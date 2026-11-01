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
         publisher = \"Example GmbH\"\n\
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
        max_connections: 64,
        connection_idle: Duration::from_secs(600),
        connect_timeout: Duration::from_secs(5),
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
        self.datasource_with(kind, json!({ "host": "db.example.test", "queryTimeoutSecs": timeout_secs })).await
    }

    async fn datasource_with(&self, kind: &str, settings: Value) -> String {
        let body = json!({
            "name": format!("Quelle {}", uuid::Uuid::now_v7()),
            "kind": kind,
            "settings": settings,
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

    /// The first document a query of the test plugin answers; fails with the plugin's state and
    /// output when there is none.
    async fn doc(&self, ds: &str, id: &str, query: Value) -> Value {
        let r = self.query(ds, query).await;
        let doc = r["result"]["documents"]["documents"][0].clone();
        if !doc.is_object() {
            let logs = self.send(Method::GET, &format!("/admin/plugins/{id}/logs"), None).await;
            panic!("no answer: {r}; the plugin: {}; its output: {}", self.plugin(id).await, logs.body);
        }
        doc
    }

    async fn plugin(&self, id: &str) -> Value {
        let r = self.send(Method::GET, &format!("/admin/plugins/{id}"), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body
    }

    async fn install_confirmed(&self, p: &Pkg<'_>) -> Reply {
        let path = "/api/admin/plugins?confirmPublisherChange=true";
        self.raw(Method::POST, path, Body::from(package(p)), "application/zip").await
    }

    async fn allow_unsigned(&self) {
        let r = self.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    /// The stored secrets of every data source of the test plugin's kind.
    async fn secrets_of_kind(&self) -> i64 {
        let (n,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM datasource_secrets s JOIN datasources d ON d.id = s.datasource_id WHERE d.kind = $1",
        )
        .bind(ID)
        .fetch_one(&self.state.db)
        .await
        .unwrap();
        n
    }

    /// A source of the kind in another organization and one in the trash, each with a secret.
    async fn foreign_sources(&self) -> (String, String) {
        let db = &self.state.db;
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('org-other', 'Andere', 0)")
            .execute(db)
            .await
            .unwrap();
        let ids = ("ds-other-org".to_string(), "ds-trashed".to_string());
        for (id, org, deleted) in [(&ids.0, "org-other", None), (&ids.1, self.org.as_str(), Some(1_i64))] {
            sqlx::query(
                "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at, deleted_at) \
                 VALUES ($1, $2, $1, $3, '{}', 0, 0, $4)",
            )
            .bind(id)
            .bind(org)
            .bind(ID)
            .bind(deleted)
            .execute(db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO datasource_secrets (datasource_id, field, key_id, nonce, ciphertext) \
                 VALUES ($1, 'password', 'k', 'n', 'c')",
            )
            .bind(id)
            .execute(db)
            .await
            .unwrap();
        }
        ids
    }

    /// The summary of the one `plugins.publisher_changed` entry.
    async fn publisher_changed(&self) -> Value {
        let (summary,): (String,) = sqlx::query_as(
            "SELECT summary FROM audit_events WHERE action = 'plugins.publisher_changed' AND resource_id = $1",
        )
        .bind(ID)
        .fetch_one(&self.state.db)
        .await
        .unwrap();
        serde_json::from_str(&summary).unwrap()
    }

    async fn audit_actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT action FROM audit_events WHERE action LIKE 'plugins.%' ORDER BY created_at, id")
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }

    /// The data sources the plugin released so far, asked through the source `via`, once at
    /// least `count` arrived (`Release` runs in the background) or after 10 seconds.
    async fn released(&self, via: &str, count: usize) -> Vec<String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let mut asked = 0u32;
        loop {
            asked += 1;
            let doc = self.doc(via, ID, json!({ "do": "released", "asked": asked })).await;
            let released: Vec<String> = serde_json::from_value(doc["released"].clone()).unwrap();
            if released.len() >= count || std::time::Instant::now() > deadline {
                return released;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
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
    assert_eq!(kind["plugin"]["publisher"], "Example GmbH", "{kind}");

    // The plugin's own settings check.
    let body = json!({ "name": "Kaputt", "kind": ID, "settings": { "host": "invalid" } });
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources", t.org), Some(body)).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "settings.host_invalid"), "{}", r.body);
    assert_eq!(r.body["error"]["field"], "host");

    let ds = t.datasource(ID, 3).await;
    let r = t.query(&ds, json!({ "do": "frame" })).await;
    assert_eq!(r["result"]["frame"]["fields"][0]["values"], json!([0, 1, 2]), "{r}");

    // One plugin names the sources of its kind in every organization, and its manifest.
    let p = t.plugin(ID).await;
    assert_eq!(p["usedIn"].as_array().map(Vec::len), Some(1), "{p}");
    assert_eq!(p["usedIn"][0]["id"], ds.as_str(), "{p}");
    assert_eq!(p["usedIn"][0]["orgId"], t.org.as_str(), "{p}");
    assert_eq!(p["usedIn"][0]["orgName"], "Müller & Söhne", "{p}");
    assert!(p["manifest"].as_str().unwrap().contains("publisher = \"Example GmbH\""), "{p}");
    let r = t.send(Method::GET, "/admin/plugins", None).await;
    assert!(r.body["items"][0].get("usedIn").is_none(), "the list leaves it out: {}", r.body);
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

/// A data source that changes or goes to the trash is released by the plugin that served it
/// (`Release`), once: a source the plugin was not handed since is not released again, also not
/// when it is purged.
#[tokio::test]
async fn changed_and_trashed_sources_are_released_once() {
    let t = test_app().await;
    let publisher = key(3);
    t.trust(&publisher).await;
    t.ready(&Pkg { key: Some(&publisher), ..Default::default() }).await;
    let ds = t.datasource(ID, 3).await;
    let via = t.datasource(ID, 3).await;
    let path = format!("/orgs/{}/datasources/{ds}", t.org);
    assert!(t.query(&ds, json!({ "do": "frame" })).await["result"]["frame"].is_object());
    assert_eq!(t.released(&via, 0).await, Vec::<String>::new());

    // A change: the plugin closes what it kept for the source.
    let r = t.send(Method::PATCH, &path, Some(json!({ "name": "Umbenannt" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.released(&via, 1).await, std::slice::from_ref(&ds));
    // Another change before the plugin was handed the source again releases nothing more.
    let r = t.send(Method::PATCH, &path, Some(json!({ "name": "Noch einmal" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(t.released(&via, 1).await, std::slice::from_ref(&ds), "exactly one release so far");

    // Handed again, then trashed: released a second time.
    assert!(t.query(&ds, json!({ "do": "frame" })).await["result"]["frame"].is_object());
    let r = t.send(Method::DELETE, &path, None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.released(&via, 2).await, [ds.clone(), ds.clone()]);

    // Purged from the trash: already released, nothing more arrives.
    let r = t.send(Method::DELETE, &format!("{path}/purge"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(t.released(&via, 2).await, [ds.clone(), ds]);
    t.finish().await;
}

/// A removed plugin leaves its key behind: installed again, its id is checked like an update.
/// Another key with data sources of the kind left needs the administrator's confirmation, and
/// then their stored secrets are cleared and the change is audited; the same key just works.
#[tokio::test]
async fn a_removed_plugin_id_stays_bound_to_its_key() {
    let t = test_app().await;
    let (publisher, other) = (key(11), key(12));
    t.trust(&publisher).await;
    t.trust(&other).await;
    t.ready(&Pkg { key: Some(&publisher), ..Default::default() }).await;
    let ds = t.datasource(ID, 3).await;
    // A source of another organization and one in the trash: their secrets count too.
    let elsewhere = t.foreign_sources().await;
    assert_eq!(t.secrets_of_kind().await, 3);
    // Its connection is cached once it has run a query.
    assert!(t.query(&ds, json!({ "do": "frame" })).await["result"].is_object());
    let (app, path) = (&t, format!("/admin/plugins/{ID}"));
    let remove = || app.send(Method::DELETE, &path, None);
    assert_eq!(remove().await.status, StatusCode::NO_CONTENT);

    // Another key is refused without confirmation; the secrets stay.
    let r = t.install(&Pkg { version: "1.1.0", key: Some(&other), ..Default::default() }).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.publisher_changed"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["datasources"], "3", "{}", r.body);
    assert_eq!(r.body["error"]["params"]["removedVersion"], "1.0.0", "{}", r.body);
    assert_eq!(
        r.body["error"]["params"]["previousKeyId"],
        kalzit_plugin_api::signing::key_id(&publisher.verifying_key()),
        "{}",
        r.body
    );
    assert_eq!(t.secrets_of_kind().await, 3);
    // So is an unsigned package, with unsigned plugins allowed.
    t.allow_unsigned().await;
    let r = t.install(&Pkg { version: "1.1.0", ..Default::default() }).await;
    assert_eq!(r.reason(), "plugin.publisher_changed", "{}", r.body);

    // The same key installs again, an older version too, and the secrets stay.
    let r = t.install(&Pkg { version: "0.9.0", key: Some(&publisher), ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(t.secrets_of_kind().await, 3);
    assert_eq!(remove().await.status, StatusCode::NO_CONTENT);
    assert!(t.state.datasources.cached_connection(&ds).is_some(), "the old connection is still cached");

    // Confirmed: installed, the secrets of every source of the kind cleared (other
    // organization and trash included), the cached connection dropped, the change audited.
    let r = t.install_confirmed(&Pkg { version: "1.1.0", key: Some(&other), ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["keyId"], kalzit_plugin_api::signing::key_id(&other.verifying_key()), "{}", r.body);
    assert_eq!(t.secrets_of_kind().await, 0);
    assert!(t.state.datasources.cached_connection(&ds).is_none(), "the cached connection is dropped");
    let summary = t.publisher_changed().await;
    let mut expected = vec![ds.clone(), elsewhere.0, elsewhere.1];
    expected.sort();
    assert_eq!(summary["datasources"], json!(expected), "{summary}");
    assert_eq!(summary["secretsCleared"], 3, "{summary}");
    assert_eq!(summary["fromKeyId"], kalzit_plugin_api::signing::key_id(&publisher.verifying_key()));

    // From now on the id is bound to the new key: the former one is an update with another key.
    let r = t.install(&Pkg { version: "1.2.0", key: Some(&publisher), ..Default::default() }).await;
    assert_eq!(r.reason(), "plugin.key_changed", "{}", r.body);
    t.finish().await;
}

/// A removed unsigned plugin vouches for nobody: with data sources left, installing its id again
/// needs the confirmation, unsigned or signed, and clears the secrets.
#[tokio::test]
async fn a_removed_unsigned_plugin_keeps_no_secrets_for_its_successor() {
    let t = test_app().await;
    let publisher = key(13);
    t.trust(&publisher).await;
    t.allow_unsigned().await;
    t.ready(&Pkg::default()).await;
    t.datasource(ID, 3).await;
    assert_eq!(t.send(Method::DELETE, &format!("/admin/plugins/{ID}"), None).await.status, StatusCode::NO_CONTENT);

    for pkg in [Pkg { version: "1.1.0", ..Default::default() }, Pkg { key: Some(&publisher), ..Default::default() }] {
        let r = t.install(&pkg).await;
        assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.publisher_changed"), "{}", r.body);
        assert_eq!(r.body["error"]["params"]["datasources"], "1", "{}", r.body);
        assert_eq!(r.body["error"]["params"].get("previousKeyId"), None, "{}", r.body);
    }
    assert_eq!(t.secrets_of_kind().await, 1);

    // Unsigned again, confirmed: the secrets go all the same.
    let r = t.install_confirmed(&Pkg { version: "1.1.0", ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(t.secrets_of_kind().await, 0);
    assert_eq!(t.publisher_changed().await["secretsCleared"], 1);
    t.finish().await;
}

/// A plugin removed before tombstones were kept: with data sources left, even the same key needs
/// the confirmation, since nothing tells which key signed it.
#[tokio::test]
async fn a_plugin_removed_before_tombstones_needs_the_confirmation() {
    let t = test_app().await;
    let publisher = key(14);
    t.trust(&publisher).await;
    t.ready(&Pkg { key: Some(&publisher), ..Default::default() }).await;
    t.datasource(ID, 3).await;
    assert_eq!(t.send(Method::DELETE, &format!("/admin/plugins/{ID}"), None).await.status, StatusCode::NO_CONTENT);
    sqlx::query("DELETE FROM plugin_tombstones").execute(&t.state.db).await.unwrap();

    let r = t.install(&Pkg { key: Some(&publisher), ..Default::default() }).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.publisher_changed"), "{}", r.body);
    assert_eq!(r.body["error"]["params"].get("removedVersion"), None, "{}", r.body);
    assert_eq!(t.secrets_of_kind().await, 1);
    let r = t.install_confirmed(&Pkg { key: Some(&publisher), ..Default::default() }).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(t.secrets_of_kind().await, 0);
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
    let r = t.query(&ds, json!({ "do": "env" })).await;
    let env = first(r.clone());
    let plugin = t.plugin(ID).await;
    let names = env["names"].as_array().unwrap_or_else(|| panic!("{r}; the plugin: {plugin}"));
    let names: Vec<&str> = names.iter().map(|n| n.as_str().unwrap()).collect();
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
        // A configuration file that every local account may read, as `kalzit.toml` in
        // ProgramData is: the plugin still cannot.
        let config_dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        {
            let me = kalzit::data_dir::acl::current_user().unwrap();
            kalzit::data_dir::acl::restrict(
                config_dir.path(),
                &format!(
                    "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{me})(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;WD)"
                ),
            )
            .unwrap();
        }
        let config = config_dir.path().join("kalzit.toml");
        std::fs::write(&config, "[database]\nurl = \"postgres://kalzit:geheim@db/kalzit\"\n").unwrap();
        let r = first(t.query(&ds, json!({ "do": "read", "path": config })).await);
        assert_eq!(r["ok"], false, "the plugin read a configuration file readable by Users: {r} ({layers:?})");
    } else {
        eprintln!("Landlock is not available on this host; layers: {layers:?}");
    }

    #[cfg(target_os = "linux")]
    {
        assert!(layers.contains(&"no_new_privs") && layers.contains(&"seccomp"), "{layers:?}");
        let r = first(t.query(&ds, json!({ "do": "join_host_group" })).await);
        assert_eq!(r["ok"], false, "the plugin moved into Kalzit's process group: {r}");
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

    // Nor its run directory.
    let mine = first(t.query(&ds, json!({ "do": "tmpdir" })).await)["path"].as_str().unwrap().to_string();
    let theirs = first(t.query(&ds2, json!({ "do": "tmpdir" })).await)["path"].as_str().unwrap().to_string();
    assert_ne!(mine, theirs);
    let target = std::path::Path::new(&theirs).join("from-the-other-plugin.txt");
    let r = first(t.query(&ds, json!({ "do": "write", "path": target })).await);
    if cfg!(windows) || layers.contains(&"landlock") {
        assert_eq!(r["ok"], false, "the plugin wrote into another plugin's run directory: {r}");
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

/// A TCP server on loopback that answers every line with `pong`.
async fn echo_server() -> u16 {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = tokio::io::BufReader::new(read).lines();
                while let Ok(Some(_)) = lines.next_line().await {
                    if write.write_all(b"pong\n").await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn the_network_goes_only_through_the_connector() {
    let port = echo_server().await;
    let t = test_app().await;
    t.state.plugins.set_options(Options {
        max_connections: 3,
        connection_idle: Duration::from_secs(2),
        ..fast_options()
    });
    t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    let extra = "[[settings]]\nname = \"port\"\nlabel = { en = \"Port\" }\ntype = \"number\"\ntarget = true\n\n\
                 [[permissions.network]]\nsetting = \"host\"\nform = \"host\"\nport_setting = \"port\"\n";
    // A version of its own: settings forms are kept per id and version for the whole process.
    t.ready(&Pkg { version: "2.0.0", extra, ..Default::default() }).await;
    let ds = t.datasource_with(ID, json!({ "host": "127.0.0.1", "port": port })).await;

    // The sandbox has no network of its own: a direct connection fails, also to loopback.
    let status = t.plugin(ID).await["process"].clone();
    let layers: Vec<&str> = status["sandbox"].as_array().unwrap().iter().map(|l| l.as_str().unwrap()).collect();
    assert!(layers.contains(&"network"), "{layers:?}");
    if cfg!(windows) {
        assert!(layers.contains(&"app_container"), "{layers:?}");
    }
    let r = t.doc(&ds, ID, json!({ "do": "net_direct", "host": "127.0.0.1", "port": port })).await;
    assert_eq!(r["ok"], false, "the plugin connected past the connector: {r} ({layers:?})");
    #[cfg(unix)]
    {
        // Nor a Unix socket of the host (a database's, Docker's), whatever its file mode.
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        let path = dir.path().join("host.sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();
        let r = t.doc(&ds, ID, json!({ "do": "unix_connect", "path": path })).await;
        assert_eq!(r["ok"], false, "the plugin reached a Unix socket of the host: {r} ({layers:?})");
        // Nor a datagram socket pair, which could send to a datagram socket of the host.
        if cfg!(target_os = "linux") {
            let r = t.doc(&ds, ID, json!({ "do": "dgram_pair" })).await;
            assert_eq!((r["ok"].clone(), r["errno"].clone()), (json!(false), json!(13)), "{r}");
            // A connection the connector handed over cannot be pointed elsewhere: it is a socket
            // pair Kalzit relays, and `connect` is refused anyway.
            let r = t.doc(&ds, ID, json!({ "do": "net_repoint", "host": "127.0.0.1", "port": port })).await;
            assert_eq!(
                (r["ok"].clone(), r["unspec"].clone(), r["inet"].clone()),
                (json!(false), json!(13), json!(13)),
                "{r}"
            );
        }
    }

    // Through the connector the declared target answers.
    let r = t.doc(&ds, ID, json!({ "do": "net_connect", "host": "127.0.0.1", "port": port })).await;
    assert_eq!((r["ok"].clone(), r["reply"].clone()), (json!(true), json!("pong")), "{r}");
    assert_eq!(r["address"], format!("127.0.0.1:{port}"), "{r}");

    // Undeclared: another port, another protocol, another host, a metadata address.
    for (host, p, protocol) in [
        ("127.0.0.1", port.wrapping_add(1), "tcp"),
        ("127.0.0.1", port, "tls"),
        ("localhost", port, "tcp"),
        ("169.254.169.254", 80, "tcp"),
    ] {
        let q = json!({ "do": "net_connect", "host": host, "port": p, "protocol": protocol });
        let r = t.doc(&ds, ID, q).await;
        assert_eq!(
            (r["ok"].clone(), r["reason"].clone()),
            (json!(false), json!("plugin.target_undeclared")),
            "{host}:{p} {protocol}: {r}"
        );
    }

    // Kalzit's own port, even as the data source's declared target.
    let own = t.datasource_with(ID, json!({ "host": "127.0.0.1", "port": 3999 })).await;
    let r = t.doc(&own, ID, json!({ "do": "net_connect", "host": "127.0.0.1", "port": 3999 })).await;
    assert_eq!(r["reason"], "target.own_address", "{r}");

    // "Test connection" reaches the target through the connector: of the saved settings, of
    // settings not saved yet, and of a saved source's edited settings.
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources/{ds}/health", t.org), Some(json!({}))).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);
    let other = echo_server().await;
    let draft = json!({ "kind": ID, "settings": { "host": "127.0.0.1", "port": other } });
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources/test", t.org), Some(draft)).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);
    // A changed target needs its secrets sent again.
    let edited = json!({
        "kind": ID, "datasourceId": ds,
        "settings": { "host": "127.0.0.1", "port": other }, "secrets": { "password": "geheim-4711" },
    });
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources/test", t.org), Some(edited)).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);
    // An unsaved target that is Kalzit's own port is refused all the same.
    let refused = json!({ "kind": ID, "settings": { "host": "127.0.0.1", "port": 3999 } });
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources/test", t.org), Some(refused)).await;
    assert_eq!(r.body["ok"], false, "{}", r.body);

    // At most three connections at once; closed ones free their place.
    let q = json!({ "do": "net_many", "host": "127.0.0.1", "port": port, "n": 5 });
    let r = t.doc(&ds, ID, q.clone()).await;
    assert_eq!(
        (r["opened"].clone(), r["refused"]["reason"].clone()),
        (json!(3), json!("plugin.connections_exhausted")),
        "{r}"
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let r = t.doc(&ds, ID, q).await;
    assert_eq!(r["opened"], 3, "{r}");

    // A connection without traffic is closed.
    let r = t.doc(&ds, ID, json!({ "do": "net_connect", "host": "127.0.0.1", "port": port, "wait": 8 })).await;
    assert_eq!((r["ok"].clone(), r["closed"].clone()), (json!(true), json!(true)), "{r}");

    // Refusals are in the plugin's log and the audit log.
    let logs = t.send(Method::GET, &format!("/admin/plugins/{ID}/logs"), None).await;
    assert!(logs.body["lines"].to_string().contains("plugin.target_undeclared"), "{}", logs.body);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let actions = t.audit_actions().await;
    assert!(actions.iter().any(|a| a == "plugins.connect_refused"), "{actions:?}");
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

/// The example data source plugin (examples/plugins/csv-http), built with the SDK, packaged and
/// signed with kalzit-plugin-tool as a release would be, installed under Kalzit's key (a test
/// key trusted as Kalzit's here) and queried through the host.
fn csv_http_package(key: &SigningKey) -> Vec<u8> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = std::process::Command::new(cargo)
        .args(["build", "--quiet", "-p", "kalzit-csv-http", "--message-format=json"])
        .output()
        .expect("cargo runs");
    assert!(out.status.success(), "building the example failed: {}", String::from_utf8_lossy(&out.stderr));
    let binary = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|m| m["target"]["name"] == "kalzit-csv-http")
        .find_map(|m| m["executable"].as_str().map(PathBuf::from))
        .expect("cargo names the example's executable");
    let example = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/csv-http");
    // The example needs the Kalzit that ships the plugin host; this build may be older.
    let template = std::fs::read_to_string(example.join("kalzit-plugin.toml"))
        .unwrap()
        .replace("min_kalzit = \"0.4.0\"", concat!("min_kalzit = \"", env!("CARGO_PKG_VERSION"), "\""));
    let exe = if cfg!(windows) { ".exe" } else { "" };
    let files = [
        (format!("bin/{}/kalzit-csv-http{exe}", platform()), std::fs::read(binary).unwrap()),
        ("README.md".to_string(), std::fs::read(example.join("README.md")).unwrap()),
    ]
    .into_iter()
    .collect();
    kalzit_plugin_tool::package(&template, &files, &[platform().to_string()], Some(key)).unwrap()
}

/// A small HTTP server: `/data.csv`, `/data.json`, and `/private.csv` with a bearer token.
async fn file_server() -> SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let path = text.split_whitespace().nth(1).unwrap_or_default().to_string();
                let authorized = text.lines().any(|l| l.eq_ignore_ascii_case("authorization: Bearer s3cret"));
                let csv =
                    "time,host,cpu\n2026-10-28T10:00:00Z,a,0.5\n2026-10-28T10:01:00Z,b,1.5\n2026-10-28T10:02:00Z,c,2\n";
                let (status, kind, body) = match path.as_str() {
                    "/data.csv" => ("200 OK", "text/csv", csv.to_string()),
                    "/private.csv" if authorized => ("200 OK", "text/csv", "n\n1\n".to_string()),
                    "/private.csv" => ("401 Unauthorized", "text/plain", "no".to_string()),
                    "/data.json" => (
                        "200 OK",
                        "application/json",
                        r#"{"items":[{"n":1,"ok":true},{"n":2,"ok":false}]}"#.to_string(),
                    ),
                    _ => ("404 Not Found", "text/plain", "missing".to_string()),
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn the_example_plugin_built_with_the_sdk_installs_and_answers() {
    const KIND: &str = "dev.kalzit.csv-http";
    let t = test_app().await;
    let kalzit = key(42);
    let package = csv_http_package(&kalzit);
    // Under Kalzit's own id a publisher key is refused; Kalzit's key installs it.
    let r = t.raw(Method::POST, "/api/admin/plugins", Body::from(package.clone()), "application/zip").await;
    assert_eq!(r.reason(), "plugin.signer_untrusted", "{}", r.body);
    t.state.plugins.trust_kalzit_key(kalzit.verifying_key());
    let r = t.raw(Method::POST, "/api/admin/plugins", Body::from(package), "application/zip").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["signer"], "kalzit", "{}", r.body);
    assert_eq!(r.body["permissions"][0]["setting"], "url", "{}", r.body);
    let r = t.send(Method::POST, &format!("/admin/plugins/{KIND}/approve"), Some(json!({ "version": "0.1.0" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.send(Method::POST, &format!("/admin/plugins/{KIND}/enable"), None).await;
    assert_eq!(r.body["running"], true, "{}", r.body);

    let server = file_server().await;
    let create = |name: &str, path: &str, secrets: Value| json!({ "name": name, "kind": KIND, "settings": { "url": format!("http://{server}{path}") }, "secrets": secrets });
    // The plugin's own settings check refuses what is not an http URL.
    let body = json!({ "name": "FTP", "kind": KIND, "settings": { "url": "ftp://example.com/x.csv" } });
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources", t.org), Some(body)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);

    let r = t
        .send(Method::POST, &format!("/orgs/{}/datasources", t.org), Some(create("CSV", "/data.csv", json!({}))))
        .await;
    if r.status != StatusCode::CREATED {
        let logs = t.send(Method::GET, &format!("/admin/plugins/{KIND}/logs"), None).await;
        panic!("creating the source failed: {}; the plugin's output: {}", r.body, logs.body);
    }
    let ds = r.body["id"].as_str().unwrap().to_string();
    let r = t.query(&ds, json!({})).await;
    let frame = &r["result"]["frame"];
    let fields = frame["fields"].as_array().unwrap_or_else(|| panic!("no frame: {r}"));
    let names: Vec<&str> = fields.iter().map(|f| f["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["time", "host", "cpu"], "{r}");
    assert_eq!(frame["fields"][0]["type"], "time", "{r}");
    assert_eq!(frame["fields"][2]["values"], json!([0.5, 1.5, 2]), "{r}");
    assert_eq!(frame["fields"][1]["values"], json!(["a", "b", "c"]), "{r}");

    // "Test connection" through the plugin.
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources/{ds}/health", t.org), Some(json!({}))).await;
    assert_eq!(r.body["ok"], true, "{}", r.body);

    // JSON with a pointer, and a secret sent as a bearer token.
    let r = t
        .send(Method::POST, &format!("/orgs/{}/datasources", t.org), Some(create("JSON", "/data.json", json!({}))))
        .await;
    let json_ds = r.body["id"].as_str().unwrap().to_string();
    let r = t.query(&json_ds, json!({ "pointer": "/items" })).await;
    assert_eq!(r["result"]["frame"]["fields"][0]["values"], json!([1, 2]), "{r}");
    let body = create("Private", "/private.csv", json!({ "token": "s3cret" }));
    let r = t.send(Method::POST, &format!("/orgs/{}/datasources", t.org), Some(body)).await;
    let private = r.body["id"].as_str().unwrap().to_string();
    let r = t.query(&private, json!({})).await;
    assert_eq!(r["result"]["frame"]["fields"][0]["values"], json!([1]), "{r}");
    let r = t
        .send(
            Method::POST,
            &format!("/orgs/{}/datasources", t.org),
            Some(create("No token", "/private.csv", json!({}))),
        )
        .await;
    let r = t.query(r.body["id"].as_str().unwrap(), json!({})).await;
    assert_eq!(r["error"]["reason"], "source.error", "{r}");
    t.finish().await;
}

/// Another server on the same database shared `archive` as the package `dir` of plugin `id`
/// with the SHA-256 `sha` (as `PluginHost::install` does when coordinated).
async fn share(t: &TestApp, id: &str, dir: &str, archive: &[u8], sha: &str) {
    let db = &t.state.db;
    sqlx::query("INSERT INTO plugin_packages (dir, archive, sha256, created_at) VALUES ($1, $2, $3, 0)")
        .bind(dir)
        .bind(base64::engine::general_purpose::STANDARD.encode(archive))
        .bind(sha)
        .execute(db)
        .await
        .unwrap();
    sqlx::query("UPDATE plugins SET dir = $1 WHERE id = $2").bind(dir).bind(id).execute(db).await.unwrap();
}

/// `share` for the test plugin, then this server takes it over (`PluginHost::sync`). Answers
/// whether everything that may run here runs.
async fn take_shared(t: &TestApp, dir: &str, archive: &[u8], sha: &str) -> bool {
    share(t, ID, dir, archive, sha).await;
    t.state.plugins.sync(&t.state).await.unwrap()
}

/// The reasons of the `plugins.package_refused` entries.
async fn refusals(t: &TestApp) -> Vec<String> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'plugins.package_refused'")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    rows.iter().map(|(s,)| serde_json::from_str::<Value>(s).unwrap()["reason"].as_str().unwrap().to_string()).collect()
}

fn count(reasons: &[String], reason: &str) -> usize {
    reasons.iter().filter(|r| *r == reason).count()
}

#[tokio::test]
async fn a_shared_package_is_checked_like_an_installation_on_every_server() {
    const SECOND: &str = "dev.example.second";
    let t = test_app().await;
    let (publisher, stranger, other) = (key(15), key(16), key(17));
    t.trust(&publisher).await;
    let good = Pkg { key: Some(&publisher), ..Default::default() };
    t.ready(&good).await;
    let second = Pkg { id: SECOND, key: Some(&publisher), ..Default::default() };
    t.ready(&second).await;
    let packages = t.dir.path().join("plugins").join("packages");
    let fresh = || format!("{}", uuid::Uuid::now_v7().simple());

    // The manifest is the stored one, but the signature is gone or from a key nobody trusts:
    // refused before anything is unpacked.
    for archive in [package(&Pkg::default()), package(&Pkg { key: Some(&stranger), ..Default::default() })] {
        let dir = fresh();
        assert!(!take_shared(&t, &dir, &archive, &sha(&archive)).await);
        assert!(!packages.join(&dir).exists());
        assert_eq!(t.plugin(ID).await["running"], false);
    }
    // An archive that is not the one stored with its SHA-256.
    let archive = package(&good);
    let dir = fresh();
    assert!(!take_shared(&t, &dir, &archive, &sha(b"another archive")).await);
    assert!(!packages.join(&dir).exists());
    // A directory name that leaves the packages directory.
    let escape = "../escape";
    assert!(!take_shared(&t, escape, &archive, &sha(&archive)).await);
    assert!(!packages.join(escape).exists() && !packages.join(format!(".partial-{escape}")).exists());
    // A validly signed package whose manifest is not the stored one.
    let changed = package(&Pkg { mode: "other", key: Some(&publisher), ..Default::default() });
    let dir = fresh();
    assert!(!take_shared(&t, &dir, &changed, &sha(&changed)).await);
    assert!(!packages.join(&dir).exists());

    // Every refusal is in the audit log once, however often the sync tries again.
    for _ in 0..3 {
        assert!(!t.state.plugins.sync(&t.state).await.unwrap());
    }
    let reasons = refusals(&t).await;
    for reason in [
        "plugin.unsigned_refused",
        "plugin.signer_untrusted",
        "plugin.package_hash_mismatch",
        "plugin.package_dir_invalid",
        "plugin.package_invalid",
    ] {
        assert_eq!(count(&reasons, reason), 1, "{reason} in {reasons:?}");
    }

    // Another plugin still takes its new package while this one is refused.
    let next = fresh();
    let second_archive = package(&second);
    share(&t, SECOND, &next, &second_archive, &sha(&second_archive)).await;
    assert!(!t.state.plugins.sync(&t.state).await.unwrap());
    assert!(packages.join(&next).is_dir());
    assert_eq!(t.plugin(SECOND).await["running"], true);
    assert_eq!(t.plugin(ID).await["running"], false);

    // Signed by another trusted key, or unsigned while unsigned plugins are allowed: not the
    // signer recorded at the installation.
    t.trust(&other).await;
    let by_other = package(&Pkg { key: Some(&other), ..Default::default() });
    assert!(!take_shared(&t, &fresh(), &by_other, &sha(&by_other)).await);
    t.allow_unsigned().await;
    let unsigned = package(&Pkg::default());
    assert!(!take_shared(&t, &fresh(), &unsigned, &sha(&unsigned)).await);
    assert_eq!(count(&refusals(&t).await, "plugin.signer_mismatch"), 2);
    assert_eq!(t.plugin(ID).await["running"], false);

    // The package as installed is taken over and runs.
    let dir = fresh();
    assert!(take_shared(&t, &dir, &archive, &sha(&archive)).await);
    assert!(packages.join(&dir).is_dir() && packages.join(format!("{dir}.complete")).exists());
    assert_eq!(t.plugin(ID).await["running"], true);

    // A package whose manifest on disk changed after it was unpacked does not start again.
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/disable"), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let file = packages.join(&dir).join("kalzit-plugin.toml");
    let text = std::fs::read_to_string(&file).unwrap();
    std::fs::write(&file, format!("{text}\n# changed\n")).unwrap();
    let r = t.send(Method::POST, &format!("/admin/plugins/{ID}/enable"), None).await;
    assert_eq!((r.status, r.body["running"].clone()), (StatusCode::OK, json!(false)), "{}", r.body);
    assert_eq!(count(&refusals(&t).await, "plugin.package_invalid"), 2);
    t.finish().await;
}
