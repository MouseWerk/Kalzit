//! The Gremlin Server WebSocket protocol, as far as Kalzit needs it: a TCP connection to the
//! checked address (`TargetPolicy::connect`), TLS against the configured name for `wss://`, the
//! WebSocket handshake, and requests in GraphSON 3.0 (`application/vnd.gremlin-v3.0+json`) whose
//! answers arrive in parts (206) until a final status. SASL PLAIN answers the server's
//! authentication challenge (407).

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use reqwest::Url;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use zeroize::Zeroizing;

use super::super::targets::TargetPolicy;
use super::super::{Detail, SourceError};

const MIME: &str = "application/vnd.gremlin-v3.0+json";
/// The largest single message read, whatever the budget.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
/// The smallest message limit, so a status answer still fits when the budget is nearly spent.
const MIN_MESSAGE: usize = 64 * 1024;

/// How a request ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The final part arrived, or `each` asked to stop.
    Done,
    /// A message was larger than the limit or the response budget; the rest was not read.
    SizeLimit,
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

pub struct Wire {
    ws: WebSocketStream<Box<dyn Io>>,
}

/// Where and how to connect.
pub struct Target<'a> {
    pub url: &'a Url,
    pub ca_pem: Option<&'a str>,
    pub timeout: Duration,
    /// The largest message accepted: the response budget left, within 64 KiB and 64 MiB.
    pub max_message: usize,
}

fn tls_config(ca_pem: Option<&str>) -> Result<rustls::ClientConfig, SourceError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| SourceError::failed("gremlin.tls", format!("TLS setup failed: {e}")).with("detail", e))?;
    let mut roots = rustls::RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for e in &native.errors {
        tracing::warn!("reading the platform's certificates: {e}");
    }
    roots.add_parsable_certificates(native.certs);
    if let Some(pem) = ca_pem.filter(|p| !p.trim().is_empty()) {
        use rustls::pki_types::pem::PemObject;
        for cert in rustls::pki_types::CertificateDer::pem_slice_iter(pem.as_bytes()) {
            let cert = cert.map_err(|e| {
                SourceError::failed("gremlin.tls", format!("the CA certificate is not valid PEM: {e}"))
                    .with("detail", e)
            })?;
            roots.add(cert).map_err(|e| {
                SourceError::failed("gremlin.tls", format!("the CA certificate cannot be used: {e}")).with("detail", e)
            })?;
        }
    }
    Ok(builder.with_root_certificates(roots).with_no_client_auth())
}

fn lost(e: impl std::fmt::Display) -> SourceError {
    super::super::connect::lost(e)
}

impl Wire {
    pub async fn connect(policy: &TargetPolicy, target: Target<'_>) -> Result<Wire, SourceError> {
        let url = target.url;
        let host = url.host_str().ok_or_else(|| SourceError::failed("settings.url_no_host", "the URL needs a host"))?;
        let tls = url.scheme() == "wss";
        let port = url.port().unwrap_or(if tls { 443 } else { 80 });
        let (_, tcp) = policy.connect(host, port, target.timeout).await?;
        tcp.set_nodelay(true).map_err(lost)?;
        let stream: Box<dyn Io> = if tls {
            let config = tls_config(target.ca_pem)?;
            let name = rustls::pki_types::ServerName::try_from(host.trim_matches(['[', ']']).to_string())
                .map_err(|e| SourceError::failed("gremlin.tls", format!("{host} cannot be checked: {e}")))?;
            let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
            let tls = tokio::time::timeout(target.timeout, connector.connect(name, tcp))
                .await
                .map_err(|_| SourceError::failed("gremlin.tls", "the TLS handshake did not finish in time"))?
                .map_err(|e| SourceError::failed("gremlin.tls", format!("TLS failed: {e}")).with("detail", e))?;
            Box::new(tls)
        } else {
            Box::new(tcp)
        };
        let max = target.max_message.clamp(MIN_MESSAGE, MAX_MESSAGE);
        let config = WebSocketConfig::default().max_message_size(Some(max)).max_frame_size(Some(max));
        let handshake = tokio_tungstenite::client_async_with_config(url.as_str(), stream, Some(config));
        let (ws, _) = tokio::time::timeout(target.timeout, handshake)
            .await
            .map_err(|_| SourceError::failed("gremlin.handshake", "the WebSocket handshake did not finish in time"))?
            .map_err(|e| {
                SourceError::failed("gremlin.handshake", format!("the WebSocket handshake failed: {e}"))
                    .with("detail", e)
            })?;
        Ok(Wire { ws })
    }

    async fn send(&mut self, message: &Value) -> Result<(), SourceError> {
        let mut frame = Vec::with_capacity(MIME.len() + 1 + 256);
        frame.push(MIME.len() as u8);
        frame.extend_from_slice(MIME.as_bytes());
        frame.extend_from_slice(message.to_string().as_bytes());
        self.ws.send(Message::Binary(frame.into())).await.map_err(lost)
    }

    /// The next answer, or `None` when it is larger than the message limit or `admit` refuses
    /// its length (the response budget), before it is parsed.
    async fn receive(&mut self, admit: &mut (dyn FnMut(usize) -> bool + Send)) -> Result<Option<Value>, SourceError> {
        use tokio_tungstenite::tungstenite::Error as WsError;
        loop {
            let message = match self.ws.next().await.ok_or_else(|| lost("Gremlin Server closed the connection"))? {
                Ok(m) => m,
                Err(WsError::Capacity(_)) => return Ok(None),
                Err(e) => return Err(lost(e)),
            };
            match message {
                Message::Text(_) | Message::Binary(_) => {
                    let data = message.into_data();
                    if !admit(data.len()) {
                        return Ok(None);
                    }
                    return serde_json::from_slice(&data).map(Some).map_err(|_| {
                        SourceError::failed(
                            "gremlin.not_an_api_response",
                            "the server answered without a Gremlin Server response",
                        )
                    });
                }
                Message::Close(_) => return Err(lost("Gremlin Server closed the connection")),
                _ => continue,
            }
        }
    }

    /// Sends one request and hands every part of its answer (`result.data`) to `each` until it
    /// answers false or the final part arrived. `admit` is asked for each message's length
    /// before it is parsed (the response budget); a refusal ends the request. `scrub` cleans
    /// the server's messages.
    #[expect(clippy::too_many_arguments, reason = "the parts of one request, each needed by some caller")]
    pub async fn request(
        &mut self,
        processor: &str,
        op: &str,
        args: Value,
        login: Option<(&str, &str)>,
        scrub: &(dyn Fn(&str) -> String + Sync),
        admit: &mut (dyn FnMut(usize) -> bool + Send),
        mut each: impl FnMut(Value) -> bool,
    ) -> Result<Ended, SourceError> {
        let id = uuid::Uuid::now_v7().to_string();
        self.send(&json!({ "requestId": id, "op": op, "processor": processor, "args": args })).await?;
        let mut authenticated = false;
        loop {
            let Some(mut answer) = self.receive(admit).await? else { return Ok(Ended::SizeLimit) };
            let code = answer.pointer("/status/code").and_then(Value::as_i64).unwrap_or(0);
            let message = scrub(answer.pointer("/status/message").and_then(Value::as_str).unwrap_or("").trim());
            match code {
                200 | 206 => {
                    let data = answer.pointer_mut("/result/data").map(Value::take).unwrap_or(Value::Null);
                    drop(answer);
                    if !each(data) || code == 200 {
                        return Ok(Ended::Done);
                    }
                }
                204 => return Ok(Ended::Done),
                407 if !authenticated => {
                    let Some((user, password)) = login else {
                        return Err(super::super::connect::auth_failed(
                            "Gremlin Server asks for a login; set a user and password",
                        ));
                    };
                    authenticated = true;
                    let sasl = Zeroizing::new(format!("\0{user}\0{password}"));
                    let sasl = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(sasl.as_bytes()));
                    self.send(&json!({ "requestId": id, "op": "authentication", "processor": processor,
                                       "args": { "saslMechanism": "PLAIN", "sasl": sasl.as_str() } }))
                        .await?;
                }
                401 | 407 => {
                    return Err(super::super::connect::auth_failed(if message.is_empty() {
                        code.to_string()
                    } else {
                        message
                    }));
                }
                598 => {
                    return Err(SourceError::Failed(
                        Detail::new(
                            "gremlin.server_timeout",
                            format!("Gremlin Server stopped the traversal: {message}"),
                        )
                        .with("detail", message),
                    ));
                }
                _ => {
                    if message.to_ascii_lowercase().contains("read only") {
                        return Err(SourceError::Rejected(
                            Detail::new(
                                "gremlin.readonly_violation",
                                format!("Gremlin Server refused the traversal under ReadOnlyStrategy: {message}"),
                            )
                            .with("detail", message),
                        ));
                    }
                    return Err(SourceError::failed(
                        "gremlin.error",
                        format!("Gremlin Server answered {code}: {message}"),
                    )
                    .with("status", code)
                    .with("detail", message));
                }
            }
        }
    }

    pub async fn close(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), self.ws.close(None)).await;
    }
}
