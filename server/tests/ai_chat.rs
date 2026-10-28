//! The agent chat "Fragen" through the real router, against an in-process mock of both provider
//! APIs (OpenAI chat completions and the Anthropic Messages API) that answers with scripted tool
//! calls and text, and a SQLite source whose queries really run: every tool authorized per call
//! with the asker's rights, the opt-in and the excluded fields of a source, the chosen sources,
//! the tool limit, chats that belong to one person, and the retention.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use kalzit::dashboards::model::SCHEMA_VERSION;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const T0: i64 = 1_800_000_000_000;
const DAY: i64 = 24 * 3600 * 1000;

struct TestApp {
    app: Router,
    state: AppState,
    clock: Arc<ManualClock>,
    dir: Arc<tempfile::TempDir>,
    sources: tempfile::TempDir,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    fn events(&self) -> Vec<(String, Value)> {
        self.text
            .replace("\r\n", "\n")
            .split("\n\n")
            .filter_map(|block| {
                let mut name = None;
                let mut data = None;
                for line in block.lines() {
                    if let Some(n) = line.strip_prefix("event: ") {
                        name = Some(n.to_string());
                    } else if let Some(d) = line.strip_prefix("data: ") {
                        data = serde_json::from_str(d).ok();
                    }
                }
                Some((name?, data?))
            })
            .collect()
    }

    fn all(&self, name: &str) -> Vec<Value> {
        self.events().into_iter().filter(|(n, _)| n == name).map(|(_, d)| d).collect()
    }

    fn event(&self, name: &str) -> Value {
        self.all(name).into_iter().next().unwrap_or(Value::Null)
    }

    /// The records of the finished tool calls, in order.
    fn records(&self) -> Vec<Value> {
        self.all("toolResult").into_iter().map(|d| d["record"].clone()).collect()
    }
}

#[derive(Clone)]
struct Session {
    cookie: String,
}

async fn test_app() -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3997".into();
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(T0));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp {
        app: router(state.clone()).layer(MockConnectInfo(peer)),
        state,
        clock,
        dir: Arc::new(dir),
        sources: tempfile::tempdir().unwrap(),
    }
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
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(cookie) = headers.get(header::SET_COOKIE) {
            let cookie = cookie.to_str().unwrap().split(';').next().unwrap().to_string();
            return Reply { status, body: json!({ "cookie": cookie, "body": body }), text };
        }
        Reply { status, body, text }
    }

    async fn get(&self, path: &str, who: &Session) -> Reply {
        self.send(Method::GET, path, None, Some(who)).await
    }

    async fn post(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::POST, path, Some(body), Some(who)).await
    }

    async fn delete(&self, path: &str, who: &Session) -> Reply {
        self.send(Method::DELETE, path, None, Some(who)).await
    }

    async fn sign_in(&self, r: Reply) -> Session {
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        Session { cookie: r.body["cookie"].as_str().unwrap().into() }
    }

    async fn setup(&self) -> (Session, String) {
        let r = self
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Vertrieb GmbH", "name": "Jörg Müller",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        let org = r.body["body"]["orgs"][0]["id"].as_str().unwrap().to_string();
        (self.sign_in(r).await, org)
    }

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
            .send(
                Method::PATCH,
                &format!("/api/admin/settings/{key}"),
                Some(json!({ "value": value, "version": version })),
                Some(admin),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
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
            .send(
                Method::PATCH,
                &format!("/api/orgs/{org}/settings/{key}"),
                Some(json!({ "value": value, "version": version })),
                Some(admin),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
    }

    /// A server provider of `kind` at `mock`, marked as tested, and AI turned on.
    async fn enable(&self, owner: &Session, mock: &Mock, kind: &str) {
        let body = match kind {
            "anthropic" => json!({ "name": "Wolke", "kind": "anthropic", "baseUrl": mock.url(""),
                                   "model": "modell-a", "apiKey": "sk-ant-test-0123456789" }),
            _ => json!({ "name": "Lokal", "kind": "openai", "baseUrl": mock.url("/v1"), "model": "modell-1" }),
        };
        let r = self.post("/api/admin/ai/providers", body, owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        sqlx::query("UPDATE ai_providers SET last_test_ok = 1, last_tested_at = 0")
            .execute(&self.state.db)
            .await
            .unwrap();
        self.setting("ai.enabled", json!(true), owner).await;
    }

    async fn ack(&self, org: &str, who: &Session) {
        let status = self.get(&format!("/api/orgs/{org}/ai/status"), who).await;
        let id = status.body["provider"]["id"].as_str().expect("a provider in effect").to_string();
        let r = self.post(&format!("/api/orgs/{org}/ai/notice"), json!({ "providerId": id }), who).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    }

    /// A SQLite source `name` with `kunden (name, email, umsatz)` and three rows.
    async fn source(&self, owner: &Session, org: &str, name: &str) -> String {
        let dir = self.sources.path();
        self.setting("datasources.sqlite_dirs", json!([dir.to_string_lossy()]), owner).await;
        let path = dir.join(format!("{name}.db"));
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE kunden (name TEXT, email TEXT, umsatz REAL); \
             INSERT INTO kunden VALUES ('Ana', 'ana@geheim.example', 10), ('Bo', 'bo@geheim.example', 20), \
             ('Cem', 'cem@geheim.example', 30);",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let body = json!({ "name": name, "kind": "sqlite", "settings": { "path": path.to_string_lossy() } });
        let r = self.post(&format!("/api/orgs/{org}/datasources"), body, owner).await;
        assert!(r.status.is_success(), "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn access(&self, org: &str, ds: &str, readable: bool, excluded: &[&str], owner: &Session) {
        let r = self
            .send(
                Method::PUT,
                &format!("/api/orgs/{org}/datasources/{ds}/ai-access"),
                Some(json!({ "readable": readable, "excludedFields": excluded })),
                Some(owner),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    async fn new_chat(&self, org: &str, who: &Session, sources: &[&str]) -> String {
        let r = self.post(&format!("/api/orgs/{org}/ai/chats"), json!({ "datasourceIds": sources }), who).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn ask(&self, org: &str, chat: &str, text: &str, who: &Session) -> Reply {
        self.post(&format!("/api/orgs/{org}/ai/chats/{chat}/messages"), json!({ "text": text, "language": "de" }), who)
            .await
    }

    /// The audit summaries of `action`, oldest first.
    async fn audited(&self, action: &str) -> Vec<Value> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT action, summary FROM audit_events ORDER BY created_at, id")
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter().filter(|(a, _)| a == action).map(|(_, s)| serde_json::from_str(&s).unwrap()).collect()
    }
}

/// One scripted answer of the mock: text, or tool calls (name and arguments).
#[derive(Clone)]
enum Answer {
    Text(String),
    Tools(Vec<(String, Value)>),
}

fn text(s: &str) -> Answer {
    Answer::Text(s.into())
}

fn tool(name: &str, args: Value) -> Answer {
    Answer::Tools(vec![(name.into(), args)])
}

/// A mock of both APIs: each request takes the next scripted answer (text "Fertig." when the
/// script is empty) and is kept.
struct Mock {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Value>>>,
    script: Arc<Mutex<VecDeque<Answer>>>,
}

impl Mock {
    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    fn requests(&self) -> Vec<Value> {
        self.seen.lock().unwrap().clone()
    }

    fn script(&self, answers: Vec<Answer>) {
        *self.script.lock().unwrap() = answers.into();
    }
}

fn openai_stream(answer: &Answer, n: usize) -> String {
    let chunk = match answer {
        Answer::Text(t) => json!({ "choices": [{ "delta": { "content": t }, "finish_reason": "stop" }] }),
        Answer::Tools(calls) => {
            let calls: Vec<Value> = calls
                .iter()
                .enumerate()
                .map(|(i, (name, args))| {
                    json!({ "index": i, "id": format!("call_{n}_{i}"),
                            "function": { "name": name, "arguments": args.to_string() } })
                })
                .collect();
            json!({ "choices": [{ "delta": { "tool_calls": calls }, "finish_reason": "tool_calls" }] })
        }
    };
    format!(
        "data: {chunk}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":40,\"completion_tokens\":8}}}}\n\ndata: [DONE]\n\n"
    )
}

fn anthropic_stream(answer: &Answer, n: usize) -> String {
    let mut events = vec![(
        "message_start",
        json!({ "type": "message_start", "message": { "usage": { "input_tokens": 50, "output_tokens": 1 } } }),
    )];
    let stop = match answer {
        Answer::Text(t) => {
            events.push((
                "content_block_start",
                json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            ));
            events.push((
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": t } }),
            ));
            events.push(("content_block_stop", json!({ "type": "content_block_stop", "index": 0 })));
            "end_turn"
        }
        Answer::Tools(calls) => {
            for (i, (name, args)) in calls.iter().enumerate() {
                events.push((
                    "content_block_start",
                    json!({ "type": "content_block_start", "index": i,
                            "content_block": { "type": "tool_use", "id": format!("toolu_{n}_{i}"), "name": name, "input": {} } }),
                ));
                events.push((
                    "content_block_delta",
                    json!({ "type": "content_block_delta", "index": i,
                            "delta": { "type": "input_json_delta", "partial_json": args.to_string() } }),
                ));
                events.push(("content_block_stop", json!({ "type": "content_block_stop", "index": i })));
            }
            "tool_use"
        }
    };
    events.push((
        "message_delta",
        json!({ "type": "message_delta", "delta": { "stop_reason": stop }, "usage": { "output_tokens": 9 } }),
    ));
    events.push(("message_stop", json!({ "type": "message_stop" })));
    events.into_iter().map(|(name, data)| format!("event: {name}\ndata: {data}\n\n")).collect()
}

#[expect(clippy::disallowed_methods, reason = "a mock AI provider, not an API route")]
async fn mock() -> Mock {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let script = Arc::new(Mutex::new(VecDeque::new()));
    let respond = |anthropic: bool, seen: Arc<Mutex<Vec<Value>>>, script: Arc<Mutex<VecDeque<Answer>>>| {
        move |body: Bytes| {
            let (seen, script) = (seen.clone(), script.clone());
            async move {
                let n = {
                    let mut seen = seen.lock().unwrap();
                    seen.push(serde_json::from_slice(&body).unwrap_or(Value::Null));
                    seen.len()
                };
                let answer = script.lock().unwrap().pop_front().unwrap_or_else(|| text("Fertig."));
                let stream = if anthropic { anthropic_stream(&answer, n) } else { openai_stream(&answer, n) };
                Response::builder().header(header::CONTENT_TYPE, "text/event-stream").body(Body::from(stream)).unwrap()
            }
        }
    };
    let app = Router::new()
        .route("/v1/chat/completions", axum::routing::post(respond(false, seen.clone(), script.clone())))
        .route("/v1/messages", axum::routing::post(respond(true, seen.clone(), script.clone())));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Mock { addr, seen, script }
}

/// The text of every tool result in a provider request, in either API's form.
fn tool_results(request: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for message in request["messages"].as_array().into_iter().flatten() {
        if message["role"] == "tool" {
            out.push(message["content"].as_str().unwrap_or("").to_string());
        }
        for block in message["content"].as_array().into_iter().flatten() {
            if block["type"] == "tool_result" {
                out.push(block["content"].as_str().unwrap_or("").to_string());
            }
        }
    }
    out
}

async fn answers_with_tools(kind: &str) {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let editor = t.member(&owner, &org, "ede@example.de", "editor").await;
    let ds = t.source(&owner, &org, "Kunden").await;
    let mock = mock().await;
    t.enable(&owner, &mock, kind).await;
    t.access(&org, &ds, true, &["kunden.email"], &owner).await;

    // The notice comes first; nothing is stored or sent before it.
    let r = t.post(&format!("/api/orgs/{org}/ai/chats"), json!({}), &editor).await;
    assert_eq!(r.reason(), "ai.notice_required", "{}", r.body);
    t.ack(&org, &editor).await;
    let chat = t.new_chat(&org, &editor, &[&ds]).await;

    mock.script(vec![
        tool("list_datasources", json!({})),
        tool("get_schema", json!({ "datasourceId": ds })),
        tool(
            "run_query",
            json!({ "datasourceId": ds, "query": { "sql": "SELECT * FROM kunden ORDER BY name" },
                    "timeRange": { "from": "now-7d", "to": "now" } }),
        ),
        text("Drei Kunden, zusammen 60."),
    ]);
    let r = t.ask(&org, &chat, "Wie viel Umsatz haben die Kunden?", &editor).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.event("meta")["chatId"], chat);
    assert_eq!(r.all("tool").len(), 3, "{}", r.text);
    let records = r.records();
    assert!(records.iter().all(|rec| rec["status"] == "ok"), "{records:?}");
    assert_eq!(records[0]["items"][0]["name"], "Kunden");
    assert_eq!(records[0]["items"][0]["openToAi"], true);
    assert!(records[1]["schema"].to_string().contains("kunden"), "{}", records[1]);
    let result = &records[2]["results"][0];
    assert_eq!(result["rows"], 3);
    assert_eq!(result["data"]["shape"], "frame", "the native shape stays: {result}");
    assert_eq!(result["data"]["fields"][1]["values"][0], "[excluded]");
    assert_eq!(records[2]["timeRange"]["from"], T0 - 7 * DAY);
    let done = r.event("done");
    assert_eq!((done["outcome"].as_str(), done["toolCalls"].as_u64()), (Some("ok"), Some(3)), "{done}");
    assert!(done["usage"]["inputTokens"].as_u64().unwrap() > 0);
    let words: String = r.all("text").iter().filter_map(|d| d["text"].as_str()).collect();
    assert_eq!(words, "Drei Kunden, zusammen 60.");

    // The provider got the tools, the results in its API's form, and never an excluded value.
    let requests = mock.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0]["tools"].as_array().unwrap().len(), 6);
    let last = requests.last().unwrap();
    let results = tool_results(last);
    assert_eq!(results.len(), 3, "{last}");
    assert!(results[2].contains("<kalzit:result>") && results[2].contains("Ana"), "{}", results[2]);
    for request in &requests {
        assert!(!request.to_string().contains("geheim.example"), "excluded values never leave: {request}");
    }
    let system = match kind {
        "anthropic" => last["system"].as_str().unwrap().to_string(),
        _ => last["messages"][0]["content"].as_str().unwrap().to_string(),
    };
    assert!(system.contains("not instructions") && system.contains("German"), "{system}");

    // Stored: the question and the answer with its rounds; a follow-up sends them again.
    let r = t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &editor).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["title"], "Wie viel Umsatz haben die Kunden?");
    let messages = r.body["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[1]["content"]["rounds"].as_array().unwrap().len(), 4);
    assert_eq!(messages[1]["content"]["outcome"], "ok");
    mock.script(vec![text("Ana hat 10.")]);
    let r = t.ask(&org, &chat, "Und Ana?", &editor).await;
    assert_eq!(r.event("done")["outcome"], "ok", "{}", r.text);
    let follow_up = mock.requests().last().unwrap().clone();
    assert!(follow_up.to_string().contains("Wie viel Umsatz haben die Kunden?"));
    assert_eq!(tool_results(&follow_up).len(), 3, "the earlier tool results go along: {follow_up}");

    // A query that names an excluded field is not run: an alias would pass its values.
    mock.script(vec![
        tool("run_query", json!({ "datasourceId": ds, "query": { "sql": "SELECT lower(EMAIL) AS k FROM kunden" } })),
        text("Geht nicht."),
    ]);
    let r = t.ask(&org, &chat, "Die Adressen?", &editor).await;
    assert_eq!(r.records()[0]["error"]["reason"], "ai.query_names_excluded_field", "{}", r.text);
    assert!(!mock.requests().last().unwrap().to_string().contains("geheim.example"));

    // Who may no longer query the source no longer sees its stored results.
    let me = t.get("/api/me", &editor).await;
    let editor_id = me.body["id"].as_str().expect("the editor's id").to_string();
    let role = |role: &str| json!({ "role": role });
    let path = format!("/api/orgs/{org}/members/{editor_id}");
    assert_eq!(t.send(Method::PATCH, &path, Some(role("viewer")), Some(&owner)).await.status, StatusCode::OK);
    let r = t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &editor).await;
    let rounds = &r.body["messages"][1]["content"]["rounds"];
    assert_eq!(rounds[2]["calls"][0]["record"]["withheld"], true, "{rounds}");
    assert!(rounds[1]["calls"][0]["record"].get("schema").is_none(), "the schema too: {rounds}");
    assert_eq!(rounds[0]["calls"][0]["record"]["items"], json!([]), "a viewer reads no source: {rounds}");
    assert_eq!(t.send(Method::PATCH, &path, Some(role("editor")), Some(&owner)).await.status, StatusCode::OK);

    // Closing the source withholds its stored results, in the chat and towards the provider.
    t.access(&org, &ds, false, &[], &owner).await;
    let r = t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &editor).await;
    let call = &r.body["messages"][1]["content"]["rounds"][2]["calls"][0]["record"];
    assert_eq!(call["withheld"], true, "{call}");
    assert!(call["results"][0].get("data").is_none());
    mock.script(vec![text("Nicht mehr verfügbar.")]);
    t.ask(&org, &chat, "Nochmal?", &editor).await;
    let resent = mock.requests().last().unwrap().clone();
    let results = tool_results(&resent);
    assert!(results[1].contains("no longer available") && results[2].contains("no longer available"), "{results:?}");
    assert!(!resent.to_string().contains("Cem"), "a closed source's rows are not sent again: {resent}");

    // Audited: each round as a call with the purpose `chat`, each tool call with its query and
    // row count, never result data.
    let calls = t.audited("ai.called").await;
    assert_eq!(calls.len(), 8);
    assert!(calls.iter().all(|c| c["purpose"] == "chat" && c["promptVersion"] == 1));
    let tools = t.audited("ai.tool_called").await;
    let names: Vec<&str> = tools.iter().map(|c| c["tool"].as_str().unwrap()).collect();
    assert_eq!(names, ["list_datasources", "get_schema", "run_query", "run_query"]);
    assert_eq!(tools[2]["rows"], 3);
    assert!(tools[2]["query"].as_str().unwrap().contains("FROM kunden"));
    for entry in calls.iter().chain(&tools) {
        assert!(!entry.to_string().contains("Ana") && !entry.to_string().contains("geheim"), "{entry}");
    }
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_chat_answers_with_tools_through_an_openai_compatible_provider() {
    answers_with_tools("openai").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_chat_answers_with_tools_through_anthropic() {
    answers_with_tools("anthropic").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_tool_is_authorized_with_the_askers_rights() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let editor = t.member(&owner, &org, "ede@example.de", "editor").await;
    let viewer = t.member(&owner, &org, "vera@example.de", "viewer").await;
    let ds = t.source(&owner, &org, "Kunden").await;
    let closed = t.source(&owner, &org, "Intern").await;
    let mock = mock().await;
    t.enable(&owner, &mock, "openai").await;
    t.ack(&org, &editor).await;
    t.ack(&org, &viewer).await;
    t.access(&org, &ds, true, &[], &owner).await;
    let model = json!({
        "schemaVersion": SCHEMA_VERSION,
        "title": "Kundenumsatz",
        "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [
            { "id": "p1", "type": "table", "title": "Umsatz je Kunde",
              "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
              "targets": [
                  { "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT name, umsatz FROM kunden" } },
                  { "refId": "B", "datasourceId": ds, "hide": true, "query": { "sql": "SELECT 'VERSTECKT' AS x" } }
              ] },
            { "id": "p2", "type": "table", "title": "Intern",
              "grid": { "x": 0, "y": 8, "w": 12, "h": 8 },
              "targets": [ { "refId": "A", "datasourceId": closed, "query": { "sql": "SELECT name FROM kunden" } } ] }
        ]
    });
    let r = t.post(&format!("/api/orgs/{org}/dashboards"), json!({ "folderId": null, "model": model }), &owner).await;
    assert!(r.status.is_success(), "{}", r.body);
    let dashboard = r.body["id"].as_str().unwrap().to_string();

    // A viewer has no free queries: no sources, no schema, no query; but the panels they see.
    let chat = t.new_chat(&org, &viewer, &[]).await;
    mock.script(vec![
        tool("list_datasources", json!({})),
        tool("run_query", json!({ "datasourceId": ds, "query": { "sql": "SELECT * FROM kunden" } })),
        tool("get_schema", json!({ "datasourceId": ds })),
        tool("find_panels", json!({ "search": "umsatz" })),
        tool("run_panel", json!({ "dashboardId": dashboard, "panelId": "p1" })),
        tool("run_panel", json!({ "dashboardId": dashboard, "panelId": "p2" })),
        tool("propose_query", json!({ "datasourceId": ds, "query": { "sql": "SELECT 1" }, "title": "x" })),
        text("Fertig."),
    ]);
    let r = t.ask(&org, &chat, "Was gibt es?", &viewer).await;
    let records = r.records();
    assert_eq!(records.len(), 7, "{}", r.text);
    assert_eq!(records[0]["items"], json!([]), "a viewer reads no source");
    for i in [1, 2, 6] {
        assert_eq!(records[i]["status"], "error", "{}", records[i]);
        assert!(matches!(records[i]["error"]["code"].as_str(), Some("forbidden" | "not_found")), "{}", records[i]);
    }
    assert_eq!(records[3]["items"][0]["title"], "Kundenumsatz");
    assert_eq!(records[3]["items"][0]["panels"][0]["panelId"], "p1");
    let panel = &records[4];
    assert_eq!(panel["status"], "ok", "{panel}");
    assert_eq!(panel["results"].as_array().unwrap().len(), 1, "the hidden query is not run: {panel}");
    assert_eq!(panel["results"][0]["rows"], 3);
    assert_eq!(records[5]["error"]["reason"], "ai.datasource_not_readable");
    assert!(records[5]["error"].get("params").is_none(), "a viewer is not told which source: {}", records[5]);

    // An editor: a closed source refuses schema and queries; writing queries are refused by the
    // query path; a proposal is never run.
    let chat = t.new_chat(&org, &editor, &[]).await;
    mock.script(vec![
        tool("get_schema", json!({ "datasourceId": closed })),
        tool("run_query", json!({ "datasourceId": closed, "query": { "sql": "SELECT * FROM kunden" } })),
        tool("run_query", json!({ "datasourceId": ds, "query": { "sql": "DELETE FROM kunden" } })),
        tool(
            "propose_query",
            json!({ "datasourceId": ds, "query": { "sql": "DELETE FROM kunden" },
                                      "title": "Aufräumen", "explanation": "Löscht alles." }),
        ),
        tool("no_such_tool", json!({})),
        tool("run_query", json!({ "datasourceId": ds })),
        text("Fertig."),
    ]);
    let r = t.ask(&org, &chat, "Zeig alles", &editor).await;
    let records = r.records();
    assert_eq!(records[0]["error"]["reason"], "ai.datasource_not_readable");
    assert_eq!(records[1]["error"]["reason"], "ai.datasource_not_readable");
    assert_eq!(records[2]["status"], "error");
    assert_eq!(records[2]["results"][0]["error"]["code"], "query_rejected", "{}", records[2]);
    assert_eq!(records[3]["status"], "ok");
    assert_eq!(records[3]["proposal"]["title"], "Aufräumen");
    assert!(records[3].get("results").is_none(), "a proposal is not run");
    assert_eq!(records[4]["error"]["reason"], "ai.chat_tool_unknown");
    assert_eq!(records[5]["error"]["reason"], "ai.chat_tool_arguments");
    let r = t.post(&format!("/api/orgs/{org}/query"), json!({
        "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT count(*) AS n FROM kunden" } }],
        "timeRange": { "from": T0 - DAY, "to": T0 }, "variables": {}
    }), &editor).await;
    let n = &r.body["results"]["A"]["result"]["frame"]["fields"][0]["values"][0];
    assert!(*n == json!(3) || *n == json!("3"), "the rows are still there: {}", r.body);

    // Chosen sources narrow every tool.
    t.access(&org, &closed, true, &[], &owner).await;
    let chat = t.new_chat(&org, &editor, &[&closed]).await;
    mock.script(vec![
        tool("list_datasources", json!({})),
        tool("run_query", json!({ "datasourceId": ds, "query": { "sql": "SELECT 1" } })),
        text("Fertig."),
    ]);
    let r = t.ask(&org, &chat, "Nur Intern", &editor).await;
    let records = r.records();
    assert_eq!(records[0]["items"].as_array().unwrap().len(), 1);
    assert_eq!(records[0]["items"][0]["name"], "Intern");
    assert_eq!(records[1]["error"]["reason"], "ai.chat_source_not_selected");

    // The tool limit: calls past it are refused, and the next round ends the answer.
    t.setting("ai.max_tool_calls", json!(1), &owner).await;
    mock.script(vec![
        Answer::Tools(vec![("list_datasources".into(), json!({})), ("list_datasources".into(), json!({}))]),
        tool("list_datasources", json!({})),
    ]);
    let r = t.ask(&org, &chat, "Viele Werkzeuge", &editor).await;
    assert_eq!(r.all("tool").len(), 1, "{}", r.text);
    let done = r.event("done");
    assert_eq!((done["outcome"].as_str(), done["toolCalls"].as_u64()), (Some("toolLimit"), Some(1)), "{done}");
    let stored = t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &editor).await;
    let last = stored.body["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["content"]["rounds"][0]["calls"][1]["record"]["error"]["reason"], "ai.chat_tool_limit");

    // Chats are their owner's alone.
    for r in [
        t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &viewer).await,
        t.ask(&org, &chat, "Fremd", &viewer).await,
        t.delete(&format!("/api/orgs/{org}/ai/chats/{chat}"), &viewer).await,
    ] {
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.text);
    }
    let r = t.get(&format!("/api/orgs/{org}/ai/chats"), &viewer).await;
    assert_eq!(r.body["items"].as_array().unwrap().len(), 1, "only the viewer's own chat: {}", r.body);
    // A source the caller may not read cannot be chosen.
    let r = t.post(&format!("/api/orgs/{org}/ai/chats"), json!({ "datasourceIds": [ds] }), &viewer).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    // A chosen source deleted since drops out of the chat's sources, so the chat stays usable.
    let r = t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &editor).await;
    assert_eq!(r.body["datasourceIds"], json!([closed]), "{}", r.body);
    let r = t.delete(&format!("/api/orgs/{org}/datasources/{closed}"), &owner).await;
    assert!(r.status.is_success(), "{}", r.body);
    let r = t.get(&format!("/api/orgs/{org}/ai/chats/{chat}"), &editor).await;
    assert_eq!(r.body["datasourceIds"], json!([]), "{}", r.body);

    // Removing a member from the organization deletes their chats there.
    let viewer_id = t.get("/api/me", &viewer).await.body["id"].as_str().unwrap().to_string();
    let r = t.delete(&format!("/api/orgs/{org}/members/{viewer_id}"), &owner).await;
    assert!(r.status.is_success(), "{}", r.body);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ai_chats WHERE user_id = $1")
        .bind(&viewer_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chats_are_deleted_after_their_retention_or_by_their_owner() {
    let t = test_app().await;
    let (owner, org) = t.setup().await;
    let editor = t.member(&owner, &org, "ede@example.de", "editor").await;
    let mock = mock().await;
    t.enable(&owner, &mock, "openai").await;
    t.ack(&org, &editor).await;
    t.ack(&org, &owner).await;

    let old = t.new_chat(&org, &editor, &[]).await;
    t.ask(&org, &old, "Alte Frage", &editor).await;
    let recent = t.new_chat(&org, &editor, &[]).await;
    t.ask(&org, &recent, "Neue Frage", &editor).await;
    let mine = t.new_chat(&org, &owner, &[]).await;
    t.ask(&org, &mine, "Frage der Inhaberin", &owner).await;
    // The old chat was last used ten days ago.
    sqlx::query("UPDATE ai_chats SET updated_at = $1 WHERE id = $2")
        .bind(T0 - 10 * DAY)
        .bind(&old)
        .execute(&t.state.db)
        .await
        .unwrap();

    let r = t.get(&format!("/api/orgs/{org}/ai/chats"), &editor).await;
    assert_eq!(r.body["retentionDays"], 30);
    let items = r.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["title"], "Neue Frage", "last used first");
    assert_eq!(items[1]["expiresAt"], T0 + 20 * DAY);
    let r = t.get(&format!("/api/orgs/{org}/ai/chats?q=ALTE"), &editor).await;
    assert_eq!(r.body["items"].as_array().unwrap().len(), 1, "{}", r.body);

    // The server's 30 days keep both; the organization's 7 days remove the old one.
    assert_eq!(kalzit::ai::chats::purge_expired(&t.state).await.unwrap(), 0);
    t.org_setting(&org, "ai.chat_retention_days", json!(7), &owner).await;
    assert_eq!(kalzit::ai::chats::purge_expired(&t.state).await.unwrap(), 1);
    let r = t.get(&format!("/api/orgs/{org}/ai/chats/{old}"), &editor).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM ai_chat_messages WHERE chat_id = $1")
        .bind(&old)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0, "the messages go with the chat");
    let r = t.get(&format!("/api/orgs/{org}/ai/chats"), &editor).await;
    assert_eq!(r.body["retentionDays"], 7);
    assert_eq!(r.body["items"][0]["expiresAt"], T0 + 7 * DAY);

    // Owners delete one chat or all of theirs; another person's stay.
    let r = t.delete(&format!("/api/orgs/{org}/ai/chats/{recent}"), &editor).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    t.new_chat(&org, &editor, &[]).await;
    let r = t.delete(&format!("/api/orgs/{org}/ai/chats"), &editor).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("/api/orgs/{org}/ai/chats"), &editor).await.body["items"], json!([]));
    assert_eq!(t.get(&format!("/api/orgs/{org}/ai/chats"), &owner).await.body["items"].as_array().unwrap().len(), 1);

    // A retention of 0 keeps none.
    t.setting("ai.chat_retention_days", json!(0), &owner).await;
    t.clock.advance_ms(1);
    assert_eq!(kalzit::ai::chats::purge_expired(&t.state).await.unwrap(), 1);
    t.finish().await;
}
