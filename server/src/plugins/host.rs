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
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use ed25519_dalek::{Signature, VerifyingKey};
use kalzit_plugin_api::manifest::{self, Manifest};
use kalzit_plugin_api::signing::{self, HandOver, Installed, Signer};
use serde::Serialize;
use serde_json::{Value, json};

use super::package::{self, PluginAccess, TrustedKey, Verified};
use super::remote::Remote;
use super::store::{self, HandOverRow, KeyRow, Pending, PluginRow};
use super::supervisor::{Options, Status, Supervisor};
use super::{HostError, intern};
use crate::app::AppState;
use crate::audit::{self, AuditEvent};
use crate::datasources::registry::Origin;
use crate::datasources::{DataSources, DefaultValue, Kind, SettingField, SettingType};
use crate::error::{ApiError, ApiResult};

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

fn key_from_hex(text: &str) -> Option<VerifyingKey> {
    let bytes = <[u8; 32]>::try_from(hex::decode(text).ok()?).ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

/// A reinstall whose key differs from the one that signed the removed plugin of the same id
/// (or whose former key is unknown), confirmed by the administrator where it matters.
struct Takeover {
    /// The key that signed the removed plugin, if it was signed and is known.
    from_key: Option<String>,
    removed_version: Option<String>,
    /// The data sources of the kind, whose stored secrets are cleared.
    datasources: Vec<String>,
}

/// Settings forms by plugin id and version.
type Forms = HashMap<(String, String), &'static [SettingField]>;

/// The settings form of a plugin kind, built once per plugin version.
fn settings_form(m: &Manifest) -> &'static [SettingField] {
    static FORMS: LazyLock<Mutex<Forms>> = LazyLock::new(Mutex::default);
    let mut forms = FORMS.lock().unwrap_or_else(|e| e.into_inner());
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
    running: Mutex<HashMap<String, Arc<Supervisor>>>,
    /// Serializes the administrator's changes.
    changes: tokio::sync::Mutex<()>,
    /// Plugins may run on a Linux host without Landlock (`allowWithoutLandlock`).
    without_landlock: Arc<AtomicBool>,
}

impl PluginHost {
    /// The host on `<data_dir>/plugins`. Nothing runs until `load`.
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("plugins"),
            options: RwLock::new(Options::default()),
            kalzit_keys: RwLock::new(package::kalzit_keys()),
            running: Mutex::default(),
            changes: tokio::sync::Mutex::new(()),
            without_landlock: Arc::default(),
        }
    }

    /// Changes the supervision times and limits for plugins started from now on (tests).
    pub fn set_options(&self, options: Options) {
        *self.options.write().unwrap_or_else(|e| e.into_inner()) = options;
    }

    /// Trusts `key` as Kalzit's own plugin key (tests; builds name theirs at build time).
    pub fn trust_kalzit_key(&self, key: VerifyingKey) {
        self.kalzit_keys.write().unwrap_or_else(|e| e.into_inner()).push(key);
    }

    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
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
        datasources.set_blocks(store::blocks(db).await?);
        self.without_landlock.store(store::switches(db).await?.allow_without_landlock, Ordering::SeqCst);
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
            if let Err(e) = self.register(&row, &keys, datasources) {
                tracing::warn!(plugin = %row.id, reason = e.reason, "the plugin does not run: {}", e.message);
            }
        }
        Ok(())
    }

    fn trusted(&self, keys: &[KeyRow]) -> Vec<TrustedKey> {
        let kalzit = self.kalzit_keys.read().unwrap_or_else(|e| e.into_inner());
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

    /// Whether the key that signed `row` is still trusted.
    fn still_trusted(&self, signer: &str, public_key: Option<&str>, keys: &[KeyRow]) -> bool {
        match signer {
            "unsigned" => true,
            "kalzit" => {
                let kalzit = self.kalzit_keys.read().unwrap_or_else(|e| e.into_inner());
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
        manifest.runs_on(env!("CARGO_PKG_VERSION")).map_err(|i| HostError::new("plugin.kalzit_too_old", i.message))?;
        let package_dir = self.dir("packages").join(&row.dir);
        let program = package::binary(&manifest, &package_dir)?;
        let launch = super::supervisor::Launch {
            manifest: Arc::new(manifest),
            program,
            package_dir,
            run_root: self.dir("run"),
            allow_without_landlock: self.without_landlock.clone(),
        };
        let options = self.options.read().unwrap_or_else(|e| e.into_inner()).clone();
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
        self.running.lock().unwrap_or_else(|e| e.into_inner()).insert(row.id.clone(), supervisor);
        Ok(true)
    }

    /// Takes the plugin's kind out of the registry and ends its process. Running queries finish
    /// on the kind they hold; new ones answer `datasource.kind_unavailable`.
    async fn unregister(&self, id: &str, datasources: &DataSources) {
        let _ = datasources.registry().unregister(id);
        let supervisor = self.running.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        if let Some(s) = supervisor {
            s.shutdown().await;
        }
    }

    /// Ends every plugin process (Kalzit stops).
    pub async fn shutdown(&self) {
        let all: Vec<Arc<Supervisor>> =
            self.running.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        for s in all {
            s.shutdown().await;
        }
    }

    pub fn supervisor(&self, id: &str) -> Option<Arc<Supervisor>> {
        self.running.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned()
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
        crate::db::commit(tx).await?;
        for id in &cleared {
            state.datasources.forget(id);
        }
        if action == "plugins.updated" {
            self.unregister(&row.id, &state.datasources).await;
            self.reregister(state, &row.id).await;
        }
        for old in old_dirs {
            remove_dir(&self.dir("packages").join(old));
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
        if m.plugin_kind() != manifest::PluginKind::DataSource {
            return Err(HostError::new("plugin.kind_unsupported", "panel plugins cannot be installed yet").api());
        }
        m.runs_on(env!("CARGO_PKG_VERSION"))
            .map_err(|i| HostError::new("plugin.kalzit_too_old", i.message).with("minKalzit", &m.min_kalzit).api())?;
        let program = package::binary(m, dir).map_err(HostError::api)?;
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
        // Only the plugin itself (its SID) may read and run its package.
        package::private_dir(dir, &PluginAccess::ReadExecute(package::plugin_sid(&m.id)))
            .map_err(|e| HostError::from(e).api())?;
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
        package::make_executable(&program).map_err(|e| HostError::from(e).api())?;
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
        Ok(Some(Takeover { from_key, removed_version: tombstone.map(|t| t.version), datasources }))
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
            tracing::warn!(plugin = %id, reason = e.reason, "the plugin does not run: {}", e.message);
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
                row.name = m.name;
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
        crate::db::commit(tx).await?;
        self.unregister(id, &state.datasources).await;
        self.reregister(state, id).await;
        if let Some(dir) = old_dir {
            remove_dir(&self.dir("packages").join(dir));
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
        crate::db::commit(tx).await?;
        self.unregister(id, &state.datasources).await;
        if enabled {
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
        crate::db::commit(tx).await?;
        self.unregister(id, &state.datasources).await;
        remove_dir(&self.dir("packages").join(&row.dir));
        if let Some(p) = &row.pending {
            remove_dir(&self.dir("packages").join(&p.dir));
        }
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
        crate::db::commit(tx).await?;
        for id in &stopped {
            self.unregister(id, &state.datasources).await;
        }
        for dir in dirs {
            remove_dir(&self.dir("packages").join(dir));
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
        crate::db::commit(tx).await?;
        state.datasources.set_blocked(org_id, id, blocked);
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
}

fn datasources_has_kind(datasources: &DataSources, id: &str) -> bool {
    datasources.registry().get(id).is_some()
}

/// Removes a directory and everything in it. A process that just ended may still hold a file
/// on Windows for a moment, so a failure is tried again for a few seconds, then logged.
fn remove_dir(dir: &Path) {
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
