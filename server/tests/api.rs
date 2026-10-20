//! API behaviour through the real router and a real database (SQLite; PostgreSQL when
//! `KALZIT_TEST_POSTGRES_URL` is set).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const HOUR_MS: i64 = 3_600_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: tempfile::TempDir,
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

    fn session_cookie(&self) -> String {
        let set = self.headers.get(header::SET_COOKIE).expect("Set-Cookie").to_str().unwrap();
        set.split(';').next().unwrap().to_string()
    }
}

async fn test_app(peer: &str, tweak: impl FnOnce(&mut Config)) -> TestApp {
    test_app_on(None, peer, tweak).await
}

async fn test_app_on(db_url: Option<String>, peer: &str, tweak: impl FnOnce(&mut Config)) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    build(dir, db_url, peer, Some(SETUP_CODE.into()), tweak).await
}

async fn build(
    dir: tempfile::TempDir,
    db_url: Option<String>,
    peer: &str,
    setup_code: Option<String>,
    tweak: impl FnOnce(&mut Config),
) -> TestApp {
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    tweak(&mut config);
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), setup_code).await.unwrap();
    let peer: SocketAddr = peer.parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), clock, state, dir }
}

impl TestApp {
    async fn send(&self, method: Method, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        for (k, v) in headers {
            req = req.header(*k, *v);
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
        Reply { status, headers, body }
    }

    async fn get(&self, path: &str, cookie: Option<&str>) -> Reply {
        let headers: Vec<(&str, &str)> = cookie.map(|c| vec![("cookie", c)]).unwrap_or_default();
        self.send(Method::GET, path, None, &headers).await
    }

    async fn post(&self, path: &str, body: Value) -> Reply {
        self.send(Method::POST, path, Some(body), &[]).await
    }

    async fn setup(&self) -> Reply {
        self.post(
            "/api/setup",
            json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                    "email": "Joerg@Example.de", "password": PASSWORD }),
        )
        .await
    }

    async fn login(&self, email: &str, password: &str) -> Reply {
        self.post("/api/auth/login", json!({ "email": email, "password": password })).await
    }
}

#[tokio::test]
async fn setup_creates_owner_once() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": true }));

    let r = t.setup().await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["email"], "joerg@example.de");
    assert_eq!(r.body["isServerAdmin"], true);
    assert_eq!(r.body["orgs"][0]["name"], "Müller & Söhne");
    assert_eq!(r.body["orgs"][0]["role"], "owner");

    let me = t.get("/api/me", Some(&r.session_cookie())).await;
    assert_eq!(me.status, StatusCode::OK);
    assert_eq!(me.body["name"], "Jörg Müller");

    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": false }));
    let again = t.setup().await;
    assert_eq!((again.status, again.code()), (StatusCode::CONFLICT, "setup_done"));
}

#[tokio::test]
async fn setup_rejects_wrong_code_and_weak_password() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let wrong = t
        .post(
            "/api/setup",
            json!({ "token": "nope", "orgName": "A", "name": "B", "email": "b@example.de", "password": PASSWORD }),
        )
        .await;
    assert_eq!((wrong.status, wrong.code()), (StatusCode::FORBIDDEN, "invalid_setup_token"));

    let weak = t
        .post(
            "/api/setup",
            json!({ "token": SETUP_CODE, "orgName": "A", "name": "B", "email": "b@example.de", "password": "kurz" }),
        )
        .await;
    assert_eq!((weak.status, weak.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"));
    assert_eq!(weak.body["error"]["field"], "password");
    for (body, field) in [
        (
            json!({ "token": SETUP_CODE, "orgName": " ", "name": "B", "email": "b@example.de", "password": PASSWORD }),
            "orgName",
        ),
        (
            json!({ "token": SETUP_CODE, "orgName": "A", "name": "x".repeat(101), "email": "b@example.de", "password": PASSWORD }),
            "name",
        ),
        (
            json!({ "token": SETUP_CODE, "orgName": "A", "name": "B", "email": "admin@localhost", "password": PASSWORD }),
            "email",
        ),
    ] {
        assert_eq!(t.post("/api/setup", body).await.body["error"]["field"], field);
    }
    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": true }));
}

#[tokio::test]
async fn malformed_and_unknown_fields_use_the_error_format() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let r = t.post("/api/auth/login", json!({ "email": "a@b.de", "password": "x", "admin": true })).await;
    assert_eq!(r.code(), "validation", "{}", r.body);
    let r = t.send(Method::POST, "/api/auth/login", None, &[("content-type", "application/json")]).await;
    assert_eq!(r.code(), "validation");
}

#[tokio::test]
async fn login_logout_and_me() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    t.setup().await;

    let unknown = t.login("niemand@example.de", PASSWORD).await;
    let wrong = t.login("joerg@example.de", "falsches Passwort").await;
    for r in [&unknown, &wrong] {
        assert_eq!((r.status, r.code()), (StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }
    assert_eq!(unknown.body, wrong.body, "unknown and wrong must look the same");

    let ok = t.login("  JOERG@example.de ", PASSWORD).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    let set_cookie = ok.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set_cookie.contains("HttpOnly") && set_cookie.contains("SameSite=Lax"));
    assert!(!set_cookie.contains("Secure"), "plain HTTP without a proxy must not set Secure");
    let cookie = ok.session_cookie();
    assert_eq!(t.get("/api/me", Some(&cookie)).await.status, StatusCode::OK);

    let out = t.send(Method::POST, "/api/auth/logout", None, &[("cookie", &cookie)]).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert!(out.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().contains("Max-Age=0"));
    let after = t.get("/api/me", Some(&cookie)).await;
    assert_eq!((after.status, after.code()), (StatusCode::UNAUTHORIZED, "unauthenticated"));
}

#[tokio::test]
async fn sessions_expire_after_lifetime_and_idle_time() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.sessions.lifetime_hours = 10;
        c.sessions.idle_timeout_hours = 3;
    })
    .await;
    let cookie = t.setup().await.session_cookie();

    // Active use keeps the session alive past the idle limit...
    for _ in 0..4 {
        t.clock.advance_ms(2 * HOUR_MS);
        assert_eq!(t.get("/api/me", Some(&cookie)).await.status, StatusCode::OK);
    }
    // ...but not past its lifetime.
    t.clock.advance_ms(2 * HOUR_MS + 1);
    assert_eq!(t.get("/api/me", Some(&cookie)).await.status, StatusCode::UNAUTHORIZED);

    let idle = t.login("joerg@example.de", PASSWORD).await.session_cookie();
    t.clock.advance_ms(3 * HOUR_MS);
    assert_eq!(t.get("/api/me", Some(&idle)).await.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn repeated_failures_are_rate_limited_even_with_the_right_password() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 3;
        c.security.login_window_secs = 600;
    })
    .await;
    t.setup().await;
    for _ in 0..3 {
        assert_eq!(t.login("joerg@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    let blocked = t.login("joerg@example.de", PASSWORD).await;
    assert_eq!((blocked.status, blocked.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));

    t.clock.advance_ms(600_000);
    assert_eq!(t.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);
}

#[tokio::test]
async fn cross_origin_writes_are_rejected() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    t.setup().await;
    let body = json!({ "email": "joerg@example.de", "password": PASSWORD });
    let evil = t.send(Method::POST, "/api/auth/login", Some(body.clone()), &[("origin", "https://evil.example")]).await;
    assert_eq!((evil.status, evil.code()), (StatusCode::FORBIDDEN, "cross_origin"));
    let same = t.send(Method::POST, "/api/auth/login", Some(body), &[("origin", "http://kalzit.test")]).await;
    assert_eq!(same.status, StatusCode::OK);
}

#[tokio::test]
async fn public_url_decides_the_allowed_origin() {
    let t = test_app("127.0.0.1:50000", |c| c.server.public_url = Some("https://kalzit.example.com".into())).await;
    t.setup().await;
    let body = json!({ "email": "joerg@example.de", "password": PASSWORD });
    let host_only =
        t.send(Method::POST, "/api/auth/login", Some(body.clone()), &[("origin", "http://kalzit.test")]).await;
    assert_eq!(host_only.status, StatusCode::FORBIDDEN);
    let public = t.send(Method::POST, "/api/auth/login", Some(body), &[("origin", "https://kalzit.example.com")]).await;
    assert_eq!(public.status, StatusCode::OK);
}

#[tokio::test]
async fn security_headers_and_hsts_only_over_https() {
    let t = test_app("10.1.2.3:50000", |c| c.security.trusted_proxies = vec!["10.0.0.0/8".parse().unwrap()]).await;
    let plain = t.get("/healthz", None).await;
    let csp = plain.headers.get("content-security-policy").unwrap().to_str().unwrap();
    assert!(csp.contains("script-src 'self'") && !csp.contains("unsafe-inline"));
    assert_eq!(plain.headers.get("x-content-type-options").unwrap(), "nosniff");
    assert!(plain.headers.get("strict-transport-security").is_none());

    let via_proxy = t.send(Method::GET, "/healthz", None, &[("x-forwarded-proto", "https")]).await;
    assert!(via_proxy.headers.get("strict-transport-security").is_some());
}

#[tokio::test]
async fn untrusted_clients_cannot_claim_https() {
    let t = test_app("203.0.113.5:50000", |c| c.security.trusted_proxies = vec!["10.0.0.0/8".parse().unwrap()]).await;
    let r = t.send(Method::GET, "/healthz", None, &[("x-forwarded-proto", "https")]).await;
    assert!(r.headers.get("strict-transport-security").is_none());
}

#[tokio::test]
async fn health_ready_and_unknown_api_routes() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    assert_eq!(t.get("/healthz", None).await.status, StatusCode::OK);
    assert_eq!(t.get("/readyz", None).await.status, StatusCode::OK);
    let missing = t.get("/api/does-not-exist", None).await;
    assert_eq!((missing.status, missing.code()), (StatusCode::NOT_FOUND, "not_found"));
}

#[tokio::test]
async fn generated_setup_code_lives_in_a_private_file_until_setup() {
    let t = build(tempfile::tempdir().unwrap(), None, "127.0.0.1:50000", None, |_| {}).await;
    let file = t.dir.path().join("setup-token.txt");
    let code = std::fs::read_to_string(&file).unwrap().trim().to_string();
    assert_eq!(code.len(), 29, "{code}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let r = t
        .post(
            "/api/setup",
            json!({ "token": code.to_uppercase(), "orgName": "A", "name": "B", "email": "b@example.de",
                    "password": PASSWORD }),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(!file.exists(), "the code must be gone once setup is done");

    // A stray file from an interrupted run is removed when the server starts with users present.
    std::fs::write(&file, "old code\n").unwrap();
    let pool = t.state.db.clone();
    AppState::new((*t.state.config).clone(), pool, t.clock.clone(), None).await.unwrap();
    assert!(!file.exists());
}

#[tokio::test]
async fn weak_fixed_setup_codes_are_refused_at_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    let pool = kalzit::db::connect(&config.database_url(), 1).await.unwrap();
    for weak in ["----", "short-code"] {
        let clock = Arc::new(ManualClock::new(0));
        assert!(AppState::new(config.clone(), pool.clone(), clock, Some(weak.into())).await.is_err(), "{weak}");
    }
}

#[tokio::test]
async fn parallel_wrong_passwords_cannot_exceed_the_limit() {
    let t = test_app("127.0.0.1:50000", |c| c.security.login_max_failures = 3).await;
    t.setup().await;
    // All requests are in flight at once, so each reaches the limiter before any password check
    // has finished.
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let app = t.app.clone();
        set.spawn(async move {
            let body = json!({ "email": "joerg@example.de", "password": "falsch falsch falsch" });
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header(header::HOST, "kalzit.test")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap();
            app.oneshot(req).await.unwrap().status()
        });
    }
    let statuses = set.join_all().await;
    let unauthorized = statuses.iter().filter(|s| **s == StatusCode::UNAUTHORIZED).count();
    let limited = statuses.iter().filter(|s| **s == StatusCode::TOO_MANY_REQUESTS).count();
    assert_eq!((unauthorized, limited), (3, 17));
}

#[tokio::test]
async fn behind_a_trusted_proxy_the_real_client_is_limited() {
    let t = test_app("10.0.0.1:50000", |c| {
        c.security.trusted_proxies = vec!["10.0.0.0/8".parse().unwrap()];
        c.security.login_max_failures = 2;
    })
    .await;
    t.setup().await;
    let body = json!({ "email": "niemand@example.de", "password": "falsch falsch falsch" });
    // The client changes its own X-Forwarded-For line each time; the proxy's line stays.
    for spoof in ["1.1.1.1", "2.2.2.2"] {
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/auth/login")
            .header(header::HOST, "kalzit.test")
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-forwarded-for", spoof)
            .header("x-forwarded-for", "203.0.113.5")
            .body(Body::from(body.to_string()))
            .unwrap();
        assert_eq!(t.app.clone().oneshot(req).await.unwrap().status(), StatusCode::UNAUTHORIZED);
    }
    let other_email = json!({ "email": "jemand@example.de", "password": "falsch falsch falsch" });
    let r = t
        .send(Method::POST, "/api/auth/login", Some(other_email), &[("x-forwarded-for", "9.9.9.9, 203.0.113.5")])
        .await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "the client address 203.0.113.5 is used up");
}

#[tokio::test]
async fn cookie_is_secure_behind_a_trusted_tls_proxy() {
    let t =
        test_app("[::ffff:10.0.0.1]:50000", |c| c.security.trusted_proxies = vec!["10.0.0.0/8".parse().unwrap()]).await;
    let r = t
        .send(
            Method::POST,
            "/api/setup",
            Some(json!({ "token": SETUP_CODE, "orgName": "A", "name": "B", "email": "b@example.de",
                         "password": PASSWORD })),
            &[("x-forwarded-proto", "https")],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().contains("; Secure"));
}

#[tokio::test]
async fn huge_emails_are_refused_without_tracking() {
    let t = test_app("127.0.0.1:50000", |c| c.security.login_max_failures = 1).await;
    t.setup().await;
    let huge = format!("{}@example.de", "a".repeat(300_000));
    for _ in 0..3 {
        assert_eq!(t.login(&huge, "x").await.code(), "invalid_credentials");
    }
}

#[tokio::test]
async fn signing_in_again_ends_the_previous_session_of_this_browser() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let first = t.setup().await.session_cookie();
    let body = json!({ "email": "joerg@example.de", "password": PASSWORD });
    let second = t.send(Method::POST, "/api/auth/login", Some(body), &[("cookie", &first)]).await;
    assert_eq!(second.status, StatusCode::OK);
    assert_eq!(t.get("/api/me", Some(&first)).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.get("/api/me", Some(&second.session_cookie())).await.status, StatusCode::OK);
}

#[tokio::test]
async fn ended_sessions_are_cleaned_up() {
    let t = test_app("127.0.0.1:50000", |c| c.sessions.lifetime_hours = 1).await;
    t.setup().await;
    t.login("joerg@example.de", PASSWORD).await;
    let cfg = &t.state.config.sessions;
    assert_eq!(kalzit::auth::session::delete_ended(&t.state.db, cfg, t.clock.now_ms()).await.unwrap(), 0);
    t.clock.advance_ms(HOUR_MS);
    assert_eq!(kalzit::auth::session::delete_ended(&t.state.db, cfg, t.clock.now_ms()).await.unwrap(), 2);
}

#[tokio::test]
async fn public_url_origin_ignores_default_port_but_not_scheme() {
    let t = test_app("127.0.0.1:50000", |c| c.server.public_url = Some("https://kalzit.example:443".into())).await;
    t.setup().await;
    let body = json!({ "email": "joerg@example.de", "password": PASSWORD });
    let ok = t.send(Method::POST, "/api/auth/login", Some(body.clone()), &[("origin", "https://Kalzit.example")]).await;
    assert_eq!(ok.status, StatusCode::OK);
    let http = t.send(Method::POST, "/api/auth/login", Some(body), &[("origin", "http://kalzit.example")]).await;
    assert_eq!(http.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn org_routes_check_membership_and_report_permissions() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let owner = t.setup().await;
    let cookie = owner.session_cookie();
    let org_id = owner.body["orgs"][0]["id"].as_str().unwrap().to_string();

    let org = t.get(&format!("/api/orgs/{org_id}"), Some(&cookie)).await;
    assert_eq!(org.status, StatusCode::OK, "{}", org.body);
    assert_eq!(org.body["role"], "owner");
    let perms: Vec<&str> = org.body["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    assert!(perms.contains(&"org:delete") && perms.contains(&"dashboards:write"));

    assert_eq!(t.get(&format!("/api/orgs/{org_id}"), None).await.code(), "unauthenticated");

    // Another organization the owner does not belong to looks like it does not exist.
    let db = &t.state.db;
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('other', 'Andere', 0)").execute(db).await.unwrap();
    let other = t.get("/api/orgs/other", Some(&cookie)).await;
    assert_eq!((other.status, other.code()), (StatusCode::NOT_FOUND, "not_found"));

    // A viewer sees the org with a narrow permission set.
    sqlx::query("UPDATE org_members SET role = 'viewer'").execute(db).await.unwrap();
    let viewer = t.get(&format!("/api/orgs/{org_id}"), Some(&cookie)).await;
    assert_eq!(viewer.body["role"], "viewer");
    let perms = viewer.body["permissions"].as_array().unwrap();
    assert!(perms.iter().all(|p| p != "dashboards:write" && p != "users:write"), "{perms:?}");
}

#[tokio::test]
async fn migrations_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    // Spaces, umlauts and a '#' in the path must survive the URL round trip.
    let folder = dir.path().join("Daten mit Ümlaut #1");
    std::fs::create_dir_all(&folder).unwrap();
    let url = kalzit::config::sqlite_url(&folder.join("kalzit.db"));
    kalzit::db::connect(&url, 1).await.unwrap().close().await;
    kalzit::db::connect(&url, 1).await.unwrap().close().await;
}

/// The same flow on PostgreSQL, in a throwaway schema so the test database is left as it was.
#[tokio::test]
async fn postgres_setup_and_login() {
    let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
        eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL test not run");
        return;
    };
    let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
    sqlx::any::install_default_drivers();
    let admin = sqlx::AnyPool::connect(&base).await.unwrap();
    // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
    let sep = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{sep}options=-csearch_path%3D{schema}");

    let t = test_app_on(Some(url), "127.0.0.1:50000", |c| c.sessions.idle_timeout_hours = 2).await;
    let setup = t.setup().await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    assert_eq!(t.setup().await.code(), "setup_done");
    let cookie = t.login("joerg@example.de", PASSWORD).await.session_cookie();
    let me = t.get("/api/me", Some(&cookie)).await;
    assert_eq!((me.status, me.body["orgs"][0]["role"].as_str()), (StatusCode::OK, Some("owner")));
    t.send(Method::POST, "/api/auth/logout", None, &[("cookie", &cookie)]).await;
    assert_eq!(t.get("/api/me", Some(&cookie)).await.status, StatusCode::UNAUTHORIZED);

    let idle = t.login("joerg@example.de", PASSWORD).await.session_cookie();
    t.clock.advance_ms(3 * HOUR_MS);
    let ended = kalzit::auth::session::delete_ended(&t.state.db, &t.state.config.sessions, t.clock.now_ms());
    assert!(ended.await.unwrap() >= 1);
    assert_eq!(t.get("/api/me", Some(&idle)).await.status, StatusCode::UNAUTHORIZED);
    drop(t);

    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
}
