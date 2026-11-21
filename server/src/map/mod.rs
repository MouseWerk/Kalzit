//! Map images for the map panel (docs/api/map.md). The source of the map images is a server
//! setting and off by default: then maps draw coordinates over the bundled outlines and Kalzit
//! asks no map service. With a source, browsers still only talk to Kalzit: the server fetches each
//! image itself (through the outbound proxy when one is set), keeps it in a bounded cache in the
//! data directory and hands it out to signed-in people and to public links that show a map.
//!
//! The source is one stored value (`map.tiles` in `server_settings`, versioned like the other
//! settings); its fields depend on each other, so the settings page saves them together after a
//! test that loaded an image. The access key is a secret of its own in `server_secrets`.

pub mod cache;

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::datasources::Detail;
use crate::error::{ApiError, ApiResult};
use crate::http::{HttpError, HttpOptions, LocalGuard};
use crate::locks::MutexExt;
use crate::secrets::{Blob, Keyring};

pub use cache::{Format, TileCache, TileId};

/// The key of the stored source in `server_settings`.
pub const SETTINGS_KEY: &str = "map.tiles";
/// The access key's row in `server_secrets`.
pub const SECRET_OWNER: &str = "map";
pub const KEY_FIELD: &str = "tiles_key";

pub const MAX_URL_CHARS: usize = 2000;
pub const MAX_ATTRIBUTION_CHARS: usize = 200;
pub const MAX_KEY_CHARS: usize = 512;
/// Web maps end at zoom 22.
pub const MAX_ZOOM: u8 = 22;
pub const DEFAULT_MAX_ZOOM: u8 = 14;
pub const CACHE_MB: std::ops::RangeInclusive<u32> = 16..=102_400;
pub const DEFAULT_CACHE_MB: u32 = 2048;
pub const CACHE_DAYS: std::ops::RangeInclusive<u32> = 1..=365;
pub const DEFAULT_CACHE_DAYS: u32 = 7;

/// A larger answer of the source is refused; map images are a few dozen kilobytes.
pub const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;
/// One fetch from the source, connecting included.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// Fetches from the source running at once, for all people together.
pub const MAX_FETCHES: usize = 8;
/// How long a request waits for one of those places before it is refused.
pub const FETCH_SLOT_WAIT: Duration = Duration::from_secs(5);
/// Images one person, or the visitors of one public link, may make Kalzit fetch from the source
/// per window. Images from the cache do not count.
pub const MAX_FETCHES_PER_VIEWER: u32 = 600;
pub const RATE_WINDOW_SECS: u64 = 60;
/// After this many failed fetches in a row for one person or public link, the source is left
/// alone for them for `PAUSE_MS`. Per requester, so one person cannot pause it for everyone.
pub const FAILURES_BEFORE_PAUSE: u32 = 5;
pub const PAUSE_MS: i64 = 30_000;
/// Requesters whose failures are remembered at once; more start the count afresh.
const MAX_BREAKERS: usize = 10_000;

const DAY_MS: i64 = 86_400_000;

/// The source of the map images, as stored and as the settings page sends it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TileSource {
    /// Off keeps the fields, so switching on again (undo) needs no typing.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// `https://host/path/{z}/{x}/{y}.png`, optionally with `{key}`.
    pub url_template: String,
    /// Shown on every map and in every export.
    pub attribution: String,
    #[serde(default = "default_max_zoom")]
    pub max_zoom: u8,
    #[serde(default = "default_cache_mb")]
    pub cache_max_mb: u32,
    #[serde(default = "default_cache_days")]
    pub cache_ttl_days: u32,
}

fn yes() -> bool {
    true
}
fn default_max_zoom() -> u8 {
    DEFAULT_MAX_ZOOM
}
fn default_cache_mb() -> u32 {
    DEFAULT_CACHE_MB
}
fn default_cache_days() -> u32 {
    DEFAULT_CACHE_DAYS
}

impl TileSource {
    pub fn normalized(mut self) -> Self {
        self.url_template = self.url_template.trim().to_string();
        self.attribution = self.attribution.trim().to_string();
        self
    }

    pub fn cache_max_bytes(&self) -> u64 {
        u64::from(self.cache_max_mb) * 1024 * 1024
    }

    pub fn cache_ttl_ms(&self) -> i64 {
        i64::from(self.cache_ttl_days) * DAY_MS
    }

    /// Whether the template has a place for the access key.
    pub fn wants_key(&self) -> bool {
        self.url_template.contains("{key}")
    }

    /// Whether a key stored for `other` may be used with this source: only towards the same
    /// scheme, host and port, so a changed address cannot carry the stored key elsewhere.
    pub fn same_origin(&self, other: &TileSource) -> bool {
        match (self.url(SAMPLE, None), other.url(SAMPLE, None)) {
            (Some(a), Some(b)) => a.origin() == b.origin(),
            _ => false,
        }
    }

    /// The address of one image. `None` when the template does not make a URL.
    pub fn url(&self, (z, x, y): TileId, key: Option<&str>) -> Option<url::Url> {
        let key: String = url::form_urlencoded::byte_serialize(key.unwrap_or_default().as_bytes()).collect();
        let text = self
            .url_template
            .replace("{z}", &z.to_string())
            .replace("{x}", &x.to_string())
            .replace("{y}", &y.to_string())
            .replace("{key}", &key);
        url::Url::parse(&text).ok()
    }

    /// The image a test loads: the highest zoom up to 6, over central Europe (`6/33/21`).
    pub fn test_tile(&self) -> TileId {
        let z = self.max_zoom.min(6);
        let n = f64::from(1u32 << z);
        (z, (n * 0.53) as u32, (n * 0.34) as u32)
    }
}

const SAMPLE: TileId = (0, 0, 0);
/// The image with the largest numbers a source can have.
const WIDEST: TileId = (MAX_ZOOM, (1 << MAX_ZOOM) - 1, (1 << MAX_ZOOM) - 1);

/// Whether `(z, x, y)` names an image of a source with `max_zoom`.
pub fn in_range((z, x, y): TileId, max_zoom: u8) -> bool {
    z <= max_zoom.min(MAX_ZOOM) && x < (1u32 << z) && y < (1u32 << z)
}

fn field_error(field: &'static str, reason: &'static str, message: &str) -> ApiError {
    ApiError::validation(message.to_string()).with_field(field).because(reason)
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

/// The placeholders of a template, without braces; `Err` for a brace that does not close.
fn placeholders(template: &str) -> Result<Vec<&str>, ()> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').ok_or(())?;
        out.push(&rest[open + 1..open + close]);
        rest = &rest[open + close + 1..];
    }
    if rest.contains('}') { Err(()) } else { Ok(out) }
}

/// The checks of the fields that need no network, first problem first, with its field.
pub fn check(source: &TileSource) -> ApiResult<()> {
    let template = &source.url_template;
    if template.is_empty() || template.chars().count() > MAX_URL_CHARS || has_control(template) {
        return Err(field_error("urlTemplate", "map.url_invalid", "enter the address of the map images")
            .param("maxChars", MAX_URL_CHARS));
    }
    let names = placeholders(template).unwrap_or_default();
    let known = names.iter().all(|n| matches!(*n, "z" | "x" | "y" | "key"));
    if !known || !["z", "x", "y"].iter().all(|n| names.contains(n)) {
        return Err(field_error(
            "urlTemplate",
            "map.url_placeholders",
            "the address needs {z}, {x} and {y}; {key} is the only other placeholder",
        ));
    }
    let Some(url) = source.url(SAMPLE, Some("k")) else {
        return Err(field_error("urlTemplate", "map.url_invalid", "the address of the map images is not a URL")
            .param("maxChars", MAX_URL_CHARS));
    };
    // The placeholders belong in the path or query: with the largest numbers and the longest key
    // the address must still name the same scheme, user, host and port.
    let long_key = "k".repeat(MAX_KEY_CHARS);
    let widest = source.url(WIDEST, Some(&long_key));
    let same_authority = widest.as_ref().is_some_and(|w| {
        w.scheme() == url.scheme()
            && w.host_str() == url.host_str()
            && w.port_or_known_default() == url.port_or_known_default()
            && w.username() == url.username()
            && w.password() == url.password()
    });
    if !same_authority {
        return Err(field_error(
            "urlTemplate",
            "map.url_placeholders",
            "{z}, {x}, {y} and {key} belong in the path or query, not in the scheme, host or port",
        ));
    }
    let Some(host) = url.host_str() else {
        return Err(field_error("urlTemplate", "map.url_invalid", "the address of the map images has no host")
            .param("maxChars", MAX_URL_CHARS));
    };
    // Plain http only to this machine, where nothing leaves it (a map server next to Kalzit).
    let https = url.scheme() == "https" || (url.scheme() == "http" && crate::mail::settings::is_loopback_host(host));
    if !https {
        return Err(field_error("urlTemplate", "map.url_not_https", "the address of the map images must be https"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(field_error(
            "urlTemplate",
            "map.url_credentials",
            "the address must not contain a user, password or fragment; use {key} and the access key",
        ));
    }
    let attribution = &source.attribution;
    if attribution.is_empty() {
        return Err(field_error(
            "attribution",
            "map.attribution_required",
            "without an attribution Kalzit must not show the map images",
        ));
    }
    if attribution.chars().count() > MAX_ATTRIBUTION_CHARS || has_control(attribution) {
        return Err(field_error("attribution", "map.attribution_invalid", "the attribution is too long")
            .param("maxChars", MAX_ATTRIBUTION_CHARS));
    }
    if source.max_zoom > MAX_ZOOM {
        return Err(
            field_error("maxZoom", "map.max_zoom_invalid", "the highest zoom level is 0 to 22").param("max", MAX_ZOOM)
        );
    }
    if !CACHE_MB.contains(&source.cache_max_mb) {
        return Err(field_error("cacheMaxMb", "map.cache_size_invalid", "the cache size is out of range")
            .param("min", CACHE_MB.start())
            .param("max", CACHE_MB.end()));
    }
    if !CACHE_DAYS.contains(&source.cache_ttl_days) {
        return Err(field_error("cacheTtlDays", "map.cache_ttl_invalid", "the cache duration is out of range")
            .param("min", CACHE_DAYS.start())
            .param("max", CACHE_DAYS.end()));
    }
    Ok(())
}

/// `check`, then the target rules that hold before any connection: not Kalzit itself, and a host
/// the data source target policy allows (checked again on every connection).
pub async fn check_target(state: &AppState, source: &TileSource) -> ApiResult<()> {
    check(source)?;
    let url = source.url(SAMPLE, Some("k")).expect("check found a URL");
    if crate::routes::ai::is_kalzit_itself(state, &url) {
        return Err(field_error("urlTemplate", "map.url_kalzit", "the address points at this Kalzit server"));
    }
    let policy = state.datasources.policy(state).await?;
    let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']');
    policy.precheck_host(host).map_err(|blocked| {
        ApiError::validation(blocked.0.message.clone())
            .with_field("urlTemplate")
            .with_reason(blocked.0.reason, blocked.0.params)
    })
}

/// A key the settings page sent: within its length, without control characters.
pub fn check_key(key: &str) -> ApiResult<()> {
    if key.chars().count() > MAX_KEY_CHARS || has_control(key) {
        return Err(field_error("key", "map.key_invalid", "the access key is too long or has control characters")
            .param("maxChars", MAX_KEY_CHARS));
    }
    Ok(())
}

/// The stored source and its version (`None` before the first save).
pub async fn load_stored<'e, E>(db: E) -> ApiResult<(Option<TileSource>, i64)>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row: Option<(String, i64)> = sqlx::query_as("SELECT value, version FROM server_settings WHERE key = $1")
        .bind(SETTINGS_KEY)
        .fetch_optional(db)
        .await?;
    let Some((value, version)) = row else { return Ok((None, 0)) };
    let parsed: Option<TileSource> =
        serde_json::from_str(&value).map_err(|e| ApiError::internal("reading the stored map image source", e))?;
    Ok((parsed, version))
}

pub async fn load_key(db: &sqlx::AnyPool, keyring: &Keyring) -> ApiResult<Option<Zeroizing<String>>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT key_id, nonce, ciphertext FROM server_secrets WHERE owner = $1 AND field = $2")
            .bind(SECRET_OWNER)
            .bind(KEY_FIELD)
            .fetch_optional(db)
            .await?;
    let Some((key_id, nonce, ciphertext)) = row else { return Ok(None) };
    let plain = keyring
        .decrypt(SECRET_OWNER, KEY_FIELD, &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("decrypting the access key of the map images", e))?;
    Ok(Some(plain))
}

/// Stores (`Some`) or removes (`None`) the access key inside the caller's transaction.
pub async fn store_key(conn: &mut sqlx::AnyConnection, keyring: &Keyring, key: Option<&str>) -> ApiResult<()> {
    sqlx::query("DELETE FROM server_secrets WHERE owner = $1 AND field = $2")
        .bind(SECRET_OWNER)
        .bind(KEY_FIELD)
        .execute(&mut *conn)
        .await?;
    if let Some(plain) = key.filter(|k| !k.is_empty()) {
        let blob = keyring.encrypt(SECRET_OWNER, KEY_FIELD, plain);
        sqlx::query("INSERT INTO server_secrets (owner, field, key_id, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5)")
            .bind(SECRET_OWNER)
            .bind(KEY_FIELD)
            .bind(&blob.key_id)
            .bind(&blob.nonce)
            .bind(&blob.ciphertext)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

/// The source in force with its key, read at most every `ACTIVE_TTL_MS` per process and again
/// right after a change here (`Map::forget`).
#[derive(Clone)]
pub struct Active {
    pub source: TileSource,
    pub key: Option<Zeroizing<String>>,
    /// The cache folder of this source (`cache::source_dir`).
    pub dir: String,
    /// The generation of the setting it was read in (`Map::generation`).
    pub generation: u64,
}

const ACTIVE_TTL_MS: i64 = 5_000;

/// Why the last fetch from the source failed, for the settings page; never with the key.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    pub reason: String,
    pub params: BTreeMap<String, String>,
    pub message: String,
    pub at: i64,
}

/// The running part: cache, limits and what is known about the source right now.
pub struct Map {
    pub cache: std::sync::Arc<TileCache>,
    /// Fetches from the source per signed-in person.
    pub users: RateLimiter,
    /// Fetches from the source per public link, all its visitors together.
    pub links: RateLimiter,
    fetches: std::sync::Arc<tokio::sync::Semaphore>,
    active: Mutex<Option<(i64, Option<Active>)>>,
    last_error: Mutex<Option<LastError>>,
    /// Failures in a row and the pause per requester (`user:<id>`, `link:<id>`).
    breakers: Mutex<HashMap<String, Breaker>>,
    /// Monotonic ms of the last fetch that failed for the source as a whole, until one succeeds.
    last_failure: Mutex<Option<i64>>,
    /// Counts the changes of the setting; the cache keeps the folder of the newest source only.
    generation: AtomicU64,
}

#[derive(Default)]
struct Breaker {
    failures: u32,
    /// Monotonic ms until which the source is left alone for this requester (0: not paused).
    paused_until: i64,
}

/// Whether the source said that it has no such image: an empty place on the map, not a failure.
pub fn is_missing(detail: &Detail) -> bool {
    detail.reason == "map.source_status"
        && matches!(detail.params.get("status").map(String::as_str), Some("404" | "410"))
}

/// Whether a failure says something about the source as a whole and counts towards a pause:
/// it could not be reached or did not answer in time, refused the key, or failed itself (5xx).
pub fn counts_as_failure(detail: &Detail) -> bool {
    match detail.reason {
        "map.source_failed" | "map.source_timeout" | "map.source_denied" => true,
        "map.source_status" => {
            detail.params.get("status").and_then(|s| s.parse::<u16>().ok()).is_some_and(|s| s >= 500)
        }
        _ => false,
    }
}

impl Default for Map {
    fn default() -> Self {
        Self {
            cache: std::sync::Arc::default(),
            users: RateLimiter::new(MAX_FETCHES_PER_VIEWER, RATE_WINDOW_SECS, Capacity::LARGE),
            links: RateLimiter::new(MAX_FETCHES_PER_VIEWER, RATE_WINDOW_SECS, Capacity::LARGE),
            fetches: std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_FETCHES)),
            active: Mutex::default(),
            last_error: Mutex::default(),
            breakers: Mutex::default(),
            last_failure: Mutex::default(),
            generation: AtomicU64::new(0),
        }
    }
}

impl Map {
    /// Drops what is remembered of the source (after a change of the setting).
    pub fn forget(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *self.active.lock_or_recover() = None;
        *self.last_error.lock_or_recover() = None;
        self.breakers.lock_or_recover().clear();
        *self.last_failure.lock_or_recover() = None;
    }

    /// Whether `who` should get map images right now: not while their fetches are paused, nor
    /// for `PAUSE_MS` after the source as a whole failed (unreachable, too slow, refusing the key,
    /// 5xx) without a success since. Maps then draw the outlines at once instead of waiting for
    /// every image to time out.
    pub fn available(&self, who: &str, mono_ms: i64) -> bool {
        let failed_lately = self.last_failure.lock_or_recover().is_some_and(|at| mono_ms - at < PAUSE_MS);
        !failed_lately && !self.paused(who, mono_ms)
    }

    /// The generation of the setting in force (see `forget`).
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub fn last_error(&self) -> Option<LastError> {
        self.last_error.lock_or_recover().clone()
    }

    /// Whether the source is left alone for `who` right now.
    fn paused(&self, who: &str, mono_ms: i64) -> bool {
        self.breakers.lock_or_recover().get(who).is_some_and(|b| mono_ms < b.paused_until)
    }

    /// Notes a failed fetch: why, for the settings page, and towards the pause of `who` when it
    /// says something about the source as a whole.
    fn failed(&self, who: &str, detail: &Detail, now_ms: i64, mono_ms: i64) {
        *self.last_error.lock_or_recover() = Some(LastError {
            reason: detail.reason.to_string(),
            params: detail.params.clone(),
            message: detail.message.clone(),
            at: now_ms,
        });
        if !counts_as_failure(detail) {
            return;
        }
        *self.last_failure.lock_or_recover() = Some(mono_ms);
        let mut breakers = self.breakers.lock_or_recover();
        if breakers.len() >= MAX_BREAKERS && !breakers.contains_key(who) {
            breakers.clear();
        }
        let breaker = breakers.entry(who.to_string()).or_default();
        breaker.failures += 1;
        if breaker.failures >= FAILURES_BEFORE_PAUSE {
            breaker.paused_until = mono_ms + PAUSE_MS;
            breaker.failures = 0;
        }
    }

    fn succeeded(&self, who: &str) {
        self.breakers.lock_or_recover().remove(who);
        *self.last_error.lock_or_recover() = None;
        *self.last_failure.lock_or_recover() = None;
    }
}

/// The source in force, or `None` while the map images are off.
pub async fn active(state: &AppState) -> ApiResult<Option<Active>> {
    let mono = state.clock.monotonic_ms();
    if let Some((at, active)) = state.map.active.lock_or_recover().as_ref()
        && mono - at < ACTIVE_TTL_MS
    {
        return Ok(active.clone());
    }
    // Taken before reading: a change while reading makes this answer the older one.
    let generation = state.map.generation();
    let (stored, _) = load_stored(&state.read_db).await?;
    let active = match stored.filter(|s| s.enabled) {
        Some(source) => {
            let key = if source.wants_key() { load_key(&state.db, &state.secrets).await? } else { None };
            let dir = cache::source_dir(&source.url_template);
            Some(Active { source, key, dir, generation })
        }
        None => None,
    };
    *state.map.active.lock_or_recover() = Some((mono, active.clone()));
    Ok(active)
}

/// When the URL's port is one of Kalzit's own listening ports, every address of this computer is
/// refused, whichever name points there: the map images never come from Kalzit itself.
fn local_guard(state: &AppState, url: &url::Url) -> Option<LocalGuard> {
    let port = url.port_or_known_default()?;
    let own = [state.config.http_addr(), state.config.https_addr()];
    own.iter().flatten().any(|l| l.port() == port).then(|| LocalGuard {
        refused: Detail::new("map.url_kalzit", "the address points at this Kalzit server"),
        private: None,
    })
}

/// One image as the source answered it.
pub struct Fetched {
    pub bytes: Vec<u8>,
    pub format: Format,
    pub elapsed_ms: u64,
    /// The request went through the outbound proxy.
    pub via_proxy: bool,
}

/// Fetches one image from the source: through the outbound proxy when one is set, to a checked
/// address, without following redirects, and only an image is taken. The failure never names the
/// key or the address with it.
pub async fn fetch(state: &AppState, source: &TileSource, key: Option<&str>, id: TileId) -> Result<Fetched, Detail> {
    let failed = |message: &str| Detail::new("map.source_failed", message.to_string());
    let Some(url) = source.url(id, key) else { return Err(failed("the address of the map images is not a URL")) };
    if crate::routes::ai::is_kalzit_itself(state, &url) {
        return Err(Detail::new("map.url_kalzit", "the address points at this Kalzit server"));
    }
    let policy = state.datasources.policy(state).await.map_err(|e| failed(&e.message))?;
    // Fails closed: when the proxy setting cannot be read, nothing goes out directly instead.
    let proxy = crate::outbound::current(state).await.map_err(|e| failed(&e.message))?;
    let via_proxy = proxy.as_ref().is_some_and(|p| !p.bypasses(&url));
    let client = crate::http::client_proxied(
        HttpOptions { timeout: FETCH_TIMEOUT, extra_root_pem: None, policy },
        local_guard(state, &url),
        proxy,
    )
    .map_err(|e| failed(&e.to_string()))?;
    let scrub = |detail: Detail| match key.filter(|k| !k.is_empty()) {
        Some(key) => detail.scrubbed(|s| s.replace(key, "[key]")),
        None => detail,
    };
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("image/png, image/jpeg, image/webp"));
    let started = std::time::Instant::now();
    let response =
        client.send_once(reqwest::Method::GET, url, headers, None).await.map_err(|e| scrub(http_detail(e)))?;
    let status = response.status();
    if status != reqwest::StatusCode::OK {
        let reason = match status.as_u16() {
            401 | 403 => "map.source_denied",
            _ => "map.source_status",
        };
        return Err(Detail::new(reason, format!("the source of the map images answered {}", status.as_u16()))
            .with("status", status.as_u16()));
    }
    let bytes = crate::http::read_limited(response, MAX_TILE_BYTES).await.map_err(|e| scrub(http_detail(e)))?;
    let Some(format) = Format::sniff(&bytes) else {
        return Err(Detail::new(
            "map.not_an_image",
            "the source answered something that is not a PNG, JPEG or WebP image",
        ));
    };
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    Ok(Fetched { bytes, format, elapsed_ms, via_proxy })
}

fn http_detail(e: HttpError) -> Detail {
    match e {
        HttpError::Timeout => Detail::new("map.source_timeout", "the source of the map images did not answer in time"),
        HttpError::TooLarge(max) => {
            Detail::new("map.tile_too_large", format!("the source answered more than {max} bytes"))
                .with("maxBytes", max)
        }
        HttpError::Other(message) => Detail::new("map.source_failed", message),
        other => other.detail(),
    }
}

/// Who asks for an image, for the limit of fetches from the source.
pub enum Viewer<'a> {
    User(&'a str),
    Link(&'a str),
}

/// Why an image is not served.
pub enum TileError {
    /// The map images are off, `(z, x, y)` is not an image of the source, or the source has no
    /// such image (`404`, `410`): an empty place on the map.
    NotFound,
    /// The viewer made Kalzit fetch too many images; the wait.
    Limited(Duration),
    /// The source did not deliver; maps fall back to the outlines.
    Unavailable,
    Internal(ApiError),
}

/// One image for a viewer: from the cache, else from the source and then kept.
pub async fn tile(state: &AppState, viewer: Viewer<'_>, id: TileId) -> Result<(Vec<u8>, Format), TileError> {
    let Some(active) = active(state).await.map_err(TileError::Internal)? else { return Err(TileError::NotFound) };
    if !in_range(id, active.source.max_zoom) {
        return Err(TileError::NotFound);
    }
    let map = &state.map;
    let data_dir = &state.config.paths.data_dir;
    let place = cache::Place { dir: &active.dir, generation: active.generation };
    let now = state.clock.now_ms();
    if let Some(hit) = map.cache.get(data_dir, place, id, now, active.source.cache_ttl_ms()).await {
        return Ok(hit);
    }
    let (limiter, who) = match viewer {
        Viewer::User(id) => (&map.users, format!("user:{id}")),
        Viewer::Link(id) => (&map.links, format!("link:{id}")),
    };
    let mono = state.clock.monotonic_ms();
    if map.paused(&who, mono) {
        return Err(TileError::Unavailable);
    }
    limiter.try_acquire(&who, &who, mono).map_err(TileError::Limited)?;
    let Ok(Ok(_slot)) = tokio::time::timeout(FETCH_SLOT_WAIT, map.fetches.clone().acquire_owned()).await else {
        return Err(TileError::Unavailable);
    };
    // Someone else may have fetched it while this request waited.
    if let Some(hit) = map.cache.get(data_dir, place, id, now, active.source.cache_ttl_ms()).await {
        return Ok(hit);
    }
    match fetch(state, &active.source, active.key.as_deref().map(|k| k.as_str()), id).await {
        Ok(fetched) => {
            map.succeeded(&who);
            let (bytes, format) = (fetched.bytes, fetched.format);
            map.cache.put(data_dir, place, id, bytes.clone(), format, now, active.source.cache_max_bytes()).await;
            Ok((bytes, format))
        }
        Err(detail) if is_missing(&detail) => Err(TileError::NotFound),
        Err(detail) => {
            tracing::info!("a map image could not be fetched: {}", detail.message);
            map.failed(&who, &detail, now, state.clock.monotonic_ms());
            Err(TileError::Unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> TileSource {
        TileSource {
            enabled: true,
            url_template: "https://karten.example.org/tiles/{z}/{x}/{y}.png".into(),
            attribution: "© Beispiel-Kartendienst und Mitwirkende".into(),
            max_zoom: 14,
            cache_max_mb: 2048,
            cache_ttl_days: 7,
        }
    }

    fn problem(source: TileSource) -> (String, String) {
        let e = check(&source).unwrap_err();
        (e.field.unwrap_or_default().to_string(), e.reason.map(|r| r.code.to_string()).unwrap_or_default())
    }

    #[test]
    fn a_complete_source_passes_and_defaults_fill_in() {
        check(&valid()).unwrap();
        let short: TileSource =
            serde_json::from_str(r#"{"urlTemplate":"https://a.example/{z}/{x}/{y}","attribution":"© A"}"#).unwrap();
        assert_eq!((short.enabled, short.max_zoom, short.cache_max_mb, short.cache_ttl_days), (true, 14, 2048, 7));
        check(&TileSource { url_template: "https://a.example/{z}/{x}/{y}?k={key}".into(), ..valid() }).unwrap();
        // A map server on this machine may speak plain http.
        check(&TileSource { url_template: "http://127.0.0.1:8080/{z}/{x}/{y}.png".into(), ..valid() }).unwrap();
        check(&TileSource { url_template: "http://localhost:8080/{z}/{x}/{y}.png".into(), ..valid() }).unwrap();
    }

    #[test]
    fn every_field_names_its_problem() {
        let with_url = |u: &str| TileSource { url_template: u.into(), ..valid() };
        assert_eq!(problem(with_url("")), ("urlTemplate".into(), "map.url_invalid".into()));
        assert_eq!(
            problem(with_url("https://k.example/{z}/{x}.png")),
            ("urlTemplate".into(), "map.url_placeholders".into())
        );
        assert_eq!(
            problem(with_url("https://{s}.k.example/{z}/{x}/{y}.png")),
            ("urlTemplate".into(), "map.url_placeholders".into())
        );
        assert_eq!(
            problem(with_url("https://k.example/{z}/{x}/{y")),
            ("urlTemplate".into(), "map.url_placeholders".into())
        );
        assert_eq!(
            problem(with_url("http://k.example/{z}/{x}/{y}")),
            ("urlTemplate".into(), "map.url_not_https".into())
        );
        assert_eq!(
            problem(with_url("ftp://k.example/{z}/{x}/{y}")),
            ("urlTemplate".into(), "map.url_not_https".into())
        );
        assert_eq!(
            problem(with_url("https://u:p@k.example/{z}/{x}/{y}")),
            ("urlTemplate".into(), "map.url_credentials".into())
        );
        assert_eq!(problem(with_url("{z}/{x}/{y}")), ("urlTemplate".into(), "map.url_invalid".into()));
        assert_eq!(
            problem(TileSource { attribution: String::new(), ..valid() }),
            ("attribution".into(), "map.attribution_required".into())
        );
        assert_eq!(
            problem(TileSource { attribution: "x".repeat(201), ..valid() }),
            ("attribution".into(), "map.attribution_invalid".into())
        );
        assert_eq!(problem(TileSource { max_zoom: 23, ..valid() }), ("maxZoom".into(), "map.max_zoom_invalid".into()));
        assert_eq!(
            problem(TileSource { cache_max_mb: 8, ..valid() }),
            ("cacheMaxMb".into(), "map.cache_size_invalid".into())
        );
        assert_eq!(
            problem(TileSource { cache_ttl_days: 0, ..valid() }),
            ("cacheTtlDays".into(), "map.cache_ttl_invalid".into())
        );
        assert!(check_key(&"k".repeat(513)).is_err());
        assert!(check_key("abc\n").is_err());
        check_key("pk.abc-123").unwrap();
    }

    #[test]
    fn placeholders_stay_out_of_the_scheme_host_and_port() {
        let with_url = |u: &str| TileSource { url_template: u.into(), ..valid() };
        for template in [
            "https://tiles{z}.example.org/{x}/{y}.png",
            "https://{x}.example.org/{z}/{y}.png",
            "https://example.org{key}/{z}/{x}/{y}.png",
            "https://example.org:8{z}/{x}/{y}.png",
            "https://example.org{key}@other.example/{z}/{x}/{y}.png",
        ] {
            assert_eq!(
                problem(with_url(template)),
                ("urlTemplate".into(), "map.url_placeholders".into()),
                "{template}"
            );
        }
        check(&with_url("https://example.org/{z}/{x}/{y}.png?key={key}")).unwrap();
        check(&with_url("https://example.org/tiles/{key}/{z}/{x}/{y}@2x.png")).unwrap();
    }

    #[test]
    fn only_failures_of_the_source_as_a_whole_count_and_only_for_their_requester() {
        let status = |s: u16| Detail::new("map.source_status", "answered").with("status", s);
        assert!(is_missing(&status(404)) && is_missing(&status(410)));
        assert!(!is_missing(&status(500)) && !is_missing(&status(302)));
        assert!(counts_as_failure(&status(503)));
        assert!(counts_as_failure(&Detail::new("map.source_timeout", "slow")));
        assert!(counts_as_failure(&Detail::new("map.source_denied", "no").with("status", 403u16)));
        assert!(!counts_as_failure(&status(404)) && !counts_as_failure(&status(302)));
        assert!(!counts_as_failure(&Detail::new("map.not_an_image", "html")));

        let map = Map::default();
        let broken = Detail::new("map.source_failed", "refused");
        for _ in 0..FAILURES_BEFORE_PAUSE {
            map.failed("user:a", &broken, 0, 1_000);
        }
        assert!(map.paused("user:a", 1_001), "the one whose fetches failed waits");
        assert!(!map.paused("user:b", 1_001), "everyone else still gets images");
        assert!(!map.paused("user:a", 1_000 + PAUSE_MS), "the pause ends");
        // A source that failed as a whole is not offered to anyone for a while.
        assert!(!map.available("user:b", 1_001));
        assert!(map.available("user:b", 1_000 + PAUSE_MS));
        // Images the source does not have do not pause anybody.
        for _ in 0..2 * FAILURES_BEFORE_PAUSE {
            map.failed("user:b", &Detail::new("map.not_an_image", "html"), 0, 1_000);
        }
        assert!(!map.paused("user:b", 1_001));
        map.failed("user:c", &broken, 0, 2_000);
        assert!(!map.available("user:b", 2_001));
        map.succeeded("user:b");
        assert!(map.last_error().is_none());
        assert!(map.available("user:b", 2_001), "a success makes the source available again");
        map.forget();
        assert!(!map.paused("user:a", 1_001));
    }

    #[test]
    fn images_outside_the_source_are_no_images() {
        assert!(in_range((0, 0, 0), 14));
        assert!(in_range((14, 16383, 16383), 14));
        assert!(!in_range((15, 0, 0), 14), "above the highest zoom level");
        assert!(!in_range((3, 8, 0), 14), "column 8 does not exist at zoom 3");
        assert!(!in_range((3, 0, 8), 14));
        assert!(!in_range((23, 0, 0), 30), "never above zoom 22");
    }

    #[test]
    fn the_key_is_encoded_and_only_reused_for_the_same_origin() {
        let source = TileSource { url_template: "https://a.example/{z}/{x}/{y}.png?key={key}".into(), ..valid() };
        let url = source.url((6, 33, 21), Some("a b&c=d")).unwrap();
        assert_eq!(url.as_str(), "https://a.example/6/33/21.png?key=a+b%26c%3Dd");
        assert!(source.wants_key() && !valid().wants_key());
        let moved = TileSource { url_template: "https://b.example/{z}/{x}/{y}.png?key={key}".into(), ..valid() };
        let same = TileSource { url_template: "https://a.example/v2/{z}/{x}/{y}.png?key={key}".into(), ..valid() };
        assert!(!source.same_origin(&moved));
        assert!(source.same_origin(&same));
        assert_eq!(valid().test_tile(), (6, 33, 21));
        assert_eq!(TileSource { max_zoom: 2, ..valid() }.test_tile(), (2, 2, 1));
    }
}
