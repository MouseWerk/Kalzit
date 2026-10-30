//! The hourly cleanup of one-time links (docs/api/mail.md, "Retention"): used or expired password
//! and confirmation links a day after they ended, accepted invitations after 30 days, expired ones
//! after 90, and the sealed copies of expired invitation links at once. It runs on one server only
//! when several share the database (`cluster::spawn_job`).

use crate::app::AppState;
use crate::db::{JobError, Schedule};
use crate::error::ApiResult;
use crate::routes::{invitations, password_reset};

/// Deletes and clears what is past its retention at `now`; answers how many rows changed.
pub async fn run(db: &sqlx::AnyPool, now: i64) -> ApiResult<u64> {
    let mut tx = crate::db::begin(db).await?;
    let mut changed = 0;
    let ended = now - password_reset::KEEP_MS;
    for sql in [
        "DELETE FROM password_resets WHERE expires_at < $1 OR used_at < $1",
        "DELETE FROM email_confirmations WHERE expires_at < $1 OR used_at < $1",
    ] {
        changed += sqlx::query(sql).bind(ended).execute(&mut *tx).await?.rows_affected();
    }
    changed +=
        sqlx::query("DELETE FROM invitations WHERE accepted_at < $1 OR (accepted_at IS NULL AND expires_at < $2)")
            .bind(now - invitations::KEEP_ACCEPTED_MS)
            .bind(now - invitations::KEEP_EXPIRED_MS)
            .execute(&mut *tx)
            .await?
            .rows_affected();
    changed += sqlx::query(
        "UPDATE invitations SET token_key_id = NULL, token_nonce = NULL, token_ciphertext = NULL \
         WHERE expires_at <= $1 AND token_key_id IS NOT NULL",
    )
    .bind(now)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    crate::db::commit(tx).await?;
    Ok(changed)
}

/// Runs `run` every hour, on the leader only.
pub fn spawn(state: AppState) {
    let cluster_state = state.clone();
    crate::cluster::spawn_job(
        &cluster_state,
        "mail:cleanup",
        "removing old one-time links",
        Schedule::hourly(),
        move || {
            let state = state.clone();
            async move {
                match run(state.background.db(), state.clock.now_ms()).await {
                    Ok(_) => Ok(()),
                    Err(e) if e.code == "busy" => Err(JobError::Busy(e.message)),
                    Err(e) => Err(JobError::Failed(e.message)),
                }
            }
        },
    );
}
