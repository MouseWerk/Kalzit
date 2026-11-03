//! An organization's sign-in rules on every request into it (docs/api/access.md, "Organization
//! sign-in rules"). Whoever enters an organization through a session meets its rules, however
//! they joined it (`org_members.joined_by`):
//!
//! - a required second factor (`security.two_factor_required`, never laxer than the server's): a
//!   session is refused with `org_second_factor_required` until it proved one itself: its sign-in
//!   asked for Kalzit's second factor, it confirmed one later (`POST /me/security/confirm`) or set
//!   one up, or its sign-in took a provider's word for one (`trustProviderMfa`) and that provider is
//!   still enabled and trusted for it. An account that has a factor does not let a session in that
//!   never proved it: a stolen password session stays out;
//! - password sign-in off (`signin.local_password` = `off`): a session signed in with a password
//!   is refused with `org_provider_sign_in_required`; the person signs in through a provider or a
//!   directory instead. The break-glass admin's sign-in, which always has Kalzit's second factor,
//!   passes, as it did at the sign-in before.
//!
//! Only the organization is refused. The person's other organizations, their account, the setup
//! of a second factor, leaving the organization (`DELETE /me/orgs/{orgId}`) and signing out stay
//! open, since none of them are routes of the organization. Server admins are members like
//! everyone else here; server administration answers to the server's rules alone. API tokens of
//! service accounts have no session and no second factor and are not gated.
//!
//! The sign-in time rules for memberships the person consented to (`authz::CONSENTED_JOINS`) stay
//! as they were: they make the person set up a second factor during the sign-in, or refuse the
//! password before a session exists.

use axum::http::StatusCode;

use super::SessionUser;
use super::second_factor as sf;
use crate::app::AppState;
use crate::error::{ApiError, ApiResult};

/// The sign-in methods of a session that count as a password for an organization's "off"
/// (`sessions.sign_in_method`); a session from before migration 0039 has no method and counts as
/// one. The break-glass admin's password sign-in always carries Kalzit's second factor and is
/// never stopped here, as it was never stopped at the sign-in.
fn signed_in_with_password(method: &str) -> bool {
    matches!(method, "password" | "")
}

/// How a session was established and what it proved since.
#[derive(sqlx::FromRow)]
struct Session {
    /// `sessions.sign_in_method`.
    method: String,
    /// `sessions.sign_in_second_factor`: Kalzit's method of the sign-in, or `provider`.
    factor: Option<String>,
    /// The identity provider or directory of the sign-in.
    provider_id: Option<String>,
    /// When the session last proved Kalzit's second factor (at the sign-in or a confirmation).
    second_factor_at: Option<i64>,
}

/// How the session `session_hash` was established.
async fn session_of(state: &AppState, session_hash: &str) -> ApiResult<Session> {
    let session: Option<Session> = sqlx::query_as(
        "SELECT sign_in_method AS method, sign_in_second_factor AS factor, sign_in_provider_id AS provider_id, \
         second_factor_at FROM sessions WHERE token_hash = $1",
    )
    .bind(session_hash)
    .fetch_optional(&state.read_db)
    .await?;
    // The session was looked up for this very request; one that ended since is refused anyway.
    session.ok_or_else(ApiError::unauthenticated)
}

/// Whether the session proved a second factor: Kalzit's own at the sign-in or since, or the
/// provider's of the sign-in while that provider is enabled and Kalzit still takes its word for
/// one. A session from before migration 0040 with a provider's factor names no provider and
/// proves nothing here; its person confirms or signs in again.
async fn proved_second_factor(state: &AppState, session: &Session) -> ApiResult<bool> {
    if session.second_factor_at.is_some() || matches!(session.factor.as_deref(), Some("totp" | "passkey" | "recovery"))
    {
        return Ok(true);
    }
    let (Some("provider"), Some(provider_id)) = (session.factor.as_deref(), session.provider_id.as_deref()) else {
        return Ok(false);
    };
    let (trusted,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM sso_providers WHERE id = $1 AND enabled = 1 AND trust_provider_mfa = 1")
            .bind(provider_id)
            .fetch_one(&state.read_db)
            .await?;
    Ok(trusted > 0)
}

/// Whether the organization's rules let this session in; `session_hash` names the session
/// (`session::hash_token`), `role` is the member's role there.
pub async fn check(
    state: &AppState,
    user: &SessionUser,
    session_hash: &str,
    org_id: &str,
    role: &str,
) -> ApiResult<()> {
    let session = session_of(state, session_hash).await?;
    let password_off = crate::settings::get_org(state, org_id, "signin.local_password").await?.as_str() == Some("off");
    if password_off && signed_in_with_password(&session.method) {
        return Err(provider_sign_in_required(org_id));
    }
    let own = sf::org_requirement(state, org_id).await?;
    if needs_second_factor(state, user, &session, org_id, role, own).await? {
        return Err(second_factor_required(org_id));
    }
    Ok(())
}

/// Whether the organization's second factor rule `own` (with the server's) refuses this session
/// there: the rule binds the member and the session proved no second factor.
async fn needs_second_factor(
    state: &AppState,
    user: &SessionUser,
    session: &Session,
    org_id: &str,
    role: &str,
    own: sf::Requirement,
) -> ApiResult<bool> {
    let server = sf::server_requirement(state).await?;
    if server.max(own) == sf::Requirement::Off || proved_second_factor(state, session).await? {
        return Ok(false);
    }
    // As at the sign-in (`second_factor::resolve`): the server's "admins" are server admins and
    // the administrators of an organization, the organization's its own administrators.
    let admin_here = sf::is_admin_role(&state.read_db, org_id, role).await?;
    let rule =
        sf::MembershipRule { org_id: org_id.to_string(), org_name: String::new(), requirement: own, admin: admin_here };
    Ok(sf::resolve(server, user.is_server_admin != 0, std::slice::from_ref(&rule)).is_some())
}

/// Whether an enabled identity provider or directory leads into `org_id`: a group mapping into
/// it, or the server's rule for people without a mapped group (`signin.default_org`).
async fn provider_leads_into(state: &AppState, org_id: &str) -> ApiResult<bool> {
    let (mapped,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sso_group_mappings g JOIN sso_providers p ON p.id = g.provider_id          WHERE g.org_id = $1 AND p.enabled = 1",
    )
    .bind(org_id)
    .fetch_one(&state.read_db)
    .await?;
    if mapped > 0 {
        return Ok(true);
    }
    let unmapped = crate::sso::unmapped(state).await?;
    if unmapped.refuse || unmapped.org_id.as_deref() != Some(org_id) {
        return Ok(false);
    }
    let (enabled,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM sso_providers WHERE enabled = 1").fetch_one(&state.read_db).await?;
    Ok(enabled > 0)
}

/// Refuses an organization setting `key` = `value` that would shut the saving session out of the
/// organization, or lock its members out (docs/api/access.md, "Organization sign-in rules"):
/// - password sign-in `off` while no enabled provider or directory leads into the organization
///   (`409`, `sso.org_local_off_blocked`, `check` = `providerReady`), or while the saving session
///   was signed in with a password (`check` = `selfViaProvider`);
/// - a second factor rule that would refuse the saving member (`409`, `second_factor.setup_first`).
pub async fn check_change(
    state: &AppState,
    user: &SessionUser,
    session_hash: &str,
    org_id: &str,
    key: &str,
    value: &serde_json::Value,
) -> ApiResult<()> {
    if key != "signin.local_password" && key != sf::POLICY_KEY {
        return Ok(());
    }
    let role: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(&user.id)
        .fetch_optional(&state.read_db)
        .await?;
    let session = session_of(state, session_hash).await?;
    if key == "signin.local_password" {
        if value.as_str() != Some("off") {
            return Ok(());
        }
        let check = if !provider_leads_into(state, org_id).await? {
            Some("providerReady")
        } else if matches!(session.method.as_str(), "password" | "break_glass" | "") {
            Some("selfViaProvider")
        } else {
            None
        };
        return match check {
            Some(check) => Err(ApiError::new(
                StatusCode::CONFLICT,
                "conflict",
                "turning password sign-in off would lock people out of the organization",
            )
            .because("sso.org_local_off_blocked")
            .param("check", check)),
            None => Ok(()),
        };
    }
    // A server admin who is no member here is not refused by the organization's rule.
    let Some((role,)) = role else { return Ok(()) };
    let own = sf::Requirement::parse(value);
    if needs_second_factor(state, user, &session, org_id, &role, own).await? {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "conflict",
            "set up your own second factor first (/settings/account-security); this rule would refuse you",
        )
        .because("second_factor.setup_first")
        .param("setupPath", "/settings/account-security"));
    }
    Ok(())
}

pub fn second_factor_required(org_id: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "org_second_factor_required",
        "this organization requires a second factor; confirm yours in this session (POST /me/security/confirm) or set one up (POST /me/security/totp/setup or /me/security/passkeys/setup)",
    )
    .because("second_factor.org_required")
    .param("orgId", org_id)
}

pub fn provider_sign_in_required(org_id: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "org_provider_sign_in_required",
        "this organization requires a sign-in through its identity provider or directory, not a password",
    )
    .because("sso.org_password_off")
    .param("orgId", org_id)
}

/// Whether `e` is one of the gate's refusals.
pub fn is_gate_error(e: &ApiError) -> bool {
    matches!(e.code, "org_second_factor_required" | "org_provider_sign_in_required")
}

/// An owner or administrator of an organization who would have no way into it once password
/// sign-in is off there (`password_only_admins`).
#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasswordOnly {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

/// The owners and administrators of `org_id` (`second_factor::is_admin_role`) with no identity
/// provider or directory sign-in into it: no confirmed identity at an enabled provider whose group
/// mapping, for the groups of the identity's last sign-in, or the server's rule for people without
/// a mapped group leads into the organization. With password sign-in off there, they are refused
/// until they sign in through a provider; the break-glass admin is not listed, as their sign-in
/// passes. Recovery then runs through a server admin (`PATCH /admin/orgs/{orgId}/sign-in-rules`).
pub async fn password_only_admins(state: &AppState, org_id: &str) -> ApiResult<Vec<PasswordOnly>> {
    let members: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT u.id, u.name, u.email, m.role FROM org_members m JOIN users u ON u.id = m.user_id \
         WHERE m.org_id = $1 AND u.service_account = 0 AND u.disabled = 0",
    )
    .bind(org_id)
    .fetch_all(&state.read_db)
    .await?;
    let break_glass = crate::sso::local_policy(state).await?.break_glass;
    let unmapped = crate::sso::unmapped(state).await?;
    let mut out = Vec::new();
    for (user_id, name, email, role) in members {
        if break_glass.as_deref() == Some(user_id.as_str()) || !sf::is_admin_role(&state.read_db, org_id, &role).await?
        {
            continue;
        }
        let identities: Vec<(String, String)> = sqlx::query_as(
            "SELECT i.provider_id, i.subject FROM sso_identities i JOIN sso_providers p ON p.id = i.provider_id \
             WHERE i.user_id = $1 AND i.confirmed = 1 AND p.enabled = 1",
        )
        .bind(&user_id)
        .fetch_all(&state.read_db)
        .await?;
        let mut leads = false;
        for (provider_id, subject) in identities {
            let groups: Vec<(String,)> =
                sqlx::query_as("SELECT group_name FROM sso_identity_groups WHERE provider_id = $1 AND subject = $2")
                    .bind(&provider_id)
                    .bind(&subject)
                    .fetch_all(&state.read_db)
                    .await?;
            let groups: Vec<String> = groups.into_iter().map(|(g,)| g).collect();
            let rules = crate::sso::mapping::rules(&state.read_db, &provider_id).await?;
            let outcome = crate::sso::mapping::resolve(&rules, &groups, &unmapped);
            if !outcome.refused && outcome.orgs.iter().any(|o| o.org_id == org_id) {
                leads = true;
                break;
            }
        }
        if !leads {
            out.push(PasswordOnly { user_id, name, email, role });
        }
    }
    out.sort_by(|a, b| crate::collation::compare(&a.name, &b.name).then_with(|| a.user_id.cmp(&b.user_id)));
    Ok(out)
}
