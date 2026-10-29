//! The plugin catalog, host side (docs/api/plugins.md, "Catalog"): a signed index of plugins
//! hosted by the project or a mirror, off by default. Turned on, Kalzit itself loads the index
//! (never a plugin) through the one HTTP client with the data source target rules, a time limit
//! and a size limit, checks its signature against the keys trusted for plugins, its sequence (no
//! rollback) and its expiry, and keeps it in `plugin_catalog` (migration 0024). A package chosen
//! from the index is downloaded, compared with the entry (size, SHA-256, id, version, signing key)
//! and then installed through exactly the path of an uploaded file (`PluginHost::install`):
//! the same checks, the same approval of network targets, the same sandbox.
//!
//! Settings (`settings::REGISTRY`): `plugins.catalog_enabled`, `plugins.catalog_url` (no default
//! host) and `plugins.catalog_refresh_hours`. While the catalog is off, nothing connects.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::RwLock;
use std::time::Duration;

use ed25519_dalek::{Signature, VerifyingKey};
use kalzit_plugin_api::catalog::{self, Accepted, CatalogEntry, CatalogIndex};
use kalzit_plugin_api::signing::{self, Signer};
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::host::Actor;
use super::package::{self, MAX_PACKAGE_BYTES, TrustedKey};
use super::store::{self, PluginRow};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::datasources::Detail;
use crate::error::{ApiError, ApiResult};
use crate::http::{self, HttpClient, HttpError, HttpOptions, LocalGuard};

/// The time limit of each request for the index and for its signature.
pub const INDEX_TIMEOUT: Duration = Duration::from_secs(30);
/// The time limit of one package download.
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The largest signature file accepted.
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
/// Redirects followed per request; each hop is checked like the first.
const MAX_REDIRECTS: usize = 5;
/// How often the background loop looks whether a refresh is due.
const TICK: Duration = Duration::from_secs(5 * 60);
/// After a failed refresh, the next try comes after this long at the latest.
const RETRY_MS: i64 = 3600 * 1000;

pub const ENABLED: &str = "plugins.catalog_enabled";
pub const URL: &str = "plugins.catalog_url";
pub const REFRESH_HOURS: &str = "plugins.catalog_refresh_hours";

/// Why the catalog refused or failed something: a reason code (`catalog.*`, or a `target.*`
/// reason of the target rules), its parameters and an English text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub reason: String,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl Failure {
    fn new(reason: &str, message: impl Into<String>) -> Self {
        Self { reason: reason.to_string(), params: BTreeMap::new(), message: message.into() }
    }

    fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    fn from_index(e: &catalog::CatalogError) -> Self {
        let failure = Self::new(e.code(), e.to_string());
        match e {
            catalog::CatalogError::Rollback { sequence, accepted } => {
                failure.with("sequence", sequence).with("accepted", accepted)
            }
            catalog::CatalogError::Expired { expires_at } => failure.with("expiresAt", expires_at * 1000),
            catalog::CatalogError::FormatUnsupported(v) => failure.with("format", v),
            catalog::CatalogError::Entry { index, reason } | catalog::CatalogError::Revocation { index, reason } => {
                failure.with("index", index).with("field", reason)
            }
            _ => failure,
        }
    }

    fn from_http(e: &HttpError, reason: &str) -> Self {
        match e {
            HttpError::Blocked(b) => {
                Self { reason: b.0.reason.to_string(), params: b.0.params.clone(), message: b.0.message.clone() }
            }
            HttpError::Refused(d) => {
                Self { reason: d.reason.to_string(), params: d.params.clone(), message: d.message.clone() }
            }
            HttpError::TooLarge(max) => Self::new("catalog.too_large", e.to_string()).with("bytes", max),
            other => Self::new(reason, other.to_string()).with("detail", other),
        }
    }

    /// The API error: `409` for a state that refuses the step, `404` for an unknown entry,
    /// `502` when the catalog or a package could not be fetched, `422` otherwise.
    pub fn api(&self) -> ApiError {
        use axum::http::StatusCode;
        let (status, code) = match self.reason.as_str() {
            "catalog.entry_unknown" => return ApiError::not_found(),
            "catalog.disabled"
            | "catalog.url_missing"
            | "catalog.not_loaded"
            | "catalog.entry_revoked"
            | "catalog.key_changed" => (StatusCode::CONFLICT, "conflict"),
            "catalog.unreachable" | "catalog.download_failed" => (StatusCode::BAD_GATEWAY, "datasource_error"),
            "catalog.private_target" | "catalog.own_address" => {
                (StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked")
            }
            r if r.starts_with("target.") => (StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked"),
            // The index's own refusals (`kalzit_plugin_api::catalog::CatalogError::code`).
            "catalog.too_large"
            | "catalog.invalid"
            | "catalog.format_unsupported"
            | "catalog.rollback"
            | "catalog.expired"
            | "catalog.times_implausible"
            | "catalog.entry_invalid"
            | "catalog.revocation_invalid" => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
            _ => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
        };
        ApiError::new(status, code, self.message.clone()).with_reason_string(self.reason.clone(), self.params.clone())
    }
}

/// The highest sequences taken: per catalog key (`catalog::Accepted`), and per catalog address
/// whatever key signed it, so a rotation to another key cannot bring back an older list.
#[derive(Clone, Debug, Default, Serialize, serde::Deserialize)]
struct Sequences {
    keys: Accepted,
    urls: BTreeMap<String, u64>,
}

/// What `plugin_catalog` holds.
#[derive(Clone, Debug, Default)]
struct Saved {
    accepted: Sequences,
    source_url: Option<String>,
    index_json: Option<String>,
    key_hex: Option<String>,
    fetched_at: Option<i64>,
    checked_at: Option<i64>,
    attempted_at: Option<i64>,
    error: Option<(Failure, i64)>,
}

type SavedRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

async fn load(db: &sqlx::AnyPool) -> ApiResult<Saved> {
    let row: Option<SavedRow> = sqlx::query_as(
        "SELECT accepted, source_url, index_json, key_hex, fetched_at, checked_at, attempted_at, \
         error_reason, error_message, error_params, error_at FROM plugin_catalog WHERE id = 'server'",
    )
    .fetch_optional(db)
    .await?;
    let Some((
        accepted,
        source_url,
        index_json,
        key_hex,
        fetched_at,
        checked_at,
        attempted_at,
        reason,
        message,
        params,
        at,
    )) = row
    else {
        return Ok(Saved::default());
    };
    let accepted = serde_json::from_str(&accepted).map_err(|e| ApiError::internal("plugin catalog", e))?;
    let error = match (reason, at) {
        (Some(reason), Some(at)) => {
            let params = params.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_default();
            Some((Failure { reason, params, message: message.unwrap_or_default() }, at))
        }
        _ => None,
    };
    Ok(Saved { accepted, source_url, index_json, key_hex, fetched_at, checked_at, attempted_at, error })
}

async fn save(db: &sqlx::AnyPool, s: &Saved) -> ApiResult<()> {
    let accepted = serde_json::to_string(&s.accepted).map_err(|e| ApiError::internal("plugin catalog", e))?;
    let (reason, message, params, at) = match &s.error {
        Some((f, at)) => (
            Some(f.reason.clone()),
            Some(f.message.clone()),
            Some(serde_json::to_string(&f.params).unwrap_or_default()),
            Some(*at),
        ),
        None => (None, None, None, None),
    };
    let mut tx = crate::db::begin(db).await?;
    sqlx::query(
        "INSERT INTO plugin_catalog (id, accepted, source_url, index_json, key_hex, fetched_at, checked_at, \
         attempted_at, error_reason, error_message, error_params, error_at) \
         VALUES ('server', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO UPDATE SET \
         accepted = excluded.accepted, source_url = excluded.source_url, index_json = excluded.index_json, \
         key_hex = excluded.key_hex, fetched_at = excluded.fetched_at, checked_at = excluded.checked_at, \
         attempted_at = excluded.attempted_at, error_reason = excluded.error_reason, \
         error_message = excluded.error_message, error_params = excluded.error_params, error_at = excluded.error_at",
    )
    .bind(accepted)
    .bind(s.source_url.as_deref())
    .bind(s.index_json.as_deref())
    .bind(s.key_hex.as_deref())
    .bind(s.fetched_at)
    .bind(s.checked_at)
    .bind(s.attempted_at)
    .bind(reason)
    .bind(message)
    .bind(params)
    .bind(at)
    .execute(&mut *tx)
    .await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// The catalog settings as they are now.
struct Config {
    enabled: bool,
    url: String,
    refresh_hours: i64,
}

async fn config(state: &AppState) -> ApiResult<Config> {
    let enabled = crate::settings::get(state, ENABLED).await?.as_bool().unwrap_or(false);
    let url = crate::settings::get(state, URL).await?.as_str().unwrap_or_default().trim().to_string();
    let refresh_hours = crate::settings::get(state, REFRESH_HOURS).await?.as_i64().unwrap_or(24).max(1);
    Ok(Config { enabled, url, refresh_hours })
}

/// The index of `saved` when it was taken from `url`.
fn index_of(saved: &Saved, url: &str) -> Option<CatalogIndex> {
    if saved.source_url.as_deref() != Some(url) {
        return None;
    }
    serde_json::from_str(saved.index_json.as_deref()?).ok()
}

/// The signature's address: the index's path with `.sig` appended (its query kept, no fragment).
fn signature_url(url: &str) -> Result<String, Failure> {
    let mut parsed =
        Url::parse(url).map_err(|e| Failure::new("catalog.url_invalid", format!("{url} is not a URL: {e}")))?;
    let path = format!("{}.sig", parsed.path());
    parsed.set_path(&path);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

/// Unix seconds of the index as the API's milliseconds.
fn millis(secs: u64) -> i64 {
    i64::try_from(secs).unwrap_or(i64::MAX / 1000).saturating_mul(1000)
}

fn key_from_hex(text: &str) -> Option<VerifyingKey> {
    VerifyingKey::from_bytes(&<[u8; 32]>::try_from(hex::decode(text).ok()?).ok()?).ok()
}

/// The catalog of this server: settings live in the registry, the index in the database.
#[derive(Default)]
pub struct Catalog {
    /// One refresh at a time.
    refreshing: tokio::sync::Mutex<()>,
    /// One package download at a time.
    installing: tokio::sync::Mutex<()>,
    /// Root certificates trusted in addition to the platform's, for the catalog's HTTPS (tests
    /// serve a local catalog with a certificate of their own).
    extra_root_pem: RwLock<Option<String>>,
}

impl Catalog {
    /// Trusts `pem` for the catalog's HTTPS in addition to the platform's store (tests).
    pub fn set_extra_root(&self, pem: Option<String>) {
        *self.extra_root_pem.write().unwrap_or_else(|e| e.into_inner()) = pem;
    }

    /// The clients of one catalog operation for the configured address `url` (see `Clients`).
    async fn clients(&self, state: &AppState, url: &str, timeout: Duration) -> Result<Clients, Failure> {
        let policy =
            state.datasources.policy(state).await.map_err(|e| Failure::new("catalog.unreachable", e.message))?;
        let parsed =
            Url::parse(url).map_err(|e| Failure::new("catalog.url_invalid", format!("{url} is not a URL: {e}")))?;
        let host = parsed.host_str().unwrap_or_default().trim_matches(['[', ']']).to_string();
        let port = parsed.port_or_known_default().unwrap_or(443);
        let private = || {
            Detail::new("catalog.private_target", "the catalog may reach only public addresses outside its own host")
        };
        let public_only = LocalGuard { refused: private(), private: Some(private()) };
        // The configured host itself: an administrator may point it at a private mirror (its
        // addresses decide), but never at Kalzit's own listening ports.
        let own_ports: Vec<u16> =
            [state.config.http_addr(), state.config.https_addr()].into_iter().flatten().map(|a| a.port()).collect();
        let resolved = policy
            .resolve_all(&host, port)
            .await
            .map_err(|e| Failure::from_http(&HttpError::from(e), "catalog.unreachable"))?;
        let home_private = resolved.iter().any(|a| LocalGuard::is_private(a.ip()));
        let home_guard = if !home_private {
            Some(public_only.clone())
        } else if own_ports.contains(&port) {
            Some(LocalGuard {
                refused: Detail::new("catalog.own_address", "the catalog address points at this Kalzit server"),
                private: None,
            })
        } else {
            None
        };
        let extra_root_pem = self.extra_root_pem.read().unwrap_or_else(|e| e.into_inner()).clone();
        let build = |guard: Option<LocalGuard>| {
            http::client_guarded(
                HttpOptions { timeout, extra_root_pem: extra_root_pem.clone(), policy: policy.clone() },
                guard,
            )
            .map_err(|e| Failure::new("catalog.unreachable", e.to_string()).with("detail", e))
        };
        Ok(Clients { home: build(home_guard)?, public: build(Some(public_only))?, host, port })
    }

    /// One GET over HTTPS with the platform named and nothing else of Kalzit's. Redirects are
    /// followed here, each hop over HTTPS and with the client its host calls for.
    async fn get(clients: &Clients, url: &str, reason: &str) -> Result<reqwest::Response, Failure> {
        let mut url =
            Url::parse(url).map_err(|e| Failure::new("catalog.url_invalid", format!("{url} is not a URL: {e}")))?;
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json, application/octet-stream"));
        if let Some(platform) = super::platform() {
            headers.insert("x-kalzit-platform", HeaderValue::from_static(platform));
        }
        for _ in 0..=MAX_REDIRECTS {
            if url.scheme() != "https" {
                return Err(Failure::new(
                    "catalog.https_required",
                    "the catalog and its packages are loaded over HTTPS only",
                )
                .with("host", url.host_str().unwrap_or_default()));
            }
            let response = clients
                .for_url(&url)
                .send_once(Method::GET, url.clone(), headers.clone(), None)
                .await
                .map_err(|e| Failure::from_http(&e, reason))?;
            if response.status().is_redirection()
                && let Some(location) = response.headers().get(reqwest::header::LOCATION).and_then(|l| l.to_str().ok())
            {
                url = url
                    .join(location)
                    .map_err(|e| Failure::new("catalog.url_invalid", format!("invalid redirect target: {e}")))?;
                continue;
            }
            if !response.status().is_success() {
                let status = response.status().as_u16();
                return Err(Failure::new(reason, format!("the server answered {status}")).with("detail", status));
            }
            return Ok(response);
        }
        Err(Failure::new(reason, format!("more than {MAX_REDIRECTS} redirects")).with("detail", "redirects"))
    }

    /// Loads the index and its signature, checks them and keeps the index. The result of the try
    /// (the new state, or the failure) is stored; a failure keeps the index taken before.
    ///
    /// The key that signed the list taken from this address is pinned: a list signed by another
    /// trusted key is refused (`catalog.key_changed`) until an administrator confirms the change
    /// with `accept_key_change`.
    pub async fn refresh(&self, state: &AppState, actor: Option<&Actor<'_>>, accept_key_change: bool) -> ApiResult<()> {
        let _one = self.refreshing.lock().await;
        let cfg = config(state).await?;
        if !cfg.enabled {
            return Err(Failure::new("catalog.disabled", "the catalog is turned off").api());
        }
        if cfg.url.is_empty() {
            return Err(Failure::new("catalog.url_missing", "the catalog has no address yet").api());
        }
        let now = state.clock.now_ms();
        let mut saved = load(&state.db).await?;
        let trusted = catalog_keys(state).await?;
        let outcome = self.fetch(state, &cfg.url, &trusted, &saved, now, accept_key_change).await;
        saved.attempted_at = Some(now);
        let summary = match outcome {
            Ok(Fetched { bytes, key, index, changed }) => {
                if changed {
                    saved.accepted.keys.record(&key, &index);
                    let url_seq = saved.accepted.urls.entry(cfg.url.clone()).or_insert(index.sequence);
                    *url_seq = (*url_seq).max(index.sequence);
                    saved.index_json = Some(String::from_utf8_lossy(&bytes).into_owned());
                    saved.key_hex = Some(signing::key_hex(&key));
                    saved.source_url = Some(cfg.url.clone());
                    saved.fetched_at = Some(now);
                }
                saved.checked_at = Some(now);
                saved.error = None;
                save(&state.db, &saved).await?;
                Ok(json!({ "sequence": index.sequence, "plugins": index.plugins.len(), "changed": changed }))
            }
            Err(f) => {
                tracing::warn!(reason = %f.reason, "the plugin catalog was not taken: {}", f.message);
                saved.error = Some((f.clone(), now));
                save(&state.db, &saved).await?;
                Err(f)
            }
        };
        if let Some(actor) = actor {
            let at = state.clock.now_ms();
            let host = Url::parse(&cfg.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
            let mut body = match &summary {
                Ok(s) => s.clone(),
                Err(f) => json!({ "reason": f.reason }),
            };
            body["host"] = json!(host);
            record(state, actor, "plugins.catalog_refreshed", "catalog", body, at).await?;
        }
        summary.map(|_| ()).map_err(|f| f.api())
    }

    async fn fetch(
        &self,
        state: &AppState,
        url: &str,
        trusted: &[TrustedKey],
        saved: &Saved,
        now: i64,
        accept_key_change: bool,
    ) -> Result<Fetched, Failure> {
        let client = self.clients(state, url, INDEX_TIMEOUT).await?;
        let response = Self::get(&client, url, "catalog.unreachable").await?;
        let bytes = http::read_limited(response, catalog::MAX_INDEX_BYTES)
            .await
            .map_err(|e| Failure::from_http(&e, "catalog.unreachable"))?;
        let sig_url = signature_url(url)?;
        let signature = match Self::get(&client, &sig_url, "catalog.unreachable").await {
            Ok(r) => http::read_limited(r, MAX_SIGNATURE_BYTES)
                .await
                .map_err(|e| Failure::from_http(&e, "catalog.unreachable"))?,
            Err(f) if f.params.get("detail").map(String::as_str) == Some("404") => {
                return Err(Failure::new(
                    "catalog.signature_missing",
                    "the catalog has no signature next to it (.sig)",
                ));
            }
            Err(f) => return Err(f),
        };
        let key = verify(&bytes, &signature, trusted)?;
        // The key of this address is pinned; another one needs the administrator's confirmation.
        if let Some(pinned) = saved.key_hex.as_deref().filter(|_| saved.source_url.as_deref() == Some(url))
            && pinned != signing::key_hex(&key)
            && !accept_key_change
        {
            let previous = key_from_hex(pinned).map(|k| signing::key_id(&k)).unwrap_or_default();
            return Err(Failure::new(
                "catalog.key_changed",
                "the catalog list is signed by another key than before; confirm the change to take it",
            )
            .with("keyId", signing::key_id(&key))
            .with("previousKeyId", previous));
        }
        let now_secs = u64::try_from(now / 1000).unwrap_or_default();
        // The index taken before, served again unchanged: still valid only until it expires.
        if saved.source_url.as_deref() == Some(url)
            && saved.index_json.as_deref().map(str::as_bytes) == Some(bytes.as_slice())
            && saved.key_hex.as_deref() == Some(signing::key_hex(&key).as_str())
            && let Some(index) = index_of(saved, url)
        {
            if now_secs >= index.expires_at {
                return Err(Failure::from_index(&catalog::CatalogError::Expired { expires_at: index.expires_at }));
            }
            return Ok(Fetched { bytes, key, index, changed: false });
        }
        let index =
            catalog::parse_index(&bytes, &key, &saved.accepted.keys, now_secs).map_err(|e| Failure::from_index(&e))?;
        // Per address too, whatever key signed it: a rotation cannot bring back an older list.
        if let Some(&accepted) = saved.accepted.urls.get(url)
            && index.sequence <= accepted
        {
            return Err(Failure::from_index(&catalog::CatalogError::Rollback { sequence: index.sequence, accepted }));
        }
        Ok(Fetched { bytes, key, index, changed: true })
    }

    /// One run of the background loop: a refresh when the catalog is on and one is due.
    pub async fn tick(&self, state: &AppState) {
        let Ok(cfg) = config(state).await else { return };
        if !cfg.enabled || cfg.url.is_empty() {
            return;
        }
        let Ok(saved) = load(&state.db).await else { return };
        let now = state.clock.now_ms();
        let interval = cfg.refresh_hours * 3600 * 1000;
        let due = match (saved.source_url.as_deref() == Some(cfg.url.as_str()), saved.checked_at, saved.attempted_at) {
            (_, _, None) => true,
            (true, Some(checked), Some(attempted)) if attempted <= checked => now - checked >= interval,
            (_, _, Some(attempted)) => now - attempted >= interval.min(RETRY_MS),
        };
        if due && let Err(e) = self.refresh(state, None, false).await {
            tracing::debug!("the plugin catalog was not refreshed: {}", e.message);
        }
    }

    /// The catalog as the administrator sees it, filtered by `query` (name, id, description,
    /// publisher) and `kind`.
    pub async fn view(&self, state: &AppState, query: &str, kind: Option<&str>) -> ApiResult<CatalogView> {
        let cfg = config(state).await?;
        let settings = SettingsView {
            enabled: setting(state, ENABLED).await?,
            url: setting(state, URL).await?,
            refresh_hours: setting(state, REFRESH_HOURS).await?,
        };
        let mut view = CatalogView {
            state: "off",
            settings,
            index: None,
            last_error: None,
            checked_at: None,
            items: vec![],
            counts: Counts::default(),
            revoked: vec![],
        };
        if !cfg.enabled {
            return Ok(view);
        }
        if cfg.url.is_empty() {
            view.state = "unconfigured";
            return Ok(view);
        }
        let saved = load(&state.db).await?;
        view.last_error =
            saved.error.as_ref().filter(|(_, at)| saved.checked_at.is_none_or(|c| *at >= c)).map(|(f, at)| ErrorView {
                reason: f.reason.clone(),
                message: f.message.clone(),
                params: f.params.clone(),
                at: *at,
            });
        let Some(index) = index_of(&saved, &cfg.url) else {
            view.state = if view.last_error.is_some() { "unreachable" } else { "not_loaded" };
            return Ok(view);
        };
        view.checked_at = saved.checked_at;
        let now_secs = u64::try_from(state.clock.now_ms() / 1000).unwrap_or_default();
        let trusted = state.plugins.trusted_keys(&state.db).await?;
        let signers = catalog_keys(state).await?;
        let signer_trusted =
            saved.key_hex.as_deref().and_then(key_from_hex).is_some_and(|k| signers.iter().any(|t| t.key == k));
        // A list whose key is trusted no more, or past its expiry, offers nothing to install.
        view.state = if !signer_trusted {
            "untrusted"
        } else if now_secs >= index.expires_at {
            "expired"
        } else {
            "ready"
        };
        let names = key_names(state, &trusted).await?;
        let signer = saved.key_hex.as_deref().and_then(key_from_hex);
        view.index = Some(IndexView {
            sequence: index.sequence,
            published_at: millis(index.published_at),
            expires_at: millis(index.expires_at),
            fetched_at: saved.fetched_at.unwrap_or_default(),
            key_id: signer.as_ref().map(signing::key_id).unwrap_or_default(),
            signer: signer.as_ref().and_then(|k| names.get(&signing::key_id(k)).cloned()),
            host: Url::parse(&cfg.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default(),
        });
        let installed = store::all(&state.db).await?;
        let (items, counts) = items(&index, &installed, &names, query, kind);
        view.items = items;
        view.counts = counts;
        view.revoked = index
            .revoked
            .iter()
            .map(|r| RevokedView {
                id: r.id.clone(),
                versions: r.versions.clone(),
                reason: r.reason.clone(),
                installed_version: installed.iter().find(|p| r.covers(&p.id, &p.version)).map(|p| p.version.clone()),
            })
            .collect();
        Ok(view)
    }

    /// Installs or updates `id` in `version` from the catalog: the package is downloaded,
    /// compared with its entry and then installed exactly like an uploaded file.
    pub async fn install(
        &self,
        state: &AppState,
        id: &str,
        version: &str,
        confirm_publisher_change: bool,
        actor: &Actor<'_>,
    ) -> ApiResult<PluginRow> {
        let _one = self.installing.lock().await;
        let checked = self.checked_entry(state, id, version).await;
        let (entry, client) = match checked {
            Ok(c) => c,
            Err(f) => return Err(self.refused(state, actor, id, version, f).await),
        };
        let upload = Upload(state.plugins.upload_path().map_err(|e| e.api())?);
        let check = async {
            download(&client, &entry, &upload.0).await?;
            let trusted = state
                .plugins
                .trusted_keys(&state.db)
                .await
                .map_err(|e| Failure::new("catalog.download_failed", e.message))?;
            compare(&upload.0, &entry, trusted).await
        };
        if let Err(f) = check.await {
            return Err(self.refused(state, actor, id, version, f).await);
        }
        // The index may have changed during the download (a withdrawal, its expiry, its key no
        // longer trusted): checked again right before the install, with the same entry.
        match self.checked_entry(state, id, version).await {
            Ok((again, _)) if again == entry => {}
            Ok(_) => {
                let f = Failure::new("catalog.package_mismatch", "the catalog entry changed during the download")
                    .with("field", "entry");
                return Err(self.refused(state, actor, id, version, f).await);
            }
            Err(f) => return Err(self.refused(state, actor, id, version, f).await),
        }
        let row = state.plugins.install(state, &upload.0, confirm_publisher_change, actor).await?;
        let host = Url::parse(&entry.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        let summary = json!({ "version": entry.version, "sha256": entry.sha256, "keyId": entry.key_id, "host": host });
        // The plugin is installed (and recorded as such by the host); a failed extra entry is logged.
        if let Err(e) = record(state, actor, "plugins.catalog_installed", &row.id, summary, state.clock.now_ms()).await
        {
            tracing::warn!(plugin = %row.id, "the catalog install could not be recorded: {}", e.message);
        }
        Ok(row)
    }

    /// The entry to install, from an index that is on, current and not expired, and not revoked.
    async fn checked_entry(
        &self,
        state: &AppState,
        id: &str,
        version: &str,
    ) -> Result<(CatalogEntry, Clients), Failure> {
        let internal = |e: ApiError| Failure::new("catalog.download_failed", e.message);
        let cfg = config(state).await.map_err(internal)?;
        if !cfg.enabled {
            return Err(Failure::new("catalog.disabled", "the catalog is turned off"));
        }
        if cfg.url.is_empty() {
            return Err(Failure::new("catalog.url_missing", "the catalog has no address yet"));
        }
        let saved = load(&state.db).await.map_err(internal)?;
        let index = index_of(&saved, &cfg.url)
            .ok_or_else(|| Failure::new("catalog.not_loaded", "the catalog has not been loaded yet"))?;
        let now_secs = u64::try_from(state.clock.now_ms() / 1000).unwrap_or_default();
        if now_secs >= index.expires_at {
            return Err(Failure::from_index(&catalog::CatalogError::Expired { expires_at: index.expires_at }));
        }
        // The key that signed the stored index must still be trusted.
        let trusted = catalog_keys(state).await.map_err(internal)?;
        let signer = saved.key_hex.as_deref().and_then(key_from_hex);
        if !signer.is_some_and(|k| trusted.iter().any(|t| t.key == k)) {
            let key_id = signer.as_ref().map(signing::key_id).unwrap_or_default();
            return Err(Failure::new(
                "catalog.signer_untrusted",
                format!("the catalog list is signed with key {key_id}, which this server no longer trusts"),
            )
            .with("keyId", key_id));
        }
        if let Some(r) = index.revocation(id, version) {
            return Err(Failure::new("catalog.entry_revoked", format!("{id} {version} was withdrawn: {}", r.reason))
                .with("reason", &r.reason));
        }
        let entry = index
            .plugins
            .iter()
            .find(|e| e.id == id && e.version == version)
            .cloned()
            .ok_or_else(|| Failure::new("catalog.entry_unknown", format!("the catalog has no {id} {version}")))?;
        if entry.size > MAX_PACKAGE_BYTES {
            return Err(Failure::new("catalog.too_large", "the package is larger than a plugin package may be")
                .with("bytes", MAX_PACKAGE_BYTES));
        }
        let client = self.clients(state, &cfg.url, DOWNLOAD_TIMEOUT).await?;
        Ok((entry, client))
    }

    /// A refused install from the catalog in the audit log, and its API error.
    async fn refused(&self, state: &AppState, actor: &Actor<'_>, id: &str, version: &str, f: Failure) -> ApiError {
        let summary = json!({ "reason": f.reason, "source": "catalog", "plugin": id, "version": version });
        if let Err(e) = record(state, actor, "plugins.install_refused", "package", summary, state.clock.now_ms()).await
        {
            tracing::warn!("the refused catalog install could not be recorded: {}", e.message);
        }
        f.api()
    }
}

struct Fetched {
    bytes: Vec<u8>,
    key: VerifyingKey,
    index: CatalogIndex,
    changed: bool,
}

/// The key among `trusted` whose signature over the index verifies. The signature file is JSON
/// like a plugin's: `{ "keyId", "signature" }` (base64).
fn verify(index: &[u8], signature: &[u8], trusted: &[TrustedKey]) -> Result<VerifyingKey, Failure> {
    let invalid = || Failure::new("catalog.signature_invalid", "the catalog's signature does not verify");
    let sig: kalzit_release::DetachedSignature = serde_json::from_slice(signature).map_err(|_| invalid())?;
    let raw = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, sig.signature.trim())
        .map_err(|_| invalid())?;
    let signature = Signature::from_slice(&raw).map_err(|_| invalid())?;
    let candidates: Vec<&TrustedKey> = trusted.iter().filter(|t| signing::key_id(&t.key) == sig.key_id).collect();
    if candidates.is_empty() {
        return Err(Failure::new(
            "catalog.signer_untrusted",
            format!("the catalog is signed with key {}, which this server does not trust", sig.key_id),
        )
        .with("keyId", &sig.key_id));
    }
    candidates
        .into_iter()
        .find(|t| signing::verify_catalog(&t.key, index, &signature))
        .map(|t| t.key)
        .ok_or_else(invalid)
}

/// Streams the entry's package into `target`: at most its size, and its SHA-256 must match.
async fn download(client: &Clients, entry: &CatalogEntry, target: &Path) -> Result<(), Failure> {
    let mut response = Catalog::get(client, &entry.url, "catalog.download_failed").await?;
    let mismatch = |field: &str| {
        Failure::new(
            "catalog.package_mismatch",
            format!("the downloaded package does not match its catalog entry ({field})"),
        )
        .with("field", field)
    };
    if response.content_length().is_some_and(|len| len > entry.size) {
        return Err(mismatch("size"));
    }
    let io = |e: std::io::Error| Failure::new("catalog.download_failed", e.to_string()).with("detail", e);
    let mut file = tokio::fs::File::create(target).await.map_err(io)?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    while let Some(chunk) =
        response.chunk().await.map_err(|e| Failure::from_http(&HttpError::from(e), "catalog.download_failed"))?
    {
        done += chunk.len() as u64;
        if done > entry.size {
            return Err(mismatch("size"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(io)?;
    }
    file.flush().await.map_err(io)?;
    drop(file);
    if done != entry.size {
        return Err(mismatch("size"));
    }
    if hex::encode(hasher.finalize()) != entry.sha256 {
        return Err(mismatch("sha256"));
    }
    Ok(())
}

/// The package must be the one the entry names: its id and version, signed (never unsigned
/// from the catalog) by a trusted key with the entry's key id. The full checks follow in
/// `PluginHost::install`.
async fn compare(archive: &Path, entry: &CatalogEntry, trusted: Vec<TrustedKey>) -> Result<(), Failure> {
    let path = archive.to_path_buf();
    let signed = tokio::task::spawn_blocking(move || package::read_from_zip(&path))
        .await
        .map_err(|e| Failure::new("catalog.download_failed", e.to_string()))?
        .map_err(host_failure)?;
    let mismatch = |field: &str| {
        Failure::new(
            "catalog.package_mismatch",
            format!("the downloaded package does not match its catalog entry ({field})"),
        )
        .with("field", field)
    };
    if signed.manifest.id != entry.id {
        return Err(mismatch("id"));
    }
    if signed.manifest.version != entry.version {
        return Err(mismatch("version"));
    }
    let verified = package::verify(&signed, &trusted, false).map_err(host_failure)?;
    if verified.key.as_ref().map(signing::key_id).as_deref() != Some(entry.key_id.as_str()) {
        return Err(mismatch("keyId"));
    }
    Ok(())
}

fn host_failure(e: super::HostError) -> Failure {
    Failure { reason: e.reason.to_string(), params: e.params, message: e.message }
}

/// The clients of one catalog operation. Requests to the configured host (and port) use `home`:
/// public addresses only, unless the administrator pointed the address at a private host, and
/// never Kalzit's own ports. Every other host (another package host, a redirect elsewhere) uses
/// `public`, which refuses loopback, private and link-local addresses. Both resolve names through
/// the target rules and connect to the address they checked.
struct Clients {
    home: HttpClient,
    public: HttpClient,
    host: String,
    port: u16,
}

impl Clients {
    fn for_url(&self, url: &Url) -> &HttpClient {
        let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
        if host.eq_ignore_ascii_case(&self.host) && url.port_or_known_default() == Some(self.port) {
            &self.home
        } else {
            &self.public
        }
    }
}

/// The keys that may sign the catalog index: Kalzit's own plugin keys, and the trusted publisher
/// keys an administrator explicitly allowed to (`may_sign_catalog`). Trusting a key for plugins
/// alone does not let it sign the catalog.
async fn catalog_keys(state: &AppState) -> ApiResult<Vec<TrustedKey>> {
    let trusted = state.plugins.trusted_keys(&state.db).await?;
    let allowed: Vec<(String,)> =
        sqlx::query_as("SELECT public_key FROM plugin_keys WHERE may_sign_catalog = 1").fetch_all(&state.db).await?;
    let allowed: Vec<VerifyingKey> = allowed.iter().filter_map(|(k,)| key_from_hex(k)).collect();
    Ok(trusted.into_iter().filter(|t| t.signer == Signer::Kalzit || allowed.contains(&t.key)).collect())
}

/// Whether the trusted publisher key `key_id` may sign the catalog.
pub async fn may_sign_catalog(db: &sqlx::AnyPool, key_id: &str) -> ApiResult<bool> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT may_sign_catalog FROM plugin_keys WHERE key_id = $1")
        .bind(key_id)
        .fetch_optional(db)
        .await?;
    Ok(row.is_some_and(|(v,)| v == 1))
}

/// Allows the trusted publisher key `key_id` to sign the catalog, or takes that back; recorded
/// as `plugins.key_catalog_allowed` or `plugins.key_catalog_disallowed`.
pub async fn set_may_sign_catalog(state: &AppState, key_id: &str, allowed: bool, actor: &Actor<'_>) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    let changed = sqlx::query("UPDATE plugin_keys SET may_sign_catalog = $1 WHERE key_id = $2")
        .bind(i64::from(allowed))
        .bind(key_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if changed == 0 {
        return Err(ApiError::not_found());
    }
    let action = if allowed { "plugins.key_catalog_allowed" } else { "plugins.key_catalog_disallowed" };
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(actor.user_id),
        actor_address: Some(actor.address.clone()),
        action,
        resource_type: Some("plugin"),
        resource_id: Some(key_id),
        summary: json!({ "keyId": key_id }),
        at_ms: state.clock.now_ms(),
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// Removes the downloaded package when the install ends, however it ends.
struct Upload(std::path::PathBuf);

impl Drop for Upload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn record(state: &AppState, actor: &Actor<'_>, action: &str, id: &str, summary: Value, at: i64) -> ApiResult<()> {
    let event = AuditEvent {
        org_id: None,
        actor_user_id: Some(actor.user_id),
        actor_address: Some(actor.address.clone()),
        action,
        resource_type: Some("plugin"),
        resource_id: Some(id),
        summary,
        at_ms: at,
    };
    let mut tx = crate::db::begin(&state.db).await?;
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// The names of the trusted keys by key id: `Kalzit` for Kalzit's own, the name an
/// administrator gave a publisher key.
async fn key_names(state: &AppState, trusted: &[TrustedKey]) -> ApiResult<BTreeMap<String, String>> {
    let mut names: BTreeMap<String, String> = trusted
        .iter()
        .filter(|t| t.signer == Signer::Kalzit)
        .map(|t| (signing::key_id(&t.key), "Kalzit".to_string()))
        .collect();
    for k in store::keys(&state.db).await? {
        names.entry(k.key_id).or_insert(k.name);
    }
    Ok(names)
}

/// The catalog's entries, newest offer per plugin, with what is installed here.
fn items(
    index: &CatalogIndex,
    installed: &[PluginRow],
    names: &BTreeMap<String, String>,
    query: &str,
    kind: Option<&str>,
) -> (Vec<ItemView>, Counts) {
    let parse = |v: &str| semver::Version::parse(v).ok();
    let query = query.trim().to_lowercase();
    let mut by_id: BTreeMap<&str, Vec<&CatalogEntry>> = BTreeMap::new();
    for e in &index.plugins {
        by_id.entry(e.id.as_str()).or_default().push(e);
    }
    let mut counts = Counts::default();
    let mut out = Vec::new();
    for (id, mut entries) in by_id {
        entries.sort_by_key(|e| std::cmp::Reverse(parse(&e.version)));
        // The newest version that is not withdrawn; when every version is, the newest one.
        let offer = entries.iter().find(|e| index.revocation(id, &e.version).is_none()).or(entries.first());
        let Some(offer) = offer.copied() else { continue };
        let text = format!(
            "{} {} {} {}",
            offer.name,
            offer.id,
            offer.description.as_deref().unwrap_or_default(),
            offer.publisher.as_deref().unwrap_or_default()
        )
        .to_lowercase();
        if !query.is_empty() && !text.contains(&query) {
            continue;
        }
        counts.all += 1;
        match offer.kind.as_str() {
            "panel" => counts.panel += 1,
            _ => counts.datasource += 1,
        }
        if kind.is_some_and(|k| k != offer.kind) {
            continue;
        }
        let here = installed.iter().find(|p| p.id == id);
        let revoked = index.revocation(id, &offer.version).map(|r| r.reason.clone());
        let installed_version = here.map(|p| p.version.clone());
        let pending_version = here.and_then(|p| p.pending.as_ref().map(|p| p.version.clone()));
        let key_name = names.get(&offer.key_id).cloned();
        let newest_here =
            [installed_version.as_deref(), pending_version.as_deref()].into_iter().flatten().filter_map(parse).max();
        let action = if revoked.is_some() {
            "revoked"
        } else if key_name.is_none() {
            "untrusted"
        } else {
            match (&newest_here, parse(&offer.version)) {
                (None, _) => "install",
                (Some(have), Some(offered)) if offered > *have => "update",
                _ if pending_version.as_deref() == Some(offer.version.as_str()) => "pending",
                _ => "installed",
            }
        };
        out.push(ItemView {
            id: offer.id.clone(),
            name: offer.name.clone(),
            version: offer.version.clone(),
            kind: offer.kind.clone(),
            description: offer.description.clone(),
            publisher: offer.publisher.clone(),
            key_id: offer.key_id.clone(),
            key_name,
            network: offer.network.clone(),
            size: offer.size,
            sha256: offer.sha256.clone(),
            url_host: Url::parse(&offer.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default(),
            installed_version: installed_version.clone(),
            pending_version,
            installed_revoked: installed_version
                .as_deref()
                .and_then(|v| index.revocation(id, v))
                .map(|r| r.reason.clone()),
            revoked,
            action,
        });
    }
    (out, counts)
}

async fn setting(state: &AppState, key: &'static str) -> ApiResult<SettingValue> {
    let def = crate::settings::find(key, crate::settings::Scope::Server)
        .ok_or_else(|| ApiError::internal("settings", format!("unknown setting {key}")))?;
    let e = crate::settings::effective(state, key).await?;
    Ok(SettingValue { editable: crate::settings::editable(def, &e), value: e.value, version: e.version })
}

/// Runs the catalog's refreshes until the server stops.
pub fn spawn_background(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        loop {
            state.catalog.tick(&state).await;
            tokio::select! {
                () = stopping.cancelled() => return,
                () = tokio::time::sleep(TICK) => {}
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingValue {
    value: Value,
    /// The stored version a change names (`PATCH /admin/settings/{key}`).
    version: i64,
    /// False when the environment or `kalzit.toml` sets it.
    editable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    enabled: SettingValue,
    url: SettingValue,
    refresh_hours: SettingValue,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexView {
    sequence: u64,
    published_at: i64,
    expires_at: i64,
    /// When this index was taken.
    fetched_at: i64,
    /// The key that signed it.
    key_id: String,
    /// `Kalzit` or the name of the trusted publisher key; absent when the key is trusted no more.
    #[serde(skip_serializing_if = "Option::is_none")]
    signer: Option<String>,
    host: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorView {
    reason: String,
    message: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    params: BTreeMap<String, String>,
    at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    id: String,
    name: String,
    version: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    publisher: Option<String>,
    key_id: String,
    /// `Kalzit` or the trusted publisher key's name; absent when nobody here trusts the key.
    #[serde(skip_serializing_if = "Option::is_none")]
    key_name: Option<String>,
    network: Vec<String>,
    size: u64,
    sha256: String,
    url_host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending_version: Option<String>,
    /// The offered version is withdrawn: why.
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked: Option<String>,
    /// The installed version is withdrawn: why.
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_revoked: Option<String>,
    /// `install`, `update`, `installed`, `pending` (the version waits for approval), `untrusted`
    /// (its key is not trusted here) or `revoked`.
    action: &'static str,
}

#[derive(Default, Serialize)]
pub struct Counts {
    all: usize,
    datasource: usize,
    panel: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevokedView {
    id: String,
    versions: String,
    reason: String,
    /// The installed version, when the revocation withdraws it.
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    /// `off`, `unconfigured` (on without an address), `not_loaded`, `unreachable` (no index could
    /// be taken), `untrusted` (its key is trusted no more), `expired` or `ready`.
    state: &'static str,
    settings: SettingsView,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<IndexView>,
    /// The last failed try, while no later check succeeded.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<ErrorView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked_at: Option<i64>,
    items: Vec<ItemView>,
    counts: Counts,
    revoked: Vec<RevokedView>,
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use kalzit_plugin_api::catalog::CatalogError;

    use super::*;

    /// Every refusal of the index answers `422 validation` with its own reason.
    #[test]
    fn index_refusals_keep_their_reason() {
        for e in [
            CatalogError::TooLarge,
            CatalogError::Invalid("x".into()),
            CatalogError::FormatUnsupported(2),
            CatalogError::Rollback { sequence: 4, accepted: 5 },
            CatalogError::Expired { expires_at: 1 },
            CatalogError::ImplausibleTimes,
            CatalogError::Entry { index: 0, reason: "url" },
            CatalogError::Revocation { index: 0, reason: "id" },
        ] {
            let api = Failure::from_index(&e).api();
            assert_eq!((api.status, api.code), (StatusCode::UNPROCESSABLE_ENTITY, "validation"), "{e}");
            assert_eq!(api.reason.as_ref().map(|r| r.code.as_str()), Some(e.code()));
        }
        let rollback = Failure::from_index(&CatalogError::Rollback { sequence: 4, accepted: 5 });
        assert_eq!((rollback.params["sequence"].as_str(), rollback.params["accepted"].as_str()), ("4", "5"));
        assert_eq!(Failure::new("catalog.entry_unknown", "x").api().status, StatusCode::NOT_FOUND);
        assert_eq!(Failure::new("catalog.disabled", "x").api().status, StatusCode::CONFLICT);
        assert_eq!(Failure::new("catalog.unreachable", "x").api().status, StatusCode::BAD_GATEWAY);
        assert_eq!(Failure::new("target.metadata_address", "x").api().code, "datasource_target_blocked");
    }

    fn entry(id: &str, version: &str, key_id: &str) -> CatalogEntry {
        CatalogEntry {
            id: id.into(),
            version: version.into(),
            kind: "datasource".into(),
            name: id.into(),
            key_id: key_id.into(),
            url: "https://plugins.example.dev/p".into(),
            sha256: "0".repeat(64),
            size: 1,
            description: None,
            publisher: None,
            network: vec![],
        }
    }

    fn installed(id: &str, version: &str) -> PluginRow {
        PluginRow {
            id: id.into(),
            name: id.into(),
            version: version.into(),
            kind: "datasource".into(),
            manifest: String::new(),
            signer: "publisher".into(),
            public_key: None,
            dir: String::new(),
            approved: true,
            enabled: true,
            pending: None,
            installed_at: 0,
            updated_at: 0,
        }
    }

    /// Per plugin the newest version that is not withdrawn, with what can be done with it here.
    #[test]
    fn items_offer_the_newest_version_and_what_to_do() {
        let key = "0011223344556677";
        let index = CatalogIndex {
            format: 1,
            sequence: 1,
            published_at: 0,
            expires_at: 1,
            plugins: vec![
                entry("dev.example.a", "1.0.0", key),
                entry("dev.example.a", "1.10.0", key),
                entry("dev.example.a", "1.9.0", key),
                entry("dev.example.b", "2.0.0", key),
                entry("dev.example.c", "1.0.0", "ffffffffffffffff"),
                entry("dev.example.d", "1.0.0", key),
                entry("dev.example.d", "1.1.0", key),
            ],
            revoked: vec![
                kalzit_plugin_api::catalog::Revocation {
                    id: "dev.example.d".into(),
                    versions: ">=1.1.0".into(),
                    reason: "bad".into(),
                },
                kalzit_plugin_api::catalog::Revocation {
                    id: "dev.example.b".into(),
                    versions: "*".into(),
                    reason: "gone".into(),
                },
            ],
        };
        let names = BTreeMap::from([(key.to_string(), "Example".to_string())]);
        let here = [installed("dev.example.a", "1.9.0"), installed("dev.example.d", "1.0.0")];
        let (offered, counts) = items(&index, &here, &names, "", None);
        let by_id: BTreeMap<&str, (&str, &str)> =
            offered.iter().map(|i| (i.id.as_str(), (i.version.as_str(), i.action))).collect();
        assert_eq!(by_id["dev.example.a"], ("1.10.0", "update"), "semver order, not text order");
        assert_eq!(by_id["dev.example.b"], ("2.0.0", "revoked"));
        assert_eq!(by_id["dev.example.c"], ("1.0.0", "untrusted"));
        assert_eq!(by_id["dev.example.d"], ("1.0.0", "installed"), "the withdrawn 1.1.0 is not offered");
        assert_eq!(counts.all, 4);
        let (found, _) = items(&index, &here, &names, "EXAMPLE.C", None);
        assert_eq!(found.len(), 1);
        let (panels, _) = items(&index, &here, &names, "", Some("panel"));
        assert!(panels.is_empty());
    }
}
