//! Plugins: what server administrators do with them (install from a file, approve permissions,
//! enable, disable, restart, remove, status and logs, trusted publisher keys, hand-overs, the
//! switch for unsigned plugins) and the block list of an organization. Documented in
//! docs/api/plugins.md.

use std::collections::BTreeMap;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, response::IntoResponse};
use futures_util::StreamExt;
use kalzit_plugin_api::manifest::{self, Manifest};
use kalzit_plugin_api::signing;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::plugins::host::Actor;
use crate::plugins::package::{self, MAX_PACKAGE_BYTES};
use crate::plugins::store::{self, HandOverRow, KeyRow, PluginRow};
use crate::plugins::supervisor::{LogLine, Status};

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/plugins", Access::ServerAdmin, list),
        route(Method::POST, "/admin/plugins", Access::ServerAdmin, install),
        route(Method::GET, "/admin/plugins/{pluginId}", Access::ServerAdmin, get_one),
        route(Method::DELETE, "/admin/plugins/{pluginId}", Access::ServerAdmin, remove),
        route(Method::POST, "/admin/plugins/{pluginId}/approve", Access::ServerAdmin, approve),
        route(Method::POST, "/admin/plugins/{pluginId}/enable", Access::ServerAdmin, enable),
        route(Method::POST, "/admin/plugins/{pluginId}/disable", Access::ServerAdmin, disable),
        route(Method::POST, "/admin/plugins/{pluginId}/restart", Access::ServerAdmin, restart),
        route(Method::GET, "/admin/plugins/{pluginId}/logs", Access::ServerAdmin, logs),
        route(Method::POST, "/admin/plugins/{pluginId}/handovers", Access::ServerAdmin, add_handover),
        route(Method::GET, "/admin/plugin-keys", Access::ServerAdmin, list_keys),
        route(Method::POST, "/admin/plugin-keys", Access::ServerAdmin, add_key),
        route(Method::DELETE, "/admin/plugin-keys/{keyId}", Access::ServerAdmin, remove_key),
        route(Method::GET, "/admin/plugin-host", Access::ServerAdmin, host_settings),
        route(Method::PATCH, "/admin/plugin-host", Access::ServerAdmin, patch_host_settings),
        route(Method::GET, "/orgs/{orgId}/plugins", Access::Org(Permission::PluginsConfigure), org_list),
        route(Method::PUT, "/orgs/{orgId}/plugins/{pluginId}/block", Access::Org(Permission::PluginsConfigure), block),
        route(
            Method::DELETE,
            "/orgs/{orgId}/plugins/{pluginId}/block",
            Access::Org(Permission::PluginsConfigure),
            unblock,
        ),
    ]
}

fn actor<'a>(user: &'a SessionUser, info: &RequestInfo, org_id: Option<&'a str>) -> Actor<'a> {
    Actor { user_id: &user.id, address: info.client_ip.to_string(), org_id }
}

/// One network target of a manifest, as the administrator approves it.
type PermissionLine = BTreeMap<&'static str, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingView {
    version: String,
    signer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_id: Option<String>,
    permissions: Vec<PermissionLine>,
    /// The targets the update adds; it runs only after they are approved.
    added_permissions: Vec<PermissionLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginView {
    id: String,
    name: String,
    version: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    license: Option<String>,
    shapes: Vec<String>,
    capabilities: Vec<String>,
    platforms: Vec<String>,
    /// `kalzit`, `publisher` or `unsigned`.
    signer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key_id: Option<String>,
    /// The signing key is still trusted (always for unsigned plugins).
    trusted: bool,
    approved: bool,
    enabled: bool,
    /// Its kind is registered (a panel: it may be shown): approved, enabled, trusted and able to
    /// run here.
    running: bool,
    permissions: Vec<PermissionLine>,
    /// What the administrator should know before approving: `landlock_missing` when this Linux
    /// host offers no Landlock (the plugin then does not start unless `allowWithoutLandlock`),
    /// `landlock_missing_allowed` when it runs without anyway.
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox_warning: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<PendingView>,
    /// The process, while the plugin runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    process: Option<Status>,
    installed_at: i64,
    updated_at: i64,
}

fn key_id_of(hex_key: Option<&str>) -> Option<String> {
    let bytes = <[u8; 32]>::try_from(hex::decode(hex_key?).ok()?).ok()?;
    let key = ed25519_dalek::VerifyingKey::from_bytes(&bytes).ok()?;
    Some(signing::key_id(&key))
}

async fn view(state: &AppState, row: PluginRow) -> ApiResult<PluginView> {
    let m: Manifest = manifest::parse(&row.manifest).map_err(|e| ApiError::internal("plugin manifest", e))?;
    let pending = match &row.pending {
        Some(p) => {
            let update = manifest::parse(&p.manifest).map_err(|e| ApiError::internal("plugin manifest", e))?;
            let added: Manifest = Manifest {
                permissions: kalzit_plugin_api::manifest::Permissions {
                    network: update.added_permissions(&m).into_iter().cloned().collect(),
                },
                ..update.clone()
            };
            Some(PendingView {
                version: p.version.clone(),
                signer: p.signer.clone(),
                key_id: key_id_of(p.public_key.as_deref()),
                permissions: package::permission_lines(&update),
                added_permissions: package::permission_lines(&added),
            })
        }
        None => None,
    };
    let trusted = state.plugins.trust_state(state, &row).await?;
    let sandbox_warning = if cfg!(target_os = "linux") && !crate::plugins::sandbox::landlock_available() {
        if store::switches(&state.db).await?.allow_without_landlock {
            Some("landlock_missing_allowed")
        } else {
            Some("landlock_missing")
        }
    } else {
        None
    };
    let process = state.plugins.status(&row.id);
    // A panel has no process: it runs when it may be shown.
    let running = process.is_some() || state.plugins.panels().get(&row.id).is_some();
    Ok(PluginView {
        id: row.id,
        name: row.name,
        version: row.version,
        kind: row.kind,
        description: m.description.clone(),
        publisher: m.publisher.clone(),
        license: m.license.clone(),
        shapes: m.shapes.clone(),
        capabilities: m.capabilities.clone(),
        platforms: m.binaries.keys().cloned().collect(),
        signer: row.signer,
        key_id: key_id_of(row.public_key.as_deref()),
        trusted,
        approved: row.approved,
        enabled: row.enabled,
        running,
        permissions: package::permission_lines(&m),
        sandbox_warning,
        pending,
        process,
        installed_at: row.installed_at,
        updated_at: row.updated_at,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginList {
    items: Vec<PluginView>,
    allow_unsigned: bool,
    /// Plugins may run on a Linux host without Landlock.
    allow_without_landlock: bool,
    /// This host offers Landlock (always false on Windows).
    landlock_available: bool,
    /// This server's platform as manifests name it (`windows-x64`, `linux-x64`, `linux-arm64`).
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<&'static str>,
}

async fn list(State(state): State<AppState>) -> ApiResult<Json<PluginList>> {
    let switches = store::switches(&state.db).await?;
    let mut items = Vec::new();
    for row in store::all(&state.db).await? {
        items.push(view(&state, row).await?);
    }
    Ok(Json(PluginList {
        items,
        allow_unsigned: switches.allow_unsigned,
        allow_without_landlock: switches.allow_without_landlock,
        landlock_available: crate::plugins::sandbox::landlock_available(),
        platform: crate::plugins::platform(),
    }))
}

#[derive(Deserialize)]
struct PluginPath {
    #[serde(rename = "pluginId")]
    plugin_id: String,
}

async fn one(state: &AppState, id: &str) -> ApiResult<Json<PluginView>> {
    let row = store::get(&state.db, id).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(view(state, row).await?))
}

/// A data source of the plugin's kind, for "Used in" and the question before removing it.
#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct UsedIn {
    id: String,
    name: String,
    org_id: String,
    org_name: String,
}

/// One plugin with what the list leaves out: the manifest as signed and the data sources of its
/// kind in every organization (not in the trash).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginDetail {
    #[serde(flatten)]
    view: PluginView,
    manifest: String,
    used_in: Vec<UsedIn>,
}

async fn get_one(State(state): State<AppState>, Path(path): Path<PluginPath>) -> ApiResult<Json<PluginDetail>> {
    let row = store::get(&state.db, &path.plugin_id).await?.ok_or_else(ApiError::not_found)?;
    let manifest = row.manifest.clone();
    let used_in: Vec<UsedIn> = sqlx::query_as(
        "SELECT d.id, d.name, d.org_id, o.name AS org_name \
         FROM datasources d JOIN orgs o ON o.id = d.org_id \
         WHERE d.kind = $1 AND d.deleted_at IS NULL \
         ORDER BY o.name, d.name, d.id",
    )
    .bind(&row.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(PluginDetail { view: view(&state, row).await?, manifest, used_in }))
}

/// Removes the uploaded file when the request ends, however it ends.
struct Upload(std::path::PathBuf);

impl Drop for Upload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallQuery {
    /// `true`: install a removed plugin's id signed with another key, clearing the stored
    /// secrets of its data sources (the count `plugin.publisher_changed` named).
    confirm_publisher_change: Option<bool>,
}

/// `POST /admin/plugins`: the package (a zip file) is the request body.
async fn install(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Query(query): Query<InstallQuery>,
    body: Body,
) -> ApiResult<impl IntoResponse> {
    let upload = Upload(state.plugins.upload_path().map_err(|e| e.api())?);
    let mut file = tokio::fs::File::create(&upload.0).await.map_err(|e| ApiError::internal("plugin upload", e))?;
    let mut stream = body.into_data_stream();
    let mut size: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| ApiError::validation("the upload broke off").because("plugin.upload_incomplete"))?;
        size += chunk.len() as u64;
        if size > MAX_PACKAGE_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                format!("a plugin package may have at most {} MiB", MAX_PACKAGE_BYTES / (1024 * 1024)),
            ));
        }
        file.write_all(&chunk).await.map_err(|e| ApiError::internal("plugin upload", e))?;
    }
    file.flush().await.map_err(|e| ApiError::internal("plugin upload", e))?;
    drop(file);
    if size == 0 {
        return Err(ApiError::validation("send the plugin package (a zip file) as the request body")
            .because("plugin.package_unreadable"));
    }
    let row = state
        .plugins
        .install(&state, &upload.0, query.confirm_publisher_change.unwrap_or(false), &actor(&user, &info, None))
        .await?;
    let id = row.id.clone();
    Ok((StatusCode::CREATED, one(&state, &id).await?))
}

async fn remove(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<PluginPath>,
) -> ApiResult<StatusCode> {
    state.plugins.remove(&state, &path.plugin_id, &actor(&user, &info, None)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApproveBody {
    /// The version whose permissions are approved: the installed one, or the update that waits.
    version: String,
}

async fn approve(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<PluginPath>,
    JsonBody(body): JsonBody<ApproveBody>,
) -> ApiResult<Json<PluginView>> {
    state.plugins.approve(&state, &path.plugin_id, &body.version, &actor(&user, &info, None)).await?;
    one(&state, &path.plugin_id).await
}

async fn enable(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<PluginPath>,
) -> ApiResult<Json<PluginView>> {
    state.plugins.set_enabled(&state, &path.plugin_id, true, &actor(&user, &info, None)).await?;
    one(&state, &path.plugin_id).await
}

async fn disable(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<PluginPath>,
) -> ApiResult<Json<PluginView>> {
    state.plugins.set_enabled(&state, &path.plugin_id, false, &actor(&user, &info, None)).await?;
    one(&state, &path.plugin_id).await
}

async fn restart(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<PluginPath>,
) -> ApiResult<Json<PluginView>> {
    state.plugins.restart(&state, &path.plugin_id, &actor(&user, &info, None)).await?;
    one(&state, &path.plugin_id).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogsView {
    lines: Vec<LogLine>,
    /// Lines dropped because the plugin wrote more than the host keeps per second.
    dropped: u64,
}

async fn logs(State(state): State<AppState>, Path(path): Path<PluginPath>) -> ApiResult<Json<LogsView>> {
    store::get(&state.db, &path.plugin_id).await?.ok_or_else(ApiError::not_found)?;
    let (lines, dropped) = match state.plugins.supervisor(&path.plugin_id) {
        Some(s) => s.logs().snapshot(),
        None => (Vec::new(), 0),
    };
    Ok(Json(LogsView { lines, dropped }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandOverBody {
    /// The old and the new public key, all 32 bytes in lowercase hex.
    from_key: String,
    to_key: String,
    from_version: String,
    /// The old key's Ed25519 signature over the hand-over statement, in hex.
    signature: String,
}

async fn add_handover(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<PluginPath>,
    JsonBody(body): JsonBody<HandOverBody>,
) -> ApiResult<StatusCode> {
    let h = HandOverRow {
        from_key: body.from_key.trim().to_lowercase(),
        to_key: body.to_key.trim().to_lowercase(),
        from_version: body.from_version.trim().to_string(),
        signature: body.signature.trim().to_lowercase(),
    };
    state.plugins.add_handover(&state, &path.plugin_id, &h, &actor(&user, &info, None)).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyView {
    key_id: String,
    /// The public key in base64, as `kalzit-sign` prints keys.
    public_key: String,
    name: String,
    added_at: i64,
    /// The installed plugins signed with it.
    plugins: Vec<String>,
}

async fn key_view(state: &AppState, k: KeyRow) -> ApiResult<KeyView> {
    let (_, plugins) = state.plugins.signed_with(state, &k.key_id).await?;
    let public_key = hex::decode(&k.public_key)
        .map(|b| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b))
        .unwrap_or_default();
    Ok(KeyView { key_id: k.key_id, public_key, name: k.name, added_at: k.added_at, plugins })
}

#[derive(Serialize)]
struct KeyList {
    items: Vec<KeyView>,
}

async fn list_keys(State(state): State<AppState>) -> ApiResult<Json<KeyList>> {
    let mut items = Vec::new();
    for k in store::keys(&state.db).await? {
        items.push(key_view(&state, k).await?);
    }
    Ok(Json(KeyList { items }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyBody {
    name: String,
    public_key: String,
}

async fn add_key(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<KeyBody>,
) -> ApiResult<impl IntoResponse> {
    let name = super::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let k = state.plugins.add_key(&state, &name, &body.public_key, &actor(&user, &info, None)).await?;
    Ok((StatusCode::CREATED, Json(key_view(&state, k).await?)))
}

#[derive(Deserialize)]
struct KeyPath {
    #[serde(rename = "keyId")]
    key_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmQuery {
    /// `true`: stop the plugins signed with the key (the list `plugin.key_in_use` named).
    confirm: Option<bool>,
}

#[derive(Serialize)]
struct Stopped {
    stopped: Vec<String>,
}

async fn remove_key(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<KeyPath>,
    Query(query): Query<ConfirmQuery>,
) -> ApiResult<Json<Stopped>> {
    let stopped = state
        .plugins
        .remove_key(&state, &path.key_id, query.confirm.unwrap_or(false), &actor(&user, &info, None))
        .await?;
    Ok(Json(Stopped { stopped }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSettings {
    /// Unsigned plugins may be installed (off by default). An invalid signature is refused
    /// either way.
    allow_unsigned: bool,
    /// Plugins may run on a Linux host without Landlock (off by default).
    allow_without_landlock: bool,
    landlock_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostSettingsPatch {
    allow_unsigned: Option<bool>,
    allow_without_landlock: Option<bool>,
}

async fn host_settings(State(state): State<AppState>) -> ApiResult<Json<HostSettings>> {
    let s = store::switches(&state.db).await?;
    Ok(Json(HostSettings {
        allow_unsigned: s.allow_unsigned,
        allow_without_landlock: s.allow_without_landlock,
        landlock_available: crate::plugins::sandbox::landlock_available(),
    }))
}

async fn patch_host_settings(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<HostSettingsPatch>,
) -> ApiResult<Json<HostSettings>> {
    let old = store::switches(&state.db).await?;
    let new = store::HostSwitches {
        allow_unsigned: body.allow_unsigned.unwrap_or(old.allow_unsigned),
        allow_without_landlock: body.allow_without_landlock.unwrap_or(old.allow_without_landlock),
    };
    state.plugins.set_switches(&state, new, &actor(&user, &info, None)).await?;
    host_settings(State(state)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgPluginView {
    id: String,
    name: String,
    version: String,
    kind: String,
    blocked: bool,
}

#[derive(Serialize)]
struct OrgPluginList {
    items: Vec<OrgPluginView>,
}

async fn org_list(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<OrgPluginList>> {
    let items = store::all(&state.db)
        .await?
        .into_iter()
        .map(|p| OrgPluginView {
            blocked: state.datasources.is_blocked(&ctx.org_id, &p.id),
            id: p.id,
            name: p.name,
            version: p.version,
            kind: p.kind,
        })
        .collect();
    Ok(Json(OrgPluginList { items }))
}

#[derive(Deserialize)]
struct OrgPluginPath {
    #[serde(rename = "orgId")]
    _org_id: String,
    #[serde(rename = "pluginId")]
    plugin_id: String,
}

async fn block(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<OrgPluginPath>,
) -> ApiResult<StatusCode> {
    state.plugins.set_blocked(&state, &path.plugin_id, true, &actor(&ctx.user, &info, Some(&ctx.org_id))).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unblock(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<OrgPluginPath>,
) -> ApiResult<StatusCode> {
    state.plugins.set_blocked(&state, &path.plugin_id, false, &actor(&ctx.user, &info, Some(&ctx.org_id))).await?;
    Ok(StatusCode::NO_CONTENT)
}
