//! A JSON-over-HTTP database API with basic auth, shared by ArangoDB and Couchbase: the base URL
//! as the settings name it, one client through `crate::http` (target checks, the private CA), and
//! requests that go exactly where Kalzit sends them. A redirect is never followed: the database's
//! origin holds every endpoint, the writing ones too, so a redirect could turn a query into
//! another request, and a body or the login must not reach another place.

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde_json::Value;

use super::frame::Charge;
use super::http_source::{self, Auth, Scrubber};
use super::{Connection, Detail, SourceError};
use crate::http::{HttpClient, HttpOptions};

/// The whole request; a query's own timeout is shorter and ends it first.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);

/// The base URL of a source: `http(s)://host[:port][/path]`, without credentials, query or
/// fragment, with a slash at the end so paths join below it.
pub fn parse_base_url(raw: &str) -> Result<Url, Detail> {
    let mut url = Url::parse(raw.trim())
        .map_err(|e| Detail::new("settings.url_invalid", format!("the URL is not valid: {e}")).with("detail", e))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Detail::new("settings.url_scheme", "the URL must start with http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Detail::new("settings.url_credentials", "the URL must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Detail::new("settings.url_query", "the URL must not contain a query or fragment"));
    }
    if url.host_str().is_none() {
        return Err(Detail::new("settings.url_no_host", "the URL needs a host"));
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// What a kind names its own errors.
#[derive(Clone, Copy)]
pub struct Reasons {
    /// The product, as error texts name it.
    pub engine: &'static str,
    /// The server answered with a redirect, which is refused.
    pub redirect: &'static str,
    /// The credentials cannot be carried in a header.
    pub credentials: &'static str,
}

pub struct JsonApi {
    http: HttpClient,
    base: Url,
    auth: Option<HeaderValue>,
    scrubber: Scrubber,
    reasons: Reasons,
}

/// An answer: its status and the body as read.
pub struct Answer {
    pub status: StatusCode,
    pub body: Vec<u8>,
}

impl JsonApi {
    /// The client of one source: `url` as stored, basic auth with `user` and the secret
    /// `password` when a user is set, and the private CA.
    pub fn new(
        conn: &Connection,
        url: &str,
        user: Option<&str>,
        ca_cert: Option<String>,
        reasons: Reasons,
    ) -> Result<Self, SourceError> {
        let base = parse_base_url(url).map_err(SourceError::Failed)?;
        let http = crate::http::client(HttpOptions {
            timeout: CLIENT_TIMEOUT,
            extra_root_pem: ca_cert,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::Failed(e.detail()))?;
        let mut scrubber = Scrubber::new(conn);
        let auth = match user.filter(|u| !u.is_empty()) {
            Some(user) => Some(
                Auth::Basic { user, password: conn.secret("password").unwrap_or("") }
                    .header(reasons.credentials, &mut scrubber)?,
            ),
            None => None,
        };
        Ok(Self { http, base, auth, scrubber, reasons })
    }

    /// The URL of `segments` below the base, each one encoded as one path segment.
    pub fn url(&self, segments: &[&str]) -> Result<Url, SourceError> {
        let mut url = self.base.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| SourceError::failed("internal", "the source URL cannot take a path"))?;
            path.pop_if_empty();
            for s in segments {
                path.push(s);
            }
        }
        Ok(url)
    }

    pub fn scrub(&self, text: &str) -> String {
        self.scrubber.scrub(text)
    }

    /// Sends one request with a JSON body (or none) and reads at most `max` bytes of the answer,
    /// charged to `charge` when given. A redirect is refused before and after it is sent.
    pub async fn send(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        max: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Answer, SourceError> {
        let mut headers = HeaderMap::new();
        if let Some(a) = &self.auth {
            headers.insert(AUTHORIZATION, a.clone());
        }
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let body = body.map(|b| b.to_string().into_bytes());
        if body.is_some() {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        let reasons = self.reasons;
        let hops = std::sync::atomic::AtomicUsize::new(0);
        let hop = |_: &Method, u: &Url| {
            if hops.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                return Ok(());
            }
            Err(redirect_detail(reasons, u))
        };
        let response = self
            .http
            .send_checked(method, url, headers, body, Some(&hop))
            .await
            .map_err(|e| http_source::failed(e, &self.scrubber))?;
        let status = response.status();
        if status.is_redirection() {
            let path = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|l| l.to_str().ok())
                .and_then(|l| self.base.join(l).ok())
                .map(|u| u.path().to_string())
                .unwrap_or_default();
            return Err(SourceError::Rejected(
                Detail::new(
                    reasons.redirect,
                    format!("{} redirected to {path}; Kalzit does not follow it", reasons.engine),
                )
                .with("path", self.scrub(&path)),
            ));
        }
        let bytes = match charge {
            Some(charge) => crate::http::read_counted(response, max, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max).await,
        }
        .map_err(|e| http_source::failed(e, &self.scrubber))?;
        Ok(Answer { status, body: bytes })
    }

    /// `send`, where `401 Unauthorized` is a refused login (`source.auth_failed`).
    pub async fn call(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        max: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Answer, SourceError> {
        let a = self.send(method, url, body, max, charge).await?;
        if let Some(e) = self.unauthorized(&a) {
            return Err(e);
        }
        Ok(a)
    }

    /// The refused login a `401` answer stands for.
    pub fn unauthorized(&self, a: &Answer) -> Option<SourceError> {
        http_source::unauthorized(a.status, &a.body, &self.scrubber)
    }
}

/// A JSON value with integers JavaScript cannot hold exactly kept as typed `int64` text, and the
/// rest as it is.
pub fn safe_numbers(v: Value) -> Value {
    match v {
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => super::graph::int_value(i),
            (None, Some(u), _) => crate::shapes::typed("int64", u.to_string()),
            (_, _, Some(f)) => super::graph::float_value(f),
            _ => Value::Null,
        },
        Value::Array(a) => Value::Array(a.into_iter().map(safe_numbers).collect()),
        Value::Object(m) => Value::Object(m.into_iter().map(|(k, v)| (k, safe_numbers(v))).collect()),
        other => other,
    }
}

/// A result item as a document: objects as they are, anything else as `{"value": ...}`.
pub fn as_document(v: Value) -> Value {
    match v {
        Value::Object(_) => v,
        other => serde_json::json!({ "value": other }),
    }
}

fn redirect_detail(reasons: Reasons, url: &Url) -> Detail {
    Detail::new(reasons.redirect, format!("{} redirected to {}; Kalzit does not follow it", reasons.engine, url.path()))
        .with("path", url.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_are_plain_and_end_in_a_slash() {
        assert_eq!(parse_base_url("http://db:8529").unwrap().as_str(), "http://db:8529/");
        assert_eq!(parse_base_url(" https://db/arango ").unwrap().as_str(), "https://db/arango/");
        for (raw, reason) in [
            ("ftp://db", "settings.url_scheme"),
            ("http://u:p@db", "settings.url_credentials"),
            ("http://db/?x=1", "settings.url_query"),
            ("http://db/#x", "settings.url_query"),
            ("nonsense", "settings.url_invalid"),
        ] {
            assert_eq!(parse_base_url(raw).unwrap_err().reason, reason, "{raw}");
        }
    }
}
