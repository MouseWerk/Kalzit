//! The administration of LDAP and Active Directory providers (docs/api/sso.md, "LDAP and Active
//! Directory"): the connection check, creating and changing a provider with its bind password,
//! and the directory sync with its halted runs. Pausing, ordering, removing and the group mapping
//! are shared with every provider (`routes::sso`).

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{Value, json};

use super::sso::{field_error, hash, kind_mismatch, outcome_json};
use super::support::{Actor, audit, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::{SessionUser, session};
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::sso::ldap::{self, Certificate, Encryption, Flavor, LdapConfig, LdapFail, Schedule};
use crate::sso::store::{self, ProviderRow};
use crate::sso::sync::{self, Trigger};

pub fn routes() -> Vec<RouteDef> {
    use Method as M;
    vec![
        route(M::POST, "/admin/sign-in/ldap/check", Access::ServerAdmin, check),
        route(M::POST, "/admin/sign-in/ldap", Access::ServerAdmin, create),
        route(M::PUT, "/admin/sign-in/ldap/{providerId}", Access::ServerAdmin, update),
        route(M::GET, "/admin/sign-in/providers/{providerId}/sync", Access::ServerAdmin, sync_status),
        route(M::POST, "/admin/sign-in/providers/{providerId}/sync", Access::ServerAdmin, sync_now),
        route(M::GET, "/admin/sign-in/providers/{providerId}/sync/runs/{runId}", Access::ServerAdmin, sync_run),
        route(
            M::POST,
            "/admin/sign-in/providers/{providerId}/sync/runs/{runId}/apply",
            Access::ServerAdmin,
            sync_apply,
        ),
    ]
}

/// A connection check is good for saving this long.
const CHECK_VALID_MS: i64 = 30 * 60 * 1000;
const MAX_PASSWORD_CHARS: usize = 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LdapInput {
    flavor: String,
    url: String,
    encryption: String,
    #[serde(default)]
    certificate: Option<String>,
    #[serde(default)]
    ca_pem: Option<String>,
    bind_dn: String,
    #[serde(default)]
    bind_password: Option<String>,
    user_base_dn: String,
    login_attribute: String,
    #[serde(default)]
    user_filter: Option<String>,
    #[serde(default)]
    group_base_dn: Option<String>,
    #[serde(default)]
    nested_groups: Option<bool>,
    #[serde(default)]
    email_attribute: Option<String>,
    #[serde(default)]
    name_attribute: Option<String>,
    #[serde(default)]
    trust_email: Option<bool>,
    #[serde(default)]
    sync_schedule: Option<String>,
    #[serde(default)]
    sync_hour: Option<i64>,
    #[serde(default)]
    sync_threshold: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LdapBody {
    #[serde(default)]
    kind: Option<String>,
    slug: String,
    name: String,
    #[serde(default)]
    create_accounts: Option<bool>,
    ldap: LdapInput,
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    check_token: Option<String>,
    #[serde(default)]
    version: Option<i64>,
    #[serde(default)]
    test_login: Option<String>,
    #[serde(default)]
    test_password: Option<String>,
}

struct Valid {
    slug: String,
    name: String,
    create_accounts: bool,
    config: LdapConfig,
    password: Option<String>,
    provider_id: Option<String>,
    check_token: Option<String>,
    version: Option<i64>,
    test_login: Option<String>,
    test_password: Option<String>,
}

fn attribute(raw: Option<String>, default: &str, field: &'static str) -> ApiResult<String> {
    let value = raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| default.to_string());
    if !ldap::valid_attribute(&value) {
        return Err(field_error(field, "ldap.attribute_invalid", "an attribute is 1 to 64 letters, digits and -"));
    }
    Ok(value)
}

fn dn(raw: &str, field: &'static str, required: bool) -> ApiResult<String> {
    let value = raw.trim().to_string();
    if (value.is_empty() && !required) || ldap::valid_dn(&value) {
        return Ok(value);
    }
    Err(field_error(field, "ldap.dn_invalid", "this is not a DN (attribute=value, separated by commas)"))
}

fn validate(body: LdapBody) -> ApiResult<Valid> {
    if body.kind.as_deref().is_some_and(|k| k != "ldap") {
        return Err(kind_mismatch());
    }
    let slug = body.slug.trim().to_string();
    if !crate::sso::valid_slug(&slug) {
        return Err(field_error("slug", "sso.slug_invalid", "the slug needs 1 to 40 of a-z, 0-9 and -"));
    }
    let name = super::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let l = body.ldap;
    let flavor = match l.flavor.as_str() {
        "ad" => Flavor::Ad,
        "ldap" => Flavor::Ldap,
        _ => return Err(ApiError::validation("flavor must be ad or ldap").with_field("flavor")),
    };
    let encryption = match l.encryption.as_str() {
        "ldaps" => Encryption::Ldaps,
        "starttls" => Encryption::Starttls,
        "none" => Encryption::None,
        _ => {
            return Err(field_error(
                "encryption",
                "ldap.scheme_conflict",
                "encryption must be ldaps, starttls or none",
            ));
        }
    };
    let url = l.url.trim().to_string();
    ldap::check_url(&url, encryption)
        .map_err(|(field, reason)| field_error(field, reason, "the URL or its encryption cannot be used"))?;
    let certificate = match l.certificate.as_deref().unwrap_or("system") {
        "system" => Certificate::System,
        "custom" => Certificate::Custom,
        _ => return Err(field_error("caPem", "ldap.ca_invalid", "certificate must be system or custom")),
    };
    let ca_pem = match certificate {
        Certificate::Custom => {
            let pem = l.ca_pem.unwrap_or_default().trim().to_string();
            if pem.len() > 64 * 1024 || ldap::read_ca(&pem).is_err() {
                return Err(field_error("caPem", "ldap.ca_invalid", "paste the CA certificates as PEM"));
            }
            Some(pem)
        }
        Certificate::System => None,
    };
    let bind_dn = dn(&l.bind_dn, "bindDn", true)?;
    let user_base_dn = dn(&l.user_base_dn, "userBaseDn", true)?;
    let group_base_dn = dn(l.group_base_dn.as_deref().unwrap_or_default(), "groupBaseDn", false)?;
    let login = l.login_attribute.trim();
    let Some(login_attribute) = ldap::login_attributes(flavor).iter().find(|a| a.eq_ignore_ascii_case(login)) else {
        return Err(field_error("loginAttribute", "ldap.attribute_invalid", "this login attribute is not offered"));
    };
    let user_filter = l.user_filter.unwrap_or_default().trim().to_string();
    if !ldap::valid_filter(&user_filter) {
        return Err(field_error("userFilter", "ldap.filter_invalid", "the filter must be one parenthesized filter"));
    }
    let default_name = if flavor == Flavor::Ad { "displayName" } else { "cn" };
    let sync_schedule = match l.sync_schedule.as_deref().unwrap_or("daily") {
        "daily" => Schedule::Daily,
        "every6h" => Schedule::Every6h,
        "off" => Schedule::Off,
        _ => {
            return Err(field_error(
                "syncSchedule",
                "ldap.schedule_invalid",
                "the schedule must be daily, every6h or off",
            ));
        }
    };
    let sync_hour = l.sync_hour.unwrap_or(2);
    if !(0..=23).contains(&sync_hour) {
        return Err(field_error("syncHour", "ldap.schedule_invalid", "the hour must be 0 to 23"));
    }
    let sync_threshold = l.sync_threshold.unwrap_or(10);
    if !(1..=100).contains(&sync_threshold) {
        return Err(field_error("syncThreshold", "ldap.threshold_invalid", "the limit must be 1 to 100 percent"));
    }
    let password = l.bind_password.filter(|p| !p.is_empty());
    if password.as_ref().is_some_and(|p| p.chars().count() > MAX_PASSWORD_CHARS || p.chars().any(char::is_control)) {
        return Err(field_error("bindPassword", "ldap.bind_password_required", "the bind password is not valid"));
    }
    let config = LdapConfig {
        flavor,
        url,
        encryption,
        certificate,
        ca_pem,
        bind_dn,
        user_base_dn,
        login_attribute: (*login_attribute).to_string(),
        user_filter,
        group_base_dn,
        nested_groups: flavor == Flavor::Ad && l.nested_groups.unwrap_or(false),
        email_attribute: attribute(l.email_attribute, "mail", "emailAttribute")?,
        name_attribute: attribute(l.name_attribute, default_name, "nameAttribute")?,
        trust_email: l.trust_email.unwrap_or(false),
        sync_schedule,
        sync_hour: sync_hour as u8,
        sync_threshold: sync_threshold as u8,
    };
    Ok(Valid {
        slug,
        name,
        create_accounts: body.create_accounts.unwrap_or(true),
        config,
        password,
        provider_id: body.provider_id,
        check_token: body.check_token,
        version: body.version,
        test_login: body.test_login.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()),
        test_password: body.test_password.filter(|p| !p.is_empty()),
    })
}

/// The bind password a form uses: the one typed, else the stored one of `provider_id` when the
/// form keeps its URL and bind DN, so a changed server never receives it.
async fn form_password(
    state: &AppState,
    valid: &Valid,
    provider_id: Option<&str>,
) -> ApiResult<zeroize::Zeroizing<String>> {
    if let Some(p) = &valid.password {
        return Ok(zeroize::Zeroizing::new(p.clone()));
    }
    if let Some(id) = provider_id
        && let Some(stored) = store::by_id(&state.db, id).await?
        && stored.kind == "ldap"
        && let Ok(config) = stored.ldap()
        && config.same_connection(&valid.config)
        && let Some(p) = store::secret(&state.db, &state.secrets, id, ldap::BIND_PASSWORD).await?
    {
        return Ok(zeroize::Zeroizing::new(p.as_str().to_string()));
    }
    Err(field_error(
        "bindPassword",
        "ldap.bind_password_required",
        "enter the bind password: a new provider, or a changed URL, bind DN, encryption or certificate, needs it",
    ))
}

fn check_material(config: &LdapConfig, password: &str, at: i64) -> Vec<u8> {
    let encryption = serde_json::to_string(&config.encryption).unwrap_or_default();
    let certificate = serde_json::to_string(&config.certificate).unwrap_or_default();
    format!(
        "kalzit-ldap-check\0{}\0{encryption}\0{certificate}\0{}\0{}\0{}\0{at}",
        config.url,
        hash(config.ca_pem.as_deref().unwrap_or_default()),
        config.bind_dn,
        hash(password)
    )
    .into_bytes()
}

fn issue_check_token(state: &AppState, config: &LdapConfig, password: &str, now: i64) -> String {
    format!("{now}.{}", hex::encode(state.secrets.sign(&check_material(config, password, now))))
}

fn verify_check_token(
    state: &AppState,
    token: Option<&str>,
    config: &LdapConfig,
    password: &str,
    now: i64,
) -> ApiResult<()> {
    let ok = token.and_then(|t| t.split_once('.')).is_some_and(|(at, mac)| {
        let (Ok(at), Ok(mac)) = (at.parse::<i64>(), hex::decode(mac)) else { return false };
        now - at <= CHECK_VALID_MS && at <= now && state.secrets.verify(&check_material(config, password, at), &mac)
    });
    if ok {
        Ok(())
    } else {
        Err(field_error("url", "ldap.check_required", "check the connection with these values first"))
    }
}

/// A failure of the check, at the field it is about.
fn check_error(e: &LdapFail) -> ApiError {
    let message = e.to_string();
    match e {
        LdapFail::Unreachable(d) | LdapFail::Other(d) => {
            field_error("url", "ldap.unreachable", &message).param("detail", d)
        }
        LdapFail::Busy => field_error("url", "ldap.unreachable", &message).param("detail", &message),
        LdapFail::Timeout => field_error("url", "ldap.timeout", &message),
        LdapFail::Refused(d) => field_error("url", "ldap.target_refused", &message).param("detail", d),
        LdapFail::PlainNotAllowed => field_error("url", "ldap.plain_not_allowed", &message),
        LdapFail::Certificate(d) => field_error("caPem", "ldap.certificate_untrusted", &message).param("detail", d),
        LdapFail::Tls(d) => field_error("encryption", "ldap.tls_failed", &message).param("detail", d),
        LdapFail::Bind { code, text } => {
            field_error("bindPassword", "ldap.bind_failed", &message).param("code", code).param("detail", text)
        }
        LdapFail::EmptyPassword => field_error("bindPassword", "ldap.bind_password_required", &message),
        LdapFail::NoSuchObject => field_error("userBaseDn", "ldap.base_not_found", &message),
        LdapFail::Search { code, text } => {
            field_error("userFilter", "ldap.search_failed", &message).param("code", code).param("detail", text)
        }
    }
}

async fn check(State(state): State<AppState>, JsonBody(body): JsonBody<LdapBody>) -> ApiResult<Json<Value>> {
    let valid = validate(body)?;
    let provider_id = valid.provider_id.clone();
    let password = form_password(&state, &valid, provider_id.as_deref()).await?;
    let config = &valid.config;
    let started = std::time::Instant::now();
    let connector = state.sso.ldap(&state);
    let mut dir = ldap::service(&connector, config, &password).await.map_err(|e| check_error(&e))?;
    let outcome = check_with(&state, &mut dir, &connector, &valid, provider_id.as_deref()).await;
    dir.close().await;
    let (sample, test) = outcome?;
    let now = state.clock.now_ms();
    Ok(Json(json!({
        "checkToken": issue_check_token(&state, config, &password, now),
        "durationMs": started.elapsed().as_millis() as u64,
        "tls": config.encryption.label(),
        "sample": sample,
        "test": test,
    })))
}

async fn check_with(
    state: &AppState,
    dir: &mut ldap::Directory,
    connector: &ldap::Connector,
    valid: &Valid,
    provider_id: Option<&str>,
) -> ApiResult<(Value, Value)> {
    use ldap3::Scope;
    let config = &valid.config;
    if !dir.exists(&config.user_base_dn).await.map_err(|e| check_error(&e))? {
        return Err(check_error(&LdapFail::NoSuchObject));
    }
    if !config.group_base_dn.is_empty() && !dir.exists(&config.group_base_dn).await.map_err(|e| check_error(&e))? {
        return Err(field_error("groupBaseDn", "ldap.group_base_not_found", "no such entry"));
    }
    let attrs = vec![config.login_attribute.clone()];
    let users = dir
        .search(&config.user_base_dn, Scope::Subtree, &config.people_filter(), &attrs, 5)
        .await
        .map_err(|e| check_error(&e))?;
    let users: Vec<String> =
        users.iter().filter_map(|e| ldap::DirEntry::read(config, e).login.or_else(|| Some(e.dn.clone()))).collect();
    let group_filter = match config.flavor {
        Flavor::Ad => "(objectClass=group)",
        Flavor::Ldap => "(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))",
    };
    let groups =
        dir.search(config.group_base(), Scope::Subtree, group_filter, &["1.1".to_string()], 5).await.map_err(|e| {
            match e {
                LdapFail::NoSuchObject => field_error("groupBaseDn", "ldap.group_base_not_found", "no such entry"),
                other => check_error(&other),
            }
        })?;
    let sample = json!({ "users": users, "groups": groups.iter().map(|g| g.dn.clone()).collect::<Vec<_>>() });
    let Some(login) = &valid.test_login else { return Ok((sample, Value::Null)) };
    let found = dir.find(config, login).await.map_err(|e| check_error(&e))?;
    let entry = match found.as_slice() {
        [] => return Err(field_error("testLogin", "ldap.test_user_not_found", "no entry matches this login")),
        [one] => one.clone(),
        _ => return Err(field_error("testLogin", "ldap.test_user_ambiguous", "more than one entry matches")),
    };
    if entry.disabled {
        return Err(field_error("testLogin", "ldap.test_user_disabled", "the entry is disabled in the directory"));
    }
    let groups = dir.groups(config, &entry).await.map_err(|e| check_error(&e))?;
    let bound = match &valid.test_password {
        Some(password) => {
            if !ldap::verify_password(connector, config, &entry.dn, password).await.map_err(|e| check_error(&e))? {
                return Err(field_error(
                    "testPassword",
                    "ldap.test_bind_failed",
                    "the directory refused this password",
                )
                .param("code", 49));
            }
            true
        }
        None => false,
    };
    let mapped = match provider_id {
        Some(id) => crate::sso::directory::mapped_groups(state, id).await?,
        None => Vec::new(),
    };
    let groups = ldap::spell_as_mapped(ldap::dedup_groups(groups), &mapped);
    let rules = match provider_id {
        Some(id) => crate::sso::mapping::rules(&state.db, id).await?,
        None => Vec::new(),
    };
    let outcome = crate::sso::mapping::resolve(&rules, &groups, &crate::sso::unmapped(state).await?);
    let test = json!({
        "dn": entry.dn, "login": entry.login.clone().unwrap_or_else(|| login.clone()), "email": entry.email, "name": entry.name, "disabled": entry.disabled,
        "bound": bound, "groups": groups, "outcome": outcome_json(state, &outcome).await?,
    });
    Ok((sample, test))
}

/// An LDAP provider as the API shows it (`GET /admin/sign-in/providers/{id}`).
pub async fn provider_json(state: &AppState, row: &ProviderRow) -> ApiResult<Value> {
    let c = row.ldap()?;
    let set: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM sso_provider_secrets WHERE provider_id = $1 AND field = $2")
            .bind(&row.id)
            .bind(ldap::BIND_PASSWORD)
            .fetch_optional(&state.db)
            .await?;
    Ok(json!({
        "id": row.id, "slug": row.slug, "kind": row.kind, "name": row.name, "enabled": row.enabled != 0,
        "position": row.position, "version": row.version, "createAccounts": row.create_accounts != 0,
        "trustProviderMfa": false, "checkedAt": row.checked_at,
        "ldap": {
            "flavor": c.flavor, "url": c.url, "encryption": c.encryption, "certificate": c.certificate,
            "caPem": c.ca_pem, "bindDn": c.bind_dn, "bindPasswordSet": set.is_some(), "userBaseDn": c.user_base_dn,
            "loginAttribute": c.login_attribute, "userFilter": c.user_filter, "groupBaseDn": c.group_base_dn,
            "nestedGroups": c.nested_groups, "emailAttribute": c.email_attribute, "nameAttribute": c.name_attribute,
            "trustEmail": c.trust_email, "syncSchedule": c.sync_schedule, "syncHour": c.sync_hour,
            "syncThreshold": c.sync_threshold,
        },
    }))
}

async fn load(state: &AppState, id: &str) -> ApiResult<ProviderRow> {
    let row = store::by_id(&state.db, id).await?.ok_or_else(ApiError::not_found)?;
    if row.kind != "ldap" {
        return Err(kind_mismatch());
    }
    Ok(row)
}

async fn create(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<LdapBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let valid = validate(body)?;
    let Some(password) = valid.password.clone() else {
        return Err(field_error(
            "bindPassword",
            "ldap.bind_password_required",
            "a new provider needs the bind password",
        ));
    };
    let now = state.clock.now_ms();
    let trusting = valid.config.trust_email;
    super::sso::require_fresh_for_trust(&state, &admin.id, &headers, info.https, trusting, now).await?;
    verify_check_token(&state, valid.check_token.as_deref(), &valid.config, &password, now)?;
    let id = super::new_id();
    let taken = || conflict("another provider has this slug").with_field("slug").because("sso.slug_taken");
    let mut tx = crate::db::begin(&state.db).await?;
    if store::by_slug(&mut *tx, &valid.slug).await?.is_some() {
        return Err(taken());
    }
    let (position,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(position) + 1, 0) FROM sso_providers").fetch_one(&mut *tx).await?;
    let config = serde_json::to_string(&valid.config).map_err(|e| ApiError::internal("sso", e))?;
    let inserted = sqlx::query(
        "INSERT INTO sso_providers (id, slug, kind, name, position, enabled, config, create_accounts, \
         trust_provider_mfa, checked_at, version, created_at, updated_at) \
         VALUES ($1, $2, 'ldap', $3, $4, 1, $5, $6, 0, $7, 1, $8, $9)",
    )
    .bind(&id)
    .bind(&valid.slug)
    .bind(&valid.name)
    .bind(position)
    .bind(&config)
    .bind(i64::from(valid.create_accounts))
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await;
    if let Err(e) = inserted {
        return Err(if is_unique_violation(&e) { taken() } else { e.into() });
    }
    store::set_secret(&mut tx, &state.secrets, &id, ldap::BIND_PASSWORD, &password).await?;
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "providerId": id, "slug": valid.slug, "kind": "ldap" });
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
    JsonBody(body): JsonBody<LdapBody>,
) -> ApiResult<Json<Value>> {
    let valid = validate(body)?;
    let current = load(&state, &id).await?;
    if valid.slug != current.slug {
        return Err(field_error("slug", "sso.slug_invalid", "the slug of a provider cannot change"));
    }
    if valid.version != Some(current.version) {
        return Err(ApiError::version_conflict(provider_json(&state, &current).await?));
    }
    let old = current.ldap()?;
    let new = &valid.config;
    let now = state.clock.now_ms();
    let trusting = old.trust_email || new.trust_email;
    super::sso::require_fresh_for_trust(&state, &admin.id, &headers, info.https, trusting, now).await?;
    let connection_changed = old.url != new.url
        || old.encryption != new.encryption
        || old.certificate != new.certificate
        || old.ca_pem != new.ca_pem
        || old.bind_dn != new.bind_dn
        || valid.password.is_some();
    if connection_changed {
        let password = form_password(&state, &valid, Some(&id)).await?;
        verify_check_token(&state, valid.check_token.as_deref(), new, &password, now)?;
    }
    let mut fields = Vec::new();
    if valid.name != current.name {
        fields.push("name");
    }
    if &old != new {
        fields.push("ldap");
    }
    if valid.password.is_some() {
        fields.push("bindPassword");
    }
    if valid.create_accounts != (current.create_accounts != 0) {
        fields.push("createAccounts");
    }
    let config = serde_json::to_string(new).map_err(|e| ApiError::internal("sso", e))?;
    let mut tx = crate::db::begin(&state.db).await?;
    let changed = sqlx::query(
        "UPDATE sso_providers SET name = $1, config = $2, create_accounts = $3, \
         checked_at = CASE WHEN $4 = 1 THEN $5 ELSE checked_at END, version = version + 1, updated_at = $6 \
         WHERE id = $7 AND version = $8",
    )
    .bind(&valid.name)
    .bind(&config)
    .bind(i64::from(valid.create_accounts))
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
        let latest = load(&state, &id).await?;
        return Err(ApiError::version_conflict(provider_json(&state, &latest).await?));
    }
    if let Some(password) = &valid.password {
        store::set_secret(&mut tx, &state.secrets, &id, ldap::BIND_PASSWORD, password).await?;
    }
    let actor = Actor { user_id: &admin.id, info: &info, at_ms: now };
    let summary = json!({ "providerId": id, "fields": fields });
    audit(&mut tx, &actor, None, "sso.provider_updated", ("sso_provider", &id), summary).await?;
    crate::db::commit(tx).await?;
    let row = load(&state, &id).await?;
    Ok(Json(provider_json(&state, &row).await?))
}

async fn sync_status(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = load(&state, &id).await?;
    Ok(Json(sync::status_json(&state, &row).await?))
}

async fn sync_now(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let row = load(&state, &id).await?;
    Ok(Json(sync::run(&state, &row, Trigger::Manual).await?))
}

async fn sync_run(State(state): State<AppState>, Path((id, run_id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    load(&state, &id).await?;
    let owner: Option<(String,)> = sqlx::query_as("SELECT provider_id FROM ldap_sync_runs WHERE id = $1")
        .bind(&run_id)
        .fetch_optional(&state.db)
        .await?;
    if owner.is_none_or(|(p,)| p != id) {
        return Err(ApiError::not_found());
    }
    Ok(Json(sync::run_json(&state, &run_id, true).await?))
}

/// "Trotzdem anwenden": a fresh second factor of the admin, then the sync without its threshold,
/// disabling only accounts of the halted run's list.
async fn sync_apply(
    State(state): State<AppState>,
    Extension(admin): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    Path((id, run_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let row = load(&state, &id).await?;
    let now = state.clock.now_ms();
    if !crate::auth::second_factor::methods(&state.db, &admin.id).await?.any() {
        return Err(conflict("applying a halted sync needs a second factor; set one up first")
            .because("ldap.sync_needs_second_factor"));
    }
    let token = session::read_cookie(&headers, info.https).ok_or_else(ApiError::unauthenticated)?;
    crate::auth::second_factor::require_fresh(&state.db, &session::hash_token(&token), now).await?;
    let approved = sync::halted_list(&state, &id, &run_id).await?;
    Ok(Json(sync::run(&state, &row, Trigger::Apply { run_id, approved, by: admin.id.clone() }).await?))
}
