//! Server configuration: defaults, then `granit.toml`, then `GRANIT_<SECTION>_<KEY>` environment
//! variables. Network and TLS settings are only configurable here, never in the UI, so a wrong
//! value cannot lock the admin out of the settings page.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use ipnet::IpNet;
use serde::Deserialize;

const ENV_PREFIX: &str = "GRANIT_";
const SECTIONS: &[&str] = &["server", "tls", "security", "sessions", "database", "paths", "log"];

#[derive(Debug, Clone, Default, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Plain HTTP listener. Empty string disables it.
    pub http_addr: String,
    /// HTTPS listener; needs `tls.cert_file` and `tls.key_file`. Empty string disables it.
    pub https_addr: String,
    /// The URL users open, e.g. `https://granit.example.com`. Used for the origin check and links.
    pub public_url: Option<String>,
    /// When HTTPS is on, answer plain HTTP with a redirect (health endpoints stay reachable).
    pub redirect_http_to_https: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TlsConfig {
    pub cert_file: Option<PathBuf>,
    pub key_file: Option<PathBuf>,
    /// "1.2" or "1.3".
    pub min_version: String,
    /// How often the certificate files are checked for changes, in seconds (0 = never).
    pub reload_interval_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SecurityConfig {
    pub hsts: bool,
    pub hsts_max_age_secs: u64,
    /// Reverse proxies whose `X-Forwarded-*` headers are trusted. Everyone else's are ignored.
    pub trusted_proxies: Vec<IpNet>,
    pub login_max_failures: u32,
    pub login_window_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SessionConfig {
    pub lifetime_hours: u64,
    pub idle_timeout_hours: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DatabaseConfig {
    /// `sqlite://...` or `postgres://...`. Default: SQLite file in the data directory.
    pub url: Option<String>,
    pub max_connections: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PathsConfig {
    pub data_dir: PathBuf,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LogConfig {
    /// A tracing filter, e.g. "info" or "granit=debug,info".
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
        Self::from_sources(&text, std::env::vars()).with_context(|| match &file {
            Some(p) => format!("in configuration {} or GRANIT_* variables", p.display()),
            None => "in GRANIT_* variables".into(),
        })
    }

    /// Merges a TOML document with `GRANIT_<SECTION>_<KEY>` variables and validates the result.
    pub fn from_sources(toml_text: &str, env: impl IntoIterator<Item = (String, String)>) -> Result<Self> {
        let mut doc: toml::Table = toml::from_str(toml_text).context("parsing TOML")?;
        for (name, raw) in env {
            let Some(rest) = name.strip_prefix(ENV_PREFIX) else { continue };
            let rest = rest.to_ascii_lowercase();
            let Some(section) = SECTIONS.iter().find(|s| rest.starts_with(&format!("{s}_"))) else {
                continue;
            };
            let key = &rest[section.len() + 1..];
            let table = doc.entry(section.to_string()).or_insert_with(|| toml::Value::Table(toml::Table::new()));
            let toml::Value::Table(table) = table else { bail!("[{section}] is not a table") };
            table.insert(key.to_string(), env_value(&raw));
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
        if let Some(url) = &self.server.public_url
            && !(url.starts_with("http://") || url.starts_with("https://"))
        {
            bail!("server.public_url must start with http:// or https://");
        }
        if self.sessions.lifetime_hours == 0 {
            bail!("sessions.lifetime_hours must be at least 1");
        }
        Ok(())
    }

    pub fn http_addr(&self) -> Option<SocketAddr> {
        self.server.http_addr.parse().ok()
    }

    pub fn https_addr(&self) -> Option<SocketAddr> {
        self.server.https_addr.parse().ok()
    }

    /// The database URL, defaulting to `granit.db` in the data directory.
    pub fn database_url(&self) -> String {
        match &self.database.url {
            Some(url) => url.clone(),
            None => sqlite_url(&self.paths.data_dir.join("granit.db")),
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

/// Reads an environment value as a TOML literal (number, bool, array) and falls back to a string.
fn env_value(raw: &str) -> toml::Value {
    match toml::from_str::<toml::Table>(&format!("v = {raw}")) {
        Ok(mut t) => t.remove("v").unwrap_or_else(|| toml::Value::String(raw.into())),
        Err(_) => toml::Value::String(raw.into()),
    }
}

fn default_config_paths() -> Vec<PathBuf> {
    let mut paths = vec![PathBuf::from("granit.toml")];
    #[cfg(windows)]
    if let Some(program_data) = std::env::var_os("ProgramData") {
        paths.push(PathBuf::from(program_data).join("Granit").join("granit.toml"));
    }
    #[cfg(unix)]
    paths.push(PathBuf::from("/etc/granit/granit.toml"));
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
            env(&[("GRANIT_SERVER_HTTP_ADDR", "127.0.0.1:5000"), ("GRANIT_SESSIONS_LIFETIME_HOURS", "12")]),
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
                ("GRANIT_SECURITY_TRUSTED_PROXIES", "[\"10.0.0.0/8\", \"::1/128\"]"),
                ("GRANIT_SECURITY_HSTS", "false"),
            ]),
        )
        .unwrap();
        assert_eq!(c.security.trusted_proxies.len(), 2);
        assert!(!c.security.hsts);
    }

    #[test]
    fn unrelated_environment_is_ignored() {
        assert!(Config::from_sources("", env(&[("GRANIT_CONFIG", "x"), ("PATH", "y")])).is_ok());
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
        let c = Config::from_sources("[paths]\ndata_dir = 'C:\\ProgramData\\Granit'\n", env(&[])).unwrap();
        assert_eq!(c.database_url(), "sqlite:C:/ProgramData/Granit/granit.db?mode=rwc");
        assert_eq!(sqlite_url(Path::new("/srv/a?b#c%d.db")), "sqlite:/srv/a%3Fb%23c%25d.db?mode=rwc");
    }
}
