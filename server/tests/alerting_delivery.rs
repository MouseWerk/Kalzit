//! Alerting's scheduler, outbox and channels through the real router and a real SQLite source
//! (on PostgreSQL too when `KALZIT_TEST_POSTGRES_URL` is set): rules are evaluated with a manual
//! clock, webhooks go to a local receiver and are checked against their signature, and a fake
//! transport stands in where attempts must fail or a crash is simulated.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use kalzit::alerting::outbox::{self, Attempt, Channels, Outgoing, Transport};
use kalzit::alerting::scheduler;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const MINUTE: i64 = 60_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    sources: tempfile::TempDir,
    org: String,
    owner: String,
    schema: Option<common::PgSchema>,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

#[derive(Clone)]
enum Who {
    Owner,
    Token(String),
}

impl TestApp {
    async fn new() -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        let schema = common::database().await;
        config.database.url = schema.as_ref().map(|s| s.url.clone());
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = TestApp {
            app,
            clock,
            state,
            dir: Arc::new(dir),
            sources: common::private_tempdir(),
            org: String::new(),
            owner: String::new(),
            schema,
        };
        let r = t
            .raw(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "MouseWerk", "name": "Lea Hoffmann",
                             "email": "lea@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        t
    }

    async fn finish(mut self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone()).with_schema(self.schema.take());
        let sources = std::mem::replace(&mut self.sources, tempfile::tempdir().unwrap());
        drop(self);
        finish.finish().await;
        common::remove_dir(sources);
    }

    async fn raw(&mut self, method: Method, path: &str, body: Option<Value>, who: Option<&Who>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        match who {
            Some(Who::Owner) => req = req.header(header::COOKIE, self.owner.clone()),
            Some(Who::Token(t)) => req = req.header(header::AUTHORIZATION, format!("Bearer {t}")),
            None => {}
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        if let Some(set) = res.headers().get(header::SET_COOKIE) {
            let set = set.to_str().unwrap();
            if set.starts_with("kalzit_session=") && self.owner.is_empty() {
                self.owner = set.split(';').next().unwrap().to_string();
            }
        }
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body }
    }

    async fn call(&mut self, who: &Who, method: Method, rest: &str, body: Option<Value>) -> Reply {
        let path = format!("/api/orgs/{}{rest}", self.org);
        self.raw(method, &path, body, Some(who)).await
    }

    async fn as_role(&mut self, role: &str) -> Who {
        let body = json!({ "name": format!("{role}-1"), "role": role });
        let r = self.call(&Who::Owner, Method::POST, "/service-accounts", Some(body)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let id = r.body["id"].as_str().unwrap().to_string();
        let path = format!("/service-accounts/{id}/tokens");
        let r = self.call(&Who::Owner, Method::POST, &path, Some(json!({ "name": "t" }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        Who::Token(r.body["token"].as_str().unwrap().to_string())
    }

    fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    fn sqlite_path(&self) -> std::path::PathBuf {
        self.sources.path().join("lager.db")
    }

    /// Runs `sql` on the SQLite file behind the source.
    async fn write(&self, sql: &str) {
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&self.sqlite_path())).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).execute(&pool).await.unwrap();
        pool.close().await;
    }

    /// A SQLite source with `m (host TEXT, v REAL)`, opted in to alerting.
    async fn source(&mut self) -> String {
        let dir = self.sources.path().to_string_lossy().to_string();
        let r = self
            .raw(
                Method::PATCH,
                "/api/admin/settings/datasources.sqlite_dirs",
                Some(json!({ "value": [dir], "version": 0 })),
                Some(&Who::Owner),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        self.write("CREATE TABLE m (host TEXT, v REAL); INSERT INTO m VALUES ('a', 2.0);").await;
        let path = self.sqlite_path().to_string_lossy().to_string();
        let body = json!({ "name": "Lager", "kind": "sqlite", "settings": { "path": path } });
        let r = self.call(&Who::Owner, Method::POST, "/datasources", Some(body)).await;
        assert!(r.status.is_success(), "{}", r.body);
        let ds = r.body["id"].as_str().unwrap().to_string();
        let r = self
            .call(&Who::Owner, Method::PUT, &format!("/datasources/{ds}/alerting"), Some(json!({ "enabled": true })))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        ds
    }

    /// A webhook contact point to `url`; answers its id and secret.
    async fn webhook(&mut self, url: &str) -> (String, String) {
        let body = json!({ "name": "Lager-Webhook", "kind": "webhook", "language": "de", "url": url });
        let r = self.call(&Who::Owner, Method::POST, "/alerting/contact-points", Some(body)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        (r.body["id"].as_str().unwrap().to_string(), r.body["secret"].as_str().unwrap().to_string())
    }

    async fn rule(&mut self, ds: &str, contact_point: &str, extra: Value) -> String {
        let mut body = json!({
            "name": "Lager-API Latenz",
            "datasourceId": ds,
            "query": { "query": { "sql": "SELECT host, v FROM m" } },
            "reduce": { "shape": "frame", "function": "last" },
            "condition": { "op": "gt", "value": 1.5 },
            "intervalSecs": 60,
            "forSecs": 0,
            "reminderSecs": 0,
            "noDataState": "ok",
            "labels": { "team": "lager" },
            "contactPointIds": [contact_point],
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        let r = self.call(&Who::Owner, Method::POST, "/alerting/rules", Some(body)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn count(&self, sql: &str) -> i64 {
        let (n,): (i64,) =
            sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string())).fetch_one(&self.state.db).await.unwrap();
        n
    }

    /// One look of the scheduler, a minute later than the last.
    async fn next_minute(&self) -> usize {
        self.clock.advance_ms(MINUTE);
        scheduler::run_due(&self.state).await.unwrap()
    }
}

/// A webhook receiver that records what it gets and answers with `status`.
struct Receiver {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<(HeaderMap, Bytes)>>>,
    status: Arc<AtomicU16>,
}

#[expect(clippy::disallowed_methods, reason = "a webhook receiver, not an API route")]
async fn receiver() -> Receiver {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let status = Arc::new(AtomicU16::new(204));
    let (s, st) = (seen.clone(), status.clone());
    let app = Router::new().route(
        "/hook",
        axum::routing::post(move |headers: HeaderMap, body: Bytes| {
            let (s, st) = (s.clone(), st.clone());
            async move {
                s.lock().unwrap().push((headers, body));
                StatusCode::from_u16(st.load(Ordering::SeqCst)).unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Receiver { addr, seen, status }
}

impl Receiver {
    fn url(&self) -> String {
        format!("http://{}/hook", self.addr)
    }

    fn take(&self) -> Vec<(HeaderMap, Value, Bytes)> {
        self.seen.lock().unwrap().drain(..).map(|(h, b)| (h, serde_json::from_slice(&b).unwrap(), b)).collect()
    }
}

/// A transport that records the messages and fails while `fail` is set.
#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<Value>>,
    fail: AtomicBool,
}

impl Transport for Fake {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            if self.fail.load(Ordering::SeqCst) {
                return Attempt { ok: false, result: "503".into(), sent_to: Vec::new() };
            }
            self.sent.lock().unwrap().push(serde_json::to_value(&out.message).unwrap());
            Attempt { ok: true, result: "ok".into(), sent_to: Vec::new() }
        })
    }
}

impl Fake {
    fn take(&self) -> Vec<Value> {
        self.sent.lock().unwrap().drain(..).collect()
    }
}

/// Checks `Kalzit-Signature` the way a receiver does.
fn verify(headers: &HeaderMap, body: &[u8], secret: &str) {
    let header = headers["kalzit-signature"].to_str().unwrap();
    let t: i64 = header.split(',').next().unwrap().strip_prefix("t=").unwrap().parse().unwrap();
    assert_eq!(kalzit::alerting::webhook::signature(&[secret], t, body), header);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rules_fire_and_resolve_with_signed_webhooks() {
    let mut t = TestApp::new().await;
    let hook = receiver().await;
    let ds = t.source().await;
    let (cp, secret) = t.webhook(&hook.url()).await;
    let rule = t.rule(&ds, &cp, json!({})).await;
    let channels = Channels(t.state.clone());

    // The first look evaluates the rule at its slot; the same slot never runs twice.
    assert_eq!(scheduler::run_due(&t.state).await.unwrap(), 1);
    assert_eq!(scheduler::run_due(&t.state).await.unwrap(), 0);
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(r.body["state"], "firing", "{}", r.body);
    assert_eq!(r.body["instances"][0]["labels"], json!({ "host": "a" }));
    assert_eq!(r.body["instances"][0]["lastValue"], 2.0);
    let tick = r.body["lastEvaluatedAt"].as_i64().unwrap();
    assert!(tick <= t.now() && t.now() - tick < MINUTE);

    // Sent after the commit, signed, with the reduced value only.
    assert_eq!(outbox::deliver_due(&t.state, &channels).await.unwrap(), 1);
    let got = hook.take();
    assert_eq!(got.len(), 1);
    let (headers, body, raw) = &got[0];
    verify(headers, raw, &secret);
    assert_eq!(headers["kalzit-event"], "firing");
    assert_eq!(headers["kalzit-delivery"].to_str().unwrap(), body["deliveryId"].as_str().unwrap());
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert_eq!(body["version"], 1);
    assert_eq!(body["organization"]["name"], "MouseWerk");
    assert_eq!(body["rule"]["labels"], json!({ "team": "lager" }));
    assert_eq!(body["instances"][0]["value"], 2.0);
    assert_eq!(body["instances"][0]["event"], "firing");
    assert_eq!(body["evaluatedAt"], tick);

    // Still firing: nothing new to send.
    assert_eq!(t.next_minute().await, 1);
    assert_eq!(outbox::deliver_due(&t.state, &channels).await.unwrap(), 0);

    // Resolved.
    t.write("UPDATE m SET v = 1.0").await;
    assert_eq!(t.next_minute().await, 1);
    assert_eq!(outbox::deliver_due(&t.state, &channels).await.unwrap(), 1);
    let got = hook.take();
    let (headers, body, raw) = &got[0];
    verify(headers, raw, &secret);
    assert_eq!(headers["kalzit-event"], "resolved");
    assert_eq!(body["instances"][0]["state"], "ok");

    // Every attempt is in the history and at the contact point.
    let r = t.call(&Who::Owner, Method::GET, "/alerting/history?kind=delivery", None).await;
    let events: Vec<&str> = r.body["items"].as_array().unwrap().iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(events, ["resolved", "firing"], "{}", r.body);
    assert!(r.body["items"].as_array().unwrap().iter().all(|e| e["result"] == "ok" && e["attempt"] == 1));
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!(r.body["lastDelivery"]["ok"], true, "{}", r.body);

    // Alerting off for the organization: rules are kept, not evaluated.
    let body = json!({ "value": false, "version": 0 });
    let r = t.call(&Who::Owner, Method::PATCH, "/settings/alerting.org_enabled", Some(body)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.next_minute().await, 0);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crash_between_commit_and_send_neither_loses_nor_repeats_a_message() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let rule = t.rule(&ds, &cp, json!({})).await;
    let fake = Fake::default();

    // The evaluation committed its message, then the server stopped before sending it.
    assert_eq!(scheduler::run_due(&t.state).await.unwrap(), 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_deliveries").await, 1);
    // After the restart the same slot is evaluated again (a new planner knows nothing): it is
    // stored already, so nothing is recorded twice.
    let tick: i64 =
        sqlx::query_scalar("SELECT last_evaluated_at FROM alert_rules").fetch_one(&t.state.db).await.unwrap();
    kalzit::alerting::evaluate::evaluate(&t.state, &rule, tick).await.unwrap();
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_deliveries").await, 1);
    // A sender that claimed it and died holds it until its lease runs out.
    sqlx::query("UPDATE alert_deliveries SET lease_until = $1")
        .bind(t.now() + 60_000)
        .execute(&t.state.db)
        .await
        .unwrap();
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0);
    t.clock.advance_ms(60_001);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 1);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0);
    let sent = fake.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["event"], "firing");
    // Later evaluations of the same firing never record it again.
    assert_eq!(t.next_minute().await, 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_deliveries").await, 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_delivery_keys").await, 1);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_deliveries_are_tried_three_times_with_pauses() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    t.rule(&ds, &cp, json!({})).await;
    let fake = Fake::default();
    fake.fail.store(true, Ordering::SeqCst);
    scheduler::run_due(&t.state).await.unwrap();
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 1);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0, "not before the pause");
    t.clock.advance_ms(10_000);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 1);
    t.clock.advance_ms(60_000);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 1);
    t.clock.advance_ms(3_600_000);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0, "given up after three");
    let attempts: Vec<(i64, String)> =
        sqlx::query_as("SELECT attempt, result FROM alert_history WHERE kind = 'delivery' ORDER BY attempt")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(attempts, [(1, "503".into()), (2, "503".into()), (3, "503".into())]);
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!(r.body["lastDelivery"]["error"], "503", "{}", r.body);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resolve_held_back_by_a_silence_is_sent_when_it_ends() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let rule = t.rule(&ds, &cp, json!({})).await;
    let fake = Fake::default();
    scheduler::run_due(&t.state).await.unwrap();
    outbox::deliver_due(&t.state, &fake).await.unwrap();
    assert_eq!(fake.take()[0]["event"], "firing");

    let silence = json!({ "matchers": [{ "label": "alertname", "op": "=", "value": "Lager-API Latenz" }],
                          "endsAt": t.now() + 3_600_000, "comment": "Wartung" });
    let r = t.call(&Who::Owner, Method::POST, "/alerting/silences", Some(silence)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let silence_id = r.body["id"].as_str().unwrap().to_string();
    // The series goes away; after three evaluations the instance ends, silently.
    t.write("DELETE FROM m").await;
    for _ in 0..3 {
        t.next_minute().await;
    }
    outbox::deliver_due(&t.state, &fake).await.unwrap();
    assert!(fake.take().is_empty());
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_owed_resolves").await, 1);
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert!(r.body["instances"].as_array().unwrap().iter().all(|i| i["labels"] != json!({ "host": "a" })));

    // The silence ends: the resolve is sent once.
    let r = t.call(&Who::Owner, Method::POST, &format!("/alerting/silences/{silence_id}/expire"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.next_minute().await;
    outbox::deliver_due(&t.state, &fake).await.unwrap();
    let sent = fake.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["event"], "resolved");
    assert_eq!(sent[0]["instances"][0]["reason"], "series_gone");
    assert_eq!(sent[0]["instances"][0]["labels"], json!({ "host": "a" }));
    t.next_minute().await;
    outbox::deliver_due(&t.state, &fake).await.unwrap();
    assert!(fake.take().is_empty());
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_owed_resolves").await, 0);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn previews_run_with_the_editors_rights_and_store_nothing() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let viewer = t.as_role("viewer").await;
    let editor = t.as_role("editor").await;
    let draft = json!({
        "name": "Entwurf", "datasourceId": ds,
        "query": { "query": { "sql": "SELECT host, v FROM m" } },
        "reduce": { "shape": "frame", "function": "last" },
        "condition": { "op": "gt", "value": 1.5 },
        "forSecs": 120, "language": "en",
    });
    let r = t.call(&viewer, Method::POST, "/alerting/rules/preview", Some(draft.clone())).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.call(&editor, Method::POST, "/alerting/rules/preview", Some(draft.clone())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["shape"], "frame");
    assert_eq!(r.body["datasourceOptedIn"], true);
    assert_eq!(
        r.body["series"][0],
        json!({ "labels": { "host": "a" }, "field": "v", "value": 2.0, "conditionMet": true })
    );
    assert_eq!(r.body["valueFields"], json!(["v"]));
    assert_eq!(r.body["labelFields"], json!(["host"]));
    assert_eq!(
        (r.body["instances"][0]["state"].as_str(), r.body["instances"][0]["pendingTarget"].as_str()),
        (Some("pending"), Some("firing"))
    );
    assert_eq!(r.body["message"]["subject"], "[Firing] Entwurf · MouseWerk", "{}", r.body);
    assert_eq!(r.body["message"]["webhook"]["instances"][0]["value"], 2.0);
    // A failing query answers its source's error to the editor; still nothing is stored.
    let mut broken = draft.clone();
    broken["query"] = json!({ "query": { "sql": "SELECT nope FROM nirgends" } });
    let r = t.call(&editor, Method::POST, "/alerting/rules/preview", Some(broken)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["error"]["code"], "alerting.query_failed");
    assert!(r.body["queryError"]["code"].is_string(), "{}", r.body);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_rules").await, 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_instances").await, 0);
    // Another organization's source is not found.
    let other = uuid::Uuid::now_v7().to_string();
    let mut foreign = draft.clone();
    foreign["datasourceId"] = json!(other);
    let r = t.call(&editor, Method::POST, "/alerting/rules/preview", Some(foreign)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    // Limited per person.
    let mut limited = false;
    for _ in 0..25 {
        let r = t.call(&editor, Method::POST, "/alerting/rules/preview", Some(draft.clone())).await;
        if r.status == StatusCode::TOO_MANY_REQUESTS {
            limited = true;
            break;
        }
    }
    assert!(limited);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_sends_are_signed_limited_audited_and_respect_the_target_rules() {
    let mut t = TestApp::new().await;
    let hook = receiver().await;
    let editor = t.as_role("editor").await;
    let (cp, secret) = t.webhook(&hook.url()).await;
    let path = format!("/alerting/contact-points/{cp}/test");
    let r = t.call(&editor, Method::POST, &path, None).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.call(&Who::Owner, Method::POST, &path, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["ok"].as_bool(), r.body["result"].as_str()), (Some(true), Some("ok")));
    let got = hook.take();
    let (headers, body, raw) = &got[0];
    verify(headers, raw, &secret);
    assert_eq!(headers["kalzit-event"], "test");
    assert_eq!(body["rule"]["name"], "Beispielregel");
    // The receiver's answer is the result.
    hook.status.store(503, Ordering::SeqCst);
    let r = t.call(&Who::Owner, Method::POST, &path, None).await;
    assert_eq!((r.body["ok"].as_bool(), r.body["result"].as_str()), (Some(false), Some("503")), "{}", r.body);
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!(r.body["lastDelivery"]["error"], "503");
    // A metadata address is refused when sending, whatever was stored.
    sqlx::query("UPDATE alert_contact_points SET settings = $1")
        .bind(json!({ "url": "http://169.254.169.254/latest", "language": "de" }).to_string())
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.call(&Who::Owner, Method::POST, &path, None).await;
    assert_eq!((r.body["ok"].as_bool(), r.body["result"].as_str()), (Some(false), Some("blocked")), "{}", r.body);
    // At most 5 per minute and contact point.
    for _ in 0..2 {
        t.call(&Who::Owner, Method::POST, &path, None).await;
    }
    let r = t.call(&Who::Owner, Method::POST, &path, None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);
    let tested: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE action = 'alert_contact_point.tested'")
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(tested, 5);
    let summaries: Vec<(String,)> =
        sqlx::query_as("SELECT summary FROM audit_events").fetch_all(&t.state.db).await.unwrap();
    assert!(summaries.iter().all(|(s,)| !s.contains(&secret) && !s.contains("/hook")));
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panels_show_the_state_of_their_rules() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let viewer = t.as_role("viewer").await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let model = json!({ "schemaVersion": 2, "title": "Lager", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{ "id": "p1", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT host, v FROM m" } }] }] });
    let r = t.call(&Who::Owner, Method::POST, "/dashboards", Some(json!({ "model": model }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let dashboard = r.body["id"].as_str().unwrap().to_string();
    let rule = t.rule(&ds, &cp, json!({ "dashboardId": dashboard, "panelId": "p1" })).await;
    scheduler::run_due(&t.state).await.unwrap();
    let r = t.call(&viewer, Method::GET, &format!("/alerting/panels?dashboardId={dashboard}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let panel = &r.body["items"][0];
    assert_eq!((panel["panelId"].as_str(), panel["state"].as_str()), (Some("p1"), Some("firing")), "{}", r.body);
    assert_eq!(panel["rules"][0]["id"], rule.as_str());
    assert_eq!(panel["rules"][0]["condition"], json!({ "op": "gt", "value": 1.5 }));
    assert_eq!(panel["rules"][0]["instances"][0]["lastValue"], 2.0);
    assert_eq!(panel["silenced"], false);
    let unknown = uuid::Uuid::now_v7();
    let r = t.call(&viewer, Method::GET, &format!("/alerting/panels?dashboardId={unknown}"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    t.finish().await;
}
