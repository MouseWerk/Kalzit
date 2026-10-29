//! Invitations, password reset and the mail server settings through the real router, with a
//! fake mail server on this machine (SQLite; PostgreSQL when `KALZIT_TEST_POSTGRES_URL` is set).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use base64::Engine;
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::ManualClock;
use kalzit::config::Config;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const NEW_PASSWORD: &str = "Ein ganz neues Passwort 2026";
const PUBLIC_URL: &str = "https://kalzit.example.com";
const WEEK_MS: i64 = 7 * 24 * 3_600_000;

// --- A mail server on this machine: plain SMTP, refuses recipients with "bounce" in them. ---

#[derive(Clone, Debug)]
struct Mail {
    to: String,
    data: String,
}

impl Mail {
    /// The decoded text part.
    fn text(&self) -> String {
        let start = self.data.find("Content-Type: text/plain").expect("a text part");
        let body = &self.data[start..];
        let body = &body[body.find("\r\n\r\n").unwrap() + 4..];
        let encoded: String = body.lines().take_while(|l| !l.starts_with("--")).collect();
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap()
    }

    fn subject(&self) -> String {
        self.data.lines().find_map(|l| l.strip_prefix("Subject: ")).unwrap_or_default().to_string()
    }

    /// The token of the link to `page`.
    fn token(&self, page: &str) -> String {
        let text = self.text();
        let marker = format!("{PUBLIC_URL}/{page}#");
        let at = text.find(&marker).unwrap_or_else(|| panic!("no {page} link in {text}"));
        text[at + marker.len()..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
    }
}

struct FakeSmtp {
    port: u16,
    mails: Arc<Mutex<Vec<Mail>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeSmtp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeSmtp {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mails = Arc::new(Mutex::new(Vec::new()));
        let log = mails.clone();
        let task = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let _ = serve(socket, log).await;
                });
            }
        });
        Self { port, mails, task }
    }

    fn mails(&self) -> Vec<Mail> {
        self.mails.lock().unwrap().clone()
    }
}

async fn serve(socket: tokio::net::TcpStream, log: Arc<Mutex<Vec<Mail>>>) -> std::io::Result<()> {
    let mut io = BufReader::new(socket);
    io.write_all(b"220 fake ESMTP\r\n").await?;
    let mut to = String::new();
    loop {
        let mut line = String::new();
        if io.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let upper = line.trim_end().to_ascii_uppercase();
        if upper.starts_with("EHLO") {
            io.write_all(b"250-fake\r\n250 SMTPUTF8\r\n").await?;
        } else if upper.starts_with("RCPT TO:") {
            if upper.contains("BOUNCE") {
                io.write_all(b"550 5.1.1 mailbox unknown\r\n").await?;
            } else {
                to = line.trim_end()[8..].trim_matches(['<', '>']).to_string();
                io.write_all(b"250 ok\r\n").await?;
            }
        } else if upper == "DATA" {
            io.write_all(b"354 go\r\n").await?;
            let mut data = String::new();
            loop {
                let mut l = String::new();
                if io.read_line(&mut l).await? == 0 || l == ".\r\n" {
                    break;
                }
                data.push_str(l.strip_prefix('.').unwrap_or(&l));
            }
            log.lock().unwrap().push(Mail { to: std::mem::take(&mut to), data });
            io.write_all(b"250 2.0.0 queued\r\n").await?;
        } else if upper == "QUIT" {
            io.write_all(b"221 bye\r\n").await?;
            return Ok(());
        } else {
            io.write_all(b"250 ok\r\n").await?;
        }
    }
}

// --- The app ---

struct TestApp {
    app: Router,
    clock: Arc<ManualClock>,
    state: AppState,
    dir: Arc<tempfile::TempDir>,
    smtp: Option<FakeSmtp>,
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

    fn field(&self) -> &str {
        self.body["error"]["field"].as_str().unwrap_or("")
    }

    fn session_cookie(&self) -> String {
        let set = self.headers.get(header::SET_COOKIE).expect("Set-Cookie").to_str().unwrap();
        set.split(';').next().unwrap().to_string()
    }
}

#[derive(Clone)]
struct Session {
    cookie: String,
}

/// How the app reaches mail: through the fake server set in the configuration, or not at all.
#[derive(Clone, Copy, PartialEq)]
enum Setup {
    Mail,
    NoMail,
    NoPublicUrl,
}

async fn test_app(setup: Setup) -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.database.url = std::env::var("KALZIT_TEST_POSTGRES_URL").ok().filter(|u| !u.is_empty());
    if setup != Setup::NoPublicUrl {
        config.server.public_url = Some(PUBLIC_URL.into());
    }
    let smtp = if setup == Setup::Mail { Some(FakeSmtp::start().await) } else { None };
    if let Some(smtp) = &smtp {
        // An unencrypted relay on this machine, which only the file may set.
        config.smtp.host = "127.0.0.1".into();
        config.smtp.port = smtp.port;
        config.smtp.security = "none".into();
        config.smtp.from_name = "Kalzit".into();
        config.smtp.from_address = "kalzit@example.com".into();
        config.file_keys.insert("smtp.host".into());
    }
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(1_800_000_000_000));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50000".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), clock, state, dir: Arc::new(dir), smtp }
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, who: Option<&Session>) -> Reply {
        self.send_from(method, path, body, who, "127.0.0.1:50000").await
    }

    async fn send_from(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        who: Option<&Session>,
        peer: &str,
    ) -> Reply {
        let mut req = Request::builder().method(method).uri(path).header(header::HOST, "kalzit.test");
        if let Some(who) = who {
            req = req.header(header::COOKIE, &who.cookie);
        }
        let mut req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let peer: SocketAddr = peer.parse().unwrap();
        req.extensions_mut().insert(axum::extract::ConnectInfo(peer));
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        self.clock.advance_ms(1);
        Reply { status, headers, body }
    }

    async fn get(&self, path: &str, who: &Session) -> Reply {
        self.send(Method::GET, path, None, Some(who)).await
    }

    async fn post(&self, path: &str, body: Value, who: &Session) -> Reply {
        self.send(Method::POST, path, Some(body), Some(who)).await
    }

    async fn public(&self, path: &str, body: Value) -> Reply {
        self.send(Method::POST, path, Some(body), None).await
    }

    async fn setup(&self) -> (Session, String) {
        let body = json!({ "token": SETUP_CODE, "orgName": "Müller & Söhne", "name": "Jonas Albers",
                           "email": "jonas@example.com", "password": PASSWORD });
        let r = self.send(Method::POST, "/api/setup", Some(body), None).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        (Session { cookie: r.session_cookie() }, r.body["orgs"][0]["id"].as_str().unwrap().into())
    }

    async fn login(&self, email: &str, password: &str) -> Reply {
        self.public("/api/auth/login", json!({ "email": email, "password": password })).await
    }

    async fn user(&self, admin: &Session, name: &str, email: &str) -> Session {
        let r =
            self.post("/api/admin/users", json!({ "name": name, "email": email, "password": PASSWORD }), admin).await;
        assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
        let r = self.login(email, PASSWORD).await;
        Session { cookie: r.session_cookie() }
    }

    fn mails(&self) -> Vec<Mail> {
        self.smtp.as_ref().map(FakeSmtp::mails).unwrap_or_default()
    }

    async fn audit(&self) -> Vec<(String, String)> {
        sqlx::query_as("SELECT action, summary FROM audit_events ORDER BY created_at, id")
            .fetch_all(&self.state.db)
            .await
            .unwrap()
    }

    async fn invite(&self, org: &str, emails: &[&str], role: &str, who: &Session) -> Reply {
        self.post(&format!("/api/orgs/{org}/invitations"), json!({ "emails": emails, "role": role }), who).await
    }
}

// --- Invitations ---

#[tokio::test]
async fn an_invitation_goes_by_mail_and_makes_a_member_once() {
    let app = test_app(Setup::Mail).await;
    let (owner, org) = app.setup().await;
    let team = app.post(&format!("/api/orgs/{org}/teams"), json!({ "name": "Vertrieb" }), &owner).await;
    let team_id = team.body["id"].as_str().unwrap().to_string();

    let r = app
        .post(
            &format!("/api/orgs/{org}/invitations"),
            json!({ "emails": ["Nora.Becker@example.com", "ole@example.com"], "role": "editor", "teamId": team_id }),
            &owner,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["mailed"], true);
    let items = r.body["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| i["link"].is_null() && i["invitation"]["delivery"] == "sent"), "{}", r.body);

    let mails = app.mails();
    assert_eq!(mails.len(), 2);
    let mail = mails.iter().find(|m| m.to == "nora.becker@example.com").expect("a mail to Nora");
    let text = mail.text();
    // German, the server's default language: the board's wording.
    assert!(text.contains("Du bist eingeladen als Bearbeiter im Team Vertrieb."), "{text}");
    assert!(text.contains("kalzit.example.com"), "{text}");
    assert!(mail.subject().starts_with("=?UTF-8?B?"), "the subject has umlauts: {}", mail.subject());
    let token = mail.token("invite");
    assert_eq!(token.len(), 43);

    let listed = app.get(&format!("/api/orgs/{org}/invitations"), &owner).await;
    assert_eq!(listed.body["items"].as_array().unwrap().len(), 2);
    assert_eq!(listed.body["items"][0]["state"], "pending");
    assert_eq!(listed.body["items"][0]["teamName"], "Vertrieb");
    assert_eq!(listed.body["items"][0]["invitedByName"], "Jonas Albers");

    let seen = app.public("/api/auth/invitation", json!({ "token": token })).await;
    assert_eq!(seen.status, StatusCode::OK, "{}", seen.body);
    assert_eq!(seen.body["state"], "valid");
    assert_eq!(seen.body["orgName"], "Müller & Söhne");
    assert_eq!(seen.body["inviterName"], "Jonas Albers");
    assert_eq!(seen.body["email"], "nora.becker@example.com");
    assert_eq!(seen.body["role"], "editor");
    assert_eq!(seen.body["accountExists"], false);
    assert_eq!(seen.body["sso"], json!([]));

    // The policy of every password applies.
    let short = app
        .public("/api/auth/invitation/accept", json!({ "token": token, "name": "Nora Becker", "password": "kurz" }))
        .await;
    assert_eq!((short.status, short.field()), (StatusCode::UNPROCESSABLE_ENTITY, "password"));

    let accepted = app
        .public("/api/auth/invitation/accept", json!({ "token": token, "name": "Nora Becker", "password": PASSWORD }))
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.body);
    assert_eq!(accepted.body["email"], "nora.becker@example.com");
    assert_eq!(accepted.body["orgs"][0]["role"], "editor");
    let nora = Session { cookie: accepted.session_cookie() };
    let me = app.get("/api/me", &nora).await;
    assert_eq!(me.body["name"], "Nora Becker");
    let members = app.get(&format!("/api/orgs/{org}/teams/{team_id}/members"), &owner).await;
    assert!(members.body.to_string().contains("nora.becker@example.com"), "{}", members.body);

    // Once only.
    let again = app
        .public("/api/auth/invitation/accept", json!({ "token": token, "name": "Nora", "password": PASSWORD }))
        .await;
    assert_eq!((again.status, again.reason()), (StatusCode::CONFLICT, "mail.invite_used"));
    let seen = app.public("/api/auth/invitation", json!({ "token": token })).await;
    assert_eq!(seen.body["state"], "accepted");
    let listed = app.get(&format!("/api/orgs/{org}/invitations"), &owner).await;
    assert_eq!(listed.body["items"].as_array().unwrap().len(), 1, "accepted ones leave the list");

    // The audit log has the steps and never a token.
    let audit = app.audit().await;
    let actions: Vec<&str> = audit.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(actions.iter().filter(|a| **a == "invitation.created").count(), 2);
    assert!(actions.contains(&"invitation.accepted"));
    assert!(audit.iter().all(|(_, s)| !s.contains(&token)), "a token in the audit log");
    let stored: Vec<(String,)> =
        sqlx::query_as("SELECT token_hash FROM invitations").fetch_all(&app.state.db).await.unwrap();
    assert!(stored.iter().all(|(h,)| *h != token && h.len() == 64), "only hashes are stored");
    app.finish().await;
}

#[tokio::test]
async fn expired_links_resend_with_a_new_link_and_revoked_links_look_unknown() {
    let app = test_app(Setup::Mail).await;
    let (mut owner, org) = app.setup().await;
    let r = app.invite(&org, &["finn@example.com"], "viewer", &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let id = r.body["items"][0]["invitation"]["id"].as_str().unwrap().to_string();
    let old = app.mails()[0].token("invite");

    app.clock.advance_ms(WEEK_MS);
    // A week idle ends the owner's session too.
    owner = Session { cookie: app.login("jonas@example.com", PASSWORD).await.session_cookie() };
    let seen = app.public("/api/auth/invitation", json!({ "token": old })).await;
    assert_eq!(seen.body["state"], "expired");
    assert_eq!(seen.body["inviterName"], "Jonas Albers");
    let late =
        app.public("/api/auth/invitation/accept", json!({ "token": old, "name": "Finn", "password": PASSWORD })).await;
    assert_eq!((late.status, late.reason()), (StatusCode::CONFLICT, "mail.invite_expired"));
    let listed = app.get(&format!("/api/orgs/{org}/invitations"), &owner).await;
    assert_eq!(listed.body["items"][0]["state"], "expired");
    // Copying an expired link is refused; resending makes a new one.
    let copy = app.get(&format!("/api/orgs/{org}/invitations/{id}/link"), &owner).await;
    assert_eq!(copy.reason(), "mail.invite_expired");

    let resent = app.post(&format!("/api/orgs/{org}/invitations/{id}/resend"), json!({}), &owner).await;
    assert_eq!(resent.status, StatusCode::OK, "{}", resent.body);
    assert_eq!(resent.body["invitation"]["state"], "pending");
    let new = app.mails()[1].token("invite");
    assert_ne!(new, old);
    let gone = app.public("/api/auth/invitation", json!({ "token": old })).await;
    assert_eq!((gone.status, gone.reason()), (StatusCode::NOT_FOUND, "mail.invite_invalid"));
    let seen = app.public("/api/auth/invitation", json!({ "token": new })).await;
    assert_eq!(seen.body["state"], "valid");

    // Resend restarts the seven days.
    app.clock.advance_ms(WEEK_MS - 10_000);
    let seen = app.public("/api/auth/invitation", json!({ "token": new })).await;
    assert_eq!(seen.body["state"], "valid");
    owner = Session { cookie: app.login("jonas@example.com", PASSWORD).await.session_cookie() };

    let revoked = app.send(Method::DELETE, &format!("/api/orgs/{org}/invitations/{id}"), None, Some(&owner)).await;
    assert_eq!(revoked.status, StatusCode::NO_CONTENT);
    let unknown = app.public("/api/auth/invitation", json!({ "token": new })).await;
    let made_up = app.public("/api/auth/invitation", json!({ "token": "A".repeat(43) })).await;
    assert_eq!((unknown.status, unknown.reason()), (StatusCode::NOT_FOUND, "mail.invite_invalid"));
    assert_eq!(unknown.body, made_up.body, "revoked and unknown links answer alike");
    let actions: Vec<String> = app.audit().await.into_iter().map(|(a, _)| a).collect();
    assert!(actions.contains(&"invitation.resent".to_string()) && actions.contains(&"invitation.revoked".to_string()));
    app.finish().await;
}

#[tokio::test]
async fn invitations_stay_in_their_organization_and_need_users_invite() {
    let app = test_app(Setup::Mail).await;
    let (owner, org) = app.setup().await;
    let other_owner = app.user(&owner, "Lea Hoffmann", "lea@example.com").await;
    let lea: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM users WHERE email = 'lea@example.com'").fetch_all(&app.state.db).await.unwrap();
    let r = app.post("/api/admin/orgs", json!({ "name": "Werk Nord", "ownerUserId": lea[0].0 }), &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let other_org = r.body["id"].as_str().unwrap().to_string();

    let r = app.invite(&org, &["paul@example.com"], "viewer", &owner).await;
    let id = r.body["items"][0]["invitation"]["id"].as_str().unwrap().to_string();
    // The other organization's owner cannot reach it through their own organization.
    for (method, path) in [
        (Method::GET, format!("/api/orgs/{other_org}/invitations/{id}/link")),
        (Method::POST, format!("/api/orgs/{other_org}/invitations/{id}/resend")),
        (Method::DELETE, format!("/api/orgs/{other_org}/invitations/{id}")),
    ] {
        let body = (method == Method::POST).then(|| json!({}));
        let r = app.send(method, &path, body, Some(&other_owner)).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}: {}", r.body);
    }
    let listed = app.get(&format!("/api/orgs/{other_org}/invitations"), &other_owner).await;
    assert_eq!(listed.body["items"], json!([]));

    // An editor may not invite; an admin may not invite as owner.
    let editor = app.user(&owner, "Mira", "mira@example.com").await;
    app.post(&format!("/api/orgs/{org}/members"), json!({ "email": "mira@example.com", "role": "editor" }), &owner)
        .await;
    let r = app.invite(&org, &["x@example.com"], "viewer", &editor).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let admin = app.user(&owner, "Ada", "ada@example.com").await;
    app.post(&format!("/api/orgs/{org}/members"), json!({ "email": "ada@example.com", "role": "admin" }), &owner).await;
    let r = app.invite(&org, &["x@example.com"], "owner", &admin).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);

    // Addresses: complete, not yet members, not invited twice.
    let r = app.invite(&org, &["nora@example.com", "ole@muellersoehne"], "viewer", &owner).await;
    assert_eq!(
        (r.status, r.reason(), r.body["error"]["params"]["email"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "mail.address_invalid", Some("ole@muellersoehne"))
    );
    let r = app.invite(&org, &["mira@example.com"], "viewer", &owner).await;
    assert_eq!(r.reason(), "mail.invite_already_member");
    let r = app.invite(&org, &["paul@example.com"], "viewer", &owner).await;
    assert_eq!(r.reason(), "mail.invite_pending");
    app.finish().await;
}

#[tokio::test]
async fn existing_accounts_sign_in_to_join_and_other_sessions_are_refused() {
    let app = test_app(Setup::Mail).await;
    let (owner, org) = app.setup().await;
    let paul = app.user(&owner, "Paul Weber", "paul@example.com").await;
    let r = app.invite(&org, &["selin@example.com"], "viewer", &owner).await;
    assert_eq!(r.status, StatusCode::CREATED);
    let selin_token = app.mails()[0].token("invite");
    // Signed in as someone else: refused, and the page says who.
    let seen = app.send(Method::POST, "/api/auth/invitation", Some(json!({ "token": selin_token })), Some(&paul)).await;
    assert_eq!(seen.body["signedInAs"]["name"], "Paul Weber");
    let r =
        app.send(Method::POST, "/api/auth/invitation/accept", Some(json!({ "token": selin_token })), Some(&paul)).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "mail.invite_other_account"));

    // Paul has an account: he signs in, then joins with the link alone.
    let r = app.invite(&org, &["paul@example.com"], "editor", &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let token = app.mails()[1].token("invite");
    let seen = app.public("/api/auth/invitation", json!({ "token": token })).await;
    assert_eq!(seen.body["accountExists"], true);
    let r = app
        .public("/api/auth/invitation/accept", json!({ "token": token, "name": "Fake", "password": PASSWORD }))
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "mail.invite_account_exists"));
    let r = app.send(Method::POST, "/api/auth/invitation/accept", Some(json!({ "token": token })), Some(&paul)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["orgs"][0]["role"], "editor");
    assert!(r.headers.get(header::SET_COOKIE).is_none(), "the session stays as it was");
    // Paul's password is unchanged.
    assert_eq!(app.login("paul@example.com", PASSWORD).await.status, StatusCode::OK);
    app.finish().await;
}

#[tokio::test]
async fn without_a_mail_server_the_admin_copies_the_link() {
    let app = test_app(Setup::NoMail).await;
    let (owner, org) = app.setup().await;
    let r = app.invite(&org, &["nora@example.com"], "viewer", &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    assert_eq!(r.body["mailed"], false);
    let item = &r.body["items"][0];
    assert_eq!(item["invitation"]["delivery"], "none");
    let link = item["link"].as_str().unwrap().to_string();
    assert!(link.starts_with(&format!("{PUBLIC_URL}/invite#")), "{link}");
    let id = item["invitation"]["id"].as_str().unwrap();
    let copy = app.get(&format!("/api/orgs/{org}/invitations/{id}/link"), &owner).await;
    assert_eq!(copy.body["link"], link.as_str());
    let token = link.rsplit('#').next().unwrap();
    let seen = app.public("/api/auth/invitation", json!({ "token": token })).await;
    assert_eq!(seen.body["state"], "valid");
    assert!(app.audit().await.iter().any(|(a, _)| a == "invitation.link_copied"));
    app.finish().await;
}

#[tokio::test]
async fn links_need_the_public_address() {
    let app = test_app(Setup::NoPublicUrl).await;
    let (owner, org) = app.setup().await;
    let r = app.invite(&org, &["nora@example.com"], "viewer", &owner).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "mail.public_url_missing"));
    let r = app.send(Method::GET, "/api/auth/password-reset", None, None).await;
    assert_eq!(r.body["available"], false);
    app.finish().await;
}

#[tokio::test]
async fn a_refused_recipient_is_shown_on_the_invitation_and_in_the_audit_log() {
    let app = test_app(Setup::Mail).await;
    let (owner, org) = app.setup().await;
    let r = app.invite(&org, &["bounce@example.com", "ok@example.com"], "viewer", &owner).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let items = r.body["items"].as_array().unwrap();
    let bounced = items.iter().find(|i| i["invitation"]["email"] == "bounce@example.com").unwrap();
    assert_eq!(bounced["invitation"]["delivery"], "failed");
    assert!(bounced["invitation"]["deliveryDetail"].as_str().unwrap().starts_with("550"), "{bounced}");
    let ok = items.iter().find(|i| i["invitation"]["email"] == "ok@example.com").unwrap();
    assert_eq!(ok["invitation"]["delivery"], "sent", "a refused recipient does not stop the others");
    assert!(app.audit().await.iter().any(|(a, s)| a == "invitation.delivery_failed" && s.contains("550")));
    app.finish().await;
}

// --- Password reset ---

#[tokio::test]
async fn a_password_link_sets_a_new_password_once_and_ends_the_sessions() {
    let app = test_app(Setup::Mail).await;
    let (owner, _) = app.setup().await;
    let lea = app.user(&owner, "Lea Hoffmann", "lea@example.com").await;
    let r = app.send(Method::GET, "/api/auth/password-reset", None, None).await;
    assert_eq!(r.body["available"], true);

    let known = app.public("/api/auth/password-reset", json!({ "email": "Lea@Example.com" })).await;
    let unknown = app.public("/api/auth/password-reset", json!({ "email": "nobody@example.com" })).await;
    assert_eq!(known.status, StatusCode::ACCEPTED);
    assert_eq!((known.status, &known.body), (unknown.status, &unknown.body), "the same answer either way");
    app.state.mail.settle().await;
    let mails = app.mails();
    assert_eq!(mails.len(), 1, "only the account gets a mail");
    assert_eq!(mails[0].to, "lea@example.com");
    let token = mails[0].token("reset-password");

    let seen = app.public("/api/auth/password-reset/inspect", json!({ "token": token })).await;
    assert_eq!(seen.status, StatusCode::OK, "{}", seen.body);
    assert_eq!(seen.body["email"], "lea@example.com");
    let short = app.public("/api/auth/password-reset/complete", json!({ "token": token, "password": "kurz" })).await;
    assert_eq!(short.field(), "password");
    let done =
        app.public("/api/auth/password-reset/complete", json!({ "token": token, "password": NEW_PASSWORD })).await;
    assert_eq!(done.status, StatusCode::NO_CONTENT, "{}", done.body);
    assert_eq!(app.get("/api/me", &lea).await.status, StatusCode::UNAUTHORIZED, "the old sessions ended");
    assert_eq!(app.login("lea@example.com", PASSWORD).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(app.login("lea@example.com", NEW_PASSWORD).await.status, StatusCode::OK);
    let again = app.public("/api/auth/password-reset/complete", json!({ "token": token, "password": PASSWORD })).await;
    assert_eq!((again.status, again.reason()), (StatusCode::NOT_FOUND, "mail.reset_invalid"));

    let audit = app.audit().await;
    assert!(audit.iter().any(|(a, _)| a == "auth.password_reset_requested"));
    assert!(audit.iter().any(|(a, _)| a == "auth.password_reset_completed"));
    assert!(audit.iter().all(|(_, s)| !s.contains(&token)));
    app.finish().await;
}

#[tokio::test]
async fn password_links_expire_and_follow_the_password() {
    let app = test_app(Setup::Mail).await;
    let (owner, _) = app.setup().await;
    let lea = app.user(&owner, "Lea Hoffmann", "lea@example.com").await;
    app.public("/api/auth/password-reset", json!({ "email": "lea@example.com" })).await;
    app.state.mail.settle().await;
    let first = app.mails()[0].token("reset-password");
    app.clock.advance_ms(60 * 60_000);
    let late = app.public("/api/auth/password-reset/inspect", json!({ "token": first })).await;
    assert_eq!(late.reason(), "mail.reset_invalid");

    // A link stops working once the password changed some other way.
    app.public("/api/auth/password-reset", json!({ "email": "lea@example.com" })).await;
    app.state.mail.settle().await;
    let second = app.mails()[1].token("reset-password");
    let r = app.post("/api/me/password", json!({ "current": PASSWORD, "new": NEW_PASSWORD }), &lea).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT, "{}", r.body);
    let stale = app.public("/api/auth/password-reset/inspect", json!({ "token": second })).await;
    assert_eq!(stale.reason(), "mail.reset_invalid");

    // A newer link replaces an older one.
    app.public("/api/auth/password-reset", json!({ "email": "lea@example.com" })).await;
    app.state.mail.settle().await;
    let third = app.mails()[2].token("reset-password");
    app.public("/api/auth/password-reset", json!({ "email": "lea@example.com" })).await;
    app.state.mail.settle().await;
    let fourth = app.mails()[3].token("reset-password");
    assert_eq!(
        app.public("/api/auth/password-reset/inspect", json!({ "token": third })).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(app.public("/api/auth/password-reset/inspect", json!({ "token": fourth })).await.status, StatusCode::OK);
    app.finish().await;
}

#[tokio::test]
async fn password_link_requests_are_limited_alike_for_every_address() {
    let app = test_app(Setup::Mail).await;
    let (owner, _) = app.setup().await;
    app.user(&owner, "Lea Hoffmann", "lea@example.com").await;
    for email in ["lea@example.com", "nobody@example.com"] {
        let mut statuses = Vec::new();
        for _ in 0..4 {
            let r = app
                .send_from(
                    Method::POST,
                    "/api/auth/password-reset",
                    Some(json!({ "email": email })),
                    None,
                    "10.1.0.1:1",
                )
                .await;
            statuses.push(r.status);
        }
        assert_eq!(
            statuses,
            [StatusCode::ACCEPTED, StatusCode::ACCEPTED, StatusCode::ACCEPTED, StatusCode::TOO_MANY_REQUESTS],
            "{email}"
        );
    }
    // Per address: ten requests, whatever the address asked for.
    let mut last = StatusCode::OK;
    for n in 0..11 {
        let body = json!({ "email": format!("someone{n}@example.com") });
        last = app.send_from(Method::POST, "/api/auth/password-reset", Some(body), None, "10.2.0.1:1").await.status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    // Unknown links count against the address too.
    let mut last = StatusCode::OK;
    for _ in 0..21 {
        let body = json!({ "token": "B".repeat(43) });
        last = app
            .send_from(Method::POST, "/api/auth/password-reset/inspect", Some(body), None, "10.3.0.1:1")
            .await
            .status;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    app.state.mail.settle().await;
    app.finish().await;
}

#[tokio::test]
async fn without_a_mail_server_there_is_no_password_link() {
    let app = test_app(Setup::NoMail).await;
    let (owner, org) = app.setup().await;
    let r = app.send(Method::GET, "/api/auth/password-reset", None, None).await;
    assert_eq!(r.body["available"], false);
    let r = app.public("/api/auth/password-reset", json!({ "email": "jonas@example.com" })).await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "mail.reset_unavailable"));
    let me: (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'jonas@example.com'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let r = app.post(&format!("/api/orgs/{org}/members/{}/password-link", me.0), json!({}), &owner).await;
    assert_eq!(r.reason(), "mail.reset_unavailable");
    app.finish().await;
}

#[tokio::test]
async fn an_admin_sends_a_member_the_password_link() {
    let app = test_app(Setup::Mail).await;
    let (owner, org) = app.setup().await;
    let mira = app.user(&owner, "Mira", "mira@example.com").await;
    app.post(&format!("/api/orgs/{org}/members"), json!({ "email": "mira@example.com", "role": "editor" }), &owner)
        .await;
    let (mira_id,): (String,) =
        sqlx::query_as("SELECT id FROM users WHERE email = 'mira@example.com'").fetch_one(&app.state.db).await.unwrap();
    let r = app.post(&format!("/api/orgs/{org}/members/{mira_id}/password-link"), json!({}), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["reply"].as_str().unwrap().starts_with("250"));
    assert_eq!(app.mails()[0].to, "mira@example.com");
    let token = app.mails()[0].token("reset-password");
    assert_eq!(app.public("/api/auth/password-reset/inspect", json!({ "token": token })).await.status, StatusCode::OK);
    // A member without users:write may not.
    let (owner_id,): (String,) = sqlx::query_as("SELECT id FROM users WHERE email = 'jonas@example.com'")
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    let r = app.post(&format!("/api/orgs/{org}/members/{owner_id}/password-link"), json!({}), &mira).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    app.finish().await;
}

// --- The mail server settings ---

#[tokio::test]
async fn settings_from_the_file_are_read_only_and_test_mails_go_out() {
    let app = test_app(Setup::Mail).await;
    let (owner, _) = app.setup().await;
    let view = app.get("/api/admin/mail", &owner).await;
    assert_eq!(view.status, StatusCode::OK, "{}", view.body);
    assert_eq!(view.body["source"], "file");
    assert_eq!(view.body["editable"], false);
    assert_eq!(view.body["settings"]["security"], "none");
    assert_eq!(view.body["publicUrl"], PUBLIC_URL);
    let r = app
        .send(
            Method::PUT,
            "/api/admin/mail",
            Some(json!({ "settings": null, "version": view.body["version"] })),
            Some(&owner),
        )
        .await;
    assert_eq!((r.status, r.reason()), (StatusCode::CONFLICT, "mail.set_in_file"));
    let r = app.post("/api/admin/mail/test", json!({ "to": "lea@example.com" }), &owner).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["reply"].as_str().unwrap().starts_with("250"));
    assert!(r.body["tls"].is_null());
    assert!(app.mails()[0].text().contains("Kalzit"));
    let r = app.post("/api/admin/mail/test", json!({ "to": "bounce@example.com" }), &owner).await;
    assert_eq!((r.field(), r.reason()), ("to", "mail.recipient_rejected"));
    app.finish().await;
}

#[tokio::test]
async fn settings_from_the_page_are_checked_before_they_are_saved() {
    let app = test_app(Setup::NoMail).await;
    let (owner, _) = app.setup().await;
    let smtp = FakeSmtp::start().await;
    let view = app.get("/api/admin/mail", &owner).await;
    assert_eq!((view.body["source"].as_str(), view.body["editable"].as_bool()), (Some("default"), Some(true)));
    assert!(view.body["settings"].is_null());
    let settings = |security: &str| {
        json!({ "host": "127.0.0.1", "port": smtp.port, "security": security, "username": "",
                "fromName": "Kalzit", "fromAddress": "kalzit@example.com", "replyTo": "" })
    };
    // Unencrypted only from the file.
    let r = app
        .send(Method::PUT, "/api/admin/mail", Some(json!({ "settings": settings("none"), "version": 0 })), Some(&owner))
        .await;
    assert_eq!((r.field(), r.reason()), ("security", "mail.unencrypted_only_in_file"));
    // The fake server offers no STARTTLS: the save names the field, and nothing is stored.
    let r = app
        .send(
            Method::PUT,
            "/api/admin/mail",
            Some(json!({ "settings": settings("starttls"), "version": 0 })),
            Some(&owner),
        )
        .await;
    assert_eq!((r.field(), r.reason()), ("security", "mail.starttls_missing"), "{}", r.body);
    let r = app
        .post("/api/admin/mail/test", json!({ "settings": settings("starttls"), "to": "x@example.com" }), &owner)
        .await;
    assert_eq!(r.reason(), "mail.starttls_missing");
    let view = app.get("/api/admin/mail", &owner).await;
    assert!(view.body["settings"].is_null());
    // Kalzit's own database and metadata addresses are no mail servers.
    let mut meta = settings("tls");
    meta["host"] = json!("169.254.169.254");
    meta["port"] = json!(465);
    let r =
        app.send(Method::PUT, "/api/admin/mail", Some(json!({ "settings": meta, "version": 0 })), Some(&owner)).await;
    assert_eq!((r.field(), r.reason()), ("host", "target.metadata_address"));
    // A password is never stored or sent back in clear.
    let mut with_user = settings("starttls");
    with_user["username"] = json!("kalzit");
    let r = app.post("/api/admin/mail/test", json!({ "settings": with_user, "to": "x@example.com" }), &owner).await;
    assert_eq!((r.field(), r.reason()), ("password", "mail.password_required"));
    let stored: Vec<(String,)> =
        sqlx::query_as("SELECT ciphertext FROM server_secrets").fetch_all(&app.state.db).await.unwrap();
    assert!(stored.is_empty());
    drop(smtp);
    app.finish().await;
}
