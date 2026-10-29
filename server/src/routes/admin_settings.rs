//! Server settings (server administrators) and organization settings (`settings:read|write`).
//! Every change is versioned and audited; see `settings` for where values come from. Settings
//! export as one JSON document and import through a preview and a batch that applies all changes
//! or none (docs/api/settings-dashboards.md, "Export and import").

use std::collections::BTreeMap;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::auth::SessionUser;
use crate::authz::{Access, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::settings::{self, Effective, Scope, SettingDef, Source};
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/settings", Access::ServerAdmin, list_server),
        route(Method::GET, "/admin/settings/export", Access::ServerAdmin, export_server),
        route(Method::POST, "/admin/settings/import/preview", Access::ServerAdmin, preview_server),
        route(Method::POST, "/admin/settings/batch", Access::ServerAdmin, batch_server),
        route(Method::PATCH, "/admin/settings/{key}", Access::ServerAdmin, patch_server),
        route(Method::GET, "/orgs/{orgId}/settings", Access::Org(Permission::SettingsRead), list_org),
        // Export holds only what the caller may change, so it needs the write permission.
        route(Method::GET, "/orgs/{orgId}/settings/export", Access::Org(Permission::SettingsWrite), export_org),
        route(
            Method::POST,
            "/orgs/{orgId}/settings/import/preview",
            Access::Org(Permission::SettingsWrite),
            preview_org,
        ),
        route(Method::POST, "/orgs/{orgId}/settings/batch", Access::Org(Permission::SettingsWrite), batch_org)
            .changes_rights(),
        route(Method::PATCH, "/orgs/{orgId}/settings/{key}", Access::Org(Permission::SettingsWrite), patch_org)
            .changes_rights(),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingView {
    key: &'static str,
    scope: Scope,
    value: Value,
    default: Value,
    source: Source,
    /// False when the value comes from the environment or `kalzit.toml`, or the setting is never
    /// changed in the UI (network, TLS, sessions).
    editable: bool,
    /// The stored version an update must name; 0 when it was never saved.
    version: i64,
    description: &'static str,
    updated_at: Option<i64>,
    updated_by: Option<String>,
}

fn view(def: &'static SettingDef, e: Effective) -> SettingView {
    SettingView {
        key: def.key,
        scope: def.scope,
        editable: settings::editable(def, &e),
        default: (def.default)(),
        value: e.value,
        source: e.source,
        version: e.version,
        description: def.description,
        updated_at: e.updated_at,
        updated_by: e.updated_by,
    }
}

fn scope_of(org_id: Option<&str>) -> Scope {
    if org_id.is_some() { Scope::Org } else { Scope::Server }
}

async fn list(state: &AppState, org_id: Option<&str>) -> ApiResult<Json<Page<SettingView>>> {
    let items = settings::list(state, org_id).await?.into_iter().map(|(def, e)| view(def, e)).collect();
    // The registry is short; one page holds every setting.
    Ok(Json(Page { items, next_cursor: None }))
}

async fn list_server(State(state): State<AppState>) -> ApiResult<Json<Page<SettingView>>> {
    list(&state, None).await
}

async fn list_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<Page<SettingView>>> {
    list(&state, Some(&ctx.org_id)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatchSetting {
    value: Value,
    version: i64,
}

async fn patch_server(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(key): Path<String>,
    JsonBody(body): JsonBody<PatchSetting>,
) -> ApiResult<Json<SettingView>> {
    patch(&state, &user, &info, None, &key, body).await
}

async fn patch_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, key)): Path<(String, String)>,
    JsonBody(body): JsonBody<PatchSetting>,
) -> ApiResult<Json<SettingView>> {
    patch(&state, &ctx.user, &info, Some(&ctx.org_id), &key, body).await
}

async fn current(state: &AppState, org_id: Option<&str>, key: &str) -> ApiResult<Effective> {
    match org_id {
        None => settings::effective(state, key).await,
        Some(org) => settings::effective_org(state, org, key).await,
    }
}

/// Why a setting cannot be changed through the API right now, or `None` when it can.
fn locked_reason(def: &SettingDef, effective: &Effective) -> Option<String> {
    if !def.ui_editable {
        return Some(format!("{} is set in kalzit.toml or the environment, not in the UI", def.key));
    }
    match effective.source {
        Source::Env => Some(format!(
            "{} is set in the environment ({}); change it there",
            def.key,
            settings::env_var_name(def.key)
        )),
        Source::File => Some(format!("{} is set in kalzit.toml; change it there", def.key)),
        Source::Database | Source::Default => None,
    }
}

async fn patch(
    state: &AppState,
    user: &SessionUser,
    info: &RequestInfo,
    org_id: Option<&str>,
    key: &str,
    body: PatchSetting,
) -> ApiResult<Json<SettingView>> {
    let def = settings::find(key, scope_of(org_id)).ok_or_else(ApiError::not_found)?;
    let before = current(state, org_id, key).await?;
    if let Some(reason) = locked_reason(def, &before) {
        return Err(ApiError::new(StatusCode::CONFLICT, "conflict", reason));
    }
    settings::validate(def, &body.value).map_err(|e| ApiError::validation(e).with_field("value"))?;
    crate::ai::service::check_switch(state, org_id, key, &body.value).await?;
    let conflict = |e: Effective| ApiError::version_conflict(json!(view(def, e)));
    if body.version != before.version {
        return Err(conflict(before));
    }

    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let Some(version) = settings::store(&mut tx, org_id, key, &body.value, body.version, &user.id, now).await? else {
        drop(tx);
        settings::cache(state).invalidate(org_id);
        return Err(conflict(current(state, org_id, key).await?));
    };
    record_update(&mut tx, user, info, org_id, key, version, now, false).await?;
    crate::db::commit(tx).await?;
    settings::cache(state).invalidate(org_id);
    // Built from what was just stored, without another read: once the change is committed,
    // nothing may fail as "busy, nothing changed". The value comes from the database now, since
    // the environment and the file were ruled out above.
    Ok(Json(view(def, stored_view(body.value, version, user, now))))
}

fn stored_view(value: Value, version: i64, user: &SessionUser, now: i64) -> Effective {
    Effective { value, source: Source::Database, version, updated_by: Some(user.id.clone()), updated_at: Some(now) }
}

/// The audit entry of one changed setting: key and new version, never the value.
#[allow(clippy::too_many_arguments)]
async fn record_update(
    tx: &mut sqlx::AnyConnection,
    user: &SessionUser,
    info: &RequestInfo,
    org_id: Option<&str>,
    key: &str,
    version: i64,
    now: i64,
    batch: bool,
) -> ApiResult<()> {
    let mut summary = json!({ "key": key, "version": version });
    if batch {
        summary["batch"] = json!(true);
    }
    let event = AuditEvent {
        org_id,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "settings.updated",
        resource_type: Some("setting"),
        resource_id: Some(key),
        summary,
        at_ms: now,
    };
    audit::record(tx, &event).await?;
    Ok(())
}

/// Marks a settings document, so an import can tell one from any other JSON file.
pub const EXPORT_FORMAT: &str = "kalzit.settings";
pub const EXPORT_VERSION: i64 = 1;
/// The most settings one batch may change; the registry is far smaller.
const MAX_BATCH: usize = 200;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDocument {
    format: &'static str,
    format_version: i64,
    scope: Scope,
    exported_at: i64,
    /// Every setting the caller may change, with its value in effect. Secrets never live in the
    /// settings registry (data source secrets are encrypted in their own table), so none can
    /// appear here; settings from the environment or `kalzit.toml` stay out as well.
    settings: BTreeMap<&'static str, Value>,
}

async fn export(state: &AppState, org_id: Option<&str>) -> ApiResult<Json<SettingsDocument>> {
    let mut out = BTreeMap::new();
    for (def, e) in settings::list(state, org_id).await? {
        if settings::editable(def, &e) {
            out.insert(def.key, e.value);
        }
    }
    Ok(Json(SettingsDocument {
        format: EXPORT_FORMAT,
        format_version: EXPORT_VERSION,
        scope: scope_of(org_id),
        exported_at: state.clock.now_ms(),
        settings: out,
    }))
}

async fn export_server(State(state): State<AppState>) -> ApiResult<Json<SettingsDocument>> {
    export(&state, None).await
}

async fn export_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<SettingsDocument>> {
    export(&state, Some(&ctx.org_id)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewRequest {
    document: Value,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ImportStatus {
    /// The imported value differs and would be applied.
    Change,
    /// The imported value is the one in effect.
    Same,
    /// The setting cannot be changed here (environment, `kalzit.toml`, configuration only).
    Locked,
    /// The value is refused by the setting's rule.
    Invalid,
    /// No such setting in this scope (another version, or the other scope).
    Unknown,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    key: String,
    status: ImportStatus,
    /// The value in effect; `null` for an unknown key.
    current: Value,
    imported: Value,
    /// The stored version a batch must name to apply this change.
    version: i64,
    /// Where the value in effect comes from; `null` for an unknown key. An undo of the import
    /// resets a setting that was `default` instead of storing its default value.
    source: Option<Source>,
    /// Why the item is locked or invalid, in English.
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// The `settings` of a document, checked to be a settings export of this scope.
fn document_settings(document: &Value, scope: Scope) -> ApiResult<&serde_json::Map<String, Value>> {
    let bad = |message: &str| ApiError::validation(message.to_string()).with_field("document");
    if document.get("format").and_then(Value::as_str) != Some(EXPORT_FORMAT) {
        return Err(bad("the file is not a Kalzit settings export"));
    }
    if document.get("formatVersion").and_then(Value::as_i64) != Some(EXPORT_VERSION) {
        return Err(bad("the settings export has a format version this server does not read"));
    }
    let expected = if scope == Scope::Server { "server" } else { "org" };
    if document.get("scope").and_then(Value::as_str) != Some(expected) {
        return Err(bad(if scope == Scope::Server {
            "this export holds organization settings, not server settings"
        } else {
            "this export holds server settings, not organization settings"
        }));
    }
    let map = document.get("settings").and_then(Value::as_object).ok_or_else(|| bad("the export has no settings"))?;
    if map.len() > MAX_BATCH {
        return Err(bad("the export holds more settings than any server has"));
    }
    Ok(map)
}

async fn preview(state: &AppState, org_id: Option<&str>, body: PreviewRequest) -> ApiResult<Json<Page<PreviewItem>>> {
    let scope = scope_of(org_id);
    let imported = document_settings(&body.document, scope)?;
    let mut items = Vec::new();
    for (key, value) in imported {
        let Some(def) = settings::find(key, scope) else {
            items.push(PreviewItem {
                key: key.clone(),
                status: ImportStatus::Unknown,
                current: Value::Null,
                imported: value.clone(),
                version: 0,
                source: None,
                message: None,
            });
            continue;
        };
        let e = current(state, org_id, key).await?;
        let (status, message) = if let Some(reason) = locked_reason(def, &e) {
            (ImportStatus::Locked, Some(reason))
        } else if let Err(reason) = settings::validate(def, value) {
            (ImportStatus::Invalid, Some(reason))
        } else if *value == e.value {
            (ImportStatus::Same, None)
        } else {
            (ImportStatus::Change, None)
        };
        items.push(PreviewItem {
            key: key.clone(),
            status,
            current: e.value,
            imported: value.clone(),
            version: e.version,
            source: Some(e.source),
            message,
        });
    }
    Ok(Json(Page { items, next_cursor: None }))
}

async fn preview_server(
    State(state): State<AppState>,
    JsonBody(body): JsonBody<PreviewRequest>,
) -> ApiResult<Json<Page<PreviewItem>>> {
    preview(&state, None, body).await
}

async fn preview_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(body): JsonBody<PreviewRequest>,
) -> ApiResult<Json<Page<PreviewItem>>> {
    preview(&state, Some(&ctx.org_id), body).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchChange {
    key: String,
    /// The new value; absent with `reset`.
    #[serde(default)]
    value: Option<Value>,
    version: i64,
    /// Deletes the stored value, so the default applies again (and later changes of the default
    /// reach this setting), instead of storing a copy of it.
    #[serde(default)]
    reset: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BatchRequest {
    changes: Vec<BatchChange>,
}

async fn batch(
    state: &AppState,
    user: &SessionUser,
    info: &RequestInfo,
    org_id: Option<&str>,
    body: BatchRequest,
) -> ApiResult<Json<Page<SettingView>>> {
    let scope = scope_of(org_id);
    if body.changes.is_empty() || body.changes.len() > MAX_BATCH {
        return Err(ApiError::validation(format!("a batch changes 1 to {MAX_BATCH} settings")).with_field("changes"));
    }
    // Everything is checked before anything is written: one bad entry and nothing changes.
    let mut checked: Vec<(&'static SettingDef, &BatchChange)> = Vec::new();
    let mut stale = false;
    for change in &body.changes {
        if checked.iter().any(|(def, _)| def.key == change.key) {
            return Err(ApiError::validation(format!("{} is in the batch twice", change.key)).with_field("changes"));
        }
        let def = settings::find(&change.key, scope).ok_or_else(|| {
            ApiError::validation(format!("there is no setting {} here", change.key)).with_field("changes")
        })?;
        let before = current(state, org_id, def.key).await?;
        if let Some(reason) = locked_reason(def, &before) {
            return Err(ApiError::new(StatusCode::CONFLICT, "conflict", reason));
        }
        match (&change.value, change.reset) {
            (Some(value), false) => {
                settings::validate(def, value).map_err(|e| ApiError::validation(e).with_field("changes"))?;
                crate::ai::service::check_switch(state, org_id, def.key, value).await?;
            }
            (None, true) => {}
            _ => {
                return Err(ApiError::validation(format!("{}: a change has either a value or reset", change.key))
                    .with_field("changes"));
            }
        }
        stale |= before.version != change.version;
        checked.push((def, change));
    }
    let conflict = async |state: &AppState| -> ApiResult<ApiError> {
        let mut items = Vec::new();
        for (def, _) in &checked {
            items.push(view(def, current(state, org_id, def.key).await?));
        }
        Ok(ApiError::version_conflict(json!({ "items": items, "nextCursor": null })))
    };
    if stale {
        return Err(conflict(state).await?);
    }

    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let mut saved = Vec::new();
    for (def, change) in &checked {
        let done = match &change.value {
            Some(value) => settings::store(&mut tx, org_id, def.key, value, change.version, &user.id, now)
                .await?
                .map(|version| (version, stored_view(value.clone(), version, user, now))),
            None => settings::reset(&mut tx, org_id, def.key, change.version, &user.id, now).await?.map(|version| {
                let default = Effective {
                    value: (def.default)(),
                    source: Source::Default,
                    version,
                    updated_by: (version > 0).then(|| user.id.clone()),
                    updated_at: (version > 0).then_some(now),
                };
                (version, default)
            }),
        };
        let Some((version, effective)) = done else {
            drop(tx);
            settings::cache(state).invalidate(org_id);
            return Err(conflict(state).await?);
        };
        record_update(&mut tx, user, info, org_id, def.key, version, now, true).await?;
        saved.push(view(def, effective));
    }
    crate::db::commit(tx).await?;
    settings::cache(state).invalidate(org_id);
    Ok(Json(Page { items: saved, next_cursor: None }))
}

async fn batch_server(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<BatchRequest>,
) -> ApiResult<Json<Page<SettingView>>> {
    batch(&state, &user, &info, None, body).await
}

async fn batch_org(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<BatchRequest>,
) -> ApiResult<Json<Page<SettingView>>> {
    batch(&state, &ctx.user, &info, Some(&ctx.org_id), body).await
}
