//! What the tests of single sources against real servers share (`arangodb.rs`, `gremlin.rs`,
//! `couchbase.rs`): an app with one organization and its owner, data sources created and queried
//! through the router, and the environment check of `KALZIT_TEST_REQUIRE_DATABASES`.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

use super::common;

const SETUP_CODE: &str = "test-setup-code-0123456789";

/// The variable's value, or `None` (with a notice) when it is not set; with
/// `KALZIT_TEST_REQUIRE_DATABASES=1` a missing value fails the test.
pub fn env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => Some(v),
        _ if std::env::var("KALZIT_TEST_REQUIRE_DATABASES").is_ok_and(|v| v == "1") => {
            panic!("{name} is not set, but KALZIT_TEST_REQUIRE_DATABASES=1 requires every database")
        }
        _ => {
            eprintln!("{name} not set, test not run");
            None
        }
    }
}

pub struct T {
    app: Router,
    org: String,
    cookie: String,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

impl T {
    pub async fn new() -> T {
        let dir = common::private_tempdir();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let body = json!({ "token": SETUP_CODE, "orgName": "Test", "name": "Jörg", "email": "joerg@example.de",
                           "password": "Grün und sicher 2026" });
        let req = Request::builder()
            .method(Method::POST)
            .uri("/api/setup")
            .header(header::HOST, "kalzit.test")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let cookie =
            res.headers().get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let me: Value = serde_json::from_slice(&bytes).unwrap();
        T { app, org: me["orgs"][0]["id"].as_str().unwrap().to_string(), cookie, state, dir: Arc::new(dir) }
    }

    /// Stops the app and deletes its data directory.
    pub async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    pub async fn send(&self, method: Method, rest: &str, body: Option<Value>) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(format!("/api/orgs/{}{rest}", self.org))
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, &self.cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// Creates a source and answers its id.
    pub async fn create(&self, name: &str, kind: &str, settings: Value, secrets: Value) -> String {
        let body = json!({ "name": name, "kind": kind, "settings": settings, "secrets": secrets });
        let (status, created) = self.send(Method::POST, "/datasources", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        created["id"].as_str().unwrap().to_string()
    }

    pub async fn health(&self, id: &str) -> Value {
        self.send(Method::POST, &format!("/datasources/{id}/health"), Some(json!({}))).await.1
    }

    pub async fn schema(&self, id: &str) -> Value {
        let (status, schema) = self.send(Method::GET, &format!("/datasources/{id}/schema"), None).await;
        assert_eq!(status, StatusCode::OK, "{schema}");
        schema
    }

    /// Runs one query; the answer of `A`, a result or an error.
    pub async fn query(&self, id: &str, query: Value) -> Value {
        let body = json!({
            "queries": [{ "refId": "A", "datasourceId": id, "query": query }],
            "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 },
            "variables": { "land": "Österreich" }
        });
        let (status, body) = self.send(Method::POST, "/query", Some(body)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["results"]["A"].clone()
    }
}

/// An HTTP client for setting up and checking a server as its administrator. The crate's
/// reqwest has no crypto provider of its own (`rustls-no-provider`), so the one the server uses
/// is installed first; otherwise building the client panics before the app has started.
pub fn admin_http() -> reqwest::Client {
    kalzit::http::ensure_crypto_provider();
    reqwest::Client::new()
}

/// A unique suffix for the names a test creates.
pub fn unique() -> String {
    uuid::Uuid::now_v7().simple().to_string()[..12].to_string()
}
