//! Server configuration: defaults, then `kalzit.toml`, then `KALZIT_<SECTION>_<KEY>` environment
//! variables. Network and TLS settings are only configurable here, never in the UI, so a wrong
//! value cannot lock the admin out of the settings page.

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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Plain HTTP listener. Empty string disables it.
    pub http_addr: String,
    /// HTTPS listener; needs `tls.cert_file` and `tls.key_file`. Empty string disables it.
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
    /// Failed sign-ins per email and per client address before further attempts are refused.
    pub login_max_failures: u32,
    /// The window in which failures are counted, in seconds.
    pub login_window_secs: u64,
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
        Self { data_dir: PathBuf::from("data") }
    }
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
        let text = match &file {
            Some(p) => {
                std::fs::read_to_string(p).with_context(|| format!("reading configuration from {}", p.display()))?
            }
            None => String::new(),
        };
        let mut env = Vec::new();
        for (name, value) in std::env::vars_os() {
            let Some(name) = name.to_str().filter(|n| n.starts_with(ENV_PREFIX)) else { continue };
            let value = value.into_string().map_err(|_| anyhow::anyhow!("{name} is not valid UTF-8"))?;
            env.push((name.to_string(), value));
        }
        Self::from_sources(&text, env).with_context(|| match &file {
            Some(p) => format!("in configuration {} or KALZIT_* variables", p.display()),
            None => "in KALZIT_* variables".into(),
        })
    }

    /// Merges a TOML document with `KALZIT_<SECTION>_<KEY>` variables and validates the result.
    pub fn from_sources(toml_text: &str, env: impl IntoIterator<Item = (String, String)>) -> Result<Self> {
        let mut doc: toml::Table = toml::from_str(toml_text).context("parsing TOML")?;
        let defaults = toml::Table::try_from(Config::default()).context("serializing the defaults")?;
        for (name, raw) in env {
            let Some(rest) = name.strip_prefix(ENV_PREFIX) else { continue };
            if OTHER_VARIABLES.contains(&rest) {
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
            if default.is_none() && raw.trim().is_empty() {
                table.remove(key);
                continue;
            }
            let value = env_value(&name, &raw, default, key)?;
            table.insert(key.to_string(), value);
        }
        let config: Config = toml::Value::Table(doc).try_into().context("reading settings")?;
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
        if !self.server.https_addr.is_empty() && (self.tls.cert_file.is_none() || self.tls.key_file.is_none()) {
            bail!("server.https_addr is set, so tls.cert_file and tls.key_file are required");
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
        if self.database.max_connections == 0 {
            bail!("database.max_connections must be at least 1");
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
    let path = path.to_string_lossy().replace('\\', "/").replace('%', "%25").replace('?', "%3F").replace('#', "%23");
    format!("sqlite:{path}?mode=rwc")
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

fn default_config_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("kalzit.toml")];
    #[cfg(windows)]
    if let Some(program_data) = std::env::var_os("ProgramData") {
        paths.push(PathBuf::from(program_data).join("Kalzit").join("kalzit.toml"));
    }
    #[cfg(unix)]
    paths.push(PathBuf::from("/etc/kalzit/kalzit.toml"));
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
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
    fn https_needs_certificate() {
        let err = Config::from_sources("[server]\nhttps_addr = \"0.0.0.0:3443\"\n", env(&[])).unwrap_err();
        assert!(format!("{err:#}").contains("tls.cert_file"), "{err:#}");
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
}
