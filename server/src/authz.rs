//! Authorization: the permission catalog, built-in organization roles and the access check that
//! runs before every organization-scoped route (see docs/ARCHITECTURE.md, "Authorization").

use std::collections::BTreeSet;

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

/// A resource inside an organization that grants can be attached to. The caller resolves the id
/// within `ctx.org_id` first (an id from another organization is `not_found`).
#[derive(Clone, Copy, Debug)]
pub enum Resource<'a> {
    Folder(&'a str),
    Dashboard(&'a str),
    Datasource(&'a str),
}

/// Checks `permission` on one resource: `not_found` when the caller may not even see it (a
/// restricted folder they have no grant for), `forbidden` when they see it but may not do this.
/// Today the org-wide permissions decide; resource grants and restricted folders (migration 0003)
/// are added here, so handlers that call this get them without a change.
pub async fn check_resource(
    _db: &sqlx::AnyPool,
    ctx: &OrgCtx,
    permission: Permission,
    resource: Resource<'_>,
) -> ApiResult<()> {
    let can_see = match resource {
        Resource::Folder(_) => ctx.permissions.contains(&Permission::FoldersRead),
        Resource::Dashboard(_) => ctx.permissions.contains(&Permission::DashboardsRead),
        // Viewers use data sources only through dashboards, so they need not see them.
        Resource::Datasource(_) => {
            ctx.permissions.contains(&Permission::DatasourcesRead)
                || ctx.permissions.contains(&Permission::DatasourcesQuery)
        }
    };
    if !can_see {
        return Err(ApiError::not_found());
    }
    ctx.check(permission)
}

/// Why the caller holds a permission, for the "why can I do this" dialog.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GrantSource {
    /// The member's role in the organization.
    OrgRole { role: String },
}

/// `resource` narrows the answer to grants on that resource once grants exist.
pub fn explain(ctx: &OrgCtx, permission: Permission, _resource: Option<Resource<'_>>) -> Vec<GrantSource> {
    if ctx.permissions.contains(&permission) {
        vec![GrantSource::OrgRole { role: ctx.role.clone() }]
    } else {
        Vec::new()
    }
}

/// The permissions a member holds in an organization. Today the built-in role decides; custom
/// roles and team roles (migration 0003) are added here.
pub async fn effective_permissions(
    _db: &sqlx::AnyPool,
    _user_id: &str,
    _org_id: &str,
    role: &str,
) -> ApiResult<BTreeSet<Permission>> {
    Ok(BuiltinRole::parse(role).map(BuiltinRole::permissions).unwrap_or_default())
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

    fn ctx(role: BuiltinRole) -> OrgCtx {
        OrgCtx {
            user: SessionUser { id: "u".into(), email: "u@example.de".into(), name: "U".into(), is_server_admin: 0 },
            org_id: "o".into(),
            role: role.as_str().into(),
            permissions: role.permissions(),
        }
    }

    #[tokio::test]
    async fn hidden_resources_are_not_found_and_visible_ones_forbidden() {
        sqlx::any::install_default_drivers();
        let db = sqlx::AnyPool::connect("sqlite::memory:").await.unwrap();
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
            explain(&editor, Permission::DashboardsWrite, None),
            [GrantSource::OrgRole { role: "editor".into() }]
        );
        assert!(explain(&viewer, Permission::DashboardsWrite, None).is_empty());
    }
}
