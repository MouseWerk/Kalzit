//! Retention of the alerting history: an hourly job on the leading server deletes entries older
//! than the organization's `alerting.history_retention_days`, like the AI chats.

use crate::app::AppState;
use crate::error::ApiResult;

const DAY_MS: i64 = 86_400_000;
const PURGE_BATCH: i64 = 1_000;

/// The oldest time still kept for the organization.
pub async fn cutoff(state: &AppState, org_id: &str) -> ApiResult<i64> {
    let days = super::limits::for_org(state, org_id).await?.history_retention_days;
    let days = i64::try_from(days).unwrap_or(i64::MAX);
    Ok(state.clock.now_ms().saturating_sub(days.saturating_mul(DAY_MS)))
}

/// Deletes history past the retention of its organization. Answers the number deleted.
pub async fn purge_expired(state: &AppState) -> ApiResult<u64> {
    purge_expired_in(state, &state.db).await
}

async fn purge_expired_in(state: &AppState, db: &sqlx::AnyPool) -> ApiResult<u64> {
    let orgs: Vec<(String,)> = sqlx::query_as("SELECT DISTINCT org_id FROM alert_history").fetch_all(db).await?;
    let mut total = 0;
    for (org,) in orgs {
        let cutoff = cutoff(state, &org).await?;
        loop {
            let mut tx = crate::db::begin(db).await?;
            let ids: Vec<(String,)> =
                sqlx::query_as("SELECT id FROM alert_history WHERE org_id = $1 AND at < $2 ORDER BY at LIMIT $3")
                    .bind(&org)
                    .bind(cutoff)
                    .bind(PURGE_BATCH)
                    .fetch_all(&mut *tx)
                    .await?;
            for (id,) in &ids {
                sqlx::query("DELETE FROM alert_history WHERE id = $1").bind(id).execute(&mut *tx).await?;
            }
            crate::db::commit(tx).await?;
            total += ids.len() as u64;
            if (ids.len() as i64) < PURGE_BATCH {
                break;
            }
        }
    }
    Ok(total)
}

/// Runs `purge_expired` every hour.
pub fn spawn_retention(state: AppState) {
    use crate::db::JobError;
    let cluster_state = state.clone();
    crate::cluster::spawn_job(
        &cluster_state,
        "alerting:history_retention",
        "deleting alerting history past its retention",
        crate::db::Schedule::hourly(),
        move || {
            let state = state.clone();
            async move {
                match purge_expired_in(&state, state.background.db()).await {
                    Ok(0) => Ok(()),
                    Ok(n) => {
                        tracing::info!("deleted {n} alerting history entries past their retention");
                        Ok(())
                    }
                    Err(e) if e.code == "busy" => Err(JobError::Busy(e.message)),
                    Err(e) => Err(JobError::Failed(e.message)),
                }
            }
        },
    );
}
