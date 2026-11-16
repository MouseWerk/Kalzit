//! An S3-compatible object store as a backup target: the few calls a backup needs (put, list,
//! delete, multipart upload for large files), signed with AWS Signature Version 4. Requests go
//! through Kalzit's HTTP client (`http::client_proxied`): the target rules of data sources and the
//! outbound proxy apply, redirects are not followed, Kalzit itself is refused.

use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::http::{HttpClient, HttpError};

/// Files up to this size go up in one request; larger ones in parts of this size.
pub const PART_BYTES: usize = 32 * 1024 * 1024;
/// The longest one request may take, a part included.
pub const TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The most an answer of a list or a multipart start is read.
const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Where and how to reach the bucket. `Debug` leaves the secret out.
#[derive(Clone)]
pub struct Bucket {
    /// `https://s3.eu-central-1.amazonaws.com` or `http://minio.internal:9000`, without a path.
    pub endpoint: Url,
    pub region: String,
    pub bucket: String,
    /// Path-style addressing (`endpoint/bucket/key`), which most self-hosted stores need; else
    /// the bucket is a part of the host name.
    pub path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: Zeroizing<String>,
}

impl std::fmt::Debug for Bucket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Bucket")
            .field("endpoint", &self.endpoint.as_str())
            .field("region", &self.region)
            .field("bucket", &self.bucket)
            .field("path_style", &self.path_style)
            .field("access_key_id", &self.access_key_id)
            .field("secret_access_key", &"<redacted>")
            .finish()
    }
}

/// A failure, with the backup reason the API answers with.
#[derive(Debug)]
pub struct Failure {
    pub reason: &'static str,
    pub message: String,
    /// The store's answer: HTTP status and its error code, when it sent one.
    pub status: Option<u16>,
}

impl Failure {
    fn http(e: HttpError) -> Self {
        let detail = e.detail();
        let reason = match &e {
            HttpError::Blocked(_) => "backup.target_blocked",
            HttpError::Timeout => "backup.target_timeout",
            _ => "backup.target_unreachable",
        };
        Self { reason, message: detail.message, status: None }
    }

    fn answer(status: u16, body: &[u8]) -> Self {
        let code = xml_value(&String::from_utf8_lossy(body), "Code").unwrap_or_default();
        let reason = match (status, code.as_str()) {
            (_, "NoSuchBucket") | (404, _) => "backup.bucket_not_found",
            (_, "InvalidAccessKeyId" | "SignatureDoesNotMatch") | (401 | 403, _) => "backup.credentials_refused",
            _ => "backup.target_failed",
        };
        let message = if code.is_empty() {
            format!("the store answered {status}")
        } else {
            format!("the store answered {status} {code}")
        };
        Self { reason, message, status: Some(status) }
    }
}

type Result<T> = std::result::Result<T, Failure>;

/// The value of the first `<tag>...</tag>` in a small XML answer, unescaped.
fn xml_value(xml: &str, tag: &str) -> Option<String> {
    xml_values(xml, tag).into_iter().next()
}

fn xml_values(xml: &str, tag: &str) -> Vec<String> {
    let (open, close) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else { break };
        out.push(unescape(&after[..end]));
        rest = &after[end + close.len()..];
    }
    out
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// RFC 3986 percent-encoding as SigV4 wants it: unreserved characters stay, `/` stays when
/// `keep_slash`.
fn encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') || (keep_slash && b == b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// The `Authorization` header of a request (Signature Version 4, service `s3`). `headers` are
/// the headers to sign besides `host`, lowercase names; `amz_date` is `YYYYMMDDTHHMMSSZ`.
#[allow(clippy::too_many_arguments)]
pub fn authorization(
    method: &str,
    host: &str,
    path: &str,
    query: &[(String, String)],
    headers: &[(&str, &str)],
    payload_sha256: &str,
    amz_date: &str,
    region: &str,
    access_key_id: &str,
    secret: &str,
) -> String {
    let mut query: Vec<(String, String)> = query.iter().map(|(k, v)| (encode(k, false), encode(v, false))).collect();
    query.sort();
    let canonical_query = query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let mut signed: Vec<(String, String)> = vec![("host".into(), host.to_string())];
    signed.extend(headers.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.trim().to_string())));
    signed.sort();
    let canonical_headers: String = signed.iter().map(|(k, v)| format!("{k}:{v}\n")).collect();
    let signed_headers = signed.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";");
    let canonical_request =
        format!("{method}\n{path}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256}");
    let date = &amz_date[..8];
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", sha256_hex(canonical_request.as_bytes()));
    let key = hmac(format!("AWS4{secret}").as_bytes(), date);
    let key = hmac(&key, region);
    let key = hmac(&key, "s3");
    let key = hmac(&key, "aws4_request");
    let signature = hex::encode(hmac(&key, &to_sign));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// One object of a listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Object {
    pub key: String,
    pub size: u64,
}

pub struct Store<'a> {
    pub bucket: &'a Bucket,
    pub client: &'a HttpClient,
    /// The request date; each request takes it anew, so a long upload stays within the store's
    /// allowed clock skew.
    pub clock: &'a dyn crate::clock::Clock,
}

impl Store<'_> {
    /// The URL of `key` (empty for the bucket itself) and the host as signed.
    fn url(&self, key: &str) -> Result<(Url, String)> {
        let b = self.bucket;
        let mut url = b.endpoint.clone();
        let path = if b.path_style {
            format!("/{}/{}", encode(&b.bucket, false), encode(key, true))
        } else {
            let host = format!("{}.{}", b.bucket, b.endpoint.host_str().unwrap_or_default());
            url.set_host(Some(&host)).map_err(|e| Failure {
                reason: "backup.endpoint_invalid",
                message: format!("the bucket cannot be a part of the host name: {e}"),
                status: None,
            })?;
            format!("/{}", encode(key, true))
        };
        url.set_path(&path);
        let host = match url.port() {
            Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_string(),
        };
        Ok((url, host))
    }

    async fn send(
        &self,
        method: Method,
        key: &str,
        query: &[(String, String)],
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
    ) -> Result<reqwest::Response> {
        let (mut url, host) = self.url(key)?;
        // The canonical path is the encoded path as it goes out.
        let path = url.path().to_string();
        if !query.is_empty() {
            let text = query
                .iter()
                .map(|(k, v)| {
                    if v.is_empty() && k == "uploads" {
                        k.clone()
                    } else {
                        format!("{}={}", encode(k, false), encode(v, false))
                    }
                })
                .collect::<Vec<_>>()
                .join("&");
            url.set_query(Some(&text));
        }
        let payload = body.as_deref().map_or_else(|| EMPTY_SHA256.to_string(), sha256_hex);
        let at = chrono::DateTime::from_timestamp_millis(self.clock.now_ms()).unwrap_or_default();
        let amz_date = at.format("%Y%m%dT%H%M%SZ").to_string();
        let mut signed: Vec<(&str, &str)> = vec![("x-amz-content-sha256", &payload), ("x-amz-date", &amz_date)];
        if let Some(ct) = content_type {
            signed.push(("content-type", ct));
        }
        let b = self.bucket;
        let auth = authorization(
            method.as_str(),
            &host,
            &path,
            query,
            &signed,
            &payload,
            &amz_date,
            &b.region,
            &b.access_key_id,
            &b.secret_access_key,
        );
        let mut headers = HeaderMap::new();
        for (name, value) in &signed {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| internal(e.to_string()))?;
            headers.insert(name, HeaderValue::from_str(value).map_err(|e| internal(e.to_string()))?);
        }
        let mut auth = HeaderValue::from_str(&auth).map_err(|e| internal(e.to_string()))?;
        auth.set_sensitive(true);
        headers.insert(reqwest::header::AUTHORIZATION, auth);
        self.client.send_once(method, url, headers, body).await.map_err(Failure::http)
    }

    async fn checked(&self, res: reqwest::Response) -> Result<Vec<u8>> {
        let status = res.status().as_u16();
        let body = crate::http::read_limited(res, MAX_ANSWER_BYTES).await.map_err(Failure::http)?;
        if (200..300).contains(&status) { Ok(body) } else { Err(Failure::answer(status, &body)) }
    }

    pub async fn put(&self, key: &str, body: Vec<u8>) -> Result<()> {
        let res = self.send(Method::PUT, key, &[], Some(body), Some("application/octet-stream")).await?;
        self.checked(res).await.map(|_| ())
    }

    pub async fn delete(&self, key: &str) -> Result<()> {
        let res = self.send(Method::DELETE, key, &[], None, None).await?;
        self.checked(res).await.map(|_| ())
    }

    /// Every object whose key starts with `prefix` (ListObjectsV2, all pages).
    pub async fn list(&self, prefix: &str) -> Result<Vec<Object>> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        for _ in 0..1000 {
            let mut query =
                vec![("list-type".to_string(), "2".to_string()), ("prefix".to_string(), prefix.to_string())];
            if let Some(t) = &token {
                query.push(("continuation-token".to_string(), t.clone()));
            }
            let res = self.send(Method::GET, "", &query, None, None).await?;
            let xml = String::from_utf8_lossy(&self.checked(res).await?).into_owned();
            for item in xml_values(&xml, "Contents") {
                let Some(key) = xml_value(&item, "Key") else { continue };
                let size = xml_value(&item, "Size").and_then(|s| s.parse().ok()).unwrap_or(0);
                out.push(Object { key, size });
            }
            token = xml_value(&xml, "NextContinuationToken")
                .filter(|_| xml_value(&xml, "IsTruncated").as_deref() == Some("true"));
            if token.is_none() {
                return Ok(out);
            }
        }
        Ok(out)
    }

    /// Uploads `file` as `key`: in one request up to `PART_BYTES`, else as a multipart upload
    /// that is aborted when a part fails.
    pub async fn upload(&self, key: &str, file: &std::path::Path) -> Result<u64> {
        use tokio::io::AsyncReadExt;
        let failed =
            |e: std::io::Error| Failure { reason: "backup.snapshot_failed", message: e.to_string(), status: None };
        let size = tokio::fs::metadata(file).await.map_err(failed)?.len();
        let mut input = tokio::fs::File::open(file).await.map_err(failed)?;
        if size <= PART_BYTES as u64 {
            let mut body = Vec::with_capacity(size as usize);
            input.read_to_end(&mut body).await.map_err(failed)?;
            self.put(key, body).await?;
            return Ok(size);
        }
        let res = self
            .send(Method::POST, key, &[("uploads".into(), String::new())], None, Some("application/octet-stream"))
            .await?;
        let xml = String::from_utf8_lossy(&self.checked(res).await?).into_owned();
        let upload_id = xml_value(&xml, "UploadId").ok_or_else(|| Failure {
            reason: "backup.target_failed",
            message: "the store sent no upload id".into(),
            status: None,
        })?;
        let result = async {
            let mut etags = Vec::new();
            let mut number = 1u32;
            loop {
                let mut part = vec![0u8; PART_BYTES];
                let mut filled = 0;
                while filled < PART_BYTES {
                    let n = input.read(&mut part[filled..]).await.map_err(failed)?;
                    if n == 0 {
                        break;
                    }
                    filled += n;
                }
                if filled == 0 {
                    break;
                }
                part.truncate(filled);
                let query =
                    [("partNumber".to_string(), number.to_string()), ("uploadId".to_string(), upload_id.clone())];
                let res = self.send(Method::PUT, key, &query, Some(part), None).await?;
                let etag = res.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
                self.checked(res).await?;
                let etag = etag.ok_or_else(|| Failure {
                    reason: "backup.target_failed",
                    message: "the store sent no ETag for a part".into(),
                    status: None,
                })?;
                etags.push((number, etag));
                number += 1;
                if filled < PART_BYTES {
                    break;
                }
            }
            let mut body = String::from("<CompleteMultipartUpload>");
            for (n, etag) in &etags {
                body.push_str(&format!(
                    "<Part><PartNumber>{n}</PartNumber><ETag>{}</ETag></Part>",
                    etag.replace('&', "&amp;")
                ));
            }
            body.push_str("</CompleteMultipartUpload>");
            let query = [("uploadId".to_string(), upload_id.clone())];
            let res = self.send(Method::POST, key, &query, Some(body.into_bytes()), Some("application/xml")).await?;
            let answer = self.checked(res).await?;
            // A 200 can still carry an error for a completion that failed late.
            if xml_value(&String::from_utf8_lossy(&answer), "Code").is_some() {
                return Err(Failure::answer(500, &answer));
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            let query = [("uploadId".to_string(), upload_id.clone())];
            if let Ok(res) = self.send(Method::DELETE, key, &query, None, None).await {
                let _ = self.checked(res).await;
            }
            return Err(e);
        }
        Ok(size)
    }
}

fn internal(message: String) -> Failure {
    Failure { reason: "backup.target_failed", message, status: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example "GET Object" of Amazon's Signature Version 4 documentation.
    #[test]
    fn signatures_match_the_documented_example() {
        let auth = authorization(
            "GET",
            "examplebucket.s3.amazonaws.com",
            "/test.txt",
            &[],
            &[("range", "bytes=0-9"), ("x-amz-content-sha256", EMPTY_SHA256), ("x-amz-date", "20130524T000000Z")],
            EMPTY_SHA256,
            "20130524T000000Z",
            "us-east-1",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn the_secret_never_shows_in_debug_output() {
        let bucket = Bucket {
            endpoint: Url::parse("https://s3.example.com").unwrap(),
            region: "eu-central-1".into(),
            bucket: "b".into(),
            path_style: true,
            access_key_id: "AKIA".into(),
            secret_access_key: Zeroizing::new("s3cr3t".into()),
        };
        let text = format!("{bucket:?}");
        assert!(!text.contains("s3cr3t") && text.contains("<redacted>"), "{text}");
    }

    #[test]
    fn keys_and_queries_are_encoded_for_signing() {
        assert_eq!(encode("kalzit/backup 1+ä.zip", true), "kalzit/backup%201%2B%C3%A4.zip");
        assert_eq!(encode("a/b", false), "a%2Fb");
    }

    #[test]
    fn answers_name_their_reason() {
        let body = b"<Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>";
        assert_eq!(Failure::answer(403, body).reason, "backup.credentials_refused");
        assert_eq!(Failure::answer(404, b"<Error><Code>NoSuchBucket</Code></Error>").reason, "backup.bucket_not_found");
        assert_eq!(Failure::answer(500, b"").reason, "backup.target_failed");
        assert_eq!(xml_values("<a><Key>x&amp;y</Key></a><a><Key>z</Key></a>", "Key"), vec!["x&y", "z"]);
    }
}
