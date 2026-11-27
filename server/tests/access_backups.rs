//! The server settings of 0.7.5 through the real router and database: CORS (preflight, allowed
//! and refused origins, the cookie only with the credentials switch), self-registration with
//! every refusal (off, no domains, no organization, domain, budgets, links, approval, declined
//! addresses) and backups to a local directory and an S3-compatible store (target checks,
//! encryption, retention, history, audit, restore).

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine;
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const PUBLIC_URL: &str = "https://kalzit.example.com";
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;

// --- A mail server on this machine that records what it gets. ---

#[derive(Clone, Debug)]
struct Mail {
    to: String,
    data: String,
}

impl Mail {
    fn text(&self) -> String {
        let start = self.data.find("Content-Type: text/plain").expect("a text part");
        let body = &self.data[start..];
        let body = &body[body.find("\r\n\r\n").unwrap() + 4..];
        let encoded: String = body.lines().take_while(|l| !l.starts_with("--")).collect();
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap()
    }

    fn token(&self, page: &str) -> String {
        let text = self.text();
        let marker = format!("{PUBLIC_URL}/{page}#");
        let at = text.find(&marker).unwrap_or_else(|| panic!("no {page} link in {text}"));
        text[at + marker.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
    }
}

struct FakeSmtp {
    port: u16,
    mails: Arc<Mutex<Vec<Mail>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeSmtp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeSmtp {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mails = Arc::new(Mutex::new(Vec::new()));
        let log = mails.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let _ = serve_smtp(socket, log).await;
                });
            }
        });
        Self { port, mails, task }
    }
}

async fn serve_smtp(socket: tokio::net::TcpStream, log: Arc<Mutex<Vec<Mail>>>) -> std::io::Result<()> {
    let mut io = BufReader::new(socket);
    io.write_all(b"220 fake ESMTP\r\n").await?;
    let mut to = String::new();
    loop {
        let mut line = String::new();
        if io.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let upper = line.trim_end().to_ascii_uppercase();
        if upper.starts_with("EHLO") {
            io.write_all(b"250-fake\r\n250 SMTPUTF8\r\n").await?;
        } else if upper.starts_with("RCPT TO:") {
            to = line.trim_end()[8..].trim_matches(['<', '>']).to_string();
            io.write_all(b"250 ok\r\n").await?;
        } else if upper == "DATA" {
            io.write_all(b"354 go\r\n").await?;
            let mut data = String::new();
            loop {
                let mut l = String::new();
                if io.read_line(&mut l).await? == 0 || l == ".\r\n" {
                    break;
                }
                data.push_str(l.strip_prefix('.').unwrap_or(&l));
            }
            log.lock().unwrap().push(Mail { to: std::mem::take(&mut to), data });
            io.write_all(b"250 2.0.0 queued\r\n").await?;
        } else if upper == "QUIT" {
            io.write_all(b"221 bye\r\n").await?;
            return Ok(());
        } else {
            io.write_all(b"250 ok\r\n").await?;
        }
    }
}

// --- An S3-compatible store on this machine: objects in memory, signed requests only. ---

/// Multipart uploads in progress: their parts by number.
type Uploads = Arc<Mutex<BTreeMap<String, BTreeMap<u32, Vec<u8>>>>>;

#[derive(Clone, Default)]
struct FakeS3 {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    uploads: Uploads,
    /// The access key id it accepts.
    key_id: &'static str,
}

fn query_map(uri: &axum::http::Uri) -> BTreeMap<String, String> {
    uri.query()
        .unwrap_or_default()
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            let decode = |s: &str| {
                let mut out = Vec::new();
                let bytes = s.as_bytes();
                let mut i = 0;
                while i < bytes.len() {
                    if bytes[i] == b'%' && i + 2 < bytes.len() + 1 {
                        out.push(u8::from_str_radix(&s[i + 1..i + 3], 16).unwrap());
                        i += 3;
                    } else {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
                String::from_utf8(out).unwrap()
            };
            (decode(k), decode(v))
        })
        .collect()
}

async fn s3_handler(
    axum::extract::State(s3): axum::extract::State<FakeS3>,
    req: Request<Body>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let auth = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    if !auth.starts_with(&format!("AWS4-HMAC-SHA256 Credential={}/", s3.key_id)) {
        return (StatusCode::FORBIDDEN, "<Error><Code>InvalidAccessKeyId</Code></Error>").into_response();
    }
    assert!(req.headers().contains_key("x-amz-date") && req.headers().contains_key("x-amz-content-sha256"));
    let method = req.method().clone();
    let uri = req.uri().clone();
    let q = query_map(&uri);
    // Path style: /bucket/key.
    let path = uri.path().trim_start_matches('/').to_string();
    let Some(("backups", key)) = path.split_once('/') else {
        return (StatusCode::NOT_FOUND, "<Error><Code>NoSuchBucket</Code></Error>").into_response();
    };
    let key = key.to_string();
    let body = req.into_body().collect().await.unwrap().to_bytes().to_vec();
    match method {
        Method::PUT if q.contains_key("partNumber") => {
            let n: u32 = q["partNumber"].parse().unwrap();
            s3.uploads.lock().unwrap().get_mut(&q["uploadId"]).unwrap().insert(n, body);
            ([(header::ETAG, format!("\"etag-{n}\""))], "").into_response()
        }
        Method::PUT => {
            s3.objects.lock().unwrap().insert(key, body);
            ([(header::ETAG, "\"x\"")], "").into_response()
        }
        Method::POST if q.contains_key("uploads") => {
            let id = format!("upload-{}", s3.uploads.lock().unwrap().len());
            s3.uploads.lock().unwrap().insert(id.clone(), BTreeMap::new());
            format!("<InitiateMultipartUploadResult><UploadId>{id}</UploadId></InitiateMultipartUploadResult>")
                .into_response()
        }
        Method::POST if q.contains_key("uploadId") => {
            let parts = s3.uploads.lock().unwrap().remove(&q["uploadId"]).unwrap();
            s3.objects.lock().unwrap().insert(key, parts.into_values().flatten().collect());
            "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>".into_response()
        }
        Method::DELETE => {
            s3.objects.lock().unwrap().remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        Method::GET if q.get("list-type").map(String::as_str) == Some("2") => {
            let prefix = q.get("prefix").cloned().unwrap_or_default();
            let items: String = s3
                .objects
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, _)| k.starts_with(&prefix))
                .map(|(k, v)| format!("<Contents><Key>{k}</Key><Size>{}</Size></Contents>", v.len()))
                .collect();
            format!("<ListBucketResult><IsTruncated>false</IsTruncated>{items}</ListBucketResult>").into_response()
        }
        _ => StatusCode::BAD_REQUEST.into_response(),
    }
}

async fn start_s3(key_id: &'static str) -> (FakeS3, u16, tokio::task::JoinHandle<()>) {
    let s3 = FakeS3 { key_id, ..FakeS3::default() };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = Router::new().fallback(s3_handler).with_state(s3.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (s3, port, task)
}

// --- The app ---

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    smtp: Option<FakeSmtp>,
    owner: String,
    org: String,
    /// Its PostgreSQL schema where `KALZIT_TEST_POSTGRES_URL` is set, dropped at `finish`.
    schema: Option<common::PgSchema>,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
}

async fn test_app(mail: bool) -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.public_url = Some(PUBLIC_URL.into());
    let schema = common::database().await;
    config.database.url = schema.as_ref().map(|s| s.url.clone());
    let smtp = if mail { Some(FakeSmtp::start().await) } else { None };
    if let Some(smtp) = &smtp {
        config.smtp.host = "127.0.0.1".into();
        config.smtp.port = smtp.port;
        config.smtp.security = "none".into();
        config.smtp.from_name = "Kalzit".into();
        config.smtp.from_address = "kalzit@example.com".into();
        config.file_keys.insert("smtp.host".into());
    }
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let mut t = TestApp {
        app: router(state.clone()).layer(MockConnectInfo(peer)),
        clock,
        state,
        dir: Arc::new(dir),
        smtp,
        owner: String::new(),
        org: String::new(),
        schema,
    };
    let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jonas Albers",
                       "email": "jonas@example.com", "password": PASSWORD });
    let r = t.send(Method::POST, "/api/setup", Some(body), &[]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
    let set = r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    t.owner = set.split(';').next().unwrap().to_string();
    t
}

impl TestApp {
    async fn finish(mut self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone()).with_schema(self.schema.take());
        drop(self);
        finish.finish().await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> Reply {
        self.send_from(method, path, body, headers, "127.0.0.1:50000").await
    }

    async fn send_from(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
        peer: &str,
    ) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.example.com");
        for (name, value) in headers {
            req = req.header(*name, *value);
        }
        let mut req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let peer: SocketAddr = peer.parse().unwrap();
        req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        self.clock.advance_ms(1);
        Reply { status, headers, body }
    }

    async fn admin(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        self.send(method, path, body, &[("cookie", self.owner.as_str())]).await
    }

    /// Sets a server setting through the API, from whatever version it has.
    async fn set(&self, key: &str, value: Value) {
        let path = format!("/api/admin/settings/{key}");
        let r = self.admin(Method::PATCH, &path, Some(json!({ "value": value, "version": 0 }))).await;
        if r.status == StatusCode::CONFLICT {
            let version = r.body["current"]["version"].as_i64().unwrap();
            let r = self.admin(Method::PATCH, &path, Some(json!({ "value": value, "version": version }))).await;
            assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
        } else {
            assert_eq!(r.status, StatusCode::OK, "{key}: {}", r.body);
        }
    }

    /// Signs the owner in again (a session ends when the test's clock moves past its lifetime).
    async fn sign_in_again(&mut self) {
        let body = json!({ "email": "jonas@example.com", "password": PASSWORD });
        let r = self.send(Method::POST, "/api/auth/login", Some(body), &[]).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let set = r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
        self.owner = set.split(';').next().unwrap().to_string();
    }

    async fn mails(&self) -> Vec<Mail> {
        self.state.mail.settle().await;
        self.smtp.as_ref().map(|s| s.mails.lock().unwrap().clone()).unwrap_or_default()
    }

    async fn audit(&self) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }
}

// --- CORS ---

#[tokio::test]
async fn cors_is_off_until_an_origin_is_allowed() {
    let app = test_app(false).await;
    let origin = ("origin", "https://app.example.org");
    let preflight = [origin, ("access-control-request-method", "GET")];
    let r = app.send(Method::OPTIONS, "/api/me", None, &preflight).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "request.cross_origin_refused"));
    assert!(!r.headers.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    let r = app.send(Method::GET, "/api/about", None, &[origin, ("cookie", app.owner.as_str())]).await;
    assert!(!r.headers.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));

    // Wildcards cover subdomains only; plain http only for localhost.
    let path = "/api/admin/settings/cors.allowed_origins";
    for bad in [json!(["*"]), json!(["http://app.example.org"]), json!(["https://app.example.org/x"])] {
        let r = app.admin(Method::PATCH, path, Some(json!({ "value": bad, "version": 0 }))).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {}", r.body);
    }
    app.set("cors.allowed_origins", json!(["https://app.example.org", "https://*.tools.example.org"])).await;
    // Origins alone do nothing while CORS is off.
    let r = app.send(Method::OPTIONS, "/api/me", None, &preflight).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    app.set("cors.enabled", json!(true)).await;

    let with = |headers: &'static str| {
        [origin, ("access-control-request-method", "POST"), ("access-control-request-headers", headers)]
    };
    let r = app.send(Method::OPTIONS, "/api/orgs/x/query", None, &with("content-type, authorization")).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(r.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://app.example.org");
    assert_eq!(r.headers[header::ACCESS_CONTROL_MAX_AGE], "600");
    assert!(!r.headers.contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    let r = app.send(Method::OPTIONS, "/api/orgs/x/query", None, &with("x-custom")).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "request.cross_origin_refused"));
    let r = app.send(Method::OPTIONS, "/api/me", None, &[origin, ("access-control-request-method", "TRACE")]).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let other = [("origin", "https://evil.example.net"), ("access-control-request-method", "GET")];
    assert_eq!(app.send(Method::OPTIONS, "/api/me", None, &other).await.status, StatusCode::FORBIDDEN);
    let sub = [("origin", "https://a.tools.example.org"), ("access-control-request-method", "GET")];
    assert_eq!(app.send(Method::OPTIONS, "/api/me", None, &sub).await.status, StatusCode::NO_CONTENT);

    // Without the credentials switch the cookie does not count from there.
    let r = app.send(Method::GET, "/api/me", None, &[origin, ("cookie", app.owner.as_str())]).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.body);
    assert_eq!(r.headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://app.example.org");
    // Changes from another origin stay refused.
    let r = app
        .send(
            Method::POST,
            "/api/auth/logout",
            Some(json!({})),
            &[("origin", "https://evil.example.net"), ("cookie", app.owner.as_str())],
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    app.set("cors.allow_credentials", json!(true)).await;
    let r = app.send(Method::GET, "/api/me", None, &[origin, ("cookie", app.owner.as_str())]).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.headers[header::ACCESS_CONTROL_ALLOW_CREDENTIALS], "true");
    // With the cookie allowed, wildcard entries match nothing.
    assert_eq!(app.send(Method::OPTIONS, "/api/me", None, &sub).await.status, StatusCode::FORBIDDEN);
    // Kalzit's own origin needs no CORS.
    let own = app.send(Method::GET, "/api/me", None, &[("origin", PUBLIC_URL), ("cookie", app.owner.as_str())]).await;
    assert_eq!(own.status, StatusCode::OK);
    assert!(!own.headers.contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    app.finish().await;
}

#[test]
fn cors_values_from_the_file_lock_the_setting_and_are_checked() {
    let ok =
        Config::from_sources("[cors]\nenabled = true\nallowed_origins = [\"https://app.example.org\"]\n", Vec::new())
            .unwrap();
    assert_eq!(ok.cors.enabled, Some(true));
    let bad = Config::from_sources("[cors]\nallowed_origins = [\"*\"]\n", Vec::new());
    assert!(bad.is_err());
    let both = Config::from_sources(
        "[cors]\nallowed_origins = [\"https://*.example.org\"]\nallow_credentials = true\n",
        Vec::new(),
    );
    assert!(both.is_err());
}

// --- Self-registration ---

async fn start(app: &TestApp, email: &str, peer: &str) -> Reply {
    let body = json!({ "email": email });
    app.send_from(Method::POST, "/api/auth/registration", Some(body), &[], peer).await
}

async fn open_registration(app: &TestApp, approval: bool) {
    app.set("registration.enabled", json!(true)).await;
    app.set("registration.allowed_domains", json!(["example.de"])).await;
    app.set("registration.default_org", json!(app.org)).await;
    app.set("registration.require_approval", json!(approval)).await;
}

#[tokio::test]
async fn registration_refuses_until_everything_it_needs_is_there() {
    let app = test_app(true).await;
    let r = app.send(Method::GET, "/api/auth/registration", None, &[]).await;
    assert_eq!(r.body["available"], false);
    assert_eq!(start(&app, "nora@example.de", "127.0.0.1:1").await.reason(), "signup.disabled");
    app.set("registration.enabled", json!(true)).await;
    assert_eq!(start(&app, "nora@example.de", "127.0.0.1:1").await.reason(), "signup.no_domains");
    app.set("registration.allowed_domains", json!(["example.de"])).await;
    assert_eq!(start(&app, "nora@example.de", "127.0.0.1:1").await.reason(), "signup.no_organization");
    // Never above editor.
    let r = app
        .admin(
            Method::PATCH,
            "/api/admin/settings/registration.default_role",
            Some(json!({ "value": "admin", "version": 0 })),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    app.set("registration.default_org", json!(app.org)).await;
    let r = app.send(Method::GET, "/api/auth/registration", None, &[]).await;
    assert_eq!((r.body["available"].clone(), r.body["requiresApproval"].clone()), (json!(true), json!(true)));

    let r = start(&app, "nora@example.com", "127.0.0.1:1").await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "signup.domain_not_allowed"));
    let r = app
        .send(
            Method::POST,
            "/api/auth/registration",
            // Starting takes no password: whoever starts need not own the address.
            Some(json!({ "email": "nora@example.de", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = app
        .send(
            Method::POST,
            "/api/auth/registration/confirm",
            Some(json!({ "token": "x".repeat(43), "name": "Nora", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::NOT_FOUND, "signup.invalid_link"));
    app.finish().await;
}

#[tokio::test]
async fn registration_starts_are_limited_per_address_email_and_server() {
    let app = test_app(true).await;
    open_registration(&app, true).await;
    for i in 0..5 {
        assert_eq!(start(&app, &format!("p{i}@example.de"), "10.0.0.1:1").await.status, StatusCode::ACCEPTED);
    }
    let r = start(&app, "p9@example.de", "10.0.0.1:1").await;
    assert_eq!((r.status, r.reason()), (StatusCode::TOO_MANY_REQUESTS, "signup.too_many"));
    for i in 0..3 {
        assert_eq!(start(&app, "same@example.de", &format!("10.0.1.{i}:1")).await.status, StatusCode::ACCEPTED);
    }
    assert_eq!(start(&app, "same@example.de", "10.0.2.1:1").await.reason(), "signup.too_many");
    // An hour later the address may again, the email address not before a day.
    app.clock.advance_ms(HOUR + 1);
    assert_eq!(start(&app, "p9@example.de", "10.0.0.1:1").await.status, StatusCode::ACCEPTED);
    assert_eq!(start(&app, "same@example.de", "10.0.3.1:1").await.reason(), "signup.too_many");
    app.set("registration.max_per_server_day", json!(9)).await;
    assert_eq!(start(&app, "q@example.de", "10.0.4.1:1").await.reason(), "signup.too_many");
    app.finish().await;
}

#[tokio::test]
async fn a_confirmed_registration_waits_for_approval_and_a_declined_address_waits_30_days() {
    let mut app = test_app(true).await;
    open_registration(&app, true).await;
    assert_eq!(start(&app, "nora@example.de", "127.0.0.1:1").await.status, StatusCode::ACCEPTED);
    let mails = app.mails().await;
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].to, "nora@example.de");
    let token = mails[0].token("register");
    // The password is chosen with the link and checked there; a weak one leaves the link usable.
    let weak = json!({ "token": token, "name": "Nora Becker", "password": "short" });
    let r = app.send(Method::POST, "/api/auth/registration/confirm", Some(weak), &[]).await;
    assert_eq!((r.status, r.body["error"]["field"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("password")));
    let r = app
        .send(
            Method::POST,
            "/api/auth/registration/confirm",
            Some(json!({ "token": token, "name": "Nora Becker", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!((r.status, r.body["status"].clone()), (StatusCode::OK, json!("pending")), "{}", r.body);
    // Used once.
    let again = app
        .send(
            Method::POST,
            "/api/auth/registration/confirm",
            Some(json!({ "token": token, "name": "Nora Becker", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(again.reason(), "signup.invalid_link");
    // The admin got a notice without the address.
    let notice = app.mails().await.into_iter().find(|m| m.to == "jonas@example.com").expect("a notice to the admin");
    assert!(!notice.text().contains("nora@example.de"));
    // Its link opens the members page, where the requests are decided.
    assert!(notice.text().contains("/admin/members"), "{}", notice.text());
    assert!(!notice.text().contains("/admin/server/registrations"));

    let list = app.admin(Method::GET, "/api/admin/registrations?status=pending", None).await;
    let id = list.body["items"][0]["id"].as_str().unwrap().to_string();
    let r = app
        .admin(Method::POST, &format!("/api/admin/registrations/{id}/approve"), Some(json!({ "role": "admin" })))
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "signup.role_too_high"));
    let r = app.admin(Method::POST, &format!("/api/admin/registrations/{id}/approve"), Some(json!({}))).await;
    assert_eq!((r.status, r.body["status"].clone()), (StatusCode::OK, json!("approved")), "{}", r.body);
    let login = app
        .send(Method::POST, "/api/auth/login", Some(json!({ "email": "nora@example.de", "password": PASSWORD })), &[])
        .await;
    assert_eq!(login.status, StatusCode::OK, "{}", login.body);
    let role: (String,) = sqlx::query_as(
        "SELECT m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'nora@example.de'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(role.0, "viewer");
    let r = app.admin(Method::POST, &format!("/api/admin/registrations/{id}/approve"), Some(json!({}))).await;
    assert_eq!(r.reason(), "signup.not_pending");

    // Declined: the address gets no new link for 30 days.
    assert_eq!(start(&app, "ole@example.de", "127.0.0.1:3").await.status, StatusCode::ACCEPTED);
    let link = app.mails().await.into_iter().rev().find(|m| m.to == "ole@example.de").unwrap().token("register");
    app.send(
        Method::POST,
        "/api/auth/registration/confirm",
        Some(json!({ "token": link, "name": "Ole", "password": PASSWORD })),
        &[],
    )
    .await;
    let list = app.admin(Method::GET, "/api/admin/registrations?status=pending", None).await;
    let ole = list.body["items"][0]["id"].as_str().unwrap().to_string();
    let r = app.admin(Method::POST, &format!("/api/admin/registrations/{ole}/reject"), None).await;
    assert_eq!(r.body["status"], "rejected", "{}", r.body);
    let before = app.mails().await.len();
    assert_eq!(start(&app, "ole@example.de", "127.0.0.1:4").await.status, StatusCode::ACCEPTED);
    assert_eq!(app.mails().await.len(), before, "a declined address gets no link");
    app.clock.advance_ms(31 * DAY);
    app.sign_in_again().await;
    assert_eq!(start(&app, "ole@example.de", "127.0.0.1:5").await.status, StatusCode::ACCEPTED);
    assert_eq!(app.mails().await.len(), before + 1);

    // A pending registration expires after 14 days.
    let link = app.mails().await.last().unwrap().token("register");
    let r = app
        .send(
            Method::POST,
            "/api/auth/registration/confirm",
            Some(json!({ "token": link, "name": "Ole", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(r.body["status"], "pending", "{}", r.body);
    let list = app.admin(Method::GET, "/api/admin/registrations?status=pending", None).await;
    let late = list.body["items"][0]["id"].as_str().unwrap_or_else(|| panic!("{}", list.body)).to_string();
    app.clock.advance_ms(15 * DAY);
    app.sign_in_again().await;
    let r = app.admin(Method::POST, &format!("/api/admin/registrations/{late}/approve"), Some(json!({}))).await;
    assert_eq!(r.reason(), "signup.not_pending");

    let audit = app.audit().await;
    for action in [
        "auth.registration_started",
        "auth.registration_confirmed",
        "auth.registration_approved",
        "auth.registration_rejected",
    ] {
        assert!(audit.iter().any(|a| a == action), "{action} in {audit:?}");
    }
    app.finish().await;
}

#[tokio::test]
async fn without_approval_the_confirmation_makes_the_account() {
    let app = test_app(true).await;
    open_registration(&app, false).await;
    app.set("registration.default_role", json!("editor")).await;
    assert_eq!(start(&app, "nora@b\u{fc}cher.example.de", "127.0.0.1:1").await.reason(), "signup.domain_not_allowed");
    assert_eq!(start(&app, "nora@example.de", "127.0.0.1:1").await.status, StatusCode::ACCEPTED);
    let token = app.mails().await[0].token("register");
    let r = app
        .send(
            Method::POST,
            "/api/auth/registration/confirm",
            Some(json!({ "token": token, "name": "Nora Becker", "password": PASSWORD })),
            &[],
        )
        .await;
    assert_eq!(r.body["status"], "approved", "{}", r.body);
    let role: (String, String) = sqlx::query_as(
        "SELECT m.role, m.joined_by FROM org_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'nora@example.de'",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!(role, ("editor".to_string(), "registration".to_string()));
    let hash: (String,) =
        sqlx::query_as("SELECT password_hash FROM registrations").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(hash.0, "", "the registration keeps no password hash");
    assert!(app.audit().await.iter().any(|a| a == "auth.registered"));
    app.finish().await;
}

#[tokio::test]
async fn a_registration_started_for_someone_else_gives_the_starter_nothing() {
    let app = test_app(true).await;
    open_registration(&app, false).await;
    // The attacker cannot choose a password at the start.
    let r = app
        .send_from(
            Method::POST,
            "/api/auth/registration",
            Some(json!({ "email": "vera@example.de", "password": "Angreifer kennt es 2026" })),
            &[],
            "10.9.9.9:1",
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Started with the address alone, the link reaches only the mailbox.
    assert_eq!(start(&app, "vera@example.de", "10.9.9.9:2").await.status, StatusCode::ACCEPTED);
    let token = app.mails().await.last().unwrap().token("register");
    let body = json!({ "token": token, "name": "Vera", "password": PASSWORD });
    let r = app.send(Method::POST, "/api/auth/registration/confirm", Some(body), &[]).await;
    assert_eq!(r.body["status"], "approved", "{}", r.body);
    // The account has the password the mailbox's owner chose, and nobody else's.
    let login = |password: &'static str| {
        app.send(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "email": "vera@example.de", "password": password })),
            &[],
        )
    };
    assert_eq!(login("Angreifer kennt es 2026").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(login(PASSWORD).await.status, StatusCode::OK);
    // Starting again for an address with an account sends nothing.
    let before = app.mails().await.len();
    assert_eq!(start(&app, "vera@example.de", "10.9.9.9:3").await.status, StatusCode::ACCEPTED);
    assert_eq!(app.mails().await.len(), before);
    app.finish().await;
}

#[tokio::test]
async fn a_declined_address_stays_declined_in_every_form() {
    let mut app = test_app(true).await;
    open_registration(&app, true).await;
    app.set("registration.allowed_domains", json!(["xn--bcher-kva.example"])).await;
    assert_eq!(start(&app, "anna@b\u{fc}cher.example", "127.0.0.1:1").await.status, StatusCode::ACCEPTED);
    let token = app.mails().await.last().unwrap().token("register");
    let body = json!({ "token": token, "name": "Anna", "password": PASSWORD });
    app.send(Method::POST, "/api/auth/registration/confirm", Some(body), &[]).await;
    let list = app.admin(Method::GET, "/api/admin/registrations?status=pending", None).await;
    let id = list.body["items"][0]["id"].as_str().unwrap_or_else(|| panic!("{}", list.body)).to_string();
    app.admin(Method::POST, &format!("/api/admin/registrations/{id}/reject"), None).await;
    let before = app.mails().await.len();
    // The same address in its ASCII form gets no new link either.
    assert_eq!(start(&app, "anna@xn--bcher-kva.example", "127.0.0.1:2").await.status, StatusCode::ACCEPTED);
    assert_eq!(app.mails().await.len(), before);
    app.clock.advance_ms(31 * DAY);
    app.sign_in_again().await;
    assert_eq!(start(&app, "anna@xn--bcher-kva.example", "127.0.0.1:3").await.status, StatusCode::ACCEPTED);
    assert_eq!(app.mails().await.len(), before + 1);
    app.finish().await;
}

// --- Backups ---

#[tokio::test]
async fn a_local_target_must_be_allowed_and_backups_are_encrypted_and_pruned() {
    let app = test_app(false).await;
    let outside = common::private_tempdir();
    let target = outside.path().join("kalzit");
    std::fs::create_dir_all(&target).unwrap();
    let put = |path: &std::path::Path, version: i64| json!({ "target": { "kind": "local", "path": path.to_string_lossy() }, "version": version });
    let r = app.admin(Method::PUT, "/api/admin/backups/target", Some(put(&target, 0))).await;
    assert_eq!(
        (r.status, r.reason(), r.body["error"]["field"].clone()),
        (StatusCode::UNPROCESSABLE_ENTITY, "backup.path_refused", json!("path"))
    );
    let r = app.admin(Method::POST, "/api/admin/backups/run", None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "backup.no_target"));
    app.set("backups.allowed_dirs", json!([outside.path().to_string_lossy(), app.dir.path().to_string_lossy()])).await;
    // The data directory never, even when allowed.
    let r = app.admin(Method::PUT, "/api/admin/backups/target", Some(put(app.dir.path(), 0))).await;
    assert_eq!(r.reason(), "backup.path_refused");
    let r = app
        .admin(
            Method::PUT,
            "/api/admin/backups/target",
            Some(json!({ "target": { "kind": "local", "path": "relative" }, "version": 0 })),
        )
        .await;
    assert_eq!(r.reason(), "backup.path_invalid");
    let r = app.admin(Method::PUT, "/api/admin/backups/target", Some(put(&target, 0))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["databaseIncluded"], app.schema.is_none());
    assert_eq!(r.body["schedule"]["keepCount"], 14);
    let version = r.body["version"].as_i64().unwrap();
    // A stale version is a conflict.
    let r = app.admin(Method::PUT, "/api/admin/backups/target", Some(put(&target, 0))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert!(version > 0);

    app.set("backups.keep_count", json!(2)).await;
    let mut files = Vec::new();
    for _ in 0..3 {
        let r = app.admin(Method::POST, "/api/admin/backups/run", None).await;
        assert_eq!((r.status, r.body["status"].clone()), (StatusCode::OK, json!("succeeded")), "{}", r.body);
        files.push(r.body["fileName"].as_str().unwrap().to_string());
        app.clock.advance_ms(1000);
    }
    let mut kept: Vec<String> =
        std::fs::read_dir(&target).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    kept.sort();
    assert_eq!(kept, files[1..].to_vec());
    assert!(files[2].ends_with(".zip.enc"));

    // Encrypted with the secrets key; inside, the database and nothing of the key.
    let sealed = std::fs::read(target.join(&files[2])).unwrap();
    assert!(kalzit::backups::archive::is_encrypted(&sealed));
    let mut plain = Vec::new();
    kalzit::backups::archive::decrypt(&app.state.secrets, &mut sealed.as_slice(), &mut plain).unwrap();
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(plain)).unwrap();
    let names: Vec<String> = zip.file_names().map(|n| n.unwrap().to_string()).collect();
    assert!(!names.iter().any(|n| n.contains("secrets")), "{names:?}");
    if app.schema.is_some() {
        // PostgreSQL: the files and a note that points to pg_dump.
        assert!(names.contains(&"README.txt".to_string()) && !names.contains(&"kalzit.db".to_string()), "{names:?}");
    } else {
        assert!(names.contains(&"kalzit.db".to_string()), "{names:?}");
        let mut db = Vec::new();
        std::io::Read::read_to_end(&mut zip.by_name("kalzit.db").unwrap(), &mut db).unwrap();
        assert!(db.starts_with(b"SQLite format 3"));
    }

    let runs = app.admin(Method::GET, "/api/admin/backups/runs", None).await;
    assert_eq!(runs.body["items"].as_array().unwrap().len(), 3);
    assert_eq!(runs.body["items"][0]["deletedCount"], 1);
    assert_eq!(runs.body["items"][0]["kind"], "manual");
    let audit = app.audit().await;
    assert!(audit.iter().any(|a| a == "backup.target_changed"));
    assert_eq!(audit.iter().filter(|a| *a == "backup.completed").count(), 3);
    app.finish().await;
}

#[tokio::test]
async fn an_unencrypted_backup_restores_into_a_stopped_server() {
    let app = test_app(false).await;
    if app.schema.is_some() {
        // The database of a PostgreSQL server is restored with pg_restore.
        app.finish().await;
        return;
    }
    let outside = common::private_tempdir();
    app.set("backups.allowed_dirs", json!([outside.path().to_string_lossy()])).await;
    app.set("backups.encrypt", json!(false)).await;
    let body = json!({ "target": { "kind": "local", "path": outside.path().to_string_lossy() }, "version": 0 });
    assert_eq!(app.admin(Method::PUT, "/api/admin/backups/target", Some(body)).await.status, StatusCode::OK);
    let r = app.admin(Method::POST, "/api/admin/backups/run", None).await;
    let file = outside.path().join(r.body["fileName"].as_str().unwrap());
    assert!(file.to_string_lossy().ends_with(".zip"));
    app.finish().await;

    let fresh = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = fresh.path().to_path_buf();
    let done = kalzit::backups::restore::restore(&config, &file, 1).unwrap();
    assert!(done.database);
    let pool = kalzit::db::connect(&config.database_url(), 1).await.unwrap();
    let (email,): (String,) = sqlx::query_as("SELECT email FROM users").fetch_one(&pool).await.unwrap();
    assert_eq!(email, "jonas@example.com");
    // A change after the restore, to see whether a later restore touches the database.
    sqlx::query("UPDATE users SET email = 'nach@example.com'").execute(&pool).await.unwrap();
    pool.close().await;

    // The same backup with plugins in it, into a plugin folder that holds someone else's file:
    // refused before anything is touched, the database and the folder stay as they were.
    let with_plugins = outside.path().join("with-plugins.zip");
    {
        let mut source = zip::ZipArchive::new(std::fs::File::open(&file).unwrap()).unwrap();
        let mut out = zip::ZipWriter::new(std::fs::File::create(&with_plugins).unwrap());
        for i in 0..source.len() {
            out.raw_copy_file(source.by_index(i).unwrap()).unwrap();
        }
        out.start_file("plugins/packages/demo/plugin.js", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut out, b"// demo").unwrap();
        out.finish().unwrap();
    }
    let general = common::private_tempdir();
    let plugins = general.path().join("tools");
    std::fs::create_dir(&plugins).unwrap();
    std::fs::write(plugins.join("notes.txt"), "mine").unwrap();
    config.paths.plugins_dir = Some(plugins.clone());
    let Err(err) = kalzit::backups::restore::restore(&config, &with_plugins, 2) else {
        panic!("the restore went through")
    };
    assert!(format!("{err:#}").contains("not Kalzit's"), "{err:#}");
    let pool = kalzit::db::connect(&config.database_url(), 1).await.unwrap();
    let (email,): (String,) = sqlx::query_as("SELECT email FROM users").fetch_one(&pool).await.unwrap();
    assert_eq!(email, "nach@example.com", "the refused restore left the database as it was");
    pool.close().await;
    assert_eq!(std::fs::read_to_string(plugins.join("notes.txt")).unwrap(), "mine");
    let beside: Vec<String> = std::fs::read_dir(general.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(beside, vec!["tools".to_string()], "nothing moved aside");
}

#[tokio::test]
async fn an_s3_target_is_tested_before_it_is_saved_and_keeps_its_secret() {
    let app = test_app(false).await;
    let (s3, port, task) = start_s3("AKIAKALZIT").await;
    let target = |key_id: &str, bucket: &str| {
        json!({ "kind": "s3", "endpoint": format!("http://127.0.0.1:{port}"), "bucket": bucket,
                "prefix": "prod/", "pathStyle": true, "accessKeyId": key_id })
    };
    let save = |t: Value, secret: Option<&str>, version: i64| json!({ "target": t, "secretAccessKey": secret, "version": version });
    let r =
        app.admin(Method::PUT, "/api/admin/backups/target", Some(save(target("AKIAKALZIT", "backups"), None, 0))).await;
    assert_eq!((r.reason(), r.body["error"]["field"].clone()), ("backup.secret_required", json!("secretAccessKey")));
    let r = app
        .admin(Method::PUT, "/api/admin/backups/target", Some(save(target("WRONG", "backups"), Some("s3cr3t"), 0)))
        .await;
    assert_eq!(
        (r.reason(), r.body["error"]["field"].clone()),
        ("backup.credentials_refused", json!("secretAccessKey"))
    );
    let r = app
        .admin(Method::PUT, "/api/admin/backups/target", Some(save(target("AKIAKALZIT", "missing"), Some("s3cr3t"), 0)))
        .await;
    assert_eq!((r.reason(), r.body["error"]["field"].clone()), ("backup.bucket_not_found", json!("bucket")));
    assert!(
        app.admin(Method::GET, "/api/admin/backups", None).await.body["target"].is_null(),
        "nothing saved after a failed test"
    );
    let r = app
        .admin(Method::PUT, "/api/admin/backups/target", Some(save(target("AKIAKALZIT", "backups"), Some("s3cr3t"), 0)))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["hasSecret"], true);
    assert!(!r.body.to_string().contains("s3cr3t"));
    // The test file is gone again.
    assert!(s3.objects.lock().unwrap().is_empty());
    let r = app.admin(Method::POST, "/api/admin/backups/target/test", Some(json!({}))).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);

    app.set("backups.keep_count", json!(1)).await;
    for _ in 0..2 {
        let r = app.admin(Method::POST, "/api/admin/backups/run", None).await;
        assert_eq!(r.body["status"], "succeeded", "{}", r.body);
        app.clock.advance_ms(1000);
    }
    let keys: Vec<String> = s3.objects.lock().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 1, "{keys:?}");
    assert!(keys[0].starts_with("prod/kalzit-backup-") && keys[0].ends_with(".zip.enc"), "{keys:?}");
    task.abort();
    app.finish().await;
}
