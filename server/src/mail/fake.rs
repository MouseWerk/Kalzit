//! A mail server for the unit tests: STARTTLS or TLS with a certificate of its own test CA,
//! PLAIN or LOGIN sign-in, and scripted refusals. It records what it was sent.

use std::sync::{Arc, Mutex};

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

#[derive(Clone)]
pub struct Script {
    pub implicit_tls: bool,
    /// Offers STARTTLS on the plain connection.
    pub starttls: bool,
    /// The sign-in mechanism offered after TLS.
    pub auth: &'static str,
    pub reject_auth: bool,
    pub reject_sender: bool,
    pub reject_recipient: bool,
    /// Sends a line right behind the answer to STARTTLS, before TLS.
    pub inject_after_starttls: bool,
}

impl Default for Script {
    fn default() -> Self {
        Self {
            implicit_tls: false,
            starttls: true,
            auth: "PLAIN",
            reject_auth: false,
            reject_sender: false,
            reject_recipient: false,
            inject_after_starttls: false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Received {
    pub from: String,
    pub to: Vec<String>,
    pub data: String,
    /// `user:password` of the sign-in on this connection.
    pub auth: Option<String>,
    pub secure: bool,
}

#[derive(Default)]
struct Log {
    messages: Vec<Received>,
    auth_attempts: usize,
}

pub struct FakeSmtp {
    port: u16,
    ca_der: rustls::pki_types::CertificateDer<'static>,
    log: Arc<Mutex<Log>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for FakeSmtp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn server_tls() -> (Arc<rustls::ServerConfig>, rustls::pki_types::CertificateDer<'static>) {
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(rcgen::DnType::CommonName, "Kalzit test CA");
    let ca = rcgen::CertifiedIssuer::self_signed(ca_params, rcgen::KeyPair::generate().unwrap()).unwrap();
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec!["127.0.0.1".to_string(), "localhost".to_string()])
        .unwrap()
        .signed_by(&leaf_key, &ca)
        .unwrap();
    let key = rustls::pki_types::PrivateKeyDer::try_from(leaf_key.serialize_der()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![leaf.der().clone(), ca.der().clone()], key)
        .unwrap();
    (Arc::new(config), ca.der().clone())
}

impl FakeSmtp {
    pub async fn start(script: Script) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tls, ca_der) = server_tls();
        let log = Arc::new(Mutex::new(Log::default()));
        let task = {
            let log = log.clone();
            tokio::spawn(async move {
                while let Ok((socket, _)) = listener.accept().await {
                    let (script, tls, log) = (script.clone(), tls.clone(), log.clone());
                    tokio::spawn(async move {
                        let _ = serve(Box::new(socket), script, tls, log).await;
                    });
                }
            })
        };
        Self { port, ca_der, log, task }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// A client configuration that trusts this server's CA only.
    pub fn client_tls(&self) -> rustls::ClientConfig {
        let mut roots = rustls::RootCertStore::empty();
        roots.add(self.ca_der.clone()).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth()
    }

    pub fn messages(&self) -> Vec<Received> {
        self.log.lock().unwrap().messages.clone()
    }

    pub fn auth_attempts(&self) -> usize {
        self.log.lock().unwrap().auth_attempts
    }
}

async fn serve(
    stream: Box<dyn Io>,
    script: Script,
    tls: Arc<rustls::ServerConfig>,
    log: Arc<Mutex<Log>>,
) -> std::io::Result<()> {
    let acceptor = tokio_rustls::TlsAcceptor::from(tls);
    let mut secure = false;
    let stream: Box<dyn Io> = if script.implicit_tls {
        secure = true;
        Box::new(acceptor.accept(stream).await?)
    } else {
        stream
    };
    let mut io = BufReader::new(stream);
    io.write_all(b"220 fake.test ESMTP\r\n").await?;
    let (mut from, mut to, mut auth) = (String::new(), Vec::new(), None);
    let b64 = base64::engine::general_purpose::STANDARD;
    loop {
        let mut line = String::new();
        if io.read_line(&mut line).await? == 0 {
            return Ok(());
        }
        let line = line.trim_end().to_string();
        let upper = line.to_ascii_uppercase();
        if upper.starts_with("EHLO") {
            let mut out = String::from("250-fake.test\r\n250-SMTPUTF8\r\n");
            if script.starttls && !secure {
                out.push_str("250-STARTTLS\r\n");
            }
            if secure {
                out.push_str(&format!("250-AUTH {}\r\n", script.auth));
            }
            out.push_str("250 8BITMIME\r\n");
            io.write_all(out.as_bytes()).await?;
        } else if upper == "STARTTLS" {
            let answer: &[u8] =
                if script.inject_after_starttls { b"220 go ahead\r\n250 injected\r\n" } else { b"220 go ahead\r\n" };
            io.write_all(answer).await?;
            if script.inject_after_starttls {
                return Ok(());
            }
            let plain = io.into_inner();
            io = BufReader::new(Box::new(acceptor.accept(plain).await?));
            secure = true;
        } else if let Some(token) = line.strip_prefix("AUTH PLAIN ") {
            log.lock().unwrap().auth_attempts += 1;
            let raw = b64.decode(token).unwrap_or_default();
            let parts: Vec<String> = raw.split(|b| *b == 0).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
            auth = Some(format!(
                "{}:{}",
                parts.get(1).cloned().unwrap_or_default(),
                parts.get(2).cloned().unwrap_or_default()
            ));
            let reply: &[u8] = if script.reject_auth { b"535 5.7.8 Authentication failed\r\n" } else { b"235 ok\r\n" };
            io.write_all(reply).await?;
        } else if upper == "AUTH LOGIN" {
            log.lock().unwrap().auth_attempts += 1;
            io.write_all(b"334 VXNlcm5hbWU6\r\n").await?;
            let mut user = String::new();
            io.read_line(&mut user).await?;
            io.write_all(b"334 UGFzc3dvcmQ6\r\n").await?;
            let mut pass = String::new();
            io.read_line(&mut pass).await?;
            let decode = |s: &str| String::from_utf8_lossy(&b64.decode(s.trim()).unwrap_or_default()).into_owned();
            auth = Some(format!("{}:{}", decode(&user), decode(&pass)));
            let reply: &[u8] = if script.reject_auth { b"535 5.7.8 Authentication failed\r\n" } else { b"235 ok\r\n" };
            io.write_all(reply).await?;
        } else if upper.starts_with("MAIL FROM:") {
            from = line[10..].trim_start_matches('<').split('>').next().unwrap_or_default().to_string();
            let reply: &[u8] = if script.reject_sender { b"553 5.7.1 Sender not allowed\r\n" } else { b"250 ok\r\n" };
            io.write_all(reply).await?;
        } else if upper.starts_with("RCPT TO:") {
            if script.reject_recipient {
                io.write_all(b"550 5.1.1 mailbox unknown\r\n").await?;
            } else {
                to.push(line[8..].trim_start_matches('<').trim_end_matches('>').to_string());
                io.write_all(b"250 ok\r\n").await?;
            }
        } else if upper == "DATA" {
            io.write_all(b"354 go\r\n").await?;
            let mut data = String::new();
            loop {
                let mut l = String::new();
                if io.read_line(&mut l).await? == 0 {
                    return Ok(());
                }
                if l == ".\r\n" {
                    break;
                }
                data.push_str(l.strip_prefix('.').unwrap_or(&l));
            }
            log.lock().unwrap().messages.push(Received {
                from: from.clone(),
                to: std::mem::take(&mut to),
                data,
                auth: auth.clone(),
                secure,
            });
            io.write_all(b"250 2.0.0 OK queued\r\n").await?;
        } else if upper == "QUIT" {
            io.write_all(b"221 bye\r\n").await?;
            return Ok(());
        } else {
            io.write_all(b"250 ok\r\n").await?;
        }
    }
}
