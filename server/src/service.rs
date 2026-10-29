//! Kalzit as a Windows service (docs/guide/installation.md, "Windows"; docs/ARCHITECTURE.md,
//! "Running as a service").
//!
//! - `kalzit service run` is what the service manager starts. It reports the service's state,
//!   stops the server gracefully on Stop (and with the short grace on a system shutdown) and
//!   writes the log to `<data dir>\logs\kalzit.log`; what goes wrong before that file is open
//!   goes to the Windows event log (Application, source `Kalzit`).
//! - `kalzit service install` and `uninstall` set the service up and remove it, for installations
//!   without the MSI package. `kalzit service configure` and `cleanup` are the steps both share
//!   with the MSI package (packaging/windows), which creates and removes the service itself.
//!
//! The service runs as the virtual account `NT SERVICE\Kalzit`. Its data directory belongs to
//! the Administrators group, and only Administrators and the service account have access. With
//! self-update on (the default), the service account may also change the program folder, so the
//! updater can swap the binary; a handover or a return ends the service with a restart request
//! (`RESTART_EXIT`), and the recovery actions set here make the service manager start it again,
//! which runs the binary now at the service's path.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// The service's name, display name and event log source.
pub const SERVICE_NAME: &str = "Kalzit";
/// The virtual account the service runs as.
pub const ACCOUNT: &str = r"NT SERVICE\Kalzit";
/// The name of the inbound firewall rule the installer may add.
pub const FIREWALL_RULE: &str = "Kalzit";
/// The service-specific exit code with which the service asks to be started again (an update
/// or the return from one). Every other failure ends with `FAILURE_EXIT`.
pub const RESTART_EXIT: u32 = 3;
pub const FAILURE_EXIT: u32 = 1;
const DEFAULT_PORT: u16 = 3000;
const DEFAULT_HTTPS_PORT: u16 = 3443;

/// The settings of `kalzit service install` and `configure`. Every value is a string, so the MSI
/// package can pass its properties as they are (an unset property is an empty string).
#[derive(clap::Args, Debug, Clone, Default)]
pub struct ServiceOptions {
    /// Folder for Kalzit's data [default: %ProgramData%\Kalzit\data].
    #[arg(long, value_name = "FOLDER")]
    pub data_dir: Option<String>,
    /// Port of the plain HTTP listener [default: 3000].
    #[arg(long)]
    pub port: Option<String>,
    /// HTTPS: off, self-signed (a certificate made for this computer) or certificate (your own
    /// PEM files, --cert-file and --key-file) [default: off].
    #[arg(long, value_name = "MODE")]
    pub https: Option<String>,
    /// Port of the HTTPS listener [default: 3443].
    #[arg(long)]
    pub https_port: Option<String>,
    /// Certificate chain (PEM) for --https certificate.
    #[arg(long, value_name = "FILE")]
    pub cert_file: Option<String>,
    /// Private key (PEM) for --https certificate.
    #[arg(long, value_name = "FILE")]
    pub key_file: Option<String>,
    /// Open the ports in Windows Defender Firewall (inbound rule "Kalzit").
    #[arg(long, value_name = "1|0", num_args = 0..=1, default_missing_value = "1")]
    pub open_firewall: Option<String>,
    /// Let the service account replace the program file, so updates install on their own
    /// [default: 1].
    #[arg(long, value_name = "1|0", num_args = 0..=1, default_missing_value = "1")]
    pub self_update: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Https {
    Off,
    SelfSigned,
    Certificate { cert: PathBuf, key: PathBuf },
}

/// What `configure` sets up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub config: PathBuf,
    pub data_dir: PathBuf,
    pub port: u16,
    pub https: Https,
    pub https_port: u16,
    pub open_firewall: bool,
    pub self_update: bool,
}

/// A value as the MSI package passes it: empty means unset. A Windows command line turns a
/// quoted path that ends in a backslash (`"C:\data\"`) into one that ends in a quote, which no
/// path does.
fn value(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(|s| s.trim().trim_end_matches('"').trim()).filter(|s| !s.is_empty())
}

fn flag(v: &Option<String>, default: bool) -> Result<bool> {
    match value(v) {
        None => Ok(default),
        Some("1" | "yes" | "true") => Ok(true),
        Some("0" | "no" | "false") => Ok(false),
        Some(other) => bail!("expected 1 or 0, not {other:?}"),
    }
}

fn parse_port(v: &Option<String>, default: u16, name: &str) -> Result<u16> {
    match value(v) {
        None => Ok(default),
        Some(text) => match text.parse::<u16>() {
            Ok(p) if p > 0 => Ok(p),
            _ => bail!("{name} must be a port number from 1 to 65535, not {text:?}"),
        },
    }
}

impl ServiceOptions {
    /// The settings, with `config` as the configuration file and `default_data_dir` where no
    /// folder is given.
    pub fn settings(&self, config: PathBuf, default_data_dir: Option<PathBuf>) -> Result<Settings> {
        let data_dir = match value(&self.data_dir) {
            Some(dir) => PathBuf::from(dir),
            None => default_data_dir.context("there is no default data folder; pass --data-dir")?,
        };
        if !data_dir.is_absolute() {
            bail!("the data folder must be an absolute path, not {}", data_dir.display());
        }
        let port = parse_port(&self.port, DEFAULT_PORT, "--port")?;
        let https_port = parse_port(&self.https_port, DEFAULT_HTTPS_PORT, "--https-port")?;
        let https = match value(&self.https).unwrap_or("off") {
            "off" => Https::Off,
            "self-signed" => Https::SelfSigned,
            "certificate" => {
                let (Some(cert), Some(key)) = (value(&self.cert_file), value(&self.key_file)) else {
                    bail!("--https certificate needs --cert-file and --key-file");
                };
                Https::Certificate { cert: PathBuf::from(cert), key: PathBuf::from(key) }
            }
            other => bail!("--https must be off, self-signed or certificate, not {other:?}"),
        };
        if https != Https::Off && https_port == port {
            bail!("HTTP and HTTPS need different ports (both are {port})");
        }
        Ok(Settings {
            config,
            data_dir,
            port,
            https,
            https_port,
            open_firewall: flag(&self.open_firewall, false)?,
            self_update: flag(&self.self_update, true)?,
        })
    }
}

/// A TOML string for `text` (quoted and escaped).
fn toml_string(text: &str) -> String {
    toml::Value::String(text.to_string()).to_string()
}

/// The configuration file the installer writes. `tls` is the certificate and key in use when
/// HTTPS is on.
pub fn config_toml(s: &Settings, tls: Option<(&Path, &Path)>) -> String {
    let mut text = String::from(
        "# Kalzit configuration, written by the installer. Kalzit reads it at start; restart the\n\
         # service \"Kalzit\" after a change. All settings: docs/guide/installation.md and the README.\n\n\
         [server]\n",
    );
    text.push_str(&format!("http_addr = {}\n", toml_string(&format!("0.0.0.0:{}", s.port))));
    if let Some((cert, key)) = tls {
        text.push_str(&format!("https_addr = {}\n", toml_string(&format!("0.0.0.0:{}", s.https_port))));
        text.push_str(&format!(
            "\n[tls]\ncert_file = {}\nkey_file = {}\n",
            toml_string(&cert.to_string_lossy()),
            toml_string(&key.to_string_lossy())
        ));
    }
    text.push_str(&format!("\n[paths]\ndata_dir = {}\n", toml_string(&s.data_dir.to_string_lossy())));
    text
}

/// Files and folders only Kalzit puts into a data directory; one of them (or an empty folder)
/// shows that a folder is Kalzit's before an uninstallation removes it.
const DATA_MARKERS: &[&str] = &["kalzit.db", "secrets.key.dpapi", "secrets.key", "updates", "setup-token.txt"];

/// Whether `dir` may be removed as Kalzit's data directory: an absolute folder below a drive or
/// share root that is empty or holds Kalzit's data. A data directory set to `D:\` or a folder
/// with other files in it is left alone.
pub fn removable_data_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!("{} is not an absolute path", dir.display()));
    }
    if dir.parent().is_none() || dir.components().filter(|c| matches!(c, std::path::Component::Normal(_))).count() == 0
    {
        return Err(format!("{} is a drive or share root", dir.display()));
    }
    let entries: Vec<String> = match std::fs::read_dir(dir) {
        Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        Err(e) => return Err(format!("{} cannot be read: {e}", dir.display())),
    };
    if entries.is_empty() || entries.iter().any(|e| DATA_MARKERS.contains(&e.as_str())) {
        Ok(())
    } else {
        Err(format!("{} does not look like Kalzit's data folder", dir.display()))
    }
}

#[cfg(windows)]
pub use windows_impl::*;

#[cfg(windows)]
mod windows_impl {
    use std::ffi::{OsStr, OsString};
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::ExitCode;
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use anyhow::{Context, Result, bail};
    use sha1::{Digest, Sha1};
    use windows_service::service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept, ServiceErrorControl,
        ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType, ServiceState,
        ServiceStatus, ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult, ServiceStatusHandle};
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
    use windows_service::{define_windows_service, service_dispatcher};

    use super::{ACCOUNT, FAILURE_EXIT, FIREWALL_RULE, Https, RESTART_EXIT, SERVICE_NAME, Settings};
    use crate::config::Config;
    use crate::data_dir::acl;

    const ADMINISTRATORS: &str = "S-1-5-32-544";
    /// `NT SERVICE\TrustedInstaller`, which owns and may change `C:\Program Files`.
    const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    /// How long a start or a stop may take before the service manager considers it hung; the
    /// start reports progress every few seconds within it.
    const PENDING_HINT: Duration = Duration::from_secs(30);
    /// The log rotates at this size; three older files are kept.
    const LOG_LIMIT: u64 = 10 * 1024 * 1024;
    const LOG_KEEP: u32 = 3;

    /// The SID of the virtual account `NT SERVICE\<name>`: `S-1-5-80-` and the SHA-1 of the
    /// upper-case name in UTF-16LE as five little-endian numbers. It is fixed by the name, so it
    /// is known before the service exists (the MSI package creates it only later in the
    /// installation) and stays the same when the service is created again.
    pub fn service_sid(name: &str) -> String {
        let bytes: Vec<u8> = name.to_uppercase().encode_utf16().flat_map(u16::to_le_bytes).collect();
        let digest = Sha1::digest(&bytes);
        let parts: Vec<String> =
            digest.chunks(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]).to_string()).collect();
        format!("S-1-5-80-{}", parts.join("-"))
    }

    // --- Running as the service -------------------------------------------------------------

    /// The status handle, used from the control handler, the start report and the end.
    /// SetServiceStatus may be called from any thread.
    struct StatusHandle(ServiceStatusHandle);
    // SAFETY: the handle is an opaque token the service manager accepts from any thread.
    unsafe impl Send for StatusHandle {}
    // SAFETY: as above; SetServiceStatus is thread-safe.
    unsafe impl Sync for StatusHandle {}

    static STATUS: OnceLock<StatusHandle> = OnceLock::new();
    static SERVE: OnceLock<fn() -> ExitCode> = OnceLock::new();
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    fn report(state: ServiceState, exit_code: ServiceExitCode, checkpoint: u32, wait_hint: Duration) {
        let Some(handle) = STATUS.get() else { return };
        let controls_accepted = if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        };
        let status = ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted,
            exit_code,
            checkpoint,
            wait_hint,
            process_id: None,
        };
        if let Err(e) = handle.0.set_service_status(status) {
            tracing::warn!("reporting the service state {state:?} failed: {e}");
        }
    }

    define_windows_service!(ffi_service_main, service_main);

    /// `kalzit service run`: hands this thread to the service manager, which calls `serve` on
    /// another thread. Started from a console it fails at once and says so.
    pub fn run(serve: fn() -> ExitCode) -> ExitCode {
        let _ = SERVE.set(serve);
        crate::updates::platform::mark_windows_service();
        match service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!(
                    "kalzit: `kalzit service run` is started by the Windows service manager ({e}). In a console, \
                     run `kalzit serve`; to set up the service, `kalzit service install`"
                );
                ExitCode::FAILURE
            }
        }
    }

    fn service_main(_arguments: Vec<OsString>) {
        let handler = |control| match control {
            ServiceControl::Stop => {
                report(ServiceState::StopPending, ServiceExitCode::NO_ERROR, 1, PENDING_HINT);
                crate::server::request_stop(false);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Shutdown => {
                report(ServiceState::StopPending, ServiceExitCode::NO_ERROR, 1, Duration::from_secs(5));
                crate::server::request_stop(true);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let handle = match service_control_handler::register(SERVICE_NAME, handler) {
            Ok(handle) => handle,
            Err(e) => {
                event_log_error(&format!("Kalzit could not register as a service: {e}"));
                return;
            }
        };
        let _ = STATUS.set(StatusHandle(handle));
        report(ServiceState::StartPending, ServiceExitCode::NO_ERROR, 1, PENDING_HINT);
        // The start (data directory checks, migrations) reports progress until the server
        // listens, so a long migration is not taken for a hung start.
        std::thread::spawn(|| {
            let mut checkpoint = 2;
            while !RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(5));
                if RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                report(ServiceState::StartPending, ServiceExitCode::NO_ERROR, checkpoint, PENDING_HINT);
                checkpoint += 1;
            }
        });
        crate::server::on_started(|| {
            if !RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                report(ServiceState::Running, ServiceExitCode::NO_ERROR, 0, Duration::ZERO);
            }
        });
        let code = SERVE.get().map_or(ExitCode::FAILURE, |serve| serve());
        RUNNING.store(true, std::sync::atomic::Ordering::SeqCst);
        let exit = if crate::updates::platform::restart_requested() {
            ServiceExitCode::ServiceSpecific(RESTART_EXIT)
        } else if code == ExitCode::SUCCESS {
            ServiceExitCode::NO_ERROR
        } else {
            ServiceExitCode::ServiceSpecific(FAILURE_EXIT)
        };
        report(ServiceState::Stopped, exit, 0, Duration::ZERO);
    }

    /// Writes an error to the Windows event log (Application, source `Kalzit`): what goes wrong
    /// before the log file is open, and the installer's steps, which have no console.
    pub fn event_log_error(message: &str) {
        use windows::Win32::System::EventLog::{
            DeregisterEventSource, EVENTLOG_ERROR_TYPE, RegisterEventSourceW, ReportEventW,
        };
        use windows::core::{HSTRING, PCWSTR};
        let source = HSTRING::from(SERVICE_NAME);
        let text = HSTRING::from(message);
        // SAFETY: the strings live for the calls; the handle is released once.
        unsafe {
            let Ok(handle) = RegisterEventSourceW(PCWSTR::null(), &source) else { return };
            let strings = [PCWSTR(text.as_ptr())];
            let _ = ReportEventW(handle, EVENTLOG_ERROR_TYPE, 0, 1, None, 0, Some(&strings), None);
            let _ = DeregisterEventSource(handle);
        }
    }

    /// The service's log file, `<data dir>\logs\kalzit.log`: rotated at 10 MiB, three older
    /// files kept (`kalzit.1.log` is the newest of them). The data directory is prepared (and
    /// checked) first, so the folder is private before anything is written into it.
    #[derive(Clone)]
    pub struct LogFile(Arc<Mutex<LogInner>>);

    pub struct LogInner {
        path: PathBuf,
        file: std::fs::File,
        size: u64,
    }

    impl LogFile {
        pub fn open(data_dir: &Path) -> Result<Self> {
            crate::data_dir::prepare(data_dir)?;
            let dir = data_dir.join("logs");
            std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
            let path = dir.join("kalzit.log");
            let (file, size) = open_log(&path)?;
            let log = Self(Arc::new(Mutex::new(LogInner { path, file, size })));
            if size >= LOG_LIMIT {
                log.lock().rotate();
            }
            Ok(log)
        }

        fn lock(&self) -> std::sync::MutexGuard<'_, LogInner> {
            self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
        }
    }

    fn open_log(path: &Path) -> Result<(std::fs::File, u64)> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok((file, size))
    }

    impl LogInner {
        fn rotate(&mut self) {
            let numbered = |n: u32| self.path.with_file_name(format!("kalzit.{n}.log"));
            let _ = std::fs::remove_file(numbered(LOG_KEEP));
            for n in (1..LOG_KEEP).rev() {
                let _ = std::fs::rename(numbered(n), numbered(n + 1));
            }
            // The open file is renamed under its handle; writes go to the new file from here on.
            if std::fs::rename(&self.path, numbered(1)).is_ok()
                && let Ok((file, size)) = open_log(&self.path)
            {
                self.file = file;
                self.size = size;
            }
        }
    }

    impl Write for LogFile {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let mut inner = self.lock();
            if inner.size + buf.len() as u64 > LOG_LIMIT {
                inner.rotate();
            }
            inner.file.write_all(buf)?;
            inner.size += buf.len() as u64;
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            self.lock().file.flush()
        }
    }

    // --- Setting up -------------------------------------------------------------------------

    fn manager(access: ServiceManagerAccess) -> Result<ServiceManager> {
        ServiceManager::local_computer(None::<&str>, access).map_err(|e| {
            anyhow::anyhow!(
                "cannot open the Windows service manager ({e}); run this from an elevated prompt (Run as administrator)"
            )
        })
    }

    /// `kalzit service install`: creates the service for this binary, configures it and starts it.
    pub fn install(settings: &Settings, start: bool) -> Result<String> {
        let exe = std::env::current_exe().context("finding this program's path")?;
        let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
        if manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS).is_ok() {
            bail!(
                "the service {SERVICE_NAME} exists already. Remove it first: `kalzit service uninstall`, or for an MSI \
                 installation, uninstall Kalzit in Settings, Apps"
            );
        }
        check_program_folder(&exe)?;
        let info = ServiceInfo {
            name: SERVICE_NAME.into(),
            display_name: SERVICE_NAME.into(),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: exe.clone(),
            launch_arguments: vec!["service".into(), "run".into(), "--config".into(), settings.config.clone().into()],
            dependencies: vec![],
            account_name: Some(ACCOUNT.into()),
            account_password: None,
        };
        let service = manager
            .create_service(
                &info,
                ServiceAccess::CHANGE_CONFIG
                    | ServiceAccess::START
                    | ServiceAccess::QUERY_STATUS
                    | ServiceAccess::DELETE,
            )
            .context("creating the service")?;
        let mut lines = match configure(settings, &exe) {
            Ok(lines) => lines,
            Err(e) => {
                let _ = service.delete();
                return Err(e);
            }
        };
        lines.insert(0, format!("created the service {SERVICE_NAME} (account {ACCOUNT}) for {}", exe.display()));
        if start {
            service.start::<&OsStr>(&[]).context("starting the service")?;
            wait_for(&service, ServiceState::Running, Duration::from_secs(90))?;
            lines.push(format!("the service is running; the log is in {}", log_hint(settings)));
            lines.push(
                "open Kalzit in a browser and enter the setup code from `kalzit setup-code` (in an elevated prompt)"
                    .into(),
            );
        }
        Ok(lines.join("\n"))
    }

    fn log_hint(settings: &Settings) -> String {
        let dir = Config::data_dir_hint(Some(&settings.config)).unwrap_or_else(|| settings.data_dir.clone());
        dir.join("logs").join("kalzit.log").display().to_string()
    }

    /// `kalzit service uninstall`: stops and removes the service and the firewall rule; the
    /// data and the configuration stay unless `remove_data`.
    pub fn uninstall(config: &Path, remove_data: bool) -> Result<String> {
        let manager = manager(ServiceManagerAccess::CONNECT)?;
        let mut lines = Vec::new();
        match manager
            .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE)
        {
            Ok(service) => {
                if service.query_status()?.current_state != ServiceState::Stopped {
                    let _ = service.stop();
                    wait_for(&service, ServiceState::Stopped, Duration::from_secs(60))?;
                    lines.push("stopped the service".to_string());
                }
                service.delete().context("removing the service")?;
                lines.push(format!("removed the service {SERVICE_NAME}"));
            }
            Err(e) => lines.push(format!("there is no service {SERVICE_NAME} ({e})")),
        }
        lines.extend(cleanup(config, remove_data)?);
        Ok(lines.join("\n"))
    }

    fn wait_for(service: &windows_service::service::Service, state: ServiceState, limit: Duration) -> Result<()> {
        let until = Instant::now() + limit;
        loop {
            let now = service.query_status()?.current_state;
            if now == state {
                return Ok(());
            }
            if now == ServiceState::Stopped && state == ServiceState::Running {
                bail!(
                    "the service stopped right after its start; see the Windows event log (Application, source \
                     {SERVICE_NAME}) and the log in the data folder"
                );
            }
            if Instant::now() > until {
                bail!("the service did not reach the state {state:?} within {} s", limit.as_secs());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// The program folder may be changed only by Administrators, SYSTEM and the installer (and the
    /// service account, which `configure` may add): the service runs what is in it.
    fn check_program_folder(exe: &Path) -> Result<()> {
        let dir = exe.parent().context("the program path has no folder")?;
        let me = acl::current_user().map_err(|e| anyhow::anyhow!("reading the current account: {e}"))?;
        let (owner, dacl) =
            acl::read(dir).map_err(|e| anyhow::anyhow!("reading the access list of {}: {e}", dir.display()))?;
        let sid = service_sid(SERVICE_NAME);
        let dacl: Option<Vec<acl::Entry>> =
            dacl.map(|entries| entries.into_iter().filter(|e| e.sid != sid && e.sid != TRUSTED_INSTALLER).collect());
        let owner = if owner == TRUSTED_INSTALLER { ADMINISTRATORS.to_string() } else { owner };
        if let Some(problem) = acl::problem(&owner, dacl.as_deref(), &me, acl::Others::ReadOnly) {
            bail!(
                "{} is not a safe program folder for a service: {problem}. Copy kalzit.exe to a folder only \
                 administrators can change, such as C:\\Program Files\\Kalzit, and run it from there",
                dir.display()
            );
        }
        Ok(())
    }

    /// The steps the MSI package and `kalzit service install` share, run elevated once the
    /// service exists: the configuration folder and file, the data directory and its access
    /// list, the certificate, the program folder's rights for updates, the service's recovery
    /// actions and the firewall rule. An existing configuration file is kept as it is (an
    /// upgrade); its data directory and ports are used.
    pub fn configure(settings: &Settings, exe: &Path) -> Result<Vec<String>> {
        let sid = service_sid(SERVICE_NAME);
        let mut lines = Vec::new();
        let config_dir = settings.config.parent().context("the configuration file has no folder")?.to_path_buf();
        prepare_config_folder(&config_dir)?;
        let existing = settings.config.is_file();
        let data_dir = if existing {
            Config::data_dir_hint(Some(&settings.config)).unwrap_or_else(|| settings.data_dir.clone())
        } else {
            settings.data_dir.clone()
        };
        secure_data_dir(&data_dir, &sid)?;
        lines.push(format!("data folder {} (Administrators and {ACCOUNT} only)", data_dir.display()));
        if existing {
            lines.push(format!("kept the configuration {}", settings.config.display()));
        } else {
            let tls = match &settings.https {
                Https::Off => None,
                Https::SelfSigned => {
                    let pair = self_signed(&data_dir)?;
                    lines.push(format!("self-signed certificate {}", pair.0.display()));
                    Some(pair)
                }
                Https::Certificate { cert, key } => {
                    for file in [cert, key] {
                        if !file.is_file() {
                            bail!("the file {} does not exist", file.display());
                        }
                        // The service account reads the files where they are, so a renewed
                        // certificate takes effect without another installation.
                        icacls(file, &["/grant", &format!("*{sid}:R")])?;
                    }
                    lines.push(format!("certificate {}, readable by {ACCOUNT}", cert.display()));
                    Some((cert.clone(), key.clone()))
                }
            };
            let text = super::config_toml(
                &Settings { data_dir: data_dir.clone(), ..settings.clone() },
                tls.as_ref().map(|(c, k)| (c.as_path(), k.as_path())),
            );
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&settings.config)
                .with_context(|| format!("writing {}", settings.config.display()))?;
            file.write_all(text.as_bytes())?;
            drop(file);
            acl::set_owner_administrators(&settings.config)
                .with_context(|| format!("making Administrators the owner of {}", settings.config.display()))?;
            lines.push(format!("wrote the configuration {}", settings.config.display()));
        }
        let program_dir = exe.parent().context("the program path has no folder")?;
        if settings.self_update {
            icacls(program_dir, &["/grant", &format!("*{sid}:(OI)(CI)M")])?;
            lines.push(format!("{ACCOUNT} may replace the program in {} (updates)", program_dir.display()));
        } else {
            icacls(program_dir, &["/remove:g", &format!("*{sid}")])?;
            lines.push("updates are installed by an administrator (self-update off)".into());
        }
        set_recovery()?;
        lines.push("the service restarts after a failure and after an update".into());
        if settings.open_firewall {
            let ports = ports(&settings.config)?;
            open_firewall(&ports)?;
            lines.push(format!("opened the firewall for TCP {ports}"));
        }
        Ok(lines)
    }

    /// Whether two paths name the same folder, as written (case and a trailing separator do not
    /// matter).
    fn same_folder(a: &Path, b: &Path) -> bool {
        let lower = |p: &Path| std::path::absolute(p).ok().map(|p| PathBuf::from(p.to_string_lossy().to_lowercase()));
        match (lower(a), lower(b)) {
            (Some(a), Some(b)) => a.components().eq(b.components()),
            _ => false,
        }
    }

    /// `%ProgramData%\Kalzit` (or the folder of another configuration file): created for
    /// Administrators to write and everyone to read, or put back to that when someone else may
    /// write it.
    fn prepare_config_folder(dir: &Path) -> Result<()> {
        let program_data = crate::config::program_data_folder();
        let is_default = program_data.as_deref().is_some_and(|f| same_folder(dir, f));
        if !dir.exists() {
            if is_default {
                acl::create_dir(dir, acl::CONFIG_DIR_SDDL).with_context(|| format!("creating {}", dir.display()))?;
                acl::set_owner_administrators(dir)?;
            } else {
                std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
            }
        } else if is_default && acl::check_admin_only(dir).is_err() {
            acl::restrict(dir, acl::CONFIG_DIR_SDDL).with_context(|| format!("securing {}", dir.display()))?;
            acl::set_owner_administrators(dir)?;
        }
        Ok(())
    }

    /// The data directory with a protected access list for Administrators and the service account
    /// (inherited by what Kalzit creates in it), owned by Administrators. A new one is created
    /// with that list from its first moment; Kalzit's own state files, which carry their own
    /// lists, get the same.
    fn secure_data_dir(dir: &Path, sid: &str) -> Result<()> {
        let sddl = format!("D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})");
        if !dir.exists() {
            if let Some(parent) = dir.parent() {
                std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
            }
            acl::create_dir(dir, &sddl).with_context(|| format!("creating {}", dir.display()))?;
        } else {
            if !dir.is_dir() {
                bail!("{} is not a folder", dir.display());
            }
            acl::restrict(dir, &sddl).with_context(|| format!("securing {}", dir.display()))?;
        }
        acl::set_owner_administrators(dir)
            .with_context(|| format!("making Administrators the owner of {}", dir.display()))?;
        let file_sddl = format!("D:P(A;;FA;;;BA)(A;;FA;;;{sid})");
        for name in crate::data_dir::STATE_FILES {
            let path = dir.join(name);
            if path.is_file() {
                acl::restrict(&path, &file_sddl).with_context(|| format!("securing {}", path.display()))?;
                acl::set_owner_administrators(&path)?;
            }
        }
        Ok(())
    }

    /// A certificate for this computer's name, `localhost` and the loopback addresses, made once
    /// and kept in `<data dir>\tls`.
    fn self_signed(data_dir: &Path) -> Result<(PathBuf, PathBuf)> {
        let dir = data_dir.join("tls");
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        let cert = dir.join("self-signed.crt.pem");
        let key = dir.join("self-signed.key.pem");
        if cert.is_file() && key.is_file() {
            return Ok((cert, key));
        }
        let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
        if let Some(host) = std::env::var_os("COMPUTERNAME").and_then(|h| h.into_string().ok()) {
            names.insert(0, host.to_lowercase());
        }
        let generated = rcgen::generate_simple_self_signed(names).context("making the self-signed certificate")?;
        std::fs::write(&key, generated.signing_key.serialize_pem())
            .with_context(|| format!("writing {}", key.display()))?;
        std::fs::write(&cert, generated.cert.pem()).with_context(|| format!("writing {}", cert.display()))?;
        Ok((cert, key))
    }

    fn icacls(path: &Path, args: &[&str]) -> Result<()> {
        let output = std::process::Command::new("icacls").arg(path).args(args).output().context("running icacls")?;
        if !output.status.success() {
            bail!(
                "icacls {} {} failed: {}",
                path.display(),
                args.join(" "),
                String::from_utf8_lossy(&output.stdout).trim()
            );
        }
        Ok(())
    }

    /// Restart 2 s after the first and 5 s after the second failure, then every 30 s; the count
    /// resets after a day without one. "Failure" includes a stop with an error code, which is
    /// how the service asks to be started again after an update.
    fn set_recovery() -> Result<()> {
        let manager = manager(ServiceManagerAccess::CONNECT)?;
        let service = manager
            .open_service(SERVICE_NAME, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
            .context("opening the service")?;
        service
            .set_description(
                "Kalzit: visualize and analyze your data. Data and logs: see kalzit.toml in %ProgramData%\\Kalzit.",
            )
            .context("setting the description")?;
        let restart =
            |secs| ServiceAction { action_type: ServiceActionType::Restart, delay: Duration::from_secs(secs) };
        service
            .update_failure_actions(ServiceFailureActions {
                reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 3600)),
                reboot_msg: None,
                command: None,
                actions: Some(vec![restart(2), restart(5), restart(30)]),
            })
            .context("setting the recovery actions")?;
        service.set_failure_actions_on_non_crash_failures(true).context("setting the recovery actions")?;
        Ok(())
    }

    /// The ports of the configuration's listeners, as netsh takes them (`3000,3443`).
    fn ports(config: &Path) -> Result<String> {
        let c = Config::from_file(Some(config), Vec::<(String, String)>::new())
            .with_context(|| format!("reading {}", config.display()))?;
        let ports: Vec<String> =
            [c.http_addr(), c.https_addr()].into_iter().flatten().map(|a| a.port().to_string()).collect();
        if ports.is_empty() {
            bail!("{} has no listener", config.display());
        }
        Ok(ports.join(","))
    }

    fn netsh(args: &[String]) -> std::io::Result<std::process::Output> {
        std::process::Command::new("netsh").args(["advfirewall", "firewall"]).args(args).output()
    }

    fn open_firewall(ports: &str) -> Result<()> {
        let _ = netsh(&["delete".into(), "rule".into(), format!("name={FIREWALL_RULE}")]);
        let output = netsh(&[
            "add".into(),
            "rule".into(),
            format!("name={FIREWALL_RULE}"),
            "dir=in".into(),
            "action=allow".into(),
            "protocol=TCP".into(),
            format!("localport={ports}"),
            "profile=any".into(),
        ])
        .context("running netsh")?;
        if !output.status.success() {
            bail!("adding the firewall rule failed: {}", String::from_utf8_lossy(&output.stdout).trim());
        }
        Ok(())
    }

    /// What an uninstallation leaves to Kalzit: the firewall rule, and with `remove_data` the
    /// data directory and the configuration file (a folder that does not look like Kalzit's
    /// data is left with a note).
    pub fn cleanup(config: &Path, remove_data: bool) -> Result<Vec<String>> {
        let mut lines = Vec::new();
        if netsh(&["delete".into(), "rule".into(), format!("name={FIREWALL_RULE}")]).is_ok_and(|o| o.status.success()) {
            lines.push("removed the firewall rule".to_string());
        }
        if !remove_data {
            lines.push(format!("kept the data and the configuration {}", config.display()));
            return Ok(lines);
        }
        if let Some(dir) = Config::data_dir_hint(Some(config))
            && dir.exists()
        {
            match super::removable_data_dir(&dir) {
                Ok(()) => {
                    std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
                    lines.push(format!("removed the data folder {}", dir.display()));
                }
                Err(why) => lines.push(format!("kept the data: {why}")),
            }
        }
        if config.is_file() {
            std::fs::remove_file(config).with_context(|| format!("removing {}", config.display()))?;
            lines.push(format!("removed {}", config.display()));
        }
        // The configuration folder goes when nothing else is in it.
        if let Some(folder) = config.parent() {
            let _ = std::fs::remove_dir(folder);
        }
        Ok(lines)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn virtual_account_sids_follow_from_the_name() {
            // `sc showsid TrustedInstaller`
            assert_eq!(service_sid("TrustedInstaller"), TRUSTED_INSTALLER);
            assert_eq!(service_sid("trustedinstaller"), TRUSTED_INSTALLER);
            assert!(service_sid(SERVICE_NAME).starts_with("S-1-5-80-"));
        }

        #[test]
        fn the_log_rotates_and_keeps_three_files() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("kalzit.log");
            let (file, size) = open_log(&path).unwrap();
            let mut inner = LogInner { path: path.clone(), file, size };
            for round in 0..5 {
                inner.file.write_all(format!("round {round}\n").as_bytes()).unwrap();
                inner.rotate();
            }
            let names: std::collections::BTreeSet<String> = std::fs::read_dir(dir.path())
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            assert_eq!(
                names.into_iter().collect::<Vec<_>>(),
                ["kalzit.1.log", "kalzit.2.log", "kalzit.3.log", "kalzit.log"]
            );
            assert_eq!(std::fs::read_to_string(path.with_file_name("kalzit.1.log")).unwrap(), "round 4\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(pairs: &[(&str, &str)]) -> ServiceOptions {
        let mut o = ServiceOptions::default();
        for (k, v) in pairs {
            let v = Some((*v).to_string());
            match *k {
                "data_dir" => o.data_dir = v,
                "port" => o.port = v,
                "https" => o.https = v,
                "https_port" => o.https_port = v,
                "cert_file" => o.cert_file = v,
                "key_file" => o.key_file = v,
                "open_firewall" => o.open_firewall = v,
                "self_update" => o.self_update = v,
                other => panic!("{other}"),
            }
        }
        o
    }

    fn absolute(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn empty_installer_properties_take_the_defaults() {
        let o = options(&[("data_dir", ""), ("port", ""), ("https", ""), ("cert_file", ""), ("open_firewall", "")]);
        let s = o.settings(absolute("kalzit.toml"), Some(absolute("data"))).unwrap();
        assert_eq!(s.port, 3000);
        assert_eq!(s.https, Https::Off);
        assert_eq!(s.data_dir, absolute("data"));
        assert!(!s.open_firewall);
        assert!(s.self_update);
    }

    #[test]
    fn a_quoted_folder_with_a_trailing_backslash_loses_the_stray_quote() {
        let dir = absolute("store").to_string_lossy().into_owned();
        let o = options(&[("data_dir", &format!("{dir}\""))]);
        assert_eq!(o.settings(absolute("k.toml"), None).unwrap().data_dir, PathBuf::from(dir));
    }

    #[test]
    fn wrong_values_are_refused_with_the_option_named() {
        let cases: &[(&[(&str, &str)], &str)] = &[
            (&[("port", "0")], "--port"),
            (&[("port", "http")], "--port"),
            (&[("https", "maybe")], "--https"),
            (&[("https", "certificate")], "--cert-file"),
            (&[("https", "self-signed"), ("port", "3443")], "different ports"),
            (&[("open_firewall", "sometimes")], "1 or 0"),
            (&[("data_dir", "relative")], "absolute"),
        ];
        for (pairs, needle) in cases {
            let err = options(pairs).settings(absolute("k.toml"), Some(absolute("data"))).unwrap_err();
            assert!(format!("{err:#}").contains(needle), "{pairs:?}: {err:#}");
        }
    }

    #[test]
    fn the_written_configuration_loads_with_the_chosen_settings() {
        let data = absolute("kalzit data's");
        let settings = Settings {
            config: absolute("kalzit.toml"),
            data_dir: data.clone(),
            port: 8471,
            https: Https::SelfSigned,
            https_port: 8472,
            open_firewall: false,
            self_update: true,
        };
        let cert = absolute("c.pem");
        let key = absolute("k.pem");
        let text = config_toml(&settings, Some((&cert, &key)));
        let c = crate::config::Config::from_sources(&text, Vec::<(String, String)>::new()).unwrap();
        assert_eq!(c.http_addr().unwrap().port(), 8471);
        assert_eq!(c.https_addr().unwrap().port(), 8472);
        assert_eq!(c.paths.data_dir, data);
        assert_eq!(c.tls.cert_file, Some(cert));
        assert_eq!(c.tls.key_file, Some(key));
        let plain = config_toml(&Settings { https: Https::Off, ..settings }, None);
        let c = crate::config::Config::from_sources(&plain, Vec::<(String, String)>::new()).unwrap();
        assert!(c.https_addr().is_none());
    }

    #[test]
    fn only_a_folder_that_looks_like_kalzits_data_is_removed() {
        let root = tempfile::tempdir().unwrap();
        let empty = root.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert!(removable_data_dir(&empty).is_ok());
        let data = root.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::write(data.join("kalzit.db"), b"").unwrap();
        std::fs::write(data.join("notes.txt"), b"").unwrap();
        assert!(removable_data_dir(&data).is_ok());
        let other = root.path().join("other");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("notes.txt"), b"").unwrap();
        assert!(removable_data_dir(&other).is_err());
        let drive_root = root.path().ancestors().last().unwrap();
        assert!(removable_data_dir(drive_root).is_err());
        assert!(removable_data_dir(Path::new("relative")).is_err());
    }
}
