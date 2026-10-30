//! Queries: free queries (`POST /orgs/{orgId}/query`), authorized per data source with
//! `datasources:query` (role or grant), and a dashboard's stored queries (a panel's targets, a
//! query variable's options) for whoever may read the dashboard. All of them run through
//! `datasources::run_queries`. Documented in docs/api/datasources.md.
//!
//! Stored queries: reading the dashboard is what authorizes them. Saving a dashboard required
//! `datasources:query` on every data source its new or changed queries use
//! (`dashboards::check_dashboard_sources`), so a viewer reaches only sources an authorized editor
//! put there, and only with the stored queries. The request adds the time range, limits and
//! variable values; values of constant and custom variables are checked against the dashboard.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::{Extension, Json};
use serde_json::Value;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::dashboards::model::{self, DashboardModel, ValuesFrom, ValuesSource, VariableType};
use crate::datasources::cache::CacheUse;
use crate::datasources::distribution::DistributionSpec;
use crate::datasources::{check_interval, check_items, check_range, run_queries_cached};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::shapes::{
    CacheStatus, DistributionRequest, ErrorBody, FieldDistribution, FieldType, PanelDistributionRequest,
    PanelQueryRequest, QueryItem, QueryOutcome, QueryRequest, QueryResponse, QueryResult, VariableOption,
    VariableOptionsRequest, VariableOptionsResponse,
};

/// What the query cache did for a whole answer (docs/api/datasources.md, "Query cache").
pub(crate) const CACHE_HEADER: HeaderName = HeaderName::from_static("x-kalzit-cache");

/// Whether the caller asks for answers straight from the source: `refresh` in the body, or
/// `Cache-Control: no-cache` (or `no-store`) or `Pragma: no-cache`.
pub(crate) fn wants_refresh(headers: &HeaderMap, refresh: Option<bool>) -> bool {
    let says =
        |name: header::HeaderName| {
            headers.get_all(name).iter().filter_map(|v| v.to_str().ok()).any(|v| {
                v.split(',').map(|d| d.trim().to_ascii_lowercase()).any(|d| d == "no-cache" || d == "no-store")
            })
        };
    refresh == Some(true) || says(header::CACHE_CONTROL) || says(header::PRAGMA)
}

/// The `X-Kalzit-Cache` header of an answer: `hit` when every answer came from the cache,
/// `refresh` when the caller asked to refresh, `miss` when at least one ran in its source and is
/// kept now, `off` when the cache had no part in it (off, not used by a source, or only errors).
pub(crate) fn cache_header(response: &QueryResponse) -> [(HeaderName, HeaderValue); 1] {
    let statuses: Vec<CacheStatus> = response
        .results
        .values()
        .filter_map(|o| match o {
            QueryOutcome::Ok { cache: Some(info), .. } => Some(info.status),
            _ => None,
        })
        .collect();
    let value = if statuses.is_empty() {
        "off"
    } else if statuses.contains(&CacheStatus::Refresh) {
        "refresh"
    } else if statuses.iter().all(|s| *s == CacheStatus::Hit) {
        "hit"
    } else {
        "miss"
    };
    [(CACHE_HEADER, HeaderValue::from_static(value))]
}

/// A query answer with its cache header.
pub(crate) type Answer = ([(HeaderName, HeaderValue); 1], Json<QueryResponse>);

pub(crate) fn answer(response: QueryResponse) -> Answer {
    (cache_header(&response), Json(response))
}

pub fn routes() -> Vec<RouteDef> {
    vec![
        // `datasources:query` per data source (role or grant), checked in the handler.
        route(Method::POST, "/orgs/{orgId}/query", Access::OrgMember, query),
        // Dashboard routes: `dashboards:read` on the dashboard decides, checked in the handler.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query",
            Access::OrgMember,
            panel_query,
        ),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options",
            Access::OrgMember,
            variable_options,
        ),
        // Field distributions: the same rights as running the query they describe.
        route(Method::POST, "/orgs/{orgId}/query/distribution", Access::OrgMember, distribution),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/distribution",
            Access::OrgMember,
            panel_distribution,
        ),
    ]
}

/// How the values of a field path are spread over the whole result of a free query; needs
/// `datasources:query` on the source (role or grant), as running it does.
async fn distribution(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(req): JsonBody<DistributionRequest>,
) -> ApiResult<Json<FieldDistribution>> {
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    check_variables(&req.variables)?;
    let spec = DistributionSpec::new(&req.path, req.top, req.bins)?;
    check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(&req.datasource_id)).await?;
    let d = crate::datasources::distribution::run(
        &state,
        &ctx,
        &req.datasource_id,
        req.query,
        req.time_range,
        req.interval_ms,
        &req.variables,
        None,
        &spec,
    )
    .await?;
    Ok(Json(d))
}

/// The same for a stored target of a panel, for whoever may read the dashboard (as its queries).
async fn panel_distribution(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(req): JsonBody<PanelDistributionRequest>,
) -> ApiResult<Json<FieldDistribution>> {
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    let spec = DistributionSpec::new(&req.path, req.top, req.bins)?;
    // The queries the panel route runs, resolved and authorized the same way (`panel_run`).
    let run = panel_run(&state, &ctx, &dashboard_id, &panel_id, &req.variables, None).await?;
    Ok(Json(stored_distribution(&state, &ctx, run, &req.ref_id, req.time_range, req.interval_ms, &spec).await?))
}

/// The distribution of the stored query `ref_id` among `run`'s items (a query the panel does
/// not run, such as a hidden one, is `not_found`), with the variable values `run` checked.
pub(crate) async fn stored_distribution(
    state: &AppState,
    ctx: &OrgCtx,
    run: PanelRun,
    ref_id: &str,
    range: crate::shapes::TimeRange,
    interval_ms: Option<u64>,
    spec: &DistributionSpec,
) -> ApiResult<FieldDistribution> {
    let PanelRun { items, variables, identifiers } = run;
    let item = items.into_iter().find(|i| i.ref_id == ref_id).ok_or_else(ApiError::not_found)?;
    crate::datasources::distribution::run(
        state,
        ctx,
        &item.datasource_id,
        item.query,
        range,
        interval_ms,
        &variables,
        Some(&identifiers),
        spec,
    )
    .await
}

/// Variables in one request, and the size of all their values together.
const MAX_VARIABLES: usize = 100;
const MAX_VARIABLES_BYTES: usize = 64 * 1024;
/// Options one query variable offers.
pub const MAX_OPTIONS: usize = 10_000;
const OPTIONS_REF_ID: &str = "options";

/// Bounds the variables of a request: count, names and total size.
pub(crate) fn check_variables(variables: &BTreeMap<String, Value>) -> ApiResult<()> {
    let refuse = |e: ApiError| Err(e.with_field("variables"));
    if variables.len() > MAX_VARIABLES {
        return refuse(
            ApiError::validation(format!("at most {MAX_VARIABLES} variables"))
                .because("variables.too_many")
                .param("max", MAX_VARIABLES),
        );
    }
    if let Some(bad) = variables.keys().find(|k| {
        k.is_empty()
            || k.len() > 64
            || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || k.starts_with(|c: char| c.is_ascii_digit())
    }) {
        return refuse(
            ApiError::validation(format!("{bad:?} is not a variable name"))
                .because("variables.name_invalid")
                .param("name", bad),
        );
    }
    if serde_json::to_string(variables).map_or(usize::MAX, |s| s.len()) > MAX_VARIABLES_BYTES {
        return refuse(
            ApiError::validation(format!("variable values exceed {MAX_VARIABLES_BYTES} bytes"))
                .because("variables.too_large")
                .param("bytes", MAX_VARIABLES_BYTES),
        );
    }
    Ok(())
}

async fn query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<QueryRequest>,
) -> ApiResult<Answer> {
    check_items(&req.queries)?;
    crate::datasources::check_item_steps(&req.queries)?;
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    check_variables(&req.variables)?;
    // Each item is authorized on its own data source; one the caller may not query answers for
    // its refId only. Ids of other organizations are not found when they are run.
    // A source is checked once per request, however many items query it (the refusal is
    // checked again for each of its items, which is rare, to answer each with its own error).
    let mut refused = Vec::new();
    let mut allowed = Vec::new();
    let mut may_query = std::collections::HashSet::new();
    for item in req.queries {
        if may_query.contains(&item.datasource_id) {
            allowed.push(item);
            continue;
        }
        match check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(&item.datasource_id))
            .await
        {
            Ok(()) => {
                may_query.insert(item.datasource_id.clone());
                allowed.push(item);
            }
            Err(e) => refused.push((item.ref_id, e)),
        }
    }
    let kept = if req.explore == Some(true) { allowed.clone() } else { Vec::new() };
    let started = std::time::Instant::now();
    let cache = CacheUse::read(wants_refresh(&headers, req.refresh));
    let mut response = if allowed.is_empty() {
        QueryResponse { results: Default::default() }
    } else {
        run_queries_cached(
            &state,
            &ctx,
            allowed,
            req.time_range,
            req.interval_ms,
            req.max_data_points,
            &req.variables,
            None,
            &cache,
        )
        .await
    };
    // Explore keeps what the user ran; the history of the caller alone, never a result.
    if !kept.is_empty() {
        let ran: Vec<_> = kept.iter().filter_map(|i| response.results.get(&i.ref_id).map(|o| (i, o))).collect();
        let duration = (kept.len() == 1).then(|| started.elapsed().as_millis() as i64);
        super::explore_history::record(&state, &ctx, &ran, duration).await;
    }
    for (ref_id, e) in refused {
        let error = crate::datasources::api_error_body(e);
        response.results.insert(ref_id, QueryOutcome::Err { error });
    }
    Ok(answer(response))
}

/// The current stored model of a dashboard the caller may read. Unknown, trashed and invisible
/// dashboards are all `not_found`.
pub(crate) async fn readable_model(state: &AppState, ctx: &OrgCtx, dashboard_id: &str) -> ApiResult<DashboardModel> {
    // The dashboard and its current version in one read, so a version pruned in between cannot
    // turn into an error.
    let row: Option<(Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT d.deleted_at, v.model FROM dashboards d LEFT JOIN dashboard_versions v \
         ON v.dashboard_id = d.id AND v.version = d.version WHERE d.org_id = $1 AND d.id = $2",
    )
    .bind(&ctx.org_id)
    .bind(dashboard_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((deleted_at, raw)) = row else { return Err(ApiError::not_found()) };
    check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(dashboard_id)).await?;
    if deleted_at.is_some() {
        return Err(ApiError::not_found());
    }
    let raw =
        raw.ok_or_else(|| ApiError::internal("dashboards", format!("dashboard {dashboard_id} lacks its version")))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| ApiError::internal("dashboards", e))?;
    model::parse(value).map_err(|e| ApiError::internal("dashboards", e))
}

fn variables_error(reason: &'static str, name: &str, message: String) -> ApiError {
    ApiError::validation(message).with_field("variables").because(reason).param("name", name)
}

/// A variable value as text, for comparing with a list of options: a scalar, or each entry of a
/// multi-value list.
fn value_texts(name: &str, value: &Value) -> ApiResult<Vec<String>> {
    let scalar = |v: &Value| match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(_) | Value::Bool(_) => Ok(v.to_string()),
        _ => Err(variables_error(
            "variables.value_type",
            name,
            format!("variable {name} must be a value or a list of values"),
        )),
    };
    match value {
        Value::Array(items) => items.iter().map(scalar).collect(),
        other => Ok(vec![scalar(other)?]),
    }
}

/// The values a custom variable offers: `options` is a list of values or of `{"value": ...}`
/// objects (with an optional label).
fn custom_options(options: Option<&Value>) -> BTreeSet<String> {
    let Some(Value::Array(items)) = options else { return BTreeSet::new() };
    items
        .iter()
        .filter_map(|o| match o {
            Value::Object(m) => m.get("value"),
            other => Some(other),
        })
        .filter_map(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(_) | Value::Bool(_) => Some(v.to_string()),
            _ => None,
        })
        .collect()
}

/// The variable values a dashboard's stored queries run with, and the variables that may be used
/// as identifiers (`${x:identifier}`).
///
/// - Only variables the dashboard defines may be sent.
/// - A constant's value is the dashboard's (`current`, or its `value`); sending one is refused.
/// - A custom variable's value (each value, for a list) must be one of its `options`.
/// - Query, textbox and interval variables are free values. They are bound as parameters in SQL
///   and escaped into quoted strings in PromQL; they may not be identifiers, since nothing limits
///   them to the dashboard's own list.
pub(crate) fn resolve_variables(
    model: &DashboardModel,
    requested: &BTreeMap<String, Value>,
) -> ApiResult<(BTreeMap<String, Value>, BTreeSet<String>)> {
    let known: BTreeSet<&str> = model.variables.iter().map(|v| v.name.as_str()).collect();
    if let Some(unknown) = requested.keys().find(|k| !known.contains(k.as_str())) {
        return Err(variables_error("variables.unknown", unknown, format!("the dashboard has no variable {unknown}")));
    }
    let mut values = BTreeMap::new();
    let mut identifiers = BTreeSet::new();
    for v in &model.variables {
        let given = requested.get(&v.name);
        match v.kind {
            VariableType::Constant => {
                if given.is_some() {
                    return Err(variables_error(
                        "variables.constant",
                        &v.name,
                        format!("{} is a constant; its value comes from the dashboard", v.name),
                    ));
                }
                let stored = match &v.current {
                    Some(Value::Object(m)) => m.get("value").cloned(),
                    other => other.clone(),
                };
                if let Some(value) = stored.filter(|s| !s.is_null()) {
                    values.insert(v.name.clone(), value);
                    identifiers.insert(v.name.clone());
                }
            }
            VariableType::Custom => {
                if let Some(given) = given {
                    let allowed = custom_options(v.options.as_ref());
                    if let Some(outside) = value_texts(&v.name, given)?.into_iter().find(|t| !allowed.contains(t)) {
                        return Err(variables_error(
                            "variables.not_an_option",
                            &v.name,
                            format!("{outside:?} is not an option of {}", v.name),
                        )
                        .param("value", &outside));
                    }
                    values.insert(v.name.clone(), given.clone());
                    identifiers.insert(v.name.clone());
                }
            }
            VariableType::Query | VariableType::Textbox | VariableType::Interval => {
                if let Some(given) = given {
                    values.insert(v.name.clone(), given.clone());
                }
            }
        }
    }
    Ok((values, identifiers))
}

/// The reference ids that the enabled steps among `transformations` read. A step that does not
/// parse reads nothing here; saving refused it already, and running it reports why.
pub(crate) fn frames_read(transformations: &[Value]) -> BTreeSet<String> {
    transformations
        .iter()
        .filter_map(|v| crate::analysis::parse_step(v).ok())
        .filter(|s| !s.disabled)
        .flat_map(|s| s.kind.frames().into_iter().map(str::to_owned).collect::<Vec<_>>())
        .collect()
}

async fn panel_query(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    JsonBody(mut req): JsonBody<PanelQueryRequest>,
) -> ApiResult<Answer> {
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    let panel = model.panels.iter().find(|p| p.id == panel_id).ok_or_else(ApiError::not_found)?;
    // A library panel's queries are its own; the dashboard showing it authorizes them as it does
    // its own stored queries (dashboards::library).
    let linked = crate::dashboards::linked_content(&state.db, &ctx.org_id, panel).await?;
    let panel = linked.as_ref().unwrap_or(panel);
    req.refresh = Some(wants_refresh(&headers, req.refresh));
    let started = std::time::Instant::now();
    let ran = run_stored_panel(&state, &ctx, &model, panel, req).await;
    // Usage insights count the run per dashboard and panel, never per person. A request refused
    // before its queries ran (a wrong range or variable) is no run.
    if let Ok(response) = &ran {
        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        let run = crate::usage::PanelRun::of(response, ms);
        crate::usage::record_panel(&state, &ctx.org_id, &dashboard_id, &panel_id, run).await;
    }
    Ok(answer(ran?))
}

/// The stored queries of a panel, ready to run, with the variable values checked against what
/// holds them.
pub(crate) struct PanelRun {
    pub items: Vec<QueryItem>,
    pub variables: BTreeMap<String, Value>,
    pub identifiers: BTreeSet<String>,
}

/// The queries `panel` of `model` runs, with `variables` checked (`resolve_variables`). Hidden
/// targets stay with the panel but are not run, unless an analysis step reads them. `cursors`
/// continue document results by `refId`.
pub(crate) fn stored_items(
    model: &DashboardModel,
    panel: &model::Panel,
    variables: &BTreeMap<String, Value>,
    limit: Option<u32>,
    cursors: &BTreeMap<String, String>,
) -> ApiResult<PanelRun> {
    check_variables(variables)?;
    let (variables, identifiers) = resolve_variables(model, variables)?;
    let read = frames_read(&panel.transformations);
    let items = panel
        .targets
        .iter()
        .filter(|t| !t.hide || read.contains(&t.ref_id))
        .map(|t| QueryItem {
            ref_id: t.ref_id.clone(),
            datasource_id: t.datasource_id.clone(),
            query: t.query.clone(),
            cursor: cursors.get(&t.ref_id).cloned(),
            limit,
            steps: graph_steps_of(&panel.transformations, &t.ref_id),
        })
        .collect();
    Ok(PanelRun { items, variables, identifiers })
}

/// The enabled graph steps among `transformations` that read the query `ref_id`, in order: they
/// run with the query, in the database where the source can (`datasources::run_queries`).
pub(crate) fn graph_steps_of(transformations: &[Value], ref_id: &str) -> Vec<Value> {
    transformations
        .iter()
        .filter(|v| {
            crate::analysis::parse_step(v)
                .is_ok_and(|s| !s.disabled && s.kind.is_graph_step() && s.kind.frames() == [ref_id])
        })
        .cloned()
        .collect()
}

/// The queries a panel of a readable dashboard runs, as `panel_query` resolves them: the
/// dashboard must be readable (`readable_model`; unknown panels are `not_found`), and a linked
/// library panel or saved analysis brings its own queries (`dashboards::linked_content`), which
/// the dashboard authorizes like its own. For live updates.
pub(crate) async fn panel_run(
    state: &AppState,
    ctx: &OrgCtx,
    dashboard_id: &str,
    panel_id: &str,
    variables: &BTreeMap<String, Value>,
    limit: Option<u32>,
) -> ApiResult<PanelRun> {
    let model = readable_model(state, ctx, dashboard_id).await?;
    let panel = model.panels.iter().find(|p| p.id == panel_id).ok_or_else(ApiError::not_found)?;
    let linked = crate::dashboards::linked_content(&state.db, &ctx.org_id, panel).await?;
    let panel = linked.as_ref().unwrap_or(panel);
    stored_items(&model, panel, variables, limit, &BTreeMap::new())
}

/// Runs the stored queries of `panel` in `model` (a dashboard's, or a saved analysis as a
/// dashboard of one panel) with the request's time range, limits and variable values, through
/// the query cache (`refresh` bypasses it). The caller has decided that the caller may read what
/// holds them.
pub(crate) async fn run_stored_panel(
    state: &AppState,
    ctx: &OrgCtx,
    model: &DashboardModel,
    panel: &model::Panel,
    req: PanelQueryRequest,
) -> ApiResult<QueryResponse> {
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    let PanelRun { items, variables, identifiers } =
        stored_items(model, panel, &req.variables, req.limit, &req.cursors)?;
    if items.is_empty() {
        return Ok(QueryResponse { results: BTreeMap::new() });
    }
    check_items(&items)?;
    Ok(run_queries_cached(
        state,
        ctx,
        items,
        req.time_range,
        req.interval_ms,
        req.max_data_points,
        &variables,
        Some(&identifiers),
        &CacheUse::read(req.refresh == Some(true)),
    )
    .await)
}

async fn variable_options(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, name)): Path<(String, String, String)>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<VariableOptionsRequest>,
) -> ApiResult<Json<VariableOptionsResponse>> {
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    let variable = model.variables.iter().find(|v| v.name == name).ok_or_else(ApiError::not_found)?;
    check_range(req.time_range)?;
    check_variables(&req.variables)?;
    if req.variables.contains_key(&name) {
        return Err(variables_error(
            "variables.self_dependency",
            &name,
            format!("variable {name} cannot depend on itself"),
        ));
    }
    let (VariableType::Query, Some(datasource_id), Some(query)) =
        (variable.kind, variable.datasource_id.as_ref(), variable.query.as_ref())
    else {
        return Err(ApiError::validation(format!("{name} is not a query variable"))
            .because("variables.not_a_query")
            .param("name", &name));
    };
    let (variables, identifiers) = resolve_variables(&model, &req.variables)?;
    let item = QueryItem {
        ref_id: OPTIONS_REF_ID.into(),
        datasource_id: datasource_id.clone(),
        query: query.clone(),
        cursor: None,
        limit: Some(MAX_OPTIONS as u32),
        steps: Vec::new(),
    };
    let cache = CacheUse::read(wants_refresh(&headers, None));
    let mut response = run_queries_cached(
        &state,
        &ctx,
        vec![item],
        req.time_range,
        None,
        None,
        &variables,
        Some(&identifiers),
        &cache,
    )
    .await;
    match response.results.remove(OPTIONS_REF_ID) {
        Some(QueryOutcome::Ok { result, .. }) => Ok(Json(options_from(result, variable.values_from.as_ref())?)),
        Some(QueryOutcome::Err { error }) => Err(api_error(error)),
        None => Err(ApiError::internal("variable options", "no outcome for the query")),
    }
}

/// A query outcome's error as the answer of a single-query route.
pub(crate) fn api_error(error: ErrorBody) -> ApiError {
    let (status, code) = match error.code.as_str() {
        "not_found" => (StatusCode::NOT_FOUND, "not_found"),
        "forbidden" => (StatusCode::FORBIDDEN, "forbidden"),
        "query_rejected" => (StatusCode::UNPROCESSABLE_ENTITY, "query_rejected"),
        "datasource_target_blocked" => (StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked"),
        "query_timeout" => (StatusCode::GATEWAY_TIMEOUT, "query_timeout"),
        "validation" => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
        "internal" => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        _ => (StatusCode::BAD_GATEWAY, "datasource_error"),
    };
    let mut e = ApiError::new(status, code, error.message);
    e.request_id = error.request_id.map(Into::into);
    if let Some(reason) = error.reason {
        e = e.with_reason_string(reason, error.params.unwrap_or_default());
    }
    e
}

/// Options in the order they come, distinct by value, at most `MAX_OPTIONS`.
struct Collected {
    seen: BTreeSet<String>,
    options: Vec<VariableOption>,
    truncated: bool,
}

impl Collected {
    fn new(truncated: bool) -> Self {
        Self { seen: BTreeSet::new(), options: Vec::new(), truncated }
    }

    /// Adds an option; false once the list is full.
    fn push(&mut self, value: String, label: Option<String>) -> bool {
        if self.seen.contains(&value) {
            return true;
        }
        if self.options.len() == MAX_OPTIONS {
            self.truncated = true;
            return false;
        }
        self.seen.insert(value.clone());
        let label = label.unwrap_or_else(|| value.clone());
        self.options.push(VariableOption { value, label });
        true
    }

    fn done(self) -> VariableOptionsResponse {
        VariableOptionsResponse { options: self.options, truncated: self.truncated }
    }
}

/// The options of a query variable. A frame: values from its first field, labels from the second
/// (or the value). A graph or documents result only through the variable's `valuesFrom`, the
/// explicit projection; without it, or when it names another shape, the answer says so.
fn options_from(result: QueryResult, values_from: Option<&ValuesFrom>) -> ApiResult<VariableOptionsResponse> {
    let shape_error = |message: &str| ApiError::validation(message.to_string()).because("variables.not_a_frame");
    match (result, values_from) {
        (QueryResult::Frame { frame }, None) => {
            let fields = frame.fields();
            let mut out = Collected::new(frame.meta().is_some_and(|m| m.rows_truncated));
            let Some(values) = fields.first() else { return Ok(out.done()) };
            let labels = fields.get(1);
            for (row, raw) in values.values.iter().enumerate() {
                let Some(value) = as_text(raw, values.field_type) else { continue };
                let label = labels.and_then(|l| as_text(&l.values[row], l.field_type));
                if !out.push(value, label) {
                    break;
                }
            }
            Ok(out.done())
        }
        (QueryResult::Graph { graph }, Some(from)) if from.from != ValuesSource::Documents => {
            let mut out = Collected::new(graph.truncated.is_some());
            let wanted = from.label.as_deref().filter(|l| !l.is_empty());
            let key = from.value.as_deref().filter(|k| !k.is_empty());
            let text = from.text.as_deref().filter(|k| !k.is_empty());
            let pick = |id: &str, props: &BTreeMap<String, Value>| {
                let value = match key {
                    Some(k) => props.get(k).and_then(cell_text),
                    None => Some(id.to_string()),
                };
                value.map(|v| (v, text.and_then(|t| props.get(t)).and_then(cell_text)))
            };
            let items: Vec<(String, Option<String>)> = if from.from == ValuesSource::Nodes {
                graph
                    .nodes
                    .iter()
                    .filter(|n| wanted.is_none_or(|l| n.labels.iter().any(|x| x == l)))
                    .filter_map(|n| pick(&n.id, &n.properties))
                    .collect()
            } else {
                graph
                    .edges
                    .iter()
                    .filter(|e| wanted.is_none_or(|t| e.edge_type == t))
                    .filter_map(|e| pick(&e.id, &e.properties))
                    .collect()
            };
            for (value, label) in items {
                if !out.push(value, label) {
                    break;
                }
            }
            Ok(out.done())
        }
        (QueryResult::Documents { documents }, Some(from)) if from.from == ValuesSource::Documents => {
            let mut out = Collected::new(documents.truncated.is_some() || documents.next_cursor.is_some());
            let path = from.value.as_deref().unwrap_or_default();
            let text = from.text.as_deref().filter(|t| !t.is_empty());
            let mut full = false;
            for raw in &documents.documents {
                let Ok(doc) = serde_json::from_str::<Value>(raw.get()) else { continue };
                let label = text.and_then(|t| document_value(&doc, t)).and_then(cell_text);
                // An array of values gives one option per element (tags, several ids).
                let values: Vec<String> = match document_value(&doc, path) {
                    Some(Value::Array(items)) => items.iter().filter_map(cell_text).collect(),
                    Some(v) => cell_text(v).into_iter().collect(),
                    None => Vec::new(),
                };
                for value in values {
                    if !out.push(value, label.clone()) {
                        full = true;
                        break;
                    }
                }
                if full {
                    break;
                }
            }
            Ok(out.done())
        }
        (QueryResult::Frame { .. }, Some(_)) => {
            Err(shape_error("the variable's query answers a table (frame); remove valuesFrom to read its first column"))
        }
        (QueryResult::Graph { .. }, _) => Err(shape_error(
            "the variable's query answers a graph; set valuesFrom to nodes or edges to read values from it",
        )),
        (QueryResult::Documents { .. }, _) => {
            Err(shape_error("the variable's query answers documents; set valuesFrom to documents with a field path"))
        }
    }
}

/// The value at a dotted path of a document (`customer.id`, `items.0.sku`). Typed values
/// (`{"$type": ..., "value": ...}`) are leaves; a wrapped document is read through.
fn document_value<'a>(doc: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = doc;
    for part in path.split('.') {
        if current.get("$type").and_then(Value::as_str) == Some("document") {
            current = current.get("value")?;
        }
        current = match current {
            Value::Array(items) if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) => {
                items.get(part.parse::<usize>().ok()?)?
            }
            Value::Object(m) if !m.contains_key("$type") => m.get(part)?,
            _ => return None,
        };
    }
    Some(current)
}

/// A property or field value as option text: scalars as their text, typed values
/// (`{"$type": "int64", "value": "..."}`, object ids, dates) as their value; `null`, objects and
/// lists give none.
fn cell_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Object(m) if m.contains_key("$type") => match m.get("value") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(v @ (Value::Number(_) | Value::Bool(_))) => Some(v.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// A cell as option text: int64 and decimal stay their decimal string, time becomes ISO 8601 in
/// UTC, a date `2026-01-01`; `null` has no option.
fn as_text(value: &Value, field_type: FieldType) -> Option<String> {
    match (field_type, value) {
        (_, Value::Null) => None,
        (FieldType::Time, Value::Number(n)) => n
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        (FieldType::Date, Value::Number(n)) => n
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|t| t.date_naive().format("%Y-%m-%d").to_string()),
        (_, Value::String(s)) => Some(s.clone()),
        (_, other) => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Field, Frame, FrameMeta};
    use serde_json::json;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    #[test]
    fn options_are_distinct_text_with_labels() {
        let frame = Frame::new(vec![
            field("id", FieldType::Int64, vec![json!("9007199254740993"), json!("2"), json!("2"), Value::Null]),
            field("name", FieldType::String, vec![json!("Groß"), json!("Klein"), json!("Doppelt"), json!("Leer")]),
        ])
        .unwrap();
        let r = options_from(QueryResult::Frame { frame }, None).unwrap();
        assert_eq!(
            r.options,
            [
                VariableOption { value: "9007199254740993".into(), label: "Groß".into() },
                VariableOption { value: "2".into(), label: "Klein".into() },
            ]
        );
        assert!(!r.truncated);

        let frame = Frame::new(vec![field("t", FieldType::Time, vec![json!(1_735_725_600_000_i64)])])
            .unwrap()
            .with_meta(FrameMeta { rows_truncated: true, ..Default::default() });
        let r = options_from(QueryResult::Frame { frame }, None).unwrap();
        assert_eq!(r.options[0].value, "2025-01-01T10:00:00.000Z");
        assert_eq!(r.options[0].label, r.options[0].value);
        assert!(r.truncated);

        let many = (0..MAX_OPTIONS + 5).map(|i| json!(i)).collect();
        let frame = Frame::new(vec![field("n", FieldType::Number, many)]).unwrap();
        let r = options_from(QueryResult::Frame { frame }, None).unwrap();
        assert_eq!((r.options.len(), r.truncated), (MAX_OPTIONS, true));
    }

    fn from(v: Value) -> ValuesFrom {
        serde_json::from_value(v).unwrap()
    }

    fn values(r: &VariableOptionsResponse) -> Vec<(&str, &str)> {
        r.options.iter().map(|o| (o.value.as_str(), o.label.as_str())).collect()
    }

    /// A graph gives options only through `valuesFrom`: node or edge properties (or ids), filtered
    /// by label or type, typed values as their text, distinct by value.
    #[test]
    fn graph_options_come_from_the_named_property() {
        use crate::shapes::{Edge, GraphSet, Node};
        let node = |id: &str, label: &str, props: Value| Node {
            id: id.into(),
            labels: vec![label.into()],
            properties: serde_json::from_value(props).unwrap(),
        };
        let graph = GraphSet {
            nodes: vec![
                node(
                    "4:1",
                    "Kunde",
                    json!({ "kundenId": { "$type": "int64", "value": "9007199254740993" }, "name": "Groß" }),
                ),
                node("4:2", "Kunde", json!({ "kundenId": 7, "name": "Klein" })),
                node("4:3", "Kunde", json!({ "kundenId": 7, "name": "Doppelt" })),
                node("4:4", "Kunde", json!({ "name": "Ohne Id" })),
                node("4:5", "Produkt", json!({ "kundenId": 99 })),
            ],
            edges: vec![Edge {
                id: "5:1".into(),
                edge_type: "KAUFT".into(),
                from: "4:1".into(),
                to: "4:5".into(),
                properties: serde_json::from_value(json!({ "seit": 2020 })).unwrap(),
            }],
            ..Default::default()
        };
        let run = |v: Value| options_from(QueryResult::Graph { graph: graph.clone() }, Some(&from(v)));
        let r = run(json!({ "from": "nodes", "label": "Kunde", "value": "kundenId", "text": "name" })).unwrap();
        assert_eq!(values(&r), [("9007199254740993", "Groß"), ("7", "Klein")]);
        assert!(!r.truncated);
        let r = run(json!({ "from": "nodes" })).unwrap();
        assert_eq!(r.options.len(), 5, "empty value takes the node id");
        assert_eq!(r.options[0].value, "4:1");
        let r = run(json!({ "from": "edges", "label": "KAUFT", "value": "seit" })).unwrap();
        assert_eq!(values(&r), [("2020", "2020")]);
        // Without valuesFrom, or with one for documents, a graph is refused with the reason.
        let err = options_from(QueryResult::Graph { graph: graph.clone() }, None).unwrap_err();
        assert_eq!(err.reason.as_ref().unwrap().code, "variables.not_a_frame");
        assert!(run(json!({ "from": "documents", "value": "a" })).is_err());
    }

    #[test]
    fn document_options_come_from_a_field_path() {
        use crate::shapes::DocumentSet;
        let docs = DocumentSet {
            documents: vec![
                json!({ "customer": { "id": { "$type": "objectId", "value": "65a1" }, "name": "Ana" }, "tags": ["a", "b"] }).into(),
                json!({ "customer": { "id": 7, "name": "Bo" }, "tags": ["b", null] }).into(),
                json!({ "customer": { "name": "Ohne" } }).into(),
            ],
            next_cursor: Some("weiter".into()),
            ..Default::default()
        };
        let run = |v: Value| options_from(QueryResult::Documents { documents: docs.clone() }, Some(&from(v)));
        let r = run(json!({ "from": "documents", "value": "customer.id", "text": "customer.name" })).unwrap();
        assert_eq!(values(&r), [("65a1", "Ana"), ("7", "Bo")]);
        assert!(r.truncated, "more documents follow");
        let r = run(json!({ "from": "documents", "value": "tags" })).unwrap();
        assert_eq!(values(&r), [("a", "a"), ("b", "b")], "each element of an array");
        assert!(run(json!({ "from": "nodes" })).is_err());
        let frame = Frame::new(vec![field("n", FieldType::Number, vec![json!(1)])]).unwrap();
        assert!(options_from(QueryResult::Frame { frame }, Some(&from(json!({ "from": "nodes" })))).is_err());
    }

    #[test]
    fn variables_are_bounded() {
        assert!(check_variables(&BTreeMap::from([("land".into(), json!("AT"))])).is_ok());
        assert!(check_variables(&BTreeMap::from([("1x".into(), json!(1))])).is_err());
        assert!(check_variables(&BTreeMap::from([("a b".into(), json!(1))])).is_err());
        let big = BTreeMap::from([("v".into(), json!("x".repeat(MAX_VARIABLES_BYTES)))]);
        assert!(check_variables(&big).is_err());
        let many: BTreeMap<String, Value> = (0..=MAX_VARIABLES).map(|i| (format!("v{i}"), json!(i))).collect();
        assert!(check_variables(&many).is_err());
    }
}
