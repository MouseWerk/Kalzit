//! Grants on folders, dashboards and data sources, and the "why can I do this" answer
//! (docs/api/access.md, "Grants" and "Explain").

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, Paging, QueryParams, audit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{
    Access, GrantSource, OrgCtx, Permission, Resource, ResourceType, ensure_holds, explain, level_permissions,
    resolve_role, resource_exists, resource_permissions,
};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    // The permission depends on the resource type (folders:permissions, dashboards:share,
    // datasources:permissions) and may come from a grant on the resource, so the handlers check
    // it per resource.
    vec![
        route(Method::GET, "/orgs/{orgId}/grants", Access::OrgMember, list),
        route(Method::POST, "/orgs/{orgId}/grants", Access::OrgMember, create),
        route(Method::DELETE, "/orgs/{orgId}/grants/{grantId}", Access::OrgMember, delete),
        route(Method::GET, "/orgs/{orgId}/explain", Access::OrgMember, explain_permission),
    ]
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    id: String,
    /// `user`, `team` or `role`.
    subject_type: String,
    /// A user id, team id, built-in role name or custom role id.
    subject_id: String,
    /// The user's, team's or role's name, for display.
    subject_name: String,
    resource_type: String,
    resource_id: String,
    level: String,
    created_at: i64,
}

const GRANT_COLUMNS: &str = "SELECT g.id, g.subject_type, g.subject_id, \
     COALESCE(u.name, t.name, r.name, g.subject_id) AS subject_name, g.resource_type, g.resource_id, g.level, \
     g.created_at FROM resource_grants g \
     LEFT JOIN users u ON g.subject_type = 'user' AND u.id = g.subject_id \
     LEFT JOIN teams t ON g.subject_type = 'team' AND t.id = g.subject_id \
     LEFT JOIN roles r ON g.subject_type = 'role' AND r.id = g.subject_id";

fn parse_resource_type(raw: &str, field: &'static str) -> ApiResult<ResourceType> {
    ResourceType::parse(raw)
        .ok_or_else(|| ApiError::validation("resource type must be folder, dashboard or datasource").with_field(field))
}

/// Ids are canonical UUIDs; anything else cannot exist and needs no lookup.
fn is_uuid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).map(|u| u.hyphenated().to_string()).ok().as_deref() == Some(id)
}

/// The caller's permissions on a resource of the organization, after checking that it exists,
/// that they see it and that they may manage its grants.
async fn managed_resource(
    state: &AppState,
    ctx: &OrgCtx,
    resource: Resource<'_>,
) -> ApiResult<std::collections::BTreeSet<Permission>> {
    if !is_uuid(resource.id()) || !resource_exists(&state.db, &ctx.org_id, resource).await? {
        return Err(ApiError::not_found());
    }
    let held = resource_permissions(&state.db, ctx, resource).await?.ok_or_else(ApiError::not_found)?;
    let manage = resource.resource_type().manage_permission();
    if !held.contains(&manage) {
        return Err(ApiError::forbidden(format!("missing permission {}", manage.as_str())));
    }
    Ok(held)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListQuery {
    resource_type: Option<String>,
    resource_id: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// The grants on exactly this resource, newest first; grants inherited from folders above it are
/// listed on those folders.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Grant>>> {
    let resource_type = parse_resource_type(q.resource_type.as_deref().unwrap_or_default(), "resourceType")?;
    let resource_id =
        q.resource_id.ok_or_else(|| ApiError::validation("resourceId is required").with_field("resourceId"))?;
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    managed_resource(&state, &ctx, Resource::new(resource_type, &resource_id)).await?;
    let rows: Vec<Grant> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{GRANT_COLUMNS} WHERE g.org_id = $1 AND g.resource_type = $2 AND g.resource_id = $3 \
         AND (g.created_at < $4 OR (g.created_at = $4 AND g.id < $5)) ORDER BY g.created_at DESC, g.id DESC LIMIT $6"
    )))
    .bind(&ctx.org_id)
    .bind(resource_type.as_str())
    .bind(&resource_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(paging.page(rows, |g| (g.created_at, g.id.as_str()))))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateRequest {
    subject_type: String,
    subject_id: String,
    resource_type: String,
    resource_id: String,
    level: String,
}

/// The subject exists in the organization: a member, a team or a role.
async fn ensure_subject(conn: &mut sqlx::AnyConnection, org_id: &str, kind: &str, id: &str) -> ApiResult<()> {
    let found = match kind {
        "user" => sqlx::query_as::<_, (String,)>("SELECT user_id FROM org_members WHERE org_id = $1 AND user_id = $2")
            .bind(org_id)
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
        "team" => sqlx::query_as::<_, (String,)>("SELECT id FROM teams WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
        "role" => resolve_role(&mut *conn, org_id, id).await?.is_some(),
        _ => return Err(ApiError::validation("subject type must be user, team or role").with_field("subjectType")),
    };
    if found { Ok(()) } else { Err(ApiError::validation("no such user, team or role here").with_field("subjectId")) }
}

/// Creates the grant, or changes its level when the subject already has one on the resource
/// (one grant per subject and resource).
async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<CreateRequest>,
) -> ApiResult<(StatusCode, Json<Grant>)> {
    let resource_type = parse_resource_type(&req.resource_type, "resourceType")?;
    let mut level_set = level_permissions(resource_type, &req.level).ok_or_else(|| {
        let levels = resource_type.levels().join(", ");
        ApiError::validation(format!("level must be one of {levels} for a {}", resource_type.as_str()))
            .with_field("level")
    })?;
    let resource = Resource::new(resource_type, &req.resource_id);
    let held = managed_resource(&state, &ctx, resource).await?;

    let mut tx = state.db.begin().await?;
    ensure_subject(&mut tx, &ctx.org_id, &req.subject_type, &req.subject_id).await?;
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT id, level FROM resource_grants WHERE org_id = $1 AND resource_type = $2 AND resource_id = $3 \
         AND subject_type = $4 AND subject_id = $5",
    )
    .bind(&ctx.org_id)
    .bind(resource_type.as_str())
    .bind(&req.resource_id)
    .bind(&req.subject_type)
    .bind(&req.subject_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((_, old_level)) = &existing {
        // Lowering a grant takes rights away; that needs the caller to hold them too.
        level_set.extend(level_permissions(resource_type, old_level).unwrap_or_default());
    }
    ensure_holds(&held, &level_set)?;

    let now = state.clock.now_ms();
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let (id, status) = match existing {
        Some((id, old_level)) => {
            if old_level != req.level {
                sqlx::query("UPDATE resource_grants SET level = $1 WHERE id = $2")
                    .bind(&req.level)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
                let summary = json!({ "grantId": id, "from": old_level, "to": req.level });
                audit(
                    &mut tx,
                    &actor,
                    Some(&ctx.org_id),
                    "grant.changed",
                    (resource_type.as_str(), &req.resource_id),
                    summary,
                )
                .await?;
            }
            (id, StatusCode::OK)
        }
        None => {
            let id = super::new_id();
            sqlx::query(
                "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, \
                 created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(&id)
            .bind(&ctx.org_id)
            .bind(&req.subject_type)
            .bind(&req.subject_id)
            .bind(resource_type.as_str())
            .bind(&req.resource_id)
            .bind(&req.level)
            .bind(&ctx.user.id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            let summary = json!({
                "grantId": id, "subjectType": req.subject_type, "subjectId": req.subject_id, "level": req.level
            });
            audit(
                &mut tx,
                &actor,
                Some(&ctx.org_id),
                "grant.created",
                (resource_type.as_str(), &req.resource_id),
                summary,
            )
            .await?;
            (id, StatusCode::CREATED)
        }
    };
    let grant: Grant = sqlx::query_as(sqlx::AssertSqlSafe(format!("{GRANT_COLUMNS} WHERE g.id = $1")))
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok((status, Json(grant)))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, grant_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT resource_type, resource_id, level FROM resource_grants WHERE org_id = $1 AND id = $2")
            .bind(&ctx.org_id)
            .bind(&grant_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((resource_type, resource_id, level)) = row else { return Err(ApiError::not_found()) };
    let resource_type = ResourceType::parse(&resource_type).ok_or_else(ApiError::not_found)?;
    let held = managed_resource(&state, &ctx, Resource::new(resource_type, &resource_id)).await?;
    ensure_holds(&held, &level_permissions(resource_type, &level).unwrap_or_default())?;

    let mut tx = state.db.begin().await?;
    let done = sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(&grant_id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "grantId": grant_id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "grant.deleted", (resource_type.as_str(), &resource_id), summary).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExplainQuery {
    permission: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    permission: &'static str,
    allowed: bool,
    /// Every role, team role and grant that gives the caller the permission.
    sources: Vec<GrantSource>,
}

async fn explain_permission(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ExplainQuery>,
) -> ApiResult<Json<Explanation>> {
    let permission = q
        .permission
        .as_deref()
        .and_then(Permission::parse)
        .ok_or_else(|| ApiError::validation("permission is not in the catalog").with_field("permission"))?;
    let resource = match (q.resource_type.as_deref(), q.resource_id.as_deref()) {
        (None, None) => None,
        (Some(t), Some(id)) => {
            let resource = Resource::new(parse_resource_type(t, "resourceType")?, id);
            if !is_uuid(id) || !resource_exists(&state.db, &ctx.org_id, resource).await? {
                return Err(ApiError::not_found());
            }
            Some(resource)
        }
        (None, Some(_)) => return Err(ApiError::validation("resourceType is required").with_field("resourceType")),
        (Some(_), None) => return Err(ApiError::validation("resourceId is required").with_field("resourceId")),
    };
    let sources = explain(&state.db, &ctx, permission, resource).await?;
    Ok(Json(Explanation { permission: permission.as_str(), allowed: !sources.is_empty(), sources }))
}
