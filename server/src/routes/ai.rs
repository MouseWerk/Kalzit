//! AI configuration and status (docs/api/ai.md): whether AI is usable for the signed-in user,
//! the server's providers (server administrators) and an organization's own (`settings:write`),
//! a connection test with a tiny prompt, usage counters, and the per data source opt-in. Keys are
//! write-only: answers say only whether one is set.

use std::time::Instant;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use super::clean_name;
use super::support::QueryParams;
use super::table::{RouteDef, route};
use crate::ai::service::{self, AiStatus};
use crate::ai::store::{self, ProviderRow};
use crate::ai::{ChatRequest, Message, ProviderKind, TokenLimitField};
use crate::app::AppState;
use crate::audit::{AuditEvent, record};
use crate::auth::SessionUser;
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/ai/status", Access::OrgMember, status),
        route(Method::GET, "/admin/ai/providers", Access::ServerAdmin, list_server),
        route(Method::POST, "/admin/ai/providers", Access::ServerAdmin, create_server),
        route(Method::PATCH, "/admin/ai/providers/{providerId}", Access::ServerAdmin, update_server),
        route(Method::DELETE, "/admin/ai/providers/{providerId}", Access::ServerAdmin, delete_server),
        route(Method::POST, "/admin/ai/providers/{providerId}/test", Access::ServerAdmin, test_server),
        route(Method::GET, "/admin/ai/usage", Access::ServerAdmin, usage_server),
        route(Method::GET, "/orgs/{orgId}/ai/providers", Access::Org(Permission::SettingsRead), list_org),
        route(Method::POST, "/orgs/{orgId}/ai/providers", Access::Org(Permission::SettingsWrite), create_org),
        route(
            Method::PATCH,
            "/orgs/{orgId}/ai/providers/{providerId}",
            Access::Org(Permission::SettingsWrite),
            update_org,
        ),
        route(
            Method::DELETE,
            "/orgs/{orgId}/ai/providers/{providerId}",
            Access::Org(Permission::SettingsWrite),
            delete_org,
        ),
        route(
            Method::POST,
            "/orgs/{orgId}/ai/providers/{providerId}/test",
            Access::Org(Permission::SettingsWrite),
            test_org,
        ),
        route(Method::GET, "/orgs/{orgId}/ai/usage", Access::Org(Permission::SettingsRead), usage_org),
        route(Method::GET, "/orgs/{orgId}/ai/datasources", Access::OrgMember, readable_datasources),
        // Rights on one data source may come from a grant, so the handler checks the source.
        route(Method::PUT, "/orgs/{orgId}/datasources/{datasourceId}/ai-access", Access::OrgMember, set_datasource),
        route(Method::GET, "/orgs/{orgId}/datasources/{datasourceId}/ai-access", Access::OrgMember, get_datasource),
        route(Method::POST, "/orgs/{orgId}/ai/notice", Access::OrgMember, acknowledge_notice),
    ]
}

async fn status(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<AiStatus>> {
    Ok(Json(service::status(&state, &ctx.org_id, &ctx.user.id).await?))
}

/// Who changes a scope's providers: the scope (`None`: server-wide), the user and their address.
struct Actor<'a> {
    org_id: Option<&'a str>,
    user: &'a SessionUser,
    info: &'a RequestInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    id: String,
    /// `server` or `org`.
    scope: &'static str,
    name: String,
    kind: String,
    base_url: String,
    model: String,
    is_default: bool,
    /// `auto`, `max_tokens` or `max_completion_tokens` (OpenAI-compatible providers).
    token_limit_field: &'static str,
    /// Whether a key is stored; the key itself is never sent.
    api_key_set: bool,
    created_at: i64,
    updated_at: i64,
    /// The last connection test, if one ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_test: Option<LastTest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastTest {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    at: i64,
}

async fn view<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E, row: ProviderRow) -> ApiResult<ProviderView> {
    let api_key_set = store::key_set(db, &row.id).await?;
    let last_test = match (row.last_test_ok, row.last_tested_at) {
        (Some(ok), Some(at)) => Some(LastTest { ok: ok != 0, reason: row.last_test_reason, at }),
        _ => None,
    };
    Ok(ProviderView {
        scope: if row.org_id.is_some() { "org" } else { "server" },
        api_key_set,
        last_test,
        token_limit_field: row
            .token_limit_field
            .as_deref()
            .and_then(TokenLimitField::parse)
            .unwrap_or_default()
            .as_str(),
        id: row.id,
        name: row.name,
        kind: row.kind,
        base_url: row.base_url,
        model: row.model,
        is_default: row.is_default != 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn list(state: &AppState, org_id: Option<&str>) -> ApiResult<Json<Page<ProviderView>>> {
    let mut items = Vec::new();
    for row in store::list(&state.db, org_id).await? {
        items.push(view(&state.db, row).await?);
    }
    Ok(Json(Page { items, next_cursor: None }))
}

async fn list_server(State(state): State<AppState>) -> ApiResult<Json<Page<ProviderView>>> {
    list(&state, None).await
}

async fn list_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<Page<ProviderView>>> {
    list(&state, Some(&ctx.org_id)).await
}

/// `apiKey`: absent = keep, `null` = remove, text = set.
fn patch_value<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<Zeroizing<String>>>, D::Error> {
    Option::<Zeroizing<String>>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    name: String,
    kind: String,
    base_url: String,
    model: String,
    api_key: Option<Zeroizing<String>>,
    #[serde(default)]
    is_default: bool,
    token_limit_field: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchBody {
    name: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    #[serde(default, deserialize_with = "patch_value")]
    api_key: Option<Option<Zeroizing<String>>>,
    is_default: Option<bool>,
    token_limit_field: Option<String>,
    /// The `updatedAt` the client last read; a newer stored provider answers `version_conflict`.
    expected_updated_at: i64,
}

const MAX_URL_CHARS: usize = 2048;
const MAX_MODEL_CHARS: usize = 200;
const MAX_KEY_CHARS: usize = 4096;

fn kind_of(raw: &str) -> ApiResult<ProviderKind> {
    ProviderKind::parse(raw).ok_or_else(|| {
        ApiError::validation(format!("{raw} is not an AI provider kind (openai, anthropic)"))
            .with_field("kind")
            .because("ai.kind_unknown")
            .param("kind", raw)
    })
}

fn check_model(raw: &str) -> ApiResult<String> {
    let model = raw.trim();
    if model.is_empty() || model.chars().count() > MAX_MODEL_CHARS || model.chars().any(char::is_control) {
        return Err(ApiError::validation(format!("model needs 1 to {MAX_MODEL_CHARS} characters"))
            .with_field("model")
            .because("ai.model_invalid")
            .param("max", MAX_MODEL_CHARS));
    }
    Ok(model.to_string())
}

fn check_key(key: &str) -> ApiResult<()> {
    let ok = !key.trim().is_empty() && key.chars().count() <= MAX_KEY_CHARS && !key.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err(ApiError::validation(format!("apiKey needs 1 to {MAX_KEY_CHARS} characters without control characters"))
            .with_field("apiKey")
            .because("ai.key_invalid")
            .param("max", MAX_KEY_CHARS))
    }
}

fn key_required(kind: ProviderKind) -> ApiError {
    ApiError::validation(format!("{} providers need an API key", kind.as_str()))
        .with_field("apiKey")
        .because("ai.key_required")
        .param("kind", kind.as_str())
}

fn bad_url(message: impl Into<String>) -> ApiError {
    ApiError::validation(message).with_field("baseUrl").because("ai.base_url_invalid")
}

fn target_blocked(detail: crate::datasources::Detail) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked", detail.message)
        .with_field("baseUrl")
        .with_reason(detail.reason, detail.params)
}

/// Whether `url` points at this Kalzit itself: its public address, or a loopback or listening
/// address on one of its ports.
fn is_kalzit_itself(state: &AppState, url: &url::Url) -> bool {
    let config = &state.config;
    if let Some(public) = config.server.public_url.as_deref().and_then(|p| url::Url::parse(p).ok())
        && public.origin() == url.origin()
    {
        return true;
    }
    let Some(port) = url.port_or_known_default() else { return false };
    let listeners: Vec<std::net::SocketAddr> =
        [config.http_addr(), config.https_addr()].into_iter().flatten().collect();
    if !listeners.iter().any(|l| l.port() == port) {
        return false;
    }
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => {
            // `[::ffff:127.0.0.1]` is 127.0.0.1.
            let ip = ip.to_canonical();
            ip.is_loopback() || ip.is_unspecified() || listeners.iter().any(|l| l.ip().to_canonical() == ip)
        }
        Err(_) => false,
    }
}

/// A base URL providers may be configured with: http or https, no credentials, query or
/// fragment, not Kalzit itself, and allowed by the data source target policy (checked again on
/// every connection).
async fn check_base_url(state: &AppState, raw: &str) -> ApiResult<url::Url> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > MAX_URL_CHARS {
        return Err(bad_url(format!("baseUrl needs 1 to {MAX_URL_CHARS} characters")));
    }
    let url = url::Url::parse(raw).map_err(|e| bad_url(format!("baseUrl is not a URL: {e}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(bad_url("baseUrl must start with http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad_url("baseUrl must not contain credentials; use apiKey"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad_url("baseUrl must not have a query or fragment"));
    }
    let Some(host) = url.host_str() else { return Err(bad_url("baseUrl has no host")) };
    if is_kalzit_itself(state, &url) {
        return Err(target_blocked(crate::datasources::Detail::new(
            "ai.base_url_kalzit",
            "baseUrl points at this Kalzit server",
        )));
    }
    let policy = state.datasources.policy(state).await?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    policy.precheck_host(host).map_err(|b| target_blocked(b.0))?;
    Ok(url)
}

fn event<'a>(actor: &'a Actor<'a>, action: &'a str, id: &'a str, summary: Value, now: i64) -> AuditEvent<'a> {
    AuditEvent {
        org_id: actor.org_id,
        actor_user_id: Some(&actor.user.id),
        actor_address: Some(actor.info.client_ip.to_string()),
        action,
        resource_type: Some("ai_provider"),
        resource_id: Some(id),
        summary,
        at_ms: now,
    }
}

/// Makes `id` the default of its scope, or, when the scope has no default, the first provider.
async fn settle_default(
    conn: &mut sqlx::AnyConnection,
    org_id: Option<&str>,
    make_default: Option<&str>,
) -> Result<(), sqlx::Error> {
    let rows = store::list(&mut *conn, org_id).await?;
    let target = match make_default {
        Some(id) => Some(id.to_string()),
        None if rows.iter().any(|r| r.is_default != 0) => None,
        None => rows.iter().min_by_key(|r| (r.created_at, r.id.clone())).map(|r| r.id.clone()),
    };
    if let Some(target) = target {
        for row in rows {
            let want = i64::from(row.id == target);
            if row.is_default != want {
                sqlx::query("UPDATE ai_providers SET is_default = $1 WHERE id = $2")
                    .bind(want)
                    .bind(&row.id)
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    Ok(())
}

/// An organization's own providers may be created, changed and tested only while the server
/// allows them (`ai.allow_org_providers`); they can always be deleted.
async fn org_providers_allowed(state: &AppState, actor: &Actor<'_>) -> ApiResult<()> {
    if actor.org_id.is_some() && !service::org_providers_allowed(state).await? {
        return Err(ApiError::forbidden("the server does not allow organizations their own AI provider")
            .because("ai.org_providers_not_allowed"));
    }
    Ok(())
}

/// `tokenLimitField`: `auto` (stored as nothing), `max_tokens` or `max_completion_tokens`.
fn token_field(raw: &str) -> ApiResult<Option<&'static str>> {
    match TokenLimitField::parse(raw) {
        Some(TokenLimitField::Auto) => Ok(None),
        Some(field) => Ok(Some(field.as_str())),
        None => {
            Err(ApiError::validation(format!("tokenLimitField must be one of {}", TokenLimitField::NAMES.join(", ")))
                .with_field("tokenLimitField")
                .because("ai.token_limit_field_unknown"))
        }
    }
}

async fn create(state: &AppState, actor: Actor<'_>, body: CreateBody) -> ApiResult<(StatusCode, Json<ProviderView>)> {
    org_providers_allowed(state, &actor).await?;
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let kind = kind_of(&body.kind)?;
    let token_field = body.token_limit_field.as_deref().map(token_field).transpose()?.flatten();
    let model = check_model(&body.model)?;
    let url = check_base_url(state, &body.base_url).await?;
    match body.api_key.as_deref() {
        Some(key) => check_key(key)?,
        None if kind.key_required() => return Err(key_required(kind)),
        None => {}
    }
    let id = super::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO ai_providers (id, org_id, name, kind, base_url, model, is_default, created_at, updated_at, \
         updated_by, token_limit_field) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7, $8, $9)",
    )
    .bind(&id)
    .bind(actor.org_id)
    .bind(&name)
    .bind(kind.as_str())
    .bind(url.as_str())
    .bind(&model)
    .bind(now)
    .bind(&actor.user.id)
    .bind(token_field)
    .execute(&mut *tx)
    .await?;
    if let Some(key) = body.api_key.as_deref() {
        store::set_key(&mut tx, &state.secrets, &id, Some(key)).await?;
    }
    settle_default(&mut tx, actor.org_id, body.is_default.then_some(id.as_str())).await?;
    let summary = json!({ "kind": kind.as_str(), "model": model, "apiKeySet": body.api_key.is_some() });
    record(&mut tx, &event(&actor, "ai.provider_created", &id, summary, now)).await?;
    let row = store::find(&mut *tx, actor.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut *tx, row).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(answer)))
}

async fn found(state: &AppState, org_id: Option<&str>, id: &str) -> ApiResult<ProviderRow> {
    store::find(&state.db, org_id, id).await?.ok_or_else(ApiError::not_found)
}

async fn update(state: &AppState, actor: Actor<'_>, id: &str, body: PatchBody) -> ApiResult<Json<ProviderView>> {
    org_providers_allowed(state, &actor).await?;
    let row = found(state, actor.org_id, id).await?;
    if body.expected_updated_at != row.updated_at {
        return Err(ApiError::version_conflict(json!(view(&state.db, row).await?)));
    }
    let kind = kind_of(&row.kind)?;
    let mut changed: Vec<&str> = Vec::new();
    let name = match &body.name {
        Some(raw) => clean_name(raw, "name").map_err(|e| e.with_field("name"))?,
        None => row.name.clone(),
    };
    if name != row.name {
        changed.push("name");
    }
    let model = match &body.model {
        Some(raw) => check_model(raw)?,
        None => row.model.clone(),
    };
    if model != row.model {
        changed.push("model");
    }
    let base_url = match &body.base_url {
        Some(raw) => check_base_url(state, raw).await?.to_string(),
        None => row.base_url.clone(),
    };
    let had_key = store::key_set(&state.db, id).await?;
    if base_url != row.base_url {
        changed.push("baseUrl");
        // The key stored for the old address is not sent to a new one unless it is sent again.
        if had_key && body.api_key.is_none() {
            return Err(ApiError::validation("apiKey must be sent again (or removed) when baseUrl changes")
                .with_field("apiKey")
                .because("ai.key_resend_on_target_change"));
        }
    }
    match &body.api_key {
        Some(Some(key)) => {
            check_key(key)?;
            changed.push("apiKey");
        }
        Some(None) if kind.key_required() => return Err(key_required(kind)),
        Some(None) if had_key => changed.push("apiKey"),
        Some(None) | None => {}
    }
    let token_limit_field = match &body.token_limit_field {
        Some(raw) => token_field(raw)?.map(str::to_string),
        None => row.token_limit_field.clone(),
    };
    if token_limit_field != row.token_limit_field {
        changed.push("tokenLimitField");
    }
    let make_default = body.is_default == Some(true) && row.is_default == 0;
    if make_default {
        changed.push("isDefault");
    }
    if changed.is_empty() {
        return Ok(Json(view(&state.db, row).await?));
    }
    let now = state.clock.now_ms().max(row.updated_at + 1);
    let mut tx = crate::db::begin(&state.db).await?;
    let updated = sqlx::query(
        "UPDATE ai_providers SET name = $1, model = $2, base_url = $3, updated_at = $4, updated_by = $5, \
         token_limit_field = $6 WHERE id = $7 AND updated_at = $8",
    )
    .bind(&name)
    .bind(&model)
    .bind(&base_url)
    .bind(now)
    .bind(&actor.user.id)
    .bind(token_limit_field.as_deref())
    .bind(id)
    .bind(row.updated_at)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        tx.rollback().await?;
        return Err(ApiError::version_conflict(json!(view(&state.db, found(state, actor.org_id, id).await?).await?)));
    }
    if let Some(key) = &body.api_key {
        store::set_key(&mut tx, &state.secrets, id, key.as_deref().map(String::as_str)).await?;
    }
    // A pass belongs to the address, model, key and request form it was made with.
    if changed.iter().any(|c| matches!(*c, "baseUrl" | "model" | "apiKey" | "tokenLimitField")) {
        store::clear_test(&mut tx, id).await?;
    }
    // The notice named the old destination: everyone is asked again.
    if changed.contains(&"baseUrl") {
        store::forget_notices(&mut tx, id).await?;
    }
    if make_default {
        settle_default(&mut tx, actor.org_id, Some(id)).await?;
    }
    record(&mut tx, &event(&actor, "ai.provider_updated", id, json!({ "changed": changed }), now)).await?;
    let saved = store::find(&mut *tx, actor.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut *tx, saved).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
}

async fn delete(state: &AppState, actor: Actor<'_>, id: &str) -> ApiResult<StatusCode> {
    let row = found(state, actor.org_id, id).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("DELETE FROM ai_providers WHERE id = $1").bind(&row.id).execute(&mut *tx).await?;
    settle_default(&mut tx, actor.org_id, None).await?;
    let summary = json!({ "kind": row.kind, "model": row.model });
    record(&mut tx, &event(&actor, "ai.provider_deleted", id, summary, now)).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The test of a stored provider.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestAnswer {
    ok: bool,
    latency_ms: u64,
    /// The start of the provider's reply, when it answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<crate::ai::Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// The prompt of a connection test: tiny, so a test costs next to nothing.
pub const TEST_PROMPT: &str = "Reply with the single word OK.";
/// Room for reasoning models, which spend tokens before they answer; still cheap.
const TEST_MAX_TOKENS: u32 = 512;
const REPLY_CHARS: usize = 200;

/// Sends a tiny prompt to the provider. Works while AI is off, so a provider can be checked
/// before it is turned on; not counted against the limits, but audited.
async fn test(state: &AppState, actor: Actor<'_>, id: &str) -> ApiResult<Json<TestAnswer>> {
    org_providers_allowed(state, &actor).await?;
    let row = found(state, actor.org_id, id).await?;
    let user_key = format!("ai-test:user:{}", actor.user.id);
    if let Err(wait) = state.probe_limiter.try_acquire(&user_key, &user_key, state.clock.monotonic_ms()) {
        return Err(ApiError::rate_limited("too many provider tests; wait a minute", wait)
            .because("ai.test_rate_limited")
            .param("max", super::datasources::PROBE_MAX));
    }
    let provider = service::build(state, &row).await?;
    let request = ChatRequest {
        messages: vec![Message::user(TEST_PROMPT)],
        max_tokens: Some(TEST_MAX_TOKENS),
        ..Default::default()
    };
    let started = Instant::now();
    let result = crate::ai::complete(provider.as_ref(), &request, &CancellationToken::new()).await;
    let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let answer = match &result {
        Ok(r) => TestAnswer {
            ok: true,
            latency_ms,
            reply: Some(r.text.chars().take(REPLY_CHARS).collect()),
            usage: Some(r.usage),
            reason: None,
            params: None,
            message: None,
        },
        Err(e) => {
            let d = e.detail();
            TestAnswer {
                ok: false,
                latency_ms,
                reply: None,
                usage: None,
                reason: Some(d.reason),
                params: (!d.params.is_empty()).then_some(d.params),
                message: Some(d.message),
            }
        }
    };
    let now = state.clock.now_ms();
    let mut summary = json!({ "ok": answer.ok, "kind": row.kind, "model": row.model });
    if let Some(reason) = answer.reason {
        summary["reason"] = json!(reason);
    }
    if let Some(usage) = answer.usage {
        summary["inputTokens"] = json!(usage.input_tokens);
        summary["outputTokens"] = json!(usage.output_tokens);
    }
    let mut tx = crate::db::begin(&state.db).await?;
    store::record_test(&mut tx, id, answer.ok, answer.reason, now).await?;
    record(&mut tx, &event(&actor, "ai.provider_tested", id, summary, now)).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderPath {
    provider_id: String,
}

async fn create_server(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateBody>,
) -> ApiResult<(StatusCode, Json<ProviderView>)> {
    create(&state, Actor { org_id: None, user: &user, info: &info }, body).await
}

async fn create_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateBody>,
) -> ApiResult<(StatusCode, Json<ProviderView>)> {
    create(&state, Actor { org_id: Some(&ctx.org_id), user: &ctx.user, info: &info }, body).await
}

async fn update_server(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<ProviderPath>,
    JsonBody(body): JsonBody<PatchBody>,
) -> ApiResult<Json<ProviderView>> {
    update(&state, Actor { org_id: None, user: &user, info: &info }, &path.provider_id, body).await
}

async fn update_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, path)): Path<(String, String)>,
    JsonBody(body): JsonBody<PatchBody>,
) -> ApiResult<Json<ProviderView>> {
    update(&state, Actor { org_id: Some(&ctx.org_id), user: &ctx.user, info: &info }, &path, body).await
}

async fn delete_server(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<ProviderPath>,
) -> ApiResult<StatusCode> {
    delete(&state, Actor { org_id: None, user: &user, info: &info }, &path.provider_id).await
}

async fn delete_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, path)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    delete(&state, Actor { org_id: Some(&ctx.org_id), user: &ctx.user, info: &info }, &path).await
}

async fn test_server(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<ProviderPath>,
) -> ApiResult<Json<TestAnswer>> {
    test(&state, Actor { org_id: None, user: &user, info: &info }, &path.provider_id).await
}

async fn test_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, path)): Path<(String, String)>,
) -> ApiResult<Json<TestAnswer>> {
    test(&state, Actor { org_id: Some(&ctx.org_id), user: &ctx.user, info: &info }, &path).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UsageQuery {
    days: Option<u32>,
}

const DEFAULT_USAGE_DAYS: u32 = 7;
const MAX_USAGE_DAYS: u32 = 90;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    day: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    requests: i64,
    input_tokens: i64,
    output_tokens: i64,
}

/// The first day (UTC) of the last `days` days, today included.
fn first_day(state: &AppState, query: &UsageQuery) -> ApiResult<String> {
    let days = query.days.unwrap_or(DEFAULT_USAGE_DAYS);
    if !(1..=MAX_USAGE_DAYS).contains(&days) {
        return Err(ApiError::validation(format!("days must be from 1 to {MAX_USAGE_DAYS}"))
            .with_field("days")
            .because("request.limit")
            .param("max", MAX_USAGE_DAYS));
    }
    let start = state.clock.now_ms() - i64::from(days - 1) * 24 * 60 * 60 * 1000;
    Ok(service::day_of(start))
}

/// Per day and organization, newest day first.
async fn usage_server(
    State(state): State<AppState>,
    QueryParams(query): QueryParams<UsageQuery>,
) -> ApiResult<Json<Page<UsageRow>>> {
    let from = first_day(&state, &query)?;
    let rows: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT day, org_id, CAST(SUM(requests) AS BIGINT), CAST(SUM(input_tokens) AS BIGINT), \
         CAST(SUM(output_tokens) AS BIGINT) FROM ai_usage \
         WHERE day >= $1 GROUP BY day, org_id ORDER BY day DESC, org_id",
    )
    .bind(&from)
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .into_iter()
        .map(|(day, org, requests, input_tokens, output_tokens)| UsageRow {
            day,
            org_id: Some(org),
            user_id: None,
            requests,
            input_tokens,
            output_tokens,
        })
        .collect();
    Ok(Json(Page { items, next_cursor: None }))
}

/// Per day and member of the organization, newest day first.
async fn usage_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(query): QueryParams<UsageQuery>,
) -> ApiResult<Json<Page<UsageRow>>> {
    let from = first_day(&state, &query)?;
    let rows: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT day, user_id, requests, input_tokens, output_tokens FROM ai_usage \
         WHERE org_id = $1 AND day >= $2 ORDER BY day DESC, user_id",
    )
    .bind(&ctx.org_id)
    .bind(&from)
    .fetch_all(&state.db)
    .await?;
    let items = rows
        .into_iter()
        .map(|(day, user, requests, input_tokens, output_tokens)| UsageRow {
            day,
            org_id: None,
            user_id: Some(user),
            requests,
            input_tokens,
            output_tokens,
        })
        .collect();
    Ok(Json(Page { items, next_cursor: None }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadableItem {
    datasource_id: String,
}

/// The data sources AI may read, among those the caller may see.
async fn readable_datasources(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<Page<ReadableItem>>> {
    let mut items = Vec::new();
    for id in store::readable_datasources(&state.db, &ctx.org_id).await? {
        if check_resource(&state.db, &ctx, Permission::DatasourcesRead, Resource::Datasource(&id)).await.is_ok() {
            items.push(ReadableItem { datasource_id: id });
        }
    }
    Ok(Json(Page { items, next_cursor: None }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessBody {
    readable: bool,
    /// Replaces the list when present; absent keeps it.
    excluded_fields: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessAnswer {
    datasource_id: String,
    readable: bool,
    excluded_fields: Vec<String>,
}

/// What AI may read of a data source, for everyone who may read the source.
async fn get_datasource(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, datasource_id)): Path<(String, String)>,
) -> ApiResult<Json<AccessAnswer>> {
    let ds = crate::datasources::find_in_org(&state.db, &ctx.org_id, &datasource_id, false).await?;
    check_resource(&state.db, &ctx, Permission::DatasourcesRead, Resource::Datasource(&ds.id)).await?;
    let access = store::datasource_access(&state.db, &ds.id).await?;
    Ok(Json(AccessAnswer { datasource_id: ds.id, readable: access.readable, excluded_fields: access.excluded_fields }))
}

/// Opens or closes a data source to AI and sets the fields AI never receives. Whoever may edit
/// the source decides (`datasources:write`, org-wide or by a grant on it); every change is
/// audited, as its results would leave the server.
async fn set_datasource(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, datasource_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<AccessBody>,
) -> ApiResult<Json<AccessAnswer>> {
    let ds = crate::datasources::find_in_org(&state.db, &ctx.org_id, &datasource_id, false).await?;
    check_resource(&state.db, &ctx, Permission::DatasourcesWrite, Resource::Datasource(&ds.id)).await?;
    let before = store::datasource_access(&state.db, &ds.id).await?;
    let excluded_fields = match &body.excluded_fields {
        Some(list) => crate::ai::redact::clean_excluded(list)?,
        None => before.excluded_fields.clone(),
    };
    let after = store::DatasourceAccess { readable: body.readable, excluded_fields };
    if after != before {
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        store::set_datasource_access(&mut tx, &ds.id, &after, &ctx.user.id, now).await?;
        // The field names are configuration, not data; the count is enough for the log.
        let summary = json!({ "readable": after.readable, "excludedFields": after.excluded_fields.len() });
        record(
            &mut tx,
            &AuditEvent {
                org_id: Some(&ctx.org_id),
                actor_user_id: Some(&ctx.user.id),
                actor_address: Some(info.client_ip.to_string()),
                action: "datasource.ai_access_changed",
                resource_type: Some("datasource"),
                resource_id: Some(&ds.id),
                summary,
                at_ms: now,
            },
        )
        .await?;
        crate::db::commit(tx).await?;
    }
    Ok(Json(AccessAnswer { datasource_id: ds.id, readable: after.readable, excluded_fields: after.excluded_fields }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoticeBody {
    /// The provider the notice named (`provider.id` of the status).
    provider_id: String,
}

/// The caller read the first-use notice for the provider in effect. Once per person and
/// provider; a new provider asks again.
async fn acknowledge_notice(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<NoticeBody>,
) -> ApiResult<StatusCode> {
    // The provider in effect, or the one chosen for a function (explain, summarize, chat).
    let mut current = service::in_effect(&state, &ctx.org_id).await?.filter(|r| r.id == body.provider_id);
    for function in service::FUNCTIONS {
        if current.is_none() {
            current =
                service::in_effect_for(&state, &ctx.org_id, Some(function)).await?.filter(|r| r.id == body.provider_id);
        }
    }
    let Some(row) = current else {
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "another AI provider is in effect now")
            .with_field("providerId")
            .because("ai.notice_provider_changed"));
    };
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    if store::acknowledge_notice(&mut tx, &ctx.user.id, &row.id, now).await? {
        record(
            &mut tx,
            &AuditEvent {
                org_id: Some(&ctx.org_id),
                actor_user_id: Some(&ctx.user.id),
                actor_address: Some(info.client_ip.to_string()),
                action: "ai.notice_acknowledged",
                resource_type: Some("ai_provider"),
                resource_id: Some(&row.id),
                summary: json!({ "kind": row.kind }),
                at_ms: now,
            },
        )
        .await?;
    }
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}
