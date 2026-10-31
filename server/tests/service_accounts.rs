//! Service accounts, their API tokens and the SCIM token through the real router (SQLite;
//! PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set, each app in a throwaway schema).

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
const DAY_MS: i64 = 86_400_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    org: String,
    owner: String,
    /// Its PostgreSQL schema, dropped at `finish` (or with the app).
    schema: Option<common::PgSchema>,
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

/// Who sends a request: a session cookie, a bearer token, or nobody.
enum Who<'a> {
    Cookie(&'a str),
    Token(&'a str),
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
        let mut t = TestApp { app, clock, state, dir: Arc::new(dir), org: String::new(), owner: String::new(), schema };
        let r = t
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        assert!(!t.owner.is_empty(), "setup signs the owner in");
        t
    }

    async fn finish(mut self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone()).with_schema(self.schema.take());
        drop(self);
        finish.finish().await;
    }

    async fn send(&mut self, method: Method, path: &str, body: Option<Value>, who: Option<Who<'_>>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        match who {
            Some(Who::Cookie(c)) => req = req.header(header::COOKIE, c),
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

    fn path(&self, rest: &str) -> String {
        format!("/api/orgs/{}{rest}", self.org)
    }

    /// A request of the owner (the session `send` kept first) to the organization's `rest`.
    async fn owner(&mut self, method: Method, rest: &str, body: Option<Value>) -> Reply {
        let (path, cookie) = (self.path(rest), self.owner.clone());
        self.send(method, &path, body, Some(Who::Cookie(&cookie))).await
    }

    async fn with_token(&mut self, method: Method, path: &str, body: Option<Value>, token: &str) -> Reply {
        self.send(method, path, body, Some(Who::Token(token))).await
    }

    async fn account(&mut self, name: &str, role: &str) -> String {
        let r = self.owner(Method::POST, "/service-accounts", Some(json!({ "name": name, "role": role }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn token(&mut self, account: &str, body: Value) -> (String, String) {
        let r = self.owner(Method::POST, &format!("/service-accounts/{account}/tokens"), Some(body)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        (r.body["token"].as_str().unwrap().to_string(), r.body["id"].as_str().unwrap().to_string())
    }

    async fn audit_actions(&self) -> Vec<(String, String)> {
        sqlx::query_as("SELECT action, summary FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn a_token_acts_as_its_service_account_with_its_role_in_its_organization_only() {
    let mut t = TestApp::new().await;
    let id = t.account("export-nightly", "viewer").await;
    let (token, _) = t.token(&id, json!({ "name": "backup01" })).await;
    assert!(token.starts_with("kz_sa_") && token.len() == 46, "{token}");

    // Only the hash is stored.
    let stored: Vec<(String, String)> =
        sqlx::query_as("SELECT token_hash, prefix FROM api_tokens").fetch_all(&t.state.db).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_ne!(stored[0].0, token);
    assert!(token.starts_with(&stored[0].1) && stored[0].1.len() == 14);

    let me = t.with_token(Method::GET, &t.path(""), None, &token).await;
    assert_eq!(me.status, StatusCode::OK, "{}", me.body);
    assert_eq!(me.body["role"], "viewer");
    let dashboards = t.with_token(Method::GET, &t.path("/dashboards"), None, &token).await;
    assert_eq!(dashboards.status, StatusCode::OK, "{}", dashboards.body);
    // The viewer's role is all it has.
    let folder = t.with_token(Method::POST, &t.path("/folders"), Some(json!({ "name": "Neu" })), &token).await;
    assert_eq!(folder.status, StatusCode::FORBIDDEN, "{}", folder.body);

    // Nothing outside its organization.
    let r = t.with_token(Method::GET, "/api/me", None, &token).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.org_routes_only"));
    let r = t.with_token(Method::GET, "/api/admin/users", None, &token).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let other = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
        .bind(&other)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.with_token(Method::GET, &format!("/api/orgs/{other}"), None, &token).await;
    assert_eq!((r.status, r.code()), (StatusCode::NOT_FOUND, "not_found"));

    // A token never manages service accounts, even with the right role.
    let r = t.owner(Method::PATCH, &format!("/service-accounts/{id}"), Some(json!({ "role": "admin" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.with_token(Method::GET, &t.path("/service-accounts"), None, &token).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.not_for_this_route"));
    let r = t
        .with_token(
            Method::POST,
            &t.path(&format!("/service-accounts/{id}/tokens")),
            Some(json!({ "name": "x" })),
            &token,
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.not_for_this_route"));
    // Its new role counts at once.
    let folder = t.with_token(Method::POST, &t.path("/folders"), Some(json!({ "name": "Neu" })), &token).await;
    assert_eq!(folder.status, StatusCode::CREATED, "{}", folder.body);

    // The last use is recorded in the background.
    t.state.touches.settle().await;
    let detail = t.owner(Method::GET, &format!("/service-accounts/{id}"), None).await;
    assert_eq!(detail.body["tokens"][0]["lastUsedAddress"], "127.0.0.1", "{}", detail.body);
    assert!(detail.body["lastUsedAt"].is_i64(), "{}", detail.body);
    assert_eq!(detail.body["activeTokens"], 1);
    t.finish().await;
}

#[tokio::test]
async fn service_accounts_are_not_people() {
    let mut t = TestApp::new().await;
    let id = t.account("ci-dashboards", "editor").await;
    let members = t.owner(Method::GET, "/members", None).await;
    assert_eq!(members.body["items"].as_array().unwrap().len(), 1, "{}", members.body);
    let r = t.owner(Method::PATCH, &format!("/members/{id}"), Some(json!({ "role": "viewer" }))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t.owner(Method::DELETE, &format!("/members/{id}"), None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let cookie = t.owner.clone();
    let users = t.send(Method::GET, "/api/admin/users", None, Some(Who::Cookie(&cookie))).await;
    assert_eq!(users.body["items"].as_array().unwrap().len(), 1, "{}", users.body);
    let r = t
        .send(
            Method::PATCH,
            &format!("/api/admin/users/{id}"),
            Some(json!({ "disabled": true })),
            Some(Who::Cookie(&cookie)),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let team = t.owner(Method::POST, "/teams", Some(json!({ "name": "Vertrieb" }))).await;
    let team = team.body["id"].as_str().unwrap().to_string();
    let r = t.owner(Method::PUT, &format!("/teams/{team}/members/{id}"), Some(json!({ "role": "member" }))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    // It cannot sign in.
    let (email,): (String,) =
        sqlx::query_as("SELECT email FROM users WHERE id = $1").bind(&id).fetch_one(&t.state.db).await.unwrap();
    let r = t.send(Method::POST, "/api/auth/login", Some(json!({ "email": email, "password": PASSWORD })), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    t.finish().await;
}

#[tokio::test]
async fn names_roles_and_expiry_are_checked() {
    let mut t = TestApp::new().await;
    let id = t.account("probe", "viewer").await;
    let r = t.owner(Method::POST, "/service-accounts", Some(json!({ "name": "probe", "role": "viewer" }))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "serviceaccount.name_taken"));
    let r = t.owner(Method::POST, "/service-accounts", Some(json!({ "name": "Probe Zwei", "role": "viewer" }))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "serviceaccount.name_invalid"));
    let r = t.owner(Method::POST, "/service-accounts", Some(json!({ "name": "boss", "role": "owner" }))).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "serviceaccount.role_owner"));
    let r = t.owner(Method::PATCH, &format!("/service-accounts/{id}"), Some(json!({ "role": "owner" }))).await;
    assert_eq!(r.reason(), "serviceaccount.role_owner");

    let now = t.state.clock.now_ms();
    let r = t.owner(Method::POST, &format!("/service-accounts/{id}/tokens"), Some(json!({ "name": "a" }))).await;
    let expires = r.body["expiresAt"].as_i64().unwrap();
    assert!((expires - now - 90 * DAY_MS).abs() < 1000, "90 days by default");
    let r = t
        .owner(
            Method::POST,
            &format!("/service-accounts/{id}/tokens"),
            Some(json!({ "name": "b", "expiresInDays": 366 })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "token.expiry_out_of_range"));
    let r = t
        .owner(
            Method::POST,
            &format!("/service-accounts/{id}/tokens"),
            Some(json!({ "name": "c", "allowedIps": ["10.20.8.0/24", "10.20.9.14", "10.20.0.0/33"] })),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "token.ip_invalid"));
    assert_eq!(r.body["error"]["params"]["line"], "3");
    t.finish().await;
}

#[tokio::test]
async fn refused_tokens_answer_401_are_audited_and_rate_limited() {
    let mut t = TestApp::new().await;
    let id = t.account("export-nightly", "viewer").await;
    let (elsewhere, _) = t.token(&id, json!({ "name": "nur intern", "allowedIps": ["10.0.0.0/8"] })).await;
    let (short, _) = t.token(&id, json!({ "name": "kurz", "expiresInDays": 1 })).await;
    let (revoked, revoked_id) = t.token(&id, json!({ "name": "alt" })).await;
    let (good, _) = t.token(&id, json!({ "name": "gut" })).await;
    let path = t.path("");

    let r = t.with_token(Method::GET, &path, None, &elsewhere).await;
    assert_eq!((r.status, r.code()), (StatusCode::UNAUTHORIZED, "unauthenticated"));
    let r = t.owner(Method::POST, &format!("/service-accounts/{id}/tokens/{revoked_id}/revoke"), None).await;
    assert!(r.body["revokedAt"].is_i64(), "{}", r.body);
    assert_eq!(t.with_token(Method::GET, &path, None, &revoked).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.with_token(Method::GET, &path, None, &short).await.status, StatusCode::OK);
    t.clock.advance_ms(DAY_MS);
    assert_eq!(t.with_token(Method::GET, &path, None, &short).await.status, StatusCode::UNAUTHORIZED);
    let r = t.owner(Method::PATCH, &format!("/service-accounts/{id}"), Some(json!({ "disabled": true }))).await;
    assert_eq!(r.body["disabled"], true);
    assert_eq!(t.with_token(Method::GET, &path, None, &good).await.status, StatusCode::UNAUTHORIZED);
    t.owner(Method::PATCH, &format!("/service-accounts/{id}"), Some(json!({ "disabled": false }))).await;
    assert_eq!(t.with_token(Method::GET, &path, None, &good).await.status, StatusCode::OK);
    let unknown = format!("kz_sa_{}", "0".repeat(40));
    assert_eq!(t.with_token(Method::GET, &path, None, &unknown).await.status, StatusCode::UNAUTHORIZED);

    let refusals: Vec<String> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(action, _)| action == "api_token.refused")
        .map(|(_, summary)| serde_json::from_str::<Value>(&summary).unwrap()["reason"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(refusals, ["address_not_allowed", "revoked", "expired", "account_disabled", "unknown"]);
    let actions: Vec<String> = t.audit_actions().await.into_iter().map(|(a, _)| a).collect();
    for wanted in ["service_account.created", "service_account.token_created", "service_account.token_revoked"] {
        assert!(actions.iter().any(|a| a == wanted), "{wanted} in {actions:?}");
    }
    for (_, summary) in t.audit_actions().await {
        assert!(!summary.contains(&good) && !summary.contains(&revoked), "no token in the audit log");
    }

    // Three refusals in this window (the day moved past the first two): expired, disabled and
    // unknown. The budget is ten per window; then other tokens from this address wait, while a
    // working token still gets through. The window writes one entry at its first refusal and one
    // with the count of the others when it ends.
    for _ in 0..7 {
        assert_eq!(t.with_token(Method::GET, &path, None, &unknown).await.status, StatusCode::UNAUTHORIZED);
    }
    let r = t.with_token(Method::GET, &path, None, &unknown).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    for _ in 0..3 {
        let r = t.with_token(Method::GET, &path, None, &revoked).await;
        assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
    }
    let not_ours = "kz_sa_kein-gueltiges-format";
    assert_eq!(t.with_token(Method::GET, &path, None, not_ours).await.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(t.with_token(Method::GET, &path, None, &good).await.status, StatusCode::OK);
    let limited: Vec<Value> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(action, _)| action.starts_with("api_token.r") && action != "api_token.refused")
        .map(|(action, summary)| json!({ "action": action, "summary": serde_json::from_str::<Value>(&summary).unwrap() }))
        .collect();
    assert_eq!(limited.len(), 1, "one entry while the window runs: {limited:?}");
    assert_eq!(limited[0]["action"], "api_token.refused_rate_limited");
    assert_eq!(limited[0]["summary"]["reason"], "unknown");
    assert_eq!(limited[0]["summary"]["prefix"], &unknown[..14], "the prefix of a well-formed token");
    // The window ends; the next request from the address closes it with the count.
    t.clock.advance_ms(16 * 60_000);
    assert_eq!(t.with_token(Method::GET, &path, None, &unknown).await.status, StatusCode::UNAUTHORIZED);
    let closing: Vec<String> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(action, _)| action == "api_token.rate_limit_ended")
        .map(|(_, summary)| summary)
        .collect();
    assert_eq!(closing.len(), 1, "{closing:?}");
    let closing: Value = serde_json::from_str(&closing[0]).unwrap();
    assert_eq!(closing["suppressed"], 4, "{closing}");
    for (_, summary) in t.audit_actions().await {
        assert!(!summary.contains("kein-gueltiges") && !summary.contains(&revoked), "{summary}");
    }
    // Revoked tokens stay listed, grey, until 90 days after they ended.
    let detail = t.owner(Method::GET, &format!("/service-accounts/{id}"), None).await;
    assert_eq!(detail.body["tokens"].as_array().unwrap().len(), 4, "{}", detail.body);
    assert_eq!(detail.body["activeTokens"], 2);
    t.clock.advance_ms(91 * DAY_MS);
    // The owner's session ended meanwhile.
    t.owner.clear();
    let login = json!({ "email": "joerg@example.de", "password": PASSWORD });
    assert_eq!(t.send(Method::POST, "/api/auth/login", Some(login), None).await.status, StatusCode::OK);
    let detail = t.owner(Method::GET, &format!("/service-accounts/{id}"), None).await;
    assert_eq!(detail.body["tokens"].as_array().unwrap().len(), 2, "{}", detail.body);
    t.finish().await;
}

#[tokio::test]
async fn deleting_an_account_ends_its_tokens() {
    let mut t = TestApp::new().await;
    let id = t.account("altes-reporting", "viewer").await;
    let (token, _) = t.token(&id, json!({ "name": "x" })).await;
    let r = t.owner(Method::DELETE, &format!("/service-accounts/{id}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.with_token(Method::GET, &t.path(""), None, &token).await.status, StatusCode::UNAUTHORIZED);
    let (users,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM users WHERE id = $1").bind(&id).fetch_one(&t.state.db).await.unwrap();
    assert_eq!(users, 0);
    let list = t.owner(Method::GET, "/service-accounts", None).await;
    assert_eq!(list.body["items"], json!([]));
    t.finish().await;
}

#[tokio::test]
async fn editors_cannot_manage_service_accounts_or_hand_out_more_than_they_hold() {
    let mut t = TestApp::new().await;
    let admin_account = t.account("admin-bot", "admin").await;
    // A custom role that may manage service accounts but holds little else.
    let role = t
        .owner(
            Method::POST,
            "/roles",
            Some(json!({ "name": "Bot-Verwalter", "description": "", "permissions": ["serviceaccounts:write", "dashboards:read"] })),
        )
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let role_id = role.body["id"].as_str().unwrap().to_string();
    let cookie = t.owner.clone();
    let r = t
        .send(
            Method::POST,
            "/api/admin/users",
            Some(json!({ "name": "Lea", "email": "lea@example.de", "password": PASSWORD })),
            Some(Who::Cookie(&cookie)),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    t.owner(Method::POST, "/members", Some(json!({ "email": "lea@example.de", "role": role_id }))).await;
    let saved = std::mem::take(&mut t.owner);
    let r = t
        .send(Method::POST, "/api/auth/login", Some(json!({ "email": "lea@example.de", "password": PASSWORD })), None)
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let lea = std::mem::replace(&mut t.owner, saved);

    let org = t.org.clone();
    let lea_path = |rest: &str| format!("/api/orgs/{org}{rest}");
    let (accounts, tokens) =
        (lea_path("/service-accounts"), lea_path(&format!("/service-accounts/{admin_account}/tokens")));
    let r = t.send(Method::GET, &accounts, None, Some(Who::Cookie(&lea))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // A token of the admin account would be more than Lea holds.
    let r = t.send(Method::POST, &tokens, Some(json!({ "name": "x" })), Some(Who::Cookie(&lea))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t
        .send(Method::POST, &accounts, Some(json!({ "name": "neu", "role": "viewer" })), Some(Who::Cookie(&lea)))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "a viewer holds more than Lea: {}", r.body);
    let r =
        t.send(Method::POST, &accounts, Some(json!({ "name": "neu", "role": role_id })), Some(Who::Cookie(&lea))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let r = t.send(Method::GET, &lea_path("/scim-token"), None, Some(Who::Cookie(&lea))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "the SCIM token needs users:write");
    t.finish().await;
}

#[tokio::test]
async fn one_scim_token_per_organization() {
    let mut t = TestApp::new().await;
    let r = t.owner(Method::GET, "/scim-token", None).await;
    assert_eq!(r.body, json!({ "token": null }));
    let first = t.owner(Method::POST, "/scim-token", Some(json!({}))).await;
    assert_eq!(first.status, StatusCode::CREATED, "{}", first.body);
    let first_token = first.body["token"].as_str().unwrap().to_string();
    assert!(first_token.starts_with("kz_scim_"));
    let second = t.owner(Method::POST, "/scim-token", Some(json!({ "expiresInDays": 365 }))).await;
    let second_id = second.body["id"].as_str().unwrap().to_string();
    let current = t.owner(Method::GET, "/scim-token", None).await;
    assert_eq!(current.body["token"]["id"], second_id.as_str(), "the new token replaces the old one");
    assert!(current.body["token"].get("token").is_none(), "the token itself is shown once");
    let (active,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM api_tokens WHERE kind = 'scim' AND revoked_at IS NULL")
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(active, 1);
    // SCIM tokens are not API tokens.
    let second_token = second.body["token"].as_str().unwrap().to_string();
    assert_eq!(t.with_token(Method::GET, &t.path(""), None, &second_token).await.status, StatusCode::UNAUTHORIZED);
    let r = t.owner(Method::DELETE, "/scim-token", None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(t.owner(Method::GET, "/scim-token", None).await.body, json!({ "token": null }));
    assert_eq!(t.owner(Method::DELETE, "/scim-token", None).await.status, StatusCode::NOT_FOUND);
    let actions: Vec<String> = t.audit_actions().await.into_iter().map(|(a, _)| a).collect();
    assert_eq!(actions.iter().filter(|a| *a == "scim.token_created").count(), 2);
    assert_eq!(actions.iter().filter(|a| *a == "scim.token_revoked").count(), 2);
    t.finish().await;
}

impl TestApp {
    /// Sends `count` requests with `token` at the same moment, each from its own task.
    async fn parallel_with_token(&self, path: &str, token: &str, count: usize) -> Vec<StatusCode> {
        let mut tasks = Vec::new();
        for _ in 0..count {
            let (app, path, bearer) = (self.app.clone(), path.to_string(), format!("Bearer {token}"));
            tasks.push(tokio::spawn(async move {
                let req = Request::builder()
                    .uri(path)
                    .header(header::HOST, "kalzit.test")
                    .header(header::AUTHORIZATION, bearer)
                    .body(Body::empty())
                    .unwrap();
                app.oneshot(req).await.unwrap().status()
            }));
        }
        let mut out = Vec::new();
        for task in tasks {
            out.push(task.await.unwrap());
        }
        out
    }

    /// A request with both the owner's session cookie and `token`.
    async fn both(&mut self, method: Method, path: &str, body: Option<Value>, token: &str) -> Reply {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, &self.owner)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if body.is_some() {
            req = req.header(header::CONTENT_TYPE, "application/json");
        }
        let req = req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        self.clock.advance_ms(1);
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }
}

/// Working tokens never use up the budget of refusals, however many arrive at once.
#[tokio::test]
async fn many_requests_with_a_working_token_at_once_all_pass() {
    let mut t = TestApp::new().await;
    let id = t.account("ci-dashboards", "viewer").await;
    let (token, _) = t.token(&id, json!({ "name": "ci" })).await;
    let statuses = t.parallel_with_token(&t.path("/dashboards"), &token, 25).await;
    assert!(statuses.iter().all(|s| *s == StatusCode::OK), "{statuses:?}");
    // Bad tokens from the same address are refused and counted; the good one goes on working.
    let unknown = format!("kz_sa_{}", "1".repeat(40));
    let path = t.path("");
    for _ in 0..12 {
        t.with_token(Method::GET, &path, None, &unknown).await;
    }
    let statuses = t.parallel_with_token(&t.path("/dashboards"), &token, 12).await;
    assert!(statuses.iter().all(|s| *s == StatusCode::OK), "{statuses:?}");
    t.finish().await;
}

/// Every change made with a token names the token in the audit log, never the token itself.
#[tokio::test]
async fn changes_made_with_a_token_name_it_in_the_audit_log() {
    let mut t = TestApp::new().await;
    let id = t.account("ci-dashboards", "editor").await;
    let (token, token_id) = t.token(&id, json!({ "name": "ci" })).await;
    let r = t.with_token(Method::POST, &t.path("/folders"), Some(json!({ "name": "Vertrieb" })), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    type Row = (String, Option<String>, Option<String>, Option<String>);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT action, actor_user_id, actor_token_id, actor_token_prefix FROM audit_events \
         WHERE actor_token_id IS NOT NULL",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let (action, actor, tid, prefix) = &rows[0];
    let prefix = prefix.clone().unwrap();
    assert!(action.starts_with("folder."), "{action}");
    assert_eq!((actor.as_deref(), tid.as_deref()), (Some(id.as_str()), Some(token_id.as_str())));
    assert!(token.starts_with(&prefix) && prefix.len() == 14);
    // The owner's own changes name no token; the audit API shows both.
    let audit = t.owner(Method::GET, "/audit?action=folder.", None).await;
    assert_eq!(audit.body["items"][0]["actorTokenId"], token_id.as_str(), "{}", audit.body);
    assert_eq!(audit.body["items"][0]["actorTokenPrefix"], prefix.as_str());
    let created = t.owner(Method::GET, "/audit?action=service_account.created", None).await;
    assert!(created.body["items"][0]["actorTokenId"].is_null(), "{}", created.body);
    t.finish().await;
}

/// The bearer token decides when both arrive; it never borrows the session's rights.
#[tokio::test]
async fn a_token_next_to_a_session_cookie_acts_as_the_token() {
    let mut t = TestApp::new().await;
    let id = t.account("leser", "viewer").await;
    let (token, _) = t.token(&id, json!({ "name": "x" })).await;
    let r = t.both(Method::GET, &t.path(""), None, &token).await;
    assert_eq!(r.body["role"], "viewer", "{}", r.body);
    let r = t.both(Method::POST, &t.path("/folders"), Some(json!({ "name": "Neu" })), &token).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "the owner's cookie lends nothing: {}", r.body);
    let r = t.both(Method::GET, "/api/me", None, &token).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "token.org_routes_only"));
    // Live updates (a WebSocket) are refused to tokens too: `routes::live_tests`.
    t.finish().await;
}

/// An admin service account cannot raise itself or anyone above its role.
#[tokio::test]
async fn a_token_cannot_raise_its_own_role_or_anyone_above_it() {
    let mut t = TestApp::new().await;
    let id = t.account("admin-bot", "admin").await;
    let (token, _) = t.token(&id, json!({ "name": "x" })).await;
    let own = t.path(&format!("/members/{id}"));
    for role in ["owner", "admin"] {
        let r = t.with_token(Method::PATCH, &own, Some(json!({ "role": role })), &token).await;
        assert!(matches!(r.status, StatusCode::NOT_FOUND | StatusCode::FORBIDDEN), "{role}: {}", r.body);
    }
    let cookie = t.owner.clone();
    let r = t
        .send(
            Method::POST,
            "/api/admin/users",
            Some(json!({ "name": "Vera", "email": "vera@example.de", "password": PASSWORD })),
            Some(Who::Cookie(&cookie)),
        )
        .await;
    let vera = r.body["id"].as_str().unwrap().to_string();
    t.owner(Method::POST, "/members", Some(json!({ "email": "vera@example.de", "role": "viewer" }))).await;
    let path = t.path(&format!("/members/{vera}"));
    let r = t.with_token(Method::PATCH, &path, Some(json!({ "role": "owner" })), &token).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "an admin does not make owners: {}", r.body);
    // A custom role with more than the account holds cannot be made either.
    let roles = t.path("/roles");
    let r = t
        .with_token(Method::POST, &roles, Some(json!({ "name": "Alles", "permissions": ["org:delete"] })), &token)
        .await;
    assert!(r.status.is_client_error(), "{}", r.body);
    let (custom,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM roles").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(custom, 0);
    let (role,): (String,) = sqlx::query_as("SELECT role FROM org_members WHERE user_id = $1")
        .bind(&id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(role, "admin");
    t.finish().await;
}

/// A service account never owns an organization.
#[tokio::test]
async fn a_service_account_cannot_own_a_new_organization() {
    let mut t = TestApp::new().await;
    let id = t.account("bot", "viewer").await;
    let cookie = t.owner.clone();
    let body = json!({ "name": "Neue Firma", "ownerUserId": id });
    let r = t.send(Method::POST, "/api/admin/orgs", Some(body), Some(Who::Cookie(&cookie))).await;
    assert_eq!((r.status, r.body["error"]["field"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("ownerUserId")));
    t.finish().await;
}

/// The SCIM token is for people who hold everything an admin holds.
#[tokio::test]
async fn the_scim_token_needs_an_admin() {
    let mut t = TestApp::new().await;
    let permissions = json!(["serviceaccounts:write", "users:write", "users:read"]);
    let role = t.owner(Method::POST, "/roles", Some(json!({ "name": "Leute", "permissions": permissions }))).await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let role_id = role.body["id"].as_str().unwrap().to_string();
    let cookie = t.owner.clone();
    let lea = json!({ "name": "Lea", "email": "lea@example.de", "password": PASSWORD });
    t.send(Method::POST, "/api/admin/users", Some(lea), Some(Who::Cookie(&cookie))).await;
    t.owner(Method::POST, "/members", Some(json!({ "email": "lea@example.de", "role": role_id }))).await;
    let saved = std::mem::take(&mut t.owner);
    let login = json!({ "email": "lea@example.de", "password": PASSWORD });
    assert_eq!(t.send(Method::POST, "/api/auth/login", Some(login), None).await.status, StatusCode::OK);
    let lea = std::mem::replace(&mut t.owner, saved);
    let path = t.path("/scim-token");
    let r = t.send(Method::POST, &path, Some(json!({})), Some(Who::Cookie(&lea))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert_eq!(t.owner(Method::POST, "/scim-token", Some(json!({}))).await.status, StatusCode::CREATED);
    t.finish().await;
}

/// The second factor is for people: a required one never holds up a token, and the overview and
/// resets leave service accounts out.
#[tokio::test]
async fn service_accounts_are_outside_the_second_factor_rules() {
    let mut t = TestApp::new().await;
    let id = t.account("bot", "admin").await;
    let (token, _) = t.token(&id, json!({ "name": "x" })).await;
    let cookie = t.owner.clone();
    let required = json!({ "value": "everyone", "version": 0 });
    let path = "/api/admin/settings/security.two_factor_required";
    let r = t.send(Method::PATCH, path, Some(required), Some(Who::Cookie(&cookie))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.with_token(Method::GET, &t.path("/dashboards"), None, &token).await.status, StatusCode::OK);
    let overview = t.send(Method::GET, "/api/admin/security/two-factor", None, Some(Who::Cookie(&cookie))).await;
    assert_eq!(overview.body["orgs"][0]["missing"], 1, "only the owner lacks one: {}", overview.body);
    let reset = t.path(&format!("/members/{id}/second-factor/reset"));
    let r = t.send(Method::POST, &reset, Some(json!({})), Some(Who::Cookie(&cookie))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    let reset = format!("/api/admin/users/{id}/second-factor/reset");
    let r = t.send(Method::POST, &reset, Some(json!({})), Some(Who::Cookie(&cookie))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    let (pending,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sign_in_challenges WHERE user_id = $1")
        .bind(&id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(pending, 0);
    t.finish().await;
}
