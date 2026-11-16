//! Plan, apply, list, unlock and export for one organization.
//!
//! `plan` reads a set's documents, checks each with the API's own rules and compares it with the
//! stored resource in the form an export writes (references as uids, secrets as references). The
//! result says per resource what an apply would do. `apply` writes that difference in one
//! transaction under the organization's lock, all or nothing, after checking that nothing the plan
//! read changed in the meantime; it records every resource with its set, file, checksum and state
//! hash and writes one audit entry per change plus one for the run. Afterwards it tests the
//! connection of every data source it made or changed; a failed test is a warning in the answer,
//! never a reason to undo the apply. Resources whose files are gone are deleted only with
//! `prune`; otherwise they stay, managed and read-only, and are reported as orphaned.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::ResourceKind;
use super::document::{self, Document, FileProblem, SecretRef, SourceFile};
use crate::app::AppState;
use crate::audit::{AuditEvent, record};
use crate::authz::{self, OrgCtx, Permission, Resource};
use crate::dashboards::model::{self, DashboardModel};
use crate::datasources::{self, Kind};
use crate::error::{ApiError, ApiResult};
use crate::folders::{FOLDER_COLUMNS, FolderRow, Tree};
use crate::net::RequestInfo;
use crate::routes::alerting::rules::{self as rules, Clean, RuleBody};
use crate::secrets::SecretPatch;

/// The longest message of a dashboard version.
const MAX_MESSAGE_CHARS: usize = 500;
/// A source's own bound on concurrent evaluations, as the opt-in route takes it.
const MAX_ALERTING_CONCURRENT: i64 = 100;
/// The most secret values one request may carry.
const MAX_SECRET_VALUES: usize = 200;

// ---- requests and answers ----

/// One file as a request carries it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestFile {
    /// Relative to the set's folder, with `/`.
    pub path: String,
    pub content: String,
}

/// `POST .../provisioning/plan` and `.../apply`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRequest {
    /// The provisioning set; `default` when left out.
    #[serde(default)]
    pub set: Option<String>,
    pub files: Vec<RequestFile>,
    /// Delete the set's resources whose files are gone.
    #[serde(default)]
    pub prune: bool,
    /// The values of the environment variables the data source files name, read where the files
    /// were read (`kalzit provision`). The server never reads its own environment for them.
    #[serde(default)]
    pub secret_values: BTreeMap<String, String>,
}

/// What an apply does to one resource.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Create,
    Update,
    /// Takes over a resource made outside provisioning (its id is the file's uid) without
    /// changing what it holds.
    Adopt,
    Delete,
    Unchanged,
    /// Managed by the set, but its file is gone; deleted only with `prune`.
    Orphaned,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Update => "update",
            Self::Adopt => "adopt",
            Self::Delete => "delete",
            Self::Unchanged => "unchanged",
            Self::Orphaned => "orphaned",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub kind: ResourceKind,
    pub uid: String,
    /// The resource's name or title.
    pub name: String,
    pub action: Action,
    /// `null` for a resource that does not exist yet.
    pub resource_id: Option<String>,
    /// The file, relative to the set's folder; for an orphan, the one it came from.
    pub path: String,
    /// The stored resource differs from what was applied last (edited after an unlock, changed
    /// some other way, or gone).
    pub drifted: bool,
    /// What an update changes, as paths into the file's `spec` (`settings.host`, `model.panels`).
    pub fields: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub create: u32,
    pub update: u32,
    pub adopt: u32,
    pub delete: u32,
    pub unchanged: u32,
    pub orphaned: u32,
    pub drifted: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub org_id: String,
    pub set: String,
    pub prune: bool,
    pub changes: Vec<Change>,
    pub counts: Counts,
}

/// Something that went wrong after the apply was committed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ApplyWarning {
    pub kind: ResourceKind,
    pub uid: String,
    /// `datasource.connection_failed` for a failed connection test.
    pub reason: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub plan: Plan,
    pub warnings: Vec<ApplyWarning>,
}

/// A managed resource as the API lists it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Provisioned {
    pub set: String,
    pub kind: ResourceKind,
    pub uid: String,
    pub resource_id: String,
    /// Empty when the resource is gone.
    pub name: String,
    pub path: String,
    pub checksum: String,
    pub applied_at: i64,
    /// The person or service account that applied it last.
    pub applied_by: Option<String>,
    /// Unlocked for edits until the set is applied again.
    pub unlocked_at: Option<i64>,
    pub unlocked_by: Option<String>,
    pub drifted: bool,
    /// The resource was deleted some other way; the next apply makes it again.
    pub missing: bool,
}

/// One file of an export.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub path: String,
    pub content: String,
}

/// A resource an export left out, and why.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportSkip {
    pub kind: ResourceKind,
    pub resource_id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Export {
    pub set: String,
    /// `org.yaml` first, then one file per resource.
    pub files: Vec<ExportFile>,
    pub skipped: Vec<ExportSkip>,
}

/// The set a request names, checked.
pub fn set_name(raw: Option<&str>) -> ApiResult<String> {
    let set = raw.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(document::DEFAULT_SET);
    document::check_set(set).map_err(|e| ApiError::validation(e).with_field("set"))?;
    Ok(set.to_string())
}

/// The documents of a request's files (`org.yaml` is the command line's and left out here).
pub fn documents(request: &SetRequest) -> ApiResult<Vec<Document>> {
    let files: Vec<SourceFile> = request
        .files
        .iter()
        .map(|f| SourceFile { path: f.path.clone(), bytes: f.content.as_bytes().to_vec() })
        .collect();
    let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let problems = document::check_paths(&paths);
    if !problems.is_empty() {
        return Err(problems_error(&problems));
    }
    let docs = document::parse_all(&files).map_err(|p| problems_error(&p))?;
    // Aliases are refused, so a spec is never much larger than its file; this bounds what one
    // request holds in memory all the same.
    let expanded: usize = docs.iter().map(|d| d.spec.to_string().len()).sum();
    if expanded > MAX_EXPANDED_BYTES {
        return Err(problems_error(&[FileProblem::new(
            ".",
            format!("the files hold more than {MAX_EXPANDED_BYTES} bytes once read"),
        )]));
    }
    Ok(docs)
}

/// What the files of one request may hold once read.
const MAX_EXPANDED_BYTES: usize = 64 * 1024 * 1024;

/// The secret values of a request, for the apply; bounded. Kalzit's own variables (`KALZIT_*`)
/// are refused, whatever a client sends.
pub fn secret_values(request: &mut SetRequest) -> ApiResult<BTreeMap<String, Zeroizing<String>>> {
    if request.secret_values.len() > MAX_SECRET_VALUES {
        return Err(
            ApiError::validation(format!("at most {MAX_SECRET_VALUES} secret values")).with_field("secretValues")
        );
    }
    if let Some(name) = request.secret_values.keys().find(|k| k.to_ascii_uppercase().starts_with("KALZIT_")) {
        return Err(ApiError::validation(format!(
            "secretValues: {name} is one of Kalzit's own variables; secrets come from other variables"
        ))
        .with_field("secretValues"));
    }
    let taken = std::mem::take(&mut request.secret_values);
    Ok(taken.into_iter().map(|(k, v)| (k, Zeroizing::new(v))).collect())
}

/// The error for files that do not pass their checks: `422 validation` with every problem in the
/// message, one per line, and the first one's file in the reason.
pub fn problems_error(problems: &[FileProblem]) -> ApiError {
    let text: Vec<String> = problems.iter().map(ToString::to_string).collect();
    let first = problems.first().cloned().unwrap_or_else(|| FileProblem::new(".", "invalid"));
    ApiError::validation(format!("{} problem(s) in the files:\n{}", problems.len(), text.join("\n")))
        .with_field("files")
        .because("provisioning.invalid_files")
        .param("count", problems.len())
        .param("path", &first.path)
        .param("detail", &first.message)
}

// ---- stored state ----

#[derive(Clone, Debug, sqlx::FromRow)]
struct RecordRow {
    set_name: String,
    kind: String,
    uid: String,
    resource_id: String,
    source_path: String,
    checksum: String,
    state_hash: String,
    secret_digest: String,
    secret_refs: String,
    applied_at: i64,
    applied_by: Option<String>,
    unlocked_at: Option<i64>,
    unlocked_by: Option<String>,
}

async fn records(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<Vec<(ResourceKind, RecordRow)>> {
    let rows: Vec<RecordRow> = sqlx::query_as(
        "SELECT set_name, kind, uid, resource_id, source_path, checksum, state_hash, secret_digest, secret_refs, \
         applied_at, applied_by, unlocked_at, unlocked_by FROM provisioned_resources WHERE org_id = $1 \
         ORDER BY set_name, kind, uid",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().filter_map(|r| ResourceKind::parse(&r.kind).map(|k| (k, r))).collect())
}

/// A hash over every record of the organization, so an apply sees that another one changed them
/// since its plan.
fn records_stamp(rows: &[(ResourceKind, RecordRow)]) -> String {
    let mut h = Sha256::new();
    for (_, r) in rows {
        for part in [&r.set_name, &r.kind, &r.uid, &r.resource_id, &r.state_hash, &r.secret_digest] {
            h.update(part.as_bytes());
            h.update([0]);
        }
        h.update(r.unlocked_at.unwrap_or(0).to_be_bytes());
    }
    hex::encode(h.finalize())
}

/// uids and ids of managed resources and of those an apply makes, both ways; contact points by
/// name. Ids without a uid are their own uid (an export writes them so).
#[derive(Default)]
struct Refs {
    uid_to_id: HashMap<(ResourceKind, String), String>,
    id_to_uid: HashMap<(ResourceKind, String), String>,
    contact_ids: HashMap<String, String>,
    contact_names: HashMap<String, String>,
}

impl Refs {
    fn add(&mut self, kind: ResourceKind, uid: &str, id: &str) {
        self.uid_to_id.insert((kind, uid.to_string()), id.to_string());
        self.id_to_uid.insert((kind, id.to_string()), uid.to_string());
    }

    fn uid_of(&self, kind: ResourceKind, id: &str) -> String {
        self.id_to_uid.get(&(kind, id.to_string())).cloned().unwrap_or_else(|| id.to_string())
    }

    /// The id a file's reference names: a uid, or the id of a stored resource in `ids`.
    fn id_of(&self, kind: ResourceKind, uid: &str, ids: &BTreeSet<String>) -> Option<String> {
        self.uid_to_id.get(&(kind, uid.to_string())).cloned().or_else(|| ids.contains(uid).then(|| uid.to_string()))
    }
}

fn hash(value: &Value) -> String {
    hex::encode(Sha256::digest(value.to_string().as_bytes()))
}

/// Paths into two specs where they differ: the top level, and one level below for objects.
fn differences(old: &Value, new: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let empty = Map::new();
    let (a, b) = (old.as_object().unwrap_or(&empty), new.as_object().unwrap_or(&empty));
    let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    for key in keys {
        let (x, y) = (a.get(key), b.get(key));
        if x == y {
            continue;
        }
        match (x.and_then(Value::as_object), y.and_then(Value::as_object)) {
            (Some(xo), Some(yo)) => {
                let inner: BTreeSet<&String> = xo.keys().chain(yo.keys()).collect();
                out.extend(inner.into_iter().filter(|k| xo.get(*k) != yo.get(*k)).map(|k| format!("{key}.{k}")));
            }
            _ => out.push(key.clone()),
        }
    }
    out
}

/// A resource as stored, in the form an export writes it.
struct Current {
    id: String,
    name: String,
    spec: Value,
    hash: String,
    detail: Detail,
}

enum Detail {
    Datasource { kind: String, settings: Value, secret_fields: BTreeSet<String>, updated_at: i64 },
    Role { permissions: BTreeSet<Permission> },
    Dashboard { folder_id: Option<String>, model: Option<Box<DashboardModel>>, links: bool },
    AlertRule { datasource_id: String, routing: String, dashboard_id: Option<String> },
}

fn ds_spec(name: &str, kind: &str, settings: &Value, alerting: bool, max: Option<i64>) -> Value {
    let mut spec = json!({ "name": name, "type": kind, "settings": settings });
    if alerting || max.is_some() {
        let mut a = json!({ "enabled": alerting });
        if let Some(max) = max {
            a["maxConcurrent"] = json!(max);
        }
        spec["alerting"] = a;
    }
    spec
}

fn ds_hash(spec: &Value, secret_fields: &BTreeSet<String>) -> String {
    hash(&json!({ "spec": spec, "secrets": secret_fields }))
}

fn role_spec(name: &str, description: &str, permissions: &BTreeSet<Permission>) -> Value {
    let mut spec = json!({ "name": name, "permissions": permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>() });
    if !description.is_empty() {
        spec["description"] = json!(description);
    }
    spec
}

fn dash_spec(folder: &[String], model: &Value) -> Value {
    let mut spec = json!({ "model": model });
    if !folder.is_empty() {
        spec["folder"] = if folder.iter().any(|p| p.contains('/')) { json!(folder) } else { json!(folder.join("/")) };
    }
    spec
}

/// Applies `f` to every data source reference of a model: panel queries, query variables and
/// annotation queries.
fn map_sources(model: &mut DashboardModel, mut f: impl FnMut(&str) -> Result<String, String>) -> Result<(), String> {
    for panel in &mut model.panels {
        for target in &mut panel.targets {
            target.datasource_id = f(&target.datasource_id)?;
        }
    }
    for variable in &mut model.variables {
        if let Some(id) = &variable.datasource_id {
            variable.datasource_id = Some(f(id)?);
        }
    }
    for annotation in &mut model.annotations {
        annotation.datasource_id = f(&annotation.datasource_id)?;
    }
    Ok(())
}

fn model_with_uids(model: &DashboardModel, refs: &Refs) -> Value {
    let mut out = model.clone();
    let _ = map_sources(&mut out, |id| Ok(refs.uid_of(ResourceKind::Datasource, id)));
    serde_json::to_value(&out).unwrap_or(Value::Null)
}

/// What a rule stores, as the checks leave it and as its row holds it.
struct RuleFields<'a> {
    name: &'a str,
    description: &'a str,
    runbook_url: Option<&'a str>,
    datasource_id: &'a str,
    query: &'a str,
    range_secs: i64,
    reduce: &'a str,
    condition: &'a str,
    interval_secs: i64,
    for_secs: i64,
    no_data_state: &'a str,
    error_state: &'a str,
    labels: &'a str,
    reminder_secs: i64,
    routing: &'a str,
    contact_point_ids: &'a [String],
    dashboard_id: Option<&'a str>,
    panel_id: Option<&'a str>,
}

impl<'a> RuleFields<'a> {
    fn of_clean(c: &'a Clean) -> Self {
        Self {
            name: &c.name,
            description: &c.description,
            runbook_url: c.runbook_url.as_deref(),
            datasource_id: &c.datasource_id,
            query: &c.query,
            range_secs: c.range_secs,
            reduce: &c.reduce,
            condition: &c.condition,
            interval_secs: c.interval_secs,
            for_secs: c.for_secs,
            no_data_state: &c.no_data_state,
            error_state: &c.error_state,
            labels: &c.labels,
            reminder_secs: c.reminder_secs,
            routing: &c.routing,
            contact_point_ids: &c.contact_point_ids,
            dashboard_id: c.dashboard_id.as_deref(),
            panel_id: c.panel_id.as_deref(),
        }
    }

    fn of_row(r: &'a RuleRow, contact_point_ids: &'a [String]) -> Self {
        Self {
            name: &r.name,
            description: &r.description,
            runbook_url: r.runbook_url.as_deref(),
            datasource_id: &r.datasource_id,
            query: &r.query,
            range_secs: r.range_secs,
            reduce: &r.reduce,
            condition: &r.condition,
            interval_secs: r.interval_secs,
            for_secs: r.for_secs,
            no_data_state: &r.no_data_state,
            error_state: &r.error_state,
            labels: &r.labels,
            reminder_secs: r.reminder_secs,
            routing: &r.routing,
            contact_point_ids,
            dashboard_id: r.dashboard_id.as_deref(),
            panel_id: r.panel_id.as_deref(),
        }
    }

    fn spec(&self, refs: &Refs) -> Value {
        let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
        let mut spec = json!({
            "name": self.name,
            "datasourceId": refs.uid_of(ResourceKind::Datasource, self.datasource_id),
            "query": parse(self.query),
            "rangeSecs": self.range_secs,
            "reduce": parse(self.reduce),
            "condition": parse(self.condition),
            "intervalSecs": self.interval_secs,
            "forSecs": self.for_secs,
            "noDataState": self.no_data_state,
            "errorState": self.error_state,
            "reminderSecs": self.reminder_secs,
            "routing": self.routing,
        });
        if !self.description.is_empty() {
            spec["description"] = json!(self.description);
        }
        if let Some(url) = self.runbook_url {
            spec["runbookUrl"] = json!(url);
        }
        let labels = parse(self.labels);
        if labels.as_object().is_some_and(|m| !m.is_empty()) {
            spec["labels"] = labels;
        }
        if !self.contact_point_ids.is_empty() {
            let mut names: Vec<String> = self
                .contact_point_ids
                .iter()
                .map(|id| refs.contact_names.get(id).cloned().unwrap_or_else(|| id.clone()))
                .collect();
            names.sort();
            spec["contactPoints"] = json!(names);
        }
        if let Some(dashboard) = self.dashboard_id {
            spec["dashboard"] = json!(refs.uid_of(ResourceKind::Dashboard, dashboard));
        }
        if let Some(panel) = self.panel_id {
            spec["panelId"] = json!(panel);
        }
        spec
    }
}

// ---- loading what is stored ----

fn id_clause(id: Option<&str>, column: &str) -> String {
    if id.is_some() { format!(" AND {column} = $2") } else { String::new() }
}

async fn load_datasources(conn: &mut sqlx::AnyConnection, org_id: &str, id: Option<&str>) -> ApiResult<Vec<Current>> {
    type Row = (String, String, String, String, i64, i64, Option<i64>);
    let sql = format!(
        "SELECT id, name, kind, settings, updated_at, alerting_enabled, alerting_max_concurrent FROM datasources \
         WHERE org_id = $1 AND deleted_at IS NULL{} ORDER BY id",
        id_clause(id, "id")
    );
    let mut query = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(sql)).bind(org_id);
    if let Some(id) = id {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&mut *conn).await?;
    let mut out = Vec::new();
    for (id, name, kind, settings, updated_at, alerting, max) in rows {
        let settings: Value =
            serde_json::from_str(&settings).map_err(|e| ApiError::internal("provisioning: data source settings", e))?;
        let secret_fields: BTreeSet<String> = crate::secrets::set_fields(&mut *conn, &id).await?.into_iter().collect();
        let spec = ds_spec(&name, &kind, &settings, alerting != 0, max);
        let hash = ds_hash(&spec, &secret_fields);
        out.push(Current {
            hash,
            spec,
            name,
            detail: Detail::Datasource { kind, settings, secret_fields, updated_at },
            id,
        });
    }
    Ok(out)
}

async fn load_roles(conn: &mut sqlx::AnyConnection, org_id: &str, id: Option<&str>) -> ApiResult<Vec<Current>> {
    let sql = format!("SELECT id, name, description FROM roles WHERE org_id = $1{} ORDER BY id", id_clause(id, "id"));
    let mut query = sqlx::query_as::<_, (String, String, String)>(sqlx::AssertSqlSafe(sql)).bind(org_id);
    if let Some(id) = id {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&mut *conn).await?;
    let mut out = Vec::new();
    for (id, name, description) in rows {
        let names: Vec<(String,)> = sqlx::query_as("SELECT permission FROM role_permissions WHERE role_id = $1")
            .bind(&id)
            .fetch_all(&mut *conn)
            .await?;
        // Names this server no longer knows grant nothing, and are left out.
        let permissions: BTreeSet<Permission> = names.iter().filter_map(|(p,)| Permission::parse(p)).collect();
        let spec = role_spec(&name, &description, &permissions);
        out.push(Current { hash: hash(&spec), spec, name, detail: Detail::Role { permissions }, id });
    }
    Ok(out)
}

async fn folder_tree(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<Tree> {
    let rows: Vec<FolderRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE org_id = $1")))
            .bind(org_id)
            .fetch_all(&mut *conn)
            .await?;
    Ok(Tree::from_rows(rows, Default::default()))
}

/// The folder's path of names from the top level.
fn folder_path(tree: &Tree, folder: Option<&str>) -> Vec<String> {
    let Some(folder) = folder else { return Vec::new() };
    let mut names: Vec<String> = tree.ancestors(folder).into_iter().map(|r| r.name.clone()).collect();
    names.reverse();
    names
}

async fn load_dashboards(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    id: Option<&str>,
    refs: &Refs,
    tree: &Tree,
) -> ApiResult<Vec<Current>> {
    let sql = format!(
        "SELECT d.id, d.folder_id, d.title, v.model FROM dashboards d \
         LEFT JOIN dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.version \
         WHERE d.org_id = $1 AND d.deleted_at IS NULL{} ORDER BY d.id",
        id_clause(id, "d.id")
    );
    type Row = (String, Option<String>, String, Option<String>);
    let mut query = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(sql)).bind(org_id);
    if let Some(id) = id {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&mut *conn).await?;
    let mut out = Vec::new();
    for (id, folder_id, title, raw) in rows {
        // A model this server cannot read compares as unreadable: any file replaces it.
        let model =
            raw.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok()).and_then(|v| model::parse(v).ok());
        let links = model.as_ref().is_some_and(|m| !m.library_panel_ids().is_empty() || !m.analysis_ids().is_empty());
        let model_value = model.as_ref().map_or(Value::Null, |m| model_with_uids(m, refs));
        let spec = dash_spec(&folder_path(tree, folder_id.as_deref()), &model_value);
        out.push(Current {
            hash: hash(&spec),
            spec,
            name: title,
            detail: Detail::Dashboard { folder_id, model: model.map(Box::new), links },
            id,
        });
    }
    Ok(out)
}

#[derive(sqlx::FromRow)]
struct RuleRow {
    id: String,
    name: String,
    description: String,
    runbook_url: Option<String>,
    datasource_id: String,
    query: String,
    range_secs: i64,
    reduce: String,
    condition: String,
    interval_secs: i64,
    for_secs: i64,
    no_data_state: String,
    error_state: String,
    labels: String,
    reminder_secs: i64,
    dashboard_id: Option<String>,
    panel_id: Option<String>,
    routing: String,
}

async fn load_rules(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    id: Option<&str>,
    refs: &Refs,
) -> ApiResult<Vec<Current>> {
    let sql = format!(
        "SELECT id, name, description, runbook_url, datasource_id, query, range_secs, reduce, condition, \
         interval_secs, for_secs, no_data_state, error_state, labels, reminder_secs, dashboard_id, panel_id, routing \
         FROM alert_rules WHERE org_id = $1{} ORDER BY id",
        id_clause(id, "id")
    );
    let mut query = sqlx::query_as::<_, RuleRow>(sqlx::AssertSqlSafe(sql)).bind(org_id);
    if let Some(id) = id {
        query = query.bind(id);
    }
    let rows = query.fetch_all(&mut *conn).await?;
    let mut out = Vec::new();
    for r in rows {
        let links: Vec<(String,)> = sqlx::query_as(
            "SELECT contact_point_id FROM alert_rule_contact_points WHERE rule_id = $1 ORDER BY contact_point_id",
        )
        .bind(&r.id)
        .fetch_all(&mut *conn)
        .await?;
        let contact_point_ids: Vec<String> = links.into_iter().map(|(id,)| id).collect();
        let spec = RuleFields::of_row(&r, &contact_point_ids).spec(refs);
        out.push(Current {
            hash: hash(&spec),
            spec,
            name: r.name.clone(),
            detail: Detail::AlertRule {
                datasource_id: r.datasource_id.clone(),
                routing: r.routing.clone(),
                dashboard_id: r.dashboard_id.clone(),
            },
            id: r.id,
        });
    }
    Ok(out)
}

async fn load(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    kind: ResourceKind,
    id: Option<&str>,
    refs: &Refs,
    tree: &Tree,
) -> ApiResult<Vec<Current>> {
    match kind {
        ResourceKind::Datasource => load_datasources(conn, org_id, id).await,
        ResourceKind::Role => load_roles(conn, org_id, id).await,
        ResourceKind::Dashboard => load_dashboards(conn, org_id, id, refs, tree).await,
        ResourceKind::AlertRule => load_rules(conn, org_id, id, refs).await,
    }
}

async fn contact_points(conn: &mut sqlx::AnyConnection, org_id: &str, refs: &mut Refs) -> ApiResult<()> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM alert_contact_points WHERE org_id = $1")
        .bind(org_id)
        .fetch_all(&mut *conn)
        .await?;
    for (id, name) in rows {
        refs.contact_ids.insert(name.clone(), id.clone());
        refs.contact_names.insert(id, name);
    }
    Ok(())
}

/// The ids of every resource of a kind in the organization, with whether it is in the trash.
async fn all_ids(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    kind: ResourceKind,
) -> ApiResult<BTreeMap<String, bool>> {
    let sql = match kind {
        ResourceKind::Datasource => "SELECT id, deleted_at FROM datasources WHERE org_id = $1",
        ResourceKind::Dashboard => "SELECT id, deleted_at FROM dashboards WHERE org_id = $1",
        ResourceKind::Role => "SELECT id, NULL FROM roles WHERE org_id = $1",
        ResourceKind::AlertRule => "SELECT id, NULL FROM alert_rules WHERE org_id = $1",
    };
    let rows: Vec<(String, Option<i64>)> = sqlx::query_as(sql).bind(org_id).fetch_all(&mut *conn).await?;
    Ok(rows.into_iter().map(|(id, deleted)| (id, deleted.is_some())).collect())
}

/// The refs of the stored records alone, with the contact points (lists and exports).
async fn stored_refs(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
) -> ApiResult<(Refs, Vec<(ResourceKind, RecordRow)>)> {
    let mut refs = Refs::default();
    let rows = records(conn, org_id).await?;
    for (kind, r) in &rows {
        refs.add(*kind, &r.uid, &r.resource_id);
    }
    contact_points(conn, org_id, &mut refs).await?;
    Ok((refs, rows))
}

// ---- what the files ask for ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DatasourceSpec {
    name: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default = "empty_object")]
    settings: Value,
    #[serde(default)]
    secrets: BTreeMap<String, SecretRef>,
    #[serde(default)]
    alerting: Option<AlertingSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlertingSpec {
    enabled: bool,
    #[serde(default)]
    max_concurrent: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RoleSpec {
    name: String,
    #[serde(default)]
    description: String,
    permissions: Vec<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum FolderSpec {
    Path(String),
    Parts(Vec<String>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DashboardSpec {
    #[serde(default)]
    folder: Option<FolderSpec>,
    model: Value,
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// Where a dashboard goes: the top level, a stored folder, or folders made on the way.
#[derive(Clone, Debug)]
enum Place {
    Top,
    Folder(String),
    /// Below `parent` (`None`: the top level), the folders named in `make`, one inside the other.
    Make {
        parent: Option<String>,
        make: Vec<String>,
        /// Live folders of the first name in that place when planned, the hidden ones included;
        /// another one by the apply means the place changed.
        same_named: usize,
    },
}

/// Live folders named `name` directly below `parent`, hidden ones included.
fn same_named(tree: &Tree, parent: Option<&String>, name: &str) -> usize {
    tree.rows.values().filter(|r| r.deleted_at.is_none() && r.parent_id.as_ref() == parent && r.name == name).count()
}

enum Desired {
    Datasource {
        kind: Arc<Kind>,
        name: String,
        settings: Value,
        patch: SecretPatch,
        alerting: bool,
        max_concurrent: Option<i64>,
        settings_changed: bool,
        stored_updated_at: Option<i64>,
    },
    Role {
        name: String,
        description: String,
        permissions: BTreeSet<Permission>,
    },
    Dashboard {
        model: Box<DashboardModel>,
        place: Place,
        moved: bool,
        from_folder: Option<String>,
    },
    AlertRule {
        clean: Box<Clean>,
        stored_routing: Option<String>,
    },
    /// An orphan, to delete with `prune` or to leave.
    Gone,
}

struct Normalized {
    name: String,
    spec: Value,
    hash: String,
    secret_digest: String,
    secret_refs: String,
    desired: Desired,
}

struct Step {
    kind: ResourceKind,
    uid: String,
    name: String,
    action: Action,
    id: String,
    path: String,
    checksum: String,
    /// The stored state's hash the plan saw, checked again under the lock; `None` for a new one.
    expect: Option<String>,
    /// The hash of the state after the apply.
    state_hash: String,
    secret_digest: String,
    secret_refs: String,
    /// The record already says the same about the file, and the resource is locked.
    record_current: bool,
    drifted: bool,
    fields: Vec<String>,
    desired: Desired,
}

/// A plan with what the apply needs.
pub struct Prepared {
    pub plan: Plan,
    steps: Vec<Step>,
    stamp: String,
}

fn problem_text(e: &ApiError) -> String {
    match e.field {
        Some(field) => format!("{field}: {}", e.message),
        None => e.message.clone(),
    }
}

fn field_text(e: datasources::FieldError) -> String {
    format!("{}: {}", e.field, e.detail.message)
}

struct Planner<'a> {
    state: &'a AppState,
    org_id: &'a str,
    ctx: &'a OrgCtx,
    secrets: &'a BTreeMap<String, Zeroizing<String>>,
    refs: Refs,
    tree: Tree,
    ids: HashMap<ResourceKind, BTreeMap<String, bool>>,
    /// Data sources the plan makes.
    new_sources: BTreeSet<String>,
    /// The data sources the plan leaves opted in to alerting, by id.
    alerting_sources: BTreeSet<String>,
}

impl Planner<'_> {
    fn live_ids(&self, kind: ResourceKind) -> BTreeSet<String> {
        self.ids
            .get(&kind)
            .map(|m| m.iter().filter(|(_, d)| !**d).map(|(id, _)| id.clone()).collect())
            .unwrap_or_default()
    }

    fn known_ids(&self, kind: ResourceKind) -> BTreeSet<String> {
        self.ids.get(&kind).map(|m| m.keys().cloned().collect()).unwrap_or_default()
    }

    async fn datasource(
        &self,
        doc: &Document,
        cur: Option<&Current>,
        record: Option<&RecordRow>,
    ) -> Result<Normalized, String> {
        let spec: DatasourceSpec = serde_json::from_value(doc.spec.clone()).map_err(|e| format!("spec: {e}"))?;
        let name = crate::routes::clean_name(&spec.name, "name").map_err(|e| problem_text(&e.with_field("name")))?;
        let kind = self
            .state
            .datasources
            .kind_in_org(self.org_id, &spec.kind)
            .ok_or_else(|| format!("type: {} is not a data source kind on this server", spec.kind))?;
        let (stored_settings, stored_fields, stored_updated_at) = match cur.map(|c| &c.detail) {
            Some(Detail::Datasource { kind: stored, settings, secret_fields, updated_at }) => {
                if stored != kind.kind() {
                    return Err(format!("type: a data source of type {stored} cannot become {}", kind.kind()));
                }
                (Some(settings), secret_fields.clone(), Some(*updated_at))
            }
            _ => (None, BTreeSet::new(), None),
        };
        let settings =
            kind.fill_tls_default(kind.validate_settings(&spec.settings).map_err(field_text)?, stored_settings);
        let policy = self.state.datasources.policy(self.state).await.map_err(|e| problem_text(&e))?;
        datasources::precheck_targets(&policy, &kind, &settings)
            .map_err(|(b, field)| format!("settings.{field}: {}", b.0.message))?;

        // Secrets: values of named variables, what the store keeps, and removals of the rest.
        let effective = |s: &Value| datasources::with_effective_tls(kind.kind(), s.clone());
        let target_changed =
            stored_settings.is_some_and(|old| !kind.changed_targets(&effective(old), &effective(&settings)).is_empty());
        let mut patch = SecretPatch::new();
        let mut names = SecretPatch::new();
        let mut digest_input = String::new();
        let mut refs = Map::new();
        for (field, r) in &spec.secrets {
            names.insert(field.clone(), None);
            refs.insert(field.clone(), serde_json::to_value(r).unwrap_or(Value::Null));
            let source = r.check().map_err(|e| format!("secrets.{field}: {e}"))?;
            match source.key() {
                Some(key) => {
                    let value = self.secrets.get(&key).ok_or_else(|| match &source {
                        document::SecretSource::File(path) => {
                            format!("secrets.{field}: the file {path} was not sent (kalzit provision reads it)")
                        }
                        _ => format!("secrets.{field}: the environment variable {key} is not set"),
                    })?;
                    digest_input.push_str(&format!("{field}\0{key}\0{}\0", value.as_str()));
                    patch.insert(field.clone(), Some(value.clone()));
                }
                None => {
                    if !stored_fields.contains(field) {
                        return Err(format!(
                            "secrets.{field}: Kalzit's store holds no value for it; set it in the interface or name an \
                             environment variable"
                        ));
                    }
                    if target_changed {
                        return Err(format!(
                            "secrets.{field}: the settings change where the data source connects, so the stored value \
                             is not sent there; name an environment variable for it or remove it"
                        ));
                    }
                    digest_input.push_str(&format!("{field}\0store\0"));
                }
            }
        }
        kind.validate_secrets(&names).map_err(field_text)?;
        kind.validate_secrets(&patch).map_err(field_text)?;
        let secret_digest =
            hex::encode(self.state.secrets.sign(format!("kalzit-provisioning\0{digest_input}").as_bytes()));
        // Values already stored for this exact reference need not be written again.
        let unchanged_values =
            cur.is_some() && !target_changed && record.is_some_and(|r| r.secret_digest == secret_digest);
        if unchanged_values {
            patch.retain(|field, _| !stored_fields.contains(field));
        }
        for field in &stored_fields {
            if !spec.secrets.contains_key(field) {
                patch.insert(field.clone(), None);
            }
        }
        // The kind's own checks that may reach out (a plugin process, the target) run after the
        // caller's rights are checked (`outbound_checks`).
        let (alerting, max_concurrent) = match &spec.alerting {
            Some(a) => {
                if a.max_concurrent.is_some_and(|n| !(1..=MAX_ALERTING_CONCURRENT).contains(&n)) {
                    return Err(format!("alerting.maxConcurrent: 1 to {MAX_ALERTING_CONCURRENT}, or left out"));
                }
                (a.enabled, a.max_concurrent)
            }
            None => (false, None),
        };
        let canonical = ds_spec(&name, kind.kind(), &settings, alerting, max_concurrent);
        let fields: BTreeSet<String> = spec.secrets.keys().cloned().collect();
        let hash = ds_hash(&canonical, &fields);
        let settings_changed = stored_settings != Some(&settings);
        Ok(Normalized {
            name: name.clone(),
            spec: canonical,
            hash,
            secret_digest,
            secret_refs: Value::Object(refs).to_string(),
            desired: Desired::Datasource {
                kind,
                name,
                settings,
                patch,
                alerting,
                max_concurrent,
                settings_changed,
                stored_updated_at,
            },
        })
    }

    fn role(&self, doc: &Document) -> Result<Normalized, String> {
        use crate::routes::roles::{MAX_DESCRIPTION_CHARS, clean_role_name, parse_permissions};
        let spec: RoleSpec = serde_json::from_value(doc.spec.clone()).map_err(|e| format!("spec: {e}"))?;
        let name = clean_role_name(&spec.name).map_err(|e| problem_text(&e))?;
        let description = crate::routes::support::clean_text(&spec.description, "description", MAX_DESCRIPTION_CHARS)
            .map_err(|e| problem_text(&e.with_field("description")))?;
        let permissions = parse_permissions(&spec.permissions).map_err(|e| problem_text(&e))?;
        let canonical = role_spec(&name, &description, &permissions);
        Ok(Normalized {
            hash: hash(&canonical),
            spec: canonical,
            secret_digest: String::new(),
            secret_refs: "{}".into(),
            desired: Desired::Role { name: name.clone(), description, permissions },
            name,
        })
    }

    /// The place of a folder path: the stored folders it names, and those to make. Only folders
    /// the caller sees count, so a plan reveals nothing of the others.
    fn place(&self, parts: &[String]) -> Result<Place, String> {
        let mut parent: Option<String> = None;
        for (i, part) in parts.iter().enumerate() {
            let children: Vec<&FolderRow> = self
                .tree
                .rows
                .values()
                .filter(|r| {
                    r.deleted_at.is_none() && r.parent_id == parent && &r.name == part && self.tree.visible(&r.id)
                })
                .collect();
            match children.as_slice() {
                [] => {
                    let same = same_named(&self.tree, parent.as_ref(), part);
                    return Ok(Place::Make { parent, make: parts[i..].to_vec(), same_named: same });
                }
                [one] => {
                    if self.tree.space_of(&one.id).is_some() {
                        return Err(format!("folder: {part} is a team space; managed dashboards live outside them"));
                    }
                    parent = Some(one.id.clone());
                }
                _ => return Err(format!("folder: there are several folders named {part} in that place")),
            }
        }
        Ok(parent.map_or(Place::Top, Place::Folder))
    }

    fn dashboard(&self, doc: &Document, cur: Option<&Current>, default_range: &Value) -> Result<Normalized, String> {
        let spec: DashboardSpec = serde_json::from_value(doc.spec.clone()).map_err(|e| format!("spec: {e}"))?;
        let parts: Vec<String> = match spec.folder {
            None => Vec::new(),
            Some(FolderSpec::Path(p)) => {
                p.split('/').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
            }
            Some(FolderSpec::Parts(p)) => p.into_iter().map(|s| s.trim().to_string()).collect(),
        };
        for part in &parts {
            crate::routes::clean_name(part, "folder").map_err(|e| problem_text(&e.with_field("folder")))?;
        }
        let mut raw = spec.model;
        let Some(fields) = raw.as_object_mut() else { return Err("model: must be an object".into()) };
        fields.entry("schemaVersion").or_insert(json!(model::SCHEMA_VERSION));
        fields.entry("timeRange").or_insert(default_range.clone());
        let parsed = model::parse(raw)?;
        if !parsed.library_panel_ids().is_empty() || !parsed.analysis_ids().is_empty() {
            return Err(
                "model: managed dashboards cannot link library panels or saved analyses; put the panel in".into()
            );
        }
        let sources = self.known_ids(ResourceKind::Datasource);
        let mut with_ids = parsed;
        map_sources(&mut with_ids, |uid| {
            self.refs.id_of(ResourceKind::Datasource, uid, &sources).ok_or_else(|| {
                format!("model: the data source {uid} is neither in these files nor stored in this organization")
            })
        })?;
        let (previous, from_folder) = match cur.map(|c| &c.detail) {
            Some(Detail::Dashboard { model, folder_id, .. }) => (model.as_deref(), folder_id.clone()),
            _ => (None, None),
        };
        model::check_panel_options(&with_ids, previous)
            .map_err(|(panel, detail)| format!("model: panel {panel}: {detail}"))?;
        crate::plugins::panels::check_dashboard_options(self.state.plugins.panels(), &with_ids, previous)
            .map_err(|r| format!("model: panel {}: {}", r.panel, r.detail))?;
        let place = self.place(&parts)?;
        let moved = cur.is_some() && folder_path(&self.tree, from_folder.as_deref()) != parts;
        let canonical = dash_spec(&parts, &model_with_uids(&with_ids, &self.refs));
        Ok(Normalized {
            name: with_ids.title.clone(),
            hash: hash(&canonical),
            spec: canonical,
            secret_digest: String::new(),
            secret_refs: "{}".into(),
            desired: Desired::Dashboard { model: Box::new(with_ids), place, moved, from_folder },
        })
    }

    fn rule(
        &self,
        doc: &Document,
        cur: Option<&Current>,
        limits: &crate::alerting::limits::Limits,
    ) -> Result<Normalized, String> {
        let mut map = doc.spec.as_object().cloned().unwrap_or_default();
        for (key, instead) in
            [("version", "nothing"), ("contactPointIds", "contactPoints"), ("dashboardId", "dashboard")]
        {
            if map.contains_key(key) {
                return Err(format!("{key}: not part of a file; use {instead}"));
            }
        }
        let source = map.get("datasourceId").and_then(Value::as_str).ok_or("datasourceId: the data source's uid")?;
        let source = self
            .refs
            .id_of(ResourceKind::Datasource, source, &self.live_ids(ResourceKind::Datasource))
            .ok_or_else(|| format!("datasourceId: the data source {source} is neither in these files nor stored"))?;
        map.insert("datasourceId".into(), json!(source));
        if let Some(names) = map.remove("contactPoints") {
            let names: Vec<String> = serde_json::from_value(names)
                .map_err(|_| "contactPoints: a list of contact point names".to_string())?;
            let mut ids = Vec::new();
            for name in names {
                let id =
                    self.refs.contact_ids.get(&name).ok_or_else(|| {
                        format!("contactPoints: there is no contact point {name} in this organization")
                    })?;
                ids.push(id.clone());
            }
            map.insert("contactPointIds".into(), json!(ids));
        }
        if let Some(dashboard) = map.remove("dashboard") {
            let uid = dashboard.as_str().ok_or("dashboard: the dashboard's uid")?;
            let id = self
                .refs
                .id_of(ResourceKind::Dashboard, uid, &self.live_ids(ResourceKind::Dashboard))
                .ok_or_else(|| format!("dashboard: the dashboard {uid} is neither in these files nor stored"))?;
            map.insert("dashboardId".into(), json!(id));
        }
        let body: RuleBody = serde_json::from_value(Value::Object(map)).map_err(|e| format!("spec: {e}"))?;
        let clean = rules::check_body(body, limits.min_interval_secs, limits.max_contact_points_per_rule)
            .map_err(|e| problem_text(&e))?;
        if !self.alerting_sources.contains(&clean.datasource_id) {
            return Err(format!(
                "datasourceId: the data source {} is not opted in to alerting; set alerting.enabled in its file",
                self.refs.uid_of(ResourceKind::Datasource, &clean.datasource_id)
            ));
        }
        let canonical = RuleFields::of_clean(&clean).spec(&self.refs);
        let stored_routing = match cur.map(|c| &c.detail) {
            Some(Detail::AlertRule { routing, .. }) => Some(routing.clone()),
            _ => None,
        };
        Ok(Normalized {
            name: clean.name.clone(),
            hash: hash(&canonical),
            spec: canonical,
            secret_digest: String::new(),
            secret_refs: "{}".into(),
            desired: Desired::AlertRule { clean: Box::new(clean), stored_routing },
        })
    }

    /// Checks across files: unique names, the organization's limits.
    async fn cross_checks(&self, steps: &[Step], problems: &mut Vec<FileProblem>) -> ApiResult<()> {
        let mut conn = self.state.db.acquire().await?;
        let deleted: BTreeSet<(ResourceKind, String)> =
            steps.iter().filter(|s| s.action == Action::Delete).map(|s| (s.kind, s.id.clone())).collect();
        let ours: BTreeSet<(ResourceKind, String)> = steps.iter().map(|s| (s.kind, s.id.clone())).collect();

        let sources: Vec<(String, String)> =
            sqlx::query_as("SELECT id, name FROM datasources WHERE org_id = $1 AND deleted_at IS NULL")
                .bind(self.org_id)
                .fetch_all(&mut *conn)
                .await?;
        let roles: Vec<(String, String)> = sqlx::query_as("SELECT id, name_key FROM roles WHERE org_id = $1")
            .bind(self.org_id)
            .fetch_all(&mut *conn)
            .await?;
        let mut names: HashMap<(ResourceKind, String), String> = HashMap::new();
        for (kind, rows) in [(ResourceKind::Datasource, &sources), (ResourceKind::Role, &roles)] {
            for (id, name) in rows {
                if !ours.contains(&(kind, id.clone())) {
                    names.insert((kind, name.clone()), format!("the stored {} {id}", kind.as_str()));
                }
            }
        }
        for s in steps.iter().filter(|s| s.action != Action::Delete && s.action != Action::Orphaned) {
            let name = match &s.desired {
                Desired::Datasource { name, .. } | Desired::Role { name, .. } => name.clone(),
                _ => continue,
            };
            // Data source names are compared as stored (exactly), role names without case.
            let key_name = if s.kind == ResourceKind::Role { name.to_lowercase() } else { name };
            let key = (s.kind, key_name);
            if let Some(other) = names.get(&key) {
                let hint = if other.starts_with("the stored") {
                    format!("; to take it over, use its id as uid ({})", other.rsplit(' ').next().unwrap_or(""))
                } else {
                    String::new()
                };
                problems.push(FileProblem::new(&s.path, format!("name: {other} has this name already{hint}")));
            } else {
                names.insert(key, s.path.clone());
            }
        }
        let stored_roles = roles.iter().filter(|(id, _)| !deleted.contains(&(ResourceKind::Role, id.clone()))).count();
        let new_roles = steps.iter().filter(|s| s.kind == ResourceKind::Role && s.action == Action::Create).count();
        if (stored_roles + new_roles) as i64 > crate::routes::roles::MAX_CUSTOM_ROLES {
            problems.push(FileProblem::new(
                ".",
                format!("an organization can have at most {} custom roles", crate::routes::roles::MAX_CUSTOM_ROLES),
            ));
        }
        let limits = crate::alerting::limits::for_org(self.state, self.org_id).await?;
        let live_rules = self.live_ids(ResourceKind::AlertRule);
        let created = steps.iter().filter(|s| s.kind == ResourceKind::AlertRule && s.action == Action::Create).count();
        // Only deletes of rules that still exist count (a record may point at a rule gone).
        let deleted_rules = steps
            .iter()
            .filter(|s| s.kind == ResourceKind::AlertRule && s.action == Action::Delete && live_rules.contains(&s.id))
            .count();
        let rules_after = (live_rules.len() + created).saturating_sub(deleted_rules);
        if rules_after as u64 > limits.max_rules_per_org {
            problems.push(FileProblem::new(
                ".",
                format!("this organization may have {} alert rules", limits.max_rules_per_org),
            ));
        }
        Ok(())
    }

    /// The caller's rights for every change, as the API asks for them.
    async fn authorize(&self, steps: &[Step], current: &HashMap<(ResourceKind, String), Current>) -> ApiResult<()> {
        let ctx = self.ctx;
        let access = authz::DatasourceAccess::load(&self.state.db, ctx).await?;
        let may_query = |id: &str| {
            access.allows(Permission::DatasourcesQuery, id)
                || (self.new_sources.contains(id) && ctx.permissions.contains(&Permission::DatasourcesQuery))
        };
        let named = |s: &Step, e: ApiError| {
            let message = format!("{} {}: {}", s.kind.as_str(), s.uid, e.message);
            if e.code == "not_found" { ApiError::forbidden(message) } else { ApiError { message, ..e } }
        };
        let query_refused = |s: &Step, id: &str| {
            ApiError::forbidden(format!(
                "{} {}: you may not query the data source {}",
                s.kind.as_str(),
                s.uid,
                self.refs.uid_of(ResourceKind::Datasource, id)
            ))
        };
        for s in steps
            .iter()
            .filter(|s| matches!(s.action, Action::Create | Action::Update | Action::Adopt | Action::Delete))
        {
            let cur = current.get(&(s.kind, s.id.clone()));
            match (s.kind, &s.desired) {
                (ResourceKind::Datasource, _) => ctx.check(Permission::DatasourcesWrite).map_err(|e| named(s, e))?,
                (ResourceKind::Role, desired) => {
                    ctx.check(Permission::RolesWrite).map_err(|e| named(s, e))?;
                    if let Desired::Role { permissions, .. } = desired {
                        authz::ensure_holds(&ctx.permissions, permissions).map_err(|e| named(s, e))?;
                    }
                    if let Some(Current { detail: Detail::Role { permissions }, .. }) = cur {
                        authz::ensure_holds(&ctx.permissions, permissions).map_err(|e| named(s, e))?;
                    }
                }
                (ResourceKind::Dashboard, desired) => {
                    ctx.check(Permission::DashboardsWrite).map_err(|e| named(s, e))?;
                    if s.action == Action::Delete {
                        ctx.check(Permission::DashboardsDelete).map_err(|e| named(s, e))?;
                    }
                    if cur.is_some() {
                        authz::check_resource(
                            &self.state.db,
                            ctx,
                            Permission::DashboardsWrite,
                            Resource::Dashboard(&s.id),
                        )
                        .await
                        .map_err(|e| named(s, e))?;
                    }
                    // A change to a dashboard with live public links goes out to them at once
                    // (owner decision D1), at plan and at apply. Adopting unchanged content is
                    // no change.
                    if cur.is_some() && s.action == Action::Update {
                        crate::sharing::check_live_links(self.state, ctx, std::slice::from_ref(&s.id), "files")
                            .await
                            .map_err(|e| named(s, e))?;
                    }
                    if let Desired::Dashboard { model, place, moved, from_folder, .. } = desired {
                        match place {
                            Place::Top => {}
                            Place::Folder(f) => authz::check_resource(
                                &self.state.db,
                                ctx,
                                Permission::DashboardsWrite,
                                Resource::Folder(f),
                            )
                            .await
                            .map_err(|e| named(s, e))?,
                            Place::Make { parent, .. } => {
                                ctx.check(Permission::FoldersWrite).map_err(|e| named(s, e))?;
                                if let Some(parent) = parent {
                                    authz::check_resource(
                                        &self.state.db,
                                        ctx,
                                        Permission::FoldersWrite,
                                        Resource::Folder(parent),
                                    )
                                    .await
                                    .map_err(|e| named(s, e))?;
                                }
                            }
                        }
                        let to = match place {
                            Place::Folder(f) => Some(f.as_str()),
                            Place::Make { parent, .. } => parent.as_deref(),
                            Place::Top => None,
                        };
                        let governing = |f: Option<&str>| f.and_then(|f| self.tree.governing(f));
                        if *moved && (governing(from_folder.as_deref()).is_some() || governing(to).is_some()) {
                            ctx.check(Permission::FoldersPermissions).map_err(|e| named(s, e))?;
                        }
                        if let Some(id) = model.datasource_ids().into_iter().find(|id| !may_query(id)) {
                            return Err(query_refused(s, id));
                        }
                    }
                }
                (ResourceKind::AlertRule, desired) => {
                    ctx.check(Permission::AlertsWrite).map_err(|e| named(s, e))?;
                    if let Some(Current { detail: Detail::AlertRule { datasource_id, .. }, .. }) = cur
                        && !may_query(datasource_id)
                    {
                        return Err(query_refused(s, datasource_id));
                    }
                    if let Desired::AlertRule { clean, .. } = desired {
                        if !may_query(&clean.datasource_id) {
                            return Err(query_refused(s, &clean.datasource_id));
                        }
                        if let Some(dashboard) = &clean.dashboard_id
                            && self.live_ids(ResourceKind::Dashboard).contains(dashboard)
                        {
                            authz::check_resource(
                                &self.state.db,
                                ctx,
                                Permission::DashboardsRead,
                                Resource::Dashboard(dashboard),
                            )
                            .await
                            .map_err(|e| named(s, e))?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// Plans what applying a set's `docs` would do. Problems with the files come back all at once
/// (`problems_error`).
pub async fn plan(
    state: &AppState,
    ctx: &OrgCtx,
    set: &str,
    docs: Vec<Document>,
    secrets: &BTreeMap<String, Zeroizing<String>>,
    prune: bool,
) -> ApiResult<Prepared> {
    let org_id = ctx.org_id.as_str();
    let mut conn = state.db.acquire().await?;
    let all_records = records(&mut conn, org_id).await?;
    let stamp = records_stamp(&all_records);
    // The rights of each kind first: nothing is read for, checked against or sent anywhere on
    // behalf of files the caller may not apply.
    let mut kinds: BTreeSet<ResourceKind> = docs.iter().map(|d| d.kind).collect();
    if prune {
        kinds.extend(all_records.iter().filter(|(_, r)| r.set_name == set).map(|(k, _)| *k));
    }
    for kind in kinds {
        let needed = match kind {
            ResourceKind::Datasource => Permission::DatasourcesWrite,
            ResourceKind::Role => Permission::RolesWrite,
            ResourceKind::Dashboard => Permission::DashboardsWrite,
            ResourceKind::AlertRule => Permission::AlertsWrite,
        };
        ctx.check(needed).map_err(|e| {
            let message = format!("the {} files need {}: {}", kind.document_kind(), needed.as_str(), e.message);
            ApiError { message, ..e }
        })?;
    }
    let mut p = Planner {
        state,
        org_id,
        ctx,
        secrets,
        refs: Refs::default(),
        // With the folders hidden from the caller marked, so places are found among the visible.
        tree: Tree::load(&mut conn, ctx).await?,
        ids: HashMap::new(),
        new_sources: BTreeSet::new(),
        alerting_sources: BTreeSet::new(),
    };
    for kind in ResourceKind::ALL {
        p.ids.insert(kind, all_ids(&mut conn, org_id, kind).await?);
    }
    let mut by_uid: HashMap<(ResourceKind, String), RecordRow> = HashMap::new();
    let mut by_id: HashMap<(ResourceKind, String), RecordRow> = HashMap::new();
    for (kind, r) in &all_records {
        p.refs.add(*kind, &r.uid, &r.resource_id);
        by_uid.insert((*kind, r.uid.clone()), r.clone());
        by_id.insert((*kind, r.resource_id.clone()), r.clone());
    }
    contact_points(&mut conn, org_id, &mut p.refs).await?;
    let mut problems: Vec<FileProblem> = Vec::new();

    // Which resource each file is about: its record's, an unmanaged one whose id is the uid (taken
    // over), or a new one. A uid or resource of another set is refused.
    struct Target {
        id: String,
        recreate: bool,
    }
    let mut targets: Vec<Target> = Vec::new();
    for doc in &docs {
        let live = p.live_ids(doc.kind);
        let target = match by_uid.get(&(doc.kind, doc.uid.clone())) {
            Some(r) if r.set_name != set => {
                problems.push(FileProblem::new(
                    &doc.path,
                    format!("uid {} belongs to the provisioning set {}; a resource has one set", doc.uid, r.set_name),
                ));
                Target { id: r.resource_id.clone(), recreate: false }
            }
            Some(r) if live.contains(&r.resource_id) => Target { id: r.resource_id.clone(), recreate: false },
            Some(_) => Target { id: crate::routes::new_id(), recreate: true },
            None if live.contains(&doc.uid) => {
                if let Some(other) = by_id.get(&(doc.kind, doc.uid.clone())) {
                    problems.push(FileProblem::new(
                        &doc.path,
                        format!(
                            "{} {} is managed as uid {} by the set {} already",
                            doc.kind.as_str(),
                            doc.uid,
                            other.uid,
                            other.set_name
                        ),
                    ));
                }
                Target { id: doc.uid.clone(), recreate: false }
            }
            None => Target { id: crate::routes::new_id(), recreate: false },
        };
        p.refs.add(doc.kind, &doc.uid, &target.id);
        if doc.kind == ResourceKind::Datasource && !live.contains(&target.id) {
            p.new_sources.insert(target.id.clone());
        }
        targets.push(target);
    }

    // What is stored now, for every resource a file or a record of the set names.
    let set_records: Vec<&RecordRow> = all_records.iter().filter(|(_, r)| r.set_name == set).map(|(_, r)| r).collect();
    let mut current: HashMap<(ResourceKind, String), Current> = HashMap::new();
    for kind in ResourceKind::ALL {
        let live = p.live_ids(kind);
        let mut wanted: BTreeSet<String> =
            docs.iter().zip(&targets).filter(|(d, _)| d.kind == kind).map(|(_, t)| t.id.clone()).collect();
        wanted.extend(set_records.iter().filter(|r| r.kind == kind.as_str()).map(|r| r.resource_id.clone()));
        for id in wanted.into_iter().filter(|id| live.contains(id)) {
            for c in load(&mut conn, org_id, kind, Some(&id), &p.refs, &p.tree).await? {
                current.insert((kind, c.id.clone()), c);
            }
        }
    }
    drop(conn);

    // The data sources' alerting opt-in as the plan leaves it, for the rules' check.
    let opted: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM datasources WHERE org_id = $1 AND deleted_at IS NULL AND alerting_enabled <> 0")
            .bind(org_id)
            .fetch_all(&state.db)
            .await?;
    p.alerting_sources = opted.into_iter().map(|(id,)| id).collect();
    for (doc, target) in docs.iter().zip(&targets) {
        if doc.kind == ResourceKind::Datasource {
            let on = doc.spec.get("alerting").and_then(|a| a.get("enabled")).and_then(Value::as_bool) == Some(true);
            if on {
                p.alerting_sources.insert(target.id.clone());
            } else {
                p.alerting_sources.remove(&target.id);
            }
        }
    }

    let limits = crate::alerting::limits::for_org(state, org_id).await?;
    let default_range = crate::settings::get_org(state, org_id, "dashboards.default_time_range").await?;
    let mut steps: Vec<Step> = Vec::new();
    for (doc, target) in docs.iter().zip(&targets) {
        let cur = current.get(&(doc.kind, target.id.clone()));
        let record = by_uid.get(&(doc.kind, doc.uid.clone())).filter(|r| r.set_name == set);
        let normalized = match doc.kind {
            ResourceKind::Datasource => p.datasource(doc, cur, record).await,
            ResourceKind::Role => p.role(doc),
            ResourceKind::Dashboard => p.dashboard(doc, cur, &default_range),
            ResourceKind::AlertRule => p.rule(doc, cur, &limits),
        };
        let n = match normalized {
            Ok(n) => n,
            Err(message) => {
                problems.push(FileProblem::new(&doc.path, message));
                continue;
            }
        };
        let drifted = target.recreate || record.is_some_and(|r| cur.is_some_and(|c| c.hash != r.state_hash));
        let patch_empty = !matches!(&n.desired, Desired::Datasource { patch, .. } if !patch.is_empty());
        let (action, fields) = match cur {
            None => (Action::Create, Vec::new()),
            Some(c) => {
                let mut fields = differences(&c.spec, &n.spec);
                if let Desired::Datasource { patch, .. } = &n.desired {
                    fields.extend(patch.keys().map(|k| format!("secrets.{k}")));
                }
                if !fields.is_empty() || !patch_empty || drifted {
                    (Action::Update, fields)
                } else if record.is_none() {
                    (Action::Adopt, fields)
                } else {
                    (Action::Unchanged, fields)
                }
            }
        };
        let record_current = record.is_some_and(|r| {
            r.resource_id == target.id
                && r.source_path == doc.path
                && r.checksum == doc.checksum
                && r.state_hash == n.hash
                && r.secret_digest == n.secret_digest
                && r.secret_refs == n.secret_refs
                && r.unlocked_at.is_none()
        });
        steps.push(Step {
            kind: doc.kind,
            uid: doc.uid.clone(),
            name: n.name,
            action,
            id: target.id.clone(),
            path: doc.path.clone(),
            checksum: doc.checksum.clone(),
            expect: cur.map(|c| c.hash.clone()),
            state_hash: n.hash,
            secret_digest: n.secret_digest,
            secret_refs: n.secret_refs,
            record_current,
            drifted,
            fields,
            desired: n.desired,
        });
    }

    // The set's records without a file now.
    let named: BTreeSet<(ResourceKind, String)> = docs.iter().map(|d| (d.kind, d.uid.clone())).collect();
    for r in set_records {
        let Some(kind) = ResourceKind::parse(&r.kind) else { continue };
        if named.contains(&(kind, r.uid.clone())) {
            continue;
        }
        let cur = current.get(&(kind, r.resource_id.clone()));
        let drifted = cur.is_none_or(|c| c.hash != r.state_hash);
        steps.push(Step {
            kind,
            uid: r.uid.clone(),
            name: cur.map(|c| c.name.clone()).unwrap_or_default(),
            action: if prune { Action::Delete } else { Action::Orphaned },
            id: r.resource_id.clone(),
            path: r.source_path.clone(),
            checksum: r.checksum.clone(),
            expect: cur.map(|c| c.hash.clone()),
            state_hash: r.state_hash.clone(),
            secret_digest: r.secret_digest.clone(),
            secret_refs: r.secret_refs.clone(),
            record_current: true,
            drifted,
            fields: Vec::new(),
            desired: Desired::Gone,
        });
    }

    p.authorize(&steps, &current).await?;
    p.cross_checks(&steps, &mut problems).await?;
    if !problems.is_empty() {
        return Err(problems_error(&problems));
    }
    // Only now the checks that may reach out: a plugin's own settings check and the check on
    // save, as the data source routes run them.
    for s in steps.iter().filter(|s| matches!(s.action, Action::Create | Action::Update | Action::Adopt)) {
        let Desired::Datasource { kind, settings, patch, .. } = &s.desired else { continue };
        let stored = current.contains_key(&(s.kind, s.id.clone())).then_some(s.id.as_str());
        let checked = match kind.plugin.check_settings_remote(&datasources::plugin_settings(settings)).await {
            Err(e) => Err(field_text(e)),
            Ok(()) => {
                datasources::check_on_save(state, kind, stored, settings, patch).await.map_err(|e| problem_text(&e))
            }
        };
        if let Err(message) = checked {
            problems.push(FileProblem::new(&s.path, message));
        }
    }
    if !problems.is_empty() {
        return Err(problems_error(&problems));
    }

    let mut counts = Counts::default();
    let mut changes = Vec::new();
    for s in &steps {
        match s.action {
            Action::Create => counts.create += 1,
            Action::Update => counts.update += 1,
            Action::Adopt => counts.adopt += 1,
            Action::Delete => counts.delete += 1,
            Action::Unchanged => counts.unchanged += 1,
            Action::Orphaned => counts.orphaned += 1,
        }
        if s.drifted {
            counts.drifted += 1;
        }
        let exists = current.contains_key(&(s.kind, s.id.clone()));
        changes.push(Change {
            kind: s.kind,
            uid: s.uid.clone(),
            name: s.name.clone(),
            action: s.action,
            resource_id: exists.then(|| s.id.clone()),
            path: s.path.clone(),
            drifted: s.drifted,
            fields: s.fields.clone(),
        });
    }
    Ok(Prepared {
        plan: Plan { org_id: org_id.to_string(), set: set.to_string(), prune, changes, counts },
        steps,
        stamp,
    })
}

// ---- apply ----

fn event<'a>(
    ctx: &'a OrgCtx,
    info: &RequestInfo,
    action: &'a str,
    resource: (&'a str, &'a str),
    summary: Value,
    at_ms: i64,
) -> AuditEvent<'a> {
    AuditEvent {
        org_id: Some(&ctx.org_id),
        actor_user_id: Some(&ctx.user.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some(resource.0),
        resource_id: Some(resource.1),
        summary,
        at_ms,
    }
}

/// Makes the folders of a dashboard's place that do not exist yet; answers the folder.
async fn make_folders(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    info: &RequestInfo,
    made: &mut HashMap<(Option<String>, String), String>,
    place: &Place,
    now: i64,
) -> ApiResult<Option<String>> {
    let (mut parent, names) = match place {
        Place::Top => return Ok(None),
        Place::Folder(f) => return Ok(Some(f.clone())),
        Place::Make { parent, make, .. } => (parent.clone(), make),
    };
    for name in names {
        let key = (parent.clone(), name.clone());
        if let Some(id) = made.get(&key) {
            parent = Some(id.clone());
            continue;
        }
        let id = crate::routes::new_id();
        sqlx::query(
            "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_by, created_at, updated_at, \
             owner_team_id) VALUES ($1, $2, $3, $4, 0, 1, $5, $6, $6, NULL)",
        )
        .bind(&id)
        .bind(&ctx.org_id)
        .bind(parent.as_deref())
        .bind(name)
        .bind(&ctx.user.id)
        .bind(now)
        .execute(&mut *conn)
        .await?;
        let summary = json!({ "parentId": parent, "restricted": false, "provisioning": true });
        record(conn, &event(ctx, info, "folder.created", ("folder", &id), summary, now)).await?;
        made.insert(key, id.clone());
        parent = Some(id);
    }
    Ok(parent)
}

#[expect(
    clippy::too_many_arguments,
    reason = "the version row and what goes with it, as the dashboard routes write it"
)]
async fn insert_version(
    conn: &mut sqlx::AnyConnection,
    dashboard_id: &str,
    version: i64,
    ctx: &OrgCtx,
    model: &DashboardModel,
    message: &str,
    keep: i64,
    now: i64,
) -> ApiResult<()> {
    let text = serde_json::to_string(model).map_err(|e| ApiError::internal("provisioning", e))?;
    sqlx::query(
        "INSERT INTO dashboard_versions (dashboard_id, version, model, message, author_id, restored_from, created_at) \
         VALUES ($1, $2, $3, $4, $5, NULL, $6)",
    )
    .bind(dashboard_id)
    .bind(version)
    .bind(&text)
    .bind(message)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    crate::routes::dashboards::forget_removed_panels(conn, dashboard_id, model).await?;
    if keep > 0 {
        sqlx::query("DELETE FROM dashboard_versions WHERE dashboard_id = $1 AND version <= $2")
            .bind(dashboard_id)
            .bind(version - keep)
            .execute(&mut *conn)
            .await?;
    }
    crate::dashboards::library::sync_references(conn, &ctx.org_id, dashboard_id, model).await?;
    crate::saved_analyses::sync_uses(conn, &ctx.org_id, dashboard_id, model).await?;
    Ok(())
}

async fn write_role_permissions(
    conn: &mut sqlx::AnyConnection,
    role_id: &str,
    permissions: &BTreeSet<Permission>,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1").bind(role_id).execute(&mut *conn).await?;
    for p in permissions {
        sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)")
            .bind(role_id)
            .bind(p.as_str())
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

fn changed() -> ApiError {
    crate::routes::support::conflict(
        "something the plan read changed before the apply could take the organization's lock; plan and apply again",
    )
    .because("provisioning.changed")
}

/// What one step did, for the audit and the connection tests.
struct Done {
    kind: ResourceKind,
    uid: String,
    id: String,
}

/// Applies a plan, all or nothing. The plan must be the caller's own, made just before.
pub async fn apply(state: &AppState, ctx: &OrgCtx, info: &RequestInfo, prepared: Prepared) -> ApiResult<ApplyResult> {
    let Prepared { plan, steps, stamp } = prepared;
    let org_id = ctx.org_id.as_str();
    let now = state.clock.now_ms();
    let keep = crate::settings::get(state, "dashboards.version_retention").await?.as_i64().unwrap_or(0);
    let mut tx = crate::db::begin(&state.db).await?;
    authz::lock_org(&mut tx, org_id).await?;

    // Nothing the plan read may have changed: the records, and every stored resource it compared.
    let (mut refs, rows) = stored_refs(&mut tx, org_id).await?;
    if records_stamp(&rows) != stamp {
        return Err(changed());
    }
    for s in &steps {
        refs.add(s.kind, &s.uid, &s.id);
    }
    let tree = folder_tree(&mut tx, org_id).await?;
    for s in steps.iter().filter(|s| s.action != Action::Orphaned) {
        let now_stored = load(&mut tx, org_id, s.kind, Some(&s.id), &refs, &tree).await?;
        if now_stored.first().map(|c| &c.hash) != s.expect.as_ref() {
            return Err(changed());
        }
    }
    // The places of dashboards as planned: each folder still there, outside the trash and every
    // team space, and no folder made meanwhile where the apply makes one.
    let live = |id: &str| tree.rows.get(id).is_some_and(|r| r.deleted_at.is_none()) && tree.space_of(id).is_none();
    for s in steps.iter().filter(|s| matches!(s.action, Action::Create | Action::Update)) {
        let Desired::Dashboard { place, .. } = &s.desired else { continue };
        let still = match place {
            Place::Top => true,
            Place::Folder(f) => live(f),
            Place::Make { parent, make, same_named: planned } => {
                parent.as_deref().is_none_or(live)
                    && make.first().is_some_and(|n| same_named(&tree, parent.as_ref(), n) == *planned)
            }
        };
        if !still {
            return Err(changed());
        }
    }

    let mut done: Vec<Done> = Vec::new();
    let mut made_folders: HashMap<(Option<String>, String), String> = HashMap::new();
    let mut touched_sources: Vec<String> = Vec::new();
    let mut alerting_changed = false;
    let audit_of = |s: &Step| json!({ "provisioning": { "set": plan.set, "uid": s.uid, "path": s.path } });

    // Deletes first, rules before what they use.
    let mut deletes: Vec<&Step> = steps.iter().filter(|s| s.action == Action::Delete).collect();
    deletes.sort_by_key(|s| std::cmp::Reverse(s.kind));
    for s in deletes {
        match s.kind {
            ResourceKind::AlertRule => {
                crate::alerting::groups::forget(&mut tx, &s.id, now).await?;
                sqlx::query("DELETE FROM alert_rules WHERE id = $1 AND org_id = $2")
                    .bind(&s.id)
                    .bind(org_id)
                    .execute(&mut *tx)
                    .await?;
                record(&mut tx, &event(ctx, info, "alert_rule.deleted", ("alert_rule", &s.id), audit_of(s), now))
                    .await?;
                alerting_changed = true;
            }
            ResourceKind::Dashboard => {
                sqlx::query(
                    "UPDATE dashboards SET deleted_at = $1, trash_batch = $2 WHERE org_id = $3 AND id = $4 \
                     AND deleted_at IS NULL",
                )
                .bind(now)
                .bind(crate::routes::new_id())
                .bind(org_id)
                .bind(&s.id)
                .execute(&mut *tx)
                .await?;
                record(&mut tx, &event(ctx, info, "dashboard.trashed", ("dashboard", &s.id), audit_of(s), now)).await?;
            }
            ResourceKind::Role => {
                let (holders,): (i64,) =
                    sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND role = $2")
                        .bind(org_id)
                        .bind(&s.id)
                        .fetch_one(&mut *tx)
                        .await?;
                if holders > 0 {
                    return Err(crate::routes::support::conflict(format!(
                        "role {}: members still have this role; give them another role first",
                        s.uid
                    )));
                }
                sqlx::query(
                    "DELETE FROM team_roles WHERE role = $1 AND team_id IN (SELECT id FROM teams WHERE org_id = $2)",
                )
                .bind(&s.id)
                .bind(org_id)
                .execute(&mut *tx)
                .await?;
                sqlx::query(
                    "DELETE FROM resource_grants WHERE org_id = $1 AND subject_type = 'role' AND subject_id = $2",
                )
                .bind(org_id)
                .bind(&s.id)
                .execute(&mut *tx)
                .await?;
                sqlx::query("DELETE FROM roles WHERE org_id = $1 AND id = $2")
                    .bind(org_id)
                    .bind(&s.id)
                    .execute(&mut *tx)
                    .await?;
                record(&mut tx, &event(ctx, info, "role.deleted", ("role", &s.id), audit_of(s), now)).await?;
            }
            ResourceKind::Datasource => {
                sqlx::query(
                    "UPDATE datasources SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND org_id = $3 \
                     AND deleted_at IS NULL",
                )
                .bind(now)
                .bind(&s.id)
                .bind(org_id)
                .execute(&mut *tx)
                .await?;
                record(&mut tx, &event(ctx, info, "datasource.deleted", ("datasource", &s.id), audit_of(s), now))
                    .await?;
                touched_sources.push(s.id.clone());
            }
        }
        sqlx::query("DELETE FROM provisioned_resources WHERE org_id = $1 AND kind = $2 AND uid = $3")
            .bind(org_id)
            .bind(s.kind.as_str())
            .bind(&s.uid)
            .execute(&mut *tx)
            .await?;
        done.push(Done { kind: s.kind, uid: s.uid.clone(), id: s.id.clone() });
    }

    // Creates and changes, data sources first and rules last.
    let mut writes: Vec<&Step> = steps
        .iter()
        .filter(|s| matches!(s.action, Action::Create | Action::Update | Action::Adopt | Action::Unchanged))
        .collect();
    writes.sort_by_key(|s| s.kind);
    for s in writes {
        let create = s.action == Action::Create;
        let write = matches!(s.action, Action::Create | Action::Update);
        if write {
            match &s.desired {
                Desired::Datasource {
                    kind,
                    name,
                    settings,
                    patch,
                    alerting,
                    max_concurrent,
                    settings_changed,
                    stored_updated_at,
                } => {
                    if *alerting {
                        crate::alerting::service_account::ensure(&mut tx, org_id, now).await?;
                    }
                    if create {
                        sqlx::query(
                            "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at, \
                             alerting_enabled, alerting_max_concurrent) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)",
                        )
                        .bind(&s.id)
                        .bind(org_id)
                        .bind(name)
                        .bind(kind.kind())
                        .bind(settings.to_string())
                        .bind(now)
                        .bind(i64::from(*alerting))
                        .bind(*max_concurrent)
                        .execute(&mut *tx)
                        .await?;
                    } else {
                        let at = now.max(stored_updated_at.unwrap_or(0) + 1);
                        sqlx::query(
                            "UPDATE datasources SET name = $1, settings = $2, updated_at = $3, alerting_enabled = $4, \
                             alerting_max_concurrent = $5 WHERE id = $6 AND org_id = $7 AND deleted_at IS NULL",
                        )
                        .bind(name)
                        .bind(settings.to_string())
                        .bind(at)
                        .bind(i64::from(*alerting))
                        .bind(*max_concurrent)
                        .bind(&s.id)
                        .bind(org_id)
                        .execute(&mut *tx)
                        .await?;
                    }
                    crate::secrets::apply_patch(&mut tx, state.datasources.keyring(), &s.id, patch).await?;
                    if !create && (*settings_changed || !patch.is_empty()) {
                        datasources::forget_last_test(&mut tx, &s.id).await?;
                    }
                    let mut summary = audit_of(s);
                    summary["changed"] = json!(s.fields);
                    summary["secrets"] = json!(patch.keys().collect::<Vec<_>>());
                    let action = if create { "datasource.created" } else { "datasource.updated" };
                    record(&mut tx, &event(ctx, info, action, ("datasource", &s.id), summary, now)).await?;
                    touched_sources.push(s.id.clone());
                    alerting_changed = true;
                }
                Desired::Role { name, description, permissions } => {
                    if create {
                        sqlx::query(
                            "INSERT INTO roles (id, org_id, name, name_key, description, created_at) \
                             VALUES ($1, $2, $3, $4, $5, $6)",
                        )
                        .bind(&s.id)
                        .bind(org_id)
                        .bind(name)
                        .bind(name.to_lowercase())
                        .bind(description)
                        .bind(now)
                        .execute(&mut *tx)
                        .await?;
                    } else {
                        authz::lock_role(&mut tx, org_id, &s.id).await?;
                        sqlx::query(
                            "UPDATE roles SET name = $1, name_key = $2, description = $3 WHERE org_id = $4 AND id = $5",
                        )
                        .bind(name)
                        .bind(name.to_lowercase())
                        .bind(description)
                        .bind(org_id)
                        .bind(&s.id)
                        .execute(&mut *tx)
                        .await?;
                    }
                    write_role_permissions(&mut tx, &s.id, permissions).await?;
                    let mut summary = audit_of(s);
                    summary["roleId"] = json!(s.id);
                    summary["permissions"] = json!(permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>());
                    let action = if create { "role.created" } else { "role.updated" };
                    record(&mut tx, &event(ctx, info, action, ("role", &s.id), summary, now)).await?;
                }
                Desired::Dashboard { model, place, from_folder, .. } => {
                    let folder = make_folders(&mut tx, ctx, info, &mut made_folders, place, now).await?;
                    let message: String =
                        format!("Provisioned from {} ({})", s.path, plan.set).chars().take(MAX_MESSAGE_CHARS).collect();
                    let version = if create {
                        sqlx::query(
                            "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_by, \
                             created_at, updated_by, updated_at, sort_title) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $6, $7, $8)",
                        )
                        .bind(&s.id)
                        .bind(org_id)
                        .bind(folder.as_deref())
                        .bind(&model.title)
                        .bind(model.title.to_lowercase())
                        .bind(&ctx.user.id)
                        .bind(now)
                        .bind(crate::collation::key(&model.title))
                        .execute(&mut *tx)
                        .await?;
                        1
                    } else {
                        if folder != *from_folder
                            && let Some(old) = from_folder.as_deref()
                            && tree.is_restricted(old)
                        {
                            sqlx::query("UPDATE dashboards SET ever_restricted = 1 WHERE org_id = $1 AND id = $2")
                                .bind(org_id)
                                .bind(&s.id)
                                .execute(&mut *tx)
                                .await?;
                        }
                        sqlx::query(
                            "UPDATE dashboards SET title = $1, search_title = $2, folder_id = $3, version = version + 1, \
                             updated_by = $4, updated_at = $5, sort_title = $6 WHERE org_id = $7 AND id = $8 \
                             AND deleted_at IS NULL",
                        )
                        .bind(&model.title)
                        .bind(model.title.to_lowercase())
                        .bind(folder.as_deref())
                        .bind(&ctx.user.id)
                        .bind(now)
                        .bind(crate::collation::key(&model.title))
                        .bind(org_id)
                        .bind(&s.id)
                        .execute(&mut *tx)
                        .await?;
                        let (v,): (i64,) = sqlx::query_as("SELECT version FROM dashboards WHERE id = $1")
                            .bind(&s.id)
                            .fetch_one(&mut *tx)
                            .await?;
                        v
                    };
                    insert_version(&mut tx, &s.id, version, ctx, model, &message, keep, now).await?;
                    let mut summary = audit_of(s);
                    summary["version"] = json!(version);
                    summary["folderId"] = json!(folder);
                    let action = if create { "dashboard.created" } else { "dashboard.saved" };
                    record(&mut tx, &event(ctx, info, action, ("dashboard", &s.id), summary, now)).await?;
                }
                Desired::AlertRule { clean, stored_routing } => {
                    if create {
                        crate::alerting::service_account::ensure(&mut tx, org_id, now).await?;
                        sqlx::query(
                            "INSERT INTO alert_rules (id, org_id, name, description, runbook_url, datasource_id, query, \
                             range_secs, reduce, condition, interval_secs, for_secs, no_data_state, error_state, labels, \
                             reminder_secs, paused, dashboard_id, panel_id, version, created_by, created_at, updated_by, \
                             updated_at, skipped_evaluations, routing) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
                             $11, $12, $13, $14, $15, $16, 0, $17, $18, 1, $19, $20, $19, $20, 0, $21)",
                        )
                        .bind(&s.id)
                        .bind(org_id)
                        .bind(&clean.name)
                        .bind(&clean.description)
                        .bind(&clean.runbook_url)
                        .bind(&clean.datasource_id)
                        .bind(&clean.query)
                        .bind(clean.range_secs)
                        .bind(&clean.reduce)
                        .bind(&clean.condition)
                        .bind(clean.interval_secs)
                        .bind(clean.for_secs)
                        .bind(&clean.no_data_state)
                        .bind(&clean.error_state)
                        .bind(&clean.labels)
                        .bind(clean.reminder_secs)
                        .bind(&clean.dashboard_id)
                        .bind(&clean.panel_id)
                        .bind(&ctx.user.id)
                        .bind(now)
                        .bind(&clean.routing)
                        .execute(&mut *tx)
                        .await?;
                        rules::link_contact_points(&mut tx, &s.id, &clean.contact_point_ids).await?;
                    } else {
                        // The rule's row locked, and the right to query the source it has now
                        // checked again (another change may have moved it since the plan).
                        let stored: Option<(String,)> =
                            sqlx::query_as("SELECT id FROM alert_rules WHERE id = $1 AND org_id = $2")
                                .bind(&s.id)
                                .bind(org_id)
                                .fetch_optional(&mut *tx)
                                .await?;
                        if stored.is_some() {
                            rules::lock_and_check_source(state, ctx, &mut tx, &s.id, "").await?;
                            // A source other than the locked row's: what the rule's instances
                            // were and sent is ended and resolved under the old one.
                            crate::alerting::evaluate::end_for_source_change(
                                state,
                                &mut tx,
                                &s.id,
                                &clean.datasource_id,
                                now,
                            )
                            .await?;
                        }
                        sqlx::query(
                            "UPDATE alert_rules SET name = $1, description = $2, runbook_url = $3, datasource_id = $4, \
                             query = $5, range_secs = $6, reduce = $7, condition = $8, interval_secs = $9, for_secs = $10, \
                             no_data_state = $11, error_state = $12, labels = $13, reminder_secs = $14, dashboard_id = $15, \
                             panel_id = $16, version = version + 1, updated_by = $17, updated_at = $18, routing = $19 \
                             WHERE id = $20 AND org_id = $21",
                        )
                        .bind(&clean.name)
                        .bind(&clean.description)
                        .bind(&clean.runbook_url)
                        .bind(&clean.datasource_id)
                        .bind(&clean.query)
                        .bind(clean.range_secs)
                        .bind(&clean.reduce)
                        .bind(&clean.condition)
                        .bind(clean.interval_secs)
                        .bind(clean.for_secs)
                        .bind(&clean.no_data_state)
                        .bind(&clean.error_state)
                        .bind(&clean.labels)
                        .bind(clean.reminder_secs)
                        .bind(&clean.dashboard_id)
                        .bind(&clean.panel_id)
                        .bind(&ctx.user.id)
                        .bind(now)
                        .bind(&clean.routing)
                        .bind(&s.id)
                        .bind(org_id)
                        .execute(&mut *tx)
                        .await?;
                        let before: Vec<(String,)> =
                            sqlx::query_as("SELECT contact_point_id FROM alert_rule_contact_points WHERE rule_id = $1")
                                .bind(&s.id)
                                .fetch_all(&mut *tx)
                                .await?;
                        let before: BTreeSet<String> = before.into_iter().map(|(id,)| id).collect();
                        rules::link_contact_points(&mut tx, &s.id, &clean.contact_point_ids).await?;
                        if stored_routing.as_deref().is_some_and(|r| r != clean.routing) {
                            rules::switch_routing(&mut tx, org_id, &s.id, clean, &before, now).await?;
                        }
                    }
                    let mut summary = audit_of(s);
                    summary["ruleId"] = json!(s.id);
                    summary["name"] = json!(clean.name);
                    summary["datasourceId"] = json!(clean.datasource_id);
                    let action = if create { "alert_rule.created" } else { "alert_rule.updated" };
                    record(&mut tx, &event(ctx, info, action, ("alert_rule", &s.id), summary, now)).await?;
                    alerting_changed = true;
                }
                Desired::Gone => {}
            }
        }
        if !s.record_current || s.action == Action::Adopt || write {
            sqlx::query(
                "INSERT INTO provisioned_resources (org_id, set_name, kind, uid, resource_id, source_path, checksum, \
                 state_hash, secret_digest, secret_refs, applied_at, applied_by, unlocked_at, unlocked_by) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL) \
                 ON CONFLICT (org_id, kind, uid) DO UPDATE SET set_name = excluded.set_name, \
                 resource_id = excluded.resource_id, source_path = excluded.source_path, checksum = excluded.checksum, \
                 state_hash = excluded.state_hash, secret_digest = excluded.secret_digest, \
                 secret_refs = excluded.secret_refs, applied_at = excluded.applied_at, applied_by = excluded.applied_by, \
                 unlocked_at = NULL, unlocked_by = NULL",
            )
            .bind(org_id)
            .bind(&plan.set)
            .bind(s.kind.as_str())
            .bind(&s.uid)
            .bind(&s.id)
            .bind(&s.path)
            .bind(&s.checksum)
            .bind(&s.state_hash)
            .bind(&s.secret_digest)
            .bind(&s.secret_refs)
            .bind(now)
            .bind(&ctx.user.id)
            .execute(&mut *tx)
            .await?;
        }
        if write || s.action == Action::Adopt {
            done.push(Done { kind: s.kind, uid: s.uid.clone(), id: s.id.clone() });
        }
    }
    let summary = json!({
        "set": plan.set,
        "prune": plan.prune,
        "create": plan.counts.create,
        "update": plan.counts.update,
        "adopt": plan.counts.adopt,
        "delete": plan.counts.delete,
        "unchanged": plan.counts.unchanged,
        "orphaned": plan.counts.orphaned,
        "drifted": plan.counts.drifted,
    });
    record(&mut tx, &event(ctx, info, "provisioning.applied", ("org", org_id), summary, now)).await?;
    crate::db::commit(tx).await?;
    // What was made now has an id.
    let mut plan = plan;
    for (change, step) in plan.changes.iter_mut().zip(&steps) {
        if step.action == Action::Create {
            change.resource_id = Some(step.id.clone());
        }
    }
    for id in &touched_sources {
        state.datasources.forget(id);
    }
    if alerting_changed {
        state.alerting.changed();
    }

    // A failed connection test is a warning: the apply stands.
    let mut warnings = Vec::new();
    for d in done.iter().filter(|d| d.kind == ResourceKind::Datasource) {
        let Ok(ds) = datasources::resolve_in_org(&state.db, org_id, &d.id).await else { continue };
        let failure = match datasources::check_health(state, &ctx.user.id, &ds).await {
            Ok(report) if report.ok => None,
            Ok(report) => Some(report.message),
            Err(e) => Some(e.message),
        };
        if let Some(message) = failure {
            warnings.push(ApplyWarning {
                kind: d.kind,
                uid: d.uid.clone(),
                reason: "datasource.connection_failed".into(),
                message,
            });
        }
    }
    Ok(ApplyResult { plan, warnings })
}

// ---- the managed resources, unlocking and export ----

/// The organization-wide permission to read resources of a kind.
fn kind_read(kind: ResourceKind) -> Permission {
    match kind {
        ResourceKind::Datasource => Permission::DatasourcesRead,
        ResourceKind::Role => Permission::RolesRead,
        ResourceKind::Dashboard => Permission::DashboardsRead,
        ResourceKind::AlertRule => Permission::AlertsRead,
    }
}

/// What the caller may read, as the routes of each kind decide it.
struct Readable {
    access: authz::DatasourceAccess,
}

impl Readable {
    async fn load(state: &AppState, ctx: &OrgCtx) -> ApiResult<Self> {
        Ok(Self { access: authz::DatasourceAccess::load(&state.db, ctx).await? })
    }

    /// `None` when the caller may read the resource, else why not. Dashboards go through
    /// `check_resource`, which also records an org admin's look into a team space.
    async fn refusal(
        &self,
        state: &AppState,
        ctx: &OrgCtx,
        kind: ResourceKind,
        c: &Current,
    ) -> ApiResult<Option<String>> {
        let dashboard = |id: String| async move {
            match authz::check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(&id)).await {
                Ok(()) => Ok(true),
                Err(e) if matches!(e.code, "not_found" | "forbidden") => Ok(false),
                Err(e) => Err(e),
            }
        };
        Ok(match (kind, &c.detail) {
            (ResourceKind::Datasource, _) => (!self.access.allows(Permission::DatasourcesRead, &c.id))
                .then(|| "you may not read this data source".to_string()),
            (ResourceKind::Role, _) => {
                (!ctx.permissions.contains(&Permission::RolesRead)).then(|| "you do not hold roles:read".to_string())
            }
            (ResourceKind::Dashboard, _) => {
                (!dashboard(c.id.clone()).await?).then(|| "you may not read this dashboard".to_string())
            }
            (ResourceKind::AlertRule, Detail::AlertRule { datasource_id, dashboard_id, .. }) => {
                if !ctx.permissions.contains(&Permission::AlertsRead) {
                    Some("you do not hold alerts:read".into())
                } else if !crate::routes::alerting::data_visible(&self.access, datasource_id) {
                    // As in the rule routes: the query and the data are for those who may read
                    // or query the source.
                    Some("you may not read or query its data source".into())
                } else if let Some(d) = dashboard_id
                    && !dashboard(d.clone()).await?
                {
                    Some("you may not read its dashboard".into())
                } else {
                    None
                }
            }
            (ResourceKind::AlertRule, _) => Some("unreadable".into()),
        })
    }
}

/// Every managed resource of the organization the caller may read, by set, kind and uid, with
/// its drift. One that is gone shows to those who may read its kind.
pub async fn list(state: &AppState, ctx: &OrgCtx) -> ApiResult<Vec<Provisioned>> {
    let org_id = ctx.org_id.as_str();
    let mut conn = state.db.acquire().await?;
    let (refs, rows) = stored_refs(&mut conn, org_id).await?;
    let tree = folder_tree(&mut conn, org_id).await?;
    let readable = Readable::load(state, ctx).await?;
    let mut out = Vec::new();
    for (kind, r) in rows {
        let cur = load(&mut conn, org_id, kind, Some(&r.resource_id), &refs, &tree).await?.into_iter().next();
        let hidden = match &cur {
            Some(c) => readable.refusal(state, ctx, kind, c).await?.is_some(),
            None => !ctx.permissions.contains(&kind_read(kind)),
        };
        if hidden {
            continue;
        }
        out.push(Provisioned {
            set: r.set_name,
            kind,
            uid: r.uid,
            name: cur.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
            drifted: cur.as_ref().is_none_or(|c| c.hash != r.state_hash),
            missing: cur.is_none(),
            resource_id: r.resource_id,
            path: r.source_path,
            checksum: r.checksum,
            applied_at: r.applied_at,
            applied_by: r.applied_by,
            unlocked_at: r.unlocked_at,
            unlocked_by: r.unlocked_by,
        });
    }
    Ok(out)
}

/// Unlocks a managed resource for normal edits until its set is applied again (an emergency
/// change). Audited; answers the resource as listed.
pub async fn unlock(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    kind: ResourceKind,
    uid: &str,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    let found: Option<(String, String, String, Option<i64>)> = sqlx::query_as(
        "SELECT set_name, resource_id, source_path, unlocked_at FROM provisioned_resources \
         WHERE org_id = $1 AND kind = $2 AND uid = $3",
    )
    .bind(&ctx.org_id)
    .bind(kind.as_str())
    .bind(uid)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((set, resource_id, path, unlocked)) = found else { return Err(ApiError::not_found()) };
    if unlocked.is_none() {
        sqlx::query(
            "UPDATE provisioned_resources SET unlocked_at = $1, unlocked_by = $2 WHERE org_id = $3 AND kind = $4 AND uid = $5",
        )
        .bind(now)
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(kind.as_str())
        .bind(uid)
        .execute(&mut *tx)
        .await?;
        let summary = json!({ "set": set, "kind": kind.as_str(), "uid": uid, "path": path, "resourceId": resource_id });
        record(&mut tx, &event(ctx, info, "provisioning.unlocked", (kind.as_str(), &resource_id), summary, now))
            .await?;
    }
    crate::db::commit(tx).await?;
    Ok(())
}

/// Writes the organization's dashboards, data sources, custom roles and alert rules as files of
/// the set `set`: its own resources at their files and uids, unmanaged ones under their ids
/// (an apply of the export takes them over), secrets as references. Resources of other sets,
/// those hidden from the caller and dashboards that link library panels or saved analyses are
/// left out with the reason.
pub async fn export(state: &AppState, ctx: &OrgCtx, set: &str) -> ApiResult<Export> {
    let org_id = ctx.org_id.as_str();
    let mut conn = state.db.acquire().await?;
    let (refs, rows) = stored_refs(&mut conn, org_id).await?;
    let owners: HashMap<(ResourceKind, String), &RecordRow> =
        rows.iter().map(|(k, r)| ((*k, r.resource_id.clone()), r)).collect();
    let tree = folder_tree(&mut conn, org_id).await?;
    let readable = Readable::load(state, ctx).await?;
    let (org_name,): (String,) =
        sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(org_id).fetch_one(&mut *conn).await?;
    let mut out = Export { set: set.to_string(), ..Export::default() };
    let org_file = document::render_org(org_id, &org_name, set).map_err(|e| ApiError::internal("provisioning", e))?;
    out.files.push(ExportFile { path: "org.yaml".into(), content: org_file });
    // Compared without case: two paths differing in case alone are one file on some systems.
    let mut used_paths: BTreeSet<String> = BTreeSet::from(["org.yaml".to_string()]);
    for kind in ResourceKind::ALL {
        let all = load(&mut conn, org_id, kind, None, &refs, &tree).await?;
        for c in all {
            let skip = |reason: String| ExportSkip { kind, resource_id: c.id.clone(), name: c.name.clone(), reason };
            if !ctx.permissions.contains(&kind_read(kind)) {
                let reason = format!("you do not hold {}", kind_read(kind).as_str());
                out.skipped.push(ExportSkip { kind, resource_id: c.id.clone(), name: String::new(), reason });
                continue;
            }
            // Resources the caller may not read are left out without a name.
            if let Some(why) = readable.refusal(state, ctx, kind, &c).await? {
                out.skipped.push(ExportSkip { kind, resource_id: c.id.clone(), name: String::new(), reason: why });
                continue;
            }
            let owner = owners.get(&(kind, c.id.clone()));
            if let Some(r) = owner.filter(|r| r.set_name != set) {
                out.skipped.push(skip(format!("managed by the provisioning set {}", r.set_name)));
                continue;
            }
            let mut spec = c.spec.clone();
            match &c.detail {
                Detail::Dashboard { links, model, .. } => {
                    if *links {
                        out.skipped.push(skip("links library panels or saved analyses".into()));
                        continue;
                    }
                    if model.is_none() {
                        out.skipped.push(skip("its stored model cannot be read".into()));
                        continue;
                    }
                }
                Detail::Datasource { secret_fields, .. } => {
                    let refs_json: Map<String, Value> =
                        owner.and_then(|r| serde_json::from_str(&r.secret_refs).ok()).unwrap_or_default();
                    let secrets: Map<String, Value> = secret_fields
                        .iter()
                        .map(|f| {
                            let r = refs_json.get(f).cloned().unwrap_or_else(|| json!(SecretRef::store()));
                            (f.clone(), r)
                        })
                        .collect();
                    if !secrets.is_empty() {
                        spec["secrets"] = Value::Object(secrets);
                    }
                }
                _ => {}
            }
            let uid = owner.map(|r| r.uid.clone()).unwrap_or_else(|| c.id.clone());
            let path = match owner {
                Some(r)
                    if !used_paths.contains(&r.source_path.to_lowercase())
                        && document::check_path(&r.source_path).is_ok() =>
                {
                    r.source_path.clone()
                }
                _ => {
                    let base = document::slug(&c.name, kind.as_str());
                    let mut path = format!("{}/{base}.yaml", kind.folder());
                    let mut n = 2;
                    while used_paths.contains(&path.to_lowercase()) {
                        path = format!("{}/{base}-{n}.yaml", kind.folder());
                        n += 1;
                    }
                    path
                }
            };
            used_paths.insert(path.to_lowercase());
            let content =
                document::render_for(&path, kind, &uid, &spec).map_err(|e| ApiError::internal("provisioning", e))?;
            out.files.push(ExportFile { path, content });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn differences_name_the_changed_fields() {
        let old = json!({ "name": "A", "settings": { "host": "a", "port": 1 }, "type": "postgres" });
        let new = json!({ "name": "A", "settings": { "host": "b", "port": 1 }, "type": "postgres", "alerting": {} });
        assert_eq!(differences(&old, &new), ["alerting", "settings.host"]);
        assert!(differences(&old, &old).is_empty());
    }

    #[test]
    fn folders_with_slashes_are_written_as_lists() {
        let model = json!({});
        assert_eq!(dash_spec(&["Ops".into(), "DB".into()], &model)["folder"], "Ops/DB");
        assert_eq!(dash_spec(&["A/B".into()], &model)["folder"], json!(["A/B"]));
        assert!(dash_spec(&[], &model).get("folder").is_none());
    }

    #[test]
    fn set_names_are_checked() {
        assert_eq!(set_name(None).unwrap(), "default");
        assert_eq!(set_name(Some(" ops ")).unwrap(), "ops");
        assert!(set_name(Some("a b")).is_err());
        assert!(set_name(Some(&"a".repeat(65))).is_err());
    }

    #[test]
    fn request_paths_stay_relative() {
        for bad in ["../x.yaml", "/x.yaml", "a//x.yaml", "a\\x.yaml", "x.txt"] {
            let request = SetRequest {
                files: vec![RequestFile { path: bad.into(), content: "kind: Role\nuid: a\nspec: {}\n".into() }],
                ..SetRequest::default()
            };
            assert_eq!(documents(&request).unwrap_err().code, "validation", "{bad}");
        }
    }
}
