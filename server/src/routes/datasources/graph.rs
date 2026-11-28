//! The graph routes of a data source (docs/api/datasources.md): its schema as a graph, query
//! plans, and patterns compiled into the source's language and read back. Each needs
//! `datasources:query` on the source (role or grant), as its schema and free queries do: a plan
//! is a free query (`PROFILE` runs it), and a pattern is one once it runs. Running a saved search
//! template needs only the right to read it (`routes/analyses.rs`).

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use super::{DsPath, resource};
use crate::app::AppState;
use crate::authz::{OrgCtx, Permission};
use crate::datasources::graph_schema::GraphSourceSchema;
use crate::datasources::pattern::{self, Compiled, Dialect, Parsed, Pattern};
use crate::datasources::plan::{PlanMode, QueryPlan};
use crate::datasources::{Datasource, Detail};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::routes::support::QueryParams;
use crate::shapes::TimeRange;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SchemaParams {
    /// Reads the source again instead of the schema kept for a few minutes.
    #[serde(default)]
    refresh: bool,
}

pub(super) async fn graph_schema(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
    QueryParams(params): QueryParams<SchemaParams>,
) -> ApiResult<Json<GraphSourceSchema>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    let schema = crate::datasources::read_graph_schema(&state, &ctx.user.id, &ds, params.refresh).await?;
    Ok(Json((*schema).clone()))
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    /// The query in the source's own form (`{"cypher": ...}` or `{"pattern": ...}`).
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub query: Value,
    pub mode: PlanMode,
    /// For the time macros; the last hour when left out.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub time_range: Option<TimeRange>,
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>", optional))]
    pub variables: BTreeMap<String, Value>,
}

pub(super) async fn plan(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
    JsonBody(req): JsonBody<PlanRequest>,
) -> ApiResult<Json<QueryPlan>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    let limits = crate::datasources::pattern_limits(&state, &ds).await?;
    let lists = pattern::list_parameters(&req.query);
    crate::routes::query::check_variables_with(&req.variables, &lists, limits.max_values)?;
    let range = match req.time_range {
        Some(r) => r,
        None => {
            let now = state.clock.now_ms();
            TimeRange { from: now - 3_600_000, to: now }
        }
    };
    crate::datasources::check_range(range)?;
    let plan =
        crate::datasources::run_plan(&state, &ctx.user.id, &ds, req.query, req.mode, range, req.variables).await?;
    Ok(Json(plan))
}

/// The pattern language of a source: its kind, and TigerGraph's graph from its settings.
pub(crate) fn dialect(ds: &Datasource) -> ApiResult<(Dialect, Option<String>)> {
    match ds.kind.as_str() {
        "neo4j" => Ok((Dialect::Neo4j, None)),
        "memgraph" => Ok((Dialect::Memgraph, None)),
        "tigergraph" => Ok((Dialect::TigerGraph, ds.settings.get("graph").and_then(Value::as_str).map(String::from))),
        other => Err(ApiError::validation(format!("a {other} source takes no graph patterns"))
            .because("pattern.unsupported_source")
            .param("kind", other)),
    }
}

fn pattern_error(d: Detail) -> ApiError {
    ApiError::validation(d.message).with_field("pattern").with_reason(d.reason, d.params)
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompilePatternRequest {
    pub pattern: Pattern,
    /// Values of the template parameters; a parameter without one is left out of the answer's
    /// values and named in its query text.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>", optional))]
    pub variables: BTreeMap<String, Value>,
}

/// The query a pattern runs as on this source, with its parameter values: shown next to the
/// builder, always. Parameters without a value are refused only when the pattern runs.
pub(super) async fn compile_pattern(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
    JsonBody(req): JsonBody<CompilePatternRequest>,
) -> ApiResult<Json<Compiled>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    let (dialect, graph) = dialect(&ds)?;
    // A parameter without a value compiles with a stand-in of its type and is left out of the
    // values; the text names it either way.
    let given: Vec<String> = req.variables.keys().cloned().collect();
    let mut variables = req.variables;
    for p in &req.pattern.parameters {
        variables.entry(p.name.clone()).or_insert_with(|| placeholder(p.ty));
    }
    let limits = crate::datasources::pattern_limits(&state, &ds).await?;
    let mut compiled =
        pattern::compile(&req.pattern, dialect, graph.as_deref(), &variables, &limits).map_err(pattern_error)?;
    compiled.parameters.retain(|name, _| name.starts_with(pattern::RESERVED_PREFIX) || given.contains(name));
    compiled.lists.retain(|r| given.contains(&r.name));
    Ok(Json(compiled))
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CountRequest {
    /// The label whose nodes to count, or
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub label: Option<String>,
    /// the edge type whose edges to count.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub edge_type: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CountAnswer {
    pub count: u64,
}

/// "Zählen" in the schema: the exact count of one label or edge type, for sources whose schema
/// has no count for it. A counting pattern (`pattern::count_pattern`), run as any query.
pub(super) async fn count(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
    JsonBody(req): JsonBody<CountRequest>,
) -> ApiResult<Json<CountAnswer>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    dialect(&ds)?;
    let counted = match (req.label.as_deref(), req.edge_type.as_deref()) {
        (Some(l), None) => pattern::count_pattern(Some(l), None),
        (None, Some(t)) => pattern::count_pattern(None, Some(t)),
        _ => {
            return Err(ApiError::validation("name either a label or an edge type").with_field("label"));
        }
    };
    counted.check().map_err(pattern_error)?;
    let query = serde_json::json!({ "pattern": counted });
    let result = run_one(&state, &ctx, &ds, query, BTreeMap::new()).await?;
    let count = first_values(&result).into_iter().find_map(|v| match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    });
    Ok(Json(CountAnswer { count: count.unwrap_or(0) }))
}

/// Runs one query of `ds` as `ctx`, already authorized, and answers its result or its error.
pub(crate) async fn run_one(
    state: &AppState,
    ctx: &OrgCtx,
    ds: &Datasource,
    query: Value,
    variables: BTreeMap<String, Value>,
) -> ApiResult<crate::shapes::QueryResult> {
    use crate::shapes::{QueryItem, QueryOutcome};
    let item = QueryItem {
        ref_id: "A".into(),
        datasource_id: ds.id.clone(),
        query,
        cursor: None,
        limit: None,
        steps: Vec::new(),
        filters: Vec::new(),
    };
    let now = state.clock.now_ms();
    let range = TimeRange { from: now - 3_600_000, to: now };
    let cache = crate::datasources::cache::CacheUse::off();
    let mut response =
        crate::datasources::run_queries_cached(state, ctx, vec![item], range, None, None, &variables, None, &cache)
            .await;
    match response.results.remove("A") {
        Some(QueryOutcome::Ok { result, .. }) => Ok(result),
        Some(QueryOutcome::Err { error }) => {
            use axum::http::StatusCode as S;
            let (status, code) = match error.code.as_str() {
                "query_rejected" => (S::UNPROCESSABLE_ENTITY, "query_rejected"),
                "datasource_target_blocked" => (S::UNPROCESSABLE_ENTITY, "datasource_target_blocked"),
                "query_timeout" => (S::GATEWAY_TIMEOUT, "query_timeout"),
                "not_found" => (S::NOT_FOUND, "not_found"),
                "forbidden" => (S::FORBIDDEN, "forbidden"),
                "validation" => (S::UNPROCESSABLE_ENTITY, "validation"),
                _ => (S::BAD_GATEWAY, "datasource_error"),
            };
            let mut e = ApiError::new(status, code, error.message);
            if let Some(reason) = error.reason {
                e = e.with_reason_string(reason, error.params.unwrap_or_default());
            }
            Err(e)
        }
        None => Err(ApiError::internal("graph", "the query gave no answer")),
    }
}

/// The scalar values of a result's first column (a frame), lists in it flattened.
pub(crate) fn first_values(result: &crate::shapes::QueryResult) -> Vec<Value> {
    let crate::shapes::QueryResult::Frame { frame } = result else { return Vec::new() };
    let Some(field) = frame.fields().first() else { return Vec::new() };
    let mut out = Vec::new();
    for v in &field.values {
        match v {
            Value::Array(items) => out.extend(items.iter().cloned()),
            other => out.push(other.clone()),
        }
    }
    out
}

/// A value of the right type for a parameter that has none yet.
fn placeholder(ty: pattern::ParameterType) -> Value {
    use pattern::ParameterType as T;
    match ty {
        T::String => Value::String(String::new()),
        T::Integer => Value::from(0),
        T::Float => Value::from(0.0),
        T::Boolean => Value::Bool(false),
        T::StringList | T::IntegerList | T::FloatList | T::IdList => Value::Array(Vec::new()),
    }
}

#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsePatternRequest {
    /// Cypher (Neo4j, Memgraph) or GSQL (TigerGraph).
    pub text: String,
    /// The values a compiled pattern came with: `kz_v...` parameters with a value read back as
    /// those literals.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, unknown>", optional))]
    pub parameters: BTreeMap<String, Value>,
}

/// The longest query text the way back reads.
const MAX_TEXT: usize = 100_000;

/// The way back into the builder: a pattern, or `representable: false` with the reason; never a
/// pattern that leaves part of the query out.
pub(super) async fn parse_pattern(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
    JsonBody(req): JsonBody<ParsePatternRequest>,
) -> ApiResult<Json<Parsed>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    let (dialect, _) = dialect(&ds)?;
    if req.text.len() > MAX_TEXT {
        return Err(ApiError::validation(format!("the text is longer than {MAX_TEXT} bytes"))
            .with_field("text")
            .because("pattern.too_large")
            .param("bytes", MAX_TEXT));
    }
    Ok(Json(pattern::parse(&req.text, dialect, &req.parameters)))
}
