//! The plugins of this server: installing from a file, approving permissions, enabling and
//! disabling, removing, trust (publisher keys, hand-overs, unsigned plugins) and the blocks of
//! organizations. An installed plugin runs when it is approved, enabled and still trusted; then
//! its kind is in the registry (`Remote` around its `Supervisor`) and its process starts with
//! the first call (docs/api/plugins.md).
//!
//! Files: `<data_dir>/plugins/packages/<dir>` holds each checked package (Kalzit's account
//! writes, plugins read and run), `<data_dir>/plugins/run/<random>` each start's private
//! directory (socket and `tmp`), `<data_dir>/plugins/uploads` packages while they are checked.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, RwLock};

use ed25519_dalek::{Signature, VerifyingKey};
use kalzit_plugin_api::manifest::{self, Manifest};
use kalzit_plugin_api::signing::{self, HandOver, Installed, Signer};
use serde::Serialize;
use serde_json::{Value, json};

use super::connector::OwnEndpoints;
use super::package::{self, PluginAccess, TrustedKey, Verified};
use super::panels::{self, ActivePanel, PanelRegistry};
use super::remote::Remote;
use super::store::{self, HandOverRow, KeyRow, Pending, PluginRow};
use super::supervisor::{Options, Status, Supervisor};
use super::{HostError, intern};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::datasources::registry::Origin;
use crate::datasources::{DataSources, DefaultValue, Kind, SettingField, SettingType};
use crate::error::{ApiError, ApiResult};
use crate::locks::{MutexExt, RwLockExt};

/// Who acts, for the audit log.
pub struct Actor<'a> {
    pub user_id: &'a str,
    pub address: String,
    pub org_id: Option<&'a str>,
}

fn signer_name(s: Signer) -> &'static str {
    match s {
        Signer::Kalzit => "kalzit",
        Signer::Publisher => "publisher",
        Signer::Unsigned => "unsigned",
    }
}

/// The stored kind must be the manifest's. Kalzit 0.4.0 let an update change the kind without
/// recording it; such a plugin neither runs nor is shown until it is removed and installed anew.
pub fn check_kind(row: &PluginRow, manifest: &Manifest) -> Result<(), HostError> {
    if row.kind == manifest.kind {
        return Ok(());
    }
    Err(HostError::new(
        "plugin.kind_changed",
        format!(
            "the plugin is stored as a {} plugin but its package is a {} plugin; remove it and install it anew",
            row.kind, manifest.kind
        ),
    ))
}

fn key_from_hex(text: &str) -> Option<VerifyingKey> {
    let bytes = <[u8; 32]>::try_from(hex::decode(text).ok()?).ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// A reinstall whose key differs from the one that signed the removed plugin of the same id
/// (or whose former key is unknown), or a signed update of an unsigned installed plugin,
/// confirmed by the administrator where it matters.
struct Takeover {
    /// The key that signed the removed plugin, if it was signed and is known.
    from_key: Option<String>,
    removed_version: Option<String>,
    /// The unsigned installed version a signed update replaces.
    installed_version: Option<String>,
    /// The data sources of the kind, whose stored secrets are cleared.
    datasources: Vec<String>,
}

/// Settings forms by plugin id and version.
type Forms = HashMap<(String, String), &'static [SettingField]>;

/// The settings form of a plugin kind, built once per plugin version.
fn settings_form(m: &Manifest) -> &'static [SettingField] {
    static FORMS: LazyLock<Mutex<Forms>> = LazyLock::new(Mutex::default);
    let mut forms = FORMS.lock_or_recover();
    if let Some(form) = forms.get(&(m.id.clone(), m.version.clone())) {
        return form;
    }
    let fields: Vec<SettingField> = m
        .settings
        .iter()
        .map(|s| {
            let field_type = match s.field_type.as_str() {
                "text" => SettingType::Text,
                "number" => SettingType::Number,
                "bool" => SettingType::Bool,
                "select" => SettingType::Select,
                _ => SettingType::String,
            };
            let options: Vec<&'static str> = s.options.iter().map(|o| intern(o)).collect();
            let default = match &s.default {
                Some(toml::Value::String(t)) => Some(DefaultValue::Text(intern(t))),
                Some(toml::Value::Integer(n)) => u64::try_from(*n).ok().map(DefaultValue::Number),
                Some(toml::Value::Boolean(b)) => Some(DefaultValue::Bool(*b)),
                _ => None,
            };
            SettingField {
                name: intern(&s.name),
                // The UI shows the manifest's labels (`labels` of the kind list); a known name
                // also has a translation of its own.
                label_key: intern(&format!("datasources.settings.{}", s.name)),
                field_type,
                required: s.required,
                secret: s.secret,
                target: s.target,
                options: Box::leak(options.into_boxed_slice()),
                default,
            }
        })
        .collect();
    let form: &'static [SettingField] = Box::leak(fields.into_boxed_slice());
    forms.insert((m.id.clone(), m.version.clone()), form);
    form
}

/// Whether a configuration text holds secrets: a value of a key named like a password, secret or
/// token, or a URL with a password (such as `database.url`).
#[cfg(any(windows, test))]
fn holds_secrets(text: &str) -> bool {
    fn walk(value: &toml::Value, key: &str) -> bool {
        match value {
            toml::Value::Table(t) => t.iter().any(|(k, v)| walk(v, &k.to_ascii_lowercase())),
            toml::Value::Array(a) => a.iter().any(|v| walk(v, key)),
            toml::Value::String(s) => {
                (!s.is_empty() && ["password", "secret", "token"].iter().any(|n| key.contains(n)))
                    || url::Url::parse(s).is_ok_and(|u| u.password().is_some())
            }
            _ => false,
        }
    }
    match toml::from_str::<toml::Table>(text) {
        Ok(table) => walk(&toml::Value::Table(table), ""),
        // A file that does not parse is not one Kalzit runs with; judge it by its words.
        Err(_) => ["password", "secret", "token"].iter().any(|n| text.to_ascii_lowercase().contains(n)),
    }
}

/// Kalzit's own files with secrets that others may read (`exposed_secrets`).
#[derive(Clone, Debug, Default)]
pub struct Exposure {
    /// Files every local account may read, but no plugin: shown and logged.
    pub warnings: Vec<super::supervisor::StatusWarning>,
    /// Files a plugin could read: plugins do not start while there are any
    /// (`plugin.secrets_exposed`).
    pub readable_by_plugins: Vec<String>,
}

/// Kalzit's own files that hold secrets: `kalzit.toml` with secrets in it, the TLS key, the
/// secrets key files and a SQLite database outside the data directory (Windows).
///
/// A plugin's token keeps Everyone, Users and `RESTRICTED` as restricting SIDs and runs in an
/// AppContainer, so a plugin reads a file when its DACL grants read to one of those and also to
/// all AppContainers (`ALL APPLICATION PACKAGES` or `ALL RESTRICTED APPLICATION PACKAGES`, as
/// under `C:\Program Files`): such a file is in `readable_by_plugins`. A file only Everyone,
/// Users or Authenticated Users may read is closed to plugins but open to other local accounts:
/// a warning. Empty on Linux, where Landlock keeps the plugin out of these files.
pub fn exposed_secrets(config: &crate::config::Config) -> Exposure {
    #[cfg(windows)]
    {
        let mut files = Vec::new();
        if let Some(path) = &config.config_file
            && std::fs::read_to_string(path).is_ok_and(|t| holds_secrets(&t))
        {
            files.push(path.clone());
        }
        files.extend(config.tls.key_file.clone());
        for name in [crate::secrets::KEY_FILE, crate::secrets::DPAPI_KEY_FILE] {
            let path = config.paths.data_dir.join(name);
            if path.exists() {
                files.push(path);
            }
        }
        let url = config.database_url();
        if let Some(rest) = url.strip_prefix("sqlite:") {
            let path = std::path::PathBuf::from(rest.trim_start_matches("//").split('?').next().unwrap_or_default());
            if path.is_absolute() && !path.starts_with(&config.paths.data_dir) {
                files.push(path);
            }
        }
        let mut out = Exposure::default();
        for path in files {
            let Ok((_, dacl)) = crate::data_dir::acl::read(&path) else { continue };
            let dacl: Option<Vec<(String, u32)>> = dacl.map(|d| d.into_iter().map(|e| (e.sid, e.mask)).collect());
            match judge(dacl.as_deref()) {
                Judged::Closed => {}
                Judged::LocalAccounts(names) => out.warnings.push(super::supervisor::StatusWarning {
                    reason: "plugin.secrets_readable",
                    message: format!(
                        "{} holds secrets and {} may read it; plugins cannot, but other local accounts can: \
                         limit it to SYSTEM, Administrators and the account Kalzit runs as",
                        path.display(),
                        names.join(", ")
                    ),
                    params: [
                        ("path".to_string(), path.display().to_string()),
                        ("accounts".to_string(), names.join(", ")),
                    ]
                    .into(),
                }),
                Judged::Plugins => out.readable_by_plugins.push(path.display().to_string()),
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        let _ = config;
        Exposure::default()
    }
}

/// Who besides Kalzit may read a file, by its allow entries (`None`: no DACL).
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum Judged {
    Closed,
    LocalAccounts(Vec<&'static str>),
    Plugins,
}

#[cfg(any(windows, test))]
fn judge(dacl: Option<&[(String, u32)]>) -> Judged {
    /// Read data, or everything.
    const READ: u32 = 0x1 | 0x8000_0000 | 0x1000_0000;
    const WIDE: &[(&str, &str)] =
        &[("S-1-1-0", "Everyone"), ("S-1-5-32-545", "Users"), ("S-1-5-11", "Authenticated Users")];
    /// The restricting SIDs of a plugin's token that name others than the plugin.
    const RESTRICTING: &[&str] = &["S-1-1-0", "S-1-5-32-545", "S-1-5-12"];
    /// What every AppContainer passes.
    const CONTAINERS: &[&str] = &["S-1-15-2-1", "S-1-15-2-2"];
    let Some(entries) = dacl else { return Judged::Plugins };
    let reads = |sid: &str| entries.iter().any(|(s, mask)| s == sid && mask & READ != 0);
    if RESTRICTING.iter().any(|s| reads(s)) && CONTAINERS.iter().any(|s| reads(s)) {
        return Judged::Plugins;
    }
    let names: Vec<&str> = WIDE.iter().filter(|(sid, _)| reads(sid)).map(|(_, name)| *name).collect();
    if names.is_empty() { Judged::Closed } else { Judged::LocalAccounts(names) }
}

/// The connector's view of the data sources: each connect reads the data source's kind and
/// settings from the database and the target rules from the server settings, as they are then.
#[derive(Default)]
pub struct StateLookup {
    state: RwLock<Option<AppState>>,
}

#[async_trait::async_trait]
impl super::connector::Lookup for StateLookup {
    async fn current(&self, datasource_id: &str) -> Option<super::connector::Current> {
        let state = self.state.read_or_recover().clone()?;
        let row: Option<(String, String, String)> =
            sqlx::query_as("SELECT org_id, kind, settings FROM datasources WHERE id = $1 AND deleted_at IS NULL")
                .bind(datasource_id)
                .fetch_optional(&state.db)
                .await
                .ok()?;
        let (org_id, kind, settings) = row?;
        // An organization that blocked the plugin keeps it away from its sources.
        if state.datasources.is_blocked(&org_id, &kind) {
            return None;
        }
        let settings = serde_json::from_str(&settings).ok()?;
        let policy = state.datasources.policy(&state).await.ok()?;
        Some(super::connector::Current { kind, settings, policy })
    }
}

/// The texts of a plugin kind for the kind list: labels and help by field and language.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindTexts {
    pub plugin: String,
    pub version: String,
    /// The publisher the manifest names; shown as a neutral badge, not a verified identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    pub labels: BTreeMap<String, BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub help: BTreeMap<String, BTreeMap<String, String>>,
}

/// The plugins of this server.
pub struct PluginHost {
    root: PathBuf,
    options: RwLock<Options>,
    kalzit_keys: RwLock<Vec<VerifyingKey>>,
    /// The plugins whose kinds are registered, with their process.
    running: Arc<Mutex<HashMap<String, Arc<Supervisor>>>>,
    /// Serializes the administrator's changes.
    changes: tokio::sync::Mutex<()>,
    /// Plugins may run on a Linux host without Landlock (`allowWithoutLandlock`).
    without_landlock: Arc<AtomicBool>,
    /// The panel plugins that may be shown (`plugins::panels`).
    panels: PanelRegistry,
    /// The package directory each registered plugin runs from (`sync`).
    registered: Mutex<HashMap<String, String>>,
    /// Kalzit's own addresses, which no plugin connection reaches.
    own: Arc<OwnEndpoints>,
    /// Kalzit's database, for the audit log of refused connects; set by `load`.
    db: OnceLock<sqlx::AnyPool>,
    /// Kalzit's own files with secrets that every local account may read (`exposed_secrets`).
    exposed: Arc<Exposure>,
    /// The data sources and server settings as they are now, for the connector (`attach`).
    lookup: Arc<StateLookup>,
    /// The shared packages whose refusal is in the audit log, by directory and reason, so that
    /// the retries of `sync` record it once.
    refused: Mutex<std::collections::HashSet<(String, String)>>,
}

impl PluginHost {
    /// The host on `<data_dir>/plugins`. Nothing runs until `load`.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("plugins"),
            options: RwLock::new(Options::default()),
            kalzit_keys: RwLock::new(package::kalzit_keys()),
            running: Arc::default(),
            changes: tokio::sync::Mutex::new(()),
            without_landlock: Arc::default(),
            panels: PanelRegistry::default(),
            registered: Mutex::default(),
            own: Arc::default(),
            db: OnceLock::new(),
            exposed: Arc::default(),
            lookup: Arc::default(),
            refused: Mutex::default(),
        }
    }

    /// Gives the connector the server's state, to read data sources and settings at each connect.
    pub fn attach(&self, state: AppState) {
        // Without this host in it: the state the connector reads must not keep the plugins (and
        // with them their processes) alive once the server lets go of them.
        let mut detached = state;
        detached.plugins = Arc::new(PluginHost::new(&detached.config.paths.data_dir));
        *self.lookup.state.write_or_recover() = Some(detached);
    }

    /// The warnings of `exposed_secrets`, shown with every plugin and logged when one is enabled.
    pub fn with_exposed_secrets(mut self, exposed: Exposure) -> Self {
        self.exposed = Arc::new(exposed);
        self
    }

    /// Kalzit's own listening addresses and database (`OwnEndpoints::from_config`).
    pub fn with_own_endpoints(mut self, own: OwnEndpoints) -> Self {
        self.own = Arc::new(own);
        self
    }

    /// The panel plugins that may be shown.
    pub fn panels(&self) -> &PanelRegistry {
        &self.panels
    }

    /// Changes the supervision times and limits for plugins started from now on (tests).
    pub fn set_options(&self, options: Options) {
        *self.options.write_or_recover() = options;
    }

    /// Trusts `key` as Kalzit's own plugin key (tests; builds name theirs at build time).
    pub fn trust_kalzit_key(&self, key: VerifyingKey) {
        self.kalzit_keys.write_or_recover().push(key);
    }

    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// The directory of the package `name` in `packages`. Names come from the database, so only
    /// the ones `install` makes are accepted (`is_package_dir_name`), and the path must stay in
    /// `packages`.
    fn package_path(&self, name: &str) -> Result<PathBuf, HostError> {
        let packages = self.dir("packages");
        let dir = packages.join(name);
        if !is_package_dir_name(name) || dir.parent() != Some(packages.as_path()) {
            return Err(HostError::new("plugin.package_dir_invalid", "the package directory name is not valid"));
        }
        Ok(dir)
    }

    /// Removes the package `name` with its mark; a name that is not a package's is left alone.
    fn remove_package(&self, name: &str) {
        match self.package_path(name) {
            Ok(dir) => remove_dir(&dir),
            Err(_) => tracing::error!("a package directory name from the database is not valid; nothing is removed"),
        }
    }

    /// Creates the host's directories (private) where they are missing.
    fn prepare(&self) -> std::io::Result<()> {
        for (dir, access) in [
            (self.root.clone(), PluginAccess::None),
            (self.dir("packages"), PluginAccess::None),
            (self.dir("run"), PluginAccess::None),
            (self.dir("uploads"), PluginAccess::None),
        ] {
            if !dir.exists() {
                package::private_dir(&dir, &access)?;
            }
        }
        Ok(())
    }

    /// A directory for an upload being received, removed with the returned guard.
    pub fn upload_path(&self) -> Result<PathBuf, HostError> {
        self.prepare()?;
        Ok(self.dir("uploads").join(format!("{}.zip", uuid::Uuid::now_v7().simple())))
    }

    /// Registers the kinds of every runnable plugin and loads the blocks of organizations;
    /// at start. A plugin that cannot run is logged and left out.
    pub async fn load(&self, db: &sqlx::AnyPool, datasources: &DataSources) -> ApiResult<()> {
        let _ = self.db.set(db.clone());
        // A changed or deleted data source takes back what plugins may reach for it.
        // Weak: the data sources must not keep the plugins alive.
        let running = Arc::downgrade(&self.running);
        datasources.on_forget(Arc::new(move |datasource_id| {
            let Some(running) = running.upgrade() else { return };
            for supervisor in running.lock_or_recover().values() {
                supervisor.grants().revoke(datasource_id);
            }
        }));
        datasources.set_blocks(store::blocks(db).await?);
        let switches = store::switches(db).await?;
        self.without_landlock.store(switches.allow_without_landlock, Ordering::SeqCst);
        let rows = store::all(db).await?;
        if rows.is_empty() {
            return Ok(());
        }
        if let Err(e) = self.prepare() {
            tracing::error!("the plugin directories cannot be prepared: {e}");
            return Ok(());
        }
        clear_dir(&self.dir("run"));
        clear_dir(&self.dir("uploads"));
        let keys = store::keys(db).await?;
        for row in rows {
            // As on every server of several (`sync`): unsigned plugins run only while allowed.
            if row.signer == "unsigned" && !switches.allow_unsigned {
                tracing::warn!(plugin = %row.id, "the plugin is unsigned and unsigned plugins are not allowed; it does not run");
                continue;
            }
            if let Err(e) = self.register(&row, &keys, datasources) {
                self.not_running(db, None, &row, Some(e.reason), &e.message).await;
            }
        }
        Ok(())
    }

    fn trusted(&self, keys: &[KeyRow]) -> Vec<TrustedKey> {
        let kalzit = self.kalzit_keys.read_or_recover();
        kalzit
            .iter()
            .map(|k| TrustedKey { key: *k, signer: Signer::Kalzit })
            .chain(
                keys.iter()
                    .filter_map(|k| key_from_hex(&k.public_key))
                    .map(|key| TrustedKey { key, signer: Signer::Publisher }),
            )
            .collect()
    }

    /// The keys plugins and the catalog index may be signed with: Kalzit's own plugin keys and
    /// the publisher keys an administrator trusts (`plugins::catalog`).
    pub async fn trusted_keys(&self, db: &sqlx::AnyPool) -> ApiResult<Vec<TrustedKey>> {
        Ok(self.trusted(&store::keys(db).await?))
    }

    /// Whether the key that signed `row` is still trusted.
    fn still_trusted(&self, signer: &str, public_key: Option<&str>, keys: &[KeyRow]) -> bool {
        match signer {
            "unsigned" => true,
            "kalzit" => {
                let kalzit = self.kalzit_keys.read_or_recover();
                public_key.and_then(key_from_hex).is_some_and(|k| kalzit.contains(&k))
            }
            _ => public_key.is_some_and(|p| keys.iter().any(|k| k.public_key == p)),
        }
    }

    /// Puts the plugin's kind into the registry when it may run: approved, enabled, trusted,
    /// with a binary for this platform and a Kalzit new enough.
    fn register(&self, row: &PluginRow, keys: &[KeyRow], datasources: &DataSources) -> Result<bool, HostError> {
        if !(row.approved && row.enabled) {
            return Ok(false);
        }
        if !self.still_trusted(&row.signer, row.public_key.as_deref(), keys) {
            return Err(HostError::new("plugin.untrusted", "the key that signed the plugin is no longer trusted"));
        }
        let manifest =
            manifest::parse(&row.manifest).map_err(|e| HostError::new("plugin.manifest_invalid", e.to_string()))?;
        check_kind(row, &manifest)?;
        manifest.runs_on(env!("CARGO_PKG_VERSION")).map_err(|i| HostError::new("plugin.kalzit_too_old", i.message))?;
        let package_dir = self.package_path(&row.dir)?;
        // The package on disk must be the one installed: its manifest (which lists every file
        // with its hash, and which the signature covers) byte for byte the stored one.
        let on_disk = std::fs::read(package_dir.join(manifest::MANIFEST_FILE))?;
        if on_disk != row.manifest.as_bytes() {
            return Err(manifest_differs());
        }
        if manifest.plugin_kind() == manifest::PluginKind::Panel {
            // Nothing runs on the server: the panel may be shown.
            self.panels.insert(&row.id, ActivePanel { manifest: Arc::new(manifest), package_dir });
            self.registered.lock_or_recover().insert(row.id.clone(), row.dir.clone());
            return Ok(true);
        }
        let program = package::binary(&manifest, &package_dir)?;
        let launch = super::supervisor::Launch {
            manifest: Arc::new(manifest),
            program,
            package_dir,
            run_root: self.dir("run"),
            allow_without_landlock: self.without_landlock.clone(),
            own: self.own.clone(),
            audit: self.db.get().cloned(),
            exposure: self.exposed.clone(),
            lookup: self.lookup.clone(),
        };
        let options = self.options.read_or_recover().clone();
        let supervisor = Supervisor::new(launch, options);
        let m = supervisor.manifest().clone();
        let kind = Kind {
            name: intern(&m.name),
            hint_key: "datasources.kinds.plugin.hint",
            settings: settings_form(&m),
            plugin: Arc::new(Remote::new(supervisor.clone())),
        };
        datasources
            .registry()
            .register(kind, Origin::Plugin { version: m.version.clone() })
            .map_err(|e| HostError::new("plugin.kind_taken", e.to_string()))?;
        self.running.lock_or_recover().insert(row.id.clone(), supervisor);
        self.registered.lock_or_recover().insert(row.id.clone(), row.dir.clone());
        Ok(true)
    }

    /// Takes the plugin's kind out of the registry and ends its process. Running queries finish
    /// on the kind they hold; new ones answer `datasource.kind_unavailable`.
    async fn unregister(&self, id: &str, datasources: &DataSources) {
        self.registered.lock_or_recover().remove(id);
        self.panels.remove(id);
        let _ = datasources.registry().unregister(id);
        let supervisor = self.running.lock_or_recover().remove(id);
        if let Some(s) = supervisor {
            s.shutdown().await;
        }
    }

    /// Ends every plugin process (Kalzit stops).
    pub async fn shutdown(&self) {
        *self.lookup.state.write_or_recover() = None;
        let all: Vec<Arc<Supervisor>> = self.running.lock_or_recover().values().cloned().collect();
        for s in all {
            s.shutdown().await;
        }
    }

    pub fn supervisor(&self, id: &str) -> Option<Arc<Supervisor>> {
        self.running.lock_or_recover().get(id).cloned()
    }

    /// The texts of a plugin kind, for the kind list.
    pub fn kind_texts(&self, kind: &str) -> Option<KindTexts> {
        let s = self.supervisor(kind)?;
        let m = s.manifest();
        Some(KindTexts {
            plugin: m.id.clone(),
            version: m.version.clone(),
            publisher: m.publisher.clone(),
            labels: m.settings.iter().map(|s| (s.name.clone(), s.label.clone())).collect(),
            help: m.settings.iter().filter_map(|s| s.help.clone().map(|h| (s.name.clone(), h))).collect(),
        })
    }

    async fn record(
        &self,
        conn: &mut sqlx::AnyConnection,
        actor: &Actor<'_>,
        action: &'static str,
        id: &str,
        summary: Value,
        at: i64,
    ) -> ApiResult<()> {
        let event = AuditEvent {
            org_id: actor.org_id,
            actor_user_id: Some(actor.user_id),
            actor_address: Some(actor.address.clone()),
            action,
            resource_type: Some("plugin"),
            resource_id: Some(id),
            summary,
            at_ms: at,
        };
        audit::record(conn, &event).await?;
        Ok(())
    }

    /// Installs or updates from the zip file `archive`. A new plugin is installed disabled and
    /// waits for the approval of its permissions. An update of an approved plugin replaces it
    /// at once when it adds no permissions; otherwise it waits for approval while the installed
    /// version keeps running. A plugin installed again after its removal must be signed like an
    /// update of the removed one; another key needs `confirm_publisher_change` when data sources
    /// of the kind exist, and then clears their stored secrets.
    pub async fn install(
        &self,
        state: &AppState,
        archive: &Path,
        confirm_publisher_change: bool,
        actor: &Actor<'_>,
    ) -> ApiResult<PluginRow> {
        let _changes = self.changes.lock().await;
        self.prepare().map_err(|e| HostError::from(e).api())?;
        let dir_name = format!("{}", uuid::Uuid::now_v7().simple());
        let dir = self.dir("packages").join(&dir_name);
        let checked = self.check_package(state, archive, &dir, confirm_publisher_change).await;
        let (unpacked, verified, existing, takeover) = match checked {
            Ok(c) => c,
            Err(e) => {
                remove_dir(&dir);
                self.record_refusal(state, actor, &e).await;
                return Err(e);
            }
        };
        let m = &unpacked.manifest;
        let now = state.clock.now_ms();
        let key_hex = verified.key.as_ref().map(signing::key_hex);
        let signer = signer_name(verified.signer).to_string();
        let mut tx = crate::db::begin(&state.db).await?;
        let fresh = existing.is_none();
        let (row, action, old_dirs) = match existing {
            None => {
                let row = PluginRow {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    version: m.version.clone(),
                    kind: m.kind.clone(),
                    manifest: unpacked.manifest_text.clone(),
                    signer,
                    public_key: key_hex,
                    dir: dir_name,
                    approved: false,
                    enabled: false,
                    pending: None,
                    installed_at: now,
                    updated_at: now,
                };
                (row, "plugins.installed", vec![])
            }
            Some(old) => {
                let old_manifest =
                    manifest::parse(&old.manifest).map_err(|e| ApiError::internal("plugin manifest", e))?;
                let added = m.added_permissions(&old_manifest);
                let mut old_dirs: Vec<String> = old.pending.iter().map(|p| p.dir.clone()).collect();
                let mut row = PluginRow { pending: None, updated_at: now, ..old.clone() };
                if old.approved && !added.is_empty() {
                    row.pending = Some(Pending {
                        version: m.version.clone(),
                        manifest: unpacked.manifest_text.clone(),
                        signer,
                        public_key: key_hex,
                        dir: dir_name,
                    });
                    (row, "plugins.update_pending", old_dirs)
                } else {
                    old_dirs.push(old.dir.clone());
                    row.name = m.name.clone();
                    // Always the applied manifest's (an update of another kind is refused).
                    row.kind = m.kind.clone();
                    row.version = m.version.clone();
                    row.manifest = unpacked.manifest_text.clone();
                    row.signer = signer;
                    row.public_key = key_hex;
                    row.dir = dir_name;
                    (row, "plugins.updated", old_dirs)
                }
            }
        };
        store::put(&mut tx, &row, actor.user_id).await?;
        if fresh {
            store::delete_tombstone(&mut tx, &row.id).await?;
        }
        if state.cluster.coordinated() {
            // The other servers on the same database unpack it from here (`sync`).
            let package_dir = row.pending.as_ref().map_or(&row.dir, |p| &p.dir);
            share_package(&mut tx, archive, package_dir, now).await?;
        }
        let mut cleared = Vec::new();
        if let Some(t) = &takeover {
            // A new publisher starts a new line of keys, and the secrets entered for the former
            // publisher's plugin never reach the new one: they must be entered again.
            store::delete_handovers(&mut tx, &row.id).await?;
            let secrets = store::clear_secrets_of_kind(&mut tx, &row.id).await?;
            let summary = json!({
                "fromKeyId": t.from_key.as_deref().and_then(key_from_hex).map(|k| signing::key_id(&k)),
                "toKeyId": verified.key.as_ref().map(signing::key_id),
                "removedVersion": t.removed_version,
                "installedVersion": t.installed_version,
                "version": m.version,
                "datasources": t.datasources,
                "secretsCleared": secrets,
            });
            self.record(&mut tx, actor, "plugins.publisher_changed", &row.id, summary, now).await?;
            cleared.clone_from(&t.datasources);
        }
        let summary = json!({
            "version": m.version,
            "signer": row.signer,
            "keyId": verified.key.as_ref().map(signing::key_id),
            "permissions": package::permission_lines(m),
        });
        self.record(&mut tx, actor, action, &row.id, summary, now).await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        // Checked in full (`materialize` unpacks again a directory without the mark).
        let unpacked = row.pending.as_ref().map_or(&row.dir, |p| &p.dir);
        if let Err(e) = write_complete_mark(&self.dir("packages").join(format!("{unpacked}{COMPLETE_SUFFIX}"))) {
            tracing::warn!(plugin = %row.id, "marking the package as complete: {e}");
        }
        for id in &cleared {
            state.datasources.forget(id);
        }
        if action == "plugins.updated" {
            self.unregister(&row.id, &state.datasources).await;
            self.reregister(state, &row.id).await;
        }
        for old in old_dirs {
            self.remove_package(&old);
        }
        Ok(row)
    }

    /// A refused package in the audit log, with the reason (a failure to write it is logged).
    async fn record_refusal(&self, state: &AppState, actor: &Actor<'_>, e: &ApiError) {
        let reason = e.reason.as_ref().map(|r| r.code.clone()).unwrap_or_else(|| e.code.to_string());
        let summary = json!({ "reason": reason });
        let recorded = async {
            let mut tx = crate::db::begin(&state.db).await?;
            self.record(&mut tx, actor, "plugins.install_refused", "package", summary, state.clock.now_ms()).await?;
            crate::db::commit(tx).await?;
            Ok::<_, ApiError>(())
        };
        if let Err(err) = recorded.await {
            tracing::warn!("the refused plugin package could not be recorded: {}", err.message);
        }
    }

    /// Every check, in this order: the manifest and the signature read from the archive (trust,
    /// reserved ids, the update rules, fixed targets), and only then the archive unpacked into
    /// `dir` and compared with the manifest; the binary is made executable last. Answers the
    /// installed plugin of the same id, if any, and a change of publisher after a removal.
    async fn check_package(
        &self,
        state: &AppState,
        archive: &Path,
        dir: &Path,
        confirm_publisher_change: bool,
    ) -> ApiResult<(package::Unpacked, Verified, Option<PluginRow>, Option<Takeover>)> {
        let path = archive.to_path_buf();
        let signed = tokio::task::spawn_blocking(move || package::read_from_zip(&path))
            .await
            .map_err(|e| ApiError::internal("plugin package", e))?
            .map_err(HostError::api)?;
        let m = &signed.manifest;
        let is_panel = m.plugin_kind() == manifest::PluginKind::Panel;
        m.runs_on(env!("CARGO_PKG_VERSION"))
            .map_err(|i| HostError::new("plugin.kalzit_too_old", i.message).with("minKalzit", &m.min_kalzit).api())?;
        // A panel has no binary: it runs in the browser (`plugins::panels`).
        let program = if is_panel { None } else { Some(package::binary(m, dir).map_err(HostError::api)?) };
        let keys = store::keys(&state.db).await?;
        let switches = store::switches(&state.db).await?;
        let verified =
            package::verify(&signed, &self.trusted(&keys), switches.allow_unsigned).map_err(HostError::api)?;
        let existing = store::get(&state.db, &m.id).await?;
        let mut takeover = None;
        if let Some(old) = &existing {
            let old_manifest = manifest::parse(&old.manifest).map_err(|e| ApiError::internal("plugin manifest", e))?;
            let old_key = old.public_key.as_deref().and_then(key_from_hex);
            let handovers = self.handovers(state, &old.id).await?;
            let installed = Installed { manifest: &old_manifest, key: old_key.as_ref(), handovers: &handovers };
            signing::check_update(&installed, m, verified.key.as_ref()).map_err(|r| package::refusal(&r).api())?;
            if signing::becomes_signed(&installed, verified.key.as_ref()) {
                takeover = Some(self.check_signed_now(state, old, m, confirm_publisher_change).await?);
            }
        } else if datasources_has_kind(&state.datasources, &m.id) {
            return Err(HostError::new("plugin.kind_taken", format!("the data source kind {} is taken", m.id)).api());
        } else {
            takeover = self.check_reinstall(state, m, verified.key.as_ref(), confirm_publisher_change).await?;
        }
        let policy = state.datasources.policy(state).await?;
        for target in &m.permissions.network {
            if let Some(host) = &target.host {
                policy.precheck_host(host).map_err(|b| {
                    HostError::new(
                        "plugin.target_refused",
                        format!("the fixed target {host} is refused: {}", b.0.message),
                    )
                    .with("host", host)
                    .api()
                })?;
            }
        }
        // Only the plugin itself (its SID) may read and run its package; no process reads a
        // panel's package but Kalzit.
        let access = if is_panel { PluginAccess::None } else { PluginAccess::ReadExecute(package::plugin_sid(&m.id)) };
        package::private_dir(dir, &access).map_err(|e| HostError::from(e).api())?;
        let (archive, into) = (archive.to_path_buf(), dir.to_path_buf());
        let unpacked = tokio::task::spawn_blocking(move || package::unpack(&archive, &into))
            .await
            .map_err(|e| ApiError::internal("plugin unpack", e))?
            .map_err(HostError::api)?;
        if unpacked.manifest_text != signed.manifest_text {
            return Err(HostError::new("plugin.package_invalid", "the manifest differs from the one checked")
                .with("issues", "manifest")
                .api());
        }
        match &program {
            Some(program) => package::make_executable(program).map_err(|e| HostError::from(e).api())?,
            None => panels::check_bundle(&unpacked.manifest, dir).map_err(HostError::api)?,
        }
        Ok((unpacked, verified, existing, takeover))
    }

    /// A plugin installed again after its removal: its tombstone stands for the removed version,
    /// and the package must be signed as an update of it would be (the same key or one it was
    /// handed over to; an older version may come back). Only that unchanged signed key keeps the
    /// secrets of the kind's data sources: a removed unsigned plugin vouches for nobody, and a
    /// plugin removed before tombstones were kept has no known key, so with data sources left any
    /// reinstall of those (signed or unsigned) counts as a change. A change with data sources of
    /// the kind needs the administrator's confirmation, since their secrets would otherwise reach
    /// a binary nobody vouched for.
    async fn check_reinstall(
        &self,
        state: &AppState,
        m: &Manifest,
        key: Option<&VerifyingKey>,
        confirm: bool,
    ) -> ApiResult<Option<Takeover>> {
        let tombstone = store::tombstone(&state.db, &m.id).await?;
        let datasources = store::datasources_of_kind(&state.db, &m.id).await?;
        let changed = match &tombstone {
            Some(t) if t.public_key.is_some() => {
                let removed = Manifest { version: m.version.clone(), ..m.clone() };
                let old_key = t.public_key.as_deref().and_then(key_from_hex);
                let handovers = self.handovers(state, &m.id).await?;
                let installed = Installed { manifest: &removed, key: old_key.as_ref(), handovers: &handovers };
                // A stored key that no longer reads as one cannot vouch for anything.
                old_key.is_none()
                    || match signing::check_update(&installed, m, key) {
                        Ok(()) => false,
                        Err(signing::Refusal::KeyChanged) => true,
                        Err(r) => return Err(package::refusal(&r).api()),
                    }
            }
            // Unsigned, or unknown: nothing ties the new package to the removed one.
            _ => !datasources.is_empty(),
        };
        if !changed {
            return Ok(None);
        }
        let from_key = tombstone.as_ref().and_then(|t| t.public_key.clone());
        if !datasources.is_empty() && !confirm {
            let mut e = HostError::new(
                "plugin.publisher_changed",
                format!(
                    "this package is not signed with the key of the removed plugin {}; installing it clears the \
                     stored secrets of its {} data sources (repeat with confirmPublisherChange=true)",
                    m.id,
                    datasources.len()
                ),
            )
            .with("datasources", datasources.len());
            if let Some(previous) = from_key.as_deref().and_then(key_from_hex) {
                e = e.with("previousKeyId", signing::key_id(&previous));
            }
            if let Some(t) = &tombstone {
                e = e.with("removedVersion", &t.version);
            }
            return Err(e.api());
        }
        Ok(Some(Takeover {
            from_key,
            removed_version: tombstone.map(|t| t.version),
            installed_version: None,
            datasources,
        }))
    }

    /// A signed update of an unsigned installed plugin: nothing ties its key to whoever made the
    /// unsigned one, so it is a change of publisher like a reinstall with another key. It always
    /// needs the administrator's confirmation (the plugin is live, with or without data sources)
    /// and then clears the stored secrets of the kind's data sources.
    async fn check_signed_now(
        &self,
        state: &AppState,
        old: &PluginRow,
        m: &Manifest,
        confirm: bool,
    ) -> ApiResult<Takeover> {
        let datasources = store::datasources_of_kind(&state.db, &m.id).await?;
        if !confirm {
            return Err(HostError::new(
                "plugin.publisher_changed",
                format!(
                    "the installed plugin {} is unsigned and this update is signed; nothing ties the key to whoever \
                     made the installed one, and updating clears the stored secrets of its {} data sources \
                     (repeat with confirmPublisherChange=true)",
                    m.id,
                    datasources.len()
                ),
            )
            .with("datasources", datasources.len())
            .with("installedVersion", &old.version)
            .with("unsigned", true)
            .api());
        }
        Ok(Takeover {
            from_key: None,
            removed_version: None,
            installed_version: Some(old.version.clone()),
            datasources,
        })
    }

    /// The verified hand-overs kept for `id`.
    async fn handovers(&self, state: &AppState, id: &str) -> ApiResult<Vec<HandOver>> {
        Ok(store::handovers(&state.db, id)
            .await?
            .into_iter()
            .map(|h| HandOver {
                plugin_id: id.to_string(),
                from: h.from_key,
                to: h.to_key,
                from_version: h.from_version,
            })
            .collect())
    }

    /// Registers the plugin from its stored row, if it may run now.
    async fn reregister(&self, state: &AppState, id: &str) {
        let (row, keys) = match (store::get(&state.db, id).await, store::keys(&state.db).await) {
            (Ok(Some(row)), Ok(keys)) => (row, keys),
            _ => return,
        };
        if let Err(e) = self.register(&row, &keys, &state.datasources) {
            self.not_running(&state.db, Some(state.cluster.id()), &row, Some(e.reason), &e.message).await;
        }
    }

    async fn row(&self, state: &AppState, id: &str) -> ApiResult<PluginRow> {
        store::get(&state.db, id).await?.ok_or_else(|| HostError::new("plugin.not_installed", "no such plugin").api())
    }

    /// Approves the permissions of `version`: the installed version, or the update that waits.
    pub async fn approve(&self, state: &AppState, id: &str, version: &str, actor: &Actor<'_>) -> ApiResult<PluginRow> {
        let _changes = self.changes.lock().await;
        let old = self.row(state, id).await?;
        let now = state.clock.now_ms();
        let mut row = PluginRow { updated_at: now, ..old.clone() };
        let mut old_dir = None;
        let manifest_text = match &old.pending {
            Some(p) if p.version == version => {
                old_dir = Some(old.dir.clone());
                let m = manifest::parse(&p.manifest).map_err(|e| ApiError::internal("plugin manifest", e))?;
                if m.kind != old.kind {
                    // Refused at upload already; a stored update of another kind never runs.
                    return Err(package::refusal(&signing::Refusal::KindChanged).api());
                }
                row.name = m.name;
                row.kind = m.kind;
                row.version = p.version.clone();
                row.manifest = p.manifest.clone();
                row.signer = p.signer.clone();
                row.public_key = p.public_key.clone();
                row.dir = p.dir.clone();
                row.pending = None;
                row.approved = true;
                row.manifest.clone()
            }
            _ if !old.approved && old.version == version => {
                row.approved = true;
                row.manifest.clone()
            }
            _ if old.approved && old.version == version && old.pending.is_none() => {
                return Err(HostError::new("plugin.nothing_to_approve", "this version is approved already").api());
            }
            _ => {
                return Err(HostError::new(
                    "plugin.version_mismatch",
                    format!("version {version} is neither the installed version nor the update that waits"),
                )
                .with("version", version)
                .api());
            }
        };
        let m = manifest::parse(&manifest_text).map_err(|e| ApiError::internal("plugin manifest", e))?;
        let mut tx = crate::db::begin(&state.db).await?;
        store::put(&mut tx, &row, actor.user_id).await?;
        let summary = json!({ "version": version, "permissions": package::permission_lines(&m) });
        self.record(&mut tx, actor, "plugins.approved", id, summary, now).await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        self.unregister(id, &state.datasources).await;
        self.reregister(state, id).await;
        if let Some(dir) = old_dir {
            self.remove_package(&dir);
        }
        Ok(row)
    }

    /// Turns a plugin on or off. On needs the approval of its permissions.
    pub async fn set_enabled(
        &self,
        state: &AppState,
        id: &str,
        enabled: bool,
        actor: &Actor<'_>,
    ) -> ApiResult<PluginRow> {
        let _changes = self.changes.lock().await;
        let old = self.row(state, id).await?;
        if enabled && !old.approved {
            return Err(
                HostError::new("plugin.not_approved", "approve the plugin's permissions before enabling it").api()
            );
        }
        let now = state.clock.now_ms();
        let row = PluginRow { enabled, updated_at: now, ..old };
        let mut tx = crate::db::begin(&state.db).await?;
        store::put(&mut tx, &row, actor.user_id).await?;
        let action = if enabled { "plugins.enabled" } else { "plugins.disabled" };
        self.record(&mut tx, actor, action, id, json!({ "version": row.version }), now).await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        self.unregister(id, &state.datasources).await;
        if enabled {
            for warning in &self.exposed.warnings {
                tracing::warn!(plugin = %id, "{}", warning.message);
            }
            for path in &self.exposed.readable_by_plugins {
                tracing::error!(plugin = %id, "{path} holds secrets that plugins could read; plugins do not start until it is limited to SYSTEM, Administrators and the account Kalzit runs as");
            }
            self.reregister(state, id).await;
        }
        Ok(row)
    }

    /// Starts a stopped plugin again with a fresh count of failures (its next call starts it).
    pub async fn restart(&self, state: &AppState, id: &str, actor: &Actor<'_>) -> ApiResult<()> {
        let _changes = self.changes.lock().await;
        let row = self.row(state, id).await?;
        let Some(supervisor) = self.supervisor(id) else {
            return Err(HostError::new("plugin.not_running", "the plugin is not enabled or cannot run").api());
        };
        supervisor.stop(true).await;
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        self.record(&mut tx, actor, "plugins.restarted", id, json!({ "version": row.version }), now).await?;
        crate::db::commit(tx).await?;
        Ok(())
    }

    /// Removes a plugin: its kind, process, files and row. Its data sources stay and answer
    /// `datasource.kind_unavailable`; blocks of organizations, hand-overs and a tombstone with
    /// the version and key stay for a reinstall (`check_reinstall`).
    pub async fn remove(&self, state: &AppState, id: &str, actor: &Actor<'_>) -> ApiResult<()> {
        let _changes = self.changes.lock().await;
        let row = self.row(state, id).await?;
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        store::delete(&mut tx, &row, actor.user_id, now).await?;
        self.record(&mut tx, actor, "plugins.removed", id, json!({ "version": row.version }), now).await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        self.unregister(id, &state.datasources).await;
        self.remove_package(&row.dir);
        if let Some(p) = &row.pending {
            self.remove_package(&p.dir);
        }
        super::sandbox::remove_app_container(&self.dir("run"), id);
        Ok(())
    }

    /// Trusts a publisher key.
    pub async fn add_key(
        &self,
        state: &AppState,
        name: &str,
        public_key: &str,
        actor: &Actor<'_>,
    ) -> ApiResult<KeyRow> {
        let _changes = self.changes.lock().await;
        let key = package::parse_public_key(public_key).ok_or_else(|| {
            ApiError::validation("the key is not an Ed25519 public key (32 bytes, base64 or hex)")
                .with_field("publicKey")
                .because("plugin.key_invalid")
        })?;
        let hex_key = signing::key_hex(&key);
        let keys = store::keys(&state.db).await?;
        if keys.iter().any(|k| k.public_key == hex_key) {
            return Err(HostError::new("plugin.key_exists", "this key is trusted already").api());
        }
        let now = state.clock.now_ms();
        let row = KeyRow { key_id: signing::key_id(&key), public_key: hex_key, name: name.to_string(), added_at: now };
        let mut tx = crate::db::begin(&state.db).await?;
        store::add_key(&mut tx, &row, actor.user_id).await?;
        self.record(
            &mut tx,
            actor,
            "plugins.key_added",
            &row.key_id,
            json!({ "keyId": row.key_id, "name": name }),
            now,
        )
        .await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        // Plugins signed with it may run again.
        for p in store::all(&state.db).await? {
            if p.public_key.as_deref() == Some(row.public_key.as_str()) && self.supervisor(&p.id).is_none() {
                self.reregister(state, &p.id).await;
            }
        }
        Ok(row)
    }

    /// The plugins signed with a trusted key (installed or waiting as an update).
    pub async fn signed_with(&self, state: &AppState, key_id: &str) -> ApiResult<(KeyRow, Vec<String>)> {
        let keys = store::keys(&state.db).await?;
        let key = keys
            .into_iter()
            .find(|k| k.key_id == key_id)
            .ok_or_else(|| HostError::new("plugin.key_unknown", "no such key").api())?;
        let plugins = store::all(&state.db)
            .await?
            .into_iter()
            .filter(|p| {
                p.signer == "publisher" && p.public_key.as_deref() == Some(key.public_key.as_str())
                    || p.pending.as_ref().is_some_and(|x| x.public_key.as_deref() == Some(key.public_key.as_str()))
            })
            .map(|p| p.id)
            .collect();
        Ok((key, plugins))
    }

    /// Removes a trusted key. The plugins whose installed version it signed stop; updates it
    /// signed that wait for approval are dropped (their installed version keeps running). With
    /// either, the administrator must confirm (`confirm`), else `plugin.key_in_use` lists them.
    /// After a restart the same holds: a stopped plugin's key is no longer trusted, and the
    /// dropped updates are gone.
    pub async fn remove_key(
        &self,
        state: &AppState,
        key_id: &str,
        confirm: bool,
        actor: &Actor<'_>,
    ) -> ApiResult<Vec<String>> {
        let _changes = self.changes.lock().await;
        let (key, _) = self.signed_with(state, key_id).await?;
        let rows = store::all(&state.db).await?;
        let signed_by = |signer: &str, public_key: Option<&str>| {
            signer == "publisher" && public_key == Some(key.public_key.as_str())
        };
        let stopped: Vec<String> =
            rows.iter().filter(|p| signed_by(&p.signer, p.public_key.as_deref())).map(|p| p.id.clone()).collect();
        let dropped: Vec<&PluginRow> = rows
            .iter()
            .filter(|p| p.pending.as_ref().is_some_and(|x| signed_by(&x.signer, x.public_key.as_deref())))
            .collect();
        let dropped_ids: Vec<String> = dropped.iter().map(|p| p.id.clone()).collect();
        if (!stopped.is_empty() || !dropped.is_empty()) && !confirm {
            return Err(HostError::new(
                "plugin.key_in_use",
                format!(
                    "plugins signed with this key stop when it is removed: {}; updates dropped: {}",
                    stopped.join(", "),
                    dropped_ids.join(", ")
                ),
            )
            .with("plugins", stopped.join(","))
            .with("pending", dropped_ids.join(","))
            .api());
        }
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        store::remove_key(&mut tx, key_id).await?;
        let mut dirs = Vec::new();
        for p in &dropped {
            let mut row = (*p).clone();
            if let Some(pending) = row.pending.take() {
                dirs.push(pending.dir);
            }
            row.updated_at = now;
            store::put(&mut tx, &row, actor.user_id).await?;
        }
        let summary =
            json!({ "keyId": key.key_id, "name": key.name, "stopped": stopped, "droppedUpdates": dropped_ids });
        self.record(&mut tx, actor, "plugins.key_removed", key_id, summary, now).await?;
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        for id in &stopped {
            self.unregister(id, &state.datasources).await;
        }
        for dir in dirs {
            self.remove_package(&dir);
        }
        Ok(stopped)
    }

    /// Keeps a hand-over of `id` from one key to another, after checking its signature.
    pub async fn add_handover(&self, state: &AppState, id: &str, h: &HandOverRow, actor: &Actor<'_>) -> ApiResult<()> {
        let _changes = self.changes.lock().await;
        self.row(state, id).await?;
        let invalid = || HostError::new("plugin.handover_invalid", "the hand-over does not verify").api();
        let from = key_from_hex(&h.from_key).ok_or_else(invalid)?;
        let signature =
            hex::decode(&h.signature).ok().and_then(|b| Signature::from_slice(&b).ok()).ok_or_else(invalid)?;
        let statement = HandOver {
            plugin_id: id.to_string(),
            from: h.from_key.clone(),
            to: h.to_key.clone(),
            from_version: h.from_version.clone(),
        };
        if !signing::verify_handover(&from, &statement, &signature) {
            return Err(invalid());
        }
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        store::add_handover(&mut tx, id, h, now).await?;
        let summary = json!({
            "from": signing::key_id(&from),
            "to": key_from_hex(&h.to_key).map(|k| signing::key_id(&k)),
            "fromVersion": h.from_version,
        });
        self.record(&mut tx, actor, "plugins.handover_added", id, summary, now).await?;
        crate::db::commit(tx).await?;
        Ok(())
    }

    /// The host's switches: unsigned plugins, and plugins on a Linux host without Landlock.
    /// Each change is recorded on its own.
    pub async fn set_switches(&self, state: &AppState, new: store::HostSwitches, actor: &Actor<'_>) -> ApiResult<()> {
        let _changes = self.changes.lock().await;
        let old = store::switches(&state.db).await?;
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        store::set_switches(&mut tx, new, actor.user_id, now).await?;
        if old.allow_unsigned != new.allow_unsigned {
            let action = if new.allow_unsigned { "plugins.unsigned_allowed" } else { "plugins.unsigned_refused" };
            self.record(&mut tx, actor, action, "server", json!({ "allowUnsigned": new.allow_unsigned }), now).await?;
        }
        if old.allow_without_landlock != new.allow_without_landlock {
            let action =
                if new.allow_without_landlock { "plugins.landlock_optional" } else { "plugins.landlock_required" };
            let summary = json!({ "allowWithoutLandlock": new.allow_without_landlock });
            self.record(&mut tx, actor, action, "server", summary, now).await?;
        }
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        self.without_landlock.store(new.allow_without_landlock, Ordering::SeqCst);
        Ok(())
    }

    /// Blocks or unblocks an installed plugin for one organization.
    pub async fn set_blocked(&self, state: &AppState, id: &str, blocked: bool, actor: &Actor<'_>) -> ApiResult<bool> {
        let _changes = self.changes.lock().await;
        let org_id = actor.org_id.ok_or_else(|| ApiError::internal("plugin block", "no organization"))?;
        self.row(state, id).await?;
        let now = state.clock.now_ms();
        let mut tx = crate::db::begin(&state.db).await?;
        let changed = store::set_block(&mut tx, org_id, id, blocked, actor.user_id, now).await?;
        if changed {
            let action = if blocked { "plugins.blocked" } else { "plugins.unblocked" };
            self.record(&mut tx, actor, action, id, json!({}), now).await?;
        }
        crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::Plugins).await?;
        crate::db::commit(tx).await?;
        state.datasources.set_blocked(org_id, id, blocked);
        if blocked && let Some(supervisor) = self.supervisor(id) {
            // What the plugin was handed of this organization goes, with its open connections.
            let sources: Vec<(String,)> = sqlx::query_as("SELECT id FROM datasources WHERE org_id = $1 AND kind = $2")
                .bind(org_id)
                .bind(id)
                .fetch_all(&state.db)
                .await?;
            for (source,) in sources {
                supervisor.grants().revoke(&source);
            }
        }
        Ok(changed)
    }

    /// Whether `row` may run now, and why not.
    pub async fn trust_state(&self, state: &AppState, row: &PluginRow) -> ApiResult<bool> {
        let keys = store::keys(&state.db).await?;
        Ok(self.still_trusted(&row.signer, row.public_key.as_deref(), &keys))
    }

    pub fn status(&self, id: &str) -> Option<Status> {
        self.supervisor(id).map(|s| s.status())
    }

    /// Takes the plugin changes another server on the same database made (`cluster`): the blocks
    /// and switches, and which plugins run. A plugin no longer runnable, or now from another
    /// package, stops; one that may run starts, its package unpacked first from the copy the
    /// installing server shared (`plugin_packages`) when it is not here yet.
    ///
    /// Answers whether everything that may run here runs: `false` when a package could not be
    /// unpacked or a plugin not registered, and the caller tries again later (`cluster`).
    pub async fn sync(&self, state: &AppState) -> ApiResult<bool> {
        let _changes = self.changes.lock().await;
        // Newly blocked organizations: what the plugin was handed of their sources goes, with
        // its open connections, as on the server where the block was set (`set_blocked`).
        let before: std::collections::HashSet<(String, String)> = state.datasources.blocks().into_iter().collect();
        let blocks = store::blocks(&state.db).await?;
        let added: Vec<(String, String)> = blocks.iter().filter(|b| !before.contains(*b)).cloned().collect();
        state.datasources.set_blocks(blocks);
        for (org_id, plugin_id) in added {
            if let Some(supervisor) = self.supervisor(&plugin_id) {
                let sources: Vec<(String,)> =
                    sqlx::query_as("SELECT id FROM datasources WHERE org_id = $1 AND kind = $2")
                        .bind(&org_id)
                        .bind(&plugin_id)
                        .fetch_all(&state.db)
                        .await?;
                for (source,) in sources {
                    supervisor.grants().revoke(&source);
                }
            }
        }
        let switches = store::switches(&state.db).await?;
        self.without_landlock.store(switches.allow_without_landlock, Ordering::SeqCst);
        let rows = store::all(&state.db).await?;
        let keys = store::keys(&state.db).await?;
        let registered = self.registered.lock_or_recover().clone();
        for (id, dir) in &registered {
            let keep = rows.iter().any(|r| {
                &r.id == id
                    && &r.dir == dir
                    && r.approved
                    && r.enabled
                    && self.still_trusted(&r.signer, r.public_key.as_deref(), &keys)
            });
            if !keep {
                self.unregister(id, &state.datasources).await;
            }
        }
        // Read again: what was just stopped (an update, an approval) starts from its new package.
        let registered = self.registered.lock_or_recover().clone();
        let mut complete = true;
        for row in rows.iter().filter(|r| r.approved && r.enabled && !registered.contains_key(&r.id)) {
            if row.signer == "unsigned" && !switches.allow_unsigned {
                tracing::warn!(plugin = %row.id, "the plugin is unsigned and unsigned plugins are not allowed; it does not run on this server");
                continue;
            }
            let server = Some(state.cluster.id());
            if let Err(e) = self.materialize(state, row, &keys, switches.allow_unsigned).await {
                let reason = e.reason.as_ref().map(|r| r.code.as_str());
                self.not_running(&state.db, server, row, reason, &e.message).await;
                complete = false;
                continue;
            }
            if let Err(e) = self.register(row, &keys, &state.datasources) {
                self.not_running(&state.db, server, row, Some(e.reason), &e.message).await;
                complete = false;
            }
        }
        // Packages no plugin refers to any more (an update or removal on another server).
        let wanted: std::collections::HashSet<&str> = rows
            .iter()
            .flat_map(|r| std::iter::once(r.dir.as_str()).chain(r.pending.as_ref().map(|p| p.dir.as_str())))
            .collect();
        if let Ok(entries) = std::fs::read_dir(self.dir("packages")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let base = name.strip_suffix(COMPLETE_SUFFIX).unwrap_or(&name);
                if wanted.contains(base) {
                    continue;
                }
                if name.ends_with(COMPLETE_SUFFIX) {
                    let _ = std::fs::remove_file(entry.path());
                } else if entry.file_type().is_ok_and(|t| t.is_dir()) {
                    remove_dir(&entry.path());
                }
            }
        }
        Ok(complete)
    }

    /// Why the plugin of `row` does not run here. A refused package (`is_refusal`) is logged as
    /// an error and recorded in the audit log as `plugins.package_refused`, once per package
    /// directory and reason; anything else (a missing package, a file or database error) may pass
    /// and is only logged, and the caller tries again.
    async fn not_running(
        &self,
        db: &sqlx::AnyPool,
        server: Option<&str>,
        row: &PluginRow,
        reason: Option<&str>,
        message: &str,
    ) {
        let Some(reason) = reason.filter(|r| is_refusal(r)) else {
            tracing::warn!(plugin = %row.id, reason, "the plugin does not run on this server: {message}");
            return;
        };
        tracing::error!(plugin = %row.id, reason, "the plugin's package is refused: {message}");
        if !self.refused.lock_or_recover().insert((row.dir.clone(), reason.to_string())) {
            return;
        }
        let at_ms =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        let event = AuditEvent {
            org_id: None,
            actor_user_id: None,
            actor_address: None,
            action: "plugins.package_refused",
            resource_type: Some("plugin"),
            resource_id: Some(&row.id),
            summary: json!({ "reason": reason, "version": row.version, "server": server }),
            at_ms,
        };
        let recorded = async {
            let mut tx = crate::db::begin(db).await?;
            audit::record(&mut tx, &event).await?;
            crate::db::commit(tx).await?;
            Ok::<_, ApiError>(())
        };
        if let Err(e) = recorded.await {
            tracing::warn!(plugin = %row.id, "the refused plugin package could not be recorded: {}", e.message);
        }
    }

    /// Unpacks the shared package `row.dir` when this server does not have it, with the checks
    /// of an installation: the archive must match the SHA-256 stored with it, its manifest must
    /// be exactly the one the installing server checked and stored, its signature must verify
    /// with a key this server trusts (`package::verify`) and be the signer and key stored with
    /// the plugin, and every file must be as the manifest lists it. It is unpacked into a
    /// temporary directory and renamed into place only once checked, then marked complete
    /// (`<dir>.complete`); a directory without the mark is unpacked again.
    async fn materialize(
        &self,
        state: &AppState,
        row: &PluginRow,
        keys: &[KeyRow],
        allow_unsigned: bool,
    ) -> ApiResult<()> {
        let (id, dir_name, manifest_text) = (row.id.as_str(), row.dir.as_str(), row.manifest.as_str());
        let dir = self.package_path(dir_name).map_err(HostError::api)?;
        let mark = self.dir("packages").join(format!("{dir_name}{COMPLETE_SUFFIX}"));
        let shared: Option<(String, String)> =
            sqlx::query_as("SELECT archive, sha256 FROM plugin_packages WHERE dir = $1")
                .bind(dir_name)
                .fetch_optional(&state.db)
                .await?;
        if dir.exists() {
            // Complete, or installed here before shared copies existed.
            if mark.exists() || shared.is_none() {
                return Ok(());
            }
            remove_dir(&dir);
        }
        let Some((archive, sha256)) = shared else {
            return Err(HostError::new("plugin.package_missing", "no server shared the package").api());
        };
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, archive.as_bytes())
            .map_err(|_| HostError::new("plugin.package_unreadable", "the shared package is not valid base64").api())?;
        // Before anything is written: the archive is the one the installing server shared.
        let digest = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes));
        if !digest.eq_ignore_ascii_case(sha256.trim()) {
            return Err(HostError::new(
                "plugin.package_hash_mismatch",
                "the shared package does not match the SHA-256 stored with it",
            )
            .api());
        }
        self.prepare().map_err(|e| HostError::from(e).api())?;
        let upload = self.upload_path().map_err(|e| e.api())?;
        let partial = self.dir("packages").join(format!(".partial-{dir_name}"));
        remove_dir(&partial);
        let unpacked = async {
            tokio::fs::write(&upload, &bytes).await.map_err(|e| HostError::from(e).api())?;
            // The manifest and the signature as the archive holds them, checked as at the
            // installation before a file is unpacked.
            let path = upload.clone();
            let signed = tokio::task::spawn_blocking(move || package::read_from_zip(&path))
                .await
                .map_err(|e| ApiError::internal("plugin package", e))?
                .map_err(HostError::api)?;
            if signed.manifest_text != manifest_text {
                return Err(manifest_differs().api());
            }
            let verified = package::verify(&signed, &self.trusted(keys), allow_unsigned).map_err(HostError::api)?;
            let key_hex = verified.key.as_ref().map(signing::key_hex);
            if signer_name(verified.signer) != row.signer || key_hex != row.public_key {
                return Err(HostError::new(
                    "plugin.signer_mismatch",
                    "the shared package is signed by another key than the one recorded at the installation",
                )
                .api());
            }
            let manifest = &signed.manifest;
            let is_panel = manifest.plugin_kind() == manifest::PluginKind::Panel;
            let access = if is_panel { PluginAccess::None } else { PluginAccess::ReadExecute(package::plugin_sid(id)) };
            package::private_dir(&partial, &access).map_err(|e| HostError::from(e).api())?;
            let (archive, into) = (upload.clone(), partial.clone());
            let unpacked = tokio::task::spawn_blocking(move || package::unpack(&archive, &into))
                .await
                .map_err(|e| ApiError::internal("plugin unpack", e))?
                .map_err(HostError::api)?;
            if unpacked.manifest_text != manifest_text {
                return Err(manifest_differs().api());
            }
            if is_panel {
                panels::check_bundle(&unpacked.manifest, &partial).map_err(HostError::api)?;
            } else {
                let program = package::binary(&unpacked.manifest, &partial).map_err(HostError::api)?;
                package::make_executable(&program).map_err(|e| HostError::from(e).api())?;
            }
            std::fs::rename(&partial, &dir).map_err(|e| HostError::from(e).api())?;
            write_complete_mark(&mark).map_err(|e| HostError::from(e).api())?;
            Ok(())
        }
        .await;
        let _ = std::fs::remove_file(&upload);
        if unpacked.is_err() {
            remove_dir(&partial);
        }
        unpacked
    }
}

fn manifest_differs() -> HostError {
    HostError::new("plugin.package_invalid", "the manifest differs from the one installed").with("issues", "manifest")
}

/// Whether `reason` refuses a package for what it is: tampered, damaged, in the wrong place,
/// signed by another or an untrusted key. Not a passing failure (a missing package, a file or
/// database error), which is tried again and not recorded as a refusal.
fn is_refusal(reason: &str) -> bool {
    matches!(
        reason,
        "plugin.package_hash_mismatch"
            | "plugin.package_dir_invalid"
            | "plugin.signer_mismatch"
            | "plugin.unsigned_refused"
            | "plugin.signer_untrusted"
            | "plugin.signature_invalid"
            | "plugin.package_invalid"
            | "plugin.package_unreadable"
            | "plugin.package_too_large"
            | "plugin.manifest_missing"
            | "plugin.manifest_invalid"
            | "plugin.id_reserved"
    )
}

/// Whether `name` is a package directory name as `install` makes them: a UUID in its simple
/// form, 32 lowercase hex digits. No separator, no `..`, nothing that leaves `packages`.
fn is_package_dir_name(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The mark next to a package directory that says it was unpacked and checked in full.
const COMPLETE_SUFFIX: &str = ".complete";

fn write_complete_mark(mark: &Path) -> std::io::Result<()> {
    std::fs::write(mark, b"")
}

/// Keeps the uploaded package in the database, in the installation's transaction, for the other
/// servers on the same database (`PluginHost::materialize`).
async fn share_package(
    tx: &mut sqlx::Transaction<'static, sqlx::Any>,
    archive: &Path,
    dir: &str,
    now_ms: i64,
) -> ApiResult<()> {
    let bytes = tokio::fs::read(archive).await.map_err(|e| HostError::from(e).api())?;
    let sha = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&bytes));
    let text = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    sqlx::query("INSERT INTO plugin_packages (dir, archive, sha256, created_at) VALUES ($1, $2, $3, $4)")
        .bind(dir)
        .bind(text)
        .bind(sha)
        .bind(now_ms)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn datasources_has_kind(datasources: &DataSources, id: &str) -> bool {
    datasources.registry().get(id).is_some()
}

/// Removes a directory and everything in it. A process that just ended may still hold a file
/// on Windows for a moment, so a failure is tried again for a few seconds, then logged.
fn remove_dir(dir: &Path) {
    // A package's mark of completeness goes first: a half-removed package never counts as whole.
    let mut mark = dir.as_os_str().to_owned();
    mark.push(COMPLETE_SUFFIX);
    let _ = std::fs::remove_file(mark);
    if !dir.exists() || std::fs::remove_dir_all(dir).is_ok() {
        return;
    }
    let dir = dir.to_path_buf();
    let shown = dir.display().to_string();
    let retry = async move {
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
        }
        tracing::warn!("the plugin directory {} could not be removed", dir.display());
    };
    match tokio::runtime::Handle::try_current() {
        Ok(rt) => {
            rt.spawn(retry);
        }
        Err(_) => tracing::warn!("the plugin directory {shown} could not be removed"),
    }
}

/// Removes what a directory holds (left from the last run).
fn clear_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let removed = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
            if let Err(e) = removed {
                tracing::warn!("removing {}: {e}", path.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row whose stored kind differs from its manifest (an update of 0.4.0 that changed the
    /// kind) is refused with its own reason; a matching one passes.
    #[test]
    fn a_stored_kind_that_differs_from_the_manifest_is_refused() {
        let manifest = manifest::parse(
            r#"
manifest = 1
id = "dev.example.tile"
name = "Kachel"
version = "1.1.0"
kind = "panel"
min_kalzit = "0.1.0"
shapes = ["frame"]

[panel]
path = "dist/panel.js"
api = 1

[files]
"dist/panel.js" = "0000000000000000000000000000000000000000000000000000000000000000"
"#,
        )
        .unwrap();
        let row = PluginRow {
            id: "dev.example.tile".into(),
            name: "Kachel".into(),
            version: "1.1.0".into(),
            kind: "datasource".into(),
            manifest: String::new(),
            signer: "publisher".into(),
            public_key: None,
            dir: String::new(),
            approved: true,
            enabled: true,
            pending: None,
            installed_at: 0,
            updated_at: 0,
        };
        let e = check_kind(&row, &manifest).unwrap_err();
        assert_eq!(e.reason, "plugin.kind_changed");
        let fixed = PluginRow { kind: "panel".into(), ..row };
        assert!(check_kind(&fixed, &manifest).is_ok());
    }

    #[test]
    fn only_generated_package_dir_names_are_accepted() {
        let host = PluginHost::new(Path::new("data"));
        let name = format!("{}", uuid::Uuid::now_v7().simple());
        assert!(is_package_dir_name(&name));
        assert_eq!(host.package_path(&name).unwrap(), host.dir("packages").join(&name));
        for bad in [
            "",
            "..",
            "../0123456789abcdef0123456789abcdef",
            "0123456789abcdef0123456789abcde/",
            "0123456789ABCDEF0123456789ABCDEF",
            "0123456789abcdef0123456789abcdef0",
            "..\\0123456789abcdef0123456789abc",
            "/etc",
        ] {
            assert!(!is_package_dir_name(bad), "{bad}");
            assert_eq!(host.package_path(bad).unwrap_err().reason, "plugin.package_dir_invalid", "{bad}");
        }
    }

    #[test]
    fn secrets_in_a_configuration_are_recognized() {
        assert!(holds_secrets("[database]\nurl = \"postgres://kalzit:geheim@db/kalzit\"\n"));
        assert!(holds_secrets("[mail]\nsmtp_password = \"x\"\n"));
        assert!(!holds_secrets("[database]\nurl = \"postgres://db/kalzit\"\n[server]\nhttp_addr = \"0.0.0.0:3000\"\n"));
        assert!(!holds_secrets("[mail]\nsmtp_password = \"\"\n"));
    }

    #[cfg(windows)]
    #[test]
    fn readable_files_with_secrets_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let me = crate::data_dir::acl::current_user().unwrap();
        let file = dir.path().join("kalzit.toml");
        std::fs::write(&file, "[database]\nurl = \"postgres://kalzit:geheim@db/kalzit\"\n").unwrap();
        crate::data_dir::acl::restrict(&file, &format!("D:P(A;;FA;;;SY)(A;;FA;;;{me})(A;;0x1200a9;;;BU)")).unwrap();
        let config = crate::config::Config { config_file: Some(file.clone()), ..Default::default() };
        let found = exposed_secrets(&config);
        assert_eq!((found.warnings.len(), found.readable_by_plugins.len()), (1, 0), "{found:?}");
        assert_eq!(found.warnings[0].params["accounts"], "Users", "{found:?}");
        // Users and all AppContainers, as under Program Files: plugins could read it.
        crate::data_dir::acl::restrict(
            &file,
            &format!("D:P(A;;FA;;;SY)(A;;FA;;;{me})(A;;0x1200a9;;;BU)(A;;0x1200a9;;;AC)"),
        )
        .unwrap();
        let found = exposed_secrets(&config);
        assert_eq!(found.readable_by_plugins.len(), 1, "{found:?}");
        crate::data_dir::acl::restrict(&file, &format!("D:P(A;;FA;;;SY)(A;;FA;;;{me})")).unwrap();
        let found = exposed_secrets(&config);
        assert!(found.warnings.is_empty() && found.readable_by_plugins.is_empty(), "{found:?}");
    }

    #[test]
    fn who_may_read_a_file_is_judged_like_a_plugin_token() {
        let entries = |list: &[(&str, u32)]| list.iter().map(|(s, m)| (s.to_string(), *m)).collect::<Vec<_>>();
        assert_eq!(judge(None), Judged::Plugins);
        assert_eq!(judge(Some(&entries(&[("S-1-5-18", 0x1f01ff)]))), Judged::Closed);
        assert_eq!(judge(Some(&entries(&[("S-1-5-32-545", 0x1200a9)]))), Judged::LocalAccounts(vec!["Users"]));
        assert_eq!(judge(Some(&entries(&[("S-1-15-2-1", 0x1200a9)]))), Judged::Closed, "AppContainers alone");
        for container in ["S-1-15-2-1", "S-1-15-2-2"] {
            for wide in ["S-1-1-0", "S-1-5-32-545", "S-1-5-12"] {
                let list = entries(&[(wide, 0x1200a9), (container, 0x1200a9)]);
                assert_eq!(judge(Some(&list)), Judged::Plugins, "{wide} {container}");
            }
        }
        // Write only is no reading.
        assert_eq!(judge(Some(&entries(&[("S-1-5-32-545", 0x2), ("S-1-15-2-1", 0x2)]))), Judged::Closed);
    }
}
