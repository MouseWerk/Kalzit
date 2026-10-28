//! The local connection Kalzit opens to the plugin, per operating system. Only Kalzit's process
//! (`KALZIT_PLUGIN_HOST_PID`) may connect; connections from any other process are closed before
//! a byte is read.

#[cfg(windows)]
pub(crate) use windows_pipe::incoming;

#[cfg(unix)]
pub(crate) use unix_socket::incoming;

#[cfg(not(any(windows, unix)))]
pub(crate) fn incoming(
    _address: &str,
    _host: u32,
) -> std::io::Result<futures_util::stream::Empty<std::io::Result<tokio::net::TcpStream>>> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "plugins run on Windows and Linux"))
}

#[cfg(windows)]
mod windows_pipe {
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_util::Stream;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::{HSTRING, PWSTR};

    use crate::log;

    fn os_error(e: windows::core::Error) -> std::io::Error {
        std::io::Error::other(e.to_string())
    }

    /// The SID of the account this process runs as: Kalzit's account (a plugin's restricted
    /// token keeps the user).
    pub(crate) fn user_sid() -> std::io::Result<String> {
        // SAFETY: token queries into a buffer of the size asked for; the token handle and the
        // string are released before returning.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(os_error)?;
            let mut needed = 0u32;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let read = GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr().cast()), needed, &mut needed);
            let _ = windows::Win32::Foundation::CloseHandle(token);
            read.map_err(os_error)?;
            let mut text = PWSTR::null();
            ConvertSidToStringSidW((*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut text).map_err(os_error)?;
            let sid = text.to_string().map_err(|e| std::io::Error::other(e.to_string()));
            LocalFree(Some(HLOCAL(text.0.cast())));
            sid
        }
    }

    /// The pipe's DACL: full access for Kalzit's account, and for `RESTRICTED`, which the
    /// plugin's restricted token needs to create the next instance. Protected, so nothing is
    /// inherited.
    pub(crate) fn sddl(user: &str) -> String {
        format!("D:P(A;;GA;;;{user})(A;;GA;;;RC)")
    }

    /// Creates one pipe instance; the first one must be the first of its name, so no other
    /// process can own the name before the plugin.
    fn create(address: &str, sddl: &str, first: bool) -> std::io::Result<NamedPipeServer> {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: the descriptor is converted from SDDL, used while the pipe is created and
        // freed after.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(&HSTRING::from(sddl), SDDL_REVISION_1, &mut sd, None)
                .map_err(os_error)?;
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

    /// One accepted pipe instance, as tonic serves a connection.
    pub struct Pipe(NamedPipeServer);

    impl tonic::transport::server::Connected for Pipe {
        type ConnectInfo = ();
        fn connect_info(&self) {}
    }

    impl AsyncRead for Pipe {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for Pipe {
        fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
            Pin::new(&mut self.0).poll_write(cx, buf)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_flush(cx)
        }
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_shutdown(cx)
        }
    }

    /// The process id of the pipe's client.
    fn client_pid(server: &NamedPipeServer) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        let mut pid = 0u32;
        // SAFETY: the handle is open for the call; `pid` is a valid out pointer.
        unsafe { GetNamedPipeClientProcessId(HANDLE(server.as_raw_handle()), &mut pid) }.ok()?;
        Some(pid)
    }

    /// Creates the pipe as its first instance and yields every client that is the host, with a
    /// fresh instance waiting for the next one.
    pub(crate) fn incoming(address: &str, host: u32) -> std::io::Result<impl Stream<Item = std::io::Result<Pipe>>> {
        let sddl = sddl(&user_sid()?);
        let first = create(address, &sddl, true)?;
        let address = address.to_string();
        Ok(futures_util::stream::unfold(Some(first), move |server| {
            let (address, sddl) = (address.clone(), sddl.clone());
            async move {
                let mut server = server?;
                loop {
                    if let Err(e) = server.connect().await {
                        return Some((Err(e), None));
                    }
                    if client_pid(&server) == Some(host) {
                        break;
                    }
                    log::warn("a connection from another process was refused");
                    server = match create(&address, &sddl, false) {
                        Ok(next) => next,
                        Err(e) => return Some((Err(e), None)),
                    };
                }
                let next = match create(&address, &sddl, false) {
                    Ok(next) => Some(next),
                    Err(e) => {
                        log::error(&format!("the next pipe instance could not be created: {e}"));
                        None
                    }
                };
                Some((Ok(Pipe(server)), next))
            }
        }))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn the_dacl_names_the_account_and_restricted_only() {
            let sid = super::user_sid().unwrap();
            assert!(sid.starts_with("S-1-"), "{sid}");
            assert_eq!(super::sddl(&sid), format!("D:P(A;;GA;;;{sid})(A;;GA;;;RC)"));
        }
    }
}

#[cfg(unix)]
mod unix_socket {
    use futures_util::Stream;
    use tokio::net::{UnixListener, UnixStream};

    use crate::log;

    /// Listens on the socket in the start's private run directory and yields every connection
    /// from the host process (`SO_PEERCRED`); others are closed.
    pub(crate) fn incoming(
        address: &str,
        host: u32,
    ) -> std::io::Result<impl Stream<Item = std::io::Result<UnixStream>>> {
        let listener = UnixListener::bind(address)?;
        Ok(futures_util::stream::unfold(listener, move |listener| async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let pid = stream.peer_cred().ok().and_then(|c| c.pid());
                        if pid == i32::try_from(host).ok() {
                            return Some((Ok(stream), listener));
                        }
                        log::warn("a connection from another process was refused");
                    }
                    Err(e) => return Some((Err(e), listener)),
                }
            }
        }))
    }
}
