//! Server settings (server administrators) and organization settings (`settings:read|write`).
//! Every change is versioned and audited; see `settings` for where values come from.

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
        route(Method::PATCH, "/admin/settings/{key}", Access::ServerAdmin, patch_server),
        route(Method::GET, "/orgs/{orgId}/settings", Access::Org(Permission::SettingsRead), list_org),
        route(Method::PATCH, "/orgs/{orgId}/settings/{key}", Access::Org(Permission::SettingsWrite), patch_org),
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

async fn patch(
    state: &AppState,
    user: &SessionUser,
    info: &RequestInfo,
    org_id: Option<&str>,
    key: &str,
    body: PatchSetting,
) -> ApiResult<Json<SettingView>> {
    let scope = if org_id.is_some() { Scope::Org } else { Scope::Server };
    let def = settings::find(key, scope).ok_or_else(ApiError::not_found)?;
    let before = current(state, org_id, key).await?;
    if !def.ui_editable {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            format!("{key} is set in kalzit.toml or the environment, not in the UI"),
        ));
    }
    let locked_by = match before.source {
        Source::Env => Some(format!("the environment ({})", settings::env_var_name(key))),
        Source::File => Some("kalzit.toml".to_string()),
        Source::Database | Source::Default => None,
    };
    if let Some(place) = locked_by {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            format!("{key} is set in {place}; change it there"),
        ));
    }
    settings::validate(key, &body.value).map_err(|e| ApiError::validation(e).with_field("value"))?;
    let conflict = |e: Effective| ApiError::version_conflict(json!(view(def, e)));
    if body.version != before.version {
        return Err(conflict(before));
    }

    let now = state.clock.now_ms();
    let mut tx = state.db.begin().await?;
    let Some(version) = settings::store(&mut tx, org_id, key, &body.value, body.version, &user.id, now).await? else {
        drop(tx);
        settings::cache(state).invalidate(org_id);
        return Err(conflict(current(state, org_id, key).await?));
    };
    let event = AuditEvent {
        org_id,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "settings.updated",
        resource_type: Some("setting"),
        resource_id: Some(key),
        summary: json!({ "key": key, "version": version }),
        at_ms: now,
    };
    audit::record(&mut tx, &event).await?;
    tx.commit().await?;
    settings::cache(state).invalidate(org_id);
    Ok(Json(view(def, current(state, org_id, key).await?)))
}
