//! Server configuration: defaults, then `kalzit.toml`, then `KALZIT_<SECTION>_<KEY>` environment
//! variables. Network and TLS settings are only configurable here, never in the UI, so a wrong
//! value cannot lock the admin out of the settings page.

use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use ipnet::IpNet;
use serde::{Deserialize, Serialize};

const ENV_PREFIX: &str = "KALZIT_";
const SECTIONS: &[&str] = &["server", "tls", "security", "sessions", "database", "paths", "log"];
/// `KALZIT_*` variables that are not settings. Any other `KALZIT_*` name is a typo and an error.
const OTHER_VARIABLES: &[&str] = &[
    "CONFIG",
    "DATABASE_URL_FILE",
    "SETUP_TOKEN",
    "SECRETS_KEY",
    "SECRETS_NEW_KEY",
    "SECRETS_OLD_KEY",
    "TEST_POSTGRES_URL",
    "TEST_MYSQL_URL",
    "TEST_MARIADB_URL",
    "TEST_REQUIRE_DATABASES",
    "TEST_MSSQL_URL",
    "TEST_PROMETHEUS_URL",
];
/// The credential (systemd `LoadCredential=`, a Docker secret under `/run/secrets` with
/// `CREDENTIALS_DIRECTORY` set) that holds the URL of Kalzit's own database, so its password is
/// in no environment variable.
pub const DATABASE_URL_CREDENTIAL: &str = "kalzit-database-url";
/// `KALZIT_SETTING_<KEY>`: runtime settings from `settings::REGISTRY`, not configuration sections.
const SETTING_PREFIX: &str = "SETTING_";
/// Settings without a default value; they do not appear in the serialized defaults.
const OPTIONAL_KEYS: &[&str] = &["public_url", "cert_file", "key_file", "url"];
/// Ten years. Longer values would overflow the millisecond arithmetic and make no sense anyway.
const MAX_SESSION_HOURS: u64 = 10 * 365 * 24;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub tls: TlsConfig,
    pub security: SecurityConfig,
    pub sessions: SessionConfig,
    pub database: DatabaseConfig,
    pub paths: PathsConfig,
    pub log: LogConfig,
    /// The settings `kalzit.toml` sets, as `section.key`, so the settings page can tell a value
    /// from the file from the default even when both are equal.
    #[serde(skip)]
    pub file_keys: BTreeSet<String>,
    /// The settings `KALZIT_*` variables set, as `section.key`; they win over the file.
    #[serde(skip)]
    pub env_keys: BTreeSet<String>,
    /// Problems found while loading that do not stop the start; logged once logging is set up.
    #[serde(skip)]
    pub warnings: Vec<String>,
    /// The configuration file this was read from (absolute), if any. Data sources may never
    /// read it.
    #[serde(skip)]
    pub config_file: Option<PathBuf>,
    /// The file the database URL was read from (`KALZIT_DATABASE_URL_FILE` or the credential
    /// `kalzit-database-url`), if any. Data sources may never read it.
    #[serde(skip)]
    pub database_url_file: Option<PathBuf>,
}

/// The layer a configuration value came from.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Source {
    #[default]
    Default,
    File,
    Environment,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Plain HTTP listener. Empty string disables it.
    pub http_addr: String,
    /// HTTPS listener with `tls.cert_file` and `tls.key_file`, or without them the certificate
    /// ACME orders (`acme`). Empty string disables it.
    pub https_addr: String,
    /// The URL users open, e.g. `https://kalzit.example.com`. Used for the origin check and links.
    pub public_url: Option<String>,
    /// When HTTPS is on, answer plain HTTP with a redirect (health endpoints stay reachable).
    pub redirect_http_to_https: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct TlsConfig {
    pub cert_file: Option<PathBuf>,
    pub key_file: Option<PathBuf>,
    /// "1.2" or "1.3".
    pub min_version: String,
    /// How often the certificate files are checked for changes, in seconds (0 = never).
    pub reload_interval_secs: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SecurityConfig {
    pub hsts: bool,
    pub hsts_max_age_secs: u64,
    /// Reverse proxies whose `X-Forwarded-*` headers are trusted. Everyone else's are ignored.
    pub trusted_proxies: Vec<IpNet>,
    /// Sign-in attempts per client address, per account at one address and per account from all
    /// addresses (except from known devices) before further attempts are refused; an IPv6 /48
    /// has five times as many for all accounts (`app::NETWORK_FAILURES_FACTOR`).
    pub login_max_failures: u32,
    /// The window in which failures are counted, in seconds.
    pub login_window_secs: u64,
    /// Wrong setup codes from all client addresses together in `setup_window_secs`, on top of
    /// the per-address limit (`login_*`). Used up, each address gets only a few more tries, so
    /// many addresses cannot guess the code in parallel; the right code still opens setup.
    pub setup_max_failures: u32,
    /// The window of `setup_max_failures`, in seconds.
    pub setup_window_secs: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SessionConfig {
    /// A session ends this long after sign-in, however active it is.
    pub lifetime_hours: u64,
    /// A session ends after this long without a request. 0 turns the idle timeout off.
    pub idle_timeout_hours: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct DatabaseConfig {
    /// `sqlite://...` or `postgres://...`. Default: SQLite file in the data directory.
    pub url: Option<String>,
    pub max_connections: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PathsConfig {
    /// Database, setup code and fallback key file. Default: `%ProgramData%\Kalzit\data` on
    /// Windows, `/var/lib/kalzit` elsewhere. A relative path in `kalzit.toml` is relative to the
    /// file; one from the environment is relative to the working directory.
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct LogConfig {
    /// A tracing filter, e.g. "info" or "kalzit=debug,info".
    pub level: String,
    /// "text" or "json".
    pub format: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            http_addr: "0.0.0.0:3000".into(),
            https_addr: String::new(),
            public_url: None,
            redirect_http_to_https: true,
        }
    }
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self { cert_file: None, key_file: None, min_version: "1.2".into(), reload_interval_secs: 60 }
    }
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            hsts: true,
            // One year, the value browsers' preload lists expect.
            hsts_max_age_secs: 31_536_000,
            trusted_proxies: Vec::new(),
            login_max_failures: 10,
            login_window_secs: 15 * 60,
            setup_max_failures: 100,
            setup_window_secs: 60 * 60,
        }
    }
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self { lifetime_hours: 30 * 24, idle_timeout_hours: 7 * 24 }
    }
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self { url: None, max_connections: 10 }
    }
}

impl Default for PathsConfig {
    fn default() -> Self {
        // Empty when there is no default (Windows without `ProgramData`); `validate` says so.
        Self { data_dir: default_data_dir().unwrap_or_default() }
    }
}

/// The system folder for Kalzit's data, used when nothing is configured.
#[cfg(windows)]
pub fn default_data_dir() -> Option<PathBuf> {
    windows_data_dir(std::env::var_os("ProgramData"))
}

/// The system folder for Kalzit's data, used when nothing is configured.
#[cfg(not(windows))]
pub fn default_data_dir() -> Option<PathBuf> {
    Some(PathBuf::from("/var/lib/kalzit"))
}

/// `%ProgramData%\Kalzit`: the system configuration file and the default data directory.
#[cfg(windows)]
pub fn program_data_folder() -> Option<PathBuf> {
    windows_program_data_folder(std::env::var_os("ProgramData"))
}

#[cfg(windows)]
fn windows_program_data_folder(program_data: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let base = PathBuf::from(program_data?);
    base.is_absolute().then(|| base.join("Kalzit"))
}

#[cfg(windows)]
fn windows_data_dir(program_data: Option<std::ffi::OsString>) -> Option<PathBuf> {
    windows_program_data_folder(program_data).map(|folder| folder.join("data"))
}

impl Default for LogConfig {
    fn default() -> Self {
        Self { level: "info".into(), format: "text".into() }
    }
}

impl Config {
    /// Loads the configuration from `path` (or the first existing default location) and the
    /// process environment.
    pub fn load(path: Option<&Path>) -> Result<Self> {
        let file = match path {
            Some(p) => Some(p.to_path_buf()),
            None => default_config_paths().into_iter().find(|p| p.is_file()),
        };
        let mut env = Vec::new();
        for (name, value) in std::env::vars_os() {
            let Some(name) = name.to_str().filter(|n| n.starts_with(ENV_PREFIX)) else { continue };
            let value = value.into_string().map_err(|_| anyhow::anyhow!("{name} is not valid UTF-8"))?;
            env.push((name.to_string(), value));
        }
        let credentials = std::env::var_os("CREDENTIALS_DIRECTORY").filter(|d| !d.is_empty()).map(PathBuf::from);
        let url_file = database_url_from_file(&mut env, credentials.as_deref())?;
        // The system file decides where the data lives and which certificate is served, so a
        // non-admin must not be able to change it.
        #[cfg(windows)]
        if let (Some(f), Some(folder)) = (&file, program_data_folder())
            && crate::data_dir::is_directly_in(f, &folder)
        {
            crate::data_dir::check_admin_only(&folder)?;
            crate::data_dir::check_admin_only(f)?;
        }
        let mut config = Self::from_file(file.as_deref(), env)?;
        config.database_url_file = url_file;
        Ok(config)
    }

    /// The data directory, read as leniently as possible, for when the configuration as a whole
    /// did not load: the start of a new version that refuses the configuration must still find
    /// the update plan and return (`updates::boot::after_config_error`). Environment first, then
    /// `paths.data_dir` of the file (relative to its folder), then the default.
    pub fn data_dir_hint(path: Option<&Path>) -> Option<PathBuf> {
        if let Some(dir) = std::env::var_os("KALZIT_PATHS_DATA_DIR").filter(|d| !d.is_empty()) {
            return std::path::absolute(PathBuf::from(dir)).ok();
        }
        let file = match path {
            Some(p) => Some(p.to_path_buf()),
            None => default_config_paths().into_iter().find(|p| p.is_file()),
        };
        if let Some(file) = file
            && let Ok(text) = std::fs::read_to_string(&file)
            && let Ok(doc) = toml::from_str::<toml::Table>(&text)
            && let Some(dir) = doc.get("paths").and_then(|p| p.get("data_dir")).and_then(|d| d.as_str())
        {
            let dir = PathBuf::from(dir);
            if dir.is_absolute() {
                return Some(dir);
            }
            let base = std::path::absolute(&file).ok()?.parent()?.to_path_buf();
            return Some(base.join(dir));
        }
        default_data_dir()
    }

    /// Where the value of `section.key` came from.
    pub fn source(&self, key: &str) -> Source {
        if self.env_keys.contains(key) {
            Source::Environment
        } else if self.file_keys.contains(key) {
            Source::File
        } else {
            Source::Default
        }
    }

    /// Reads `file` (if any), merges `env` and resolves relative paths: those from the file
    /// (data directory, certificate and key, a SQLite database URL) against the folder of the
    /// file; a data directory from the environment against the working directory, with a warning.
    pub fn from_file(file: Option<&Path>, env: impl IntoIterator<Item = (String, String)>) -> Result<Self> {
        let text = match file {
            Some(p) => {
                std::fs::read_to_string(p).with_context(|| format!("reading configuration from {}", p.display()))?
            }
            None => String::new(),
        };
        let mut config = Self::from_sources(&text, env).with_context(|| match file {
            Some(p) => format!("in configuration {} or KALZIT_* variables", p.display()),
            None => "in KALZIT_* variables".into(),
        })?;
        let file_dir = match file {
            Some(f) => Some(
                std::path::absolute(f)
                    .context("resolving the configuration path")?
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_default(),
            ),
            None => None,
        };
        // Only a value that really came from the file is relative to it.
        let from_file = |c: &Config, key: &str| file_dir.as_ref().filter(|_| c.source(key) == Source::File);

        if let Some(base) = from_file(&config, "tls.cert_file") {
            config.tls.cert_file = config.tls.cert_file.as_ref().map(|p| base.join(p));
        }
        if let Some(base) = from_file(&config, "tls.key_file") {
            config.tls.key_file = config.tls.key_file.as_ref().map(|p| base.join(p));
        }
        if let Some(base) = from_file(&config, "database.url")
            && let Some(url) = config.database.url.as_deref().and_then(|u| resolve_sqlite_url(u, base))
        {
            config.database.url = Some(url);
        }
        let dir = &config.paths.data_dir;
        if dir.is_relative() {
            let base = match from_file(&config, "paths.data_dir") {
                Some(base) => base.clone(),
                None => std::env::current_dir().context("reading the working directory")?,
            };
            if config.source("paths.data_dir") == Source::Environment {
                config.warnings.push(format!(
                    "KALZIT_PATHS_DATA_DIR \"{}\" is a relative path, so the data directory depends on the \
                     working directory; use an absolute path",
                    dir.display()
                ));
            }
            config.paths.data_dir = base.join(dir);
        }
        config.config_file = match file {
            Some(f) => Some(std::path::absolute(f).context("resolving the configuration path")?),
            None => None,
        };
        Ok(config)
    }

    /// Merges a TOML document with `KALZIT_<SECTION>_<KEY>` variables and validates the result.
    pub fn from_sources(toml_text: &str, env: impl IntoIterator<Item = (String, String)>) -> Result<Self> {
        let mut doc: toml::Table = toml::from_str(toml_text).context("parsing TOML")?;
        let file_keys: BTreeSet<String> = doc
            .iter()
            .filter_map(|(section, v)| v.as_table().map(|t| (section, t)))
            .flat_map(|(section, table)| table.keys().map(move |key| format!("{section}.{key}")))
            .collect();
        let defaults = toml::Table::try_from(Config::default()).context("serializing the defaults")?;
        let mut env_keys = BTreeSet::new();
        for (name, raw) in env {
            let Some(rest) = name.strip_prefix(ENV_PREFIX) else { continue };
            // Runtime settings (`KALZIT_SETTING_<KEY>`) are checked by `settings::check_environment`.
            if OTHER_VARIABLES.contains(&rest) || rest.to_ascii_uppercase().starts_with(SETTING_PREFIX) {
                continue;
            }
            let lower = rest.to_ascii_lowercase();
            let Some(section) = SECTIONS.iter().find(|s| lower.starts_with(&format!("{s}_"))) else {
                bail!(
                    "unknown variable {name}: settings are {ENV_PREFIX}<SECTION>_<KEY> with a section from {SECTIONS:?}"
                );
            };
            let key = &lower[section.len() + 1..];
            let default = defaults.get(*section).and_then(|t| t.get(key));
            let table = doc.entry(section.to_string()).or_insert_with(|| toml::Value::Table(toml::Table::new()));
            let toml::Value::Table(table) = table else { bail!("[{section}] is not a table") };
            // An empty optional setting (`KALZIT_DATABASE_URL=` in docker-compose) means "not set".
            env_keys.insert(format!("{section}.{key}"));
            if default.is_none() && raw.trim().is_empty() {
                table.remove(key);
                continue;
            }
            let value = env_value(&name, &raw, default, key)?;
            table.insert(key.to_string(), value);
        }
        let mut config: Config = toml::Value::Table(doc).try_into().context("reading settings")?;
        config.file_keys = file_keys;
        config.env_keys = env_keys;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        if self.server.http_addr.is_empty() && self.server.https_addr.is_empty() {
            bail!("server.http_addr and server.https_addr are both empty; nothing to listen on");
        }
        for (key, addr) in [("http_addr", &self.server.http_addr), ("https_addr", &self.server.https_addr)] {
            if !addr.is_empty() {
                addr.parse::<SocketAddr>()
                    .with_context(|| format!("server.{key} \"{addr}\" is not an address like 0.0.0.0:3000"))?;
            }
        }
        // Without certificate files, HTTPS serves the certificate ACME orders (Settings, Network),
        // and a temporary self-signed one until then.
        if self.tls.cert_file.is_some() != self.tls.key_file.is_some() {
            bail!("tls.cert_file and tls.key_file are set together, or neither (then ACME provides the certificate)");
        }
        if !matches!(self.tls.min_version.as_str(), "1.2" | "1.3") {
            bail!("tls.min_version must be \"1.2\" or \"1.3\"");
        }
        if !matches!(self.log.format.as_str(), "text" | "json") {
            bail!("log.format must be \"text\" or \"json\"");
        }
        if let Some(url) = &self.server.public_url {
            // The origin check and the HTTPS redirect both rely on this exact shape.
            let host =
                url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")).map(|h| h.trim_end_matches('/'));
            let plain = host.is_some_and(|h| !h.is_empty() && !h.contains(['/', '?', '#']));
            if !plain || crate::net::parse_origin(url).is_none() {
                bail!("server.public_url must be a scheme and host like https://kalzit.example.com, without a path");
            }
        }
        let s = &self.sessions;
        if s.lifetime_hours == 0 || s.lifetime_hours > MAX_SESSION_HOURS || s.idle_timeout_hours > MAX_SESSION_HOURS {
            bail!(
                "sessions.lifetime_hours must be 1 to {MAX_SESSION_HOURS}, idle_timeout_hours 0 to {MAX_SESSION_HOURS}"
            );
        }
        if self.security.login_max_failures == 0 || self.security.login_window_secs == 0 {
            bail!("security.login_max_failures and security.login_window_secs must be at least 1");
        }
        if self.security.setup_max_failures == 0 || self.security.setup_window_secs == 0 {
            bail!("security.setup_max_failures and security.setup_window_secs must be at least 1");
        }
        if self.database.max_connections == 0 {
            bail!("database.max_connections must be at least 1");
        }
        // Without `scheme://` there is no host part, the password cannot be told apart, and
        // the value is never echoed here.
        if let Some(url) = &self.database.url
            && !url.starts_with("sqlite:")
            && !url.split_once("://").is_some_and(|(scheme, _)| crate::db::is_scheme(scheme))
        {
            bail!("database.url must look like postgres://user:pass@host/db (or sqlite:path)");
        }
        // Owner decision: no other backend for Kalzit's own data. The value is not echoed.
        if let Some(url) = &self.database.url
            && !url.starts_with("sqlite:")
            && !url
                .split_once("://")
                .is_some_and(|(scheme, _)| ["postgres", "postgresql"].contains(&scheme.to_ascii_lowercase().as_str()))
        {
            bail!("Kalzit's own database must be SQLite or PostgreSQL (database.url)");
        }
        if self.paths.data_dir.to_string_lossy().trim().is_empty() {
            match self.source("paths.data_dir") {
                Source::Default => bail!(
                    "the ProgramData environment variable is not set, so there is no default data directory; \
                     set paths.data_dir or KALZIT_PATHS_DATA_DIR"
                ),
                _ => bail!("paths.data_dir is empty"),
            }
        }
        tracing_subscriber::EnvFilter::try_new(&self.log.level)
            .with_context(|| format!("log.level \"{}\" is not a filter like \"info\"", self.log.level))?;
        Ok(())
    }

    pub fn http_addr(&self) -> Option<SocketAddr> {
        self.server.http_addr.parse().ok()
    }

    pub fn https_addr(&self) -> Option<SocketAddr> {
        self.server.https_addr.parse().ok()
    }

    /// The database URL, defaulting to `kalzit.db` in the data directory.
    pub fn database_url(&self) -> String {
        match &self.database.url {
            Some(url) => url.clone(),
            None => sqlite_url(&self.paths.data_dir.join("kalzit.db")),
        }
    }
}

/// A SQLite URL for a file path. No `//` after the scheme: sqlx parses the URL, and with `//` a
/// Windows drive letter (`C:`) would be read as a host name. Characters that end the path in a URL
/// are percent-encoded; sqlx decodes them again.
pub fn sqlite_url(path: &Path) -> String {
    format!("sqlite:{}?mode=rwc", sqlite_path(path))
}

fn sqlite_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace('%', "%25").replace('?', "%3F").replace('#', "%23")
}

/// A `sqlite:` URL with a relative file path, rebased onto `base`. `None` for every other URL:
/// other engines, absolute paths and in-memory databases.
fn resolve_sqlite_url(url: &str, base: &Path) -> Option<String> {
    let rest = url.strip_prefix("sqlite:")?;
    let rest = rest.strip_prefix("//").unwrap_or(rest);
    let (path, query) = match rest.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (rest, None),
    };
    if path.is_empty() || path.starts_with([':', '/', '\\']) || Path::new(path).is_absolute() {
        return None;
    }
    let joined = format!("sqlite:{}/{path}", sqlite_path(base).trim_end_matches('/'));
    Some(match query {
        Some(query) => format!("{joined}?{query}"),
        None => joined,
    })
}

/// Converts an environment value to the type the setting has, so `KALZIT_TLS_MIN_VERSION=1.3`
/// stays the string "1.3" and `KALZIT_SERVER_REDIRECT_HTTP_TO_HTTPS=off` becomes a bool.
fn env_value(name: &str, raw: &str, default: Option<&toml::Value>, key: &str) -> Result<toml::Value> {
    let trimmed = raw.trim();
    Ok(match default {
        None if !OPTIONAL_KEYS.contains(&key) => bail!("unknown variable {name}: there is no such setting"),
        // Strings, and optional settings without a default (paths, URLs), are taken verbatim.
        None | Some(toml::Value::String(_)) => toml::Value::String(raw.to_string()),
        Some(toml::Value::Integer(_)) => toml::Value::Integer(
            trimmed.parse().with_context(|| format!("{name} must be a whole number, not \"{raw}\""))?,
        ),
        Some(toml::Value::Boolean(_)) => toml::Value::Boolean(match trimmed.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "on" => true,
            "false" | "0" | "no" | "off" => false,
            _ => bail!("{name} must be true or false, not \"{raw}\""),
        }),
        // Lists: a TOML array (`["10.0.0.0/8"]`) or comma-separated values.
        Some(toml::Value::Array(_)) => match toml::from_str::<toml::Table>(&format!("v = {trimmed}")) {
            Ok(mut t) if matches!(t.get("v"), Some(toml::Value::Array(_))) => {
                t.remove("v").unwrap_or(toml::Value::Array(Vec::new()))
            }
            _ => toml::Value::Array(
                raw.split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(|v| toml::Value::String(v.to_string()))
                    .collect(),
            ),
        },
        Some(other) => bail!("{name}: a setting of type {} cannot come from the environment", other.type_str()),
    })
}

/// Takes the database URL from a file when `KALZIT_DATABASE_URL` does not set one: the file
/// `KALZIT_DATABASE_URL_FILE` names, else the credential `kalzit-database-url` in
/// `credentials_dir`. The URL is added to `env` as `KALZIT_DATABASE_URL` (so it wins over
/// `kalzit.toml` and shows as set by the environment); the file it came from is returned.
/// Errors name the file, never its content.
fn database_url_from_file(env: &mut Vec<(String, String)>, credentials_dir: Option<&Path>) -> Result<Option<PathBuf>> {
    let get = |env: &[(String, String)], name: &str| {
        env.iter().find(|(n, _)| n == name).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty())
    };
    if get(env, "KALZIT_DATABASE_URL").is_some() {
        return Ok(None);
    }
    let path = match get(env, "KALZIT_DATABASE_URL_FILE") {
        Some(p) => PathBuf::from(p),
        None => match credentials_dir.map(|d| d.join(DATABASE_URL_CREDENTIAL)).filter(|p| p.is_file()) {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    let text =
        std::fs::read_to_string(&path).with_context(|| format!("reading the database URL from {}", path.display()))?;
    let url = text.trim();
    if url.is_empty() {
        bail!("the database URL file {} is empty", path.display());
    }
    env.retain(|(n, _)| n != "KALZIT_DATABASE_URL");
    env.push(("KALZIT_DATABASE_URL".into(), url.to_string()));
    Ok(Some(path))
}

fn default_config_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("kalzit.toml")];
    #[cfg(windows)]
    if let Some(folder) = program_data_folder() {
        paths.push(folder.join("kalzit.toml"));
    }
    #[cfg(unix)]
    paths.push(PathBuf::from("/etc/kalzit/kalzit.toml"));
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_directory_is_found_in_a_configuration_that_does_not_load() {
        if std::env::var_os("KALZIT_PATHS_DATA_DIR").is_some() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kalzit.toml");
        std::fs::write(&file, "[paths]\ndata_dir = \"daten\"\n\n[unknown]\nkey = 1\n").unwrap();
        assert!(Config::load(Some(&file)).is_err());
        assert_eq!(Config::data_dir_hint(Some(&file)), Some(std::path::absolute(dir.path()).unwrap().join("daten")));
        std::fs::write(&file, "not toml at all").unwrap();
        assert_eq!(Config::data_dir_hint(Some(&file)), default_data_dir());
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn the_database_url_comes_from_a_file_or_credential_unless_the_variable_sets_it() {
        let dir = tempfile::tempdir().unwrap();
        let creds = dir.path().join("creds");
        std::fs::create_dir(&creds).unwrap();
        std::fs::write(creds.join(DATABASE_URL_CREDENTIAL), "postgres://k:cred@db/k\n").unwrap();
        let file = dir.path().join("url");
        std::fs::write(&file, "postgres://k:p%2Fw@db/k\n").unwrap();
        let file_var = ("KALZIT_DATABASE_URL_FILE".to_string(), file.display().to_string());
        let url_of =
            |env: &[(String, String)]| env.iter().find(|(n, _)| n == "KALZIT_DATABASE_URL").map(|(_, v)| v.clone());

        // The variable wins over the file and the credential.
        let mut e = env(&[("KALZIT_DATABASE_URL", "postgres://k:env@db/k")]);
        e.push(file_var.clone());
        assert_eq!(database_url_from_file(&mut e, Some(&creds)).unwrap(), None);
        assert_eq!(url_of(&e).as_deref(), Some("postgres://k:env@db/k"));

        // The file wins over the credential; an empty variable counts as unset.
        let mut e = env(&[("KALZIT_DATABASE_URL", "")]);
        e.push(file_var);
        assert_eq!(database_url_from_file(&mut e, Some(&creds)).unwrap(), Some(file.clone()));
        assert_eq!(url_of(&e).as_deref(), Some("postgres://k:p%2Fw@db/k"));
        assert_eq!(e.iter().filter(|(n, _)| n == "KALZIT_DATABASE_URL").count(), 1);

        // Then the credential, which wins over kalzit.toml and counts as set by the environment.
        let mut e = env(&[]);
        assert!(database_url_from_file(&mut e, Some(&creds)).unwrap().is_some());
        let c = Config::from_sources("[database]\nurl = 'sqlite:x.db'\n", e).unwrap();
        assert_eq!(c.database.url.as_deref(), Some("postgres://k:cred@db/k"));
        assert_eq!(c.source("database.url"), Source::Environment);

        // Nothing configured: the environment stays as it is.
        let mut e = env(&[]);
        assert_eq!(database_url_from_file(&mut e, Some(dir.path())).unwrap(), None);
        assert_eq!(database_url_from_file(&mut e, None).unwrap(), None);
        assert!(e.is_empty());
    }

    #[test]
    fn a_database_url_file_never_shows_its_content_in_errors() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        let mut e = env(&[("KALZIT_DATABASE_URL_FILE", missing.to_str().unwrap())]);
        let err = format!("{:#}", database_url_from_file(&mut e, None).unwrap_err());
        assert!(err.contains("missing"), "{err}");
        let blank = dir.path().join("blank");
        std::fs::write(&blank, " \n").unwrap();
        let mut e = env(&[("KALZIT_DATABASE_URL_FILE", blank.to_str().unwrap())]);
        assert!(database_url_from_file(&mut e, None).is_err());
        // A URL that is not valid is refused without repeating it.
        let bad = dir.path().join("bad");
        std::fs::write(&bad, "mysql://k:secret-pw@db/k").unwrap();
        let mut e = env(&[("KALZIT_DATABASE_URL_FILE", bad.to_str().unwrap())]);
        database_url_from_file(&mut e, None).unwrap();
        let err = format!("{:#}", Config::from_sources("", e).unwrap_err());
        assert!(!err.contains("secret-pw"), "{err}");
    }

    #[test]
    fn defaults_listen_on_http_only() {
        let c = Config::from_sources("", env(&[])).unwrap();
        assert_eq!(c.http_addr().unwrap().port(), 3000);
        assert!(c.https_addr().is_none());
    }

    #[test]
    fn environment_wins_over_file() {
        let c = Config::from_sources(
            "[server]\nhttp_addr = \"127.0.0.1:4000\"\n",
            env(&[("KALZIT_SERVER_HTTP_ADDR", "127.0.0.1:5000"), ("KALZIT_SESSIONS_LIFETIME_HOURS", "12")]),
        )
        .unwrap();
        assert_eq!(c.server.http_addr, "127.0.0.1:5000");
        assert_eq!(c.sessions.lifetime_hours, 12);
    }

    #[test]
    fn environment_reads_lists_and_bools() {
        let c = Config::from_sources(
            "",
            env(&[
                ("KALZIT_SECURITY_TRUSTED_PROXIES", "[\"10.0.0.0/8\", \"::1/128\"]"),
                ("KALZIT_SECURITY_HSTS", "false"),
            ]),
        )
        .unwrap();
        assert_eq!(c.security.trusted_proxies.len(), 2);
        assert!(!c.security.hsts);
    }

    #[test]
    fn file_keys_record_what_the_file_sets() {
        let c = Config::from_sources(
            "[sessions]\nlifetime_hours = 720\n",
            env(&[("KALZIT_SESSIONS_IDLE_TIMEOUT_HOURS", "3")]),
        )
        .unwrap();
        // The file names the default value; the environment is not the file.
        assert_eq!(c.file_keys.iter().collect::<Vec<_>>(), ["sessions.lifetime_hours"]);
        assert!(Config::from_sources("", env(&[])).unwrap().file_keys.is_empty());
    }

    #[test]
    fn runtime_setting_variables_pass_through() {
        for name in ["KALZIT_SETTING_AUDIT_RETENTION_DAYS", "KALZIT_setting_audit_retention_days"] {
            let c = Config::from_sources("", env(&[(name, "30")]));
            assert!(c.is_ok(), "{name}: {:?}", c.err());
        }
    }

    #[test]
    fn unrelated_environment_is_ignored() {
        assert!(Config::from_sources("", env(&[("KALZIT_CONFIG", "x"), ("PATH", "y")])).is_ok());
        // The secrets key and the test database URLs are read elsewhere, not settings.
        assert!(Config::from_sources("", env(&[("KALZIT_SECRETS_KEY", "x"), ("KALZIT_TEST_MYSQL_URL", "y")])).is_ok());
    }

    #[test]
    fn environment_values_take_the_setting_type() {
        let c = Config::from_sources(
            "",
            env(&[
                ("KALZIT_TLS_MIN_VERSION", "1.3"),
                ("KALZIT_PATHS_DATA_DIR", "2024"),
                ("KALZIT_SERVER_REDIRECT_HTTP_TO_HTTPS", "off"),
                ("KALZIT_SECURITY_TRUSTED_PROXIES", "10.0.0.0/8, 192.168.0.0/16"),
                ("KALZIT_SERVER_PUBLIC_URL", "https://kalzit.example.com"),
            ]),
        )
        .unwrap();
        assert_eq!(c.tls.min_version, "1.3");
        assert_eq!(c.paths.data_dir, PathBuf::from("2024"));
        assert!(!c.server.redirect_http_to_https);
        assert_eq!(c.security.trusted_proxies.len(), 2);
        assert_eq!(c.server.public_url.as_deref(), Some("https://kalzit.example.com"));
    }

    #[test]
    fn misspelled_variables_are_rejected() {
        for name in ["KALZIT_SERVR_HTTP_ADDR", "KALZIT_SERVER_HTTP_PORT"] {
            let err = Config::from_sources("", env(&[(name, "1")])).unwrap_err();
            assert!(format!("{err:#}").contains(name), "{err:#}");
        }
        let err = Config::from_sources("", env(&[("KALZIT_SESSIONS_LIFETIME_HOURS", "viele")])).unwrap_err();
        assert!(format!("{err:#}").contains("whole number"), "{err:#}");
    }

    #[test]
    fn empty_optional_variables_mean_unset() {
        let c = Config::from_sources(
            "[database]\nurl = \"postgres://db/x\"\n",
            env(&[("KALZIT_DATABASE_URL", ""), ("KALZIT_TLS_CERT_FILE", "  ")]),
        )
        .unwrap();
        assert!(c.database.url.is_none() && c.tls.cert_file.is_none());
    }

    #[test]
    fn out_of_range_values_are_rejected() {
        for toml in [
            "[security]\nlogin_max_failures = 0\n",
            "[security]\nlogin_window_secs = 0\n",
            "[security]\nsetup_max_failures = 0\n",
            "[security]\nsetup_window_secs = 0\n",
            "[database]\nmax_connections = 0\n",
            "[server]\npublic_url = \"https://\"\n",
            "[server]\npublic_url = \"https://x.example/sub\"\n",
            "[server]\npublic_url = \"https://user@x.example\"\n",
            "[server]\npublic_url = \"https://x.example:abc\"\n",
            "[server]\npublic_url = \"https://x.example?x=1\"\n",
            "[sessions]\nlifetime_hours = 9999999999\n",
            "[log]\nlevel = \"kalzit=nonsense[\"\n",
        ] {
            assert!(Config::from_sources(toml, env(&[])).is_err(), "{toml}");
        }
    }

    #[test]
    fn unknown_keys_are_rejected() {
        let err = Config::from_sources("[server]\nhttp_port = 3000\n", env(&[])).unwrap_err();
        assert!(format!("{err:#}").contains("http_port"), "{err:#}");
    }

    #[test]
    fn https_takes_both_certificate_files_or_none() {
        let half = "[server]\nhttps_addr = \"0.0.0.0:3443\"\n[tls]\ncert_file = \"cert.pem\"\n";
        let err = Config::from_sources(half, env(&[])).unwrap_err();
        assert!(format!("{err:#}").contains("tls.key_file"), "{err:#}");
        let err = Config::from_sources("[tls]\nkey_file = \"key.pem\"\n", env(&[])).unwrap_err();
        assert!(format!("{err:#}").contains("tls.cert_file"), "{err:#}");
        // Without files, ACME provides the certificate.
        let c = Config::from_sources("[server]\nhttps_addr = \"0.0.0.0:3443\"\n", env(&[])).unwrap();
        assert!(c.https_addr().is_some() && c.tls.cert_file.is_none());
    }

    #[test]
    fn no_listener_is_rejected() {
        assert!(Config::from_sources("[server]\nhttp_addr = \"\"\n", env(&[])).is_err());
    }

    #[test]
    fn sqlite_url_uses_forward_slashes() {
        let c = Config::from_sources("[paths]\ndata_dir = 'C:\\ProgramData\\Kalzit'\n", env(&[])).unwrap();
        assert_eq!(c.database_url(), "sqlite:C:/ProgramData/Kalzit/kalzit.db?mode=rwc");
        assert_eq!(sqlite_url(Path::new("/srv/a?b#c%d.db")), "sqlite:/srv/a%3Fb%23c%25d.db?mode=rwc");
    }

    #[cfg(windows)]
    #[test]
    fn default_data_dir_is_under_program_data() {
        assert_eq!(
            windows_data_dir(Some(r"C:\ProgramData".into())),
            Some(PathBuf::from(r"C:\ProgramData\Kalzit\data"))
        );
        assert_eq!(windows_data_dir(None), None);
        assert_eq!(windows_data_dir(Some("relative".into())), None);
        let c = Config::from_sources("", env(&[])).unwrap();
        assert!(c.paths.data_dir.ends_with(r"Kalzit\data"), "{}", c.paths.data_dir.display());
        assert!(c.database_url().ends_with("/Kalzit/data/kalzit.db?mode=rwc"), "{}", c.database_url());
    }

    #[cfg(not(windows))]
    #[test]
    fn default_data_dir_is_var_lib() {
        assert_eq!(default_data_dir(), Some(PathBuf::from("/var/lib/kalzit")));
        let c = Config::from_sources("", env(&[])).unwrap();
        assert_eq!(c.paths.data_dir, PathBuf::from("/var/lib/kalzit"));
        assert_eq!(c.database_url(), "sqlite:/var/lib/kalzit/kalzit.db?mode=rwc");
    }

    #[test]
    fn a_relative_data_dir_in_the_file_is_relative_to_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kalzit.toml");
        std::fs::write(&file, "[paths]\ndata_dir = \"store\"\n").unwrap();
        let c = Config::from_file(Some(&file), env(&[])).unwrap();
        assert_eq!(c.source("paths.data_dir"), Source::File);
        assert_eq!(c.paths.data_dir, dir.path().join("store"));
        assert!(c.warnings.is_empty());

        let absolute = dir.path().join("elsewhere");
        let toml = format!("[paths]\ndata_dir = '{}'\n", absolute.display());
        std::fs::write(&file, toml).unwrap();
        assert_eq!(Config::from_file(Some(&file), env(&[])).unwrap().paths.data_dir, absolute);
    }

    #[test]
    fn the_environment_overrides_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kalzit.toml");
        std::fs::write(&file, "[paths]\ndata_dir = \"store\"\n").unwrap();
        let absolute = dir.path().join("from-env");
        let c = Config::from_file(Some(&file), env(&[("KALZIT_PATHS_DATA_DIR", &absolute.to_string_lossy())])).unwrap();
        assert_eq!(c.source("paths.data_dir"), Source::Environment);
        assert_eq!(c.paths.data_dir, absolute);
        assert!(c.warnings.is_empty());

        // A relative path from the environment stays relative to the working directory, with a warning.
        let c = Config::from_file(Some(&file), env(&[("KALZIT_PATHS_DATA_DIR", "rel")])).unwrap();
        assert_eq!(c.paths.data_dir, std::env::current_dir().unwrap().join("rel"));
        assert_eq!(c.warnings.len(), 1);
        assert!(c.warnings[0].contains("working directory"), "{}", c.warnings[0]);

        let err = Config::from_sources("", env(&[("KALZIT_PATHS_DATA_DIR", " ")])).unwrap_err();
        assert!(format!("{err:#}").contains("paths.data_dir"), "{err:#}");
    }

    /// `KALZIT_CONFIG=conf/kalzit.toml`: paths in the file are relative to `conf`, not to the
    /// working directory.
    #[test]
    fn paths_in_a_relatively_named_file_are_relative_to_its_folder() {
        let dir = tempfile::Builder::new().prefix("config-test").tempdir_in(".").unwrap();
        let relative = PathBuf::from(dir.path().file_name().unwrap());
        let file = relative.join("kalzit.toml");
        std::fs::write(
            &file,
            "[paths]\ndata_dir = \"store\"\n[tls]\ncert_file = \"certs/cert.pem\"\nkey_file = \"certs/key.pem\"\n\
             [database]\nurl = \"sqlite:db/kalzit.db?mode=rwc\"\n",
        )
        .unwrap();
        let folder = std::path::absolute(&relative).unwrap();
        let c = Config::from_file(Some(&file), env(&[])).unwrap();
        assert_eq!(c.paths.data_dir, folder.join("store"));
        assert_eq!(c.tls.cert_file, Some(folder.join("certs/cert.pem")));
        assert_eq!(c.tls.key_file, Some(folder.join("certs/key.pem")));
        assert_eq!(c.database_url(), format!("sqlite:{}/db/kalzit.db?mode=rwc", sqlite_path(&folder)));

        // Values from the environment are not rebased onto the file's folder.
        let c = Config::from_file(
            Some(&file),
            env(&[("KALZIT_TLS_CERT_FILE", "env.pem"), ("KALZIT_DATABASE_URL", "sqlite:env.db")]),
        )
        .unwrap();
        assert_eq!(c.tls.cert_file, Some(PathBuf::from("env.pem")));
        assert_eq!(c.database_url(), "sqlite:env.db");
    }

    #[test]
    fn a_database_url_without_scheme_slashes_is_refused_without_echo() {
        for url in [
            "postgres:/u:secret@db/k",
            "postgres:u:secret@db/k",
            "mysql:/u:secret@h:3306/db",
            "postgres:x://u:secret@db",
        ] {
            let err = Config::from_sources("", env(&[("KALZIT_DATABASE_URL", url)])).unwrap_err();
            let text = format!("{err:#}");
            assert!(text.contains("postgres://user:pass@host/db"), "{text}");
            assert!(!text.contains("secret"), "the value is echoed: {text}");
            let toml = format!("[database]\nurl = \"{url}\"\n");
            let text = format!("{:#}", Config::from_sources(&toml, env(&[])).unwrap_err());
            assert!(!text.contains("secret"), "the value is echoed: {text}");
        }
        for url in ["postgres://u:p@db/k", "postgresql://h/db", "sqlite:data/k.db", "sqlite::memory:"] {
            assert!(Config::from_sources("", env(&[("KALZIT_DATABASE_URL", url)])).is_ok(), "{url}");
        }
    }

    #[test]
    fn only_sqlite_and_postgres_hold_kalzits_own_data() {
        for url in ["mysql://u:secret@h/db", "mariadb://u:secret@h/db", "mssql://u:secret@h/db", "redis://:secret@h"] {
            for (toml, vars) in [
                (format!("[database]\nurl = \"{url}\"\n"), env(&[])),
                (String::new(), env(&[("KALZIT_DATABASE_URL", url)])),
            ] {
                let text = format!("{:#}", Config::from_sources(&toml, vars).unwrap_err());
                assert!(text.contains("Kalzit's own database must be SQLite or PostgreSQL"), "{text}");
                assert!(!text.contains("secret"), "the value is echoed: {text}");
            }
        }
        for url in ["postgres://h/db", "PostgreSQL://h/db", "sqlite:k.db"] {
            assert!(Config::from_sources("", env(&[("KALZIT_DATABASE_URL", url)])).is_ok(), "{url}");
        }
    }

    #[test]
    fn only_relative_sqlite_urls_are_rebased() {
        let base = Path::new("/etc/kalzit");
        assert_eq!(resolve_sqlite_url("sqlite:k.db", base).as_deref(), Some("sqlite:/etc/kalzit/k.db"));
        assert_eq!(
            resolve_sqlite_url("sqlite://k.db?mode=rwc", base).as_deref(),
            Some("sqlite:/etc/kalzit/k.db?mode=rwc")
        );
        for url in ["sqlite::memory:", "sqlite:/var/k.db", "sqlite:", "postgres://h/db", "postgresql://h/db"] {
            assert_eq!(resolve_sqlite_url(url, base), None, "{url}");
        }
    }
}
