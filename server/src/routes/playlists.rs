//! Playlists: dashboards shown one after another on an interval, for wall screens. Documented in
//! docs/api/dashboard-features.md.
//!
//! Reading and playing need `dashboards:read`, changing needs `dashboards:write` (org-wide). A
//! playlist names dashboards and tags; whoever reads or plays it gets only the dashboards they may
//! read, so a playlist never shows or names a dashboard to someone who may not see it. Entries
//! hidden from the caller stay in the playlist when they save it.

use std::collections::BTreeSet;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::new_id;
use super::support::{Actor, PageQuery, QueryParams, audit, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use super::clean_name;
use crate::app::AppState;
use crate::authz::{Access, AccessIndex, OrgCtx, Permission};
use crate::dashboards::model;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

const MIN_INTERVAL_SECONDS: i64 = 10;
const MAX_INTERVAL_SECONDS: i64 = 24 * 3600;
const MAX_ITEMS: usize = 100;

pub fn routes() -> Vec<RouteDef> {
    use Permission::{DashboardsRead, DashboardsWrite};
    vec![
        route(Method::GET, "/orgs/{orgId}/playlists", Access::Org(DashboardsRead), list),
        route(Method::POST, "/orgs/{orgId}/playlists", Access::Org(DashboardsWrite), create),
        route(Method::GET, "/orgs/{orgId}/playlists/{playlistId}", Access::Org(DashboardsRead), get_one),
        route(Method::PUT, "/orgs/{orgId}/playlists/{playlistId}", Access::Org(DashboardsWrite), save),
        route(Method::DELETE, "/orgs/{orgId}/playlists/{playlistId}", Access::Org(DashboardsWrite), remove),
        route(Method::GET, "/orgs/{orgId}/playlists/{playlistId}/play", Access::Org(DashboardsRead), play),
    ]
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Item {
    #[serde(rename_all = "camelCase")]
    Dashboard { dashboard_id: String },
    /// Every dashboard with this tag, by title.
    Tag { tag: String },
}

#[derive(Clone, Debug, sqlx::FromRow)]
struct PlaylistRow {
    id: String,
    name: String,
    interval_seconds: i64,
    items: String,
    version: i64,
    created_at: i64,
    updated_by: Option<String>,
    updated_at: i64,
}

const COLUMNS: &str = "id, name, interval_seconds, items, version, created_at, updated_by, updated_at";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    id: String,
    name: String,
    interval_seconds: i64,
    /// Entries naming a dashboard the caller cannot see are left out.
    items: Vec<Item>,
    version: i64,
    created_at: i64,
    updated_by: Option<String>,
    updated_at: i64,
}

/// The dashboards the caller may read, by id with their title; trashed ones are left out.
struct Readable {
    dashboards: std::collections::HashMap<String, String>,
}

impl Readable {
    async fn load(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx) -> ApiResult<Self> {
        let index = AccessIndex::load(conn, ctx).await?;
        let rows: Vec<(String, Option<String>, String)> =
            sqlx::query_as("SELECT id, folder_id, title FROM dashboards WHERE org_id = $1 AND deleted_at IS NULL")
                .bind(&ctx.org_id)
                .fetch_all(&mut *conn)
                .await?;
        let dashboards = rows
            .into_iter()
            .filter(|(id, folder, _)| {
                index.dashboard(id, folder.as_deref()).is_some_and(|held| held.contains(&Permission::DashboardsRead))
            })
            .map(|(id, _, title)| (id, title))
            .collect();
        Ok(Self { dashboards })
    }

    fn sees(&self, item: &Item) -> bool {
        match item {
            Item::Dashboard { dashboard_id } => self.dashboards.contains_key(dashboard_id),
            Item::Tag { .. } => true,
        }
    }
}

fn stored_items(raw: &str) -> ApiResult<Vec<Item>> {
    serde_json::from_str(raw).map_err(|e| ApiError::internal("playlists", e))
}

fn view(row: PlaylistRow, readable: &Readable) -> ApiResult<Playlist> {
    let items = stored_items(&row.items)?.into_iter().filter(|i| readable.sees(i)).collect();
    Ok(Playlist {
        id: row.id,
        name: row.name,
        interval_seconds: row.interval_seconds,
        items,
        version: row.version,
        created_at: row.created_at,
        updated_by: row.updated_by,
        updated_at: row.updated_at,
    })
}

async fn fetch(conn: &mut sqlx::AnyConnection, org_id: &str, id: &str) -> ApiResult<Option<PlaylistRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM playlists WHERE org_id = $1 AND id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

/// Checks name, interval and items; a dashboard the caller cannot read counts as missing.
fn check(name: &str, interval: i64, items: &[Item], readable: &Readable) -> ApiResult<String> {
    let name = clean_name(name, "name").map_err(|e| e.with_field("name"))?;
    if !(MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&interval) {
        return Err(ApiError::validation(format!(
            "intervalSeconds must be {MIN_INTERVAL_SECONDS} to {MAX_INTERVAL_SECONDS}"
        ))
        .with_field("intervalSeconds"));
    }
    if items.len() > MAX_ITEMS {
        return Err(ApiError::validation(format!("items takes at most {MAX_ITEMS} entries")).with_field("items"));
    }
    for (i, item) in items.iter().enumerate() {
        match item {
            Item::Dashboard { dashboard_id } if !readable.sees(item) => {
                return Err(ApiError::validation(format!("items[{i}]: dashboard {dashboard_id} does not exist"))
                    .with_field("items"));
            }
            Item::Tag { tag } => {
                model::check_tag(&format!("items[{i}].tag"), tag)
                    .map_err(|e| ApiError::validation(e).with_field("items"))?;
            }
            Item::Dashboard { .. } => {}
        }
    }
    Ok(name)
}

/// Ordered by name, then id.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<Playlist>>> {
    let limit = page_limit(q.limit)? as usize;
    let after: Option<(String, String)> = decode_cursor(q.cursor.as_deref())?;
    let (after_name, after_id) = after.unzip();
    let mut conn = state.db.acquire().await?;
    let rows: Vec<PlaylistRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {COLUMNS} FROM playlists WHERE org_id = $1 \
         AND (CAST($2 AS TEXT) IS NULL OR name > $2 OR (name = $2 AND id > $3)) ORDER BY name, id LIMIT $4"
    )))
    .bind(&ctx.org_id)
    .bind(after_name.as_deref())
    .bind(after_id.as_deref())
    .bind(limit as i64 + 1)
    .fetch_all(&mut *conn)
    .await?;
    let readable = Readable::load(&mut conn, &ctx).await?;
    let mut items = rows.into_iter().map(|r| view(r, &readable)).collect::<ApiResult<Vec<_>>>()?;
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&(&last.name, &last.id))),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePlaylist {
    name: String,
    interval_seconds: i64,
    #[serde(default)]
    items: Vec<Item>,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreatePlaylist>,
) -> ApiResult<impl IntoResponse> {
    let readable = Readable::load(&mut *state.db.acquire().await?, &ctx).await?;
    let name = check(&body.name, body.interval_seconds, &body.items, &readable)?;
    let items = serde_json::to_string(&body.items).map_err(|e| ApiError::internal("playlists", e))?;
    let id = new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO playlists (id, org_id, name, interval_seconds, items, version, created_by, created_at, \
         updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $6, $7)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&name)
    .bind(body.interval_seconds)
    .bind(&items)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "playlist.created", ("playlist", &id), json!({})).await?;
    let row = fetch(&mut tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(row, &readable)?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(answer)))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Playlist>> {
    let mut conn = state.db.acquire().await?;
    let row = fetch(&mut conn, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let readable = Readable::load(&mut conn, &ctx).await?;
    Ok(Json(view(row, &readable)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavePlaylist {
    version: i64,
    name: String,
    interval_seconds: i64,
    items: Vec<Item>,
}

async fn save(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<SavePlaylist>,
) -> ApiResult<Json<Playlist>> {
    let mut conn = state.db.acquire().await?;
    let row = fetch(&mut conn, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let readable = Readable::load(&mut conn, &ctx).await?;
    drop(conn);
    let name = check(&body.name, body.interval_seconds, &body.items, &readable)?;
    if body.version != row.version {
        return Err(ApiError::version_conflict(json!(view(row, &readable)?)));
    }
    // Entries the caller cannot see were not sent back; they stay, after the caller's own.
    let hidden: Vec<Item> = stored_items(&row.items)?.into_iter().filter(|i| !readable.sees(i)).collect();
    let mut items = body.items;
    items.extend(hidden);
    let items = serde_json::to_string(&items).map_err(|e| ApiError::internal("playlists", e))?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let updated = sqlx::query(
        "UPDATE playlists SET name = $1, interval_seconds = $2, items = $3, version = version + 1, updated_by = $4, \
         updated_at = $5 WHERE org_id = $6 AND id = $7 AND version = $8",
    )
    .bind(&name)
    .bind(body.interval_seconds)
    .bind(&items)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&ctx.org_id)
    .bind(&id)
    .bind(row.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        drop(tx);
        let mut conn = state.db.acquire().await?;
        let current = fetch(&mut conn, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
        return Err(ApiError::version_conflict(json!(view(current, &readable)?)));
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "playlist.updated", ("playlist", &id), json!({})).await?;
    let saved = fetch(&mut tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(saved, &readable)?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
}

async fn remove(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let gone = sqlx::query("DELETE FROM playlists WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if gone == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "playlist.deleted", ("playlist", &id), json!({})).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayItem {
    id: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayOrder {
    interval_seconds: i64,
    /// The dashboards to show, in order: each once, only those the caller may read.
    items: Vec<PlayItem>,
}

async fn play(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
    // Unknown query parameters are refused, as on every route.
    QueryParams(_): QueryParams<NoParams>,
) -> ApiResult<Json<PlayOrder>> {
    let mut conn = state.db.acquire().await?;
    let row = fetch(&mut conn, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let readable = Readable::load(&mut conn, &ctx).await?;
    let mut seen = BTreeSet::new();
    let mut items = Vec::new();
    for item in stored_items(&row.items)? {
        let ids: Vec<String> = match item {
            Item::Dashboard { dashboard_id } => vec![dashboard_id],
            Item::Tag { tag } => {
                let tagged: Vec<(String,)> = sqlx::query_as(
                    "SELECT d.id FROM dashboard_tags t JOIN dashboards d ON d.id = t.dashboard_id \
                     WHERE t.org_id = $1 AND t.tag_key = $2 ORDER BY d.title, d.id",
                )
                .bind(&ctx.org_id)
                .bind(tag.to_lowercase())
                .fetch_all(&mut *conn)
                .await?;
                tagged.into_iter().map(|(id,)| id).collect()
            }
        };
        for dashboard in ids {
            if let Some(title) = readable.dashboards.get(&dashboard)
                && seen.insert(dashboard.clone())
            {
                items.push(PlayItem { id: dashboard, title: title.clone() });
            }
        }
    }
    Ok(Json(PlayOrder { interval_seconds: row.interval_seconds, items }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoParams {}

