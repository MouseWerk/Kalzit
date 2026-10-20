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
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    _dir: tempfile::TempDir,
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
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = db_url;
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), clock, state, _dir: dir }
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
}

#[tokio::test]
async fn concurrent_owner_demotions_keep_one_owner() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let ada = t.member(&owner, &org, "Ada", "ada@example.de", "owner").await;
    // Both owners step down at the same moment; one must be refused.
    let mut set = tokio::task::JoinSet::new();
    for who in [owner.clone(), ada.clone()] {
        let app = t.app.clone();
        let path = format!("/api/orgs/{org}/members/{}", who.user_id);
        set.spawn(async move {
            let req = Request::builder()
                .method(Method::PATCH)
                .uri(path)
                .header(header::HOST, "kalzit.test")
                .header(header::COOKIE, &who.cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "role": "admin" }).to_string()))
                .unwrap();
            app.oneshot(req).await.unwrap().status()
        });
    }
    let mut statuses = set.join_all().await;
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let (owners,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE role = 'owner'").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(owners, 1);
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
        (json!({ "name": "X", "permissions": ["rockets:launch"] }), "permissions"),
        (json!({ "name": "X", "description": "a\u{0}b", "permissions": [] }), "description"),
    ] {
        assert_eq!(t.post(&roles, body.clone(), &ada).await.field(), field, "{body}");
    }
    // Admins lack org:delete, so they cannot put it into a role.
    let r = t.post(&roles, json!({ "name": "Löscher", "permissions": ["org:delete"] }), &ada).await;
    assert_eq!((r.status, r.code()), (StatusCode::FORBIDDEN, "forbidden"));

    // A member with the custom role holds exactly its permissions.
    let r = t.patch(&format!("/api/orgs/{org}/members/{}", bob.user_id), json!({ "role": role_id }), &ada).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.permissions(&org, &bob).await, ["users:read", "audit:read"]);
    let r = t.patch(&role, json!({ "permissions": ["audit:read"], "name": "Revision" }), &ada).await;
    assert_eq!((r.body["name"].as_str(), r.body["permissions"].clone()), (Some("Revision"), json!(["audit:read"])));
    assert_eq!(t.permissions(&org, &bob).await, ["audit:read"]);
    let r = t.patch(&role, json!({ "permissions": ["org:delete"] }), &ada).await;
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
    assert_eq!(t.get(&roles, &owner).await.body["items"].as_array().unwrap().len(), 4);

    let actions = t.audit_actions().await;
    for action in ["role.created", "role.updated", "role.deleted"] {
        assert!(has(&actions, action), "{action} in {actions:?}");
    }
}

#[tokio::test]
async fn grants_extend_access_per_resource() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let grants = format!("/api/orgs/{org}/grants");
    let ed = t.member(&owner, &org, "Ed", "ed@example.de", "editor").await;
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let stranger = t.user(&owner, "Fremd", "fremd@example.de").await;
    let dashboard = uuid();
    let datasource = uuid();
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
}

#[tokio::test]
async fn nobody_grants_more_than_they_hold_on_a_resource() {
    let t = test_app(None).await;
    let (owner, org) = t.setup().await;
    let grants = format!("/api/orgs/{org}/grants");
    let vic = t.member(&owner, &org, "Vic", "vic@example.de", "viewer").await;
    let max = t.member(&owner, &org, "Max", "max@example.de", "viewer").await;
    let dashboard = uuid();
    let grant = |who: &str, level: &str| json!({ "subjectType": "user", "subjectId": who, "resourceType": "dashboard", "resourceId": dashboard, "level": level });
    // A viewer with an admin grant on one dashboard manages its grants...
    assert_eq!(t.post(&grants, grant(&vic.user_id, "admin"), &owner).await.status, StatusCode::CREATED);
    let r = t.post(&grants, grant(&max.user_id, "edit"), &vic).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    // ...but not on another one.
    let other = json!({ "subjectType": "user", "subjectId": max.user_id, "resourceType": "dashboard",
                        "resourceId": uuid(), "level": "view" });
    assert_eq!(t.post(&grants, other, &vic).await.status, StatusCode::FORBIDDEN);
    // An edit grant does not let Max share further.
    assert_eq!(t.post(&grants, grant(&vic.user_id, "view"), &max).await.status, StatusCode::FORBIDDEN);
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
}

/// The access model on PostgreSQL, in a throwaway schema so the test database is left as it was.
#[tokio::test]
async fn postgres_access_model() {
    let Ok(base) = std::env::var("KALZIT_TEST_POSTGRES_URL") else {
        eprintln!("KALZIT_TEST_POSTGRES_URL not set, PostgreSQL test not run");
        return;
    };
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
    let dashboard = uuid();
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
    drop(t);

    sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE"))).execute(&admin_pool).await.unwrap();
}
