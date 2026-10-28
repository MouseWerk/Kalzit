//! The plugin catalog index: a JSON document hosted by the project and signed in the catalog
//! context (`signing::verify_catalog`). It is off by default. Each index carries a sequence
//! number and an expiry, so an attacker who controls the download can neither serve an older
//! index (rollback) nor keep serving a stale one forever (freeze).
//!
//! Sequences are counted per catalog key: `Accepted` keeps the highest sequence accepted for
//! each key, and `parse_index` takes the key whose signature verified, so a host can neither
//! compare one key's index with another key's number nor forget to name the key. The host
//! stores `Accepted` durably and calls `Accepted::record` only after it has taken the index.
//!
//! An index may revoke plugin versions (`revoked`): a host refuses to install them from the
//! catalog and shows the revocation on installed plugins it matches. The texts an entry carries
//! for browsing (description, publisher, network targets) are what the publisher says; the host
//! shows the package's own manifest before anything is approved.

use std::collections::{BTreeMap, BTreeSet};

use ed25519_dalek::VerifyingKey;
use serde::{Deserialize, Serialize};

use crate::signing::key_hex;

/// The index format this crate reads.
pub const CATALOG_FORMAT: u32 = 1;

/// Largest index accepted.
pub const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;

/// Longest validity an index may claim, so a leaked old signature cannot be served for years.
pub const MAX_VALIDITY_SECS: u64 = 31 * 24 * 3600;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogIndex {
    pub format: u32,
    /// Grows with every published index.
    pub sequence: u64,
    /// When the index was published, Unix seconds.
    pub published_at: u64,
    /// After this (Unix seconds) the index is stale and refused.
    pub expires_at: u64,
    pub plugins: Vec<CatalogEntry>,
    /// Plugin versions withdrawn by the publisher of the index (a known vulnerability, a leaked
    /// key): never installed from the catalog, shown on installed plugins they match.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub revoked: Vec<Revocation>,
}

/// Withdrawn versions of one plugin.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Revocation {
    pub id: String,
    /// A semver requirement (`*`, `<1.2.3`, `=1.0.0`): the versions withdrawn.
    pub versions: String,
    /// Why, in a short text for administrators.
    pub reason: String,
}

impl Revocation {
    /// Whether this revocation withdraws `version` of `id`. A pre-release is matched as its
    /// release (`1.5.0-rc.1` as `1.5.0`): semver requirements never match pre-releases, so `*`
    /// would otherwise miss them. A version that does not parse is withdrawn by any revocation of
    /// its id, so nothing escapes a withdrawal by its form.
    pub fn covers(&self, id: &str, version: &str) -> bool {
        if self.id != id {
            return false;
        }
        let Ok(req) = semver::VersionReq::parse(&self.versions) else { return false };
        match semver::Version::parse(version) {
            Ok(v) => req.matches(&semver::Version::new(v.major, v.minor, v.patch)),
            Err(_) => true,
        }
    }
}

impl CatalogIndex {
    /// The revocation that withdraws `version` of `id`, if any.
    pub fn revocation(&self, id: &str, version: &str) -> Option<&Revocation> {
        self.revoked.iter().find(|r| r.covers(id, version))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub version: String,
    /// `datasource` or `panel`.
    pub kind: String,
    pub name: String,
    /// `signing::key_id` of the key that signs the package (16 lowercase hex digits). It picks
    /// the trusted key; the package signature is still checked with that key in full.
    pub key_id: String,
    /// Where the package is downloaded from; `https` only.
    pub url: String,
    /// SHA-256 of the package file, lowercase hex.
    pub sha256: String,
    pub size: u64,
    /// One line about the plugin, for browsing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The publisher's name as the index states it; a neutral label, not a verified identity.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    /// The network targets the package declares, in words (`*.example.com:443`), for browsing.
    /// The host shows the package's own targets before they are approved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network: Vec<String>,
}

/// Longest description of an entry and longest reason of a revocation, in characters.
pub const MAX_TEXT_CHARS: usize = 280;

/// Most network targets an entry lists.
pub const MAX_NETWORK_ENTRIES: usize = 32;

/// The highest sequence accepted per catalog key (by its full public key in hex).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Accepted(BTreeMap<String, u64>);

impl Accepted {
    pub fn get(&self, key: &VerifyingKey) -> Option<u64> {
        self.0.get(&key_hex(key)).copied()
    }

    /// Remembers that `index`, signed by `key`, was taken.
    pub fn record(&mut self, key: &VerifyingKey, index: &CatalogIndex) {
        let entry = self.0.entry(key_hex(key)).or_insert(index.sequence);
        *entry = (*entry).max(index.sequence);
    }
}

/// Why an index is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogError {
    TooLarge,
    Invalid(String),
    FormatUnsupported(u32),
    /// Older than or as old as an index already accepted from the same key.
    Rollback {
        sequence: u64,
        accepted: u64,
    },
    Expired {
        expires_at: u64,
    },
    /// Published in the future or valid for longer than `MAX_VALIDITY_SECS`.
    ImplausibleTimes,
    /// An entry that is not well formed, with its position and why.
    Entry {
        index: usize,
        reason: &'static str,
    },
    /// A revocation that is not well formed, with its position and why.
    Revocation {
        index: usize,
        reason: &'static str,
    },
}

impl CatalogError {
    pub fn code(&self) -> &'static str {
        match self {
            CatalogError::TooLarge => "catalog.too_large",
            CatalogError::Invalid(_) => "catalog.invalid",
            CatalogError::FormatUnsupported(_) => "catalog.format_unsupported",
            CatalogError::Rollback { .. } => "catalog.rollback",
            CatalogError::Expired { .. } => "catalog.expired",
            CatalogError::ImplausibleTimes => "catalog.times_implausible",
            CatalogError::Entry { .. } => "catalog.entry_invalid",
            CatalogError::Revocation { .. } => "catalog.revocation_invalid",
        }
    }
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CatalogError::TooLarge => write!(f, "the index is larger than {MAX_INDEX_BYTES} bytes"),
            CatalogError::Invalid(e) => write!(f, "the index is not valid: {e}"),
            CatalogError::FormatUnsupported(v) => {
                write!(f, "the index has format {v}, which this Kalzit does not read")
            }
            CatalogError::Rollback { sequence, accepted } => {
                write!(f, "the index has sequence {sequence}, but {accepted} was accepted already (rollback)")
            }
            CatalogError::Expired { expires_at } => write!(f, "the index expired at {expires_at}"),
            CatalogError::ImplausibleTimes => write!(f, "the index's publication or expiry time is not plausible"),
            CatalogError::Entry { index, reason } => write!(f, "plugin entry {index} is not valid ({reason})"),
            CatalogError::Revocation { index, reason } => write!(f, "revocation {index} is not valid ({reason})"),
        }
    }
}

/// A short text for people: not empty, at most `max` characters, no control or bidirectional
/// override characters.
fn plain_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= max
        && !text.chars().any(|c| c.is_control() || crate::manifest::is_bidi_control(c))
}

fn lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An `https://` URL with a host and no whitespace, control characters or user info.
fn https_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    !authority.is_empty()
        && !authority.contains('@')
        && url.len() <= 2048
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn check_entry(entry: &CatalogEntry) -> Result<(), &'static str> {
    if !crate::manifest::valid_id(&entry.id) {
        return Err("id");
    }
    if semver::Version::parse(&entry.version).is_err() {
        return Err("version");
    }
    if !matches!(entry.kind.as_str(), "datasource" | "panel") {
        return Err("kind");
    }
    if entry.name.trim().is_empty() || entry.name.chars().count() > 64 || entry.name.chars().any(char::is_control) {
        return Err("name");
    }
    if !lower_hex(&entry.key_id, 16) {
        return Err("keyId");
    }
    if !https_url(&entry.url) {
        return Err("url");
    }
    if !lower_hex(&entry.sha256, 64) {
        return Err("sha256");
    }
    if entry.description.as_deref().is_some_and(|d| !plain_text(d, MAX_TEXT_CHARS)) {
        return Err("description");
    }
    if entry.publisher.as_deref().is_some_and(|p| !plain_text(p, 64)) {
        return Err("publisher");
    }
    let target_ok = |t: &String| plain_text(t, 255) && !t.chars().any(char::is_whitespace);
    if entry.network.len() > MAX_NETWORK_ENTRIES || !entry.network.iter().all(target_ok) {
        return Err("network");
    }
    Ok(())
}

fn check_revocation(r: &Revocation) -> Result<(), &'static str> {
    if !crate::manifest::valid_id(&r.id) {
        return Err("id");
    }
    if r.versions.len() > 128 || semver::VersionReq::parse(&r.versions).is_err() {
        return Err("versions");
    }
    if !plain_text(&r.reason, MAX_TEXT_CHARS) {
        return Err("reason");
    }
    Ok(())
}

/// Reads an index whose signature `key` has verified. `accepted` holds the highest sequences
/// taken before, `now` is the current Unix time in seconds. A refresh with the same sequence is
/// refused too: a new index always has a new number. Every entry is checked, and an id with
/// the same version twice is refused.
pub fn parse_index(
    bytes: &[u8],
    key: &VerifyingKey,
    accepted: &Accepted,
    now: u64,
) -> Result<CatalogIndex, CatalogError> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(CatalogError::TooLarge);
    }
    let index: CatalogIndex = serde_json::from_slice(bytes).map_err(|e| CatalogError::Invalid(e.to_string()))?;
    if index.format != CATALOG_FORMAT {
        return Err(CatalogError::FormatUnsupported(index.format));
    }
    if let Some(accepted) = accepted.get(key)
        && index.sequence <= accepted
    {
        return Err(CatalogError::Rollback { sequence: index.sequence, accepted });
    }
    // A few minutes of clock skew are tolerated for the publication time.
    if index.published_at > now + 300 || index.expires_at <= index.published_at {
        return Err(CatalogError::ImplausibleTimes);
    }
    if index.expires_at - index.published_at > MAX_VALIDITY_SECS {
        return Err(CatalogError::ImplausibleTimes);
    }
    if now >= index.expires_at {
        return Err(CatalogError::Expired { expires_at: index.expires_at });
    }
    let mut seen = BTreeSet::new();
    for (i, entry) in index.plugins.iter().enumerate() {
        check_entry(entry).map_err(|reason| CatalogError::Entry { index: i, reason })?;
        if !seen.insert((entry.id.as_str(), entry.version.as_str())) {
            return Err(CatalogError::Entry { index: i, reason: "repeated" });
        }
    }
    if index.revoked.len() > 4096 {
        return Err(CatalogError::Revocation { index: 4096, reason: "count" });
    }
    for (i, r) in index.revoked.iter().enumerate() {
        check_revocation(r).map_err(|reason| CatalogError::Revocation { index: i, reason })?;
    }
    Ok(index)
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn key(seed: u8) -> VerifyingKey {
        SigningKey::from_bytes(&[seed; 32]).verifying_key()
    }

    fn entry() -> CatalogEntry {
        CatalogEntry {
            id: "dev.example.redis".into(),
            version: "1.2.0".into(),
            kind: "datasource".into(),
            name: "Redis".into(),
            key_id: "0011223344556677".into(),
            url: "https://plugins.example.dev/redis-1.2.0.kalzit-plugin".into(),
            sha256: "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708".into(),
            size: 1234,
            description: None,
            publisher: None,
            network: vec![],
        }
    }

    fn index_with(sequence: u64, published_at: u64, expires_at: u64, plugins: Vec<CatalogEntry>) -> Vec<u8> {
        serde_json::to_vec(&CatalogIndex { format: 1, sequence, published_at, expires_at, plugins, revoked: vec![] })
            .unwrap()
    }

    fn index(sequence: u64, published_at: u64, expires_at: u64) -> Vec<u8> {
        index_with(sequence, published_at, expires_at, vec![entry()])
    }

    fn accepted(seq: u64) -> Accepted {
        let mut a = Accepted::default();
        let taken: CatalogIndex = serde_json::from_slice(&index(seq, NOW - 60, NOW + 60)).unwrap();
        a.record(&key(1), &taken);
        a
    }

    #[test]
    fn a_fresh_newer_index_is_accepted() {
        let i = parse_index(&index(5, NOW - 60, NOW + 86_400), &key(1), &accepted(4), NOW).unwrap();
        assert_eq!((i.sequence, i.plugins.len()), (5, 1));
        assert!(parse_index(&index(1, NOW, NOW + 60), &key(1), &Accepted::default(), NOW).is_ok());
    }

    #[test]
    fn rollbacks_and_frozen_indexes_are_refused() {
        let refused =
            |bytes: Vec<u8>, accepted: &Accepted| parse_index(&bytes, &key(1), accepted, NOW).unwrap_err().code();
        let none = Accepted::default();
        assert_eq!(refused(index(4, NOW - 60, NOW + 60), &accepted(4)), "catalog.rollback");
        assert_eq!(refused(index(3, NOW - 60, NOW + 60), &accepted(4)), "catalog.rollback");
        assert_eq!(refused(index(5, NOW - 120, NOW - 1), &accepted(4)), "catalog.expired");
        assert_eq!(refused(index(5, NOW + 3600, NOW + 7200), &none), "catalog.times_implausible");
        assert_eq!(refused(index(5, NOW - 60, NOW + MAX_VALIDITY_SECS), &none), "catalog.times_implausible");
        assert_eq!(refused(b"{\"format\":1}".to_vec(), &none), "catalog.invalid");
        let future = String::from_utf8(index(5, NOW, NOW + 60)).unwrap().replacen("\"format\":1", "\"format\":2", 1);
        assert_eq!(refused(future.into_bytes(), &none), "catalog.format_unsupported");
    }

    /// Sequences belong to their key: another key's index starts on its own count, and a
    /// recorded sequence never goes down.
    #[test]
    fn sequences_are_kept_per_key() {
        let mut seen = accepted(40);
        assert!(parse_index(&index(2, NOW - 60, NOW + 60), &key(2), &seen, NOW).is_ok());
        assert_eq!(seen.get(&key(2)), None);
        let low: CatalogIndex = serde_json::from_slice(&index(7, NOW - 60, NOW + 60)).unwrap();
        seen.record(&key(1), &low);
        assert_eq!(seen.get(&key(1)), Some(40));
    }

    #[test]
    fn every_entry_is_checked() {
        let cases: Vec<(CatalogEntry, &str)> = vec![
            (CatalogEntry { url: "http://plugins.example.dev/x".into(), ..entry() }, "url"),
            (CatalogEntry { url: "https://user@plugins.example.dev/x".into(), ..entry() }, "url"),
            (CatalogEntry { url: "https:///x".into(), ..entry() }, "url"),
            (CatalogEntry { url: "https://x.dev/a b".into(), ..entry() }, "url"),
            (CatalogEntry { sha256: "ABC".into(), ..entry() }, "sha256"),
            (CatalogEntry { key_id: "00112233445566778899".into(), ..entry() }, "keyId"),
            (CatalogEntry { key_id: "001122334455667G".into(), ..entry() }, "keyId"),
            (CatalogEntry { id: "postgres".into(), ..entry() }, "id"),
            (CatalogEntry { version: "1.2".into(), ..entry() }, "version"),
            (CatalogEntry { kind: "app".into(), ..entry() }, "kind"),
            (CatalogEntry { description: Some("Neu\u{202E}".into()), ..entry() }, "description"),
            (CatalogEntry { description: Some("x".repeat(MAX_TEXT_CHARS + 1)), ..entry() }, "description"),
            (CatalogEntry { publisher: Some(" ".into()), ..entry() }, "publisher"),
            (CatalogEntry { network: vec!["db.example.dev 443".into()], ..entry() }, "network"),
            (CatalogEntry { network: vec!["a:1".into(); MAX_NETWORK_ENTRIES + 1], ..entry() }, "network"),
        ];
        for (bad, reason) in cases {
            let bytes = index_with(5, NOW - 60, NOW + 60, vec![entry(), bad]);
            let e = parse_index(&bytes, &key(1), &Accepted::default(), NOW).unwrap_err();
            assert_eq!(e, CatalogError::Entry { index: 1, reason }, "{reason}");
        }
        let twice = index_with(5, NOW - 60, NOW + 60, vec![entry(), entry()]);
        assert_eq!(
            parse_index(&twice, &key(1), &Accepted::default(), NOW).unwrap_err(),
            CatalogError::Entry { index: 1, reason: "repeated" }
        );
        let next = CatalogEntry { version: "1.3.0".into(), ..entry() };
        assert!(
            parse_index(&index_with(5, NOW - 60, NOW + 60, vec![entry(), next]), &key(1), &Accepted::default(), NOW)
                .is_ok()
        );
    }

    fn with_revoked(revoked: Vec<Revocation>) -> Vec<u8> {
        let index = CatalogIndex {
            format: 1,
            sequence: 5,
            published_at: NOW - 60,
            expires_at: NOW + 60,
            plugins: vec![entry()],
            revoked,
        };
        serde_json::to_vec(&index).unwrap()
    }

    fn revocation(versions: &str) -> Revocation {
        Revocation { id: "dev.example.redis".into(), versions: versions.into(), reason: "CVE-2026-0001".into() }
    }

    /// Revocations name versions by a semver requirement; the index says which entry or installed
    /// version they withdraw, and malformed ones refuse the whole index.
    #[test]
    fn revocations_withdraw_matching_versions() {
        let i = parse_index(&with_revoked(vec![revocation("<1.2.1")]), &key(1), &Accepted::default(), NOW).unwrap();
        assert_eq!(i.revocation("dev.example.redis", "1.2.0").map(|r| r.reason.as_str()), Some("CVE-2026-0001"));
        assert!(i.revocation("dev.example.redis", "1.2.1").is_none());
        assert!(i.revocation("dev.example.other", "1.0.0").is_none());
        assert!(revocation("*").covers("dev.example.redis", "9.9.9"));
        assert!(revocation("*").covers("dev.example.redis", "not-a-version"));
        // Pre-releases count as their release, which plain requirements never match otherwise.
        assert!(revocation("*").covers("dev.example.redis", "1.5.0-rc.1"));
        assert!(revocation("<1.2.1").covers("dev.example.redis", "1.2.0-beta.2"));
        assert!(revocation("=1.5.0").covers("dev.example.redis", "1.5.0-rc.1"));
        assert!(!revocation("<1.2.1").covers("dev.example.redis", "1.3.0-rc.1"));
        assert!(!revocation("*").covers("dev.example.other", "1.0.0"));
        // An index without revocations reads as before.
        let plain = parse_index(&index(5, NOW - 60, NOW + 60), &key(1), &Accepted::default(), NOW).unwrap();
        assert!(plain.revoked.is_empty());

        for (bad, reason) in [
            (Revocation { id: "redis".into(), ..revocation("*") }, "id"),
            (revocation("about 1.0"), "versions"),
            (Revocation { reason: String::new(), ..revocation("*") }, "reason"),
            (Revocation { reason: "a\nb".into(), ..revocation("*") }, "reason"),
        ] {
            let e =
                parse_index(&with_revoked(vec![revocation("*"), bad]), &key(1), &Accepted::default(), NOW).unwrap_err();
            assert_eq!(e, CatalogError::Revocation { index: 1, reason }, "{reason}");
            assert_eq!(e.code(), "catalog.revocation_invalid");
        }
    }
}
