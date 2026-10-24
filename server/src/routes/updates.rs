//! Updates, for server administrators (docs/api/updates.md).

use std::collections::HashSet;

use axum::extract::multipart::MultipartError;
use axum::extract::{Multipart, Path, State};
use axum::http::Method;
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::updates::signing::{MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES, MAX_SIGNATURE_BYTES};
use crate::updates::staging::{self, MANIFEST_FILE, PACKAGE_FILE, SIGNATURE_FILE};
use crate::updates::{Actor, UpdateError, UpdateStatus};

/// The upload's body: the package and its two small files, with room for the multipart framing.
const MAX_UPLOAD_BYTES: usize = MAX_PACKAGE_BYTES as usize + MAX_MANIFEST_BYTES + MAX_SIGNATURE_BYTES + 64 * 1024;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/updates", Access::ServerAdmin, status),
        route(Method::POST, "/admin/updates/check", Access::ServerAdmin, check),
        route(Method::POST, "/admin/updates/download", Access::ServerAdmin, download),
        route(Method::POST, "/admin/updates/upload", Access::ServerAdmin, upload).body_limit(MAX_UPLOAD_BYTES),
        route(Method::DELETE, "/admin/updates/staged", Access::ServerAdmin, discard),
        route(Method::POST, "/admin/updates/apply", Access::ServerAdmin, apply),
        route(Method::PUT, "/admin/updates/schedule", Access::ServerAdmin, schedule),
        route(Method::DELETE, "/admin/updates/schedule", Access::ServerAdmin, unschedule),
        route(Method::POST, "/admin/updates/rollback", Access::ServerAdmin, rollback),
        route(Method::POST, "/admin/updates/skip", Access::ServerAdmin, skip),
        route(Method::POST, "/admin/updates/backups", Access::ServerAdmin, backup_now),
        route(Method::GET, "/admin/updates/backups/{file}", Access::ServerAdmin, download_backup),
    ]
}

fn actor(user: &SessionUser, info: &RequestInfo) -> Actor {
    Actor { user_id: Some(user.id.clone()), address: Some(info.client_ip.to_string()) }
}

async fn status(State(state): State<AppState>) -> ApiResult<Json<UpdateStatus>> {
    Ok(Json(state.updates.status(&state).await?))
}

async fn check(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.check(&state, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionBody {
    version: String,
}

async fn download(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<VersionBody>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.start_download(&state, &body.version, actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

fn multipart_error(e: MultipartError) -> ApiError {
    let status = e.status();
    let detail = e.body_text();
    if status == axum::http::StatusCode::PAYLOAD_TOO_LARGE {
        return ApiError::new(status, "payload_too_large", detail);
    }
    ApiError::new(axum::http::StatusCode::UNPROCESSABLE_ENTITY, "validation", detail.clone())
        .because("request.body_invalid")
        .param("detail", detail)
}

use staging::UPLOAD_BUNDLE_FILE as BUNDLE_FILE;

/// Writes the parts into `dir`, each within its limit: either one offline package (`bundle`, a
/// `.kalzit-update` file), or `manifest`, `signature` and `package` on their own.
async fn receive(multipart: &mut Multipart, dir: &std::path::Path) -> ApiResult<()> {
    let mut seen = HashSet::new();
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_error)? {
        let name = field.name().unwrap_or_default().to_string();
        let (file, max) = match name.as_str() {
            "manifest" => (MANIFEST_FILE, MAX_MANIFEST_BYTES as u64),
            "signature" => (SIGNATURE_FILE, MAX_SIGNATURE_BYTES as u64),
            "package" => (PACKAGE_FILE, MAX_PACKAGE_BYTES),
            "bundle" => (BUNDLE_FILE, MAX_UPLOAD_BYTES as u64),
            _ => return Err(UpdateError::UploadUnknownPart(name).into()),
        };
        // A bundle carries all three parts, so it comes alone.
        let mixed = (file == BUNDLE_FILE && !seen.is_empty()) || seen.contains(BUNDLE_FILE);
        if !seen.insert(file) || mixed {
            return Err(UpdateError::UploadUnknownPart(name).into());
        }
        let failed = |e: std::io::Error| ApiError::from(UpdateError::InstallFailed(e.to_string()));
        let mut out = tokio::fs::File::create(dir.join(file)).await.map_err(failed)?;
        let mut size = 0u64;
        while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
            size += chunk.len() as u64;
            if size > max {
                return Err(UpdateError::TooLarge(max).into());
            }
            out.write_all(&chunk).await.map_err(failed)?;
        }
        out.sync_all().await.map_err(failed)?;
    }
    // `Updates::stage_upload` splits a bundle, so a broken one is refused like any other upload.
    Ok(())
}

/// Sends a backup file, for keeping it elsewhere.
async fn download_backup(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    Path(file): Path<String>,
) -> ApiResult<axum::response::Response> {
    let path = state.updates.backup_path(&file).ok_or_else(ApiError::not_found)?;
    let opened = tokio::fs::File::open(&path).await.map_err(|_| ApiError::not_found())?;
    let size = opened.metadata().await.map(|m| m.len()).map_err(|_| ApiError::not_found())?;
    state.updates.record_backup_download(&state, &file, &actor(&user, &info)).await?;
    let disposition = format!("attachment; filename=\"{file}\"");
    let body = axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(opened));
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/vnd.sqlite3".to_string()),
            (axum::http::header::CONTENT_DISPOSITION, disposition),
            (axum::http::header::CONTENT_LENGTH, size.to_string()),
            (axum::http::header::CACHE_CONTROL, "no-store".to_string()),
        ],
        body,
    )
        .into_response())
}

/// An offline release: the package with its manifest and signature (multipart parts `package`,
/// `manifest`, `signature`). Verified like a download before it is staged.
async fn upload(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    headers: axum::http::HeaderMap,
    mut multipart: Multipart,
) -> ApiResult<Json<UpdateStatus>> {
    // One upload at a time, and only with room for it; without a length, the largest allowed.
    let incoming = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(MAX_UPLOAD_BYTES as u64);
    let _slot = state.updates.begin_upload(incoming)?;
    let layout = state.updates.layout().clone();
    let dir = staging::incoming_dir(&layout, &format!("upload-{}", super::new_id()))
        .map_err(|e| ApiError::from(UpdateError::InstallFailed(e.to_string())))?;
    let result = match receive(&mut multipart, &dir).await {
        Ok(()) => state.updates.stage_upload(&state, &dir, &actor(&user, &info)).await,
        Err(e) => Err(e),
    };
    // Staging moved the folder; anything left is a refused upload.
    if dir.exists() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
    result?;
    Ok(Json(state.updates.status(&state).await?))
}

async fn discard(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.discard(&state, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyBody {
    version: String,
    /// PostgreSQL: the administrator backed the database up and installs without Kalzit's own
    /// backup.
    #[serde(default)]
    acknowledge_no_backup: bool,
}

async fn apply(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ApplyBody>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.apply(&state, &body.version, body.acknowledge_no_backup, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleBody {
    version: String,
    /// Unix milliseconds.
    at: i64,
    /// The end of the maintenance window (Unix milliseconds): a server that was down at `at`
    /// and starts after it does not install any more.
    #[serde(default)]
    until: Option<i64>,
    /// PostgreSQL: the administrator backed the database up and confirms it now.
    #[serde(default)]
    acknowledge_no_backup: bool,
}

async fn schedule(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<ScheduleBody>,
) -> ApiResult<Json<UpdateStatus>> {
    let ack = body.acknowledge_no_backup;
    state.updates.schedule(&state, &body.version, body.at, body.until, ack, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

async fn unschedule(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.unschedule(&state, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

async fn skip(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<VersionBody>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.skip(&state, &body.version, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

async fn backup_now(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.backup_now(&state, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackBody {
    version: String,
    /// Confirms that the database goes back to the backup taken when `version` was left.
    #[serde(default)]
    restore_database: bool,
}

async fn rollback(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<RollbackBody>,
) -> ApiResult<Json<UpdateStatus>> {
    state.updates.rollback(&state, &body.version, body.restore_database, &actor(&user, &info)).await?;
    Ok(Json(state.updates.status(&state).await?))
}
