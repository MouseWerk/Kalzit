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
        Self::with_mail(None).await
    }

    /// With a mail server without TLS on `smtp_port` of this computer.
    async fn with_mail(smtp_port: Option<u16>) -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        if let Some(port) = smtp_port {
            config.smtp.host = "127.0.0.1".into();
            config.smtp.port = port;
            config.smtp.security = "none".into();
            config.smtp.from_name = "Kalzit".into();
            config.smtp.from_address = "kalzit@example.com".into();
        }
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
        self.webhook_named("Lager-Webhook", url).await
    }

    async fn webhook_named(&mut self, name: &str, url: &str) -> (String, String) {
        let body = json!({ "name": name, "kind": "webhook", "language": "de", "url": url });
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

    /// Adds `n` copies of the message waiting for `contact_point`, each due a millisecond before
    /// the last, so they come first.
    async fn copies(&self, contact_point: &str, n: i64) {
        let (org, rule, event, message, due): (String, String, String, String, i64) = sqlx::query_as(
            "SELECT org_id, rule_id, event, message, next_attempt_at FROM alert_deliveries WHERE contact_point_id = $1",
        )
        .bind(contact_point)
        .fetch_one(&self.state.db)
        .await
        .unwrap();
        let mut tx = kalzit::db::begin(&self.state.db).await.unwrap();
        for i in 1..=n {
            sqlx::query(
                "INSERT INTO alert_deliveries (id, org_id, rule_id, contact_point_id, event, message, attempts, \
                 next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)",
            )
            .bind(uuid::Uuid::now_v7().to_string())
            .bind(&org)
            .bind(&rule)
            .bind(contact_point)
            .bind(&event)
            .bind(&message)
            .bind(due - i)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        kalzit::db::commit(tx).await.unwrap();
    }

    /// Sets an organization setting.
    async fn org_setting(&mut self, key: &str, value: Value) {
        let r = self
            .call(
                &Who::Owner,
                Method::PATCH,
                &format!("/settings/{key}"),
                Some(json!({ "value": value, "version": 0 })),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
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
    /// The `sent_to` of every message handed over.
    seen_sent_to: Mutex<Vec<Vec<String>>>,
    fail: AtomicBool,
    /// Records the message, then never answers: the sender dies mid-send.
    hang: AtomicBool,
    /// Contact points whose messages never get an answer (a blackholed receiver).
    hang_for: Mutex<Vec<String>>,
    /// The result of every attempt instead of `503` while `fail` is set.
    fail_with: Mutex<Option<String>>,
    /// Contact point of every message handed over, in order.
    seen_points: Mutex<Vec<String>>,
}

impl Transport for Fake {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            self.seen_sent_to.lock().unwrap().push(out.sent_to.clone());
            self.seen_points.lock().unwrap().push(out.contact_point_id.clone());
            if self.fail.load(Ordering::SeqCst) {
                let result = self.fail_with.lock().unwrap().clone().unwrap_or_else(|| "503".into());
                return Attempt { ok: false, result, sent_to: Vec::new() };
            }
            self.sent.lock().unwrap().push(serde_json::to_value(&out.message).unwrap());
            let blackholed = self.hang_for.lock().unwrap().contains(&out.contact_point_id);
            if self.hang.load(Ordering::SeqCst) || blackholed {
                std::future::pending::<()>().await;
            }
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
    assert_eq!(r.body["instances"][0]["labels"], json!({ "__field__": "v", "host": "a" }));
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
    assert!(
        r.body["instances"].as_array().unwrap().iter().all(|i| i["labels"] != json!({ "__field__": "v", "host": "a" }))
    );

    // The silence ends: the resolve is sent once.
    let r = t.call(&Who::Owner, Method::POST, &format!("/alerting/silences/{silence_id}/expire"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.next_minute().await;
    outbox::deliver_due(&t.state, &fake).await.unwrap();
    let sent = fake.take();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["event"], "resolved");
    assert_eq!(sent[0]["instances"][0]["reason"], "series_gone");
    assert_eq!(sent[0]["instances"][0]["labels"], json!({ "__field__": "v", "host": "a" }));
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
        json!({ "labels": { "__field__": "v", "host": "a" }, "field": "v", "value": 2.0, "conditionMet": true })
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
    // A viewer may not read the source: the state, without labels or values.
    assert_eq!(panel["rules"][0]["dataHidden"], true, "{}", r.body);
    assert_eq!(panel["rules"][0]["instances"][0]["state"], "firing");
    assert_eq!(panel["rules"][0]["instances"][0]["lastValue"], Value::Null);
    assert_eq!(panel["rules"][0]["instances"][0]["labels"], json!({}));
    assert_eq!(panel["silenced"], false);
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/panels?dashboardId={dashboard}"), None).await;
    let owner_rule = &r.body["items"][0]["rules"][0];
    assert_eq!(owner_rule["dataHidden"], false, "{}", r.body);
    assert_eq!(owner_rule["instances"][0]["lastValue"], 2.0);
    assert_eq!(owner_rule["instances"][0]["labels"], json!({ "__field__": "v", "host": "a" }));
    let unknown = uuid::Uuid::now_v7();
    let r = t.call(&viewer, Method::GET, &format!("/alerting/panels?dashboardId={unknown}"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // `alerts:read` without read access to the dashboard: no badge.
    let role = json!({ "name": "Nur Alarme", "description": "", "permissions": ["alerts:read"] });
    let r = t.call(&Who::Owner, Method::POST, "/roles", Some(role)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let alerts_only = t.as_role(r.body["id"].as_str().unwrap()).await;
    let r = t.call(&alerts_only, Method::GET, &format!("/alerting/panels?dashboardId={dashboard}"), None).await;
    assert!(matches!(r.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND), "{}", r.body);
    assert!(!r.body.to_string().contains(&rule));
    t.finish().await;
}

/// A mail server without TLS that refuses recipients with `refuse` in the address and records
/// every accepted `RCPT TO`.
async fn fake_smtp() -> (u16, Arc<Mutex<Vec<String>>>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let accepted = Arc::new(Mutex::new(Vec::new()));
    let log = accepted.clone();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else { return };
            let log = log.clone();
            tokio::spawn(async move {
                let (read, mut write) = socket.into_split();
                let mut lines = BufReader::new(read).lines();
                let _ = write.write_all(b"220 fake\r\n").await;
                let mut in_data = false;
                let mut to = String::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    let answer: &[u8] = if in_data {
                        if line != "." {
                            continue;
                        }
                        in_data = false;
                        log.lock().unwrap().push(to.clone());
                        b"250 queued\r\n"
                    } else if let Some(rest) = line.strip_prefix("RCPT TO:<") {
                        to = rest.trim_end_matches('>').to_string();
                        if to.contains("refuse") { b"550 no such user\r\n" } else { b"250 ok\r\n" }
                    } else if line == "DATA" {
                        in_data = true;
                        b"354 go on\r\n"
                    } else if line == "QUIT" {
                        let _ = write.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = write.write_all(answer).await;
                }
            });
        }
    });
    (port, accepted)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mail_goes_to_each_recipient_once_and_a_refused_one_does_not_stop_the_others() {
    let (port, accepted) = fake_smtp().await;
    let mut t = TestApp::with_mail(Some(port)).await;
    let ds = t.source().await;
    let body = json!({ "name": "Bereitschaft", "kind": "mail", "language": "en",
                       "recipients": ["refuse@example.de", "lea@example.de"] });
    let r = t.call(&Who::Owner, Method::POST, "/alerting/contact-points", Some(body)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let cp = r.body["id"].as_str().unwrap().to_string();
    t.rule(&ds, &cp, json!({})).await;
    let channels = Channels(t.state.clone());
    scheduler::run_due(&t.state).await.unwrap();
    assert_eq!(outbox::deliver_due(&t.state, &channels).await.unwrap(), 1);
    assert_eq!(*accepted.lock().unwrap(), ["lea@example.de"]);
    let (result, sent_to): (String, String) =
        sqlx::query_as("SELECT result, sent_to FROM alert_deliveries").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(result, "mail.recipient_rejected");
    assert_eq!(sent_to, r#"["lea@example.de"]"#);
    // The retry mails only the one not reached.
    t.clock.advance_ms(10_000);
    assert_eq!(outbox::deliver_due(&t.state, &channels).await.unwrap(), 1);
    assert_eq!(*accepted.lock().unwrap(), ["lea@example.de"], "lea is not mailed twice");
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!(r.body["lastDelivery"]["error"], "mail.recipient_rejected", "{}", r.body);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_sender_that_dies_mid_send_is_repeated_with_the_same_id_and_given_up_after_three() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    t.rule(&ds, &cp, json!({})).await;
    let fake = Fake::default();
    fake.hang.store(true, Ordering::SeqCst);
    scheduler::run_due(&t.state).await.unwrap();
    // A recipient an earlier attempt reached is handed to the next one.
    sqlx::query("UPDATE alert_deliveries SET sent_to = '[\"lea@example.de\"]'").execute(&t.state.db).await.unwrap();
    for _ in 0..3 {
        let run = outbox::deliver_due(&t.state, &fake);
        assert!(tokio::time::timeout(std::time::Duration::from_millis(500), run).await.is_err(), "it hangs");
        // Claimed: nobody else sends it while the lease lasts.
        assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0);
        t.clock.advance_ms(5 * MINUTE + 1);
    }
    let sent = fake.take();
    assert_eq!(sent.len(), 3);
    assert!(sent.iter().all(|m| m["deliveryId"] == sent[0]["deliveryId"]), "the same Kalzit-Delivery");
    assert!(fake.seen_sent_to.lock().unwrap().iter().all(|s| s == &["lea@example.de".to_string()]));
    // Every attempt was claimed: given up, not tried a fourth time.
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0);
    assert!(fake.take().is_empty());
    let (attempts, result, done): (i64, String, Option<i64>) =
        sqlx::query_as("SELECT attempts, result, done_at FROM alert_deliveries").fetch_one(&t.state.db).await.unwrap();
    assert_eq!((attempts, result.as_str(), done.is_some()), (3, "interrupted", true));
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_workers_never_send_the_same_message() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    t.rule(&ds, &cp, json!({})).await;
    scheduler::run_due(&t.state).await.unwrap();
    let fake = Fake::default();
    let (a, b) = tokio::join!(outbox::deliver_due(&t.state, &fake), outbox::deliver_due(&t.state, &fake));
    assert_eq!(a.unwrap() + b.unwrap(), 1);
    assert_eq!(fake.take().len(), 1);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_source_error_stays_in_the_server_log() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let broken = json!({ "query": { "query": { "sql": "SELECT geheim FROM nirgends_tabelle" } } });
    let rule = t.rule(&ds, &cp, broken).await;
    scheduler::run_due(&t.state).await.unwrap();
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(r.body["lastError"], json!({ "code": "alerting.query_failed" }), "{}", r.body);
    assert_eq!(r.body["state"], "error");
    let fake = Fake::default();
    outbox::deliver_due(&t.state, &fake).await.unwrap();
    let sent = fake.take();
    assert_eq!(sent[0]["instances"][0]["error"], json!({ "code": "alerting.query_failed" }));
    for sql in [
        "SELECT COALESCE(last_error, '') FROM alert_rules",
        "SELECT COALESCE(last_error, '') FROM alert_instances",
        "SELECT COALESCE(error, '') FROM alert_history",
        "SELECT message FROM alert_deliveries",
    ] {
        let texts: Vec<(String,)> =
            sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string())).fetch_all(&t.state.db).await.unwrap();
        for (text,) in texts {
            assert!(!text.contains("nirgends") && !text.contains("no such table"), "{sql}: {text}");
        }
    }
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_webhook_never_reaches_kalzit_itself() {
    let mut t = TestApp::new().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let port = t.state.config.http_addr().unwrap().port();
    for url in [format!("http://127.0.0.1:{port}/api/setup"), format!("http://localhost:{port}/x")] {
        sqlx::query("UPDATE alert_contact_points SET settings = $1")
            .bind(json!({ "url": url, "language": "de" }).to_string())
            .execute(&t.state.db)
            .await
            .unwrap();
        let r = t.call(&Who::Owner, Method::POST, &format!("/alerting/contact-points/{cp}/test"), None).await;
        assert_eq!(
            (r.body["ok"].as_bool(), r.body["result"].as_str()),
            (Some(false), Some("blocked")),
            "{url}: {}",
            r.body
        );
    }
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn previews_need_the_right_to_query_the_source_and_skips_are_stored() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let role = json!({ "name": "Alarmpflege", "description": "", "permissions": ["alerts:read", "alerts:write"] });
    let r = t.call(&Who::Owner, Method::POST, "/roles", Some(role)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let custom = t.as_role(r.body["id"].as_str().unwrap()).await;
    let draft = json!({ "datasourceId": ds, "query": { "query": { "sql": "SELECT host, v FROM m" } },
                        "reduce": { "shape": "frame", "function": "last" }, "condition": { "op": "gt", "value": 1 } });
    let r = t.call(&custom, Method::POST, "/alerting/rules/preview", Some(draft)).await;
    assert!(matches!(r.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND), "{}", r.body);
    assert!(r.body.get("series").is_none());

    // A slot that passes while the rule still runs is counted on the rule.
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let rule = t.rule(&ds, &cp, json!({})).await;
    let started = scheduler::due(&t.state).await.unwrap();
    assert_eq!(started.len(), 1);
    t.clock.advance_ms(MINUTE);
    assert!(scheduler::due(&t.state).await.unwrap().is_empty());
    t.clock.advance_ms(MINUTE);
    assert!(scheduler::due(&t.state).await.unwrap().is_empty());
    scheduler::run(&t.state, &started[0]).await;
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(r.body["skippedEvaluations"], 1, "{}", r.body);
    t.finish().await;
}

/// A receiver that never answers holds at most its own slots: the messages to other contact
/// points go out while its messages hang.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blackholed_receiver_does_not_hold_up_the_others() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (slow, _) = t.webhook_named("Schwarzes Loch", "http://127.0.0.1:9/slow").await;
    let (fast, _) = t.webhook_named("Bereitschaft", "http://127.0.0.1:9/fast").await;
    t.rule(&ds, &slow, json!({ "contactPointIds": [slow, fast] })).await;
    scheduler::run_due(&t.state).await.unwrap();
    // Many more messages to the slow one than the worker sends at once, all due earlier.
    t.copies(&slow, 3 * outbox::MAX_IN_FLIGHT as i64).await;
    let fake = Fake::default();
    fake.hang_for.lock().unwrap().push(slow.clone());
    let run = outbox::deliver_due(&t.state, &fake);
    assert!(tokio::time::timeout(std::time::Duration::from_millis(1500), run).await.is_err(), "the slow one hangs");
    let points = fake.seen_points.lock().unwrap().clone();
    assert_eq!(points.iter().filter(|p| **p == fast).count(), 1, "{points:?}");
    assert_eq!(points.iter().filter(|p| **p == slow).count(), outbox::MAX_IN_FLIGHT_PER_CONTACT_POINT, "{points:?}");
    t.finish().await;
}

/// After repeated timeouts the worker pauses a contact point without using up attempts, and
/// sends its messages once the pause is over.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repeated_timeouts_pause_a_contact_point() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    t.rule(&ds, &cp, json!({})).await;
    scheduler::run_due(&t.state).await.unwrap();
    t.copies(&cp, 7).await;
    let fake = Fake::default();
    fake.fail.store(true, Ordering::SeqCst);
    *fake.fail_with.lock().unwrap() = Some("timeout".into());
    let made = outbox::deliver_due(&t.state, &fake).await.unwrap();
    assert!((outbox::BREAKER_FAILURES as usize..8).contains(&made), "{made}");
    let until = t.state.alerting.breakers.open_until(&cp, t.now()).expect("paused");
    assert_eq!(until, t.now() + outbox::BREAKER_OPEN_MS);
    let paused = t
        .count(&format!(
            "SELECT COUNT(*) FROM alert_deliveries WHERE result = 'circuit_open' AND attempts = 0 \
             AND next_attempt_at = {until}"
        ))
        .await;
    assert_eq!(paused, 8 - made as i64);
    // Nothing goes out while paused, everything after.
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 0);
    t.clock.advance_ms(outbox::BREAKER_OPEN_MS + 1);
    fake.fail.store(false, Ordering::SeqCst);
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 8);
    assert_eq!(fake.take().len(), 8);
    assert!(t.state.alerting.breakers.open_until(&cp, t.now()).is_none());
    t.finish().await;
}

/// Messages beyond the organization's hourly limit are not sent, and beyond its waiting limit
/// not queued; both are in the history with their result.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_organization_has_hourly_and_waiting_limits() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    t.rule(&ds, &cp, json!({})).await;
    t.org_setting("alerting.max_messages_per_org_hour", json!(1)).await;
    scheduler::run_due(&t.state).await.unwrap();
    t.copies(&cp, 2).await;
    let fake = Fake::default();
    assert_eq!(outbox::deliver_due(&t.state, &fake).await.unwrap(), 3);
    assert_eq!(fake.take().len(), 1);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM alert_deliveries WHERE result = 'rate_limited' AND done_at IS NOT NULL").await,
        2
    );
    let r = t.call(&Who::Owner, Method::GET, "/alerting/history?kind=delivery", None).await;
    let results: Vec<&str> =
        r.body["items"].as_array().unwrap().iter().map(|e| e["result"].as_str().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| **r == "rate_limited").count(), 2, "{}", r.body);

    // With as many messages waiting as allowed, the next one is not queued.
    t.copies(&cp, outbox::MAX_PENDING_PER_ORG).await;
    t.write("UPDATE m SET v = 1.0").await;
    assert_eq!(t.next_minute().await, 1);
    let (result, done, attempts): (String, Option<i64>, i64) =
        sqlx::query_as("SELECT result, done_at, attempts FROM alert_deliveries WHERE event = 'resolved'")
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!((result.as_str(), done.is_some(), attempts), ("queue_full", true, 0));
    let r = t.call(&Who::Owner, Method::GET, "/alerting/history?kind=delivery", None).await;
    let full = r.body["items"].as_array().unwrap().iter().find(|e| e["result"] == "queue_full").cloned();
    assert_eq!(full.map(|e| (e["event"].clone(), e["attempt"].clone())), Some((json!("resolved"), json!(0))));
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn contact_points_and_test_sends_are_limited_per_organization() {
    let mut t = TestApp::new().await;
    t.org_setting("alerting.max_contact_points_per_org", json!(5)).await;
    let mut points = Vec::new();
    for i in 0..5 {
        points.push(t.webhook_named(&format!("Punkt {i}"), "http://127.0.0.1:9/hook").await.0);
    }
    let body = json!({ "name": "Punkt 5", "kind": "webhook", "language": "de", "url": "http://127.0.0.1:9/hook" });
    let r = t.call(&Who::Owner, Method::POST, "/alerting/contact-points", Some(body)).await;
    assert_eq!(
        (r.status, r.body["error"]["reason"].as_str()),
        (StatusCode::CONFLICT, Some("alerts.too_many_contact_points_in_org")),
        "{}",
        r.body
    );
    assert_eq!(r.body["error"]["params"]["max"], "5", "{}", r.body);
    // 4 per contact point stays below its own limit; the organization's 20 are used up.
    for i in 0..scheduler::TESTS_PER_ORG_MINUTE as usize {
        let path = format!("/alerting/contact-points/{}/test", points[i % 5]);
        let r = t.call(&Who::Owner, Method::POST, &path, None).await;
        assert_eq!(r.status, StatusCode::OK, "{i}: {}", r.body);
    }
    let r = t.call(&Who::Owner, Method::POST, &format!("/alerting/contact-points/{}/test", points[0]), None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);
    t.finish().await;
}

/// Viewers and editors who may not read or query a rule's source see states and counts, not
/// what the data says: no labels, values or error parameters, in rules, instances and history.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn people_without_source_rights_see_states_not_data() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let (cp, _) = t.webhook("http://127.0.0.1:9/hook").await;
    let rule = t.rule(&ds, &cp, json!({})).await;
    // A label value longer than allowed: an error with parameters.
    let long = json!({ "name": "Lange Labels",
                       "query": { "query": { "sql": "SELECT substr(hex(zeroblob(200)), 1, 300) AS host, v FROM m" } } });
    let broken = t.rule(&ds, &cp, long).await;
    scheduler::run_due(&t.state).await.unwrap();
    let r = t.call(&Who::Owner, Method::GET, &format!("/alerting/rules/{broken}"), None).await;
    let full_error = json!({ "code": "alerting.label_too_long", "params": { "what": "value", "max": "256" } });
    assert_eq!(r.body["lastError"], full_error, "{}", r.body);
    assert_eq!(r.body["dataHidden"], false);
    let r = t.call(&Who::Owner, Method::GET, "/alerting/history?label=host=a", None).await;
    assert!(!r.body["items"].as_array().unwrap().is_empty(), "{}", r.body);

    let viewer = t.as_role("viewer").await;
    let role = json!({ "name": "Alarmpflege", "description": "", "permissions": ["alerts:read", "alerts:write"] });
    let r = t.call(&Who::Owner, Method::POST, "/roles", Some(role)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let editor_without_source = t.as_role(r.body["id"].as_str().unwrap()).await;
    for who in [viewer, editor_without_source] {
        let r = t.call(&who, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        assert_eq!((r.body["dataHidden"].as_bool(), r.body["state"].as_str()), (Some(true), Some("firing")));
        let instance = &r.body["instances"][0];
        assert_eq!((&instance["labels"], &instance["lastValue"]), (&json!({}), &Value::Null), "{}", r.body);
        assert_eq!(instance["state"], "firing");
        let r = t.call(&who, Method::GET, &format!("/alerting/rules/{broken}"), None).await;
        assert_eq!(r.body["lastError"], json!({ "code": "alerting.label_too_long" }), "{}", r.body);
        assert_eq!(r.body["instances"][0]["lastError"], json!({ "code": "alerting.label_too_long" }));
        let r = t.call(&who, Method::GET, "/alerting/rules", None).await;
        assert!(r.body["items"].as_array().unwrap().iter().all(|i| i["dataHidden"] == true), "{}", r.body);
        let r = t.call(&who, Method::GET, "/alerting/history", None).await;
        let items = r.body["items"].as_array().unwrap();
        assert!(!items.is_empty());
        for e in items {
            assert_eq!((&e["dataHidden"], &e["labels"], &e["value"]), (&json!(true), &json!({}), &Value::Null), "{e}");
            assert!(e["error"].is_null() || e["error"].get("params").is_none(), "{e}");
        }
        // A label filter does not tell which hidden labels exist.
        let r = t.call(&who, Method::GET, "/alerting/history?label=host=a", None).await;
        assert_eq!(r.body["items"], json!([]), "{}", r.body);
    }
    t.finish().await;
}
