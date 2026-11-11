//! Alert rules (docs/api/alerting.md, "Rules"). Saving one needs `alerts:write`, the right to
//! query its data source for the person saving, and the source's alerting opt-in; it can only
//! use contact points and dashboards of its own organization.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::known_id;
use crate::alerting::eval::stored_error;
use crate::alerting::rule::{
    self, Condition, ERROR_STATES, NO_DATA_STATES, RULE_NAME_LABEL, Reduce, RuleQuery, check_labels, invalid,
};
use crate::alerting::{limits, service_account, silences};
use crate::app::AppState;
use crate::authz::{AccessIndex, DatasourceAccess, OrgCtx, Permission, Resource, check_resource, lock_org};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::routes::support::{Actor, QueryParams, audit, clean_text, conflict};
use crate::shapes::Page;

const MAX_DESCRIPTION_CHARS: usize = 2000;
const MAX_URL_CHARS: usize = 2048;
const MAX_PANEL_ID_CHARS: usize = 64;
/// The longest interval, "for" duration and query range.
const MAX_INTERVAL_SECS: i64 = 86_400;
const MAX_FOR_SECS: i64 = 86_400;
const MAX_RANGE_SECS: i64 = 30 * 86_400;
const MIN_REMINDER_SECS: i64 = 60;
const MAX_REMINDER_SECS: i64 = 7 * 86_400;

fn default_range() -> i64 {
    600
}
fn default_interval() -> i64 {
    60
}
fn default_no_data() -> String {
    "no_data".into()
}
fn default_error() -> String {
    "error".into()
}
fn default_reminder() -> i64 {
    4 * 3600
}

/// A rule as `POST` and `PUT` take it. `version` is required for `PUT`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuleBody {
    name: String,
    #[serde(default)]
    description: String,
    runbook_url: Option<String>,
    datasource_id: String,
    query: RuleQuery,
    #[serde(default = "default_range")]
    range_secs: i64,
    reduce: Value,
    condition: Value,
    #[serde(default = "default_interval")]
    interval_secs: i64,
    #[serde(default)]
    for_secs: i64,
    #[serde(default = "default_no_data")]
    no_data_state: String,
    #[serde(default = "default_error")]
    error_state: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default = "default_reminder")]
    reminder_secs: i64,
    #[serde(default)]
    contact_point_ids: Vec<String>,
    dashboard_id: Option<String>,
    panel_id: Option<String>,
    version: Option<i64>,
}

/// A body that passed every check that needs no database.
struct Clean {
    name: String,
    description: String,
    runbook_url: Option<String>,
    datasource_id: String,
    query: String,
    range_secs: i64,
    reduce: String,
    condition: String,
    interval_secs: i64,
    for_secs: i64,
    no_data_state: String,
    error_state: String,
    labels: String,
    reminder_secs: i64,
    contact_point_ids: Vec<String>,
    dashboard_id: Option<String>,
    panel_id: Option<String>,
}

fn check_runbook(raw: Option<&str>) -> ApiResult<Option<String>> {
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else { return Ok(None) };
    let ok = raw.chars().count() <= MAX_URL_CHARS
        && url::Url::parse(raw).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
        });
    if ok {
        Ok(Some(raw.to_string()))
    } else {
        Err(invalid(
            "runbookUrl",
            "runbookUrl is an http or https address without credentials",
            "alerts.runbook_url_invalid",
        ))
    }
}

fn check_body(body: RuleBody, min_interval_secs: u64, max_contact_points: u64) -> ApiResult<Clean> {
    let name = crate::routes::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    let description =
        clean_text(&body.description, "description", MAX_DESCRIPTION_CHARS).map_err(|e| e.with_field("description"))?;
    let runbook_url = check_runbook(body.runbook_url.as_deref())?;
    body.query.check()?;
    let reduce = Reduce::parse(&body.reduce)?;
    let condition = Condition::parse(&body.condition)?;
    let min_interval = i64::try_from(min_interval_secs).unwrap_or(i64::MAX);
    if body.interval_secs < min_interval || body.interval_secs > MAX_INTERVAL_SECS {
        return Err(ApiError::validation(format!(
            "intervalSecs is {min_interval} to {MAX_INTERVAL_SECS} seconds in this organization"
        ))
        .with_field("intervalSecs")
        .because("alerts.interval_invalid")
        .param("min", min_interval)
        .param("max", MAX_INTERVAL_SECS));
    }
    if body.for_secs < 0 || body.for_secs > MAX_FOR_SECS || body.for_secs % body.interval_secs != 0 {
        return Err(ApiError::validation(format!(
            "forSecs is a multiple of the interval, at most {MAX_FOR_SECS} seconds"
        ))
        .with_field("forSecs")
        .because("alerts.for_invalid")
        .param("max", MAX_FOR_SECS));
    }
    if body.range_secs < 1 || body.range_secs > MAX_RANGE_SECS {
        return Err(invalid(
            "rangeSecs",
            format!("rangeSecs is 1 to {MAX_RANGE_SECS} seconds"),
            "alerts.range_invalid",
        ));
    }
    if !NO_DATA_STATES.contains(&body.no_data_state.as_str()) {
        return Err(invalid("noDataState", "noDataState is no_data, ok or firing", "alerts.state_option_invalid"));
    }
    if !ERROR_STATES.contains(&body.error_state.as_str()) {
        return Err(invalid("errorState", "errorState is error or keep", "alerts.state_option_invalid"));
    }
    if body.reminder_secs != 0 && !(MIN_REMINDER_SECS..=MAX_REMINDER_SECS).contains(&body.reminder_secs) {
        return Err(invalid(
            "reminderSecs",
            format!("reminderSecs is 0 (off) or {MIN_REMINDER_SECS} to {MAX_REMINDER_SECS} seconds"),
            "alerts.reminder_invalid",
        ));
    }
    check_labels(&body.labels)?;
    let contact_point_ids: Vec<String> =
        body.contact_point_ids.into_iter().collect::<BTreeSet<_>>().into_iter().collect();
    if contact_point_ids.len() as u64 > max_contact_points {
        return Err(ApiError::validation(format!("a rule notifies at most {max_contact_points} contact points"))
            .with_field("contactPointIds")
            .because("alerts.too_many_contact_points")
            .param("max", max_contact_points));
    }
    let panel_id = body.panel_id.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if panel_id.as_ref().is_some_and(|p| p.chars().count() > MAX_PANEL_ID_CHARS || p.chars().any(char::is_control))
        || (panel_id.is_some() && body.dashboard_id.is_none())
    {
        return Err(invalid("panelId", "panelId names a panel of dashboardId", "alerts.panel_invalid"));
    }
    Ok(Clean {
        name,
        description,
        runbook_url,
        datasource_id: body.datasource_id,
        query: to_json(&body.query),
        range_secs: body.range_secs,
        reduce: to_json(&reduce),
        condition: to_json(&condition),
        interval_secs: body.interval_secs,
        for_secs: body.for_secs,
        no_data_state: body.no_data_state,
        error_state: body.error_state,
        labels: to_json(&body.labels),
        reminder_secs: body.reminder_secs,
        contact_point_ids,
        dashboard_id: body.dashboard_id,
        panel_id,
    })
}

/// The checked parts as stored; they always serialize.
fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// The checks that need the database, outside the change's transaction: the source (the saver
/// may query it, it is opted in) and the dashboard (in the organization, readable).
async fn check_targets(state: &AppState, ctx: &OrgCtx, clean: &Clean) -> ApiResult<()> {
    let ds = crate::datasources::find_in_org(&state.db, &ctx.org_id, &clean.datasource_id, false)
        .await
        .map_err(|e| e.with_field("datasourceId"))?;
    check_resource(&state.db, ctx, Permission::DatasourcesQuery, Resource::Datasource(&ds.id))
        .await
        .map_err(|e| e.with_field("datasourceId"))?;
    if !service_account::may_query(&state.db, &ctx.org_id, &ds.id).await? {
        return Err(service_account::not_opted_in());
    }
    if let Some(dashboard_id) = &clean.dashboard_id {
        let found: Option<(String,)> =
            sqlx::query_as("SELECT id FROM dashboards WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL")
                .bind(dashboard_id)
                .bind(&ctx.org_id)
                .fetch_optional(&state.db)
                .await?;
        if found.is_none() {
            return Err(ApiError::not_found().with_field("dashboardId"));
        }
        check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(dashboard_id))
            .await
            .map_err(|e| e.with_field("dashboardId"))?;
    }
    Ok(())
}

/// The contact points must all be in the organization (an id of another one is not found).
async fn check_contact_points(conn: &mut sqlx::AnyConnection, org_id: &str, ids: &[String]) -> ApiResult<()> {
    for id in ids {
        let found: Option<(String,)> =
            sqlx::query_as("SELECT id FROM alert_contact_points WHERE id = $1 AND org_id = $2")
                .bind(id)
                .bind(org_id)
                .fetch_optional(&mut *conn)
                .await?;
        if found.is_none() {
            return Err(ApiError::not_found().with_field("contactPointIds"));
        }
    }
    Ok(())
}

async fn link_contact_points(conn: &mut sqlx::AnyConnection, rule_id: &str, ids: &[String]) -> ApiResult<()> {
    sqlx::query("DELETE FROM alert_rule_contact_points WHERE rule_id = $1").bind(rule_id).execute(&mut *conn).await?;
    for id in ids {
        sqlx::query("INSERT INTO alert_rule_contact_points (rule_id, contact_point_id) VALUES ($1, $2)")
            .bind(rule_id)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct RuleRow {
    id: String,
    name: String,
    description: String,
    runbook_url: Option<String>,
    datasource_id: String,
    query: String,
    range_secs: i64,
    reduce: String,
    condition: String,
    interval_secs: i64,
    for_secs: i64,
    no_data_state: String,
    error_state: String,
    labels: String,
    reminder_secs: i64,
    paused: i64,
    dashboard_id: Option<String>,
    panel_id: Option<String>,
    version: i64,
    created_by: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_by_name: Option<String>,
    updated_at: i64,
    last_evaluated_at: Option<i64>,
    last_duration_ms: Option<i64>,
    last_error: Option<String>,
    skipped_evaluations: i64,
    dashboard_folder_id: Option<String>,
}

const RULE_COLUMNS: &str = "SELECT r.id, r.name, r.description, r.runbook_url, r.datasource_id, r.query, r.range_secs, \
     r.reduce, r.condition, r.interval_secs, r.for_secs, r.no_data_state, r.error_state, r.labels, r.reminder_secs, \
     r.paused, r.dashboard_id, r.panel_id, r.version, r.created_by, r.created_at, r.updated_by, \
     (SELECT u.name FROM users u WHERE u.id = r.updated_by) AS updated_by_name, r.updated_at, r.last_evaluated_at, \
     r.last_duration_ms, r.last_error, r.skipped_evaluations, d.folder_id AS dashboard_folder_id \
     FROM alert_rules r LEFT JOIN dashboards d ON d.id = r.dashboard_id WHERE r.org_id = $1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    id: String,
    name: String,
    description: String,
    runbook_url: Option<String>,
    datasource_id: String,
    /// `null` when the caller may neither read nor query the data source (`queryHidden`).
    query: Option<Value>,
    query_hidden: bool,
    range_secs: i64,
    reduce: Value,
    condition: Value,
    interval_secs: i64,
    for_secs: i64,
    no_data_state: String,
    error_state: String,
    labels: BTreeMap<String, String>,
    reminder_secs: i64,
    paused: bool,
    contact_point_ids: Vec<String>,
    /// The panel the rule was made from; `null` when the caller may not read that dashboard.
    dashboard_id: Option<String>,
    panel_id: Option<String>,
    version: i64,
    created_by: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_by_name: Option<String>,
    updated_at: i64,
    last_evaluated_at: Option<i64>,
    last_duration_ms: Option<i64>,
    /// Why the last evaluation failed, as `{code, params}` (as an instance's `lastError`).
    last_error: Option<serde_json::Value>,
    skipped_evaluations: i64,
    /// The most severe state of its instances (`firing`, `error`, `no_data`, `pending`, `ok`), or
    /// `null` while it has none (not evaluated yet, or paused).
    state: Option<String>,
    /// Instances per state.
    instance_counts: BTreeMap<String, i64>,
    /// With `GET /rules/{ruleId}` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    instances: Option<Vec<Instance>>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRow {
    fingerprint: String,
    labels: String,
    state: String,
    state_since: i64,
    pending_since: Option<i64>,
    pending_target: Option<String>,
    last_evaluated_at: Option<i64>,
    last_value: Option<f64>,
    last_error: Option<String>,
    last_notified_at: Option<i64>,
    last_notified_state: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    fingerprint: String,
    labels: BTreeMap<String, String>,
    state: String,
    state_since: i64,
    pending_since: Option<i64>,
    /// The state a pending instance waits for (`firing`, `no_data` or `error`).
    pending_target: Option<String>,
    last_evaluated_at: Option<i64>,
    last_value: Option<f64>,
    /// Why the last evaluation failed, as `{code, params}` for the catalogs (`alerting.*`).
    last_error: Option<serde_json::Value>,
    last_notified_at: Option<i64>,
    last_notified_state: Option<String>,
    /// Active silences that match the instance.
    silenced_by: Vec<String>,
}

/// Most severe first.
const SEVERITY: [&str; 5] = ["firing", "error", "no_data", "pending", "ok"];

fn worst(counts: &BTreeMap<String, i64>) -> Option<String> {
    SEVERITY.iter().find(|s| counts.get(**s).is_some_and(|n| *n > 0)).map(|s| s.to_string())
}

fn parse_json<T: serde::de::DeserializeOwned + Default>(text: &str) -> T {
    serde_json::from_str(text).unwrap_or_default()
}

/// What the caller may see of rules: the data sources (for the query) and the dashboards (for
/// the panel link). Read without audit entries; this only hides parts of the answer.
struct Visibility {
    datasources: DatasourceAccess,
    index: AccessIndex,
}

impl Visibility {
    async fn load(state: &AppState, ctx: &OrgCtx) -> ApiResult<Self> {
        let datasources = DatasourceAccess::load(&state.db, ctx).await?;
        let mut conn = state.db.acquire().await?;
        let index = AccessIndex::load(&mut conn, ctx).await?;
        Ok(Self { datasources, index })
    }

    fn view(
        &self,
        row: RuleRow,
        contact_points: Vec<String>,
        counts: BTreeMap<String, i64>,
        instances: Option<Vec<Instance>>,
    ) -> Rule {
        // The query text is what the source settings and queries show: for people who may read or
        // query the source, not for viewers who only see the rule.
        let query_visible = self.datasources.permissions(&row.datasource_id).is_some_and(|held| {
            held.contains(&Permission::DatasourcesRead) || held.contains(&Permission::DatasourcesQuery)
        });
        let dashboard_visible = row.dashboard_id.as_deref().is_some_and(|id| {
            self.index
                .dashboard(id, row.dashboard_folder_id.as_deref())
                .is_some_and(|held| held.contains(&Permission::DashboardsRead))
        });
        Rule {
            id: row.id,
            name: row.name,
            description: row.description,
            runbook_url: row.runbook_url,
            datasource_id: row.datasource_id,
            query: query_visible.then(|| parse_json::<Value>(&row.query)),
            query_hidden: !query_visible,
            range_secs: row.range_secs,
            reduce: parse_json(&row.reduce),
            condition: parse_json(&row.condition),
            interval_secs: row.interval_secs,
            for_secs: row.for_secs,
            no_data_state: row.no_data_state,
            error_state: row.error_state,
            labels: parse_json(&row.labels),
            reminder_secs: row.reminder_secs,
            paused: row.paused != 0,
            contact_point_ids: contact_points,
            dashboard_id: row.dashboard_id.filter(|_| dashboard_visible),
            panel_id: row.panel_id.filter(|_| dashboard_visible),
            version: row.version,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_by: row.updated_by,
            updated_by_name: row.updated_by_name,
            updated_at: row.updated_at,
            last_evaluated_at: row.last_evaluated_at,
            last_duration_ms: row.last_duration_ms,
            last_error: stored_error(row.last_error.as_deref()),
            skipped_evaluations: row.skipped_evaluations,
            state: worst(&counts),
            instance_counts: counts,
            instances,
        }
    }
}

async fn load_row<'e, E>(db: E, org_id: &str, rule_id: &str) -> ApiResult<RuleRow>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    known_id(rule_id)?;
    let row: Option<RuleRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{RULE_COLUMNS} AND r.id = $2")))
        .bind(org_id)
        .bind(rule_id)
        .fetch_optional(db)
        .await?;
    row.ok_or_else(ApiError::not_found)
}

async fn contact_points_of(db: &sqlx::AnyPool, rule_id: &str) -> ApiResult<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT contact_point_id FROM alert_rule_contact_points WHERE rule_id = $1 ORDER BY contact_point_id",
    )
    .bind(rule_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

async fn counts_of(db: &sqlx::AnyPool, rule_id: &str) -> ApiResult<BTreeMap<String, i64>> {
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT state, COUNT(*) FROM alert_instances WHERE rule_id = $1 GROUP BY state")
            .bind(rule_id)
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// The active silences of the organization at `now`, with their matchers.
pub(super) async fn active_silences(
    db: &sqlx::AnyPool,
    org_id: &str,
    now: i64,
) -> ApiResult<Vec<(String, silences::Compiled)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, matchers FROM alert_silences WHERE org_id = $1 AND starts_at <= $2 AND ends_at > $2 \
         AND ended_at IS NULL ORDER BY id",
    )
    .bind(org_id)
    .bind(now)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, m)| (id, silences::Compiled::new(&parse_json::<Vec<silences::Matcher>>(&m))))
        .collect())
}

/// An instance's labels with the rule's name, as silences and messages see them.
pub(super) fn with_rule_name(mut labels: BTreeMap<String, String>, rule_name: &str) -> BTreeMap<String, String> {
    labels.insert(RULE_NAME_LABEL.to_string(), rule_name.to_string());
    labels
}

async fn instances_of(state: &AppState, org_id: &str, rule_id: &str, rule_name: &str) -> ApiResult<Vec<Instance>> {
    let rows: Vec<InstanceRow> = sqlx::query_as(
        "SELECT fingerprint, labels, state, state_since, pending_since, pending_target, last_evaluated_at, last_value, \
         last_error, last_notified_at, last_notified_state FROM alert_instances WHERE rule_id = $1 ORDER BY fingerprint",
    )
    .bind(rule_id)
    .fetch_all(&state.db)
    .await?;
    let active = active_silences(&state.db, org_id, state.clock.now_ms()).await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let labels: BTreeMap<String, String> = parse_json(&r.labels);
            let full = with_rule_name(labels.clone(), rule_name);
            let silenced_by = active.iter().filter(|(_, m)| m.matches(&full)).map(|(id, _)| id.clone()).collect();
            Instance {
                fingerprint: r.fingerprint,
                labels,
                state: r.state,
                state_since: r.state_since,
                pending_since: r.pending_since,
                pending_target: r.pending_target,
                last_evaluated_at: r.last_evaluated_at,
                last_value: r.last_value,
                last_error: stored_error(r.last_error.as_deref()),
                last_notified_at: r.last_notified_at,
                last_notified_state: r.last_notified_state,
                silenced_by,
            }
        })
        .collect())
}

async fn rule_view(state: &AppState, ctx: &OrgCtx, rule_id: &str, with_instances: bool) -> ApiResult<Rule> {
    let row = load_row(&state.db, &ctx.org_id, rule_id).await?;
    let visibility = Visibility::load(state, ctx).await?;
    let contact_points = contact_points_of(&state.db, &row.id).await?;
    let counts = counts_of(&state.db, &row.id).await?;
    let instances = match with_instances {
        true => Some(instances_of(state, &ctx.org_id, &row.id, &row.name).await?),
        false => None,
    };
    Ok(visibility.view(row, contact_points, counts, instances))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    datasource_id: Option<String>,
    dashboard_id: Option<String>,
    panel_id: Option<String>,
    /// The most severe state of a rule's instances.
    state: Option<String>,
}

/// The organization's rules by name (at most `alerting.max_rules_per_org`, so in one page).
pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Rule>>> {
    if let Some(s) = &q.state
        && !rule::STATES.contains(&s.as_str())
    {
        return Err(invalid("state", "state is ok, pending, firing, no_data or error", "alerts.state_option_invalid"));
    }
    // The badge of a panel: only for people who may read its dashboard.
    if let Some(dashboard_id) = &q.dashboard_id {
        known_id(dashboard_id)?;
        let found: Option<(String,)> = sqlx::query_as("SELECT id FROM dashboards WHERE id = $1 AND org_id = $2")
            .bind(dashboard_id)
            .bind(&ctx.org_id)
            .fetch_optional(&state.db)
            .await?;
        if found.is_none() {
            return Err(ApiError::not_found());
        }
        check_resource(&state.db, &ctx, Permission::DashboardsRead, Resource::Dashboard(dashboard_id)).await?;
    }
    let rows: Vec<RuleRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(RULE_COLUMNS)).bind(&ctx.org_id).fetch_all(&state.db).await?;
    let links: Vec<(String, String)> = sqlx::query_as(
        "SELECT l.rule_id, l.contact_point_id FROM alert_rule_contact_points l JOIN alert_rules r ON r.id = l.rule_id \
         WHERE r.org_id = $1 ORDER BY l.contact_point_id",
    )
    .bind(&ctx.org_id)
    .fetch_all(&state.db)
    .await?;
    let counts: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT rule_id, state, COUNT(*) FROM alert_instances WHERE org_id = $1 GROUP BY rule_id, state",
    )
    .bind(&ctx.org_id)
    .fetch_all(&state.db)
    .await?;
    let mut links_by: HashMap<String, Vec<String>> = HashMap::new();
    for (rule_id, cp) in links {
        links_by.entry(rule_id).or_default().push(cp);
    }
    let mut counts_by: HashMap<String, BTreeMap<String, i64>> = HashMap::new();
    for (rule_id, s, n) in counts {
        counts_by.entry(rule_id).or_default().insert(s, n);
    }
    let visibility = Visibility::load(&state, &ctx).await?;
    let mut items: Vec<Rule> = rows
        .into_iter()
        .filter(|r| q.datasource_id.as_ref().is_none_or(|d| *d == r.datasource_id))
        .filter(|r| q.dashboard_id.is_none() || r.dashboard_id == q.dashboard_id)
        .filter(|r| q.panel_id.is_none() || r.panel_id == q.panel_id)
        .map(|r| {
            let cps = links_by.remove(&r.id).unwrap_or_default();
            let counts = counts_by.remove(&r.id).unwrap_or_default();
            visibility.view(r, cps, counts, None)
        })
        .filter(|r| q.state.is_none() || r.state == q.state)
        .collect();
    items.sort_by(|a, b| crate::collation::compare(&a.name, &b.name).then_with(|| a.id.cmp(&b.id)));
    Ok(Json(Page { items, next_cursor: None }))
}

pub async fn detail(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, rule_id)): Path<(String, String)>,
) -> ApiResult<Json<Rule>> {
    Ok(Json(rule_view(&state, &ctx, &rule_id, true).await?))
}

fn summary(rule_id: &str, clean_name: &str, datasource_id: &str, contact_points: usize) -> Value {
    json!({ "ruleId": rule_id, "name": clean_name, "datasourceId": datasource_id, "contactPoints": contact_points })
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<RuleBody>,
) -> ApiResult<(StatusCode, Json<Rule>)> {
    if body.version.is_some() {
        return Err(invalid("version", "a new rule has no version", "alerts.version_unexpected"));
    }
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let clean = check_body(body, limits.min_interval_secs, limits.max_contact_points_per_rule)?;
    check_targets(&state, &ctx, &clean).await?;
    let id = crate::routes::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_rules WHERE org_id = $1")
        .bind(&ctx.org_id)
        .fetch_one(&mut *tx)
        .await?;
    if count as u64 >= limits.max_rules_per_org {
        return Err(conflict(format!("this organization has its {} alert rules", limits.max_rules_per_org))
            .because("alerts.too_many_rules")
            .param("max", limits.max_rules_per_org));
    }
    check_contact_points(&mut tx, &ctx.org_id, &clean.contact_point_ids).await?;
    service_account::ensure(&mut tx, &ctx.org_id, now).await?;
    sqlx::query(
        "INSERT INTO alert_rules (id, org_id, name, description, runbook_url, datasource_id, query, range_secs, reduce, \
         condition, interval_secs, for_secs, no_data_state, error_state, labels, reminder_secs, paused, dashboard_id, \
         panel_id, version, created_by, created_at, updated_by, updated_at, skipped_evaluations) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 0, $17, $18, 1, $19, $20, $19, \
         $20, 0)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&clean.name)
    .bind(&clean.description)
    .bind(&clean.runbook_url)
    .bind(&clean.datasource_id)
    .bind(&clean.query)
    .bind(clean.range_secs)
    .bind(&clean.reduce)
    .bind(&clean.condition)
    .bind(clean.interval_secs)
    .bind(clean.for_secs)
    .bind(&clean.no_data_state)
    .bind(&clean.error_state)
    .bind(&clean.labels)
    .bind(clean.reminder_secs)
    .bind(&clean.dashboard_id)
    .bind(&clean.panel_id)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    link_contact_points(&mut tx, &id, &clean.contact_point_ids).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = summary(&id, &clean.name, &clean.datasource_id, clean.contact_point_ids.len());
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_rule.created", ("alert_rule", &id), summary).await?;
    crate::db::commit(tx).await?;
    state.alerting.changed();
    Ok((StatusCode::CREATED, Json(rule_view(&state, &ctx, &id, false).await?)))
}

/// A change of a stored rule also needs the right to query the source it uses now, not only the
/// one a new body names: whoever may not query a source cannot change or remove what is
/// evaluated on it.
async fn check_stored_source(state: &AppState, ctx: &OrgCtx, row: &RuleRow) -> ApiResult<()> {
    check_resource(&state.db, ctx, Permission::DatasourcesQuery, Resource::Datasource(&row.datasource_id))
        .await
        .map_err(|_| {
            ApiError::forbidden("changing this rule needs the right to query its data source")
                .because("alerts.datasource_forbidden")
        })
}

/// Replaces a rule. `version` must be the stored one; a newer one answers `version_conflict`
/// with the stored rule. Pausing has its own routes.
pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, rule_id)): Path<(String, String)>,
    JsonBody(body): JsonBody<RuleBody>,
) -> ApiResult<Json<Rule>> {
    let stored = load_row(&state.db, &ctx.org_id, &rule_id).await?;
    check_stored_source(&state, &ctx, &stored).await?;
    let Some(expected) = body.version else {
        return Err(invalid("version", "version is the version the change is based on", "alerts.version_required"));
    };
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let clean = check_body(body, limits.min_interval_secs, limits.max_contact_points_per_rule)?;
    check_targets(&state, &ctx, &clean).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    check_contact_points(&mut tx, &ctx.org_id, &clean.contact_point_ids).await?;
    let changed = sqlx::query(
        "UPDATE alert_rules SET name = $1, description = $2, runbook_url = $3, datasource_id = $4, query = $5, \
         range_secs = $6, reduce = $7, condition = $8, interval_secs = $9, for_secs = $10, no_data_state = $11, \
         error_state = $12, labels = $13, reminder_secs = $14, dashboard_id = $15, panel_id = $16, \
         version = version + 1, updated_by = $17, updated_at = $18 WHERE id = $19 AND org_id = $20 AND version = $21",
    )
    .bind(&clean.name)
    .bind(&clean.description)
    .bind(&clean.runbook_url)
    .bind(&clean.datasource_id)
    .bind(&clean.query)
    .bind(clean.range_secs)
    .bind(&clean.reduce)
    .bind(&clean.condition)
    .bind(clean.interval_secs)
    .bind(clean.for_secs)
    .bind(&clean.no_data_state)
    .bind(&clean.error_state)
    .bind(&clean.labels)
    .bind(clean.reminder_secs)
    .bind(&clean.dashboard_id)
    .bind(&clean.panel_id)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&rule_id)
    .bind(&ctx.org_id)
    .bind(expected)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed == 0 {
        drop(tx);
        let current = rule_view(&state, &ctx, &rule_id, false).await?;
        return Err(ApiError::version_conflict(serde_json::to_value(current).unwrap_or_default()));
    }
    link_contact_points(&mut tx, &rule_id, &clean.contact_point_ids).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = summary(&rule_id, &clean.name, &clean.datasource_id, clean.contact_point_ids.len());
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_rule.updated", ("alert_rule", &rule_id), summary).await?;
    crate::db::commit(tx).await?;
    state.alerting.changed();
    Ok(Json(rule_view(&state, &ctx, &rule_id, false).await?))
}

/// Deletes a rule with its instances; its history stays until the retention ends.
pub async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, rule_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row = load_row(&state.db, &ctx.org_id, &rule_id).await?;
    check_stored_source(&state, &ctx, &row).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let removed = sqlx::query("DELETE FROM alert_rules WHERE id = $1 AND org_id = $2")
        .bind(&rule_id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if removed == 0 {
        return Err(ApiError::not_found());
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "ruleId": rule_id, "name": row.name, "datasourceId": row.datasource_id });
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_rule.deleted", ("alert_rule", &rule_id), summary).await?;
    crate::db::commit(tx).await?;
    state.alerting.changed();
    Ok(StatusCode::NO_CONTENT)
}

async fn set_paused(
    state: &AppState,
    ctx: &OrgCtx,
    info: &RequestInfo,
    rule_id: &str,
    paused: bool,
) -> ApiResult<Rule> {
    let now = state.clock.now_ms();
    let row = load_row(&state.db, &ctx.org_id, rule_id).await?;
    check_stored_source(state, ctx, &row).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    if (row.paused != 0) != paused {
        sqlx::query(
            "UPDATE alert_rules SET paused = $1, version = version + 1, updated_by = $2, updated_at = $3 \
             WHERE id = $4 AND org_id = $5",
        )
        .bind(i64::from(paused))
        .bind(&ctx.user.id)
        .bind(now)
        .bind(rule_id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
        // Paused rules have no instances; on resume everything starts at OK.
        sqlx::query("DELETE FROM alert_instances WHERE rule_id = $1").bind(rule_id).execute(&mut *tx).await?;
        let actor = Actor { user_id: &ctx.user.id, info, at_ms: now };
        let action = if paused { "alert_rule.paused" } else { "alert_rule.resumed" };
        let summary = json!({ "ruleId": rule_id, "name": row.name });
        audit(&mut tx, &actor, Some(&ctx.org_id), action, ("alert_rule", rule_id), summary).await?;
    }
    crate::db::commit(tx).await?;
    state.alerting.changed();
    rule_view(state, ctx, rule_id, false).await
}

pub async fn pause(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, rule_id)): Path<(String, String)>,
) -> ApiResult<Json<Rule>> {
    Ok(Json(set_paused(&state, &ctx, &info, &rule_id, true).await?))
}

pub async fn resume(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, rule_id)): Path<(String, String)>,
) -> ApiResult<Json<Rule>> {
    Ok(Json(set_paused(&state, &ctx, &info, &rule_id, false).await?))
}
