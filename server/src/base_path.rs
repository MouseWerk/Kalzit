//! Serving under a sub-path behind a reverse proxy (`server.base_path`, such as `/kalzit` for
//! `https://example.com/kalzit/`; docs/guide/reverse-proxy.md).
//!
//! The routes stay where they are. This wrapper takes the prefix off each request before routing,
//! and puts it back wherever an answer names a path of this server: `Location` headers that are
//! paths, and the `Path` of cookies. Links the server builds start with `Config::public_base`; the
//! web UI reads the prefix from its app shell (`web::index_html`).
//!
//! Cookies: a `__Host-` cookie must have `Path=/`, so below a sub-path the server's cookies are
//! sent as `__Secure-` cookies with `Path=<prefix>` instead, and renamed back on the way in. Only
//! this wrapper knows; the rest of the server keeps its names.

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Redirect, Response};
use tower::ServiceExt;

/// The server's cookies over HTTPS at the root (`auth::session::SECURE_COOKIE_NAME` and its
/// siblings), and their names below a sub-path.
const HOST_PREFIX: &str = "__Host-kalzit";
const SECURE_PREFIX: &str = "__Secure-kalzit";

/// Paths that also answer at the root: probes and load balancers often reach the server directly,
/// and an ACME authority always asks at the root of the host.
fn served_at_root(path: &str) -> bool {
    matches!(path, "/healthz" | "/readyz") || path.starts_with("/.well-known/acme-challenge/")
}

/// `app` below `base`; `app` itself when `base` is empty.
pub fn wrap(app: Router, base: &str) -> Router {
    if base.is_empty() {
        return app;
    }
    let base: Arc<str> = Arc::from(base);
    Router::new().fallback(move |req: Request| {
        let (app, base) = (app.clone(), base.clone());
        async move { serve(app, &base, req).await }
    })
}

async fn serve(app: Router, base: &str, mut req: Request) -> Response {
    let path = req.uri().path();
    let Some(inner) = strip(base, path) else {
        if served_at_root(path) {
            return app.oneshot(req).await.unwrap_or_else(|never| match never {});
        }
        if path == "/" {
            return Redirect::temporary(&format!("{base}/")).into_response();
        }
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = match req.uri().query() {
        Some(query) => format!("{inner}?{query}"),
        None => inner.to_string(),
    };
    let mut parts = req.uri().clone().into_parts();
    let Ok(target) = target.parse() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    parts.path_and_query = Some(target);
    let Ok(uri) = Uri::from_parts(parts) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    *req.uri_mut() = uri;
    incoming_cookies(req.headers_mut());
    let mut res = app.oneshot(req).await.unwrap_or_else(|never| match never {});
    outgoing(res.headers_mut(), base);
    res
}

/// The path below `base`: `/` for `base` itself, `None` outside it. `/kalzitx` is outside
/// `/kalzit`.
fn strip<'a>(base: &str, path: &'a str) -> Option<&'a str> {
    match path.strip_prefix(base)? {
        "" => Some("/"),
        rest if rest.starts_with('/') => Some(rest),
        _ => None,
    }
}

/// `__Secure-kalzit*` cookies get their usual `__Host-` names back. A `__Host-kalzit*` cookie a
/// browser still holds from Kalzit at the root of the same host is dropped: it is not this one's.
fn incoming_cookies(headers: &mut HeaderMap) {
    let values: Vec<String> =
        headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).map(str::to_string).collect();
    if !values.iter().any(|v| v.contains(SECURE_PREFIX) || v.contains(HOST_PREFIX)) {
        return;
    }
    let all: Vec<&str> =
        values.iter().flat_map(|v| v.split(';')).map(str::trim).filter(|pair| !pair.is_empty()).collect();
    // A `__Secure-` cookie, unlike a `__Host-` one, may be set with `Domain=` by a sibling
    // subdomain, with a longer path so the browser sends it first. When a name arrives twice,
    // neither copy can be told to be this server's, so both are dropped (no session, no device).
    let name = |pair: &str| pair.split_once('=').map_or(pair, |(n, _)| n).to_string();
    let mut seen = std::collections::HashMap::<String, usize>::new();
    for pair in all.iter().filter(|p| p.starts_with(SECURE_PREFIX)) {
        *seen.entry(name(pair)).or_default() += 1;
    }
    let pairs: Vec<String> = all
        .iter()
        .filter(|pair| !pair.starts_with(HOST_PREFIX))
        .filter(|pair| !pair.starts_with(SECURE_PREFIX) || seen.get(&name(pair)) == Some(&1))
        .map(|pair| match pair.strip_prefix(SECURE_PREFIX) {
            Some(rest) => format!("{HOST_PREFIX}{rest}"),
            None => pair.to_string(),
        })
        .collect();
    headers.remove(header::COOKIE);
    if let Ok(value) = HeaderValue::from_str(&pairs.join("; ")) {
        headers.insert(header::COOKIE, value);
    }
}

/// A path in `Location` gets the prefix; cookies get `Path=<base>` and, for `__Host-` ones, the
/// `__Secure-` name.
fn outgoing(headers: &mut HeaderMap, base: &str) {
    if let Some(location) = headers.get(header::LOCATION).and_then(|v| v.to_str().ok())
        && location.starts_with('/')
        && !location.starts_with("//")
        && let Ok(value) = HeaderValue::from_str(&format!("{base}{location}"))
    {
        headers.insert(header::LOCATION, value);
    }
    let cookies: Vec<HeaderValue> = headers.get_all(header::SET_COOKIE).iter().cloned().collect();
    if cookies.is_empty() {
        return;
    }
    headers.remove(header::SET_COOKIE);
    for cookie in cookies {
        let fixed = cookie.to_str().ok().map(|c| scoped_cookie(c, base)).and_then(|c| HeaderValue::from_str(&c).ok());
        headers.append(header::SET_COOKIE, fixed.unwrap_or(cookie));
    }
}

fn scoped_cookie(cookie: &str, base: &str) -> String {
    let renamed = match cookie.strip_prefix(HOST_PREFIX) {
        Some(rest) => format!("{SECURE_PREFIX}{rest}"),
        None => cookie.to_string(),
    };
    renamed
        .split(';')
        .map(|attr| if attr.trim().eq_ignore_ascii_case("path=/") { format!(" Path={base}") } else { attr.to_string() })
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paths_below_the_prefix_are_inside() {
        assert_eq!(strip("/kalzit", "/kalzit"), Some("/"));
        assert_eq!(strip("/kalzit", "/kalzit/"), Some("/"));
        assert_eq!(strip("/kalzit", "/kalzit/api/me"), Some("/api/me"));
        assert_eq!(strip("/kalzit", "/kalzitx/api"), None);
        assert_eq!(strip("/kalzit", "/api/me"), None);
        assert_eq!(strip("/a/b", "/a/b/c"), Some("/c"));
    }

    #[test]
    fn cookies_carry_the_prefix_and_lose_the_host_name() {
        let secure = "__Host-kalzit_session=abc; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure";
        assert_eq!(
            scoped_cookie(secure, "/kalzit"),
            "__Secure-kalzit_session=abc; Max-Age=60; Path=/kalzit; HttpOnly; SameSite=Lax; Secure"
        );
        let plain = "kalzit_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax";
        assert_eq!(scoped_cookie(plain, "/kalzit"), "kalzit_session=; Max-Age=0; Path=/kalzit; HttpOnly; SameSite=Lax");
    }

    #[test]
    fn incoming_cookies_get_their_names_back_and_a_root_one_is_dropped() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, HeaderValue::from_static("__Host-kalzit_session=root; theme=dark"));
        h.append(header::COOKIE, HeaderValue::from_static("__Secure-kalzit_session=mine; __Secure-kalzit_device=d"));
        incoming_cookies(&mut h);
        assert_eq!(h[header::COOKIE], "theme=dark; __Host-kalzit_session=mine; __Host-kalzit_device=d");
        assert_eq!(crate::auth::session::read_cookie(&h, true).as_deref(), Some("mine"));
    }

    /// A sibling subdomain can set a `__Secure-` cookie of the same name; with two of a name, no
    /// copy counts, while the other cookies stay.
    #[test]
    fn a_cookie_name_that_arrives_twice_is_dropped() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("__Secure-kalzit_session=planted; __Secure-kalzit_device=d; theme=dark"),
        );
        h.append(header::COOKIE, HeaderValue::from_static("__Secure-kalzit_session=mine"));
        incoming_cookies(&mut h);
        assert_eq!(h[header::COOKIE], "__Host-kalzit_device=d; theme=dark");
        assert_eq!(crate::auth::session::read_cookie(&h, true), None);
        assert_eq!(crate::auth::device::read_cookie(&h, true).as_deref(), Some("d"));
    }

    #[test]
    fn a_location_path_gets_the_prefix_and_an_address_stays() {
        let mut h = HeaderMap::new();
        h.insert(header::LOCATION, HeaderValue::from_static("/anmelden?sso=ok"));
        outgoing(&mut h, "/kalzit");
        assert_eq!(h[header::LOCATION], "/kalzit/anmelden?sso=ok");
        for kept in ["https://idp.example/authorize", "//elsewhere.example/x"] {
            let mut h = HeaderMap::new();
            h.insert(header::LOCATION, HeaderValue::from_str(kept).unwrap());
            outgoing(&mut h, "/kalzit");
            assert_eq!(h[header::LOCATION], kept);
        }
    }
}
