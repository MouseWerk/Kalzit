//! Folder structure: ancestors, restriction and the tree of an organization. Authorization
//! (`authz::check_resource`) uses `folder_chain` and `dashboard_folder`; the folder and dashboard
//! routes use the rest.

use std::collections::{BTreeSet, HashMap, HashSet};

use sqlx::AnyPool;

use crate::authz::{self, OrgCtx};
use crate::error::{ApiError, ApiResult};

/// Folders nest at most this deep, so paths stay readable and every walk up the tree is short.
pub const MAX_DEPTH: usize = 10;

type LinkRow = (Option<String>, bool, Option<String>);

/// One step up from `folder_id`: its parent, own restricted flag and owner team, or `None` if the
/// folder is not in the organization. Trashed folders count; trash does not change the structure.
async fn link(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<Option<LinkRow>> {
    let row: Option<(Option<String>, i64, Option<String>)> =
        sqlx::query_as("SELECT parent_id, restricted, owner_team_id FROM folders WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(folder_id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(parent, restricted, owner)| (parent, restricted != 0, owner)))
}

/// One folder of a chain, its own restricted flag and the team that owns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderLink {
    pub id: String,
    pub restricted: bool,
    pub owner_team: Option<String>,
}

/// The folder itself first, then its parents up to the top level, with their own restricted
/// flags. The nearest restricted folder in the chain decides who sees the folder: a restricted
/// subfolder narrows access further. `not_found` if the folder is not in the organization.
pub async fn folder_chain(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<Vec<FolderLink>> {
    let mut out: Vec<FolderLink> = Vec::new();
    let mut next = Some(folder_id.to_string());
    while let Some(id) = next {
        // Moves refuse cycles; this guard keeps a damaged table from hanging a request.
        if out.len() > MAX_DEPTH * 2 || out.iter().any(|seen| seen.id == id) {
            return Err(ApiError::internal("folders", format!("folder {folder_id} has a cycle among its parents")));
        }
        let Some((parent, restricted, owner_team)) = link(db, org_id, &id).await? else {
            // The folder itself is missing: not in this organization. A missing parent cannot
            // happen with the foreign key, so it is an error as well.
            return Err(if out.is_empty() {
                ApiError::not_found()
            } else {
                ApiError::internal("folders", format!("parent {id} of folder {folder_id} is missing"))
            });
        };
        out.push(FolderLink { id, restricted, owner_team });
        next = parent;
    }
    Ok(out)
}

/// The folder itself first, then its parents up to the top level. `not_found` if the folder is
/// not in the organization.
pub async fn folder_ancestors(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<Vec<String>> {
    Ok(folder_chain(db, org_id, folder_id).await?.into_iter().map(|l| l.id).collect())
}

/// Whether the folder is restricted, by its own flag or a restricted parent (restriction covers
/// subfolders). `not_found` if the folder is not in the organization.
pub async fn folder_is_restricted(db: &AnyPool, org_id: &str, folder_id: &str) -> ApiResult<bool> {
    Ok(folder_chain(db, org_id, folder_id).await?.iter().any(|l| l.restricted))
}

/// SQL that decides which folders the caller sees, by the rule of `authz::check_resource`: the
/// nearest restricted folder above (or at) a folder governs it, and only the caller's grants on
/// folders from there down count, membership in a team that owns one of them counting like a
/// grant; members whose org-wide permissions include `folders:permissions` see every folder. Defines `caller_grants(resource_type, resource_id)`
/// (the grants of the caller, their teams and roles) and `hidden_folders(id)`. Binds `$1` the
/// organization, `$2` the user id, `$3` the member's role key, `$4` 1 when the caller sees every
/// folder; the query that uses it numbers its own parameters from `$5`.
pub const VISIBILITY_CTE: &str = "WITH RECURSIVE \
    caller_teams(id) AS (SELECT m.team_id FROM team_members m JOIN teams t ON t.id = m.team_id \
        WHERE m.user_id = $2 AND t.org_id = $1), \
    caller_grants(resource_type, resource_id) AS (SELECT g.resource_type, g.resource_id FROM resource_grants g \
        WHERE g.org_id = $1 AND ((g.subject_type = 'user' AND g.subject_id = $2) \
        OR (g.subject_type = 'team' AND g.subject_id IN (SELECT id FROM caller_teams)) \
        OR (g.subject_type = 'role' AND (g.subject_id = $3 OR g.subject_id IN \
            (SELECT r.role FROM team_roles r WHERE r.team_id IN (SELECT id FROM caller_teams)))))), \
    folder_walk(id, restricted, granted, depth) AS ( \
        SELECT f.id, CAST(f.restricted AS BIGINT), \
            CAST(CASE WHEN f.id IN (SELECT resource_id FROM caller_grants WHERE resource_type = 'folder') \
                OR f.owner_team_id IN (SELECT id FROM caller_teams) THEN 1 ELSE 0 END AS BIGINT), \
            CAST(1 AS BIGINT) \
        FROM folders f WHERE f.org_id = $1 AND f.parent_id IS NULL \
        UNION ALL \
        SELECT c.id, CAST(CASE WHEN c.restricted = 1 OR w.restricted = 1 THEN 1 ELSE 0 END AS BIGINT), \
            CAST(CASE WHEN c.id IN (SELECT resource_id FROM caller_grants WHERE resource_type = 'folder') \
                OR c.owner_team_id IN (SELECT id FROM caller_teams) THEN 1 \
                WHEN c.restricted = 1 THEN 0 ELSE w.granted END AS BIGINT), w.depth + 1 \
        FROM folders c JOIN folder_walk w ON c.parent_id = w.id WHERE w.depth < 64), \
    hidden_folders(id) AS (SELECT id FROM folder_walk \
        WHERE CAST($4 AS BIGINT) = 0 AND restricted = 1 AND granted = 0) ";

/// The condition, for a query that starts with `VISIBILITY_CTE`, that the caller sees a row of
/// `dashboards` named `alias`, by the rule of `authz::check_resource`: a team-only dashboard
/// governs itself (only grants on it and membership in its owner team count); any other one is
/// seen where its folder is seen, or through a grant on it or membership in its owner team.
pub fn dashboard_visible(alias: &str) -> String {
    let a = alias;
    format!(
        "(CAST($4 AS BIGINT) = 1 \
         OR ({a}.team_only = 0 AND ({a}.folder_id IS NULL OR {a}.folder_id NOT IN (SELECT id FROM hidden_folders))) \
         OR {a}.id IN (SELECT resource_id FROM caller_grants WHERE resource_type = 'dashboard') \
         OR {a}.owner_team_id IN (SELECT id FROM caller_teams))"
    )
}

/// The value of `$4` in `VISIBILITY_CTE` for the caller.
pub fn sees_every_folder(ctx: &OrgCtx) -> i64 {
    authz::role_sees_restricted(&ctx.permissions) as i64
}

/// The folders hidden from the caller (see `VISIBILITY_CTE`), read through `conn`: a pooled
/// connection, or the transaction holding the organization's lock.
pub async fn hidden_folder_ids(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx) -> ApiResult<HashSet<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{VISIBILITY_CTE} SELECT id FROM hidden_folders")))
            .bind(&ctx.org_id)
            .bind(&ctx.user.id)
            .bind(&ctx.role)
            .bind(sees_every_folder(ctx))
            .fetch_all(&mut *conn)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Whether a restricted folder governs `folder_id`, read through `conn` (the transaction that
/// holds the organization's lock).
pub async fn restricted_in(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<bool> {
    let mut next = Some(folder_id.to_string());
    let mut steps = 0;
    while let Some(id) = next {
        steps += 1;
        if steps > MAX_DEPTH * 2 {
            return Err(ApiError::internal("folders", format!("folder {folder_id} has a cycle among its parents")));
        }
        let row: Option<(Option<String>, i64)> =
            sqlx::query_as("SELECT parent_id, restricted FROM folders WHERE org_id = $1 AND id = $2")
                .bind(org_id)
                .bind(&id)
                .fetch_optional(&mut *conn)
                .await?;
        let Some((parent, restricted)) = row else { return Ok(false) };
        if restricted != 0 {
            return Ok(true);
        }
        next = parent;
    }
    Ok(false)
}

/// Records that a purged folder (and the dashboards in it) was restricted content, so its audit
/// events stay hidden from members without access to restricted folders once nothing is left to
/// decide by. Runs in the purge's transaction, before the rows go.
pub async fn tombstone_folder(conn: &mut sqlx::AnyConnection, org_id: &str, folder_id: &str) -> ApiResult<()> {
    sqlx::query("INSERT INTO restricted_tombstones (org_id, resource_type, resource_id) VALUES ($1, 'folder', $2)")
        .bind(org_id)
        .bind(folder_id)
        .execute(&mut *conn)
        .await?;
    sqlx::query(
        "INSERT INTO restricted_tombstones (org_id, resource_type, resource_id) \
         SELECT org_id, 'dashboard', id FROM dashboards WHERE org_id = $1 AND folder_id = $2",
    )
    .bind(org_id)
    .bind(folder_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// See `tombstone_folder`, for one dashboard.
pub async fn tombstone_dashboard(conn: &mut sqlx::AnyConnection, org_id: &str, dashboard_id: &str) -> ApiResult<()> {
    sqlx::query("INSERT INTO restricted_tombstones (org_id, resource_type, resource_id) VALUES ($1, 'dashboard', $2)")
        .bind(org_id)
        .bind(dashboard_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
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
    /// Shared by everything trashed in one go, so a restore brings back exactly that.
    pub trash_batch: Option<String>,
    /// The team that owns the folder: at the top level and restricted, a team space.
    pub owner_team_id: Option<String>,
}

pub const FOLDER_COLUMNS: &str = "id, parent_id, name, restricted, version, created_by, created_at, updated_at, \
     deleted_at, trash_batch, owner_team_id";

/// All folders of an organization, trashed ones included, for work on the whole tree in memory,
/// with the ones hidden from the caller.
pub struct Tree {
    pub rows: HashMap<String, FolderRow>,
    hidden: HashSet<String>,
}

impl Tree {
    /// Reads through `conn`: a pooled connection, or the transaction holding the organization's
    /// lock (`authz::lock_org`), which must not touch the pool.
    pub async fn load(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx) -> ApiResult<Self> {
        let rows: Vec<FolderRow> =
            sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {FOLDER_COLUMNS} FROM folders WHERE org_id = $1")))
                .bind(&ctx.org_id)
                .fetch_all(&mut *conn)
                .await?;
        let hidden = hidden_folder_ids(conn, ctx).await?;
        Ok(Self::from_rows(rows, hidden))
    }

    pub fn from_rows(rows: Vec<FolderRow>, hidden: HashSet<String>) -> Self {
        Self { rows: rows.into_iter().map(|r| (r.id.clone(), r)).collect(), hidden }
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

    /// The nearest restricted folder in the chain (the folder itself first): its grants decide.
    pub fn nearest_restricted(&self, id: &str) -> Option<&FolderRow> {
        self.ancestors(id).into_iter().find(|r| r.restricted != 0)
    }

    pub fn is_restricted(&self, id: &str) -> bool {
        self.nearest_restricted(id).is_some()
    }

    /// The id of the restricted folder that governs `id` (see `nearest_restricted`).
    pub fn governing(&self, id: &str) -> Option<&str> {
        self.nearest_restricted(id).map(|r| r.id.as_str())
    }

    /// Whether a move from under the governing restricted folder `from` to under `to` (see
    /// `governing`) needs `folders:permissions` on both sides. Moves between the open tree and
    /// team-owned restricted folders (team spaces) need only edit rights on both sides, which the
    /// caller checks.
    pub fn crossing_needs_permissions(&self, from: Option<&str>, to: Option<&str>) -> bool {
        let team_owned =
            |g: Option<&str>| g.is_none_or(|id| self.rows.get(id).is_some_and(|r| r.owner_team_id.is_some()));
        from != to && !(team_owned(from) && team_owned(to))
    }

    /// Whether the caller sees the folder (see `VISIBILITY_CTE`).
    pub fn visible(&self, id: &str) -> bool {
        !self.hidden.contains(id)
    }

    /// `forbidden` if anything below `id` is hidden from the caller: a change of the whole
    /// subtree (trash, restore, purge, move) would act on content they cannot see, and its
    /// counts or depth would reveal it.
    pub fn check_subtree_visible(&self, id: &str) -> ApiResult<()> {
        if self.descendants(id).iter().all(|d| self.visible(&d.id)) {
            Ok(())
        } else {
            Err(ApiError::forbidden("the folder contains content you cannot see"))
        }
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

/// What a team context shows in lists (docs/api/access.md, "Team spaces"): everything outside
/// team spaces, the team's own spaces, and what was shared with the team inside other teams'
/// spaces. A filter only: access is decided by `authz` as always, so nothing the caller may not
/// see appears because of it.
pub struct TeamScope {
    /// Folders inside another team's space that no grant to the team reaches.
    out: HashSet<String>,
    /// Dashboards the team holds a grant on.
    dashboards: HashSet<String>,
}

impl TeamScope {
    /// For `team_id`, which the caller checked against the member's teams.
    pub async fn load(conn: &mut sqlx::AnyConnection, org_id: &str, team_id: &str) -> ApiResult<Self> {
        let rows: Vec<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT id, parent_id, owner_team_id FROM folders WHERE org_id = $1")
                .bind(org_id)
                .fetch_all(&mut *conn)
                .await?;
        let grants: Vec<(String, String)> = sqlx::query_as(
            "SELECT resource_type, resource_id FROM resource_grants WHERE org_id = $1 AND subject_type = 'team' \
             AND subject_id = $2 AND resource_type IN ('folder', 'dashboard')",
        )
        .bind(org_id)
        .bind(team_id)
        .fetch_all(&mut *conn)
        .await?;
        let shared: HashSet<&str> = grants.iter().filter(|(t, _)| t == "folder").map(|(_, id)| id.as_str()).collect();
        let folders: HashMap<&str, (Option<&str>, Option<&str>)> =
            rows.iter().map(|(id, parent, owner)| (id.as_str(), (parent.as_deref(), owner.as_deref()))).collect();
        let mut out = HashSet::new();
        for id in folders.keys() {
            let mut chain = vec![*id];
            let mut next = folders.get(id).and_then(|(parent, _)| *parent);
            while let Some(parent) = next {
                // A cycle cannot be stored (moves refuse it); the bound keeps a damaged table harmless.
                if chain.len() > MAX_DEPTH * 2 {
                    break;
                }
                chain.push(parent);
                next = folders.get(parent).and_then(|(p, _)| *p);
            }
            let top = chain.last().and_then(|top| folders.get(top)).and_then(|(_, owner)| *owner);
            if top.is_some_and(|owner| owner != team_id) && !chain.iter().any(|f| shared.contains(f)) {
                out.insert(id.to_string());
            }
        }
        let dashboards = grants.into_iter().filter(|(t, _)| t == "dashboard").map(|(_, id)| id).collect();
        Ok(Self { out, dashboards })
    }

    pub fn folder(&self, id: &str) -> bool {
        !self.out.contains(id)
    }

    pub fn dashboard(&self, id: &str, folder: Option<&str>) -> bool {
        folder.is_none_or(|f| self.folder(f)) || self.dashboards.contains(id)
    }

    /// The folders left out, sorted, for a query that filters by them.
    pub fn excluded_folders(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self.out.iter().map(String::as_str).collect();
        out.sort_unstable();
        out
    }

    /// The dashboards shared with the team, sorted, for a query that brings them back.
    pub fn shared_dashboards(&self) -> Vec<&str> {
        let mut out: Vec<&str> = self.dashboards.iter().map(String::as_str).collect();
        out.sort_unstable();
        out
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
            trash_batch: None,
            owner_team_id: None,
        }
    }

    fn ctx(role: crate::authz::BuiltinRole) -> OrgCtx {
        OrgCtx {
            user: crate::auth::SessionUser {
                id: "u".into(),
                email: "u@example.de".into(),
                name: "U".into(),
                is_server_admin: 0,
            },
            org_id: "o".into(),
            role: role.as_str().into(),
            permissions: role.permissions(),
            at_ms: 0,
        }
    }

    #[test]
    fn subtrees_with_hidden_content_are_refused() {
        let rows = || {
            vec![
                row("a", None, false),
                row("b", Some("a"), false),
                row("c", Some("b"), false),
                row("d", Some("a"), true),
                row("e", Some("d"), false),
            ]
        };
        let hidden: HashSet<String> = ["d".to_string(), "e".to_string()].into();
        let t = Tree::from_rows(rows(), hidden);
        assert!(!t.visible("e") && t.visible("c"));
        assert_eq!(t.check_subtree_visible("a").unwrap_err().code, "forbidden");
        assert!(t.check_subtree_visible("b").is_ok());
        assert!(Tree::from_rows(rows(), HashSet::new()).check_subtree_visible("a").is_ok());
    }

    #[test]
    fn the_nearest_restricted_folder_decides() {
        let t = Tree::from_rows(
            vec![row("a", None, true), row("b", Some("a"), false), row("c", Some("b"), true)],
            HashSet::new(),
        );
        assert_eq!(t.nearest_restricted("c").unwrap().id, "c");
        assert_eq!(t.nearest_restricted("b").unwrap().id, "a");
        assert!(Tree::from_rows(vec![row("x", None, false)], HashSet::new()).nearest_restricted("x").is_none());
    }

    /// a > b > c, a > d (restricted) > e
    fn tree() -> Tree {
        Tree::from_rows(
            vec![
                row("a", None, false),
                row("b", Some("a"), false),
                row("c", Some("b"), false),
                row("d", Some("a"), true),
                row("e", Some("d"), false),
            ],
            HashSet::new(),
        )
    }

    /// The SQL that lists and searches must hide exactly what `check_resource` refuses: every
    /// folder of a tree with nested restrictions and grants to a user, a team and a role.
    #[tokio::test]
    async fn the_visibility_query_agrees_with_check_resource() {
        use crate::authz::{BuiltinRole, Permission, Resource, check_resource};
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        // r1 (restricted) > g (grant to the user) > r2 (restricted) > x
        // r1 > y;  t (restricted, grant to the team) > t2;  v (restricted, grant to the role) > v2
        // open > r3 (restricted, grant on open above it does not reach in) > z
        // w (restricted) > w2 (grant to the user, below the governing folder) > w3
        let statements = [
            "INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)",
            "INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@example.de', 'U', 0)",
            "INSERT INTO teams (id, org_id, name, name_key, created_at) VALUES ('team', 'o', 'T', 't', 0)",
            "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ('team', 'u', 'member', 0)",
        ];
        for sql in statements {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        let folders = [
            ("r1", None, 1),
            ("g", Some("r1"), 0),
            ("r2", Some("g"), 1),
            ("x", Some("r2"), 0),
            ("y", Some("r1"), 0),
            ("t", None, 1),
            ("t2", Some("t"), 0),
            ("v", None, 1),
            ("v2", Some("v"), 0),
            ("open", None, 0),
            ("r3", Some("open"), 1),
            ("z", Some("r3"), 0),
            ("w", None, 1),
            ("w2", Some("w"), 0),
            ("w3", Some("w2"), 0),
        ];
        for (id, parent, restricted) in folders {
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
        for (id, subject_type, subject, folder) in [
            ("g1", "user", "u", "g"),
            ("g2", "team", "team", "t"),
            ("g3", "role", "viewer", "v"),
            ("g4", "user", "u", "open"),
            ("g5", "user", "u", "w2"),
        ] {
            sqlx::query(
                "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, \
                 level, created_at) VALUES ($1, 'o', $2, $3, 'folder', $4, 'view', 0)",
            )
            .bind(id)
            .bind(subject_type)
            .bind(subject)
            .bind(folder)
            .execute(&db)
            .await
            .unwrap();
        }
        for role in [BuiltinRole::Viewer, BuiltinRole::Admin] {
            let ctx = ctx(role);
            let hidden = hidden_folder_ids(&mut db.acquire().await.unwrap(), &ctx).await.unwrap();
            // The in-memory index that lists use for `access` agrees as well, permission by permission.
            let index = crate::authz::AccessIndex::load(&mut db.acquire().await.unwrap(), &ctx).await.unwrap();
            for (id, _, _) in folders {
                let refused = check_resource(&db, &ctx, Permission::FoldersRead, Resource::Folder(id)).await.is_err();
                assert_eq!(hidden.contains(id), refused, "{role:?} {id}");
                let held = crate::authz::resource_permissions(&db, &ctx, Resource::Folder(id)).await.unwrap();
                assert_eq!(index.folder(id), held, "{role:?} {id}");
            }
            if role == BuiltinRole::Viewer {
                let mut hidden: Vec<_> = hidden.into_iter().collect();
                hidden.sort();
                assert_eq!(hidden, ["r1", "r2", "r3", "w", "x", "y", "z"]);
            } else {
                assert!(hidden.is_empty());
            }
        }
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
        let t = Tree::from_rows(rows, HashSet::new());
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
        let t = Tree::from_rows(vec![row("p", Some("q"), false), row("q", Some("p"), false)], HashSet::new());
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
        let link = |id: &str, restricted| FolderLink { id: id.into(), restricted, owner_team: None };
        assert_eq!(folder_chain(&db, "o", "e").await.unwrap(), [link("e", false), link("d", true), link("a", false)]);
        assert_eq!(folder_chain(&db, "p", "e").await.unwrap_err().code, "not_found");
        assert!(folder_is_restricted(&db, "o", "e").await.unwrap());
        assert!(!folder_is_restricted(&db, "o", "a").await.unwrap());
        // Another organization's folder does not exist from here.
        assert_eq!(folder_ancestors(&db, "p", "e").await.unwrap_err().code, "not_found");
        assert_eq!(folder_is_restricted(&db, "o", "nope").await.unwrap_err().code, "not_found");
    }
}
