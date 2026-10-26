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
        change_spacing: Duration::from_millis(10),
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

#[tokio::test]
async fn free_queries_poll_and_push_new_results() {
    let t = T::new().await;
    let (ds, path) = t.sqlite_source().await;
    let mut ws = t.connect(&t.owner).await;
    say(
        &mut ws,
        json!({ "type": "subscribe", "id": "q", "queries": count_query(&ds), "timeRange": range(), "refreshMs": 1 }),
    )
    .await;
    let status = next_of(&mut ws, "status").await;
    assert_eq!(
        status,
        json!({ "type": "status", "id": "q", "mode": "poll", "refreshMs": 50, "reason": "live.source_unsupported" })
    );
    let first = next_of(&mut ws, "result").await;
    assert_eq!((first["id"].as_str(), count_of(&first)), (Some("q"), 1), "{first}");
    insert(&path, 2).await;
    let second = next_of(&mut ws, "result").await;
    assert_eq!(count_of(&second), 2, "{second}");
    // An identical subscription on another connection shares the feed.
    let mut other = t.connect(&t.owner).await;
    say(
        &mut other,
        json!({ "type": "subscribe", "id": "x", "queries": count_query(&ds), "timeRange": range(), "refreshMs": 1 }),
    )
    .await;
    assert_eq!(count_of(&next_of(&mut other, "result").await), 2);
    assert_eq!(t.state.live.feeds(), 1);
    // A moving range is its own feed.
    say(&mut other, json!({ "type": "subscribe", "id": "y", "queries": count_query(&ds), "lastMs": 3_600_000 })).await;
    let status = next_of(&mut other, "status").await;
    assert_eq!((status["mode"].as_str(), status.get("reason")), (Some("poll"), None), "{status}");
    assert_eq!(t.state.live.feeds(), 2);
    say(&mut other, json!({ "type": "unsubscribe", "id": "y" })).await;
    drop(other);
    say(&mut ws, json!({ "type": "unsubscribe", "id": "q" })).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while t.state.live.feeds() > 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the feeds end with their last subscriber");
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
    say(
        &mut ws,
        json!({ "type": "subscribe", "id": "a", "queries": count_query(&ds), "timeRange": range(), "unbekannt": 1 }),
    )
    .await;
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["reason"].as_str()), (Some("a"), Some("live.invalid_message")));
    let both =
        json!({ "type": "subscribe", "id": "b", "queries": count_query(&ds), "timeRange": range(), "lastMs": 5 });
    say(&mut ws, both).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "live.invalid_message");
    let neither = json!({ "type": "subscribe", "id": "c", "timeRange": range() });
    say(&mut ws, neither).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "live.invalid_message");
    let reversed =
        json!({ "type": "subscribe", "id": "d", "queries": count_query(&ds), "timeRange": { "from": 2, "to": 1 } });
    say(&mut ws, reversed).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "query.range_reversed");
    let ok = json!({ "type": "subscribe", "id": "e", "queries": count_query(&ds), "timeRange": range() });
    say(&mut ws, ok.clone()).await;
    next_of(&mut ws, "result").await;
    say(&mut ws, ok).await;
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["reason"].as_str()), (Some("e"), Some("live.duplicate_id")));
    say(&mut ws, json!({ "type": "nix" })).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["reason"], "live.invalid_message");
    t.finish().await;
}

#[tokio::test]
async fn viewers_follow_panels_they_may_read_and_lose_them_with_access() {
    let t = T::new().await;
    let (ds, _) = t.sqlite_source().await;
    let model = json!({
        "schemaVersion": 1, "title": "Live", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{
            "id": "p1", "type": "table", "title": "Zähler", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT COUNT(*) AS n FROM zaehler" } }],
            "transformations": [], "options": {}, "fieldConfig": {}
        }]
    });
    let dashboard = t.post("/dashboards", json!({ "model": model })).await["id"].as_str().unwrap().to_string();
    let viewer = t.session(Some("viewer")).await;
    let mut ws = t.connect(&viewer).await;
    let panel = json!({ "dashboardId": dashboard, "panelId": "p1" });
    say(&mut ws, json!({ "type": "subscribe", "id": "p", "panel": panel, "timeRange": range() })).await;
    assert_eq!(count_of(&next_of(&mut ws, "result").await), 1);
    // A viewer may not run free queries (sources they cannot see are not found, as in POST /query),
    // and unknown panels are not found.
    say(&mut ws, json!({ "type": "subscribe", "id": "q", "queries": count_query(&ds), "timeRange": range() })).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["code"], "not_found");
    let missing = json!({ "dashboardId": dashboard, "panelId": "p9" });
    say(&mut ws, json!({ "type": "subscribe", "id": "r", "panel": missing, "timeRange": range() })).await;
    assert_eq!(next_of(&mut ws, "error").await["error"]["code"], "not_found");
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
async fn free_queries_end_when_the_right_to_query_goes() {
    let t = T::new().await;
    let (ds, _) = t.sqlite_source().await;
    let editor = t.session(Some("editor")).await;
    let mut ws = t.connect(&editor).await;
    say(&mut ws, json!({ "type": "subscribe", "id": "q", "queries": count_query(&ds), "timeRange": range() })).await;
    next_of(&mut ws, "result").await;
    sqlx::query("UPDATE org_members SET role = 'viewer' WHERE role = 'editor'").execute(&t.state.db).await.unwrap();
    let e = next_of(&mut ws, "error").await;
    assert_eq!((e["id"].as_str(), e["error"]["code"].as_str()), (Some("q"), Some("not_found")), "{e}");
    assert_eq!(e["error"]["reason"], "live.forbidden");
    // Leaving the organization closes the connection.
    sqlx::query("DELETE FROM org_members WHERE role = 'viewer'").execute(&t.state.db).await.unwrap();
    let closing = next_of(&mut ws, "closing").await;
    assert_eq!(closing["error"]["reason"], "live.forbidden");
    assert_eq!(next_of(&mut ws, "close").await, json!({ "close": 4003, "reason": "live.forbidden" }));
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
    tokio::time::timeout(Duration::from_secs(5), async {
        while t.state.live.connections() == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
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

fn find_orders(ds: &str) -> Value {
    json!([{ "refId": "A", "datasourceId": ds, "query": { "collection": "orders", "filter": "{\"land\": \"AT\"}" } }])
}

#[tokio::test]
async fn mongodb_change_streams_push_new_results() {
    let t = T::new().await;
    let fake = FakeMongo::start(mongo_behaviour(true)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    say(&mut ws, json!({ "type": "subscribe", "id": "m", "queries": find_orders(&ds), "timeRange": range(), "refreshMs": 3_600_000 }))
        .await;
    let status = next_of(&mut ws, "status").await;
    assert_eq!((status["mode"].as_str(), status.get("reason")), (Some("changes"), None), "{status}");
    let first = next_of(&mut ws, "result").await;
    assert_eq!(first["results"]["A"]["result"]["documents"]["documents"].as_array().unwrap().len(), 1, "{first}");
    // The stream narrows inserts to the query's filter and carries no documents.
    let opened = fake
        .commands
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|c| {
            c.get_array("pipeline")
                .is_ok_and(|p| p.first().and_then(|s| s.as_document()).is_some_and(|s| s.contains_key("$changeStream")))
        })
        .cloned()
        .expect("a change stream");
    let stages = opened.get_array("pipeline").unwrap();
    let text = format!("{stages:?}");
    assert!(text.contains("fullDocument.land") && text.contains("$project"), "{text}");
    fake.behaviour.lock().unwrap().documents.push(doc! { "land": "AT", "n": 2 });
    fake.change("insert");
    let second = next_of(&mut ws, "result").await;
    assert_eq!(second["results"]["A"]["result"]["documents"]["documents"].as_array().unwrap().len(), 2, "{second}");
    drop(ws);
    t.finish().await;
}

#[tokio::test]
async fn mongodb_without_change_streams_is_polled() {
    let t = T::new().await;
    let fake = FakeMongo::start(mongo_behaviour(false)).await;
    let ds = mongo_source(&t, &fake).await;
    let mut ws = t.connect(&t.owner).await;
    say(
        &mut ws,
        json!({ "type": "subscribe", "id": "m", "queries": find_orders(&ds), "timeRange": range(), "refreshMs": 50 }),
    )
    .await;
    let status = next_of(&mut ws, "status").await;
    assert_eq!((status["mode"].as_str(), status["reason"].as_str()), (Some("poll"), Some("live.source_unsupported")));
    next_of(&mut ws, "result").await;
    fake.behaviour.lock().unwrap().documents.push(doc! { "land": "AT", "n": 2 });
    let second = next_of(&mut ws, "result").await;
    assert_eq!(second["results"]["A"]["result"]["documents"]["documents"].as_array().unwrap().len(), 2, "{second}");
    drop(ws);
    t.finish().await;
}
