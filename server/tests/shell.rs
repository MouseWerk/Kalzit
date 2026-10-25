//! Search, stars, recently viewed dashboards and personal preferences through the real router
//! and database.

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

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
    owner: String,
    org: String,
}

struct Reply {
    status: StatusCode,
    body: Value,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn field(&self) -> &str {
        self.body["error"]["field"].as_str().unwrap_or("")
    }

    fn items(&self) -> &Vec<Value> {
        self.body["items"].as_array().unwrap_or_else(|| panic!("no items: {}", self.body))
    }

    fn titles(&self) -> Vec<&str> {
        self.items().iter().map(|i| i["title"].as_str().unwrap()).collect()
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
    let mut t = TestApp { app, clock, state, _dir: dir, owner: String::new(), org: String::new() };
    let setup = t
        .send(
            Method::POST,
            "/api/setup",
            Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                         "email": "joerg@example.de", "password": "Grün und sicher 2026" })),
            None,
        )
        .await;
    assert_eq!(setup.status, StatusCode::OK, "{}", setup.body);
    t.org = setup.body["orgs"][0]["id"].as_str().unwrap().to_string();
    let owner_id = setup.body["id"].as_str().unwrap().to_string();
    t.owner = t.session_for(&owner_id).await;
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

    async fn get(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::GET, &self.path(path), None, Some(cookie)).await
    }

    async fn post(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::POST, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn put(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::PUT, &self.path(path), None, Some(cookie)).await
    }

    async fn patch(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PATCH, &self.path(path), Some(body), Some(cookie)).await
    }

    async fn delete(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::DELETE, &self.path(path), None, Some(cookie)).await
    }

    /// `~` stands for `/api/orgs/<the org>`.
    fn path(&self, path: &str) -> String {
        match path.strip_prefix('~') {
            Some(rest) => format!("/api/orgs/{}{rest}", self.org),
            None => format!("/api{path}"),
        }
    }

    async fn session_for(&self, user_id: &str) -> String {
        let cfg = &self.state.config.sessions;
        let token = kalzit::auth::session::create(&self.state.db, cfg, self.clock.now_ms(), user_id).await.unwrap();
        format!("kalzit_session={token}")
    }

    /// A new user in the organization with `role`, signed in.
    async fn member(&self, name: &str, role: &str) -> String {
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
        self.session_for(&id).await
    }

    async fn user_id(&self, name: &str) -> String {
        let (id,): (String,) =
            sqlx::query_as("SELECT id FROM users WHERE name = $1").bind(name).fetch_one(&self.state.db).await.unwrap();
        id
    }

    /// Grants `level` on a resource to a user, as the owner; answers the grant id.
    async fn grant(&self, user: &str, resource_type: &str, resource_id: &str, level: &str) -> String {
        let user_id = self.user_id(user).await;
        let body = json!({ "subjectType": "user", "subjectId": user_id, "resourceType": resource_type,
                           "resourceId": resource_id, "level": level });
        let r = self.post("~/grants", body, &self.owner).await;
        assert!(matches!(r.status, StatusCode::CREATED | StatusCode::OK), "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    async fn folder(&self, name: &str, parent: Option<&str>, restricted: bool) -> String {
        id_of(
            self.post("~/folders", json!({ "name": name, "parentId": parent, "restricted": restricted }), &self.owner)
                .await,
        )
    }

    async fn dashboard(&self, title: &str, folder: Option<&str>) -> String {
        id_of(self.post("~/dashboards", json!({ "folderId": folder, "model": model(title) }), &self.owner).await)
    }

    async fn datasource(&self, name: &str) -> String {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
             VALUES ($1, $2, $3, 'sqlite', '{}', 0, 0)",
        )
        .bind(&id)
        .bind(&self.org)
        .bind(name)
        .execute(&self.state.db)
        .await
        .unwrap();
        id
    }

    /// Another organization with one dashboard titled `title`: (org id, dashboard id).
    async fn foreign_org_with(&self, title: &str) -> (String, String) {
        let org = uuid::Uuid::now_v7().to_string();
        let dashboard = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, 'Andere', 0)")
            .bind(&org)
            .execute(&self.state.db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at) \
             VALUES ($1, $2, $3, $4, 1, 0, 0)",
        )
        .bind(&dashboard)
        .bind(&org)
        .bind(title)
        .bind(title.to_lowercase())
        .execute(&self.state.db)
        .await
        .unwrap();
        (org, dashboard)
    }

    async fn search(&self, query: &str, cookie: &str) -> Reply {
        let r = self.get(&format!("~/search?{query}"), cookie).await;
        assert_eq!(r.status, StatusCode::OK, "{query}: {}", r.body);
        r
    }
}

fn id_of(r: Reply) -> String {
    assert!(r.status.is_success(), "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

/// A model without queries, so members who may not query data sources can be given it.
fn model(title: &str) -> Value {
    json!({ "schemaVersion": 1, "title": title, "timeRange": { "from": "now-6h", "to": "now" }, "panels": [] })
}

fn hit<'a>(r: &'a Reply, title: &str) -> Option<&'a Value> {
    r.items().iter().find(|i| i["title"] == title)
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
    search_names_only_what_the_caller_may_open;
    search_ranks_fuzzy_matches_and_pages;
    stars_are_personal_and_follow_access;
    stars_page_through_titles_that_differ_in_punctuation;
    recents_keep_the_newest_and_follow_access;
    preferences_are_personal_validated_and_reset;
    start_dashboards_must_be_readable;
    about_names_the_build_to_signed_in_users;
}

async fn search_names_only_what_the_caller_may_open(t: TestApp) {
    let sales = t.folder("Vertrieb", None, false).await;
    let secret = t.folder("Geheim", None, true).await;
    let inner = t.folder("Innen", Some(&secret), false).await;
    let vault = t.folder("Tresor", None, true).await;
    t.dashboard("Umsatz Übersicht", None).await;
    t.dashboard("Umsatz Region", Some(&sales)).await;
    let hidden = t.dashboard("Umsatz Geheim", Some(&inner)).await;
    let alone = t.dashboard("Umsatz Tresor", Some(&vault)).await;
    let trashed = t.dashboard("Umsatz Alt", None).await;
    assert_eq!(t.delete(&format!("~/dashboards/{trashed}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let source = t.datasource("Umsatzdaten").await;

    let viewer = t.member("Vera", "viewer").await;
    let editor = t.member("Emil", "editor").await;

    // A viewer sees open dashboards with their folder path, nothing restricted, trashed or a
    // data source (viewers hold no datasources:read).
    let r = t.search("q=umsatz", &viewer).await;
    assert_eq!(r.titles(), ["Umsatz Region", "Umsatz Übersicht"], "{}", r.body);
    assert_eq!(hit(&r, "Umsatz Region").unwrap()["path"], json!(["Vertrieb"]));
    assert_eq!(hit(&r, "Umsatz Region").unwrap()["folderId"], sales.as_str());
    assert_eq!(hit(&r, "Umsatz Übersicht").unwrap()["kind"], "dashboard");
    let folders = t.search("kind=folder", &viewer).await;
    assert_eq!(folders.titles(), ["Vertrieb"], "restricted folders do not exist for the viewer");

    // An editor reads data sources as well.
    let r = t.search("q=umsatz", &editor).await;
    let ds = hit(&r, "Umsatzdaten").expect("the editor finds the data source");
    assert_eq!(
        (&ds["kind"], &ds["datasourceKind"], &ds["id"]),
        (&json!("datasource"), &json!("sqlite"), &json!(source))
    );
    assert!(hit(&r, "Umsatz Geheim").is_none(), "editors need a grant inside restricted folders too");

    // Owners and admins see restricted content, with the whole path.
    let r = t.search("q=umsatz", &t.owner).await;
    assert_eq!(hit(&r, "Umsatz Geheim").unwrap()["path"], json!(["Geheim", "Innen"]));
    assert!(hit(&r, "Umsatz Alt").is_none(), "the trash is left out for everyone");

    // A grant on the restricted folder opens it and what lies below.
    t.grant("Vera", "folder", &secret, "view").await;
    let r = t.search("q=umsatz", &viewer).await;
    assert_eq!(hit(&r, "Umsatz Geheim").unwrap()["path"], json!(["Geheim", "Innen"]));
    let folders = t.search("kind=folder", &viewer).await;
    assert_eq!(folders.titles(), ["Geheim", "Innen", "Vertrieb"]);
    assert_eq!(hit(&folders, "Innen").unwrap()["path"], json!(["Geheim"]));

    // A grant on one dashboard opens that dashboard alone; its folder stays unnamed.
    t.grant("Vera", "dashboard", &alone, "view").await;
    let r = t.search("q=tresor", &viewer).await;
    assert_eq!(r.titles(), ["Umsatz Tresor"]);
    assert_eq!((&r.items()[0]["folderId"], &r.items()[0]["path"]), (&Value::Null, &json!([])));

    // A grant on a data source makes it readable (querying includes reading its name), for that
    // source only.
    t.datasource("Umsatzarchiv").await;
    t.grant("Vera", "datasource", &source, "query").await;
    let r = t.search("q=umsatz", &viewer).await;
    assert!(hit(&r, "Umsatzdaten").is_some(), "{}", r.body);
    assert!(hit(&r, "Umsatzarchiv").is_none(), "the matching source without a grant stays out: {}", r.body);

    // Trashed folders and data sources are left out, also for the owner.
    let old = t.folder("Umsatz alt", None, false).await;
    assert_eq!(t.delete(&format!("~/folders/{old}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let gone = t.datasource("Umsatz gelöscht").await;
    sqlx::query("UPDATE datasources SET deleted_at = 1 WHERE id = $1").bind(&gone).execute(&t.state.db).await.unwrap();
    let r = t.search("q=umsatz", &t.owner).await;
    assert!(hit(&r, "Umsatzarchiv").is_some(), "{}", r.body);
    assert!(hit(&r, "Umsatz alt").is_none() && hit(&r, "Umsatz gelöscht").is_none(), "{}", r.body);

    // Another organization's content never appears, and its search is not reachable.
    let (foreign_org, _) = t.foreign_org_with("Umsatz Fremd").await;
    assert!(hit(&t.search("q=umsatz", &t.owner).await, "Umsatz Fremd").is_none());
    let r = t.get(&format!("/orgs/{foreign_org}/search?q=umsatz"), &t.owner).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // The hidden dashboard of another member stays hidden for them.
    let other = t.member("Otto", "viewer").await;
    assert!(t.search("q=geheim", &other).await.items().is_empty());
    let _ = hidden;
}

async fn search_ranks_fuzzy_matches_and_pages(t: TestApp) {
    for title in ["Umsatz Übersicht", "Monatsumsatz", "Kosten", "Lager Umsatz", "Umsatz"] {
        t.dashboard(title, None).await;
    }
    t.folder("Umsätze", None, false).await;
    // Exact, then prefix (shorter first), then at a word start, then inside a word.
    let r = t.search("q=umsatz&kind=dashboard", &t.owner).await;
    assert_eq!(r.titles(), ["Umsatz", "Umsatz Übersicht", "Lager Umsatz", "Monatsumsatz"]);
    let scores: Vec<i64> = r.items().iter().map(|i| i["score"].as_i64().unwrap()).collect();
    assert!(scores.windows(2).all(|w| w[0] > w[1]), "{scores:?}");
    // Letters in order match across words, any case, umlauts included.
    let r = t.search("q=UMSÜBS", &t.owner).await;
    assert_eq!(r.titles(), ["Umsatz Übersicht"]);
    assert_eq!(t.search("q=ums%C3%A4", &t.owner).await.titles(), ["Umsätze"]);
    // Wildcards are letters, not patterns: each finds only titles that contain it.
    for title in ["50% Rabatt", "a_b Liste", "C:\\Pfad"] {
        t.dashboard(title, None).await;
    }
    assert_eq!(t.search("q=%25", &t.owner).await.titles(), ["50% Rabatt"]);
    assert_eq!(t.search("q=_", &t.owner).await.titles(), ["a_b Liste"]);
    assert_eq!(t.search("q=%5C", &t.owner).await.titles(), ["C:\\Pfad"]);

    // Pages follow the ranking without repeats or gaps.
    let all = t.search("q=um", &t.owner).await.titles().iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(all.len(), 5, "{all:?}");
    let mut paged = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let query = match &cursor {
            Some(c) => format!("q=um&limit=2&cursor={c}"),
            None => "q=um&limit=2".to_string(),
        };
        let r = t.search(&query, &t.owner).await;
        assert!(r.items().len() <= 2);
        paged.extend(r.titles().iter().map(|s| s.to_string()));
        match r.body["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(paged, all);

    for (query, field) in
        [("kind=widget", "kind"), (&format!("q={}", "x".repeat(101)) as &str, "q"), ("cursor=zz", "cursor")]
    {
        let r = t.get(&format!("~/search?{query}"), &t.owner).await;
        assert_eq!((r.status, r.code(), r.field()), (StatusCode::UNPROCESSABLE_ENTITY, "validation", field), "{query}");
    }
    let r = t.get("~/search?limit=201", &t.owner).await;
    assert_eq!(r.code(), "validation");
}

async fn stars_are_personal_and_follow_access(t: TestApp) {
    let vault = t.folder("Tresor", None, true).await;
    let open = t.dashboard("Lager", None).await;
    let locked = t.dashboard("Bilanz", Some(&vault)).await;
    let viewer = t.member("Vera", "viewer").await;

    let star = |id: &str| format!("~/dashboards/{id}/star");
    assert_eq!(t.get(&star(&open), &viewer).await.body, json!({ "starred": false }));
    assert_eq!(t.put(&star(&open), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.put(&star(&open), &viewer).await.status, StatusCode::NO_CONTENT, "starring again is fine");
    assert_eq!(t.get(&star(&open), &viewer).await.body, json!({ "starred": true }));
    let list = t.get("~/stars", &viewer).await;
    assert_eq!(list.titles(), ["Lager"]);
    assert_eq!(list.items()[0]["at"], json!(t.clock.now_ms()));
    assert!(t.get("~/stars", &t.owner).await.items().is_empty(), "stars are per user");

    // A dashboard the viewer cannot see cannot be starred, nor can its star be read.
    assert_eq!(t.put(&star(&locked), &viewer).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&star(&locked), &viewer).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.put(&star("no-such-dashboard"), &viewer).await.status, StatusCode::NOT_FOUND);

    // A grant opens it; once the grant goes, the star is hidden again.
    let grant = t.grant("Vera", "dashboard", &locked, "view").await;
    assert_eq!(t.put(&star(&locked), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("~/stars", &viewer).await.titles(), ["Bilanz", "Lager"]);
    assert_eq!(t.get("~/stars?limit=1", &viewer).await.titles(), ["Bilanz"]);
    let cursor = t.get("~/stars?limit=1", &viewer).await.body["nextCursor"].as_str().unwrap().to_string();
    assert_eq!(t.get(&format!("~/stars?limit=1&cursor={cursor}"), &viewer).await.titles(), ["Lager"]);
    assert_eq!(t.delete(&format!("~/grants/{grant}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("~/stars", &viewer).await.titles(), ["Lager"]);

    // Trashed dashboards drop out of the list and cannot be starred; purging removes the stars.
    assert_eq!(t.delete(&format!("~/dashboards/{open}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert!(t.get("~/stars", &viewer).await.items().is_empty());
    let r = t.put(&star(&open), &t.owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"));
    assert_eq!(t.delete(&format!("~/dashboards/{open}/purge"), &t.owner).await.status, StatusCode::NO_CONTENT);
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboard_stars WHERE dashboard_id = $1")
        .bind(&open)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);

    // A member whose role lacks dashboards:read (a custom role with folders:read only) gets
    // `not_found` here, as for a dashboard that does not exist.
    let role = t.post("~/roles", json!({ "name": "Ordnerblick", "permissions": ["folders:read"] }), &t.owner).await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let looker = t.member("Lea", role.body["id"].as_str().unwrap()).await;
    let seen = t.dashboard("Sichtbar", None).await;
    for r in [
        t.put(&star(&seen), &looker).await,
        t.get(&star(&seen), &looker).await,
        t.post(&format!("~/dashboards/{seen}/views"), json!({}), &looker).await,
    ] {
        assert_eq!((r.status, r.code()), (StatusCode::NOT_FOUND, "not_found"), "{}", r.body);
    }

    // Unstarring is idempotent and tells nothing about other dashboards.
    assert_eq!(t.delete(&star(&locked), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&star(&locked), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&star("no-such-dashboard"), &viewer).await.status, StatusCode::NO_CONTENT);
}

/// The cursor compares titles as the server does, so the database's collation (PostgreSQL sorts
/// punctuation by locale rules) can neither repeat nor skip a star across pages.
async fn stars_page_through_titles_that_differ_in_punctuation(t: TestApp) {
    let titles = ["Lager-A", "Lager A", "Lager_A", "LagerA", "lager a2", "Lager.A", "Lager/A"];
    for title in titles {
        let id = t.dashboard(title, None).await;
        assert_eq!(t.put(&format!("~/dashboards/{id}/star"), &t.owner).await.status, StatusCode::NO_CONTENT);
    }
    let all: Vec<String> = t.get("~/stars", &t.owner).await.titles().iter().map(|s| s.to_string()).collect();
    let mut expected: Vec<String> = titles.iter().map(|s| s.to_string()).collect();
    expected.sort_by_key(|s| s.to_lowercase());
    assert_eq!(all, expected);
    let mut paged = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(c) => format!("~/stars?limit=1&cursor={c}"),
            None => "~/stars?limit=1".to_string(),
        };
        let r = t.get(&path, &t.owner).await;
        paged.extend(r.titles().iter().map(|s| s.to_string()));
        match r.body["nextCursor"].as_str() {
            Some(c) => cursor = Some(c.to_string()),
            None => break,
        }
    }
    assert_eq!(paged, all);
}
async fn recents_keep_the_newest_and_follow_access(t: TestApp) {
    let vault = t.folder("Tresor", None, true).await;
    let a = t.dashboard("Erster", None).await;
    let b = t.dashboard("Zweiter", None).await;
    let locked = t.dashboard("Bilanz", Some(&vault)).await;
    let viewer = t.member("Vera", "viewer").await;
    let view = |id: &str| format!("~/dashboards/{id}/views");

    for id in [&a, &b, &a] {
        t.clock.advance_ms(1000);
        assert_eq!(t.post(&view(id), json!({}), &viewer).await.status, StatusCode::NO_CONTENT);
    }
    let r = t.get("~/recents", &viewer).await;
    assert_eq!(r.titles(), ["Erster", "Zweiter"], "opened again moves to the top");
    assert_eq!(r.items()[0]["at"], json!(t.clock.now_ms()));
    let first = t.get("~/recents?limit=1", &viewer).await;
    assert_eq!(first.titles(), ["Erster"]);
    let cursor = first.body["nextCursor"].as_str().unwrap();
    assert_eq!(t.get(&format!("~/recents?limit=1&cursor={cursor}"), &viewer).await.titles(), ["Zweiter"]);
    assert!(t.get("~/recents", &t.owner).await.items().is_empty(), "views are per user");

    assert_eq!(t.post(&view(&locked), json!({}), &viewer).await.status, StatusCode::NOT_FOUND);
    let grant = t.grant("Vera", "dashboard", &locked, "view").await;
    t.clock.advance_ms(1000);
    assert_eq!(t.post(&view(&locked), json!({}), &viewer).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("~/recents", &viewer).await.titles(), ["Bilanz", "Erster", "Zweiter"]);
    assert_eq!(t.delete(&format!("~/grants/{grant}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("~/recents", &viewer).await.titles(), ["Erster", "Zweiter"], "hidden once the grant goes");
    assert_eq!(t.delete(&format!("~/dashboards/{b}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("~/recents", &viewer).await.titles(), ["Erster"], "the trash is left out");

    // Only the newest views are kept.
    let keep = kalzit::routes::home::RECENT_KEEP as usize;
    for i in 0..keep + 2 {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at) \
             VALUES ($1, $2, $3, $3, 1, 0, 0)",
        )
        .bind(&id)
        .bind(&t.org)
        .bind(format!("d{i:03}"))
        .execute(&t.state.db)
        .await
        .unwrap();
        t.clock.advance_ms(1000);
        assert_eq!(t.post(&view(&id), json!({}), &t.owner).await.status, StatusCode::NO_CONTENT);
    }
    let (kept,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboard_views WHERE user_id <> $1")
        .bind(t.user_id("Vera").await)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(kept as usize, keep);
    let newest = t.get("~/recents?limit=1", &t.owner).await;
    assert_eq!(newest.titles(), [format!("d{:03}", keep + 1).as_str()]);
}

async fn preferences_are_personal_validated_and_reset(t: TestApp) {
    let other = t.member("Vera", "viewer").await;
    let r = t.get("/me/preferences", &t.owner).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        r.body,
        json!({ "language": null, "theme": null, "timeZone": null, "weekStart": null, "startDashboard": null,
                "defaults": { "language": "de", "theme": "system" } })
    );

    let r = t
        .patch(
            "/me/preferences",
            json!({ "language": "en", "theme": "contrast", "timeZone": "Europe/Berlin", "weekStart": "sunday" }),
            &t.owner,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((&r.body["language"], &r.body["theme"]), (&json!("en"), &json!("contrast")));
    assert_eq!((&r.body["timeZone"], &r.body["weekStart"]), (&json!("Europe/Berlin"), &json!("sunday")));
    let again = t.get("/me/preferences", &t.owner).await;
    assert_eq!(again.body, r.body);
    assert_eq!(t.get("/me/preferences", &other).await.body["theme"], Value::Null, "preferences are per user");

    // A missing field keeps its value, null resets it.
    let r = t.patch("/me/preferences", json!({ "theme": null }), &t.owner).await;
    assert_eq!((&r.body["theme"], &r.body["language"]), (&Value::Null, &json!("en")));

    // The server default follows the setting.
    let set = t.patch("/admin/settings/appearance.default_theme", json!({ "value": "dark", "version": 0 }), &t.owner);
    assert_eq!(set.await.status, StatusCode::OK);
    assert_eq!(t.get("/me/preferences", &other).await.body["defaults"]["theme"], "dark");

    for (body, field) in [
        (json!({ "language": "fr" }), "language"),
        (json!({ "theme": "pink" }), "theme"),
        (json!({ "weekStart": "friday" }), "weekStart"),
        (json!({ "timeZone": "../etc/passwd" }), "timeZone"),
        (json!({ "timeZone": "" }), "timeZone"),
    ] {
        let r = t.patch("/me/preferences", body.clone(), &t.owner).await;
        assert_eq!((r.status, r.code(), r.field()), (StatusCode::UNPROCESSABLE_ENTITY, "validation", field), "{body}");
    }
    let r = t.patch("/me/preferences", json!({ "colour": "blue" }), &t.owner).await;
    assert_eq!(r.code(), "validation", "unknown fields are refused");
    assert_eq!(t.get("/me/preferences", &t.owner).await.body["language"], "en", "refused changes change nothing");

    let events: Vec<(String, String)> = sqlx::query_as(
        "SELECT action, summary FROM audit_events WHERE action = 'user.preferences_updated' ORDER BY created_at, id",
    )
    .fetch_all(&t.state.db)
    .await
    .unwrap();
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(events[0].1.contains("timeZone") && events[1].1.contains("theme"), "{events:?}");
}

async fn start_dashboards_must_be_readable(t: TestApp) {
    let vault = t.folder("Tresor", None, true).await;
    let open = t.dashboard("Lager", None).await;
    let locked = t.dashboard("Bilanz", Some(&vault)).await;
    let viewer = t.member("Vera", "viewer").await;
    let start = |org: &str, id: &str| json!({ "startDashboard": { "orgId": org, "dashboardId": id } });

    let r = t.patch("/me/preferences", start(&t.org, &open), &viewer).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["startDashboard"], json!({ "orgId": t.org, "dashboardId": open, "title": "Lager" }));

    // Hidden, unknown and foreign dashboards are refused alike.
    let foreign_org = uuid::Uuid::now_v7().to_string();
    for (org, id) in
        [(t.org.as_str(), locked.as_str()), (t.org.as_str(), "no-such"), (foreign_org.as_str(), open.as_str())]
    {
        let r = t.patch("/me/preferences", start(org, id), &viewer).await;
        assert_eq!((r.status, r.field()), (StatusCode::UNPROCESSABLE_ENTITY, "startDashboard"), "{org} {id}");
        assert_eq!(r.body["error"]["message"], "startDashboard is not a dashboard you can open");
    }
    assert_eq!(t.get("/me/preferences", &viewer).await.body["startDashboard"]["dashboardId"], open.as_str());

    // Another change keeps the start dashboard and names it.
    let r = t.patch("/me/preferences", json!({ "language": "de" }), &viewer).await;
    assert_eq!(r.body["startDashboard"]["title"], "Lager");

    // In the trash it reads as unset until it is restored.
    assert_eq!(t.delete(&format!("~/dashboards/{open}"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("/me/preferences", &viewer).await.body["startDashboard"], Value::Null);
    assert_eq!(t.post(&format!("~/dashboards/{open}/restore"), json!({}), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.get("/me/preferences", &viewer).await.body["startDashboard"]["title"], "Lager");

    let r = t.patch("/me/preferences", json!({ "startDashboard": null }), &viewer).await;
    assert_eq!(r.body["startDashboard"], Value::Null);
}

async fn about_names_the_build_to_signed_in_users(t: TestApp) {
    let anonymous = t.send(Method::GET, "/api/about", None, None).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);

    let viewer = t.member("Vera", "viewer").await;
    let r = t.send(Method::GET, "/api/about", None, Some(&viewer)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["version"], env!("CARGO_PKG_VERSION"));
    assert!(r.body["commit"].as_str().is_some_and(|c| c == "unknown" || c.chars().all(|ch| ch.is_ascii_hexdigit())));
    let date = r.body["buildDate"].as_str().unwrap();
    assert!(date.len() == 10 && date.as_bytes()[4] == b'-', "{date}");
    assert!(r.body["platform"].as_str().is_some_and(|p| !p.is_empty()));
    assert!(r.body["arch"].as_str().is_some_and(|p| !p.is_empty()));
    let database = if t.state.config.database_url().starts_with("postgres") { "postgres" } else { "sqlite" };
    assert_eq!(r.body["database"], database);

    // Only the six fields: no paths, host names or settings.
    let mut keys: Vec<&String> = r.body.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["arch", "buildDate", "commit", "database", "platform", "version"]);
}
