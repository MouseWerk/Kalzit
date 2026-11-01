//! AI providers behind one interface (docs/ARCHITECTURE.md, "AI"). A provider turns a chat request
//! into a stream of events: text as it arrives, complete tool calls, token usage and the end. Two
//! clients implement it: `openai` for the OpenAI chat completions API and every server that speaks
//! it (OpenAI, LiteLLM, Ollama, vLLM, LM Studio), and `anthropic` for the Anthropic Messages API.
//!
//! Every request goes through the one HTTP client factory (`crate::http`), so a provider's base
//! URL is checked by the same target policy as data sources, on every connection. The key is
//! sent only to the configured URL (no redirects are followed) and is never part of an error.
//! Calls are retried with backoff while nothing was received yet, end at the configured time
//! limit, and stop at once when their cancellation token fires.
//!
//! `service` decides whether a call may run (the switch, the provider in effect, the limits) and
//! records its usage and audit entry; `store` keeps the providers, their keys and the per data
//! source opt-in.

pub mod anthropic;
pub mod chats;
pub mod openai;
pub mod prompts;
pub mod redact;
pub mod service;
pub mod sse;
pub mod store;
pub mod tools;

use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use async_trait::async_trait;
use futures_util::Stream;
use reqwest::header::HeaderMap;
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::datasources::Detail;
use crate::datasources::targets::TargetPolicy;
use crate::http::{HttpClient, HttpError, HttpOptions};

/// The API a provider speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    /// The OpenAI chat completions API: OpenAI, LiteLLM, Ollama and other compatible servers.
    #[serde(rename = "openai")]
    OpenAi,
    Anthropic,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 2] = [Self::OpenAi, Self::Anthropic];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// Anthropic always needs a key; local OpenAI-compatible servers (Ollama) often have none.
    pub fn key_required(self) -> bool {
        matches!(self, Self::Anthropic)
    }
}

/// What a client needs to reach one provider. The key is wiped when dropped and never printed.
#[derive(Clone)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub base_url: Url,
    pub model: String,
    pub api_key: Option<Arc<Zeroizing<String>>>,
    /// Whole call, including the streamed answer and every retry.
    pub timeout: Duration,
    /// The OpenAI-compatible request field of the answer's token budget.
    pub token_limit_field: TokenLimitField,
    /// Set when the base URL's port is one of Kalzit's own listening ports: then no local
    /// address may be connected to (`http::LocalGuard`).
    pub local_guard: Option<crate::http::LocalGuard>,
}

/// Which field of an OpenAI-compatible request carries `max_tokens`. OpenAI's own API wants
/// `max_completion_tokens` (its reasoning models refuse `max_tokens`); compatible servers
/// (LiteLLM, Ollama, vLLM) mostly know only `max_tokens`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TokenLimitField {
    /// `max_completion_tokens` for api.openai.com, `max_tokens` elsewhere.
    #[default]
    Auto,
    MaxTokens,
    MaxCompletionTokens,
}

impl TokenLimitField {
    pub const NAMES: [&str; 3] = ["auto", "max_tokens", "max_completion_tokens"];

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "max_tokens" => Some(Self::MaxTokens),
            "max_completion_tokens" => Some(Self::MaxCompletionTokens),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::MaxTokens => "max_tokens",
            Self::MaxCompletionTokens => "max_completion_tokens",
        }
    }

    /// The field name to send to `base`.
    pub fn field_for(self, base: &Url) -> &'static str {
        match self {
            Self::MaxTokens => "max_tokens",
            Self::MaxCompletionTokens => "max_completion_tokens",
            Self::Auto if base.host_str().is_some_and(|h| h.eq_ignore_ascii_case("api.openai.com")) => {
                "max_completion_tokens"
            }
            Self::Auto => "max_tokens",
        }
    }
}

impl fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("kind", &self.kind)
            .field("base_url", &self.base_url.as_str())
            .field("model", &self.model)
            .field("api_key", &self.api_key.as_ref().map(|_| "***"))
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

/// One part of a message: text, or a tool call of the assistant and its result (the agent chat).
#[derive(Clone, Debug, PartialEq)]
pub enum Part {
    Text(String),
    /// A call the assistant made; `arguments` is a JSON object.
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    /// The answer to a tool call, sent in a user message.
    ToolResult {
        call_id: String,
        content: String,
        is_error: bool,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self { role: Role::User, parts: vec![Part::Text(text.into())] }
    }

    pub fn assistant(text: impl Into<String>) -> Self {
        Self { role: Role::Assistant, parts: vec![Part::Text(text.into())] }
    }
}

/// A tool the model may call: its name, what it does and its parameters as JSON Schema.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatRequest {
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<ToolDef>,
    /// The longest answer in tokens. Anthropic requires one and gets `DEFAULT_MAX_TOKENS` without.
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// Anthropic's Messages API requires `max_tokens`; used when the request names none.
pub const DEFAULT_MAX_TOKENS: u32 = 4096;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl Usage {
    pub fn total(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StopReason {
    /// The model finished its answer.
    End,
    MaxTokens,
    ToolUse,
    Other(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum ChatEvent {
    Text(String),
    /// A complete tool call, sent once its arguments arrived in full.
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    /// Token usage so far; the last one counts.
    Usage(Usage),
    Done(StopReason),
}

/// A whole answer, collected from the events.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChatResponse {
    pub text: String,
    pub tool_calls: Vec<(String, String, Value)>,
    pub usage: Usage,
    pub stop: Option<StopReason>,
}

impl ChatResponse {
    pub fn add(&mut self, event: ChatEvent) {
        match event {
            ChatEvent::Text(t) => self.text.push_str(&t),
            ChatEvent::ToolCall { id, name, arguments } => self.tool_calls.push((id, name, arguments)),
            ChatEvent::Usage(u) => self.usage = u,
            ChatEvent::Done(stop) => self.stop = Some(stop),
        }
    }
}

pub type EventStream = Pin<Box<dyn Stream<Item = Result<ChatEvent, AiError>> + Send>>;

#[async_trait]
pub trait Provider: Send + Sync {
    fn config(&self) -> &ProviderConfig;

    /// Starts the call. Errors before the first event (refused target, bad key, an answer other
    /// than success after the retries) come from here; later ones arrive in the stream.
    async fn stream(&self, request: &ChatRequest, cancel: &CancellationToken) -> Result<EventStream, AiError>;
}

/// Collects a whole answer from `provider`.
pub async fn complete(
    provider: &dyn Provider,
    request: &ChatRequest,
    cancel: &CancellationToken,
) -> Result<ChatResponse, AiError> {
    use futures_util::StreamExt;
    let mut events = provider.stream(request, cancel).await?;
    let mut out = ChatResponse::default();
    while let Some(event) = events.next().await {
        out.add(event?);
    }
    Ok(out)
}

/// The client for `config`, its requests checked by `policy`, through the outbound `proxy` when
/// one is set.
pub fn provider(
    config: ProviderConfig,
    policy: Arc<TargetPolicy>,
    proxy: Option<Arc<crate::outbound::OutboundProxy>>,
) -> Result<Box<dyn Provider>, AiError> {
    let http = crate::http::client_proxied(
        HttpOptions { timeout: config.timeout, extra_root_pem: None, policy },
        config.local_guard.clone(),
        proxy,
    )
    .map_err(AiError::from_http)?;
    Ok(match config.kind {
        ProviderKind::OpenAi => Box::new(openai::OpenAiProvider::new(config, http)),
        ProviderKind::Anthropic => Box::new(anthropic::AnthropicProvider::new(config, http)),
    })
}

/// Why a call failed. Every variant has a stable reason (`detail`), documented in docs/api/ai.md.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum AiError {
    /// The target policy refused the address (`target.*` reasons, as for data sources).
    #[error("{}", .0.message)]
    Blocked(Detail),
    #[error("the AI provider did not answer in time")]
    Timeout,
    #[error("the call was cancelled")]
    Cancelled,
    #[error("the AI provider cannot be reached: {0}")]
    Unreachable(String),
    #[error("the AI provider refused the key ({status})")]
    Unauthorized { status: u16 },
    #[error("the AI provider is busy or limits requests ({status}){}", fmt_detail(.message))]
    Overloaded { status: u16, message: String },
    #[error("the AI provider answered {status}{}", fmt_detail(.message))]
    Status { status: u16, message: String },
    #[error("the AI provider sent an answer Kalzit cannot read: {0}")]
    Protocol(String),
    #[error("the answer of the AI provider is larger than {0} bytes")]
    TooLarge(usize),
}

fn fmt_detail(message: &str) -> String {
    if message.is_empty() { String::new() } else { format!(": {message}") }
}

impl AiError {
    pub fn detail(&self) -> Detail {
        let text = self.to_string();
        match self {
            Self::Blocked(d) => d.clone(),
            Self::Timeout => Detail::new("ai.provider_timeout", text),
            Self::Cancelled => Detail::new("ai.cancelled", text),
            Self::Unreachable(d) => Detail::new("ai.provider_unreachable", text).with("detail", d),
            Self::Unauthorized { status } => Detail::new("ai.provider_unauthorized", text).with("status", status),
            Self::Overloaded { status, message } => {
                Detail::new("ai.provider_overloaded", text).with("status", status).with("detail", message)
            }
            Self::Status { status, message } => {
                Detail::new("ai.provider_status", text).with("status", status).with("detail", message)
            }
            Self::Protocol(d) => Detail::new("ai.provider_protocol", text).with("detail", d),
            Self::TooLarge(max) => Detail::new("ai.provider_too_large", text).with("bytes", max),
        }
    }

    fn from_http(e: HttpError) -> Self {
        match e {
            HttpError::Blocked(b) => Self::Blocked(b.0),
            HttpError::Refused(d) => Self::Blocked(d),
            HttpError::Timeout => Self::Timeout,
            HttpError::TooLarge(max) => Self::TooLarge(max),
            HttpError::Other(m) => Self::Unreachable(m),
            HttpError::Connection(d) => Self::Unreachable(d.message),
        }
    }

    /// The same error with `secret` replaced wherever an answer could have echoed it, also in
    /// part: providers often repeat the start and the end of a key (`sk-ab...wxyz`).
    fn scrubbed(self, secret: Option<&str>) -> Self {
        let Some(secret) = secret.filter(|s| s.chars().count() >= 4) else { return self };
        let clean = |s: String| scrub(&s, secret);
        match self {
            Self::Unreachable(m) => Self::Unreachable(clean(m)),
            Self::Overloaded { status, message } => Self::Overloaded { status, message: clean(message) },
            Self::Status { status, message } => Self::Status { status, message: clean(message) },
            Self::Protocol(m) => Self::Protocol(clean(m)),
            Self::Blocked(d) => Self::Blocked(d.scrubbed(|s| scrub(s, secret))),
            other => other,
        }
    }
}

/// The shortest start of a key that counts as an echo of it, and the shortest end.
const ECHO_PREFIX: usize = 6;
const ECHO_SUFFIX: usize = 4;

/// `text` with `secret` and every start (from `ECHO_PREFIX` characters) and end (from
/// `ECHO_SUFFIX` characters) of it replaced by `***`, longest first. Ends shorter than the key's
/// own length are taken only for keys of at least 12 characters, so a short key does not blank
/// ordinary text.
pub fn scrub(text: &str, secret: &str) -> String {
    let mut out = text.replace(secret, "***");
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() < 12 {
        return out;
    }
    for n in (ECHO_PREFIX..chars.len()).rev() {
        let start: String = chars[..n].iter().collect();
        out = out.replace(&start, "***");
    }
    for n in (ECHO_SUFFIX..chars.len()).rev() {
        let end: String = chars[chars.len() - n..].iter().collect();
        out = out.replace(&end, "***");
    }
    out
}

/// The most bytes one answer may have; a stream that goes on beyond is cut off as an error.
pub const MAX_ANSWER_BYTES: usize = 16 * 1024 * 1024;
/// The longest provider message an error carries.
const MAX_ERROR_CHARS: usize = 300;
/// Attempts per call while nothing was received yet (the first plus retries).
const ATTEMPTS: u32 = 3;
const BACKOFF: Duration = Duration::from_millis(500);
/// The longest `Retry-After` honoured; a provider asking for longer gets an error instead.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);

/// Answers worth another attempt: overload, rate limits and passing server errors.
fn retryable(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504 | 529)
}

/// The provider's own error text from a JSON answer (`{"error": {"message": ...}}` in both APIs),
/// shortened, else the start of the body.
fn error_message(body: &[u8]) -> String {
    let parsed: Option<Value> = serde_json::from_slice(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|e| e.get("message").and_then(Value::as_str).or_else(|| e.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string());
    let clean: String = message.chars().filter(|c| !c.is_control()).collect();
    match clean.char_indices().nth(MAX_ERROR_CHARS) {
        Some((i, _)) => format!("{}...", &clean[..i]),
        None => clean,
    }
}

/// Sends the request with `send_once` (the key reaches exactly this URL), retrying with backoff
/// while the answer is a passing failure. Returns a success answer whose body is still unread.
async fn send_with_retries(
    http: &HttpClient,
    url: &Url,
    headers: &HeaderMap,
    body: &[u8],
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<reqwest::Response, AiError> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let sent = tokio::select! {
            () = cancel.cancelled() => return Err(AiError::Cancelled),
            () = tokio::time::sleep_until(deadline) => return Err(AiError::Timeout),
            r = http.send_once(Method::POST, url.clone(), headers.clone(), Some(body.to_vec())) => r,
        };
        let wait = match sent {
            Ok(response) if response.status().is_success() => return Ok(response),
            Ok(response) => {
                let status = response.status();
                let retry_after = response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.trim().parse::<u64>().ok())
                    .map(Duration::from_secs);
                let body = tokio::select! {
                    () = cancel.cancelled() => return Err(AiError::Cancelled),
                    () = tokio::time::sleep_until(deadline) => return Err(AiError::Timeout),
                    b = crate::http::read_limited(response, 64 * 1024) => b.unwrap_or_default(),
                };
                let message = error_message(&body);
                let error = match status.as_u16() {
                    401 | 403 => return Err(AiError::Unauthorized { status: status.as_u16() }),
                    429 | 503 | 529 => AiError::Overloaded { status: status.as_u16(), message },
                    _ => AiError::Status { status: status.as_u16(), message },
                };
                let wait = retry_after.unwrap_or_else(|| backoff(attempt));
                // The time limit covers every attempt: no retry that could not finish within it.
                let past_deadline = Instant::now() + wait >= deadline;
                let too_long = retry_after.is_some_and(|w| w > MAX_RETRY_AFTER);
                if !retryable(status) || attempt >= ATTEMPTS || too_long || past_deadline {
                    return Err(error);
                }
                wait
            }
            Err(e @ (HttpError::Other(_) | HttpError::Connection(_)))
                if attempt < ATTEMPTS && Instant::now() + backoff(attempt) < deadline =>
            {
                tracing::debug!("AI provider request failed, trying again: {e}");
                backoff(attempt)
            }
            Err(e) => return Err(AiError::from_http(e)),
        };
        tokio::select! {
            () = cancel.cancelled() => return Err(AiError::Cancelled),
            () = tokio::time::sleep(wait) => {}
        }
    }
}

/// 0.5 s, 1 s, 2 s ..., plus up to a quarter of that at random, so callers spread out.
fn backoff(attempt: u32) -> Duration {
    let base = BACKOFF * 2u32.saturating_pow(attempt.saturating_sub(1));
    let jitter = rand::random_range(0..=base.as_millis() as u64 / 4);
    base + Duration::from_millis(jitter)
}

/// Joins `path` (`chat/completions`) to the base URL's path, keeping what is there (`/v1`).
fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let joined = format!("{}/{path}", base.path().trim_end_matches('/'));
    url.set_path(&joined);
    url.set_query(None);
    url.set_fragment(None);
    url
}

/// Reads an event stream answer and hands each SSE event to `on_event`, which turns it into chat
/// events; ends at `cancel`, the size limit, or the end of the answer. Runs in its own task and
/// sends to the returned stream, which stops the task when dropped.
fn spawn_reader<F>(
    response: reqwest::Response,
    cancel: CancellationToken,
    deadline: Instant,
    secret: Option<Arc<Zeroizing<String>>>,
    mut on_event: F,
) -> EventStream
where
    F: FnMut(sse::Event) -> Result<Vec<ChatEvent>, AiError> + Send + 'static,
{
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<ChatEvent, AiError>>(64);
    tokio::spawn(async move {
        let secret = secret.as_ref().map(|s| s.as_str().to_string()).map(Zeroizing::new);
        let fail = |e: AiError| e.scrubbed(secret.as_deref().map(String::as_str));
        let mut response = response;
        let mut parser = sse::Parser::default();
        let mut read = 0usize;
        loop {
            let chunk = tokio::select! {
                () = cancel.cancelled() => {
                    let _ = tx.send(Err(AiError::Cancelled)).await;
                    return;
                }
                () = tx.closed() => return,
                () = tokio::time::sleep_until(deadline) => {
                    let _ = tx.send(Err(AiError::Timeout)).await;
                    return;
                }
                c = response.chunk() => c,
            };
            let (events, ended) = match chunk {
                Ok(Some(bytes)) => {
                    read += bytes.len();
                    if read > MAX_ANSWER_BYTES {
                        let _ = tx.send(Err(AiError::TooLarge(MAX_ANSWER_BYTES))).await;
                        return;
                    }
                    (parser.push(&bytes), false)
                }
                Ok(None) => (parser.finish(), true),
                Err(e) => {
                    let _ = tx.send(Err(fail(AiError::from_http(HttpError::from(e))))).await;
                    return;
                }
            };
            for event in events {
                match on_event(event) {
                    Ok(out) => {
                        for e in out {
                            let done = matches!(e, ChatEvent::Done(_));
                            if tx.send(Ok(e)).await.is_err() {
                                return;
                            }
                            if done {
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(fail(e))).await;
                        return;
                    }
                }
            }
            if ended {
                // The answer ended without its end event: what arrived is not a whole answer.
                let _ = tx.send(Err(AiError::Protocol("the answer ended early".into()))).await;
                return;
            }
        }
    });
    Box::pin(futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_keep_the_base_path() {
        let base = Url::parse("http://localhost:11434/v1/").unwrap();
        assert_eq!(endpoint(&base, "chat/completions").as_str(), "http://localhost:11434/v1/chat/completions");
        let base = Url::parse("https://api.anthropic.com").unwrap();
        assert_eq!(endpoint(&base, "v1/messages").as_str(), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn error_messages_are_short_and_plain() {
        let body = br#"{"error":{"message":"Incorrect API key provided: sk-abc\ndef","type":"invalid"}}"#;
        assert_eq!(error_message(body), "Incorrect API key provided: sk-abcdef");
        let long = "x".repeat(1000);
        assert_eq!(error_message(long.as_bytes()).chars().count(), MAX_ERROR_CHARS + 3);
    }

    #[test]
    fn errors_never_carry_the_key() {
        let e = AiError::Status { status: 400, message: "bad key sk-geheim-123".into() };
        let clean = e.scrubbed(Some("sk-geheim-123"));
        assert!(!clean.to_string().contains("sk-geheim-123"));
        assert!(!format!("{:?}", clean.detail()).contains("sk-geheim-123"));
    }

    #[test]
    fn partial_echoes_of_the_key_are_scrubbed() {
        let key = "sk-proj-abcdefghijklmnop4711";
        let echoed = "Incorrect API key provided: sk-proj-***********4711. Key sk-proj-abcd... was refused";
        let clean = scrub(echoed, key);
        assert!(!clean.contains("sk-proj-a") && !clean.contains("4711") && !clean.contains("sk-proj-"), "{clean}");
        assert!(clean.starts_with("Incorrect API key provided: "));
        // A short key is replaced only as a whole, so it cannot blank ordinary words.
        assert_eq!(scrub("token abcd in text abc", "abcd"), "token *** in text abc");
    }

    #[test]
    fn the_key_is_not_printed() {
        let config = ProviderConfig {
            kind: ProviderKind::OpenAi,
            base_url: Url::parse("http://localhost:1/v1").unwrap(),
            model: "m".into(),
            api_key: Some(Arc::new(Zeroizing::new("sk-geheim".into()))),
            timeout: Duration::from_secs(1),
            token_limit_field: TokenLimitField::Auto,
            local_guard: None,
        };
        assert!(!format!("{config:?}").contains("sk-geheim"));
    }

    #[test]
    fn backoff_grows() {
        assert!(backoff(1) >= Duration::from_millis(500) && backoff(1) <= Duration::from_millis(625));
        assert!(backoff(2) >= Duration::from_secs(1));
    }
}
