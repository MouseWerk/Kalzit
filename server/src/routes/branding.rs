//! Appearance and brand: what the sign-in page and the app shell show before and after sign-in
//! (product name, logo, sign-in texts, default theme and look), the logo itself, and the look an
//! organization's members get (its overrides of the server's appearance settings).
//! docs/api/settings-dashboards.md, "Appearance and brand".

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header};
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
        // Base64 makes a 256 KiB image about 342 KiB; the cap leaves room for the JSON around it.
        route(Method::PUT, "/admin/branding/logo", Access::ServerAdmin, put_logo).body_limit(MAX_UPLOAD_BYTES),
        route(Method::DELETE, "/admin/branding/logo", Access::ServerAdmin, delete_logo),
        route(Method::POST, "/admin/branding/logo/restore", Access::ServerAdmin, restore_logo),
        route(Method::GET, "/orgs/{orgId}/appearance", Access::OrgMember, get_org_appearance),
    ]
}

/// The largest logo, decoded. A logo is a small mark; this keeps the database row and every page
/// load small.
pub const MAX_LOGO_BYTES: usize = 256 * 1024;

/// The largest upload request: the logo as base64 plus its JSON envelope.
pub const MAX_UPLOAD_BYTES: usize = 400 * 1024;

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
        accent: get("appearance.accent").await?,
        density: get("appearance.density").await?,
        font_size: get("appearance.font_size").await?,
    }))
}

/// Whether an `If-None-Match` header names `etag`: a list of tags, weak ones (`W/"..."`) compared
/// by their value, or `*`.
pub fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').map(str::trim).any(|tag| tag == "*" || tag.strip_prefix("W/").unwrap_or(tag) == etag)
}

/// `?v=` of a logo URL, if it names the current image (a prefix of its hash, as the UI builds it).
fn versioned(query: Option<&str>, sha: &str) -> bool {
    query
        .into_iter()
        .flat_map(|q| q.split('&'))
        .filter_map(|pair| pair.strip_prefix("v="))
        .any(|v| v.len() >= 8 && v.len() <= sha.len() && sha.starts_with(v) && v.bytes().all(|b| b.is_ascii_hexdigit()))
}

async fn get_logo(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> ApiResult<Response> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT content_type, data, sha256 FROM branding_logo WHERE id = 'server'")
            .fetch_optional(&state.db)
            .await?;
    let Some((content_type, data, sha)) = row else { return Err(ApiError::not_found()) };
    let etag = format!("\"{sha}\"");
    let fresh =
        headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).is_some_and(|v| etag_matches(v, &etag));
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
    // A URL with the image's hash never changes its answer; a plain URL must show a new logo at once.
    let cache = if versioned(uri.query(), &sha) { "public, max-age=31536000, immutable" } else { "no-cache" };
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
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

/// Keeps the current logo as the previous one, for undo (`restore_logo`). Without a current logo
/// the previous one is cleared, so undoing the next upload removes the logo again.
async fn keep_previous(tx: &mut sqlx::AnyConnection) -> ApiResult<()> {
    let copied = sqlx::query(
        "INSERT INTO branding_logo (id, content_type, data, sha256, version, updated_by, updated_at) \
         SELECT 'previous', content_type, data, sha256, version, updated_by, updated_at FROM branding_logo \
         WHERE id = 'server' \
         ON CONFLICT (id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, \
         sha256 = excluded.sha256, version = excluded.version, updated_by = excluded.updated_by, \
         updated_at = excluded.updated_at",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if copied == 0 {
        sqlx::query("DELETE FROM branding_logo WHERE id = 'previous'").execute(&mut *tx).await?;
    }
    Ok(())
}

async fn record_logo(
    tx: &mut sqlx::AnyConnection,
    user: &SessionUser,
    info: &RequestInfo,
    action: &'static str,
    summary: Value,
    now: i64,
) -> ApiResult<()> {
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("logo"),
        resource_id: None,
        summary,
        at_ms: now,
    };
    audit::record(tx, &event).await?;
    Ok(())
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
    let current: Option<(i64,)> =
        sqlx::query_as("SELECT version FROM branding_logo WHERE id = 'server'").fetch_optional(&mut *tx).await?;
    let version = current.map_or(1, |(v,)| v + 1);
    keep_previous(&mut tx).await?;
    // An upsert, so two uploads at once both succeed on PostgreSQL too; the later one wins.
    sqlx::query(
        "INSERT INTO branding_logo (id, content_type, data, sha256, version, updated_by, updated_at) \
         VALUES ('server', $1, $2, $3, $4, $5, $6) \
         ON CONFLICT (id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, \
         sha256 = excluded.sha256, version = excluded.version, updated_by = excluded.updated_by, \
         updated_at = excluded.updated_at",
    )
    .bind(&body.content_type)
    .bind(&data)
    .bind(&sha)
    .bind(version)
    .bind(&user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let summary = json!({ "contentType": body.content_type, "bytes": bytes.len(), "version": version });
    record_logo(&mut tx, &user, &info, "branding.logo_updated", summary, now).await?;
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
    let exists: Option<(i64,)> =
        sqlx::query_as("SELECT version FROM branding_logo WHERE id = 'server'").fetch_optional(&mut *tx).await?;
    if exists.is_none() {
        return Err(ApiError::not_found());
    }
    keep_previous(&mut tx).await?;
    sqlx::query("DELETE FROM branding_logo WHERE id = 'server'").execute(&mut *tx).await?;
    record_logo(&mut tx, &user, &info, "branding.logo_removed", json!({}), now).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Undo of the last upload or removal: the previous logo and the current one change places (a
/// missing one counts as "no logo"). Answers the logo now in effect, or `null`.
async fn restore_logo(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
) -> ApiResult<Json<Option<LogoInfo>>> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM branding_logo WHERE id IN ('server', 'previous')").fetch_all(&mut *tx).await?;
    if !rows.iter().any(|(id,)| id == "previous") && !rows.iter().any(|(id,)| id == "server") {
        return Err(ApiError::not_found());
    }
    sqlx::query("UPDATE branding_logo SET id = 'swap' WHERE id = 'server'").execute(&mut *tx).await?;
    sqlx::query("UPDATE branding_logo SET id = 'server' WHERE id = 'previous'").execute(&mut *tx).await?;
    sqlx::query("UPDATE branding_logo SET id = 'previous' WHERE id = 'swap'").execute(&mut *tx).await?;
    let now_logo: Option<(String, String)> =
        sqlx::query_as("SELECT content_type, sha256 FROM branding_logo WHERE id = 'server'")
            .fetch_optional(&mut *tx)
            .await?;
    record_logo(&mut tx, &user, &info, "branding.logo_restored", json!({ "logo": now_logo.is_some() }), now).await?;
    crate::db::commit(tx).await?;
    Ok(Json(now_logo.map(|(content_type, sha256)| LogoInfo { content_type, sha256 })))
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

    #[test]
    fn if_none_match_takes_lists_weak_tags_and_the_wildcard() {
        let etag = "\"abc\"";
        for header in ["\"abc\"", "W/\"abc\"", "\"x\", \"abc\"", "\"x\",W/\"abc\"", "*"] {
            assert!(etag_matches(header, etag), "{header}");
        }
        for header in ["\"abd\"", "abc", "W/abc", ""] {
            assert!(!etag_matches(header, etag), "{header}");
        }
    }

    #[test]
    fn only_a_url_with_the_current_hash_is_cached_for_good() {
        let sha = "0123456789abcdef0123";
        assert!(versioned(Some("v=0123456789abcdef"), sha));
        assert!(!versioned(Some("v=0123456789abcdee"), sha));
        assert!(!versioned(Some("v=01"), sha), "too short to name an image");
        assert!(!versioned(None, sha));
    }
}
