//! Real listeners on random ports: HTTPS with a self-signed certificate, the HTTP to HTTPS
//! redirect, certificate reload and the minimum TLS version.

use std::path::Path;
use std::time::{Duration, Instant};

use kalzit::config::Config;
use reqwest::{Certificate, Client, StatusCode, redirect};

mod common;

struct TestCert {
    pem: String,
    key: String,
}

fn self_signed() -> TestCert {
    let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
    TestCert { pem: ck.cert.pem(), key: ck.signing_key.serialize_pem() }
}

fn write_cert(dir: &Path, cert: &TestCert) {
    std::fs::write(dir.join("cert.pem"), &cert.pem).unwrap();
    std::fs::write(dir.join("key.pem"), &cert.key).unwrap();
}

fn client_trusting(cert: &TestCert) -> Client {
    Client::builder()
        .tls_certs_only([Certificate::from_pem(cert.pem.as_bytes()).unwrap()])
        .redirect(redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap()
}

async fn start(dir: &Path, tweak: impl FnOnce(&mut Config)) -> kalzit::server::Running {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut config = Config::default();
    config.paths.data_dir = dir.join("data");
    config.server.http_addr = "127.0.0.1:0".into();
    config.server.https_addr = "127.0.0.1:0".into();
    config.tls.cert_file = Some(dir.join("cert.pem"));
    config.tls.key_file = Some(dir.join("key.pem"));
    tweak(&mut config);
    kalzit::server::start(config, Some("tls-test-setup-code-0123".into())).await.unwrap()
}

#[tokio::test]
async fn https_serves_and_http_redirects() {
    let dir = tempfile::tempdir().unwrap();
    let cert = self_signed();
    write_cert(dir.path(), &cert);
    let server = start(dir.path(), |_| {}).await;
    let https = server.https_addr.unwrap();
    let http = server.http_addr.unwrap();
    let client = client_trusting(&cert);

    let res = client.get(format!("https://localhost:{}/api/setup", https.port())).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers().get("strict-transport-security").is_some());

    let res = client.get(format!("http://127.0.0.1:{}/dashboards/x?from=now-1h", http.port())).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
    assert_eq!(
        res.headers().get("location").unwrap().to_str().unwrap(),
        format!("https://127.0.0.1:{}/dashboards/x?from=now-1h", https.port())
    );

    // Health checks of load balancers often speak plain HTTP; they are not redirected.
    let res = client.get(format!("http://127.0.0.1:{}/healthz", http.port())).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    server.shutdown();
    server.wait().await.unwrap();
    common::remove_dir(dir);
}

#[tokio::test]
async fn redirect_respects_public_url_proxies_and_bad_hosts() {
    let dir = tempfile::tempdir().unwrap();
    let cert = self_signed();
    write_cert(dir.path(), &cert);
    let server = start(dir.path(), |c| {
        c.server.public_url = Some("https://kalzit.example.com".into());
        c.security.trusted_proxies = vec!["127.0.0.0/8".parse().unwrap()];
    })
    .await;
    let http = format!("http://127.0.0.1:{}", server.http_addr.unwrap().port());
    let client = client_trusting(&cert);

    // Behind a port mapping the bound HTTPS port is wrong for users; public_url is right.
    let res = client.get(format!("{http}/explore?q=1")).send().await.unwrap();
    assert_eq!(res.headers().get("location").unwrap(), "https://kalzit.example.com/explore?q=1");

    // A trusted proxy that already terminated TLS gets the app, not another redirect.
    let res = client.get(format!("{http}/api/setup")).header("x-forwarded-proto", "https").send().await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    server.shutdown();
    server.wait().await.unwrap();

    let server = start(dir.path(), |_| {}).await;
    let http = format!("http://127.0.0.1:{}", server.http_addr.unwrap().port());
    let res = client.get(format!("{http}/")).header("host", "evil.example/x").send().await.unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    let res = client.get(format!("{http}/a")).header("host", "[::1]:8080").send().await.unwrap();
    let https_port = server.https_addr.unwrap().port();
    assert_eq!(res.headers().get("location").unwrap().to_str().unwrap(), format!("https://[::1]:{https_port}/a"));
    server.shutdown();
    server.wait().await.unwrap();
    common::remove_dir(dir);
}

#[tokio::test]
async fn renewed_certificate_is_picked_up_without_restart() {
    let dir = tempfile::tempdir().unwrap();
    let old = self_signed();
    write_cert(dir.path(), &old);
    let server = start(dir.path(), |c| c.tls.reload_interval_secs = 1).await;
    let url = format!("https://localhost:{}/healthz", server.https_addr.unwrap().port());

    let new = self_signed();
    let trusts_new = client_trusting(&new);
    assert!(trusts_new.get(&url).send().await.is_err(), "new certificate must not be served yet");
    write_cert(dir.path(), &new);

    let deadline = Instant::now() + common::HANG_GUARD;
    loop {
        if trusts_new.get(&url).send().await.is_ok() {
            break;
        }
        assert!(Instant::now() < deadline, "renewed certificate was not loaded in time");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    server.shutdown();
    server.wait().await.unwrap();
    common::remove_dir(dir);
}

#[tokio::test]
async fn minimum_tls_version_is_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let cert = self_signed();
    write_cert(dir.path(), &cert);
    let server = start(dir.path(), |c| c.tls.min_version = "1.3".into()).await;
    let url = format!("https://localhost:{}/healthz", server.https_addr.unwrap().port());

    let tls12_only = Client::builder()
        .tls_certs_only([Certificate::from_pem(cert.pem.as_bytes()).unwrap()])
        .tls_version_max(reqwest::tls::Version::TLS_1_2)
        .build()
        .unwrap();
    assert!(tls12_only.get(&url).send().await.is_err());
    assert_eq!(client_trusting(&cert).get(&url).send().await.unwrap().status(), StatusCode::OK);

    server.shutdown();
    server.wait().await.unwrap();
    common::remove_dir(dir);
}

#[tokio::test]
async fn https_without_certificate_files_needs_acme_then_serves_a_temporary_one() {
    let dir = tempfile::tempdir().unwrap();
    let no_files = |c: &mut Config| {
        c.tls.cert_file = None;
        c.tls.key_file = None;
    };
    // ACME off: no HTTPS with a permanent self-signed certificate (fail closed).
    let mut config = Config::default();
    config.paths.data_dir = dir.path().join("data");
    config.server.http_addr = "127.0.0.1:0".into();
    config.server.https_addr = "127.0.0.1:0".into();
    let url = config.database_url();
    let err = match kalzit::server::start(config, Some("tls-test-setup-code-0123".into())).await {
        Ok(_) => panic!("HTTPS without certificate files and without ACME must not start"),
        Err(e) => format!("{e:#}"),
    };
    assert!(err.contains("tls.cert_file") && err.contains("ACME"), "{err}");
    // ACME on (as a save in Settings stores it): HTTPS starts with the temporary certificate.
    let db = kalzit::db::connect(&url, 1).await.unwrap();
    // A directory nobody answers at, so the background order fails here instead of reaching a CA.
    let settings = serde_json::json!({ "enabled": true, "directory": "custom", "directoryUrl": "https://127.0.0.1:9/dir",
                                       "domains": ["kalzit.example.com"], "acceptTerms": true });
    sqlx::query(
        "INSERT INTO server_settings (key, value, version, updated_by, updated_at) VALUES ($1, $2, 1, NULL, 0)",
    )
    .bind(kalzit::acme::SETTINGS_KEY)
    .bind(settings.to_string())
    .execute(&db)
    .await
    .unwrap();
    db.close().await;
    let server = start(dir.path(), no_files).await;
    let https = server.https_addr.unwrap();
    let url = format!("https://localhost:{}/healthz", https.port());
    // Not trusted by anyone, but HTTPS works until ACME has a certificate.
    let default_roots = Client::builder().timeout(Duration::from_secs(10)).build().unwrap();
    assert!(default_roots.get(&url).send().await.is_err());
    let any = Client::builder().danger_accept_invalid_certs(true).timeout(Duration::from_secs(10)).build().unwrap();
    assert_eq!(any.get(&url).send().await.unwrap().status(), StatusCode::OK);
    // HTTP-01 validations reach the HTTP listener instead of being redirected.
    let client = Client::builder().redirect(redirect::Policy::none()).build().unwrap();
    let http = server.http_addr.unwrap();
    let res =
        client.get(format!("http://127.0.0.1:{}/.well-known/acme-challenge/x", http.port())).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let res = client.get(format!("http://127.0.0.1:{}/explore", http.port())).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT);
    server.shutdown();
    server.wait().await.unwrap();
    common::remove_dir(dir);
}

#[tokio::test]
async fn busy_port_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = taken.local_addr().unwrap().port();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().join("data");
    config.server.http_addr = format!("127.0.0.1:{port}");
    let err = match kalzit::server::start(config, None).await {
        Ok(_) => panic!("binding a busy port must fail"),
        Err(e) => format!("{e:#}"),
    };
    assert!(err.contains(&port.to_string()), "{err}");
    // The failed start closed what it had opened.
    common::remove_dir(dir);
}
