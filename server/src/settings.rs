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
        default: || json!(128 * 1024 * 1024),
        ui_editable: true,
        description: "Memory the results of one request may take, all its queries together; counted as held in memory (every value, string and document entry), not as JSON text.",
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
        description: "Memory the results of all running queries together may take, counted like the per-request limit.",
    },
    SettingDef {
        key: "ai.enabled",
        scope: Scope::Server,
        default: || json!(false),
        ui_editable: true,
        description: "Turns every AI function on or off. Off, the UI shows no AI buttons or hints.",
    },
    SettingDef {
        key: "ai.request_timeout_secs",
        scope: Scope::Server,
        default: || json!(120),
        ui_editable: true,
        description: "Longest a single call to an AI provider may take, including the streamed answer.",
    },
    SettingDef {
        key: "ai.user_requests_per_day",
        scope: Scope::Server,
        default: || json!(200),
        ui_editable: true,
        description: "AI calls one user may make per day (UTC) in one organization; 0 for no limit.",
    },
    SettingDef {
        key: "ai.user_tokens_per_day",
        scope: Scope::Server,
        default: || json!(200_000),
        ui_editable: true,
        description: "Tokens (input and output) one user may use per day (UTC) in one organization; 0 for no limit.",
    },
    SettingDef {
        key: "ai.org_tokens_per_month",
        scope: Scope::Server,
        default: || json!(20_000_000),
        ui_editable: true,
        description: "Tokens all members of one organization together may use per calendar month (UTC); then AI is \
                      refused there until the month ends. 0 for no limit.",
    },
    SettingDef {
        key: "ai.max_rows_to_model",
        scope: Scope::Server,
        default: || json!(200),
        ui_editable: true,
        description: "Most rows, documents or nodes of one result AI receives; more are cut off with a note.",
    },
    SettingDef {
        key: "ai.max_tool_calls",
        scope: Scope::Server,
        default: || json!(10),
        ui_editable: true,
        description: "Most tool calls the assistant makes for one answer in a chat; then it answers with what it has.",
    },
    SettingDef {
        key: "ai.allow_org_providers",
        scope: Scope::Server,
        default: || json!(true),
        ui_editable: true,
        description: "Organization admins may connect their own AI provider with their own key; the server's limits \
                      still apply.",
    },
    SettingDef {
        key: "ai.max_concurrent",
        scope: Scope::Server,
        default: || json!(8),
        ui_editable: true,
        description: "AI calls running at once on the whole server; a further call is refused until one ends.",
    },
    SettingDef {
        key: "ai.max_concurrent_per_user",
        scope: Scope::Server,
        default: || json!(2),
        ui_editable: true,
        description: "AI calls one user may have running at once.",
    },
    SettingDef {
        key: "ai.max_concurrent_per_org",
        scope: Scope::Server,
        default: || json!(4),
        ui_editable: true,
        description: "AI calls all members of one organization together may have running at once.",
    },
    SettingDef {
        key: "ai.chat_retention_days",
        scope: Scope::Server,
        default: || json!(30),
        ui_editable: true,
        description: "AI chats are deleted this many days after their last message; 0 keeps no chats. Applies once \
                      chats are stored (the chat package).",
    },
    SettingDef {
        key: "ai.notice_text",
        scope: Scope::Server,
        default: || json!(""),
        ui_editable: true,
        description: "A paragraph the administrators add to the notice about which data leaves the server, shown \
                      before a person's first AI call.",
    },
    SettingDef {
        key: "ai.org_enabled",
        scope: Scope::Org,
        default: || json!(true),
        ui_editable: true,
        description: "AI in this organization, while the server has it on. Off, members see nothing of AI.",
    },
    SettingDef {
        key: "ai.user_requests_per_day",
        scope: Scope::Org,
        default: || json!(INHERIT),
        ui_editable: true,
        description: "A lower limit of AI calls per member and day than the server's, or inherit.",
    },
    SettingDef {
        key: "ai.user_tokens_per_day",
        scope: Scope::Org,
        default: || json!(INHERIT),
        ui_editable: true,
        description: "A lower limit of AI tokens per member and day than the server's, or inherit.",
    },
    SettingDef {
        key: "ai.org_tokens_per_month",
        scope: Scope::Org,
        default: || json!(INHERIT),
        ui_editable: true,
        description: "A lower limit of AI tokens for the organization per month than the server's, or inherit.",
    },
    SettingDef {
        key: "ai.chat_retention_days",
        scope: Scope::Org,
        default: || json!(INHERIT),
        ui_editable: true,
        description: "A shorter retention of AI chats than the server's, or inherit.",
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
    SettingDef {
        key: "dashboards.new_in_team_space",
        scope: Scope::Org,
        default: || json!(false),
        ui_editable: true,
        description: "New dashboards go into the team space of the member's current team.",
    },
    // Appearance and brand. The organization entries of the same keys start as "inherit" and then
    // follow the server's value (`routes::branding`).
    SettingDef {
        key: "appearance.product_name",
        scope: Scope::Server,
        default: || json!("Kalzit"),
        ui_editable: true,
        description: "Name shown in the sidebar, on the sign-in page and in the window title.",
    },
    SettingDef {
        key: "appearance.accent",
        scope: Scope::Server,
        default: || json!("copper"),
        ui_editable: true,
        description: "Accent color of primary actions and links: a vetted color or #rrggbb with enough contrast.",
    },
    SettingDef {
        key: "appearance.density",
        scope: Scope::Server,
        default: || json!("balanced"),
        ui_editable: true,
        description: "Spacing and control height: compact, balanced or comfortable.",
    },
    SettingDef {
        key: "appearance.font_size",
        scope: Scope::Server,
        default: || json!(14),
        ui_editable: true,
        description: "Size of body text in pixels; everything else scales with it.",
    },
    SettingDef {
        key: "appearance.start_page",
        scope: Scope::Server,
        default: || json!("home"),
        ui_editable: true,
        description: "Page members land on when they have no start dashboard of their own.",
    },
    SettingDef {
        key: "appearance.time_zone",
        scope: Scope::Server,
        default: || json!("browser"),
        ui_editable: true,
        description: "Time zone for users who have not chosen one: an IANA name, or browser for their own.",
    },
    SettingDef {
        key: "appearance.week_start",
        scope: Scope::Server,
        default: || json!("monday"),
        ui_editable: true,
        description: "First day of the week for users who have not chosen one.",
    },
    SettingDef {
        key: "signin.welcome",
        scope: Scope::Server,
        default: || json!(""),
        ui_editable: true,
        description: "Welcome text on the sign-in page, plain text with emphasis and links.",
    },
    SettingDef {
        key: "signin.notice",
        scope: Scope::Server,
        default: || json!(""),
        ui_editable: true,
        description: "Notice on the sign-in page, such as a maintenance window or a usage policy.",
    },
    SettingDef {
        key: "appearance.accent",
        scope: Scope::Org,
        default: || json!("inherit"),
        ui_editable: true,
        description: "Accent color in this organization; inherit follows the server.",
    },
    SettingDef {
        key: "appearance.density",
        scope: Scope::Org,
        default: || json!("inherit"),
        ui_editable: true,
        description: "Density in this organization; inherit follows the server.",
    },
    SettingDef {
        key: "appearance.font_size",
        scope: Scope::Org,
        default: || json!("inherit"),
        ui_editable: true,
        description: "Body text size in this organization; inherit follows the server.",
    },
    SettingDef {
        key: "appearance.start_page",
        scope: Scope::Org,
        default: || json!("inherit"),
        ui_editable: true,
        description: "Start page in this organization; inherit follows the server.",
    },
    SettingDef {
        key: "appearance.time_zone",
        scope: Scope::Org,
        default: || json!("inherit"),
        ui_editable: true,
        description: "Default time zone in this organization; inherit follows the server.",
    },
    SettingDef {
        key: "appearance.week_start",
        scope: Scope::Org,
        default: || json!("inherit"),
        ui_editable: true,
        description: "First day of the week in this organization; inherit follows the server.",
    },
    // Network, TLS, proxies, security and logging live in the configuration only (a wrong value
    // could lock the admin out); the settings page shows them read-only with their source.
    SettingDef {
        key: "server.http_addr",
        scope: Scope::Server,
        default: || json!("0.0.0.0:3000"),
        ui_editable: false,
        description: "Address and port of the HTTP listener; empty turns it off.",
    },
    SettingDef {
        key: "server.https_addr",
        scope: Scope::Server,
        default: || json!(""),
        ui_editable: false,
        description: "Address and port of the HTTPS listener; empty turns it off.",
    },
    SettingDef {
        key: "server.public_url",
        scope: Scope::Server,
        default: || Value::Null,
        ui_editable: false,
        description: "The address users open; used for the origin check and links.",
    },
    SettingDef {
        key: "server.redirect_http_to_https",
        scope: Scope::Server,
        default: || json!(true),
        ui_editable: false,
        description: "With HTTPS on, plain HTTP answers with a redirect.",
    },
    SettingDef {
        key: "tls.cert_file",
        scope: Scope::Server,
        default: || Value::Null,
        ui_editable: false,
        description: "Certificate chain of the HTTPS listener (PEM).",
    },
    SettingDef {
        key: "tls.min_version",
        scope: Scope::Server,
        default: || json!("1.2"),
        ui_editable: false,
        description: "Oldest TLS version the HTTPS listener accepts.",
    },
    SettingDef {
        key: "tls.reload_interval_secs",
        scope: Scope::Server,
        default: || json!(60),
        ui_editable: false,
        description: "How often the certificate files are checked for changes (0: never).",
    },
    SettingDef {
        key: "security.trusted_proxies",
        scope: Scope::Server,
        default: || json!([]),
        ui_editable: false,
        description: "Reverse proxies whose X-Forwarded headers are trusted.",
    },
    SettingDef {
        key: "security.hsts",
        scope: Scope::Server,
        default: || json!(true),
        ui_editable: false,
        description: "Strict-Transport-Security on HTTPS answers.",
    },
    SettingDef {
        key: "security.hsts_max_age_secs",
        scope: Scope::Server,
        default: || json!(31_536_000),
        ui_editable: false,
        description: "How long browsers keep to HTTPS after a visit.",
    },
    SettingDef {
        key: "security.login_max_failures",
        scope: Scope::Server,
        default: || json!(10),
        ui_editable: false,
        description: "Failed sign-ins per address, per account at one address and per account before further attempts are refused.",
    },
    SettingDef {
        key: "security.login_window_secs",
        scope: Scope::Server,
        default: || json!(15 * 60),
        ui_editable: false,
        description: "The window in which failed sign-ins are counted.",
    },
    SettingDef {
        key: "security.setup_max_failures",
        scope: Scope::Server,
        default: || json!(100),
        ui_editable: false,
        description: "Wrong setup codes from all addresses together before addresses that guessed are refused.",
    },
    SettingDef {
        key: "security.setup_window_secs",
        scope: Scope::Server,
        default: || json!(60 * 60),
        ui_editable: false,
        description: "The window in which wrong setup codes from all addresses are counted.",
    },
    SettingDef {
        key: "log.level",
        scope: Scope::Server,
        default: || json!("info"),
        ui_editable: false,
        description: "Log filter, such as info or kalzit=debug,info.",
    },
    SettingDef {
        key: "log.format",
        scope: Scope::Server,
        default: || json!("text"),
        ui_editable: false,
        description: "Log format: text or json.",
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
    IntOneOf(&'static [i64]),
    OneOf(&'static [&'static str]),
    Strings {
        max_items: usize,
        max_chars: usize,
    },
    TimeRange,
    Bool,
    /// `HH:MM-HH:MM`, two different times of day.
    TimeWindow,
    Text {
        max_chars: usize,
        multiline: bool,
        required: bool,
    },
    Accent,
    /// An IANA time zone name, or `browser`.
    TimeZone,
    /// Read from the configuration and never written here; the configuration checks it at start.
    Configuration,
    /// An organization's appearance: `inherit` (the server's value) or what the server accepts.
    Inherit(Box<Rule>),
}

fn time_of_day(text: &str) -> Option<u32> {
    let (h, m) = text.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// The value of an organization's appearance setting that follows the server.
pub const INHERIT: &str = "inherit";

/// The rule of a setting in its scope.
fn rule_for(key: &str, scope: Scope) -> Option<Rule> {
    // An organization's AI limits and retention follow the server's or lower them
    // (`ai::service` takes the lower of both).
    if scope == Scope::Org && (key.starts_with("appearance.") || (key.starts_with("ai.") && key != "ai.org_enabled")) {
        return Some(Rule::Inherit(Box::new(rule(key)?)));
    }
    rule(key)
}

fn rule(key: &str) -> Option<Rule> {
    if config_backed(key).is_some() && !key.starts_with("sessions.") {
        return Some(Rule::Configuration);
    }
    Some(match key {
        "datasources.sqlite_dirs" | "datasources.allowed_targets" => Rule::Strings { max_items: 100, max_chars: 1024 },
        "datasources.file_dirs" => Rule::Strings { max_items: 100, max_chars: 1024 },
        "datasources.query_timeout_secs" => Rule::Int { min: 1, max: 3600 },
        "datasources.max_rows" => Rule::Int { min: 1, max: 10_000_000 },
        "datasources.max_response_bytes" => Rule::Int { min: 1024, max: 1024 * 1024 * 1024 },
        "datasources.max_parallel_queries" => Rule::Int { min: 1, max: 10_000 },
        "datasources.max_inflight_bytes" => Rule::Int { min: 1024 * 1024, max: 64 * 1024 * 1024 * 1024 },
        "ai.enabled" | "ai.org_enabled" | "ai.allow_org_providers" => Rule::Bool,
        "ai.request_timeout_secs" => Rule::Int { min: 5, max: 900 },
        "ai.user_requests_per_day" => Rule::Int { min: 0, max: 10_000_000 },
        "ai.user_tokens_per_day" | "ai.org_tokens_per_month" => Rule::Int { min: 0, max: 100_000_000_000 },
        "ai.max_concurrent" => Rule::Int { min: 1, max: 1_000 },
        "ai.max_concurrent_per_user" => Rule::Int { min: 1, max: 100 },
        "ai.max_concurrent_per_org" => Rule::Int { min: 1, max: 1_000 },
        "ai.max_rows_to_model" => Rule::Int { min: 1, max: 10_000 },
        "ai.max_tool_calls" => Rule::Int { min: 1, max: 100 },
        // 0 keeps no chats at all.
        "ai.chat_retention_days" => Rule::Int { min: 0, max: 3_650 },
        "ai.notice_text" => Rule::Text { max_chars: 2000, multiline: true, required: false },
        // At least a day, so a slip of the keyboard cannot wipe the log at the next run.
        "audit.retention_days" => Rule::Int { min: 1, max: 36_500 },
        "appearance.default_language" => Rule::OneOf(&["de", "en"]),
        "appearance.default_theme" => Rule::OneOf(&["system", "light", "dark", "contrast"]),
        // The same bounds as `config.rs`, which checks the file and environment at startup.
        "sessions.lifetime_hours" => Rule::Int { min: 1, max: 10 * 365 * 24 },
        "sessions.idle_timeout_hours" => Rule::Int { min: 0, max: 10 * 365 * 24 },
        "dashboards.version_retention" => Rule::Int { min: 0, max: 100_000 },
        "dashboards.default_time_range" => Rule::TimeRange,
        "dashboards.new_in_team_space" => Rule::Bool,
        "appearance.product_name" => Rule::Text { max_chars: 40, multiline: false, required: true },
        "appearance.accent" => Rule::Accent,
        "appearance.density" => Rule::OneOf(crate::appearance::DENSITIES),
        "appearance.font_size" => Rule::IntOneOf(crate::appearance::FONT_SIZES),
        "appearance.start_page" => Rule::OneOf(crate::appearance::START_PAGES),
        "appearance.time_zone" => Rule::TimeZone,
        "appearance.week_start" => Rule::OneOf(crate::routes::preferences::WEEK_STARTS),
        "signin.welcome" => Rule::Text { max_chars: 280, multiline: true, required: false },
        "signin.notice" => Rule::Text { max_chars: 2000, multiline: true, required: false },
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
pub fn validate(def: &SettingDef, value: &Value) -> Result<(), String> {
    let key = def.key;
    let Some(rule) = rule_for(key, def.scope) else { return Err(format!("{key} has no validation rule")) };
    check_rule(key, &rule, value)
}

fn check_rule(key: &str, rule: &Rule, value: &Value) -> Result<(), String> {
    match rule {
        Rule::Inherit(inner) => {
            if value.as_str() == Some(INHERIT) {
                Ok(())
            } else {
                check_rule(key, inner, value).map_err(|e| format!("{e} (or {INHERIT})"))
            }
        }
        Rule::Configuration => Err(format!("{key} is set in kalzit.toml or the environment")),
        Rule::IntOneOf(allowed) => match value.as_i64() {
            Some(n) if allowed.contains(&n) => Ok(()),
            _ => Err(format!(
                "{key} must be one of {}",
                allowed.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")
            )),
        },
        Rule::Text { max_chars, multiline, required } => match value.as_str() {
            Some(s) => crate::appearance::validate_text(s, *max_chars, *multiline, *required)
                .map_err(|e| format!("{key}: {e}")),
            None => Err(format!("{key} must be a text")),
        },
        Rule::Accent => match value.as_str() {
            Some(s) => crate::appearance::validate_accent(s).map_err(|e| format!("{key}: {e}")),
            None => Err(format!("{key} must be a text")),
        },
        Rule::TimeZone => match value.as_str() {
            Some(s) if s == "browser" || crate::routes::preferences::is_time_zone_name(s) => Ok(()),
            _ => Err(format!("{key} must be an IANA time zone name such as Europe/Berlin, or browser")),
        },
        Rule::Int { .. } | Rule::OneOf(_) | Rule::Strings { .. } | Rule::TimeRange | Rule::TimeWindow | Rule::Bool => {
            check_basic(key, rule, value)
        }
    }
}

fn check_basic(key: &str, rule: &Rule, value: &Value) -> Result<(), String> {
    match *rule {
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
        _ => Err(format!("{key} has no plain rule")),
    }
}

/// A setting that lives in the configuration: how to read it. Its environment variable is
/// `KALZIT_<SECTION>_<KEY>` (`config_env_var`).
struct ConfigBacked {
    read: fn(&Config) -> Value,
}

/// `sessions.lifetime_hours` -> `KALZIT_SESSIONS_LIFETIME_HOURS`.
fn config_env_var(key: &str) -> String {
    format!("KALZIT_{}", key.replace('.', "_").to_ascii_uppercase())
}

fn config_backed(key: &str) -> Option<ConfigBacked> {
    let read: fn(&Config) -> Value = match key {
        "sessions.lifetime_hours" => |c| json!(c.sessions.lifetime_hours),
        "sessions.idle_timeout_hours" => |c| json!(c.sessions.idle_timeout_hours),
        "server.http_addr" => |c| json!(c.server.http_addr),
        "server.https_addr" => |c| json!(c.server.https_addr),
        "server.public_url" => |c| json!(c.server.public_url),
        "server.redirect_http_to_https" => |c| json!(c.server.redirect_http_to_https),
        "tls.cert_file" => |c| json!(c.tls.cert_file.as_ref().map(|p| p.display().to_string())),
        "tls.min_version" => |c| json!(c.tls.min_version),
        "tls.reload_interval_secs" => |c| json!(c.tls.reload_interval_secs),
        "security.trusted_proxies" => {
            |c| json!(c.security.trusted_proxies.iter().map(ToString::to_string).collect::<Vec<_>>())
        }
        "security.hsts" => |c| json!(c.security.hsts),
        "security.hsts_max_age_secs" => |c| json!(c.security.hsts_max_age_secs),
        "security.login_max_failures" => |c| json!(c.security.login_max_failures),
        "security.login_window_secs" => |c| json!(c.security.login_window_secs),
        "security.setup_max_failures" => |c| json!(c.security.setup_max_failures),
        "security.setup_window_secs" => |c| json!(c.security.setup_window_secs),
        "log.level" => |c| json!(c.log.level),
        "log.format" => |c| json!(c.log.format),
        _ => return None,
    };
    Some(ConfigBacked { read })
}

/// Whether a setting lives in the configuration (`kalzit.toml` and `KALZIT_<SECTION>_<KEY>`).
pub fn is_configuration(key: &str) -> bool {
    config_backed(key).is_some()
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
        validate(def, &parse_env_value(&raw)).map_err(|e| format!("{name}: {e}"))?;
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
            let source = if env(&config_env_var(def.key)).is_some() {
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
            validate(def, &value).map_err(|e| format!("{name}: {e}"))?;
            return Ok(row(value, Source::Env));
        }
    }
    // A reset leaves `null` behind with its version (`RESET_VALUE`): the default applies.
    if let Some(stored) = stored.filter(|s| !s.value.is_null()) {
        match validate(def, &stored.value) {
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

/// The stored value of a setting that was reset: the row stays with its version, so versions keep
/// counting up and a write that names a version from before the reset is refused. No setting
/// accepts `null`, so it never stands for a real value.
///
/// Why a marker and not a delete: the version is the only thing a write is checked against, and a
/// deleted row starts again at version 0. Then a page opened before the reset and the first save
/// after it would name the same versions (0, 1, ...), and a stale write would silently replace
/// the newer value. Every reader skips the marker: `resolve` (value, list, export, import
/// preview) treats it as no value, and `updates::cli::health_timeout`, which reads the table
/// directly, refuses it as invalid (tests `a_reset_in_a_batch_brings_the_default_back` and
/// `the_health_timeout_skips_a_reset_marker`).
const RESET_VALUE: &str = "null";

/// Removes a setting's stored value if its version is still `expected`, so the default applies
/// again (rather than a stored copy of it). The row stays as a marker with the next version (see
/// `RESET_VALUE`). Answers the new version (0 for a setting never saved, which has nothing to
/// remove), or `None` when someone else saved first. Same transaction and cache rules as `store`.
pub async fn reset(
    conn: &mut sqlx::AnyConnection,
    org_id: Option<&str>,
    key: &str,
    expected: i64,
    user_id: &str,
    now_ms: i64,
) -> ApiResult<Option<i64>> {
    if expected == 0 {
        let stored: Option<(i64,)> = match org_id {
            None => {
                sqlx::query_as("SELECT version FROM server_settings WHERE key = $1")
                    .bind(key)
                    .fetch_optional(&mut *conn)
                    .await?
            }
            Some(org) => {
                sqlx::query_as("SELECT version FROM org_settings WHERE org_id = $1 AND key = $2")
                    .bind(org)
                    .bind(key)
                    .fetch_optional(&mut *conn)
                    .await?
            }
        };
        return Ok(stored.is_none().then_some(0));
    }
    let next = expected + 1;
    let affected = match org_id {
        None => {
            sqlx::query(
                "UPDATE server_settings SET value = $1, version = $2, updated_by = $3, updated_at = $4 \
                 WHERE key = $5 AND version = $6",
            )
            .bind(RESET_VALUE)
            .bind(next)
            .bind(user_id)
            .bind(now_ms)
            .bind(key)
            .bind(expected)
            .execute(&mut *conn)
            .await?
        }
        Some(org) => {
            sqlx::query(
                "UPDATE org_settings SET value = $1, version = $2, updated_by = $3, updated_at = $4 \
                 WHERE org_id = $5 AND key = $6 AND version = $7",
            )
            .bind(RESET_VALUE)
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
            assert!(seen.insert((d.key, d.scope == Scope::Server)), "{} twice in one scope", d.key);
            assert!(d.key.contains('.'), "{} needs an area prefix", d.key);
            assert!(!d.description.is_empty());
            // A key in both scopes is an organization override of the server's value.
            if d.scope == Scope::Org && find(d.key, Scope::Server).is_some() {
                assert!(d.key.starts_with("appearance.") || d.key.starts_with("ai."), "{} is in both scopes", d.key);
                assert_eq!((d.default)(), json!(INHERIT), "{} starts by following the server", d.key);
            }
        }
    }

    #[test]
    fn every_setting_has_a_rule_its_default_passes() {
        for d in REGISTRY {
            if is_configuration(d.key) && !d.key.starts_with("sessions.") {
                // Checked by `config.rs` at start, never written here.
                assert!(!d.ui_editable && validate(d, &(d.default)()).is_err(), "{}", d.key);
                continue;
            }
            assert!(validate(d, &(d.default)()).is_ok(), "{}: {:?}", d.key, validate(d, &(d.default)()));
        }
    }

    /// Checks against the server setting of `key`, else its organization setting.
    fn check(key: &str, value: &Value) -> Result<(), String> {
        let def = find(key, Scope::Server).or_else(|| find(key, Scope::Org)).ok_or("unknown")?;
        validate(def, value)
    }

    #[test]
    fn appearance_settings_take_vetted_values() {
        let org = |key: &str| find(key, Scope::Org).unwrap();
        for (key, good, bad) in [
            ("appearance.accent", json!("teal"), json!("pink")),
            ("appearance.accent", json!("#2563eb"), json!("#ffffff")),
            ("appearance.density", json!("compact"), json!("tight")),
            ("appearance.font_size", json!(16), json!(17)),
            ("appearance.start_page", json!("explore"), json!("/admin")),
            ("appearance.time_zone", json!("Europe/Berlin"), json!("Europe/../etc")),
            ("appearance.week_start", json!("sunday"), json!("friday")),
            ("appearance.product_name", json!("Datenwerk"), json!("")),
            ("signin.welcome", json!("Willkommen!\nMelde dich an."), json!("a\u{0007}")),
        ] {
            assert!(check(key, &good).is_ok(), "{key} refused {good}");
            assert!(check(key, &bad).is_err(), "{key} accepted {bad}");
        }
        // Organizations may follow the server; the server itself has nothing to inherit from.
        assert!(validate(org("appearance.accent"), &json!("inherit")).is_ok());
        assert!(validate(org("appearance.accent"), &json!("#ffffff")).is_err());
        assert!(validate(org("appearance.font_size"), &json!(15)).is_ok());
        assert!(check("appearance.accent", &json!("inherit")).is_err());
        assert!(check("appearance.product_name", &json!("x".repeat(41))).is_err());
        assert!(check("appearance.product_name", &json!("Zwei\nZeilen")).is_err());
    }

    #[test]
    fn configuration_values_are_read_with_their_source() {
        let def = server_def("server.http_addr");
        let mut config = Config::default();
        config.server.http_addr = "127.0.0.1:8080".into();
        let file = resolve(def, &|_: &str| None, &|key: &str| key == "server.http_addr", &config, None).unwrap();
        assert_eq!((&file.value, file.source), (&json!("127.0.0.1:8080"), Source::File));
        let env = |name: &str| (name == "KALZIT_SERVER_HTTP_ADDR").then(|| "x".to_string());
        assert_eq!(resolve(def, &env, &|_: &str| false, &config, None).unwrap().source, Source::Env);
        assert!(!editable(def, &file));
        // Never through KALZIT_SETTING_*: the configuration's own variable applies.
        let vars = vec![("KALZIT_SETTING_SERVER_HTTP_ADDR".to_string(), "x".to_string())];
        assert!(check_environment(vars).is_err());
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
            assert!(check(key, &bad).is_err(), "{key} accepted {bad}");
        }
        assert!(check("datasources.sqlite_dirs", &json!(["D:/Daten/Ümlaut"])).is_ok());
        assert!(check("no.such", &json!(1)).is_err());
    }

    /// Matches `config.rs`: a session lasts at least an hour; idle timeout 0 means never.
    #[test]
    fn session_lifetime_needs_at_least_an_hour() {
        let max = 10 * 365 * 24;
        assert!(check("sessions.lifetime_hours", &json!(0)).is_err());
        assert!(check("sessions.lifetime_hours", &json!(1)).is_ok());
        assert!(check("sessions.lifetime_hours", &json!(max)).is_ok());
        assert!(check("sessions.lifetime_hours", &json!(max + 1)).is_err());
        assert!(check("sessions.idle_timeout_hours", &json!(0)).is_ok());
        assert!(check("sessions.idle_timeout_hours", &json!(max + 1)).is_err());
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
