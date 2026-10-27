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

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const HOUR_MS: i64 = 3_600_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

impl TestApp {
    /// Stops the app and deletes its data directory (`common::Finish`).
    async fn finish(self) {
        let finish = self.finisher();
        drop(self);
        finish.finish().await;
    }

    /// What `finish` does, for a test that hands the app on by value.
    fn finisher(&self) -> common::Finish {
        common::Finish::new(self.state.clone(), self.dir.clone())
    }
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
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), clock, state, dir: Arc::new(dir) }
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

    /// The same server, asked from the client `address`.
    fn from(&self, address: &str) -> TestApp {
        let peer: SocketAddr = address.parse().unwrap();
        TestApp {
            app: router(self.state.clone()).layer(MockConnectInfo(peer)),
            clock: self.clock.clone(),
            state: self.state.clone(),
            dir: self.dir.clone(),
        }
    }
}

/// Setup claims the one `setup_lock` row first: when another server on the same database already
/// holds it (setup done there, or running at this moment), this one answers `setup_done` and
/// leaves nothing behind, without relying on the user count.
#[tokio::test]
async fn setup_is_refused_once_another_server_claimed_it() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    sqlx::query("INSERT INTO setup_lock (id, done_at) VALUES (1, 0)").execute(&t.state.db).await.unwrap();
    let r = t.setup().await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "setup_done"), "{}", r.body);
    for table in ["users", "orgs", "org_members", "sessions"] {
        let (n,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": false }));
    t.finish().await;
}

#[tokio::test]
async fn setup_creates_owner_once() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": true, "codeHint": "fixed" }));

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
    t.finish().await;
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
    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": true, "codeHint": "fixed" }));
    t.finish().await;
}

#[tokio::test]
async fn malformed_and_unknown_fields_use_the_error_format() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let r = t.post("/api/auth/login", json!({ "email": "a@b.de", "password": "x", "admin": true })).await;
    assert_eq!(r.code(), "validation", "{}", r.body);
    let r = t.send(Method::POST, "/api/auth/login", None, &[("content-type", "application/json")]).await;
    assert_eq!(r.code(), "validation");
    t.finish().await;
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
    // Signing out is audited once; an ended session's cookie signs out without a second entry.
    let again = t.send(Method::POST, "/api/auth/logout", None, &[("cookie", &cookie)]).await;
    assert_eq!(again.status, StatusCode::NO_CONTENT);
    let signed_out: Vec<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT actor_user_id, actor_address FROM audit_events WHERE action = 'auth.signed_out'")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(signed_out.len(), 1);
    assert!(signed_out[0].0.is_some());
    assert_eq!(signed_out[0].1.as_deref(), Some("127.0.0.1"));
    t.finish().await;
}

/// The session cookie follows the scheme the request arrived with: over HTTPS (here reported by a
/// trusted proxy) it is `Secure` with the `__Host-` prefix and only that name is read; over plain
/// HTTP it stays a plain cookie even with an `https://` public URL, since a browser would not
/// send a `Secure` cookie back over HTTP and the sign-in would be lost.
#[tokio::test]
async fn the_session_cookie_follows_the_request_scheme() {
    let t = test_app("10.1.2.3:50000", |c| {
        c.server.public_url = Some("https://kalzit.example.com".into());
        c.security.trusted_proxies = vec!["10.0.0.0/8".parse().unwrap()];
    })
    .await;
    t.setup().await;
    let body = json!({ "email": "joerg@example.de", "password": PASSWORD });
    let origin = ("origin", "https://kalzit.example.com");

    let secure =
        t.send(Method::POST, "/api/auth/login", Some(body.clone()), &[origin, ("x-forwarded-proto", "https")]).await;
    assert_eq!(secure.status, StatusCode::OK, "{}", secure.body);
    let set_cookie = secure.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set_cookie.starts_with("__Host-kalzit_session="), "{set_cookie}");
    assert!(set_cookie.contains("; Secure") && set_cookie.contains("Path=/") && !set_cookie.contains("Domain"));
    let cookie = secure.session_cookie();
    let over_https = |cookie: String| {
        let t = &t;
        async move {
            t.send(Method::GET, "/api/me", None, &[("cookie", &cookie), ("x-forwarded-proto", "https")]).await.status
        }
    };
    assert_eq!(over_https(cookie.clone()).await, StatusCode::OK);
    let token = cookie.split_once('=').unwrap().1;
    assert_eq!(over_https(format!("kalzit_session={token}")).await, StatusCode::UNAUTHORIZED);

    let plain = t.send(Method::POST, "/api/auth/login", Some(body), &[origin]).await;
    assert_eq!(plain.status, StatusCode::OK, "{}", plain.body);
    let set_cookie = plain.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(set_cookie.starts_with("kalzit_session=") && !set_cookie.contains("Secure"), "{set_cookie}");
    assert_eq!(t.get("/api/me", Some(&plain.session_cookie())).await.status, StatusCode::OK);
    t.finish().await;
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
        // The last-seen update runs in the background; it lands before the clock moves on.
        t.state.touches.settle().await;
    }
    // ...but not past its lifetime.
    t.clock.advance_ms(2 * HOUR_MS + 1);
    assert_eq!(t.get("/api/me", Some(&cookie)).await.status, StatusCode::UNAUTHORIZED);

    let idle = t.login("joerg@example.de", PASSWORD).await.session_cookie();
    t.clock.advance_ms(3 * HOUR_MS);
    assert_eq!(t.get("/api/me", Some(&idle)).await.status, StatusCode::UNAUTHORIZED);
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
}

#[tokio::test]
async fn untrusted_clients_cannot_claim_https() {
    let t = test_app("203.0.113.5:50000", |c| c.security.trusted_proxies = vec!["10.0.0.0/8".parse().unwrap()]).await;
    let r = t.send(Method::GET, "/healthz", None, &[("x-forwarded-proto", "https")]).await;
    assert!(r.headers.get("strict-transport-security").is_none());
    t.finish().await;
}

#[tokio::test]
async fn health_ready_and_unknown_api_routes() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    assert_eq!(t.get("/healthz", None).await.status, StatusCode::OK);
    assert_eq!(t.get("/readyz", None).await.status, StatusCode::OK);
    let missing = t.get("/api/does-not-exist", None).await;
    assert_eq!((missing.status, missing.code()), (StatusCode::NOT_FOUND, "not_found"));
    t.finish().await;
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
    t.finish().await;
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
    pool.close().await;
    common::remove_dir(dir);
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
    // At most the limit is checked; the checks in flight per account may refuse some sooner.
    assert_eq!(unauthorized + limited, 20, "{statuses:?}");
    assert!((1..=3).contains(&unauthorized), "{unauthorized}");
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
}

#[tokio::test]
async fn huge_emails_are_refused_without_tracking() {
    let t = test_app("127.0.0.1:50000", |c| c.security.login_max_failures = 1).await;
    t.setup().await;
    let huge = format!("{}@example.de", "a".repeat(300_000));
    for _ in 0..3 {
        assert_eq!(t.login(&huge, "x").await.code(), "invalid_credentials");
    }
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
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
    t.finish().await;
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
    let other_id = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
        .bind(&other_id)
        .execute(db)
        .await
        .unwrap();
    let other = t.get(&format!("/api/orgs/{other_id}"), Some(&cookie)).await;
    assert_eq!((other.status, other.code()), (StatusCode::NOT_FOUND, "not_found"));

    // A viewer sees the org with a narrow permission set.
    sqlx::query("UPDATE org_members SET role = 'viewer'").execute(db).await.unwrap();
    let viewer = t.get(&format!("/api/orgs/{org_id}"), Some(&cookie)).await;
    assert_eq!(viewer.body["role"], "viewer");
    let perms = viewer.body["permissions"].as_array().unwrap();
    assert!(perms.iter().all(|p| p != "dashboards:write" && p != "users:write"), "{perms:?}");
    t.finish().await;
}

/// Every declared route except the public ones refuses strangers before its handler runs: no
/// session answers 401, a member of another organization 404, a non-admin on /admin 403.
#[tokio::test]
async fn every_declared_route_enforces_its_access() {
    use kalzit::authz::Access;
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let cookie = t.setup().await.session_cookie();
    sqlx::query("UPDATE users SET is_server_admin = 0").execute(&t.state.db).await.unwrap();
    let foreign_org = uuid::Uuid::now_v7().to_string();
    let any_id = uuid::Uuid::now_v7().to_string();
    let mut checked = 0;
    for def in kalzit::routes::all() {
        let path = format!("/api{}", def.path)
            .replace("{orgId}", &foreign_org)
            .split('/')
            .map(|s| if s.starts_with('{') { any_id.as_str() } else { s })
            .collect::<Vec<_>>()
            .join("/");
        let body = (def.method != Method::GET).then(|| json!({}));
        let (anon_status, member_status) = match def.access {
            Access::Org(_) | Access::OrgMember => (StatusCode::UNAUTHORIZED, StatusCode::NOT_FOUND),
            Access::ServerAdmin => (StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN),
            Access::Authenticated => {
                let anon = t.send(def.method.clone(), &path, body, &[]).await;
                assert_eq!(anon.status, StatusCode::UNAUTHORIZED, "{} {path} without a session", def.method);
                checked += 1;
                continue;
            }
            Access::Public => continue,
        };
        let anon = t.send(def.method.clone(), &path, body.clone(), &[]).await;
        assert_eq!(anon.status, anon_status, "{} {path} without a session", def.method);
        let member = t.send(def.method.clone(), &path, body, &[("cookie", &cookie)]).await;
        assert_eq!(member.status, member_status, "{} {path} as a stranger: {}", def.method, member.body);
        checked += 1;
    }
    assert!(checked > 0);
    t.finish().await;
}

#[tokio::test]
async fn setup_and_sign_ins_are_audited_without_personal_data() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    t.setup().await;
    t.login("joerg@example.de", "falsch falsch falsch").await;
    t.login("niemand@example.de", "falsch falsch falsch").await;
    t.login("joerg@example.de", PASSWORD).await;
    let rows: Vec<(String, Option<String>, String)> =
        sqlx::query_as("SELECT action, actor_user_id, summary FROM audit_events ORDER BY created_at, id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    let actions: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(actions, ["setup.completed", "auth.sign_in_failed", "auth.sign_in_failed", "auth.signed_in"]);
    for (_, _, summary) in &rows {
        assert!(!summary.contains('@'), "no email in audit summaries: {summary}");
    }
    assert!(rows[1].2.contains("userId"), "a failed sign-in of a known account names the account id");
    assert_eq!(rows[2].2, "{}", "an unknown email leaves no trace of what was typed");
    assert!(rows[3].1.is_some());
    t.finish().await;
}

#[tokio::test]
async fn unsupported_methods_answer_in_the_error_format() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let r = t.send(Method::DELETE, "/api/me", None, &[]).await;
    assert_eq!((r.status, r.code()), (StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed"));
    t.finish().await;
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
    t.finish().await;

    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
}

/// A rate-limited sign-in says how long to wait, as `Retry-After` and `retryAfterSecs`, and the
/// wait counts down with the clock.
#[tokio::test]
async fn a_rate_limited_sign_in_names_the_wait() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 3;
        c.security.login_window_secs = 600;
    })
    .await;
    t.setup().await;
    for _ in 0..3 {
        assert_eq!(t.login("joerg@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    let wait = |r: &Reply| {
        assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
        let header = r.headers.get(header::RETRY_AFTER).expect("Retry-After").to_str().unwrap().to_string();
        let secs = r.body["error"]["retryAfterSecs"].as_u64().expect("retryAfterSecs");
        assert_eq!(header, secs.to_string());
        secs
    };
    assert_eq!(wait(&t.login("joerg@example.de", PASSWORD).await), 600);
    // 349.5 seconds left are 350.
    t.clock.advance_ms(250_500);
    assert_eq!(wait(&t.login("joerg@example.de", PASSWORD).await), 350);
    t.clock.advance_ms(349_000);
    assert_eq!(wait(&t.login("joerg@example.de", PASSWORD).await), 1);
    t.clock.advance_ms(500);
    assert_eq!(t.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);
    t.finish().await;
}

/// The value of the cookie `name` that a reply sets, as `name=value` for a `Cookie` header.
fn set_cookie(reply: &Reply, name: &str) -> String {
    reply
        .headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with(&format!("{name}=")))
        .and_then(|v| v.split(';').next())
        .unwrap_or_else(|| panic!("no {name} cookie"))
        .to_string()
}

impl TestApp {
    async fn login_with(&self, email: &str, password: &str, cookie: &str) -> Reply {
        let body = json!({ "email": email, "password": password });
        self.send(Method::POST, "/api/auth/login", Some(body), &[("cookie", cookie)]).await
    }
}

/// The account rule: wrong passwords from many networks, one each, so no address or account at
/// an address is limited, use up the account's shared budget. A browser that signed in to the
/// account before (its device cookie) still gets in, from any address; any other browser is
/// refused, the right password included, with the whole window as the wait. A new password
/// revokes the device cookies.
#[tokio::test]
async fn a_known_device_signs_in_while_the_account_is_under_attack() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 3;
        c.security.login_window_secs = 600;
    })
    .await;
    t.setup().await;
    let owner = t.from("198.51.100.7:1");
    let signed_in = owner.login("joerg@example.de", PASSWORD).await;
    assert_eq!(signed_in.status, StatusCode::OK);
    let device = set_cookie(&signed_in, "kalzit_device");
    assert!(
        signed_in.headers.get_all(header::SET_COOKIE).iter().any(|v| {
            let v = v.to_str().unwrap();
            v.starts_with("kalzit_device=") && v.contains("HttpOnly") && v.contains("Max-Age=7776000")
        }),
        "the device cookie is HttpOnly and lasts 90 days"
    );

    for i in 1..=3 {
        let attacker = t.from(&format!("[2001:db8:{i:x}::1]:1"));
        assert_eq!(attacker.login("joerg@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    for client in [t.from("203.0.113.9:1"), t.from("[2001:db8:ff::1]:1")] {
        let r = client.login("joerg@example.de", PASSWORD).await;
        assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
        assert_eq!(r.body["error"]["retryAfterSecs"], 600);
    }
    // A device cookie of another account, or a forged one, does not help.
    let forged = device.replacen("kalzit_device=v2.", "kalzit_device=v2.9", 1);
    assert_eq!(
        t.from("203.0.113.9:1").login_with("joerg@example.de", PASSWORD, &forged).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    // The owner's browser gets in, at home and elsewhere.
    let again = owner.login_with("joerg@example.de", PASSWORD, &device).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    let travelling = t.from("192.0.2.200:1");
    assert_eq!(travelling.login_with("joerg@example.de", PASSWORD, &device).await.status, StatusCode::OK);

    // A new password revokes the device cookies of the account.
    let session = again.session_cookie();
    let changed = owner
        .send(
            Method::POST,
            "/api/me/password",
            Some(json!({ "current": PASSWORD, "new": "Ein ganz neues Passwort 2026" })),
            &[("cookie", &session)],
        )
        .await;
    assert_eq!(changed.status, StatusCode::NO_CONTENT, "{}", changed.body);
    let r = travelling.login_with("joerg@example.de", "Ein ganz neues Passwort 2026", &device).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    drop((owner, travelling));
    t.finish().await;
}

/// Guessing spread over many networks gets only the account's shared budget, not the budget of
/// every address: after it, every guess is refused, the right one included.
#[tokio::test]
async fn distributed_guessing_gets_only_the_account_budget() {
    let t = test_app("127.0.0.1:50000", |c| c.security.login_max_failures = 3).await;
    t.setup().await;
    let (mut wrong, mut refused) = (0, 0);
    for i in 0..20 {
        let attacker = t.from(&format!("[2001:db8:{i:x}:{i:x}::1]:1"));
        match attacker.login("joerg@example.de", "falsch falsch falsch").await.status {
            StatusCode::UNAUTHORIZED => wrong += 1,
            StatusCode::TOO_MANY_REQUESTS => refused += 1,
            other => panic!("{other}"),
        }
    }
    assert_eq!((wrong, refused), (3, 17));
    assert_eq!(
        t.from("[2001:db8:99::1]:1").login("joerg@example.de", PASSWORD).await.status,
        StatusCode::TOO_MANY_REQUESTS
    );
    t.finish().await;
}

/// An IPv6 site (/48) has a budget of failures for all accounts together. Used up, an address in
/// it goes on only with accounts that are clean at that address; other sites are not affected.
#[tokio::test]
async fn an_ipv6_site_that_used_up_its_failures_goes_on_only_with_clean_accounts() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 5;
        c.security.login_window_secs = 600;
    })
    .await;
    t.setup().await;
    // Five addresses of one site, five wrong passwords each for different accounts: 25 for the
    // site, which is its budget.
    for i in 1..=5 {
        let address = t.from(&format!("[2001:db8:1:{i}::1]:1"));
        for _ in 0..5 {
            let r = address.login(&format!("konto{i}@example.de"), "falsch falsch falsch").await;
            assert_eq!(r.status, StatusCode::UNAUTHORIZED);
        }
    }
    let sixth = t.from("[2001:db8:1:6::1]:1");
    for _ in 0..3 {
        assert_eq!(sixth.login("y@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    // Neither the address (3 of 5) nor the account (3 of 5) is used up; the site is.
    let r = sixth.login("y@example.de", "falsch falsch falsch").await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    // An account clean at this address goes on, and so does the owner from it.
    assert_eq!(sixth.login("z@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(sixth.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);
    // Another site is not affected.
    assert_eq!(
        t.from("[2001:db8:2::1]:1").login("y@example.de", "falsch falsch falsch").await.status,
        StatusCode::UNAUTHORIZED
    );
    drop(sixth);
    t.finish().await;
}

/// Tables filled from attacker networks refuse those networks, while a client from another
/// network still signs in, and the setup still completes.
#[tokio::test]
async fn full_rate_limit_tables_still_let_other_networks_in() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let now = t.clock.monotonic_ms();
    let attacker = |i: u128| {
        std::net::IpAddr::V6(std::net::Ipv6Addr::from(
            (0x2001_0db8u128 << 96) | ((i / 100) << 80) | ((i % 100) << 64) | 1,
        ))
    };
    use kalzit::auth::ratelimit::{address_key, network_key};
    for i in 0..101_000u128 {
        let ip = attacker(i);
        let (key, net) = (address_key("login", ip), network_key(ip));
        let _ = t.state.login_limiter.try_acquire(&key, &net, now);
        let _ = t.state.pair_limiter.try_acquire(&format!("account:a{i}@example.de|{key}"), &net, now);
        let _ = t.state.unknown_account_limiter.record(&format!("email:a{i}@example.de"), &net, now);
        let _ = t.state.setup_limiter.try_acquire(&address_key("setup", ip), &net, now);
    }
    // A new /64 in one of the flooding /48s.
    let flooded_ip = std::net::Ipv6Addr::from((0x2001_0db8u128 << 96) | (5 << 80) | (200 << 64) | 1);
    let flooded = t.from(&format!("[{flooded_ip}]:1"));
    let r = flooded.post("/api/setup/check", json!({ "token": SETUP_CODE })).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    let done = t.setup().await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    let r = flooded.login("joerg@example.de", PASSWORD).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    let owner = t.from("198.51.100.7:1");
    assert_eq!(owner.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);
    drop((flooded, owner));
    t.finish().await;
}

/// Tables filled to their hard cap (300 000 entries from 30 000 networks) still take a client
/// from a fresh network: the setup completes and the owner signs in.
#[tokio::test]
async fn tables_at_their_hard_cap_still_let_a_fresh_network_in() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let now = t.clock.monotonic_ms();
    for i in 0..300_000 {
        let net = format!("net:attacker-{}", i / 10);
        let _ = t.state.login_limiter.try_acquire(&format!("ip:login:a{i}"), &net, now);
        let _ = t.state.pair_limiter.try_acquire(&format!("account:a{i}"), &net, now);
        let _ = t.state.unknown_account_limiter.record(&format!("email:a{i}@example.de"), &net, now);
        let _ = t.state.setup_limiter.try_acquire(&format!("ip:setup:a{i}"), &net, now);
    }
    let done = t.setup().await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    let owner = t.from("198.51.100.7:1");
    assert_eq!(owner.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);
    drop(owner);
    t.finish().await;
}

/// A flood that fills every bounded table to its cap, with guesses at made-up emails among
/// them, never pushes out the partly used budget of an existing account: it lives in a table of
/// its own, without a cap.
#[tokio::test]
async fn a_partly_used_account_budget_survives_a_flood_at_the_cap() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 3;
        c.security.login_window_secs = 600;
    })
    .await;
    t.setup().await;
    for i in 1..=2 {
        let attacker = t.from(&format!("[2001:db8:{i:x}::1]:1"));
        assert_eq!(attacker.login("joerg@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    let now = t.clock.monotonic_ms();
    for i in 0..300_010 {
        let net = format!("net:attacker-{}", i / 10);
        let _ = t.state.login_limiter.try_acquire(&format!("ip:login:a{i}"), &net, now);
        let _ = t.state.pair_limiter.try_acquire(&format!("account:a{i}"), &net, now);
        let _ = t.state.unknown_account_limiter.record(&format!("email:a{i}@example.de"), &net, now);
        let _ = t.state.network_limiter.record(&net, &net, now);
    }
    // Made-up emails through the API go to their own table as well.
    for i in 0..20 {
        let r = t.from(&format!("[2001:db8:{:x}::1]:1", 0x200 + i)).login(&format!("x{i}@example.de"), "falsch").await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    // The third failure uses the victim's budget up; then even the right password is refused.
    let third = t.from("[2001:db8:3::1]:1");
    assert_eq!(third.login("joerg@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    let r = t.from("[2001:db8:4::1]:1").login("joerg@example.de", PASSWORD).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    drop(third);
    t.finish().await;
}

/// Guesses that hold every check slot of an account cannot keep its owner out: a browser with a
/// device cookie has slots of its own, while other browsers wait and are refused.
#[tokio::test]
async fn guesses_holding_the_check_slots_do_not_keep_a_known_device_out() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    t.setup().await;
    let owner = t.from("198.51.100.7:1");
    let signed_in = owner.login("joerg@example.de", PASSWORD).await;
    let device = set_cookie(&signed_in, "kalzit_device");
    // An attacker's checks in flight take both slots of the account.
    let wait = std::time::Duration::from_secs(1);
    let slots = &t.state.password_checks;
    let held =
        (slots.enter("email:joerg@example.de", 2, wait).await, slots.enter("email:joerg@example.de", 2, wait).await);
    assert!(held.0.is_some() && held.1.is_some());
    let r = t.from("203.0.113.9:1").login("joerg@example.de", PASSWORD).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    let r = owner.login_with("joerg@example.de", PASSWORD, &device).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    drop((held, owner));
    t.finish().await;
}

/// While the table of emails without an account is full, such an email is not counted rather
/// than refused, so a wrong password answers the same for it as for an account that exists.
#[tokio::test]
async fn a_full_table_of_unknown_emails_answers_like_an_account() {
    let t = test_app("127.0.0.1:50000", |c| c.security.login_max_failures = 2).await;
    t.setup().await;
    let now = t.clock.monotonic_ms();
    // Used-up entries only, so nothing can be dropped to make room.
    for i in 0..300_000 {
        let (key, net) = (format!("email:a{i}@example.de"), format!("net:n{i}"));
        let _ = t.state.unknown_account_limiter.record(&key, &net, now);
        let _ = t.state.unknown_account_limiter.record(&key, &net, now);
    }
    let unknown = t.from("[2001:db8:1::1]:1").login("niemand@example.de", "falsch falsch falsch").await;
    let known = t.from("[2001:db8:2::1]:1").login("joerg@example.de", "falsch falsch falsch").await;
    assert_eq!(unknown.status, StatusCode::UNAUTHORIZED, "{}", unknown.body);
    assert_eq!((known.status, &known.body), (unknown.status, &unknown.body));
    // Repeated from fresh addresses, both reach the refusal at the same count: the unknown email
    // counts in an overflow bucket with the same budget.
    let mut next = 0x100;
    let mut refused_at = |email: &'static str| {
        let attempts: Vec<_> = (0..4)
            .map(|_| {
                next += 1;
                t.from(&format!("[2001:db8:{next:x}::1]:1"))
            })
            .collect();
        async move {
            for (n, client) in attempts.iter().enumerate() {
                let r = client.login(email, "falsch falsch falsch").await;
                if r.status == StatusCode::TOO_MANY_REQUESTS {
                    return Some(n);
                }
                assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.body);
            }
            None
        }
    };
    let unknown_at = refused_at("niemand@example.de").await;
    let known_at = refused_at("joerg@example.de").await;
    assert_eq!(unknown_at, Some(1), "two failures in all, then refused");
    assert_eq!(known_at, unknown_at);
    t.finish().await;
}

/// An account that signs in over and over from a known device cannot keep the threads of known
/// devices busy for others: it has one check at a time and a budget of successes, and another
/// account's known device still signs in meanwhile.
#[tokio::test]
async fn an_account_signing_in_over_and_over_cannot_crowd_out_known_devices() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let admin = t.setup().await.session_cookie();
    let created = t
        .send(
            Method::POST,
            "/api/admin/users",
            Some(json!({ "name": "Ina Innen", "email": "ina@example.de", "password": PASSWORD })),
            &[("cookie", &admin)],
        )
        .await;
    assert!(created.status.is_success(), "{}", created.body);
    let owner = t.from("198.51.100.7:1");
    let owner_device = set_cookie(&owner.login("joerg@example.de", PASSWORD).await, "kalzit_device");
    let insider = t.from("203.0.113.5:1");
    let insider_device = set_cookie(&insider.login("ina@example.de", PASSWORD).await, "kalzit_device");

    // Many sign-ins of the insider at once, and the owner's in the middle of them.
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..40 {
        let app = insider.app.clone();
        let cookie = insider_device.clone();
        set.spawn(async move {
            let body = json!({ "email": "ina@example.de", "password": PASSWORD });
            let req = Request::builder()
                .method(Method::POST)
                .uri("/api/auth/login")
                .header(header::HOST, "kalzit.test")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, cookie)
                .body(Body::from(body.to_string()))
                .unwrap();
            app.oneshot(req).await.unwrap().status()
        });
    }
    let r = owner.login_with("joerg@example.de", PASSWORD, &owner_device).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let statuses = set.join_all().await;
    assert!(statuses.iter().all(|s| *s == StatusCode::OK || *s == StatusCode::TOO_MANY_REQUESTS), "{statuses:?}");

    // Signed in one after the other, the insider runs out of its budget of successes.
    let mut refused = false;
    for _ in 0..kalzit::auth::ratelimit::MAX_SIGN_INS + 1 {
        if insider.login_with("ina@example.de", PASSWORD, &insider_device).await.status == StatusCode::TOO_MANY_REQUESTS
        {
            refused = true;
            break;
        }
    }
    assert!(refused, "the budget of successes ends the loop");
    assert_eq!(owner.login_with("joerg@example.de", PASSWORD, &owner_device).await.status, StatusCode::OK);
    drop((owner, insider));
    t.finish().await;
}

/// Wrong passwords sent all at once from fresh networks, right when the account's window
/// starts again, are held to the account's budget: it is counted before the password is checked.
#[tokio::test]
async fn simultaneous_guesses_are_held_to_the_account_budget() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 3;
        c.security.login_window_secs = 600;
    })
    .await;
    t.setup().await;
    for i in 1..=3 {
        let attacker = t.from(&format!("[2001:db8:{i:x}::1]:1"));
        assert_eq!(attacker.login("joerg@example.de", "falsch falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    t.clock.advance_ms(600_000);
    let mut set = tokio::task::JoinSet::new();
    for i in 0..30 {
        let peer: SocketAddr = format!("[2001:db8:{:x}::1]:1", 0x100 + i).parse().unwrap();
        let app = router(t.state.clone()).layer(MockConnectInfo(peer));
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
    let wrong = statuses.iter().filter(|s| **s == StatusCode::UNAUTHORIZED).count();
    let refused = statuses.iter().filter(|s| **s == StatusCode::TOO_MANY_REQUESTS).count();
    assert_eq!(wrong + refused, 30, "{statuses:?}");
    assert!((1..=3).contains(&wrong), "{wrong} guesses were checked");
    // Whatever got through, the account's budget is used up for browsers it does not know.
    for _ in wrong..3 {
        let _ = t.from("[2001:db8:ffff::1]:1").login("joerg@example.de", "falsch falsch falsch").await;
    }
    let r = t.from("[2001:db8:fffe::1]:1").login("joerg@example.de", PASSWORD).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn the_setup_code_can_be_checked_on_its_own() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let ok = t.post("/api/setup/check", json!({ "token": SETUP_CODE.to_uppercase() })).await;
    assert_eq!((ok.status, ok.body.clone()), (StatusCode::OK, json!({ "valid": true })));
    let wrong = t.post("/api/setup/check", json!({ "token": "falsch-falsch" })).await;
    assert_eq!((wrong.status, wrong.code()), (StatusCode::FORBIDDEN, "invalid_setup_token"));
    // The answer never repeats the code.
    assert!(!wrong.body.to_string().contains("falsch-falsch"));
    let unknown = t.post("/api/setup/check", json!({ "token": SETUP_CODE, "orgName": "A" })).await;
    assert_eq!(unknown.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", unknown.body);
    // A fixed code has no previous one.
    assert_eq!(t.get("/api/setup", None).await.body["codeHint"], "fixed");

    assert_eq!(t.setup().await.status, StatusCode::OK);
    let done = t.post("/api/setup/check", json!({ "token": SETUP_CODE })).await;
    assert_eq!((done.status, done.code()), (StatusCode::CONFLICT, "setup_done"));
    t.finish().await;
}

/// Five wrong codes per minute and address, for the check and setup together; a correct code
/// gives its attempt back.
#[tokio::test]
async fn setup_codes_are_rate_limited_per_address() {
    // Per address the sign-in limits apply.
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 5;
        c.security.login_window_secs = 120;
    })
    .await;
    for _ in 0..4 {
        assert_eq!(t.post("/api/setup/check", json!({ "token": "falsch" })).await.status, StatusCode::FORBIDDEN);
    }
    for _ in 0..10 {
        assert_eq!(t.post("/api/setup/check", json!({ "token": SETUP_CODE })).await.status, StatusCode::OK);
    }
    let wrong_setup = t
        .post(
            "/api/setup",
            json!({ "token": "falsch", "orgName": "A", "name": "B", "email": "b@example.de", "password": PASSWORD }),
        )
        .await;
    assert_eq!(wrong_setup.code(), "invalid_setup_token");
    let blocked = t.post("/api/setup/check", json!({ "token": SETUP_CODE })).await;
    assert_eq!((blocked.status, blocked.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", blocked.body);
    assert_eq!(blocked.headers.get(header::RETRY_AFTER).unwrap(), "120");
    assert_eq!(blocked.body["error"]["retryAfterSecs"], 120);
    assert_eq!(t.setup().await.code(), "rate_limited");
    t.clock.advance_ms(60_000);
    assert_eq!(t.post("/api/setup/check", json!({ "token": SETUP_CODE })).await.body["error"]["retryAfterSecs"], 60);
    t.clock.advance_ms(60_000);
    assert_eq!(t.setup().await.status, StatusCode::OK);
    t.finish().await;
}

/// Wrong codes from all addresses together have a budget of their own. Used up, it slows a guess
/// spread over many addresses to a few tries per address, and names its wait; but it never keeps
/// out the person with the right code, who completes setup from a clean address.
#[tokio::test]
async fn setup_codes_are_capped_across_all_addresses_but_the_right_code_gets_in() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 5;
        c.security.setup_max_failures = 5;
        c.security.setup_window_secs = 3600;
    })
    .await;
    let guess = json!({ "token": "falsch" });
    // Five wrong codes from one address use up its own budget and the shared one.
    let first = t.from("192.0.2.1:1");
    for _ in 0..5 {
        assert_eq!(first.post("/api/setup/check", guess.clone()).await.code(), "invalid_setup_token");
    }
    assert_eq!(first.post("/api/setup/check", guess.clone()).await.code(), "rate_limited");
    // Another address gets a mistyping's worth of tries, not its whole budget of five.
    t.clock.advance_ms(600_000);
    let second = t.from("192.0.2.2:1");
    for _ in 0..3 {
        assert_eq!(second.post("/api/setup/check", guess.clone()).await.code(), "invalid_setup_token");
    }
    for token in ["falsch", SETUP_CODE] {
        let r = second.post("/api/setup/check", json!({ "token": token })).await;
        assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
        assert_eq!(r.headers.get(header::RETRY_AFTER).unwrap(), "3000");
        assert_eq!(r.body["error"]["retryAfterSecs"], 3000);
    }
    // The person with the code, from a clean address, checks it and completes setup.
    let owner = t.from("198.51.100.7:1");
    assert_eq!(owner.post("/api/setup/check", json!({ "token": SETUP_CODE })).await.status, StatusCode::OK);
    let done = owner.setup().await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    drop((first, second, owner));
    t.finish().await;
}

/// Wrong codes cannot use up the budget of the code itself: an attacker flooding the setup with
/// wrong codes from many addresses never keeps the server's operator out.
#[tokio::test]
async fn a_flood_of_wrong_setup_codes_does_not_block_setup() {
    let t = test_app("127.0.0.1:50000", |c| {
        c.security.login_max_failures = 3;
        c.security.setup_max_failures = 10;
    })
    .await;
    for i in 0..20 {
        let attacker = t.from(&format!("[2001:db8:{i:x}::1]:1"));
        for _ in 0..4 {
            attacker.post("/api/setup/check", json!({ "token": "falsch" })).await;
        }
    }
    let done = t.setup().await;
    assert_eq!(done.status, StatusCode::OK, "{}", done.body);
    t.finish().await;
}

/// After a restart the generated code is new; the code of the previous start is answered as
/// expired, never accepted.
#[tokio::test]
async fn the_code_of_the_previous_start_is_expired() {
    let t = build(tempfile::tempdir().unwrap(), None, "127.0.0.1:50000", None, |_| {}).await;
    let file = t.dir.path().join("setup-token.txt");
    let old = std::fs::read_to_string(&file).unwrap().trim().to_string();
    let hint = if kalzit::updates::platform::in_container() { "docker" } else { "file" };
    assert_eq!(t.get("/api/setup", None).await.body, json!({ "needed": true, "codeHint": hint }));
    // A server without a file from before has no previous code.
    let other = t.post("/api/setup/check", json!({ "token": "0000-0000-0000-0000-0000-0000" })).await;
    assert_eq!(other.code(), "invalid_setup_token");

    // The restart: a new state on the same data directory and database.
    let restarted = AppState::new((*t.state.config).clone(), t.state.db.clone(), t.clock.clone(), None).await.unwrap();
    let new = std::fs::read_to_string(&file).unwrap().trim().to_string();
    assert_ne!(old, new);
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let r = TestApp {
        app: router(restarted.clone()).layer(MockConnectInfo(peer)),
        clock: t.clock.clone(),
        state: restarted.clone(),
        dir: t.dir.clone(),
    };
    let expired = r.post("/api/setup/check", json!({ "token": old })).await;
    assert_eq!((expired.status, expired.code()), (StatusCode::FORBIDDEN, "setup_token_expired"), "{}", expired.body);
    assert!(!expired.body.to_string().contains(&old));
    let setup = |token: &str| json!({ "token": token, "orgName": "A", "name": "B", "email": "b@example.de", "password": PASSWORD });
    let refused = r.post("/api/setup", setup(&old)).await;
    assert_eq!((refused.status, refused.code()), (StatusCode::FORBIDDEN, "setup_token_expired"));
    assert_eq!(r.post("/api/setup/check", json!({ "token": new })).await.status, StatusCode::OK);
    assert_eq!(r.post("/api/setup", setup(&new)).await.status, StatusCode::OK);
    drop(r);
    restarted.close().await;
    drop(restarted);
    t.finish().await;
}

/// Language and theme become the server defaults, the time zone the new organization's, in the
/// setup transaction and recorded like any settings change. Left out, nothing is stored.
#[tokio::test]
async fn setup_stores_the_chosen_language_theme_and_time_zone() {
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    let body = |extra: Value| {
        let mut b = json!({ "token": SETUP_CODE, "orgName": "A", "name": "B", "email": "b@example.de",
                            "password": PASSWORD });
        b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        b
    };
    for (extra, field) in [
        (json!({ "language": "fr" }), "language"),
        (json!({ "theme": "pink" }), "theme"),
        (json!({ "timeZone": "Europe/../etc" }), "timeZone"),
    ] {
        let r = t.post("/api/setup", body(extra)).await;
        assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{}", r.body);
        assert_eq!(r.body["error"]["field"], field);
    }
    assert_eq!(t.get("/api/setup", None).await.body["needed"], true, "a refused setup changes nothing");

    let r = t.post("/api/setup", body(json!({ "language": "en", "theme": "dark", "timeZone": "Europe/Berlin" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(kalzit::settings::get(&t.state, "appearance.default_language").await.unwrap(), "en");
    assert_eq!(kalzit::settings::get(&t.state, "appearance.default_theme").await.unwrap(), "dark");
    assert_eq!(kalzit::settings::get_org(&t.state, &org, "appearance.time_zone").await.unwrap(), "Europe/Berlin");
    let audited: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT resource_id, org_id FROM audit_events WHERE action = 'settings.updated' ORDER BY resource_id",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(
        audited,
        [
            ("appearance.default_language".to_string(), None),
            ("appearance.default_theme".to_string(), None),
            ("appearance.time_zone".to_string(), Some(org.clone())),
        ]
    );
    t.finish().await;

    // Left out: the defaults stay and nothing is stored.
    let t = test_app("127.0.0.1:50000", |_| {}).await;
    assert_eq!(t.setup().await.status, StatusCode::OK);
    assert_eq!(kalzit::settings::get(&t.state, "appearance.default_language").await.unwrap(), "de");
    let (stored,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM server_settings").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(stored, 0);
    t.finish().await;
}
