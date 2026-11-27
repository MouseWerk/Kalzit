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
    #[cfg_attr(test, ts(as = "Option<BTreeMap<String, Value>>", optional))]
    pub variables: BTreeMap<String, Value>,
}

pub(super) async fn plan(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
    JsonBody(req): JsonBody<PlanRequest>,
) -> ApiResult<Json<QueryPlan>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    crate::routes::query::check_variables(&req.variables)?;
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
fn dialect(ds: &Datasource) -> ApiResult<(Dialect, Option<String>)> {
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
    #[cfg_attr(test, ts(as = "Option<BTreeMap<String, Value>>", optional))]
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
    let mut compiled = pattern::compile(&req.pattern, dialect, graph.as_deref(), &variables).map_err(pattern_error)?;
    compiled.parameters.retain(|name, _| name.starts_with(pattern::RESERVED_PREFIX) || given.contains(name));
    Ok(Json(compiled))
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
    #[cfg_attr(test, ts(as = "Option<BTreeMap<String, Value>>", optional))]
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
