//! The second factor through the real router: sign-in with each factor, the half-signed-in state
//! that reaches no API, lockout, forced setup, policies of the server and organizations, fresh
//! confirmations and an admin's reset. Passkeys run against a software authenticator (P-256,
//! "none" attestation) built here.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::auth::totp;
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const HOST: &str = "kalzit.test";
const ORIGIN: &str = "http://kalzit.test";

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    /// The `name=value` of the cookie `name` this answer sets, if any.
    fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap().to_string())
            .find(|pair| pair.starts_with(&format!("{name}=")) && pair.len() > name.len() + 1)
    }
}

/// The cookies of one browser.
#[derive(Clone, Default)]
struct Browser {
    session: Option<String>,
    pending: Option<String>,
}

impl Browser {
    fn header(&self) -> String {
        [self.session.clone(), self.pending.clone()].into_iter().flatten().collect::<Vec<_>>().join("; ")
    }
}

async fn test_app() -> TestApp {
    test_app_on(None).await
}

/// An app on a schema of its own in the PostgreSQL database at `base`.
async fn postgres_app(base: &str) -> TestApp {
    let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
    sqlx::any::install_default_drivers();
    let admin_pool = sqlx::AnyPool::connect(base).await.unwrap();
    // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin_pool).await.unwrap();
    admin_pool.close().await;
    let sep = if base.contains('?') { '&' } else { '?' };
    test_app_on(Some(format!("{base}{sep}options=-csearch_path%3D{schema}"))).await
}

async fn test_app_on(db_url: Option<String>) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    // A moment 15 seconds into a TOTP step, so a few requests stay within it.
    let clock = Arc::new(ManualClock::new(1_800_000_015_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), clock, state, dir: Arc::new(dir) }
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, who: &Browser) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, HOST).header("origin", ORIGIN);
        let cookies = who.header();
        if !cookies.is_empty() {
            req = req.header(header::COOKIE, cookies);
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
        self.clock.advance_ms(1);
        Reply { status, headers, body }
    }

    async fn get(&self, path: &str, who: &Browser) -> Reply {
        self.send(Method::GET, path, None, who).await
    }

    async fn post(&self, path: &str, body: Value, who: &Browser) -> Reply {
        self.send(Method::POST, path, Some(body), who).await
    }

    /// The owner (also server admin) and the id of their organization.
    async fn setup(&self) -> (Browser, String) {
        let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                           "email": "joerg@example.de", "password": PASSWORD });
        let r = self.post("/api/setup", body, &Browser::default()).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let browser = Browser { session: r.cookie("kalzit_session"), pending: None };
        (browser, r.body["orgs"][0]["id"].as_str().unwrap().into())
    }

    /// The first step of a sign-in: a session, or the half-signed-in state with its prompt.
    async fn password(&self, email: &str) -> (Browser, Reply) {
        let r =
            self.post("/api/auth/login", json!({ "email": email, "password": PASSWORD }), &Browser::default()).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let browser = Browser { session: r.cookie("kalzit_session"), pending: r.cookie("kalzit_pending") };
        (browser, r)
    }

    async fn member(&self, owner: &Browser, org: &str, email: &str, role: &str) -> Browser {
        let r =
            self.post("/api/admin/users", json!({ "name": email, "email": email, "password": PASSWORD }), owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let r = self.post(&format!("/api/orgs/{org}/members"), json!({ "email": email, "role": role }), owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let (browser, r) = self.password(email).await;
        assert!(r.body["id"].is_string(), "{}", r.body);
        browser
    }

    /// Sets up the app for the signed-in `who`; answers the key and the recovery codes.
    async fn enroll_totp(&self, who: &Browser) -> (Vec<u8>, Vec<String>) {
        let r = self.post("/api/me/security/totp/setup", json!({}), who).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let secret = totp::decode_secret(&r.body["secret"].as_str().unwrap().replace(' ', "")).unwrap();
        assert!(r.body["uri"].as_str().unwrap().starts_with("otpauth://totp/"));
        assert!(r.body["qr"]["path"].as_str().unwrap().starts_with('M'));
        let r = self.post("/api/me/security/totp", json!({ "code": self.code(&secret) }), who).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let codes =
            r.body["recoveryCodes"].as_array().map(|a| a.iter().map(|c| c.as_str().unwrap().to_string()).collect());
        // The code that confirmed the key is used; the next sign-in needs the next step.
        self.next_step();
        (secret, codes.unwrap_or_default())
    }

    fn code(&self, secret: &[u8]) -> String {
        totp::code_at(secret, totp::step_at(self.clock.now_ms()))
    }

    fn next_step(&self) {
        self.clock.advance_ms(totp::STEP_SECS * 1000);
    }

    async fn put_setting(&self, admin: &Browser, path: &str, value: Value) -> Reply {
        self.send(Method::PATCH, path, Some(json!({ "value": value, "version": 0 })), admin).await
    }

    async fn audit_actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }
}

/// Completes a sign-in's second step; answers the signed-in browser.
async fn second_step(t: &TestApp, pending: &Browser, proof: Value) -> (Browser, Reply) {
    let r = t.post("/api/auth/second-factor", proof, pending).await;
    let browser = Browser { session: r.cookie("kalzit_session"), pending: None };
    (browser, r)
}

async fn check_totp_sign_in_and_the_half_signed_in_state_reaches_no_api(t: TestApp) {
    let (owner, org) = t.setup().await;
    let status = t.get("/api/me/security", &owner).await;
    assert_eq!(status.status, StatusCode::OK, "{}", status.body);
    assert_eq!((status.body["required"].as_bool(), status.body["totp"].is_null()), (Some(false), true));
    let (secret, codes) = t.enroll_totp(&owner).await;
    assert_eq!(codes.len(), 10, "the first factor comes with recovery codes");

    // The password alone opens no session.
    let (pending, r) = t.password("joerg@example.de").await;
    assert!(pending.session.is_none(), "no session before the second factor");
    assert!(pending.pending.is_some());
    assert_eq!(r.body["secondFactor"]["methods"], json!(["totp", "recovery"]));
    assert_eq!(r.body["secondFactor"]["setup"], false);
    for path in ["/api/me", &format!("/api/orgs/{org}"), "/api/me/security", "/api/admin/users"] {
        let r = t.get(path, &pending).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNAUTHORIZED, "unauthenticated"), "{path}");
    }
    let r = t.get("/api/auth/second-factor", &pending).await;
    assert_eq!(r.body["email"], "joerg@example.de");

    // A wrong code, then the right one.
    let wrong_code = if t.code(&secret) == "000000" { "111111" } else { "000000" };
    let (_, wrong) = second_step(&t, &pending, json!({ "method": "totp", "code": wrong_code })).await;
    assert_eq!((wrong.status, wrong.code()), (StatusCode::UNPROCESSABLE_ENTITY, "invalid_code"), "{}", wrong.body);
    let (signed_in, r) = second_step(&t, &pending, json!({ "method": "totp", "code": t.code(&secret) })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["me"]["email"], "joerg@example.de");
    assert!(r.cookie("kalzit_device").is_some(), "the browser becomes a known device");
    assert_eq!(t.get("/api/me", &signed_in).await.status, StatusCode::OK);
    // The half-signed-in state is used up.
    assert_eq!(t.get("/api/auth/second-factor", &pending).await.status, StatusCode::UNAUTHORIZED);

    // The same code does not sign in a second time within its step.
    let (pending, _) = t.password("joerg@example.de").await;
    let (_, replay) = second_step(&t, &pending, json!({ "method": "totp", "code": t.code(&secret) })).await;
    assert_eq!(replay.code(), "invalid_code", "{}", replay.body);
    t.next_step();
    let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": t.code(&secret) })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // The state lives five minutes.
    let (pending, _) = t.password("joerg@example.de").await;
    t.clock.advance_ms(5 * 60_000);
    t.next_step();
    let (_, late) = second_step(&t, &pending, json!({ "method": "totp", "code": t.code(&secret) })).await;
    assert_eq!((late.status, late.reason()), (StatusCode::UNAUTHORIZED, "second_factor.pending_expired"));

    let actions = t.audit_actions().await;
    assert!(actions.contains(&"user.second_factor_enrolled".to_string()));
    assert!(actions.contains(&"auth.second_factor_failed".to_string()));
    let summaries: Vec<(String,)> =
        sqlx::query_as("SELECT summary FROM audit_events").fetch_all(&t.state.db).await.unwrap();
    let secret_text = totp::encode_secret(&secret);
    assert!(summaries.iter().all(|(s,)| !s.contains(&secret_text) && !codes.iter().any(|c| s.contains(c))));
    t.finish().await;
}

async fn check_recovery_codes_work_once_and_regenerating_needs_a_fresh_confirmation(t: TestApp) {
    let (owner, _) = t.setup().await;
    let (secret, codes) = t.enroll_totp(&owner).await;
    let (pending, _) = t.password("joerg@example.de").await;
    let (browser, r) =
        second_step(&t, &pending, json!({ "method": "recovery", "code": codes[0].to_uppercase() })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["recoveryCodesRemaining"], 9);
    let (pending, _) = t.password("joerg@example.de").await;
    let (_, again) = second_step(&t, &pending, json!({ "method": "recovery", "code": codes[0] })).await;
    assert_eq!(again.code(), "invalid_code", "a code works once");

    // Right after the sign-in the session counts as confirmed; five minutes later it does not.
    let r = t.post("/api/me/security/recovery-codes", json!({}), &browser).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let fresh: Vec<String> =
        r.body["recoveryCodes"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    t.clock.advance_ms(6 * 60_000);
    let r = t.post("/api/me/security/recovery-codes", json!({}), &browser).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "confirmation_required"));
    let r = t.post("/api/me/security/confirm", json!({ "method": "totp", "code": t.code(&secret) }), &browser).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.post("/api/me/security/recovery-codes", json!({}), &browser).await.status, StatusCode::OK);
    // The set before is gone.
    let (pending, _) = t.password("joerg@example.de").await;
    let (_, old) = second_step(&t, &pending, json!({ "method": "recovery", "code": fresh[1] })).await;
    assert_eq!(old.code(), "invalid_code");
    t.finish().await;
}

async fn check_five_wrong_codes_lock_the_second_step_for_fifteen_minutes(t: TestApp) {
    let (owner, _) = t.setup().await;
    let (secret, _) = t.enroll_totp(&owner).await;
    let (pending, _) = t.password("joerg@example.de").await;
    let right = t.code(&secret);
    let wrong = if right == "123456" { "654321" } else { "123456" };
    for attempt in 1..=4 {
        let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": wrong })).await;
        assert_eq!(r.code(), "invalid_code", "attempt {attempt}");
    }
    let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": wrong })).await;
    assert_eq!((r.code(), r.reason()), ("rate_limited", "second_factor.locked"), "{}", r.body);
    let until: i64 = r.body["error"]["params"]["until"].as_str().unwrap().parse().unwrap();
    assert!(until > t.clock.now_ms() + 14 * 60_000);
    // Locked: the right code is refused too, from any browser.
    let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": right })).await;
    assert_eq!(r.reason(), "second_factor.locked");
    assert!(t.get("/api/auth/second-factor", &pending).await.body["lockedUntil"].is_i64());
    assert!(t.audit_actions().await.contains(&"auth.second_factor_locked".to_string()));
    t.clock.advance_ms(15 * 60_000);
    let (pending, _) = t.password("joerg@example.de").await;
    let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": t.code(&secret) })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.finish().await;
}

async fn check_parallel_guesses_cannot_pass_the_lockout(t: TestApp) {
    let (owner, _) = t.setup().await;
    let (secret, _) = t.enroll_totp(&owner).await;
    let (pending, _) = t.password("joerg@example.de").await;
    let right = t.code(&secret);
    let wrong = if right == "123456" { "654321" } else { "123456" };
    let mut tasks = Vec::new();
    for _ in 0..12 {
        let app = t.app.clone();
        let cookie = pending.header();
        tasks.push(tokio::spawn(async move {
            let req = Request::post("/api/auth/second-factor")
                .header(header::HOST, HOST)
                .header("origin", ORIGIN)
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "method": "totp", "code": wrong }).to_string()))
                .unwrap();
            app.oneshot(req).await.unwrap().status()
        }));
    }
    let mut checked = 0;
    for task in tasks {
        if task.await.unwrap() == StatusCode::UNPROCESSABLE_ENTITY {
            checked += 1;
        }
    }
    assert!(checked < 5, "at most four wrong codes are checked before the lock ({checked})");
    let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": right })).await;
    assert_eq!(r.reason(), "second_factor.locked", "{}", r.body);
    t.finish().await;
}

async fn check_a_required_second_factor_is_set_up_at_the_next_sign_in(t: TestApp) {
    let (owner, org) = t.setup().await;
    t.member(&owner, &org, "vera@example.de", "viewer").await;
    let r = t.put_setting(&owner, "/api/admin/settings/security.two_factor_required", json!("everyone")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    let (pending, r) = t.password("vera@example.de").await;
    assert!(pending.session.is_none());
    let prompt = &r.body["secondFactor"];
    assert_eq!((prompt["setup"].as_bool(), prompt["requiredBy"]["kind"].as_str()), (Some(true), Some("server")));
    // Nothing to confirm with yet.
    let (_, r) = second_step(&t, &pending, json!({ "method": "totp", "code": "123456" })).await;
    assert_eq!(r.reason(), "second_factor.setup_needed");
    let r = t.post("/api/auth/second-factor/setup/totp", json!({}), &pending).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let secret = totp::decode_secret(&r.body["secret"].as_str().unwrap().replace(' ', "")).unwrap();
    let r = t.post("/api/auth/second-factor/setup", json!({ "method": "totp", "code": "000001" }), &pending).await;
    assert_eq!(r.code(), "invalid_code", "a wrong first code keeps the setup open");
    let r =
        t.post("/api/auth/second-factor/setup", json!({ "method": "totp", "code": t.code(&secret) }), &pending).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["recoveryCodes"].as_array().unwrap().len(), 10);
    let signed_in = Browser { session: r.cookie("kalzit_session"), pending: None };
    let status = t.get("/api/me/security", &signed_in).await;
    assert_eq!((status.body["required"].as_bool(), status.body["totp"].is_object()), (Some(true), true));

    // The last method cannot go while it is required, even confirmed.
    let r = t.send(Method::DELETE, "/api/me/security/totp", None, &signed_in).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "second_factor.last_method"), "{}", r.body);
    // With the method turned off, it cannot be set up any more.
    let r = t.put_setting(&owner, "/api/admin/settings/security.two_factor_methods", json!("passkey")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.post("/api/me/security/totp/setup", json!({}), &signed_in).await;
    assert_eq!(r.reason(), "second_factor.method_off");
    t.finish().await;
}

async fn check_organizations_can_only_be_stricter_than_the_server(t: TestApp) {
    let (owner, org) = t.setup().await;
    let _admin = t.member(&owner, &org, "ada@example.de", "admin").await;
    let _viewer = t.member(&owner, &org, "vera@example.de", "viewer").await;
    let path = format!("/api/orgs/{org}/settings/security.two_factor_required");
    let r = t.put_setting(&owner, &path, json!("off")).await;
    assert_eq!(r.code(), "validation", "an organization cannot turn the server's rule off");
    let r = t.put_setting(&owner, &path, json!("admins")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    let (_, r) = t.password("ada@example.de").await;
    assert_eq!(r.body["secondFactor"]["requiredBy"]["kind"], "org", "{}", r.body);
    let (viewer, r) = t.password("vera@example.de").await;
    assert!(r.body["id"].is_string() && viewer.session.is_some(), "viewers need none here");

    // The members list shows who must set one up.
    let r = t.get(&format!("/api/orgs/{org}/members"), &owner).await;
    let ada = r.body["items"].as_array().unwrap().iter().find(|m| m["email"] == "ada@example.de").unwrap();
    assert_eq!(
        (ada["secondFactor"]["required"].as_bool(), ada["secondFactor"]["methods"].clone()),
        (Some(true), json!([]))
    );
    let overview = t.get("/api/admin/security/two-factor", &owner).await;
    assert_eq!(overview.status, StatusCode::OK, "{}", overview.body);
    assert_eq!(overview.body["orgs"][0]["effective"], "admins");
    // The owner (also a server admin) and Ada.
    assert_eq!(overview.body["orgs"][0]["missing"], 2);
    t.finish().await;
}

async fn check_an_admin_resets_a_second_factor_after_confirming_their_own(t: TestApp) {
    let (owner, org) = t.setup().await;
    let editor = t.member(&owner, &org, "eda@example.de", "editor").await;
    let (_, _) = t.enroll_totp(&editor).await;
    let reset = format!("/api/orgs/{org}/members/{}/second-factor/reset", member_id(&t, "eda@example.de").await);

    // The admin needs a second factor of their own, confirmed just before.
    let r = t.post(&reset, json!({ "reason": "Telefon verloren" }), &owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "second_factor.admin_needs_factor"), "{}", r.body);
    let (owner_secret, _) = t.enroll_totp(&owner).await;
    t.clock.advance_ms(6 * 60_000);
    let r = t.post(&reset, json!({ "reason": "Telefon verloren" }), &owner).await;
    assert_eq!(r.code(), "confirmation_required", "{}", r.body);
    let r =
        t.post("/api/me/security/confirm", json!({ "method": "totp", "code": t.code(&owner_secret) }), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Never one's own.
    let own = format!("/api/orgs/{org}/members/{}/second-factor/reset", member_id(&t, "joerg@example.de").await);
    assert_eq!(t.post(&own, json!({}), &owner).await.reason(), "second_factor.reset_self");
    // Others cannot reset.
    assert_eq!(t.post(&reset, json!({}), &editor).await.status, StatusCode::FORBIDDEN);

    let r = t.post(&reset, json!({ "reason": "Telefon verloren" }), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["removed"]["totp"], true);
    assert_eq!(t.get("/api/me", &editor).await.status, StatusCode::UNAUTHORIZED, "the person is signed out");
    let (fresh, r) = t.password("eda@example.de").await;
    assert!(fresh.session.is_some() && r.body["id"].is_string(), "no second factor any more: {}", r.body);
    let summaries: Vec<(String,)> =
        sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'user.second_factor_reset'")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert!(summaries[0].0.contains("Telefon verloren"));

    // A member of another organization too needs a server admin.
    let other: Value = t
        .post(
            "/api/admin/orgs",
            json!({ "name": "Partner", "ownerUserId": member_id(&t, "eda@example.de").await }),
            &owner,
        )
        .await
        .body;
    assert!(other["id"].is_string(), "{other}");
    let r = t.post(&reset, json!({}), &owner).await;
    assert_eq!(r.reason(), "second_factor.reset_needs_server_admin", "{}", r.body);
    let admin_reset = format!("/api/admin/users/{}/second-factor/reset", member_id(&t, "eda@example.de").await);
    assert_eq!(t.post(&admin_reset, json!({}), &owner).await.status, StatusCode::OK);
    t.finish().await;
}

async fn check_a_new_password_needs_a_fresh_confirmation_with_a_second_factor(t: TestApp) {
    let (owner, _) = t.setup().await;
    let (secret, _) = t.enroll_totp(&owner).await;
    t.clock.advance_ms(6 * 60_000);
    let change = json!({ "current": PASSWORD, "new": "Ein anderes langes Passwort" });
    let r = t.post("/api/me/password", change.clone(), &owner).await;
    assert_eq!(r.code(), "confirmation_required", "{}", r.body);
    t.post("/api/me/security/confirm", json!({ "method": "totp", "code": t.code(&secret) }), &owner).await;
    assert_eq!(t.post("/api/me/password", change, &owner).await.status, StatusCode::NO_CONTENT);
    t.finish().await;
}

async fn member_id(t: &TestApp, email: &str) -> String {
    let (id,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = $1").bind(email).fetch_one(&t.state.db).await.unwrap();
    id
}

// ---------------------------------------------------------------------------------------------
// A software authenticator: one P-256 key, "none" attestation, user present and verified.

mod authenticator {
    use data_encoding::BASE64URL_NOPAD as B64;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{DerSignature, SigningKey};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    pub struct Authenticator {
        key: SigningKey,
        pub credential_id: Vec<u8>,
        pub counter: u32,
    }

    /// The parts of CBOR this needs: unsigned and negative integers, byte and text strings, maps.
    fn head(major: u8, len: u64, out: &mut Vec<u8>) {
        let m = major << 5;
        match len {
            0..=23 => out.push(m | len as u8),
            24..=0xff => out.extend([m | 24, len as u8]),
            0x100..=0xffff => {
                out.push(m | 25);
                out.extend((len as u16).to_be_bytes());
            }
            _ => {
                out.push(m | 26);
                out.extend((len as u32).to_be_bytes());
            }
        }
    }

    fn int(v: i64, out: &mut Vec<u8>) {
        if v >= 0 { head(0, v as u64, out) } else { head(1, (-1 - v) as u64, out) }
    }

    fn bytes(b: &[u8], out: &mut Vec<u8>) {
        head(2, b.len() as u64, out);
        out.extend(b);
    }

    fn text(s: &str, out: &mut Vec<u8>) {
        head(3, s.len() as u64, out);
        out.extend(s.as_bytes());
    }

    impl Authenticator {
        pub fn new() -> Self {
            let key = loop {
                if let Ok(key) = SigningKey::from_slice(&rand::random::<[u8; 32]>()) {
                    break key;
                }
            };
            Self { key, credential_id: rand::random::<[u8; 16]>().to_vec(), counter: 0 }
        }

        fn cose_key(&self) -> Vec<u8> {
            let point = self.key.verifying_key().to_encoded_point(false);
            let mut out = Vec::new();
            head(5, 5, &mut out);
            int(1, &mut out);
            int(2, &mut out); // kty: EC2
            int(3, &mut out);
            int(-7, &mut out); // alg: ES256
            int(-1, &mut out);
            int(1, &mut out); // crv: P-256
            int(-2, &mut out);
            bytes(point.x().unwrap(), &mut out);
            int(-3, &mut out);
            bytes(point.y().unwrap(), &mut out);
            out
        }

        fn auth_data(&self, rp_id: &str, attested: bool) -> Vec<u8> {
            let mut out = Sha256::digest(rp_id.as_bytes()).to_vec();
            // User present and verified; attested credential data on registration.
            out.push(0x01 | 0x04 | if attested { 0x40 } else { 0 });
            out.extend(self.counter.to_be_bytes());
            if attested {
                out.extend([0u8; 16]);
                out.extend((self.credential_id.len() as u16).to_be_bytes());
                out.extend(&self.credential_id);
                out.extend(self.cose_key());
            }
            out
        }

        fn client_data(kind: &str, challenge: &str, origin: &str) -> Vec<u8> {
            json!({ "type": kind, "challenge": challenge, "origin": origin, "crossOrigin": false })
                .to_string()
                .into_bytes()
        }

        /// The answer of `navigator.credentials.create` to `options` (`{"publicKey": ...}`).
        pub fn register(&self, options: &Value, origin: &str) -> Value {
            let public_key = &options["publicKey"];
            let rp_id = public_key["rp"]["id"].as_str().unwrap();
            let client = Self::client_data("webauthn.create", public_key["challenge"].as_str().unwrap(), origin);
            let mut attestation = Vec::new();
            head(5, 3, &mut attestation);
            text("fmt", &mut attestation);
            text("none", &mut attestation);
            text("attStmt", &mut attestation);
            head(5, 0, &mut attestation);
            text("authData", &mut attestation);
            bytes(&self.auth_data(rp_id, true), &mut attestation);
            json!({
                "id": B64.encode(&self.credential_id),
                "rawId": B64.encode(&self.credential_id),
                "type": "public-key",
                "response": { "attestationObject": B64.encode(&attestation), "clientDataJSON": B64.encode(&client) },
                "extensions": {}
            })
        }

        /// The answer of `navigator.credentials.get` to `options`; the counter goes up first.
        pub fn assert(&mut self, options: &Value, origin: &str) -> Value {
            self.counter += 1;
            let public_key = &options["publicKey"];
            let rp_id = public_key["rpId"].as_str().unwrap();
            let client = Self::client_data("webauthn.get", public_key["challenge"].as_str().unwrap(), origin);
            let auth_data = self.auth_data(rp_id, false);
            let signed = [auth_data.as_slice(), Sha256::digest(&client).as_slice()].concat();
            let signature: DerSignature = self.key.sign(&signed);
            json!({
                "id": B64.encode(&self.credential_id),
                "rawId": B64.encode(&self.credential_id),
                "type": "public-key",
                "response": {
                    "authenticatorData": B64.encode(&auth_data),
                    "clientDataJSON": B64.encode(&client),
                    "signature": B64.encode(signature.as_bytes()),
                    "userHandle": null
                },
                "extensions": {}
            })
        }
    }
}

async fn check_passkeys_sign_in_and_a_cloned_authenticator_is_refused(t: TestApp) {
    use authenticator::Authenticator;
    let (owner, _) = t.setup().await;
    let mut key = Authenticator::new();
    let options = t.post("/api/me/security/passkeys/setup", json!({}), &owner).await;
    assert_eq!(options.status, StatusCode::OK, "{}", options.body);
    assert_eq!(options.body["publicKey"]["rp"]["id"], HOST);
    assert!(options.body["publicKey"].get("hints").is_none(), "no hint for hardware keys only");
    assert_eq!(options.body["publicKey"]["attestation"], "none");
    let answer = key.register(&options.body, ORIGIN);
    let r = t.post("/api/me/security/passkeys", json!({ "name": "Laptop Büro", "credential": answer }), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["recoveryCodes"].as_array().unwrap().len(), 10);
    let passkey_id = r.body["passkey"]["id"].as_str().unwrap().to_string();
    // A second one needs a fresh confirmation first.
    let r = t.post("/api/me/security/passkeys/setup", json!({}), &owner).await;
    assert_eq!(r.code(), "confirmation_required");

    let (pending, r) = t.password("joerg@example.de").await;
    assert_eq!(r.body["secondFactor"]["methods"][0], "passkey");
    let options = t.post("/api/auth/second-factor/passkey", json!({}), &pending).await;
    assert_eq!(options.status, StatusCode::OK, "{}", options.body);
    // An answer for another origin is refused.
    let foreign = key.assert(&options.body, "http://evil.test");
    let (_, r) = second_step(&t, &pending, json!({ "method": "passkey", "credential": foreign })).await;
    assert_eq!(r.code(), "invalid_code", "{}", r.body);
    let options = t.post("/api/auth/second-factor/passkey", json!({}), &pending).await;
    let answer = key.assert(&options.body, ORIGIN);
    let (browser, r) = second_step(&t, &pending, json!({ "method": "passkey", "credential": answer })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // The same authenticator again is refused (the browser excludes it; the server too).
    let options = t.post("/api/me/security/passkeys/setup", json!({}), &browser).await;
    let r = t
        .post("/api/me/security/passkeys", json!({ "credential": key.register(&options.body, ORIGIN) }), &browser)
        .await;
    assert_eq!(r.reason(), "second_factor.passkey_refused", "{}", r.body);
    assert_eq!(t.get("/api/me/security", &browser).await.body["passkeys"].as_array().unwrap().len(), 1);

    // A copy of the authenticator with an older counter: refused.
    let (pending, _) = t.password("joerg@example.de").await;
    let options = t.post("/api/auth/second-factor/passkey", json!({}), &pending).await;
    key.counter = 0;
    let answer = key.assert(&options.body, ORIGIN);
    let (_, r) = second_step(&t, &pending, json!({ "method": "passkey", "credential": answer })).await;
    assert_eq!(r.code(), "invalid_code", "{}", r.body);

    // Rename and remove, with a fresh confirmation by passkey.
    let r = t
        .send(
            Method::PATCH,
            &format!("/api/me/security/passkeys/{passkey_id}"),
            Some(json!({ "name": "Laptop" })),
            &browser,
        )
        .await;
    assert_eq!(r.body["name"], "Laptop");
    t.clock.advance_ms(6 * 60_000);
    let remove = format!("/api/me/security/passkeys/{passkey_id}");
    assert_eq!(t.send(Method::DELETE, &remove, None, &browser).await.code(), "confirmation_required");
    let options = t.post("/api/me/security/confirm/passkey", json!({}), &browser).await;
    key.counter = 10;
    let answer = key.assert(&options.body, ORIGIN);
    let r = t.post("/api/me/security/confirm", json!({ "method": "passkey", "credential": answer }), &browser).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.send(Method::DELETE, &remove, None, &browser).await.status, StatusCode::NO_CONTENT);
    // The last method gone: the recovery codes go with it, and the next sign-in has no second step.
    let status = t.get("/api/me/security", &browser).await;
    assert!(status.body["recoveryCodes"].is_null(), "{}", status.body);
    let (_, r) = t.password("joerg@example.de").await;
    assert!(r.body["id"].is_string());
    t.finish().await;
}

// ---------------------------------------------------------------------------------------------
// Each check on SQLite, and all of them on PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set.

#[tokio::test]
async fn totp_sign_in_and_the_half_signed_in_state_reaches_no_api() {
    check_totp_sign_in_and_the_half_signed_in_state_reaches_no_api(test_app().await).await;
}

#[tokio::test]
async fn recovery_codes_work_once_and_regenerating_needs_a_fresh_confirmation() {
    check_recovery_codes_work_once_and_regenerating_needs_a_fresh_confirmation(test_app().await).await;
}

#[tokio::test]
async fn five_wrong_codes_lock_the_second_step_for_fifteen_minutes() {
    check_five_wrong_codes_lock_the_second_step_for_fifteen_minutes(test_app().await).await;
}

#[tokio::test]
async fn parallel_guesses_cannot_pass_the_lockout() {
    check_parallel_guesses_cannot_pass_the_lockout(test_app().await).await;
}

#[tokio::test]
async fn a_required_second_factor_is_set_up_at_the_next_sign_in() {
    check_a_required_second_factor_is_set_up_at_the_next_sign_in(test_app().await).await;
}

#[tokio::test]
async fn organizations_can_only_be_stricter_than_the_server() {
    check_organizations_can_only_be_stricter_than_the_server(test_app().await).await;
}

#[tokio::test]
async fn an_admin_resets_a_second_factor_after_confirming_their_own() {
    check_an_admin_resets_a_second_factor_after_confirming_their_own(test_app().await).await;
}

#[tokio::test]
async fn a_new_password_needs_a_fresh_confirmation_with_a_second_factor() {
    check_a_new_password_needs_a_fresh_confirmation_with_a_second_factor(test_app().await).await;
}

#[tokio::test]
async fn passkeys_sign_in_and_a_cloned_authenticator_is_refused() {
    check_passkeys_sign_in_and_a_cloned_authenticator_is_refused(test_app().await).await;
}

#[tokio::test]
async fn postgres_two_factor() {
    let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
        eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL test not run");
        return;
    };
    check_totp_sign_in_and_the_half_signed_in_state_reaches_no_api(postgres_app(&base).await).await;
    check_recovery_codes_work_once_and_regenerating_needs_a_fresh_confirmation(postgres_app(&base).await).await;
    check_five_wrong_codes_lock_the_second_step_for_fifteen_minutes(postgres_app(&base).await).await;
    check_parallel_guesses_cannot_pass_the_lockout(postgres_app(&base).await).await;
    check_a_required_second_factor_is_set_up_at_the_next_sign_in(postgres_app(&base).await).await;
    check_organizations_can_only_be_stricter_than_the_server(postgres_app(&base).await).await;
    check_an_admin_resets_a_second_factor_after_confirming_their_own(postgres_app(&base).await).await;
    check_a_new_password_needs_a_fresh_confirmation_with_a_second_factor(postgres_app(&base).await).await;
    check_passkeys_sign_in_and_a_cloned_authenticator_is_refused(postgres_app(&base).await).await;
}
