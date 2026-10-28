//! Kalzit's network connector (`ConnectRequest` in the protocol, docs/ARCHITECTURE.md,
//! "Network connector"): a plugin has no network of its own and asks Kalzit for every
//! connection. This module holds the framing both sides share and, with the feature
//! `connector`, the client a plugin uses (`Connector`).
//!
//! One connection to the connector asks for one network connection: the plugin writes a
//! `ConnectRequest`, Kalzit answers a `ConnectResponse`, each preceded by its length (4 bytes,
//! big-endian, at most `MAX_MESSAGE_BYTES`). On Linux the answer carries the connected socket
//! (`SCM_RIGHTS`); on Windows the pipe itself becomes the connection, relayed by Kalzit.

use prost::Message;

/// The name of the addition in `DescribeRequest.features`.
pub const FEATURE: &str = "network_connector";

/// The environment variable with the connector's address: a Unix socket path (Linux) or a pipe
/// name (Windows).
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
    }

    impl Connector {
        /// The connector of this start (`KALZIT_PLUGIN_CONNECTOR`, `KALZIT_PLUGIN_TOKEN`); `None`
        /// when the host did not give one (a host before protocol minor 1).
        pub fn from_env() -> Option<Self> {
            Some(Self { address: std::env::var(super::ENV).ok()?, token: std::env::var("KALZIT_PLUGIN_TOKEN").ok()? })
        }

        pub fn new(address: impl Into<String>, token: impl Into<String>) -> Self {
            Self { address: address.into(), token: token.into() }
        }

        /// A connection to `host:port` for the data source `datasource_id` (its
        /// `Connection.datasource_id`), over which the plugin speaks `protocol` (wrapping the
        /// stream in TLS itself for `TargetProtocol::Tls`). Returns the stream and the address
        /// Kalzit connected to.
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
            };
            imp::connect(&self.address, &super::frame(&request)).await
        }
    }

    /// The address from a decoded answer, or why there is none.
    fn answer(bytes: &[u8]) -> Result<String, ConnectError> {
        let response = pb::ConnectResponse::decode(bytes)
            .map_err(|e| ConnectError::Protocol(format!("undecodable answer: {e}")))?;
        match response.result {
            Some(pb::connect_response::Result::Connected(c)) => Ok(c.address),
            Some(pb::connect_response::Result::Error(e)) => Err(ConnectError::Refused(e)),
            None => Err(ConnectError::Protocol("an empty answer".into())),
        }
    }

    /// A connection Kalzit made: the TCP socket itself (Linux) or the pipe Kalzit relays
    /// (Windows).
    #[derive(Debug)]
    pub struct Stream(imp::Inner);

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
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

        use tokio::io::{AsyncWriteExt, Interest};
        use tokio::net::UnixStream;

        use super::{ConnectError, Stream};

        pub type Inner = tokio::net::TcpStream;

        /// One `recvmsg`: bytes into `buf`, a passed descriptor (if any) into `fd`. Descriptors
        /// beyond the first are closed.
        fn receive(socket: RawFd, buf: &mut [u8], fd: &mut Option<OwnedFd>) -> std::io::Result<usize> {
            // Room for a few descriptors; only one is expected.
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

        pub async fn connect(address: &str, request: &[u8]) -> Result<(Stream, String), ConnectError> {
            let mut socket = UnixStream::connect(address).await?;
            socket.write_all(request).await?;
            let mut bytes = Vec::new();
            let mut fd = None;
            let mut chunk = vec![0u8; 4096];
            let body = loop {
                let n =
                    socket.async_io(Interest::READABLE, || receive(socket.as_raw_fd(), &mut chunk, &mut fd)).await?;
                if n == 0 {
                    return Err(ConnectError::Protocol("the connector closed before it answered".into()));
                }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() >= 4 {
                    let prefix = [bytes[0], bytes[1], bytes[2], bytes[3]];
                    let len = super::super::frame_len(prefix)
                        .ok_or_else(|| ConnectError::Protocol("the answer is too large".into()))?;
                    if bytes.len() >= 4 + len {
                        break &bytes[4..4 + len];
                    }
                }
            };
            let address = super::answer(body)?;
            let fd = fd.ok_or_else(|| ConnectError::Protocol("the answer carried no socket".into()))?;
            let stream = std::net::TcpStream::from(fd);
            stream.set_nonblocking(true)?;
            Ok((Stream(tokio::net::TcpStream::from_std(stream)?), address))
        }
    }

    #[cfg(windows)]
    mod imp {
        use std::time::Duration;

        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::windows::named_pipe::ClientOptions;

        use super::{ConnectError, Stream};

        pub type Inner = tokio::net::windows::named_pipe::NamedPipeClient;

        const ERROR_PIPE_BUSY: i32 = 231;

        pub async fn connect(address: &str, request: &[u8]) -> Result<(Stream, String), ConnectError> {
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
            pipe.write_all(request).await?;
            let mut prefix = [0u8; 4];
            pipe.read_exact(&mut prefix).await?;
            let len = super::super::frame_len(prefix)
                .ok_or_else(|| ConnectError::Protocol("the answer is too large".into()))?;
            let mut body = vec![0u8; len];
            pipe.read_exact(&mut body).await?;
            let address = super::answer(&body)?;
            Ok((Stream(pipe), address))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::v1 as pb;

    #[test]
    fn frames_carry_their_length() {
        let request = pb::ConnectRequest { host: "db".into(), port: 5432, ..Default::default() };
        let bytes = frame(&request);
        let len = frame_len(bytes[..4].try_into().unwrap()).unwrap();
        assert_eq!(len, bytes.len() - 4);
        assert_eq!(pb::ConnectRequest::decode(&bytes[4..]).unwrap(), request);
        assert_eq!(frame_len((MAX_MESSAGE_BYTES as u32 + 1).to_be_bytes()), None);
    }
}
