//! Network access of a plugin.
//!
//! EXTENSION POINT: Kalzit's network connector for plugins (the plugin asks Kalzit for a
//! connection to a target its manifest declares; Kalzit checks the target against the manifest,
//! the administrator's approval and the data source target rules, and connects) is being built
//! separately and is not part of this SDK version. Its client belongs here, behind
//! [`connect`], so plugins that use this function keep working unchanged when it lands.
//!
//! Until then a plugin connects on its own, and [`connect`] opens a plain TCP connection. The
//! host checks the configured targets before every call, and an administrator approved the
//! targets of the manifest; neither stops a plugin from connecting elsewhere (docs/api/plugins.md,
//! "Sandbox"). Connect only to the targets your manifest declares.

use tokio::net::TcpStream;

/// Whether connections go through Kalzit's connector. `false` in this version.
pub const THROUGH_KALZIT: bool = false;

/// A TCP connection to `host` and `port`, a target the manifest declares (a host setting, or a
/// fixed host). With Kalzit's connector this will ask Kalzit for the connection instead.
pub async fn connect(host: &str, port: u16) -> std::io::Result<TcpStream> {
    TcpStream::connect((host, port)).await
}
