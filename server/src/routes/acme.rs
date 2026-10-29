//! HTTPS certificates over ACME, for server administrators (docs/api/settings-dashboards.md,
//! "HTTPS certificates"). The settings are dependent fields, so they are saved in one step: each
//! field is checked, then the directory and the names over the network, and the first problem is
//! answered with its field and reason.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::table::{RouteDef, route};
use crate::acme::{self, AcmeSettings, AcmeView, Checked, FieldError};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/acme", Access::ServerAdmin, status),
        route(Method::PUT, "/admin/acme", Access::ServerAdmin, save),
        route(Method::POST, "/admin/acme/test", Access::ServerAdmin, test),
        route(Method::POST, "/admin/acme/renew", Access::ServerAdmin, renew),
    ]
}

fn view(state: &AppState) -> AcmeView {
    state.acme.view(&state.config, state.clock.now_ms())
}

async fn status(State(state): State<AppState>) -> ApiResult<Json<AcmeView>> {
    Ok(Json(view(&state)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBody {
    settings: AcmeSettings,
    /// The version the administrator edited (`AcmeView::version`).
    version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestBody {
    settings: AcmeSettings,
}

/// Every check a save makes, without saving.
async fn checked(state: &AppState, settings: &AcmeSettings) -> Result<Checked, FieldError> {
    acme::settings::check(settings)?;
    acme::settings::check_against(settings, &state.config)?;
    acme::check_connection(settings, &state.config).await
}

async fn test(State(state): State<AppState>, JsonBody(body): JsonBody<TestBody>) -> ApiResult<Json<Checked>> {
    let settings = body.settings.normalized();
    checked(&state, &settings).await.map(Json).map_err(FieldError::into_api)
}

async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<AcmeView>> {
    let settings = body.settings.normalized();
    if settings.enabled {
        checked(&state, &settings).await.map_err(FieldError::into_api)?;
    } else {
        // Off, the fields are kept as they are for later; their form is checked, and that HTTPS
        // does not depend on ACME.
        acme::settings::check(&settings).map_err(FieldError::into_api)?;
        acme::settings::check_against(&settings, &state.config).map_err(FieldError::into_api)?;
    }
    let (before, _) = state.acme.settings();
    let value = serde_json::to_value(&settings).map_err(|e| ApiError::internal("acme settings", e))?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let Some(version) =
        crate::settings::store(&mut tx, None, acme::SETTINGS_KEY, &value, body.version, &user.id, now).await?
    else {
        drop(tx);
        // Another administrator saved in the meantime; the UI shows what is stored now.
        let (stored, version) =
            acme::load_settings(&state.db).await.map_err(|e| ApiError::internal("acme settings", e))?;
        state.acme.apply_saved(stored, version);
        return Err(ApiError::version_conflict(json!(view(&state))));
    };
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "tls.acme_changed",
        resource_type: Some("certificate"),
        resource_id: None,
        summary: json!({
            "enabled": settings.enabled,
            "directory": settings.directory,
            "directoryUrl": settings.directory_url(),
            "domains": settings.domains,
            "challenge": settings.challenge.name(),
            "contact": !settings.email.is_empty(),
            "wasEnabled": before.enabled,
        }),
        at_ms: now,
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    state.acme.apply_saved(settings, version);
    // The other servers on the same database take the settings; the leader orders.
    state.cluster.publish(crate::cluster::Change::Acme);
    Ok(Json(view(&state)))
}

async fn renew(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<AcmeView>> {
    let (settings, _) = state.acme.settings();
    let requested = state.acme.request_renewal(state.clock.now_ms()).map_err(|refused| {
        ApiError::new(axum::http::StatusCode::CONFLICT, "conflict", refused.message)
            .with_field(refused.field)
            .with_reason_string(refused.reason.to_string(), refused.params)
    })?;
    if requested {
        // The leader of several servers on one database orders.
        if !state.cluster.is_leader() {
            state.cluster.publish(crate::cluster::Change::AcmeRenew);
        }
        let mut tx = crate::db::begin(&state.db).await?;
        let event = AuditEvent {
            org_id: None,
            actor_user_id: Some(&user.id),
            actor_address: Some(info.client_ip.to_string()),
            action: "tls.certificate_requested",
            resource_type: Some("certificate"),
            resource_id: None,
            summary: json!({ "domains": settings.domains }),
            at_ms: state.clock.now_ms(),
        };
        audit::record(&mut tx, &event).await?;
        crate::db::commit(tx).await?;
    }
    Ok(Json(view(&state)))
}
