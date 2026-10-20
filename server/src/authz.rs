//! Authorization: the permission catalog, built-in organization roles and the access check that
//! runs before every organization-scoped route, custom and team roles, resource grants and the
//! guards on handing out rights (see docs/ARCHITECTURE.md, "Authorization").

use std::collections::BTreeSet;

use axum::http::StatusCode;

use crate::auth::SessionUser;
use crate::error::{ApiError, ApiResult};

macro_rules! permissions {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        /// One action on one resource type. The string form (`dashboards:read`) is what the API
        /// and the database use.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum Permission { $($variant),+ }

        impl Permission {
            pub const ALL: &'static [Permission] = &[$(Permission::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Permission::$variant => $name),+ }
            }

            pub fn parse(s: &str) -> Option<Permission> {
                match s { $($name => Some(Permission::$variant),)+ _ => None }
            }
        }
    };
}

permissions! {
    DashboardsRead => "dashboards:read",
    DashboardsWrite => "dashboards:write",
    DashboardsDelete => "dashboards:delete",
    DashboardsShare => "dashboards:share",
    FoldersRead => "folders:read",
    FoldersWrite => "folders:write",
    FoldersPermissions => "folders:permissions",
    DatasourcesQuery => "datasources:query",
    DatasourcesRead => "datasources:read",
    DatasourcesWrite => "datasources:write",
    DatasourcesPermissions => "datasources:permissions",
    AnalysesRead => "analyses:read",
    AnalysesWrite => "analyses:write",
    DataExport => "data:export",
    AnnotationsWrite => "annotations:write",
    TeamsRead => "teams:read",
    TeamsWrite => "teams:write",
    TeamsMembers => "teams:members",
    UsersRead => "users:read",
    UsersInvite => "users:invite",
    UsersWrite => "users:write",
    RolesRead => "roles:read",
    RolesWrite => "roles:write",
    ServiceAccountsWrite => "serviceaccounts:write",
    AuditRead => "audit:read",
    PluginsConfigure => "plugins:configure",
    SettingsRead => "settings:read",
    SettingsWrite => "settings:write",
    OrgWrite => "org:write",
    OrgDelete => "org:delete",
}

/// The four roles every organization has. Custom roles (migration 0003) add to these.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuiltinRole {
    Owner,
    Admin,
    Editor,
    Viewer,
}

impl BuiltinRole {
    /// Strongest first, the order the roles list shows them in.
    pub const ALL: [BuiltinRole; 4] = [Self::Owner, Self::Admin, Self::Editor, Self::Viewer];

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "editor" => Some(Self::Editor),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }

    /// Pinned by a test, so a permission added to the catalog is granted to a role only by an
    /// explicit edit here.
    pub fn permissions(self) -> BTreeSet<Permission> {
        use Permission::*;
        let viewer = [DashboardsRead, FoldersRead, AnalysesRead, TeamsRead];
        let editor_extra = [
            DashboardsWrite,
            DashboardsDelete,
            // Share means granting access to users and teams of the same organization. Public
            // links for people without an account are a separate permission (M6).
            DashboardsShare,
            FoldersWrite,
            DatasourcesQuery,
            DatasourcesRead,
            AnalysesWrite,
            DataExport,
            AnnotationsWrite,
            // Needed to pick people and teams when sharing.
            UsersRead,
        ];
        let admin_extra = [
            FoldersPermissions,
            DatasourcesWrite,
            DatasourcesPermissions,
            TeamsWrite,
            TeamsMembers,
            UsersInvite,
            UsersWrite,
            RolesRead,
            RolesWrite,
            ServiceAccountsWrite,
            AuditRead,
            PluginsConfigure,
            SettingsRead,
            SettingsWrite,
            OrgWrite,
        ];
        let mut set: BTreeSet<Permission> = viewer.into();
        if matches!(self, Self::Editor | Self::Admin | Self::Owner) {
            set.extend(editor_extra);
        }
        if matches!(self, Self::Admin | Self::Owner) {
            set.extend(admin_extra);
        }
        if self == Self::Owner {
            set.insert(OrgDelete);
        }
        set
    }
}

/// Who may call a route. Every route is declared with one (see `routes::RouteDef`).
#[derive(Clone, Copy, Debug)]
pub enum Access {
    Public,
    Authenticated,
    ServerAdmin,
    /// The caller must be a member of the `{orgId}` in the path; no particular permission.
    OrgMember,
    /// The caller must be a member of the `{orgId}` in the path and hold this permission.
    Org(Permission),
}

/// The caller of an organization-scoped route, inserted by the access layer.
#[derive(Clone, Debug)]
pub struct OrgCtx {
    pub user: SessionUser,
    pub org_id: String,
    pub role: String,
    pub permissions: BTreeSet<Permission>,
}

impl OrgCtx {
    pub fn check(&self, permission: Permission) -> ApiResult<()> {
        if self.permissions.contains(&permission) {
            Ok(())
        } else {
            Err(ApiError::forbidden(format!("missing permission {}", permission.as_str())))
        }
    }
}

/// The kinds of resources grants attach to. The string form is what the API and the database use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ResourceType {
    Folder,
    Dashboard,
    Datasource,
}

impl ResourceType {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "folder" => Some(Self::Folder),
            "dashboard" => Some(Self::Dashboard),
            "datasource" => Some(Self::Datasource),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Dashboard => "dashboard",
            Self::Datasource => "datasource",
        }
    }

    /// The grant levels of this type, weakest first; each includes the ones before it.
    pub fn levels(self) -> [&'static str; 3] {
        match self {
            Self::Folder | Self::Dashboard => ["view", "edit", "admin"],
            Self::Datasource => ["query", "edit", "admin"],
        }
    }

    /// The permission that manages grants on resources of this type.
    pub fn manage_permission(self) -> Permission {
        match self {
            Self::Folder => Permission::FoldersPermissions,
            Self::Dashboard => Permission::DashboardsShare,
            Self::Datasource => Permission::DatasourcesPermissions,
        }
    }
}

/// What a grant of `level` on a resource of type `resource_type` allows, or `None` when the type
/// has no such level. Folder grants carry dashboard permissions, since they inherit to the
/// dashboards inside.
pub fn level_permissions(resource_type: ResourceType, level: &str) -> Option<BTreeSet<Permission>> {
    use Permission::*;
    let tiers: [&[Permission]; 3] = match resource_type {
        ResourceType::Folder => [
            &[FoldersRead, DashboardsRead],
            &[FoldersWrite, DashboardsWrite, DashboardsDelete],
            &[FoldersPermissions, DashboardsShare],
        ],
        ResourceType::Dashboard => [&[DashboardsRead], &[DashboardsWrite, DashboardsDelete], &[DashboardsShare]],
        // Querying needs the source's name and type in pickers, so it includes reading them.
        ResourceType::Datasource => {
            [&[DatasourcesQuery, DatasourcesRead], &[DatasourcesWrite], &[DatasourcesPermissions]]
        }
    };
    let rank = resource_type.levels().iter().position(|l| *l == level)?;
    Some(tiers[..=rank].iter().flat_map(|tier| tier.iter().copied()).collect())
}

/// A resource inside an organization that grants can be attached to. The caller resolves the id
/// within `ctx.org_id` first (an id from another organization is `not_found`).
#[derive(Clone, Copy, Debug)]
pub enum Resource<'a> {
    Folder(&'a str),
    Dashboard(&'a str),
    Datasource(&'a str),
}

impl<'a> Resource<'a> {
    pub fn new(resource_type: ResourceType, id: &'a str) -> Self {
        match resource_type {
            ResourceType::Folder => Self::Folder(id),
            ResourceType::Dashboard => Self::Dashboard(id),
            ResourceType::Datasource => Self::Datasource(id),
        }
    }

    pub fn resource_type(self) -> ResourceType {
        match self {
            Self::Folder(_) => ResourceType::Folder,
            Self::Dashboard(_) => ResourceType::Dashboard,
            Self::Datasource(_) => ResourceType::Datasource,
        }
    }

    pub fn id(self) -> &'a str {
        match self {
            Self::Folder(id) | Self::Dashboard(id) | Self::Datasource(id) => id,
        }
    }
}

/// Whether `resource` exists in `org_id`. The folder, dashboard and data source tables arrive with
/// streams B (migration 0005) and C (migration 0006); until the orchestrator wires their lookups
/// here, every well-formed id counts as existing.
pub async fn resource_exists(_db: &sqlx::AnyPool, _org_id: &str, _resource: Resource<'_>) -> ApiResult<bool> {
    Ok(true)
}

/// Whether a folder is marked restricted. Stream B's migration 0005 adds the flag to `folders`;
/// until the orchestrator wires it here, every folder is unrestricted.
pub async fn folder_is_restricted(_db: &sqlx::AnyPool, _org_id: &str, _folder_id: &str) -> ApiResult<bool> {
    Ok(false)
}

/// The folder and its ancestors, nearest first, so folder grants inherit to subfolders. Stream
/// B's migration 0005 adds `folders.parent_id`; until the orchestrator wires the walk here, this
/// is just the folder itself.
pub async fn folder_ancestors(_db: &sqlx::AnyPool, _org_id: &str, folder_id: &str) -> ApiResult<Vec<String>> {
    Ok(vec![folder_id.to_string()])
}

/// The folder a dashboard lives in, so folder grants inherit to its dashboards. Stream B's
/// migration 0005 adds `dashboards.folder_id`; until the orchestrator wires it here, dashboards
/// are in no folder.
pub async fn dashboard_folder(_db: &sqlx::AnyPool, _org_id: &str, _dashboard_id: &str) -> ApiResult<Option<String>> {
    Ok(None)
}

/// A role as members and teams hold it: a built-in role, or a custom role of the organization.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleInfo {
    /// The built-in name or the custom role's id; what `org_members.role` and `team_roles.role`
    /// store.
    pub key: String,
    pub name: String,
    pub builtin: bool,
    pub permissions: BTreeSet<Permission>,
}

/// Resolves a role key within `org_id`; `None` when there is no such role there.
pub async fn resolve_role(db: &sqlx::AnyPool, org_id: &str, key: &str) -> ApiResult<Option<RoleInfo>> {
    if let Some(builtin) = BuiltinRole::parse(key) {
        return Ok(Some(RoleInfo {
            key: key.to_string(),
            name: key.to_string(),
            builtin: true,
            permissions: builtin.permissions(),
        }));
    }
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT r.name, p.permission FROM roles r LEFT JOIN role_permissions p ON p.role_id = r.id \
         WHERE r.org_id = $1 AND r.id = $2",
    )
    .bind(org_id)
    .bind(key)
    .fetch_all(db)
    .await?;
    let Some((name, _)) = rows.first() else { return Ok(None) };
    Ok(Some(RoleInfo {
        key: key.to_string(),
        name: name.clone(),
        builtin: false,
        permissions: rows.iter().filter_map(|(_, p)| p.as_deref().and_then(Permission::parse)).collect(),
    }))
}

/// Why the caller holds a permission, for the "why can I do this" dialog.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GrantSource {
    /// The member's built-in role in the organization.
    OrgRole { role: String },
    /// The member's role in the organization is a custom role.
    #[serde(rename_all = "camelCase")]
    CustomRole { role_id: String, role_name: String },
    /// A role of a team the member belongs to; `role` is a built-in name or a custom role id.
    #[serde(rename_all = "camelCase")]
    TeamRole { team_id: String, team_name: String, role: String, role_name: String },
    /// A grant on the resource or, for folders, on a folder above it.
    #[serde(rename_all = "camelCase")]
    Grant {
        grant_id: String,
        subject_type: String,
        subject_id: String,
        resource_type: String,
        resource_id: String,
        level: String,
    },
}

/// The member's org role and their teams' roles, each with what it allows.
async fn role_sources(
    db: &sqlx::AnyPool,
    user_id: &str,
    org_id: &str,
    role: &str,
) -> ApiResult<Vec<(GrantSource, BTreeSet<Permission>)>> {
    let mut out = Vec::new();
    if let Some(info) = resolve_role(db, org_id, role).await? {
        let source = if info.builtin {
            GrantSource::OrgRole { role: info.key }
        } else {
            GrantSource::CustomRole { role_id: info.key, role_name: info.name }
        };
        out.push((source, info.permissions));
    }
    let team_roles: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT t.id, t.name, r.role FROM team_members m JOIN teams t ON t.id = m.team_id \
         JOIN team_roles r ON r.team_id = t.id WHERE m.user_id = $1 AND t.org_id = $2 ORDER BY t.name, r.role",
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_all(db)
    .await?;
    for (team_id, team_name, key) in team_roles {
        // A custom role deleted in the meantime grants nothing.
        if let Some(info) = resolve_role(db, org_id, &key).await? {
            out.push((GrantSource::TeamRole { team_id, team_name, role: key, role_name: info.name }, info.permissions));
        }
    }
    Ok(out)
}

/// The permissions a member holds in an organization: their org role (built-in or custom) plus
/// the roles of their teams. Resource grants add to this per resource (`check_resource`).
pub async fn effective_permissions(
    db: &sqlx::AnyPool,
    user_id: &str,
    org_id: &str,
    role: &str,
) -> ApiResult<BTreeSet<Permission>> {
    let sources = role_sources(db, user_id, org_id, role).await?;
    Ok(sources.into_iter().flat_map(|(_, permissions)| permissions).collect())
}

#[derive(Clone, Debug, sqlx::FromRow)]
struct GrantRow {
    id: String,
    subject_type: String,
    subject_id: String,
    resource_type: String,
    resource_id: String,
    level: String,
}

impl GrantRow {
    fn permissions(&self) -> BTreeSet<Permission> {
        ResourceType::parse(&self.resource_type)
            .and_then(|t| level_permissions(t, &self.level))
            .unwrap_or_default()
    }

    fn source(&self) -> GrantSource {
        GrantSource::Grant {
            grant_id: self.id.clone(),
            subject_type: self.subject_type.clone(),
            subject_id: self.subject_id.clone(),
            resource_type: self.resource_type.clone(),
            resource_id: self.resource_id.clone(),
            level: self.level.clone(),
        }
    }
}

/// What decides the caller's access to one resource: whether it lies in a restricted folder, and
/// the caller's grants on it and the folders above it.
#[derive(Debug, Default)]
struct ResourceFacts {
    restricted: bool,
    grants: Vec<GrantRow>,
}

async fn resource_facts(db: &sqlx::AnyPool, ctx: &OrgCtx, resource: Resource<'_>) -> ApiResult<ResourceFacts> {
    let org_id = ctx.org_id.as_str();
    let mut chain = vec![(resource.resource_type(), resource.id().to_string())];
    let folder = match resource {
        Resource::Folder(id) => Some(id.to_string()),
        Resource::Dashboard(id) => dashboard_folder(db, org_id, id).await?,
        Resource::Datasource(_) => None,
    };
    if let Some(folder) = folder {
        chain.retain(|(t, _)| *t != ResourceType::Folder);
        chain.extend(folder_ancestors(db, org_id, &folder).await?.into_iter().map(|id| (ResourceType::Folder, id)));
    }
    let mut restricted = false;
    for (_, id) in chain.iter().filter(|(t, _)| *t == ResourceType::Folder) {
        restricted |= folder_is_restricted(db, org_id, id).await?;
    }

    // The subjects the caller is: themselves, their teams, and every role they hold.
    let teams: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT t.id, r.role FROM team_members m JOIN teams t ON t.id = m.team_id \
         LEFT JOIN team_roles r ON r.team_id = t.id WHERE m.user_id = $1 AND t.org_id = $2",
    )
    .bind(&ctx.user.id)
    .bind(org_id)
    .fetch_all(db)
    .await?;
    let team_ids: BTreeSet<&str> = teams.iter().map(|(id, _)| id.as_str()).collect();
    let mut role_keys: BTreeSet<&str> = teams.iter().filter_map(|(_, r)| r.as_deref()).collect();
    role_keys.insert(&ctx.role);
    let is_caller = |g: &GrantRow| match g.subject_type.as_str() {
        "user" => g.subject_id == ctx.user.id,
        "team" => team_ids.contains(g.subject_id.as_str()),
        "role" => role_keys.contains(g.subject_id.as_str()),
        _ => false,
    };

    let mut grants = Vec::new();
    for (resource_type, id) in &chain {
        let rows: Vec<GrantRow> = sqlx::query_as(
            "SELECT id, subject_type, subject_id, resource_type, resource_id, level FROM resource_grants \
             WHERE org_id = $1 AND resource_type = $2 AND resource_id = $3 ORDER BY id",
        )
        .bind(org_id)
        .bind(resource_type.as_str())
        .bind(id)
        .fetch_all(db)
        .await?;
        grants.extend(rows.into_iter().filter(|g| is_caller(g)));
    }
    Ok(ResourceFacts { restricted, grants })
}

/// Whether the org-wide permissions count on this resource. In a restricted folder they do only
/// for members who manage folder permissions (admins and owners); everyone else needs a grant.
fn role_applies(org: &BTreeSet<Permission>, facts: &ResourceFacts) -> bool {
    !facts.restricted || org.contains(&Permission::FoldersPermissions)
}

/// What the caller may do on a resource, or `None` when they may not see it at all.
fn permissions_on(
    org: &BTreeSet<Permission>,
    resource_type: ResourceType,
    facts: &ResourceFacts,
) -> Option<BTreeSet<Permission>> {
    let role_applies = role_applies(org, facts);
    let role_sees = role_applies
        && match resource_type {
            ResourceType::Folder => org.contains(&Permission::FoldersRead),
            ResourceType::Dashboard => org.contains(&Permission::DashboardsRead),
            // Viewers use data sources only through dashboards, so they need not see them.
            ResourceType::Datasource => {
                org.contains(&Permission::DatasourcesRead) || org.contains(&Permission::DatasourcesQuery)
            }
        };
    if !role_sees && facts.grants.is_empty() {
        return None;
    }
    let mut out: BTreeSet<Permission> = facts.grants.iter().flat_map(GrantRow::permissions).collect();
    if role_applies {
        out.extend(org.iter().copied());
    }
    Some(out)
}

/// Everything the caller may do on `resource` (org-wide permissions where they apply, plus
/// grants), or `None` when they may not see it.
pub async fn resource_permissions(
    db: &sqlx::AnyPool,
    ctx: &OrgCtx,
    resource: Resource<'_>,
) -> ApiResult<Option<BTreeSet<Permission>>> {
    let facts = resource_facts(db, ctx, resource).await?;
    Ok(permissions_on(&ctx.permissions, resource.resource_type(), &facts))
}

/// Checks `permission` on one resource: `not_found` when the caller may not even see it (a
/// restricted folder they have no grant for), `forbidden` when they see it but may not do this.
pub async fn check_resource(
    db: &sqlx::AnyPool,
    ctx: &OrgCtx,
    permission: Permission,
    resource: Resource<'_>,
) -> ApiResult<()> {
    match resource_permissions(db, ctx, resource).await? {
        None => Err(ApiError::not_found()),
        Some(held) if held.contains(&permission) => Ok(()),
        Some(_) => Err(ApiError::forbidden(format!("missing permission {}", permission.as_str()))),
    }
}

/// Every source that gives the caller `permission`, org-wide or on `resource`; empty when nothing
/// does. A resource the caller may not see is `not_found`, as in `check_resource`.
pub async fn explain(
    db: &sqlx::AnyPool,
    ctx: &OrgCtx,
    permission: Permission,
    resource: Option<Resource<'_>>,
) -> ApiResult<Vec<GrantSource>> {
    let roles = role_sources(db, &ctx.user.id, &ctx.org_id, &ctx.role).await?;
    let from_roles = roles.into_iter().filter(|(_, p)| p.contains(&permission)).map(|(source, _)| source);
    let Some(resource) = resource else { return Ok(from_roles.collect()) };
    let facts = resource_facts(db, ctx, resource).await?;
    if permissions_on(&ctx.permissions, resource.resource_type(), &facts).is_none() {
        return Err(ApiError::not_found());
    }
    let mut out: Vec<GrantSource> = if role_applies(&ctx.permissions, &facts) { from_roles.collect() } else { Vec::new() };
    out.extend(facts.grants.iter().filter(|g| g.permissions().contains(&permission)).map(GrantRow::source));
    Ok(out)
}

/// Nobody hands out a permission they do not hold: creating or changing a custom role, assigning
/// a role, giving a team roles and creating a grant all pass what they give (and, when they
/// change someone's access, what that someone had) through this.
pub fn ensure_holds(held: &BTreeSet<Permission>, wanted: &BTreeSet<Permission>) -> ApiResult<()> {
    let missing: Vec<&str> = wanted.difference(held).map(|p| p.as_str()).collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!("you do not hold {}, so you cannot grant or change it", missing.join(", "))))
    }
}

fn conflict(message: &str) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", message)
}

/// Refuses to remove or demote the last owner. `new_role` is `None` when the member is removed.
pub fn ensure_owner_remains(current_role: &str, new_role: Option<&str>, owners: i64) -> ApiResult<()> {
    let leaves_owners = current_role == BuiltinRole::Owner.as_str() && new_role != Some(BuiltinRole::Owner.as_str());
    if leaves_owners && owners <= 1 {
        return Err(conflict("the last owner of an organization cannot be removed or demoted"));
    }
    Ok(())
}

/// Locks the owner rows of `org_id` for the rest of the transaction and counts them, so two
/// owners demoting each other at the same time cannot both succeed.
pub async fn lock_owners(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<i64> {
    // A no-op update takes the row locks on PostgreSQL and the write lock on SQLite; both drivers
    // understand it, unlike `SELECT ... FOR UPDATE`.
    sqlx::query("UPDATE org_members SET role = role WHERE org_id = $1 AND role = 'owner'")
        .bind(org_id)
        .execute(&mut *conn)
        .await?;
    let (owners,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE org_id = $1 AND role = 'owner'")
        .bind(org_id)
        .fetch_one(&mut *conn)
        .await?;
    Ok(owners)
}

/// Refuses to leave the server without an active server admin. `is_active_admin` is the user's
/// state now, `stays_active_admin` after the change; `admins` counts the active admins.
pub fn ensure_admin_remains(is_active_admin: bool, stays_active_admin: bool, admins: i64) -> ApiResult<()> {
    if is_active_admin && !stays_active_admin && admins <= 1 {
        return Err(conflict("the last server administrator cannot be disabled or lose the role"));
    }
    Ok(())
}

/// Locks the rows of the active server admins for the rest of the transaction and counts them.
pub async fn lock_server_admins(conn: &mut sqlx::AnyConnection) -> ApiResult<i64> {
    sqlx::query("UPDATE users SET is_server_admin = 1 WHERE is_server_admin = 1 AND disabled = 0")
        .execute(&mut *conn)
        .await?;
    let (admins,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE is_server_admin = 1 AND disabled = 0")
        .fetch_one(&mut *conn)
        .await?;
    Ok(admins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_are_unique() {
        let mut seen = BTreeSet::new();
        for p in Permission::ALL {
            assert_eq!(Permission::parse(p.as_str()), Some(*p));
            assert!(seen.insert(p.as_str()), "{} twice", p.as_str());
            assert!(p.as_str().contains(':'));
        }
        assert_eq!(Permission::parse("dashboards:fly"), None);
    }

    #[test]
    fn roles_nest() {
        let owner = BuiltinRole::Owner.permissions();
        let admin = BuiltinRole::Admin.permissions();
        let editor = BuiltinRole::Editor.permissions();
        let viewer = BuiltinRole::Viewer.permissions();
        assert!(viewer.is_subset(&editor) && editor.is_subset(&admin) && admin.is_subset(&owner));
        assert!(!admin.contains(&Permission::OrgDelete) && owner.contains(&Permission::OrgDelete));
        assert!(!editor.contains(&Permission::UsersWrite));
        assert!(!viewer.contains(&Permission::DashboardsWrite));
    }

    #[test]
    fn role_sets_are_pinned() {
        let names = |r: BuiltinRole| r.permissions().iter().map(|p| p.as_str()).collect::<Vec<_>>().join(" ");
        assert_eq!(names(BuiltinRole::Viewer), "dashboards:read folders:read analyses:read teams:read");
        assert_eq!(
            names(BuiltinRole::Editor),
            concat!(
                "dashboards:read dashboards:write dashboards:delete dashboards:share folders:read folders:write ",
                "datasources:query datasources:read analyses:read analyses:write data:export annotations:write ",
                "teams:read users:read"
            )
        );
        // The whole catalog by name: a new permission fails this test until someone decides which
        // roles get it (admin and owner would otherwise receive it silently).
        let all: Vec<&str> = Permission::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(
            all.join(" "),
            concat!(
                "dashboards:read dashboards:write dashboards:delete dashboards:share folders:read folders:write ",
                "folders:permissions datasources:query datasources:read datasources:write datasources:permissions ",
                "analyses:read analyses:write data:export annotations:write teams:read teams:write teams:members ",
                "users:read users:invite users:write roles:read roles:write serviceaccounts:write audit:read ",
                "plugins:configure settings:read settings:write org:write org:delete"
            )
        );
        assert_eq!(BuiltinRole::Owner.permissions().len(), Permission::ALL.len());
        let admin_missing: Vec<_> =
            Permission::ALL.iter().filter(|p| !BuiltinRole::Admin.permissions().contains(p)).collect();
        assert_eq!(admin_missing, [&Permission::OrgDelete]);
    }

    #[test]
    fn viewers_cannot_run_their_own_queries() {
        // Viewers see dashboards; the server runs the stored panel queries for them.
        assert!(!BuiltinRole::Viewer.permissions().contains(&Permission::DatasourcesQuery));
    }

    #[test]
    fn unknown_roles_grant_nothing() {
        assert!(BuiltinRole::parse("superuser").is_none());
    }
}

#[cfg(test)]
mod resource_tests {
    use super::*;

    fn ctx_with(role: &str, permissions: BTreeSet<Permission>) -> OrgCtx {
        OrgCtx {
            user: SessionUser { id: "u".into(), email: "u@example.de".into(), name: "U".into(), is_server_admin: 0 },
            org_id: "o".into(),
            role: role.into(),
            permissions,
        }
    }

    fn ctx(role: BuiltinRole) -> OrgCtx {
        ctx_with(role.as_str(), role.permissions())
    }

    /// One connection, so the in-memory database is the same for every query.
    async fn db() -> sqlx::AnyPool {
        sqlx::any::install_default_drivers();
        let db = sqlx::any::AnyPoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&db).await.unwrap();
        for sql in [
            "INSERT INTO orgs (id, name, created_at) VALUES ('o', 'Org', 0)",
            "INSERT INTO orgs (id, name, created_at) VALUES ('other', 'Andere', 0)",
            "INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@example.de', 'U', 0)",
            "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o', 'u', 'viewer', 0)",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        db
    }

    async fn exec(db: &sqlx::AnyPool, sql: &'static str) {
        sqlx::query(sql).execute(db).await.unwrap();
    }

    fn grant(resource_type: &str, resource_id: &str, level: &str) -> GrantRow {
        GrantRow {
            id: "g".into(),
            subject_type: "user".into(),
            subject_id: "u".into(),
            resource_type: resource_type.into(),
            resource_id: resource_id.into(),
            level: level.into(),
        }
    }

    #[tokio::test]
    async fn hidden_resources_are_not_found_and_visible_ones_forbidden() {
        let db = db().await;
        let viewer = ctx(BuiltinRole::Viewer);
        // A viewer sees dashboards but may not change them.
        let e = check_resource(&db, &viewer, Permission::DashboardsWrite, Resource::Dashboard("d")).await.unwrap_err();
        assert_eq!(e.code, "forbidden");
        // A viewer does not see data sources at all.
        let e = check_resource(&db, &viewer, Permission::DatasourcesRead, Resource::Datasource("s")).await.unwrap_err();
        assert_eq!(e.code, "not_found");
        let editor = ctx(BuiltinRole::Editor);
        assert!(check_resource(&db, &editor, Permission::DatasourcesQuery, Resource::Datasource("s")).await.is_ok());
        assert_eq!(
            explain(&db, &editor, Permission::DashboardsWrite, None).await.unwrap(),
            [GrantSource::OrgRole { role: "editor".into() }]
        );
        assert!(explain(&db, &viewer, Permission::DashboardsWrite, None).await.unwrap().is_empty());
    }

    #[test]
    fn levels_nest_and_differ_per_type() {
        use Permission::*;
        for t in [ResourceType::Folder, ResourceType::Dashboard, ResourceType::Datasource] {
            let [low, mid, high] = t.levels().map(|l| level_permissions(t, l).unwrap());
            assert!(low.is_subset(&mid) && mid.is_subset(&high) && low != mid && mid != high, "{t:?}");
            assert!(high.contains(&t.manage_permission()), "{t:?}: admin level manages grants");
            assert!(!mid.contains(&t.manage_permission()));
            assert_eq!(ResourceType::parse(t.as_str()), Some(t));
        }
        assert_eq!(level_permissions(ResourceType::Dashboard, "view").unwrap(), [DashboardsRead].into());
        assert_eq!(level_permissions(ResourceType::Datasource, "query").unwrap(), [DatasourcesQuery, DatasourcesRead].into());
        assert!(level_permissions(ResourceType::Folder, "edit").unwrap().contains(&DashboardsWrite));
        // Levels are per type: data sources have no "view", folders no "query".
        assert!(level_permissions(ResourceType::Datasource, "view").is_none());
        assert!(level_permissions(ResourceType::Folder, "query").is_none());
        assert!(level_permissions(ResourceType::Folder, "owner").is_none());
    }

    #[test]
    fn grants_extend_the_role_per_level() {
        let viewer = BuiltinRole::Viewer.permissions();
        let facts = ResourceFacts { restricted: false, grants: vec![grant("dashboard", "d", "edit")] };
        let held = permissions_on(&viewer, ResourceType::Dashboard, &facts).unwrap();
        assert!(held.contains(&Permission::DashboardsWrite) && !held.contains(&Permission::DashboardsShare));
        // A query grant makes a data source visible to a viewer, who otherwise does not see it.
        let none = ResourceFacts::default();
        assert!(permissions_on(&viewer, ResourceType::Datasource, &none).is_none());
        let facts = ResourceFacts { restricted: false, grants: vec![grant("datasource", "s", "query")] };
        let held = permissions_on(&viewer, ResourceType::Datasource, &facts).unwrap();
        assert!(held.contains(&Permission::DatasourcesQuery) && !held.contains(&Permission::DatasourcesWrite));
    }

    #[test]
    fn folder_grants_inherit_to_dashboards_inside() {
        // A grant found on a folder above the dashboard (the chain `resource_facts` collects)
        // carries the folder level's dashboard permissions.
        let facts = ResourceFacts { restricted: false, grants: vec![grant("folder", "parent", "admin")] };
        let held = permissions_on(&BTreeSet::new(), ResourceType::Dashboard, &facts).unwrap();
        assert!(held.contains(&Permission::DashboardsShare) && held.contains(&Permission::DashboardsDelete));
    }

    #[test]
    fn restricted_folders_need_a_grant_unless_you_manage_permissions() {
        let restricted = ResourceFacts { restricted: true, grants: vec![] };
        let editor = BuiltinRole::Editor.permissions();
        assert!(permissions_on(&editor, ResourceType::Folder, &restricted).is_none());
        assert!(permissions_on(&editor, ResourceType::Dashboard, &restricted).is_none());
        let admin = BuiltinRole::Admin.permissions();
        assert!(permissions_on(&admin, ResourceType::Dashboard, &restricted).unwrap().contains(&Permission::DashboardsWrite));
        // With a view grant, an editor sees it but the role's write permission does not apply.
        let granted = ResourceFacts { restricted: true, grants: vec![grant("folder", "f", "view")] };
        let held = permissions_on(&editor, ResourceType::Folder, &granted).unwrap();
        assert!(held.contains(&Permission::FoldersRead) && !held.contains(&Permission::FoldersWrite));
    }

    #[tokio::test]
    async fn custom_and_team_roles_add_up() {
        let db = db().await;
        exec(&db, "INSERT INTO roles (id, org_id, name, description, created_at) VALUES ('r1', 'o', 'Auditor', '', 0)").await;
        exec(&db, "INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'audit:read')").await;
        // Names the server does not know (from a newer or older version) grant nothing.
        exec(&db, "INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'rockets:launch')").await;
        let held = effective_permissions(&db, "u", "o", "r1").await.unwrap();
        assert_eq!(held, [Permission::AuditRead].into());
        // A custom role of another organization is no role here.
        assert!(effective_permissions(&db, "u", "other", "r1").await.unwrap().is_empty());

        exec(&db, "INSERT INTO teams (id, org_id, name, created_at) VALUES ('t1', 'o', 'Betrieb', 0)").await;
        exec(&db, "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ('t1', 'u', 'member', 0)").await;
        exec(&db, "INSERT INTO team_roles (team_id, role) VALUES ('t1', 'editor')").await;
        let held = effective_permissions(&db, "u", "o", "r1").await.unwrap();
        assert!(held.contains(&Permission::AuditRead) && held.contains(&Permission::DashboardsWrite));

        let ctx = ctx_with("r1", held);
        let sources = explain(&db, &ctx, Permission::DashboardsWrite, None).await.unwrap();
        assert_eq!(
            sources,
            [GrantSource::TeamRole {
                team_id: "t1".into(),
                team_name: "Betrieb".into(),
                role: "editor".into(),
                role_name: "editor".into()
            }]
        );
        let sources = explain(&db, &ctx, Permission::AuditRead, None).await.unwrap();
        assert_eq!(sources, [GrantSource::CustomRole { role_id: "r1".into(), role_name: "Auditor".into() }]);
    }

    #[tokio::test]
    async fn grants_match_the_user_their_teams_and_their_roles() {
        let db = db().await;
        let viewer = ctx(BuiltinRole::Viewer);
        exec(&db, "INSERT INTO teams (id, org_id, name, created_at) VALUES ('t1', 'o', 'Betrieb', 0)").await;
        exec(&db, "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ('t1', 'u', 'member', 0)").await;
        for sql in [
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g1', 'o', 'user', 'u', 'dashboard', 'd1', 'edit', 0)",
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g2', 'o', 'team', 't1', 'dashboard', 'd2', 'edit', 0)",
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g3', 'o', 'role', 'viewer', 'dashboard', 'd3', 'edit', 0)",
            // Someone else's grant, and a grant of another organization on the same id.
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g4', 'o', 'user', 'x', 'dashboard', 'd4', 'edit', 0)",
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g5', 'other', 'user', 'u', 'dashboard', 'd4', 'edit', 0)",
        ] {
            sqlx::query(sql).execute(&db).await.unwrap();
        }
        for (dashboard, allowed) in [("d1", true), ("d2", true), ("d3", true), ("d4", false)] {
            let r = check_resource(&db, &viewer, Permission::DashboardsWrite, Resource::Dashboard(dashboard)).await;
            assert_eq!(r.is_ok(), allowed, "{dashboard}");
        }
        let sources = explain(&db, &viewer, Permission::DashboardsWrite, Some(Resource::Dashboard("d2"))).await.unwrap();
        assert!(matches!(&sources[..], [GrantSource::Grant { grant_id, subject_type, .. }] if grant_id == "g2" && subject_type == "team"));
        // Reading comes from the role and the grant alike.
        let sources = explain(&db, &viewer, Permission::DashboardsRead, Some(Resource::Dashboard("d1"))).await.unwrap();
        assert_eq!(sources.len(), 2, "{sources:?}");
    }

    #[tokio::test]
    async fn inheritance_stub_is_the_folder_itself() {
        let db = db().await;
        assert_eq!(folder_ancestors(&db, "o", "f").await.unwrap(), ["f"]);
        assert_eq!(dashboard_folder(&db, "o", "d").await.unwrap(), None);
        assert!(!folder_is_restricted(&db, "o", "f").await.unwrap());
        exec(
            &db,
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g1', 'o', 'user', 'u', 'folder', 'f', 'edit', 0)",
        )
        .await;
        let viewer = ctx(BuiltinRole::Viewer);
        assert!(check_resource(&db, &viewer, Permission::FoldersWrite, Resource::Folder("f")).await.is_ok());
        assert!(check_resource(&db, &viewer, Permission::FoldersWrite, Resource::Folder("g")).await.is_err());
    }

    #[test]
    fn nobody_grants_what_they_do_not_hold() {
        let editor = BuiltinRole::Editor.permissions();
        assert!(ensure_holds(&editor, &BuiltinRole::Viewer.permissions()).is_ok());
        let e = ensure_holds(&editor, &BuiltinRole::Admin.permissions()).unwrap_err();
        assert_eq!(e.code, "forbidden");
        assert!(e.message.contains("users:write"), "{}", e.message);
        // Admins cannot make owners: they lack org:delete.
        assert!(ensure_holds(&BuiltinRole::Admin.permissions(), &BuiltinRole::Owner.permissions()).is_err());
        assert!(ensure_holds(&BuiltinRole::Owner.permissions(), &BuiltinRole::Owner.permissions()).is_ok());
    }

    #[test]
    fn the_last_owner_stays() {
        assert_eq!(ensure_owner_remains("owner", Some("admin"), 1).unwrap_err().code, "conflict");
        assert_eq!(ensure_owner_remains("owner", None, 1).unwrap_err().code, "conflict");
        assert!(ensure_owner_remains("owner", Some("owner"), 1).is_ok());
        assert!(ensure_owner_remains("owner", None, 2).is_ok());
        assert!(ensure_owner_remains("admin", None, 0).is_ok());
    }

    #[test]
    fn the_last_server_admin_stays() {
        assert_eq!(ensure_admin_remains(true, false, 1).unwrap_err().code, "conflict");
        assert!(ensure_admin_remains(true, false, 2).is_ok());
        assert!(ensure_admin_remains(true, true, 1).is_ok());
        assert!(ensure_admin_remains(false, false, 0).is_ok());
    }

    #[tokio::test]
    async fn owner_and_admin_counts_are_taken_under_lock() {
        let db = db().await;
        exec(&db, "UPDATE org_members SET role = 'owner'").await;
        let mut tx = db.begin().await.unwrap();
        assert_eq!(lock_owners(&mut tx, "o").await.unwrap(), 1);
        assert_eq!(lock_server_admins(&mut tx).await.unwrap(), 0);
        tx.commit().await.unwrap();
    }
}
