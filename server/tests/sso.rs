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
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    /// A token endpoint the discovery names instead of the provider's own.
    token_endpoint: Option<String>,
}

type Idp = Arc<Mutex<IdpState>>;

async fn discovery(State(idp): State<Idp>) -> axum::Json<Value> {
    let (issuer, token) = {
        let s = idp.lock().unwrap();
        (s.issuer.clone(), s.token_endpoint.clone())
    };
    axum::Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/authorize"),
        "token_endpoint": token.unwrap_or_else(|| format!("{issuer}/token")),
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
// A mail server that keeps what it receives (recipient, message)

type Inbox = Arc<Mutex<Vec<(String, String)>>>;

async fn fake_smtp() -> (u16, Inbox) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let inbox: Inbox = Arc::default();
    let log = inbox.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let log = log.clone();
            tokio::spawn(async move {
                let mut io = BufReader::new(socket);
                let _ = io.write_all(b"220 fake ESMTP\r\n").await;
                let mut to = String::new();
                loop {
                    let mut line = String::new();
                    if io.read_line(&mut line).await.unwrap_or(0) == 0 {
                        return;
                    }
                    let upper = line.trim_end().to_ascii_uppercase();
                    let answer: &[u8] = if upper.starts_with("EHLO") {
                        b"250-fake\r\n250 SMTPUTF8\r\n"
                    } else if upper.starts_with("RCPT TO:") {
                        to = line.trim_end()[8..].trim_matches(['<', '>']).to_string();
                        b"250 ok\r\n"
                    } else if upper == "DATA" {
                        let _ = io.write_all(b"354 go\r\n").await;
                        let mut data = String::new();
                        loop {
                            let mut l = String::new();
                            if io.read_line(&mut l).await.unwrap_or(0) == 0 || l == ".\r\n" {
                                break;
                            }
                            data.push_str(&l);
                        }
                        log.lock().unwrap().push((std::mem::take(&mut to), data));
                        b"250 queued\r\n"
                    } else if upper == "QUIT" {
                        let _ = io.write_all(b"221 bye\r\n").await;
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    let _ = io.write_all(answer).await;
                }
            });
        }
    });
    (port, inbox)
}

// ---------------------------------------------------------------------------------------------
// The app

struct TestApp {
    app: Router,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    clock: Arc<ManualClock>,
    inbox: Inbox,
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
    test_app_with(None).await
}

/// The app, with `server.public_url` when links must go out by mail.
async fn test_app_with(public_url: Option<&str>) -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3999".into();
    config.server.public_url = public_url.map(str::to_string);
    // An unencrypted relay on this machine, which only the file may set.
    let (smtp_port, inbox) = fake_smtp().await;
    config.smtp.host = "127.0.0.1".into();
    config.smtp.port = smtp_port;
    config.smtp.security = "none".into();
    config.smtp.from_name = "Kalzit".into();
    config.smtp.from_address = "kalzit@example.com".into();
    config.file_keys.insert("smtp.host".into());
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(START_MS));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), state, dir: Arc::new(dir), clock, inbox }
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
    let (_, _) = sign_in(&app, &idp, &Who { groups: &["kalzit-admins"], ..lea }, |_| {}).await;
    let (r, _) = sign_in(&app, &idp, &Who { groups: &[], ..lea }, |_| {}).await;
    assert_eq!(outcome_of(&r), "unmapped");
    // Refused, the person still loses what the provider decided.
    let member: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE user_id = $1")
        .bind(&lea_id)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(member.is_none(), "the \"IdP entscheidet\" membership ends with a refusal: {member:?}");
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
    // `email_verified` counts only for the `email` claim; an email claim of another name does not
    // prove it (the claim here is still `email`, so this checks the plain case).
    let (r, _) = sign_in(&app, &idp, &Who { verified: true, ..nora }, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "a verified email links the account");
    // An account whose email was never confirmed (made from a link an admin passed on) is never
    // taken over by email, even when the provider verified it.
    let r = app
        .post("/api/admin/users", json!({ "name": "Olga", "email": "olga@example.de", "password": PASSWORD }), &admin)
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    sqlx::query("UPDATE users SET email_confirmed = 0 WHERE email = 'olga@example.de'")
        .execute(&app.state.db)
        .await
        .unwrap();
    let olga = Who { sub: "sub-olga", email: "olga@example.de", verified: true, groups: &["alle"] };
    let (r, _) = sign_in(&app, &idp, &olga, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken");
    let linked: Option<(String,)> = sqlx::query_as("SELECT user_id FROM sso_identities WHERE subject = 'sub-olga'")
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(linked.is_none());
    // A server admin is never linked by email, verified or not.
    let joerg = Who { sub: "sub-joerg", email: "joerg@example.de", verified: true, groups: &["alle"] };
    let (r, _) = sign_in(&app, &idp, &joerg, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken");
    // Nor an email whose local part only looks alike after Unicode case folding (the Kelvin sign).
    let kelvin = Who { sub: "sub-kelvin", email: "\u{212A}elvin@example.de", verified: true, groups: &["alle"] };
    let (r, _) = sign_in(&app, &idp, &kelvin, |_| {}).await;
    assert_eq!(outcome_of(&r), "failed", "no usable email: {}", r.location());

    // The callback is bound to the browser that started it: another cookie takes nothing, the
    // right one still works.
    let start = app.send(Method::GET, "/api/auth/sso/mueller-sso/start", None, None).await;
    let binding = start.cookie("kalzit_sso").unwrap();
    let q: HashMap<String, String> = url::Url::parse(&start.location()).unwrap().query_pairs().into_owned().collect();
    let r = app
        .send(
            Method::GET,
            &format!("/auth/oidc/mueller-sso/callback?code=x&state={}", q["state"]),
            None,
            Some("kalzit_sso=fremd"),
        )
        .await;
    assert_eq!(outcome_of(&r), "expired");
    // RFC 9207: an `iss` that names another issuer is refused.
    let r = app
        .send(
            Method::GET,
            &format!("/auth/oidc/mueller-sso/callback?code=x&state={}&iss=https%3A%2F%2Fevil.example", q["state"]),
            None,
            Some(&format!("kalzit_sso={binding}")),
        )
        .await;
    assert_eq!(outcome_of(&r), "failed");
    let causes: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'auth.sso_failed'")
        .fetch_all(&app.state.db)
        .await
        .unwrap();
    assert!(causes.iter().any(|(s,)| s.contains("sso.iss_mismatch")));
    assert!(causes.iter().any(|(s,)| s.contains("sso.email_link_admin")));

    // With a second factor, Kalzit asks for it after the provider ("Kalzit fragt"), unless the
    // provider's switch takes its word for one and the token says it checked several factors.
    let nora_id: (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'nora@example.de'").fetch_one(&app.state.db).await.unwrap();
    sqlx::query(
        "INSERT INTO user_passkeys (id, user_id, credential_id, name, credential, created_at) \
         VALUES ('pk-nora', $1, 'cred-nora', 'Schlüssel', '{}', 0)",
    )
    .bind(&nora_id.0)
    .execute(&app.state.db)
    .await
    .unwrap();
    let verified_nora = Who { verified: true, ..nora };
    let (r, _) = sign_in(&app, &idp, &verified_nora, |c| c["amr"] = json!(["pwd", "mfa"])).await;
    assert_eq!(r.location(), "/anmelden?secondFactor=1&redirect=%2Fdashboards");
    assert!(r.cookie("kalzit_session").is_none());
    let pending =
        r.headers.get_all(header::SET_COOKIE).iter().any(|c| c.to_str().unwrap().starts_with("kalzit_pending="));
    assert!(pending, "the half-signed-in state starts: {:?}", r.headers);
    // The mapping waits for the second step: a new admin group gives nothing before it.
    let (r, _) = sign_in(&app, &idp, &Who { groups: &["kalzit-admins"], ..verified_nora }, |_| {}).await;
    assert_eq!(r.location(), "/anmelden?secondFactor=1&redirect=%2Fdashboards");
    let role: (String,) = sqlx::query_as("SELECT role FROM org_members WHERE user_id = $1")
        .bind(&nora_id.0)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(role.0, "viewer", "nothing applies before the second factor");
    let deferred: Option<(String,)> = sqlx::query_as("SELECT provider_id FROM sso_pending_mappings WHERE user_id = $1")
        .bind(&nora_id.0)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert_eq!(deferred.map(|d| d.0), Some(provider_id.clone()));
    sqlx::query("UPDATE sso_providers SET trust_provider_mfa = 1").execute(&app.state.db).await.unwrap();
    let (r, _) = sign_in(&app, &idp, &verified_nora, |_| {}).await;
    assert_eq!(r.location(), "/anmelden?secondFactor=1&redirect=%2Fdashboards", "no mfa in amr: Kalzit asks");
    let (r, _) = sign_in(&app, &idp, &verified_nora, |c| c["amr"] = json!(["pwd", "mfa"])).await;
    assert_eq!(r.location(), "/dashboards");
    // That sign-in did not take over what the earlier one kept for its second step.
    let deferred: Option<(String,)> = sqlx::query_as("SELECT provider_id FROM sso_pending_mappings WHERE user_id = $1")
        .bind(&nora_id.0)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(deferred.is_none(), "a pending mapping belongs to its own sign-in");
    sqlx::query("UPDATE sso_providers SET trust_provider_mfa = 0").execute(&app.state.db).await.unwrap();

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

    // A form that names another issuer never gets the stored secret: it must bring it again.
    let mut body = form("https://other-idp.example", None);
    body["providerId"] = json!(provider_id);
    let r = app.post("/api/admin/sign-in/providers/check", body, &admin).await;
    assert_eq!((r.reason(), r.body["error"]["field"].as_str()), ("sso.client_secret_required", Some("clientSecret")));

    // An organization's "off" applies to its members, never to server admins.
    let settings = app.get(&format!("/api/orgs/{org}/settings"), &admin).await;
    let version = settings.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "signin.local_password")
        .map(|s| s["version"].as_i64().unwrap())
        .unwrap();
    let path = format!("/api/orgs/{org}/settings/signin.local_password");
    let r = app.send(Method::PATCH, &path, Some(json!({ "value": "off", "version": version })), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let login = |email: &str, password: &str| json!({ "email": email, "password": password });
    let r = app.send(Method::POST, "/api/auth/login", Some(login("nora@example.de", PASSWORD)), None).await;
    assert_eq!(r.reason(), "sso.password_sign_in_off", "a member of the organization");
    let r = app.send(Method::POST, "/api/auth/login", Some(login("joerg@example.de", PASSWORD)), None).await;
    assert_eq!(r.status, StatusCode::OK, "a server admin in the organization: {}", r.body);
    let r =
        app.send(Method::PATCH, &path, Some(json!({ "value": "inherit", "version": version + 1 })), Some(&admin)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

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
    let off = json!({ "localPassword": "off", "passwordForm": "hidden", "breakGlassUserId": admin_id });
    let r = app.put("/api/admin/sign-in/local", off.clone(), &admin).await;
    assert_eq!(
        r.body["error"]["params"]["check"],
        json!("breakGlassReady"),
        "the break-glass admin needs a second factor"
    );
    sqlx::query(
        "INSERT INTO user_passkeys (id, user_id, credential_id, name, credential, created_at)          VALUES ('pk-1', $1, 'cred-1', 'Schlüssel', '{}', 0)",
    )
    .bind(&admin_id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let r = app.put("/api/admin/sign-in/local", off, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["localPassword"], json!("off"));
    let r = app.send(Method::GET, "/api/auth/providers", None, None).await;
    assert_eq!((r.body["localSignIn"].clone(), r.body["passwordForm"].clone()), (json!(false), json!("hidden")));

    // Nora still has a password, but it no longer signs her in; a wrong one says nothing more.
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
    assert!(r.body.get("secondFactor").is_some(), "the second factor follows: {}", r.body);
    assert!(app.audit_actions().await.contains(&"auth.break_glass_signed_in".to_string()));
    // Every server admin gets a mail about it.
    app.state.mail.settle().await;
    let mails = app.inbox.lock().unwrap().clone();
    let notice = mails
        .iter()
        .find(|(to, data)| to == "joerg@example.de" && data.contains("Subject: Anmeldung des Notfall-Admins"));
    assert!(notice.is_some(), "a break-glass notice to the server admins: {mails:?}");
    let r = app
        .send(Method::PATCH, &format!("/api/admin/users/{admin_id}"), Some(json!({ "disabled": true })), Some(&admin))
        .await;
    assert_eq!(r.reason(), "sso.break_glass_protected");
    // Without a second factor (gone through a database change), the break-glass admin sets one up
    // before getting in: a password alone never opens the server.
    sqlx::query("DELETE FROM user_passkeys WHERE user_id = $1").bind(&admin_id).execute(&app.state.db).await.unwrap();
    let r = app.send(Method::POST, "/api/auth/login/local", Some(login("joerg@example.de", PASSWORD)), None).await;
    assert_eq!(r.body["secondFactor"]["setup"], json!(true), "{}", r.body);
    assert!(r.cookie("kalzit_session").is_none());
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

    // No endpoint of a provider may point back at Kalzit (its own port on this computer).
    let other = fake_idp().await;
    let other_issuer = other.lock().unwrap().issuer.clone();
    other.lock().unwrap().token_endpoint = Some("http://127.0.0.1:3999/api/auth/login".into());
    let r = app.post("/api/admin/sign-in/providers/check", form(&other_issuer, Some(CLIENT_SECRET)), &admin).await;
    assert_eq!(r.reason(), "sso.token_unreachable", "{}", r.body);
    let detail = r.body["error"]["params"]["detail"].as_str().unwrap_or_default();
    assert!(detail.contains("this Kalzit server"), "refused before connecting, not unreachable: {detail}");
    other.lock().unwrap().token_endpoint = None;

    // Someone the provider made an admin ("IdP entscheidet"), before the issuer changes.
    let enable = |on: bool| json!({ "enabled": on });
    let enabled_path = format!("/api/admin/sign-in/providers/{provider_id}/enabled");
    app.send(Method::PATCH, &enabled_path, Some(enable(true)), Some(&admin)).await;
    let tess = Who { sub: "sub-tess", email: "tess@example.de", verified: true, groups: &["kalzit-admins"] };
    let (r, _) = sign_in(&app, &idp, &tess, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    let tess_id: (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'tess@example.de'").fetch_one(&app.state.db).await.unwrap();
    app.send(Method::PATCH, &enabled_path, Some(enable(false)), Some(&admin)).await;

    // Another issuer: subjects are only unique per issuer, so the links go, after a confirmation.
    let r = app.post("/api/admin/sign-in/providers/check", form(&other_issuer, Some(CLIENT_SECRET)), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let detail = app.get(&format!("/api/admin/sign-in/providers/{provider_id}"), &admin).await;
    let mut body = form(&other_issuer, Some(CLIENT_SECRET));
    body["checkToken"] = r.body["checkToken"].clone();
    body["version"] = detail.body["version"].clone();
    let provider_path = format!("/api/admin/sign-in/providers/{provider_id}");
    let r = app.put(&provider_path, body.clone(), &admin).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "sso.issuer_change_confirm"), "{}", r.body);
    body["confirmIssuerChange"] = json!(true);
    let r = app.put(&provider_path, body, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (links,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sso_identities WHERE provider_id = $1")
        .bind(&provider_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(links, 0);
    let (managed,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sso_managed WHERE provider_id = $1")
        .bind(&provider_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(managed, 0);
    assert!(app.audit_actions().await.contains(&"sso.provider_identities_removed".to_string()));
    // The memberships the provider decided went with them, recorded per person.
    let member: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE user_id = $1")
        .bind(&tess_id.0)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(member.is_none(), "{member:?}");
    let revoked: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT summary, actor_user_id FROM audit_events WHERE action = 'sso.memberships_changed' \
         AND resource_id = $1 AND summary LIKE '%issuer_changed%'",
    )
    .bind(&tess_id.0)
    .fetch_all(&app.state.db)
    .await
    .unwrap();
    assert!(revoked.iter().any(|(s, _)| s.contains("removed")), "{revoked:?}");
    assert!(revoked.iter().all(|(_, actor)| actor.as_deref() == Some(admin_id.as_str())), "the admin changed it");

    // Not for anyone but server admins.
    let r = app.get("/api/admin/sign-in", &lea_session).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    app.finish().await;
}

/// The plain text of a mail the fake server received.
fn mail_text(data: &str) -> String {
    let part = data.split("Content-Type: text/plain").nth(1).unwrap_or_default();
    let body = part.split("\r\n\r\n").nth(1).unwrap_or_default();
    let encoded: String = body.lines().take_while(|l| !l.starts_with("--")).collect();
    String::from_utf8(STANDARD.decode(encoded.trim()).unwrap_or_default()).unwrap_or_default()
}

/// Adds the provider `mueller-sso` for `issuer` and answers its id.
async fn add_provider(app: &TestApp, issuer: &str, admin: &str) -> String {
    let r = app.post("/api/admin/sign-in/providers/check", form(issuer, Some(CLIENT_SECRET)), admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let mut body = form(issuer, Some(CLIENT_SECRET));
    body["checkToken"] = r.body["checkToken"].clone();
    let r = app.post("/api/admin/sign-in/providers", body, admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

/// An account a provider made from an email it did not verify is unconfirmed: nobody adds it by
/// that address, no other identity is linked to it by email, and a password link gives it no
/// password. With password sign-in off, an invitation is accepted through a provider only.
#[tokio::test]
async fn unverified_provider_accounts_and_invitations_without_passwords() {
    let app = test_app_with(Some("https://kalzit.example")).await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, admin_id, org) = app.setup().await;
    add_provider(&app, &issuer, &admin).await;

    let uwe = Who { sub: "sub-uwe", email: "uwe@example.de", verified: false, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &uwe, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    let (confirmed,): (i64,) = sqlx::query_as("SELECT email_confirmed FROM users WHERE email = 'uwe@example.de'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(confirmed, 0, "the provider did not verify the address");
    let r = app
        .post(&format!("/api/orgs/{org}/members"), json!({ "email": "uwe@example.de", "role": "viewer" }), &admin)
        .await;
    assert_eq!(r.reason(), "mail.email_unconfirmed", "{}", r.body);
    let other = Who { sub: "sub-uwe-elsewhere", email: "uwe@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &other, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken", "no other identity is linked to it by email");
    let r = app.send(Method::POST, "/api/auth/password-reset", Some(json!({ "email": "uwe@example.de" })), None).await;
    assert_eq!(r.status, StatusCode::ACCEPTED, "{}", r.body);
    app.state.mail.settle().await;
    let (links,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM password_resets").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(links, 0, "no password link for an account without a password");
    let mails = app.inbox.lock().unwrap().clone();
    let elsewhere = mails.iter().find(|(to, _)| to == "uwe@example.de").map(|(_, d)| mail_text(d)).unwrap_or_default();
    assert!(elsewhere.contains("Anmeldung deiner"), "the mail says where the password lives: {elsewhere}");

    // A verified address makes a confirmed account.
    let vera = Who { sub: "sub-vera", email: "vera@example.de", verified: true, groups: &[] };
    sign_in(&app, &idp, &vera, |_| {}).await;
    let (confirmed,): (i64,) = sqlx::query_as("SELECT email_confirmed FROM users WHERE email = 'vera@example.de'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(confirmed, 1);

    // Password sign-in off: an invitation offers the provider and takes no password.
    sqlx::query(
        "INSERT INTO user_passkeys (id, user_id, credential_id, name, credential, created_at) \
         VALUES ('pk-admin', $1, 'cred-admin', 'Schlüssel', '{}', 0)",
    )
    .bind(&admin_id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let off = json!({ "localPassword": "off", "passwordForm": "hidden", "breakGlassUserId": admin_id });
    let r = app.put("/api/admin/sign-in/local", off, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let token = invite(&app, &admin, &org, "neu@example.de").await;
    let r = app.send(Method::POST, "/api/auth/invitation", Some(json!({ "token": token })), None).await;
    assert_eq!(r.body["password"], json!(false), "{}", r.body);
    assert_eq!(r.body["sso"][0]["id"], json!("mueller-sso"));
    let accept = json!({ "token": token, "name": "Neu", "password": PASSWORD });
    let r = app.send(Method::POST, "/api/auth/invitation/accept", Some(accept), None).await;
    assert_eq!((r.status, r.reason()), (StatusCode::FORBIDDEN, "sso.password_sign_in_off"), "{}", r.body);
    let made: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = 'neu@example.de'")
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(made.is_none(), "no account with a password");

    // An invitation to an internationalized domain names the account a provider made from its
    // ASCII (IDNA) form.
    let anna_token = invite(&app, &admin, &org, "anna@bücher.example").await;
    let anna = Who { sub: "sub-anna", email: "anna@xn--bcher-kva.example", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &anna, |_| {}).await;
    let anna_session = session_of(&r);
    let r = app.send(Method::POST, "/api/auth/invitation", Some(json!({ "token": anna_token })), None).await;
    assert_eq!(r.body["accountExists"], json!(true), "{}", r.body);
    let r = app.post("/api/auth/invitation/accept", json!({ "token": anna_token }), &anna_session).await;
    assert_eq!(r.status, StatusCode::OK, "the invited address in another form: {}", r.body);
    assert_eq!(r.body["orgs"][0]["id"], json!(org));

    // The organization requires a second factor: someone who signed in through the provider and
    // joins sets one up first; the session they had ends.
    let settings = app.get(&format!("/api/orgs/{org}/settings"), &admin).await;
    let version = settings.body["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "security.two_factor_required")
        .map(|s| s["version"].as_i64().unwrap())
        .unwrap();
    let path = format!("/api/orgs/{org}/settings/security.two_factor_required");
    let r =
        app.send(Method::PATCH, &path, Some(json!({ "value": "everyone", "version": version })), Some(&admin)).await;
    assert!(r.status == StatusCode::OK || r.status == StatusCode::FORBIDDEN, "{}", r.body);
    if r.status == StatusCode::FORBIDDEN {
        // The change asks for a fresh confirmation of the admin's own factor; set it directly.
        sqlx::query(
            "INSERT INTO org_settings (org_id, key, value, version, updated_by, updated_at) \
             VALUES ($1, 'security.two_factor_required', '\"everyone\"', 1, $2, 0)",
        )
        .bind(&org)
        .bind(&admin_id)
        .execute(&app.state.db)
        .await
        .unwrap();
        kalzit::settings::cache(&app.state).invalidate(Some(&org));
    }
    let neu = Who { sub: "sub-neu", email: "neu@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &neu, |_| {}).await;
    let neu_session = session_of(&r);
    let r = app.post("/api/auth/invitation/accept", json!({ "token": token }), &neu_session).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["secondFactor"]["setup"], json!(true), "{}", r.body);
    assert!(r.cookie("kalzit_pending").is_some(), "the second step starts");
    assert_eq!(app.get("/api/me", &neu_session).await.status, StatusCode::UNAUTHORIZED, "the session ended");
    app.finish().await;
}

/// Invites `email` to `org` and answers the token of the mailed link.
async fn invite(app: &TestApp, admin: &str, org: &str, email: &str) -> String {
    let r =
        app.post(&format!("/api/orgs/{org}/invitations"), json!({ "emails": [email], "role": "viewer" }), admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    app.state.mail.settle().await;
    let mails = app.inbox.lock().unwrap().clone();
    let text = mails.iter().rev().find(|(to, _)| to == email).map(|(_, d)| mail_text(d)).unwrap_or_default();
    let token: String = text
        .split("/invite#")
        .nth(1)
        .unwrap_or_default()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    assert!(!token.is_empty(), "the invitation link: {text}");
    token
}

/// One address in two forms of its domain (Unicode, NFC or NFD, and ASCII/IDNA) names one
/// account, whichever form the account was made with: an invitation finds it, a provider links
/// it, and no second account is made with the other form. Two accounts left from before (made
/// with both forms) make a sign-in by email ambiguous, and it is refused.
#[tokio::test]
async fn internationalized_addresses_name_one_account_in_both_directions() {
    let app = test_app_with(Some("https://kalzit.example")).await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, _, org) = app.setup().await;
    add_provider(&app, &issuer, &admin).await;

    // An account made with the Unicode form.
    let r = app
        .post(
            "/api/admin/users",
            json!({ "name": "Anna", "email": "anna@bücher.example", "password": PASSWORD }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let anna_id = r.body["id"].as_str().unwrap().to_string();
    // The same address in its ASCII or NFD form is taken.
    for other in ["anna@xn--bcher-kva.example", "anna@bu\u{308}cher.example"] {
        let r =
            app.post("/api/admin/users", json!({ "name": "Anna", "email": other, "password": PASSWORD }), &admin).await;
        assert_eq!(r.status, StatusCode::CONFLICT, "{other}: {}", r.body);
    }

    // An invitation to the ASCII form names it, and makes no second account.
    let token = invite(&app, &admin, &org, "anna@xn--bcher-kva.example").await;
    let r = app.send(Method::POST, "/api/auth/invitation", Some(json!({ "token": token })), None).await;
    assert_eq!(r.body["accountExists"], json!(true), "{}", r.body);
    let accept = json!({ "token": token, "name": "Anna", "password": PASSWORD });
    let r = app.send(Method::POST, "/api/auth/invitation/accept", Some(accept), None).await;
    assert_eq!(r.reason(), "mail.invite_account_exists", "{}", r.body);

    // A provider that sends the ASCII form signs in to it.
    let anna = Who { sub: "sub-anna", email: "anna@xn--bcher-kva.example", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &anna, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    let (linked,): (String,) = sqlx::query_as("SELECT user_id FROM sso_identities WHERE subject = 'sub-anna'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(linked, anna_id);
    let (accounts,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM users WHERE email LIKE 'anna@%'").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(accounts, 1);
    // Signed in that way, the ASCII invitation is joined with that account.
    let r = app.post("/api/auth/invitation/accept", json!({ "token": token }), &session_of(&r)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["id"], json!(anna_id));

    // Two accounts with both forms, left from before the forms were compared as one.
    for (id, email) in [("bea-1", "bea@bücher.example"), ("bea-2", "bea@xn--bcher-kva.example")] {
        sqlx::query("INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, 'Bea', 0)")
            .bind(id)
            .bind(email)
            .execute(&app.state.db)
            .await
            .unwrap();
    }
    let bea = Who { sub: "sub-bea", email: "bea@xn--bcher-kva.example", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &bea, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken", "{}", r.location());
    let causes: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'auth.sso_failed'")
        .fetch_all(&app.state.db)
        .await
        .unwrap();
    assert!(causes.iter().any(|(s,)| s.contains("sso.email_ambiguous")), "{causes:?}");
    let linked: Option<(String,)> = sqlx::query_as("SELECT user_id FROM sso_identities WHERE subject = 'sub-bea'")
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(linked.is_none());
    app.finish().await;
}

/// A service account never signs in through a provider: not by its address (in any form), and
/// not through an identity linked to it. An invitation never names it either.
#[tokio::test]
async fn service_accounts_never_sign_in_or_link_through_a_provider() {
    let app = test_app_with(Some("https://kalzit.example")).await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, _, org) = app.setup().await;
    let provider_id = add_provider(&app, &issuer, &admin).await;
    sqlx::query(
        "INSERT INTO users (id, email, name, created_at, service_account, email_confirmed) \
         VALUES ('svc', 'robot@bücher.example', 'Robot', 0, 1, 1)",
    )
    .execute(&app.state.db)
    .await
    .unwrap();

    // By its address, here in the ASCII form: refused, nothing linked, no account made.
    let robot = Who { sub: "sub-robot", email: "robot@xn--bcher-kva.example", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &robot, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken", "{}", r.location());
    assert!(r.cookie("kalzit_session").is_none());
    let linked: Option<(String,)> = sqlx::query_as("SELECT user_id FROM sso_identities WHERE subject = 'sub-robot'")
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(linked.is_none());
    let (accounts,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM users WHERE email LIKE 'robot@%'").fetch_one(&app.state.db).await.unwrap();
    assert_eq!(accounts, 1);

    // Through an identity linked to it (made by hand or left from before): refused.
    sqlx::query(
        "INSERT INTO sso_identities (provider_id, subject, issuer, user_id, created_at, last_sign_in_at) \
         VALUES ($1, 'sub-robot-linked', $2, 'svc', 0, 0)",
    )
    .bind(&provider_id)
    .bind(&issuer)
    .execute(&app.state.db)
    .await
    .unwrap();
    let linked = Who { sub: "sub-robot-linked", email: "other@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &linked, |_| {}).await;
    assert_eq!(outcome_of(&r), "failed", "{}", r.location());
    assert!(r.cookie("kalzit_session").is_none());
    let causes: Vec<(String,)> = sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'auth.sso_failed'")
        .fetch_all(&app.state.db)
        .await
        .unwrap();
    assert_eq!(causes.iter().filter(|(s,)| s.contains("sso.service_account")).count(), 2, "{causes:?}");

    // An invitation to its address in the Unicode form is refused.
    let r = app
        .post(
            &format!("/api/orgs/{org}/invitations"),
            json!({ "emails": ["robot@bücher.example"], "role": "viewer" }),
            &admin,
        )
        .await;
    assert_eq!(r.reason(), "mail.address_invalid", "{}", r.body);
    app.finish().await;
}

/// Creates a SCIM user in `org` with its SCIM token and answers its id.
async fn scim_user(app: &TestApp, org: &str, token: &str, user_name: &str) -> String {
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/scim/v2/o/{org}/Users"))
        .header(header::HOST, "kalzit.test")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/scim+json")
        .body(Body::from(json!({ "userName": user_name }).to_string()))
        .unwrap();
    let res = app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::CREATED);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice::<Value>(&bytes).unwrap()["id"].as_str().unwrap().to_string()
}

/// SCIM's word for an address counts for a single sign-on into the account it made, and for
/// nothing else: the account stays unconfirmed, nobody adds it elsewhere by its address, and an
/// unused one never blocks a mailed invitation of another organization (docs/api/scim.md,
/// "Accounts").
#[tokio::test]
async fn scim_accounts_link_at_sign_in_and_stay_unconfirmed_for_everything_else() {
    let app = test_app_with(Some("https://kalzit.example")).await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, admin_id, org) = app.setup().await;
    add_provider(&app, &issuer, &admin).await;
    let r = app.post(&format!("/api/orgs/{org}/scim-token"), json!({}), &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let token = r.body["token"].as_str().unwrap().to_string();

    // Entra ID SCIM, then Entra ID OIDC with the same address: linked at once.
    let sina = scim_user(&app, &org, &token, "sina@example.de").await;
    let who = Who { sub: "sub-sina", email: "sina@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &who, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    let session = session_of(&r);
    let me = app.get("/api/me", &session).await;
    assert_eq!(me.body["id"], json!(sina), "{}", me.body);
    assert_eq!(me.body["emailConfirmed"], json!(false), "the address stays unconfirmed");
    // A provider that did not verify the address gets nothing.
    let other = scim_user(&app, &org, &token, "olaf@example.de").await;
    let who = Who { sub: "sub-olaf", email: "olaf@example.de", verified: false, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &who, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken", "{}", r.location());
    let linked: Option<(String,)> = sqlx::query_as("SELECT user_id FROM sso_identities WHERE user_id = $1")
        .bind(&other)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(linked.is_none());

    // Nobody adds the address to another organization.
    let r = app.post("/api/admin/orgs", json!({ "name": "Werk Nord", "ownerUserId": admin_id }), &admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let nord = r.body["id"].as_str().unwrap().to_string();
    let r = app
        .post(&format!("/api/orgs/{nord}/members"), json!({ "email": "sina@example.de", "role": "viewer" }), &admin)
        .await;
    assert_eq!(r.reason(), "mail.email_unconfirmed", "{}", r.body);

    // An unused account SCIM made never blocks a mailed invitation of another organization: the
    // invited person takes it over, and SCIM's ownership ends.
    let pia = scim_user(&app, &org, &token, "pia@example.de").await;
    let invitation = invite(&app, &admin, &nord, "pia@example.de").await;
    let r = app.send(Method::POST, "/api/auth/invitation", Some(json!({ "token": invitation })), None).await;
    assert_eq!(r.body["accountExists"], json!(false), "{}", r.body);
    let accept = json!({ "token": invitation, "name": "Pia Paulsen", "password": PASSWORD });
    let r = app.send(Method::POST, "/api/auth/invitation/accept", Some(accept), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (confirmed, has_password, owned): (i64, i64, i64) = sqlx::query_as(
        "SELECT u.email_confirmed, CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END, s.created_account \
         FROM users u JOIN scim_users s ON s.user_id = u.id WHERE u.id = $1",
    )
    .bind(&pia)
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert_eq!((confirmed, has_password, owned), (1, 1, 0));
    let (members,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(&nord)
        .bind(&pia)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(members, 1);
    // Owned no more: another identity is not linked to it by SCIM's word.
    sqlx::query("UPDATE users SET email_confirmed = 0 WHERE id = $1").bind(&pia).execute(&app.state.db).await.unwrap();
    let who = Who { sub: "sub-pia", email: "pia@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &who, |_| {}).await;
    assert_eq!(outcome_of(&r), "email_taken", "{}", r.location());
    app.finish().await;
}

/// The cross-organization chain: once someone signs in to an account SCIM made, its SCIM can no
/// longer give it another person's address, so that person's sign-in never lands in it.
#[tokio::test]
async fn a_signed_in_scim_account_never_takes_another_persons_address() {
    let app = test_app_with(Some("https://kalzit.example")).await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, _, org) = app.setup().await;
    add_provider(&app, &issuer, &admin).await;
    let r = app.post(&format!("/api/orgs/{org}/scim-token"), json!({}), &admin).await;
    let token = r.body["token"].as_str().unwrap().to_string();

    let x = scim_user(&app, &org, &token, "x@example.de").await;
    let who = Who { sub: "sub-x", email: "x@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &who, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    // SCIM tries to give X the victim's address.
    let req = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/scim/v2/o/{org}/Users/{x}"))
        .header(header::HOST, "kalzit.test")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/scim+json")
        .body(Body::from(
            json!({ "Operations": [{ "op": "replace", "path": "emails",
                    "value": [{ "value": "victim@example.de", "primary": true }] }] })
            .to_string(),
        ))
        .unwrap();
    let res = app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (email,): (String,) =
        sqlx::query_as("SELECT email FROM users WHERE id = $1").bind(&x).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(email, "x@example.de", "the account keeps its address");
    // The victim's sign-in gets an account of its own.
    let victim = Who { sub: "sub-victim", email: "victim@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &victim, |_| {}).await;
    let session = session_of(&r);
    let me = app.get("/api/me", &session).await;
    assert_ne!(me.body["id"], json!(x), "{}", me.body);
    app.finish().await;
}

/// The first sign-in ends SCIM's ownership at once: when the provider and with it the identity are
/// gone right after, with no SCIM write in between, SCIM still cannot change the account's address.
#[tokio::test]
async fn the_first_link_ends_scim_ownership_even_when_the_identity_goes() {
    let app = test_app_with(Some("https://kalzit.example")).await;
    let idp = fake_idp().await;
    let issuer = idp.lock().unwrap().issuer.clone();
    let (admin, _, org) = app.setup().await;
    let provider = add_provider(&app, &issuer, &admin).await;
    let r = app.post(&format!("/api/orgs/{org}/scim-token"), json!({}), &admin).await;
    let token = r.body["token"].as_str().unwrap().to_string();

    let rua = scim_user(&app, &org, &token, "rua@example.de").await;
    let who = Who { sub: "sub-rua", email: "rua@example.de", verified: true, groups: &[] };
    let (r, _) = sign_in(&app, &idp, &who, |_| {}).await;
    assert_eq!(r.location(), "/dashboards", "{}", r.location());
    let (owned,): (i64,) = sqlx::query_as("SELECT created_account FROM scim_users WHERE user_id = $1")
        .bind(&rua)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(owned, 0, "the link ended the ownership");
    sqlx::query("DELETE FROM sso_providers WHERE id = $1").bind(&provider).execute(&app.state.db).await.unwrap();
    let (identities,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sso_identities WHERE user_id = $1")
        .bind(&rua)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(identities, 0);
    let req = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/scim/v2/o/{org}/Users/{rua}"))
        .header(header::HOST, "kalzit.test")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/scim+json")
        .body(Body::from(
            json!({ "Operations": [{ "op": "replace", "path": "emails",
                    "value": [{ "value": "other@example.de", "primary": true }] }] })
            .to_string(),
        ))
        .unwrap();
    let res = app.app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let (email,): (String,) =
        sqlx::query_as("SELECT email FROM users WHERE id = $1").bind(&rua).fetch_one(&app.state.db).await.unwrap();
    assert_eq!(email, "rua@example.de");
    app.finish().await;
}
