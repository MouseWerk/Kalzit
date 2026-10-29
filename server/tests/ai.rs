//! AI configuration, status, calls, limits and rights through the real router, against in-process
//! mock servers for the OpenAI chat completions API and the Anthropic Messages API.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::response::Response;
use futures_util::StreamExt;
use http_body_util::BodyExt;
use kalzit::ai::service::{self, Caller};
use kalzit::ai::{ChatEvent, ChatRequest, Message, Usage};
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const KEY: &str = "sk-test-geheimer-schluessel-4711";

struct TestApp {
    app: Router,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
}

#[derive(Clone)]
struct Session {
    cookie: String,
    user_id: String,
}

async fn test_app() -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3999".into();
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), state, dir: Arc::new(dir) }
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, who: Option<&Session>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(who) = who {
            req = req.header(header::COOKIE, &who.cookie);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(cookie) = headers.get(header::SET_COOKIE) {
            let cookie = cookie.to_str().unwrap().split(';').next().unwrap().to_string();
            return Reply { status, body: json!({ "cookie": cookie, "body": body }) };
        }
        Reply { status, body }
    }

    async fn get(&self, path: &str, who: &Session) -> Reply {
        self.send(Method::GET, path, None, Some(who)).await
    }

    async fn post(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::POST, path, Some(body), Some(who)).await
    }

    async fn patch(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::PATCH, path, Some(body), Some(who)).await
    }

    async fn sign_in(&self, r: Reply) -> Session {
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        Session {
            cookie: r.body["cookie"].as_str().unwrap().into(),
            user_id: r.body["body"]["id"].as_str().unwrap().into(),
        }
    }

    /// The owner (also server admin) and the id of their organization.
    async fn setup(&self) -> (Session, String) {
        let r = self
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        let org = r.body["body"]["orgs"][0]["id"].as_str().unwrap().to_string();
        (self.sign_in(r).await, org)
    }

    /// A new account, member of `org` with `role`, signed in.
    async fn member(&self, owner: &Session, org: &str, email: &str, role: &str) -> Session {
        let r =
            self.post("/api/admin/users", json!({ "name": email, "email": email, "password": PASSWORD }), owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let r = self.post(&format!("/api/orgs/{org}/members"), json!({ "email": email, "role": role }), owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let r = self
            .send(Method::POST, "/api/auth/login", Some(json!({ "email": email, "password": PASSWORD })), None)
            .await;
        self.sign_in(r).await
    }

    async fn setting(&self, key: &str, value: Value, admin: &Session) {
        let current = self.get("/api/admin/settings", admin).await;
        let version = current.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == key)
            .map(|s| s["version"].as_i64().unwrap())
            .unwrap();
        let r = self
            .patch(&format!("/api/admin/settings/{key}"), json!({ "value": value, "version": version }), admin)
            .await;
        assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
    }

    /// Turns AI on, after marking every stored provider as tested (the switch needs a passed
    /// connection test; the tests of that rule are their own).
    async fn enable(&self, admin: &Session) {
        sqlx::query("UPDATE ai_providers SET last_test_ok = 1, last_tested_at = 0")
            .execute(&self.state.db)
            .await
            .unwrap();
        self.setting("ai.enabled", json!(true), admin).await;
    }

    async fn org_setting(&self, org: &str, key: &str, value: Value, admin: &Session) {
        let current = self.get(&format!("/api/orgs/{org}/settings"), admin).await;
        let version = current.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == key)
            .map(|s| s["version"].as_i64().unwrap())
            .unwrap();
        let r = self
            .patch(&format!("/api/orgs/{org}/settings/{key}"), json!({ "value": value, "version": version }), admin)
            .await;
        assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
    }

    async fn audit(&self) -> Vec<(String, String)> {
        sqlx::query_as("SELECT action, summary FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap()
    }

    /// Acknowledges the first-use notice for the provider in effect, as the UI does.
    async fn ack(&self, org: &str, who: &Session) {
        let status = self.get(&format!("/api/orgs/{org}/ai/status"), who).await;
        let id = status.body["provider"]["id"].as_str().expect("a provider in effect").to_string();
        let r = self.post(&format!("/api/orgs/{org}/ai/notice"), json!({ "providerId": id }), who).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    }

    fn caller(&self, org: &str, who: &Session) -> Caller {
        Caller {
            org_id: org.into(),
            user_id: who.user_id.clone(),
            address: None,
            purpose: "test_suite",
            prompt_version: None,
        }
    }
}

/// What a mock provider answers.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Ok,
    /// 503 once, then the answer.
    FailOnce,
    /// 401 with the key echoed in the error message.
    Unauthorized,
    /// The first event, then nothing more.
    Hang,
    /// The answer after 1.5 seconds.
    Delay,
    /// 400 to a request with `stream_options`, the answer without.
    RejectStreamOptions,
}

#[derive(Default)]
struct Seen {
    requests: Vec<(HeaderMap, Value)>,
    failed: bool,
}

struct Mock {
    addr: SocketAddr,
    seen: Arc<Mutex<Seen>>,
}

impl Mock {
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn requests(&self) -> usize {
        self.seen.lock().unwrap().requests.len()
    }

    fn last(&self) -> (HeaderMap, Value) {
        self.seen.lock().unwrap().requests.last().cloned().unwrap()
    }
}

const OPENAI_STREAM: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hallo\"}}]}\n\n",
    ": keep-alive\n\n",
    "data: {\"choices\":[{\"delta\":{\"content\":\" Welt\"},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":2}}\n\n",
    "data: [DONE]\n\n",
);

const ANTHROPIC_STREAM: &str = concat!(
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9,\"output_tokens\":1}}}\n\n",
    "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
    "event: ping\ndata: {\"type\":\"ping\"}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n",
    "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
);

fn sse(text: &'static str, hang: bool) -> Response {
    let body = if hang {
        let first = text.split_inclusive("\n\n").next().unwrap();
        let chunks = futures_util::stream::iter([Ok::<_, std::io::Error>(Bytes::from_static(first.as_bytes()))])
            .chain(futures_util::stream::pending());
        Body::from_stream(chunks)
    } else {
        Body::from(text)
    };
    Response::builder().header(header::CONTENT_TYPE, "text/event-stream").body(body).unwrap()
}

#[expect(clippy::disallowed_methods, reason = "a mock AI provider, not an API route")]
async fn mock(path: &'static str, stream: &'static str, mode: Mode) -> Mock {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let handler_seen = seen.clone();
    let app = Router::new().route(
        path,
        axum::routing::post(move |headers: HeaderMap, body: Bytes| {
            let seen = handler_seen.clone();
            async move {
                let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                if mode == Mode::Delay {
                    seen.lock().unwrap().requests.push((headers, body));
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    return sse(stream, false);
                }
                let mut s = seen.lock().unwrap();
                let asks_usage = body.get("stream_options").is_some();
                s.requests.push((headers, body));
                match mode {
                    Mode::RejectStreamOptions if asks_usage => Response::builder()
                        .status(400)
                        .body(Body::from("{\"error\":{\"message\":\"unknown field stream_options\"}}"))
                        .unwrap(),
                    Mode::FailOnce if !s.failed => {
                        s.failed = true;
                        Response::builder().status(503).body(Body::from("{\"error\":{\"message\":\"busy\"}}")).unwrap()
                    }
                    Mode::Unauthorized => Response::builder()
                        .status(401)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(format!(
                            "{{\"error\":{{\"message\":\"Incorrect API key provided: {KEY}\"}}}}"
                        )))
                        .unwrap(),
                    Mode::Hang => sse(stream, true),
                    _ => sse(stream, false),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Mock { addr, seen }
}

async fn openai(mode: Mode) -> Mock {
    mock("/v1/chat/completions", OPENAI_STREAM, mode).await
}

async fn anthropic(mode: Mode) -> Mock {
    mock("/v1/messages", ANTHROPIC_STREAM, mode).await
}

fn provider_body(kind: &str, base_url: String, key: Option<&str>) -> Value {
    let mut body = json!({ "name": format!("{kind} lokal"), "kind": kind, "baseUrl": base_url, "model": "modell-1" });
    if let Some(key) = key {
        body["apiKey"] = json!(key);
    }
    body
}

fn hello() -> ChatRequest {
    ChatRequest { messages: vec![Message::user("Vertrauliche Frage zu Umsätzen")], ..Default::default() }
}

#[tokio::test]
async fn status_says_nothing_while_ai_is_off_and_follows_the_provider_in_effect() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let viewer = t.member(&owner, &org, "vera@example.de", "viewer").await;
    let status = format!("/api/orgs/{org}/ai/status");

    let r = t.get(&status, &viewer).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.body,
        json!({ "enabled": false, "usable": false, "orgProvidersAllowed": true }),
        "off: no reason, provider or usage"
    );

    // A provider alone does not turn AI on.
    let server_mock = openai(Mode::Ok).await;
    let r = t.post("/api/admin/ai/providers", provider_body("openai", server_mock.url("/v1"), None), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(
        t.get(&status, &viewer).await.body,
        json!({ "enabled": false, "usable": false, "orgProvidersAllowed": true })
    );

    let server_id = r.body["id"].as_str().unwrap().to_string();
    t.enable(&owner).await;
    let r = t.get(&status, &viewer).await;
    assert_eq!(r.body["usable"], true);
    assert_eq!(r.body["noticeAcknowledged"], false);
    let endpoint = r.body["provider"]["endpoint"].as_str().unwrap_or_default().to_string();
    assert!(endpoint.starts_with("127.0.0.1:"), "{endpoint}");
    assert_eq!(
        r.body["provider"],
        json!({
            "id": server_id, "name": "openai lokal", "kind": "openai", "model": "modell-1", "host": "127.0.0.1",
            "scope": "server", "endpoint": endpoint, "leavesNetwork": false, "leavesNetworkEstimated": true,
            "usable": true, "reachable": true,
            "noticeAcknowledged": false
        })
    );
    assert_eq!(r.body["maxRowsToModel"], 200);
    assert!(r.body.get("noticeText").is_none(), "no addition of the administrators yet");
    t.setting("ai.notice_text", json!("  Fragen an datenschutz@example.org.  "), &owner).await;
    assert_eq!(t.get(&status, &viewer).await.body["noticeText"], "Fragen an datenschutz@example.org.");
    assert_eq!(r.body["usage"]["requestsLimit"], 200);
    assert_eq!(r.body["usage"]["orgTokensMonthLimit"], 20_000_000);
    assert!(!r.body.to_string().contains('€') && r.body["usage"].get("cost").is_none(), "tokens, no prices");

    // The first call waits for the notice, once per person and provider.
    let caller = t.caller(&org, &viewer);
    let e = service::complete(&t.state, &caller, &hello(), &CancellationToken::new()).await.unwrap_err();
    assert_eq!(e.reason.unwrap().code, "ai.notice_required");
    let wrong = t.post(&format!("/api/orgs/{org}/ai/notice"), json!({ "providerId": "x" }), &viewer).await;
    assert_eq!(wrong.reason(), "ai.notice_provider_changed");
    t.ack(&org, &viewer).await;
    assert_eq!(t.get(&status, &viewer).await.body["noticeAcknowledged"], true);
    service::complete(&t.state, &caller, &hello(), &CancellationToken::new()).await.unwrap();

    // An organization can lower a limit but not raise it, and turn AI off for its members.
    t.org_setting(&org, "ai.user_requests_per_day", json!(5), &owner).await;
    assert_eq!(t.get(&status, &viewer).await.body["usage"]["requestsLimit"], 5);
    t.org_setting(&org, "ai.user_requests_per_day", json!(5000), &owner).await;
    assert_eq!(t.get(&status, &viewer).await.body["usage"]["requestsLimit"], 200);
    t.org_setting(&org, "ai.chat_retention_days", json!(90), &owner).await;
    assert_eq!(service::chat_retention_days(&t.state, &org).await.unwrap(), 30, "never longer than the server's");
    t.org_setting(&org, "ai.chat_retention_days", json!(7), &owner).await;
    assert_eq!(service::chat_retention_days(&t.state, &org).await.unwrap(), 7);
    t.org_setting(&org, "ai.org_enabled", json!(false), &owner).await;
    assert_eq!(
        t.get(&status, &viewer).await.body,
        json!({ "enabled": false, "usable": false, "orgProvidersAllowed": true })
    );
    let e = service::complete(&t.state, &caller, &hello(), &CancellationToken::new()).await.unwrap_err();
    assert_eq!(e.reason.unwrap().code, "ai.org_disabled");
    t.org_setting(&org, "ai.org_enabled", json!(true), &owner).await;

    // The organization's own provider wins over the server's, and asks for the notice again.
    let org_mock = anthropic(Mode::Ok).await;
    let r = t
        .post(&format!("/api/orgs/{org}/ai/providers"), provider_body("anthropic", org_mock.url(""), Some(KEY)), &owner)
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let r = t.get(&status, &viewer).await;
    assert_eq!(r.body["provider"]["scope"], "org");
    assert_eq!(r.body["provider"]["kind"], "anthropic");
    assert_eq!(r.body["noticeAcknowledged"], false);

    // Unless the server does not allow organizations their own provider.
    t.setting("ai.allow_org_providers", json!(false), &owner).await;
    assert_eq!(t.get(&status, &viewer).await.body["provider"]["scope"], "server");
    let r = t
        .post(&format!("/api/orgs/{org}/ai/providers"), provider_body("anthropic", org_mock.url(""), Some(KEY)), &owner)
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "ai.org_providers_not_allowed"));
    t.setting("ai.allow_org_providers", json!(true), &owner).await;

    // Without any provider, AI is on but not usable.
    for (list, prefix) in [
        (format!("/api/orgs/{org}/ai/providers"), format!("/api/orgs/{org}/ai/providers")),
        ("/api/admin/ai/providers".to_string(), "/api/admin/ai/providers".to_string()),
    ] {
        for p in t.get(&list, &owner).await.body["items"].as_array().unwrap().clone() {
            let r =
                t.send(Method::DELETE, &format!("{prefix}/{}", p["id"].as_str().unwrap()), None, Some(&owner)).await;
            assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
        }
    }
    let r = t.get(&status, &viewer).await;
    assert_eq!(
        r.body,
        json!({ "enabled": true, "usable": false, "orgProvidersAllowed": true, "reason": "ai.no_provider" })
    );
    let e =
        service::complete(&t.state, &t.caller(&org, &viewer), &hello(), &CancellationToken::new()).await.unwrap_err();
    assert_eq!((e.code, e.reason.unwrap().code.as_str()), ("ai_unavailable", "ai.no_provider"));

    t.setting("ai.enabled", json!(false), &owner).await;
    let e =
        service::complete(&t.state, &t.caller(&org, &viewer), &hello(), &CancellationToken::new()).await.unwrap_err();
    assert_eq!((e.status, e.reason.unwrap().code.as_str()), (StatusCode::CONFLICT, "ai.disabled"));
    t.finish().await;
}

#[tokio::test]
async fn the_key_is_stored_encrypted_and_never_answered_logged_or_audited() {
    let t = test_app().await;
    let (owner, _org) = t.setup().await;
    let mock = openai(Mode::Unauthorized).await;
    let r = t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), Some(KEY)), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["apiKeySet"], true);
    assert_eq!(r.body["isDefault"], true, "the first provider of a scope is its default");
    let id = r.body["id"].as_str().unwrap().to_string();
    assert!(!r.body.to_string().contains(KEY));
    assert!(!t.get("/api/admin/ai/providers", &owner).await.body.to_string().contains(KEY));

    // The provider echoes the key in its error; the answer and the audit entry do not.
    let r = t.post(&format!("/api/admin/ai/providers/{id}/test"), json!({}), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["ok"], false);
    assert_eq!(r.body["reason"], "ai.provider_unauthorized");
    assert!(!r.body.to_string().contains(KEY), "{}", r.body);
    let (headers, _) = mock.last();
    assert_eq!(headers[header::AUTHORIZATION], format!("Bearer {KEY}"), "the key reached the provider");

    let stored: Vec<(String,)> =
        sqlx::query_as("SELECT ciphertext FROM ai_provider_secrets").fetch_all(&t.state.db).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert!(!stored[0].0.contains(KEY));
    for (action, summary) in t.audit().await {
        assert!(!summary.contains(KEY), "{action}: {summary}");
    }
    let actions: Vec<String> = t.audit().await.into_iter().map(|(a, _)| a).collect();
    assert!(actions.contains(&"ai.provider_created".into()) && actions.contains(&"ai.provider_tested".into()));

    // A new address does not get the old key unless it is sent again.
    let updated_at = t.get("/api/admin/ai/providers", &owner).await.body["items"][0]["updatedAt"].clone();
    let other = openai(Mode::Ok).await;
    let r = t
        .patch(
            &format!("/api/admin/ai/providers/{id}"),
            json!({ "baseUrl": other.url("/v1"), "expectedUpdatedAt": updated_at }),
            &owner,
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "ai.key_resend_on_target_change"));
    let r = t
        .patch(
            &format!("/api/admin/ai/providers/{id}"),
            json!({ "baseUrl": other.url("/v1"), "apiKey": null, "expectedUpdatedAt": updated_at }),
            &owner,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["apiKeySet"], false);
    let r = t
        .patch(
            &format!("/api/admin/ai/providers/{id}"),
            json!({ "name": "alt", "expectedUpdatedAt": updated_at }),
            &owner,
        )
        .await;
    assert_eq!(r.code(), "version_conflict", "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn openai_compatible_calls_stream_retry_and_are_counted_and_audited() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let mock = openai(Mode::FailOnce).await;
    let r = t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1/"), Some(KEY)), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    t.enable(&owner).await;
    t.ack(&org, &owner).await;

    let caller = t.caller(&org, &owner);
    let events: Vec<ChatEvent> = service::stream(&t.state, &caller, &hello(), &CancellationToken::new())
        .await
        .unwrap()
        .map(|e| e.unwrap())
        .collect()
        .await;
    let text: String = events
        .iter()
        .filter_map(|e| match e {
            ChatEvent::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hallo Welt");
    assert!(events.contains(&ChatEvent::Usage(Usage { input_tokens: 11, output_tokens: 2 })));
    assert_eq!(mock.requests(), 2, "the 503 was retried once");
    let (_, body) = mock.last();
    assert_eq!(body["model"], "modell-1");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["content"], "Vertrauliche Frage zu Umsätzen");

    // Counted when it started, its tokens added when it ended (in its own task).
    let deadline = tokio::time::Instant::now() + common::HANG_GUARD;
    loop {
        let (user, org_counts) = service::today(&t.state, &org, &owner.user_id).await.unwrap();
        if user.tokens == 13 {
            assert_eq!((user.requests, org_counts.requests), (1, 1));
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "the tokens were never counted");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let audit = t.audit().await;
    let (_, summary) = audit.iter().find(|(a, _)| a == "ai.called").expect("the call is audited");
    let summary: Value = serde_json::from_str(summary).unwrap();
    assert_eq!(summary["purpose"], "test_suite");
    assert_eq!(summary["model"], "modell-1");
    assert_eq!(summary["providerKind"], "openai");
    assert_eq!((summary["inputTokens"].as_u64(), summary["outputTokens"].as_u64()), (Some(11), Some(2)));
    assert_eq!(summary["outcome"], "ok");
    for (_, s) in &audit {
        assert!(!s.contains("Vertrauliche") && !s.contains("Hallo Welt"), "no prompt or answer in the audit: {s}");
    }

    let usage = t.get("/api/admin/ai/usage?days=1", &owner).await;
    assert_eq!(usage.body["items"][0]["requests"], 1, "{}", usage.body);
    assert_eq!(usage.body["items"][0]["inputTokens"], 11);
    let usage = t.get(&format!("/api/orgs/{org}/ai/usage"), &owner).await;
    assert_eq!(usage.body["items"][0]["userId"], owner.user_id.as_str());
    assert_eq!(t.get("/api/admin/ai/usage?days=91", &owner).await.code(), "validation");
    t.finish().await;
}

#[tokio::test]
async fn anthropic_calls_send_the_version_and_key_headers() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let mock = anthropic(Mode::Ok).await;
    let r = t.post("/api/admin/ai/providers", provider_body("anthropic", mock.url(""), None), &owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "ai.key_required"), "{}", r.body);
    let r = t.post("/api/admin/ai/providers", provider_body("anthropic", mock.url(""), Some(KEY)), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap();

    let r = t.post(&format!("/api/admin/ai/providers/{id}/test"), json!({}), &owner).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);
    assert_eq!(r.body["reply"], "OK");
    assert_eq!(r.body["usage"], json!({ "inputTokens": 9, "outputTokens": 3 }));
    let (headers, body) = mock.last();
    assert_eq!(headers["x-api-key"], KEY);
    assert_eq!(headers["anthropic-version"], "2023-06-01");
    assert_eq!(body["max_tokens"], 512);
    assert_eq!(body["messages"][0]["content"][0]["text"], "Reply with the single word OK.");
    let listed = t.get("/api/admin/ai/providers", &owner).await;
    assert_eq!(listed.body["items"][0]["lastTest"]["ok"], true, "{}", listed.body);

    // The passed test is what allows the switch.
    t.setting("ai.enabled", json!(true), &owner).await;
    t.ack(&org, &owner).await;
    let answer =
        service::complete(&t.state, &t.caller(&org, &owner), &hello(), &CancellationToken::new()).await.unwrap();
    assert_eq!(answer.text, "OK");
    assert_eq!(answer.usage, Usage { input_tokens: 9, output_tokens: 3 });
    t.finish().await;
}

#[tokio::test]
async fn daily_and_concurrent_limits_refuse_calls() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let ada = t.member(&owner, &org, "ada@example.de", "editor").await;
    t.setting("ai.user_requests_per_day", json!(2), &owner).await;
    let mock = openai(Mode::Ok).await;
    t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), None), &owner).await;
    t.enable(&owner).await;
    t.ack(&org, &ada).await;
    t.ack(&org, &owner).await;

    let cancel = CancellationToken::new();
    for _ in 0..2 {
        service::complete(&t.state, &t.caller(&org, &ada), &hello(), &cancel).await.unwrap();
    }
    let e = service::complete(&t.state, &t.caller(&org, &ada), &hello(), &cancel).await.unwrap_err();
    assert_eq!((e.code, e.reason.as_ref().unwrap().code.as_str()), ("rate_limited", "ai.limit_user_requests"));
    assert!(e.retry_after_secs.is_some());
    // Another member still may.
    service::complete(&t.state, &t.caller(&org, &owner), &hello(), &cancel).await.unwrap();

    // The organization's tokens this month: 3 calls of 13 tokens each are 39.
    assert_eq!(service::month_tokens(&t.state, &org).await.unwrap(), 39);
    t.setting("ai.org_tokens_per_month", json!(39), &owner).await;
    let e = service::complete(&t.state, &t.caller(&org, &owner), &hello(), &cancel).await.unwrap_err();
    assert_eq!(e.reason.as_ref().unwrap().code, "ai.limit_org_tokens");
    assert!(e.retry_after_secs.unwrap().get() > 24 * 60 * 60, "until the month ends");
    t.finish().await;
}

#[tokio::test]
async fn a_running_call_holds_its_place_until_it_is_cancelled_or_dropped() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    t.setting("ai.max_concurrent_per_user", json!(1), &owner).await;
    let mock = openai(Mode::Hang).await;
    t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), None), &owner).await;
    t.enable(&owner).await;
    t.ack(&org, &owner).await;
    let caller = t.caller(&org, &owner);

    let cancel = CancellationToken::new();
    let mut first = Box::pin(service::stream(&t.state, &caller, &hello(), &cancel).await.unwrap());
    assert_eq!(first.next().await.unwrap().unwrap(), ChatEvent::Text("Hallo".into()));
    let e = service::stream(&t.state, &caller, &hello(), &CancellationToken::new()).await.err().unwrap();
    assert_eq!(e.reason.unwrap().code, "ai.limit_user_concurrent");

    cancel.cancel();
    let ended = tokio::time::timeout(common::HANG_GUARD, async {
        while let Some(item) = first.next().await {
            if let Err(e) = item {
                return e.reason.map(|r| r.code);
            }
        }
        None
    })
    .await
    .expect("cancelling ends the stream");
    assert_eq!(ended.as_deref(), Some("ai.cancelled"));

    // Dropping a stream frees its place as well.
    let second = service::stream(&t.state, &caller, &hello(), &CancellationToken::new()).await;
    let second = match second {
        Ok(s) => s,
        Err(_) => {
            wait_idle(&t.state).await;
            service::stream(&t.state, &caller, &hello(), &CancellationToken::new()).await.unwrap()
        }
    };
    drop(second);
    wait_idle(&t.state).await;
    let outcomes: Vec<String> = t
        .audit()
        .await
        .into_iter()
        .filter(|(a, _)| a == "ai.called")
        .map(|(_, s)| serde_json::from_str::<Value>(&s).unwrap()["outcome"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(outcomes.len(), 2, "{outcomes:?}");
    assert!(outcomes.iter().all(|o| o == "cancelled"), "{outcomes:?}");
    t.finish().await;
}

async fn wait_idle(state: &AppState) {
    let deadline = tokio::time::Instant::now() + common::HANG_GUARD;
    while state.ai.running() > 0 {
        assert!(tokio::time::Instant::now() < deadline, "the call kept its place");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The audit entry is written right after the place is given back.
    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn base_urls_follow_the_data_source_target_policy() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let create = |url: &str| provider_body("openai", url.to_string(), None);
    let cases = [
        ("http://169.254.169.254/v1", "datasource_target_blocked", "target.metadata_address"),
        ("http://localhost:3999/v1", "datasource_target_blocked", "ai.base_url_kalzit"),
        ("http://127.0.0.1:3999/v1", "datasource_target_blocked", "ai.base_url_kalzit"),
        ("http://nutzer:pass@localhost:11434/v1", "validation", "ai.base_url_invalid"),
        ("ftp://localhost/v1", "validation", "ai.base_url_invalid"),
        ("http://localhost:11434/v1?x=1", "validation", "ai.base_url_invalid"),
    ];
    for (url, code, reason) in cases {
        for path in ["/api/admin/ai/providers".to_string(), format!("/api/orgs/{org}/ai/providers")] {
            let r = t.post(&path, create(url), &owner).await;
            assert_eq!((r.code(), r.reason()), (code, reason), "{url} at {path}: {}", r.body);
        }
    }
    // Private networks and localhost are allowed, as for data sources.
    let r = t.post("/api/admin/ai/providers", create("http://localhost:11434/v1"), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);

    // The allow-list of data sources applies, at saving and at every connection.
    let mock = openai(Mode::Ok).await;
    let r = t.post("/api/admin/ai/providers", create(&mock.url("/v1")), &owner).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    t.setting("datasources.allowed_targets", json!(["db.intern.example"]), &owner).await;
    let r = t.post("/api/admin/ai/providers", create("http://10.1.2.3/v1"), &owner).await;
    assert_eq!(r.reason(), "target.not_allowed", "{}", r.body);
    let r = t.post(&format!("/api/admin/ai/providers/{id}/test"), json!({}), &owner).await;
    assert_eq!((r.body["ok"].as_bool(), r.body["reason"].as_str()), (Some(false), Some("target.not_allowed")));
    assert_eq!(mock.requests(), 0, "nothing was sent");
    t.finish().await;
}

#[tokio::test]
async fn only_admins_configure_and_only_source_admins_open_a_source_to_ai() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let admin = t.member(&owner, &org, "anna@example.de", "admin").await;
    let editor = t.member(&owner, &org, "ede@example.de", "editor").await;
    let viewer = t.member(&owner, &org, "vera@example.de", "viewer").await;
    let mock = openai(Mode::Ok).await;
    let org_providers = format!("/api/orgs/{org}/ai/providers");

    for who in [&admin, &editor, &viewer] {
        let r = t.get("/api/admin/ai/providers", who).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "server config is for server administrators");
        let r = t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), None), who).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN);
        let r = t.get(&format!("/api/orgs/{org}/ai/status"), who).await;
        assert_eq!(r.status, StatusCode::OK, "every member may ask for the status");
    }
    for who in [&editor, &viewer] {
        assert_eq!(t.get(&org_providers, who).await.status, StatusCode::FORBIDDEN);
        let r = t.post(&org_providers, provider_body("openai", mock.url("/v1"), None), who).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN);
        assert_eq!(t.get(&format!("/api/orgs/{org}/ai/usage"), who).await.status, StatusCode::FORBIDDEN);
    }
    let r = t.post(&org_providers, provider_body("openai", mock.url("/v1"), None), &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["scope"], "org");
    let id = r.body["id"].as_str().unwrap();
    // An organization's provider is not reachable through the server's routes or another org's.
    let r = t.send(Method::DELETE, &format!("/api/admin/ai/providers/{id}"), None, Some(&owner)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // A data source, closed to AI until someone who administers it opens it.
    let ds = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
         VALUES ($1, $2, 'Umsatz', 'prometheus', '{\"url\":\"http://localhost:9090\"}', 0, 0)",
    )
    .bind(&ds)
    .bind(&org)
    .execute(&t.state.db)
    .await
    .unwrap();
    assert!(!kalzit::ai::store::datasource_readable(&t.state.db, &ds).await.unwrap());
    let access = format!("/api/orgs/{org}/datasources/{ds}/ai-access");
    // An editor sees the source but may not edit it; a viewer does not even see it.
    for (who, status) in [(&editor, StatusCode::FORBIDDEN), (&viewer, StatusCode::NOT_FOUND)] {
        let r = t.send(Method::PUT, &access, Some(json!({ "readable": true })), Some(who)).await;
        assert_eq!(r.status, status, "{}", r.body);
    }
    let r = t.get(&access, &editor).await;
    assert_eq!(r.body, json!({ "datasourceId": ds, "readable": false, "excludedFields": [], "outwardFacing": false }));
    let bad = json!({ "readable": true, "excludedFields": ["kunden..email"] });
    let r = t.send(Method::PUT, &access, Some(bad), Some(&admin)).await;
    assert_eq!(r.reason(), "ai.excluded_fields_invalid", "{}", r.body);
    let body = json!({ "readable": true, "excludedFields": ["kunden.email", " kunden.iban "] });
    let r = t.send(Method::PUT, &access, Some(body), Some(&admin)).await;
    assert_eq!(
        r.body,
        json!({ "datasourceId": ds, "readable": true, "excludedFields": ["kunden.email", "kunden.iban"],
                "outwardFacing": false })
    );
    assert!(kalzit::ai::store::datasource_readable(&t.state.db, &ds).await.unwrap());
    let r = t.get(&format!("/api/orgs/{org}/ai/datasources"), &editor).await;
    assert_eq!(r.body["items"], json!([{ "datasourceId": ds }]));
    let r = t.get(&format!("/api/orgs/{org}/ai/datasources"), &viewer).await;
    assert_eq!(r.body["items"], json!([]), "only sources the caller may read are listed");

    // The shared helper applies what was stored, with the server's row limit.
    t.setting("ai.max_rows_to_model", json!(1), &owner).await;
    let policy = kalzit::ai::redact::policy(&t.state, &ds).await.unwrap();
    assert!(policy.readable && policy.excludes("email") && policy.excludes("kunden.iban"));
    assert_eq!(policy.max_rows, 1);

    // Closing keeps the excluded fields for the next opening.
    let r = t.send(Method::PUT, &access, Some(json!({ "readable": false })), Some(&owner)).await;
    assert_eq!(r.body["readable"], false);
    assert_eq!(r.body["excludedFields"], json!(["kunden.email", "kunden.iban"]));
    let policy = kalzit::ai::redact::policy(&t.state, &ds).await.unwrap();
    let schema = kalzit::datasources::SourceSchema::Metrics { metrics: vec!["up".into()], labels: vec![] };
    assert_eq!(kalzit::ai::redact::schema_for_model(&policy, &schema), None, "closed: only the query text");
    let changes: Vec<String> =
        t.audit().await.into_iter().filter(|(a, _)| a == "datasource.ai_access_changed").map(|(_, s)| s).collect();
    assert_eq!(changes.len(), 2);
    assert!(changes.iter().all(|s| !s.contains("iban")), "field names are not logged: {changes:?}");
    t.finish().await;
}

/// The `ai.called` summaries, oldest first.
async fn calls(t: &TestApp) -> Vec<Value> {
    t.audit()
        .await
        .into_iter()
        .filter(|(a, _)| a == "ai.called")
        .map(|(_, s)| serde_json::from_str(&s).unwrap())
        .collect()
}

impl TestApp {
    /// Patches a setting without asserting success, for refusals.
    async fn try_setting(&self, path: &str, list: &str, key: &str, value: Value, admin: &Session) -> Reply {
        let version = self.get(list, admin).await.body["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["key"] == key)
            .map(|s| s["version"].as_i64().unwrap())
            .unwrap();
        self.patch(&format!("{path}/{key}"), json!({ "value": value, "version": version }), admin).await
    }
}

#[tokio::test]
async fn ai_turns_on_only_with_a_tested_provider_and_a_changed_one_needs_a_new_test() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let viewer = t.member(&owner, &org, "vera@example.de", "viewer").await;
    let (admin_path, admin_list) = ("/api/admin/settings", "/api/admin/settings");
    let r = t.try_setting(admin_path, admin_list, "ai.enabled", json!(true), &owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "ai.enable_needs_tested_provider"), "no provider");
    let mock = openai(Mode::Ok).await;
    let r = t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), None), &owner).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let r = t.try_setting(admin_path, admin_list, "ai.enabled", json!(true), &owner).await;
    assert_eq!(r.reason(), "ai.enable_needs_tested_provider", "not tested yet");
    let batch = json!({ "changes": [{ "key": "ai.enabled", "value": true, "version": 0 }] });
    assert_eq!(t.post("/api/admin/settings/batch", batch, &owner).await.reason(), "ai.enable_needs_tested_provider");

    let r = t.post(&format!("/api/admin/ai/providers/{id}/test"), json!({}), &owner).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);
    let r = t.try_setting(admin_path, admin_list, "ai.enabled", json!(true), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.ack(&org, &viewer).await;

    // A new name keeps the pass; a new model drops it; a new address also asks for the notice again.
    let p = t.get("/api/admin/ai/providers", &owner).await.body["items"][0].clone();
    let path = format!("/api/admin/ai/providers/{id}");
    let r = t.patch(&path, json!({ "name": "Umbenannt", "expectedUpdatedAt": p["updatedAt"] }), &owner).await;
    assert_eq!(r.body["lastTest"]["ok"], true, "{}", r.body);
    let r = t.patch(&path, json!({ "model": "modell-2", "expectedUpdatedAt": r.body["updatedAt"] }), &owner).await;
    assert!(r.body.get("lastTest").is_none(), "{}", r.body);
    let status = format!("/api/orgs/{org}/ai/status");
    assert_eq!(t.get(&status, &viewer).await.body["noticeAcknowledged"], true);
    let other = openai(Mode::Ok).await;
    let r =
        t.patch(&path, json!({ "baseUrl": other.url("/v1"), "expectedUpdatedAt": r.body["updatedAt"] }), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.get(&status, &viewer).await.body["noticeAcknowledged"], false);

    // Turning an organization's AI back on needs a tested provider in effect as well.
    t.org_setting(&org, "ai.org_enabled", json!(false), &owner).await;
    let (org_path, org_list) = (format!("/api/orgs/{org}/settings"), format!("/api/orgs/{org}/settings"));
    let r = t.try_setting(&org_path, &org_list, "ai.org_enabled", json!(true), &owner).await;
    assert_eq!(r.reason(), "ai.enable_needs_tested_provider", "{}", r.body);
    t.post(&format!("{path}/test"), json!({}), &owner).await;
    t.org_setting(&org, "ai.org_enabled", json!(true), &owner).await;
    t.finish().await;
}

#[tokio::test]
async fn kalzit_itself_is_refused_at_connect_time_in_every_form() {
    let t = test_app().await;
    let (owner, _org) = t.setup().await;
    let create = |url: String| provider_body("openai", url, None);
    // Saving refuses the forms it can see.
    let r = t.post("/api/admin/ai/providers", create("http://[::ffff:127.0.0.1]:3999/v1".into()), &owner).await;
    assert_eq!(r.reason(), "ai.base_url_kalzit", "{}", r.body);
    // A host name passes the save but not the connection: it resolves to this computer.
    let r = t.post("/api/admin/ai/providers", create("http://localhost.:3999/v1".into()), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap();
    let r = t.post(&format!("/api/admin/ai/providers/{id}/test"), json!({}), &owner).await;
    assert_eq!(
        (r.body["ok"].as_bool(), r.body["reason"].as_str()),
        (Some(false), Some("ai.base_url_kalzit")),
        "{}",
        r.body
    );
    // Another port of this computer is a local model server, which is fine.
    let mock = openai(Mode::Ok).await;
    let r = t.post("/api/admin/ai/providers", create(mock.url("/v1").replace("127.0.0.1", "localhost.")), &owner).await;
    let id = r.body["id"].as_str().unwrap();
    assert_eq!(t.post(&format!("/api/admin/ai/providers/{id}/test"), json!({}), &owner).await.body["ok"], true);
    t.finish().await;
}

#[tokio::test]
async fn a_dropped_call_is_still_counted_and_audited() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let slow_openai = openai(Mode::Hang).await;
    t.post("/api/admin/ai/providers", provider_body("openai", slow_openai.url("/v1"), None), &owner).await;
    t.enable(&owner).await;
    t.ack(&org, &owner).await;
    let caller = t.caller(&org, &owner);

    // No usage from the provider: estimated from the request and what arrived.
    let mut events = Box::pin(service::stream(&t.state, &caller, &hello(), &CancellationToken::new()).await.unwrap());
    assert_eq!(events.next().await.unwrap().unwrap(), ChatEvent::Text("Hallo".into()));
    drop(events);
    wait_idle(&t.state).await;
    // A whole call whose caller went away (a dropped request).
    let gone = tokio::time::timeout(
        Duration::from_millis(300),
        service::complete(&t.state, &caller, &hello(), &CancellationToken::new()),
    )
    .await;
    assert!(gone.is_err());
    wait_idle(&t.state).await;
    let audited = calls(&t).await;
    assert_eq!(audited.len(), 2, "{audited:?}");
    for call in &audited {
        assert_eq!(call["outcome"], "cancelled");
        assert_eq!(call["estimated"], true);
        assert_eq!(call["inputTokens"], 8, "30 characters of prompt");
    }
    assert_eq!(audited[0]["outputTokens"], 2, "5 characters arrived");
    let (user, _) = service::today(&t.state, &org, &owner.user_id).await.unwrap();
    assert_eq!(user.reserved, 0, "every reservation was settled");
    assert_eq!(user.requests, 2);

    // Anthropic tells the input tokens at once; a call cut short keeps them.
    let slow_anthropic = anthropic(Mode::Hang).await;
    let body = provider_body("anthropic", slow_anthropic.url(""), Some(KEY));
    let r = t.post(&format!("/api/orgs/{org}/ai/providers"), body, &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    t.ack(&org, &owner).await;
    let mut events = Box::pin(service::stream(&t.state, &caller, &hello(), &CancellationToken::new()).await.unwrap());
    let first = events.next().await.unwrap().unwrap();
    assert_eq!(first, ChatEvent::Usage(Usage { input_tokens: 9, output_tokens: 1 }));
    drop(events);
    wait_idle(&t.state).await;
    let last = calls(&t).await.pop().unwrap();
    assert_eq!((last["inputTokens"].as_u64(), last["outputTokens"].as_u64()), (Some(9), Some(1)));
    assert!(last.get("estimated").is_none());
    t.finish().await;
}

#[tokio::test]
async fn calls_starting_together_cannot_overshoot_a_token_limit() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let mock = openai(Mode::Delay).await;
    t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), None), &owner).await;
    t.enable(&owner).await;
    t.setting("ai.user_tokens_per_day", json!(100), &owner).await;
    t.setting("ai.max_concurrent_per_user", json!(10), &owner).await;
    t.ack(&org, &owner).await;
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let (state, caller) = (t.state.clone(), t.caller(&org, &owner));
        tasks.push(tokio::spawn(async move {
            let cancel = CancellationToken::new();
            service::complete(&state, &caller, &hello(), &cancel).await.map_err(|e| e.reason.map(|r| r.code))
        }));
    }
    let mut ok = 0;
    for task in tasks {
        match task.await.unwrap() {
            Ok(_) => ok += 1,
            Err(reason) => assert_eq!(reason.as_deref(), Some("ai.limit_user_tokens")),
        }
    }
    assert_eq!(ok, 1, "the first call's budget is reserved while it runs");
    assert_eq!(mock.requests(), 1);
    let (user, _) = service::today(&t.state, &org, &owner.user_id).await.unwrap();
    assert_eq!((user.tokens, user.reserved), (13, 0), "the reservation became the real use");
    // Under the limit again: the next call may start.
    service::complete(&t.state, &t.caller(&org, &owner), &hello(), &CancellationToken::new()).await.unwrap();
    t.finish().await;
}

#[tokio::test]
async fn compatible_servers_get_their_token_field_and_a_retry_without_stream_options() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let mock = openai(Mode::RejectStreamOptions).await;
    let r = t.post("/api/admin/ai/providers", provider_body("openai", mock.url("/v1"), None), &owner).await;
    assert_eq!(r.body["tokenLimitField"], "auto");
    let id = r.body["id"].as_str().unwrap().to_string();
    let path = format!("/api/admin/ai/providers/{id}");
    let r = t.post(&format!("{path}/test"), json!({}), &owner).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);
    assert_eq!(mock.requests(), 2, "once with stream_options, once without");
    let (_, body) = mock.last();
    assert!(body.get("stream_options").is_none());
    assert_eq!((body["max_tokens"].as_u64(), body.get("max_completion_tokens")), (Some(512), None));

    let updated_at = t.get("/api/admin/ai/providers", &owner).await.body["items"][0]["updatedAt"].clone();
    let change = json!({ "tokenLimitField": "max_completion_tokens", "expectedUpdatedAt": updated_at });
    let r = t.patch(&path, change, &owner).await;
    assert_eq!(r.body["tokenLimitField"], "max_completion_tokens", "{}", r.body);
    t.post(&format!("{path}/test"), json!({}), &owner).await;
    let (_, body) = mock.last();
    assert_eq!((body["max_completion_tokens"].as_u64(), body.get("max_tokens")), (Some(512), None));
    let bad = json!({ "tokenLimitField": "tokens", "expectedUpdatedAt": r.body["updatedAt"] });
    assert_eq!(t.patch(&path, bad, &owner).await.reason(), "ai.token_limit_field_unknown");

    // Calls go through the same retry without stream_options.
    t.enable(&owner).await;
    t.ack(&org, &owner).await;
    service::complete(&t.state, &t.caller(&org, &owner), &hello(), &CancellationToken::new()).await.unwrap();
    assert_eq!(calls(&t).await.pop().unwrap()["outcome"], "ok");
    t.finish().await;
}

#[tokio::test]
async fn org_providers_are_not_changed_tested_or_used_while_disallowed() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let mock = openai(Mode::Ok).await;
    let body = provider_body("openai", mock.url("/v1"), None);
    let r = t.post(&format!("/api/orgs/{org}/ai/providers"), body, &owner).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let updated_at = r.body["updatedAt"].clone();
    t.setting("ai.allow_org_providers", json!(false), &owner).await;
    let path = format!("/api/orgs/{org}/ai/providers/{id}");
    let r = t.patch(&path, json!({ "name": "x", "expectedUpdatedAt": updated_at }), &owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "ai.org_providers_not_allowed"));
    let r = t.post(&format!("{path}/test"), json!({}), &owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "ai.org_providers_not_allowed"));
    assert!(service::in_effect(&t.state, &org).await.unwrap().is_none(), "not used either");
    let r = t.send(Method::DELETE, &path, None, Some(&owner)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "removing stays possible");
    t.finish().await;
}
