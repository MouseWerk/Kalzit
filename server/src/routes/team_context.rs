//! The team context of the sidebar: which team a member works in, per organization
//! (docs/api/access.md, "Team spaces"). It scopes lists (`?team=` on the folder tree, the
//! dashboard list and the start page lists) and names where new dashboards go. It is a view, not
//! a right: access is decided by `authz` as always, and the team is checked against the member's
//! teams on every use.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{TeamScope, Tree};
use crate::settings;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/orgs/{orgId}/team-context", Access::OrgMember, get),
        route(Method::PUT, "/orgs/{orgId}/team-context", Access::OrgMember, put),
    ]
}

/// A team the caller may pick: their own teams, and for org admins every team.
struct Choice {
    id: String,
    name: String,
    member: bool,
}

/// The teams the caller may pick, members' teams first by name, then the rest by name.
async fn choices(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx) -> ApiResult<Vec<Choice>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT t.id, t.name, (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id AND m.user_id = $2) \
         FROM teams t WHERE t.org_id = $1",
    )
    .bind(&ctx.org_id)
    .bind(&ctx.user.id)
    .fetch_all(&mut *conn)
    .await?;
    let every = authz::role_sees_restricted(&ctx.permissions);
    let mut out: Vec<Choice> = rows
        .into_iter()
        .filter(|(_, _, member)| every || *member > 0)
        .map(|(id, name, member)| Choice { id, name, member: member > 0 })
        .collect();
    out.sort_by(|a, b| {
        b.member.cmp(&a.member).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then(a.id.cmp(&b.id))
    });
    Ok(out)
}

/// The scope of a list for `team` (`None`: no team context, everything the caller sees). A team
/// that is not one of the caller's (or any team, for org admins) is refused.
pub async fn scope(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, team: Option<&str>) -> ApiResult<Option<TeamScope>> {
    let Some(team) = team else { return Ok(None) };
    if !choices(conn, ctx).await?.iter().any(|c| c.id == team) {
        return Err(ApiError::validation("the team is not one of yours").with_field("team"));
    }
    Ok(Some(TeamScope::load(conn, &ctx.org_id, team).await?))
}

/// The team the caller works in: their stored choice while it is still one they may pick, else
/// the first of their own teams; `None` for all areas (chosen, or without a team).
async fn current(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, choices: &[Choice]) -> ApiResult<Option<String>> {
    let stored: Option<(Option<String>,)> =
        sqlx::query_as("SELECT team_id FROM team_contexts WHERE user_id = $1 AND org_id = $2")
            .bind(&ctx.user.id)
            .bind(&ctx.org_id)
            .fetch_optional(&mut *conn)
            .await?;
    let first = || choices.iter().find(|c| c.member).map(|c| c.id.clone());
    Ok(match stored {
        Some((None,)) => None,
        Some((Some(team),)) if choices.iter().any(|c| c.id == team) => Some(team),
        _ => first(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    id: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamChoice {
    id: String,
    name: String,
    /// The caller is a member (org admins also see teams they are not in).
    member: bool,
    /// The team's spaces the caller sees, by name.
    spaces: Vec<Space>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamContext {
    /// The team the caller works in; `null` for all areas.
    team_id: Option<String>,
    teams: Vec<TeamChoice>,
    /// Where "New dashboard" puts a dashboard: the active team's first space when the
    /// organization setting `dashboards.new_in_team_space` is on and the caller may create
    /// dashboards there; `null` for the default place.
    default_folder_id: Option<String>,
}

async fn answer(state: &AppState, ctx: &OrgCtx) -> ApiResult<TeamContext> {
    let new_in_space = settings::get_org(state, &ctx.org_id, "dashboards.new_in_team_space").await?.as_bool();
    let mut conn = state.db.acquire().await?;
    let choices = choices(&mut conn, ctx).await?;
    let team_id = current(&mut conn, ctx, &choices).await?;
    let tree = Tree::load(&mut conn, ctx).await?;
    let index = AccessIndex::load(&mut conn, ctx).await?;
    let mut spaces: Vec<(&str, &str, &str)> = tree
        .rows
        .values()
        .filter(|r| r.parent_id.is_none() && r.restricted != 0 && r.deleted_at.is_none() && tree.visible(&r.id))
        .filter_map(|r| r.owner_team_id.as_deref().map(|team| (team, r.name.as_str(), r.id.as_str())))
        .collect();
    spaces.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then(a.2.cmp(b.2)));
    let default_folder_id = match (&team_id, new_in_space) {
        (Some(team), Some(true)) => spaces
            .iter()
            .filter(|(owner, _, _)| owner == team)
            .find(|(_, _, id)| index.folder(id).is_some_and(|held| held.contains(&Permission::DashboardsWrite)))
            .map(|(_, _, id)| id.to_string()),
        _ => None,
    };
    let teams = choices
        .into_iter()
        .map(|c| TeamChoice {
            spaces: spaces
                .iter()
                .filter(|(owner, _, _)| *owner == c.id)
                .map(|(_, name, id)| Space { id: id.to_string(), name: name.to_string() })
                .collect(),
            id: c.id,
            name: c.name,
            member: c.member,
        })
        .collect();
    Ok(TeamContext { team_id, teams, default_folder_id })
}

async fn get(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<TeamContext>> {
    Ok(Json(answer(&state, &ctx).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PutRequest {
    /// A team the caller may pick, or `null` for all areas.
    team_id: Option<String>,
}

async fn put(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(body): JsonBody<PutRequest>,
) -> ApiResult<Json<TeamContext>> {
    if let Some(team) = body.team_id.as_deref()
        && !choices(&mut *state.db.acquire().await?, &ctx).await?.iter().any(|c| c.id == team)
    {
        return Err(ApiError::validation("the team is not one of yours").with_field("teamId"));
    }
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO team_contexts (user_id, org_id, team_id, updated_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (user_id, org_id) DO UPDATE SET team_id = excluded.team_id, updated_at = excluded.updated_at",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(body.team_id.as_deref())
    .bind(state.clock.now_ms())
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer(&state, &ctx).await?))
}
