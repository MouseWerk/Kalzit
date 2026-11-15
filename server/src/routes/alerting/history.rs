//! The alerting history of an organization (docs/api/alerting.md, "History"): state changes and
//! deliveries, newest first, filterable by rule, state, label, kind and time, within the
//! retention.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::alerting::rule::{STATES, invalid, is_label_name};
use crate::app::AppState;
use crate::authz::{DatasourceAccess, OrgCtx};
use crate::error::ApiResult;
use crate::routes::support::{Paging, QueryParams};
use crate::shapes::Page;

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    rule_id: String,
    rule_name: String,
    fingerprint: String,
    labels: String,
    kind: String,
    from_state: Option<String>,
    to_state: Option<String>,
    pending_target: Option<String>,
    value: Option<f64>,
    error: Option<String>,
    silence_id: Option<String>,
    reason: Option<String>,
    contact_point_id: Option<String>,
    event: Option<String>,
    attempt: Option<i64>,
    result: Option<String>,
    at: i64,
    group_id: Option<String>,
    policy_id: Option<String>,
    stage: Option<String>,
    datasource_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    rule_id: String,
    rule_name: String,
    fingerprint: String,
    labels: BTreeMap<String, String>,
    /// The caller may neither read nor query the data source the rule had when the entry was
    /// written: `labels` is empty, `value` is `null` and `error` has its code only.
    data_hidden: bool,
    /// `transition` or `delivery`. A transition with the reason `flapping` stands for
    /// `attempt` further changes of the instance in that hour, collapsed into one entry.
    kind: String,
    from_state: Option<String>,
    to_state: Option<String>,
    /// For a change to `pending`: the state it waits for.
    pending_target: Option<String>,
    value: Option<f64>,
    /// Why the evaluation failed, as `{code, params}` for the catalogs (`alerting.*`).
    error: Option<serde_json::Value>,
    /// The silence that held a notification back; `null` when `dataHidden`, since it matched the
    /// instance's labels.
    silence_id: Option<String>,
    /// Why an instance went back to `ok` on its own: `series_gone`.
    reason: Option<String>,
    contact_point_id: Option<String>,
    /// `firing`, `resolved`, `no_data`, `error`, `reminder`, `escalation` or `test`.
    event: Option<String>,
    attempt: Option<i64>,
    result: Option<String>,
    /// A group's delivery: its policy, group and stage (`0`, the repetition, `e1` to `e3`). A
    /// group's deliveries of data the caller may not see are not answered at all.
    policy_id: Option<String>,
    group_id: Option<String>,
    stage: Option<String>,
    at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListQuery {
    rule_id: Option<String>,
    /// The state changed to.
    state: Option<String>,
    /// `name=value`.
    label: Option<String>,
    kind: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// `"name":"value"`: the pair as the stored JSON of the labels writes it.
fn label_needle(name: &str, value: &str) -> String {
    format!("{}:{}", serde_json::to_string(name).unwrap_or_default(), serde_json::to_string(value).unwrap_or_default())
}

pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Entry>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    // What the data says is shown only to people who may read or query the data source the rule
    // had when the entry was written; for an entry without one (of a rule deleted before 0.7.3)
    // and a source no longer there the organization-wide rights decide.
    let access = DatasourceAccess::load(&state.db, &ctx).await?;
    let known: Vec<String> = sqlx::query_scalar("SELECT id FROM datasources WHERE org_id = $1")
        .bind(&ctx.org_id)
        .fetch_all(&state.db)
        .await?;
    let sees = Sees::new(&access, known);
    let mut sql = String::from(
        "SELECT id, rule_id, rule_name, fingerprint, labels, kind, from_state, to_state, pending_target, value, error, \
         silence_id, reason, contact_point_id, event, attempt, result, at, group_id, policy_id, stage, datasource_id \
         FROM alert_history WHERE org_id = $1 AND at >= $2 AND at <= $3 \
         AND (at < $4 OR (at = $4 AND id < $5))",
    );
    let mut binds: Vec<String> = Vec::new();
    let mut add = |sql: &mut String, clause: &str, value: String| {
        binds.push(value);
        sql.push_str(&clause.replace('?', &format!("${}", 5 + binds.len())));
    };
    if let Some(rule_id) = q.rule_id {
        add(&mut sql, " AND rule_id = ?", rule_id);
    }
    if let Some(s) = q.state {
        if !STATES.contains(&s.as_str()) {
            return Err(invalid(
                "state",
                "state is ok, pending, firing, no_data or error",
                "alerts.state_option_invalid",
            ));
        }
        add(&mut sql, " AND to_state = ?", s);
    }
    if let Some(kind) = q.kind {
        if !matches!(kind.as_str(), "transition" | "delivery") {
            return Err(invalid("kind", "kind is transition or delivery", "alerts.history_kind_invalid"));
        }
        add(&mut sql, " AND kind = ?", kind);
    }
    if let Some(label) = q.label {
        let Some((name, value)) = label.split_once('=').filter(|(n, _)| is_label_name(n.trim())) else {
            return Err(invalid("label", "label is name=value", "alerts.label_filter_invalid"));
        };
        // Case-sensitive on both databases (SQLite's LIKE is not).
        let postgres = crate::cluster::is_postgres(&state.config.database_url());
        let find = if postgres { " AND strpos(labels, ?) > 0" } else { " AND instr(labels, ?) > 0" };
        add(&mut sql, find, label_needle(name.trim(), value.trim()));
        // Only entries whose data the caller sees, in the query itself, so neither a page nor its
        // length tells which hidden labels exist.
        let shown = sees.condition(&mut add);
        sql.push_str(&format!(" AND {shown}"));
    }
    // A group's delivery of data the caller may not see is left out entirely, in the query
    // itself, so neither a page nor its length shows it: its time, attempt, group and stage would
    // tell which group (chosen by the hidden labels) the instance was in and what its policy did.
    let shown = sees.condition(&mut add);
    sql.push_str(&format!(" AND (group_id IS NULL OR {shown})"));
    let limit_at = 6 + binds.len();
    sql.push_str(&format!(" ORDER BY at DESC, id DESC LIMIT ${limit_at}"));
    let cutoff = crate::alerting::history::cutoff(&state, &ctx.org_id).await?;
    let from = q.from.unwrap_or(i64::MIN).max(cutoff);
    let to = q.to.unwrap_or(i64::MAX);
    let mut query = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(sql))
        .bind(&ctx.org_id)
        .bind(from)
        .bind(to)
        .bind(paging.before_time())
        .bind(paging.before_id().to_string());
    for b in binds {
        query = query.bind(b);
    }
    let rows = query.bind(paging.fetch_limit()).fetch_all(&state.db).await?;
    let page = paging.page(rows, |r| (r.at, r.id.as_str()));
    // Hidden fingerprints become ids of this answer: entries of one instance still go together.
    let mut hidden_ids: HashMap<String, String> = HashMap::new();
    let items = page
        .items
        .into_iter()
        .map(|r| {
            let visible = sees.row(r.datasource_id.as_deref());
            let error = crate::alerting::eval::stored_error(r.error.as_deref());
            let fingerprint = if visible {
                r.fingerprint
            } else {
                let next = super::hidden_fingerprint(hidden_ids.len());
                hidden_ids.entry(format!("{}:{}", r.rule_id, r.fingerprint)).or_insert(next).clone()
            };
            Entry {
                id: r.id,
                rule_id: r.rule_id,
                rule_name: r.rule_name,
                fingerprint,
                labels: if visible { serde_json::from_str(&r.labels).unwrap_or_default() } else { BTreeMap::new() },
                data_hidden: !visible,
                kind: r.kind,
                from_state: r.from_state,
                to_state: r.to_state,
                pending_target: r.pending_target,
                value: r.value.filter(|_| visible),
                error: if visible { error } else { super::error_code_only(error) },
                silence_id: r.silence_id.filter(|_| visible),
                reason: r.reason,
                // A hidden entry left here is a direct rule's delivery or a transition: its
                // contact point is the rule's own.
                contact_point_id: r.contact_point_id,
                event: r.event,
                attempt: r.attempt,
                result: r.result,
                policy_id: r.policy_id,
                group_id: r.group_id,
                stage: r.stage,
                at: r.at,
            }
        })
        .collect();
    Ok(Json(Page { items, next_cursor: page.next_cursor }))
}

/// Whose data the caller sees, by the data source an entry's rule had when it was written: their
/// rights on a source of the organization, or the organization-wide ones for an entry without a
/// source or with a source no longer there. The SQL condition and the check per row agree.
struct Sees {
    org: bool,
    /// The organization's sources the caller sees differently from `org`.
    exceptions: Vec<String>,
    known: HashSet<String>,
    visible: HashSet<String>,
}

impl Sees {
    fn new(access: &DatasourceAccess, known: Vec<String>) -> Self {
        let org = super::data_visible(access, "");
        let visible: HashSet<String> = known.iter().filter(|id| super::data_visible(access, id)).cloned().collect();
        let exceptions = known.iter().filter(|id| visible.contains(*id) != org).cloned().collect();
        Sees { org, exceptions, known: known.into_iter().collect(), visible }
    }

    fn row(&self, datasource_id: Option<&str>) -> bool {
        match datasource_id {
            Some(id) if self.known.contains(id) => self.visible.contains(id),
            _ => self.org,
        }
    }

    /// The same as an SQL condition on `alert_history`, its values bound through `add`.
    fn condition(&self, add: &mut impl FnMut(&mut String, &str, String)) -> String {
        if self.exceptions.is_empty() {
            return if self.org { "1 = 1" } else { "1 = 0" }.to_string();
        }
        let list = placeholders(add, &self.exceptions);
        if self.org {
            format!("(datasource_id IS NULL OR datasource_id NOT IN ({list}))")
        } else {
            format!("(datasource_id IS NOT NULL AND datasource_id IN ({list}))")
        }
    }
}

/// Binds every value through `add` and answers their placeholders, separated by commas.
fn placeholders(add: &mut impl FnMut(&mut String, &str, String), values: &[String]) -> String {
    let mut list = Vec::new();
    for value in values {
        let mut one = String::new();
        add(&mut one, "?", value.clone());
        list.push(one);
    }
    list.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_filters_look_for_the_stored_pair() {
        assert_eq!(label_needle("team", "lager"), "\"team\":\"lager\"");
        assert_eq!(label_needle("a_b", "50% \"x\""), "\"a_b\":\"50% \\\"x\\\"\"");
    }
}
