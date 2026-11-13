//! Alerting 0.7.2 through the real router and a real SQLite source (on PostgreSQL too when
//! `KALZIT_TEST_POSTGRES_URL` is set): notification policies, groups across rules with their
//! times on a manual clock, escalation and silences, Slack and Teams, the routing of rules, the
//! rights, and the update of 0.7.0 rules.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use kalzit::alerting::outbox::{self, Attempt, Outgoing, Transport};
use kalzit::alerting::{groups, scheduler};
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const SEC: i64 = 1000;
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

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
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

    async fn ok(&mut self, method: Method, rest: &str, body: Option<Value>) -> Value {
        let r = self.call(&Who::Owner, method.clone(), rest, body).await;
        assert!(r.status.is_success(), "{method} {rest}: {} {}", r.status, r.body);
        r.body
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
        let ds = self.ok(Method::POST, "/datasources", Some(body)).await["id"].as_str().unwrap().to_string();
        self.ok(Method::PUT, &format!("/datasources/{ds}/alerting"), Some(json!({ "enabled": true }))).await;
        ds
    }

    async fn webhook(&mut self, name: &str) -> String {
        let body = json!({ "name": name, "kind": "webhook", "language": "de", "url": "http://127.0.0.1:9/hook" });
        self.ok(Method::POST, "/alerting/contact-points", Some(body)).await["id"].as_str().unwrap().to_string()
    }

    async fn rule(&mut self, ds: &str, name: &str, extra: Value) -> String {
        let mut body = json!({
            "name": name,
            "datasourceId": ds,
            "query": { "query": { "sql": "SELECT host, v FROM m" } },
            "reduce": { "shape": "frame", "function": "last" },
            "condition": { "op": "gt", "value": 1.5 },
            "intervalSecs": 60,
            "noDataState": "ok",
            "labels": { "team": "lager" },
        });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        self.ok(Method::POST, "/alerting/rules", Some(body)).await["id"].as_str().unwrap().to_string()
    }

    async fn root(&mut self) -> Value {
        let r = self.ok(Method::GET, "/alerting/policies", None).await;
        r["items"][0].clone()
    }

    async fn count(&self, sql: &str) -> i64 {
        let (n,): (i64,) =
            sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string())).fetch_one(&self.state.db).await.unwrap();
        n
    }

    /// The scheduler runs the due evaluations and the dispatcher the due groups.
    async fn tick(&self) -> usize {
        scheduler::run_due(&self.state).await.unwrap();
        groups::dispatch_due(&self.state).await.unwrap()
    }
}

/// A transport that records every message and its contact point.
#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<(String, Value)>>,
}

impl Transport for Fake {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt> {
        Box::pin(async move {
            self.sent.lock().unwrap().push((out.contact_point_id.clone(), serde_json::to_value(&out.message).unwrap()));
            Attempt { ok: true, result: "ok".into(), ..Attempt::default() }
        })
    }
}

impl Fake {
    async fn take(&self, t: &TestApp) -> Vec<(String, Value)> {
        outbox::deliver_due(&t.state, self).await.unwrap();
        let mut sent: Vec<(String, Value)> = self.sent.lock().unwrap().drain(..).collect();
        sent.sort_by(|a, b| {
            a.0.cmp(&b.0).then(a.1["group"]["stage"].to_string().cmp(&b.1["group"]["stage"].to_string()))
        });
        sent
    }
}

fn names(message: &Value) -> Vec<String> {
    message["alerts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| format!("{}:{}", a["rule"]["name"].as_str().unwrap(), a["event"].as_str().unwrap()))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn groups_bundle_rules_wait_repeat_escalate_and_resolve() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let team = t.webhook("Team Lager").await;
    let on_call = t.webhook("Bereitschaft").await;
    // Standard › Lager (team=lager): grouped by team, 30 s wait, 5 min interval, 1 h repeat,
    // step 1 after 5 minutes.
    let root = t.root().await;
    assert_eq!(root["name"], "Standard");
    assert_eq!(root["effective"]["delivers"], false);
    let body = json!({
        "parentId": root["id"], "name": "Lager",
        "matchers": [{ "label": "team", "op": "=", "value": "lager" }],
        "groupBy": ["team"], "groupWaitSecs": 30, "groupIntervalSecs": 300, "repeatIntervalSecs": 3600,
        "contactPointIds": [team],
        "escalations": [{ "level": 1, "waitSecs": 300, "contactPointIds": [on_call] }],
    });
    let lager = t.ok(Method::POST, "/alerting/policies", Some(body)).await;
    assert_eq!(lager["effective"]["delivers"], true);
    assert_eq!(lager["depth"], 1);
    let a = t.rule(&ds, "Latenz", json!({})).await;
    let b = t.rule(&ds, "Fehlerquote", json!({})).await;
    let fake = Fake::default();

    // Both rules fire: one group, nothing before the group wait.
    assert_eq!(t.tick().await, 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_groups").await, 1);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_group_pending").await, 2);
    let r = t.ok(Method::GET, &format!("/alerting/rules/{a}"), None).await;
    assert_eq!(r["routing"], "policies");
    assert_eq!(r["routes"][0]["path"][1]["name"], "Lager", "{r}");
    let g = t.ok(Method::GET, "/alerting/groups", None).await;
    assert_eq!(g["items"][0]["state"], "waiting");
    assert_eq!(g["items"][0]["labels"], json!({ "team": "lager" }));
    t.clock.advance_ms(30 * SEC);
    assert_eq!(groups::dispatch_due(&t.state).await.unwrap(), 1);
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, team);
    let m = &sent[0].1;
    assert_eq!(m["version"], 2);
    assert_eq!(m["event"], "firing");
    assert_eq!(m["group"]["kind"], "change");
    assert_eq!(m["group"]["policy"]["name"], "Lager");
    assert_eq!(names(m), ["Latenz:firing", "Fehlerquote:firing"]);
    assert!(m["alerts"].as_array().unwrap().iter().all(|a| a["changed"] == true));
    // Nothing changes: nothing more, the same slot twice records nothing either.
    t.clock.advance_ms(MINUTE);
    assert_eq!(t.tick().await, 0);
    assert_eq!(groups::dispatch_due(&t.state).await.unwrap(), 0);
    assert!(fake.take(&t).await.is_empty());
    let keys = t.count("SELECT COUNT(*) FROM alert_delivery_keys").await;
    assert_eq!(keys, 2);

    // After 5 minutes of firing: step 1, the whole group to the on-call contact point.
    t.clock.advance_ms(4 * MINUTE);
    t.tick().await;
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].0, on_call);
    assert_eq!(sent[0].1["event"], "escalation");
    assert_eq!(sent[0].1["group"]["stage"], "e1");
    assert_eq!(names(&sent[0].1).len(), 2);
    let g = t.ok(Method::GET, "/alerting/groups", None).await;
    assert_eq!(g["items"][0]["escalationLevel"], 1);

    // Both resolve: past the group interval the team and the step reached get the resolve.
    t.write("UPDATE m SET v = 1.0").await;
    t.clock.advance_ms(MINUTE);
    t.tick().await;
    let sent = fake.take(&t).await;
    let resolved: Vec<&(String, Value)> = sent.iter().filter(|(_, m)| m["event"] == "resolved").collect();
    assert_eq!(resolved.len(), 2, "team and step: {sent:?}");
    assert!(resolved.iter().any(|(cp, _)| *cp == team) && resolved.iter().any(|(cp, _)| *cp == on_call));
    assert_eq!(names(&resolved[0].1), ["Latenz:resolved", "Fehlerquote:resolved"]);
    // Everything resolved and sent: the group is gone.
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_groups").await, 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_group_pending").await, 0);
    // The history names the group, the policy and the stage of each delivery.
    let h = t.ok(Method::GET, "/alerting/history?kind=delivery", None).await;
    let stages: Vec<&str> = h["items"].as_array().unwrap().iter().filter_map(|e| e["stage"].as_str()).collect();
    assert!(stages.contains(&"e1") && stages.contains(&"0"), "{h}");
    assert!(h["items"].as_array().unwrap().iter().all(|e| e["policyId"] == lager["id"]));
    assert!(h["items"].as_array().unwrap().iter().any(|e| e["ruleId"] == json!(b)));
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn repetitions_follow_the_policy_and_a_silence_holds_the_escalation() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let team = t.webhook("Team").await;
    let on_call = t.webhook("Bereitschaft").await;
    let mut root = t.root().await;
    // The root itself delivers: no wait, 5 minutes interval, repeat after 10 minutes, step 1
    // after 15 minutes.
    root["groupWaitSecs"] = json!(0);
    root["repeatIntervalSecs"] = json!(600);
    root["contactPointIds"] = json!([team]);
    root["escalations"] = json!([{ "level": 1, "waitSecs": 900, "contactPointIds": [on_call] }]);
    let body = json!({
        "name": root["name"], "groupBy": root["groupBy"], "groupWaitSecs": 0, "groupIntervalSecs": 300,
        "repeatIntervalSecs": 600, "contactPointIds": [team],
        "escalations": [{ "level": 1, "waitSecs": 900, "contactPointIds": [on_call] }], "version": root["version"],
    });
    let id = root["id"].as_str().unwrap().to_string();
    t.ok(Method::PUT, &format!("/alerting/policies/{id}"), Some(body)).await;
    t.rule(&ds, "Latenz", json!({ "reminderSecs": 60 })).await;
    let fake = Fake::default();
    t.tick().await;
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1["group"]["labels"], json!({ "alertname": "Latenz" }));
    // The rule's reminder of a minute does not apply; the policy repeats after 10 minutes.
    for _ in 0..9 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    assert!(fake.take(&t).await.is_empty());
    t.clock.advance_ms(MINUTE);
    t.tick().await;
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1["event"], "reminder");
    assert_eq!(sent[0].1["group"]["stage"], "1");
    assert_eq!(sent[0].1["alerts"][0]["reminder"], 1);

    // Silenced at minute 10 (by the rule's label): the escalation (due at 15) holds.
    let silence = json!({ "matchers": [{ "label": "team", "op": "=", "value": "lager" }],
                          "endsAt": t.now() + 30 * MINUTE, "comment": "Wartung" });
    let s = t.ok(Method::POST, "/alerting/silences", Some(silence)).await;
    groups::dispatch_due(&t.state).await.unwrap();
    for _ in 0..8 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    assert!(fake.take(&t).await.is_empty(), "nothing while silenced");
    let g = t.ok(Method::GET, "/alerting/groups", None).await;
    assert_eq!(g["items"][0]["escalationPaused"], true, "{g}");
    assert_eq!(g["items"][0]["escalationLevel"], 0);
    // The silence ends at minute 18 and is noticed at 19: the count goes on from 10 minutes, so
    // step 1 comes about 5 minutes later, not at once.
    let sid = s["id"].as_str().unwrap().to_string();
    t.ok(Method::POST, &format!("/alerting/silences/{sid}/expire"), None).await;
    t.clock.advance_ms(MINUTE);
    t.tick().await;
    let early: Vec<(String, Value)> = fake.take(&t).await.into_iter().filter(|(cp, _)| *cp == on_call).collect();
    assert!(early.is_empty(), "{early:?}");
    for _ in 0..5 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    let sent = fake.take(&t).await;
    assert!(sent.iter().any(|(cp, m)| *cp == on_call && m["group"]["stage"] == "e1"), "{sent:?}");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn routing_is_policies_or_direct_and_switches_without_double_sends() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let cp = t.webhook("Team").await;
    let root = t.root().await;
    let body = json!({
        "name": "Standard", "groupBy": ["alertname"], "groupWaitSecs": 0, "groupIntervalSecs": 300,
        "repeatIntervalSecs": 0, "contactPointIds": [cp], "version": root["version"],
    });
    t.ok(Method::PUT, &format!("/alerting/policies/{}", root["id"].as_str().unwrap()), Some(body)).await;
    // Without routing: direct with contact points, policies without.
    let direct = t.rule(&ds, "Direkt", json!({ "contactPointIds": [cp] })).await;
    let r = t.ok(Method::GET, &format!("/alerting/rules/{direct}"), None).await;
    assert_eq!(r["routing"], "direct");
    assert_eq!(r["routes"], json!([]));
    let r = t
        .call(
            &Who::Owner,
            Method::POST,
            "/alerting/rules",
            Some(json!({ "name": "x", "datasourceId": ds, "query": { "query": { "sql": "SELECT 1" } },
                         "reduce": { "shape": "frame", "function": "last" }, "condition": { "op": "gt", "value": 1 },
                         "routing": "policies", "contactPointIds": [cp] })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "alerts.routing_invalid"), "{}", r.body);
    let fake = Fake::default();
    t.tick().await;
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].1["version"], 1, "direct rules keep version 1");

    // Switched to the policies: the same contact point does not get the firing again.
    let mut rule = t.ok(Method::GET, &format!("/alerting/rules/{direct}"), None).await;
    let mut body = json!({});
    for k in
        ["name", "datasourceId", "query", "reduce", "condition", "intervalSecs", "noDataState", "labels", "version"]
    {
        body[k] = rule[k].take();
    }
    body["routing"] = json!("policies");
    t.ok(Method::PUT, &format!("/alerting/rules/{direct}"), Some(body.clone())).await;
    t.clock.advance_ms(MINUTE);
    t.tick().await;
    assert!(fake.take(&t).await.is_empty(), "deduplicated across the switch");
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_group_pending").await, 1);
    // And back to direct with the same contact point: it still has the instance, so it gets no
    // resolve from the group and no second firing from the rule.
    body["routing"] = json!("direct");
    body["contactPointIds"] = json!([cp]);
    body["version"] = json!(2);
    t.ok(Method::PUT, &format!("/alerting/rules/{direct}"), Some(body)).await;
    for _ in 0..6 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    let sent = fake.take(&t).await;
    assert!(sent.is_empty(), "{sent:?}");
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_group_pending").await, 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM alert_groups").await, 0);
    // Its real resolve still reaches the contact point, once.
    t.write("UPDATE m SET v = 1.0").await;
    t.clock.advance_ms(MINUTE);
    t.tick().await;
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].1["version"], 1);
    assert_eq!(sent[0].1["instances"][0]["event"], "resolved");
    t.finish().await;
}

/// People without rights on a rule's source learn nothing of its data labels from the groups or
/// the route check: no label values, no silence matched on them, no way that only those labels
/// would take.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn groups_and_route_checks_hide_data_labels() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let cp = t.webhook("Team").await;
    let root = t.root().await;
    let root_id = root["id"].as_str().unwrap().to_string();
    // A policy on a data label (`host` comes from the series).
    let host = t
        .ok(
            Method::POST,
            "/alerting/policies",
            Some(json!({ "parentId": root_id, "name": "Host A", "groupWaitSecs": 0,
                         "matchers": [{ "label": "host", "op": "=", "value": "a" }], "contactPointIds": [cp] })),
        )
        .await;
    let host_id = host["id"].as_str().unwrap().to_string();
    let rule = t.rule(&ds, "Latenz", json!({})).await;
    t.tick().await;
    // A silence on the data label.
    let silence = json!({ "matchers": [{ "label": "host", "op": "=~", "value": "a.*" }],
                          "endsAt": t.now() + 3_600_000, "comment": "Wartung" });
    t.ok(Method::POST, "/alerting/silences", Some(silence)).await;
    let g = t.ok(Method::GET, "/alerting/groups", None).await;
    assert_eq!(g["items"][0]["policyId"], json!(host_id));
    assert_eq!((g["items"][0]["silencedInstances"].as_i64(), &g["items"][0]["dataHidden"]), (Some(1), &json!(false)));
    let r = t.ok(Method::POST, "/alerting/policies/route", Some(json!({ "ruleId": rule }))).await;
    assert_eq!(r["items"][0]["routes"][0]["policyId"], json!(host_id));

    let viewer = t.as_role("viewer").await;
    let r = t.call(&viewer, Method::GET, "/alerting/groups", None).await;
    let group = &r.body["items"][0];
    assert_eq!((&group["labels"], &group["dataHidden"]), (&json!({}), &json!(true)), "{}", r.body);
    // The silence matches the hidden `host`: for this caller it is matched by the rule's name only.
    assert_eq!(group["silencedInstances"], 0, "{}", r.body);
    // The policy was chosen by `host`: it is not named, nor anything that follows from it.
    for field in ["policyId", "nextSendAt", "escalationLevel", "repeats"] {
        assert!(group[field].is_null(), "{field}: {}", r.body);
    }
    assert_eq!(r.body["hiddenGroups"], 1, "{}", r.body);
    let r = t.call(&viewer, Method::GET, &format!("/alerting/groups?policyId={host_id}"), None).await;
    assert_eq!((&r.body["items"], &r.body["hiddenGroups"]), (&json!([]), &json!(1)), "{}", r.body);
    let active = |body: &Value| {
        body["items"].as_array().unwrap().iter().find(|p| p["id"] == json!(host_id)).unwrap()["activeGroups"].clone()
    };
    let r = t.call(&viewer, Method::GET, "/alerting/policies", None).await;
    assert_eq!((active(&r.body), &r.body["hiddenGroups"]), (json!(0), &json!(1)), "{}", r.body);
    let owner = t.ok(Method::GET, "/alerting/policies", None).await;
    assert_eq!((active(&owner), &owner["hiddenGroups"]), (json!(1), &json!(0)), "{owner}");
    let r = t.call(&viewer, Method::GET, &format!("/alerting/policies/{host_id}"), None).await;
    assert_eq!(r.body["activeGroups"], 0, "{}", r.body);
    // Nor do the rule's ways or its deliveries in the history name it.
    let r = t.call(&viewer, Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(r.body["routes"][0]["policyId"], json!(root_id), "{}", r.body);
    let owner_rule = t.ok(Method::GET, &format!("/alerting/rules/{rule}"), None).await;
    assert_eq!(owner_rule["routes"][0]["policyId"], json!(host_id), "{owner_rule}");
    let fake = Fake::default();
    fake.take(&t).await;
    let r = t.call(&viewer, Method::GET, "/alerting/history?kind=delivery", None).await;
    let deliveries = r.body["items"].as_array().unwrap();
    assert!(!deliveries.is_empty(), "{}", r.body);
    assert!(deliveries.iter().all(|e| e["policyId"].is_null() && e["groupId"].is_null()), "{}", r.body);
    let r = t.call(&viewer, Method::POST, "/alerting/policies/route", Some(json!({ "ruleId": rule }))).await;
    let item = &r.body["items"][0];
    assert_eq!(item["dataHidden"], true, "{}", r.body);
    assert_eq!(item["labels"], json!({ "alertname": "Latenz", "team": "lager" }), "{}", r.body);
    assert!(item["fingerprint"].as_str().unwrap().starts_with("hidden-"), "{}", r.body);
    // The way is that of the shown labels: the policy on `host` is not revealed.
    assert_eq!(item["routes"][0]["policyId"], json!(root_id), "{}", r.body);
    t.finish().await;
}

/// Group messages wait in the same queue as rules' messages: over the contact point's cap a new
/// firing is not queued (`queue_full`), but a group's resolves travel in a message of their own
/// and always go.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn group_messages_respect_the_queue_caps_but_their_resolves_go_through() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let cp = t.webhook("Team").await;
    let root = t.root().await;
    let body = json!({
        "name": "Standard", "groupBy": ["alertname"], "groupWaitSecs": 0, "groupIntervalSecs": 300,
        "repeatIntervalSecs": 0, "contactPointIds": [cp], "version": root["version"],
    });
    t.ok(Method::PUT, &format!("/alerting/policies/{}", root["id"].as_str().unwrap()), Some(body)).await;
    t.rule(&ds, "Latenz", json!({})).await;
    let fake = Fake::default();
    t.tick().await;
    assert_eq!(fake.take(&t).await.len(), 1);
    // The contact point has as many messages waiting as it may (not due for a long time).
    for _ in 0..outbox::MAX_PENDING_PER_CONTACT_POINT {
        sqlx::query(
            "INSERT INTO alert_deliveries (id, org_id, rule_id, contact_point_id, event, message, attempts, \
             next_attempt_at, created_at) VALUES ($1, $2, '', $3, 'firing', '{}', 0, $4, $5)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(&t.org)
        .bind(&cp)
        .bind(t.now() + 86_400_000)
        .bind(t.now())
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    // A second rule fires: its group's message is not queued.
    t.rule(&ds, "Fehlerquote", json!({})).await;
    t.clock.advance_ms(MINUTE);
    t.tick().await;
    assert!(fake.take(&t).await.is_empty());
    let full: i64 =
        t.count("SELECT COUNT(*) FROM alert_history WHERE kind = 'delivery' AND result = 'queue_full'").await;
    assert_eq!(full, 1);
    let (stage,): (Option<String>,) = sqlx::query_as("SELECT stage FROM alert_history WHERE result = 'queue_full'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(stage.as_deref(), Some("0"), "recorded as the group's delivery");
    // Both resolve: the resolves are a message of their own each and go despite the full queue.
    t.write("UPDATE m SET v = 1.0").await;
    for _ in 0..6 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    let sent = fake.take(&t).await;
    assert!(!sent.is_empty(), "the resolves go");
    for (_, m) in &sent {
        assert_eq!(m["event"], "resolved", "{m}");
        assert!(m["alerts"].as_array().unwrap().iter().all(|a| a["event"] == "resolved"), "{m}");
    }
    t.finish().await;
}

/// A changed way: the contact point the instance still reaches keeps it (no resolve, no second
/// firing, and later its real resolve); the one it left gets a resolve marked `rerouted`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_changed_way_resolves_only_where_the_instance_is_gone() {
    let mut t = TestApp::new().await;
    let ds = t.source().await;
    let shared = t.webhook("Gemeinsam").await;
    let only_a = t.webhook("Nur A").await;
    let root = t.root().await;
    let root_id = root["id"].as_str().unwrap().to_string();
    let body = json!({
        "name": "Standard", "groupBy": ["alertname"], "groupWaitSecs": 0, "groupIntervalSecs": 300,
        "repeatIntervalSecs": 0, "contactPointIds": [shared], "version": root["version"],
    });
    t.ok(Method::PUT, &format!("/alerting/policies/{root_id}"), Some(body)).await;
    let a = t
        .ok(
            Method::POST,
            "/alerting/policies",
            Some(json!({ "parentId": root_id, "name": "A", "groupWaitSecs": 0,
                         "matchers": [{ "label": "team", "op": "=", "value": "lager" }],
                         "contactPointIds": [shared, only_a] })),
        )
        .await;
    let a_id = a["id"].as_str().unwrap().to_string();
    t.rule(&ds, "Latenz", json!({})).await;
    let fake = Fake::default();
    t.tick().await;
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 2, "{sent:?}");
    // A no longer matches: the instance now ends at the root, which reaches `shared` too.
    let body = json!({ "name": "A", "groupWaitSecs": 0, "matchers": [{ "label": "team", "op": "=", "value": "x" }],
                       "contactPointIds": [shared, only_a], "version": a["version"] });
    t.ok(Method::PUT, &format!("/alerting/policies/{a_id}"), Some(body)).await;
    for _ in 0..6 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].0, only_a);
    assert_eq!(sent[0].1["alerts"][0]["event"], "resolved");
    assert_eq!(sent[0].1["alerts"][0]["reason"], "rerouted");
    // The real resolve reaches `shared` through the root.
    t.write("UPDATE m SET v = 1.0").await;
    for _ in 0..6 {
        t.clock.advance_ms(MINUTE);
        t.tick().await;
    }
    let sent = fake.take(&t).await;
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0].0, shared);
    assert_eq!(sent[0].1["alerts"][0]["event"], "resolved");
    assert!(sent[0].1["alerts"][0]["reason"].is_null());
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policies_are_read_by_viewers_and_changed_by_admins_only() {
    let mut t = TestApp::new().await;
    let viewer = t.as_role("viewer").await;
    let editor = t.as_role("editor").await;
    let root = t.root().await;
    let root_id = root["id"].as_str().unwrap().to_string();
    assert_eq!(root_id, t.org, "the root's id is the organization's");
    let child =
        json!({ "parentId": root_id, "name": "Lager", "matchers": [{ "label": "team", "op": "=", "value": "lager" }] });
    for who in [&viewer, &editor] {
        let r = t.call(who, Method::GET, "/alerting/policies", None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let r = t
            .call(who, Method::POST, "/alerting/policies/route", Some(json!({ "labels": [{ "team": "lager" }] })))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let r = t.call(who, Method::GET, "/alerting/groups", None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let r = t.call(who, Method::POST, "/alerting/policies", Some(child.clone())).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    }
    let lager = t.ok(Method::POST, "/alerting/policies", Some(child.clone())).await;
    let lager_id = lager["id"].as_str().unwrap().to_string();
    for (who, method, rest, body) in [
        (&editor, Method::PUT, format!("/alerting/policies/{lager_id}"), Some(json!({ "name": "x", "version": 1 }))),
        (&editor, Method::DELETE, format!("/alerting/policies/{lager_id}"), None),
        (
            &viewer,
            Method::POST,
            format!("/alerting/policies/{lager_id}/move"),
            Some(json!({ "parentId": root_id, "position": 0 })),
        ),
    ] {
        let r = t.call(who, method, &rest, body).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{rest}: {}", r.body);
    }
    // The root: neither deleted nor moved.
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/alerting/policies/{root_id}"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.policy_root"));
    let r = t
        .call(
            &Who::Owner,
            Method::POST,
            &format!("/alerting/policies/{root_id}/move"),
            Some(json!({ "parentId": lager_id, "position": 0 })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.policy_root"));
    // Moves: below itself is refused, between siblings and levels works and the tree answers.
    let kritisch =
        t.ok(Method::POST, "/alerting/policies", Some(json!({ "parentId": lager_id, "name": "Kritisch" }))).await;
    let kritisch_id = kritisch["id"].as_str().unwrap().to_string();
    let r = t
        .call(
            &Who::Owner,
            Method::POST,
            &format!("/alerting/policies/{lager_id}/move"),
            Some(json!({ "parentId": kritisch_id, "position": 0 })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "alerts.policy_move_invalid"));
    // Siblings have names of their own.
    let r = t
        .call(&Who::Owner, Method::POST, "/alerting/policies", Some(json!({ "parentId": root_id, "name": "lager" })))
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.policy_name_taken"));
    let tree = t
        .ok(
            Method::POST,
            &format!("/alerting/policies/{kritisch_id}/move"),
            Some(json!({ "parentId": root_id, "position": 0 })),
        )
        .await;
    let order: Vec<&str> = tree["items"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(order, ["Standard", "Kritisch", "Lager"]);
    // The route check: first matching child, with the effective values.
    let r = t
        .ok(Method::POST, "/alerting/policies/route", Some(json!({ "labels": [{ "team": "lager" }, { "team": "x" }] })))
        .await;
    assert_eq!(
        r["items"][0]["routes"][0]["policyId"],
        json!(kritisch_id),
        "Kritisch matches everything and comes first"
    );
    // A stale version is a conflict with the stored policy.
    let body = json!({ "name": "Lager 2", "version": 99 });
    let r = t.call(&Who::Owner, Method::PUT, &format!("/alerting/policies/{lager_id}"), Some(body)).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["current"]["name"], "Lager");
    // Every change is audited, without URLs.
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action LIKE 'alert_policy.%'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 3);
    // Deleting a policy takes the ones below it along.
    t.ok(Method::POST, "/alerting/policies", Some(json!({ "parentId": lager_id, "name": "Unter" }))).await;
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/alerting/policies/{lager_id}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    let tree = t.ok(Method::GET, "/alerting/policies", None).await;
    let order: Vec<&str> = tree["items"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(order, ["Standard", "Kritisch"]);

    // Another organization's policies are not found, and ours cannot use its contact points.
    let other = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
        .bind(&other)
        .execute(&t.state.db)
        .await
        .unwrap();
    let foreign_cp = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO alert_contact_points (id, org_id, name, kind, settings, version, created_at, updated_at) \
         VALUES ($1, $2, 'Fremd', 'webhook', '{\"url\":\"https://x.example/\",\"language\":\"de\"}', 1, 0, 0)",
    )
    .bind(&foreign_cp)
    .bind(&other)
    .execute(&t.state.db)
    .await
    .unwrap();
    let foreign_policy = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO alert_policies (id, org_id, parent_id, position, name, matchers, continue_matching, version, \
         created_at, updated_at) VALUES ($1, $2, NULL, 0, 'Fremd', '[]', 0, 1, 0, 0)",
    )
    .bind(&foreign_policy)
    .bind(&other)
    .execute(&t.state.db)
    .await
    .unwrap();
    for (method, rest, body) in [
        (Method::GET, format!("/alerting/policies/{foreign_policy}"), None),
        (Method::PUT, format!("/alerting/policies/{foreign_policy}"), Some(json!({ "name": "x", "version": 1 }))),
        (Method::DELETE, format!("/alerting/policies/{foreign_policy}"), None),
        (
            Method::POST,
            format!("/alerting/policies/{foreign_policy}/move"),
            Some(json!({ "parentId": root_id, "position": 0 })),
        ),
        (Method::POST, "/alerting/policies".to_string(), Some(json!({ "parentId": foreign_policy, "name": "x" }))),
        (
            Method::POST,
            "/alerting/policies".to_string(),
            Some(json!({ "parentId": root_id, "name": "x", "contactPointIds": [foreign_cp] })),
        ),
    ] {
        let r = t.call(&Who::Owner, method.clone(), &rest, body).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {rest}: {}", r.body);
    }
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn contact_points_in_use_by_policies_cannot_be_deleted() {
    let mut t = TestApp::new().await;
    let cp = t.webhook("Team").await;
    let root = t.root().await;
    let body = json!({ "parentId": root["id"], "name": "Lager", "contactPointIds": [cp] });
    t.ok(Method::POST, "/alerting/policies", Some(body)).await;
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.contact_point_in_use"));
    assert_eq!(r.body["error"]["params"]["policies"], "Lager");
    let c = t.ok(Method::GET, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!(c["policies"], 1);
    t.finish().await;
}

/// A receiver that answers 429 with `Retry-After: 12`.
#[expect(clippy::disallowed_methods, reason = "a chat receiver, not an API route")]
async fn busy_receiver() -> (SocketAddr, Arc<Mutex<Vec<(HeaderMap, Bytes)>>>, Arc<AtomicU16>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let status = Arc::new(AtomicU16::new(429));
    let (s, st) = (seen.clone(), status.clone());
    let app = Router::new().route(
        "/hook",
        axum::routing::post(move |headers: HeaderMap, body: Bytes| {
            let (s, st) = (s.clone(), st.clone());
            async move {
                s.lock().unwrap().push((headers, body));
                let code = StatusCode::from_u16(st.load(Ordering::SeqCst)).unwrap();
                (code, [(header::RETRY_AFTER, "12")])
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, seen, status)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn slack_and_teams_keep_their_url_secret_and_respect_retry_after() {
    let mut t = TestApp::new().await;
    // Only https; the URL is never answered, only its host and end.
    let body = json!({ "name": "#lager", "kind": "slack", "language": "de", "url": "http://hooks.slack.com/services/T0/B0/x" });
    let r = t.call(&Who::Owner, Method::POST, "/alerting/contact-points", Some(body)).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "alerts.chat_url_invalid"));
    let body = json!({ "name": "#lager", "kind": "slack", "language": "de", "url": "https://169.254.169.254/latest" });
    let r = t.call(&Who::Owner, Method::POST, "/alerting/contact-points", Some(body)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    let (addr, seen, status) = busy_receiver().await;
    let body = json!({ "name": "#lager", "kind": "slack", "language": "de",
                       "url": format!("https://127.0.0.1:{}/hook/geheim9Qx2", addr.port()) });
    let created = t.ok(Method::POST, "/alerting/contact-points", Some(body)).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["urlEnd"], "9Qx2");
    assert_eq!(created["host"], "127.0.0.1");
    assert!(created.get("url").is_none() && created.get("secret").is_none(), "{created}");
    assert!(!created.to_string().contains("geheim"));
    let stored: String = sqlx::query_scalar("SELECT settings FROM alert_contact_points WHERE id = $1")
        .bind(&id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert!(!stored.contains("geheim"), "the URL is only in the encrypted store: {stored}");
    // A PUT without url keeps it.
    let r = t
        .ok(
            Method::PUT,
            &format!("/alerting/contact-points/{id}"),
            Some(json!({ "name": "#lager-alerts", "kind": "slack", "language": "en", "version": 1 })),
        )
        .await;
    assert_eq!(r["urlEnd"], "9Qx2");
    // Sent over plain http to the local receiver (the stored secret is replaced underneath, since
    // the test has no TLS receiver): 429 with its Retry-After.
    let mut conn = t.state.db.acquire().await.unwrap();
    kalzit::alerting::contact_points::store_secret(
        &mut conn,
        &t.state.secrets,
        &id,
        kalzit::alerting::contact_points::URL_FIELD,
        &format!("http://{addr}/hook"),
    )
    .await
    .unwrap();
    drop(conn);
    let r = t.ok(Method::POST, &format!("/alerting/contact-points/{id}/test"), None).await;
    assert_eq!(r["ok"], false);
    assert_eq!(r["result"], "429");
    assert_eq!(r["retryAfterSecs"], 12);
    let (_, raw) = seen.lock().unwrap().pop().unwrap();
    let body: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(body["blocks"][0]["type"], "header");
    assert_eq!(body["blocks"][0]["text"]["text"], "[Test] Example rule");
    // Accepted the next time.
    status.store(200, Ordering::SeqCst);
    let r = t.ok(Method::POST, &format!("/alerting/contact-points/{id}/test"), None).await;
    assert_eq!(r["ok"], true, "{r}");
    // Teams gets an Adaptive Card.
    let body = json!({ "name": "Vertrieb", "kind": "teams", "language": "en",
                       "url": format!("https://127.0.0.1:{}/hook", addr.port()) });
    let teams = t.ok(Method::POST, "/alerting/contact-points", Some(body)).await;
    let teams_id = teams["id"].as_str().unwrap().to_string();
    let mut conn = t.state.db.acquire().await.unwrap();
    kalzit::alerting::contact_points::store_secret(
        &mut conn,
        &t.state.secrets,
        &teams_id,
        kalzit::alerting::contact_points::URL_FIELD,
        &format!("http://{addr}/hook"),
    )
    .await
    .unwrap();
    drop(conn);
    t.ok(Method::POST, &format!("/alerting/contact-points/{teams_id}/test"), None).await;
    let (_, raw) = seen.lock().unwrap().pop().unwrap();
    let body: Value = serde_json::from_slice(&raw).unwrap();
    assert_eq!(body["attachments"][0]["content"]["type"], "AdaptiveCard");
    // The audit log has the host, never the URL.
    let summaries: Vec<String> =
        sqlx::query_scalar("SELECT CAST(summary AS TEXT) FROM audit_events WHERE action LIKE 'alert_contact_point.%'")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert!(summaries.iter().all(|s| !s.contains("/hook")), "{summaries:?}");
    t.finish().await;
}

/// The update of 0.7.0: rules with contact points become direct, the others go through the
/// policies; every organization gets its root without contact points.
#[tokio::test]
async fn the_update_keeps_rules_with_contact_points_direct() {
    use sqlx::Connection;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("kalzit.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true).foreign_keys(false);
    let mut conn = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut files: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    let (before, after): (Vec<_>, Vec<_>) =
        files.into_iter().partition(|p| p.file_name().unwrap().to_string_lossy().as_ref() < "0047");
    for file in before {
        let sql = std::fs::read_to_string(&file).unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(&mut conn).await.unwrap();
    }
    sqlx::raw_sql(
        "INSERT INTO orgs (id, name, created_at) VALUES ('o', 'MouseWerk', 7); \
         INSERT INTO alert_contact_points (id, org_id, name, kind, settings, version, created_at, updated_at) \
           VALUES ('cp', 'o', 'Team', 'webhook', '{}', 1, 0, 0); \
         INSERT INTO alert_rules (id, org_id, name, description, datasource_id, query, range_secs, reduce, condition, \
           interval_secs, for_secs, no_data_state, error_state, labels, reminder_secs, version, created_at, updated_at) \
           VALUES ('with', 'o', 'Mit', '', 'ds', '{}', 600, '{}', '{}', 60, 0, 'no_data', 'error', '{}', 3600, 1, 0, 0), \
                  ('without', 'o', 'Ohne', '', 'ds', '{}', 600, '{}', '{}', 60, 0, 'no_data', 'error', '{}', 0, 1, 0, 0); \
         INSERT INTO alert_rule_contact_points (rule_id, contact_point_id) VALUES ('with', 'cp');",
    )
    .execute(&mut conn)
    .await
    .unwrap();
    for file in after.iter().filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("0047")) {
        let sql = std::fs::read_to_string(file).unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(&mut conn).await.unwrap();
    }
    let routing: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT id, routing, reminder_secs FROM alert_rules ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
    assert_eq!(routing, [("with".into(), "direct".into(), 3600), ("without".into(), "policies".into(), 0)]);
    let root: (String, String, Option<String>, String, Option<String>, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT id, org_id, parent_id, name, group_by, group_wait_secs, group_interval_secs, repeat_interval_secs, \
         created_at FROM alert_policies",
    )
    .fetch_one(&mut conn)
    .await
    .unwrap();
    assert_eq!(
        root,
        ("o".into(), "o".into(), None, "Standard".into(), Some("[\"alertname\"]".into()), 30, 300, 14400, 7)
    );
    let (links,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM alert_policy_contact_points").fetch_one(&mut conn).await.unwrap();
    assert_eq!(links, 0, "the root starts without contact points");
    conn.close().await.unwrap();
}
