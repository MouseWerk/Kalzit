//! Reading the audit log (an organization's with `audit:read`, the whole server's for server
//! administrators), exporting it as CSV or JSON with the same rights and filters, and deleting
//! events older than `audit.retention_days`.

use std::collections::HashSet;

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::response::Response;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::support::{Paging, QueryParams};
use super::table::{RouteDef, route};
use crate::analysis::export::{defuse, file_name, quote};
use crate::analysis::expr::iso_time;
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::auth::SessionUser;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders;
use crate::locks::RwLockExt;
use crate::net::RequestInfo;
use crate::settings;
use crate::shapes::{ExportLanguage, Page};

const DAY_MS: i64 = 24 * 3600 * 1000;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/audit", Access::Org(Permission::AuditRead), list_org),
        route(Method::GET, "/admin/audit", Access::ServerAdmin, list_server),
        route(Method::POST, "/orgs/{orgId}/audit/export", Access::Org(Permission::AuditRead), export_org),
        route(Method::POST, "/admin/audit/export", Access::ServerAdmin, export_server),
    ]
}

/// Events one export holds at most (`routes::export::Limits::audit_events`, smaller in tests);
/// more are refused, so a file never holds less than its filters ask for without saying so. A
/// shorter time range or a filter makes a smaller file.
pub const MAX_EXPORT_EVENTS: usize = 100_000;
/// Events read per query while an export collects them.
const EXPORT_BATCH: u32 = 1_000;

/// `POST /orgs/{orgId}/audit/export` and `POST /admin/audit/export`: every event the list shows
/// for these filters, all pages of them, as one file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditExportRequest {
    format: AuditFormat,
    /// CSV only: `de` separates with `;`, `en` (the default) with `,`.
    language: Option<ExportLanguage>,
    actor: Option<String>,
    action: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    /// Server export only: one organization.
    org_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum AuditFormat {
    Csv,
    Json,
}

impl AuditExportRequest {
    /// The list's filters, without paging.
    fn query(&self) -> AuditQuery {
        AuditQuery {
            actor: self.actor.clone(),
            action: self.action.clone(),
            resource_type: self.resource_type.clone(),
            resource_id: self.resource_id.clone(),
            from: self.from,
            to: self.to,
            limit: None,
            cursor: None,
            org_id: None,
        }
    }

    /// The audit summary: the format and the filters that were set, never the events.
    fn summary(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("format".into(), json!(self.format));
        let filters = [
            ("actor", self.actor.as_ref().map(|v| json!(v))),
            ("action", self.action.as_ref().map(|v| json!(v))),
            ("resourceType", self.resource_type.as_ref().map(|v| json!(v))),
            ("resourceId", self.resource_id.as_ref().map(|v| json!(v))),
            ("from", self.from.map(|v| json!(v))),
            ("to", self.to.map(|v| json!(v))),
            ("orgId", self.org_id.as_ref().map(|v| json!(v))),
        ];
        for (key, value) in filters {
            if let Some(value) = value {
                m.insert(key.into(), value);
            }
        }
        m
    }
}

async fn export_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<AuditExportRequest>,
) -> ApiResult<Response> {
    if req.org_id.is_some() {
        return Err(ApiError::validation("orgId is a filter of the server export only").with_field("orgId"));
    }
    let viewer = Viewer {
        org_id: Some(&ctx.org_id),
        user_id: &ctx.user.id,
        role: &ctx.role,
        sees_every_folder: folders::sees_every_folder(&ctx),
        scrub: (folders::sees_every_folder(&ctx) == 0).then_some(&ctx),
    };
    export(&state, viewer, Scope::Org(&ctx.org_id), &ctx.user, &info, req).await
}

async fn export_server(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<AuditExportRequest>,
) -> ApiResult<Response> {
    if req.org_id.as_deref().is_some_and(|o| o.trim().is_empty()) {
        return Err(ApiError::validation("orgId must not be empty").with_field("orgId"));
    }
    let org = req.org_id.clone();
    if let Some(org) = org.as_deref() {
        let found: Option<(String,)> =
            sqlx::query_as("SELECT id FROM orgs WHERE id = $1").bind(org).fetch_optional(&state.db).await?;
        if found.is_none() {
            return Err(ApiError::validation("orgId names no organization").with_field("orgId"));
        }
    }
    // Server administrators see every event; no folder is hidden from this view.
    let viewer = Viewer { org_id: org.as_deref(), user_id: "", role: "", sees_every_folder: 1, scrub: None };
    export(&state, viewer, Scope::Server, &admin, &info, req).await
}

/// Where `audit.exported` is recorded: in the organization of an organization's export, at
/// server level for a server administrator's (also when it was narrowed to one organization).
#[derive(Clone, Copy)]
enum Scope<'a> {
    Org(&'a str),
    Server,
}

/// Streams every event the filters match, as the list shows them to this viewer, batch by batch
/// into a spool file (memory holds one batch), records `audit.exported` once the file is complete
/// and sends the file from disk. When the entry cannot be written, there is no file. The export
/// takes the same slots as a data export: one per user, and one of the server's while the file
/// is made.
async fn export(
    state: &AppState,
    viewer: Viewer<'_>,
    scope: Scope<'_>,
    actor: &SessionUser,
    info: &RequestInfo,
    req: AuditExportRequest,
) -> ApiResult<Response> {
    let q = req.query();
    check_range(&q)?;
    let limits = *state.export_limits.read_or_recover();
    let slots = crate::routes::export::acquire_for(state, &actor.id)?;
    let unnamed = unnamed_folders(state, &viewer).await?;
    let spool = state.config.paths.data_dir.join(crate::routes::export::SPOOL_DIR);
    let io = |e: std::io::Error| ApiError::internal("audit", format!("the spool file: {e}"));
    std::fs::create_dir_all(&spool).map_err(io)?;
    if let Some(free) = crate::updates::platform::free_space(&spool)
        && free < limits.keep_free
    {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "busy",
            "the server has too little free disk space to make this file",
        )
        .because("export.disk_space")
        .param("free", free)
        .param("needed", limits.keep_free));
    }
    let (file, path) =
        tempfile::Builder::new().prefix("audit-").suffix(".part").tempfile_in(&spool).map_err(io)?.into_parts();
    let language = req.language.unwrap_or(ExportLanguage::En);
    let mut writer = Some(AuditWriter::new(file, req.format, language, limits.file_bytes));
    let mut count = 0usize;
    let mut cursor: Option<String> = None;
    loop {
        let paging = Paging::batch(EXPORT_BATCH, cursor.as_deref())?;
        let rows = fetch(state, &viewer, &q, &paging, &unnamed).await?;
        let page = paging.page(rows, |e| (e.created_at, e.id.as_str()));
        count += page.items.len();
        if count > limits.audit_events {
            return Err(ApiError::validation(format!(
                "the export would hold more than {} events; choose a shorter time range or a filter",
                limits.audit_events
            ))
            .because("export.too_many_events")
            .param("max", limits.audit_events));
        }
        // Encoding and writing a batch is file work: off the request threads.
        let mut w = writer.take().ok_or_else(|| ApiError::internal("audit", "the writer is gone"))?;
        let items = page.items;
        let w = tokio::task::spawn_blocking(move || w.write(&items).map(|()| w))
            .await
            .map_err(|e| ApiError::internal("audit", e))??;
        writer = Some(w);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    let writer = writer.ok_or_else(|| ApiError::internal("audit", "the writer is gone"))?;
    let len =
        tokio::task::spawn_blocking(move || writer.finish()).await.map_err(|e| ApiError::internal("audit", e))??;
    // Complete: the server's slot is free for the next export while this one is sent.
    let crate::routes::export::Slots { permit, user } = slots;
    drop(permit);
    let mut summary = req.summary();
    summary.insert("events".into(), json!(count));
    let mut tx = crate::db::begin(&state.db).await?;
    let event = AuditEvent {
        org_id: match scope {
            Scope::Org(org) => Some(org),
            Scope::Server => None,
        },
        actor_user_id: Some(&actor.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "audit.exported",
        resource_type: None,
        resource_id: None,
        summary: Value::Object(summary),
        at_ms: state.clock.now_ms(),
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    let (content_type, extension) = match req.format {
        AuditFormat::Csv => ("text/csv; charset=utf-8", "csv"),
        AuditFormat::Json => ("application/json", "json"),
    };
    let name = file_name("kalzit-audit", extension);
    Ok(crate::routes::export::send_spooled(path, len, user, limits, content_type, &name))
}

/// The columns of the CSV file, named as the API names the fields.
const CSV_COLUMNS: [&str; 12] = [
    "createdAt",
    "id",
    "orgId",
    "actorUserId",
    "actorName",
    "actorAddress",
    "actorTokenId",
    "actorTokenPrefix",
    "action",
    "resourceType",
    "resourceId",
    "summary",
];

/// Writes an audit export batch by batch, within the file size limit.
struct AuditWriter {
    out: std::io::BufWriter<std::fs::File>,
    format: AuditFormat,
    separator: char,
    written: usize,
    max: usize,
    started: bool,
    first: bool,
}

impl AuditWriter {
    fn new(file: std::fs::File, format: AuditFormat, language: ExportLanguage, max: usize) -> Self {
        let separator = if language == ExportLanguage::De { ';' } else { ',' };
        let out = std::io::BufWriter::with_capacity(64 * 1024, file);
        Self { out, format, separator, written: 0, max, started: false, first: true }
    }

    fn put(&mut self, bytes: &[u8]) -> ApiResult<()> {
        use std::io::Write as _;
        if self.written + bytes.len() > self.max {
            return Err(ApiError::validation(format!("the file would be larger than {} bytes", self.max))
                .because("export.too_large")
                .param("max", self.max));
        }
        self.written += bytes.len();
        self.out.write_all(bytes).map_err(|e| ApiError::internal("audit", format!("the spool file: {e}")))
    }

    /// The start of the file (the CSV header, the JSON array) comes with the first batch, so an
    /// export without events is still a whole file.
    fn start(&mut self) -> ApiResult<()> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        match self.format {
            AuditFormat::Csv => {
                let sep = self.separator.to_string();
                let header = format!("\u{FEFF}{}\r\n", CSV_COLUMNS.map(|c| self.cell(c)).join(&sep));
                self.put(header.as_bytes())?;
            }
            AuditFormat::Json => self.put(b"[")?,
        }
        Ok(())
    }

    fn cell(&self, text: &str) -> String {
        quote(&defuse(text), self.separator)
    }

    fn write(&mut self, events: &[AuditItem]) -> ApiResult<()> {
        self.start()?;
        for e in events {
            match self.format {
                AuditFormat::Csv => {
                    let line = self.csv_row(e);
                    self.put(line.as_bytes())?;
                }
                AuditFormat::Json => {
                    let item = serde_json::to_vec(e).map_err(|e| ApiError::internal("audit", e))?;
                    if !self.first {
                        self.put(b",")?;
                    }
                    self.put(&item)?;
                }
            }
            self.first = false;
        }
        Ok(())
    }

    /// RFC 4180 CSV as the data exports write it: a byte order mark, CRLF line ends, the time in
    /// ISO 8601 UTC, the summary as compact JSON, and every text a spreadsheet would read as a
    /// formula defused with a leading `'`.
    fn csv_row(&self, e: &AuditItem) -> String {
        let sep = self.separator.to_string();
        let text = |v: &Option<String>| v.as_deref().map(|t| self.cell(t)).unwrap_or_default();
        let row = [
            iso_time(e.created_at),
            self.cell(&e.id),
            text(&e.org_id),
            text(&e.actor_user_id),
            text(&e.actor_name),
            text(&e.actor_address),
            text(&e.actor_token_id),
            text(&e.actor_token_prefix),
            self.cell(&e.action),
            text(&e.resource_type),
            text(&e.resource_id),
            self.cell(&e.summary.to_string()),
        ];
        format!("{}\r\n", row.join(&sep))
    }

    /// Ends the file and answers its size.
    fn finish(mut self) -> ApiResult<u64> {
        use std::io::Write as _;
        self.start()?;
        if self.format == AuditFormat::Json {
            self.put(b"]")?;
        }
        self.out.flush().map_err(|e| ApiError::internal("audit", format!("the spool file: {e}")))?;
        Ok(self.written as u64)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditQuery {
    /// User id of the actor.
    actor: Option<String>,
    /// Prefix of the action: `dashboard.` or `dashboard.saved`.
    action: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
    /// Unix ms, inclusive.
    from: Option<i64>,
    /// Unix ms, exclusive.
    to: Option<i64>,
    limit: Option<u32>,
    cursor: Option<String>,
    /// Server view only: one organization.
    org_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct AuditRow {
    id: String,
    org_id: Option<String>,
    actor_user_id: Option<String>,
    actor_name: Option<String>,
    actor_address: Option<String>,
    actor_token_id: Option<String>,
    actor_token_prefix: Option<String>,
    action: String,
    resource_type: Option<String>,
    resource_id: Option<String>,
    summary: String,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditItem {
    id: String,
    org_id: Option<String>,
    actor_user_id: Option<String>,
    /// The actor's current name; `null` for the system or a removed account.
    actor_name: Option<String>,
    actor_address: Option<String>,
    actor_token_id: Option<String>,
    actor_token_prefix: Option<String>,
    action: String,
    resource_type: Option<String>,
    resource_id: Option<String>,
    summary: Value,
    created_at: i64,
}

async fn list_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<AuditQuery>,
) -> ApiResult<Json<Page<AuditItem>>> {
    if q.org_id.is_some() {
        return Err(ApiError::validation("orgId is a filter of the server view only").with_field("orgId"));
    }
    let viewer = Viewer {
        org_id: Some(&ctx.org_id),
        user_id: &ctx.user.id,
        role: &ctx.role,
        sees_every_folder: folders::sees_every_folder(&ctx),
        scrub: (folders::sees_every_folder(&ctx) == 0).then_some(&ctx),
    };
    list(&state, viewer, q).await
}

async fn list_server(
    State(state): State<AppState>,
    QueryParams(mut q): QueryParams<AuditQuery>,
) -> ApiResult<Json<Page<AuditItem>>> {
    let org = q.org_id.take();
    if org.as_deref().is_some_and(|o| o.trim().is_empty()) {
        return Err(ApiError::validation("orgId must not be empty").with_field("orgId"));
    }
    // Server administrators see every event; no folder is hidden from this view.
    let viewer = Viewer { org_id: org.as_deref(), user_id: "", role: "", sees_every_folder: 1, scrub: None };
    list(&state, viewer, q).await
}

/// Whose view of the log: the organization (`None`: the whole server) and, for hiding events about
/// restricted folders and their dashboards, the parameters of `folders::VISIBILITY_CTE`.
struct Viewer<'a> {
    org_id: Option<&'a str>,
    user_id: &'a str,
    role: &'a str,
    sees_every_folder: i64,
    /// The member whose hidden folders are not named in summaries; `None` names everything.
    scrub: Option<&'a OrgCtx>,
}

/// Newest first. Events about folders and dashboards the viewer cannot see are left out, as the
/// resources themselves are, also once restricted content is purged (`restricted_tombstones`).
async fn list(state: &AppState, viewer: Viewer<'_>, q: AuditQuery) -> ApiResult<Json<Page<AuditItem>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    check_range(&q)?;
    let unnamed = unnamed_folders(state, &viewer).await?;
    let items = fetch(state, &viewer, &q, &paging, &unnamed).await?;
    Ok(Json(paging.page(items, |e| (e.created_at, e.id.as_str()))))
}

fn check_range(q: &AuditQuery) -> ApiResult<()> {
    if let (Some(from), Some(to)) = (q.from, q.to)
        && from > to
    {
        return Err(ApiError::validation("from must not be after to").with_field("from"));
    }
    Ok(())
}

/// Summaries name folders (`parentId`, `folderId`); those the viewer cannot see, or that were
/// restricted when they were purged, are not named.
async fn unnamed_folders(state: &AppState, viewer: &Viewer<'_>) -> ApiResult<HashSet<String>> {
    Ok(match viewer.scrub {
        Some(ctx) => {
            let mut conn = state.db.acquire().await?;
            let mut ids = folders::hidden_folder_ids(&mut conn, ctx).await?;
            let gone: Vec<(String,)> = sqlx::query_as(
                "SELECT resource_id FROM restricted_tombstones WHERE org_id = $1 AND resource_type = 'folder'",
            )
            .bind(&ctx.org_id)
            .fetch_all(&mut *conn)
            .await?;
            ids.extend(gone.into_iter().map(|(id,)| id));
            ids
        }
        None => HashSet::new(),
    })
}

/// One page of events (`paging.fetch_limit()` rows) as the viewer may see them.
async fn fetch(
    state: &AppState,
    viewer: &Viewer<'_>,
    q: &AuditQuery,
    paging: &Paging,
    unnamed: &HashSet<String>,
) -> ApiResult<Vec<AuditItem>> {
    let (sql, args) = list_sql(viewer, q, paging);
    let mut query = sqlx::query_as::<_, AuditRow>(sqlx::AssertSqlSafe(sql));
    for arg in args {
        query = match arg {
            Arg::Text(t) => query.bind(t),
            Arg::Int(i) => query.bind(i),
        };
    }
    let rows: Vec<AuditRow> = query.fetch_all(&state.db).await?;
    let mut items = Vec::with_capacity(rows.len());
    for r in rows {
        let mut summary: Value = serde_json::from_str(&r.summary)
            .map_err(|e| ApiError::internal("audit", format!("summary of event {} is not JSON: {e}", r.id)))?;
        // Folder ids also stand in the team events (`governingId`, `spaceId`, `from`, `to`).
        for key in ["parentId", "folderId", "governingId", "spaceId", "from", "to"] {
            if summary.get(key).and_then(Value::as_str).is_some_and(|id| unnamed.contains(id)) {
                summary[key] = Value::Null;
            }
        }
        items.push(AuditItem {
            id: r.id,
            org_id: r.org_id,
            actor_user_id: r.actor_user_id,
            actor_name: r.actor_name,
            actor_address: r.actor_address,
            actor_token_id: r.actor_token_id,
            actor_token_prefix: r.actor_token_prefix,
            action: r.action,
            resource_type: r.resource_type,
            resource_id: r.resource_id,
            summary,
            created_at: r.created_at,
        });
    }
    Ok(items)
}

/// A bound value of the audit query.
#[derive(Debug)]
enum Arg<'a> {
    Text(Option<&'a str>),
    Int(i64),
}

/// The audit query for `viewer` with only the filters that are set, so the database can use
/// the indexes on the organization, the resource and the time (`audit_events_org_time_id`,
/// `audit_events_org_resource`); a condition like `($n IS NULL OR column = $n)` would make SQLite
/// scan every event. `$1` to `$4` are the parameters of `folders::VISIBILITY_CTE`; the filters
/// follow from `$5`. The checks for hidden folders and dashboards are left out for a viewer who
/// sees every folder, for whom they hold anyway.
fn list_sql<'a>(viewer: &Viewer<'a>, q: &'a AuditQuery, paging: &'a Paging) -> (String, Vec<Arg<'a>>) {
    let mut args = vec![
        Arg::Text(viewer.org_id),
        Arg::Text(Some(viewer.user_id)),
        Arg::Text(Some(viewer.role)),
        Arg::Int(viewer.sees_every_folder),
    ];
    let mut conditions: Vec<String> = Vec::new();
    if viewer.org_id.is_some() {
        conditions.push("e.org_id = $1".into());
    }
    let mut add = |args: &mut Vec<Arg<'a>>, condition: &str, arg: Arg<'a>| {
        args.push(arg);
        conditions.push(condition.replace("$?", &format!("${}", args.len())));
    };
    if let Some(actor) = q.actor.as_deref() {
        add(&mut args, "e.actor_user_id = $?", Arg::Text(Some(actor)));
    }
    if let Some(action) = q.action.as_deref().filter(|a| !a.is_empty()) {
        add(&mut args, "SUBSTR(e.action, 1, LENGTH(CAST($? AS TEXT))) = $?", Arg::Text(Some(action)));
    }
    if let Some(resource_type) = q.resource_type.as_deref() {
        add(&mut args, "e.resource_type = $?", Arg::Text(Some(resource_type)));
    }
    if let Some(resource_id) = q.resource_id.as_deref() {
        add(&mut args, "e.resource_id = $?", Arg::Text(Some(resource_id)));
    }
    if let Some(from) = q.from {
        add(&mut args, "e.created_at >= $?", Arg::Int(from));
    }
    if let Some(to) = q.to {
        add(&mut args, "e.created_at < $?", Arg::Int(to));
    }
    args.push(Arg::Int(paging.before_time()));
    args.push(Arg::Text(Some(paging.before_id())));
    let (t, i) = (args.len() - 1, args.len());
    // As a row value, so the database seeks to the cursor in the index instead of filtering.
    conditions.push(format!("(e.created_at, e.id) < (${t}, ${i})"));
    if viewer.sees_every_folder == 0 {
        conditions.push(format!(
            "NOT ((COALESCE(e.resource_type, '') = 'folder' \
               AND COALESCE(e.resource_id, '') IN (SELECT id FROM hidden_folders)) \
             OR (COALESCE(e.resource_type, '') = 'dashboard' AND COALESCE(e.resource_id, '') IN \
               (SELECT d.id FROM dashboards d WHERE d.org_id = $1 AND NOT {})) \
             OR (COALESCE(e.resource_type, '') = 'analysis' AND COALESCE(e.resource_id, '') IN \
               (SELECT a.id FROM analyses a WHERE a.org_id = $1 AND NOT {})))",
            folders::dashboard_visible("d"),
            folders::analysis_visible("a"),
        ));
        conditions.push(
            "NOT EXISTS (SELECT 1 FROM restricted_tombstones t WHERE t.org_id = e.org_id \
             AND t.resource_type = COALESCE(e.resource_type, '') AND t.resource_id = COALESCE(e.resource_id, ''))"
                .into(),
        );
    }
    args.push(Arg::Int(paging.fetch_limit()));
    let limit = args.len();
    let sql = format!(
        "{} SELECT e.id, e.org_id, e.actor_user_id, u.name AS actor_name, e.actor_address, e.actor_token_id, \
         e.actor_token_prefix, e.action, e.resource_type, \
         e.resource_id, e.summary, e.created_at \
         FROM audit_events e LEFT JOIN users u ON u.id = e.actor_user_id \
         WHERE {} ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}",
        folders::VISIBILITY_CTE,
        conditions.join(" AND "),
    );
    (sql, args)
}

/// Deletes events older than `audit.retention_days` and records how many went. Answers the
/// number deleted.
pub async fn purge_expired(state: &AppState) -> ApiResult<u64> {
    purge_expired_in(state, &state.db).await
}

/// Events deleted per transaction, so a large backlog (a shortened retention, a first run after
/// a long time) never holds the write lock for long; requests write in between.
const PURGE_BATCH: i64 = 5_000;

/// `purge_expired` through `db`: the hourly job uses the background pool.
async fn purge_expired_in(state: &AppState, db: &sqlx::AnyPool) -> ApiResult<u64> {
    let days = settings::get(state, "audit.retention_days").await?;
    let days = days.as_i64().ok_or_else(|| ApiError::internal("audit", "audit.retention_days is not a number"))?;
    let now = state.clock.now_ms();
    let cutoff = now.saturating_sub(days.saturating_mul(DAY_MS));
    let deleted = delete_before(db, cutoff, PURGE_BATCH).await?;
    let mut tx = crate::db::begin(db).await?;
    if deleted > 0 {
        let event = AuditEvent {
            org_id: None,
            actor_user_id: None,
            actor_address: None,
            action: "audit.expired",
            resource_type: None,
            resource_id: None,
            summary: json!({ "deleted": deleted, "before": cutoff }),
            at_ms: now,
        };
        audit::record(&mut tx, &event).await?;
    }
    crate::db::commit(tx).await?;
    Ok(deleted)
}

/// Deletes the events from before `cutoff`, `batch` at a time, each batch in its own transaction.
async fn delete_before(db: &sqlx::AnyPool, cutoff: i64, batch: i64) -> ApiResult<u64> {
    let mut deleted = 0;
    loop {
        let mut tx = crate::db::begin(db).await?;
        let done = sqlx::query(
            "DELETE FROM audit_events WHERE id IN (SELECT id FROM audit_events WHERE created_at < $1 LIMIT $2)",
        )
        .bind(cutoff)
        .bind(batch)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        crate::db::commit(tx).await?;
        deleted += done;
        if done < batch as u64 {
            return Ok(deleted);
        }
    }
}

/// Runs `purge_expired` every hour, like the session cleanup. The retention is a privacy rule,
/// so a run that finds the database busy is tried again within minutes.
pub fn spawn_retention(state: AppState) {
    spawn_retention_on(state, crate::db::Schedule::hourly());
}

/// `spawn_retention` on another schedule (tests).
pub fn spawn_retention_on(state: AppState, schedule: crate::db::Schedule) {
    use crate::db::JobError;
    let cluster_state = state.clone();
    crate::cluster::spawn_job(&cluster_state, "audit:retention", "deleting old audit events", schedule, move || {
        let state = state.clone();
        async move {
            match purge_expired_in(&state, state.background.db()).await {
                Ok(0) => Ok(()),
                Ok(n) => {
                    tracing::info!("deleted {n} audit events past their retention");
                    Ok(())
                }
                Err(e) if e.code == "busy" => Err(JobError::Busy(e.message)),
                Err(e) => Err(JobError::Failed(e.message)),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Old events go in batches, each its own transaction, until none is left; newer ones stay.
    #[tokio::test]
    async fn expired_events_are_deleted_in_batches() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        for i in 0..8_i64 {
            sqlx::query("INSERT INTO audit_events (id, action, summary, created_at) VALUES ($1, 'x.y', '{}', $2)")
                .bind(format!("e{i}"))
                .bind(if i < 7 { 10 + i } else { 1_000 })
                .execute(&db)
                .await
                .unwrap();
        }
        assert_eq!(delete_before(&db, 500, 3).await.unwrap(), 7);
        let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events").fetch_one(&db).await.unwrap();
        assert_eq!(left, 1);
        assert_eq!(delete_before(&db, 500, 3).await.unwrap(), 0);
    }

    /// The audit pages use the indexes on SQLite instead of scanning every event (checked with
    /// EXPLAIN QUERY PLAN), for an organization with and without hidden folders, by resource,
    /// and on a later page.
    #[tokio::test]
    async fn audit_pages_use_the_indexes() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let plan = |viewer: Viewer<'static>, filters: Value, cursor: Option<&'static str>| {
            let db = db.clone();
            async move {
                let q: AuditQuery = serde_json::from_value(filters).unwrap();
                let paging = Paging::new(Some(50), cursor).unwrap();
                let (sql, args) = list_sql(&viewer, &q, &paging);
                let mut query = sqlx::query_as::<_, (i64, i64, i64, String)>(sqlx::AssertSqlSafe(format!(
                    "EXPLAIN QUERY PLAN {sql}"
                )));
                for arg in args {
                    query = match arg {
                        Arg::Text(t) => query.bind(t.map(str::to_string)),
                        Arg::Int(i) => query.bind(i),
                    };
                }
                query.fetch_all(&db).await.unwrap().into_iter().map(|r| r.3).collect::<Vec<_>>()
            }
        };
        let member = || Viewer { org_id: Some("o"), user_id: "u", role: "viewer", sees_every_folder: 0, scrub: None };
        let admin = || Viewer { sees_every_folder: 1, ..member() };
        let events = |plan: &[String]| {
            plan.iter().filter(|l| l.starts_with("SCAN e") || l.starts_with("SEARCH e")).cloned().collect::<Vec<_>>()
        };
        for (viewer, filters, index) in [
            (admin(), json!({}), "audit_events_org_time_id"),
            (member(), json!({}), "audit_events_org_time_id"),
            (admin(), json!({ "action": "dashboard.", "from": 1, "to": 2 }), "audit_events_org_time_id"),
            (admin(), json!({ "resourceType": "dashboard", "resourceId": "d" }), "audit_events_org_resource"),
            (member(), json!({ "resourceType": "folder", "resourceId": "f" }), "audit_events_org_resource"),
        ] {
            let lines = plan(viewer, filters.clone(), None).await;
            let access = events(&lines);
            assert_eq!(access.len(), 1, "{filters}: {lines:?}");
            assert!(access[0].contains(index), "{filters} uses {index}: {lines:?}");
            assert!(!lines.iter().any(|l| l.contains("TEMP B-TREE FOR ORDER BY")), "{filters} sorts: {lines:?}");
        }
        // A later page seeks to its cursor.
        let cursor =
            Paging::new(Some(50), None).unwrap().page(vec![(5_i64, "x".to_string()); 51], |r| (r.0, r.1.as_str()));
        let next = cursor.next_cursor.clone().expect("a next page");
        let next: &'static str = Box::leak(next.into_boxed_str());
        let lines = plan(admin(), json!({}), Some(next)).await;
        let access = events(&lines);
        assert!(access[0].starts_with("SEARCH e USING") && access[0].contains("created_at"), "{lines:?}");
    }

    /// Built-in roles that read the audit log also see restricted folders, so this runs the
    /// query directly, as for a custom role with `audit:read` alone.
    #[tokio::test]
    async fn events_about_hidden_folders_and_their_dashboards_are_left_out() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let clock = std::sync::Arc::new(crate::clock::ManualClock::new(0));
        // A data directory of its own: never the system folder, and the server state keeps its
        // secrets key there.
        let dir = tempfile::tempdir().unwrap();
        let mut config = crate::config::Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        let state = AppState::new(config, db.clone(), clock, Some("fixed-code-0123456789".into())).await.unwrap();
        for sql in [
            "INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)",
            "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_at, updated_at) VALUES \
             ('secret', 'o', NULL, 'S', 1, 1, 0, 0), ('inner', 'o', 'secret', 'I', 0, 1, 0, 0), \
             ('open', 'o', NULL, 'O', 0, 1, 0, 0)",
            "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_at, updated_at) VALUES \
             ('hidden', 'o', 'inner', 'H', 'h', 1, 0, 0), ('shown', 'o', 'open', 'S', 's', 1, 0, 0)",
            "INSERT INTO audit_events (id, org_id, action, resource_type, resource_id, summary, created_at) VALUES \
             ('1', 'o', 'folder.created', 'folder', 'secret', '{}', 1), \
             ('2', 'o', 'folder.created', 'folder', 'inner', '{}', 2), \
             ('3', 'o', 'dashboard.saved', 'dashboard', 'hidden', '{}', 3), \
             ('4', 'o', 'dashboard.saved', 'dashboard', 'shown', '{}', 4), \
             ('5', 'o', 'folder.created', 'folder', 'open', '{}', 5), \
             ('6', 'o', 'settings.updated', NULL, NULL, '{}', 6)",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        let ids = |page: Page<AuditItem>| page.items.into_iter().map(|e| e.id).collect::<Vec<_>>();
        let query = || serde_json::from_value::<AuditQuery>(serde_json::json!({})).unwrap();
        let viewer = || Viewer { org_id: Some("o"), user_id: "u", role: "viewer", sees_every_folder: 0, scrub: None };
        let limited = list(&state, viewer(), query()).await.unwrap().0;
        assert_eq!(ids(limited), ["6", "5", "4"]);
        let admin = Viewer { sees_every_folder: 1, ..viewer() };
        assert_eq!(ids(list(&state, admin, query()).await.unwrap().0).len(), 6);

        // A grant on the inner folder shows it and its dashboard, not the restricted folder above.
        sqlx::query(
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, \
             created_at) VALUES ('g', 'o', 'role', 'viewer', 'folder', 'inner', 'view', 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        assert_eq!(ids(list(&state, viewer(), query()).await.unwrap().0), ["6", "5", "4", "3", "2"]);
        crate::app::finish_test_app(state, dir).await;
    }
}
