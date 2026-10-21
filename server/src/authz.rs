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

/// Whether `resource` exists in `org_id` (trashed folders and dashboards count: grants on them
/// stay until they are purged). Works on the pool or inside a transaction (`&mut *tx`); a
/// transaction holding `lock_org` must use its own connection.
pub async fn resource_exists<'c, E>(db: E, org_id: &str, resource: Resource<'_>) -> ApiResult<bool>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let sql = match resource {
        Resource::Folder(_) => "SELECT COUNT(*) FROM folders WHERE org_id = $1 AND id = $2",
        Resource::Dashboard(_) => "SELECT COUNT(*) FROM dashboards WHERE org_id = $1 AND id = $2",
        Resource::Datasource(_) => "SELECT COUNT(*) FROM datasources WHERE org_id = $1 AND id = $2",
    };
    let (n,): (i64,) = sqlx::query_as(sql).bind(org_id).bind(resource.id()).fetch_one(db).await?;
    Ok(n > 0)
}

/// The folder chain (the folder itself first, then its parents) and a dashboard's folder, so
/// folder grants inherit and the nearest restricted folder can be found.
pub use crate::folders::{FolderLink, dashboard_folder, folder_chain};

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

/// Resolves a role key within `org_id`; `None` when there is no such role there. Works on the pool
/// or inside a transaction (`&mut *tx`).
pub async fn resolve_role<'c, E>(db: E, org_id: &str, key: &str) -> ApiResult<Option<RoleInfo>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
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
        ResourceType::parse(&self.resource_type).and_then(|t| level_permissions(t, &self.level)).unwrap_or_default()
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

/// What decides the caller's access to one resource: whether a restricted folder governs it, and
/// the caller's grants that reach it.
#[derive(Debug, Default)]
struct ResourceFacts {
    restricted: bool,
    grants: Vec<GrantRow>,
}

/// One step from the resource up to the top folder: the resource itself, then its folders.
#[derive(Clone, Debug)]
struct ChainLink {
    resource_type: ResourceType,
    id: String,
    restricted: bool,
}

/// The nearest restricted folder governs: only grants on it or below it count, so a restricted
/// subfolder narrows access and grants on folders above it do not reach into it. Without a
/// restricted folder, grants anywhere in the chain count. `grants` are the caller's grants on any
/// link of `chain` (nearest first).
fn narrow(chain: &[ChainLink], grants: Vec<GrantRow>) -> ResourceFacts {
    let governing = chain.iter().position(|link| link.restricted);
    let reach = &chain[..governing.map_or(chain.len(), |i| i + 1)];
    let grants = grants
        .into_iter()
        .filter(|g| reach.iter().any(|l| l.resource_type.as_str() == g.resource_type && l.id == g.resource_id))
        .collect();
    ResourceFacts { restricted: governing.is_some(), grants }
}

async fn resource_facts(db: &sqlx::AnyPool, ctx: &OrgCtx, resource: Resource<'_>) -> ApiResult<ResourceFacts> {
    let org_id = ctx.org_id.as_str();
    let link = |resource_type, id: &str, restricted| ChainLink { resource_type, id: id.to_string(), restricted };
    let mut chain = Vec::new();
    let folder = match resource {
        Resource::Folder(id) => Some(id.to_string()),
        Resource::Dashboard(id) => {
            chain.push(link(ResourceType::Dashboard, id, false));
            dashboard_folder(db, org_id, id).await?
        }
        Resource::Datasource(id) => {
            chain.push(link(ResourceType::Datasource, id, false));
            None
        }
    };
    if let Some(folder) = folder {
        for f in folder_chain(db, org_id, &folder).await? {
            chain.push(link(ResourceType::Folder, &f.id, f.restricted));
        }
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
    for link in &chain {
        let rows: Vec<GrantRow> = sqlx::query_as(
            "SELECT id, subject_type, subject_id, resource_type, resource_id, level FROM resource_grants \
             WHERE org_id = $1 AND resource_type = $2 AND resource_id = $3 ORDER BY id",
        )
        .bind(org_id)
        .bind(link.resource_type.as_str())
        .bind(&link.id)
        .fetch_all(db)
        .await?;
        grants.extend(rows.into_iter().filter(|g| is_caller(g)));
    }
    Ok(narrow(&chain, grants))
}

/// What decides access to many folders and dashboards at once, read in three queries, so lists can
/// say per row what the caller may do without a query per row. It applies the same rule as
/// `check_resource` (`narrow` and `permissions_on`); a test keeps the two in step.
pub struct AccessIndex {
    org: BTreeSet<Permission>,
    /// Folder id to (parent, restricted).
    folders: std::collections::HashMap<String, (Option<String>, bool)>,
    grants: Vec<GrantRow>,
}

impl AccessIndex {
    /// Reads through `conn`: a pooled connection, or a transaction that holds `lock_org`.
    pub async fn load(conn: &mut sqlx::AnyConnection, ctx: &OrgCtx) -> ApiResult<Self> {
        let folders: Vec<(String, Option<String>, i64)> =
            sqlx::query_as("SELECT id, parent_id, restricted FROM folders WHERE org_id = $1")
                .bind(&ctx.org_id)
                .fetch_all(&mut *conn)
                .await?;
        let teams: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT t.id, r.role FROM team_members m JOIN teams t ON t.id = m.team_id \
             LEFT JOIN team_roles r ON r.team_id = t.id WHERE m.user_id = $1 AND t.org_id = $2",
        )
        .bind(&ctx.user.id)
        .bind(&ctx.org_id)
        .fetch_all(&mut *conn)
        .await?;
        let grants: Vec<GrantRow> = sqlx::query_as(
            "SELECT id, subject_type, subject_id, resource_type, resource_id, level FROM resource_grants \
             WHERE org_id = $1 AND resource_type IN ('folder', 'dashboard', 'datasource') ORDER BY id",
        )
        .bind(&ctx.org_id)
        .fetch_all(&mut *conn)
        .await?;
        let team_ids: BTreeSet<&str> = teams.iter().map(|(id, _)| id.as_str()).collect();
        let mut role_keys: BTreeSet<&str> = teams.iter().filter_map(|(_, r)| r.as_deref()).collect();
        role_keys.insert(&ctx.role);
        let grants = grants
            .into_iter()
            .filter(|g| match g.subject_type.as_str() {
                "user" => g.subject_id == ctx.user.id,
                "team" => team_ids.contains(g.subject_id.as_str()),
                "role" => role_keys.contains(g.subject_id.as_str()),
                _ => false,
            })
            .collect();
        Ok(Self {
            org: ctx.permissions.clone(),
            folders: folders.into_iter().map(|(id, parent, r)| (id, (parent, r != 0))).collect(),
            grants,
        })
    }

    fn folder_links(&self, folder_id: &str, chain: &mut Vec<ChainLink>) {
        let mut next = Some(folder_id.to_string());
        while let Some(id) = next {
            // A cycle cannot be stored (moves refuse it); the bound keeps a damaged table harmless.
            if chain.len() > 64 {
                break;
            }
            let Some((parent, restricted)) = self.folders.get(&id) else { break };
            next = parent.clone();
            chain.push(ChainLink { resource_type: ResourceType::Folder, id, restricted: *restricted });
        }
    }

    /// What the caller may do on a folder, or `None` when they may not see it.
    pub fn folder(&self, folder_id: &str) -> Option<BTreeSet<Permission>> {
        let mut chain = Vec::new();
        self.folder_links(folder_id, &mut chain);
        self.decide(ResourceType::Folder, &chain)
    }

    /// What the caller may do on a data source, or `None` when they may not see it.
    pub fn datasource(&self, datasource_id: &str) -> Option<BTreeSet<Permission>> {
        let chain =
            [ChainLink { resource_type: ResourceType::Datasource, id: datasource_id.to_string(), restricted: false }];
        self.decide(ResourceType::Datasource, &chain)
    }

    /// The data sources the caller holds a grant on (org-wide visibility aside).
    pub fn granted_datasources(&self) -> BTreeSet<&str> {
        self.grants
            .iter()
            .filter(|g| g.resource_type == ResourceType::Datasource.as_str())
            .map(|g| g.resource_id.as_str())
            .collect()
    }

    /// What the caller may do on a dashboard in `folder_id`, or `None` when they may not see it.
    pub fn dashboard(&self, dashboard_id: &str, folder_id: Option<&str>) -> Option<BTreeSet<Permission>> {
        let mut chain =
            vec![ChainLink { resource_type: ResourceType::Dashboard, id: dashboard_id.to_string(), restricted: false }];
        if let Some(folder) = folder_id {
            self.folder_links(folder, &mut chain);
        }
        self.decide(ResourceType::Dashboard, &chain)
    }

    fn decide(&self, resource_type: ResourceType, chain: &[ChainLink]) -> Option<BTreeSet<Permission>> {
        let reaching = self
            .grants
            .iter()
            .filter(|g| chain.iter().any(|l| l.resource_type.as_str() == g.resource_type && l.id == g.resource_id))
            .cloned()
            .collect();
        permissions_on(&self.org, resource_type, &narrow(chain, reaching))
    }
}

/// Whether org-wide permissions reach into restricted folders: only for members who manage folder
/// permissions (admins and owners); everyone else needs a grant there. The listing SQL
/// (`folders::VISIBILITY_CTE`) applies the same rule.
pub fn role_sees_restricted(org: &BTreeSet<Permission>) -> bool {
    org.contains(&Permission::FoldersPermissions)
}

/// Whether the org-wide permissions count on this resource (see `role_sees_restricted`).
fn role_applies(org: &BTreeSet<Permission>, facts: &ResourceFacts) -> bool {
    !facts.restricted || role_sees_restricted(org)
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
    let mut out: Vec<GrantSource> =
        if role_applies(&ctx.permissions, &facts) { from_roles.collect() } else { Vec::new() };
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

/// Refuses to leave an organization without an enabled owner. `other_owners` counts the enabled
/// owners besides the member being changed; `new_role` is `None` when the member is removed.
pub fn ensure_owner_remains(current_role: &str, new_role: Option<&str>, other_owners: i64) -> ApiResult<()> {
    let leaves_owners = current_role == BuiltinRole::Owner.as_str() && new_role != Some(BuiltinRole::Owner.as_str());
    if leaves_owners && other_owners == 0 {
        return Err(conflict("the last owner of an organization cannot be removed or demoted"));
    }
    Ok(())
}

// Lock order. Transactions that lock more than one kind of row take them in this order, so two of
// them can never wait on each other in a cycle (a deadlock on PostgreSQL):
//   1. user rows of server admins (`lock_server_admins`, administration only);
//   1b. the user row of the account being disabled (`lock_orgs_left_without_owner`) or made the
//       owner of a new organization (`routes/admin_orgs.rs`);
//   2. organization rows (`lock_org`), several of them in id order;
//   3. custom role rows (`lock_role`);
//   4. owner rows of org_members (`lock_owners`, `lock_orgs_left_without_owner`).
// A sign-in locks only its own user row and nothing after it.
// While holding any of these locks, a handler uses only its transaction's connection, never the
// pool: waiting for a second connection while other writers hold theirs waiting for the lock
// would drain the pool.

/// Locks the organization's row for the rest of the transaction. Every organization change that
/// checks before it writes takes this first, so concurrent changes in one organization run one
/// after the other: on PostgreSQL through the row lock, on SQLite because the transaction starts
/// with a write (one that reads first and writes later fails with "database is locked" when
/// another writer got in between).
pub async fn lock_org(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<()> {
    // A no-op update takes the row lock on PostgreSQL and the write lock on SQLite; both drivers
    // understand it, unlike `SELECT ... FOR UPDATE`.
    sqlx::query("UPDATE orgs SET name = name WHERE id = $1").bind(org_id).execute(&mut *conn).await?;
    Ok(())
}

/// Resolves a role key inside a transaction and, for a custom role, locks its row, so it cannot be
/// changed or deleted while it is being assigned.
pub async fn lock_role(conn: &mut sqlx::AnyConnection, org_id: &str, key: &str) -> ApiResult<Option<RoleInfo>> {
    if BuiltinRole::parse(key).is_none() {
        sqlx::query("UPDATE roles SET name = name WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(key)
            .execute(&mut *conn)
            .await?;
    }
    resolve_role(&mut *conn, org_id, key).await
}

/// Locks the owner rows of `org_id` for the rest of the transaction and counts the enabled owners
/// other than `user_id`, so two owners demoting each other at the same time cannot both succeed.
pub async fn lock_owners(conn: &mut sqlx::AnyConnection, org_id: &str, user_id: &str) -> ApiResult<i64> {
    sqlx::query("UPDATE org_members SET role = role WHERE org_id = $1 AND role = 'owner'")
        .bind(org_id)
        .execute(&mut *conn)
        .await?;
    let (owners,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM org_members m JOIN users u ON u.id = m.user_id \
         WHERE m.org_id = $1 AND m.role = 'owner' AND m.user_id <> $2 AND u.disabled = 0",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(owners)
}

/// Before disabling `user_id`: locks every organization they own (in id order, see the lock order
/// above `lock_org`), then those organizations' owner rows, and counts the organizations that would
/// be left without an enabled owner.
pub async fn lock_orgs_left_without_owner(conn: &mut sqlx::AnyConnection, user_id: &str) -> ApiResult<i64> {
    // The user's own row first (user rows come before organization rows in the lock order). It
    // also makes this safe as the first statement of a transaction: on SQLite a transaction that
    // reads first can fail at its first write when another commit made its snapshot stale.
    sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1").bind(user_id).execute(&mut *conn).await?;
    let owned: Vec<(String,)> =
        sqlx::query_as("SELECT org_id FROM org_members WHERE user_id = $1 AND role = 'owner' ORDER BY org_id")
            .bind(user_id)
            .fetch_all(&mut *conn)
            .await?;
    for (org_id,) in &owned {
        lock_org(conn, org_id).await?;
    }
    sqlx::query(
        "UPDATE org_members SET role = role WHERE role = 'owner' \
         AND org_id IN (SELECT org_id FROM org_members WHERE user_id = $1 AND role = 'owner')",
    )
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    let (orphaned,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM org_members m WHERE m.user_id = $1 AND m.role = 'owner' AND NOT EXISTS \
         (SELECT 1 FROM org_members o JOIN users u ON u.id = o.user_id \
          WHERE o.org_id = m.org_id AND o.role = 'owner' AND o.user_id <> m.user_id AND u.disabled = 0)",
    )
    .bind(user_id)
    .fetch_one(&mut *conn)
    .await?;
    Ok(orphaned)
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
        exec(
            &db,
            "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at) \
             VALUES ('d', 'o', 'D', 'd', 1, 0, 0)",
        )
        .await;
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
        assert_eq!(
            level_permissions(ResourceType::Datasource, "query").unwrap(),
            [DatasourcesQuery, DatasourcesRead].into()
        );
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
        assert!(
            permissions_on(&admin, ResourceType::Dashboard, &restricted)
                .unwrap()
                .contains(&Permission::DashboardsWrite)
        );
        // With a view grant, an editor sees it but the role's write permission does not apply.
        let granted = ResourceFacts { restricted: true, grants: vec![grant("folder", "f", "view")] };
        let held = permissions_on(&editor, ResourceType::Folder, &granted).unwrap();
        assert!(held.contains(&Permission::FoldersRead) && !held.contains(&Permission::FoldersWrite));
    }

    fn link(resource_type: ResourceType, id: &str, restricted: bool) -> ChainLink {
        ChainLink { resource_type, id: id.into(), restricted }
    }

    fn team_grant(team: &str, resource_type: &str, resource_id: &str) -> GrantRow {
        GrantRow { subject_type: "team".into(), subject_id: team.into(), ..grant(resource_type, resource_id, "view") }
    }

    #[test]
    fn the_nearest_restricted_folder_governs() {
        // Restricted "Finanzen" (Finance may view) holds restricted "Gehaelter" (HR may view).
        let finance_grants = || vec![team_grant("finance", "folder", "finanzen")];
        let finanzen = [link(ResourceType::Folder, "finanzen", true), link(ResourceType::Folder, "root", false)];
        let gehaelter = [
            link(ResourceType::Folder, "gehaelter", true),
            link(ResourceType::Folder, "finanzen", true),
            link(ResourceType::Folder, "root", false),
        ];
        let viewer = BuiltinRole::Viewer.permissions();
        assert!(permissions_on(&viewer, ResourceType::Folder, &narrow(&finanzen, finance_grants())).is_some());
        assert!(permissions_on(&viewer, ResourceType::Folder, &narrow(&gehaelter, finance_grants())).is_none());
        let hr = vec![team_grant("hr", "folder", "gehaelter")];
        assert!(permissions_on(&viewer, ResourceType::Folder, &narrow(&gehaelter, hr)).is_some());

        // A dashboard inside "Gehaelter": its own grants and the folder's count, not those above.
        let mut dashboard = vec![link(ResourceType::Dashboard, "lohn", false)];
        dashboard.extend(gehaelter.iter().cloned());
        assert!(permissions_on(&viewer, ResourceType::Dashboard, &narrow(&dashboard, finance_grants())).is_none());
        let own = vec![grant("dashboard", "lohn", "view")];
        assert!(permissions_on(&viewer, ResourceType::Dashboard, &narrow(&dashboard, own)).is_some());

        // Without a restricted folder, grants anywhere in the chain inherit down.
        let open = [link(ResourceType::Folder, "sub", false), link(ResourceType::Folder, "top", false)];
        let facts = narrow(&open, vec![grant("folder", "top", "edit")]);
        assert!(!facts.restricted && facts.grants.len() == 1);
        // Admins see restricted folders through their role.
        let admin = BuiltinRole::Admin.permissions();
        assert!(permissions_on(&admin, ResourceType::Folder, &narrow(&gehaelter, vec![])).is_some());
    }

    #[tokio::test]
    async fn custom_and_team_roles_add_up() {
        let db = db().await;
        exec(&db, "INSERT INTO roles (id, org_id, name, name_key, description, created_at) VALUES ('r1', 'o', 'Auditor', 'auditor', '', 0)")
            .await;
        exec(&db, "INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'audit:read')").await;
        // Names the server does not know (from a newer or older version) grant nothing.
        exec(&db, "INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'rockets:launch')").await;
        let held = effective_permissions(&db, "u", "o", "r1").await.unwrap();
        assert_eq!(held, [Permission::AuditRead].into());
        // A custom role of another organization is no role here.
        assert!(effective_permissions(&db, "u", "other", "r1").await.unwrap().is_empty());

        exec(
            &db,
            "INSERT INTO teams (id, org_id, name, name_key, created_at) VALUES ('t1', 'o', 'Betrieb', 'betrieb', 0)",
        )
        .await;
        exec(&db, "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ('t1', 'u', 'member', 0)")
            .await;
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
        exec(
            &db,
            "INSERT INTO dashboards (id, org_id, title, search_title, version, created_at, updated_at) VALUES \
             ('d1', 'o', 'D', 'd', 1, 0, 0), ('d2', 'o', 'D', 'd', 1, 0, 0), ('d3', 'o', 'D', 'd', 1, 0, 0), \
             ('d4', 'o', 'D', 'd', 1, 0, 0)",
        )
        .await;
        exec(
            &db,
            "INSERT INTO teams (id, org_id, name, name_key, created_at) VALUES ('t1', 'o', 'Betrieb', 'betrieb', 0)",
        )
        .await;
        exec(&db, "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ('t1', 'u', 'member', 0)")
            .await;
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
        let sources =
            explain(&db, &viewer, Permission::DashboardsWrite, Some(Resource::Dashboard("d2"))).await.unwrap();
        assert!(
            matches!(&sources[..], [GrantSource::Grant { grant_id, subject_type, .. }] if grant_id == "g2" && subject_type == "team")
        );
        // Reading comes from the role and the grant alike.
        let sources = explain(&db, &viewer, Permission::DashboardsRead, Some(Resource::Dashboard("d1"))).await.unwrap();
        assert_eq!(sources.len(), 2, "{sources:?}");
    }

    #[tokio::test]
    async fn the_access_index_agrees_with_check_resource_on_dashboards() {
        let db = db().await;
        for sql in [
            "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_at, updated_at) \
             VALUES ('open', 'o', NULL, 'O', 0, 1, 0, 0), ('secret', 'o', NULL, 'S', 1, 1, 0, 0)",
            "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_at, updated_at) \
             VALUES ('top', 'o', NULL, 'T', 't', 1, 0, 0), ('in_open', 'o', 'open', 'O', 'o', 1, 0, 0), \
             ('own_grant', 'o', 'secret', 'G', 'g', 1, 0, 0), ('hidden', 'o', 'secret', 'H', 'h', 1, 0, 0)",
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g1', 'o', 'user', 'u', 'dashboard', 'own_grant', 'edit', 0), \
             ('g2', 'o', 'user', 'u', 'folder', 'open', 'edit', 0)",
        ] {
            exec(&db, sql).await;
        }
        for role in [BuiltinRole::Viewer, BuiltinRole::Editor, BuiltinRole::Admin] {
            let ctx = ctx(role);
            let index = AccessIndex::load(&mut db.acquire().await.unwrap(), &ctx).await.unwrap();
            for (id, folder) in
                [("top", None), ("in_open", Some("open")), ("own_grant", Some("secret")), ("hidden", Some("secret"))]
            {
                let held = resource_permissions(&db, &ctx, Resource::Dashboard(id)).await.unwrap();
                assert_eq!(index.dashboard(id, folder), held, "{role:?} {id}");
            }
        }
        // The cases that matter: the own grant opens the dashboard in the hidden folder, nothing
        // else in it.
        let viewer = AccessIndex::load(&mut db.acquire().await.unwrap(), &ctx(BuiltinRole::Viewer)).await.unwrap();
        assert!(viewer.dashboard("own_grant", Some("secret")).unwrap().contains(&Permission::DashboardsWrite));
        assert!(viewer.dashboard("hidden", Some("secret")).is_none());
        assert!(viewer.folder("secret").is_none());
    }

    #[tokio::test]
    async fn folder_grants_inherit_through_the_stored_tree() {
        let db = db().await;
        for sql in [
            "INSERT INTO folders (id, org_id, parent_id, name, restricted, version, created_at, updated_at) \
             VALUES ('f', 'o', NULL, 'F', 0, 1, 0, 0), ('sub', 'o', 'f', 'S', 0, 1, 0, 0), \
             ('g', 'o', NULL, 'G', 0, 1, 0, 0), ('secret', 'o', 'f', 'X', 1, 1, 0, 0)",
            "INSERT INTO dashboards (id, org_id, folder_id, title, search_title, version, created_at, updated_at) \
             VALUES ('d', 'o', 'sub', 'D', 'd', 1, 0, 0), ('hidden', 'o', 'secret', 'H', 'h', 1, 0, 0)",
            "INSERT INTO resource_grants (id, org_id, subject_type, subject_id, resource_type, resource_id, level, created_at) \
             VALUES ('g1', 'o', 'user', 'u', 'folder', 'f', 'edit', 0)",
        ] {
            exec(&db, sql).await;
        }
        assert_eq!(dashboard_folder(&db, "o", "d").await.unwrap().as_deref(), Some("sub"));
        assert_eq!(folder_chain(&db, "o", "sub").await.unwrap().len(), 2);
        let viewer = ctx(BuiltinRole::Viewer);
        let can = |p, r| check_resource(&db, &viewer, p, r);
        assert!(can(Permission::FoldersWrite, Resource::Folder("f")).await.is_ok());
        assert!(can(Permission::FoldersWrite, Resource::Folder("sub")).await.is_ok());
        assert!(can(Permission::DashboardsWrite, Resource::Dashboard("d")).await.is_ok());
        assert_eq!(can(Permission::FoldersWrite, Resource::Folder("g")).await.unwrap_err().code, "forbidden");
        // The grant on "f" does not reach into the restricted folder below it.
        assert_eq!(can(Permission::DashboardsRead, Resource::Dashboard("hidden")).await.unwrap_err().code, "not_found");
        // Ids that are not in this organization do not exist.
        assert_eq!(can(Permission::FoldersRead, Resource::Folder("nope")).await.unwrap_err().code, "not_found");
        assert!(resource_exists(&db, "o", Resource::Dashboard("d")).await.unwrap());
        assert!(!resource_exists(&db, "other", Resource::Dashboard("d")).await.unwrap());
        assert!(!resource_exists(&db, "o", Resource::Folder("nope")).await.unwrap());
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
        // The count is of the other enabled owners.
        assert_eq!(ensure_owner_remains("owner", Some("admin"), 0).unwrap_err().code, "conflict");
        assert_eq!(ensure_owner_remains("owner", None, 0).unwrap_err().code, "conflict");
        assert!(ensure_owner_remains("owner", Some("owner"), 0).is_ok());
        assert!(ensure_owner_remains("owner", None, 1).is_ok());
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
        exec(&db, "INSERT INTO users (id, email, name, disabled, created_at) VALUES ('d', 'd@example.de', 'D', 1, 0)")
            .await;
        exec(&db, "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ('o', 'd', 'owner', 0)").await;
        let mut tx = crate::db::begin(&db).await.unwrap();
        lock_org(&mut tx, "o").await.unwrap();
        // A disabled owner does not count: u is the only enabled one.
        assert_eq!(lock_owners(&mut tx, "o", "u").await.unwrap(), 0);
        assert_eq!(lock_owners(&mut tx, "o", "d").await.unwrap(), 1);
        assert_eq!(lock_orgs_left_without_owner(&mut tx, "u").await.unwrap(), 1);
        assert_eq!(lock_orgs_left_without_owner(&mut tx, "d").await.unwrap(), 0);
        assert_eq!(lock_server_admins(&mut tx).await.unwrap(), 0);
        assert_eq!(lock_role(&mut tx, "o", "viewer").await.unwrap().unwrap().name, "viewer");
        assert!(lock_role(&mut tx, "o", "gone").await.unwrap().is_none());
        crate::db::commit(tx).await.unwrap();
    }
}
