//! What the data warehouse kinds share (BigQuery, Snowflake, Databricks SQL): RS256-signed JWTs
//! from a private key in the secret store, access tokens kept until shortly before they expire,
//! cancelling a statement in the warehouse when Kalzit stops waiting for it, and reading the
//! JSON answers of their REST APIs within a size limit.
//!
//! All three run a statement as a job in the warehouse, so a query that Kalzit abandons (the time
//! limit, a closed panel) keeps running and costing there unless it is cancelled: `CancelGuard`
//! sends the cancel request when the query's future is dropped before it finished. Every request
//! goes through the one HTTP client factory (`crate::http`), which checks each target, and none
//! follows a redirect (`HttpClient::send_once`), so a token is only ever sent to the URL it is
//! meant for.

use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde_json::Value;
use zeroize::Zeroizing;

use super::detail::Detail;
use super::http_source::{self, Scrubber};
use super::{SourceError, Table};
use crate::http::HttpClient;

/// The client's own limit; the query time limit around each call is usually shorter.
pub const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// One answer (a page of rows, a status) is read up to this size.
pub const MAX_PAGE_BYTES: usize = 64 * 1024 * 1024;
/// Health, token and schema answers are read up to this size.
pub const MAX_SMALL_BYTES: usize = 16 * 1024 * 1024;
/// Schema browsing reads at most this many columns.
pub const MAX_SCHEMA_COLUMNS: usize = 20_000;
/// An access token is renewed when less than this is left of it.
const TOKEN_MARGIN: Duration = Duration::from_secs(120);

// ---- RS256 ----

/// An RSA private key from the secret store, for RS256-signed JWTs (Google service accounts,
/// Snowflake key-pair authentication).
pub struct RsaKey(ring::signature::RsaKeyPair);

impl std::fmt::Debug for RsaKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RsaKey(..)")
    }
}

impl RsaKey {
    /// A key in PEM: unencrypted PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`).
    /// An encrypted key is refused with its own reason: Kalzit keeps the key in its encrypted
    /// store and has no passphrase to open it.
    pub fn from_pem(pem: &str, reason: &'static str) -> Result<Self, SourceError> {
        let invalid = |what: &str| SourceError::failed(reason, format!("the private key is not valid: {what}"));
        if pem.contains("ENCRYPTED") {
            return Err(SourceError::failed(
                reason,
                "the private key is encrypted; store it unencrypted (Kalzit encrypts its secret store)",
            )
            .with("detail", "encrypted"));
        }
        let pkcs1 = pem.contains("BEGIN RSA PRIVATE KEY");
        // The armour lines may arrive glued to the body: a key pasted into a one-line field
        // loses its line breaks. Everything between the armours, without white space, is the key.
        let mut body = pem.replace("\\n", "\n");
        for armour in ["-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----"] {
            if let Some((_, rest)) = body.split_once(armour) {
                body = rest.to_string();
            }
        }
        if let Some((key, _)) = body.split_once("-----END") {
            body = key.to_string();
        }
        let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let der = Zeroizing::new(
            base64::engine::general_purpose::STANDARD.decode(body.as_bytes()).map_err(|_| invalid("not PEM"))?,
        );
        let key = if pkcs1 {
            ring::signature::RsaKeyPair::from_der(&der)
        } else {
            ring::signature::RsaKeyPair::from_pkcs8(&der)
        }
        .map_err(|e| invalid(&e.to_string()))?;
        Ok(Self(key))
    }

    /// `header.claims.signature`, each part base64url without padding.
    pub fn sign_jwt(&self, header: &Value, claims: &Value) -> Result<Zeroizing<String>, SourceError> {
        let b64 = |v: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v);
        let message = format!("{}.{}", b64(header.to_string().as_bytes()), b64(claims.to_string().as_bytes()));
        let mut signature = vec![0; self.0.public().modulus_len()];
        self.0
            .sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                message.as_bytes(),
                &mut signature,
            )
            .map_err(|_| SourceError::failed("source.error", "the token could not be signed"))?;
        Ok(Zeroizing::new(format!("{message}.{}", b64(&signature))))
    }

    /// `SHA256:<base64>` of the public key's DER SubjectPublicKeyInfo, as Snowflake names the key
    /// a user signs in with (`RSA_PUBLIC_KEY_FP`).
    pub fn public_key_fingerprint(&self) -> String {
        use sha2::Digest as _;
        let spki = subject_public_key_info(self.0.public().as_ref());
        let digest = sha2::Sha256::digest(&spki);
        format!("SHA256:{}", base64::engine::general_purpose::STANDARD.encode(digest))
    }
}

/// A DER length.
fn der_length(len: usize, out: &mut Vec<u8>) {
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes: Vec<u8> = len.to_be_bytes().into_iter().skip_while(|b| *b == 0).collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend(bytes);
    }
}

fn der(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    der_length(content.len(), &mut out);
    out.extend_from_slice(content);
    out
}

/// The SubjectPublicKeyInfo around a PKCS#1 `RSAPublicKey`.
fn subject_public_key_info(rsa_public_key: &[u8]) -> Vec<u8> {
    // SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
    const ALGORITHM: &[u8] =
        &[0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
    let mut bits = vec![0x00];
    bits.extend_from_slice(rsa_public_key);
    let mut content = ALGORITHM.to_vec();
    content.extend(der(0x03, &bits));
    der(0x30, &content)
}

// ---- access tokens ----

/// An access token, kept until shortly before it expires and then fetched again.
#[derive(Default)]
pub struct TokenCache(tokio::sync::Mutex<Option<(Zeroizing<String>, Instant)>>);

impl TokenCache {
    /// The cached token, or a new one from `fetch` (the token and how long it is valid).
    pub async fn get<F, Fut>(&self, fetch: F) -> Result<Zeroizing<String>, SourceError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(Zeroizing<String>, Duration), SourceError>>,
    {
        let mut slot = self.0.lock().await;
        if let Some((token, until)) = slot.as_ref()
            && Instant::now() + TOKEN_MARGIN < *until
        {
            return Ok(token.clone());
        }
        let (token, valid) = fetch().await?;
        *slot = Some((token.clone(), Instant::now() + valid));
        Ok(token)
    }

    /// Forgets the token, after the warehouse refused it.
    pub async fn clear(&self) {
        *self.0.lock().await = None;
    }
}

// ---- cancelling ----

type CancelFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Cancels a statement in the warehouse when dropped while still armed: the query's future was
/// dropped (time limit, closed request) before the statement finished.
#[derive(Default)]
pub struct CancelGuard(Option<CancelFuture>);

impl CancelGuard {
    /// Arms the guard with the request that cancels the running statement.
    pub fn arm(&mut self, cancel: impl Future<Output = ()> + Send + 'static) {
        self.0 = Some(Box::pin(cancel));
    }

    /// The statement finished; nothing to cancel.
    pub fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let (Some(cancel), Ok(rt)) = (self.0.take(), tokio::runtime::Handle::try_current()) {
            rt.spawn(async move {
                // The cancel request gets a short time of its own; it is best effort.
                let _ = tokio::time::timeout(Duration::from_secs(30), cancel).await;
            });
        }
    }
}

// ---- requests ----

/// One answer: its status, headers and body.
pub struct Answer {
    pub status: reqwest::StatusCode,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }

    /// The body as text without secrets, cut short.
    pub fn text(&self, scrubber: &Scrubber) -> String {
        let text = scrubber.scrub(&String::from_utf8_lossy(&self.body));
        text.trim().chars().take(500).collect()
    }
}

/// Sends one request (no redirects followed) and reads the answer up to `max` bytes. `headers`
/// carry the credentials, marked sensitive.
pub async fn send(
    http: &HttpClient,
    method: Method,
    url: Url,
    mut headers: HeaderMap,
    body: Option<(&'static str, Vec<u8>)>,
    max: usize,
    scrubber: &Scrubber,
) -> Result<Answer, SourceError> {
    let body = body.map(|(content_type, bytes)| {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        bytes
    });
    headers.insert(reqwest::header::ACCEPT, HeaderValue::from_static("application/json"));
    let response = http.send_once(method, url, headers, body).await.map_err(|e| http_source::failed(e, scrubber))?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = crate::http::read_limited(response, max).await.map_err(|e| http_source::failed(e, scrubber))?;
    Ok(Answer { status, headers, body })
}

/// A JSON request body.
pub fn json_body(value: &Value) -> Option<(&'static str, Vec<u8>)> {
    Some(("application/json", value.to_string().into_bytes()))
}

/// A form request body (`application/x-www-form-urlencoded`).
pub fn form_body(pairs: &[(&str, &str)]) -> Option<(&'static str, Vec<u8>)> {
    let text = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs).finish();
    Some(("application/x-www-form-urlencoded", text.into_bytes()))
}

/// `Authorization: Bearer <token>`, sensitive.
pub fn bearer(token: &str, reason: &'static str) -> Result<HeaderMap, SourceError> {
    let mut headers = HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, http_source::header_value(&format!("Bearer {token}"), reason)?);
    Ok(headers)
}

/// `base` with `path` (starting with `/`) after its own path.
pub fn join(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let prefix = base.path().trim_end_matches('/');
    let (path, query) = path.split_once('?').map_or((path, None), |(p, q)| (p, Some(q)));
    url.set_path(&format!("{prefix}{path}"));
    url.set_query(query);
    url
}

/// The waits between status checks of a running statement: short at first, then once a second.
pub fn poll_delay(attempt: u32) -> Duration {
    Duration::from_millis((100u64 << attempt.min(4)).min(1_000))
}

/// The answer as a refused login, when its status says so.
pub fn refused_login(answer: &Answer, scrubber: &Scrubber) -> Option<SourceError> {
    match answer.status.as_u16() {
        401 => http_source::unauthorized(answer.status, &answer.body, scrubber),
        _ => None,
    }
}

/// An answer that is not the warehouse's JSON: a proxy's error page, a wrong URL.
pub fn not_an_api_answer(reason: &'static str, engine: &str, answer: &Answer) -> SourceError {
    SourceError::failed(reason, format!("the server answered {} without a {engine} answer", answer.status))
        .with("status", answer.status.as_u16())
}

// ---- values ----

/// `1700000000.123456789` (seconds with a fraction, as Snowflake writes times) as Unix
/// milliseconds.
pub fn seconds_text_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let seconds: i64 = whole.parse().ok()?;
    let digits: String = fraction.chars().chain(std::iter::repeat('0')).take(3).collect();
    let ms: i64 = digits.parse().ok()?;
    let ms = if seconds < 0 && ms > 0 { -ms } else { ms };
    seconds.checked_mul(1000)?.checked_add(ms)
}

/// A time of day from seconds since midnight, as `HH:MM:SS[.fff]`.
pub fn time_of_day(seconds: f64) -> String {
    let total_ms = (seconds * 1000.0).round() as i64;
    let (h, m, s, ms) = (total_ms / 3_600_000, total_ms / 60_000 % 60, total_ms / 1000 % 60, total_ms % 1000);
    if ms == 0 { format!("{h:02}:{m:02}:{s:02}") } else { format!("{h:02}:{m:02}:{s:02}.{ms:03}") }
}

/// A date or time as the warehouses write them in text (`2026-10-29`, `2026-10-29T12:00:00Z`,
/// `2026-10-29 12:00:00.123`, with or without a zone) as Unix milliseconds; without a zone it is
/// UTC.
pub fn datetime_text_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(t.timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f%#z", "%Y-%m-%d %H:%M:%S%.f%#z"] {
        if let Ok(t) = chrono::DateTime::parse_from_str(text, format) {
            return Some(t.timestamp_millis());
        }
    }
    let plain = text.trim_end_matches(" UTC").trim_end_matches('Z');
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(plain, format) {
            return Some(super::naive_to_ms(t));
        }
    }
    chrono::NaiveDate::parse_from_str(plain, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(super::naive_to_ms)
}

/// A decimal number as text, when it is one (digits, one point, a sign); otherwise `None`.
pub fn decimal_text(text: &str) -> Option<String> {
    let t = text.trim();
    let digits = t.strip_prefix('-').unwrap_or(t);
    let plain = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && digits.bytes().filter(|b| *b == b'.').count() <= 1
        && digits.bytes().any(|b| b.is_ascii_digit());
    plain.then(|| t.to_string())
}

/// A number from text; `NaN` and the infinities, which JSON cannot hold, are `null`.
pub fn number_text(text: &str) -> Value {
    text.trim().parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
}

/// An integer from text, as a decimal string (`int64` fields), when it is one.
pub fn int_text(text: &str) -> Value {
    let t = text.trim();
    let digits = t.strip_prefix('-').unwrap_or(t);
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) { Value::String(t.into()) } else { Value::Null }
}

/// JSON text as its value, or the text itself when it is not JSON.
pub fn json_text(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::String(text.to_string()))
}

/// The schema rows (schema, table, column, type) as tables.
pub fn tables(rows: Vec<(String, String, String, String)>) -> Vec<Table> {
    super::postgres::group_columns(rows)
}

/// The text of a JSON value, for schema rows.
pub fn text_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// A source error from the warehouse's own error text, scrubbed.
pub fn warehouse_error(
    reason: &'static str,
    engine: &str,
    code: &str,
    message: &str,
    scrubber: &Scrubber,
) -> SourceError {
    let message = scrubber.scrub(message.trim());
    SourceError::Failed(
        Detail::new(reason, format!("{engine} answered an error: {message}"))
            .with("code", code)
            .with("detail", message),
    )
}

/// A query the warehouse refused because it would change something: always a refused write.
pub fn write_refused(detail: &str) -> SourceError {
    SourceError::rejected("query.write_refused", format!("the query tried to write: {detail}")).with("detail", detail)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! The throwaway RSA key of the tests (generated for them, never used anywhere else), kept as
    //! base64 DER without PEM armour in tests/fixtures/warehouses.

    fn armour(kind: &str, b64: &str) -> String {
        format!("-----BEGIN {kind}-----\n{}\n-----END {kind}-----\n", b64.trim())
    }

    pub fn pkcs8_pem() -> String {
        armour("PRIVATE KEY", include_str!("../../tests/fixtures/warehouses/test-key.pk8.b64"))
    }

    pub fn pkcs1_pem() -> String {
        armour("RSA PRIVATE KEY", include_str!("../../tests/fixtures/warehouses/test-key.pkcs1.b64"))
    }

    /// `SHA256:` fingerprint of the test key's public key, computed with OpenSSL.
    pub const FINGERPRINT: &str = "SHA256:n54Y5DaLFxr3i575UTlkMQIPoREZ/adwYFFCUgFeM/c=";

    /// A query of the tests: a time range in late October 2026 and the variable `land`.
    pub fn req(sql: &str, max_rows: usize) -> crate::datasources::SourceQuery {
        use crate::datasources::Limits;
        use crate::datasources::frame::ResponseBudget;
        crate::datasources::SourceQuery {
            ref_id: "A".into(),
            query: serde_json::json!({ "sql": sql }),
            range: crate::shapes::TimeRange { from: 1_793_232_000_000, to: 1_793_318_400_000 },
            interval_ms: 60_000,
            max_data_points: None,
            variables: std::collections::BTreeMap::from([
                ("land".to_string(), serde_json::json!("Öster'reich")),
                ("ids".to_string(), serde_json::json!([1, 2])),
            ]),
            identifier_variables: None,
            limits: Limits {
                timeout: std::time::Duration::from_secs(20),
                max_rows,
                budget: ResponseBudget::new(1 << 20),
            },
            cursor: None,
            filters: Vec::new(),
        }
    }

    /// A connection to the mock, whose local address the target rules allow (as they allow
    /// private networks and localhost).
    pub async fn connection(settings: serde_json::Value, secrets: &[(&str, &str)]) -> crate::datasources::Connection {
        connection_with_files(settings, secrets, &[]).await
    }

    /// `connection` whose target rules allow files in `file_dirs`.
    pub async fn connection_with_files(
        settings: serde_json::Value,
        secrets: &[(&str, &str)],
        file_dirs: &[String],
    ) -> crate::datasources::Connection {
        let policy = crate::datasources::targets::TargetPolicy::new(
            &std::env::temp_dir().join("kalzit-none"),
            "sqlite::memory:",
            &[],
            &[],
        )
        .with_file_dirs(file_dirs);
        crate::datasources::json_documents::test_connection(settings, secrets, policy).await
    }
}

#[cfg(test)]
#[path = "../../tests/support/warehouse_mock.rs"]
pub(crate) mod mock;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_sign_jwts_and_name_their_fingerprint() {
        for pem in [test_support::pkcs8_pem(), test_support::pkcs1_pem()] {
            let key = RsaKey::from_pem(&pem, "snowflake.private_key_invalid").unwrap();
            assert_eq!(key.public_key_fingerprint(), test_support::FINGERPRINT);
            let jwt = key.sign_jwt(&json!({ "alg": "RS256", "typ": "JWT" }), &json!({ "sub": "x" })).unwrap();
            let parts: Vec<&str> = jwt.split('.').collect();
            assert_eq!(parts.len(), 3);
            let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[1]).unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&claims).unwrap(), json!({ "sub": "x" }));
            // A 2048-bit key signs with 256 bytes.
            assert_eq!(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[2]).unwrap().len(), 256);
        }
        // Pasted into a one-line field, the key loses its line breaks; in a JSON key file it
        // carries `\n` escapes.
        let one_line = test_support::pkcs8_pem().replace('\n', "");
        assert_eq!(RsaKey::from_pem(&one_line, "x.y").unwrap().public_key_fingerprint(), test_support::FINGERPRINT);
        let escaped = test_support::pkcs8_pem().replace('\n', "\\n");
        assert_eq!(RsaKey::from_pem(&escaped, "x.y").unwrap().public_key_fingerprint(), test_support::FINGERPRINT);
        let e =
            RsaKey::from_pem("-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----", "x.y")
                .unwrap_err();
        assert_eq!(e.detail().params["detail"], "encrypted");
        assert!(RsaKey::from_pem("kein Schlüssel", "x.y").is_err());
    }

    #[test]
    fn texts_become_values() {
        assert_eq!(seconds_text_ms("1700000000.123456789"), Some(1_700_000_000_123));
        assert_eq!(seconds_text_ms("1700000000"), Some(1_700_000_000_000));
        assert_eq!(seconds_text_ms("-1.5"), Some(-1_500));
        assert_eq!(time_of_day(45_000.25), "12:30:00.250");
        assert_eq!(time_of_day(3_600.0), "01:00:00");
        assert_eq!(datetime_text_ms("2026-10-29T12:00:00.000Z"), Some(1_793_275_200_000));
        assert_eq!(datetime_text_ms("2026-10-29T13:00:00+01:00"), Some(1_793_275_200_000));
        assert_eq!(datetime_text_ms("2026-10-29 12:00:00.5"), Some(1_793_275_200_500));
        assert_eq!(datetime_text_ms("2026-10-29T12:00:00"), Some(1_793_275_200_000));
        assert_eq!(datetime_text_ms("2026-10-29"), Some(1_793_232_000_000));
        assert_eq!(datetime_text_ms("gestern"), None);
        assert_eq!(decimal_text("-12.50"), Some("-12.50".into()));
        assert_eq!(decimal_text("1e5"), None);
        assert_eq!(number_text("NaN"), Value::Null);
        assert_eq!(number_text("2.5"), json!(2.5));
        assert_eq!(int_text("9007199254740993"), json!("9007199254740993"));
        assert_eq!(int_text("1.5"), Value::Null);
        assert_eq!(json_text("{\"a\":1}"), json!({ "a": 1 }));
        assert_eq!(json_text("POINT(1 2)"), json!("POINT(1 2)"));
    }

    #[test]
    fn paths_join_below_the_base() {
        let base = Url::parse("https://h.example/proxy/").unwrap();
        assert_eq!(join(&base, "/api/2.0/sql/statements").as_str(), "https://h.example/proxy/api/2.0/sql/statements");
        assert_eq!(join(&base, "/a?b=1").as_str(), "https://h.example/proxy/a?b=1");
        assert_eq!(poll_delay(0), Duration::from_millis(100));
        assert_eq!(poll_delay(9), Duration::from_millis(1000));
    }

    #[tokio::test]
    async fn a_dropped_guard_cancels_and_a_disarmed_one_does_not() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut guard = CancelGuard::default();
        let t = tx.clone();
        guard.arm(async move {
            let _ = t.send("abgebrochen");
        });
        drop(guard);
        assert_eq!(rx.recv().await, Some("abgebrochen"));
        let mut guard = CancelGuard::default();
        guard.arm(async move {
            let _ = tx.send("nie");
        });
        guard.disarm();
        drop(guard);
        assert_eq!(rx.recv().await, None);
    }
}
