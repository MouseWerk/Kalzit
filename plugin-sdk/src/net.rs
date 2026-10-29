//! Network access of a plugin: through Kalzit's network connector only (docs/api/plugins.md,
//! "Network connector"). The plugin's sandbox has no network of its own; for every connection it
//! asks Kalzit, naming the data source, host, port and protocol. Kalzit checks that the target is
//! one the manifest declares for the data source's current settings, applies the data source
//! target rules, connects and hands over the connected stream. Over it the plugin speaks its
//! database's protocol and, for `Protocol::Tls`, wraps it in TLS itself.

pub use kalzit_plugin_api::connector::{ConnectError, Stream};
pub use kalzit_plugin_api::datasource::v1::TargetProtocol as Protocol;

use crate::{Connection, Detail, Error, ErrorKind};

/// A refused connection as the plugin's error, with Kalzit's reason (a `target.*` reason reaches
/// the user as it is); a connector that cannot be reached as `source.no_answer`.
impl From<ConnectError> for Error {
    fn from(e: ConnectError) -> Self {
        use kalzit_plugin_api::datasource::v1::ErrorKind as Kind;
        match e {
            ConnectError::Refused(refused) => {
                let kind = match Kind::try_from(refused.kind) {
                    Ok(Kind::Blocked) => ErrorKind::Blocked,
                    Ok(Kind::Timeout) => ErrorKind::Timeout,
                    _ => ErrorKind::Failed,
                };
                let d = refused.detail.unwrap_or_default();
                Error { kind, detail: Detail { reason: d.reason, params: d.params, message: d.message } }
            }
            other => Error::failed("source.no_answer", other.to_string()),
        }
    }
}

/// The connector of this start, kept by `run` before the token leaves the environment.
static CONNECTOR: std::sync::OnceLock<Option<kalzit_plugin_api::connector::Connector>> = std::sync::OnceLock::new();

pub(crate) fn init(connector: Option<kalzit_plugin_api::connector::Connector>) {
    let _ = CONNECTOR.set(connector);
}

/// Whether connections go through Kalzit's connector: always, since protocol minor 1.
pub const THROUGH_KALZIT: bool = true;

/// A connection to `host:port` for the data source `conn`, a target its manifest declares (a
/// host or URL setting, or a fixed host) with the declared protocol. Answers the stream and the
/// address Kalzit connected to.
pub async fn connect(
    conn: &Connection,
    host: &str,
    port: u16,
    protocol: Protocol,
) -> Result<(Stream, String), ConnectError> {
    let connector = CONNECTOR.get().cloned().flatten().ok_or_else(|| {
        ConnectError::Io(std::io::Error::new(
            std::io::ErrorKind::NotConnected,
            "Kalzit gave this plugin no network connector (KALZIT_PLUGIN_CONNECTOR)",
        ))
    })?;
    connector.connect(&conn.datasource_id, host, port, protocol).await
}
