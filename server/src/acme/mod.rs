//! Automatic HTTPS certificates over ACME (RFC 8555): Let's Encrypt, its staging directory or any
//! other ACME directory, validated with HTTP-01 or TLS-ALPN-01 (RFC 8737) by this server itself
//! (docs/ARCHITECTURE.md, "HTTPS certificates"; guide docs/guide/https.md).
//!
//! The settings (`settings`) are one stored value (`tls.acme` in `server_settings`), saved in
//! one step after a connection check. With ACME on and no certificate files configured, the
//! HTTPS listener serves the certificates of `resolver`: the issued one, until then a temporary
//! self-signed one. A background task orders a certificate when none matches the settings and
//! renews it once two thirds of its lifetime have passed; a failed attempt is retried after
//! 5 minutes, then 15 minutes, 1, 3, 6 and every 12 hours. Every issue and every failure is in
//! the audit log. The account key and the certificate are stored encrypted (`store`).

#[cfg(test)]
mod api_tests;
pub mod issue;
pub mod resolver;
pub mod settings;
pub mod store;
pub mod transport;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde_json::json;

use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::config::Config;
use crate::locks::MutexExt;
use crate::secrets::Keyring;
pub use settings::{AcmeSettings, Challenge, Directory, FieldError};
use store::StoredCertificate;

/// The row in `server_settings` that holds the settings.
pub const SETTINGS_KEY: &str = "tls.acme";
/// Where HTTP-01 validations fetch their answer, on every listener (also the HTTP one that
/// otherwise redirects to HTTPS).
pub const CHALLENGE_ROUTE: &str = "/.well-known/acme-challenge/{token}";
/// Minutes until the next attempt after the 1st, 2nd, ... failure in a row; the last repeats.
const BACKOFF_MINUTES: [i64; 6] = [5, 15, 60, 180, 360, 720];
/// The background task looks again at least this often (a changed clock, a missed wake-up).
const MAX_SLEEP: Duration = Duration::from_secs(3600);
const DNS_TIMEOUT: Duration = Duration::from_secs(10);
/// A server that does not lead looks this often whether it leads now.
const NOT_LEADING_RECHECK: Duration = Duration::from_secs(10);
/// The claim of a certificate order among several servers (`cluster::leader_claim`): one at a
/// time, held for longer than an order can take (validation and issuing get 2 minutes each).
const ORDER_JOB: &str = "acme:order";
const ORDER_LEASE: Duration = Duration::from_secs(15 * 60);

/// Why an order failed or a check found a problem, with a reason the UI translates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl Failure {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Self {
        let message = message.into();
        let mut params = BTreeMap::new();
        params.insert("detail".to_string(), message.clone());
        Self { reason, params, message }
    }

    /// A warning or problem without the `detail` parameter.
    fn plain(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, params: BTreeMap::new(), message: message.into() }
    }

    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// ACME is off.
    Off,
    /// On, waiting for the first attempt or the next one.
    Waiting,
    /// An order is running.
    Working,
    /// The certificate matches the settings and is not due for renewal.
    Valid,
    /// The last attempt failed; the next one is planned.
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateView {
    pub domains: Vec<String>,
    pub issuer: String,
    pub not_before: i64,
    pub not_after: i64,
    pub issued_at: i64,
    pub directory_url: String,
    /// When the server orders the next one.
    pub renew_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
    pub at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub phase: Phase,
    pub certificate: Option<CertificateView>,
    pub next_attempt_at: Option<i64>,
    pub last_error: Option<LastError>,
    /// Failed attempts in a row.
    pub failures: u32,
    /// The certificate in use could not be stored (`acme.store_failed`); storing is retried.
    pub store_error: Option<LastError>,
}

/// What the server's configuration says about the listeners ACME needs.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerView {
    pub http_addr: Option<String>,
    pub https_addr: Option<String>,
    /// `tls.cert_file` is configured; ACME cannot be used then.
    pub certificate_files: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcmeView {
    pub settings: AcmeSettings,
    /// The stored version a save must name; 0 when never saved.
    pub version: i64,
    pub status: StatusView,
    pub server: ServerView,
}

/// The answer of a connection check.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    /// The CA's terms of service, from its directory.
    pub terms_of_service: Option<String>,
    /// Things that may keep validation from working, though the settings are valid.
    pub warnings: Vec<Failure>,
}

struct Runtime {
    settings: AcmeSettings,
    version: i64,
    certificate: Option<StoredCertificate>,
    working: bool,
    /// Ordered from the API: the next tick orders even when the certificate is not due.
    forced: bool,
    failures: u32,
    next_attempt_ms: Option<i64>,
    last_error: Option<LastError>,
    /// The certificate in use is not stored yet: the failed tries so far and when to try again
    /// (`retry_store`). Ordering goes on as usual meanwhile.
    store_retry: Option<(u32, i64)>,
    /// Why storing failed, shown next to the certificate.
    store_error: Option<LastError>,
}

pub struct Acme {
    /// What the HTTPS listener serves when no certificate files are configured.
    pub certificates: Arc<resolver::Certificates>,
    /// HTTP-01 answers: token to key authorization.
    http: Mutex<HashMap<String, String>>,
    runtime: Mutex<Runtime>,
    wake: tokio::sync::Notify,
    /// TLS-ALPN-01 answers this server serves for the leader's order (`sync_challenges`).
    shared_alpn: Mutex<HashSet<String>>,
    /// HTTP-01 tokens this server answers for the leader's order (`sync_challenges`).
    shared_http: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for Acme {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Acme").finish_non_exhaustive()
    }
}

/// The shared challenge answers (`acme_challenges`) as (kind, name, value), in a fixed order.
pub async fn challenge_rows(db: &sqlx::AnyPool) -> Result<Vec<(String, String, String)>, sqlx::Error> {
    sqlx::query_as("SELECT kind, name, value FROM acme_challenges ORDER BY kind, name").fetch_all(db).await
}

/// What the leader and the other servers compare to know that a server serves the shared
/// answers as they are now (`cluster::await_challenges`).
pub fn challenge_fingerprint(rows: &[(String, String, String)]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for (kind, name, value) in rows {
        hash.update(format!("{kind}\t{name}\t{value}\n").as_bytes());
    }
    hex::encode(hash.finalize())
}

/// When a certificate is renewed: once two thirds of its lifetime have passed (30 days before
/// the end of a 90-day certificate, 2 days before the end of a 6-day one).
pub fn renew_at(certificate: &StoredCertificate) -> i64 {
    let lifetime = (certificate.not_after_ms - certificate.not_before_ms).max(0);
    certificate.not_after_ms - lifetime / 3
}

/// Until when a certificate counts as new: a third of its lifetime after it was issued.
fn young_until(certificate: &StoredCertificate) -> i64 {
    let lifetime = (certificate.not_after_ms - certificate.not_before_ms).max(0);
    certificate.not_before_ms + lifetime / 3
}

/// An HTTP-01 token: base64url without padding (RFC 8555, section 8.3).
fn is_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 256
        && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn store_error(e: &anyhow::Error, at: i64) -> LastError {
    let message = format!("{e:#}");
    let mut params = BTreeMap::new();
    params.insert("detail".to_string(), message.clone());
    LastError { reason: "acme.store_failed", params, message, at }
}

fn backoff_ms(failures: u32) -> i64 {
    let index = (failures.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1);
    BACKOFF_MINUTES[index] * 60_000
}

impl Acme {
    /// The stored settings and certificate; problems with either are logged, not fatal: the
    /// server starts with what it has.
    pub async fn load(config: &Config, keyring: &Keyring, db: &sqlx::AnyPool) -> anyhow::Result<Self> {
        let (settings, version) = load_settings(db).await?;
        // On PostgreSQL another server may have ordered the certificate (`store::share`).
        if !config.database_url().starts_with("sqlite:")
            && let Err(e) = store::pull(db, &config.paths.data_dir).await
        {
            tracing::warn!("taking the certificate the other servers share: {e:#}");
        }
        let certificate = match store::load_certificate(&config.paths.data_dir, keyring) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("the stored HTTPS certificate cannot be used; a new one will be ordered: {e:#}");
                None
            }
        };
        let names = if settings.domains.is_empty() {
            public_host(config).into_iter().collect()
        } else {
            settings.domains.clone()
        };
        let certificates = Arc::new(resolver::Certificates::new(&names)?);
        let certificate = certificate.filter(|c| match certificates.set(&c.chain_pem, &c.key_pem) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("the stored HTTPS certificate cannot be used; a new one will be ordered: {e:#}");
                false
            }
        });
        let runtime = Runtime {
            settings,
            version,
            certificate,
            working: false,
            forced: false,
            failures: 0,
            next_attempt_ms: None,
            last_error: None,
            store_retry: None,
            store_error: None,
        };
        Ok(Self {
            certificates,
            http: Mutex::default(),
            runtime: Mutex::new(runtime),
            wake: tokio::sync::Notify::new(),
            shared_alpn: Mutex::default(),
            shared_http: Mutex::default(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock_or_recover()
    }

    fn lock_http(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.http.lock_or_recover()
    }

    pub fn add_http_challenge(&self, token: &str, key_authorization: &str) {
        self.lock_http().insert(token.to_string(), key_authorization.to_string());
    }

    pub fn remove_http_challenge(&self, token: &str) {
        self.lock_http().remove(token);
    }

    pub fn settings(&self) -> (AcmeSettings, i64) {
        let rt = self.lock();
        (rt.settings.clone(), rt.version)
    }

    /// Takes newly saved settings and looks at once whether a certificate is due.
    pub fn apply_saved(&self, settings: AcmeSettings, version: i64) {
        let mut rt = self.lock();
        if rt.settings != settings {
            rt.failures = 0;
            rt.next_attempt_ms = None;
            rt.last_error = None;
            // A certificate for the old settings is not worth storing any more.
            rt.store_retry = None;
            rt.store_error = None;
        }
        rt.settings = settings;
        rt.version = version;
        drop(rt);
        self.wake.notify_one();
    }

    /// Orders a certificate now, even when the current one is not due; false when an order is
    /// already running. Refused while ACME is off, while a failure's pause runs (the CA's rate
    /// limits count failures), and while the certificate in use is younger than a third of its
    /// lifetime and matches the settings (a renewal then only spends the CA's limits).
    pub fn request_renewal(&self, now_ms: i64) -> Result<bool, FieldError> {
        let mut rt = self.lock();
        if !rt.settings.enabled {
            return Err(FieldError::new("enabled", "acme.off", "ACME is off"));
        }
        if rt.working {
            return Ok(false);
        }
        if rt.next_attempt_ms.is_some_and(|at| at > now_ms) {
            return Err(FieldError::new(
                "enabled",
                "acme.renew_backoff",
                "the last attempt failed; the next one follows the pause, or change the settings",
            ));
        }
        if let Some(c) = &rt.certificate
            && !Self::needs_certificate(&rt, now_ms)
            && now_ms < young_until(c)
        {
            return Err(FieldError::new(
                "enabled",
                "acme.renew_too_soon",
                "the certificate in use is new; it is renewed when it is due",
            ));
        }
        rt.forced = true;
        drop(rt);
        self.wake.notify_one();
        Ok(true)
    }

    /// The certificate does not match the settings or is due for renewal.
    fn needs_certificate(rt: &Runtime, now_ms: i64) -> bool {
        match &rt.certificate {
            None => true,
            Some(c) => {
                let mut have = c.domains.clone();
                let mut want = rt.settings.domains.clone();
                have.sort();
                want.sort();
                c.directory_url != rt.settings.directory_url() || have != want || now_ms >= renew_at(c)
            }
        }
    }

    fn due(rt: &Runtime, now_ms: i64) -> bool {
        rt.settings.enabled
            && !rt.working
            && rt.next_attempt_ms.is_none_or(|at| now_ms >= at)
            && (rt.forced || Self::needs_certificate(rt, now_ms))
    }

    /// How long the background task may sleep before something can be due.
    fn sleep_for(&self, now_ms: i64) -> Duration {
        let rt = self.lock();
        if !rt.settings.enabled {
            return MAX_SLEEP;
        }
        if Self::due(&rt, now_ms) {
            return Duration::ZERO;
        }
        let renewal = rt.certificate.as_ref().map(renew_at);
        let store = rt.store_retry.map(|(_, at)| at);
        let next = [rt.next_attempt_ms, renewal, store].into_iter().flatten().min();
        match next {
            Some(at) => Duration::from_millis((at - now_ms).max(1000) as u64).min(MAX_SLEEP),
            None => MAX_SLEEP,
        }
    }

    pub fn view(&self, config: &Config, now_ms: i64) -> AcmeView {
        let rt = self.lock();
        let certificate = rt.certificate.as_ref().map(|c| CertificateView {
            domains: c.domains.clone(),
            issuer: c.issuer.clone(),
            not_before: c.not_before_ms,
            not_after: c.not_after_ms,
            issued_at: c.issued_at_ms,
            directory_url: c.directory_url.clone(),
            renew_at: renew_at(c),
        });
        let phase = if !rt.settings.enabled {
            Phase::Off
        } else if rt.working {
            Phase::Working
        } else if rt.last_error.is_some() {
            Phase::Failed
        } else if Self::needs_certificate(&rt, now_ms) {
            Phase::Waiting
        } else {
            Phase::Valid
        };
        AcmeView {
            settings: rt.settings.clone(),
            version: rt.version,
            status: StatusView {
                phase,
                certificate,
                next_attempt_at: rt.next_attempt_ms,
                last_error: rt.last_error.clone(),
                failures: rt.failures,
                store_error: rt.store_error.clone(),
            },
            server: server_view(config),
        }
    }

    /// Several servers on one database (`cluster`): copies the stored account and certificate
    /// into the database and tells the other servers. Nothing for a server alone.
    async fn share(&self, state: &AppState) -> anyhow::Result<()> {
        if !state.cluster.coordinated() {
            return Ok(());
        }
        // The copies and their announcement in one transaction (`cluster::record`).
        let mut tx = crate::db::begin(&state.db).await?;
        store::share(&mut tx, &state.config.paths.data_dir, state.clock.now_ms()).await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Acme).await?;
        crate::db::commit(tx).await?;
        Ok(())
    }

    /// Takes what another server changed: the saved settings and the certificate it ordered
    /// (`store::pull`), served from the next handshake on.
    pub async fn refresh_shared(&self, state: &AppState) {
        if !state.cluster.coordinated() {
            return;
        }
        match load_settings(&state.db).await {
            Ok((settings, version)) if version != self.settings().1 => self.apply_saved(settings, version),
            Ok(_) => {}
            Err(e) => tracing::warn!("reading the ACME settings another server saved: {e:#}"),
        }
        if let Err(e) = store::pull(&state.db, &state.config.paths.data_dir).await {
            tracing::warn!("taking the certificate the other servers share: {e:#}");
            return;
        }
        let certificate = match store::load_certificate(&state.config.paths.data_dir, &state.secrets) {
            Ok(Some(c)) => c,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!("the certificate another server shared cannot be used: {e:#}");
                return;
            }
        };
        let mut rt = self.lock();
        if rt.certificate.as_ref() == Some(&certificate) {
            return;
        }
        match self.certificates.set(&certificate.chain_pem, &certificate.key_pem) {
            Ok(()) => {
                tracing::info!(
                    "serving the HTTPS certificate another server ordered, valid until {}",
                    certificate.not_after_ms
                );
                rt.certificate = Some(certificate);
                rt.store_retry = None;
                rt.store_error = None;
            }
            Err(e) => tracing::warn!("the certificate another server shared cannot be served: {e:#}"),
        }
    }

    /// Serves the challenge answers of the leader's running order (`acme_challenges`), so the
    /// server the certificate authority reaches answers it: HTTP-01 answers go into this server's
    /// own token map, TLS-ALPN-01 answers into the resolver, both in memory, so a validation never
    /// waits for the database. Then confirms to the leader which answers this server serves
    /// (`cluster::ack_challenges`), which it waits for before the CA validates.
    pub async fn sync_challenges(&self, state: &AppState) {
        let rows = match challenge_rows(&state.db).await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("reading the challenge answers of the other servers: {e}");
                return;
            }
        };
        let fingerprint = challenge_fingerprint(&rows);
        {
            let mut tokens = self.shared_http.lock_or_recover();
            let mut http = self.lock_http();
            let wanted: HashSet<&str> =
                rows.iter().filter(|(kind, _, _)| kind == "http").map(|(_, token, _)| token.as_str()).collect();
            for gone in tokens.iter().filter(|t| !wanted.contains(t.as_str())) {
                http.remove(gone);
            }
            tokens.clear();
            for (_, token, answer) in rows.iter().filter(|(kind, _, _)| kind == "http") {
                if is_token(token) {
                    http.insert(token.clone(), answer.clone());
                    tokens.insert(token.clone());
                }
            }
        }
        {
            let mut served = self.shared_alpn.lock_or_recover();
            let wanted: HashSet<String> =
                rows.iter().filter(|(kind, _, _)| kind == "alpn").map(|(_, domain, _)| domain.clone()).collect();
            for gone in served.difference(&wanted) {
                self.certificates.remove_challenge(gone);
            }
            served.clear();
            for (_, domain, digest) in rows.into_iter().filter(|(kind, _, _)| kind == "alpn") {
                let Ok(digest) = hex::decode(&digest) else { continue };
                match self.certificates.add_challenge(&domain, &digest) {
                    Ok(()) => {
                        served.insert(domain);
                    }
                    Err(e) => tracing::warn!("answering the TLS-ALPN-01 challenge for {domain}: {e:#}"),
                }
            }
        }
        crate::cluster::ack_challenges(state, &fingerprint).await;
    }

    /// Stores a certificate that is served but could not be stored, once its pause is over; an
    /// order is not repeated for it, and renewing it when due goes on regardless.
    async fn retry_store(&self, state: &AppState, now: i64) {
        let (tries, certificate) = {
            let rt = self.lock();
            match rt.store_retry {
                Some((tries, at)) if !rt.working && now >= at => (tries, rt.certificate.clone()),
                _ => return,
            }
        };
        let Some(certificate) = certificate else { return };
        let stored = match store::save_certificate(&state.config.paths.data_dir, &state.secrets, &certificate) {
            Ok(()) => self.share(state).await,
            Err(e) => Err(e),
        };
        let mut rt = self.lock();
        match stored {
            Ok(()) => {
                rt.store_retry = None;
                rt.store_error = None;
            }
            Err(e) => {
                tracing::error!("the HTTPS certificate in use still cannot be stored: {e:#}");
                rt.store_retry = Some((tries + 1, now + backoff_ms(tries + 1)));
                rt.store_error = Some(store_error(&e, now));
            }
        }
    }

    /// Orders a certificate when one is due. Runs in the background task only.
    async fn tick(&self, state: &AppState) {
        // A new leader first takes what the previous one ordered and stored.
        self.refresh_shared(state).await;
        let now = state.clock.now_ms();
        self.retry_store(state, now).await;
        if !Self::due(&self.lock(), now) {
            return;
        }
        // Several servers: one order at a time across all of them, only while the lease holds in
        // the database (a leader that paused past its lease does not order on an old belief).
        if !crate::cluster::leader_claim(state, ORDER_JOB, Duration::ZERO, ORDER_LEASE).await {
            return;
        }
        let settings = {
            let mut rt = self.lock();
            if Self::due(&rt, now) {
                rt.working = true;
                Some(rt.settings.clone())
            } else {
                None
            }
        };
        let Some(settings) = settings else {
            crate::cluster::leader_done(state, ORDER_JOB).await;
            return;
        };
        tracing::info!(
            "ordering an HTTPS certificate for {} from {}",
            settings.domains.join(", "),
            settings.directory_url()
        );
        let cx = issue::Context {
            data_dir: &state.config.paths.data_dir,
            db_url: &state.config.database_url(),
            keyring: &state.secrets,
            now_ms: now,
            shared: state
                .cluster
                .coordinated()
                .then(|| issue::Shared { state, order_id: uuid::Uuid::now_v7().to_string() }),
        };
        // A certificate counts only once it is served.
        let outcome = issue::obtain(self, &settings, &cx).await.and_then(|certificate| {
            self.certificates
                .set(&certificate.chain_pem, &certificate.key_pem)
                .map(|()| certificate)
                .map_err(|e| Failure::new("acme.certificate_failed", format!("{e:#}")))
        });
        let done = state.clock.now_ms();
        match outcome {
            Ok(certificate) => {
                // Not stored, it stays in use from memory and storing is retried after a pause;
                // the CA is not asked again for it until it is due for renewal.
                let stored = match store::save_certificate(&state.config.paths.data_dir, &state.secrets, &certificate) {
                    Ok(()) => self.share(state).await,
                    Err(e) => Err(e),
                };
                if let Err(e) = &stored {
                    tracing::error!("the new HTTPS certificate is served but could not be stored: {e:#}");
                }
                tracing::info!(
                    "HTTPS certificate for {} issued by {}, valid until {}",
                    certificate.domains.join(", "),
                    certificate.issuer,
                    certificate.not_after_ms
                );
                let summary = json!({
                    "domains": certificate.domains,
                    "issuer": certificate.issuer,
                    "notAfter": certificate.not_after_ms,
                    "directory": host_of(&certificate.directory_url),
                });
                {
                    let mut rt = self.lock();
                    rt.certificate = Some(certificate);
                    rt.failures = 0;
                    rt.next_attempt_ms = None;
                    rt.last_error = None;
                    match stored {
                        Ok(()) => {
                            rt.store_retry = None;
                            rt.store_error = None;
                        }
                        Err(e) => {
                            rt.store_retry = Some((1, done + backoff_ms(1)));
                            rt.store_error = Some(store_error(&e, done));
                        }
                    }
                }
                record(state, "tls.certificate_issued", summary).await;
            }
            Err(failure) => {
                let (failures, next) = {
                    let mut rt = self.lock();
                    rt.failures += 1;
                    let next = done + backoff_ms(rt.failures);
                    rt.next_attempt_ms = Some(next);
                    rt.last_error = Some(LastError {
                        reason: failure.reason,
                        params: failure.params.clone(),
                        message: failure.message.clone(),
                        at: done,
                    });
                    (rt.failures, next)
                };
                tracing::warn!("ordering the HTTPS certificate failed ({}): {}", failure.reason, failure.message);
                let summary = json!({
                    "domains": settings.domains,
                    "reason": failure.reason,
                    "message": failure.message,
                    "failures": failures,
                    "nextAttemptAt": next,
                    "directory": host_of(settings.directory_url()),
                });
                record(state, "tls.certificate_failed", summary).await;
            }
        }
        crate::cluster::leader_done(state, ORDER_JOB).await;
        let mut rt = self.lock();
        rt.working = false;
        rt.forced = false;
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

fn public_host(config: &Config) -> Option<String> {
    let url = url::Url::parse(config.server.public_url.as_deref()?).ok()?;
    url.host_str().map(str::to_string)
}

pub fn server_view(config: &Config) -> ServerView {
    let addr = |s: &str| (!s.is_empty()).then(|| s.to_string());
    ServerView {
        http_addr: addr(&config.server.http_addr),
        https_addr: addr(&config.server.https_addr),
        certificate_files: config.tls.cert_file.is_some() || config.tls.key_file.is_some(),
    }
}

/// An audit entry of the server itself (no user).
async fn record(state: &AppState, action: &str, summary: serde_json::Value) {
    let event = AuditEvent {
        org_id: None,
        actor_user_id: None,
        actor_address: None,
        action,
        resource_type: Some("certificate"),
        resource_id: None,
        summary,
        at_ms: state.clock.now_ms(),
    };
    let write = async {
        let mut tx = crate::db::begin(&state.db).await?;
        audit::record(&mut tx, &event).await?;
        crate::db::commit(tx).await
    };
    if let Err(e) = write.await {
        tracing::warn!("writing the audit entry {action}: {e}");
    }
}

/// The stored settings and their version; defaults (off) when none were saved.
pub async fn load_settings(db: &sqlx::AnyPool) -> anyhow::Result<(AcmeSettings, i64)> {
    let row: Option<(String, i64)> = sqlx::query_as("SELECT value, version FROM server_settings WHERE key = $1")
        .bind(SETTINGS_KEY)
        .fetch_optional(db)
        .await?;
    Ok(match row {
        None => (AcmeSettings::default(), 0),
        Some((text, version)) => match serde_json::from_str::<AcmeSettings>(&text) {
            Ok(settings) => (settings, version),
            Err(e) => {
                tracing::warn!("the stored ACME settings cannot be read, ACME stays off: {e}");
                (AcmeSettings::default(), version)
            }
        },
    })
}

/// Checks what can only be checked over the network: the directory answers as an ACME directory,
/// and every name resolves. Warns about listeners on other ports than the CA connects to.
pub async fn check_connection(settings: &AcmeSettings, config: &Config) -> Result<Checked, FieldError> {
    let url_field = if settings.directory == Directory::Custom { "directoryUrl" } else { "directory" };
    let url = settings.directory_url();
    let unreachable = |detail: String| {
        FieldError::new(
            url_field,
            "acme.directory_unreachable",
            format!("the ACME directory cannot be reached: {detail}"),
        )
        .with("detail", detail)
    };
    let invalid = |detail: String| {
        FieldError::new(url_field, "acme.directory_invalid", format!("{url} is not an ACME directory: {detail}"))
            .with("detail", detail)
    };
    let transport = transport::Transport::new(&config.paths.data_dir, &config.database_url(), settings.directory_ca())
        .map_err(|e| unreachable(e.to_string()))?;
    let (status, body) = transport.get(url).await.map_err(unreachable)?;
    if status != 200 {
        return Err(invalid(format!("HTTP {status}")));
    }
    let directory: serde_json::Value = serde_json::from_slice(&body).map_err(|e| invalid(e.to_string()))?;
    for key in ["newNonce", "newAccount", "newOrder"] {
        if !directory.get(key).is_some_and(serde_json::Value::is_string) {
            return Err(invalid(format!("{key} is missing")));
        }
    }
    let terms_of_service = directory.pointer("/meta/termsOfService").and_then(|t| t.as_str()).map(str::to_string);
    let resolver =
        crate::datasources::targets::TargetPolicy::new(&config.paths.data_dir, &config.database_url(), &[], &[]);
    for domain in &settings.domains {
        let lookup = tokio::time::timeout(DNS_TIMEOUT, resolver.resolve_all(domain, 443)).await;
        let found = lookup.ok().and_then(Result::ok).is_some_and(|addrs| !addrs.is_empty());
        if !found {
            return Err(FieldError::new("domains", "acme.domain_unresolved", format!("{domain} does not resolve"))
                .with("domain", domain));
        }
    }
    let mut warnings = Vec::new();
    if config.https_addr().is_none() {
        warnings.push(Failure::plain(
            "acme.https_later",
            "HTTPS is off: the certificate is ordered and stored; set server.https_addr and restart to serve it",
        ));
    }
    match settings.challenge {
        Challenge::Http01 => {
            if let Some(port) = config.http_addr().map(|a| a.port()).filter(|p| *p != 80) {
                warnings.push(
                    Failure::plain("acme.http_port", format!("the CA connects to port 80; forward it to {port}"))
                        .with("port", port),
                );
            }
        }
        Challenge::TlsAlpn01 => {
            if let Some(port) = config.https_addr().map(|a| a.port()).filter(|p| *p != 443) {
                warnings.push(
                    Failure::plain("acme.https_port", format!("the CA connects to port 443; forward it to {port}"))
                        .with("port", port),
                );
            }
        }
    }
    Ok(Checked { terms_of_service, warnings })
}

/// Answers HTTP-01 validations: `/.well-known/acme-challenge/<token>` on the HTTP listener.
pub async fn http_challenge(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    if !is_token(&token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Memory only: with several servers on one database, the leader's answers are loaded here
    // before it lets the CA validate (`Acme::sync_challenges`).
    let answer = state.acme.lock_http().get(&token).cloned();
    match answer {
        Some(answer) => ([(header::CONTENT_TYPE, "application/octet-stream")], answer).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Orders and renews certificates until the server stops.
pub fn spawn(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        loop {
            // Several servers on one database: only the leader orders; the others look again
            // shortly, to take over when it goes.
            let leads = state.cluster.is_leader();
            let mut wait = state.acme.sleep_for(state.clock.now_ms());
            if !leads {
                wait = wait.max(Duration::from_secs(1)).min(NOT_LEADING_RECHECK);
            }
            tokio::select! {
                () = stopping.cancelled() => return,
                () = state.acme.wake.notified() => {}
                () = tokio::time::sleep(wait) => {}
            }
            if !state.cluster.is_leader() {
                continue;
            }
            tokio::select! {
                () = stopping.cancelled() => return,
                () = state.acme.tick(&state) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn certificate(domains: &[&str], not_before_ms: i64, not_after_ms: i64) -> StoredCertificate {
        StoredCertificate {
            directory_url: settings::LETS_ENCRYPT.into(),
            domains: domains.iter().map(|d| d.to_string()).collect(),
            chain_pem: String::new(),
            key_pem: String::new(),
            not_before_ms,
            not_after_ms,
            issuer: "R11".into(),
            issued_at_ms: not_before_ms,
        }
    }

    fn runtime(certificate: Option<StoredCertificate>) -> Runtime {
        Runtime {
            settings: AcmeSettings {
                enabled: true,
                domains: vec!["b.example.com".into(), "a.example.com".into()],
                accept_terms: true,
                ..Default::default()
            },
            version: 1,
            certificate,
            working: false,
            forced: false,
            failures: 0,
            next_attempt_ms: None,
            last_error: None,
            store_retry: None,
            store_error: None,
        }
    }

    const DAY: i64 = 86_400_000;

    #[test]
    fn renewal_starts_when_two_thirds_have_passed() {
        assert_eq!(renew_at(&certificate(&[], 0, 90 * DAY)), 60 * DAY);
        assert_eq!(renew_at(&certificate(&[], 0, 6 * DAY)), 4 * DAY);
    }

    #[test]
    fn a_certificate_is_due_when_missing_different_or_old() {
        let rt = runtime(None);
        assert!(Acme::due(&rt, 0));
        let good = certificate(&["a.example.com", "b.example.com"], 0, 90 * DAY);
        let mut rt = runtime(Some(good.clone()));
        assert!(!Acme::due(&rt, DAY), "same names in another order are the same certificate");
        assert!(Acme::due(&rt, 61 * DAY));
        rt.forced = true;
        assert!(Acme::due(&rt, DAY));
        rt.forced = false;
        rt.settings.domains.push("c.example.com".into());
        assert!(Acme::due(&rt, DAY));
        let mut rt = runtime(Some(good));
        rt.settings.directory = Directory::LetsencryptStaging;
        assert!(Acme::due(&rt, DAY));
        // Not while waiting for the next attempt, not while one runs, not when off.
        rt.next_attempt_ms = Some(2 * DAY);
        assert!(!Acme::due(&rt, DAY));
        assert!(Acme::due(&rt, 2 * DAY));
        rt.working = true;
        assert!(!Acme::due(&rt, 2 * DAY));
        rt.working = false;
        rt.settings.enabled = false;
        assert!(!Acme::due(&rt, 2 * DAY));
    }

    fn acme_with(rt: Runtime) -> Acme {
        Acme {
            certificates: Arc::new(resolver::Certificates::new(&[]).unwrap()),
            http: Mutex::default(),
            runtime: Mutex::new(rt),
            wake: tokio::sync::Notify::new(),
            shared_alpn: Mutex::default(),
            shared_http: Mutex::default(),
        }
    }

    #[test]
    fn a_renewal_on_request_respects_the_pause_and_a_new_certificate() {
        let reason = |acme: &Acme, now| acme.request_renewal(now).err().map(|e| e.reason);
        let good = certificate(&["a.example.com", "b.example.com"], 0, 90 * DAY);
        // New (younger than 30 of 90 days) and matching: refused.
        let acme = acme_with(runtime(Some(good.clone())));
        assert_eq!(reason(&acme, DAY), Some("acme.renew_too_soon"));
        assert_eq!(acme.request_renewal(31 * DAY), Ok(true));
        assert!(acme.lock().forced);
        // Other names: ordered at once, however new the certificate is.
        let mut rt = runtime(Some(good.clone()));
        rt.settings.domains.push("c.example.com".into());
        assert_eq!(acme_with(rt).request_renewal(DAY), Ok(true));
        // During a failure's pause: refused, after it allowed.
        let mut rt = runtime(None);
        rt.next_attempt_ms = Some(2 * DAY);
        let acme = acme_with(rt);
        assert_eq!(reason(&acme, DAY), Some("acme.renew_backoff"));
        assert_eq!(acme.request_renewal(2 * DAY), Ok(true));
        // Off: refused; running: nothing to do.
        let mut rt = runtime(None);
        rt.settings.enabled = false;
        assert_eq!(reason(&acme_with(rt), DAY), Some("acme.off"));
        let mut rt = runtime(None);
        rt.working = true;
        assert_eq!(acme_with(rt).request_renewal(DAY), Ok(false));
    }

    #[test]
    fn a_certificate_waiting_to_be_stored_is_still_renewed_when_due() {
        let mut rt = runtime(Some(certificate(&["a.example.com", "b.example.com"], 0, 90 * DAY)));
        rt.store_retry = Some((3, 100 * DAY));
        rt.store_error = Some(store_error(&anyhow::anyhow!("disk full"), DAY));
        assert!(!Acme::due(&rt, DAY), "not due yet, and not ordered again for the store");
        assert!(Acme::due(&rt, 61 * DAY), "the pending store does not hold the renewal back");
        let acme = acme_with(rt);
        let view = acme.view(&Config::default(), DAY);
        assert_eq!(view.status.phase, Phase::Valid);
        assert_eq!(view.status.store_error.unwrap().reason, "acme.store_failed");
        assert_eq!(acme.sleep_for(DAY), MAX_SLEEP);
    }

    #[test]
    fn only_tokens_are_looked_up() {
        assert!(is_token("GQa4oFOtuLYVNCLUW3dTh314flM5-DYxMNbQzkC2CJA"));
        for bad in ["", "a/b", "..", "a b", "a%2F", "ä", &"a".repeat(257)] {
            assert!(!is_token(bad), "{bad}");
        }
    }

    #[test]
    fn failures_back_off_up_to_twelve_hours() {
        let minutes: Vec<i64> = (1..=8).map(|n| backoff_ms(n) / 60_000).collect();
        assert_eq!(minutes, [5, 15, 60, 180, 360, 720, 720, 720]);
    }
}
