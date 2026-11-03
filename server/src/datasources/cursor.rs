//! Cursors of document sets as callers see them (docs/api/datasources.md, "The documents
//! shape"). A source names where its next page starts in its own form (an offset, say); the
//! caller gets that position sealed with an HMAC over the organization, the user, the data
//! source and the query it continues (query, graph steps, time range and variables). A cursor is
//! accepted only for the same caller running the same query, so it can only continue a result
//! the caller was already allowed to run; changed, made-up or foreign cursors are refused before
//! the source is asked.

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::Digest;

use super::cache::canonical;
use super::detail::Detail;
use crate::secrets::Keyring;
use crate::shapes::{QueryResult, TimeRange};

/// The version of the sealed form; a cursor of another version is refused.
const VERSION: &str = "c1";
/// Positions longer than this are not sealed (the source then offers no next page).
const MAX_POSITION: usize = 4 * 1024;
/// Sealed cursors longer than this are refused unread.
const MAX_CURSOR: usize = 8 * 1024;

/// The query a cursor belongs to, as the digest its seal covers.
pub struct Binding([u8; 32]);

impl Binding {
    pub fn new(
        org_id: &str,
        user_id: &str,
        datasource_id: &str,
        query: &Value,
        steps: &[Value],
        range: TimeRange,
        variables: &BTreeMap<String, Value>,
    ) -> Self {
        let basis = serde_json::json!({
            "o": org_id,
            "u": user_id,
            "d": datasource_id,
            "q": canonical(query),
            "s": steps.iter().map(canonical).collect::<Vec<_>>(),
            "r": [range.from, range.to],
            "v": variables.iter().map(|(k, v)| (k.clone(), canonical(v))).collect::<BTreeMap<_, _>>(),
        });
        Binding(sha2::Sha256::digest(basis.to_string().as_bytes()).into())
    }

    fn signed(&self, position: &str) -> Vec<u8> {
        let mut data = b"kalzit-cursor\0".to_vec();
        data.extend_from_slice(&self.0);
        data.push(0);
        data.extend_from_slice(position.as_bytes());
        data
    }
}

/// The source's position as the caller's cursor; `None` when the position is too long.
pub fn seal(keys: &Keyring, binding: &Binding, position: &str) -> Option<String> {
    if position.len() > MAX_POSITION {
        return None;
    }
    let mac = keys.sign(&binding.signed(position));
    Some(format!("{VERSION}.{}.{}", URL_SAFE_NO_PAD.encode(position), URL_SAFE_NO_PAD.encode(mac)))
}

/// The source's position from a cursor sealed for this binding, or the refusal.
pub fn open(keys: &Keyring, binding: &Binding, cursor: &str) -> Result<String, Detail> {
    let invalid = || Detail::new("query.cursor_invalid", "the cursor does not belong to this query");
    if cursor.len() > MAX_CURSOR {
        return Err(invalid());
    }
    let mut parts = cursor.split('.');
    let (Some(VERSION), Some(position), Some(mac), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(invalid());
    };
    let position = URL_SAFE_NO_PAD.decode(position).ok().and_then(|p| String::from_utf8(p).ok()).ok_or_else(invalid)?;
    let mac = URL_SAFE_NO_PAD.decode(mac).map_err(|_| invalid())?;
    if !keys.verify(&binding.signed(&position), &mac) {
        return Err(invalid());
    }
    Ok(position)
}

/// Seals the next page's position of a document set in place; a position that cannot be sealed
/// is dropped, so the set then simply has no next page.
pub fn seal_result(keys: &Keyring, binding: &Binding, result: &mut QueryResult) {
    if let QueryResult::Documents { documents } = result
        && let Some(position) = documents.next_cursor.take()
    {
        documents.next_cursor = seal(keys, binding, &position);
    }
}

/// The offset a source's own position names, for sources that page by document count. Only
/// positions this server sealed reach a source, so a wrong one is a refusal, not a failure.
pub fn offset(position: Option<&str>) -> Result<u64, super::SourceError> {
    match position {
        None => Ok(0),
        Some(p) => p.parse().map_err(|_| {
            super::SourceError::rejected("query.cursor_invalid", "the cursor does not belong to this query")
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::secrets::SecretKey;

    fn keys() -> Keyring {
        Keyring::from_key(SecretKey::generate().0)
    }

    fn binding(user: &str, query: Value) -> Binding {
        let range = TimeRange { from: 1, to: 2 };
        Binding::new("org", user, "ds", &query, &[], range, &BTreeMap::new())
    }

    #[test]
    fn cursors_open_only_for_their_caller_and_query() {
        let keys = keys();
        let mine = binding("u1", json!({ "lucene": "a", "size": 10 }));
        let cursor = seal(&keys, &mine, "200").unwrap();
        assert!(!cursor.contains("200"), "the position is not readable as is: {cursor}");
        assert_eq!(open(&keys, &mine, &cursor).unwrap(), "200");
        // Key order of the query does not matter.
        let same = binding("u1", json!({ "size": 10, "lucene": "a" }));
        assert_eq!(open(&keys, &same, &cursor).unwrap(), "200");

        let refused = |b: &Binding, c: &str| open(&keys, b, c).unwrap_err().reason;
        // Another user, another query, another range, another data source or organization.
        assert_eq!(refused(&binding("u2", json!({ "lucene": "a", "size": 10 })), &cursor), "query.cursor_invalid");
        assert_eq!(refused(&binding("u1", json!({ "lucene": "b", "size": 10 })), &cursor), "query.cursor_invalid");
        let q = json!({ "lucene": "a", "size": 10 });
        let vars = BTreeMap::new();
        let other_range = Binding::new("org", "u1", "ds", &q, &[], TimeRange { from: 1, to: 3 }, &vars);
        assert_eq!(refused(&other_range, &cursor), "query.cursor_invalid");
        let other_ds = Binding::new("org", "u1", "ds2", &q, &[], TimeRange { from: 1, to: 2 }, &vars);
        assert_eq!(refused(&other_ds, &cursor), "query.cursor_invalid");
        let other_org = Binding::new("org2", "u1", "ds", &q, &[], TimeRange { from: 1, to: 2 }, &vars);
        assert_eq!(refused(&other_org, &cursor), "query.cursor_invalid");
        // Another server key.
        assert_eq!(open(&super::tests::keys(), &mine, &cursor).unwrap_err().reason, "query.cursor_invalid");

        // A changed position, a made-up seal, other forms.
        let parts: Vec<&str> = cursor.split('.').collect();
        let forged = format!("{}.{}.{}", parts[0], URL_SAFE_NO_PAD.encode("100000"), parts[2]);
        for bad in [
            forged.as_str(),
            "c1.MjAw.AAAA",
            "MjAwOmFiY2Q",
            "",
            "c2.MjAw.AAAA",
            &format!("{cursor}.x"),
            &"c1.".repeat(4000),
        ] {
            assert_eq!(refused(&mine, bad), "query.cursor_invalid", "{bad}");
        }
    }

    #[test]
    fn long_positions_are_not_sealed_and_offsets_parse() {
        let keys = keys();
        assert!(seal(&keys, &binding("u", json!({})), &"9".repeat(MAX_POSITION + 1)).is_none());
        assert_eq!(offset(None).unwrap(), 0);
        assert_eq!(offset(Some("42")).unwrap(), 42);
        assert_eq!(offset(Some("x")).unwrap_err().detail().reason, "query.cursor_invalid");
    }
}
