//! `kalzit update ...`: installing and returning from the command line, where the server does
//! not install on its own (Windows until the service integration, a console, a binary the
//! service account cannot write). The server must be stopped; the next start runs the same
//! trial with its automatic return as an installation from the web UI.

use anyhow::{Context, Result, anyhow, bail};
use serde_json::json;

use super::install::{self, DatabaseKind, Layout, PlanKind, Switch};
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
    if let Some(plan) = install::read_plan(&layout) {
        out += &format!("switch in progress: {} -> {} ({:?})\n", plan.from, plan.to, plan.state);
    }
    let kept = install::kept_versions(&layout);
    if !kept.is_empty() {
        let names: Vec<&str> = kept.iter().map(|k| k.version.as_str()).collect();
        out += &format!("kept for a return: {}\n", names.join(", "));
    }
    out
}

/// Installs the staged release with the server stopped.
pub async fn apply(config: &Config, acknowledge_no_backup: bool) -> Result<String> {
    let data_dir = &config.paths.data_dir;
    let _lock = crate::secrets::hold_exclusive(data_dir)?;
    let layout = Layout::new(data_dir);
    if install::read_plan(&layout).is_some() {
        bail!("a switch is still in progress (updates/plan.json); start Kalzit to finish it first");
    }
    let current = current_version();
    let staged = staging::load(&layout, &TrustedKeys::compiled(), &Platform::current())?;
    version_rules(&current, &staged.manifest)?;
    let staged_source = staging::staged_info(&layout).map_or_else(|| "offline".to_string(), |s| s.source);
    let url = config.database_url();
    if install::database_kind(&url) == DatabaseKind::Postgres && !acknowledge_no_backup {
        bail!(
            "Kalzit cannot back up a PostgreSQL database. Back it up with pg_dump, then run again with \
             --acknowledge-no-backup"
        );
    }
    platform::smoke_test(&staged.package_path, &staged.version).await?;
    let exe = running_binary()?;
    let db = crate::db::connect(&url, 1).await?;
    let outcome = async {
        let schema = install::schema_version(&db).await.map_err(|e| anyhow!(e.message))?;
        let now = SystemClock.now_ms();
        let backup =
            install::backup_database(&db, &url, &layout, &current, now, install::BackupKind::Switch, None).await?;
        let timeout = health_timeout(&db).await;
        let plan = install::prepare_update(
            &layout,
            Switch {
                kind: PlanKind::Update,
                from: current.to_string(),
                to: staged.version.clone(),
                exe: exe.clone(),
                source: staged.package_path.clone(),
                backup,
                database: install::sqlite_file(&url),
                schema,
                health_timeout_secs: timeout,
                actor: None,
                now,
                source_kind: staged_source.clone(),
                scheduled: false,
            },
        )?;
        audit(&db, "update.applied", &plan.to, json!({ "from": plan.from, "to": plan.to, "via": "cli" })).await;
        anyhow::Ok(plan)
    }
    .await;
    db.close().await;
    let plan = outcome?;
    staging::discard(&layout).ok();
    fix_ownership(config);
    Ok(format!(
        "{} is in place of {}. Start Kalzit now: its first start checks its health and returns to {} on its own \
         if it is not healthy within {} seconds.",
        plan.to, plan.from, plan.from, plan.health_timeout_secs
    ))
}

/// Returns to a kept version with the server stopped.
pub async fn rollback(config: &Config, version: &str, restore_database: bool) -> Result<String> {
    let data_dir = &config.paths.data_dir;
    let _lock = crate::secrets::hold_exclusive(data_dir)?;
    let layout = Layout::new(data_dir);
    if install::read_plan(&layout).is_some() {
        bail!("a switch is still in progress (updates/plan.json); start Kalzit to finish it first");
    }
    let current = current_version();
    let target = install::kept_version(&layout, version)
        .filter(|k| k.version != current.to_string())
        .ok_or_else(|| anyhow!("version {version} is not kept; `kalzit update status` lists the kept ones"))?;
    let url = config.database_url();
    let database = install::sqlite_file(&url);
    let exe = running_binary()?;
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
            Some(target.backup.clone().filter(|b| b.is_file()).context("the backup of that version is gone")?)
        };
        let now = SystemClock.now_ms();
        let backup =
            install::backup_database(&db, &url, &layout, &current, now, install::BackupKind::Switch, None).await?;
        let timeout = health_timeout(&db).await;
        let plan = install::prepare_update(
            &layout,
            Switch {
                kind: PlanKind::Rollback,
                from: current.to_string(),
                to: target.version.clone(),
                exe: exe.clone(),
                source: target.binary.clone(),
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
        anyhow::Ok((plan, restore))
    }
    .await;
    db.close().await;
    let (plan, restore) = outcome?;
    if let (Some(backup), Some(database)) = (restore, database) {
        install::restore_database(&backup, &database).context("restoring the database")?;
    }
    fix_ownership(config);
    Ok(format!("{} is back in place of {}. Start Kalzit now.", plan.to, plan.from))
}

fn running_binary() -> Result<std::path::PathBuf> {
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

/// Files this command created belong to whoever owns the data directory, so a command run as
/// root does not leave files the service account cannot use (Linux).
#[cfg(unix)]
fn fix_ownership(config: &Config) {
    use std::os::unix::fs::MetadataExt;
    let data_dir = &config.paths.data_dir;
    let Ok(meta) = std::fs::metadata(data_dir) else { return };
    let (uid, gid) = (meta.uid(), meta.gid());
    let mut paths = vec![Layout::new(data_dir).root().to_path_buf()];
    if let Some(db) = install::sqlite_file(&config.database_url()) {
        for suffix in ["", "-wal", "-shm"] {
            paths.push(std::path::PathBuf::from(format!("{}{suffix}", db.display())));
        }
    }
    while let Some(path) = paths.pop() {
        let Ok(m) = std::fs::symlink_metadata(&path) else { continue };
        if m.is_dir()
            && let Ok(entries) = std::fs::read_dir(&path)
        {
            paths.extend(entries.flatten().map(|e| e.path()));
        }
        if (m.uid(), m.gid()) != (uid, gid)
            && let Err(e) = std::os::unix::fs::lchown(&path, Some(uid), Some(gid))
        {
            eprintln!("kalzit: warning: {} keeps its owner ({e}); give it to the service account", path.display());
        }
    }
}

#[cfg(not(unix))]
fn fix_ownership(_config: &Config) {}
