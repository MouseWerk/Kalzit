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
    PluginsInstall => "plugins:install",
    PluginsConfigure => "plugins:configure",
    SettingsRead => "settings:read",
    SettingsWrite => "settings:write",
    OrgWrite => "org:write",
    OrgDelete => "org:delete",
}

/// The four roles every organization has. Custom roles (migration 0002) add to these.
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

    pub fn permissions(self) -> BTreeSet<Permission> {
        use Permission::*;
        match self {
            Self::Owner => Permission::ALL.iter().copied().collect(),
            Self::Admin => Permission::ALL.iter().copied().filter(|p| *p != OrgDelete).collect(),
            Self::Editor => [
                DashboardsRead,
                DashboardsWrite,
                DashboardsDelete,
                DashboardsShare,
                FoldersRead,
                FoldersWrite,
                DatasourcesQuery,
                DatasourcesRead,
                AnalysesRead,
                AnalysesWrite,
                DataExport,
                AnnotationsWrite,
                TeamsRead,
                UsersRead,
            ]
            .into(),
            // Viewers query data sources only through what they may see; resource checks narrow
            // this to the data sources of dashboards they can read.
            Self::Viewer => [DashboardsRead, FoldersRead, AnalysesRead, DatasourcesQuery, TeamsRead].into(),
        }
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

/// The permissions a member holds in an organization. Today the built-in role decides; custom
/// roles, team roles and resource grants (migration 0002) are added here.
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
    fn unknown_roles_grant_nothing() {
        assert!(BuiltinRole::parse("superuser").is_none());
    }
}
