//! Reading the usage buckets for the administration (docs/api/usage.md): the totals and trend of a
//! period, the most viewed dashboards, the slowest and most failing panels, the data sources with
//! their errors and cache hits, and the dashboards nobody opened. One organization, or every one
//! for server administrators.
//!
//! Dashboards and panels a member cannot see (restricted folders, team spaces) are left out for a
//! viewer who does not see every folder, by the rule of `folders::VISIBILITY_CTE`, and data
//! sources a member may not read (`datasources:read`, role or grant) are left out for them, also
//! from the totals and the trend. Dashboards and data sources in the trash or purged are left out
//! everywhere; their buckets expire.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;
use sqlx::any::AnyRow;

use super::{DAY_MS, HOUR_MS, RANGES, bucket_of, quantile};
use crate::app::AppState;
use crate::authz::{OrgCtx, Permission, Resource, check_resource};
use crate::error::{ApiError, ApiResult};
use crate::folders;

/// Entries of each list in a report.
pub const TOP: usize = 20;
/// The longest period a report covers.
pub const MAX_RANGE_MS: i64 = 366 * DAY_MS;
/// Periods up to this length have an hourly trend, longer ones a daily one.
pub const HOURLY_UP_TO_MS: i64 = 3 * DAY_MS;
/// Unused dashboards listed at most; `total` says how many there are.
pub const MAX_UNUSED: usize = 200;
/// Panel rows read at most for one report, the most run first.
const MAX_PANEL_ROWS: i64 = 10_000;

/// Whose view: one organization or all, the member whose hidden dashboards are left out, and the
/// data sources the viewer may read.
#[derive(Clone, Copy)]
pub struct Scope<'a> {
    pub org_id: Option<&'a str>,
    /// `Some` for a member who does not see every folder.
    pub hiding: Option<&'a OrgCtx>,
    /// `Some` for a member who may read only some data sources: their ids (`visible_sources`).
    pub sources: Option<&'a [String]>,
    /// A server administrator's view: it also names the server's dropped events.
    pub server: bool,
}

impl<'a> Scope<'a> {
    /// A member's view of their organization; `sources` from `visible_sources`.
    pub fn member(ctx: &'a OrgCtx, sources: Option<&'a [String]>) -> Self {
        let hiding = (folders::sees_every_folder(ctx) == 0).then_some(ctx);
        Self { org_id: Some(&ctx.org_id), hiding, sources, server: false }
    }

    /// A server administrator's view of one organization or of all.
    pub fn server(org_id: Option<&'a str>) -> Self {
        Self { org_id, hiding: None, sources: None, server: true }
    }

    /// The same view without the dashboard rule, for queries about data sources only.
    fn sources_only(&self) -> Self {
        Self { hiding: None, ..*self }
    }
}

/// The data sources of the organization (not in the trash) a member may read, when the member's
/// role does not let them read every one; `None` when it does.
pub async fn visible_sources(state: &AppState, ctx: &OrgCtx) -> ApiResult<Option<Vec<String>>> {
    if ctx.permissions.contains(&Permission::DatasourcesRead) {
        return Ok(None);
    }
    let ids: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM datasources WHERE org_id = $1 AND deleted_at IS NULL ORDER BY id")
            .bind(&ctx.org_id)
            .fetch_all(&state.db)
            .await?;
    let mut visible = Vec::new();
    for (id,) in ids {
        if check_resource(&state.db, ctx, Permission::DatasourcesRead, Resource::Datasource(&id)).await.is_ok() {
            visible.push(id);
        }
    }
    Ok(Some(visible))
}

/// The first hour a report from `from` counts: the first that starts at or after it, so a
/// period of 24 hours covers 24 hourly buckets, not 25.
pub fn first_bucket(from: i64) -> i64 {
    bucket_of(from.saturating_add(HOUR_MS - 1))
}

#[derive(Debug, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub views: i64,
    pub panel_runs: i64,
    pub panel_errors: i64,
    pub queries: i64,
    pub query_errors: i64,
    pub cache_hits: i64,
    pub cache_misses: i64,
}

#[derive(Debug, Serialize, Default, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    /// Start of the step (Unix ms).
    pub at: i64,
    pub views: i64,
    pub panel_runs: i64,
    pub panel_errors: i64,
    pub queries: i64,
    pub query_errors: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardUsage {
    pub org_id: String,
    pub org_name: String,
    pub id: String,
    pub title: String,
    pub views: i64,
    /// The start of the last hour with a view in the period.
    pub last_viewed_at: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanelUsage {
    pub org_id: String,
    pub org_name: String,
    pub dashboard_id: String,
    pub dashboard_title: String,
    pub panel_id: String,
    pub panel_title: String,
    pub runs: i64,
    pub errors: i64,
    pub cache_hits: i64,
    pub cache_misses: i64,
    pub rows: i64,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub max_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceUsage {
    pub org_id: String,
    pub org_name: String,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub queries: i64,
    pub errors: i64,
    pub errors_timeout: i64,
    pub errors_rejected: i64,
    pub errors_source: i64,
    pub errors_other: i64,
    pub cache_hits: i64,
    pub cache_misses: i64,
    pub rows: i64,
    /// Of the queries that ran in the source (not the cache's answers).
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub max_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub from: i64,
    pub to: i64,
    /// The trend's step: an hour or a day.
    pub step_ms: i64,
    /// `usage.enabled` now.
    pub recording: bool,
    pub retention_days: i64,
    /// The oldest bucket kept for this scope: nothing older can be known.
    pub since: Option<i64>,
    /// Events this server dropped since it started, because its buffer was full; a count of the
    /// whole server, so only in the server view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped: Option<u64>,
    pub totals: Totals,
    pub trend: Vec<TrendPoint>,
    pub dashboards: Vec<DashboardUsage>,
    pub slow_panels: Vec<PanelUsage>,
    pub failing_panels: Vec<PanelUsage>,
    pub sources: Vec<SourceUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnusedDashboard {
    pub org_id: String,
    pub org_name: String,
    pub id: String,
    pub title: String,
    pub created_at: i64,
    /// The last hour with a view within the retention, if any.
    pub last_viewed_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unused {
    pub days: i64,
    /// Dashboards without a view since this moment.
    pub since: i64,
    /// The oldest bucket kept for this scope.
    pub recorded_since: Option<i64>,
    pub items: Vec<UnusedDashboard>,
    pub total: usize,
}

/// Checks a report's period: `from` before `to`, at most `MAX_RANGE_MS`.
pub fn check_range(from: i64, to: i64) -> ApiResult<()> {
    if from < 0 || to <= from {
        return Err(ApiError::validation("from must be before to").with_field("from"));
    }
    if to - from > MAX_RANGE_MS {
        return Err(ApiError::validation("the period must not be longer than 366 days").with_field("from"));
    }
    Ok(())
}

/// A bound value.
enum Arg<'a> {
    Text(&'a str),
    Int(i64),
}

/// A query with its parameters, numbered as they are added. With a hiding scope it starts with
/// `folders::VISIBILITY_CTE`, whose parameters are `$1` to `$4`.
struct Sql<'a> {
    text: String,
    args: Vec<Arg<'a>>,
}

impl<'a> Sql<'a> {
    fn new(scope: &Scope<'a>) -> Self {
        match scope.hiding {
            Some(ctx) => Self {
                text: folders::VISIBILITY_CTE.to_string(),
                args: vec![
                    Arg::Text(&ctx.org_id),
                    Arg::Text(&ctx.user.id),
                    Arg::Text(&ctx.role),
                    Arg::Int(folders::sees_every_folder(ctx)),
                ],
            },
            None => Self { text: String::new(), args: Vec::new() },
        }
    }

    /// Adds a parameter and answers its placeholder.
    fn arg(&mut self, arg: Arg<'a>) -> String {
        self.args.push(arg);
        format!("${}", self.args.len())
    }

    /// `AND alias.org_id = $n` for one organization.
    fn org(&mut self, scope: &Scope<'a>, alias: &str) -> String {
        match scope.org_id {
            Some(org) => format!(" AND {alias}.org_id = {}", self.arg(Arg::Text(org))),
            None => String::new(),
        }
    }

    /// `AND alias.datasource_id IN (...)` when the scope may read only some sources.
    fn sources(&mut self, scope: &Scope<'a>, alias: &str) -> String {
        match scope.sources {
            None => String::new(),
            Some([]) => " AND 1 = 0".to_string(),
            Some(ids) => {
                let list: Vec<String> = ids.iter().map(|id| self.arg(Arg::Text(id))).collect();
                format!(" AND {alias}.datasource_id IN ({})", list.join(", "))
            }
        }
    }

    async fn fetch(self, state: &AppState) -> ApiResult<Vec<AnyRow>> {
        let mut query = sqlx::query(sqlx::AssertSqlSafe(self.text));
        for arg in self.args {
            query = match arg {
                Arg::Text(t) => query.bind(t),
                Arg::Int(i) => query.bind(i),
            };
        }
        Ok(query.fetch_all(&state.db).await?)
    }
}

/// `AND <dashboard alias is visible>` for a hiding scope.
fn visible(scope: &Scope<'_>, alias: &str) -> String {
    match scope.hiding {
        Some(_) => format!(" AND {}", folders::dashboard_visible(alias)),
        None => String::new(),
    }
}

fn sum(column: &str) -> String {
    format!("CAST(COALESCE(SUM({column}), 0) AS BIGINT)")
}

fn ranges_sum(alias: &str) -> String {
    (0..RANGES).map(|i| sum(&format!("{alias}.d{i}"))).collect::<Vec<_>>().join(", ")
}

fn int(row: &AnyRow, i: usize) -> ApiResult<i64> {
    row.try_get::<i64, _>(i).map_err(|e| ApiError::internal("usage", e))
}

fn opt_int(row: &AnyRow, i: usize) -> ApiResult<Option<i64>> {
    row.try_get::<Option<i64>, _>(i).map_err(|e| ApiError::internal("usage", e))
}

fn text(row: &AnyRow, i: usize) -> ApiResult<String> {
    row.try_get::<String, _>(i).map_err(|e| ApiError::internal("usage", e))
}

fn ranges(row: &AnyRow, first: usize) -> ApiResult<[i64; RANGES]> {
    let mut out = [0i64; RANGES];
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = int(row, first + i)?;
    }
    Ok(out)
}

/// The report of `scope` for the period `from` to `to` (Unix ms; the buckets whose hour starts
/// in it, `first_bucket`).
pub async fn report(state: &AppState, scope: Scope<'_>, from: i64, to: i64) -> ApiResult<Report> {
    check_range(from, to)?;
    let start = first_bucket(from);
    let step_ms = if to - from <= HOURLY_UP_TO_MS { HOUR_MS } else { DAY_MS };
    let trend_rows = trend(state, &scope, start, to).await?;
    let mut totals = Totals::default();
    let mut points: Vec<TrendPoint> = Vec::new();
    let first = start - start.rem_euclid(step_ms);
    let mut at = first;
    while at < to {
        points.push(TrendPoint { at, ..Default::default() });
        at += step_ms;
    }
    for (bucket, point) in trend_rows {
        totals.views += point.views;
        totals.panel_runs += point.panel_runs;
        totals.panel_errors += point.panel_errors;
        totals.queries += point.queries;
        totals.query_errors += point.query_errors;
        let index = ((bucket - first) / step_ms) as usize;
        if let Some(p) = points.get_mut(index) {
            p.views += point.views;
            p.panel_runs += point.panel_runs;
            p.panel_errors += point.panel_errors;
            p.queries += point.queries;
            p.query_errors += point.query_errors;
        }
    }
    let sources = sources(state, &scope, start, to).await?;
    for s in &sources {
        totals.cache_hits += s.cache_hits;
        totals.cache_misses += s.cache_misses;
    }
    let (slow_panels, failing_panels) = panels(state, &scope, start, to).await?;
    Ok(Report {
        from,
        to,
        step_ms,
        recording: super::enabled(state).await,
        retention_days: super::retention_days(state).await,
        since: since(state, &scope).await?,
        dropped: scope.server.then(|| state.usage.dropped()),
        totals,
        trend: points,
        dashboards: dashboards(state, &scope, start, to).await?,
        slow_panels,
        failing_panels,
        sources,
    })
}

/// Counts per hour from the three tables.
async fn trend(state: &AppState, scope: &Scope<'_>, start: i64, to: i64) -> ApiResult<Vec<(i64, TrendPoint)>> {
    let mut out: HashMap<i64, TrendPoint> = HashMap::new();
    // Views and panel runs belong to dashboards: only those that exist and are not in the trash
    // count, as in the lists, and a hiding scope counts only those it sees.
    for (table, count, errors) in
        [("usage_dashboard_views", "views", None), ("usage_panel_runs", "runs", Some("errors"))]
    {
        let mut sql = Sql::new(scope);
        let (a, b) = (sql.arg(Arg::Int(start)), sql.arg(Arg::Int(to)));
        let org = sql.org(scope, "u");
        let vis = visible(scope, "d");
        sql.text += &format!(
            "SELECT u.bucket, {}, {} FROM {table} u \
             JOIN dashboards d ON d.id = u.dashboard_id AND d.org_id = u.org_id AND d.deleted_at IS NULL \
             WHERE u.bucket >= {a} AND u.bucket < {b}{org}{vis} \
             GROUP BY u.bucket",
            sum(&format!("u.{count}")),
            errors.map_or("CAST(0 AS BIGINT)".to_string(), |e| sum(&format!("u.{e}"))),
        );
        for row in sql.fetch(state).await? {
            let p = out.entry(int(&row, 0)?).or_default();
            if table == "usage_dashboard_views" {
                p.views += int(&row, 1)?;
            } else {
                p.panel_runs += int(&row, 1)?;
                p.panel_errors += int(&row, 2)?;
            }
        }
    }
    // Queries of the sources that exist, are not in the trash and the viewer may read.
    let mut sql = Sql::new(&scope.sources_only());
    let (a, b) = (sql.arg(Arg::Int(start)), sql.arg(Arg::Int(to)));
    let org = sql.org(scope, "u");
    let readable = sql.sources(scope, "u");
    sql.text += &format!(
        "SELECT u.bucket, {}, {} FROM usage_source_queries u \
         JOIN datasources s ON s.id = u.datasource_id AND s.org_id = u.org_id AND s.deleted_at IS NULL \
         WHERE u.bucket >= {a} AND u.bucket < {b}{org}{readable} \
         GROUP BY u.bucket",
        sum("u.queries"),
        sum("u.errors"),
    );
    for row in sql.fetch(state).await? {
        let p = out.entry(int(&row, 0)?).or_default();
        p.queries += int(&row, 1)?;
        p.query_errors += int(&row, 2)?;
    }
    let mut rows: Vec<(i64, TrendPoint)> = out.into_iter().collect();
    rows.sort_by_key(|(bucket, _)| *bucket);
    Ok(rows)
}

/// The most viewed dashboards that still exist and are not in the trash.
async fn dashboards(state: &AppState, scope: &Scope<'_>, start: i64, to: i64) -> ApiResult<Vec<DashboardUsage>> {
    let mut sql = Sql::new(scope);
    let (a, b) = (sql.arg(Arg::Int(start)), sql.arg(Arg::Int(to)));
    let org = sql.org(scope, "u");
    let limit = sql.arg(Arg::Int(TOP as i64));
    sql.text += &format!(
        "SELECT u.org_id, o.name, u.dashboard_id, d.title, {} AS views, MAX(u.bucket) AS last_bucket \
         FROM usage_dashboard_views u \
         JOIN dashboards d ON d.id = u.dashboard_id AND d.org_id = u.org_id AND d.deleted_at IS NULL \
         JOIN orgs o ON o.id = u.org_id \
         WHERE u.bucket >= {a} AND u.bucket < {b}{org}{} \
         GROUP BY u.org_id, o.name, u.dashboard_id, d.title \
         ORDER BY views DESC, d.title, u.dashboard_id LIMIT {limit}",
        sum("u.views"),
        visible(scope, "d"),
    );
    sql.fetch(state)
        .await?
        .iter()
        .map(|row| {
            Ok(DashboardUsage {
                org_id: text(row, 0)?,
                org_name: text(row, 1)?,
                id: text(row, 2)?,
                title: text(row, 3)?,
                views: int(row, 4)?,
                last_viewed_at: int(row, 5)?,
            })
        })
        .collect()
}

/// The slowest panels (by their 95th percentile, then median) and those with the most failing
/// runs (by share, then number), `TOP` each, of panels that are still on their dashboard.
async fn panels(
    state: &AppState,
    scope: &Scope<'_>,
    start: i64,
    to: i64,
) -> ApiResult<(Vec<PanelUsage>, Vec<PanelUsage>)> {
    let mut sql = Sql::new(scope);
    let (a, b) = (sql.arg(Arg::Int(start)), sql.arg(Arg::Int(to)));
    let org = sql.org(scope, "u");
    let limit = sql.arg(Arg::Int(MAX_PANEL_ROWS));
    sql.text += &format!(
        "SELECT u.org_id, o.name, u.dashboard_id, d.title, u.panel_id, {runs} AS runs, {}, {}, {}, {}, \
         MAX(u.duration_max_ms), {} \
         FROM usage_panel_runs u \
         JOIN dashboards d ON d.id = u.dashboard_id AND d.org_id = u.org_id AND d.deleted_at IS NULL \
         JOIN orgs o ON o.id = u.org_id \
         WHERE u.bucket >= {a} AND u.bucket < {b}{org}{} \
         GROUP BY u.org_id, o.name, u.dashboard_id, d.title, u.panel_id \
         ORDER BY runs DESC, u.dashboard_id, u.panel_id LIMIT {limit}",
        sum("u.errors"),
        sum("u.cache_hits"),
        sum("u.cache_misses"),
        sum("u.result_rows"),
        ranges_sum("u"),
        visible(scope, "d"),
        runs = sum("u.runs"),
    );
    let mut all = Vec::new();
    for row in sql.fetch(state).await? {
        let max_ms = int(&row, 10)?;
        let r = ranges(&row, 11)?;
        all.push(PanelUsage {
            org_id: text(&row, 0)?,
            org_name: text(&row, 1)?,
            dashboard_id: text(&row, 2)?,
            dashboard_title: text(&row, 3)?,
            panel_id: text(&row, 4)?,
            panel_title: String::new(),
            runs: int(&row, 5)?,
            errors: int(&row, 6)?,
            cache_hits: int(&row, 7)?,
            cache_misses: int(&row, 8)?,
            rows: int(&row, 9)?,
            p50_ms: quantile(&r, max_ms, 0.5),
            p95_ms: quantile(&r, max_ms, 0.95),
            max_ms,
        });
    }
    let mut slow: Vec<&PanelUsage> = all.iter().filter(|p| p.runs > 0).collect();
    slow.sort_by(|x, y| y.p95_ms.cmp(&x.p95_ms).then(y.p50_ms.cmp(&x.p50_ms)).then(y.runs.cmp(&x.runs)));
    let mut failing: Vec<&PanelUsage> = all.iter().filter(|p| p.errors > 0).collect();
    failing.sort_by(|x, y| {
        // Share of failing runs, compared without division: x.errors / x.runs.
        (y.errors as i128 * x.runs as i128).cmp(&(x.errors as i128 * y.runs as i128)).then(y.errors.cmp(&x.errors))
    });
    // The titles of the candidates' dashboards, read in one query. Panels no longer on their
    // dashboard are left out, so a few more than `TOP` of each list are considered.
    let candidates: Vec<&PanelUsage> =
        slow.iter().take(TITLE_CANDIDATES).chain(failing.iter().take(TITLE_CANDIDATES)).copied().collect();
    let titles = panel_titles(state, &candidates).await?;
    Ok((named(&titles, slow), named(&titles, failing)))
}

/// Candidates of each panel list whose dashboards' titles are read.
const TITLE_CANDIDATES: usize = 4 * TOP;

/// Panel titles per (organization, dashboard): panel id to title.
type Titles = HashMap<(String, String), HashMap<String, String>>;

/// The first `TOP` of `panels` still on their dashboard, with their titles.
fn named(titles: &Titles, panels: Vec<&PanelUsage>) -> Vec<PanelUsage> {
    panels
        .into_iter()
        .take(TITLE_CANDIDATES)
        .filter_map(|p| {
            let title = titles.get(&(p.org_id.clone(), p.dashboard_id.clone()))?.get(&p.panel_id)?;
            Some(PanelUsage { panel_title: title.clone(), ..p.clone() })
        })
        .take(TOP)
        .collect()
}

/// The panel titles of the current versions of the dashboards of `panels`, in one query.
async fn panel_titles(state: &AppState, panels: &[&PanelUsage]) -> ApiResult<Titles> {
    let mut dashboards: Vec<&str> = panels.iter().map(|p| p.dashboard_id.as_str()).collect();
    dashboards.sort_unstable();
    dashboards.dedup();
    if dashboards.is_empty() {
        return Ok(HashMap::new());
    }
    let mut sql = Sql { text: String::new(), args: Vec::new() };
    let list: Vec<String> = dashboards.iter().map(|id| sql.arg(Arg::Text(id))).collect();
    sql.text = format!(
        "SELECT d.org_id, d.id, v.model FROM dashboards d JOIN dashboard_versions v \
         ON v.dashboard_id = d.id AND v.version = d.version WHERE d.id IN ({})",
        list.join(", ")
    );
    let mut out = Titles::new();
    for row in sql.fetch(state).await? {
        let model: Value = serde_json::from_str(&text(&row, 2)?).unwrap_or(Value::Null);
        let panels = model.get("panels").and_then(Value::as_array).cloned().unwrap_or_default();
        let titles = panels
            .iter()
            .filter_map(|p| {
                let id = p.get("id")?.as_str()?.to_string();
                let title = p.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
                Some((id, title))
            })
            .collect();
        out.insert((text(&row, 0)?, text(&row, 1)?), titles);
    }
    Ok(out)
}

/// Every data source asked in the period that still exists, the most asked first.
async fn sources(state: &AppState, scope: &Scope<'_>, start: i64, to: i64) -> ApiResult<Vec<SourceUsage>> {
    let mut sql = Sql::new(&scope.sources_only());
    let (a, b) = (sql.arg(Arg::Int(start)), sql.arg(Arg::Int(to)));
    let org = sql.org(scope, "u");
    let readable = sql.sources(scope, "u");
    sql.text += &format!(
        "SELECT u.org_id, o.name, u.datasource_id, s.name, s.kind, {queries} AS queries, {}, {}, {}, {}, {}, {}, \
         {}, {}, MAX(u.duration_max_ms), {} \
         FROM usage_source_queries u \
         JOIN datasources s ON s.id = u.datasource_id AND s.org_id = u.org_id AND s.deleted_at IS NULL \
         JOIN orgs o ON o.id = u.org_id \
         WHERE u.bucket >= {a} AND u.bucket < {b}{org}{readable} \
         GROUP BY u.org_id, o.name, u.datasource_id, s.name, s.kind \
         ORDER BY queries DESC, s.name, u.datasource_id",
        sum("u.errors"),
        sum("u.errors_timeout"),
        sum("u.errors_rejected"),
        sum("u.errors_source"),
        sum("u.errors_other"),
        sum("u.cache_hits"),
        sum("u.cache_misses"),
        sum("u.result_rows"),
        ranges_sum("u"),
        queries = sum("u.queries"),
    );
    sql.fetch(state)
        .await?
        .iter()
        .map(|row| {
            let max_ms = int(row, 14)?;
            let r = ranges(row, 15)?;
            Ok(SourceUsage {
                org_id: text(row, 0)?,
                org_name: text(row, 1)?,
                id: text(row, 2)?,
                name: text(row, 3)?,
                kind: text(row, 4)?,
                queries: int(row, 5)?,
                errors: int(row, 6)?,
                errors_timeout: int(row, 7)?,
                errors_rejected: int(row, 8)?,
                errors_source: int(row, 9)?,
                errors_other: int(row, 10)?,
                cache_hits: int(row, 11)?,
                cache_misses: int(row, 12)?,
                rows: int(row, 13)?,
                p50_ms: quantile(&r, max_ms, 0.5),
                p95_ms: quantile(&r, max_ms, 0.95),
                max_ms,
            })
        })
        .collect()
}

/// The oldest bucket kept for the scope, in any of the tables.
async fn since(state: &AppState, scope: &Scope<'_>) -> ApiResult<Option<i64>> {
    let mut oldest: Option<i64> = None;
    for table in ["usage_dashboard_views", "usage_panel_runs", "usage_source_queries"] {
        let mut sql = Sql::new(&scope.sources_only());
        let org = sql.org(scope, "u");
        sql.text += &format!("SELECT MIN(u.bucket) FROM {table} u WHERE 1 = 1{org}");
        if let Some(row) = sql.fetch(state).await?.first()
            && let Some(min) = opt_int(row, 0)?
        {
            oldest = Some(oldest.map_or(min, |o| o.min(min)));
        }
    }
    Ok(oldest)
}

/// Dashboards of the scope, not in the trash, without a view in the last `days` days before
/// `now_ms`: never opened in the retention first, then the longest unopened.
pub async fn unused(state: &AppState, scope: Scope<'_>, days: i64, now_ms: i64) -> ApiResult<Unused> {
    if !(1..=super::MAX_RETENTION_DAYS).contains(&days) {
        return Err(ApiError::validation("days must be between 1 and 90").with_field("days"));
    }
    let cut = bucket_of(now_ms) + HOUR_MS - days * DAY_MS;
    let mut sql = Sql::new(&scope);
    let org = sql.org(&scope, "d");
    let c = sql.arg(Arg::Int(cut));
    sql.text += &format!(
        "SELECT d.org_id, o.name, d.id, d.title, d.created_at, \
         (SELECT MAX(v.bucket) FROM usage_dashboard_views v WHERE v.org_id = d.org_id AND v.dashboard_id = d.id) \
         FROM dashboards d JOIN orgs o ON o.id = d.org_id \
         WHERE d.deleted_at IS NULL{org}{} \
         AND NOT EXISTS (SELECT 1 FROM usage_dashboard_views w \
             WHERE w.org_id = d.org_id AND w.dashboard_id = d.id AND w.bucket >= {c})",
        visible(&scope, "d"),
    );
    let mut items = sql
        .fetch(state)
        .await?
        .iter()
        .map(|row| {
            Ok(UnusedDashboard {
                org_id: text(row, 0)?,
                org_name: text(row, 1)?,
                id: text(row, 2)?,
                title: text(row, 3)?,
                created_at: int(row, 4)?,
                last_viewed_at: opt_int(row, 5)?,
            })
        })
        .collect::<ApiResult<Vec<_>>>()?;
    items.sort_by(|x, y| {
        x.last_viewed_at
            .cmp(&y.last_viewed_at)
            .then_with(|| x.title.to_lowercase().cmp(&y.title.to_lowercase()))
            .then_with(|| x.id.cmp(&y.id))
    });
    let total = items.len();
    items.truncate(MAX_UNUSED);
    Ok(Unused { days, since: cut, recorded_since: since(state, &scope).await?, items, total })
}
