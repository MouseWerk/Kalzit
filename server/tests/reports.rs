//! Reports through the real router, a real SQLite source and the worker with a manual clock (on
//! PostgreSQL too when `KALZIT_TEST_POSTGRES_URL` is set). A fake mailer keeps the mails; it fails
//! on demand where the retry and the failure mail are checked.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use kalzit::mail::message::{Attachment, Content};
use kalzit::reports::run::{MailFailure, Mailer};
use kalzit::reports::worker;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
/// 2027-01-15 08:00 UTC, 09:00 in Berlin.
const START: i64 = 1_800_000_000_000;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    sources: tempfile::TempDir,
    org: String,
    owner: String,
    owner_id: String,
    schema: Option<common::PgSchema>,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
    bytes: Vec<u8>,
}

#[derive(Clone)]
enum Who {
    Owner,
    Cookie(String),
    Token(String),
}

/// A mail the fake kept.
#[derive(Clone, Debug)]
struct Sent {
    to: String,
    subject: String,
    text: String,
    files: Vec<(String, Vec<u8>)>,
    unsubscribe: Option<String>,
}

#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<Sent>>,
    /// Every send fails as if the mail server could not be reached, except to these addresses.
    down: AtomicBool,
    reachable: Mutex<Vec<String>>,
    /// The mail server refuses these addresses (and only them).
    refused: Mutex<Vec<String>>,
}

impl Mailer for Fake {
    fn send<'a>(
        &'a self,
        to: &'a str,
        content: &'a Content,
        attachments: &'a [Attachment],
        unsubscribe: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), MailFailure>> {
        Box::pin(async move {
            if self.down.load(Ordering::SeqCst) && !self.reachable.lock().unwrap().iter().any(|r| r == to) {
                return Err(MailFailure { reason: "mail.connection_lost".into(), connection: true });
            }
            if self.refused.lock().unwrap().iter().any(|r| r == to) {
                return Err(MailFailure { reason: "mail.recipient_refused".into(), connection: false });
            }
            self.sent.lock().unwrap().push(Sent {
                to: to.to_string(),
                subject: content.subject.clone(),
                text: content.text.clone(),
                files: attachments.iter().map(|a| (a.name.clone(), a.data.clone())).collect(),
                unsubscribe: unsubscribe.map(str::to_string),
            });
            Ok(())
        })
    }
}

impl Fake {
    fn take(&self) -> Vec<Sent> {
        self.sent.lock().unwrap().drain(..).collect()
    }
}

impl TestApp {
    async fn new() -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        // A mail server is set up; the fake mailer stands in for it.
        config.smtp.host = "127.0.0.1".into();
        config.smtp.port = 9;
        config.smtp.security = "none".into();
        config.smtp.from_name = "Kalzit".into();
        config.smtp.from_address = "kalzit@example.com".into();
        config.server.public_url = Some("https://kalzit.test".into());
        let schema = common::database().await;
        config.database.url = schema.as_ref().map(|s| s.url.clone());
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(START));
        let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = TestApp {
            app,
            clock,
            state,
            dir: Arc::new(dir),
            sources: common::private_tempdir(),
            org: String::new(),
            owner: String::new(),
            owner_id: String::new(),
            schema,
        };
        let r = t
            .raw(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "MouseWerk", "name": "Lea Hoffmann",
                             "email": "lea@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        t.owner_id = r.body["user"]["id"].as_str().or_else(|| r.body["id"].as_str()).unwrap_or_default().to_string();
        if t.owner_id.is_empty() {
            let (id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'lea@example.de'")
                .fetch_one(&t.state.db)
                .await
                .unwrap();
            t.owner_id = id;
        }
        t
    }

    async fn finish(mut self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone()).with_schema(self.schema.take());
        let sources = std::mem::replace(&mut self.sources, tempfile::tempdir().unwrap());
        drop(self);
        finish.finish().await;
        common::remove_dir(sources);
    }

    async fn raw(&mut self, method: Method, path: &str, body: Option<Value>, who: Option<&Who>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        match who {
            Some(Who::Owner) => req = req.header(header::COOKIE, self.owner.clone()),
            Some(Who::Cookie(c)) => req = req.header(header::COOKIE, c.clone()),
            Some(Who::Token(t)) => req = req.header(header::AUTHORIZATION, format!("Bearer {t}")),
            None => {}
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        if let Some(set) = headers.get(header::SET_COOKIE) {
            let set = set.to_str().unwrap();
            if set.starts_with("kalzit_session=") && self.owner.is_empty() {
                self.owner = set.split(';').next().unwrap().to_string();
            }
        }
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Reply { status, headers, body, bytes }
    }

    async fn call(&mut self, who: &Who, method: Method, rest: &str, body: Option<Value>) -> Reply {
        let path = format!("/api/orgs/{}{rest}", self.org);
        self.raw(method, &path, body, Some(who)).await
    }

    /// A person with `role` in the organization, signed in; answers their id and session.
    async fn person(&mut self, name: &str, email: &str, role: &str) -> (String, Who) {
        let r = self
            .raw(
                Method::POST,
                "/api/admin/users",
                Some(json!({ "name": name, "email": email, "password": PASSWORD })),
                Some(&Who::Owner),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let id = r.body["id"].as_str().unwrap().to_string();
        let r = self.call(&Who::Owner, Method::POST, "/members", Some(json!({ "email": email, "role": role }))).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let r = self
            .raw(Method::POST, "/api/auth/login", Some(json!({ "email": email, "password": PASSWORD })), None)
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let cookie =
            r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap().split(';').next().unwrap().to_string();
        (id, Who::Cookie(cookie))
    }

    async fn set_role(&mut self, user_id: &str, role: &str) {
        let r =
            self.call(&Who::Owner, Method::PATCH, &format!("/members/{user_id}"), Some(json!({ "role": role }))).await;
        assert!(r.status.is_success(), "{}", r.body);
    }

    async fn as_role(&mut self, role: &str) -> Who {
        let body = json!({ "name": format!("{role}-1"), "role": role });
        let r = self.call(&Who::Owner, Method::POST, "/service-accounts", Some(body)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let id = r.body["id"].as_str().unwrap().to_string();
        let r = self
            .call(&Who::Owner, Method::POST, &format!("/service-accounts/{id}/tokens"), Some(json!({ "name": "t" })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        Who::Token(r.body["token"].as_str().unwrap().to_string())
    }

    async fn server_setting(&mut self, key: &str, value: Value) {
        let path = format!("/api/admin/settings/{key}");
        let mut r =
            self.raw(Method::PATCH, &path, Some(json!({ "value": value, "version": 0 })), Some(&Who::Owner)).await;
        if r.status == StatusCode::CONFLICT {
            let version = r.body["current"]["version"].clone();
            r = self
                .raw(Method::PATCH, &path, Some(json!({ "value": value, "version": version })), Some(&Who::Owner))
                .await;
        }
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    async fn org_setting(&mut self, key: &str, value: Value) {
        let path = format!("/settings/{key}");
        let mut r = self.call(&Who::Owner, Method::PATCH, &path, Some(json!({ "value": value, "version": 0 }))).await;
        if r.status == StatusCode::CONFLICT {
            let version = r.body["current"]["version"].clone();
            r = self.call(&Who::Owner, Method::PATCH, &path, Some(json!({ "value": value, "version": version }))).await;
        }
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    /// A SQLite source with `umsatz (region TEXT, betrag REAL)` and a dashboard with a table, a
    /// stat and a text panel; answers the dashboard's id.
    async fn dashboard(&mut self, folder: Option<&str>) -> String {
        let dir = self.sources.path().to_string_lossy().to_string();
        self.server_setting("datasources.sqlite_dirs", json!([dir])).await;
        let path = self.sources.path().join("lager.db");
        let pool = sqlx::SqlitePool::connect(&kalzit::config::sqlite_url(&path)).await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE IF NOT EXISTS umsatz (region TEXT, betrag REAL); DELETE FROM umsatz; \
                       INSERT INTO umsatz VALUES ('Nord', 1234.5), ('Süd', 99.0);",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;
        let body = json!({ "name": format!("Lager {}", uuid::Uuid::now_v7()), "kind": "sqlite",
                           "settings": { "path": path.to_string_lossy() } });
        let r = self.call(&Who::Owner, Method::POST, "/datasources", Some(body)).await;
        assert!(r.status.is_success(), "{}", r.body);
        let ds = r.body["id"].as_str().unwrap().to_string();
        let target = json!([{ "refId": "A", "datasourceId": ds, "query": { "sql": "SELECT region, betrag FROM umsatz ORDER BY region" } }]);
        let model = json!({ "schemaVersion": 2, "title": "Lagerbericht", "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [
                { "id": "p1", "type": "table", "title": "Umsatz je Region", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 }, "targets": target },
                { "id": "p2", "type": "stat", "title": "Summe", "grid": { "x": 12, "y": 0, "w": 12, "h": 8 }, "targets": target },
                { "id": "p3", "type": "text", "title": "Hinweis", "grid": { "x": 0, "y": 8, "w": 24, "h": 4 },
                  "options": { "mode": "markdown", "content": "Zahlen vorläufig" } }
            ] });
        let mut body = json!({ "model": model });
        if let Some(folder) = folder {
            body["folderId"] = json!(folder);
        }
        let r = self.call(&Who::Owner, Method::POST, "/dashboards", Some(body)).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    fn report_body(&self, dashboard: &str, recipients: Value) -> Value {
        json!({
            "name": "Lager täglich",
            "dashboardId": dashboard,
            "schedule": { "kind": "daily", "time": "10:00" },
            "timeZone": "Europe/Berlin",
            "formats": ["pdf", "csv"],
            "language": "de",
            "recipients": recipients,
        })
    }

    async fn create(&mut self, who: &Who, body: Value) -> Reply {
        self.call(who, Method::POST, "/reports", Some(body)).await
    }

    async fn run(&self, fake: &Fake) -> usize {
        worker::run_due(&self.state, fake).await.unwrap()
    }

    fn advance(&self, ms: i64) {
        self.clock.advance_ms(ms);
    }

    async fn runs(&mut self, report: &str) -> Vec<Value> {
        let r = self.call(&Who::Owner, Method::GET, &format!("/reports/{report}/runs"), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body["items"].as_array().unwrap().clone()
    }
}

fn reason(r: &Reply) -> &str {
    r.body["error"]["reason"].as_str().or_else(|| r.body["error"]["reason"]["code"].as_str()).unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scheduled_report_arrives_as_pdf_and_csv_at_its_time() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    // 09:00 in Berlin now: the first run is today at 10:00.
    assert_eq!(r.body["nextRunAt"], json!(START + HOUR));
    assert_eq!(r.body["ownerId"], json!(owner_id));
    let fake = Fake::default();
    assert_eq!(t.run(&fake).await, 0, "not before its time");
    t.advance(HOUR);
    assert_eq!(t.run(&fake).await, 1);
    let mails = fake.take();
    assert_eq!(mails.len(), 1);
    let mail = &mails[0];
    assert_eq!(mail.to, "lea@example.de");
    assert_eq!(mail.subject, "Bericht: Lager täglich");
    assert!(mail.unsubscribe.is_none(), "members get no unsubscribe address");
    assert!(!mail.text.contains("https://"), "no link into Kalzit: {}", mail.text);
    let names: Vec<&str> = mail.files.iter().map(|f| f.0.as_str()).collect();
    assert_eq!(names, ["Lager-t-glich.pdf", "Lager-t-glich.zip"]);
    assert!(mail.files[0].1.starts_with(b"%PDF-"));
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(mail.files[1].1.clone())).unwrap();
    assert_eq!(zip.len(), 2, "the table and the stat panel");
    let mut csv = String::new();
    std::io::Read::read_to_string(&mut zip.by_name("Umsatz-je-Region.csv").unwrap(), &mut csv).unwrap();
    assert_eq!(csv, "\u{feff}region;betrag\r\nNord;1234,5\r\nSüd;99\r\n");
    let runs = t.runs(&id).await;
    assert_eq!(runs[0]["status"], "ok", "{runs:?}");
    assert_eq!((runs[0]["sent"].as_i64(), runs[0]["scheduledFor"].as_i64()), (Some(1), Some(START + HOUR)));
    assert!(runs[0]["pages"].as_i64().unwrap() >= 1);
    // The next run is tomorrow at 10:00.
    let r = t.call(&Who::Owner, Method::GET, &format!("/reports/{id}"), None).await;
    assert_eq!(r.body["nextRunAt"], json!(START + HOUR + 24 * HOUR));
    assert_eq!(t.run(&fake).await, 0);
    // A whole day without a server: the missed time is recorded, never made up.
    t.advance(25 * HOUR + 30 * MINUTE);
    assert_eq!(t.run(&fake).await, 0);
    assert!(fake.take().is_empty());
    assert_eq!(t.runs(&id).await[0]["status"], "skipped");
    assert_eq!(t.runs(&id).await[0]["error"]["code"], "reports.missed");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_creators_rights_are_checked_at_every_run() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let (editor_id, editor) = t.person("Nora Berg", "nora@example.de", "editor").await;
    let owner_id = t.owner_id.clone();
    let r = t.create(&editor, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    // The owner changes the report; it keeps running with the creator's rights.
    let mut body = t.report_body(&dashboard, json!([{ "userId": owner_id }]));
    body["version"] = json!(1);
    body["name"] = json!("Lager jeden Tag");
    let r = t.call(&Who::Owner, Method::PUT, &format!("/reports/{id}"), Some(body.clone())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["ownerId"], json!(editor_id));
    let r = t.call(&Who::Owner, Method::PUT, &format!("/reports/{id}"), Some(body)).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "an old version: {}", r.body);
    // The creator becomes a viewer: the report is suspended, nothing is sent.
    t.set_role(&editor_id, "viewer").await;
    let fake = Fake::default();
    t.advance(HOUR);
    assert_eq!(t.run(&fake).await, 1);
    assert!(fake.take().is_empty());
    let run = &t.runs(&id).await[0];
    assert_eq!(
        (run["status"].as_str(), run["error"]["code"].as_str()),
        (Some("suspended"), Some("reports.creator_no_permission"))
    );
    let r = t.call(&Who::Owner, Method::GET, &format!("/reports/{id}"), None).await;
    assert_eq!(r.body["suspended"]["code"], "reports.creator_no_permission", "{}", r.body);
    // The right comes back: the next time runs and the suspension ends.
    t.set_role(&editor_id, "editor").await;
    t.advance(24 * HOUR);
    assert_eq!(t.run(&fake).await, 1);
    assert_eq!(fake.take().len(), 1);
    let r = t.call(&Who::Owner, Method::GET, &format!("/reports/{id}"), None).await;
    assert_eq!(r.body["suspended"], Value::Null);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn recipients_must_read_the_dashboard() {
    let mut t = TestApp::new().await;
    let r = t.call(&Who::Owner, Method::POST, "/folders", Some(json!({ "name": "Geheim", "restricted": true }))).await;
    assert!(r.status.is_success(), "{}", r.body);
    let folder = r.body["id"].as_str().unwrap().to_string();
    let secret = t.dashboard(Some(&folder)).await;
    let open = t.dashboard(None).await;
    let (viewer_id, _) = t.person("Ole Viewer", "ole@example.de", "viewer").await;
    let r = t.create(&Who::Owner, t.report_body(&secret, json!([{ "userId": viewer_id }]))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!(
        (r.body["error"]["field"].as_str(), reason(&r)),
        (Some("recipients"), "reports.recipient_no_access"),
        "{}",
        r.body
    );
    // Viewers receive reports of dashboards they can read.
    let owner_id = t.owner_id.clone();
    let r = t.create(&Who::Owner, t.report_body(&open, json!([{ "userId": viewer_id }, { "userId": owner_id }]))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    // A recipient who left is left out of the run and counted.
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/members/{viewer_id}"), None).await;
    assert!(r.status.is_success(), "{}", r.body);
    let fake = Fake::default();
    t.advance(HOUR);
    t.run(&fake).await;
    let mails = fake.take();
    assert_eq!(mails.iter().map(|m| m.to.as_str()).collect::<Vec<_>>(), ["lea@example.de"]);
    let run = &t.runs(&id).await[0];
    assert_eq!((run["status"].as_str(), run["skippedRecipients"].as_i64()), (Some("partial"), Some(1)), "{run}");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pausing_always_works_and_resuming_checks_the_report() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let mut body = t.report_body(&dashboard, json!([{ "userId": owner_id }]));
    body["formats"] = json!(["pdf"]);
    body["panelIds"] = json!(["p1"]);
    let r = t.create(&Who::Owner, body).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    let version = r.body["version"].as_i64().unwrap();
    // The panel leaves the dashboard: the report could no longer be saved as it is.
    let d = t.call(&Who::Owner, Method::GET, &format!("/dashboards/{dashboard}"), None).await;
    let mut model = d.body["model"].clone();
    model["panels"].as_array_mut().unwrap().remove(0);
    let r = t
        .call(
            &Who::Owner,
            Method::PUT,
            &format!("/dashboards/{dashboard}"),
            Some(json!({ "model": model, "version": d.body["version"] })),
        )
        .await;
    assert!(r.status.is_success(), "{}", r.body);
    // Viewers cannot pause, and a stale version answers with the current report.
    let viewer = t.as_role("viewer").await;
    let r = t.call(&viewer, Method::POST, &format!("/reports/{id}/pause"), Some(json!({ "version": version }))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t
        .call(&Who::Owner, Method::POST, &format!("/reports/{id}/pause"), Some(json!({ "version": version + 7 })))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    assert_eq!(r.body["error"]["code"], "version_conflict");
    assert_eq!(r.body["current"]["version"], version);
    // Pausing works all the same and rests the schedule.
    let r =
        t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/pause"), Some(json!({ "version": version }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["paused"].as_bool(), r.body["nextRunAt"].is_null()), (Some(true), true), "{}", r.body);
    let paused = r.body["version"].as_i64().unwrap();
    assert_eq!(paused, version + 1);
    let fake = Fake::default();
    t.advance(2 * HOUR);
    assert_eq!(t.run(&fake).await, 0);
    // Resuming checks the report as a save would, and refuses it while the panel is gone.
    let r =
        t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/resume"), Some(json!({ "version": paused }))).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!(reason(&r), "reports.panel_unknown", "{}", r.body);
    let r = t.call(&Who::Owner, Method::GET, &format!("/reports/{id}"), None).await;
    assert_eq!((r.body["paused"].as_bool(), r.body["version"].as_i64()), (Some(true), Some(paused)), "{}", r.body);
    // With the whole dashboard it resumes and has a next run again.
    let mut whole = t.report_body(&dashboard, json!([{ "userId": owner_id }]));
    whole["formats"] = json!(["pdf"]);
    whole["paused"] = json!(true);
    whole["version"] = json!(paused);
    let r = t.call(&Who::Owner, Method::PUT, &format!("/reports/{id}"), Some(whole)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let saved = r.body["version"].as_i64().unwrap();
    let r =
        t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/resume"), Some(json!({ "version": saved }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["paused"].as_bool(), r.body["nextRunAt"].is_i64()), (Some(false), true), "{}", r.body);
    // Both are in the audit log as changes of the report.
    let (changes,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action = 'report.updated'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(changes, 3, "pause, the save and resume");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outside_addresses_need_the_setting_and_can_unsubscribe() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let recipients = json!([{ "userId": owner_id }, { "email": "Partner@Example.com" }]);
    let r = t.create(&Who::Owner, t.report_body(&dashboard, recipients.clone())).await;
    assert_eq!(reason(&r), "reports.external_not_allowed", "{}", r.body);
    t.org_setting("reports.allow_external_recipients", json!(true)).await;
    t.org_setting("reports.external_domains", json!(["partner.example"])).await;
    let r = t.create(&Who::Owner, t.report_body(&dashboard, recipients.clone())).await;
    assert_eq!(reason(&r), "reports.external_domain_not_allowed", "{}", r.body);
    t.org_setting("reports.external_domains", json!([])).await;
    let r = t.create(&Who::Owner, t.report_body(&dashboard, recipients)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(r.body["recipients"][1]["email"], "partner@example.com");
    let fake = Fake::default();
    t.advance(HOUR);
    t.run(&fake).await;
    let mails = fake.take();
    let outside = mails.iter().find(|m| m.to == "partner@example.com").expect("the outside address got it");
    let link = outside.unsubscribe.clone().expect("a one-click unsubscribe");
    assert!(link.starts_with("https://kalzit.test/api/reports/unsubscribe/"), "{link}");
    assert!(!link.contains("partner"), "the address is not in the link");
    let path = link.trim_start_matches("https://kalzit.test");
    let r = t.raw(Method::GET, path, None, None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(String::from_utf8_lossy(&r.bytes).contains("<form method=\"post\""));
    let r = t.raw(Method::POST, path, None, None).await;
    assert_eq!(r.status, StatusCode::OK);
    let r = t.raw(Method::POST, &format!("{path}x"), None, None).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "a token that does not hold");
    // From now on the address is left out.
    t.advance(24 * HOUR);
    t.run(&fake).await;
    let mails = fake.take();
    assert_eq!(mails.iter().map(|m| m.to.as_str()).collect::<Vec<_>>(), ["lea@example.de"]);
    assert_eq!(t.runs(&id).await[0]["skippedRecipients"], 1);
    // Turned off again: outside addresses are left out of the runs too.
    let summaries: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events WHERE action LIKE 'report.%'")
        .fetch_all(&t.state.db)
        .await
        .unwrap();
    assert!(!summaries.is_empty() && summaries.iter().all(|(s,)| !s.contains("partner@")), "{summaries:?}");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_run_is_tried_once_more_then_the_creator_hears_of_it() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let (other_id, _) = t.person("Ole Berg", "ole@example.de", "viewer").await;
    let owner_id = t.owner_id.clone();
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": other_id }]))).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let fake = Fake::default();
    fake.down.store(true, Ordering::SeqCst);
    fake.reachable.lock().unwrap().push("lea@example.de".into());
    t.advance(HOUR);
    t.run(&fake).await;
    let run = &t.runs(&id).await[0];
    assert_eq!((run["status"].as_str(), run["attempt"].as_i64()), (Some("queued"), Some(2)), "{run}");
    assert!(fake.take().is_empty());
    t.advance(4 * MINUTE);
    assert_eq!(t.run(&fake).await, 0, "not before five minutes");
    t.advance(MINUTE);
    assert_eq!(t.run(&fake).await, 1);
    let run = &t.runs(&id).await[0];
    assert_eq!((run["status"].as_str(), run["sent"].as_i64()), (Some("failed"), Some(0)), "{run}");
    // Only the creator hears of it, once a day.
    let mails = fake.take();
    assert_eq!(mails.len(), 1);
    assert_eq!(mails[0].to, "lea@example.de");
    assert!(mails[0].subject.starts_with("Bericht nicht gesendet"), "{}", mails[0].subject);
    assert!(mails[0].files.is_empty());
    let _ = owner_id;
    let r = t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/send"), None).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.body);
    t.run(&fake).await;
    t.advance(5 * MINUTE);
    t.run(&fake).await;
    assert!(fake.take().is_empty(), "no second failure mail the same day");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permissions_caps_preview_and_audit() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let viewer = t.as_role("viewer").await;
    for (method, path) in [(Method::GET, "/reports"), (Method::GET, "/reports/status")] {
        let r = t.call(&viewer, method, path, None).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}: {}", r.body);
    }
    let r = t.create(&viewer, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // Bad bodies.
    let mut bad = t.report_body(&dashboard, json!([{ "userId": owner_id }]));
    bad["schedule"] = json!({ "kind": "cron", "expression": "* * * * *" });
    assert_eq!(reason(&t.create(&Who::Owner, bad).await), "reports.schedule_too_frequent");
    let mut bad = t.report_body(&dashboard, json!([{ "userId": owner_id }]));
    bad["timeZone"] = json!("Mars/Olympus");
    assert_eq!(reason(&t.create(&Who::Owner, bad).await), "reports.time_zone_invalid");
    let mut bad = t.report_body(&dashboard, json!([{ "userId": owner_id }]));
    bad["panelIds"] = json!(["nope"]);
    assert_eq!(reason(&t.create(&Who::Owner, bad).await), "reports.panel_unknown");
    // Caps.
    t.server_setting("reports.max_recipients", json!(1)).await;
    let two = t.report_body(&dashboard, json!([{ "userId": owner_id }, { "email": "a@example.com" }]));
    assert_eq!(reason(&t.create(&Who::Owner, two).await), "reports.too_many_recipients");
    t.server_setting("reports.max_reports_per_org", json!(1)).await;
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    assert_eq!(reason(&r), "reports.too_many", "{}", r.body);
    t.server_setting("reports.max_runs_per_org_hour", json!(1)).await;
    let r = t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/send"), None).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.body);
    assert_eq!(r.body["run"]["status"], "queued");
    let r = t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/send"), None).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);
    let fake = Fake::default();
    assert_eq!(t.run(&fake).await, 1);
    assert_eq!(fake.take().len(), 1);
    // Preview: a PDF file, nothing stored or sent.
    let r = t.call(&Who::Owner, Method::POST, "/reports/preview", Some(t.report_body(&dashboard, json!([])))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", String::from_utf8_lossy(&r.bytes));
    assert_eq!(r.headers[header::CONTENT_TYPE], "application/pdf");
    assert!(r.bytes.starts_with(b"%PDF-"));
    // Off: no sending, no preview, the schedule rests.
    t.server_setting("reports.enabled", json!(false)).await;
    let r = t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/send"), None).await;
    assert_eq!(reason(&r), "reports.disabled");
    t.advance(HOUR);
    assert_eq!(t.run(&fake).await, 0);
    let r = t.call(&Who::Owner, Method::DELETE, &format!("/reports/{id}"), None).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let actions: Vec<(String,)> =
        sqlx::query_as("SELECT action FROM audit_events WHERE action LIKE 'report.%' ORDER BY created_at, id")
            .fetch_all(&t.state.db)
            .await
            .unwrap();
    let actions: Vec<&str> = actions.iter().map(|a| a.0.as_str()).collect();
    assert_eq!(actions, ["report.created", "report.sent_now", "report.deleted"]);
    // The history goes after its retention.
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM report_runs").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(left, 0, "runs go with their report");
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_past_the_retention_are_deleted() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let fake = Fake::default();
    t.advance(HOUR);
    t.run(&fake).await;
    assert_eq!(t.runs(&id).await.len(), 1);
    t.server_setting("reports.history_retention_days", json!(1)).await;
    t.advance(2 * 24 * HOUR);
    worker::purge(&t.state).await.unwrap();
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM report_runs WHERE status <> 'skipped'")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_recipients_with_export_rights_get_the_csv_files() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let (viewer_id, _) = t.person("Ole Viewer", "ole@example.de", "viewer").await;
    let owner_id = t.owner_id.clone();
    t.org_setting("reports.allow_external_recipients", json!(true)).await;
    // An address of an account goes by the account.
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "email": "OLE@example.de" }]))).await;
    assert_eq!(
        (r.body["error"]["field"].as_str(), reason(&r)),
        (Some("recipients"), "reports.recipient_is_account"),
        "{}",
        r.body
    );
    let recipients = json!([{ "userId": owner_id }, { "userId": viewer_id }, { "email": "partner@example.com" }]);
    let r = t.create(&Who::Owner, t.report_body(&dashboard, recipients)).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["id"].as_str().unwrap().to_string();
    let fake = Fake::default();
    t.advance(HOUR);
    t.run(&fake).await;
    let mails = fake.take();
    let files = |to: &str| -> Vec<String> {
        mails.iter().find(|m| m.to == to).unwrap().files.iter().map(|f| f.0.clone()).collect()
    };
    assert_eq!(files("lea@example.de"), ["Lager-t-glich.pdf", "Lager-t-glich.zip"]);
    assert_eq!(files("ole@example.de"), ["Lager-t-glich.pdf"], "a viewer has no data:export");
    assert_eq!(files("partner@example.com"), ["Lager-t-glich.pdf"], "outside addresses never get CSV files");
    let run = &t.runs(&id).await[0];
    assert_eq!((run["status"].as_str(), run["csvWithheld"].as_i64()), (Some("ok"), Some(2)), "{run}");
    // An outside address that becomes an account later is left out at runs.
    let r = t
        .raw(
            Method::POST,
            "/api/admin/users",
            Some(json!({ "name": "Partner", "email": "partner@example.com", "password": PASSWORD })),
            Some(&Who::Owner),
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    t.advance(24 * HOUR);
    t.run(&fake).await;
    let mails = fake.take();
    assert!(mails.iter().all(|m| m.to != "partner@example.com"));
    assert_eq!(t.runs(&id).await[0]["skippedRecipients"], 1);
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsubscribe_links_hold_across_a_rotation_of_the_secrets_key() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    t.org_setting("reports.allow_external_recipients", json!(true)).await;
    let r = t
        .create(
            &Who::Owner,
            t.report_body(&dashboard, json!([{ "userId": owner_id }, { "email": "partner@example.com" }])),
        )
        .await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let fake = Fake::default();
    t.advance(HOUR);
    t.run(&fake).await;
    let link = fake.take().into_iter().find_map(|m| m.unsubscribe).unwrap();
    let path = link.trim_start_matches("https://kalzit.test").to_string();
    // The server stops, the key is rotated, a server starts with the new key.
    let config = (*t.state.config).clone();
    let TestApp { app, state, dir, sources, schema, clock, .. } = t;
    drop(app);
    state.close().await;
    drop(state);
    let rotation = kalzit::secrets::rotate(&config).await.unwrap();
    assert!(rotation.reencrypted > 0 || !rotation.key_id.is_empty());
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let restarted = AppState::new(config, pool, clock.clone(), None).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    let app = router(restarted.clone()).layer(MockConnectInfo(peer));
    let req = Request::builder()
        .method(Method::POST)
        .uri(&path)
        .header(header::HOST, "kalzit.test")
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM report_unsubscribes WHERE report_id = $1")
        .bind(&id)
        .fetch_one(&restarted.db)
        .await
        .unwrap();
    assert_eq!(n, 1, "the address is left out from now on");
    drop(app);
    common::Finish::new(restarted, dir).with_schema(schema).finish().await;
    common::remove_dir(sources);
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_organization_may_turn_reports_off() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    t.org_setting("reports.org_enabled", json!(false)).await;
    let r = t.call(&Who::Owner, Method::POST, &format!("/reports/{id}/send"), None).await;
    assert_eq!(reason(&r), "reports.disabled");
    let r = t.call(&Who::Owner, Method::POST, "/reports/preview", Some(t.report_body(&dashboard, json!([])))).await;
    assert_eq!(reason(&r), "reports.disabled");
    let r = t.call(&Who::Owner, Method::GET, "/reports/status", None).await;
    assert_eq!(r.body["enabled"], false);
    let fake = Fake::default();
    t.advance(HOUR);
    assert_eq!(t.run(&fake).await, 0);
    assert!(fake.take().is_empty());
    t.finish().await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_refused_for_every_recipient_fails_and_tells_the_creator() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let (other_id, _) = t.person("Ole Berg", "ole@example.de", "editor").await;
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": other_id }]))).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    let fake = Fake::default();
    fake.refused.lock().unwrap().push("ole@example.de".into());
    t.advance(HOUR);
    t.run(&fake).await;
    let run = &t.runs(&id).await[0];
    assert_eq!(
        (run["status"].as_str(), run["error"]["code"].as_str()),
        (Some("failed"), Some("reports.all_refused")),
        "{run}"
    );
    let mails = fake.take();
    assert_eq!(
        mails.iter().map(|m| m.to.as_str()).collect::<Vec<_>>(),
        ["lea@example.de"],
        "only the creator hears of it"
    );
    t.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduled_runs_waiting_too_long_are_skipped() {
    let mut t = TestApp::new().await;
    let dashboard = t.dashboard(None).await;
    let owner_id = t.owner_id.clone();
    let r = t.create(&Who::Owner, t.report_body(&dashboard, json!([{ "userId": owner_id }]))).await;
    let id = r.body["id"].as_str().unwrap().to_string();
    // A run queued at its time, then held up (another server led and stopped, say).
    sqlx::query(
        "INSERT INTO report_runs (id, org_id, report_id, trigger_kind, scheduled_for, status, attempt, not_before, created_at) \
         VALUES ($1, $2, $3, 'schedule', $4, 'queued', 1, $4, $4)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&t.org)
    .bind(&id)
    .bind(START - 20 * MINUTE)
    .execute(&t.state.db)
    .await
    .unwrap();
    let fake = Fake::default();
    assert_eq!(t.run(&fake).await, 0);
    assert!(fake.take().is_empty());
    let run = &t.runs(&id).await[0];
    assert_eq!(
        (run["status"].as_str(), run["error"]["code"].as_str()),
        (Some("skipped"), Some("reports.queue_late")),
        "{run}"
    );
    t.finish().await;
}
