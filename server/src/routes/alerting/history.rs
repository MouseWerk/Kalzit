//! The alerting history of an organization (docs/api/alerting.md, "History"): state changes and
//! deliveries, newest first, filterable by rule, state, label, kind and time, within the
//! retention.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};

use crate::alerting::rule::{STATES, invalid, is_label_name};
use crate::app::AppState;
use crate::authz::OrgCtx;
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    rule_id: String,
    rule_name: String,
    fingerprint: String,
    labels: BTreeMap<String, String>,
    /// `transition` or `delivery`.
    kind: String,
    from_state: Option<String>,
    to_state: Option<String>,
    /// For a change to `pending`: the state it waits for.
    pending_target: Option<String>,
    value: Option<f64>,
    /// Why the evaluation failed, as `{code, params}` for the catalogs (`alerting.*`).
    error: Option<serde_json::Value>,
    /// The silence that held a notification back.
    silence_id: Option<String>,
    /// Why an instance went back to `ok` on its own: `series_gone`.
    reason: Option<String>,
    contact_point_id: Option<String>,
    event: Option<String>,
    attempt: Option<i64>,
    result: Option<String>,
    /// A group's delivery: its policy, group and stage (`0`, the repetition, `e1` to `e3`).
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

/// `%"name":"value"%` for `LIKE`, with the JSON forms of both and `\` escaping `%`, `_` and `\`.
fn label_pattern(name: &str, value: &str) -> String {
    let pair = format!(
        "{}:{}",
        serde_json::to_string(name).unwrap_or_default(),
        serde_json::to_string(value).unwrap_or_default()
    );
    let escaped = pair.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    format!("%{escaped}%")
}

pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<ListQuery>,
) -> ApiResult<Json<Page<Entry>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let mut sql = String::from(
        "SELECT id, rule_id, rule_name, fingerprint, labels, kind, from_state, to_state, pending_target, value, error, \
         silence_id, reason, contact_point_id, event, attempt, result, at, group_id, policy_id, stage \
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
        add(&mut sql, " AND labels LIKE ? ESCAPE '\\'", label_pattern(name.trim(), value.trim()));
    }
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
    let items = page
        .items
        .into_iter()
        .map(|r| Entry {
            id: r.id,
            rule_id: r.rule_id,
            rule_name: r.rule_name,
            fingerprint: r.fingerprint,
            labels: serde_json::from_str(&r.labels).unwrap_or_default(),
            kind: r.kind,
            from_state: r.from_state,
            to_state: r.to_state,
            pending_target: r.pending_target,
            value: r.value,
            error: crate::alerting::eval::stored_error(r.error.as_deref()),
            silence_id: r.silence_id,
            reason: r.reason,
            contact_point_id: r.contact_point_id,
            event: r.event,
            attempt: r.attempt,
            result: r.result,
            policy_id: r.policy_id,
            group_id: r.group_id,
            stage: r.stage,
            at: r.at,
        })
        .collect();
    Ok(Json(Page { items, next_cursor: page.next_cursor }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_filters_escape_like_wildcards() {
        assert_eq!(label_pattern("team", "lager"), "%\"team\":\"lager\"%");
        assert_eq!(label_pattern("a_b", "50%"), "%\"a\\_b\":\"50\\%\"%");
    }
}
