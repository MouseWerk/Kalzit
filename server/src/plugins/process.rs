//! A plugin process: started in the operating system's sandbox (`sandbox`), with its output
//! captured, and the local connection to it.
//!
//! The connection: on Windows a named pipe with a random name the host chooses; the plugin
//! creates it as its first instance, and the host checks that the pipe's server process
//! (`GetNamedPipeServerProcessId`) is the child it started. On Linux a Unix socket in the
//! plugin's private run directory (mode 0700); the host checks the peer's process id
//! (`SO_PEERCRED`). Every reconnect checks again. The address and a per-start token reach the
//! plugin in its environment; every call carries the token (docs/ARCHITECTURE.md, "Process
//! model and transport").

use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::AsyncRead;
use tokio::sync::watch;

/// What a plugin process may use. Enforced by the job object on Windows; on Linux the memory is
/// a limit on the data segment (`RLIMIT_DATA`), processes and CPU are not limited there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Limits {
    pub memory_bytes: u64,
    /// Processes at once, the plugin included (Windows).
    pub max_processes: u32,
    /// Hard cap on the CPU share of the whole machine in percent (Windows); `None`: no cap.
    pub cpu_percent: Option<u32>,
}

impl Default for Limits {
    fn default() -> Self {
        Self { memory_bytes: 2 * 1024 * 1024 * 1024, max_processes: 16, cpu_percent: None }
    }
}

/// How to start one plugin process.
#[derive(Clone, Debug)]
pub struct Spec {
    /// The binary, inside `package_dir`.
    pub program: PathBuf,
    /// Arguments after the program; plugins get none.
    pub args: Vec<String>,
    /// The checked package: read and run only.
    pub package_dir: PathBuf,
    /// The private directory of this start: the socket (Linux) and `tmp`. Read and write.
    pub run_dir: PathBuf,
    /// The plugin's temporary directory, inside `run_dir`.
    pub tmp_dir: PathBuf,
    /// The whole environment of the plugin; nothing of Kalzit's own is passed on.
    pub env: Vec<(String, String)>,
    pub limits: Limits,
    /// Windows: the plugin's SID (its package grants it) and this start's (its run directory and
    /// default DACL grant it), both restricting SIDs of its token.
    pub plugin_sid: String,
    pub start_sid: String,
    /// Linux: refuse to start when Landlock does not take.
    pub require_landlock: bool,
}

/// A started plugin process.
pub struct Child {
    pub pid: u32,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stderr: Box<dyn AsyncRead + Send + Unpin>,
    /// The sandbox layers in force, and those this host could not apply.
    pub layers: Vec<&'static str>,
    pub missing: Vec<&'static str>,
    /// Becomes `Some(how it ended)` when the process has ended.
    pub exited: watch::Receiver<Option<String>>,
    pub control: Arc<dyn Control>,
}

/// Ends a plugin process and everything it started.
pub trait Control: Send + Sync {
    fn kill(&self);
}

/// Starts the plugin in the sandbox of this operating system.
pub fn spawn(spec: &Spec) -> std::io::Result<Child> {
    super::sandbox::spawn(spec)
}

/// The environment every plugin gets: its address, its token, its temporary directory, and on
/// Windows the few system variables a process needs to load the network stack.
pub fn environment(address: &str, token: &str, tmp: &std::path::Path) -> Vec<(String, String)> {
    let tmp = tmp.to_string_lossy().into_owned();
    let mut env = vec![
        ("KALZIT_PLUGIN_ADDRESS".to_string(), address.to_string()),
        ("KALZIT_PLUGIN_TOKEN".to_string(), token.to_string()),
        // The plugin accepts connections from this process only (client process id of the
        // pipe, SO_PEERCRED of the socket).
        ("KALZIT_PLUGIN_HOST_PID".to_string(), std::process::id().to_string()),
        ("TMP".to_string(), tmp.clone()),
        ("TEMP".to_string(), tmp.clone()),
        ("TMPDIR".to_string(), tmp.clone()),
    ];
    if cfg!(windows) {
        for name in ["SystemRoot", "SystemDrive", "windir", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"] {
            if let Ok(value) = std::env::var(name) {
                env.push((name.to_string(), value));
            }
        }
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        env.push(("PATH".to_string(), format!(r"{root}\System32")));
    } else {
        env.push(("PATH".to_string(), "/usr/bin:/bin".to_string()));
        env.push(("HOME".to_string(), tmp));
        env.push(("LANG".to_string(), "C.UTF-8".to_string()));
    }
    env
}

/// The address of a new start: a pipe name on Windows, a socket path in `run_dir` on Linux.
pub fn address(run_dir: &std::path::Path, random: &str) -> String {
    if cfg!(windows) {
        let _ = run_dir;
        format!(r"\\.\pipe\kalzit-plugin-{random}")
    } else {
        run_dir.join("socket").to_string_lossy().into_owned()
    }
}

/// The local connection to a plugin, checked to end at the process `pid`.
#[cfg(windows)]
pub async fn connect(address: &str, pid: u32) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use std::os::windows::io::AsRawHandle;
    use tokio::net::windows::named_pipe::ClientOptions;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut tries = 0;
    let client = loop {
        match ClientOptions::new().open(address) {
            Ok(client) => break client,
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 50 => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Err(e) => return Err(e),
        }
    };
    let mut server = 0u32;
    // SAFETY: the client handle is open for the call; `server` is a valid out pointer.
    unsafe { GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut server) }
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    if server != pid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("the pipe belongs to process {server}, not to the plugin ({pid})"),
        ));
    }
    Ok(client)
}

/// The local connection to a plugin, checked to end at the process `pid`.
#[cfg(unix)]
pub async fn connect(address: &str, pid: u32) -> std::io::Result<tokio::net::UnixStream> {
    let stream = tokio::net::UnixStream::connect(address).await?;
    let peer = stream.peer_cred()?.pid();
    if peer != i32::try_from(pid).ok() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("the socket belongs to process {peer:?}, not to the plugin ({pid})"),
        ));
    }
    Ok(stream)
}

/// A gRPC channel over the checked local connection; every reconnect is checked again.
pub async fn channel(address: String, pid: u32) -> Result<tonic::transport::Channel, tonic::transport::Error> {
    let connector = tower::service_fn(move |_: tonic::transport::Uri| {
        let address = address.clone();
        async move { connect(&address, pid).await.map(hyper_util::rt::TokioIo::new) }
    });
    tonic::transport::Endpoint::from_static("http://kalzit-plugin.invalid")
        .connect_timeout(std::time::Duration::from_secs(5))
        .http2_keep_alive_interval(std::time::Duration::from_secs(30))
        .keep_alive_timeout(std::time::Duration::from_secs(10))
        .connect_with_connector(connector)
        .await
}
