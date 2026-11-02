//! Export (docs/api/datasources.md, "Export"): a query result after its analysis steps, as a CSV,
//! JSON or Excel file. The server runs the queries and the steps itself, so the file is made only
//! after the same checks as running the query, plus `data:export`:
//!
//! - `POST /orgs/{orgId}/export`: free queries, with `datasources:query` on every data source.
//! - `POST /orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export`: a panel's stored
//!   queries and steps, for whoever may read the dashboard.
//!
//! Every export is written to the audit log, a refused one too. The format is chosen per result
//! shape: frames today; documents (NDJSON) and graphs (GraphML) add their encoders here with M2
//! and M3.
//!
//! Resources: at most `MAX_EXPORTS` exports make files at once on a server (more answer `busy`);
//! steps and encoding run off the request threads, stop when the client goes away (a drop guard
//! sets the cancel flag) and when the query timeout (`datasources.query_timeout_secs`) has passed,
//! and the run's cell and text budget bounds what they build.
//!
//! The file is made first and sent afterwards. Steps and encoder write it to a spool file in
//! `<data dir>/export-tmp` (Excel in constant memory mode, CSV and JSON row by row), so memory
//! holds the frame and a chunk, whatever the file's size. The server-wide slot is given back when
//! the file is complete: a client that reads slowly holds no slot, only its own user's (one export
//! per user at a time) and a spool file. Everything that goes wrong while making the file (the
//! queries, the steps, the size limit, too little disk space) is an ordinary error answer.
//!
//! The file is then sent from disk, 1 MiB at a time through a channel of two, by a task of its
//! own: it ends when the client goes away, takes nothing for `Limits::stall`, or the whole
//! download passes `Limits::download` (15 minutes). The audit entry `data.exported` is written
//! before the last chunk is sent, and a failing write breaks the download off; one that ends
//! early writes `data.export_aborted` with a reason and the bytes sent. The query time limit
//! covers the queries, the steps and the encoder, not the download.

use std::collections::{BTreeSet, HashSet};
use std::io::Write as _;
use std::path::Path as FsPath;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::query::{api_error, check_variables, graph_steps_of, readable_model, resolve_variables};
use super::table::{RouteDef, route};
use crate::analysis::expr::Calendar;
use crate::analysis::steps::{self, Control, Input};
use crate::analysis::{Step, check_steps, export};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{Access, DatasourceAccess, OrgCtx, Permission};
use crate::datasources::detail::Detail;
use crate::datasources::{check_interval, check_items, check_range, run_queries, run_queries_with};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::locks::{MutexExt, RwLockExt};
use crate::net::RequestInfo;
use crate::shapes::{
    ExportFormat, ExportLanguage, ExportRequest, PanelExportRequest, QueryItem, QueryOutcome, QueryResponse,
    QueryResult, Shape, TimeRange,
};

/// Exports that make their file at the same time, per server (`AppState::exports`).
pub const MAX_EXPORTS: usize = 3;
/// The steps' and the encoder's time limit when the setting cannot be read.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Chunks waiting between the sending task and the response body.
const QUEUED_CHUNKS: usize = 2;
/// Where an export's temporary files go, inside the data directory.
const SPOOL_DIR: &str = "export-tmp";
/// Free disk space an export leaves, besides its own estimate.
const KEEP_FREE_BYTES: u64 = 1024 * 1024 * 1024;
/// The size of one chunk sent.
const CHUNK: usize = 1024 * 1024;

/// The bounds of exports.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// A client that takes no chunk for this long loses its export.
    pub stall: Duration,
    /// The longest a download takes, from the first chunk to the last.
    pub download: Duration,
    /// The largest file.
    pub file_bytes: usize,
    /// Free disk space kept besides the estimate of the file.
    pub keep_free: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            stall: Duration::from_secs(60),
            download: Duration::from_secs(15 * 60),
            file_bytes: export::MAX_FILE_BYTES,
            keep_free: KEEP_FREE_BYTES,
        }
    }
}

/// Empties the spool folder (files of exports cut short by a stop or a crash) and makes sure it
/// exists. Called before the server takes requests.
pub fn clear_spool(data_dir: &FsPath) {
    let spool = data_dir.join(SPOOL_DIR);
    let _ = std::fs::remove_dir_all(&spool);
    if let Err(e) = std::fs::create_dir_all(&spool) {
        tracing::warn!("creating the export folder {}: {e}", spool.display());
    }
}

/// One export per user at a time, from making the file to the last byte sent.
struct UserSlot {
    users: Arc<Mutex<HashSet<String>>>,
    id: String,
}

impl Drop for UserSlot {
    fn drop(&mut self) {
        self.users.lock_or_recover().remove(&self.id);
    }
}

/// What a running export holds: a slot of the server while the file is made, its user's slot.
struct Slots {
    permit: tokio::sync::OwnedSemaphorePermit,
    user: UserSlot,
}

fn acquire(state: &AppState, ctx: &OrgCtx) -> ApiResult<Slots> {
    let user = {
        let mut users = state.export_users.lock_or_recover();
        if !users.insert(ctx.user.id.clone()) {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "you have an export running; wait until it is done",
            )
            .because("export.user_busy"));
        }
        UserSlot { users: state.export_users.clone(), id: ctx.user.id.clone() }
    };
    let permit = state.exports.clone().try_acquire_owned().map_err(|_| too_busy())?;
    Ok(Slots { permit, user })
}

/// Sets the cancel flag when the request goes away (the client closed the connection), so the
/// blocking work stops at its next check instead of running to the end for nobody.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

pub fn routes() -> Vec<RouteDef> {
    vec![
        // And `datasources:query` per data source (role or grant), checked in the handler.
        route(Method::POST, "/orgs/{orgId}/export", Access::Org(Permission::DataExport), export_query).long_running(),
        // And `dashboards:read` on the dashboard, checked in the handler.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export",
            Access::Org(Permission::DataExport),
            export_panel,
        )
        .long_running(),
    ]
}

fn refused(detail: Detail) -> ApiError {
    ApiError::validation(detail.message).with_reason(detail.reason, detail.params)
}

/// What a request asks to be written.
struct Wanted {
    format: ExportFormat,
    language: ExportLanguage,
    frame: Option<String>,
    time_range: TimeRange,
    calendar: Calendar,
}

/// The calendar calculated fields read times in, from the request: a known IANA zone (UTC when
/// absent) and the first day of the week (Monday when absent).
fn calendar(time_zone: Option<&str>, week_start: Option<&str>) -> ApiResult<Calendar> {
    use crate::dashboards::model::WeekStart;
    let zone = match time_zone {
        None => None,
        Some(name) => Some(name.parse::<chrono_tz::Tz>().map_err(|_| {
            ApiError::validation("timeZone must be a time zone name such as Europe/Berlin")
                .with_field("timeZone")
                .because("export.time_zone_unknown")
        })?),
    };
    let week_start = match week_start {
        None | Some("monday") => WeekStart::Monday,
        Some("sunday") => WeekStart::Sunday,
        Some("saturday") => WeekStart::Saturday,
        Some(_) => {
            return Err(ApiError::validation("weekStart must be monday, sunday or saturday")
                .with_field("weekStart")
                .because("export.week_start_unknown"));
        }
    };
    Ok(Calendar::new(zone, week_start))
}

impl Wanted {
    /// The audit summary's common part: never the data, never what a user typed into a query.
    fn summary(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("format".into(), json!(self.format));
        m.insert("timeRange".into(), json!(self.time_range));
        m.insert("frame".into(), json!(self.frame));
        m
    }
}

/// What the sending task tells the response body.
enum Msg {
    Chunk(Vec<u8>),
    /// The whole file was sent.
    Done,
    Failed(String),
}

/// A finished file on disk, waiting to be sent.
struct Spooled {
    path: tempfile::TempPath,
    len: u64,
    rows: usize,
    kind: export::Kind,
    user: UserSlot,
}

/// A finished file and where its audit entry points.
struct Made {
    file: Spooled,
    title: String,
    summary: serde_json::Map<String, Value>,
}

async fn export_query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<ExportRequest>,
) -> ApiResult<Response> {
    let wanted = Wanted {
        format: req.format,
        language: req.language,
        frame: req.frame.clone(),
        time_range: req.time_range,
        calendar: calendar(req.time_zone.as_deref(), req.week_start.as_deref())?,
    };
    let sources: BTreeSet<String> = req.queries.iter().map(|q| q.datasource_id.clone()).collect();
    let mut where_ = wanted.summary();
    where_.insert("datasourceIds".into(), json!(sources));
    let made = make_query(&state, &ctx, req, &wanted).await;
    finish(&state, &ctx, &info, None, where_, made).await
}

async fn make_query(state: &AppState, ctx: &OrgCtx, req: ExportRequest, wanted: &Wanted) -> ApiResult<Made> {
    check_items(&req.queries)?;
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    check_variables(&req.variables)?;
    let refs: BTreeSet<&str> = req.queries.iter().map(|q| q.ref_id.as_str()).collect();
    let steps = check_steps(&req.steps, &refs, "steps")
        .map_err(|e| ApiError::validation(e.clone()).with_field("steps").because("steps.invalid").param("detail", e))?;
    // The file holds what running the queries would show, so the same right decides: each data
    // source must be one the caller may query. Unlike a run, one refusal refuses the file.
    let access = DatasourceAccess::load(&state.db, ctx).await?;
    for item in &req.queries {
        access.check(Permission::DatasourcesQuery, &item.datasource_id)?;
    }
    let slots = acquire(state, ctx)?;
    let order: Vec<String> = req.queries.iter().map(|q| q.ref_id.clone()).collect();
    // The graph steps run with their query, as when Explore shows the result.
    let mut queries = req.queries;
    for q in &mut queries {
        if q.steps.is_empty() {
            q.steps = graph_steps_of(&req.steps, &q.ref_id);
        }
    }
    check_items(&queries)?;
    crate::datasources::check_item_steps(&queries)?;
    let response =
        run_queries(state, ctx, queries, req.time_range, req.interval_ms, req.max_data_points, &req.variables).await;
    let title = req.title.unwrap_or_else(|| "kalzit-export".into());
    let stream = produce(state, response, &order, steps, wanted, slots).await?;
    Ok(Made { file: stream, title, summary: wanted.summary() })
}

async fn export_panel(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<PanelExportRequest>,
) -> ApiResult<Response> {
    let wanted = Wanted {
        format: req.format,
        language: req.language,
        frame: req.frame.clone(),
        time_range: req.time_range,
        calendar: calendar(req.time_zone.as_deref(), req.week_start.as_deref())?,
    };
    let mut where_ = wanted.summary();
    where_.insert("panelId".into(), json!(panel_id));
    let made = make_panel(&state, &ctx, &dashboard_id, &panel_id, req, &wanted).await;
    // A dashboard the caller may not see is not named in their refused entry.
    let seen = !matches!(&made, Err(e) if e.code == "not_found");
    finish(&state, &ctx, &info, seen.then_some(dashboard_id.as_str()), where_, made).await
}

async fn make_panel(
    state: &AppState,
    ctx: &OrgCtx,
    dashboard_id: &str,
    panel_id: &str,
    req: PanelExportRequest,
    wanted: &Wanted,
) -> ApiResult<Made> {
    let model = readable_model(state, ctx, dashboard_id).await?;
    let panel = model.panels.iter().find(|p| p.id == panel_id).ok_or_else(ApiError::not_found)?;
    // A panel linked to a library panel or saved analysis exports its queries and steps, which the
    // dashboard showing it authorizes, as when the panel runs (`query::panel_query`).
    let linked = crate::dashboards::linked_content(&state.db, &ctx.org_id, panel).await?;
    let panel = linked.as_ref().unwrap_or(panel);
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    check_variables(&req.variables)?;
    let (variables, identifiers) = resolve_variables(&model, &req.variables)?;
    // Hidden targets stay with the panel but are not run, unless a step reads them: a panel with
    // only hidden ones nobody reads has nothing to export.
    let read = super::query::frames_read(&panel.transformations);
    let runs = |t: &crate::dashboards::model::Target| !t.hide || read.contains(&t.ref_id);
    if !panel.targets.iter().any(runs) {
        return Err(ApiError::validation("the panel has no query to export").because("export.no_queries"));
    }
    let refs: BTreeSet<&str> = panel.targets.iter().map(|t| t.ref_id.as_str()).collect();
    // Checked when the dashboard was saved; failing here means the stored model is broken.
    let steps = check_steps(&panel.transformations, &refs, "transformations")
        .map_err(|e| ApiError::internal("export", format!("stored steps of panel {panel_id}: {e}")))?;
    let items: Vec<QueryItem> = panel
        .targets
        .iter()
        .filter(|t| runs(t))
        .map(|t| QueryItem {
            ref_id: t.ref_id.clone(),
            datasource_id: t.datasource_id.clone(),
            query: t.query.clone(),
            cursor: None,
            limit: None,
            steps: graph_steps_of(&panel.transformations, &t.ref_id),
        })
        .collect();
    check_items(&items)?;
    let slots = acquire(state, ctx)?;
    let order: Vec<String> = items.iter().map(|i| i.ref_id.clone()).collect();
    let response = run_queries_with(
        state,
        ctx,
        items,
        req.time_range,
        req.interval_ms,
        req.max_data_points,
        &variables,
        Some(&identifiers),
    )
    .await;
    let title = if panel.title.trim().is_empty() { model.title.clone() } else { panel.title.clone() };
    let stream = produce(state, response, &order, steps, wanted, slots).await?;
    let mut summary = wanted.summary();
    summary.insert("panelId".into(), json!(panel_id));
    Ok(Made { file: stream, title, summary })
}

fn too_busy() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "too many exports run at the moment; try again shortly")
        .because("export.busy")
}

/// Writes the audit entry, of the export or of its refusal, and answers the file or the error.
async fn finish(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    dashboard_id: Option<&str>,
    mut where_: serde_json::Map<String, Value>,
    made: ApiResult<Made>,
) -> ApiResult<Response> {
    match made {
        Ok(made) => {
            let pending = Pending {
                state: state.clone(),
                ctx: ctx.clone(),
                info: info.clone(),
                dashboard_id: dashboard_id.map(String::from),
                summary: made.summary,
            };
            Ok(attachment(made.file, pending, &made.title))
        }
        Err(e) => {
            where_.insert("code".into(), json!(e.code));
            if let Some(reason) = &e.reason {
                where_.insert("reason".into(), json!(reason.code));
            }
            // The refusal is what the caller needs to hear; a failed audit write is logged.
            if let Err(audit) =
                record(state, ctx, info, "data.export_refused", dashboard_id, Value::Object(where_)).await
            {
                tracing::warn!("audit entry of a refused export: {}", audit.message);
            }
            Err(e)
        }
    }
}

/// The file from the queries' outcomes: every query must have answered (a file never holds less
/// than asked for without saying so), then the steps run and the chosen frame is encoded.
async fn produce(
    state: &AppState,
    mut response: QueryResponse,
    order: &[String],
    steps: Vec<Step>,
    wanted: &Wanted,
    // The server slot is held by the blocking work itself until the file is complete: a client
    // that goes away ends the request, not the work.
    slots: Slots,
) -> ApiResult<Spooled> {
    let timeout = crate::settings::get(state, "datasources.query_timeout_secs")
        .await
        .ok()
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    let mut inputs = Vec::new();
    // Results that are no frame: exported only after a projection or a graph step made one.
    let mut other_shapes = Vec::new();
    // Graph steps that ran with their query (in the database or on the server); their results
    // are the inputs here.
    let mut done = BTreeSet::new();
    for ref_id in order {
        match response.results.remove(ref_id) {
            Some(QueryOutcome::Ok { result, steps: ran, .. }) => {
                done.extend(ran.into_iter().flatten().filter(|p| p.error.is_none()).map(|p| p.id));
                match result {
                    QueryResult::Frame { frame } => inputs.push((ref_id.clone(), Input::Frame(frame))),
                    QueryResult::Documents { documents } => {
                        other_shapes.push((ref_id.clone(), Shape::Documents));
                        inputs.push((ref_id.clone(), Input::Documents(documents)));
                    }
                    QueryResult::Graph { graph } => {
                        other_shapes.push((ref_id.clone(), Shape::Graph));
                        inputs.push((ref_id.clone(), Input::Graph(graph)));
                    }
                }
            }
            Some(QueryOutcome::Err { error }) => return Err(api_error(error)),
            None => return Err(ApiError::internal("export", format!("no outcome for {ref_id}"))),
        }
    }
    let (format, language, frame) = (wanted.format, wanted.language, wanted.frame.clone());
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = CancelOnDrop(cancelled.clone());
    let control = Control::new(cancelled, timeout).with_calendar(wanted.calendar);
    let spool = state.config.paths.data_dir.join(SPOOL_DIR);
    let limits = *state.export_limits.read_or_recover();
    let Slots { permit, user } = slots;
    // Steps and encoding take CPU time and disk; they run off the request threads.
    let work = move || -> Result<Spooled, ApiError> {
        let permit = permit;
        #[cfg(test)]
        tests::hold_if_asked(&steps);
        let (frames, _) = steps::run_shapes(&steps, inputs, &control, &done).map_err(|f| {
            let message = format!("step {}: {}", f.index + 1, f.detail.message);
            step_error(message, f.detail)
        })?;
        let chosen = match &frame {
            Some(name) => frames.iter().find(|f| &f.name == name),
            None => frames.first(),
        };
        let Some(chosen) = chosen else {
            let shape = other_shapes.iter().find(|(r, _)| frame.as_ref().is_none_or(|f| f == r)).map(|(_, s)| *s);
            return Err(match shape {
                Some(shape) => {
                    let shape =
                        serde_json::to_value(shape).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                    refused(
                        Detail::new("export.shape_unsupported", format!("{shape} results cannot be exported yet"))
                            .with("shape", shape),
                    )
                }
                None => {
                    let name = frame.unwrap_or_default();
                    refused(
                        Detail::new("export.frame_missing", format!("there is no table {name} to export"))
                            .with("frame", &name),
                    )
                    .with_field("frame")
                }
            });
        };
        let frame = &chosen.frame;
        let io = |e: std::io::Error| ApiError::internal("export", format!("the spool file: {e}"));
        std::fs::create_dir_all(&spool).map_err(io)?;
        // The file may be as large as its cells suggest, up to the limit; the disk keeps what
        // the data directory's other users (the databases) need.
        let size =
            (frame.rows().saturating_mul(frame.fields().len()).saturating_mul(24) as u64).min(limits.file_bytes as u64);
        // An Excel file takes three copies at once: the sheet, the workbook and the spool file.
        let estimate = if format == ExportFormat::Xlsx { size.saturating_mul(3) } else { size };
        let free = crate::updates::platform::free_space(&spool);
        if free.is_none() {
            tracing::warn!(
                "the free disk space of {} is unknown; the export is made without checking it",
                spool.display()
            );
        }
        if let Some(free) = free
            && free < limits.keep_free.saturating_add(estimate)
        {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "the server has too little free disk space to make this file",
            )
            .because("export.disk_space")
            .param("free", free)
            .param("needed", limits.keep_free.saturating_add(estimate)));
        }
        let (file, path) =
            tempfile::Builder::new().prefix("export-").suffix(".part").tempfile_in(&spool).map_err(io)?.into_parts();
        let mut out = std::io::BufWriter::with_capacity(CHUNK, file);
        let mut write = |chunk: Vec<u8>| {
            out.write_all(&chunk)
                .map_err(|e| Detail::new("export.failed", format!("the file could not be written: {e}")))
        };
        let caps = export::Caps { file_bytes: limits.file_bytes };
        export::encode_to(frame, &chosen.name, format, language, &control, caps, &spool, true, &mut write)
            .map_err(|d| if d.reason.starts_with("steps.") { step_error(d.message.clone(), d) } else { refused(d) })?;
        let file = out.into_inner().map_err(|e| io(e.into_error()))?;
        let len = file.metadata().map_err(io)?.len();
        drop(file);
        // Complete: the server's slot is free for the next export while this one is sent.
        drop(permit);
        Ok(Spooled { path, len, rows: frame.rows(), kind: export::kind(format), user })
    };
    tokio::task::spawn_blocking(work).await.map_err(|e| ApiError::internal("export", e))?
}

/// A step's failure as an answer: the time limit as `query_timeout`, anything else as a
/// `validation` of the steps.
fn step_error(message: String, detail: Detail) -> ApiError {
    let e = if detail.reason == "steps.timeout" {
        ApiError::new(StatusCode::GATEWAY_TIMEOUT, "query_timeout", message)
    } else {
        ApiError::validation(message).with_field("steps")
    };
    e.with_reason(detail.reason, detail.params)
}

async fn record(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    action: &str,
    dashboard_id: Option<&str>,
    summary: Value,
) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    let event = AuditEvent {
        org_id: Some(&ctx.org_id),
        actor_user_id: Some(&ctx.user.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: dashboard_id.map(|_| "dashboard"),
        resource_id: dashboard_id,
        summary,
        at_ms: state.clock.now_ms(),
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// What the audit entry of an export needs once it ends.
struct Pending {
    state: AppState,
    ctx: OrgCtx,
    info: RequestInfo,
    dashboard_id: Option<String>,
    summary: serde_json::Map<String, Value>,
}

impl Pending {
    /// Writes the entry in a task of its own, so that nothing dropping the response (a client
    /// that went away) can cancel it halfway.
    async fn record(mut self, action: &'static str, extra: Vec<(&'static str, Value)>) -> ApiResult<()> {
        for (k, v) in extra {
            self.summary.insert(k.into(), v);
        }
        #[cfg(test)]
        if tests::audit_fails(&self.ctx.org_id) && action == "data.exported" {
            return Err(ApiError::internal("export", "the audit entry could not be written"));
        }
        tokio::spawn(async move {
            record(
                &self.state,
                &self.ctx,
                &self.info,
                action,
                self.dashboard_id.as_deref(),
                Value::Object(self.summary),
            )
            .await
        })
        .await
        .map_err(|e| ApiError::internal("export", e))?
    }
}

/// Why a download ended early.
fn stopped(reason: &'static str, message: &str) -> Detail {
    Detail::new(reason, message.to_string())
}

/// Sends the spooled file in chunks, then ends. It owns the user's slot and the spool file until
/// the last byte is sent or the download is given up, and writes the audit entry.
async fn send_file(file: Spooled, tx: mpsc::Sender<Msg>, pending: Pending, limits: Limits) {
    use tokio::io::AsyncReadExt;
    let started = Instant::now();
    let Spooled { path, len, rows, user: _user, .. } = file;
    let mut sent: u64 = 0;
    // Set once `data.exported` is written: the file was complete on the server then, and a client
    // that drops at the last chunk does not turn it into an aborted export.
    let mut recorded = false;
    let outcome: Result<(), (Detail, &'static str)> = async {
        // A file without bytes still gets its entry.
        if len == 0 {
            pending.record_exported(rows).await.map_err(|e| (stopped("export.audit_failed", &e.message), "audit"))?;
            recorded = true;
        }
        let mut source = tokio::fs::File::open(&path)
            .await
            .map_err(|e| (stopped("export.failed", &format!("the spool file: {e}")), "failed"))?;
        while sent < len {
            let mut chunk = Vec::with_capacity(CHUNK);
            let n = (&mut source)
                .take(CHUNK as u64)
                .read_to_end(&mut chunk)
                .await
                .map_err(|e| (stopped("export.failed", &format!("the spool file: {e}")), "failed"))?;
            if n == 0 {
                break;
            }
            // The entry comes before the last chunk: when it cannot be written the client does
            // not get a file that was not recorded.
            if sent + n as u64 >= len {
                pending
                    .record_exported(rows)
                    .await
                    .map_err(|e| (stopped("export.audit_failed", &e.message), "audit"))?;
                recorded = true;
            }
            let left = limits.download.saturating_sub(started.elapsed());
            if left.is_zero() {
                return Err((stopped("export.download_too_long", "the download took too long"), "deadline"));
            }
            let wait = limits.stall.min(left);
            match tokio::time::timeout(wait, tx.send(Msg::Chunk(chunk))).await {
                Ok(Ok(())) => sent += n as u64,
                Ok(Err(_)) => return Err((stopped("export.client_gone", "the client went away"), "gone")),
                Err(_) if wait == left => {
                    return Err((stopped("export.download_too_long", "the download took too long"), "deadline"));
                }
                Err(_) => return Err((stopped("export.stalled", "the client stopped taking the file"), "stalled")),
            }
        }
        Ok(())
    }
    .await;
    match outcome {
        Ok(()) => {
            let _ = tokio::time::timeout(limits.stall, tx.send(Msg::Done)).await;
        }
        Err((detail, kind)) => {
            let reason = detail.reason;
            let _ = tx.try_send(Msg::Failed(detail.message.clone()));
            if kind == "audit" {
                // The database that takes the audit log is failing: operators must see it.
                tracing::error!(
                    "the audit entry of an export could not be written, the download was broken off: {}",
                    detail.message
                );
            } else if recorded {
                // `data.exported` exists: the file was complete; no second entry for the same export.
                tracing::info!("an export was recorded as made, but the client left before its last chunk: {reason}");
            } else {
                let aborted = pending.record(
                    "data.export_aborted",
                    vec![("reason", json!(reason)), ("bytes", json!(sent)), ("of", json!(len))],
                );
                if let Err(e) = aborted.await {
                    tracing::warn!("audit entry of an aborted export: {}", e.message);
                }
            }
        }
    }
}

impl Pending {
    async fn record_exported(&self, rows: usize) -> ApiResult<()> {
        let copy = Pending {
            state: self.state.clone(),
            ctx: self.ctx.clone(),
            info: self.info.clone(),
            dashboard_id: self.dashboard_id.clone(),
            summary: self.summary.clone(),
        };
        copy.record("data.exported", vec![("rows", json!(rows))]).await
    }
}

fn attachment(file: Spooled, pending: Pending, title: &str) -> Response {
    let name = export::file_name(title, file.kind.extension);
    let (tx, rx) = mpsc::channel::<Msg>(QUEUED_CHUNKS);
    let kind = file.kind;
    let limits = *pending.state.export_limits.read_or_recover();
    tokio::spawn(send_file(file, tx, pending, limits));
    let chunks = futures_util::stream::unfold(rx, |mut rx| async move {
        match rx.recv().await {
            Some(Msg::Chunk(c)) => Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(c)), rx)),
            Some(Msg::Done) => None,
            Some(Msg::Failed(message)) => Some((Err(std::io::Error::other(message)), rx)),
            None => Some((Err(std::io::Error::other("the export stopped")), rx)),
        }
    });
    let mut response = Response::new(Body::from_stream(chunks));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(kind.content_type));
    // `file_name` leaves only ASCII letters, digits, `-`, `_` and the dot: always a valid header.
    if let Ok(value) = header::HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;
