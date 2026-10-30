//! A small SMTP client (RFC 5321) for Kalzit's own mails: one connection per mail, STARTTLS
//! (RFC 3207) or TLS from the start, AUTH PLAIN or LOGIN (RFC 4954). The mail server is a target
//! like a data source: the address is resolved and checked once (`TargetPolicy`, Kalzit's own
//! listeners and database refused) and that checked address is connected to, so a second lookup
//! cannot lead elsewhere. Credentials are only sent over TLS (or to a relay on this machine), and
//! no command or answer is logged, since they carry the password and the recipients.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::settings::{Security, SmtpSettings, is_loopback_host};
use crate::datasources::targets::{ResolveError, TargetPolicy};
use crate::error::ApiError;
use crate::plugins::connector::OwnEndpoints;

/// Longest a single read or write may wait.
pub const STEP_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest one mail may take from connect to the last answer.
pub const MAIL_TIMEOUT: Duration = Duration::from_secs(60);
/// One answer line; RFC 5321 allows 512 bytes, servers send longer ones.
const MAX_LINE_BYTES: u64 = 4096;
/// Lines of one multi-line answer (EHLO lists its extensions).
const MAX_LINES: usize = 100;
/// The server's text as Kalzit passes it on (UI, invitation list, audit).
const MAX_REPLY_CHARS: usize = 300;

/// Why a mail did not go out: the field it is about (as the settings form names it, `to` for the
/// recipient), a reason the UI translates and the server's answer, if it gave one.
#[derive(Debug, Clone)]
pub struct SendError {
    pub field: Option<&'static str>,
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
    /// The server or the connection failed, not this one recipient: further mails of the same
    /// batch would fail alike.
    pub connection: bool,
}

impl SendError {
    fn new(field: Option<&'static str>, reason: &'static str, message: impl Into<String>) -> Self {
        Self { field, reason, params: BTreeMap::new(), message: message.into(), connection: true }
    }

    fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    fn for_recipient(mut self) -> Self {
        self.connection = false;
        self
    }

    /// The server's answer, if this error carries one, else the message.
    pub fn detail(&self) -> String {
        self.params.get("reply").cloned().unwrap_or_else(|| self.message.clone())
    }

    pub fn into_api(self) -> ApiError {
        let mut e = ApiError::validation(self.message).with_reason_string(self.reason.to_string(), self.params);
        if let Some(field) = self.field {
            e = e.with_field(field);
        }
        e
    }
}

/// What the mail server said when it took the mail.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delivered {
    /// The last answer, such as `250 2.0.0 OK queued`.
    pub reply: String,
    pub elapsed_ms: u64,
    /// `TLS 1.3`, or `None` for an unencrypted relay.
    pub tls: Option<String>,
    /// When the server's certificate expires (Unix milliseconds).
    pub certificate_not_after: Option<i64>,
}

/// How to reach a mail server: the target rules and Kalzit's own endpoints, the certificates to
/// trust and how long to wait.
#[derive(Clone)]
pub struct Connector {
    pub policy: Arc<TargetPolicy>,
    pub own: Arc<OwnEndpoints>,
    pub tls: Arc<rustls::ClientConfig>,
    pub step_timeout: Duration,
}

/// The platform's trusted certificates, with Kalzit's TLS defaults.
pub fn platform_tls() -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?;
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for e in &native.errors {
        tracing::warn!("reading the platform's certificates: {e}");
    }
    roots.add_parsable_certificates(native.certs);
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

/// One mail to send: the envelope and the rendered message (`message::render`).
pub struct Outgoing<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub data: &'a [u8],
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

struct Reply {
    code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn text(&self) -> String {
        let joined = self.lines.join(" ");
        let clean: String = joined.chars().filter(|c| !c.is_control()).take(MAX_REPLY_CHARS).collect();
        format!("{} {}", self.code, clean).trim_end().to_string()
    }

    fn positive(&self) -> bool {
        (200..400).contains(&self.code)
    }
}

struct Session {
    stream: BufReader<Box<dyn Io>>,
    timeout: Duration,
    extensions: Vec<String>,
}

fn io_error(what: &str, e: impl std::fmt::Display) -> SendError {
    SendError::new(Some("host"), "mail.connection_lost", format!("the connection broke while {what}: {e}"))
        .with("detail", e)
}

impl Session {
    async fn read_reply(&mut self, what: &str) -> Result<Reply, SendError> {
        let mut lines = Vec::new();
        loop {
            let mut raw = Vec::new();
            let mut limited = (&mut self.stream).take(MAX_LINE_BYTES);
            match tokio::time::timeout(self.timeout, limited.read_until(b'\n', &mut raw)).await {
                Err(_) => {
                    return Err(SendError::new(
                        Some("port"),
                        "mail.no_answer",
                        format!(
                            "the mail server did not answer within {} seconds while {what}",
                            self.timeout.as_secs()
                        ),
                    ));
                }
                Ok(Err(e)) => return Err(io_error(what, e)),
                Ok(Ok(0)) => return Err(io_error(what, "the server closed the connection")),
                Ok(Ok(_)) => {}
            }
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\r', '\n']);
            let code = line.get(..3).and_then(|c| c.parse::<u16>().ok()).filter(|c| (200..600).contains(c));
            let Some(code) = code else {
                return Err(SendError::new(
                    Some("port"),
                    "mail.not_smtp",
                    format!("the server at this port does not speak SMTP (while {what})"),
                ));
            };
            let last = line.as_bytes().get(3) != Some(&b'-');
            lines.push(line.get(4..).unwrap_or_default().to_string());
            if last {
                return Ok(Reply { code, lines });
            }
            if lines.len() >= MAX_LINES {
                return Err(SendError::new(
                    Some("port"),
                    "mail.not_smtp",
                    "the mail server's answer has too many lines",
                ));
            }
        }
    }

    async fn write(&mut self, bytes: &[u8], what: &str) -> Result<(), SendError> {
        let write = async {
            self.stream.write_all(bytes).await?;
            self.stream.flush().await
        };
        match tokio::time::timeout(self.timeout, write).await {
            Err(_) => Err(SendError::new(Some("host"), "mail.no_answer", format!("sending timed out while {what}"))),
            Ok(Err(e)) => Err(io_error(what, e)),
            Ok(Ok(())) => Ok(()),
        }
    }

    async fn command(&mut self, line: &str, what: &str) -> Result<Reply, SendError> {
        self.write(format!("{line}\r\n").as_bytes(), what).await?;
        self.read_reply(what).await
    }

    async fn hello(&mut self, name: &str) -> Result<(), SendError> {
        let reply = self.command(&format!("EHLO {name}"), "greeting the server").await?;
        if reply.code == 250 {
            self.extensions = reply.lines.iter().skip(1).map(|l| l.trim().to_ascii_uppercase()).collect();
            return Ok(());
        }
        // A server without ESMTP: no extensions, so no STARTTLS and no AUTH.
        let reply = self.command(&format!("HELO {name}"), "greeting the server").await?;
        if reply.code != 250 {
            return Err(SendError::new(Some("host"), "mail.refused", "the mail server refused the greeting")
                .with("reply", reply.text()));
        }
        self.extensions.clear();
        Ok(())
    }

    fn extension(&self, name: &str) -> Option<&str> {
        self.extensions.iter().find_map(|e| {
            let (word, rest) = e.split_once(' ').unwrap_or((e.as_str(), ""));
            (word == name).then_some(rest)
        })
    }
}

/// The TLS details of a connection, for the test mail's answer.
struct TlsInfo {
    version: Option<String>,
    not_after: Option<i64>,
}

async fn handshake(
    connector: &Connector,
    host: &str,
    stream: Box<dyn Io>,
) -> Result<(Box<dyn Io>, TlsInfo), SendError> {
    let name = match crate::datasources::targets::parse_ip_literal(host) {
        Some(ip) => rustls::pki_types::ServerName::IpAddress(ip.into()),
        None => rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|e| SendError::new(Some("host"), "mail.host_invalid", format!("not a host name: {e}")))?,
    };
    let tls = tokio_rustls::TlsConnector::from(connector.tls.clone());
    let connected = tokio::time::timeout(connector.step_timeout, tls.connect(name, stream)).await;
    let stream = match connected {
        Err(_) => {
            return Err(SendError::new(Some("security"), "mail.tls_failed", "the TLS handshake timed out")
                .with("detail", "timeout"));
        }
        Ok(Err(e)) => {
            let certificate = e
                .get_ref()
                .and_then(|inner| inner.downcast_ref::<rustls::Error>())
                .is_some_and(|r| matches!(r, rustls::Error::InvalidCertificate(_)));
            return Err(if certificate {
                SendError::new(
                    Some("host"),
                    "mail.certificate_invalid",
                    format!("the server's certificate is not trusted: {e}"),
                )
                .with("detail", e)
            } else {
                SendError::new(Some("security"), "mail.tls_failed", format!("the TLS handshake failed: {e}"))
                    .with("detail", e)
            });
        }
        Ok(Ok(stream)) => stream,
    };
    let connection = stream.get_ref().1;
    let version = connection.protocol_version().map(|v| match v {
        rustls::ProtocolVersion::TLSv1_3 => "TLS 1.3".to_string(),
        rustls::ProtocolVersion::TLSv1_2 => "TLS 1.2".to_string(),
        other => format!("{other:?}"),
    });
    let not_after = connection.peer_certificates().and_then(|c| c.first()).and_then(|leaf| {
        x509_parser::parse_x509_certificate(leaf.as_ref())
            .ok()
            .map(|(_, cert)| cert.validity().not_after.timestamp() * 1000)
    });
    Ok((Box::new(stream), TlsInfo { version, not_after }))
}

fn resolve_error(e: ResolveError) -> SendError {
    let detail = e.detail();
    let mut out = SendError::new(Some("host"), detail.reason, detail.message);
    out.params = detail.params;
    out
}

/// `loopback_only`: without encryption, every address connected to must be this machine's, not
/// only the host's name (a name that looks local can resolve elsewhere).
async fn connect(connector: &Connector, host: &str, port: u16, loopback_only: bool) -> Result<TcpStream, SendError> {
    let addrs: Vec<SocketAddr> = connector.policy.resolve_all(host, port).await.map_err(resolve_error)?;
    let mut last = String::new();
    for addr in addrs {
        if loopback_only && !addr.ip().to_canonical().is_loopback() {
            return Err(SendError::new(
                Some("security"),
                "mail.unencrypted_not_local",
                format!("{host} resolves to {}, not this machine; without encryption only a local relay", addr.ip()),
            ));
        }
        if let Err(detail) = connector.own.check(addr).await {
            let mut out = SendError::new(Some("host"), detail.reason, detail.message);
            out.params = detail.params;
            return Err(out);
        }
        match tokio::time::timeout(connector.step_timeout, TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(e)) => last = format!("{addr}: {e}"),
            Err(_) => last = format!("{addr}: no answer within {} seconds", connector.step_timeout.as_secs()),
        }
    }
    Err(SendError::new(Some("host"), "target.unreachable", format!("cannot connect to {host} ({last})"))
        .with("host", host)
        .with("detail", last))
}

/// The name Kalzit greets with: its public host when known.
pub fn hello_name(public_url: Option<&str>) -> String {
    public_url
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(str::to_string))
        .filter(|h| crate::datasources::targets::is_host_name(h))
        .unwrap_or_else(|| "localhost".to_string())
}

/// Connects, greets, secures and signs in; with `mail`, sends it. Without `mail` this is the
/// check a save runs: everything up to the sign-in, nothing sent.
pub async fn deliver(
    connector: &Connector,
    settings: &SmtpSettings,
    password: Option<&str>,
    hello: &str,
    mail: Option<&Outgoing<'_>>,
) -> Result<Delivered, SendError> {
    let started = Instant::now();
    match tokio::time::timeout(MAIL_TIMEOUT, run(connector, settings, password, hello, mail)).await {
        Ok(Ok((reply, tls))) => Ok(Delivered {
            reply,
            elapsed_ms: started.elapsed().as_millis() as u64,
            tls: tls.as_ref().and_then(|t| t.version.clone()),
            certificate_not_after: tls.and_then(|t| t.not_after),
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(SendError::new(
            Some("host"),
            "mail.no_answer",
            format!("the mail did not go out within {} seconds", MAIL_TIMEOUT.as_secs()),
        )),
    }
}

async fn run(
    connector: &Connector,
    settings: &SmtpSettings,
    password: Option<&str>,
    hello: &str,
    mail: Option<&Outgoing<'_>>,
) -> Result<(String, Option<TlsInfo>), SendError> {
    let host = settings.host.as_str();
    let tcp: Box<dyn Io> =
        Box::new(connect(connector, host, settings.port, settings.security == Security::None).await?);
    let (stream, mut tls) = match settings.security {
        Security::Tls => {
            let (stream, info) = handshake(connector, host, tcp).await?;
            (stream, Some(info))
        }
        Security::Starttls | Security::None => (tcp, None),
    };
    let mut session =
        Session { stream: BufReader::new(stream), timeout: connector.step_timeout, extensions: Vec::new() };
    let greeting = session.read_reply("waiting for the greeting").await.map_err(|e| {
        if e.reason == "mail.no_answer" && settings.security == Security::Starttls {
            SendError::new(
                Some("port"),
                "mail.no_greeting",
                "the server sent no greeting; does this port speak TLS directly?",
            )
            .with("port", settings.port)
        } else {
            e
        }
    })?;
    if greeting.code != 220 {
        return Err(SendError::new(Some("host"), "mail.refused", "the mail server refused the connection")
            .with("reply", greeting.text()));
    }
    session.hello(hello).await?;
    if settings.security == Security::Starttls {
        if session.extension("STARTTLS").is_none() {
            return Err(SendError::new(
                Some("security"),
                "mail.starttls_missing",
                "the mail server does not offer STARTTLS",
            ));
        }
        let reply = session.command("STARTTLS", "starting TLS").await?;
        if reply.code != 220 {
            return Err(SendError::new(Some("security"), "mail.starttls_missing", "the mail server refused STARTTLS")
                .with("reply", reply.text()));
        }
        // Anything the server sent after its answer would be read as if it came over TLS
        // (command injection, CVE-2011-0411 and its kin): refused.
        if !session.stream.buffer().is_empty() {
            return Err(SendError::new(Some("security"), "mail.tls_failed", "the server sent data before TLS started")
                .with("detail", "unexpected data after STARTTLS"));
        }
        let plain = session.stream.into_inner();
        let (stream, info) = handshake(connector, host, plain).await?;
        tls = Some(info);
        session = Session { stream: BufReader::new(stream), timeout: connector.step_timeout, extensions: Vec::new() };
        session.hello(hello).await?;
    }
    if !settings.username.is_empty() {
        if tls.is_none() && !is_loopback_host(host) {
            return Err(SendError::new(Some("security"), "mail.unencrypted_not_local", "credentials go over TLS only"));
        }
        authenticate(&mut session, &settings.username, password.unwrap_or_default()).await?;
    }
    let Some(mail) = mail else {
        let _ = session.command("QUIT", "closing").await;
        return Ok(("250 OK".to_string(), tls));
    };
    let utf8 = !mail.from.is_ascii() || !mail.to.is_ascii();
    if utf8 && session.extension("SMTPUTF8").is_none() {
        return Err(SendError::new(
            Some("to"),
            "mail.address_not_ascii",
            "the mail server does not take addresses with characters beyond ASCII",
        )
        .for_recipient());
    }
    let suffix = if utf8 { " SMTPUTF8" } else { "" };
    let reply = session.command(&format!("MAIL FROM:<{}>{suffix}", mail.from), "naming the sender").await?;
    if !reply.positive() {
        return Err(if reply.code == 530 {
            SendError::new(Some("username"), "mail.auth_required", "the mail server wants a user name and password")
                .with("reply", reply.text())
        } else {
            SendError::new(Some("fromAddress"), "mail.sender_rejected", "the mail server refused the sender address")
                .with("reply", reply.text())
        });
    }
    let reply = session.command(&format!("RCPT TO:<{}>", mail.to), "naming the recipient").await?;
    if !reply.positive() {
        return Err(SendError::new(Some("to"), "mail.recipient_rejected", "the mail server refused the recipient")
            .with("reply", reply.text())
            .for_recipient());
    }
    let reply = session.command("DATA", "starting the message").await?;
    if reply.code != 354 {
        return Err(SendError::new(None, "mail.message_rejected", "the mail server refused the message")
            .with("reply", reply.text()));
    }
    session.write(&dot_stuffed(mail.data), "sending the message").await?;
    let reply = session.read_reply("sending the message").await?;
    if !reply.positive() {
        return Err(SendError::new(None, "mail.message_rejected", "the mail server refused the message")
            .with("reply", reply.text())
            .for_recipient());
    }
    let text = reply.text();
    let _ = session.command("QUIT", "closing").await;
    Ok((text, tls))
}

async fn authenticate(session: &mut Session, username: &str, password: &str) -> Result<(), SendError> {
    let b64 = |s: &[u8]| base64::engine::general_purpose::STANDARD.encode(s);
    let Some(mechanisms) = session.extension("AUTH").map(str::to_string) else {
        return Err(SendError::new(
            Some("username"),
            "mail.auth_unsupported",
            "the mail server offers no sign-in; leave user and password empty",
        ));
    };
    let mechanisms: Vec<&str> = mechanisms.split_whitespace().collect();
    let rejected = |reply: Reply| {
        SendError::new(Some("password"), "mail.auth_rejected", "the mail server refused user name or password")
            .with("reply", reply.text())
    };
    if mechanisms.contains(&"PLAIN") {
        let mut token = zeroize::Zeroizing::new(Vec::new());
        token.push(0);
        token.extend_from_slice(username.as_bytes());
        token.push(0);
        token.extend_from_slice(password.as_bytes());
        let line = zeroize::Zeroizing::new(format!("AUTH PLAIN {}", b64(&token)));
        let reply = session.command(&line, "signing in").await?;
        return if reply.code == 235 { Ok(()) } else { Err(rejected(reply)) };
    }
    if mechanisms.contains(&"LOGIN") {
        let reply = session.command("AUTH LOGIN", "signing in").await?;
        if reply.code != 334 {
            return Err(rejected(reply));
        }
        let reply = session.command(&b64(username.as_bytes()), "signing in").await?;
        if reply.code != 334 {
            return Err(rejected(reply));
        }
        let line = zeroize::Zeroizing::new(b64(password.as_bytes()));
        let reply = session.command(&line, "signing in").await?;
        return if reply.code == 235 { Ok(()) } else { Err(rejected(reply)) };
    }
    Err(SendError::new(
        Some("username"),
        "mail.auth_unsupported",
        "the mail server offers neither PLAIN nor LOGIN to sign in",
    ))
}

/// The message as `DATA` sends it: CRLF line ends, a dot doubled at the start of a line, and the
/// final `.` line.
fn dot_stuffed(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 16);
    let text = String::from_utf8_lossy(data);
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.starts_with('.') {
            out.push(b'.');
        }
        out.extend_from_slice(line.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    // `split` yields an empty last piece after the final line break: drop its CRLF.
    if text.ends_with('\n') {
        out.truncate(out.len() - 2);
    }
    out.extend_from_slice(b".\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::fake::{FakeSmtp, Script};

    fn settings(port: u16, security: Security, username: &str) -> SmtpSettings {
        SmtpSettings {
            host: "127.0.0.1".into(),
            port,
            security,
            username: username.into(),
            from_name: "Kalzit".into(),
            from_address: "kalzit@example.com".into(),
            reply_to: String::new(),
        }
    }

    fn connector(tls: rustls::ClientConfig) -> Connector {
        let dir = std::env::temp_dir();
        Connector {
            policy: Arc::new(TargetPolicy::new(&dir, "sqlite::memory:", &[], &[])),
            own: Arc::new(OwnEndpoints::new(vec!["127.0.0.1:1".parse().unwrap()], None)),
            tls: Arc::new(tls),
            step_timeout: Duration::from_secs(5),
        }
    }

    const MAIL: Outgoing<'static> = Outgoing {
        from: "kalzit@example.com",
        to: "nora@example.com",
        data: b"Subject: Hallo\r\n\r\nzeile\r\n.punkt\r\n",
    };

    #[test]
    fn dots_are_doubled_and_the_end_is_marked() {
        assert_eq!(dot_stuffed(b"a\r\n.b\nc\r\n"), b"a\r\n..b\r\nc\r\n.\r\n");
        assert_eq!(dot_stuffed(b"a"), b"a\r\n.\r\n");
    }

    #[tokio::test]
    async fn starttls_then_plain_auth_then_the_mail() {
        let fake = FakeSmtp::start(Script::default()).await;
        let c = connector(fake.client_tls());
        let s = settings(fake.port(), Security::Starttls, "kalzit@example.com");
        let done = deliver(&c, &s, Some("geheim"), "kalzit.example.com", Some(&MAIL)).await.unwrap();
        assert!(done.reply.starts_with("250"), "{}", done.reply);
        assert_eq!(done.tls.as_deref(), Some("TLS 1.3"));
        assert!(done.certificate_not_after.is_some());
        let got = fake.messages();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].from, "kalzit@example.com");
        assert_eq!(got[0].to, vec!["nora@example.com".to_string()]);
        assert!(got[0].data.contains(".punkt"), "the dot is undone by the server: {}", got[0].data);
        assert_eq!(got[0].auth.as_deref(), Some("kalzit@example.com:geheim"));
        assert!(got[0].secure, "credentials and mail went over TLS");
    }

    #[tokio::test]
    async fn implicit_tls_and_login_auth() {
        let fake = FakeSmtp::start(Script { implicit_tls: true, auth: "LOGIN", ..Script::default() }).await;
        let c = connector(fake.client_tls());
        let s = settings(fake.port(), Security::Tls, "u");
        deliver(&c, &s, Some("p"), "x", Some(&MAIL)).await.unwrap();
        assert_eq!(fake.messages()[0].auth.as_deref(), Some("u:p"));
    }

    #[tokio::test]
    async fn answers_are_mapped_to_their_fields() {
        let cases: Vec<(Script, &str, &str)> = vec![
            (Script { reject_auth: true, ..Script::default() }, "password", "mail.auth_rejected"),
            (Script { starttls: false, ..Script::default() }, "security", "mail.starttls_missing"),
            (Script { reject_recipient: true, ..Script::default() }, "to", "mail.recipient_rejected"),
            (Script { reject_sender: true, ..Script::default() }, "fromAddress", "mail.sender_rejected"),
        ];
        for (script, field, reason) in cases {
            let fake = FakeSmtp::start(script).await;
            let c = connector(fake.client_tls());
            let s = settings(fake.port(), Security::Starttls, "kalzit@example.com");
            let e = deliver(&c, &s, Some("geheim"), "x", Some(&MAIL)).await.unwrap_err();
            assert_eq!((e.field, e.reason), (Some(field), reason), "{e:?}");
        }
        let fake = FakeSmtp::start(Script { reject_recipient: true, ..Script::default() }).await;
        let c = connector(fake.client_tls());
        let e = deliver(&c, &settings(fake.port(), Security::Starttls, ""), None, "x", Some(&MAIL)).await.unwrap_err();
        assert!(e.detail().starts_with("550"), "{}", e.detail());
        assert!(!e.connection, "a refused recipient does not stop the others");
    }

    #[tokio::test]
    async fn an_untrusted_certificate_is_refused_before_credentials() {
        let fake = FakeSmtp::start(Script::default()).await;
        let c = connector(platform_tls().unwrap());
        let s = settings(fake.port(), Security::Starttls, "kalzit@example.com");
        let e = deliver(&c, &s, Some("geheim"), "x", Some(&MAIL)).await.unwrap_err();
        assert_eq!(e.reason, "mail.certificate_invalid");
        assert!(fake.messages().is_empty());
        assert!(fake.auth_attempts() == 0, "no password went to an unverified server");
    }

    #[tokio::test]
    async fn kalzits_own_port_is_refused() {
        let fake = FakeSmtp::start(Script::default()).await;
        let mut c = connector(fake.client_tls());
        c.own = Arc::new(OwnEndpoints::new(vec![SocketAddr::from(([0, 0, 0, 0], fake.port()))], None));
        let e = deliver(&c, &settings(fake.port(), Security::Starttls, ""), None, "x", None).await.unwrap_err();
        assert_eq!(e.reason, "target.own_address");
    }

    #[tokio::test]
    async fn unencrypted_mail_goes_only_to_a_loopback_address() {
        let c = connector(platform_tls().unwrap());
        // A literal address that is not this machine never gets the unencrypted dialogue, even
        // when the name check was passed some other way.
        let s = SmtpSettings { host: "192.0.2.10".into(), ..settings(25, Security::None, "") };
        let e = deliver(&c, &s, None, "x", None).await.unwrap_err();
        assert_eq!((e.field, e.reason), (Some("security"), "mail.unencrypted_not_local"));
    }

    #[tokio::test]
    async fn metadata_addresses_are_refused() {
        let c = connector(platform_tls().unwrap());
        let s = SmtpSettings { host: "169.254.169.254".into(), ..settings(587, Security::Starttls, "") };
        let e = deliver(&c, &s, None, "x", None).await.unwrap_err();
        assert_eq!((e.field, e.reason), (Some("host"), "target.metadata_address"));
    }

    #[tokio::test]
    async fn a_check_signs_in_but_sends_nothing() {
        let fake = FakeSmtp::start(Script::default()).await;
        let c = connector(fake.client_tls());
        let s = settings(fake.port(), Security::Starttls, "kalzit@example.com");
        deliver(&c, &s, Some("geheim"), "x", None).await.unwrap();
        assert!(fake.messages().is_empty());
        assert_eq!(fake.auth_attempts(), 1);
    }

    #[tokio::test]
    async fn data_after_the_starttls_answer_is_refused() {
        let fake = FakeSmtp::start(Script { inject_after_starttls: true, ..Script::default() }).await;
        let c = connector(fake.client_tls());
        let e = deliver(&c, &settings(fake.port(), Security::Starttls, ""), None, "x", None).await.unwrap_err();
        assert_eq!(e.reason, "mail.tls_failed");
    }

    #[tokio::test]
    async fn a_silent_port_names_the_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(10)).await;
        });
        let mut c = connector(platform_tls().unwrap());
        c.step_timeout = Duration::from_millis(300);
        let e = deliver(&c, &settings(port, Security::Starttls, ""), None, "x", None).await.unwrap_err();
        assert_eq!((e.field, e.reason), (Some("port"), "mail.no_greeting"));
        hold.abort();
    }
}
