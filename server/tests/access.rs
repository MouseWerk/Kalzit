//! Organizations, members, teams, roles, grants, server administration and self service through
//! the real router (SQLite; PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
/// Small, so tests with more parallel requests than connections show a handler that needs a
/// second connection while holding a lock.
const POOL_SIZE: u32 = 4;

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
}

impl TestApp {
    /// Stops the app and deletes its data directory (`common::Finish`).
    async fn finish(self) {
        let finish = self.finisher();
        drop(self);
        finish.finish().await;
    }

    /// What `finish` does, for a test that hands the app on by value.
    fn finisher(&self) -> common::Finish {
        common::Finish::new(self.state.clone(), self.dir.clone())
    }
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Reply {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }

    fn field(&self) -> &str {
        self.body["error"]["field"].as_str().unwrap_or("")
    }

    fn session_cookie(&self) -> String {
        let set = self.headers.get(header::SET_COOKIE).expect("Set-Cookie").to_str().unwrap();
        set.split(';').next().unwrap().to_string()
    }
}

async fn test_app(db_url: Option<String>) -> TestApp {
    test_app_with_pool(db_url, POOL_SIZE).await
}

/// `test_app` with `pool_size` connections to Kalzit's own database.
async fn test_app_with_pool(db_url: Option<String>, pool_size: u32) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    let pool = kalzit::db::connect(&config.database_url(), pool_size).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), clock, state, dir: Arc::new(dir) }
}

/// A signed-in user, as the requests of one browser.
#[derive(Clone)]
struct Session {
    cookie: String,
    user_id: String,
}

impl TestApp {
    async fn send(&self, method: Method, path: &str, body: Option<Value>, who: Option<&Session>) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(who) = who {
            req = req.header(header::COOKIE, &who.cookie);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        // Each request is a moment later, so lists ordered by time have a defined order.
        self.clock.advance_ms(1);
        Reply { status, headers, body }
    }

    async fn get(&self, path: &str, who: &Session) -> Reply {
        self.send(Method::GET, path, None, Some(who)).await
    }

    async fn post(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::POST, path, Some(body), Some(who)).await
    }

    async fn patch(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::PATCH, path, Some(body), Some(who)).await
    }

    async fn put(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::PUT, path, Some(body), Some(who)).await
    }

    async fn delete(&self, path: &str, who: &Session) -> Reply {
        self.send(Method::DELETE, path, None, Some(who)).await
    }

    /// The owner (also server admin) and the id of their organization.
    async fn setup(&self) -> (Session, String) {
        let r = self
            .send(
                Method::POST,
                "/api/setup",
                Some(json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                             "email": "joerg@example.de", "password": PASSWORD })),
                None,
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let session = Session { cookie: r.session_cookie(), user_id: r.body["id"].as_str().unwrap().into() };
        (session, r.body["orgs"][0]["id"].as_str().unwrap().into())
    }

    async fn login(&self, email: &str) -> Session {
        let r = self
            .send(Method::POST, "/api/auth/login", Some(json!({ "email": email, "password": PASSWORD })), None)
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        Session { cookie: r.session_cookie(), user_id: r.body["id"].as_str().unwrap().into() }
    }

    /// Creates an account through the admin API and signs it in.
    async fn user(&self, admin: &Session, name: &str, email: &str) -> Session {
        let r =
            self.post("/api/admin/users", json!({ "name": name, "email": email, "password": PASSWORD }), admin).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        self.login(email).await
    }

    /// Creates an account and adds it to `org` with `role`.
    async fn member(&self, owner: &Session, org: &str, name: &str, email: &str, role: &str) -> Session {
        let s = self.user(owner, name, email).await;
        let r = self.post(&format!("/api/orgs/{org}/members"), json!({ "email": email, "role": role }), owner).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        s
    }

    /// Sends the calls at the same moment, each from its own task; the answers in call order.
    async fn parallel(&self, calls: Vec<(Method, String, Value, Session)>) -> Vec<(StatusCode, Value)> {
        let mut tasks = Vec::new();
        for (method, path, body, who) in calls {
            let app = self.app.clone();
            tasks.push(tokio::spawn(async move {
                let req = Request::builder()
                    .method(method)
                    .uri(format!("/api{}", path.trim_start_matches("/api")))
                    .header(header::HOST, "kalzit.test")
                    .header(header::COOKIE, &who.cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap();
                let res = app.oneshot(req).await.unwrap();
                let status = res.status();
                let bytes = res.into_body().collect().await.unwrap().to_bytes();
                (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
            }));
        }
        let mut out = Vec::new();
        for task in tasks {
            out.push(task.await.unwrap());
        }
        out
    }

    async fn permissions(&self, org: &str, who: &Session) -> Vec<String> {
        let r = self.get(&format!("/api/orgs/{org}"), who).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body["permissions"].as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_string()).collect()
    }

    /// Audit actions in the order they were written.
    async fn audit_actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }

    async fn audit_summaries(&self) -> Vec<String> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT summary FROM audit_events").fetch_all(&self.state.db).await.unwrap();
        rows.into_iter().map(|(s,)| s).collect()
    }
}

fn uuid() -> String {
    uuid::Uuid::now_v7().to_string()
}

impl TestApp {
    /// A real dashboard of `org`: grants need an existing resource.
    async fn dashboard(&self, org: &str) -> String {
        let id = uuid();
        sqlx::query(
            "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at)              VALUES ($1, $2, 'Umsatz', 'umsatz', 1, 0, 0)",
        )
        .bind(&id)
        .bind(org)
        .execute(&self.state.db)
        .await
        .unwrap();
        id
    }
}

fn has(list: &[String], item: &str) -> bool {
    list.iter().any(|p| p == item)
}

#[tokio::test]
async fn members_are_listed_added_changed_and_removed() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let members = format!("/api/orgs/{org}/members");
    let ada = t.member(&owner, &org, "Ada Lovelace", "ada@example.de", "editor").await;
    let bob = t.user(&owner, "Bob", "bob@example.de").await;

    let list = t.get(&members, &owner).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    let items = list.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["email"], "ada@example.de", "newest first");
    assert_eq!(items[0]["role"], "editor");
    assert!(items[0]["joinedAt"].as_i64().is_some() && items[0]["userId"] == ada.user_id.as_str());
    assert_eq!(list.body["nextCursor"], Value::Null);
    let first = t.get(&format!("{members}?limit=1"), &owner).await;
    assert_eq!(first.body["items"].as_array().unwrap().len(), 1);
    let cursor = first.body["nextCursor"].as_str().unwrap();
    let second = t.get(&format!("{members}?limit=1&cursor={cursor}"), &owner).await;
    assert_eq!(second.body["items"][0]["name"], "Jörg Müller");
    assert_eq!(second.body["nextCursor"], Value::Null);
    for bad in ["limit=0", "limit=201", "cursor=xyz", "limit=abc", "sort=name"] {
        assert_eq!(t.get(&format!("{members}?{bad}"), &owner).await.code(), "validation", "{bad}");
    }

    // Editors may read the list (to share dashboards) but not change it; strangers see nothing.
    assert_eq!(t.get(&members, &ada).await.status, StatusCode::OK);
    let r = t.post(&members, json!({ "email": "bob@example.de", "role": "viewer" }), &ada).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"));
    assert_eq!(t.get(&members, &bob).await.status, StatusCode::NOT_FOUND);

    // Validation and conflicts.
    let r = t.post(&members, json!({ "email": "niemand@example.de", "role": "viewer" }), &owner).await;
    assert_eq!((r.code(), r.field()), ("validation", "email"));
    let r = t.post(&members, json!({ "email": "bob@example.de", "role": "superuser" }), &owner).await;
    assert_eq!((r.code(), r.field()), ("validation", "role"));
    let r = t.post(&members, json!({ "email": "ADA@example.de", "role": "viewer" }), &owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"));
    let r = t.post(&members, json!({ "email": "bob@example.de", "role": "viewer" }), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["role"], "viewer");

    let ada_path = format!("{members}/{}", ada.user_id);
    let r = t.patch(&ada_path, json!({ "role": "admin" }), &owner).await;
    assert_eq!((r.status, r.body["role"].as_str()), (StatusCode::OK, Some("admin")), "{}", r.body);
    assert!(has(&t.permissions(&org, &ada).await, "users:write"));
    assert_eq!(
        t.patch(&format!("{members}/{}", uuid()), json!({ "role": "viewer" }), &owner).await.status,
        StatusCode::NOT_FOUND
    );

    let bob_path = format!("{members}/{}", bob.user_id);
    assert_eq!(t.delete(&bob_path, &owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("/api/orgs/{org}"), &bob).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.delete(&bob_path, &owner).await.status, StatusCode::NOT_FOUND);

    let actions = t.audit_actions().await;
    for action in ["member.added", "member.role_changed", "member.removed"] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
    assert!(t.audit_summaries().await.iter().all(|s| !s.contains('@')), "no emails in audit summaries");
    t.finish().await;
}

#[tokio::test]
async fn owners_and_admins_cannot_hand_out_or_take_more_than_they_hold() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let members = format!("/api/orgs/{org}/members");
    let ada = t.member(&owner, &org, "Ada", "ada@example.de", "admin").await;
    let bob = t.member(&owner, &org, "Bob", "bob@example.de", "viewer").await;
    let owner_path = format!("{members}/{}", owner.user_id);
    let bob_path = format!("{members}/{}", bob.user_id);
    let ada_path = format!("{members}/{}", ada.user_id);

    // An admin cannot make an owner, demote or remove an owner, or make themselves owner.
    for (path, body) in [
        (&bob_path, json!({ "role": "owner" })),
        (&owner_path, json!({ "role": "viewer" })),
        (&ada_path, json!({ "role": "owner" })),
    ] {
        let r = t.patch(path, body, &ada).await;
        assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{path}: {}", r.body);
    }
    assert_eq!(t.delete(&owner_path, &ada).await.status, StatusCode::FORBIDDEN);
    let r = t.post(&members, json!({ "email": "joerg@example.de", "role": "viewer" }), &ada).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "already a member");
    // ...but may manage roles up to their own.
    assert_eq!(t.patch(&bob_path, json!({ "role": "admin" }), &ada).await.status, StatusCode::OK);

    // The last owner can neither leave nor step down; with a second owner they can.
    let r = t.patch(&owner_path, json!({ "role": "admin" }), &owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"), "{}", r.body);
    assert_eq!(t.delete(&owner_path, &owner).await.status, StatusCode::CONFLICT);
    assert_eq!(t.patch(&ada_path, json!({ "role": "owner" }), &owner).await.status, StatusCode::OK);
    assert_eq!(t.patch(&owner_path, json!({ "role": "admin" }), &owner).await.status, StatusCode::OK);
    assert_eq!(t.delete(&ada_path, &ada).await.status, StatusCode::CONFLICT, "ada is the last owner now");
    t.finish().await;
}

/// Both owners step down at the same moment; one must be refused.
async fn check_concurrent_owner_demotions(t: &TestApp, owner: &Session, org: &str) {
    let ada = t.member(owner, org, "Ada", "ada@example.de", "owner").await;
    let calls = [owner, &ada].map(|who| {
        (Method::PATCH, format!("/api/orgs/{org}/members/{}", who.user_id), json!({ "role": "admin" }), who.clone())
    });
    let mut statuses: Vec<StatusCode> = t.parallel(calls.to_vec()).await.into_iter().map(|(s, _)| s).collect();
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let (owners,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND role = 'owner'")
        .bind(org)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(owners, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_owner_demotions_keep_one_owner() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    check_concurrent_owner_demotions(&t, &owner, &org).await;
    t.finish().await;
}

/// Two admins give up their admin role at the same moment; one must be refused. (Each revokes their
/// own, so the loser is refused by the guard, not by the access check.)
async fn check_concurrent_admin_revocations(t: &TestApp, admin: &Session) {
    let r = t
        .post(
            "/api/admin/users",
            json!({ "name": "Ada", "email": "root2@example.de", "password": PASSWORD,
                                              "isServerAdmin": true }),
            admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let second = t.login("root2@example.de").await;
    let calls = [admin, &second].map(|who| {
        (Method::PATCH, format!("/api/admin/users/{}", who.user_id), json!({ "isServerAdmin": false }), who.clone())
    });
    let mut statuses: Vec<StatusCode> = t.parallel(calls.to_vec()).await.into_iter().map(|(s, _)| s).collect();
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let (admins,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE is_server_admin = 1 AND disabled = 0")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(admins, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_admin_revocations_keep_one_admin() {
    let t = test_app(None).await;
    let (admin, _) = t.setup().await;
    check_concurrent_admin_revocations(&t, &admin).await;
    t.finish().await;
}

/// The same request sent several times at once: grants and team member PUT answer 200 with the
/// one row, adding a member answers 409 for all but the first; never a 500.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_duplicate_writes_are_answered_cleanly() {
    const COPIES: usize = 6;
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let dashboard = t.dashboard(&org).await;

    let grant = json!({ "subjectType": "user", "subjectId": vic.user_id, "resourceType": "dashboard",
                        "resourceId": dashboard, "level": "edit" });
    let calls = vec![(Method::POST, format!("/api/orgs/{org}/grants"), grant, owner.clone()); COPIES];
    let replies = t.parallel(calls).await;
    let mut statuses: Vec<StatusCode> = replies.iter().map(|(s, _)| *s).collect();
    statuses.sort();
    assert_eq!(statuses[0], StatusCode::OK, "{replies:?}");
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::CREATED).count(), 1, "{replies:?}");
    assert!(statuses.iter().all(|s| *s == StatusCode::OK || *s == StatusCode::CREATED), "{replies:?}");
    let ids: std::collections::BTreeSet<&str> = replies.iter().map(|(_, b)| b["id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 1, "one grant: {replies:?}");

    t.user(&owner, "Neu", "neu@example.de").await;
    let add = json!({ "email": "neu@example.de", "role": "viewer" });
    let calls = vec![(Method::POST, format!("/api/orgs/{org}/members"), add, owner.clone()); COPIES];
    let replies = t.parallel(calls).await;
    let created = replies.iter().filter(|(s, _)| *s == StatusCode::CREATED).count();
    let conflicts =
        replies.iter().filter(|(s, b)| *s == StatusCode::CONFLICT && b["error"]["field"] == "email").count();
    assert_eq!((created, conflicts), (1, COPIES - 1), "{replies:?}");

    let team = t.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Betrieb" }), &owner).await;
    let path = format!("/api/orgs/{org}/teams/{}/members/{}", team.body["id"].as_str().unwrap(), vic.user_id);
    let calls = vec![(Method::PUT, path, json!({}), owner.clone()); COPIES];
    let replies = t.parallel(calls).await;
    assert!(replies.iter().all(|(s, b)| *s == StatusCode::OK && b["role"] == "member"), "{replies:?}");
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM team_members").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(rows, 1);
    t.finish().await;
}
#[tokio::test]
async fn teams_members_and_team_roles() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let teams = format!("/api/orgs/{org}/teams");
    let vera = t.member(&owner, &org, "Vera", "vera@example.de", "viewer").await;
    let max = t.member(&owner, &org, "Max", "max@example.de", "viewer").await;
    let stranger = t.user(&owner, "Fremd", "fremd@example.de").await;

    let r = t.post(&teams, json!({ "name": "  Betrieb  " }), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!((r.body["name"].as_str(), r.body["memberCount"].as_i64()), (Some("Betrieb"), Some(0)));
    let team_id = r.body["id"].as_str().unwrap().to_string();
    let team = format!("{teams}/{team_id}");
    let r = t.post(&teams, json!({ "name": "Betrieb" }), &owner).await;
    assert_eq!((r.status, r.field()), (StatusCode::CONFLICT, "name"));
    assert_eq!(t.post(&teams, json!({ "name": "" }), &owner).await.field(), "name");
    assert_eq!(t.post(&teams, json!({ "name": "Zweites" }), &owner).await.status, StatusCode::CREATED);

    // Viewers read teams but do not change them; strangers do not see them.
    assert_eq!(t.get(&teams, &vera).await.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(t.post(&teams, json!({ "name": "X" }), &vera).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.get(&team, &stranger).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("{teams}/{}", uuid()), &owner).await.status, StatusCode::NOT_FOUND);

    let r = t.patch(&team, json!({ "name": "Betrieb Nord" }), &owner).await;
    assert_eq!(r.body["name"], "Betrieb Nord");
    assert_eq!(t.patch(&team, json!({ "name": "Zweites" }), &owner).await.status, StatusCode::CONFLICT);

    // Members: only organization members join, the role is member or maintainer.
    let r = t.put(&format!("{team}/members/{}", vera.user_id), json!({ "role": "maintainer" }), &owner).await;
    assert_eq!((r.status, r.body["role"].as_str()), (StatusCode::OK, Some("maintainer")), "{}", r.body);
    let r = t.put(&format!("{team}/members/{}", stranger.user_id), json!({}), &owner).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t.put(&format!("{team}/members/{}", max.user_id), json!({ "role": "chief" }), &owner).await;
    assert_eq!(r.field(), "role");
    // A maintainer manages the team's members without teams:members; others may not.
    let max_path = format!("{team}/members/{}", max.user_id);
    assert_eq!(t.put(&max_path, json!({}), &max).await.status, StatusCode::FORBIDDEN);
    let r = t.put(&max_path, json!({}), &vera).await;
    assert_eq!((r.status, r.body["role"].as_str()), (StatusCode::OK, Some("member")), "{}", r.body);
    let list = t.get(&format!("{team}/members"), &vera).await;
    assert_eq!(list.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(t.get(&team, &owner).await.body["memberCount"], 2);

    // Team roles add to the members' permissions.
    assert!(!has(&t.permissions(&org, &max).await, "dashboards:write"));
    let r = t.put(&format!("{team}/roles"), json!({ "roles": ["editor"] }), &owner).await;
    assert_eq!(r.body["roles"], json!(["editor"]), "{}", r.body);
    assert!(has(&t.permissions(&org, &max).await, "dashboards:write"));
    for roles in [json!(["owner"]), json!(["superuser"]), json!([uuid()])] {
        let r = t.put(&format!("{team}/roles"), json!({ "roles": roles }), &owner).await;
        assert_eq!((r.code(), r.field()), ("validation", "roles"), "{roles}");
    }
    // Someone who manages teams but lacks the team's roles cannot hand them out by adding members,
    // nor give a team roles they do not hold.
    let body = json!({ "name": "Teamverwaltung", "permissions": ["teams:read", "teams:write", "teams:members"] });
    let role = t.post(&format!("/api/orgs/{org}/roles"), body, &owner).await;
    let tom = t.member(&owner, &org, "Tom", "tom@example.de", role.body["id"].as_str().unwrap()).await;
    let r = t.put(&format!("{team}/members/{}", tom.user_id), json!({}), &tom).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);
    assert_eq!(t.delete(&max_path, &tom).await.status, StatusCode::FORBIDDEN);
    let r = t.put(&format!("{teams}/{}/roles", team_id), json!({ "roles": ["admin"] }), &tom).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let ada = t.member(&owner, &org, "Ada", "ada@example.de", "admin").await;
    let r = t.put(&format!("{team}/roles"), json!({ "roles": ["admin"] }), &ada).await;
    assert_eq!(r.status, StatusCode::OK, "admins may hand out admin: {}", r.body);
    assert_eq!(t.delete(&max_path, &owner).await.status, StatusCode::NO_CONTENT);
    assert!(!has(&t.permissions(&org, &max).await, "dashboards:write"));
    assert_eq!(t.delete(&max_path, &owner).await.status, StatusCode::NOT_FOUND);

    assert_eq!(t.delete(&team, &owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&team, &owner).await.status, StatusCode::NOT_FOUND);
    assert!(!has(&t.permissions(&org, &vera).await, "users:write"));

    let actions = t.audit_actions().await;
    for action in [
        "team.created",
        "team.renamed",
        "team.member_added",
        "team.member_removed",
        "team.roles_changed",
        "team.deleted",
    ] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
    t.finish().await;
}

#[tokio::test]
async fn custom_roles_are_created_assigned_changed_and_deleted() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let roles = format!("/api/orgs/{org}/roles");
    let ada = t.member(&owner, &org, "Ada", "ada@example.de", "admin").await;
    let bob = t.member(&owner, &org, "Bob", "bob@example.de", "viewer").await;

    let list = t.get(&roles, &owner).await;
    let ids: Vec<&str> = list.body["items"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["owner", "admin", "editor", "viewer"]);
    assert_eq!(list.body["items"][3]["builtin"], true);
    assert_eq!(t.get(&roles, &bob).await.status, StatusCode::FORBIDDEN, "viewers lack roles:read");

    let body =
        json!({ "name": "Prüfer", "description": "Liest das Audit-Log", "permissions": ["audit:read", "users:read"] });
    let r = t.post(&roles, body, &ada).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["permissions"], json!(["users:read", "audit:read"]));
    let role_id = r.body["id"].as_str().unwrap().to_string();
    let role = format!("{roles}/{role_id}");

    for (body, field) in [
        (json!({ "name": "Prüfer", "permissions": [] }), "name"),
        (json!({ "name": "Admin", "permissions": [] }), "name"),
        // Case-insensitive, also beyond ASCII.
        (json!({ "name": "PRÜFER", "permissions": [] }), "name"),
        (json!({ "name": "X", "permissions": ["rockets:launch"] }), "permissions"),
        (json!({ "name": "X", "description": "a\u{0}b", "permissions": [] }), "description"),
    ] {
        assert_eq!(t.post(&roles, body.clone(), &ada).await.field(), field, "{body}");
    }
    // org:delete belongs to owners alone: no custom role may contain it, not even an owner's.
    for who in [&ada, &owner] {
        let r = t.post(&roles, json!({ "name": "Löscher", "permissions": ["org:delete"] }), who).await;
        assert_eq!((r.code(), r.field()), ("validation", "permissions"), "{}", r.body);
    }
    // Someone who manages roles but lacks users:write cannot put it into a role.
    let body = json!({ "name": "Rollenpflege", "permissions": ["roles:read", "roles:write"] });
    let keeper_role = t.post(&roles, body, &owner).await;
    let keeper_role = keeper_role.body["id"].as_str().unwrap();
    let keeper = t.member(&owner, &org, "Kim", "kim@example.de", keeper_role).await;
    let r = t.post(&roles, json!({ "name": "Mehr", "permissions": ["users:write"] }), &keeper).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"));

    // A member with the custom role holds exactly its permissions.
    let r = t.patch(&format!("/api/orgs/{org}/members/{}", bob.user_id), json!({ "role": role_id }), &ada).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.permissions(&org, &bob).await, ["users:read", "audit:read"]);
    let r = t.patch(&role, json!({ "permissions": ["audit:read"], "name": "Revision" }), &ada).await;
    assert_eq!((r.body["name"].as_str(), r.body["permissions"].clone()), (Some("Revision"), json!(["audit:read"])));
    assert_eq!(t.permissions(&org, &bob).await, ["audit:read"]);
    let r = t.patch(&role, json!({ "permissions": ["org:delete"] }), &owner).await;
    assert_eq!(r.field(), "permissions");
    let r = t.patch(&role, json!({ "permissions": ["users:write"] }), &keeper).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // Built-in roles are fixed; unknown ids are not found.
    assert_eq!(t.patch(&format!("{roles}/viewer"), json!({ "name": "X" }), &owner).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&format!("{roles}/admin"), &owner).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&format!("{roles}/{}", uuid()), &owner).await.status, StatusCode::NOT_FOUND);

    // A role in use as an org role stays until its members have another one.
    let r = t.delete(&role, &ada).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"));
    t.patch(&format!("/api/orgs/{org}/members/{}", bob.user_id), json!({ "role": "viewer" }), &ada).await;
    let team = t.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Revision" }), &ada).await;
    let team_roles = format!("/api/orgs/{org}/teams/{}/roles", team.body["id"].as_str().unwrap());
    assert_eq!(t.put(&team_roles, json!({ "roles": [role_id] }), &ada).await.status, StatusCode::OK);
    assert_eq!(t.delete(&role, &ada).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&team_roles.replace("/roles", ""), &ada).await.body["roles"], json!([]), "team role removed too");
    assert_eq!(
        t.get(&roles, &owner).await.body["items"].as_array().unwrap().len(),
        5,
        "four built-ins and Rollenpflege"
    );

    let actions = t.audit_actions().await;
    for action in ["role.created", "role.updated", "role.deleted"] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
    t.finish().await;
}

#[tokio::test]
async fn grants_extend_access_per_resource() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let grants = format!("/api/orgs/{org}/grants");
    let ed = t.member(&owner, &org, "Ed", "ed@example.de", "editor").await;
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let stranger = t.user(&owner, "Fremd", "fremd@example.de").await;
    let dashboard = t.dashboard(&org).await;
    // Grants need a data source that exists in the organization.
    let datasource = uuid();
    sqlx::query(
        "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
         VALUES ($1, $2, 'Quelle', 'sqlite', '{}', 0, 0)",
    )
    .bind(&datasource)
    .bind(&org)
    .execute(&t.state.db)
    .await
    .unwrap();
    let explain = |p: &str, rt: &str, id: &str| {
        format!("/api/orgs/{org}/explain?permission={p}&resourceType={rt}&resourceId={id}")
    };

    // Before any grant the viewer may only read the dashboard.
    let r = t.get(&explain("dashboards:write", "dashboard", &dashboard), &vic).await;
    assert_eq!((r.status, r.body["allowed"].as_bool()), (StatusCode::OK, Some(false)), "{}", r.body);

    let body = |subject_type: &str, subject_id: &str, rt: &str, id: &str, level: &str| json!({ "subjectType": subject_type, "subjectId": subject_id, "resourceType": rt, "resourceId": id, "level": level });
    let r = t.post(&grants, body("user", &vic.user_id, "dashboard", &dashboard, "edit"), &ed).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!((r.body["subjectName"].as_str(), r.body["level"].as_str()), (Some("Vic"), Some("edit")));
    let grant_id = r.body["id"].as_str().unwrap().to_string();

    let r = t.get(&explain("dashboards:write", "dashboard", &dashboard), &vic).await;
    assert_eq!(r.body["allowed"], true);
    assert_eq!(r.body["sources"][0]["kind"], "grant");
    assert_eq!(r.body["sources"][0]["grantId"], grant_id.as_str());
    let r = t.get(&explain("dashboards:read", "dashboard", &dashboard), &vic).await;
    assert_eq!(r.body["sources"].as_array().unwrap().len(), 2, "role and grant: {}", r.body);
    assert_eq!(r.body["sources"][0], json!({ "kind": "orgRole", "role": "viewer" }));

    // Changing the level of an existing grant answers 200 and keeps one grant.
    let r = t.post(&grants, body("user", &vic.user_id, "dashboard", &dashboard, "view"), &ed).await;
    assert_eq!((r.status, r.body["id"].as_str()), (StatusCode::OK, Some(grant_id.as_str())));
    let list = t.get(&format!("{grants}?resourceType=dashboard&resourceId={dashboard}"), &ed).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    assert_eq!(list.body["items"].as_array().unwrap().len(), 1);
    assert_eq!(list.body["items"][0]["level"], "view");

    // Grants to teams and roles show their names.
    let team = t.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Leser" }), &owner).await;
    let team_id = team.body["id"].as_str().unwrap();
    let r = t.post(&grants, body("team", team_id, "dashboard", &dashboard, "view"), &ed).await;
    assert_eq!(r.body["subjectName"], "Leser");
    let r = t.post(&grants, body("role", "viewer", "dashboard", &dashboard, "view"), &ed).await;
    assert_eq!(r.body["subjectName"], "viewer");

    // Who may manage grants: dashboards:share for dashboards, datasources:permissions for sources.
    assert_eq!(
        t.get(&format!("{grants}?resourceType=dashboard&resourceId={dashboard}"), &vic).await.status,
        StatusCode::FORBIDDEN
    );
    let r = t.post(&grants, body("user", &vic.user_id, "datasource", &datasource, "query"), &ed).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.post(&grants, body("user", &vic.user_id, "datasource", &datasource, "query"), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED);
    // The grant makes the source visible to a viewer for querying, not for editing.
    let r = t.get(&explain("datasources:query", "datasource", &datasource), &vic).await;
    assert_eq!(r.body["allowed"], true);
    let r = t.get(&explain("datasources:write", "datasource", &datasource), &vic).await;
    assert_eq!(r.body["allowed"], false);
    // A data source the viewer has no grant on does not exist for them.
    assert_eq!(t.get(&explain("datasources:query", "datasource", &uuid()), &vic).await.status, StatusCode::NOT_FOUND);

    // Validation.
    for (b, field) in [
        (body("user", &vic.user_id, "dashboard", &dashboard, "query"), "level"),
        (body("user", &vic.user_id, "chart", &dashboard, "view"), "resourceType"),
        (body("group", &vic.user_id, "dashboard", &dashboard, "view"), "subjectType"),
        (body("user", &stranger.user_id, "dashboard", &dashboard, "view"), "subjectId"),
        (body("team", &uuid(), "dashboard", &dashboard, "view"), "subjectId"),
        (body("role", "superuser", "dashboard", &dashboard, "view"), "subjectId"),
    ] {
        let r = t.post(&grants, b.clone(), &owner).await;
        assert_eq!((r.code(), r.field()), ("validation", field), "{b}");
    }
    let r = t.post(&grants, body("user", &vic.user_id, "dashboard", "not-a-uuid", "view"), &owner).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("{grants}?resourceType=dashboard"), &owner).await.field(), "resourceId");
    assert_eq!(t.get(&format!("/api/orgs/{org}/explain?permission=fly"), &owner).await.field(), "permission");
    assert_eq!(
        t.get(&format!("/api/orgs/{org}/explain?permission=dashboards:read&resourceId={dashboard}"), &owner)
            .await
            .field(),
        "resourceType"
    );
    let r = t.get(&format!("/api/orgs/{org}/explain?permission=org:delete"), &owner).await;
    assert_eq!((r.body["allowed"].as_bool(), r.body["sources"][0]["kind"].as_str()), (Some(true), Some("orgRole")));

    // Strangers and other organizations: the grant does not exist for them.
    assert_eq!(t.delete(&format!("{grants}/{grant_id}"), &stranger).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.delete(&format!("{grants}/{grant_id}"), &vic).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&format!("{grants}/{grant_id}"), &ed).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.delete(&format!("{grants}/{grant_id}"), &ed).await.status, StatusCode::NOT_FOUND);

    // Removing a member removes their grants.
    t.delete(&format!("/api/orgs/{org}/members/{}", vic.user_id), &owner).await;
    let (left,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM resource_grants WHERE subject_id = $1")
        .bind(&vic.user_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(left, 0);

    let actions = t.audit_actions().await;
    for action in ["grant.created", "grant.changed", "grant.deleted"] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
    t.finish().await;
}

#[tokio::test]
async fn nobody_grants_more_than_they_hold_on_a_resource() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let grants = format!("/api/orgs/{org}/grants");
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let max = t.member(&owner, &org, "Max", "max@example.de", "viewer").await;
    let dashboard = t.dashboard(&org).await;
    let grant = |who: &str, level: &str| json!({ "subjectType": "user", "subjectId": who, "resourceType": "dashboard", "resourceId": dashboard, "level": level });
    // A viewer with an admin grant on one dashboard manages its grants...
    assert_eq!(t.post(&grants, grant(&vic.user_id, "admin"), &owner).await.status, StatusCode::CREATED);
    let r = t.post(&grants, grant(&max.user_id, "edit"), &vic).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    // ...but not on another one.
    let other = json!({ "subjectType": "user", "subjectId": max.user_id, "resourceType": "dashboard",
                        "resourceId": t.dashboard(&org).await, "level": "view" });
    assert_eq!(t.post(&grants, other, &vic).await.status, StatusCode::FORBIDDEN);
    // An edit grant does not let Max share further.
    assert_eq!(t.post(&grants, grant(&vic.user_id, "view"), &max).await.status, StatusCode::FORBIDDEN);
    t.finish().await;
}

#[tokio::test]
async fn server_admins_manage_accounts() {
    let t = test_app(None).await;
    let (admin, org) = t.setup().await;
    let users = "/api/admin/users";

    let r = t
        .post(
            users,
            json!({ "name": "Ada", "email": "Ada@Example.de", "password": PASSWORD, "isServerAdmin": false }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!((r.body["email"].as_str(), r.body["disabled"].as_bool()), (Some("ada@example.de"), Some(false)));
    assert!(r.body.get("passwordHash").is_none() && r.body.get("password_hash").is_none());
    let ada_id = r.body["id"].as_str().unwrap().to_string();
    for (body, field) in [
        (json!({ "name": "A", "email": "ada@example.de", "password": PASSWORD }), "email"),
        (json!({ "name": "A", "email": "a@b", "password": PASSWORD }), "email"),
        (json!({ "name": "A", "email": "x@example.de", "password": "kurz" }), "password"),
        (json!({ "name": " ", "email": "x@example.de", "password": PASSWORD }), "name"),
    ] {
        assert_eq!(t.post(users, body.clone(), &admin).await.field(), field, "{body}");
    }
    let list = t.get(users, &admin).await;
    assert_eq!(list.body["items"][0]["id"], ada_id.as_str());
    assert_eq!(list.body["items"][1]["isServerAdmin"], true);

    // Disabling ends every session at once; enabling lets the account sign in again.
    let ada = t.login("ada@example.de").await;
    let r = t.patch(&format!("{users}/{ada_id}"), json!({ "disabled": true }), &admin).await;
    assert_eq!(r.body["disabled"], true, "{}", r.body);
    assert_eq!(t.get("/api/me", &ada).await.status, StatusCode::UNAUTHORIZED);
    let (sessions,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sessions WHERE user_id = $1")
        .bind(&ada_id)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(sessions, 0);
    t.patch(&format!("{users}/{ada_id}"), json!({ "disabled": false }), &admin).await;
    let ada = t.login("ada@example.de").await;

    // A new password ends the account's sessions.
    let r = t.patch(&format!("{users}/{ada_id}"), json!({ "password": "Ein neues langes Passwort" }), &admin).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(t.get("/api/me", &ada).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.patch(&format!("{users}/{ada_id}"), json!({ "password": "kurz" }), &admin).await.field(), "password");
    assert_eq!(
        t.patch(&format!("{users}/{}", uuid()), json!({ "name": "X" }), &admin).await.status,
        StatusCode::NOT_FOUND
    );

    // The last server admin can neither be disabled nor lose the role.
    let me = format!("{users}/{}", admin.user_id);
    for body in [json!({ "disabled": true }), json!({ "isServerAdmin": false })] {
        let r = t.patch(&me, body, &admin).await;
        assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"), "{}", r.body);
    }
    let r = t.patch(&format!("{users}/{ada_id}"), json!({ "isServerAdmin": true, "name": "Ada L." }), &admin).await;
    assert_eq!((r.body["isServerAdmin"].as_bool(), r.body["name"].as_str()), (Some(true), Some("Ada L.")));
    assert_eq!(t.patch(&me, json!({ "isServerAdmin": false }), &admin).await.status, StatusCode::OK);
    // No longer an admin: the admin area refuses, the organization stays.
    assert_eq!(t.get(users, &admin).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.get(&format!("/api/orgs/{org}"), &admin).await.status, StatusCode::OK);

    let actions = t.audit_actions().await;
    for action in ["user.created", "user.disabled", "user.enabled", "user.updated"] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
    assert!(t.audit_summaries().await.iter().all(|s| !s.contains("Ein neues")), "no passwords in audit summaries");
    t.finish().await;
}

#[tokio::test]
async fn server_admins_create_and_rename_organizations() {
    let t = test_app(None).await;
    let (admin, _) = t.setup().await;
    let ada = t.user(&admin, "Ada", "ada@example.de").await;
    let r = t.post("/api/admin/orgs", json!({ "name": "Zweite GmbH", "ownerUserId": ada.user_id }), &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["memberCount"], 1);
    let org = r.body["id"].as_str().unwrap().to_string();
    let me = t.get("/api/me", &ada).await;
    assert_eq!(
        (me.body["orgs"][0]["id"].as_str(), me.body["orgs"][0]["role"].as_str()),
        (Some(org.as_str()), Some("owner"))
    );
    // The admin who created it is not a member.
    assert_eq!(t.get(&format!("/api/orgs/{org}"), &admin).await.status, StatusCode::NOT_FOUND);

    let r = t.post("/api/admin/orgs", json!({ "name": "X", "ownerUserId": uuid() }), &admin).await;
    assert_eq!(r.field(), "ownerUserId");
    assert_eq!(
        t.post("/api/admin/orgs", json!({ "name": "", "ownerUserId": ada.user_id }), &admin).await.field(),
        "name"
    );
    let r = t.patch(&format!("/api/admin/orgs/{org}"), json!({ "name": "Zweite AG" }), &admin).await;
    assert_eq!(r.body["name"], "Zweite AG");
    assert_eq!(
        t.patch(&format!("/api/admin/orgs/{}", uuid()), json!({ "name": "X" }), &admin).await.status,
        StatusCode::NOT_FOUND
    );
    let list = t.get("/api/admin/orgs?limit=1", &admin).await;
    assert_eq!(list.body["items"][0]["id"], org.as_str());
    assert!(list.body["nextCursor"].is_string());
    assert_eq!(t.get("/api/admin/orgs", &ada).await.status, StatusCode::FORBIDDEN);

    let actions = t.audit_actions().await;
    assert!(has(&actions, "org.created") && has(&actions, "org.renamed"), "{actions:?}");
    t.finish().await;
}

#[tokio::test]
async fn users_manage_their_own_name_password_and_sessions() {
    let t = test_app(None).await;
    let (first, _) = t.setup().await;
    let second = t.login("joerg@example.de").await;

    let r = t.patch("/api/me", json!({ "name": "Jörg M." }), &first).await;
    assert_eq!((r.status, r.body["name"].as_str()), (StatusCode::OK, Some("Jörg M.")));
    assert_eq!(t.patch("/api/me", json!({ "name": "" }), &first).await.field(), "name");
    assert_eq!(t.patch("/api/me", json!({ "name": "X", "isServerAdmin": false }), &first).await.code(), "validation");

    let sessions = t.get("/api/me/sessions", &first).await;
    let items = sessions.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let current: Vec<bool> = items.iter().map(|s| s["current"].as_bool().unwrap()).collect();
    assert_eq!(current, [false, true], "newest first; this browser's session marked");
    let (hashes,): (String,) =
        sqlx::query_as("SELECT token_hash FROM sessions LIMIT 1").fetch_one(&t.state.db).await.unwrap();
    assert!(items.iter().all(|s| s["id"] != hashes.as_str() && s.get("tokenHash").is_none()));
    let second_id = items[0]["id"].as_str().unwrap().to_string();

    // Ending one session by id; another user's session ids are unknown.
    let other = t.user(&first, "Ada", "ada@example.de").await;
    assert_eq!(t.delete(&format!("/api/me/sessions/{second_id}"), &other).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.delete(&format!("/api/me/sessions/{second_id}"), &first).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get("/api/me", &second).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.get("/api/me", &first).await.status, StatusCode::OK);

    // Ending all others.
    let third = t.login("joerg@example.de").await;
    let r = t.post("/api/me/sessions/revoke-others", json!({}), &first).await;
    assert_eq!(r.body, json!({ "revoked": 1 }));
    assert_eq!(t.get("/api/me", &third).await.status, StatusCode::UNAUTHORIZED);

    // Changing the password needs the current one and ends the other sessions.
    let fourth = t.login("joerg@example.de").await;
    let wrong = t
        .post("/api/me/password", json!({ "current": "falsch falsch", "new": "Ein neues langes Passwort" }), &first)
        .await;
    assert_eq!((wrong.code(), wrong.field()), ("validation", "current"));
    let weak = t.post("/api/me/password", json!({ "current": PASSWORD, "new": "kurz" }), &first).await;
    assert_eq!((weak.code(), weak.field()), ("validation", "new"));
    let r =
        t.post("/api/me/password", json!({ "current": PASSWORD, "new": "Ein neues langes Passwort" }), &first).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.get("/api/me", &fourth).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.get("/api/me", &first).await.status, StatusCode::OK);
    let old = t
        .send(Method::POST, "/api/auth/login", Some(json!({ "email": "joerg@example.de", "password": PASSWORD })), None)
        .await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);

    let actions = t.audit_actions().await;
    for action in ["user.updated", "auth.session_ended", "auth.sessions_revoked", "user.password_changed"] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
    assert!(t.audit_summaries().await.iter().all(|s| !s.contains("Passwort")), "no passwords in audit summaries");
    t.finish().await;
}

/// Disabling an owner of two organizations while members change in both at the same moment: no
/// deadlock or 500, and each organization keeps an enabled owner. On PostgreSQL this needs the
/// disable path to lock the organizations before their owner rows, like member changes do.
async fn check_disable_races_member_changes(t: &TestApp, admin: &Session) {
    let ada = t.user(admin, "Ada", "ada.race@example.de").await;
    let r = t.post("/api/admin/orgs", json!({ "name": "Erste", "ownerUserId": admin.user_id }), admin).await;
    let first_org = r.body["id"].as_str().unwrap().to_string();
    let first_org = first_org.as_str();
    let r = t.post("/api/admin/orgs", json!({ "name": "Zweite", "ownerUserId": ada.user_id }), admin).await;
    let second_org = r.body["id"].as_str().unwrap().to_string();
    let add = |email: &str| json!({ "email": email, "role": "owner" });
    let r = t.post(&format!("/api/orgs/{second_org}/members"), add("joerg@example.de"), &ada).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let r = t.post(&format!("/api/orgs/{first_org}/members"), add("ada.race@example.de"), admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);

    let demote = |org: &str, who: &Session| format!("/api/orgs/{org}/members/{}", who.user_id);
    let calls = vec![
        (Method::PATCH, format!("/api/admin/users/{}", ada.user_id), json!({ "disabled": true }), admin.clone()),
        (Method::PATCH, demote(first_org, &ada), json!({ "role": "admin" }), admin.clone()),
        (Method::PATCH, demote(&second_org, &ada), json!({ "role": "admin" }), admin.clone()),
        (Method::PATCH, demote(&second_org, admin), json!({ "role": "admin" }), ada.clone()),
    ];
    let replies = t.parallel(calls).await;
    let fine = [StatusCode::OK, StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN, StatusCode::CONFLICT];
    assert!(replies.iter().all(|(s, _)| fine.contains(s)), "{replies:?}");
    for org in [first_org, second_org.as_str()] {
        let (owners,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM org_members m JOIN users u ON u.id = m.user_id \
             WHERE m.org_id = $1 AND m.role = 'owner' AND u.disabled = 0",
        )
        .bind(org)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
        assert!(owners >= 1, "{org} lost its last enabled owner: {replies:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabling_an_owner_races_member_changes_cleanly() {
    let t = test_app(None).await;
    let (admin, _) = t.setup().await;
    check_disable_races_member_changes(&t, &admin).await;
    t.finish().await;
}

/// Handlers that hold the organization lock must not need a second connection: with more
/// parallel writes than pool connections, every one still succeeds.
///
/// Such a handler cannot finish until a timeout fires: with one connection it waits out the
/// pool's acquire timeout and answers `500`; with several, the writers holding the others give
/// up after SQLite's busy timeout and answer `503 busy`. Nothing on this path retries, so every
/// delete answering `204` shows that none of them waited for a timeout, however slow the machine
/// is. One connection shows the mistake on every run; four show it only when the other writers
/// happen to hold the rest of the pool at that moment, so that round adds coverage of real
/// contention, not certainty. The time limit only stops a hang and lies far above both timeouts.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_grant_deletes_do_not_drain_the_pool() {
    for pool_size in [1, POOL_SIZE] {
        let parallel = 3 * POOL_SIZE as usize;
        let t = test_app_with_pool(None, pool_size).await;
        let (owner, org) = t.setup().await;
        let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
        let mut calls = Vec::new();
        for _ in 0..parallel {
            let grant = json!({ "subjectType": "user", "subjectId": vic.user_id, "resourceType": "dashboard",
                                "resourceId": t.dashboard(&org).await, "level": "edit" });
            let r = t.post(&format!("/api/orgs/{org}/grants"), grant, &owner).await;
            assert_eq!(r.status, StatusCode::CREATED);
            let path = format!("/api/orgs/{org}/grants/{}", r.body["id"].as_str().unwrap());
            calls.push((Method::DELETE, path, Value::Null, owner.clone()));
        }
        let replies = tokio::time::timeout(std::time::Duration::from_secs(300), t.parallel(calls))
            .await
            .unwrap_or_else(|_| panic!("the deletes hang with {pool_size} connection(s)"));
        let failed: Vec<_> = replies.iter().filter(|(s, _)| *s != StatusCode::NO_CONTENT).collect();
        assert!(failed.is_empty(), "{pool_size} connection(s): {failed:?}");
        let (left,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM resource_grants").fetch_one(&t.state.db).await.unwrap();
        assert_eq!(left, 0);
        t.finish().await;
    }
}

#[tokio::test]
async fn removing_a_member_needs_what_they_hold_through_teams_and_grants() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    // Holds what a viewer has, plus managing members.
    let permissions = ["dashboards:read", "folders:read", "analyses:read", "teams:read", "users:read", "users:write"];
    let body = json!({ "name": "Personal", "permissions": permissions });
    let hr_role = t.post(&format!("/api/orgs/{org}/roles"), body, &owner).await;
    let hr = t.member(&owner, &org, "Hanna", "hanna@example.de", hr_role.body["id"].as_str().unwrap()).await;
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let vic_path = format!("/api/orgs/{org}/members/{}", vic.user_id);

    // Vic is admin through a team: removing Vic would take that away.
    let team = t.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Leitung" }), &owner).await;
    let team = format!("/api/orgs/{org}/teams/{}", team.body["id"].as_str().unwrap());
    t.put(&format!("{team}/members/{}", vic.user_id), json!({}), &owner).await;
    assert_eq!(t.put(&format!("{team}/roles"), json!({ "roles": ["admin"] }), &owner).await.status, StatusCode::OK);
    let r = t.delete(&vic_path, &hr).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"), "{}", r.body);

    // Out of the team, Vic still holds an admin grant on a dashboard.
    t.delete(&format!("{team}/members/{}", vic.user_id), &owner).await;
    let grant = json!({ "subjectType": "user", "subjectId": vic.user_id, "resourceType": "dashboard",
                        "resourceId": t.dashboard(&org).await, "level": "admin" });
    assert_eq!(t.post(&format!("/api/orgs/{org}/grants"), grant, &owner).await.status, StatusCode::CREATED);
    assert_eq!(t.delete(&vic_path, &hr).await.status, StatusCode::FORBIDDEN);

    // With neither, a plain viewer can be removed.
    let plain = t.member(&owner, &org, "Pia", "pia@example.de", "viewer").await;
    let r = t.delete(&format!("/api/orgs/{org}/members/{}", plain.user_id), &hr).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn names_are_unique_regardless_of_case_and_deleted_teams_leave_nothing() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let teams = format!("/api/orgs/{org}/teams");
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let r = t.post(&teams, json!({ "name": "Ölförderung" }), &owner).await;
    let team = format!("{teams}/{}", r.body["id"].as_str().unwrap());
    let r = t.post(&teams, json!({ "name": "ÖLFÖRDERUNG" }), &owner).await;
    assert_eq!((r.status, r.field()), (StatusCode::CONFLICT, "name"));
    let other = t.post(&teams, json!({ "name": "Andere" }), &owner).await;
    let other = format!("{teams}/{}", other.body["id"].as_str().unwrap());
    assert_eq!(t.patch(&other, json!({ "name": "ölförderung" }), &owner).await.status, StatusCode::CONFLICT);
    // Changing only the case of a team's own name is fine.
    assert_eq!(t.patch(&team, json!({ "name": "ÖLförderung" }), &owner).await.status, StatusCode::OK);

    t.put(&format!("{team}/members/{}", vic.user_id), json!({}), &owner).await;
    t.put(&format!("{team}/roles"), json!({ "roles": ["editor"] }), &owner).await;
    assert_eq!(t.delete(&team, &owner).await.status, StatusCode::NO_CONTENT);
    for table in ["team_members", "team_roles"] {
        let (rows,): (i64,) = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(&t.state.db)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{table}");
    }
    t.finish().await;
}

#[tokio::test]
async fn disabled_accounts_do_not_count_as_owners() {
    let t = test_app(None).await;
    let (admin, org) = t.setup().await;
    let ada = t.user(&admin, "Ada", "ada@example.de").await;
    let ada_path = format!("/api/admin/users/{}", ada.user_id);
    t.patch(&ada_path, json!({ "disabled": true }), &admin).await;
    let r = t.post("/api/admin/orgs", json!({ "name": "Zweite", "ownerUserId": ada.user_id }), &admin).await;
    assert_eq!((r.code(), r.field()), ("validation", "ownerUserId"));
    t.patch(&ada_path, json!({ "disabled": false }), &admin).await;

    // Ada becomes a second owner of the first organization, then is disabled: the admin, still
    // an owner there, is now its last enabled owner.
    let r = t
        .post(&format!("/api/orgs/{org}/members"), json!({ "email": "ada@example.de", "role": "owner" }), &admin)
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    assert_eq!(t.patch(&ada_path, json!({ "disabled": true }), &admin).await.status, StatusCode::OK);
    let r = t.patch(&format!("/api/orgs/{org}/members/{}", admin.user_id), json!({ "role": "admin" }), &admin).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"), "a disabled owner does not count");
    // And the last enabled owner of an organization cannot be disabled.
    let r = t
        .post(
            "/api/admin/users",
            json!({ "name": "Root", "email": "root@example.de", "password": PASSWORD,
                                              "isServerAdmin": true }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED);
    let root = t.login("root@example.de").await;
    let r = t.patch(&format!("/api/admin/users/{}", admin.user_id), json!({ "disabled": true }), &root).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"), "{}", r.body);
    // With Ada enabled again, the admin may be disabled.
    t.patch(&ada_path, json!({ "disabled": false }), &root).await;
    let r = t.patch(&format!("/api/admin/users/{}", admin.user_id), json!({ "disabled": true }), &root).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn ended_sessions_are_not_listed() {
    let t = test_app(None).await;
    let (owner, _) = t.setup().await;
    let other = t.login("joerg@example.de").await;
    // The other session reaches its lifetime; the hourly cleanup has not run yet.
    sqlx::query("UPDATE sessions SET expires_at = $1 WHERE token_hash <> $2")
        .bind(t.clock.now_ms())
        .bind(kalzit::auth::session::hash_token(owner.cookie.split_once('=').unwrap().1))
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.get("/api/me/sessions", &owner).await;
    let items = r.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{}", r.body);
    assert_eq!(items[0]["current"], true);
    assert_eq!(t.get("/api/me", &other).await.status, StatusCode::UNAUTHORIZED);
    t.finish().await;
}

#[tokio::test]
async fn password_checks_count_for_the_account_but_are_not_refused_by_it() {
    let t = test_app(None).await;
    let (owner, _) = t.setup().await;
    let limit = t.state.config.security.login_max_failures;
    let sign_in = |password: &'static str| {
        t.send(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "email": "joerg@example.de", "password": password })),
            None,
        )
    };
    // Wrong passwords on the sign-in page use up the account's shared budget ...
    for _ in 0..limit {
        assert_eq!(sign_in("falsch falsch").await.status, StatusCode::UNAUTHORIZED);
    }
    // ... which does not refuse a password check of a session: it has its own budget.
    let r =
        t.post("/api/me/password", json!({ "current": PASSWORD, "new": "Ein neues langes Passwort" }), &owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    t.finish().await;

    // Wrong current passwords of a session count for the account: a sign-in from a browser the
    // account does not know is refused once they used it up.
    let mut t = test_app(None).await;
    let (owner, _) = t.setup().await;
    for _ in 0..limit {
        let r = t
            .post("/api/me/password", json!({ "current": "falsch falsch", "new": "Ein neues langes Passwort" }), &owner)
            .await;
        assert_eq!(r.field(), "current");
    }
    t.app = router(t.state.clone()).layer(MockConnectInfo("192.0.2.1:1".parse::<SocketAddr>().unwrap()));
    let r = t
        .send(Method::POST, "/api/auth/login", Some(json!({ "email": "joerg@example.de", "password": PASSWORD })), None)
        .await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"), "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn guessing_the_current_password_is_rate_limited() {
    let t = test_app(None).await;
    let (owner, _) = t.setup().await;
    let limit = t.state.config.security.login_max_failures;
    for _ in 0..limit {
        let r = t
            .post("/api/me/password", json!({ "current": "falsch falsch", "new": "Ein neues langes Passwort" }), &owner)
            .await;
        assert_eq!(r.field(), "current");
    }
    let r =
        t.post("/api/me/password", json!({ "current": PASSWORD, "new": "Ein neues langes Passwort" }), &owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    let wait = r.body["error"]["retryAfterSecs"].as_u64().expect("retryAfterSecs");
    assert_eq!(r.headers.get(header::RETRY_AFTER).unwrap().to_str().unwrap(), wait.to_string());
    t.finish().await;
}

/// The access model on PostgreSQL, in a throwaway schema so the test database is left as it was.
#[tokio::test]
async fn postgres_access_model() {
    let Some(base) = common::postgres_url("PostgreSQL test") else { return };
    let schema = format!("kalzit_test_{}", uuid::Uuid::now_v7().simple());
    sqlx::any::install_default_drivers();
    let admin_pool = sqlx::AnyPool::connect(&base).await.unwrap();
    // The schema name is a fixed prefix plus UUID hex digits, so it is safe to splice in.
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE SCHEMA {schema}"))).execute(&admin_pool).await.unwrap();
    let sep = if base.contains('?') { '&' } else { '?' };
    let t = test_app(Some(format!("{base}{sep}options=-csearch_path%3D{schema}"))).await;

    let (owner, org) = t.setup().await;
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let team = t.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Betrieb" }), &owner).await;
    let team = format!("/api/orgs/{org}/teams/{}", team.body["id"].as_str().unwrap());
    assert_eq!(t.put(&format!("{team}/members/{}", vic.user_id), json!({}), &owner).await.status, StatusCode::OK);
    assert_eq!(t.put(&format!("{team}/roles"), json!({ "roles": ["editor"] }), &owner).await.status, StatusCode::OK);
    assert!(has(&t.permissions(&org, &vic).await, "dashboards:write"));
    let role = t
        .post(&format!("/api/orgs/{org}/roles"), json!({ "name": "Prüfer", "permissions": ["audit:read"] }), &owner)
        .await;
    assert_eq!(role.status, StatusCode::CREATED, "{}", role.body);
    let dashboard = t.dashboard(&org).await;
    let grant = json!({ "subjectType": "role", "subjectId": role.body["id"], "resourceType": "dashboard",
                        "resourceId": dashboard, "level": "admin" });
    assert_eq!(t.post(&format!("/api/orgs/{org}/grants"), grant, &owner).await.status, StatusCode::CREATED);
    let list = t.get(&format!("/api/orgs/{org}/grants?resourceType=dashboard&resourceId={dashboard}"), &owner).await;
    assert_eq!(list.body["items"][0]["subjectName"], "Prüfer", "{}", list.body);
    let r = t.patch(&format!("/api/orgs/{org}/members/{}", owner.user_id), json!({ "role": "admin" }), &owner).await;
    assert_eq!(r.code(), "conflict");
    assert_eq!(t.get("/api/me/sessions", &vic).await.body["items"].as_array().unwrap().len(), 1);
    let r = t.patch(&format!("/api/admin/users/{}", owner.user_id), json!({ "disabled": true }), &owner).await;
    assert_eq!(r.code(), "conflict");
    check_disable_races_member_changes(&t, &owner).await;
    check_concurrent_owner_demotions(&t, &owner, &org).await;
    check_concurrent_admin_revocations(&t, &owner).await;
    t.finish().await;

    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin_pool).await.unwrap();
}
