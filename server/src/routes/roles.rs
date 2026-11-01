//! Built-in and custom roles of an organization (docs/api/access.md, "Roles").

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::support::{Actor, audit, clean_text, conflict, is_unique_violation};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{
    Access, BuiltinRole, OrgCtx, Permission, RoleInfo, ensure_holds, lock_org, lock_role, resolve_role,
};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

/// Bounds the roles list, which is answered in one page.
const MAX_CUSTOM_ROLES: i64 = 100;
const MAX_DESCRIPTION_CHARS: usize = 500;

pub fn routes() -> Vec<RouteDef> {
    use Access::Org;
    use Permission::{RolesRead, RolesWrite};
    vec![
        route(Method::GET, "/orgs/{orgId}/roles", Org(RolesRead), list),
        route(Method::POST, "/orgs/{orgId}/roles", Org(RolesWrite), create).changes_rights(),
        route(Method::PATCH, "/orgs/{orgId}/roles/{roleId}", Org(RolesWrite), update).changes_rights(),
        route(Method::DELETE, "/orgs/{orgId}/roles/{roleId}", Org(RolesWrite), delete).changes_rights(),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    /// The built-in name or the custom role's id; what members and teams store as their role.
    id: String,
    name: String,
    description: String,
    builtin: bool,
    permissions: Vec<&'static str>,
    /// `null` for built-in roles.
    created_at: Option<i64>,
}

fn names(permissions: &BTreeSet<Permission>) -> Vec<&'static str> {
    permissions.iter().map(|p| p.as_str()).collect()
}

/// Built-ins first (strongest first), then custom roles by name. The list is bounded by
/// `MAX_CUSTOM_ROLES`, so it is one page.
async fn list(State(state): State<AppState>, Extension(ctx): Extension<OrgCtx>) -> ApiResult<Json<Page<Role>>> {
    let mut items: Vec<Role> = BuiltinRole::ALL
        .iter()
        .map(|r| Role {
            id: r.as_str().into(),
            name: r.as_str().into(),
            description: String::new(),
            builtin: true,
            permissions: names(&r.permissions()),
            created_at: None,
        })
        .collect();
    let mut custom: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT id, name, description, created_at FROM roles WHERE org_id = $1")
            .bind(&ctx.org_id)
            .fetch_all(&state.db)
            .await?;
    custom.sort_by(|a, b| crate::collation::compare(&a.1, &b.1).then_with(|| a.0.cmp(&b.0)));
    for (id, name, description, created_at) in custom {
        let permissions = resolve_role(&state.db, &ctx.org_id, &id).await?.map(|r| r.permissions).unwrap_or_default();
        items.push(Role {
            id,
            name,
            description,
            builtin: false,
            permissions: names(&permissions),
            created_at: Some(created_at),
        });
    }
    Ok(Json(Page { items, next_cursor: None }))
}

fn parse_permissions(raw: &[String]) -> ApiResult<BTreeSet<Permission>> {
    raw.iter()
        .map(|p| match Permission::parse(p) {
            // Owners alone may delete the organization; a custom role would make owners outside
            // the last-owner rule.
            Some(Permission::OrgDelete) => {
                Err(ApiError::validation("org:delete belongs to owners only").with_field("permissions"))
            }
            Some(permission) => Ok(permission),
            None => Err(ApiError::validation(format!("unknown permission {p}")).with_field("permissions")),
        })
        .collect()
}

fn clean_role_name(raw: &str) -> ApiResult<String> {
    let name = super::clean_name(raw, "name").map_err(|e| e.with_field("name"))?;
    // A custom role called "Admin" next to the built-in admin would mislead whoever assigns it.
    if BuiltinRole::parse(&name.to_lowercase()).is_some() {
        return Err(ApiError::validation("a built-in role has this name").with_field("name"));
    }
    Ok(name)
}

fn duplicate_name() -> ApiError {
    conflict("a role with this name exists already").with_field("name")
}

async fn load(conn: &mut sqlx::AnyConnection, org_id: &str, role_id: &str) -> ApiResult<Role> {
    let row: Option<(String, String, i64)> =
        sqlx::query_as("SELECT name, description, created_at FROM roles WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(role_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((name, description, created_at)) = row else { return Err(ApiError::not_found()) };
    let permissions = resolve_role(&mut *conn, org_id, role_id).await?.map(|r| r.permissions).unwrap_or_default();
    Ok(Role {
        id: role_id.into(),
        name,
        description,
        builtin: false,
        permissions: names(&permissions),
        created_at: Some(created_at),
    })
}

async fn write_permissions(
    conn: &mut sqlx::AnyConnection,
    role_id: &str,
    permissions: &BTreeSet<Permission>,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM role_permissions WHERE role_id = $1").bind(role_id).execute(&mut *conn).await?;
    for p in permissions {
        sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)")
            .bind(role_id)
            .bind(p.as_str())
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    name: String,
    #[serde(default)]
    description: String,
    permissions: Vec<String>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(req): JsonBody<CreateRequest>,
) -> ApiResult<(StatusCode, Json<Role>)> {
    let name = clean_role_name(&req.name)?;
    let description =
        clean_text(&req.description, "description", MAX_DESCRIPTION_CHARS).map_err(|e| e.with_field("description"))?;
    let permissions = parse_permissions(&req.permissions)?;
    ensure_holds(&ctx.permissions, &permissions)?;

    let id = super::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM roles WHERE org_id = $1").bind(&ctx.org_id).fetch_one(&mut *tx).await?;
    if count >= MAX_CUSTOM_ROLES {
        return Err(conflict(format!("an organization can have at most {MAX_CUSTOM_ROLES} custom roles")));
    }
    sqlx::query(
        "INSERT INTO roles (id, org_id, name, name_key, description, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&name)
    .bind(name.to_lowercase())
    .bind(&description)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| if is_unique_violation(&e) { duplicate_name() } else { e.into() })?;
    write_permissions(&mut tx, &id, &permissions).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "roleId": id, "permissions": names(&permissions) });
    audit(&mut tx, &actor, Some(&ctx.org_id), "role.created", ("role", &id), summary).await?;
    let role = load(&mut tx, &ctx.org_id, &id).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(role)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateRequest {
    name: Option<String>,
    description: Option<String>,
    permissions: Option<Vec<String>>,
}

/// The custom role `role_id` of the organization. Built-in roles cannot be changed.
async fn custom_role(conn: &mut sqlx::AnyConnection, org_id: &str, role_id: &str) -> ApiResult<RoleInfo> {
    if BuiltinRole::parse(role_id).is_some() {
        return Err(ApiError::forbidden("built-in roles cannot be changed"));
    }
    // Locked, so a member cannot be given the role while it is changed or deleted.
    lock_role(conn, org_id, role_id).await?.ok_or_else(ApiError::not_found)
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, role_id)): Path<(String, String)>,
    JsonBody(req): JsonBody<UpdateRequest>,
) -> ApiResult<Json<Role>> {
    let name = req.name.as_deref().map(clean_role_name).transpose()?;
    let description = req
        .description
        .as_deref()
        .map(|d| clean_text(d, "description", MAX_DESCRIPTION_CHARS).map_err(|e| e.with_field("description")))
        .transpose()?;
    let permissions = req.permissions.as_deref().map(parse_permissions).transpose()?;

    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let current = custom_role(&mut tx, &ctx.org_id, &role_id).await?;
    // Changing a role changes the rights of everyone holding it, in both directions.
    ensure_holds(&ctx.permissions, &current.permissions)?;
    let mut fields = Vec::new();
    if let Some(name) = &name {
        sqlx::query("UPDATE roles SET name = $1, name_key = $2 WHERE org_id = $3 AND id = $4")
            .bind(name)
            .bind(name.to_lowercase())
            .bind(&ctx.org_id)
            .bind(&role_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| if is_unique_violation(&e) { duplicate_name() } else { e.into() })?;
        fields.push("name");
    }
    if let Some(description) = &description {
        sqlx::query("UPDATE roles SET description = $1 WHERE org_id = $2 AND id = $3")
            .bind(description)
            .bind(&ctx.org_id)
            .bind(&role_id)
            .execute(&mut *tx)
            .await?;
        fields.push("description");
    }
    if let Some(permissions) = &permissions {
        ensure_holds(&ctx.permissions, permissions)?;
        write_permissions(&mut tx, &role_id, permissions).await?;
        fields.push("permissions");
    }
    if !fields.is_empty() {
        let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
        let mut summary = json!({ "roleId": role_id, "fields": fields });
        if let Some(permissions) = &permissions {
            summary["permissions"] = json!(names(permissions));
        }
        audit(&mut tx, &actor, Some(&ctx.org_id), "role.updated", ("role", &role_id), summary).await?;
    }
    let role = load(&mut tx, &ctx.org_id, &role_id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(role))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, role_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let current = custom_role(&mut tx, &ctx.org_id, &role_id).await?;
    ensure_holds(&ctx.permissions, &current.permissions)?;
    // Members whose org role this is would be left with no role; they get another one first.
    let (holders,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND role = $2")
        .bind(&ctx.org_id)
        .bind(&role_id)
        .fetch_one(&mut *tx)
        .await?;
    if holders > 0 {
        return Err(conflict("members still have this role; give them another role first"));
    }
    sqlx::query("DELETE FROM team_roles WHERE role = $1 AND team_id IN (SELECT id FROM teams WHERE org_id = $2)")
        .bind(&role_id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND subject_type = 'role' AND subject_id = $2")
        .bind(&ctx.org_id)
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM roles WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    audit(&mut tx, &actor, Some(&ctx.org_id), "role.deleted", ("role", &role_id), json!({ "roleId": role_id })).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}
