//! SAML 2.0 providers (docs/api/sso.md, "SAML 2.0"): the check of their metadata or settings,
//! creating and changing them, test sign-ins, Kalzit's metadata per provider, and the sign-in:
//! the AuthnRequest (HTTP-Redirect), the ACS (HTTP-POST) and the step back into the browser that
//! started it. Pausing, ordering, removing and the group mapping are shared with every provider
//! (`routes::sso`).
//!
//! The ACS receives a cross-site POST from the provider, which carries no `SameSite=Lax` cookie.
//! It checks the answer completely (`sso::saml`), consumes the request it answers and the
//! assertion ID, and keeps the result with the sign-in; then it sends the browser on to
//! `/auth/saml/<slug>/finish`, a same-site GET that does carry the binding cookie. Only there,
//! in the browser that started the sign-in, does the account get its session. An answer posted
//! from another browser (login CSRF) ends at that step.

use std::collections::HashMap;

use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::sso::{
    clear_binding, complete_sign_in, field_error, hash, kind_mismatch, record_failure,
    refuse_unconfirmed_issuer_change, remove_links, see_other, set_binding, sign_in_page, test_outcome_for,
};
use super::support::{Actor, audit, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::{SessionUser, session};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::sso::saml::{self, Asserted, SamlConfig};
use crate::sso::store::{self, ProviderRow};

pub fn routes() -> Vec<RouteDef> {
    use Method as M;
    vec![
        route(M::POST, "/admin/sign-in/saml/check", Access::ServerAdmin, check),
        route(M::POST, "/admin/sign-in/saml", Access::ServerAdmin, create),
        route(M::PUT, "/admin/sign-in/saml/{providerId}", Access::ServerAdmin, update),
        route(M::POST, "/admin/sign-in/saml/test-sign-ins", Access::ServerAdmin, test_start),
    ]
}

/// Kalzit's metadata for a provider, outside `/api` (a stable address for the provider).
pub const METADATA_ROUTE: &str = "/auth/saml/{slug}/metadata";
/// The assertion consumer service (HTTP-POST from the provider).
pub const ACS_ROUTE: &str = "/auth/saml/{slug}/acs";
/// The same-site step after the ACS that ends the sign-in in the browser that started it.
pub const FINISH_ROUTE: &str = "/auth/saml/{slug}/finish";

/// A check is good for saving this long.
const CHECK_VALID_MS: i64 = 30 * 60 * 1000;
const MAX_ATTRIBUTE_CHARS: usize = 256;

// ---------------------------------------------------------------------------------------------
// The form

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SamlInput {
    #[serde(default)]
    metadata_url: Option<String>,
    /// An uploaded metadata file; only the check reads it.
    #[serde(default)]
    metadata_xml: Option<String>,
    #[serde(default)]
    idp_entity_id: Option<String>,
    #[serde(default)]
    sso_url: Option<String>,
    #[serde(default)]
    certificates: Option<Vec<String>>,
    #[serde(default)]
    email_attribute: Option<String>,
    #[serde(default)]
    name_attribute: Option<String>,
    #[serde(default)]
    groups_attribute: Option<String>,
    #[serde(default)]
    trust_email: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SamlBody {
    #[serde(default)]
    kind: Option<String>,
    slug: String,
    name: String,
    #[serde(default)]
    create_accounts: Option<bool>,
    #[serde(default)]
    trust_provider_mfa: Option<bool>,
    saml: SamlInput,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    check_token: Option<String>,
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    confirm_issuer_change: Option<bool>,
}

struct Valid {
    slug: String,
    name: String,
    create_accounts: bool,
    trust_provider_mfa: bool,
    metadata_url: String,
    metadata_xml: Option<String>,
    /// The provider's values as typed (or filled in from a check); empty when not given.
    idp_entity_id: String,
    sso_url: String,
    certificates: Vec<String>,
    email_attribute: String,
    name_attribute: String,
    groups_attribute: String,
    trust_email: bool,
    provider_id: Option<String>,
    check_token: Option<String>,
    version: Option<i64>,
    confirm_issuer_change: bool,
}

fn attribute(raw: Option<String>, default: fn() -> String, field: &'static str) -> ApiResult<String> {
    let value = raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(default);
    if value.chars().count() > MAX_ATTRIBUTE_CHARS || value.chars().any(char::is_control) {
        return Err(field_error(field, "saml.attribute_invalid", "an attribute name has 1 to 256 characters"));
    }
    Ok(value)
}

fn validate(body: SamlBody) -> ApiResult<Valid> {
    if body.kind.as_deref().is_some_and(|k| k != "saml") {
        return Err(kind_mismatch());
    }
    let slug = body.slug.trim().to_string();
    if !crate::sso::valid_slug(&slug) {
        return Err(field_error("slug", "sso.slug_invalid", "the slug needs 1 to 40 of a-z, 0-9 and -"));
    }
    let name = super::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let s = body.saml;
    let metadata_url = s.metadata_url.unwrap_or_default().trim().to_string();
    if !metadata_url.is_empty()
        && (crate::sso::oidc::check_endpoint(&metadata_url).is_none() || metadata_url.len() > 2048)
    {
        return Err(field_error(
            "metadataUrl",
            "saml.metadata_url_invalid",
            "the metadata URL must be an https:// address",
        ));
    }
    let metadata_xml = s.metadata_xml.filter(|x| !x.trim().is_empty());
    if metadata_xml.as_ref().is_some_and(|x| x.len() > saml::MAX_METADATA_BYTES) {
        return Err(field_error("metadataXml", "saml.metadata_invalid", "the metadata file is larger than 1 MB"));
    }
    let certificates: Vec<String> = s
        .certificates
        .unwrap_or_default()
        .into_iter()
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();
    Ok(Valid {
        slug,
        name,
        create_accounts: body.create_accounts.unwrap_or(true),
        trust_provider_mfa: body.trust_provider_mfa.unwrap_or(false),
        metadata_url,
        metadata_xml,
        idp_entity_id: s.idp_entity_id.unwrap_or_default().trim().to_string(),
        sso_url: s.sso_url.unwrap_or_default().trim().to_string(),
        certificates,
        email_attribute: attribute(s.email_attribute, saml::default_email_attribute, "emailAttribute")?,
        name_attribute: attribute(s.name_attribute, saml::default_name_attribute, "nameAttribute")?,
        groups_attribute: attribute(s.groups_attribute, saml::default_groups_attribute, "groupsAttribute")?,
        trust_email: s.trust_email.unwrap_or(false),
        provider_id: body.provider_id,
        check_token: body.check_token,
        version: body.version,
        confirm_issuer_change: body.confirm_issuer_change.unwrap_or(false),
    })
}

/// The settings from the provider's values as given (no metadata read): what is saved.
fn config_of(valid: &Valid) -> ApiResult<SamlConfig> {
    config_from(valid, &valid.idp_entity_id, &valid.sso_url, &valid.certificates, &valid.metadata_url)
}

/// The settings from the form's attributes and the provider's values `entity`, `sso_url` and
/// `certificates`, each checked.
fn config_from(
    valid: &Valid,
    entity: &str,
    sso_url: &str,
    raw_certificates: &[String],
    metadata_url: &str,
) -> ApiResult<SamlConfig> {
    if entity.is_empty() || entity.chars().count() > 1024 || entity.chars().any(char::is_control) {
        return Err(field_error("idpEntityId", "saml.entity_id_invalid", "the provider's entity ID is required"));
    }
    if sso_url.len() > 2048 || crate::sso::oidc::check_endpoint(sso_url).is_none() {
        return Err(field_error("ssoUrl", "saml.sso_url_invalid", "the sign-in URL must be an https:// address"));
    }
    if raw_certificates.is_empty() {
        return Err(field_error("certificates", "saml.certificate_required", "pin the provider's signing certificate"));
    }
    if raw_certificates.len() > saml::MAX_CERTIFICATES {
        return Err(field_error("certificates", "saml.certificate_invalid", "at most two certificates are pinned"));
    }
    let mut certificates = Vec::new();
    for raw in raw_certificates {
        let der = saml::certificate_der(raw)
            .map_err(|e| field_error("certificates", "saml.certificate_invalid", &e).param("detail", e))?;
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, der);
        if !certificates.contains(&b64) {
            certificates.push(b64);
        }
    }
    Ok(SamlConfig {
        metadata_url: metadata_url.to_string(),
        idp_entity_id: entity.to_string(),
        sso_url: sso_url.to_string(),
        certificates,
        email_attribute: valid.email_attribute.clone(),
        name_attribute: valid.name_attribute.clone(),
        groups_attribute: valid.groups_attribute.clone(),
        trust_email: valid.trust_email,
    })
}

/// Kalzit's own address for SAML, which must be configured (`server.public_url`).
fn base(state: &AppState) -> ApiResult<String> {
    crate::sso::saml_base(state).ok_or_else(|| {
        ApiError::validation("set the public address (server.public_url) first; SAML addresses are built from it")
            .because("saml.public_url_missing")
    })
}

async fn read_metadata(state: &AppState, url: &str) -> ApiResult<String> {
    let unreachable = |detail: String| {
        field_error("metadataUrl", "saml.metadata_unreachable", &format!("the metadata cannot be read: {detail}"))
            .param("detail", detail)
    };
    let parsed = url::Url::parse(url).map_err(|e| unreachable(e.to_string()))?;
    let mut headers = HeaderMap::new();
    headers.insert(header::ACCEPT, HeaderValue::from_static("application/samlmetadata+xml, application/xml, text/xml"));
    let response = state.sso.client(state).get(parsed, headers).await.map_err(|e| unreachable(e.detail().message))?;
    let status = response.status();
    if !status.is_success() {
        return Err(unreachable(format!("HTTP {}", status.as_u16())));
    }
    let body = crate::http::read_limited(response, saml::MAX_METADATA_BYTES)
        .await
        .map_err(|e| unreachable(e.detail().message))?;
    String::from_utf8(body).map_err(|_| {
        field_error("metadataUrl", "saml.metadata_invalid", "the metadata is not UTF-8").param("detail", "not UTF-8")
    })
}

/// The settings the check found: from an uploaded file, else from the metadata URL, else the
/// values as typed.
async fn resolve(state: &AppState, valid: &Valid) -> ApiResult<SamlConfig> {
    let (xml, field) = match (&valid.metadata_xml, valid.metadata_url.is_empty()) {
        (Some(xml), _) => (Some(xml.clone()), "metadataXml"),
        (None, false) => (Some(read_metadata(state, &valid.metadata_url).await?), "metadataUrl"),
        (None, true) => (None, "idpEntityId"),
    };
    let Some(xml) = xml else { return config_of(valid) };
    let found = saml::parse_metadata(&xml).map_err(|e| {
        field_error(field, "saml.metadata_invalid", &format!("the metadata cannot be used: {e}")).param("detail", e)
    })?;
    let metadata_url = if valid.metadata_xml.is_some() { "" } else { valid.metadata_url.as_str() };
    config_from(valid, &found.entity_id, &found.sso_url, &found.certificates, metadata_url)
        .map_err(|e| e.with_field(field))
}

fn check_material(config: &SamlConfig, at: i64) -> Vec<u8> {
    format!("kalzit-saml-check\0{}\0{}\0{}\0{at}", config.idp_entity_id, config.sso_url, config.certificates.join(","))
        .into_bytes()
}

fn issue_check_token(state: &AppState, config: &SamlConfig, now: i64) -> String {
    format!("{now}.{}", hex::encode(state.secrets.sign(&check_material(config, now))))
}

fn verify_check_token(state: &AppState, token: Option<&str>, config: &SamlConfig, now: i64) -> ApiResult<()> {
    let ok = token.and_then(|t| t.split_once('.')).is_some_and(|(at, mac)| {
        let (Ok(at), Ok(mac)) = (at.parse::<i64>(), hex::decode(mac)) else { return false };
        now - at <= CHECK_VALID_MS && at <= now && state.secrets.verify(&check_material(config, at), &mac)
    });
    if ok { Ok(()) } else { Err(field_error("idpEntityId", "saml.check_required", "check these values first")) }
}

fn certificate_infos(config: &SamlConfig, now: i64) -> Vec<saml::CertificateInfo> {
    config.certificates.iter().filter_map(|c| saml::certificate_info(c, now)).collect()
}

fn sp_json(state: &AppState, slug: &str) -> Value {
    match crate::sso::saml_base(state) {
        Some(b) => json!({
            "spEntityId": saml::sp_entity_id(&b, slug), "acsUrl": saml::acs_url(&b, slug),
            "spMetadataUrl": saml::sp_metadata_url(&b, slug),
        }),
        None => json!({ "spEntityId": null, "acsUrl": null, "spMetadataUrl": null }),
    }
}

async fn check(State(state): State<AppState>, JsonBody(body): JsonBody<SamlBody>) -> ApiResult<Json<Value>> {
    let valid = validate(body)?;
    base(&state)?;
    let started = std::time::Instant::now();
    let config = resolve(&state, &valid).await?;
    let now = state.clock.now_ms();
    let mut answer = json!({
        "checkToken": issue_check_token(&state, &config, now),
        "durationMs": started.elapsed().as_millis() as u64,
        "saml": {
            "metadataUrl": config.metadata_url, "idpEntityId": config.idp_entity_id, "ssoUrl": config.sso_url,
            "certificates": config.certificates,
        },
        "certificates": certificate_infos(&config, now),
    });
    if let (Some(a), Value::Object(sp)) = (answer.as_object_mut(), sp_json(&state, &valid.slug)) {
        a.extend(sp);
    }
    Ok(Json(answer))
}

/// A SAML provider as the API shows it (`GET /admin/sign-in/providers/{id}`).
pub async fn provider_json(state: &AppState, row: &ProviderRow) -> ApiResult<Value> {
    let c = row.saml()?;
    let now = state.clock.now_ms();
    let mut value = json!({
        "id": row.id, "slug": row.slug, "kind": row.kind, "name": row.name, "enabled": row.enabled != 0,
        "position": row.position, "version": row.version, "createAccounts": row.create_accounts != 0,
        "trustProviderMfa": row.trust_provider_mfa != 0, "checkedAt": row.checked_at,
        "saml": {
            "metadataUrl": c.metadata_url, "idpEntityId": c.idp_entity_id, "ssoUrl": c.sso_url,
            "certificates": c.certificates, "certificateInfo": certificate_infos(&c, now),
            "emailAttribute": c.email_attribute, "nameAttribute": c.name_attribute,
            "groupsAttribute": c.groups_attribute, "trustEmail": c.trust_email,
        },
    });
    if let (Some(v), Value::Object(sp)) = (value.as_object_mut(), sp_json(state, &row.slug)) {
        v.extend(sp);
    }
    Ok(value)
}

async fn load(state: &AppState, id: &str) -> ApiResult<ProviderRow> {
    let row = store::by_id(&state.db, id).await?.ok_or_else(ApiError::not_found)?;
    if row.kind != "saml" {
        return Err(kind_mismatch());
    }
    Ok(row)
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<SamlBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let valid = validate(body)?;
    base(&state)?;
    let config = config_of(&valid)?;
    let now = state.clock.now_ms();
    let trusting = valid.trust_email || valid.trust_provider_mfa;
    super::sso::require_fresh_for_trust(&state, &admin.id, &headers, info.https, trusting, now).await?;
    verify_check_token(&state, valid.check_token.as_deref(), &config, now)?;
    let id = super::new_id();
    let taken = || conflict("another provider has this slug").with_field("slug").because("sso.slug_taken");
    let mut tx = crate::db::begin(&state.db).await?;
    if store::by_slug(&mut *tx, &valid.slug).await?.is_some() {
        return Err(taken());
    }
    let (position,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(position) + 1, 0) FROM sso_providers").fetch_one(&mut *tx).await?;
    let stored = serde_json::to_string(&config).map_err(|e| ApiError::internal("sso", e))?;
    let inserted = sqlx::query(
        "INSERT INTO sso_providers (id, slug, kind, name, position, enabled, config, create_accounts, \
         trust_provider_mfa, checked_at, version, created_at, updated_at) \
         VALUES ($1, $2, 'saml', $3, $4, 1, $5, $6, $7, $8, 1, $9, $10)",
    )
    .bind(&id)
    .bind(&valid.slug)
    .bind(&valid.name)
    .bind(position)
    .bind(&stored)
    .bind(i64::from(valid.create_accounts))
    .bind(i64::from(valid.trust_provider_mfa))
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await;
    if let Err(e) = inserted {
        return Err(if is_unique_violation(&e) { taken() } else { e.into() });
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "providerId": id, "slug": valid.slug, "kind": "saml" });
    audit(&mut tx, &actor, None, "sso.provider_created", ("sso_provider", &id), summary).await?;
    crate::db::commit(tx).await?;
    let row = load(&state, &id).await?;
    Ok((StatusCode::CREATED, Json(provider_json(&state, &row).await?)))
}

async fn update(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<SamlBody>,
) -> ApiResult<Json<Value>> {
    let valid = validate(body)?;
    let current = load(&state, &id).await?;
    if valid.slug != current.slug {
        return Err(field_error("slug", "sso.slug_invalid", "the slug of a provider cannot change"));
    }
    if valid.version != Some(current.version) {
        return Err(ApiError::version_conflict(provider_json(&state, &current).await?));
    }
    let old = current.saml()?;
    let config = config_of(&valid)?;
    let now = state.clock.now_ms();
    let trusting = old.trust_email || valid.trust_email || current.trust_provider_mfa != 0 || valid.trust_provider_mfa;
    super::sso::require_fresh_for_trust(&state, &admin.id, &headers, info.https, trusting, now).await?;
    // A new entity ID, sign-in URL or certificate is a new trust: checked first.
    let trust_changed = !old.same_trust(&config);
    if trust_changed {
        verify_check_token(&state, valid.check_token.as_deref(), &config, now)?;
    }
    // NameIDs are only unique per entity ID: with another provider, the people linked through
    // the old one are not the same people.
    let entity_changed = old.idp_entity_id != config.idp_entity_id;
    if entity_changed && !valid.confirm_issuer_change {
        refuse_unconfirmed_issuer_change(&state, &id, "idpEntityId").await?;
    }
    let mut fields = Vec::new();
    if valid.name != current.name {
        fields.push("name");
    }
    if old != config {
        fields.push("saml");
    }
    if valid.create_accounts != (current.create_accounts != 0) {
        fields.push("createAccounts");
    }
    if valid.trust_provider_mfa != (current.trust_provider_mfa != 0) {
        fields.push("trustProviderMfa");
    }
    let stored = serde_json::to_string(&config).map_err(|e| ApiError::internal("sso", e))?;
    let mut tx = crate::db::begin(&state.db).await?;
    let changed = sqlx::query(
        "UPDATE sso_providers SET name = $1, config = $2, create_accounts = $3, trust_provider_mfa = $4, \
         checked_at = CASE WHEN $5 = 1 THEN $6 ELSE checked_at END, version = version + 1, updated_at = $7 \
         WHERE id = $8 AND version = $9",
    )
    .bind(&valid.name)
    .bind(&stored)
    .bind(i64::from(valid.create_accounts))
    .bind(i64::from(valid.trust_provider_mfa))
    .bind(i64::from(trust_changed))
    .bind(now)
    .bind(now)
    .bind(&id)
    .bind(current.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed == 0 {
        drop(tx);
        let latest = load(&state, &id).await?;
        return Err(ApiError::version_conflict(provider_json(&state, &latest).await?));
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let touched = if entity_changed {
        remove_links(&mut tx, &info, &actor, &id, &current.slug).await?
    } else {
        Default::default()
    };
    let summary = json!({ "providerId": id, "fields": fields });
    audit(&mut tx, &actor, None, "sso.provider_updated", ("sso_provider", &id), summary).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(&state, &touched).await;
    let row = load(&state, &id).await?;
    Ok(Json(provider_json(&state, &row).await?))
}

/// The form a test sign-in tests, as kept with it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Draft {
    slug: String,
    provider_id: Option<String>,
    config: SamlConfig,
}

async fn test_start(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SamlBody>,
) -> ApiResult<(StatusCode, HeaderMap, Json<Value>)> {
    let valid = validate(body)?;
    let base = base(&state)?;
    if let Some(id) = &valid.provider_id {
        load(&state, id).await?;
    }
    let config = config_of(&valid)?;
    let now = state.clock.now_ms();
    verify_check_token(&state, valid.check_token.as_deref(), &config, now)?;
    let request_id = saml::request_id();
    let (sp, acs) = (saml::sp_entity_id(&base, &valid.slug), saml::acs_url(&base, &valid.slug));
    let url = saml::redirect_url(&config, &sp, &acs, &request_id, now)
        .map_err(|e| ApiError::internal("sso", format!("the SAML request cannot be built: {e}")))?;
    let id = super::new_id();
    let draft = Draft { slug: valid.slug.clone(), provider_id: valid.provider_id.clone(), config };
    let draft = serde_json::to_string(&draft).map_err(|e| ApiError::internal("sso", e))?;
    let binding = crate::sso::oidc::random_token();
    sqlx::query(
        "INSERT INTO sso_sign_ins (id, state_hash, binding_hash, provider_id, purpose, nonce, redirect_uri, \
         return_to, draft, created_by, status, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, 'test', $5, $6, '/', $7, $8, 'pending', $9, $10)",
    )
    .bind(&id)
    .bind(hash(&request_id))
    .bind(hash(&binding))
    .bind(valid.provider_id.as_deref())
    .bind(&request_id)
    .bind(&acs)
    .bind(&draft)
    .bind(&admin.id)
    .bind(now)
    .bind(now + crate::sso::SIGN_IN_TTL_MS)
    .execute(&state.db)
    .await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, set_binding(&binding, info.https));
    Ok((StatusCode::CREATED, headers, Json(json!({ "id": id, "url": url }))))
}

// ---------------------------------------------------------------------------------------------
// Signing in

/// `GET /api/auth/sso/<slug>/start` for a SAML provider: the AuthnRequest, with its ID kept as
/// the single-use request the answer must name.
pub async fn start(
    state: &AppState,
    info: &RequestInfo,
    provider: &ProviderRow,
    return_to: Option<&str>,
) -> ApiResult<Response> {
    let ids = Some((provider.id.as_str(), provider.slug.as_str()));
    let Some(base) = crate::sso::saml_base(state) else {
        let r = record_failure(state, info, ids, None, "saml.public_url_missing", "server.public_url is not set").await;
        return Ok(see_other(&sign_in_page("unavailable", &provider.slug, Some(&r)), Vec::new()));
    };
    let config = provider.saml()?;
    let now = state.clock.now_ms();
    let request_id = saml::request_id();
    let (sp, acs) = (saml::sp_entity_id(&base, &provider.slug), saml::acs_url(&base, &provider.slug));
    let url = match saml::redirect_url(&config, &sp, &acs, &request_id, now) {
        Ok(url) => url,
        Err(e) => {
            let r = record_failure(state, info, ids, None, "sso.internal", &e).await;
            return Ok(see_other(&sign_in_page("unavailable", &provider.slug, Some(&r)), Vec::new()));
        }
    };
    let binding = crate::sso::oidc::random_token();
    sqlx::query(
        "INSERT INTO sso_sign_ins (id, state_hash, binding_hash, provider_id, purpose, nonce, redirect_uri, \
         return_to, status, created_at, expires_at) VALUES ($1, $2, $3, $4, 'sign_in', $5, $6, $7, 'pending', $8, $9)",
    )
    .bind(super::new_id())
    .bind(hash(&request_id))
    .bind(hash(&binding))
    .bind(&provider.id)
    .bind(&request_id)
    .bind(&acs)
    .bind(crate::sso::safe_return_to(return_to))
    .bind(now)
    .bind(now + crate::sso::SIGN_IN_TTL_MS)
    .execute(&state.db)
    .await?;
    Ok(see_other(&url, vec![set_binding(&binding, info.https)]))
}

#[derive(sqlx::FromRow)]
struct SignInRow {
    id: String,
    provider_id: Option<String>,
    purpose: String,
    nonce: String,
    redirect_uri: String,
    return_to: String,
    draft: Option<String>,
    result: Option<String>,
}

const ROW_COLUMNS: &str =
    "SELECT id, provider_id, purpose, nonce, redirect_uri, return_to, draft, result FROM sso_sign_ins";

/// The provider a sign-in goes through: the stored one, or the form a test sign-in tests.
struct Target {
    provider: ProviderRow,
    config: SamlConfig,
}

async fn load_target(state: &AppState, row: &SignInRow, slug: &str) -> ApiResult<Option<Target>> {
    if row.purpose == "test" {
        let Some(draft) = row.draft.as_deref().and_then(|d| serde_json::from_str::<Draft>(d).ok()) else {
            return Ok(None);
        };
        if draft.slug != slug {
            return Ok(None);
        }
        let stored = match &draft.provider_id {
            Some(id) => store::by_id(&state.db, id).await?,
            None => None,
        };
        let provider = ProviderRow {
            id: draft.provider_id.clone().unwrap_or_default(),
            slug: draft.slug.clone(),
            kind: "saml".into(),
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
        return Ok(Some(Target { provider, config: draft.config }));
    }
    let Some(id) = &row.provider_id else { return Ok(None) };
    let found = store::by_id(&state.db, id).await?.filter(|p| p.enabled != 0 && p.slug == slug && p.kind == "saml");
    let Some(provider) = found else { return Ok(None) };
    let config = provider.saml()?;
    Ok(Some(Target { provider, config }))
}

/// Ends a test sign-in with its result for the admin (`GET /admin/sign-in/test-sign-ins/{id}`):
/// what it found, or the reason it failed with its params.
async fn end_test(state: &AppState, id: &str, result: Result<Value, (&str, &str, Value)>) -> ApiResult<()> {
    let (status, value) = match result {
        Ok(v) => ("done", v),
        Err((outcome, reason, params)) => ("failed", json!({ "reason": reason, "outcome": outcome, "params": params })),
    };
    sqlx::query("UPDATE sso_sign_ins SET status = $1, result = $2 WHERE id = $3")
        .bind(status)
        .bind(value.to_string())
        .bind(id)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Ends a sign-in that failed: recorded for admins, the row ended, the person sent to the sign-in
/// page (an admin's test to its result page).
#[expect(clippy::too_many_arguments, reason = "the parts of one failure, passed on as they are")]
async fn fail(
    state: &AppState,
    info: &RequestInfo,
    slug: &str,
    row: Option<&SignInRow>,
    provider: Option<(&str, &str)>,
    outcome: &'static str,
    reason: &str,
    detail: &str,
) -> ApiResult<Response> {
    fail_with(state, info, slug, row, provider, (outcome, reason, json!({})), detail).await
}

/// `fail`, with the params of the reason for an admin's test.
async fn fail_with(
    state: &AppState,
    info: &RequestInfo,
    slug: &str,
    row: Option<&SignInRow>,
    provider: Option<(&str, &str)>,
    (outcome, reason, params): (&'static str, &str, Value),
    detail: &str,
) -> ApiResult<Response> {
    let r = record_failure(state, info, provider, None, reason, detail).await;
    let test = row.is_some_and(|r| r.purpose == "test");
    if let Some(row) = row {
        if test {
            end_test(state, &row.id, Err((outcome, reason, params))).await?;
        } else {
            sqlx::query("DELETE FROM sso_sign_ins WHERE id = $1").bind(&row.id).execute(&state.db).await?;
        }
    }
    let page = if test { "/anmelden/sso-test".to_string() } else { sign_in_page(outcome, slug, Some(&r)) };
    Ok(see_other(&page, vec![clear_binding(info.https)]))
}

/// `POST /auth/saml/<slug>/acs`: the provider's answer.
pub async fn acs(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(slug): Path<String>,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    use crate::auth::ratelimit::{address_key, network_key};
    let mono = state.clock.monotonic_ms();
    if state
        .sso
        .start_limiter
        .try_acquire(&address_key("saml-acs", info.client_ip), &network_key(info.client_ip), mono)
        .is_err()
    {
        return see_other(&sign_in_page("unavailable", &slug, None), Vec::new());
    }
    match acs_inner(&state, &info, &slug, &form).await {
        Ok(response) => response,
        Err(e) => {
            let r = record_failure(&state, &info, None, None, "sso.internal", &e.message).await;
            see_other(&sign_in_page("unavailable", &slug, Some(&r)), vec![clear_binding(info.https)])
        }
    }
}

async fn acs_inner(
    state: &AppState,
    info: &RequestInfo,
    slug: &str,
    form: &HashMap<String, String>,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    let Some(raw) = form.get("SAMLResponse") else {
        return fail(
            state,
            info,
            slug,
            None,
            None,
            "failed",
            "saml.response_missing",
            "the provider sent no SAMLResponse",
        )
        .await;
    };
    let xml = match saml::decode_post(raw) {
        Ok(x) => x,
        Err(e) => return fail(state, info, slug, None, None, "failed", e.reason(), &e.to_string()).await,
    };
    let request_id = match saml::in_response_to(&xml) {
        Ok(id) => id,
        Err(e) => return fail(state, info, slug, None, None, "failed", e.reason(), &e.to_string()).await,
    };
    // Each AuthnRequest is answered once: the row is taken before anything else happens.
    let taken = sqlx::query(
        "UPDATE sso_sign_ins SET status = 'running' WHERE state_hash = $1 AND status = 'pending' AND expires_at > $2",
    )
    .bind(hash(&request_id))
    .bind(now)
    .execute(&state.db)
    .await?
    .rows_affected();
    let row: Option<SignInRow> = if taken == 1 {
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{ROW_COLUMNS} WHERE state_hash = $1")))
            .bind(hash(&request_id))
            .fetch_optional(&state.db)
            .await?
    } else {
        None
    };
    let Some(row) = row else {
        return fail(
            state,
            info,
            slug,
            None,
            None,
            "expired",
            "saml.request_unknown",
            "the request is unknown, used or expired",
        )
        .await;
    };
    let Some(target) = load_target(state, &row, slug).await? else {
        let detail = "the provider is paused or gone";
        return fail(state, info, slug, Some(&row), None, "unavailable", "sso.provider_unavailable", detail).await;
    };
    let ids = Some((target.provider.id.as_str(), target.provider.slug.as_str()));
    // The ACS this answer must name, from the public URL only; the one the request named.
    let Some(base) = crate::sso::saml_base(state) else {
        return fail(
            state,
            info,
            slug,
            Some(&row),
            ids,
            "unavailable",
            "saml.public_url_missing",
            "server.public_url is not set",
        )
        .await;
    };
    let (sp, acs) = (saml::sp_entity_id(&base, slug), saml::acs_url(&base, slug));
    if acs != row.redirect_uri {
        let detail = "the public address changed during the sign-in";
        return fail(state, info, slug, Some(&row), ids, "failed", "saml.destination", detail).await;
    }
    let certificates = target.config.certificate_der();
    let expected = saml::Expected {
        idp_entity_id: &target.config.idp_entity_id,
        certificates: &certificates,
        sp_entity_id: &sp,
        acs_url: &acs,
        request_id: &row.nonce,
        now_ms: now,
    };
    let asserted = match saml::check_response(&xml, &expected) {
        Ok(a) => a,
        Err(e) => {
            let why = (e.outcome(), e.reason(), e.params());
            return fail_with(state, info, slug, Some(&row), ids, why, &e.to_string()).await;
        }
    };
    // An assertion is used once, remembered until it would be refused anyway.
    let remembered = sqlx::query("INSERT INTO saml_assertions (issuer, assertion_id, expires_at) VALUES ($1, $2, $3)")
        .bind(&target.config.idp_entity_id)
        .bind(&asserted.assertion_id)
        .bind(asserted.expires_ms)
        .execute(&state.db)
        .await;
    if let Err(e) = remembered {
        if is_unique_violation(&e) {
            let detail = "the assertion was used before";
            return fail(state, info, slug, Some(&row), ids, "failed", "saml.replay", detail).await;
        }
        return Err(e.into());
    }
    let kept = serde_json::to_string(&asserted).map_err(|e| ApiError::internal("sso", e))?;
    sqlx::query("UPDATE sso_sign_ins SET status = 'asserted', result = $1 WHERE id = $2")
        .bind(&kept)
        .bind(&row.id)
        .execute(&state.db)
        .await?;
    let next = format!("{base}/auth/saml/{slug}/finish?s={}", row.id);
    Ok(see_other(&next, Vec::new()))
}

/// `GET /auth/saml/<slug>/finish?s=<sign-in>`: the checked answer, in the browser that started
/// the sign-in (its binding cookie), becomes a session, or an admin's test result.
pub async fn finish(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(slug): Path<String>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    match finish_inner(&state, &info, &slug, &headers, &query).await {
        Ok(response) => response,
        Err(e) => {
            let r = record_failure(&state, &info, None, None, "sso.internal", &e.message).await;
            see_other(&sign_in_page("unavailable", &slug, Some(&r)), vec![clear_binding(info.https)])
        }
    }
}

async fn finish_inner(
    state: &AppState,
    info: &RequestInfo,
    slug: &str,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    let id = query.get("s").filter(|s| !s.is_empty() && s.len() <= 64).cloned().unwrap_or_default();
    let binding = session::cookie_value(headers, super::sso::binding_cookie(info.https)).unwrap_or_default();
    let taken = sqlx::query(
        "UPDATE sso_sign_ins SET status = 'finishing' WHERE id = $1 AND binding_hash = $2 AND status = 'asserted' \
         AND expires_at > $3",
    )
    .bind(&id)
    .bind(hash(&binding))
    .bind(now)
    .execute(&state.db)
    .await?
    .rows_affected();
    let row: Option<SignInRow> = if taken == 1 && !binding.is_empty() {
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{ROW_COLUMNS} WHERE id = $1")))
            .bind(&id)
            .fetch_optional(&state.db)
            .await?
    } else {
        None
    };
    let Some(row) = row else {
        let detail = "the sign-in is unknown, used, expired or from another browser";
        return fail(state, info, slug, None, None, "expired", "sso.state_unknown", detail).await;
    };
    let asserted: Option<Asserted> = row.result.as_deref().and_then(|r| serde_json::from_str(r).ok());
    let (Some(asserted), Some(target)) = (asserted, load_target(state, &row, slug).await?) else {
        let detail = "the provider is paused or gone";
        return fail(state, info, slug, Some(&row), None, "unavailable", "sso.provider_unavailable", detail).await;
    };
    let person = saml::person(&target.config, &asserted);
    if row.purpose == "test" {
        let outcome = test_outcome_for(state, &target.provider.id, &person.groups).await?;
        let result = json!({
            "subject": person.subject, "username": person.username, "email": person.email,
            "groups": person.groups, "outcome": outcome,
        });
        end_test(state, &row.id, Ok(result)).await?;
        return Ok(see_other("/anmelden/sso-test", vec![clear_binding(info.https)]));
    }
    sqlx::query("DELETE FROM sso_sign_ins WHERE id = $1").bind(&row.id).execute(&state.db).await?;
    let issuer = target.config.idp_entity_id.clone();
    complete_sign_in(state, info, headers, &target.provider, &issuer, &person, slug, &row.return_to).await
}

/// `GET /auth/saml/<slug>/metadata`: Kalzit's metadata for the provider.
pub async fn metadata(State(state): State<AppState>, Path(slug): Path<String>) -> Response {
    let found = match store::by_slug(&state.read_db, &slug).await {
        Ok(p) => p.filter(|p| p.kind == "saml"),
        Err(e) => return e.into_response(),
    };
    let (Some(provider), Some(base)) = (found, crate::sso::saml_base(&state)) else {
        return ApiError::not_found().into_response();
    };
    let body = saml::sp_metadata(&saml::sp_entity_id(&base, &provider.slug), &saml::acs_url(&base, &provider.slug));
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/samlmetadata+xml"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"kalzit-{}.xml\"", provider.slug))
            .unwrap_or(HeaderValue::from_static("inline")),
    );
    (StatusCode::OK, headers, body).into_response()
}
