//! An organization's sign-in rules on every request into it (docs/api/access.md, "Organization
//! sign-in rules"). Whoever enters an organization through a session meets its rules, however
//! they joined it (`org_members.joined_by`):
//!
//! - a required second factor (`security.two_factor_required`, never laxer than the server's): an
//!   account without one is refused with `org_second_factor_required` until it sets one up, unless
//!   the session's sign-in took a provider's word for one (`trustProviderMfa`);
//! - password sign-in off (`signin.local_password` = `off`): a session signed in with a password
//!   (the break-glass admin's included) is refused with `org_provider_sign_in_required`; the person
//!   signs in through a provider or a directory instead.
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

/// The sign-in methods of a session that count as a password (`sessions.sign_in_method`); a
/// session from before migration 0039 has no method and counts as one.
fn signed_in_with_password(method: &str) -> bool {
    matches!(method, "password" | "break_glass" | "")
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
    let session: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT sign_in_method, sign_in_second_factor FROM sessions WHERE token_hash = $1")
            .bind(session_hash)
            .fetch_optional(&state.read_db)
            .await?;
    // The session was looked up for this very request; one that ended since is refused anyway.
    let Some((method, session_factor)) = session else { return Err(ApiError::unauthenticated()) };
    let password_off = crate::settings::get_org(state, org_id, "signin.local_password").await?.as_str() == Some("off");
    if password_off && signed_in_with_password(&method) {
        return Err(provider_sign_in_required(org_id));
    }
    let server = sf::server_requirement(state).await?;
    let own = sf::org_requirement(state, org_id).await?;
    if server.max(own) == sf::Requirement::Off || session_factor.as_deref() == Some("provider") {
        return Ok(());
    }
    // As at the sign-in (`second_factor::resolve`): the server's "admins" are server admins and
    // the administrators of an organization, the organization's its own administrators.
    let admin_here = sf::is_admin_role(&state.read_db, org_id, role).await?;
    let rule =
        sf::MembershipRule { org_id: org_id.to_string(), org_name: String::new(), requirement: own, admin: admin_here };
    if sf::resolve(server, user.is_server_admin != 0, std::slice::from_ref(&rule)).is_none() {
        return Ok(());
    }
    if sf::methods(&state.read_db, &user.id).await?.any() {
        return Ok(());
    }
    Err(second_factor_required(org_id))
}

pub fn second_factor_required(org_id: &str) -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "org_second_factor_required",
        "this organization requires a second factor; set one up on your account (POST /me/security/totp/setup or /me/security/passkeys/setup)",
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
