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

use std::collections::{BTreeMap, HashMap};
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
}

pub struct Acme {
    /// What the HTTPS listener serves when no certificate files are configured.
    pub certificates: Arc<resolver::Certificates>,
    /// HTTP-01 answers: token to key authorization.
    http: Mutex<HashMap<String, String>>,
    runtime: Mutex<Runtime>,
    wake: tokio::sync::Notify,
}

impl std::fmt::Debug for Acme {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Acme").finish_non_exhaustive()
    }
}

/// When a certificate is renewed: once two thirds of its lifetime have passed (30 days before
/// the end of a 90-day certificate, 2 days before the end of a 6-day one).
pub fn renew_at(certificate: &StoredCertificate) -> i64 {
    let lifetime = (certificate.not_after_ms - certificate.not_before_ms).max(0);
    certificate.not_after_ms - lifetime / 3
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
        };
        Ok(Self {
            certificates,
            http: Mutex::default(),
            runtime: Mutex::new(runtime),
            wake: tokio::sync::Notify::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.runtime.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn lock_http(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.http.lock().unwrap_or_else(|p| p.into_inner())
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
        }
        rt.settings = settings;
        rt.version = version;
        drop(rt);
        self.wake.notify_one();
    }

    /// Orders a certificate now, even when the current one is not due. False when ACME is off
    /// or an order is already running.
    pub fn request_renewal(&self) -> bool {
        let mut rt = self.lock();
        if !rt.settings.enabled || rt.working {
            return false;
        }
        rt.forced = true;
        rt.next_attempt_ms = None;
        drop(rt);
        self.wake.notify_one();
        true
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
        let next = [rt.next_attempt_ms, renewal].into_iter().flatten().min();
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
            },
            server: server_view(config),
        }
    }

    /// Orders a certificate when one is due. Runs in the background task only.
    async fn tick(&self, state: &AppState) {
        let now = state.clock.now_ms();
        let settings = {
            let mut rt = self.lock();
            if !Self::due(&rt, now) {
                return;
            }
            rt.working = true;
            rt.settings.clone()
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
        };
        let outcome = issue::obtain(self, &settings, &cx).await;
        let done = state.clock.now_ms();
        match outcome {
            Ok(certificate) => {
                if let Err(e) = store::save_certificate(&state.config.paths.data_dir, &state.secrets, &certificate) {
                    tracing::error!("the new HTTPS certificate is served but could not be stored: {e:#}");
                }
                if let Err(e) = self.certificates.set(&certificate.chain_pem, &certificate.key_pem) {
                    tracing::error!("the new HTTPS certificate cannot be served: {e:#}");
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
    match state.acme.lock_http().get(&token).cloned() {
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
            let wait = state.acme.sleep_for(state.clock.now_ms());
            tokio::select! {
                () = stopping.cancelled() => return,
                () = state.acme.wake.notified() => {}
                () = tokio::time::sleep(wait) => {}
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

    #[test]
    fn failures_back_off_up_to_twelve_hours() {
        let minutes: Vec<i64> = (1..=8).map(|n| backoff_ms(n) / 60_000).collect();
        assert_eq!(minutes, [5, 15, 60, 180, 360, 720, 720, 720]);
    }
}
