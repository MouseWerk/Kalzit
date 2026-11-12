//! One scheduled evaluation of a rule: its query runs as the organization's alerting identity
//! (`service_account::context_for_source`, which checks the opt-in every time), never from the
//! query cache, within the evaluation's time limit; the result goes through the rule's reduce
//! step and condition (`eval::outcome`) and the state machine (`eval::step`). Then, in **one
//! transaction**, the instances, their transitions and the messages to send are stored
//! (`instances::save`, `outbox::record`), and only after the commit does the delivery worker send
//! them. A query's own error goes to the server log only; what is stored is the error's code.

use std::time::{Duration, Instant};

use sqlx::AnyConnection;

use super::eval::{
    self, ErrorBehavior, EvalError, Event, InstanceState, Labels, NoDataBehavior, Notification, Outcome, ResolveReason,
    RuleTiming, State, Step,
};
use super::message::{Links, Message, Organization, RuleInfo};
use super::rule::{Condition, RULE_NAME_LABEL, Reduce, RuleQuery};
use super::{instances, outbox, service_account, silences};
use crate::app::AppState;
use crate::authz::OrgCtx;
use crate::error::{ApiError, ApiResult};
use crate::shapes::{QueryItem, QueryOutcome, QueryResult, TimeRange};

/// A stored rule as the evaluation reads it.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct StoredRule {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub description: String,
    pub runbook_url: Option<String>,
    pub datasource_id: String,
    pub query: String,
    pub range_secs: i64,
    pub reduce: String,
    pub condition: String,
    pub interval_secs: i64,
    pub for_secs: i64,
    pub no_data_state: String,
    pub error_state: String,
    pub labels: String,
    pub reminder_secs: i64,
    pub paused: i64,
    pub dashboard_id: Option<String>,
    pub panel_id: Option<String>,
}

const RULE_COLUMNS: &str = "SELECT id, org_id, name, description, runbook_url, datasource_id, query, range_secs, \
     reduce, condition, interval_secs, for_secs, no_data_state, error_state, labels, reminder_secs, paused, \
     dashboard_id, panel_id FROM alert_rules WHERE id = $1";

/// A rule's labels with its name under `alertname`, as silences match them.
pub fn with_rule_name(labels: &Labels, rule_name: &str) -> Labels {
    let mut all = labels.clone();
    all.insert(RULE_NAME_LABEL.to_string(), rule_name.to_string());
    all
}

/// The timing of the state machine from the stored rule.
pub fn timing(
    rule_id: &str,
    interval_secs: i64,
    for_secs: i64,
    no_data: &str,
    error: &str,
    reminder_secs: i64,
) -> RuleTiming {
    let secs = |s: i64| Duration::from_secs(u64::try_from(s).unwrap_or(0));
    RuleTiming {
        rule_id: rule_id.to_string(),
        interval: secs(interval_secs),
        for_duration: secs(for_secs),
        no_data: NoDataBehavior::parse(no_data).unwrap_or(NoDataBehavior::NoData),
        error: ErrorBehavior::parse(error).unwrap_or(ErrorBehavior::Error),
        reminder: (reminder_secs > 0).then(|| secs(reminder_secs)),
    }
}

/// The time an evaluation may take: the lower of the interval and `alerting.evaluation_timeout`
/// (the source's own query timeout applies inside it as always).
pub fn time_limit(interval_secs: i64, evaluation_timeout_secs: u64) -> Duration {
    let interval = u64::try_from(interval_secs).unwrap_or(1).max(1);
    Duration::from_secs(interval.min(evaluation_timeout_secs.max(1)))
}

/// Runs a rule's query once as `ctx` within `limit`: the result, or why there is none. `Err`
/// carries the source's error for whoever may see it (the preview); the evaluation logs it.
pub async fn run_query(
    state: &AppState,
    ctx: &OrgCtx,
    datasource_id: &str,
    query: &RuleQuery,
    range: TimeRange,
    limit: Duration,
) -> Result<QueryResult, (EvalError, Option<Box<crate::shapes::ErrorBody>>)> {
    let item = QueryItem {
        ref_id: "A".into(),
        datasource_id: datasource_id.to_string(),
        query: query.query.clone(),
        cursor: None,
        limit: None,
        steps: query.steps.clone(),
    };
    // `run_queries` never reads or fills the query cache.
    let run = crate::datasources::run_queries(state, ctx, vec![item], range, None, None, &query.variables);
    let Ok(mut response) = tokio::time::timeout(limit, run).await else {
        return Err((EvalError::Timeout, None));
    };
    match response.results.remove("A") {
        Some(QueryOutcome::Ok { result, steps, .. }) => {
            if let Some(failed) = steps.iter().flatten().find_map(|s| s.error.clone()) {
                return Err((EvalError::QueryFailed, Some(Box::new(failed))));
            }
            Ok(result)
        }
        Some(QueryOutcome::Err { error }) => Err((EvalError::QueryFailed, Some(Box::new(error)))),
        None => Err((EvalError::QueryFailed, None)),
    }
}

/// The outcome of the stored rule's query, run as the alerting identity at `tick`.
async fn outcome(state: &AppState, rule: &StoredRule, tick: i64) -> ApiResult<Outcome> {
    let (Ok(reduce), Ok(condition), Ok(query)) = (
        serde_json::from_str::<Reduce>(&rule.reduce),
        serde_json::from_str::<Condition>(&rule.condition),
        serde_json::from_str::<RuleQuery>(&rule.query),
    ) else {
        return Ok(Outcome::Error(EvalError::InvalidRule));
    };
    let limits = super::limits::for_org(state, &rule.org_id).await?;
    let identity = match service_account::existing(&state.db, &rule.org_id).await? {
        Some(identity) => identity,
        None => {
            let mut tx = crate::db::begin(&state.db).await?;
            crate::authz::lock_org(&mut tx, &rule.org_id).await?;
            let identity = service_account::ensure(&mut tx, &rule.org_id, state.clock.now_ms()).await?;
            crate::db::commit(tx).await?;
            identity
        }
    };
    let ctx = match service_account::context_for_source(
        &state.db,
        &identity,
        &rule.org_id,
        &rule.datasource_id,
        state.clock.now_ms(),
    )
    .await
    {
        Ok(ctx) => ctx,
        Err(e) if e.reason.as_ref().is_some_and(|r| r.code == "alerts.datasource_not_opted_in") => {
            return Ok(Outcome::Error(EvalError::SourceNotEnabled));
        }
        Err(e) => return Err(e),
    };
    let range = TimeRange { from: tick.saturating_sub(rule.range_secs.saturating_mul(1000)), to: tick };
    let limit = time_limit(rule.interval_secs, limits.evaluation_timeout_secs);
    let max_instances = usize::try_from(limits.max_instances_per_rule).unwrap_or(usize::MAX);
    Ok(match run_query(state, &ctx, &rule.datasource_id, &query, range, limit).await {
        Ok(result) => eval::outcome(&reduce, &condition, Ok(&result), max_instances),
        Err((error, cause)) => {
            // The source's own text stays on the server; the rule shows the code.
            match cause {
                Some(cause) => tracing::warn!(
                    rule_id = %rule.id,
                    code = %cause.code,
                    reason = cause.reason.as_deref().unwrap_or(""),
                    "alert rule query failed: {}",
                    cause.message
                ),
                None => tracing::warn!(rule_id = %rule.id, "alert rule evaluation: {error}"),
            }
            Outcome::Error(error)
        }
    })
}

/// Evaluates the rule for its scheduled time `tick` and stores everything in one transaction.
/// A rule that is gone, paused, or already evaluated for `tick` is left alone.
pub async fn evaluate(state: &AppState, rule_id: &str, tick: i64) -> ApiResult<()> {
    let started = Instant::now();
    let rule: Option<StoredRule> =
        sqlx::query_as(sqlx::AssertSqlSafe(RULE_COLUMNS)).bind(rule_id).fetch_optional(&state.db).await?;
    let Some(rule) = rule.filter(|r| r.paused == 0) else { return Ok(()) };
    let outcome = outcome(state, &rule, tick).await?;
    let took = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let recorded = store(state, &rule, tick, &outcome, took).await?;
    state.metrics.alert_evaluation(matches!(outcome, Outcome::Error(_)));
    if recorded > 0 {
        state.alerting.outbox.notify_one();
    }
    Ok(())
}

/// An evaluation that could not be stored (the database failed it) still shows on the rule: its
/// slot as `lastEvaluatedAt` and `alerting.query_failed` as `lastError`; the cause is in the
/// server log. A slot stored in the meantime is left as it is.
pub async fn record_failure(state: &AppState, rule_id: &str, tick: i64) -> ApiResult<()> {
    let code = serde_json::to_string(&EvalError::QueryFailed).expect("errors always serialize");
    sqlx::query(
        "UPDATE alert_rules SET last_evaluated_at = $1, last_error = $2 \
         WHERE id = $3 AND (last_evaluated_at IS NULL OR last_evaluated_at < $1)",
    )
    .bind(tick)
    .bind(code)
    .bind(rule_id)
    .execute(&state.db)
    .await?;
    state.metrics.alert_evaluation(true);
    Ok(())
}

/// The active silences of the organization at `at`, compiled.
pub async fn active_silences(
    conn: &mut AnyConnection,
    org_id: &str,
    at: i64,
) -> ApiResult<Vec<(String, silences::Compiled)>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, matchers FROM alert_silences WHERE org_id = $1 AND starts_at <= $2 AND ends_at > $2 \
         AND ended_at IS NULL ORDER BY id",
    )
    .bind(org_id)
    .bind(at)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, m)| {
            let matchers: Vec<silences::Matcher> = serde_json::from_str(&m).unwrap_or_default();
            (id, silences::Compiled::new(&matchers))
        })
        .collect())
}

/// The message the rule's evaluations send, without instances.
async fn template(state: &AppState, conn: &mut AnyConnection, rule: &StoredRule, tick: i64) -> ApiResult<Message> {
    let (org_name,): (String,) =
        sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&rule.org_id).fetch_one(&mut *conn).await?;
    let broken = |what: &str| ApiError::internal("alert rule", format!("stored {what} of {} does not parse", rule.id));
    let public = crate::mail::public_url(state);
    let dashboard = rule.dashboard_id.as_deref().map(|d| (d, rule.panel_id.as_deref()));
    Ok(Message {
        version: super::message::VERSION,
        event: String::new(),
        delivery_id: String::new(),
        organization: Organization { id: rule.org_id.clone(), name: org_name },
        rule: RuleInfo {
            id: rule.id.clone(),
            name: rule.name.clone(),
            description: rule.description.clone(),
            runbook_url: rule.runbook_url.clone(),
            labels: serde_json::from_str(&rule.labels).map_err(|_| broken("labels"))?,
            reduce: serde_json::from_str(&rule.reduce).map_err(|_| broken("reduce"))?,
            condition: serde_json::from_str(&rule.condition).map_err(|_| broken("condition"))?,
        },
        instances: Vec::new(),
        omitted_instances: 0,
        truncated: false,
        links: Links::new(public.as_deref(), &rule.id, dashboard),
        evaluated_at: tick,
    })
}

/// Resolves still owed for instances that ended while silenced: stored now for the instances
/// that ended silenced in `step`, and returned as notifications for those no silence holds back
/// any more.
async fn owed_resolves(
    conn: &mut AnyConnection,
    rule: &StoredRule,
    previous: &[InstanceState],
    step: &Step,
    silenced: &(dyn Fn(&Labels) -> Option<String> + Sync),
    now: i64,
) -> ApiResult<Vec<Notification>> {
    for p in previous {
        let sent_active = p.last_notification.is_some_and(|n| n.state.is_active());
        let ended = !step.instances.iter().any(|i| i.fingerprint == p.fingerprint);
        let resolved_now = step.notifications.iter().any(|n| n.fingerprint == p.fingerprint);
        if !(sent_active && ended && !resolved_now && silenced(&p.labels).is_some()) {
            continue;
        }
        let last = p.last_notification.expect("checked above");
        let reason = if p.labels.is_empty() { ResolveReason::Replaced } else { ResolveReason::SeriesGone };
        sqlx::query("DELETE FROM alert_owed_resolves WHERE rule_id = $1 AND fingerprint = $2")
            .bind(&rule.id)
            .bind(&p.fingerprint)
            .execute(&mut *conn)
            .await?;
        sqlx::query(
            "INSERT INTO alert_owed_resolves (rule_id, fingerprint, org_id, labels, state_since, reason, created_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&rule.id)
        .bind(&p.fingerprint)
        .bind(&rule.org_id)
        .bind(serde_json::to_string(&p.labels).expect("labels always serialize"))
        .bind(last.state_since)
        .bind(reason.as_str())
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    let owed: Vec<(String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT fingerprint, labels, state_since, reason FROM alert_owed_resolves WHERE rule_id = $1 ORDER BY fingerprint",
    )
    .bind(&rule.id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out = Vec::new();
    for (fingerprint, labels, state_since, reason) in owed {
        let labels: Labels = serde_json::from_str(&labels).unwrap_or_default();
        // The series came back and was reported again since: that episode has its own resolve.
        let reported_again = step
            .instances
            .iter()
            .any(|i| i.fingerprint == fingerprint && i.last_notification.is_some_and(|n| n.state_since > state_since));
        if silenced(&labels).is_some() && !reported_again {
            continue;
        }
        sqlx::query("DELETE FROM alert_owed_resolves WHERE rule_id = $1 AND fingerprint = $2")
            .bind(&rule.id)
            .bind(&fingerprint)
            .execute(&mut *conn)
            .await?;
        if reported_again {
            continue;
        }
        out.push(Notification {
            fingerprint,
            labels,
            event: Event::Resolved,
            state: State::Ok,
            state_since,
            value: None,
            error: None,
            reminder: 0,
            reason: reason.as_deref().and_then(ResolveReason::parse),
        });
    }
    Ok(out)
}

/// Stores the evaluation of `rule` at `tick` in one transaction: instances, transitions, owed
/// resolves, the messages to send and what the rule shows of its last evaluation. Answers the
/// number of messages recorded; nothing when the rule went, was paused, or `tick` was stored
/// already (another server, or an evaluation that ran twice).
pub async fn store(
    state: &AppState,
    rule: &StoredRule,
    tick: i64,
    outcome: &Outcome,
    took_ms: i64,
) -> ApiResult<usize> {
    let now = state.clock.now_ms();
    // A server that no longer leads stores nothing; the new leader evaluates the slot.
    if state.cluster.coordinated() && !state.cluster.is_leader() {
        return Ok(0);
    }
    let mut tx = crate::db::begin(&state.db).await?;
    // The rule's row is locked first (a no-op update: the row lock on PostgreSQL, the write lock
    // on SQLite), so two evaluations of the same slot, or one racing a change of the rule, are
    // stored one after the other and the second sees the first.
    sqlx::query("UPDATE alert_rules SET version = version WHERE id = $1").bind(&rule.id).execute(&mut *tx).await?;
    let current: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT paused, last_evaluated_at FROM alert_rules WHERE id = $1 AND org_id = $2")
            .bind(&rule.id)
            .bind(&rule.org_id)
            .fetch_optional(&mut *tx)
            .await?;
    // A stored tick beyond now and the next interval was written under a clock that went back
    // since; it does not hold the rule back.
    let from_the_future = |last: i64| last > now.saturating_add(rule.interval_secs.saturating_mul(1000));
    match current {
        Some((0, last)) if last.is_none_or(|l| l < tick || from_the_future(l)) => {}
        _ => return Ok(0),
    }
    let previous = instances::load(&mut tx, Some(&rule.org_id), &rule.id).await?;
    let active = active_silences(&mut tx, &rule.org_id, tick).await?;
    let silenced = |labels: &Labels| {
        let all = with_rule_name(labels, &rule.name);
        active.iter().find(|(_, m)| m.matches(&all)).map(|(id, _)| id.clone())
    };
    let timing =
        timing(&rule.id, rule.interval_secs, rule.for_secs, &rule.no_data_state, &rule.error_state, rule.reminder_secs);
    let step = eval::step(&timing, &previous, outcome, tick, &silenced);
    let released = owed_resolves(&mut tx, rule, &previous, &step, &silenced, now).await?;
    instances::save(&mut tx, Some(&rule.org_id), &rule.id, &rule.name, &step).await?;
    let mut notifications = step.notifications.clone();
    notifications.extend(released);
    let mut recorded = 0;
    if !notifications.is_empty() {
        let contact_points: Vec<(String,)> = sqlx::query_as(
            "SELECT contact_point_id FROM alert_rule_contact_points WHERE rule_id = $1 ORDER BY contact_point_id",
        )
        .bind(&rule.id)
        .fetch_all(&mut *tx)
        .await?;
        let ids: Vec<String> = contact_points.into_iter().map(|(id,)| id).collect();
        if !ids.is_empty() {
            let template = template(state, &mut tx, rule, tick).await?;
            recorded = outbox::record(&mut tx, &template, &ids, &notifications, now).await?;
        }
    }
    let last_error = match outcome {
        Outcome::Error(e) => Some(serde_json::to_string(e).expect("errors always serialize")),
        _ => None,
    };
    sqlx::query("UPDATE alert_rules SET last_evaluated_at = $1, last_duration_ms = $2, last_error = $3 WHERE id = $4")
        .bind(tick)
        .bind(took_ms)
        .bind(last_error)
        .bind(&rule.id)
        .execute(&mut *tx)
        .await?;
    crate::db::commit(tx).await?;
    Ok(recorded)
}
