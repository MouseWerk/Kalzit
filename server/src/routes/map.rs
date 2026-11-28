//! Map images (docs/api/map.md): the source as a server setting for server administrators, and
//! the images themselves for signed-in people and for public links that show a map panel. The
//! fields of the source depend on each other, so they are saved in one step after a test that
//! loaded an image; switching the map images off applies at once.

use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::map::{self, TileError, TileSource, Viewer};
use crate::net::RequestInfo;

/// How long a browser keeps an image of a signed-in person.
const BROWSER_CACHE: &str = "private, max-age=3600";

pub fn routes() -> Vec<RouteDef> {
    use Access::{Authenticated, Public, ServerAdmin};
    vec![
        route(Method::GET, "/admin/map", ServerAdmin, view),
        route(Method::PUT, "/admin/map", ServerAdmin, save),
        route(Method::PUT, "/admin/map/enabled", ServerAdmin, switch),
        route(Method::POST, "/admin/map/test", ServerAdmin, test),
        route(Method::GET, "/map", Authenticated, info),
        route(Method::GET, "/map/tiles/{z}/{x}/{y}", Authenticated, tile),
        route(Method::GET, "/public/dashboards/{token}/map", Public, public_info),
        route(Method::GET, "/public/dashboards/{token}/map/tiles/{z}/{x}/{y}", Public, public_tile),
    ]
}

/// What a map panel needs to know: whether there are map images, and what to write under them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapInfo {
    tiles: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    attribution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_zoom: Option<u8>,
    /// With map images: whether they load for this viewer right now. `false` while the source
    /// failed lately or the viewer's fetches are paused; maps then draw the outlines at once.
    #[serde(skip_serializing_if = "Option::is_none")]
    available: Option<bool>,
}

async fn load_info(state: &AppState, who: &str) -> ApiResult<MapInfo> {
    Ok(match map::active(state).await? {
        Some(active) => MapInfo {
            tiles: true,
            attribution: Some(active.source.attribution),
            max_zoom: Some(active.source.max_zoom),
            available: Some(state.map.available(who, state.clock.monotonic_ms())),
        },
        None => MapInfo { tiles: false, attribution: None, max_zoom: None, available: None },
    })
}

async fn info(State(state): State<AppState>, Extension(user): Extension<SessionUser>) -> ApiResult<Json<MapInfo>> {
    Ok(Json(load_info(&state, &format!("user:{}", user.id)).await?))
}

async fn public_info(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(token): Path<String>,
) -> Response {
    let answer = match super::sharing::link_showing_map(&state, &info, &token).await {
        Ok(link_id) => load_info(&state, &format!("link:{link_id}")).await.map(Json),
        Err(e) => Err(e),
    };
    super::sharing::public(answer)
}

/// `z`, `x` and `y` of a path; anything that is not three numbers is no image.
fn tile_id(z: &str, x: &str, y: &str) -> Option<map::TileId> {
    // Digits only: no sign, no space, nothing a parser would accept beyond a plain number.
    let plain = |s: &str| !s.is_empty() && s.len() <= 10 && s.bytes().all(|b| b.is_ascii_digit());
    if !(plain(z) && plain(x) && plain(y)) {
        return None;
    }
    Some((z.parse().ok()?, x.parse().ok()?, y.parse().ok()?))
}

fn tile_error(e: TileError) -> ApiError {
    match e {
        TileError::NotFound => ApiError::not_found(),
        TileError::Limited(wait) => ApiError::rate_limited("too many map images at once, wait a moment", wait),
        TileError::Unavailable => {
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "busy", "the map images cannot be loaded right now")
                .because("map.tiles_unavailable")
        }
        TileError::Internal(e) => e,
    }
}

fn image(bytes: Vec<u8>, format: map::Format, cache: &'static str) -> Response {
    let mut res = bytes.into_response();
    let headers = res.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(format.content_type()));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

async fn tile(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Path((z, x, y)): Path<(String, String, String)>,
) -> ApiResult<Response> {
    let id = tile_id(&z, &x, &y).ok_or_else(ApiError::not_found)?;
    let (bytes, format) = map::tile(&state, Viewer::User(&user.id), id).await.map_err(tile_error)?;
    Ok(image(bytes, format, BROWSER_CACHE))
}

async fn public_tile(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path((token, z, x, y)): Path<(String, String, String, String)>,
) -> Response {
    let answer = async {
        // The link first: a path that is no image must not tell a working token from another.
        let link_id = super::sharing::link_showing_map(&state, &info, &token).await?;
        let id = tile_id(&z, &x, &y).ok_or_else(crate::sharing::unavailable)?;
        let (bytes, format) = map::tile(&state, Viewer::Link(&link_id), id).await.map_err(|e| match e {
            TileError::NotFound => crate::sharing::unavailable(),
            other => tile_error(other),
        })?;
        Ok::<_, ApiError>(image(bytes, format, "no-store"))
    }
    .await;
    super::sharing::public(answer)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminView {
    /// `null`: never set up. `enabled: false` keeps the fields of a source that was switched off.
    source: Option<TileSource>,
    /// An access key is stored (never sent back).
    has_key: bool,
    version: i64,
    /// The outbound proxy the fetches go through (`host:port`), if one is set.
    proxy: Option<String>,
    cache: map::cache::Usage,
    /// Why the last fetch from the source failed, until one succeeds.
    last_error: Option<map::LastError>,
}

async fn load_view(state: &AppState) -> ApiResult<AdminView> {
    let (source, version) = map::load_stored(&state.db).await?;
    let has_key = map::load_key(&state.db, &state.secrets).await?.is_some();
    let proxy = crate::outbound::current(state).await?.map(|p| {
        let url = p.url();
        match url.port_or_known_default() {
            Some(port) => format!("{}:{port}", p.host()),
            None => p.host(),
        }
    });
    let cache = match source.as_ref().filter(|s| s.enabled) {
        Some(s) => {
            let dir = map::cache::source_dir(&s.url_template);
            let place = map::cache::Place { dir: &dir, generation: state.map.generation() };
            state.map.cache.usage(&state.config.paths.data_dir, place).await
        }
        None => map::cache::Usage::default(),
    };
    Ok(AdminView { source, has_key, version, proxy, cache, last_error: state.map.last_error() })
}

async fn view(State(state): State<AppState>) -> ApiResult<Json<AdminView>> {
    Ok(Json(load_view(&state).await?))
}

/// The fields of the form; `enabled` is not one of them (saving switches the map images on).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFields {
    url_template: String,
    attribution: String,
    max_zoom: u8,
    cache_max_mb: u32,
    cache_ttl_days: u32,
}

impl SourceFields {
    fn source(self) -> TileSource {
        TileSource {
            enabled: true,
            url_template: self.url_template,
            attribution: self.attribution,
            max_zoom: self.max_zoom,
            cache_max_mb: self.cache_max_mb,
            cache_ttl_days: self.cache_ttl_days,
        }
        .normalized()
    }
}

/// The key to use with `source`: the one sent, else the stored one when it belongs to the same
/// scheme, host and port (so changing the address cannot send the stored key elsewhere). A
/// template without `{key}` uses none.
async fn key_for(state: &AppState, source: &TileSource, sent: Option<String>) -> ApiResult<Option<Zeroizing<String>>> {
    let sent = sent.map(Zeroizing::new);
    if let Some(key) = &sent {
        map::check_key(key)?;
    }
    if !source.wants_key() {
        return match sent.filter(|k| !k.is_empty()) {
            Some(_) => Err(ApiError::validation("the address has no {key}, so the access key would not be used")
                .with_field("key")
                .because("map.key_unused")),
            None => Ok(None),
        };
    }
    let key = match sent {
        Some(key) => Some(key).filter(|k| !k.is_empty()),
        None => {
            let (stored, _) = map::load_stored(&state.db).await?;
            match stored.filter(|s| s.same_origin(source)) {
                Some(_) => map::load_key(&state.db, &state.secrets).await?,
                None => None,
            }
        }
    };
    key.map(Some).ok_or_else(|| {
        ApiError::validation("the address has {key}; enter the access key for this map service")
            .with_field("key")
            .because("map.key_required")
    })
}

/// What a test loaded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    z: u8,
    x: u32,
    y: u32,
    bytes: usize,
    content_type: &'static str,
    elapsed_ms: u64,
    via_proxy: bool,
}

/// Loads one image with the values given, as a test and before every save. Counted against the
/// connection tests of the administrator. A refused target is a problem of the address field;
/// anything else the source did is answered without a field.
async fn load_test_image(
    state: &AppState,
    user: &SessionUser,
    source: &TileSource,
    key: Option<&str>,
) -> ApiResult<TestResult> {
    let limit = format!("map-test:{}", user.id);
    state
        .probe_limiter
        .try_acquire(&limit, &limit, state.clock.monotonic_ms())
        .map_err(|wait| ApiError::rate_limited("too many tests of the map images, wait a few minutes", wait))?;
    let id = source.test_tile();
    match map::fetch(state, source, key, id).await {
        Ok(fetched) => Ok(TestResult {
            z: id.0,
            x: id.1,
            y: id.2,
            bytes: fetched.bytes.len(),
            content_type: fetched.format.content_type(),
            elapsed_ms: fetched.elapsed_ms,
            via_proxy: fetched.via_proxy,
        }),
        Err(detail) => {
            let about_address = detail.reason.starts_with("target.") || detail.reason == "map.url_kalzit";
            let mut e = ApiError::validation(detail.message.clone()).with_reason(detail.reason, detail.params);
            if about_address {
                e = e.with_field("urlTemplate");
            }
            Err(e)
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestBody {
    source: SourceFields,
    /// Left out: the stored key, while the address stays on the same host. `""`: none.
    #[serde(default)]
    key: Option<String>,
}

async fn test(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    JsonBody(body): JsonBody<TestBody>,
) -> ApiResult<Json<TestResult>> {
    let source = body.source.source();
    map::check_target(&state, &source).await?;
    let key = key_for(&state, &source, body.key).await?;
    Ok(Json(load_test_image(&state, &user, &source, key.as_deref().map(|k| k.as_str())).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBody {
    source: SourceFields,
    #[serde(default)]
    key: Option<String>,
    version: i64,
}

fn audit_event<'a>(
    user: &'a SessionUser,
    info: &RequestInfo,
    summary: serde_json::Value,
    now: i64,
) -> crate::audit::AuditEvent<'a> {
    crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "map.tiles_changed",
        resource_type: Some("map"),
        resource_id: None,
        summary,
        at_ms: now,
    }
}

/// The host of the source, for the audit log: never the path or query, which may carry the key's
/// place.
fn source_host(source: &TileSource) -> String {
    source.url((0, 0, 0), None).and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<AdminView>> {
    let source = body.source.source();
    map::check_target(&state, &source).await?;
    let key = key_for(&state, &source, body.key).await?;
    let had_key = map::load_key(&state.db, &state.secrets).await?;
    // Stored only when the source delivered an image with exactly these values.
    load_test_image(&state, &user, &source, key.as_deref().map(|k| k.as_str())).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let value = serde_json::to_value(&source).map_err(|e| ApiError::internal("map image source", e))?;
    let stored = crate::settings::store(&mut tx, None, map::SETTINGS_KEY, &value, body.version, &user.id, now).await?;
    if stored.is_none() {
        drop(tx);
        return Err(ApiError::version_conflict(json!(load_view(&state).await?)));
    }
    map::store_key(&mut tx, &state.secrets, key.as_deref().map(|k| k.as_str())).await?;
    let summary = json!({
        "enabled": true,
        "host": source_host(&source),
        "maxZoom": source.max_zoom,
        "cacheMaxMb": source.cache_max_mb,
        "cacheTtlDays": source.cache_ttl_days,
        "keySet": key.is_some(),
        "keyChanged": key.as_deref() != had_key.as_deref(),
    });
    crate::audit::record(&mut tx, &audit_event(&user, &info, summary, now)).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    state.map.forget();
    Ok(Json(load_view(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SwitchBody {
    enabled: bool,
    version: i64,
}

/// Switches the map images off at once, or back on (the undo of switching off): the stored source
/// is the one a test accepted when it was saved, so switching on again needs no new test.
async fn switch(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SwitchBody>,
) -> ApiResult<Json<AdminView>> {
    let (stored, version) = map::load_stored(&state.db).await?;
    let Some(mut source) = stored else {
        // Nothing stored: off is what it is, and there is nothing to switch on.
        if body.enabled {
            return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "no source of map images is set up")
                .because("map.not_configured"));
        }
        return Ok(Json(load_view(&state).await?));
    };
    if version != body.version {
        return Err(ApiError::version_conflict(json!(load_view(&state).await?)));
    }
    if source.enabled == body.enabled {
        return Ok(Json(load_view(&state).await?));
    }
    if body.enabled {
        // The rules may have changed since it was saved (allowed targets, the server's address).
        map::check_target(&state, &source).await?;
    }
    source.enabled = body.enabled;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let value = serde_json::to_value(&source).map_err(|e| ApiError::internal("map image source", e))?;
    let stored = crate::settings::store(&mut tx, None, map::SETTINGS_KEY, &value, body.version, &user.id, now).await?;
    if stored.is_none() {
        drop(tx);
        return Err(ApiError::version_conflict(json!(load_view(&state).await?)));
    }
    let summary = json!({ "enabled": body.enabled, "host": source_host(&source) });
    crate::audit::record(&mut tx, &audit_event(&user, &info, summary, now)).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    state.map.forget();
    if !body.enabled {
        // Off means off: nothing of the map service stays on this server.
        state.map.cache.clear(&state.config.paths.data_dir).await;
    }
    Ok(Json(load_view(&state).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_numbers_name_an_image() {
        assert_eq!(tile_id("6", "33", "21"), Some((6, 33, 21)));
        assert_eq!(tile_id("0", "0", "0"), Some((0, 0, 0)));
        for bad in ["+6", "-1", " 6", "6.0", "0x6", "", "six", "99999999999", "256"] {
            assert_eq!(tile_id(bad, "0", "0"), None, "{bad:?}");
        }
        assert_eq!(tile_id("6", "33", "21.png"), None);
        assert_eq!(tile_id("6", "4294967296", "0"), None);
    }
}
