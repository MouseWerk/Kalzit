//! Appearance and brand: what the sign-in page and the app shell show before and after sign-in
//! (product name, logo, sign-in texts, default theme and look), the logo itself, and the look an
//! organization's members get (its overrides of the server's appearance settings).
//! docs/api/settings-dashboards.md, "Appearance and brand".

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::auth::SessionUser;
use crate::authz::{Access, OrgCtx};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::settings;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/branding", Access::Public, get_branding),
        route(Method::GET, "/branding/logo", Access::Public, get_logo),
        route(Method::PUT, "/admin/branding/logo", Access::ServerAdmin, put_logo),
        route(Method::DELETE, "/admin/branding/logo", Access::ServerAdmin, delete_logo),
        route(Method::GET, "/orgs/{orgId}/appearance", Access::OrgMember, get_org_appearance),
    ]
}

/// The largest logo, decoded. A logo is a small mark; this keeps the database row and every page
/// load small.
pub const MAX_LOGO_BYTES: usize = 256 * 1024;

/// Raster formats only: an SVG can carry scripts and links, and would need its own sanitizer.
pub const LOGO_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp"];

/// Whether the bytes are an image of the declared type, by their signature.
pub fn logo_matches(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoInfo {
    content_type: String,
    /// Changes with the image; the UI puts it into the logo's URL.
    sha256: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignInTexts {
    welcome: Value,
    notice: Value,
}

/// Everything the pages need before anyone signs in: only what the sign-in page shows anyway.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branding {
    product_name: Value,
    logo: Option<LogoInfo>,
    sign_in: SignInTexts,
    default_theme: Value,
    default_language: Value,
    accent: Value,
    density: Value,
    font_size: Value,
}

async fn logo_info(state: &AppState) -> ApiResult<Option<LogoInfo>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT content_type, sha256 FROM branding_logo WHERE id = 'server'")
            .fetch_optional(&state.db)
            .await?;
    Ok(row.map(|(content_type, sha256)| LogoInfo { content_type, sha256 }))
}

async fn get_branding(State(state): State<AppState>) -> ApiResult<Json<Branding>> {
    let get = |key: &'static str| settings::get(&state, key);
    Ok(Json(Branding {
        product_name: get("appearance.product_name").await?,
        logo: logo_info(&state).await?,
        sign_in: SignInTexts { welcome: get("signin.welcome").await?, notice: get("signin.notice").await? },
        default_theme: get("appearance.default_theme").await?,
        default_language: get("appearance.default_language").await?,
        accent: get("appearance.accent").await?,
        density: get("appearance.density").await?,
        font_size: get("appearance.font_size").await?,
    }))
}

async fn get_logo(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT content_type, data, sha256 FROM branding_logo WHERE id = 'server'")
            .fetch_optional(&state.db)
            .await?;
    let Some((content_type, data, sha)) = row else { return Err(ApiError::not_found()) };
    let etag = format!("\"{sha}\"");
    let fresh = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).is_some_and(|v| v == etag);
    let mut res = if fresh {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| ApiError::internal("branding", format!("stored logo is not base64: {e}")))?;
        Response::new(Body::from(bytes))
    };
    let h = res.headers_mut();
    // Only types from LOGO_TYPES are ever stored, so the value is a valid header.
    if let Ok(v) = HeaderValue::from_str(&content_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&etag) {
        h.insert(header::ETAG, v);
    }
    // The URL carries the hash, but a plain URL must still show a new logo at once.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline"));
    Ok(res)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogoUpload {
    content_type: String,
    /// The image, base64.
    data: String,
}

async fn put_logo(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<LogoUpload>,
) -> ApiResult<Json<LogoInfo>> {
    if !LOGO_TYPES.contains(&body.content_type.as_str()) {
        return Err(ApiError::validation(format!("the logo must be one of {}", LOGO_TYPES.join(", ")))
            .with_field("contentType"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.data.trim())
        .map_err(|_| ApiError::validation("the logo is not valid base64").with_field("data"))?;
    if bytes.is_empty() || bytes.len() > MAX_LOGO_BYTES {
        return Err(
            ApiError::validation(format!("the logo takes 1 byte to {} KiB", MAX_LOGO_BYTES / 1024)).with_field("data")
        );
    }
    if !logo_matches(&body.content_type, &bytes) {
        return Err(ApiError::validation(format!("the file is not a {} image", body.content_type)).with_field("data"));
    }
    let sha = hex::encode(Sha256::digest(&bytes));
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let previous: Option<(i64,)> =
        sqlx::query_as("SELECT version FROM branding_logo WHERE id = 'server'").fetch_optional(&mut *tx).await?;
    let version = previous.map_or(1, |(v,)| v + 1);
    sqlx::query("DELETE FROM branding_logo WHERE id = 'server'").execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO branding_logo (id, content_type, data, sha256, version, updated_by, updated_at) \
         VALUES ('server', $1, $2, $3, $4, $5, $6)",
    )
    .bind(&body.content_type)
    .bind(&data)
    .bind(&sha)
    .bind(version)
    .bind(&user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "branding.logo_updated",
        resource_type: Some("logo"),
        resource_id: None,
        summary: json!({ "contentType": body.content_type, "bytes": bytes.len(), "version": version }),
        at_ms: now,
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(Json(LogoInfo { content_type: body.content_type, sha256: sha }))
}

async fn delete_logo(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<StatusCode> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let removed = sqlx::query("DELETE FROM branding_logo WHERE id = 'server'").execute(&mut *tx).await?.rows_affected();
    if removed == 0 {
        return Err(ApiError::not_found());
    }
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "branding.logo_removed",
        resource_type: Some("logo"),
        resource_id: None,
        summary: json!({}),
        at_ms: now,
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The look of one organization: its own value where it set one, the server's where it inherits.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgAppearance {
    accent: Value,
    density: Value,
    font_size: Value,
    start_page: Value,
    time_zone: Value,
    week_start: Value,
}

async fn effective(state: &AppState, org_id: &str, key: &str) -> ApiResult<Value> {
    let own = settings::get_org(state, org_id, key).await?;
    if own.as_str() == Some(settings::INHERIT) { settings::get(state, key).await } else { Ok(own) }
}

async fn get_org_appearance(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<OrgAppearance>> {
    let org = ctx.org_id.as_str();
    Ok(Json(OrgAppearance {
        accent: effective(&state, org, "appearance.accent").await?,
        density: effective(&state, org, "appearance.density").await?,
        font_size: effective(&state, org, "appearance.font_size").await?,
        start_page: effective(&state, org, "appearance.start_page").await?,
        time_zone: effective(&state, org, "appearance.time_zone").await?,
        week_start: effective(&state, org, "appearance.week_start").await?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logos_are_checked_by_their_signature() {
        assert!(logo_matches("image/png", b"\x89PNG\r\n\x1a\n...."));
        assert!(logo_matches("image/jpeg", &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(logo_matches("image/webp", b"RIFF\x10\0\0\0WEBPVP8 "));
        assert!(!logo_matches("image/png", &[0xff, 0xd8, 0xff]));
        assert!(!logo_matches("image/svg+xml", b"<svg/>"));
        assert!(!logo_matches("image/webp", b"RIFF"));
    }
}
