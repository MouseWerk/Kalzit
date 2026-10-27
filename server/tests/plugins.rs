//! Contract tests of the plugin host with a real plugin process (plugin-api/test-plugin): install
//! and the refusals of packages, signatures and updates; permissions, enabling and organization
//! blocks; queries through the process with the host's limits; supervision with timeouts,
//! crashes, backoff and restart; and what the sandbox holds on Windows and Linux.

use std::io::{Cursor, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use kalzit::plugins::supervisor::Options;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use zip::write::SimpleFileOptions;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const ID: &str = "dev.example.testplugin";

/// The test plugin's binary, built once per test run (cargo shares the target directory).
fn plugin_binary() -> &'static [u8] {
    static BINARY: OnceLock<Vec<u8>> = OnceLock::new();
    BINARY.get_or_init(|| {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let out = std::process::Command::new(cargo)
            .args(["build", "--quiet", "-p", "kalzit-test-plugin", "--message-format=json"])
            .output()
            .expect("cargo runs");
        assert!(out.status.success(), "building the test plugin failed: {}", String::from_utf8_lossy(&out.stderr));
        let path = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|m| m["target"]["name"] == "kalzit-test-plugin")
            .find_map(|m| m["executable"].as_str().map(PathBuf::from))
            .expect("cargo names the test plugin's executable");
        std::fs::read(path).unwrap()
    })
}

fn platform() -> &'static str {
    kalzit::plugins::platform().expect("plugins run on this platform")
}

fn binary_path() -> String {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    format!("bin/{}/kalzit-test-plugin{exe}", platform())
}

/// What goes into a package.
struct Pkg<'a> {
    id: &'a str,
    version: &'a str,
    mode: &'a str,
    /// Extra lines for the manifest (permissions), before `[binaries]`.
    extra: &'a str,
    key: Option<&'a SigningKey>,
    /// A file in the archive that the manifest does not list.
    smuggle: bool,
    /// The manifest is changed after it was signed.
    tamper: bool,
}

impl Default for Pkg<'_> {
    fn default() -> Self {
        Self { id: ID, version: "1.0.0", mode: "normal", extra: "", key: None, smuggle: false, tamper: false }
    }
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn signature(key: &SigningKey, manifest: &str) -> Vec<u8> {
    let message = kalzit_plugin_api::signing::manifest_message(manifest.as_bytes());
    let sig = kalzit_release::DetachedSignature {
        key_id: kalzit_plugin_api::signing::key_id(&key.verifying_key()),
        signature: base64::engine::general_purpose::STANDARD.encode(key.sign(&message).to_bytes()),
    };
    serde_json::to_vec(&sig).unwrap()
}

fn manifest(p: &Pkg) -> String {
    let binary = plugin_binary();
    format!(
        "manifest = 1\nid = \"{id}\"\nname = \"Test plugin\"\nversion = \"{version}\"\nkind = \"datasource\"\n\
         min_kalzit = \"0.1.0\"\nshapes = [\"frame\", \"documents\", \"graph\"]\nprotocol = 1\n\n\
         [[settings]]\nname = \"host\"\nlabel = {{ en = \"Host\", de = \"Rechner\" }}\ntype = \"string\"\nrequired = true\ntarget = true\n\n\
         [[settings]]\nname = \"password\"\nlabel = {{ en = \"Password\" }}\ntype = \"string\"\nsecret = true\n\n\
         {extra}\n[binaries]\n{platform} = \"{bin}\"\n\n[files]\n\"{bin}\" = \"{binary}\"\n\"kind.txt\" = \"{kind}\"\n\"mode.txt\" = \"{mode}\"\n",
        id = p.id,
        version = p.version,
        extra = p.extra,
        platform = platform(),
        bin = binary_path(),
        binary = sha(binary),
        kind = sha(p.id.as_bytes()),
        mode = sha(p.mode.as_bytes()),
    )
}

fn package(p: &Pkg) -> Vec<u8> {
    let text = manifest(p);
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut add = |name: &str, bytes: &[u8]| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(bytes).unwrap();
    };
    let shown = if p.tamper { text.replace("Test plugin", "Best plugin") } else { text.clone() };
    add("kalzit-plugin.toml", shown.as_bytes());
    if let Some(key) = p.key {
        add("kalzit-plugin.sig", &signature(key, &text));
    }
    add(&binary_path(), plugin_binary());
    add("kind.txt", p.id.as_bytes());
    add("mode.txt", p.mode.as_bytes());
    if p.smuggle {
        add("bin/helper.dll", b"not listed");
    }
    zip.finish().unwrap().into_inner()
}

struct TestApp {
    app: Router,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    cookie: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }
}

fn fast_options() -> Options {
    Options {
        start_timeout: Duration::from_secs(20),
        backoff: vec![Duration::from_millis(300), Duration::from_millis(300)],
        stable_after: Duration::from_secs(600),
        probe_interval: Duration::from_secs(600),
        probe_timeout: Duration::from_secs(5),
        limits: Default::default(),
    }
}

async fn test_app() -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3999".into();
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
    state.plugins.set_options(fast_options());
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));
    let mut t = TestApp { app, state, dir: Arc::new(dir), cookie: String::new(), org: String::new() };
    let r = t
        .raw(
            Method::POST,
            "/api/setup",
            Body::from(
                json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                        "email": "joerg@example.de", "password": PASSWORD })
                .to_string(),
            ),
            "application/json",
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.org = r.body["body"]["orgs"][0]["id"].as_str().unwrap().to_string();
    t.cookie = r.body["cookie"].as_str().unwrap().to_string();
    // Without Landlock plugins are refused on Linux; where the runner lacks it, the tests allow
    // it (and the sandbox test checks the layers it gets).
    if cfg!(target_os = "linux") && !kalzit::plugins::sandbox::landlock_available() {
        eprintln!("Landlock is not available here; plugins are allowed without it");
        let r = t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowWithoutLandlock": true }))).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }
    t
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn raw(&self, method: Method, path: &str, body: Body, content_type: &str) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if !self.cookie.is_empty() {
            req = req.header(header::COOKIE, &self.cookie);
        }
        let req = req.header(header::CONTENT_TYPE, content_type).body(body).unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(cookie) = headers.get(header::SET_COOKIE) {
            let cookie = cookie.to_str().unwrap().split(';').next().unwrap().to_string();
            return Reply { status, body: json!({ "cookie": cookie, "body": body }) };
        }
        Reply { status, body }
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let body = body.map_or_else(Body::empty, |b| Body::from(b.to_string()));
        self.raw(method, &format!("/api{path}"), body, "application/json").await
    }

    async fn install(&self, p: &Pkg<'_>) -> Reply {
        self.raw(Method::POST, "/api/admin/plugins", Body::from(package(p)), "application/zip").await
    }

    async fn trust(&self, key: &SigningKey) {
        let public = base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes());
        let r = self
            .send(Method::POST, "/admin/plugin-keys", Some(json!({ "name": "Example", "publicKey": public })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    }

    /// Installs, approves and enables the plugin.
    async fn ready(&self, p: &Pkg<'_>) {
        let r = self.install(p).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let r = self
            .send(Method::POST, &format!("/admin/plugins/{}/approve", p.id), Some(json!({ "version": p.version })))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let r = self.send(Method::POST, &format!("/admin/plugins/{}/enable", p.id), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        assert_eq!(r.body["running"], true, "{}", r.body);
    }

    async fn datasource(&self, kind: &str, timeout_secs: u64) -> String {
        let body = json!({
            "name": format!("Quelle {}", uuid::Uuid::now_v7()),
            "kind": kind,
            "settings": { "host": "db.example.test", "queryTimeoutSecs": timeout_secs },
            "secrets": { "password": "geheim-4711" }
        });
        let r = self.send(Method::POST, &format!("/orgs/{}/datasources", self.org), Some(body)).await;
        if r.status != StatusCode::CREATED {
            let logs = self.send(Method::GET, &format!("/admin/plugins/{kind}/logs"), None).await;
            let plugin = self.send(Method::GET, &format!("/admin/plugins/{kind}"), None).await;
            panic!(
                "creating the source failed: {}; the plugin's output: {}; the plugin: {}",
                r.body, logs.body, plugin.body
            );
        }
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn query(&self, ds: &str, query: Value) -> Value {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": ds, "query": query }],
            "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 },
        });
        let r = self.send(Method::POST, &format!("/orgs/{}/query", self.org), Some(body)).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body["results"]["A"].clone()
    }

    async fn plugin(&self, id: &str) -> Value {
        let r = self.send(Method::GET, &format!("/admin/plugins/{id}"), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body
    }

    async fn audit_actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT action FROM audit_events WHERE action LIKE 'plugins.%' ORDER BY created_at, id")
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

#[tokio::test]
async fn packages_signatures_and_updates_are_checked() {
    let t = test_app().await;
    let (publisher, other) = (key(1), key(2));

    // Unsigned is refused by default, and so is a key nobody trusts.
    assert_eq!(t.install(&Pkg::default()).await.reason(), "plugin.unsigned_refused");
    assert_eq!(
        t.install(&Pkg { key: Some(&publisher), ..Default::default() }).await.reason(),
        "plugin.signer_untrusted"
    );
    t.trust(&publisher).await;

    // An unlisted file, a reserved id, a broken archive.
    let r = t.install(&Pkg { key: Some(&publisher), smuggle: true, ..Default::default() }).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "plugin.package_invalid"), "{}", r.body);
    assert!(r.body["error"]["message"].as_str().unwrap().contains("package.file_unlisted"), "{}", r.body);
    let r = t.install(&Pkg { id: "io.kalzit.fake", key: Some(&publisher), ..Default::default() }).await;
    assert_eq!(r.reason(), "plugin.id_reserved");
    let r = t.raw(Method::POST, "/api/admin/plugins", Body::from("kein zip"), "application/zip").await;
    assert_eq!(r.reason(), "plugin.package_unreadable");

    // A signature that does not match the manifest is refused, also with unsigned allowed.
    let r = t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    assert_eq!((r.status, r.body["allowUnsigned"].clone()), (StatusCode::OK, json!(true)));
    let r = t.install(&Pkg { key: Some(&publisher), tamper: true, ..Default::default() }).await;
    assert_eq!(r.reason(), "plugin.signature_invalid", "{}", r.body);

    // A good install waits for approval and is off.
    let r = t.install(&Pkg { key: Some(&publisher), ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!((r.body["approved"].clone(), r.body["enabled"].clone()), (json!(false), json!(false)));
    assert_eq!(r.body["signer"], "publisher");
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/enable"), None).await;
    assert_eq!(r.reason(), "plugin.not_approved");

    // Updates: never older, never unsigned once signed, only with the same key.
    let r = t.install(&Pkg { version: "0.9.0", key: Some(&publisher), ..Default::default() }).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.downgrade"));
    assert_eq!(t.install(&Pkg { version: "1.1.0", ..Default::default() }).await.reason(), "plugin.key_changed");
    t.trust(&other).await;
    let r = t.install(&Pkg { version: "1.1.0", key: Some(&other), ..Default::default() }).await;
    assert_eq!(r.reason(), "plugin.key_changed");

    // A hand-over signed by the old key lets the new one sign from 1.1.0 on.
    let statement = kalzit_plugin_api::signing::HandOver {
        plugin_id: ID.into(),
        from: hex::encode(publisher.verifying_key().as_bytes()),
        to: hex::encode(other.verifying_key().as_bytes()),
        from_version: "1.1.0".into(),
    };
    let sig = publisher.sign(&kalzit_plugin_api::signing::handover_message(&statement));
    let mut body = json!({
        "fromKey": statement.from, "toKey": statement.to, "fromVersion": "1.1.0",
        "signature": hex::encode(other.sign(b"wrong").to_bytes()),
    });
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/handovers"), Some(body.clone())).await;
    assert_eq!(r.reason(), "plugin.handover_invalid");
    body["signature"] = json!(hex::encode(sig.to_bytes()));
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/handovers"), Some(body)).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    let r = t.install(&Pkg { version: "1.1.0", key: Some(&other), ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["version"], "1.1.0");

    // Approved and running, an update that adds a network target waits for approval while
    // the installed version keeps running.
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/approve"), Some(json!({ "version": "1.1.0" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/enable"), None).await;
    assert_eq!(r.body["running"], true, "{}", r.body);
    let extra = "[[permissions.network]]\nsetting = \"host\"\nform = \"host\"\ndefault_port = 6379\n";
    let r = t.install(&Pkg { version: "1.2.0", key: Some(&other), extra, ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["version"], "1.1.0", "{}", r.body);
    assert_eq!(r.body["pending"]["version"], "1.2.0");
    assert_eq!(r.body["pending"]["addedPermissions"][0]["setting"], "host", "{}", r.body);
    assert_eq!(r.body["running"], true);
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/approve"), Some(json!({ "version": "9.9.9" }))).await;
    assert_eq!(r.reason(), "plugin.version_mismatch");
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/approve"), Some(json!({ "version": "1.2.0" }))).await;
    assert_eq!((r.body["version"].clone(), r.body["pending"].clone()), (json!("1.2.0"), Value::Null), "{}", r.body);
    assert_eq!(r.body["running"], true);

    // A fixed target that the target rules refuse is refused at install.
    let metadata = "[[permissions.network]]\nhost = \"169.254.169.254\"\nport = 80\n";
    let r = t.install(&Pkg { version: "1.2.5", key: Some(&other), extra: metadata, ..Default::default() }).await;
    assert_eq!(r.reason(), "plugin.target_refused", "{}", r.body);

    // Removing the trusted key stops the plugins whose installed version it signed and drops
    // updates it signed, after confirmation. Here both: 1.2.0 runs, 1.3.0 waits.
    let more = "[[permissions.network]]\nsetting = \"host\"\nform = \"host\"\ndefault_port = 6380\n";
    let r = t.install(&Pkg { version: "1.3.0", key: Some(&other), extra: more, ..Default::default() }).await;
    assert_eq!(r.body["pending"]["version"], "1.3.0", "{}", r.body);
    let key_id = kalzit_plugin_api::signing::key_id(&other.verifying_key());
    let r = t.send(Method::DELETE, &format!("/admin/plugin-keys/{key_id}"), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.key_in_use"));
    assert_eq!(r.body["error"]["params"]["plugins"], ID);
    assert_eq!(r.body["error"]["params"]["pending"], ID);
    let r = t.send(Method::DELETE, &format!("/admin/plugin-keys/{key_id}?confirm=true"), None).await;
    assert_eq!(r.body["stopped"], json!([ID]), "{}", r.body);
    let p = t.plugin(ID).await;
    assert_eq!((p["trusted"].clone(), p["running"].clone()), (json!(false), json!(false)), "{p}");
    assert_eq!(p["pending"], Value::Null, "the update signed with the key is dropped: {p}");

    let actions = t.audit_actions().await;
    for action in [
        "plugins.key_added",
        "plugins.unsigned_allowed",
        "plugins.installed",
        "plugins.handover_added",
        "plugins.updated",
        "plugins.approved",
        "plugins.enabled",
        "plugins.update_pending",
        "plugins.key_removed",
        "plugins.install_refused",
    ] {
        assert!(actions.iter().any(|a| a == action), "{action} is missing from {actions:?}");
    }
    t.finish().await;
}

#[tokio::test]
async fn a_plugin_serves_its_kind_within_the_limits_and_organizations_can_block_it() {
    let t = test_app().await;
    let publisher = key(3);
    t.trust(&publisher).await;
    t.ready(&Pkg { key: Some(&publisher), ..Default::default() }).await;

    // The kind with its labels from the manifest.
    let r = t.send(Method::GET, &format!("/orgs/{}/datasource-kinds", t.org), None).await;
    let kind = r.body["items"].as_array().unwrap().iter().find(|k| k["kind"] == ID).cloned().expect("listed");
    assert_eq!(kind["plugin"]["labels"]["host"]["de"], "Rechner", "{kind}");

    // The plugin's own settings check.
    let body = json!({ "name": "Kaputt", "kind": ID, "settings": { "host": "invalid" } });
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources", t.org), Some(body)).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "settings.host_invalid"), "{}", r.body);
    assert_eq!(r.body["error"]["field"], "host");

    let ds = t.datasource(ID, 3).await;
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert_eq!(r["result"]["frame"]["fields"][0]["values"], json!([0, 1, 2]), "{r}");
    let r = t.query(&ds, json!({ "do": "documents" })).await;
    assert_eq!(r["result"]["documents"]["documents"][0]["a"], "zwei", "{r}");
    let r = t.query(&ds, json!({ "do": "graph" })).await;
    assert_eq!(r["result"]["graph"]["edges"][0]["type"], "KNOWS", "{r}");
    // The row limit of the query, whatever the plugin sends.
    let body = json!({
        "queries": [{ "refId": "A", "datasourceId": ds, "query": { "do": "rows", "n": 5000 }, "limit": 100 }],
        "timeRange": { "from": 0, "to": 1 },
    });
    let r = t.send(Method::POST, &format!("/orgs/{}/query", t.org), Some(body)).await;
    let frame = &r.body["results"]["A"]["result"]["frame"];
    assert_eq!(frame["fields"][0]["values"].as_array().map(Vec::len), Some(100), "{}", r.body);
    // Broken streams fail the query, the plugin's own reasons arrive as plugin.error.
    let r = t.query(&ds, json!({ "do": "malformed" })).await;
    assert_eq!(r["error"]["reason"], "plugin.protocol", "{r}");
    let r = t.query(&ds, json!({ "do": "no_end" })).await;
    assert_eq!(r["error"]["reason"], "plugin.protocol", "{r}");
    let r = t.query(&ds, json!({ "do": "error" })).await;
    assert_eq!(
        (r["error"]["code"].clone(), r["error"]["reason"].clone()),
        (json!("query_rejected"), json!("plugin.error"))
    );
    assert_eq!(r["error"]["params"]["reason"], "testplugin.refused", "{r}");
    // A query that never ends is stopped at its time limit; the plugin keeps serving.
    let r = t.query(&ds, json!({ "do": "hang" })).await;
    assert_eq!(r["error"]["code"], "query_timeout", "{r}");
    let r = t.query(&ds, json!({ "do": "endless" })).await;
    assert!(r["error"]["code"] == "query_timeout" || r["error"]["reason"] == "plugin.protocol", "{r}");
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert!(r["result"]["frame"].is_object(), "{r}");

    // Health and schema.
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources/{ds}/health", t.org), Some(json!({}))).await;
    assert_eq!(
        (r.body["ok"].clone(), r.body["reason"].clone()),
        (json!(true), json!("health.connected")),
        "{}",
        r.body
    );
    let r = t.send(Method::GET, &format!("/orgs/{}/datasources/{ds}/schema", t.org), None).await;
    assert_eq!(r.body["kind"], "tables", "{}", r.body);

    // Output floods are bounded and counted.
    t.query(&ds, json!({ "do": "flood" })).await;
    let r = t.send(Method::GET, &format!("/admin/plugins/{ID}/logs"), None).await;
    assert!(r.body["dropped"].as_u64().unwrap() > 0, "{}", r.body);
    assert!(r.body["lines"].as_array().unwrap().len() <= kalzit::plugins::supervisor::MAX_LOG_LINES);

    // An organization blocks the plugin: not offered, its sources stop; and back.
    let r = t.send(Method::PUT, &format!("/orgs/{}/plugins/{ID}/block", t.org), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    let r = t.send(Method::GET, &format!("/orgs/{}/plugins", t.org), None).await;
    assert_eq!(r.body["items"][0]["blocked"], true, "{}", r.body);
    let r = t.send(Method::GET, &format!("/orgs/{}/datasource-kinds", t.org), None).await;
    assert!(r.body["items"].as_array().unwrap().iter().all(|k| k["kind"] != ID));
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert_eq!(r["error"]["reason"], "datasource.kind_unavailable", "{r}");
    let r = t.send(Method::DELETE, &format!("/orgs/{}/plugins/{ID}/block", t.org), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert!(r["result"]["frame"].is_object(), "{r}");

    // Disabled: the kind is gone, its sources stay.
    t.send(Method::POST, &format!("/admin/plugins/{ID}/disable"), None).await;
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert_eq!(r["error"]["reason"], "datasource.kind_unavailable", "{r}");
    let r = t.send(Method::DELETE, &format!("/admin/plugins/{ID}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let actions = t.audit_actions().await;
    for action in ["plugins.blocked", "plugins.unblocked", "plugins.disabled", "plugins.removed"] {
        assert!(actions.iter().any(|a| a == action), "{action} is missing from {actions:?}");
    }
    t.finish().await;
}

#[tokio::test]
async fn crashes_restart_with_backoff_until_stopped_and_an_admin_restarts() {
    let t = test_app().await;
    let r = t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    assert_eq!(r.status, StatusCode::OK);
    t.ready(&Pkg::default()).await;
    let ds = t.datasource(ID, 5).await;

    // A crash in a query fails that query only; the next one after the wait starts it again.
    let r = t.query(&ds, json!({ "do": "crash" })).await;
    assert_eq!(r["error"]["code"], "datasource_error", "{r}");
    let status = t.plugin(ID).await["process"].clone();
    assert!(status["state"] == "waiting" || status["state"] == "running", "{status}");
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    if r["error"]["reason"] == "plugin.restarting" {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert!(r["result"]["frame"].is_object(), "{r}");
    let status = t.plugin(ID).await["process"].clone();
    assert_eq!(status["state"], "running", "{status}");
    assert!(status["starts"].as_u64().unwrap() >= 2, "{status}");
    t.finish().await;

    // A plugin that crashes at every start is stopped after the last wait.
    let t = test_app().await;
    t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    t.ready(&Pkg { mode: "crash", ..Default::default() }).await;
    let ds = t.datasource(ID, 5).await;
    // Saving the source started it once already (and did not refuse the settings).
    let mut reasons = Vec::new();
    for _ in 0..5 {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let r = t.query(&ds, json!({ "do": "frame" })).await;
        reasons.push(r["error"]["reason"].as_str().unwrap_or_default().to_string());
    }
    assert_eq!(reasons.first().map(String::as_str), Some("plugin.exited"), "{reasons:?}");
    assert_eq!(reasons.last().map(String::as_str), Some("plugin.stopped"), "{reasons:?}");
    let status = t.plugin(ID).await["process"].clone();
    assert_eq!((status["state"].clone(), status["failures"].clone()), (json!("stopped"), json!(3)), "{status}");
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/restart"), None).await;
    assert_eq!(r.body["process"]["state"], "idle", "{}", r.body);
    assert_eq!(r.body["process"]["failures"], 0);
    let logs = t.send(Method::GET, &format!("/admin/plugins/{ID}/logs"), None).await;
    let text = logs.body["lines"].to_string();
    assert!(text.contains("crashes at start"), "{text}");
    t.finish().await;
}

#[tokio::test]
async fn starts_that_hang_or_break_the_handshake_are_refused() {
    for (mode, reason) in [
        ("hang", "plugin.start_timeout"),
        ("bad_handshake", "plugin.start_timeout"),
        ("newer_protocol", "plugin.protocol_unsupported"),
        ("wrong_kind", "plugin.describe_mismatch"),
    ] {
        let t = test_app().await;
        t.state.plugins.set_options(Options { start_timeout: Duration::from_secs(3), ..fast_options() });
        t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
        t.ready(&Pkg { mode, ..Default::default() }).await;
        // Saving the source tried the first start; the next one after the wait fails the same way.
        let ds = t.datasource(ID, 10).await;
        assert_eq!(t.plugin(ID).await["process"]["lastError"]["reason"], reason, "{mode}");
        tokio::time::sleep(Duration::from_millis(400)).await;
        let r = t.query(&ds, json!({ "do": "frame" })).await;
        assert_eq!(r["error"]["reason"], reason, "{mode}: {r}");
        t.finish().await;
    }
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
    // SAFETY: a handle opened, waited on for up to two seconds and closed.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else { return false };
        let waited = WaitForSingleObject(h, 2000);
        let _ = CloseHandle(h);
        waited == WAIT_TIMEOUT
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    for _ in 0..20 {
        // SAFETY: signal 0 only checks that the process exists.
        let exists = unsafe { libc::kill(pid as libc::pid_t, 0) } == 0;
        let zombie = std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|s| s.contains(") Z "));
        if !exists || zombie {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    true
}

#[tokio::test]
async fn the_sandbox_holds() {
    let t = test_app().await;
    t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    t.ready(&Pkg::default()).await;
    let ds = t.datasource(ID, 10).await;
    let first = |r: Value| r["result"]["documents"]["documents"][0].clone();

    // Nothing of Kalzit's environment reaches the plugin.
    let env = first(t.query(&ds, json!({ "do": "env" })).await);
    let names: Vec<&str> = env["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    assert!(names.contains(&"KALZIT_PLUGIN_TOKEN"), "{names:?}");
    assert!(!names.iter().any(|n| n.starts_with("CARGO") || n.starts_with("RUST")), "{names:?}");

    // Its temporary directory is writable, Kalzit's data directory is not.
    let r = first(t.query(&ds, json!({ "do": "temp" })).await);
    assert_eq!(r["ok"], true, "{r}");
    let status = t.plugin(ID).await["process"].clone();
    let layers: Vec<&str> = status["sandbox"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    // Kalzit's process cannot be opened for reading (its memory and environment hold secrets).
    let r = first(t.query(&ds, json!({ "do": "open_host" })).await);
    if cfg!(windows) || layers.contains(&"landlock") {
        assert_eq!(r["ok"], false, "the plugin opened Kalzit's process: {r} ({layers:?})");
    }
    let outside = t.dir.path().join("written-by-plugin.txt");
    let r = first(t.query(&ds, json!({ "do": "write", "path": outside })).await);
    if cfg!(windows) || layers.contains(&"landlock") {
        assert_eq!(r["ok"], false, "the plugin wrote into the data directory: {r} ({layers:?})");
        assert!(!outside.exists());
        let db = t.dir.path().join("kalzit.db");
        let r = first(t.query(&ds, json!({ "do": "read", "path": db })).await);
        assert_eq!(r["ok"], false, "the plugin read Kalzit's database: {r} ({layers:?})");
    } else {
        eprintln!("Landlock is not available on this host; layers: {layers:?}");
    }

    #[cfg(target_os = "linux")]
    {
        assert!(layers.contains(&"no_new_privs") && layers.contains(&"seccomp"), "{layers:?}");
        if layers.contains(&"signals") {
            let r = first(t.query(&ds, json!({ "do": "signal_host" })).await);
            assert_eq!(r["ok"], false, "the plugin may signal Kalzit: {r}");
        }
        let r = first(t.query(&ds, json!({ "do": "ptrace" })).await);
        assert_eq!((r["ok"].clone(), r["errno"].clone()), (json!(false), json!(1)), "ptrace is refused: {r}");
    }
    #[cfg(windows)]
    {
        for layer in ["restricted_token", "job_object", "kill_on_close", "process_limit"] {
            assert!(layers.contains(&layer), "{layer}: {layers:?}");
        }
        // The process limit of the job.
        let r = first(t.query(&ds, json!({ "do": "spawn_many", "n": 40 })).await);
        assert!(r["failed"].as_u64().unwrap() > 0 && r["started"].as_u64().unwrap() < 40, "{r}");
    }

    // Another plugin's process is out of reach as well.
    let other = "dev.example.otherplugin";
    t.ready(&Pkg { id: other, ..Default::default() }).await;
    let ds2 = t.datasource(other, 10).await;
    t.query(&ds2, json!({ "do": "frame" })).await;
    let other_pid = t.plugin(other).await["process"]["pid"].as_u64().unwrap();
    let r = first(t.query(&ds, json!({ "do": "open_pid", "pid": other_pid })).await);
    if cfg!(windows) || layers.contains(&"landlock") {
        assert_eq!(r["ok"], false, "the plugin opened another plugin's process: {r}");
    }

    // A child of the plugin ends with it.
    let r = first(t.query(&ds, json!({ "do": "child" })).await);
    let child = r["pid"].as_u64().unwrap_or_else(|| panic!("no child: {r}")) as u32;
    let plugin = status["pid"].as_u64().unwrap() as u32;
    assert!(alive(child), "the child runs");
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/disable"), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(!alive(plugin), "the plugin process ended");
    assert!(!alive(child), "the plugin's child ended with it");
    t.finish().await;
}

#[tokio::test]
async fn processes_end_when_kalzit_stops() {
    let t = test_app().await;
    t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    t.ready(&Pkg::default()).await;
    let ds = t.datasource(ID, 10).await;
    t.query(&ds, json!({ "do": "frame" })).await;
    let pid = t.plugin(ID).await["process"]["pid"].as_u64().unwrap() as u32;
    assert!(alive(pid));
    t.finish().await;
    assert!(!alive(pid), "the plugin process ended with the server");
}
