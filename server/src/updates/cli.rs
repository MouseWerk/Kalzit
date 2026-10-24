//! `kalzit update ...`: installing and returning from the command line, where the server does
//! not install on its own (Windows until the service integration, a console, a binary the
//! service account cannot write). The server must be stopped; the next start runs the same
//! trial with its automatic return as an installation from the web UI.
//!
//! The command usually runs with more rights than the server (root, an Administrator), while
//! the data directory belongs to the service account. So nothing read from the data directory
//! is trusted for what it does with those rights:
//!
//! - A binary (the staged package, a kept version) is opened once and copied into the binary's
//!   own folder, which the service account cannot write, and the copy is checked against the
//!   release's signed SHA-256 before it runs (smoke test) or replaces anything. A return takes
//!   only a kept version whose signed manifest was kept with it.
//! - On Unix, run as root on a data directory another account owns, every access to the data
//!   directory (the lock, the database, backups, kept versions, the plan) runs with that
//!   account's user and group ids; only the copy into the binary's folder, the smoke test and
//!   the final rename run as root. A link planted in the data directory leads nowhere the
//!   service account could not go itself, and the files created there belong to it.
//! - On Windows an Administrator has no such switch: the folders written below `updates/` are
//!   checked not to be links or junctions before they are used.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde_json::json;

use super::install::{self, DatabaseKind, Layout, PlanKind, PlanState, Switch};
use super::platform::{self, Platform};
use super::signing::TrustedKeys;
use super::{current_version, staging, version_rules};
use crate::clock::{Clock, SystemClock};
use crate::config::Config;

/// What the operator sees of the update state.
pub fn status(config: &Config) -> String {
    let layout = Layout::new(&config.paths.data_dir);
    let mut out = format!("installed: {} ({})\n", current_version(), Platform::current().name());
    let keys = TrustedKeys::compiled();
    out += &format!(
        "trusted release keys: {}\n",
        if keys.is_empty() { "none (updates cannot be verified)".to_string() } else { keys.ids().join(", ") }
    );
    match staging::staged_info(&layout) {
        Some(s) => out += &format!("ready to install: {} ({}, {} bytes)\n", s.version, s.source, s.size),
        None => out += "ready to install: nothing\n",
    }
    match install::read_plan_checked(&layout) {
        Ok(Some(plan)) => out += &format!("switch in progress: {} -> {} ({:?})\n", plan.from, plan.to, plan.state),
        Ok(None) => {}
        Err(e) => out += &format!("switch in progress, unreadable: {e}\n"),
    }
    if let Ok(exe) = running_binary()
        && let Some(name) = exe.file_name()
    {
        let kept = install::kept_versions(&layout, name);
        if !kept.is_empty() {
            let names: Vec<&str> = kept.iter().map(|k| k.version.as_str()).collect();
            out += &format!("kept for a return: {}\n", names.join(", "));
        }
    }
    out
}

/// Installs the staged release with the server stopped.
pub async fn apply(config: &Config, acknowledge_no_backup: bool) -> Result<String> {
    let data_dir = &config.paths.data_dir;
    let rights = Rights::detect(data_dir)?;
    // Opened with this command's own rights, before anything else: the binary to keep.
    let exe = running_binary()?;
    let exe_file = std::fs::File::open(&exe).with_context(|| format!("opening {}", exe.display()))?;
    rights.as_owner()?;
    let layout = Layout::new(data_dir);
    let _lock = crate::secrets::hold_exclusive(data_dir)?;
    plain_folders(data_dir, &layout)?;
    settle_previous_plan(&layout)?;
    let current = current_version();
    let staged = staging::load(&layout, &TrustedKeys::compiled(), &Platform::current())?;
    version_rules(&current, &staged.manifest)?;
    let source_kind = staging::staged_info(&layout).map_or_else(|| "offline".to_string(), |s| s.source);
    let url = config.database_url();
    if install::database_kind(&url) == DatabaseKind::Postgres && !acknowledge_no_backup {
        bail!(
            "Kalzit cannot back up a PostgreSQL database. Back it up with pg_dump, then run again with \
             --acknowledge-no-backup"
        );
    }
    // The package, opened with the owner's rights, is copied and checked with this command's.
    let package = std::fs::File::open(&staged.package_path).context("opening the staged package")?;
    rights.as_self()?;
    let placed = install::place_from(package, &exe, &staged.package.sha256, staged.package.size)?;
    platform::smoke_test(placed.path(), &staged.version).await?;
    rights.as_owner()?;

    let db = crate::db::connect(&url, 1).await?;
    let outcome = async {
        let schema = install::schema_version(&db).await.map_err(|e| anyhow!(e.message))?;
        let now = SystemClock.now_ms();
        let backup =
            install::backup_database(&db, &url, &layout, &current, now, install::BackupKind::Switch, None).await?;
        let timeout = health_timeout(&db).await;
        let (plan, placed) = install::record_switch(
            &layout,
            Switch {
                kind: PlanKind::Update,
                from: current.to_string(),
                to: staged.version.clone(),
                exe: exe.clone(),
                exe_file,
                placed,
                release: Some((staged.manifest_bytes.clone(), staged.signature_bytes.clone())),
                backup,
                database: install::sqlite_file(&url),
                schema,
                health_timeout_secs: timeout,
                actor: None,
                now,
                source_kind,
                scheduled: false,
            },
        )?;
        audit(&db, "update.applied", &plan.to, json!({ "from": plan.from, "to": plan.to, "via": "cli" })).await;
        anyhow::Ok((plan, placed))
    }
    .await;
    db.close().await;
    let (plan, placed) = outcome?;
    rights.as_self()?;
    let committed = placed.commit(&exe);
    rights.as_owner()?;
    if let Err(e) = committed {
        install::remove_plan(&layout);
        bail!("putting the new binary in place failed: {e}");
    }
    staging::discard(&layout).ok();
    rights.as_self()?;
    Ok(format!(
        "{} is in place of {}. Start Kalzit now: its first start checks its health and returns to {} on its own \
         if it is not healthy within {} seconds.",
        plan.to, plan.from, plan.from, plan.health_timeout_secs
    ))
}

/// Returns to a kept version with the server stopped. Only a kept version whose signed manifest
/// was kept with it qualifies: its binary is checked against the signed SHA-256.
pub async fn rollback(config: &Config, version: &str, restore_database: bool) -> Result<String> {
    let data_dir = &config.paths.data_dir;
    let rights = Rights::detect(data_dir)?;
    let exe = running_binary()?;
    let exe_file = std::fs::File::open(&exe).with_context(|| format!("opening {}", exe.display()))?;
    rights.as_owner()?;
    let layout = Layout::new(data_dir);
    let _lock = crate::secrets::hold_exclusive(data_dir)?;
    plain_folders(data_dir, &layout)?;
    settle_previous_plan(&layout)?;
    let current = current_version();
    if version == current.to_string() {
        bail!("{version} is the installed version");
    }
    let target = install::kept_version(&layout, version)
        .ok_or_else(|| anyhow!("version {version} is not kept; `kalzit update status` lists the kept ones"))?;
    let kept = install::verify_kept(&layout, version, &exe, &TrustedKeys::compiled(), &Platform::current())?;
    if !kept.signed {
        return Err(super::UpdateError::RollbackUnsigned(version.to_string()).into());
    }
    let url = config.database_url();
    let database = install::sqlite_file(&url);
    let binary = std::fs::File::open(&kept.path).context("opening the kept binary")?;
    rights.as_self()?;
    let placed = install::place_from(binary, &exe, &kept.sha256, kept.size)?;
    rights.as_owner()?;

    let db = crate::db::connect(&url, 1).await?;
    let outcome = async {
        let schema = install::schema_version(&db).await.map_err(|e| anyhow!(e.message))?;
        let restore = if target.schema == schema {
            None
        } else {
            if database.is_none() {
                bail!("{version} used another database schema; restore your PostgreSQL backup of that time instead");
            }
            if !restore_database {
                bail!(
                    "{version} used another database schema: returning restores the backup taken when it was left, \
                     and what changed since is lost. Run again with --restore-database to do that"
                );
            }
            let name = target.backup.as_deref().context("no backup of that version is recorded")?;
            Some(install::backup_path(&layout, name).context("the backup of that version is gone")?)
        };
        let now = SystemClock.now_ms();
        let backup =
            install::backup_database(&db, &url, &layout, &current, now, install::BackupKind::Switch, None).await?;
        let timeout = health_timeout(&db).await;
        let (plan, placed) = install::record_switch(
            &layout,
            Switch {
                kind: PlanKind::Rollback,
                from: current.to_string(),
                to: target.version.clone(),
                exe: exe.clone(),
                exe_file,
                placed,
                release: None,
                backup,
                database: database.clone(),
                schema,
                health_timeout_secs: timeout,
                actor: None,
                now,
                source_kind: "kept".into(),
                scheduled: false,
            },
        )?;
        let summary = json!({ "from": plan.from, "to": plan.to, "restoreDatabase": restore.is_some(), "via": "cli" });
        audit(&db, "update.rollback_started", &plan.to, summary).await;
        anyhow::Ok((plan, placed, restore))
    }
    .await;
    db.close().await;
    let (plan, placed, restore) = outcome?;
    if let (Some(backup), Some(database)) = (restore, database)
        && let Err(e) = install::restore_database(&backup, &database)
    {
        install::remove_plan(&layout);
        bail!("restoring the database failed, nothing was switched: {e}");
    }
    rights.as_self()?;
    let committed = placed.commit(&exe);
    rights.as_owner()?;
    if let Err(e) = committed {
        install::remove_plan(&layout);
        bail!("putting the kept binary in place failed: {e}");
    }
    rights.as_self()?;
    Ok(format!("{} is back in place of {}. Start Kalzit now.", plan.to, plan.from))
}

/// A return the previous start did not record yet (it needs the database the server opens) is
/// written to the history here, so it does not block the command; any other plan does.
fn settle_previous_plan(layout: &Layout) -> Result<()> {
    match install::read_plan_checked(layout).map_err(anyhow::Error::msg)? {
        None => Ok(()),
        Some(plan) if plan.state == PlanState::RolledBack && plan.from == current_version().to_string() => {
            if !plan.recorded {
                install::push_history(layout, install::returned_entry(&plan, SystemClock.now_ms()));
            }
            install::remove_plan(layout);
            Ok(())
        }
        Some(_) => bail!("a switch is still in progress (updates/plan.json); start Kalzit to finish it first"),
    }
}

/// The folders written below the data directory must be real folders, not links or junctions.
fn plain_folders(data_dir: &Path, layout: &Layout) -> Result<()> {
    for dir in [layout.root().to_path_buf(), layout.versions(), layout.backups(), layout.staging()] {
        let Ok(meta) = std::fs::symlink_metadata(&dir) else { continue };
        if !meta.file_type().is_dir() {
            bail!("{} is a link or not a folder; Kalzit does not follow it", dir.display());
        }
    }
    if let Ok(entries) = std::fs::read_dir(layout.versions()) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| !t.is_dir()).unwrap_or(true) {
                bail!("{} is a link or not a folder; Kalzit does not follow it", entry.path().display());
            }
        }
    }
    let _ = data_dir;
    Ok(())
}

fn running_binary() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("finding the running binary")?;
    Ok(std::fs::canonicalize(&exe).unwrap_or(exe))
}

/// `updates.health_timeout_secs` from the environment or the database, else its default.
async fn health_timeout(db: &sqlx::AnyPool) -> u64 {
    let key = "updates.health_timeout_secs";
    let ok = |v: &serde_json::Value| crate::settings::validate(key, v).is_ok();
    if let Ok(raw) = std::env::var(crate::settings::env_var_name(key))
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.trim())
        && ok(&value)
    {
        return value.as_u64().unwrap_or(60);
    }
    let stored: Option<(String,)> = sqlx::query_as("SELECT value FROM server_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    stored
        .and_then(|(v,)| serde_json::from_str::<serde_json::Value>(&v).ok())
        .filter(ok)
        .and_then(|v| v.as_u64())
        .unwrap_or(60)
}

async fn audit(db: &sqlx::AnyPool, action: &str, version: &str, summary: serde_json::Value) {
    let result = async {
        let mut tx = crate::db::begin(db).await?;
        let event = crate::audit::AuditEvent {
            org_id: None,
            actor_user_id: None,
            actor_address: None,
            action,
            resource_type: Some("update"),
            resource_id: Some(version),
            summary,
            at_ms: SystemClock.now_ms(),
        };
        crate::audit::record(&mut tx, &event).await?;
        crate::db::commit(tx).await
    }
    .await;
    if let Err(e) = result {
        eprintln!("kalzit: warning: recording the step in the audit log failed: {e}");
    }
}

/// The rights the command works with in the data directory. On Unix, when it runs as root and
/// the data directory belongs to another account, it switches its effective user, group and
/// supplementary groups to that account for everything in the data directory (`as_owner`) and
/// back for the binary's folder (`as_self`). Elsewhere both are no-ops. Dropped, it is back to
/// its own rights.
struct Rights {
    #[cfg(unix)]
    switch: Option<UnixSwitch>,
}

#[cfg(unix)]
struct UnixSwitch {
    uid: libc::uid_t,
    gid: libc::gid_t,
    groups: Vec<libc::gid_t>,
}

impl Rights {
    fn detect(data_dir: &Path) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // SAFETY: geteuid has no preconditions.
            if unsafe { libc::geteuid() } != 0 {
                return Ok(Self { switch: None });
            }
            let meta = std::fs::metadata(data_dir).with_context(|| format!("reading {}", data_dir.display()))?;
            if meta.uid() == 0 {
                return Ok(Self { switch: None });
            }
            // SAFETY: a null buffer with size 0 asks for the number of groups.
            let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
            let mut groups: Vec<libc::gid_t> = vec![0; count.max(0) as usize];
            // SAFETY: `groups` has room for `count` entries.
            let got = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
            if got < 0 {
                bail!("reading the groups of this process: {}", std::io::Error::last_os_error());
            }
            groups.truncate(got as usize);
            Ok(Self { switch: Some(UnixSwitch { uid: meta.uid(), gid: meta.gid(), groups }) })
        }
        #[cfg(not(unix))]
        {
            let _ = data_dir;
            Ok(Self {})
        }
    }

    /// The data directory owner's rights.
    fn as_owner(&self) -> Result<()> {
        #[cfg(unix)]
        if let Some(s) = &self.switch {
            // SAFETY: plain system calls on values read from the system; checked below.
            let ok = unsafe {
                libc::seteuid(0) == 0
                    && libc::setgroups(1, &s.gid) == 0
                    && libc::setegid(s.gid) == 0
                    && libc::seteuid(s.uid) == 0
            };
            if !ok {
                bail!("taking the rights of the data directory's owner failed: {}", std::io::Error::last_os_error());
            }
        }
        Ok(())
    }

    /// This command's own rights.
    fn as_self(&self) -> Result<()> {
        #[cfg(unix)]
        if let Some(s) = &self.switch {
            // SAFETY: plain system calls; the saved set-user-id is still root, so this succeeds.
            let ok = unsafe {
                libc::seteuid(0) == 0
                    && libc::setegid(0) == 0
                    && libc::setgroups(s.groups.len() as _, s.groups.as_ptr()) == 0
            };
            if !ok {
                bail!("returning to root rights failed: {}", std::io::Error::last_os_error());
            }
        }
        Ok(())
    }
}

impl Drop for Rights {
    fn drop(&mut self) {
        let _ = self.as_self();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_below_updates_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        std::fs::create_dir_all(layout.versions()).unwrap();
        assert!(plain_folders(dir.path(), &layout).is_ok());
        std::fs::write(layout.versions().join("1.0.0"), "not a folder").unwrap();
        assert!(plain_folders(dir.path(), &layout).is_err());
    }

    #[test]
    fn a_return_the_server_did_not_record_does_not_block_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        let plan = install::Plan {
            format: install::PLAN_FORMAT,
            kind: PlanKind::Update,
            from: current_version().to_string(),
            to: "99.0.0".into(),
            exe: dir.path().join("kalzit"),
            previous_sha256: String::new(),
            previous_size: 0,
            backup: None,
            database: None,
            schema: 1,
            migrated: false,
            state: PlanState::RolledBack,
            created_at: 0,
            health_timeout_secs: 60,
            actor: None,
            error: Some("not healthy".into()),
            source: "online".into(),
            scheduled: false,
            recorded: false,
        };
        install::write_plan(&layout, &plan).unwrap();
        settle_previous_plan(&layout).unwrap();
        assert!(install::read_plan(&layout).is_none());
        assert_eq!(install::history(&layout)[0].outcome, install::Outcome::RolledBack);
        // Any other plan still blocks it.
        install::write_plan(&layout, &install::Plan { state: PlanState::Trial, ..plan }).unwrap();
        assert!(settle_previous_plan(&layout).is_err());
    }
}
