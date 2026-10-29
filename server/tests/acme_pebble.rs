//! Ordering real certificates from pebble, Let's Encrypt's ACME test server (CI job `acme`, on
//! Linux): the settings saved through the API, HTTP-01 on the HTTP listener, TLS-ALPN-01 on the
//! HTTPS listener, the issued certificate served without a restart and again after one, read
//! back from the encrypted store.
//!
//! Needs pebble listening at `KALZIT_TEST_PEBBLE_DIRECTORY` with its CA in
//! `KALZIT_TEST_PEBBLE_CA` (a PEM file), validating on ports 5002 (HTTP-01) and 5001
//! (TLS-ALPN-01) of 127.0.0.1, and the names `http.kalzit.test` and `alpn.kalzit.test`
//! resolving to 127.0.0.1 for pebble and for this machine. Ignored elsewhere.

use std::net::SocketAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use kalzit::config::Config;
use reqwest::{Certificate, Client, StatusCode};
use serde_json::{Value, json};

mod common;

const SETUP_CODE: &str = "acme-test-setup-code-0123";
const HTTP_DOMAIN: &str = "http.kalzit.test";
const ALPN_DOMAIN: &str = "alpn.kalzit.test";
const HTTP: &str = "127.0.0.1:5002";
const HTTPS: &str = "127.0.0.1:5001";

struct Pebble {
    directory: String,
    ca_pem: String,
}

fn pebble() -> Pebble {
    let directory = std::env::var("KALZIT_TEST_PEBBLE_DIRECTORY").expect("KALZIT_TEST_PEBBLE_DIRECTORY");
    let ca = std::env::var("KALZIT_TEST_PEBBLE_CA").expect("KALZIT_TEST_PEBBLE_CA");
    Pebble { directory, ca_pem: std::fs::read_to_string(ca).unwrap() }
}

/// The server with HTTP, and with HTTPS when `https` (which needs ACME on).
async fn start(dir: &Path, https: bool) -> kalzit::server::Running {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = Config::default();
    config.paths.data_dir = dir.join("data");
    config.server.http_addr = HTTP.into();
    config.server.https_addr = if https { HTTPS.into() } else { String::new() };
    // The test talks to the API over plain HTTP.
    config.server.redirect_http_to_https = false;
    kalzit::server::start(config, Some(SETUP_CODE.into())).await.unwrap()
}

struct Api {
    client: Client,
    cookie: String,
}

/// `name=value` of the session cookie an answer sets.
fn session_cookie(res: &reqwest::Response) -> String {
    res.headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or_default().to_string())
        .find(|c| c.contains("session="))
        .expect("a session cookie")
}

impl Api {
    async fn sign_up() -> Api {
        let client = Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
        let body = json!({ "token": SETUP_CODE, "orgName": "Kalzit", "name": "Admin",
                           "email": "admin@example.com", "password": "Grün und sicher 2026" });
        let res = client.post(format!("http://{HTTP}/api/setup")).json(&body).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        Api { client, cookie: session_cookie(&res) }
    }

    async fn sign_in() -> Api {
        let client = Client::builder().timeout(Duration::from_secs(30)).build().unwrap();
        let body = json!({ "email": "admin@example.com", "password": "Grün und sicher 2026" });
        let res = client.post(format!("http://{HTTP}/api/auth/login")).json(&body).send().await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        Api { client, cookie: session_cookie(&res) }
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self.client.request(method, format!("http://{HTTP}/api{path}")).header("cookie", &self.cookie);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        (status, res.json().await.unwrap_or(Value::Null))
    }

    async fn status(&self) -> Value {
        self.call(reqwest::Method::GET, "/admin/acme", None).await.1
    }

    async fn save(&self, settings: Value) -> Value {
        let version = self.status().await["version"].clone();
        let (status, body) = self
            .call(reqwest::Method::PUT, "/admin/acme", Some(json!({ "settings": settings, "version": version })))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// Waits until a certificate for `domain` is in place.
    async fn wait_valid(&self, domain: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            let view = self.status().await;
            let status = &view["status"];
            let has = status["certificate"]["domains"].as_array().is_some_and(|d| d.iter().any(|x| x == domain));
            if status["phase"] == "valid" && has {
                return view;
            }
            assert_ne!(status["phase"], "failed", "ordering failed: {}", status["lastError"]);
            assert!(Instant::now() < deadline, "no certificate in time: {status}");
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

fn settings(pebble: &Pebble, domain: &str, challenge: &str) -> Value {
    json!({
        "enabled": true,
        "directory": "custom",
        "directoryUrl": pebble.directory,
        "directoryCa": pebble.ca_pem,
        "domains": [domain],
        "email": "ops@example.com",
        "challenge": challenge,
        "acceptTerms": true,
    })
}

/// pebble's root for issued certificates, from its management interface (port 15000).
async fn issuing_root(pebble: &Pebble) -> Certificate {
    let url = reqwest::Url::parse(&pebble.directory).unwrap();
    let management = format!("https://{}:15000/roots/0", url.host_str().unwrap());
    let client =
        Client::builder().tls_certs_only([Certificate::from_pem(pebble.ca_pem.as_bytes()).unwrap()]).build().unwrap();
    let pem = client.get(management).send().await.unwrap().text().await.unwrap();
    Certificate::from_pem(pem.as_bytes()).unwrap()
}

/// The HTTPS listener serves a certificate for `domain` that chains to pebble's root.
async fn served_for(pebble: &Pebble, domain: &str) -> bool {
    let https: SocketAddr = HTTPS.parse().unwrap();
    let client = Client::builder()
        .tls_certs_only([issuing_root(pebble).await])
        .resolve(domain, https)
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    match client.get(format!("https://{domain}:{}/healthz", https.port())).send().await {
        Ok(res) => res.status() == StatusCode::OK,
        Err(_) => false,
    }
}

#[tokio::test]
#[ignore = "needs pebble (CI job acme)"]
async fn certificates_are_ordered_served_renewed_and_kept() {
    let pebble = pebble();
    let dir = common::private_tempdir();
    // HTTPS off at first: HTTP-01 orders the certificate already, answered by the HTTP listener.
    let server = start(dir.path(), false).await;
    let api = Api::sign_up().await;
    let view = api.save(settings(&pebble, HTTP_DOMAIN, "http-01")).await;
    assert_eq!(view["server"]["httpsAddr"], Value::Null);
    let view = api.wait_valid(HTTP_DOMAIN).await;
    assert!(view["status"]["certificate"]["renewAt"].as_i64() < view["status"]["certificate"]["notAfter"].as_i64());
    server.shutdown();
    server.wait().await.unwrap();

    // HTTPS turned on: the stored certificate is served at once.
    let server = start(dir.path(), true).await;
    assert!(served_for(&pebble, HTTP_DOMAIN).await, "the stored certificate is served after the restart");
    let api = Api::sign_in().await;

    // TLS-ALPN-01, answered by the HTTPS listener; a new name orders a new certificate, served
    // without a restart.
    api.save(settings(&pebble, ALPN_DOMAIN, "tls-alpn-01")).await;
    api.wait_valid(ALPN_DOMAIN).await;
    assert!(served_for(&pebble, ALPN_DOMAIN).await, "the issued certificate is served without a restart");

    // A new certificate is not renewed on request: that would only spend the CA's limits.
    let (status, body) = api.call(reqwest::Method::POST, "/admin/acme/renew", None).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["reason"], "acme.renew_too_soon");

    server.shutdown();
    server.wait().await.unwrap();

    // After another restart the newest stored certificate is served at once.
    let server = start(dir.path(), true).await;
    assert!(served_for(&pebble, ALPN_DOMAIN).await, "the stored certificate is served after a restart");
    let api = Api::sign_in().await;
    assert_eq!(api.status().await["status"]["phase"], "valid");
    let (status, audit) = api.call(reqwest::Method::GET, "/admin/audit?limit=100", None).await;
    assert_eq!(status, StatusCode::OK, "{audit}");
    let actions: Vec<&str> = audit["items"].as_array().unwrap().iter().filter_map(|e| e["action"].as_str()).collect();
    assert_eq!(actions.iter().filter(|a| **a == "tls.certificate_issued").count(), 2, "{actions:?}");
    assert!(actions.contains(&"tls.acme_changed"), "{actions:?}");
    // Nothing in the data directory shows the key in clear.
    for entry in std::fs::read_dir(dir.path().join("data").join("acme")).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(!text.contains("PRIVATE KEY") && !text.contains(ALPN_DOMAIN), "{text}");
    }
    server.shutdown();
    server.wait().await.unwrap();
    common::remove_dir(dir);
}
