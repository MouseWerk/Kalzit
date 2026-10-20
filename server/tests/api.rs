//! API behaviour through the real router and a real database (SQLite; PostgreSQL when
//! `GRANIT_TEST_POSTGRES_URL` is set).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use granit::app::{AppState, router};
use granit::clock::ManualClock;
use granit::config::Config;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code";
const PASSWORD: &str = "Grün und sicher 2026";
const HOUR_MS: i64 = 3_600_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    _dir: tempfile::TempDir,
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
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    tweak(&mut config);
    let pool = granit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = peer.parse().unwrap();
    TestApp { app: router(state).layer(MockConnectInfo(peer)), clock, _dir: dir }
}

impl TestApp {
    async fn send(&self, method: Method, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "granit.test");
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
    assert_eq!((evil.status, evil.code()), (StatusCode::FORBIDDEN, "forbidden"));
    let same = t.send(Method::POST, "/api/auth/login", Some(body), &[("origin", "http://granit.test")]).await;
    assert_eq!(same.status, StatusCode::OK);
}

#[tokio::test]
async fn public_url_decides_the_allowed_origin() {
    let t = test_app("127.0.0.1:50000", |c| c.server.public_url = Some("https://granit.example.com".into())).await;
    t.setup().await;
    let body = json!({ "email": "joerg@example.de", "password": PASSWORD });
    let host_only =
        t.send(Method::POST, "/api/auth/login", Some(body.clone()), &[("origin", "http://granit.test")]).await;
    assert_eq!(host_only.status, StatusCode::FORBIDDEN);
    let public = t.send(Method::POST, "/api/auth/login", Some(body), &[("origin", "https://granit.example.com")]).await;
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
async fn migrations_are_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    // Spaces, umlauts and a '#' in the path must survive the URL round trip.
    let folder = dir.path().join("Daten mit Ümlaut #1");
    std::fs::create_dir_all(&folder).unwrap();
    let url = granit::config::sqlite_url(&folder.join("granit.db"));
    granit::db::connect(&url, 1).await.unwrap().close().await;
    granit::db::connect(&url, 1).await.unwrap().close().await;
}

/// The same flow on PostgreSQL, in a throwaway schema so the test database is left as it was.
#[tokio::test]
async fn postgres_setup_and_login() {
    let Ok(base) = std::env::var("GRANIT_TEST_POSTGRES_URL") else {
        eprintln!("GRANIT_TEST_POSTGRES_URL not set, PostgreSQL test not run");
        return;
    };
    let schema = format!("granit_test_{}", uuid::Uuid::now_v7().simple());
    sqlx::any::install_default_drivers();
    let admin = sqlx::AnyPool::connect(&base).await.unwrap();
    // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
    let sep = if base.contains('?') { '&' } else { '?' };
    let url = format!("{base}{sep}options=-csearch_path%3D{schema}");

    let t = test_app_on(Some(url), "127.0.0.1:50000", |_| {}).await;
    let setup = t.setup().await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    assert_eq!(t.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);
    drop(t);

    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
}
