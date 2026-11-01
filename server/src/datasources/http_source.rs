//! What the HTTP data sources share: the `Authorization` header from the stored credentials,
//! the secrets kept out of every error text, and one mapping from `HttpError` to `SourceError`.
//!
//! Every HTTP kind builds its client with these, so a refused redirect, an unreachable server or
//! a rejected login answers the same reason whichever kind it is, and no secret (as stored, or
//! as the base64 of `user:password` a server may echo) reaches an error, a log or the audit log.

use base64::Engine as _;
use reqwest::StatusCode;
use reqwest::header::HeaderValue;
use zeroize::Zeroizing;

use super::{Connection, SourceError};
use crate::http::HttpError;

/// The secrets of one source and the forms derived from them, removed from error texts.
#[derive(Clone, Default)]
pub struct Scrubber(Vec<Zeroizing<String>>);

impl Scrubber {
    /// Every stored secret of the source.
    pub fn new(conn: &Connection) -> Self {
        Self(conn.secrets.values().cloned().collect())
    }

    /// Adds a form derived from the secrets (a token in a header, say).
    pub fn add(&mut self, secret: impl Into<String>) {
        let secret = secret.into();
        if !secret.is_empty() {
            self.0.push(Zeroizing::new(secret));
        }
    }

    /// The text without any of the secrets (see `datasources::scrub`).
    pub fn scrub(&self, text: &str) -> String {
        super::scrub(text, self.0.iter().map(|s| s.as_str()))
    }
}

/// How a source signs in over HTTP.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Auth<'a> {
    /// `Basic <base64(user:password)>`.
    Basic { user: &'a str, password: &'a str },
    /// `<scheme> <token>`, such as `Bearer`, `ApiKey` or InfluxDB's `Token`.
    Token { scheme: &'static str, token: &'a str },
}

impl<'a> Auth<'a> {
    pub fn bearer(token: &'a str) -> Self {
        Auth::Token { scheme: "Bearer", token }
    }

    /// The usual choice of the HTTP kinds: basic auth when a user is set (also with an empty
    /// password), otherwise the bearer token, otherwise nothing.
    pub fn basic_or_bearer(user: Option<&'a str>, password: Option<&'a str>, bearer: Option<&'a str>) -> Option<Self> {
        match (user.filter(|u| !u.is_empty()), bearer) {
            (Some(user), _) => Some(Auth::Basic { user, password: password.unwrap_or("") }),
            (None, Some(token)) => Some(Auth::bearer(token)),
            (None, None) => None,
        }
    }

    /// The header value, marked sensitive so it never follows a redirect to another origin. The
    /// base64 of `user:password` goes to `scrubber`: servers echo it, and it is no stored secret.
    /// `invalid` is the kind's own reason for credentials a header cannot carry.
    pub fn header(&self, invalid: &'static str, scrubber: &mut Scrubber) -> Result<HeaderValue, SourceError> {
        let text = match *self {
            Auth::Basic { user, password } => {
                let token =
                    Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")));
                scrubber.add(token.as_str());
                Zeroizing::new(format!("Basic {}", token.as_str()))
            }
            Auth::Token { scheme, token } => Zeroizing::new(format!("{scheme} {token}")),
        };
        header_value(&text, invalid)
    }
}

/// A request header value from credentials, marked sensitive so it never follows a redirect to
/// another origin. `reason` names the kind's own error.
pub fn header_value(text: &str, reason: &'static str) -> Result<HeaderValue, SourceError> {
    let mut value = HeaderValue::from_str(text)
        .map_err(|_| SourceError::failed(reason, "the credentials contain characters a header cannot carry"))?;
    value.set_sensitive(true);
    Ok(value)
}

/// An `HttpError` as a source error, by its kind rather than its text: a refused target is
/// `datasource_target_blocked`, a request or redirect the kind's hop check refused is
/// `query_rejected`, everything else (unreachable, timed out, too large, broken) is
/// `datasource_error` with the reason `HttpError::detail` names. Texts are scrubbed.
pub fn failed(e: HttpError, scrubber: &Scrubber) -> SourceError {
    let scrub = |t: &str| scrubber.scrub(t);
    match e {
        HttpError::Blocked(b) => SourceError::Blocked(b.0.scrubbed(scrub)),
        HttpError::Refused(d) => SourceError::Rejected(d.scrubbed(scrub)),
        other => SourceError::Failed(other.detail().scrubbed(scrub)),
    }
}

/// The server's text in `source.auth_failed` is cut to this many characters.
const MAX_DETAIL_CHARS: usize = 300;

/// `401 Unauthorized`: the server did not accept the credentials (`source.auth_failed`), with
/// the start of its answer. The answer is scrubbed whole before it is cut, so a secret the
/// server echoes across the cut is still found.
pub fn unauthorized(status: StatusCode, body: &[u8], scrubber: &Scrubber) -> Option<SourceError> {
    if status != StatusCode::UNAUTHORIZED {
        return None;
    }
    let text = scrubber.scrub(&String::from_utf8_lossy(body));
    let text: String = text.trim().chars().take(MAX_DETAIL_CHARS).collect();
    let detail = if text.is_empty() { status.to_string() } else { format!("{status}: {text}") };
    Some(super::connect::auth_failed(detail))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Detail;
    use crate::datasources::targets::Blocked;

    #[test]
    fn basic_auth_scrubs_its_token_and_is_sensitive() {
        let mut s = Scrubber::default();
        let auth = Auth::basic_or_bearer(Some("leser"), Some("geheim"), Some("ignored")).unwrap();
        let value = auth.header("x.credentials_invalid", &mut s).unwrap();
        assert!(value.is_sensitive());
        let token = base64::engine::general_purpose::STANDARD.encode("leser:geheim");
        assert_eq!(value.to_str().unwrap(), format!("Basic {token}"));
        assert_eq!(s.scrub(&format!("echo {token} end")), "echo *** end");
    }

    #[test]
    fn the_bearer_token_is_used_without_a_user() {
        assert_eq!(Auth::basic_or_bearer(Some(""), None, Some("t")), Some(Auth::bearer("t")));
        assert_eq!(Auth::basic_or_bearer(None, Some("pw"), None), None);
        assert_eq!(
            Auth::basic_or_bearer(Some("u"), None, None),
            Some(Auth::Basic { user: "u", password: "" }),
            "a user without a password still signs in"
        );
        let mut s = Scrubber::default();
        let v = Auth::Token { scheme: "ApiKey", token: "k" }.header("x", &mut s).unwrap();
        assert_eq!(v.to_str().unwrap(), "ApiKey k");
    }

    #[test]
    fn credentials_a_header_cannot_carry_answer_the_kinds_reason() {
        let e = Auth::bearer("a\nb").header("prometheus.credentials_invalid", &mut Scrubber::default()).unwrap_err();
        assert_eq!(e.detail().reason, "prometheus.credentials_invalid");
        assert!(!e.detail().message.contains("a\nb"));
    }

    #[test]
    fn http_errors_map_by_kind_and_are_scrubbed() {
        let mut s = Scrubber::default();
        s.add("TOKEN-1");
        let refused = failed(HttpError::Refused(Detail::new("x.redirect_refused", "to /TOKEN-1")), &s);
        assert!(
            matches!(&refused, SourceError::Rejected(d) if d.reason == "x.redirect_refused" && d.message == "to /***")
        );
        let blocked = failed(HttpError::Blocked(Blocked(Detail::new("target.not_allowed", "no"))), &s);
        assert!(matches!(blocked, SourceError::Blocked(d) if d.reason == "target.not_allowed"));
        let unreachable = Detail::new("source.connect_refused", "cannot connect").with("address", "h:1");
        let e = failed(HttpError::Connection(unreachable), &s);
        assert!(matches!(e, SourceError::Failed(d) if d.reason == "source.connect_refused"));
        let e = failed(HttpError::Other("sent TOKEN-1".into()), &s);
        assert!(matches!(&e, SourceError::Failed(d) if d.reason == "http.failed" && !d.message.contains("TOKEN-1")));
        assert!(!format!("{:?}", e.detail().params).contains("TOKEN-1"));
        assert!(matches!(failed(HttpError::Timeout, &s), SourceError::Failed(d) if d.reason == "http.timeout"));
    }

    #[test]
    fn only_401_is_a_rejected_login() {
        let mut s = Scrubber::default();
        let mut auth = Scrubber::default();
        let header = Auth::Basic { user: "u", password: "pw-geheim" }.header("x", &mut auth).unwrap();
        s.add("pw-geheim");
        let token = header.to_str().unwrap().trim_start_matches("Basic ").to_string();
        s.add(token.clone());
        let echo = format!("denied for Basic {token} (u:pw-geheim)");
        let e = unauthorized(StatusCode::UNAUTHORIZED, echo.as_bytes(), &s).unwrap();
        let d = e.detail();
        assert_eq!(d.reason, "source.auth_failed");
        assert!(!d.message.contains("pw-geheim") && !d.message.contains(&token), "{}", d.message);
        assert!(!d.params["detail"].contains("pw-geheim"), "{:?}", d.params);
        let e = unauthorized(StatusCode::UNAUTHORIZED, b"", &s).unwrap();
        assert_eq!(e.detail().params["detail"], "401 Unauthorized");
        // Scrubbed whole, then cut: a secret across the cut leaves no part of itself behind.
        let long = format!("{}pw-geheim", "x".repeat(MAX_DETAIL_CHARS - 4));
        let e = unauthorized(StatusCode::UNAUTHORIZED, long.as_bytes(), &s).unwrap();
        assert!(!e.detail().message.contains("pw-g"), "{}", e.detail().message);
        assert!(unauthorized(StatusCode::FORBIDDEN, b"", &s).is_none());
        assert!(unauthorized(StatusCode::OK, b"", &s).is_none());
    }
}
