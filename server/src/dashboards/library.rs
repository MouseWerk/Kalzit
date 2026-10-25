//! Library panels: a panel kept once in a folder and shown by many dashboards. Rights follow the
//! folder (`dashboards:read` to use one, `dashboards:write` to change it, `dashboards:delete` to
//! delete it; at the top level the org-wide permission), so a restricted folder hides its library
//! panels too. The routes live in `routes/library_panels.rs`.
//!
//! A dashboard stores only the reference (`libraryPanelId`); reading the dashboard shows the
//! panels it references and runs their queries, as for its own stored queries. Whoever adds a
//! reference must be able to read that library panel; whoever saves a library panel must be
//! allowed to query every data source its new or changed queries use.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::Value;
use sqlx::AnyPool;

use super::model::{self, DashboardModel};
use crate::authz::{self, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct LibraryRow {
    pub id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub model: String,
    pub version: i64,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_by: Option<String>,
    pub updated_at: i64,
}

pub const LIBRARY_COLUMNS: &str = "id, folder_id, name, model, version, created_by, created_at, updated_by, updated_at";

pub async fn fetch<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: &str,
    id: &str,
) -> ApiResult<Option<LibraryRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {LIBRARY_COLUMNS} FROM library_panels WHERE org_id = $1 AND id = $2"
    )))
    .bind(org_id)
    .bind(id)
    .fetch_optional(db)
    .await?)
}

/// Whether `folder` is in the trash (a trashed folder takes its subfolders along). Library panels
/// there do not exist for the routes or for new references until the folder is restored.
pub async fn in_trashed_folder(db: &AnyPool, org_id: &str, folder: Option<&str>) -> ApiResult<bool> {
    let Some(folder) = folder else { return Ok(false) };
    let row: Option<(Option<i64>,)> = sqlx::query_as("SELECT deleted_at FROM folders WHERE org_id = $1 AND id = $2")
        .bind(org_id)
        .bind(folder)
        .fetch_optional(db)
        .await?;
    Ok(matches!(row, Some((Some(_),))))
}

/// The caller may do `permission` on library panels in `folder` (`None`: the top level, which
/// takes the org-wide permission). A folder they cannot see is `not_found`.
pub async fn check_place(db: &AnyPool, ctx: &OrgCtx, permission: Permission, folder: Option<&str>) -> ApiResult<()> {
    match folder {
        Some(folder) => authz::check_resource(db, ctx, permission, Resource::Folder(folder)).await,
        None => ctx.check(permission),
    }
}

/// The stored content, migrated to the current `schemaVersion`.
pub fn stored_content(raw: &str) -> ApiResult<Value> {
    let value: Value = serde_json::from_str(raw).map_err(|e| ApiError::internal("library panels", e))?;
    model::parse_library_panel(value).map_err(|e| ApiError::internal("library panels", e))
}

/// A library panel as a dashboard's answer carries it: enough to draw the panel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPanel {
    pub id: String,
    pub name: String,
    pub version: i64,
    pub model: Value,
}

/// The library panels `ids` names that exist in the organization. Reading the dashboard is what
/// shows them, as it runs the dashboard's stored queries: a viewer need not see their folder.
pub async fn linked_panels(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    ids: &BTreeSet<&str>,
) -> ApiResult<BTreeMap<String, LinkedPanel>> {
    let mut out = BTreeMap::new();
    for id in ids {
        if let Some(row) = fetch(&mut *conn, org_id, id).await? {
            // One unreadable library panel leaves its slot empty instead of the whole dashboard
            // failing to open or save.
            let model = match stored_content(&row.model) {
                Ok(model) => model,
                Err(e) => {
                    tracing::warn!("library panel {id} cannot be read, its slots stay empty: {}", e.message);
                    continue;
                }
            };
            out.insert(row.id.clone(), LinkedPanel { model, id: row.id, name: row.name, version: row.version });
        }
    }
    Ok(out)
}

/// Every library panel the model references and `previous` (the stored version) did not must
/// exist in the organization and be readable by the caller; one they cannot see is
/// `422 validation` on `model`, as if it did not exist.
pub async fn check_references(
    db: &AnyPool,
    ctx: &OrgCtx,
    model: &DashboardModel,
    previous: Option<&DashboardModel>,
) -> ApiResult<()> {
    let known = previous.map(DashboardModel::library_panel_ids).unwrap_or_default();
    for id in model.library_panel_ids().difference(&known) {
        let missing = || ApiError::validation(format!("library panel {id} does not exist")).with_field("model");
        let row = fetch(db, &ctx.org_id, id).await?.ok_or_else(missing)?;
        if in_trashed_folder(db, &ctx.org_id, row.folder_id.as_deref()).await? {
            return Err(missing());
        }
        match check_place(db, ctx, Permission::DashboardsRead, row.folder_id.as_deref()).await {
            Ok(()) => {}
            Err(e) if e.code == "not_found" => return Err(missing()),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Inside the save's transaction, after the organization's lock: every library panel the save
/// adds still exists. A delete takes the same lock before it counts the uses, so either the
/// delete sees this save's reference and refuses, or this check sees the panel gone and refuses
/// the save (`422 validation` on `model`).
pub async fn recheck_added(conn: &mut sqlx::AnyConnection, org_id: &str, ids: &BTreeSet<&str>) -> ApiResult<()> {
    for id in ids {
        let missing = || ApiError::validation(format!("library panel {id} does not exist")).with_field("model");
        let row = fetch(&mut *conn, org_id, id).await?.ok_or_else(missing)?;
        // A folder trashed meanwhile takes its library panels out of reach, as in `check_references`.
        if let Some(folder) = row.folder_id.as_deref() {
            let trashed: Option<(Option<i64>,)> =
                sqlx::query_as("SELECT deleted_at FROM folders WHERE org_id = $1 AND id = $2")
                    .bind(org_id)
                    .bind(folder)
                    .fetch_optional(&mut *conn)
                    .await?;
            if matches!(trashed, Some((Some(_),))) {
                return Err(missing());
            }
        }
    }
    Ok(())
}

/// Records which library panels and tags the dashboard's current version has, inside the save's
/// transaction.
pub async fn sync_references(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    dashboard_id: &str,
    model: &DashboardModel,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM library_panel_uses WHERE dashboard_id = $1")
        .bind(dashboard_id)
        .execute(&mut *conn)
        .await?;
    for id in model.library_panel_ids() {
        sqlx::query("INSERT INTO library_panel_uses (org_id, library_panel_id, dashboard_id) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(id)
            .bind(dashboard_id)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("DELETE FROM dashboard_tags WHERE dashboard_id = $1").bind(dashboard_id).execute(&mut *conn).await?;
    for tag in &model.tags {
        sqlx::query("INSERT INTO dashboard_tags (org_id, dashboard_id, tag, tag_key) VALUES ($1, $2, $3, $4)")
            .bind(org_id)
            .bind(dashboard_id)
            .bind(tag)
            .bind(tag.to_lowercase())
            .execute(&mut *conn)
            .await?;
    }
    let tags = serde_json::to_string(&model.tags).map_err(|e| ApiError::internal("dashboards", e))?;
    sqlx::query("UPDATE dashboards SET tags = $1 WHERE org_id = $2 AND id = $3")
        .bind(tags)
        .bind(org_id)
        .bind(dashboard_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Deletes what belongs to dashboards that are purged: their annotations, tags and library panel
/// uses. `filter` is the SQL condition on `dashboards` (aliased `d`) with `$1` the organization.
pub async fn purge_dashboard_rows(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    filter: &str,
    arg: &str,
) -> ApiResult<()> {
    for table in ["annotations", "dashboard_tags", "library_panel_uses"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {table} WHERE dashboard_id IN (SELECT d.id FROM dashboards d WHERE d.org_id = $1 AND {filter})"
        )))
        .bind(org_id)
        .bind(arg)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The recheck inside the save's transaction refuses a library panel deleted after the check
    /// before it: a save racing a delete leaves no reference to a missing panel.
    #[tokio::test]
    async fn a_library_panel_deleted_meanwhile_is_refused_inside_the_save() {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)").execute(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO library_panels (id, org_id, name, search_name, model, version, created_at, updated_at) \
             VALUES ('lib', 'o', 'L', 'l', '{}', 1, 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        let mut conn = db.acquire().await.unwrap();
        assert!(recheck_added(&mut conn, "o", &BTreeSet::from(["lib"])).await.is_ok());
        // Another organization's id is as missing as a deleted one.
        let e = recheck_added(&mut conn, "other", &BTreeSet::from(["lib"])).await.unwrap_err();
        assert_eq!((e.code, e.field), ("validation", Some("model")));
        sqlx::query("DELETE FROM library_panels WHERE id = 'lib'").execute(&mut *conn).await.unwrap();
        let e = recheck_added(&mut conn, "o", &BTreeSet::from(["lib"])).await.unwrap_err();
        assert!(e.message.contains("lib"), "{}", e.message);
        assert!(recheck_added(&mut conn, "o", &BTreeSet::new()).await.is_ok());
        // One whose folder went to the trash meanwhile is out of reach too.
        sqlx::query(
            "INSERT INTO folders (id, org_id, name, restricted, version, created_at, updated_at, deleted_at) \
             VALUES ('f', 'o', 'F', 0, 1, 0, 0, 5)",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO library_panels (id, org_id, folder_id, name, search_name, model, version, created_at, \
             updated_at) VALUES ('in-trash', 'o', 'f', 'T', 't', '{}', 1, 0, 0)",
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        let e = recheck_added(&mut conn, "o", &BTreeSet::from(["in-trash"])).await.unwrap_err();
        assert_eq!(e.field, Some("model"));
        sqlx::query("UPDATE folders SET deleted_at = NULL WHERE id = 'f'").execute(&mut *conn).await.unwrap();
        assert!(recheck_added(&mut conn, "o", &BTreeSet::from(["in-trash"])).await.is_ok());
    }
}
