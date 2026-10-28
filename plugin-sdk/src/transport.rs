//! The local connection between Kalzit and the plugin, per operating system. Only Kalzit's
//! process (`KALZIT_PLUGIN_HOST_PID`) is served.
//!
//! - Linux: `KALZIT_PLUGIN_ADDRESS` is `fd:<n>`, one end of a socket pair Kalzit made: the plugin
//!   serves the protocol on that one connection (its sandbox lets it open no socket).
//! - Windows: the plugin runs in an AppContainer, which cannot create named pipes. Kalzit creates
//!   the pipe `KALZIT_PLUGIN_ADDRESS` and keeps an instance waiting; the plugin connects to it as
//!   a client, checks that the server is Kalzit's process, and serves the protocol over every
//!   connection it makes, with one always ready for Kalzit's next call.

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
    use std::os::windows::io::AsRawHandle;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use futures_util::Stream;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows::core::HSTRING;

    use crate::log;

    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PIPE_BUSY: i32 = 231;

    /// One connection to Kalzit's pipe, as tonic serves a connection.
    pub struct Pipe(NamedPipeClient);

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

    /// The process id of the pipe's server.
    fn server_pid(client: &NamedPipeClient) -> Option<u32> {
        let mut pid = 0u32;
        // SAFETY: the handle is open for the call; `pid` is a valid out pointer.
        unsafe { GetNamedPipeServerProcessId(HANDLE(client.as_raw_handle()), &mut pid) }.ok()?;
        Some(pid)
    }

    /// The next connection to Kalzit: waits in the kernel (a second at a time) while every
    /// instance is taken, and a moment while the pipe has none yet.
    async fn dial(address: &str, host: u32) -> Pipe {
        loop {
            match ClientOptions::new().open(address) {
                Ok(client) if server_pid(&client) == Some(host) => return Pipe(client),
                Ok(_) => {
                    log::warn("the pipe's server is not Kalzit's process; the connection was closed");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    let name = HSTRING::from(address);
                    // SAFETY: a plain wait on the pipe's name, which lives for the call.
                    let _ = tokio::task::spawn_blocking(move || unsafe { WaitNamedPipeW(&name, 1000) }).await;
                }
                Err(e) if e.raw_os_error() == Some(ERROR_FILE_NOT_FOUND) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(e) => {
                    log::warn(&format!("Kalzit's pipe cannot be opened: {e}"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Every connection to Kalzit's pipe, one after the other.
    pub(crate) fn incoming(address: &str, host: u32) -> std::io::Result<impl Stream<Item = std::io::Result<Pipe>>> {
        let address = address.to_string();
        Ok(futures_util::stream::unfold(address, move |address| async move {
            let pipe = dial(&address, host).await;
            Some((Ok(pipe), address))
        }))
    }
}

#[cfg(unix)]
mod unix_socket {
    use tokio::net::{UnixListener, UnixStream};

    use crate::log;

    /// `fd:<n>` (as Kalzit starts a plugin): the one connection Kalzit handed over, connected
    /// already, so the plugin needs no socket of its own (its sandbox allows none). A path (tests
    /// and tools): listens there and yields every connection from the host process
    /// (`SO_PEERCRED`); others are closed.
    pub(crate) fn incoming(
        address: &str,
        host: u32,
    ) -> std::io::Result<futures_util::stream::BoxStream<'static, std::io::Result<UnixStream>>> {
        use futures_util::StreamExt;
        if let Some(fd) = address.strip_prefix("fd:") {
            let fd: std::os::fd::RawFd = fd.parse().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "KALZIT_PLUGIN_ADDRESS is not fd:<n>")
            })?;
            // SAFETY: the inherited descriptor belongs to this process and is taken over once.
            let stream = unsafe { <std::os::unix::net::UnixStream as std::os::fd::FromRawFd>::from_raw_fd(fd) };
            // A copy that closes on exec, so programs the plugin starts do not get the connection.
            let stream = {
                let copy = stream.try_clone()?;
                drop(stream);
                copy
            };
            stream.set_nonblocking(true)?;
            let stream = UnixStream::from_std(stream)?;
            // One connection, then none: the server keeps serving it until Kalzit ends it.
            return Ok(futures_util::stream::once(async move { Ok(stream) })
                .chain(futures_util::stream::pending())
                .boxed());
        }
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
                    Err(e) => {
                        // Out of descriptors for a moment, or a connection gone before it was
                        // accepted: keep listening.
                        log::warn(&format!("a connection could not be accepted: {e}"));
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
        })
        .boxed())
    }
}
