//! Folder structure: ancestors, restriction and the tree of an organization. Authorization
//! (`authz::check_resource`) uses `folder_is_restricted` and `folder_ancestors`; the folder and
//! dashboard routes use the rest.

use std::collections::{BTreeSet, HashMap};

use sqlx::AnyPool;

use crate::authz::{OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};

/// Folders nest at most this deep, so paths stay readable and every walk up the tree is short.
pub const MAX_DEPTH: usize = 10;

/// One step up from `folder_id`: its parent and own restricted flag, or `None` if the folder is
/// not in the organization. Trashed folders count; trash does not change the structure.
async fn link(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<Option<(Option<String>, bool)>> {
    let row: Option<(Option<String>, i64)> =
        sqlx::query_as("SELECT parent_id, restricted FROM folders WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(folder_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(parent, restricted)| (parent, restricted != 0)))
}

/// The folder and its parents, nearest first, with their own restricted flags.
async fn chain(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<Vec<(String, bool)>> {
    let mut out: Vec<(String, bool)> = Vec::new();
    let mut next = Some(folder_id.to_string());
    while let Some(id) = next {
        // Moves refuse cycles; this guard keeps a damaged table from hanging a request.
        if out.len() > MAX_DEPTH * 2 || out.iter().any(|(seen, _)| *seen == id) {
            return Err(ApiError::internal("folders", format!("folder {folder_id} has a cycle among its parents")));
        }
        let Some((parent, restricted)) = link(db, org_id, &id).await? else {
            // The folder itself is missing: not in this organization. A missing parent cannot
            // happen with the foreign key, so it is an error as well.
            return Err(if out.is_empty() {
                ApiError::not_found()
            } else {
                ApiError::internal("folders", format!("parent {id} of folder {folder_id} is missing"))
            });
        };
        out.push((id, restricted));
        next = parent;
    }
    Ok(out)
}

/// The folder itself first, then its parents up to the top level. `not_found` if the folder is
/// not in the organization.
pub async fn folder_ancestors(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<Vec<String>> {
    Ok(chain(db, org_id, folder_id).await?.into_iter().map(|(id, _)| id).collect())
}

/// Whether the folder is restricted, by its own flag or a restricted parent (restriction covers
/// subfolders). `not_found` if the folder is not in the organization.
pub async fn folder_is_restricted(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<bool> {
    Ok(chain(db, org_id, folder_id).await?.iter().any(|(_, restricted)| *restricted))
}

/// The folder a dashboard of the organization lives in (`None`: top level). `not_found` if the
/// dashboard is not in the organization.
pub async fn dashboard_folder(db: &AnyPool, org_id: &str, dashboard_id: &str) -> ApiResult<Option<String>> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT folder_id FROM dashboards WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(dashboard_id)
            .fetch_optional(db)
            .await?;
    row.map(|(folder,)| folder).ok_or_else(ApiError::not_found)
}

/// Whether the caller sees restricted folders without a grant on them. Grants on single folders
/// (stream A, migration 0003) widen this; until then members who manage folder permissions
/// (admins and owners) are the ones who see restricted folders.
pub fn sees_restricted(ctx: &OrgCtx) -> bool {
    ctx.permissions.contains(&Permission::FoldersPermissions)
}

/// `not_found` unless the caller may see `folder_id` (and with it the dashboards inside).
pub async fn ensure_visible(db: &AnyPool, ctx: &OrgCtx, folder_id: Option<&str>) -> ApiResult<()> {
    let Some(folder_id) = folder_id else { return Ok(()) };
    if folder_is_restricted(db, &ctx.org_id, folder_id).await? && !sees_restricted(ctx) {
        return Err(ApiError::not_found());
    }
    Ok(())
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct FolderRow {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub restricted: i64,
    pub version: i64,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

pub const FOLDER_COLUMNS: &str =
    "id, parent_id, name, restricted, version, created_by, created_at, updated_at, deleted_at";

/// All folders of an organization, trashed ones included, for work on the whole tree in memory.
pub struct Tree {
    pub rows: HashMap<String, FolderRow>,
}

impl Tree {
    pub async fn load(db: &AnyPool, org_id: &str) -> ApiResult<Self> {
        let rows: Vec<FolderRow> =
            sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE org_id = $1")))
                .bind(org_id)
                .fetch_all(db)
                .await?;
        Ok(Self::from_rows(rows))
    }

    pub fn from_rows(rows: Vec<FolderRow>) -> Self {
        Self { rows: rows.into_iter().map(|r| (r.id.clone(), r)).collect() }
    }

    /// The folder and its parents, nearest first (stops at a cycle or a missing parent).
    pub fn ancestors(&self, id: &str) -> Vec<&FolderRow> {
        let mut out: Vec<&FolderRow> = Vec::new();
        let mut next = self.rows.get(id);
        while let Some(row) = next {
            if out.iter().any(|r| r.id == row.id) {
                break;
            }
            out.push(row);
            next = row.parent_id.as_deref().and_then(|p| self.rows.get(p));
        }
        out
    }

    pub fn is_restricted(&self, id: &str) -> bool {
        self.ancestors(id).iter().any(|r| r.restricted != 0)
    }

    /// Whether the caller sees the folder: see `ensure_visible`.
    pub fn visible(&self, ctx: &OrgCtx, id: &str) -> bool {
        sees_restricted(ctx) || !self.is_restricted(id)
    }

    fn children(&self) -> HashMap<&str, Vec<&FolderRow>> {
        let mut children: HashMap<&str, Vec<&FolderRow>> = HashMap::new();
        for row in self.rows.values() {
            if let Some(parent) = row.parent_id.as_deref() {
                children.entry(parent).or_default().push(row);
            }
        }
        children
    }

    /// Every folder below `id` (not `id` itself), parents before their children.
    pub fn descendants(&self, id: &str) -> Vec<&FolderRow> {
        let children = self.children();
        let mut out = Vec::new();
        let mut seen = BTreeSet::from([id]);
        let mut queue = vec![id];
        while let Some(current) = queue.pop() {
            for child in children.get(current).into_iter().flatten() {
                if seen.insert(child.id.as_str()) {
                    out.push(*child);
                    queue.push(child.id.as_str());
                }
            }
        }
        out
    }

    /// Levels below `id`: 0 without subfolders.
    pub fn height(&self, id: &str) -> usize {
        let base = self.ancestors(id).len();
        self.descendants(id).iter().map(|d| self.ancestors(&d.id).len() - base).max().unwrap_or(0)
    }

    /// Checks that `folder` (or a new folder, `None`) may live under `parent`: no cycle, and the
    /// tree stays within `MAX_DEPTH`.
    pub fn check_placement(&self, folder: Option<&str>, parent: &str) -> ApiResult<()> {
        let parent_chain = self.ancestors(parent);
        if let Some(folder) = folder
            && parent_chain.iter().any(|r| r.id == folder)
        {
            return Err(
                ApiError::validation("a folder cannot be moved into itself or its subfolders").with_field("parentId")
            );
        }
        let height = folder.map_or(0, |f| self.height(f));
        if parent_chain.len() + 1 + height > MAX_DEPTH {
            return Err(
                ApiError::validation(format!("folders nest at most {MAX_DEPTH} levels deep")).with_field("parentId")
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, parent: Option<&str>, restricted: bool) -> FolderRow {
        FolderRow {
            id: id.into(),
            parent_id: parent.map(Into::into),
            name: id.into(),
            restricted: restricted as i64,
            version: 1,
            created_by: None,
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    /// a > b > c, a > d (restricted) > e
    fn tree() -> Tree {
        Tree::from_rows(vec![
            row("a", None, false),
            row("b", Some("a"), false),
            row("c", Some("b"), false),
            row("d", Some("a"), true),
            row("e", Some("d"), false),
        ])
    }

    #[test]
    fn moves_into_the_own_subtree_are_refused() {
        let t = tree();
        for (folder, parent) in [("a", "a"), ("a", "c"), ("b", "c"), ("d", "e")] {
            let err = t.check_placement(Some(folder), parent).unwrap_err();
            assert_eq!(err.field, Some("parentId"), "{folder} under {parent}");
        }
        assert!(t.check_placement(Some("c"), "e").is_ok());
        assert!(t.check_placement(Some("d"), "c").is_ok());
        assert!(t.check_placement(None, "c").is_ok());
    }

    #[test]
    fn depth_is_limited_including_the_moved_subtree() {
        let mut rows = vec![row("f0", None, false)];
        for i in 1..MAX_DEPTH {
            rows.push(row(&format!("f{i}"), Some(&format!("f{}", i - 1)), false));
        }
        rows.push(row("x", None, false));
        rows.push(row("y", Some("x"), false));
        let t = Tree::from_rows(rows);
        let deepest = format!("f{}", MAX_DEPTH - 1);
        assert!(t.check_placement(None, &deepest).is_err(), "an eleventh level");
        assert!(t.check_placement(None, &format!("f{}", MAX_DEPTH - 2)).is_ok());
        assert!(t.check_placement(Some("x"), &format!("f{}", MAX_DEPTH - 2)).is_err(), "x brings y along");
        assert_eq!(t.height("x"), 1);
    }

    #[test]
    fn restriction_covers_subfolders() {
        let t = tree();
        assert!(t.is_restricted("d") && t.is_restricted("e"));
        assert!(!t.is_restricted("a") && !t.is_restricted("c"));
        let ids = |rows: Vec<&FolderRow>| rows.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(t.ancestors("e")), ["e", "d", "a"]);
        let mut below = ids(t.descendants("a"));
        below.sort();
        assert_eq!(below, ["b", "c", "d", "e"]);
    }

    #[test]
    fn a_damaged_cycle_does_not_hang() {
        let t = Tree::from_rows(vec![row("p", Some("q"), false), row("q", Some("p"), false)]);
        assert_eq!(t.ancestors("p").len(), 2);
        assert_eq!(t.descendants("p").len(), 1);
    }

    #[tokio::test]
    async fn queries_walk_the_stored_tree() {
        // One connection, so every query sees the same in-memory database.
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0), ('p', 'P', 0)")
            .execute(&db)
            .await
            .unwrap();
        for (id, parent, restricted) in [("a", None, 0), ("d", Some("a"), 1), ("e", Some("d"), 0)] {
            sqlx::query(
                "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_at, updated_at) \
                 VALUES ($1, 'o', $2, $1, $3, 1, 0, 0)",
            )
            .bind(id)
            .bind(parent)
            .bind(restricted)
            .execute(&db)
            .await
            .unwrap();
        }
        assert_eq!(folder_ancestors(&db, "o", "e").await.unwrap(), ["e", "d", "a"]);
        assert!(folder_is_restricted(&db, "o", "e").await.unwrap());
        assert!(!folder_is_restricted(&db, "o", "a").await.unwrap());
        // Another organization's folder does not exist from here.
        assert_eq!(folder_ancestors(&db, "p", "e").await.unwrap_err().code, "not_found");
        assert_eq!(folder_is_restricted(&db, "o", "nope").await.unwrap_err().code, "not_found");
    }
}
