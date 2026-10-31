//! OpenID Connect: discovery, the provider's keys, the authorization request with state, nonce
//! and PKCE, the token exchange and the userinfo endpoint (OpenID Connect Core 1.0, RFC 7636).
//! Every request goes through Kalzit's HTTP client (`http`), so the target rules apply. Tokens
//! are never logged; errors carry only what an admin needs to find the cause.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::jwt::{self, JwkSet, TokenError};
use crate::datasources::targets::TargetPolicy;
use crate::http::{HttpClient, HttpError, HttpOptions};

/// Requests to one provider. Every URL, the issuer's and each endpoint its discovery names, gets
/// its own client: when its port is one of Kalzit's own, that client refuses every address of this
/// computer (`http::LocalGuard`), so no endpoint can point a request back at Kalzit. Redirects are
/// checked hop by hop: one to a port of Kalzit's from a client without that guard is refused.
pub struct Fetcher {
    policy: std::sync::Arc<TargetPolicy>,
    own_ports: Vec<u16>,
    timeout: std::time::Duration,
}

impl Fetcher {
    pub fn new(policy: std::sync::Arc<TargetPolicy>, own_ports: Vec<u16>, timeout: std::time::Duration) -> Self {
        Self { policy, own_ports, timeout }
    }

    fn own_port(&self, url: &Url) -> bool {
        url.port_or_known_default().is_some_and(|p| self.own_ports.contains(&p))
    }

    fn refused() -> crate::datasources::Detail {
        crate::datasources::Detail::new("sso.issuer_is_kalzit", "the address is this Kalzit server")
    }

    fn client(&self, url: &Url) -> Result<(HttpClient, bool), HttpError> {
        let guarded = self.own_port(url);
        let guard = guarded.then(|| crate::http::LocalGuard { refused: Self::refused(), private: None });
        let opts = HttpOptions { timeout: self.timeout, extra_root_pem: None, policy: self.policy.clone() };
        Ok((crate::http::client_guarded(opts, guard)?, guarded))
    }

    /// A GET that follows redirects, each hop checked.
    pub async fn get(&self, url: Url, headers: HeaderMap) -> Result<reqwest::Response, HttpError> {
        let (http, guarded) = self.client(&url)?;
        let hop = |_: &Method, next: &Url| {
            if !guarded && self.own_port(next) { Err(Self::refused()) } else { Ok(()) }
        };
        http.send_checked(Method::GET, url, headers, None, Some(&hop)).await
    }

    /// One POST that does not follow redirects (a token request carries the client secret).
    pub async fn post_once(&self, url: Url, headers: HeaderMap, body: Vec<u8>) -> Result<reqwest::Response, HttpError> {
        let (http, _) = self.client(&url)?;
        http.send_once(Method::POST, url, headers, Some(body)).await
    }
}

/// Largest discovery document, key set, token or userinfo answer read.
const MAX_ANSWER_BYTES: usize = 256 * 1024;
/// A discovery document and its keys are read again after this long.
pub const DISCOVERY_TTL: Duration = Duration::from_secs(60 * 60);
/// An unknown `kid` reloads the keys at most this often, so tokens with made-up key ids cannot
/// make Kalzit hammer the provider.
pub const KEY_RELOAD_INTERVAL: Duration = Duration::from_secs(60);

/// The settings of an OIDC provider, as stored (`sso_providers.config`) and edited. No secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OidcConfig {
    pub issuer: String,
    pub client_id: String,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
    #[serde(default = "default_groups_claim")]
    pub groups_claim: String,
    #[serde(default = "default_email_claim")]
    pub email_claim: String,
    #[serde(default = "default_name_claim")]
    pub name_claim: String,
    #[serde(default = "yes")]
    pub pkce: bool,
    #[serde(default)]
    pub trust_email: bool,
}

fn default_scopes() -> Vec<String> {
    ["openid", "email", "profile"].map(String::from).to_vec()
}
fn default_groups_claim() -> String {
    "groups".into()
}
fn default_email_claim() -> String {
    "email".into()
}
fn default_name_claim() -> String {
    "name".into()
}
fn yes() -> bool {
    true
}

impl OidcConfig {
    /// The scopes sent: the configured ones, `openid` always first.
    pub fn scope_param(&self) -> String {
        let mut scopes = vec!["openid"];
        scopes.extend(self.scopes.iter().map(String::as_str).filter(|s| *s != "openid"));
        scopes.join(" ")
    }
}

/// The discovery document, as far as Kalzit uses it.
#[derive(Clone, Debug, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
    pub jwks_uri: String,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

/// Why talking to a provider failed. `outcome` is what the person is told (docs/api/sso.md).
#[derive(Debug, Clone, thiserror::Error)]
pub enum OidcError {
    #[error("the discovery document cannot be read: {0}")]
    DiscoveryUnreachable(String),
    #[error("the discovery document is not valid: {0}")]
    DiscoveryInvalid(String),
    #[error("the discovery document names the issuer {0}")]
    IssuerMismatch(String),
    #[error("the provider's keys cannot be read: {0}")]
    KeysUnreachable(String),
    #[error("the provider offers no key Kalzit can use")]
    KeysInvalid,
    #[error("the token endpoint refused the client id or secret")]
    ClientRejected,
    #[error("the token endpoint cannot be reached: {0}")]
    TokenUnreachable(String),
    #[error("the token endpoint answered {status}: {error}")]
    TokenRefused { status: u16, error: String },
    #[error("the token endpoint's answer is not valid: {0}")]
    TokenInvalid(String),
    #[error(transparent)]
    IdToken(#[from] TokenError),
    #[error("the userinfo endpoint failed: {0}")]
    Userinfo(String),
}

impl OidcError {
    /// `unavailable` for a provider that cannot be reached or answers with an error, `failed`
    /// for an answer that is not valid.
    pub fn outcome(&self) -> &'static str {
        match self {
            Self::DiscoveryUnreachable(_) | Self::KeysUnreachable(_) | Self::TokenUnreachable(_) => "unavailable",
            Self::Userinfo(_) => "unavailable",
            _ => "failed",
        }
    }

    pub fn reason(&self) -> &'static str {
        match self {
            Self::DiscoveryUnreachable(_) => "sso.discovery_unreachable",
            Self::DiscoveryInvalid(_) => "sso.discovery_invalid",
            Self::IssuerMismatch(_) => "sso.issuer_mismatch",
            Self::KeysUnreachable(_) => "sso.keys_unreachable",
            Self::KeysInvalid => "sso.keys_invalid",
            Self::ClientRejected => "sso.client_rejected",
            Self::TokenUnreachable(_) => "sso.token_unreachable",
            Self::TokenRefused { .. } => "sso.token_refused",
            Self::TokenInvalid(_) => "sso.token_invalid",
            Self::IdToken(_) => "sso.id_token_invalid",
            Self::Userinfo(_) => "sso.userinfo_failed",
        }
    }
}

fn http_text(e: &HttpError) -> String {
    e.detail().message
}

/// The base URL check for the issuer and every endpoint: `https`, or `http` to a loopback
/// address or `localhost`; no credentials, query or fragment for the issuer.
pub fn check_endpoint(raw: &str) -> Option<Url> {
    let url = Url::parse(raw).ok()?;
    let host = url.host_str()?;
    let loopback = host == "localhost"
        || host.ends_with(".localhost")
        || crate::datasources::targets::parse_ip_literal(host).is_some_and(|ip| ip.is_loopback());
    let scheme_ok = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    (scheme_ok && url.username().is_empty() && url.password().is_none()).then_some(url)
}

pub fn check_issuer(raw: &str) -> Option<Url> {
    let url = check_endpoint(raw)?;
    (url.query().is_none() && url.fragment().is_none() && raw.len() <= 2048).then_some(url)
}

async fn get_json(http: &Fetcher, url: Url, bearer: Option<&str>) -> Result<(StatusCode, Vec<u8>), HttpError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if let Some(token) = bearer {
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| HttpError::Other("the access token is not a valid header".into()))?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    let response = http.get(url, headers).await?;
    let status = response.status();
    Ok((status, crate::http::read_limited(response, MAX_ANSWER_BYTES).await?))
}

/// Reads the discovery document of `issuer`; its `issuer` must be the same string exactly.
pub async fn discover(http: &Fetcher, issuer: &str) -> Result<Discovery, OidcError> {
    let base = issuer.trim_end_matches('/');
    let url = Url::parse(&format!("{base}/.well-known/openid-configuration"))
        .map_err(|e| OidcError::DiscoveryInvalid(e.to_string()))?;
    let (status, body) = get_json(http, url, None).await.map_err(|e| OidcError::DiscoveryUnreachable(http_text(&e)))?;
    if !status.is_success() {
        return Err(OidcError::DiscoveryUnreachable(format!("HTTP {}", status.as_u16())));
    }
    let doc: Discovery = serde_json::from_slice(&body)
        .map_err(|e| OidcError::DiscoveryInvalid(format!("not a discovery document: {e}")))?;
    if doc.issuer != issuer {
        return Err(OidcError::IssuerMismatch(doc.issuer));
    }
    for (name, endpoint) in [
        ("authorization_endpoint", Some(&doc.authorization_endpoint)),
        ("token_endpoint", Some(&doc.token_endpoint)),
        ("jwks_uri", Some(&doc.jwks_uri)),
        ("userinfo_endpoint", doc.userinfo_endpoint.as_ref()),
    ] {
        if let Some(e) = endpoint
            && check_endpoint(e).is_none()
        {
            return Err(OidcError::DiscoveryInvalid(format!("{name} is not an https address")));
        }
    }
    Ok(doc)
}

pub async fn load_keys(http: &Fetcher, jwks_uri: &str) -> Result<JwkSet, OidcError> {
    let url = Url::parse(jwks_uri).map_err(|e| OidcError::KeysUnreachable(e.to_string()))?;
    let (status, body) = get_json(http, url, None).await.map_err(|e| OidcError::KeysUnreachable(http_text(&e)))?;
    if !status.is_success() {
        return Err(OidcError::KeysUnreachable(format!("HTTP {}", status.as_u16())));
    }
    let keys: JwkSet = serde_json::from_slice(&body).map_err(|_| OidcError::KeysInvalid)?;
    if keys.usable() == 0 {
        return Err(OidcError::KeysInvalid);
    }
    Ok(keys)
}

/// The random values of one sign-in.
pub struct Request {
    pub state: String,
    pub nonce: String,
    pub verifier: Option<String>,
}

pub fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

impl Request {
    pub fn new(pkce: bool) -> Self {
        Self { state: random_token(), nonce: random_token(), verifier: pkce.then(random_token) }
    }
}

/// The PKCE challenge of `verifier` (`S256`).
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn authorization_url(
    discovery: &Discovery,
    config: &OidcConfig,
    redirect_uri: &str,
    request: &Request,
) -> Result<Url, OidcError> {
    let mut url = Url::parse(&discovery.authorization_endpoint)
        .map_err(|e| OidcError::DiscoveryInvalid(format!("authorization_endpoint: {e}")))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", &config.scope_param())
            .append_pair("state", &request.state)
            .append_pair("nonce", &request.nonce);
        if let Some(verifier) = &request.verifier {
            q.append_pair("code_challenge", &challenge(verifier)).append_pair("code_challenge_method", "S256");
        }
    }
    Ok(url)
}

/// What the token endpoint answered.
pub struct Tokens {
    pub id_token: String,
    pub access_token: Option<String>,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tokens { .. }")
    }
}

#[derive(Deserialize)]
struct TokenAnswer {
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// `client_secret_basic` unless the provider lists only `client_secret_post`.
fn uses_basic(discovery: &Discovery) -> bool {
    match &discovery.token_endpoint_auth_methods_supported {
        Some(methods) => {
            methods.iter().any(|m| m == "client_secret_basic") || !methods.iter().any(|m| m == "client_secret_post")
        }
        None => true,
    }
}

fn form_body(pairs: &[(&str, &str)]) -> Vec<u8> {
    let mut body = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        body.append_pair(k, v);
    }
    body.finish().into_bytes()
}

async fn token_request(
    http: &Fetcher,
    discovery: &Discovery,
    config: &OidcConfig,
    secret: &str,
    form: &[(&str, &str)],
) -> Result<(StatusCode, TokenAnswer), OidcError> {
    let url = Url::parse(&discovery.token_endpoint).map_err(|e| OidcError::DiscoveryInvalid(e.to_string()))?;
    let basic = uses_basic(discovery);
    let mut pairs = form.to_vec();
    if !basic {
        pairs.push(("client_id", &config.client_id));
        pairs.push(("client_secret", secret));
    }
    // Built apart: the serializer is not `Send`, so it must not live across an await.
    let body = form_body(&pairs);
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/x-www-form-urlencoded"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    if basic {
        // RFC 6749, 2.3.1: both parts form-encoded before they are joined.
        let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
        let pair = format!("{}:{}", enc(&config.client_id), enc(secret));
        let mut value = HeaderValue::from_str(&format!("Basic {}", STANDARD.encode(pair)))
            .map_err(|_| OidcError::TokenInvalid("client credentials are not a valid header".into()))?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    let response = http.post_once(url, headers, body).await.map_err(|e| OidcError::TokenUnreachable(http_text(&e)))?;
    let status = response.status();
    let bytes = crate::http::read_limited(response, MAX_ANSWER_BYTES)
        .await
        .map_err(|e| OidcError::TokenUnreachable(http_text(&e)))?;
    let answer: TokenAnswer = serde_json::from_slice(&bytes)
        .map_err(|_| OidcError::TokenInvalid(format!("HTTP {} without a JSON answer", status.as_u16())))?;
    Ok((status, answer))
}

/// Exchanges the authorization code for tokens.
pub async fn exchange(
    http: &Fetcher,
    discovery: &Discovery,
    config: &OidcConfig,
    secret: &str,
    code: &str,
    redirect_uri: &str,
    verifier: Option<&str>,
) -> Result<Tokens, OidcError> {
    let mut form = vec![("grant_type", "authorization_code"), ("code", code), ("redirect_uri", redirect_uri)];
    if let Some(v) = verifier {
        form.push(("code_verifier", v));
    }
    let (status, answer) = token_request(http, discovery, config, secret, &form).await?;
    if !status.is_success() {
        let error = answer.error.unwrap_or_default();
        if error == "invalid_client" {
            return Err(OidcError::ClientRejected);
        }
        return Err(OidcError::TokenRefused { status: status.as_u16(), error: clean_error(&error) });
    }
    let id_token = answer.id_token.ok_or_else(|| OidcError::TokenInvalid("no id_token in the answer".into()))?;
    Ok(Tokens { id_token, access_token: answer.access_token })
}

/// An error code of the provider, kept short and printable for the audit log.
fn clean_error(error: &str) -> String {
    error.chars().filter(|c| c.is_ascii_graphic()).take(64).collect()
}

/// Offers the client to the token endpoint with a made-up code: `Some(true)` when the provider
/// accepted the client (and only refused the code), `Some(false)` when it refused the client,
/// `None` when its answer does not say.
pub async fn probe_client(
    http: &Fetcher,
    discovery: &Discovery,
    config: &OidcConfig,
    secret: &str,
    redirect_uri: &str,
) -> Result<Option<bool>, OidcError> {
    let code = format!("kalzit-connection-check-{}", random_token());
    let form = [("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", redirect_uri)];
    match token_request(http, discovery, config, secret, &form).await {
        Ok((status, answer)) => Ok(match answer.error.as_deref() {
            Some("invalid_client" | "unauthorized_client") if status == StatusCode::UNAUTHORIZED => Some(false),
            Some("invalid_client") => Some(false),
            Some("invalid_grant") => Some(true),
            _ => None,
        }),
        // An answer that is not JSON says nothing about the client.
        Err(OidcError::TokenInvalid(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// The claims of the userinfo endpoint; its `sub` must be the ID token's.
pub async fn userinfo(
    http: &Fetcher,
    discovery: &Discovery,
    access_token: &str,
    subject: &str,
) -> Result<Map<String, Value>, OidcError> {
    let Some(endpoint) = &discovery.userinfo_endpoint else { return Ok(Map::new()) };
    let url = Url::parse(endpoint).map_err(|e| OidcError::Userinfo(e.to_string()))?;
    let (status, body) =
        get_json(http, url, Some(access_token)).await.map_err(|e| OidcError::Userinfo(http_text(&e)))?;
    if !status.is_success() {
        return Err(OidcError::Userinfo(format!("HTTP {}", status.as_u16())));
    }
    // A signed userinfo answer (JWT) is not read; the ID token is what proves the person.
    let claims: Map<String, Value> =
        serde_json::from_slice(&body).map_err(|_| OidcError::Userinfo("the answer is not JSON".into()))?;
    if claims.get("sub").and_then(Value::as_str) != Some(subject) {
        return Err(OidcError::Userinfo("the answer is about another subject".into()));
    }
    Ok(claims)
}

/// A provider's discovery and keys, kept between sign-ins.
#[derive(Clone)]
pub struct Cached {
    pub discovery: Discovery,
    pub keys: JwkSet,
    /// When the document and the keys were read, on the server's monotonic clock (ms).
    pub loaded_ms: i64,
    pub keys_loaded_ms: i64,
}

/// What a sign-in learned about the person.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub subject: String,
    pub username: Option<String>,
    pub email: Option<String>,
    /// The same address as Kalzit keeps typed-in ones (`routes::normalize_email`: the domain as
    /// written), so an account made with an internationalized domain is found either way.
    #[serde(skip)]
    pub email_as_typed: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
    pub groups: Vec<String>,
    /// The provider said it checked several factors (`amr`).
    #[serde(skip)]
    pub mfa_done: bool,
}

/// Reads the person from the checked ID token's claims, with the userinfo claims added (the ID
/// token wins where both have a claim).
pub fn person(config: &OidcConfig, id_claims: &Map<String, Value>, userinfo: &Map<String, Value>) -> Person {
    let claim = |name: &str| id_claims.get(name).or_else(|| userinfo.get(name));
    let text = |name: &str| {
        claim(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(256).collect())
    };
    let groups = match claim(&config.groups_claim) {
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        // One group, or several separated by commas; never split on spaces, which group names
        // (such as LDAP distinguished names) contain.
        Some(Value::String(one)) => {
            one.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
        }
        _ => Vec::new(),
    };
    let mut groups: Vec<String> = groups
        .into_iter()
        .filter(|g| !g.is_empty() && g.chars().count() <= 256 && !g.chars().any(char::is_control))
        .collect();
    groups.sort();
    groups.dedup();
    groups.truncate(500);
    // `email_verified` speaks about the `email` claim only; another email claim counts as verified
    // only through the provider's switch.
    let verified = config.email_claim == "email"
        && match claim("email_verified") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s == "true",
            _ => false,
        };
    let amr: Vec<&str> = match id_claims.get("amr") {
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    Person {
        subject: id_claims.get("sub").and_then(Value::as_str).unwrap_or_default().to_string(),
        username: text("preferred_username"),
        email: text(&config.email_claim).and_then(|e: String| matching_email(&e)),
        email_as_typed: text(&config.email_claim)
            .filter(|e: &String| matching_email(e).is_some())
            .and_then(|e| crate::routes::normalize_email(&e).ok()),
        email_verified: verified || config.trust_email,
        name: text(&config.name_claim),
        groups,
        mfa_done: several_factors(&amr),
    }
}

/// Whether `amr` (RFC 8176) says the provider checked several factors: `mfa`, or methods of two
/// different kinds (something known, something held, something one is). One kind alone, such as a
/// one-time code without a password, is one factor.
pub fn several_factors(amr: &[&str]) -> bool {
    if amr.contains(&"mfa") {
        return true;
    }
    let kind = |m: &str| match m {
        "pwd" | "pin" | "kba" => Some(0),
        "otp" | "hwk" | "swk" | "sc" | "sms" | "tel" => Some(1),
        "fpt" | "face" | "iris" | "retina" | "vbm" => Some(2),
        _ => None,
    };
    let kinds: std::collections::BTreeSet<u8> = amr.iter().filter_map(|m| kind(m)).collect();
    kinds.len() >= 2
}

/// The form of an email Kalzit compares with its accounts: an ASCII local part in lowercase and
/// the domain in its ASCII (IDNA) form. Other local parts are not used, since Unicode case folding
/// makes different addresses look alike (the Kelvin sign `\u{212A}` folds to `k`).
pub fn matching_email(raw: &str) -> Option<String> {
    let (local, domain) = raw.trim().rsplit_once('@')?;
    if local.is_empty() || !local.is_ascii() || local.bytes().any(|b| b.is_ascii_control() || b == b' ') {
        return None;
    }
    let domain = match url::Host::parse(domain).ok()? {
        url::Host::Domain(d) => d,
        _ => return None,
    };
    crate::routes::normalize_email(&format!("{}@{domain}", local.to_ascii_lowercase())).ok()
}

/// Checks an ID token against the provider's keys and the sign-in.
pub fn check_id_token(
    token: &str,
    keys: &JwkSet,
    expected: &jwt::Expected<'_>,
) -> Result<Map<String, Value>, TokenError> {
    let parsed = jwt::parse(token)?;
    parsed.verify(keys)?;
    jwt::check_claims(parsed.claims(), expected)?;
    Ok(parsed.claims().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> OidcConfig {
        serde_json::from_value(json!({ "issuer": "https://idp.example", "clientId": "kalzit" })).unwrap()
    }

    #[test]
    fn endpoints_need_https_except_on_loopback() {
        assert!(check_issuer("https://idp.example/realms/k").is_some());
        assert!(check_issuer("http://127.0.0.1:8080").is_some());
        assert!(check_issuer("http://localhost:8080").is_some());
        assert!(check_issuer("http://idp.example").is_none());
        assert!(check_issuer("https://u:p@idp.example").is_none());
        assert!(check_issuer("https://idp.example?x=1").is_none());
        assert!(check_issuer("ftp://idp.example").is_none());
    }

    #[test]
    fn the_authorization_request_carries_state_nonce_and_pkce() {
        let discovery = Discovery {
            issuer: "https://idp.example".into(),
            authorization_endpoint: "https://idp.example/auth?tenant=a".into(),
            token_endpoint: "https://idp.example/token".into(),
            userinfo_endpoint: None,
            jwks_uri: "https://idp.example/jwks".into(),
            token_endpoint_auth_methods_supported: None,
        };
        let request = Request::new(true);
        let url = authorization_url(&discovery, &config(), "https://k.example/cb", &request).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["tenant"], "a");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "openid email profile");
        assert_eq!(q["state"], request.state);
        assert_eq!(q["nonce"], request.nonce);
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], challenge(request.verifier.as_deref().unwrap()));
        assert_ne!(request.state, request.nonce);
        // RFC 7636, appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(Request::new(false).verifier.is_none());
    }

    #[test]
    fn the_person_comes_from_the_claims() {
        let mut c = config();
        c.groups_claim = "roles".into();
        let id = json!({ "sub": "s-1", "email": "Lea@Example.DE", "email_verified": true, "name": " Lea ",
                         "roles": ["b", "a", "a", "\u{7}x"], "amr": ["pwd", "mfa"] });
        let info = json!({ "sub": "s-1", "preferred_username": "l.hoffmann", "name": "other" });
        let p = person(&c, id.as_object().unwrap(), info.as_object().unwrap());
        assert_eq!(p.subject, "s-1");
        assert_eq!(p.email.as_deref(), Some("lea@example.de"));
        assert!(p.email_verified && p.mfa_done);
        assert_eq!(p.name.as_deref(), Some("Lea"));
        assert_eq!(p.username.as_deref(), Some("l.hoffmann"));
        assert_eq!(p.groups, ["a", "b"]);
        let p = person(&config(), json!({ "sub": "s", "amr": ["pwd"] }).as_object().unwrap(), &Map::new());
        assert!(!p.email_verified && !p.mfa_done && p.groups.is_empty());
    }

    #[test]
    fn email_verified_speaks_only_about_the_email_claim() {
        let id = json!({ "sub": "s", "email": "a@example.de", "upn": "b@example.de", "email_verified": true });
        let mut c = config();
        c.email_claim = "upn".into();
        let p = person(&c, id.as_object().unwrap(), &Map::new());
        assert_eq!(p.email.as_deref(), Some("b@example.de"));
        assert!(!p.email_verified, "email_verified is about `email`, not `upn`");
        c.trust_email = true;
        assert!(person(&c, id.as_object().unwrap(), &Map::new()).email_verified);
    }

    #[test]
    fn a_string_groups_claim_splits_on_commas_only() {
        let id = json!({ "sub": "s", "groups": "CN=Kalzit Leser,OU=Gruppen , admins" });
        let p = person(&config(), id.as_object().unwrap(), &Map::new());
        assert_eq!(p.groups, ["CN=Kalzit Leser", "OU=Gruppen", "admins"]);
        let id = json!({ "sub": "s", "groups": "Kalzit Leser" });
        assert_eq!(person(&config(), id.as_object().unwrap(), &Map::new()).groups, ["Kalzit Leser"]);
    }

    #[test]
    fn several_factors_need_mfa_or_two_kinds() {
        assert!(several_factors(&["mfa"]));
        assert!(several_factors(&["pwd", "otp"]));
        assert!(several_factors(&["hwk", "fpt"]));
        for one in [&["otp"][..], &["hwk"], &["sc"], &["pwd"], &["otp", "hwk"], &["pwd", "pin"], &[]] {
            assert!(!several_factors(one), "{one:?}");
        }
    }

    #[test]
    fn emails_match_in_an_ascii_form() {
        assert_eq!(matching_email("Lea.Hoffmann@Example.DE").as_deref(), Some("lea.hoffmann@example.de"));
        assert_eq!(matching_email("lea@bücher.example").as_deref(), Some("lea@xn--bcher-kva.example"));
        // The Kelvin sign folds to `k` in Unicode; such a local part is never matched.
        assert_eq!(matching_email("\u{212A}ate@example.de"), None);
        assert_eq!(matching_email("jörg@example.de"), None);
        assert_eq!(matching_email("no-at-sign"), None);
    }
}
