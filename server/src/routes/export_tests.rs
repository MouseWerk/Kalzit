//! The export routes through the real router, with SQLite files as data sources.

/// A request that goes away (the client closed the connection) sets the flag its work watches.
#[test]
fn dropping_the_request_cancels_its_work() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let flag = std::sync::Arc::new(AtomicBool::new(false));
    let guard = super::CancelOnDrop(flag.clone());
    assert!(!flag.load(Ordering::Relaxed));
    drop(guard);
    assert!(flag.load(Ordering::Relaxed));
}

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

use std::collections::HashSet;
use std::sync::Mutex;

use crate::app::{AppState, router};
use crate::clock::ManualClock;
use crate::config::Config;

const SETUP_CODE: &str = "test-setup-code-0123456789";

struct T {
    app: Router,
    state: AppState,
    org: String,
    owner: String,
    dir: tempfile::TempDir,
}

struct Reply {
    status: StatusCode,
    headers: axum::http::HeaderMap,
    bytes: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or(Value::Null)
    }

    fn code(&self) -> String {
        self.json()["error"]["code"].as_str().unwrap_or("").to_string()
    }

    fn reason(&self) -> String {
        self.json()["error"]["reason"].as_str().unwrap_or("").to_string()
    }

    fn header(&self, name: header::HeaderName) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).to_string()
    }
}

impl T {
    async fn new() -> T {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = crate::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock, Some(SETUP_CODE.into())).await.unwrap();
        // Tests run on disks of any size.
        state.export_limits.write().unwrap().keep_free = 0;
        let allowed = dir.path().join("erlaubt");
        std::fs::create_dir_all(&allowed).unwrap();
        state
            .datasources
            .test_settings
            .lock()
            .unwrap()
            .insert("datasources.sqlite_dirs".into(), json!([allowed.to_string_lossy()]));
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = T { app, state, org: String::new(), owner: String::new(), dir };
        let r = t
            .send(
                "/api/setup",
                json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg",
                        "email": "joerg@example.de", "password": "Grün und sicher 2026" }),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.text());
        t.org = r.json()["orgs"][0]["id"].as_str().unwrap().to_string();
        let (owner_id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'joerg@example.de'")
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        t.owner = t.session(&owner_id).await;
        t
    }

    async fn session(&self, user_id: &str) -> String {
        let token =
            crate::auth::session::create(&self.state.db, &self.state.config.sessions, 1_800_000_000_000, user_id)
                .await
                .unwrap();
        format!("kalzit_session={token}")
    }

    /// A new member with `role` (a built-in role or a custom role's id).
    async fn member(&self, name: &str, role: &str) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, 0)")
            .bind(&id)
            .bind(format!("{name}@example.de"))
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
        self.session(&id).await
    }

    async fn send(&self, path: &str, body: Value, cookie: Option<&str>) -> Reply {
        let mut req = Request::builder().method(Method::POST).uri(path).header(header::HOST, "kalzit.test");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = req.header(header::CONTENT_TYPE, "application/json").body(Body::from(body.to_string())).unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Reply { status, headers, bytes }
    }

    async fn post(&self, rest: &str, body: Value, cookie: &str) -> Reply {
        self.send(&format!("/api/orgs/{}{rest}", self.org), body, Some(cookie)).await
    }

    fn allowed_dir(&self) -> PathBuf {
        self.dir.path().join("erlaubt")
    }

    async fn sqlite_source(&self, name: &str, sql: &str) -> String {
        let path = self.allowed_dir().join(format!("{name}.db"));
        let pool = sqlx::SqlitePool::connect(&crate::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_string())).execute(&pool).await.unwrap();
        pool.close().await;
        let r = self
            .post(
                "/datasources",
                json!({ "name": name, "kind": "sqlite", "settings": { "path": path.to_string_lossy() } }),
                &self.owner,
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.text());
        r.json()["id"].as_str().unwrap().to_string()
    }
}

const SALES: &str = "CREATE TABLE verkauf (tag DATE, land TEXT, betrag REAL);
INSERT INTO verkauf VALUES ('2026-01-01', 'Österreich', 1234.5), ('2026-01-02', 'Schweiz', 7.25), ('2026-01-03', '=Formel', NULL);";
const VISITS: &str = "CREATE TABLE besuche (tag DATE, sitzungen INTEGER);
INSERT INTO besuche VALUES ('2026-01-01', 10), ('2026-01-02', 5), ('2026-01-04', 1);";

fn range() -> Value {
    json!({ "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 })
}

fn free(ds: &str, format: &str, language: &str, steps: Value) -> Value {
    json!({
        "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT tag, land, betrag FROM verkauf ORDER BY tag" } }],
        "timeRange": range(), "steps": steps, "format": format, "language": language, "title": "Umsätze 2026"
    })
}

fn brutto() -> Value {
    json!([{ "id": "s1", "type": "calculate", "frame": "A", "name": "brutto", "expression": "round(betrag * 2, 1)" }])
}

#[tokio::test]
async fn free_queries_export_as_german_csv_with_their_steps() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let r = t.post("/export", free(&ds, "csv", "de", brutto()), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.header(header::CONTENT_TYPE), "text/csv; charset=utf-8");
    assert_eq!(r.header(header::CONTENT_DISPOSITION), "attachment; filename=\"Ums-tze-2026.csv\"");
    assert_eq!(r.header(header::CACHE_CONTROL), "no-store");
    let text = r.text();
    assert!(text.starts_with('\u{FEFF}'), "BOM");
    let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
    assert_eq!(lines[0], "tag;land;betrag;brutto");
    assert_eq!(lines[1], "2026-01-01T00:00:00.000Z;Österreich;1234,5;2469");
    assert_eq!(lines[2], "2026-01-02T00:00:00.000Z;Schweiz;7,25;14,5");
    assert_eq!(lines[3], "2026-01-03T00:00:00.000Z;'=Formel;;", "a formula from the data stays text");

    let en = t.post("/export", free(&ds, "csv", "en", json!([])), &t.owner).await;
    assert!(en.text().contains("\r\n2026-01-02T00:00:00.000Z,Schweiz,7.25\r\n"), "{}", en.text());

    // A disabled step is not run.
    let mut off = brutto();
    off[0]["disabled"] = json!(true);
    let r = t.post("/export", free(&ds, "csv", "de", off), &t.owner).await;
    assert!(r.text().contains("tag;land;betrag\r\n"), "{}", r.text());
}

/// Calculated fields read times in the calendar the request names, so the file shows what the
/// panel shows; without one they read UTC with weeks from Monday.
#[tokio::test]
async fn calculated_fields_read_times_in_the_requested_calendar() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let steps = json!([
        { "id": "d", "type": "calculate", "frame": "A", "name": "tagNr", "expression": "day(tag) * 100 + hour(tag)" },
        { "id": "w", "type": "calculate", "frame": "A", "name": "woche", "expression": "day(startOf(tag, 'week'))" }
    ]);
    let file = |calendar: Value| {
        let mut body = free(&ds, "json", "en", steps.clone());
        for (key, value) in calendar.as_object().unwrap() {
            body[key] = value.clone();
        }
        body
    };
    let fields = |r: &Reply| {
        (r.json()["frame"]["fields"][3]["values"].clone(), r.json()["frame"]["fields"][4]["values"].clone())
    };
    // 2026-01-01 (a Thursday) to 2026-01-03 at midnight UTC.
    let r = t.post("/export", file(json!({})), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(fields(&r), (json!([100.0, 200.0, 300.0]), json!([29.0, 29.0, 29.0])));
    // In New York these are the evenings before; a week from Sunday starts on 2025-12-28.
    let r = t.post("/export", file(json!({ "timeZone": "America/New_York", "weekStart": "sunday" })), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(fields(&r), (json!([3119.0, 119.0, 219.0]), json!([28.0, 28.0, 28.0])));

    for (calendar, field) in
        [(json!({ "timeZone": "Europe/Atlantis" }), "timeZone"), (json!({ "weekStart": "friday" }), "weekStart")]
    {
        let r = t.post("/export", file(calendar), &t.owner).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.text());
        assert_eq!(r.json()["error"]["field"], field, "{}", r.text());
    }
}

#[tokio::test]
async fn json_and_excel_files() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let r = t.post("/export", free(&ds, "json", "de", brutto()), &t.owner).await;
    assert_eq!((r.status, r.header(header::CONTENT_TYPE)), (StatusCode::OK, "application/json"), "{}", r.text());
    let body = r.json();
    assert_eq!(body["shape"], "frame");
    assert_eq!(body["frame"]["fields"][3]["name"], "brutto");
    assert_eq!(body["frame"]["fields"][2]["values"], json!([1234.5, 7.25, null]), "JSON keeps decimal points");

    let r = t.post("/export", free(&ds, "xlsx", "de", json!([])), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(r.header(header::CONTENT_TYPE), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert!(r.header(header::CONTENT_DISPOSITION).ends_with(".xlsx\""));
    assert_eq!(&r.bytes[..2], b"PK");
}

#[tokio::test]
async fn joins_span_two_sources_in_one_export() {
    let t = T::new().await;
    let sales = t.sqlite_source("umsatz", SALES).await;
    let visits = t.sqlite_source("besuche", VISITS).await;
    let body = json!({
        "queries": [
            { "refId": "A", "datasourceId": sales, "query": { "sql": "SELECT tag, betrag FROM verkauf" } },
            { "refId": "B", "datasourceId": visits, "query": { "sql": "SELECT tag, sitzungen FROM besuche" } }
        ],
        "timeRange": range(), "format": "csv", "language": "en",
        "steps": [
            { "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "inner" },
            { "id": "c", "type": "calculate", "frame": "A", "name": "perSession", "expression": "A.betrag / B.sitzungen" }
        ]
    });
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let text = r.text();
    let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
    assert_eq!(lines[0], "tag,A.betrag,B.sitzungen,perSession");
    assert_eq!(lines[1], "2026-01-01T00:00:00.000Z,1234.5,10,123.45");
    assert_eq!(lines[2], "2026-01-02T00:00:00.000Z,7.25,5,1.45");
    assert_eq!(lines[3], "");
    assert_eq!(r.header(header::CONTENT_DISPOSITION), "attachment; filename=\"kalzit-export.csv\"");
}

#[tokio::test]
async fn export_needs_the_permission_and_the_same_rights_as_running() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let dashboard = t
        .post(
            "/dashboards",
            json!({ "model": {
                "schemaVersion": 2, "title": "Umsatz", "timeRange": { "from": "now-6h", "to": "now" },
                "panels": [{ "id": "p1", "type": "table", "title": "Verkäufe", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                    "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT land, betrag FROM verkauf ORDER BY tag" } }],
                    "transformations": [
                        { "id": "g", "type": "group", "frame": "A", "by": ["land"], "aggregations": [{ "field": "betrag", "op": "sum", "name": "summe" }] }
                    ] }]
            } }),
            &t.owner,
        )
        .await;
    assert_eq!(dashboard.status, StatusCode::CREATED, "{}", dashboard.text());
    let id = dashboard.json()["id"].as_str().unwrap().to_string();
    let panel = format!("/dashboards/{id}/panels/p1/export");
    let panel_body = json!({ "timeRange": range(), "format": "csv", "language": "en" });

    // Viewers see the panel but may not take its data with them.
    let viewer = t.member("viewer", "viewer").await;
    let r = t.post(&panel, panel_body.clone(), &viewer).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden".into()), "{}", r.text());
    let r = t.post("/export", free(&ds, "csv", "en", json!([])), &viewer).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden".into()));
    // The panel query itself still runs for them.
    let r = t.post(&format!("/dashboards/{id}/panels/p1/query"), json!({ "timeRange": range() }), &viewer).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());

    // Editors hold data:export by default; the stored steps are in the file.
    let editor = t.member("editor", "editor").await;
    let r = t.post(&panel, panel_body.clone(), &editor).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert_eq!(
        r.text(),
        "\u{FEFF}land,summe\r\nÖsterreich,1234.5\r\nSchweiz,7.25\r\n=Formel,\r\n".replace("=Formel", "'=Formel")
    );
    assert_eq!(r.header(header::CONTENT_DISPOSITION), "attachment; filename=\"Verk-ufe.csv\"");

    // Export without query rights: stored panels yes (as viewing them), free queries no.
    let role = t
        .post(
            "/roles",
            json!({ "name": "Berichte", "permissions": ["dashboards:read", "folders:read", "data:export"] }),
            &t.owner,
        )
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.text());
    let reporter = t.member("reporter", role.json()["id"].as_str().unwrap()).await;
    assert_eq!(t.post(&panel, panel_body.clone(), &reporter).await.status, StatusCode::OK);
    let r = t.post("/export", free(&ds, "csv", "en", json!([])), &reporter).await;
    // The data source is not visible to the role at all.
    assert_eq!((r.status, r.code()), (StatusCode::NOT_FOUND, "not_found".into()), "{}", r.text());

    // Without a session, and for unknown panels.
    let r = t.send(&format!("/api/orgs/{}{panel}", t.org), panel_body.clone(), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.post(&format!("/dashboards/{id}/panels/p9/export"), panel_body, &editor).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // Every export is in the audit log, without the data.
    let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT action, resource_id, summary FROM audit_events WHERE action = 'data.exported' ORDER BY created_at, id",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].1.as_deref(), Some(id.as_str()));
    let summary: Value = serde_json::from_str(&rows[0].2).unwrap();
    assert_eq!(
        summary,
        json!({ "format": "csv", "rows": 3, "panelId": "p1", "frame": null,
                "timeRange": { "from": 1_700_000_000_000_i64, "to": 1_800_000_000_000_i64 } })
    );
    // Refusals inside the route are there too: the reporter's free export and the unknown panel.
    let refused: Vec<(Option<String>, String)> = sqlx::query_as(
        "SELECT resource_id, summary FROM audit_events WHERE action = 'data.export_refused' ORDER BY created_at, id",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(refused.len(), 2, "{refused:?}");
    let first: Value = serde_json::from_str(&refused[0].1).unwrap();
    assert_eq!((first["code"].as_str(), first["datasourceIds"][0].as_str()), (Some("not_found"), Some(ds.as_str())));
    assert_eq!(refused[1].0, None, "a panel that does not exist names no dashboard");
}

/// A restricted folder hides its dashboards: their panels cannot be exported either.
#[tokio::test]
async fn panels_in_hidden_folders_are_not_found() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let folder = t.post("/folders", json!({ "name": "Geheim", "restricted": true }), &t.owner).await;
    assert_eq!(folder.status, StatusCode::CREATED, "{}", folder.text());
    let model = json!({
        "schemaVersion": 2, "title": "Geheim", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{ "id": "p1", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT land FROM verkauf" } }] }]
    });
    let created = t.post("/dashboards", json!({ "model": model, "folderId": folder.json()["id"] }), &t.owner).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    let id = created.json()["id"].as_str().unwrap().to_string();
    let editor = t.member("editor", "editor").await;
    let body = json!({ "timeRange": range(), "format": "csv", "language": "en" });
    let r = t.post(&format!("/dashboards/{id}/panels/p1/export"), body.clone(), &editor).await;
    assert_eq!((r.status, r.code()), (StatusCode::NOT_FOUND, "not_found".into()), "{}", r.text());
    assert_eq!(t.post(&format!("/dashboards/{id}/panels/p1/export"), body, &t.owner).await.status, StatusCode::OK);
}

/// A query grant on one data source is enough for a free export of it, as for running it.
#[tokio::test]
async fn a_datasource_grant_allows_its_free_export() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let role = t.post("/roles", json!({ "name": "Export", "permissions": ["data:export"] }), &t.owner).await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.text());
    let role_id = role.json()["id"].as_str().unwrap().to_string();
    let member = t.member("analyst", &role_id).await;
    let r = t.post("/export", free(&ds, "csv", "en", json!([])), &member).await;
    assert_eq!((r.status, r.code()), (StatusCode::NOT_FOUND, "not_found".into()), "{}", r.text());
    let grant = t
        .post(
            "/grants",
            json!({ "subjectType": "role", "subjectId": role_id, "resourceType": "datasource",
                    "resourceId": ds, "level": "query" }),
            &t.owner,
        )
        .await;
    assert_eq!(grant.status, StatusCode::CREATED, "{}", grant.text());
    let r = t.post("/export", free(&ds, "csv", "en", json!([])), &member).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    assert!(r.text().starts_with("\u{FEFF}tag,land,betrag\r\n"), "{}", r.text());
}

/// Text from the data never runs as a formula in a spreadsheet, whatever it starts with.
#[tokio::test]
async fn csv_cells_that_look_like_formulas_are_defused() {
    let t = T::new().await;
    let sql = "CREATE TABLE t (n INTEGER, s TEXT); INSERT INTO t VALUES \
        (1, '+1'), (2, '-1'), (3, '@SUM(A1)'), (4, char(9) || '=1'), (5, char(13) || '=1'), \
        (6, '=cmd|'' /C calc''!A0'), (7, ' =1'), (8, '＝1');";
    let ds = t.sqlite_source("formeln", sql).await;
    let body = json!({ "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT s FROM t ORDER BY n" } }],
                       "timeRange": range(), "format": "csv", "language": "en" });
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    let text = r.text();
    let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
    assert_eq!(
        &lines[1..9],
        ["'+1", "'-1", "'@SUM(A1)", "'\t=1", "\"'\r=1\"", "'=cmd|' /C calc'!A0", "' =1", "'＝1"],
        "{text:?}"
    );
}

#[tokio::test]
async fn failures_name_the_step_or_the_query() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let unknown = json!([{ "id": "s1", "type": "calculate", "frame": "A", "name": "x", "expression": "preis * 2" }]);
    let r = t.post("/export", free(&ds, "csv", "de", unknown), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "expression.unknown_field".into()));
    assert_eq!(r.json()["error"]["field"], "steps");
    assert_eq!(r.json()["error"]["params"]["field"], "preis");
    assert!(r.json()["error"]["message"].as_str().unwrap().starts_with("step 1:"));

    let invalid = json!([{ "id": "s1", "type": "calculate", "frame": "Z", "name": "x", "expression": "1" }]);
    let r = t.post("/export", free(&ds, "csv", "de", invalid), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "steps.invalid".into()));

    let mut body = free(&ds, "csv", "de", json!([]));
    body["queries"][0]["query"]["sql"] = json!("DELETE FROM verkauf");
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::UNPROCESSABLE_ENTITY, "query_rejected".into()), "{}", r.text());

    let mut body = free(&ds, "csv", "de", json!([]));
    body["frame"] = json!("B");
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "export.frame_missing".into()));

    let mut body = free(&ds, "pdf", "de", json!([]));
    body["format"] = json!("pdf");
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "unknown formats are refused");

    // Nothing failed was written to the audit log.
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action = 'data.exported'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

/// More exports than the server makes at once are answered busy, before any query runs.
#[tokio::test]
async fn too_many_exports_at_once_are_busy() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let model = json!({ "model": {
        "schemaVersion": 2, "title": "Umsatz", "timeRange": { "from": "now-6h", "to": "now" },
        "panels": [{ "id": "p1", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
            "targets": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT land FROM verkauf" } }] }]
    } });
    let id = t.post("/dashboards", model, &t.owner).await.json()["id"].as_str().unwrap().to_string();
    let panel = format!("/dashboards/{id}/panels/p1/export");
    let panel_body = json!({ "timeRange": range(), "format": "csv", "language": "en" });
    // Two slots are taken: one export still runs.
    let two = t.state.exports.clone().acquire_many_owned(super::MAX_EXPORTS as u32 - 1).await.unwrap();
    assert_eq!(t.post("/export", free(&ds, "csv", "en", json!([])), &t.owner).await.status, StatusCode::OK);
    let held = t.state.exports.clone().acquire_owned().await.unwrap();
    for r in [
        t.post("/export", free(&ds, "csv", "en", json!([])), &t.owner).await,
        t.post(&panel, panel_body.clone(), &t.owner).await,
    ] {
        assert_eq!(
            (r.status, r.code(), r.reason()),
            (StatusCode::SERVICE_UNAVAILABLE, "busy".into(), "export.busy".into()),
            "{}",
            r.text()
        );
    }
    drop((two, held));
    assert_eq!(t.post(&panel, panel_body, &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.state.exports.available_permits(), super::MAX_EXPORTS, "every slot is given back");
}

/// The time limit of an export's steps answers as a query timeout.
#[test]
fn a_late_export_answers_query_timeout() {
    let e = super::step_error("step 1: late".into(), crate::datasources::detail::Detail::new("steps.timeout", "late"));
    assert_eq!((e.status, e.code), (StatusCode::GATEWAY_TIMEOUT, "query_timeout"));
    let e = super::step_error("step 1: no".into(), crate::datasources::detail::Detail::new("steps.name_taken", "no"));
    assert_eq!((e.status, e.code, e.field), (StatusCode::UNPROCESSABLE_ENTITY, "validation", Some("steps")));
}

type Hold = (std::sync::mpsc::SyncSender<()>, std::sync::mpsc::Receiver<()>);

/// Set by a test that wants an export's blocking work to stop at its start: the work says it
/// started and waits until the test lets it go.
static HOLD: std::sync::Mutex<Option<Hold>> = std::sync::Mutex::new(None);

/// Called by the export's blocking work; only steps with the id `hold-for-test` wait.
pub(super) fn hold_if_asked(steps: &[crate::analysis::Step]) {
    if !steps.iter().any(|s| s.id == "hold-for-test") {
        return;
    }
    let (started, release) = HOLD.lock().unwrap().take().expect("a test set up the hold");
    started.send(()).unwrap();
    let _ = release.recv();
}

/// A client that goes away while its file is made does not free the slot early: the work holds
/// it until it has stopped.
#[tokio::test]
async fn an_aborted_export_holds_its_slot_until_the_work_stops() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    *HOLD.lock().unwrap() = Some((started_tx, release_rx));
    let steps = json!([{ "id": "hold-for-test", "type": "calculate", "frame": "A", "name": "x", "expression": "1" }]);
    let body = free(&ds, "csv", "en", steps);
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/orgs/{}/export", t.org))
        .header(header::HOST, "kalzit.test")
        .header(header::COOKIE, &t.owner)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let request = tokio::spawn(t.app.clone().oneshot(req));
    tokio::task::spawn_blocking(move || started_rx.recv().unwrap()).await.unwrap();
    assert_eq!(t.state.exports.available_permits(), super::MAX_EXPORTS - 1);
    // The client goes away while the file is being made.
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    assert_eq!(t.state.exports.available_permits(), super::MAX_EXPORTS - 1, "the work still holds the slot");
    release_tx.send(()).unwrap();
    let freed = async {
        while t.state.exports.available_permits() != super::MAX_EXPORTS {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(10), freed)
        .await
        .expect("the slot comes back once the work stops");
}

const BIG: &str = "CREATE TABLE gross (n INTEGER, s TEXT);
WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 20000)
INSERT INTO gross SELECT x, printf('%0600d', x) FROM c;";

impl T {
    /// The response before its body is read: what a client has when the headers arrive.
    async fn raw(&self, rest: &str, body: Value, cookie: &str) -> axum::response::Response {
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!("/api/orgs/{}{rest}", self.org))
            .header(header::HOST, "kalzit.test")
            .header(header::COOKIE, cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        self.app.clone().oneshot(req).await.unwrap()
    }

    async fn audit_count(&self, action: &str) -> i64 {
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action = $1")
            .bind(action)
            .fetch_one(&self.state.db)
            .await
            .unwrap();
        n
    }

    async fn slots_free(&self) {
        let freed = async {
            while self.state.exports.available_permits() != super::MAX_EXPORTS {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(20), freed).await.expect("the slot comes back");
    }
}

fn big(ds: &str, format: &str) -> Value {
    json!({
        "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT n, s FROM gross ORDER BY n" } }],
        "timeRange": range(), "format": format, "language": "en", "title": "gross"
    })
}

fn tiny(ds: &str) -> Value {
    let mut body = big(ds, "csv");
    body["queries"][0]["query"]["sql"] = json!("SELECT n, s FROM gross LIMIT 3");
    body
}

/// Organizations whose `data.exported` audit entry fails, set by the test of that failure.
static FAILING_AUDIT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub(super) fn audit_fails(org_id: &str) -> bool {
    FAILING_AUDIT.lock().unwrap().as_ref().is_some_and(|s| s.contains(org_id))
}

impl T {
    fn spool_files(&self) -> usize {
        std::fs::read_dir(self.state.config.paths.data_dir.join(super::SPOOL_DIR)).map(|d| d.count()).unwrap_or(0)
    }

    async fn spool_empty(&self) {
        for _ in 0..400 {
            if self.spool_files() == 0 {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("the spool folder is not empty");
    }

    async fn aborted(&self) -> Value {
        for _ in 0..400 {
            if self.audit_count("data.export_aborted").await == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let (summary,): (String,) =
            sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'data.export_aborted'")
                .fetch_one(&self.state.db)
                .await
                .unwrap();
        serde_json::from_str(&summary).unwrap()
    }
}

/// The file is made before it is sent: while a client reads nothing, no server slot is held (only
/// its user's own), a second export of that user is refused and another user's is not, and a
/// client that goes away ends the sending, frees its user slot and its spool file, and is
/// recorded as an aborted export.
#[tokio::test]
async fn a_slow_reader_holds_no_server_slot_and_a_vanished_client_stops_it() {
    let t = T::new().await;
    let ds = t.sqlite_source("gross", BIG).await;
    let r = t.raw("/export", big(&ds, "csv"), &t.owner).await;
    assert_eq!(r.status(), StatusCode::OK);
    let mut body = r.into_body();
    let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(first.len(), 1024 * 1024, "the first chunk comes before the file is sent whole");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(t.state.exports.available_permits(), super::MAX_EXPORTS, "the server's slots are free");
    assert_eq!(t.spool_files(), 1, "the file waits on disk");
    assert_eq!(t.audit_count("data.exported").await, 0, "not recorded before the end");
    // One export per user at a time.
    let again = t.post("/export", big(&ds, "csv"), &t.owner).await;
    assert_eq!((again.status, again.reason()), (StatusCode::SERVICE_UNAVAILABLE, "export.user_busy".into()));
    let (_, other) = (0, t.member("anna", "editor").await);
    let r = t.post("/export", tiny(&ds), &other).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text());
    drop(body);
    t.slots_free().await;
    let summary = t.aborted().await;
    assert_eq!(summary["reason"], "export.client_gone");
    assert!(summary["bytes"].as_u64().unwrap() >= 1024 * 1024, "{summary}");
    assert!(summary["of"].as_u64().unwrap() > summary["bytes"].as_u64().unwrap());
    assert_eq!(t.audit_count("data.exported").await, 1, "only the other user's");
    t.spool_empty().await;
    // The user can export again.
    assert_eq!(t.post("/export", tiny(&ds), &t.owner).await.status, StatusCode::OK);
}

/// A client that takes nothing for the stall time, or whose download passes the total time, loses
/// its export with the reason named.
#[tokio::test]
async fn a_stalled_or_endless_download_is_broken_off() {
    for (stall_ms, download_ms, reason) in [(300, 60_000, "export.stalled"), (60_000, 300, "export.download_too_long")]
    {
        let t = T::new().await;
        {
            let mut limits = t.state.export_limits.write().unwrap();
            limits.stall = std::time::Duration::from_millis(stall_ms);
            limits.download = std::time::Duration::from_millis(download_ms);
        }
        let ds = t.sqlite_source("gross", BIG).await;
        let r = t.raw("/export", big(&ds, "csv"), &t.owner).await;
        let mut body = r.into_body();
        let first = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(first.len(), 1024 * 1024);
        // Read nothing: the sending task gives up by itself.
        let summary = t.aborted().await;
        assert_eq!(summary["reason"], reason, "{summary}");
        t.slots_free().await;
        t.spool_empty().await;
        // What the client still gets ends in an error, not in a file that looks whole.
        let mut ended_badly = false;
        while let Some(frame) = body.frame().await {
            if frame.is_err() {
                ended_badly = true;
                break;
            }
        }
        assert!(ended_badly, "{reason}");
        assert_eq!(t.audit_count("data.exported").await, 0);
    }
}

/// The size limit is an ordinary error answer, before anything is sent, with nothing left behind.
#[tokio::test]
async fn a_file_over_the_size_limit_is_refused_before_it_is_sent() {
    let t = T::new().await;
    t.state.export_limits.write().unwrap().file_bytes = 2 * 1024 * 1024;
    let ds = t.sqlite_source("gross", BIG).await;
    let r = t.post("/export", big(&ds, "csv"), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::UNPROCESSABLE_ENTITY, "export.too_large".into()), "{}", r.text());
    assert_eq!(t.audit_count("data.export_refused").await, 1);
    assert_eq!(t.audit_count("data.export_aborted").await, 0);
    t.slots_free().await;
    t.spool_empty().await;
    // The user's slot is free again.
    t.state.export_limits.write().unwrap().file_bytes = 256 * 1024 * 1024;
    assert_eq!(t.post("/export", tiny(&ds), &t.owner).await.status, StatusCode::OK);
}

/// Too little disk space is refused up front.
#[tokio::test]
async fn too_little_disk_space_refuses_the_export() {
    let t = T::new().await;
    t.state.export_limits.write().unwrap().keep_free = u64::MAX / 2;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let r = t.post("/export", free(&ds, "csv", "en", json!([])), &t.owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::SERVICE_UNAVAILABLE, "export.disk_space".into()), "{}", r.text());
    t.slots_free().await;
}

/// When the audit entry cannot be written the download is broken off instead of completing.
#[tokio::test]
async fn a_failing_audit_entry_breaks_the_download_off() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    FAILING_AUDIT.lock().unwrap().get_or_insert_with(HashSet::new).insert(t.org.clone());
    let r = t.raw("/export", free(&ds, "csv", "en", json!([])), &t.owner).await;
    assert_eq!(r.status(), StatusCode::OK);
    let collected = r.into_body().collect().await;
    assert!(collected.is_err(), "the client must not get a complete file that was not recorded");
    assert_eq!(t.audit_count("data.exported").await, 0);
    FAILING_AUDIT.lock().unwrap().as_mut().unwrap().remove(&t.org);
    t.slots_free().await;
    t.spool_empty().await;
}

/// Files left by a run that was cut short are removed when the server starts.
#[test]
fn leftover_spool_files_are_removed_at_start() {
    let dir = tempfile::tempdir().unwrap();
    let spool = dir.path().join(super::SPOOL_DIR);
    std::fs::create_dir_all(&spool).unwrap();
    std::fs::write(spool.join("export-old.part"), b"x").unwrap();
    super::clear_spool(dir.path());
    assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
}

/// Read to the end, the streamed file is whole and its audit entry exists by then.
#[tokio::test]
async fn a_large_export_arrives_whole_with_its_audit_entry() {
    let t = T::new().await;
    let ds = t.sqlite_source("gross", BIG).await;
    let r = t.post("/export", big(&ds, "csv"), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.bytes.len() > 10 * 1024 * 1024, "{}", r.bytes.len());
    let text = r.text();
    assert_eq!(text.matches("\r\n").count(), 20_001);
    assert!(text.trim_end().ends_with(&format!("20000,{:0>600}", 20000)));
    assert_eq!(t.audit_count("data.exported").await, 1);
    assert_eq!(t.audit_count("data.export_aborted").await, 0);
    let (summary,): (String,) = sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'data.exported'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&summary).unwrap()["rows"], 20_000);

    let r = t.post("/export", big(&ds, "json"), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.json()["frame"]["fields"][0]["values"].as_array().unwrap().len(), 20_000);
}

/// Excel files are written in constant memory mode: more cells than the former limit of a million,
/// sent from a spool file that is gone afterwards.
#[tokio::test]
async fn excel_exports_have_no_cell_limit_and_leave_no_spool_files() {
    let t = T::new().await;
    let sql = "CREATE TABLE w (a INTEGER); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 90000) \
               INSERT INTO w SELECT x FROM c;";
    let ds = t.sqlite_source("breit", sql).await;
    let cols: Vec<String> = (0..12).map(|i| format!("a + {i} AS c{i}")).collect();
    let body = json!({
        "queries": [{ "refId": "A", "datasourceId": ds, "query": { "sql": format!("SELECT {} FROM w", cols.join(", ")) } }],
        "timeRange": range(), "format": "xlsx", "language": "en"
    });
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.bytes[..r.bytes.len().min(300)]));
    assert_eq!(&r.bytes[..2], b"PK");
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&r.bytes[..])).unwrap();
    let mut sheet = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("xl/worksheets/sheet1.xml").unwrap(), &mut sheet).unwrap();
    assert!(sheet.contains(r#"<dimension ref="A1:L90001"/>"#), "{}", &sheet[..300.min(sheet.len())]);
    t.slots_free().await;
    let spool = t.state.config.paths.data_dir.join(super::SPOOL_DIR);
    let left = std::fs::read_dir(&spool).map(|d| d.count()).unwrap_or(0);
    assert_eq!(left, 0, "the spool files are removed");
}

/// A failure before the first chunk is an ordinary error answer: refused in the audit log, never
/// an aborted export.
#[tokio::test]
async fn an_export_that_fails_before_its_first_chunk_is_a_plain_error_without_an_aborted_entry() {
    let t = T::new().await;
    let ds = t.sqlite_source("umsatz", SALES).await;
    let mut body = free(&ds, "csv", "en", json!([]));
    body["frame"] = json!("B");
    let r = t.post("/export", body, &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(t.audit_count("data.export_refused").await, 1);
    assert_eq!(t.audit_count("data.export_aborted").await, 0);
    t.slots_free().await;
}
