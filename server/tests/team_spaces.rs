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

    /// The audit events with `action` about `resource_id`, newest first.
    async fn events(&self, action: &str, resource_id: &str) -> Vec<Value> {
        let r = self.get(&format!("~/audit?action={action}&resourceId={resource_id}"), &self.owner).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.items().clone()
    }

    /// `PUT .../{kind}/{id}/owner` as `cookie`.
    async fn set_owner(&self, kind: &str, id: &str, team: Option<&str>, visibility: &str, cookie: &str) -> Reply {
        self.put(&format!("~/{kind}/{id}/owner"), json!({ "ownerTeamId": team, "visibility": visibility }), cookie)
            .await
    }

    async fn subfolder(&self, name: &str, parent: &str, cookie: &str) -> String {
        id_of(self.post("~/folders", json!({ "name": name, "parentId": parent }), cookie).await)
    }

    /// Moves a folder as `cookie`.
    async fn move_folder(&self, id: &str, parent: Option<&str>, cookie: &str) -> Reply {
        let tree = self.get("~/folders", &self.owner).await;
        fn find(nodes: &[Value], id: &str) -> Option<Value> {
            nodes
                .iter()
                .find_map(|n| if n["id"] == id { Some(n.clone()) } else { find(n["children"].as_array().unwrap(), id) })
        }
        let version = find(tree.items(), id).unwrap()["version"].clone();
        let body = json!({ "parentId": parent, "version": version });
        self.send(Method::PATCH, &self.path(&format!("~/folders/{id}")), Some(body), Some(cookie)).await
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
            let Some(base) = common::postgres_url("PostgreSQL flows") else { return };
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
    owner_changes_follow_the_owner_rules;
    moving_out_of_a_space_is_for_maintainers;
    admin_access_is_audited_per_permission;
    joining_a_team_with_spaces;
    outsiders_reach_nothing_else_either;
    library_panels_in_spaces;
    nested_owners_decide_by_the_nearest;
    handing_over_a_deleted_team_needs_both_teams;
    a_spaces_library_panel_stays_in_the_space;
    admins_reading_shared_content_leave_no_trace;
    other_teams_content_goes_into_a_space_through_admins;
}

/// Two teams with an editor each and a space each: (team a, team b, a's editor, b's editor).
struct Teams {
    a: String,
    b: String,
    anna: String,
    bert: String,
    anna_id: String,
    bert_id: String,
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
    Teams { a, b, anna, bert, anna_id, bert_id, space_a, space_b }
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
    // Nor can Bert hand open content to his team: that needs folders:permissions on its folder.
    let r =
        t.put(&format!("~/dashboards/{d}/owner"), json!({ "ownerTeamId": s.b, "visibility": "shared" }), &s.bert).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // An admin makes it team B's: everyone reads it, only B edits it.
    let r = t
        .put(&format!("~/dashboards/{d}/owner"), json!({ "ownerTeamId": s.b, "visibility": "shared" }), &t.owner)
        .await;
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
        .put(&format!("~/dashboards/{only}/owner"), json!({ "ownerTeamId": s.b, "visibility": "shared" }), &t.owner)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Within what his team owns, Bert decides the visibility himself.
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
    // Admins still open restricted folders; that access is recorded like access to a team's
    // space (a space handed to the organization is such a folder), plain content is not.
    assert_eq!(t.get(&format!("~/dashboards/{hidden}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&hidden).await, 1);
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&d).await, 0);
}

/// A library panel without queries, so members who may not query data sources can be given it.
fn library_model(title: &str) -> Value {
    json!({ "schemaVersion": 2, "type": "table", "title": title, "targets": [] })
}

/// A dashboard model showing one library panel.
fn showing(title: &str, library: &str) -> Value {
    json!({ "schemaVersion": 2, "title": title, "timeRange": { "from": "now-6h", "to": "now" },
            "panels": [{ "id": "lp", "type": "table", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                         "libraryPanelId": library }] })
}

async fn owner_changes_follow_the_owner_rules(t: TestApp) {
    let s = two_teams(&t).await;
    // Vic maintains team A with the org role viewer; Carl is an editor in both teams.
    let (vic_id, vic) = t.member("Vic", "viewer").await;
    t.join(&s.a, &vic_id, "maintainer").await;
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&s.a, &carl_id, "member").await;
    t.join(&s.b, &carl_id, "member").await;

    // B1: a maintainer cannot open up the space or hand it away, whatever their role; only org
    // admins change a team space's owner or visibility.
    for cookie in [&vic, &s.anna] {
        for (team, visibility) in [(None, "shared"), (None, "team"), (Some(s.b.as_str()), "team")] {
            let r = t.set_owner("folders", &s.space_a, team, visibility, cookie).await;
            assert_eq!(r.status, StatusCode::FORBIDDEN, "{team:?} {visibility}: {}", r.body);
        }
        let r = t
            .send(
                Method::PATCH,
                &t.path(&format!("~/folders/{}", s.space_a)),
                Some(json!({ "restricted": false, "version": 1 })),
                Some(cookie),
            )
            .await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    }
    // Vic got no grant out of trying.
    let grants = t.get(&format!("~/grants?resourceType=folder&resourceId={}", s.space_a), &t.owner).await;
    assert!(grants.items().is_empty(), "{}", grants.body);
    // A viewer maintainer cannot change ownership inside the space either: no folders:write.
    let sub = t.subfolder("Netz", &s.space_a, &s.anna).await;
    let r = t.set_owner("folders", &sub, Some(&s.a), "team", &vic).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);

    // B2: inside A's space, content belongs to team A or nobody, unless an org admin decides.
    let d = t.dashboard("Leitstand", Some(&s.space_a), &s.anna).await;
    let r = t.set_owner("dashboards", &d, Some(&s.b), "shared", &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.set_owner("folders", &sub, Some(&s.b), "shared", &s.anna).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.set_owner("dashboards", &d, Some(&s.a), "team", &carl).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.set_owner("dashboards", &d, Some(&s.b), "shared", &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // B3: open content goes to a team only through folders:permissions on its folder.
    let open = t.folder("Gemeinsam", None, false).await;
    let shared = t.dashboard("Kennzahlen", Some(&open), &t.owner).await;
    let r = t.set_owner("dashboards", &shared, Some(&s.a), "shared", &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.set_owner("folders", &open, Some(&s.a), "shared", &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let body = json!({ "subjectType": "user", "subjectId": carl_id, "resourceType": "folder",
                       "resourceId": open, "level": "admin" });
    assert!(t.post("~/grants", body, &t.owner).await.status.is_success());
    let r = t.set_owner("dashboards", &shared, Some(&s.a), "shared", &carl).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Within what team A owns, its editors change owner and visibility without the grant.
    let other = t.dashboard("Wartung", Some(&open), &t.owner).await;
    t.set_owner("dashboards", &other, Some(&s.a), "shared", &t.owner).await;
    let (_, edith) = t.member("Edith", "editor").await;
    let r = t.set_owner("dashboards", &other, Some(&s.a), "team", &edith).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.set_owner("dashboards", &other, Some(&s.b), "team", &carl).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // A stale version is a conflict, not a silent change.
    let current = t.get(&format!("~/dashboards/{other}"), &t.owner).await.body["version"].as_i64().unwrap();
    let body = json!({ "ownerTeamId": s.b, "visibility": "shared", "version": current + 5 });
    let r = t.put(&format!("~/dashboards/{other}/owner"), body, &t.owner).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "version_conflict"), "{}", r.body);
    let body = json!({ "ownerTeamId": s.a, "visibility": "shared", "version": 1 });
    let r = t.put(&format!("~/folders/{sub}/owner"), body, &s.anna).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let body = json!({ "ownerTeamId": s.a, "visibility": "team", "version": 1 });
    let r = t.put(&format!("~/folders/{sub}/owner"), body, &s.anna).await;
    assert_eq!((r.status, r.code()), (StatusCode::CONFLICT, "version_conflict"), "{}", r.body);

    // The owner opens a team space up, audited as an owner change.
    let r = t.set_owner("folders", &s.space_b, None, "shared", &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.events("folder.owner_changed", &s.space_b).await.len(), 1);
}

async fn moving_out_of_a_space_is_for_maintainers(t: TestApp) {
    let s = two_teams(&t).await;
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&s.a, &carl_id, "member").await;
    let general = t.folder("Allgemein", None, false).await;
    let inner = t.subfolder("Netz", &s.space_a, &s.anna).await;
    let d = t.dashboard("Störungen", Some(&s.space_a), &carl).await;
    // An editor of the team moves within the space, not out of it.
    assert_eq!(t.save(&d, "Störungen", Some(Some(&inner)), &carl).await.status, StatusCode::OK);
    assert_eq!(t.save(&d, "Störungen", Some(Some(&general)), &carl).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.save(&d, "Störungen", Some(None), &carl).await.status, StatusCode::FORBIDDEN);
    // The maintainer does, and the move is recorded with source and target.
    assert_eq!(t.save(&d, "Störungen", Some(Some(&general)), &s.anna).await.status, StatusCode::OK);
    let moved = t.events("team_space.moved_out", &d).await;
    assert_eq!(moved.len(), 1);
    assert_eq!(moved[0]["summary"]["spaceId"], s.space_a.as_str());
    assert_eq!(moved[0]["summary"]["from"], inner.as_str());
    assert_eq!(moved[0]["summary"]["to"], general.as_str());

    // A folder goes out of the space only with every team's content in it movable by the caller.
    let carried = t.subfolder("Mitnahme", &s.space_a, &s.anna).await;
    let theirs = t.dashboard("Fremd", Some(&carried), &s.anna).await;
    let r = t.set_owner("dashboards", &theirs, Some(&s.b), "shared", &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.move_folder(&carried, None, &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.move_folder(&carried, None, &s.anna).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.move_folder(&carried, Some(&general), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.events("team_space.moved_out", &carried).await.len(), 1);
    // Within the space, editors move folders as before.
    let deep = t.subfolder("Tief", &s.space_a, &s.anna).await;
    assert_eq!(t.move_folder(&deep, Some(&inner), &carl).await.status, StatusCode::OK);
    // A team space stays at the top level.
    let r = t.move_folder(&s.space_a, Some(&general), &t.owner).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);

    // A folder with children moves from A's space into B's, which shared edit with team A: the
    // maintainer takes it along, and B's members then see what it holds.
    let parcel = t.subfolder("Paket", &s.space_a, &s.anna).await;
    let child = t.subfolder("Kind", &parcel, &s.anna).await;
    let packed = t.dashboard("Im Paket", Some(&child), &s.anna).await;
    assert_eq!(t.get(&format!("~/dashboards/{packed}"), &s.bert).await.status, StatusCode::NOT_FOUND);
    t.grant_team(&s.a, "folder", &s.space_b, "edit").await;
    assert_eq!(t.move_folder(&parcel, Some(&s.space_b), &carl).await.status, StatusCode::FORBIDDEN);
    let r = t.move_folder(&parcel, Some(&s.space_b), &s.anna).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.events("team_space.moved_out", &parcel).await[0]["summary"]["to"], s.space_b.as_str());
    assert_eq!(t.get(&format!("~/dashboards/{packed}"), &s.bert).await.status, StatusCode::OK);
}

async fn admin_access_is_audited_per_permission(t: TestApp) {
    let s = two_teams(&t).await;
    let open = t.folder("Gemeinsam", None, false).await;
    let d = t.dashboard("Absatz", Some(&open), &t.owner).await;
    t.set_owner("dashboards", &d, Some(&s.b), "shared", &t.owner).await;
    // Reading a shared team dashboard is everyone's: no entry.
    assert_eq!(t.get(&format!("~/dashboards/{d}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&d).await, 0);
    // Changing it rests on the admin's reach: recorded, with the permission and the team.
    assert_eq!(t.save(&d, "Absatz neu", None, &t.owner).await.status, StatusCode::OK);
    let events = t.events("team_space.admin_access", &d).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["summary"]["permission"], "dashboards:write");
    assert_eq!(events[0]["summary"]["teamId"], s.b.as_str());
    // "Why can I" on another team's space is access too, even with a grant on a folder in reach
    // that does not give what was asked.
    let inner = t.subfolder("Netz", &s.space_a, &s.anna).await;
    let r =
        t.get(&format!("~/explain?permission=folders:write&resourceType=folder&resourceId={inner}"), &t.owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let events = t.events("team_space.admin_access", &inner).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["summary"]["governingId"], s.space_a.as_str());
    // A space handed to the organization is still recorded.
    let gone = t.team("Aufgelöst").await;
    let (zoe_id, zoe) = t.member("Zoe", "editor").await;
    t.join(&gone, &zoe_id, "maintainer").await;
    let space = t.space("Archiv", &gone, &zoe).await;
    let kept = t.dashboard("Archivbericht", Some(&space), &zoe).await;
    assert_eq!(t.delete(&format!("~/teams/{gone}?transferTo=org"), &t.owner).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/dashboards/{kept}"), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&kept).await, 1);
}

async fn joining_a_team_with_spaces(t: TestApp) {
    let s = two_teams(&t).await;
    let (newbie_id, _) = t.member("Neu", "viewer").await;
    // A member manager without folders:permissions cannot open a team space by adding people.
    let role = t
        .post(
            "~/roles",
            json!({ "name": "Teamverwaltung", "description": "", "permissions": ["teams:read", "teams:members"] }),
            &t.owner,
        )
        .await;
    assert!(role.status.is_success(), "{}", role.body);
    let (_, manager) = t.member("Mia", role.body["id"].as_str().unwrap()).await;
    let r = t.put(&format!("~/teams/{}/members/{newbie_id}", s.a), json!({ "role": "member" }), &manager).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // A team without spaces is theirs to fill.
    let plain = t.team("Ohne Bereich").await;
    let r = t.put(&format!("~/teams/{plain}/members/{newbie_id}"), json!({ "role": "member" }), &manager).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // The maintainer adds members; an org admin does too, recorded as admin access.
    let r = t.put(&format!("~/teams/{}/members/{newbie_id}", s.a), json!({ "role": "member" }), &s.anna).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.join(&s.b, &newbie_id, "member").await;
    let events = t.events("team_space.admin_access", &s.b).await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["summary"]["action"], "team.member_added");
}

async fn outsiders_reach_nothing_else_either(t: TestApp) {
    let s = two_teams(&t).await;
    let d = t.dashboard("Netzlast", Some(&s.space_a), &s.anna).await;
    let not_found = |r: Reply| assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
    // Stored panel queries, version restore, pins, grants.
    let q = json!({ "timeRange": { "from": 0, "to": 1 }, "variables": {} });
    not_found(t.post(&format!("~/dashboards/{d}/panels/p1/query"), q.clone(), &s.bert).await);
    not_found(t.post(&format!("~/dashboards/{d}/versions/1/restore"), json!(null), &s.bert).await);
    not_found(t.put(&format!("~/dashboards/{d}/pin"), json!(null), &s.bert).await);
    let body = json!({ "subjectType": "team", "subjectId": s.b, "resourceType": "folder",
                       "resourceId": s.space_a, "level": "edit" });
    not_found(t.post("~/grants", body, &s.bert).await);
    let body = json!({ "subjectType": "team", "subjectId": s.b, "resourceType": "dashboard",
                       "resourceId": d, "level": "view" });
    not_found(t.post("~/grants", body, &s.bert).await);
    // Trash, restore and purge.
    not_found(t.delete(&format!("~/dashboards/{d}"), &s.bert).await);
    assert_eq!(t.delete(&format!("~/dashboards/{d}"), &s.anna).await.status, StatusCode::NO_CONTENT);
    not_found(t.post(&format!("~/dashboards/{d}/restore"), json!(null), &s.bert).await);
    not_found(t.delete(&format!("~/dashboards/{d}/purge"), &s.bert).await);
    let trash = t.get("~/dashboards?trashed=true", &s.bert).await;
    assert!(trash.items().is_empty(), "{}", trash.body);
    assert_eq!(t.post(&format!("~/dashboards/{d}/restore"), json!(null), &s.anna).await.status, StatusCode::OK);
    not_found(t.post(&format!("~/folders/{}/restore", s.space_a), json!(null), &s.bert).await);
    not_found(t.delete(&format!("~/folders/{}/purge", s.space_a), &s.bert).await);
    // Stars, pins and scoped lists for members of the team.
    assert_eq!(t.put(&format!("~/dashboards/{d}/star"), json!(null), &s.anna).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.put(&format!("~/dashboards/{d}/pin"), json!(null), &s.anna).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&format!("~/stars?team={}", s.a), &s.anna).await.titles(), ["Netzlast"]);
    assert_eq!(t.get(&format!("~/pins?team={}", s.a), &s.anna).await.titles(), ["Netzlast"]);
    assert_eq!(t.get(&format!("~/stars?team={}", s.b), &s.anna).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(t.get(&format!("~/pins?team={}", s.b), &s.anna).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(t.get(&format!("~/folders?team={}", s.b), &s.anna).await.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Bert's star and pin of it never come into being, so his lists stay empty.
    assert!(t.get(&format!("~/stars?team={}", s.b), &s.bert).await.items().is_empty());
    assert!(t.get("~/pins", &s.bert).await.items().is_empty());
    // A grant to Bert in person keeps A's dashboard in his team context too.
    let body = json!({ "subjectType": "user", "subjectId": s.bert_id, "resourceType": "dashboard",
                       "resourceId": d, "level": "view" });
    assert!(t.post("~/grants", body, &t.owner).await.status.is_success());
    assert_eq!(t.get(&format!("~/dashboards?team={}", s.b), &s.bert).await.titles(), ["Netzlast"]);
}

async fn library_panels_in_spaces(t: TestApp) {
    let s = two_teams(&t).await;
    let open = t.folder("Allgemein", None, false).await;
    let made = t
        .post(
            "~/library-panels",
            json!({ "name": "Lastkurve", "model": library_model("Lastkurve"), "folderId": s.space_a }),
            &s.anna,
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let lib = made.body["id"].as_str().unwrap().to_string();
    // Team B neither opens nor lists it.
    assert_eq!(t.get(&format!("~/library-panels/{lib}"), &s.bert).await.status, StatusCode::NOT_FOUND);
    let listed = t.get("~/library-panels", &s.bert).await;
    assert!(listed.items().iter().all(|p| p["id"] != lib.as_str()), "{}", listed.body);
    // A panel in the open tree used by dashboards in two places cannot move into A's space.
    let shared = t
        .post("~/library-panels", json!({ "name": "Kopf", "model": library_model("Kopf"), "folderId": open }), &t.owner)
        .await;
    let shared_id = shared.body["id"].as_str().unwrap().to_string();
    let inside = id_of(
        t.post("~/dashboards", json!({ "folderId": s.space_a, "model": showing("Innen", &shared_id) }), &s.anna).await,
    );
    id_of(t.post("~/dashboards", json!({ "folderId": open, "model": showing("Außen", &shared_id) }), &t.owner).await);
    let body = json!({ "version": 1, "name": "Kopf", "model": library_model("Kopf"), "folderId": s.space_a });
    let r = t.put(&format!("~/library-panels/{shared_id}"), body, &t.owner).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    // Counts tell only what the caller may read.
    assert_eq!(t.get(&format!("~/library-panels/{shared_id}"), &s.bert).await.body["uses"], 1);
    assert_eq!(t.get(&format!("~/library-panels/{shared_id}"), &s.anna).await.body["uses"], 2);
    let uses = t.get(&format!("~/library-panels/{shared_id}/uses"), &s.bert).await;
    assert_eq!(uses.body["items"].as_array().unwrap().len(), 1);
    assert!(uses.body.get("hidden").is_none(), "{}", uses.body);
    // An editor of the team cannot take A's panel out of the space; its maintainer can.
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&s.a, &carl_id, "member").await;
    let body = json!({ "version": 1, "name": "Lastkurve", "model": library_model("Lastkurve"), "folderId": open });
    assert_eq!(t.put(&format!("~/library-panels/{lib}"), body.clone(), &carl).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.put(&format!("~/library-panels/{lib}"), body, &s.anna).await.status, StatusCode::OK);
    let _ = inside;
}

async fn nested_owners_decide_by_the_nearest(t: TestApp) {
    let s = two_teams(&t).await;
    let open = t.folder("Allgemein", None, false).await;
    let owned = t.folder("Betriebsordner", Some(&open), false).await;
    t.set_owner("folders", &owned, Some(&s.a), "shared", &t.owner).await;
    let theirs = t.dashboard("Vertriebsbericht", Some(&owned), &t.owner).await;
    t.set_owner("dashboards", &theirs, Some(&s.b), "shared", &t.owner).await;
    let ours = t.dashboard("Betriebsbericht", Some(&owned), &t.owner).await;
    // The dashboard's own owner decides who edits it, the folder's owner the rest.
    assert_eq!(t.save(&theirs, "Vertrieb neu", None, &s.bert).await.status, StatusCode::OK);
    assert_eq!(t.save(&theirs, "Vertrieb A", None, &s.anna).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.save(&ours, "Betrieb neu", None, &s.anna).await.status, StatusCode::OK);
    assert_eq!(t.save(&ours, "Betrieb B", None, &s.bert).await.status, StatusCode::FORBIDDEN);
    // Annotations follow the owner too.
    let path = format!("~/dashboards/{ours}/annotations");
    let note = json!({ "time": 1_800_000_000_000_i64, "text": "Wartung" });
    assert_eq!(t.post(&path, note.clone(), &s.bert).await.status, StatusCode::FORBIDDEN);
    assert_eq!(t.post(&path, note, &s.anna).await.status, StatusCode::CREATED);
    // A team-only dashboard of B inside A's folder: B's members see it, A's members do not.
    t.set_owner("dashboards", &theirs, Some(&s.b), "team", &s.bert).await;
    assert_eq!(t.get(&format!("~/dashboards/{theirs}"), &s.anna).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.get(&format!("~/dashboards/{theirs}"), &s.bert).await.status, StatusCode::OK);
}

async fn handing_over_a_deleted_team_needs_both_teams(t: TestApp) {
    let s = two_teams(&t).await;
    t.dashboard("Schicht", Some(&s.space_a), &s.anna).await;
    // A custom role with teams:write who maintains team B only cannot carry A's space over to B.
    let role = t
        .post(
            "~/roles",
            json!({ "name": "Teamleitung", "description": "", "permissions": ["teams:read", "teams:write"] }),
            &t.owner,
        )
        .await;
    assert!(role.status.is_success(), "{}", role.body);
    let (lea_id, lea) = t.member("Lea", role.body["id"].as_str().unwrap()).await;
    t.join(&s.b, &lea_id, "maintainer").await;
    let r = t.delete(&format!("~/teams/{}?transferTo={}", s.a, s.b), &lea).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.delete(&format!("~/teams/{}?transferTo=org", s.a), &lea).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // Maintaining both teams, she may; no admin access is recorded.
    t.join(&s.a, &lea_id, "maintainer").await;
    let r = t.delete(&format!("~/teams/{}?transferTo={}", s.a, s.b), &lea).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert!(t.events("team_space.admin_access", &s.a).await.iter().all(|e| e["summary"]["action"] != "team.deleted"));
    // An org admin hands B's spaces to the organization, recorded as admin access.
    let r = t.delete(&format!("~/teams/{}?transferTo=org", s.b), &t.owner).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    let events = t.events("team_space.admin_access", &s.b).await;
    assert!(events.iter().any(|e| e["summary"]["action"] == "team.deleted"), "{events:?}");
}

async fn a_spaces_library_panel_stays_in_the_space(t: TestApp) {
    let s = two_teams(&t).await;
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&s.a, &carl_id, "member").await;
    let open = t.folder("Allgemein", None, false).await;
    let made = t
        .post(
            "~/library-panels",
            json!({ "name": "Lastkurve", "model": library_model("Lastkurve"), "folderId": s.space_a }),
            &s.anna,
        )
        .await;
    assert_eq!(made.status, StatusCode::CREATED, "{}", made.body);
    let lib = made.body["id"].as_str().unwrap().to_string();
    // Inside the space, every member of the team shows it.
    let inside = t.post("~/dashboards", json!({ "folderId": s.space_a, "model": showing("Innen", &lib) }), &carl).await;
    assert_eq!(inside.status, StatusCode::CREATED, "{}", inside.body);
    let inside = inside.body["id"].as_str().unwrap().to_string();
    // Outside it, only the team's maintainers and org admins.
    let r = t.post("~/dashboards", json!({ "folderId": open, "model": showing("Außen", &lib) }), &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t.post("~/dashboards", json!({ "folderId": open, "model": showing("Außen", &lib) }), &s.anna).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    // Carrying a dashboard that shows it out of the space counts as showing it outside.
    let current = t.get(&format!("~/dashboards/{inside}"), &t.owner).await.body["version"].clone();
    let body = json!({ "model": showing("Innen", &lib), "version": current, "folderId": open });
    let r = t.put(&format!("~/dashboards/{inside}"), body, &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // Moving a library panel out of a space is recorded like other moves out.
    let lone = t
        .post(
            "~/library-panels",
            json!({ "name": "Allein", "model": library_model("Allein"), "folderId": s.space_a }),
            &s.anna,
        )
        .await;
    let lone = lone.body["id"].as_str().unwrap().to_string();
    let body = json!({ "version": 1, "name": "Allein", "model": library_model("Allein"), "folderId": open });
    assert_eq!(t.put(&format!("~/library-panels/{lone}"), body, &s.anna).await.status, StatusCode::OK);
    assert_eq!(t.events("team_space.moved_out", &lone).await.len(), 1);
}

async fn admins_reading_shared_content_leave_no_trace(t: TestApp) {
    let s = two_teams(&t).await;
    let open = t.folder("Gemeinsam", None, false).await;
    let shared = t.dashboard("Absatz", Some(&open), &t.owner).await;
    t.set_owner("dashboards", &shared, Some(&s.b), "shared", &t.owner).await;
    let path = |id: &str| format!("~/dashboards/{id}/annotations?from=0&to=1");
    // Reading another team's shared dashboard and its annotations is everyone's: no entry.
    assert_eq!(t.get(&path(&shared), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&shared).await, 0);
    // Reading through an own grant is no admin access either.
    let owner_id: (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'joerg@example.de'").fetch_one(&t.state.db).await.unwrap();
    let body = json!({ "subjectType": "user", "subjectId": owner_id.0, "resourceType": "folder",
                       "resourceId": s.space_a, "level": "view" });
    assert!(t.post("~/grants", body, &t.owner).await.status.is_success());
    let inside = t.dashboard("Netz", Some(&s.space_a), &s.anna).await;
    assert_eq!(t.get(&path(&inside), &t.owner).await.status, StatusCode::OK);
    assert_eq!(t.admin_accesses(&inside).await, 0);
    // Without one, reading another team's space is recorded, as a read.
    let theirs = t.dashboard("Angebote", Some(&s.space_b), &s.bert).await;
    assert_eq!(t.get(&path(&theirs), &t.owner).await.status, StatusCode::OK);
    let events = t.events("team_space.admin_access", &theirs).await;
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["summary"]["permission"], "dashboards:read");
}

async fn other_teams_content_goes_into_a_space_through_admins(t: TestApp) {
    let s = two_teams(&t).await;
    let (carl_id, carl) = t.member("Carl", "editor").await;
    t.join(&s.a, &carl_id, "member").await;
    t.join(&s.b, &carl_id, "member").await;
    let open = t.folder("Allgemein", None, false).await;
    let theirs = t.dashboard("Vertriebszahlen", Some(&open), &t.owner).await;
    t.set_owner("dashboards", &theirs, Some(&s.b), "shared", &t.owner).await;
    // Carl edits B's dashboard and may write in A's space, but cannot carry B's content into it.
    assert_eq!(t.save(&theirs, "Vertriebszahlen", Some(Some(&s.space_a)), &carl).await.status, StatusCode::FORBIDDEN);
    let folder = t.folder("Vertriebsordner", None, false).await;
    t.set_owner("folders", &folder, Some(&s.b), "shared", &t.owner).await;
    let r = t.move_folder(&folder, Some(&s.space_a), &carl).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    // An org admin may.
    assert_eq!(t.save(&theirs, "Vertriebszahlen", Some(Some(&s.space_a)), &t.owner).await.status, StatusCode::OK);
}
