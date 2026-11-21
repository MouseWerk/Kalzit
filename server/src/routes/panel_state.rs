//! A viewer's own state of a graph panel on a dashboard: the nodes they pinned and the ones they
//! selected while exploring it, where they dragged pinned nodes to, and what they hid
//! (docs/api/dashboard-features.md, "Panel view state"). It belongs to the caller alone and
//! changes neither the panel nor its query.
//!
//! Only node and edge ids and positions are stored, never a node's properties or any other part
//! of a result. Reading
//! and writing need read access to the dashboard, and the panel must be one of its panels; a
//! dashboard the caller cannot read answers like one that does not exist.

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, OrgCtx};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;

/// Ids kept per list (pinned, selected, positions, hidden, hidden edges, released).
pub const MAX_IDS: usize = 200;
/// Longest node id, in characters (Neo4j element ids are about 50).
pub const MAX_ID_CHARS: usize = 512;
/// Largest coordinate of a kept position, either way from zero: far beyond any layout, and small
/// enough that the number survives JSON and a 32-bit float in the renderer.
pub const MAX_COORDINATE: f64 = 1.0e9;
/// Longest panel id in the path, in characters.
const MAX_PANEL_ID_CHARS: usize = 100;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    let path = "/orgs/{orgId}/dashboards/{dashboardId}/panels/{panelId}/view-state";
    vec![
        route(Method::GET, path, OrgMember, get_state),
        route(Method::PUT, path, OrgMember, put_state),
        route(Method::DELETE, path, OrgMember, delete_state),
    ]
}

/// Where a viewer dragged a pinned node to, in the drawing's own units.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub id: String,
    pub x: f64,
    pub y: f64,
}

/// What a viewer keeps of a panel: node ids, in the order they were pinned or selected, the
/// positions of pinned nodes they dragged, the nodes and edges they hid, and the panel's own
/// pinned nodes they released. The lists added in 0.8.1 are left out of an answer while empty, so
/// a state kept before them reads and answers as it did.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewState {
    #[serde(default)]
    pub pinned: Vec<String>,
    #[serde(default)]
    pub selected: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub positions: Vec<Position>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_edges: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub released: Vec<String>,
}

impl ViewState {
    fn is_empty(&self) -> bool {
        self.pinned.is_empty()
            && self.selected.is_empty()
            && self.positions.is_empty()
            && self.hidden.is_empty()
            && self.hidden_edges.is_empty()
            && self.released.is_empty()
    }

    /// Every list within its bounds; the error names the list.
    fn check(&self) -> ApiResult<()> {
        check_ids("pinned", &self.pinned)?;
        check_ids("selected", &self.selected)?;
        check_positions(&self.positions)?;
        check_ids("hidden", &self.hidden)?;
        check_ids("hiddenEdges", &self.hidden_edges)?;
        check_ids("released", &self.released)
    }
}

fn check_ids(name: &'static str, ids: &[String]) -> ApiResult<()> {
    if ids.len() > MAX_IDS {
        return Err(ApiError::validation(format!("{name} takes at most {MAX_IDS} ids")).with_field(name));
    }
    for id in ids {
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS || id.chars().any(char::is_control) {
            return Err(ApiError::validation(format!(
                "{name} takes ids of 1 to {MAX_ID_CHARS} characters without control characters"
            ))
            .with_field(name));
        }
    }
    let mut seen = std::collections::HashSet::new();
    if !ids.iter().all(|id| seen.insert(id.as_str())) {
        return Err(ApiError::validation(format!("{name} names each id once")).with_field(name));
    }
    Ok(())
}

/// Positions are bounded like the id lists, one per node, with finite coordinates.
fn check_positions(positions: &[Position]) -> ApiResult<()> {
    let ids: Vec<String> = positions.iter().map(|p| p.id.clone()).collect();
    check_ids("positions", &ids)?;
    let within = |v: f64| v.is_finite() && v.abs() <= MAX_COORDINATE;
    if !positions.iter().all(|p| within(p.x) && within(p.y)) {
        return Err(ApiError::validation("positions takes coordinates within 1e9 of zero").with_field("positions"));
    }
    Ok(())
}

/// The dashboard must be readable by the caller and hold the panel; anything else is not found.
async fn check_panel(state: &AppState, ctx: &OrgCtx, dashboard_id: &str, panel_id: &str) -> ApiResult<()> {
    if panel_id.is_empty() || panel_id.chars().count() > MAX_PANEL_ID_CHARS {
        return Err(ApiError::not_found());
    }
    let model = super::query::readable_model(state, ctx, dashboard_id)
        .await
        .map_err(|e| if e.code == "forbidden" { ApiError::not_found() } else { e })?;
    if !model.panels.iter().any(|p| p.id == panel_id) {
        return Err(ApiError::not_found());
    }
    Ok(())
}

/// The caller's state of the panel; empty lists when they kept none.
async fn get_state(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
) -> ApiResult<Json<ViewState>> {
    check_panel(&state, &ctx, &dashboard_id, &panel_id).await?;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT state FROM panel_view_state WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3 AND panel_id = $4",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&panel_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(row.map(|(raw,)| read_kept(&raw)).unwrap_or_default()))
}

/// A kept row as the caller gets it: one this server cannot read (written by hand, or beyond the
/// bounds) counts as none.
fn read_kept(raw: &str) -> ViewState {
    serde_json::from_str::<ViewState>(raw).ok().filter(|kept| kept.check().is_ok()).unwrap_or_default()
}

/// Replaces the caller's state of the panel. Empty lists remove it.
async fn put_state(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
    JsonBody(body): JsonBody<ViewState>,
) -> ApiResult<Json<ViewState>> {
    body.check()?;
    check_panel(&state, &ctx, &dashboard_id, &panel_id).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "DELETE FROM panel_view_state WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3 AND panel_id = $4",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&panel_id)
    .execute(&mut *tx)
    .await?;
    if !body.is_empty() {
        let text = serde_json::to_string(&body).map_err(|e| ApiError::internal("panel view state", e))?;
        sqlx::query(
            "INSERT INTO panel_view_state (user_id, org_id, dashboard_id, panel_id, state, updated_at) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(&dashboard_id)
        .bind(&panel_id)
        .bind(text)
        .bind(state.clock.now_ms())
        .execute(&mut *tx)
        .await?;
    }
    crate::db::commit(tx).await?;
    Ok(Json(body))
}

/// Forgets the caller's state of the panel; also of a dashboard they can no longer read, and
/// without an answer that tells whether there was one.
async fn delete_state(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, dashboard_id, panel_id)): Path<(String, String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "DELETE FROM panel_view_state WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3 AND panel_id = $4",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&dashboard_id)
    .bind(&panel_id)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_bounded() {
        assert!(check_ids("pinned", &[]).is_ok());
        assert!(check_ids("pinned", &["4:abc:1".into(), "12".into()]).is_ok());
        assert!(check_ids("pinned", &vec!["x".to_string(); 2]).is_err(), "each id once");
        let many: Vec<String> = (0..=MAX_IDS).map(|i| i.to_string()).collect();
        assert!(check_ids("pinned", &many).is_err());
        assert!(check_ids("selected", &[String::new()]).is_err());
        assert!(check_ids("selected", &["a\nb".into()]).is_err());
        assert!(check_ids("selected", &["x".repeat(MAX_ID_CHARS + 1)]).is_err());
        assert!(check_ids("selected", &["x".repeat(MAX_ID_CHARS)]).is_ok());
    }

    fn at(id: &str, x: f64, y: f64) -> Position {
        Position { id: id.into(), x, y }
    }

    #[test]
    fn positions_are_bounded() {
        assert!(check_positions(&[]).is_ok());
        assert!(check_positions(&[at("a", -12.5, 3.0)]).is_ok());
        assert!(check_positions(&[at("b", MAX_COORDINATE, -MAX_COORDINATE)]).is_ok());
        assert!(check_positions(&[at("a", 0.0, 0.0), at("a", 1.0, 1.0)]).is_err(), "each node once");
        assert!(check_positions(&[at("", 0.0, 0.0)]).is_err());
        assert!(check_positions(&[at("a", f64::NAN, 0.0)]).is_err());
        assert!(check_positions(&[at("a", 0.0, f64::INFINITY)]).is_err());
        assert!(check_positions(&[at("a", MAX_COORDINATE * 2.0, 0.0)]).is_err());
        let many: Vec<Position> = (0..=MAX_IDS).map(|i| at(&i.to_string(), 0.0, 0.0)).collect();
        assert!(check_positions(&many).is_err());
    }

    #[test]
    fn a_kept_row_beyond_the_bounds_or_unreadable_reads_as_empty() {
        let crowd: Vec<String> = (0..=MAX_IDS).map(|i| format!("\"{i}\"")).collect();
        let too_many = format!(r#"{{"pinned":[],"selected":[],"hidden":[{}]}}"#, crowd.join(","));
        assert!(read_kept(&too_many).is_empty(), "more hidden ids than a write may send");
        assert!(read_kept(r#"{"pinned":["a","a"],"selected":[]}"#).is_empty(), "an id twice");
        assert!(read_kept(r#"{"positions":[{"id":"a","x":1e12,"y":0}]}"#).is_empty());
        assert!(read_kept("not json").is_empty());
        assert_eq!(read_kept(r#"{"pinned":["a"],"selected":[]}"#).pinned, ["a"]);
    }

    #[test]
    fn a_state_kept_before_the_new_lists_reads_and_answers_as_it_did() {
        let old: ViewState = serde_json::from_str(r#"{"pinned":["a"],"selected":[]}"#).unwrap();
        assert!(old.check().is_ok());
        assert_eq!(serde_json::to_string(&old).unwrap(), r#"{"pinned":["a"],"selected":[]}"#);
        let text = r#"{"pinned":["a"],"positions":[{"id":"a","x":1.5,"y":-2}],"hidden":["b"],"released":["c"]}"#;
        let new: ViewState = serde_json::from_str(text).unwrap();
        assert!(new.check().is_ok());
        assert!(!new.is_empty());
        assert_eq!(new.positions, [at("a", 1.5, -2.0)]);
        let extra = r#"{"positions":[{"id":"a","x":1,"y":2,"z":3}]}"#;
        assert!(serde_json::from_str::<ViewState>(extra).is_err());
        assert!(ViewState::default().is_empty());
        let only_hidden: ViewState = serde_json::from_str(r#"{"hiddenEdges":["e1"]}"#).unwrap();
        assert!(!only_hidden.is_empty(), "hidden edges alone are kept");
    }
}
