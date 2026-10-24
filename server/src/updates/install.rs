//! Putting a release in place and returning from it: the files under `<data dir>/updates`, the
//! database backup, the binary swap, the plan the next start reads, kept versions and the
//! history. Everything here works on paths, so tests run it on a temporary directory with fake
//! binaries.
//!
//! Layout of `<data dir>/updates`:
//!
//! | Path | What |
//! |---|---|
//! | `staging/` | the downloaded or uploaded release, verified (`staging.rs`) |
//! | `versions/<version>/` | a kept binary with `info.json` (schema, backup), for a return |
//! | `backups/` | database backups taken before each switch |
//! | `plan.json` | the switch in progress, read by the next start (`boot.rs`) |
//! | `history.json` | installed and returned versions, newest first |
//! | `state.json` | the last check and a planned installation |

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::UpdateError;
use crate::error::ApiResult;

/// The most history entries kept.
const MAX_HISTORY: usize = 50;

#[derive(Clone, Debug)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("updates") }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn staging(&self) -> PathBuf {
        self.root.join("staging")
    }

    pub fn versions(&self) -> PathBuf {
        self.root.join("versions")
    }

    pub fn backups(&self) -> PathBuf {
        self.root.join("backups")
    }

    pub fn plan_file(&self) -> PathBuf {
        self.root.join("plan.json")
    }

    pub fn history_file(&self) -> PathBuf {
        self.root.join("history.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.root.join("state.json")
    }
}

/// Writes `value` as JSON through a temporary file and a rename, so a reader never sees half a
/// file.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    {
        let mut file = fs::File::create(&tmp)?;
        io::Write::write_all(&mut file, &bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(e) => {
            tracing::warn!("ignoring {}: {e}", path.display());
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanKind {
    /// To a newer release.
    Update,
    /// Back to a kept version.
    Rollback,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanState {
    /// The new binary is in place; its first start begins the trial.
    Swapped,
    /// The new binary started and has not confirmed its health yet. A start that finds this
    /// state returns: the trial ended without a confirmation (a crash, a kill).
    Trial,
    /// The trial failed; the next start returns.
    RollbackRequested,
    /// The previous binary and database are back; the previous version records it at its start.
    RolledBack,
}

/// A switch between two versions, from the moment the new binary is in place until it confirmed
/// its health or Kalzit returned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// 1.
    pub format: u32,
    pub kind: PlanKind,
    pub from: String,
    pub to: String,
    /// The binary that runs Kalzit.
    pub exe: PathBuf,
    /// The kept binary of `from`, put back on a return.
    pub previous: PathBuf,
    /// The database backup taken before the switch (SQLite), restored on a return.
    pub backup: Option<PathBuf>,
    /// The SQLite database file; `None` for PostgreSQL.
    pub database: Option<PathBuf>,
    pub state: PlanState,
    pub created_at: i64,
    /// How long the new version has to report healthy.
    pub health_timeout_secs: u64,
    /// Who started it, for the audit log.
    pub actor: Option<String>,
    /// Why Kalzit returned.
    pub error: Option<String>,
    /// `online` (downloaded), `offline` (uploaded) or `kept` (a return to a kept version).
    #[serde(default)]
    pub source: String,
    /// Started by a planned installation.
    #[serde(default)]
    pub scheduled: bool,
}

pub fn read_plan(layout: &Layout) -> Option<Plan> {
    read_json(&layout.plan_file())
}

pub fn write_plan(layout: &Layout, plan: &Plan) -> io::Result<()> {
    write_json(&layout.plan_file(), plan)
}

pub fn remove_plan(layout: &Layout) {
    if let Err(e) = fs::remove_file(layout.plan_file())
        && e.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!("removing the update plan failed: {e}");
    }
}

/// Keeps a plan that no longer fits the running version aside, for the operator to look at.
pub fn archive_plan(layout: &Layout, now: i64) {
    let target = layout.root().join(format!("plan-{now}.stale.json"));
    if let Err(e) = fs::rename(layout.plan_file(), &target) {
        tracing::warn!("moving the stale update plan aside failed: {e}");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DatabaseKind {
    Sqlite,
    Postgres,
}

impl DatabaseKind {
    pub fn name(self) -> &'static str {
        match self {
            DatabaseKind::Sqlite => "sqlite",
            DatabaseKind::Postgres => "postgres",
        }
    }
}

pub fn database_kind(url: &str) -> DatabaseKind {
    if url.starts_with("sqlite:") { DatabaseKind::Sqlite } else { DatabaseKind::Postgres }
}

/// The SQLite database file, `None` for PostgreSQL and in-memory databases.
pub fn sqlite_file(url: &str) -> Option<PathBuf> {
    crate::db::sqlite_file(url)
}

/// The newest migration applied to Kalzit's database. Two versions with the same number can use
/// the same database.
pub async fn schema_version(db: &sqlx::AnyPool) -> ApiResult<i64> {
    let (version,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success").fetch_one(db).await?;
    Ok(version)
}

/// Why a backup was taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackupKind {
    /// Before a switch away from `version`.
    Switch,
    /// Asked for on the Updates page.
    Manual,
}

/// What `backups/<file>.json` records next to a backup.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    /// The version that wrote the database.
    pub version: String,
    pub at: i64,
    pub kind: BackupKind,
    /// The user who asked for a manual backup.
    pub by: Option<String>,
}

/// A backup as the Updates page lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub file: String,
    pub size: u64,
    #[serde(flatten)]
    pub meta: BackupMeta,
}

fn meta_path(backup: &Path) -> PathBuf {
    backup.with_file_name(format!("{}.json", backup.file_name().unwrap_or_default().to_string_lossy()))
}

/// A consistent copy of the SQLite database (`VACUUM INTO`, safe while the server runs), in
/// `backups/`, with its `.json` record. `None` for PostgreSQL, which Kalzit cannot back up
/// itself.
pub async fn backup_database(
    db: &sqlx::AnyPool,
    url: &str,
    layout: &Layout,
    version: &semver::Version,
    now: i64,
    kind: BackupKind,
    by: Option<String>,
) -> Result<Option<PathBuf>, UpdateError> {
    if sqlite_file(url).is_none() {
        return Ok(None);
    }
    let dir = layout.backups();
    fs::create_dir_all(&dir).map_err(|e| UpdateError::BackupFailed(e.to_string()))?;
    let prefix = match kind {
        BackupKind::Switch => "kalzit",
        BackupKind::Manual => "manual",
    };
    let target = dir.join(format!("{prefix}-{version}-{now}.db"));
    let path =
        target.to_str().ok_or_else(|| UpdateError::BackupFailed("the data directory path is not UTF-8".into()))?;
    sqlx::query("VACUUM INTO $1").bind(path).execute(db).await.map_err(|e| UpdateError::BackupFailed(e.to_string()))?;
    let meta = BackupMeta { version: version.to_string(), at: now, kind, by };
    write_json(&meta_path(&target), &meta).map_err(|e| UpdateError::BackupFailed(e.to_string()))?;
    Ok(Some(target))
}

/// Every backup with its record, newest first.
pub fn list_backups(layout: &Layout) -> Vec<BackupInfo> {
    let Ok(entries) = fs::read_dir(layout.backups()) else { return Vec::new() };
    let mut out: Vec<BackupInfo> = entries
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".db"))
        .filter_map(|e| {
            let path = e.path();
            let meta = read_json::<BackupMeta>(&meta_path(&path))?;
            let size = e.metadata().ok()?.len();
            Some(BackupInfo { file: e.file_name().to_string_lossy().into_owned(), size, meta })
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.meta.at));
    out
}

fn remove_backup(path: &Path) {
    for file in [path.to_path_buf(), meta_path(path)] {
        if let Err(e) = fs::remove_file(&file)
            && e.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!("removing the backup {} failed: {e}", file.display());
        }
    }
}

/// Puts a backup in place of the SQLite database. Only while no connection is open: at a start
/// before the database opens, or after the server stopped. The WAL and shared memory files go
/// first, so the old WAL is never replayed onto the restored file.
pub fn restore_database(backup: &Path, database: &Path) -> io::Result<()> {
    let name = database.file_name().ok_or_else(|| io::Error::other("the database path has no file name"))?;
    let tmp = database.with_file_name(format!("{}.restore", name.to_string_lossy()));
    fs::copy(backup, &tmp)?;
    fs::OpenOptions::new().write(true).open(&tmp)?.sync_all()?;
    for suffix in ["-wal", "-shm"] {
        let side = database.with_file_name(format!("{}{suffix}", name.to_string_lossy()));
        match fs::remove_file(&side) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    fs::rename(&tmp, database)
}

/// Puts `source` in place of the binary `exe`: a copy next to it first (same directory, so the
/// last step is a rename), with the old binary's permissions. On Windows the running binary
/// cannot be replaced but can be renamed, so it moves aside first and is deleted at a later
/// start (`clean_leftovers`).
pub fn install_binary(source: &Path, exe: &Path) -> io::Result<()> {
    let name = exe.file_name().ok_or_else(|| io::Error::other("the binary path has no file name"))?.to_string_lossy();
    let dir = exe.parent().ok_or_else(|| io::Error::other("the binary path has no directory"))?;
    let staged = dir.join(format!(".{name}.new"));
    let _ = fs::remove_file(&staged);
    fs::copy(source, &staged)?;
    let file = fs::OpenOptions::new().write(true).open(&staged)?;
    file.sync_all()?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(exe).map(|m| m.permissions().mode() & 0o7777).unwrap_or(0o755) | 0o100;
        fs::set_permissions(&staged, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(windows)]
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let aside = dir.join(format!(".{name}.old-{stamp}"));
        let moved = exe.exists();
        if moved {
            fs::rename(exe, &aside)?;
        }
        if let Err(e) = fs::rename(&staged, exe) {
            if moved {
                let _ = fs::rename(&aside, exe);
            }
            return Err(e);
        }
        // Fails while the old binary still runs; a later start removes it.
        let _ = fs::remove_file(&aside);
    }
    #[cfg(not(windows))]
    {
        fs::rename(&staged, exe)?;
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Removes binaries moved aside by earlier swaps (Windows) and copies left by an interrupted one.
pub fn clean_leftovers(exe: &Path) {
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name()) else { return };
    let name = name.to_string_lossy();
    let prefix_old = format!(".{name}.old-");
    let new = format!(".{name}.new");
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        if file.starts_with(&prefix_old) || file == new {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// A binary kept for a return.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeptVersion {
    pub version: String,
    /// The binary inside the version's folder.
    pub binary: PathBuf,
    /// `schema_version` while this version ran.
    pub schema: i64,
    /// The backup taken when this version was left.
    pub backup: Option<PathBuf>,
    pub kept_at: i64,
}

fn version_dir(layout: &Layout, version: &str) -> Option<PathBuf> {
    // Only real versions name folders, so a request cannot point outside `versions/`.
    semver::Version::parse(version).ok()?;
    Some(layout.versions().join(version))
}

/// Copies `exe` into the folder of `version` (once) and records its schema and backup.
pub fn keep_version(
    layout: &Layout,
    exe: &Path,
    version: &str,
    schema: i64,
    backup: Option<PathBuf>,
    now: i64,
) -> io::Result<KeptVersion> {
    let dir = version_dir(layout, version).ok_or_else(|| io::Error::other("not a version"))?;
    fs::create_dir_all(&dir)?;
    let name = exe.file_name().ok_or_else(|| io::Error::other("the binary path has no file name"))?;
    let binary = dir.join(name);
    if !binary.is_file() {
        let tmp = dir.join(format!("{}.tmp", name.to_string_lossy()));
        fs::copy(exe, &tmp)?;
        fs::OpenOptions::new().write(true).open(&tmp)?.sync_all()?;
        fs::rename(&tmp, &binary)?;
    }
    let kept = KeptVersion { version: version.to_string(), binary, schema, backup, kept_at: now };
    write_json(&dir.join("info.json"), &kept)?;
    Ok(kept)
}

pub fn kept_version(layout: &Layout, version: &str) -> Option<KeptVersion> {
    let dir = version_dir(layout, version)?;
    read_json::<KeptVersion>(&dir.join("info.json")).filter(|k| k.version == version && k.binary.is_file())
}

/// Every kept version, newest first.
pub fn kept_versions(layout: &Layout) -> Vec<KeptVersion> {
    let Ok(entries) = fs::read_dir(layout.versions()) else { return Vec::new() };
    let mut kept: Vec<KeptVersion> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter_map(|name| kept_version(layout, &name))
        .collect();
    kept.sort_by(|a, b| b.kept_at.cmp(&a.kept_at).then_with(|| b.version.cmp(&a.version)));
    kept
}

/// Keeps the newest `keep` versions and deletes the others with their backups, then backups no
/// kept version or plan refers to; of the manual backups the newest `keep` stay.
pub fn prune(layout: &Layout, keep: usize) {
    let kept = kept_versions(layout);
    for old in kept.iter().skip(keep.max(1)) {
        if let Some(dir) = version_dir(layout, &old.version)
            && let Err(e) = fs::remove_dir_all(&dir)
        {
            tracing::warn!("removing the kept version {} failed: {e}", old.version);
        }
    }
    let mut referenced: Vec<PathBuf> = kept.iter().take(keep.max(1)).filter_map(|k| k.backup.clone()).collect();
    if let Some(plan) = read_plan(layout) {
        referenced.extend(plan.backup);
    }
    let manual: Vec<PathBuf> = list_backups(layout)
        .into_iter()
        .filter(|b| b.meta.kind == BackupKind::Manual)
        .take(keep.max(1))
        .map(|b| layout.backups().join(b.file))
        .collect();
    referenced.extend(manual);
    let Ok(entries) = fs::read_dir(layout.backups()) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|e| e == "json") {
            // A record goes with its backup; one without a backup is left over.
            let backup = path.with_extension("");
            if !backup.exists() {
                let _ = fs::remove_file(&path);
            }
            continue;
        }
        if !referenced.iter().any(|r| same_file(r, &path)) {
            remove_backup(&path);
        }
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b || matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// What a switch needs.
pub struct Switch {
    pub kind: PlanKind,
    pub from: String,
    pub to: String,
    /// The running binary, replaced.
    pub exe: PathBuf,
    /// The binary of `to`.
    pub source: PathBuf,
    /// The backup of the database just taken.
    pub backup: Option<PathBuf>,
    pub database: Option<PathBuf>,
    /// `schema_version` now (the `from` version's).
    pub schema: i64,
    pub health_timeout_secs: u64,
    pub actor: Option<String>,
    pub now: i64,
    /// `online`, `offline` or `kept`.
    pub source_kind: String,
    pub scheduled: bool,
}

/// Keeps the running binary, writes the plan, then puts the new binary in place. The plan comes
/// first: a start that finds it with the old binary still in place sets it aside, while the new
/// binary always finds its plan.
pub fn prepare_update(layout: &Layout, s: Switch) -> Result<Plan, UpdateError> {
    let failed = |e: io::Error| UpdateError::InstallFailed(e.to_string());
    let kept = keep_version(layout, &s.exe, &s.from, s.schema, s.backup.clone(), s.now).map_err(failed)?;
    let plan = Plan {
        format: 1,
        kind: s.kind,
        from: s.from,
        to: s.to,
        exe: s.exe.clone(),
        previous: kept.binary,
        backup: s.backup,
        database: s.database,
        state: PlanState::Swapped,
        created_at: s.now,
        health_timeout_secs: s.health_timeout_secs,
        actor: s.actor,
        error: None,
        source: s.source_kind,
        scheduled: s.scheduled,
    };
    write_plan(layout, &plan).map_err(failed)?;
    if let Err(e) = install_binary(&s.source, &s.exe) {
        remove_plan(layout);
        return Err(failed(e));
    }
    Ok(plan)
}

/// Returns from a failed switch: the database backup (SQLite) and the previous binary go back.
/// Runs at a start, before the database opens.
pub fn roll_back(plan: &Plan) -> io::Result<()> {
    if let (Some(backup), Some(database)) = (&plan.backup, &plan.database) {
        restore_database(backup, database)?;
    }
    install_binary(&plan.previous, &plan.exe)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Installed,
    RolledBack,
    /// Refused or failed before anything changed (a bad signature, a failed backup).
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub version: String,
    pub from: Option<String>,
    pub at: i64,
    pub kind: PlanKind,
    pub outcome: Outcome,
    /// Why Kalzit returned or stopped (English, from the log).
    pub reason: Option<String>,
    /// For an aborted step: its reason code, which the UI translates.
    #[serde(default)]
    pub reason_code: Option<String>,
    /// `online`, `offline` or `kept`.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub scheduled: bool,
    /// The user who started it; `None` for Kalzit itself.
    #[serde(default)]
    pub actor: Option<String>,
    /// From the start of the switch to its end.
    #[serde(default)]
    pub duration_ms: Option<i64>,
}

pub fn history(layout: &Layout) -> Vec<HistoryEntry> {
    read_json(&layout.history_file()).unwrap_or_default()
}

pub fn push_history(layout: &Layout, entry: HistoryEntry) {
    let mut entries = history(layout);
    entries.insert(0, entry);
    entries.truncate(MAX_HISTORY);
    if let Err(e) = write_json(&layout.history_file(), &entries) {
        tracing::warn!("saving the update history failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_binary(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn switch(dir: &Path, exe: &Path, source: &Path, backup: Option<PathBuf>, database: Option<PathBuf>) -> Switch {
        let _ = dir;
        Switch {
            kind: PlanKind::Update,
            from: "1.0.0".into(),
            to: "1.1.0".into(),
            exe: exe.to_path_buf(),
            source: source.to_path_buf(),
            backup,
            database,
            schema: 9,
            health_timeout_secs: 60,
            actor: Some("u1".into()),
            now: 1000,
            source_kind: "online".into(),
            scheduled: false,
        }
    }

    #[test]
    fn an_update_keeps_the_old_binary_writes_the_plan_and_swaps() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("new-kalzit");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        let plan = prepare_update(&layout, switch(dir.path(), &exe, &new, None, None)).unwrap();
        assert_eq!(fs::read_to_string(&exe).unwrap(), "new");
        assert_eq!(fs::read_to_string(&plan.previous).unwrap(), "old");
        assert_eq!(read_plan(&layout).unwrap(), plan);
        assert_eq!(plan.state, PlanState::Swapped);
        let kept = kept_version(&layout, "1.0.0").unwrap();
        assert_eq!(kept.schema, 9);
        clean_leftovers(&exe);
        let names: Vec<String> = fs::read_dir(exe.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into())
            .collect();
        assert_eq!(names, ["kalzit"], "no copies are left next to the binary");
    }

    #[test]
    fn a_failed_swap_removes_the_plan() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("bin").join("kalzit");
        fake_binary(&exe, "old");
        let missing = dir.path().join("does-not-exist");
        let e = prepare_update(&layout, switch(dir.path(), &exe, &missing, None, None)).unwrap_err();
        assert!(matches!(e, UpdateError::InstallFailed(_)), "{e}");
        assert!(read_plan(&layout).is_none());
        assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
    }

    #[test]
    fn a_return_restores_the_database_and_the_previous_binary() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("new-kalzit");
        let database = dir.path().join("data").join("kalzit.db");
        let backup = dir.path().join("data").join("updates").join("backups").join("kalzit-1.0.0-1.db");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        fake_binary(&database, "migrated by 1.1.0");
        fake_binary(&database.with_file_name("kalzit.db-wal"), "wal of 1.1.0");
        fake_binary(&backup, "data of 1.0.0");
        let plan =
            prepare_update(&layout, switch(dir.path(), &exe, &new, Some(backup.clone()), Some(database.clone())))
                .unwrap();
        roll_back(&plan).unwrap();
        assert_eq!(fs::read_to_string(&exe).unwrap(), "old");
        assert_eq!(fs::read_to_string(&database).unwrap(), "data of 1.0.0");
        assert!(!database.with_file_name("kalzit.db-wal").exists(), "the new version's WAL must not be replayed");
        assert!(backup.is_file(), "the backup stays for a later look");
    }

    #[cfg(unix)]
    #[test]
    fn the_new_binary_keeps_the_old_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("kalzit");
        let new = dir.path().join("download");
        fake_binary(&exe, "old");
        fake_binary(&new, "new");
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o750)).unwrap();
        fs::set_permissions(&new, fs::Permissions::from_mode(0o600)).unwrap();
        install_binary(&new, &exe).unwrap();
        assert_eq!(fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn pruning_keeps_the_newest_versions_and_their_backups() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(&dir.path().join("data"));
        let exe = dir.path().join("kalzit");
        fake_binary(&exe, "bin");
        let backups = layout.backups();
        for (i, v) in ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].iter().enumerate() {
            let backup = backups.join(format!("kalzit-{v}.db"));
            fake_binary(&backup, v);
            keep_version(&layout, &exe, v, i as i64, Some(backup), i as i64).unwrap();
        }
        fake_binary(&backups.join("orphan.db"), "x");
        prune(&layout, 2);
        let left: Vec<String> = kept_versions(&layout).into_iter().map(|k| k.version).collect();
        assert_eq!(left, ["1.3.0", "1.2.0"]);
        let mut files: Vec<String> =
            fs::read_dir(&backups).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        files.sort();
        assert_eq!(files, ["kalzit-1.2.0.db", "kalzit-1.3.0.db"]);
    }

    #[test]
    fn version_folders_take_only_versions() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        assert!(version_dir(&layout, "../../etc").is_none());
        assert!(version_dir(&layout, "1.2.3-rc.1").is_some());
        assert!(kept_version(&layout, "..").is_none());
    }

    #[test]
    fn history_is_newest_first_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        for i in 0..60 {
            push_history(
                &layout,
                HistoryEntry {
                    version: format!("1.{i}.0"),
                    from: None,
                    at: i,
                    kind: PlanKind::Update,
                    outcome: Outcome::Installed,
                    reason: None,
                    reason_code: None,
                    source: None,
                    scheduled: false,
                    actor: None,
                    duration_ms: None,
                },
            );
        }
        let entries = history(&layout);
        assert_eq!(entries.len(), MAX_HISTORY);
        assert_eq!(entries[0].version, "1.59.0");
    }

    #[tokio::test]
    async fn the_sqlite_backup_is_a_consistent_copy() {
        let dir = tempfile::tempdir().unwrap();
        let url = crate::config::sqlite_url(&dir.path().join("kalzit.db"));
        let pool = crate::db::connect(&url, 2).await.unwrap();
        sqlx::query("INSERT INTO server_settings (key, value, version, updated_at) VALUES ('x', '1', 1, 0)")
            .execute(&pool)
            .await
            .unwrap();
        let layout = Layout::new(dir.path());
        let version = semver::Version::parse("1.0.0").unwrap();
        let backup =
            backup_database(&pool, &url, &layout, &version, 5, BackupKind::Switch, None).await.unwrap().unwrap();
        let schema = schema_version(&pool).await.unwrap();
        assert!(schema > 0);
        pool.close().await;
        let copy = crate::db::connect(&crate::config::sqlite_url(&backup), 1).await.unwrap();
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM server_settings WHERE key = 'x'").fetch_one(&copy).await.unwrap();
        assert_eq!(n, 1);
        copy.close().await;
        assert!(
            backup_database(&pool, "postgres://h/db", &layout, &version, 6, BackupKind::Manual, None)
                .await
                .unwrap()
                .is_none()
        );
    }
}
