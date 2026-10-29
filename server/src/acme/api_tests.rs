//! The ACME routes through the real router: each field is checked with its own reason, the save
//! checks a (fake) directory over HTTPS and the names, stores the settings in one step with a
//! version and an audit entry. Ordering real certificates runs against pebble in CI
//! (server/tests/acme_pebble.rs).

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::app::{AppState, router};
use crate::clock::ManualClock;
use crate::config::Config;
use crate::datasources::targets::test_hosts;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const NOW: i64 = 1_800_000_000_000;
/// Resolves to loopback in these tests only (`test_hosts`).
const DOMAIN: &str = "kalzit.acme-test.example";

struct T {
    app: Router,
    state: AppState,
    admin: String,
    dir: tempfile::TempDir,
}

struct Reply {
    status: StatusCode,
    body: Value,
    text: String,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    fn field(&self) -> &str {
        self.body["error"]["field"].as_str().unwrap_or("")
    }
}

impl T {
    async fn new() -> T {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        config.server.http_addr = "127.0.0.1:8080".into();
        config.server.https_addr = "127.0.0.1:8443".into();
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = crate::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(NOW));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = T { app, state, admin: String::new(), dir };
        let r = t
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        let (id,): (String,) = sqlx::query_as("SELECT id FROM users").fetch_one(&t.state.db).await.unwrap();
        let token = crate::auth::session::create(&t.state.db, &t.state.config.sessions, NOW, &id).await.unwrap();
        t.admin = format!("kalzit_session={token}");
        t
    }

    async fn finish(self) {
        let T { app, state, dir, .. } = self;
        drop(app);
        crate::app::finish_test_app(state, dir).await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, body, text }
    }

    async fn save(&self, settings: Value, version: i64) -> Reply {
        let body = json!({ "settings": settings, "version": version });
        self.send(Method::PUT, "/api/admin/acme", Some(body), Some(&self.admin)).await
    }

    async fn test(&self, settings: Value) -> Reply {
        self.send(Method::POST, "/api/admin/acme/test", Some(json!({ "settings": settings })), Some(&self.admin)).await
    }

    async fn audit(&self) -> Vec<(String, Value)> {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT action, summary FROM audit_events WHERE action LIKE 'tls.%' ORDER BY created_at, id",
        )
        .fetch_all(&self.state.db)
        .await
        .unwrap();
        rows.into_iter().map(|(a, s)| (a, serde_json::from_str(&s).unwrap())).collect()
    }
}

/// A fake ACME directory over HTTPS: its address and the certificate (PEM) to trust.
#[expect(clippy::disallowed_methods, reason = "a fake ACME directory, not an API route")]
async fn directory() -> (String, String) {
    crate::http::ensure_crypto_provider();
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let (cert, key) = (ck.cert.pem(), ck.signing_key.serialize_pem());
    let app = Router::new()
        .route(
            "/dir",
            axum::routing::get(|| async {
                axum::Json(json!({
                    "newNonce": "https://localhost/nonce",
                    "newAccount": "https://localhost/account",
                    "newOrder": "https://localhost/order",
                    "meta": { "termsOfService": "https://ca.example/terms.pdf" }
                }))
            }),
        )
        .route("/not-acme", axum::routing::get(|| async { axum::Json(json!({ "hello": "world" })) }));
    let tls =
        axum_server::tls_rustls::RustlsConfig::from_pem(cert.clone().into_bytes(), key.into_bytes()).await.unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(
        async move { axum_server::from_tcp_rustls(listener, tls).unwrap().serve(app.into_make_service()).await },
    );
    (format!("https://localhost:{}", addr.port()), cert)
}

fn settings(base: &str, ca: &str) -> Value {
    json!({
        "enabled": true,
        "directory": "custom",
        "directoryUrl": format!("{base}/dir"),
        "directoryCa": ca,
        "domains": [DOMAIN],
        "email": "ops@example.com",
        "challenge": "http-01",
        "acceptTerms": true,
    })
}

#[tokio::test]
async fn each_field_is_checked_and_the_settings_are_saved_in_one_step() {
    test_hosts::pin(DOMAIN, &[IpAddr::from([127, 0, 0, 1])]);
    let t = T::new().await;
    let (base, ca) = directory().await;

    let r = t.send(Method::GET, "/api/admin/acme", None, Some(&t.admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["status"]["phase"], "off");
    assert_eq!(r.body["version"], 0);
    assert_eq!(r.body["server"]["httpsAddr"], "127.0.0.1:8443");
    assert_eq!(r.body["server"]["certificateFiles"], false);
    let r = t.send(Method::GET, "/api/admin/acme", None, None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // One problem at a time, each with its field.
    let cases: Vec<(Value, &str, &str)> = vec![
        (json!({ "domains": [] }), "domains", "acme.domains_missing"),
        (json!({ "domains": ["*.example.com"] }), "domains", "acme.domain_wildcard"),
        (json!({ "domains": ["localhost"] }), "domains", "acme.domain_invalid"),
        (json!({ "acceptTerms": false }), "acceptTerms", "acme.terms_not_accepted"),
        (json!({ "email": "no address" }), "email", "acme.email_invalid"),
        (json!({ "directoryUrl": "http://localhost/dir" }), "directoryUrl", "acme.directory_url_invalid"),
        (json!({ "directoryCa": "nothing" }), "directoryCa", "acme.directory_ca_invalid"),
        (json!({ "directoryUrl": "https://localhost:9/dir" }), "directoryUrl", "acme.directory_unreachable"),
        (json!({ "directoryUrl": format!("{base}/not-acme") }), "directoryUrl", "acme.directory_invalid"),
        (json!({ "domains": ["nowhere.invalid"] }), "domains", "acme.domain_unresolved"),
    ];
    for (change, field, reason) in cases {
        let mut s = settings(&base, &ca);
        for (k, v) in change.as_object().unwrap() {
            s[k] = v.clone();
        }
        let r = t.save(s.clone(), 0).await;
        assert_eq!((r.status, r.field(), r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, field, reason), "{}", r.text);
        let r = t.test(s).await;
        assert_eq!((r.field(), r.reason()), (field, reason), "{}", r.text);
    }
    assert!(t.audit().await.is_empty(), "nothing was saved");

    // The test names the terms and warns that the CA connects to port 80.
    let r = t.test(settings(&base, &ca)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["termsOfService"], "https://ca.example/terms.pdf");
    assert_eq!(r.body["warnings"][0]["reason"], "acme.http_port");
    assert_eq!(r.body["warnings"][0]["params"]["port"], "8080");

    let r = t.save(settings(&base, &ca), 0).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["version"], 1);
    assert_eq!(r.body["settings"]["domains"], json!([DOMAIN]));
    assert_eq!(r.body["status"]["phase"], "waiting");
    let audit = t.audit().await;
    assert_eq!(audit.len(), 1);
    assert_eq!(audit[0].0, "tls.acme_changed");
    assert_eq!(audit[0].1["domains"], json!([DOMAIN]));
    assert!(!audit[0].1.to_string().contains("ops@example.com"), "the contact stays out of the audit log");

    // An older version is a conflict that carries what is stored now.
    let r = t.save(settings(&base, &ca), 0).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.text);
    assert_eq!(r.body["current"]["version"], 1);

    // Off, the fields stay for later and nothing is fetched.
    let mut off = settings("https://localhost:9", &ca);
    off["enabled"] = json!(false);
    let r = t.save(off, 1).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(r.body["status"]["phase"], "off");
    let r = t.send(Method::POST, "/api/admin/acme/renew", None, Some(&t.admin)).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "acme.off"), "{}", r.text);
    t.finish().await;
}

#[tokio::test]
async fn acme_needs_https_without_certificate_files() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.server.https_addr = "127.0.0.1:8443".into();
    config.tls.cert_file = Some(dir.path().join("cert.pem"));
    config.tls.key_file = Some(dir.path().join("key.pem"));
    let s: crate::acme::AcmeSettings = serde_json::from_value(settings("https://ca.example", "")).unwrap();
    let e = crate::acme::settings::check_against(&s, &config).unwrap_err();
    assert_eq!((e.field, e.reason), ("enabled", "acme.certificate_file_set"));
}

#[tokio::test]
async fn http_01_answers_come_from_the_running_order() {
    let t = T::new().await;
    t.state.acme.add_http_challenge("token-1", "token-1.thumbprint");
    let r = t.send(Method::GET, "/.well-known/acme-challenge/token-1", None, None).await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, "token-1.thumbprint"));
    let r = t.send(Method::GET, "/.well-known/acme-challenge/other", None, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    t.state.acme.remove_http_challenge("token-1");
    let r = t.send(Method::GET, "/.well-known/acme-challenge/token-1", None, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    t.finish().await;
}
