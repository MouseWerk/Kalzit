//! Instances of a rule and their transitions in the database (`alert_instances`,
//! `alert_history`): what `alerting::eval::step` reads before an evaluation and returns after it.
//! The scheduler calls [`save`] in the same transaction as it records the deliveries (see the
//! contract in `alerting::eval`).

use sqlx::AnyConnection;

use super::eval::{EvalError, InstanceState, Labels, LastNotification, PendingTarget, ResolveReason, State, Step};
use crate::error::{ApiError, ApiResult};

type Row = (
    String,
    String,
    String,
    i64,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<f64>,
    Option<String>,
    i64,
    Option<i64>,
    Option<String>,
    Option<i64>,
    i64,
);

fn broken(what: &str, cause: impl std::fmt::Display) -> ApiError {
    ApiError::internal(&format!("stored alert instance: {what}"), cause)
}

fn state(text: &str) -> ApiResult<State> {
    State::parse(text).ok_or_else(|| broken("state", text))
}

/// The organization of the rule: `not_found` when there is no such rule, or when `org_id` is given
/// and the rule belongs to another organization.
async fn rule_org(conn: &mut AnyConnection, org_id: Option<&str>, rule_id: &str) -> ApiResult<String> {
    let org: Option<String> = sqlx::query_scalar("SELECT org_id FROM alert_rules WHERE id = $1")
        .bind(rule_id)
        .fetch_optional(&mut *conn)
        .await?;
    match org {
        Some(org) if org_id.is_none_or(|wanted| wanted == org) => Ok(org),
        _ => Err(ApiError::not_found()),
    }
}

/// The stored instances of a rule, by fingerprint; with `org_id`, only of a rule of that
/// organization.
pub async fn load(conn: &mut AnyConnection, org_id: Option<&str>, rule_id: &str) -> ApiResult<Vec<InstanceState>> {
    rule_org(conn, org_id, rule_id).await?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT fingerprint, labels, state, state_since, pending_since, pending_target, last_evaluated_at, \
         last_value, last_error, missing_count, last_notified_at, last_notified_state, last_notified_state_since, \
         last_notified_reminders FROM alert_instances WHERE rule_id = $1 ORDER BY fingerprint",
    )
    .bind(rule_id)
    .fetch_all(&mut *conn)
    .await?;
    rows.into_iter()
        .map(
            |(
                fingerprint,
                labels,
                current,
                since,
                pending_since,
                pending_target,
                last_evaluated_at,
                last_value,
                last_error,
                missing,
                notified_at,
                notified_state,
                notified_since,
                reminders,
            )| {
                let labels: Labels = serde_json::from_str(&labels).map_err(|e| broken("labels", e))?;
                let pending = match (pending_target, pending_since) {
                    (Some(target), Some(since)) => Some(PendingTarget { target: state(&target)?, since }),
                    _ => None,
                };
                // A damaged error is logged and dropped; it must not stop the evaluation.
                let last_error = last_error.and_then(|text| match serde_json::from_str::<EvalError>(&text) {
                    Ok(error) => Some(error),
                    Err(e) => {
                        tracing::warn!(rule_id, "stored alert instance error is not an error code ({e}); dropped");
                        None
                    }
                });
                let last_notification = match (notified_state, notified_since, notified_at) {
                    (Some(s), Some(state_since), Some(at)) => Some(LastNotification {
                        state: state(&s)?,
                        state_since,
                        at,
                        reminders: u32::try_from(reminders).unwrap_or(u32::MAX),
                    }),
                    _ => None,
                };
                Ok(InstanceState {
                    fingerprint,
                    labels,
                    state: state(&current)?,
                    since,
                    pending,
                    last_evaluated_at,
                    last_value,
                    last_error,
                    missing: u32::try_from(missing).unwrap_or(u32::MAX),
                    last_notification,
                })
            },
        )
        .collect()
}

fn json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).expect("labels and errors always serialize")
}

/// Transitions of one instance recorded in the history one by one per rolling hour. Further
/// transitions in that hour (a flapping series) are collapsed into one entry per instance with
/// the reason `flapping` and their number in `attempt`, so the history of a rule grows by at most
/// `(MAX_TRANSITIONS_PER_INSTANCE_HOUR + 1) × instances` transition entries an hour.
pub const MAX_TRANSITIONS_PER_INSTANCE_HOUR: i64 = 20;
const HOUR_MS: i64 = 3_600_000;
/// The reason of a collapsed history entry.
pub const FLAPPING: &str = "flapping";

/// Replaces the stored instances of the rule with `step.instances` (in place: instances that
/// stay are updated, gone ones deleted) and adds its transitions to the history, under the rule's
/// own organization (with `org_id`, only a rule of that organization). Runs inside the caller's
/// transaction.
pub async fn save(
    conn: &mut AnyConnection,
    org_id: Option<&str>,
    rule_id: &str,
    rule_name: &str,
    step: &Step,
) -> ApiResult<()> {
    let org_id = rule_org(conn, org_id, rule_id).await?;
    let stored: Vec<(String,)> = sqlx::query_as("SELECT fingerprint FROM alert_instances WHERE rule_id = $1")
        .bind(rule_id)
        .fetch_all(&mut *conn)
        .await?;
    for (fingerprint,) in stored {
        if !step.instances.iter().any(|i| i.fingerprint == fingerprint) {
            sqlx::query("DELETE FROM alert_instances WHERE rule_id = $1 AND fingerprint = $2")
                .bind(rule_id)
                .bind(&fingerprint)
                .execute(&mut *conn)
                .await?;
        }
    }
    for i in &step.instances {
        sqlx::query(
            "INSERT INTO alert_instances (rule_id, fingerprint, org_id, labels, state, state_since, pending_since, \
             pending_target, last_evaluated_at, last_value, last_error, missing_count, last_notified_at, \
             last_notified_state, last_notified_state_since, last_notified_reminders) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) \
             ON CONFLICT (rule_id, fingerprint) DO UPDATE SET org_id = excluded.org_id, labels = excluded.labels, \
             state = excluded.state, state_since = excluded.state_since, pending_since = excluded.pending_since, \
             pending_target = excluded.pending_target, last_evaluated_at = excluded.last_evaluated_at, \
             last_value = excluded.last_value, last_error = excluded.last_error, \
             missing_count = excluded.missing_count, last_notified_at = excluded.last_notified_at, \
             last_notified_state = excluded.last_notified_state, \
             last_notified_state_since = excluded.last_notified_state_since, \
             last_notified_reminders = excluded.last_notified_reminders",
        )
        .bind(rule_id)
        .bind(&i.fingerprint)
        .bind(&org_id)
        .bind(json(&i.labels))
        .bind(i.state.as_str())
        .bind(i.since)
        .bind(i.pending.map(|p| p.since))
        .bind(i.pending.map(|p| p.target.as_str()))
        .bind(i.last_evaluated_at)
        .bind(i.last_value)
        .bind(i.last_error.as_ref().map(json))
        .bind(i64::from(i.missing))
        .bind(i.last_notification.map(|n| n.at))
        .bind(i.last_notification.map(|n| n.state.as_str()))
        .bind(i.last_notification.map(|n| n.state_since))
        .bind(i64::from(i.last_notification.map_or(0, |n| n.reminders)))
        .execute(&mut *conn)
        .await?;
    }
    // Changes per instance in the hour before this evaluation, collapsed entries not counted.
    let mut recorded: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    if let Some(first) = step.transitions.iter().map(|t| t.at).min() {
        let counts: Vec<(String, i64)> = sqlx::query_as(
            "SELECT fingerprint, COUNT(*) FROM alert_history WHERE rule_id = $1 AND kind = 'transition' \
             AND at > $2 AND (reason IS NULL OR reason <> $3) GROUP BY fingerprint",
        )
        .bind(rule_id)
        .bind(first - HOUR_MS)
        .bind(FLAPPING)
        .fetch_all(&mut *conn)
        .await?;
        recorded.extend(counts);
    }
    for t in &step.transitions {
        let count = recorded.entry(t.fingerprint.clone()).or_default();
        if *count >= MAX_TRANSITIONS_PER_INSTANCE_HOUR {
            collapse(conn, &org_id, rule_id, rule_name, t).await?;
            continue;
        }
        *count += 1;
        sqlx::query(
            "INSERT INTO alert_history (id, org_id, rule_id, rule_name, fingerprint, labels, kind, from_state, \
             to_state, pending_target, value, error, silence_id, reason, at) \
             VALUES ($1, $2, $3, $4, $5, $6, 'transition', $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(&org_id)
        .bind(rule_id)
        .bind(rule_name)
        .bind(&t.fingerprint)
        .bind(json(&t.labels))
        .bind(t.from.as_str())
        .bind(t.to.as_str())
        .bind(t.pending_target.map(State::as_str))
        .bind(t.value)
        .bind(t.error.as_ref().map(json))
        .bind(t.silence_id.as_deref())
        .bind(t.reason.map(ResolveReason::as_str))
        .bind(t.at)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Counts a transition past [`MAX_TRANSITIONS_PER_INSTANCE_HOUR`] in the instance's collapsed
/// entry that started within the last hour (`attempt` holds the number, `at` the first collapsed
/// transition, `from_state` the state it left, `to_state` the latest), or starts one.
async fn collapse(
    conn: &mut AnyConnection,
    org_id: &str,
    rule_id: &str,
    rule_name: &str,
    t: &super::eval::Transition,
) -> ApiResult<()> {
    let open: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM alert_history WHERE rule_id = $1 AND fingerprint = $2 AND kind = 'transition' \
         AND reason = $3 AND at > $4 ORDER BY at DESC LIMIT 1",
    )
    .bind(rule_id)
    .bind(&t.fingerprint)
    .bind(FLAPPING)
    .bind(t.at - HOUR_MS)
    .fetch_optional(&mut *conn)
    .await?;
    match open {
        // The entry keeps its start (`at`, the window it counts in) and the state the first
        // collapsed transition left; `to_state` follows the latest.
        Some((id,)) => {
            sqlx::query("UPDATE alert_history SET attempt = attempt + 1, to_state = $1 WHERE id = $2")
                .bind(t.to.as_str())
                .bind(&id)
                .execute(&mut *conn)
                .await?;
        }
        None => {
            sqlx::query(
                "INSERT INTO alert_history (id, org_id, rule_id, rule_name, fingerprint, labels, kind, from_state, \
                 to_state, reason, attempt, at) VALUES ($1, $2, $3, $4, $5, $6, 'transition', $7, $8, $9, 1, $10)",
            )
            .bind(uuid::Uuid::now_v7().to_string())
            .bind(org_id)
            .bind(rule_id)
            .bind(rule_name)
            .bind(&t.fingerprint)
            .bind(json(&t.labels))
            .bind(t.from.as_str())
            .bind(t.to.as_str())
            .bind(FLAPPING)
            .bind(t.at)
            .execute(&mut *conn)
            .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::alerting::eval::{
        ErrorBehavior, Event, NoDataBehavior, Outcome, RuleTiming, SeriesOutcome, fingerprint, step,
    };

    const MINUTE: i64 = 60_000;

    async fn database() -> sqlx::AnyPool {
        // One connection, so every query sees the same in-memory database with the migrations.
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)").execute(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at) \
             VALUES ('ds', 'o', 'D', 'prometheus', '{}', 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO alert_rules (id, org_id, name, description, datasource_id, query, range_secs, reduce, \
             condition, interval_secs, for_secs, no_data_state, error_state, labels, reminder_secs, version, \
             created_at, updated_at) \
             VALUES ('r', 'o', 'R', '', 'ds', '{}', 600, '{}', '{}', 60, 0, 'no_data', 'error', '{}', 240, 1, 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        db
    }

    fn rule() -> RuleTiming {
        RuleTiming {
            rule_id: "r".into(),
            interval: Duration::from_secs(60),
            for_duration: Duration::from_secs(120),
            no_data: NoDataBehavior::NoData,
            error: ErrorBehavior::Error,
            reminder: Some(Duration::from_secs(4 * 60)),
        }
    }

    /// Loads, steps and saves in one transaction, as the scheduler does.
    async fn evaluate(db: &sqlx::AnyPool, outcome: &Outcome, tick: i64) -> Step {
        let mut tx = crate::db::begin(db).await.unwrap();
        let previous = load(&mut tx, Some("o"), "r").await.unwrap();
        let step = step(&rule(), &previous, outcome, tick, &|_| None);
        save(&mut tx, Some("o"), "r", "R", &step).await.unwrap();
        crate::db::commit(tx).await.unwrap();
        // What was stored reads back as the step returned it (as a set: the order is the
        // database's).
        let mut conn = db.acquire().await.unwrap();
        assert_eq!(by_fingerprint(load(&mut conn, None, "r").await.unwrap()), by_fingerprint(step.instances.clone()));
        step
    }

    fn by_fingerprint(mut instances: Vec<InstanceState>) -> Vec<InstanceState> {
        instances.sort_by(|a, b| a.fingerprint.cmp(&b.fingerprint));
        instances
    }

    fn series(host: &str, outcome: SeriesOutcome) -> (Labels, SeriesOutcome) {
        ([("host".to_string(), host.to_string())].into(), outcome)
    }

    #[tokio::test]
    async fn instances_survive_the_database_with_reminders_counting_on() {
        let db = database().await;
        let firing = Outcome::Series { series: vec![series("a", SeriesOutcome::Met(5.0))], complete: true };
        let mut sent = Vec::new();
        for minute in 0..12 {
            let step = evaluate(&db, &firing, minute * MINUTE).await;
            sent.extend(step.notifications.iter().map(|n| (minute, n.event, n.reminder)));
        }
        // Pending for 2 minutes, firing at 2, reminders every 4 minutes after that, numbered on
        // across every reload.
        assert_eq!(sent, vec![(2, Event::Firing, 0), (6, Event::Reminder, 1), (10, Event::Reminder, 2)]);

        // An error with its parameters, a pending change towards it, a missing series.
        let error = Outcome::Error(EvalError::Truncated { limit: Some(10), reason: Some("graph.node_limit".into()) });
        let step = evaluate(&db, &error, 12 * MINUTE).await;
        let instance = &step.instances[0];
        assert_eq!(instance.pending, Some(PendingTarget { target: State::Error, since: 12 * MINUTE }));
        assert!(instance.last_error.is_some());
        let other = Outcome::Series { series: vec![series("b", SeriesOutcome::NotMet(1.0))], complete: true };
        let step = evaluate(&db, &other, 13 * MINUTE).await;
        let gone = step.instances.iter().find(|i| i.labels["host"] == "a").unwrap();
        assert_eq!(gone.missing, 1);
        evaluate(&db, &other, 14 * MINUTE).await;
        let step = evaluate(&db, &other, 15 * MINUTE).await;
        assert_eq!(step.notifications.len(), 1);
        assert_eq!(step.notifications[0].reason, Some(ResolveReason::SeriesGone));

        type Entry = (String, String, Option<String>, Option<String>, Option<String>);
        let history: Vec<Entry> = sqlx::query_as(
            "SELECT from_state, to_state, pending_target, reason, error FROM alert_history \
             WHERE fingerprint = $1 AND kind = 'transition' ORDER BY at",
        )
        .bind(fingerprint("r", &[("host".to_string(), "a".to_string())].into()))
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(history[0], ("ok".into(), "pending".into(), Some("firing".into()), None, None));
        assert_eq!(history[1], ("pending".into(), "firing".into(), None, None, None));
        let last = history.last().unwrap();
        assert_eq!((last.0.as_str(), last.1.as_str(), last.3.as_deref()), ("firing", "ok", Some("series_gone")));
        // Errors are stored as code and parameters, never as text.
        let stored: Option<String> = sqlx::query_scalar("SELECT error FROM alert_history WHERE error IS NOT NULL")
            .fetch_optional(&db)
            .await
            .unwrap();
        assert!(stored.is_none(), "no transition carried an error here");
    }

    /// A series that flips every minute: 20 changes an hour are recorded one by one, the rest
    /// counted in one collapsed entry; instances are updated in place.
    #[tokio::test]
    async fn flapping_is_collapsed_in_the_history() {
        let db = database().await;
        let rule = RuleTiming { for_duration: Duration::ZERO, reminder: None, ..rule() };
        for minute in 0..60 {
            let value = if minute % 2 == 0 { SeriesOutcome::Met(5.0) } else { SeriesOutcome::NotMet(1.0) };
            let outcome = Outcome::Series { series: vec![series("a", value)], complete: true };
            let mut tx = crate::db::begin(&db).await.unwrap();
            let previous = load(&mut tx, Some("o"), "r").await.unwrap();
            let step = step(&rule, &previous, &outcome, minute * MINUTE, &|_| None);
            assert_eq!(step.transitions.len(), 1, "minute {minute}");
            save(&mut tx, Some("o"), "r", "R", &step).await.unwrap();
            crate::db::commit(tx).await.unwrap();
        }
        let (single,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM alert_history WHERE kind = 'transition' AND (reason IS NULL OR reason <> 'flapping')",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(single, MAX_TRANSITIONS_PER_INSTANCE_HOUR);
        // It starts at the first collapsed transition (minute 20, ok to firing) and follows the
        // latest state (minute 59, back to ok).
        type Collapsed = (Option<i64>, i64, Option<String>, Option<String>);
        let collapsed: Vec<Collapsed> =
            sqlx::query_as("SELECT attempt, at, from_state, to_state FROM alert_history WHERE reason = 'flapping'")
                .fetch_all(&db)
                .await
                .unwrap();
        let start = MAX_TRANSITIONS_PER_INSTANCE_HOUR * MINUTE;
        assert_eq!(
            collapsed,
            vec![(Some(60 - MAX_TRANSITIONS_PER_INSTANCE_HOUR), start, Some("ok".into()), Some("ok".into()))]
        );
        let (instances,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_instances").fetch_one(&db).await.unwrap();
        assert_eq!(instances, 1);
    }

    #[tokio::test]
    async fn stored_errors_are_codes() {
        let db = database().await;
        let rule = RuleTiming { for_duration: Duration::ZERO, ..rule() };
        let mut tx = crate::db::begin(&db).await.unwrap();
        let step = step(&rule, &[], &Outcome::Error(EvalError::QueryFailed), 0, &|_| None);
        save(&mut tx, None, "r", "R", &step).await.unwrap();
        crate::db::commit(tx).await.unwrap();
        let (instance, history): (String, String) = sqlx::query_as(
            "SELECT i.last_error, h.error FROM alert_instances i JOIN alert_history h ON h.fingerprint = i.fingerprint",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(instance, r#"{"code":"alerting.query_failed"}"#);
        assert_eq!(history, instance);
    }

    #[tokio::test]
    async fn a_rule_of_another_organization_is_refused() {
        let db = database().await;
        let mut conn = db.acquire().await.unwrap();
        let step = step(&rule(), &[], &Outcome::NoData, 0, &|_| None);
        for org in [Some("other"), None] {
            let rule_id = if org.is_some() { "r" } else { "no-such-rule" };
            assert_eq!(load(&mut conn, org, rule_id).await.unwrap_err().code, "not_found");
            assert_eq!(save(&mut conn, org, rule_id, "R", &step).await.unwrap_err().code, "not_found");
        }
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM alert_instances").fetch_one(&mut *conn).await.unwrap();
        assert_eq!(count, 0);
        // The rule's own organization is used, whatever the caller's.
        save(&mut conn, None, "r", "R", &step).await.unwrap();
        let org: String = sqlx::query_scalar("SELECT org_id FROM alert_instances").fetch_one(&mut *conn).await.unwrap();
        assert_eq!(org, "o");
    }

    #[tokio::test]
    async fn a_damaged_stored_error_is_dropped_not_fatal() {
        let db = database().await;
        let mut conn = db.acquire().await.unwrap();
        let step = step(&rule(), &[], &Outcome::Error(EvalError::Timeout), 0, &|_| None);
        save(&mut conn, None, "r", "R", &step).await.unwrap();
        sqlx::query("UPDATE alert_instances SET last_error = 'Connection refused by 10.0.0.5'")
            .execute(&mut *conn)
            .await
            .unwrap();
        let loaded = load(&mut conn, Some("o"), "r").await.unwrap();
        assert_eq!(loaded[0].last_error, None);
        assert_eq!(crate::alerting::eval::stored_error(Some("Connection refused by 10.0.0.5")), None);
        assert_eq!(
            crate::alerting::eval::stored_error(Some(r#"{"code":"alerting.timeout"}"#)),
            Some(serde_json::json!({ "code": "alerting.timeout" }))
        );
    }
}
