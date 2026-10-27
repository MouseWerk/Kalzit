//! The plugin manifest: `kalzit-plugin.toml` at the root of every plugin package (TOML, like
//! `kalzit.toml`). It says what the plugin is, what it delivers, what it may reach, and pins
//! every file of the package by SHA-256 (`files`); the plugin signature covers its exact bytes
//! (`signing::manifest_message`). docs/ARCHITECTURE.md ("Plugins") shows a full example.
//!
//! `parse` reads and validates a manifest and reports every problem at once, each with the path
//! of the value at fault and a stable code. `Manifest::check_package` compares an unpacked
//! package with the manifest before anything in it runs.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Serialize};

/// The file name of the manifest in a plugin package.
pub const MANIFEST_FILE: &str = "kalzit-plugin.toml";

/// The file name of the detached signature next to the manifest.
pub const SIGNATURE_FILE: &str = "kalzit-plugin.sig";

/// The manifest format this crate reads (`manifest = 1`).
pub const MANIFEST_VERSION: u32 = 1;

/// Largest manifest accepted.
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;

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

/// Id prefixes only plugins signed with Kalzit's own plugin key may use
/// (`signing::check_signer`).
pub const RESERVED_ID_PREFIXES: &[&str] = &["io.kalzit.", "dev.kalzit."];

/// What a network target's settings field holds.
pub const TARGET_FORMS: &[&str] = &["host", "url"];

/// How a plugin talks to a host-form or fixed target: plain TCP or TLS over TCP.
pub const TARGET_PROTOCOLS: &[&str] = &["tcp", "tls"];

const MAX_SETTINGS: usize = 64;
const MAX_OPTIONS: usize = 256;
const MAX_NETWORK_TARGETS: usize = 32;
const MAX_FILES: usize = 4096;
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
    /// Data sources: the executable per platform (`windows-x64`, `linux-x64`, `linux-arm64`), a
    /// path listed in `files`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub binaries: BTreeMap<String, String>,
    /// Panels: the web bundle the browser loads into a sandboxed iframe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel: Option<WebBundle>,
    /// Every file of the package (paths relative to its root, `/` between parts) with its
    /// SHA-256 in lowercase hex; only the manifest and its signature are not listed. Kalzit
    /// refuses a package with any other file, a missing file, a different hash or a link.
    pub files: BTreeMap<String, String>,
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

/// One network target: the host or URL a settings field holds, or a fixed host and port. Both
/// pass the same data source target rules (`TargetPolicy`) as built-in sources: Kalzit's own
/// database and metadata addresses are refused, `datasources.allowed_targets` applies.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkTarget {
    /// A `target` settings field with the target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
    /// What `setting` holds: `host` (a host name or address, the port from `port_setting` or
    /// `default_port`) or `url` (scheme, host and port from the URL; `https` means TLS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<String>,
    /// A `target` number field with the port, for the `host` form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_setting: Option<String>,
    /// The port when the settings give none, for the `host` form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_port: Option<u16>,
    /// A fixed host name or address (no wildcards).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The port of a fixed `host`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// `tcp` (the default) or `tls`, for the `host` form and fixed hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

/// A panel's web bundle: one ES module with everything it needs inlined, run in a sandboxed
/// iframe that talks to Kalzit only through the versioned panel message API.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WebBundle {
    /// The bundle's `.js` or `.mjs` file, a path listed in `files`.
    pub path: String,
    /// The panel message API version the bundle speaks.
    pub api: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginKind {
    DataSource,
    Panel,
}

/// One entry of an unpacked package, as the host lists it without following links.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageEntry {
    /// Relative to the package root, with `/` between parts.
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Directory,
    /// A regular file with its SHA-256 (lowercase hex).
    File {
        sha256: String,
    },
    /// A symbolic link, junction or anything else that is not a plain file or directory.
    Other,
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

/// Whether `id` lies in a namespace reserved for Kalzit's own plugins.
pub fn is_reserved_id(id: &str) -> bool {
    RESERVED_ID_PREFIXES.iter().any(|p| id.starts_with(p) || id == p.trim_end_matches('.'))
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

    /// Compares an unpacked package with `files`: every regular file must be listed with the
    /// same hash, every listed file must exist, and links or other special entries are refused
    /// (a link could point outside the package, and on Windows a DLL placed next to the binary
    /// would be loaded before the system's). Only the manifest and its signature may be extra.
    ///
    /// What the host must do for this check to mean anything:
    /// - Unpack into a fresh directory that only Kalzit's service account can write, and run the
    ///   plugin from there; hash the files there, not in the archive or a download folder, so
    ///   nothing can change between the check and the start.
    /// - List entries without following links. Report as `EntryKind::Other` symbolic links,
    ///   junctions and reparse points, files with more than one hard link, and archive entries
    ///   that are links, devices or anything but a plain file or directory; refuse archive paths
    ///   that are not valid package paths before unpacking.
    pub fn check_package(&self, entries: &[PackageEntry]) -> Result<(), Invalid> {
        let mut issues = Vec::new();
        let mut seen = BTreeSet::new();
        for entry in entries {
            let path = &entry.path;
            match &entry.kind {
                EntryKind::Directory => {}
                EntryKind::Other => {
                    issues.push(issue(path.clone(), "package.link", "links and special files are refused"))
                }
                EntryKind::File { .. } if path == MANIFEST_FILE || path == SIGNATURE_FILE => {}
                EntryKind::File { sha256 } => match self.files.get(path) {
                    None => issues.push(issue(
                        path.clone(),
                        "package.file_unlisted",
                        "the manifest does not list this file",
                    )),
                    Some(expected) if expected != sha256 => issues.push(issue(
                        path.clone(),
                        "package.hash_mismatch",
                        "the file's SHA-256 differs from the manifest",
                    )),
                    Some(_) => {
                        seen.insert(path.as_str());
                    }
                },
            }
        }
        for path in self.files.keys().filter(|p| !seen.contains(p.as_str())) {
            if !issues.iter().any(|i| &i.path == path) {
                issues.push(issue(path.clone(), "package.file_missing", "a listed file is missing"));
            }
        }
        if issues.is_empty() { Ok(()) } else { Err(Invalid(issues)) }
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
        self.files(&m.files);

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
            self.listed(&path, file, &m.files);
            if platform.starts_with("windows") && !file.to_ascii_lowercase().ends_with(".exe") {
                self.push(&path, "manifest.binary_not_exe", "a Windows binary ends with .exe");
            }
        }
        self.settings(&m.settings);
        self.network(&m.permissions.network, &m.settings);
    }

    fn panel(&mut self, m: &Manifest) {
        match &m.panel {
            Some(bundle) => {
                self.listed("panel.path", &bundle.path, &m.files);
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
        } else if value.chars().any(is_bidi_control) {
            self.push(path, "manifest.text_bidi", "must not contain bidirectional control characters");
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

    fn files(&mut self, files: &BTreeMap<String, String>) {
        if files.is_empty() {
            self.push("files", "manifest.files_missing", "list every file of the package with its SHA-256");
        } else if files.len() > MAX_FILES {
            self.push("files", "manifest.too_many", format!("at most {MAX_FILES} files"));
        }
        let mut folded = BTreeSet::new();
        for (path, sha256) in files {
            let at = format!("files.{path:?}");
            if !valid_package_path(path) {
                self.push(
                    &at,
                    "manifest.path_invalid",
                    "a relative path inside the package with / between parts, no reserved Windows names, \
                     no part ending in a dot or space",
                );
            } else if path == MANIFEST_FILE || path == SIGNATURE_FILE {
                self.push(&at, "manifest.path_invalid", "the manifest and its signature are not listed");
            } else if !folded.insert(path.to_lowercase()) {
                self.push(&at, "manifest.path_case_duplicate", "another file differs only in case");
            }
            if !(sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) {
                self.push(&at, "manifest.sha256_invalid", "64 lowercase hex digits");
            }
        }
    }

    /// `file` must be one of the listed files.
    fn listed(&mut self, path: &str, file: &str, files: &BTreeMap<String, String>) {
        if !files.contains_key(file) {
            self.push(path, "manifest.file_unlisted", format!("{file} is not in files"));
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

    fn protocol(&mut self, path: &str, protocol: Option<&String>) {
        if let Some(p) = protocol
            && !TARGET_PROTOCOLS.contains(&p.as_str())
        {
            self.push(
                format!("{path}.protocol"),
                "manifest.name_unknown",
                format!("use one of {}", TARGET_PROTOCOLS.join(", ")),
            );
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
                    match t.form.as_deref() {
                        Some("host") => {
                            if let Some(port) = &t.port_setting
                                && !field(port).is_some_and(|s| s.target && s.field_type == "number")
                            {
                                self.push(
                                    format!("{path}.port_setting"),
                                    "manifest.target_setting",
                                    format!("{port} is not a number settings field marked target"),
                                );
                            }
                            if t.default_port == Some(0) {
                                self.push(
                                    format!("{path}.default_port"),
                                    "manifest.port_invalid",
                                    "a port is 1 to 65535",
                                );
                            }
                            self.protocol(&path, t.protocol.as_ref());
                        }
                        Some("url") => {
                            if t.port_setting.is_some() || t.default_port.is_some() || t.protocol.is_some() {
                                self.push(
                                    path.clone(),
                                    "manifest.not_for_target",
                                    "a URL names its scheme and port itself",
                                );
                            }
                        }
                        _ => self.push(
                            format!("{path}.form"),
                            "manifest.target_form",
                            "say whether the setting holds a host or a url",
                        ),
                    }
                    if t.port.is_some() {
                        self.push(format!("{path}.port"), "manifest.not_for_target", "use default_port with a setting");
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
                    if t.port_setting.is_some() || t.default_port.is_some() || t.form.is_some() {
                        self.push(
                            path.clone(),
                            "manifest.not_for_target",
                            "a fixed host has only host, port and protocol",
                        );
                    }
                    self.protocol(&path, t.protocol.as_ref());
                }
                _ => self.push(path, "manifest.target_form", "give either setting or host"),
            }
        }
    }
}

/// Characters that reorder how text is shown (U+202A to U+202E, U+2066 to U+2069, the marks
/// U+200E and U+200F), so a name cannot pretend to be another.
fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}')
}

pub(crate) fn valid_id(id: &str) -> bool {
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

/// A name Windows reserves for a device in any directory and with any extension (`nul.txt`).
fn windows_reserved(part: &str) -> bool {
    let stem = part.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit())
}

/// Whether `path` is a valid path inside a package (relative, `/` between parts, portable). The
/// host refuses archive entries whose paths are not, before it unpacks anything.
pub fn is_package_path(path: &str) -> bool {
    valid_package_path(path)
}

fn valid_package_path(path: &str) -> bool {
    !path.is_empty()
        && path.chars().count() <= MAX_PATH_CHARS
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
        && !path.chars().any(|c| c.is_control() || is_bidi_control(c))
        && path.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.ends_with(['.', ' ']) && !windows_reserved(part)
        })
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
    const HASH2: &str = "0000000000000000000000000000000000000000000000000000000000000002";

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
form = "host"
port_setting = "port"
default_port = 6379
protocol = "tls"

[[permissions.network]]
host = "license.example.dev"
port = 443
protocol = "tls"

[binaries]
windows-x64 = "bin/windows-x64/redis-plugin.exe"
linux-x64 = "bin/linux-x64/redis-plugin"
linux-arm64 = "bin/linux-arm64/redis-plugin"

[files]
"bin/windows-x64/redis-plugin.exe" = "{HASH}"
"bin/linux-x64/redis-plugin" = "{HASH}"
"bin/linux-arm64/redis-plugin" = "{HASH}"
"LICENSE" = "{HASH2}"
"#
        )
    }

    fn panel() -> String {
        format!(
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
api = 1

[files]
"dist/panel.js" = "{HASH}"
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
        assert_eq!(m.files.len(), 4);
        assert_eq!(m.permissions.network.len(), 2);
        assert_eq!(m.settings[1].default, Some(toml::Value::Integer(6379)));
    }

    #[test]
    fn a_panel_manifest_is_valid() {
        let text = panel();
        assert_eq!(parse(&text).expect("valid").plugin_kind(), PluginKind::Panel);
        let html = text
            .replacen("path = \"dist/panel.js\"", "path = \"dist/index.html\"", 1)
            .replacen("api = 1", "api = 9", 1);
        assert_eq!(
            codes(&html),
            ["manifest.file_unlisted", "manifest.panel_not_module", "manifest.panel_api_unsupported"]
        );
        let binary = text.replacen("[files]", "[binaries]\nlinux-x64 = \"dist/panel.js\"\n\n[files]", 1);
        assert_eq!(codes(&binary), ["manifest.not_for_kind"]);
    }

    #[test]
    fn syntax_errors_and_unknown_keys_are_refused() {
        assert_eq!(codes("manifest = "), ["manifest.syntax"]);
        let no_files = datasource().split("[files]").next().unwrap().to_string();
        assert_eq!(codes(&no_files), ["manifest.syntax"]);
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
        for reserved in ["io.kalzit.csv", "dev.kalzit.redis", "io.kalzit"] {
            assert!(is_reserved_id(reserved), "{reserved}");
        }
        for free in ["io.kalzitx.csv", "dev.example.kalzit", "dev.kalzitfan.x"] {
            assert!(!is_reserved_id(free), "{free}");
        }
    }

    #[test]
    fn binaries_are_listed_files_for_known_platforms() {
        let text = datasource()
            .replacen(
                "windows-x64 = \"bin/windows-x64/redis-plugin.exe\"",
                "windows-x64 = \"bin/windows-x64/redis-plugin\"",
                1,
            )
            .replacen("linux-arm64 = ", "macos-arm64 = ", 1)
            .replacen(&format!("\"LICENSE\" = \"{HASH2}\""), "\"LICENSE\" = \"ABC\"", 1);
        assert_eq!(
            codes(&text),
            [
                "manifest.sha256_invalid",
                "manifest.platform_unknown",
                "manifest.file_unlisted",
                "manifest.binary_not_exe",
            ]
        );
        let none = datasource().replacen("[binaries]\n", "[unused]\n", 1);
        assert_eq!(codes(&none), ["manifest.syntax"]);
        let empty = datasource().replacen(
            "windows-x64 = \"bin/windows-x64/redis-plugin.exe\"\nlinux-x64 = \"bin/linux-x64/redis-plugin\"\nlinux-arm64 = \"bin/linux-arm64/redis-plugin\"\n",
            "",
            1,
        );
        assert_eq!(codes(&empty), ["manifest.binaries_missing"]);
    }

    #[test]
    fn package_paths_stay_inside_and_are_portable() {
        for bad in [
            "/abs",
            "C:/x.exe",
            "bin\\x.exe",
            "bin//x",
            "./x",
            "bin/../x",
            "",
            "bin/CON",
            "nul.txt",
            "bin/com1.dll",
            "LPT9",
            "dir./x",
            "x ",
            "a?b",
            "evil\u{202E}txt.exe",
        ] {
            assert!(!valid_package_path(bad), "{bad:?}");
        }
        for good in ["bin/console.exe", "COM10/x", "nullable.js", "a/b.c/d", "x.y"] {
            assert!(valid_package_path(good), "{good:?}");
        }
        let text = datasource().replacen(
            &format!("\"LICENSE\" = \"{HASH2}\""),
            &format!("\"LICENSE\" = \"{HASH2}\"\n\"license\" = \"{HASH2}\"\n\"kalzit-plugin.toml\" = \"{HASH2}\""),
            1,
        );
        assert_eq!(codes(&text), ["manifest.path_invalid", "manifest.path_case_duplicate"]);
    }

    #[test]
    fn packages_hold_exactly_the_listed_files() {
        let m = parse(&datasource()).unwrap();
        let file = |path: &str, sha256: &str| PackageEntry {
            path: path.into(),
            kind: EntryKind::File { sha256: sha256.into() },
        };
        let mut entries = vec![
            PackageEntry { path: "bin".into(), kind: EntryKind::Directory },
            file("bin/windows-x64/redis-plugin.exe", HASH),
            file("bin/linux-x64/redis-plugin", HASH),
            file("bin/linux-arm64/redis-plugin", HASH),
            file("LICENSE", HASH2),
            file(MANIFEST_FILE, HASH2),
            file(SIGNATURE_FILE, HASH2),
        ];
        assert_eq!(m.check_package(&entries), Ok(()));

        entries[4] = file("LICENSE", HASH);
        entries.push(file("bin/windows-x64/version.dll", HASH));
        entries.push(PackageEntry { path: "bin/link".into(), kind: EntryKind::Other });
        entries.remove(3);
        let codes = m.check_package(&entries).unwrap_err().codes();
        assert_eq!(codes, ["package.hash_mismatch", "package.file_unlisted", "package.link", "package.file_missing"]);
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
        let bidi = datasource().replacen("name = \"Redis\"", "name = \"Redis\u{202E}lacol\"", 1);
        assert_eq!(codes(&bidi), ["manifest.text_bidi"]);
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
        let no_form = datasource().replacen("form = \"host\"\n", "", 1);
        assert_eq!(codes(&no_form), ["manifest.target_form"]);
        let url_with_port = datasource().replacen("form = \"host\"", "form = \"url\"", 1);
        assert_eq!(codes(&url_with_port), ["manifest.not_for_target"]);
        let udp = datasource().replacen("protocol = \"tls\"", "protocol = \"udp\"", 1);
        assert_eq!(codes(&udp), ["manifest.name_unknown"]);
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
        for text in [datasource(), panel()] {
            let m = parse(&text).unwrap();
            let again = parse(&toml::to_string(&m).expect("serializes")).expect("still valid");
            assert_eq!(again, m);
        }
    }

    #[test]
    fn oversized_manifests_are_refused_before_parsing() {
        let text = format!("{}\n# {}\n", datasource(), "x".repeat(MAX_MANIFEST_BYTES));
        assert_eq!(codes(&text), ["manifest.too_large"]);
    }
}
