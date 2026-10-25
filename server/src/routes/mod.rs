pub mod admin_orgs;
pub mod admin_settings;
pub mod admin_users;
pub mod annotations;
pub mod audit;
pub mod auth;
pub mod branding;
pub mod dashboards;
pub mod datasources;
pub mod explore_history;
pub mod export;
pub mod folders;
pub mod grants;
pub mod health;
pub mod home;
pub mod library_panels;
pub mod me;
pub mod members;
pub mod orgs;
pub mod playlists;
pub mod preferences;
pub mod query;
pub mod roles;
pub mod setup;
pub mod support;
pub mod table;
pub mod team_context;
pub mod teams;
pub mod updates;

use serde::Serialize;

use crate::auth::SessionUser;
use crate::error::{ApiError, ApiResult};

/// Every API route, from each area's table. New areas add their `routes()` here.
pub fn all() -> Vec<table::RouteDef> {
    [
        setup::routes(),
        auth::routes(),
        orgs::routes(),
        admin_settings::routes(),
        branding::routes(),
        audit::routes(),
        folders::routes(),
        dashboards::routes(),
        annotations::routes(),
        library_panels::routes(),
        playlists::routes(),
        datasources::routes(),
        query::routes(),
        explore_history::routes(),
        export::routes(),
        members::routes(),
        teams::routes(),
        team_context::routes(),
        roles::routes(),
        grants::routes(),
        admin_users::routes(),
        admin_orgs::routes(),
        me::routes(),
        home::routes(),
        preferences::routes(),
        updates::routes(),
    ]
    .into_iter()
    .flatten()
    .collect()
}

const MAX_NAME_CHARS: usize = 100;
/// RFC 5321 limit for a forward path.
pub const MAX_EMAIL_CHARS: usize = 254;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_server_admin: bool,
    pub orgs: Vec<OrgMembership>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct OrgMembership {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// Reads through `db`: the pool, or, after a change, the change's transaction before its commit.
pub async fn me<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E, user: SessionUser) -> ApiResult<Me> {
    let orgs: Vec<OrgMembership> = sqlx::query_as(
        "SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id \
         WHERE m.user_id = $1 ORDER BY o.name",
    )
    .bind(&user.id)
    .fetch_all(db)
    .await?;
    Ok(Me { id: user.id, email: user.email, name: user.name, is_server_admin: user.is_server_admin != 0, orgs })
}

/// Trims and lowercases an email address and checks its rough shape. Delivery is what proves an
/// address; this only rejects obvious typos.
pub fn normalize_email(raw: &str) -> ApiResult<String> {
    let email = raw.trim().to_lowercase();
    // The UI applies exactly these rules before sending; keep both in step.
    let valid = email.chars().count() <= MAX_EMAIL_CHARS
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
        && matches!(email.split_once('@'), Some((local, domain))
            if !local.is_empty() && !domain.contains('@') && domain.contains('.')
                && !domain.starts_with('.') && !domain.ends_with('.'));
    if valid { Ok(email) } else { Err(ApiError::validation("email is not a valid address")) }
}

pub fn clean_name(raw: &str, what: &str) -> ApiResult<String> {
    let name = raw.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS {
        return Err(ApiError::validation(format!("{what} needs 1 to {MAX_NAME_CHARS} characters"))
            .because("request.name_length")
            .param("field", what)
            .param("max", MAX_NAME_CHARS));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::validation(format!("{what} contains control characters"))
            .because("request.name_control_characters")
            .param("field", what));
    }
    Ok(name.to_string())
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_is_normalized() {
        assert_eq!(normalize_email("  Jörg@Example.DE ").unwrap(), "jörg@example.de");
        for bad in
            ["", "a", "a@b", "@b.de", "a@.de", "a@b.", "a b@c.de", "a@b@c.de", "ada@exa\u{0}mple.com", "a\u{85}b@c.de"]
        {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(clean_name("  Müller GmbH ", "name").unwrap(), "Müller GmbH");
        assert!(clean_name("   ", "name").is_err());
        assert!(clean_name(&"x".repeat(101), "name").is_err());
        assert!(clean_name("a\u{0007}b", "name").is_err());
    }
}

#[cfg(test)]
mod access_guard {
    use crate::authz::Access;

    /// Routes anyone may call, as "METHOD path". Adding one here is a reviewed decision.
    const PUBLIC: &[&str] = &[
        "GET /setup",
        "POST /setup",
        "POST /auth/login",
        "POST /auth/logout",
        // What the sign-in page shows anyway: product name, logo, sign-in texts and default look.
        "GET /branding",
        "GET /branding/logo",
    ];
    /// Routes for any signed-in user, regardless of organization.
    const AUTHENTICATED: &[&str] = &[
        "GET /me",
        "PATCH /me",
        "POST /me/password",
        "GET /me/sessions",
        "DELETE /me/sessions/{sessionId}",
        "POST /me/sessions/revoke-others",
        "GET /me/preferences",
        "PATCH /me/preferences",
    ];

    /// The path layout decides the access rule, so a route cannot be scoped to an organization
    /// without the membership check, and an org route cannot be declared public by mistake.
    #[test]
    fn every_route_has_the_access_its_path_implies() {
        for def in super::all() {
            let segments: Vec<&str> = def.path.trim_start_matches('/').split('/').collect();
            let first = segments[0];
            let key = format!("{} {}", def.method, def.path);
            match def.access {
                Access::Public => assert!(PUBLIC.contains(&key.as_str()), "{key} is public but not listed"),
                Access::Authenticated => {
                    assert!(AUTHENTICATED.contains(&key.as_str()), "{key} needs a session but is not listed")
                }
                Access::ServerAdmin => assert_eq!(first, "admin", "{}: ServerAdmin routes live under /admin", def.path),
                Access::OrgMember | Access::Org(_) => assert!(
                    first == "orgs" && segments.get(1) == Some(&"{orgId}"),
                    "{}: organization routes are /orgs/{{orgId}}/...",
                    def.path
                ),
            }
            if first == "orgs" {
                assert!(
                    matches!(def.access, Access::Org(_) | Access::OrgMember),
                    "{} lacks the membership check",
                    def.path
                );
            }
            if first == "admin" {
                assert!(matches!(def.access, Access::ServerAdmin), "{} must be ServerAdmin", def.path);
            }
        }
    }
}
