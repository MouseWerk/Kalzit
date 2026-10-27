//! The OpenAI chat completions API (`POST {base}/chat/completions`), which OpenAI, LiteLLM,
//! Ollama (`http://localhost:11434/v1`), vLLM and LM Studio all speak. The base URL includes the
//! version path (`https://api.openai.com/v1`). Answers stream as server-sent events ending with
//! `data: [DONE]`; usage comes in the last chunk when the server supports `stream_options`. A
//! server that answers with one JSON document instead of a stream is read as well.

use std::collections::BTreeMap;

use async_trait::async_trait;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    AiError, ChatEvent, ChatRequest, EventStream, Part, Provider, ProviderConfig, Role, StopReason, Usage, endpoint,
    send_with_retries, spawn_reader,
};
use crate::http::HttpClient;

pub struct OpenAiProvider {
    config: ProviderConfig,
    http: HttpClient,
}

impl OpenAiProvider {
    pub fn new(config: ProviderConfig, http: HttpClient) -> Self {
        Self { config, http }
    }

    fn headers(&self) -> Result<HeaderMap, AiError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream, application/json"));
        if let Some(key) = &self.config.api_key {
            let mut value = HeaderValue::from_str(&format!("Bearer {}", key.as_str()))
                .map_err(|_| AiError::Protocol("the API key contains characters a header cannot carry".into()))?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        Ok(headers)
    }

    fn secret(&self) -> Option<&str> {
        self.config.api_key.as_ref().map(|k| k.as_str())
    }
}

/// The request body for `request`, streamed.
pub fn body(model: &str, request: &ChatRequest) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = &request.system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    for message in &request.messages {
        let text: String = message
            .parts
            .iter()
            .filter_map(|p| match p {
                Part::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        match message.role {
            Role::User => {
                // Tool results are messages of their own in this API, before any new text.
                for part in &message.parts {
                    if let Part::ToolResult { call_id, content, .. } = part {
                        messages.push(json!({ "role": "tool", "tool_call_id": call_id, "content": content }));
                    }
                }
                if !text.is_empty() {
                    messages.push(json!({ "role": "user", "content": text }));
                }
            }
            Role::Assistant => {
                let calls: Vec<Value> = message
                    .parts
                    .iter()
                    .filter_map(|p| match p {
                        Part::ToolCall { id, name, arguments } => Some(json!({
                            "id": id, "type": "function",
                            "function": { "name": name, "arguments": arguments.to_string() },
                        })),
                        _ => None,
                    })
                    .collect();
                let mut m =
                    json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { json!(text) } });
                if !calls.is_empty() {
                    m["tool_calls"] = json!(calls);
                }
                messages.push(m);
            }
        }
    }
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if let Some(max) = request.max_tokens {
        body["max_tokens"] = json!(max);
    }
    if let Some(t) = request.temperature {
        body["temperature"] = json!(t);
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(
            request
                .tools
                .iter()
                .map(|t| json!({ "type": "function", "function": {
                    "name": t.name, "description": t.description, "parameters": t.parameters,
                }}))
                .collect::<Vec<_>>()
        );
    }
    body
}

fn stop_reason(reason: &str) -> StopReason {
    match reason {
        "stop" => StopReason::End,
        "length" => StopReason::MaxTokens,
        "tool_calls" | "function_call" => StopReason::ToolUse,
        other => StopReason::Other(other.to_string()),
    }
}

fn usage_of(value: &Value) -> Option<Usage> {
    let u = value.get("usage").filter(|u| u.is_object())?;
    Some(Usage {
        input_tokens: u.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
        output_tokens: u.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
    })
}

fn arguments(raw: &str) -> Result<Value, AiError> {
    if raw.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(raw).map_err(|e| AiError::Protocol(format!("tool call arguments are not JSON: {e}")))
}

/// Turns the chunks of one streamed answer into chat events.
#[derive(Default)]
pub struct StreamState {
    /// Tool calls by index: id, name and the arguments so far.
    calls: BTreeMap<u64, (String, String, String)>,
    usage: Option<Usage>,
    stop: Option<StopReason>,
}

impl StreamState {
    pub fn on_data(&mut self, data: &str) -> Result<Vec<ChatEvent>, AiError> {
        if data.trim() == "[DONE]" {
            return self.finish();
        }
        let chunk: Value =
            serde_json::from_str(data).map_err(|e| AiError::Protocol(format!("a streamed chunk is not JSON: {e}")))?;
        if let Some(error) = chunk.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or("unknown error");
            return Err(AiError::Status { status: 200, message: super::error_message(message.as_bytes()) });
        }
        let mut out = Vec::new();
        if let Some(usage) = usage_of(&chunk) {
            self.usage = Some(usage);
        }
        for choice in chunk.get("choices").and_then(Value::as_array).into_iter().flatten() {
            let delta = &choice["delta"];
            if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                out.push(ChatEvent::Text(text.to_string()));
            }
            for call in delta.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                let entry = self.calls.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    entry.0 = id.to_string();
                }
                if let Some(name) = call["function"].get("name").and_then(Value::as_str) {
                    entry.1.push_str(name);
                }
                if let Some(args) = call["function"].get("arguments").and_then(Value::as_str) {
                    entry.2.push_str(args);
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.stop = Some(stop_reason(reason));
            }
        }
        Ok(out)
    }

    fn finish(&mut self) -> Result<Vec<ChatEvent>, AiError> {
        let mut out = Vec::new();
        for (_, (id, name, args)) in std::mem::take(&mut self.calls) {
            out.push(ChatEvent::ToolCall { id, name, arguments: arguments(&args)? });
        }
        if let Some(usage) = self.usage {
            out.push(ChatEvent::Usage(usage));
        }
        out.push(ChatEvent::Done(self.stop.take().unwrap_or(StopReason::End)));
        Ok(out)
    }
}

/// The events of an answer sent as one JSON document.
fn whole_answer(body: &[u8]) -> Result<Vec<ChatEvent>, AiError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| AiError::Protocol(format!("the answer is not JSON: {e}")))?;
    let choice = value
        .get("choices")
        .and_then(|c| c.get(0))
        .ok_or_else(|| AiError::Protocol("the answer has no choices".into()))?;
    let message = &choice["message"];
    let mut out = Vec::new();
    if let Some(text) = message.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        out.push(ChatEvent::Text(text.to_string()));
    }
    for call in message.get("tool_calls").and_then(Value::as_array).into_iter().flatten() {
        let function = &call["function"];
        out.push(ChatEvent::ToolCall {
            id: call.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            name: function.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            arguments: arguments(function.get("arguments").and_then(Value::as_str).unwrap_or(""))?,
        });
    }
    if let Some(usage) = usage_of(&value) {
        out.push(ChatEvent::Usage(usage));
    }
    let stop = choice.get("finish_reason").and_then(Value::as_str).map(stop_reason).unwrap_or(StopReason::End);
    out.push(ChatEvent::Done(stop));
    Ok(out)
}

#[async_trait]
impl Provider for OpenAiProvider {
    fn config(&self) -> &ProviderConfig {
        &self.config
    }

    async fn stream(&self, request: &ChatRequest, cancel: &CancellationToken) -> Result<EventStream, AiError> {
        let url = endpoint(&self.config.base_url, "chat/completions");
        let body = body(&self.config.model, request).to_string();
        let response = send_with_retries(&self.http, &url, &self.headers()?, body.as_bytes(), cancel)
            .await
            .map_err(|e| e.scrubbed(self.secret()))?;
        let is_json = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("application/json"));
        if is_json {
            let bytes = tokio::select! {
                () = cancel.cancelled() => return Err(AiError::Cancelled),
                b = crate::http::read_limited(response, super::MAX_ANSWER_BYTES) => b.map_err(AiError::from_http)?,
            };
            let events = whole_answer(&bytes).map_err(|e| e.scrubbed(self.secret()))?;
            return Ok(Box::pin(futures_util::stream::iter(events.into_iter().map(Ok))));
        }
        let mut state = StreamState::default();
        Ok(spawn_reader(response, cancel.clone(), self.config.api_key.clone(), move |event| state.on_data(&event.data)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{Message, ToolDef};

    #[test]
    fn the_body_carries_system_tools_and_tool_results() {
        let request = ChatRequest {
            system: Some("Sei knapp.".into()),
            messages: vec![
                Message::user("Wie viele?"),
                Message {
                    role: Role::Assistant,
                    parts: vec![Part::ToolCall { id: "c1".into(), name: "count".into(), arguments: json!({"a": 1}) }],
                },
                Message {
                    role: Role::User,
                    parts: vec![Part::ToolResult { call_id: "c1".into(), content: "3".into(), is_error: false }],
                },
            ],
            tools: vec![ToolDef {
                name: "count".into(),
                description: "Zählt".into(),
                parameters: json!({"type": "object"}),
            }],
            max_tokens: Some(16),
            temperature: None,
        };
        let b = body("llama3", &request);
        assert_eq!(b["model"], "llama3");
        assert_eq!(b["messages"][0], json!({ "role": "system", "content": "Sei knapp." }));
        assert_eq!(b["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"a\":1}");
        assert_eq!(b["messages"][3], json!({ "role": "tool", "tool_call_id": "c1", "content": "3" }));
        assert_eq!(b["tools"][0]["function"]["name"], "count");
        assert_eq!(b["max_tokens"], 16);
        assert_eq!(b["stream"], true);
    }

    #[test]
    fn tool_call_fragments_are_joined() {
        let mut s = StreamState::default();
        let chunks = [
            r#"{"choices":[{"delta":{"content":"Hal"}}]}"#,
            r#"{"choices":[{"delta":{"content":"lo"}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"count","arguments":"{\"a\""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":2}"}}]},"finish_reason":"tool_calls"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
            "[DONE]",
        ];
        let events: Vec<ChatEvent> = chunks.iter().flat_map(|c| s.on_data(c).unwrap()).collect();
        assert_eq!(
            events,
            vec![
                ChatEvent::Text("Hal".into()),
                ChatEvent::Text("lo".into()),
                ChatEvent::ToolCall { id: "c1".into(), name: "count".into(), arguments: json!({"a": 2}) },
                ChatEvent::Usage(Usage { input_tokens: 7, output_tokens: 3 }),
                ChatEvent::Done(StopReason::ToolUse),
            ]
        );
    }

    #[test]
    fn a_whole_json_answer_is_read() {
        let body = br#"{"choices":[{"message":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}"#;
        assert_eq!(
            whole_answer(body).unwrap(),
            vec![
                ChatEvent::Text("OK".into()),
                ChatEvent::Usage(Usage { input_tokens: 5, output_tokens: 1 }),
                ChatEvent::Done(StopReason::End),
            ]
        );
    }
}
