//! Kalzit's network connector (`ConnectRequest` in the protocol, docs/ARCHITECTURE.md,
//! "Network connector"): a plugin has no network of its own and asks Kalzit for every
//! connection. This module holds the framing both sides share and, with the feature
//! `connector`, the client a plugin uses (`Connector`).
//!
//! Every message is preceded by its length (4 bytes, big-endian, at most `MAX_MESSAGE_BYTES`).
//! Linux: requests and answers share one inherited `SOCK_SEQPACKET` socket (`fd:<n>`), matched by
//! `request_id`; an answer carries one end of a new stream socket pair (`SCM_RIGHTS`) that
//! Kalzit relays to the TCP connection it holds. The connector belongs to the process that
//! opened it (close-on-exec; a forked child does not use it). Windows: one pipe connection per
//! request; after the answer the pipe itself is the connection, relayed by Kalzit.

use prost::Message;

/// The name of the addition in `DescribeRequest.features`.
pub const FEATURE: &str = "network_connector";

/// The environment variable with the connector's address: `fd:<n>`, an inherited socket (Linux),
/// or a pipe name (Windows).
pub const ENV: &str = "KALZIT_PLUGIN_CONNECTOR";

/// The largest request or answer either side accepts.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// `message` with its length in front.
pub fn frame(message: &impl Message) -> Vec<u8> {
    let body = message.encode_to_vec();
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

/// The length a frame announces in its first four bytes; `None` when it is above
/// `MAX_MESSAGE_BYTES`.
pub fn frame_len(prefix: [u8; 4]) -> Option<usize> {
    let len = u32::from_be_bytes(prefix) as usize;
    (len <= MAX_MESSAGE_BYTES).then_some(len)
}

/// The body of a whole frame in `bytes`, or `None` when `bytes` is not exactly one frame.
pub fn frame_body(bytes: &[u8]) -> Option<&[u8]> {
    let prefix: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    let len = frame_len(prefix)?;
    (bytes.len() == 4 + len).then(|| &bytes[4..])
}

#[cfg(feature = "connector")]
pub use client::{ConnectError, Connector, Stream};

#[cfg(feature = "connector")]
mod client {
    use std::fmt;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use prost::Message;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    use crate::datasource::v1 as pb;

    /// Why a connection was not made.
    #[derive(Debug)]
    pub enum ConnectError {
        /// Kalzit refused it: not a declared target, a refused address, over the limit. The
        /// detail's reason is a `target.*` or `plugin.*` reason a plugin may pass on.
        Refused(pb::Error),
        /// The connector could not be reached, or the connection broke.
        Io(std::io::Error),
        /// The answer was not one the protocol allows.
        Protocol(String),
    }

    impl fmt::Display for ConnectError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                ConnectError::Refused(e) => {
                    let detail = e.detail.clone().unwrap_or_default();
                    write!(f, "Kalzit refused the connection ({}): {}", detail.reason, detail.message)
                }
                ConnectError::Io(e) => write!(f, "the connector failed: {e}"),
                ConnectError::Protocol(m) => write!(f, "the connector answered wrongly: {m}"),
            }
        }
    }

    impl std::error::Error for ConnectError {}

    impl From<std::io::Error> for ConnectError {
        fn from(e: std::io::Error) -> Self {
            ConnectError::Io(e)
        }
    }

    /// The client of the connector, from the plugin's environment.
    #[derive(Clone, Debug)]
    pub struct Connector {
        address: String,
        token: String,
        /// Kalzit's process id (`KALZIT_PLUGIN_HOST_PID`): on Windows the pipe's server must be it.
        host_pid: Option<u32>,
    }

    impl Connector {
        /// The connector of this start (`KALZIT_PLUGIN_CONNECTOR`, `KALZIT_PLUGIN_TOKEN`,
        /// `KALZIT_PLUGIN_HOST_PID`); `None` when the host did not give one (a host before
        /// protocol minor 1). Read it before the token leaves the environment.
        pub fn from_env() -> Option<Self> {
            Some(Self {
                address: std::env::var(super::ENV).ok()?,
                token: std::env::var("KALZIT_PLUGIN_TOKEN").ok()?,
                host_pid: std::env::var("KALZIT_PLUGIN_HOST_PID").ok().and_then(|p| p.parse().ok()),
            })
        }

        pub fn new(address: impl Into<String>, token: impl Into<String>, host_pid: Option<u32>) -> Self {
            Self { address: address.into(), token: token.into(), host_pid }
        }

        /// A connection to `host:port` for the data source `datasource_id` (its
        /// `Connection.datasource_id`), over which the plugin speaks `protocol` (wrapping the
        /// stream in TLS itself for `TargetProtocol::Tls`; Kalzit checks the protocol against the
        /// manifest but does not enforce it). Returns the stream and the address Kalzit connected
        /// to.
        pub async fn connect(
            &self,
            datasource_id: &str,
            host: &str,
            port: u16,
            protocol: pb::TargetProtocol,
        ) -> Result<(Stream, String), ConnectError> {
            let request = pb::ConnectRequest {
                token: self.token.clone(),
                datasource_id: datasource_id.to_string(),
                host: host.to_string(),
                port: u32::from(port),
                protocol: protocol as i32,
                request_id: 0,
            };
            imp::connect(&self.address, self.host_pid, request).await
        }
    }

    /// The decoded answer: its request id, and the address or why there is none.
    fn answer(bytes: &[u8]) -> Result<(u64, Result<String, ConnectError>), ConnectError> {
        let response = pb::ConnectResponse::decode(bytes)
            .map_err(|e| ConnectError::Protocol(format!("undecodable answer: {e}")))?;
        let result = match response.result {
            Some(pb::connect_response::Result::Connected(c)) => Ok(c.address),
            Some(pb::connect_response::Result::Error(e)) => Err(ConnectError::Refused(e)),
            None => Err(ConnectError::Protocol("an empty answer".into())),
        };
        Ok((response.request_id, result))
    }

    /// A connection Kalzit made and relays: one end of a socket pair (Linux) or a pipe (Windows).
    /// The TCP connection itself stays with Kalzit.
    #[derive(Debug)]
    pub struct Stream(imp::Inner);

    #[cfg(unix)]
    impl std::os::fd::AsRawFd for Stream {
        fn as_raw_fd(&self) -> std::os::fd::RawFd {
            self.0.as_raw_fd()
        }
    }

    impl AsyncRead for Stream {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for Stream {
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

    #[cfg(unix)]
    mod imp {
        use std::collections::HashMap;
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::sync::{Arc, Mutex};

        use tokio::io::unix::AsyncFd;
        use tokio::sync::oneshot;

        use super::{ConnectError, Stream, pb};

        pub type Inner = tokio::net::UnixStream;

        /// What the reader hands a waiting request: the answer's body and the socket it carried.
        type Reply = (Vec<u8>, Option<OwnedFd>);

        /// The one connector socket of this process, shared by every request.
        struct Mux {
            socket: AsyncFd<OwnedFd>,
            waiting: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
            next: AtomicU64,
        }

        static MUX: Mutex<Option<(String, Arc<Mux>)>> = Mutex::new(None);

        /// The shared socket for `address` (`fd:<n>`), its reader started on first use.
        fn mux(address: &str) -> std::io::Result<Arc<Mux>> {
            let mut current = MUX.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((a, m)) = current.as_ref()
                && a == address
            {
                return Ok(m.clone());
            }
            let fd: RawFd = address.strip_prefix("fd:").and_then(|n| n.parse().ok()).ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "the connector's address is not fd:<n>")
            })?;
            // SAFETY: fcntl only queries the flags of a number; it fails for a closed one.
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: the inherited descriptor belongs to this process and is taken over once
            // (guarded by `MUX`); it is made non-blocking and close-on-exec.
            let owned = unsafe {
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                OwnedFd::from_raw_fd(fd)
            };
            // SAFETY: an `OwnedFd` keeps its one open descriptor until the `AsyncFd` drops it.
            let socket = unsafe { AsyncFd::register(owned) }?;
            let m = Arc::new(Mux { socket, waiting: Mutex::default(), next: AtomicU64::new(1) });
            tokio::spawn(read(m.clone()));
            *current = Some((address.to_string(), m.clone()));
            Ok(m)
        }

        /// One `recvmsg`: one message into `buf`, a passed descriptor (if any) into `fd`.
        /// Descriptors beyond the first are closed.
        fn receive(socket: RawFd, buf: &mut [u8], fd: &mut Option<OwnedFd>) -> std::io::Result<usize> {
            let mut control = [0u64; 8];
            let mut iov = libc::iovec { iov_base: buf.as_mut_ptr().cast(), iov_len: buf.len() };
            // SAFETY: a zeroed msghdr is valid; the pointers below refer to buffers alive for the call.
            let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
            msg.msg_iov = &raw mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = control.as_mut_ptr().cast();
            msg.msg_controllen = std::mem::size_of_val(&control) as _;
            // SAFETY: `msg` describes valid buffers; descriptors arrive close-on-exec.
            let n = unsafe { libc::recvmsg(socket, &raw mut msg, libc::MSG_CMSG_CLOEXEC) };
            if n < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: the control buffer was filled by the kernel; the macros walk it within
            // `msg_controllen`.
            unsafe {
                let mut cmsg = libc::CMSG_FIRSTHDR(&raw const msg);
                while !cmsg.is_null() {
                    if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                        let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
                        let count = ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / size_of::<RawFd>();
                        for i in 0..count {
                            let received = OwnedFd::from_raw_fd(data.add(i).read_unaligned());
                            if fd.is_none() {
                                *fd = Some(received);
                            }
                        }
                    }
                    cmsg = libc::CMSG_NXTHDR(&raw const msg, cmsg);
                }
            }
            Ok(n as usize)
        }

        /// Hands every answer to its request; at the end of the socket every request fails.
        async fn read(m: Arc<Mux>) {
            let mut buf = vec![0u8; super::super::MAX_MESSAGE_BYTES + 4];
            loop {
                let Ok(mut guard) = m.socket.readable().await else { break };
                let mut fd = None;
                let read = guard.try_io(|inner| receive(inner.as_raw_fd(), &mut buf, &mut fd));
                let n = match read {
                    Err(_would_block) => continue,
                    Ok(Ok(0)) | Ok(Err(_)) => break,
                    Ok(Ok(n)) => n,
                };
                let Some(body) = super::super::frame_body(&buf[..n]) else { continue };
                let Ok((id, _)) = super::answer(body) else { continue };
                let sender = m.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send((body.to_vec(), fd));
                }
            }
            m.waiting.lock().unwrap_or_else(|e| e.into_inner()).clear();
            // A broken socket is not used again.
            let mut current = MUX.lock().unwrap_or_else(|e| e.into_inner());
            if current.as_ref().is_some_and(|(_, c)| Arc::ptr_eq(c, &m)) {
                *current = None;
            }
        }

        pub async fn connect(
            address: &str,
            _host_pid: Option<u32>,
            mut request: pb::ConnectRequest,
        ) -> Result<(Stream, String), ConnectError> {
            let m = mux(address)?;
            // Unique also should another process (a fork) share the socket by mistake; the
            // connector belongs to the process that opened it.
            let id = (u64::from(std::process::id()) << 32) | (m.next.fetch_add(1, Ordering::Relaxed) & 0xffff_ffff);
            request.request_id = id;
            let bytes = super::super::frame(&request);
            let (tx, rx) = oneshot::channel();
            m.waiting.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
            let sent = loop {
                let mut guard = m.socket.writable().await?;
                let sent = guard.try_io(|inner| {
                    // SAFETY: one message from a buffer alive for the call.
                    let n = unsafe {
                        libc::send(inner.as_raw_fd(), bytes.as_ptr().cast(), bytes.len(), libc::MSG_NOSIGNAL)
                    };
                    if n < 0 { Err(std::io::Error::last_os_error()) } else { Ok(n as usize) }
                });
                if let Ok(result) = sent {
                    break result;
                }
            };
            if let Err(e) = sent {
                m.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                return Err(e.into());
            }
            let (body, fd) =
                rx.await.map_err(|_| ConnectError::Protocol("the connector closed before it answered".into()))?;
            let (_, result) = super::answer(&body)?;
            let address = result?;
            let fd = fd.ok_or_else(|| ConnectError::Protocol("the answer carried no socket".into()))?;
            // One end of a socket pair Kalzit relays to the TCP connection it holds.
            let stream = std::os::unix::net::UnixStream::from(fd);
            stream.set_nonblocking(true)?;
            Ok((Stream(tokio::net::UnixStream::from_std(stream)?), address))
        }
    }

    #[cfg(windows)]
    mod imp {
        use std::os::windows::io::AsRawHandle;
        use std::time::Duration;

        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::windows::named_pipe::ClientOptions;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;

        use super::{ConnectError, Stream, pb};

        pub type Inner = tokio::net::windows::named_pipe::NamedPipeClient;

        const ERROR_PIPE_BUSY: i32 = 231;

        pub async fn connect(
            address: &str,
            host_pid: Option<u32>,
            request: pb::ConnectRequest,
        ) -> Result<(Stream, String), ConnectError> {
            let mut tries = 0;
            let mut pipe = loop {
                match ClientOptions::new().open(address) {
                    Ok(pipe) => break pipe,
                    Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && tries < 250 => {
                        tries += 1;
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    Err(e) => return Err(e.into()),
                }
            };
            // The token goes only to Kalzit's process.
            if let Some(host) = host_pid {
                let mut server = 0u32;
                // SAFETY: the handle is open for the call; `server` is a valid out pointer.
                let known = unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut server) }.is_ok();
                if !known || server != host {
                    return Err(ConnectError::Io(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "the connector's pipe does not belong to Kalzit's process",
                    )));
                }
            }
            pipe.write_all(&super::super::frame(&request)).await?;
            let mut prefix = [0u8; 4];
            pipe.read_exact(&mut prefix).await?;
            let len = super::super::frame_len(prefix)
                .ok_or_else(|| ConnectError::Protocol("the answer is too large".into()))?;
            let mut body = vec![0u8; len];
            pipe.read_exact(&mut body).await?;
            let (_, result) = super::answer(&body)?;
            Ok((Stream(pipe), result?))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::v1 as pb;

    #[test]
    fn frames_carry_their_length() {
        let request = pb::ConnectRequest { host: "db".into(), port: 5432, request_id: 7, ..Default::default() };
        let bytes = frame(&request);
        let len = frame_len(bytes[..4].try_into().unwrap()).unwrap();
        assert_eq!(len, bytes.len() - 4);
        assert_eq!(pb::ConnectRequest::decode(frame_body(&bytes).unwrap()).unwrap(), request);
        assert_eq!(frame_body(&bytes[..bytes.len() - 1]), None);
        assert_eq!(frame_len((MAX_MESSAGE_BYTES as u32 + 1).to_be_bytes()), None);
    }
}
