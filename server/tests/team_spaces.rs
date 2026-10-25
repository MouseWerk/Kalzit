//! Team spaces, team ownership of dashboards and folders, and the team context, through the real
//! router and database (docs/api/access.md, "Team spaces" and "Team ownership").

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

    fn items(&self) -> &Vec<Value> {
        self.body["items"].as_array().unwrap_or_else(|| panic!("no items: {}", self.body))
    }

    fn titles(&self) -> Vec<&str> {
        self.items().iter().map(|i| i["title"].as_str().unwrap()).collect()
    }

    /// Every folder name of a folder tree, depth first.
    fn folder_names(&self) -> Vec<String> {
        fn walk(nodes: &[Value], out: &mut Vec<String>) {
            for n in nodes {
                out.push(n["name"].as_str().unwrap().to_string());
                walk(n["children"].as_array().unwrap(), out);
            }
        }
        let mut out = Vec::new();
        walk(self.items(), &mut out);
        out
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
            Some(json!({ "token": SETUP_CODE, "orgName": "MouseWerk", "name": "Jörg Müller",
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

    async fn put(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PUT, &self.path(path), Some(body), Some(cookie)).await
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

    /// A new user in the organization with `role`, signed in: (user id, cookie).
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

    async fn team(&self, name: &str) -> String {
        id_of(self.post("~/teams", json!({ "name": name }), &self.owner).await)
    }

    async fn join(&self, team: &str, user: &str, role: &str) {
        let r = self.put(&format!("~/teams/{team}/members/{user}"), json!({ "role": role }), &self.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }

    async fn space(&self, name: &str, team: &str, cookie: &str) -> String {
        id_of(self.post("~/folders", json!({ "name": name, "ownerTeamId": team }), cookie).await)
    }

    async fn folder(&self, name: &str, parent: Option<&str>, restricted: bool) -> String {
        id_of(
            self.post("~/folders", json!({ "name": name, "parentId": parent, "restricted": restricted }), &self.owner)
                .await,
        )
    }

    async fn dashboard(&self, title: &str, folder: Option<&str>, cookie: &str) -> String {
        id_of(self.post("~/dashboards", json!({ "folderId": folder, "model": model(title) }), cookie).await)
    }

    /// Saves the dashboard as `cookie`, optionally moving it; answers the reply.
    async fn save(&self, id: &str, title: &str, folder: Option<Option<&str>>, cookie: &str) -> Reply {
        let current = self.get(&format!("~/dashboards/{id}"), &self.owner).await;
        let mut body = json!({ "model": model(title), "version": current.body["version"] });
        if let Some(folder) = folder {
            body["folderId"] = json!(folder);
        }
        self.put(&format!("~/dashboards/{id}"), body, cookie).await
    }

    async fn grant_team(&self, team: &str, resource_type: &str, resource_id: &str, level: &str) {
        let body = json!({ "subjectType": "team", "subjectId": team, "resourceType": resource_type,
                           "resourceId": resource_id, "level": level });
        let r = self.post("~/grants", body, &self.owner).await;
        assert!(matches!(r.status, StatusCode::CREATED | StatusCode::OK), "{}", r.body);
    }

    async fn admin_accesses(&self, resource_id: &str) -> usize {
        let r =
            self.get(&format!("~/audit?action=team_space.admin_access&resourceId={resource_id}"), &self.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.items().len()
    }
}

fn id_of(r: Reply) -> String {
    assert!(r.status.is_success(), "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

/// A model with one panel without queries, so it can be exported only as far as access goes.
fn model(title: &str) -> Value {
    json!({ "schemaVersion": 1, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{ "id": "p1", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 }, "targets": [] }] })
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
    other_teams_cannot_reach_a_space_through_any_route;
    sharing_gives_read_or_edit;
    moves_between_spaces_need_edit_on_both_sides;
    admin_access_to_a_space_is_audited;
    deleting_a_team_needs_a_handover;
    the_team_context_is_checked_against_membership;
    team_owned_dashboards_in_shared_folders;
    folders_without_a_team_keep_their_access;
}

/// Two teams with an editor each and a space each: (team a, team b, a's editor, b's editor).
struct Teams {
    a: String,
    b: String,
    anna: String,
    bert: String,
    anna_id: String,
    space_a: String,
    space_b: String,
}

async fn two_teams(t: &TestApp) -> Teams {
    let a = t.team("Betrieb").await;
    let b = t.team("Vertrieb").await;
    let (anna_id, anna) = t.member("Anna", "editor").await;
    let (bert_id, bert) = t.member("Bert", "editor").await;
    t.join(&a, &anna_id, "maintainer").await;
    t.join(&b, &bert_id, "maintainer").await;
    // Maintainers create their team's space.
    let space_a = t.space("Betrieb", &a, &anna).await;
    let space_b = t.space("Vertrieb", &b, &bert).await;
    Teams { a, b, anna, bert, anna_id, space_a, space_b }
}

async fn other_teams_cannot_reach_a_space_through_any_route(t: TestApp) {
    let s = two_teams(&t).await;
    let sub = id_of(t.post("~/folders", json!({ "name": "Netz", "parentId": s.space_a }), &s.anna).await);
    let secret = t.dashboard("Störungen Netz", Some(&sub), &s.anna).await;
    t.dashboard("Umsatz Vertrieb", Some(&s.space_b), &s.bert).await;

    // A plain member of the org without a team sees neither, and cannot create a space.
    let (_, eve) = t.member("Eva", "editor").await;
    let r = t.post("~/folders", json!({ "name": "Eigen", "ownerTeamId": s.a }), &eve).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // An editor of team A who is no maintainer cannot either.
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&s.a, &carl_id, "member").await;
    let r = t.post("~/folders", json!({ "name": "Zweit", "ownerTeamId": s.a }), &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);

    for (cookie, sees_a) in [(&s.bert, false), (&eve, false), (&s.anna, true), (&carl, true)] {
        let tree = t.get("~/folders", cookie).await;
        assert_eq!(tree.folder_names().contains(&"Netz".to_string()), sees_a, "{}", tree.body);
        let list = t.get("~/dashboards", cookie).await;
        assert_eq!(list.titles().contains(&"Störungen Netz"), sees_a);
        let found = t.get("~/search?q=netz", cookie).await;
        assert_eq!(found.items().iter().any(|h| h["id"] == secret.as_str()), sees_a);
        assert_eq!(found.items().iter().any(|h| h["id"] == sub.as_str()), sees_a);
        let one = t.get(&format!("~/dashboards/{secret}"), cookie).await;
        assert_eq!(one.status == StatusCode::OK, sees_a, "{}", one.body);
    }
    // Bert's dashboards list never names A's titles, also not by searching for them.
    let r = t.get("~/dashboards?q=st%C3%B6rungen", &s.bert).await;
    assert!(r.items().is_empty(), "{}", r.body);
    // Every route on A's dashboard and folder is not found for team B.
    let not_found = |r: Reply| assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    not_found(t.save(&secret, "Übernommen", None, &s.bert).await);
    not_found(t.get(&format!("~/dashboards/{secret}/versions"), &s.bert).await);
    not_found(t.get(&format!("~/dashboards/{secret}/versions/1"), &s.bert).await);
    not_found(t.delete(&format!("~/dashboards/{secret}"), &s.bert).await);
    not_found(t.put(&format!("~/dashboards/{secret}/star"), json!(null), &s.bert).await);
    not_found(t.post(&format!("~/dashboards/{secret}/views"), json!(null), &s.bert).await);
    not_found(t.get(&format!("~/dashboards/{secret}/annotations?from=0&to=1"), &s.bert).await);
    let export = json!({ "timeRange": { "from": 0, "to": 1 }, "format": "csv", "language": "en" });
    not_found(t.post(&format!("~/dashboards/{secret}/panels/p1/export"), export.clone(), &s.bert).await);
    // For A the export gets as far as the panel (which has nothing to export).
    let r = t.post(&format!("~/dashboards/{secret}/panels/p1/export"), export, &s.anna).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    not_found(
        t.send(
            Method::PATCH,
            &t.path(&format!("~/folders/{sub}")),
            Some(json!({ "name": "X", "version": 1 })),
            Some(&s.bert),
        )
        .await,
    );
    not_found(t.delete(&format!("~/folders/{sub}"), &s.bert).await);
    not_found(t.get(&format!("~/grants?resourceType=folder&resourceId={}", s.space_a), &s.bert).await);
    not_found(
        t.get(&format!("~/explain?permission=dashboards:read&resourceType=dashboard&resourceId={secret}"), &s.bert)
            .await,
    );
    // Nothing can be created in or copied into A's space by B.
    let r = t.post("~/dashboards", json!({ "folderId": s.space_a, "model": model("Kopie") }), &s.bert).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    // The audit log does not name A's content to B (B's editor cannot read it anyway; a B admin
    // without access is covered by the restricted folder rules).
    let r = t.get("~/audit", &s.bert).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    // The space is marked with its team for those who see it.
    let tree = t.get("~/folders", &s.anna).await;
    let space = tree.items().iter().find(|f| f["id"] == s.space_a.as_str()).unwrap();
    assert_eq!(space["teamSpace"], true);
    assert_eq!(space["ownerTeam"]["name"], "Betrieb");
    let _ = &s.anna_id;
}

async fn sharing_gives_read_or_edit(t: TestApp) {
    let s = two_teams(&t).await;
    let d = t.dashboard("Lager", Some(&s.space_a), &s.anna).await;
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &s.bert).await.status, StatusCode::NOT_FOUND);
    t.grant_team(&s.b, "folder", &s.space_a, "view").await;
    let one = t.get(&format!("~/dashboards/{d}"), &s.bert).await;
    assert_eq!(one.status, StatusCode::OK);
    assert_eq!(one.body["access"]["write"], false);
    assert_eq!(t.save(&d, "Lager neu", None, &s.bert).await.status, StatusCode::FORBIDDEN);
    t.grant_team(&s.b, "folder", &s.space_a, "edit").await;
    assert_eq!(t.save(&d, "Lager neu", None, &s.bert).await.status, StatusCode::OK);
    // Maintainers of the owning team share their space themselves.
    let body = json!({ "subjectType": "team", "subjectId": s.b, "resourceType": "folder",
                       "resourceId": s.space_a, "level": "view" });
    let r = t.post("~/grants", body, &s.anna).await;
    assert!(r.status.is_success(), "{}", r.body);
    assert_eq!(t.save(&d, "Lager neuer", None, &s.bert).await.status, StatusCode::FORBIDDEN);
    // Another team's maintainer cannot share A's space.
    let body = json!({ "subjectType": "team", "subjectId": s.b, "resourceType": "folder",
                       "resourceId": s.space_a, "level": "edit" });
    assert_eq!(t.post("~/grants", body, &s.bert).await.status, StatusCode::FORBIDDEN);
}

async fn moves_between_spaces_need_edit_on_both_sides(t: TestApp) {
    let s = two_teams(&t).await;
    let general = t.folder("Allgemein", None, false).await;
    let d = t.dashboard("Wartung", Some(&s.space_a), &s.anna).await;
    // Out of the space into the general tree: edit on both sides is enough.
    assert_eq!(t.save(&d, "Wartung", Some(Some(&general)), &s.anna).await.status, StatusCode::OK);
    // And back.
    assert_eq!(t.save(&d, "Wartung", Some(Some(&s.space_a)), &s.anna).await.status, StatusCode::OK);
    // Into B's space, which A does not see: refused.
    assert_eq!(t.save(&d, "Wartung", Some(Some(&s.space_b)), &s.anna).await.status, StatusCode::NOT_FOUND);
    // With view on B's space only, still refused; with edit, allowed.
    t.grant_team(&s.a, "folder", &s.space_b, "view").await;
    assert_eq!(t.save(&d, "Wartung", Some(Some(&s.space_b)), &s.anna).await.status, StatusCode::FORBIDDEN);
    t.grant_team(&s.a, "folder", &s.space_b, "edit").await;
    assert_eq!(t.save(&d, "Wartung", Some(Some(&s.space_b)), &s.anna).await.status, StatusCode::OK);
    // A viewer of team B cannot move it out of B's space: no edit on the dashboard.
    let (vid, viewer) = t.member("Vera", "viewer").await;
    t.join(&s.b, &vid, "member").await;
    assert_eq!(t.save(&d, "Wartung", Some(Some(&general)), &viewer).await.status, StatusCode::FORBIDDEN);
    // A plain restricted folder still needs folders:permissions to cross into.
    let vault = t.folder("Tresor", None, true).await;
    t.grant_team(&s.a, "folder", &vault, "edit").await;
    assert_eq!(t.save(&d, "Wartung", Some(Some(&vault)), &s.anna).await.status, StatusCode::FORBIDDEN);
}

async fn admin_access_to_a_space_is_audited(t: TestApp) {
    let s = two_teams(&t).await;
    let d = t.dashboard("Schichtplan", Some(&s.space_a), &s.anna).await;
    // Members of the team leave no such trace.
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &s.anna).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&d).await, 0);
    // The owner sees every space and can open and change its content; each access is recorded,
    // repeated reads within a short time once.
    let tree = t.get("~/folders", &t.owner).await;
    assert!(
        tree.folder_names().contains(&"Betrieb".to_string()) && tree.folder_names().contains(&"Vertrieb".to_string())
    );
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&d).await, 1);
    t.clock.advance_ms(11 * 60 * 1000);
    assert_eq!(t.save(&d, "Schichtplan neu", None, &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&d).await, 2);
    let r = t.get(&format!("~/audit?action=team_space.admin_access&resourceId={d}"), &t.owner).await;
    assert_eq!(r.items()[0]["summary"]["teamId"], s.a.as_str());
}

async fn deleting_a_team_needs_a_handover(t: TestApp) {
    let s = two_teams(&t).await;
    let d = t.dashboard("Bestand", Some(&s.space_a), &s.anna).await;
    let r = t.delete(&format!("~/teams/{}", s.a), &t.owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "conflict"), "{}", r.body);
    // Not to itself, nor to a team that does not exist.
    let r = t.delete(&format!("~/teams/{}?transferTo={}", s.a, s.a), &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Handed to team B: B's members now work in the space.
    let r = t.delete(&format!("~/teams/{}?transferTo={}", s.a, s.b), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &s.anna).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.save(&d, "Bestand B", None, &s.bert).await.status, StatusCode::OK);
    // Handed to the organization: only org admins (and grants) reach it.
    let r = t.delete(&format!("~/teams/{}?transferTo=org", s.b), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &s.bert).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &t.owner).await.status, StatusCode::OK);
    let tree = t.get("~/folders", &t.owner).await;
    let space = tree.items().iter().find(|f| f["id"] == s.space_a.as_str()).unwrap();
    assert_eq!(space["ownerTeam"], Value::Null);
    assert_eq!(space["restricted"], true);
    let _ = &s.space_b;
}

async fn the_team_context_is_checked_against_membership(t: TestApp) {
    let s = two_teams(&t).await;
    t.dashboard("Netzlast", Some(&s.space_a), &s.anna).await;
    t.dashboard("Angebote", Some(&s.space_b), &s.bert).await;
    t.dashboard("Firmenweit", None, &t.owner).await;
    // Anna works in her only team by default; the context names its space.
    let ctx = t.get("~/team-context", &s.anna).await;
    assert_eq!(ctx.body["teamId"], s.a.as_str(), "{}", ctx.body);
    assert_eq!(ctx.body["teams"].as_array().unwrap().len(), 1);
    assert_eq!(ctx.body["teams"][0]["spaces"][0]["id"], s.space_a.as_str());
    assert_eq!(ctx.body["defaultFolderId"], Value::Null);
    // She cannot pick a team she is not in, nor scope a list by it.
    let r = t.put("~/team-context", json!({ "teamId": s.b }), &s.anna).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    let r = t.get(&format!("~/dashboards?team={}", s.b), &s.anna).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    // "All areas" is a choice of its own.
    let r = t.put("~/team-context", json!({ "teamId": null }), &s.anna).await;
    assert_eq!(r.body["teamId"], Value::Null, "{}", r.body);
    // The owner (an org admin) may pick any team; the scope hides other teams' spaces.
    let r = t.put("~/team-context", json!({ "teamId": s.b }), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["teams"].as_array().unwrap().len(), 2);
    let scoped = t.get(&format!("~/dashboards?team={}", s.b), &t.owner).await;
    assert_eq!(scoped.titles(), ["Angebote", "Firmenweit"]);
    let all = t.get("~/dashboards", &t.owner).await;
    assert_eq!(all.titles(), ["Angebote", "Firmenweit", "Netzlast"]);
    let tree = t.get(&format!("~/folders?team={}", s.b), &t.owner).await;
    assert_eq!(tree.folder_names(), ["Vertrieb"]);
    // A space shared with team B comes into B's scope.
    t.grant_team(&s.b, "folder", &s.space_a, "view").await;
    let scoped = t.get(&format!("~/dashboards?team={}", s.b), &t.owner).await;
    assert_eq!(scoped.titles(), ["Angebote", "Firmenweit", "Netzlast"]);
    // The start page lists follow the scope too.
    let netz = t.get("~/dashboards?q=netzlast", &s.anna).await.items()[0]["id"].as_str().unwrap().to_string();
    assert_eq!(
        t.post(&format!("~/dashboards/{netz}/views"), json!(null), &s.anna).await.status,
        StatusCode::NO_CONTENT
    );
    assert_eq!(t.get(&format!("~/recents?team={}", s.a), &s.anna).await.titles(), ["Netzlast"]);
    // A stored choice that is no longer valid falls back: Anna leaves team A after choosing it.
    t.put("~/team-context", json!({ "teamId": s.a }), &s.anna).await;
    let r = t.delete(&format!("~/teams/{}/members/{}", s.a, s.anna_id), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let ctx = t.get("~/team-context", &s.anna).await;
    assert_eq!(ctx.body["teamId"], Value::Null, "{}", ctx.body);
    assert!(ctx.body["teams"].as_array().unwrap().is_empty());
    // With the organization setting on, new dashboards go into the active team's space.
    let path = t.path("~/settings/dashboards.new_in_team_space");
    let r = t.send(Method::PATCH, &path, Some(json!({ "value": true, "version": 0 })), Some(&t.owner)).await;
    assert!(r.status.is_success(), "{}", r.body);
    let ctx = t.get("~/team-context", &s.bert).await;
    assert_eq!(ctx.body["defaultFolderId"], s.space_b.as_str(), "{}", ctx.body);
}

async fn team_owned_dashboards_in_shared_folders(t: TestApp) {
    let s = two_teams(&t).await;
    let shared = t.folder("Gemeinsam", None, false).await;
    let d = t.dashboard("Kennzahlen", Some(&shared), &s.bert).await;
    // Without an owner, every editor edits it.
    assert_eq!(t.save(&d, "Kennzahlen", None, &s.anna).await.status, StatusCode::OK);
    // Anna cannot hand it to team B, which she is not in.
    let r =
        t.put(&format!("~/dashboards/{d}/owner"), json!({ "ownerTeamId": s.b, "visibility": "shared" }), &s.anna).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // Bert makes it team B's: everyone reads it, only B edits it.
    let r =
        t.put(&format!("~/dashboards/{d}/owner"), json!({ "ownerTeamId": s.b, "visibility": "shared" }), &s.bert).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["ownerTeam"]["name"], "Vertrieb");
    let seen = t.get(&format!("~/dashboards/{d}"), &s.anna).await;
    assert_eq!((seen.status, seen.body["access"]["write"].clone()), (StatusCode::OK, json!(false)));
    assert_eq!(t.save(&d, "Kennzahlen A", None, &s.anna).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.delete(&format!("~/dashboards/{d}"), &s.anna).await.status, StatusCode::FORBIDDEN);
    let r = t
        .put(&format!("~/dashboards/{d}/owner"), json!({ "ownerTeamId": null, "visibility": "shared" }), &s.anna)
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert_eq!(t.save(&d, "Kennzahlen B", None, &s.bert).await.status, StatusCode::OK);
    // A grant still lets someone outside the team edit.
    let body = json!({ "subjectType": "user", "subjectId": s.anna_id, "resourceType": "dashboard",
                       "resourceId": d, "level": "edit" });
    assert!(t.post("~/grants", body, &t.owner).await.status.is_success());
    assert_eq!(t.save(&d, "Kennzahlen A", None, &s.anna).await.status, StatusCode::OK);
    // Team only: hidden from everyone else everywhere, including a team-owned folder's content.
    let only = t.dashboard("Nur Vertrieb", Some(&shared), &s.bert).await;
    let r = t
        .put(&format!("~/dashboards/{only}/owner"), json!({ "ownerTeamId": s.b, "visibility": "team" }), &s.bert)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["teamOnly"], true);
    assert_eq!(t.get(&format!("~/dashboards/{only}"), &s.anna).await.status, StatusCode::NOT_FOUND);
    assert!(!t.get("~/dashboards", &s.anna).await.titles().contains(&"Nur Vertrieb"));
    assert!(t.get("~/search?q=nur", &s.anna).await.items().is_empty());
    assert!(t.get("~/dashboards", &s.bert).await.titles().contains(&"Nur Vertrieb"));
    // The owner reaches it, audited.
    assert_eq!(t.get(&format!("~/dashboards/{only}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&only).await, 1);
    // A team-owned folder in the shared tree passes its ownership down.
    let owned = t.folder("Vertriebsordner", Some(&shared), false).await;
    let r = t
        .put(&format!("~/folders/{owned}/owner"), json!({ "ownerTeamId": s.b, "visibility": "shared" }), &t.owner)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let inside = t.dashboard("Prognose", Some(&owned), &s.bert).await;
    assert_eq!(t.get(&format!("~/dashboards/{inside}"), &s.anna).await.status, StatusCode::OK);
    assert_eq!(t.save(&inside, "Prognose A", None, &s.anna).await.status, StatusCode::FORBIDDEN);
    let r = t.post("~/dashboards", json!({ "folderId": owned, "model": model("Fremd") }), &s.anna).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let _ = (&s.space_a, &s.space_b, &s.a);
}

async fn folders_without_a_team_keep_their_access(t: TestApp) {
    let general = t.folder("Allgemein", None, false).await;
    let vault = t.folder("Tresor", None, true).await;
    let d = t.dashboard("Übersicht", Some(&general), &t.owner).await;
    let hidden = t.dashboard("Geheim", Some(&vault), &t.owner).await;
    let (_, editor) = t.member("Emil", "editor").await;
    let (_, viewer) = t.member("Vera", "viewer").await;
    assert_eq!(t.save(&d, "Übersicht neu", None, &editor).await.status, StatusCode::OK);
    assert_eq!(t.save(&d, "Übersicht", None, &viewer).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.get(&format!("~/dashboards/{hidden}"), &editor).await.status, StatusCode::NOT_FOUND);
    let tree = t.get("~/folders", &editor).await;
    assert_eq!(tree.folder_names(), ["Allgemein"]);
    let folder = tree.items()[0].clone();
    assert_eq!((folder["ownerTeam"].clone(), folder["teamSpace"].clone()), (Value::Null, json!(false)));
    // A member without any team has no team context and sees everything they may see.
    let ctx = t.get("~/team-context", &editor).await;
    assert_eq!((ctx.body["teamId"].clone(), ctx.body["teams"].clone()), (Value::Null, json!([])));
    // Without a team, nothing changed for admins: no admin-access entries for plain folders.
    assert_eq!(t.get(&format!("~/dashboards/{hidden}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&hidden).await, 0);
}
