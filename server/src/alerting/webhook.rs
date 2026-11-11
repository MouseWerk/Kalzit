//! The webhook channel (docs/PLAN.md section 13, "Webhook" and "Webhook-Signatur"): a `POST` of
//! the message as JSON, signed with the contact point's secret, to a URL that passes the target
//! check of data sources (private networks allowed, metadata addresses never) and never reaches
//! Kalzit itself. Redirects are not followed; the answer's body is not read.
//!
//! With an outbound proxy (`network.proxy_url`) webhooks go through it, except to the hosts
//! `network.no_proxy` names, like the plugin catalog: the URL's host is resolved and every address
//! checked against the target rules before anything is sent; a plain `http://` request goes to the
//! checked address, an `https://` one through `CONNECT` by name (the proxy resolves it again, see
//! `http`). Without a proxy, or past it, the connection itself goes to the checked address.
//!
//! "Kalzit itself" is its public address and, on Kalzit's own listening ports, every address of
//! this computer. A reverse proxy in front of Kalzit on other ports (80, 443) is not known to
//! Kalzit; a webhook through it is refused only when it uses the public address.

use std::time::Duration;

use hmac::{Hmac, KeyInit, Mac};
use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use sha2::Sha256;

use crate::app::AppState;
use crate::http::{HttpError, HttpOptions, LocalGuard};

/// Time per attempt.
pub const TIMEOUT: Duration = Duration::from_secs(10);

pub const SIGNATURE_HEADER: &str = "kalzit-signature";
pub const DELIVERY_HEADER: &str = "kalzit-delivery";
pub const EVENT_HEADER: &str = "kalzit-event";

/// `Kalzit-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]`: HMAC-SHA256 over `<t>.<body>` with
/// each secret, the current one first and, for a day after a rotation, the previous one.
pub fn signature<S: AsRef<str>>(secrets: &[S], t: i64, body: &[u8]) -> String {
    let mut out = format!("t={t}");
    for secret in secrets {
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_ref().as_bytes())
            .expect("HMAC takes keys of any length");
        mac.update(t.to_string().as_bytes());
        mac.update(b".");
        mac.update(body);
        out.push_str(",v1=");
        out.push_str(&hex::encode(mac.finalize().into_bytes()));
    }
    out
}

/// How an attempt ended: `ok`, the status code of another answer (`503`, `302` for a redirect,
/// which is not followed), or why there was none (`timeout`, `blocked`, `connection`, `failed`).
pub fn result_of(answer: Result<reqwest::StatusCode, HttpError>) -> (bool, String) {
    match answer {
        Ok(status) if status.is_success() => (true, "ok".into()),
        Ok(status) => (false, status.as_u16().to_string()),
        Err(HttpError::Timeout) => (false, "timeout".into()),
        Err(HttpError::Blocked(_)) | Err(HttpError::Refused(_)) => (false, "blocked".into()),
        Err(HttpError::Connection(_)) => (false, "connection".into()),
        Err(HttpError::TooLarge(_)) | Err(HttpError::Other(_)) => (false, "failed".into()),
    }
}

/// Sends `body` to `url` once, signed with `secrets`. Answers how it ended (`result_of`); the
/// cause of a failure goes to the server log only.
pub async fn send(
    state: &AppState,
    url: &str,
    body: Vec<u8>,
    secrets: &[impl AsRef<str>],
    delivery_id: &str,
    event: &str,
) -> (bool, String) {
    let Ok(url) = url::Url::parse(url) else { return (false, "failed".into()) };
    if crate::routes::ai::is_kalzit_itself(state, &url) {
        return (false, "blocked".into());
    }
    let policy = match state.datasources.policy(state).await {
        Ok(policy) => policy,
        Err(e) => {
            tracing::warn!("webhook delivery: the target rules cannot be read: {}", e.message);
            return (false, "failed".into());
        }
    };
    // Fails closed: when the proxy setting cannot be read, nothing goes out directly instead.
    let proxy = match crate::outbound::current(state).await {
        Ok(proxy) => proxy,
        Err(e) => {
            tracing::warn!("webhook delivery: the outbound proxy setting cannot be read: {}", e.message);
            return (false, "failed".into());
        }
    };
    let client = crate::http::client_proxied(
        HttpOptions { timeout: TIMEOUT, extra_root_pem: None, policy },
        local_guard(state, &url),
        proxy,
    );
    let client = match client {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!("webhook delivery: {e}");
            return (false, "failed".into());
        }
    };
    let t = state.clock.now_ms().div_euclid(1000);
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let values = [
        (SIGNATURE_HEADER, signature(secrets, t, &body)),
        (DELIVERY_HEADER, delivery_id.to_string()),
        (EVENT_HEADER, event.to_string()),
    ];
    for (name, value) in values {
        let Ok(value) = HeaderValue::from_str(&value) else {
            tracing::warn!("webhook delivery {delivery_id}: the {name} header cannot be sent");
            return (false, "failed".into());
        };
        headers.insert(HeaderName::from_static(name), value);
    }
    let answer = client.send_once(reqwest::Method::POST, url, headers, Some(body)).await.map(|r| r.status());
    if let Err(e) = &answer {
        tracing::info!("webhook delivery {delivery_id} failed: {}", e.detail().message);
    }
    result_of(answer)
}

/// When the URL's port is one of Kalzit's own listening ports, every address of this computer is
/// refused, whichever name points there: a webhook never reaches Kalzit itself. Other local and
/// private addresses are allowed, as for data sources.
fn local_guard(state: &AppState, url: &url::Url) -> Option<LocalGuard> {
    let port = url.port_or_known_default()?;
    let own = [state.config.http_addr(), state.config.https_addr()];
    own.iter().flatten().any(|l| l.port() == port).then(|| LocalGuard {
        refused: crate::datasources::Detail::new(
            "alerts.webhook_url_kalzit",
            "the webhook points at this Kalzit server",
        ),
        private: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The test vector of the guide: receivers can check their implementation against it.
    #[test]
    fn signatures_match_the_test_vector() {
        let secret = "4f3c2b1a00112233445566778899aabbccddeeff00112233445566778899aabb";
        let body = br#"{"version":1,"event":"test"}"#;
        let header = signature(&[secret], 1_794_319_332, body);
        assert_eq!(header, "t=1794319332,v1=54c9f745f2d47249ff0e616758f83cf4f52ae832a15b05f97f76203c3a35320d");
    }

    #[test]
    fn a_rotation_signs_with_both_secrets() {
        let body = b"{}";
        let both = signature(&["neu", "alt"], 10, body);
        let parts: Vec<&str> = both.split(',').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "t=10");
        assert_eq!(format!("{},{}", parts[0], parts[1]), signature(&["neu"], 10, body));
        assert_eq!(format!("{},{}", parts[0], parts[2]), signature(&["alt"], 10, body));
        // Recomputed the way a receiver does it.
        let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(b"alt").unwrap();
        mac.update(b"10.{}");
        assert_eq!(parts[2], format!("v1={}", hex::encode(mac.finalize().into_bytes())));
    }

    #[test]
    fn results_name_the_status_or_the_cause() {
        assert_eq!(result_of(Ok(reqwest::StatusCode::NO_CONTENT)), (true, "ok".into()));
        assert_eq!(result_of(Ok(reqwest::StatusCode::SERVICE_UNAVAILABLE)), (false, "503".into()));
        assert_eq!(result_of(Ok(reqwest::StatusCode::FOUND)), (false, "302".into()));
        assert_eq!(result_of(Err(HttpError::Timeout)), (false, "timeout".into()));
    }
}
