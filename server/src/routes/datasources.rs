//! Data sources of an organization: kinds, CRUD with trash and purge, "Test connection" (of a
//! stored source, and of settings not saved yet) and the schema for query editors. Secrets are written through `secrets` and never returned, only `{"set": true}`.
//! Documented in docs/api/datasources.md.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::support::QueryParams;
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
        // The built-in sample database as a SQLite source; a path of its own, like `test`.
        route(
            Method::POST,
            "/orgs/{orgId}/datasources/sample",
            Access::Org(Permission::DatasourcesWrite),
            create_sample,
        ),
        // Settings not saved yet; no source id is involved, `test` is a path of its own.
        // Member, then the right to change: on the source when `datasourceId` names one (a grant is
        // enough there), else org-wide (as adding a source).
        route(Method::POST, "/orgs/{orgId}/datasources/test", Access::OrgMember, test_unsaved),
        route(Method::GET, "/orgs/{orgId}/datasources/{datasourceId}", Access::OrgMember, get_one),
        route(Method::PATCH, "/orgs/{orgId}/datasources/{datasourceId}", Access::OrgMember, update),
        route(Method::DELETE, "/orgs/{orgId}/datasources/{datasourceId}", Access::OrgMember, delete),
        route(Method::POST, "/orgs/{orgId}/datasources/{datasourceId}/restore", Access::OrgMember, restore),
        route(Method::DELETE, "/orgs/{orgId}/datasources/{datasourceId}/purge", Access::OrgMember, purge),
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
    ApiError::new(
        StatusCode::UNPROCESSABLE_ENTITY,
        "datasource_target_blocked",
        datasources::hide_logins(&detail.message),
    )
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
    /// The last "Test connection" since the settings or secrets last changed, with its warnings,
    /// for everyone who may see the source.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_test: Option<datasources::LastTest>,
}

/// The answer for one data source, read through `conn`: after a change, the change's own
/// transaction before its commit, so a failing read can still be answered as "nothing changed".
/// The caller's access comes from the access index read on the same connection, so it sees the
/// change too and needs no second connection while the transaction holds the database.
async fn view_in(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, ds: Datasource) -> ApiResult<DatasourceView> {
    let secrets =
        secrets::set_fields(&mut *conn, &ds.id).await?.into_iter().map(|f| (f, json!({ "set": true }))).collect();
    let access = access(ctx, AccessIndex::load(&mut *conn, ctx).await?.datasource(&ds.id));
    let last_test = datasources::last_test(&mut *conn, &ds.id).await?;
    Ok(DatasourceView {
        access,
        last_test,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SampleBody {
    /// The UI sends it in the user's language ("Beispieldaten", "Sample data").
    name: String,
}

/// The most names tried with a number appended before the request gives up.
const MAX_SAMPLE_NAME_TRIES: u32 = 100;

/// Adds the built-in sample database (`datasources::sample`) as a SQLite source, through the same
/// checks and audit as `create`. When a source of the organization already opens the sample, that
/// one is answered (200) instead of a second; a taken name gets " 2", " 3" and so on.
async fn create_sample(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SampleBody>,
) -> ApiResult<impl IntoResponse> {
    let name = clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let kind = state.datasources.kind("sqlite").ok_or_else(|| ApiError::internal("sample", "no sqlite kind"))?;
    let file = datasources::sample::ensure(&state.config.paths.data_dir)
        .await
        .map_err(|e| ApiError::internal("creating the sample database", format!("{e:#}")))?;
    // The canonical path the target rules answer is the one stored, so it is the same for every
    // source of the sample.
    let policy = state.datasources.policy(&state).await?;
    // The rules resolve the path on disk, so they run off the async workers.
    let checked = file.to_string_lossy().to_string();
    let path = tokio::task::spawn_blocking(move || policy.check_sqlite_path(&checked))
        .await
        .map_err(|e| ApiError::internal("checking the sample database", e))?
        .map_err(|b| blocked(b.0, "path"))?;
    let settings = kind.validate_settings(&json!({ "path": path.to_string_lossy() })).map_err(field_error)?;
    let secrets = SecretPatch::default();
    precheck_targets(&state, kind, &settings).await?;
    datasources::check_on_save(&state, kind, None, &settings, &secrets).await?;

    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // Two requests at once must not both add the sample.
    crate::authz::lock_org(&mut tx, &ctx.org_id).await?;
    let sqlite_sources: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, settings FROM datasources WHERE org_id = $1 AND kind = 'sqlite' AND deleted_at IS NULL \
         ORDER BY created_at, id",
    )
    .bind(&ctx.org_id)
    .fetch_all(&mut *tx)
    .await?;
    let sample_path = path.clone();
    let existing = tokio::task::spawn_blocking(move || {
        let sample = std::fs::canonicalize(&sample_path).ok()?;
        sqlite_sources.into_iter().find(|(_, stored)| {
            serde_json::from_str::<Value>(stored)
                .ok()
                .and_then(|s| s.get("path").and_then(Value::as_str).map(std::path::PathBuf::from))
                .and_then(|p| std::fs::canonicalize(p).ok())
                .is_some_and(|p| p == sample)
        })
    })
    .await
    .map_err(|e| ApiError::internal("looking for the sample source", e))?;
    if let Some((id, _)) = existing {
        let ds = datasources::resolve_in_org(&mut *tx, &ctx.org_id, &id).await?;
        let answer = view_in(&mut tx, &ctx, ds).await?;
        crate::db::commit(tx).await?;
        return Ok((StatusCode::OK, Json(answer)));
    }
    let mut chosen = None;
    for n in 1..=MAX_SAMPLE_NAME_TRIES {
        let candidate = if n == 1 { name.clone() } else { format!("{name} {n}") };
        let candidate = clean_name(&candidate, "name").map_err(|e| e.with_field("name"))?;
        let taken: Option<(String,)> =
            sqlx::query_as("SELECT id FROM datasources WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL")
                .bind(&ctx.org_id)
                .bind(&candidate)
                .fetch_optional(&mut *tx)
                .await?;
        if taken.is_none() {
            chosen = Some(candidate);
            break;
        }
    }
    let Some(name) = chosen else { return Err(name_conflict()) };
    let id = new_id();
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
    let summary = json!({ "kind": kind.kind(), "settings": ["path"], "secrets": [], "sample": true });
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
    /// The `updatedAt` the client last read. A newer stored row answers `409 version_conflict`
    /// with the stored data source instead of overwriting it. Required with `settings` or
    /// `secrets`; a rename alone may leave it out.
    expected_updated_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteQuery {
    /// As for `PATCH`: the `updatedAt` the client last read.
    expected_updated_at: Option<i64>,
}

/// The conflict for a change made on a data source that was changed since: it carries the
/// stored data source, or answers "not found" when it is gone (trashed) in the meantime.
async fn stale(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiError {
    let current = match find_in_org(&state.db, &ctx.org_id, id, false).await {
        Ok(current) => current,
        Err(e) => return e,
    };
    match view(state, ctx, current).await {
        Ok(current) => ApiError::version_conflict(json!(current)),
        Err(e) => e,
    }
}

async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<DsPath>,
    JsonBody(body): JsonBody<PatchBody>,
) -> ApiResult<Json<DatasourceView>> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, false).await?;
    // Settings and secrets belong to one target: a change to them is only taken over the version
    // of the source the client saw.
    let Some(expected) = body
        .expected_updated_at
        .or_else(|| (body.settings.is_none() && body.secrets.is_empty()).then_some(ds.updated_at))
    else {
        return Err(ApiError::validation("expectedUpdatedAt is required when settings or secrets change")
            .with_field("expectedUpdatedAt")
            .because("datasource.expected_version_missing"));
    };
    if expected != ds.updated_at {
        return Err(stale(&state, &ctx, &ds.id).await);
    }
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
    check_target_change(&state, &ctx, kind, &ds, &settings, &body.secrets).await?;
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
    // Written only over the row everything above was checked against: the target change rule,
    // the secrets that must be sent again and the connection check all saw this row. A change
    // saved in the meantime (another host, say) answers the conflict, so a password meant for one
    // host is never stored against another.
    let updated = sqlx::query(
        "UPDATE datasources SET name = $1, settings = $2, updated_at = $3 \
         WHERE id = $4 AND org_id = $5 AND updated_at = $6 AND deleted_at IS NULL",
    )
    .bind(&name)
    .bind(settings.to_string())
    .bind(now)
    .bind(&ds.id)
    .bind(&ctx.org_id)
    .bind(ds.updated_at)
    .execute(&mut *tx)
    .await
    .map_err(conflict_on_name)?
    .rows_affected();
    if updated == 0 {
        tx.rollback().await?;
        return Err(stale(&state, &ctx, &ds.id).await);
    }
    secrets::apply_patch(&mut tx, state.datasources.keyring(), &ds.id, &body.secrets).await?;
    if changed.iter().any(|c| c.starts_with("settings.") || c.starts_with("secrets.")) {
        // The last test checked what was stored before; its warnings may no longer apply.
        datasources::forget_last_test(&mut tx, &ds.id).await?;
    }
    record(&mut tx, &event(&ctx, &info, "datasource.updated", &ds.id, json!({ "changed": changed }), now)).await?;
    let saved = datasources::resolve_in_org(&mut *tx, &ctx.org_id, &ds.id).await?;
    let answer = view_in(&mut tx, &ctx, saved).await?;
    crate::db::commit(tx).await?;
    state.datasources.forget(&ds.id);
    Ok(Json(answer))
}

/// A new target must not receive the secrets stored for the old one: whoever moves it needs the
/// right to, and every stored secret is sent again (or removed) in the same change. Saving and
/// testing unsaved settings both apply it, so a test cannot send a stored password anywhere a
/// save could not.
async fn check_target_change(
    state: &AppState,
    ctx: &OrgCtx,
    kind: &Kind,
    ds: &Datasource,
    settings: &Value,
    patch: &SecretPatch,
) -> ApiResult<()> {
    let Some(target) = kind.changed_targets(&ds.settings, settings).first().copied() else {
        return Ok(());
    };
    let held = resource_permissions(&state.db, ctx, Resource::Datasource(&ds.id)).await?.unwrap_or_default();
    if !may_change_target(ctx, &held) {
        return Err(ApiError::forbidden(format!(
            "changing {target} needs datasources:write for the organization or an admin grant on this source"
        ))
        .because("datasource.target_change_forbidden")
        .param("field", target));
    }
    for stored in secrets::set_fields(&state.db, &ds.id).await? {
        if !patch.contains_key(&stored) {
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
    Ok(())
}

/// Tests per user and per client address in `PROBE_WINDOW_SECS`: "Test" before saving can reach
/// any address the data source rules allow, so it must not be a way to scan a network.
pub(crate) const PROBE_MAX: u32 = 20;
pub(crate) const PROBE_WINDOW_SECS: u64 = 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestBody {
    kind: String,
    /// The stored source an edit form tests: unchanged secrets come from it, and `settings` may be
    /// left out to test its stored ones.
    datasource_id: Option<String>,
    settings: Option<Value>,
    /// As in `PATCH`: absent keeps the stored secret (edit), null removes it, a string sets it.
    #[serde(default)]
    secrets: SecretPatch,
}

/// The host a test goes to, for the log: the first host, URL host or "file". Never a secret.
fn target_of(settings: &Value) -> String {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).filter(|v| !v.is_empty());
    if let Some(host) = text("host").or_else(|| text("hosts")) {
        return host.chars().take(200).collect();
    }
    for key in ["url", "restppUrl"] {
        if let Some(host) =
            text(key).and_then(|u| reqwest::Url::parse(u).ok()).and_then(|u| u.host_str().map(String::from))
        {
            return host.chars().take(200).collect();
        }
    }
    if text("path").is_some() { "file".into() } else { "-".into() }
}

/// "Test connection" for what the add or edit form holds, before anything is saved. The body
/// carries secrets: it is read into memory, used for the probe and dropped; it is not logged, not
/// stored and not part of the answer (messages are scrubbed of the secrets, and a malformed body
/// is refused without repeating any of it). The test is logged with user, organization, kind and
/// target, never with a secret.
async fn test_unsaved(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(raw): JsonBody<Value>,
) -> ApiResult<Json<HealthReport>> {
    let body: TestBody = serde_json::from_value(raw).map_err(|_| {
        ApiError::validation("the body is not a valid test request; see docs/api/datasources.md")
            .because("request.body_invalid")
            .param("detail", "not a valid test request")
    })?;
    // The right first, so that members who may not test cannot use up the limit of those who may.
    let stored = match &body.datasource_id {
        Some(id) => Some(resource(&state, &ctx, id, Permission::DatasourcesWrite, false).await?),
        None => {
            // A new source: what adding one takes.
            if !ctx.permissions.contains(&Permission::DatasourcesWrite) {
                return Err(ApiError::forbidden("testing a new data source needs datasources:write")
                    .because("datasource.test_forbidden"));
            }
            None
        }
    };
    // Per user and per client address within the organization.
    let user_key = format!("datasource-test:user:{}", ctx.user.id);
    let address_key = format!("datasource-test:{}:address:{}", ctx.org_id, info.client_ip);
    let mono = state.clock.monotonic_ms();
    let network = crate::auth::ratelimit::network_key(info.client_ip);
    let counted = state.probe_limiter.try_acquire(&user_key, &user_key, mono).and_then(|_| {
        state.probe_limiter.try_acquire(&address_key, &network, mono).inspect_err(|_| {
            state.probe_limiter.refund(&user_key);
        })
    });
    if let Err(wait) = counted {
        return Err(ApiError::rate_limited("too many connection tests; wait a minute", wait)
            .because("datasource.test_rate_limited")
            .param("max", PROBE_MAX));
    }
    let kind = state.datasources.kind(&body.kind).ok_or_else(|| {
        ApiError::validation(format!("{} is not a data source kind", body.kind))
            .with_field("kind")
            .because("datasource.kind_unknown")
            .param("kind", &body.kind)
    })?;
    if stored.as_ref().is_some_and(|ds| ds.kind != kind.kind()) {
        return Err(ApiError::validation("the kind of a stored data source cannot change")
            .with_field("kind")
            .because("datasource.kind_changed"));
    }
    let settings = match (&body.settings, &stored) {
        (Some(s), _) => kind.validate_settings(s).map_err(field_error)?,
        (None, Some(ds)) => ds.settings.clone(),
        (None, None) => kind.validate_settings(&empty_object()).map_err(field_error)?,
    };
    // A secret that is null for a new source is simply not set.
    let patch: SecretPatch =
        if stored.is_some() { body.secrets } else { body.secrets.into_iter().filter(|(_, v)| v.is_some()).collect() };
    kind.validate_secrets(&patch).map_err(field_error)?;
    precheck_targets(&state, kind, &settings).await?;
    if let Some(ds) = &stored {
        check_target_change(&state, &ctx, kind, ds, &settings, &patch).await?;
    }
    tracing::info!(
        user = %ctx.user.id,
        org = %ctx.org_id,
        kind = kind.kind(),
        target = %target_of(&settings),
        stored = stored.is_some(),
        "connection test of data source settings that are not saved"
    );
    let report = datasources::check_unsaved(
        &state,
        &ctx.user.id,
        kind,
        stored.as_ref().map(|d| d.id.as_str()),
        &settings,
        &patch,
    )
    .await?;
    Ok(Json(report))
}

async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<DsPath>,
    QueryParams(query): QueryParams<DeleteQuery>,
) -> ApiResult<StatusCode> {
    let ds = resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, false).await?;
    let expected = query.expected_updated_at.unwrap_or(ds.updated_at);
    let now = state.clock.now_ms().max(ds.updated_at + 1);
    let mut tx = crate::db::begin(&state.db).await?;
    let updated = sqlx::query(
        "UPDATE datasources SET deleted_at = $1, updated_at = $1 \
         WHERE id = $2 AND org_id = $3 AND updated_at = $4 AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(&ds.id)
    .bind(&ctx.org_id)
    .bind(expected)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        tx.rollback().await?;
        return Err(stale(&state, &ctx, &ds.id).await);
    }
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
    // Purging locks the organization too: a source is either restored or purged, never both.
    crate::authz::lock_org(&mut tx, &ctx.org_id).await?;
    let restored = sqlx::query(
        "UPDATE datasources SET deleted_at = NULL, updated_at = $1 \
         WHERE id = $2 AND org_id = $3 AND deleted_at IS NOT NULL",
    )
    .bind(now)
    .bind(&ds.id)
    .bind(&ctx.org_id)
    .execute(&mut *tx)
    .await
    .map_err(conflict_on_name)?
    .rows_affected();
    if restored != 1 {
        // Purged (or restored by someone else) since it was read.
        return Err(ApiError::not_found());
    }
    record(&mut tx, &event(&ctx, &info, "datasource.restored", &ds.id, json!({}), now)).await?;
    let restored = datasources::resolve_in_org(&mut *tx, &ctx.org_id, &ds.id).await?;
    let answer = view_in(&mut tx, &ctx, restored).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
}

/// Deletes a data source in the trash for good, with its stored secrets, its grants and the
/// Explore history of its queries. Refused while a dashboard (the trash included, it can come
/// back) or a library panel still uses it, since they would be left with a source that is gone.
/// Needs what deleting needs: `datasources:write` on the source.
async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path(path): Path<DsPath>,
) -> ApiResult<StatusCode> {
    let not_trashed = || {
        ApiError::new(StatusCode::CONFLICT, "conflict", "only data sources in the trash can be purged")
            .because("datasource.not_in_trash")
    };
    let ds = match resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, true).await {
        Ok(ds) => ds,
        // A live source the caller may change: say why, instead of "not found".
        Err(e) if e.code == "not_found" => {
            resource(&state, &ctx, &path.datasource_id, Permission::DatasourcesWrite, false).await?;
            return Err(not_trashed());
        }
        Err(e) => return Err(e),
    };
    // Deleting for good cannot be undone, so it takes the right to move targets: the org-wide
    // `datasources:write` or an admin grant on the source, not an edit grant.
    let held = resource_permissions(&state.db, &ctx, Resource::Datasource(&ds.id)).await?.unwrap_or_default();
    if !may_change_target(&ctx, &held) {
        return Err(ApiError::forbidden(
            "deleting a data source for good needs datasources:write for the organization or an admin grant on it",
        )
        .because("datasource.purge_forbidden"));
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    match purge_in(&mut tx, &ctx.org_id, &ds.id, None).await? {
        Purge::Done { name, kind } => {
            let summary = json!({ "name": name, "kind": kind });
            record(&mut tx, &event(&ctx, &info, "datasource.purged", &ds.id, summary, now)).await?;
        }
        Purge::Gone => return Err(ApiError::not_found()),
        Purge::NotTrashed { restored } => {
            tx.rollback().await?;
            return Err(if restored {
                ApiError::new(
                    StatusCode::CONFLICT,
                    "conflict",
                    "the data source was restored in the meantime; it was not deleted",
                )
                .because("datasource.not_in_trash")
            } else {
                not_trashed()
            });
        }
        Purge::InUse { dashboards, library_panels } => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "conflict",
                format!(
                    "the data source is still used by {dashboards} dashboards and {library_panels} library panels; \
                     remove it from them first"
                ),
            )
            .because("datasource.in_use")
            .param("dashboards", dashboards)
            .param("libraryPanels", library_panels));
        }
    }
    crate::db::commit(tx).await?;
    state.datasources.forget(&ds.id);
    Ok(StatusCode::NO_CONTENT)
}

/// What `purge_in` did.
enum Purge {
    /// Deleted, with what the audit entry names.
    Done { name: String, kind: String },
    /// No such source (any more).
    Gone,
    /// Not in the trash (or, for the retention, not long enough); `restored` when it was in the
    /// trash when the delete started but not at the delete itself.
    NotTrashed { restored: bool },
    /// Still used by the current version of that many dashboards (the trash included) or by
    /// library panels; nothing was changed.
    InUse { dashboards: i64, library_panels: i64 },
}

/// Deletes a trashed data source for good inside the caller's transaction: its stored secrets, its
/// grants and the Explore history of its queries go with it. Takes the organization's lock first
/// (saves of dashboards and restores take it too), so what is counted holds until the commit.
/// With `trashed_before`, only a source trashed before that time is deleted (the retention). The
/// caller writes the audit entry and commits on `Done`, and rolls back otherwise.
async fn purge_in(
    tx: &mut sqlx::AnyConnection,
    org_id: &str,
    id: &str,
    trashed_before: Option<i64>,
) -> ApiResult<Purge> {
    crate::authz::lock_org(tx, org_id).await?;
    let row: Option<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT name, kind, deleted_at FROM datasources WHERE id = $1 AND org_id = $2")
            .bind(id)
            .bind(org_id)
            .fetch_optional(&mut *tx)
            .await?;
    let (name, kind) = match row {
        None => return Ok(Purge::Gone),
        Some((_, _, None)) => return Ok(Purge::NotTrashed { restored: false }),
        Some((_, _, Some(at))) if trashed_before.is_some_and(|cutoff| at >= cutoff) => {
            return Ok(Purge::NotTrashed { restored: false });
        }
        Some((name, kind, Some(_))) => (name, kind),
    };
    // The ids are UUIDs, so the quoted id in a stored model is a reference and nothing else.
    let needle = format!("%\"{id}\"%");
    let (dashboards,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM dashboards d JOIN dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.version \
         WHERE d.org_id = $1 AND v.model LIKE $2",
    )
    .bind(org_id)
    .bind(&needle)
    .fetch_one(&mut *tx)
    .await?;
    let (library_panels,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM library_panels WHERE org_id = $1 AND model LIKE $2")
            .bind(org_id)
            .bind(&needle)
            .fetch_one(&mut *tx)
            .await?;
    if dashboards > 0 || library_panels > 0 {
        return Ok(Purge::InUse { dashboards, library_panels });
    }
    sqlx::query("DELETE FROM datasource_secrets WHERE datasource_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM explore_history WHERE datasource_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'datasource' AND resource_id = $2")
        .bind(org_id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let removed = sqlx::query("DELETE FROM datasources WHERE id = $1 AND org_id = $2 AND deleted_at IS NOT NULL")
        .bind(id)
        .bind(org_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed != 1 {
        // Restored in the meantime: the caller rolls back, so not even its secrets go.
        return Ok(Purge::NotTrashed { restored: true });
    }
    Ok(Purge::Done { name, kind })
}

/// Days a deleted data source stays in the trash before it is purged with its secrets.
pub const TRASH_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 3600 * 1000;

/// Purges the data sources that have been in the trash for longer than `TRASH_DAYS`, each in its
/// own transaction with the same checks as a purge by hand (`purge_in`) and an audit entry
/// without an actor. A source still in use is skipped with a warning and tried again on the next
/// run. Answers the number purged.
pub async fn purge_expired(state: &AppState) -> ApiResult<u64> {
    purge_expired_in(state, &state.db).await
}

async fn purge_expired_in(state: &AppState, db: &sqlx::AnyPool) -> ApiResult<u64> {
    let now = state.clock.now_ms();
    let cutoff = now.saturating_sub(TRASH_DAYS * DAY_MS);
    let expired: Vec<(String, String)> = sqlx::query_as(
        "SELECT org_id, id FROM datasources WHERE deleted_at IS NOT NULL AND deleted_at < $1 ORDER BY deleted_at",
    )
    .bind(cutoff)
    .fetch_all(db)
    .await?;
    let mut purged = 0;
    for (org_id, id) in expired {
        let mut tx = crate::db::begin(db).await?;
        match purge_in(&mut tx, &org_id, &id, Some(cutoff)).await? {
            Purge::Done { name, kind } => {
                let event = AuditEvent {
                    org_id: Some(&org_id),
                    actor_user_id: None,
                    actor_address: None,
                    action: "datasource.purged",
                    resource_type: Some("datasource"),
                    resource_id: Some(&id),
                    summary: json!({ "name": name, "kind": kind, "trashDays": TRASH_DAYS }),
                    at_ms: now,
                };
                record(&mut tx, &event).await?;
                crate::db::commit(tx).await?;
                state.datasources.forget(&id);
                purged += 1;
            }
            Purge::InUse { dashboards, library_panels } => {
                tx.rollback().await?;
                tracing::warn!(
                    datasource = %id,
                    "a data source in the trash for {TRASH_DAYS} days is still used by {dashboards} dashboards and \
                     {library_panels} library panels; it stays in the trash"
                );
            }
            // Restored or purged since the list was read: nothing to do.
            Purge::Gone | Purge::NotTrashed { .. } => tx.rollback().await?,
        }
    }
    Ok(purged)
}

/// Runs `purge_expired` every hour, like the audit retention.
pub fn spawn_trash_purge(state: AppState) {
    spawn_trash_purge_on(state, crate::db::Schedule::hourly());
}

/// `spawn_trash_purge` on another schedule (tests).
pub fn spawn_trash_purge_on(state: AppState, schedule: crate::db::Schedule) {
    use crate::db::JobError;
    let background = state.background.clone();
    crate::db::spawn_job(&background, "purging trashed data sources", schedule, move || {
        let state = state.clone();
        async move {
            match purge_expired_in(&state, state.background.db()).await {
                Ok(0) => Ok(()),
                Ok(n) => {
                    tracing::info!("purged {n} data sources that were in the trash for {TRASH_DAYS} days");
                    Ok(())
                }
                Err(e) if e.code == "busy" => Err(JobError::Busy(e.message)),
                Err(e) => Err(JobError::Failed(e.message)),
            }
        }
    });
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
