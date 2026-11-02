//! SAML 2.0 sign-in through the real router against a provider simulated in the test: its
//! metadata, the AuthnRequest, answers signed with keys made here, and the ACS and finish steps
//! (docs/api/sso.md, "SAML 2.0"). Covers a valid answer, signature wrapping, unsigned and forged
//! answers, audience, expiry, replay, InResponseTo, comments and DTDs, group mapping and the
//! refusal of service accounts.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::routing::get;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use gamlastan::crypto::keys::loader;
use gamlastan::crypto::{KeyUsage, KeysManager, SamlSigner};
use http_body_util::BodyExt;
use kalzit::app::{AppState, router};
use kalzit::clock::{Clock, ManualClock};
use kalzit::config::Config;
use serde_json::{Value, json};
use tower::ServiceExt;

mod common;

const SETUP_CODE: &str = "test-setup-code-0123456789";
const PASSWORD: &str = "Grün und sicher 2026";
const START_MS: i64 = 1_800_000_000_000;
const PUBLIC: &str = "https://kalzit.example";
const IDP: &str = "https://idp.partnerportal.example/saml";
const SLUG: &str = "partnerportal";
const ECDSA_SHA256: &str = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";

fn acs() -> String {
    format!("{PUBLIC}/auth/saml/{SLUG}/acs")
}

fn sp() -> String {
    format!("{PUBLIC}/auth/saml/{SLUG}")
}

// ---------------------------------------------------------------------------------------------
// The simulated provider

/// A signing key of the provider and its self-signed certificate.
struct IdpKey {
    signer: SamlSigner,
    cert_b64: String,
}

impl IdpKey {
    fn new(name: &str) -> Self {
        let made = rcgen::generate_simple_self_signed(vec![name.to_string()]).unwrap();
        let mut key = loader::load_pem_auto(made.signing_key.serialize_pem().as_bytes(), None).unwrap();
        key.usage = KeyUsage::Sign;
        let mut keys = KeysManager::new();
        keys.add_key(key);
        Self { signer: SamlSigner::new(keys), cert_b64: STANDARD.encode(made.cert.der()) }
    }

    /// Signs the element with `id` (an `Assertion` or the `Response`): the signature goes right
    /// after that element's `Issuer`, as SAML wants it.
    fn sign(&self, xml: &str, id: &str) -> String {
        let template = gamlastan::profiles::sso::idp::signature_template(id, &self.cert_b64, ECDSA_SHA256);
        let at = xml.find(&format!("ID=\"{id}\"")).expect("the element to sign");
        let issuer_end = at + xml[at..].find("</saml:Issuer>").expect("its issuer") + "</saml:Issuer>".len();
        let with_template = format!("{}{template}{}", &xml[..issuer_end], &xml[issuer_end..]);
        self.signer.sign_enveloped(&with_template).unwrap()
    }
}

fn metadata(certs: &[&str]) -> String {
    let keys: String = certs
        .iter()
        .map(|c| {
            format!(
                "<md:KeyDescriptor use=\"signing\"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>{c}</ds:X509Certificate>\
                 </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>"
            )
        })
        .collect();
    format!(
        "<?xml version=\"1.0\"?>\n<!-- Partnerportal -->\n<md:EntityDescriptor xmlns:md=\"urn:oasis:names:tc:SAML:2.0:metadata\" \
         xmlns:ds=\"http://www.w3.org/2000/09/xmldsig#\" entityID=\"{IDP}\"><md:IDPSSODescriptor \
         protocolSupportEnumeration=\"urn:oasis:names:tc:SAML:2.0:protocol\">{keys}<md:SingleSignOnService \
         Binding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\" Location=\"{IDP}/post\"/><md:SingleSignOnService \
         Binding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect\" Location=\"{IDP}/sso\"/></md:IDPSSODescriptor>\
         </md:EntityDescriptor>"
    )
}

/// What the provider's answer says; each test changes what it is about.
#[derive(Clone)]
struct Answer {
    response_id: String,
    assertion_id: String,
    in_response_to: String,
    confirmation_in_response_to: String,
    destination: String,
    recipient: String,
    audience: String,
    issuer: String,
    name_id: String,
    name_id_format: &'static str,
    email: String,
    groups: Vec<String>,
    /// Issue instant, relative to the clock now.
    issued_offset_ms: i64,
    lifetime_ms: i64,
    status: &'static str,
    authn_context: &'static str,
}

impl Answer {
    fn new(request_id: &str, email: &str, groups: &[&str]) -> Self {
        Self {
            response_id: format!("_r{}", hex::encode(rand::random::<[u8; 8]>())),
            assertion_id: format!("_a{}", hex::encode(rand::random::<[u8; 8]>())),
            in_response_to: request_id.into(),
            confirmation_in_response_to: request_id.into(),
            destination: acs(),
            recipient: acs(),
            audience: sp(),
            issuer: IDP.into(),
            name_id: format!("pp-{email}"),
            name_id_format: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
            email: email.into(),
            groups: groups.iter().map(|g| g.to_string()).collect(),
            issued_offset_ms: 0,
            lifetime_ms: 5 * 60 * 1000,
            status: "urn:oasis:names:tc:SAML:2.0:status:Success",
            authn_context: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
        }
    }

    fn assertion(&self, now: i64) -> String {
        let t = |ms: i64| chrono::DateTime::from_timestamp_millis(ms).unwrap().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let issued = now + self.issued_offset_ms;
        let groups: String = self
            .groups
            .iter()
            .map(|g| format!("<saml:AttributeValue>{}</saml:AttributeValue>", g.replace('&', "&amp;")))
            .collect();
        format!(
            "<saml:Assertion xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\" ID=\"{aid}\" Version=\"2.0\" \
             IssueInstant=\"{i}\"><saml:Issuer>{iss}</saml:Issuer><saml:Subject><saml:NameID Format=\"{fmt}\">{nid}\
             </saml:NameID><saml:SubjectConfirmation Method=\"urn:oasis:names:tc:SAML:2.0:cm:bearer\">\
             <saml:SubjectConfirmationData InResponseTo=\"{cirt}\" NotOnOrAfter=\"{until}\" Recipient=\"{rcp}\"/>\
             </saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore=\"{i}\" NotOnOrAfter=\"{until}\">\
             <saml:AudienceRestriction><saml:Audience>{aud}</saml:Audience></saml:AudienceRestriction></saml:Conditions>\
             <saml:AuthnStatement AuthnInstant=\"{i}\"><saml:AuthnContext><saml:AuthnContextClassRef>{ctx}\
             </saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement>\
             <saml:Attribute Name=\"urn:oid:0.9.2342.19200300.100.1.3\" FriendlyName=\"mail\"><saml:AttributeValue>{mail}\
             </saml:AttributeValue></saml:Attribute><saml:Attribute Name=\"displayName\"><saml:AttributeValue>Lea Hoffmann\
             </saml:AttributeValue></saml:Attribute><saml:Attribute Name=\"memberOf\">{groups}</saml:Attribute>\
             </saml:AttributeStatement></saml:Assertion>",
            aid = self.assertion_id,
            i = t(issued),
            iss = self.issuer,
            fmt = self.name_id_format,
            nid = self.name_id,
            cirt = self.confirmation_in_response_to,
            until = t(issued + self.lifetime_ms),
            rcp = self.recipient,
            aud = self.audience,
            ctx = self.authn_context,
            mail = self.email,
        )
    }

    fn response(&self, now: i64, assertion: &str) -> String {
        let t = chrono::DateTime::from_timestamp_millis(now + self.issued_offset_ms)
            .unwrap()
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        format!(
            "<samlp:Response xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" \
             xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\" ID=\"{rid}\" Version=\"2.0\" IssueInstant=\"{t}\" \
             Destination=\"{dest}\" InResponseTo=\"{irt}\"><saml:Issuer>{iss}</saml:Issuer><samlp:Status>\
             <samlp:StatusCode Value=\"{status}\"/></samlp:Status>{assertion}</samlp:Response>",
            rid = self.response_id,
            dest = self.destination,
            irt = self.in_response_to,
            iss = self.issuer,
            status = self.status,
        )
    }

    /// The usual answer: the assertion signed.
    fn signed(&self, key: &IdpKey, now: i64) -> String {
        let assertion = key.sign(&self.assertion(now), &self.assertion_id);
        self.response(now, &assertion)
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

    fn location(&self) -> String {
        self.headers.get(header::LOCATION).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default()
    }

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

    /// The `sso` outcome of a redirect to the sign-in page.
    fn outcome(&self) -> String {
        let location = self.location();
        let url = url::Url::parse(&format!("http://x{location}")).unwrap();
        url.query_pairs().find(|(k, _)| k == "sso").map(|(_, v)| v.into_owned()).unwrap_or(location)
    }
}

async fn test_app(public_url: Option<&str>) -> TestApp {
    let dir = common::private_tempdir();
    let mut config = Config::default();
    config.paths.data_dir = dir.path().to_path_buf();
    config.server.http_addr = "127.0.0.1:3998".into();
    config.server.public_url = public_url.map(str::to_string);
    let pool = kalzit::db::connect(&config.database_url(), 4).await.unwrap();
    let clock = Arc::new(ManualClock::new(START_MS));
    let state = AppState::new(config, pool, clock.clone(), Some(SETUP_CODE.into())).await.unwrap();
    let peer: SocketAddr = "127.0.0.1:50001".parse().unwrap();
    TestApp { app: router(state.clone()).layer(MockConnectInfo(peer)), state, dir: Arc::new(dir), clock }
}

impl TestApp {
    async fn finish(self) {
        let finish = common::Finish::new(self.state.clone(), self.dir.clone());
        drop(self);
        finish.finish().await;
    }

    async fn request(&self, req: axum::http::request::Builder, body: Body) -> Reply {
        let req = req.header(header::HOST, "kalzit.example").body(body).unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).to_string();
        Reply { status, headers, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null), text }
    }

    async fn send(&self, method: Method, path: &str, body: Option<Value>, cookie: Option<&str>) -> Reply {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        match body {
            Some(b) => {
                self.request(req.header(header::CONTENT_TYPE, "application/json"), Body::from(b.to_string())).await
            }
            None => self.request(req, Body::empty()).await,
        }
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

    /// The provider's browser POST to the ACS, from the provider's origin.
    async fn post_answer(&self, xml: &str) -> Reply {
        let form: String = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("SAMLResponse", &STANDARD.encode(xml))
            .finish();
        let req = Request::builder()
            .method(Method::POST)
            .uri(format!("/auth/saml/{SLUG}/acs"))
            .header(header::ORIGIN, "https://idp.partnerportal.example")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        self.request(req, Body::from(form)).await
    }

    async fn setup(&self) -> (String, String) {
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
        (cookie, r.body["orgs"][0]["id"].as_str().unwrap().into())
    }

    /// The reasons of failed sign-ins in the audit log, oldest first.
    async fn failures(&self) -> Vec<String> {
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT summary FROM audit_events WHERE action = 'auth.sso_failed' ORDER BY created_at, id")
                .fetch_all(&self.state.db)
                .await
                .unwrap();
        rows.into_iter()
            .map(|(s,)| serde_json::from_str::<Value>(&s).unwrap()["reason"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    async fn last_failure(&self) -> String {
        self.failures().await.pop().unwrap_or_default()
    }
}

/// The form of the provider in the admin dialog.
fn form(saml: Value) -> Value {
    json!({ "kind": "saml", "slug": SLUG, "name": "Partnerportal", "saml": saml })
}

/// Adds the provider with `certs` pinned (through an uploaded metadata file and the check).
async fn add_provider(app: &TestApp, admin: &str, certs: &[&str]) -> String {
    let check = app.post("/api/admin/sign-in/saml/check", form(json!({ "metadataXml": metadata(certs) })), admin).await;
    assert_eq!(check.status, StatusCode::OK, "{}", check.body);
    let mut saml = check.body["saml"].clone();
    saml["trustEmail"] = json!(true);
    let mut body = form(saml);
    body["checkToken"] = check.body["checkToken"].clone();
    let r = app.post("/api/admin/sign-in/saml", body, admin).await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    r.body["id"].as_str().unwrap().to_string()
}

/// Serves `xml` as the provider's metadata on this computer; answers its URL.
#[expect(clippy::disallowed_methods, reason = "a fake identity provider, not an API route")]
async fn serve_metadata(xml: String) -> String {
    let idp = Router::new().route("/metadata.xml", get(move || async move { xml }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/metadata.xml", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, idp).await.unwrap() });
    url
}

/// A started sign-in: the AuthnRequest's ID and the browser's binding cookie.
struct Started {
    request_id: String,
    binding: String,
}

async fn start(app: &TestApp) -> Started {
    let r = app.send(Method::GET, &format!("/api/auth/sso/{SLUG}/start?returnTo=/dashboards"), None, None).await;
    assert_eq!(r.status, StatusCode::SEE_OTHER, "{}", r.text);
    let url = url::Url::parse(&r.location()).unwrap();
    assert_eq!(url.as_str().split('?').next(), Some(format!("{IDP}/sso").as_str()));
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let deflated = STANDARD.decode(&q["SAMLRequest"]).unwrap();
    let request = String::from_utf8(gamlastan::bindings::deflate::deflate_decompress(&deflated).unwrap()).unwrap();
    assert!(request.contains(&format!("AssertionConsumerServiceURL=\"{}\"", acs())), "{request}");
    assert!(request.contains(&format!("<saml:Issuer>{}</saml:Issuer>", sp())), "{request}");
    assert!(request.contains("HTTP-POST"), "{request}");
    let id_at = request.find(" ID=\"").unwrap() + 5;
    let request_id = request[id_at..id_at + request[id_at..].find('"').unwrap()].to_string();
    Started { request_id, binding: r.cookie("kalzit_sso").expect("the start sets the binding cookie") }
}

/// Posts an answer and, when the ACS accepts it, takes the browser's step to `finish`.
async fn deliver(app: &TestApp, started: &Started, xml: &str) -> Reply {
    let r = app.post_answer(xml).await;
    assert_eq!(r.status, StatusCode::SEE_OTHER, "{}", r.text);
    let location = r.location();
    let Some(path) = location.strip_prefix(PUBLIC) else { return r };
    app.get(path, &format!("kalzit_sso={}", started.binding)).await
}

/// The first `<ds:Signature>` element of `xml`, as text.
fn signature_of(xml: &str) -> String {
    let start = xml.find("<ds:Signature").expect("a signature");
    let end = start + xml[start..].find("</ds:Signature>").unwrap() + "</ds:Signature>".len();
    xml[start..end].to_string()
}

fn session_of(reply: &Reply) -> String {
    format!("kalzit_session={}", reply.cookie("kalzit_session").expect("a session cookie"))
}

// ---------------------------------------------------------------------------------------------
// Tests

#[tokio::test]
async fn saml_sign_in_with_metadata_mapping_and_replay() {
    let app = test_app(Some(PUBLIC)).await;
    let (admin, org) = app.setup().await;
    let key = IdpKey::new("idp.partnerportal.example");

    // Without the public address nothing can be built: refused at the check.
    let bare = test_app(None).await;
    let (bare_admin, _) = bare.setup().await;
    let r = bare
        .post("/api/admin/sign-in/saml/check", form(json!({ "metadataXml": metadata(&[&key.cert_b64]) })), &bare_admin)
        .await;
    assert_eq!(r.reason(), "saml.public_url_missing", "{}", r.body);
    bare.finish().await;

    // The metadata from a URL: the provider's values, ready to pin.
    let metadata_url = serve_metadata(metadata(&[&key.cert_b64])).await;
    let check = app.post("/api/admin/sign-in/saml/check", form(json!({ "metadataUrl": metadata_url })), &admin).await;
    assert_eq!(check.status, StatusCode::OK, "{}", check.body);
    assert_eq!(check.body["saml"]["idpEntityId"], IDP);
    assert_eq!(check.body["saml"]["ssoUrl"], format!("{IDP}/sso"));
    assert_eq!(check.body["saml"]["certificates"], json!([key.cert_b64]));
    assert_eq!(check.body["acsUrl"], acs());
    assert_eq!(check.body["spEntityId"], sp());
    assert_eq!(check.body["certificates"][0]["fingerprint"].as_str().unwrap().len(), 95);
    let missing = format!("{}/missing.xml", metadata_url.trim_end_matches("/metadata.xml"));
    let r = app.post("/api/admin/sign-in/saml/check", form(json!({ "metadataUrl": missing })), &admin).await;
    assert_eq!(r.reason(), "saml.metadata_unreachable", "{}", r.body);
    assert_eq!(r.body["error"]["field"], "metadataUrl");

    // Saving needs a check of exactly these values.
    let mut unchecked = form(check.body["saml"].clone());
    unchecked["checkToken"] = json!("1.00");
    let r = app.post("/api/admin/sign-in/saml", unchecked, &admin).await;
    assert_eq!(r.reason(), "saml.check_required", "{}", r.body);
    let provider_id = add_provider(&app, &admin, &[&key.cert_b64]).await;
    let detail = app.get(&format!("/api/admin/sign-in/providers/{provider_id}"), &admin).await;
    assert_eq!(detail.body["kind"], "saml");
    assert_eq!(detail.body["trustProviderMfa"], false);
    assert_eq!(detail.body["spMetadataUrl"], format!("{PUBLIC}/auth/saml/{SLUG}/metadata"));
    let providers = app.send(Method::GET, "/api/auth/providers", None, None).await;
    assert_eq!(providers.body["providers"][0]["kind"], "saml");

    // Kalzit's metadata, at a stable address.
    let md = app.send(Method::GET, &format!("/auth/saml/{SLUG}/metadata"), None, None).await;
    assert_eq!(md.status, StatusCode::OK);
    assert!(md.text.contains(&format!("entityID=\"{}\"", sp())), "{}", md.text);
    assert!(md.text.contains(&format!("Location=\"{}\"", acs())), "{}", md.text);

    // A group maps to a role.
    let r = app
        .post(
            "/api/admin/sign-in/mappings",
            json!({ "providerId": provider_id, "group": "CN=Vertrieb,OU=Gruppen,DC=partnerportal,DC=example",
                    "orgId": org, "role": "editor", "idpDecides": true }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);

    // A valid answer: the account is made, the mapping applies, the session opens where the
    // person was headed.
    let started = start(&app).await;
    let answer = Answer::new(
        &started.request_id,
        "lea.hoffmann@partnerportal.example",
        &["CN=Vertrieb,OU=Gruppen,DC=partnerportal,DC=example"],
    );
    let now = app.clock.now_ms();
    let xml = answer.signed(&key, now);
    let r = deliver(&app, &started, &xml).await;
    assert_eq!(r.location(), "/dashboards", "{:?}", app.failures().await);
    let session = session_of(&r);
    let me = app.get("/api/me", &session).await;
    assert_eq!(me.body["email"], "lea.hoffmann@partnerportal.example", "{}", me.body);
    let r = app.get("/api/me/sign-ins", &session).await;
    let first = &r.body["items"][0];
    assert_eq!((&first["method"], &first["current"]), (&json!("saml"), &json!(true)), "{}", r.body);
    let user_id = me.body["id"].as_str().unwrap().to_string();
    let (role,): (String,) = sqlx::query_as("SELECT role FROM org_members WHERE user_id = $1 AND org_id = $2")
        .bind(&user_id)
        .bind(&org)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(role, "editor");
    let (subject, issuer): (String, String) =
        sqlx::query_as("SELECT subject, issuer FROM sso_identities WHERE user_id = $1")
            .bind(&user_id)
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!((subject.as_str(), issuer.as_str()), ("pp-lea.hoffmann@partnerportal.example", IDP));

    // The same answer again: its request was used.
    let r = app.post_answer(&xml).await;
    assert_eq!(r.outcome(), "expired");
    assert_eq!(app.last_failure().await, "saml.request_unknown");

    // The same assertion in an answer to a new request: a replay.
    let again = start(&app).await;
    let replay = Answer {
        in_response_to: again.request_id.clone(),
        confirmation_in_response_to: again.request_id.clone(),
        ..answer.clone()
    };
    let r = deliver(&app, &again, &replay.signed(&key, app.clock.now_ms())).await;
    assert_eq!(r.outcome(), "failed", "{}", r.location());
    assert_eq!(app.last_failure().await, "saml.replay");

    // A signed response (not assertion) with exactly one assertion is accepted too.
    let started = start(&app).await;
    let answer = Answer::new(
        &started.request_id,
        "lea.hoffmann@partnerportal.example",
        &["CN=Vertrieb,OU=Gruppen,DC=partnerportal,DC=example"],
    );
    let now = app.clock.now_ms();
    let xml = key.sign(&answer.response(now, &answer.assertion(now)), &answer.response_id);
    let r = deliver(&app, &started, &xml).await;
    assert_eq!(r.location(), "/dashboards", "{:?}", app.failures().await);

    // The accepted answer posted from another browser never opens a session there.
    let started = start(&app).await;
    let answer = Answer::new(&started.request_id, "lea.hoffmann@partnerportal.example", &[]);
    let r = app.post_answer(&answer.signed(&key, app.clock.now_ms())).await;
    let finish = r.location().strip_prefix(PUBLIC).unwrap().to_string();
    let r = app.get(&finish, "kalzit_sso=someone-else").await;
    assert_eq!(r.outcome(), "expired");
    assert!(r.cookie("kalzit_session").is_none());

    // Unmapped people are refused when the rule says so.
    let r = app.put("/api/admin/sign-in/unmapped", json!({ "rule": "refuse", "defaultRole": "viewer" }), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let started = start(&app).await;
    let answer = Answer::new(&started.request_id, "lea.hoffmann@partnerportal.example", &["Andere"]);
    let r = deliver(&app, &started, &answer.signed(&key, app.clock.now_ms())).await;
    assert_eq!(r.outcome(), "unmapped", "{}", r.location());
    let member: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE user_id = $1 AND org_id = $2")
        .bind(&user_id)
        .bind(&org)
        .fetch_optional(&app.state.db)
        .await
        .unwrap();
    assert!(member.is_none(), "the provider's membership goes with the refusal");
    app.finish().await;
}

#[tokio::test]
async fn saml_refuses_forged_wrapped_and_misaddressed_answers() {
    let app = test_app(Some(PUBLIC)).await;
    let (admin, _) = app.setup().await;
    let key = IdpKey::new("idp.partnerportal.example");
    let next = IdpKey::new("next.partnerportal.example");
    let stranger = IdpKey::new("evil.example");
    add_provider(&app, &admin, &[&key.cert_b64, &next.cert_b64]).await;
    let lea = "lea.hoffmann@partnerportal.example";

    // Each case: a fresh sign-in, the answer made by `make`, and the reason it is refused with.
    type Make = Box<dyn Fn(&Answer, i64) -> String>;
    type Tweak = Box<dyn Fn(&mut Answer)>;
    let k = Arc::new(key);
    let cases: Vec<(&str, Tweak, Make)> = vec![
        // Wrapping: the signed assertion hidden in Extensions, a forged one in its place.
        ("saml.assertion_count", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                let forged =
                    Answer { assertion_id: "_forged".into(), name_id: "admin".into(), ..a.clone() }.assertion(now);
                a.response(now, &format!("<samlp:Extensions>{signed}</samlp:Extensions>{forged}"))
            })
        }),
        // Wrapping: the response signature over another element than the one used.
        ("saml.wrapping", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let xml = a.response(now, &a.assertion(now));
                let signed = k.sign(&xml, &a.response_id);
                signed.replacen(&format!("URI=\"#{}\"", a.response_id), &format!("URI=\"#{}\"", a.assertion_id), 1)
            })
        }),
        // The NameID changed after signing.
        ("saml.signature_invalid", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                a.response(now, &signed.replace(&a.name_id, "admin"))
            })
        }),
        // A comment splitting the NameID (the classic truncation trick) is refused at parsing.
        ("saml.xml_invalid", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                a.response(now, &signed.replace(&a.name_id, &format!("{}<!---->.evil", a.name_id)))
            })
        }),
        // A DTD with an entity.
        ("saml.xml_invalid", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| format!("<!DOCTYPE r [<!ENTITY x \"y\">]>{}", a.signed(&k, now)))
        }),
        ("saml.unsigned", Box::new(|_| {}), Box::new(|a, now| a.response(now, &a.assertion(now)))),
        // Signed by a key that is not pinned.
        ("saml.signature_invalid", Box::new(|_| {}), Box::new(move |a, now| a.signed(&stranger, now))),
        ("saml.audience", Box::new(|a| a.audience = "https://other.example/sp".into()), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.expired", Box::new(|a| a.issued_offset_ms = -20 * 60 * 1000), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.not_yet_valid", Box::new(|a| a.issued_offset_ms = 4 * 60 * 1000), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.in_response_to", Box::new(|a| a.confirmation_in_response_to = "_another".into()), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.request_unknown", Box::new(|a| a.in_response_to = "_unknown".into()), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.destination", Box::new(|a| a.destination = "https://other.example/acs".into()), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.recipient", Box::new(|a| a.recipient = "https://other.example/acs".into()), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        ("saml.issuer", Box::new(|a| a.issuer = "https://evil.example/saml".into()), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        (
            "saml.name_id_transient",
            Box::new(|a| a.name_id_format = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient"),
            {
                let k = k.clone();
                Box::new(move |a, now| a.signed(&k, now))
            },
        ),
        ("saml.status", Box::new(|a| a.status = "urn:oasis:names:tc:SAML:2.0:status:Responder"), {
            let k = k.clone();
            Box::new(move |a, now| a.signed(&k, now))
        }),
        // Many signatures cost CPU: more than one on an element is refused before any is checked.
        ("saml.signature_unsupported", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                let sig = signature_of(&signed);
                a.response(now, &signed.replacen(&sig, &sig.repeat(40), 1))
            })
        }),
        // An ID repeated on another element, as `Id` or as `ID`.
        ("saml.wrapping", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let decoy = format!(
                    "<samlp:Extensions><x:Decoy xmlns:x=\"urn:x\" Id=\"{}\"/></samlp:Extensions>",
                    a.assertion_id
                );
                a.response(now, &format!("{decoy}{}", k.sign(&a.assertion(now), &a.assertion_id)))
            })
        }),
        ("saml.wrapping", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let decoy = format!(
                    "<samlp:Extensions><x:Decoy xmlns:x=\"urn:x\" ID=\"{}\"/></samlp:Extensions>",
                    a.assertion_id
                );
                a.response(now, &format!("{decoy}{}", k.sign(&a.assertion(now), &a.assertion_id)))
            })
        }),
        // An assertion inside Advice, even inside the signed one.
        ("saml.assertion_count", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let inner = "<saml:Advice><saml:Assertion ID=\"_inner\" Version=\"2.0\" \
                             IssueInstant=\"2027-01-15T08:00:00Z\"><saml:Issuer>x</saml:Issuer></saml:Assertion></saml:Advice>";
                let assertion =
                    a.assertion(now).replacen("</saml:Conditions>", &format!("</saml:Conditions>{inner}"), 1);
                a.response(now, &k.sign(&assertion, &a.assertion_id))
            })
        }),
        // A signature on another element than the response or assertion.
        ("saml.wrapping", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                let sig = signature_of(&signed);
                let moved =
                    signed.replacen(&sig, "", 1).replacen("</saml:Subject>", &format!("{sig}</saml:Subject>"), 1);
                a.response(now, &moved)
            })
        }),
        // An XPath transform and SHA-1 are refused before the signature is checked.
        ("saml.signature_unsupported", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                let xpath = signed.replacen(
                    "<ds:Transform Algorithm=\"http://www.w3.org/2001/10/xml-exc-c14n#\"/>",
                    "<ds:Transform Algorithm=\"http://www.w3.org/TR/1999/REC-xpath-19991116\"><ds:XPath>not(ancestor-or-self::saml:Subject)</ds:XPath></ds:Transform>",
                    1,
                );
                assert_ne!(xpath, signed, "the template has an exclusive C14N transform");
                a.response(now, &xpath)
            })
        }),
        ("saml.signature_unsupported", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                let sha1 = signed.replacen(
                    "http://www.w3.org/2001/04/xmlenc#sha256",
                    "http://www.w3.org/2000/09/xmldsig#sha1",
                    1,
                );
                assert_ne!(sha1, signed, "the template digests with SHA-256");
                a.response(now, &sha1)
            })
        }),
        ("saml.signature_unsupported", Box::new(|_| {}), {
            let k = k.clone();
            Box::new(move |a, now| {
                let signed = k.sign(&a.assertion(now), &a.assertion_id);
                a.response(now, &signed.replacen(ECDSA_SHA256, "http://www.w3.org/2000/09/xmldsig#rsa-sha1", 1))
            })
        }),
    ];
    for (reason, tweak, make) in cases {
        let started = start(&app).await;
        let mut answer = Answer::new(&started.request_id, lea, &[]);
        tweak(&mut answer);
        let r = deliver(&app, &started, &make(&answer, app.clock.now_ms())).await;
        assert!(r.cookie("kalzit_session").is_none(), "{reason}");
        assert!(r.location().starts_with("/anmelden?sso="), "{reason}: {}", r.location());
        assert_eq!(app.last_failure().await, reason, "{}", r.location());
    }

    // An answer without any request (IdP-initiated) is refused.
    let unsolicited = Answer::new("", lea, &[]).signed(&k, app.clock.now_ms()).replace(" InResponseTo=\"\"", "");
    let r = app.post_answer(&unsolicited).await;
    assert!(r.location().starts_with("/anmelden?sso=failed"), "{}", r.location());
    assert_eq!(app.last_failure().await, "saml.unsolicited");

    // A refused status names only SAML's own codes in the audit log.
    let started = start(&app).await;
    let made_up =
        Answer { status: "urn:oasis:names:tc:SAML:2.0:status:MadeUp", ..Answer::new(&started.request_id, lea, &[]) };
    let r = app.post_answer(&made_up.signed(&k, app.clock.now_ms())).await;
    assert!(r.location().starts_with("/anmelden?sso=failed"), "{}", r.location());
    let (summary,): (String,) = sqlx::query_as(
        "SELECT summary FROM audit_events WHERE action = 'auth.sso_failed' ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .fetch_one(&app.state.db)
    .await
    .unwrap();
    assert!(summary.contains("status other") && !summary.contains("MadeUp"), "{summary}");

    // Both the response and its assertion signed: accepted.
    let started = start(&app).await;
    let answer = Answer::new(&started.request_id, lea, &[]);
    let now = app.clock.now_ms();
    let both =
        k.sign(&answer.response(now, &k.sign(&answer.assertion(now), &answer.assertion_id)), &answer.response_id);
    let r = deliver(&app, &started, &both).await;
    assert_eq!(r.location(), "/dashboards", "{:?}", app.failures().await);

    // The second pinned certificate (a rollover) signs in; the clock may be a minute off.
    let started = start(&app).await;
    let answer = Answer { issued_offset_ms: 60 * 1000, ..Answer::new(&started.request_id, lea, &[]) };
    let r = deliver(&app, &started, &answer.signed(&next, app.clock.now_ms())).await;
    assert_eq!(r.location(), "/dashboards", "{:?}", app.failures().await);
    app.finish().await;
}

#[tokio::test]
async fn saml_never_signs_in_service_accounts() {
    let app = test_app(Some(PUBLIC)).await;
    let (admin, _) = app.setup().await;
    let key = IdpKey::new("idp.partnerportal.example");
    let provider_id = add_provider(&app, &admin, &[&key.cert_b64]).await;
    sqlx::query(
        "INSERT INTO users (id, email, name, created_at, service_account, email_confirmed) \
         VALUES ('svc', 'robot@partnerportal.example', 'Robot', 0, 1, 1)",
    )
    .execute(&app.state.db)
    .await
    .unwrap();

    // By its address (the provider's addresses are trusted here): refused, nothing linked.
    let started = start(&app).await;
    let r = deliver(
        &app,
        &started,
        &Answer::new(&started.request_id, "robot@partnerportal.example", &[]).signed(&key, app.clock.now_ms()),
    )
    .await;
    assert_eq!(r.outcome(), "email_taken", "{}", r.location());
    assert!(r.cookie("kalzit_session").is_none());
    assert_eq!(app.last_failure().await, "sso.service_account");

    // Through an identity linked to it: refused.
    sqlx::query(
        "INSERT INTO sso_identities (provider_id, subject, issuer, user_id, created_at, last_sign_in_at) \
         VALUES ($1, 'pp-robot', $2, 'svc', 0, 0)",
    )
    .bind(&provider_id)
    .bind(IDP)
    .execute(&app.state.db)
    .await
    .unwrap();
    let started = start(&app).await;
    let answer =
        Answer { name_id: "pp-robot".into(), ..Answer::new(&started.request_id, "other@partnerportal.example", &[]) };
    let r = deliver(&app, &started, &answer.signed(&key, app.clock.now_ms())).await;
    assert_eq!(r.outcome(), "failed", "{}", r.location());
    assert_eq!(app.last_failure().await, "sso.service_account");
    app.finish().await;
}

#[tokio::test]
async fn saml_second_factor_entity_change_and_own_address() {
    let app = test_app(Some(PUBLIC)).await;
    let (admin, _) = app.setup().await;
    let key = IdpKey::new("idp.partnerportal.example");
    let provider_id = add_provider(&app, &admin, &[&key.cert_b64]).await;
    let lea = "lea.hoffmann@partnerportal.example";
    const MFA: &str = "https://refeds.org/profile/mfa";

    // The account exists after a first sign-in; then it gets a passkey.
    let started = start(&app).await;
    let r = deliver(&app, &started, &Answer::new(&started.request_id, lea, &[]).signed(&key, app.clock.now_ms())).await;
    let me = app.get("/api/me", &session_of(&r)).await;
    let user_id = me.body["id"].as_str().unwrap().to_string();
    sqlx::query(
        "INSERT INTO user_passkeys (id, user_id, credential_id, name, credential, created_at) \
         VALUES ('pk-lea', $1, 'cred-lea', 'Schlüssel', '{}', 0)",
    )
    .bind(&user_id)
    .execute(&app.state.db)
    .await
    .unwrap();
    let sign_in_with = |context: &'static str| {
        let app = &app;
        let key = &key;
        async move {
            let started = start(app).await;
            let answer = Answer { authn_context: context, ..Answer::new(&started.request_id, lea, &[]) };
            deliver(app, &started, &answer.signed(key, app.clock.now_ms())).await
        }
    };
    let asks = "/anmelden?secondFactor=1&redirect=%2Fdashboards";

    // "Kalzit fragt" (the default): Kalzit asks, whatever the provider says.
    assert_eq!(sign_in_with(MFA).await.location(), asks);

    // Taking the provider's word: a context with several factors skips Kalzit's second factor.
    let detail = app.get(&format!("/api/admin/sign-in/providers/{provider_id}"), &admin).await;
    let mut saml = detail.body["saml"].clone();
    saml.as_object_mut().unwrap().remove("certificateInfo");
    let mut body = form(saml.clone());
    body["trustProviderMfa"] = json!(true);
    body["version"] = detail.body["version"].clone();
    let r = app.put(&format!("/api/admin/sign-in/saml/{provider_id}"), body, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(sign_in_with(MFA).await.location(), "/dashboards");
    assert_eq!(
        sign_in_with("urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport").await.location(),
        asks
    );

    // Another entity ID: the people linked through the old one are unlinked after confirming.
    let mut other = saml.clone();
    other["idpEntityId"] = json!("https://idp.neu.example/saml");
    other["metadataUrl"] = json!("");
    let check = app.post("/api/admin/sign-in/saml/check", form(other.clone()), &admin).await;
    assert_eq!(check.status, StatusCode::OK, "{}", check.body);
    let version = r.body["version"].clone();
    let mut body = form(check.body["saml"].clone());
    body["checkToken"] = check.body["checkToken"].clone();
    body["version"] = version;
    let r = app.put(&format!("/api/admin/sign-in/saml/{provider_id}"), body.clone(), &admin).await;
    assert_eq!(r.reason(), "sso.issuer_change_confirm", "{}", r.body);
    assert_eq!(r.body["error"]["field"], "idpEntityId");
    body["confirmIssuerChange"] = json!(true);
    let r = app.put(&format!("/api/admin/sign-in/saml/{provider_id}"), body, &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let (links,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sso_identities WHERE provider_id = $1")
        .bind(&provider_id)
        .fetch_one(&app.state.db)
        .await
        .unwrap();
    assert_eq!(links, 0);
    let (removed,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM audit_events WHERE action = 'sso.provider_identities_removed'")
            .fetch_one(&app.state.db)
            .await
            .unwrap();
    assert_eq!(removed, 1);

    // Metadata at Kalzit's own address is never read.
    let own = form(json!({ "metadataUrl": "http://127.0.0.1:3998/metadata.xml" }));
    let r = app.post("/api/admin/sign-in/saml/check", own, &admin).await;
    assert_eq!(r.reason(), "saml.metadata_unreachable", "{}", r.body);
    assert!(r.body["error"]["params"]["detail"].as_str().unwrap_or_default().contains("Kalzit"), "{}", r.body);
    app.finish().await;
}
