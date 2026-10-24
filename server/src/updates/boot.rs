//! The start of a new version: a trial with a deadline, and the return when it fails.
//!
//! `guard` runs first thing at `kalzit serve`, before the database opens, and reads the plan an
//! installation left (`install::Plan`):
//!
//! - The new binary's first start (`swapped`) begins the trial: the plan says `trial`, and a
//!   watchdog thread waits `health_timeout_secs`. The server starts as usual; once it answers
//!   `/readyz` and its listeners accept connections, `Trial::confirm` removes the plan, records
//!   the installation and stops the watchdog.
//! - A failed start (migrations, a listener), a failed health check or the watchdog's deadline
//!   mark the plan `rollbackRequested` and start the binary again. That start, and any start
//!   that finds a `trial` plan (the trial ended without a confirmation: a crash, a kill), puts the
//!   database backup and the previous binary back before anything opens the database, marks the
//!   plan `rolledBack` and starts the previous binary, which records the return.
//!
//! The return runs in a fresh process because only then is it sure that no connection still
//! writes to the database being replaced.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::install::{self, HistoryEntry, Layout, Outcome, Plan, PlanState};
use super::{Actor, Handover};
use crate::app::AppState;
use crate::config::Config;

/// The longest and shortest trial, whatever the plan says.
const MIN_TRIAL: u64 = 15;
const MAX_TRIAL: u64 = 1800;

/// What `kalzit serve` does after the guard.
#[derive(Debug)]
#[expect(clippy::large_enum_variant, reason = "made once per start and matched at once")]
pub enum Boot {
    /// Start the server, in a trial when there is one.
    Run(Option<Trial>),
    /// Start this binary instead (the previous version after a return).
    Relaunch(PathBuf),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrialState {
    Pending,
    Confirmed,
    Expired,
}

/// The first start of a new version, until it confirmed its health or failed.
#[derive(Debug)]
pub struct Trial {
    layout: Layout,
    plan: Plan,
    deadline: Instant,
    /// Shared with the watchdog, so a confirmation and the deadline cannot both win.
    state: Arc<Mutex<TrialState>>,
}

pub fn guard(config: &Config) -> Boot {
    let layout = Layout::new(&config.paths.data_dir);
    let boot = guard_with(&layout, &super::current_version().to_string(), now_ms());
    if let Boot::Run(Some(trial)) = &boot {
        trial.spawn_watchdog();
    }
    boot
}

fn now_ms() -> i64 {
    use crate::clock::Clock;
    crate::clock::SystemClock.now_ms()
}

/// The start of `kalzit serve` failed on the configuration. If this is the first start of a new
/// version (a plan says so), Kalzit returns to the previous one, which accepted the
/// configuration: `Some` is the binary to start instead. `data_dir` comes from
/// `Config::data_dir_hint`, since the configuration itself did not load.
pub fn after_config_error(data_dir: &std::path::Path, error: &str) -> Option<PathBuf> {
    let layout = Layout::new(data_dir);
    match guard_after_config_error(&layout, &super::current_version().to_string(), error, now_ms()) {
        Boot::Relaunch(exe) => Some(exe),
        Boot::Run(_) => None,
    }
}

/// `after_config_error` for the running `version`, without the clock (tests).
pub fn guard_after_config_error(layout: &Layout, version: &str, error: &str, now: i64) -> Boot {
    let plan = match install::read_plan_checked(layout) {
        Ok(Some(plan)) => plan,
        Ok(None) => return Boot::Run(None),
        Err(e) => {
            tracing::error!("{e}");
            return Boot::Run(None);
        }
    };
    let trial = matches!(plan.state, PlanState::Swapped | PlanState::Trial | PlanState::RollbackRequested);
    if plan.to != version || !trial {
        return Boot::Run(None);
    }
    let _ = now;
    return_to_previous(layout, plan, &format!("the new version refused the configuration: {error}"))
}

/// The guard's decision for the running `version`, without the watchdog (tests).
pub fn guard_with(layout: &Layout, version: &str, now: i64) -> Boot {
    let mut plan = match install::read_plan_checked(layout) {
        Ok(Some(plan)) => plan,
        Ok(None) => return Boot::Run(None),
        Err(e) => {
            // A switch is in progress, but nobody can tell which; the operator decides.
            tracing::error!(
                "{e}. An update may be half done: check that the binary is the version you want and \
                 restore a backup from updates/backups if needed. The plan is set aside"
            );
            install::archive_plan(layout, now, "unreadable");
            return Boot::Run(None);
        }
    };
    install::clean_leftovers(&plan.exe);
    if plan.to == version {
        match plan.state {
            PlanState::Swapped => {
                plan.state = PlanState::Trial;
                if let Err(e) = install::write_plan(layout, &plan) {
                    // Without the trial mark a crash would not lead back; run without a trial
                    // rather than not at all.
                    tracing::error!("cannot record the update trial, starting without it: {e}");
                    return Boot::Run(None);
                }
                let secs = plan.health_timeout_secs.clamp(MIN_TRIAL, MAX_TRIAL);
                tracing::info!(
                    "first start of {} after the update from {}: it has {secs} s to report healthy",
                    plan.to,
                    plan.from
                );
                let deadline = Instant::now() + Duration::from_secs(secs);
                let trial =
                    Trial { layout: layout.clone(), plan, deadline, state: Arc::new(Mutex::new(TrialState::Pending)) };
                Boot::Run(Some(trial))
            }
            PlanState::Trial => return_to_previous(layout, plan, "the new version stopped before it reported healthy"),
            PlanState::RollbackRequested => {
                let reason = plan.error.clone().unwrap_or_else(|| "the new version did not report healthy".into());
                return_to_previous(layout, plan, &reason)
            }
            PlanState::RolledBack => {
                tracing::error!(
                    "the return from {} to {} did not put the previous binary back; check {}",
                    plan.to,
                    plan.from,
                    plan.exe.display()
                );
                install::archive_plan(layout, now, "stale");
                Boot::Run(None)
            }
        }
    } else if plan.from == version && plan.state == PlanState::RolledBack {
        // `Updates::record_outcome` records it once the database is open.
        Boot::Run(None)
    } else {
        tracing::warn!(
            "an update plan from {} to {} does not fit the running version {version}; it is set aside",
            plan.from,
            plan.to
        );
        install::archive_plan(layout, now, "stale");
        Boot::Run(None)
    }
}

fn return_to_previous(layout: &Layout, mut plan: Plan, reason: &str) -> Boot {
    // PostgreSQL has no backup Kalzit could restore: once the new version changed the schema,
    // the previous binary would not start on it. The new version stays, loudly.
    if plan.database.is_none() && plan.migrated {
        tracing::error!(
            "{reason}. Kalzit does not return to {}: the new version already changed the PostgreSQL schema, \
             which {} cannot use. {} keeps running; restore your pg_dump and install {} by hand to go back",
            plan.from,
            plan.from,
            plan.to,
            plan.from
        );
        install::archive_plan(layout, now_ms(), "kept-new");
        return Boot::Run(None);
    }
    tracing::error!("{reason}; returning to {}", plan.from);
    match install::roll_back(layout, &plan) {
        Ok(()) => {
            plan.state = PlanState::RolledBack;
            plan.error = Some(reason.to_string());
            if let Err(e) = install::write_plan(layout, &plan) {
                tracing::warn!("recording the return failed: {e}");
            }
            Boot::Relaunch(plan.exe)
        }
        Err(e) => {
            tracing::error!(
                "returning to {} failed: {e}. The binary {} stays; restore it and the database from {} by hand",
                plan.from,
                plan.exe.display(),
                plan.backup
                    .as_deref()
                    .map_or_else(|| "your own backup".to_string(), |b| format!("updates/backups/{b}"))
            );
            install::archive_plan(layout, now_ms(), "failed-return");
            Boot::Run(None)
        }
    }
}

impl Trial {
    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    /// When the health check must have passed.
    pub fn deadline(&self) -> Instant {
        self.deadline
    }

    fn spawn_watchdog(&self) {
        let state = self.state.clone();
        let layout = self.layout.clone();
        let deadline = self.deadline;
        let exe = self.plan.exe.clone();
        std::thread::spawn(move || {
            while Instant::now() < deadline {
                if *lock(&state) != TrialState::Pending {
                    return;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            let mut s = lock(&state);
            if *s != TrialState::Pending {
                return;
            }
            *s = TrialState::Expired;
            mark_failed(&layout, "the new version did not report healthy in time");
            drop(s);
            tracing::error!("the update trial ran out of time; starting again to return to the previous version");
            restart_now(&exe);
        });
    }

    /// PostgreSQL: the started version changed the schema (`schema` is the schema now), so a
    /// return could not work any more; the plan says so for the next start.
    pub fn note_schema(&self, schema: i64) {
        if self.plan.database.is_some() || schema == self.plan.schema {
            return;
        }
        if let Some(mut plan) = install::read_plan(&self.layout) {
            plan.migrated = true;
            if let Err(e) = install::write_plan(&self.layout, &plan) {
                tracing::error!("recording the schema change of the update failed: {e}");
            }
        }
    }

    /// The health check passed: the plan goes, the installation is recorded.
    pub async fn confirm(&self, state: &AppState) -> Result<(), String> {
        {
            let mut s = lock(&self.state);
            if *s != TrialState::Pending {
                return Err("the trial already ended".into());
            }
            // The plan goes first: once it is gone, no later start returns.
            std::fs::remove_file(self.layout.plan_file()).map_err(|e| format!("removing the update plan: {e}"))?;
            *s = TrialState::Confirmed;
        }
        let plan = &self.plan;
        tracing::info!("{} reported healthy; the update from {} is complete", plan.to, plan.from);
        install::push_history(
            &self.layout,
            HistoryEntry {
                version: plan.to.clone(),
                from: Some(plan.from.clone()),
                at: state.clock.now_ms(),
                kind: plan.kind,
                outcome: Outcome::Installed,
                reason: None,
                reason_code: None,
                source: Some(plan.source.clone()),
                scheduled: plan.scheduled,
                actor: plan.actor.clone(),
                duration_ms: Some((state.clock.now_ms() - plan.created_at).max(0)),
            },
        );
        let exe_name = plan.exe.file_name().unwrap_or_default().to_os_string();
        install::prune(&self.layout, super::keep_versions(state).await, &plan.to, &exe_name);
        let actor = Actor { user_id: plan.actor.clone(), address: None };
        let summary = serde_json::json!({ "from": plan.from, "to": plan.to, "kind": plan.kind });
        super::record_audit(state, &actor, "update.installed", Some(&plan.to), summary).await.map_err(|e| e.message)
    }

    /// The trial failed (`reason`): the plan asks the next start to return, and the server hands
    /// over to this binary again, which does it.
    pub fn fail(&self, reason: &str) -> Option<Handover> {
        let mut s = lock(&self.state);
        if *s != TrialState::Pending {
            return None;
        }
        *s = TrialState::Expired;
        tracing::error!("the update trial failed: {reason}");
        mark_failed(&self.layout, reason);
        Some(Handover { exe: self.plan.exe.clone(), restore: None })
    }
}

fn mark_failed(layout: &Layout, reason: &str) {
    if let Some(mut plan) = install::read_plan(layout) {
        plan.state = PlanState::RollbackRequested;
        plan.error = Some(reason.to_string());
        if let Err(e) = install::write_plan(layout, &plan) {
            tracing::error!("recording the failed trial failed: {e}");
        }
    }
}

/// Ends this process at once and starts `exe` again. On Unix the image is replaced, which stops
/// every thread (and with them every database write) in one step. Windows only ends the
/// process: the return then happens at the next start (by an administrator, or a service
/// wrapper that restarts Kalzit).
fn restart_now(exe: &std::path::Path) -> ! {
    #[cfg(unix)]
    {
        let _ = super::platform::relaunch(exe);
    }
    let _ = exe;
    std::process::exit(1)
}

/// What the server does after it stopped for a handover: a database restore it needs, then the
/// next binary.
pub fn handover(h: &Handover) -> std::process::ExitCode {
    if let Some((backup, database)) = &h.restore
        && let Err(e) = install::restore_database(backup, database)
    {
        tracing::error!(
            "restoring the database from {} failed: {e}; the next start returns if it cannot open it",
            backup.display()
        );
    }
    super::platform::relaunch(&h.exe)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::*;
    use crate::updates::install::{PlanKind, Switch, place_binary, prepare_update};

    struct Setup {
        _dir: tempfile::TempDir,
        layout: Layout,
        exe: PathBuf,
        database: PathBuf,
    }

    /// An installation from 1.0.0 to 1.1.0 with fake binaries and a fake database (`None`:
    /// PostgreSQL).
    fn installed_with(sqlite: bool) -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let layout = Layout::new(&data);
        let exe = dir.path().join("bin").join("kalzit");
        let new = dir.path().join("download");
        let database = data.join("kalzit.db");
        let backup = layout.backups().join("kalzit-1.0.0-1.db");
        for (path, content) in
            [(&exe, "binary 1.0.0"), (&new, "binary 1.1.0"), (&database, "data 1.0.0"), (&backup, "data 1.0.0")]
        {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let placed = place_binary(&new, &exe, &crate::updates::signing::sha256_hex(b"binary 1.1.0"), 12).unwrap();
        prepare_update(
            &layout,
            Switch {
                kind: PlanKind::Update,
                from: "1.0.0".into(),
                to: "1.1.0".into(),
                exe: exe.clone(),
                exe_file: fs::File::open(&exe).unwrap(),
                placed,
                release: None,
                backup: sqlite.then(|| "kalzit-1.0.0-1.db".to_string()),
                database: sqlite.then(|| database.clone()),
                schema: 9,
                health_timeout_secs: 30,
                actor: None,
                now: 1,
                source_kind: "online".into(),
                scheduled: false,
            },
        )
        .unwrap();
        // The new version migrated the database.
        fs::write(&database, "data 1.1.0").unwrap();
        Setup { _dir: dir, layout, exe, database }
    }

    fn installed() -> Setup {
        installed_with(true)
    }

    fn content(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn the_first_start_of_the_new_version_is_a_trial() {
        let s = installed();
        let Boot::Run(Some(trial)) = guard_with(&s.layout, "1.1.0", 2) else { panic!("no trial") };
        assert_eq!(trial.plan().to, "1.1.0");
        assert_eq!(install::read_plan(&s.layout).unwrap().state, PlanState::Trial);
    }

    #[test]
    fn a_start_after_an_unconfirmed_trial_returns() {
        let s = installed();
        let Boot::Run(Some(_)) = guard_with(&s.layout, "1.1.0", 2) else { panic!("no trial") };
        // The trial process died without confirming; the next start of the new binary returns.
        let Boot::Relaunch(exe) = guard_with(&s.layout, "1.1.0", 3) else { panic!("no return") };
        assert_eq!(exe, s.exe);
        assert_eq!(content(&s.exe), "binary 1.0.0");
        assert_eq!(content(&s.database), "data 1.0.0");
        let plan = install::read_plan(&s.layout).unwrap();
        assert_eq!(plan.state, PlanState::RolledBack);
        // The previous version starts normally and keeps the plan for its record.
        assert!(matches!(guard_with(&s.layout, "1.0.0", 4), Boot::Run(None)));
        assert!(install::read_plan(&s.layout).is_some());
    }

    #[test]
    fn a_failed_health_check_returns_at_the_next_start() {
        let s = installed();
        let Boot::Run(Some(trial)) = guard_with(&s.layout, "1.1.0", 2) else { panic!("no trial") };
        let handover = trial.fail("readyz answered 503").unwrap();
        assert_eq!(handover.exe, s.exe);
        assert!(trial.fail("again").is_none(), "a trial fails once");
        assert_eq!(install::read_plan(&s.layout).unwrap().state, PlanState::RollbackRequested);
        let Boot::Relaunch(_) = guard_with(&s.layout, "1.1.0", 3) else { panic!("no return") };
        assert_eq!(content(&s.exe), "binary 1.0.0");
        assert_eq!(install::read_plan(&s.layout).unwrap().error.as_deref(), Some("readyz answered 503"));
    }

    #[test]
    fn a_new_version_that_refuses_the_configuration_returns() {
        let s = installed();
        let Boot::Relaunch(exe) = guard_after_config_error(&s.layout, "1.1.0", "unknown key x.y", 2) else {
            panic!("no return")
        };
        assert_eq!(exe, s.exe);
        assert_eq!(content(&s.exe), "binary 1.0.0");
        let plan = install::read_plan(&s.layout).unwrap();
        assert_eq!(plan.state, PlanState::RolledBack);
        assert!(plan.error.unwrap().contains("unknown key x.y"));
        // The previous version with the same configuration error is not an update problem.
        assert!(matches!(guard_after_config_error(&s.layout, "1.0.0", "unknown key x.y", 3), Boot::Run(None)));
    }

    #[test]
    fn a_configuration_error_without_a_switch_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(guard_after_config_error(&Layout::new(dir.path()), "1.0.0", "bad", 1), Boot::Run(None)));
    }

    #[test]
    fn postgresql_after_a_schema_change_keeps_the_new_version() {
        let s = installed_with(false);
        let Boot::Run(Some(trial)) = guard_with(&s.layout, "1.1.0", 2) else { panic!("no trial") };
        trial.note_schema(10);
        trial.fail("readyz answered 503").unwrap();
        assert!(matches!(guard_with(&s.layout, "1.1.0", 3), Boot::Run(None)), "no return");
        assert_eq!(content(&s.exe), "binary 1.1.0");
        assert!(install::read_plan(&s.layout).is_none(), "the plan is set aside");
    }

    #[test]
    fn postgresql_without_a_schema_change_returns() {
        let s = installed_with(false);
        let Boot::Run(Some(trial)) = guard_with(&s.layout, "1.1.0", 2) else { panic!("no trial") };
        trial.note_schema(9);
        trial.fail("readyz answered 503").unwrap();
        assert!(matches!(guard_with(&s.layout, "1.1.0", 3), Boot::Relaunch(_)));
        assert_eq!(content(&s.exe), "binary 1.0.0");
    }

    #[test]
    fn an_unreadable_plan_is_set_aside_loudly() {
        let s = installed();
        fs::write(s.layout.plan_file(), "{ not json").unwrap();
        assert!(matches!(guard_with(&s.layout, "1.1.0", 7), Boot::Run(None)));
        assert!(s.layout.root().join("plan-7.unreadable.json").is_file());
    }

    #[test]
    fn a_plan_that_does_not_fit_is_set_aside() {
        let s = installed();
        // The old binary still runs (the swap never happened as planned).
        assert!(matches!(guard_with(&s.layout, "1.0.0", 5), Boot::Run(None)));
        assert!(install::read_plan(&s.layout).is_none());
        assert!(s.layout.root().join("plan-5.stale.json").is_file());
    }

    #[test]
    fn without_a_plan_nothing_happens() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(guard_with(&Layout::new(dir.path()), "1.0.0", 1), Boot::Run(None)));
    }
}
