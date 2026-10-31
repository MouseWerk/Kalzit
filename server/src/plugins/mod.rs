//! Plugins (docs/ARCHITECTURE.md, "Plugins"). The contract lives in the `kalzit-plugin-api`
//! crate: the data source protocol, the manifest and the signing context. Here is the server's
//! side of it:
//!
//! - `wire`: the server's types in the protocol and back; `in_process`: a registered kind served
//!   through the protocol inside the server (the protocol's reference).
//! - `package`: unpacking a package into a private directory and checking it against its
//!   manifest and signature; `store`: installed plugins, trusted keys, hand-overs and blocks.
//! - `process` and `sandbox`: starting a plugin process in the operating system's sandbox, and
//!   the local connection to it; `supervisor`: start on demand, handshake, health, restarts
//!   with backoff, logs; `connector`: the network connections a plugin asks Kalzit for, checked
//!   against its manifest and the target rules.
//! - `remote`: a plugin process as a `DataSourcePlugin`; `host`: the plugins of this server,
//!   their kinds in the registry and the administrator's actions on them.
//! - `catalog`: the signed catalog index (off by default), its checks and installing from it
//!   through the same path as a file.
//! - `panels`: the panel plugins that may be shown and the sandboxed frame document that carries
//!   a panel's bundle (the message exchange itself runs in the browser).

pub mod catalog;
pub mod connector;
pub mod host;
pub mod in_process;
pub mod package;
pub mod panels;
pub mod process;
pub mod remote;
pub mod sandbox;
pub mod store;
pub mod supervisor;
#[cfg(test)]
pub(crate) mod test_results;
pub mod wire;

use std::collections::{BTreeMap, HashSet};
use std::sync::{LazyLock, Mutex};

use axum::http::StatusCode;

use crate::error::ApiError;
use crate::locks::MutexExt;

/// Why the host refused or failed something: a reason code in the `plugin.*` namespace
/// (docs/api/plugins.md, "Reasons"), its parameters and an English text.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct HostError {
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl HostError {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, params: BTreeMap::new(), message: message.into() }
    }

    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    /// The API error: `409 conflict` for a state that refuses the action, `404` for a plugin
    /// that is not installed, `422 validation` otherwise.
    pub fn api(self) -> ApiError {
        let (status, code) = match self.reason {
            "plugin.not_installed" | "plugin.key_unknown" => return ApiError::not_found(),
            "plugin.key_in_use"
            | "plugin.downgrade"
            | "plugin.key_changed"
            | "plugin.kind_changed"
            | "plugin.publisher_changed"
            | "plugin.not_approved"
            | "plugin.nothing_to_approve"
            | "plugin.version_mismatch"
            | "plugin.key_exists"
            | "plugin.untrusted"
            | "plugin.bundle_changed" => (StatusCode::CONFLICT, "conflict"),
            _ => (StatusCode::UNPROCESSABLE_ENTITY, "validation"),
        };
        ApiError::new(status, code, self.message).with_reason(self.reason, self.params)
    }
}

impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        HostError::new("plugin.io", format!("a file of the plugin host could not be written or read: {e}"))
            .with("detail", e)
    }
}

/// The same `&'static str` for equal texts, made once and kept for the life of the process.
/// Kinds, settings fields and their options are `&'static` in the registry; a plugin's names come
/// from its manifest, so they are interned here. Only names from validated manifests (bounded in
/// number and length) are interned, never texts a plugin process sends.
pub fn intern(text: &str) -> &'static str {
    static NAMES: LazyLock<Mutex<HashSet<&'static str>>> = LazyLock::new(Mutex::default);
    let mut names = NAMES.lock_or_recover();
    if let Some(name) = names.get(text) {
        return name;
    }
    let name: &'static str = Box::leak(text.to_string().into_boxed_str());
    names.insert(name);
    name
}

/// The platform name of this build as manifests name it (`[binaries]`), if plugins can run here.
pub fn platform() -> Option<&'static str> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Some("windows-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("linux-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("linux-arm64")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interned_names_are_shared() {
        let a = intern("dev.example.redis");
        let b = intern(&String::from("dev.example.redis"));
        assert!(std::ptr::eq(a, b));
        assert_eq!(a, "dev.example.redis");
    }

    #[test]
    fn this_build_names_its_platform() {
        if cfg!(any(windows, target_os = "linux")) && cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
            assert!(platform().is_some());
        }
    }
}
