//! Service accounts, their API tokens and the SCIM token through the real router (SQLite).

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
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = TestApp { app, clock, state, dir: Arc::new(dir), org: String::new(), owner: String::new() };
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

    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
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
    // unknown. The budget is ten per window, then even a good token waits.
    for _ in 0..7 {
        assert_eq!(t.with_token(Method::GET, &path, None, &unknown).await.status, StatusCode::UNAUTHORIZED);
    }
    let r = t.with_token(Method::GET, &path, None, &good).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
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
