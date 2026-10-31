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
    /// Let the service account replace the program file, so updates install on their own. Then the
    /// service account can change code administrators may run: do not run that kalzit.exe
    /// elevated [default: 0].
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

/// A value as the MSI package passes it: empty means unset. The package quotes each value with a
/// space before the closing quote (`"[DATADIR] "`), so a folder ending in a backslash does not
/// escape the quote; the space goes here.
fn value(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
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
        // No value needs a quote; one would mean a command line put together wrongly or on purpose.
        for (name, v) in [
            ("--data-dir", &self.data_dir),
            ("--port", &self.port),
            ("--https", &self.https),
            ("--https-port", &self.https_port),
            ("--cert-file", &self.cert_file),
            ("--key-file", &self.key_file),
            ("--open-firewall", &self.open_firewall),
            ("--self-update", &self.self_update),
        ] {
            if v.as_deref().is_some_and(|v| v.contains('"')) {
                bail!("{name} must not contain a quote (\")");
            }
        }
        if config.to_string_lossy().contains('"') {
            bail!("--config must not contain a quote (\")");
        }
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
            self_update: flag(&self.self_update, false)?,
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

/// Whether `path` is `folder` or lies inside it, as written (case does not matter).
pub fn same_or_within(path: &Path, folder: &Path) -> bool {
    let lower = |p: &Path| std::path::absolute(p).ok().map(|p| PathBuf::from(p.to_string_lossy().to_lowercase()));
    match (lower(path), lower(folder)) {
        (Some(path), Some(folder)) => path.starts_with(folder),
        _ => false,
    }
}

/// Why `dir` cannot be a data directory: a drive or share root, a system folder itself
/// (`exact`), or a folder inside one whose content belongs to the system or to programs
/// (`within`, such as Windows, Program Files and Kalzit's program folder).
pub fn refused_data_dir(dir: &Path, within: &[PathBuf], exact: &[PathBuf]) -> Option<String> {
    if !dir.is_absolute() {
        return Some("it is not an absolute path".into());
    }
    if dir.parent().is_none() || !dir.components().any(|c| matches!(c, std::path::Component::Normal(_))) {
        return Some("it is a drive or share root".into());
    }
    if let Some(f) = within.iter().find(|f| same_or_within(dir, f)) {
        return Some(format!("it lies in {}", f.display()));
    }
    if let Some(f) = exact.iter().find(|f| same_or_within(dir, f) && same_or_within(f, dir)) {
        return Some(format!("it is the system folder {}", f.display()));
    }
    None
}

/// The entries of a program folder that are not Kalzit's: anything but the program, the license
/// and what the updater leaves next to the program (`.<name>.old-*`, `.<stem>.new<ext>`, write
/// probes).
pub fn foreign_program_entries(names: &[String], exe_name: &str) -> Vec<String> {
    let exe = exe_name.to_lowercase();
    let (stem, ext) = match exe.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (exe.clone(), String::new()),
    };
    let old = format!(".{exe}.old-");
    let new = format!(".{stem}.new{ext}");
    names
        .iter()
        .filter(|name| {
            let n = name.to_lowercase();
            !(n == exe
                || n == "license.txt"
                || n == new
                || n.starts_with(&old)
                || n.starts_with(".kalzit-write-probe-"))
        })
        .cloned()
        .collect()
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
    use crate::locks::MutexExt;

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
            self.0.lock_or_recover()
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
            let data = Config::data_dir_hint(Some(&settings.config)).unwrap_or_else(|| settings.data_dir.clone());
            lines.push(format!(
                "open Kalzit in a browser and enter the setup code from {} (only administrators can open it)",
                data.join(crate::routes::setup::TOKEN_FILE).display()
            ));
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

    /// Rights that let an account move, remove or re-permission an object or what is in it:
    /// delete, delete child, change the access list or the owner, full control.
    const TAKEOVER_MASK: u32 = acl::DELETE | 0x40 | acl::WRITE_DAC | acl::WRITE_OWNER | acl::GENERIC_ALL;
    /// Read and execute (`RX`) and modify (`M`), as icacls names them.
    const READ_EXECUTE: u32 = 0x1200a9;
    const MODIFY: u32 = 0x1301bf;
    /// `ALL APPLICATION PACKAGES`: in AppContainer tokens only, which the plugin sandbox uses.
    const ALL_APP_PACKAGES: &str = "S-1-15-2-1";

    /// SYSTEM, Administrators and the installer service.
    fn system_account(sid: &str) -> bool {
        [acl::SYSTEM, acl::ADMINISTRATORS, TRUSTED_INSTALLER].contains(&sid)
    }

    /// What is wrong with an object's owner and access list: an owner not in `owners`, or an
    /// entry not `trusted` that grants any of `refused`.
    pub(super) fn judge(
        owner: &str,
        dacl: Option<&[acl::Entry]>,
        owners: &[&str],
        trusted: &dyn Fn(&acl::Entry) -> bool,
        refused: u32,
    ) -> Option<String> {
        if !owners.contains(&owner) {
            return Some(format!("it is owned by {owner}"));
        }
        let Some(dacl) = dacl else {
            return Some("it has no access list, so everyone has full access".into());
        };
        let open: Vec<&str> =
            dacl.iter().filter(|e| !trusted(e) && e.mask & refused != 0).map(|e| e.sid.as_str()).collect();
        if open.is_empty() { None } else { Some(format!("{} may change or read it", open.join(", "))) }
    }

    /// A folder above Kalzit's folders: only SYSTEM, Administrators and the installer service may
    /// own it or rename, remove or re-permission what is in it, or a Kalzit folder could be swapped
    /// for another one (or a junction) behind the installer's back.
    pub(super) fn ancestor_problem(owner: &str, dacl: Option<&[acl::Entry]>) -> Option<String> {
        let trusted = |e: &acl::Entry| system_account(&e.sid) || e.sid == acl::CREATOR_OWNER;
        judge(owner, dacl, &[acl::SYSTEM, acl::ADMINISTRATORS, TRUSTED_INSTALLER], &trusted, TAKEOVER_MASK)
    }

    /// An object in the data directory: owned by SYSTEM, Administrators or the service account, and
    /// nobody else may read or write it. Below `plugins`, the plugin sandbox's own grants (the
    /// plugin and start SIDs, which only Kalzit's restricted tokens carry, and AppContainers) are
    /// Kalzit's too.
    pub(super) fn data_problem(
        owner: &str,
        dacl: Option<&[acl::Entry]>,
        sid: &str,
        in_plugins: bool,
    ) -> Option<String> {
        let trusted = |e: &acl::Entry| {
            system_account(&e.sid)
                || [acl::OWNER_RIGHTS, acl::CREATOR_OWNER, sid].contains(&e.sid.as_str())
                || (in_plugins && (e.sid.starts_with("S-1-9-") || e.sid == ALL_APP_PACKAGES))
        };
        judge(owner, dacl, &[acl::SYSTEM, acl::ADMINISTRATORS, sid], &trusted, acl::READ_MASK | acl::WRITE_MASK)
    }

    /// The configuration folder: everyone may read, only Administrators and SYSTEM write. The
    /// service account may own it (Kalzit made it on a first start), when its owner entry cannot
    /// change the access list.
    pub(super) fn config_folder_problem(owner: &str, dacl: Option<&[acl::Entry]>, sid: &str) -> Option<String> {
        let owner_limited = dacl.is_some_and(|d| {
            d.iter().any(|e| {
                e.sid == acl::OWNER_RIGHTS && e.mask & (acl::WRITE_DAC | acl::WRITE_OWNER | acl::GENERIC_ALL) == 0
            })
        });
        if owner == sid && !owner_limited {
            return Some("the service account owns it and may change its access list".into());
        }
        let trusted = |e: &acl::Entry| {
            system_account(&e.sid)
                || e.sid == acl::CREATOR_OWNER
                || (e.sid == acl::OWNER_RIGHTS && (owner != sid || e.mask & (acl::WRITE_DAC | acl::WRITE_OWNER) == 0))
        };
        judge(owner, dacl, &[acl::SYSTEM, acl::ADMINISTRATORS, sid], &trusted, acl::WRITE_MASK)
    }

    /// A file only Administrators may change (the configuration, a certificate); with `secret`
    /// also only they and the service account may read it (a private key).
    pub(super) fn admin_file_problem(
        owner: &str,
        dacl: Option<&[acl::Entry]>,
        sid: &str,
        secret: bool,
    ) -> Option<String> {
        let trusted = |e: &acl::Entry| {
            system_account(&e.sid) || e.sid == acl::OWNER_RIGHTS || (e.sid == sid && e.mask & acl::WRITE_MASK == 0)
        };
        let refused = if secret { acl::READ_MASK | acl::WRITE_MASK } else { acl::WRITE_MASK };
        judge(owner, dacl, &[acl::SYSTEM, acl::ADMINISTRATORS], &trusted, refused)
    }

    fn read_acl(path: &Path, effective: bool) -> Result<(String, Option<Vec<acl::Entry>>)> {
        let read = if effective { acl::read_effective(path) } else { acl::read(path) };
        read.map_err(|e| anyhow::anyhow!("reading the access list of {}: {e}", path.display()))
    }

    /// Refuses a link, junction or other reparse point at `path` or any existing folder above it:
    /// Kalzit's folders are where their path says.
    fn refuse_reparse_points(path: &Path) -> Result<()> {
        for item in path.ancestors().filter(|a| a.parent().is_some()) {
            match std::fs::symlink_metadata(item) {
                Ok(meta) if acl::is_reparse_point(&meta) => {
                    bail!("{} is a link or junction; Kalzit's folders must not lie behind one", item.display())
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Every existing folder above `path` must be safe (`ancestor_problem`).
    fn check_ancestors(path: &Path) -> Result<()> {
        refuse_reparse_points(path)?;
        for folder in path.ancestors().skip(1).filter(|a| a.exists()) {
            let (owner, dacl) = read_acl(folder, true)?;
            if let Some(problem) = ancestor_problem(&owner, dacl.as_deref()) {
                bail!(
                    "{} cannot hold Kalzit's files: {problem} of the folder {} above it, so its content could be \
                     swapped. Choose a folder under %ProgramData% or C:\\Program Files",
                    path.display(),
                    folder.display()
                );
            }
        }
        Ok(())
    }

    /// Folders a data directory must not be or lie in, as the file system names them.
    fn system_folders() -> (Vec<PathBuf>, Vec<PathBuf>) {
        let var =
            |name: &str| std::env::var_os(name).map(|v| normalized(Path::new(&v)).unwrap_or_else(|_| PathBuf::from(v)));
        let within: Vec<PathBuf> = ["windir", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
            .iter()
            .filter_map(|n| var(n))
            .collect();
        let mut exact: Vec<PathBuf> =
            ["ProgramData", "PUBLIC", "USERPROFILE", "ALLUSERSPROFILE"].iter().filter_map(|n| var(n)).collect();
        if let Some(drive) = var("SystemDrive") {
            exact.push(PathBuf::from(format!("{}\\Users", drive.display())));
        }
        (within, exact)
    }

    /// The program folder may be changed only by Administrators, SYSTEM and the installer (and the
    /// service account, which `configure` may add): the service runs what is in it.
    fn check_program_folder(exe: &Path) -> Result<()> {
        let dir = exe.parent().context("the program path has no folder")?;
        let me = acl::current_user().map_err(|e| anyhow::anyhow!("reading the current account: {e}"))?;
        let (owner, dacl) = read_acl(dir, true)?;
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

    /// Turns off the search of the program folder (and the working directory) for DLLs loaded at
    /// run time: System32 only. With `/DEPENDENTLOADFLAG:0x800` (build.rs) for the imports, a DLL
    /// placed next to `kalzit.exe` is never loaded.
    pub fn restrict_dll_search() {
        use windows::Win32::System::LibraryLoader::{LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories};
        // SAFETY: changes the process's DLL search order; no pointers involved.
        let _ = unsafe { SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) };
    }

    /// A program of Windows by its full path in System32 (`icacls.exe`, `sc.exe`, `netsh.exe`): a
    /// bare name would be looked up in the program folder first.
    fn system_tool(name: &str) -> PathBuf {
        use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
        let mut buffer = [0u16; 260];
        // SAFETY: `buffer` is writable for its length.
        let n = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
        let dir = if n > 0 && n < buffer.len() {
            PathBuf::from(String::from_utf16_lossy(&buffer[..n]))
        } else {
            PathBuf::from(r"C:\Windows\System32")
        };
        dir.join(name)
    }

    /// The path as the file system names it, before it is compared with system folders: `\\?\`,
    /// `\\.\` and network paths, and `.` or `..` in it, are refused; the deepest existing folder
    /// is resolved (long names, the real spelling) and the rest appended.
    pub(super) fn normalized(path: &Path) -> Result<PathBuf> {
        let text = path.to_string_lossy();
        if text.starts_with(r"\\") || text.starts_with("//") {
            bail!("{} is a device, long or network path; use a plain local path such as C:\\...", path.display());
        }
        if !path.is_absolute() {
            bail!("{} is not an absolute path", path.display());
        }
        if path.components().any(|c| matches!(c, std::path::Component::CurDir | std::path::Component::ParentDir)) {
            bail!("{} contains . or ..", path.display());
        }
        let mut existing = path;
        let mut rest = Vec::new();
        while !existing.exists() {
            rest.push(existing.file_name().context("no part of the path exists")?.to_os_string());
            existing = existing.parent().context("no part of the path exists")?;
        }
        let mut out = final_path(existing).with_context(|| format!("resolving {}", existing.display()))?;
        if out.to_string_lossy().starts_with(r"\\") {
            bail!("{} lies on a network share", path.display());
        }
        for part in rest.iter().rev() {
            out.push(part);
        }
        Ok(out)
    }

    /// The program folder holds Kalzit's files only, and nobody else may change it: checked, then
    /// given a protected access list (SYSTEM and Administrators full, Users read and run, the
    /// service account modify with self-update) and Administrators as owner, then checked again.
    fn lock_program_folder(exe: &Path, sid: &str, self_update: bool) -> Result<()> {
        let dir = exe.parent().context("the program path has no folder")?;
        let exe_name = exe.file_name().context("the program path has no file name")?.to_string_lossy().into_owned();
        let (system, _) = system_folders();
        let windows = std::env::var_os("windir").map(PathBuf::from);
        if dir.parent().is_none()
            || system.iter().any(|f| same_folder(f, dir))
            || windows.is_some_and(|w| super::same_or_within(dir, &w))
        {
            bail!(
                "{} is not a folder of its own for Kalzit; install it into its own folder, such as C:\\Program Files\\Kalzit",
                dir.display()
            );
        }
        check_ancestors(dir)?;
        let foreign = |dir: &Path| -> Result<Vec<String>> {
            let names: Vec<String> = std::fs::read_dir(dir)
                .with_context(|| format!("reading {}", dir.display()))?
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            Ok(super::foreign_program_entries(&names, &exe_name))
        };
        let found = foreign(dir)?;
        if !found.is_empty() {
            bail!(
                "{} holds other files than Kalzit's ({}); the service account must not get rights there. Install \
                 Kalzit into its own folder, such as C:\\Program Files\\Kalzit",
                dir.display(),
                found.join(", ")
            );
        }
        check_program_folder(exe)?;
        let mut sddl = format!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x{READ_EXECUTE:x};;;BU)");
        if self_update {
            sddl.push_str(&format!("(A;OICI;0x{MODIFY:x};;;{sid})"));
        }
        acl::restrict(dir, &sddl).with_context(|| format!("securing {}", dir.display()))?;
        acl::set_owner_administrators(dir)
            .with_context(|| format!("making Administrators the owner of {}", dir.display()))?;
        let found = foreign(dir)?;
        if !found.is_empty() {
            bail!("{} changed while it was secured ({})", dir.display(), found.join(", "));
        }
        Ok(())
    }

    /// The steps the MSI package and `kalzit service install` share, run elevated once the
    /// service exists and before it starts: the configuration folder and file, the data
    /// directory and its access list, the certificate, the program folder, the service's
    /// privileges and recovery actions and the firewall rule. An existing configuration file is
    /// kept (an upgrade) when only Administrators can change it; its data directory and ports are
    /// used. Folders someone else could have prepared are refused, not taken over.
    pub fn configure(settings: &Settings, exe: &Path) -> Result<Vec<String>> {
        let sid = service_sid(SERVICE_NAME);
        let mut lines = Vec::new();
        let exe = &normalized(exe)?;
        // The program folder first: nothing else is touched when it is not Kalzit's own.
        lock_program_folder(exe, &sid, settings.self_update)?;
        let config_dir = settings.config.parent().context("the configuration file has no folder")?.to_path_buf();
        prepare_config_folder(&config_dir, &sid)?;
        let existing = match std::fs::symlink_metadata(&settings.config) {
            Ok(meta) => {
                if acl::is_reparse_point(&meta) || !meta.is_file() {
                    bail!("{} is a link or not a file; remove it and install again", settings.config.display());
                }
                let (owner, dacl) = read_acl(&settings.config, false)?;
                if let Some(problem) = admin_file_problem(&owner, dacl.as_deref(), &sid, false) {
                    bail!(
                        "{} was not written by an administrator ({problem}), so it is not used. Check it, make it \
                         Administrators' only (`icacls \"{p}\" /setowner *S-1-5-32-544` and `icacls \"{p}\" /reset`) \
                         or remove it, then install again",
                        settings.config.display(),
                        p = settings.config.display()
                    );
                }
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => bail!("reading {}: {e}", settings.config.display()),
        };
        let data_dir = if existing {
            Config::data_dir_hint(Some(&settings.config)).unwrap_or_else(|| settings.data_dir.clone())
        } else {
            settings.data_dir.clone()
        };
        let data_dir = normalized(&data_dir)?;
        let (within, exact) = system_folders();
        let program_dir = exe.parent().context("the program path has no folder")?.to_path_buf();
        let mut within = within;
        within.push(program_dir.clone());
        if let Some(why) = super::refused_data_dir(&data_dir, &within, &exact) {
            bail!("{} cannot be Kalzit's data folder: {why}", data_dir.display());
        }
        let found = take_over_data_dir(&data_dir, &sid)?;
        lines.push(format!("data folder {} ({found}; Administrators and {ACCOUNT} only)", data_dir.display()));
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
                    let (cert, key) = (&normalized(cert)?, &normalized(key)?);
                    check_certificate(cert, key, &sid)?;
                    for file in [cert, key] {
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
        if settings.self_update {
            lines.push(format!("{ACCOUNT} may replace the program in {} (updates)", program_dir.display()));
        } else {
            lines.push("updates are installed by an administrator (self-update off)".into());
        }
        set_service_config()?;
        lines.push("the service has only SeChangeNotifyPrivilege and restarts after a failure and an update".into());
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
        super::same_or_within(a, b) && super::same_or_within(b, a)
    }

    /// `%ProgramData%\Kalzit` (or the folder of another configuration file): created for
    /// Administrators to write and everyone to read. An existing one must already be that way
    /// (Kalzit made it); one someone else could have prepared is refused.
    fn prepare_config_folder(dir: &Path, sid: &str) -> Result<()> {
        let program_data = crate::config::program_data_folder();
        let is_default = program_data.as_deref().is_some_and(|f| same_folder(dir, f));
        check_ancestors(dir)?;
        if !dir.exists() {
            if is_default {
                acl::create_dir(dir, acl::CONFIG_DIR_SDDL).with_context(|| format!("creating {}", dir.display()))?;
            } else {
                std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
                acl::restrict(dir, acl::CONFIG_DIR_SDDL).with_context(|| format!("securing {}", dir.display()))?;
            }
            acl::set_owner_administrators(dir)?;
            return Ok(());
        }
        let (owner, dacl) = read_acl(dir, false)?;
        if let Some(problem) = config_folder_problem(&owner, dacl.as_deref(), sid) {
            bail!(
                "{} exists, but not as Kalzit's installer makes it ({problem}). Someone else may have prepared it: \
                 move it aside or remove it, then install again",
                dir.display()
            );
        }
        if owner != acl::ADMINISTRATORS && owner != acl::SYSTEM {
            acl::set_owner_administrators(dir)?;
        }
        Ok(())
    }

    /// Every file and folder in `dir` (`dir` first), with whether it lies below `plugins`. Links,
    /// junctions and other reparse points are refused.
    fn tree(dir: &Path) -> Result<Vec<(PathBuf, bool, bool)>> {
        let mut out = vec![(dir.to_path_buf(), true, false)];
        let mut next = 0;
        while next < out.len() {
            let (path, is_dir, in_plugins) = out[next].clone();
            next += 1;
            if !is_dir {
                continue;
            }
            for entry in std::fs::read_dir(&path).with_context(|| format!("reading {}", path.display()))? {
                let entry = entry?;
                let meta = std::fs::symlink_metadata(entry.path())?;
                if acl::is_reparse_point(&meta) {
                    bail!("{} is a link or junction; Kalzit's data folder must not hold one", entry.path().display());
                }
                let plugins = in_plugins || (path == dir && entry.file_name().eq_ignore_ascii_case("plugins"));
                out.push((entry.path(), meta.is_dir(), plugins));
            }
        }
        Ok(out)
    }

    /// The data directory with a protected access list for Administrators and the service account,
    /// owned by Administrators. A new one is created that way from its first moment. An existing
    /// one (an upgrade, or `kalzit serve` before) must be private to Kalzit through and through
    /// when found: no link or junction anywhere in it, nothing anyone else may read or write.
    /// Then every file and folder gets the same list and owner, except below `plugins`, where the
    /// sandbox's own grants stay (checked above).
    fn take_over_data_dir(dir: &Path, sid: &str) -> Result<&'static str> {
        let dir_sddl = format!("D:P(A;OICI;FA;;;BA)(A;OICI;FA;;;{sid})");
        let file_sddl = format!("D:P(A;;FA;;;BA)(A;;FA;;;{sid})");
        if let Some(parent) = dir.parent() {
            check_ancestors(parent)?;
            std::fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
            // Folders created just now inherit from above; nobody else may move them either.
            check_ancestors(dir)?;
        }
        let meta = match std::fs::symlink_metadata(dir) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                acl::create_dir(dir, &dir_sddl).with_context(|| format!("creating {}", dir.display()))?;
                acl::set_owner_administrators(dir)?;
                return Ok("created");
            }
            Err(e) => bail!("reading {}: {e}", dir.display()),
        };
        if acl::is_reparse_point(&meta) || !meta.is_dir() {
            bail!("{} is a link, a junction or a file, not a folder", dir.display());
        }
        let items = tree(dir)?;
        for (path, _, in_plugins) in &items {
            let (owner, dacl) = read_acl(path, false)?;
            if let Some(problem) = data_problem(&owner, dacl.as_deref(), sid, *in_plugins) {
                bail!(
                    "{} was not private to Kalzit when the installer found it: {} ({problem}). Someone else may have \
                     prepared it; move the data folder aside or remove it, then install again",
                    dir.display(),
                    path.display()
                );
            }
        }
        for (path, is_dir, in_plugins) in &items {
            if *in_plugins {
                continue;
            }
            acl::restrict(path, if *is_dir { &dir_sddl } else { &file_sddl })
                .with_context(|| format!("securing {}", path.display()))?;
            acl::set_owner_administrators(path)?;
        }
        Ok("kept")
    }

    /// The certificate (only Administrators may change it) and its key (and only they may read
    /// it), each in folders nobody else may rename: the service would serve whatever they hold.
    fn check_certificate(cert: &Path, key: &Path, sid: &str) -> Result<()> {
        for (file, secret) in [(cert, false), (key, true)] {
            let meta = std::fs::symlink_metadata(file).with_context(|| format!("reading {}", file.display()))?;
            if acl::is_reparse_point(&meta) || !meta.is_file() {
                bail!("{} is a link or not a file", file.display());
            }
            check_ancestors(file)?;
            let (owner, dacl) = read_acl(file, false)?;
            if let Some(problem) = admin_file_problem(&owner, dacl.as_deref(), sid, secret) {
                let what = if secret { "change or read" } else { "change" };
                bail!(
                    "{} must be a file only Administrators may {what} ({problem}); fix its access list or copy it to a \
                     folder only Administrators can open",
                    file.display()
                );
            }
        }
        Ok(())
    }

    /// A certificate for this computer's name, `localhost` and the loopback addresses, made once
    /// and kept in `<data dir>\tls` (checked private with the data directory before it is reused).
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

    fn run_tool(program: &Path, args: &[std::ffi::OsString]) -> Result<()> {
        let output = std::process::Command::new(program)
            .args(args)
            .output()
            .with_context(|| format!("running {}", program.display()))?;
        if !output.status.success() {
            bail!(
                "{} {} failed: {}",
                program.display(),
                args.iter().map(|a| a.to_string_lossy()).collect::<Vec<_>>().join(" "),
                String::from_utf8_lossy(&output.stdout).trim()
            );
        }
        Ok(())
    }

    fn icacls(path: &Path, args: &[&str]) -> Result<()> {
        let mut all: Vec<std::ffi::OsString> = vec![path.as_os_str().to_owned()];
        all.extend(args.iter().map(std::ffi::OsString::from));
        run_tool(&system_tool("icacls.exe"), &all)
    }

    /// The description; only `SeChangeNotifyPrivilege` in the service's token (no impersonation,
    /// no primary tokens: a compromised service cannot turn into SYSTEM through them); restart 2 s
    /// after the first and 5 s after the second failure, then every 30 s, the count reset after a
    /// day without one. "Failure" includes a stop with an error code, which is how the service
    /// asks to be started again after an update.
    fn set_service_config() -> Result<()> {
        let manager = manager(ServiceManagerAccess::CONNECT)?;
        let service = manager
            .open_service(SERVICE_NAME, ServiceAccess::CHANGE_CONFIG | ServiceAccess::START)
            .context("opening the service")?;
        service
            .set_description(
                "Kalzit: visualize and analyze your data. Data and logs: see kalzit.toml in %ProgramData%\\Kalzit.",
            )
            .context("setting the description")?;
        run_tool(&system_tool("sc.exe"), &["privs".into(), SERVICE_NAME.into(), "SeChangeNotifyPrivilege".into()])?;
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
        std::process::Command::new(system_tool("netsh.exe")).args(["advfirewall", "firewall"]).args(args).output()
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

    /// The path an open handle really leads to, without the `\\?\` prefix: links and junctions
    /// resolved by the system, so it tells whether a path still names what it says.
    fn final_path(path: &Path) -> std::io::Result<PathBuf> {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{FILE_NAME_NORMALIZED, GetFinalPathNameByHandleW};
        // FILE_FLAG_BACKUP_SEMANTICS (a folder), FILE_FLAG_OPEN_REPARSE_POINT (not through a link)
        let file = std::fs::OpenOptions::new().read(true).custom_flags(0x0200_0000 | 0x0020_0000).open(path)?;
        let mut buffer = vec![0u16; 32 * 1024];
        // SAFETY: the handle is open for the call; `buffer` is writable for its length.
        let n = unsafe { GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut buffer, FILE_NAME_NORMALIZED) };
        if n == 0 || n as usize >= buffer.len() {
            return Err(std::io::Error::last_os_error());
        }
        let text = String::from_utf16_lossy(&buffer[..n as usize]);
        let text = text
            .strip_prefix(r"\\?\UNC\")
            .map(|t| format!(r"\\{t}"))
            .unwrap_or_else(|| text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text.clone()));
        Ok(PathBuf::from(text))
    }

    /// What an uninstallation leaves to Kalzit: the firewall rule, and with `remove_data` the
    /// data directory and the configuration file. The data directory goes only when no link or
    /// junction leads anywhere on its way, the folders above it are safe, the opened folder is the
    /// one the path names, and it looks like Kalzit's data; otherwise it stays with a note.
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
            let checked = check_ancestors(&dir)
                .and_then(|()| refuse_reparse_points(&dir))
                .and_then(|()| super::removable_data_dir(&dir).map_err(anyhow::Error::msg))
                .and_then(|()| {
                    let real = final_path(&dir).with_context(|| format!("opening {}", dir.display()))?;
                    if same_folder(&real, &dir) {
                        Ok(())
                    } else {
                        bail!("{} leads to {}", dir.display(), real.display())
                    }
                });
            match checked {
                Ok(()) => {
                    // Removes links found inside as links, never what they point to.
                    std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))?;
                    lines.push(format!("removed the data folder {}", dir.display()));
                }
                Err(why) => lines.push(format!("kept the data: {why:#}")),
            }
        }
        if std::fs::symlink_metadata(config).is_ok_and(|m| m.is_file() && !acl::is_reparse_point(&m)) {
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

        const FULL: u32 = 0x1f01ff;
        const USERS: &str = "S-1-5-32-545";
        const AUTHENTICATED_USERS: &str = "S-1-5-11";
        const SOMEONE: &str = "S-1-5-21-1-2-3-1001";

        fn e(sid: &str, mask: u32) -> acl::Entry {
            acl::Entry { sid: sid.into(), mask }
        }

        #[test]
        fn folders_above_must_not_let_others_move_what_is_inside() {
            // %ProgramData%: Users may add files and folders, but not remove or rename them.
            let program_data =
                [e(acl::SYSTEM, FULL), e(acl::ADMINISTRATORS, FULL), e(USERS, READ_EXECUTE), e(USERS, 0x116)];
            assert!(ancestor_problem(acl::SYSTEM, Some(&program_data)).is_none());
            // A folder made under C:\, where Authenticated Users may modify what is created.
            let open = [e(acl::ADMINISTRATORS, FULL), e(AUTHENTICATED_USERS, MODIFY)];
            assert!(ancestor_problem(acl::ADMINISTRATORS, Some(&open)).is_some());
            assert!(ancestor_problem(SOMEONE, Some(&program_data)).is_some());
            assert!(ancestor_problem(acl::SYSTEM, None).is_some());
        }

        #[test]
        fn data_found_open_to_others_is_refused() {
            let sid = service_sid(SERVICE_NAME);
            let ours = [e(acl::ADMINISTRATORS, FULL), e(&sid, FULL)];
            assert!(data_problem(acl::ADMINISTRATORS, Some(&ours), &sid, false).is_none());
            assert!(data_problem(&sid, Some(&ours), &sid, false).is_none());
            // Created by `kalzit serve`: SYSTEM, Administrators and the owner.
            let first_start = [e(acl::SYSTEM, FULL), e(acl::ADMINISTRATORS, FULL), e(acl::OWNER_RIGHTS, FULL)];
            assert!(data_problem(acl::ADMINISTRATORS, Some(&first_start), &sid, false).is_none());
            let readable = [e(acl::ADMINISTRATORS, FULL), e(&sid, FULL), e(USERS, READ_EXECUTE)];
            assert!(data_problem(acl::ADMINISTRATORS, Some(&readable), &sid, false).is_some());
            // Pre-created by a user: their own folder.
            assert!(data_problem(SOMEONE, Some(&ours), &sid, false).is_some());
            // The plugin sandbox's grants count only below `plugins`.
            let plugin =
                [e(acl::ADMINISTRATORS, FULL), e("S-1-9-1-2-3-4", READ_EXECUTE), e(ALL_APP_PACKAGES, READ_EXECUTE)];
            assert!(data_problem(&sid, Some(&plugin), &sid, true).is_none());
            assert!(data_problem(&sid, Some(&plugin), &sid, false).is_some());
        }

        #[test]
        fn configuration_folders_and_files_must_be_administrators_only() {
            let sid = service_sid(SERVICE_NAME);
            let installer = [
                e(acl::SYSTEM, FULL),
                e(acl::ADMINISTRATORS, FULL),
                e(USERS, READ_EXECUTE),
                e(acl::OWNER_RIGHTS, 0x1200ad),
            ];
            assert!(config_folder_problem(acl::ADMINISTRATORS, Some(&installer), &sid).is_none());
            // Made by the service on a first start: owned by it, but its owner entry is limited.
            assert!(config_folder_problem(&sid, Some(&installer), &sid).is_none());
            let unlimited = [e(acl::SYSTEM, FULL), e(acl::ADMINISTRATORS, FULL)];
            assert!(config_folder_problem(&sid, Some(&unlimited), &sid).is_some());
            // Pre-created under %ProgramData%: Users may add files.
            let planted = [e(acl::SYSTEM, FULL), e(acl::ADMINISTRATORS, FULL), e(USERS, 0x116)];
            assert!(config_folder_problem(acl::ADMINISTRATORS, Some(&planted), &sid).is_some());
            assert!(config_folder_problem(SOMEONE, Some(&installer), &sid).is_some());

            let file = [e(acl::SYSTEM, FULL), e(acl::ADMINISTRATORS, FULL), e(USERS, READ_EXECUTE)];
            assert!(admin_file_problem(acl::ADMINISTRATORS, Some(&file), &sid, false).is_none());
            assert!(admin_file_problem(SOMEONE, Some(&file), &sid, false).is_some());
            // A private key: Users may not read it; the service account may, but not write it.
            assert!(admin_file_problem(acl::ADMINISTRATORS, Some(&file), &sid, true).is_some());
            let key = [e(acl::SYSTEM, FULL), e(acl::ADMINISTRATORS, FULL), e(&sid, READ_EXECUTE)];
            assert!(admin_file_problem(acl::ADMINISTRATORS, Some(&key), &sid, true).is_none());
            let writable = [e(acl::ADMINISTRATORS, FULL), e(&sid, MODIFY)];
            assert!(admin_file_problem(acl::ADMINISTRATORS, Some(&writable), &sid, true).is_some());
        }

        #[test]
        fn a_link_inside_the_data_folder_is_refused() {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("data");
            std::fs::create_dir_all(data.join("plugins").join("packages")).unwrap();
            std::fs::write(data.join("kalzit.db"), b"").unwrap();
            let items = tree(&data).unwrap();
            assert!(items.iter().any(|(p, is_dir, in_plugins)| p.ends_with("packages") && *is_dir && *in_plugins));
            assert!(items.iter().any(|(p, _, in_plugins)| p.ends_with("kalzit.db") && !*in_plugins));
            let elsewhere = root.path().join("elsewhere");
            std::fs::create_dir(&elsewhere).unwrap();
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(data.join("updates"))
                .arg(&elsewhere)
                .output()
                .unwrap();
            assert!(status.status.success());
            assert!(format!("{:#}", tree(&data).unwrap_err()).contains("junction"));
            assert!(refuse_reparse_points(&data.join("updates").join("x")).is_err());
            assert!(refuse_reparse_points(&data.join("plugins")).is_ok());
        }

        #[test]
        fn paths_are_normalized_before_they_are_compared() {
            let windows = PathBuf::from(std::env::var_os("windir").unwrap());
            let lower = PathBuf::from(windows.to_string_lossy().to_lowercase());
            let n = normalized(&lower.join("Missing").join("Deeper")).unwrap();
            assert!(n.starts_with(normalized(&windows).unwrap()), "{}", n.display());
            assert!(n.ends_with(Path::new("Missing").join("Deeper")));
            let long = format!(r"\\?\{}", windows.display());
            for refused in [long.as_str(), r"\\server\share\kalzit", r"\\.\C:\kalzit", "relative"] {
                assert!(normalized(Path::new(refused)).is_err(), "{refused}");
            }
            assert!(normalized(&windows.join("..").join("ProgramData")).is_err());
            assert!(system_tool("icacls.exe").is_file());
        }

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
        assert!(!s.self_update);
    }

    #[test]
    fn the_installers_padding_space_goes_and_quotes_are_refused() {
        let dir = absolute("store").to_string_lossy().into_owned();
        let o = options(&[("data_dir", &format!("{dir} "))]);
        assert_eq!(o.settings(absolute("k.toml"), None).unwrap().data_dir, PathBuf::from(&dir));
        for field in ["data_dir", "cert_file", "key_file", "port"] {
            let err = options(&[(field, &format!("{dir}\" --self-update 0"))])
                .settings(absolute("k.toml"), None)
                .unwrap_err();
            assert!(format!("{err:#}").contains("quote"), "{field}: {err:#}");
        }
    }

    #[test]
    fn drive_roots_and_system_folders_are_no_data_folders() {
        let base = absolute("sys");
        let windows = base.join("Windows");
        let program_data = base.join("ProgramData");
        let within = [windows.clone()];
        let exact = [program_data.clone()];
        assert!(refused_data_dir(&windows.join("Temp"), &within, &exact).is_some());
        assert!(refused_data_dir(&windows, &within, &exact).is_some());
        assert!(refused_data_dir(&program_data, &within, &exact).is_some());
        assert!(refused_data_dir(&program_data.join("Kalzit").join("data"), &within, &exact).is_none());
        let drive_root = base.ancestors().last().unwrap();
        assert!(refused_data_dir(drive_root, &within, &exact).is_some());
        assert!(refused_data_dir(Path::new("relative"), &within, &exact).is_some());
    }

    #[test]
    fn a_program_folder_may_hold_only_kalzits_files() {
        let names = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let ok =
            names(&["kalzit.exe", "LICENSE.txt", ".kalzit.exe.old-123", ".kalzit.new.exe", ".kalzit-write-probe-7"]);
        assert!(foreign_program_entries(&ok, "kalzit.exe").is_empty());
        let shared = names(&["kalzit.exe", "version.dll", "other-tool.exe", "Common Files"]);
        assert_eq!(foreign_program_entries(&shared, "kalzit.exe"), ["version.dll", "other-tool.exe", "Common Files"]);
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
