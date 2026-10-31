//! LDAP and Active Directory (docs/api/sso.md, "LDAP and Active Directory"): the provider's
//! settings, the connection (LDAPS or StartTLS, plain only to this computer or a private network),
//! the search for a person with the service account, the bind as that person, and their groups.
//!
//! Every value that goes into a filter is escaped (RFC 4515, `escape_filter`); an empty password
//! never reaches a bind, since servers take it as an unauthenticated bind that "succeeds".

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ldap3::adapters::{Adapter, EntriesOnly, PagedResults};
use ldap3::{Ldap, LdapConnAsync, LdapConnSettings, LdapError, Scope, SearchEntry, SearchOptions, StdStream};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::datasources::targets::{ResolveError, TargetPolicy};

/// Opening a connection (TCP, and TLS or StartTLS) may take this long.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// One operation (bind, search, one page of a search) may take this long.
pub const OP_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections to all directories at once; more wait `CONNECTION_WAIT`, then fail as busy.
pub const MAX_CONNECTIONS: usize = 16;
/// Connections of syncs at once, apart from `MAX_CONNECTIONS`.
pub const MAX_SYNC_CONNECTIONS: usize = 4;
/// Reading every entry of a sync (`Directory::search_all`) may take this long in all.
pub const SEARCH_ALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
pub const CONNECTION_WAIT: Duration = Duration::from_secs(5);
/// The field of the bind password among a provider's secrets.
pub const BIND_PASSWORD: &str = "bind_password";
/// LDAP_MATCHING_RULE_IN_CHAIN: Active Directory follows group memberships through groups.
pub const IN_CHAIN: &str = "1.2.840.113556.1.4.1941";
/// `userAccountControl` flag ACCOUNTDISABLE.
const UAC_DISABLED: u64 = 0x2;
/// Entries one sync reads at most; a directory with more is not synced (the run fails).
pub const MAX_SYNC_ENTRIES: usize = 200_000;
const PAGE_SIZE: i32 = 500;
const MAX_DN_CHARS: usize = 1024;
const MAX_FILTER_CHARS: usize = 1024;
const RESULT_SUCCESS: u32 = 0;
const RESULT_SIZE_LIMIT: u32 = 4;
const RESULT_NO_SUCH_OBJECT: u32 = 32;
const RESULT_INVALID_CREDENTIALS: u32 = 49;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Flavor {
    Ad,
    Ldap,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encryption {
    Ldaps,
    Starttls,
    None,
}

impl Encryption {
    pub fn label(self) -> Option<&'static str> {
        match self {
            Encryption::Ldaps => Some("LDAPS"),
            Encryption::Starttls => Some("StartTLS"),
            Encryption::None => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Certificate {
    System,
    Custom,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Schedule {
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "every6h")]
    Every6h,
    #[serde(rename = "off")]
    Off,
}

/// A provider's settings as stored in `sso_providers.config` (without the bind password).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LdapConfig {
    pub flavor: Flavor,
    pub url: String,
    pub encryption: Encryption,
    pub certificate: Certificate,
    pub ca_pem: Option<String>,
    pub bind_dn: String,
    pub user_base_dn: String,
    pub login_attribute: String,
    pub user_filter: String,
    pub group_base_dn: String,
    pub nested_groups: bool,
    pub email_attribute: String,
    pub name_attribute: String,
    pub trust_email: bool,
    pub sync_schedule: Schedule,
    pub sync_hour: u8,
    pub sync_threshold: u8,
}

/// The issuer of identities linked through an LDAP provider: their subjects are the entries'
/// stable ids (`objectGUID`, `entryUUID`), unique in every directory.
pub const ISSUER: &str = "ldap";

impl LdapConfig {
    /// The attribute with the entry's stable id.
    pub fn id_attribute(&self) -> &'static str {
        match self.flavor {
            Flavor::Ad => "objectGUID",
            Flavor::Ldap => "entryUUID",
        }
    }

    pub fn group_base(&self) -> &str {
        if self.group_base_dn.is_empty() { &self.user_base_dn } else { &self.group_base_dn }
    }

    /// The filters every person entry matches, to be put inside an `(&…)`.
    fn person_class(&self) -> &'static str {
        match self.flavor {
            Flavor::Ad => "(objectCategory=person)(objectClass=user)",
            Flavor::Ldap => "(objectClass=person)",
        }
    }

    /// Every person below the base DN that passes the filter.
    pub fn people_filter(&self) -> String {
        format!("(&{}{})", self.person_class(), self.user_filter)
    }

    /// The person signing in as `typed`: the login attribute, and for an address (with `@`) also
    /// the email attribute and, in Active Directory, `userPrincipalName`. `DOMAIN\name` is `name`
    /// for `sAMAccountName`.
    pub fn login_filter(&self, typed: &str) -> String {
        let mut login = typed.trim();
        if self.flavor == Flavor::Ad
            && self.login_attribute.eq_ignore_ascii_case("sAMAccountName")
            && let Some((_, name)) = login.rsplit_once('\\')
        {
            login = name;
        }
        let value = escape_filter(login);
        let mut alternatives = vec![format!("({}={value})", self.login_attribute)];
        if login.contains('@') {
            if self.flavor == Flavor::Ad && !self.login_attribute.eq_ignore_ascii_case("userPrincipalName") {
                alternatives.push(format!("(userPrincipalName={value})"));
            }
            if !self.login_attribute.eq_ignore_ascii_case(&self.email_attribute) {
                alternatives.push(format!("({}={value})", self.email_attribute));
            }
        }
        let who = match alternatives.as_slice() {
            [one] => one.clone(),
            many => format!("(|{})", many.concat()),
        };
        format!("(&{}{who}{})", self.person_class(), self.user_filter)
    }

    /// The groups of the entry `dn` (whose `uid` is `uid`) below the group base: Active Directory
    /// follows nested groups with LDAP_MATCHING_RULE_IN_CHAIN; other directories have
    /// `groupOfNames`, `groupOfUniqueNames` and `posixGroup`.
    pub fn groups_filter(&self, dn: &str, uid: Option<&str>) -> String {
        let dn = escape_filter(dn);
        match self.flavor {
            Flavor::Ad => format!("(&(objectClass=group)(member:{IN_CHAIN}:={dn}))"),
            Flavor::Ldap => {
                let posix = uid.map(|u| format!("(memberUid={})", escape_filter(u))).unwrap_or_default();
                format!("(|(member={dn})(uniqueMember={dn}){posix})")
            }
        }
    }

    /// The attributes read of a person.
    pub fn person_attributes(&self) -> Vec<String> {
        let mut attrs = vec![
            self.id_attribute().to_string(),
            self.login_attribute.clone(),
            self.email_attribute.clone(),
            self.name_attribute.clone(),
            "uid".to_string(),
        ];
        if self.flavor == Flavor::Ad {
            attrs.extend(["userAccountControl".to_string(), "memberOf".to_string(), "sAMAccountName".to_string()]);
        }
        attrs.dedup();
        attrs
    }

    /// Whether `other` connects in the same way, so a stored bind password may go with it.
    pub fn same_connection(&self, other: &LdapConfig) -> bool {
        // Also the encryption and the certificates trusted: a weaker connection must bring the
        // password again, so it never goes out over a connection it was not given for.
        self.url == other.url
            && self.bind_dn == other.bind_dn
            && self.encryption == other.encryption
            && self.certificate == other.certificate
            && self.ca_pem == other.ca_pem
    }
}

// ---------------------------------------------------------------------------------------------
// Escaping and checks of what admins type

/// Escapes a value for an LDAP filter (RFC 4515, section 3): `*`, `(`, `)`, `\` and NUL become
/// `\2a`, `\28`, `\29`, `\5c` and `\00`, so typed text is always compared as a value and never
/// widens the filter.
pub fn escape_filter(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\\' => out.push_str("\\5c"),
            '\0' => out.push_str("\\00"),
            c => out.push(c),
        }
    }
    out
}

/// Whether `dn` looks like a DN: 1 to 1024 characters without control characters, every
/// comma-separated part (escaped commas kept) an `attribute=value`.
pub fn valid_dn(dn: &str) -> bool {
    if dn.is_empty() || dn.chars().count() > MAX_DN_CHARS || dn.chars().any(char::is_control) {
        return false;
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for c in dn.chars() {
        if escaped {
            current.push(c);
            escaped = false;
        } else if c == '\\' {
            current.push(c);
            escaped = true;
        } else if c == ',' {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    if escaped {
        return false;
    }
    parts.push(current);
    parts.iter().all(|p| {
        p.split_once('=').is_some_and(|(attr, value)| {
            let attr = attr.trim();
            !attr.is_empty()
                && !value.trim().is_empty()
                && attr.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        })
    })
}

/// An extra filter: empty, or one parenthesized filter the LDAP library can read.
pub fn valid_filter(filter: &str) -> bool {
    filter.is_empty()
        || (filter.chars().count() <= MAX_FILTER_CHARS
            && filter.starts_with('(')
            && filter.ends_with(')')
            && !filter.chars().any(char::is_control)
            && ldap3::parse_filter(filter).is_ok())
}

/// An attribute name: 1 to 64 of letters, digits and `-`, starting with a letter.
pub fn valid_attribute(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The login attributes a flavor offers.
pub fn login_attributes(flavor: Flavor) -> &'static [&'static str] {
    match flavor {
        Flavor::Ad => &["sAMAccountName", "userPrincipalName", "mail"],
        Flavor::Ldap => &["uid", "mail", "cn"],
    }
}

/// Why a URL or its encryption cannot be used: `(field, reason)`.
pub fn check_url(url: &str, encryption: Encryption) -> Result<(), (&'static str, &'static str)> {
    let invalid = ("url", "ldap.url_invalid");
    let parsed = url::Url::parse(url).map_err(|_| invalid)?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "ldap" | "ldaps")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || url.chars().any(char::is_control)
        || url.len() > 512
    {
        return Err(invalid);
    }
    match (scheme, encryption) {
        ("ldaps", Encryption::Ldaps) | ("ldap", Encryption::Starttls | Encryption::None) => Ok(()),
        _ => Err(("encryption", "ldap.scheme_conflict")),
    }
}

/// The certificates of `pem`, refused when there is none or one cannot be read.
pub fn read_ca(pem: &str) -> Result<Vec<rustls::pki_types::CertificateDer<'static>>, String> {
    use rustls::pki_types::pem::PemObject;
    let mut out = Vec::new();
    for cert in rustls::pki_types::CertificateDer::pem_slice_iter(pem.as_bytes()) {
        out.push(cert.map_err(|e| format!("the CA certificate is not valid PEM: {e}"))?);
    }
    if out.is_empty() {
        return Err("no certificate in the PEM text".into());
    }
    Ok(out)
}

fn tls_config(config: &LdapConfig) -> Result<rustls::ClientConfig, LdapFail> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| LdapFail::Tls(e.to_string()))?;
    let mut roots = rustls::RootCertStore::empty();
    match config.certificate {
        Certificate::System => {
            let native = rustls_native_certs::load_native_certs();
            for e in &native.errors {
                tracing::warn!("reading the platform's certificates: {e}");
            }
            roots.add_parsable_certificates(native.certs);
        }
        Certificate::Custom => {
            for cert in read_ca(config.ca_pem.as_deref().unwrap_or_default()).map_err(LdapFail::Certificate)? {
                roots.add(cert).map_err(|e| LdapFail::Certificate(e.to_string()))?;
            }
        }
    }
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

// ---------------------------------------------------------------------------------------------
// Failures

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LdapFail {
    #[error("the directory cannot be reached: {0}")]
    Unreachable(String),
    #[error("the directory did not answer within 10 seconds")]
    Timeout,
    #[error("the address is refused: {0}")]
    Refused(String),
    #[error("an unencrypted connection is allowed only to this computer or a private network")]
    PlainNotAllowed,
    #[error("the certificate is not trusted: {0}")]
    Certificate(String),
    #[error("TLS failed: {0}")]
    Tls(String),
    #[error("the bind was refused ({code}): {text}")]
    Bind { code: u32, text: String },
    #[error("an empty password is never sent")]
    EmptyPassword,
    #[error("no such entry")]
    NoSuchObject,
    #[error("the search failed ({code}): {text}")]
    Search { code: u32, text: String },
    #[error("too many directory connections at once")]
    Busy,
    #[error("{0}")]
    Other(String),
}

impl LdapFail {
    /// The cause recorded in the audit log for a failure at sign-in.
    pub fn cause(&self) -> &'static str {
        match self {
            LdapFail::Bind { .. } | LdapFail::EmptyPassword => "ldap.service_bind_failed",
            LdapFail::Search { .. } | LdapFail::NoSuchObject => "ldap.search_failed",
            _ => "ldap.unreachable",
        }
    }
}

/// A server's diagnostic text, short and printable (Active Directory's says `data 52e` for a
/// wrong password).
fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(300).collect::<String>().trim().to_string()
}

/// The server's text for result code `rc`, or the code's name (RFC 4511, appendix A) when the
/// server sent none, as OpenLDAP does for a wrong password.
fn result_text(rc: u32, text: &str) -> String {
    let text = clean(text);
    if !text.is_empty() {
        return text;
    }
    match rc {
        8 => "strongerAuthRequired",
        32 => "noSuchObject",
        48 => "inappropriateAuthentication",
        49 => "invalidCredentials",
        50 => "insufficientAccessRights",
        51 => "busy",
        52 => "unavailable",
        53 => "unwillingToPerform",
        _ => "",
    }
    .to_string()
}

fn fail(e: LdapError) -> LdapFail {
    match e {
        LdapError::Timeout { .. } => LdapFail::Timeout,
        LdapError::LdapResult { result } => {
            if result.rc == RESULT_NO_SUCH_OBJECT {
                LdapFail::NoSuchObject
            } else {
                LdapFail::Search { code: result.rc, text: result_text(result.rc, &result.text) }
            }
        }
        other => {
            let text = clean(&other.to_string());
            let lower = text.to_ascii_lowercase();
            if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("notvalidforname") {
                LdapFail::Certificate(text)
            } else if lower.contains("tls") || lower.contains("handshake") || lower.contains("rustls") {
                LdapFail::Tls(text)
            } else {
                LdapFail::Unreachable(text)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Connections

/// Opens connections to directories under the target rules of providers, at most
/// `MAX_CONNECTIONS` at once.
#[derive(Clone)]
pub struct Connector {
    pub policy: Arc<TargetPolicy>,
    /// Kalzit's own ports on this computer, which are never a directory.
    pub own_ports: Vec<u16>,
    pub limit: Arc<Semaphore>,
}

/// An open connection; the slot of `Connector::limit` is given back when it is dropped.
pub struct Directory {
    ldap: Ldap,
    _slot: OwnedSemaphorePermit,
}

/// One person as read from the directory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DirEntry {
    pub dn: String,
    pub id: Option<String>,
    pub login: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub uid: Option<String>,
    /// Disabled in Active Directory (`userAccountControl`).
    pub disabled: bool,
    /// Direct groups (`memberOf`, Active Directory).
    pub member_of: Vec<String>,
}

fn first<'a>(entry: &'a SearchEntry, name: &str) -> Option<&'a str> {
    entry
        .attrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .and_then(|(_, v)| v.first())
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

fn all(entry: &SearchEntry, name: &str) -> Vec<String> {
    entry.attrs.iter().filter(|(k, _)| k.eq_ignore_ascii_case(name)).flat_map(|(_, v)| v.iter().cloned()).collect()
}

/// An `objectGUID` in its usual form (`{...}` without braces): the first three groups are stored
/// little-endian.
pub fn guid_string(bytes: &[u8]) -> Option<String> {
    let b: [u8; 16] = bytes.try_into().ok()?;
    Some(format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    ))
}

impl DirEntry {
    pub fn read(config: &LdapConfig, entry: &SearchEntry) -> DirEntry {
        let id = match config.flavor {
            Flavor::Ad => {
                let binary = entry
                    .bin_attrs
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("objectGUID"))
                    .and_then(|(_, v)| v.first().cloned())
                    // Sixteen bytes that happen to be UTF-8 arrive as text.
                    .or_else(|| first(entry, "objectGUID").map(|s| s.as_bytes().to_vec()));
                binary.as_deref().and_then(guid_string)
            }
            Flavor::Ldap => first(entry, "entryUUID").map(|s| s.to_ascii_lowercase()),
        };
        let uac = first(entry, "userAccountControl").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
        let text = |name: &str| first(entry, name).map(|v| v.chars().filter(|c| !c.is_control()).take(256).collect());
        DirEntry {
            dn: entry.dn.clone(),
            id,
            login: text(&config.login_attribute),
            email: text(&config.email_attribute),
            name: text(&config.name_attribute),
            uid: text("uid"),
            disabled: config.flavor == Flavor::Ad && uac & UAC_DISABLED != 0,
            member_of: all(entry, "memberOf"),
        }
    }
}

impl Connector {
    /// Connects to `config`'s server: the address checked by the target rules (and, for an
    /// unencrypted connection, private), TLS or StartTLS set up, nothing bound yet.
    pub async fn open(&self, config: &LdapConfig) -> Result<Directory, LdapFail> {
        let slot = tokio::time::timeout(CONNECTION_WAIT, self.limit.clone().acquire_owned())
            .await
            .map_err(|_| LdapFail::Busy)?
            .map_err(|_| LdapFail::Busy)?;
        let url = url::Url::parse(&config.url).map_err(|e| LdapFail::Other(e.to_string()))?;
        let port = url.port().unwrap_or(if url.scheme() == "ldaps" { 636 } else { 389 });
        let host = match url.host() {
            Some(url::Host::Domain(d)) => d.to_string(),
            Some(url::Host::Ipv4(ip)) => ip.to_string(),
            Some(url::Host::Ipv6(ip)) => ip.to_string(),
            None => return Err(LdapFail::Other("the URL has no host".into())),
        };
        let addrs = self.policy.resolve_all(&host, port).await.map_err(|e| match e {
            ResolveError::Blocked(b) => LdapFail::Refused(b.0.message.clone()),
            other => LdapFail::Unreachable(other.detail().message),
        })?;
        if config.encryption == Encryption::None && !addrs.iter().all(|a| crate::http::LocalGuard::is_private(a.ip())) {
            return Err(LdapFail::PlainNotAllowed);
        }
        if addrs.iter().any(|a| own_endpoint(a, &self.own_ports)) {
            return Err(LdapFail::Refused(format!("{host}:{port} is Kalzit itself")));
        }
        // One deadline for all addresses of the name, so a name with many addresses that never
        // answer cannot hold the sign-in longer than one connection would.
        let deadline = tokio::time::Instant::now() + CONNECT_TIMEOUT;
        let mut last = LdapFail::Unreachable(format!("{host}:{port} cannot be reached"));
        let mut stream = None;
        for addr in &addrs {
            if tokio::time::Instant::now() >= deadline {
                last = LdapFail::Timeout;
                break;
            }
            match tokio::time::timeout_at(deadline, tokio::net::TcpStream::connect(addr)).await {
                Ok(Ok(s)) => {
                    stream = Some(s);
                    break;
                }
                Ok(Err(e)) => last = LdapFail::Unreachable(format!("{host}:{port}: {e}")),
                Err(_) => last = LdapFail::Timeout,
            }
        }
        let stream = stream.ok_or(last)?.into_std().map_err(|e| LdapFail::Unreachable(e.to_string()))?;
        let mut settings = LdapConnSettings::new()
            .set_conn_timeout(CONNECT_TIMEOUT)
            .set_std_stream(StdStream::Tcp(stream))
            .set_starttls(config.encryption == Encryption::Starttls);
        if config.encryption != Encryption::None {
            settings = settings.set_config(Arc::new(tls_config(config)?));
        }
        let (conn, ldap) = LdapConnAsync::from_url_with_settings(settings, &url).await.map_err(fail)?;
        tokio::spawn(async move {
            if let Err(e) = conn.drive().await {
                tracing::debug!("LDAP connection ended: {e}");
            }
        });
        Ok(Directory { ldap, _slot: slot })
    }
}

fn own_endpoint(addr: &SocketAddr, own_ports: &[u16]) -> bool {
    addr.ip().to_canonical().is_loopback() && own_ports.contains(&addr.port())
}

impl Directory {
    /// A simple bind. An empty DN or password is refused here: it would be an anonymous or
    /// unauthenticated bind (RFC 4513, 5.1.2), which servers answer with success.
    pub async fn bind(&mut self, dn: &str, password: &str) -> Result<(), LdapFail> {
        if dn.is_empty() || password.is_empty() {
            return Err(LdapFail::EmptyPassword);
        }
        let result = self.ldap.with_timeout(OP_TIMEOUT).simple_bind(dn, password).await.map_err(fail)?;
        if result.rc != RESULT_SUCCESS {
            return Err(LdapFail::Bind { code: result.rc, text: result_text(result.rc, &result.text) });
        }
        Ok(())
    }

    /// A search of at most `limit` entries; more is not an error, the first ones are answered.
    pub async fn search(
        &mut self,
        base: &str,
        scope: Scope,
        filter: &str,
        attrs: &[String],
        limit: i32,
    ) -> Result<Vec<SearchEntry>, LdapFail> {
        let options = SearchOptions::new().sizelimit(limit).timelimit(OP_TIMEOUT.as_secs() as i32);
        let result = self
            .ldap
            .with_search_options(options)
            .with_timeout(OP_TIMEOUT)
            .search(base, scope, filter, attrs.to_vec())
            .await
            .map_err(fail)?;
        let (entries, res) = (result.0, result.1);
        match res.rc {
            RESULT_SUCCESS | RESULT_SIZE_LIMIT => Ok(entries.into_iter().map(SearchEntry::construct).collect()),
            RESULT_NO_SUCH_OBJECT => Err(LdapFail::NoSuchObject),
            code => Err(LdapFail::Search { code, text: result_text(code, &res.text) }),
        }
    }

    /// Every entry of a subtree search, in pages of 500 (RFC 2696), at most `MAX_SYNC_ENTRIES`.
    pub async fn search_all(
        &mut self,
        base: &str,
        filter: &str,
        attrs: &[String],
    ) -> Result<Vec<SearchEntry>, LdapFail> {
        let adapters: Vec<Box<dyn Adapter<'_, String, Vec<String>>>> =
            vec![Box::new(EntriesOnly::new()), Box::new(PagedResults::new(PAGE_SIZE))];
        let mut stream = self
            .ldap
            .with_timeout(OP_TIMEOUT)
            .streaming_search_with(adapters, base, Scope::Subtree, filter, attrs.to_vec())
            .await
            .map_err(fail)?;
        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + SEARCH_ALL_TIMEOUT;
        loop {
            let wait = deadline.min(tokio::time::Instant::now() + OP_TIMEOUT);
            let next = tokio::time::timeout_at(wait, stream.next()).await.map_err(|_| LdapFail::Timeout)?;
            match next.map_err(fail)? {
                Some(entry) => {
                    if out.len() >= MAX_SYNC_ENTRIES {
                        let _ = stream.finish().await;
                        return Err(LdapFail::Other(format!("more than {MAX_SYNC_ENTRIES} entries below the base DN")));
                    }
                    out.push(SearchEntry::construct(entry));
                }
                None => break,
            }
        }
        let res = stream.finish().await;
        match res.rc {
            RESULT_SUCCESS => Ok(out),
            RESULT_NO_SUCH_OBJECT => Err(LdapFail::NoSuchObject),
            code => Err(LdapFail::Search { code, text: result_text(code, &res.text) }),
        }
    }

    /// Whether the entry `dn` exists (readable for the bound account).
    pub async fn exists(&mut self, dn: &str) -> Result<bool, LdapFail> {
        match self.search(dn, Scope::Base, "(objectClass=*)", &["1.1".to_string()], 1).await {
            Ok(_) => Ok(true),
            Err(LdapFail::NoSuchObject) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// The people that `typed` names (at most a few).
    pub async fn find(&mut self, config: &LdapConfig, typed: &str) -> Result<Vec<DirEntry>, LdapFail> {
        let attrs = config.person_attributes();
        let entries = self.search(&config.user_base_dn, Scope::Subtree, &config.login_filter(typed), &attrs, 2).await?;
        Ok(entries.iter().map(|e| DirEntry::read(config, e)).collect())
    }

    /// The groups of `entry` (DNs).
    pub async fn groups(&mut self, config: &LdapConfig, entry: &DirEntry) -> Result<Vec<String>, LdapFail> {
        let mut groups = if config.flavor == Flavor::Ad { entry.member_of.clone() } else { Vec::new() };
        if config.flavor == Flavor::Ldap || config.nested_groups {
            let filter = config.groups_filter(&entry.dn, entry.uid.as_deref());
            let found = self.search(config.group_base(), Scope::Subtree, &filter, &["1.1".to_string()], 1000).await?;
            groups.extend(found.into_iter().map(|e| e.dn));
        }
        Ok(dedup_groups(groups))
    }

    pub async fn close(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(2), self.ldap.unbind()).await;
    }
}

/// Groups once each, compared without regard to case (DNs are case-insensitive).
pub fn dedup_groups(groups: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    groups.into_iter().filter(|g| seen.insert(g.to_lowercase())).collect()
}

/// The groups in the spelling of the provider's mappings where a mapping names them in another
/// case, so a mapping matches whichever case the directory answers with.
pub fn spell_as_mapped(groups: Vec<String>, mapped: &[String]) -> Vec<String> {
    groups.into_iter().map(|g| mapped.iter().find(|m| m.eq_ignore_ascii_case(&g)).cloned().unwrap_or(g)).collect()
}

/// Binds as `dn` with `password` on a connection of its own: `Ok(true)` when the directory takes
/// the password, `Ok(false)` when it refuses the credentials.
pub async fn verify_password(
    connector: &Connector,
    config: &LdapConfig,
    dn: &str,
    password: &str,
) -> Result<bool, LdapFail> {
    if password.is_empty() {
        return Ok(false);
    }
    let mut dir = connector.open(config).await?;
    let outcome = match dir.bind(dn, password).await {
        Ok(()) => Ok(true),
        // Invalid credentials, and in Active Directory also an expired or locked account
        // (`data 532`, `775`) or a password that must change (`773`).
        Err(LdapFail::Bind { code, .. }) if code == RESULT_INVALID_CREDENTIALS => Ok(false),
        Err(LdapFail::Bind { .. }) => Ok(false),
        Err(e) => Err(e),
    };
    dir.close().await;
    outcome
}

/// A connection bound with the service account.
pub async fn service(connector: &Connector, config: &LdapConfig, password: &str) -> Result<Directory, LdapFail> {
    let mut dir = connector.open(config).await?;
    dir.bind(&config.bind_dn, password).await?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn config(flavor: Flavor) -> LdapConfig {
        LdapConfig {
            flavor,
            url: "ldaps://dc01.example:636".into(),
            encryption: Encryption::Ldaps,
            certificate: Certificate::System,
            ca_pem: None,
            bind_dn: "CN=svc,DC=example".into(),
            user_base_dn: "OU=People,DC=example".into(),
            login_attribute: if flavor == Flavor::Ad { "sAMAccountName".into() } else { "uid".into() },
            user_filter: String::new(),
            group_base_dn: String::new(),
            nested_groups: false,
            email_attribute: "mail".into(),
            name_attribute: "cn".into(),
            trust_email: true,
            sync_schedule: Schedule::Daily,
            sync_hour: 2,
            sync_threshold: 10,
        }
    }

    #[test]
    fn filter_values_are_escaped() {
        assert_eq!(escape_filter("anna"), "anna");
        assert_eq!(escape_filter("*"), "\\2a");
        assert_eq!(escape_filter("a)(uid=*"), "a\\29\\28uid=\\2a");
        assert_eq!(escape_filter("C:\\x\0"), "C:\\5cx\\00");
        assert_eq!(escape_filter("Jörg Müller"), "Jörg Müller");
        // Every special character goes, so the typed text can never close or widen the filter.
        let hostile = "*)(|(objectClass=*))(&(uid=";
        let escaped = escape_filter(hostile);
        assert!(!escaped.contains(['(', ')', '*']), "{escaped}");
        assert!(ldap3::parse_filter(format!("(uid={escaped})")).is_ok());
    }

    #[test]
    fn login_filters_never_widen() {
        let ad = config(Flavor::Ad);
        assert_eq!(
            ad.login_filter("e.schroeder"),
            "(&(objectCategory=person)(objectClass=user)(sAMAccountName=e.schroeder))"
        );
        assert_eq!(ad.login_filter("ZENTRALE\\e.schroeder"), ad.login_filter("e.schroeder"));
        assert_eq!(
            ad.login_filter("e.schroeder@zentrale.example"),
            "(&(objectCategory=person)(objectClass=user)(|(sAMAccountName=e.schroeder@zentrale.example)\
             (userPrincipalName=e.schroeder@zentrale.example)(mail=e.schroeder@zentrale.example)))"
        );
        let ldap = LdapConfig { user_filter: "(departmentNumber=7)".into(), ..config(Flavor::Ldap) };
        assert_eq!(ldap.login_filter("*"), "(&(objectClass=person)(uid=\\2a)(departmentNumber=7))");
        assert_eq!(ldap.login_filter(" anna "), "(&(objectClass=person)(uid=anna)(departmentNumber=7))");
        for typed in ["*", "a*", "*)(uid=*", "\\", "x)(|(uid=*)"] {
            assert!(ldap3::parse_filter(ldap.login_filter(typed)).is_ok(), "{typed}");
        }
    }

    #[test]
    fn group_filters_escape_the_dn() {
        let mut ad = config(Flavor::Ad);
        ad.nested_groups = true;
        assert_eq!(
            ad.groups_filter("CN=Müller\\, Jörg,OU=People,DC=example", None),
            "(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=CN=Müller\\5c, Jörg,OU=People,DC=example))"
        );
        let ldap = config(Flavor::Ldap);
        assert_eq!(
            ldap.groups_filter("uid=a*,ou=people", Some("a*")),
            "(|(member=uid=a\\2a,ou=people)(uniqueMember=uid=a\\2a,ou=people)(memberUid=a\\2a))"
        );
        assert!(ldap3::parse_filter(ad.groups_filter("CN=a(b),DC=x", None)).is_ok());
    }

    #[test]
    fn urls_and_encryption() {
        assert_eq!(check_url("ldaps://dc01.example:636", Encryption::Ldaps), Ok(()));
        assert_eq!(check_url("ldap://dc01.example", Encryption::Starttls), Ok(()));
        assert_eq!(check_url("ldap://127.0.0.1:3389", Encryption::None), Ok(()));
        assert_eq!(
            check_url("ldaps://dc01.example", Encryption::Starttls),
            Err(("encryption", "ldap.scheme_conflict"))
        );
        assert_eq!(check_url("ldap://dc01.example", Encryption::Ldaps), Err(("encryption", "ldap.scheme_conflict")));
        for bad in ["http://dc01", "ldap://", "ldap://u:p@dc01", "ldap://dc01/dc=x", "ldap://dc01?x", "dc01"] {
            assert_eq!(check_url(bad, Encryption::Starttls), Err(("url", "ldap.url_invalid")), "{bad}");
        }
    }

    #[test]
    fn dns_filters_and_attributes() {
        assert!(valid_dn("OU=Mitarbeitende,DC=zentrale,DC=example"));
        assert!(valid_dn("cn=admin,dc=kalzit,dc=test"));
        for bad in ["", "plain", "OU=,DC=x", "OU=a,,DC=x", "OU=a\\", "=a"] {
            assert!(!valid_dn(bad), "{bad}");
        }
        assert!(valid_filter("") && valid_filter("(department=IT)") && valid_filter("(&(a=1)(!(b=2)))"));
        for bad in ["department=IT", "(a=1", "(a=1))(", "(a=1)(b=2)"] {
            assert!(!valid_filter(bad), "{bad}");
        }
        assert!(
            valid_attribute("sAMAccountName")
                && valid_attribute("mail")
                && !valid_attribute("1x")
                && !valid_attribute("a b")
        );
    }

    #[test]
    fn guids_read_like_windows_shows_them() {
        let bytes = [0x33, 0x22, 0x11, 0x00, 0x55, 0x44, 0x77, 0x66, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
        assert_eq!(guid_string(&bytes).unwrap(), "00112233-4455-6677-8899-aabbccddeeff");
        assert_eq!(guid_string(&bytes[..15]), None);
    }

    #[test]
    fn entries_read_ad_flags_and_groups() {
        let mut entry = SearchEntry {
            dn: "CN=Greta Vogel,OU=People,DC=example".into(),
            attrs: Default::default(),
            bin_attrs: Default::default(),
        };
        entry.attrs.insert("userAccountControl".into(), vec!["514".into()]);
        entry.attrs.insert("sAMAccountName".into(), vec!["g.vogel".into()]);
        entry.attrs.insert("memberOf".into(), vec!["CN=A,DC=example".into(), "CN=B,DC=example".into()]);
        entry.bin_attrs.insert("objectGUID".into(), vec![vec![0u8; 16]]);
        let read = DirEntry::read(&config(Flavor::Ad), &entry);
        assert!(read.disabled);
        assert_eq!(read.login.as_deref(), Some("g.vogel"));
        assert_eq!(read.member_of.len(), 2);
        assert_eq!(read.id.as_deref(), Some("00000000-0000-0000-0000-000000000000"));
        // Not Active Directory: the flag means nothing.
        let read = DirEntry::read(&config(Flavor::Ldap), &entry);
        assert!(!read.disabled && read.id.is_none());
    }

    #[test]
    fn groups_match_mappings_in_any_case() {
        let groups = dedup_groups(vec!["CN=Kalzit-Leser,OU=Gruppen".into(), "cn=kalzit-leser,ou=gruppen".into()]);
        assert_eq!(groups.len(), 1);
        let spelled = spell_as_mapped(
            vec!["cn=kalzit-leser,ou=gruppen".into(), "CN=Other".into()],
            &["CN=Kalzit-Leser,OU=Gruppen".into()],
        );
        assert_eq!(spelled, vec!["CN=Kalzit-Leser,OU=Gruppen".to_string(), "CN=Other".to_string()]);
    }

    #[test]
    fn plain_connections_only_to_private_hosts() {
        use crate::http::LocalGuard;
        for private in ["127.0.0.1", "10.1.2.3", "192.168.0.10", "::1", "fd00::1"] {
            assert!(LocalGuard::is_private(private.parse().unwrap()), "{private}");
        }
        assert!(!LocalGuard::is_private("8.8.8.8".parse().unwrap()));
    }
}
