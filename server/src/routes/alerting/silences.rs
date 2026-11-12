//! Silences (docs/api/alerting.md, "Silences"): label conditions, a time window of at most 90
//! days and a required comment. They hold back notifications, never the evaluation. Ending one
//! early is the only change; ended and expired ones stay listed until the history retention.

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::known_id;
use super::rules::with_rule_name;
use crate::alerting::rule::invalid;
use crate::alerting::silences::{self, Matcher};
use crate::app::AppState;
use crate::authz::{DatasourceAccess, OrgCtx};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::routes::support::{Actor, Paging, QueryParams, audit, clean_text, conflict};
use crate::shapes::Page;

const MAX_DURATION_MS: i64 = 90 * 86_400_000;
const MAX_COMMENT_CHARS: usize = 500;
/// A start this far in the past still counts as "now" (the dialog's clock may lag).
const START_GRACE_MS: i64 = 5 * 60_000;

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    matchers: String,
    starts_at: i64,
    ends_at: i64,
    comment: String,
    created_by: Option<String>,
    created_by_name: Option<String>,
    created_at: i64,
    ended_by: Option<String>,
    ended_by_name: Option<String>,
    ended_at: Option<i64>,
}

const COLUMNS: &str = "SELECT s.id, s.matchers, s.starts_at, s.ends_at, s.comment, s.created_by, \
     (SELECT u.name FROM users u WHERE u.id = s.created_by) AS created_by_name, s.created_at, s.ended_by, \
     (SELECT u.name FROM users u WHERE u.id = s.ended_by) AS ended_by_name, s.ended_at \
     FROM alert_silences s WHERE s.org_id = $1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Silence {
    id: String,
    matchers: Vec<Matcher>,
    starts_at: i64,
    ends_at: i64,
    comment: String,
    /// `active`, `pending` (starts later) or `expired` (ended or past its end).
    status: &'static str,
    created_by: Option<String>,
    created_by_name: Option<String>,
    created_at: i64,
    ended_by: Option<String>,
    ended_by_name: Option<String>,
    ended_at: Option<i64>,
}

fn status_of(row: &Row, now: i64) -> &'static str {
    if row.ended_at.is_some() || row.ends_at <= now {
        "expired"
    } else if row.starts_at > now {
        "pending"
    } else {
        "active"
    }
}

fn view(row: Row, now: i64) -> Silence {
    let status = status_of(&row, now);
    Silence {
        id: row.id,
        matchers: serde_json::from_str(&row.matchers).unwrap_or_default(),
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        comment: row.comment,
        status,
        created_by: row.created_by,
        created_by_name: row.created_by_name,
        created_at: row.created_at,
        ended_by: row.ended_by,
        ended_by_name: row.ended_by_name,
        ended_at: row.ended_at,
    }
}

async fn load<'e, E>(db: E, org_id: &str, id: &str) -> ApiResult<Row>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    known_id(id)?;
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLUMNS} AND s.id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.ok_or_else(ApiError::not_found)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    /// `active`, `pending` or `expired`; all without.
    status: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Silences by their end, latest first; expired ones only within the history retention.
pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Silence>>> {
    let condition = match q.status.as_deref() {
        None => "",
        Some("active") => " AND s.ended_at IS NULL AND s.starts_at <= $2 AND s.ends_at > $2",
        Some("pending") => " AND s.ended_at IS NULL AND s.starts_at > $2",
        Some("expired") => " AND (s.ended_at IS NOT NULL OR s.ends_at <= $2)",
        Some(_) => return Err(invalid("status", "status is active, pending or expired", "alerts.status_invalid")),
    };
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let now = state.clock.now_ms();
    let cutoff = crate::alerting::history::cutoff(&state, &ctx.org_id).await?;
    let sql = format!(
        "{COLUMNS} AND $2 = $2 AND s.ends_at >= $3{condition} AND (s.ends_at < $4 OR (s.ends_at = $4 AND s.id < $5)) \
         ORDER BY s.ends_at DESC, s.id DESC LIMIT $6"
    );
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(&ctx.org_id)
        .bind(now)
        .bind(cutoff)
        .bind(paging.before_time())
        .bind(paging.before_id())
        .bind(paging.fetch_limit())
        .fetch_all(&state.db)
        .await?;
    let page = paging.page(rows, |r| (r.ends_at, r.id.as_str()));
    Ok(Json(Page { items: page.items.into_iter().map(|r| view(r, now)).collect(), next_cursor: page.next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBody {
    matchers: Vec<Matcher>,
    /// Now when absent.
    starts_at: Option<i64>,
    ends_at: i64,
    comment: String,
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateBody>,
) -> ApiResult<(StatusCode, Json<Silence>)> {
    silences::check(&body.matchers)?;
    let now = state.clock.now_ms();
    let starts_at = body.starts_at.unwrap_or(now).max(now.saturating_sub(START_GRACE_MS));
    if body.starts_at.is_some_and(|s| s < now - START_GRACE_MS) {
        return Err(invalid("startsAt", "startsAt is now or later", "alerts.silence_window_invalid"));
    }
    if body.ends_at <= starts_at.max(now) || body.ends_at - starts_at > MAX_DURATION_MS {
        return Err(invalid(
            "endsAt",
            "endsAt is after the start and after now, at most 90 days after the start",
            "alerts.silence_window_invalid",
        ));
    }
    let comment = clean_text(&body.comment, "comment", MAX_COMMENT_CHARS).map_err(|e| e.with_field("comment"))?;
    if comment.is_empty() {
        return Err(invalid("comment", "a silence needs a comment", "alerts.comment_required"));
    }
    let max = crate::alerting::limits::for_org(&state, &ctx.org_id).await?.max_silences_per_org;
    let id = crate::routes::new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    crate::authz::lock_org(&mut tx, &ctx.org_id).await?;
    // Active and planned silences count; ended ones do not.
    let (open,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM alert_silences WHERE org_id = $1 AND ended_at IS NULL AND ends_at > $2")
            .bind(&ctx.org_id)
            .bind(now)
            .fetch_one(&mut *tx)
            .await?;
    if open as u64 >= max {
        return Err(conflict(format!("this organization has its {max} active and planned silences"))
            .because("alerts.too_many_silences")
            .param("max", max));
    }
    sqlx::query(
        "INSERT INTO alert_silences (id, org_id, matchers, starts_at, ends_at, comment, created_by, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(serde_json::to_string(&body.matchers).unwrap_or_default())
    .bind(starts_at)
    .bind(body.ends_at)
    .bind(&comment)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    // Label values can name people or hosts; the log keeps how many conditions and the window.
    let summary =
        json!({ "silenceId": id, "matchers": body.matchers.len(), "startsAt": starts_at, "endsAt": body.ends_at });
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_silence.created", ("alert_silence", &id), summary).await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(view(row, now))))
}

/// Ends a silence now. One that ended already answers `409 alerts.silence_ended`.
pub async fn expire(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Silence>> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    if status_of(&row, now) == "expired" {
        return Err(conflict("this silence has ended").because("alerts.silence_ended"));
    }
    sqlx::query("UPDATE alert_silences SET ended_at = $1, ended_by = $2 WHERE id = $3 AND org_id = $4")
        .bind(now)
        .bind(&ctx.user.id)
        .bind(&id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(
        &mut tx,
        &actor,
        Some(&ctx.org_id),
        "alert_silence.expired",
        ("alert_silence", &id),
        json!({ "silenceId": id }),
    )
    .await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(view(row, now)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewBody {
    matchers: Vec<Matcher>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Affected {
    rule_id: String,
    rule_name: String,
    fingerprint: String,
    labels: BTreeMap<String, String>,
    /// The caller may not see the rule's data: matched by the rule's name only, without labels.
    data_hidden: bool,
    state: String,
}

/// The instances the matchers hold back now, before a silence is saved (at most 500).
pub async fn preview(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(body): JsonBody<PreviewBody>,
) -> ApiResult<Json<Page<Affected>>> {
    silences::check(&body.matchers)?;
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT i.rule_id, r.name, i.fingerprint, i.labels, i.state, r.datasource_id FROM alert_instances i \
         JOIN alert_rules r ON r.id = i.rule_id WHERE i.org_id = $1 ORDER BY r.name, i.fingerprint",
    )
    .bind(&ctx.org_id)
    .fetch_all(&state.db)
    .await?;
    let access = DatasourceAccess::load(&state.db, &ctx).await?;
    let compiled = silences::Compiled::new(&body.matchers);
    let items = rows
        .into_iter()
        .enumerate()
        .filter_map(|(index, (rule_id, rule_name, fingerprint, labels, state, source))| {
            let labels: BTreeMap<String, String> = serde_json::from_str(&labels).unwrap_or_default();
            // An instance whose labels the caller may not see is matched by the rule's name only
            // and listed without labels, so the answer tells nothing about them.
            if !super::data_visible(&access, &source) {
                return compiled.matches(&super::hidden_silence_labels(&rule_name)).then(|| Affected {
                    rule_id,
                    rule_name,
                    fingerprint: super::hidden_fingerprint(index),
                    labels: BTreeMap::new(),
                    data_hidden: true,
                    state,
                });
            }
            compiled.matches(&with_rule_name(labels.clone(), &rule_name)).then_some(Affected {
                rule_id,
                rule_name,
                fingerprint,
                labels,
                data_hidden: false,
                state,
            })
        })
        .take(500)
        .collect();
    Ok(Json(Page { items, next_cursor: None }))
}
