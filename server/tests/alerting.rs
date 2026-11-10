//! Alerting's stored model, rights and validation through the real router (SQLite; PostgreSQL
//! when `KALZIT_TEST_POSTGRES_URL` is set, each app in a throwaway schema). Viewers, editors and
//! admins act through API tokens of service accounts with those roles.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const HOUR_MS: i64 = 3_600_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
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

/// Who calls: the owner's session, or a bearer token.
#[derive(Clone)]
enum Who {
    Owner,
    Token(String),
}

impl TestApp {
    async fn new(mail: bool) -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        if mail {
            config.smtp.host = "127.0.0.1".into();
            config.smtp.port = 2525;
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
        let mut t = TestApp { app, clock, state, dir: Arc::new(dir), org: String::new(), owner: String::new(), schema };
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
        assert!(!t.owner.is_empty());
        t
    }

    async fn finish(mut self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone()).with_schema(self.schema.take());
        drop(self);
        finish.finish().await;
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
        self.clock.advance_ms(1);
        Reply { status, body }
    }

    /// A request to the organization's `rest`.
    async fn call(&mut self, who: &Who, method: Method, rest: &str, body: Option<Value>) -> Reply {
        let path = format!("/api/orgs/{}{rest}", self.org);
        self.raw(method, &path, body, Some(who)).await
    }

    /// A service account with `role` and a token for it.
    async fn as_role(&mut self, role: &str) -> Who {
        let r = self
            .call(
                &Who::Owner,
                Method::POST,
                "/service-accounts",
                Some(json!({ "name": format!("{role}-1"), "role": role })),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let id = r.body["id"].as_str().unwrap().to_string();
        let r = self
            .call(&Who::Owner, Method::POST, &format!("/service-accounts/{id}/tokens"), Some(json!({ "name": "t" })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        Who::Token(r.body["token"].as_str().unwrap().to_string())
    }

    /// A data source in `org`, written directly (it is never queried here).
    async fn datasource(&self, org: &str, name: &str) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
             VALUES ($1, $2, $3, 'prometheus', '{\"url\":\"http://127.0.0.1:9\"}', 0, 0)",
        )
        .bind(&id)
        .bind(org)
        .bind(name)
        .execute(&self.state.db)
        .await
        .unwrap();
        id
    }

    async fn audit_actions(&self) -> Vec<(String, String)> {
        sqlx::query_as("SELECT action, summary FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap()
    }
}

fn rule(datasource: &str) -> Value {
    json!({
        "name": "Lager-API Latenz p95",
        "datasourceId": datasource,
        "query": { "query": { "expr": "up" } },
        "reduce": { "shape": "frame", "function": "last" },
        "condition": { "op": "gt", "value": 1.5 },
        "intervalSecs": 60,
        "forSecs": 300,
        "labels": { "team": "lager" },
    })
}

#[tokio::test]
async fn rights_follow_the_roles() {
    let mut t = TestApp::new(false).await;
    let viewer = t.as_role("viewer").await;
    let editor = t.as_role("editor").await;
    let admin = t.as_role("admin").await;
    let owner = Who::Owner;
    let ds = t.datasource(&t.org.clone(), "Prometheus").await;

    // The opt-in: only whoever may edit the source sets it.
    let optin = format!("/datasources/{ds}/alerting");
    let r = t.call(&editor, Method::PUT, &optin, Some(json!({ "enabled": true }))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // Without the opt-in no rule can be saved.
    let r = t.call(&editor, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.datasource_not_opted_in"), "{}", r.body);
    let r = t.call(&admin, Method::PUT, &optin, Some(json!({ "enabled": true, "maxConcurrent": 1 }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["enabled"].as_bool(), r.body["maxConcurrent"].as_i64()), (Some(true), Some(1)));
    let r = t.call(&editor, Method::GET, &optin, None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // Rules: viewers read, editors write.
    let r = t.call(&viewer, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.call(&editor, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let rule_id = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(r.body["version"], 1);
    assert_eq!(r.body["reminderSecs"], 14400);
    let r = t.call(&viewer, Method::GET, "/alerting/rules", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["items"][0]["id"], rule_id.as_str());
    let r = t.call(&viewer, Method::GET, &format!("/alerting/rules/{rule_id}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["instances"].as_array().unwrap().is_empty());
    for (method, rest) in [
        (Method::DELETE, format!("/alerting/rules/{rule_id}")),
        (Method::POST, format!("/alerting/rules/{rule_id}/pause")),
    ] {
        let r = t.call(&viewer, method, &rest, None).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{rest}");
    }
    let r = t.call(&editor, Method::POST, &format!("/alerting/rules/{rule_id}/pause"), None).await;
    assert_eq!((r.status, r.body["paused"].as_bool()), (StatusCode::OK, Some(true)), "{}", r.body);
    let r = t.call(&editor, Method::POST, &format!("/alerting/rules/{rule_id}/resume"), None).await;
    assert_eq!((r.status, r.body["paused"].as_bool()), (StatusCode::OK, Some(false)), "{}", r.body);

    // Contact points: only admins manage them; editors and viewers see the short form.
    let hook = json!({ "name": "Lager-Webhook", "kind": "webhook", "url": "https://hooks.lager.example/kalzit?k=1" });
    let r = t.call(&editor, Method::POST, "/alerting/contact-points", Some(hook.clone())).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.call(&admin, Method::POST, "/alerting/contact-points", Some(hook)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let cp = r.body["id"].as_str().unwrap().to_string();
    let secret = r.body["secret"].as_str().unwrap().to_string();
    assert_eq!(secret.len(), 64);
    assert_eq!(r.body["url"], "https://hooks.lager.example/kalzit?k=1");
    let r = t.call(&viewer, Method::GET, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["details"].as_bool(), r.body["host"].as_str()), (Some(false), Some("hooks.lager.example")));
    assert!(r.body.get("url").is_none() && r.body.get("secret").is_none(), "{}", r.body);
    for (method, rest) in [
        (Method::POST, format!("/alerting/contact-points/{cp}/secret")),
        (Method::DELETE, format!("/alerting/contact-points/{cp}")),
    ] {
        let r = t.call(&editor, method, &rest, None).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{rest}");
    }
    let r = t.call(&owner, Method::POST, &format!("/alerting/contact-points/{cp}/secret"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_ne!(r.body["secret"].as_str().unwrap(), secret);
    assert_eq!(r.body["previousSecretUntil"].as_i64().unwrap() - t.clock_now(), 24 * HOUR_MS - 1);
    // Both secrets sign for a day, then only the new one.
    let now = t.clock_now();
    let signing =
        kalzit::alerting::contact_points::signing_secrets(&t.state.db, &t.state.secrets, &cp, now).await.unwrap();
    assert_eq!(signing.len(), 2);
    assert_eq!(*signing[1], secret);
    let later =
        kalzit::alerting::contact_points::signing_secrets(&t.state.db, &t.state.secrets, &cp, now + 25 * HOUR_MS)
            .await
            .unwrap();
    assert_eq!(later.len(), 1);

    // An editor's rule notifies an existing contact point; it cannot be deleted while in use.
    let mut with_cp = rule(&ds);
    with_cp["contactPointIds"] = json!([cp]);
    with_cp["version"] = json!(3);
    let r = t.call(&editor, Method::PUT, &format!("/alerting/rules/{rule_id}"), Some(with_cp.clone())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["version"], 4);
    // A stale version answers the stored rule.
    let r = t.call(&editor, Method::PUT, &format!("/alerting/rules/{rule_id}"), Some(with_cp)).await;
    assert_eq!((r.status, r.body["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("version_conflict")));
    assert_eq!(r.body["current"]["version"], 4, "{}", r.body);
    let r = t.call(&admin, Method::DELETE, &format!("/alerting/contact-points/{cp}"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.contact_point_in_use"));

    // Silences: viewers read, editors create and end.
    let silence = json!({ "matchers": [{ "label": "team", "op": "=", "value": "lager" }],
                          "endsAt": t.clock_now() + HOUR_MS, "comment": "Umzug Rechenzentrum" });
    let r = t.call(&viewer, Method::POST, "/alerting/silences", Some(silence.clone())).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.call(&editor, Method::POST, "/alerting/silences", Some(silence)).await;
    assert_eq!((r.status, r.body["status"].as_str()), (StatusCode::CREATED, Some("active")), "{}", r.body);
    let silence_id = r.body["id"].as_str().unwrap().to_string();
    let r = t.call(&viewer, Method::GET, "/alerting/silences?status=active", None).await;
    assert_eq!(r.body["items"].as_array().unwrap().len(), 1, "{}", r.body);
    let r = t.call(&editor, Method::POST, &format!("/alerting/silences/{silence_id}/expire"), None).await;
    assert_eq!((r.status, r.body["status"].as_str()), (StatusCode::OK, Some("expired")), "{}", r.body);
    let r = t.call(&editor, Method::POST, &format!("/alerting/silences/{silence_id}/expire"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.silence_ended"));

    // History and status for viewers.
    let r = t.call(&viewer, Method::GET, "/alerting/history?label=team=lager", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&viewer, Method::GET, "/alerting/status", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["limits"]["minIntervalSecs"], 30);
    assert_eq!(r.body["serviceAccount"]["permissions"], json!(["datasources:query"]));
    assert_eq!(r.body["rules"], 1);

    // Delete as an editor; every change was audited, never with the secret or the URL path.
    let r = t.call(&editor, Method::DELETE, &format!("/alerting/rules/{rule_id}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let audit = t.audit_actions().await;
    let actions: Vec<&str> = audit
        .iter()
        .map(|(a, _)| a.as_str())
        .filter(|a| a.starts_with("alert") || a.starts_with("datasource.alerting"))
        .collect();
    assert_eq!(
        actions,
        [
            "datasource.alerting_changed",
            "alert_rule.created",
            "alert_rule.paused",
            "alert_rule.resumed",
            "alert_contact_point.created",
            "alert_contact_point.secret_rotated",
            "alert_rule.updated",
            "alert_silence.created",
            "alert_silence.expired",
            "alert_rule.deleted",
        ]
    );
    for (_, summary) in &audit {
        assert!(!summary.contains(&secret) && !summary.contains("/kalzit"), "{summary}");
    }
    t.finish().await;
}

impl TestApp {
    fn clock_now(&self) -> i64 {
        use kalzit::clock::Clock;
        self.clock.now_ms()
    }
}

#[tokio::test]
async fn nothing_crosses_organizations() {
    let mut t = TestApp::new(false).await;
    let owner = Who::Owner;
    let other = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
        .bind(&other)
        .execute(&t.state.db)
        .await
        .unwrap();
    let foreign_ds = t.datasource(&other, "Fremd").await;
    sqlx::query("UPDATE datasources SET alerting_enabled = 1").execute(&t.state.db).await.unwrap();
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
    let foreign_rule = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO alert_rules (id, org_id, name, description, datasource_id, query, range_secs, reduce, condition, \
         interval_secs, for_secs, no_data_state, error_state, labels, reminder_secs, version, created_at, updated_at) \
         VALUES ($1, $2, 'Fremd', '', $3, '{}', 600, '{}', '{}', 60, 0, 'no_data', 'error', '{}', 0, 1, 0, 0)",
    )
    .bind(&foreign_rule)
    .bind(&other)
    .bind(&foreign_ds)
    .execute(&t.state.db)
    .await
    .unwrap();
    let foreign_silence = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO alert_silences (id, org_id, matchers, starts_at, ends_at, comment, created_at) \
         VALUES ($1, $2, '[]', 0, 9000000000000, 'x', 0)",
    )
    .bind(&foreign_silence)
    .bind(&other)
    .execute(&t.state.db)
    .await
    .unwrap();

    // Another organization's ids through our organization: not found.
    for (method, rest, body) in [
        (Method::GET, format!("/alerting/rules/{foreign_rule}"), None),
        (
            Method::PUT,
            format!("/alerting/rules/{foreign_rule}"),
            Some({
                let mut b = rule(&foreign_ds);
                b["version"] = json!(1);
                b
            }),
        ),
        (Method::DELETE, format!("/alerting/rules/{foreign_rule}"), None),
        (Method::POST, format!("/alerting/rules/{foreign_rule}/pause"), None),
        (Method::GET, format!("/alerting/contact-points/{foreign_cp}"), None),
        (Method::DELETE, format!("/alerting/contact-points/{foreign_cp}"), None),
        (Method::POST, format!("/alerting/contact-points/{foreign_cp}/secret"), None),
        (Method::POST, format!("/alerting/silences/{foreign_silence}/expire"), None),
        (Method::GET, format!("/datasources/{foreign_ds}/alerting"), None),
        (Method::PUT, format!("/datasources/{foreign_ds}/alerting"), Some(json!({ "enabled": false }))),
        (Method::POST, "/alerting/rules".to_string(), Some(rule(&foreign_ds))),
    ] {
        let r = t.call(&owner, method.clone(), &rest, body).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {rest}: {}", r.body);
    }
    // A rule of ours cannot notify their contact point.
    let ds = t.datasource(&t.org.clone(), "Eigen").await;
    sqlx::query("UPDATE datasources SET alerting_enabled = 1").execute(&t.state.db).await.unwrap();
    let mut body = rule(&ds);
    body["contactPointIds"] = json!([foreign_cp]);
    let r = t.call(&owner, Method::POST, "/alerting/rules", Some(body)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    // Lists hold only our own.
    for rest in ["/alerting/rules", "/alerting/contact-points", "/alerting/silences", "/alerting/datasources"] {
        let r = t.call(&owner, Method::GET, rest, None).await;
        assert_eq!(r.status, StatusCode::OK, "{rest}: {}", r.body);
        let text = r.body.to_string();
        assert!(
            !text.contains(&foreign_rule) && !text.contains(&foreign_cp) && !text.contains(&foreign_ds),
            "{rest}: {text}"
        );
    }
    // Their organization's routes: not a member.
    let r = t.raw(Method::GET, &format!("/api/orgs/{other}/alerting/rules"), None, Some(&owner)).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    t.finish().await;
}

#[tokio::test]
async fn rules_silences_and_contact_points_are_validated() {
    let mut t = TestApp::new(false).await;
    let owner = Who::Owner;
    let ds = t.datasource(&t.org.clone(), "Prometheus").await;
    let r = t.call(&owner, Method::PUT, &format!("/datasources/{ds}/alerting"), Some(json!({ "enabled": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let with = |key: &str, value: Value| {
        let mut b = rule(&ds);
        b[key] = value;
        b
    };
    for (body, field, reason) in [
        (with("intervalSecs", json!(10)), "intervalSecs", "alerts.interval_invalid"),
        (with("forSecs", json!(90)), "forSecs", "alerts.for_invalid"),
        (with("forSecs", json!(90_000)), "forSecs", "alerts.for_invalid"),
        (with("rangeSecs", json!(0)), "rangeSecs", "alerts.range_invalid"),
        (
            with("reduce", json!({ "shape": "graph", "count": "paths", "label": "X" })),
            "reduce",
            "alerts.reduce_invalid",
        ),
        (
            with("reduce", json!({ "shape": "documents", "mode": "field", "path": "a", "function": "max" })),
            "reduce",
            "alerts.reduce_path_invalid",
        ),
        (with("condition", json!({ "op": "inside", "low": 2, "high": 1 })), "condition", "alerts.condition_invalid"),
        (with("noDataState", json!("alarm")), "noDataState", "alerts.state_option_invalid"),
        (with("errorState", json!("ok")), "errorState", "alerts.state_option_invalid"),
        (with("labels", json!({ "alertname": "x" })), "labels", "alerts.labels_invalid"),
        (with("reminderSecs", json!(5)), "reminderSecs", "alerts.reminder_invalid"),
        (with("runbookUrl", json!("ftp://x.example")), "runbookUrl", "alerts.runbook_url_invalid"),
        (with("panelId", json!("p1")), "panelId", "alerts.panel_invalid"),
        (with("query", json!({ "query": null })), "query", "alerts.query_invalid"),
        (
            with("contactPointIds", json!(["a", "b", "c", "d", "e", "f"])),
            "contactPointIds",
            "alerts.too_many_contact_points",
        ),
        (with("version", json!(1)), "version", "alerts.version_unexpected"),
    ] {
        let r = t.call(&owner, Method::POST, "/alerting/rules", Some(body.clone())).await;
        assert_eq!(
            (r.status, r.body["error"]["field"].as_str(), r.reason()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some(field), reason),
            "{body}: {}",
            r.body
        );
    }
    // Unknown fields are refused.
    let r = t.call(&owner, Method::POST, "/alerting/rules", Some(with("paused", json!(true)))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);

    // An organization can raise the shortest interval and lower the number of rules, not the reverse.
    let r = t
        .call(
            &owner,
            Method::PATCH,
            "/settings/alerting.min_interval_secs",
            Some(json!({ "value": 120, "version": 0 })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t
        .call(&owner, Method::PATCH, "/settings/alerting.max_rules_per_org", Some(json!({ "value": 1, "version": 0 })))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t
        .call(
            &owner,
            Method::PATCH,
            "/settings/alerting.max_instances_per_rule",
            Some(json!({ "value": 5000, "version": 0 })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&owner, Method::GET, "/alerting/status", None).await;
    assert_eq!(r.body["limits"]["minIntervalSecs"], 120, "{}", r.body);
    assert_eq!(r.body["limits"]["maxRulesPerOrg"], 1);
    assert_eq!(r.body["limits"]["maxInstancesPerRule"], 100, "a higher organization value has no effect");
    let r = t.call(&owner, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!(r.reason(), "alerts.interval_invalid", "{}", r.body);
    let mut ok = with("intervalSecs", json!(120));
    ok["forSecs"] = json!(240);
    let r = t.call(&owner, Method::POST, "/alerting/rules", Some(ok.clone())).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let r = t
        .call(
            &owner,
            Method::POST,
            "/alerting/rules",
            Some({
                let mut b = ok.clone();
                b["forSecs"] = json!(240);
                b
            }),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.too_many_rules"), "{}", r.body);
    let audit = t.audit_actions().await;
    assert!(audit.iter().any(|(a, s)| a == "alerting.settings_changed" && s.contains("alerting.max_rules_per_org")));

    // Silences.
    let now = t.clock_now();
    let m = json!([{ "label": "team", "op": "=", "value": "lager" }]);
    for (body, reason) in [
        (json!({ "matchers": [], "endsAt": now + HOUR_MS, "comment": "x" }), "alerts.matchers_invalid"),
        (
            json!({ "matchers": [{ "label": "team", "op": "=~", "value": "(" }], "endsAt": now + HOUR_MS, "comment": "x" }),
            "alerts.matcher_regex_invalid",
        ),
        (json!({ "matchers": m, "endsAt": now - 1, "comment": "x" }), "alerts.silence_window_invalid"),
        (json!({ "matchers": m, "endsAt": now + 91 * 24 * HOUR_MS, "comment": "x" }), "alerts.silence_window_invalid"),
        (
            json!({ "matchers": m, "startsAt": now - 24 * HOUR_MS, "endsAt": now + HOUR_MS, "comment": "x" }),
            "alerts.silence_window_invalid",
        ),
        (json!({ "matchers": m, "endsAt": now + HOUR_MS, "comment": "  " }), "alerts.comment_required"),
    ] {
        let r = t.call(&owner, Method::POST, "/alerting/silences", Some(body.clone())).await;
        assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, reason), "{body}: {}", r.body);
    }

    // Contact points: without a mail server no mail contact point; webhook targets are checked.
    let r = t
        .call(
            &owner,
            Method::POST,
            "/alerting/contact-points",
            Some(json!({ "name": "Mail", "kind": "mail", "recipients": ["a@example.de"] })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.mail_not_configured"), "{}", r.body);
    for (body, reason) in [
        (json!({ "name": "W", "kind": "webhook", "url": "ftp://x.example/" }), "alerts.webhook_url_invalid"),
        (json!({ "name": "W", "kind": "webhook", "url": "https://u:p@x.example/" }), "alerts.webhook_url_invalid"),
        (json!({ "name": "W", "kind": "webhook" }), "alerts.webhook_url_invalid"),
        (json!({ "name": "W", "kind": "sms" }), "alerts.kind_invalid"),
        (
            json!({ "name": "W", "kind": "webhook", "url": "https://x.example/", "language": "fr" }),
            "alerts.language_invalid",
        ),
        (json!({ "name": "W", "kind": "webhook", "url": "http://169.254.169.254/latest" }), "target.metadata"),
    ] {
        let r = t.call(&owner, Method::POST, "/alerting/contact-points", Some(body.clone())).await;
        assert!(r.status.is_client_error(), "{body}: {}", r.body);
        if reason != "target.metadata" {
            assert_eq!(r.reason(), reason, "{body}: {}", r.body);
        } else {
            assert_eq!(r.body["error"]["code"], "datasource_target_blocked", "{}", r.body);
        }
    }
    let r = t
        .call(
            &owner,
            Method::POST,
            "/alerting/contact-points",
            Some(json!({ "name": "W", "kind": "webhook", "url": "http://10.0.0.5/hook" })),
        )
        .await;
    assert_eq!((r.status, r.body["insecure"].as_bool()), (StatusCode::CREATED, Some(true)), "{}", r.body);
    let cp = r.body["id"].as_str().unwrap().to_string();
    // A change based on an older version answers the stored contact point.
    let change = json!({ "name": "W2", "kind": "webhook", "url": "https://hooks.example/a", "version": 1 });
    let r = t.call(&owner, Method::PUT, &format!("/alerting/contact-points/{cp}"), Some(change.clone())).await;
    assert_eq!((r.status, r.body["version"].as_i64()), (StatusCode::OK, Some(2)), "{}", r.body);
    let r = t.call(&owner, Method::PUT, &format!("/alerting/contact-points/{cp}"), Some(change)).await;
    assert_eq!((r.status, r.body["error"]["code"].as_str()), (StatusCode::CONFLICT, Some("version_conflict")));
    assert_eq!((r.body["current"]["version"].as_i64(), r.body["current"]["name"].as_str()), (Some(2), Some("W2")));
    let r = t
        .call(
            &owner,
            Method::PUT,
            &format!("/alerting/contact-points/{cp}"),
            Some(json!({ "name": "W2", "kind": "mail", "recipients": ["a@example.de"], "version": 2 })),
        )
        .await;
    assert_eq!(r.reason(), "alerts.kind_invalid", "{}", r.body);
    let r = t
        .call(
            &owner,
            Method::POST,
            "/alerting/contact-points",
            Some(json!({ "name": "W2", "kind": "webhook", "url": "https://x.example/" })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.contact_point_name_taken"), "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn mail_contact_points_show_shortened_recipients_to_editors() {
    let mut t = TestApp::new(true).await;
    let editor = t.as_role("editor").await;
    let r = t
        .call(
            &Who::Owner,
            Method::POST,
            "/alerting/contact-points",
            Some(json!({ "name": "Bereitschaft Lager", "kind": "mail", "language": "en",
                         "recipients": ["J.Berger@Mousewerk.test", "j.berger@mousewerk.test", "m.yilmaz@mousewerk.test"] })),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["recipients"], json!(["j.berger@mousewerk.test", "m.yilmaz@mousewerk.test"]));
    assert!(r.body.get("secret").is_none());
    let id = r.body["id"].as_str().unwrap().to_string();
    let r = t.call(&editor, Method::GET, "/alerting/contact-points", None).await;
    assert_eq!(r.body["items"][0]["recipients"], json!(["j…@mousewerk.test", "m…@mousewerk.test"]), "{}", r.body);
    let r = t.call(&Who::Owner, Method::POST, &format!("/alerting/contact-points/{id}/secret"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.not_a_webhook"));
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/alerting/contact-points/{id}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    for (_, summary) in t.audit_actions().await {
        assert!(!summary.contains("berger@") && !summary.contains("yilmaz@"), "{summary}");
    }
    t.finish().await;
}

#[tokio::test]
async fn the_alerting_identity_is_fixed() {
    let mut t = TestApp::new(false).await;
    let owner = Who::Owner;
    // Reading the status makes nothing; the first opt-in makes the identity.
    let r = t.call(&owner, Method::GET, "/alerting/status", None).await;
    assert_eq!((r.status, r.body["serviceAccount"].is_null()), (StatusCode::OK, true), "{}", r.body);
    let ds = t.datasource(&t.org.clone(), "Prometheus").await;
    let optin = format!("/datasources/{ds}/alerting");
    let r = t.call(&owner, Method::PUT, &optin, Some(json!({ "enabled": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&owner, Method::GET, "/alerting/status", None).await;
    let id = r.body["serviceAccount"]["id"].as_str().unwrap().to_string();
    assert_eq!(r.body["serviceAccount"]["permissions"], json!(["datasources:query"]));
    let (kind, members): (String, i64) = sqlx::query_as(
        "SELECT a.kind, (SELECT COUNT(*) FROM org_members m WHERE m.user_id = a.id) FROM service_accounts a WHERE a.id = $1",
    )
    .bind(&id)
    .fetch_one(&t.state.db)
    .await
    .unwrap();
    assert_eq!((kind.as_str(), members), ("alerting", 0), "no membership, so no role");

    // Not listed, not changed, not deleted, no tokens.
    let r = t.call(&owner, Method::GET, "/service-accounts", None).await;
    assert!(!r.body.to_string().contains(&id), "{}", r.body);
    for (method, rest, body) in [
        (Method::GET, format!("/service-accounts/{id}"), None),
        (Method::PATCH, format!("/service-accounts/{id}"), Some(json!({ "role": "admin" }))),
        (Method::DELETE, format!("/service-accounts/{id}"), None),
        (Method::POST, format!("/service-accounts/{id}/tokens"), Some(json!({ "name": "x" }))),
        (Method::PATCH, format!("/members/{id}"), Some(json!({ "role": "admin" }))),
    ] {
        let r = t.call(&owner, method.clone(), &rest, body).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{method} {rest}: {}", r.body);
    }
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM api_tokens WHERE service_account_id = $1")
        .bind(&id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    // It cannot sign in.
    let (email,): (String,) =
        sqlx::query_as("SELECT email FROM users WHERE id = $1").bind(&id).fetch_one(&t.state.db).await.unwrap();
    let r = t.raw(Method::POST, "/api/auth/login", Some(json!({ "email": email, "password": PASSWORD })), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Its only right is querying, and its context exists only for sources opted in.
    use kalzit::alerting::service_account::{Identity, context_for_source};
    let identity = Identity { id: id.clone(), name: "Alerting".into() };
    let ctx = context_for_source(&t.state.db, &identity, &t.org, &ds, 0).await.unwrap();
    assert_eq!(ctx.permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>(), ["datasources:query"]);
    let r = t.call(&owner, Method::PUT, &optin, Some(json!({ "enabled": false }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let err = context_for_source(&t.state.db, &identity, &t.org, &ds, 0).await.unwrap_err();
    assert_eq!(err.code, "conflict");
    let other = t.datasource(&t.org.clone(), "Andere").await;
    assert!(context_for_source(&t.state.db, &identity, &t.org, &other, 0).await.is_err());
    let r = t.call(&owner, Method::PUT, &optin, Some(json!({ "enabled": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (accounts,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM service_accounts WHERE org_id = $1 AND kind = 'alerting'")
            .bind(&t.org)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(accounts, 1);
    t.finish().await;
}

/// Changing a stored rule needs the right to query the source it uses now; `alerts:write` alone
/// is not enough. Viewers see rules without their query.
#[tokio::test]
async fn changing_a_rule_needs_its_current_source() {
    let mut t = TestApp::new(false).await;
    let owner = Who::Owner;
    let ds = t.datasource(&t.org.clone(), "Prometheus").await;
    let r = t.call(&owner, Method::PUT, &format!("/datasources/{ds}/alerting"), Some(json!({ "enabled": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&owner, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let rule_id = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(r.body["queryHidden"], false);

    let viewer = t.as_role("viewer").await;
    let r = t.call(&viewer, Method::GET, &format!("/alerting/rules/{rule_id}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["query"].is_null(), r.body["queryHidden"].as_bool()), (true, Some(true)), "{}", r.body);
    let r = t.call(&viewer, Method::GET, "/alerting/rules", None).await;
    assert!(r.body["items"][0]["query"].is_null(), "{}", r.body);

    let r = t
        .call(
            &owner,
            Method::POST,
            "/roles",
            Some(json!({ "name": "Alarmpflege", "description": "", "permissions": ["alerts:read", "alerts:write"] })),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let role = r.body["id"].as_str().unwrap().to_string();
    let custom = t.as_role(&role).await;
    let r = t.call(&custom, Method::GET, &format!("/alerting/rules/{rule_id}"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let mut body = rule(&ds);
    body["version"] = json!(1);
    for (method, rest, body) in [
        (Method::PUT, format!("/alerting/rules/{rule_id}"), Some(body)),
        (Method::POST, format!("/alerting/rules/{rule_id}/pause"), None),
        (Method::POST, format!("/alerting/rules/{rule_id}/resume"), None),
        (Method::DELETE, format!("/alerting/rules/{rule_id}"), None),
    ] {
        let r = t.call(&custom, method.clone(), &rest, body).await;
        assert_eq!(
            (r.status, r.reason()),
            (StatusCode::FORBIDDEN, "alerts.datasource_forbidden"),
            "{method} {rest}: {}",
            r.body
        );
    }
    // A new rule on a source the role cannot even see: not found, as for every hidden source.
    let r = t.call(&custom, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    let r = t.call(&owner, Method::GET, &format!("/alerting/rules/{rule_id}"), None).await;
    assert_eq!((r.body["version"].as_i64(), r.body["paused"].as_bool()), (Some(1), Some(false)), "{}", r.body);
    t.finish().await;
}

/// A data source with alert rules stays in the trash; its rules are never deleted with it.
#[tokio::test]
async fn a_source_with_rules_is_not_purged() {
    let mut t = TestApp::new(false).await;
    let owner = Who::Owner;
    let ds = t.datasource(&t.org.clone(), "Prometheus").await;
    let r = t.call(&owner, Method::PUT, &format!("/datasources/{ds}/alerting"), Some(json!({ "enabled": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&owner, Method::POST, "/alerting/rules", Some(rule(&ds))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let rule_id = r.body["id"].as_str().unwrap().to_string();
    let r = t.call(&owner, Method::DELETE, &format!("/datasources/{ds}"), None).await;
    assert!(r.status.is_success(), "{}", r.body);
    let r = t.call(&owner, Method::DELETE, &format!("/datasources/{ds}/purge"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "datasource.in_use"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["alertRules"], "1", "{}", r.body);
    // The automatic purge after the trash days leaves it too (the session has expired by then,
    // so the database answers).
    t.clock.advance_ms(31 * 24 * HOUR_MS);
    assert_eq!(kalzit::routes::datasources::purge_expired(&t.state).await.unwrap(), 0);
    let count = |sql: &'static str| {
        let db = t.state.db.clone();
        async move { sqlx::query_as::<_, (i64,)>(sql).fetch_one(&db).await.unwrap().0 }
    };
    assert_eq!(count("SELECT COUNT(*) FROM alert_rules").await, 1);
    // Without the rule it goes.
    sqlx::query("DELETE FROM alert_rules WHERE id = $1").bind(&rule_id).execute(&t.state.db).await.unwrap();
    assert_eq!(kalzit::routes::datasources::purge_expired(&t.state).await.unwrap(), 1);
    assert_eq!(count("SELECT COUNT(*) FROM datasources").await, 0);
    t.finish().await;
}

/// Silences: at most the organization's limit of active and planned ones; ended ones leave with
/// the retention.
#[tokio::test]
async fn silences_are_limited_and_expire_with_the_retention() {
    let mut t = TestApp::new(false).await;
    let owner = Who::Owner;
    let r = t
        .call(
            &owner,
            Method::PATCH,
            "/settings/alerting.max_silences_per_org",
            Some(json!({ "value": 1, "version": 0 })),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let body = |t: &TestApp| {
        json!({ "matchers": [{ "label": "team", "op": "=~", "value": "lag.*" }],
                "endsAt": t.clock_now() + HOUR_MS, "comment": "Wartung" })
    };
    let r = t.call(&owner, Method::POST, "/alerting/silences", Some(body(&t))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let first = r.body["id"].as_str().unwrap().to_string();
    let r = t.call(&owner, Method::POST, "/alerting/silences", Some(body(&t))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "alerts.too_many_silences"), "{}", r.body);
    let r = t.call(&owner, Method::POST, &format!("/alerting/silences/{first}/expire"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.call(&owner, Method::POST, "/alerting/silences", Some(body(&t))).await;
    assert_eq!(r.status, StatusCode::CREATED, "an ended silence does not count: {}", r.body);
    // After the retention the ended silence is deleted, the active one too once it ended.
    t.clock.advance_ms(91 * 24 * HOUR_MS);
    assert_eq!(kalzit::alerting::history::purge_expired(&t.state).await.unwrap(), 2);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_silences").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(left, 0);
    t.finish().await;
}

#[tokio::test]
async fn history_is_kept_for_the_retention_only() {
    let mut t = TestApp::new(false).await;
    let now = t.clock_now();
    for (i, at) in [now - 100 * 24 * HOUR_MS, now - HOUR_MS].into_iter().enumerate() {
        sqlx::query(
            "INSERT INTO alert_history (id, org_id, rule_id, rule_name, fingerprint, labels, kind, from_state, to_state, at) \
             VALUES ($1, $2, 'r', 'Regel', 'f', '{\"team\":\"lager\"}', 'transition', 'ok', 'firing', $3)",
        )
        .bind(format!("h{i}"))
        .bind(&t.org)
        .bind(at)
        .execute(&t.state.db)
        .await
        .unwrap();
    }
    let r = t.call(&Who::Owner, Method::GET, "/alerting/history?state=firing&label=team%3Dlager", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["items"].as_array().unwrap().len(), 1, "the old entry is past 90 days: {}", r.body);
    let r = t.call(&Who::Owner, Method::GET, "/alerting/history?label=team%3Dversand", None).await;
    assert!(r.body["items"].as_array().unwrap().is_empty(), "{}", r.body);
    assert_eq!(kalzit::alerting::history::purge_expired(&t.state).await.unwrap(), 1);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_history").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(left, 1);
    t.finish().await;
}
