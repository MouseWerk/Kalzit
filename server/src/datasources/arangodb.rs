//! ArangoDB 3.11+ over its HTTP API (`json_api.rs`). Queries are AQL (`{"aql": "..."}`), with
//! dashboard variables and macros bound as bind parameters (`@name`, `@@name` for a collection),
//! never as text in the query.
//!
//! ArangoDB has no read-only query mode, so three things keep a source read-only:
//!
//! 1. The login: Kalzit reads the user's access levels (`GET /_api/user/{user}/database/?full=true`)
//!    when it sets up the connection (after every change of the source) and in Test connection, and
//!    refuses a user with `rw` on the database or on any collection of it, or whose levels it cannot
//!    read, unless a data source admin set `allowWriteCapableUser`.
//! 2. The query text, checked by `aql.rs` before anything is sent: no `INSERT`, `UPDATE`,
//!    `REPLACE`, `REMOVE`, `UPSERT`, user-defined functions, `CALL` or `APPLY`.
//! 3. ArangoDB's own parser: every query is parsed first (`POST /_api/query`, which runs nothing),
//!    and one whose syntax tree has a writing operation or a user function call is refused.
//!
//! Results: documents with `_from` and `_to` (edges) and traversal paths (`{vertices, edges}`)
//! make the result a `graph`, with the documents next to them as nodes (a node's id is its `_id`,
//! its label its collection); any other result is `documents` (values that are not objects as
//! `{"value": ...}`).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::frame::Charge;
use super::graph::{GraphBuilder, GraphLimits};
use super::json_api::{self, Answer, JsonApi, Reasons};
use super::json_documents::DocumentsBuilder;
use super::{
    Connection, DataSourcePlugin, DefaultValue, Detail, FieldError, Health, Kind, SettingField, SettingType,
    SourceError, SourceQuery, SourceSchema,
};
use crate::locks::MutexExt;
use crate::shapes::{Edge, GraphPath, Node, NoticeSeverity, QueryResult, Shape};

pub mod aql;

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("database", "datasources.settings.database", SettingType::String)
        .target()
        .default(DefaultValue::Text("_system")),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    // Deciding that only the query checks protect the data is an admin's decision, so the field is
    // a target field (it needs the admin level and the secrets again to change).
    SettingField::new("allowWriteCapableUser", "datasources.settings.allowWriteCapableUser", SettingType::Bool)
        .target()
        .default(DefaultValue::Bool(false)),
    SettingField::new("maxNodes", "datasources.settings.maxNodes", SettingType::Number),
    SettingField::new("maxEdges", "datasources.settings.maxEdges", SettingType::Number),
];

const REASONS: Reasons =
    Reasons { engine: "ArangoDB", redirect: "arangodb.redirect_refused", credentials: "arangodb.credentials_invalid" };
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Results asked for per batch.
const BATCH: usize = 1000;
/// Collections whose documents are sampled for property keys.
const SAMPLED_COLLECTIONS: usize = 50;
const MAX_SCHEMA_NAMES: usize = 10_000;
/// How deep the result is searched for documents, edges and paths.
const MAX_DEPTH: usize = 8;
/// How long the deletion of a cursor left open may take.
const CURSOR_DELETE_TIMEOUT: Duration = Duration::from_secs(2);
/// The time limit of a schema sample of one collection.
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn kind() -> Kind {
    Kind {
        name: "ArangoDB",
        hint_key: "datasources.kinds.arangodb.hint",
        settings: SETTINGS,
        plugin: Arc::new(ArangoDb),
    }
}

pub struct ArangoDb;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    database: Option<String>,
    user: Option<String>,
    ca_cert: Option<String>,
    allow_write_capable_user: Option<bool>,
    max_nodes: Option<u64>,
    max_edges: Option<u64>,
}

impl Settings {
    fn database(&self) -> &str {
        self.database.as_deref().filter(|d| !d.trim().is_empty()).unwrap_or("_system")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AqlQuery {
    aql: String,
}

struct Client {
    api: JsonApi,
    database: String,
    user: Option<String>,
    allow_write: bool,
    /// What lets the user write, as found when the connection was set up.
    writes: Vec<String>,
}

/// A database or collection name: letters, digits, `_`, `-` and the like, no `/`.
fn is_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 256 && !s.contains('/') && !s.chars().any(char::is_control)
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let api = JsonApi::new(conn, &s.url, s.user.as_deref(), s.ca_cert.clone(), REASONS)?;
        let mut c = Client {
            api,
            database: s.database().to_string(),
            user: s.user.clone().filter(|u| !u.is_empty()),
            allow_write: s.allow_write_capable_user.unwrap_or(false),
            writes: Vec::new(),
        };
        c.writes = c.checked_writes().await?;
        Ok(c)
    })
    .await
}

impl Client {
    fn url(&self, rest: &[&str]) -> Result<reqwest::Url, SourceError> {
        let mut segments = vec!["_db", self.database.as_str()];
        segments.extend_from_slice(rest);
        self.api.url(&segments)
    }

    /// A JSON answer; an answer with `"error": true` or a status outside 2xx is the server's
    /// error.
    async fn json(&self, method: Method, rest: &[&str], body: Option<&Value>) -> Result<Value, SourceError> {
        let url = self.url(rest)?;
        let a = self.api.call(method, url, body, MAX_SMALL_RESPONSE, None).await?;
        self.ok(a)
    }

    fn ok(&self, a: Answer) -> Result<Value, SourceError> {
        let body: Value = serde_json::from_slice(&a.body).map_err(|_| {
            SourceError::failed(
                "arangodb.not_an_api_response",
                format!("the server answered {} without an ArangoDB API response", a.status),
            )
            .with("status", a.status.as_u16())
        })?;
        if !a.status.is_success() || body.get("error").and_then(Value::as_bool) == Some(true) {
            return Err(self.api_error(a.status, &body));
        }
        Ok(body)
    }

    fn api_error(&self, status: StatusCode, body: &Value) -> SourceError {
        let message = body
            .get("errorMessage")
            .and_then(Value::as_str)
            .filter(|m| !m.trim().is_empty())
            .unwrap_or("unknown error")
            .trim();
        let message = self.api.scrub(message);
        let num = body.get("errorNum").and_then(Value::as_i64).unwrap_or(0);
        SourceError::failed("arangodb.error", format!("ArangoDB answered {status} (error {num}): {message}"))
            .with("status", status.as_u16())
            .with("detail", message)
    }

    /// What lets the user write: `database` for `rw` on it, `collection <name>` for `rw` on a
    /// collection. Refuses a user who may write, or whose levels cannot be read, unless the
    /// source allows it; then the list is returned for Test connection.
    async fn checked_writes(&self) -> Result<Vec<String>, SourceError> {
        let found = self.writes().await;
        match found {
            Ok(w) if w.is_empty() => Ok(w),
            Ok(w) if self.allow_write => Ok(w),
            Ok(w) => {
                let list = w.join(", ");
                Err(SourceError::failed(
                    "arangodb.user_can_write",
                    format!("the ArangoDB user may write ({list}); use a user with read-only access (ro)"),
                )
                .with("privileges", list))
            }
            Err(SourceError::Failed(d)) if self.allow_write && d.reason == "arangodb.privileges_unverifiable" => {
                Ok(vec!["unknown".to_string()])
            }
            Err(e) => Err(e),
        }
    }

    async fn writes(&self) -> Result<Vec<String>, SourceError> {
        let unverifiable = || {
            SourceError::failed(
                "arangodb.privileges_unverifiable",
                "cannot read the ArangoDB user's access levels, so Kalzit cannot check that it only reads",
            )
        };
        let Some(user) = &self.user else { return Err(unverifiable()) };
        let mut url = self.url(&["_api", "user", user, "database", ""])?;
        url.set_query(Some("full=true"));
        let a = self.api.call(Method::GET, url, None, MAX_SMALL_RESPONSE, None).await?;
        let body = match self.ok(a) {
            Ok(b) => b,
            Err(SourceError::Failed(d)) if d.reason == "arangodb.error" => return Err(unverifiable()),
            Err(e) => return Err(e),
        };
        writes_from(&body, &self.database).ok_or_else(unverifiable)
    }

    async fn version(&self) -> Result<(String, String), SourceError> {
        let v = self.json(Method::GET, &["_api", "version"], None).await?;
        Ok((
            v.get("version").and_then(Value::as_str).unwrap_or("").to_string(),
            v.get("license").and_then(Value::as_str).unwrap_or("").to_string(),
        ))
    }

    /// ArangoDB parses the query without running it; a write or a user function in its syntax
    /// tree refuses it.
    async fn parse_check(&self, aql: &str) -> Result<(), SourceError> {
        let body = self.json(Method::POST, &["_api", "query"], Some(&json!({ "query": aql }))).await?;
        let ast = body.get("ast").ok_or_else(|| {
            SourceError::failed("arangodb.not_an_api_response", "ArangoDB parsed the query without a syntax tree")
                .with("status", 200)
        })?;
        match refused_in(ast, 0) {
            Some(d) => Err(SourceError::Rejected(d)),
            None => Ok(()),
        }
    }

    /// Runs a reading query and hands every result to `each` until it answers false or the
    /// results end. The cursor is deleted when it is left before its end.
    /// `cursor` within `timeout`. A cursor still open afterwards (left early, at an error or at
    /// the timeout) is deleted, best effort; it would otherwise live until its TTL.
    async fn run(
        &self,
        aql: &str,
        bind: Map<String, Value>,
        timeout: Duration,
        max_bytes: usize,
        charge: Option<&mut Charge>,
        each: impl FnMut(Value) -> bool,
    ) -> Result<(), SourceError> {
        // Outside the timed future, so the id survives its cancellation.
        let live = Mutex::new(None);
        let result = tokio::time::timeout(timeout, self.cursor(aql, bind, timeout, max_bytes, charge, &live, each))
            .await
            .unwrap_or(Err(SourceError::Timeout(timeout.as_secs())));
        let open = live.lock_or_recover().take();
        if let Some(id) = open
            && let Ok(url) = self.url(&["_api", "cursor", &id])
        {
            let delete = self.api.call(Method::DELETE, url, None, MAX_SMALL_RESPONSE, None);
            let _ = tokio::time::timeout(CURSOR_DELETE_TIMEOUT, delete).await;
        }
        result
    }

    /// Runs a reading query and hands every result to `each` until it answers false or the
    /// results end. `live` holds the id of the cursor while it has more results.
    #[expect(clippy::too_many_arguments, reason = "the parts of one cursor, each needed by some caller")]
    async fn cursor(
        &self,
        aql: &str,
        bind: Map<String, Value>,
        timeout: Duration,
        max_bytes: usize,
        mut charge: Option<&mut Charge>,
        live: &Mutex<Option<String>>,
        mut each: impl FnMut(Value) -> bool,
    ) -> Result<(), SourceError> {
        let body = json!({
            "query": aql,
            "bindVars": bind,
            "batchSize": BATCH,
            "count": false,
            "ttl": 60,
            "options": { "maxRuntime": timeout.as_secs_f64(), "stream": true },
        });
        let url = self.url(&["_api", "cursor"])?;
        let mut answer =
            self.ok(self.api.call(Method::POST, url, Some(&body), max_bytes, charge.as_deref_mut()).await?)?;
        loop {
            let more = answer.get("hasMore").and_then(Value::as_bool) == Some(true);
            let id = answer.get("id").and_then(Value::as_str).map(String::from).filter(|_| more);
            *live.lock_or_recover() = id.clone();
            let items = match answer.get_mut("result").map(Value::take) {
                Some(Value::Array(items)) => items,
                _ => Vec::new(),
            };
            drop(answer);
            for item in items {
                if !each(item) {
                    // `run` deletes the cursor when it is still open.
                    return Ok(());
                }
            }
            let Some(id) = id else { return Ok(()) };
            let url = self.url(&["_api", "cursor", &id])?;
            answer = self.ok(self.api.call(Method::POST, url, None, max_bytes, charge.as_deref_mut()).await?)?;
        }
    }
}

/// What lets the user write, from `GET /_api/user/{user}/database/?full=true`; `None` when the
/// answer does not describe the database.
fn writes_from(body: &Value, database: &str) -> Option<Vec<String>> {
    let entry = body.get("result")?.get(database)?;
    let (permission, collections) = match entry {
        Value::String(p) => (p.as_str(), None),
        Value::Object(_) => (entry.get("permission")?.as_str()?, entry.get("collections").and_then(Value::as_object)),
        _ => return None,
    };
    let mut writes = Vec::new();
    if permission == "rw" {
        writes.push("database".to_string());
    }
    match collections {
        Some(c) => {
            for (name, level) in c {
                if level.as_str() == Some("rw") {
                    writes.push(if name == "*" {
                        "every collection".to_string()
                    } else {
                        format!("collection {name}")
                    });
                }
            }
        }
        // Without the collection levels a collection may still be writable.
        None if permission != "rw" => return None,
        None => {}
    }
    Some(writes)
}

/// The first node of an AQL syntax tree that writes or runs user code.
fn refused_in(node: &Value, depth: usize) -> Option<Detail> {
    if depth > 200 {
        return Some(Detail::new("arangodb.syntax", "the query is nested too deeply"));
    }
    match node {
        Value::Array(items) => items.iter().find_map(|n| refused_in(n, depth + 1)),
        Value::Object(m) => {
            if let Some(t) = m.get("type").and_then(Value::as_str)
                && let Some(d) = aql::refused_node(t, m.get("name").and_then(Value::as_str))
            {
                return Some(d);
            }
            m.get("subNodes").and_then(|s| refused_in(s, depth + 1))
        }
        _ => None,
    }
}

/// The bind parameters the query uses: macros (`@__timeFrom`, `@__timeTo` in Unix ms,
/// `@__interval_ms`) and dashboard variables; `@@name` takes a variable that may be an
/// identifier, as a collection name.
fn bind_vars(checked: &aql::Checked, req: &SourceQuery) -> Result<Map<String, Value>, SourceError> {
    let mut out = Map::new();
    for name in &checked.params {
        let value = match name.as_str() {
            "__timeFrom" => json!(req.range.from),
            "__timeTo" => json!(req.range.to),
            "__interval_ms" => json!(req.interval_ms),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("arangodb.macro_unknown", format!("unknown macro @{m}")).with("name", m)
                );
            }
            var => req.variables.get(var).cloned().ok_or_else(|| {
                SourceError::rejected("arangodb.variable_missing", format!("variable {var} has no value"))
                    .with("name", var)
            })?,
        };
        out.insert(name.clone(), value);
    }
    for name in &checked.collections {
        let allowed = !name.starts_with("__") && req.identifier_variables.as_ref().is_none_or(|c| c.contains(name));
        let value = req.variables.get(name).and_then(Value::as_str).filter(|v| is_name(v));
        match value {
            Some(v) if allowed => {
                out.insert(format!("@{name}"), json!(v));
            }
            _ => {
                return Err(SourceError::rejected(
                    "arangodb.variable_identifier",
                    format!(
                        "@@{name} names a collection; only a constant or custom variable whose value is a collection name may"
                    ),
                )
                .with("name", name));
            }
        }
    }
    Ok(out)
}

// ---- results ----

fn is_document(v: &Value) -> bool {
    v.get("_id").and_then(Value::as_str).is_some_and(|id| id.contains('/')) && v.get("_key").is_some()
}

fn is_edge(v: &Value) -> bool {
    is_document(v) && v.get("_from").and_then(Value::as_str).is_some() && v.get("_to").and_then(Value::as_str).is_some()
}

fn is_path(v: &Value) -> bool {
    let all_docs =
        |k: &str| v.get(k).and_then(Value::as_array).is_some_and(|a| a.iter().all(|x| x.is_null() || is_document(x)));
    v.is_object() && all_docs("vertices") && all_docs("edges")
}

/// Whether a value holds an edge or a path, which makes the result a graph.
fn has_graph(v: &Value, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    if is_edge(v) || is_path(v) {
        return true;
    }
    if is_document(v) {
        return false;
    }
    match v {
        Value::Array(a) => a.iter().any(|x| has_graph(x, depth + 1)),
        Value::Object(m) => m.values().any(|x| has_graph(x, depth + 1)),
        _ => false,
    }
}

fn collection_of(id: &str) -> String {
    id.split_once('/').map_or(id, |(c, _)| c).to_string()
}

fn properties(v: &Value, skip: &[&str]) -> BTreeMap<String, Value> {
    v.as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, _)| !skip.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), json_api::safe_numbers(v.clone())))
                .collect()
        })
        .unwrap_or_default()
}

fn node_of(v: &Value) -> Node {
    let id = v["_id"].as_str().unwrap_or_default().to_string();
    Node { labels: vec![collection_of(&id)], properties: properties(v, &["_id", "_rev"]), id }
}

fn edge_of(v: &Value) -> (Edge, String, String) {
    let id = v["_id"].as_str().unwrap_or_default().to_string();
    let from = v["_from"].as_str().unwrap_or_default().to_string();
    let to = v["_to"].as_str().unwrap_or_default().to_string();
    let (fl, tl) = (collection_of(&from), collection_of(&to));
    let edge = Edge {
        edge_type: collection_of(&id),
        properties: properties(v, &["_id", "_rev", "_from", "_to"]),
        id,
        from,
        to,
    };
    (edge, fl, tl)
}

/// Adds the documents, edges and paths in `v` to the graph; values that are neither are named in
/// `omitted` (the key they were under, or `value`). False when a limit was reached.
fn add_graph(g: &mut GraphBuilder, v: &Value, key: &str, omitted: &mut BTreeSet<String>, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        omitted.insert(key.to_string());
        return true;
    }
    if is_edge(v) {
        let (e, fl, tl) = edge_of(v);
        return g.add_edge(e, &[fl], &[tl]);
    }
    if is_document(v) {
        return g.add_node(node_of(v));
    }
    if is_path(v) {
        let docs = |k: &str| v[k].as_array().cloned().unwrap_or_default();
        let (vertices, edges) = (docs("vertices"), docs("edges"));
        for n in vertices.iter().filter(|n| !n.is_null()) {
            if !g.add_node(node_of(n)) {
                return false;
            }
        }
        for e in edges.iter().filter(|e| !e.is_null()) {
            let (e, fl, tl) = edge_of(e);
            if !g.add_edge(e, &[fl], &[tl]) {
                return false;
            }
        }
        let ids = |a: &[Value]| a.iter().filter_map(|x| x.get("_id")?.as_str().map(String::from)).collect();
        return g.add_path(GraphPath::new(ids(&vertices), ids(&edges)));
    }
    match v {
        Value::Array(a) => a.iter().all(|x| add_graph(g, x, key, omitted, depth + 1)),
        Value::Object(m) => m.iter().all(|(k, x)| add_graph(g, x, k, omitted, depth + 1)),
        Value::Null => true,
        _ => {
            omitted.insert(key.to_string());
            true
        }
    }
}

fn to_result(items: Vec<Value>, cut: bool, req: &SourceQuery, settings: &Value, executed: &str) -> QueryResult {
    if items.iter().any(|v| has_graph(v, 0)) {
        let limits = GraphLimits::from_settings(settings, req.limits.max_rows, req.limits.budget.clone());
        let mut g = GraphBuilder::new(limits);
        let mut omitted = BTreeSet::new();
        for item in &items {
            if !add_graph(&mut g, item, "value", &mut omitted, 0) {
                break;
            }
        }
        if cut && !g.is_full() {
            g.cut_at_rows(items.len());
        }
        if !omitted.is_empty() {
            let list = omitted.into_iter().collect::<Vec<_>>().join(", ");
            g.notice(
                NoticeSeverity::Info,
                Detail::new(
                    "graph.columns_omitted",
                    format!("{list} hold no vertices or edges and are not part of the graph; return them in another query for documents"),
                )
                .with("columns", list),
            );
        }
        return QueryResult::Graph { graph: g.finish() };
    }
    let mut docs = DocumentsBuilder::new(req.limits.max_rows, req.limits.budget.clone());
    docs.executed_query(executed);
    for item in items {
        if !docs.push(json_api::as_document(json_api::safe_numbers(item))) {
            break;
        }
    }
    if cut {
        docs.mark_limit(req.limits.max_rows);
    }
    QueryResult::Documents { documents: docs.finish() }
}

#[async_trait::async_trait]
impl DataSourcePlugin for ArangoDb {
    fn kind(&self) -> &'static str {
        "arangodb"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Graph, Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        json_api::parse_base_url(&s.url).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if !is_name(s.database()) {
            return Err(FieldError::new("database", "settings.name_invalid", "the database name may not contain /"));
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        for (field, value) in [("maxNodes", s.max_nodes), ("maxEdges", s.max_edges)] {
            if value == Some(0) {
                return Err(FieldError::new(field, "settings.out_of_range", format!("{field} must be at least 1"))
                    .with("min", 1));
            }
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let (version, license) = c.version().await?;
            // The cached client checked the user when it was built; Test connection checks again.
            let writes = c.checked_writes().await?;
            Ok::<_, SourceError>((version, license, writes))
        };
        match check.await {
            Ok((version, license, writes)) => {
                let mut h = if writes.is_empty() {
                    Health::connected("ArangoDB", &version, false)
                } else {
                    let list = writes.join(", ");
                    Health {
                        ok: true,
                        code: None,
                        detail: Detail::new(
                            "health.connected_write_capable",
                            format!(
                                "ArangoDB {version}; the user may write ({list}), so only Kalzit's query checks keep queries read-only"
                            ),
                        )
                        .with("engine", "ArangoDB")
                        .with("version", &version)
                        .with("privileges", &list),
                        warnings: Vec::new(),
                    }
                };
                if !license.is_empty() {
                    h.detail = h.detail.with("edition", license);
                }
                h
            }
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let mut url = c.url(&["_api", "collection"])?;
        url.set_query(Some("excludeSystem=true"));
        let body = c.ok(c.api.call(Method::GET, url, None, MAX_SMALL_RESPONSE, None).await?)?;
        let mut labels = Vec::new();
        let mut edge_types = Vec::new();
        for col in body.get("result").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            let Some(name) = col.get("name").and_then(Value::as_str) else { continue };
            if name.starts_with('_') {
                continue;
            }
            match col.get("type").and_then(Value::as_i64) {
                Some(3) => edge_types.push(name.to_string()),
                _ => labels.push(name.to_string()),
            }
        }
        labels.sort();
        edge_types.sort();
        labels.truncate(MAX_SCHEMA_NAMES);
        edge_types.truncate(MAX_SCHEMA_NAMES);
        let mut keys = BTreeSet::new();
        for name in labels.iter().chain(&edge_types).take(SAMPLED_COLLECTIONS) {
            let mut bind = Map::new();
            bind.insert("@c".into(), json!(name));
            // A sample of a collection that cannot be read leaves its keys out.
            let _ = c
                .run(
                    "FOR d IN @@c LIMIT 20 RETURN ATTRIBUTES(d, true)",
                    bind,
                    SAMPLE_TIMEOUT,
                    MAX_SMALL_RESPONSE,
                    None,
                    |attrs| {
                        for k in attrs.as_array().map(Vec::as_slice).unwrap_or_default() {
                            if let Some(k) = k.as_str().filter(|k| !matches!(*k, "_from" | "_to")) {
                                keys.insert(k.to_string());
                            }
                        }
                        keys.len() < MAX_SCHEMA_NAMES
                    },
                )
                .await;
        }
        Ok(SourceSchema::Graph {
            labels,
            edge_types,
            property_keys: keys.into_iter().collect(),
            queries: Vec::new(),
            query_params: BTreeMap::new(),
        })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: AqlQuery = req.parse()?;
        let checked = aql::check(&q.aql).map_err(SourceError::Rejected)?;
        let bind = bind_vars(&checked, &req)?;
        let c = client(conn).await?;
        c.parse_check(&q.aql).await?;
        let max_rows = req.limits.max_rows.max(1);
        let mut charge = req.limits.budget.charge();
        let mut items = Vec::new();
        let mut cut = false;
        c.run(&q.aql, bind, req.limits.timeout, req.limits.budget.remaining(), Some(&mut charge), |item| {
            if items.len() >= max_rows {
                cut = true;
                return false;
            }
            items.push(item);
            true
        })
        .await?;
        let result = to_result(items, cut, &req, conn.settings(), &q.aql);
        // The raw answers are gone; only the result's own charge remains.
        drop(charge);
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
