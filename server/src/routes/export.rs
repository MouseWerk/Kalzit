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
//! The file is streamed: the encoder writes chunks of 1 MiB into a channel of two that feeds the
//! response body, so a slow client slows the encoder down and memory holds the frame plus a few
//! chunks, whatever the file's size. The answer is chosen at the first chunk: everything that
//! goes wrong before it (the queries, the steps, a small file's size limit) is a proper error
//! answer. A failure after it (a CSV or JSON file passing the size limit, the client stalling for
//! longer than `STALL_SECS`) breaks the response off, and the audit log gets `data.export_aborted`
//! instead of `data.exported`; the entry of a finished file is written before its last byte is
//! sent. The query timeout bounds the queries and steps, not the download itself.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use axum::Extension;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode, header};
use axum::response::Response;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::query::{api_error, check_variables, readable_model, resolve_variables};
use super::table::{RouteDef, route};
use crate::analysis::expr::Calendar;
use crate::analysis::steps::{self, Control, Input};
use crate::analysis::{Step, check_steps, export};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::datasources::detail::Detail;
use crate::datasources::{check_interval, check_items, check_range, run_queries, run_queries_with};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::{
    ExportFormat, ExportLanguage, ExportRequest, PanelExportRequest, QueryItem, QueryOutcome, QueryResponse,
    QueryResult, Shape, TimeRange,
};

/// Exports that make their file at the same time, per server (`AppState::exports`).
pub const MAX_EXPORTS: usize = 3;
/// The steps' and the encoder's time limit when the setting cannot be read.
const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Chunks waiting between the encoder and the response body.
const QUEUED_CHUNKS: usize = 2;
/// A client that takes no chunk for this long loses its export, so a connection that stays open
/// without reading cannot hold a slot for ever.
const STALL_SECS: u64 = 60;
/// Where an export's temporary files go, inside the data directory.
const SPOOL_DIR: &str = "export-tmp";

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
        route(Method::POST, "/orgs/{orgId}/export", Access::Org(Permission::DataExport), export_query),
        // And `dashboards:read` on the dashboard, checked in the handler.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/export",
            Access::Org(Permission::DataExport),
            export_panel,
        ),
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

/// What the encoder tells the response body.
enum Msg {
    Chunk(Vec<u8>),
    /// The file is complete, with the frame's row count for the audit entry.
    Done(usize),
    Failed(ApiError),
}

/// A file being made: its first chunk and the rest to come.
struct Streaming {
    first: Vec<u8>,
    rx: mpsc::Receiver<Msg>,
    kind: export::Kind,
    cancel: CancelOnDrop,
}

/// A file being made and where its audit entry points.
struct Made {
    stream: Streaming,
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
    for item in &req.queries {
        check_resource(&state.db, ctx, Permission::DatasourcesQuery, Resource::Datasource(&item.datasource_id)).await?;
    }
    let permit = state.exports.clone().try_acquire_owned().map_err(|_| too_busy())?;
    let order: Vec<String> = req.queries.iter().map(|q| q.ref_id.clone()).collect();
    let response =
        run_queries(state, ctx, req.queries, req.time_range, req.interval_ms, req.max_data_points, &req.variables)
            .await;
    let title = req.title.unwrap_or_else(|| "kalzit-export".into());
    let stream = produce(state, response, &order, steps, wanted, permit).await?;
    Ok(Made { stream, title, summary: wanted.summary() })
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
        })
        .collect();
    check_items(&items)?;
    let permit = state.exports.clone().try_acquire_owned().map_err(|_| too_busy())?;
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
    let stream = produce(state, response, &order, steps, wanted, permit).await?;
    let mut summary = wanted.summary();
    summary.insert("panelId".into(), json!(panel_id));
    Ok(Made { stream, title, summary })
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
            Ok(attachment(made.stream, pending, &made.title))
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
    // Held by the blocking work itself: a client that goes away ends the request, not the work,
    // and the slot is free only when the work has stopped.
    permit: tokio::sync::OwnedSemaphorePermit,
) -> ApiResult<Streaming> {
    let timeout = crate::settings::get(state, "datasources.query_timeout_secs")
        .await
        .ok()
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    let mut inputs = Vec::new();
    // Results that are no frame: exported only after a projection made one of them.
    let mut other_shapes = Vec::new();
    for ref_id in order {
        match response.results.remove(ref_id) {
            Some(QueryOutcome::Ok { result: QueryResult::Frame { frame } }) => {
                inputs.push((ref_id.clone(), Input::Frame(frame)))
            }
            Some(QueryOutcome::Ok { result: QueryResult::Documents { documents } }) => {
                other_shapes.push((ref_id.clone(), Shape::Documents));
                inputs.push((ref_id.clone(), Input::Documents(documents)));
            }
            Some(QueryOutcome::Ok { result }) => other_shapes.push((ref_id.clone(), result.shape())),
            Some(QueryOutcome::Err { error }) => return Err(api_error(error)),
            None => return Err(ApiError::internal("export", format!("no outcome for {ref_id}"))),
        }
    }
    let (format, language, frame) = (wanted.format, wanted.language, wanted.frame.clone());
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel = CancelOnDrop(cancelled.clone());
    let control = Control::new(cancelled.clone(), timeout).with_calendar(wanted.calendar);
    let spool = state.config.paths.data_dir.join(SPOOL_DIR);
    let (tx, mut rx) = mpsc::channel::<Msg>(QUEUED_CHUNKS);
    let (tx_end, cancelled_end) = (tx.clone(), cancelled.clone());
    // Steps and encoding take CPU time; they run off the request threads.
    let work = move || -> Result<usize, ApiError> {
        let _permit = permit;
        #[cfg(test)]
        tests::hold_if_asked(&steps);
        let frames = steps::run_inputs(&steps, inputs, &control).map_err(|f| {
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
        // Sending to the client is paced by the client: the deadline covers the steps above.
        let mut send = |chunk: Vec<u8>| {
            send_chunk(&tx, &cancelled, Msg::Chunk(chunk), Duration::from_secs(STALL_SECS))
                .then_some(())
                .ok_or_else(|| Detail::new("steps.cancelled", "the client stopped taking the file"))
        };
        export::encode_to(
            frame,
            &chosen.name,
            format,
            language,
            &control,
            export::Caps::default(),
            &spool,
            false,
            &mut send,
        )
        .map_err(|d| if d.reason.starts_with("steps.") { step_error(d.message.clone(), d) } else { refused(d) })?;
        Ok(frame.rows())
    };
    tokio::task::spawn_blocking(move || {
        let end = match work() {
            Ok(rows) => Msg::Done(rows),
            Err(e) => Msg::Failed(e),
        };
        // The client may be gone already; then nobody reads the end.
        let _ = send_chunk(&tx_end, &cancelled_end, end, Duration::from_secs(STALL_SECS));
    });
    match rx.recv().await {
        Some(Msg::Chunk(first)) => Ok(Streaming { first, rx, kind: export::kind(format), cancel }),
        Some(Msg::Failed(e)) => Err(e),
        Some(Msg::Done(_)) | None => Err(ApiError::internal("export", "the export made no file")),
    }
}

/// Puts `msg` on the channel, waiting while it is full. Fails when the client went away (the
/// receiver is gone), the cancel flag is set or nothing was taken for `stall`.
fn send_chunk(tx: &mpsc::Sender<Msg>, cancelled: &AtomicBool, mut msg: Msg, stall: Duration) -> bool {
    let start = Instant::now();
    loop {
        match tx.try_send(msg) {
            Ok(()) => return true,
            Err(mpsc::error::TrySendError::Closed(_)) => return false,
            Err(mpsc::error::TrySendError::Full(back)) => {
                if cancelled.load(Ordering::Relaxed) || start.elapsed() > stall {
                    return false;
                }
                msg = back;
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
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

/// What the audit entry of a streamed file needs once it ends.
struct Pending {
    state: AppState,
    ctx: OrgCtx,
    info: RequestInfo,
    dashboard_id: Option<String>,
    summary: serde_json::Map<String, Value>,
}

impl Pending {
    async fn record(mut self, action: &str, extra: Vec<(&str, Value)>) {
        for (k, v) in extra {
            self.summary.insert(k.into(), v);
        }
        let done = record(
            &self.state,
            &self.ctx,
            &self.info,
            action,
            self.dashboard_id.as_deref(),
            Value::Object(self.summary),
        )
        .await;
        if let Err(e) = done {
            tracing::warn!("audit entry of an export: {}", e.message);
        }
    }
}

/// The response body's state; its audit entry is written when the file ends, or, if the body is
/// dropped before that (the client went away), as an aborted export.
struct BodyState {
    first: Option<Vec<u8>>,
    rx: mpsc::Receiver<Msg>,
    pending: Option<Pending>,
    _cancel: CancelOnDrop,
}

impl Drop for BodyState {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(pending.record("data.export_aborted", vec![("reason", json!("client_gone"))]));
        }
    }
}

fn attachment(stream: Streaming, pending: Pending, title: &str) -> Response {
    let name = export::file_name(title, stream.kind.extension);
    let state = BodyState { first: Some(stream.first), rx: stream.rx, pending: Some(pending), _cancel: stream.cancel };
    let chunks = futures_util::stream::unfold(state, |mut s| async move {
        if let Some(first) = s.first.take() {
            return Some((Ok::<_, std::io::Error>(axum::body::Bytes::from(first)), s));
        }
        match s.rx.recv().await {
            Some(Msg::Chunk(c)) => Some((Ok(axum::body::Bytes::from(c)), s)),
            Some(Msg::Done(rows)) => {
                // Before the last byte goes out, so a client that has the whole file finds its entry.
                if let Some(p) = s.pending.take() {
                    p.record("data.exported", vec![("rows", json!(rows))]).await;
                }
                None
            }
            Some(Msg::Failed(e)) => {
                if let Some(p) = s.pending.take() {
                    let reason = e.reason.as_ref().map_or(e.code, |r| r.code.as_str()).to_string();
                    p.record("data.export_aborted", vec![("reason", json!(reason))]).await;
                }
                Some((Err(std::io::Error::other(e.message)), s))
            }
            None => {
                if let Some(p) = s.pending.take() {
                    p.record("data.export_aborted", vec![("reason", json!("stopped"))]).await;
                }
                Some((Err(std::io::Error::other("the export stopped")), s))
            }
        }
    });
    let mut response = Response::new(Body::from_stream(chunks));
    *response.status_mut() = StatusCode::OK;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static(stream.kind.content_type));
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
