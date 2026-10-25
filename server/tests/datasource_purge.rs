//! Purging data sources from the trash, through the real router and database (docs/api/
//! datasources.md, "Purge"): SQLite, and PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const SECRET: &str = "Pr0m-Passwort-Nr-1!";

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
    owner: String,
    owner_id: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
}

async fn test_app(db_url: Option<String>) -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(state.clone()).layer(MockConnectInfo(peer));
    let mut t =
        TestApp { app, clock, state, _dir: dir, owner: String::new(), owner_id: String::new(), org: String::new() };
    let setup = t
        .send(
            Method::POST,
            "/api/setup",
            Some(json!({ "token": SETUP_CODE, "orgName": "MouseWerk", "name": "Jörg Müller",
                         "email": "joerg@example.de", "password": "Grün und sicher 2026" })),
            None,
        )
        .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    t.org = setup.body["orgs"][0]["id"].as_str().unwrap().to_string();
    t.owner_id = setup.body["id"].as_str().unwrap().to_string();
    t.owner = t.session_for(&t.owner_id).await;
    t
}

impl TestApp {
    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
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
        Reply { status, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
    }

    fn path(&self, rest: &str) -> String {
        format!("/api/orgs/{}{rest}", self.org)
    }

    async fn get(&self, rest: &str, cookie: &str) -> Reply {
        self.send(Method::GET, &self.path(rest), None, Some(cookie)).await
    }

    async fn post(&self, rest: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::POST, &self.path(rest), Some(body), Some(cookie)).await
    }

    async fn delete(&self, rest: &str, cookie: &str) -> Reply {
        self.send(Method::DELETE, &self.path(rest), None, Some(cookie)).await
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    async fn member(&self, name: &str, role: &str) -> (String, String) {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&id)
            .bind(format!("{}@example.de", name.to_lowercase()))
            .bind(name)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&self.org)
            .bind(&id)
            .bind(role)
            .execute(&self.state.db)
            .await
            .unwrap();
        let cookie = self.session_for(&id).await;
        (id, cookie)
    }

    /// A Prometheus source with a stored secret.
    async fn source(&self, name: &str) -> String {
        let r = self
            .post(
                "/datasources",
                json!({ "name": name, "kind": "prometheus",
                        "settings": { "url": "http://127.0.0.1:9", "basicAuthUser": "grafik" },
                        "secrets": { "basicAuthPassword": SECRET } }),
                &self.owner,
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn trash(&self, id: &str) {
        let r = self.delete(&format!("/datasources/{id}"), &self.owner).await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    }

    async fn purge(&self, id: &str, cookie: &str) -> Reply {
        self.delete(&format!("/datasources/{id}/purge"), cookie).await
    }

    async fn count(&self, sql: &str, id: &str) -> i64 {
        let (n,): (i64,) =
            sqlx::query_as(sqlx::AssertSqlSafe(sql.to_string())).bind(id).fetch_one(&self.state.db).await.unwrap();
        n
    }

    async fn dashboard_using(&self, title: &str, source: &str) -> String {
        let model = json!({ "schemaVersion": 2, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{ "id": "p1", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                "targets": [{ "refId": "A", "datasourceId": source, "query": { "expr": "up" } }] }] });
        let r = self.post("/dashboards", json!({ "model": model }), &self.owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }
}

/// A trashed source goes for good with what hangs on it: its secrets, its grants and the Explore
/// history of its queries. Only whoever may delete it may purge it; the audit entry names it and
/// holds no secret.
async fn a_trashed_source_is_purged_with_its_secrets_grants_and_history(t: TestApp) {
    let id = t.source("Prom").await;
    let (member_id, _) = t.member("Eva", "editor").await;
    let grant = t
        .post(
            "/grants",
            json!({ "subjectType": "user", "subjectId": member_id, "resourceType": "datasource",
                    "resourceId": id, "level": "query" }),
            &t.owner,
        )
        .await;
    assert!(grant.status.is_success(), "{}", grant.body);
    sqlx::query(
        "INSERT INTO explore_history (id, user_id, org_id, datasource_id, query, search_text, shape, created_at) \
         VALUES ($1, $2, $3, $4, '{}', '', 'frame', 1)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&t.owner_id)
    .bind(&t.org)
    .bind(&id)
    .execute(&t.state.db)
    .await
    .unwrap();
    assert_eq!(t.count("SELECT COUNT(*) FROM datasource_secrets WHERE datasource_id = $1", &id).await, 1);

    // Not while it is live.
    let r = t.purge(&id, &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "datasource.not_in_trash"), "{}", r.body);
    t.trash(&id).await;

    // Editors and viewers hold no datasources:write.
    for role in ["editor", "viewer"] {
        let (_, cookie) = t.member(&format!("{role}-nutzer"), role).await;
        let r = t.purge(&id, &cookie).await;
        assert!(matches!(r.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND), "{role}: {}", r.body);
    }
    let r = t.send(Method::DELETE, &t.path(&format!("/datasources/{id}/purge")), None, None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.count("SELECT COUNT(*) FROM datasources WHERE id = $1", &id).await, 1, "still there");

    let r = t.purge(&id, &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.count("SELECT COUNT(*) FROM datasources WHERE id = $1", &id).await, 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM datasource_secrets WHERE datasource_id = $1", &id).await, 0);
    assert_eq!(t.count("SELECT COUNT(*) FROM explore_history WHERE datasource_id = $1", &id).await, 0);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM resource_grants WHERE resource_type = 'datasource' AND resource_id = $1", &id)
            .await,
        0
    );
    // Gone from the trash, and no longer to be restored or purged again.
    let trash = t.get("/datasources?trash=true", &t.owner).await;
    assert!(trash.body["items"].as_array().unwrap().is_empty(), "{}", trash.body);
    assert_eq!(t.post(&format!("/datasources/{id}/restore"), json!({}), &t.owner).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.purge(&id, &t.owner).await.status, StatusCode::NOT_FOUND);

    let events: Vec<(String, Option<String>, String)> =
        sqlx::query_as("SELECT action, resource_id, summary FROM audit_events WHERE action = 'datasource.purged'")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].1.as_deref(), Some(id.as_str()));
    let summary: Value = serde_json::from_str(&events[0].2).unwrap();
    assert_eq!(summary, json!({ "name": "Prom", "kind": "prometheus" }));
    let all: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events").fetch_all(&t.state.db).await.unwrap();
    assert!(all.iter().all(|(s,)| !s.contains(SECRET)));
}

/// Dashboards and library panels that still use the source keep it: purging would leave them with
/// a source that is gone. Dashboards in the trash count, they can come back.
async fn a_source_in_use_is_not_purged(t: TestApp) {
    let id = t.source("Prom").await;
    let other = t.source("Andere").await;
    let dashboard = t.dashboard_using("Betrieb", &id).await;
    t.trash(&id).await;
    let r = t.purge(&id, &t.owner).await;
    assert_eq!((r.status, r.code(), r.reason()), (StatusCode::CONFLICT, "conflict", "datasource.in_use"));
    assert_eq!(r.body["error"]["params"]["dashboards"], "1", "{}", r.body);
    assert_eq!(r.body["error"]["params"]["libraryPanels"], "0");
    assert_eq!(t.count("SELECT COUNT(*) FROM datasource_secrets WHERE datasource_id = $1", &id).await, 1);
    assert_eq!(
        t.count("SELECT COUNT(*) FROM audit_events WHERE action = 'datasource.purged' AND $1 <> ''", &id).await,
        0
    );

    // A source nobody uses is not held back by that.
    t.trash(&other).await;
    assert_eq!(t.purge(&other, &t.owner).await.status, StatusCode::NO_CONTENT);

    // In the trash the dashboard still counts.
    let r = t.delete(&format!("/dashboards/{dashboard}"), &t.owner).await;
    assert!(r.status.is_success(), "{}", r.body);
    assert_eq!(t.purge(&id, &t.owner).await.code(), "conflict");
    // Purged, it no longer does.
    let r = t.delete(&format!("/dashboards/{dashboard}/purge"), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);

    // A library panel counts too.
    let panel = json!({ "name": "Verfügbarkeit", "model": { "schemaVersion": 2, "type": "timeseries", "title": "Up",
        "targets": [{ "refId": "A", "datasourceId": id, "query": { "expr": "up" } }] } });
    let lib = t.post("/library-panels", panel, &t.owner).await;
    assert_eq!(lib.status, StatusCode::CREATED, "{}", lib.body);
    let r = t.purge(&id, &t.owner).await;
    assert_eq!((r.code(), r.body["error"]["params"]["libraryPanels"].as_str()), ("conflict", Some("1")));
    let lib_id = lib.body["id"].as_str().unwrap();
    let r = t.delete(&format!("/library-panels/{lib_id}"), &t.owner).await;
    assert!(r.status.is_success(), "{}", r.body);
    assert_eq!(t.purge(&id, &t.owner).await.status, StatusCode::NO_CONTENT);
}

/// Sources of another organization are not reachable by id.
async fn purging_is_limited_to_the_organization(t: TestApp) {
    let id = t.source("Prom").await;
    t.trash(&id).await;
    let other_org = uuid::Uuid::now_v7().to_string();
    let r =
        t.send(Method::DELETE, &format!("/api/orgs/{other_org}/datasources/{id}/purge"), None, Some(&t.owner)).await;
    assert!(matches!(r.status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND), "{}", r.body);
    assert_eq!(t.count("SELECT COUNT(*) FROM datasources WHERE id = $1", &id).await, 1);
}

/// Deleting for good takes the right to move targets: an edit grant restores and edits, an admin
/// grant or the org-wide right also purges.
async fn purging_needs_the_right_to_move_targets(t: TestApp) {
    let id = t.source("Prom").await;
    let (member, cookie) = t.member("Gerda", "editor").await;
    let give = |level: &'static str| {
        let (t, id, member) = (&t, id.clone(), member.clone());
        async move {
            let r = t
                .post(
                    "/grants",
                    json!({ "subjectType": "user", "subjectId": member, "resourceType": "datasource",
                           "resourceId": id, "level": level }),
                    &t.owner,
                )
                .await;
            assert!(r.status.is_success(), "{}", r.body);
        }
    };
    give("edit").await;
    // She may delete it (to the trash) and restore it, but not purge it.
    let r = t.delete(&format!("/datasources/{id}"), &cookie).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    let r = t.purge(&id, &cookie).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "datasource.purge_forbidden"), "{}", r.body);
    assert_eq!(t.count("SELECT COUNT(*) FROM datasources WHERE id = $1", &id).await, 1);
    give("admin").await;
    assert_eq!(t.purge(&id, &cookie).await.status, StatusCode::NO_CONTENT);
}

/// Restore and purge of the same source at the same time: one wins, never both, and a restored
/// source keeps its secrets.
async fn restoring_and_purging_at_once_end_in_one_state(t: TestApp) {
    for round in 0..8 {
        let id = t.source(&format!("Prom {round}")).await;
        t.trash(&id).await;
        let restore_path = format!("/datasources/{id}/restore");
        let restore = t.post(&restore_path, json!({}), &t.owner);
        let purge = t.purge(&id, &t.owner);
        let (restored, purged) = tokio::join!(restore, purge);
        let rows = t.count("SELECT COUNT(*) FROM datasources WHERE id = $1", &id).await;
        let secrets = t.count("SELECT COUNT(*) FROM datasource_secrets WHERE datasource_id = $1", &id).await;
        match (restored.status, purged.status) {
            (StatusCode::OK, StatusCode::CONFLICT | StatusCode::NOT_FOUND) => {
                assert_eq!((rows, secrets), (1, 1), "restored: it and its secret stay");
            }
            (StatusCode::NOT_FOUND | StatusCode::CONFLICT, StatusCode::NO_CONTENT) => {
                assert_eq!((rows, secrets), (0, 0), "purged: nothing is left");
            }
            other => panic!("round {round}: {other:?} {} {}", restored.body, purged.body),
        }
        let live: i64 = t.count("SELECT COUNT(*) FROM datasources WHERE id = $1 AND deleted_at IS NULL", &id).await;
        assert!(rows == 0 || live == 1, "never half restored");
    }
}

/// Every flow runs on SQLite, and on PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set (in a
/// throwaway schema per flow, so the test database is left as it was).
macro_rules! on_both_databases {
    ($($flow:ident;)*) => {
        mod sqlite {
            use super::*;
            $(
                #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
                async fn $flow() {
                    super::$flow(test_app(None).await).await
                }
            )*
        }

        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn postgres_flows() {
            let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
                eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL flows not run");
                return;
            };
            sqlx::any::install_default_drivers();
            let admin = sqlx::AnyPool::connect(&base).await.unwrap();
            $(
                let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
                // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
                sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin).await.unwrap();
                let sep = if base.contains('?') { '&' } else { '?' };
                let url = format!("{base}{sep}options=-csearch_path%3D{schema}");
                $flow(test_app(Some(url)).await).await;
                sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin).await.unwrap();
            )*
        }
    };
}

on_both_databases! {
    a_trashed_source_is_purged_with_its_secrets_grants_and_history;
    a_source_in_use_is_not_purged;
    purging_is_limited_to_the_organization;
    purging_needs_the_right_to_move_targets;
    restoring_and_purging_at_once_end_in_one_state;
}
