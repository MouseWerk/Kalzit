//! The plugin catalog index: a JSON document hosted by the project and signed in the catalog
//! context (`signing::verify_catalog`). It is off by default. Each index carries a sequence
//! number and an expiry, so an attacker who controls the download can neither serve an older
//! index (rollback) nor keep serving a stale one forever (freeze): the host remembers the
//! highest sequence it accepted and refuses lower ones, and refuses an index past its expiry.

use serde::{Deserialize, Serialize};

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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub version: String,
    /// `datasource` or `panel`.
    pub kind: String,
    pub name: String,
    /// `signing::key_id` of the key that signs the package.
    pub key_id: String,
    /// Where the package is downloaded from (https).
    pub url: String,
    /// SHA-256 of the package file, lowercase hex.
    pub sha256: String,
    pub size: u64,
}

/// Why an index is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CatalogError {
    TooLarge,
    Invalid(String),
    FormatUnsupported(u32),
    /// Older than or as old as an index already accepted.
    Rollback {
        sequence: u64,
        accepted: u64,
    },
    Expired {
        expires_at: u64,
    },
    /// Published in the future or valid for longer than `MAX_VALIDITY_SECS`.
    ImplausibleTimes,
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
        }
    }
}

/// Reads an index whose signature has verified. `accepted` is the highest sequence accepted
/// before (none on first use), `now` the current Unix time in seconds. A refresh with the same
/// sequence is refused too: a new index always has a new number.
pub fn parse_index(bytes: &[u8], accepted: Option<u64>, now: u64) -> Result<CatalogIndex, CatalogError> {
    if bytes.len() > MAX_INDEX_BYTES {
        return Err(CatalogError::TooLarge);
    }
    let index: CatalogIndex = serde_json::from_slice(bytes).map_err(|e| CatalogError::Invalid(e.to_string()))?;
    if index.format != CATALOG_FORMAT {
        return Err(CatalogError::FormatUnsupported(index.format));
    }
    if let Some(accepted) = accepted
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
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000;

    fn index(sequence: u64, published_at: u64, expires_at: u64) -> Vec<u8> {
        serde_json::to_vec(&CatalogIndex {
            format: 1,
            sequence,
            published_at,
            expires_at,
            plugins: vec![CatalogEntry {
                id: "dev.example.redis".into(),
                version: "1.2.0".into(),
                kind: "datasource".into(),
                name: "Redis".into(),
                key_id: "0011223344556677".into(),
                url: "https://plugins.example.dev/redis-1.2.0.kalzit-plugin".into(),
                sha256: "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708".into(),
                size: 1234,
            }],
        })
        .unwrap()
    }

    #[test]
    fn a_fresh_newer_index_is_accepted() {
        let i = parse_index(&index(5, NOW - 60, NOW + 86_400), Some(4), NOW).unwrap();
        assert_eq!((i.sequence, i.plugins.len()), (5, 1));
        assert!(parse_index(&index(1, NOW, NOW + 60), None, NOW).is_ok());
    }

    #[test]
    fn rollbacks_and_frozen_indexes_are_refused() {
        let refused = |bytes: Vec<u8>, accepted: Option<u64>| parse_index(&bytes, accepted, NOW).unwrap_err().code();
        assert_eq!(refused(index(4, NOW - 60, NOW + 60), Some(4)), "catalog.rollback");
        assert_eq!(refused(index(3, NOW - 60, NOW + 60), Some(4)), "catalog.rollback");
        assert_eq!(refused(index(5, NOW - 120, NOW - 1), Some(4)), "catalog.expired");
        assert_eq!(refused(index(5, NOW + 3600, NOW + 7200), None), "catalog.times_implausible");
        assert_eq!(refused(index(5, NOW - 60, NOW + MAX_VALIDITY_SECS), None), "catalog.times_implausible");
        assert_eq!(refused(b"{\"format\":1}".to_vec(), None), "catalog.invalid");
        let future = String::from_utf8(index(5, NOW, NOW + 60)).unwrap().replacen("\"format\":1", "\"format\":2", 1);
        assert_eq!(refused(future.into_bytes(), None), "catalog.format_unsupported");
    }
}
