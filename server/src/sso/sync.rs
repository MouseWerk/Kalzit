//! The directory sync of LDAP providers (docs/api/sso.md, "Sync"): reads the people and groups
//! below the base DN, updates the linked accounts and their group mapping, disables accounts whose
//! entry is gone, disabled in the directory or without a mapped group under "refuse", and enables
//! again those it disabled. It halts before changing anything when it would disable more than the
//! provider's threshold, never deletes an account, and runs on one server only
//! (`cluster::spawn_job`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use chrono::TimeZone;
use serde_json::{Value, json};

use super::ldap::{self, DirEntry, Flavor, LdapConfig, LdapFail, Schedule};
use super::mapping::{self, Outcome};
use super::store::{self, ProviderRow};
use crate::app::AppState;
use crate::error::{ApiError, ApiResult};

/// How often the job looks for syncs that are due.
const CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// A run still `running` after this long was cut off (a server stopped during it).
const STALE_RUN_MS: i64 = 30 * 60 * 1000;
const HOUR_MS: i64 = 60 * 60 * 1000;
/// Runs kept per provider.
const KEPT_RUNS: i64 = 200;

/// Why the sync disables an account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    NotInDirectory,
    DisabledInDirectory,
    NoMappedGroup,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::NotInDirectory => "not_in_directory",
            Reason::DisabledInDirectory => "disabled_in_directory",
            Reason::NoMappedGroup => "no_mapped_group",
        }
    }
}

/// Whether disabling `would` of `accounts` enabled accounts is more than `threshold` percent.
pub fn exceeds_threshold(would: usize, accounts: usize, threshold: u8) -> bool {
    would > 0 && (would as u128) * 100 > (accounts as u128) * u128::from(threshold)
}

/// The first time after `after_ms` the schedule says to run, in the time zone `tz` (the server's;
/// `None` for `off`).
pub fn next_run<Tz: TimeZone>(tz: &Tz, schedule: Schedule, hour: u8, after_ms: i64) -> Option<i64> {
    match schedule {
        Schedule::Off => None,
        Schedule::Every6h => Some(after_ms + 6 * HOUR_MS),
        Schedule::Daily => {
            let after = tz.timestamp_millis_opt(after_ms).single()?;
            for offset in 0..3 {
                let day = after.date_naive().checked_add_days(chrono::Days::new(offset))?;
                // The hour, or the first one after it that exists (a clock change can skip it).
                let at = (u32::from(hour)..24)
                    .find_map(|h| day.and_hms_opt(h, 0, 0).and_then(|n| tz.from_local_datetime(&n).earliest()));
                if let Some(at) = at
                    && at.timestamp_millis() > after_ms
                {
                    return Some(at.timestamp_millis());
                }
            }
            None
        }
    }
}

/// What the sync does with one linked account.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Disable it.
    Disable(Reason),
    /// Bring name, email, groups and memberships up to date, and enable it again when the sync
    /// had disabled it.
    Update { entry: Box<DirEntry>, groups: Vec<String>, outcome: Outcome, enable: bool },
    /// Leave it (disabled already, or the break-glass admin).
    Keep,
}

/// One account linked to the provider, as the sync sees it.
#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Linked {
    pub subject: String,
    pub user_id: String,
    pub disabled: i64,
    pub is_server_admin: i64,
    pub name: String,
    pub email: String,
    pub username: Option<String>,
}

/// The decision for `account` given the directory's entry (with its groups) for it.
pub fn decide(
    account: &Linked,
    found: Option<(&DirEntry, &[String])>,
    rules: &[mapping::Rule],
    unmapped: &mapping::Unmapped,
    break_glass: Option<&str>,
    sync_disabled: bool,
) -> Action {
    if break_glass == Some(account.user_id.as_str()) {
        return Action::Keep;
    }
    let enabled = account.disabled == 0;
    let Some((entry, groups)) = found else {
        return if enabled { Action::Disable(Reason::NotInDirectory) } else { Action::Keep };
    };
    if entry.disabled {
        return if enabled { Action::Disable(Reason::DisabledInDirectory) } else { Action::Keep };
    }
    let outcome = mapping::resolve(rules, groups, unmapped);
    // Server admins are never refused by the unmapped rule (`sso::signin`).
    if outcome.refused && account.is_server_admin == 0 {
        return if enabled { Action::Disable(Reason::NoMappedGroup) } else { Action::Keep };
    }
    if !enabled && !sync_disabled {
        // Disabled by an admin: the sync leaves it alone.
        return Action::Keep;
    }
    Action::Update { entry: Box::new(entry.clone()), groups: groups.to_vec(), outcome, enable: !enabled }
}

/// How a run started.
pub enum Trigger {
    Schedule,
    Manual,
    /// "Trotzdem anwenden": the halted run `run_id`, whose list `approved` an admin (`by`) let go.
    Apply {
        run_id: String,
        approved: BTreeSet<String>,
        by: String,
    },
}

impl Trigger {
    fn kind(&self) -> &'static str {
        match self {
            Trigger::Schedule => "schedule",
            Trigger::Manual => "manual",
            Trigger::Apply { .. } => "apply",
        }
    }
}

/// What the directory says, read before anything changes.
struct Reading {
    entries: HashMap<String, (DirEntry, Vec<String>)>,
    checked: usize,
}

/// Every person below the base DN with their groups, by stable id.
async fn read_directory(state: &AppState, provider: &ProviderRow, config: &LdapConfig) -> Result<Reading, LdapFail> {
    let secret = store::secret(&state.db, &state.secrets, &provider.id, ldap::BIND_PASSWORD)
        .await
        .map_err(|e| LdapFail::Other(e.message))?
        .ok_or_else(|| LdapFail::Other("the provider has no bind password".into()))?;
    let connector = state.sso.ldap_sync(state);
    let mut dir = ldap::service(&connector, config, &secret).await?;
    let outcome = read_with(&mut dir, state, provider, config).await;
    dir.close().await;
    outcome
}

async fn read_with(
    dir: &mut ldap::Directory,
    state: &AppState,
    provider: &ProviderRow,
    config: &LdapConfig,
) -> Result<Reading, LdapFail> {
    let raw = dir.search_all(&config.user_base_dn, &config.people_filter(), &config.person_attributes()).await?;
    let checked = raw.len();
    let people: Vec<DirEntry> = raw.iter().map(|e| DirEntry::read(config, e)).collect();
    let mapped: Vec<String> =
        super::directory::mapped_groups(state, &provider.id).await.map_err(|e| LdapFail::Other(e.message))?;
    let mut extra: HashMap<String, Vec<String>> = HashMap::new();
    match config.flavor {
        Flavor::Ad if config.nested_groups => {
            // Through groups in groups: who is in each mapped group, one search per group.
            for group in mapped.iter().filter(|g| ldap::valid_dn(g)) {
                let filter = format!(
                    "(&{}(memberOf:{}:={}))",
                    config.people_filter(),
                    ldap::IN_CHAIN,
                    ldap::escape_filter(group)
                );
                let members =
                    dir.search_all(&config.user_base_dn, &filter, &[config.id_attribute().to_string()]).await?;
                for m in &members {
                    if let Some(id) = DirEntry::read(config, m).id {
                        extra.entry(id).or_default().push(group.clone());
                    }
                }
            }
        }
        Flavor::Ad => {}
        Flavor::Ldap => {
            let groups = dir
                .search_all(
                    config.group_base(),
                    "(|(objectClass=groupOfNames)(objectClass=groupOfUniqueNames)(objectClass=posixGroup))",
                    &["member".to_string(), "uniqueMember".to_string(), "memberUid".to_string()],
                )
                .await?;
            let mut by_dn: HashMap<String, Vec<String>> = HashMap::new();
            let mut by_uid: HashMap<String, Vec<String>> = HashMap::new();
            for g in &groups {
                for (attr, values) in &g.attrs {
                    let target = if attr.eq_ignore_ascii_case("memberUid") { &mut by_uid } else { &mut by_dn };
                    for v in values {
                        target.entry(v.to_lowercase()).or_default().push(g.dn.clone());
                    }
                }
            }
            for p in &people {
                let Some(id) = &p.id else { continue };
                let mut list = by_dn.get(&p.dn.to_lowercase()).cloned().unwrap_or_default();
                if let Some(uid) = &p.uid {
                    list.extend(by_uid.get(&uid.to_lowercase()).cloned().unwrap_or_default());
                }
                extra.insert(id.clone(), list);
            }
        }
    }
    let mut entries = HashMap::new();
    for p in people {
        let Some(id) = p.id.clone() else { continue };
        let mut groups = if config.flavor == Flavor::Ad { p.member_of.clone() } else { Vec::new() };
        groups.extend(extra.remove(&id).unwrap_or_default());
        let person = super::directory::person(config, &p, groups, &mapped);
        let groups = person.map(|p| p.groups).unwrap_or_default();
        entries.insert(id, (p, groups));
    }
    Ok(Reading { entries, checked })
}

/// The accounts linked to `provider_id` (service accounts never are).
async fn linked(state: &AppState, provider_id: &str) -> ApiResult<Vec<Linked>> {
    Ok(sqlx::query_as(
        "SELECT i.subject, i.user_id, u.disabled, u.is_server_admin, u.name, u.email, i.username \
         FROM sso_identities i JOIN users u ON u.id = i.user_id WHERE i.provider_id = $1 AND u.service_account = 0 \
         ORDER BY i.user_id",
    )
    .bind(provider_id)
    .fetch_all(&state.db)
    .await?)
}

async fn audit_system(
    conn: &mut sqlx::AnyConnection,
    actor: Option<&str>,
    action: &'static str,
    resource: (&'static str, &str),
    summary: Value,
    now: i64,
) -> ApiResult<()> {
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: actor,
        actor_address: None,
        action,
        resource_type: Some(resource.0),
        resource_id: Some(resource.1),
        summary,
        at_ms: now,
    };
    Ok(crate::audit::record(conn, &event).await?)
}

/// Claims the provider's sync on this server (and, through the runs table, across servers).
struct Claim<'a> {
    state: &'a AppState,
    provider_id: String,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.state.sso.syncing.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&self.provider_id);
    }
}

fn running() -> ApiError {
    crate::routes::support::conflict("a sync of this provider is running").because("ldap.sync_running")
}

/// Runs a sync of `provider` now and answers the run as the API shows it.
pub async fn run(state: &AppState, provider: &ProviderRow, trigger: Trigger) -> ApiResult<Value> {
    if !state.sso.syncing.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(provider.id.clone()) {
        return Err(running());
    }
    let _claim = Claim { state, provider_id: provider.id.clone() };
    let config = provider.ldap()?;
    let now = state.clock.now_ms();
    let run_id = crate::routes::new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    // A run of another server still going (not cut off by a stop) holds the provider.
    let other: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM ldap_sync_runs WHERE provider_id = $1 AND status = 'running' AND started_at > $2 LIMIT 1",
    )
    .bind(&provider.id)
    .bind(now - STALE_RUN_MS)
    .fetch_optional(&mut *tx)
    .await?;
    if other.is_some() {
        return Err(running());
    }
    sqlx::query("UPDATE ldap_sync_runs SET status = 'failed', error = $1, finished_at = $2 WHERE provider_id = $3 AND status = 'running'")
        .bind("the server stopped during the run")
        .bind(now)
        .bind(&provider.id)
        .execute(&mut *tx)
        .await?;
    let inserted = sqlx::query(
        "INSERT INTO ldap_sync_runs (id, provider_id, trigger_kind, status, started_at, threshold) \
         VALUES ($1, $2, $3, 'running', $4, $5)",
    )
    .bind(&run_id)
    .bind(&provider.id)
    .bind(trigger.kind())
    .bind(now)
    .bind(i64::from(config.sync_threshold))
    .execute(&mut *tx)
    .await;
    // Another server started one at the same moment (`ldap_sync_runs_one_running`).
    match inserted {
        Err(e) if crate::routes::support::is_unique_violation(&e) => return Err(running()),
        other => other?,
    };
    crate::db::commit(tx).await?;
    let outcome = sync_now(state, provider, &config, &run_id, &trigger).await;
    if let Err(e) = outcome {
        let finished = state.clock.now_ms();
        let mut conn = state.db.acquire().await?;
        sqlx::query("UPDATE ldap_sync_runs SET status = 'failed', error = $1, finished_at = $2 WHERE id = $3")
            .bind(e.to_string())
            .bind(finished)
            .bind(&run_id)
            .execute(&mut *conn)
            .await?;
        let summary = json!({ "providerId": provider.id, "runId": run_id, "error": e.to_string() });
        audit_system(&mut conn, None, "ldap.sync_failed", ("sso_provider", &provider.id), summary, finished).await?;
        tracing::warn!(provider = %provider.slug, "the directory sync failed: {e}");
    }
    run_json(state, &run_id, false).await
}

#[derive(Default)]
struct Counts {
    changed: i64,
    deactivated: i64,
    reactivated: i64,
    skipped: i64,
}

async fn sync_now(
    state: &AppState,
    provider: &ProviderRow,
    config: &LdapConfig,
    run_id: &str,
    trigger: &Trigger,
) -> Result<(), LdapFail> {
    let reading = read_directory(state, provider, config).await?;
    let internal = |e: ApiError| LdapFail::Other(e.message);
    let accounts = linked(state, &provider.id).await.map_err(internal)?;
    let rules = mapping::rules(&state.db, &provider.id).await.map_err(internal)?;
    let unmapped = super::unmapped(state).await.map_err(internal)?;
    let break_glass = super::local_policy(state).await.map_err(internal)?.break_glass;
    let disabled_by_sync: BTreeSet<String> =
        sqlx::query_as::<_, (String,)>("SELECT user_id FROM ldap_deactivations WHERE provider_id = $1")
            .bind(&provider.id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| LdapFail::Other(e.to_string()))?
            .into_iter()
            .map(|(u,)| u)
            .collect();
    let enabled = accounts.iter().filter(|a| a.disabled == 0).count();
    let plan: Vec<(&Linked, Action)> = accounts
        .iter()
        .map(|a| {
            let found = reading.entries.get(&a.subject).map(|(e, g)| (e, g.as_slice()));
            let action =
                decide(a, found, &rules, &unmapped, break_glass.as_deref(), disabled_by_sync.contains(&a.user_id));
            (a, action)
        })
        .collect();
    let would: Vec<(&Linked, Reason)> = plan
        .iter()
        .filter_map(|(a, action)| match action {
            Action::Disable(r) => Some((*a, *r)),
            _ => None,
        })
        .collect();
    let now = state.clock.now_ms();
    let db_fail = |e: sqlx::Error| LdapFail::Other(e.to_string());
    if !matches!(trigger, Trigger::Apply { .. }) && exceeds_threshold(would.len(), enabled, config.sync_threshold) {
        let pending: Vec<Value> =
            would.iter().map(|(a, r)| json!({ "userId": a.user_id, "reason": r.as_str() })).collect();
        let mut tx = crate::db::begin(&state.db).await.map_err(db_fail)?;
        sqlx::query(
            "UPDATE ldap_sync_runs SET status = 'halted', finished_at = $1, checked = $2, would_deactivate = $3, \
             accounts = $4, pending = $5 WHERE id = $6",
        )
        .bind(now)
        .bind(reading.checked as i64)
        .bind(would.len() as i64)
        .bind(enabled as i64)
        .bind(Value::Array(pending).to_string())
        .bind(run_id)
        .execute(&mut *tx)
        .await
        .map_err(db_fail)?;
        let summary = json!({ "providerId": provider.id, "runId": run_id, "wouldDeactivate": would.len(),
                              "accounts": enabled, "threshold": config.sync_threshold });
        audit_system(&mut tx, None, "ldap.sync_halted", ("sso_provider", &provider.id), summary, now)
            .await
            .map_err(internal)?;
        crate::db::commit(tx).await.map_err(db_fail)?;
        crate::mail::notify_ldap_sync_halted(state, &provider.name, would.len(), enabled, config.sync_threshold);
        tracing::warn!(provider = %provider.slug, would = would.len(), accounts = enabled, "the directory sync halted");
        return Ok(());
    }
    let mut counts = Counts::default();
    let mut touched = BTreeSet::new();
    for (account, action) in &plan {
        let result = match action {
            Action::Keep => Ok(()),
            Action::Disable(reason) => {
                if let Trigger::Apply { approved, .. } = trigger
                    && !approved.contains(&account.user_id)
                {
                    counts.skipped += 1;
                    continue;
                }
                disable(state, provider, run_id, account, *reason, now, &mut counts).await
            }
            Action::Update { entry, groups, outcome, enable } => {
                update(state, provider, account, entry, groups, outcome, *enable, now, &mut counts, &mut touched).await
            }
        };
        result.map_err(internal)?;
    }
    super::rights_changed(state, &touched).await;
    let finished = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await.map_err(db_fail)?;
    sqlx::query(
        "UPDATE ldap_sync_runs SET status = 'done', finished_at = $1, checked = $2, changed = $3, deactivated = $4, \
         reactivated = $5, skipped = $6, would_deactivate = $7, accounts = $8 WHERE id = $9",
    )
    .bind(finished)
    .bind(reading.checked as i64)
    .bind(counts.changed)
    .bind(counts.deactivated)
    .bind(counts.reactivated)
    .bind(counts.skipped)
    .bind(would.len() as i64)
    .bind(enabled as i64)
    .bind(run_id)
    .execute(&mut *tx)
    .await
    .map_err(db_fail)?;
    let summary = json!({ "providerId": provider.id, "runId": run_id, "checked": reading.checked,
                          "changed": counts.changed, "deactivated": counts.deactivated,
                          "reactivated": counts.reactivated, "skipped": counts.skipped });
    audit_system(&mut tx, None, "ldap.sync_finished", ("sso_provider", &provider.id), summary, finished)
        .await
        .map_err(internal)?;
    if let Trigger::Apply { run_id: halted, by, .. } = trigger {
        sqlx::query(
            "UPDATE ldap_sync_runs SET status = 'applied', applied_by = $1, applied_at = $2, applied_run = $3 WHERE id = $4",
        )
        .bind(by)
        .bind(finished)
        .bind(run_id)
        .bind(halted)
        .execute(&mut *tx)
        .await
        .map_err(db_fail)?;
        let summary = json!({ "providerId": provider.id, "haltedRunId": halted, "runId": run_id,
                              "deactivated": counts.deactivated });
        audit_system(&mut tx, Some(by), "ldap.sync_applied", ("sso_provider", &provider.id), summary, finished)
            .await
            .map_err(internal)?;
    }
    // Old runs go; the audit log keeps what they did.
    sqlx::query(
        "DELETE FROM ldap_sync_runs WHERE provider_id = $1 AND id NOT IN \
         (SELECT id FROM ldap_sync_runs WHERE provider_id = $2 ORDER BY started_at DESC LIMIT $3)",
    )
    .bind(&provider.id)
    .bind(&provider.id)
    .bind(KEPT_RUNS)
    .execute(&mut *tx)
    .await
    .map_err(db_fail)?;
    crate::db::commit(tx).await.map_err(db_fail)?;
    Ok(())
}

/// Disables `account` and ends its sessions, unless that would leave the server without an
/// enabled admin or an organization without an enabled owner (then it is skipped).
async fn disable(
    state: &AppState,
    provider: &ProviderRow,
    run_id: &str,
    account: &Linked,
    reason: Reason,
    now: i64,
    counts: &mut Counts,
) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    let admins = crate::authz::lock_server_admins(&mut tx).await?;
    let current: Option<(i64, i64)> = sqlx::query_as("SELECT disabled, is_server_admin FROM users WHERE id = $1")
        .bind(&account.user_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((disabled, is_admin)) = current else { return Ok(()) };
    if disabled != 0 {
        return Ok(());
    }
    if crate::authz::ensure_admin_remains(is_admin != 0, false, admins).is_err()
        || crate::authz::lock_orgs_left_without_owner(&mut tx, &account.user_id).await? > 0
    {
        counts.skipped += 1;
        return Ok(());
    }
    sqlx::query("UPDATE users SET disabled = 1 WHERE id = $1").bind(&account.user_id).execute(&mut *tx).await?;
    crate::auth::session::delete_for_user(&mut *tx, &account.user_id, None).await?;
    sqlx::query(
        "INSERT INTO ldap_deactivations (user_id, provider_id, run_id, reason, login, at) VALUES ($1, $2, $3, $4, $5, $6) \
         ON CONFLICT (user_id, provider_id) DO UPDATE SET run_id = excluded.run_id, reason = excluded.reason, \
         login = excluded.login, at = excluded.at",
    )
    .bind(&account.user_id)
    .bind(&provider.id)
    .bind(run_id)
    .bind(reason.as_str())
    .bind(account.username.as_deref())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let summary = json!({ "userId": account.user_id, "cause": "ldap_sync", "reason": reason.as_str(),
                          "providerId": provider.id, "runId": run_id });
    audit_system(&mut tx, None, "user.disabled", ("user", &account.user_id), summary, now).await?;
    crate::db::commit(tx).await?;
    counts.deactivated += 1;
    Ok(())
}

#[expect(clippy::too_many_arguments, reason = "one account's update with what the run counts")]
async fn update(
    state: &AppState,
    provider: &ProviderRow,
    account: &Linked,
    entry: &DirEntry,
    groups: &[String],
    outcome: &Outcome,
    enable: bool,
    now: i64,
    counts: &mut Counts,
    touched: &mut BTreeSet<String>,
) -> ApiResult<()> {
    let mut tx = crate::db::begin(&state.db).await?;
    let mut changed = false;
    if let Some(name) =
        entry.name.as_deref().map(|n| n.chars().filter(|c| !c.is_control()).take(100).collect::<String>())
        && !name.trim().is_empty()
        && name != account.name
    {
        sqlx::query("UPDATE users SET name = $1 WHERE id = $2")
            .bind(&name)
            .bind(&account.user_id)
            .execute(&mut *tx)
            .await?;
        changed = true;
    }
    // A new address only when it is valid and no other account has it; it counts as confirmed only
    // when the provider trusts the directory's addresses (`trustEmail`), as for a new account.
    if let Some(email) = entry.email.as_deref().and_then(|e| crate::routes::normalize_email(e).ok())
        && !crate::routes::same_email(&email, &account.email)
    {
        let trusted = provider.ldap().is_ok_and(|c| c.trust_email);
        let others = crate::routes::all_accounts_with_email(&mut tx, &email).await?;
        if others.iter().all(|(id, _)| id == &account.user_id) {
            sqlx::query("UPDATE users SET email = $1, email_confirmed = $2 WHERE id = $3")
                .bind(&email)
                .bind(i64::from(trusted))
                .bind(&account.user_id)
                .execute(&mut *tx)
                .await?;
            changed = true;
        }
    }
    let stored: Vec<(String,)> = sqlx::query_as(
        "SELECT group_name FROM sso_identity_groups WHERE provider_id = $1 AND subject = $2 ORDER BY group_name",
    )
    .bind(&provider.id)
    .bind(&account.subject)
    .fetch_all(&mut *tx)
    .await?;
    let stored: BTreeSet<String> = stored.into_iter().map(|(g,)| g).collect();
    let now_groups: BTreeSet<String> = groups.iter().cloned().collect();
    if stored != now_groups {
        sqlx::query("DELETE FROM sso_identity_groups WHERE provider_id = $1 AND subject = $2")
            .bind(&provider.id)
            .bind(&account.subject)
            .execute(&mut *tx)
            .await?;
        for group in &now_groups {
            sqlx::query("INSERT INTO sso_identity_groups (provider_id, subject, group_name) VALUES ($1, $2, $3)")
                .bind(&provider.id)
                .bind(&account.subject)
                .bind(group)
                .execute(&mut *tx)
                .await?;
        }
        changed = true;
    }
    if entry.login.is_some() && entry.login != account.username {
        sqlx::query("UPDATE sso_identities SET username = $1 WHERE provider_id = $2 AND subject = $3")
            .bind(entry.login.as_deref())
            .bind(&provider.id)
            .bind(&account.subject)
            .execute(&mut *tx)
            .await?;
    }
    if enable {
        sqlx::query("UPDATE users SET disabled = 0 WHERE id = $1").bind(&account.user_id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM ldap_deactivations WHERE user_id = $1 AND provider_id = $2")
            .bind(&account.user_id)
            .bind(&provider.id)
            .execute(&mut *tx)
            .await?;
        let summary = json!({ "userId": account.user_id, "cause": "ldap_sync", "providerId": provider.id });
        audit_system(&mut tx, None, "user.enabled", ("user", &account.user_id), summary, now).await?;
        counts.reactivated += 1;
    }
    // The memberships follow the groups as at a sign-in (a refused outcome only takes away what
    // the provider decided), recorded as the sync's change.
    let refused = Outcome { refused: true, orgs: Vec::new() };
    let effective = if outcome.refused { &refused } else { outcome };
    let (changes, gave) = mapping::apply(&mut tx, &provider.id, &account.user_id, effective, now).await?;
    if !changes.is_empty() {
        let summary = json!({ "provider": provider.slug, "changes": changes, "cause": "ldap_sync" });
        audit_system(&mut tx, None, "sso.memberships_changed", ("user", &account.user_id), summary, now).await?;
        changed = true;
    }
    crate::db::commit(tx).await?;
    touched.extend(gave);
    if changed {
        counts.changed += 1;
    }
    Ok(())
}

/// A run as the API shows it; `with_pending` adds the accounts a halted run would disable.
pub async fn run_json(state: &AppState, run_id: &str, with_pending: bool) -> ApiResult<Value> {
    type Row = (String, String, String, i64, Option<i64>, i64, i64, i64, i64, i64, i64, i64, i64);
    let row: Option<Row> = sqlx::query_as(
        "SELECT id, trigger_kind, status, started_at, finished_at, checked, changed, deactivated, reactivated, skipped, \
         would_deactivate, accounts, threshold FROM ldap_sync_runs WHERE id = $1",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(r) = row else { return Err(ApiError::not_found()) };
    let extra: (Option<String>, Option<String>, Option<String>, Option<i64>) =
        sqlx::query_as("SELECT error, pending, applied_by, applied_at FROM ldap_sync_runs WHERE id = $1")
            .bind(run_id)
            .fetch_one(&state.db)
            .await?;
    let mut out = json!({
        "id": r.0, "trigger": r.1, "status": r.2, "startedAt": r.3, "finishedAt": r.4, "checked": r.5,
        "changed": r.6, "deactivated": r.7, "reactivated": r.8, "skipped": r.9, "wouldDeactivate": r.10,
        "accounts": r.11, "threshold": r.12, "error": extra.0, "appliedBy": extra.2, "appliedAt": extra.3,
    });
    if with_pending {
        let list: Vec<Value> = extra.1.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
        let mut pending = Vec::new();
        for item in list {
            let user_id = item["userId"].as_str().unwrap_or_default().to_string();
            let who: Option<(String, String)> = sqlx::query_as("SELECT name, email FROM users WHERE id = $1")
                .bind(&user_id)
                .fetch_optional(&state.db)
                .await?;
            let login: Option<(Option<String>,)> =
                sqlx::query_as("SELECT username FROM sso_identities WHERE user_id = $1 LIMIT 1")
                    .bind(&user_id)
                    .fetch_optional(&state.db)
                    .await?;
            if let Some((name, email)) = who {
                pending.push(json!({ "userId": user_id, "name": name, "email": email,
                                     "login": login.and_then(|(l,)| l), "reason": item["reason"] }));
            }
        }
        out["pending"] = Value::Array(pending);
    }
    Ok(out)
}

/// The start of the last run of `provider_id`, or when the provider was made.
async fn last_start(state: &AppState, provider_id: &str) -> ApiResult<i64> {
    let (last,): (Option<i64>,) =
        sqlx::query_as("SELECT MAX(started_at) FROM ldap_sync_runs WHERE provider_id = $1 AND trigger_kind <> 'apply'")
            .bind(provider_id)
            .fetch_one(&state.db)
            .await?;
    if let Some(at) = last {
        return Ok(at);
    }
    let (created,): (i64,) = sqlx::query_as("SELECT created_at FROM sso_providers WHERE id = $1")
        .bind(provider_id)
        .fetch_one(&state.db)
        .await?;
    Ok(created)
}

/// The sync status of a provider (`GET /admin/sign-in/providers/{id}/sync`).
pub async fn status_json(state: &AppState, provider: &ProviderRow) -> ApiResult<Value> {
    let config = provider.ldap()?;
    let ids: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM ldap_sync_runs WHERE provider_id = $1 ORDER BY started_at DESC, id DESC LIMIT 20",
    )
    .bind(&provider.id)
    .fetch_all(&state.db)
    .await?;
    let mut runs = Vec::new();
    for (id,) in &ids {
        runs.push(run_json(state, id, false).await?);
    }
    let mut failures = 0;
    for run in &runs {
        match run["status"].as_str() {
            Some("failed") => failures += 1,
            Some("running") => {}
            _ => break,
        }
    }
    let base = last_start(state, &provider.id).await?;
    let next = if provider.enabled != 0 {
        next_run(&chrono::Local, config.sync_schedule, config.sync_hour, base)
    } else {
        None
    };
    let rows: Vec<(String, String, String, Option<String>, i64, String)> = sqlx::query_as(
        "SELECT d.user_id, u.name, u.email, d.login, d.at, d.reason FROM ldap_deactivations d \
         JOIN users u ON u.id = d.user_id WHERE d.provider_id = $1 AND u.disabled = 1 ORDER BY d.at DESC, u.name",
    )
    .bind(&provider.id)
    .fetch_all(&state.db)
    .await?;
    let deactivated: Vec<Value> = rows
        .into_iter()
        .map(|(user_id, name, email, login, at, reason)| {
            json!({ "userId": user_id, "name": name, "email": email, "login": login, "at": at, "reason": reason })
        })
        .collect();
    Ok(json!({
        "schedule": config.sync_schedule, "hour": config.sync_hour, "threshold": config.sync_threshold,
        "nextRunAt": next, "failuresInRow": failures, "runs": runs, "deactivated": deactivated,
    }))
}

/// Runs the syncs that are due, every few minutes, on one server only.
pub fn spawn(state: AppState) {
    let schedule = crate::db::Schedule { interval: CHECK_INTERVAL, retries: Vec::new() };
    let job_state = state.clone();
    crate::cluster::spawn_job(&state, "ldap:sync", "syncing LDAP directories", schedule, move || {
        let state = job_state.clone();
        async move {
            due_syncs(&state).await.map_err(|e| crate::db::JobError::Failed(e.message))?;
            Ok(())
        }
    });
}

async fn due_syncs(state: &AppState) -> ApiResult<()> {
    let now = state.clock.now_ms();
    for provider in super::directory::enabled(state).await? {
        let Ok(config) = provider.ldap() else { continue };
        let base = last_start(state, &provider.id).await?;
        let due = next_run(&chrono::Local, config.sync_schedule, config.sync_hour, base).is_some_and(|at| at <= now);
        if !due {
            continue;
        }
        match run(state, &provider, Trigger::Schedule).await {
            Ok(_) => {}
            Err(e) if e.reason.as_ref().is_some_and(|r| r.code == "ldap.sync_running") => {}
            Err(e) => tracing::warn!(provider = %provider.slug, "the directory sync did not run: {}", e.message),
        }
    }
    Ok(())
}

/// The ids of a halted run's list.
pub async fn halted_list(state: &AppState, provider_id: &str, run_id: &str) -> ApiResult<BTreeSet<String>> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT status, pending FROM ldap_sync_runs WHERE id = $1 AND provider_id = $2")
            .bind(run_id)
            .bind(provider_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((status, pending)) = row else { return Err(ApiError::not_found()) };
    if status != "halted" {
        return Err(crate::routes::support::conflict("the run is not halted, or was applied already")
            .because("ldap.sync_not_halted"));
    }
    let list: Vec<BTreeMap<String, Value>> =
        pending.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or_default();
    Ok(list.into_iter().filter_map(|m| m.get("userId").and_then(Value::as_str).map(str::to_string)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::Berlin;

    fn ms(tz: &chrono_tz::Tz, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        tz.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap().timestamp_millis()
    }

    #[test]
    fn the_threshold_halts_above_its_percentage() {
        // 58 of 412 is 14 %: above 10 %.
        assert!(exceeds_threshold(58, 412, 10));
        // Exactly 10 % is allowed, one more is not.
        assert!(!exceeds_threshold(10, 100, 10));
        assert!(exceeds_threshold(11, 100, 10));
        assert!(!exceeds_threshold(0, 0, 10));
        assert!(!exceeds_threshold(0, 5, 1));
        // With very few accounts a single one can exceed it.
        assert!(exceeds_threshold(1, 3, 10));
        assert!(!exceeds_threshold(3, 3, 100));
        // An empty directory with accounts: everything would go.
        assert!(exceeds_threshold(412, 412, 10));
    }

    #[test]
    fn daily_runs_at_the_hour_in_server_time() {
        let tz = Berlin;
        // Made at 01:30: today at 02:00.
        assert_eq!(next_run(&tz, Schedule::Daily, 2, ms(&tz, 2026, 10, 27, 1, 30)), Some(ms(&tz, 2026, 10, 27, 2, 0)));
        // Ran at 02:00: tomorrow at 02:00.
        assert_eq!(next_run(&tz, Schedule::Daily, 2, ms(&tz, 2026, 10, 27, 2, 0)), Some(ms(&tz, 2026, 10, 28, 2, 0)));
        assert_eq!(next_run(&tz, Schedule::Daily, 2, ms(&tz, 2026, 10, 27, 14, 0)), Some(ms(&tz, 2026, 10, 28, 2, 0)));
        // 02:00 does not exist on 29 March 2026 in Berlin: the run is at 03:00 that day.
        assert_eq!(next_run(&tz, Schedule::Daily, 2, ms(&tz, 2026, 3, 28, 12, 0)), Some(ms(&tz, 2026, 3, 29, 3, 0)));
        assert_eq!(next_run(&tz, Schedule::Every6h, 2, 1_000), Some(1_000 + 6 * HOUR_MS));
        assert_eq!(next_run(&tz, Schedule::Off, 2, 1_000), None);
        assert_eq!(next_run(&chrono::Utc, Schedule::Daily, 0, 0), Some(24 * HOUR_MS));
    }

    fn account(id: &str, disabled: bool, admin: bool) -> Linked {
        Linked {
            subject: format!("s-{id}"),
            user_id: id.into(),
            disabled: i64::from(disabled),
            is_server_admin: i64::from(admin),
            name: "N".into(),
            email: format!("{id}@example.de"),
            username: None,
        }
    }

    #[test]
    fn decisions_per_account() {
        let rules = vec![mapping::Rule {
            id: "r".into(),
            group_name: "CN=Leser".into(),
            org_id: "o".into(),
            team_id: None,
            role: "viewer".into(),
            idp_decides: 0,
        }];
        let refuse = mapping::Unmapped { refuse: true, org_id: None, role: "viewer".into() };
        let let_in = mapping::Unmapped { refuse: false, org_id: None, role: "viewer".into() };
        let entry = DirEntry { dn: "uid=a".into(), id: Some("s-a".into()), ..Default::default() };
        let locked = DirEntry { disabled: true, ..entry.clone() };
        let leser = vec!["CN=Leser".to_string()];
        let none: Vec<String> = Vec::new();
        let a = account("a", false, false);
        assert_eq!(decide(&a, None, &rules, &refuse, None, false), Action::Disable(Reason::NotInDirectory));
        assert_eq!(
            decide(&a, Some((&locked, &leser)), &rules, &refuse, None, false),
            Action::Disable(Reason::DisabledInDirectory)
        );
        assert_eq!(
            decide(&a, Some((&entry, &none)), &rules, &refuse, None, false),
            Action::Disable(Reason::NoMappedGroup)
        );
        // Under the default role nobody is disabled for missing groups.
        assert!(matches!(
            decide(&a, Some((&entry, &none)), &rules, &let_in, None, false),
            Action::Update { enable: false, .. }
        ));
        assert!(matches!(
            decide(&a, Some((&entry, &leser)), &rules, &refuse, None, false),
            Action::Update { enable: false, .. }
        ));
        // Server admins are not refused for missing groups.
        let admin = account("a", false, true);
        assert!(matches!(decide(&admin, Some((&entry, &none)), &rules, &refuse, None, false), Action::Update { .. }));
        // The break-glass admin is never touched.
        assert_eq!(decide(&a, None, &rules, &refuse, Some("a"), false), Action::Keep);
        // Disabled by the sync and fine again: enabled; disabled by an admin: left alone.
        let off = account("a", true, false);
        assert!(matches!(
            decide(&off, Some((&entry, &leser)), &rules, &refuse, None, true),
            Action::Update { enable: true, .. }
        ));
        assert_eq!(decide(&off, Some((&entry, &leser)), &rules, &refuse, None, false), Action::Keep);
        assert_eq!(decide(&off, None, &rules, &refuse, None, true), Action::Keep);
    }
}
