//! App plugins in an organization (docs/api/plugins.md, "App plugins"): the apps a member may
//! open, the sandboxed frames of their pages, each app's own storage, and the organization's
//! rules for them (Verwaltung > Apps: block, least role).
//!
//! An app may be used in an organization when it may be shown on the server (approved, enabled,
//! trusted), the organization did not block it and the member's role is at least the role the
//! organization set (default `viewer`; custom roles count as `viewer`). Everything else answers
//! `404 not_found` with `plugin.app_unavailable`, so a member cannot tell a blocked app from a
//! missing one. Pages never reach Kalzit themselves; reading dashboards and saved analyses and
//! running saved analyses go through Kalzit's own page with the member's session and the routes
//! they always use, for the capabilities the manifest names.

use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::plugins::apps::{self, ActiveApp};

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/apps", Access::OrgMember, list),
        route(Method::GET, "/orgs/{orgId}/apps/{pluginId}/pages/{pageId}/frame", Access::OrgMember, frame),
        route(Method::GET, "/orgs/{orgId}/apps/{pluginId}/storage", Access::OrgMember, storage_list),
        route(Method::GET, "/orgs/{orgId}/apps/{pluginId}/storage/{key}", Access::OrgMember, storage_get),
        route(Method::PUT, "/orgs/{orgId}/apps/{pluginId}/storage/{key}", Access::OrgMember, storage_put)
            .body_limit(apps::MAX_VALUE_BYTES + 1024),
        route(Method::DELETE, "/orgs/{orgId}/apps/{pluginId}/storage/{key}", Access::OrgMember, storage_delete),
        route(Method::GET, "/orgs/{orgId}/app-settings", Access::Org(Permission::PluginsConfigure), settings_list),
        route(
            Method::PUT,
            "/orgs/{orgId}/app-settings/{pluginId}",
            Access::Org(Permission::PluginsConfigure),
            settings_put,
        )
        .changes_rights(),
    ]
}

fn unavailable() -> ApiError {
    ApiError::not_found().because("plugin.app_unavailable")
}

/// The least role the organization set for the app (`viewer` when none).
async fn min_role(state: &AppState, org_id: &str, plugin_id: &str) -> ApiResult<String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT min_role FROM app_org_settings WHERE org_id = $1 AND plugin_id = $2")
            .bind(org_id)
            .bind(plugin_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map_or_else(|| "viewer".to_string(), |(r,)| r))
}

/// The app `id` when the caller may use it in their organization.
async fn usable(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<ActiveApp> {
    let app = state.plugins.apps().get(id).ok_or_else(unavailable)?;
    if state.datasources.is_blocked(&ctx.org_id, id) {
        return Err(unavailable());
    }
    if apps::rank(&ctx.role) < apps::rank(&min_role(state, &ctx.org_id, id).await?) {
        return Err(unavailable());
    }
    Ok(app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppView {
    id: String,
    name: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    /// The app message API version its pages speak.
    api: u32,
    /// What Kalzit's page does for the app's pages, with the member's rights.
    capabilities: Vec<String>,
    pages: Vec<PageView>,
}

#[derive(Serialize)]
struct PageView {
    id: String,
    title: std::collections::BTreeMap<String, String>,
}

fn app_view(id: String, app: &ActiveApp) -> AppView {
    let m = &app.manifest;
    let a = app.app();
    AppView {
        id,
        name: m.name.clone(),
        version: m.version.clone(),
        description: m.description.clone(),
        publisher: m.publisher.clone(),
        api: a.api,
        capabilities: a.capabilities.clone(),
        pages: a.pages.iter().map(|p| PageView { id: p.id.clone(), title: p.title.clone() }).collect(),
    }
}

/// `GET /orgs/{orgId}/apps`: the apps the caller may open, for the navigation.
async fn list(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<Value>> {
    let mut items = Vec::new();
    for (id, _) in state.plugins.apps().all() {
        if let Ok(app) = usable(&state, &ctx, &id).await {
            items.push(app_view(id, &app));
        }
    }
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
struct PagePath {
    #[serde(rename = "orgId")]
    _org_id: String,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    #[serde(rename = "pageId")]
    page_id: String,
}

/// `GET /orgs/{orgId}/apps/{pluginId}/pages/{pageId}/frame`: the page's frame document, for
/// `<iframe sandbox="allow-scripts">`, with the policy of panel frames (no network at all).
async fn frame(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<PagePath>,
) -> ApiResult<Response> {
    let app = usable(&state, &ctx, &path.plugin_id).await?;
    let built = tokio::task::spawn_blocking({
        let (id, page) = (path.plugin_id.clone(), path.page_id.clone());
        move || apps::frame(&id, &app, &page)
    })
    .await
    .map_err(|e| ApiError::internal("app frame", e))?
    .map_err(|e| e.api())?;
    let frame = built.ok_or_else(ApiError::not_found)?;
    let csp = HeaderValue::from_str(&frame.csp).map_err(|e| ApiError::internal("app frame", e))?;
    let mut res = (StatusCode::OK, frame.html).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CONTENT_SECURITY_POLICY, csp);
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    Ok(res)
}

#[derive(Deserialize)]
struct AppPath {
    #[serde(rename = "orgId")]
    _org_id: String,
    #[serde(rename = "pluginId")]
    plugin_id: String,
}

#[derive(Deserialize)]
struct KeyPath {
    #[serde(rename = "orgId")]
    _org_id: String,
    #[serde(rename = "pluginId")]
    plugin_id: String,
    key: String,
}

/// The app when the caller may use it and it may keep data (`storage`).
async fn with_storage(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<ActiveApp> {
    let app = usable(state, ctx, id).await?;
    if !app.can("storage") {
        return Err(ApiError::forbidden("the app has no storage")
            .because("plugin.app_capability_missing")
            .param("capability", "storage"));
    }
    Ok(app)
}

/// A storage key: 1 to 200 letters, digits, `.`, `_`, `-`, `:` or `/`.
fn check_key(key: &str) -> ApiResult<()> {
    let ok = !key.is_empty()
        && key.len() <= 200
        && key.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' | b'/'));
    if ok {
        Ok(())
    } else {
        Err(ApiError::validation("a key has 1 to 200 letters, digits, . _ - : or /")
            .with_field("key")
            .because("plugin.app_storage_key"))
    }
}

/// Serializes the writes of one app's storage in one organization until the transaction ends, so
/// two writes cannot both pass the quota check. SQLite transactions are serialized already
/// (`db::begin`); PostgreSQL takes an advisory lock on the pair.
async fn lock_storage(conn: &mut sqlx::AnyConnection, org_id: &str, plugin_id: &str) -> ApiResult<()> {
    if conn.backend_name() == "SQLite" {
        return Ok(());
    }
    // FNV-1a over both ids, apart from the address locks of `routes::lock_email` by a prefix.
    let hash = format!("app-storage\u{0}{org_id}\u{0}{plugin_id}")
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    let key = i64::from_ne_bytes(hash.to_ne_bytes());
    // `pg_advisory_xact_lock` returns void, which the `Any` driver cannot read; counting the row works.
    sqlx::query("SELECT COUNT(*) FROM (SELECT pg_advisory_xact_lock($1)) AS locked").bind(key).execute(conn).await?;
    Ok(())
}

async fn used_bytes(conn: &mut sqlx::AnyConnection, org_id: &str, plugin_id: &str) -> ApiResult<i64> {
    let (used,): (i64,) = sqlx::query_as(
        "SELECT CAST(COALESCE(SUM(size_bytes), 0) AS BIGINT) FROM app_storage WHERE org_id = $1 AND plugin_id = $2",
    )
    .bind(org_id)
    .bind(plugin_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(used)
}

/// `GET /orgs/{orgId}/apps/{pluginId}/storage`: the keys, the bytes used and the limit.
async fn storage_list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<AppPath>,
) -> ApiResult<Json<Value>> {
    with_storage(&state, &ctx, &path.plugin_id).await?;
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT key, size_bytes, updated_at FROM app_storage WHERE org_id = $1 AND plugin_id = $2 ORDER BY key",
    )
    .bind(&ctx.org_id)
    .bind(&path.plugin_id)
    .fetch_all(&state.db)
    .await?;
    let used: i64 = rows.iter().map(|r| r.1).sum();
    let items: Vec<Value> =
        rows.into_iter().map(|(key, size, at)| json!({ "key": key, "sizeBytes": size, "updatedAt": at })).collect();
    Ok(Json(json!({ "items": items, "usedBytes": used, "limitBytes": apps::STORAGE_BYTES })))
}

/// `GET /orgs/{orgId}/apps/{pluginId}/storage/{key}`: `{key, value, updatedAt}`.
async fn storage_get(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<KeyPath>,
) -> ApiResult<Json<Value>> {
    with_storage(&state, &ctx, &path.plugin_id).await?;
    check_key(&path.key)?;
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT value, updated_at FROM app_storage WHERE org_id = $1 AND plugin_id = $2 AND key = $3")
            .bind(&ctx.org_id)
            .bind(&path.plugin_id)
            .bind(&path.key)
            .fetch_optional(&state.db)
            .await?;
    let (value, at) = row.ok_or_else(ApiError::not_found)?;
    let value: Value = serde_json::from_str(&value).map_err(|e| ApiError::internal("app storage", e))?;
    Ok(Json(json!({ "key": path.key, "value": value, "updatedAt": at })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutBody {
    value: Value,
}

/// `PUT /orgs/{orgId}/apps/{pluginId}/storage/{key}`: `{value}` (any JSON up to 1 MiB); the app
/// keeps at most 50 MiB per organization, keys and values together.
async fn storage_put(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<KeyPath>,
    JsonBody(body): JsonBody<PutBody>,
) -> ApiResult<StatusCode> {
    with_storage(&state, &ctx, &path.plugin_id).await?;
    check_key(&path.key)?;
    let text = body.value.to_string();
    if text.len() > apps::MAX_VALUE_BYTES {
        return Err(ApiError::validation("the value is larger than 1 MiB")
            .with_field("value")
            .because("plugin.app_storage_value")
            .param("maxBytes", apps::MAX_VALUE_BYTES));
    }
    let size = (text.len() + path.key.len()) as i64;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_storage(&mut tx, &ctx.org_id, &path.plugin_id).await?;
    let (old,): (i64,) = sqlx::query_as(
        "SELECT CAST(COALESCE(SUM(size_bytes), 0) AS BIGINT) FROM app_storage \
         WHERE org_id = $1 AND plugin_id = $2 AND key = $3",
    )
    .bind(&ctx.org_id)
    .bind(&path.plugin_id)
    .bind(&path.key)
    .fetch_one(&mut *tx)
    .await?;
    if used_bytes(&mut tx, &ctx.org_id, &path.plugin_id).await? - old + size > apps::STORAGE_BYTES {
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "the app's storage in this organization is full")
            .because("plugin.app_storage_full")
            .param("limitBytes", apps::STORAGE_BYTES));
    }
    sqlx::query(
        "INSERT INTO app_storage (org_id, plugin_id, key, value, size_bytes, updated_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (org_id, plugin_id, key) DO UPDATE SET \
         value = excluded.value, size_bytes = excluded.size_bytes, updated_by = excluded.updated_by, \
         updated_at = excluded.updated_at",
    )
    .bind(&ctx.org_id)
    .bind(&path.plugin_id)
    .bind(&path.key)
    .bind(&text)
    .bind(size)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn storage_delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<KeyPath>,
) -> ApiResult<StatusCode> {
    with_storage(&state, &ctx, &path.plugin_id).await?;
    check_key(&path.key)?;
    let n = sqlx::query("DELETE FROM app_storage WHERE org_id = $1 AND plugin_id = $2 AND key = $3")
        .bind(&ctx.org_id)
        .bind(&path.plugin_id)
        .bind(&path.key)
        .execute(&state.db)
        .await?
        .rows_affected();
    if n == 0 { Err(ApiError::not_found()) } else { Ok(StatusCode::NO_CONTENT) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppSettingsView {
    id: String,
    name: String,
    blocked: bool,
    /// The least role that may use the app here.
    min_role: String,
    capabilities: Vec<String>,
    /// Bytes the app keeps in this organization.
    used_bytes: i64,
}

async fn settings_view(state: &AppState, org_id: &str, id: &str, app: &ActiveApp) -> ApiResult<AppSettingsView> {
    let mut conn = state.db.acquire().await?;
    Ok(AppSettingsView {
        id: id.to_string(),
        name: app.manifest.name.clone(),
        blocked: state.datasources.is_blocked(org_id, id),
        min_role: min_role(state, org_id, id).await?,
        capabilities: app.app().capabilities.clone(),
        used_bytes: used_bytes(&mut conn, org_id, id).await?,
    })
}

/// `GET /orgs/{orgId}/app-settings`: every app the server offers, with the organization's rules.
async fn settings_list(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<Value>> {
    let mut items = Vec::new();
    for (id, app) in state.plugins.apps().all() {
        items.push(settings_view(&state, &ctx.org_id, &id, &app).await?);
    }
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsBody {
    /// `viewer`, `editor`, `admin` or `owner`.
    #[serde(default)]
    min_role: Option<String>,
    /// Blocks or allows the app in this organization (the plugin block,
    /// `PUT|DELETE /orgs/{orgId}/plugins/{pluginId}/block`).
    #[serde(default)]
    blocked: Option<bool>,
}

/// `PUT /orgs/{orgId}/app-settings/{pluginId}`: `{minRole?, blocked?}`, applied at once.
async fn settings_put(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<AppPath>,
    JsonBody(body): JsonBody<SettingsBody>,
) -> ApiResult<Json<AppSettingsView>> {
    let app = state.plugins.apps().get(&path.plugin_id).ok_or_else(unavailable)?;
    if let Some(role) = &body.min_role {
        if !apps::ROLES.contains(&role.as_str()) {
            return Err(ApiError::validation("minRole is viewer, editor, admin or owner")
                .with_field("minRole")
                .because("plugin.app_role_invalid"));
        }
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        sqlx::query("DELETE FROM app_org_settings WHERE org_id = $1 AND plugin_id = $2")
            .bind(&ctx.org_id)
            .bind(&path.plugin_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO app_org_settings (org_id, plugin_id, min_role, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(&ctx.org_id)
        .bind(&path.plugin_id)
        .bind(role)
        .bind(&ctx.user.id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        let event = crate::audit::AuditEvent {
            org_id: Some(&ctx.org_id),
            actor_user_id: Some(&ctx.user.id),
            actor_address: Some(info.client_ip.to_string()),
            action: "plugins.app_role_changed",
            resource_type: Some("plugin"),
            resource_id: Some(&path.plugin_id),
            summary: json!({ "minRole": role }),
            at_ms: now,
        };
        crate::audit::record(&mut tx, &event).await?;
        crate::db::commit(tx).await?;
    }
    if let Some(blocked) = body.blocked {
        let actor = crate::plugins::host::Actor {
            user_id: &ctx.user.id,
            address: info.client_ip.to_string(),
            org_id: Some(&ctx.org_id),
        };
        state.plugins.set_blocked(&state, &path.plugin_id, blocked, &actor).await?;
    }
    Ok(Json(settings_view(&state, &ctx.org_id, &path.plugin_id, &app).await?))
}
