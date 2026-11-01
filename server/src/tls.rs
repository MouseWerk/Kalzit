//! TLS with rustls (no OpenSSL, same code on Windows and Linux). Certificates are PEM files and
//! are reloaded when their content changes, so a renewed certificate needs no restart. Without
//! files, the certificates come from ACME (`acme::resolver`), which swaps them itself.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum_server::tls_rustls::RustlsConfig;
use rustls::ServerConfig;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::server::ResolvesServerCert;
use sha2::{Digest, Sha256};

use crate::config::TlsConfig;

pub fn server_config(cfg: &TlsConfig) -> Result<Arc<ServerConfig>> {
    config_from(cfg, &read_files(cfg)?)
}

/// The certificate and key files as read once: a reload hashes and parses the same bytes, so a
/// file replaced in between cannot mix into what was compared.
struct Files {
    cert: Vec<u8>,
    key: Vec<u8>,
}

fn read_files(cfg: &TlsConfig) -> Result<Files> {
    let (Some(cert_file), Some(key_file)) = (&cfg.cert_file, &cfg.key_file) else {
        anyhow::bail!("tls.cert_file and tls.key_file are required for HTTPS");
    };
    let cert =
        std::fs::read(cert_file).with_context(|| format!("reading certificates from {}", cert_file.display()))?;
    let key =
        std::fs::read(key_file).with_context(|| format!("reading the private key from {}", key_file.display()))?;
    Ok(Files { cert, key })
}

fn config_from(cfg: &TlsConfig, files: &Files) -> Result<Arc<ServerConfig>> {
    let name = |p: &Option<std::path::PathBuf>| p.as_deref().map(|p| p.display().to_string()).unwrap_or_default();
    let certs = CertificateDer::pem_slice_iter(&files.cert)
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("reading certificates from {}", name(&cfg.cert_file)))?;
    if certs.is_empty() {
        anyhow::bail!("{} contains no certificate", name(&cfg.cert_file));
    }
    let key = PrivateKeyDer::from_pem_slice(&files.key)
        .with_context(|| format!("reading the private key from {}", name(&cfg.key_file)))?;

    let mut config =
        builder(cfg)?.with_single_cert(certs, key).context("certificate and key do not match or are not supported")?;
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// HTTPS with the certificates ACME provides; also answers TLS-ALPN-01 validations, whose
/// clients offer only `acme-tls/1` (browsers never do, so they get h2 or HTTP/1.1).
pub fn acme_server_config(cfg: &TlsConfig, resolver: Arc<dyn ResolvesServerCert>) -> Result<Arc<ServerConfig>> {
    let mut config = builder(cfg)?.with_cert_resolver(resolver);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec(), crate::acme::resolver::ACME_TLS_ALPN.to_vec()];
    Ok(Arc::new(config))
}

fn builder(cfg: &TlsConfig) -> Result<rustls::ConfigBuilder<ServerConfig, rustls::server::WantsServerCert>> {
    let versions: &[&rustls::SupportedProtocolVersion] = match cfg.min_version.as_str() {
        "1.3" => &[&rustls::version::TLS13],
        _ => &[&rustls::version::TLS12, &rustls::version::TLS13],
    };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .context("TLS protocol versions")?
        .with_no_client_auth())
}

/// Checks the certificate files every `reload_interval_secs` and swaps the configuration when
/// their content changed. A broken new file keeps the old certificate in use and logs why.
pub fn spawn_reload(rustls: RustlsConfig, cfg: TlsConfig) {
    if cfg.reload_interval_secs == 0 {
        return;
    }
    tokio::spawn(async move {
        let mut watch = Watch::new(&cfg);
        let mut tick = tokio::time::interval(Duration::from_secs(cfg.reload_interval_secs));
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(read) = watch.check(&cfg) else { continue };
            match read.and_then(|files| config_from(&cfg, &files)) {
                Ok(new) => {
                    rustls.reload_from_config(new);
                    tracing::info!("TLS certificate reloaded");
                }
                Err(e) => tracing::warn!("TLS certificate changed but could not be loaded, keeping the old one: {e:#}"),
            }
        }
    });
}

/// Tells a change of the certificate and key files by their content, not their modification
/// time: a renewal that keeps the time, a copied file with an older time or a clock that went
/// back still count as a change, and rewriting a file with the same bytes does not.
struct Watch {
    last: Option<[u8; 32]>,
}

impl Watch {
    fn new(cfg: &TlsConfig) -> Self {
        Self { last: read_files(cfg).ok().as_ref().map(content_hash) }
    }

    /// The files as read now when their content differs from the last check, `None` when it
    /// does not. Files that cannot be read count as a content of their own, so the reload is
    /// tried, and fails with a log line, once.
    fn check(&mut self, cfg: &TlsConfig) -> Option<Result<Files>> {
        let read = read_files(cfg);
        let now = read.as_ref().ok().map(content_hash);
        if now == self.last {
            return None;
        }
        self.last = now;
        Some(read)
    }
}

/// SHA-256 over both files, each after its length, so bytes moved from one file to the other
/// change it too.
fn content_hash(files: &Files) -> [u8; 32] {
    let mut hash = Sha256::new();
    for bytes in [&files.cert, &files.key] {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.finalize().into()
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::time::SystemTime;

    use super::*;

    fn config(dir: &Path) -> TlsConfig {
        TlsConfig { cert_file: Some(dir.join("cert.pem")), key_file: Some(dir.join("key.pem")), ..TlsConfig::default() }
    }

    fn write(dir: &Path, cert: &str, key: &str) {
        std::fs::write(dir.join("cert.pem"), cert).unwrap();
        std::fs::write(dir.join("key.pem"), key).unwrap();
    }

    fn set_mtime(path: &Path, at: SystemTime) {
        std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    }

    #[test]
    fn a_new_certificate_with_the_old_modification_time_is_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        write(dir.path(), "cert one", "key one");
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        set_mtime(&dir.path().join("cert.pem"), at);
        set_mtime(&dir.path().join("key.pem"), at);
        let mut watch = Watch::new(&cfg);
        assert!(watch.check(&cfg).is_none());

        // Renewed in place with the time kept, then a key copied in with an older time.
        std::fs::write(dir.path().join("cert.pem"), "cert two").unwrap();
        set_mtime(&dir.path().join("cert.pem"), at);
        assert!(watch.check(&cfg).is_some());
        assert!(watch.check(&cfg).is_none(), "the same content is loaded once");
        std::fs::write(dir.path().join("key.pem"), "key two").unwrap();
        set_mtime(&dir.path().join("key.pem"), at - Duration::from_secs(3600));
        assert!(watch.check(&cfg).is_some());
    }

    #[test]
    fn an_unchanged_file_with_a_new_time_is_no_change() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        write(dir.path(), "cert", "key");
        let mut watch = Watch::new(&cfg);
        // Rewritten with the same bytes, as by a renewal that found nothing to renew.
        write(dir.path(), "cert", "key");
        set_mtime(&dir.path().join("cert.pem"), SystemTime::now() + Duration::from_secs(60));
        assert!(watch.check(&cfg).is_none());
    }

    #[test]
    fn a_missing_file_counts_once_and_its_return_again() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        write(dir.path(), "cert", "key");
        let mut watch = Watch::new(&cfg);
        std::fs::remove_file(dir.path().join("key.pem")).unwrap();
        assert!(watch.check(&cfg).is_some());
        assert!(watch.check(&cfg).is_none());
        std::fs::write(dir.path().join("key.pem"), "key").unwrap();
        assert!(watch.check(&cfg).is_some());
    }

    #[test]
    fn bytes_moved_between_the_files_are_a_change() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        write(dir.path(), "ab", "c");
        let mut watch = Watch::new(&cfg);
        write(dir.path(), "a", "bc");
        assert!(watch.check(&cfg).is_some());
    }

    /// The configuration is made from the bytes that were compared: a file replaced after the
    /// check does not get into it.
    #[test]
    fn the_reload_parses_what_it_compared() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        write(dir.path(), "old", "old");
        let mut watch = Watch::new(&cfg);
        let ck = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        write(dir.path(), &ck.cert.pem(), &ck.signing_key.serialize_pem());
        let files = watch.check(&cfg).unwrap().unwrap();
        // Replaced by something broken right after the check.
        write(dir.path(), "broken", "broken");
        assert!(config_from(&cfg, &files).is_ok());
        assert!(server_config(&cfg).is_err());
    }
}
