//! TLS with rustls (no OpenSSL, same code on Windows and Linux). Certificates are PEM files and
//! are reloaded when they change, so a renewed certificate needs no restart.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};

use crate::config::TlsConfig;

pub fn server_config(cfg: &TlsConfig) -> Result<Arc<ServerConfig>> {
    let (Some(cert_file), Some(key_file)) = (&cfg.cert_file, &cfg.key_file) else {
        anyhow::bail!("tls.cert_file and tls.key_file are required for HTTPS");
    };
    let certs = CertificateDer::pem_file_iter(cert_file)
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .with_context(|| format!("reading certificates from {}", cert_file.display()))?;
    if certs.is_empty() {
        anyhow::bail!("{} contains no certificate", cert_file.display());
    }
    let key = PrivateKeyDer::from_pem_file(key_file)
        .with_context(|| format!("reading the private key from {}", key_file.display()))?;

    let versions: &[&rustls::SupportedProtocolVersion] = match cfg.min_version.as_str() {
        "1.3" => &[&rustls::version::TLS13],
        _ => &[&rustls::version::TLS12, &rustls::version::TLS13],
    };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .context("TLS protocol versions")?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("certificate and key do not match or are not supported")?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Checks the certificate files every `reload_interval_secs` and swaps the configuration when
/// they changed. A broken new file keeps the old certificate in use and logs why.
pub fn spawn_reload(rustls: RustlsConfig, cfg: TlsConfig) {
    if cfg.reload_interval_secs == 0 {
        return;
    }
    tokio::spawn(async move {
        let mut last = modified(&cfg);
        let mut tick = tokio::time::interval(Duration::from_secs(cfg.reload_interval_secs));
        tick.tick().await;
        loop {
            tick.tick().await;
            let now = modified(&cfg);
            if now == last {
                continue;
            }
            last = now;
            match server_config(&cfg) {
                Ok(new) => {
                    rustls.reload_from_config(new);
                    tracing::info!("TLS certificate reloaded");
                }
                Err(e) => tracing::warn!("TLS certificate changed but could not be loaded, keeping the old one: {e:#}"),
            }
        }
    });
}

fn modified(cfg: &TlsConfig) -> (Option<SystemTime>, Option<SystemTime>) {
    let m = |p: &Option<std::path::PathBuf>| p.as_deref().and_then(|p: &Path| p.metadata().ok()?.modified().ok());
    (m(&cfg.cert_file), m(&cfg.key_file))
}
