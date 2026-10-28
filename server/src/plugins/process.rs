//! A plugin process: started in the operating system's sandbox (`sandbox`), with its output
//! captured, and the local connection to it.
//!
//! The connection: on Windows a named pipe with a random name; the host creates it (its first
//! instance before the plugin starts, so nobody else owns the name) and keeps one instance
//! waiting, the plugin connects to it as a client (an AppContainer cannot create pipes) and
//! serves the protocol over each connection it makes; the host checks that the pipe's client
//! process (`GetNamedPipeClientProcessId`) is the child it started. On Linux a Unix socket in
//! the plugin's private run directory (mode 0700) that the plugin listens on; the host checks
//! the peer's process id (`SO_PEERCRED`). Every reconnect checks again. The address and a
//! per-start token reach the plugin in its environment; every call carries the token
//! (docs/ARCHITECTURE.md, "Process model and transport").

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
    /// Windows: the AppContainer the process runs in (`package::app_container_sid`).
    pub app_container_sid: String,
    /// Linux: refuse to start when Landlock does not take.
    pub require_landlock: bool,
    /// Linux: descriptors of Kalzit's that the plugin gets, as (Kalzit's number, the plugin's).
    pub inherit: Vec<(i32, i32)>,
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

/// The environment every plugin gets: its address, its token, the address of Kalzit's network
/// connector, its temporary directory, and on Windows the few system variables a process needs
/// to load the network stack.
pub fn environment(address: &str, token: &str, tmp: &std::path::Path, connector: &str) -> Vec<(String, String)> {
    let tmp = tmp.to_string_lossy().into_owned();
    let mut env = vec![
        ("KALZIT_PLUGIN_ADDRESS".to_string(), address.to_string()),
        ("KALZIT_PLUGIN_TOKEN".to_string(), token.to_string()),
        (kalzit_plugin_api::connector::ENV.to_string(), connector.to_string()),
        // The plugin accepts connections from this process only (client process id of the
        // pipe, SO_PEERCRED of the socket).
        ("KALZIT_PLUGIN_HOST_PID".to_string(), std::process::id().to_string()),
        ("TMP".to_string(), tmp.clone()),
        ("TEMP".to_string(), tmp.clone()),
        ("TMPDIR".to_string(), tmp.clone()),
    ];
    if cfg!(windows) {
        for name in [
            "SystemRoot",
            "SystemDrive",
            "windir",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
        ] {
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

/// The descriptor number a Linux plugin finds its connection to Kalzit on (`fd:3`).
pub const HOST_FD: i32 = 3;
/// The descriptor number of Kalzit's network connector in a Linux plugin (`fd:4`).
pub const CONNECTOR_FD: i32 = 4;

/// Where a start's local connection lives, made before the plugin starts: a connected socket
/// pair (Linux; the plugin's end becomes its descriptor 3, so it needs no socket of its own) or
/// the pipe with its waiting instance (Windows).
pub struct Endpoint {
    /// What the plugin gets as `KALZIT_PLUGIN_ADDRESS`.
    pub address: String,
    #[cfg(windows)]
    pipe: windows_pipe::Pipe,
    /// Kalzit's end, taken by the one connection Kalzit makes.
    #[cfg(unix)]
    ours: std::sync::Mutex<Option<std::os::unix::net::UnixStream>>,
    /// The plugin's end, until it is handed to the process (`take_plugin_end`).
    #[cfg(unix)]
    theirs: Option<std::os::fd::OwnedFd>,
}

impl Endpoint {
    /// Linux: a socket pair, `fd:3` for the plugin. Windows: the pipe
    /// `\\.\pipe\kalzit-plugin-<random>`, created here, for Kalzit's account, the start's SID
    /// and the plugin's AppContainer, labelled low.
    pub fn new(
        run_dir: &std::path::Path,
        random: &str,
        start_sid: &str,
        app_container_sid: &str,
    ) -> std::io::Result<Self> {
        #[cfg(windows)]
        {
            let _ = run_dir;
            let address = format!(r"\\.\pipe\kalzit-plugin-{random}");
            let sddl = windows_pipe::sddl(start_sid, app_container_sid)?;
            let pipe = windows_pipe::Pipe::new(address.clone(), sddl)?;
            Ok(Self { address, pipe })
        }
        #[cfg(not(windows))]
        {
            let _ = (run_dir, random, start_sid, app_container_sid);
            let (ours, theirs) = std::os::unix::net::UnixStream::pair()?;
            ours.set_nonblocking(true)?;
            Ok(Self {
                address: format!("fd:{HOST_FD}"),
                ours: std::sync::Mutex::new(Some(ours)),
                theirs: Some(theirs.into()),
            })
        }
    }

    /// The plugin's end of the connection, to be inherited as `HOST_FD` (Linux).
    #[cfg(unix)]
    pub fn take_plugin_end(&mut self) -> Option<std::os::fd::OwnedFd> {
        self.theirs.take()
    }

    /// The one connection to the plugin (Linux): the socket pair cannot reach anyone else, so no
    /// process check is needed; a second connect finds it gone and fails.
    #[cfg(unix)]
    async fn connect(&self, _pid: u32) -> std::io::Result<tokio::net::UnixStream> {
        let ours = self.ours.lock().unwrap_or_else(|e| e.into_inner()).take();
        match ours {
            Some(stream) => tokio::net::UnixStream::from_std(stream),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "the plugin's connection ended; it is restarted with its next start",
            )),
        }
    }

    /// The local connection to the plugin, checked to end at the process `pid`.
    #[cfg(windows)]
    async fn connect(&self, pid: u32) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        self.pipe.accept(pid).await
    }
}

/// Named pipes Kalzit creates for a plugin (Windows): its connection and its network connector.
#[cfg(windows)]
pub mod windows_pipe {
    use std::os::windows::io::AsRawHandle;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::core::HSTRING;

    /// Kalzit's account, the start's SID (a restricting SID of the plugin's token) and the
    /// plugin's AppContainer may open the pipe; labelled low, so the plugin at low integrity may
    /// write it.
    pub fn sddl(start_sid: &str, app_container_sid: &str) -> std::io::Result<String> {
        let user = crate::data_dir::acl::current_user()?;
        // Read and write for the plugin, never the right to change the pipe's security.
        Ok(format!("D:P(A;;GA;;;{user})(A;;0x12019f;;;{start_sid})(A;;0x12019f;;;{app_container_sid})S:(ML;;NW;;;LW)"))
    }

    /// A pipe instance with the descriptor `sddl`, local clients only.
    pub fn create(address: &str, sddl: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: the descriptor is converted from SDDL, used for the creation and freed.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let mut attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: false.into(),
            };
            let pipe = ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(address, (&raw mut attributes).cast());
            LocalFree(Some(HLOCAL(sd.0)));
            pipe
        }
    }

    /// The process id of a pipe's client.
    pub fn client_pid(server: &NamedPipeServer) -> Option<u32> {
        let mut pid = 0u32;
        // SAFETY: the handle is open for the call; `pid` is a valid out pointer.
        unsafe { GetNamedPipeClientProcessId(HANDLE(server.as_raw_handle()), &mut pid) }.ok()?;
        Some(pid)
    }

    /// A pipe with one instance always waiting for the plugin.
    pub struct Pipe {
        address: String,
        sddl: String,
        waiting: tokio::sync::Mutex<Option<NamedPipeServer>>,
    }

    impl Pipe {
        /// Creates the first instance: the name is Kalzit's from now on.
        pub fn new(address: String, sddl: String) -> std::io::Result<Self> {
            let first = create(&address, &sddl, true)?;
            Ok(Self { address, sddl, waiting: tokio::sync::Mutex::new(Some(first)) })
        }

        /// The next connection of the process `pid`; connections of others are dropped. A new
        /// instance waits for the plugin's next connection.
        pub async fn accept(&self, pid: u32) -> std::io::Result<NamedPipeServer> {
            let mut waiting = self.waiting.lock().await;
            loop {
                let server = match waiting.take() {
                    Some(s) => s,
                    None => create(&self.address, &self.sddl, false)?,
                };
                server.connect().await?;
                *waiting = Some(create(&self.address, &self.sddl, false)?);
                if client_pid(&server) == Some(pid) {
                    return Ok(server);
                }
                tracing::warn!("a connection to a plugin's pipe from another process was refused");
            }
        }
    }
}

/// A gRPC channel over the checked local connection; every reconnect is checked again.
pub async fn channel(endpoint: Endpoint, pid: u32) -> Result<tonic::transport::Channel, tonic::transport::Error> {
    let endpoint = Arc::new(endpoint);
    let connector = tower::service_fn(move |_: tonic::transport::Uri| {
        let endpoint = endpoint.clone();
        async move { endpoint.connect(pid).await.map(hyper_util::rt::TokioIo::new) }
    });
    tonic::transport::Endpoint::from_static("http://kalzit-plugin.invalid")
        .connect_timeout(std::time::Duration::from_secs(5))
        .http2_keep_alive_interval(std::time::Duration::from_secs(30))
        .keep_alive_timeout(std::time::Duration::from_secs(10))
        .connect_with_connector(connector)
        .await
}
