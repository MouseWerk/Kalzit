//! Settings that can change at runtime, server-wide or per organization. Every setting is declared
//! in `REGISTRY` with its scope, default and whether the UI may change it.
//!
//! The effective value of a server setting comes from the first layer that has one:
//!
//! 1. the environment: `KALZIT_<SECTION>_<KEY>` for settings that live in the configuration
//!    (`sessions.lifetime_hours`), `KALZIT_SETTING_<KEY>` for all others, the key in upper snake
//!    case (`audit.retention_days` is `KALZIT_SETTING_AUDIT_RETENTION_DAYS`, its value JSON or a
//!    plain string);
//! 2. the configuration file `kalzit.toml`, for settings that live in the configuration;
//! 3. the `server_settings` table, written through the API;
//! 4. the default in `REGISTRY`.
//!
//! Organization settings are the `org_settings` table, then the default. A setting set in the
//! environment or file is read-only in the UI. Database values are cached per process and the
//! cache is dropped on every write; other server processes on the same database see a change
//! within `CACHE_TTL_MS`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use serde::Serialize;
use serde_json::{Value, json};

use crate::app::AppState;
use crate::config::Config;
use crate::error::{ApiError, ApiResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Server,
    Org,
}

pub struct SettingDef {
    pub key: &'static str,
    pub scope: Scope,
    pub default: fn() -> Value,
    /// Settings that could lock an admin out (network, TLS) are file or environment only.
    pub ui_editable: bool,
    /// English. The UI shows its own label and description from `ui/src/i18n/*/admin.json`
    /// (a test there fails for a key without them) and this text only for keys it does not know.
    pub description: &'static str,
}

pub const REGISTRY: &[SettingDef] = &[
    SettingDef {
        key: "datasources.sqlite_dirs",
        scope: Scope::Server,
        default: || json!([]),
        ui_editable: true,
        description: "Directories SQLite data sources may open. Never the data directory.",
    },
    SettingDef {
        key: "datasources.file_dirs",
        scope: Scope::Server,
        default: || json!([]),
        ui_editable: true,
        description: "Directories CSV and JSON file data sources may read. Never the data directory.",
    },
    SettingDef {
        key: "datasources.allowed_targets",
        scope: Scope::Server,
        default: || json!([]),
        ui_editable: true,
        description: "If not empty, data sources may only connect to these hosts and networks.",
    },
    SettingDef {
        key: "datasources.query_timeout_secs",
        scope: Scope::Server,
        default: || json!(30),
        ui_editable: true,
        description: "Longest a single query may run.",
    },
    SettingDef {
        key: "datasources.max_rows",
        scope: Scope::Server,
        default: || json!(100_000),
        ui_editable: true,
        description: "Most rows, points, documents or nodes one query returns.",
    },
    SettingDef {
        key: "datasources.max_response_bytes",
        scope: Scope::Server,
        default: || json!(50 * 1024 * 1024),
        ui_editable: true,
        description: "Largest result one request may produce, all its queries together.",
    },
    SettingDef {
        key: "datasources.max_parallel_queries",
        scope: Scope::Server,
        default: || json!(64),
        ui_editable: true,
        description: "Queries running at once on the whole server; further ones wait for a free slot, at most until their time limit runs out.",
    },
    SettingDef {
        key: "datasources.max_inflight_bytes",
        scope: Scope::Server,
        default: || json!(1024 * 1024 * 1024),
        ui_editable: true,
        description: "Result bytes all running queries together may hold.",
    },
    SettingDef {
        key: "audit.retention_days",
        scope: Scope::Server,
        default: || json!(365),
        ui_editable: true,
        description: "Audit events older than this are deleted, since they hold client addresses.",
    },
    SettingDef {
        key: "appearance.default_language",
        scope: Scope::Server,
        default: || json!("de"),
        ui_editable: true,
        description: "Language of the UI for users who have not chosen one.",
    },
    SettingDef {
        key: "appearance.default_theme",
        scope: Scope::Server,
        default: || json!("system"),
        ui_editable: true,
        description: "Theme of the UI for users who have not chosen one.",
    },
    SettingDef {
        key: "sessions.lifetime_hours",
        scope: Scope::Server,
        default: || json!(30 * 24),
        ui_editable: false,
        description: "A session ends this long after sign-in. Set in kalzit.toml or the environment.",
    },
    SettingDef {
        key: "sessions.idle_timeout_hours",
        scope: Scope::Server,
        default: || json!(7 * 24),
        ui_editable: false,
        description: "A session ends after this long without a request (0: never). Set in kalzit.toml or the environment.",
    },
    SettingDef {
        key: "dashboards.version_retention",
        scope: Scope::Server,
        default: || json!(100),
        ui_editable: true,
        description: "Saved versions kept per dashboard; older ones are deleted on save. 0 keeps all.",
    },
    SettingDef {
        key: "updates.channel",
        scope: Scope::Server,
        default: || json!("stable"),
        ui_editable: true,
        description: "Which releases updates offer: stable releases only, or previews too.",
    },
    SettingDef {
        key: "updates.check_daily",
        scope: Scope::Server,
        default: || json!(false),
        ui_editable: true,
        description: "Look for a new version once a day (asks GitHub; off by default, nothing else is sent).",
    },
    SettingDef {
        key: "updates.window",
        scope: Scope::Server,
        default: || json!("02:00-04:00"),
        ui_editable: true,
        description: "Maintenance window for planned installations, HH:MM-HH:MM in the administrator's local time.",
    },
    SettingDef {
        key: "updates.keep_versions",
        scope: Scope::Server,
        default: || json!(3),
        ui_editable: true,
        description: "Previous versions kept with their database backups, for a return.",
    },
    SettingDef {
        key: "updates.health_timeout_secs",
        scope: Scope::Server,
        default: || json!(60),
        ui_editable: true,
        description: "How long a new version has to report healthy before Kalzit returns to the previous one.",
    },
    SettingDef {
        key: "dashboards.default_time_range",
        scope: Scope::Org,
        default: || json!({ "from": "now-6h", "to": "now" }),
        ui_editable: true,
        description: "Time range of new dashboards in this organization.",
    },
];

fn def(key: &str, scope: Scope) -> ApiResult<&'static SettingDef> {
    find(key, scope).ok_or_else(|| ApiError::internal("settings", format!("unknown {scope:?} setting {key}")))
}

pub fn find(key: &str, scope: Scope) -> Option<&'static SettingDef> {
    REGISTRY.iter().find(|d| d.key == key && d.scope == scope)
}

/// Where an effective value came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Env,
    File,
    Database,
    Default,
}

/// What a setting accepts. Every registry entry has one (tested).
enum Rule {
    Int {
        min: i64,
        max: i64,
    },
    OneOf(&'static [&'static str]),
    Strings {
        max_items: usize,
        max_chars: usize,
    },
    TimeRange,
    Bool,
    /// `HH:MM-HH:MM`, two different times of day.
    TimeWindow,
}

fn time_of_day(text: &str) -> Option<u32> {
    let (h, m) = text.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

fn rule(key: &str) -> Option<Rule> {
    Some(match key {
        "datasources.sqlite_dirs" | "datasources.allowed_targets" => Rule::Strings { max_items: 100, max_chars: 1024 },
        "datasources.file_dirs" => Rule::Strings { max_items: 100, max_chars: 1024 },
        "datasources.query_timeout_secs" => Rule::Int { min: 1, max: 3600 },
        "datasources.max_rows" => Rule::Int { min: 1, max: 10_000_000 },
        "datasources.max_response_bytes" => Rule::Int { min: 1024, max: 1024 * 1024 * 1024 },
        "datasources.max_parallel_queries" => Rule::Int { min: 1, max: 10_000 },
        "datasources.max_inflight_bytes" => Rule::Int { min: 1024 * 1024, max: 64 * 1024 * 1024 * 1024 },
        // At least a day, so a slip of the keyboard cannot wipe the log at the next run.
        "audit.retention_days" => Rule::Int { min: 1, max: 36_500 },
        "appearance.default_language" => Rule::OneOf(&["de", "en"]),
        "appearance.default_theme" => Rule::OneOf(&["system", "light", "dark", "contrast"]),
        // The same bounds as `config.rs`, which checks the file and environment at startup.
        "sessions.lifetime_hours" => Rule::Int { min: 1, max: 10 * 365 * 24 },
        "sessions.idle_timeout_hours" => Rule::Int { min: 0, max: 10 * 365 * 24 },
        "dashboards.version_retention" => Rule::Int { min: 0, max: 100_000 },
        "dashboards.default_time_range" => Rule::TimeRange,
        "updates.channel" => Rule::OneOf(&["stable", "preview"]),
        "updates.check_daily" => Rule::Bool,
        "updates.window" => Rule::TimeWindow,
        "updates.keep_versions" => Rule::Int { min: 1, max: 20 },
        // Long enough for migrations of a large database, short enough that a hang is noticed.
        "updates.health_timeout_secs" => Rule::Int { min: 15, max: 1800 },
        _ => return None,
    })
}

/// Checks a value against the setting's rule; the message is for the `validation` error.
pub fn validate(key: &str, value: &Value) -> Result<(), String> {
    let Some(rule) = rule(key) else { return Err(format!("{key} has no validation rule")) };
    match rule {
        Rule::Int { min, max } => match value.as_i64() {
            Some(n) if (min..=max).contains(&n) => Ok(()),
            _ => Err(format!("{key} must be a whole number from {min} to {max}")),
        },
        Rule::OneOf(allowed) => match value.as_str() {
            Some(s) if allowed.contains(&s) => Ok(()),
            _ => Err(format!("{key} must be one of {}", allowed.join(", "))),
        },
        Rule::Strings { max_items, max_chars } => {
            let items = value.as_array().ok_or_else(|| format!("{key} must be a list of texts"))?;
            if items.len() > max_items {
                return Err(format!("{key} takes at most {max_items} entries"));
            }
            for item in items {
                let ok = item.as_str().is_some_and(|s| {
                    let chars = s.chars().count();
                    !s.trim().is_empty() && chars <= max_chars && !s.chars().any(char::is_control)
                });
                if !ok {
                    return Err(format!("{key} entries must be texts of 1 to {max_chars} characters"));
                }
            }
            Ok(())
        }
        Rule::TimeRange => crate::dashboards::model::check_time_range(value).map_err(|e| format!("{key}: {e}")),
        Rule::TimeWindow => {
            let window = value.as_str().and_then(|s| s.split_once('-'));
            match window.and_then(|(a, b)| Some((time_of_day(a)?, time_of_day(b)?))) {
                Some((a, b)) if a != b => Ok(()),
                _ => Err(format!("{key} must be two different times like 02:00-04:00")),
            }
        }
        Rule::Bool => match value {
            Value::Bool(_) => Ok(()),
            _ => Err(format!("{key} must be true or false")),
        },
    }
}

/// A setting that lives in the configuration: its environment variable and how to read it.
struct ConfigBacked {
    env_var: &'static str,
    read: fn(&Config) -> Value,
}

fn config_backed(key: &str) -> Option<ConfigBacked> {
    Some(match key {
        "sessions.lifetime_hours" => {
            ConfigBacked { env_var: "KALZIT_SESSIONS_LIFETIME_HOURS", read: |c| json!(c.sessions.lifetime_hours) }
        }
        "sessions.idle_timeout_hours" => ConfigBacked {
            env_var: "KALZIT_SESSIONS_IDLE_TIMEOUT_HOURS",
            read: |c| json!(c.sessions.idle_timeout_hours),
        },
        _ => return None,
    })
}

const SETTING_ENV_PREFIX: &str = "KALZIT_SETTING_";

/// `audit.retention_days` -> `KALZIT_SETTING_AUDIT_RETENTION_DAYS`.
pub fn env_var_name(key: &str) -> String {
    format!("{SETTING_ENV_PREFIX}{}", key.replace('.', "_").to_ascii_uppercase())
}

/// A value from the environment: JSON if it parses, otherwise the text itself, so
/// `KALZIT_SETTING_APPEARANCE_DEFAULT_THEME=dark` needs no quotes.
fn parse_env_value(raw: &str) -> Value {
    serde_json::from_str(raw.trim()).unwrap_or_else(|_| Value::String(raw.to_string()))
}

/// Checks every `KALZIT_SETTING_*` variable at startup: it must name a server setting that is not
/// configured in `kalzit.toml`, with a valid value. A typo would otherwise be ignored silently.
pub fn check_environment(vars: impl IntoIterator<Item = (String, String)>) -> Result<(), String> {
    check_environment_with(vars, cfg!(windows))
}

/// `names_ignore_case`: Windows matches variable names regardless of case, so a lowercase
/// `kalzit_setting_...` is read by `std::env::var` later and is checked like the upper case name.
/// Elsewhere lookups are exact, so such a name would never apply and is refused instead.
fn check_environment_with(
    vars: impl IntoIterator<Item = (String, String)>,
    names_ignore_case: bool,
) -> Result<(), String> {
    for (name, raw) in vars {
        let upper = name.to_ascii_uppercase();
        if !upper.starts_with(SETTING_ENV_PREFIX) {
            continue;
        }
        if !names_ignore_case && upper != name {
            return Err(format!("{name}: setting variables are upper case, like {upper}; this one would never apply"));
        }
        let Some(def) = REGISTRY
            .iter()
            .find(|d| d.scope == Scope::Server && config_backed(d.key).is_none() && env_var_name(d.key) == upper)
        else {
            return Err(format!("unknown variable {name}: there is no such server setting"));
        };
        validate(def.key, &parse_env_value(&raw)).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(())
}

/// A row of `server_settings` or `org_settings`.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub value: Value,
    pub version: i64,
    pub updated_by: Option<String>,
    pub updated_at: i64,
}

/// The value in effect and where it came from. `version` and the `updated_*` fields describe the
/// database row (version 0: never saved), which is what an update must name.
#[derive(Clone, Debug, PartialEq)]
pub struct Effective {
    pub value: Value,
    pub source: Source,
    pub version: i64,
    pub updated_by: Option<String>,
    pub updated_at: Option<i64>,
}

/// The layering, without IO: `env` looks a variable up, `file_sets` tells whether `kalzit.toml`
/// sets a key (`sessions.lifetime_hours`), `stored` is the database row.
pub fn resolve(
    def: &SettingDef,
    env: &dyn Fn(&str) -> Option<String>,
    file_sets: &dyn Fn(&str) -> bool,
    config: &Config,
    stored: Option<&Stored>,
) -> Result<Effective, String> {
    let row = |value: Value, source: Source| Effective {
        value,
        source,
        version: stored.map_or(0, |s| s.version),
        updated_by: stored.and_then(|s| s.updated_by.clone()),
        updated_at: stored.map(|s| s.updated_at),
    };
    if def.scope == Scope::Server {
        if let Some(backed) = config_backed(def.key) {
            // The configuration has merged file and environment already; the variable tells which.
            let value = (backed.read)(config);
            let source = if env(backed.env_var).is_some() {
                Source::Env
            } else if file_sets(def.key) {
                Source::File
            } else {
                Source::Default
            };
            return Ok(row(value, source));
        }
        let name = env_var_name(def.key);
        if let Some(raw) = env(&name) {
            let value = parse_env_value(&raw);
            validate(def.key, &value).map_err(|e| format!("{name}: {e}"))?;
            return Ok(row(value, Source::Env));
        }
    }
    if let Some(stored) = stored {
        match validate(def.key, &stored.value) {
            Ok(()) => return Ok(row(stored.value.clone(), Source::Database)),
            // A rule tightened by an update must not break the server; the default applies until
            // an admin saves a valid value.
            Err(e) => tracing::warn!("ignoring the stored value of {}: {e}", def.key),
        }
    }
    Ok(row((def.default)(), Source::Default))
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// How long a cached database value is trusted. Writes through this process drop the cache at
/// once; the limit is for other server processes sharing the database.
const CACHE_TTL_MS: i64 = 30_000;

/// The stored settings of one scope (the server, or one organization).
#[derive(Clone)]
struct Loaded {
    at_ms: i64,
    rows: Arc<HashMap<String, Stored>>,
}

#[derive(Default)]
struct CacheInner {
    /// Bumped by every invalidation, so a load that started before a write cannot store the old
    /// rows after the write dropped them.
    generation: u64,
    server: Option<Loaded>,
    orgs: HashMap<String, Loaded>,
}

/// The database layer's cache for one `AppState`.
#[derive(Default)]
pub struct Cache {
    inner: Mutex<CacheInner>,
}

impl Cache {
    fn lock(&self) -> std::sync::MutexGuard<'_, CacheInner> {
        // The data is a cache: after a panic elsewhere it is still safe to use or rebuild.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, org_id: Option<&str>, now_ms: i64) -> Result<Arc<HashMap<String, Stored>>, u64> {
        let inner = self.lock();
        let loaded = match org_id {
            None => inner.server.as_ref(),
            Some(org) => inner.orgs.get(org),
        };
        match loaded {
            Some(l) if (0..CACHE_TTL_MS).contains(&(now_ms - l.at_ms)) => Ok(l.rows.clone()),
            _ => Err(inner.generation),
        }
    }

    fn put(&self, org_id: Option<&str>, generation: u64, loaded: Loaded) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        match org_id {
            None => inner.server = Some(loaded),
            Some(org) => {
                inner.orgs.insert(org.to_string(), loaded);
            }
        }
    }

    /// Drops the cached rows of the server (`None`) or one organization.
    pub fn invalidate(&self, org_id: Option<&str>) {
        let mut inner = self.lock();
        inner.generation += 1;
        match org_id {
            None => inner.server = None,
            Some(org) => {
                inner.orgs.remove(org);
            }
        }
    }
}

/// One cache per `AppState`, found through its configuration `Arc` (which every clone of the
/// state shares). The `Weak` keeps the allocation alive, so a later state cannot get the same
/// address while the entry exists. This moves into `AppState` once the state carries a field
/// for it.
type CacheEntry = (Weak<Config>, Arc<Cache>);
static CACHES: LazyLock<Mutex<Vec<CacheEntry>>> = LazyLock::new(Mutex::default);

pub fn cache(state: &AppState) -> Arc<Cache> {
    let mut caches = CACHES.lock().unwrap_or_else(|e| e.into_inner());
    caches.retain(|(config, _)| config.strong_count() > 0);
    let key = Arc::downgrade(&state.config);
    if let Some((_, cache)) = caches.iter().find(|(config, _)| config.ptr_eq(&key)) {
        return cache.clone();
    }
    let cache = Arc::new(Cache::default());
    caches.push((key, cache.clone()));
    cache
}

#[derive(sqlx::FromRow)]
struct StoredRow {
    key: String,
    value: String,
    version: i64,
    updated_by: Option<String>,
    updated_at: i64,
}

async fn stored_rows(state: &AppState, org_id: Option<&str>) -> ApiResult<Arc<HashMap<String, Stored>>> {
    let cache = cache(state);
    let now = state.clock.now_ms();
    let generation = match cache.get(org_id, now) {
        Ok(rows) => return Ok(rows),
        Err(generation) => generation,
    };
    let rows: Vec<StoredRow> = match org_id {
        None => {
            sqlx::query_as("SELECT key, value, version, updated_by, updated_at FROM server_settings")
                .fetch_all(&state.db)
                .await?
        }
        Some(org) => {
            sqlx::query_as("SELECT key, value, version, updated_by, updated_at FROM org_settings WHERE org_id = $1")
                .bind(org)
                .fetch_all(&state.db)
                .await?
        }
    };
    let mut map = HashMap::new();
    for r in rows {
        let value = serde_json::from_str(&r.value)
            .map_err(|e| ApiError::internal("settings", format!("stored value of {} is not JSON: {e}", r.key)))?;
        map.insert(r.key, Stored { value, version: r.version, updated_by: r.updated_by, updated_at: r.updated_at });
    }
    let rows = Arc::new(map);
    cache.put(org_id, generation, Loaded { at_ms: now, rows: rows.clone() });
    Ok(rows)
}

fn resolved(state: &AppState, def: &SettingDef, stored: Option<&Stored>) -> ApiResult<Effective> {
    // Configuration-backed settings carry the configuration's own `section.key` names.
    let file_sets = |key: &str| state.config.file_keys.contains(key);
    resolve(def, &process_env, &file_sets, &state.config, stored).map_err(|e| ApiError::internal("settings", e))
}

/// The effective value of a server setting.
pub async fn get(state: &AppState, key: &str) -> ApiResult<Value> {
    Ok(effective(state, key).await?.value)
}

/// The effective value of an organization setting.
pub async fn get_org(state: &AppState, org_id: &str, key: &str) -> ApiResult<Value> {
    Ok(effective_org(state, org_id, key).await?.value)
}

/// A server setting with its source and stored version.
pub async fn effective(state: &AppState, key: &str) -> ApiResult<Effective> {
    let def = def(key, Scope::Server)?;
    let rows = stored_rows(state, None).await?;
    resolved(state, def, rows.get(key))
}

/// An organization setting with its source and stored version.
pub async fn effective_org(state: &AppState, org_id: &str, key: &str) -> ApiResult<Effective> {
    let def = def(key, Scope::Org)?;
    let rows = stored_rows(state, Some(org_id)).await?;
    resolved(state, def, rows.get(key))
}

/// Every setting of a scope (`org_id` for organization settings), in registry order.
pub async fn list(state: &AppState, org_id: Option<&str>) -> ApiResult<Vec<(&'static SettingDef, Effective)>> {
    let scope = if org_id.is_some() { Scope::Org } else { Scope::Server };
    let rows = stored_rows(state, org_id).await?;
    REGISTRY.iter().filter(|d| d.scope == scope).map(|d| Ok((d, resolved(state, d, rows.get(d.key))?))).collect()
}

/// Whether the UI may change a setting given where its value comes from now.
pub fn editable(def: &SettingDef, effective: &Effective) -> bool {
    def.ui_editable && matches!(effective.source, Source::Database | Source::Default)
}

/// Writes a setting if its stored version is still `expected` (0: never saved). Answers the new
/// version, or `None` when someone else saved first. Runs inside the caller's transaction, next
/// to the audit entry; call `Cache::invalidate` after the commit.
pub async fn store(
    conn: &mut sqlx::AnyConnection,
    org_id: Option<&str>,
    key: &str,
    value: &Value,
    expected: i64,
    user_id: &str,
    now_ms: i64,
) -> ApiResult<Option<i64>> {
    let text = value.to_string();
    let next = expected + 1;
    let affected =
        match (org_id, expected) {
            (None, 0) => sqlx::query(
                "INSERT INTO server_settings (key, value, version, updated_by, updated_at) VALUES ($1, $2, 1, $3, $4) \
                 ON CONFLICT (key) DO NOTHING",
            )
            .bind(key)
            .bind(&text)
            .bind(user_id)
            .bind(now_ms)
            .execute(&mut *conn)
            .await?,
            (None, _) => {
                sqlx::query(
                    "UPDATE server_settings SET value = $1, version = $2, updated_by = $3, updated_at = $4 \
                 WHERE key = $5 AND version = $6",
                )
                .bind(&text)
                .bind(next)
                .bind(user_id)
                .bind(now_ms)
                .bind(key)
                .bind(expected)
                .execute(&mut *conn)
                .await?
            }
            (Some(org), 0) => {
                sqlx::query(
                    "INSERT INTO org_settings (org_id, key, value, version, updated_by, updated_at) \
                 VALUES ($1, $2, $3, 1, $4, $5) ON CONFLICT (org_id, key) DO NOTHING",
                )
                .bind(org)
                .bind(key)
                .bind(&text)
                .bind(user_id)
                .bind(now_ms)
                .execute(&mut *conn)
                .await?
            }
            (Some(org), _) => {
                sqlx::query(
                    "UPDATE org_settings SET value = $1, version = $2, updated_by = $3, updated_at = $4 \
                 WHERE org_id = $5 AND key = $6 AND version = $7",
                )
                .bind(&text)
                .bind(next)
                .bind(user_id)
                .bind(now_ms)
                .bind(org)
                .bind(key)
                .bind(expected)
                .execute(&mut *conn)
                .await?
            }
        }
        .rows_affected();
    Ok((affected == 1).then_some(next))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_unique_and_namespaced() {
        let mut seen = std::collections::BTreeSet::new();
        for d in REGISTRY {
            assert!(seen.insert(d.key), "{} twice", d.key);
            assert!(d.key.contains('.'), "{} needs an area prefix", d.key);
            assert!(!d.description.is_empty());
        }
    }

    #[test]
    fn every_setting_has_a_rule_its_default_passes() {
        for d in REGISTRY {
            assert!(validate(d.key, &(d.default)()).is_ok(), "{}: {:?}", d.key, validate(d.key, &(d.default)()));
        }
    }

    #[test]
    fn configuration_backed_settings_match_the_configuration() {
        let config = Config::default();
        for d in REGISTRY {
            if let Some(backed) = config_backed(d.key) {
                assert_eq!(d.scope, Scope::Server);
                assert!(!d.ui_editable, "{} lives in the configuration, the UI cannot change it", d.key);
                assert_eq!((backed.read)(&config), (d.default)(), "{} default differs from Config::default", d.key);
            }
        }
    }

    fn server_def(key: &str) -> &'static SettingDef {
        find(key, Scope::Server).unwrap()
    }

    fn stored(value: Value) -> Stored {
        Stored { value, version: 3, updated_by: Some("u".into()), updated_at: 7 }
    }

    #[test]
    fn environment_beats_database_beats_default() {
        let config = Config::default();
        let def = server_def("audit.retention_days");
        let no_env = |_: &str| None;
        let env = |name: &str| (name == "KALZIT_SETTING_AUDIT_RETENTION_DAYS").then(|| "30".to_string());

        let d = resolve(def, &no_env, &|_: &str| false, &config, None).unwrap();
        assert_eq!((d.value, d.source, d.version), (json!(365), Source::Default, 0));
        let db = resolve(def, &no_env, &|_: &str| false, &config, Some(&stored(json!(90)))).unwrap();
        assert_eq!((&db.value, db.source, db.version, db.updated_at), (&json!(90), Source::Database, 3, Some(7)));
        let e = resolve(def, &env, &|_: &str| false, &config, Some(&stored(json!(90)))).unwrap();
        assert_eq!((&e.value, e.source), (&json!(30), Source::Env));
        // The stored version stays visible, so the UI can show that a value waits underneath.
        assert_eq!(e.version, 3);
        assert!(!editable(def, &e) && editable(def, &db));
    }

    #[test]
    fn environment_values_need_no_quotes_and_are_validated() {
        let config = Config::default();
        let theme = server_def("appearance.default_theme");
        let env =
            |v: &'static str| move |name: &str| (name == "KALZIT_SETTING_APPEARANCE_DEFAULT_THEME").then(|| v.into());
        assert_eq!(resolve(theme, &env("dark"), &|_: &str| false, &config, None).unwrap().value, json!("dark"));
        assert_eq!(resolve(theme, &env("\"light\""), &|_: &str| false, &config, None).unwrap().value, json!("light"));
        let err = resolve(theme, &env("pink"), &|_: &str| false, &config, None).unwrap_err();
        assert!(err.contains("KALZIT_SETTING_APPEARANCE_DEFAULT_THEME"), "{err}");
    }

    #[test]
    fn configuration_settings_report_file_or_environment() {
        let def = server_def("sessions.lifetime_hours");
        let no_env = |_: &str| None;
        let mut config = Config::default();
        assert_eq!(resolve(def, &no_env, &|_: &str| false, &config, None).unwrap().source, Source::Default);
        config.sessions.lifetime_hours = 12;
        let file =
            resolve(def, &no_env, &|key: &str| key == "sessions.lifetime_hours", &config, Some(&stored(json!(99))))
                .unwrap();
        assert_eq!((file.value, file.source), (json!(12), Source::File), "the database never applies here");
        let env = |name: &str| (name == "KALZIT_SESSIONS_LIFETIME_HOURS").then(|| "12".to_string());
        let from_env = resolve(def, &env, &|_: &str| false, &config, None).unwrap();
        // The file names the default value explicitly: still the file's value.
        let in_file = |key: &str| key == "sessions.lifetime_hours";
        let explicit = resolve(def, &no_env, &in_file, &Config::default(), None).unwrap();
        assert_eq!(explicit.source, Source::File);
        assert_eq!(from_env.source, Source::Env);
        assert!(!editable(def, &from_env));
    }

    #[test]
    fn organization_settings_ignore_the_environment() {
        let def = find("dashboards.default_time_range", Scope::Org).unwrap();
        let env = |_: &str| Some("{\"from\":\"now-1h\",\"to\":\"now\"}".to_string());
        let config = Config::default();
        assert_eq!(resolve(def, &env, &|_: &str| false, &config, None).unwrap().source, Source::Default);
        let range = json!({ "from": "now-24h", "to": "now" });
        let db = resolve(def, &env, &|_: &str| false, &config, Some(&stored(range.clone()))).unwrap();
        assert_eq!((db.value, db.source), (range, Source::Database));
    }

    #[test]
    fn invalid_stored_values_fall_back_to_the_default() {
        let def = server_def("audit.retention_days");
        let r = resolve(def, &|_: &str| None, &|_: &str| false, &Config::default(), Some(&stored(json!(0)))).unwrap();
        assert_eq!((r.value, r.source), (json!(365), Source::Default));
    }

    #[test]
    fn rules_reject_wrong_values() {
        for (key, bad) in [
            ("audit.retention_days", json!(0)),
            ("audit.retention_days", json!("365")),
            ("audit.retention_days", json!(1.5)),
            ("appearance.default_language", json!("fr")),
            ("datasources.sqlite_dirs", json!(["ok", ""])),
            ("datasources.sqlite_dirs", json!("C:/data")),
            ("datasources.allowed_targets", json!(["a\u{0}b"])),
            ("dashboards.default_time_range", json!({ "from": "yesterday", "to": "now" })),
            ("dashboards.version_retention", json!(-1)),
        ] {
            assert!(validate(key, &bad).is_err(), "{key} accepted {bad}");
        }
        assert!(validate("datasources.sqlite_dirs", &json!(["D:/Daten/Ümlaut"])).is_ok());
        assert!(validate("no.such", &json!(1)).is_err());
    }

    /// Matches `config.rs`: a session lasts at least an hour; idle timeout 0 means never.
    #[test]
    fn session_lifetime_needs_at_least_an_hour() {
        let max = 10 * 365 * 24;
        assert!(validate("sessions.lifetime_hours", &json!(0)).is_err());
        assert!(validate("sessions.lifetime_hours", &json!(1)).is_ok());
        assert!(validate("sessions.lifetime_hours", &json!(max)).is_ok());
        assert!(validate("sessions.lifetime_hours", &json!(max + 1)).is_err());
        assert!(validate("sessions.idle_timeout_hours", &json!(0)).is_ok());
        assert!(validate("sessions.idle_timeout_hours", &json!(max + 1)).is_err());
    }

    #[test]
    fn environment_check_names_the_bad_variable() {
        let vars =
            |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert!(check_environment(vars(&[("KALZIT_SETTING_AUDIT_RETENTION_DAYS", "30"), ("PATH", "x")])).is_ok());
        for (name, value) in [
            ("KALZIT_SETTING_AUDIT_RETENTION_DAYZ", "30"),
            ("KALZIT_SETTING_AUDIT_RETENTION_DAYS", "never"),
            // Lives in the configuration: KALZIT_SESSIONS_LIFETIME_HOURS is the variable for it.
            ("KALZIT_SETTING_SESSIONS_LIFETIME_HOURS", "12"),
            // Organization settings cannot come from the environment.
            ("KALZIT_SETTING_DASHBOARDS_DEFAULT_TIME_RANGE", "{}"),
        ] {
            let err = check_environment(vars(&[(name, value)])).unwrap_err();
            assert!(err.contains(name), "{err}");
        }
        assert_eq!(env_var_name("audit.retention_days"), "KALZIT_SETTING_AUDIT_RETENTION_DAYS");
        // Where names ignore case (Windows), a lowercase name is read later, so it is checked...
        let err = check_environment_with(vars(&[("kalzit_setting_audit_retention_days", "0")]), true).unwrap_err();
        assert!(err.contains("kalzit_setting_audit_retention_days") && err.contains("whole number"), "{err}");
        assert!(check_environment_with(vars(&[("Kalzit_Setting_Audit_Retention_Days", "30")]), true).is_ok());
        // ...elsewhere it would never apply, so it is refused even with a valid value.
        let err = check_environment_with(vars(&[("kalzit_setting_audit_retention_days", "30")]), false).unwrap_err();
        assert!(err.contains("upper case"), "{err}");
        assert!(check_environment_with(vars(&[("KALZIT_SETTING_AUDIT_RETENTION_DAYS", "30")]), false).is_ok());
    }

    fn rows(value: i64) -> Loaded {
        let mut map = HashMap::new();
        map.insert("k".to_string(), stored(json!(value)));
        Loaded { at_ms: 1000, rows: Arc::new(map) }
    }

    #[test]
    fn cache_is_dropped_on_write_and_expires() {
        let cache = Cache::default();
        let generation = cache.get(None, 1000).unwrap_err();
        cache.put(None, generation, rows(1));
        assert_eq!(cache.get(None, 1000 + CACHE_TTL_MS - 1).unwrap()["k"].value, json!(1));
        assert!(cache.get(None, 1000 + CACHE_TTL_MS).is_err(), "expired");
        assert!(cache.get(None, 999).is_err(), "a clock set back does not keep a value forever");

        cache.put(None, generation, rows(1));
        cache.invalidate(None);
        assert!(cache.get(None, 1000).is_err());
        // Organizations are cached apart from the server.
        let g = cache.get(Some("o"), 1000).unwrap_err();
        cache.put(Some("o"), g, rows(2));
        cache.invalidate(None);
        assert_eq!(cache.get(Some("o"), 1000).unwrap()["k"].value, json!(2));
        cache.invalidate(Some("o"));
        assert!(cache.get(Some("o"), 1000).is_err());
    }

    #[test]
    fn a_load_that_raced_a_write_is_not_cached() {
        let cache = Cache::default();
        let generation = cache.get(None, 1000).unwrap_err();
        // A write commits and invalidates while the load is still reading the old rows.
        cache.invalidate(None);
        cache.put(None, generation, rows(1));
        assert!(cache.get(None, 1000).is_err());
    }
}
