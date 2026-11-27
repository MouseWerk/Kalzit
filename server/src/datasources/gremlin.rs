//! Apache TinkerPop Gremlin Server 3.7+ over WebSocket (`gremlin/wire.rs`), and the graph
//! databases that speak its protocol. Queries are Gremlin traversals (`{"gremlin": "g.V()..."}`),
//! which Kalzit parses and checks itself (`gremlin/traversal.rs`) and sends as bytecode, never as
//! a script: Gremlin Server then evaluates no Groovy at all. Dashboard variables and macros
//! (`__timeFrom`, `__timeTo` in Unix ms, `__interval_ms`) are names in the traversal whose values
//! go into the bytecode as values.
//!
//! Two things keep a source read-only, independent of each other:
//!
//! 1. Kalzit's check: only reading steps, also inside anonymous traversals; `addV`, `addE`,
//!    `property`, `drop`, `mergeV`, `mergeE`, `io`, `call`, `sideEffect`, lambdas and source steps
//!    are refused before anything is sent.
//! 2. Every traversal is sent under `ReadOnlyStrategy`, so Gremlin Server refuses a mutating step
//!    itself.
//!
//! Gremlin Server has no read-only users of its own; where a provider has them, the docs advise
//! one.
//!
//! Results: vertices, edges and paths of them make a `graph` (a node's id is the vertex id as
//! text, its label the vertex label); any other result is `documents` (maps as objects, other
//! values as `{"value": ...}`). Each connection serves one request and is closed afterwards.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Url;
use serde::Deserialize;
use serde_json::{Value, json};

use super::frame::{Charge, ResponseBudget};
use super::graph::{GraphBuilder, GraphLimits};
use super::json_documents::DocumentsBuilder;
use super::{
    Connection, DataSourcePlugin, DefaultValue, Detail, FieldError, Health, Kind, SettingField, SettingType,
    SourceError, SourceQuery, SourceSchema,
};
use crate::shapes::{Edge, GraphPath, Node, NoticeSeverity, QueryResult, Shape};

pub mod graphson;
pub mod traversal;
pub mod wire;

use graphson::Gv;
use traversal::Arg;

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.gremlinUrl", SettingType::String).target().required(),
    SettingField::new("traversalSource", "datasources.settings.traversalSource", SettingType::String)
        .target()
        .default(DefaultValue::Text("g")),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    SettingField::new("maxNodes", "datasources.settings.maxNodes", SettingType::Number),
    SettingField::new("maxEdges", "datasources.settings.maxEdges", SettingType::Number),
];

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const SCHEMA_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_SCHEMA_NAMES: usize = 10_000;
/// Results a schema traversal reads at most, repeated ones included.
const MAX_SCHEMA_ITEMS: usize = 100_000;
/// The budget of Kalzit's own traversals (health, schema).
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Elements of each kind whose properties are fetched when the server sent them without.
const MAX_REFETCH: usize = 10_000;
/// Element ids asked for per `elementMap()` traversal.
const REFETCH_BATCH: usize = 500;
/// The largest bulk of one traverser that is unfolded; a larger one counts as this many.
const MAX_BULK: u64 = 10_000;
/// Results Gremlin Server sends per part.
const BATCH: u64 = 256;

pub fn kind() -> Kind {
    Kind { name: "Gremlin", hint_key: "datasources.kinds.gremlin.hint", settings: SETTINGS, plugin: Arc::new(Gremlin) }
}

pub struct Gremlin;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    traversal_source: Option<String>,
    user: Option<String>,
    ca_cert: Option<String>,
    max_nodes: Option<u64>,
    max_edges: Option<u64>,
}

impl Settings {
    fn source(&self) -> &str {
        self.traversal_source.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("g")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GremlinQuery {
    gremlin: String,
}

/// `ws(s)://host[:port][/path]`, without credentials, query or fragment.
fn parse_url(raw: &str) -> Result<Url, Detail> {
    let url = Url::parse(raw.trim())
        .map_err(|e| Detail::new("settings.url_invalid", format!("the URL is not valid: {e}")).with("detail", e))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Err(Detail::new("gremlin.url_scheme", "the URL must start with ws:// or wss://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Detail::new("settings.url_credentials", "the URL must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Detail::new("settings.url_query", "the URL must not contain a query or fragment"));
    }
    if url.host_str().is_none() {
        return Err(Detail::new("settings.url_no_host", "the URL needs a host"));
    }
    Ok(url)
}

fn is_source_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The items of one answer part (`result.data`), taken out of it, not copied.
fn items_of(data: Value) -> Vec<Value> {
    match data {
        // A typed list (`g:List`, `g:BulkSet` of traversers): its items.
        Value::Object(mut m) if matches!(m.get("@value"), Some(Value::Array(_))) => match m.remove("@value") {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        },
        Value::Array(a) => a,
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

/// How often a traverser's value is handed on: its bulk, at least 1 and at most `MAX_BULK`.
fn bulk_of(item: &Value) -> u64 {
    match item.get("@type").and_then(Value::as_str) {
        Some("g:Traverser") => item
            .pointer("/@value/bulk")
            .map(|b| graphson::id_text(b).parse::<u64>().unwrap_or(1))
            .unwrap_or(1)
            .clamp(1, MAX_BULK),
        _ => 1,
    }
}

/// Runs one checked traversal on a fresh connection and hands every result (with its bulk
/// unfolded, at most `max_items` in all) to `each` until it answers false. Every message is
/// charged to `charge` before it is parsed, and none may be larger than the budget left.
async fn run(
    conn: &Connection,
    steps: &[traversal::Step],
    timeout: Duration,
    max_items: usize,
    charge: &mut Charge,
    max_message: usize,
    mut each: impl FnMut(Gv) -> bool,
) -> Result<wire::Ended, SourceError> {
    let s: Settings = conn.settings_as()?;
    let url = parse_url(&s.url).map_err(SourceError::Failed)?;
    let target =
        wire::Target { url: &url, ca_pem: s.ca_cert.as_deref(), timeout: CONNECT_TIMEOUT.min(timeout), max_message };
    let work = async {
        let mut w = wire::Wire::connect(conn.policy(), target).await?;
        let args = json!({
            "gremlin": traversal::bytecode(steps),
            "aliases": { "g": s.source() },
            "evaluationTimeout": timeout.as_millis() as u64,
            "batchSize": BATCH,
        });
        let login = s.user.as_deref().filter(|u| !u.is_empty()).map(|u| (u, conn.secret("password").unwrap_or("")));
        let scrub = |t: &str| conn.scrub(t);
        let mut admit = |n: usize| charge.add(n);
        let mut handed = 0usize;
        let result = w
            .request("traversal", "bytecode", args, login, &scrub, &mut admit, |data| {
                for item in items_of(data) {
                    let bulk = bulk_of(&item);
                    let value = graphson::decode(&item, 0);
                    for _ in 0..bulk {
                        if handed >= max_items || !each(value.clone()) {
                            return false;
                        }
                        handed += 1;
                    }
                }
                true
            })
            .await;
        w.close().await;
        result
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(r) => r,
        Err(_) => Err(SourceError::Timeout(timeout.as_secs())),
    }
}

/// The values of the variables and macros a traversal names.
fn variables(names: &BTreeSet<String>, req: &SourceQuery) -> Result<BTreeMap<String, Arg>, SourceError> {
    let mut out = BTreeMap::new();
    for name in names {
        let value = match name.as_str() {
            "__timeFrom" => Arg::Int(req.range.from),
            "__timeTo" => Arg::Int(req.range.to),
            "__interval_ms" => Arg::Int(req.interval_ms as i64),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("gremlin.macro_unknown", format!("unknown macro {m}")).with("name", m)
                );
            }
            var => {
                let v = req.variables.get(var).ok_or_else(|| {
                    SourceError::rejected("gremlin.variable_missing", format!("{var} has no value")).with("name", var)
                })?;
                traversal::value_arg(v).ok_or_else(|| {
                    SourceError::rejected(
                        "gremlin.variable_type",
                        format!("variable {var} must be a string, number, boolean or a list of them"),
                    )
                    .with("name", var)
                })?
            }
        };
        out.insert(name.clone(), value);
    }
    Ok(out)
}

// ---- results ----

fn add(g: &mut GraphBuilder, v: &Gv, omitted: &mut BTreeSet<String>, key: &str, depth: usize) -> bool {
    if depth > 32 {
        return true;
    }
    match v {
        Gv::Vertex { id, label, properties, .. } => {
            g.add_node(Node { id: id.clone(), labels: vec![label.clone()], properties: properties.clone() })
        }
        Gv::Edge { id, label, out_v, out_label, in_v, in_label, properties, .. } => g.add_edge(
            Edge {
                id: id.clone(),
                edge_type: label.clone(),
                from: out_v.clone(),
                to: in_v.clone(),
                properties: properties.clone(),
            },
            std::slice::from_ref(out_label),
            std::slice::from_ref(in_label),
        ),
        Gv::Path(objects) if graphson::has_elements(v, 0) => {
            let mut path = GraphPath::new(Vec::new(), Vec::new());
            for o in objects {
                match o {
                    Gv::Vertex { id, .. } => path.nodes.push(id.clone()),
                    Gv::Edge { id, .. } => path.edges.push(id.clone()),
                    _ => {}
                }
                if !add(g, o, omitted, key, depth + 1) {
                    return false;
                }
            }
            g.add_path(path)
        }
        Gv::List(items) | Gv::Path(items) => items.iter().all(|i| add(g, i, omitted, key, depth + 1)),
        Gv::Map(pairs) => pairs.iter().all(|(k, x)| add(g, x, omitted, &graphson::key_text(k), depth + 1)),
        Gv::Plain(Value::Null) => true,
        Gv::Plain(_) => {
            omitted.insert(key.to_string());
            true
        }
    }
}

fn to_result(items: Vec<Gv>, cut: Cut, req: &SourceQuery, settings: &Value, executed: &str) -> QueryResult {
    if items.iter().any(|i| graphson::has_elements(i, 0)) {
        let limits = GraphLimits::from_settings(settings, req.limits.max_rows, req.limits.budget.clone());
        let mut g = GraphBuilder::new(limits);
        let mut omitted = BTreeSet::new();
        for item in &items {
            if !add(&mut g, item, &mut omitted, "value", 0) {
                break;
            }
        }
        if cut != Cut::None && !g.is_full() {
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
    for item in &items {
        let value = match item {
            Gv::Map(_) => graphson::to_plain(item),
            other => json!({ "value": graphson::to_plain(other) }),
        };
        if !docs.push(value) {
            break;
        }
    }
    match cut {
        Cut::Rows => docs.mark_limit(req.limits.max_rows),
        Cut::Size => docs.mark_truncated(),
        Cut::None => {}
    }
    QueryResult::Documents { documents: docs.finish() }
}

/// An id's text as `graphson::id_text` writes it, from a plain value.
fn plain_id_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Object(m) if m.get("$type").is_some() => {
            m.get("value").and_then(Value::as_str).unwrap_or("").to_string()
        }
        other => other.to_string(),
    }
}

/// The elements of a result that came without properties, as (text id, id as sent), each once:
/// vertices and edges apart.
type Bare = (Vec<(String, Value)>, Vec<(String, Value)>);

fn bare_elements(items: &[Gv]) -> Bare {
    fn walk(g: &Gv, out: &mut Bare, seen: &mut BTreeSet<(bool, String)>, depth: usize) {
        if depth > 32 {
            return;
        }
        match g {
            Gv::Vertex { id, raw_id, properties, .. } if properties.is_empty() => {
                if out.0.len() < MAX_REFETCH && seen.insert((true, id.clone())) {
                    out.0.push((id.clone(), raw_id.clone()));
                }
            }
            Gv::Edge { id, raw_id, properties, .. } if properties.is_empty() => {
                if out.1.len() < MAX_REFETCH && seen.insert((false, id.clone())) {
                    out.1.push((id.clone(), raw_id.clone()));
                }
            }
            Gv::List(items) | Gv::Path(items) => items.iter().for_each(|i| walk(i, out, seen, depth + 1)),
            Gv::Map(pairs) => pairs.iter().for_each(|(_, v)| walk(v, out, seen, depth + 1)),
            _ => {}
        }
    }
    let mut out = (Vec::new(), Vec::new());
    let mut seen = BTreeSet::new();
    items.iter().for_each(|i| walk(i, &mut out, &mut seen, 0));
    out
}

/// Puts the fetched properties into the elements that came without them.
fn fill_properties(g: &mut Gv, vertices: &Props, edges: &Props, depth: usize) {
    if depth > 32 {
        return;
    }
    match g {
        Gv::Vertex { id, properties, .. } if properties.is_empty() => {
            if let Some(p) = vertices.get(id.as_str()) {
                properties.clone_from(p);
            }
        }
        Gv::Edge { id, properties, .. } if properties.is_empty() => {
            if let Some(p) = edges.get(id.as_str()) {
                properties.clone_from(p);
            }
        }
        Gv::List(items) | Gv::Path(items) => {
            items.iter_mut().for_each(|i| fill_properties(i, vertices, edges, depth + 1))
        }
        Gv::Map(pairs) => pairs.iter_mut().for_each(|(_, v)| fill_properties(v, vertices, edges, depth + 1)),
        _ => {}
    }
}

type Props = std::collections::HashMap<String, BTreeMap<String, Value>>;

/// The properties of the elements `ids` (`V` or `E`), read with `elementMap()`: a map, so
/// servers that send elements only as references (id and label, `ReferenceElementStrategy`)
/// answer them too.
async fn element_properties(
    conn: &Connection,
    start: &str,
    ids: &[(String, Value)],
    timeout: Duration,
    budget: &ResponseBudget,
) -> Result<Props, SourceError> {
    let mut out = Props::new();
    for chunk in ids.chunks(REFETCH_BATCH) {
        let steps = vec![
            traversal::Step { name: start.into(), args: chunk.iter().map(|(_, raw)| Arg::Raw(raw.clone())).collect() },
            traversal::Step { name: "elementMap".into(), args: Vec::new() },
        ];
        let mut charge = budget.charge();
        run(conn, &steps, timeout, chunk.len(), &mut charge, budget.remaining(), |v| {
            if let Gv::Map(pairs) = v {
                let mut id = None;
                let mut props = BTreeMap::new();
                for (k, value) in pairs {
                    match graphson::key_text(&k).as_str() {
                        "id" => id = Some(plain_id_text(&graphson::to_plain(&value))),
                        // The token keys of an edge's ends and the label are no properties.
                        "label" | "IN" | "OUT" => {}
                        key => {
                            props.insert(key.to_string(), graphson::to_plain(&value));
                        }
                    }
                }
                if let Some(id) = id {
                    out.insert(id, props);
                }
            }
            true
        })
        .await?;
    }
    Ok(out)
}

/// Fills in the properties of elements the server sent without them, best effort: a server
/// that cannot answer `elementMap()` leaves them as they came.
async fn complete_properties(conn: &Connection, items: &mut [Gv], req: &SourceQuery) {
    let (vertices, edges) = bare_elements(items);
    if vertices.is_empty() && edges.is_empty() {
        return;
    }
    let budget = &req.limits.budget;
    let v = if vertices.is_empty() {
        Props::new()
    } else {
        element_properties(conn, "V", &vertices, req.limits.timeout, budget).await.unwrap_or_default()
    };
    let e = if edges.is_empty() {
        Props::new()
    } else {
        element_properties(conn, "E", &edges, req.limits.timeout, budget).await.unwrap_or_default()
    };
    items.iter_mut().for_each(|i| fill_properties(i, &v, &e, 0));
}

/// Where a result was cut.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cut {
    None,
    /// At the row limit.
    Rows,
    /// At the response size limit.
    Size,
}

/// Runs a traversal of Kalzit's own (health, schema) within a small budget of its own.
async fn run_small(
    conn: &Connection,
    text: &str,
    max_items: usize,
    each: impl FnMut(Gv) -> bool,
) -> Result<wire::Ended, SourceError> {
    let t = traversal::parse(text).map_err(SourceError::Rejected)?;
    let budget = ResponseBudget::new(MAX_SMALL_RESPONSE);
    let mut charge = budget.charge();
    run(conn, &t.steps, SCHEMA_TIMEOUT, max_items, &mut charge, MAX_SMALL_RESPONSE, each).await
}

/// The names one schema traversal answers, as text; at most `MAX_SCHEMA_ITEMS` results are
/// read, repeated ones included.
async fn names(conn: &Connection, text: &str) -> Result<Vec<String>, SourceError> {
    let mut out = BTreeSet::new();
    run_small(conn, text, MAX_SCHEMA_ITEMS, |v| {
        if let Gv::Plain(Value::String(s)) = v {
            out.insert(s);
        }
        out.len() < MAX_SCHEMA_NAMES
    })
    .await?;
    Ok(out.into_iter().collect())
}

#[async_trait::async_trait]
impl DataSourcePlugin for Gremlin {
    fn kind(&self) -> &'static str {
        "gremlin"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Graph, Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if !is_source_name(s.source()) {
            return Err(FieldError::new(
                "traversalSource",
                "settings.name_invalid",
                "the traversal source has letters, digits and _ only",
            ));
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
            let mut answered = false;
            run_small(conn, "g.inject(1)", 1, |_| {
                answered = true;
                false
            })
            .await?;
            if !answered {
                return Err(SourceError::failed(
                    "gremlin.not_an_api_response",
                    "Gremlin Server answered without a result",
                ));
            }
            Ok::<_, SourceError>(())
        };
        match check.await {
            Ok(()) => Health::connected("Gremlin Server", "", false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let labels = names(conn, "g.V().label().dedup().limit(10000)").await?;
        let edge_types = names(conn, "g.E().label().dedup().limit(10000)").await?;
        let mut keys = names(conn, "g.V().limit(1000).properties().key().dedup().limit(10000)").await?;
        keys.extend(names(conn, "g.E().limit(1000).properties().key().dedup().limit(10000)").await?);
        keys.sort();
        keys.dedup();
        Ok(SourceSchema::Graph {
            labels,
            edge_types,
            property_keys: keys,
            queries: Vec::new(),
            query_params: BTreeMap::new(),
        })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: GremlinQuery = req.parse()?;
        let t = traversal::parse(&q.gremlin).map_err(SourceError::Rejected)?;
        let vars = variables(&t.variables, &req)?;
        let steps = traversal::bind_steps(&t.steps, &vars).map_err(SourceError::Rejected)?;
        let max_rows = req.limits.max_rows.max(1);
        // The raw messages are charged before they are parsed, the decoded results while they
        // are held.
        let mut raw = req.limits.budget.charge();
        let mut held = req.limits.budget.charge();
        let mut items = Vec::new();
        let mut cut = Cut::None;
        let max_message = req.limits.budget.remaining();
        let ended = run(conn, &steps, req.limits.timeout, max_rows + 1, &mut raw, max_message, |v| {
            if items.len() >= max_rows {
                cut = Cut::Rows;
                return false;
            }
            if !held.add(super::frame::value_size(&graphson::to_plain(&v))) {
                cut = Cut::Size;
                return false;
            }
            items.push(v);
            true
        })
        .await?;
        if ended == wire::Ended::SizeLimit {
            cut = Cut::Size;
        }
        drop(raw);
        if cut != Cut::Size {
            complete_properties(conn, &mut items, &req).await;
        }
        let result = to_result(items, cut, &req, conn.settings(), &q.gremlin);
        drop(held);
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
