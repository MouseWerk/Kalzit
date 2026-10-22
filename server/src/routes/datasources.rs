//! Data sources of an organization: kinds, CRUD with trash, "Test connection" and the schema for
//! query editors. Secrets are written through `secrets` and never returned, only `{"set": true}`.
//! Documented in docs/api/datasources.md.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::table::{RouteDef, route};
use super::{clean_name, new_id};
use crate::app::AppState;
use crate::audit::{AuditEvent, record};
use crate::authz::{Access, AccessIndex, OrgCtx, Permission, Resource, check_resource, resource_permissions};
use crate::datasources::{self, Datasource, FieldError, HealthReport, Kind, SettingField, SourceSchema, find_in_org};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::secrets::{self, SecretPatch};
use crate::shapes::{DatasourceAccess, Page, Shape};

pub fn routes() -> Vec<RouteDef> {
    // Rights on one data source may come from the role or from a grant on it, so every route on a
    // data source is open to members and the handler checks the source (`check_resource`).
    // Creating one has no source yet and needs the org-wide permission.
    vec![
        route(Method::GET, "/orgs/{orgId}/datasource-kinds", Access::OrgMember, kinds),
        route(Method::GET, "/orgs/{orgId}/datasources", Access::OrgMember, list),
        route(Method::POST, "/orgs/{orgId}/datasources", Access::Org(Permission::DatasourcesWrite), create),
        route(Method::GET, "/orgs/{orgId}/datasources/{datasourceId}", Access::OrgMember, get_one),
        route(Method::PATCH, "/orgs/{orgId}/datasources/{datasourceId}", Access::OrgMember, update),
        route(Method::DELETE, "/orgs/{orgId}/datasources/{datasourceId}", Access::OrgMember, delete),
        route(Method::POST, "/orgs/{orgId}/datasources/{datasourceId}/restore", Access::OrgMember, restore),
        route(Method::POST, "/orgs/{orgId}/datasources/{datasourceId}/health", Access::OrgMember, health),
        route(Method::GET, "/orgs/{orgId}/datasources/{datasourceId}/schema", Access::OrgMember, schema),
    ]
}

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 200;

fn field_error(e: FieldError) -> ApiError {
    ApiError::validation(e.detail.message).with_field(e.field).with_reason(e.detail.reason, e.detail.params)
}

fn blocked(detail: crate::datasources::Detail, field: &'static str) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked", detail.message)
        .with_field(field)
        .with_reason(detail.reason, detail.params)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KindView {
    kind: &'static str,
    name: &'static str,
    shapes: &'static [Shape],
    hint_key: &'static str,
    settings: Vec<SettingField>,
}

async fn kinds(State(state): State<AppState>) -> Json<Page<KindView>> {
    let items = state
        .datasources
        .kinds()
        .iter()
        .map(|k| KindView {
            kind: k.kind(),
            name: k.name,
            shapes: k.plugin.shapes(),
            hint_key: k.hint_key,
            settings: k.all_settings().copied().collect(),
        })
        .collect();
    Json(Page { items, next_cursor: None })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListItem {
    id: String,
    name: String,
    kind: String,
    created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
    access: DatasourceAccess,
}

/// The caller's access from what they hold on the source (role and grants together, as
/// `resource_permissions` and the access index answer it). Nothing is allowed on a source the
/// caller cannot see.
fn access(ctx: &OrgCtx, held: Option<BTreeSet<Permission>>) -> DatasourceAccess {
    let Some(held) = held else { return DatasourceAccess::default() };
    DatasourceAccess {
        read: held.contains(&Permission::DatasourcesRead),
        query: held.contains(&Permission::DatasourcesQuery),
        write: held.contains(&Permission::DatasourcesWrite),
        permissions: held.contains(&Permission::DatasourcesPermissions),
        change_target: may_change_target(ctx, &held),
    }
}

/// Whether the caller may change where a source connects: they may change the source at all
/// (write on it), and where it connects is decided by those who administer it: the org-wide
/// right, or an admin grant on this source. An edit grant changes names, limits and secrets only.
fn may_change_target(ctx: &OrgCtx, held: &BTreeSet<Permission>) -> bool {
    held.contains(&Permission::DatasourcesWrite)
        && (ctx.permissions.contains(&Permission::DatasourcesWrite)
            || held.contains(&Permission::DatasourcesPermissions))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListParams {
    limit: Option<String>,
    cursor: Option<String>,
    trash: Option<String>,
}

/// Newest first (ids are UUIDv7, so id order is creation order); the cursor is the last id.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    params: Result<Query<ListParams>, QueryRejection>,
) -> ApiResult<Json<Page<ListItem>>> {
    let Query(params) = params.map_err(|e| {
        ApiError::validation(e.body_text()).because("request.query_invalid").param("detail", e.body_text())
    })?;
    let limit = match params.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(l) => match l.parse::<usize>() {
            Ok(n) if (1..=MAX_LIMIT).contains(&n) => n,
            _ => {
                return Err(ApiError::validation(format!("limit must be 1 to {MAX_LIMIT}"))
                    .with_field("limit")
                    .because("request.limit")
                    .param("max", MAX_LIMIT));
            }
        },
    };
    let trash = match params.trash.as_deref() {
        None | Some("false") => false,
        Some("true") => true,
        Some(_) => {
            return Err(ApiError::validation("trash must be true or false")
                .with_field("trash")
                .because("request.trash"));
        }
    };
    if let Some(c) = &params.cursor
        && uuid::Uuid::parse_str(c).is_err()
    {
        return Err(ApiError::validation("cursor is not valid").with_field("cursor").because("request.cursor"));
    }
    // The role shows every source, or a grant shows that one: live sources with read or query
    // rights, trashed ones with the right to restore them (write).
    let shows = |p: &std::collections::BTreeSet<Permission>| {
        if trash {
            p.contains(&Permission::DatasourcesWrite)
        } else {
            p.contains(&Permission::DatasourcesRead) || p.contains(&Permission::DatasourcesQuery)
        }
    };
    // The role alone shows every source only where it makes them visible at all (read or
    // query); a role with write but neither sees, and restores, only what grants show it.
    let role_sees = ctx.permissions.contains(&Permission::DatasourcesRead)
        || ctx.permissions.contains(&Permission::DatasourcesQuery);
    let org_wide = role_sees && shows(&ctx.permissions);
    // Also says per row what the caller may do, without a query per row.
    let index = AccessIndex::load(&mut *state.db.acquire().await?, &ctx).await?;
    let granted: Vec<String> = if org_wide {
        Vec::new()
    } else {
        index
            .granted_datasources()
            .into_iter()
            .filter(|id| index.datasource(id).is_some_and(|p| shows(&p)))
            .map(String::from)
            .collect()
    };
    if !org_wide && granted.is_empty() {
        return Ok(Json(Page { items: Vec::new(), next_cursor: None }));
    }
    let deleted = if trash { "deleted_at IS NOT NULL" } else { "deleted_at IS NULL" };
    let after = if params.cursor.is_some() { "AND id < $3" } else { "" };
    let first = if params.cursor.is_some() { 4 } else { 3 };
    let only = if org_wide {
        String::new()
    } else {
        let placeholders: Vec<String> = (0..granted.len()).map(|i| format!("${}", first + i)).collect();
        format!("AND id IN ({})", placeholders.join(", "))
    };
    let sql = format!(
        "SELECT id, name, kind, created_at, deleted_at FROM datasources WHERE org_id = $1 AND {deleted} {after} \
         {only} ORDER BY id DESC LIMIT $2"
    );
    let mut q = sqlx::query_as::<_, (String, String, String, i64, Option<i64>)>(sqlx::AssertSqlSafe(sql))
        .bind(&ctx.org_id)
        .bind((limit + 1) as i64);
    if let Some(c) = &params.cursor {
        q = q.bind(c);
    }
    for id in &granted {
        q = q.bind(id);
    }
    let mut rows = q.fetch_all(&state.db).await?;
    let next_cursor = if rows.len() > limit {
        rows.truncate(limit);
        rows.last().map(|r| r.0.clone())
    } else {
        None
    };
    let items = rows
        .into_iter()
        .map(|(id, name, kind, created_at, deleted_at)| {
            let access = access(&ctx, index.datasource(&id));
            ListItem { id, name, kind, created_at, deleted_at, access }
        })
        .collect();
    Ok(Json(Page { items, next_cursor }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DatasourceView {
    id: String,
    name: String,
    kind: String,
    settings: Value,
    /// Only the names of the secrets that have a value: `{"password": {"set": true}}`.
    secrets: BTreeMap<String, Value>,
    created_at: i64,
    updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    deleted_at: Option<i64>,
    access: DatasourceAccess,
}

/// The answer for one data source, read through `conn`: after a change, the change's own
/// transaction before its commit, so a failing read can still be answered as "nothing changed".
/// The caller's access comes from the access index read on the same connection, so it sees the
/// change too and needs no second connection while the transaction holds the database.
async fn view_in(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, ds: Datasource) -> ApiResult<DatasourceView> {
    let secrets =
        secrets::set_fields(&mut *conn, &ds.id).await?.into_iter().map(|f| (f, json!({ "set": true }))).collect();
    let access = access(ctx, AccessIndex::load(&mut *conn, ctx).await?.datasource(&ds.id));
    Ok(DatasourceView {
        access,
        id: ds.id,
        name: ds.name,
        kind: ds.kind,
        settings: ds.settings,
        secrets,
        created_at: ds.created_at,
        updated_at: ds.updated_at,
        deleted_at: ds.deleted_at,
    })
}

/// The target checks that need no network, so a blocked target is reported when saving.
async fn precheck_targets(state: &AppState, kind: &Kind, settings: &Value) -> ApiResult<()> {
    let policy = state.datasources.policy(state).await?;
    datasources::precheck_targets(&policy, kind, settings).map_err(|(b, field)| blocked(b.0, field))
}

/// `view_in` on a pooled connection, where no change is involved.
async fn view(state: &AppState, ctx: &OrgCtx, ds: Datasource) -> ApiResult<DatasourceView> {
    view_in(&mut *state.db.acquire().await?, ctx, ds).await
}

fn conflict_on_name(e: sqlx::Error) -> ApiError {
    if e.as_database_error().is_some_and(|d| d.is_unique_violation()) { name_conflict() } else { e.into() }
}

async fn name_taken(state: &AppState, org_id: &str, name: &str, except: &str) -> ApiResult<bool> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM datasources WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL AND id <> $3",
    )
    .bind(org_id)
    .bind(name)
    .bind(except)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.is_some())
}

fn name_conflict() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "a data source with this name exists")
        .with_field("name")
        .because("datasource.name_taken")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    name: String,
    kind: String,
    #[serde(default = "empty_object")]
    settings: Value,
    #[serde(default)]
    secrets: SecretPatch,
}

fn empty_object() -> Value {
    json!({})
}

fn event<'a>(
    ctx: &'a OrgCtx,
    info: &RequestInfo,
    action: &'a str,
    id: &'a str,
    summary: Value,
    at_ms: i64,
) -> AuditEvent<'a> {
    AuditEvent {
        org_id: Some(&ctx.org_id),
        actor_user_id: Some(&ctx.user.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("datasource"),
        resource_id: Some(id),
        summary,
        at_ms,
    }
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateBody>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let kind = state.datasources.kind(&body.kind).ok_or_else(|| {
        ApiError::validation(format!("{} is not a data source kind", body.kind))
            .with_field("kind")
            .because("datasource.kind_unknown")
            .param("kind", &body.kind)
    })?;
    let settings = kind.validate_settings(&body.settings).map_err(field_error)?;
    // A secret that is null on create is simply not set.
    let secrets: SecretPatch = body.secrets.into_iter().filter(|(_, v)| v.is_some()).collect();
    kind.validate_secrets(&secrets).map_err(field_error)?;
    precheck_targets(&state, kind, &settings).await?;
    datasources::check_on_save(&state, kind, None, &settings, &secrets).await?;
    if name_taken(&state, &ctx.org_id, &name, "").await? {
        return Err(name_conflict());
    }
    let id = new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $6)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&name)
    .bind(kind.kind())
    .bind(settings.to_string())
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(conflict_on_name)?;
    secrets::apply_patch(&mut tx, state.datasources.keyring(), &id, &secrets).await?;
    let summary = json!({
        "kind": kind.kind(),
        "settings": settings.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        "secrets": secrets.keys().collect::<Vec<_>>(),
    });
    record(&mut tx, &event(&ctx, &info, "datasource.created", &id, summary, now)).await?;
    let ds = datasources::resolve_in_org(&mut *tx, &ctx.org_id, &id).await?;
    let answer = view_in(&mut tx, &ctx, ds).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(answer)))
}

/// A data source the caller may act on with `permission`, after the org-level rule.
async fn resource(
    state: &AppState,
    ctx: &OrgCtx,
    id: &str,
    permission: Permission,
    trashed: bool,
) -> ApiResult<Datasource> {
    let ds = find_in_org(&state.db, &ctx.org_id, id, trashed).await?;
    check_resource(&state.db, ctx, permission, Resource::Datasource(&ds.id)).await?;
    Ok(ds)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DsPath {
    datasource_id: String,
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
) -> ApiResult<Json<DatasourceView>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesRead, false).await?;
    Ok(Json(view(&state, &ctx, ds).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchBody {
    name: Option<String>,
    /// Replaces all settings when present.
    settings: Option<Value>,
    /// Per field: absent = keep, null = remove, string = set.
    #[serde(default)]
    secrets: SecretPatch,
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<DsPath>,
    JsonBody(body): JsonBody<PatchBody>,
) -> ApiResult<Json<DatasourceView>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, false).await?;
    let kind = state.datasources.kind(&ds.kind).ok_or_else(|| ApiError::internal("update", "unknown kind"))?;
    let mut changed: Vec<String> = Vec::new();
    let name = match &body.name {
        Some(raw) => {
            let name = clean_name(raw, "name").map_err(|e| e.with_field("name"))?;
            if name != ds.name {
                if name_taken(&state, &ctx.org_id, &name, &ds.id).await? {
                    return Err(name_conflict());
                }
                changed.push("name".into());
            }
            name
        }
        None => ds.name.clone(),
    };
    let settings = match &body.settings {
        Some(s) => {
            let new = kind.validate_settings(s).map_err(field_error)?;
            let keys = |v: &Value| v.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default();
            let mut all = keys(&new);
            all.extend(keys(&ds.settings));
            all.sort();
            all.dedup();
            changed
                .extend(all.into_iter().filter(|k| new.get(k) != ds.settings.get(k)).map(|k| format!("settings.{k}")));
            precheck_targets(&state, kind, &new).await?;
            new
        }
        None => ds.settings.clone(),
    };
    kind.validate_secrets(&body.secrets).map_err(field_error)?;
    // A new target must not receive the secrets stored for the old one: every stored secret is
    // sent again (or removed) in the same change.
    if let Some(target) = kind.changed_targets(&ds.settings, &settings).first() {
        let held = resource_permissions(&state.db, &ctx, Resource::Datasource(&ds.id)).await?.unwrap_or_default();
        if !may_change_target(&ctx, &held) {
            return Err(ApiError::forbidden(format!(
                "changing {target} needs datasources:write for the organization or an admin grant on this source"
            ))
            .because("datasource.target_change_forbidden")
            .param("field", target));
        }
        for stored in secrets::set_fields(&state.db, &ds.id).await? {
            if !body.secrets.contains_key(&stored) {
                let field = kind.all_settings().find(|f| f.name == stored).map_or("secrets", |f| f.name);
                return Err(ApiError::validation(format!(
                    "{target} changes where the data source connects; send {stored} again or remove it"
                ))
                .with_field(field)
                .because("secrets.resend_on_target_change")
                .param("field", target)
                .param("secret", &stored));
            }
        }
    }
    changed.extend(body.secrets.keys().map(|k| format!("secrets.{k}")));
    if changed.is_empty() {
        return Ok(Json(view(&state, &ctx, ds).await?));
    }
    if changed.iter().any(|c| c.starts_with("settings.") || c.starts_with("secrets.")) {
        datasources::check_on_save(&state, kind, Some(&ds.id), &settings, &body.secrets).await?;
    }
    // Strictly increasing, so the connection cache sees the change even within one millisecond.
    let now = state.clock.now_ms().max(ds.updated_at + 1);
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("UPDATE datasources SET name = $1, settings = $2, updated_at = $3 WHERE id = $4 AND org_id = $5")
        .bind(&name)
        .bind(settings.to_string())
        .bind(now)
        .bind(&ds.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await
        .map_err(conflict_on_name)?;
    secrets::apply_patch(&mut tx, state.datasources.keyring(), &ds.id, &body.secrets).await?;
    record(&mut tx, &event(&ctx, &info, "datasource.updated", &ds.id, json!({ "changed": changed }), now)).await?;
    let saved = datasources::resolve_in_org(&mut *tx, &ctx.org_id, &ds.id).await?;
    let answer = view_in(&mut tx, &ctx, saved).await?;
    crate::db::commit(tx).await?;
    state.datasources.forget(&ds.id);
    Ok(Json(answer))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<DsPath>,
) -> ApiResult<StatusCode> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, false).await?;
    let now = state.clock.now_ms().max(ds.updated_at + 1);
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("UPDATE datasources SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND org_id = $3")
        .bind(now)
        .bind(&ds.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    record(&mut tx, &event(&ctx, &info, "datasource.deleted", &ds.id, json!({}), now)).await?;
    crate::db::commit(tx).await?;
    state.datasources.forget(&ds.id);
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<DsPath>,
) -> ApiResult<Json<DatasourceView>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, true).await?;
    if name_taken(&state, &ctx.org_id, &ds.name, &ds.id).await? {
        return Err(name_conflict());
    }
    let now = state.clock.now_ms().max(ds.updated_at + 1);
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("UPDATE datasources SET deleted_at = NULL, updated_at = $1 WHERE id = $2 AND org_id = $3")
        .bind(now)
        .bind(&ds.id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await
        .map_err(conflict_on_name)?;
    record(&mut tx, &event(&ctx, &info, "datasource.restored", &ds.id, json!({}), now)).await?;
    let restored = datasources::resolve_in_org(&mut *tx, &ctx.org_id, &ds.id).await?;
    let answer = view_in(&mut tx, &ctx, restored).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
}

async fn health(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
) -> ApiResult<Json<HealthReport>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    Ok(Json(datasources::check_health(&state, &ctx.user.id, &ds).await?))
}

async fn schema(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path(path): Path<DsPath>,
) -> ApiResult<Json<SourceSchema>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesQuery, false).await?;
    Ok(Json(datasources::read_schema(&state, &ctx.user.id, &ds).await?))
}
