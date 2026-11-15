//! Public links and snapshots (docs/api/sharing.md; the rules in `sharing`).
//!
//! - Public links: creating needs `dashboards:public`, read on the dashboard and query rights on
//!   every source its panels use, with public sharing on for the server and the organization.
//!   Organization admins (`org:write`) list every link of the organization, everyone else their
//!   own. The creator and the organization's admins change the expiry and revoke; revoking is
//!   final.
//! - Snapshots: an internal one needs `dashboards:share` on the dashboard and is seen by members
//!   who may read the dashboard; a public one needs what a public link needs. Listing, changing
//!   the expiry and revoking follow the links.
//! - Status (active, suspended with its reason, expired, revoked) is shown to the creator and the
//!   organization's admins only. Suspension is not stored: each request finds it anew.
//! - The public routes need no session: the token is the credential. Each counts against the
//!   client address and the token, and every token that does not work answers alike.
//!
//! Creating, changing the expiry and revoking are audited, never with a token.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::new_id;
use super::support::{Actor, Paging, QueryParams, audit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::api_token::{TokenCaller, refuse_tokens};
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::dashboards::model;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::routes::query::{check_variables, readable_model, resolve_variables, run_stored_panel};
use crate::shapes::{Page, PanelQueryRequest, QueryResponse, TimeRange};
use crate::sharing::{
    self, Gate, PublicDashboard, SharedPanel, SharedTimeRange, SuspendedReason, current_variables, default_variables,
    panel_sources, public_response, shared_panels, unavailable,
};

pub fn routes() -> Vec<RouteDef> {
    use Access::{OrgMember, Public};
    vec![
        route(
            Method::POST,
            "/orgs/{orgId}/dashboards/{dashboardId}/public-links",
            Access::Org(Permission::DashboardsPublic),
            create_link,
        ),
        // Organization admins see and manage every link, everyone else their own (in the handler).
        route(Method::GET, "/orgs/{orgId}/public-links", OrgMember, list_links),
        route(Method::PATCH, "/orgs/{orgId}/public-links/{linkId}", OrgMember, change_link),
        route(Method::POST, "/orgs/{orgId}/public-links/{linkId}/revoke", OrgMember, revoke_link),
        // `dashboards:share` on the dashboard, or `dashboards:public` for a public one; the panels'
        // queries run while the request waits.
        route(Method::POST, "/orgs/{orgId}/dashboards/{dashboardId}/snapshots", OrgMember, create_snapshot)
            .long_running(),
        // Read on the dashboard.
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}/snapshots", OrgMember, dashboard_snapshots),
        route(Method::GET, "/orgs/{orgId}/snapshots", OrgMember, list_snapshots),
        route(Method::GET, "/orgs/{orgId}/snapshots/{snapshotId}", OrgMember, get_snapshot),
        route(Method::PATCH, "/orgs/{orgId}/snapshots/{snapshotId}", OrgMember, change_snapshot),
        route(Method::POST, "/orgs/{orgId}/snapshots/{snapshotId}/revoke", OrgMember, revoke_snapshot),
        route(Method::GET, "/public/dashboards/{token}", Public, public_link),
        route(Method::POST, "/public/dashboards/{token}/panels/{panelId}/query", Public, public_panel_query)
            .long_running(),
        route(Method::GET, "/public/snapshots/{token}", Public, public_snapshot),
    ]
}

/// Where a link or snapshot stands. `expired` and `revoked` ones are deleted 30 days later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ShareStatus {
    Active,
    /// Not served now (`suspendedReason`); works again once the cause is gone, until it expires.
    Suspended,
    Expired,
    Revoked,
}

/// A public link as its creator and the organization's admins see it; the token is shown once,
/// when the link is made.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicLink {
    pub id: String,
    pub dashboard_id: String,
    /// Absent when the caller may not read the dashboard.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub dashboard_title: Option<String>,
    pub created_by: Option<String>,
    pub created_by_name: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    /// How far back a visitor may look: any range from `now - maxWindowMs` to now.
    pub max_window_ms: i64,
    /// The range the page opens with.
    pub time_range: SharedTimeRange,
    /// The fixed variable values.
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    /// Page loads by visitors; nothing else about them is kept.
    pub views: i64,
    pub last_viewed_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub status: ShareStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub suspended_reason: Option<SuspendedReason>,
}

/// `POST /orgs/{orgId}/dashboards/{dashboardId}/public-links`: every field may be left out.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePublicLink {
    /// Unix milliseconds; default 30 days from now, at most `sharing.max_expiry_days` from now.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub expires_at: Option<i64>,
    /// Default 7 days; 1 minute up to `sharing.max_expiry_days`.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub max_window_ms: Option<i64>,
    /// Default: the dashboard's range.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub time_range: Option<SharedTimeRange>,
    /// Default: the dashboard's current values. Constants are the dashboard's own.
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "Record<string, unknown>"))]
    pub variables: Option<BTreeMap<String, Value>>,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CreatedPublicLink {
    pub link: PublicLink,
    /// The link's token, shown this once: the page is `/public/dashboards/{token}`.
    pub token: String,
}

/// `PATCH` of a link or snapshot: a new expiry, at most `sharing.max_expiry_days` from now.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeExpiry {
    pub expires_at: i64,
}

/// `GET /public/dashboards/{token}`.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicLinkView {
    pub dashboard: PublicDashboard,
    pub time_range: SharedTimeRange,
    pub max_window_ms: i64,
    pub expires_at: i64,
}

/// `POST /public/dashboards/{token}/panels/{panelId}/query`: the time range is all a visitor may
/// choose; any other field is refused.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicPanelQuery {
    pub time_range: TimeRange,
}

/// A snapshot without its contents. `status` and `suspendedReason` only for its creator and the
/// organization's admins.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub id: String,
    pub dashboard_id: String,
    /// Absent when the caller may not read the dashboard.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub dashboard_title: Option<String>,
    pub title: String,
    pub public: bool,
    pub created_by: Option<String>,
    pub created_by_name: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    /// The absolute range the panels ran for.
    pub time_range: TimeRange,
    pub size_bytes: i64,
    pub views: i64,
    pub last_viewed_at: Option<i64>,
    pub revoked_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub status: Option<ShareStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub suspended_reason: Option<SuspendedReason>,
}

/// `POST /orgs/{orgId}/dashboards/{dashboardId}/snapshots`.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSnapshot {
    /// Default: the dashboard's title.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub title: Option<String>,
    /// The absolute range every panel runs for.
    pub time_range: TimeRange,
    /// Default: the dashboard's current values.
    #[serde(default)]
    #[cfg_attr(test, ts(optional, type = "Record<string, unknown>"))]
    pub variables: Option<BTreeMap<String, Value>>,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub expires_at: Option<i64>,
    /// A public snapshot gets a token; it needs `dashboards:public`. Default `false`.
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub public: bool,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CreatedSnapshot {
    pub snapshot: SnapshotSummary,
    /// A public snapshot's token, shown this once: the page is `/public/snapshots/{token}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub token: Option<String>,
}

/// `GET /orgs/{orgId}/snapshots/{snapshotId}`: the snapshot with the dashboard as it was shared
/// and the frozen answers by panel id.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SnapshotView {
    pub snapshot: SnapshotSummary,
    #[cfg_attr(test, ts(type = "PublicDashboard"))]
    pub dashboard: Box<RawValue>,
    #[cfg_attr(test, ts(type = "Record<string, QueryResponse>"))]
    pub results: Box<RawValue>,
}

/// `GET /public/snapshots/{token}`.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct PublicSnapshotView {
    pub title: String,
    pub time_range: TimeRange,
    pub created_at: i64,
    pub expires_at: i64,
    #[cfg_attr(test, ts(type = "PublicDashboard"))]
    pub dashboard: Box<RawValue>,
    #[cfg_attr(test, ts(type = "Record<string, QueryResponse>"))]
    pub results: Box<RawValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
    /// Only the caller's own; organization admins see everyone's without it.
    mine: Option<bool>,
    dashboard_id: Option<String>,
}

fn public_off() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "public sharing is turned off for this server or organization")
        .because("sharing.public_off")
}

fn sources_forbidden() -> ApiError {
    ApiError::forbidden("public sharing needs query rights on every data source of the dashboard's panels")
        .because("sharing.sources_forbidden")
}

fn ended(status: ShareStatus) -> ApiError {
    match status {
        ShareStatus::Revoked => ApiError::new(StatusCode::CONFLICT, "conflict", "it was revoked; revoking is final")
            .because("sharing.revoked"),
        _ => ApiError::new(StatusCode::CONFLICT, "conflict", "it has expired").because("sharing.expired"),
    }
}

/// Revoked or expired, before any check of rights: what can no longer change.
fn ended_status(revoked_at: Option<i64>, expires_at: i64, now: i64) -> Option<ShareStatus> {
    if revoked_at.is_some() {
        Some(ShareStatus::Revoked)
    } else if expires_at <= now {
        Some(ShareStatus::Expired)
    } else {
        None
    }
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::internal("sharing", e)
}

fn raw(text: String) -> ApiResult<Box<RawValue>> {
    RawValue::from_string(text).map_err(internal)
}

/// Whether the caller manages every link and snapshot of the organization.
fn manages_all(ctx: &OrgCtx) -> bool {
    ctx.permissions.contains(&Permission::OrgWrite)
}

/// Whether the caller made it or manages all: who sees its status, changes and revokes it.
fn manages(ctx: &OrgCtx, created_by: Option<&str>) -> bool {
    manages_all(ctx) || created_by == Some(ctx.user.id.as_str())
}

/// The dashboards among `ids` the caller may read, so lists name only those.
async fn readable_dashboards<'a>(
    state: &AppState,
    ctx: &OrgCtx,
    ids: impl Iterator<Item = &'a str>,
) -> ApiResult<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    let ids: BTreeSet<&str> = ids.collect();
    for id in ids {
        match check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(id)).await {
            Ok(()) => {
                out.insert(id.to_string());
            }
            Err(e) if matches!(e.status, StatusCode::NOT_FOUND | StatusCode::FORBIDDEN) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// The filter of a list: the caller's own rows unless they manage all of them and did not ask
/// for their own, and one dashboard's when named. Empty means no filter.
fn list_filter(ctx: &OrgCtx, q: &ListQuery) -> (String, String) {
    let mine = q.mine == Some(true) || !manages_all(ctx);
    let creator = if mine { ctx.user.id.clone() } else { String::new() };
    (creator, q.dashboard_id.clone().unwrap_or_default())
}

fn audit_actor<'a>(ctx: &'a OrgCtx, info: &'a RequestInfo, now: i64) -> Actor<'a> {
    Actor { user_id: &ctx.user.id, info, at_ms: now }
}

// Public links.

#[derive(sqlx::FromRow)]
struct LinkRow {
    id: String,
    org_id: String,
    dashboard_id: String,
    dashboard_title: String,
    created_by: Option<String>,
    created_by_name: Option<String>,
    created_at: i64,
    expires_at: i64,
    max_window_ms: i64,
    time_from: String,
    time_to: String,
    variables: String,
    views: i64,
    last_viewed_at: Option<i64>,
    revoked_at: Option<i64>,
}

const LINK_COLUMNS: &str = "SELECT l.id, l.org_id, l.dashboard_id, d.title AS dashboard_title, l.created_by, \
     u.name AS created_by_name, l.created_at, l.expires_at, l.max_window_ms, l.time_from, l.time_to, l.variables, \
     l.views, l.last_viewed_at, l.revoked_at FROM public_links l JOIN dashboards d ON d.id = l.dashboard_id \
     LEFT JOIN users u ON u.id = l.created_by";

impl LinkRow {
    fn variables(&self) -> ApiResult<BTreeMap<String, Value>> {
        serde_json::from_str(&self.variables).map_err(internal)
    }

    fn time_range(&self) -> SharedTimeRange {
        SharedTimeRange { from: self.time_from.clone(), to: self.time_to.clone() }
    }

    fn view(&self, readable: bool, status: (ShareStatus, Option<SuspendedReason>)) -> ApiResult<PublicLink> {
        Ok(PublicLink {
            id: self.id.clone(),
            dashboard_id: self.dashboard_id.clone(),
            dashboard_title: readable.then(|| self.dashboard_title.clone()),
            created_by: self.created_by.clone(),
            created_by_name: self.created_by_name.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
            max_window_ms: self.max_window_ms,
            time_range: self.time_range(),
            variables: self.variables()?,
            views: self.views,
            last_viewed_at: self.last_viewed_at,
            revoked_at: self.revoked_at,
            status: status.0,
            suspended_reason: status.1,
        })
    }
}

async fn fetch_link(conn: &mut sqlx::AnyConnection, org_id: &str, id: &str) -> ApiResult<Option<LinkRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{LINK_COLUMNS} WHERE l.org_id = $1 AND l.id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

/// A link that works now, with its creator's context, the dashboard and its panels.
struct OpenLink {
    ctx: OrgCtx,
    model: model::DashboardModel,
    panels: Vec<SharedPanel>,
}

type Closed = (ShareStatus, Option<SuspendedReason>);

/// Every check a link passes before it is served, or where it stands instead. The checks of the
/// creator run for revoked and expired links too, so a visitor cannot tell those apart from a
/// suspended link by how long the answer takes.
async fn evaluate_link(state: &AppState, row: &LinkRow) -> ApiResult<Result<OpenLink, Closed>> {
    let ended = ended_status(row.revoked_at, row.expires_at, state.clock.now_ms());
    let gate = sharing::creator_gate(state, &row.org_id, row.created_by.as_deref(), &row.dashboard_id).await?;
    let open = match gate {
        Gate::Open(ctx, model) => {
            let panels = shared_panels(state, &row.org_id, &model).await?;
            if sharing::may_query_all(state, &ctx, &panel_sources(&panels)).await? {
                Ok(OpenLink { ctx: *ctx, model: *model, panels })
            } else {
                Err((ShareStatus::Suspended, Some(SuspendedReason::CreatorRights)))
            }
        }
        Gate::Suspended(reason) => Err((ShareStatus::Suspended, Some(reason))),
    };
    Ok(match ended {
        Some(status) => Err((status, None)),
        None => open,
    })
}

async fn link_status(state: &AppState, row: &LinkRow) -> ApiResult<Closed> {
    Ok(match evaluate_link(state, row).await? {
        Ok(_) => (ShareStatus::Active, None),
        Err(closed) => closed,
    })
}

async fn create_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, dashboard_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<CreatePublicLink>,
) -> ApiResult<(StatusCode, Json<CreatedPublicLink>)> {
    // Only a signed-in person publishes: an API token is no one to answer for it.
    refuse_tokens(caller.as_deref())?;
    let now = state.clock.now_ms();
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    if !sharing::public_enabled(&state, &ctx.org_id).await? {
        return Err(public_off());
    }
    let expires_at = sharing::expiry(&state, body.expires_at, now).await?;
    let max_window_ms = sharing::window(body.max_window_ms, sharing::max_expiry_days(&state).await?)?;
    let range = match body.time_range {
        Some(range) => {
            let value = serde_json::to_value(&range).map_err(internal)?;
            model::check_time_range(&value).map_err(|e| {
                ApiError::validation(format!("timeRange {e}")).with_field("timeRange").because("sharing.range_invalid")
            })?;
            range
        }
        None => SharedTimeRange { from: model.time_range.from.clone(), to: model.time_range.to.clone() },
    };
    let variables = body.variables.unwrap_or_else(|| default_variables(&model));
    check_variables(&variables)?;
    resolve_variables(&model, &variables)?;
    let panels = shared_panels(&state, &ctx.org_id, &model).await?;
    if !sharing::may_query_all(&state, &ctx, &panel_sources(&panels)).await? {
        return Err(sources_forbidden());
    }
    let (token, token_hash) = sharing::new_token();
    let id = new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO public_links (id, org_id, dashboard_id, token_hash, created_by, created_at, expires_at, \
         max_window_ms, time_from, time_to, variables) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&token_hash)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(expires_at)
    .bind(max_window_ms)
    .bind(&range.from)
    .bind(&range.to)
    .bind(serde_json::to_string(&variables).map_err(internal)?)
    .execute(&mut *tx)
    .await?;
    let summary = json!({ "dashboardId": dashboard_id, "expiresAt": expires_at, "maxWindowMs": max_window_ms });
    let actor = audit_actor(&ctx, &info, now);
    audit(&mut tx, &actor, Some(&ctx.org_id), "public_link.created", ("public_link", &id), summary).await?;
    let row = fetch_link(&mut tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let link = row.view(true, (ShareStatus::Active, None))?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(CreatedPublicLink { link, token })))
}

async fn list_links(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<PublicLink>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let (creator, dashboard) = list_filter(&ctx, &q);
    let rows: Vec<LinkRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{LINK_COLUMNS} WHERE l.org_id = $1 AND (l.created_at < $2 OR (l.created_at = $2 AND l.id < $3)) \
         AND ($4 = '' OR l.created_by = $4) AND ($5 = '' OR l.dashboard_id = $5) \
         ORDER BY l.created_at DESC, l.id DESC LIMIT $6"
    )))
    .bind(&ctx.org_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(&creator)
    .bind(&dashboard)
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    let readable = readable_dashboards(&state, &ctx, rows.iter().map(|r| r.dashboard_id.as_str())).await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(row.view(readable.contains(&row.dashboard_id), link_status(&state, row).await?)?);
    }
    Ok(Json(paging.page(items, |l| (l.created_at, l.id.as_str()))))
}

/// A link the caller manages; someone else's does not exist for a member who cannot list it.
async fn managed_link(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, id: &str) -> ApiResult<LinkRow> {
    let row = fetch_link(conn, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    if !manages(ctx, row.created_by.as_deref()) {
        return Err(ApiError::not_found());
    }
    Ok(row)
}

async fn change_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<ChangeExpiry>,
) -> ApiResult<Json<PublicLink>> {
    let now = state.clock.now_ms();
    let expires_at = sharing::expiry(&state, Some(body.expires_at), now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let row = managed_link(&mut tx, &ctx, &id).await?;
    if let Some(status) = ended_status(row.revoked_at, row.expires_at, now) {
        return Err(ended(status));
    }
    sqlx::query("UPDATE public_links SET expires_at = $1 WHERE org_id = $2 AND id = $3")
        .bind(expires_at)
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let summary = json!({ "dashboardId": row.dashboard_id, "from": row.expires_at, "to": expires_at });
    let actor = audit_actor(&ctx, &info, now);
    audit(&mut tx, &actor, Some(&ctx.org_id), "public_link.expiry_changed", ("public_link", &id), summary).await?;
    let row = fetch_link(&mut tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    crate::db::commit(tx).await?;
    let readable = readable_dashboards(&state, &ctx, std::iter::once(row.dashboard_id.as_str())).await?;
    let status = link_status(&state, &row).await?;
    Ok(Json(row.view(!readable.is_empty(), status)?))
}

async fn revoke_link(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let row = managed_link(&mut tx, &ctx, &id).await?;
    if row.revoked_at.is_some() {
        return Err(ended(ShareStatus::Revoked));
    }
    sqlx::query("UPDATE public_links SET revoked_at = $1, revoked_by = $2 WHERE org_id = $3 AND id = $4")
        .bind(now)
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let summary = json!({ "dashboardId": row.dashboard_id, "createdBy": row.created_by, "views": row.views });
    let actor = audit_actor(&ctx, &info, now);
    audit(&mut tx, &actor, Some(&ctx.org_id), "public_link.revoked", ("public_link", &id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The headers of every public answer, refusals included: never kept by a browser or proxy,
/// never sent on as a referrer, never indexed.
fn public(answer: impl IntoResponse) -> Response {
    let mut res = answer.into_response();
    let headers = res.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(HeaderName::from_static("x-robots-tag"), HeaderValue::from_static("noindex"));
    res
}

/// The hash of a public token that exists, counted against the client address and the token; an
/// unknown one counts against the address alone and answers `unavailable`.
async fn known_token(state: &AppState, info: &RequestInfo, token: &str, sql: &'static str) -> ApiResult<String> {
    state.sharing.check_address(state, info)?;
    let found = match sharing::token_hash(token) {
        Some(hash) => {
            let (n,): (i64,) = sqlx::query_as(sql).bind(&hash).fetch_one(&state.db).await?;
            (n > 0).then_some(hash)
        }
        None => None,
    };
    let Some(hash) = found else {
        state.sharing.unknown(state, info);
        return Err(unavailable());
    };
    state.sharing.admit_known(state, info, &hash)?;
    Ok(hash)
}

const LINK_EXISTS: &str = "SELECT COUNT(*) FROM public_links WHERE token_hash = $1";
const SNAPSHOT_EXISTS: &str = "SELECT COUNT(*) FROM snapshots WHERE token_hash = $1 AND public = 1";

/// The link of `token` when it works now; `unavailable` for every other token, whatever the
/// reason.
async fn open_link(state: &AppState, info: &RequestInfo, token: &str) -> ApiResult<(LinkRow, OpenLink)> {
    let hash = known_token(state, info, token, LINK_EXISTS).await?;
    let row: Option<LinkRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{LINK_COLUMNS} WHERE l.token_hash = $1")))
        .bind(&hash)
        .fetch_optional(&state.db)
        .await?;
    let row = row.ok_or_else(unavailable)?;
    let open = evaluate_link(state, &row).await?.map_err(|_| unavailable())?;
    Ok((row, open))
}

async fn count_view(state: &AppState, sql: &'static str, id: &str) -> ApiResult<()> {
    sqlx::query(sql).bind(id).bind(state.clock.now_ms()).execute(&state.db).await?;
    Ok(())
}

const COUNT_LINK_VIEW: &str = "UPDATE public_links SET views = views + 1, last_viewed_at = $2 WHERE id = $1";
const COUNT_SNAPSHOT_VIEW: &str = "UPDATE snapshots SET views = views + 1, last_viewed_at = $2 WHERE id = $1";

async fn public_link(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(token): Path<String>,
) -> Response {
    public(link_page(&state, &info, &token).await)
}

async fn link_page(state: &AppState, info: &RequestInfo, token: &str) -> ApiResult<Json<PublicLinkView>> {
    let (row, link) = open_link(state, info, token).await?;
    count_view(state, COUNT_LINK_VIEW, &row.id).await?;
    let variables = current_variables(&link.model, &row.variables()?);
    Ok(Json(PublicLinkView {
        dashboard: sharing::public_dashboard(&link.model, &link.panels, &variables),
        time_range: row.time_range(),
        max_window_ms: row.max_window_ms,
        expires_at: row.expires_at,
    }))
}

async fn public_panel_query(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path((token, panel_id)): Path<(String, String)>,
    body: Result<JsonBody<PublicPanelQuery>, ApiError>,
) -> Response {
    public(match body {
        Ok(JsonBody(body)) => panel_answer(&state, &info, &token, &panel_id, body).await,
        Err(e) => Err(e),
    })
}

async fn panel_answer(
    state: &AppState,
    info: &RequestInfo,
    token: &str,
    panel_id: &str,
    body: PublicPanelQuery,
) -> ApiResult<Json<QueryResponse>> {
    let (row, link) = open_link(state, info, token).await?;
    let panel = link.panels.iter().find(|p| p.panel.id == panel_id).ok_or_else(unavailable)?;
    sharing::check_window(body.time_range, row.max_window_ms, state.clock.now_ms())?;
    let req = PanelQueryRequest {
        time_range: sharing::round_range(body.time_range),
        cursors: BTreeMap::new(),
        limit: None,
        interval_ms: None,
        max_data_points: None,
        variables: current_variables(&link.model, &row.variables()?),
        refresh: None,
    };
    let started = std::time::Instant::now();
    let response = match run_stored_panel(state, &link.ctx, &link.model, &panel.panel, req).await {
        Ok(response) => response,
        // A stored value that no longer fits the dashboard: the link is broken, not the request.
        Err(e) if e.status.is_client_error() => return Err(unavailable()),
        Err(e) => return Err(e),
    };
    let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let run = crate::usage::PanelRun::of(&response, ms);
    crate::usage::record_panel(state, &row.org_id, &row.dashboard_id, panel_id, run).await;
    let shown = sharing::shown_response(state, &panel.panel, response).await?;
    Ok(Json(public_response(shown)))
}

// Snapshots.

#[derive(sqlx::FromRow)]
struct SnapshotRow {
    id: String,
    org_id: String,
    dashboard_id: String,
    dashboard_title: String,
    title: String,
    public: i64,
    created_by: Option<String>,
    created_by_name: Option<String>,
    created_at: i64,
    expires_at: i64,
    range_from: i64,
    range_to: i64,
    size_bytes: i64,
    views: i64,
    last_viewed_at: Option<i64>,
    revoked_at: Option<i64>,
    datasource_ids: String,
}

const SNAPSHOT_COLUMNS: &str = "SELECT s.id, s.org_id, s.dashboard_id, d.title AS dashboard_title, s.title, \
     s.public, s.created_by, u.name AS created_by_name, s.created_at, s.expires_at, s.range_from, s.range_to, \
     s.size_bytes, s.views, s.last_viewed_at, s.revoked_at, s.datasource_ids FROM snapshots s \
     JOIN dashboards d ON d.id = s.dashboard_id LEFT JOIN users u ON u.id = s.created_by";

impl SnapshotRow {
    fn view(&self, readable: bool, status: Option<Closed>) -> SnapshotSummary {
        SnapshotSummary {
            id: self.id.clone(),
            dashboard_id: self.dashboard_id.clone(),
            dashboard_title: readable.then(|| self.dashboard_title.clone()),
            title: self.title.clone(),
            public: self.public != 0,
            created_by: self.created_by.clone(),
            created_by_name: self.created_by_name.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
            time_range: TimeRange { from: self.range_from, to: self.range_to },
            size_bytes: self.size_bytes,
            views: self.views,
            last_viewed_at: self.last_viewed_at,
            revoked_at: self.revoked_at,
            status: status.map(|s| s.0),
            suspended_reason: status.and_then(|s| s.1),
        }
    }
}

/// Where a snapshot stands. Only a public one can be suspended: an internal one is seen with the
/// viewer's own read right on the dashboard. A public one's creator is checked even when it was
/// revoked or has expired, so the time of the answer does not tell those apart.
async fn snapshot_status(state: &AppState, row: &SnapshotRow) -> ApiResult<Closed> {
    let ended = ended_status(row.revoked_at, row.expires_at, state.clock.now_ms());
    if row.public == 0 {
        return Ok(ended.map_or((ShareStatus::Active, None), |s| (s, None)));
    }
    let open = match sharing::creator_gate(state, &row.org_id, row.created_by.as_deref(), &row.dashboard_id).await? {
        Gate::Open(ctx, _) => {
            let sources: BTreeSet<String> = serde_json::from_str(&row.datasource_ids).map_err(internal)?;
            if sharing::may_query_all(state, &ctx, &sources).await? {
                (ShareStatus::Active, None)
            } else {
                (ShareStatus::Suspended, Some(SuspendedReason::CreatorRights))
            }
        }
        Gate::Suspended(reason) => (ShareStatus::Suspended, Some(reason)),
    };
    Ok(ended.map_or(open, |s| (s, None)))
}

/// The status of `row` for `ctx`: only its creator and the organization's admins see it.
async fn status_for(state: &AppState, ctx: &OrgCtx, row: &SnapshotRow) -> ApiResult<Option<Closed>> {
    if manages(ctx, row.created_by.as_deref()) { Ok(Some(snapshot_status(state, row).await?)) } else { Ok(None) }
}

async fn fetch_snapshot(conn: &mut sqlx::AnyConnection, org_id: &str, id: &str) -> ApiResult<Option<SnapshotRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{SNAPSHOT_COLUMNS} WHERE s.org_id = $1 AND s.id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

fn too_large(max: usize) -> ApiError {
    ApiError::validation(format!("the snapshot would be larger than {max} bytes"))
        .because("sharing.snapshot_too_large")
        .param("max", max)
}

async fn create_snapshot(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    caller: Option<Extension<TokenCaller>>,
    Path((_, dashboard_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<CreateSnapshot>,
) -> ApiResult<(StatusCode, Json<CreatedSnapshot>)> {
    let now = state.clock.now_ms();
    if body.public {
        // Only a signed-in person publishes: an API token is no one to answer for it.
        refuse_tokens(caller.as_deref())?;
    }
    let model = readable_model(&state, &ctx, &dashboard_id).await?;
    if body.public {
        ctx.check(Permission::DashboardsPublic)?;
        if !sharing::public_enabled(&state, &ctx.org_id).await? {
            return Err(public_off());
        }
    } else {
        check_resource(&state.db, &ctx, Permission::DashboardsShare, Resource::Dashboard(&dashboard_id)).await?;
    }
    let title = match &body.title {
        Some(raw) => super::clean_name(raw, "title")?,
        None => model.title.clone(),
    };
    crate::datasources::check_range(body.time_range)?;
    let expires_at = sharing::expiry(&state, body.expires_at, now).await?;
    let variables = body.variables.clone().unwrap_or_else(|| default_variables(&model));
    check_variables(&variables)?;
    resolve_variables(&model, &variables)?;
    let panels = shared_panels(&state, &ctx.org_id, &model).await?;
    let sources = panel_sources(&panels);
    if body.public && !sharing::may_query_all(&state, &ctx, &sources).await? {
        return Err(sources_forbidden());
    }
    let max = sharing::snapshot_max_bytes(&state).await?;
    let dashboard = serde_json::to_string(&sharing::public_dashboard(&model, &panels, &variables)).map_err(internal)?;
    let mut size = dashboard.len();
    if size > max {
        return Err(too_large(max));
    }
    // The answers by panel id, written out as they come so the size is known before the next runs.
    let mut results = String::from("{");
    for p in panels.iter().filter(|p| !p.panel.targets.is_empty()) {
        // Each value takes at least two bytes of JSON, so a query never needs more rows than half
        // of what is left: one panel cannot hold more than the cap in memory.
        let rows = u32::try_from((max - size) / 2).unwrap_or(u32::MAX).max(1);
        let req = PanelQueryRequest {
            time_range: body.time_range,
            cursors: BTreeMap::new(),
            limit: Some(rows),
            interval_ms: None,
            max_data_points: None,
            variables: variables.clone(),
            refresh: None,
        };
        let response = run_stored_panel(&state, &ctx, &model, &p.panel, req).await?;
        let response = public_response(sharing::shown_response(&state, &p.panel, response).await?);
        let key = serde_json::to_string(&p.panel.id).map_err(internal)?;
        let text = serde_json::to_string(&response).map_err(internal)?;
        size += key.len() + text.len() + 2;
        if size > max {
            return Err(too_large(max));
        }
        if results.len() > 1 {
            results.push(',');
        }
        results.push_str(&key);
        results.push(':');
        results.push_str(&text);
    }
    results.push('}');
    let size_bytes = i64::try_from(dashboard.len() + results.len()).unwrap_or(i64::MAX);
    let (token, token_hash) = if body.public {
        let (token, hash) = sharing::new_token();
        (Some(token), Some(hash))
    } else {
        (None, None)
    };
    let id = new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO snapshots (id, org_id, dashboard_id, title, public, token_hash, created_by, created_at, \
         expires_at, range_from, range_to, model, results, datasource_ids, size_bytes) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&title)
    .bind(i64::from(body.public))
    .bind(token_hash.as_deref())
    .bind(&ctx.user.id)
    .bind(now)
    .bind(expires_at)
    .bind(body.time_range.from)
    .bind(body.time_range.to)
    .bind(&dashboard)
    .bind(&results)
    .bind(serde_json::to_string(&sources).map_err(internal)?)
    .bind(size_bytes)
    .execute(&mut *tx)
    .await?;
    let summary = json!({ "dashboardId": dashboard_id, "public": body.public, "expiresAt": expires_at,
                          "sizeBytes": size_bytes });
    let actor = audit_actor(&ctx, &info, now);
    audit(&mut tx, &actor, Some(&ctx.org_id), "snapshot.created", ("snapshot", &id), summary).await?;
    let row = fetch_snapshot(&mut tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let snapshot = row.view(true, Some((ShareStatus::Active, None)));
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(CreatedSnapshot { snapshot, token })))
}

/// One page of snapshots. `open_only` leaves out revoked and expired ones (the per-dashboard list
/// readers see).
async fn snapshot_page(
    state: &AppState,
    ctx: &OrgCtx,
    paging: &Paging,
    creator: &str,
    dashboard: &str,
    open_only: bool,
) -> ApiResult<Page<SnapshotSummary>> {
    let open = if open_only { "AND s.revoked_at IS NULL AND s.expires_at > $7" } else { "AND $7 = $7" };
    let rows: Vec<SnapshotRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SNAPSHOT_COLUMNS} WHERE s.org_id = $1 AND (s.created_at < $2 OR (s.created_at = $2 AND s.id < $3)) \
         AND ($4 = '' OR s.created_by = $4) AND ($5 = '' OR s.dashboard_id = $5) {open} \
         ORDER BY s.created_at DESC, s.id DESC LIMIT $6"
    )))
    .bind(&ctx.org_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(creator)
    .bind(dashboard)
    .bind(paging.fetch_limit())
    .bind(state.clock.now_ms())
    .fetch_all(&state.db)
    .await?;
    let readable = readable_dashboards(state, ctx, rows.iter().map(|r| r.dashboard_id.as_str())).await?;
    let mut items = Vec::with_capacity(rows.len());
    for row in &rows {
        items.push(row.view(readable.contains(&row.dashboard_id), status_for(state, ctx, row).await?));
    }
    Ok(paging.page(items, |s: &SnapshotSummary| (s.created_at, s.id.as_str())))
}

async fn list_snapshots(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<SnapshotSummary>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let (creator, dashboard) = list_filter(&ctx, &q);
    Ok(Json(snapshot_page(&state, &ctx, &paging, &creator, &dashboard, false).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DashboardListQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

/// The open snapshots of one dashboard, for everyone who may read it: what they could open.
async fn dashboard_snapshots(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id)): Path<(String, String)>,
    QueryParams(q): QueryParams<DashboardListQuery>,
) -> ApiResult<Json<Page<SnapshotSummary>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    if !crate::authz::resource_exists(&state.db, &ctx.org_id, Resource::Dashboard(&dashboard_id)).await? {
        return Err(ApiError::not_found());
    }
    check_resource(&state.db, &ctx, Permission::DashboardsRead, Resource::Dashboard(&dashboard_id)).await?;
    Ok(Json(snapshot_page(&state, &ctx, &paging, "", &dashboard_id, true).await?))
}

async fn get_snapshot(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<SnapshotView>> {
    let now = state.clock.now_ms();
    let row =
        fetch_snapshot(&mut *state.db.acquire().await?, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    if ended_status(row.revoked_at, row.expires_at, now).is_some() {
        return Err(ApiError::not_found());
    }
    check_resource(&state.db, &ctx, Permission::DashboardsRead, Resource::Dashboard(&row.dashboard_id)).await?;
    let (dashboard, results): (String, String) =
        sqlx::query_as("SELECT model, results FROM snapshots WHERE org_id = $1 AND id = $2")
            .bind(&ctx.org_id)
            .bind(&id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(ApiError::not_found)?;
    count_view(&state, COUNT_SNAPSHOT_VIEW, &id).await?;
    let status = status_for(&state, &ctx, &row).await?;
    Ok(Json(SnapshotView { snapshot: row.view(true, status), dashboard: raw(dashboard)?, results: raw(results)? }))
}

/// A snapshot the caller manages. Members who may read the dashboard see its snapshots, but
/// change and revoke only their own.
async fn managed_snapshot(
    state: &AppState,
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    id: &str,
) -> ApiResult<SnapshotRow> {
    let row = fetch_snapshot(conn, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    if !manages(ctx, row.created_by.as_deref()) {
        let readable = readable_dashboards(state, ctx, std::iter::once(row.dashboard_id.as_str())).await?;
        return Err(if readable.is_empty() {
            ApiError::not_found()
        } else {
            ApiError::forbidden("only its creator or an organization admin changes or revokes a snapshot")
        });
    }
    Ok(row)
}

async fn change_snapshot(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<ChangeExpiry>,
) -> ApiResult<Json<SnapshotSummary>> {
    let now = state.clock.now_ms();
    let expires_at = sharing::expiry(&state, Some(body.expires_at), now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let row = managed_snapshot(&state, &mut tx, &ctx, &id).await?;
    if let Some(status) = ended_status(row.revoked_at, row.expires_at, now) {
        return Err(ended(status));
    }
    sqlx::query("UPDATE snapshots SET expires_at = $1 WHERE org_id = $2 AND id = $3")
        .bind(expires_at)
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let summary = json!({ "dashboardId": row.dashboard_id, "from": row.expires_at, "to": expires_at });
    let actor = audit_actor(&ctx, &info, now);
    audit(&mut tx, &actor, Some(&ctx.org_id), "snapshot.expiry_changed", ("snapshot", &id), summary).await?;
    let row = fetch_snapshot(&mut tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    crate::db::commit(tx).await?;
    let readable = readable_dashboards(&state, &ctx, std::iter::once(row.dashboard_id.as_str())).await?;
    let status = snapshot_status(&state, &row).await?;
    Ok(Json(row.view(!readable.is_empty(), Some(status))))
}

async fn revoke_snapshot(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let row = managed_snapshot(&state, &mut tx, &ctx, &id).await?;
    if row.revoked_at.is_some() {
        return Err(ended(ShareStatus::Revoked));
    }
    // The frozen results go at once: nobody can open them again. The row stays listed until the
    // cleanup deletes it.
    sqlx::query("UPDATE snapshots SET revoked_at = $1, revoked_by = $2, results = '{}' WHERE org_id = $3 AND id = $4")
        .bind(now)
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    let summary = json!({ "dashboardId": row.dashboard_id, "public": row.public != 0, "createdBy": row.created_by,
                          "views": row.views });
    let actor = audit_actor(&ctx, &info, now);
    audit(&mut tx, &actor, Some(&ctx.org_id), "snapshot.revoked", ("snapshot", &id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn public_snapshot(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(token): Path<String>,
) -> Response {
    public(public_snapshot_page(&state, &info, &token).await)
}

async fn public_snapshot_page(
    state: &AppState,
    info: &RequestInfo,
    token: &str,
) -> ApiResult<Json<PublicSnapshotView>> {
    let hash = known_token(state, info, token, SNAPSHOT_EXISTS).await?;
    let row: Option<SnapshotRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SNAPSHOT_COLUMNS} WHERE s.token_hash = $1 AND s.public = 1")))
            .bind(&hash)
            .fetch_optional(&state.db)
            .await?;
    let row = row.ok_or_else(unavailable)?;
    if snapshot_status(state, &row).await?.0 != ShareStatus::Active {
        return Err(unavailable());
    }
    let (dashboard, results): (String, String) = sqlx::query_as("SELECT model, results FROM snapshots WHERE id = $1")
        .bind(&row.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(unavailable)?;
    count_view(state, COUNT_SNAPSHOT_VIEW, &row.id).await?;
    Ok(Json(PublicSnapshotView {
        title: row.title,
        time_range: TimeRange { from: row.range_from, to: row.range_to },
        created_at: row.created_at,
        expires_at: row.expires_at,
        dashboard: raw(dashboard)?,
        results: raw(results)?,
    }))
}
