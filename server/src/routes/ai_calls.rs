//! The plain AI calls (docs/api/ai.md, "Explain, draft and summarize"): explain a query, draft one
//! from a request, and summarize a result of Explore or of a dashboard panel. Every call goes
//! through `ai::service` (switch, provider, notice, limits, audit) with the signed-in user's
//! rights, and every piece of a data source goes through `ai::redact`: a schema only for a source
//! open to AI, a result only from such a source, with its excluded values replaced and cut to the
//! row limit. A drafted query is only returned; nothing here runs it.
//!
//! Answers stream as server-sent events (`text/event-stream`): `meta` first (what was sent, to
//! which provider), then `text` deltas, then `done` (with the draft for a draft) or `error`. A
//! refusal before the call starts (rights, AI off, notice, limits) is an ordinary JSON error. The
//! client cancels by closing the request; the call is then stopped, counted and audited.

use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::Extension;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::table::{RouteDef, route};
use crate::ai::prompts::{self, Language, Prompt, ResultPart};
use crate::ai::service::{self, Caller};
use crate::ai::store::ProviderRow;
use crate::ai::{ChatEvent, ChatRequest, Usage, redact};
use crate::analysis::steps::{Control, Input, run_shapes};
use crate::analysis::{Step, check_steps};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::datasources::{Datasource, check_interval, check_items, check_range, find_in_org, run_queries_with};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::{QueryItem, QueryOutcome, QueryResponse, QueryResult, TimeRange};

pub fn routes() -> Vec<RouteDef> {
    vec![
        // `datasources:query` on the source (role or grant), checked in the handlers.
        route(Method::POST, "/orgs/{orgId}/ai/explain", Access::OrgMember, explain),
        route(Method::POST, "/orgs/{orgId}/ai/draft", Access::OrgMember, draft),
        route(Method::POST, "/orgs/{orgId}/ai/summarize", Access::OrgMember, summarize),
        // `dashboards:read` on the dashboard, as its stored queries.
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/ai/summarize",
            Access::OrgMember,
            summarize_panel,
        ),
    ]
}

/// The longest request text of a draft, in characters.
const MAX_REQUEST_CHARS: usize = 4000;
/// The longest query, as JSON text.
const MAX_QUERY_BYTES: usize = 100 * 1024;

fn caller(ctx: &OrgCtx, info: &RequestInfo, prompt: &Prompt) -> Caller {
    Caller {
        org_id: ctx.org_id.clone(),
        user_id: ctx.user.id.clone(),
        address: Some(info.client_ip.to_string()),
        purpose: prompt.purpose,
        prompt_version: Some(prompt.version),
    }
}

fn check_query(query: &Value) -> ApiResult<()> {
    if serde_json::to_string(query).map_or(usize::MAX, |s| s.len()) > MAX_QUERY_BYTES {
        return Err(ApiError::validation(format!("query exceeds {MAX_QUERY_BYTES} bytes"))
            .with_field("query")
            .because("ai.query_too_large")
            .param("bytes", MAX_QUERY_BYTES));
    }
    Ok(())
}

/// A source of the organization the caller may run free queries on.
async fn queryable(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<Datasource> {
    let ds = find_in_org(&state.db, &ctx.org_id, id, false).await?;
    check_resource(&state.db, ctx, Permission::DatasourcesQuery, Resource::Datasource(&ds.id)).await?;
    Ok(ds)
}

/// The schema of a source as a prompt may carry it: only for a source open to AI (else `None`,
/// and only the query text goes out). A schema that cannot be read is left out as well.
async fn schema_for(state: &AppState, ctx: &OrgCtx, ds: &Datasource) -> ApiResult<Option<Value>> {
    let policy = redact::policy(state, &ds.id).await?;
    if !policy.readable {
        return Ok(None);
    }
    match crate::datasources::read_schema(state, &ctx.user.id, ds).await {
        Ok(schema) => Ok(redact::schema_for_model(&policy, &schema)),
        Err(e) => {
            tracing::debug!("the schema of {} for an AI call could not be read: {}", ds.id, e.message);
            Ok(None)
        }
    }
}

/// Who answers, for the `meta` event: the name, kind, model and the host data goes to.
pub(crate) fn provider_meta(row: &ProviderRow) -> Value {
    let host = url::Url::parse(&row.base_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    json!({
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "model": row.model,
        "host": host,
        "scope": if row.org_id.is_some() { "org" } else { "server" },
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExplainBody {
    datasource_id: String,
    #[serde(default)]
    query: Value,
    #[serde(default)]
    language: Language,
}

async fn explain(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ExplainBody>,
) -> ApiResult<Response> {
    check_query(&body.query)?;
    if prompts::query_text(&body.query).trim().is_empty() || body.query == json!({}) {
        return Err(ApiError::validation("there is no query to explain").with_field("query").because("ai.query_empty"));
    }
    let ds = queryable(&state, &ctx, &body.datasource_id).await?;
    let caller = caller(&ctx, &info, &prompts::EXPLAIN);
    let row = service::precheck(&state, &caller).await?;
    let schema = schema_for(&state, &ctx, &ds).await?;
    let request =
        prompts::EXPLAIN.request(body.language, prompts::explain_message(&ds.kind, &body.query, schema.as_ref()));
    let meta = json!({ "provider": provider_meta(&row), "schema": schema.is_some() });
    respond(&state, &caller, &request, meta, Finish::Text).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftBody {
    datasource_id: String,
    request: String,
    /// The query in the editor now, as context.
    #[serde(default)]
    query: Option<Value>,
    #[serde(default)]
    language: Language,
}

async fn draft(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<DraftBody>,
) -> ApiResult<Response> {
    let text = body.request.trim();
    if text.is_empty() || text.chars().count() > MAX_REQUEST_CHARS || text.chars().any(|c| c.is_control() && c != '\n')
    {
        return Err(ApiError::validation(format!("request needs 1 to {MAX_REQUEST_CHARS} characters"))
            .with_field("request")
            .because("ai.request_invalid")
            .param("max", MAX_REQUEST_CHARS));
    }
    if let Some(query) = &body.query {
        check_query(query)?;
    }
    let ds = queryable(&state, &ctx, &body.datasource_id).await?;
    let caller = caller(&ctx, &info, &prompts::DRAFT);
    let row = service::precheck(&state, &caller).await?;
    let schema = schema_for(&state, &ctx, &ds).await?;
    let message = prompts::draft_message(&ds.kind, text, body.query.as_ref(), schema.as_ref());
    let request = prompts::DRAFT.request(body.language, message);
    let meta = json!({ "provider": provider_meta(&row), "schema": schema.is_some() });
    respond(&state, &caller, &request, meta, Finish::Draft { kind: ds.kind }).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SummarizeBody {
    query: QueryItem,
    time_range: TimeRange,
    #[serde(default)]
    interval_ms: Option<u64>,
    #[serde(default)]
    max_data_points: Option<u32>,
    #[serde(default)]
    variables: BTreeMap<String, Value>,
    #[serde(default)]
    language: Language,
}

/// A result of Explore: the query runs again here, as the caller, so the summary rests on what the
/// caller may see and not on what a client sends.
async fn summarize(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SummarizeBody>,
) -> ApiResult<Response> {
    check_range(body.time_range)?;
    check_interval(body.interval_ms)?;
    super::query::check_variables(&body.variables)?;
    check_query(&body.query.query)?;
    let items = vec![body.query];
    check_items(&items)?;
    crate::datasources::check_item_steps(&items)?;
    queryable(&state, &ctx, &items[0].datasource_id).await?;
    let caller = caller(&ctx, &info, &prompts::SUMMARIZE);
    let request = SummaryRun {
        title: None,
        items,
        range: body.time_range,
        interval_ms: body.interval_ms,
        max_data_points: body.max_data_points,
        variables: body.variables,
        identifiers: None,
        language: body.language,
        steps: Vec::new(),
        hidden: BTreeSet::new(),
    };
    summarize_run(&state, &ctx, &caller, request).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PanelSummarizeBody {
    time_range: TimeRange,
    #[serde(default)]
    interval_ms: Option<u64>,
    #[serde(default)]
    max_data_points: Option<u32>,
    #[serde(default)]
    variables: BTreeMap<String, Value>,
    #[serde(default)]
    language: Language,
}

/// A panel of a dashboard the caller may read: its stored queries only, as the panel runs them,
/// and the result as the panel shows it: after its own steps (transformations), without hidden
/// queries that only feed a step.
async fn summarize_panel(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(body): JsonBody<PanelSummarizeBody>,
) -> ApiResult<Response> {
    check_range(body.time_range)?;
    check_interval(body.interval_ms)?;
    let model = super::query::readable_model(&state, &ctx, &dashboard_id).await?;
    let panel = model.panels.iter().find(|p| p.id == panel_id).ok_or_else(ApiError::not_found)?;
    let title = panel.title.clone();
    let linked = crate::dashboards::linked_content(&state.db, &ctx.org_id, panel).await?;
    let panel = linked.as_ref().unwrap_or(panel);
    let run = super::query::stored_items(&model, panel, &body.variables, None, &BTreeMap::new())?;
    if run.items.is_empty() {
        return Err(ApiError::validation("the panel has no query to summarize").because("ai.query_empty"));
    }
    check_items(&run.items)?;
    let refs: BTreeSet<&str> = panel.targets.iter().map(|t| t.ref_id.as_str()).collect();
    // Checked when the dashboard was saved; failing here means the stored model is broken.
    let steps = check_steps(&panel.transformations, &refs, "transformations")
        .map_err(|e| ApiError::internal("ai", format!("stored steps of panel {panel_id}: {e}")))?;
    let hidden = panel.targets.iter().filter(|t| t.hide).map(|t| t.ref_id.clone()).collect();
    let caller = caller(&ctx, &info, &prompts::SUMMARIZE);
    let request = SummaryRun {
        title: Some(title),
        items: run.items,
        range: body.time_range,
        interval_ms: body.interval_ms,
        max_data_points: body.max_data_points,
        variables: run.variables,
        identifiers: Some(run.identifiers),
        language: body.language,
        steps: steps.into_iter().filter(|s| !s.disabled).collect(),
        hidden,
    };
    summarize_run(&state, &ctx, &caller, request).await
}

struct SummaryRun {
    title: Option<String>,
    items: Vec<QueryItem>,
    range: TimeRange,
    interval_ms: Option<u64>,
    max_data_points: Option<u32>,
    variables: BTreeMap<String, Value>,
    identifiers: Option<BTreeSet<String>>,
    language: Language,
    /// The panel's enabled steps; the summary reads their frames. Empty in Explore, whose steps
    /// run in the browser: there the query's own result is summarized.
    steps: Vec<Step>,
    /// Queries the panel does not show (they only feed a step).
    hidden: BTreeSet<String>,
}

/// Refuses a source closed to AI. Its name and id are said only to someone who may read the
/// source; a viewer of a panel learns only that a source of the panel is closed.
async fn closed(state: &AppState, ctx: &OrgCtx, ds: &Datasource) -> ApiError {
    let named = check_resource(&state.db, ctx, Permission::DatasourcesRead, Resource::Datasource(&ds.id)).await.is_ok();
    if named {
        ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "ai_unavailable",
            format!("the data source {} is not open to AI", ds.name),
        )
        .because("ai.datasource_not_readable")
        .param("name", &ds.name)
        .param("datasourceId", &ds.id)
    } else {
        ApiError::new(
            axum::http::StatusCode::CONFLICT,
            "ai_unavailable",
            "a data source of this panel is not open to AI",
        )
        .because("ai.datasource_not_readable")
    }
}

/// Checks that every source is open to AI and AI would answer, runs the queries as the caller,
/// runs a panel's steps on the server as its export does, passes the results through
/// `ai::redact` and streams the summary.
async fn summarize_run(state: &AppState, ctx: &OrgCtx, caller: &Caller, run: SummaryRun) -> ApiResult<Response> {
    let mut policies = BTreeMap::new();
    let mut kinds = BTreeMap::new();
    for item in &run.items {
        if policies.contains_key(&item.datasource_id) {
            continue;
        }
        let ds = find_in_org(&state.db, &ctx.org_id, &item.datasource_id, false).await?;
        let policy = redact::policy(state, &ds.id).await?;
        if !policy.readable {
            return Err(closed(state, ctx, &ds).await);
        }
        kinds.insert(ds.id.clone(), ds.kind.clone());
        policies.insert(ds.id, policy);
    }
    let row = service::precheck(state, caller).await?;
    let order: Vec<String> = run.items.iter().map(|i| i.ref_id.clone()).collect();
    let queries: BTreeMap<String, (String, Value)> =
        run.items.iter().map(|i| (i.ref_id.clone(), (i.datasource_id.clone(), i.query.clone()))).collect();
    let QueryResponse { mut results } = run_queries_with(
        state,
        ctx,
        run.items,
        run.range,
        run.interval_ms,
        run.max_data_points,
        &run.variables,
        run.identifiers.as_ref(),
    )
    .await;
    // What the summary reads: (name, the query it is the result of, the result).
    let mut shown: Vec<(String, Option<String>, QueryResult)> = Vec::new();
    let mut first_error = None;
    let with_steps = !run.steps.is_empty();
    if !with_steps {
        for ref_id in &order {
            match results.remove(ref_id) {
                Some(QueryOutcome::Ok { result, .. }) if !run.hidden.contains(ref_id) => {
                    shown.push((ref_id.clone(), Some(ref_id.clone()), result));
                }
                Some(QueryOutcome::Err { error }) => {
                    first_error.get_or_insert(error);
                }
                _ => {}
            }
        }
    } else {
        // The steps read every query, as the panel's do: one that failed fails the summary.
        let mut inputs = Vec::new();
        let mut done = BTreeSet::new();
        for ref_id in &order {
            match results.remove(ref_id) {
                Some(QueryOutcome::Ok { result, steps: ran, .. }) => {
                    done.extend(ran.into_iter().flatten().filter(|p| p.error.is_none()).map(|p| p.id));
                    inputs.push((
                        ref_id.clone(),
                        match result {
                            QueryResult::Frame { frame } => Input::Frame(frame),
                            QueryResult::Documents { documents } => Input::Documents(documents),
                            QueryResult::Graph { graph } => Input::Graph(graph),
                        },
                    ));
                }
                Some(QueryOutcome::Err { error }) => return Err(super::query::api_error(error)),
                None => return Err(ApiError::internal("ai", format!("no outcome for {ref_id}"))),
            }
        }
        let timeout = crate::settings::get(state, "datasources.query_timeout_secs").await?.as_u64().unwrap_or(30);
        let steps = run.steps;
        // Steps take CPU time; they run off the request threads, stopped when the request goes.
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let _stop = StopOnDrop(cancelled);
        let (frames, graphs) =
            tokio::task::spawn_blocking(move || run_shapes(&steps, inputs, &Control::new(flag, timeout), &done))
                .await
                .map_err(|e| ApiError::internal("ai", e))?
                .map_err(|f| {
                    ApiError::validation(format!("step {}: {}", f.index + 1, f.detail.message))
                        .with_reason(f.detail.reason, f.detail.params)
                })?;
        for frame in frames {
            if !run.hidden.contains(&frame.name) {
                let query = queries.contains_key(&frame.name).then(|| frame.name.clone());
                shown.push((frame.name, query, QueryResult::Frame { frame: frame.frame }));
            }
        }
        for (name, graph) in graphs {
            if !run.hidden.contains(&name) {
                let query = queries.contains_key(&name).then(|| name.clone());
                shown.push((name, query, QueryResult::Graph { graph }));
            }
        }
    }
    // A frame the steps made may combine several sources: the rules of all of them apply.
    let all = redact::DataPolicy::merged(policies.values());
    let mut parts = Vec::new();
    let mut sent = Vec::new();
    for (name, query, result) in shown {
        let source = query.as_ref().and_then(|q| queries.get(q));
        let policy = match source {
            Some((datasource_id, _)) if !with_steps => &policies[datasource_id],
            _ => &all,
        };
        let for_model = redact::result_for_model(policy, &result)?;
        sent.push(json!({
            "refId": prompts::identifier(&name),
            "rows": for_model.rows,
            "truncated": for_model.truncated,
            "excludedValues": for_model.excluded_values,
        }));
        parts.push(ResultPart {
            ref_id: name,
            query: source.map(|(datasource_id, q)| (kinds[datasource_id].clone(), q.clone())),
            data: for_model.value,
            rows: for_model.rows,
            truncated: for_model.truncated,
        });
    }
    if parts.is_empty() {
        return Err(match first_error {
            Some(error) => super::query::api_error(error),
            None => ApiError::validation("the panel has no query to summarize").because("ai.query_empty"),
        });
    }
    let range = format!("{} to {}", iso(run.range.from), iso(run.range.to));
    let message = prompts::summarize_message(run.title.as_deref(), &range, &parts);
    let request = prompts::SUMMARIZE.request(run.language, message);
    let meta = json!({ "provider": provider_meta(&row), "results": sent, "title": run.title.is_some() });
    respond(state, caller, &request, meta, Finish::Text).await
}

/// Sets the flag when dropped: steps still running for a request that went away stop.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| ms.to_string())
}

/// What the `done` event carries besides the usage.
enum Finish {
    Text,
    /// The query of the answer, in the query form of a source of this kind.
    Draft {
        kind: String,
    },
}

type Events = Pin<Box<dyn Stream<Item = Result<ChatEvent, ApiError>> + Send>>;

enum Phase {
    Meta(Value),
    Body,
    End,
}

struct Run {
    phase: Phase,
    events: Events,
    text: String,
    usage: Option<Usage>,
    finish: Finish,
}

fn json_event(name: &str, data: &Value) -> Event {
    Event::default().event(name).data(data.to_string())
}

/// Starts the call and answers its events as server-sent events. A refusal before the provider
/// answered is an ordinary error response.
async fn respond(
    state: &AppState,
    caller: &Caller,
    request: &ChatRequest,
    meta: Value,
    finish: Finish,
) -> ApiResult<Response> {
    // Cancelling relies on dropping: when the client closes the request, axum drops the body and
    // with it this stream, which drops the service's stream; its task then cancels the provider
    // call and settles and audits it as `cancelled` (`ai::service::stream`). The token here is
    // never fired itself.
    let events = service::stream(state, caller, request, &CancellationToken::new()).await?;
    let run = Run { phase: Phase::Meta(meta), events: Box::pin(events), text: String::new(), usage: None, finish };
    let stream = futures_util::stream::unfold(run, |mut run| async move {
        loop {
            match std::mem::replace(&mut run.phase, Phase::Body) {
                Phase::Meta(meta) => return Some((Ok::<_, Infallible>(json_event("meta", &meta)), run)),
                Phase::End => return None,
                Phase::Body => {}
            }
            match run.events.next().await {
                Some(Ok(ChatEvent::Text(text))) => {
                    run.text.push_str(&text);
                    return Some((Ok(json_event("text", &json!({ "text": text }))), run));
                }
                Some(Ok(ChatEvent::Usage(usage))) => run.usage = Some(usage),
                Some(Ok(ChatEvent::ToolCall { .. } | ChatEvent::Done(_))) => {}
                Some(Err(e)) => {
                    run.phase = Phase::End;
                    let body = crate::datasources::api_error_body(e);
                    return Some((Ok(json_event("error", &json!({ "error": body }))), run));
                }
                None => {
                    run.phase = Phase::End;
                    let mut done = json!({});
                    if let Some(usage) = run.usage {
                        done["usage"] = json!(usage);
                    }
                    if let Finish::Draft { kind } = &run.finish {
                        let text = prompts::draft_text(&run.text);
                        done["draft"] = prompts::draft_query(kind, &text).unwrap_or(Value::Null);
                        done["draftText"] = json!(text);
                    }
                    return Some((Ok(json_event("done", &done)), run));
                }
            }
        }
    });
    let mut response = Sse::new(stream).keep_alive(KeepAlive::default()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    // Proxies such as nginx pass the events on as they come.
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}
