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
use crate::authz::{Access, DatasourceAccess, OrgCtx, Permission, Resource, check_resource};
use crate::dashboards::model::{self, DashboardModel, ValuesFrom, ValuesSource, VariableType};
use crate::datasources::cache::CacheUse;
use crate::datasources::distribution::DistributionSpec;
use crate::datasources::{check_interval, check_items, check_range, run_queries_cached};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::shapes::{
    CacheStatus, DistributionRequest, ErrorBody, FieldDistribution, FieldType, PanelDistributionRequest,
    PanelQueryRequest, QueryItem, QueryOutcome, QueryRequest, QueryResponse, QueryResult, VariableOption,
    VariableOptionsRequest, VariableOptionsResponse, VariablePreviewRequest,
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
        route(Method::POST, "/orgs/{orgId}/query", Access::OrgMember, query).long_running(),
        // Dashboard routes: `dashboards:read` on the dashboard decides, checked in the handler.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/query",
            Access::OrgMember,
            panel_query,
        )
        .long_running(),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/variables/{name}/options",
            Access::OrgMember,
            variable_options,
        )
        .long_running(),
        // A variable being edited: `datasources:query` on its source, as a free query.
        route(Method::POST, "/orgs/{orgId}/query/variable-options", Access::OrgMember, variable_preview).long_running(),
        // Field distributions: the same rights as running the query they describe.
        route(Method::POST, "/orgs/{orgId}/query/distribution", Access::OrgMember, distribution).long_running(),
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/distribution",
            Access::OrgMember,
            panel_distribution,
        )
        .long_running(),
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
/// Values in one variable's list, such as "All" sends: a longer list is better one custom value
/// for "All" (docs/api/datasources.md, "Variables").
pub const MAX_LIST_VALUES: usize = 1000;
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
    if let Some((name, _)) =
        variables.iter().find(|(_, v)| v.as_array().is_some_and(|items| items.len() > MAX_LIST_VALUES))
    {
        return refuse(list_too_long(name));
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
    // its refId only. Ids of other organizations are not found when they are run. The caller's
    // rights on data sources are read once per request, however many sources the items query.
    let mut refused = Vec::new();
    let mut allowed = Vec::new();
    let access = DatasourceAccess::load(&state.db, &ctx).await?;
    for item in req.queries {
        match access.check(Permission::DatasourcesQuery, &item.datasource_id) {
            Ok(()) => allowed.push(item),
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
/// - A custom variable's value (each value, for a list) must be one of its `options`, or its
///   custom value for "All". With `allowCustom` other values pass too, as free values.
/// - Query, textbox and interval variables are free values. They are bound as parameters in SQL
///   and escaped into quoted strings in PromQL; they may not be identifiers, since nothing limits
///   them to the dashboard's own list.
/// - A variable's custom value for "All" (`allValue`), sent alone, is the dashboard's own value:
///   it counts as checked (a pattern such as `.*` stays one in PromQL), whatever the type.
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
                    let outside = value_texts(&v.name, given)?.into_iter().find(|t| !allowed.contains(t));
                    match outside {
                        None => {
                            identifiers.insert(v.name.clone());
                        }
                        Some(_) if is_all_value(v, given) => {
                            identifiers.insert(v.name.clone());
                        }
                        Some(_) if v.allow_custom => {}
                        Some(outside) => {
                            return Err(variables_error(
                                "variables.not_an_option",
                                &v.name,
                                format!("{outside:?} is not an option of {}", v.name),
                            )
                            .param("value", &outside));
                        }
                    }
                    values.insert(v.name.clone(), given.clone());
                }
            }
            VariableType::Query | VariableType::Textbox | VariableType::Interval => {
                if let Some(given) = given {
                    if is_all_value(v, given) {
                        identifiers.insert(v.name.clone());
                    }
                    values.insert(v.name.clone(), given.clone());
                }
            }
        }
    }
    Ok((values, identifiers))
}

/// Whether `given` is the variable's custom value for "All", sent alone (as itself, or a list of
/// just it).
fn is_all_value(v: &model::Variable, given: &Value) -> bool {
    let Some(all) = v.all_value.as_deref().filter(|_| v.include_all) else { return false };
    match given {
        Value::String(s) => s == all,
        Value::Array(items) => matches!(items.as_slice(), [Value::String(s)] if s == all),
        _ => false,
    }
}

/// Whether `given` is a selection of "All" of `v` that the server fills in (`expand_all`).
fn marks_all(v: &model::Variable, given: &Value) -> bool {
    v.include_all && crate::dashboards::variables::is_all(given)
}

/// The values without the selections of "All" that a run fills in (`expand_all`), for checking
/// the others where nothing runs yet: a public link, a snapshot or a report being saved.
pub(crate) fn without_all(model: &DashboardModel, values: &BTreeMap<String, Value>) -> BTreeMap<String, Value> {
    values
        .iter()
        .filter(|(name, given)| !model.variables.iter().any(|v| &v.name == *name && marks_all(v, given)))
        .map(|(name, given)| (name.clone(), given.clone()))
        .collect()
}

/// Fills in each selection of "All" (`$__all`) among `values` as the browser sends it: the custom
/// value for "All", a custom variable's options, or a query variable's options, read here by
/// running its stored options query as `ctx`, with the regex, order, fixed options and list cap
/// of the options route. The variables are filled in in the dashboard's order, each options
/// query with the values known by then (other "All" selections not yet filled in are left out).
/// Only the query variables that `uses` (the queries about to run) mentions are read, and those
/// their own queries mention in turn: a broken variable elsewhere on the dashboard stops nothing.
/// The others keep the marker, which nothing that runs reads.
///
/// The caller has decided that `ctx` may read the dashboard (`readable_model`, a public link's
/// creator check, a report's creator). With `AllRights::Query` (runs that belong to someone who
/// is not looking: public links and snapshots, reports) `ctx` must also hold `datasources:query`
/// on each options query's source, as for the panels' own sources (`sharing::may_query_all`). An options query that fails is an error naming the
/// variable (`variables.all_options_failed`), never an empty list; more values than a list may
/// hold is `variables.list_too_long`, as if the browser had sent them.
pub(crate) async fn expand_all(
    state: &AppState,
    ctx: &OrgCtx,
    model: &DashboardModel,
    values: &BTreeMap<String, Value>,
    range: crate::shapes::TimeRange,
    uses: &Value,
    rights: AllRights,
) -> ApiResult<BTreeMap<String, Value>> {
    let mut out = values.clone();
    if !out.values().any(crate::dashboards::variables::is_all) {
        return Ok(out);
    }
    let needed = needed_variables(model, uses);
    for v in &model.variables {
        if !out.get(&v.name).is_some_and(|given| marks_all(v, given)) {
            continue;
        }
        let filled = match crate::dashboards::variables::all_without_query(v) {
            Some(value) => value,
            None if !needed.contains(&v.name) => continue,
            None => {
                if let (AllRights::Query, Some(source)) = (rights, v.datasource_id.as_deref()) {
                    check_resource(&state.db, ctx, Permission::DatasourcesQuery, Resource::Datasource(source)).await?;
                }
                let mut inputs = without_all(model, &out);
                inputs.remove(&v.name);
                let answer = options_of(state, ctx, model, v, &inputs, range, &CacheUse::read(false))
                    .await
                    .map_err(|e| all_failed(&v.name, e))?;
                if answer.options.len() > MAX_LIST_VALUES {
                    return Err(list_too_long(&v.name));
                }
                Value::Array(answer.options.into_iter().map(|o| Value::String(o.value)).collect())
            }
        };
        out.insert(v.name.clone(), filled);
    }
    Ok(out)
}

/// Whose rights an "All" is filled in with (`expand_all`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AllRights {
    /// Someone who may read the dashboard runs its stored queries, as a viewer does.
    Reader,
    /// A run that belongs to someone who is not looking (a public link or snapshot, a report):
    /// they must also hold `datasources:query` on the options query's source.
    Query,
}

/// The data sources of the options queries that a run of `uses` with `values` needs for "All":
/// the query variables in use (`needed_variables`) whose selection is "All" without a custom
/// value. Public links and snapshots check their creator's query rights on these too.
pub(crate) fn all_sources(model: &DashboardModel, values: &BTreeMap<String, Value>, uses: &Value) -> BTreeSet<String> {
    let needed = needed_variables(model, uses);
    model
        .variables
        .iter()
        .filter(|v| needed.contains(&v.name) && values.get(&v.name).is_some_and(|given| marks_all(v, given)))
        .filter(|v| crate::dashboards::variables::all_without_query(v).is_none())
        .filter_map(|v| v.datasource_id.clone())
        .collect()
}

/// The names `uses` mentions (`$name`, `${name}`), with those the queries of the variables it
/// mentions mention in turn.
pub(crate) fn needed_variables(model: &DashboardModel, uses: &Value) -> BTreeSet<String> {
    let mut needed = mentioned_names(uses);
    loop {
        let more: BTreeSet<String> = model
            .variables
            .iter()
            .filter(|v| needed.contains(&v.name))
            .filter_map(|v| v.query.as_ref())
            .flat_map(mentioned_names)
            .filter(|n| !needed.contains(n))
            .collect();
        if more.is_empty() {
            return needed;
        }
        needed.extend(more);
    }
}

/// Every `$name` or `${name` in the JSON text of `value`.
fn mentioned_names(value: &Value) -> BTreeSet<String> {
    let text = value.to_string();
    let mut names = BTreeSet::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find('$') {
        rest = &rest[at + 1..];
        let after = rest.strip_prefix('{').unwrap_or(rest);
        let len = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
        if len > 0 && !after.starts_with(|c: char| c.is_ascii_digit()) {
            names.insert(after[..len].to_string());
        }
    }
    names
}

/// The queries a panel runs, as `expand_all` reads which variables they use.
pub(crate) fn panel_uses(panel: &model::Panel) -> Value {
    Value::Array(panel.targets.iter().map(|t| t.query.clone()).collect())
}

/// The error of an options query that "All" needed, naming the variable; the database's own
/// reason goes along as `detail`.
fn all_failed(name: &str, e: ApiError) -> ApiError {
    let detail = e.message.clone();
    let mut out =
        ApiError::new(e.status, e.code, format!("the values of {name} for \"All\" could not be read: {detail}"));
    out.request_id = e.request_id;
    out.because("variables.all_options_failed").param("name", name).param("detail", detail)
}

fn list_too_long(name: &str) -> ApiError {
    ApiError::validation(format!(
        "variable {name} has more than {MAX_LIST_VALUES} values; give \"All\" a custom value instead"
    ))
    .because("variables.list_too_long")
    .param("name", name)
    .param("max", MAX_LIST_VALUES)
}

/// The options of the saved query variable `variable` of `model`, its stored query run as `ctx`
/// with `values` (checked as for a panel), then its regex, order and fixed options.
async fn options_of(
    state: &AppState,
    ctx: &OrgCtx,
    model: &DashboardModel,
    variable: &model::Variable,
    values: &BTreeMap<String, Value>,
    range: crate::shapes::TimeRange,
    cache: &CacheUse,
) -> ApiResult<VariableOptionsResponse> {
    let (VariableType::Query, Some(datasource_id), Some(query)) =
        (variable.kind, variable.datasource_id.as_ref(), variable.query.as_ref())
    else {
        return Err(ApiError::validation(format!("{} is not a query variable", variable.name))
            .because("variables.not_a_query")
            .param("name", &variable.name));
    };
    check_variables(values)?;
    let (variables, identifiers) = resolve_variables(model, values)?;
    let item = QueryItem {
        ref_id: OPTIONS_REF_ID.into(),
        datasource_id: datasource_id.clone(),
        query: query.clone(),
        cursor: None,
        limit: Some(MAX_OPTIONS as u32),
        steps: Vec::new(),
    };
    let mut response =
        run_queries_cached(state, ctx, vec![item], range, None, None, &variables, Some(&identifiers), cache).await;
    match response.results.remove(OPTIONS_REF_ID) {
        Some(QueryOutcome::Ok { result, .. }) => refined(result, variable),
        Some(QueryOutcome::Err { error }) => Err(api_error(error)),
        None => Err(ApiError::internal("variable options", "no outcome for the query")),
    }
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
    let ran = run_stored_panel(&state, &ctx, &model, panel, req, AllRights::Reader).await;
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
/// continue document results by `refId`; with any, only the targets they name run (a later page
/// of one result does not run the others again).
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
        .filter(|t| cursors.is_empty() || cursors.contains_key(&t.ref_id))
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

/// The enabled graph and trace steps among `transformations` that read the query `ref_id`, in
/// order: they run with the query, in the database where the source can
/// (`datasources::run_queries`).
pub(crate) fn graph_steps_of(transformations: &[Value], ref_id: &str) -> Vec<Value> {
    transformations
        .iter()
        .filter(|v| {
            crate::analysis::parse_step(v)
                .is_ok_and(|s| !s.disabled && s.kind.runs_with_query() && s.kind.frames() == [ref_id])
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
    rights: AllRights,
) -> ApiResult<QueryResponse> {
    check_range(req.time_range)?;
    check_interval(req.interval_ms)?;
    // A shared or saved "All" (a public link, a snapshot) is filled in with `ctx`'s rights.
    let values = expand_all(state, ctx, model, &req.variables, req.time_range, &panel_uses(panel), rights).await?;
    let PanelRun { items, variables, identifiers } = stored_items(model, panel, &values, req.limit, &req.cursors)?;
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
    if variable.kind != VariableType::Query {
        return Err(ApiError::validation(format!("{name} is not a query variable"))
            .because("variables.not_a_query")
            .param("name", &name));
    }
    // Another variable this one uses may stand at "All": filled in as for the panels.
    let uses = variable.query.clone().unwrap_or(Value::Null);
    let values = expand_all(&state, &ctx, &model, &req.variables, req.time_range, &uses, AllRights::Reader).await?;
    let cache = CacheUse::read(wants_refresh(&headers, None));
    Ok(Json(options_of(&state, &ctx, &model, variable, &values, req.time_range, &cache).await?))
}

/// The options of a variable's query result: read from its shape (`options_from`), then its
/// regex, order and fixed options (`dashboards::variables::refine`).
fn refined(result: QueryResult, variable: &model::Variable) -> ApiResult<VariableOptionsResponse> {
    let options = options_from(result, variable.values_from.as_ref())?;
    crate::dashboards::variables::refine(options, variable).map_err(|e| {
        ApiError::validation(e.clone()).with_field("regex").because("variables.regex_invalid").param("detail", e)
    })
}

/// The options a variable being edited would offer: the variable as the dashboard model holds it
/// (checked by the model's rules), its query run as a free query, which needs `datasources:query`
/// on the source (role or grant), with the caller's variable values. Another variable at "All"
/// (`$__all`) is filled in from the saved dashboard `dashboardId` names, as the options route
/// does, with the caller's rights and only when the caller may read it; one the saved dashboard
/// cannot fill in is refused (`variables.all_unresolved`), so the marker never reaches a query.
async fn variable_preview(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<VariablePreviewRequest>,
) -> ApiResult<Json<VariableOptionsResponse>> {
    let variable: model::Variable = serde_json::from_value(req.variable).map_err(|e| {
        ApiError::validation(format!("variable: {e}"))
            .with_field("variable")
            .because("variables.invalid")
            .param("detail", e)
    })?;
    model::validate_variable("variable", &variable).map_err(|e| {
        ApiError::validation(e.clone()).with_field("variable").because("variables.invalid").param("detail", e)
    })?;
    check_range(req.time_range)?;
    check_variables(&req.variables)?;
    let (VariableType::Query, Some(datasource_id), Some(query)) =
        (variable.kind, variable.datasource_id.as_ref(), variable.query.as_ref())
    else {
        return Err(ApiError::validation(format!("{} is not a query variable", variable.name))
            .because("variables.not_a_query")
            .param("name", &variable.name));
    };
    check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(datasource_id)).await?;
    let mut values = req.variables;
    if values.values().any(crate::dashboards::variables::is_all) {
        if let Some(dashboard_id) = &req.dashboard_id {
            let model = readable_model(&state, &ctx, dashboard_id).await?;
            values = expand_all(&state, &ctx, &model, &values, req.time_range, query, AllRights::Reader).await?;
        }
        if let Some(name) = values.iter().find(|(_, v)| crate::dashboards::variables::is_all(v)).map(|(n, _)| n) {
            return Err(variables_error(
                "variables.all_unresolved",
                name,
                format!("{name} stands at \"All\", which only a saved variable can fill in"),
            ));
        }
    }
    let item = QueryItem {
        ref_id: OPTIONS_REF_ID.into(),
        datasource_id: datasource_id.clone(),
        query: query.clone(),
        cursor: None,
        limit: Some(MAX_OPTIONS as u32),
        steps: Vec::new(),
    };
    let cache = CacheUse::read(wants_refresh(&headers, None));
    let mut response =
        run_queries_cached(&state, &ctx, vec![item], req.time_range, None, None, &values, None, &cache).await;
    match response.results.remove(OPTIONS_REF_ID) {
        Some(QueryOutcome::Ok { result, .. }) => Ok(Json(refined(result, &variable)?)),
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
        VariableOptionsResponse { options: self.options, truncated: self.truncated, unmatched: None }
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
        // Variables have no steps; a trace source lists services and operations as frames.
        (QueryResult::Trace { .. }, _) => Err(shape_error(
            "the variable's query answers traces; use a query that answers a list, such as the services",
        )),
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
        // "All" as a list: up to MAX_LIST_VALUES values, then the answer names the custom value.
        let list =
            |n: usize| BTreeMap::from([("job".into(), json!((0..n).map(|i| format!("j{i}")).collect::<Vec<_>>()))]);
        assert!(check_variables(&list(MAX_LIST_VALUES)).is_ok());
        let e = check_variables(&list(MAX_LIST_VALUES + 1)).unwrap_err();
        assert_eq!(e.reason.as_ref().unwrap().code, "variables.list_too_long");
    }

    fn all_model() -> DashboardModel {
        model::parse(json!({
            "schemaVersion": 2,
            "title": "Alle",
            "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "job", "type": "query", "datasourceId": "ds", "query": { "expr": "up" },
                  "multi": true, "includeAll": true, "allValue": ".*" },
                { "name": "region", "type": "custom", "options": ["nord", "sued"], "multi": true,
                  "includeAll": true, "current": "$__all" },
                { "name": "env", "type": "custom", "options": ["prod"], "includeAll": true, "allValue": "%" },
                { "name": "host", "type": "custom", "options": ["a"], "allowCustom": true }
            ]
        }))
        .unwrap()
    }

    fn resolve(values: Value) -> ApiResult<(BTreeMap<String, Value>, BTreeSet<String>)> {
        resolve_variables(&all_model(), &serde_json::from_value(values).unwrap())
    }

    #[test]
    fn all_is_a_list_of_values_or_the_custom_value_as_one_value() {
        // "All" of a custom variable is the list of its options, each one checked.
        let (values, checked) = resolve(json!({ "region": ["nord", "sued"] })).unwrap();
        assert_eq!(values["region"], json!(["nord", "sued"]));
        assert!(checked.contains("region"));
        // The custom value for "All" passes as the one value it is, and counts as checked; any
        // other value outside the options does not.
        let (values, checked) = resolve(json!({ "env": "%", "job": ".*" })).unwrap();
        assert_eq!(values["env"], json!("%"));
        assert!(checked.contains("env") && checked.contains("job"));
        assert!(resolve(json!({ "env": "_" })).is_err());
        assert!(resolve(json!({ "env": ["%", "prod"] })).is_err());
        // A query variable's other values stay free: bound, not checked.
        let (_, checked) = resolve(json!({ "job": ["api", ".*"] })).unwrap();
        assert!(!checked.contains("job"));
        // The marker itself is no option: the browser resolves "All" before it sends.
        assert!(resolve(json!({ "region": "$__all" })).is_err());
    }

    /// Only the query variables the queries about to run use, and those they use in turn, are
    /// read for "All"; a selection the server fills in never reaches the checks of a save.
    #[test]
    fn all_reads_only_the_variables_in_use() {
        let model = model::parse(json!({
            "schemaVersion": 2, "title": "Alle", "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "env", "type": "query", "datasourceId": "ds", "query": { "sql": "SELECT env" },
                  "includeAll": true },
                { "name": "job", "type": "query", "datasourceId": "ds",
                  "query": { "sql": "SELECT job WHERE env IN (${env:csv})" }, "includeAll": true },
                { "name": "fern", "type": "query", "datasourceId": "ds", "query": { "sql": "SELECT 1" },
                  "includeAll": true },
                { "name": "region", "type": "custom", "options": ["nord"], "includeAll": true }
            ]
        }))
        .unwrap();
        let used = needed_variables(&model, &json!([{ "sql": "SELECT * WHERE job IN ($job) AND x = $1" }]));
        assert_eq!(used, BTreeSet::from(["env".to_string(), "job".to_string()]));
        assert!(mentioned_names(&json!("$__all ${a} $9 $")).contains("__all"));
        let values: BTreeMap<String, Value> = serde_json::from_value(json!({
            "job": "$__all", "region": ["$__all"], "fern": "x"
        }))
        .unwrap();
        assert_eq!(without_all(&model, &values), BTreeMap::from([("fern".to_string(), json!("x"))]));
    }

    #[test]
    fn typed_values_pass_only_with_allow_custom_and_stay_unchecked() {
        let (values, checked) = resolve(json!({ "host": "b'; --" })).unwrap();
        assert_eq!(values["host"], json!("b'; --"));
        assert!(!checked.contains("host"));
        let (_, checked) = resolve(json!({ "host": "a" })).unwrap();
        assert!(checked.contains("host"));
    }

    /// How the values reach the database: a list is one bound parameter per value in SQL and a
    /// pattern of escaped values in PromQL; the custom value for "All" is one parameter.
    #[test]
    fn all_lists_and_the_custom_value_render_as_parameters() {
        use crate::datasources::sql::{Bind, Context, Engine, prepare};
        let (values, checked) = resolve(json!({ "region": ["nord", "sued"], "env": "%" })).unwrap();
        let ctx = Context {
            range: crate::shapes::TimeRange { from: 0, to: 1 },
            interval_ms: 1,
            variables: &values,
            identifiers: None,
            identifier_variables: Some(&checked),
        };
        let p = prepare("SELECT * FROM t WHERE region IN ($region) AND env LIKE $env", Engine::Postgres, &ctx).unwrap();
        assert_eq!(p.sql, "SELECT * FROM t WHERE region IN ($1, $2) AND env LIKE $3");
        assert_eq!(p.binds, [Bind::Text("nord".into()), Bind::Text("sued".into()), Bind::Text("%".into())]);

        let (values, checked) = resolve(json!({ "job": ["a.b", "c|d"] })).unwrap();
        let expr = crate::datasources::prometheus::expand_for_test("up{job=~\"$job\"}", &values, &checked);
        assert_eq!(expr.unwrap(), r#"up{job=~"a\\.b|c\\|d"}"#);
        let (values, checked) = resolve(json!({ "job": ".*" })).unwrap();
        let expr = crate::datasources::prometheus::expand_for_test("up{job=~\"$job\"}", &values, &checked);
        assert_eq!(expr.unwrap(), r#"up{job=~".*"}"#);
    }
}
