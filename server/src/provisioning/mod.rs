//! Provisioning as code (docs/guide/provisioning.md, docs/PLAN.md M7 0.7.4): dashboards, data
//! sources, custom roles and alert rules as YAML or JSON files, typically in a Git checkout.
//!
//! - `document` reads and writes the files, `files` finds them on disk for the command line.
//! - `engine` compares a set's files with what is stored (`plan`), applies the difference in one
//!   transaction (`apply`), lists the managed resources, unlocks one, and writes the stored state
//!   as files (`export`). `routes::provisioning` serves them.
//! - `cli` is `kalzit provision` and `kalzit import grafana`: they read the files and talk to the
//!   running server's API with a service account's token; files never reach the server another
//!   way. `grafana` converts Grafana dashboard JSON (their public format only).
//!
//! A provisioning set belongs to one organization and owns its resources; every resource is named
//! by a `uid` that stays when files move, and `provisioned_resources` keeps the set, the uid, the
//! file, its checksum and a hash of the applied state. A resource belongs to at most one set.
//! While a resource is managed the API refuses normal edits (`ensure_editable`); an org admin may
//! unlock one in an emergency, and the next apply of its set overwrites it. A stored state that no
//! longer matches its hash has drifted. Files never hold secrets: a data source names an
//! environment variable, whose value the command line sends with the request, or keeps what the
//! encrypted store holds. Checks are the API's own (model, settings, rule and role rules), and
//! applying needs `provisioning:write` plus the write permissions of every kind it changes.

pub mod cli;
pub mod document;
pub mod engine;
pub mod files;
pub mod grafana;

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};

/// The kinds of resources provisioning manages.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ResourceKind {
    Datasource,
    Role,
    Dashboard,
    AlertRule,
}

impl ResourceKind {
    /// In the order an apply creates and changes them; deletes run the other way round.
    pub const ALL: [ResourceKind; 4] = [Self::Datasource, Self::Role, Self::Dashboard, Self::AlertRule];

    /// The name in `provisioned_resources.kind`, in paths and in audit entries.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Datasource => "datasource",
            Self::Role => "role",
            Self::Dashboard => "dashboard",
            Self::AlertRule => "alert_rule",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }

    /// The `kind` of a file.
    pub fn document_kind(self) -> &'static str {
        match self {
            Self::Datasource => "DataSource",
            Self::Role => "Role",
            Self::Dashboard => "Dashboard",
            Self::AlertRule => "AlertRule",
        }
    }

    pub fn from_document_kind(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.document_kind() == s)
    }

    /// The folder export writes files of this kind into.
    pub fn folder(self) -> &'static str {
        match self {
            Self::Datasource => "datasources",
            Self::Role => "roles",
            Self::Dashboard => "dashboards",
            Self::AlertRule => "alert-rules",
        }
    }
}

/// Refuses a normal edit (change, move, delete, restore) of a managed resource: its files decide
/// what it holds. An unlocked one may be edited until its set is applied again. `409 conflict`
/// with the reason `provisioning.read_only`, the set, uid and file, so the interface can say
/// where to change it.
pub async fn ensure_editable<'e, E>(db: E, org_id: &str, kind: ResourceKind, resource_id: &str) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let found: Option<(String, String, String)> = sqlx::query_as(
        "SELECT set_name, uid, source_path FROM provisioned_resources \
         WHERE org_id = $1 AND kind = $2 AND resource_id = $3 AND unlocked_at IS NULL",
    )
    .bind(org_id)
    .bind(kind.as_str())
    .bind(resource_id)
    .fetch_optional(db)
    .await?;
    match found {
        None => Ok(()),
        Some((set, uid, path)) => Err(read_only(kind, &set, &uid, &path)),
    }
}

pub fn read_only(kind: ResourceKind, set: &str, uid: &str, path: &str) -> ApiError {
    crate::routes::support::conflict(format!(
        "this {} is managed by the provisioning set {set} ({path}, uid {uid}); change the file and apply the set, \
         or unlock it first",
        kind.as_str().replace('_', " ")
    ))
    .because("provisioning.read_only")
    .param("kind", kind.as_str())
    .param("set", set)
    .param("uid", uid)
    .param("path", path)
}

/// Refuses a change of a whole folder (trash, purge) that holds managed dashboards, directly or
/// below.
pub async fn ensure_folder_editable(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<()> {
    let found: Option<(String, String, String)> = sqlx::query_as(
        "WITH RECURSIVE sub (id) AS (SELECT id FROM folders WHERE org_id = $1 AND id = $2 \
         UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id WHERE f.org_id = $1) \
         SELECT p.set_name, p.uid, p.source_path FROM provisioned_resources p JOIN dashboards d ON d.id = p.resource_id \
         WHERE p.org_id = $1 AND p.kind = 'dashboard' AND p.unlocked_at IS NULL \
         AND d.folder_id IN (SELECT id FROM sub) ORDER BY p.uid LIMIT 1",
    )
    .bind(org_id)
    .bind(folder_id)
    .fetch_optional(&mut *conn)
    .await?;
    match found {
        None => Ok(()),
        Some((set, uid, path)) => Err(read_only(ResourceKind::Dashboard, &set, &uid, &path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_round_trip() {
        for kind in ResourceKind::ALL {
            assert_eq!(ResourceKind::parse(kind.as_str()), Some(kind));
            assert_eq!(ResourceKind::from_document_kind(kind.document_kind()), Some(kind));
        }
        assert_eq!(serde_json::to_value(ResourceKind::AlertRule).unwrap(), "alertRule");
    }
}
