//! Single sign-on through the real router against a small in-process OpenID Connect provider:
//! the connection check, the sign-in with state, nonce and PKCE, ID token validation with key
//! rotation, accounts, the group mapping, test sign-ins, and the local sign-in with its
//! break-glass admin (docs/api/sso.md).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::extract::{Form, State};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const CLIENT_ID: &str = "kalzit";
const CLIENT_SECRET: &str = "geheimes-client-secret-4711";
const START_MS: i64 = 1_800_000_000_000;

// ---------------------------------------------------------------------------------------------
// The fake provider

struct Key {
    pair: EcdsaKeyPair,
    kid: String,
}

impl Key {
    fn new(kid: &str) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        Self {
            pair: EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap(),
            kid: kid.into(),
        }
    }

    fn jwk(&self) -> Value {
        let p = self.pair.public_key().as_ref();
        json!({ "kty": "EC", "crv": "P-256", "kid": self.kid, "use": "sig", "alg": "ES256",
                "x": URL_SAFE_NO_PAD.encode(&p[1..33]), "y": URL_SAFE_NO_PAD.encode(&p[33..65]) })
    }

    fn sign(&self, claims: &Value) -> String {
        let header = json!({ "alg": "ES256", "typ": "JWT", "kid": self.kid });
        let signed =
            format!("{}.{}", URL_SAFE_NO_PAD.encode(header.to_string()), URL_SAFE_NO_PAD.encode(claims.to_string()));
        let sig = self.pair.sign(&SystemRandom::new(), signed.as_bytes()).unwrap();
        format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()))
    }
}

/// A code the provider handed out: what its token request must bring and what it answers.
struct Grant {
    challenge: Option<String>,
    redirect_uri: String,
    claims: Value,
    userinfo: Value,
}

#[derive(Default)]
struct IdpState {
    issuer: String,
    keys: Vec<Arc<Key>>,
    signer: Option<Arc<Key>>,
    grants: HashMap<String, Grant>,
    tokens: HashMap<String, Value>,
    jwks_reads: usize,
}

type Idp = Arc<Mutex<IdpState>>;

async fn discovery(State(idp): State<Idp>) -> axum::Json<Value> {
    let issuer = idp.lock().unwrap().issuer.clone();
    axum::Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": format!("{issuer}/token"),
        "userinfo_endpoint": format!("{issuer}/userinfo"),
        "jwks_uri": format!("{issuer}/jwks"),
        "token_endpoint_auth_methods_supported": ["client_secret_basic"],
    }))
}

async fn jwks(State(idp): State<Idp>) -> axum::Json<Value> {
    let mut idp = idp.lock().unwrap();
    idp.jwks_reads += 1;
    axum::Json(json!({ "keys": idp.keys.iter().map(|k| k.jwk()).collect::<Vec<_>>() }))
}

async fn token(
    State(idp): State<Idp>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> (StatusCode, axum::Json<Value>) {
    let expected = format!("Basic {}", STANDARD.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}")));
    if headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) != Some(expected.as_str()) {
        return (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": "invalid_client" })));
    }
    let mut idp = idp.lock().unwrap();
    let invalid = (StatusCode::BAD_REQUEST, axum::Json(json!({ "error": "invalid_grant" })));
    let Some(grant) = form.get("code").and_then(|c| idp.grants.remove(c)) else { return invalid };
    if form.get("redirect_uri") != Some(&grant.redirect_uri) {
        return invalid;
    }
    if let Some(challenge) = &grant.challenge {
        let verifier = form.get("code_verifier").cloned().unwrap_or_default();
        if &URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) != challenge {
            return invalid;
        }
    }
    let id_token = idp.signer.as_ref().unwrap().sign(&grant.claims);
    let access = format!("at-{}", idp.tokens.len());
    idp.tokens.insert(access.clone(), grant.userinfo);
    (StatusCode::OK, axum::Json(json!({ "id_token": id_token, "access_token": access, "token_type": "Bearer" })))
}

async fn userinfo(State(idp): State<Idp>, headers: HeaderMap) -> (StatusCode, axum::Json<Value>) {
    let token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or_default();
    match idp.lock().unwrap().tokens.get(token.trim_start_matches("Bearer ")) {
        Some(info) => (StatusCode::OK, axum::Json(info.clone())),
        None => (StatusCode::UNAUTHORIZED, axum::Json(json!({}))),
    }
}

#[expect(clippy::disallowed_methods, reason = "a fake identity provider, not an API route")]
async fn fake_idp() -> Idp {
    let key = Arc::new(Key::new("k1"));
    let idp: Idp = Arc::new(Mutex::new(IdpState { keys: vec![key.clone()], signer: Some(key), ..IdpState::default() }));
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(discovery))
        .route("/jwks", get(jwks))
        .route("/token", post(token))
        .route("/userinfo", get(userinfo))
        .with_state(idp.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    idp.lock().unwrap().issuer = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    idp
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
}

impl Reply {
    fn reason(&self) -> &str {
        self.body["error"]["reason"].as_str().unwrap_or("")
    }

    fn location(&self) -> String {
        self.headers.get(header::LOCATION).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default()
    }

    /// The value of the cookie `name` this answer sets.
    fn cookie(&self, name: &str) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .filter_map(|v| v.split(';').next())
            .filter_map(|v| v.split_once('='))
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.to_string())
            .filter(|v| !v.is_empty())
    }
}

async fn test_app() -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
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
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Reply { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
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

    /// The owner (server admin, with a password): session cookie, user id and organization.
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
        let cookie = format!("kalzit_session={}", r.cookie("kalzit_session").unwrap());
        (cookie, r.body["id"].as_str().unwrap().into(), r.body["orgs"][0]["id"].as_str().unwrap().into())
    }

    async fn audit_actions(&self) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as("SELECT action FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap();
        rows.into_iter().map(|(a,)| a).collect()
    }
}

fn form(issuer: &str, secret: Option<&str>) -> Value {
    let mut oidc =
        json!({ "issuer": issuer, "clientId": CLIENT_ID, "scopes": ["openid", "email", "profile", "groups"] });
    if let Some(s) = secret {
        oidc["clientSecret"] = json!(s);
    }
    json!({ "kind": "oidc", "slug": "mueller-sso", "name": "Müller SSO", "oidc": oidc })
}

/// What a person at the provider is.
struct Who<'a> {
    sub: &'a str,
    email: &'a str,
    verified: bool,
    groups: &'a [&'a str],
}

/// The browser's way through the provider: start (or a test sign-in's URL), the provider's
/// authorization (simulated: it hands out a code for `who`), and the callback. `tamper` changes
/// the ID token's claims. Answers the callback's reply.
async fn through_provider(
    app: &TestApp,
    idp: &Idp,
    authorize: &str,
    binding: &str,
    who: &Who<'_>,
    tamper: impl FnOnce(&mut Value),
) -> (Reply, String) {
    let url = url::Url::parse(authorize).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], CLIENT_ID);
    assert_eq!(q["code_challenge_method"], "S256");
    let now = app.clock.now_ms() / 1000;
    let issuer = idp.lock().unwrap().issuer.clone();
    let mut claims = json!({ "iss": issuer, "aud": CLIENT_ID, "sub": who.sub, "nonce": q["nonce"], "iat": now,
                             "exp": now + 300, "email": who.email, "email_verified": who.verified,
                             "name": "Lea Hoffmann", "amr": ["pwd"] });
    tamper(&mut claims);
    let code = format!("code-{}", q["state"]);
    idp.lock().unwrap().grants.insert(
        code.clone(),
        Grant {
            challenge: Some(q["code_challenge"].clone()),
            redirect_uri: q["redirect_uri"].clone(),
            claims,
            userinfo: json!({ "sub": who.sub, "preferred_username": "l.hoffmann", "groups": who.groups }),
        },
    );
    let redirect = url::Url::parse(&q["redirect_uri"]).unwrap();
    let callback = format!("{}?code={code}&state={}", redirect.path(), q["state"]);
    let reply = app.send(Method::GET, &callback, None, Some(&format!("kalzit_sso={binding}"))).await;
    (reply, callback)
}

/// Starts a sign-in through the provider and goes through it.
async fn sign_in(app: &TestApp, idp: &Idp, who: &Who<'_>, tamper: impl FnOnce(&mut Value)) -> (Reply, String) {
    let start = app.send(Method::GET, "/api/auth/sso/mueller-sso/start?returnTo=/dashboards", None, None).await;
    assert_eq!(start.status, StatusCode::SEE_OTHER, "{}", start.body);
    let binding = start.cookie("kalzit_sso").expect("the start sets the binding cookie");
    through_provider(app, idp, &start.location(), &binding, who, tamper).await
}

fn session_of(reply: &Reply) -> String {
    format!("kalzit_session={}", reply.cookie("kalzit_session").expect("a session cookie"))
}

fn outcome_of(reply: &Reply) -> String {
    let location = reply.location();
    let url = url::Url::parse(&format!("http://x{location}")).unwrap();
    url.query_pairs().find(|(k, _)| k == "sso").map(|(_, v)| v.into_owned()).unwrap_or_else(|| location.clone())
}

#[tokio::test]
async fn oidc_sign_in_with_mapping_and_break_glass() {
    let app = test_app().await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, admin_id, org) = app.setup().await;

    // No provider yet: the sign-in page shows only the password form.
    let r = app.send(Method::GET, "/api/auth/providers", None, None).await;
    assert_eq!(r.body["providers"], json!([]));

    // The connection check finds the discovery and keys and tells a wrong secret apart.
    let r = app.post("/api/admin/sign-in/providers/check", form(&issuer, Some("falsch")), &admin).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!((r.reason(), r.body["error"]["field"].as_str()), ("sso.client_rejected", Some("clientSecret")));
    let r = app.post("/api/admin/sign-in/providers/check", form("https://u:p@idp.example", Some("x")), &admin).await;
    assert_eq!(r.reason(), "sso.issuer_invalid");
    let r = app.post("/api/admin/sign-in/providers/check", form(&format!("{issuer}/other"), Some("x")), &admin).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = app.post("/api/admin/sign-in/providers/check", form(&issuer, Some(CLIENT_SECRET)), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["keys"].as_u64(), r.body["clientAccepted"].as_bool()), (Some(1), Some(true)));
    let token = r.body["checkToken"].as_str().unwrap().to_string();

    // Saving needs the check of exactly these values.
    let r = app.post("/api/admin/sign-in/providers", form(&issuer, Some(CLIENT_SECRET)), &admin).await;
    assert_eq!(r.reason(), "sso.check_required");
    let mut body = form(&issuer, Some("anderes-secret"));
    body["checkToken"] = json!(token);
    assert_eq!(app.post("/api/admin/sign-in/providers", body, &admin).await.reason(), "sso.check_required");
    let mut body = form(&issuer, Some(CLIENT_SECRET));
    body["checkToken"] = json!(token);
    let r = app.post("/api/admin/sign-in/providers", body, &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let provider_id = r.body["id"].as_str().unwrap().to_string();
    assert_eq!(r.body["oidc"]["clientSecretSet"], json!(true));
    assert!(r.body.to_string().find(CLIENT_SECRET).is_none(), "the secret never comes back");
    assert_eq!(r.body["redirectUri"], json!("http://kalzit.test/auth/oidc/mueller-sso/callback"));
    let stored: (String,) =
        sqlx::query_as("SELECT ciphertext FROM sso_provider_secrets").fetch_one(&app.state.db).await.unwrap();
    assert!(!stored.0.contains(CLIENT_SECRET), "the secret is stored encrypted");
    let r = app.send(Method::GET, "/api/auth/providers", None, None).await;
    assert_eq!(r.body["providers"][0], json!({ "slug": "mueller-sso", "name": "Müller SSO", "kind": "oidc" }));

    // Mappings: admins decided by the provider, everyone else at least a viewer.
    let teams = app.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Plattform" }), &admin).await;
    assert_eq!(teams.status, StatusCode::CREATED, "{}", teams.body);
    let team = teams.body["id"].as_str().unwrap().to_string();
    let r = app
        .post(
            "/api/admin/sign-in/mappings",
            json!({ "providerId": provider_id, "group": "kalzit-admins", "orgId": org, "teamId": team,
                    "role": "admin", "idpDecides": true }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let r = app
        .post(
            "/api/admin/sign-in/mappings",
            json!({ "providerId": provider_id, "group": "alle", "orgId": org, "role": "viewer", "idpDecides": false }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let r = app
        .post(
            "/api/admin/sign-in/mappings",
            json!({ "providerId": provider_id, "group": "x", "orgId": org, "role": "owner" }),
            &admin,
        )
        .await;
    assert_eq!(r.reason(), "sso.role_invalid");

    // A new person: the account is created, the mapping applied, the session opens.
    let lea = Who { sub: "sub-lea", email: "lea@example.de", verified: true, groups: &["alle"] };
    let (r, callback) = sign_in(&app, &idp, &lea, |_| {}).await;
    assert_eq!(r.status, StatusCode::SEE_OTHER);
    assert_eq!(r.location(), "/dashboards");
    let lea_session = session_of(&r);
    let me = app.get("/api/me", &lea_session).await;
    assert_eq!(me.body["email"], json!("lea@example.de"));
    assert_eq!(me.body["orgs"][0]["role"], json!("viewer"));
    let actions = app.audit_actions().await;
    assert!(actions.contains(&"auth.sso_account_created".to_string()));
    assert!(actions.contains(&"sso.memberships_changed".to_string()));

    // The same callback again: each start works once.
    let again = app.send(Method::GET, &callback, None, None).await;
    assert_eq!(outcome_of(&again), "expired");
    assert!(again.location().contains("&ref="));

    // A token with the wrong nonce, issuer or audience, or an expired one, is refused.
    for tamper in [
        Box::new(|c: &mut Value| c["nonce"] = json!("fremd")) as Box<dyn FnOnce(&mut Value)>,
        Box::new(|c: &mut Value| c["iss"] = json!("https://evil.example")),
        Box::new(|c: &mut Value| c["aud"] = json!("other-client")),
        Box::new(|c: &mut Value| c["exp"] = json!(START_MS / 1000 - 3600)),
    ] {
        let (r, _) = sign_in(&app, &idp, &lea, tamper).await;
        assert_eq!(outcome_of(&r), "failed", "{}", r.location());
        assert!(r.cookie("kalzit_session").is_none());
    }
    assert!(app.audit_actions().await.contains(&"auth.sso_failed".to_string()));

    // The provider rotates its key: the new key is loaded once the old set is a minute old.
    let new_key = Arc::new(Key::new("k2"));
    {
        let mut s = idp.lock().unwrap();
        s.keys = vec![new_key.clone()];
        s.signer = Some(new_key);
    }
    app.clock.advance_ms(61_000);
    let reads = idp.lock().unwrap().jwks_reads;
    let (r, _) = sign_in(&app, &idp, &lea, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    assert_eq!(idp.lock().unwrap().jwks_reads, reads + 1);

    // "IdP entscheidet": the role follows the provider and is locked in Members.
    let (r, _) = sign_in(&app, &idp, &Who { groups: &["alle", "kalzit-admins"], ..lea }, |_| {}).await;
    let lea_session = session_of(&r);
    let me = app.get("/api/me", &lea_session).await;
    let lea_id = me.body["id"].as_str().unwrap().to_string();
    assert_eq!(me.body["orgs"][0]["role"], json!("admin"));
    let members = app.get(&format!("/api/orgs/{org}/members"), &admin).await;
    let row = members.body["items"].as_array().unwrap().iter().find(|m| m["userId"] == json!(lea_id)).unwrap().clone();
    assert_eq!(row["idpManaged"], json!(true));
    let r = app
        .send(
            Method::PATCH,
            &format!("/api/orgs/{org}/members/{lea_id}"),
            Some(json!({ "role": "viewer" })),
            Some(&admin),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "sso.role_managed"));
    let in_team: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(&team)
        .bind(&lea_id)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(in_team.is_some());

    // The preview shows what the last groups give.
    let r = app.post("/api/admin/sign-in/mappings/preview", json!({ "userId": lea_id }), &admin).await;
    assert_eq!(r.body["outcome"]["orgs"][0]["role"], json!("admin"), "{}", r.body);
    assert_eq!(r.body["outcome"]["orgs"][0]["group"], json!("kalzit-admins"));

    // The admin group falls away: the role the provider decided follows the remaining group, and
    // the team it gave ends.
    let (r, _) = sign_in(&app, &idp, &lea, |_| {}).await;
    let me = app.get("/api/me", &session_of(&r)).await;
    assert_eq!(me.body["orgs"][0]["role"], json!("viewer"));
    let in_team: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(&team)
        .bind(&lea_id)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(in_team.is_none(), "the team of an \"IdP entscheidet\" group ends with the group");
    let members = app.get(&format!("/api/orgs/{org}/members"), &admin).await;
    let row = members.body["items"].as_array().unwrap().iter().find(|m| m["userId"] == json!(lea_id)).unwrap().clone();
    assert_eq!(row["idpManaged"], json!(false));

    // Without any group the membership the provider decided ends.
    let (_, _) = sign_in(&app, &idp, &Who { groups: &["kalzit-admins"], ..lea }, |_| {}).await;
    let (r, _) = sign_in(&app, &idp, &Who { groups: &[], ..lea }, |_| {}).await;
    let me = app.get("/api/me", &session_of(&r)).await;
    assert_eq!(me.body["orgs"], json!([]), "{}", me.body);

    // "Ablehnen": nobody without a group gets in.
    let r = app.put("/api/admin/sign-in/unmapped", json!({ "rule": "refuse", "defaultRole": "viewer" }), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (r, _) = sign_in(&app, &idp, &Who { groups: &[], ..lea }, |_| {}).await;
    assert_eq!(outcome_of(&r), "unmapped");
    let r = app
        .put(
            "/api/admin/sign-in/unmapped",
            json!({ "rule": "default", "defaultOrgId": org, "defaultRole": "viewer" }),
            &admin,
        )
        .await;
    assert_eq!(r.body["defaultOrgId"], json!(org));

    // An account with the same email is not taken over when the provider did not verify it.
    let r = app
        .post("/api/admin/users", json!({ "name": "Nora", "email": "nora@example.de", "password": PASSWORD }), &admin)
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let nora = Who { sub: "sub-nora", email: "nora@example.de", verified: false, groups: &["alle"] };
    let (r, _) = sign_in(&app, &idp, &nora, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken");
    let (r, _) = sign_in(&app, &idp, &Who { verified: true, ..nora }, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "a verified email links the account");

    // A test sign-in signs nobody in and shows the groups and what the mapping makes of them.
    let mut body = form(&issuer, None);
    body["providerId"] = json!(provider_id);
    let r = app.post("/api/admin/sign-in/providers/check", body.clone(), &admin).await;
    body["checkToken"] = r.body["checkToken"].clone();
    let r = app.post("/api/admin/sign-in/test-sign-ins", body, &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let test_id = r.body["id"].as_str().unwrap().to_string();
    let binding = r.cookie("kalzit_sso").unwrap();
    let url = r.body["url"].as_str().unwrap().to_string();
    let pending = app.get(&format!("/api/admin/sign-in/test-sign-ins/{test_id}"), &admin).await;
    assert_eq!(pending.body["status"], json!("pending"));
    let tester = Who { sub: "sub-test", email: "test@example.de", verified: true, groups: &["kalzit-admins"] };
    let (r, _) = through_provider(&app, &idp, &url, &binding, &tester, |_| {}).await;
    assert_eq!(r.location(), "/anmelden/sso-test");
    assert!(r.cookie("kalzit_session").is_none());
    let done = app.get(&format!("/api/admin/sign-in/test-sign-ins/{test_id}"), &admin).await;
    assert_eq!(done.body["status"], json!("done"), "{}", done.body);
    assert_eq!(done.body["result"]["groups"], json!(["kalzit-admins"]));
    assert_eq!(done.body["result"]["outcome"]["orgs"][0]["role"], json!("admin"));
    let tester_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM users WHERE email = 'test@example.de'")
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(tester_exists.is_none());

    // Password sign-in off: only with a break-glass admin and a checked provider.
    let r =
        app.put("/api/admin/sign-in/local", json!({ "localPassword": "off", "passwordForm": "hidden" }), &admin).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "sso.local_off_blocked"));
    assert_eq!(r.body["error"]["params"]["check"], json!("breakGlassReady"));
    let r = app
        .put(
            "/api/admin/sign-in/local",
            json!({ "localPassword": "off", "passwordForm": "hidden", "breakGlassUserId": lea_id }),
            &admin,
        )
        .await;
    assert_eq!(r.reason(), "sso.break_glass_invalid", "an account without password cannot be the break-glass admin");
    let r = app
        .put(
            "/api/admin/sign-in/local",
            json!({ "localPassword": "off", "passwordForm": "hidden", "breakGlassUserId": admin_id }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["localPassword"], json!("off"));
    let r = app.send(Method::GET, "/api/auth/providers", None, None).await;
    assert_eq!((r.body["localSignIn"].clone(), r.body["passwordForm"].clone()), (json!(false), json!("hidden")));

    // Nora still has a password, but it no longer signs her in; a wrong one says nothing more.
    let login = |email: &str, password: &str| json!({ "email": email, "password": password });
    let r = app.send(Method::POST, "/api/auth/login", Some(login("nora@example.de", PASSWORD)), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "sso.password_sign_in_off"));
    let r = app.send(Method::POST, "/api/auth/login", Some(login("nora@example.de", "falsch-falsch")), None).await;
    assert_eq!(r.body["error"]["code"], json!("invalid_credentials"));
    let r = app.send(Method::POST, "/api/auth/login/local", Some(login("nora@example.de", PASSWORD)), None).await;
    assert_eq!(r.reason(), "sso.password_sign_in_off");
    // The break-glass admin: not through the normal form, through the fixed one.
    let r = app.send(Method::POST, "/api/auth/login", Some(login("joerg@example.de", PASSWORD)), None).await;
    assert_eq!(r.reason(), "sso.password_sign_in_off");
    let r = app.send(Method::POST, "/api/auth/login/local", Some(login("joerg@example.de", PASSWORD)), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(app.audit_actions().await.contains(&"auth.break_glass_signed_in".to_string()));
    let r = app
        .send(Method::PATCH, &format!("/api/admin/users/{admin_id}"), Some(json!({ "disabled": true })), Some(&admin))
        .await;
    assert_eq!(r.reason(), "sso.break_glass_protected");
    // The break-glass form has a budget of its own.
    let mut limited = false;
    for _ in 0..12 {
        let r =
            app.send(Method::POST, "/api/auth/login/local", Some(login("x@example.de", "falsch-falsch")), None).await;
        limited |= r.status == StatusCode::TOO_MANY_REQUESTS;
    }
    assert!(limited);

    // A provider with people cannot be removed, only paused; paused, its button is gone.
    let r = app.send(Method::DELETE, &format!("/api/admin/sign-in/providers/{provider_id}"), None, Some(&admin)).await;
    assert_eq!(r.reason(), "sso.provider_in_use");
    let r = app
        .send(
            Method::PATCH,
            &format!("/api/admin/sign-in/providers/{provider_id}/enabled"),
            Some(json!({ "enabled": false })),
            Some(&admin),
        )
        .await;
    assert_eq!(r.body["enabled"], json!(false));
    let r = app.send(Method::GET, "/api/auth/sso/mueller-sso/start", None, None).await;
    assert_eq!(outcome_of(&r), "unavailable");

    // Not for anyone but server admins.
    let r = app.get("/api/admin/sign-in", &lea_session).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    app.finish().await;
}
