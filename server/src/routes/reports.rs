//! Report routes (docs/guide/reports.md): the organization's reports, their runs, "send now", a
//! preview of a draft as PDF, the status with the limits in force, and the one-click unsubscribe
//! of addresses outside the organization. `reports:read` to see, `reports:write` to change, send
//! and preview (both from editor up). Reports on dashboards the caller cannot read do not exist
//! for them. Every change and every "send now" is audited, without addresses.

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::json;

use super::support::{Actor, PageQuery, Paging, QueryParams, audit, clean_text, conflict};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::reports::gather::{self, Spec};
use crate::reports::model::{
    MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS, MAX_PANELS, Recipient, Report, ReportFormat, ReportInput, ReportRun,
    ReportTimeRange, ReportsStatus, RunStatus, SendNow,
};
use crate::reports::run::{self, RUN_COLUMNS, RunRow, Stored};
use crate::reports::{range, schedule};
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    let read = Access::Org(Permission::ReportsRead);
    let write = Access::Org(Permission::ReportsWrite);
    vec![
        route(Method::GET, "/orgs/{orgId}/reports", read, list),
        route(Method::POST, "/orgs/{orgId}/reports", write, create),
        route(Method::GET, "/orgs/{orgId}/reports/status", read, status),
        // A draft as PDF, with the caller's own rights; nothing is stored or sent.
        route(Method::POST, "/orgs/{orgId}/reports/preview", write, preview).long_running(),
        route(Method::GET, "/orgs/{orgId}/reports/{reportId}", read, detail),
        route(Method::PUT, "/orgs/{orgId}/reports/{reportId}", write, update),
        route(Method::DELETE, "/orgs/{orgId}/reports/{reportId}", write, delete),
        route(Method::POST, "/orgs/{orgId}/reports/{reportId}/send", write, send_now),
        route(Method::GET, "/orgs/{orgId}/reports/{reportId}/runs", read, runs),
        // Report mails to addresses outside the organization: a page to confirm, and the one-click
        // POST mail programs send (RFC 8058). The signed token is the credential.
        route(Method::GET, "/reports/unsubscribe/{token}", Access::Public, unsubscribe_page),
        route(Method::POST, "/reports/unsubscribe/{token}", Access::Public, unsubscribe),
    ]
}

fn invalid(field: &'static str, reason: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::validation(message).with_field(field).because(reason)
}

fn disabled() -> ApiError {
    conflict("reports are turned off on this server").because("reports.disabled")
}

/// A report the caller may see: of the organization, on a dashboard the caller can read.
async fn visible(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<Stored> {
    let report = run::load(&state.db, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    if !run::reads_dashboard(state, ctx, &report.dashboard_id).await? {
        return Err(ApiError::not_found());
    }
    Ok(report)
}

/// A report body, checked.
struct Checked {
    name: String,
    description: String,
    panel_ids: Option<Vec<String>>,
    time_range: Option<ReportTimeRange>,
    variables: std::collections::BTreeMap<String, serde_json::Value>,
    schedule: schedule::Schedule,
    compiled: schedule::Compiled,
    zone: chrono_tz::Tz,
    formats: Vec<ReportFormat>,
    recipients: Vec<Recipient>,
}

/// Checks a body as `ctx` would save it. A preview checks what it draws only.
async fn check(state: &AppState, ctx: &OrgCtx, input: &ReportInput, now: i64, preview: bool) -> ApiResult<Checked> {
    let name = clean_text(&input.name, "name", MAX_NAME_CHARS).map_err(|e| e.with_field("name"))?;
    if name.is_empty() {
        return Err(invalid("name", "reports.name_required", "a report needs a name"));
    }
    let description =
        clean_text(input.description.as_deref().unwrap_or_default(), "description", MAX_DESCRIPTION_CHARS)
            .map_err(|e| e.with_field("description"))?;
    let zone = schedule::zone(&input.time_zone).map_err(|e| invalid("timeZone", e.reason, e.message))?;
    // The dashboard, as the caller reads it.
    let model = match crate::routes::query::readable_model(state, ctx, &input.dashboard_id).await {
        Ok(model) => model,
        Err(e) if e.code == "not_found" => {
            return Err(invalid("dashboardId", "reports.dashboard_unknown", "there is no such dashboard you can read"));
        }
        Err(e) => return Err(e),
    };
    if let Some(ids) = &input.panel_ids {
        let unique: BTreeSet<&String> = ids.iter().collect();
        if ids.is_empty() || ids.len() > MAX_PANELS || unique.len() != ids.len() {
            return Err(invalid(
                "panelIds",
                "reports.panels_invalid",
                format!("name 1 to {MAX_PANELS} different panels"),
            ));
        }
        if let Some(missing) = ids.iter().find(|id| !model.panels.iter().any(|p| &p.id == *id)) {
            return Err(invalid("panelIds", "reports.panel_unknown", format!("the dashboard has no panel {missing}"))
                .param("panelId", missing));
        }
    }
    if let Some(r) = &input.time_range {
        range::resolve_range(&r.from, &r.to, now, zone).map_err(|e| invalid("timeRange", e.reason, e.message))?;
    }
    gather::variables(&model, &input.variables)?;
    let compiled = input.schedule.compile().map_err(|e| invalid("schedule", e.reason, e.message))?;
    let mut formats = input.formats.clone();
    formats.sort();
    formats.dedup();
    if formats.is_empty() || formats.len() != input.formats.len() {
        return Err(invalid("formats", "reports.formats_invalid", "pick PDF, CSV or both, each once"));
    }
    if formats.contains(&ReportFormat::Csv) && !ctx.permissions.contains(&Permission::DataExport) {
        return Err(ApiError::forbidden("CSV files need data:export")
            .with_field("formats")
            .because("reports.csv_needs_export"));
    }
    let mut recipients = Vec::new();
    if !preview {
        schedule::check_spacing(&compiled, zone, now).map_err(|e| invalid("schedule", e.reason, e.message))?;
        recipients = check_recipients(state, ctx, &input.recipients, &input.dashboard_id).await?;
    }
    Ok(Checked {
        name,
        description,
        panel_ids: input.panel_ids.clone(),
        time_range: input.time_range.clone(),
        variables: input.variables.clone(),
        schedule: input.schedule.clone(),
        compiled,
        zone,
        formats,
        recipients,
    })
}

/// Members must be able to read the dashboard; addresses outside the organization need its
/// setting (and domain list) and the server's public address, for their unsubscribe link.
async fn check_recipients(
    state: &AppState,
    ctx: &OrgCtx,
    input: &[Recipient],
    dashboard_id: &str,
) -> ApiResult<Vec<Recipient>> {
    let max = crate::reports::limits(state).await?.max_recipients;
    if input.is_empty() {
        return Err(invalid("recipients", "reports.recipients_required", "a report needs at least one recipient"));
    }
    if input.len() as u64 > max {
        return Err(invalid(
            "recipients",
            "reports.too_many_recipients",
            format!("a report has at most {max} recipients"),
        )
        .param("max", max));
    }
    let external_ok = crate::reports::external_allowed(state, &ctx.org_id).await?;
    let domains = crate::reports::external_domains(state, &ctx.org_id).await?;
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for (i, r) in input.iter().enumerate() {
        let at = |reason: &'static str, message: String| invalid("recipients", reason, message).param("index", i);
        match (&r.user_id, &r.email) {
            (Some(user_id), None) => {
                let account: Option<(i64,)> = sqlx::query_as("SELECT service_account FROM users WHERE id = $1")
                    .bind(user_id)
                    .fetch_optional(&state.db)
                    .await?;
                let member = match account {
                    Some((0,)) => run::member_ctx(state, &ctx.org_id, user_id).await?,
                    _ => None,
                };
                let Some(member) = member else {
                    return Err(at("reports.recipient_unknown", format!("recipient {i} is no active member")));
                };
                if !run::reads_dashboard(state, &member, dashboard_id).await? {
                    return Err(at(
                        "reports.recipient_no_access",
                        format!("{} cannot read the dashboard; share it first", member.user.name),
                    )
                    .param("name", &member.user.name));
                }
                if !seen.insert(format!("user:{user_id}")) {
                    return Err(at("reports.recipient_duplicate", format!("recipient {i} is listed twice")));
                }
                out.push(Recipient { user_id: Some(user_id.clone()), email: None });
            }
            (None, Some(email)) => {
                let email = crate::routes::normalize_email(email).map_err(|_| {
                    at("reports.recipient_email_invalid", format!("recipient {i} is not a mail address"))
                })?;
                // Someone with an account goes by the account, so the read check applies.
                if run::is_account(&state.db, &email).await? {
                    return Err(at(
                        "reports.recipient_is_account",
                        format!("{email} belongs to an account; add the person by their account instead"),
                    ));
                }
                if !external_ok {
                    return Err(at(
                        "reports.external_not_allowed",
                        "this organization sends reports to its members only".to_string(),
                    ));
                }
                if !crate::reports::domain_allowed(&email, &domains) {
                    return Err(at(
                        "reports.external_domain_not_allowed",
                        format!("{email} is not in a mail domain this organization allows"),
                    ));
                }
                if crate::mail::public_url(state).is_none() {
                    return Err(at(
                        "reports.external_needs_public_url",
                        "addresses outside the organization need the server's public address for their unsubscribe link"
                            .to_string(),
                    ));
                }
                if !seen.insert(format!("mail:{email}")) {
                    return Err(at("reports.recipient_duplicate", format!("recipient {i} is listed twice")));
                }
                out.push(Recipient { user_id: None, email: Some(email) });
            }
            _ => return Err(at("reports.recipient_invalid", format!("recipient {i} needs either userId or email"))),
        }
    }
    Ok(out)
}

/// What an audit entry says about a report: never an address.
fn summary(id: &str, c: &Checked) -> serde_json::Value {
    let external = c.recipients.iter().filter(|r| r.email.is_some()).count();
    json!({
        "reportId": id,
        "name": c.name,
        "formats": c.formats,
        "recipients": c.recipients.len(),
        "externalRecipients": external,
        "schedule": c.schedule,
        "timeZone": c.zone.name(),
    })
}

fn next_run(c: &Checked, paused: bool, now: i64) -> Option<i64> {
    if paused { None } else { c.compiled.next_after(now, c.zone) }
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<Report>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let sql = format!(
        "{} WHERE r.org_id = $1 AND (r.created_at < $2 OR (r.created_at = $2 AND r.id < $3)) \
         ORDER BY r.created_at DESC, r.id DESC LIMIT $4",
        run::COLUMNS
    );
    let rows: Vec<Stored> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(&ctx.org_id)
        .bind(paging.before_time())
        .bind(paging.before_id())
        .bind(paging.fetch_limit())
        .fetch_all(&state.db)
        .await?;
    let page = paging.page(rows, |r| (r.created_at, r.id.as_str()));
    let mut items = Vec::new();
    for r in page.items {
        if run::reads_dashboard(&state, &ctx, &r.dashboard_id).await? {
            items.push(run::view(&state, r).await?);
        }
    }
    Ok(Json(Page { items, next_cursor: page.next_cursor }))
}

async fn status(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<ReportsStatus>> {
    let (reports,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM reports WHERE org_id = $1").bind(&ctx.org_id).fetch_one(&state.db).await?;
    Ok(Json(ReportsStatus {
        enabled: crate::reports::enabled_for(&state, &ctx.org_id).await?,
        mail_configured: crate::mail::settings::effective(&state).await?.configured(),
        allow_external_recipients: crate::reports::external_allowed(&state, &ctx.org_id).await?,
        external_domains: crate::reports::external_domains(&state, &ctx.org_id).await?,
        limits: crate::reports::limits(&state).await?,
        reports,
    }))
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(input): JsonBody<ReportInput>,
) -> ApiResult<(StatusCode, Json<Report>)> {
    let now = state.clock.now_ms();
    let c = check(&state, &ctx, &input, now, false).await?;
    let max = crate::reports::limits(&state).await?.max_reports_per_org;
    let id = crate::routes::new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    crate::authz::lock_org(&mut tx, &ctx.org_id).await?;
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM reports WHERE org_id = $1").bind(&ctx.org_id).fetch_one(&mut *tx).await?;
    if u64::try_from(count).unwrap_or(0) >= max {
        return Err(conflict(format!("this organization has its {max} reports"))
            .because("reports.too_many")
            .param("max", max));
    }
    sqlx::query(
        "INSERT INTO reports (id, org_id, name, description, dashboard_id, panel_ids, time_from, time_to, variables, \
         schedule, time_zone, formats, language, recipients, paused, next_run_at, owner_id, version, created_by, \
         created_at, updated_by, updated_at, unsubscribe_key) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 1, $17, $18, $17, $18, $19)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&c.name)
    .bind(&c.description)
    .bind(&input.dashboard_id)
    .bind(c.panel_ids.as_ref().map(|p| serde_json::to_string(p).expect("ids serialize")))
    .bind(c.time_range.as_ref().map(|r| r.from.clone()))
    .bind(c.time_range.as_ref().map(|r| r.to.clone()))
    .bind(serde_json::to_string(&c.variables).expect("values serialize"))
    .bind(serde_json::to_string(&c.schedule).expect("schedules serialize"))
    .bind(c.zone.name())
    .bind(serde_json::to_string(&c.formats).expect("formats serialize"))
    .bind(input.language.as_str())
    .bind(serde_json::to_string(&c.recipients).expect("recipients serialize"))
    .bind(i64::from(input.paused))
    .bind(next_run(&c, input.paused, now))
    .bind(&ctx.user.id)
    .bind(now)
    .bind(run::new_unsubscribe_key())
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "report.created", ("report", &id), summary(&id, &c)).await?;
    let stored = run::load(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(run::view(&state, stored).await?)))
}

async fn detail(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Report>> {
    let report = visible(&state, &ctx, &id).await?;
    Ok(Json(run::view(&state, report).await?))
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(input): JsonBody<ReportInput>,
) -> ApiResult<Json<Report>> {
    let current = visible(&state, &ctx, &id).await?;
    let Some(version) = input.version else {
        return Err(invalid("version", "reports.version_required", "send the version the change started from"));
    };
    let now = state.clock.now_ms();
    let c = check(&state, &ctx, &input, now, false).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    // The creator stays the owner: the report keeps running with the creator's rights.
    let changed = sqlx::query(
        "UPDATE reports SET name = $1, description = $2, dashboard_id = $3, panel_ids = $4, time_from = $5, \
         time_to = $6, variables = $7, schedule = $8, time_zone = $9, formats = $10, language = $11, recipients = $12, \
         paused = $13, next_run_at = $14, version = version + 1, updated_by = $15, updated_at = $16 \
         WHERE id = $17 AND org_id = $18 AND version = $19",
    )
    .bind(&c.name)
    .bind(&c.description)
    .bind(&input.dashboard_id)
    .bind(c.panel_ids.as_ref().map(|p| serde_json::to_string(p).expect("ids serialize")))
    .bind(c.time_range.as_ref().map(|r| r.from.clone()))
    .bind(c.time_range.as_ref().map(|r| r.to.clone()))
    .bind(serde_json::to_string(&c.variables).expect("values serialize"))
    .bind(serde_json::to_string(&c.schedule).expect("schedules serialize"))
    .bind(c.zone.name())
    .bind(serde_json::to_string(&c.formats).expect("formats serialize"))
    .bind(input.language.as_str())
    .bind(serde_json::to_string(&c.recipients).expect("recipients serialize"))
    .bind(i64::from(input.paused))
    .bind(next_run(&c, input.paused, now))
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed == 0 {
        drop(tx);
        let view = run::view(&state, current).await?;
        return Err(ApiError::version_conflict(serde_json::to_value(view).unwrap_or_default()));
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let mut s = summary(&id, &c);
    s["paused"] = json!(input.paused);
    audit(&mut tx, &actor, Some(&ctx.org_id), "report.updated", ("report", &id), s).await?;
    let stored = run::load(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    crate::db::commit(tx).await?;
    Ok(Json(run::view(&state, stored).await?))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let report = visible(&state, &ctx, &id).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("DELETE FROM reports WHERE id = $1 AND org_id = $2")
        .bind(&id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(
        &mut tx,
        &actor,
        Some(&ctx.org_id),
        "report.deleted",
        ("report", &id),
        json!({ "reportId": id, "name": report.name }),
    )
    .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Queues a run now; the worker on the leading server makes and sends it, with the creator's
/// rights like a scheduled run.
async fn send_now(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<SendNow>)> {
    let report = visible(&state, &ctx, &id).await?;
    if !crate::reports::enabled_for(&state, &ctx.org_id).await? {
        return Err(disabled());
    }
    if !crate::mail::settings::effective(&state).await?.configured() {
        return Err(conflict("no mail server is set up").because("reports.mail_not_configured"));
    }
    let now = state.clock.now_ms();
    let max = crate::reports::limits(&state).await?.max_runs_per_org_hour;
    let mut tx = crate::db::begin(&state.db).await?;
    crate::authz::lock_org(&mut tx, &ctx.org_id).await?;
    if u64::try_from(crate::reports::worker::runs_last_hour(&mut *tx, &ctx.org_id, now).await?).unwrap_or(0) >= max {
        return Err(ApiError::rate_limited(
            format!("this organization started its {max} report runs for this hour"),
            std::time::Duration::from_secs(60),
        )
        .because("reports.rate_limited"));
    }
    let run_id = crate::reports::worker::record_run(
        &mut tx,
        &ctx.org_id,
        &id,
        "manual",
        Some(&ctx.user.id),
        None,
        RunStatus::Queued,
        None,
        now,
    )
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(
        &mut tx,
        &actor,
        Some(&ctx.org_id),
        "report.sent_now",
        ("report", &id),
        json!({ "reportId": id, "name": report.name, "runId": run_id }),
    )
    .await?;
    let row: RunRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{RUN_COLUMNS} WHERE id = $1")))
        .bind(&run_id)
        .fetch_one(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    state.reports.queued.notify_one();
    Ok((StatusCode::ACCEPTED, Json(SendNow { run: row.view() })))
}

async fn runs(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<ReportRun>>> {
    visible(&state, &ctx, &id).await?;
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let sql = format!(
        "{RUN_COLUMNS} WHERE report_id = $1 AND (created_at < $2 OR (created_at = $2 AND id < $3)) \
         ORDER BY created_at DESC, id DESC LIMIT $4"
    );
    let rows: Vec<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(&id)
        .bind(paging.before_time())
        .bind(paging.before_id())
        .bind(paging.fetch_limit())
        .fetch_all(&state.db)
        .await?;
    let page = paging.page(rows, |r| (r.created_at, r.id.as_str()));
    Ok(Json(Page { items: page.items.into_iter().map(RunRow::view).collect(), next_cursor: page.next_cursor }))
}

/// The PDF file of a draft, made with the caller's rights. Panels that fail show their reason in
/// place, so the draft can be fixed.
async fn preview(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(input): JsonBody<ReportInput>,
) -> ApiResult<Response> {
    if !crate::reports::enabled_for(&state, &ctx.org_id).await? {
        return Err(disabled());
    }
    let key = format!("{}:{}", ctx.org_id, ctx.user.id);
    state
        .reports
        .previews
        .try_acquire(&key, &key, state.clock.monotonic_ms())
        .map_err(|wait| ApiError::rate_limited("too many previews, wait a moment", wait))?;
    let now = state.clock.now_ms();
    let c = check(&state, &ctx, &input, now, true).await?;
    let spec = Spec {
        dashboard_id: &input.dashboard_id,
        panel_ids: c.panel_ids.as_deref(),
        time_range: c.time_range.as_ref().map(|r| (r.from.as_str(), r.to.as_str())),
        variables: &c.variables,
        zone: c.zone,
    };
    // The place is held while the panels run too: what they hold counts against the server.
    let permit = state.reports.rendering.clone().acquire_owned().await.map_err(|_| ApiError::busy())?;
    let max = crate::reports::limits(&state).await?.max_attachment_bytes;
    let g = gather::gather(&state, &ctx, &spec, now, &gather::Budget::new(max, true)).await?;
    let (name, lang) = (c.name.clone(), input.language);
    let rendered = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::reports::pdf::render(&g, &crate::reports::pdf::Cover { title: &name, generated_at: now }, lang)
    })
    .await
    .map_err(|e| ApiError::internal("reports", e))?
    .map_err(|e| ApiError::internal("reports", e))?;
    let file = crate::analysis::export::file_name(&c.name, "pdf");
    Ok((
        [
            (header::CONTENT_TYPE, "application/pdf".to_string()),
            (header::CONTENT_DISPOSITION, format!("inline; filename=\"{file}\"")),
            (header::CACHE_CONTROL, "no-store".to_string()),
        ],
        rendered.bytes,
    )
        .into_response())
}

/// A small page in German and English; no script, no outside resource.
fn page(status: StatusCode, de: &str, en: &str, form: Option<&str>) -> Response {
    use crate::mail::templates::escape;
    let button = form
        .map(|action| {
            format!(
                "<form method=\"post\" action=\"{}\"><button type=\"submit\">Abmelden / Unsubscribe</button></form>",
                escape(action)
            )
        })
        .unwrap_or_default();
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">\
         <title>Kalzit</title></head><body style=\"font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;\
         padding:0 16px;line-height:1.5\"><p lang=\"de\">{}</p><p lang=\"en\">{}</p>{button}</body></html>",
        escape(de),
        escape(en)
    );
    (status, [(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], body)
        .into_response()
}

async fn unsubscribe_page(State(state): State<AppState>, Path(token): Path<String>) -> ApiResult<Response> {
    if run::check_unsubscribe_token(&state.db, &token).await?.is_none() {
        return Ok(page(StatusCode::NOT_FOUND, "Dieser Link gilt nicht.", "This link is not valid.", None));
    }
    Ok(page(
        StatusCode::OK,
        "Keine weiteren Mails mit diesem Bericht?",
        "No more mails with this report?",
        Some(&token),
    ))
}

/// Leaves the address out of the report's runs from now on. Answers alike whether or not it was
/// unsubscribed before.
async fn unsubscribe(State(state): State<AppState>, Path(token): Path<String>) -> ApiResult<Response> {
    let Some((org_id, report_id, hash)) = run::check_unsubscribe_token(&state.db, &token).await? else {
        return Ok(page(StatusCode::NOT_FOUND, "Dieser Link gilt nicht.", "This link is not valid.", None));
    };
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    {
        let added = sqlx::query(
            "INSERT INTO report_unsubscribes (report_id, email_hash, created_at) VALUES ($1, $2, $3) \
             ON CONFLICT (report_id, email_hash) DO NOTHING",
        )
        .bind(&report_id)
        .bind(&hash)
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if added == 1 {
            let event = crate::audit::AuditEvent {
                org_id: Some(&org_id),
                actor_user_id: None,
                actor_address: None,
                action: "report.unsubscribed",
                resource_type: Some("report"),
                resource_id: Some(&report_id),
                summary: json!({ "reportId": report_id, "emailHash": hash }),
                at_ms: now,
            };
            crate::audit::record(&mut tx, &event).await?;
        }
    }
    crate::db::commit(tx).await?;
    Ok(page(
        StatusCode::OK,
        "Du bekommst diesen Bericht nicht mehr.",
        "You will not receive this report any more.",
        None,
    ))
}
