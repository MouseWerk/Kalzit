//! The connection of the kinds that speak their own protocol over TCP without a driver that
//! connects by itself (Redis, ClickHouse's native protocol): Kalzit opens the socket to the
//! checked address (`TargetPolicy::connect`) and, when asked, TLS against the configured name,
//! trusting the platform's certificates and an optional CA in PEM.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};

use super::{SourceError, targets::TargetPolicy};

/// A plain or TLS stream.
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send + Sync {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Sync> Stream for T {}

/// TLS for a socket.
pub struct Tls<'a> {
    /// PEM certificates trusted in addition to the platform's store.
    pub ca_pem: Option<&'a str>,
}

/// An open connection: the stream, and for plain TCP a second handle on the socket, so a pool
/// can see whether the server closed it while it waited (`pool::socket_open`). TLS has none: a
/// server may send TLS records unasked (session tickets), which that look would take for data.
pub struct Opened {
    pub stream: Box<dyn Stream>,
    pub probe: Option<std::net::TcpStream>,
}

/// Connects to the checked address of `host`, with TLS against the name `host` when `tls` is
/// set. `reason` names the kind's own TLS failure (`redis.tls`, `clickhouse.tls`); `timeout`
/// covers the TCP connect and the TLS handshake each.
pub async fn open(
    policy: &TargetPolicy,
    host: &str,
    port: u16,
    timeout: Duration,
    tls: Option<Tls<'_>>,
    reason: &'static str,
) -> Result<Opened, SourceError> {
    let (_, tcp) = policy.connect(host, port, timeout).await?;
    let io = |e: std::io::Error| SourceError::from_source(e.to_string());
    tcp.set_nodelay(true).map_err(io)?;
    let Some(tls) = tls else {
        let socket = tcp.into_std().map_err(io)?;
        let probe = socket.try_clone().map_err(io)?;
        let tcp = tokio::net::TcpStream::from_std(socket).map_err(io)?;
        return Ok(Opened { stream: Box::new(tcp), probe: Some(probe) });
    };
    let config = client_config(tls.ca_pem, reason)?;
    let name = rustls::pki_types::ServerName::try_from(host.trim_matches(['[', ']']).to_string()).map_err(|e| {
        SourceError::failed(reason, format!("TLS failed: {host} cannot be checked: {e}")).with("detail", e)
    })?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let stream = tokio::time::timeout(timeout, connector.connect(name, tcp))
        .await
        .map_err(|_| {
            let address = super::connect::address(host, port);
            SourceError::Failed(super::connect::timed_out(&address, timeout))
        })?
        .map_err(|e| SourceError::failed(reason, format!("TLS failed: {e}")).with("detail", e))?;
    Ok(Opened { stream: Box::new(stream), probe: None })
}

/// The platform's certificates plus `ca_pem`, with ring, as every TLS connection of Kalzit.
fn client_config(ca_pem: Option<&str>, reason: &'static str) -> Result<rustls::ClientConfig, SourceError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| SourceError::failed(reason, format!("TLS failed: {e}")).with("detail", e))?;
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for e in &native.errors {
        tracing::warn!("reading the platform's certificates: {e}");
    }
    roots.add_parsable_certificates(native.certs);
    if let Some(pem) = ca_pem.filter(|p| !p.trim().is_empty()) {
        use rustls::pki_types::pem::PemObject;
        for cert in rustls::pki_types::CertificateDer::pem_slice_iter(pem.as_bytes()) {
            let cert = cert.map_err(|e| {
                SourceError::failed(reason, format!("TLS failed: the CA certificate is not valid PEM: {e}"))
                    .with("detail", e)
            })?;
            roots.add(cert).map_err(|e| {
                SourceError::failed(reason, format!("TLS failed: the CA certificate cannot be used: {e}"))
                    .with("detail", e)
            })?;
        }
    }
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ca_that_is_not_pem_is_named() {
        let e =
            client_config(Some("-----BEGIN CERTIFICATE-----\nnot base64\n-----END CERTIFICATE-----\n"), "redis.tls")
                .unwrap_err();
        assert_eq!(e.detail().reason, "redis.tls");
        assert!(client_config(None, "redis.tls").is_ok());
    }

    #[tokio::test]
    async fn a_refused_target_is_refused_before_connecting() {
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let e = open(&policy, "169.254.169.254", 6379, Duration::from_secs(1), None, "redis.tls").await;
        assert!(matches!(e, Err(SourceError::Blocked(_))));
    }
}
