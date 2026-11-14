//! App plugins (docs/api/plugins.md, "App plugins"): an app installs like any plugin and waits
//! for the approval of its capabilities; once enabled its pages are served sandboxed to members
//! whose role the organization allows, it keeps its own storage within its limit, an
//! organization can block it, and an update that adds a capability waits for approval again.

use std::io::{Cursor, Write};
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use zip::write::SimpleFileOptions;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const ID: &str = "dev.example.board";
const PAGE: &str = "window.parent.postMessage({ kalzit: \"app\", api: 1, type: \"ready\" }, \"*\");\n";

fn manifest(version: &str, capabilities: &str) -> String {
    format!(
        "manifest = 1\nid = \"{ID}\"\nname = \"Tafel\"\nversion = \"{version}\"\nkind = \"app\"\nmin_kalzit = \"0.1.0\"\n\
         shapes = [\"frame\"]\npublisher = \"Example GmbH\"\n\n\
         [app]\napi = 1\ncapabilities = [{capabilities}]\n\n\
         [[app.pages]]\nid = \"board\"\ntitle = {{ en = \"Board\", de = \"Tafel\" }}\npath = \"dist/board.js\"\n\n\
         [files]\n\"dist/board.js\" = \"{}\"\n",
        hex::encode(Sha256::digest(PAGE.as_bytes()))
    )
}

fn package(key: &SigningKey, text: &str) -> Vec<u8> {
    let message = kalzit_plugin_api::signing::manifest_message(text.as_bytes());
    let sig = kalzit_release::DetachedSignature {
        key_id: kalzit_plugin_api::signing::key_id(&key.verifying_key()),
        signature: base64::engine::general_purpose::STANDARD.encode(key.sign(&message).to_bytes()),
    };
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("kalzit-plugin.toml", text.as_bytes().to_vec()),
        ("kalzit-plugin.sig", serde_json::to_vec(&sig).unwrap()),
        ("dist/board.js", PAGE.as_bytes().to_vec()),
    ] {
        zip.start_file(name, stored).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

struct TestApp {
    app: Router,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    owner: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    text: String,
    body: Value,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
}

fn cookie(headers: &HeaderMap) -> String {
    headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string()
}

impl TestApp {
    async fn new() -> Self {
        let dir = common::private_tempdir();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        config.server.http_addr = "127.0.0.1:3998".into();
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = Self { app, state, dir: Arc::new(dir), owner: String::new(), org: String::new() };
        let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                           "email": "joerg@example.de", "password": PASSWORD });
        let r = t.call(Method::POST, "/api/setup", Body::from(body.to_string()), "application/json", "").await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        t.owner = cookie(&r.headers);
        t
    }

    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn call(&self, method: Method, path: &str, body: Body, content_type: &str, cookie: &str) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if !cookie.is_empty() {
            req = req.header(header::COOKIE, cookie);
        }
        let req = req.header(header::CONTENT_TYPE, content_type).body(body).unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, headers, text, body }
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: &str) -> Reply {
        let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
        self.call(method, &format!("/api{path}"), body, "application/json", cookie).await
    }

    async fn admin(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        self.send(method, path, body, &self.owner).await
    }

    async fn install(&self, bytes: Vec<u8>) -> Reply {
        self.call(Method::POST, "/api/admin/plugins", Body::from(bytes), "application/zip", &self.owner).await
    }

    async fn member(&self, name: &str, email: &str, role: &str) -> String {
        let r = self
            .admin(Method::POST, "/admin/users", Some(json!({ "name": name, "email": email, "password": PASSWORD })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        let r = self
            .admin(Method::POST, &format!("/orgs/{}/members", self.org), Some(json!({ "email": email, "role": role })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        let r = self.send(Method::POST, "/auth/login", Some(json!({ "email": email, "password": PASSWORD })), "").await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        cookie(&r.headers)
    }

    fn org_path(&self, rest: &str) -> String {
        format!("/orgs/{}{rest}", self.org)
    }
}

#[tokio::test]
async fn an_app_runs_its_pages_and_storage_for_the_roles_its_organization_allows() {
    let t = TestApp::new().await;
    let key = SigningKey::from_bytes(&[9; 32]);
    let public = base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes());
    let r = t.admin(Method::POST, "/admin/plugin-keys", Some(json!({ "name": "Example", "publicKey": public }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);

    let r = t.install(package(&key, &manifest("1.0.0", "\"dashboards:read\", \"storage\""))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!(r.body["kind"], "app");
    assert_eq!(r.body["appCapabilities"], json!(["dashboards:read", "storage"]));
    let viewer = t.member("Vera", "vera@example.de", "viewer").await;
    let frame = t.org_path(&format!("/apps/{ID}/pages/board/frame"));
    let r = t.send(Method::GET, &frame, None, &viewer).await;
    assert_eq!((r.status, r.reason()), (StatusCode::NOT_FOUND, "plugin.app_unavailable"));

    t.admin(Method::POST, &format!("/admin/plugins/{ID}/approve"), Some(json!({ "version": "1.0.0" }))).await;
    let r = t.admin(Method::POST, &format!("/admin/plugins/{ID}/enable"), None).await;
    assert_eq!(r.body["running"], true, "{}", r.text);
    let r = t.admin(Method::POST, &format!("/admin/plugins/{ID}/restart"), None).await;
    assert_eq!(r.reason(), "plugin.panel_has_no_process");

    let r = t.send(Method::GET, &t.org_path("/apps"), None, &viewer).await;
    assert_eq!(r.body["items"][0]["pages"][0]["id"], "board", "{}", r.text);
    let r = t.send(Method::GET, &frame, None, &viewer).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.text.contains(PAGE.trim_end()));
    let csp = r.headers["content-security-policy"].to_str().unwrap();
    assert!(csp.starts_with("sandbox allow-scripts") && csp.contains("connect-src 'none'"), "{csp}");
    let r = t.send(Method::GET, &t.org_path(&format!("/apps/{ID}/pages/other/frame")), None, &viewer).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Its own storage, within the limit and with checked keys.
    let note = t.org_path(&format!("/apps/{ID}/storage/note:1"));
    let r = t.send(Method::PUT, &note, Some(json!({ "value": { "text": "Umsatz prüfen" } })), &viewer).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.text);
    let r = t.send(Method::GET, &note, None, &viewer).await;
    assert_eq!(r.body["value"]["text"], "Umsatz prüfen");
    let r = t
        .send(Method::PUT, &t.org_path(&format!("/apps/{ID}/storage/bad%20key")), Some(json!({ "value": 1 })), &viewer)
        .await;
    assert_eq!(r.reason(), "plugin.app_storage_key");
    let big = "x".repeat(1000 * 1024);
    for i in 0..60 {
        let path = t.org_path(&format!("/apps/{ID}/storage/big:{i}"));
        let r = t.send(Method::PUT, &path, Some(json!({ "value": big })), &viewer).await;
        if r.status != StatusCode::NO_CONTENT {
            assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.app_storage_full"), "{}", r.text);
            assert!(i > 50, "full after {i}");
            break;
        }
        assert!(i < 52, "never full");
    }
    let r = t.send(Method::GET, &t.org_path(&format!("/apps/{ID}/storage")), None, &viewer).await;
    assert!(r.body["usedBytes"].as_i64().unwrap() <= 50 * 1024 * 1024);

    // The organization lets only editors and up use it, then blocks it.
    let settings = t.org_path(&format!("/app-settings/{ID}"));
    let r = t.send(Method::PUT, &settings, Some(json!({ "minRole": "editor" })), &viewer).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t.admin(Method::PUT, &settings, Some(json!({ "minRole": "superuser" }))).await;
    assert_eq!(r.reason(), "plugin.app_role_invalid");
    let r = t.admin(Method::PUT, &settings, Some(json!({ "minRole": "editor" }))).await;
    assert_eq!(r.body["minRole"], "editor", "{}", r.text);
    assert_eq!(t.send(Method::GET, &frame, None, &viewer).await.reason(), "plugin.app_unavailable");
    assert_eq!(t.send(Method::GET, &note, None, &viewer).await.reason(), "plugin.app_unavailable");
    assert!(
        t.send(Method::GET, &t.org_path("/apps"), None, &viewer).await.body["items"].as_array().unwrap().is_empty()
    );
    assert_eq!(t.admin(Method::GET, &frame, None).await.status, StatusCode::OK);
    let r = t.admin(Method::PUT, &settings, Some(json!({ "blocked": true }))).await;
    assert_eq!(r.body["blocked"], true, "{}", r.text);
    assert_eq!(t.admin(Method::GET, &frame, None).await.reason(), "plugin.app_unavailable");
    let r = t.admin(Method::GET, &t.org_path("/app-settings"), None).await;
    assert_eq!(
        (r.body["items"][0]["blocked"].clone(), r.body["items"][0]["minRole"].clone()),
        (json!(true), json!("editor"))
    );
    t.admin(Method::PUT, &settings, Some(json!({ "blocked": false }))).await;

    // An update that adds a capability waits for approval; the installed version keeps running.
    let r = t.install(package(&key, &manifest("1.1.0", "\"dashboards:read\", \"storage\", \"analyses:run\""))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = t.admin(Method::GET, &format!("/admin/plugins/{ID}"), None).await;
    assert_eq!(r.body["version"], "1.0.0", "{}", r.text);
    assert_eq!(r.body["pending"]["addedCapabilities"], json!(["analyses:run"]), "{}", r.text);
    // One without new capabilities applies at once.
    let r = t.install(package(&key, &manifest("1.2.0", "\"dashboards:read\""))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let r = t.admin(Method::GET, &format!("/admin/plugins/{ID}"), None).await;
    assert_eq!(r.body["version"], "1.2.0", "{}", r.text);
    // Without `storage` the app keeps nothing.
    assert_eq!(t.admin(Method::GET, &note, None).await.reason(), "plugin.app_capability_missing");
    t.finish().await;
}
