//! Backups on a schedule and to a target, for server administrators (docs/api/backups.md). The
//! target's fields depend on each other, so it is saved in one step after a connection test;
//! schedule and retention are ordinary settings (`backups.*`) with undo.

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use super::support::{Paging, QueryParams};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::backups::{self, Run, Target};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::shapes::Page;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/backups", Access::ServerAdmin, view),
        route(Method::PUT, "/admin/backups/target", Access::ServerAdmin, save_target).long_running(),
        route(Method::POST, "/admin/backups/target/test", Access::ServerAdmin, test_target).long_running(),
        route(Method::POST, "/admin/backups/run", Access::ServerAdmin, run_now).long_running(),
        route(Method::GET, "/admin/backups/runs", Access::ServerAdmin, runs),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    enabled: bool,
    interval_hours: i64,
    keep_count: i64,
    /// Backups are encrypted with the secrets key.
    encrypt: bool,
    /// When the next scheduled backup is due; `null` while the schedule is off or no target is
    /// saved.
    next_run_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupsView {
    /// Backups hold Kalzit's database (SQLite). With PostgreSQL they hold the files only and
    /// `pg_dump` backs up the database (docs/guide/backup.md).
    database_included: bool,
    /// `sqlite` or `postgres`.
    database: &'static str,
    /// `null`: no target saved.
    target: Option<Target>,
    /// A secret access key is stored (never sent back).
    has_secret: bool,
    version: i64,
    schedule: ScheduleView,
    last_run: Option<Run>,
}

async fn load_view(state: &AppState) -> ApiResult<BackupsView> {
    let (target, version) = backups::load_target(&state.db).await?;
    let has_secret = matches!(target, Some(Target::S3 { .. })) && backups::load_secret(state).await?.is_some();
    let int = async |key: &'static str, default: i64| -> ApiResult<i64> {
        Ok(crate::settings::get(state, key).await?.as_i64().unwrap_or(default))
    };
    let interval = backups::schedule(state).await?;
    let next_run_at = match interval {
        Some(ms) if target.is_some() => Some(backups::next_due(state, ms).await?.max(state.clock.now_ms())),
        _ => None,
    };
    Ok(BackupsView {
        database_included: backups::supported(state),
        database: if backups::supported(state) { "sqlite" } else { "postgres" },
        target,
        has_secret,
        version,
        schedule: ScheduleView {
            enabled: interval.is_some(),
            interval_hours: int("backups.interval_hours", 24).await?,
            keep_count: int("backups.keep_count", 14).await?,
            encrypt: crate::settings::get(state, "backups.encrypt").await?.as_bool() != Some(false),
            next_run_at,
        },
        last_run: backups::last_run(state).await?,
    })
}

async fn view(State(state): State<AppState>) -> ApiResult<Json<BackupsView>> {
    Ok(Json(load_view(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBody {
    /// `null` removes the target (and stops scheduled backups from running).
    target: Option<Target>,
    /// S3 only: `null` keeps the stored one for the same store, bucket and key id.
    #[serde(default)]
    secret_access_key: Option<String>,
    version: i64,
}

/// Connection checks per administrator, counted like data source connection tests.
fn count_check(state: &AppState, user: &SessionUser) -> ApiResult<()> {
    let key = format!("backup-check:{}", user.id);
    state
        .probe_limiter
        .try_acquire(&key, &key, state.clock.monotonic_ms())
        .map(|_| ())
        .map_err(|wait| ApiError::rate_limited("too many checks of the backup target, wait a few minutes", wait))
}

async fn save_target(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<BackupsView>> {
    let target = body.target.map(Target::normalized);
    let secret = match &target {
        Some(t) => {
            backups::check(t)?;
            let secret = backups::secret_for(&state, t, body.secret_access_key.map(Zeroizing::new)).await?;
            count_check(&state, &user)?;
            // The same test as "Test connection": nothing is saved that cannot be written to.
            let reach = backups::reach(&state, t, secret.clone()).await?;
            backups::test(&state, &reach).await?;
            secret
        }
        None => None,
    };
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let stored = match &target {
        Some(t) => {
            let value = serde_json::to_value(t).map_err(|e| ApiError::internal("backup target", e))?;
            crate::settings::store(&mut tx, None, backups::TARGET_KEY, &value, body.version, &user.id, now).await?
        }
        None => crate::settings::reset(&mut tx, None, backups::TARGET_KEY, body.version, &user.id, now).await?,
    };
    if stored.is_none() {
        drop(tx);
        return Err(ApiError::version_conflict(json!(load_view(&state).await?)));
    }
    backups::store_secret(&mut tx, &state, secret.as_deref().map(|s| s.as_str())).await?;
    let summary = match &target {
        Some(Target::Local { .. }) => json!({ "kind": "local" }),
        Some(Target::S3 { endpoint, bucket, .. }) => json!({ "kind": "s3", "endpoint": endpoint, "bucket": bucket }),
        None => json!({ "removed": true }),
    };
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "backup.target_changed",
        resource_type: Some("backup_target"),
        resource_id: None,
        summary,
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    Ok(Json(load_view(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestBody {
    /// The values in the form; `null` tests the saved target.
    #[serde(default)]
    target: Option<Target>,
    #[serde(default)]
    secret_access_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tested {
    ok: bool,
}

async fn test_target(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    JsonBody(body): JsonBody<TestBody>,
) -> ApiResult<Json<Tested>> {
    let (target, secret) = match body.target.map(Target::normalized) {
        Some(t) => {
            backups::check(&t)?;
            let secret = backups::secret_for(&state, &t, body.secret_access_key.map(Zeroizing::new)).await?;
            (t, secret)
        }
        None => match backups::load_target(&state.db).await?.0 {
            Some(t) => {
                let secret = backups::load_secret(&state).await?;
                (t, secret)
            }
            None => {
                return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "no backup target is saved")
                    .because("backup.no_target"));
            }
        },
    };
    count_check(&state, &user)?;
    let reach = backups::reach(&state, &target, secret).await?;
    backups::test(&state, &reach).await?;
    Ok(Json(Tested { ok: true }))
}

async fn run_now(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<Run>> {
    let address = info.client_ip.to_string();
    Ok(Json(backups::run(&state, "manual", Some(&user.id), Some(&address)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunsQuery {
    limit: Option<u32>,
    cursor: Option<String>,
}

async fn runs(State(state): State<AppState>, QueryParams(q): QueryParams<RunsQuery>) -> ApiResult<Json<Page<Run>>> {
    let paging = Paging::new(q.limit, q.cursor.as_deref())?;
    let rows: Vec<Run> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} WHERE (started_at < $1 OR (started_at = $1 AND id < $2)) ORDER BY started_at DESC, id DESC LIMIT $3",
        backups::RUN_COLUMNS
    )))
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(&state.db)
    .await?;
    Ok(Json(paging.page(rows, |r| (r.started_at, r.id.as_str()))))
}
