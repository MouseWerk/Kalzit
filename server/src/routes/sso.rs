//! Single sign-on (docs/api/sso.md): the provider buttons and the sign-in through a provider, the
//! break-glass form, and the administration of providers, group mappings and the local sign-in.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::support::{Actor, audit, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::second_factor::FirstStep;
use crate::auth::{SessionUser, session};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::sso::mapping::{self, Outcome};
use crate::sso::oidc::{self, OidcConfig, OidcError, Person};
use crate::sso::store::{self, CLIENT_SECRET, ProviderRow};

pub fn routes() -> Vec<RouteDef> {
    use Method as M;
    vec![
        route(M::GET, "/auth/providers", Access::Public, providers_public),
        route(M::GET, "/auth/sso/{slug}/start", Access::Public, start),
        route(M::POST, "/auth/login/local", Access::Public, login_local),
        route(M::GET, "/admin/sign-in", Access::ServerAdmin, overview),
        route(M::GET, "/admin/sign-in/providers/{providerId}", Access::ServerAdmin, provider_detail),
        route(M::POST, "/admin/sign-in/providers/check", Access::ServerAdmin, check),
        route(M::POST, "/admin/sign-in/providers", Access::ServerAdmin, create),
        route(M::PUT, "/admin/sign-in/providers/{providerId}", Access::ServerAdmin, update),
        route(M::PATCH, "/admin/sign-in/providers/{providerId}/enabled", Access::ServerAdmin, set_enabled),
        route(M::DELETE, "/admin/sign-in/providers/{providerId}", Access::ServerAdmin, delete),
        route(M::PUT, "/admin/sign-in/order", Access::ServerAdmin, reorder),
        route(M::POST, "/admin/sign-in/test-sign-ins", Access::ServerAdmin, test_start),
        route(M::GET, "/admin/sign-in/test-sign-ins/{testId}", Access::ServerAdmin, test_result),
        route(M::GET, "/admin/sign-in/mappings", Access::ServerAdmin, mappings),
        route(M::POST, "/admin/sign-in/mappings", Access::ServerAdmin, mapping_create),
        route(M::PATCH, "/admin/sign-in/mappings/{mappingId}", Access::ServerAdmin, mapping_update),
        route(M::DELETE, "/admin/sign-in/mappings/{mappingId}", Access::ServerAdmin, mapping_delete),
        route(M::PUT, "/admin/sign-in/unmapped", Access::ServerAdmin, set_unmapped),
        route(M::POST, "/admin/sign-in/mappings/preview", Access::ServerAdmin, preview),
        route(M::GET, "/admin/sign-in/local", Access::ServerAdmin, local),
        route(M::PUT, "/admin/sign-in/local", Access::ServerAdmin, set_local),
    ]
}

/// The callback path outside `/api`, the redirect URI providers send the browser back to.
pub const CALLBACK_ROUTE: &str = "/auth/oidc/{slug}/callback";
/// The cookie that binds a sign-in to the browser that started it.
const BINDING_COOKIE: &str = "kalzit_sso";
const SECURE_BINDING_COOKIE: &str = "__Host-kalzit_sso";
/// A connection check is good for saving this long.
const CHECK_VALID_MS: i64 = 30 * 60 * 1000;

pub(crate) fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn binding_cookie(secure: bool) -> &'static str {
    if secure { SECURE_BINDING_COOKIE } else { BINDING_COOKIE }
}

fn set_binding(value: &str, secure: bool) -> HeaderValue {
    let max_age = crate::sso::SIGN_IN_TTL_MS / 1000;
    session::cookie_header(&format!("{}={value}; Max-Age={max_age}", binding_cookie(secure)), secure)
}

fn clear_binding(secure: bool) -> HeaderValue {
    session::cookie_header(&format!("{}=; Max-Age=0", binding_cookie(secure)), secure)
}

fn see_other(location: &str, cookies: Vec<HeaderValue>) -> Response {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(location) {
        headers.insert(header::LOCATION, value);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    for cookie in cookies {
        headers.append(header::SET_COOKIE, cookie);
    }
    (StatusCode::SEE_OTHER, headers).into_response()
}

fn sign_in_page(outcome: &str, slug: &str, error_ref: Option<&str>) -> String {
    let mut url = format!("/anmelden?sso={outcome}");
    if crate::sso::valid_slug(slug) {
        url.push_str(&format!("&provider={slug}"));
    }
    if let Some(r) = error_ref {
        url.push_str(&format!("&ref={r}"));
    }
    url
}

/// Records a failed sign-in through a provider for admins and answers its error id.
pub(crate) async fn record_failure(
    state: &AppState,
    info: &RequestInfo,
    provider: Option<(&str, &str)>,
    user_id: Option<&str>,
    reason: &str,
    detail: &str,
) -> String {
    let error_ref = crate::sso::error_ref();
    tracing::info!(client = %info.client_ip, error_ref, reason, "single sign-on failed: {detail}");
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: user_id,
        actor_address: Some(info.client_ip.to_string()),
        action: "auth.sso_failed",
        resource_type: Some("sso_provider"),
        resource_id: provider.map(|p| p.0),
        summary: json!({ "provider": provider.map(|p| p.1), "ref": error_ref, "reason": reason, "detail": detail }),
        at_ms: state.clock.now_ms(),
    };
    let recorded = match state.db.acquire().await {
        Ok(mut conn) => crate::audit::record(&mut conn, &event).await,
        Err(e) => Err(e),
    };
    if let Err(e) = recorded {
        tracing::warn!("recording a failed single sign-on in the audit log failed: {e}");
    }
    error_ref
}

// ---------------------------------------------------------------------------------------------
// Signing in

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicProvider {
    slug: String,
    name: String,
    kind: String,
}

async fn providers_public(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let providers: Vec<PublicProvider> = store::all(&state.read_db)
        .await?
        .into_iter()
        .filter(|p| p.enabled != 0)
        .map(|p| PublicProvider { slug: p.slug, name: p.name, kind: p.kind })
        .collect();
    let policy = crate::sso::local_policy(&state).await?;
    Ok(Json(json!({
        "providers": providers,
        "passwordForm": policy.password_form,
        "localSignIn": policy.local_on,
    })))
}

async fn start(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(slug): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    use crate::auth::ratelimit::{address_key, network_key};
    let mono = state.clock.monotonic_ms();
    if state
        .sso
        .start_limiter
        .try_acquire(&address_key("sso-start", info.client_ip), &network_key(info.client_ip), mono)
        .is_err()
    {
        return Ok(see_other(&sign_in_page("unavailable", &slug, None), Vec::new()));
    }
    let provider = store::by_slug(&state.read_db, &slug).await?.filter(|p| p.enabled != 0 && p.kind == "oidc");
    let Some(provider) = provider else {
        return Ok(see_other(&sign_in_page("unavailable", &slug, None), Vec::new()));
    };
    let config = provider.oidc()?;
    let return_to = crate::sso::safe_return_to(query.get("returnTo").map(String::as_str));
    let redirect_uri = crate::sso::redirect_uri(&crate::sso::public_base(&state, &info), &provider.slug);
    let http = state.sso.client(&state);
    let prepared = state.sso.provider(&http, &config, false, state.clock.monotonic_ms()).await;
    let cached = match prepared {
        Ok(c) => c,
        Err(e) => {
            let r =
                record_failure(&state, &info, Some((&provider.id, &provider.slug)), None, e.reason(), &e.to_string())
                    .await;
            return Ok(see_other(&sign_in_page("unavailable", &slug, Some(&r)), Vec::new()));
        }
    };
    let request = oidc::Request::new(config.pkce);
    let url = match oidc::authorization_url(&cached.discovery, &config, &redirect_uri, &request) {
        Ok(url) => url,
        Err(e) => {
            let r =
                record_failure(&state, &info, Some((&provider.id, &provider.slug)), None, e.reason(), &e.to_string())
                    .await;
            return Ok(see_other(&sign_in_page("unavailable", &slug, Some(&r)), Vec::new()));
        }
    };
    let binding = oidc::random_token();
    let now = state.clock.now_ms();
    sqlx::query(
        "INSERT INTO sso_sign_ins (id, state_hash, binding_hash, provider_id, purpose, nonce, verifier, redirect_uri, \
         return_to, status, created_at, expires_at) VALUES ($1, $2, $3, $4, 'sign_in', $5, $6, $7, $8, 'pending', $9, $10)",
    )
    .bind(super::new_id())
    .bind(hash(&request.state))
    .bind(hash(&binding))
    .bind(&provider.id)
    .bind(&request.nonce)
    .bind(request.verifier.as_deref())
    .bind(&redirect_uri)
    .bind(&return_to)
    .bind(now)
    .bind(now + crate::sso::SIGN_IN_TTL_MS)
    .execute(&state.db)
    .await?;
    Ok(see_other(url.as_str(), vec![set_binding(&binding, info.https)]))
}

#[derive(sqlx::FromRow)]
struct SignInRow {
    id: String,
    provider_id: Option<String>,
    purpose: String,
    nonce: String,
    verifier: Option<String>,
    redirect_uri: String,
    return_to: String,
    draft: Option<String>,
    draft_secret_key_id: Option<String>,
    draft_secret_nonce: Option<String>,
    draft_secret: Option<String>,
}

/// The form a test sign-in tests, as kept with it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    slug: String,
    provider_id: Option<String>,
    config: OidcConfig,
}

/// What the callback works with: the provider (stored or the tested form) and its secret.
struct Target {
    provider: ProviderRow,
    config: OidcConfig,
    secret: zeroize::Zeroizing<String>,
}

pub async fn callback(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    match callback_inner(&state, &info, &slug, &headers, &query).await {
        Ok(response) => response,
        Err(e) => {
            let r = record_failure(&state, &info, None, None, "sso.internal", &e.message).await;
            see_other(&sign_in_page("unavailable", &slug, Some(&r)), vec![clear_binding(info.https)])
        }
    }
}

async fn callback_inner(
    state: &AppState,
    info: &RequestInfo,
    slug: &str,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    let clear = || vec![clear_binding(info.https)];
    let expired = |r: String| see_other(&sign_in_page("expired", slug, Some(&r)), clear());
    let Some(state_param) = query.get("state").filter(|s| s.len() <= 512) else {
        let r = record_failure(state, info, None, None, "sso.state_missing", "the provider sent no state").await;
        return Ok(expired(r));
    };
    // Each start works once, and only in the browser that started it: the row is taken, with its
    // binding cookie, before anything else happens.
    let binding = session::cookie_value(headers, binding_cookie(info.https)).unwrap_or_default();
    let taken = sqlx::query(
        "UPDATE sso_sign_ins SET status = 'running' WHERE state_hash = $1 AND binding_hash = $2 \
         AND status = 'pending' AND expires_at > $3",
    )
    .bind(hash(state_param))
    .bind(hash(&binding))
    .bind(now)
    .execute(&state.db)
    .await?
    .rows_affected();
    let row: Option<SignInRow> = if taken == 1 && !binding.is_empty() {
        sqlx::query_as(
            "SELECT id, provider_id, purpose, nonce, verifier, redirect_uri, return_to, draft, \
             draft_secret_key_id, draft_secret_nonce, draft_secret FROM sso_sign_ins WHERE state_hash = $1",
        )
        .bind(hash(state_param))
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };
    let Some(row) = row else {
        let r = record_failure(state, info, None, None, "sso.state_unknown", "the sign-in is unknown, used or expired")
            .await;
        return Ok(expired(r));
    };
    let test = row.purpose == "test";
    let target = match load_target(state, &row, slug).await? {
        Some(t) => t,
        None => {
            let r =
                record_failure(state, info, None, None, "sso.provider_unavailable", "the provider is paused or gone")
                    .await;
            finish_row(state, &row, test, Err(("unavailable", "sso.outcome_unavailable"))).await?;
            return Ok(see_other(&sign_in_page("unavailable", slug, Some(&r)), clear()));
        }
    };
    let ids = (target.provider.id.as_str(), target.provider.slug.as_str());
    let row_ref = &row;
    let fail = move |outcome: &'static str, reason: &'static str, detail: String, user: Option<String>| async move {
        let r = record_failure(state, info, Some(ids), user.as_deref(), reason, &detail).await;
        finish_row(state, row_ref, test, Err((outcome, outcome_reason(outcome)))).await?;
        let page = if test { "/anmelden/sso-test".to_string() } else { sign_in_page(outcome, slug, Some(&r)) };
        Ok::<Response, ApiError>(see_other(&page, clear()))
    };
    // RFC 9207: a provider that names itself in the answer must be the one asked (no mix-up).
    if let Some(iss) = query.get("iss")
        && iss != &target.config.issuer
    {
        return fail("failed", "sso.iss_mismatch", "the answer names another issuer".into(), None).await;
    }
    if let Some(error) = query.get("error") {
        let code: String = error.chars().filter(char::is_ascii_graphic).take(64).collect();
        let outcome = if code == "access_denied" { "cancelled" } else { "failed" };
        return fail(outcome, "sso.provider_error", format!("the provider answered {code}"), None).await;
    }
    let Some(code) = query.get("code").filter(|c| !c.is_empty() && c.len() <= 4096) else {
        return fail("failed", "sso.code_missing", "the provider sent no code".into(), None).await;
    };
    let person = match person(state, &target, &row, code, now).await {
        Ok(p) => p,
        Err(e) => return fail(e.outcome(), e.reason(), e.to_string(), None).await,
    };
    if test {
        let outcome = test_outcome(state, &target, &person).await?;
        let result = json!({
            "subject": person.subject, "username": person.username, "email": person.email,
            "groups": person.groups, "outcome": outcome,
        });
        finish_row(state, &row, true, Ok(result)).await?;
        return Ok(see_other("/anmelden/sso-test", clear()));
    }
    sqlx::query("DELETE FROM sso_sign_ins WHERE id = $1").bind(&row.id).execute(&state.db).await?;
    use crate::sso::signin;
    let refuse = |refusal: signin::Refusal| async move {
        let r =
            record_failure(state, info, Some(ids), refusal.user_id.as_deref(), refusal.reason, &refusal.detail).await;
        see_other(&sign_in_page(refusal.outcome, slug, Some(&r)), clear())
    };
    // The account and its identity (`sso::signin`, which also explains the order below).
    let mut tx = crate::db::begin(&state.db).await?;
    let issuer = target.config.issuer.as_str();
    let linked = match signin::account(&mut tx, state, info, &target.provider, issuer, &person, now).await? {
        Ok(l) => l,
        Err(refusal) => {
            drop(tx);
            return Ok(refuse(refusal).await);
        }
    };
    let outcome = signin::decide(&mut tx, state, &target.provider.id, &linked, &person.groups).await?;
    if let Some(o) = outcome.as_ref().filter(|o| o.refused) {
        // Refused, or a server admin without a mapped group: what the provider decided goes now
        // (that only takes rights away); nothing is given.
        let touched = signin::apply(&mut tx, info, ids, &linked.user.id, o, None, now).await?;
        crate::db::commit(tx).await?;
        crate::sso::rights_changed(state, &touched).await;
        if linked.user.is_server_admin == 0 {
            let refusal = signin::Refusal::new("unmapped", "sso.unmapped", "no group of the person is mapped");
            return Ok(refuse(signin::Refusal { user_id: Some(linked.user.id.clone()), ..refusal }).await);
        }
        tx = crate::db::begin(&state.db).await?;
    }
    crate::db::commit(tx).await?;
    // Kalzit's own second factor, unless the provider's switch says to take its word for one
    // (`trust_provider_mfa` and the token's `amr`).
    let first = FirstStep::Provider {
        provider_id: &target.provider.id,
        mfa_done: person.mfa_done,
        provider_mfa_trusted: target.provider.trust_provider_mfa != 0,
    };
    let plan = super::second_factor::plan(state, info, &linked.user, first, now).await?;
    let mut cookies = clear();
    let mut tx = crate::db::begin(&state.db).await?;
    if plan.is_some() {
        // The half-signed-in state starts; the mapping waits for it to end well. The sign-in page
        // asks for the second factor and then goes on to where the person was headed.
        if outcome.as_ref().is_some_and(|o| !o.refused) {
            signin::defer(&mut tx, &linked.user.id, &target.provider.id, now).await?;
        }
        let answer =
            super::second_factor::finish_first_step(tx, state, info, headers, linked.user, first, false, plan, now)
                .await?;
        cookies.extend(answer.headers().get_all(header::SET_COOKIE).iter().cloned());
        let page = format!(
            "/anmelden?secondFactor=1&redirect={}",
            url::form_urlencoded::byte_serialize(row.return_to.as_bytes()).collect::<String>()
        );
        return Ok(see_other(&page, cookies));
    }
    let touched = match outcome.as_ref().filter(|o| !o.refused) {
        Some(o) => signin::apply(&mut tx, info, ids, &linked.user.id, o, None, now).await?,
        None => Default::default(),
    };
    cookies.extend(open_session(&mut tx, state, info, headers, &linked.user, &target.provider, &person, now).await?);
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(state, &touched).await;
    Ok(see_other(&row.return_to, cookies))
}

/// Opens the session after a sign-in through a provider that needs no second step, inside `tx`
/// (as `routes::second_factor::open_session`, with the provider in the audit entry).
#[expect(clippy::too_many_arguments, reason = "the parts of one sign-in, passed on as they are")]
async fn open_session(
    tx: &mut sqlx::AnyConnection,
    state: &AppState,
    info: &RequestInfo,
    headers: &HeaderMap,
    user: &SessionUser,
    provider: &ProviderRow,
    person: &Person,
    now: i64,
) -> ApiResult<Vec<HeaderValue>> {
    if let Some(old) = session::read_cookie(headers, info.https) {
        session::delete(&mut *tx, &old).await?;
    }
    let token = session::create(&mut *tx, &state.config.sessions, now, &user.id).await?;
    let provider_mfa = provider.trust_provider_mfa != 0 && person.mfa_done;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "auth.signed_in",
        resource_type: Some("user"),
        resource_id: Some(&user.id),
        summary: json!({ "provider": provider.slug, "providerMfa": provider_mfa }),
        at_ms: now,
    };
    crate::audit::record(&mut *tx, &event).await?;
    Ok(vec![session::set_cookie(&token, &state.config.sessions, info.https)])
}

fn outcome_reason(outcome: &str) -> &'static str {
    match outcome {
        "unavailable" => "sso.outcome_unavailable",
        "cancelled" => "sso.outcome_cancelled",
        "expired" => "sso.outcome_expired",
        "email_taken" => "sso.outcome_email_taken",
        _ => "sso.outcome_failed",
    }
}

/// Ends the row of a sign-in: a test keeps its result for the admin, a sign-in goes.
async fn finish_row(
    state: &AppState,
    row: &SignInRow,
    test: bool,
    result: Result<Value, (&str, &str)>,
) -> ApiResult<()> {
    if !test {
        sqlx::query("DELETE FROM sso_sign_ins WHERE id = $1").bind(&row.id).execute(&state.db).await?;
        return Ok(());
    }
    let (status, value) = match result {
        Ok(v) => ("done", v),
        Err((outcome, reason)) => ("failed", json!({ "reason": reason, "outcome": outcome })),
    };
    sqlx::query(
        "UPDATE sso_sign_ins SET status = $1, result = $2, draft_secret = NULL, draft_secret_key_id = NULL, \
         draft_secret_nonce = NULL WHERE id = $3",
    )
    .bind(status)
    .bind(value.to_string())
    .bind(&row.id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn load_target(state: &AppState, row: &SignInRow, slug: &str) -> ApiResult<Option<Target>> {
    if row.purpose == "test" {
        let Some(draft) = row.draft.as_deref().and_then(|d| serde_json::from_str::<Draft>(d).ok()) else {
            return Ok(None);
        };
        if draft.slug != slug {
            return Ok(None);
        }
        let secret = match (&row.draft_secret, &row.draft_secret_key_id, &row.draft_secret_nonce) {
            (Some(ciphertext), Some(key_id), Some(nonce)) => {
                let blob = crate::secrets::Blob {
                    key_id: key_id.clone(),
                    nonce: nonce.clone(),
                    ciphertext: ciphertext.clone(),
                };
                state
                    .secrets
                    .decrypt(&store::test_owner(&row.id), CLIENT_SECRET, &blob)
                    .map_err(|e| ApiError::internal("sso", e))?
            }
            _ => {
                // As for a check: the stored secret only goes to the stored issuer and client.
                let Some(id) = &draft.provider_id else { return Ok(None) };
                let Some(stored) = store::by_id(&state.db, id).await? else { return Ok(None) };
                let same = stored
                    .oidc()
                    .is_ok_and(|c| c.issuer == draft.config.issuer && c.client_id == draft.config.client_id);
                if !same {
                    return Ok(None);
                }
                match store::secret(&state.db, &state.secrets, id, CLIENT_SECRET).await? {
                    Some(s) => zeroize::Zeroizing::new(s.as_str().to_string()),
                    None => return Ok(None),
                }
            }
        };
        let stored = match &draft.provider_id {
            Some(id) => store::by_id(&state.db, id).await?,
            None => None,
        };
        let provider = ProviderRow {
            id: draft.provider_id.clone().unwrap_or_default(),
            slug: draft.slug.clone(),
            kind: "oidc".into(),
            name: stored.as_ref().map(|p| p.name.clone()).unwrap_or_default(),
            position: 0,
            enabled: 1,
            config: String::new(),
            create_accounts: 1,
            trust_provider_mfa: 0,
            checked_at: None,
            last_sign_in_at: None,
            version: 0,
        };
        return Ok(Some(Target { provider, config: draft.config, secret }));
    }
    let Some(id) = &row.provider_id else { return Ok(None) };
    let Some(provider) = store::by_id(&state.db, id).await?.filter(|p| p.enabled != 0 && p.slug == slug) else {
        return Ok(None);
    };
    let config = provider.oidc()?;
    let Some(secret) = store::secret(&state.db, &state.secrets, id, CLIENT_SECRET).await? else { return Ok(None) };
    let secret = zeroize::Zeroizing::new(secret.as_str().to_string());
    Ok(Some(Target { provider, config, secret }))
}

/// The person, from the code: the token exchange, the ID token and the userinfo endpoint.
async fn person(state: &AppState, target: &Target, row: &SignInRow, code: &str, now: i64) -> Result<Person, OidcError> {
    let http = state.sso.client(state);
    let cached = state.sso.provider(&http, &target.config, row.purpose == "test", state.clock.monotonic_ms()).await?;
    let tokens = oidc::exchange(
        &http,
        &cached.discovery,
        &target.config,
        &target.secret,
        code,
        &row.redirect_uri,
        row.verifier.as_deref(),
    )
    .await?;
    let claims = state
        .sso
        .check_id_token(&http, &target.config, &cached, &tokens.id_token, &row.nonce, now, state.clock.monotonic_ms())
        .await?;
    let subject = claims.get("sub").and_then(Value::as_str).unwrap_or_default().to_string();
    let info = match &tokens.access_token {
        Some(token) if cached.discovery.userinfo_endpoint.is_some() => {
            oidc::userinfo(&http, &cached.discovery, token, &subject).await?
        }
        _ => serde_json::Map::new(),
    };
    Ok(oidc::person(&target.config, &claims, &info))
}

async fn test_outcome(state: &AppState, target: &Target, person: &Person) -> ApiResult<Value> {
    let rules =
        if target.provider.id.is_empty() { Vec::new() } else { mapping::rules(&state.db, &target.provider.id).await? };
    let outcome = mapping::resolve(&rules, &person.groups, &crate::sso::unmapped(state).await?);
    outcome_json(state, &outcome).await
}

/// An outcome with the names of its organizations and teams.
pub(crate) async fn outcome_json(state: &AppState, outcome: &Outcome) -> ApiResult<Value> {
    let mut orgs = Vec::new();
    for org in &outcome.orgs {
        let name: Option<(String,)> =
            sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&org.org_id).fetch_optional(&state.db).await?;
        let Some((org_name,)) = name else { continue };
        let mut teams = Vec::new();
        for team in org.teams.keys() {
            let name: Option<(String,)> = sqlx::query_as("SELECT name FROM teams WHERE id = $1 AND org_id = $2")
                .bind(team)
                .bind(&org.org_id)
                .fetch_optional(&state.db)
                .await?;
            if let Some((team_name,)) = name {
                teams.push(json!({ "teamId": team, "teamName": team_name }));
            }
        }
        orgs.push(json!({
            "orgId": org.org_id, "orgName": org_name, "role": org.role, "group": org.group,
            "teams": teams, "idpDecides": org.idp_decides, "default": org.default,
        }));
    }
    Ok(json!({ "refused": outcome.refused, "orgs": orgs }))
}

async fn login_local(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<super::auth::LoginRequest>,
) -> ApiResult<Response> {
    use crate::auth::ratelimit::{address_key, network_key};
    // Every attempt counts here, on top of the sign-in limits.
    let mono = state.clock.monotonic_ms();
    state
        .sso
        .local_limiter
        .try_acquire(&address_key("login-local", info.client_ip), &network_key(info.client_ip), mono)
        .map_err(|wait| ApiError::rate_limited("too many attempts, wait a few minutes", wait))?;
    super::auth::login_with(state, info, headers, req, true).await.map(IntoResponse::into_response)
}

// ---------------------------------------------------------------------------------------------
// Administration: providers

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OidcInput {
    issuer: String,
    client_id: String,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    groups_claim: Option<String>,
    #[serde(default)]
    email_claim: Option<String>,
    #[serde(default)]
    name_claim: Option<String>,
    #[serde(default)]
    pkce: Option<bool>,
    #[serde(default)]
    trust_email: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderBody {
    #[serde(default)]
    kind: Option<String>,
    slug: String,
    name: String,
    #[serde(default)]
    create_accounts: Option<bool>,
    #[serde(default)]
    trust_provider_mfa: Option<bool>,
    oidc: OidcInput,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    check_token: Option<String>,
    #[serde(default)]
    version: Option<i64>,
    /// Changing the issuer of a provider people sign in through removes their links; the admin
    /// confirms that.
    #[serde(default)]
    confirm_issuer_change: Option<bool>,
}

pub(crate) fn field_error(field: &'static str, reason: &'static str, message: &str) -> ApiError {
    ApiError::validation(message).with_field(field).because(reason)
}

fn clean_claim(raw: Option<String>, default: &str, field: &'static str) -> ApiResult<String> {
    let value = raw.map(|s| s.trim().to_string()).unwrap_or_else(|| default.to_string());
    if value.is_empty() || value.chars().count() > 100 || value.chars().any(char::is_control) {
        return Err(field_error(field, "sso.claim_invalid", "a claim needs 1 to 100 characters"));
    }
    Ok(value)
}

/// The form, checked field by field.
struct Valid {
    slug: String,
    name: String,
    create_accounts: bool,
    trust_provider_mfa: bool,
    config: OidcConfig,
    secret: Option<String>,
    provider_id: Option<String>,
    check_token: Option<String>,
    version: Option<i64>,
    confirm_issuer_change: bool,
}

fn validate(body: ProviderBody) -> ApiResult<Valid> {
    if body.kind.as_deref().is_some_and(|k| k != "oidc") {
        return Err(ApiError::validation("only OpenID Connect providers can be added").with_field("kind"));
    }
    let slug = body.slug.trim().to_string();
    if !crate::sso::valid_slug(&slug) {
        return Err(field_error("slug", "sso.slug_invalid", "the slug needs 1 to 40 of a-z, 0-9 and -"));
    }
    let name = super::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let o = body.oidc;
    let issuer = o.issuer.trim().to_string();
    if oidc::check_issuer(&issuer).is_none() {
        return Err(field_error("issuer", "sso.issuer_invalid", "the issuer must be an https:// address"));
    }
    let client_id = o.client_id.trim().to_string();
    if client_id.is_empty() || client_id.len() > 256 || client_id.chars().any(char::is_control) {
        return Err(field_error("clientId", "sso.client_id_required", "the client id is required"));
    }
    let scopes = o.scopes.unwrap_or_else(|| ["openid", "email", "profile"].map(String::from).to_vec());
    if scopes.len() > 20
        || scopes.iter().any(|s| s.is_empty() || s.len() > 100 || !s.bytes().all(|b| b.is_ascii_graphic()))
    {
        return Err(field_error("scopes", "sso.scopes_invalid", "scopes are 1 to 100 printable characters each"));
    }
    let secret = o.client_secret.filter(|s| !s.is_empty());
    if secret.as_ref().is_some_and(|s| s.len() > 4096 || s.chars().any(char::is_control)) {
        return Err(field_error("clientSecret", "sso.client_secret_required", "the client secret is not valid"));
    }
    let config = OidcConfig {
        issuer,
        client_id,
        scopes,
        groups_claim: clean_claim(o.groups_claim, "groups", "groupsClaim")?,
        email_claim: clean_claim(o.email_claim, "email", "emailClaim")?,
        name_claim: clean_claim(o.name_claim, "name", "nameClaim")?,
        pkce: o.pkce.unwrap_or(true),
        trust_email: o.trust_email.unwrap_or(false),
    };
    let valid = Valid {
        slug,
        name,
        create_accounts: body.create_accounts.unwrap_or(true),
        trust_provider_mfa: body.trust_provider_mfa.unwrap_or(false),
        config,
        secret,
        provider_id: body.provider_id,
        check_token: body.check_token,
        version: body.version,
        confirm_issuer_change: body.confirm_issuer_change.unwrap_or(false),
    };
    Ok(valid)
}

/// A route for one kind of provider used with another.
pub(crate) fn kind_mismatch() -> ApiError {
    ApiError::validation("this route is for another kind of provider").because("sso.kind_mismatch")
}

/// The secret a form uses: the one typed, else the stored one of `provider_id`.
async fn form_secret(
    state: &AppState,
    valid: &Valid,
    provider_id: Option<&str>,
) -> ApiResult<zeroize::Zeroizing<String>> {
    if let Some(s) = &valid.secret {
        return Ok(zeroize::Zeroizing::new(s.clone()));
    }
    // The stored secret goes only to the issuer and client it was given for: a form that names
    // another one must bring the secret again, so a changed issuer cannot collect it.
    if let Some(id) = provider_id
        && let Some(stored) = store::by_id(&state.db, id).await?
        && let Ok(config) = stored.oidc()
        && config.issuer == valid.config.issuer
        && config.client_id == valid.config.client_id
        && let Some(s) = store::secret(&state.db, &state.secrets, id, CLIENT_SECRET).await?
    {
        return Ok(zeroize::Zeroizing::new(s.as_str().to_string()));
    }
    Err(field_error(
        "clientSecret",
        "sso.client_secret_required",
        "enter the client secret: a new provider, or a changed issuer or client id, needs it",
    ))
}

fn check_material(config: &OidcConfig, secret: &str, at: i64) -> Vec<u8> {
    format!("kalzit-sso-check\0{}\0{}\0{}\0{at}", config.issuer, config.client_id, hash(secret)).into_bytes()
}

fn issue_check_token(state: &AppState, config: &OidcConfig, secret: &str, now: i64) -> String {
    format!("{now}.{}", hex::encode(state.secrets.sign(&check_material(config, secret, now))))
}

fn verify_check_token(
    state: &AppState,
    token: Option<&str>,
    config: &OidcConfig,
    secret: &str,
    now: i64,
) -> ApiResult<()> {
    let ok = token.and_then(|t| t.split_once('.')).is_some_and(|(at, mac)| {
        let (Ok(at), Ok(mac)) = (at.parse::<i64>(), hex::decode(mac)) else { return false };
        now - at <= CHECK_VALID_MS && at <= now && state.secrets.verify(&check_material(config, secret, at), &mac)
    });
    if ok {
        Ok(())
    } else {
        Err(field_error("issuer", "sso.check_required", "check the connection with these values first"))
    }
}

fn check_error(e: &OidcError) -> ApiError {
    let message = e.to_string();
    let detail = |reason| field_error("issuer", reason, &message);
    match e {
        OidcError::DiscoveryUnreachable(d) => detail("sso.discovery_unreachable").param("detail", d),
        OidcError::DiscoveryInvalid(d) => detail("sso.discovery_invalid").param("detail", d),
        OidcError::IssuerMismatch(i) => detail("sso.issuer_mismatch").param("issuer", i),
        OidcError::KeysUnreachable(d) => detail("sso.keys_unreachable").param("detail", d),
        OidcError::KeysInvalid => detail("sso.keys_invalid"),
        OidcError::ClientRejected => field_error("clientSecret", "sso.client_rejected", &message),
        OidcError::TokenUnreachable(d) | OidcError::TokenInvalid(d) => {
            detail("sso.token_unreachable").param("detail", d)
        }
        other => detail("sso.discovery_invalid").param("detail", other.to_string()),
    }
}

async fn check(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ProviderBody>,
) -> ApiResult<Json<Value>> {
    let valid = validate(body)?;
    let provider_id = valid.provider_id.clone();
    let secret = form_secret(&state, &valid, provider_id.as_deref()).await?;
    let started = std::time::Instant::now();
    let redirect_uri = crate::sso::redirect_uri(&crate::sso::public_base(&state, &info), &valid.slug);
    let http = state.sso.client(&state);
    let cached = state
        .sso
        .provider(&http, &valid.config, true, state.clock.monotonic_ms())
        .await
        .map_err(|e| check_error(&e))?;
    let accepted = oidc::probe_client(&http, &cached.discovery, &valid.config, &secret, &redirect_uri)
        .await
        .map_err(|e| check_error(&e))?;
    if accepted == Some(false) {
        return Err(check_error(&OidcError::ClientRejected));
    }
    let now = state.clock.now_ms();
    Ok(Json(json!({
        "checkToken": issue_check_token(&state, &valid.config, &secret, now),
        "keys": cached.keys.usable(),
        "durationMs": started.elapsed().as_millis() as u64,
        "clientAccepted": accepted,
    })))
}

pub(crate) async fn provider_json(state: &AppState, info: &RequestInfo, row: &ProviderRow) -> ApiResult<Value> {
    if row.kind == "ldap" {
        return super::ldap::provider_json(state, row).await;
    }
    let config = row.oidc()?;
    let secret_set: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM sso_provider_secrets WHERE provider_id = $1 AND field = $2")
            .bind(&row.id)
            .bind(CLIENT_SECRET)
            .fetch_optional(&state.db)
            .await?;
    Ok(json!({
        "id": row.id, "slug": row.slug, "kind": row.kind, "name": row.name, "enabled": row.enabled != 0,
        "position": row.position, "version": row.version, "createAccounts": row.create_accounts != 0,
        "trustProviderMfa": row.trust_provider_mfa != 0, "checkedAt": row.checked_at,
        "redirectUri": crate::sso::redirect_uri(&crate::sso::public_base(state, info), &row.slug),
        "oidc": {
            "issuer": config.issuer, "clientId": config.client_id, "clientSecretSet": secret_set.is_some(),
            "scopes": config.scopes, "groupsClaim": config.groups_claim, "emailClaim": config.email_claim,
            "nameClaim": config.name_claim, "pkce": config.pkce, "trustEmail": config.trust_email,
        },
    }))
}

async fn overview(State(state): State<AppState>, Extension(info): Extension<RequestInfo>) -> ApiResult<Json<Value>> {
    let rows = store::all(&state.db).await?;
    let people: Vec<(String, i64)> =
        sqlx::query_as("SELECT provider_id, COUNT(*) FROM sso_identities GROUP BY provider_id")
            .fetch_all(&state.db)
            .await?;
    let people: HashMap<String, i64> = people.into_iter().collect();
    let base = crate::sso::public_base(&state, &info);
    let mut providers = Vec::new();
    for row in &rows {
        let (issuer, flavor) = match row.kind.as_str() {
            "ldap" => match row.ldap() {
                Ok(c) => (c.url, Some(c.flavor)),
                Err(_) => (String::new(), None),
            },
            _ => (row.oidc().map(|c| c.issuer).unwrap_or_default(), None),
        };
        providers.push(json!({
            "flavor": flavor,
            "id": row.id, "slug": row.slug, "kind": row.kind, "name": row.name, "issuer": issuer,
            "position": row.position, "enabled": row.enabled != 0, "people": people.get(&row.id).copied().unwrap_or(0),
            "lastSignInAt": row.last_sign_in_at, "checkedAt": row.checked_at,
            "createAccounts": row.create_accounts != 0, "trustProviderMfa": row.trust_provider_mfa != 0,
            "redirectUri": crate::sso::redirect_uri(&base, &row.slug),
        }));
    }
    let (accounts,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM users WHERE disabled = 0").fetch_one(&state.db).await?;
    let (via,): (i64,) = sqlx::query_as(
        "SELECT COUNT(DISTINCT i.user_id) FROM sso_identities i JOIN users u ON u.id = i.user_id \
         JOIN sso_providers p ON p.id = i.provider_id WHERE u.disabled = 0 AND p.enabled = 1",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Json(json!({ "providers": providers, "accounts": accounts, "viaProviders": via, "redirectBase": base })))
}

async fn load_provider(state: &AppState, id: &str) -> ApiResult<ProviderRow> {
    store::by_id(&state.db, id).await?.ok_or_else(ApiError::not_found)
}

async fn provider_detail(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = load_provider(&state, &id).await?;
    Ok(Json(provider_json(&state, &info, &row).await?))
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ProviderBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let valid = validate(body)?;
    let token = valid.check_token.clone();
    let Some(secret) = valid.secret.clone() else {
        return Err(field_error("clientSecret", "sso.client_secret_required", "a new provider needs a client secret"));
    };
    let now = state.clock.now_ms();
    verify_check_token(&state, token.as_deref(), &valid.config, &secret, now)?;
    let id = super::new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    if store::by_slug(&mut *tx, &valid.slug).await?.is_some() {
        return Err(conflict("another provider has this slug").with_field("slug").because("sso.slug_taken"));
    }
    let (position,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(position) + 1, 0) FROM sso_providers").fetch_one(&mut *tx).await?;
    let config = serde_json::to_string(&valid.config).map_err(|e| ApiError::internal("sso", e))?;
    let inserted = sqlx::query(
        "INSERT INTO sso_providers (id, slug, kind, name, position, enabled, config, create_accounts, \
         trust_provider_mfa, checked_at, version, created_at, updated_at) \
         VALUES ($1, $2, 'oidc', $3, $4, 1, $5, $6, $7, $8, 1, $9, $10)",
    )
    .bind(&id)
    .bind(&valid.slug)
    .bind(&valid.name)
    .bind(position)
    .bind(&config)
    .bind(i64::from(valid.create_accounts))
    .bind(i64::from(valid.trust_provider_mfa))
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await;
    if let Err(e) = inserted {
        if is_unique_violation(&e) {
            return Err(conflict("another provider has this slug").with_field("slug").because("sso.slug_taken"));
        }
        return Err(e.into());
    }
    store::set_secret(&mut tx, &state.secrets, &id, CLIENT_SECRET, &secret).await?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "providerId": id, "slug": valid.slug, "kind": "oidc" });
    audit(&mut tx, &actor, None, "sso.provider_created", ("sso_provider", &id), summary).await?;
    crate::db::commit(tx).await?;
    let row = load_provider(&state, &id).await?;
    Ok((StatusCode::CREATED, Json(provider_json(&state, &info, &row).await?)))
}

async fn update(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<ProviderBody>,
) -> ApiResult<Json<Value>> {
    let valid = validate(body)?;
    let (token, version) = (valid.check_token.clone(), valid.version);
    let current = load_provider(&state, &id).await?;
    if current.kind != "oidc" {
        return Err(kind_mismatch());
    }
    if valid.slug != current.slug {
        return Err(field_error("slug", "sso.slug_invalid", "the slug of a provider cannot change"));
    }
    if version != Some(current.version) {
        return Err(ApiError::version_conflict(provider_json(&state, &info, &current).await?));
    }
    let old = current.oidc()?;
    let now = state.clock.now_ms();
    let connection_changed =
        old.issuer != valid.config.issuer || old.client_id != valid.config.client_id || valid.secret.is_some();
    if connection_changed {
        let secret = form_secret(&state, &valid, Some(&id)).await?;
        verify_check_token(&state, token.as_deref(), &valid.config, &secret, now)?;
    }
    // Subjects are only unique per issuer: with another issuer, the people linked through the old
    // one are not the same people. Their links and what the provider decided for them go, after
    // the admin confirmed it.
    let issuer_changed = old.issuer != valid.config.issuer;
    if issuer_changed && !valid.confirm_issuer_change {
        let (people,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sso_identities WHERE provider_id = $1")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
        if people > 0 {
            return Err(conflict("changing the issuer removes the links of the people who sign in through it")
                .with_field("issuer")
                .because("sso.issuer_change_confirm")
                .param("people", people));
        }
    }
    let mut fields = Vec::new();
    if valid.name != current.name {
        fields.push("name");
    }
    if old != valid.config {
        fields.push("oidc");
    }
    if valid.secret.is_some() {
        fields.push("clientSecret");
    }
    if valid.create_accounts != (current.create_accounts != 0) {
        fields.push("createAccounts");
    }
    if valid.trust_provider_mfa != (current.trust_provider_mfa != 0) {
        fields.push("trustProviderMfa");
    }
    let config = serde_json::to_string(&valid.config).map_err(|e| ApiError::internal("sso", e))?;
    let mut tx = crate::db::begin(&state.db).await?;
    let changed = sqlx::query(
        "UPDATE sso_providers SET name = $1, config = $2, create_accounts = $3, trust_provider_mfa = $4, \
         checked_at = CASE WHEN $5 = 1 THEN $6 ELSE checked_at END, version = version + 1, updated_at = $7 \
         WHERE id = $8 AND version = $9",
    )
    .bind(&valid.name)
    .bind(&config)
    .bind(i64::from(valid.create_accounts))
    .bind(i64::from(valid.trust_provider_mfa))
    .bind(i64::from(connection_changed))
    .bind(now)
    .bind(now)
    .bind(&id)
    .bind(current.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed == 0 {
        drop(tx);
        let latest = load_provider(&state, &id).await?;
        return Err(ApiError::version_conflict(provider_json(&state, &info, &latest).await?));
    }
    if let Some(secret) = &valid.secret {
        store::set_secret(&mut tx, &state.secrets, &id, CLIENT_SECRET, secret).await?;
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let mut touched = BTreeSet::new();
    if issuer_changed {
        // What the provider decided under "IdP entscheidet" goes with the links (the memberships
        // and teams it gave), recorded per person as at a sign-in.
        let managed: Vec<(String,)> =
            sqlx::query_as("SELECT DISTINCT user_id FROM sso_managed WHERE provider_id = $1 ORDER BY user_id")
                .bind(&id)
                .fetch_all(&mut *tx)
                .await?;
        let revoke = crate::sso::mapping::Outcome { refused: true, orgs: Vec::new() };
        for (user_id,) in managed {
            touched.extend(
                crate::sso::signin::apply(
                    &mut tx,
                    &info,
                    (&id, &current.slug),
                    &user_id,
                    &revoke,
                    Some(&admin.id),
                    now,
                )
                .await?,
            );
        }
        let removed = sqlx::query("DELETE FROM sso_identities WHERE provider_id = $1")
            .bind(&id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        for table in ["sso_identity_groups", "sso_managed", "sso_pending_mappings"] {
            sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table} WHERE provider_id = $1")))
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
        if removed > 0 {
            let summary = json!({ "providerId": id, "identities": removed });
            audit(&mut tx, &actor, None, "sso.provider_identities_removed", ("sso_provider", &id), summary).await?;
        }
    }
    audit(
        &mut tx,
        &actor,
        None,
        "sso.provider_updated",
        ("sso_provider", &id),
        json!({ "providerId": id, "fields": fields }),
    )
    .await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(&state, &touched).await;
    state.sso.forget(&old.issuer);
    state.sso.forget(&valid.config.issuer);
    let row = load_provider(&state, &id).await?;
    Ok(Json(provider_json(&state, &info, &row).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnabledBody {
    enabled: bool,
}

async fn set_enabled(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<EnabledBody>,
) -> ApiResult<Json<Value>> {
    let current = load_provider(&state, &id).await?;
    let now = state.clock.now_ms();
    if (current.enabled != 0) != body.enabled {
        let mut tx = crate::db::begin(&state.db).await?;
        sqlx::query("UPDATE sso_providers SET enabled = $1, version = version + 1, updated_at = $2 WHERE id = $3")
            .bind(i64::from(body.enabled))
            .bind(now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
        let action = if body.enabled { "sso.provider_resumed" } else { "sso.provider_paused" };
        let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
        audit(&mut tx, &actor, None, action, ("sso_provider", &id), json!({ "providerId": id })).await?;
        crate::db::commit(tx).await?;
    }
    let row = load_provider(&state, &id).await?;
    Ok(Json(provider_json(&state, &info, &row).await?))
}

async fn delete(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let current = load_provider(&state, &id).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let (people,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sso_identities WHERE provider_id = $1")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if people > 0 {
        return Err(conflict("people sign in through this provider; pause it instead")
            .because("sso.provider_in_use")
            .param("people", people));
    }
    sqlx::query("DELETE FROM sso_sign_ins WHERE provider_id = $1").bind(&id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM sso_providers WHERE id = $1").bind(&id).execute(&mut *tx).await?;
    let now = state.clock.now_ms();
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "providerId": id, "slug": current.slug });
    audit(&mut tx, &actor, None, "sso.provider_deleted", ("sso_provider", &id), summary).await?;
    crate::db::commit(tx).await?;
    if let Ok(config) = current.oidc() {
        state.sso.forget(&config.issuer);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OrderBody {
    ids: Vec<String>,
}

async fn reorder(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<OrderBody>,
) -> ApiResult<Json<Value>> {
    let mut tx = crate::db::begin(&state.db).await?;
    let rows = store::all(&mut *tx).await?;
    let have: BTreeSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let want: BTreeSet<&str> = body.ids.iter().map(String::as_str).collect();
    if have != want || want.len() != body.ids.len() {
        return Err(ApiError::validation("name every provider exactly once").with_field("ids"));
    }
    for (position, id) in body.ids.iter().enumerate() {
        sqlx::query("UPDATE sso_providers SET position = $1 WHERE id = $2")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let now = state.clock.now_ms();
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, None, "sso.providers_reordered", ("sso_provider", ""), json!({ "ids": body.ids })).await?;
    crate::db::commit(tx).await?;
    Ok(Json(json!({ "ids": body.ids })))
}

async fn test_start(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ProviderBody>,
) -> ApiResult<(StatusCode, HeaderMap, Json<Value>)> {
    let valid = validate(body)?;
    let (provider_id, token) = (valid.provider_id.clone(), valid.check_token.clone());
    if let Some(id) = &provider_id {
        load_provider(&state, id).await?;
    }
    let secret = form_secret(&state, &valid, provider_id.as_deref()).await?;
    let now = state.clock.now_ms();
    verify_check_token(&state, token.as_deref(), &valid.config, &secret, now)?;
    let http = state.sso.client(&state);
    let cached = state
        .sso
        .provider(&http, &valid.config, true, state.clock.monotonic_ms())
        .await
        .map_err(|e| check_error(&e))?;
    let redirect_uri = crate::sso::redirect_uri(&crate::sso::public_base(&state, &info), &valid.slug);
    let request = oidc::Request::new(valid.config.pkce);
    let url = oidc::authorization_url(&cached.discovery, &valid.config, &redirect_uri, &request)
        .map_err(|e| check_error(&e))?;
    let id = super::new_id();
    let draft = Draft { slug: valid.slug.clone(), provider_id: provider_id.clone(), config: valid.config.clone() };
    let draft = serde_json::to_string(&draft).map_err(|e| ApiError::internal("sso", e))?;
    let blob = valid.secret.as_ref().map(|s| state.secrets.encrypt(&store::test_owner(&id), CLIENT_SECRET, s));
    let binding = oidc::random_token();
    sqlx::query(
        "INSERT INTO sso_sign_ins (id, state_hash, binding_hash, provider_id, purpose, nonce, verifier, redirect_uri, \
         return_to, draft, draft_secret_key_id, draft_secret_nonce, draft_secret, created_by, status, created_at, \
         expires_at) VALUES ($1, $2, $3, $4, 'test', $5, $6, $7, '/', $8, $9, $10, $11, $12, 'pending', $13, $14)",
    )
    .bind(&id)
    .bind(hash(&request.state))
    .bind(hash(&binding))
    .bind(provider_id.as_deref())
    .bind(&request.nonce)
    .bind(request.verifier.as_deref())
    .bind(&redirect_uri)
    .bind(&draft)
    .bind(blob.as_ref().map(|b| b.key_id.clone()))
    .bind(blob.as_ref().map(|b| b.nonce.clone()))
    .bind(blob.as_ref().map(|b| b.ciphertext.clone()))
    .bind(&admin.id)
    .bind(now)
    .bind(now + crate::sso::SIGN_IN_TTL_MS)
    .execute(&state.db)
    .await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, set_binding(&binding, info.https));
    Ok((StatusCode::CREATED, headers, Json(json!({ "id": id, "url": url.as_str() }))))
}

async fn test_result(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT status, result, expires_at FROM sso_sign_ins WHERE id = $1 AND purpose = 'test' AND created_by = $2",
    )
    .bind(&id)
    .bind(&admin.id)
    .fetch_optional(&state.db)
    .await?;
    let now = state.clock.now_ms();
    let Some((status, result, expires_at)) = row else { return Err(ApiError::not_found().because("sso.test_unknown")) };
    let result: Value = result.as_deref().and_then(|r| serde_json::from_str(r).ok()).unwrap_or(Value::Null);
    Ok(Json(match status.as_str() {
        "done" => json!({ "status": "done", "result": result }),
        "failed" => json!({ "status": "failed", "error": {
            "reason": result["reason"], "message": format!("the test sign-in ended: {}", result["outcome"].as_str().unwrap_or("failed")),
        } }),
        _ if expires_at <= now => json!({ "status": "failed", "error": {
            "reason": "sso.outcome_expired", "message": "the test sign-in took too long",
        } }),
        _ => json!({ "status": "pending" }),
    }))
}

// ---------------------------------------------------------------------------------------------
// Administration: group mappings

#[derive(sqlx::FromRow)]
struct MappingRow {
    id: String,
    provider_id: String,
    provider_name: String,
    group_name: String,
    org_id: String,
    org_name: String,
    team_id: Option<String>,
    team_name: Option<String>,
    role: String,
    idp_decides: i64,
    people: i64,
}

const MAPPING_COLUMNS: &str = "SELECT m.id, m.provider_id, p.name AS provider_name, m.group_name, m.org_id, \
     o.name AS org_name, m.team_id, t.name AS team_name, m.role, m.idp_decides, \
     (SELECT COUNT(*) FROM sso_identity_groups g WHERE g.provider_id = m.provider_id AND g.group_name = m.group_name) \
     AS people FROM sso_group_mappings m JOIN sso_providers p ON p.id = m.provider_id JOIN orgs o ON o.id = m.org_id \
     LEFT JOIN teams t ON t.id = m.team_id";

fn mapping_value(m: MappingRow) -> Value {
    json!({
        "id": m.id, "providerId": m.provider_id, "providerName": m.provider_name, "group": m.group_name,
        "orgId": m.org_id, "orgName": m.org_name, "teamId": m.team_id, "teamName": m.team_name,
        "role": m.role, "idpDecides": m.idp_decides != 0, "people": m.people,
    })
}

async fn load_mapping<'c, E>(db: E, id: &str) -> ApiResult<MappingRow>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{MAPPING_COLUMNS} WHERE m.id = $1")))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(ApiError::not_found)
}

async fn unmapped_value(state: &AppState) -> ApiResult<Value> {
    let rule = crate::sso::unmapped(state).await?;
    Ok(json!({
        "rule": if rule.refuse { "refuse" } else { "default" },
        "defaultOrgId": rule.org_id, "defaultRole": rule.role,
    }))
}

async fn mappings(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<MappingRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{MAPPING_COLUMNS} ORDER BY p.position, m.group_name, m.id")))
            .fetch_all(&state.db)
            .await?;
    // Organizations and their teams to choose from: server admins need not be members.
    let orgs: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM orgs ORDER BY name").fetch_all(&state.db).await?;
    let teams: Vec<(String, String, String)> =
        sqlx::query_as("SELECT org_id, id, name FROM teams ORDER BY name").fetch_all(&state.db).await?;
    let mut by_org: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (org, id, name) in teams {
        by_org.entry(org).or_default().push(json!({ "id": id, "name": name }));
    }
    let orgs: Vec<Value> = orgs
        .into_iter()
        .map(|(id, name)| json!({ "id": id, "name": name, "teams": by_org.remove(&id).unwrap_or_default() }))
        .collect();
    Ok(Json(json!({
        "mappings": rows.into_iter().map(mapping_value).collect::<Vec<_>>(),
        "unmapped": unmapped_value(&state).await?,
        "orgs": orgs,
    })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MappingBody {
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    group: Option<String>,
    #[serde(default)]
    org_id: Option<String>,
    /// `null` removes the team; left out keeps it.
    #[serde(default, deserialize_with = "some_or_null")]
    team_id: Option<Option<String>>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    idp_decides: Option<bool>,
}

fn some_or_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

fn clean_group(raw: &str) -> ApiResult<String> {
    let g = raw.trim();
    if g.is_empty() || g.chars().count() > 256 || g.chars().any(char::is_control) {
        return Err(field_error("group", "sso.group_invalid", "a group needs 1 to 256 characters"));
    }
    Ok(g.to_string())
}

async fn check_target(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    team_id: Option<&str>,
    role: &str,
) -> ApiResult<()> {
    if !mapping::MAPPABLE_ROLES.contains(&role) {
        return Err(field_error("role", "sso.role_invalid", "the role must be viewer, editor or admin"));
    }
    let org: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM orgs WHERE id = $1").bind(org_id).fetch_optional(&mut *conn).await?;
    if org.is_none() {
        return Err(field_error("orgId", "sso.org_unknown", "no such organization"));
    }
    if let Some(team) = team_id {
        let found: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM teams WHERE id = $1 AND org_id = $2")
            .bind(team)
            .bind(org_id)
            .fetch_optional(&mut *conn)
            .await?;
        if found.is_none() {
            return Err(field_error("teamId", "sso.team_unknown", "no such team in the organization"));
        }
    }
    Ok(())
}

async fn mapping_create(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<MappingBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let provider_id =
        body.provider_id.ok_or_else(|| ApiError::validation("providerId is required").with_field("providerId"))?;
    let group = clean_group(body.group.as_deref().unwrap_or_default())?;
    let org_id = body.org_id.ok_or_else(|| field_error("orgId", "sso.org_unknown", "orgId is required"))?;
    let team_id = body.team_id.flatten();
    let role = body.role.unwrap_or_default();
    let mut tx = crate::db::begin(&state.db).await?;
    if store::by_id(&mut *tx, &provider_id).await?.is_none() {
        return Err(ApiError::validation("no such provider").with_field("providerId"));
    }
    check_target(&mut tx, &org_id, team_id.as_deref(), &role).await?;
    let id = super::new_id();
    let now = state.clock.now_ms();
    sqlx::query(
        "INSERT INTO sso_group_mappings (id, provider_id, group_name, org_id, team_id, role, idp_decides, created_at, \
         updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&id)
    .bind(&provider_id)
    .bind(&group)
    .bind(&org_id)
    .bind(team_id.as_deref())
    .bind(&role)
    .bind(i64::from(body.idp_decides.unwrap_or(false)))
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "mappingId": id, "providerId": provider_id, "orgId": org_id, "teamId": team_id, "role": role,
                          "idpDecides": body.idp_decides.unwrap_or(false) });
    audit(&mut tx, &actor, Some(&org_id), "sso.mapping_created", ("sso_mapping", &id), summary).await?;
    let row = load_mapping(&mut *tx, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(mapping_value(row))))
}

async fn mapping_update(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<MappingBody>,
) -> ApiResult<Json<Value>> {
    if body.provider_id.is_some() {
        return Err(ApiError::validation("the provider of a mapping cannot change").with_field("providerId"));
    }
    let mut tx = crate::db::begin(&state.db).await?;
    let current = load_mapping(&mut *tx, &id).await?;
    let group = match &body.group {
        Some(g) => clean_group(g)?,
        None => current.group_name.clone(),
    };
    let org_id = body.org_id.clone().unwrap_or_else(|| current.org_id.clone());
    let team_id = match body.team_id.clone() {
        Some(t) => t,
        // Another organization does not keep the team of the old one.
        None if org_id != current.org_id => None,
        None => current.team_id.clone(),
    };
    let role = body.role.clone().unwrap_or_else(|| current.role.clone());
    let idp = body.idp_decides.unwrap_or(current.idp_decides != 0);
    check_target(&mut tx, &org_id, team_id.as_deref(), &role).await?;
    let now = state.clock.now_ms();
    sqlx::query(
        "UPDATE sso_group_mappings SET group_name = $1, org_id = $2, team_id = $3, role = $4, idp_decides = $5, \
         updated_at = $6 WHERE id = $7",
    )
    .bind(&group)
    .bind(&org_id)
    .bind(team_id.as_deref())
    .bind(&role)
    .bind(i64::from(idp))
    .bind(now)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    let mut fields = Vec::new();
    for (name, changed) in [
        ("group", group != current.group_name),
        ("orgId", org_id != current.org_id),
        ("teamId", team_id != current.team_id),
        ("role", role != current.role),
        ("idpDecides", idp != (current.idp_decides != 0)),
    ] {
        if changed {
            fields.push(name);
        }
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "mappingId": id, "fields": fields, "role": role, "idpDecides": idp });
    audit(&mut tx, &actor, Some(&org_id), "sso.mapping_updated", ("sso_mapping", &id), summary).await?;
    let row = load_mapping(&mut *tx, &id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(mapping_value(row)))
}

async fn mapping_delete(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    let current = load_mapping(&mut *tx, &id).await?;
    sqlx::query("DELETE FROM sso_group_mappings WHERE id = $1").bind(&id).execute(&mut *tx).await?;
    let now = state.clock.now_ms();
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "mappingId": id, "providerId": current.provider_id, "orgId": current.org_id });
    audit(&mut tx, &actor, Some(&current.org_id), "sso.mapping_deleted", ("sso_mapping", &id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Writes server settings of the sign-in that the generic settings routes do not change
/// (`ui_editable: false`), refusing when the environment or the file sets one.
async fn store_settings(
    state: &AppState,
    conn: &mut sqlx::AnyConnection,
    values: &[(&str, Value)],
    user_id: &str,
    now: i64,
) -> ApiResult<()> {
    use crate::settings::Source;
    for (key, value) in values {
        let effective = crate::settings::effective(state, key).await?;
        if !matches!(effective.source, Source::Database | Source::Default) {
            return Err(
                conflict("the environment or kalzit.toml sets the sign-in settings").because("sso.settings_read_only")
            );
        }
        if effective.value == *value {
            continue;
        }
        let def = crate::settings::find(key, crate::settings::Scope::Server)
            .ok_or_else(|| ApiError::internal("sso", format!("unknown setting {key}")))?;
        crate::settings::validate(def, value).map_err(ApiError::validation)?;
        if crate::settings::store(&mut *conn, None, key, value, effective.version, user_id, now).await?.is_none() {
            return Err(ApiError::busy());
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnmappedBody {
    rule: String,
    #[serde(default)]
    default_org_id: Option<String>,
    default_role: String,
}

async fn set_unmapped(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<UnmappedBody>,
) -> ApiResult<Json<Value>> {
    if !matches!(body.rule.as_str(), "default" | "refuse") {
        return Err(ApiError::validation("rule must be default or refuse").with_field("rule"));
    }
    if !mapping::DEFAULT_ROLES.contains(&body.default_role.as_str()) {
        return Err(field_error("defaultRole", "sso.role_invalid", "the default role must be viewer or editor"));
    }
    let org = body.default_org_id.clone().unwrap_or_default();
    let mut tx = crate::db::begin(&state.db).await?;
    if !org.is_empty() {
        let found: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM orgs WHERE id = $1").bind(&org).fetch_optional(&mut *tx).await?;
        if found.is_none() {
            return Err(field_error("defaultOrgId", "sso.org_unknown", "no such organization"));
        }
    }
    let now = state.clock.now_ms();
    let values = [
        ("signin.unmapped", json!(body.rule)),
        ("signin.default_org", json!(org)),
        ("signin.default_role", json!(body.default_role)),
    ];
    store_settings(&state, &mut tx, &values, &admin.id, now).await?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "rule": body.rule, "defaultOrgId": body.default_org_id, "defaultRole": body.default_role });
    audit(&mut tx, &actor, None, "sso.unmapped_changed", ("settings", "signin.unmapped"), summary).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    Ok(Json(unmapped_value(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewBody {
    user_id: String,
}

async fn preview(State(state): State<AppState>, JsonBody(body): JsonBody<PreviewBody>) -> ApiResult<Json<Value>> {
    let identities: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT i.provider_id, p.name, i.subject FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id \
         WHERE i.user_id = $1 ORDER BY p.position",
    )
    .bind(&body.user_id)
    .fetch_all(&state.db)
    .await?;
    let unmapped = crate::sso::unmapped(&state).await?;
    let mut groups_out = Vec::new();
    let mut merged: BTreeMap<String, mapping::OrgOutcome> = BTreeMap::new();
    let mut refused = !identities.is_empty();
    for (provider_id, provider_name, subject) in &identities {
        let groups: Vec<(String,)> = sqlx::query_as(
            "SELECT group_name FROM sso_identity_groups WHERE provider_id = $1 AND subject = $2 ORDER BY group_name",
        )
        .bind(provider_id)
        .bind(subject)
        .fetch_all(&state.db)
        .await?;
        let groups: Vec<String> = groups.into_iter().map(|(g,)| g).collect();
        let outcome = mapping::resolve(&mapping::rules(&state.db, provider_id).await?, &groups, &unmapped);
        refused &= outcome.refused;
        for org in outcome.orgs {
            match merged.get_mut(&org.org_id) {
                Some(have) if mapping::rank(&org.role) > mapping::rank(&have.role) => *have = org,
                Some(have) => {
                    have.teams.extend(org.teams);
                    have.idp_decides |= org.idp_decides;
                }
                None => {
                    merged.insert(org.org_id.clone(), org);
                }
            }
        }
        groups_out.push(json!({ "providerId": provider_id, "providerName": provider_name, "groups": groups }));
    }
    let outcome = Outcome { refused, orgs: merged.into_values().collect() };
    Ok(Json(json!({ "groups": groups_out, "outcome": outcome_json(&state, &outcome).await? })))
}

// ---------------------------------------------------------------------------------------------
// Administration: local sign-in

/// Whether `user_id` is an enabled server admin with a password.
async fn break_glass_valid(state: &AppState, user_id: &str) -> ApiResult<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM users WHERE id = $1 AND is_server_admin = 1 AND disabled = 0 AND password_hash IS NOT NULL",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.is_some())
}

/// Whether `user_id` may be the break-glass admin while password sign-in is off: valid, and with
/// a second factor (`auth::second_factor`), so a password alone never opens the server.
async fn break_glass_ready(state: &AppState, user_id: &str) -> ApiResult<bool> {
    Ok(break_glass_valid(state, user_id).await? && crate::auth::second_factor::methods(&state.db, user_id).await?.any())
}

struct Checks {
    provider: Option<String>,
    break_glass: bool,
    self_via_provider: bool,
    password_only: i64,
}

async fn checks(state: &AppState, break_glass: Option<&str>, me: &str) -> ApiResult<Checks> {
    let provider: Option<(String,)> = sqlx::query_as(
        "SELECT name FROM sso_providers WHERE enabled = 1 AND kind IN ('oidc', 'ldap') AND checked_at IS NOT NULL \
         ORDER BY position LIMIT 1",
    )
    .fetch_optional(&state.db)
    .await?;
    let ready = match break_glass {
        Some(id) => break_glass_ready(state, id).await?,
        None => false,
    };
    let via: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id WHERE i.user_id = $1 \
         AND p.enabled = 1 LIMIT 1",
    )
    .bind(me)
    .fetch_optional(&state.db)
    .await?;
    let (password_only,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM users u WHERE u.disabled = 0 AND u.password_hash IS NOT NULL \
         AND NOT EXISTS (SELECT 1 FROM sso_identities i WHERE i.user_id = u.id)",
    )
    .fetch_one(&state.db)
    .await?;
    Ok(Checks {
        provider: provider.map(|(n,)| n),
        break_glass: ready,
        self_via_provider: via.is_some() || break_glass == Some(me),
        password_only,
    })
}

async fn local_value(state: &AppState, me: &str) -> ApiResult<Value> {
    use crate::settings::Source;
    let policy = crate::sso::local_policy(state).await?;
    let mut read_only = false;
    for key in ["signin.local_password", "signin.password_form", "signin.break_glass_user"] {
        read_only |=
            !matches!(crate::settings::effective(state, key).await?.source, Source::Database | Source::Default);
    }
    let break_glass = match &policy.break_glass {
        Some(id) => {
            let row: Option<(String, String)> = sqlx::query_as("SELECT name, email FROM users WHERE id = $1")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
            row.map(|(name, email)| json!({ "userId": id, "name": name, "email": email }))
        }
        None => None,
    };
    let c = checks(state, policy.break_glass.as_deref(), me).await?;
    Ok(json!({
        "localPassword": if policy.local_on { "on" } else { "off" },
        "passwordForm": policy.password_form,
        "breakGlass": break_glass,
        "readOnly": read_only,
        "checks": {
            "providerReady": { "ok": c.provider.is_some(), "name": c.provider },
            "breakGlassReady": { "ok": c.break_glass },
            "selfViaProvider": { "ok": c.self_via_provider },
            "passwordOnlyAccounts": c.password_only,
        },
    }))
}

async fn local(State(state): State<AppState>, Extension(admin): Extension<SessionUser>) -> ApiResult<Json<Value>> {
    Ok(Json(local_value(&state, &admin.id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBody {
    local_password: String,
    password_form: String,
    #[serde(default)]
    break_glass_user_id: Option<String>,
}

async fn set_local(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<LocalBody>,
) -> ApiResult<Json<Value>> {
    if !matches!(body.local_password.as_str(), "on" | "off") {
        return Err(ApiError::validation("localPassword must be on or off").with_field("localPassword"));
    }
    if !matches!(body.password_form.as_str(), "expanded" | "collapsed" | "hidden") {
        return Err(
            ApiError::validation("passwordForm must be expanded, collapsed or hidden").with_field("passwordForm")
        );
    }
    let break_glass = body.break_glass_user_id.clone().filter(|s| !s.is_empty());
    if let Some(id) = &break_glass
        && !break_glass_valid(&state, id).await?
    {
        return Err(field_error(
            "breakGlassUserId",
            "sso.break_glass_invalid",
            "the break-glass admin must be an enabled server admin with a password",
        ));
    }
    if body.local_password == "off" {
        let c = checks(&state, break_glass.as_deref(), &admin.id).await?;
        let failed = if c.provider.is_none() {
            Some("providerReady")
        } else if !c.break_glass {
            Some("breakGlassReady")
        } else if !c.self_via_provider {
            Some("selfViaProvider")
        } else {
            None
        };
        if let Some(check) = failed {
            return Err(conflict("turning password sign-in off would lock people out")
                .because("sso.local_off_blocked")
                .param("check", check));
        }
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let values = [
        ("signin.local_password", json!(body.local_password)),
        ("signin.password_form", json!(body.password_form)),
        ("signin.break_glass_user", json!(break_glass.clone().unwrap_or_default())),
    ];
    store_settings(&state, &mut tx, &values, &admin.id, now).await?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "localPassword": body.local_password, "passwordForm": body.password_form,
                          "breakGlassUserId": break_glass });
    audit(&mut tx, &actor, None, "sso.local_changed", ("settings", "signin.local_password"), summary).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    Ok(Json(local_value(&state, &admin.id).await?))
}

/// Refuses disabling the break-glass admin or taking their server admin role
/// (`routes::admin_users`).
pub async fn ensure_break_glass_kept(state: &AppState, user_id: &str, disabled: bool, is_admin: bool) -> ApiResult<()> {
    let policy = crate::sso::local_policy(state).await?;
    if policy.break_glass.as_deref() == Some(user_id) && (disabled || !is_admin) {
        return Err(conflict("the break-glass admin cannot be disabled or lose the server admin role")
            .because("sso.break_glass_protected"));
    }
    Ok(())
}
