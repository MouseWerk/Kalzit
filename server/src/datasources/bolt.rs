//! A Bolt client for Neo4j and Memgraph: PackStream values, Bolt 4.4 and 5.0 to 5.8, TLS through
//! rustls, read transactions.
//!
//! Why not the `neo4rs` crate (the plan's first choice): its current stable release (0.8) and
//! its 0.9 release candidates resolve the host name and open the TCP connection themselves, and
//! take the TLS server name from the same host. Kalzit's target rule is that a name is resolved
//! once, the address is checked, and the connection goes to that checked address while the name
//! is kept for the certificate check (docs/ARCHITECTURE.md, "Targets"); neo4rs has no way to hand
//! it a connected stream or a separate TLS name. It also reads a private CA only from a file
//! path (Kalzit stores the PEM in the settings), does not expose the server's agent string, and
//! decodes whole batches without a byte limit per record. The protocol subset Kalzit needs
//! (handshake, HELLO/LOGON, BEGIN in read mode, RUN, PULL, ROLLBACK, RESET) is small and fully
//! specified, so it lives here, with the TCP stream opened by `TargetPolicy::connect`.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufStream};

use super::SourceError;
use super::targets::TargetPolicy;

/// Values nested deeper than this are refused instead of recursing further.
const MAX_DEPTH: usize = 64;
const MAX_CHUNK: usize = 0xFFFF;
/// Entries reserved ahead for a list or map, whatever count the server claims.
const PREALLOCATE: usize = 1024;
const USER_AGENT: &str = concat!("Kalzit/", env!("CARGO_PKG_VERSION"));

/// A PackStream value.
#[derive(Clone, Debug, PartialEq)]
pub enum Bv {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Bytes(Vec<u8>),
    String(String),
    List(Vec<Bv>),
    /// Entries in the order the server sent them.
    Map(Vec<(String, Bv)>),
    Struct(u8, Vec<Bv>),
}

impl Bv {
    pub fn get(&self, key: &str) -> Option<&Bv> {
        match self {
            Bv::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Bv::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Bv::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn as_list(&self) -> Option<&[Bv]> {
        match self {
            Bv::List(l) => Some(l),
            _ => None,
        }
    }

    fn map(entries: Vec<(&str, Bv)>) -> Bv {
        Bv::Map(entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }
}

// ---- PackStream ----

pub fn encode(v: &Bv, out: &mut Vec<u8>) {
    match v {
        Bv::Null => out.push(0xC0),
        Bv::Bool(false) => out.push(0xC2),
        Bv::Bool(true) => out.push(0xC3),
        Bv::Int(i) => {
            let i = *i;
            if (-16..=127).contains(&i) {
                out.push(i as i8 as u8);
            } else if (-128..=127).contains(&i) {
                out.push(0xC8);
                out.push(i as i8 as u8);
            } else if (-32_768..=32_767).contains(&i) {
                out.push(0xC9);
                out.extend_from_slice(&(i as i16).to_be_bytes());
            } else if (-2_147_483_648..=2_147_483_647).contains(&i) {
                out.push(0xCA);
                out.extend_from_slice(&(i as i32).to_be_bytes());
            } else {
                out.push(0xCB);
                out.extend_from_slice(&i.to_be_bytes());
            }
        }
        Bv::Float(f) => {
            out.push(0xC1);
            out.extend_from_slice(&f.to_be_bytes());
        }
        Bv::Bytes(b) => {
            size_marker(out, b.len(), None, [0xCC, 0xCD, 0xCE]);
            out.extend_from_slice(b);
        }
        Bv::String(s) => {
            size_marker(out, s.len(), Some(0x80), [0xD0, 0xD1, 0xD2]);
            out.extend_from_slice(s.as_bytes());
        }
        Bv::List(items) => {
            size_marker(out, items.len(), Some(0x90), [0xD4, 0xD5, 0xD6]);
            for item in items {
                encode(item, out);
            }
        }
        Bv::Map(entries) => {
            size_marker(out, entries.len(), Some(0xA0), [0xD8, 0xD9, 0xDA]);
            for (k, v) in entries {
                encode(&Bv::String(k.clone()), out);
                encode(v, out);
            }
        }
        Bv::Struct(tag, fields) => {
            out.push(0xB0 | (fields.len() as u8 & 0x0F));
            out.push(*tag);
            for f in fields {
                encode(f, out);
            }
        }
    }
}

fn size_marker(out: &mut Vec<u8>, len: usize, tiny: Option<u8>, markers: [u8; 3]) {
    match tiny {
        Some(base) if len < 16 => out.push(base | len as u8),
        _ if len <= 0xFF => {
            out.push(markers[0]);
            out.push(len as u8);
        }
        _ if len <= 0xFFFF => {
            out.push(markers[1]);
            out.extend_from_slice(&(len as u16).to_be_bytes());
        }
        _ => {
            out.push(markers[2]);
            out.extend_from_slice(&(len as u32).to_be_bytes());
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], BoltError> {
        let end =
            self.at.checked_add(n).filter(|e| *e <= self.bytes.len()).ok_or_else(|| protocol("truncated value"))?;
        let s = &self.bytes[self.at..end];
        self.at = end;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8, BoltError> {
        Ok(self.take(1)?[0])
    }

    fn len(&mut self, width: usize) -> Result<usize, BoltError> {
        let b = self.take(width)?;
        Ok(match width {
            1 => b[0] as usize,
            2 => u16::from_be_bytes([b[0], b[1]]) as usize,
            _ => u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize,
        })
    }

    /// A length of items, each at least one byte: more than the bytes left is a broken message,
    /// refused before anything is allocated for it.
    fn count(&mut self, width: usize) -> Result<usize, BoltError> {
        let n = self.len(width)?;
        if n > self.bytes.len() - self.at {
            return Err(protocol("a length beyond the message"));
        }
        Ok(n)
    }

    fn string(&mut self, n: usize) -> Result<String, BoltError> {
        String::from_utf8(self.take(n)?.to_vec()).map_err(|_| protocol("a string that is not UTF-8"))
    }

    fn value(&mut self, depth: usize) -> Result<Bv, BoltError> {
        if depth > MAX_DEPTH {
            return Err(protocol("values nested too deep"));
        }
        let m = self.u8()?;
        Ok(match m {
            0x00..=0x7F => Bv::Int(m as i64),
            0xF0..=0xFF => Bv::Int(m as i8 as i64),
            0x80..=0x8F => Bv::String(self.string((m & 0x0F) as usize)?),
            0x90..=0x9F => self.list((m & 0x0F) as usize, depth)?,
            0xA0..=0xAF => self.map((m & 0x0F) as usize, depth)?,
            0xB0..=0xBF => {
                let tag = self.u8()?;
                let mut fields = Vec::with_capacity((m & 0x0F) as usize);
                for _ in 0..(m & 0x0F) {
                    fields.push(self.value(depth + 1)?);
                }
                Bv::Struct(tag, fields)
            }
            0xC0 => Bv::Null,
            0xC1 => {
                let b = self.take(8)?;
                Bv::Float(f64::from_be_bytes(b.try_into().expect("8 bytes")))
            }
            0xC2 => Bv::Bool(false),
            0xC3 => Bv::Bool(true),
            0xC8 => Bv::Int(self.take(1)?[0] as i8 as i64),
            0xC9 => Bv::Int(i16::from_be_bytes(self.take(2)?.try_into().expect("2 bytes")) as i64),
            0xCA => Bv::Int(i32::from_be_bytes(self.take(4)?.try_into().expect("4 bytes")) as i64),
            0xCB => Bv::Int(i64::from_be_bytes(self.take(8)?.try_into().expect("8 bytes"))),
            0xCC..=0xCE => {
                let n = self.len(1 << (m - 0xCC))?;
                Bv::Bytes(self.take(n)?.to_vec())
            }
            0xD0..=0xD2 => {
                let n = self.len(1 << (m - 0xD0))?;
                Bv::String(self.string(n)?)
            }
            0xD4..=0xD6 => {
                let n = self.count(1 << (m - 0xD4))?;
                self.list(n, depth)?
            }
            0xD8..=0xDA => {
                let n = self.count(1 << (m - 0xD8))?;
                self.map(n, depth)?
            }
            other => return Err(protocol(&format!("unknown marker 0x{other:02X}"))),
        })
    }

    fn list(&mut self, n: usize, depth: usize) -> Result<Bv, BoltError> {
        // A count is only a claim; space grows with what actually arrives.
        let mut items = Vec::with_capacity(n.min(PREALLOCATE));
        for _ in 0..n {
            items.push(self.value(depth + 1)?);
        }
        Ok(Bv::List(items))
    }

    fn map(&mut self, n: usize, depth: usize) -> Result<Bv, BoltError> {
        let mut entries = Vec::with_capacity(n.min(PREALLOCATE));
        for _ in 0..n {
            let Bv::String(key) = self.value(depth + 1)? else {
                return Err(protocol("a map key that is not a string"));
            };
            entries.push((key, self.value(depth + 1)?));
        }
        Ok(Bv::Map(entries))
    }
}

pub fn decode(bytes: &[u8]) -> Result<Bv, BoltError> {
    let mut r = Reader { bytes, at: 0 };
    let v = r.value(0)?;
    if r.at != bytes.len() {
        return Err(protocol("bytes after the value"));
    }
    Ok(v)
}

// ---- messages ----

#[derive(Debug, thiserror::Error)]
pub enum BoltError {
    #[error("{0}")]
    Io(String),
    #[error("the server broke the Bolt protocol: {0}")]
    Protocol(String),
    /// The server's FAILURE: its status code and message.
    #[error("{message}")]
    Failure { code: String, message: String },
    /// A message larger than allowed (the response size budget).
    #[error("a message from the server is larger than {0} bytes")]
    TooLarge(usize),
}

fn protocol(what: &str) -> BoltError {
    BoltError::Protocol(what.to_string())
}

impl From<std::io::Error> for BoltError {
    fn from(e: std::io::Error) -> Self {
        BoltError::Io(e.to_string())
    }
}

impl BoltError {
    pub fn into_source(self) -> SourceError {
        match self {
            BoltError::Failure { code, message } => {
                // Writes a read transaction refused (Neo4j: Neo.ClientError.Statement.AccessMode).
                if code.contains("AccessMode") || code.contains("ForbiddenDueToTransactionType") {
                    SourceError::rejected("query.write_refused", format!("the query tried to write: {message}"))
                        .with("detail", message)
                } else {
                    SourceError::from_source(message)
                }
            }
            BoltError::TooLarge(_) => SourceError::failed("bolt.too_large", self.to_string()),
            BoltError::Protocol(_) => SourceError::failed("bolt.protocol", self.to_string()).with("detail", self),
            BoltError::Io(message) => SourceError::from_source(message),
        }
    }
}

const SUCCESS: u8 = 0x70;
const RECORD: u8 = 0x71;
const IGNORED: u8 = 0x7E;
const FAILURE: u8 = 0x7F;

#[derive(Debug)]
pub enum Response {
    Success(Bv),
    Record(Vec<Bv>),
    Ignored,
}

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// TLS for a Bolt connection.
pub struct Tls {
    /// PEM certificates trusted in addition to the platform's store.
    pub ca_pem: Option<String>,
    /// Accept any certificate (for tests only; the settings form says so).
    pub trust_any: bool,
}

pub struct ConnectOptions<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: Option<&'a str>,
    pub password: Option<&'a str>,
    pub tls: Option<Tls>,
    pub timeout: Duration,
}

/// One authenticated Bolt connection.
pub struct BoltConn {
    stream: BufStream<Box<dyn Stream>>,
    /// (major, minor) agreed in the handshake.
    pub version: (u8, u8),
    /// DateTime values arrive as UTC seconds (Bolt 5, or 4.4 with the `utc` patch).
    pub utc: bool,
    /// The server's agent string from HELLO, such as `Neo4j/5.26.0`.
    pub server: String,
    /// The connection is in an unknown state (a result read only in part, a failed reset, a broken
    /// stream) and must be closed, not reused.
    pub broken: bool,
}

fn tls_config(tls: &Tls) -> Result<rustls::ClientConfig, SourceError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| SourceError::failed("bolt.tls", format!("TLS setup failed: {e}")).with("detail", e))?;
    if tls.trust_any {
        return Ok(builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
            .with_no_client_auth());
    }
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for e in &native.errors {
        tracing::warn!("reading the platform's certificates: {e}");
    }
    roots.add_parsable_certificates(native.certs);
    if let Some(pem) = tls.ca_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        use rustls::pki_types::pem::PemObject;
        for cert in rustls::pki_types::CertificateDer::pem_slice_iter(pem.as_bytes()) {
            let cert = cert.map_err(|e| {
                SourceError::failed("bolt.tls", format!("the CA certificate is not valid PEM: {e}")).with("detail", e)
            })?;
            roots.add(cert).map_err(|e| {
                SourceError::failed("bolt.tls", format!("the CA certificate cannot be used: {e}")).with("detail", e)
            })?;
        }
    }
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

/// Accepts every certificate, but still checks the handshake signatures.
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// The versions Kalzit offers: 5.8 down to 5.0, then 4.4.
const PROPOSALS: [[u8; 4]; 4] = [[0, 8, 8, 5], [0, 0, 4, 4], [0; 4], [0; 4]];

/// Connects to the checked address of `host`, with TLS against the name `host`, agrees on a
/// version and logs in.
pub async fn connect(policy: &TargetPolicy, opts: ConnectOptions<'_>) -> Result<BoltConn, SourceError> {
    let (_, tcp) = policy.connect(opts.host, opts.port, opts.timeout).await?;
    tcp.set_nodelay(true).map_err(|e| SourceError::from_source(e.to_string()))?;
    let stream: Box<dyn Stream> = match &opts.tls {
        None => Box::new(tcp),
        Some(tls) => {
            let config = tls_config(tls)?;
            let name = rustls::pki_types::ServerName::try_from(opts.host.trim_matches(['[', ']']).to_string())
                .map_err(|e| SourceError::failed("bolt.tls", format!("{} cannot be checked: {e}", opts.host)))?;
            let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
            let tls = tokio::time::timeout(opts.timeout, connector.connect(name, tcp))
                .await
                .map_err(|_| {
                    SourceError::failed("bolt.login_timeout", "the server did not complete the login in time")
                })?
                .map_err(|e| SourceError::failed("bolt.tls", format!("TLS failed: {e}")).with("detail", e))?;
            Box::new(tls)
        }
    };
    let login = async {
        let mut conn = BoltConn {
            stream: BufStream::new(stream),
            version: (0, 0),
            utc: false,
            server: String::new(),
            broken: false,
        };
        conn.handshake().await?;
        conn.login(opts.user, opts.password).await?;
        Ok::<_, BoltError>(conn)
    };
    tokio::time::timeout(opts.timeout, login)
        .await
        .map_err(|_| SourceError::failed("bolt.login_timeout", "the server did not complete the login in time"))?
        .map_err(BoltError::into_source)
}

impl BoltConn {
    async fn handshake(&mut self) -> Result<(), BoltError> {
        let mut hello = vec![0x60, 0x60, 0xB0, 0x17];
        for p in PROPOSALS {
            hello.extend_from_slice(&p);
        }
        self.stream.write_all(&hello).await?;
        self.stream.flush().await?;
        let mut answer = [0u8; 4];
        self.stream.read_exact(&mut answer).await?;
        let version = (answer[3], answer[2]);
        let supported = matches!(version, (5, 0..=8) | (4, 4));
        if !supported {
            return Err(BoltError::Protocol(format!(
                "no common Bolt version (the server answered {}.{}; Kalzit speaks 4.4 and 5.0 to 5.8)",
                version.0, version.1
            )));
        }
        self.version = version;
        Ok(())
    }

    async fn login(&mut self, user: Option<&str>, password: Option<&str>) -> Result<(), BoltError> {
        let auth = match user.filter(|u| !u.is_empty()) {
            Some(u) => vec![
                ("scheme", Bv::String("basic".into())),
                ("principal", Bv::String(u.into())),
                ("credentials", Bv::String(password.unwrap_or("").into())),
            ],
            None => vec![("scheme", Bv::String("none".into()))],
        };
        let mut hello = vec![("user_agent", Bv::String(USER_AGENT.into()))];
        let logon = self.version >= (5, 1);
        if self.version >= (5, 3) {
            hello.push(("bolt_agent", Bv::map(vec![("product", Bv::String(USER_AGENT.into()))])));
        }
        if !logon {
            hello.extend(auth.clone());
        }
        if self.version == (4, 4) {
            hello.push(("patch_bolt", Bv::List(vec![Bv::String("utc".into())])));
        }
        let meta = self.request(0x01, vec![Bv::map(hello)]).await?;
        self.server = meta.get("server").and_then(Bv::as_str).unwrap_or_default().to_string();
        self.utc = self.version.0 >= 5
            || meta
                .get("patch_bolt")
                .and_then(Bv::as_list)
                .is_some_and(|p| p.iter().any(|v| v.as_str() == Some("utc")));
        if logon {
            self.request(0x6A, vec![Bv::map(auth)]).await?;
        }
        Ok(())
    }

    async fn send(&mut self, tag: u8, fields: Vec<Bv>) -> Result<(), BoltError> {
        let mut bytes = Vec::new();
        encode(&Bv::Struct(tag, fields), &mut bytes);
        for chunk in bytes.chunks(MAX_CHUNK) {
            self.stream.write_all(&(chunk.len() as u16).to_be_bytes()).await?;
            self.stream.write_all(chunk).await?;
        }
        self.stream.write_all(&[0, 0]).await?;
        self.stream.flush().await?;
        Ok(())
    }

    /// One message, at most `max` bytes; also the bytes it took.
    pub async fn recv(&mut self, max: usize) -> Result<(Response, usize), BoltError> {
        let mut bytes = Vec::new();
        loop {
            let size = self.stream.read_u16().await? as usize;
            if size == 0 {
                if bytes.is_empty() {
                    // A NOOP keep-alive between messages.
                    continue;
                }
                break;
            }
            if bytes.len() + size > max {
                return Err(BoltError::TooLarge(max));
            }
            let start = bytes.len();
            bytes.resize(start + size, 0);
            self.stream.read_exact(&mut bytes[start..]).await?;
        }
        let n = bytes.len();
        let Bv::Struct(tag, mut fields) = decode(&bytes)? else {
            return Err(protocol("a message that is not a structure"));
        };
        let response = match tag {
            SUCCESS => Response::Success(fields.pop().unwrap_or(Bv::Map(Vec::new()))),
            RECORD => match fields.pop() {
                Some(Bv::List(values)) => Response::Record(values),
                _ => return Err(protocol("a record without values")),
            },
            IGNORED => Response::Ignored,
            FAILURE => {
                let meta = fields.pop().unwrap_or(Bv::Map(Vec::new()));
                let text = |k: &str| meta.get(k).and_then(Bv::as_str).map(str::to_string);
                return Err(BoltError::Failure {
                    code: text("code").or_else(|| text("neo4j_code")).unwrap_or_default(),
                    message: text("message").or_else(|| text("description")).unwrap_or_else(|| "unknown error".into()),
                });
            }
            other => return Err(protocol(&format!("unexpected message 0x{other:02X}"))),
        };
        Ok((response, n))
    }

    /// Sends a request and expects SUCCESS with small metadata.
    async fn request(&mut self, tag: u8, fields: Vec<Bv>) -> Result<Bv, BoltError> {
        let answer = self.request_inner(tag, fields).await;
        if matches!(answer, Err(ref e) if !matches!(e, BoltError::Failure { .. })) {
            self.broken = true;
        }
        answer
    }

    async fn request_inner(&mut self, tag: u8, fields: Vec<Bv>) -> Result<Bv, BoltError> {
        self.send(tag, fields).await?;
        match self.recv(16 * 1024 * 1024).await?.0 {
            Response::Success(meta) => Ok(meta),
            Response::Ignored => Err(protocol("the request was ignored")),
            Response::Record(_) => Err(protocol("a record where none was expected")),
        }
    }

    /// BEGIN a transaction: read mode unless `write_probe`, in `db` when set, with the server's
    /// own transaction timeout.
    pub async fn begin(&mut self, db: Option<&str>, timeout: Duration, read: bool) -> Result<(), BoltError> {
        let mut extra = Vec::new();
        if read {
            extra.push(("mode", Bv::String("r".into())));
        }
        if let Some(db) = db.filter(|d| !d.is_empty()) {
            extra.push(("db", Bv::String(db.into())));
        }
        extra.push(("tx_timeout", Bv::Int(timeout.as_millis().clamp(1, i64::MAX as u128) as i64)));
        self.request(0x11, vec![Bv::map(extra)]).await.map(|_| ())
    }

    /// RUN in the open transaction; answers the result's field names.
    pub async fn run(&mut self, query: &str, params: Vec<(String, Bv)>) -> Result<Vec<String>, BoltError> {
        self.run_with(query, params, Vec::new()).await
    }

    /// RUN outside a transaction (auto-commit), in `db` when set.
    pub async fn run_auto(&mut self, query: &str, db: Option<&str>) -> Result<Vec<String>, BoltError> {
        let extra = match db.filter(|d| !d.is_empty()) {
            Some(db) => vec![("db".to_string(), Bv::String(db.into()))],
            None => Vec::new(),
        };
        self.run_with(query, Vec::new(), extra).await
    }

    async fn run_with(
        &mut self,
        query: &str,
        params: Vec<(String, Bv)>,
        extra: Vec<(String, Bv)>,
    ) -> Result<Vec<String>, BoltError> {
        let meta = self.request(0x10, vec![Bv::String(query.into()), Bv::Map(params), Bv::Map(extra)]).await?;
        Ok(meta
            .get("fields")
            .and_then(Bv::as_list)
            .map(|f| f.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default())
    }

    /// PULL up to `n` records. `on_record` gets each record and its size and answers whether to
    /// go on; it returns false to stop, after which the connection is in the middle of a result
    /// and must not be reused. Answers whether the result has more records.
    pub async fn pull(
        &mut self,
        n: i64,
        max_message: usize,
        on_record: impl FnMut(Vec<Bv>, usize) -> bool,
    ) -> Result<PullEnd, BoltError> {
        let end = self.pull_inner(n, max_message, on_record).await;
        if matches!(end, Ok(PullEnd::Stopped)) || matches!(end, Err(ref e) if !matches!(e, BoltError::Failure { .. })) {
            self.broken = true;
        }
        end
    }

    async fn pull_inner(
        &mut self,
        n: i64,
        max_message: usize,
        mut on_record: impl FnMut(Vec<Bv>, usize) -> bool,
    ) -> Result<PullEnd, BoltError> {
        self.send(0x3F, vec![Bv::map(vec![("n", Bv::Int(n)), ("qid", Bv::Int(-1))])]).await?;
        loop {
            match self.recv(max_message).await? {
                (Response::Record(values), size) => {
                    if !on_record(values, size) {
                        return Ok(PullEnd::Stopped);
                    }
                }
                (Response::Success(meta), _) => {
                    let more = matches!(meta.get("has_more"), Some(Bv::Bool(true)));
                    return Ok(if more { PullEnd::More } else { PullEnd::Done });
                }
                (Response::Ignored, _) => return Err(protocol("PULL was ignored")),
            }
        }
    }

    pub async fn rollback(&mut self) -> Result<(), BoltError> {
        self.request(0x13, Vec::new()).await.map(|_| ())
    }

    /// Back to a clean, logged-in state after a failure. A failed reset leaves the connection
    /// broken.
    pub async fn reset(&mut self) -> Result<(), BoltError> {
        let done = self.request(0x0F, Vec::new()).await.map(|_| ());
        if done.is_err() {
            self.broken = true;
        }
        done
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PullEnd {
    Done,
    More,
    Stopped,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(v: Bv) {
        let mut bytes = Vec::new();
        encode(&v, &mut bytes);
        assert_eq!(decode(&bytes).unwrap(), v);
    }

    #[test]
    fn packstream_round_trips() {
        for i in [0, 1, -1, -16, -17, 127, 128, -128, -129, 32_767, 32_768, -32_769, 2_147_483_648, i64::MAX, i64::MIN]
        {
            round_trip(Bv::Int(i));
        }
        round_trip(Bv::Float(-1.25));
        round_trip(Bv::String("Grüße".into()));
        round_trip(Bv::String("x".repeat(300)));
        round_trip(Bv::String("y".repeat(70_000)));
        round_trip(Bv::Bytes(vec![1, 2, 3]));
        round_trip(Bv::List((0..20).map(Bv::Int).collect()));
        round_trip(Bv::map(vec![("a", Bv::Null), ("b", Bv::Bool(true))]));
        round_trip(Bv::Struct(0x4E, vec![Bv::Int(1), Bv::List(vec![]), Bv::Map(vec![])]));
    }

    #[test]
    fn known_encodings() {
        let enc = |v: Bv| {
            let mut b = Vec::new();
            encode(&v, &mut b);
            b
        };
        assert_eq!(enc(Bv::Int(-16)), [0xF0]);
        assert_eq!(enc(Bv::Int(-17)), [0xC8, 0xEF]);
        assert_eq!(enc(Bv::String("a".into())), [0x81, b'a']);
        assert_eq!(enc(Bv::Struct(0x0F, vec![])), [0xB0, 0x0F]);
    }

    #[test]
    fn broken_messages_are_refused_before_allocating() {
        // A list that claims four billion entries in a five-byte message.
        assert!(decode(&[0xD6, 0xFF, 0xFF, 0xFF, 0xFF]).is_err());
        assert!(decode(&[0xD0, 0x05, b'a']).is_err());
        assert!(decode(&[0xA1, 0x01, 0x01]).is_err(), "a key that is not a string");
        assert!(decode(&[0x01, 0x02]).is_err(), "bytes after the value");
        let deep: Vec<u8> = std::iter::repeat_n(0x91, 200).chain([0x01]).collect();
        assert!(decode(&deep).is_err());
        assert!(decode(&[0xE0]).is_err(), "0xE0..0xEF are reserved");
        // Nested maps that each claim as many entries as bytes are left: reserving space for the
        // claims (gigabytes over the nesting) would abort the process.
        let total = 8 << 20;
        let mut msg = Vec::with_capacity(total);
        for _ in 0..60 {
            let left = (total - msg.len() - 5) as u32;
            msg.push(0xDA);
            msg.extend_from_slice(&left.to_be_bytes());
            msg.push(0x80);
        }
        msg.resize(total, 0xC0);
        assert!(decode(&msg).is_err());
        let mut lists = Vec::with_capacity(total);
        for _ in 0..60 {
            let left = (total - lists.len() - 5) as u32;
            lists.push(0xD6);
            lists.extend_from_slice(&left.to_be_bytes());
        }
        lists.resize(total, 0x01);
        assert!(decode(&lists).is_err());
    }

    /// A Bolt server in a task: answers the handshake with `version`, then each request with the
    /// next canned messages.
    async fn fake_server(version: [u8; 4], responses: Vec<Vec<Bv>>) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut hs = [0u8; 20];
            s.read_exact(&mut hs).await.unwrap();
            s.write_all(&version).await.unwrap();
            for r in responses {
                // Read one request message.
                loop {
                    let n = s.read_u16().await.unwrap() as usize;
                    if n == 0 {
                        break;
                    }
                    let mut buf = vec![0; n];
                    s.read_exact(&mut buf).await.unwrap();
                }
                for message in r {
                    let mut bytes = Vec::new();
                    encode(&message, &mut bytes);
                    s.write_all(&(bytes.len() as u16).to_be_bytes()).await.unwrap();
                    s.write_all(&bytes).await.unwrap();
                    s.write_all(&[0, 0]).await.unwrap();
                }
            }
        });
        addr
    }

    fn success(entries: Vec<(&str, Bv)>) -> Bv {
        Bv::Struct(SUCCESS, vec![Bv::map(entries)])
    }

    fn policy() -> TargetPolicy {
        TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[])
    }

    #[tokio::test]
    async fn logs_in_reads_and_reports_failures() {
        let records = vec![
            vec![success(vec![("server", Bv::String("Neo4j/5.26.0".into()))])],
            vec![success(vec![])],
            vec![success(vec![])],
            vec![success(vec![("fields", Bv::List(vec![Bv::String("n".into())]))])],
            vec![Bv::Struct(RECORD, vec![Bv::List(vec![Bv::Int(7)])]), success(vec![("has_more", Bv::Bool(false))])],
            vec![Bv::Struct(
                FAILURE,
                vec![Bv::map(vec![
                    ("code", Bv::String("Neo.ClientError.Statement.AccessMode".into())),
                    ("message", Bv::String("Writing in read access mode not allowed".into())),
                ])],
            )],
        ];
        let addr = fake_server([0, 0, 4, 5], records).await;
        let opts = ConnectOptions {
            host: "127.0.0.1",
            port: addr.port(),
            user: Some("leser"),
            password: Some("geheim"),
            tls: None,
            timeout: Duration::from_secs(5),
        };
        let mut c = connect(&policy(), opts).await.unwrap();
        assert_eq!(c.version, (5, 4));
        assert!(c.utc);
        assert_eq!(c.server, "Neo4j/5.26.0");
        c.begin(Some("neo4j"), Duration::from_secs(3), true).await.unwrap();
        assert_eq!(c.run("RETURN 7 AS n", vec![]).await.unwrap(), ["n"]);
        let mut got = Vec::new();
        assert_eq!(
            c.pull(100, 1 << 20, |r, _| {
                got.push(r);
                true
            })
            .await
            .unwrap(),
            PullEnd::Done
        );
        assert_eq!(got, [vec![Bv::Int(7)]]);
        assert!(!c.broken);
        let e = c.run("CREATE ()", vec![]).await.unwrap_err();
        assert!(matches!(e.into_source(), SourceError::Rejected(d) if d.reason == "query.write_refused"));
        assert!(!c.broken, "a failure leaves the connection usable after a reset");
    }

    #[tokio::test]
    async fn a_result_read_in_part_breaks_the_connection() {
        let record = |i| Bv::Struct(RECORD, vec![Bv::List(vec![Bv::Int(i)])]);
        let records = vec![
            vec![success(vec![])],
            vec![success(vec![("fields", Bv::List(vec![Bv::String("n".into())]))])],
            vec![record(1), record(2), success(vec![])],
        ];
        let addr = fake_server([0, 0, 4, 4], records).await;
        let opts = ConnectOptions {
            host: "127.0.0.1",
            port: addr.port(),
            user: None,
            password: None,
            tls: None,
            timeout: Duration::from_secs(5),
        };
        let mut c = connect(&policy(), opts).await.unwrap();
        c.run("UNWIND [1, 2] AS n RETURN n", vec![]).await.unwrap();
        assert_eq!(c.pull(100, 1 << 20, |_, _| false).await.unwrap(), PullEnd::Stopped);
        assert!(c.broken, "the rest of the result is still on the wire");
        // A reset the server does not answer breaks it as well.
        let mut d = connect(
            &policy(),
            ConnectOptions { port: fake_server([0, 0, 4, 4], vec![vec![success(vec![])]]).await.port(), ..opts_copy() },
        )
        .await
        .unwrap();
        assert!(d.reset().await.is_err());
        assert!(d.broken);
    }

    fn opts_copy() -> ConnectOptions<'static> {
        ConnectOptions {
            host: "127.0.0.1",
            port: 0,
            user: None,
            password: None,
            tls: None,
            timeout: Duration::from_secs(5),
        }
    }

    #[tokio::test]
    async fn refuses_versions_it_does_not_speak_and_blocked_targets() {
        let addr = fake_server([0, 0, 0, 3], vec![]).await;
        let opts = |port| ConnectOptions {
            host: "127.0.0.1",
            port,
            user: None,
            password: None,
            tls: None,
            timeout: Duration::from_secs(5),
        };
        let e = connect(&policy(), opts(addr.port())).await.err().unwrap();
        assert!(e.to_string().contains("no common Bolt version"), "{e}");
        let blocked = ConnectOptions { host: "169.254.169.254", ..opts(7687) };
        assert!(matches!(connect(&policy(), blocked).await, Err(SourceError::Blocked(_))));
    }
}
