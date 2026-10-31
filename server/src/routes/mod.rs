pub mod about;
pub mod acme;
pub mod admin_orgs;
pub mod admin_settings;
pub mod admin_users;
pub mod ai;
pub mod ai_calls;
pub mod ai_chat;
pub mod analyses;
pub mod annotations;
pub mod audit;
pub mod auth;
pub mod branding;
pub mod dashboards;
pub mod datasources;
pub mod email_confirmation;
pub mod explore_history;
pub mod export;
pub mod folders;
pub mod grants;
pub mod health;
pub mod home;
pub mod instances;
pub mod invitations;
pub mod ldap;
pub mod library_panels;
pub mod live;
#[cfg(test)]
mod live_tests;
pub mod mail;
pub mod me;
pub mod members;
pub mod orgs;
pub mod panel_plugins;
pub mod panel_state;
pub mod password_reset;
pub mod playlists;
pub mod plugins;
pub mod preferences;
pub mod query;
pub mod query_cache;
pub mod roles;
pub mod second_factor;
pub mod security;
pub mod service_accounts;
pub mod setup;
pub mod sso;
pub mod support;
pub mod table;
pub mod team_context;
pub mod teams;
pub mod updates;
pub mod usage;

use serde::Serialize;

use crate::auth::SessionUser;
use crate::error::{ApiError, ApiResult};

/// Every API route, from each area's table. New areas add their `routes()` here.
pub fn all() -> Vec<table::RouteDef> {
    [
        setup::routes(),
        about::routes(),
        auth::routes(),
        sso::routes(),
        ldap::routes(),
        second_factor::routes(),
        security::routes(),
        orgs::routes(),
        admin_settings::routes(),
        acme::routes(),
        branding::routes(),
        audit::routes(),
        folders::routes(),
        dashboards::routes(),
        analyses::routes(),
        annotations::routes(),
        library_panels::routes(),
        playlists::routes(),
        datasources::routes(),
        query::routes(),
        query_cache::routes(),
        instances::routes(),
        explore_history::routes(),
        live::routes(),
        export::routes(),
        members::routes(),
        service_accounts::routes(),
        teams::routes(),
        team_context::routes(),
        roles::routes(),
        grants::routes(),
        admin_users::routes(),
        admin_orgs::routes(),
        me::routes(),
        home::routes(),
        panel_state::routes(),
        panel_plugins::routes(),
        preferences::routes(),
        updates::routes(),
        ai::routes(),
        ai_calls::routes(),
        ai_chat::routes(),
        plugins::routes(),
        // Mail, invitations and password reset (docs/api/mail.md).
        mail::routes(),
        invitations::routes(),
        password_reset::routes(),
        email_confirmation::routes(),
        usage::routes(),
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
    /// False for an account made from an invitation link that was passed on rather than mailed,
    /// until its owner confirms the address (`routes::email_confirmation`).
    pub email_confirmed: bool,
    pub orgs: Vec<OrgMembership>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct OrgMembership {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// Reads through `db`: a pooled connection, or, after a change, the change's transaction before
/// its commit.
pub async fn me(db: &mut sqlx::AnyConnection, user: SessionUser) -> ApiResult<Me> {
    let (confirmed,): (i64,) =
        sqlx::query_as("SELECT email_confirmed FROM users WHERE id = $1").bind(&user.id).fetch_one(&mut *db).await?;
    let orgs: Vec<OrgMembership> = sqlx::query_as(
        "SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id \
         WHERE m.user_id = $1 ORDER BY o.name",
    )
    .bind(&user.id)
    .fetch_all(&mut *db)
    .await?;
    Ok(Me {
        id: user.id,
        email: user.email,
        name: user.name,
        is_server_admin: user.is_server_admin != 0,
        email_confirmed: confirmed != 0,
        orgs,
    })
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

/// The form two addresses are compared in: the local part lowercased and the domain mapped by
/// IDNA (UTS #46, which also unifies NFC and NFD), so `anna@bücher.example` and
/// `anna@xn--bcher-kva.example` are one address. An address IDNA cannot map (a local part outside
/// ASCII) is compared as stored.
pub fn email_key(email: &str) -> String {
    crate::sso::oidc::matching_email(email).unwrap_or_else(|| email.to_string())
}

/// Whether two addresses are one (`email_key`).
pub fn same_email(a: &str, b: &str) -> bool {
    a == b || email_key(a) == email_key(b)
}

/// The accounts whose address is `email` in any of its forms (`email_key`), service accounts
/// included: `(id, service_account)`. Accounts keep the form they were made with, so the
/// candidates are those with the same local part, and the domain is compared in Rust.
pub async fn all_accounts_with_email(conn: &mut sqlx::AnyConnection, email: &str) -> ApiResult<Vec<(String, bool)>> {
    let key = email_key(email);
    let prefix = match key.rsplit_once('@') {
        Some((local, _)) => format!("{local}@"),
        None => key.clone(),
    };
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id, email, service_account FROM users          WHERE email = $1 OR email = $2 OR substr(email, 1, length($3)) = $3 ORDER BY id",
    )
    .bind(email)
    .bind(&key)
    .bind(&prefix)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, stored, _)| stored == email || email_key(stored) == key)
        .map(|(id, _, service)| (id, service != 0))
        .collect())
}

/// The people (no service accounts) whose address is `email` in any of its forms.
pub async fn accounts_with_email(conn: &mut sqlx::AnyConnection, email: &str) -> ApiResult<Vec<String>> {
    Ok(all_accounts_with_email(conn, email)
        .await?
        .into_iter()
        .filter(|(_, service)| !service)
        .map(|(id, _)| id)
        .collect())
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
    fn email_forms_compare_as_one() {
        let nfc = "anna@b\u{fc}cher.example";
        let nfd = "anna@bu\u{308}cher.example";
        assert_eq!(email_key(nfc), "anna@xn--bcher-kva.example");
        assert!(same_email(nfc, "anna@xn--bcher-kva.example"));
        assert!(same_email("anna@xn--bcher-kva.example", nfc));
        assert!(same_email(nfd, nfc));
        assert!(!same_email("anna@bucher.example", nfc));
        assert_eq!(email_key("j\u{f6}rg@example.de"), "j\u{f6}rg@example.de");
    }

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
        // Rate-limited per address like setup itself, which checks the same code.
        "POST /setup/check",
        "POST /auth/login",
        "POST /auth/logout",
        // Single sign-on (docs/api/sso.md): the buttons of the sign-in page, the start of a sign-in
        // through a provider (rate-limited per address) and the break-glass form (its own limit on
        // top of the sign-in limits).
        "GET /auth/providers",
        "GET /auth/sso/{slug}/start",
        "POST /auth/login/local",
        // The second step of a sign-in: each needs the half-signed-in state of its cookie
        // (`auth::second_factor`), and the codes count against the account's lockout.
        "GET /auth/second-factor",
        "POST /auth/second-factor",
        "POST /auth/second-factor/passkey",
        "POST /auth/second-factor/setup/totp",
        "POST /auth/second-factor/setup/passkey",
        "POST /auth/second-factor/setup",
        // What the sign-in page shows anyway: product name, logo, sign-in texts and default look.
        "GET /branding",
        "GET /branding/logo",
        // Invitation and password links (docs/api/mail.md): the token is the credential; unknown
        // tokens count against the client address, requests for a link are limited per address,
        // network and account and answer alike for every address.
        "POST /auth/invitation",
        "POST /auth/invitation/accept",
        "GET /auth/password-reset",
        "POST /auth/password-reset",
        "POST /auth/password-reset/inspect",
        "POST /auth/password-reset/complete",
    ];
    /// Routes for any signed-in user, regardless of organization.
    const AUTHENTICATED: &[&str] = &[
        "GET /about",
        "GET /me",
        "PATCH /me",
        "POST /me/password",
        "GET /me/sessions",
        "DELETE /me/sessions/{sessionId}",
        "POST /me/sessions/revoke-others",
        "GET /me/preferences",
        "PATCH /me/preferences",
        // Sends the user's own address a confirmation link (docs/api/mail.md).
        "POST /me/email-confirmation",
        // Confirms with the link's token, for the signed-in account the link was made for only.
        "POST /me/email-confirmation/confirm",
        "GET /me/security",
        "POST /me/security/confirm",
        "POST /me/security/confirm/passkey",
        "POST /me/security/totp/setup",
        "POST /me/security/totp",
        "DELETE /me/security/totp",
        "POST /me/security/passkeys/setup",
        "POST /me/security/passkeys",
        "PATCH /me/security/passkeys/{passkeyId}",
        "DELETE /me/security/passkeys/{passkeyId}",
        "POST /me/security/recovery-codes",
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
