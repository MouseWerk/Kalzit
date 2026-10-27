//! The Anthropic Messages API (`POST {base}/v1/messages`, base `https://api.anthropic.com`),
//! streamed as server-sent events: `message_start` carries the input tokens, content blocks
//! (text, tool use) arrive as `content_block_start`, `content_block_delta` and
//! `content_block_stop`, `message_delta` carries the stop reason and output tokens, and
//! `message_stop` ends the answer. An `error` event ends it with the provider's error. The usage
//! is passed on as soon as `message_start` and each `message_delta` bring it, so a call cut short
//! still counts what it used.

use std::collections::BTreeMap;

use async_trait::async_trait;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{
    AiError, ChatEvent, ChatRequest, DEFAULT_MAX_TOKENS, EventStream, Part, Provider, ProviderConfig, Role, StopReason,
    Usage, endpoint, send_with_retries, spawn_reader,
};
use crate::http::HttpClient;

/// The API version this client speaks, sent as `anthropic-version`.
pub const API_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    config: ProviderConfig,
    http: HttpClient,
}

impl AnthropicProvider {
    pub fn new(config: ProviderConfig, http: HttpClient) -> Self {
        Self { config, http }
    }

    fn headers(&self) -> Result<HeaderMap, AiError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
        headers.insert(HeaderName::from_static("anthropic-version"), HeaderValue::from_static(API_VERSION));
        if let Some(key) = &self.config.api_key {
            let mut value = HeaderValue::from_str(key.as_str())
                .map_err(|_| AiError::Protocol("the API key contains characters a header cannot carry".into()))?;
            value.set_sensitive(true);
            headers.insert(HeaderName::from_static("x-api-key"), value);
        }
        Ok(headers)
    }

    fn secret(&self) -> Option<&str> {
        self.config.api_key.as_ref().map(|k| k.as_str())
    }
}

/// `{base}/v1/messages`; a base that already ends in `/v1` is taken as it is.
fn messages_url(base: &url::Url) -> url::Url {
    if base.path().trim_end_matches('/').ends_with("/v1") {
        endpoint(base, "messages")
    } else {
        endpoint(base, "v1/messages")
    }
}

pub fn body(model: &str, request: &ChatRequest) -> Value {
    let messages: Vec<Value> = request
        .messages
        .iter()
        .map(|m| {
            let content: Vec<Value> = m
                .parts
                .iter()
                .map(|p| match p {
                    Part::Text(text) => json!({ "type": "text", "text": text }),
                    Part::ToolCall { id, name, arguments } => {
                        json!({ "type": "tool_use", "id": id, "name": name, "input": arguments })
                    }
                    Part::ToolResult { call_id, content, is_error } => json!({
                        "type": "tool_result", "tool_use_id": call_id, "content": content, "is_error": is_error,
                    }),
                })
                .collect();
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            json!({ "role": role, "content": content })
        })
        .collect();
    let mut body = json!({
        "model": model,
        "max_tokens": request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": messages,
        "stream": true,
    });
    if let Some(system) = &request.system {
        body["system"] = json!(system);
    }
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t);
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(
            request
                .tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters }))
                .collect::<Vec<_>>()
        );
    }
    body
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "end_turn" | "stop_sequence" => StopReason::End,
        "max_tokens" => StopReason::MaxTokens,
        "tool_use" => StopReason::ToolUse,
        other => StopReason::Other(other.to_string()),
    }
}

/// Tokens read from the prompt: the plain input plus what the prompt cache wrote and read.
fn input_tokens(usage: &Value) -> u64 {
    ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
        .iter()
        .filter_map(|k| usage.get(*k).and_then(Value::as_u64))
        .sum()
}

#[derive(Default)]
pub struct StreamState {
    /// Tool use blocks by index: id, name and the input JSON so far.
    tools: BTreeMap<u64, (String, String, String)>,
    usage: Usage,
    stop: Option<StopReason>,
}

impl StreamState {
    pub fn on_event(&mut self, name: &str, data: &str) -> Result<Vec<ChatEvent>, AiError> {
        let value: Value =
            serde_json::from_str(data).map_err(|e| AiError::Protocol(format!("a streamed event is not JSON: {e}")))?;
        // The event name is repeated as `type` in the data; either one names it.
        let kind = value.get("type").and_then(Value::as_str).unwrap_or(name);
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0);
        let mut out = Vec::new();
        match kind {
            "message_start" => {
                let usage = &value["message"]["usage"];
                self.usage.input_tokens = input_tokens(usage);
                self.usage.output_tokens = usage.get("output_tokens").and_then(Value::as_u64).unwrap_or(0);
                out.push(ChatEvent::Usage(self.usage));
            }
            "content_block_start" => {
                let block = &value["content_block"];
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        let id = block.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
                        let name = block.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                        self.tools.insert(index, (id, name, String::new()));
                    }
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                            out.push(ChatEvent::Text(text.to_string()));
                        }
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                            out.push(ChatEvent::Text(text.to_string()));
                        }
                    }
                    Some("input_json_delta") => {
                        if let (Some(tool), Some(part)) =
                            (self.tools.get_mut(&index), delta.get("partial_json").and_then(Value::as_str))
                        {
                            tool.2.push_str(part);
                        }
                    }
                    // Thinking and signature deltas are not part of the answer.
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some((id, name, input)) = self.tools.remove(&index) {
                    let arguments = if input.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&input)
                            .map_err(|e| AiError::Protocol(format!("tool input is not JSON: {e}")))?
                    };
                    out.push(ChatEvent::ToolCall { id, name, arguments });
                }
            }
            "message_delta" => {
                if let Some(reason) = value["delta"].get("stop_reason").and_then(Value::as_str) {
                    self.stop = Some(stop_reason(reason));
                }
                if let Some(tokens) = value["usage"].get("output_tokens").and_then(Value::as_u64) {
                    self.usage.output_tokens = tokens;
                }
                if value["usage"].get("input_tokens").is_some() {
                    self.usage.input_tokens = input_tokens(&value["usage"]);
                }
                out.push(ChatEvent::Usage(self.usage));
            }
            "message_stop" => {
                out.push(ChatEvent::Usage(self.usage));
                out.push(ChatEvent::Done(self.stop.take().unwrap_or(StopReason::End)));
            }
            "error" => {
                let error = &value["error"];
                let message = super::error_message(
                    error.get("message").and_then(Value::as_str).unwrap_or("unknown error").as_bytes(),
                );
                return Err(match error.get("type").and_then(Value::as_str) {
                    Some("overloaded_error") => AiError::Overloaded { status: 529, message },
                    Some("rate_limit_error") => AiError::Overloaded { status: 429, message },
                    _ => AiError::Status { status: 200, message },
                });
            }
            // `ping` and events added later.
            _ => {}
        }
        Ok(out)
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn config(&self) -> &ProviderConfig {
        &self.config
    }

    async fn stream(&self, request: &ChatRequest, cancel: &CancellationToken) -> Result<EventStream, AiError> {
        let deadline = Instant::now() + self.config.timeout;
        let url = messages_url(&self.config.base_url);
        let body = body(&self.config.model, request).to_string();
        let response = send_with_retries(&self.http, &url, &self.headers()?, body.as_bytes(), cancel, deadline)
            .await
            .map_err(|e| e.scrubbed(self.secret()))?;
        let mut state = StreamState::default();
        Ok(spawn_reader(response, cancel.clone(), deadline, self.config.api_key.clone(), move |event| {
            state.on_event(&event.name, &event.data)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{Message, ToolDef};

    #[test]
    fn the_url_takes_a_base_with_or_without_the_version() {
        for base in ["https://api.anthropic.com", "https://api.anthropic.com/", "https://proxy.example/anthropic/v1"] {
            let url = messages_url(&url::Url::parse(base).unwrap());
            assert!(url.path().ends_with("/v1/messages"), "{base}: {url}");
        }
    }

    #[test]
    fn the_body_has_max_tokens_system_and_tools() {
        let request = ChatRequest {
            system: Some("Sei knapp.".into()),
            messages: vec![Message::user("Hallo")],
            tools: vec![ToolDef {
                name: "count".into(),
                description: "Zählt".into(),
                parameters: json!({"type": "object"}),
            }],
            ..Default::default()
        };
        let b = body("model-x", &request);
        assert_eq!(b["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(b["system"], "Sei knapp.");
        assert_eq!(b["messages"][0], json!({ "role": "user", "content": [{ "type": "text", "text": "Hallo" }] }));
        assert_eq!(b["tools"][0]["input_schema"], json!({"type": "object"}));
    }

    #[test]
    fn a_stream_with_text_and_a_tool_call() {
        let mut s = StreamState::default();
        let events = [
            (
                "message_start",
                r#"{"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":1}}}"#,
            ),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Moin"}}"#,
            ),
            ("content_block_stop", r#"{"type":"content_block_stop","index":0}"#),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"count","input":{}}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"5}"}}"#,
            ),
            ("content_block_stop", r#"{"type":"content_block_stop","index":1}"#),
            ("ping", r#"{"type":"ping"}"#),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ];
        let out: Vec<ChatEvent> = events.iter().flat_map(|(n, d)| s.on_event(n, d).unwrap()).collect();
        assert_eq!(
            out,
            vec![
                // The input tokens as soon as the answer starts, so a call cut short still counts.
                ChatEvent::Usage(Usage { input_tokens: 15, output_tokens: 1 }),
                ChatEvent::Text("Moin".into()),
                ChatEvent::ToolCall { id: "t1".into(), name: "count".into(), arguments: json!({"a": 5}) },
                ChatEvent::Usage(Usage { input_tokens: 15, output_tokens: 9 }),
                ChatEvent::Usage(Usage { input_tokens: 15, output_tokens: 9 }),
                ChatEvent::Done(StopReason::ToolUse),
            ]
        );
    }

    #[test]
    fn an_overloaded_error_event_is_an_error() {
        let mut s = StreamState::default();
        let e = s
            .on_event("error", r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#)
            .unwrap_err();
        assert_eq!(e, AiError::Overloaded { status: 529, message: "Overloaded".into() });
    }
}
