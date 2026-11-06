//! What the data source list and its side panel show beyond a source itself: where it connects,
//! its stored last test, its query latency over the last 24 hours, the dashboards that use it,
//! who changed it last and which teams it is shared with; per source the dashboards using it and
//! its history. Nothing here opens a connection to a source. Documented in
//! docs/api/datasources.md ("The list", "Usage of a source", "History of a source").

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;
use sqlx::Row;

use crate::authz::{AccessIndex, OrgCtx, Permission};
use crate::datasources::{HealthRow, LastTest};
use crate::error::ApiResult;
use crate::usage::{self, RANGES};

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// The changes of a source that "Changed" names: its own, not those of its grants.
pub const CHANGE_ACTIONS: &str = "'datasource.created', 'datasource.updated', 'datasource.restored'";

/// The most entries the history of one source answers.
pub const HISTORY_LIMIT: i64 = 50;

/// One hour of queries: its start and the median duration of the queries that ran in the source.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyPoint {
    pub at: i64,
    pub ms: i64,
}

/// A team the source is shared with, and the level of its grant.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamShare {
    pub id: String,
    pub name: String,
    pub level: String,
}

/// A live source's details in the list, only for callers who may read it.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    /// Where it connects, without login, query or fragment; absent for kinds without a target.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_test: Option<LastTest>,
    /// The hours of the last 24 with queries, oldest first.
    pub latency: Vec<LatencyPoint>,
    /// The start of the last hour a query ran, within the usage retention.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
    /// Live dashboards the caller may see whose current version refers to the source.
    pub used_in: usize,
    pub updated_at: i64,
    /// The name of who made the last change, as the audit log keeps it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<String>,
    /// Teams with a grant on the source; for callers who may read teams.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teams: Option<Vec<TeamShare>>,
}

/// `$start, $start+1, ...` for `count` binds.
pub fn placeholders(start: usize, count: usize) -> String {
    (start..start + count).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ")
}

/// Where a source connects, from its settings (which never hold secrets): `url` without login,
/// query and fragment; else `host[:port]` or `hosts`, with `/database` or `/graph`; else `path`.
pub fn address(settings: &Value) -> Option<String> {
    let text = |key: &str| settings.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    if let Some(url) = text("url") {
        return Some(clean_url(url));
    }
    let base = if let Some(host) = text("host") {
        match settings.get("port").and_then(Value::as_u64) {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        }
    } else if let Some(hosts) = text("hosts") {
        hosts.to_string()
    } else {
        return text("path").map(String::from);
    };
    Some(match text("database").or_else(|| text("graph")) {
        Some(db) => format!("{base}/{db}"),
        None => base,
    })
}

/// A URL without login, query and fragment (an API key may sit in either); text that is no URL
/// is cut at the first `?` or `#` and after the last `@`.
fn clean_url(raw: &str) -> String {
    // Only a URL with a host: `user:pw@host` parses as the scheme `user` without one.
    if let Ok(mut url) = url::Url::parse(raw)
        && url.has_host()
    {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        let text = url.to_string();
        return text.strip_suffix('/').filter(|_| url.path() == "/").unwrap_or(&text).to_string();
    }
    let cut = raw.split(['?', '#']).next().unwrap_or_default();
    match cut.rsplit_once('@') {
        Some((_, rest)) => rest.to_string(),
        None => cut.to_string(),
    }
}

/// The columns of `usage_source_queries` that `UsageHour` reads.
const USAGE_COLUMNS: &str = "bucket, queries, errors, duration_max_ms, \
    d0, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12";

/// One hour of a source's usage counts.
struct UsageHour {
    bucket: i64,
    queries: i64,
    errors: i64,
    max_ms: i64,
    ranges: [i64; RANGES],
}

impl UsageHour {
    fn from_row(row: &sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let mut ranges = [0; RANGES];
        for (i, slot) in ranges.iter_mut().enumerate() {
            *slot = row.try_get(format!("d{i}").as_str())?;
        }
        Ok(Self {
            bucket: row.try_get("bucket")?,
            queries: row.try_get("queries")?,
            errors: row.try_get("errors")?,
            max_ms: row.try_get("duration_max_ms")?,
            ranges,
        })
    }
}

/// The hourly medians of the queries that ran in the source, oldest first.
fn latency_points(mut hours: Vec<UsageHour>) -> Vec<LatencyPoint> {
    hours.sort_by_key(|h| h.bucket);
    hours
        .into_iter()
        .filter_map(|h| usage::quantile(&h.ranges, h.max_ms, 0.5).map(|ms| LatencyPoint { at: h.bucket, ms }))
        .collect()
}

/// A source's row of `datasources` the list reads: id, settings and when it last changed.
pub struct SourceRow<'a> {
    pub id: &'a str,
    pub settings: &'a str,
    pub updated_at: i64,
}

/// The details of the listed sources the caller may read, in a fixed number of queries whatever
/// the number of sources (dashboards are read once for all of them).
pub async fn details(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    index: &AccessIndex,
    sources: &[SourceRow<'_>],
    now: i64,
) -> ApiResult<HashMap<String, Details>> {
    let readable: Vec<&SourceRow<'_>> = sources
        .iter()
        .filter(|s| index.datasource(s.id).is_some_and(|held| held.contains(&Permission::DatasourcesRead)))
        .collect();
    if readable.is_empty() {
        return Ok(HashMap::new());
    }
    let ids: Vec<&str> = readable.iter().map(|s| s.id).collect();
    let mut out: HashMap<String, Details> = readable
        .iter()
        .map(|s| {
            let settings = serde_json::from_str::<Value>(s.settings).unwrap_or(Value::Null);
            (s.id.to_string(), Details { address: address(&settings), updated_at: s.updated_at, ..Details::default() })
        })
        .collect();

    // The stored last tests.
    let sql = format!(
        "SELECT datasource_id, ok, warnings, tested_at, latency_ms, failing_since FROM datasource_health \
         WHERE datasource_id IN ({})",
        placeholders(1, ids.len())
    );
    let mut q = sqlx::query_as::<_, (String, i64, String, i64, Option<i64>, Option<i64>)>(sqlx::AssertSqlSafe(sql));
    for id in &ids {
        q = q.bind(*id);
    }
    for (id, ok, warnings, tested_at, latency_ms, failing_since) in q.fetch_all(&mut *conn).await? {
        let row: HealthRow = (ok, warnings, tested_at, latency_ms, failing_since);
        if let Some(d) = out.get_mut(&id) {
            d.last_test = Some(LastTest::from_row(row));
        }
    }

    // Query latency per hour over the last day, from the usage counts (kept while usage is on).
    let since = usage::bucket_of(now - DAY_MS) + HOUR_MS;
    let sql = format!(
        "SELECT datasource_id, {USAGE_COLUMNS} FROM usage_source_queries \
         WHERE org_id = $1 AND bucket >= $2 AND datasource_id IN ({})",
        placeholders(3, ids.len())
    );
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql)).bind(&ctx.org_id).bind(since);
    for id in &ids {
        q = q.bind(*id);
    }
    let mut hours: HashMap<String, Vec<UsageHour>> = HashMap::new();
    for row in q.fetch_all(&mut *conn).await? {
        hours.entry(row.try_get("datasource_id")?).or_default().push(UsageHour::from_row(&row)?);
    }
    for (id, rows) in hours {
        if let Some(d) = out.get_mut(&id) {
            d.latency = latency_points(rows);
        }
    }

    // The last hour a query ran.
    let sql = format!(
        "SELECT datasource_id, MAX(bucket) FROM usage_source_queries WHERE org_id = $1 AND queries > 0 \
         AND datasource_id IN ({}) GROUP BY datasource_id",
        placeholders(2, ids.len())
    );
    let mut q = sqlx::query_as::<_, (String, i64)>(sqlx::AssertSqlSafe(sql)).bind(&ctx.org_id);
    for id in &ids {
        q = q.bind(*id);
    }
    for (id, bucket) in q.fetch_all(&mut *conn).await? {
        if let Some(d) = out.get_mut(&id) {
            d.last_used_at = Some(bucket);
        }
    }

    // Who made the last change: the newest change entry of each source in the audit log.
    let sql = format!(
        "SELECT a.resource_id, u.name, a.created_at FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id \
         WHERE a.org_id = $1 AND a.resource_type = 'datasource' AND a.action IN ({CHANGE_ACTIONS}) \
         AND a.resource_id IN ({ids}) AND a.created_at = (SELECT MAX(b.created_at) FROM audit_events b \
         WHERE b.org_id = a.org_id AND b.resource_type = 'datasource' AND b.resource_id = a.resource_id \
         AND b.action IN ({CHANGE_ACTIONS}))",
        ids = placeholders(2, ids.len())
    );
    let mut q = sqlx::query_as::<_, (String, Option<String>, i64)>(sqlx::AssertSqlSafe(sql)).bind(&ctx.org_id);
    for id in &ids {
        q = q.bind(*id);
    }
    for (id, name, _) in q.fetch_all(&mut *conn).await? {
        if let Some(d) = out.get_mut(&id)
            && d.updated_by.is_none()
        {
            d.updated_by = name;
        }
    }

    // The teams each source is shared with, for callers who may read teams.
    if ctx.permissions.contains(&Permission::TeamsRead) {
        let sql = format!(
            "SELECT g.resource_id, t.id, t.name, g.level FROM resource_grants g JOIN teams t ON t.id = g.subject_id \
             WHERE g.org_id = $1 AND g.resource_type = 'datasource' AND g.subject_type = 'team' \
             AND g.resource_id IN ({}) ORDER BY t.name, t.id",
            placeholders(2, ids.len())
        );
        let mut q = sqlx::query_as::<_, (String, String, String, String)>(sqlx::AssertSqlSafe(sql)).bind(&ctx.org_id);
        for id in &ids {
            q = q.bind(*id);
        }
        for d in out.values_mut() {
            d.teams = Some(Vec::new());
        }
        for (source, id, name, level) in q.fetch_all(&mut *conn).await? {
            if let Some(teams) = out.get_mut(&source).and_then(|d| d.teams.as_mut()) {
                teams.push(TeamShare { id, name, level });
            }
        }
    }

    // The dashboards that use them: the current models, read once, matched per source.
    for dashboard in visible_dashboards(conn, ctx, index).await? {
        for id in &ids {
            if dashboard.refers_to(id)
                && let Some(d) = out.get_mut(*id)
            {
                d.used_in += 1;
            }
        }
    }
    Ok(out)
}

/// A live dashboard the caller may see, with its current model.
pub struct DashboardModel {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    model: String,
}

impl DashboardModel {
    /// Whether the model refers to the source. The ids are UUIDs, so the quoted id in a stored
    /// model is a reference and nothing else (as the purge checks it).
    pub fn refers_to(&self, datasource_id: &str) -> bool {
        self.model.contains(&format!("\"{datasource_id}\""))
    }
}

/// The organization's live dashboards the caller may read, with their current models.
pub async fn visible_dashboards(
    conn: &mut sqlx::AnyConnection,
    ctx: &OrgCtx,
    index: &AccessIndex,
) -> ApiResult<Vec<DashboardModel>> {
    let rows: Vec<(String, Option<String>, String, i64, String)> = sqlx::query_as(
        "SELECT d.id, d.folder_id, d.title, d.updated_at, v.model FROM dashboards d \
         JOIN dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.version \
         WHERE d.org_id = $1 AND d.deleted_at IS NULL",
    )
    .bind(&ctx.org_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(id, folder, ..)| {
            index.dashboard(id, folder.as_deref()).is_some_and(|held| held.contains(&Permission::DashboardsRead))
        })
        .map(|(id, _, title, updated_at, model)| DashboardModel { id, title, updated_at, model })
        .collect())
}

/// The usage of one source in the last 24 hours: queries, failed queries, and the hours.
pub async fn day_usage(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    datasource_id: &str,
    now: i64,
) -> ApiResult<(i64, i64, Vec<LatencyPoint>)> {
    let since = usage::bucket_of(now - DAY_MS) + HOUR_MS;
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {USAGE_COLUMNS} FROM usage_source_queries WHERE org_id = $1 AND datasource_id = $2 AND bucket >= $3"
    )))
    .bind(org_id)
    .bind(datasource_id)
    .bind(since)
    .fetch_all(&mut *conn)
    .await?;
    let hours = rows.iter().map(UsageHour::from_row).collect::<Result<Vec<_>, _>>()?;
    let queries = hours.iter().map(|h| h.queries).sum();
    let errors = hours.iter().map(|h| h.errors).sum();
    Ok((queries, errors, latency_points(hours)))
}

/// One entry of a source's history: what happened, who did it, when.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    /// The audit entry's id.
    pub id: String,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_name: Option<String>,
    pub at: i64,
}

/// The newest entries of the audit log about one source (its changes and its grants), without
/// their details: those stay in the audit log for who may read it.
pub async fn history(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    datasource_id: &str,
) -> ApiResult<Vec<HistoryEntry>> {
    let rows: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT a.id, a.action, u.name, a.created_at FROM audit_events a LEFT JOIN users u ON u.id = a.actor_user_id \
         WHERE a.org_id = $1 AND a.resource_type = 'datasource' AND a.resource_id = $2 \
         ORDER BY a.created_at DESC, a.id DESC LIMIT $3",
    )
    .bind(org_id)
    .bind(datasource_id)
    .bind(HISTORY_LIMIT)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(|(id, action, actor_name, at)| HistoryEntry { id, action, actor_name, at }).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn address_leaves_out_logins_and_queries() {
        assert_eq!(
            address(&json!({"host": "db.intern", "port": 5432, "database": "shop"})).unwrap(),
            "db.intern:5432/shop"
        );
        assert_eq!(address(&json!({"host": "db.intern"})).unwrap(), "db.intern");
        assert_eq!(
            address(&json!({"hosts": "a:27017,b:27017", "database": "orders"})).unwrap(),
            "a:27017,b:27017/orders"
        );
        assert_eq!(address(&json!({"url": "https://ada:pw@prom.intern:9090/"})).unwrap(), "https://prom.intern:9090");
        assert_eq!(
            address(&json!({"url": "https://api.example.org/v2?apikey=secret#x"})).unwrap(),
            "https://api.example.org/v2"
        );
        assert_eq!(address(&json!({"url": "not a url?key=1"})).unwrap(), "not a url");
        assert_eq!(address(&json!({"url": "user:pw@host/x"})).unwrap(), "host/x");
        assert_eq!(address(&json!({"path": "/data/shop.db"})).unwrap(), "/data/shop.db");
        assert_eq!(address(&json!({"host": "graph", "port": 7687, "graph": "social"})).unwrap(), "graph:7687/social");
        assert_eq!(address(&json!({"maxRows": 10})), None);
        assert_eq!(address(&json!({"url": "  "})), None);
    }

    #[test]
    fn latency_is_hourly_and_ordered() {
        let hour = |bucket, n| {
            let mut ranges = [0; RANGES];
            ranges[0] = n;
            UsageHour { bucket, queries: n, errors: 0, max_ms: 3, ranges }
        };
        let points = latency_points(vec![hour(2 * HOUR_MS, 4), hour(HOUR_MS, 4), hour(0, 0)]);
        assert_eq!(points.iter().map(|p| p.at).collect::<Vec<_>>(), vec![HOUR_MS, 2 * HOUR_MS]);
    }

    #[test]
    fn placeholders_count_from_start() {
        assert_eq!(placeholders(3, 2), "$3, $4");
        assert_eq!(placeholders(1, 0), "");
    }
}
