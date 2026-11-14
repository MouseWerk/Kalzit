//! The queue of report runs, worked on the leading server only (like alerting's scheduler).
//!
//! Every few seconds the worker looks at the reports whose next scheduled time has come: it moves
//! the report on to its following time and queues a run, both in one transaction that only one
//! server's look can win. A time that passed more than [`GRACE_MS`] ago (no server ran, or reports
//! were off) is not made up: it is recorded as `skipped`. Paused reports have no next time; when
//! they are resumed, they continue at the next time from then. Runs beyond
//! `reports.max_runs_per_org_hour` are recorded as `skipped` too.
//!
//! Queued runs ("send now" and the schedule's) are claimed with a lease, up to [`PARALLEL`] at once,
//! organizations taking turns and one run per organization at a time; a scheduled run still
//! queued [`GRACE_MS`] after its time is skipped; a run whose server stopped mid-run is found by its lease and counts as a failed attempt.
//! Once an hour, runs past `reports.history_retention_days` are deleted.

use std::time::Duration;

use super::model::RunStatus;
use super::run::{self, LEASE_MS, Mailer};
use crate::app::AppState;
use crate::error::ApiResult;

/// How often the worker looks.
const LOOK_EVERY: Duration = Duration::from_secs(5);
/// A scheduled time this late still runs.
pub const GRACE_MS: i64 = 15 * 60_000;
/// Runs made at once, each of another organization.
pub const PARALLEL: usize = 4;
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

/// Runs the organization started in the last hour.
pub async fn runs_last_hour<'e, E>(db: E, org_id: &str, now: i64) -> ApiResult<i64>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM report_runs WHERE org_id = $1 AND created_at > $2 AND status <> 'skipped' \
         AND status <> 'suspended'",
    )
    .bind(org_id)
    .bind(now - HOUR_MS)
    .fetch_one(db)
    .await?;
    Ok(n)
}

/// Records a run: `queued`, or `skipped` with its reason.
#[expect(clippy::too_many_arguments, reason = "the columns of a new run")]
pub async fn record_run(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    report_id: &str,
    trigger: &str,
    triggered_by: Option<&str>,
    scheduled_for: Option<i64>,
    status: RunStatus,
    error: Option<(&str, &str)>,
    now: i64,
) -> ApiResult<String> {
    let id = crate::routes::new_id();
    let finished = (status != RunStatus::Queued).then_some(now);
    sqlx::query(
        "INSERT INTO report_runs (id, org_id, report_id, trigger_kind, triggered_by, scheduled_for, status, attempt, \
         not_before, created_at, finished_at, error_code, error_message) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8, $9, $10, $11)",
    )
    .bind(&id)
    .bind(org_id)
    .bind(report_id)
    .bind(trigger)
    .bind(triggered_by)
    .bind(scheduled_for)
    .bind(status.as_str())
    .bind(now)
    .bind(finished)
    .bind(error.map(|e| e.0))
    .bind(error.map(|e| e.1))
    .execute(&mut *conn)
    .await?;
    Ok(id)
}

/// Moves due reports on to their next time and queues their runs. Answers how many were queued.
async fn enqueue_due(state: &AppState, now: i64) -> ApiResult<usize> {
    let due: Vec<(String, String, i64, String, String)> = sqlx::query_as(
        "SELECT id, org_id, next_run_at, schedule, time_zone FROM reports \
         WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at, id",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    if due.is_empty() {
        return Ok(0);
    }
    let server_on = super::enabled(state).await?;
    let mut org_on: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let max_runs = super::limits(state).await?.max_runs_per_org_hour;
    let mut queued = 0;
    for (id, org_id, at, schedule, zone) in due {
        let next = serde_json::from_str::<super::schedule::Schedule>(&schedule)
            .ok()
            .and_then(|s| s.compile().ok())
            .zip(zone.parse::<chrono_tz::Tz>().ok())
            .and_then(|(c, z)| c.next_after(now, z));
        let on = match org_on.get(&org_id) {
            Some(on) => *on,
            None => {
                let on = server_on && super::enabled_for(state, &org_id).await?;
                org_on.insert(org_id.clone(), on);
                on
            }
        };
        let mut tx = crate::db::begin(&state.db).await?;
        let won = sqlx::query("UPDATE reports SET next_run_at = $1 WHERE id = $2 AND next_run_at = $3")
            .bind(next)
            .bind(&id)
            .bind(at)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if won == 1 {
            if !on || now - at > GRACE_MS {
                // Off: the time passes quietly. Late: recorded, never made up.
                if on {
                    let reason = ("reports.missed", "the scheduled time passed while no server ran the report");
                    record_run(
                        &mut tx,
                        &org_id,
                        &id,
                        "schedule",
                        None,
                        Some(at),
                        RunStatus::Skipped,
                        Some(reason),
                        now,
                    )
                    .await?;
                }
            } else if u64::try_from(runs_last_hour(&mut *tx, &org_id, now).await?).unwrap_or(0) >= max_runs {
                let reason = ("reports.rate_limited", "the organization started its report runs for this hour");
                record_run(&mut tx, &org_id, &id, "schedule", None, Some(at), RunStatus::Skipped, Some(reason), now)
                    .await?;
            } else {
                record_run(&mut tx, &org_id, &id, "schedule", None, Some(at), RunStatus::Queued, None, now).await?;
                queued += 1;
            }
        }
        crate::db::commit(tx).await?;
    }
    Ok(queued)
}

/// Runs whose worker stopped mid-run: queued again for their retry, or failed.
async fn recover_stale(state: &AppState, now: i64) -> ApiResult<()> {
    let stale: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, attempt FROM report_runs WHERE status = 'running' AND lease_until < $1")
            .bind(now)
            .fetch_all(&state.db)
            .await?;
    for (id, attempt) in stale {
        let (status, finished) = if attempt < 2 { (RunStatus::Queued, None) } else { (RunStatus::Failed, Some(now)) };
        sqlx::query(
            "UPDATE report_runs SET status = $1, attempt = attempt + 1, not_before = $2, finished_at = $3, \
             lease_until = NULL, error_code = 'reports.interrupted', \
             error_message = 'the server stopped while the report was being made' WHERE id = $4 AND status = 'running'",
        )
        .bind(status.as_str())
        .bind(now + run::RETRY_AFTER_MS)
        .bind(finished)
        .bind(&id)
        .execute(&state.db)
        .await?;
    }
    Ok(())
}

/// Scheduled runs still waiting this long after their time are given up (`skipped`): a report
/// late by more is not sent.
async fn give_up_late(state: &AppState, now: i64) -> ApiResult<()> {
    sqlx::query(
        "UPDATE report_runs SET status = 'skipped', finished_at = $1, error_code = 'reports.queue_late', \
         error_message = 'the run waited too long for its turn' \
         WHERE status = 'queued' AND trigger_kind = 'schedule' AND attempt = 1 AND not_before < $2",
    )
    .bind(now)
    .bind(now - GRACE_MS)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Picks up to `limit` runs, organizations taking turns (one run of each in a round, starting with
/// a different one each time) and none of an organization with a run in progress.
pub fn pick(
    due: &[(String, String)],
    busy: &std::collections::HashSet<String>,
    turn: usize,
    limit: usize,
) -> Vec<String> {
    let mut orgs: Vec<&str> = Vec::new();
    for (_, org) in due {
        if !busy.contains(org) && !orgs.contains(&org.as_str()) {
            orgs.push(org);
        }
    }
    if orgs.is_empty() {
        return Vec::new();
    }
    let start = turn % orgs.len();
    orgs.rotate_left(start);
    orgs.into_iter()
        .take(limit)
        .filter_map(|org| due.iter().find(|(_, o)| o == org).map(|(id, _)| id.clone()))
        .collect()
}

/// Claims due runs fairly across organizations, each with a lease.
async fn claim(state: &AppState, now: i64) -> ApiResult<Vec<String>> {
    let due: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, org_id FROM report_runs WHERE status = 'queued' AND not_before <= $1 ORDER BY not_before, id LIMIT 500",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    let busy: Vec<(String,)> =
        sqlx::query_as("SELECT DISTINCT org_id FROM report_runs WHERE status = 'running'").fetch_all(&state.db).await?;
    let busy = busy.into_iter().map(|b| b.0).collect();
    let turn = state.reports.turn.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut claimed = Vec::new();
    for id in pick(&due, &busy, turn, PARALLEL) {
        let won = sqlx::query(
            "UPDATE report_runs SET status = 'running', lease_until = $1, started_at = COALESCE(started_at, $2) \
             WHERE id = $3 AND status = 'queued'",
        )
        .bind(now + LEASE_MS)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?
        .rows_affected();
        if won == 1 {
            claimed.push(id);
        }
    }
    Ok(claimed)
}
/// Deletes finished runs past the retention.
pub async fn purge(state: &AppState) -> ApiResult<u64> {
    let days = super::limits(state).await?.history_retention_days;
    let cutoff =
        state.clock.now_ms().saturating_sub(i64::try_from(days).unwrap_or(i64::MAX / DAY_MS).saturating_mul(DAY_MS));
    Ok(sqlx::query("DELETE FROM report_runs WHERE finished_at IS NOT NULL AND finished_at < $1")
        .bind(cutoff)
        .execute(&state.db)
        .await?
        .rows_affected())
}

/// One look: due reports are queued, stale runs recovered and every claimed run is run to its
/// end. Nothing on a server that does not lead. Answers the runs made (tests drive the worker
/// with a manual clock through this).
pub async fn run_due(state: &AppState, mailer: &dyn Mailer) -> ApiResult<usize> {
    if state.cluster.coordinated() && !state.cluster.is_leader() {
        return Ok(0);
    }
    let now = state.clock.now_ms();
    enqueue_due(state, now).await?;
    recover_stale(state, now).await?;
    give_up_late(state, now).await?;
    if !super::enabled(state).await? {
        return Ok(0);
    }
    let mut made = 0;
    loop {
        let claimed = claim(state, state.clock.now_ms()).await?;
        if claimed.is_empty() {
            return Ok(made);
        }
        made += claimed.len();
        let runs = claimed.iter().map(|id| async move {
            if let Err(e) = run::execute(state, mailer, id).await {
                tracing::warn!(run = %id, "a report run could not be stored: {}", e.message);
            }
        });
        futures_util::future::join_all(runs).await;
    }
}

/// Runs the worker until the server stops.
pub fn spawn(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let mailer = run::SmtpMailer { state: state.clone() };
        let mut last_purge = None;
        loop {
            tokio::select! {
                () = stopping.cancelled() => return,
                () = tokio::time::sleep(LOOK_EVERY) => {}
                () = state.reports.queued.notified() => {}
            }
            if let Err(e) = run_due(&state, &mailer).await {
                tracing::warn!("report worker: {}", e.message);
            }
            let mono = state.clock.monotonic_ms();
            let leads = !state.cluster.coordinated() || state.cluster.is_leader();
            if leads && last_purge.is_none_or(|at| mono - at >= HOUR_MS) {
                last_purge = Some(mono);
                match purge(&state).await {
                    Ok(0) => {}
                    Ok(n) => tracing::info!("deleted {n} report runs past their retention"),
                    Err(e) => tracing::warn!("report history retention: {}", e.message),
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn organizations_take_turns_one_run_each() {
        let due: Vec<(String, String)> = [("r1", "big"), ("r2", "big"), ("r3", "big"), ("s1", "small"), ("t1", "busy")]
            .iter()
            .map(|(r, o)| (r.to_string(), o.to_string()))
            .collect();
        let busy = std::collections::HashSet::from(["busy".to_string()]);
        assert_eq!(pick(&due, &busy, 0, 4), ["r1", "s1"], "one per organization, none of a busy one");
        assert_eq!(pick(&due, &busy, 1, 4), ["s1", "r1"], "another goes first next time");
        assert_eq!(pick(&due, &busy, 0, 1), ["r1"]);
        assert!(pick(&[], &busy, 0, 4).is_empty());
    }
}
