//! Live updates through a real listener and WebSocket clients: SQLite sources (polling) and the
//! in-process MongoDB (change streams, and polling where a server has none). Real MongoDB is
//! tested in `server/tests/mongodb.rs`.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use bson::doc;
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

use crate::app::{AppState, router};
use crate::clock::ManualClock;
use crate::config::Config;
use crate::datasources::mongodb::test_server::{Behaviour, FakeMongo};
use crate::live::Limits;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const NOW: i64 = 1_800_000_000_000;

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct T {
    app: Router,
    state: AppState,
    org: String,
    owner: String,
    addr: SocketAddr,
    server: tokio::task::JoinHandle<()>,
    dir: tempfile::TempDir,
}

/// Short intervals, so the tests see refreshes, checks and timeouts quickly.
fn quick() -> Limits {
    Limits {
        min_refresh: Duration::from_millis(50),
        default_refresh: Duration::from_millis(100),
        watch_retry: Duration::from_millis(200),
        recheck: Duration::from_millis(150),
        ..Limits::default()
    }
}

impl T {
    async fn new() -> T {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = crate::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(NOW));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        let allowed = dir.path().join("erlaubt");
        std::fs::create_dir_all(&allowed).unwrap();
        state
            .datasources
            .test_settings
            .lock()
            .unwrap()
            .insert("datasources.sqlite_dirs".into(), json!([allowed.to_string_lossy()]));
        *state.live.limits.write().unwrap() = quick();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let served = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, served).await;
        });
        let mut t = T { app, state, org: String::new(), owner: String::new(), addr, server, dir };
        let (status, body) = t
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Test", "name": "Jörg",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        t.org = body["orgs"][0]["id"].as_str().unwrap().to_string();
        t.owner = t.session(None).await;
        t
    }

    async fn finish(self) {
        let T { app, state, server, dir, .. } = self;
        state.live.shutdown(Duration::from_secs(2)).await;
        server.abort();
        let _ = server.await;
        drop(app);
        crate::app::finish_test_app(state, dir).await;
    }

    /// A session of the owner (`role` None) or of a new member with `role`.
    async fn session(&self, role: Option<&str>) -> String {
        let db = &self.state.db;
        let user_id = match role {
            None => {
                let (id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'joerg@example.de'")
                    .fetch_one(db)
                    .await
                    .unwrap();
                id
            }
            Some(role) => {
                let id = uuid::Uuid::now_v7().to_string();
                sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
                    .bind(&id)
                    .bind(format!("{id}@example.de"))
                    .bind(role)
                    .execute(db)
                    .await
                    .unwrap();
                sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
                    .bind(&self.org)
                    .bind(&id)
                    .bind(role)
                    .execute(db)
                    .await
                    .unwrap();
                id
            }
        };
        let token = crate::auth::session::create(db, &self.state.config.sessions, NOW, &user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn post(&self, rest: &str, body: Value) -> Value {
        let path = format!("/api/orgs/{}{rest}", self.org);
        let (status, body) = self.send(Method::POST, &path, Some(body), Some(&self.owner)).await;
        assert!(status.is_success(), "{status} {body}");
        body
    }

    /// A SQLite source on a file with the table `zaehler`, and the file's path.
    async fn sqlite_source(&self) -> (String, std::path::PathBuf) {
        let path = self.dir.path().join("erlaubt").join("live.db");
        let pool = sqlx::SqlitePool::connect(&crate::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql("CREATE TABLE zaehler (n INTEGER); INSERT INTO zaehler VALUES (1);")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let body = json!({ "name": "Zähler", "kind": "sqlite", "settings": { "path": path.to_string_lossy() } });
        let created = self.post("/datasources", body).await;
        (created["id"].as_str().unwrap().to_string(), path)
    }

    async fn connect(&self, cookie: &str) -> Ws {
        self.connect_from(cookie, &format!("http://{}", self.addr)).await.unwrap()
    }

    async fn connect_from(&self, cookie: &str, origin: &str) -> Result<Ws, Box<tokio_tungstenite::tungstenite::Error>> {
        let mut req = format!("ws://{}/api/orgs/{}/live", self.addr, self.org).into_client_request().unwrap();
        req.headers_mut().insert("cookie", cookie.parse().unwrap());
        req.headers_mut().insert("origin", origin.parse().unwrap());
        tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(Box::new)
    }
}

async fn insert(path: &std::path::Path, n: i64) {
    let pool = sqlx::SqlitePool::connect(&crate::config::sqlite_url(path)).await.unwrap();
    sqlx::query("INSERT INTO zaehler VALUES ($1)").bind(n).execute(&pool).await.unwrap();
    pool.close().await;
}

async fn say(ws: &mut Ws, msg: Value) {
    ws.send(Message::Text(msg.to_string().into())).await.unwrap();
}

/// The next message: a JSON text, or `{"close": code, "reason": ...}` for the close frame.
async fn next(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("a message within 10 s")
            .expect("the connection is open");
        match msg {
            Ok(Message::Text(t)) => return serde_json::from_str(t.as_str()).unwrap(),
            Ok(Message::Close(frame)) => {
                let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or_default();
                return json!({ "close": code, "reason": reason });
            }
            Ok(_) => continue,
            Err(e) => panic!("{e}"),
        }
    }
}

/// The next message of `type`, skipping others.
async fn next_of(ws: &mut Ws, kind: &str) -> Value {
    loop {
        let msg = next(ws).await;
        if msg["type"] == kind || (kind == "close" && msg.get("close").is_some()) {
            return msg;
        }
        assert!(msg.get("close").is_none(), "closed while waiting for {kind}: {msg}");
    }
}

fn count_of(result: &Value) -> i64 {
    let values = &result["results"]["A"]["result"]["frame"]["fields"][0]["values"];
    values[0].as_i64().or_else(|| values[0].as_str().and_then(|s| s.parse().ok())).unwrap_or(-1)
}

fn range() -> Value {
    json!({ "from": 1_700_000_000_000_i64, "to": NOW })
}

fn count_query(ds: &str) -> Value {
    json!([{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT COUNT(*) AS n FROM zaehler" } }])
}

/// Subscribes and answers the feed the subscription follows (panics on an error).
async fn subscribe(ws: &mut Ws, msg: Value) -> String {
    let id = msg["id"].clone();
    say(ws, msg).await;
    loop {
        let m = next(ws).await;
        if m["type"] == "subscribed" && m["id"] == id {
            return m["feed"].as_str().unwrap().to_string();
        }
        assert!(m["type"] != "error" && m.get("close").is_none(), "{m}");
    }
}

/// The next message of `type` about `feed`.
async fn next_for(ws: &mut Ws, kind: &str, feed: &str) -> Value {
    loop {
        let m = next_of(ws, kind).await;
        if m["feed"] == feed {
            return m;
        }
    }
}

async fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !ok() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{what}"));
}

fn sub(id: &str, queries: Value) -> Value {
    json!({ "type": "subscribe", "id": id, "queries": queries, "timeRange": range(), "refreshMs": 1 })
}

#[tokio::test]
async fn free_queries_poll_and_push_new_results() {
    let t = T::new().await;
    let (ds, path) = t.sqlite_source().await;
    let mut ws = t.connect(&t.owner).await;
    let feed = subscribe(&mut ws, sub("q", count_query(&ds))).await;
    let status = next_for(&mut ws, "status", &feed).await;
    assert_eq!(
        status,
        json!({ "type": "status", "feed": feed, "mode": "poll", "refreshMs": 50, "reason": "live.source_unsupported" })
    );
    assert_eq!(count_of(&next_for(&mut ws, "result", &feed).await), 1);
    insert(&path, 2).await;
    assert_eq!(count_of(&next_for(&mut ws, "result", &feed).await), 2);
    // A second subscription with the same queries on the same connection follows the same feed
    // and gets its current result at once.
    assert_eq!(subscribe(&mut ws, sub("q2", count_query(&ds))).await, feed);
    assert_eq!(count_of(&next_for(&mut ws, "result", &feed).await), 2);
    // Another connection shares the feed too.
    let mut other = t.connect(&t.owner).await;
    assert_eq!(subscribe(&mut other, sub("x", count_query(&ds))).await, feed);
    assert_eq!(count_of(&next_for(&mut other, "result", &feed).await), 2);
    assert_eq!(t.state.live.feeds(), 1);
    assert!(t.state.live.held_bytes() > 0);
    // A moving range is its own feed.
    let moving = json!({ "type": "subscribe", "id": "y", "queries": count_query(&ds), "lastMs": 3_600_000 });
    let second = subscribe(&mut other, moving).await;
    assert_ne!(second, feed);
    let status = next_for(&mut other, "status", &second).await;
    assert_eq!((status["mode"].as_str(), status.get("reason")), (Some("poll"), None), "{status}");
    assert_eq!(t.state.live.feeds(), 2);
    drop(other);
    say(&mut ws, json!({ "type": "unsubscribe", "id": "q" })).await;
    say(&mut ws, json!({ "type": "unsubscribe", "id": "q2" })).await;
    let live = t.state.live.clone();
    wait_until("the feeds end with their last holder", || live.feeds() == 0).await;
    wait_until("their results are let go", || live.held_bytes() == 0).await;
    t.finish().await;
}

#[tokio::test]
async fn messages_are_checked() {
    let t = T::new().await;
    let (ds, _) = t.sqlite_source().await;
    let mut ws = t.connect(&t.owner).await;
    ws.send(Message::Text("kein json".into())).await.unwrap();
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e.get("id"), e["error"]["reason"].as_str()), (None, Some("live.invalid_message")), "{e}");
    let mut unknown = sub("a", count_query(&ds));
    unknown["unbekannt"] = json!(1);
    say(&mut ws, unknown).await;
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["reason"].as_str()), (Some("a"), Some("live.invalid_message")));
    let mut both = sub("b", count_query(&ds));
    both["lastMs"] = json!(5);
    say(&mut ws, both).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "live.invalid_message");
    say(&mut ws, json!({ "type": "subscribe", "id": "c", "timeRange": range() })).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "live.invalid_message");
    let mut reversed = sub("d", count_query(&ds));
    reversed["timeRange"] = json!({ "from": 2, "to": 1 });
    say(&mut ws, reversed).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "query.range_reversed");
    subscribe(&mut ws, sub("e", count_query(&ds))).await;
    say(&mut ws, sub("e", count_query(&ds))).await;
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["reason"].as_str()), (Some("e"), Some("live.duplicate_id")));
    say(&mut ws, json!({ "type": "nix" })).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "live.invalid_message");
    t.finish().await;
}

#[tokio::test]
async fn feeds_are_limited_per_user_and_server() {
    let t = T::new().await;
    *t.state.live.limits.write().unwrap() = Limits { feeds_per_user: 1, feeds: 2, ..quick() };
    let (ds, _) = t.sqlite_source().await;
    let mut ws = t.connect(&t.owner).await;
    subscribe(&mut ws, sub("a", count_query(&ds))).await;
    // The same feed again is no new feed.
    subscribe(&mut ws, sub("b", count_query(&ds))).await;
    let other = json!([{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT 1 AS n" } }]);
    say(&mut ws, sub("c", other.clone())).await;
    let e = next_of(&mut ws, "error").await;
    assert_eq!(
        (e["error"]["reason"].as_str(), e["error"]["params"]["max"].as_str()),
        (Some("live.too_many_feeds"), Some("1"))
    );
    let editor = t.session(Some("editor")).await;
    let mut ws2 = t.connect(&editor).await;
    subscribe(&mut ws2, sub("c", other)).await;
    let editor2 = t.session(Some("editor")).await;
    let mut ws3 = t.connect(&editor2).await;
    let third = json!([{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT 2 AS n" } }]);
    say(&mut ws3, sub("d", third)).await;
    assert_eq!(next_of(&mut ws3, "error").await["error"]["reason"], "live.feeds_busy");
    t.finish().await;
}

#[tokio::test]
async fn results_beyond_the_memory_budget_end_the_feed() {
    let t = T::new().await;
    *t.state.live.limits.write().unwrap() = Limits { held_bytes: 10, ..quick() };
    let (ds, _) = t.sqlite_source().await;
    let mut ws = t.connect(&t.owner).await;
    subscribe(&mut ws, sub("a", count_query(&ds))).await;
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["reason"].as_str()), (Some("a"), Some("live.memory_limit")), "{e}");
    t.finish().await;
}

#[tokio::test]
async fn viewers_follow_panels_they_may_read_and_lose_them_with_access() {
    let t = T::new().await;
    let (ds, path) = t.sqlite_source().await;
    let model = |sql: &str| {
        json!({
            "schemaVersion": 1, "title": "Live", "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{
                "id": "p1", "type": "table", "title": "Zähler", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": sql } }],
                "transformations": [], "options": {}, "fieldConfig": {}
            }]
        })
    };
    let created = t.post("/dashboards", json!({ "model": model("SELECT COUNT(*) AS n FROM zaehler") })).await;
    let dashboard = created["id"].as_str().unwrap().to_string();
    let viewer = t.session(Some("viewer")).await;
    let mut ws = t.connect(&viewer).await;
    let panel = json!({ "dashboardId": dashboard, "panelId": "p1" });
    let feed =
        subscribe(&mut ws, json!({ "type": "subscribe", "id": "p", "panel": panel, "timeRange": range() })).await;
    assert_eq!(count_of(&next_for(&mut ws, "result", &feed).await), 1);
    // A viewer may not run free queries (sources they cannot see are not found, as in POST /query),
    // and unknown panels are not found.
    say(&mut ws, sub("q", count_query(&ds))).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["code"], "not_found");
    let missing = json!({ "dashboardId": dashboard, "panelId": "p9" });
    say(&mut ws, json!({ "type": "subscribe", "id": "r", "panel": missing, "timeRange": range() })).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["code"], "not_found");
    // The panel is edited: the next check moves the subscription to its new queries.
    let put = format!("/api/orgs/{}/dashboards/{dashboard}", t.org);
    let body = json!({ "model": model("SELECT COUNT(*) + 100 AS n FROM zaehler"), "version": created["version"] });
    let (status, saved) = t.send(Method::PUT, &put, Some(body), Some(&t.owner)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let moved = next_of(&mut ws, "subscribed").await;
    assert_eq!(moved["id"], "p");
    let new_feed = moved["feed"].as_str().unwrap().to_string();
    assert_ne!(new_feed, feed);
    assert_eq!(count_of(&next_for(&mut ws, "result", &new_feed).await), 101);
    insert(&path, 2).await;
    assert_eq!(count_of(&next_for(&mut ws, "result", &new_feed).await), 102);
    // The dashboard goes to the trash: the next check ends the subscription.
    sqlx::query("UPDATE dashboards SET deleted_at = 1 WHERE id = $1")
        .bind(&dashboard)
        .execute(&t.state.db)
        .await
        .unwrap();
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["reason"].as_str()), (Some("p"), Some("live.forbidden")), "{e}");
    t.finish().await;
}

#[tokio::test]
async fn a_shared_feed_ends_only_for_who_lost_the_right() {
    let t = T::new().await;
    let (ds, path) = t.sqlite_source().await;
    let editor = t.session(Some("editor")).await;
    let mut owner_ws = t.connect(&t.owner).await;
    let mut editor_ws = t.connect(&editor).await;
    let feed = subscribe(&mut owner_ws, sub("o", count_query(&ds))).await;
    assert_eq!(subscribe(&mut editor_ws, sub("e", count_query(&ds))).await, feed);
    next_for(&mut editor_ws, "result", &feed).await;
    sqlx::query("UPDATE org_members SET role = 'viewer' WHERE role = 'editor'").execute(&t.state.db).await.unwrap();
    let e = next_of(&mut editor_ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["code"].as_str()), (Some("e"), Some("not_found")), "{e}");
    assert_eq!(e["error"]["reason"], "live.forbidden");
    // The owner's subscription goes on with the same feed.
    insert(&path, 2).await;
    while count_of(&next_for(&mut owner_ws, "result", &feed).await) != 2 {}
    assert_eq!(t.state.live.feeds(), 1);
    // Leaving the organization closes the connection.
    sqlx::query("DELETE FROM org_members WHERE role = 'viewer'").execute(&t.state.db).await.unwrap();
    assert_eq!(next_of(&mut editor_ws, "closing").await["error"]["reason"], "live.forbidden");
    assert_eq!(next_of(&mut editor_ws, "close").await, json!({ "close": 4003, "reason": "live.forbidden" }));
    t.finish().await;
}

#[tokio::test]
async fn an_ended_session_closes_the_connection() {
    let t = T::new().await;
    let mut ws = t.connect(&t.owner).await;
    sqlx::query("DELETE FROM sessions").execute(&t.state.db).await.unwrap();
    assert_eq!(next_of(&mut ws, "closing").await["error"]["reason"], "live.unauthenticated");
    assert_eq!(next_of(&mut ws, "close").await, json!({ "close": 4001, "reason": "live.unauthenticated" }));
    t.finish().await;
}

#[tokio::test]
async fn handshakes_need_this_origin_and_a_session() {
    let t = T::new().await;
    let refused = t.connect_from(&t.owner, "http://evil.example").await.expect_err("refused");
    let tokio_tungstenite::tungstenite::Error::Http(res) = *refused else { panic!("{refused}") };
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let refused = t.connect_from("kalzit_session=nichts", &format!("http://{}", t.addr)).await.expect_err("refused");
    let tokio_tungstenite::tungstenite::Error::Http(res) = *refused else { panic!("{refused}") };
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    t.finish().await;
}

#[tokio::test]
async fn limits_close_connections_with_a_reason() {
    let t = T::new().await;
    *t.state.live.limits.write().unwrap() =
        Limits { connections_per_user: 1, idle: Duration::from_millis(300), ..quick() };
    let mut first = t.connect(&t.owner).await;
    let mut second = t.connect(&t.owner).await;
    let closing = next_of(&mut second, "closing").await;
    assert_eq!(
        (closing["error"]["reason"].as_str(), closing["error"]["params"]["max"].as_str()),
        (Some("live.too_many"), Some("1"))
    );
    assert_eq!(next_of(&mut second, "close").await["close"], 4029);
    // Without subscriptions, a connection ends after the idle time.
    assert_eq!(next_of(&mut first, "close").await, json!({ "close": 4008, "reason": "live.idle_timeout" }));
    t.finish().await;
}

#[tokio::test]
async fn a_stopping_server_closes_its_connections() {
    let t = T::new().await;
    let mut ws = t.connect(&t.owner).await;
    // The connection is admitted once the handshake is done; wait for its slot.
    let live = t.state.live.clone();
    wait_until("the connection is admitted", || live.connections() > 0).await;
    t.state.live.begin_shutdown();
    assert_eq!(next_of(&mut ws, "closing").await["error"]["reason"], "live.shutting_down");
    assert_eq!(next_of(&mut ws, "close").await, json!({ "close": 1001, "reason": "live.shutting_down" }));
    t.finish().await;
}

async fn mongo_source(t: &T, fake: &FakeMongo) -> String {
    let settings = json!({ "hosts": format!("127.0.0.1:{}", fake.port), "database": "shop" });
    let created = t.post("/datasources", json!({ "name": "Mongo", "kind": "mongodb", "settings": settings })).await;
    created["id"].as_str().unwrap().to_string()
}

fn mongo_behaviour(change_streams: bool) -> Behaviour {
    Behaviour {
        privileges: vec![doc! {
            "resource": { "db": "shop", "collection": "" },
            "actions": ["changeStream", "find", "listCollections", "listIndexes"]
        }],
        documents: vec![doc! { "land": "AT", "n": 1 }],
        change_streams,
        ..Behaviour::default()
    }
}

fn find_where(ds: &str, filter: &str) -> Value {
    json!([{ "refId": "A", "datasourceId": ds, "query": { "collection": "orders", "filter": filter } }])
}

fn find_orders(ds: &str) -> Value {
    find_where(ds, "{\"land\": \"AT\"}")
}

fn documents_of(result: &Value) -> usize {
    result["results"]["A"]["result"]["documents"]["documents"].as_array().map_or(0, Vec::len)
}

/// The `$changeStream` specs of the aggregations the fake server received.
fn change_streams(fake: &FakeMongo) -> Vec<bson::Document> {
    fake.commands
        .lock()
        .unwrap()
        .iter()
        .filter_map(|c| {
            c.get_array("pipeline").ok()?.first()?.as_document()?.get_document("$changeStream").ok().cloned()
        })
        .collect()
}

/// The pipelines of the change streams opened.
fn change_pipelines(fake: &FakeMongo) -> Vec<String> {
    fake.commands
        .lock()
        .unwrap()
        .iter()
        .filter_map(|c| c.get_array("pipeline").ok())
        .filter(|p| p.first().and_then(|s| s.as_document()).is_some_and(|s| s.contains_key("$changeStream")))
        .map(|p| format!("{p:?}"))
        .collect()
}

fn finds(fake: &FakeMongo) -> usize {
    fake.commands.lock().unwrap().iter().filter(|c| c.contains_key("find")).count()
}

/// A subscription that only runs again on changes.
fn watched(id: &str, queries: Value) -> Value {
    let mut msg = sub(id, queries);
    msg["refreshMs"] = json!(3_600_000);
    msg
}

#[tokio::test]
async fn mongodb_change_streams_push_new_results() {
    let t = T::new().await;
    let fake = FakeMongo::start(mongo_behaviour(true)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    let feed = subscribe(&mut ws, watched("m", find_orders(&ds))).await;
    let status = next_for(&mut ws, "status", &feed).await;
    assert_eq!((status["mode"].as_str(), status.get("reason")), (Some("changes"), None), "{status}");
    assert_eq!(documents_of(&next_for(&mut ws, "result", &feed).await), 1);
    // The stream narrows inserts to the query's filter and carries no documents.
    let text = change_pipelines(&fake).pop().expect("a change stream");
    assert!(text.contains("fullDocument.land") && text.contains("$project"), "{text}");
    fake.behaviour.lock().unwrap().documents.push(doc! { "land": "AT", "n": 2 });
    fake.change("insert");
    assert_eq!(documents_of(&next_for(&mut ws, "result", &feed).await), 2);
    drop(ws);
    t.finish().await;
}

#[tokio::test]
async fn a_flood_of_changes_keeps_runs_apart() {
    let t = T::new().await;
    *t.state.live.limits.write().unwrap() = Limits { min_refresh: Duration::from_millis(300), ..quick() };
    let fake = FakeMongo::start(mongo_behaviour(true)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    let feed = subscribe(&mut ws, watched("m", find_orders(&ds))).await;
    next_for(&mut ws, "result", &feed).await;
    let before = finds(&fake);
    let started = std::time::Instant::now();
    while started.elapsed() < Duration::from_millis(900) {
        fake.change("update");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let runs = finds(&fake) - before;
    // About 1 s of changes, runs at least 300 ms apart: at most 4.
    assert!((1..=4).contains(&runs), "{runs} runs");
    drop(ws);
    t.finish().await;
}

#[tokio::test]
async fn change_streams_keep_off_the_query_pool_and_are_capped() {
    let t = T::new().await;
    let fake = FakeMongo::start(mongo_behaviour(true)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    // More change-mode feeds than the queries' pool has connections, and one more than the cap.
    for n in 0..9 {
        say(&mut ws, watched(&format!("m{n}"), find_where(&ds, &format!("{{\"n\": {n}}}")))).await;
    }
    // The first status of each feed.
    let mut first = std::collections::BTreeMap::new();
    while first.len() < 9 {
        let m = next(&mut ws).await;
        assert!(m["type"] != "error" && m.get("close").is_none(), "{m}");
        if m["type"] == "status" {
            let feed = m["feed"].as_str().unwrap().to_string();
            first
                .entry(feed)
                .or_insert((m["mode"].as_str().unwrap().to_string(), m["reason"].as_str().map(str::to_string)));
        }
    }
    let modes: Vec<_> = first.into_values().collect();
    let changes = modes.iter().filter(|(m, _)| m == "changes").count();
    let capped: Vec<_> = modes.iter().filter(|(m, _)| m == "poll").collect();
    assert_eq!(changes, 8, "{modes:?}");
    assert_eq!(capped, [&("poll".to_string(), Some("live.streams_limit".to_string()))]);
    // Every stream waits in a getMore; queries still answer at once.
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let body = json!({ "queries": find_orders(&ds), "timeRange": range() });
        let path = format!("/api/orgs/{}/query", t.org);
        let (status, r) = t.send(Method::POST, &path, Some(body), Some(&t.owner)).await;
        assert_eq!(status, StatusCode::OK, "{r}");
        assert_eq!(documents_of(&r), 1, "{r}");
        assert!(started.elapsed() < Duration::from_millis(1_000), "{:?}", started.elapsed());
    }
    drop(ws);
    t.finish().await;
}

#[tokio::test]
async fn change_streams_resume_and_start_over_when_history_is_gone() {
    let t = T::new().await;
    *t.state.live.limits.write().unwrap() = Limits { watch_renew: Duration::from_millis(400), ..quick() };
    let fake = FakeMongo::start(mongo_behaviour(true)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    let feed = subscribe(&mut ws, watched("m", find_orders(&ds))).await;
    next_for(&mut ws, "result", &feed).await;
    fake.change("insert");
    fake.change("insert");
    // Reopened after `watch_renew` from the last position (two changes sent: token 2).
    let token = format!("{:016X}", 2);
    wait_until("the stream is reopened from its token", || {
        change_streams(&fake)
            .iter()
            .any(|s| s.get_document("startAfter").is_ok_and(|t| t.get_str("_data").ok() == Some(token.as_str())))
    })
    .await;
    // The token's history is gone: the stream starts over without it and stays in change mode.
    fake.behaviour.lock().unwrap().history_lost = true;
    let opened = change_streams(&fake).len();
    wait_until("the stream starts over", || {
        let streams = change_streams(&fake);
        streams.len() > opened + 1 && streams[opened..].iter().any(|s| !s.contains_key("startAfter"))
    })
    .await;
    fake.behaviour.lock().unwrap().documents.push(doc! { "land": "AT", "n": 2 });
    fake.change("insert");
    while documents_of(&next_for(&mut ws, "result", &feed).await) != 2 {}
    drop(ws);
    t.finish().await;
}

#[tokio::test]
async fn mongodb_without_change_streams_is_polled() {
    let t = T::new().await;
    let fake = FakeMongo::start(mongo_behaviour(false)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    let mut msg = sub("m", find_orders(&ds));
    msg["refreshMs"] = json!(50);
    let feed = subscribe(&mut ws, msg).await;
    let status = next_for(&mut ws, "status", &feed).await;
    assert_eq!((status["mode"].as_str(), status["reason"].as_str()), (Some("poll"), Some("live.source_unsupported")));
    next_for(&mut ws, "result", &feed).await;
    fake.behaviour.lock().unwrap().documents.push(doc! { "land": "AT", "n": 2 });
    assert_eq!(documents_of(&next_for(&mut ws, "result", &feed).await), 2);
    drop(ws);
    t.finish().await;
}

#[tokio::test]
async fn panels_linked_to_a_saved_analysis_follow_its_queries() {
    let t = T::new().await;
    let (ds, _) = t.sqlite_source().await;
    let analysis = |sql: &str| {
        json!({ "schemaVersion": 1, "title": "Zähler", "timeRange": null,
                "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": sql } }],
                "visualization": { "type": "table", "options": {} } })
    };
    let created = t.post("/analyses", json!({ "model": analysis("SELECT COUNT(*) AS n FROM zaehler") })).await;
    let id = created["id"].as_str().unwrap().to_string();
    let dashboard = json!({ "schemaVersion": 2, "title": "Live", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{ "id": "p1", "type": "table", "title": "Zähler", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                     "analysisId": id }] });
    let dashboard = t.post("/dashboards", json!({ "model": dashboard })).await["id"].as_str().unwrap().to_string();
    // A viewer of the dashboard follows the linked queries without access to the analysis.
    let viewer = t.session(Some("viewer")).await;
    let mut ws = t.connect(&viewer).await;
    let panel = json!({ "dashboardId": dashboard, "panelId": "p1" });
    let feed =
        subscribe(&mut ws, json!({ "type": "subscribe", "id": "p", "panel": panel, "timeRange": range() })).await;
    assert_eq!(count_of(&next_for(&mut ws, "result", &feed).await), 1);
    // The analysis changes: the next check moves the subscription to its new queries.
    let body = json!({ "model": analysis("SELECT COUNT(*) + 10 AS n FROM zaehler"), "version": created["version"] });
    let (status, saved) =
        t.send(Method::PUT, &format!("/api/orgs/{}/analyses/{id}", t.org), Some(body), Some(&t.owner)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let moved = next_of(&mut ws, "subscribed").await;
    assert_eq!(moved["id"], "p");
    let new_feed = moved["feed"].as_str().unwrap().to_string();
    assert_ne!(new_feed, feed);
    assert_eq!(count_of(&next_for(&mut ws, "result", &new_feed).await), 11);
    t.finish().await;
}
