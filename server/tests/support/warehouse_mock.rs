//! A recorded-answer HTTP server for the warehouse sources (BigQuery, Snowflake, Databricks SQL),
//! which cannot run in CI containers. Each route answers its recorded responses in order (the
//! last one again once the others are used up) and every request is kept, so a test can check
//! what Kalzit sent. Shared by the unit tests in `src/datasources` and `tests/warehouses.rs`.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

/// One recorded answer.
#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub gzip: bool,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Self {
        Self { status, body: body.as_bytes().to_vec(), content_type: "application/json", gzip: false }
    }

    /// A body the server sends compressed (`Content-Encoding: gzip`), as Snowflake does for
    /// result partitions after the first.
    pub fn gzip_json(status: u16, compressed: Vec<u8>) -> Self {
        Self { status, body: compressed, content_type: "application/json", gzip: true }
    }
}

/// One request as received.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    /// The path with the query.
    pub path: String,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
    }
}

struct Route {
    method: Method,
    /// Matched against the path without the query: equal, or a prefix when it ends with `*`.
    path: String,
    replies: VecDeque<Reply>,
}

#[derive(Clone, Default)]
pub struct Mock {
    routes: Arc<Mutex<Vec<Route>>>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    /// Adds a route; `path` ending with `*` matches every path that starts with the rest.
    pub fn on(&self, method: &str, path: &str, replies: Vec<Reply>) -> &Self {
        let route = Route {
            method: Method::from_bytes(method.as_bytes()).expect("a method"),
            path: path.to_string(),
            replies: replies.into(),
        };
        self.routes.lock().unwrap().push(route);
        self
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The requests to paths that start with `prefix`.
    pub fn seen_at(&self, method: &str, prefix: &str) -> Vec<Seen> {
        self.seen().into_iter().filter(|s| s.method == method && s.path.starts_with(prefix)).collect()
    }

    fn answer(&self, method: &Method, path: &str) -> Option<Reply> {
        let mut routes = self.routes.lock().unwrap();
        let route = routes.iter_mut().find(|r| {
            r.method == *method
                && match r.path.strip_suffix('*') {
                    Some(prefix) => path.starts_with(prefix),
                    None => r.path == path,
                }
        })?;
        if route.replies.len() > 1 { route.replies.pop_front() } else { route.replies.front().cloned() }
    }

    /// Serves on a free local port.
    pub async fn serve(&self) -> SocketAddr {
        let mock = self.clone();
        let app = Router::new().fallback(move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let mock = mock.clone();
            async move {
                let path = uri.path_and_query().map_or_else(|| uri.path().to_string(), |p| p.as_str().to_string());
                mock.seen.lock().unwrap().push(Seen {
                    method: method.to_string(),
                    path: path.clone(),
                    headers,
                    body: body.to_vec(),
                });
                match mock.answer(&method, uri.path()) {
                    Some(reply) => {
                        let mut response: Response = (
                            StatusCode::from_u16(reply.status).unwrap(),
                            [(header::CONTENT_TYPE, reply.content_type)],
                            reply.body,
                        )
                            .into_response();
                        if reply.gzip {
                            response.headers_mut().insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
                        }
                        response
                    }
                    None => (StatusCode::NOT_FOUND, format!("no recorded answer for {method} {path}")).into_response(),
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }
}

/// The recorded answer `name` of `tests/fixtures/warehouses/<kind>.json`, as JSON text with
/// `{base}` replaced by the mock's URL.
pub fn fixture(kind: &str, name: &str, base: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/warehouses/{kind}.json"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let all: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let entry = all.get(name).unwrap_or_else(|| panic!("no answer {name} in {}", path.display()));
    entry.to_string().replace("{base}", base)
}

/// `fixture` as a reply with `status`.
pub fn reply(kind: &str, name: &str, base: &str, status: u16) -> Reply {
    Reply::json(status, &fixture(kind, name, base))
}
