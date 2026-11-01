//! SCIM provisioning through the real router (SQLite), with the request shapes Entra ID and Okta
//! send (docs/api/scim.md): users and groups, deactivation instead of deletion, the group mapping,
//! organization isolation, the accounts SCIM never touches, and the token's checks.

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

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const SCIM: &str = "application/scim+json";

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    org: String,
    owner: String,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Reply {
    fn scim_type(&self) -> &str {
        self.body["scimType"].as_str().unwrap_or("")
    }

    fn id(&self) -> String {
        self.body["id"].as_str().unwrap_or_else(|| panic!("no id in {}", self.body)).to_string()
    }
}

impl TestApp {
    async fn new() -> TestApp {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().to_path_buf();
        let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
        let clock = Arc::new(ManualClock::new(1_800_000_000_000));
        let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
        let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let app = router(state.clone()).layer(MockConnectInfo(peer));
        let mut t = TestApp { app, clock, state, dir: Arc::new(dir), org: String::new(), owner: String::new() };
        let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jörg Müller",
                           "email": "joerg@example.de", "password": PASSWORD });
        let r = t.request(Method::POST, "/api/setup", Some(body), None, "application/json").await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        t.org = r.body["orgs"][0]["id"].as_str().unwrap().to_string();
        assert!(!t.owner.is_empty(), "setup signs the owner in");
        t
    }

    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn request(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
        auth: Option<(&str, &str)>,
        content_type: &str,
    ) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        match auth {
            Some(("cookie", c)) => req = req.header(header::COOKIE, c),
            Some((_, token)) => req = req.header(header::AUTHORIZATION, format!("Bearer {token}")),
            None => {}
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, content_type).body(Body::from(b.to_string())),
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
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        self.clock.advance_ms(1);
        Reply { status, headers, body }
    }

    /// A request of the owner to `/api/orgs/{org}{rest}`.
    async fn owner(&mut self, method: Method, rest: &str, body: Option<Value>) -> Reply {
        let (path, cookie) = (format!("/api/orgs/{}{rest}", self.org), self.owner.clone());
        self.request(method, &path, body, Some(("cookie", &cookie)), "application/json").await
    }

    async fn admin(&mut self, method: Method, path: &str, body: Option<Value>) -> Reply {
        let cookie = self.owner.clone();
        self.request(method, path, body, Some(("cookie", &cookie)), "application/json").await
    }

    /// A new SCIM token of the organization `org`.
    async fn scim_token(&mut self, org: &str) -> String {
        let cookie = self.owner.clone();
        let path = format!("/api/orgs/{org}/scim-token");
        let r = self.request(Method::POST, &path, Some(json!({})), Some(("cookie", &cookie)), "application/json").await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["token"].as_str().unwrap().to_string()
    }

    /// A SCIM request to `rest` below the base URL of `org`.
    async fn scim_in(&mut self, org: &str, method: Method, rest: &str, body: Option<Value>, token: &str) -> Reply {
        let path = format!("/scim/v2/o/{org}{rest}");
        self.request(method, &path, body, Some(("bearer", token)), SCIM).await
    }

    async fn scim(&mut self, method: Method, rest: &str, body: Option<Value>, token: &str) -> Reply {
        let org = self.org.clone();
        self.scim_in(&org, method, rest, body, token).await
    }

    async fn role_of(&self, org: &str, user: &str) -> Option<String> {
        sqlx::query_as::<_, (String,)>("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
            .bind(org)
            .bind(user)
            .fetch_optional(&self.state.db)
            .await
            .unwrap()
            .map(|(r,)| r)
    }

    async fn account(&self, user: &str) -> (String, String, i64, i64) {
        sqlx::query_as("SELECT email, name, disabled, email_confirmed FROM users WHERE id = $1")
            .bind(user)
            .fetch_one(&self.state.db)
            .await
            .unwrap()
    }

    async fn audit_actions(&self) -> Vec<(String, Value)> {
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT action, summary FROM audit_events ORDER BY created_at, id")
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter().map(|(a, s)| (a, serde_json::from_str(&s).unwrap())).collect()
    }

    /// A group mapping rule for `org` (through a provider made for it).
    async fn mapping(&self, group: &str, org: &str, team: Option<&str>, role: &str, idp_decides: bool) {
        let provider: Option<(String,)> =
            sqlx::query_as("SELECT id FROM sso_providers").fetch_optional(&self.state.db).await.unwrap();
        let provider = match provider {
            Some((id,)) => id,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                sqlx::query(
                    "INSERT INTO sso_providers (id, slug, kind, name, position, enabled, config, created_at, \
                     updated_at) VALUES ($1, 'mueller-sso', 'oidc', 'Müller SSO', 0, 1, '{}', 0, 0)",
                )
                .bind(&id)
                .execute(&self.state.db)
                .await
                .unwrap();
                id
            }
        };
        sqlx::query(
            "INSERT INTO sso_group_mappings (id, provider_id, group_name, org_id, team_id, role, idp_decides, \
             created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(&provider)
        .bind(group)
        .bind(org)
        .bind(team)
        .bind(role)
        .bind(i64::from(idp_decides))
        .execute(&self.state.db)
        .await
        .unwrap();
    }

    /// A second organization, owned by the setup owner.
    async fn other_org(&mut self) -> String {
        let me = self.admin(Method::GET, "/api/me", None).await;
        let owner = me.body["id"].as_str().unwrap().to_string();
        let r = self
            .admin(Method::POST, "/api/admin/orgs", Some(json!({ "name": "Werk Nord", "ownerUserId": owner })))
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }

    /// Signs in `email` (with the test password) and answers the session cookie.
    async fn login(&mut self, email: &str) -> String {
        let body = json!({ "email": email, "password": PASSWORD });
        let r = self.request(Method::POST, "/api/auth/login", Some(body), None, "application/json").await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let set = r.headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
        set.split(';').next().unwrap().to_string()
    }

    /// A confirmed account made by a server admin, with a password.
    async fn person(&mut self, name: &str, email: &str) -> String {
        let r = self
            .admin(
                Method::POST,
                "/api/admin/users",
                Some(json!({ "name": name, "email": email, "password": PASSWORD })),
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        r.body["id"].as_str().unwrap().to_string()
    }
}

/// A user as Entra ID provisions it.
fn entra_user(user_name: &str, given: &str, family: &str) -> Value {
    json!({
        "schemas": [
            "urn:ietf:params:scim:schemas:core:2.0:User",
            "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"
        ],
        "externalId": format!("ext-{given}"),
        "userName": user_name,
        "active": true,
        "displayName": format!("{given} {family}"),
        "emails": [{ "primary": true, "type": "work", "value": user_name }],
        "meta": { "resourceType": "User" },
        "name": { "formatted": format!("{given} {family}"), "familyName": family, "givenName": given },
        "title": "Analyst",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { "department": "Vertrieb" }
    })
}

fn patch(ops: Value) -> Value {
    json!({ "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], "Operations": ops })
}

#[tokio::test]
async fn entra_provisions_users_and_groups_and_the_mapping_applies() {
    let mut t = TestApp::new().await;
    let token = t.scim_token(&t.org.clone()).await;
    t.mapping("kalzit-admins", &t.org.clone(), None, "admin", true).await;

    // Entra's connection test and discovery.
    let r = t.scim(Method::GET, "/ServiceProviderConfig", None, &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.headers[header::CONTENT_TYPE], SCIM);
    assert_eq!(r.body["patch"]["supported"], true);
    let r = t.scim(Method::GET, "/Schemas", None, &token).await;
    assert_eq!(r.body["totalResults"], 2);
    let r = t.scim(Method::GET, "/ResourceTypes/User", None, &token).await;
    assert_eq!(r.body["endpoint"], "/Users");

    // Entra looks for the user first, then creates it.
    let filter = "/Users?filter=userName+eq+%22anna.berg%40mueller.example%22";
    let r = t.scim(Method::GET, filter, None, &token).await;
    assert_eq!((r.status, r.body["totalResults"].clone()), (StatusCode::OK, json!(0)), "{}", r.body);
    let r = t.scim(Method::POST, "/Users", Some(entra_user("anna.berg@mueller.example", "Anna", "Berg")), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let anna = r.id();
    assert_eq!(r.headers[header::LOCATION], format!("http://kalzit.test/scim/v2/o/{}/Users/{anna}", t.org));
    assert_eq!(r.body["userName"], "anna.berg@mueller.example");
    assert_eq!(r.body["active"], true);
    assert_eq!(r.body["name"]["givenName"], "Anna");
    assert!(r.body.get("title").is_none(), "attributes Kalzit does not keep are left out");
    // A new account without a password, its address unconfirmed, in the organization with the
    // default role.
    let (email, name, disabled, confirmed) = t.account(&anna).await;
    assert_eq!((email.as_str(), name.as_str(), disabled, confirmed), ("anna.berg@mueller.example", "Anna Berg", 0, 0));
    assert_eq!(t.role_of(&t.org.clone(), &anna).await.as_deref(), Some("viewer"));
    let r = t.scim(Method::GET, &filter.replace("anna.berg", "ANNA.Berg"), None, &token).await;
    assert_eq!(r.body["totalResults"], 1, "userName compares case-insensitively: {}", r.body);
    assert_eq!(r.body["Resources"][0]["id"], anna.as_str());
    let r = t.scim(Method::GET, "/Users?filter=externalId+eq+%22ext-Anna%22", None, &token).await;
    assert_eq!(r.body["totalResults"], 1);
    let r = t.scim(Method::POST, "/Users", Some(entra_user("anna.berg@mueller.example", "A", "B")), &token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::CONFLICT, "uniqueness"));

    // Entra's PATCH: capitalized ops, filtered email paths, booleans as strings.
    let ops = patch(json!([
        { "op": "Replace", "path": "displayName", "value": "Anna Brandt" },
        { "op": "Add", "path": "emails[type eq \"work\"].value", "value": "anna.brandt@mueller.example" },
        { "op": "Replace", "path": "name.familyName", "value": "Brandt" }
    ]));
    let r = t.scim(Method::PATCH, &format!("/Users/{anna}"), Some(ops), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["displayName"], "Anna Brandt");
    let (email, name, _, confirmed) = t.account(&anna).await;
    assert_eq!((email.as_str(), name.as_str(), confirmed), ("anna.brandt@mueller.example", "Anna Brandt", 0));

    // A group, then its members as Entra adds them.
    let group = json!({ "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"], "displayName": "kalzit-admins",
                        "externalId": "9a7e", "members": [] });
    let r = t.scim(Method::POST, "/Groups", Some(group), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let admins = r.id();
    let add = patch(json!([{ "op": "Add", "path": "members", "value": [{ "value": anna }] }]));
    let r = t.scim(Method::PATCH, &format!("/Groups/{admins}"), Some(add), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["members"][0]["value"], anna.as_str());
    assert_eq!(t.role_of(&t.org.clone(), &anna).await.as_deref(), Some("admin"), "the mapping applies at once");
    // "IdP entscheidet": the role is locked in Members.
    let r = t.owner(Method::GET, "/members", None).await;
    let member = r.body["items"].as_array().unwrap().iter().find(|m| m["userId"] == anna.as_str()).unwrap().clone();
    assert_eq!(member["idpManaged"], true, "{member}");
    let r = t.owner(Method::PATCH, &format!("/members/{anna}"), Some(json!({ "role": "viewer" }))).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    let r = t.scim(Method::GET, &format!("/Users/{anna}"), None, &token).await;
    assert_eq!(r.body["groups"][0]["display"], "kalzit-admins");
    let r = t
        .scim(Method::GET, "/Groups?filter=displayName+eq+%22kalzit-admins%22&excludedAttributes=members", None, &token)
        .await;
    assert_eq!(r.body["totalResults"], 1, "{}", r.body);
    assert!(r.body["Resources"][0].get("members").is_none(), "{}", r.body);

    let remove = patch(json!([{ "op": "Remove", "path": "members", "value": [{ "value": anna }] }]));
    let r = t.scim(Method::PATCH, &format!("/Groups/{admins}"), Some(remove), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(
        t.role_of(&t.org.clone(), &anna).await.as_deref(),
        Some("viewer"),
        "the role follows the directory down"
    );

    // Entra disables the user with the string "False" and enables it again.
    let off = patch(json!([{ "op": "Replace", "path": "active", "value": "False" }]));
    let r = t.scim(Method::PATCH, &format!("/Users/{anna}"), Some(off), &token).await;
    assert_eq!((r.status, r.body["active"].clone()), (StatusCode::OK, json!(false)), "{}", r.body);
    assert_eq!(t.account(&anna).await.2, 1, "an account SCIM made is locked");
    assert_eq!(t.role_of(&t.org.clone(), &anna).await.as_deref(), Some("viewer"), "its membership stays");
    let on = patch(json!([{ "op": "Replace", "path": "active", "value": "True" }]));
    let r = t.scim(Method::PATCH, &format!("/Users/{anna}"), Some(on), &token).await;
    assert_eq!(r.body["active"], true, "{}", r.body);
    assert_eq!(t.account(&anna).await.2, 0);

    let actions: Vec<String> = t.audit_actions().await.into_iter().map(|(a, _)| a).collect();
    for wanted in [
        "scim.user_created",
        "scim.user_updated",
        "scim.group_created",
        "scim.group_updated",
        "scim.memberships_changed",
        "scim.user_deactivated",
        "scim.user_reactivated",
    ] {
        assert!(actions.iter().any(|a| a == wanted), "{wanted} in {actions:?}");
    }
    // SCIM changes name the token and no person.
    let (token_id, actor): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT actor_token_prefix, actor_user_id FROM audit_events WHERE action = 'scim.user_created'")
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert!(token.starts_with(&token_id.unwrap()));
    assert_eq!(actor, None);
    t.finish().await;
}

#[tokio::test]
async fn okta_provisions_with_put_and_path_less_patches() {
    let mut t = TestApp::new().await;
    let token = t.scim_token(&t.org.clone()).await;
    t.mapping("Vertrieb", &t.org.clone(), None, "editor", false).await;
    let okta = json!({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
        "userName": "jonas.weber@mueller.example",
        "name": { "givenName": "Jonas", "familyName": "Weber" },
        "emails": [{ "primary": true, "value": "jonas.weber@mueller.example", "type": "work" }],
        "displayName": "Jonas Weber",
        "locale": "de-DE",
        "externalId": "00u1abc",
        "groups": [],
        "password": "not-kept-1!",
        "active": true
    });
    let r = t.scim(Method::POST, "/Users", Some(okta.clone()), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let jonas = r.id();
    // A PUT replaces the attributes.
    let mut put = okta.clone();
    put["name"]["familyName"] = json!("Weber-Lang");
    put["displayName"] = json!("Jonas Weber-Lang");
    let r = t.scim(Method::PUT, &format!("/Users/{jonas}"), Some(put), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.account(&jonas).await.1, "Jonas Weber-Lang");

    // Okta's group shapes: create with members, replace without a path, remove by filter.
    let r = t
        .scim(
            Method::POST,
            "/Groups",
            Some(json!({ "displayName": "Vertrieb", "members": [{ "value": jonas, "display": "Jonas" }] })),
            &token,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let group = r.id();
    assert_eq!(t.role_of(&t.org.clone(), &jonas).await.as_deref(), Some("editor"));
    // "Kalzit ergänzt": an admin may give more, and it stays when the group falls away.
    let r = t.owner(Method::PATCH, &format!("/members/{jonas}"), Some(json!({ "role": "admin" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let rename = patch(json!([{ "op": "replace", "value": { "id": group, "displayName": "Vertrieb Süd" } }]));
    let r = t.scim(Method::PATCH, &format!("/Groups/{group}"), Some(rename), &token).await;
    assert_eq!((r.status, r.body["displayName"].clone()), (StatusCode::OK, json!("Vertrieb Süd")), "{}", r.body);
    let remove = patch(json!([{ "op": "remove", "path": format!("members[value eq \"{jonas}\"]") }]));
    let r = t.scim(Method::PATCH, &format!("/Groups/{group}"), Some(remove), &token).await;
    assert_eq!(r.body["members"], json!([]), "{}", r.body);
    assert_eq!(t.role_of(&t.org.clone(), &jonas).await.as_deref(), Some("admin"));

    // Okta deactivates with a path-less replace.
    let off = patch(json!([{ "op": "replace", "value": { "active": false } }]));
    let r = t.scim(Method::PATCH, &format!("/Users/{jonas}"), Some(off), &token).await;
    assert_eq!(r.body["active"], false, "{}", r.body);
    assert_eq!(t.account(&jonas).await.2, 1);
    let r = t.scim(Method::GET, "/Users?filter=active+eq+false", None, &token).await;
    assert_eq!(r.body["totalResults"], 1);

    // Pagination.
    for i in 0..3 {
        let u = json!({ "userName": format!("p{i}@mueller.example") });
        assert_eq!(t.scim(Method::POST, "/Users", Some(u), &token).await.status, StatusCode::CREATED);
    }
    let r = t.scim(Method::GET, "/Users?startIndex=2&count=2", None, &token).await;
    assert_eq!((r.body["totalResults"].clone(), r.body["startIndex"].clone()), (json!(4), json!(2)), "{}", r.body);
    assert_eq!(r.body["itemsPerPage"], 2);
    assert_eq!(r.body["Resources"][0]["userName"], "p0@mueller.example");
    let r = t.scim(Method::GET, "/Users?count=0", None, &token).await;
    assert_eq!((r.body["totalResults"].clone(), r.body["Resources"].clone()), (json!(4), json!([])));
    let r = t.scim(Method::GET, "/Users?filter=userName+co+%22p%22", None, &token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::BAD_REQUEST, "invalidFilter"));
    assert_eq!(r.headers[header::CONTENT_TYPE], SCIM);
    assert_eq!(r.body["schemas"][0], "urn:ietf:params:scim:api:messages:2.0:Error");
    assert_eq!(r.body["status"], "400");
    t.finish().await;
}

#[tokio::test]
async fn delete_deactivates_and_never_deletes() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    // An account SCIM made, in no other organization: DELETE locks it and keeps its membership.
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "eva@mueller.example" })), &token).await;
    let eva = r.id();
    let r = t.scim(Method::DELETE, &format!("/Users/{eva}"), None, &token).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    assert_eq!(t.account(&eva).await.2, 1);
    assert_eq!(t.role_of(&org, &eva).await.as_deref(), Some("viewer"));
    let r = t.scim(Method::GET, &format!("/Users/{eva}"), None, &token).await;
    assert_eq!((r.status, r.body["active"].clone()), (StatusCode::OK, json!(false)), "the user stays in SCIM");
    assert_eq!(t.scim(Method::DELETE, &format!("/Users/{eva}"), None, &token).await.status, StatusCode::NO_CONTENT);

    // An existing account in another organization: linked only once it joined here by invitation,
    // and DELETE ends only its membership here; the account and its other membership stay.
    let lea = t.person("Lea Hoffmann", "lea@mueller.example").await;
    let other = t.other_org().await;
    let cookie = t.owner.clone();
    let r = t
        .request(
            Method::POST,
            &format!("/api/orgs/{other}/members"),
            Some(json!({ "email": "lea@mueller.example", "role": "editor" })),
            Some(("cookie", &cookie)),
            "application/json",
        )
        .await;
    assert!(r.status.is_success(), "{}", r.body);
    let r = t.scim(Method::POST, "/Users", Some(entra_user("lea@mueller.example", "Lea", "H")), &token).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'viewer', 0)")
        .bind(&org)
        .bind(&lea)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.scim(Method::POST, "/Users", Some(entra_user("lea@mueller.example", "Lea", "H")), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.id(), lea, "linked to the confirmed account with the address");
    assert_eq!(t.account(&lea).await.1, "Lea Hoffmann", "a linked account keeps its name");
    assert_eq!(t.role_of(&org, &lea).await.as_deref(), Some("viewer"));
    let r = t.scim(Method::DELETE, &format!("/Users/{lea}"), None, &token).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(t.account(&lea).await.2, 0, "not locked");
    assert_eq!(t.role_of(&org, &lea).await, None, "its membership here ended");
    assert_eq!(t.role_of(&other, &lea).await.as_deref(), Some("editor"));
    // Reactivating does not bring the membership back: Lea belongs to another organization and
    // joins this one again only by invitation.
    let on = patch(json!([{ "op": "replace", "path": "active", "value": true }]));
    let r = t.scim(Method::PATCH, &format!("/Users/{lea}"), Some(on), &token).await;
    assert_eq!(r.body["active"], true, "{}", r.body);
    assert_eq!(t.role_of(&org, &lea).await, None);

    // A group DELETE deactivates it.
    let r = t
        .scim(Method::POST, "/Groups", Some(json!({ "displayName": "Alt", "members": [{ "value": lea }] })), &token)
        .await;
    let group = r.id();
    assert_eq!(t.scim(Method::DELETE, &format!("/Groups/{group}"), None, &token).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.scim(Method::GET, &format!("/Groups/{group}"), None, &token).await.status, StatusCode::NOT_FOUND);
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM scim_groups WHERE id = $1")
        .bind(&group)
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(rows, 1, "the row stays for the audit log");
    let r = t.scim(Method::POST, "/Groups", Some(json!({ "displayName": "Alt" })), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "a deactivated group's name is free again: {}", r.body);

    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&t.state.db).await.unwrap();
    assert_eq!(users, 3, "nothing was deleted");
    let scopes: Vec<Value> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(a, _)| a == "scim.user_deactivated")
        .map(|(_, s)| s["scope"].clone())
        .collect();
    assert_eq!(scopes, [json!("account"), json!("organization")]);
    t.finish().await;
}

#[tokio::test]
async fn organizations_stay_apart() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let other = t.other_org().await;
    let token = t.scim_token(&org).await;
    let other_token = t.scim_token(&other).await;
    // A mapping rule of the other organization never applies to this one's groups.
    t.mapping("kalzit-admins", &other, None, "admin", true).await;

    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "mia@mueller.example" })), &token).await;
    let mia = r.id();
    // The token of one organization on the other's routes.
    let r = t.scim_in(&other, Method::GET, "/Users", None, &token).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.body);
    assert_eq!(r.headers[header::WWW_AUTHENTICATE], "Bearer");
    let r = t.scim_in(&other, Method::GET, &format!("/Users/{mia}"), None, &other_token).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t.scim_in(&other, Method::GET, "/Users", None, &other_token).await;
    assert_eq!(r.body["totalResults"], 0);
    let group = json!({ "displayName": "kalzit-admins", "members": [{ "value": mia }] });
    let r = t.scim_in(&other, Method::POST, "/Groups", Some(group.clone()), &other_token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::BAD_REQUEST, "invalidValue"), "{}", r.body);
    let r = t.scim(Method::POST, "/Groups", Some(group), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(t.role_of(&org, &mia).await.as_deref(), Some("viewer"), "the other organization's rule does not apply");
    assert_eq!(t.role_of(&other, &mia).await, None);
    let refusal: Vec<Value> =
        t.audit_actions().await.into_iter().filter(|(a, _)| a == "api_token.refused").map(|(_, s)| s).collect();
    assert_eq!(refusal.len(), 1);
    assert_eq!((refusal[0]["reason"].clone(), refusal[0]["kind"].clone()), (json!("other_org"), json!("scim")));
    t.finish().await;
}

#[tokio::test]
async fn an_account_in_another_organization_is_linked_only_after_it_joined() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let other = t.other_org().await;
    let token = t.scim_token(&org).await;
    // Pia belongs to the other organization.
    let pia = t.person("Pia Klein", "pia@mueller.example").await;
    let cookie = t.owner.clone();
    let r = t
        .request(
            Method::POST,
            &format!("/api/orgs/{other}/members"),
            Some(json!({ "email": "pia@mueller.example", "role": "viewer" })),
            Some(("cookie", &cookie)),
            "application/json",
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);

    // The directory's word does not bind her account to this organization's sign-in rules.
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "pia@mueller.example" })), &token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::CONFLICT, "uniqueness"), "{}", r.body);
    assert_eq!(t.role_of(&org, &pia).await, None);
    let reasons: Vec<Value> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(a, _)| a == "scim.request_refused")
        .map(|(_, s)| s["reason"].clone())
        .collect();
    assert_eq!(reasons, [json!("scim.account_in_other_org")]);

    // Once she accepted an invitation here, the directory links her account.
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'viewer', 0)")
        .bind(&org)
        .bind(&pia)
        .execute(&t.state.db)
        .await
        .unwrap();
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "pia@mueller.example" })), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.id(), pia);
    t.finish().await;
}

#[tokio::test]
async fn scim_never_adds_back_a_person_who_left_or_joined_elsewhere() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let other = t.other_org().await;
    let token = t.scim_token(&org).await;
    // Sam joins this organization through SCIM.
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "sam@mueller.example" })), &token).await;
    let sam = r.id();
    assert_eq!(t.role_of(&org, &sam).await.as_deref(), Some("viewer"));
    let (joined_by,): (String,) =
        sqlx::query_as("SELECT joined_by FROM org_members WHERE org_id = $1 AND user_id = $2")
            .bind(&org)
            .bind(&sam)
            .fetch_one(&t.state.db)
            .await
            .unwrap();
    assert_eq!(joined_by, "scim_owned");
    // Sam sets a password, joins the other organization by invitation and leaves this one.
    let hash = kalzit::auth::password::hash(PASSWORD.to_string()).await.unwrap();
    sqlx::query("UPDATE users SET password_hash = $1, email_confirmed = 1 WHERE id = $2")
        .bind(&hash)
        .bind(&sam)
        .execute(&t.state.db)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO org_members (org_id, user_id, role, created_at, joined_by) VALUES ($1, $2, 'viewer', 0, 'invitation')",
    )
    .bind(&other)
    .bind(&sam)
    .execute(&t.state.db)
    .await
    .unwrap();
    let cookie = t.login("sam@mueller.example").await;
    let r = t
        .request(Method::DELETE, &format!("/api/me/orgs/{org}"), None, Some(("cookie", &cookie)), "application/json")
        .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);

    // Neither a PATCH, a reactivation nor a group change adds Sam back.
    let ops = patch(json!([{ "op": "replace", "path": "displayName", "value": "Samuel" }]));
    let r = t.scim(Method::PATCH, &format!("/Users/{sam}"), Some(ops), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let ops = patch(json!([{ "op": "replace", "path": "active", "value": true }]));
    let r = t.scim(Method::PATCH, &format!("/Users/{sam}"), Some(ops), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let group = json!({ "displayName": "alle", "members": [{ "value": sam }] });
    let r = t.scim(Method::POST, "/Groups", Some(group), &token).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(t.role_of(&org, &sam).await, None, "the leave sticks");
    assert_eq!(t.role_of(&other, &sam).await.as_deref(), Some("viewer"));
    let skipped = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(a, _)| a == "scim.memberships_changed")
        .any(|(_, s)| s.to_string().contains("\"skipped\""));
    assert!(skipped, "the skip is in the audit log");
    t.finish().await;
}

#[tokio::test]
async fn service_accounts_admins_and_the_last_owner_are_protected() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    let r =
        t.owner(Method::POST, "/service-accounts", Some(json!({ "name": "export-nightly", "role": "viewer" }))).await;
    let account = r.body["id"].as_str().unwrap().to_string();

    // A service account is never linked, listed, found or made a member.
    let r = t
        .scim(Method::POST, "/Users", Some(json!({ "userName": format!("{account}@service-account.invalid") })), &token)
        .await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::CONFLICT, "uniqueness"), "{}", r.body);
    assert_eq!(t.scim(Method::GET, &format!("/Users/{account}"), None, &token).await.status, StatusCode::NOT_FOUND);
    assert_eq!(t.scim(Method::DELETE, &format!("/Users/{account}"), None, &token).await.status, StatusCode::NOT_FOUND);
    let r = t
        .scim(Method::POST, "/Groups", Some(json!({ "displayName": "x", "members": [{ "value": account }] })), &token)
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.body);

    // A server admin's account (here also the only owner) is never linked.
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "joerg@example.de" })), &token).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);

    // An account whose owner never confirmed its address is never linked.
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, email_confirmed) \
         VALUES ($1, 'neu@mueller.example', 'Neu', NULL, 0, 0, 0, 0)",
    )
    .bind(&id)
    .execute(&t.state.db)
    .await
    .unwrap();
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "neu@mueller.example" })), &token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::CONFLICT, "uniqueness"), "{}", r.body);

    // No owner is ever deactivated, also not one of several, and also not with a token an admin
    // (not an owner) made.
    let ada = t.person("Ada Admin", "ada@mueller.example").await;
    let r = t.owner(Method::POST, "/members", Some(json!({ "email": "ada@mueller.example", "role": "admin" }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let ada_cookie = t.login("ada@mueller.example").await;
    let r = t
        .request(
            Method::POST,
            &format!("/api/orgs/{org}/scim-token"),
            Some(json!({})),
            Some(("cookie", &ada_cookie)),
            "application/json",
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let token = r.body["token"].as_str().unwrap().to_string();
    let lea = t.person("Lea Hoffmann", "lea@mueller.example").await;
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "lea@mueller.example" })), &token).await;
    assert_eq!(r.id(), lea);
    assert_eq!(
        t.owner(Method::PATCH, &format!("/members/{lea}"), Some(json!({ "role": "owner" }))).await.status,
        StatusCode::OK
    );
    let r = t.scim(Method::DELETE, &format!("/Users/{lea}"), None, &token).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert_eq!(t.role_of(&org, &lea).await.as_deref(), Some("owner"));
    let r = t.scim(Method::GET, &format!("/Users/{lea}"), None, &token).await;
    assert_eq!(r.body["active"], true, "nothing changed: {}", r.body);
    // Ada herself is an admin: SCIM holds what she holds and may end her membership here.
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "ada@mueller.example" })), &token).await;
    assert_eq!(r.id(), ada);
    // A mapping never demotes an owner either.
    t.mapping("leser", &org, None, "viewer", true).await;
    let r = t
        .scim(Method::POST, "/Groups", Some(json!({ "displayName": "leser", "members": [{ "value": lea }] })), &token)
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(t.role_of(&org, &lea).await.as_deref(), Some("owner"));

    let reasons: Vec<Value> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(a, _)| a == "scim.request_refused")
        .map(|(_, s)| s["reason"].clone())
        .collect();
    assert_eq!(
        reasons,
        [
            json!("scim.email_taken"),
            json!("scim.member_unknown"),
            json!("scim.account_protected"),
            json!("scim.email_unconfirmed"),
            json!("scim.account_protected"),
        ]
    );
    t.finish().await;
}

#[tokio::test]
async fn the_token_is_checked_on_every_request_and_revocation_ends_it() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    assert_eq!(t.scim(Method::GET, "/Users", None, &token).await.status, StatusCode::OK);

    // Not without a token, not with a service account token, and the SCIM token not on /api.
    let r = t.request(Method::GET, &format!("/scim/v2/o/{org}/Users"), None, None, SCIM).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t.owner(Method::POST, "/service-accounts", Some(json!({ "name": "bot", "role": "admin" }))).await;
    let bot = r.body["id"].as_str().unwrap().to_string();
    let r = t.owner(Method::POST, &format!("/service-accounts/{bot}/tokens"), Some(json!({ "name": "t" }))).await;
    let sa_token = r.body["token"].as_str().unwrap().to_string();
    assert_eq!(t.scim(Method::GET, "/Users", None, &sa_token).await.status, StatusCode::UNAUTHORIZED);
    let r =
        t.request(Method::GET, &format!("/api/orgs/{org}"), None, Some(("bearer", &token)), "application/json").await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    assert_eq!(t.scim(Method::GET, "/Nichts", None, &token).await.status, StatusCode::NOT_FOUND);
    let r = t.request(Method::GET, "/scim/v2/o/kein-org/Users", None, Some(("bearer", &token)), SCIM).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // The switch turns SCIM off without revoking the token.
    let r = t.owner(Method::PUT, "/scim", Some(json!({ "enabled": false }))).await;
    assert_eq!((r.status, r.body["enabled"].clone()), (StatusCode::OK, json!(false)), "{}", r.body);
    assert_eq!(t.scim(Method::GET, "/Users", None, &token).await.status, StatusCode::FORBIDDEN);
    t.owner(Method::PUT, "/scim", Some(json!({ "enabled": true }))).await;
    assert_eq!(
        t.scim(Method::POST, "/Users", Some(json!({ "userName": "a@mueller.example" })), &token).await.status,
        StatusCode::CREATED
    );
    let r = t.scim(Method::POST, "/Users", Some(json!({ "userName": "kein-name" })), &token).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    // The status for the card.
    t.state.touches.settle().await;
    let r = t.owner(Method::GET, "/scim", None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["endpoint"], format!("http://kalzit.test/scim/v2/o/{org}"));
    assert_eq!(r.body["stats"]["created"], 1);
    assert_eq!(r.body["stats"]["lastError"]["reason"], "scim.email_missing", "{}", r.body);
    assert_eq!(r.body["token"]["lastUsedAddress"], "127.0.0.1");

    // Revoked: every SCIM request answers 401 at once, and the refusal is audited.
    assert_eq!(t.owner(Method::DELETE, "/scim-token", None).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.scim(Method::GET, "/Users", None, &token).await.status, StatusCode::UNAUTHORIZED);
    let reasons: Vec<(Value, Value)> = t
        .audit_actions()
        .await
        .into_iter()
        .filter(|(a, _)| a == "api_token.refused")
        .map(|(_, s)| (s["reason"].clone(), s["kind"].clone()))
        .collect();
    assert_eq!(
        reasons,
        [
            (json!("wrong_kind"), json!("service_account")),
            (json!("wrong_kind"), json!("scim")),
            (json!("revoked"), json!("scim"))
        ]
    );
    let r = t.owner(Method::GET, "/scim", None).await;
    assert_eq!(r.body["stats"]["lastError"]["action"], "api_token.refused", "{}", r.body);

    // Refused tokens are rate-limited like API tokens.
    let mut statuses = Vec::new();
    for _ in 0..10 {
        statuses.push(t.scim(Method::GET, "/Users", None, &token).await.status);
    }
    assert_eq!(statuses.last(), Some(&StatusCode::TOO_MANY_REQUESTS), "{statuses:?}");
    let r = t.scim(Method::GET, "/Users", None, &token).await;
    assert!(r.headers.contains_key(header::RETRY_AFTER));
    let summaries: Vec<String> = t.audit_actions().await.into_iter().map(|(_, s)| s.to_string()).collect();
    assert!(summaries.iter().all(|s| !s.contains(&token)), "the token is never in the audit log");
    t.finish().await;
}

#[tokio::test]
async fn scim_owns_an_account_only_until_it_joins_elsewhere_is_confirmed_or_becomes_an_admin() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    let create = |name: &str| json!({ "userName": format!("{name}@mueller.example"), "displayName": name });
    let rename = |name: &str| {
        patch(json!([
            { "op": "replace", "path": "displayName", "value": name },
            { "op": "replace", "path": "emails", "value": [{ "value": format!("{name}@neu.example"), "primary": true }] }
        ]))
    };

    // Owned: the directory renames the account.
    let kim = t.scim(Method::POST, "/Users", Some(create("kim")), &token).await.id();
    let r = t.scim(Method::PATCH, &format!("/Users/{kim}"), Some(rename("kimberly")), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(t.account(&kim).await.0, "kimberly@neu.example");
    // Nobody adds the unconfirmed address to another organization.
    let other = t.other_org().await;
    let cookie = t.owner.clone();
    let r = t
        .request(
            Method::POST,
            &format!("/api/orgs/{other}/members"),
            Some(json!({ "email": "kimberly@neu.example", "role": "viewer" })),
            Some(("cookie", &cookie)),
            "application/json",
        )
        .await;
    assert_eq!(r.body["error"]["reason"], "mail.email_unconfirmed", "{}", r.body);
    // Kim owns another organization now: SCIM no longer changes or locks the account, also after
    // Kim leaves it again.
    let r = t.admin(Method::POST, "/api/admin/orgs", Some(json!({ "name": "Kims Firma", "ownerUserId": kim }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let kims = r.body["id"].as_str().unwrap().to_string();
    sqlx::query("DELETE FROM org_members WHERE org_id = $1").bind(&kims).execute(&t.state.db).await.unwrap();
    let r = t.scim(Method::PATCH, &format!("/Users/{kim}"), Some(rename("mallory")), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["displayName"], "mallory", "kept on the SCIM user");
    let (email, name, _, _) = t.account(&kim).await;
    assert_eq!((email.as_str(), name.as_str()), ("kimberly@neu.example", "kimberly"));
    assert_eq!(t.scim(Method::DELETE, &format!("/Users/{kim}"), None, &token).await.status, StatusCode::NO_CONTENT);
    assert_eq!(t.account(&kim).await.2, 0, "not locked: only the membership here ended");

    // Confirmed by its owner: the same, also if the flag were cleared again.
    let lou = t.scim(Method::POST, "/Users", Some(create("lou")), &token).await.id();
    sqlx::query("UPDATE users SET email_confirmed = 1 WHERE id = $1").bind(&lou).execute(&t.state.db).await.unwrap();
    t.scim(Method::PATCH, &format!("/Users/{lou}"), Some(rename("mallory2")), &token).await;
    sqlx::query("UPDATE users SET email_confirmed = 0 WHERE id = $1").bind(&lou).execute(&t.state.db).await.unwrap();
    t.scim(Method::PATCH, &format!("/Users/{lou}"), Some(rename("mallory3")), &token).await;
    let (email, name, _, _) = t.account(&lou).await;
    assert_eq!((email.as_str(), name.as_str()), ("lou@mueller.example", "lou"));

    // A server admin: never renamed, never deactivated.
    let max = t.scim(Method::POST, "/Users", Some(create("max")), &token).await.id();
    let r = t.admin(Method::PATCH, &format!("/api/admin/users/{max}"), Some(json!({ "isServerAdmin": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.scim(Method::PATCH, &format!("/Users/{max}"), Some(rename("mallory4")), &token).await;
    assert_eq!(t.account(&max).await.0, "max@mueller.example");
    let r = t.scim(Method::DELETE, &format!("/Users/{max}"), None, &token).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert_eq!(t.role_of(&org, &max).await.as_deref(), Some("viewer"));
    let (owned,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM scim_users WHERE created_account = 1")
        .fetch_one(&t.state.db)
        .await
        .unwrap();
    assert_eq!(owned, 0, "every ownership ended for good");
    t.finish().await;
}

#[tokio::test]
async fn reactivating_never_undoes_an_admins_lock() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    let nora = t.scim(Method::POST, "/Users", Some(json!({ "userName": "nora@mueller.example" })), &token).await.id();
    let off = patch(json!([{ "op": "replace", "path": "active", "value": false }]));
    let on = patch(json!([{ "op": "replace", "path": "active", "value": true }]));
    t.scim(Method::PATCH, &format!("/Users/{nora}"), Some(off.clone()), &token).await;
    assert_eq!(t.account(&nora).await.2, 1);
    // An admin confirms the lock: SCIM's reactivation leaves the account locked.
    let r = t.admin(Method::PATCH, &format!("/api/admin/users/{nora}"), Some(json!({ "disabled": true }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.scim(Method::PATCH, &format!("/Users/{nora}"), Some(on.clone()), &token).await;
    assert_eq!(r.body["active"], true, "{}", r.body);
    assert_eq!(t.account(&nora).await.2, 1, "the admin's lock stays");
    // An admin unlocks, SCIM locks again and an admin locks too: the same.
    t.admin(Method::PATCH, &format!("/api/admin/users/{nora}"), Some(json!({ "disabled": false }))).await;
    t.scim(Method::PATCH, &format!("/Users/{nora}"), Some(off), &token).await;
    t.admin(Method::PATCH, &format!("/api/admin/users/{nora}"), Some(json!({ "disabled": true }))).await;
    t.scim(Method::PATCH, &format!("/Users/{nora}"), Some(on), &token).await;
    assert_eq!(t.account(&nora).await.2, 1);
    t.finish().await;
}

#[tokio::test]
async fn editors_filters_body_size_and_member_counts_are_checked() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    // An editor never reads or switches SCIM.
    t.person("Eddi Editor", "eddi@mueller.example").await;
    let r = t.owner(Method::POST, "/members", Some(json!({ "email": "eddi@mueller.example", "role": "editor" }))).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let eddi = t.login("eddi@mueller.example").await;
    let path = format!("/api/orgs/{org}/scim");
    let r = t.request(Method::GET, &path, None, Some(("cookie", &eddi)), "application/json").await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t
        .request(Method::PUT, &path, Some(json!({ "enabled": false })), Some(("cookie", &eddi)), "application/json")
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert!(kalzit::scim::enabled(&t.state.db, &org).await.unwrap());

    // Filters over HTTP.
    t.scim(Method::POST, "/Users", Some(json!({ "userName": "a@mueller.example" })), &token).await;
    let r = t.scim(Method::GET, "/Users?filter=active+eq+true", None, &token).await;
    assert_eq!(r.body["totalResults"], 1, "{}", r.body);
    let r = t.scim(Method::GET, "/Users?filter=active+eq+false", None, &token).await;
    assert_eq!(r.body["totalResults"], 0, "{}", r.body);
    for bad in ["userName+eq+%22a%22+or+userName+eq+%22b%22", "userName+co+%22a%22", "displayName+eq+%22a%22"] {
        let r = t.scim(Method::GET, &format!("/Users?filter={bad}"), None, &token).await;
        assert_eq!((r.status, r.scim_type()), (StatusCode::BAD_REQUEST, "invalidFilter"), "{bad}");
    }

    // A body over 1 MiB.
    let big = json!({ "userName": "big@mueller.example", "displayName": "x".repeat(1024 * 1024 + 10) });
    let r = t.scim(Method::POST, "/Users", Some(big), &token).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", r.body);
    assert_eq!(r.headers[header::CONTENT_TYPE], SCIM);

    // More than 10,000 members in one PATCH.
    let group = t.scim(Method::POST, "/Groups", Some(json!({ "displayName": "Alle" })), &token).await.id();
    let members: Vec<Value> = (0..10_001).map(|i| json!({ "value": format!("u{i}") })).collect();
    let add = patch(json!([{ "op": "add", "path": "members", "value": members }]));
    let r = t.scim(Method::PATCH, &format!("/Groups/{group}"), Some(add), &token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::BAD_REQUEST, "tooMany"), "{}", r.body);
    // Many known members at once are checked in chunks.
    let mut ids = Vec::new();
    for i in 0..600 {
        let u = json!({ "userName": format!("m{i}@mueller.example") });
        ids.push(t.scim(Method::POST, "/Users", Some(u), &token).await.id());
    }
    let mut members: Vec<Value> = ids.iter().map(|id| json!({ "value": id })).collect();
    let add = patch(json!([{ "op": "add", "path": "members", "value": members.clone() }]));
    let r = t.scim(Method::PATCH, &format!("/Groups/{group}"), Some(add), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["members"].as_array().unwrap().len(), 600);
    members.push(json!({ "value": "unbekannt" }));
    let put = json!({ "displayName": "Alle", "members": members });
    let r = t.scim(Method::PUT, &format!("/Groups/{group}"), Some(put), &token).await;
    assert_eq!((r.status, r.scim_type()), (StatusCode::BAD_REQUEST, "invalidValue"), "{}", r.body);
    t.finish().await;
}

#[tokio::test]
async fn scim_and_the_directory_sync_never_lift_each_others_locks() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    let off = patch(json!([{ "op": "replace", "path": "active", "value": false }]));
    let on = patch(json!([{ "op": "replace", "path": "active", "value": true }]));
    t.mapping("x", &org, None, "viewer", false).await;
    let (provider,): (String,) = sqlx::query_as("SELECT id FROM sso_providers").fetch_one(&t.state.db).await.unwrap();

    // The sync locked the account, then SCIM deactivates it: SCIM's reactivation leaves the sync's
    // lock, and the sync's enabling it leaves SCIM's.
    let ole = t.scim(Method::POST, "/Users", Some(json!({ "userName": "ole@mueller.example" })), &token).await.id();
    sqlx::query("UPDATE users SET disabled = 1 WHERE id = $1").bind(&ole).execute(&t.state.db).await.unwrap();
    sqlx::query(
        "INSERT INTO ldap_deactivations (user_id, provider_id, run_id, reason, at) \
         VALUES ($1, $2, 'run-1', 'not_in_directory', 0)",
    )
    .bind(&ole)
    .bind(&provider)
    .execute(&t.state.db)
    .await
    .unwrap();
    t.scim(Method::PATCH, &format!("/Users/{ole}"), Some(off.clone()), &token).await;
    t.scim(Method::PATCH, &format!("/Users/{ole}"), Some(on.clone()), &token).await;
    assert_eq!(t.account(&ole).await.2, 1, "the sync's lock stays");
    t.scim(Method::PATCH, &format!("/Users/{ole}"), Some(off), &token).await;
    let mut conn = t.state.db.acquire().await.unwrap();
    let enabled = kalzit::sso::directory::enable_sync_disabled(&mut conn, None, &ole, "run-1", 0).await.unwrap();
    drop(conn);
    assert!(!enabled);
    assert_eq!(t.account(&ole).await.2, 1, "SCIM's lock stays");
    // With the sync's lock gone, SCIM's reactivation unlocks.
    t.scim(Method::PATCH, &format!("/Users/{ole}"), Some(on), &token).await;
    assert_eq!(t.account(&ole).await.2, 0);
    t.finish().await;
}

#[tokio::test]
async fn scim_never_rewrites_an_account_someone_signs_in_to_or_a_protected_one() {
    let mut t = TestApp::new().await;
    let org = t.org.clone();
    let token = t.scim_token(&org).await;
    t.mapping("x", &org, None, "viewer", false).await;
    let (provider,): (String,) = sqlx::query_as("SELECT id FROM sso_providers").fetch_one(&t.state.db).await.unwrap();
    let new_mail = |name: &str| {
        patch(json!([
            { "op": "replace", "path": "displayName", "value": name },
            { "op": "replace", "path": "emails", "value": [{ "value": format!("{name}@evil.example"), "primary": true }] }
        ]))
    };

    // An owner whose account has a linked identity: the email never changes.
    let ida = t.scim(Method::POST, "/Users", Some(json!({ "userName": "ida@mueller.example" })), &token).await.id();
    sqlx::query(
        "INSERT INTO sso_identities (provider_id, subject, issuer, user_id, created_at, last_sign_in_at) \
         VALUES ($1, 'sub-ida', 'https://idp.example', $2, 0, 0)",
    )
    .bind(&provider)
    .bind(&ida)
    .execute(&t.state.db)
    .await
    .unwrap();
    let r = t.owner(Method::PATCH, &format!("/members/{ida}"), Some(json!({ "role": "owner" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.scim(Method::PATCH, &format!("/Users/{ida}"), Some(new_mail("mallory")), &token).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (email, name, _, _) = t.account(&ida).await;
    assert_eq!((email.as_str(), name.as_str()), ("ida@mueller.example", "ida"));
    // The identity alone ends the ownership for good, also once it is gone again.
    sqlx::query("DELETE FROM sso_identities WHERE user_id = $1").bind(&ida).execute(&t.state.db).await.unwrap();
    let r = t.owner(Method::PATCH, &format!("/members/{ida}"), Some(json!({ "role": "viewer" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.scim(Method::PATCH, &format!("/Users/{ida}"), Some(new_mail("mallory2")), &token).await;
    assert_eq!(t.account(&ida).await.0, "ida@mueller.example");

    // An owner without any sign-in method: protected, so the email never changes either.
    let otto = t.scim(Method::POST, "/Users", Some(json!({ "userName": "otto@mueller.example" })), &token).await.id();
    let r = t.owner(Method::PATCH, &format!("/members/{otto}"), Some(json!({ "role": "owner" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.scim(Method::PATCH, &format!("/Users/{otto}"), Some(new_mail("mallory3")), &token).await;
    assert_eq!(t.account(&otto).await.0, "otto@mueller.example");

    // A password set by an admin: the same.
    let pit = t.scim(Method::POST, "/Users", Some(json!({ "userName": "pit@mueller.example" })), &token).await.id();
    let r = t.admin(Method::PATCH, &format!("/api/admin/users/{pit}"), Some(json!({ "password": PASSWORD }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.scim(Method::PATCH, &format!("/Users/{pit}"), Some(new_mail("mallory4")), &token).await;
    assert_eq!(t.account(&pit).await.0, "pit@mueller.example");
    t.finish().await;
}
