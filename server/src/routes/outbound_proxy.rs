//! The outbound proxy's password, for server administrators (docs/api/settings-dashboards.md,
//! "Outbound proxy"). Address, bypass list and user name are ordinary settings; the password is a
//! secret, so it is only set or removed here and never sent back.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::outbound;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/network/proxy-password", Access::ServerAdmin, view),
        route(Method::PUT, "/admin/network/proxy-password", Access::ServerAdmin, save),
    ]
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPasswordView {
    /// A password is stored for the proxy address in force; it is sent with the user name.
    set: bool,
    /// A password is stored, but for another proxy address: it is not used until it is set again.
    stale: bool,
}

async fn load_view(state: &AppState) -> ApiResult<ProxyPasswordView> {
    let url = crate::settings::get(state, outbound::URL_KEY).await?;
    let url = url.as_str().unwrap_or_default();
    let stored = outbound::stored_password(&state.db, &state.secrets).await?;
    Ok(match stored {
        Some((proxy, _)) if !url.is_empty() && proxy == url => ProxyPasswordView { set: true, stale: false },
        Some(_) => ProxyPasswordView { set: false, stale: true },
        None => ProxyPasswordView { set: false, stale: false },
    })
}

async fn view(State(state): State<AppState>) -> ApiResult<Json<ProxyPasswordView>> {
    Ok(Json(load_view(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBody {
    /// The new password; `null` or empty removes it.
    password: Option<String>,
}

async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<ProxyPasswordView>> {
    let password = body.password.filter(|p| !p.is_empty()).map(Zeroizing::new);
    let url = crate::settings::get(&state, outbound::URL_KEY).await?;
    let url = url.as_str().unwrap_or_default().to_string();
    if let Some(p) = &password {
        if p.chars().count() > outbound::MAX_PASSWORD_CHARS || p.chars().any(char::is_control) {
            return Err(ApiError::validation("the password is too long or has control characters")
                .with_field("password")
                .because("settings.proxy_password_invalid")
                .param("maxChars", outbound::MAX_PASSWORD_CHARS));
        }
        if url.is_empty() {
            return Err(ApiError::validation("set the proxy address first; the password belongs to it")
                .with_field("password")
                .because("settings.proxy_url_missing"));
        }
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    outbound::store_password(&mut tx, &state.secrets, password.as_deref().map(|p| (url.as_str(), p.as_str())))
        .await?;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "settings.updated",
        resource_type: Some("setting"),
        resource_id: Some("network.proxy_password"),
        summary: json!({ "key": "network.proxy_password", "set": password.is_some() }),
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(Json(load_view(&state).await?))
}
