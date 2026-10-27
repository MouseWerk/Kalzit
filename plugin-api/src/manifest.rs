//! The plugin manifest: `kalzit-plugin.toml` at the root of every plugin package (TOML, like
//! `kalzit.toml`). It says what the plugin is, what it delivers, what it may reach and which
//! binaries it ships with their SHA-256; the plugin signature covers its exact bytes
//! (`signing::manifest_message`). docs/ARCHITECTURE.md ("Plugins") shows a full example.
//!
//! `parse` reads and validates a manifest and reports every problem at once, each with the path
//! of the value at fault and a stable code.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};

/// The file name of the manifest in a plugin package.
pub const MANIFEST_FILE: &str = "kalzit-plugin.toml";

/// The manifest format this crate reads (`manifest = 1`).
pub const MANIFEST_VERSION: u32 = 1;

/// Largest manifest accepted.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// The platforms a plugin can ship binaries for.
pub const PLATFORMS: &[&str] = &["windows-x64", "linux-x64", "linux-arm64"];

/// The shapes a plugin can deliver (data source) or show (panel).
pub const SHAPES: &[&str] = &["frame", "documents", "graph"];

/// The optional parts of the data source protocol, version 1 (`Capability` in the proto).
pub const CAPABILITIES: &[&str] = &["check_on_save", "watch"];

/// The versions of the panel message API (data in, events out) this crate knows.
pub const PANEL_API_VERSIONS: &[u32] = &[1];

/// The settings field types of a data source form.
pub const SETTING_TYPES: &[&str] = &["string", "text", "number", "bool", "select"];

/// Fields every data source has; a plugin cannot declare them again.
pub const COMMON_SETTINGS: &[&str] = &["queryTimeoutSecs", "maxRows"];

/// Languages a label may carry; `en` is required, as the fallback.
pub const LANGUAGES: &[&str] = &["en", "de"];

const MAX_SETTINGS: usize = 64;
const MAX_OPTIONS: usize = 256;
const MAX_NETWORK_TARGETS: usize = 32;
const MAX_NAME_CHARS: usize = 64;
const MAX_TEXT_CHARS: usize = 500;
const MAX_PATH_CHARS: usize = 255;

/// A plugin manifest as written. `parse` returns it only when it is valid.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// The manifest format, `1`.
    pub manifest: u32,
    /// Reverse domain name, lowercase, at least one dot (`dev.example.redis`). It is the kind of
    /// the data sources the plugin serves, so it can never clash with a built-in kind.
    pub id: String,
    pub name: String,
    /// Semantic version of the plugin.
    pub version: String,
    /// `datasource` or `panel`.
    pub kind: String,
    /// The oldest Kalzit version the plugin runs with.
    pub min_kalzit: String,
    /// What it delivers (data source) or shows (panel).
    pub shapes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    /// SPDX expression.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Data sources: the protocol version the plugin speaks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<u32>,
    /// Data sources: the optional protocol parts it implements.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    /// Data sources: the settings form.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<Setting>,
    #[serde(default)]
    pub permissions: Permissions,
    /// Data sources: one binary per platform (`windows-x64`, `linux-x64`, `linux-arm64`).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub binaries: BTreeMap<String, PackageFile>,
    /// Panels: the web bundle the browser loads into a sandboxed iframe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<WebBundle>,
}

/// One field of a data source's settings form.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Setting {
    pub name: String,
    /// The label by language; `en` is required.
    pub label: BTreeMap<String, String>,
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub required: bool,
    /// Sent in the secrets, never stored in plain settings and never returned.
    #[serde(default)]
    pub secret: bool,
    /// Decides where secrets are sent (host, port, URL, user); changing it requires sending the
    /// secrets again.
    #[serde(default)]
    pub target: bool,
    /// The choices of a `select`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<toml::Value>,
    /// Help text by language.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    /// Where the plugin may connect, through Kalzit. Nothing else is reachable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub network: Vec<NetworkTarget>,
}

/// One network target: the host (or URL) a settings field holds, or a fixed host and port.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkTarget {
    /// A `target` settings field holding a host name, address or URL. The data source's own
    /// target rules apply to it like to a built-in source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
    /// A `target` number field with the port, for a `setting` that holds a host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_setting: Option<String>,
    /// The port when the settings give none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_port: Option<u16>,
    /// A fixed host name or address (no wildcards).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The port of a fixed `host`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// A file in the plugin package, pinned by its SHA-256.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageFile {
    /// Relative to the package root, with `/` between parts.
    pub path: String,
    /// Lowercase hex.
    pub sha256: String,
}

/// A panel's web bundle: one ES module with everything it needs inlined, run in a sandboxed
/// iframe that talks to Kalzit only through the versioned panel message API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebBundle {
    /// The bundle's `.js` or `.mjs` file, relative to the package root.
    pub path: String,
    pub sha256: String,
    /// The panel message API version the bundle speaks.
    pub api: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginKind {
    DataSource,
    Panel,
}

/// One problem in a manifest: where (`settings[1].options`), a stable code and an English text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

impl fmt::Display for Issue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() { write!(f, "{}", self.message) } else { write!(f, "{}: {}", self.path, self.message) }
    }
}

/// Every problem `parse` found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid(pub Vec<Issue>);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let lines: Vec<String> = self.0.iter().map(Issue::to_string).collect();
        write!(f, "the plugin manifest is not valid: {}", lines.join("; "))
    }
}

impl std::error::Error for Invalid {}

impl Invalid {
    /// The codes, for tests and logs.
    pub fn codes(&self) -> Vec<&'static str> {
        self.0.iter().map(|i| i.code).collect()
    }
}

/// Reads and validates a manifest.
pub fn parse(text: &str) -> Result<Manifest, Invalid> {
    if text.len() > MAX_MANIFEST_BYTES {
        return Err(Invalid(vec![issue("", "manifest.too_large", format!("larger than {MAX_MANIFEST_BYTES} bytes"))]));
    }
    let manifest: Manifest =
        toml::from_str(text).map_err(|e| Invalid(vec![issue("", "manifest.syntax", e.message().to_string())]))?;
    manifest.validate()?;
    Ok(manifest)
}

impl Manifest {
    /// Checks every rule of the format; `parse` calls it.
    pub fn validate(&self) -> Result<(), Invalid> {
        let mut v = Validator::default();
        v.check(self);
        if v.issues.is_empty() { Ok(()) } else { Err(Invalid(v.issues)) }
    }

    /// The kind; only meaningful on a valid manifest.
    pub fn plugin_kind(&self) -> PluginKind {
        if self.kind == "panel" { PluginKind::Panel } else { PluginKind::DataSource }
    }

    /// The network targets of `self` (an update) that `installed` did not have. An update with
    /// any needs an administrator's approval again before it runs.
    pub fn added_permissions<'a>(&'a self, installed: &Manifest) -> Vec<&'a NetworkTarget> {
        self.permissions.network.iter().filter(|t| !installed.permissions.network.contains(t)).collect()
    }

    /// Whether this Kalzit version may run the plugin (`min_kalzit`).
    pub fn runs_on(&self, kalzit_version: &str) -> Result<(), Issue> {
        let (Ok(min), Ok(host)) = (semver::Version::parse(&self.min_kalzit), semver::Version::parse(kalzit_version))
        else {
            return Err(issue("min_kalzit", "manifest.version_invalid", "not a semantic version"));
        };
        // Semantic version order: a pre-release of the minimum (0.4.0-rc.1) is older than it.
        if host < min {
            return Err(issue(
                "min_kalzit",
                "manifest.kalzit_too_old",
                format!("the plugin needs Kalzit {min} or later, this is {host}"),
            ));
        }
        Ok(())
    }
}

fn issue(path: impl Into<String>, code: &'static str, message: impl Into<String>) -> Issue {
    Issue { path: path.into(), code, message: message.into() }
}

#[derive(Default)]
struct Validator {
    issues: Vec<Issue>,
}

impl Validator {
    fn push(&mut self, path: impl Into<String>, code: &'static str, message: impl Into<String>) {
        self.issues.push(issue(path, code, message));
    }

    fn check(&mut self, m: &Manifest) {
        if m.manifest != MANIFEST_VERSION {
            self.push("manifest", "manifest.format_unsupported", format!("format {} is not supported", m.manifest));
        }
        if !valid_id(&m.id) {
            self.push(
                "id",
                "manifest.id_invalid",
                "use a lowercase reverse domain name with at least one dot, such as dev.example.redis",
            );
        }
        self.text("name", &m.name, MAX_NAME_CHARS, true);
        for (path, version) in [("version", &m.version), ("min_kalzit", &m.min_kalzit)] {
            if semver::Version::parse(version).is_err() {
                self.push(path, "manifest.version_invalid", format!("{version:?} is not a semantic version"));
            }
        }
        if let Some(d) = &m.description {
            self.text("description", d, MAX_TEXT_CHARS, true);
        }
        if let Some(p) = &m.publisher {
            self.text("publisher", p, MAX_NAME_CHARS, true);
        }
        if let Some(l) = &m.license {
            self.text("license", l, MAX_NAME_CHARS, true);
        }
        self.names("shapes", &m.shapes, SHAPES, true);

        let kind = match m.kind.as_str() {
            "datasource" => Some(PluginKind::DataSource),
            "panel" => Some(PluginKind::Panel),
            other => {
                self.push("kind", "manifest.kind_unknown", format!("{other:?} is not datasource or panel"));
                None
            }
        };
        match kind {
            Some(PluginKind::DataSource) => self.datasource(m),
            Some(PluginKind::Panel) => self.panel(m),
            None => {}
        }
    }

    fn datasource(&mut self, m: &Manifest) {
        match m.protocol {
            None => self.push("protocol", "manifest.protocol_missing", "a data source names its protocol version"),
            Some(p) if !crate::SUPPORTED_PROTOCOL_VERSIONS.contains(&p) => {
                self.push("protocol", "manifest.protocol_unsupported", format!("protocol {p} is not supported"))
            }
            Some(_) => {}
        }
        self.names("capabilities", &m.capabilities, CAPABILITIES, false);
        if m.panel.is_some() {
            self.push("panel", "manifest.not_for_kind", "only panels have a panel entry");
        }
        if m.binaries.is_empty() {
            self.push(
                "binaries",
                "manifest.binaries_missing",
                "a data source ships a binary for at least one platform",
            );
        }
        for (platform, file) in &m.binaries {
            let path = format!("binaries.{platform}");
            if !PLATFORMS.contains(&platform.as_str()) {
                self.push(&path, "manifest.platform_unknown", format!("use one of {}", PLATFORMS.join(", ")));
            }
            self.file(&path, file);
            if platform.starts_with("windows") && !file.path.to_ascii_lowercase().ends_with(".exe") {
                self.push(format!("{path}.path"), "manifest.binary_not_exe", "a Windows binary ends with .exe");
            }
        }
        self.settings(&m.settings);
        self.network(&m.permissions.network, &m.settings);
    }

    fn panel(&mut self, m: &Manifest) {
        match &m.panel {
            Some(bundle) => {
                self.file("panel", &PackageFile { path: bundle.path.clone(), sha256: bundle.sha256.clone() });
                if !(bundle.path.ends_with(".js") || bundle.path.ends_with(".mjs")) {
                    self.push("panel.path", "manifest.panel_not_module", "the panel bundle is a .js or .mjs file");
                }
                if !PANEL_API_VERSIONS.contains(&bundle.api) {
                    self.push(
                        "panel.api",
                        "manifest.panel_api_unsupported",
                        format!("panel API {} is not supported", bundle.api),
                    );
                }
            }
            None => self.push("panel", "manifest.panel_missing", "a panel names its web bundle"),
        }
        for (path, present) in [
            ("protocol", m.protocol.is_some()),
            ("capabilities", !m.capabilities.is_empty()),
            ("settings", !m.settings.is_empty()),
            ("binaries", !m.binaries.is_empty()),
            ("permissions.network", !m.permissions.network.is_empty()),
        ] {
            if present {
                self.push(path, "manifest.not_for_kind", "only data sources have this");
            }
        }
    }

    fn text(&mut self, path: &str, value: &str, max: usize, required: bool) {
        if required && value.trim().is_empty() {
            self.push(path, "manifest.text_empty", "must not be empty");
        } else if value.chars().count() > max {
            self.push(path, "manifest.text_too_long", format!("at most {max} characters"));
        } else if value.chars().any(char::is_control) {
            self.push(path, "manifest.text_control", "must not contain control characters");
        }
    }

    /// A list of names from `known`, without repeats; `required` when it may not be empty.
    fn names(&mut self, path: &str, values: &[String], known: &[&str], required: bool) {
        if required && values.is_empty() {
            self.push(path, "manifest.list_empty", format!("name at least one of {}", known.join(", ")));
        }
        let mut seen = BTreeSet::new();
        for (i, value) in values.iter().enumerate() {
            if !known.contains(&value.as_str()) {
                self.push(format!("{path}[{i}]"), "manifest.name_unknown", format!("use one of {}", known.join(", ")));
            } else if !seen.insert(value) {
                self.push(format!("{path}[{i}]"), "manifest.name_repeated", format!("{value} is listed twice"));
            }
        }
    }

    fn file(&mut self, path: &str, file: &PackageFile) {
        if !valid_package_path(&file.path) {
            self.push(
                format!("{path}.path"),
                "manifest.path_invalid",
                "use a relative path inside the package with / between parts",
            );
        }
        if !(file.sha256.len() == 64 && file.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
            self.push(format!("{path}.sha256"), "manifest.sha256_invalid", "64 lowercase hex digits");
        }
    }

    fn settings(&mut self, settings: &[Setting]) {
        if settings.len() > MAX_SETTINGS {
            self.push("settings", "manifest.too_many", format!("at most {MAX_SETTINGS} fields"));
        }
        let mut names = BTreeSet::new();
        for (i, s) in settings.iter().enumerate() {
            let path = format!("settings[{i}]");
            if !valid_setting_name(&s.name) {
                self.push(
                    format!("{path}.name"),
                    "manifest.setting_name_invalid",
                    "a letter, then letters, digits or _ (at most 64)",
                );
            } else if COMMON_SETTINGS.contains(&s.name.as_str()) {
                self.push(format!("{path}.name"), "manifest.setting_reserved", format!("{} is a common field", s.name));
            } else if !names.insert(s.name.as_str()) {
                self.push(format!("{path}.name"), "manifest.setting_repeated", format!("{} is declared twice", s.name));
            }
            self.labels(&format!("{path}.label"), &s.label, MAX_NAME_CHARS);
            if let Some(help) = &s.help {
                self.labels(&format!("{path}.help"), help, MAX_TEXT_CHARS);
            }
            let ty = s.field_type.as_str();
            if !SETTING_TYPES.contains(&ty) {
                self.push(
                    format!("{path}.type"),
                    "manifest.name_unknown",
                    format!("use one of {}", SETTING_TYPES.join(", ")),
                );
                continue;
            }
            if s.secret {
                if !matches!(ty, "string" | "text") {
                    self.push(format!("{path}.secret"), "manifest.secret_type", "a secret is a string or text field");
                }
                if s.target {
                    self.push(format!("{path}.target"), "manifest.secret_target", "a secret cannot be a target field");
                }
                if s.default.is_some() {
                    self.push(format!("{path}.default"), "manifest.secret_default", "a secret has no default");
                }
            }
            if ty == "select" {
                let unique: BTreeSet<&String> = s.options.iter().collect();
                if s.options.is_empty() || s.options.len() > MAX_OPTIONS || unique.len() != s.options.len() {
                    self.push(
                        format!("{path}.options"),
                        "manifest.options_invalid",
                        format!("a select has 1 to {MAX_OPTIONS} distinct options"),
                    );
                }
            } else if !s.options.is_empty() {
                self.push(format!("{path}.options"), "manifest.not_for_type", "only a select has options");
            }
            if let Some(default) = &s.default {
                let fits = match (ty, default) {
                    ("string" | "text", toml::Value::String(_)) => true,
                    ("number", toml::Value::Integer(n)) => *n >= 0,
                    ("bool", toml::Value::Boolean(_)) => true,
                    ("select", toml::Value::String(v)) => s.options.contains(v),
                    _ => false,
                };
                if !fits {
                    self.push(format!("{path}.default"), "manifest.default_type", "the default does not fit the type");
                }
            }
        }
    }

    fn labels(&mut self, path: &str, labels: &BTreeMap<String, String>, max: usize) {
        if !labels.contains_key("en") {
            self.push(path, "manifest.label_english", "an English text (en) is required");
        }
        for (lang, text) in labels {
            if !LANGUAGES.contains(&lang.as_str()) {
                self.push(
                    format!("{path}.{lang}"),
                    "manifest.language_unknown",
                    format!("use {}", LANGUAGES.join(" or ")),
                );
            }
            self.text(&format!("{path}.{lang}"), text, max, true);
        }
    }

    fn network(&mut self, targets: &[NetworkTarget], settings: &[Setting]) {
        if targets.len() > MAX_NETWORK_TARGETS {
            self.push("permissions.network", "manifest.too_many", format!("at most {MAX_NETWORK_TARGETS} targets"));
        }
        let field = |name: &str| settings.iter().find(|s| s.name == name);
        for (i, t) in targets.iter().enumerate() {
            let path = format!("permissions.network[{i}]");
            match (&t.setting, &t.host) {
                (Some(name), None) => {
                    match field(name) {
                        Some(s) if s.target && !s.secret && matches!(s.field_type.as_str(), "string" | "text") => {}
                        _ => self.push(
                            format!("{path}.setting"),
                            "manifest.target_setting",
                            format!("{name} is not a string settings field marked target"),
                        ),
                    }
                    if let Some(port) = &t.port_setting
                        && !field(port).is_some_and(|s| s.target && s.field_type == "number")
                    {
                        self.push(
                            format!("{path}.port_setting"),
                            "manifest.target_setting",
                            format!("{port} is not a number settings field marked target"),
                        );
                    }
                    if t.port.is_some() {
                        self.push(format!("{path}.port"), "manifest.not_for_target", "use default_port with a setting");
                    }
                    if t.default_port == Some(0) {
                        self.push(format!("{path}.default_port"), "manifest.port_invalid", "a port is 1 to 65535");
                    }
                }
                (None, Some(host)) => {
                    if !valid_host(host) {
                        self.push(
                            format!("{path}.host"),
                            "manifest.host_invalid",
                            "a host name or address without wildcards, scheme or port",
                        );
                    }
                    match t.port {
                        None | Some(0) => self.push(
                            format!("{path}.port"),
                            "manifest.port_invalid",
                            "a fixed host needs a port, 1 to 65535",
                        ),
                        Some(_) => {}
                    }
                    if t.port_setting.is_some() || t.default_port.is_some() {
                        self.push(path.clone(), "manifest.not_for_target", "a fixed host has only host and port");
                    }
                }
                _ => self.push(path, "manifest.target_form", "give either setting or host"),
            }
        }
    }
}

fn valid_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    (3..=64).contains(&id.len())
        && parts.len() >= 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && !p.starts_with('-')
                && !p.ends_with('-')
                && p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
        && parts[0].as_bytes()[0].is_ascii_lowercase()
}

fn valid_setting_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 64
        && bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_package_path(path: &str) -> bool {
    !path.is_empty()
        && path.chars().count() <= MAX_PATH_CHARS
        && !path.starts_with('/')
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path.split('/').all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_host(host: &str) -> bool {
    if host.parse::<std::net::IpAddr>().is_ok() {
        return true;
    }
    host.len() <= 253
        && host.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708";

    fn datasource() -> String {
        format!(
            r#"
manifest = 1
id = "dev.example.redis"
name = "Redis"
version = "1.2.0"
kind = "datasource"
min_kalzit = "0.4.0"
shapes = ["frame", "documents"]
description = "Keys and streams from Redis"
publisher = "Example"
license = "MIT"
protocol = 1
capabilities = ["watch"]

[[settings]]
name = "host"
label = {{ en = "Host", de = "Host" }}
type = "string"
required = true
target = true

[[settings]]
name = "port"
label = {{ en = "Port" }}
type = "number"
target = true
default = 6379

[[settings]]
name = "password"
label = {{ en = "Password", de = "Passwort" }}
type = "string"
secret = true

[[settings]]
name = "mode"
label = {{ en = "Mode" }}
type = "select"
options = ["standalone", "cluster"]
default = "standalone"

[[permissions.network]]
setting = "host"
port_setting = "port"
default_port = 6379

[[permissions.network]]
host = "license.example.dev"
port = 443

[binaries.windows-x64]
path = "bin/windows-x64/redis-plugin.exe"
sha256 = "{HASH}"

[binaries.linux-x64]
path = "bin/linux-x64/redis-plugin"
sha256 = "{HASH}"

[binaries.linux-arm64]
path = "bin/linux-arm64/redis-plugin"
sha256 = "{HASH}"
"#
        )
    }

    fn codes(text: &str) -> Vec<&'static str> {
        parse(text).expect_err("the manifest is invalid").codes()
    }

    #[test]
    fn a_complete_data_source_manifest_is_valid() {
        let m = parse(&datasource()).expect("valid");
        assert_eq!(m.plugin_kind(), PluginKind::DataSource);
        assert_eq!(m.binaries.len(), 3);
        assert_eq!(m.permissions.network.len(), 2);
        assert_eq!(m.settings[1].default, Some(toml::Value::Integer(6379)));
    }

    #[test]
    fn a_panel_manifest_is_valid() {
        let text = format!(
            r#"
manifest = 1
id = "dev.example.sankey"
name = "Sankey"
version = "0.1.0"
kind = "panel"
min_kalzit = "0.4.0"
shapes = ["graph", "frame"]

[panel]
path = "dist/panel.js"
sha256 = "{HASH}"
api = 1
"#
        );
        assert_eq!(parse(&text).expect("valid").plugin_kind(), PluginKind::Panel);
        let html = text.replacen("dist/panel.js", "dist/index.html", 1).replacen("api = 1", "api = 9", 1);
        assert_eq!(codes(&html), ["manifest.panel_not_module", "manifest.panel_api_unsupported"]);
        let binary = format!(
            "{text}
[binaries.linux-x64]
path = \"bin/x\"
sha256 = \"{HASH}\"
"
        );
        assert_eq!(codes(&binary), ["manifest.not_for_kind"]);
    }

    #[test]
    fn syntax_errors_and_unknown_keys_are_refused() {
        assert_eq!(codes("manifest = "), ["manifest.syntax"]);
        assert_eq!(
            codes(&format!("{}\nentry = \"x\"\n", datasource().replacen("manifest = 1", "", 1))),
            ["manifest.syntax"]
        );
        let unknown = datasource().replacen("protocol = 1", "protocol = 1\nnetwork = true", 1);
        assert_eq!(codes(&unknown), ["manifest.syntax"]);
    }

    #[test]
    fn every_problem_is_reported_at_once() {
        let text = datasource()
            .replacen("manifest = 1", "manifest = 2", 1)
            .replacen("dev.example.redis", "Redis", 1)
            .replacen("version = \"1.2.0\"", "version = \"1.2\"", 1)
            .replacen("shapes = [\"frame\", \"documents\"]", "shapes = [\"frame\", \"table\", \"frame\"]", 1)
            .replacen("capabilities = [\"watch\"]", "capabilities = [\"pushdown\"]", 1);
        assert_eq!(
            codes(&text),
            [
                "manifest.format_unsupported",
                "manifest.id_invalid",
                "manifest.version_invalid",
                "manifest.name_unknown",
                "manifest.name_repeated",
                "manifest.name_unknown",
            ]
        );
    }

    #[test]
    fn ids_are_lowercase_reverse_domain_names() {
        for good in ["dev.example.redis", "io.kalzit.sample-csv", "a.b1"] {
            assert!(valid_id(good), "{good}");
        }
        // No dot (a built-in kind such as postgres), uppercase, empty parts, leading digits.
        for bad in ["postgres", "Dev.example", "dev..x", ".dev.x", "dev.x.", "1dev.x", "dev.-x", "dev.x_y", "d.x/y"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn binaries_are_pinned_relative_files_for_known_platforms() {
        let text = datasource()
            .replacen("bin/windows-x64/redis-plugin.exe", "bin/windows-x64/redis-plugin", 1)
            .replacen("bin/linux-x64/redis-plugin", "../redis-plugin", 1)
            .replacen("[binaries.linux-arm64]", "[binaries.macos-arm64]", 1)
            .replacen(&format!("sha256 = \"{HASH}\""), "sha256 = \"ABC\"", 1);
        assert_eq!(
            codes(&text),
            [
                "manifest.path_invalid",
                "manifest.platform_unknown",
                "manifest.sha256_invalid",
                "manifest.binary_not_exe",
            ]
        );
        for bad in ["/abs", "C:/x.exe", "bin\\x.exe", "bin//x", "./x", "bin/../x", ""] {
            assert!(!valid_package_path(bad), "{bad}");
        }
        let none = datasource().split("[binaries.windows-x64]").next().unwrap().to_string();
        assert_eq!(codes(&none), ["manifest.binaries_missing"]);
    }

    #[test]
    fn settings_follow_the_form_rules() {
        let text = datasource()
            .replacen("name = \"port\"", "name = \"maxRows\"", 1)
            .replacen("type = \"string\"\nsecret = true", "type = \"bool\"\nsecret = true\ntarget = true", 1)
            .replacen("options = [\"standalone\", \"cluster\"]", "options = [\"a\", \"a\"]", 1)
            .replacen("label = { en = \"Host\", de = \"Host\" }", "label = { de = \"Host\", fr = \"Hôte\" }", 1);
        assert_eq!(
            codes(&text),
            [
                "manifest.label_english",
                "manifest.language_unknown",
                "manifest.setting_reserved",
                "manifest.secret_type",
                "manifest.secret_target",
                "manifest.options_invalid",
                "manifest.default_type",
                // The port field is gone, so the network target cannot use it.
                "manifest.target_setting",
            ]
        );
    }

    #[test]
    fn network_targets_are_target_fields_or_fixed_hosts() {
        let text = datasource().replacen("setting = \"host\"", "setting = \"password\"", 1).replacen(
            "host = \"license.example.dev\"\nport = 443",
            "host = \"*.example.dev\"",
            1,
        );
        assert_eq!(codes(&text), ["manifest.target_setting", "manifest.host_invalid", "manifest.port_invalid"]);
        let both = datasource().replacen("setting = \"host\"", "setting = \"host\"\nhost = \"x.dev\"", 1);
        assert_eq!(codes(&both), ["manifest.target_form"]);
        for bad in ["https://x.dev", "x.dev:443", "*.x.dev", "-x.dev", ""] {
            assert!(!valid_host(bad), "{bad}");
        }
        for good in ["x.dev", "localhost", "10.0.0.1", "::1"] {
            assert!(valid_host(good), "{good}");
        }
    }

    #[test]
    fn kinds_only_carry_their_own_parts() {
        let panel = datasource().replacen("kind = \"datasource\"", "kind = \"panel\"", 1);
        assert_eq!(
            codes(&panel),
            [
                "manifest.panel_missing",
                "manifest.not_for_kind",
                "manifest.not_for_kind",
                "manifest.not_for_kind",
                "manifest.not_for_kind",
                "manifest.not_for_kind",
            ]
        );
        let no_protocol = datasource().replacen("protocol = 1\n", "", 1);
        assert_eq!(codes(&no_protocol), ["manifest.protocol_missing"]);
        let future = datasource().replacen("protocol = 1\n", "protocol = 2\n", 1);
        assert_eq!(codes(&future), ["manifest.protocol_unsupported"]);
        let other = datasource().replacen("kind = \"datasource\"", "kind = \"app\"", 1);
        assert_eq!(codes(&other), ["manifest.kind_unknown"]);
    }

    #[test]
    fn updates_name_the_permissions_they_add() {
        let installed = parse(&datasource()).unwrap();
        assert!(installed.added_permissions(&installed).is_empty());
        let update =
            parse(&datasource().replacen("host = \"license.example.dev\"", "host = \"telemetry.example.dev\"", 1))
                .unwrap();
        let added = update.added_permissions(&installed);
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].host.as_deref(), Some("telemetry.example.dev"));
        // Dropping a permission needs no approval.
        let mut fewer = installed.clone();
        fewer.permissions.network.pop();
        assert!(fewer.added_permissions(&installed).is_empty());
    }

    #[test]
    fn the_minimum_kalzit_version_is_checked() {
        let m = parse(&datasource()).unwrap();
        assert!(m.runs_on("0.4.0").is_ok());
        assert!(m.runs_on("1.0.0").is_ok());
        assert_eq!(m.runs_on("0.3.9").unwrap_err().code, "manifest.kalzit_too_old");
        assert_eq!(m.runs_on("0.4.0-rc.1").unwrap_err().code, "manifest.kalzit_too_old");
    }

    #[test]
    fn a_valid_manifest_survives_writing_it_again() {
        let m = parse(&datasource()).unwrap();
        let again = parse(&toml::to_string(&m).expect("serializes")).expect("still valid");
        assert_eq!(again, m);
    }

    #[test]
    fn oversized_manifests_are_refused_before_parsing() {
        let text = format!("{}\n# {}\n", datasource(), "x".repeat(MAX_MANIFEST_BYTES));
        assert_eq!(codes(&text), ["manifest.too_large"]);
    }
}
