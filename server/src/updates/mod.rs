//! Updates (docs/ARCHITECTURE.md, "Updates"; operator guide docs/operations/updates.md).
//!
//! Kalzit looks for new releases on GitHub (`source`), downloads a release's package for this
//! platform into the data directory and verifies its Ed25519 signatures and SHA-256 before
//! anything else happens (`signing`, `staging`). Packages can also be uploaded (offline
//! installations); they pass the same checks. Installing (`install`) backs the database up,
//! keeps the running binary for a return, puts the new binary in place and hands over to it
//! (`boot`): the server stops, the new binary starts in a trial, checks its own health and
//! confirms, or Kalzit returns to the previous binary and database on its own.
//!
//! Only server administrators reach any of it, and every step is written to the audit log.

pub mod boot;
pub mod cli;
pub mod install;
pub mod platform;
pub mod signing;
pub mod source;
pub mod staging;

#[cfg(test)]
mod api_tests;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::error::{ApiError, ApiResult};
use install::{Layout, PlanKind};
use platform::{Mode, Platform};
use signing::{Channel, TrustedKeys};
use source::{Offer, ReleaseSource};

/// Why an update step failed or was refused. Each has a stable reason the UI translates
/// (docs/api/datasources.md, "Reasons", Updates).
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("no trusted update key is built into this Kalzit; updates cannot be verified")]
    NoTrustedKey,
    #[error("the signature does not match the release files")]
    SignatureInvalid,
    #[error("the release is signed with key {0}, which this Kalzit does not trust")]
    UnknownKey(String),
    #[error("the release files are not valid: {0}")]
    ManifestInvalid(String),
    #[error("the release has no package for {platform}-{arch}")]
    NoPackage { platform: String, arch: String },
    #[error("the package is for {platform}-{arch}, this server runs {ours}")]
    WrongPlatform { platform: String, arch: String, ours: String },
    #[error("the package does not match its signed SHA-256")]
    HashMismatch,
    #[error("the package size differs from its signed size")]
    SizeMismatch,
    #[error("the upload is larger than {0} bytes")]
    TooLarge(u64),
    #[error("{version} is older than the installed {installed}; return to an older version from the history")]
    Downgrade { version: String, installed: String },
    #[error("{0} is already installed")]
    AlreadyInstalled(String),
    #[error("this release needs at least version {0} installed first")]
    MinimumVersion(String),
    #[error("the release source cannot be reached: {0}")]
    SourceUnreachable(String),
    #[error("Kalzit does not send update requests to {0}")]
    SourceRefused(String),
    #[error("release {0} lacks its signed manifest or a file it names")]
    ReleaseIncomplete(String),
    #[error("version {0} is not offered; check for updates first")]
    NotOffered(String),
    #[error("another update step is running")]
    Busy,
    #[error("an update is being installed; wait until Kalzit has restarted")]
    Pending,
    #[error("version {0} is not downloaded or uploaded")]
    NotStaged(String),
    #[error("Kalzit cannot install updates on its own here ({0}); install from the command line")]
    ManualOnly(&'static str),
    #[error("Kalzit cannot back up a PostgreSQL database; back it up with pg_dump and confirm")]
    BackupUnsupported,
    #[error("the database backup failed: {0}")]
    BackupFailed(String),
    #[error("the new binary does not run: {0}")]
    SmokeTestFailed(String),
    #[error("putting the files in place failed: {0}")]
    InstallFailed(String),
    #[error("version {0} is not kept; Kalzit cannot return to it")]
    RollbackUnavailable(String),
    #[error("returning to {0} restores the database backup taken when it was left; confirm it")]
    RollbackNeedsRestore(String),
    #[error("returning across a database change needs a PostgreSQL restore from your own backup")]
    RollbackRestoreUnsupported,
    #[error("the time is in the past or more than 7 days ahead")]
    ScheduleOutOfRange,
    #[error("the planned installation did not run: the server was not running during its maintenance window")]
    ScheduleMissed,
    #[error("the upload lacks its {0}")]
    UploadIncomplete(&'static str),
    #[error("the upload has an unknown part {0}")]
    UploadUnknownPart(String),
    #[error("this preview release is not offered on the stable channel")]
    ChannelMismatch,
    #[error("the data directory's disk has too little free space ({0} bytes are needed)")]
    DiskFull(u64),
    #[error("version {0} has no signed manifest kept, so the command line cannot check it; return from the web page")]
    RollbackUnsigned(String),
}

impl UpdateError {
    /// The stable reason code.
    pub fn reason(&self) -> &'static str {
        match self {
            UpdateError::NoTrustedKey => "updates.no_trusted_key",
            UpdateError::SignatureInvalid => "updates.signature_invalid",
            UpdateError::UnknownKey(_) => "updates.unknown_key",
            UpdateError::ManifestInvalid(_) => "updates.manifest_invalid",
            UpdateError::NoPackage { .. } => "updates.no_package",
            UpdateError::WrongPlatform { .. } => "updates.wrong_platform",
            UpdateError::HashMismatch => "updates.hash_mismatch",
            UpdateError::SizeMismatch => "updates.size_mismatch",
            UpdateError::TooLarge(_) => "updates.too_large",
            UpdateError::Downgrade { .. } => "updates.downgrade",
            UpdateError::AlreadyInstalled(_) => "updates.already_installed",
            UpdateError::MinimumVersion(_) => "updates.minimum_version",
            UpdateError::SourceUnreachable(_) => "updates.source_unreachable",
            UpdateError::SourceRefused(_) => "updates.source_refused",
            UpdateError::ReleaseIncomplete(_) => "updates.release_incomplete",
            UpdateError::NotOffered(_) => "updates.not_offered",
            UpdateError::Busy => "updates.busy",
            UpdateError::Pending => "updates.pending",
            UpdateError::NotStaged(_) => "updates.not_staged",
            UpdateError::ManualOnly(_) => "updates.manual_only",
            UpdateError::BackupUnsupported => "updates.backup_unsupported",
            UpdateError::BackupFailed(_) => "updates.backup_failed",
            UpdateError::SmokeTestFailed(_) => "updates.smoke_test_failed",
            UpdateError::InstallFailed(_) => "updates.install_failed",
            UpdateError::RollbackUnavailable(_) => "updates.rollback_unavailable",
            UpdateError::RollbackNeedsRestore(_) => "updates.rollback_needs_restore",
            UpdateError::RollbackRestoreUnsupported => "updates.rollback_restore_unsupported",
            UpdateError::ScheduleOutOfRange => "updates.schedule_out_of_range",
            UpdateError::ScheduleMissed => "updates.schedule_missed",
            UpdateError::UploadIncomplete(_) => "updates.upload_incomplete",
            UpdateError::UploadUnknownPart(_) => "updates.upload_unknown_part",
            UpdateError::ChannelMismatch => "updates.channel_mismatch",
            UpdateError::DiskFull(_) => "updates.disk_full",
            UpdateError::RollbackUnsigned(_) => "updates.rollback_unsigned",
        }
    }

    /// The values the translated text uses.
    pub fn params(&self) -> BTreeMap<String, String> {
        let pairs: Vec<(&str, String)> = match self {
            UpdateError::UnknownKey(id) => vec![("keyId", id.clone())],
            UpdateError::ManifestInvalid(d)
            | UpdateError::SourceUnreachable(d)
            | UpdateError::BackupFailed(d)
            | UpdateError::SmokeTestFailed(d)
            | UpdateError::InstallFailed(d) => vec![("detail", d.clone())],
            UpdateError::NoPackage { platform, arch } => vec![("platform", platform.clone()), ("arch", arch.clone())],
            UpdateError::WrongPlatform { platform, arch, ours } => {
                vec![("platform", platform.clone()), ("arch", arch.clone()), ("ours", ours.clone())]
            }
            UpdateError::TooLarge(max) => vec![("max", max.to_string())],
            UpdateError::Downgrade { version, installed } => {
                vec![("version", version.clone()), ("installed", installed.clone())]
            }
            UpdateError::AlreadyInstalled(v)
            | UpdateError::ReleaseIncomplete(v)
            | UpdateError::NotOffered(v)
            | UpdateError::NotStaged(v)
            | UpdateError::RollbackUnavailable(v)
            | UpdateError::RollbackNeedsRestore(v)
            | UpdateError::RollbackUnsigned(v) => vec![("version", v.clone())],
            UpdateError::DiskFull(needed) => vec![("needed", needed.to_string())],
            UpdateError::MinimumVersion(v) => vec![("minimum", v.clone())],
            UpdateError::SourceRefused(host) => vec![("host", host.clone())],
            UpdateError::ManualOnly(mode) => vec![("mode", mode.to_string())],
            UpdateError::UploadIncomplete(part) => vec![("part", part.to_string())],
            UpdateError::UploadUnknownPart(part) => vec![("part", part.chars().take(64).collect())],
            _ => vec![],
        };
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    fn status(&self) -> (StatusCode, &'static str) {
        match self {
            UpdateError::Busy
            | UpdateError::Pending
            | UpdateError::NotStaged(_)
            | UpdateError::NotOffered(_)
            | UpdateError::ManualOnly(_)
            | UpdateError::BackupUnsupported
            | UpdateError::RollbackUnavailable(_)
            | UpdateError::RollbackNeedsRestore(_)
            | UpdateError::RollbackRestoreUnsupported
            | UpdateError::AlreadyInstalled(_)
            | UpdateError::Downgrade { .. }
            | UpdateError::MinimumVersion(_)
            | UpdateError::ChannelMismatch
            | UpdateError::DiskFull(_)
            | UpdateError::RollbackUnsigned(_) => (StatusCode::CONFLICT, "conflict"),
            _ => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
        }
    }

    pub fn view(&self) -> ErrorView {
        ErrorView { reason: self.reason().to_string(), params: self.params(), message: self.to_string() }
    }
}

impl From<UpdateError> for ApiError {
    fn from(e: UpdateError) -> Self {
        let (status, code) = e.status();
        let reason = e.reason();
        let params = e.params();
        ApiError::new(status, code, e.to_string()).with_reason(reason, params)
    }
}

/// An error as the status reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorView {
    pub reason: String,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    pub message: String,
}

/// What the server is doing about updates right now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "phase")]
pub enum Job {
    Idle,
    Checking,
    Downloading {
        version: String,
        bytes_done: u64,
        bytes_total: u64,
    },
    Applying {
        version: String,
        /// `backup`, `verify` or `replace`; `Restarting` follows.
        step: &'static str,
    },
    /// The new binary is in place and the server is about to restart into it.
    Restarting {
        version: String,
    },
    Failed {
        /// `check`, `download`, `upload`, `apply` or `rollback`.
        action: &'static str,
        error: ErrorView,
        at: i64,
    },
}

/// The last check, kept across restarts in `state.json`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRecord {
    pub at: i64,
    pub channel: Channel,
    /// The newest version the channel offers (also when it is not newer than this one).
    pub latest: Option<String>,
    pub offer: Option<Offer>,
    pub error: Option<ErrorView>,
}

/// An installation planned for a time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub version: String,
    pub at: i64,
    /// The end of the maintenance window: a server that was down at `at` and starts after this
    /// does not install any more.
    #[serde(default)]
    pub until: Option<i64>,
    /// Who planned it, for the audit log of the installation.
    pub by: Option<String>,
    /// PostgreSQL: the administrator confirmed an own backup when planning.
    #[serde(default)]
    pub acknowledge_no_backup: bool,
}

/// One upload at a time; dropped when the upload ends.
pub struct UploadSlot<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for UploadSlot<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    last_check: Option<CheckRecord>,
    schedule: Option<Schedule>,
    /// A version the administrator chose to skip; it is not offered again.
    #[serde(default)]
    skipped: Option<String>,
}

/// Who asked for a step, for the audit log.
#[derive(Clone, Debug, Default)]
pub struct Actor {
    pub user_id: Option<String>,
    pub address: Option<String>,
}

/// What the server does once it has stopped: start `exe` in its place. `restore` is a database
/// backup that must replace the database first (a return across a database change).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Handover {
    pub exe: PathBuf,
    pub restore: Option<(PathBuf, PathBuf)>,
}

/// The largest schedule ahead.
const MAX_SCHEDULE_AHEAD_MS: i64 = 7 * 24 * 3_600_000;
/// How often the daily check runs at most.
const DAY_MS: i64 = 24 * 3_600_000;
/// How often the background loop looks at the schedule and the daily check.
const TICK: Duration = Duration::from_secs(30);
/// Users with a request in this time count as active before an installation.
const ACTIVE_SESSION_MS: i64 = 30 * 60_000;

/// The update service of one server.
pub struct Updates {
    layout: Layout,
    current: semver::Version,
    platform: Platform,
    data_dir: PathBuf,
    db_url: String,
    keys: RwLock<TrustedKeys>,
    source: RwLock<ReleaseSource>,
    /// The running binary.
    exe: RwLock<Option<PathBuf>>,
    mode: RwLock<Option<Mode>>,
    /// Off only in tests, whose packages are not programs.
    smoke_test: RwLock<bool>,
    job: Mutex<Job>,
    saved: Mutex<Saved>,
    /// Held by every step that changes files (check, download, upload, apply, rollback).
    work: Arc<tokio::sync::Mutex<()>>,
    handover: Mutex<Option<Handover>>,
    handover_requested: tokio::sync::Notify,
    uploading: std::sync::atomic::AtomicBool,
    /// Other Kalzit servers use the same database (`cluster`): this one does not replace its own
    /// binary, each server is updated on its own with its package.
    clustered: std::sync::atomic::AtomicBool,
}

impl Updates {
    pub fn new(data_dir: &Path, db_url: &str) -> Self {
        let layout = Layout::new(data_dir);
        let saved = match std::fs::read(layout.state_file()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                tracing::warn!("ignoring {}: {e}", layout.state_file().display());
                Saved::default()
            }),
            Err(_) => Saved::default(),
        };
        Self {
            layout,
            current: current_version(),
            platform: Platform::current(),
            data_dir: data_dir.to_path_buf(),
            db_url: db_url.to_string(),
            keys: RwLock::new(TrustedKeys::compiled()),
            source: RwLock::new(ReleaseSource::github()),
            exe: RwLock::new(std::env::current_exe().ok().map(|p| std::fs::canonicalize(&p).unwrap_or(p))),
            mode: RwLock::new(None),
            smoke_test: RwLock::new(true),
            job: Mutex::new(Job::Idle),
            saved: Mutex::new(saved),
            work: Arc::new(tokio::sync::Mutex::new(())),
            handover: Mutex::new(None),
            handover_requested: tokio::sync::Notify::new(),
            uploading: std::sync::atomic::AtomicBool::new(false),
            clustered: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Whether other servers run on the same database (`cluster::Cluster`); then installing is
    /// refused with `updates.mode_cluster`.
    pub fn set_clustered(&self, clustered: bool) {
        self.clustered.store(clustered, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// Takes the one upload slot, after checking that the data directory's disk has room for an
    /// upload of `incoming` bytes (twice: the upload, and the staged copy of the binary).
    pub fn begin_upload(&self, incoming: u64) -> Result<UploadSlot<'_>, UpdateError> {
        if lock(&self.handover).is_some() {
            return Err(UpdateError::Pending);
        }
        if let Some(free) = platform::free_space(&self.data_dir) {
            let needed = incoming.saturating_mul(2);
            if free < needed {
                return Err(UpdateError::DiskFull(needed));
            }
        }
        self.uploading
            .compare_exchange(false, true, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst)
            .map_err(|_| UpdateError::Busy)?;
        Ok(UploadSlot(&self.uploading))
    }

    fn exe_name(&self) -> std::ffi::OsString {
        read(&self.exe)
            .as_deref()
            .and_then(Path::file_name)
            .map(|n| n.to_os_string())
            .unwrap_or_else(|| std::ffi::OsString::from(if cfg!(windows) { "kalzit.exe" } else { "kalzit" }))
    }

    pub fn current(&self) -> &semver::Version {
        &self.current
    }

    fn keys(&self) -> TrustedKeys {
        read(&self.keys).clone()
    }

    fn exe(&self) -> Result<PathBuf, UpdateError> {
        read(&self.exe).clone().ok_or_else(|| UpdateError::InstallFailed("the running binary is unknown".into()))
    }

    /// Whether this server installs on its own, or why not (the platform's answer is cached
    /// after the first look). Several servers on one database never install on their own: one
    /// binary replacing itself would leave the others on the old version in the middle of a
    /// migration, so every server is updated with its package, one after the other. A server
    /// that cannot install on its own anyway keeps its own reason (the package command).
    pub fn mode(&self) -> Mode {
        let cached = *read(&self.mode);
        let mode = cached.unwrap_or_else(|| {
            let mode = match read(&self.exe).as_deref() {
                Some(exe) => platform::detect_mode(exe),
                None => Mode::Manual("updates.mode_binary_not_writable"),
            };
            *write(&self.mode) = Some(mode);
            mode
        });
        match mode {
            Mode::Automatic if self.clustered.load(std::sync::atomic::Ordering::SeqCst) => {
                Mode::Manual("updates.mode_cluster")
            }
            mode => mode,
        }
    }

    fn set_job(&self, job: Job) {
        *lock(&self.job) = job;
    }

    pub fn job(&self) -> Job {
        lock(&self.job).clone()
    }

    fn saved(&self) -> Saved {
        lock(&self.saved).clone()
    }

    fn update_saved(&self, change: impl FnOnce(&mut Saved)) {
        let mut saved = lock(&self.saved);
        change(&mut saved);
        if let Err(e) = install::write_json(&self.layout.state_file(), &*saved) {
            tracing::warn!("saving the update state failed: {e}");
        }
    }

    fn try_work(&self) -> Result<tokio::sync::OwnedMutexGuard<()>, UpdateError> {
        if lock(&self.handover).is_some() {
            return Err(UpdateError::Pending);
        }
        self.work.clone().try_lock_owned().map_err(|_| UpdateError::Busy)
    }

    /// The handover the server performs once it has stopped, if one was asked for.
    pub fn take_handover(&self) -> Option<Handover> {
        lock(&self.handover).take()
    }

    /// Waits until a step asks the server to stop and hand over.
    pub async fn handover_requested(&self) {
        loop {
            let notified = self.handover_requested.notified();
            if lock(&self.handover).is_some() {
                return;
            }
            notified.await;
        }
    }

    /// Asks the server to stop and start `handover.exe`.
    pub fn request_handover(&self, handover: Handover) {
        *lock(&self.handover) = Some(handover);
        self.handover_requested.notify_waiters();
    }

    fn fetcher(&self, timeout: Duration) -> Result<source::Fetcher, UpdateError> {
        source::Fetcher::new(&self.data_dir, &self.db_url, read(&self.source).clone(), timeout)
    }

    /// Asks the release source for the newest release of `channel`.
    pub async fn check(&self, state: &AppState, actor: &Actor) -> ApiResult<()> {
        let _work = self.try_work()?;
        self.set_job(Job::Checking);
        let channel = channel(state).await?;
        let now = state.clock.now_ms();
        let found = match self.fetcher(source::API_TIMEOUT) {
            Ok(fetcher) => fetcher.latest(channel, &self.current, &self.keys(), &self.platform).await,
            Err(e) => Err(e),
        };
        let record = match found {
            Ok(found) => CheckRecord { at: now, channel, latest: found.latest, offer: found.offer, error: None },
            Err(e) => {
                tracing::warn!("update check failed: {e}");
                CheckRecord { at: now, channel, latest: None, offer: None, error: Some(e.view()) }
            }
        };
        let summary = json!({
            "channel": channel,
            "latest": record.latest,
            "offered": record.offer.as_ref().map(|o| o.version.clone()),
            "error": record.error.as_ref().map(|e| e.reason.clone()),
        });
        self.update_saved(|s| s.last_check = Some(record));
        self.set_job(Job::Idle);
        record_audit(state, actor, "update.checked", None, summary).await
    }

    /// Starts downloading the offered `version` in the background.
    pub async fn start_download(self: &Arc<Self>, state: &AppState, version: &str, actor: Actor) -> ApiResult<()> {
        let work = self.try_work()?;
        let offer = self
            .saved()
            .last_check
            .and_then(|c| c.offer)
            .filter(|o| o.version == version)
            .ok_or_else(|| UpdateError::NotOffered(version.to_string()))?;
        self.set_job(Job::Downloading { version: version.to_string(), bytes_done: 0, bytes_total: offer.size });
        let fetcher = self.fetcher(source::DOWNLOAD_TIMEOUT)?;
        let this = self.clone();
        let state = state.clone();
        tokio::spawn(async move {
            // The step lock is released before the job reads idle (or failed) again, so whoever
            // sees the finished job can start the next step at once.
            let progress = |done: u64, total: u64| {
                this.set_job(Job::Downloading { version: offer.version.clone(), bytes_done: done, bytes_total: total });
            };
            let result =
                staging::download(&fetcher, &this.layout, &offer, &this.keys(), &this.platform, &progress).await;
            let now = state.clock.now_ms();
            match result {
                Ok(staged) => {
                    let summary = json!({ "version": staged.version, "size": staged.size, "sha256": staged.sha256 });
                    if let Err(e) =
                        record_audit(&state, &actor, "update.downloaded", Some(&staged.version), summary).await
                    {
                        tracing::warn!("recording the download in the audit log failed: {}", e.message);
                    }
                    drop(work);
                    this.set_job(Job::Idle);
                }
                Err(e) => {
                    tracing::warn!("downloading {} failed: {e}", offer.version);
                    let summary = json!({ "version": offer.version, "error": e.reason() });
                    let _ = record_audit(&state, &actor, "update.download_failed", Some(&offer.version), summary).await;
                    drop(work);
                    this.set_job(Job::Failed { action: "download", error: e.view(), at: now });
                }
            }
        });
        Ok(())
    }

    /// Verifies and stages an uploaded release (`dir` holds `manifest.json`, `manifest.json.sig`
    /// and `package`, or one offline package, written by the upload route). The file work runs on
    /// the blocking pool.
    pub async fn stage_upload(&self, state: &AppState, dir: &Path, actor: &Actor) -> ApiResult<()> {
        let _work = self.try_work()?;
        let channel = channel(state).await?;
        let (layout, keys, platform, current, folder) =
            (self.layout.clone(), self.keys(), self.platform, self.current.clone(), dir.to_path_buf());
        let checked = blocking(move || {
            staging::split_upload(&folder)
                .and_then(|()| staging::stage_upload(&layout, &folder, &keys, &platform, &current, channel))
        })
        .await;
        let staged = match checked {
            Ok(staged) => staged,
            Err(e) => {
                let version = staging::uploaded_version(dir).unwrap_or_default();
                self.record_aborted(state, &version, "offline", &e, actor, false);
                let summary = json!({ "error": e.reason() });
                let _ = record_audit(state, actor, "update.upload_refused", None, summary).await;
                return Err(e.into());
            }
        };
        let summary = json!({ "version": staged.version, "size": staged.size, "sha256": staged.sha256 });
        record_audit(state, actor, "update.uploaded", Some(&staged.version), summary).await
    }

    /// A step that stopped before anything changed, in the history.
    fn record_aborted(
        &self,
        state: &AppState,
        version: &str,
        source: &str,
        e: &UpdateError,
        actor: &Actor,
        scheduled: bool,
    ) {
        install::push_history(
            &self.layout,
            install::HistoryEntry {
                version: version.to_string(),
                from: Some(self.current.to_string()),
                at: state.clock.now_ms(),
                kind: PlanKind::Update,
                outcome: install::Outcome::Aborted,
                reason: Some(e.to_string()),
                reason_code: Some(e.reason().to_string()),
                source: Some(source.to_string()),
                scheduled,
                actor: actor.user_id.clone(),
                duration_ms: None,
            },
        );
    }

    /// Removes the downloaded or uploaded release and its schedule.
    pub async fn discard(&self, state: &AppState, actor: &Actor) -> ApiResult<()> {
        let _work = self.try_work()?;
        let staged = staging::staged_info(&self.layout);
        staging::discard(&self.layout).map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
        self.update_saved(|s| s.schedule = None);
        if matches!(self.job(), Job::Failed { .. }) {
            self.set_job(Job::Idle);
        }
        let version = staged.map(|s| s.version);
        record_audit(state, actor, "update.discarded", version.as_deref(), json!({ "version": version })).await
    }

    /// Hides the offered `version` until a newer one comes.
    pub async fn skip(&self, state: &AppState, version: &str, actor: &Actor) -> ApiResult<()> {
        let offered = self.saved().last_check.and_then(|c| c.offer).is_some_and(|o| o.version == version);
        if !offered {
            return Err(UpdateError::NotOffered(version.to_string()).into());
        }
        self.update_saved(|s| s.skipped = Some(version.to_string()));
        record_audit(state, actor, "update.skipped", Some(version), json!({ "version": version })).await
    }

    /// A database backup now, kept like the backups before installations.
    pub async fn backup_now(&self, state: &AppState, actor: &Actor) -> ApiResult<()> {
        let _work = self.try_work()?;
        let now = state.clock.now_ms();
        let kind = install::BackupKind::Manual;
        let file = install::backup_database(
            &state.db,
            &self.db_url,
            &self.layout,
            &self.current,
            now,
            kind,
            actor.user_id.clone(),
        )
        .await?
        .ok_or(UpdateError::BackupUnsupported)?;
        let (layout, keep, current, exe_name) =
            (self.layout.clone(), keep_versions(state).await, self.current.to_string(), self.exe_name());
        blocking(move || {
            install::prune(&layout, keep, &current, &exe_name);
            Ok(())
        })
        .await?;
        record_audit(state, actor, "update.backed_up", None, json!({ "file": file })).await
    }

    /// The path of a listed backup, `None` for any other name.
    pub fn backup_path(&self, file: &str) -> Option<PathBuf> {
        install::list_backups(&self.layout)
            .into_iter()
            .find(|b| b.file == file)
            .and_then(|b| install::backup_path(&self.layout, &b.file))
    }

    pub async fn record_backup_download(&self, state: &AppState, file: &str, actor: &Actor) -> ApiResult<()> {
        record_audit(state, actor, "update.backup_downloaded", None, json!({ "file": file })).await
    }

    /// Installs the staged `version` now: backup, binary swap, then the server restarts into it.
    pub async fn apply(
        &self,
        state: &AppState,
        version: &str,
        acknowledge_no_backup: bool,
        actor: &Actor,
    ) -> ApiResult<()> {
        self.apply_as(state, version, acknowledge_no_backup, actor, false).await
    }

    async fn apply_as(
        &self,
        state: &AppState,
        version: &str,
        acknowledge_no_backup: bool,
        actor: &Actor,
        scheduled: bool,
    ) -> ApiResult<()> {
        if let Mode::Manual(why) = self.mode() {
            return Err(UpdateError::ManualOnly(why).into());
        }
        let _work = self.try_work()?;
        self.set_job(Job::Applying { version: version.to_string(), step: "verify" });
        match self.apply_locked(state, version, acknowledge_no_backup, actor, scheduled).await {
            Ok(handover) => {
                self.update_saved(|s| s.schedule = None);
                self.set_job(Job::Restarting { version: version.to_string() });
                self.request_handover(handover);
                Ok(())
            }
            // A PostgreSQL installation waiting for its confirmation has not failed, unless it
            // was planned: then nobody is there to confirm, and the history must say why.
            Err(Failure::Update(UpdateError::BackupUnsupported)) if !scheduled => {
                self.set_job(Job::Idle);
                Err(UpdateError::BackupUnsupported.into())
            }
            Err(Failure::Update(e)) => {
                let view = e.view();
                self.set_job(Job::Failed { action: "apply", error: view.clone(), at: state.clock.now_ms() });
                let source = staging::staged_info(&self.layout).map_or_else(|| "online".to_string(), |s| s.source);
                self.record_aborted(state, version, &source, &e, actor, scheduled);
                let summary = json!({ "version": version, "error": view.reason });
                let _ = record_audit(state, actor, "update.apply_failed", Some(version), summary).await;
                Err(e.into())
            }
            Err(Failure::Api(e)) => {
                self.set_job(Job::Idle);
                Err(e)
            }
        }
    }

    async fn apply_locked(
        &self,
        state: &AppState,
        version: &str,
        acknowledge_no_backup: bool,
        actor: &Actor,
        scheduled: bool,
    ) -> Result<Handover, Failure> {
        let (layout, keys, platform) = (self.layout.clone(), self.keys(), self.platform);
        let staged = blocking(move || staging::load(&layout, &keys, &platform)).await?;
        if staged.version != version {
            return Err(UpdateError::NotStaged(version.to_string()).into());
        }
        version_rules(&self.current, &staged.manifest)?;
        let database = install::database_kind(&self.db_url);
        if database == install::DatabaseKind::Postgres && !acknowledge_no_backup {
            return Err(UpdateError::BackupUnsupported.into());
        }
        let exe = self.exe()?;
        // The package is copied once next to the binary and checked there; the copy is what runs
        // for the smoke test and what goes into place.
        let (source, target, sha, size) =
            (staged.package_path.clone(), exe.clone(), staged.package.sha256.clone(), staged.package.size);
        let placed = blocking(move || install::place_binary(&source, &target, &sha, size)).await?;
        if *read(&self.smoke_test) {
            platform::smoke_test(placed.path(), version).await?;
        }
        let source_kind = staging::staged_info(&self.layout).map_or_else(|| "online".to_string(), |s| s.source);
        self.set_job(Job::Applying { version: version.to_string(), step: "backup" });
        let now = state.clock.now_ms();
        let schema = install::schema_version(&state.db).await.map_err(Failure::Api)?;
        let kind = install::BackupKind::Switch;
        let backup =
            install::backup_database(&state.db, &self.db_url, &self.layout, &self.current, now, kind, None).await?;
        let keep = health_timeout(state).await?;
        self.set_job(Job::Applying { version: version.to_string(), step: "replace" });
        let switch = install::Switch {
            kind: PlanKind::Update,
            from: self.current.to_string(),
            to: staged.version.clone(),
            exe: exe.clone(),
            exe_file: std::fs::File::open(&exe).map_err(|e| UpdateError::InstallFailed(e.to_string()))?,
            release: Some((staged.manifest_bytes, staged.signature_bytes)),
            backup,
            database: install::sqlite_file(&self.db_url),
            schema,
            health_timeout_secs: keep,
            actor: actor.user_id.clone(),
            now,
            source_kind,
            scheduled,
        };
        let layout = self.layout.clone();
        let plan = blocking(move || install::prepare_update(&layout, switch, placed)).await?;
        let summary = json!({
            "from": plan.from, "to": plan.to, "backup": plan.backup.is_some(), "database": database.name(),
        });
        // The binary is in place: from here the handover must happen, whatever the audit log says.
        if let Err(e) = record_audit(state, actor, "update.applied", Some(&plan.to), summary).await {
            tracing::warn!("recording the installation in the audit log failed: {}", e.message);
        }
        staging::discard(&self.layout).ok();
        Ok(Handover { exe, restore: None })
    }

    /// Returns to the kept `version`. When the database changed since, the backup taken when that
    /// version was left replaces it (`restore_database` must confirm that); without that change
    /// only the binary is swapped.
    pub async fn rollback(
        &self,
        state: &AppState,
        version: &str,
        restore_database: bool,
        actor: &Actor,
    ) -> ApiResult<()> {
        if let Mode::Manual(why) = self.mode() {
            return Err(UpdateError::ManualOnly(why).into());
        }
        let _work = self.try_work()?;
        self.set_job(Job::Applying { version: version.to_string(), step: "backup" });
        match self.rollback_locked(state, version, restore_database, actor).await {
            Ok(handover) => {
                self.set_job(Job::Restarting { version: version.to_string() });
                self.request_handover(handover);
                Ok(())
            }
            Err(e) => {
                self.set_job(Job::Idle);
                Err(e.into())
            }
        }
    }

    async fn rollback_locked(
        &self,
        state: &AppState,
        version: &str,
        restore_database: bool,
        actor: &Actor,
    ) -> Result<Handover, Failure> {
        if version == self.current.to_string() {
            return Err(UpdateError::RollbackUnavailable(version.to_string()).into());
        }
        let target = install::kept_version(&self.layout, version)
            .ok_or_else(|| UpdateError::RollbackUnavailable(version.to_string()))?;
        let schema = install::schema_version(&state.db).await.map_err(Failure::Api)?;
        let database_file = install::sqlite_file(&self.db_url);
        let restore = if target.schema == schema {
            None
        } else {
            if database_file.is_none() {
                return Err(UpdateError::RollbackRestoreUnsupported.into());
            }
            if !restore_database {
                return Err(UpdateError::RollbackNeedsRestore(version.to_string()).into());
            }
            let backup = target
                .backup
                .as_deref()
                .and_then(|name| install::backup_path(&self.layout, name))
                .ok_or_else(|| UpdateError::RollbackUnavailable(version.into()))?;
            Some(backup)
        };
        let exe = self.exe()?;
        let (layout, keys, platform, wanted, target_exe) =
            (self.layout.clone(), self.keys(), self.platform, version.to_string(), exe.clone());
        let placed = blocking(move || {
            let kept = install::verify_kept(&layout, &wanted, &target_exe, &keys, &platform)?;
            install::place_binary(&kept.path, &target_exe, &kept.sha256, kept.size)
        })
        .await?;
        let now = state.clock.now_ms();
        let kind = install::BackupKind::Switch;
        let backup =
            install::backup_database(&state.db, &self.db_url, &self.layout, &self.current, now, kind, None).await?;
        let keep = health_timeout(state).await?;
        let switch = install::Switch {
            kind: PlanKind::Rollback,
            from: self.current.to_string(),
            to: target.version.clone(),
            exe: exe.clone(),
            exe_file: std::fs::File::open(&exe).map_err(|e| UpdateError::InstallFailed(e.to_string()))?,
            release: None,
            backup,
            database: database_file.clone(),
            schema,
            health_timeout_secs: keep,
            actor: actor.user_id.clone(),
            now,
            source_kind: "kept".into(),
            scheduled: false,
        };
        let layout = self.layout.clone();
        let plan = blocking(move || install::prepare_update(&layout, switch, placed)).await?;
        let summary = json!({ "from": plan.from, "to": plan.to, "restoreDatabase": restore.is_some() });
        if let Err(e) = record_audit(state, actor, "update.rollback_started", Some(&plan.to), summary).await {
            tracing::warn!("recording the return in the audit log failed: {}", e.message);
        }
        Ok(Handover { exe, restore: restore.zip(database_file) })
    }

    /// Plans the installation of the staged `version` at `at`; `until` ends the maintenance
    /// window, after which a server that was down at `at` does not install any more.
    pub async fn schedule(
        &self,
        state: &AppState,
        version: &str,
        at: i64,
        until: Option<i64>,
        acknowledge_no_backup: bool,
        actor: &Actor,
    ) -> ApiResult<()> {
        if let Mode::Manual(why) = self.mode() {
            return Err(UpdateError::ManualOnly(why).into());
        }
        let now = state.clock.now_ms();
        if at <= now || at > now + MAX_SCHEDULE_AHEAD_MS {
            return Err(ApiError::from(UpdateError::ScheduleOutOfRange).with_field("at"));
        }
        if until.is_some_and(|u| u <= at || u > at + DAY_MS) {
            return Err(ApiError::from(UpdateError::ScheduleOutOfRange).with_field("until"));
        }
        let staged = staging::staged_info(&self.layout).filter(|s| s.version == version);
        if staged.is_none() {
            return Err(UpdateError::NotStaged(version.to_string()).into());
        }
        // On PostgreSQL nobody is there to confirm an own backup when the time comes.
        if install::database_kind(&self.db_url) == install::DatabaseKind::Postgres && !acknowledge_no_backup {
            return Err(UpdateError::BackupUnsupported.into());
        }
        let schedule =
            Schedule { version: version.to_string(), at, until, by: actor.user_id.clone(), acknowledge_no_backup };
        self.update_saved(|s| s.schedule = Some(schedule));
        let summary = json!({ "version": version, "at": at, "until": until });
        record_audit(state, actor, "update.scheduled", Some(version), summary).await
    }

    pub async fn unschedule(&self, state: &AppState, actor: &Actor) -> ApiResult<()> {
        let had = self.saved().schedule;
        self.update_saved(|s| s.schedule = None);
        let version = had.map(|s| s.version);
        record_audit(state, actor, "update.unscheduled", version.as_deref(), json!({ "version": version })).await
    }

    /// One run of the background loop: a due installation, then the daily check.
    pub async fn tick(&self, state: &AppState) {
        let now = state.clock.now_ms();
        if let Some(schedule) = self.saved().schedule.filter(|s| s.at <= now) {
            let actor = Actor { user_id: schedule.by.clone(), address: None };
            self.update_saved(|s| s.schedule = None);
            if schedule.until.is_some_and(|u| now > u) {
                let e = UpdateError::ScheduleMissed;
                tracing::warn!("{e}");
                self.set_job(Job::Failed { action: "apply", error: e.view(), at: now });
                self.record_aborted(state, &schedule.version, "online", &e, &actor, true);
                return;
            }
            let ack = schedule.acknowledge_no_backup;
            if let Err(e) = self.apply_as(state, &schedule.version, ack, &actor, true).await {
                tracing::warn!("the scheduled installation of {} failed: {}", schedule.version, e.message);
            }
            return;
        }
        // Several servers on one database: the leader checks once a day for all of them; "Check
        // now" works on every server.
        if !state.cluster.is_leader() {
            return;
        }
        let daily = crate::settings::get(state, "updates.check_daily").await.ok().and_then(|v| v.as_bool());
        let due = self.saved().last_check.is_none_or(|c| now - c.at >= DAY_MS);
        if daily == Some(true)
            && due
            && lock(&self.handover).is_none()
            && let Err(e) = self.check(state, &Actor::default()).await
        {
            tracing::debug!("the daily update check did not run: {}", e.message);
        }
    }

    /// The status the Updates page shows.
    pub async fn status(&self, state: &AppState) -> ApiResult<UpdateStatus> {
        let saved = self.saved();
        let staged = staging::staged_info(&self.layout);
        let mode = self.mode();
        let schema = install::schema_version(&state.db).await?;
        let database = install::database_kind(&self.db_url);
        let kept = install::kept_versions(&self.layout, &self.exe_name());
        let current = self.current.to_string();
        let now = state.clock.now_ms();
        let rollback_targets = kept
            .into_iter()
            .filter(|k| k.version != current)
            .map(|k| RollbackTarget {
                needs_database_restore: k.schema != schema,
                restore_possible: k.schema == schema
                    || (database != install::DatabaseKind::Postgres
                        && k.backup.as_deref().and_then(|b| install::backup_path(&self.layout, b)).is_some()),
                version: k.version,
                kept_at: k.kept_at,
            })
            .collect();
        let skipped = saved.skipped.clone();
        let available = saved
            .last_check
            .as_ref()
            .and_then(|c| c.offer.as_ref())
            .filter(|o| skipped.as_deref() != Some(o.version.as_str()))
            .map(|o| AvailableView {
                version: o.version.clone(),
                channel: o.channel,
                size: o.size,
                sha256: o.sha256.clone(),
                notes: o.notes.clone(),
                notes_url: o.notes_url.clone(),
                highlights: o.highlights.clone(),
                released_at: o.released_at.clone(),
                minimum_version: o.minimum_version.clone(),
                key_id: o.key_id.clone(),
                staged: staged.as_ref().is_some_and(|s| s.version == o.version),
            });
        let history = install::history(&self.layout);
        let backups = install::list_backups(&self.layout);
        let mut ids: Vec<String> = history
            .iter()
            .filter_map(|h| h.actor.clone())
            .chain(backups.iter().filter_map(|b| b.meta.by.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        let mut people = Vec::new();
        for id in ids {
            let row: Option<(String,)> =
                sqlx::query_as("SELECT name FROM users WHERE id = $1").bind(&id).fetch_optional(&state.db).await?;
            if let Some((name,)) = row {
                people.push(Person { id, name });
            }
        }
        let (sessions,): (i64,) =
            sqlx::query_as("SELECT COUNT(DISTINCT user_id) FROM sessions WHERE expires_at > $1 AND last_seen_at > $2")
                .bind(now)
                .bind(now - ACTIVE_SESSION_MS)
                .fetch_one(&state.db)
                .await?;
        let database_bytes = install::sqlite_file(&self.db_url).map(|db| {
            ["", "-wal"]
                .iter()
                .filter_map(|s| std::fs::metadata(format!("{}{s}", db.display())).ok())
                .map(|m| m.len())
                .sum::<u64>()
        });
        let preflight = Preflight {
            backup_bytes: database_bytes,
            free_bytes: platform::free_space(&self.data_dir),
            active_users: sessions,
            health_timeout_secs: health_timeout(state).await.map_err(ApiError::from)?,
        };
        Ok(UpdateStatus {
            installed: Installed {
                version: current,
                platform: self.platform.os.to_string(),
                arch: self.platform.arch.to_string(),
                since: install::history(&self.layout)
                    .iter()
                    .find(|h| h.outcome == install::Outcome::Installed && h.version == self.current.to_string())
                    .map(|h| h.at),
            },
            channel: channel(state).await?,
            check_daily: crate::settings::get(state, "updates.check_daily").await?.as_bool().unwrap_or(false),
            window: crate::settings::get(state, "updates.window").await?.as_str().unwrap_or("02:00-04:00").to_string(),
            last_check: saved.last_check.map(|c| LastCheckView { at: c.at, latest: c.latest, error: c.error }),
            available,
            skipped,
            staged,
            job: self.job(),
            mode: ModeView {
                automatic: matches!(mode, Mode::Automatic),
                reason: match mode {
                    Mode::Automatic => None,
                    Mode::Manual(why) => Some(why),
                },
            },
            database: database.name(),
            schedule: saved.schedule.map(|s| ScheduleView { version: s.version, at: s.at, until: s.until }),
            trusted_keys: self.keys().ids(),
            preflight,
            max_package_bytes: signing::MAX_PACKAGE_BYTES,
            backups,
            history,
            people,
            rollback_targets,
        })
    }

    /// After a start: records a return that happened before it (the plan says `rolledBack`) in
    /// the audit log and the history.
    pub async fn record_outcome(&self, state: &AppState) {
        let Some(plan) = install::read_plan(&self.layout) else { return };
        if plan.state != install::PlanState::RolledBack || plan.from != self.current.to_string() {
            return;
        }
        let mut plan = plan;
        // The history entry is written once; a failed audit write is tried again at the next
        // start without a second entry.
        if !plan.recorded {
            install::push_history(&self.layout, install::returned_entry(&plan, state.clock.now_ms()));
            plan.recorded = true;
            if let Err(e) = install::write_plan(&self.layout, &plan) {
                tracing::warn!("marking the return as recorded failed: {e}");
            }
        }
        let actor = Actor { user_id: plan.actor.clone(), address: None };
        let summary = json!({ "from": plan.from, "to": plan.to, "reason": plan.error });
        if record_audit(state, &actor, "update.rolled_back", Some(&plan.to), summary).await.is_ok() {
            install::remove_plan(&self.layout);
        }
    }

    #[cfg(test)]
    pub(crate) fn set_test_environment(&self, source: ReleaseSource, keys: TrustedKeys, exe: PathBuf, mode: Mode) {
        *write(&self.source) = source;
        *write(&self.keys) = keys;
        *write(&self.exe) = Some(exe);
        *write(&self.mode) = Some(mode);
        *write(&self.smoke_test) = false;
    }
}

/// An apply or rollback failure: an update reason, or an API error from the database.
enum Failure {
    Update(UpdateError),
    Api(ApiError),
}

impl From<UpdateError> for Failure {
    fn from(e: UpdateError) -> Self {
        Failure::Update(e)
    }
}

impl From<Failure> for ApiError {
    fn from(f: Failure) -> Self {
        match f {
            Failure::Update(e) => e.into(),
            Failure::Api(e) => e,
        }
    }
}

/// Downgrades, the installed version and versions that need an intermediate step are refused.
/// The stable channel takes only stable releases; preview takes both.
pub fn channel_rule(channel: Channel, manifest: &signing::Manifest) -> Result<(), UpdateError> {
    if channel == Channel::Stable && manifest.channel != Channel::Stable {
        return Err(UpdateError::ChannelMismatch);
    }
    Ok(())
}

/// Runs file work (hashing, copying, restoring) on the blocking pool, off the request threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, UpdateError> + Send + 'static,
) -> Result<T, UpdateError> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|e| Err(UpdateError::InstallFailed(format!("a background step failed: {e}"))))
}

pub fn version_rules(current: &semver::Version, manifest: &signing::Manifest) -> Result<(), UpdateError> {
    let version = semver::Version::parse(&manifest.version)
        .map_err(|_| UpdateError::ManifestInvalid("the version is not a semantic version".into()))?;
    if version == *current {
        return Err(UpdateError::AlreadyInstalled(manifest.version.clone()));
    }
    if version < *current {
        return Err(UpdateError::Downgrade { version: manifest.version.clone(), installed: current.to_string() });
    }
    if let Some(minimum) = manifest.minimum_version.as_deref().and_then(|m| semver::Version::parse(m).ok())
        && *current < minimum
    {
        return Err(UpdateError::MinimumVersion(minimum.to_string()));
    }
    Ok(())
}

/// This build's version.
pub fn current_version() -> semver::Version {
    semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the crate version is a semantic version")
}

async fn channel(state: &AppState) -> ApiResult<Channel> {
    Ok(match crate::settings::get(state, "updates.channel").await?.as_str() {
        Some("preview") => Channel::Preview,
        _ => Channel::Stable,
    })
}

async fn health_timeout(state: &AppState) -> Result<u64, Failure> {
    let value = crate::settings::get(state, "updates.health_timeout_secs").await.map_err(Failure::Api)?;
    Ok(value.as_u64().unwrap_or(60))
}

/// How many versions (binaries and backups) are kept for a return.
pub async fn keep_versions(state: &AppState) -> usize {
    crate::settings::get(state, "updates.keep_versions").await.ok().and_then(|v| v.as_u64()).unwrap_or(3) as usize
}

async fn record_audit(
    state: &AppState,
    actor: &Actor,
    action: &str,
    version: Option<&str>,
    summary: serde_json::Value,
) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    let event = AuditEvent {
        org_id: None,
        actor_user_id: actor.user_id.as_deref(),
        actor_address: actor.address.clone(),
        action,
        resource_type: Some("update"),
        resource_id: version,
        summary,
        at_ms: state.clock.now_ms(),
    };
    audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(())
}

/// Runs the scheduled installations and the daily check until the server stops.
pub fn spawn_background(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        loop {
            tokio::select! {
                () = stopping.cancelled() => return,
                () = tokio::time::sleep(TICK) => {}
            }
            state.updates.tick(&state).await;
        }
    });
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub installed: Installed,
    pub channel: Channel,
    pub check_daily: bool,
    /// The maintenance window, `HH:MM-HH:MM` in the administrator's local time.
    pub window: String,
    pub last_check: Option<LastCheckView>,
    pub available: Option<AvailableView>,
    /// The version the administrator chose to skip.
    pub skipped: Option<String>,
    pub staged: Option<staging::StagedInfo>,
    pub job: Job,
    pub mode: ModeView,
    /// `sqlite` (backed up before every installation) or `postgres` (back it up yourself).
    pub database: &'static str,
    pub schedule: Option<ScheduleView>,
    /// Ids of the keys this build trusts; empty when it trusts none.
    pub trusted_keys: Vec<String>,
    /// What an installation now would involve.
    pub preflight: Preflight,
    /// The largest package an upload may carry.
    pub max_package_bytes: u64,
    pub backups: Vec<install::BackupInfo>,
    pub history: Vec<install::HistoryEntry>,
    /// Names of the users the history and the backups name by id.
    pub people: Vec<Person>,
    pub rollback_targets: Vec<RollbackTarget>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub version: String,
    pub platform: String,
    pub arch: String,
    /// When this version was installed through an update, if it was.
    pub since: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCheckView {
    pub at: i64,
    pub latest: Option<String>,
    pub error: Option<ErrorView>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableView {
    pub version: String,
    pub channel: Channel,
    pub size: u64,
    pub sha256: String,
    pub notes: String,
    pub notes_url: Option<String>,
    pub highlights: Vec<signing::Highlight>,
    pub released_at: Option<String>,
    pub minimum_version: Option<String>,
    pub key_id: String,
    /// Downloaded and verified, ready to install.
    pub staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeView {
    /// Kalzit installs and restarts on its own.
    pub automatic: bool,
    /// Why not (`updates.mode_*`).
    pub reason: Option<&'static str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub version: String,
    pub at: i64,
    pub until: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    /// Size of the SQLite database the backup copies; `None` for PostgreSQL.
    pub backup_bytes: Option<u64>,
    /// Free space on the data directory's disk, if the system says.
    pub free_bytes: Option<u64>,
    /// Users with a request in the last 30 minutes; they see the restart.
    pub active_users: i64,
    /// How long the new version has to report healthy before Kalzit returns.
    pub health_timeout_secs: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackTarget {
    pub version: String,
    pub kept_at: i64,
    /// The database changed since this version ran: returning restores the backup taken when it
    /// was left, and what changed since is lost.
    pub needs_database_restore: bool,
    /// False when the needed backup is gone, or the database is PostgreSQL.
    pub restore_possible: bool,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn read<T>(l: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(|p| p.into_inner())
}

fn write<T>(l: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, minimum: Option<&str>) -> signing::Manifest {
        signing::Manifest {
            format: 1,
            product: "kalzit".into(),
            version: version.into(),
            channel: Channel::Stable,
            released_at: None,
            minimum_version: minimum.map(Into::into),
            notes: String::new(),
            notes_url: None,
            highlights: vec![],
            packages: vec![],
            installers: vec![],
        }
    }

    #[test]
    fn downgrades_and_reinstalls_are_refused() {
        let current = semver::Version::parse("1.4.0").unwrap();
        assert!(version_rules(&current, &manifest("1.5.0", None)).is_ok());
        assert!(matches!(version_rules(&current, &manifest("1.3.9", None)), Err(UpdateError::Downgrade { .. })));
        assert!(matches!(version_rules(&current, &manifest("1.4.0", None)), Err(UpdateError::AlreadyInstalled(_))));
        // A preview of the installed version is older than the version itself.
        assert!(matches!(version_rules(&current, &manifest("1.4.0-rc.1", None)), Err(UpdateError::Downgrade { .. })));
    }

    #[test]
    fn a_minimum_version_above_the_installed_one_is_refused() {
        let current = semver::Version::parse("1.4.0").unwrap();
        assert!(version_rules(&current, &manifest("2.0.0", Some("1.4.0"))).is_ok());
        assert!(matches!(
            version_rules(&current, &manifest("2.0.0", Some("1.5.0"))),
            Err(UpdateError::MinimumVersion(_))
        ));
    }

    #[test]
    fn one_upload_at_a_time_and_only_with_room_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let updates = Updates::new(dir.path(), "sqlite::memory:");
        let first = updates.begin_upload(1).unwrap();
        assert!(matches!(updates.begin_upload(1), Err(UpdateError::Busy)));
        drop(first);
        assert!(updates.begin_upload(1).is_ok());
        assert!(matches!(updates.begin_upload(u64::MAX / 2), Err(UpdateError::DiskFull(_))));
    }

    #[test]
    fn the_stable_channel_takes_only_stable_releases() {
        let mut m = manifest("2.0.0", None);
        assert!(channel_rule(Channel::Stable, &m).is_ok());
        m.channel = Channel::Preview;
        assert!(matches!(channel_rule(Channel::Stable, &m), Err(UpdateError::ChannelMismatch)));
        assert!(channel_rule(Channel::Preview, &m).is_ok());
    }

    #[test]
    fn every_error_has_an_update_reason() {
        let errors = [
            UpdateError::NoTrustedKey,
            UpdateError::Busy,
            UpdateError::ManualOnly("updates.mode_not_systemd"),
            UpdateError::TooLarge(5),
        ];
        for e in errors {
            assert!(e.reason().starts_with("updates."), "{}", e.reason());
            let api: ApiError = e.into();
            assert!(api.reason.is_some());
        }
    }
}
