//! The plugin catalog, host side, against a local catalog served over HTTPS in the test: off by
//! default without any connection; the index's signature, sequence (no rollback) and expiry;
//! revoked entries; installs from the catalog through the same checks as an uploaded file; and
//! that only server administrators reach it.

use std::collections::HashMap;
use std::io::{Cursor, Write};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::IntoResponse;
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use kalzit_plugin_api::catalog::{CatalogEntry, CatalogIndex, Revocation};
use kalzit_plugin_api::signing;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use zip::write::SimpleFileOptions;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const ID: &str = "dev.example.catalogtest";
const NOW_MS: i64 = 1_800_000_000_000;
const NOW: u64 = 1_800_000_000;

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn key_id(k: &SigningKey) -> String {
    signing::key_id(&k.verifying_key())
}

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn platform() -> &'static str {
    kalzit::plugins::platform().expect("plugins run on this platform")
}

fn binary_path() -> String {
    let exe = if cfg!(windows) { ".exe" } else { "" };
    format!("bin/{}/catalog-test{exe}", platform())
}

/// The plugin's "binary": the host never starts it in these tests (a new plugin waits for
/// approval), so any bytes the manifest pins will do.
const BINARY: &[u8] = b"not a real program";

/// A package of `id` in `version`, signed by `signer` (or unsigned); `tamper` changes the
/// manifest after it was signed.
fn package(id: &str, version: &str, signer: Option<&SigningKey>, tamper: bool, extra: &str) -> Vec<u8> {
    let manifest = format!(
        "manifest = 1\nid = \"{id}\"\nname = \"Catalog test\"\nversion = \"{version}\"\nkind = \"datasource\"\n\
         publisher = \"Example GmbH\"\nmin_kalzit = \"0.1.0\"\nshapes = [\"frame\"]\nprotocol = 1\n\n{extra}\n\
         [binaries]\n{platform} = \"{bin}\"\n\n[files]\n\"{bin}\" = \"{hash}\"\n",
        platform = platform(),
        bin = binary_path(),
        hash = sha(BINARY),
    );
    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut add = |name: &str, bytes: &[u8]| {
        zip.start_file(name, stored).unwrap();
        zip.write_all(bytes).unwrap();
    };
    let shown = if tamper { manifest.replace("Catalog test", "Katalog-Test") } else { manifest.clone() };
    add("kalzit-plugin.toml", shown.as_bytes());
    if let Some(k) = signer {
        let sig = kalzit_release::DetachedSignature {
            key_id: key_id(k),
            signature: base64::engine::general_purpose::STANDARD
                .encode(k.sign(&signing::manifest_message(manifest.as_bytes())).to_bytes()),
        };
        add("kalzit-plugin.sig", &serde_json::to_vec(&sig).unwrap());
    }
    add(&binary_path(), BINARY);
    zip.finish().unwrap().into_inner()
}

/// The files the fake catalog serves, by path, and how many requests it answered.
#[derive(Default)]
struct Files {
    files: Mutex<HashMap<String, Vec<u8>>>,
    hits: AtomicUsize,
}

impl Files {
    fn put(&self, path: &str, bytes: Vec<u8>) {
        self.files.lock().unwrap().insert(path.to_string(), bytes);
    }
}

/// A local HTTPS server for `localhost` with a certificate of its own; answers its address and
/// the certificate (PEM) to trust.
#[expect(clippy::disallowed_methods, reason = "a fake catalog server, not an API route")]
async fn serve(files: Arc<Files>) -> (SocketAddr, String) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    let (cert, key) = (ck.cert.pem(), ck.signing_key.serialize_pem());
    let app = Router::new().route(
        "/{*path}",
        axum::routing::get(move |axum::extract::Path(path): axum::extract::Path<String>| {
            let files = files.clone();
            async move {
                files.hits.fetch_add(1, Ordering::SeqCst);
                let found = files.files.lock().unwrap().get(&path).cloned();
                match found {
                    // `REDIRECT <url>`: a redirect there, as a mirror or a CDN answers.
                    Some(bytes) if bytes.starts_with(b"REDIRECT ") => {
                        let target = String::from_utf8_lossy(&bytes[9..]).into_owned();
                        (StatusCode::FOUND, [(header::LOCATION, target)], Vec::new()).into_response()
                    }
                    Some(bytes) => (StatusCode::OK, bytes).into_response(),
                    None => (StatusCode::NOT_FOUND, Vec::new()).into_response(),
                }
            }
        }),
    );
    let tls =
        axum_server::tls_rustls::RustlsConfig::from_pem(cert.clone().into_bytes(), key.into_bytes()).await.unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(
        async move { axum_server::from_tcp_rustls(listener, tls).unwrap().serve(app.into_make_service()).await },
    );
    (addr, cert)
}

struct TestApp {
    app: Router,
    state: AppState,
    clock: Arc<ManualClock>,
    dir: Arc<tempfile::TempDir>,
    cookie: String,
    org: String,
    files: Arc<Files>,
    base: String,
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

async fn test_app() -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3999".into();
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(NOW_MS));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let files = Arc::new(Files::default());
    let (addr, cert) = serve(files.clone()).await;
    state.catalog.set_extra_root(Some(cert));
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));
    let mut t = TestApp {
        app,
        state,
        clock,
        dir: Arc::new(dir),
        cookie: String::new(),
        org: String::new(),
        files,
        base: format!("https://localhost:{}", addr.port()),
    };
    let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                       "email": "joerg@example.de", "password": PASSWORD });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/setup")
        .header(header::HOST, "kalzit.test")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = t.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    t.cookie = res.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_string();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    t.org = answer["orgs"][0]["id"].as_str().unwrap().to_string();
    t
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn send_as(&self, cookie: &str, method: Method, path: &str, body: Option<Value>) -> Reply {
        let req = Request::builder()
            .method(method)
            .uri(format!("/api{path}"))
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>) -> Reply {
        self.send_as(&self.cookie.clone(), method, path, body).await
    }

    async fn setting(&self, key: &str, value: Value) {
        let list = self.send(Method::GET, "/admin/settings", None).await;
        let version =
            list.body["items"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap()["version"].clone();
        let r = self
            .send(Method::PATCH, &format!("/admin/settings/{key}"), Some(json!({ "value": value, "version": version })))
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    /// Turns the catalog on with the fake catalog's address.
    async fn turn_on(&self) {
        self.setting("plugins.catalog_enabled", json!(true)).await;
        self.setting("plugins.catalog_url", json!(format!("{}/index.json", self.base))).await;
    }

    async fn trust(&self, k: &SigningKey, name: &str) {
        let public = base64::engine::general_purpose::STANDARD.encode(k.verifying_key().as_bytes());
        let r = self.send(Method::POST, "/admin/plugin-keys", Some(json!({ "name": name, "publicKey": public }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    }

    /// Trusts `k` and allows it to sign the catalog.
    async fn trust_catalog(&self, k: &SigningKey, name: &str) {
        self.trust(k, name).await;
        let r = self
            .send(
                Method::PUT,
                &format!("/admin/plugin-keys/{}/catalog", key_id(k)),
                Some(json!({ "maySignCatalog": true })),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        assert_eq!(r.body["maySignCatalog"], true);
    }

    /// Serves `index` signed by `signer` at /index.json; answers the exact bytes.
    fn publish(&self, index: &CatalogIndex, signer: &SigningKey) -> Vec<u8> {
        let bytes = serde_json::to_vec(index).unwrap();
        self.publish_bytes(bytes.clone(), signer);
        bytes
    }

    fn publish_bytes(&self, bytes: Vec<u8>, signer: &SigningKey) {
        let sig = kalzit_release::DetachedSignature {
            key_id: key_id(signer),
            signature: base64::engine::general_purpose::STANDARD
                .encode(signer.sign(&signing::catalog_message(&bytes)).to_bytes()),
        };
        self.files.put("index.json", bytes);
        self.files.put("index.json.sig", serde_json::to_vec(&sig).unwrap());
    }

    /// Serves `package` and answers its catalog entry.
    fn offer(&self, id: &str, version: &str, signer: &SigningKey, package: Vec<u8>) -> CatalogEntry {
        let path = format!("pkg/{id}-{version}.kalzit-plugin");
        let entry = CatalogEntry {
            id: id.into(),
            version: version.into(),
            kind: "datasource".into(),
            name: "Catalog test".into(),
            key_id: key_id(signer),
            url: format!("{}/{path}", self.base),
            sha256: sha(&package),
            size: package.len() as u64,
            description: Some("Rows from a test.".into()),
            publisher: Some("Example GmbH".into()),
            network: vec!["db.example.dev:5432".into()],
        };
        self.files.put(&path, package);
        entry
    }

    async fn refresh(&self) -> Reply {
        self.send(Method::POST, "/admin/plugin-catalog/refresh", None).await
    }

    async fn catalog(&self, query: &str) -> Value {
        let r = self.send(Method::GET, &format!("/admin/plugin-catalog{query}"), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body
    }

    async fn install(&self, id: &str, version: &str) -> Reply {
        self.send(Method::POST, "/admin/plugin-catalog/install", Some(json!({ "id": id, "version": version }))).await
    }

    async fn audit(&self, action: &str) -> Vec<Value> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT summary FROM audit_events WHERE action = $1 ORDER BY created_at, id")
                .bind(action)
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter().map(|(s,)| serde_json::from_str(&s).unwrap()).collect()
    }

    /// A new session for the administrator, after the clock moved past the old one.
    async fn sign_in_again(&mut self) {
        let (id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'joerg@example.de'")
            .fetch_one(&self.state.db)
            .await
            .unwrap();
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), &id).await.unwrap();
        self.cookie = format!("kalzit_session={token}");
    }

    /// A member of the organization with `role` and a session: their cookie.
    async fn member(&self, role: &str) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&id)
            .bind(format!("{id}@example.de"))
            .bind("Org Admin")
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&self.org)
            .bind(&id)
            .bind(role)
            .execute(&self.state.db)
            .await
            .unwrap();
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), &id).await.unwrap();
        format!("kalzit_session={token}")
    }
}

fn index(sequence: u64, plugins: Vec<CatalogEntry>) -> CatalogIndex {
    CatalogIndex { format: 1, sequence, published_at: NOW - 60, expires_at: NOW + 7 * 86_400, plugins, revoked: vec![] }
}

/// Off by default: no address, nothing listed, nothing fetched, and refresh and install refused.
#[tokio::test]
async fn the_catalog_is_off_by_default_and_connects_nowhere() {
    let t = test_app().await;
    let c = t.catalog("").await;
    assert_eq!(c["state"], "off", "{c}");
    assert_eq!(c["settings"]["enabled"]["value"], false);
    assert_eq!(c["settings"]["url"]["value"], "", "no default host");
    assert_eq!(c["settings"]["refreshHours"]["value"], 24);
    let r = t.refresh().await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "catalog.disabled"), "{}", r.body);
    let r = t.install(ID, "1.0.0").await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "catalog.disabled"), "{}", r.body);
    // The background loop does nothing while it is off.
    t.state.catalog.tick(&t.state).await;
    assert_eq!(t.files.hits.load(Ordering::SeqCst), 0, "no request while the catalog is off");

    // On without an address: still nothing to fetch.
    t.setting("plugins.catalog_enabled", json!(true)).await;
    assert_eq!(t.catalog("").await["state"], "unconfigured");
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.url_missing", "{}", r.body);
    // Only HTTPS addresses are taken.
    let list = t.send(Method::GET, "/admin/settings", None).await;
    let version =
        list.body["items"].as_array().unwrap().iter().find(|s| s["key"] == "plugins.catalog_url").unwrap()["version"]
            .clone();
    for bad in ["http://plugins.example.dev/index.json", "https://user:pw@plugins.example.dev/i.json", "nonsense"] {
        let r = t
            .send(
                Method::PATCH,
                "/admin/settings/plugins.catalog_url",
                Some(json!({ "value": bad, "version": version })),
            )
            .await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}: {}", r.body);
    }
    assert_eq!(t.files.hits.load(Ordering::SeqCst), 0);
    t.finish().await;
}

/// The index's signature is checked against the keys trusted for plugins.
#[tokio::test]
async fn the_index_signature_is_checked() {
    let t = test_app().await;
    let (catalog_key, stranger) = (key(1), key(2));
    t.trust_catalog(&catalog_key, "Katalog GmbH").await;
    t.turn_on().await;

    // Not signed at all.
    t.files.put("index.json", serde_json::to_vec(&index(1, vec![])).unwrap());
    let r = t.refresh().await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "catalog.signature_missing"), "{}", r.body);
    let c = t.catalog("").await;
    assert_eq!(
        (c["state"].as_str(), c["lastError"]["reason"].as_str()),
        (Some("unreachable"), Some("catalog.signature_missing"))
    );

    // Signed by a key nobody here trusts.
    t.publish(&index(1, vec![]), &stranger);
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.signer_untrusted", "{}", r.body);
    assert_eq!(r.body["error"]["params"]["keyId"], key_id(&stranger));

    // Changed after signing: always refused.
    t.publish(&index(1, vec![]), &catalog_key);
    let mut changed = serde_json::to_vec(&index(1, vec![])).unwrap();
    changed.extend_from_slice(b" ");
    t.files.put("index.json", changed);
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.signature_invalid", "{}", r.body);
    assert_eq!(t.catalog("").await["state"], "unreachable");

    // Properly signed: taken, and the refresh is in the audit log.
    let pkg = package(ID, "1.0.0", Some(&catalog_key), false, "");
    let entry = t.offer(ID, "1.0.0", &catalog_key, pkg);
    t.publish(&index(1, vec![entry]), &catalog_key);
    let r = t.refresh().await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["state"], "ready");
    assert_eq!(r.body["index"]["keyId"], key_id(&catalog_key));
    assert_eq!(r.body["index"]["signer"], "Katalog GmbH");
    assert!(r.body.get("lastError").is_none(), "{}", r.body);
    let item = &r.body["items"][0];
    assert_eq!((item["id"].as_str(), item["action"].as_str()), (Some(ID), Some("install")), "{item}");
    assert_eq!(item["network"], json!(["db.example.dev:5432"]));
    assert_eq!(item["keyName"], "Katalog GmbH");
    let refreshed = t.audit("plugins.catalog_refreshed").await;
    assert_eq!(refreshed.len(), 4, "{refreshed:?}");
    assert_eq!(refreshed[0]["reason"], "catalog.signature_missing");
    assert_eq!(refreshed[3]["sequence"], 1);

    // Search and kind filter.
    assert_eq!(t.catalog("?q=rows%20from").await["items"].as_array().unwrap().len(), 1);
    assert_eq!(t.catalog("?q=redis").await["items"].as_array().unwrap().len(), 0);
    let panels = t.catalog("?kind=panel").await;
    assert_eq!((panels["items"].as_array().unwrap().len(), panels["counts"]["datasource"].as_u64()), (0, Some(1)));
    let r = t.send(Method::GET, "/admin/plugin-catalog?kind=app", None).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    t.finish().await;
}

/// An older or equal sequence is a rollback, an index past its expiry is refused, and the same
/// index served again stays valid only until it expires.
#[tokio::test]
async fn rollbacks_and_expired_indexes_are_refused() {
    let mut t = test_app().await;
    let catalog_key = key(1);
    t.trust_catalog(&catalog_key, "Katalog GmbH").await;
    t.turn_on().await;
    let pkg = package(ID, "1.0.0", Some(&catalog_key), false, "");
    let entry = t.offer(ID, "1.0.0", &catalog_key, pkg);
    let taken = t.publish(&index(5, vec![entry.clone()]), &catalog_key);
    assert_eq!(t.refresh().await.status, StatusCode::OK);

    // The same bytes again: unchanged, fine.
    let r = t.refresh().await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // An older index, and another index with the same number.
    t.publish(&index(4, vec![entry.clone()]), &catalog_key);
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.rollback", "{}", r.body);
    assert_eq!(
        (r.body["error"]["params"]["sequence"].as_str(), r.body["error"]["params"]["accepted"].as_str()),
        (Some("4"), Some("5"))
    );
    t.publish(&index(5, vec![]), &catalog_key);
    assert_eq!(t.refresh().await.reason(), "catalog.rollback");
    // The index taken before stays in use, with the failure shown.
    let c = t.catalog("").await;
    assert_eq!((c["state"].as_str(), c["lastError"]["reason"].as_str()), (Some("ready"), Some("catalog.rollback")));
    assert_eq!(c["index"]["sequence"], 5);

    // The rollback holds after the catalog was turned off and on again.
    t.setting("plugins.catalog_enabled", json!(false)).await;
    t.setting("plugins.catalog_enabled", json!(true)).await;
    t.publish(&index(4, vec![entry.clone()]), &catalog_key);
    assert_eq!(t.refresh().await.reason(), "catalog.rollback");

    // A frozen index: the same bytes served past its expiry.
    t.publish_bytes(taken, &catalog_key);
    t.clock.advance_ms(8 * 86_400 * 1000);
    t.sign_in_again().await;
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.expired", "{}", r.body);
    assert_eq!(t.catalog("").await["state"], "expired");
    let r = t.install(ID, "1.0.0").await;
    assert_eq!(r.reason(), "catalog.expired", "{}", r.body);
    // A new index published past an expiry date already gone.
    let stale = CatalogIndex { published_at: NOW - 86_400, expires_at: NOW + 3600, ..index(6, vec![entry]) };
    t.publish(&stale, &catalog_key);
    assert_eq!(t.refresh().await.reason(), "catalog.expired");
    t.finish().await;
}

/// A package from the catalog goes through every check of an uploaded file, and must be the
/// package its entry names.
#[tokio::test]
async fn installs_from_the_catalog_use_the_same_checks() {
    let t = test_app().await;
    let (catalog_key, publisher, other) = (key(1), key(3), key(4));
    t.trust_catalog(&catalog_key, "Katalog GmbH").await;
    t.trust(&publisher, "Example GmbH").await;
    t.trust(&other, "Andere GmbH").await;
    // Unsigned packages are allowed for files here, but never come from the catalog.
    let r = t.send(Method::PATCH, "/admin/plugin-host", Some(json!({ "allowUnsigned": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.turn_on().await;

    let target = "[[permissions.network]]\nhost = \"license.example.dev\"\nport = 443\nprotocol = \"tls\"\n";
    let good = t.offer(ID, "1.0.0", &publisher, package(ID, "1.0.0", Some(&publisher), false, target));
    let bad_hash = CatalogEntry {
        sha256: sha(b"other"),
        ..t.offer(
            "dev.example.hash",
            "1.0.0",
            &publisher,
            package("dev.example.hash", "1.0.0", Some(&publisher), false, ""),
        )
    };
    let tampered = t.offer(
        "dev.example.tampered",
        "1.0.0",
        &publisher,
        package("dev.example.tampered", "1.0.0", Some(&publisher), true, ""),
    );
    let unsigned = CatalogEntry {
        key_id: key_id(&publisher),
        ..t.offer(
            "dev.example.unsigned",
            "1.0.0",
            &publisher,
            package("dev.example.unsigned", "1.0.0", None, false, ""),
        )
    };
    let other_key = CatalogEntry {
        key_id: key_id(&publisher),
        ..t.offer(
            "dev.example.otherkey",
            "1.0.0",
            &other,
            package("dev.example.otherkey", "1.0.0", Some(&other), false, ""),
        )
    };
    let wrong_id = CatalogEntry {
        id: "dev.example.wrongid".into(),
        ..t.offer(
            "dev.example.realid",
            "1.0.0",
            &publisher,
            package("dev.example.realid", "1.0.0", Some(&publisher), false, ""),
        )
    };
    let reserved =
        t.offer("io.kalzit.fake", "1.0.0", &publisher, package("io.kalzit.fake", "1.0.0", Some(&publisher), false, ""));
    t.publish(&index(1, vec![good, bad_hash, tampered, unsigned, other_key, wrong_id, reserved]), &catalog_key);
    assert_eq!(t.refresh().await.status, StatusCode::OK);

    for (id, reason, field) in [
        ("dev.example.hash", "catalog.package_mismatch", Some("sha256")),
        ("dev.example.tampered", "plugin.signature_invalid", None),
        ("dev.example.unsigned", "plugin.unsigned_refused", None),
        ("dev.example.otherkey", "catalog.package_mismatch", Some("keyId")),
        ("dev.example.wrongid", "catalog.package_mismatch", Some("id")),
        ("io.kalzit.fake", "plugin.id_reserved", None),
    ] {
        let r = t.install(id, "1.0.0").await;
        assert_eq!(r.reason(), reason, "{id}: {}", r.body);
        assert_eq!(r.body["error"]["params"]["field"].as_str(), field, "{id}");
        assert!(t.send(Method::GET, &format!("/admin/plugins/{id}"), None).await.status == StatusCode::NOT_FOUND);
    }
    let r = t.install(ID, "9.9.9").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);

    // The good one: installed like an uploaded file, disabled and waiting for its approval.
    let r = t.install(ID, "1.0.0").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!((r.body["approved"].as_bool(), r.body["enabled"].as_bool()), (Some(false), Some(false)));
    assert_eq!(r.body["keyId"], key_id(&publisher));
    assert_eq!(r.body["permissions"][0]["host"], "license.example.dev");
    assert_eq!(t.audit("plugins.installed").await.len(), 1);
    let from_catalog = t.audit("plugins.catalog_installed").await;
    assert_eq!((from_catalog.len(), from_catalog[0]["version"].as_str()), (1, Some("1.0.0")));
    let refused = t.audit("plugins.install_refused").await;
    assert!(
        refused.iter().any(|s| s["reason"] == "catalog.package_mismatch" && s["source"] == "catalog"),
        "{refused:?}"
    );
    assert!(refused.iter().any(|s| s["reason"] == "plugin.signature_invalid"), "{refused:?}");
    let item = t.catalog(&format!("?q={ID}")).await["items"][0].clone();
    assert_eq!((item["action"].as_str(), item["installedVersion"].as_str()), (Some("installed"), Some("1.0.0")));

    // A newer signed version is offered as an update and goes through the update rules.
    let approve =
        t.send(Method::POST, &format!("/admin/plugins/{ID}/approve"), Some(json!({ "version": "1.0.0" }))).await;
    assert_eq!(approve.status, StatusCode::OK, "{}", approve.body);
    let next = t.offer(ID, "1.1.0", &publisher, package(ID, "1.1.0", Some(&publisher), false, target));
    let by_other = t.offer(ID, "1.2.0", &other, package(ID, "1.2.0", Some(&other), false, target));
    t.publish(&index(2, vec![next, by_other.clone()]), &catalog_key);
    assert_eq!(t.refresh().await.status, StatusCode::OK);
    let item = t.catalog("").await["items"][0].clone();
    assert_eq!((item["action"].as_str(), item["version"].as_str()), (Some("update"), Some("1.2.0")), "{item}");
    // 1.2.0 is signed by another key: the update rules refuse it, as for a file.
    let r = t.install(ID, "1.2.0").await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "plugin.key_changed"), "{}", r.body);
    let r = t.install(ID, "1.1.0").await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["version"], "1.1.0");
    assert_eq!(t.audit("plugins.updated").await.len(), 1);
    t.finish().await;
}

/// Withdrawn versions are refused and shown, also on installed plugins.
#[tokio::test]
async fn revoked_entries_are_refused_and_shown() {
    let t = test_app().await;
    let catalog_key = key(1);
    t.trust_catalog(&catalog_key, "Katalog GmbH").await;
    t.turn_on().await;
    let first = t.offer(ID, "1.0.0", &catalog_key, package(ID, "1.0.0", Some(&catalog_key), false, ""));
    t.publish(&index(1, vec![first.clone()]), &catalog_key);
    assert_eq!(t.refresh().await.status, StatusCode::OK);
    assert_eq!(t.install(ID, "1.0.0").await.status, StatusCode::CREATED);

    let revoked = vec![Revocation { id: ID.into(), versions: "<1.1.0".into(), reason: "CVE-2026-4711".into() }];
    let withdrawn = CatalogIndex { revoked, ..index(2, vec![first]) };
    t.publish(&withdrawn, &catalog_key);
    assert_eq!(t.refresh().await.status, StatusCode::OK);
    let c = t.catalog("").await;
    let item = &c["items"][0];
    assert_eq!((item["action"].as_str(), item["revoked"].as_str()), (Some("revoked"), Some("CVE-2026-4711")), "{c}");
    assert_eq!(item["installedRevoked"], "CVE-2026-4711");
    assert_eq!(c["revoked"][0]["installedVersion"], "1.0.0");
    let r = t.install(ID, "1.0.0").await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "catalog.entry_revoked"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["reason"], "CVE-2026-4711");
    t.finish().await;
}

/// Only server administrators see and use the catalog; an organization's admin does not.
#[tokio::test]
async fn only_server_admins_reach_the_catalog() {
    let t = test_app().await;
    let org_admin = t.member("admin").await;
    for (method, path, body) in [
        (Method::GET, "/admin/plugin-catalog", None),
        (Method::POST, "/admin/plugin-catalog/refresh", None),
        (Method::POST, "/admin/plugin-catalog/install", Some(json!({ "id": ID, "version": "1.0.0" }))),
    ] {
        let r = t.send_as(&org_admin, method.clone(), path, body.clone()).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{method} {path}: {}", r.body);
        let r = t.send_as("", method.clone(), path, body).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{method} {path}: {}", r.body);
    }
    assert_eq!(t.files.hits.load(Ordering::SeqCst), 0);
    t.finish().await;
}

/// The key of an address is pinned: another trusted key needs the administrator's confirmation,
/// and even then cannot bring back a list older than one taken from the address.
#[tokio::test]
async fn the_catalog_key_is_pinned_to_its_address() {
    let t = test_app().await;
    let (first, second) = (key(1), key(2));
    t.trust_catalog(&first, "Katalog GmbH").await;
    t.trust_catalog(&second, "Neuer Schlüssel").await;
    t.turn_on().await;
    t.publish(&index(5, vec![]), &first);
    assert_eq!(t.refresh().await.status, StatusCode::OK);

    t.publish(&index(6, vec![]), &second);
    let r = t.refresh().await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "catalog.key_changed"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["previousKeyId"], key_id(&first));
    assert_eq!(t.catalog("").await["index"]["sequence"], 5, "the pinned list stays");

    // Confirmed, the new key still cannot serve an older list for this address.
    t.publish(&index(3, vec![]), &second);
    let r = t.send(Method::POST, "/admin/plugin-catalog/refresh?acceptKeyChange=true", None).await;
    assert_eq!(r.reason(), "catalog.rollback", "{}", r.body);
    t.publish(&index(6, vec![]), &second);
    let r = t.send(Method::POST, "/admin/plugin-catalog/refresh?acceptKeyChange=true", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["index"]["keyId"], key_id(&second));

    // A list whose key is trusted no more offers nothing to install.
    let pkg = package(ID, "1.0.0", Some(&second), false, "");
    let entry = t.offer(ID, "1.0.0", &second, pkg);
    t.publish(&index(7, vec![entry]), &second);
    assert_eq!(t.refresh().await.status, StatusCode::OK);
    let r = t.send(Method::DELETE, &format!("/admin/plugin-keys/{}", key_id(&second)), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.catalog("").await["state"], "untrusted");
    let r = t.install(ID, "1.0.0").await;
    assert_eq!(r.reason(), "catalog.signer_untrusted", "{}", r.body);
    t.finish().await;
}

/// Only Kalzit's keys and keys an administrator allowed may sign the catalog: trusting a
/// publisher key for plugins is not enough.
#[tokio::test]
async fn only_keys_allowed_for_the_catalog_sign_it() {
    let t = test_app().await;
    let publisher = key(3);
    t.trust(&publisher, "Example GmbH").await;
    t.turn_on().await;
    t.publish(&index(1, vec![]), &publisher);
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.signer_untrusted", "{}", r.body);
    let keys = t.send(Method::GET, "/admin/plugin-keys", None).await;
    assert_eq!(keys.body["items"][0]["maySignCatalog"], false);

    let path = format!("/admin/plugin-keys/{}/catalog", key_id(&publisher));
    assert_eq!(t.send(Method::PUT, &path, Some(json!({ "maySignCatalog": true }))).await.status, StatusCode::OK);
    assert_eq!(t.refresh().await.status, StatusCode::OK);
    assert_eq!(t.catalog("").await["state"], "ready");
    assert_eq!(t.audit("plugins.key_catalog_allowed").await.len(), 1);

    // Taken back: the list stays, but nothing is installed from it.
    assert_eq!(t.send(Method::PUT, &path, Some(json!({ "maySignCatalog": false }))).await.status, StatusCode::OK);
    assert_eq!(t.catalog("").await["state"], "untrusted");
    let r = t
        .send(Method::PUT, "/admin/plugin-keys/0000000000000000/catalog", Some(json!({ "maySignCatalog": true })))
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    // Only server administrators.
    let org_admin = t.member("admin").await;
    let r = t.send_as(&org_admin, Method::PUT, &path, Some(json!({ "maySignCatalog": true }))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    t.finish().await;
}

/// The catalog's own host may be a private mirror, but packages and redirects on any other host
/// must be public, and the catalog address can never be Kalzit's own port.
#[tokio::test]
async fn other_hosts_must_be_public_and_kalzit_itself_is_refused() {
    let t = test_app().await;
    let catalog_key = key(1);
    t.trust_catalog(&catalog_key, "Katalog GmbH").await;
    t.turn_on().await;
    let pkg = package(ID, "1.0.0", Some(&catalog_key), false, "");
    let mut entry = t.offer(ID, "1.0.0", &catalog_key, pkg);
    // The same server under another name: a private address of another host.
    let port = t.base.rsplit(':').next().unwrap().to_string();
    entry.url = format!("https://127.0.0.1:{port}/pkg/{ID}-1.0.0.kalzit-plugin");
    t.publish(&index(1, vec![entry]), &catalog_key);
    assert_eq!(t.refresh().await.status, StatusCode::OK, "the configured private host is allowed");
    let r = t.install(ID, "1.0.0").await;
    assert_eq!(r.reason(), "catalog.private_target", "{}", r.body);

    // A redirect of the index to a private address elsewhere is refused at that hop.
    t.files.put("index.json", format!("REDIRECT https://127.0.0.1:{port}/index.json").into_bytes());
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.private_target", "{}", r.body);

    // Kalzit's own listening port (127.0.0.1:3999 in these tests).
    t.setting("plugins.catalog_url", json!("https://localhost:3999/index.json")).await;
    let r = t.refresh().await;
    assert_eq!(r.reason(), "catalog.own_address", "{}", r.body);
    t.finish().await;
}
