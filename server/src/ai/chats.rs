//! Stored chats of "Fragen" (migration 0022): a chat belongs to one person in one organization,
//! and every read and write here is for that person alone. A chat holds the questions and the
//! answers with their rounds of text and tool calls (`Turn`); the conversation the provider gets
//! is rebuilt from them (`conversation`), so a stored chat sends again exactly what it sent
//! before, minus what the person may no longer see.
//!
//! Chats are deleted `ai.chat_retention_days` after their last message (the organization may
//! shorten it, `service::chat_retention_days`) by an hourly job (`spawn_retention`).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::tools::{self, ToolRecord, Visibility};
use super::{Message, Part, Role, Usage};
use crate::app::AppState;
use crate::authz::OrgCtx;
use crate::error::{ApiError, ApiResult};
use crate::shapes::ErrorBody;

pub const DAY_MS: i64 = 24 * 3600 * 1000;
/// The longest title, taken from the first question.
const MAX_TITLE_CHARS: usize = 120;
/// Questions (with their answers) a provider gets from the chat's past, newest kept.
const MAX_PAST_QUESTIONS: usize = 12;
/// Rows deleted per statement by the retention job.
const PURGE_BATCH: i64 = 500;

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ChatRow {
    pub id: String,
    pub org_id: String,
    pub user_id: String,
    pub title: String,
    pub datasource_ids: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ChatRow {
    /// The sources chosen in the composer.
    pub fn selection(&self) -> Vec<String> {
        serde_json::from_str(&self.datasource_ids).unwrap_or_default()
    }
}

const COLUMNS: &str = "id, org_id, user_id, title, datasource_ids, created_at, updated_at";

/// A question.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub text: String,
    #[serde(default)]
    pub datasource_ids: Vec<String>,
    /// The dashboard the question was asked about ("Dashboard als Kontext").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dashboard: Option<DashboardContext>,
}

/// A dashboard given as context: its id and title, and its panels as the model got them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardContext {
    pub id: String,
    pub title: String,
    /// `[{panelId, title, type}]`.
    #[serde(default)]
    pub panels: Vec<Value>,
}

impl DashboardContext {
    /// The question as the model gets it: the text, then the dashboard inside a block.
    pub fn message(&self, text: &str) -> String {
        let data = serde_json::json!({ "dashboardId": self.id, "title": self.title, "panels": self.panels });
        format!(
            "{text}\n\nThe person asks in the context of this dashboard; use run_panel for its panels.\n{}",
            super::prompts::fence("dashboard", &data.to_string())
        )
    }
}

/// An answer: its rounds (each the model's text and the tools it called), the tokens of all its
/// calls, who answered and how it ended.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub rounds: Vec<Round>,
    #[serde(default)]
    pub usage: Usage,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Value>,
    /// `ok`, `stopped` (the person stopped it), `failed` or `toolLimit`.
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    /// Set when the answer is read or continued and one of its tool results shows less than when
    /// the model saw it (withheld, or rules tightened since): the model's words and the arguments
    /// of its calls may quote that data, so they are neither shown nor sent again. Never stored.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub withheld: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Round {
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub calls: Vec<Call>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    /// Absent when the answer was stopped before the call finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record: Option<ToolRecord>,
}

/// One stored message, as the API answers it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub seq: i64,
    /// `user` or `assistant`.
    pub role: String,
    pub created_at: i64,
    pub content: Value,
}

/// A title from a question: one line, at most `MAX_TITLE_CHARS`.
pub fn title_of(text: &str) -> String {
    let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match line.char_indices().nth(MAX_TITLE_CHARS) {
        Some((i, _)) => format!("{}...", line[..i].trim_end()),
        None => line,
    }
}

pub async fn create(state: &AppState, ctx: &OrgCtx, selection: &[String]) -> ApiResult<ChatRow> {
    let now = state.clock.now_ms();
    let row = ChatRow {
        id: uuid::Uuid::now_v7().to_string(),
        org_id: ctx.org_id.clone(),
        user_id: ctx.user.id.clone(),
        title: String::new(),
        datasource_ids: serde_json::to_string(selection).expect("a list of texts serializes"),
        created_at: now,
        updated_at: now,
    };
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO ai_chats (id, org_id, user_id, title, search_title, datasource_ids, created_at, updated_at) \
         VALUES ($1, $2, $3, '', '', $4, $5, $5)",
    )
    .bind(&row.id)
    .bind(&row.org_id)
    .bind(&row.user_id)
    .bind(&row.datasource_ids)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(row)
}

/// The caller's chat, or `not_found` (also for another person's chat).
pub async fn find_own(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<ChatRow> {
    let row: Option<ChatRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM ai_chats WHERE id = $1 AND org_id = $2 AND user_id = $3"
    )))
    .bind(id)
    .bind(&ctx.org_id)
    .bind(&ctx.user.id)
    .fetch_optional(&state.db)
    .await?;
    row.ok_or_else(ApiError::not_found)
}

/// The caller's chats in the organization, last used first; `search` matches the title.
pub async fn list_own(state: &AppState, ctx: &OrgCtx, search: Option<&str>, limit: i64) -> ApiResult<Vec<ChatRow>> {
    let pattern = search.map(str::trim).filter(|s| !s.is_empty()).map(|s| {
        let lower = s.to_lowercase();
        format!("%{}%", lower.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
    });
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM ai_chats WHERE org_id = $1 AND user_id = $2 \
         AND (CAST($3 AS TEXT) IS NULL OR search_title LIKE $3 ESCAPE '\\') \
         ORDER BY updated_at DESC, id DESC LIMIT $4"
    )))
    .bind(&ctx.org_id)
    .bind(&ctx.user.id)
    .bind(pattern.as_deref())
    .bind(limit)
    .fetch_all(&state.db)
    .await?)
}

pub async fn messages(state: &AppState, chat_id: &str) -> ApiResult<Vec<(i64, String, i64, Value)>> {
    let rows: Vec<(i64, String, i64, String)> =
        sqlx::query_as("SELECT seq, role, created_at, content FROM ai_chat_messages WHERE chat_id = $1 ORDER BY seq")
            .bind(chat_id)
            .fetch_all(&state.db)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(seq, role, at, content)| (seq, role, at, serde_json::from_str(&content).unwrap_or(Value::Null)))
        .collect())
}

/// Adds a message at the end of the chat and marks the chat used; the first question names it.
/// The chat's sources are replaced by `selection` when given.
pub async fn append(
    state: &AppState,
    chat: &ChatRow,
    role: &str,
    content: &Value,
    selection: Option<&[String]>,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let (next,): (i64,) =
        sqlx::query_as("SELECT CAST(COALESCE(MAX(seq), 0) + 1 AS BIGINT) FROM ai_chat_messages WHERE chat_id = $1")
            .bind(&chat.id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("INSERT INTO ai_chat_messages (chat_id, seq, role, content, created_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(&chat.id)
        .bind(next)
        .bind(role)
        .bind(content.to_string())
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE ai_chats SET updated_at = $1 WHERE id = $2").bind(now).bind(&chat.id).execute(&mut *tx).await?;
    if role == "user"
        && let Some(text) = content.get("text").and_then(Value::as_str)
    {
        let title = title_of(text);
        sqlx::query("UPDATE ai_chats SET title = $1, search_title = $2 WHERE id = $3 AND title = ''")
            .bind(&title)
            .bind(title.to_lowercase())
            .bind(&chat.id)
            .execute(&mut *tx)
            .await?;
    }
    if let Some(selection) = selection {
        sqlx::query("UPDATE ai_chats SET datasource_ids = $1 WHERE id = $2")
            .bind(serde_json::to_string(selection).expect("a list of texts serializes"))
            .bind(&chat.id)
            .execute(&mut *tx)
            .await?;
    }
    crate::db::commit(tx).await?;
    Ok(())
}

pub async fn delete_own(state: &AppState, ctx: &OrgCtx, id: Option<&str>) -> ApiResult<u64> {
    let mut tx = crate::db::begin(&state.db).await?;
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM ai_chats WHERE org_id = $1 AND user_id = $2 AND (CAST($3 AS TEXT) IS NULL OR id = $3)",
    )
    .bind(&ctx.org_id)
    .bind(&ctx.user.id)
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for (chat,) in &ids {
        delete_chat(&mut tx, chat).await?;
    }
    crate::db::commit(tx).await?;
    Ok(ids.len() as u64)
}

/// Deletes a chat and its messages (also where foreign keys are not enforced).
async fn delete_chat(conn: &mut sqlx::AnyConnection, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_chat_messages WHERE chat_id = $1").bind(id).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM ai_chats WHERE id = $1").bind(id).execute(&mut *conn).await?;
    Ok(())
}

/// The stored messages as the person may see them now: tool results of sources they lost, or
/// that were closed to AI, are withheld.
pub async fn visible_messages(state: &AppState, ctx: &OrgCtx, chat_id: &str) -> ApiResult<Vec<StoredMessage>> {
    let mut visibility = Visibility::default();
    let mut out = Vec::new();
    let mut tainted = false;
    for (seq, role, created_at, content) in messages(state, chat_id).await? {
        let content = if role == "assistant" {
            match serde_json::from_value::<Turn>(content.clone()) {
                Ok(turn) => {
                    let turn = checked_turn(state, ctx, &mut visibility, turn, tainted).await;
                    tainted |= turn.withheld;
                    serde_json::to_value(turn).unwrap_or(Value::Null)
                }
                // An answer that cannot be read cannot be checked: shown as stored, but the
                // answers after it are treated as if it were withheld.
                Err(_) => {
                    tainted = true;
                    content
                }
            }
        } else {
            match serde_json::from_value::<Question>(content.clone()) {
                // A dashboard context the person may no longer read is left out.
                Ok(mut question) => {
                    if let Some(d) = &question.dashboard
                        && !visibility.dashboard_readable(state, ctx, &d.id).await
                    {
                        question.dashboard = None;
                    }
                    serde_json::to_value(question).unwrap_or(Value::Null)
                }
                Err(_) => content,
            }
        };
        out.push(StoredMessage { seq, role, created_at, content });
    }
    Ok(out)
}

/// An answer as the person may see it now: each record checked again (`Visibility::check`), and
/// the model's words withheld where a record shows less than the model saw, or where an earlier
/// answer of the chat was withheld (`tainted`): the model had that answer's data in front of it
/// and may quote it later on.
async fn checked_turn(
    state: &AppState,
    ctx: &OrgCtx,
    visibility: &mut Visibility,
    mut turn: Turn,
    tainted: bool,
) -> Turn {
    let mut hides = false;
    for round in &mut turn.rounds {
        for call in &mut round.calls {
            if let Some(record) = call.record.take() {
                let (record, less) = visibility.check(state, ctx, &call.name, record).await;
                hides |= less;
                call.record = Some(record);
            }
        }
    }
    if hides || tainted {
        withhold_words(&mut turn);
    }
    turn
}

/// Takes out of an answer what the model wrote: its text, the arguments of its calls, the
/// queries it wrote (a panel's stored queries stay) and its proposals. What is left are the
/// records, each as `Visibility::check` left it.
fn withhold_words(turn: &mut Turn) {
    turn.withheld = true;
    for round in &mut turn.rounds {
        round.text.clear();
        for call in &mut round.calls {
            call.arguments = Value::Object(serde_json::Map::new());
            let Some(record) = &mut call.record else { continue };
            if call.name != "run_panel" {
                record.query = None;
                for result in &mut record.results {
                    result.query = None;
                }
            }
            if record.proposal.take().is_some() {
                record.withheld = true;
            }
        }
    }
}

/// The conversation the provider gets: the newest `MAX_PAST_QUESTIONS` questions with their
/// answers, each answer as its rounds of text and tool calls followed by their results, with
/// results the person may no longer see withheld, and with them the model's words around them
/// (`checked_turn`): withheld text is never sent again. Messages of the same role in a row are joined,
/// as the Messages API wants them alternating.
pub async fn conversation(state: &AppState, ctx: &OrgCtx, chat_id: &str) -> ApiResult<Vec<Message>> {
    let stored = messages(state, chat_id).await?;
    let first_kept = stored
        .iter()
        .enumerate()
        .filter(|(_, (_, role, _, _))| role == "user")
        .map(|(i, _)| i)
        .rev()
        .nth(MAX_PAST_QUESTIONS - 1)
        .unwrap_or(0);
    let mut visibility = Visibility::default();
    let mut out: Vec<Message> = Vec::new();
    let push = |message: Message, out: &mut Vec<Message>| {
        if message.parts.is_empty() {
            return;
        }
        match out.last_mut() {
            Some(last) if last.role == message.role => {
                // Tool results come first in a user message.
                let (mut results, rest): (Vec<Part>, Vec<Part>) =
                    last.parts.drain(..).chain(message.parts).partition(|p| matches!(p, Part::ToolResult { .. }));
                results.extend(rest);
                last.parts = results;
            }
            _ => out.push(message),
        }
    };
    // Answers before the newest twelve questions are not sent, but one of them withheld still
    // withholds the words of every answer after it.
    let mut tainted = false;
    for (_, role, _, content) in &stored[..first_kept] {
        if role == "assistant" && !tainted {
            tainted = match serde_json::from_value::<Turn>(content.clone()) {
                Ok(turn) => checked_turn(state, ctx, &mut visibility, turn, false).await.withheld,
                Err(_) => true,
            };
        }
    }
    for (_, role, _, content) in stored.into_iter().skip(first_kept) {
        match role.as_str() {
            "user" => {
                let question: Question = serde_json::from_value(content).unwrap_or_default();
                // A dashboard the person may no longer read is left out of the question.
                let text = match &question.dashboard {
                    Some(d) if visibility.dashboard_readable(state, ctx, &d.id).await => d.message(&question.text),
                    _ => question.text,
                };
                push(Message::user(text), &mut out);
            }
            "assistant" => {
                let Ok(turn) = serde_json::from_value::<Turn>(content) else {
                    tainted = true;
                    continue;
                };
                let turn = checked_turn(state, ctx, &mut visibility, turn, tainted).await;
                tainted |= turn.withheld;
                for round in turn.rounds {
                    let mut parts = Vec::new();
                    if !round.text.trim().is_empty() {
                        parts.push(Part::Text(round.text));
                    }
                    let mut results = Vec::new();
                    for call in round.calls {
                        let (content, is_error) = match &call.record {
                            Some(record) => tools::model_content(&call.name, record),
                            None => ("The call was stopped before it finished.".to_string(), true),
                        };
                        results.push(Part::ToolResult { call_id: call.id.clone(), content, is_error });
                        parts.push(Part::ToolCall { id: call.id, name: call.name, arguments: call.arguments });
                    }
                    push(Message { role: Role::Assistant, parts }, &mut out);
                    push(Message { role: Role::User, parts: results }, &mut out);
                }
            }
            _ => {}
        }
    }
    trim(&mut out);
    Ok(out)
}

/// The most characters a conversation sent to the provider holds; results beyond it are left
/// out, oldest first, so a chat with large results stays within a model's context.
pub const MAX_CONVERSATION_CHARS: usize = 150_000;

/// What replaces a tool result left out to keep the conversation short.
const LEFT_OUT: &str =
    "This older result was left out to keep the conversation short. Run the query again if it is needed.";

fn part_chars(part: &Part) -> usize {
    match part {
        Part::Text(t) => t.chars().count(),
        Part::ToolCall { name, arguments, .. } => name.len() + arguments.to_string().len(),
        Part::ToolResult { content, .. } => content.chars().count(),
    }
}

/// Leaves out tool results, oldest first, until the conversation holds at most
/// `MAX_CONVERSATION_CHARS`; the newest result always stays, as do questions and answers.
pub fn trim(messages: &mut [Message]) {
    let mut total: usize = messages.iter().flat_map(|m| &m.parts).map(part_chars).sum();
    let results = messages.iter().flat_map(|m| &m.parts).filter(|p| matches!(p, Part::ToolResult { .. })).count();
    let mut seen = 0;
    for part in messages.iter_mut().flat_map(|m| m.parts.iter_mut()) {
        if total <= MAX_CONVERSATION_CHARS {
            return;
        }
        if let Part::ToolResult { content, .. } = part {
            seen += 1;
            if seen == results {
                // The newest result stays.
                return;
            }
            let before = content.chars().count();
            if before > LEFT_OUT.len() {
                *content = LEFT_OUT.to_string();
                total = total - before + LEFT_OUT.len();
            }
        }
    }
}

/// The data sources a chat names in the list, for each chat: the chosen ones, by name, among the
/// ones the person may still read.
pub fn names_of(selection: &[String], visible: &[tools::UsableSource]) -> Vec<Value> {
    let chosen: BTreeSet<&str> = selection.iter().map(String::as_str).collect();
    visible
        .iter()
        .filter(|s| chosen.contains(s.id.as_str()))
        .map(|s| serde_json::json!({ "id": s.id, "name": s.name, "kind": s.kind }))
        .collect()
}

/// Deletes chats past the retention of their organization. Answers the number deleted.
pub async fn purge_expired(state: &AppState) -> ApiResult<u64> {
    purge_expired_in(state, &state.db).await
}

async fn purge_expired_in(state: &AppState, db: &sqlx::AnyPool) -> ApiResult<u64> {
    let orgs: Vec<(String,)> = sqlx::query_as("SELECT DISTINCT org_id FROM ai_chats").fetch_all(db).await?;
    let now = state.clock.now_ms();
    let mut total = 0;
    for (org,) in orgs {
        let days = i64::try_from(super::service::chat_retention_days(state, &org).await?).unwrap_or(i64::MAX);
        let cutoff = now.saturating_sub(days.saturating_mul(DAY_MS));
        loop {
            let mut tx = crate::db::begin(db).await?;
            let ids: Vec<(String,)> = sqlx::query_as(
                "SELECT id FROM ai_chats WHERE org_id = $1 AND updated_at < $2 ORDER BY updated_at LIMIT $3",
            )
            .bind(&org)
            .bind(cutoff)
            .bind(PURGE_BATCH)
            .fetch_all(&mut *tx)
            .await?;
            for (id,) in &ids {
                delete_chat(&mut tx, id).await?;
            }
            crate::db::commit(tx).await?;
            total += ids.len() as u64;
            if (ids.len() as i64) < PURGE_BATCH {
                break;
            }
        }
    }
    Ok(total)
}

/// Runs `purge_expired` every hour, like the other retention jobs.
pub fn spawn_retention(state: AppState) {
    spawn_retention_on(state, crate::db::Schedule::hourly());
}

/// `spawn_retention` on another schedule (tests).
pub fn spawn_retention_on(state: AppState, schedule: crate::db::Schedule) {
    use crate::db::JobError;
    let background = state.background.clone();
    crate::db::spawn_job(&background, "deleting AI chats past their retention", schedule, move || {
        let state = state.clone();
        async move {
            match purge_expired_in(&state, state.background.db()).await {
                Ok(0) => Ok(()),
                Ok(n) => {
                    tracing::info!("deleted {n} AI chats past their retention");
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

    #[test]
    fn titles_are_one_short_line() {
        assert_eq!(title_of("  Wie hat sich\nder Umsatz entwickelt? "), "Wie hat sich der Umsatz entwickelt?");
        let long = "Wort ".repeat(60);
        let title = title_of(&long);
        assert!(title.ends_with("...") && title.chars().count() <= MAX_TITLE_CHARS + 3, "{title}");
    }

    #[test]
    fn long_conversations_lose_their_oldest_results_first() {
        let result = |id: &str, n: usize| Message {
            role: Role::User,
            parts: vec![Part::ToolResult { call_id: id.into(), content: "x".repeat(n), is_error: false }],
        };
        let mut messages = vec![
            Message::user("Frage"),
            result("a", MAX_CONVERSATION_CHARS),
            result("b", 1000),
            result("c", MAX_CONVERSATION_CHARS),
        ];
        trim(&mut messages);
        let content = |m: &Message| match &m.parts[0] {
            Part::ToolResult { content, .. } => content.clone(),
            _ => String::new(),
        };
        assert_eq!(content(&messages[1]), LEFT_OUT);
        assert_eq!(content(&messages[2]), LEFT_OUT, "older ones go until it fits");
        assert_eq!(content(&messages[3]).len(), MAX_CONVERSATION_CHARS, "the newest result stays");
        let mut short = vec![Message::user("Frage"), result("a", 10)];
        trim(&mut short);
        assert_eq!(content(&short[1]).len(), 10);
    }

    #[test]
    fn withheld_answers_lose_the_models_words_but_keep_panel_queries() {
        let record = |query: Option<Value>| ToolRecord { status: "ok".into(), query, ..Default::default() };
        let call = |name: &str, record: ToolRecord| Call {
            id: name.into(),
            name: name.into(),
            arguments: serde_json::json!({ "query": { "sql": "SELECT email FROM kunden WHERE email = 'ana@x.de'" } }),
            record: Some(record),
        };
        let mut panel = record(None);
        panel.results = vec![tools::ResultRecord {
            ref_id: "A".into(),
            datasource_id: None,
            query: Some(serde_json::json!({ "sql": "SELECT name FROM kunden" })),
            data: None,
            rows: 0,
            truncated: false,
            excluded_values: 0,
            error: None,
        }];
        let mut proposal = record(Some(serde_json::json!({ "sql": "SELECT 1" })));
        proposal.proposal = Some(tools::Proposal { title: "Ana".into(), explanation: "ana@x.de".into() });
        let mut turn = Turn {
            rounds: vec![Round {
                text: "Ana hat die Adresse ana@x.de.".into(),
                calls: vec![
                    call("run_query", record(Some(serde_json::json!({ "sql": "SELECT 'ana@x.de'" })))),
                    call("run_panel", panel),
                    call("propose_query", proposal),
                ],
            }],
            outcome: "ok".into(),
            ..Default::default()
        };
        withhold_words(&mut turn);
        assert!(turn.withheld);
        let text = serde_json::to_string(&turn).unwrap();
        assert!(!text.contains("ana@x.de"), "{text}");
        let calls = &turn.rounds[0].calls;
        assert!(calls.iter().all(|c| c.arguments == serde_json::json!({})));
        assert!(calls[0].record.as_ref().unwrap().query.is_none());
        assert!(calls[1].record.as_ref().unwrap().results[0].query.is_some(), "a stored panel query stays");
        assert!(calls[2].record.as_ref().unwrap().withheld, "a proposal is the model's own");
    }

    #[test]
    fn turns_read_back_what_they_stored() {
        let turn = Turn {
            rounds: vec![Round {
                text: "Ich sehe nach.".into(),
                calls: vec![Call {
                    id: "c1".into(),
                    name: "list_datasources".into(),
                    arguments: serde_json::json!({}),
                    record: Some(ToolRecord { status: "ok".into(), ..Default::default() }),
                }],
            }],
            usage: Usage { input_tokens: 3, output_tokens: 4 },
            provider: None,
            outcome: "ok".into(),
            error: None,
            withheld: false,
        };
        let value = serde_json::to_value(&turn).unwrap();
        assert!(value.get("withheld").is_none(), "only set when read");
        assert_eq!(value["usage"]["inputTokens"], 3);
        assert_eq!(serde_json::from_value::<Turn>(value).unwrap(), turn);
    }
}
