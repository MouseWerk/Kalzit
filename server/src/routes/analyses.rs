//! Saved analyses (docs/api/analyses.md): list, create, read, save with the version check and the
//! version history, trash, restore, purge, owner, the dashboards that link one, and running the
//! stored queries.
//!
//! Analyses live in folders and follow the dashboards' rules: access is decided per analysis
//! (`authz::check_resource`, `Resource::Analysis`), so folder grants, grants on the analysis,
//! restricted folders, team spaces and team ownership all count; what lives at the top level,
//! outside every folder, needs the org-wide permission. Reading takes `analyses:read`, every
//! change `analyses:write`, sharing (owner and grants) `dashboards:share`.
//!
//! Stored queries: as with a dashboard, reading the analysis is what authorizes running its
//! queries (`POST .../query`). Saving required `datasources:query` on every data source its new
//! or changed queries use (`saved_analyses::check_sources`), so a viewer reaches only sources an
//! authorized editor put there, and only with the stored queries. Changing a query to run it is
//! a free query (`POST /orgs/{orgId}/query`), which needs `datasources:query` of its own.
//!
//! Dashboards may link an analysis (`saved_analyses`); while any does (trashed dashboards
//! included), the analysis stays out of the trash and out of other teams' reach.

use std::collections::{BTreeSet, HashMap};

use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::dashboards::{check_space_move, like_contains, lock_place};
use super::folders::{
    OwnedItem, OwnerRequest, OwnerTeam, ResourceAccess, Visibility, check_owner_change, double_option, keep_access,
};
use super::new_id;
use super::support::{QueryParams, conflict, decode_cursor, encode_cursor, page_limit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::authz::{self, Access, AccessIndex, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::folders::{self, Tree};
use crate::net::RequestInfo;
use crate::saved_analyses::{self, AnalysisModel};
use crate::settings;
use crate::shapes::{FieldDistribution, Page, PanelDistributionRequest, PanelQueryRequest, QueryResponse};

pub fn routes() -> Vec<RouteDef> {
    use Access::OrgMember;
    vec![
        route(Method::GET, "/orgs/{orgId}/analyses", Access::Org(Permission::AnalysesRead), list),
        route(Method::POST, "/orgs/{orgId}/analyses", OrgMember, create),
        route(Method::GET, "/orgs/{orgId}/analyses/{analysisId}", OrgMember, get_one),
        route(Method::PUT, "/orgs/{orgId}/analyses/{analysisId}", OrgMember, save),
        route(Method::DELETE, "/orgs/{orgId}/analyses/{analysisId}", OrgMember, trash),
        route(Method::POST, "/orgs/{orgId}/analyses/{analysisId}/restore", OrgMember, restore),
        route(Method::DELETE, "/orgs/{orgId}/analyses/{analysisId}/purge", OrgMember, purge),
        route(Method::PUT, "/orgs/{orgId}/analyses/{analysisId}/owner", OrgMember, set_owner),
        route(Method::GET, "/orgs/{orgId}/analyses/{analysisId}/uses", OrgMember, uses),
        route(Method::GET, "/orgs/{orgId}/analyses/{analysisId}/versions", OrgMember, versions),
        route(Method::GET, "/orgs/{orgId}/analyses/{analysisId}/versions/{version}", OrgMember, version),
        route(
            Method::POST,
            "/orgs/{orgId}/analyses/{analysisId}/versions/{version}/restore",
            OrgMember,
            restore_version,
        ),
        // `analyses:read` on the analysis decides, checked in the handler.
        route(Method::POST, "/orgs/{orgId}/analyses/{analysisId}/query", OrgMember, run),
        route(Method::POST, "/orgs/{orgId}/analyses/{analysisId}/distribution", OrgMember, distribution),
    ]
}

#[derive(Clone, Debug, sqlx::FromRow)]
struct AnalysisRow {
    id: String,
    folder_id: Option<String>,
    title: String,
    body: String,
    version: i64,
    created_by: Option<String>,
    created_by_name: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_by_name: Option<String>,
    updated_at: i64,
    deleted_at: Option<i64>,
    owner_team_id: Option<String>,
    team_only: i64,
}

/// The names are read from the accounts as they are now: `NULL` once an account is gone.
const COLUMNS: &str = "id, folder_id, title, body, version, created_by, \
     (SELECT u.name FROM users u WHERE u.id = analyses.created_by) AS created_by_name, created_at, updated_by, \
     (SELECT u.name FROM users u WHERE u.id = analyses.updated_by) AS updated_by_name, updated_at, \
     deleted_at, owner_team_id, team_only";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisSummary {
    id: String,
    /// `null` at the top level, and when the caller cannot see the folder (they reach the
    /// analysis through a grant on it alone).
    folder_id: Option<String>,
    title: String,
    version: i64,
    created_by: Option<String>,
    /// The creator's display name; `null` when the account no longer exists.
    created_by_name: Option<String>,
    created_at: i64,
    updated_at: i64,
    updated_by: Option<String>,
    /// The display name of who saved last; `null` when the account no longer exists.
    updated_by_name: Option<String>,
    deleted_at: Option<i64>,
    access: ResourceAccess,
    /// The team that owns the analysis; `null` when it belongs to the organization.
    owner_team: Option<OwnerTeam>,
    /// Only the owner team, grants on the analysis and org admins see it.
    team_only: bool,
    /// The data sources its queries use.
    datasource_ids: Vec<String>,
    /// Whether the caller may query every one of them (`datasources:query`), so change and run
    /// its queries as their own. Running the stored analysis needs only reading it.
    may_query: bool,
    /// How many dashboards the caller may read link it (trashed ones included); others are not
    /// counted, so the number tells nothing about content the caller cannot see.
    uses: i64,
}

/// The parts of an answer that come from other tables: data sources and uses, per analysis.
#[derive(Default)]
struct Extras {
    sources: HashMap<String, Vec<String>>,
    uses: HashMap<String, i64>,
}

impl Extras {
    /// For the analyses `ids` (one answer, or one page of a list), read through `conn`.
    async fn load(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, index: &AccessIndex, ids: &[&str]) -> ApiResult<Self> {
        let mut out = Extras::default();
        if ids.is_empty() {
            return Ok(out);
        }
        // `$2` onwards, one per id: numbers only, so nothing from the request reaches the SQL.
        let list = (0..ids.len()).map(|i| format!("${}", i + 2)).collect::<Vec<_>>().join(", ");
        let sql = format!(
            "SELECT analysis_id, datasource_id FROM analysis_sources WHERE org_id = $1 \
             AND analysis_id IN ({list}) ORDER BY analysis_id, datasource_id"
        );
        let mut query = sqlx::query_as::<_, (String, String)>(sqlx::AssertSqlSafe(sql)).bind(&ctx.org_id);
        for id in ids {
            query = query.bind(*id);
        }
        for (analysis, source) in query.fetch_all(&mut *conn).await? {
            out.sources.entry(analysis).or_default().push(source);
        }
        let sql = format!(
            "SELECT u.analysis_id, d.id, d.folder_id FROM analysis_uses u JOIN dashboards d ON d.id = u.dashboard_id \
             WHERE d.org_id = $1 AND u.analysis_id IN ({list})"
        );
        let mut query =
            sqlx::query_as::<_, (String, String, Option<String>)>(sqlx::AssertSqlSafe(sql)).bind(&ctx.org_id);
        for id in ids {
            query = query.bind(*id);
        }
        for (analysis, dashboard, folder) in query.fetch_all(&mut *conn).await? {
            if index.dashboard(&dashboard, folder.as_deref()).is_some_and(|p| p.contains(&Permission::DashboardsRead)) {
                *out.uses.entry(analysis).or_insert(0) += 1;
            }
        }
        Ok(out)
    }
}

/// (analysis, dashboard, the dashboard's folder) for every dashboard linking the analysis,
/// trashed ones included.
async fn using_dashboards(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    id: &str,
) -> ApiResult<Vec<(String, String, Option<String>)>> {
    Ok(sqlx::query_as(
        "SELECT u.analysis_id, d.id, d.folder_id FROM analysis_uses u JOIN dashboards d ON d.id = u.dashboard_id \
         WHERE d.org_id = $1 AND u.analysis_id = $2",
    )
    .bind(org_id)
    .bind(id)
    .fetch_all(&mut *conn)
    .await?)
}

impl AnalysisSummary {
    fn new(r: &AnalysisRow, index: &AccessIndex, extras: &Extras) -> Self {
        let datasource_ids = extras.sources.get(&r.id).cloned().unwrap_or_default();
        let may_query = datasource_ids
            .iter()
            .all(|ds| index.datasource(ds).is_some_and(|held| held.contains(&Permission::DatasourcesQuery)));
        Self {
            id: r.id.clone(),
            folder_id: visible_folder(r, index),
            title: r.title.clone(),
            version: r.version,
            created_by: r.created_by.clone(),
            created_by_name: r.created_by_name.clone(),
            created_at: r.created_at,
            updated_at: r.updated_at,
            updated_by: r.updated_by.clone(),
            updated_by_name: r.updated_by_name.clone(),
            deleted_at: r.deleted_at,
            access: ResourceAccess::analysis(index.analysis(&r.id, r.folder_id.as_deref())),
            owner_team: OwnerTeam::of(r.owner_team_id.as_deref(), index),
            team_only: r.team_only != 0,
            datasource_ids,
            may_query,
            uses: extras.uses.get(&r.id).copied().unwrap_or(0),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    #[serde(flatten)]
    summary: AnalysisSummary,
    /// Migrated to the current `schemaVersion`.
    model: Value,
}

/// The folder as the caller sees it: `None` when it is hidden from them.
fn visible_folder(row: &AnalysisRow, index: &AccessIndex) -> Option<String> {
    row.folder_id.clone().filter(|f| index.folder(f).is_some())
}

fn event<'a>(
    ctx: &'a OrgCtx,
    info: &RequestInfo,
    action: &'a str,
    id: &'a str,
    summary: Value,
    now: i64,
) -> AuditEvent<'a> {
    AuditEvent {
        org_id: Some(&ctx.org_id),
        actor_user_id: Some(&ctx.user.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("analysis"),
        resource_id: Some(id),
        summary,
        at_ms: now,
    }
}

async fn fetch<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: &str,
    id: &str,
) -> ApiResult<Option<AnalysisRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM analyses WHERE org_id = $1 AND id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

/// The analysis in the path, if the caller sees it (`not_found` otherwise, also inside a
/// restricted folder without access) and may do `permission` on it.
async fn load(state: &AppState, ctx: &OrgCtx, id: &str, permission: Permission) -> ApiResult<AnalysisRow> {
    let row = fetch(&state.db, &ctx.org_id, id).await?.ok_or_else(ApiError::not_found)?;
    authz::check_resource(&state.db, ctx, permission, Resource::Analysis(id)).await?;
    Ok(row)
}

/// Before the transaction: the caller may put analyses into `folder` (`None`: the top level,
/// which takes the org-wide permission).
async fn authorize_place(state: &AppState, ctx: &OrgCtx, folder: Option<&str>) -> ApiResult<()> {
    match folder {
        Some(folder) => {
            authz::check_resource(&state.db, ctx, Permission::AnalysesWrite, Resource::Folder(folder)).await
        }
        None => ctx.check(Permission::AnalysesWrite),
    }
}

/// The stored model, migrated to the current `schemaVersion`. A model this server cannot read
/// (written by a newer version) is an operator problem.
fn stored_value(raw: &str) -> ApiResult<Value> {
    let value: Value = serde_json::from_str(raw).map_err(|e| ApiError::internal("analyses", e))?;
    saved_analyses::migrate(value).map_err(|e| ApiError::internal("analyses", e))
}

fn parse_model(raw: Value) -> ApiResult<AnalysisModel> {
    saved_analyses::parse(raw).map_err(|e| ApiError::validation(e).with_field("model"))
}

fn model_text(model: &AnalysisModel) -> ApiResult<String> {
    serde_json::to_string(model).map_err(|e| ApiError::internal("analyses", e))
}

/// The answer for one analysis, read through `conn`: after a change, the change's own transaction
/// before its commit, so a failing read can still be answered as "nothing changed".
async fn view(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx, row: AnalysisRow) -> ApiResult<Analysis> {
    let index = AccessIndex::load(conn, ctx).await?;
    let extras = Extras::load(conn, ctx, &index, &[row.id.as_str()]).await?;
    let model = stored_value(&row.body)?;
    Ok(Analysis { summary: AnalysisSummary::new(&row, &index, &extras), model })
}

/// `view` on a pooled connection, where no change is involved.
async fn pool_view(state: &AppState, ctx: &OrgCtx, row: AnalysisRow) -> ApiResult<Analysis> {
    view(&mut *state.db.acquire().await?, ctx, row).await
}

/// `409 conflict`, reason `analysis.in_use`: dashboards link the analysis. `dashboards` counts
/// those the caller may read; the others are not counted, as in the list.
fn in_use(message: &str, visible: i64) -> ApiError {
    conflict(message).because("analysis.in_use").param("dashboards", visible)
}

/// Inside a transaction that holds the organization's lock: refuses with `analysis.in_use` while
/// any dashboard links the analysis (trashed dashboards included), or with `placed` set (the
/// analysis's folder and team-only flag after the change), any dashboard whose audience it would
/// no longer fit (`saved_analyses::audience_fits`).
async fn check_unused(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    id: &str,
    placed: Option<(Option<&str>, bool)>,
    message: &str,
) -> ApiResult<()> {
    let users = using_dashboards(&mut *conn, &ctx.org_id, id).await?;
    let blocking: Vec<&(String, String, Option<String>)> = match placed {
        None => users.iter().collect(),
        Some((folder, team_only)) => {
            let tree = Tree::load(&mut *conn, ctx).await?;
            users
                .iter()
                .filter(|(_, _, dashboard_folder)| {
                    !saved_analyses::audience_fits(&tree, folder, team_only, dashboard_folder.as_deref())
                })
                .collect()
        }
    };
    if blocking.is_empty() {
        return Ok(());
    }
    let index = AccessIndex::load(&mut *conn, ctx).await?;
    let visible = blocking
        .iter()
        .filter(|(_, d, folder)| {
            index.dashboard(d, folder.as_deref()).is_some_and(|p| p.contains(&Permission::DashboardsRead))
        })
        .count();
    Err(in_use(message, visible as i64))
}

/// How many versions to keep per analysis (0: all): the dashboards' setting, read before the
/// transaction opens.
async fn version_retention(state: &AppState) -> ApiResult<i64> {
    Ok(settings::get(state, "dashboards.version_retention").await?.as_i64().unwrap_or(0))
}

/// Writes the current state as a new row of the history, records its data sources and drops
/// versions beyond `keep`.
#[allow(clippy::too_many_arguments)]
async fn record_version(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    id: &str,
    version: i64,
    model: &AnalysisModel,
    text: &str,
    restored_from: Option<i64>,
    keep: i64,
    now: i64,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO analysis_versions (analysis_id, version, body, author_id, restored_from, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(version)
    .bind(text)
    .bind(&ctx.user.id)
    .bind(restored_from)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    if keep > 0 {
        sqlx::query("DELETE FROM analysis_versions WHERE analysis_id = $1 AND version <= $2")
            .bind(id)
            .bind(version - keep)
            .execute(&mut *conn)
            .await?;
    }
    saved_analyses::sync_sources(conn, &ctx.org_id, id, model).await
}

/// Deletes the saved analyses of one folder with their grants, inside the caller's transaction
/// (a folder's purge). Answers how many went.
pub(super) async fn purge_in_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<u64> {
    // Analyses that once were team only or lived in a restricted folder keep their events hidden.
    sqlx::query(
        "INSERT INTO restricted_tombstones (org_id, resource_type, resource_id) \
         SELECT a.org_id, 'analysis', a.id FROM analyses a WHERE a.org_id = $1 AND a.folder_id = $2 \
         AND (a.ever_restricted = 1 OR a.team_only = 1) AND NOT EXISTS (SELECT 1 FROM restricted_tombstones t \
         WHERE t.org_id = a.org_id AND t.resource_type = 'analysis' AND t.resource_id = a.id)",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    for sql in [
        "DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'analysis' AND resource_id IN \
         (SELECT id FROM analyses WHERE org_id = $1 AND folder_id = $2)",
        "DELETE FROM analysis_uses WHERE org_id = $1 AND analysis_id IN \
         (SELECT id FROM analyses WHERE org_id = $1 AND folder_id = $2)",
        "DELETE FROM analysis_versions WHERE analysis_id IN (SELECT id FROM analyses WHERE org_id = $1 AND folder_id = $2)",
        "DELETE FROM analysis_sources WHERE org_id = $1 AND analysis_id IN \
         (SELECT id FROM analyses WHERE org_id = $1 AND folder_id = $2)",
    ] {
        sqlx::query(sql).bind(org_id).bind(folder_id).execute(&mut *conn).await?;
    }
    let gone = sqlx::query("DELETE FROM analyses WHERE org_id = $1 AND folder_id = $2")
        .bind(org_id)
        .bind(folder_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    Ok(gone)
}

/// Inside a folder's trash or purge, after the organization's lock: no dashboard outside the
/// subtree (`folders`, whose dashboards go along) links an analysis inside it, since that
/// dashboard would be left showing nothing (`409`, reason `analysis.in_use`).
pub(super) async fn check_subtree_unused(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    folders: &BTreeSet<String>,
) -> ApiResult<()> {
    let links: Vec<(Option<String>, String, Option<String>)> = sqlx::query_as(
        "SELECT a.folder_id, d.id, d.folder_id FROM analysis_uses u JOIN analyses a ON a.id = u.analysis_id \
         JOIN dashboards d ON d.id = u.dashboard_id WHERE a.org_id = $1 AND a.folder_id IS NOT NULL",
    )
    .bind(&ctx.org_id)
    .fetch_all(&mut *conn)
    .await?;
    let inside = |f: &Option<String>| f.as_ref().is_some_and(|f| folders.contains(f));
    let blocking: Vec<_> = links.iter().filter(|(a, _, d)| inside(a) && !inside(d)).collect();
    if blocking.is_empty() {
        return Ok(());
    }
    let index = AccessIndex::load(&mut *conn, ctx).await?;
    let visible = blocking
        .iter()
        .filter(|(_, d, folder)| {
            index.dashboard(d, folder.as_deref()).is_some_and(|p| p.contains(&Permission::DashboardsRead))
        })
        .count();
    Err(in_use("dashboards outside the folder show analyses inside it; remove them from those first", visible as i64))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Sort {
    /// By title, then id (the default).
    #[default]
    Title,
    /// Newest change first, then id.
    Updated,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    folder_id: Option<String>,
    /// Part of the title, any case.
    q: Option<String>,
    /// `true` lists the trash instead.
    trashed: Option<bool>,
    /// A team context: only analyses outside other teams' spaces, in the team's own spaces and
    /// what was shared with the team (see `folders::TeamScope`).
    team: Option<String>,
    /// Only analyses whose queries use this data source.
    datasource_id: Option<String>,
    /// Only analyses this user created.
    created_by: Option<String>,
    /// Only analyses this team owns.
    owner_team_id: Option<String>,
    #[serde(default)]
    sort: Sort,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Ordered by title or by the last change. Analyses the caller does not see are left out by the
/// query itself, so every page is full.
async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<AnalysisSummary>>> {
    let limit = page_limit(q.limit)? as usize;
    // The cursor is the last row's (title, id) or (updated time, id), by the sort.
    let (after_title, after_time, after_id) = match q.sort {
        Sort::Title => {
            let after: Option<(String, String)> = decode_cursor(q.cursor.as_deref())?;
            let (t, i) = after.unzip();
            (t, None, i)
        }
        Sort::Updated => {
            let after: Option<(i64, String)> = decode_cursor(q.cursor.as_deref())?;
            let (t, i) = after.unzip();
            (None, t, i)
        }
    };
    let mut conn = state.db.acquire().await?;
    if let Some(folder) = q.folder_id.as_deref() {
        let tree = Tree::load(&mut conn, &ctx).await?;
        if !tree.rows.contains_key(folder) || !tree.visible(folder) {
            return Err(ApiError::not_found());
        }
    }
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    super::team_context::check_team(&mut conn, &ctx, q.team.as_deref()).await?;
    // Lower case by Unicode rules on both sides: `search_title` is written by the server.
    let pattern = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| like_contains(&s.to_lowercase()));
    let (after, order) = match q.sort {
        // Each names the other sort's cursor too, which is NULL then: PostgreSQL needs every bound
        // parameter in the statement to know its type.
        Sort::Title => (
            "(CAST($8 AS TEXT) IS NULL OR title > $8 OR (title = $8 AND id > $9)) AND CAST($12 AS BIGINT) IS NULL",
            "title, id",
        ),
        Sort::Updated => (
            "(CAST($12 AS BIGINT) IS NULL OR updated_at < $12 OR (updated_at = $12 AND id < $9)) \
             AND CAST($8 AS TEXT) IS NULL",
            "updated_at DESC, id DESC",
        ),
    };
    // A team context (`$11`) leaves out other teams' spaces in the query itself, so pages stay full.
    let sql = format!(
        "{}{} SELECT {COLUMNS} FROM analyses WHERE org_id = $1 \
         AND ((CAST($5 AS BIGINT) = 1 AND deleted_at IS NOT NULL) OR (CAST($5 AS BIGINT) = 0 AND deleted_at IS NULL)) \
         AND (CAST($6 AS TEXT) IS NULL OR folder_id = $6) \
         AND (CAST($7 AS TEXT) IS NULL OR search_title LIKE $7 ESCAPE '\\') \
         AND {} \
         AND {after} \
         AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM scope_out) \
              OR id IN (SELECT resource_id FROM scope_grants WHERE resource_type = 'analysis')) \
         AND (CAST($13 AS TEXT) IS NULL OR id IN \
              (SELECT analysis_id FROM analysis_sources WHERE org_id = $1 AND datasource_id = $13)) \
         AND (CAST($14 AS TEXT) IS NULL OR created_by = $14) \
         AND (CAST($15 AS TEXT) IS NULL OR owner_team_id = $15) \
         ORDER BY {order} LIMIT $10",
        folders::VISIBILITY_CTE,
        folders::scope_cte(11),
        folders::analysis_visible("analyses"),
    );
    // Built from constants and parameter numbers only, so nothing from the request reaches the SQL.
    let rows: Vec<AnalysisRow> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
        .bind(&ctx.org_id)
        .bind(&ctx.user.id)
        .bind(&ctx.role)
        .bind(folders::sees_every_folder(&ctx))
        .bind(q.trashed.unwrap_or(false) as i64)
        .bind(q.folder_id.as_deref())
        .bind(pattern.as_deref())
        .bind(after_title.as_deref())
        .bind(after_id.as_deref())
        .bind(limit as i64 + 1)
        .bind(q.team.as_deref())
        .bind(after_time)
        .bind(q.datasource_id.as_deref())
        .bind(q.created_by.as_deref())
        .bind(q.owner_team_id.as_deref())
        .fetch_all(&mut *conn)
        .await?;
    let more = rows.len() > limit;
    let rows = &rows[..rows.len().min(limit)];
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let extras = Extras::load(&mut conn, &ctx, &index, &ids).await?;
    let items: Vec<AnalysisSummary> = rows.iter().map(|r| AnalysisSummary::new(r, &index, &extras)).collect();
    let next_cursor = match items.last() {
        Some(last) if more => Some(match q.sort {
            Sort::Title => encode_cursor(&(&last.title, &last.id)),
            Sort::Updated => encode_cursor(&(last.updated_at, &last.id)),
        }),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAnalysis {
    #[serde(default)]
    folder_id: Option<String>,
    model: Value,
}

async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<CreateAnalysis>,
) -> ApiResult<impl IntoResponse> {
    let model = parse_model(body.model)?;
    saved_analyses::check_visualization(&model, None)?;
    authorize_place(&state, &ctx, body.folder_id.as_deref()).await?;
    saved_analyses::check_sources(&state.db, &ctx, &model, None).await?;

    let id = new_id();
    let text = model_text(&model)?;
    let keep = version_retention(&state).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_place(&mut tx, &ctx.org_id, body.folder_id.as_deref()).await?;
    sqlx::query(
        "INSERT INTO analyses (id, org_id, folder_id, title, search_title, body, version, created_by, created_at, \
         updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $7, $8)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(body.folder_id.as_deref())
    .bind(&model.title)
    .bind(model.title.to_lowercase())
    .bind(&text)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    record_version(&mut tx, &ctx, &id, 1, &model, &text, None, keep, now).await?;
    let summary = json!({ "folderId": body.folder_id, "version": 1 });
    audit::record(&mut tx, &event(&ctx, &info, "analysis.created", &id, summary, now)).await?;
    let row = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut tx, &ctx, row).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(answer)))
}

async fn get_one(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Analysis>> {
    let row = load(&state, &ctx, &id, Permission::AnalysesRead).await?;
    Ok(Json(pool_view(&state, &ctx, row).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveAnalysis {
    model: Value,
    /// The version the caller started from; a newer stored one is a `version_conflict`. To
    /// overwrite after a conflict, the caller sends the version the conflict answered; the
    /// version it replaces stays in the history.
    version: i64,
    /// Moves the analysis; `null` is the top level, a missing field keeps the folder.
    #[serde(default, deserialize_with = "double_option")]
    folder_id: Option<Option<String>>,
}

/// One save on top of `row` (which must still be the stored version): the new model, where it
/// goes and, for a restore, the version it brings back.
struct NewVersion<'a> {
    model: &'a AnalysisModel,
    folder_id: Option<&'a str>,
    restored_from: Option<i64>,
}

async fn save(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<SaveAnalysis>,
) -> ApiResult<Json<Analysis>> {
    let row = load(&state, &ctx, &id, Permission::AnalysesWrite).await?;
    if row.deleted_at.is_some() {
        return Err(conflict("the analysis is in the trash; restore it first"));
    }
    let model = parse_model(body.model)?;
    // The caller names the folder as they see it; a folder hidden from them reads as `null`, and
    // sending that back unchanged is no move.
    let index = AccessIndex::load(&mut *state.db.acquire().await?, &ctx).await?;
    let folder_id = match body.folder_id {
        Some(folder) if folder != visible_folder(&row, &index) => folder,
        _ => row.folder_id.clone(),
    };
    if folder_id != row.folder_id {
        authorize_place(&state, &ctx, folder_id.as_deref()).await?;
        // Moving into or out of a restricted folder changes who sees the analysis: a permissions
        // change on both sides, as for dashboards. Between the open tree and team spaces, edit
        // rights on both sides (the analysis's and the new place's, checked here) are enough.
        let tree = Tree::load(&mut *state.db.acquire().await?, &ctx).await?;
        let governing = |folder: Option<&str>| folder.and_then(|f| tree.governing(f));
        if tree.crossing_needs_permissions(governing(row.folder_id.as_deref()), governing(folder_id.as_deref())) {
            for place in [row.folder_id.as_deref(), folder_id.as_deref()].into_iter().flatten() {
                authz::check_resource(&state.db, &ctx, Permission::FoldersPermissions, Resource::Folder(place))
                    .await
                    .map_err(|e| {
                    if e.code == "not_found" {
                        ApiError::forbidden("missing permission folders:permissions")
                    } else {
                        e
                    }
                })?;
            }
        }
    }
    if body.version != row.version {
        return Err(ApiError::version_conflict(json!(pool_view(&state, &ctx, row).await?)));
    }
    let stored = saved_analyses::stored(&row.body)?;
    saved_analyses::check_visualization(&model, Some(&stored))?;
    saved_analyses::check_sources(&state.db, &ctx, &model, Some(&stored)).await?;
    let new = NewVersion { model: &model, folder_id: folder_id.as_deref(), restored_from: None };
    Ok(Json(write_version(&state, &ctx, &info, &row, new).await?))
}

/// Writes a new version on top of `row`. Answers the saved analysis, or the version conflict with
/// the stored one.
async fn write_version(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    row: &AnalysisRow,
    new: NewVersion<'_>,
) -> ApiResult<Analysis> {
    let text = model_text(new.model)?;
    let keep = version_retention(state).await?;
    let now = state.clock.now_ms();
    let next = row.version + 1;
    let moved = new.folder_id != row.folder_id.as_deref();
    let mut moved_out = None;
    let mut tx = crate::db::begin(&state.db).await?;
    if moved {
        lock_place(&mut tx, &ctx.org_id, new.folder_id).await?;
        moved_out =
            check_space_move(&mut tx, ctx, row.folder_id.as_deref(), row.owner_team_id.as_deref(), new.folder_id)
                .await?;
        // Into a restricted folder or team space only while every dashboard that links the
        // analysis lies under the same restricted folder: the others would show it to readers
        // who may no longer see it.
        let message = "dashboards outside the restricted folder show this analysis; remove it from them first";
        check_unused(&mut tx, ctx, &row.id, Some((new.folder_id, row.team_only != 0)), message).await?;
        // Leaving a restricted folder is remembered, so the purge still hides its old events.
        if let Some(old) = row.folder_id.as_deref()
            && folders::restricted_in(&mut tx, &ctx.org_id, old).await?
        {
            sqlx::query("UPDATE analyses SET ever_restricted = 1 WHERE org_id = $1 AND id = $2")
                .bind(&ctx.org_id)
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
        }
    }
    let updated = sqlx::query(
        "UPDATE analyses SET title = $1, search_title = $2, folder_id = $3, body = $4, version = $5, updated_by = $6, \
         updated_at = $7 WHERE org_id = $8 AND id = $9 AND version = $10 AND deleted_at IS NULL",
    )
    .bind(&new.model.title)
    .bind(new.model.title.to_lowercase())
    .bind(new.folder_id)
    .bind(&text)
    .bind(next)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&ctx.org_id)
    .bind(&row.id)
    .bind(row.version)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        // Saved, trashed or purged by someone else since the check above: nothing changed here.
        drop(tx);
        let stored = load(state, ctx, &row.id, Permission::AnalysesRead).await?;
        if stored.deleted_at.is_some() {
            return Err(conflict("the analysis is in the trash; restore it first"));
        }
        return Err(ApiError::version_conflict(json!(pool_view(state, ctx, stored).await?)));
    }
    record_version(&mut tx, ctx, &row.id, next, new.model, &text, new.restored_from, keep, now).await?;
    let summary = match new.restored_from {
        Some(from) => json!({ "version": next, "restoredFrom": from }),
        None => json!({ "version": next, "moved": moved }),
    };
    audit::record(&mut tx, &event(ctx, info, "analysis.updated", &row.id, summary, now)).await?;
    if let Some(summary) = moved_out {
        audit::record(&mut tx, &event(ctx, info, "team_space.moved_out", &row.id, summary, now)).await?;
    }
    let saved = fetch(&mut *tx, &ctx.org_id, &row.id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut tx, ctx, saved).await?;
    crate::db::commit(tx).await?;
    Ok(answer)
}

/// Moves the analysis to the trash, unless dashboards link it (`409`, reason `analysis.in_use`):
/// they would be left showing nothing.
async fn trash(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, Permission::AnalysesWrite).await?;
    if row.deleted_at.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // Dashboard saves that add a link take the same lock and check that the analysis is outside
    // the trash, so either they see it trashed or this sees their link.
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    check_unused(&mut tx, &ctx, &id, None, "dashboards still show this analysis; remove it from them first").await?;
    let trashed = sqlx::query(
        "UPDATE analyses SET deleted_at = $1, trash_batch = $2 WHERE org_id = $3 AND id = $4 AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(new_id())
    .bind(&ctx.org_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if trashed == 1 {
        audit::record(&mut tx, &event(&ctx, &info, "analysis.deleted", &id, json!({}), now)).await?;
    }
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Analysis>> {
    let row = load(&state, &ctx, &id, Permission::AnalysesWrite).await?;
    if row.deleted_at.is_none() {
        return Ok(Json(pool_view(&state, &ctx, row).await?));
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // The lock orders this against a purge of the analysis or its folder: whichever comes second
    // sees what the first left.
    match lock_place(&mut tx, &ctx.org_id, row.folder_id.as_deref()).await {
        Ok(()) => {}
        Err(e) if e.code == "validation" => {
            return Err(conflict("the folder is in the trash; restore the folder first"));
        }
        Err(e) => return Err(e),
    }
    let restored = sqlx::query(
        "UPDATE analyses SET deleted_at = NULL, trash_batch = NULL \
         WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL",
    )
    .bind(&ctx.org_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if restored == 1 {
        audit::record(&mut tx, &event(&ctx, &info, "analysis.restored", &id, json!({}), now)).await?;
        let row = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
        let answer = view(&mut tx, &ctx, row).await?;
        crate::db::commit(tx).await?;
        return Ok(Json(answer));
    }
    // Restored or purged by someone else meanwhile: nothing changed here, answer what is stored.
    drop(tx);
    let row = fetch(&state.db, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    Ok(Json(pool_view(&state, &ctx, row).await?))
}

async fn purge(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let not_trashed = || conflict("only analyses in the trash can be purged; move it to the trash first");
    let row = load(&state, &ctx, &id, Permission::AnalysesWrite).await?;
    // Gone for good is the admin level's, as for data sources: `dashboards:share` on the analysis
    // (an admin grant, or the org-wide right where it applies) on top of `analyses:write`.
    authz::check_resource(&state.db, &ctx, Permission::DashboardsShare, Resource::Analysis(&id)).await?;
    if row.deleted_at.is_none() {
        return Err(not_trashed());
    }
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    // Restores and grant changes lock the organization too, so the state read here holds until
    // the commit: an analysis restored since the check above stays.
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    let current: Option<(Option<String>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT folder_id, deleted_at, CASE WHEN team_only = 1 THEN 1 ELSE ever_restricted END \
         FROM analyses WHERE org_id = $1 AND id = $2",
    )
    .bind(&ctx.org_id)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let (folder, ever_restricted) = match current {
        None => return Err(ApiError::not_found()),
        Some((_, None, _)) => return Err(not_trashed()),
        Some((folder, Some(_), ever_restricted)) => (folder, ever_restricted),
    };
    // A dashboard that links it may still come back from the trash (its folder's trash may have
    // taken both along): the link would be left pointing at nothing.
    let message = "dashboards, also in the trash, still show this analysis; remove it from them or purge them first";
    check_unused(&mut tx, &ctx, &id, None, message).await?;
    let restricted_now = match folder.as_deref() {
        Some(folder) => folders::restricted_in(&mut tx, &ctx.org_id, folder).await?,
        None => false,
    };
    if restricted_now || ever_restricted != 0 {
        // Restricted content keeps its audit events hidden once it is gone.
        folders::tombstone_analysis(&mut tx, &ctx.org_id, &id).await?;
    }
    for sql in [
        "DELETE FROM resource_grants WHERE org_id = $1 AND resource_type = 'analysis' AND resource_id = $2",
        "DELETE FROM analysis_uses WHERE org_id = $1 AND analysis_id = $2",
        "DELETE FROM analysis_sources WHERE org_id = $1 AND analysis_id = $2",
    ] {
        sqlx::query(sql).bind(&ctx.org_id).bind(&id).execute(&mut *tx).await?;
    }
    sqlx::query("DELETE FROM analysis_versions WHERE analysis_id = $1").bind(&id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM analyses WHERE org_id = $1 AND id = $2 AND deleted_at IS NOT NULL")
        .bind(&ctx.org_id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    audit::record(&mut tx, &event(&ctx, &info, "analysis.purged", &id, json!({}), now)).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Sets the team that owns an analysis and who else sees it (`team`: team only), by the rules of
/// a dashboard's owner (`folders::check_owner_change`): `analyses:write` and `dashboards:share` on
/// the analysis, and the new owner team must be the caller's unless they are an org admin. An
/// analysis that dashboards link stays visible to their viewers: making it team only is refused
/// while any does (`409`, reason `analysis.in_use`).
async fn set_owner(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<OwnerRequest>,
) -> ApiResult<Json<Analysis>> {
    // Before the lock, for `not_found` on what the caller cannot see and the admin audit; every
    // rule is checked again under the lock, where nothing can change it meanwhile.
    load(&state, &ctx, &id, Permission::DashboardsShare).await?;
    let team_only = body.visibility == Visibility::Team;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    authz::lock_org(&mut tx, &ctx.org_id).await?;
    let row = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    if row.deleted_at.is_some() {
        return Err(conflict("the analysis is in the trash; restore it first"));
    }
    if body.version.is_some_and(|v| v != row.version) {
        let current = view(&mut tx, &ctx, row).await?;
        return Err(ApiError::version_conflict(json!(current)));
    }
    let held =
        check_owner_change(&mut tx, &ctx, OwnedItem::Analysis { id: &id, folder: row.folder_id.as_deref() }, &body)
            .await?;
    if team_only && row.team_only == 0 {
        let message = "dashboards show this analysis; it cannot be made team only while they do";
        check_unused(&mut tx, &ctx, &id, None, message).await?;
    }
    let member = match body.owner_team_id.as_deref() {
        Some(team) => authz::team_membership(&mut *tx, &ctx, team).await?.is_some(),
        None => false,
    };
    let changed = sqlx::query(
        "UPDATE analyses SET owner_team_id = $1, team_only = $2, \
         ever_restricted = CASE WHEN $2 = 1 THEN 1 ELSE ever_restricted END \
         WHERE org_id = $3 AND id = $4 AND deleted_at IS NULL \
         AND (COALESCE(owner_team_id, '') <> COALESCE(CAST($1 AS TEXT), '') OR team_only <> $2)",
    )
    .bind(body.owner_team_id.as_deref())
    .bind(team_only as i64)
    .bind(&ctx.org_id)
    .bind(&id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed > 0 {
        let summary = json!({ "from": row.owner_team_id, "to": body.owner_team_id, "visibility": body.visibility });
        audit::record(&mut tx, &event(&ctx, &info, "analysis.owner_changed", &id, summary, now)).await?;
        // Whoever makes an analysis team only without belonging to its team keeps sight of it,
        // with no more than they held.
        if team_only && !member {
            keep_access(&mut tx, &ctx, &info, Resource::Analysis(&id), &held, now).await?;
        }
    }
    let saved = fetch(&mut *tx, &ctx.org_id, &id).await?.ok_or_else(ApiError::not_found)?;
    let answer = view(&mut tx, &ctx, saved).await?;
    crate::db::commit(tx).await?;
    Ok(Json(answer))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Use {
    id: String,
    title: String,
    deleted_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uses {
    /// The dashboards linking it that the caller may read, by title. Others are not counted, so
    /// nothing tells about content the caller cannot see.
    items: Vec<Use>,
}

async fn uses(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Uses>> {
    load(&state, &ctx, &id, Permission::AnalysesRead).await?;
    let mut conn = state.db.acquire().await?;
    let rows: Vec<(String, Option<String>, String, Option<i64>)> = sqlx::query_as(
        "SELECT d.id, d.folder_id, d.title, d.deleted_at FROM analysis_uses u \
         JOIN dashboards d ON d.id = u.dashboard_id WHERE u.analysis_id = $1 AND d.org_id = $2 \
         ORDER BY d.title, d.id",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .fetch_all(&mut *conn)
    .await?;
    let index = AccessIndex::load(&mut conn, &ctx).await?;
    let items = rows
        .into_iter()
        .filter(|(dashboard, folder, _, _)| {
            index.dashboard(dashboard, folder.as_deref()).is_some_and(|p| p.contains(&Permission::DashboardsRead))
        })
        .map(|(id, _, title, deleted_at)| Use { id, title, deleted_at })
        .collect();
    Ok(Json(Uses { items }))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    version: i64,
    author_id: Option<String>,
    /// The author's current name; `null` once the account is removed.
    author_name: Option<String>,
    restored_from: Option<i64>,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    #[serde(flatten)]
    summary: VersionSummary,
    model: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionsQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

const VERSION_COLUMNS: &str = "v.version, v.author_id, u.name AS author_name, v.restored_from, v.created_at";

/// Newest version first.
async fn versions(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
    QueryParams(q): QueryParams<VersionsQuery>,
) -> ApiResult<Json<Page<VersionSummary>>> {
    let limit = page_limit(q.limit)? as usize;
    let before: Option<i64> = decode_cursor(q.cursor.as_deref())?;
    load(&state, &ctx, &id, Permission::AnalysesRead).await?;
    let mut items: Vec<VersionSummary> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VERSION_COLUMNS} FROM analysis_versions v LEFT JOIN users u ON u.id = v.author_id \
         WHERE v.analysis_id = $1 AND (CAST($2 AS BIGINT) IS NULL OR v.version < $2) \
         ORDER BY v.version DESC LIMIT $3"
    )))
    .bind(&id)
    .bind(before)
    .bind(limit as i64 + 1)
    .fetch_all(&state.db)
    .await?;
    let more = items.len() > limit;
    items.truncate(limit);
    let next_cursor = match items.last() {
        Some(last) if more => Some(encode_cursor(&last.version)),
        _ => None,
    };
    Ok(Json(Page { items, next_cursor }))
}

/// One stored version with its body, or `not_found` (also for a number that is not a canonical
/// number: digits only, no sign, no leading zero).
async fn load_version(state: &AppState, analysis_id: &str, raw: &str) -> ApiResult<(VersionSummary, String)> {
    let canonical = !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) && (raw == "0" || !raw.starts_with('0'));
    let number: i64 = if canonical { raw.parse().ok() } else { None }.ok_or_else(ApiError::not_found)?;
    #[derive(sqlx::FromRow)]
    struct Row {
        #[sqlx(flatten)]
        summary: VersionSummary,
        body: String,
    }
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VERSION_COLUMNS}, v.body FROM analysis_versions v LEFT JOIN users u ON u.id = v.author_id \
         WHERE v.analysis_id = $1 AND v.version = $2"
    )))
    .bind(analysis_id)
    .bind(number)
    .fetch_optional(&state.db)
    .await?;
    row.map(|r| (r.summary, r.body)).ok_or_else(ApiError::not_found)
}

async fn version(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id, number)): Path<(String, String, String)>,
) -> ApiResult<Json<Version>> {
    load(&state, &ctx, &id, Permission::AnalysesRead).await?;
    let (summary, raw) = load_version(&state, &id, &number).await?;
    Ok(Json(Version { summary, model: stored_value(&raw)? }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreQuery {
    /// The current version the caller saw; an analysis saved since answers `version_conflict`.
    expected_version: Option<i64>,
}

/// Saves an older version's model as a new version; the history keeps everything in between.
async fn restore_version(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id, number)): Path<(String, String, String)>,
    QueryParams(q): QueryParams<RestoreQuery>,
) -> ApiResult<Json<Analysis>> {
    let row = load(&state, &ctx, &id, Permission::AnalysesWrite).await?;
    if row.deleted_at.is_some() {
        return Err(conflict("the analysis is in the trash; restore it first"));
    }
    if q.expected_version.is_some_and(|v| v != row.version) {
        return Err(ApiError::version_conflict(json!(pool_view(&state, &ctx, row).await?)));
    }
    let (summary, raw) = load_version(&state, &id, &number).await?;
    // Rules may have tightened since that version was saved; it must pass today's.
    let model = parse_model(stored_value(&raw)?)?;
    let current = saved_analyses::stored(&row.body)?;
    saved_analyses::check_visualization(&model, Some(&current))?;
    saved_analyses::check_sources(&state.db, &ctx, &model, Some(&current)).await?;
    let new = NewVersion { model: &model, folder_id: row.folder_id.as_deref(), restored_from: Some(summary.version) };
    Ok(Json(write_version(&state, &ctx, &info, &row, new).await?))
}

/// Runs the analysis's stored queries for whoever may read it, as a dashboard panel's stored
/// queries run for its readers. The request adds the time range and limits; an analysis has no
/// variables, so sending any is refused. The steps run in the browser, as for a panel.
async fn run(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(req): JsonBody<PanelQueryRequest>,
) -> ApiResult<Json<QueryResponse>> {
    let row = load(&state, &ctx, &id, Permission::AnalysesRead).await?;
    // A trashed analysis runs nothing; it is restored first, like a trashed dashboard.
    if row.deleted_at.is_some() {
        return Err(ApiError::not_found());
    }
    let model = saved_analyses::stored(&row.body)?.as_dashboard()?;
    let panel = model.panels.first().ok_or_else(|| ApiError::internal("analyses", "the analysis has no panel"))?;
    Ok(Json(super::query::run_stored_panel(&state, &ctx, &model, panel, req).await?))
}

/// The field distribution of one of the analysis's stored queries (`refId`) over its whole
/// result, for whoever may run them: the same rights, time range and (absent) variables as the
/// query route above. A hidden query no step reads is not run there, and is `not_found` here.
async fn distribution(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(req): JsonBody<PanelDistributionRequest>,
) -> ApiResult<Json<FieldDistribution>> {
    let row = load(&state, &ctx, &id, Permission::AnalysesRead).await?;
    if row.deleted_at.is_some() {
        return Err(ApiError::not_found());
    }
    let model = saved_analyses::stored(&row.body)?.as_dashboard()?;
    let panel = model.panels.first().ok_or_else(|| ApiError::internal("analyses", "the analysis has no panel"))?;
    crate::datasources::check_range(req.time_range)?;
    crate::datasources::check_interval(req.interval_ms)?;
    let spec = crate::datasources::distribution::DistributionSpec::new(&req.path, req.top, req.bins)?;
    let run = super::query::stored_items(&model, panel, &req.variables, None, &Default::default())?;
    let d = super::query::stored_distribution(&state, &ctx, run, &req.ref_id, req.time_range, req.interval_ms, &spec)
        .await?;
    Ok(Json(d))
}
