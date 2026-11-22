//! The numbers on the administration's overview (docs/api/access.md, "Administration
//! overview"): how many members, teams, roles and service accounts the organization has and, for
//! server administrators, how many people and organizations the server has.
//!
//! One request instead of one list per row. Each number is only filled in when the caller may
//! open the section it stands for, by the same permission that section's own list route checks;
//! the others are left out of the answer.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::Serialize;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{Access, BuiltinRole, OrgCtx, Permission};
use crate::error::ApiResult;

pub fn routes() -> Vec<RouteDef> {
    vec![route(Method::GET, "/orgs/{orgId}/admin/summary", Access::OrgMember, summary)]
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdminSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    members: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    teams: Option<i64>,
    /// The fixed roles and the organization's own.
    #[serde(skip_serializing_if = "Option::is_none")]
    roles: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_accounts: Option<i64>,
    /// People on the server (service accounts belong to their organization and are not counted).
    #[serde(skip_serializing_if = "Option::is_none")]
    users: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orgs: Option<i64>,
}

async fn count(state: &AppState, sql: &'static str, org_id: Option<&str>) -> ApiResult<i64> {
    let query = sqlx::query_as::<_, (i64,)>(sql);
    let query = match org_id {
        Some(org_id) => query.bind(org_id.to_owned()),
        None => query,
    };
    let (n,) = query.fetch_one(&state.read_db).await?;
    Ok(n)
}

async fn summary(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<AdminSummary>> {
    let may = |permission: Permission| ctx.permissions.contains(&permission);
    let org = Some(ctx.org_id.as_str());
    let mut out = AdminSummary::default();
    if may(Permission::UsersRead) {
        out.members = Some(
            count(
                &state,
                "SELECT COUNT(*) FROM org_members m JOIN users u ON u.id = m.user_id \
                 WHERE m.org_id = $1 AND u.service_account = 0",
                org,
            )
            .await?,
        );
    }
    if may(Permission::TeamsRead) {
        out.teams = Some(count(&state, "SELECT COUNT(*) FROM teams WHERE org_id = $1", org).await?);
    }
    if may(Permission::RolesRead) {
        let custom = count(&state, "SELECT COUNT(*) FROM roles WHERE org_id = $1", org).await?;
        out.roles = Some(BuiltinRole::ALL.len() as i64 + custom);
    }
    if may(Permission::ServiceAccountsWrite) {
        out.service_accounts = Some(
            count(
                &state,
                "SELECT COUNT(*) FROM service_accounts a \
                 JOIN org_members m ON m.org_id = a.org_id AND m.user_id = a.id WHERE a.org_id = $1",
                org,
            )
            .await?,
        );
    }
    if ctx.user.is_server_admin != 0 {
        out.users = Some(count(&state, "SELECT COUNT(*) FROM users WHERE service_account = 0", None).await?);
        out.orgs = Some(count(&state, "SELECT COUNT(*) FROM orgs", None).await?);
    }
    Ok(Json(out))
}
