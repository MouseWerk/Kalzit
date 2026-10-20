//! Settings that can change at runtime, server-wide or per organization. Every setting is declared
//! in `REGISTRY` with its scope, default and whether the UI may change it.
//!
//! The lookup functions are the stable interface for every work stream. Today they answer the
//! default; stream B adds the layers (environment > file > database > default) and the
//! `server_settings` / `org_settings` tables (migration 0004) behind the same signatures.

use serde_json::{Value, json};

use crate::app::AppState;
use crate::error::{ApiError, ApiResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    Server,
    Org,
}

pub struct SettingDef {
    pub key: &'static str,
    pub scope: Scope,
    pub default: fn() -> Value,
    /// Settings that could lock an admin out (network, TLS) are file or environment only.
    pub ui_editable: bool,
    pub description: &'static str,
}

pub const REGISTRY: &[SettingDef] = &[
    SettingDef {
        key: "datasources.sqlite_dirs",
        scope: Scope::Server,
        default: || json!([]),
        ui_editable: true,
        description: "Directories SQLite data sources may open. Never the data directory.",
    },
    SettingDef {
        key: "datasources.allowed_targets",
        scope: Scope::Server,
        default: || json!([]),
        ui_editable: true,
        description: "If not empty, data sources may only connect to these hosts and networks.",
    },
    SettingDef {
        key: "datasources.query_timeout_secs",
        scope: Scope::Server,
        default: || json!(30),
        ui_editable: true,
        description: "Longest a single query may run.",
    },
    SettingDef {
        key: "datasources.max_rows",
        scope: Scope::Server,
        default: || json!(100_000),
        ui_editable: true,
        description: "Most rows, points, documents or nodes one query returns.",
    },
    SettingDef {
        key: "datasources.max_response_bytes",
        scope: Scope::Server,
        default: || json!(50 * 1024 * 1024),
        ui_editable: true,
        description: "Largest result one query may produce.",
    },
    SettingDef {
        key: "audit.retention_days",
        scope: Scope::Server,
        default: || json!(365),
        ui_editable: true,
        description: "Audit events older than this are deleted, since they hold client addresses.",
    },
];

fn def(key: &str, scope: Scope) -> ApiResult<&'static SettingDef> {
    REGISTRY
        .iter()
        .find(|d| d.key == key && d.scope == scope)
        .ok_or_else(|| ApiError::internal("settings", format!("unknown {scope:?} setting {key}")))
}

/// The effective value of a server setting.
pub async fn get(_state: &AppState, key: &str) -> ApiResult<Value> {
    Ok((def(key, Scope::Server)?.default)())
}

/// The effective value of an organization setting.
pub async fn get_org(_state: &AppState, _org_id: &str, key: &str) -> ApiResult<Value> {
    Ok((def(key, Scope::Org)?.default)())
}

#[cfg(test)]
mod tests {
    use super::REGISTRY;

    #[test]
    fn keys_are_unique_and_namespaced() {
        let mut seen = std::collections::BTreeSet::new();
        for d in REGISTRY {
            assert!(seen.insert(d.key), "{} twice", d.key);
            assert!(d.key.contains('.'), "{} needs an area prefix", d.key);
            assert!(!d.description.is_empty());
        }
    }
}
