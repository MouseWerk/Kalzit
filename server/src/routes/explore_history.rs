//! Explore's query history: the queries a user ran from Explore, private to that user, kept for
//! 30 days and at most `MAX_ENTRIES` per user and organization (docs/api/explore-history.md).
//!
//! Only what the user typed is stored (the query JSON, the data source id and the shape and size
//! of the answer), never a result and never a data source's settings. Every read is for the
//! caller alone, in the organization of the route; an entry of a data source the caller may no
//! longer query is left out, so it names nothing. Running an entry again is a normal query.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::support::{QueryParams, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, AccessIndex, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::shapes::{Page, QueryItem, QueryOutcome, QueryResult};

/// Entries kept per user and organization; older ones are dropped when a new one is recorded.
pub const MAX_ENTRIES: i64 = 500;
/// How long an entry is kept.
pub const RETENTION_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 3600 * 1000;
/// A query longer than this (bytes of JSON) is run but not kept.
const MAX_QUERY_BYTES: usize = 64 * 1024;
/// Longest search text, in characters.
const MAX_SEARCH_CHARS: usize = 100;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/explore/history", OrgMember, list),
        route(Method::DELETE, "/orgs/{orgId}/explore/history", OrgMember, delete_all),
        route(Method::DELETE, "/orgs/{orgId}/explore/history/{entryId}", OrgMember, delete_one),
    ]
}

/// One query the caller ran from Explore.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub datasource_id: String,
    pub datasource_name: String,
    pub datasource_kind: String,
    /// The query as Explore sent it.
    pub query: Value,
    pub shape: String,
    pub row_count: Option<i64>,
    pub duration_ms: Option<i64>,
    pub created_at: i64,
}

/// Records the successful items of an Explore run. A failure to record is logged and never fails
/// the query. `duration_ms` is the run's time when it held a single item, else unknown.
pub async fn record(state: &AppState, ctx: &OrgCtx, ran: &[(&QueryItem, &QueryOutcome)], duration_ms: Option<i64>) {
    if let Err(e) = try_record(state, ctx, ran, duration_ms).await {
        tracing::warn!(error = %e.message, "could not record the Explore history");
    }
}

async fn try_record(
    state: &AppState,
    ctx: &OrgCtx,
    ran: &[(&QueryItem, &QueryOutcome)],
    duration_ms: Option<i64>,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    for (item, outcome) in ran {
        let QueryOutcome::Ok { result } = outcome else { continue };
        let Ok(text) = serde_json::to_string(&item.query) else { continue };
        if text.len() > MAX_QUERY_BYTES {
            continue;
        }
        let shape = shape_name(result);
        let rows = row_count(result);
        let mut tx = crate::db::begin(&state.db).await?;
        // The same query again right after itself is one entry that moves to the top.
        let last: Option<(String, String, String)> = sqlx::query_as(
            "SELECT id, datasource_id, query FROM explore_history WHERE user_id = $1 AND org_id = $2 \
             ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .fetch_optional(&mut *tx)
        .await?;
        match last {
            Some((id, ds, q)) if ds == item.datasource_id && q == text => {
                sqlx::query(
                    "UPDATE explore_history SET created_at = $1, shape = $2, row_count = $3, duration_ms = $4 \
                     WHERE id = $5",
                )
                .bind(now)
                .bind(shape)
                .bind(rows)
                .bind(duration_ms)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
            _ => {
                sqlx::query(
                    "INSERT INTO explore_history \
                     (id, user_id, org_id, datasource_id, query, shape, row_count, duration_ms, created_at) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                )
                .bind(uuid::Uuid::now_v7().to_string())
                .bind(&ctx.user.id)
                .bind(&ctx.org_id)
                .bind(&item.datasource_id)
                .bind(&text)
                .bind(shape)
                .bind(rows)
                .bind(duration_ms)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            }
        }
        sqlx::query(
            "DELETE FROM explore_history WHERE user_id = $1 AND org_id = $2 AND id NOT IN \
             (SELECT id FROM explore_history WHERE user_id = $1 AND org_id = $2 \
              ORDER BY created_at DESC, id DESC LIMIT $3)",
        )
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(MAX_ENTRIES)
        .execute(&mut *tx)
        .await?;
        crate::db::commit(tx).await?;
    }
    Ok(())
}

fn shape_name(result: &QueryResult) -> &'static str {
    match result {
        QueryResult::Frame { .. } => "frame",
        QueryResult::Documents { .. } => "documents",
        QueryResult::Graph { .. } => "graph",
    }
}

/// Rows of a table, documents of a document set, nodes of a graph.
fn row_count(result: &QueryResult) -> Option<i64> {
    let n = match result {
        QueryResult::Frame { frame } => frame.rows(),
        QueryResult::Documents { documents } => documents.documents.len(),
        QueryResult::Graph { graph } => graph.nodes.len(),
    };
    i64::try_from(n).ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
    datasource_id: Option<String>,
    q: Option<String>,
}

type Row = (String, String, String, String, String, String, Option<i64>, Option<i64>, i64);

/// A LIKE pattern for "contains `needle`"; `%`, `_` and `\` match themselves.
fn contains_pattern(needle: &str) -> String {
    let mut out = String::from("%");
    for c in needle.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

/// The caller's entries, newest first, of data sources they may still query. Filter by data
/// source and by text in the query (case-insensitive).
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<HistoryEntry>>> {
    let limit = page_limit(q.limit)? as usize;
    let after: Option<(i64, String)> = decode_cursor(q.cursor.as_deref())?;
    let text = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if text.is_some_and(|t| t.chars().count() > MAX_SEARCH_CHARS) {
        return Err(ApiError::validation(format!("q is at most {MAX_SEARCH_CHARS} characters")).with_field("q"));
    }
    let mut sql = String::from(
        "SELECT h.id, h.datasource_id, d.name, d.kind, h.query, h.shape, h.row_count, h.duration_ms, h.created_at \
         FROM explore_history h JOIN datasources d ON d.id = h.datasource_id AND d.org_id = h.org_id \
         WHERE h.user_id = $1 AND h.org_id = $2 AND d.deleted_at IS NULL",
    );
    let mut next = 3;
    if q.datasource_id.is_some() {
        sql.push_str(&format!(" AND h.datasource_id = ${next}"));
        next += 1;
    }
    if text.is_some() {
        sql.push_str(&format!(" AND LOWER(h.query) LIKE ${next} ESCAPE '\\'"));
    }
    sql.push_str(" ORDER BY h.created_at DESC, h.id DESC");
    let mut query = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(sql)).bind(&ctx.user.id).bind(&ctx.org_id);
    if let Some(ds) = &q.datasource_id {
        query = query.bind(ds);
    }
    if let Some(t) = text {
        query = query.bind(contains_pattern(&t.to_lowercase()));
    }
    let mut conn = state.db.acquire().await?;
    let rows = query.fetch_all(&mut *conn).await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    // At most `MAX_ENTRIES` rows, filtered here by what the caller may query now, so pages stay
    // full and the cursor compares the same key the rows are ordered by.
    let mut items: Vec<HistoryEntry> = rows
        .into_iter()
        .filter(|r| index.datasource(&r.1).is_some_and(|p| p.contains(&Permission::DatasourcesQuery)))
        .filter(|r| after.as_ref().is_none_or(|(t, id)| (r.8, r.0.as_str()) < (*t, id.as_str())))
        .filter_map(|r| {
            let query = serde_json::from_str(&r.4).ok()?;
            Some(HistoryEntry {
                id: r.0,
                datasource_id: r.1,
                datasource_name: r.2,
                datasource_kind: r.3,
                query,
                shape: r.5,
                row_count: r.6,
                duration_ms: r.7,
                created_at: r.8,
            })
        })
        .collect();
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = items.last().filter(|_| more).map(|e| encode_cursor(&(e.created_at, e.id.as_str())));
    Ok(Json(Page { items, next_cursor }))
}

/// Deletes one of the caller's own entries. An id that is not theirs answers like one that does
/// not exist.
async fn delete_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    let n = sqlx::query("DELETE FROM explore_history WHERE id = $1 AND user_id = $2 AND org_id = $3")
        .bind(&id)
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    crate::db::commit(tx).await?;
    if n == 0 {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes all of the caller's entries in this organization, also those of data sources they can
/// no longer query.
async fn delete_all(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("DELETE FROM explore_history WHERE user_id = $1 AND org_id = $2")
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes entries older than the retention. Answers the number deleted.
pub async fn purge_expired(state: &AppState) -> ApiResult<u64> {
    purge_expired_in(state, &state.db).await
}

async fn purge_expired_in(state: &AppState, db: &sqlx::AnyPool) -> ApiResult<u64> {
    let cutoff = state.clock.now_ms().saturating_sub(RETENTION_DAYS * DAY_MS);
    let mut tx = crate::db::begin(db).await?;
    let deleted = sqlx::query("DELETE FROM explore_history WHERE created_at < $1")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    crate::db::commit(tx).await?;
    Ok(deleted)
}

/// Runs `purge_expired` every hour, like the audit retention.
pub fn spawn_retention(state: AppState) {
    spawn_retention_on(state, crate::db::Schedule::hourly());
}

/// `spawn_retention` on another schedule (tests).
pub fn spawn_retention_on(state: AppState, schedule: crate::db::Schedule) {
    use crate::db::JobError;
    let background = state.background.clone();
    crate::db::spawn_job(&background, "deleting old Explore history", schedule, move || {
        let state = state.clone();
        async move {
            match purge_expired_in(&state, state.background.db()).await {
                Ok(0) => Ok(()),
                Ok(n) => {
                    tracing::info!("deleted {n} Explore history entries past their retention");
                    Ok(())
                }
                Err(e) if e.code == "busy" => Err(JobError::Busy(e.message)),
                Err(e) => Err(JobError::Failed(e.message)),
            }
        }
    });
}
