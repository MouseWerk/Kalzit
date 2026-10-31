//! LDAP sign-in and the directory sync through the real router against a real OpenLDAP server
//! (docs/api/sso.md, "LDAP and Active Directory"): the connection check with its field errors,
//! the provider with its bind password, the sign-in in the password form with the group mapping,
//! the sync with its threshold, "apply anyway" with a fresh second factor, and accounts enabled
//! again.
//!
//! The server comes from the environment (the `ldap` job in CI starts one in a container):
//!
//! - `KALZIT_TEST_LDAP_URL`: `ldap://127.0.0.1:3389`
//! - `KALZIT_TEST_LDAP_BASE`: `dc=kalzit,dc=test`
//! - `KALZIT_TEST_LDAP_ADMIN_DN`, `KALZIT_TEST_LDAP_ADMIN_PASSWORD`: an account that may add and
//!   remove entries below the base
//!
//! Without them the test is skipped with a notice, unless `KALZIT_TEST_REQUIRE_LDAP=1`. Every run
//! works below an `ou` of its own and removes it at the end.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::auth::totp;
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use ldap3::{Ldap, LdapConnAsync, Mod, Scope};
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const START_MS: i64 = 1_800_000_000_000;

struct Env {
    url: String,
    base: String,
    admin_dn: String,
    admin_password: String,
}

fn env() -> Option<Env> {
    let get = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    match (
        get("KALZIT_TEST_LDAP_URL"),
        get("KALZIT_TEST_LDAP_BASE"),
        get("KALZIT_TEST_LDAP_ADMIN_DN"),
        get("KALZIT_TEST_LDAP_ADMIN_PASSWORD"),
    ) {
        (Some(url), Some(base), Some(admin_dn), Some(admin_password)) => {
            Some(Env { url, base, admin_dn, admin_password })
        }
        _ if std::env::var("KALZIT_TEST_REQUIRE_LDAP").is_ok_and(|v| v == "1") => {
            panic!("KALZIT_TEST_LDAP_* are not set, but KALZIT_TEST_REQUIRE_LDAP=1 requires them")
        }
        _ => {
            eprintln!("KALZIT_TEST_LDAP_URL not set, test not run");
            None
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The directory

struct Dir {
    ldap: Ldap,
    ou: String,
}

fn set(values: &[&str]) -> HashSet<String> {
    values.iter().map(|v| v.to_string()).collect()
}

impl Dir {
    async fn open(env: &Env) -> Dir {
        let (conn, mut ldap) = LdapConnAsync::new(&env.url).await.expect("the test directory answers");
        tokio::spawn(async move {
            let _ = conn.drive().await;
        });
        ldap.simple_bind(&env.admin_dn, &env.admin_password).await.unwrap().success().unwrap();
        let ou = format!("ou=kalzit-{},{}", uuid::Uuid::now_v7().simple(), env.base);
        let mut dir = Dir { ldap, ou };
        let (top, name) = (dir.ou.clone(), dir.name().to_string());
        dir.add(&top, &[("objectClass", &["organizationalUnit"]), ("ou", &[&name])]).await;
        let people = dir.people();
        dir.add(&people, &[("objectClass", &["organizationalUnit"]), ("ou", &["people"])]).await;
        let groups = dir.groups();
        dir.add(&groups, &[("objectClass", &["organizationalUnit"]), ("ou", &["groups"])]).await;
        let gone = dir.gone();
        dir.add(&gone, &[("objectClass", &["organizationalUnit"]), ("ou", &["gone"])]).await;
        dir
    }

    fn name(&self) -> &str {
        self.ou.trim_start_matches("ou=").split(',').next().unwrap()
    }

    fn people(&self) -> String {
        format!("ou=people,{}", self.ou)
    }

    fn groups(&self) -> String {
        format!("ou=groups,{}", self.ou)
    }

    /// Outside the base DN of people: an entry moved here keeps its `entryUUID`.
    fn gone(&self) -> String {
        format!("ou=gone,{}", self.ou)
    }

    fn person_dn(&self, uid: &str) -> String {
        format!("uid={uid},{}", self.people())
    }

    fn group_dn(&self, cn: &str) -> String {
        format!("cn={cn},{}", self.groups())
    }

    async fn add(&mut self, dn: &str, attrs: &[(&str, &[&str])]) {
        let attrs: Vec<(String, HashSet<String>)> = attrs.iter().map(|(k, v)| (k.to_string(), set(v))).collect();
        self.ldap.add(dn, attrs).await.unwrap().success().unwrap_or_else(|e| panic!("adding {dn}: {e}"));
    }

    async fn person(&mut self, uid: &str, name: &str, password: &str) {
        let dn = self.person_dn(uid);
        let mail = format!("{uid}@kalzit.test");
        self.add(
            &dn,
            &[
                ("objectClass", &["inetOrgPerson"]),
                ("uid", &[uid]),
                ("cn", &[name]),
                ("sn", &[name]),
                ("mail", &[&mail]),
                ("userPassword", &[password]),
            ],
        )
        .await;
    }

    async fn group(&mut self, cn: &str, members: &[String]) {
        let dn = self.group_dn(cn);
        let mut list: Vec<&str> = members.iter().map(String::as_str).collect();
        // A groupOfNames needs a member.
        let nobody = format!("cn=nobody,{}", self.ou);
        list.push(&nobody);
        self.add(&dn, &[("objectClass", &["groupOfNames"]), ("cn", &[cn]), ("member", &list)]).await;
    }

    async fn remove_member(&mut self, cn: &str, member: &str) {
        let dn = self.group_dn(cn);
        self.ldap
            .modify(&dn, vec![Mod::Delete("member".to_string(), set(&[member]))])
            .await
            .unwrap()
            .success()
            .unwrap();
    }

    /// Moves the person `uid` below `to`.
    async fn move_person(&mut self, uid: &str, from: &str, to: &str) {
        let dn = format!("uid={uid},{from}");
        self.ldap.modifydn(&dn, &format!("uid={uid}"), true, Some(to)).await.unwrap().success().unwrap();
    }

    /// Removes everything below and including the run's `ou`.
    async fn clean(mut self) {
        let (entries, _) = self
            .ldap
            .search(&self.ou, Scope::Subtree, "(objectClass=*)", vec!["1.1"])
            .await
            .unwrap()
            .success()
            .unwrap();
        let mut dns: Vec<String> = entries.into_iter().map(|e| ldap3::SearchEntry::construct(e).dn).collect();
        // Deepest first.
        dns.sort_by_key(|d| std::cmp::Reverse(d.matches(',').count()));
        for dn in dns {
            let _ = self.ldap.delete(&dn).await;
        }
        let _ = self.ldap.unbind().await;
    }
}

// ---------------------------------------------------------------------------------------------
// The app

struct TestApp {
    app: Router,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    clock: Arc<ManualClock>,
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
    text: String,
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    fn field(&self) -> &str {
        self.body["error"]["field"].as_str().unwrap_or("")
    }

    /// `name=value` of the cookie `name` this answer sets.
    fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .filter(|v| v.split_once('=').is_some_and(|(n, value)| n == name && !value.is_empty()))
            .map(str::to_string)
            .next()
    }

    fn session(&self) -> String {
        let value = self
            .headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .filter_map(|v| v.split_once('='))
            .find(|(n, _)| *n == "kalzit_session")
            .map(|(_, v)| v.to_string())
            .expect("a session cookie");
        format!("kalzit_session={value}")
    }
}

async fn test_app() -> TestApp {
    test_app_with(10).await
}

/// The app, with `failures` wrong sign-ins allowed per budget.
async fn test_app_with(failures: u32) -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.security.login_max_failures = failures;
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3999".into();
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(START_MS));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), state, dir: Arc::new(dir), clock }
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
        self.send_with(self.app.clone(), method, path, body, cookie).await
    }

    /// A sign-in from the client address `ip`, so the budgets of an address and its network start
    /// fresh and only those of the login and the directory entry carry over.
    async fn login_from(&self, ip: &str, login: &str, password: &str) -> Reply {
        let peer: SocketAddr = format!("{ip}:50000").parse().unwrap();
        let app = router(self.state.clone()).layer(MockConnectInfo(peer));
        let body = json!({ "email": login, "password": password });
        self.send_with(app, Method::POST, "/api/auth/login", Some(body), None).await
    }

    async fn send_with(
        &self,
        app: Router,
        method: Method,
        path: &str,
        body: Option<Value>,
        cookie: Option<&str>,
    ) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = app.oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        Reply { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), text }
    }

    async fn get(&self, path: &str, cookie: &str) -> Reply {
        self.send(Method::GET, path, None, Some(cookie)).await
    }

    async fn post(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::POST, path, Some(body), Some(cookie)).await
    }

    async fn put(&self, path: &str, body: Value, cookie: &str) -> Reply {
        self.send(Method::PUT, path, Some(body), Some(cookie)).await
    }

    async fn login(&self, login: &str, password: &str) -> Reply {
        self.send(Method::POST, "/api/auth/login", Some(json!({ "email": login, "password": password })), None).await
    }

    async fn setup(&self) -> (String, String, String) {
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
        (r.session(), r.body["id"].as_str().unwrap().into(), r.body["orgs"][0]["id"].as_str().unwrap().into())
    }

    async fn role(&self, org_id: &str, email: &str) -> Option<String> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT m.role FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2",
        )
        .bind(org_id)
        .bind(email)
        .fetch_optional(&self.state.db)
        .await
        .unwrap();
        row.map(|(r,)| r)
    }

    /// Sets up an authenticator app for the signed-in `session`; answers its key. The code that
    /// confirmed it is used, so the clock moves on a step.
    async fn enroll_totp(&self, session: &str) -> Vec<u8> {
        let r = self.post("/api/me/security/totp/setup", json!({}), session).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let secret = totp::decode_secret(&r.body["secret"].as_str().unwrap().replace(' ', "")).unwrap();
        let r = self.post("/api/me/security/totp", json!({ "code": self.code(&secret) }), session).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        self.clock.advance_ms(totp::STEP_SECS * 1000);
        secret
    }

    fn code(&self, secret: &[u8]) -> String {
        totp::code_at(secret, totp::step_at(self.clock.now_ms()))
    }

    /// The second step of a sign-in with the app's code.
    async fn second_step(&self, pending: &str, secret: &[u8]) -> Reply {
        let body = json!({ "method": "totp", "code": self.code(secret) });
        self.send(Method::POST, "/api/auth/second-factor", Some(body), Some(pending)).await
    }

    async fn disabled(&self, email: &str) -> bool {
        let (d,): (i64,) = sqlx::query_as("SELECT disabled FROM users WHERE email = $1")
            .bind(email)
            .fetch_one(&self.state.db)
            .await
            .unwrap();
        d != 0
    }
}

fn form(env: &Env, dir: &Dir, password: Option<&str>) -> Value {
    let mut ldap = json!({
        "flavor": "ldap", "url": env.url, "encryption": "none", "bindDn": env.admin_dn,
        "userBaseDn": dir.people(), "groupBaseDn": dir.groups(), "loginAttribute": "uid",
        "syncSchedule": "off", "syncThreshold": 10,
    });
    if let Some(p) = password {
        ldap["bindPassword"] = json!(p);
    }
    json!({ "kind": "ldap", "slug": "zentrale", "name": "Verzeichnis Zentrale", "ldap": ldap })
}

#[tokio::test]
async fn ldap_sign_in_sync_and_threshold() {
    let Some(env) = env() else { return };
    let mut dir = Dir::open(&env).await;
    dir.person("anna", "Anna Admin", "anna-geheim-1").await;
    dir.person("ben", "Ben Leser", "ben-geheim-2").await;
    dir.person("carl", "Carl Ohnegruppe", "carl-geheim-3").await;
    dir.person("dora", "Dora Leser", "dora-geheim-4").await;
    let (anna, ben, dora) = (dir.person_dn("anna"), dir.person_dn("ben"), dir.person_dn("dora"));
    dir.group("kalzit-admins", std::slice::from_ref(&anna)).await;
    dir.group("kalzit-readers", &[ben.clone(), dora.clone(), anna.clone()]).await;
    let app = test_app().await;
    let (admin, admin_id, org) = app.setup().await;

    // The check, step by step, with the error at its field.
    let mut wrong = form(&env, &dir, Some("falsch"));
    let r = app.post("/api/admin/sign-in/ldap/check", wrong.clone(), &admin).await;
    assert_eq!(
        (r.status, r.field(), r.reason()),
        (StatusCode::UNPROCESSABLE_ENTITY, "bindPassword", "ldap.bind_failed")
    );
    assert_eq!(r.body["error"]["params"]["code"], "49");
    wrong["ldap"]["bindPassword"] = json!(env.admin_password);
    wrong["ldap"]["userBaseDn"] = json!(format!("ou=missing,{}", dir.ou));
    let r = app.post("/api/admin/sign-in/ldap/check", wrong.clone(), &admin).await;
    assert_eq!((r.field(), r.reason()), ("userBaseDn", "ldap.base_not_found"), "{}", r.body);
    // Unencrypted only to this computer or a private network; never to a public address.
    let mut public = form(&env, &dir, Some(&env.admin_password));
    public["ldap"]["url"] = json!("ldap://8.8.8.8:389");
    let r = app.post("/api/admin/sign-in/ldap/check", public, &admin).await;
    assert_eq!((r.field(), r.reason()), ("url", "ldap.plain_not_allowed"), "{}", r.body);
    let mut conflict = form(&env, &dir, Some(&env.admin_password));
    conflict["ldap"]["encryption"] = json!("ldaps");
    let r = app.post("/api/admin/sign-in/ldap/check", conflict, &admin).await;
    assert_eq!((r.field(), r.reason()), ("encryption", "ldap.scheme_conflict"));
    let mut test = form(&env, &dir, Some(&env.admin_password));
    test["testLogin"] = json!("anna");
    test["testPassword"] = json!("nicht-annas");
    let r = app.post("/api/admin/sign-in/ldap/check", test.clone(), &admin).await;
    assert_eq!((r.field(), r.reason()), ("testPassword", "ldap.test_bind_failed"), "{}", r.body);
    test["testPassword"] = json!("anna-geheim-1");
    let r = app.post("/api/admin/sign-in/ldap/check", test, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["test"]["bound"], true);
    assert_eq!(r.body["test"]["login"], "anna");
    let groups: Vec<String> = serde_json::from_value(r.body["test"]["groups"].clone()).unwrap();
    assert!(groups.contains(&dir.group_dn("kalzit-admins")), "{groups:?}");
    assert!(r.body["sample"]["users"].as_array().unwrap().len() >= 3);
    let token = r.body["checkToken"].as_str().unwrap().to_string();

    // Saving needs a check of these values; the password is stored and never sent back.
    let r = app.post("/api/admin/sign-in/ldap", form(&env, &dir, Some(&env.admin_password)), &admin).await;
    assert_eq!(r.reason(), "ldap.check_required");
    let mut body = form(&env, &dir, Some(&env.admin_password));
    body["checkToken"] = json!(token);
    let r = app.post("/api/admin/sign-in/ldap", body, &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["ldap"]["bindPasswordSet"], true);
    assert!(!r.text.contains(&env.admin_password));
    let provider = r.body["id"].as_str().unwrap().to_string();
    let r = app.get(&format!("/api/admin/sign-in/providers/{provider}"), &admin).await;
    assert_eq!(r.body["kind"], "ldap");
    assert!(!r.text.contains(&env.admin_password));
    let r = app.send(Method::GET, "/api/auth/providers", None, None).await;
    assert_eq!(r.body["providers"][0]["kind"], "ldap");
    // The OpenID Connect route refuses an LDAP provider.
    let r = app
        .put(
            &format!("/api/admin/sign-in/providers/{provider}"),
            json!({ "slug": "zentrale", "name": "x",
        "oidc": { "issuer": "https://x.example", "clientId": "c" }, "version": 1 }),
            &admin,
        )
        .await;
    assert_eq!(r.reason(), "sso.kind_mismatch");

    // Groups map to roles, the highest wins; people without a mapped group are refused.
    for (group, role) in [("kalzit-admins", "admin"), ("kalzit-readers", "viewer")] {
        let r = app
            .post(
                "/api/admin/sign-in/mappings",
                json!({ "providerId": provider, "group": dir.group_dn(group),
                  "orgId": org, "role": role, "idpDecides": true }),
                &admin,
            )
            .await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    }
    let r = app.put("/api/admin/sign-in/unmapped", json!({ "rule": "refuse", "defaultRole": "viewer" }), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // Signing in: a wrong password, a wildcard and an empty password never get in.
    assert_eq!(app.login("anna", "falsch").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.login("*", "anna-geheim-1").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.login("anna", "").await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.login("an*", "anna-geheim-1").await.status, StatusCode::UNAUTHORIZED);
    let r = app.login("anna", "anna-geheim-1").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["email"], "anna@kalzit.test");
    assert_eq!(app.role(&org, "anna@kalzit.test").await.as_deref(), Some("admin"));
    // By address too.
    assert_eq!(app.login("ben@kalzit.test", "ben-geheim-2").await.status, StatusCode::OK);
    assert_eq!(app.role(&org, "ben@kalzit.test").await.as_deref(), Some("viewer"));
    let ben_session = app.login("ben", "ben-geheim-2").await.session();
    assert_eq!(app.get("/api/me", &ben_session).await.status, StatusCode::OK);
    assert_eq!(app.login("dora", "dora-geheim-4").await.status, StatusCode::OK);
    let r = app.login("carl", "carl-geheim-3").await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "ldap.sign_in_refused"), "{}", r.body);
    assert_eq!(r.body["error"]["params"]["outcome"], "unmapped");
    // The local owner still signs in with the password.
    assert_eq!(app.login("joerg@example.de", PASSWORD).await.status, StatusCode::OK);

    // Carl's account exists (made at his first sign-in) but has no mapped group under "refuse",
    // and Ben leaves the base DN: two of four accounts is more than 10 %, so the sync halts.
    let (people, gone) = (dir.people(), dir.gone());
    dir.move_person("ben", &people, &gone).await;
    let sync = format!("/api/admin/sign-in/providers/{provider}/sync");
    let r = app.post(&sync, json!({}), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["status"], "halted", "{}", r.body);
    assert_eq!((r.body["wouldDeactivate"].as_i64(), r.body["accounts"].as_i64()), (Some(2), Some(4)));
    assert!(!app.disabled("ben@kalzit.test").await, "a halted sync changes nothing");
    let run = r.body["id"].as_str().unwrap().to_string();
    let r = app.get(&format!("{sync}/runs/{run}"), &admin).await;
    let pending: Vec<(String, String)> = r.body["pending"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["email"].as_str().unwrap().to_string(), p["reason"].as_str().unwrap().to_string()))
        .collect();
    assert!(pending.contains(&("ben@kalzit.test".into(), "not_in_directory".into())), "{pending:?}");
    assert!(pending.contains(&("carl@kalzit.test".into(), "no_mapped_group".into())), "{pending:?}");

    // "Apply anyway" needs a second factor, confirmed in this session just now.
    let apply = format!("{sync}/runs/{run}/apply");
    let r = app.post(&apply, json!({}), &admin).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "ldap.sync_needs_second_factor"));
    sqlx::query(
        "INSERT INTO user_totp (user_id, key_id, nonce, ciphertext, last_step, created_at) VALUES ($1, 'k', 'n', 'c', 0, 0)",
    )
    .bind(&admin_id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let r = app.post(&apply, json!({}), &admin).await;
    assert_eq!((r.status, r.body["error"]["code"].as_str()), (StatusCode::FORBIDDEN, Some("confirmation_required")));
    sqlx::query("UPDATE sessions SET second_factor_at = $1 WHERE user_id = $2")
        .bind(START_MS)
        .bind(&admin_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let r = app.post(&apply, json!({}), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["status"].as_str(), r.body["deactivated"].as_i64()), (Some("done"), Some(2)), "{}", r.body);
    assert!(app.disabled("ben@kalzit.test").await);
    assert_eq!(app.get("/api/me", &ben_session).await.status, StatusCode::UNAUTHORIZED, "the sync ends the sessions");
    let r = app.post(&apply, json!({}), &admin).await;
    assert_eq!(r.reason(), "ldap.sync_not_halted");
    let r = app.get(&sync, &admin).await;
    assert_eq!(r.body["deactivated"][0]["reason"], "not_in_directory");
    assert_eq!(r.body["runs"][1]["status"], "applied");
    assert_eq!(app.login("ben", "ben-geheim-2").await.status, StatusCode::UNAUTHORIZED);

    // Back below the base DN (with the same entry, so the same id, and still in his group): the
    // next sync enables the account again. Dora leaves every mapped group under "refuse"; a
    // higher threshold lets the sync disable her.
    dir.move_person("ben", &gone, &people).await;
    let r = app.get(&format!("/api/admin/sign-in/providers/{provider}"), &admin).await;
    let mut body = form(&env, &dir, None);
    body["ldap"]["syncThreshold"] = json!(50);
    body["version"] = r.body["version"].clone();
    let r = app.put(&format!("/api/admin/sign-in/ldap/{provider}"), body, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    dir.remove_member("kalzit-readers", &dora).await;
    let r = app.post(&sync, json!({}), &admin).await;
    assert_eq!(r.body["status"], "done", "{}", r.body);
    assert_eq!((r.body["reactivated"].as_i64(), r.body["deactivated"].as_i64()), (Some(1), Some(1)), "{}", r.body);
    assert!(!app.disabled("ben@kalzit.test").await);
    assert!(app.disabled("dora@kalzit.test").await);
    let r = app.get(&sync, &admin).await;
    let reasons: Vec<&str> =
        r.body["deactivated"].as_array().unwrap().iter().filter_map(|d| d["reason"].as_str()).collect();
    assert_eq!(reasons, ["no_mapped_group", "no_mapped_group"], "Carl and Dora: {}", r.body);
    // Back in a mapped group, a sign-in enables her at once.
    let group = dir.group_dn("kalzit-readers");
    dir.ldap.modify(&group, vec![Mod::Add("member".to_string(), set(&[&dora]))]).await.unwrap().success().unwrap();
    let r = app.login("dora", "dora-geheim-4").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(!app.disabled("dora@kalzit.test").await);
    // An account an admin disabled stays disabled, whatever the directory says.
    sqlx::query("UPDATE users SET disabled = 1 WHERE email = 'anna@kalzit.test'").execute(&app.state.db).await.unwrap();
    let r = app.post(&sync, json!({}), &admin).await;
    assert_eq!(r.body["status"], "done", "{}", r.body);
    assert!(app.disabled("anna@kalzit.test").await);

    let actions: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
        .fetch_all(&app.state.db)
        .await
        .unwrap();
    let actions: Vec<String> = actions.into_iter().map(|(a,)| a).collect();
    for expected in ["ldap.sync_halted", "ldap.sync_applied", "ldap.sync_finished", "user.disabled", "auth.sso_failed"]
    {
        assert!(actions.iter().any(|a| a == expected), "{expected} in {actions:?}");
    }
    app.finish().await;
    dir.clean().await;
}

/// Creates the provider of `form` (checked first) and answers its id.
async fn create_provider(app: &TestApp, admin: &str, mut body: Value) -> String {
    let r = app.post("/api/admin/sign-in/ldap/check", body.clone(), admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    body["checkToken"] = r.body["checkToken"].clone();
    let r = app.post("/api/admin/sign-in/ldap", body, admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

/// Adds a local account straight to the database: `(id, email, admin, confirmed, service)`.
async fn local_account(app: &TestApp, email: &str, admin: bool, confirmed: bool, service: bool) -> String {
    let id = uuid::Uuid::now_v7().to_string();
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, email_confirmed, \
         service_account) VALUES ($1, $2, 'Lokal', 'x', $3, 0, 0, $4, $5)",
    )
    .bind(&id)
    .bind(email)
    .bind(i64::from(admin))
    .bind(i64::from(confirmed))
    .bind(i64::from(service))
    .execute(&app.state.db)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn ldap_budgets_email_links_and_admin_decisions() {
    let Some(env) = env() else { return };
    let mut dir = Dir::open(&env).await;
    for uid in ["conf", "unconf", "adm", "bg", "svc", "gina", "hans", "ida", "jo", "kai"] {
        dir.person(uid, &format!("Person {uid}"), &format!("{uid}-geheim-1")).await;
    }
    // Three wrong sign-ins per budget.
    let app = test_app_with(3).await;
    let (admin, admin_id, org) = app.setup().await;
    let mut body = form(&env, &dir, Some(&env.admin_password));
    body["ldap"]["syncThreshold"] = json!(100);
    let provider = create_provider(&app, &admin, body).await;
    let r = app
        .put(
            "/api/admin/sign-in/unmapped",
            json!({ "rule": "default", "defaultOrgId": org,
        "defaultRole": "viewer" }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // Linking by email: off by default, and even on never to an unconfirmed account, a server
    // admin, the break-glass admin or a service account.
    let conf = local_account(&app, "conf@kalzit.test", false, true, false).await;
    local_account(&app, "unconf@kalzit.test", false, false, false).await;
    local_account(&app, "adm@kalzit.test", true, true, false).await;
    let bg = local_account(&app, "bg@kalzit.test", true, true, false).await;
    local_account(&app, "svc@kalzit.test", false, true, true).await;
    let r = app
        .put(
            "/api/admin/sign-in/local",
            json!({ "localPassword": "on", "passwordForm": "collapsed",
             "breakGlassUserId": bg }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Without the server admin role, so the break-glass rule alone refuses the link.
    sqlx::query("UPDATE users SET is_server_admin = 0 WHERE id = $1").bind(&bg).execute(&app.state.db).await.unwrap();
    let refused = |r: &Reply| (r.status, r.reason().to_string(), r.body["error"]["params"]["outcome"].clone());
    let taken = (StatusCode::FORBIDDEN, "ldap.sign_in_refused".to_string(), json!("email_taken"));
    assert_eq!(refused(&app.login("conf", "conf-geheim-1").await), taken, "trustEmail is off by default");
    let r = app.get(&format!("/api/admin/sign-in/providers/{provider}"), &admin).await;
    assert_eq!(r.body["ldap"]["trustEmail"], false);
    let mut body = form(&env, &dir, None);
    body["ldap"]["syncThreshold"] = json!(100);
    body["ldap"]["trustEmail"] = json!(true);
    body["version"] = r.body["version"].clone();
    let r = app.put(&format!("/api/admin/sign-in/ldap/{provider}"), body, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = app.login("conf", "conf-geheim-1").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["id"], conf.as_str(), "linked to the confirmed local account");
    for uid in ["unconf", "adm", "bg", "svc"] {
        assert_eq!(refused(&app.login(uid, &format!("{uid}-geheim-1")).await), taken, "{uid}");
    }

    // A changed password connection needs the password again: a stored one never goes out over a
    // weaker connection.
    let r = app.get(&format!("/api/admin/sign-in/providers/{provider}"), &admin).await;
    let mut weaker = form(&env, &dir, None);
    weaker["ldap"]["encryption"] = json!("starttls");
    weaker["providerId"] = json!(provider);
    weaker["version"] = r.body["version"].clone();
    let r = app.post("/api/admin/sign-in/ldap/check", weaker, &admin).await;
    assert_eq!((r.field(), r.reason()), ("bindPassword", "ldap.bind_password_required"), "{}", r.body);

    // An admin's decision wins over the sync: disabled by the sync, enabled and disabled again by
    // an admin, the account stays disabled when the directory says it is fine.
    assert_eq!(app.login("gina", "gina-geheim-1").await.status, StatusCode::OK);
    let (people, gone) = (dir.people(), dir.gone());
    dir.move_person("gina", &people, &gone).await;
    let sync = format!("/api/admin/sign-in/providers/{provider}/sync");
    let r = app.post(&sync, json!({}), &admin).await;
    assert_eq!((r.body["status"].as_str(), r.body["deactivated"].as_i64()), (Some("done"), Some(1)), "{}", r.body);
    let (gina,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'gina@kalzit.test'").fetch_one(&app.state.db).await.unwrap();
    let user = format!("/api/admin/users/{gina}");
    for disabled in [false, true] {
        let r = app.send(Method::PATCH, &user, Some(json!({ "disabled": disabled })), Some(&admin)).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }
    dir.move_person("gina", &gone, &people).await;
    let r = app.post(&sync, json!({}), &admin).await;
    assert_eq!((r.body["status"].as_str(), r.body["reactivated"].as_i64()), (Some("done"), Some(0)), "{}", r.body);
    assert!(app.disabled("gina@kalzit.test").await);
    let r = app.login("gina", "gina-geheim-1").await;
    assert_eq!(r.body["error"]["params"]["outcome"], "disabled", "{}", r.body);
    assert!(app.disabled("gina@kalzit.test").await);

    // With a second factor, a sign-in enables an account the sync disabled only after that step.
    let r = app.login("hans", "hans-geheim-1").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let hans = app.enroll_totp(&r.session()).await;
    dir.move_person("hans", &people, &gone).await;
    assert_eq!(app.post(&sync, json!({}), &admin).await.body["deactivated"], 1);
    dir.move_person("hans", &gone, &people).await;
    let r = app.login("hans", "hans-geheim-1").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["secondFactor"].is_object(), "{}", r.body);
    assert!(app.disabled("hans@kalzit.test").await, "enabled only after the second factor");
    let r = app.second_step(&r.cookie("kalzit_pending").expect("a pending cookie"), &hans).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(!app.disabled("hans@kalzit.test").await, "enabled once the second factor succeeded");
    assert_eq!(app.get("/api/me", &r.session()).await.status, StatusCode::OK);

    // An account an admin disabled is refused before any second step.
    let r = app.login("jo", "jo-geheim-1").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let jo_id = r.body["id"].as_str().unwrap().to_string();
    app.enroll_totp(&r.session()).await;
    let user = format!("/api/admin/users/{jo_id}");
    let r = app.send(Method::PATCH, &user, Some(json!({ "disabled": true })), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = app.login("jo", "jo-geheim-1").await;
    assert_eq!((r.status, r.body["error"]["params"]["outcome"].as_str()), (StatusCode::FORBIDDEN, Some("disabled")));
    assert!(r.cookie("kalzit_pending").is_none() && r.body["secondFactor"].is_null(), "no second step");

    // A second step started while the account was enabled, finished after the sync disabled it:
    // refused, and the account stays disabled.
    let r = app.login("kai", "kai-geheim-1").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let kai = app.enroll_totp(&r.session()).await;
    let r = app.login("kai", "kai-geheim-1").await;
    assert!(r.body["secondFactor"].is_object(), "{}", r.body);
    let pending = r.cookie("kalzit_pending").expect("a pending cookie");
    dir.move_person("kai", &people, &gone).await;
    assert_eq!(app.post(&sync, json!({}), &admin).await.body["deactivated"], 1);
    let r = app.second_step(&pending, &kai).await;
    assert_ne!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.cookie("kalzit_session").is_none());
    assert!(app.disabled("kai@kalzit.test").await, "a stale second step never enables the account");

    // One budget for every spelling of a login: after three wrong passwords for the address
    // (each from another network, so only the login's and the entry's budgets carry over), the
    // name with the right password is refused too, since it names the same directory entry.
    for (i, typed) in ["ida@kalzit.test", "IDA@kalzit.test", "ida@kalzit.test"].iter().enumerate() {
        let r = app.login_from(&format!("10.{i}.1.1"), typed, "falsch").await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{}", r.body);
    }
    let r = app.login_from("10.9.1.1", "ida", "ida-geheim-1").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);
    let r = app.login_from("10.10.1.1", "IDA", "ida-geheim-1").await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);

    // A directory that cannot be reached answers the same whether or not a local account has the
    // login, so the answer never tells which local accounts exist.
    let port = env.url.rsplit(':').next().unwrap().to_string();
    sqlx::query("UPDATE sso_providers SET config = replace(config, $1, ':9\"') WHERE id = $2")
        .bind(format!(":{port}\""))
        .bind(&provider)
        .execute(&app.state.db)
        .await
        .unwrap();
    let local = app.login_from("10.20.1.1", "joerg@example.de", "falsch").await;
    let unknown = app.login_from("10.21.1.1", "niemand@example.de", "falsch").await;
    assert_eq!((local.status, local.reason()), (StatusCode::SERVICE_UNAVAILABLE, "ldap.directory_unreachable"));
    assert_eq!((unknown.status, unknown.reason()), (local.status, local.reason()));
    // The owner still signs in with the right password.
    assert_eq!(app.login_from("10.22.1.1", "joerg@example.de", PASSWORD).await.status, StatusCode::OK);
    let _ = admin_id;
    app.finish().await;
    dir.clean().await;
}

#[test]
fn logins_count_without_domain_and_case() {
    assert_eq!(kalzit::routes::auth::login_key(" ZENTRALE\\Anna "), "anna");
    assert_eq!(kalzit::routes::auth::login_key("Anna@Example.DE"), "anna@example.de");
    assert_eq!(kalzit::routes::auth::login_key("a\\b\\C"), "c");
    assert_eq!(kalzit::routes::auth::login_key("DOM\\anna"), "anna");
    // An address with a backslash stays the address.
    assert_eq!(kalzit::routes::auth::login_key("a\\b@x.de"), "a\\b@x.de");
    assert_eq!(kalzit::routes::auth::login_key(" A\\B@X.de "), "a\\b@x.de");
}
