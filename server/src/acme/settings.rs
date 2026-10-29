//! The ACME settings: which directory, which names, which challenge. They are dependent fields
//! (a directory with its CA, names with a challenge the listeners can answer), so they are saved
//! together in one explicit step and checked as a whole; each problem names its field.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::error::ApiError;

/// Let's Encrypt's production directory.
pub const LETS_ENCRYPT: &str = "https://acme-v02.api.letsencrypt.org/directory";
/// Let's Encrypt's staging directory: untrusted certificates, generous rate limits, for trying.
pub const LETS_ENCRYPT_STAGING: &str = "https://acme-staging-v02.api.letsencrypt.org/directory";
/// The most names one certificate may carry (Let's Encrypt's limit).
pub const MAX_DOMAINS: usize = 100;
/// The CA certificate of a custom directory, in PEM.
const MAX_CA_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Directory {
    #[default]
    Letsencrypt,
    LetsencryptStaging,
    /// Any other ACME directory (`directory_url`), for example an internal CA.
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Challenge {
    /// The CA fetches a token from `http://<name>/.well-known/acme-challenge/` on port 80.
    #[default]
    #[serde(rename = "http-01")]
    Http01,
    /// The CA opens a TLS connection to port 443 with the ALPN protocol `acme-tls/1`.
    #[serde(rename = "tls-alpn-01")]
    TlsAlpn01,
}

impl Challenge {
    pub fn name(self) -> &'static str {
        match self {
            Challenge::Http01 => "http-01",
            Challenge::TlsAlpn01 => "tls-alpn-01",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcmeSettings {
    pub enabled: bool,
    #[serde(default)]
    pub directory: Directory,
    /// Only for `Directory::Custom`.
    #[serde(default)]
    pub directory_url: String,
    /// PEM certificates trusted for a custom directory's HTTPS, in addition to the system's.
    #[serde(default)]
    pub directory_ca: String,
    #[serde(default)]
    pub domains: Vec<String>,
    /// Contact for expiry notices of the CA; optional.
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub challenge: Challenge,
    /// The administrator accepted the CA's terms of service.
    #[serde(default)]
    pub accept_terms: bool,
}

impl AcmeSettings {
    pub fn directory_url(&self) -> &str {
        match self.directory {
            Directory::Letsencrypt => LETS_ENCRYPT,
            Directory::LetsencryptStaging => LETS_ENCRYPT_STAGING,
            Directory::Custom => self.directory_url.trim(),
        }
    }

    /// The CA certificate to trust for the directory; only a custom directory has one.
    pub fn directory_ca(&self) -> Option<&str> {
        match self.directory {
            Directory::Custom => Some(self.directory_ca.trim()).filter(|ca| !ca.is_empty()),
            _ => None,
        }
    }

    /// Trims and lower-cases the names, drops empty and repeated ones and a trailing dot; drops
    /// what does not belong to the chosen directory.
    pub fn normalized(mut self) -> Self {
        let mut seen = std::collections::BTreeSet::new();
        self.domains = self
            .domains
            .iter()
            .map(|d| d.trim().trim_end_matches('.').to_ascii_lowercase())
            .filter(|d| !d.is_empty() && seen.insert(d.clone()))
            .collect();
        self.email = self.email.trim().to_string();
        self.directory_url = self.directory_url.trim().to_string();
        self.directory_ca = self.directory_ca.trim().to_string();
        if self.directory != Directory::Custom {
            self.directory_url.clear();
            self.directory_ca.clear();
        }
        self
    }
}

/// A problem with one field, with a reason the UI translates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    /// The field's JSON name.
    pub field: &'static str,
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl FieldError {
    pub fn new(field: &'static str, reason: &'static str, message: impl Into<String>) -> Self {
        Self { field, reason, params: BTreeMap::new(), message: message.into() }
    }

    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    pub fn into_api(self) -> ApiError {
        ApiError::validation(self.message)
            .with_field(self.field)
            .with_reason_string(self.reason.to_string(), self.params)
    }
}

/// The checks that need neither the network nor the server: each field on its own and together.
pub fn check(settings: &AcmeSettings) -> Result<(), FieldError> {
    if settings.directory == Directory::Custom {
        check_directory_url(&settings.directory_url)?;
        if !settings.directory_ca.is_empty() {
            check_ca(&settings.directory_ca)?;
        }
    }
    if settings.domains.len() > MAX_DOMAINS {
        return Err(FieldError::new(
            "domains",
            "acme.domains_too_many",
            format!("one certificate holds at most {MAX_DOMAINS} names"),
        )
        .with("max", MAX_DOMAINS));
    }
    for domain in &settings.domains {
        check_domain(domain)?;
    }
    if !settings.email.is_empty() && !is_email(&settings.email) {
        return Err(FieldError::new("email", "acme.email_invalid", "the contact is not an email address"));
    }
    if settings.enabled {
        if settings.domains.is_empty() {
            return Err(FieldError::new("domains", "acme.domains_missing", "name at least one domain"));
        }
        if !settings.accept_terms {
            return Err(FieldError::new(
                "acceptTerms",
                "acme.terms_not_accepted",
                "the CA issues certificates only when its terms of service are accepted",
            ));
        }
    }
    Ok(())
}

/// What the server's own configuration demands: an HTTPS listener without certificate files,
/// and a listener for the chosen challenge.
pub fn check_against(settings: &AcmeSettings, config: &Config) -> Result<(), FieldError> {
    if !settings.enabled {
        return Ok(());
    }
    if config.tls.cert_file.is_some() || config.tls.key_file.is_some() {
        return Err(FieldError::new(
            "enabled",
            "acme.certificate_file_set",
            "tls.cert_file and tls.key_file are set in kalzit.toml or the environment; remove them to use ACME",
        ));
    }
    if config.https_addr().is_none() {
        return Err(FieldError::new(
            "enabled",
            "acme.https_off",
            "HTTPS is off: set server.https_addr in kalzit.toml or the environment",
        ));
    }
    if settings.challenge == Challenge::Http01 && config.http_addr().is_none() {
        return Err(FieldError::new(
            "challenge",
            "acme.http_off",
            "HTTP-01 needs the HTTP listener (server.http_addr); choose TLS-ALPN-01 or turn HTTP on",
        ));
    }
    Ok(())
}

fn check_directory_url(raw: &str) -> Result<(), FieldError> {
    let invalid =
        || FieldError::new("directoryUrl", "acme.directory_url_invalid", "the directory needs an https:// address");
    let url = url::Url::parse(raw).map_err(|_| invalid())?;
    if url.scheme() != "https" || url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() {
        return Err(invalid());
    }
    Ok(())
}

fn check_ca(pem: &str) -> Result<(), FieldError> {
    use rustls::pki_types::CertificateDer;
    use rustls::pki_types::pem::PemObject;
    let invalid = || FieldError::new("directoryCa", "acme.directory_ca_invalid", "the CA certificate is not valid PEM");
    if pem.len() > MAX_CA_BYTES {
        return Err(invalid());
    }
    let certs: Vec<_> =
        CertificateDer::pem_slice_iter(pem.as_bytes()).collect::<Result<_, _>>().map_err(|_| invalid())?;
    if certs.is_empty() {
        return Err(invalid());
    }
    Ok(())
}

/// A DNS name a public CA can validate over HTTP-01 or TLS-ALPN-01: no wildcard (that needs
/// DNS-01), no address, not `localhost`, at least two labels, ASCII (an international name in
/// its `xn--` form).
pub fn check_domain(domain: &str) -> Result<(), FieldError> {
    let invalid =
        |reason: &'static str, message: &str| FieldError::new("domains", reason, message).with("domain", domain);
    if domain.starts_with("*.") {
        return Err(invalid("acme.domain_wildcard", "wildcard names need DNS-01, which Kalzit does not offer"));
    }
    if crate::datasources::targets::parse_ip_literal(domain).is_some() {
        return Err(invalid("acme.domain_address", "certificates are for names, not addresses"));
    }
    let plain = domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.');
    let labels_ok = domain.split('.').all(|l| !l.is_empty() && !l.starts_with('-') && !l.ends_with('-'));
    if !plain
        || !labels_ok
        || !domain.contains('.')
        || !crate::datasources::targets::is_host_name(domain)
        || domain == "localhost"
        || domain.ends_with(".localhost")
    {
        return Err(invalid("acme.domain_invalid", "not a public DNS name"));
    }
    Ok(())
}

fn is_email(text: &str) -> bool {
    let Some((local, domain)) = text.rsplit_once('@') else { return false };
    !local.is_empty()
        && local.len() <= 64
        && !local.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, ',' | ';' | '<' | '>' | '@'))
        && domain.contains('.')
        && crate::datasources::targets::is_host_name(domain)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(domains: &[&str]) -> AcmeSettings {
        AcmeSettings {
            enabled: true,
            domains: domains.iter().map(|d| d.to_string()).collect(),
            accept_terms: true,
            ..Default::default()
        }
    }

    fn reason(settings: &AcmeSettings) -> Option<(&'static str, &'static str)> {
        check(settings).err().map(|e| (e.field, e.reason))
    }

    #[test]
    fn names_are_normalized() {
        let s = on(&[" Kalzit.Example.com. ", "kalzit.example.com", "", "b.example.org"]).normalized();
        assert_eq!(s.domains, ["kalzit.example.com", "b.example.org"]);
    }

    #[test]
    fn names_a_public_ca_cannot_validate_are_refused() {
        assert_eq!(reason(&on(&["kalzit.example.com"])), None);
        assert_eq!(reason(&on(&["xn--bcher-kva.example"])), None);
        assert_eq!(reason(&on(&["*.example.com"])), Some(("domains", "acme.domain_wildcard")));
        assert_eq!(reason(&on(&["192.0.2.1"])), Some(("domains", "acme.domain_address")));
        assert_eq!(reason(&on(&["[2001:db8::1]"])), Some(("domains", "acme.domain_address")));
        for bad in ["localhost", "a.localhost", "intranet", "bad_name.example", "-a.example", "a..example", "bücher.de"]
        {
            assert_eq!(reason(&on(&[bad])), Some(("domains", "acme.domain_invalid")), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_DOMAINS).map(|i| format!("n{i}.example.com")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(reason(&on(&refs)), Some(("domains", "acme.domains_too_many")));
    }

    #[test]
    fn turning_on_needs_names_and_the_terms() {
        assert_eq!(reason(&on(&[])), Some(("domains", "acme.domains_missing")));
        let mut s = on(&["kalzit.example.com"]);
        s.accept_terms = false;
        assert_eq!(reason(&s), Some(("acceptTerms", "acme.terms_not_accepted")));
        // Off, the fields may be incomplete.
        s.enabled = false;
        s.domains.clear();
        assert_eq!(reason(&s), None);
    }

    #[test]
    fn contact_and_custom_directory_are_checked() {
        let mut s = on(&["kalzit.example.com"]);
        s.email = "ops@example.com".into();
        assert_eq!(reason(&s), None);
        for bad in ["ops", "ops@", "ops@localhost", "a b@example.com", "a@b@example.com"] {
            s.email = bad.into();
            assert_eq!(reason(&s), Some(("email", "acme.email_invalid")), "{bad}");
        }
        s.email.clear();
        s.directory = Directory::Custom;
        for bad in ["", "http://ca.example/dir", "ftp://ca.example", "https://", "https://user@ca.example/dir"] {
            s.directory_url = bad.into();
            assert_eq!(reason(&s), Some(("directoryUrl", "acme.directory_url_invalid")), "{bad}");
        }
        s.directory_url = "https://ca.internal.example:9000/acme/acme/directory".into();
        assert_eq!(reason(&s), None);
        assert_eq!(s.directory_url(), "https://ca.internal.example:9000/acme/acme/directory");
        s.directory_ca = "not a certificate".into();
        assert_eq!(reason(&s), Some(("directoryCa", "acme.directory_ca_invalid")));
        let ca = rcgen::generate_simple_self_signed(vec!["ca.internal.example".into()]).unwrap();
        s.directory_ca = ca.cert.pem();
        assert_eq!(reason(&s), None);
        assert!(s.directory_ca().is_some());
        // Switching back to Let's Encrypt forgets the custom fields.
        s.directory = Directory::Letsencrypt;
        let s = s.normalized();
        assert_eq!((s.directory_url.as_str(), s.directory_ca.as_str(), s.directory_url()), ("", "", LETS_ENCRYPT));
    }

    #[test]
    fn the_server_must_have_the_listeners_the_challenge_needs() {
        let mut config = Config::default();
        config.server.https_addr = String::new();
        let s = on(&["kalzit.example.com"]);
        assert_eq!(check_against(&s, &config).unwrap_err().reason, "acme.https_off");
        config.server.https_addr = "0.0.0.0:443".into();
        config.server.http_addr = String::new();
        assert_eq!(check_against(&s, &config).unwrap_err().reason, "acme.http_off");
        let mut alpn = s.clone();
        alpn.challenge = Challenge::TlsAlpn01;
        assert_eq!(check_against(&alpn, &config), Ok(()));
        config.server.http_addr = "0.0.0.0:80".into();
        assert_eq!(check_against(&s, &config), Ok(()));
        config.tls.cert_file = Some("cert.pem".into());
        assert_eq!(check_against(&s, &config).unwrap_err().reason, "acme.certificate_file_set");
        let mut off = s;
        off.enabled = false;
        assert_eq!(check_against(&off, &config), Ok(()));
    }

    #[test]
    fn stored_settings_read_back() {
        let s = on(&["kalzit.example.com"]);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["challenge"], "http-01");
        assert_eq!(json["directory"], "letsencrypt");
        assert_eq!(serde_json::from_value::<AcmeSettings>(json).unwrap(), s);
        assert!(serde_json::from_str::<AcmeSettings>(r#"{"enabled":true,"other":1}"#).is_err());
    }
}
