//! Panel plugins in an organization (docs/api/plugins.md, "Panel plugins"): the panel types its
//! members may use, and the sandboxed frame document of one (`plugins::panels`).
//!
//! A frame is served only for a panel plugin that may be shown (approved, enabled, trusted, not
//! blocked for the organization) and only for a dashboard the caller may read that shows the
//! panel; adding a panel the dashboard does not show yet needs the right to edit it, and a new
//! dashboard that is not saved yet the right to create dashboards.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use kalzit_plugin_api::manifest::PanelOption;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{self, Access, OrgCtx, Permission, Resource};
use crate::dashboards::library;
use crate::error::{ApiError, ApiResult};
use crate::plugins::panels::{self, ActivePanel};
use crate::plugins::store;
use crate::saved_analyses;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/panel-plugins", Access::OrgMember, list),
        route(Method::GET, "/orgs/{orgId}/panel-plugins/{pluginId}/frame", Access::OrgMember, frame),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelPluginView {
    id: String,
    name: String,
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    /// As the manifest names it: a neutral badge, not a verified identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    /// `kalzit`, `publisher` or `unsigned`.
    signer: String,
    /// The shapes the panel shows.
    shapes: Vec<String>,
    /// The panel message API version the bundle speaks.
    api: u32,
    /// The options the panel declares; the options editor is built from them.
    options: Vec<PanelOption>,
}

#[derive(Serialize)]
struct PanelPluginList {
    items: Vec<PanelPluginView>,
}

/// The panel plugin `id` if it may be shown in the caller's organization.
fn usable(state: &AppState, ctx: &OrgCtx, id: &str) -> Option<ActivePanel> {
    let panel = state.plugins.panels().get(id)?;
    (!state.datasources.is_blocked(&ctx.org_id, id)).then_some(panel)
}

/// `GET /orgs/{orgId}/panel-plugins`: the panel types of installed panel plugins that may be shown
/// in the organization, for the visualization picker and the options editor.
async fn list(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<PanelPluginList>> {
    let signers: std::collections::HashMap<String, String> =
        store::all(&state.db).await?.into_iter().map(|p| (p.id, p.signer)).collect();
    let items = state
        .plugins
        .panels()
        .all()
        .into_iter()
        .filter(|(id, _)| !state.datasources.is_blocked(&ctx.org_id, id))
        .map(|(id, p)| {
            let m = &p.manifest;
            let bundle = p.bundle();
            PanelPluginView {
                signer: signers.get(&id).cloned().unwrap_or_else(|| "unsigned".into()),
                id,
                name: m.name.clone(),
                version: m.version.clone(),
                description: m.description.clone(),
                publisher: m.publisher.clone(),
                shapes: m.shapes.clone(),
                api: bundle.api,
                options: bundle.options.clone(),
            }
        })
        .collect();
    Ok(Json(PanelPluginList { items }))
}

#[derive(Deserialize)]
struct FramePath {
    #[serde(rename = "orgId")]
    _org_id: String,
    #[serde(rename = "pluginId")]
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrameQuery {
    /// The dashboard the panel is drawn on; absent for a new dashboard that is not saved yet.
    dashboard: Option<String>,
    /// The plugin's version, so a new version is loaded afresh; not checked.
    #[serde(rename = "v")]
    _version: Option<String>,
}

/// Whether the current version of the dashboard shows a panel of type `kind`: its own, a linked
/// library panel's or a linked analysis's visualization.
async fn shows_panel(state: &AppState, org_id: &str, dashboard_id: &str, kind: &str) -> ApiResult<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT v.model FROM dashboards d JOIN dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.version \
         WHERE d.org_id = $1 AND d.id = $2 AND d.deleted_at IS NULL",
    )
    .bind(org_id)
    .bind(dashboard_id)
    .fetch_optional(&state.db)
    .await?;
    let (raw,) = row.ok_or_else(ApiError::not_found)?;
    let model: Value = serde_json::from_str(&raw).map_err(|e| ApiError::internal("dashboards", e))?;
    model_shows_panel(state, org_id, &model, kind).await
}

/// Whether a dashboard model of the organization shows a panel of type `kind`: its own, a
/// linked library panel's or a linked analysis's visualization.
pub(crate) async fn model_shows_panel(state: &AppState, org_id: &str, model: &Value, kind: &str) -> ApiResult<bool> {
    let panels: Vec<&Value> = model["panels"].as_array().into_iter().flatten().collect();
    if panels.iter().any(|p| p["type"].as_str() == Some(kind)) {
        return Ok(true);
    }
    let ids = |key: &str| -> BTreeSet<&str> { panels.iter().filter_map(|p| p[key].as_str()).collect() };
    let (library, analyses) = (ids("libraryPanelId"), ids("analysisId"));
    let mut conn = state.db.acquire().await?;
    if !library.is_empty()
        && library::linked_panels(&mut conn, org_id, &library)
            .await?
            .values()
            .any(|p| p.model["type"].as_str() == Some(kind))
    {
        return Ok(true);
    }
    Ok(!analyses.is_empty()
        && saved_analyses::linked_analyses(&mut conn, org_id, &analyses)
            .await?
            .values()
            .any(|a| a.model["visualization"]["type"].as_str() == Some(kind)))
}

/// `GET /orgs/{orgId}/panel-plugins/{pluginId}/frame?dashboard=...`: the frame document of a
/// panel plugin, for `<iframe sandbox="allow-scripts">`, with a policy of its own.
async fn frame(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<FramePath>,
    Query(query): Query<FrameQuery>,
) -> ApiResult<Response> {
    let id = path.plugin_id.as_str();
    match &query.dashboard {
        Some(dashboard) => {
            // A dashboard the caller cannot see answers as one that does not exist.
            let shown = shows_panel(&state, &ctx.org_id, dashboard, id).await?;
            let needed = if shown { Permission::DashboardsRead } else { Permission::DashboardsWrite };
            authz::check_resource(&state.db, &ctx, needed, Resource::Dashboard(dashboard)).await?;
        }
        None => ctx.check(Permission::DashboardsWrite)?,
    }
    let panel = usable(&state, &ctx, id).ok_or_else(|| ApiError::not_found().because("plugin.panel_unavailable"))?;
    let frame = tokio::task::spawn_blocking({
        let (id, panel) = (id.to_string(), panel.clone());
        move || panels::frame(&id, &panel)
    })
    .await
    .map_err(|e| ApiError::internal("panel frame", e))?
    .map_err(|e| e.api())?;
    let csp = HeaderValue::from_str(&frame.csp).map_err(|e| ApiError::internal("panel frame", e))?;
    let mut res = (StatusCode::OK, frame.html).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    h.insert(header::CONTENT_SECURITY_POLICY, csp);
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("SAMEORIGIN"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    h.insert("x-dns-prefetch-control", HeaderValue::from_static("off"));
    h.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    h.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), display-capture=(), fullscreen=()",
        ),
    );
    Ok(res)
}
