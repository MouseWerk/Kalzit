//! The agent chat "Fragen" (docs/api/ai.md, "Chat"): the caller's own chats, and a question that
//! the model answers with the read-only tools of `ai::tools`. Every round of the answer is one
//! call through `ai::service` (switch, provider, notice, limits, audit as `ai.called` with the
//! purpose `chat`), and every tool call is authorized on its own with the caller's rights and
//! audited as `ai.tool_called`. A chat is the caller's alone: another person's chat is not found.
//!
//! The answer streams as server-sent events: `meta` (the chat and the provider), `text` deltas,
//! `tool` when a tool call starts and `toolResult` when it ends (with the record the chat shows),
//! then `done` (tokens, outcome) or `error`. The answer runs in a task of its own, so it is stored
//! with what it reached also when the person stops it by closing the request (`stopped`).

use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::{LazyLock, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::support::QueryParams;
use super::table::{RouteDef, route};
use crate::ai::chats::{self, Call, ChatRow, DAY_MS, Question, Round, StoredMessage, Turn};
use crate::ai::prompts::{CHAT, Language};
use crate::ai::service::{self, Caller};
use crate::ai::tools::{self, ToolRecord, ToolScope};
use crate::ai::{ChatEvent, ChatRequest, Message, Part, Role, Usage};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/ai/chats", OrgMember, list),
        route(Method::POST, "/orgs/{orgId}/ai/chats", OrgMember, create),
        route(Method::DELETE, "/orgs/{orgId}/ai/chats", OrgMember, delete_all),
        route(Method::GET, "/orgs/{orgId}/ai/chats/{chatId}", OrgMember, get_one),
        route(Method::DELETE, "/orgs/{orgId}/ai/chats/{chatId}", OrgMember, delete_one),
        route(Method::POST, "/orgs/{orgId}/ai/chats/{chatId}/messages", OrgMember, ask),
    ]
}

/// The longest question, in characters.
const MAX_QUESTION_CHARS: usize = 4000;
/// The most sources one chat may be narrowed to.
const MAX_SELECTION: usize = 50;
const DEFAULT_LIST_LIMIT: i64 = 50;
const MAX_LIST_LIMIT: i64 = 200;

/// Chats answering right now: a second question to the same chat waits until the first ends.
static RUNNING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

struct RunningChat(String);

impl RunningChat {
    fn take(id: &str) -> ApiResult<Self> {
        let mut running = RUNNING.lock().expect("running chats lock");
        if !running.insert(id.to_string()) {
            return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "this chat is answering a question already")
                .because("ai.chat_busy"));
        }
        Ok(Self(id.to_string()))
    }
}

impl Drop for RunningChat {
    fn drop(&mut self) {
        RUNNING.lock().expect("running chats lock").remove(&self.0);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSummary {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    /// When the retention job deletes the chat unless it is used again.
    expires_at: i64,
    /// The chosen sources the caller may still read: `{id, name, kind}`.
    datasources: Vec<Value>,
    datasource_ids: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatList {
    items: Vec<ChatSummary>,
    /// Days a chat is kept after its last message, for this caller's organization.
    retention_days: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatView {
    #[serde(flatten)]
    summary: ChatSummary,
    messages: Vec<StoredMessage>,
}

fn summary(chat: ChatRow, retention_days: u64, visible: &[tools::UsableSource]) -> ChatSummary {
    // Only the chosen sources the caller may still read: one deleted or out of reach since would
    // make the next question fail, and the composer could not take it off.
    let selection: Vec<String> =
        chat.selection().into_iter().filter(|id| visible.iter().any(|s| &s.id == id)).collect();
    let keep = i64::try_from(retention_days).unwrap_or(i64::MAX / DAY_MS);
    ChatSummary {
        datasources: chats::names_of(&selection, visible),
        datasource_ids: selection,
        expires_at: chat.updated_at.saturating_add(keep.saturating_mul(DAY_MS)),
        id: chat.id,
        title: chat.title,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListParams {
    q: Option<String>,
    limit: Option<i64>,
}

async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(params): QueryParams<ListParams>,
) -> ApiResult<Json<ChatList>> {
    let limit = params.limit.unwrap_or(DEFAULT_LIST_LIMIT);
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return Err(ApiError::validation(format!("limit must be 1 to {MAX_LIST_LIMIT}"))
            .with_field("limit")
            .because("request.limit")
            .param("max", MAX_LIST_LIMIT));
    }
    let retention_days = service::chat_retention_days(&state, &ctx.org_id).await?;
    let visible = tools::visible_sources(&state, &ctx).await?;
    let rows = chats::list_own(&state, &ctx, params.q.as_deref(), limit).await?;
    let items = rows.into_iter().map(|row| summary(row, retention_days, &visible)).collect();
    Ok(Json(ChatList { items, retention_days }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    #[serde(default)]
    datasource_ids: Vec<String>,
}

/// The sources chosen in the composer: each one the caller may read or query; at most
/// `MAX_SELECTION`, without duplicates.
async fn check_selection(state: &AppState, ctx: &OrgCtx, ids: Vec<String>) -> ApiResult<Vec<String>> {
    if ids.len() > MAX_SELECTION {
        return Err(ApiError::validation(format!("datasourceIds takes at most {MAX_SELECTION} sources"))
            .with_field("datasourceIds")
            .because("ai.chat_sources_invalid")
            .param("max", MAX_SELECTION));
    }
    if ids.is_empty() {
        return Ok(ids);
    }
    let visible = tools::visible_sources(state, ctx).await?;
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !visible.iter().any(|s| s.id == id) {
            return Err(ApiError::not_found());
        }
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

fn caller(ctx: &OrgCtx, info: &RequestInfo) -> Caller {
    Caller {
        org_id: ctx.org_id.clone(),
        user_id: ctx.user.id.clone(),
        address: Some(info.client_ip.to_string()),
        purpose: CHAT.purpose,
        prompt_version: Some(CHAT.version),
    }
}

/// A new, empty chat. Only while AI is usable for the caller (switch, provider, notice).
async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateBody>,
) -> ApiResult<(StatusCode, Json<ChatView>)> {
    service::precheck(&state, &caller(&ctx, &info)).await?;
    let selection = check_selection(&state, &ctx, body.datasource_ids).await?;
    let row = chats::create(&state, &ctx, &selection).await?;
    let retention_days = service::chat_retention_days(&state, &ctx.org_id).await?;
    let visible = tools::visible_sources(&state, &ctx).await?;
    Ok((StatusCode::CREATED, Json(ChatView { summary: summary(row, retention_days, &visible), messages: Vec::new() })))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, chat_id)): Path<(String, String)>,
) -> ApiResult<Json<ChatView>> {
    let row = chats::find_own(&state, &ctx, &chat_id).await?;
    let retention_days = service::chat_retention_days(&state, &ctx.org_id).await?;
    let visible = tools::visible_sources(&state, &ctx).await?;
    let messages = chats::visible_messages(&state, &ctx, &row.id).await?;
    Ok(Json(ChatView { summary: summary(row, retention_days, &visible), messages }))
}

async fn delete_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, chat_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    if chats::delete_own(&state, &ctx, Some(&chat_id)).await? == 0 {
        return Err(ApiError::not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes all of the caller's chats in the organization.
async fn delete_all(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<StatusCode> {
    chats::delete_own(&state, &ctx, None).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskBody {
    text: String,
    /// Replaces the chat's sources; absent keeps them.
    #[serde(default)]
    datasource_ids: Option<Vec<String>>,
    /// A dashboard the question is about ("Dashboard als Kontext"); needs `dashboards:read`.
    #[serde(default)]
    dashboard_id: Option<String>,
    #[serde(default)]
    language: Language,
}

/// The most panels of a context dashboard the model is told about.
const MAX_CONTEXT_PANELS: usize = 100;

/// A dashboard as the context of a question: readable for the caller (else not found), with its
/// panels' ids, titles and types.
async fn dashboard_context(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<chats::DashboardContext> {
    let model = super::query::readable_model(state, ctx, id).await?;
    let panels = model
        .panels
        .iter()
        .filter(|p| !p.targets.is_empty() || p.library_panel_id.is_some())
        .take(MAX_CONTEXT_PANELS)
        .map(|p| json!({ "panelId": p.id, "title": p.title, "type": p.kind }))
        .collect();
    Ok(chats::DashboardContext { id: id.to_string(), title: model.title, panels })
}

/// A question to a chat: stored, then answered by the model with its tools, streamed.
async fn ask(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, chat_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<AskBody>,
) -> ApiResult<Response> {
    let text = body.text.trim().to_string();
    if text.is_empty()
        || text.chars().count() > MAX_QUESTION_CHARS
        || text.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(ApiError::validation(format!("text needs 1 to {MAX_QUESTION_CHARS} characters"))
            .with_field("text")
            .because("ai.request_invalid")
            .param("max", MAX_QUESTION_CHARS));
    }
    let chat = chats::find_own(&state, &ctx, &chat_id).await?;
    let selection = match body.datasource_ids {
        Some(ids) => check_selection(&state, &ctx, ids).await?,
        // The chat's own, of which the caller may since have lost some.
        None => {
            let visible = tools::visible_sources(&state, &ctx).await?;
            chat.selection().into_iter().filter(|id| visible.iter().any(|s| &s.id == id)).collect()
        }
    };
    let caller = caller(&ctx, &info);
    // The switch, provider, notice and limits before anything is stored or sent.
    let row = service::precheck(&state, &caller).await?;
    let running = RunningChat::take(&chat.id)?;
    let dashboard = match body.dashboard_id.as_deref() {
        Some(id) => Some(dashboard_context(&state, &ctx, id).await?),
        None => None,
    };
    let question = Question { text, datasource_ids: selection.clone(), dashboard };
    chats::append(&state, &chat, "user", &json!(question), Some(&selection)).await?;
    let history = chats::conversation(&state, &ctx, &chat.id).await?;
    let max_calls = service::max_tool_calls(&state).await?;
    let (tx, rx) = mpsc::channel::<Event>(64);
    let run = AgentRun {
        state,
        ctx,
        caller,
        chat,
        selection,
        history,
        language: body.language,
        max_calls,
        provider: super::ai_calls::provider_meta(&row),
        address: Some(info.client_ip.to_string()),
        _running: running,
    };
    tokio::spawn(run.run(tx));
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|event| (Ok::<_, Infallible>(event), rx))
    });
    let mut response = Sse::new(stream).keep_alive(KeepAlive::default()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(response)
}

fn json_event(name: &str, data: &Value) -> Event {
    Event::default().event(name).data(data.to_string())
}

/// One answer being worked out, in its own task.
struct AgentRun {
    state: AppState,
    ctx: OrgCtx,
    caller: Caller,
    chat: ChatRow,
    selection: Vec<String>,
    /// The conversation so far, ending with the new question.
    history: Vec<Message>,
    language: Language,
    max_calls: usize,
    provider: Value,
    address: Option<String>,
    // Held, not read: the chat takes the next question once this answer is stored.
    _running: RunningChat,
}

/// What a call over the limit gets back.
fn limit_record(max: usize) -> ToolRecord {
    let error = ApiError::new(
        StatusCode::CONFLICT,
        "ai_unavailable",
        format!("The limit of {max} tool calls for this answer is reached. Answer now with what you have."),
    )
    .because("ai.chat_tool_limit")
    .param("max", max);
    ToolRecord { status: "error".into(), error: Some(crate::datasources::api_error_body(error)), ..Default::default() }
}

fn add_usage(total: &mut Usage, more: Usage) {
    total.input_tokens = total.input_tokens.saturating_add(more.input_tokens);
    total.output_tokens = total.output_tokens.saturating_add(more.output_tokens);
}

impl AgentRun {
    async fn run(self, tx: mpsc::Sender<Event>) {
        let mut turn = Turn { outcome: "ok".into(), provider: Some(self.provider.clone()), ..Default::default() };
        let _ = tx.send(json_event("meta", &json!({ "chatId": self.chat.id, "provider": self.provider }))).await;
        let used = self.answer(&tx, &mut turn).await;
        let content = serde_json::to_value(&turn).unwrap_or(Value::Null);
        if let Err(e) = chats::append(&self.state, &self.chat, "assistant", &content, None).await {
            // The chat was deleted while it answered.
            tracing::debug!("the answer of an AI chat was not stored: {}", e.message);
        }
        let mut done = json!({ "usage": turn.usage, "outcome": turn.outcome, "toolCalls": used });
        if let Some(error) = &turn.error {
            done["error"] = json!(error);
        }
        let _ = tx.send(json_event("done", &done)).await;
    }

    /// Runs the rounds of the answer into `turn`; answers the number of tool calls made.
    async fn answer(&self, tx: &mpsc::Sender<Event>, turn: &mut Turn) -> usize {
        let system = CHAT.system(self.language);
        let definitions = tools::definitions();
        let mut messages = self.history.clone();
        let cancel = CancellationToken::new();
        let mut used = 0usize;
        let mut ids = HashSet::new();
        // The round after the limit was reached is the model's last chance to answer in words.
        let mut after_limit = false;
        let scope = ToolScope {
            state: &self.state,
            ctx: &self.ctx,
            selection: &self.selection,
            chat_id: &self.chat.id,
            address: self.address.clone(),
        };
        for _ in 0..self.max_calls.saturating_add(2) {
            // Results of this answer add up too; the oldest go first when they grow too large.
            chats::trim(&mut messages);
            let request = ChatRequest {
                system: Some(system.clone()),
                messages: messages.clone(),
                tools: definitions.clone(),
                max_tokens: Some(CHAT.max_tokens),
                temperature: Some(0.2),
            };
            let events = match service::stream(&self.state, &self.caller, &request, &cancel).await {
                Ok(events) => events,
                Err(e) => {
                    let body = crate::datasources::api_error_body(e);
                    let _ = tx.send(json_event("error", &json!({ "error": body }))).await;
                    turn.outcome = "failed".into();
                    turn.error = Some(body);
                    return used;
                }
            };
            let mut events = std::pin::pin!(events);
            let mut round = Round::default();
            let mut calls = Vec::new();
            let mut usage = Usage::default();
            loop {
                let next = tokio::select! {
                    () = tx.closed() => {
                        turn.outcome = "stopped".into();
                        break;
                    }
                    next = events.next() => next,
                };
                match next {
                    None => break,
                    Some(Ok(ChatEvent::Text(text))) => {
                        round.text.push_str(&text);
                        let _ = tx.send(json_event("text", &json!({ "text": text }))).await;
                    }
                    Some(Ok(ChatEvent::ToolCall { id, name, arguments })) => {
                        // Compatible servers may send no id, or the same one twice.
                        let id =
                            if id.is_empty() || ids.contains(&id) { format!("call_{}", ids.len() + 1) } else { id };
                        ids.insert(id.clone());
                        calls.push((id, name, arguments));
                    }
                    Some(Ok(ChatEvent::Usage(u))) => usage = u,
                    Some(Ok(ChatEvent::Done(_))) => {}
                    Some(Err(e)) => {
                        let body = crate::datasources::api_error_body(e);
                        let _ = tx.send(json_event("error", &json!({ "error": body }))).await;
                        turn.outcome = "failed".into();
                        turn.error = Some(body);
                        break;
                    }
                }
            }
            add_usage(&mut turn.usage, usage);
            if turn.outcome != "ok" || calls.is_empty() {
                // Calls of an answer cut short are kept as stopped, so the conversation stays whole.
                round.calls =
                    calls.into_iter().map(|(id, name, arguments)| Call { id, name, arguments, record: None }).collect();
                if !round.text.is_empty() || !round.calls.is_empty() {
                    turn.rounds.push(round);
                }
                return used;
            }
            let mut asked = Vec::new();
            if !round.text.trim().is_empty() {
                asked.push(Part::Text(round.text.clone()));
            }
            let mut results = Vec::new();
            let limit_reached_before = after_limit;
            for (id, name, arguments) in calls {
                asked.push(Part::ToolCall { id: id.clone(), name: name.clone(), arguments: arguments.clone() });
                let record = if tx.is_closed() {
                    None
                } else if used >= self.max_calls {
                    after_limit = true;
                    Some(limit_record(self.max_calls))
                } else {
                    used += 1;
                    let _ =
                        tx.send(json_event("tool", &json!({ "id": id, "name": name, "arguments": arguments }))).await;
                    let record = tokio::select! {
                        () = tx.closed() => None,
                        record = tools::run(&scope, &name, &arguments) => Some(record),
                    };
                    if let Some(record) = &record {
                        let _ = tx.send(json_event("toolResult", &json!({ "id": id, "record": record }))).await;
                    }
                    record
                };
                let (content, is_error) = match &record {
                    Some(record) => tools::model_content(&name, record),
                    None => ("The call was stopped before it finished.".to_string(), true),
                };
                results.push(Part::ToolResult { call_id: id.clone(), content, is_error });
                round.calls.push(Call { id, name, arguments, record });
            }
            turn.rounds.push(round);
            if tx.is_closed() {
                turn.outcome = "stopped".into();
                return used;
            }
            if limit_reached_before {
                turn.outcome = "toolLimit".into();
                return used;
            }
            messages.push(Message { role: Role::Assistant, parts: asked });
            messages.push(Message { role: Role::User, parts: results });
        }
        turn.outcome = "toolLimit".into();
        used
    }
}
