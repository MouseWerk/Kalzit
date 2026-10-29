//! The sandbox a plugin process runs in (docs/ARCHITECTURE.md, "Sandbox").
//!
//! Linux, each layer where the kernel offers it (the ones in force are reported, none is
//! required): `no_new_privs`; Landlock (the file system read-only and only where a process
//! needs it: the system libraries, a few files of `/etc`, `/proc`, `/sys`, the device files
//! `null`, `zero`, `full`, `random` and `urandom`, the plugin's package to read and run, its run
//! directory to write); seccomp (no `ptrace`, no other process's memory, no mounts, no
//! namespaces, no kernel modules or `kexec`, no `bpf`, `perf_event_open`, `userfaultfd` or
//! keyrings; `socket` for Unix sockets only, so no network of its own); a user, an IPC and a
//! network namespace (only an unconfigured loopback device); no core dumps and a limit on the
//! data segment; its own process group (all of it is killed), and it is killed when Kalzit ends
//! (`PR_SET_PDEATHSIG`). Network connections come from Kalzit's connector (`connector`).
//!
//! Windows: a restricted token (no privileges but "bypass traverse checking", Administrators
//! deny-only, restricting SIDs Everyone, Users, `RESTRICTED`, the plugin's and the start's; what
//! any local account may read stays closed through the AppContainer check below): the
//! plugin can open only what one of these may open, so not Kalzit's data directory, only its
//! package to read and run and its run directory to write); an AppContainer of its own without
//! capabilities (no network, not even loopback; the connector is its way out); a job object
//! (killed with Kalzit, no breakaway, limits on memory and processes, optional CPU cap, no
//! desktop, clipboard or global atoms); image load policy (system DLLs first, no images from
//! remote shares or with a low label).

#[cfg(target_os = "linux")]
pub use linux::spawn;
#[cfg(target_os = "linux")]
pub use linux::{LANDLOCK_REFUSED, landlock_available};
#[cfg(windows)]
pub use windows::{app_container, label_low, remove_app_container, spawn};

/// The AppContainer of a plugin's processes (Windows only; empty elsewhere).
#[cfg(not(windows))]
pub fn app_container(_installation: &std::path::Path, _id: &str) -> std::io::Result<String> {
    Ok(String::new())
}

/// Removes the AppContainer profile of a removed plugin (Windows only).
#[cfg(not(windows))]
pub fn remove_app_container(_installation: &std::path::Path, _id: &str) {}

/// What `kalzit sandbox-check` found: the layers a plugin started now would run with.
#[derive(Debug)]
pub struct CheckReport {
    pub layers: Vec<&'static str>,
    pub missing: Vec<&'static str>,
    /// How the started program ended, and what it printed.
    pub exit: String,
    pub output: String,
}

impl std::fmt::Display for CheckReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "sandbox layers in force: {}", self.layers.join(" "))?;
        writeln!(
            f,
            "sandbox layers missing: {}",
            if self.missing.is_empty() { "none".into() } else { self.missing.join(" ") }
        )?;
        // The probe prints its capability sets, one `capabilities ...` line.
        writeln!(f, "{}", self.output.trim())?;
        write!(f, "test program: {}", self.exit)
    }
}

/// What `kalzit sandbox-probe` prints: the capability sets of this process, from
/// `/proc/self/status`, as `capabilities ambient <hex> bounding <hex> effective <hex> permitted <hex>`.
pub fn probe() -> String {
    match std::fs::read_to_string("/proc/self/status") {
        Ok(status) => capability_line(&status),
        Err(e) => format!("capabilities unknown: {e}"),
    }
}

fn capability_line(status: &str) -> String {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name).map(|v| v.trim().to_string()))
            .unwrap_or_else(|| "unknown".into())
    };
    format!(
        "capabilities ambient {} bounding {} effective {} permitted {}",
        field("CapAmb:"),
        field("CapBnd:"),
        field("CapEff:"),
        field("CapPrm:")
    )
}

#[cfg(test)]
mod check_tests {
    #[test]
    fn the_probe_reads_the_capability_sets() {
        let status = "Name:\tkalzit\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\n\
                      CapEff:\t0000000000000000\nCapBnd:\t0000000000000400\nCapAmb:\t0000000000000400\n";
        assert_eq!(
            super::capability_line(status),
            "capabilities ambient 0000000000000400 bounding 0000000000000400 effective 0000000000000000 \
             permitted 0000000000000000"
        );
        assert!(super::capability_line("Name:\tx\n").contains("ambient unknown"));
    }
}

/// Starts this binary (`kalzit sandbox-probe`) the way a plugin is started (Linux), so an operator sees
/// which layers this system and the service's own restrictions (systemd hardening, a container)
/// leave in force. Plugins run with what this reports.
#[cfg(target_os = "linux")]
pub async fn check() -> anyhow::Result<CheckReport> {
    use anyhow::Context;
    use tokio::io::AsyncReadExt;
    if runs_as_root() {
        anyhow::bail!(
            "Kalzit runs as root, so plugins are refused; run it as a service account (the packages use `kalzit`)"
        );
    }
    let exe = std::env::current_exe().context("finding this program")?;
    let package_dir = exe.parent().context("the program's folder")?.to_path_buf();
    let run = tempfile::Builder::new().prefix("kalzit-sandbox-check-").tempdir().context("a run directory")?;
    let tmp_dir = run.path().join("tmp");
    std::fs::create_dir(&tmp_dir)?;
    let spec = super::process::Spec {
        program: exe,
        args: vec!["sandbox-probe".into()],
        package_dir,
        run_dir: run.path().to_path_buf(),
        tmp_dir,
        env: Vec::new(),
        limits: super::process::Limits::default(),
        plugin_sid: String::new(),
        start_sid: String::new(),
        app_container_sid: String::new(),
        require_landlock: false,
        inherit: Vec::new(),
    };
    let mut child = spawn(&spec).context("starting the test program in the sandbox")?;
    let mut output = String::new();
    child.stdout.read_to_string(&mut output).await.context("reading the test program's output")?;
    let exit = child
        .exited
        .wait_for(Option::is_some)
        .await
        .map(|e| e.clone().unwrap_or_default())
        .unwrap_or_else(|_| "unknown".into());
    Ok(CheckReport { layers: child.layers, missing: child.missing, exit, output })
}

/// The check starts a program in the Linux sandbox; elsewhere there is nothing to check here.
#[cfg(not(target_os = "linux"))]
pub async fn check() -> anyhow::Result<CheckReport> {
    anyhow::bail!("the sandbox check runs on Linux; on Windows the plugin page shows the layers of each plugin")
}

/// Whether Kalzit runs as root (Linux): plugins are refused then, as a sandboxed process of root
/// would still be root.
pub fn runs_as_root() -> bool {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: geteuid cannot fail.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Whether this kernel offers Landlock (Linux only).
#[cfg(not(target_os = "linux"))]
pub fn landlock_available() -> bool {
    false
}

/// Plugins run on Windows and Linux only.
#[cfg(not(any(windows, target_os = "linux")))]
pub fn spawn(_spec: &super::process::Spec) -> std::io::Result<super::process::Child> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "plugins run on Windows and Linux only"))
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::sync::Arc;

    use tokio::sync::watch;

    use super::super::process::{Child, Control, Spec};

    // Landlock (include/uapi/linux/landlock.h).
    const CREATE_RULESET_VERSION: u32 = 1;
    const RULE_PATH_BENEATH: u32 = 1;
    const EXECUTE: u64 = 1 << 0;
    const WRITE_FILE: u64 = 1 << 1;
    const READ_FILE: u64 = 1 << 2;
    const READ_DIR: u64 = 1 << 3;
    const MAKE_CHAR: u64 = 1 << 6;
    const MAKE_BLOCK: u64 = 1 << 11;
    const REFER: u64 = 1 << 13;
    const TRUNCATE: u64 = 1 << 14;
    const IOCTL_DEV: u64 = 1 << 15;

    /// ABI 6: signals and abstract Unix sockets only within the sandbox.
    const SCOPE_ABSTRACT_UNIX_SOCKET: u64 = 1 << 0;
    const SCOPE_SIGNAL: u64 = 1 << 1;

    /// `landlock_ruleset_attr`; older kernels get only its first field (`size`), ABI 6 all.
    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
        handled_access_net: u64,
        scoped: u64,
    }

    #[repr(C, packed)]
    struct PathBeneath {
        allowed_access: u64,
        parent_fd: i32,
    }

    // Seccomp and BPF (include/uapi/linux/seccomp.h, filter.h, audit.h).
    const BPF_LD_W_ABS: u16 = 0x20;
    const BPF_JMP_JEQ_K: u16 = 0x15;
    const BPF_JMP_JSET_K: u16 = 0x45;
    const BPF_ALU_AND_K: u16 = 0x54;
    const BPF_RET_K: u16 = 0x06;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH: u32 = 0xC000_003E;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH: u32 = 0xC000_00B7;
    const EPERM: u32 = 1;
    const EACCES: u32 = 13;
    const ENOSYS: u32 = 38;
    /// `seccomp_data`: the number at 0, the architecture at 4, the first argument's low half at 16.
    const ARG0: u32 = 16;
    /// The `CLONE_NEW*` flags: a new namespace of any kind.
    const CLONE_NAMESPACES: u32 = 0x0002_0000 // NEWNS
        | 0x0200_0000 // NEWCGROUP
        | 0x0400_0000 // NEWUTS
        | 0x0800_0000 // NEWIPC
        | 0x1000_0000 // NEWUSER
        | 0x2000_0000 // NEWPID
        | 0x4000_0000 // NEWNET
        | 0x0000_0080; // NEWTIME

    /// The error `spawn` answers when Landlock is required but did not take (`ENOTSUP`).
    pub const LANDLOCK_REFUSED: i32 = libc::ENOTSUP;

    // `prctl` reads its arguments as `unsigned long`.
    const ZERO: libc::c_ulong = 0;
    const ONE: libc::c_ulong = 1;

    // What the child reports back, one bit per layer.
    const NO_NEW_PRIVS: u16 = 1;
    const USER_NAMESPACE: u16 = 2;
    const IPC_NAMESPACE: u16 = 4;
    const LANDLOCK: u16 = 8;
    const SECCOMP: u16 = 16;
    const MEMORY_LIMIT: u16 = 32;
    const SIGNALS: u16 = 64;
    /// No network sockets (part of the seccomp filter).
    const NETWORK: u16 = 128;
    const NETWORK_NAMESPACE: u16 = 256;
    const NAMES: [(u16, &str); 9] = [
        (NO_NEW_PRIVS, "no_new_privs"),
        (USER_NAMESPACE, "user_namespace"),
        (IPC_NAMESPACE, "ipc_namespace"),
        (NETWORK_NAMESPACE, "network_namespace"),
        (LANDLOCK, "landlock"),
        (SECCOMP, "seccomp"),
        (NETWORK, "network"),
        (MEMORY_LIMIT, "memory_limit"),
        (SIGNALS, "signals"),
    ];

    /// The system calls the filter refuses with `EPERM`.
    fn denied() -> Vec<libc::c_long> {
        let mut calls = vec![
            libc::SYS_ptrace,
            libc::SYS_process_vm_readv,
            libc::SYS_process_vm_writev,
            libc::SYS_pidfd_getfd,
            libc::SYS_mount,
            libc::SYS_umount2,
            libc::SYS_pivot_root,
            libc::SYS_open_tree,
            libc::SYS_move_mount,
            libc::SYS_fsopen,
            libc::SYS_fsconfig,
            libc::SYS_fsmount,
            libc::SYS_fspick,
            libc::SYS_mount_setattr,
            libc::SYS_setns,
            libc::SYS_unshare,
            libc::SYS_swapon,
            libc::SYS_swapoff,
            libc::SYS_reboot,
            libc::SYS_kexec_load,
            libc::SYS_kexec_file_load,
            libc::SYS_init_module,
            libc::SYS_finit_module,
            libc::SYS_delete_module,
            libc::SYS_bpf,
            libc::SYS_perf_event_open,
            libc::SYS_userfaultfd,
            libc::SYS_keyctl,
            libc::SYS_add_key,
            libc::SYS_request_key,
            libc::SYS_open_by_handle_at,
            libc::SYS_acct,
            libc::SYS_quotactl,
            libc::SYS_lookup_dcookie,
            libc::SYS_io_uring_setup,
            libc::SYS_io_uring_enter,
            libc::SYS_io_uring_register,
            libc::SYS_pidfd_send_signal,
            libc::SYS_tkill,
            libc::SYS_name_to_handle_at,
            // After its own `setsid` the plugin leads a session of its own; it may not move
            // into another process group (Kalzit's) to reach it with `kill(0)`.
            libc::SYS_setpgid,
            libc::SYS_setsid,
        ];
        #[cfg(target_arch = "x86_64")]
        calls.extend([libc::SYS_iopl, libc::SYS_ioperm]);
        calls
    }

    /// The filter: other architectures killed; `denied` with `EPERM`; `truncate` and
    /// `ftruncate` too where Landlock cannot hold them (ABI below 3); `clone3` with `ENOSYS`
    /// (its flags are out of reach of a filter; the C library falls back to `clone`); `clone`
    /// with any `CLONE_NEW*` flag with `EPERM`; the rest allowed.
    fn filter(truncate_unguarded: bool) -> Vec<libc::sock_filter> {
        let op = |code: u16, jt: u8, jf: u8, k: u32| libc::sock_filter { code, jt, jf, k };
        let errno = libc::SECCOMP_RET_ERRNO | EPERM;
        let mut f = vec![
            op(BPF_LD_W_ABS, 0, 0, 4),
            op(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH),
            op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),
            op(BPF_LD_W_ABS, 0, 0, 0),
        ];
        // The x32 ABI reaches the same calls under other numbers.
        if cfg!(target_arch = "x86_64") {
            f.push(op(BPF_JMP_JSET_K, 0, 1, 0x4000_0000));
            f.push(op(BPF_RET_K, 0, 0, errno));
        }
        let mut calls = denied();
        if truncate_unguarded {
            calls.extend([libc::SYS_truncate, libc::SYS_ftruncate]);
        }
        for nr in calls {
            f.push(op(BPF_JMP_JEQ_K, 0, 1, nr as u32));
            f.push(op(BPF_RET_K, 0, 0, errno));
        }
        f.push(op(BPF_JMP_JEQ_K, 0, 1, libc::SYS_clone3 as u32));
        f.push(op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ERRNO | ENOSYS));
        // No socket of its own, of any family, and no address for one: the connection to Kalzit
        // and the connector arrive as connected socket pairs, and every network connection is a
        // socket pair Kalzit relays. So neither the network nor a Unix socket of the host (a
        // database's, Docker's, D-Bus, `/dev/log`), named or abstract, is reachable.
        let refused = libc::SECCOMP_RET_ERRNO | EACCES;
        for nr in
            [libc::SYS_socket, libc::SYS_connect, libc::SYS_bind, libc::SYS_listen, libc::SYS_accept, libc::SYS_accept4]
        {
            f.push(op(BPF_JMP_JEQ_K, 0, 1, nr as u32));
            f.push(op(BPF_RET_K, 0, 0, refused));
        }
        // socketpair: stream or sequenced packets only (a datagram pair could `sendto` a
        // datagram socket of the host by its path).
        f.push(op(BPF_JMP_JEQ_K, 0, 6, libc::SYS_socketpair as u32));
        f.push(op(BPF_LD_W_ABS, 0, 0, ARG0 + 8));
        f.push(op(BPF_ALU_AND_K, 0, 0, !((libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK) as u32)));
        f.push(op(BPF_JMP_JEQ_K, 2, 0, libc::SOCK_STREAM as u32));
        f.push(op(BPF_JMP_JEQ_K, 1, 0, libc::SOCK_SEQPACKET as u32));
        f.push(op(BPF_RET_K, 0, 0, refused));
        f.push(op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ALLOW));
        // sendto, sendmsg, sendmmsg: no TCP Fast Open (a connect in disguise). The flags are the
        // fourth, third and fourth argument.
        for (nr, arg) in [(libc::SYS_sendto, 3), (libc::SYS_sendmsg, 2), (libc::SYS_sendmmsg, 3)] {
            f.push(op(BPF_JMP_JEQ_K, 0, 4, nr as u32));
            f.push(op(BPF_LD_W_ABS, 0, 0, ARG0 + 8 * arg));
            f.push(op(BPF_JMP_JSET_K, 0, 1, libc::MSG_FASTOPEN as u32));
            f.push(op(BPF_RET_K, 0, 0, refused));
            f.push(op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ALLOW));
        }
        // clone: the flags are the first argument (x86_64 and aarch64 alike).
        f.push(op(BPF_JMP_JEQ_K, 0, 3, libc::SYS_clone as u32));
        f.push(op(BPF_LD_W_ABS, 0, 0, ARG0));
        f.push(op(BPF_JMP_JSET_K, 0, 1, CLONE_NAMESPACES));
        f.push(op(BPF_RET_K, 0, 0, errno));
        f.push(op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ALLOW));
        f
    }

    /// Signals only to the plugin itself and its process group (`kill(0)`, `kill(-pid)`,
    /// threads of its own process): Kalzit and other processes of the account are out of reach.
    /// Built in the child, which knows its own process id, on the stack.
    fn signal_filter(pid: u32) -> [libc::sock_filter; 15] {
        let op = |code: u16, jt: u8, jf: u8, k: u32| libc::sock_filter { code, jt, jf, k };
        [
            op(BPF_LD_W_ABS, 0, 0, 4),
            op(BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH),
            op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),
            op(BPF_LD_W_ABS, 0, 0, 0),
            op(BPF_JMP_JEQ_K, 4, 0, libc::SYS_kill as u32),
            op(BPF_JMP_JEQ_K, 3, 0, libc::SYS_tgkill as u32),
            op(BPF_JMP_JEQ_K, 2, 0, libc::SYS_rt_sigqueueinfo as u32),
            op(BPF_JMP_JEQ_K, 1, 0, libc::SYS_rt_tgsigqueueinfo as u32),
            op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ALLOW),
            op(BPF_LD_W_ABS, 0, 0, ARG0),
            op(BPF_JMP_JEQ_K, 3, 0, 0),
            op(BPF_JMP_JEQ_K, 2, 0, pid),
            op(BPF_JMP_JEQ_K, 1, 0, pid.wrapping_neg()),
            op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ERRNO | EPERM),
            op(BPF_RET_K, 0, 0, libc::SECCOMP_RET_ALLOW),
        ]
    }

    /// Whether this kernel offers Landlock.
    pub fn landlock_available() -> bool {
        landlock_abi() > 0
    }

    /// The Landlock ABI of the running kernel; 0 without Landlock.
    fn landlock_abi() -> libc::c_long {
        // SAFETY: the version query takes no attribute and changes nothing.
        let abi = unsafe {
            libc::syscall(
                libc::SYS_landlock_create_ruleset,
                std::ptr::null::<RulesetAttr>(),
                0usize,
                CREATE_RULESET_VERSION,
            )
        };
        abi.max(0)
    }

    fn handled(abi: libc::c_long) -> u64 {
        if abi < 1 {
            return 0;
        }
        let mut access = (1u64 << 13) - 1;
        if abi >= 2 {
            access |= REFER;
        }
        if abi >= 3 {
            access |= TRUNCATE;
        }
        if abi >= 5 {
            access |= IOCTL_DEV;
        }
        access
    }

    /// Read-only places every process needs: libraries, a few files of `/etc` (name lookup,
    /// certificates, time zones, users), and `/proc` and `/sys` (Landlock keeps the plugin away
    /// from other processes' `/proc` entries itself).
    const READ_ONLY: &[&str] = &[
        "/usr",
        "/lib",
        "/lib32",
        "/lib64",
        "/libx32",
        "/bin",
        "/sbin",
        "/proc",
        "/sys",
        "/etc/ssl",
        "/etc/pki",
        "/etc/ca-certificates",
        "/etc/ld.so.conf.d",
        "/etc/ld.so.cache",
        "/etc/ld.so.conf",
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/host.conf",
        "/etc/nsswitch.conf",
        "/etc/gai.conf",
        "/etc/services",
        "/etc/protocols",
        "/etc/localtime",
        "/etc/passwd",
        "/etc/group",
    ];
    const DEVICES: &[&str] = &["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom"];

    /// Everything the child does between fork and exec, prepared beforehand: the child only
    /// makes system calls with what is here (no allocation after the fork).
    struct Plan {
        abi: libc::c_long,
        handled: u64,
        rules: Vec<(OwnedFd, u64)>,
        filter: Vec<libc::sock_filter>,
        uid: libc::uid_t,
        uid_map: Vec<u8>,
        gid_map: Vec<u8>,
        uid_map_path: CString,
        gid_map_path: CString,
        setgroups_path: CString,
        memory: u64,
        status: RawFd,
        /// Landlock must take, or the plugin does not start.
        require_landlock: bool,
        /// Descriptors the plugin gets, by their number.
        inherit: Vec<RawFd>,
    }

    fn open_path(path: &Path) -> Option<(OwnedFd, bool)> {
        let c = CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: `c` is a NUL-terminated path; O_PATH opens no data, O_CLOEXEC keeps it from the plugin.
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_PATH | libc::O_CLOEXEC) };
        if fd < 0 {
            return None;
        }
        // SAFETY: `fd` was just opened and is owned here.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
        Some((fd, is_dir))
    }

    impl Plan {
        fn new(spec: &Spec, status: RawFd) -> Self {
            let abi = landlock_abi();
            let handled = handled(abi);
            let mut rules = Vec::new();
            let file_rights = EXECUTE | READ_FILE;
            let mut add = |path: &Path, dir_rights: u64, file_only: u64| {
                if let Some((fd, is_dir)) = open_path(path) {
                    let rights = if is_dir { dir_rights } else { file_only };
                    rules.push((fd, rights & handled));
                }
            };
            for p in READ_ONLY {
                add(Path::new(p), EXECUTE | READ_FILE | READ_DIR, file_rights);
            }
            for p in DEVICES {
                add(Path::new(p), 0, READ_FILE | WRITE_FILE | TRUNCATE | IOCTL_DEV);
            }
            add(&spec.package_dir, EXECUTE | READ_FILE | READ_DIR, file_rights);
            // Write, but neither run nor make devices.
            add(&spec.run_dir, handled & !(EXECUTE | MAKE_CHAR | MAKE_BLOCK), READ_FILE | WRITE_FILE | TRUNCATE);
            // SAFETY: getuid and getgid cannot fail.
            let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
            Plan {
                abi,
                handled,
                rules,
                filter: filter(abi < 3),
                uid,
                uid_map: format!("{uid} {uid} 1\n").into_bytes(),
                gid_map: format!("{gid} {gid} 1\n").into_bytes(),
                uid_map_path: CString::new("/proc/self/uid_map").expect("no NUL"),
                gid_map_path: CString::new("/proc/self/gid_map").expect("no NUL"),
                setgroups_path: CString::new("/proc/self/setgroups").expect("no NUL"),
                memory: spec.limits.memory_bytes,
                status,
                require_landlock: spec.require_landlock,
                inherit: spec.inherit.clone(),
            }
        }

        /// Writes `bytes` to the file at `path`; only system calls.
        fn write_file(path: &CString, bytes: &[u8]) -> bool {
            // SAFETY: `path` is NUL-terminated and `bytes` valid for its length.
            unsafe {
                let fd = libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                if fd < 0 {
                    return false;
                }
                let n = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
                libc::close(fd);
                n == bytes.len() as isize
            }
        }

        /// Runs in the child between fork and exec. Each layer that fails is left out and
        /// reported; the plugin then runs with the others.
        fn apply(&self) -> std::io::Result<()> {
            let mut layers = 0u16;
            // SAFETY: only system calls on data prepared before the fork.
            unsafe {
                // No capability of Kalzit's reaches the plugin: the ambient set (the packaged
                // service has CAP_NET_BIND_SERVICE there, which exec would hand on) is cleared
                // first, whatever else takes. The bounding set is dropped further down.
                libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL as libc::c_ulong, ZERO, ZERO, ZERO);
                // A session and process group of its own, outside Kalzit's: the plugin's group
                // is killed as a whole, and `kill(0)` reaches only it.
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, ZERO, ZERO, ZERO);
                let no_core = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
                libc::setrlimit(libc::RLIMIT_CORE, &no_core);
                let data = libc::rlimit { rlim_cur: self.memory, rlim_max: self.memory };
                if libc::setrlimit(libc::RLIMIT_DATA, &data) == 0 {
                    layers |= MEMORY_LIMIT;
                }
                // A user namespace mapping the account to itself; only for a non-root account,
                // which keeps no capabilities after exec.
                if self.uid != 0
                    && libc::unshare(libc::CLONE_NEWUSER) == 0
                    && Self::write_file(&self.setgroups_path, b"deny\n")
                    && Self::write_file(&self.uid_map_path, &self.uid_map)
                    && Self::write_file(&self.gid_map_path, &self.gid_map)
                {
                    layers |= USER_NAMESPACE;
                    if libc::unshare(libc::CLONE_NEWIPC) == 0 {
                        layers |= IPC_NAMESPACE;
                    }
                    // A network namespace with nothing but its loopback device (not up): the
                    // sockets Kalzit's connector hands over stay in the host's namespace.
                    if libc::unshare(libc::CLONE_NEWNET) == 0 {
                        layers |= NETWORK_NAMESPACE;
                    }
                }
                // Every capability out of the bounding set, so no exec can gain one. This needs
                // CAP_SETPCAP, which the process has in its own user namespace; without one the
                // calls fail and the ambient set above is what keeps the capabilities away.
                for cap in 0..=63 {
                    libc::prctl(libc::PR_CAPBSET_DROP, cap as libc::c_ulong, ZERO, ZERO, ZERO);
                }
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, ONE, ZERO, ZERO, ZERO) == 0 {
                    layers |= NO_NEW_PRIVS;
                }
                let scoped = self.abi >= 6;
                let mut signals_scoped = false;
                if self.handled != 0 && layers & NO_NEW_PRIVS != 0 {
                    let attr = RulesetAttr {
                        handled_access_fs: self.handled,
                        handled_access_net: 0,
                        scoped: if scoped { SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL } else { 0 },
                    };
                    let size = if scoped { std::mem::size_of::<RulesetAttr>() } else { std::mem::size_of::<u64>() };
                    let ruleset = libc::syscall(libc::SYS_landlock_create_ruleset, &raw const attr, size, 0u32);
                    if ruleset >= 0 {
                        let ruleset = ruleset as libc::c_int;
                        let mut all = true;
                        for (fd, access) in &self.rules {
                            let rule = PathBeneath { allowed_access: *access, parent_fd: fd.as_raw_fd() };
                            if *access != 0
                                && libc::syscall(
                                    libc::SYS_landlock_add_rule,
                                    ruleset,
                                    RULE_PATH_BENEATH,
                                    &raw const rule,
                                    0u32,
                                ) != 0
                            {
                                all = false;
                            }
                        }
                        if all && libc::syscall(libc::SYS_landlock_restrict_self, ruleset, 0u32) == 0 {
                            layers |= LANDLOCK;
                            signals_scoped = scoped;
                        }
                        libc::close(ruleset);
                    }
                }
                if layers & NO_NEW_PRIVS != 0 {
                    let program =
                        libc::sock_fprog { len: self.filter.len() as u16, filter: self.filter.as_ptr().cast_mut() };
                    let mode = libc::SECCOMP_MODE_FILTER as libc::c_ulong;
                    if libc::prctl(libc::PR_SET_SECCOMP, mode, &raw const program, ZERO, ZERO) == 0 {
                        layers |= SECCOMP | NETWORK;
                    }
                    if signals_scoped {
                        layers |= SIGNALS;
                    } else {
                        let signals = signal_filter(libc::getpid() as u32);
                        let program =
                            libc::sock_fprog { len: signals.len() as u16, filter: signals.as_ptr().cast_mut() };
                        if libc::prctl(libc::PR_SET_SECCOMP, mode, &raw const program, ZERO, ZERO) == 0 {
                            layers |= SIGNALS;
                        }
                    }
                }
                // The handed descriptors keep their numbers (named in the plugin's environment);
                // only close-on-exec is cleared, so no descriptor of the child is moved or
                // overwritten.
                for fd in &self.inherit {
                    if libc::fcntl(*fd, libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                libc::write(self.status, (&raw const layers).cast(), 2);
                if self.require_landlock && layers & LANDLOCK == 0 {
                    // `spawn` fails with this error; nothing of the plugin runs.
                    return Err(std::io::Error::from_raw_os_error(LANDLOCK_REFUSED));
                }
            }
            Ok(())
        }
    }

    struct Group {
        pid: u32,
        kill: tokio::sync::Notify,
    }

    impl Control for Group {
        fn kill(&self) {
            self.kill.notify_one();
            // The process group, so children go too.
            // SAFETY: a signal to the group the plugin leads.
            unsafe { libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL) };
        }
    }

    pub fn spawn(spec: &Spec) -> std::io::Result<Child> {
        let mut fds = [0 as RawFd; 2];
        // SAFETY: `fds` has room for both ends.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: both ends were just made and are owned here.
        let (status_read, status_write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        let plan = Arc::new(Plan::new(spec, status_write.as_raw_fd()));
        let mut command = tokio::process::Command::new(&spec.program);
        command
            .args(&spec.args)
            .env_clear()
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .current_dir(&spec.run_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let hook = plan.clone();
        // SAFETY: the hook only makes system calls on data prepared above (`Plan::apply`).
        unsafe { command.pre_exec(move || hook.apply()) };
        let mut child = command.spawn()?;
        drop(status_write);
        drop(plan);
        let mut bits = 0u16;
        // SAFETY: a two-byte read into `bits`; the child wrote it before exec, which `spawn`
        // waited for (a pipe write of two bytes is atomic).
        let read = unsafe { libc::read(status_read.as_raw_fd(), (&raw mut bits).cast(), 2) };
        if read != 2 {
            bits = 0;
        }
        let pid = child.id().ok_or_else(|| std::io::Error::other("the plugin ended at once"))?;
        let stdout = child.stdout.take().ok_or_else(|| std::io::Error::other("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| std::io::Error::other("no stderr"))?;
        let (tx, exited) = watch::channel(None);
        let control = Arc::new(Group { pid, kill: tokio::sync::Notify::new() });
        let watcher = control.clone();
        tokio::spawn(async move {
            let status = tokio::select! {
                status = child.wait() => status,
                () = watcher.kill.notified() => {
                    let _ = child.start_kill();
                    child.wait().await
                }
            };
            // Children the plugin left behind go with it.
            // SAFETY: a signal to the plugin's process group.
            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
            let text = match status {
                Ok(s) => s.to_string(),
                Err(e) => format!("unknown ({e})"),
            };
            let _ = tx.send(Some(text));
        });
        let layers = NAMES.iter().filter(|(bit, _)| bits & bit != 0).map(|(_, name)| *name).collect();
        let missing: Vec<&'static str> =
            NAMES.iter().filter(|(bit, _)| bits & bit == 0).map(|(_, name)| *name).collect();
        Ok(Child { pid, stdout: Box::new(stdout), stderr: Box::new(stderr), layers, missing, exited, control })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_filter_checks_the_architecture_first_and_allows_the_rest() {
            let f = filter(true);
            assert!(f.iter().any(|i| i.k == libc::SYS_truncate as u32));
            assert!(!filter(false).iter().any(|i| i.k == libc::SYS_truncate as u32));
            let s = signal_filter(4242);
            assert_eq!(s[11].k, 4242);
            assert_eq!(s[12].k, (-4242i32) as u32);
            assert_eq!((f[0].code, f[0].k), (BPF_LD_W_ABS, 4));
            assert_eq!((f[1].code, f[1].k), (BPF_JMP_JEQ_K, AUDIT_ARCH));
            assert_eq!(f.last().unwrap().k, libc::SECCOMP_RET_ALLOW);
            assert!(f.len() < 4096);
            assert!(denied().contains(&libc::SYS_ptrace));
            // No socket of its own and no address for one; socket pairs of streams only; no
            // TCP Fast Open.
            let at = |nr: libc::c_long| f.iter().position(|i| i.code == BPF_JMP_JEQ_K && i.k == nr as u32).unwrap();
            for nr in [libc::SYS_socket, libc::SYS_connect, libc::SYS_bind, libc::SYS_listen, libc::SYS_accept4] {
                assert_eq!(f[at(nr) + 1].k, libc::SECCOMP_RET_ERRNO | EACCES, "{nr}");
            }
            let pair = at(libc::SYS_socketpair);
            assert_eq!((f[pair + 1].k, f[pair + 2].code), (ARG0 + 8, BPF_ALU_AND_K));
            assert_eq!((f[pair + 3].k, f[pair + 4].k), (libc::SOCK_STREAM as u32, libc::SOCK_SEQPACKET as u32));
            assert_eq!(f[pair + 5].k, libc::SECCOMP_RET_ERRNO | EACCES);
            let send = at(libc::SYS_sendto);
            assert_eq!((f[send + 1].k, f[send + 2].k), (ARG0 + 24, libc::MSG_FASTOPEN as u32));
        }

        #[test]
        fn landlock_rights_grow_with_the_abi() {
            assert_eq!(handled(0), 0);
            assert_eq!(handled(1) & REFER, 0);
            assert_ne!(handled(2) & REFER, 0);
            assert_ne!(handled(3) & TRUNCATE, 0);
            assert_ne!(handled(5) & IOCTL_DEV, 0);
        }
    }
}

#[cfg(windows)]
mod windows {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use std::sync::Arc;

    use tokio::sync::watch;
    use windows::Win32::Foundation::{
        CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, HLOCAL, LocalFree, SetHandleInformation,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, ConvertStringSidToSidW,
        SDDL_REVISION_1,
    };
    use windows::Win32::Security::Authorization::{SE_FILE_OBJECT, SetNamedSecurityInfoW};
    use windows::Win32::Security::FreeSid;
    use windows::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
        GetAppContainerFolderPath,
    };
    use windows::Win32::Security::{
        ACL, CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, GetLengthSid, GetSecurityDescriptorDacl,
        GetSecurityDescriptorSacl, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_CAPABILITIES,
        SID_AND_ATTRIBUTES, SetTokenInformation, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL,
        TOKEN_DUPLICATE, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TokenDefaultDacl, TokenIntegrityLevel,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
        JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
        JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_UILIMIT, JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions, JobObjectCpuRateControlInformation,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW,
        DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, INFINITE,
        InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST, OpenProcessToken,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES,
        STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
    };
    use windows::core::{HSTRING, PWSTR};

    use super::super::process::{Child, Control, Spec};

    /// `SE_GROUP_INTEGRITY`: the attribute of an integrity label in a token.
    const SE_GROUP_INTEGRITY: u32 = 0x20;
    /// The low integrity level.
    const LOW_INTEGRITY: &str = "S-1-16-4096";

    /// Serializes making the plugin's pipe ends inheritable and creating the process, so no
    /// other process this server starts at the same moment inherits them.
    static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());
    /// Image load policy: no images from remote shares, none with a low label, system32 first.
    const IMAGE_LOAD_POLICY: u64 = (1 << 52) | (1 << 56) | (1 << 60);
    /// Every UI restriction of a job: desktop, display settings, exit, global atoms, handles,
    /// clipboard and system parameters.
    const UI_LIMITS: u32 = 0xFF;

    /// A handle closed on drop.
    struct Owned(HANDLE);

    // SAFETY: a kernel handle may be used and closed from any thread.
    unsafe impl Send for Owned {}
    // SAFETY: as above; the handles here are only passed to thread-safe kernel calls.
    unsafe impl Sync for Owned {}

    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_invalid() && !self.0.0.is_null() {
                // SAFETY: the handle is owned and closed once.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn os(e: windows::core::Error) -> std::io::Error {
        let code = e.code().0 as u32;
        if code & 0xFFFF_0000 == 0x8007_0000 {
            std::io::Error::from_raw_os_error((code & 0xFFFF) as i32)
        } else {
            std::io::Error::other(e.to_string())
        }
    }

    /// A SID from its string form, freed on drop.
    struct Sid(PSID);

    impl Sid {
        fn parse(text: &str) -> std::io::Result<Self> {
            let mut sid = PSID::default();
            // SAFETY: `sid` receives a LocalAlloc'ed SID owned by the returned value.
            unsafe { ConvertStringSidToSidW(&HSTRING::from(text), &mut sid) }.map_err(os)?;
            Ok(Self(sid))
        }
    }

    impl Drop for Sid {
        fn drop(&mut self) {
            // SAFETY: allocated by ConvertStringSidToSidW, freed once.
            unsafe { LocalFree(Some(HLOCAL(self.0.0))) };
        }
    }

    /// A security descriptor from SDDL, freed on drop.
    struct Descriptor(PSECURITY_DESCRIPTOR);

    impl Descriptor {
        fn parse(sddl: &str) -> std::io::Result<Self> {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            // SAFETY: `sd` receives a LocalAlloc'ed descriptor owned by the returned value.
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    &HSTRING::from(sddl),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
            }
            .map_err(os)?;
            Ok(Self(sd))
        }

        fn dacl(&self) -> std::io::Result<*mut ACL> {
            let mut present = windows::core::BOOL::default();
            let mut defaulted = windows::core::BOOL::default();
            let mut dacl: *mut ACL = std::ptr::null_mut();
            // SAFETY: `self.0` is valid; `dacl` points into it.
            unsafe { GetSecurityDescriptorDacl(self.0, &mut present, &mut dacl, &mut defaulted) }.map_err(os)?;
            Ok(dacl)
        }
    }

    impl Drop for Descriptor {
        fn drop(&mut self) {
            // SAFETY: allocated by the conversion, freed once.
            unsafe { LocalFree(Some(HLOCAL(self.0.0))) };
        }
    }

    /// A primary token like Kalzit's, without privileges (but bypass traverse checking), with
    /// Administrators for deny only, restricted to Everyone, Users, `RESTRICTED`, the plugin's
    /// and the start's SID, at low
    /// integrity, and a default DACL that only Kalzit's account, SYSTEM and a SID of this start
    /// pass. Not the logon
    /// session: Kalzit's own process grants it read access, and with it a plugin could read
    /// Kalzit's memory. The low label keeps it from opening Kalzit's process for reading (no read
    /// up on processes) and from writing anything not labelled low; the default DACL keeps other
    /// plugins (restricted tokens all) out of this plugin's process and objects.
    fn restricted_token(plugin_sid: &str, own: &str) -> std::io::Result<Owned> {
        let mut current = HANDLE::default();
        // SAFETY: the pseudo handle of this process; `current` receives a handle owned below.
        unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                &mut current,
            )
        }
        .map_err(os)?;
        let current = Owned(current);
        let disable = [Sid::parse("S-1-5-32-544")?, Sid::parse("S-1-5-114")?];
        // Everyone and Users stay: System32 grants Users (and AppContainers), the NUL device
        // Everyone, and `ALL APPLICATION PACKAGES` cannot be a restricting SID of a token that
        // becomes a lowbox token (the process creation fails). What any local account may read
        // (`kalzit.toml` in ProgramData, a TLS key inheriting its entries) is closed by the
        // AppContainer check instead: those files have no entry for AppContainers (tested).
        // `RESTRICTED` is for what Windows grants restricted processes; the package and run
        // directory grant the plugin's or the start's SID, so plugins do not reach each other's
        // files.
        let restrict = [
            Sid::parse("S-1-1-0")?,
            Sid::parse("S-1-5-32-545")?,
            Sid::parse("S-1-5-12")?,
            Sid::parse(plugin_sid)?,
            Sid::parse(own)?,
        ];
        let restricting: Vec<SID_AND_ATTRIBUTES> =
            restrict.iter().map(|s| SID_AND_ATTRIBUTES { Sid: s.0, Attributes: 0 }).collect();
        let disabling: Vec<SID_AND_ATTRIBUTES> =
            disable.iter().map(|s| SID_AND_ATTRIBUTES { Sid: s.0, Attributes: 0 }).collect();
        let mut token = HANDLE::default();
        // SAFETY: the SID arrays and the buffers they point into live for the call.
        unsafe {
            CreateRestrictedToken(
                current.0,
                DISABLE_MAX_PRIVILEGE,
                Some(&disabling),
                None,
                Some(&restricting),
                &mut token,
            )
        }
        .map_err(os)?;
        let token = Owned(token);
        let user = crate::data_dir::acl::current_user()?;
        let descriptor = Descriptor::parse(&format!("D:(A;;GA;;;{user})(A;;GA;;;SY)(A;;GA;;;{own})"))?;
        let default = TOKEN_DEFAULT_DACL { DefaultDacl: descriptor.dacl()? };
        // SAFETY: `default` points into `descriptor`, alive for the call.
        unsafe {
            SetTokenInformation(
                token.0,
                TokenDefaultDacl,
                (&raw const default).cast(),
                std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        }
        .map_err(os)?;
        let low = Sid::parse(LOW_INTEGRITY)?;
        let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: low.0, Attributes: SE_GROUP_INTEGRITY } };
        // SAFETY: `label` points at `low`, alive for the call; the size covers the SID.
        unsafe {
            SetTokenInformation(
                token.0,
                TokenIntegrityLevel,
                (&raw const label).cast(),
                std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(low.0),
            )
        }
        .map_err(os)?;
        Ok(token)
    }

    /// The AppContainer profile functions fail when two threads use them at once.
    static PROFILES: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The AppContainer name of a plugin of this installation (`installation`: its plugins'
    /// run directory, so two installations under one account never share a container): from
    /// both, within the 64 characters Windows allows.
    fn container_name(installation: &std::path::Path, id: &str) -> HSTRING {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(format!("kalzit-plugin\n{}\n{id}", installation.display()).as_bytes());
        HSTRING::from(format!("kalzit.plugin.{}", &hex::encode(digest)[..32]))
    }

    /// Makes sure the plugin's AppContainer profile exists and answers its SID. Its processes
    /// run in it without any capability: no network of their own, no loopback. Windows sets
    /// `TEMP` and `TMP` of an AppContainer process to the profile's `AC\Temp`; that folder is
    /// emptied and given a DACL for Kalzit's account, the plugin's SID and its AppContainer only.
    pub fn app_container(installation: &std::path::Path, id: &str) -> std::io::Result<String> {
        let sid = app_container_sid(installation, id)?;
        // SAFETY: the SID string lives for the call; the path is freed with CoTaskMemFree.
        let folder = unsafe {
            let path = GetAppContainerFolderPath(&HSTRING::from(sid.as_str())).map_err(os)?;
            let folder = path.to_string().map_err(|e| std::io::Error::other(e.to_string()));
            CoTaskMemFree(Some(path.0.cast_const().cast()));
            folder
        }?;
        let temp = std::path::Path::new(&folder).join("Temp");
        if temp.exists() {
            let _ = std::fs::remove_dir_all(&temp);
        }
        std::fs::create_dir_all(&temp)?;
        let user = crate::data_dir::acl::current_user()?;
        let plugin = crate::plugins::package::plugin_sid(id);
        crate::data_dir::acl::restrict(
            &temp,
            &format!(
                "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{user})(A;OICI;0x13019f;;;{plugin})(A;OICI;0x13019f;;;{sid})"
            ),
        )?;
        label_low(&temp)?;
        Ok(sid)
    }

    fn app_container_sid(installation: &std::path::Path, id: &str) -> std::io::Result<String> {
        /// `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`.
        const ALREADY_EXISTS: i32 = 0x8007_00B7_u32 as i32;
        let _one = PROFILES.lock().unwrap_or_else(|e| e.into_inner());
        let name = container_name(installation, id);
        // SAFETY: the strings live for the calls; the SID returned is freed with FreeSid below.
        let sid = unsafe {
            match CreateAppContainerProfile(&name, &name, &HSTRING::from("A Kalzit data source plugin"), None) {
                Ok(sid) => sid,
                Err(e) if e.code().0 == ALREADY_EXISTS => {
                    DeriveAppContainerSidFromAppContainerName(&name).map_err(os)?
                }
                Err(e) => return Err(os(e)),
            }
        };
        let mut text = PWSTR::null();
        // SAFETY: `sid` is valid until freed; the string is LocalAlloc'ed and freed below.
        let converted = unsafe { ConvertSidToStringSidW(sid, &mut text) };
        // SAFETY: allocated by the profile functions, freed once.
        unsafe { FreeSid(sid) };
        converted.map_err(os)?;
        // SAFETY: a NUL-terminated string from ConvertSidToStringSidW, freed once.
        let out = unsafe {
            let s = text.to_string().map_err(|e| std::io::Error::other(e.to_string()));
            LocalFree(Some(HLOCAL(text.0.cast())));
            s
        }?;
        Ok(out)
    }

    /// Removes the AppContainer profile of a removed plugin; a failure is logged.
    pub fn remove_app_container(installation: &std::path::Path, id: &str) {
        let _one = PROFILES.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: the name lives for the call.
        if let Err(e) = unsafe { DeleteAppContainerProfile(&container_name(installation, id)) } {
            tracing::warn!(plugin = %id, "the plugin's AppContainer profile could not be removed: {e}");
        }
    }

    /// Gives a directory (and what is created in it) the low integrity label, so a plugin at low
    /// integrity may write there; anything without the label it may not write.
    pub fn label_low(path: &std::path::Path) -> std::io::Result<()> {
        let descriptor = Descriptor::parse("S:(ML;OICI;NW;;;LW)")?;
        let mut present = windows::core::BOOL::default();
        let mut defaulted = windows::core::BOOL::default();
        let mut sacl: *mut ACL = std::ptr::null_mut();
        // SAFETY: the descriptor is valid; `sacl` points into it while it lives.
        unsafe { GetSecurityDescriptorSacl(descriptor.0, &mut present, &mut sacl, &mut defaulted) }.map_err(os)?;
        // SAFETY: `sacl` points into `descriptor`, alive for the call.
        let status = unsafe {
            SetNamedSecurityInfoW(
                &HSTRING::from(path.as_os_str()),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                None,
                None,
                None,
                Some(sacl.cast_const()),
            )
        };
        if status.0 == 0 { Ok(()) } else { Err(std::io::Error::from_raw_os_error(status.0 as i32)) }
    }

    /// A job that kills everything in it when its last handle closes, with the limits, and the
    /// layers that took.
    fn job(limits: &super::super::process::Limits) -> std::io::Result<(Owned, Vec<&'static str>)> {
        // SAFETY: an unnamed job with default security.
        let job = Owned(unsafe { CreateJobObjectW(None, None) }.map_err(os)?);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
            | JOB_OBJECT_LIMIT_JOB_MEMORY
            | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        info.BasicLimitInformation.ActiveProcessLimit = limits.max_processes.max(1);
        info.JobMemoryLimit = usize::try_from(limits.memory_bytes).unwrap_or(usize::MAX);
        // SAFETY: `info` is the structure the class names, with its size.
        unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(os)?;
        let mut layers = vec!["job_object", "kill_on_close", "memory_limit", "process_limit"];
        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS { UIRestrictionsClass: JOB_OBJECT_UILIMIT(UI_LIMITS) };
        // SAFETY: as above.
        let ui_set = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectBasicUIRestrictions,
                (&raw const ui).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        };
        if ui_set.is_ok() {
            layers.push("ui_restrictions");
        }
        if let Some(percent) = limits.cpu_percent.filter(|p| (1..100).contains(p)) {
            let mut cpu = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
                ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
                ..Default::default()
            };
            cpu.Anonymous.CpuRate = percent * 100;
            // SAFETY: as above.
            let set = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectCpuRateControlInformation,
                    (&raw const cpu).cast(),
                    std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
                )
            };
            if set.is_ok() {
                layers.push("cpu_limit");
            }
        }
        Ok((job, layers))
    }

    /// A pipe with the plugin's end and ours, neither inheritable; the plugin's end becomes
    /// inheritable only while the process is created (`SPAWN`), and only it is in the handle list.
    fn pipe(child_reads: bool) -> std::io::Result<(Owned, Owned)> {
        let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
        // SAFETY: both out pointers are valid; no security attributes, so not inheritable.
        unsafe { CreatePipe(&mut read, &mut write, None, 0) }.map_err(os)?;
        let (read, write) = (Owned(read), Owned(write));
        Ok(if child_reads { (read, write) } else { (write, read) })
    }

    fn inheritable(handle: &Owned) -> std::io::Result<()> {
        // SAFETY: the handle is owned and open.
        unsafe { SetHandleInformation(handle.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }.map_err(os)
    }

    /// The program, quoted, then the arguments (none have quotes or spaces: plugins get none,
    /// the tests pass plain words), as a command line.
    fn command_line(program: &std::path::Path, args: &[String]) -> Vec<u16> {
        let mut line: Vec<u16> = "\"".encode_utf16().collect();
        line.extend(program.as_os_str().encode_wide());
        line.extend("\"".encode_utf16());
        for arg in args {
            line.push(u16::from(b' '));
            line.extend(arg.encode_utf16());
        }
        line.push(0);
        line
    }

    /// The environment block: `NAME=value` entries, sorted without regard to case, each ended by
    /// a NUL and the block by another.
    fn environment_block(env: &[(String, String)]) -> Vec<u16> {
        let mut entries: Vec<&(String, String)> = env.iter().collect();
        entries.sort_by_key(|(k, _)| k.to_uppercase());
        let mut block = Vec::new();
        for (k, v) in entries {
            block.extend(format!("{k}={v}").encode_utf16());
            block.push(0);
        }
        block.push(0);
        block
    }

    /// Deletes an initialized attribute list on drop.
    struct AttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);

    impl Drop for AttributeList {
        fn drop(&mut self) {
            // SAFETY: the list was initialized and is deleted once, after the process creation.
            unsafe { DeleteProcThreadAttributeList(self.0) };
        }
    }

    struct Job {
        job: Owned,
        process: Arc<Owned>,
    }

    impl Control for Job {
        fn kill(&self) {
            // SAFETY: both handles are owned by `self` and open.
            unsafe {
                let _ = TerminateJobObject(self.job.0, 1);
                let _ = TerminateProcess(self.process.0, 1);
            }
        }
    }

    pub fn spawn(spec: &Spec) -> std::io::Result<Child> {
        let token = restricted_token(&spec.plugin_sid, &spec.start_sid)?;
        let (job, mut layers) = job(&spec.limits)?;
        layers.insert(0, "restricted_token");
        layers.insert(1, "low_integrity");
        let (stdin_child, stdin_ours) = pipe(true)?;
        drop(stdin_ours);
        let (stdout_child, stdout_ours) = pipe(false)?;
        let (stderr_child, stderr_ours) = pipe(false)?;

        let mut size = 0usize;
        // SAFETY: a size query for three attributes; fails with "insufficient buffer" by design.
        let _ = unsafe { InitializeProcThreadAttributeList(None, 3, None, &mut size) };
        let mut attributes = vec![0u64; size.div_ceil(8)];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(attributes.as_mut_ptr().cast());
        // SAFETY: `attributes` holds `size` bytes for the list.
        unsafe { InitializeProcThreadAttributeList(Some(list), 3, None, &mut size) }.map_err(os)?;
        let _guard = AttributeList(list);
        let inherited = [stdin_child.0, stdout_child.0, stderr_child.0];
        // SAFETY: the handle array and the policy outlive the process creation below.
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(inherited.as_ptr().cast()),
                std::mem::size_of_val(&inherited),
                None,
                None,
            )
        }
        .map_err(os)?;
        let policy = IMAGE_LOAD_POLICY;
        // SAFETY: as above.
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY as usize,
                Some((&raw const policy).cast()),
                std::mem::size_of::<u64>(),
                None,
                None,
            )
        }
        .map_err(os)?;
        layers.push("image_load_policy");
        // An AppContainer without capabilities: no network of its own (no `internetClient`,
        // `privateNetworkClientServer` or loopback), Windows makes the restricted token a
        // lowbox token of it. Files pass the AppContainer check through `AC` (`PluginAccess`).
        let container = Sid::parse(&spec.app_container_sid)?;
        let capabilities = SECURITY_CAPABILITIES { AppContainerSid: container.0, ..Default::default() };
        // SAFETY: `capabilities` and the SID it points to outlive the process creation below.
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some((&raw const capabilities).cast()),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
        }
        .map_err(os)?;
        layers.push("app_container");
        layers.push("network");

        let mut info = STARTUPINFOEXW::default();
        info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = stdin_child.0;
        info.StartupInfo.hStdOutput = stdout_child.0;
        info.StartupInfo.hStdError = stderr_child.0;
        info.lpAttributeList = list;
        let mut line = command_line(&spec.program, &spec.args);
        let env = environment_block(&spec.env);
        let mut created = PROCESS_INFORMATION::default();
        let spawning = SPAWN.lock().unwrap_or_else(|e| e.into_inner());
        for handle in [&stdin_child, &stdout_child, &stderr_child] {
            inheritable(handle)?;
        }
        // SAFETY: every pointer refers to data alive for the call; the process starts suspended,
        // so it runs no code before it is in the job.
        unsafe {
            CreateProcessAsUserW(
                Some(token.0),
                &HSTRING::from(spec.program.as_os_str()),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                Some(env.as_ptr().cast()),
                &HSTRING::from(spec.run_dir.as_os_str()),
                &info.StartupInfo,
                &mut created,
            )
        }
        .map_err(os)?;
        let process = Owned(created.hProcess);
        let thread = Owned(created.hThread);
        // SAFETY: the process is suspended and owned here.
        if let Err(e) = unsafe { AssignProcessToJobObject(job.0, process.0) } {
            // SAFETY: as above; it never ran.
            let _ = unsafe { TerminateProcess(process.0, 1) };
            return Err(os(e));
        }
        // SAFETY: the main thread of the suspended process.
        unsafe { ResumeThread(thread.0) };
        drop(thread);
        drop((stdin_child, stdout_child, stderr_child));
        drop(spawning);
        // SAFETY: our pipe ends are owned; the files take them over and close them.
        let (stdout, stderr) = unsafe {
            let out = std::fs::File::from_raw_handle(stdout_ours.0.0);
            let err = std::fs::File::from_raw_handle(stderr_ours.0.0);
            std::mem::forget(stdout_ours);
            std::mem::forget(stderr_ours);
            (tokio::fs::File::from_std(out), tokio::fs::File::from_std(err))
        };
        let pid = created.dwProcessId;
        let process = Arc::new(process);
        let control = Arc::new(Job { job, process: process.clone() });
        let (tx, exited) = watch::channel(None);
        // The waiter holds the process, not the job: when every holder of the job is gone (also
        // when Kalzit's runtime shuts down after a failure), the job closes and kills the
        // plugin, and the wait ends.
        let job = Arc::downgrade(&control);
        tokio::task::spawn_blocking(move || {
            let mut code = 0u32;
            // SAFETY: the process handle stays open while `process` lives.
            unsafe {
                WaitForSingleObject(process.0, INFINITE);
                let _ = GetExitCodeProcess(process.0, &mut code);
            }
            // Whatever the plugin started goes with it.
            if let Some(job) = job.upgrade() {
                // SAFETY: the job handle is open while `job` lives.
                let _ = unsafe { TerminateJobObject(job.job.0, 1) };
            }
            let _ = tx.send(Some(format!("exit code {code}")));
        });
        Ok(Child {
            pid,
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            layers,
            missing: Vec::new(),
            exited,
            control,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn environment_blocks_are_sorted_and_terminated() {
            let env = [("b".to_string(), "2".to_string()), ("A".to_string(), "1".to_string())];
            let block = String::from_utf16(&environment_block(&env)).unwrap();
            assert_eq!(block, "A=1\0b=2\0\0");
        }

        #[test]
        fn a_restricted_token_can_be_made() {
            restricted_token(
                &crate::plugins::package::plugin_sid("dev.example.t"),
                &crate::plugins::package::start_sid(),
            )
            .unwrap();
        }
    }
}
