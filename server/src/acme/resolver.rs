//! The certificates the HTTPS listener serves when no certificate files are configured: the one
//! ACME issued, until then a self-signed one made at the start, and for a TLS-ALPN-01
//! validation the challenge certificate of the name asked for (RFC 8737). A new certificate takes
//! effect for the next handshake, without a restart.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use crate::locks::{MutexExt, RwLockExt};

use anyhow::{Context, Result};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;

/// The ALPN protocol of TLS-ALPN-01 validations.
pub const ACME_TLS_ALPN: &[u8] = b"acme-tls/1";

pub struct Certificates {
    current: RwLock<Option<Arc<CertifiedKey>>>,
    fallback: Arc<CertifiedKey>,
    /// TLS-ALPN-01 answers by name, while a validation runs.
    challenges: Mutex<HashMap<String, Arc<CertifiedKey>>>,
}

impl std::fmt::Debug for Certificates {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Certificates").finish_non_exhaustive()
    }
}

impl Certificates {
    /// With a self-signed certificate for `names` (or `localhost`) until a real one is set.
    pub fn new(names: &[String]) -> Result<Self> {
        let names = if names.is_empty() { vec!["localhost".to_string()] } else { names.to_vec() };
        let key = rcgen::KeyPair::generate().context("making a key")?;
        let mut params = rcgen::CertificateParams::new(names).context("certificate names")?;
        params.distinguished_name.push(rcgen::DnType::CommonName, "Kalzit (temporary, self-signed)");
        let cert = params.self_signed(&key).context("making the temporary certificate")?;
        let fallback = certified(vec![cert.der().clone()], &key)?;
        Ok(Self { current: RwLock::default(), fallback: Arc::new(fallback), challenges: Mutex::default() })
    }

    /// Serves `chain_pem` with `key_pem` from the next handshake on.
    pub fn set(&self, chain_pem: &str, key_pem: &str) -> Result<()> {
        let key = from_pem(chain_pem, key_pem)?;
        *self.current.write_or_recover() = Some(Arc::new(key));
        Ok(())
    }

    pub fn has_certificate(&self) -> bool {
        self.current.read_or_recover().is_some()
    }

    /// Answers TLS-ALPN-01 for `domain` with a certificate carrying `digest`, the SHA-256 of the
    /// key authorization.
    pub fn add_challenge(&self, domain: &str, digest: &[u8]) -> Result<()> {
        let key = rcgen::KeyPair::generate().context("making a key")?;
        let mut params = rcgen::CertificateParams::new(vec![domain.to_string()]).context("challenge name")?;
        params.custom_extensions = vec![rcgen::CustomExtension::new_acme_identifier(digest)];
        let cert = params.self_signed(&key).context("making the challenge certificate")?;
        let certified = certified(vec![cert.der().clone()], &key)?;
        self.lock_challenges().insert(domain.to_ascii_lowercase(), Arc::new(certified));
        Ok(())
    }

    pub fn remove_challenge(&self, domain: &str) {
        self.lock_challenges().remove(&domain.to_ascii_lowercase());
    }

    fn lock_challenges(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<CertifiedKey>>> {
        self.challenges.lock_or_recover()
    }
}

impl ResolvesServerCert for Certificates {
    fn resolve(&self, hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        // A validation offers only `acme-tls/1`; it gets the challenge certificate or nothing.
        let validation = hello.alpn().is_some_and(|mut protocols| protocols.any(|p| p == ACME_TLS_ALPN));
        if validation {
            let name = hello.server_name()?.to_ascii_lowercase();
            return self.lock_challenges().get(&name).cloned();
        }
        let current = self.current.read_or_recover().clone();
        Some(current.unwrap_or_else(|| self.fallback.clone()))
    }
}

fn certified(chain: Vec<CertificateDer<'static>>, key: &rcgen::KeyPair) -> Result<CertifiedKey> {
    let der = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der()));
    let signing = rustls::crypto::ring::sign::any_supported_type(&der).context("the key type is not supported")?;
    Ok(CertifiedKey::new(chain, signing))
}

/// A chain and its key from PEM, checked to belong together.
pub fn from_pem(chain_pem: &str, key_pem: &str) -> Result<CertifiedKey> {
    let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(chain_pem.as_bytes())
        .collect::<Result<_, _>>()
        .context("reading the certificate chain")?;
    if chain.is_empty() {
        anyhow::bail!("the certificate chain is empty");
    }
    let key = PrivateKeyDer::from_pem_slice(key_pem.as_bytes()).context("reading the private key")?;
    let signing = rustls::crypto::ring::sign::any_supported_type(&key).context("the key type is not supported")?;
    let certified = CertifiedKey::new(chain, signing);
    certified.keys_match().context("the certificate and its key do not belong together")?;
    Ok(certified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_certificate_replaces_the_temporary_one() {
        let certs = Certificates::new(&[]).unwrap();
        assert!(!certs.has_certificate());
        let issued = rcgen::generate_simple_self_signed(vec!["kalzit.example.com".into()]).unwrap();
        certs.set(&issued.cert.pem(), &issued.signing_key.serialize_pem()).unwrap();
        assert!(certs.has_certificate());
        // A key of another certificate is refused, and the served one stays.
        let other = rcgen::generate_simple_self_signed(vec!["x.example.com".into()]).unwrap();
        assert!(certs.set(&issued.cert.pem(), &other.signing_key.serialize_pem()).is_err());
        assert!(certs.set("", &issued.signing_key.serialize_pem()).is_err());
        assert!(certs.has_certificate());
    }

    #[test]
    fn challenge_certificates_come_and_go() {
        let certs = Certificates::new(&["kalzit.example.com".into()]).unwrap();
        certs.add_challenge("Kalzit.Example.com", &[7u8; 32]).unwrap();
        assert!(certs.lock_challenges().contains_key("kalzit.example.com"));
        certs.remove_challenge("kalzit.example.com");
        assert!(certs.lock_challenges().is_empty());
    }
}
