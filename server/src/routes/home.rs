//! Per-user conveniences in an organization: search across what the caller may see, starred
//! dashboards and recently viewed dashboards (docs/api/shell.md).
//!
//! Every answer is decided by the caller's current access (`AccessIndex`, the same rule as
//! `check_resource`): a star or view of a dashboard the caller can no longer see is left out, and
//! search never names a folder, dashboard or data source they could not open.

use std::cmp::Reverse;
use std::collections::HashMap;

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use super::support::{PageQuery, Paging, QueryParams, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use crate::shapes::Page;

/// Views kept per user and organization; older ones are dropped when a new one is recorded.
pub const RECENT_KEEP: i64 = 50;
/// Stars per user and organization.
pub const MAX_STARS: i64 = 1000;
/// Longest search text, in characters.
const MAX_QUERY_CHARS: usize = 100;
/// Rows read per kind for one search; an organization with more matches gets the best of these.
const SEARCH_SCAN: i64 = 10_000;

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/search", OrgMember, search),
        route(Method::GET, "/orgs/{orgId}/stars", OrgMember, list_stars),
        route(Method::GET, "/orgs/{orgId}/dashboards/{dashboardId}/star", OrgMember, get_star),
        route(Method::PUT, "/orgs/{orgId}/dashboards/{dashboardId}/star", OrgMember, star),
        route(Method::DELETE, "/orgs/{orgId}/dashboards/{dashboardId}/star", OrgMember, unstar),
        route(Method::GET, "/orgs/{orgId}/recents", OrgMember, list_recents),
        route(Method::POST, "/orgs/{orgId}/dashboards/{dashboardId}/views", OrgMember, record_view),
    ]
}

/// How well `needle` matches `hay`, both in lower case; `None` when it does not match at all.
/// Whole text, then prefix, then a substring at a word start, then any substring, then the
/// letters in order (a subsequence). The UI ranks with the same rules (`ui/src/shell/fuzzy.ts`).
pub fn fuzzy_score(needle: &str, hay: &str) -> Option<i64> {
    if needle.is_empty() {
        return Some(0);
    }
    let needle_chars: Vec<char> = needle.chars().collect();
    let hay_chars: Vec<char> = hay.chars().collect();
    let capped = |n: usize| (n as i64).min(99);
    if hay == needle {
        return Some(1000);
    }
    if hay.starts_with(needle) {
        return Some(900 - capped(hay_chars.len() - needle_chars.len()));
    }
    let word_start = |i: usize| i == 0 || !hay_chars[i - 1].is_alphanumeric();
    let mut first_at = None;
    for start in 0..hay_chars.len().saturating_sub(needle_chars.len() - 1) {
        if hay_chars[start..start + needle_chars.len()] == needle_chars[..] {
            if word_start(start) {
                return Some(800 - capped(start));
            }
            first_at.get_or_insert(start);
        }
    }
    if let Some(start) = first_at {
        return Some(700 - capped(start));
    }
    // The letters in order, each as early as possible.
    let mut score: i64 = 100;
    let mut gaps = 0;
    let mut previous: Option<usize> = None;
    let mut at = 0;
    for c in &needle_chars {
        let found = (at..hay_chars.len()).find(|&i| hay_chars[i] == *c)?;
        match previous {
            Some(p) if found == p + 1 => score += 10,
            Some(p) => gaps += found - p - 1,
            None => gaps += found,
        }
        if word_start(found) {
            score += 15;
        }
        previous = Some(found);
        at = found + 1;
    }
    Some((score - capped(gaps)).clamp(1, 599))
}

/// A LIKE pattern that matches every text containing the letters of `needle` in order, so the
/// database narrows the rows before `fuzzy_score` ranks them. `%`, `_` and `\` match themselves.
fn subsequence_pattern(needle: &str) -> String {
    let mut out = String::from("%");
    for c in needle.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
        out.push('%');
    }
    out
}

/// Folder names and parents of an organization, for the path shown next to a result.
struct FolderNames {
    rows: HashMap<String, (Option<String>, String, bool)>,
}

impl FolderNames {
    async fn load(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<Self> {
        let rows: Vec<(String, Option<String>, String, Option<i64>)> =
            sqlx::query_as("SELECT id, parent_id, name, deleted_at FROM folders WHERE org_id = $1")
                .bind(org_id)
                .fetch_all(&mut *conn)
                .await?;
        Ok(Self {
            rows: rows.into_iter().map(|(id, parent, name, deleted)| (id, (parent, name, deleted.is_some()))).collect(),
        })
    }

    /// The names from the top down to `folder_id` itself, as far up as the caller sees: a hidden
    /// folder ends the path, so nothing above it is named.
    fn path(&self, folder_id: Option<&str>, index: &AccessIndex) -> Vec<String> {
        let mut names = Vec::new();
        let mut next = folder_id.map(str::to_string);
        while let Some(id) = next {
            if names.len() > 64 || index.folder(&id).is_none() {
                break;
            }
            let Some((parent, name, _)) = self.rows.get(&id) else { break };
            names.push(name.clone());
            next = parent.clone();
        }
        names.reverse();
        names
    }
}

/// The folder as the caller sees it: `None` at the top level and when it is hidden from them.
fn visible_folder(folder_id: Option<String>, index: &AccessIndex) -> Option<String> {
    folder_id.filter(|f| index.folder(f).is_some())
}

fn may_read_dashboard(index: &AccessIndex, id: &str, folder: Option<&str>) -> bool {
    index.dashboard(id, folder).is_some_and(|p| p.contains(&Permission::DashboardsRead))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
enum HitKind {
    Dashboard,
    Folder,
    Datasource,
}

impl HitKind {
    fn parse(raw: &str) -> Option<Self> {
        match raw {
            "dashboard" => Some(Self::Dashboard),
            "folder" => Some(Self::Folder),
            "datasource" => Some(Self::Datasource),
            _ => None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    kind: HitKind,
    id: String,
    title: String,
    /// The folder a dashboard or folder lives in, as the caller sees it (`null`: top level or
    /// hidden).
    folder_id: Option<String>,
    /// Folder names from the top down to where the hit lives (for a folder: its parents).
    path: Vec<String>,
    /// The kind of a data source (`postgres`).
    #[serde(skip_serializing_if = "Option::is_none")]
    datasource_kind: Option<String>,
    /// Higher is a better match (see `fuzzy_score`); results are ordered by it.
    score: i64,
    #[serde(skip)]
    sort_title: String,
}

impl SearchHit {
    /// Best match first, then dashboards, folders, data sources, then by title and id.
    fn key(&self) -> (Reverse<i64>, HitKind, &str, &str) {
        (Reverse(self.score), self.kind, &self.sort_title, &self.id)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    q: Option<String>,
    /// Only this kind: `dashboard`, `folder` or `datasource`.
    kind: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Dashboards, folders and data sources whose title matches `q` (letters in order, any case),
/// that the caller may open: `dashboards:read` on the dashboard, `folders:read` on the folder,
/// `datasources:read` on the data source, each by role or grant and within restricted folders
/// only by a grant there. Trashed items are left out. Without `q`, everything visible.
async fn search(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<SearchQuery>,
) -> ApiResult<Json<Page<SearchHit>>> {
    let limit = page_limit(q.limit)? as usize;
    let needle = q.q.as_deref().unwrap_or("").trim().to_lowercase();
    if needle.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::validation(format!("q may have at most {MAX_QUERY_CHARS} characters")).with_field("q"));
    }
    if needle.chars().any(char::is_control) {
        return Err(ApiError::validation("q contains control characters").with_field("q"));
    }
    let only =
        match q.kind.as_deref() {
            None => None,
            Some(raw) => Some(HitKind::parse(raw).ok_or_else(|| {
                ApiError::validation("kind must be dashboard, folder or datasource").with_field("kind")
            })?),
        };
    let after: Option<(i64, HitKind, String, String)> = decode_cursor(q.cursor.as_deref())?;
    let wants = |kind: HitKind| only.is_none_or(|k| k == kind);

    let mut conn = state.db.acquire().await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    let folders = FolderNames::load(&mut conn, &ctx.org_id).await?;
    let mut hits: Vec<SearchHit> = Vec::new();

    if wants(HitKind::Dashboard) {
        // `search_title` is the title in lower case by Unicode rules, written by the server.
        let rows: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
            "SELECT id, folder_id, title, search_title FROM dashboards WHERE org_id = $1 AND deleted_at IS NULL \
             AND search_title LIKE $2 ESCAPE '\\' ORDER BY id LIMIT $3",
        )
        .bind(&ctx.org_id)
        .bind(subsequence_pattern(&needle))
        .bind(SEARCH_SCAN)
        .fetch_all(&mut *conn)
        .await?;
        for (id, folder, title, lower) in rows {
            let Some(score) = fuzzy_score(&needle, &lower) else { continue };
            if !may_read_dashboard(&index, &id, folder.as_deref()) {
                continue;
            }
            let folder_id = visible_folder(folder, &index);
            let path = folders.path(folder_id.as_deref(), &index);
            hits.push(SearchHit {
                kind: HitKind::Dashboard,
                id,
                title,
                folder_id,
                path,
                datasource_kind: None,
                score,
                sort_title: lower,
            });
        }
    }
    if wants(HitKind::Folder) {
        for (id, (parent, name, deleted)) in &folders.rows {
            if *deleted {
                continue;
            }
            let lower = name.to_lowercase();
            let Some(score) = fuzzy_score(&needle, &lower) else { continue };
            if !index.folder(id).is_some_and(|p| p.contains(&Permission::FoldersRead)) {
                continue;
            }
            let folder_id = visible_folder(parent.clone(), &index);
            let path = folders.path(folder_id.as_deref(), &index);
            hits.push(SearchHit {
                kind: HitKind::Folder,
                id: id.clone(),
                title: name.clone(),
                folder_id,
                path,
                datasource_kind: None,
                score,
                sort_title: lower,
            });
        }
    }
    if wants(HitKind::Datasource) {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, name, kind FROM datasources WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id LIMIT $2",
        )
        .bind(&ctx.org_id)
        .bind(SEARCH_SCAN)
        .fetch_all(&mut *conn)
        .await?;
        for (id, name, kind) in rows {
            let lower = name.to_lowercase();
            let Some(score) = fuzzy_score(&needle, &lower) else { continue };
            if !index.datasource(&id).is_some_and(|p| p.contains(&Permission::DatasourcesRead)) {
                continue;
            }
            hits.push(SearchHit {
                kind: HitKind::Datasource,
                id,
                title: name,
                folder_id: None,
                path: Vec::new(),
                datasource_kind: Some(kind),
                score,
                sort_title: lower,
            });
        }
    }

    hits.sort_by(|a, b| a.key().cmp(&b.key()));
    if let Some((score, kind, title, id)) = &after {
        let cursor = (Reverse(*score), *kind, title.as_str(), id.as_str());
        hits.retain(|h| h.key() > cursor);
    }
    let more = hits.len() > limit;
    hits.truncate(limit);
    let next_cursor = match hits.last() {
        Some(last) if more => Some(encode_cursor(&(last.score, last.kind, &last.sort_title, &last.id))),
        _ => None,
    };
    Ok(Json(Page { items: hits, next_cursor }))
}

impl<'de> Deserialize<'de> for HitKind {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::parse(&raw).ok_or_else(|| serde::de::Error::custom("unknown kind"))
    }
}

/// A starred or recently viewed dashboard.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardEntry {
    id: String,
    title: String,
    folder_id: Option<String>,
    path: Vec<String>,
    /// When it was starred, or last opened.
    at: i64,
}

/// The dashboard in the path, if the caller may read it (`not_found` otherwise), with its trash
/// time.
async fn readable(state: &AppState, ctx: &OrgCtx, id: &str) -> ApiResult<Option<i64>> {
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
        .bind(&ctx.org_id)
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
    let Some((deleted_at,)) = row else { return Err(ApiError::not_found()) };
    authz::check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(id)).await?;
    Ok(deleted_at)
}

/// Rows of `(dashboard id, folder id, title, at)` that the caller may read, as entries.
fn entries(
    rows: Vec<(String, Option<String>, String, i64)>,
    index: &AccessIndex,
    folders: &FolderNames,
) -> Vec<DashboardEntry> {
    rows.into_iter()
        .filter(|(id, folder, _, _)| may_read_dashboard(index, id, folder.as_deref()))
        .map(|(id, folder, title, at)| {
            let folder_id = visible_folder(folder, index);
            let path = folders.path(folder_id.as_deref(), index);
            DashboardEntry { id, title, folder_id, path, at }
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StarState {
    starred: bool,
}

async fn get_star(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<StarState>> {
    readable(&state, &ctx, &id).await?;
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT created_at FROM dashboard_stars WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(StarState { starred: row.is_some() }))
}

/// Stars a dashboard the caller may read. Starring it again changes nothing.
async fn star(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    if readable(&state, &ctx, &id).await?.is_some() {
        return Err(conflict("the dashboard is in the trash; restore it first"));
    }
    let mut tx = crate::db::begin(&state.db).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM dashboard_stars WHERE user_id = $1 AND org_id = $2")
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .fetch_one(&mut *tx)
        .await?;
    if count >= MAX_STARS {
        return Err(ApiError::validation(format!("at most {MAX_STARS} dashboards can be starred")));
    }
    sqlx::query(
        "INSERT INTO dashboard_stars (user_id, org_id, dashboard_id, created_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (user_id, dashboard_id) DO NOTHING",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&id)
    .bind(state.clock.now_ms())
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Removes the caller's own star; also for a dashboard they can no longer see, and without an
/// answer that tells whether there was one.
async fn unstar(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query("DELETE FROM dashboard_stars WHERE user_id = $1 AND org_id = $2 AND dashboard_id = $3")
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The caller's starred dashboards they may still read, not in the trash, by title.
async fn list_stars(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<DashboardEntry>>> {
    let limit = page_limit(q.limit)? as usize;
    let after: Option<(String, String)> = decode_cursor(q.cursor.as_deref())?;
    let mut conn = state.db.acquire().await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    let folders = FolderNames::load(&mut conn, &ctx.org_id).await?;
    // At most `MAX_STARS` rows, filtered in memory by the access index, so pages stay full.
    let rows: Vec<(String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT d.id, d.folder_id, d.title, s.created_at FROM dashboard_stars s \
         JOIN dashboards d ON d.id = s.dashboard_id AND d.org_id = s.org_id \
         WHERE s.user_id = $1 AND s.org_id = $2 AND d.deleted_at IS NULL ORDER BY d.search_title, d.id",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut items = entries(rows, &index, &folders);
    let sort_key = |e: &DashboardEntry| (e.title.to_lowercase(), e.id.clone());
    if let Some(after) = after {
        items.retain(|e| sort_key(e) > after);
    }
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&sort_key(last))),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

/// Records that the caller opened a dashboard they may read, keeping the newest `RECENT_KEEP`
/// per user and organization.
async fn record_view(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    readable(&state, &ctx, &id).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "INSERT INTO dashboard_views (user_id, org_id, dashboard_id, viewed_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (user_id, dashboard_id) DO UPDATE SET viewed_at = excluded.viewed_at",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(&id)
    .bind(state.clock.now_ms())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM dashboard_views WHERE user_id = $1 AND org_id = $2 AND dashboard_id NOT IN \
         (SELECT dashboard_id FROM dashboard_views WHERE user_id = $1 AND org_id = $2 \
          ORDER BY viewed_at DESC, dashboard_id DESC LIMIT $3)",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(RECENT_KEEP)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The dashboards the caller opened last that they may still read, not in the trash, newest
/// first.
async fn list_recents(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<PageQuery>,
) -> ApiResult<Json<Page<DashboardEntry>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let mut conn = state.db.acquire().await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    let folders = FolderNames::load(&mut conn, &ctx.org_id).await?;
    let rows: Vec<(String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT d.id, d.folder_id, d.title, v.viewed_at FROM dashboard_views v \
         JOIN dashboards d ON d.id = v.dashboard_id AND d.org_id = v.org_id \
         WHERE v.user_id = $1 AND v.org_id = $2 AND d.deleted_at IS NULL \
         AND (v.viewed_at < $3 OR (v.viewed_at = $3 AND d.id < $4)) \
         ORDER BY v.viewed_at DESC, d.id DESC",
    )
    .bind(&ctx.user.id)
    .bind(&ctx.org_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .fetch_all(&mut *conn)
    .await?;
    let items = entries(rows, &index, &folders);
    Ok(Json(paging.page(items, |e| (e.at, e.id.as_str()))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn better_matches_score_higher() {
        let s = |needle: &str, hay: &str| fuzzy_score(needle, hay);
        assert_eq!(s("", "anything"), Some(0));
        assert_eq!(s("umsatz", "umsatz"), Some(1000));
        let ranked = [
            s("ums", "umsatz").unwrap(),
            s("ums", "monat umsatz").unwrap(),
            s("ums", "kumsatz").unwrap(),
            s("umz", "umsatz").unwrap(),
        ];
        assert!(ranked.windows(2).all(|w| w[0] > w[1]), "{ranked:?}");
        assert_eq!(s("xyz", "umsatz"), None);
        assert_eq!(s("zu", "umsatz"), None, "letters must come in order");
        // Word starts count: "Server Logs" beats a scattered match of the same letters.
        assert!(s("sl", "server logs").unwrap() > s("sl", "basel").unwrap_or(0));
        // Umlauts are letters like any other.
        assert_eq!(s("über", "übersicht"), Some(895));
    }

    #[test]
    fn subsequence_patterns_escape_wildcards() {
        assert_eq!(subsequence_pattern("a%_"), "%a%\\%%\\_%");
        assert_eq!(subsequence_pattern(""), "%");
    }
}
