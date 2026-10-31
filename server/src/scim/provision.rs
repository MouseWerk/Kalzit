//! What a SCIM change does to accounts and memberships: the group mapping of the organization,
//! deactivating and reactivating, and the accounts SCIM never touches.
//!
//! Deactivating (`active: false` or a DELETE) never deletes. An account this organization's SCIM
//! still owns (`super::owner_org`) is locked (disabled and signed out everywhere); its membership
//! stays, so it comes back as it was. Any other account keeps its access elsewhere: only its
//! membership in this organization ends. SCIM never deactivates, removes or changes the role of an
//! owner, a member whose role holds more than an admin's, a server admin or the break-glass admin
//! (the members API's rule: nobody takes away more than they hold, and the token holds an admin's
//! permissions).

use std::collections::BTreeSet;

use serde_json::json;

use super::{Ctx, ScimError, ScimResult};
use crate::app::AppState;
use crate::sso::mapping::{self, Outcome, Unmapped};

/// The server's sign-in settings a change needs, read before its transaction starts (a handler
/// holding locks reads only through its transaction).
pub struct Policy {
    break_glass: Option<String>,
    /// The rule for SCIM users without a mapped group: the server's unmapped rule, with this
    /// organization as the place and its default role (viewer when it names none a mapping gives).
    unmapped: Unmapped,
}

impl Policy {
    pub async fn load(state: &AppState, org_id: &str) -> ScimResult<Self> {
        let rule = crate::sso::unmapped(state).await?;
        let role = if mapping::DEFAULT_ROLES.contains(&rule.role.as_str()) { rule.role } else { "viewer".to_string() };
        Ok(Self {
            break_glass: crate::sso::local_policy(state).await?.break_glass,
            unmapped: Unmapped { refuse: rule.refuse, org_id: Some(org_id.to_string()), role },
        })
    }

    /// For reads, which change nothing.
    pub fn none() -> Self {
        Self { break_glass: None, unmapped: Unmapped { refuse: true, org_id: None, role: String::new() } }
    }

    /// The break-glass admin's id, if one is set.
    pub fn break_glass(&self) -> Option<&str> {
        self.break_glass.as_deref()
    }
}

fn protected(detail: &str) -> ScimError {
    ScimError::protected(detail.to_string()).because("scim.account_protected")
}

/// Why SCIM may not change `user_id`'s account or role, or `None`: the break-glass admin, a server
/// admin, a service account, or a member of this organization whose role holds more than an
/// admin's (owners always). Read inside the change's transaction.
pub async fn protection(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, user_id: &str) -> ScimResult<Option<ScimError>> {
    if ctx.policy.break_glass.as_deref() == Some(user_id) {
        return Ok(Some(protected("the break-glass admin is never changed through SCIM")));
    }
    let account: Option<(i64, i64)> =
        sqlx::query_as("SELECT is_server_admin, service_account FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    match account {
        Some((admin, _)) if admin != 0 => {
            return Ok(Some(protected("a server admin's account and roles are never changed through SCIM")));
        }
        Some((_, service)) if service != 0 => {
            return Ok(Some(protected("service accounts are never changed through SCIM")));
        }
        _ => {}
    }
    let role: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(ctx.org_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some((role,)) = role {
        let held = crate::authz::resolve_role(&mut *conn, ctx.org_id, &role).await?.map(|r| r.permissions);
        let admin = crate::authz::BuiltinRole::Admin.permissions();
        let beyond = role == crate::authz::BuiltinRole::Owner.as_str()
            || held.is_none_or(|held| crate::authz::ensure_holds(&admin, &held).is_err());
        if beyond {
            return Ok(Some(protected(
                "this member's role holds more than an admin's; SCIM never removes or changes it",
            )));
        }
    }
    Ok(None)
}

/// The group names of `user_id` in this organization: the `displayName` and `externalId` of each
/// active SCIM group they are in.
async fn group_names(conn: &mut sqlx::AnyConnection, org_id: &str, user_id: &str) -> ScimResult<Vec<String>> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT g.display_name, g.external_id FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id \
         WHERE m.user_id = $1 AND g.org_id = $2 AND g.deactivated_at IS NULL ORDER BY g.display_name",
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut names = Vec::new();
    for (name, external) in rows {
        names.push(name);
        names.extend(external.filter(|e| !e.is_empty()));
    }
    Ok(names)
}

/// Brings `user_id`'s membership and teams in this organization in line with their groups, inside
/// the change's transaction (which holds `lock_org`). Inactive SCIM users and the break-glass
/// admin are left alone. Writes `scim.memberships_changed` when something changed and answers the
/// organizations whose rights changed.
pub async fn sync(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, user_id: &str) -> ScimResult<BTreeSet<String>> {
    let active: Option<(i64,)> = sqlx::query_as(
        "SELECT s.active FROM scim_users s JOIN users u ON u.id = s.user_id \
         WHERE s.org_id = $1 AND s.user_id = $2 AND u.service_account = 0",
    )
    .bind(ctx.org_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    if active.is_none_or(|(a,)| a == 0) || protection(&mut *conn, ctx, user_id).await?.is_some() {
        return Ok(BTreeSet::new());
    }
    let groups = group_names(&mut *conn, ctx.org_id, user_id).await?;
    let rules = mapping::org_rules(&mut *conn, ctx.org_id).await?;
    let mut outcome = mapping::resolve(&rules, &groups, &ctx.policy.unmapped);
    if outcome.refused {
        // No group and the unmapped rule refuses: what the directory decided ends, nothing is added.
        outcome = Outcome::default();
    }
    outcome.orgs.retain(|o| o.org_id == ctx.org_id);
    let now = ctx.state.clock.now_ms();
    let (changes, touched) = mapping::apply_scim(&mut *conn, ctx.org_id, user_id, &outcome, now).await?;
    if !changes.is_empty() {
        let summary = json!({ "userId": user_id, "groups": groups, "changes": changes });
        super::audit(&mut *conn, ctx, "scim.memberships_changed", ("user", user_id), summary).await?;
    }
    Ok(touched)
}

/// The row of a SCIM user as deactivating and reactivating need it.
#[derive(sqlx::FromRow)]
struct Link {
    locked_account: i64,
    disabled: i64,
}

async fn link(conn: &mut sqlx::AnyConnection, org_id: &str, user_id: &str) -> ScimResult<Link> {
    sqlx::query_as(
        "SELECT s.locked_account, u.disabled FROM scim_users s \
         JOIN users u ON u.id = s.user_id WHERE s.org_id = $1 AND s.user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(ScimError::not_found)
}

/// Deactivates `user_id` in this organization (see the module's comment). Answers what it did for
/// the audit entry: `"account"` (locked) or `"organization"` (membership ended), and the
/// organizations whose rights changed. The transaction holds the user's row and `lock_org`.
pub async fn deactivate(
    conn: &mut sqlx::AnyConnection,
    ctx: &Ctx<'_>,
    user_id: &str,
) -> ScimResult<(&'static str, BTreeSet<String>)> {
    if let Some(e) = protection(&mut *conn, ctx, user_id).await? {
        return Err(e);
    }
    let link = link(&mut *conn, ctx.org_id, user_id).await?;
    let member: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(ctx.org_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let owned = super::owner_org(&mut *conn, user_id, ctx.policy.break_glass()).await?.as_deref() == Some(ctx.org_id);
    let now = ctx.state.clock.now_ms();
    let mut touched = BTreeSet::new();
    let scope = if owned {
        if link.disabled == 0 {
            sqlx::query("UPDATE users SET disabled = 1 WHERE id = $1").bind(user_id).execute(&mut *conn).await?;
            // Signed out everywhere at once, like an account an admin disables.
            crate::auth::session::delete_for_user(&mut *conn, user_id, None).await?;
            sqlx::query("UPDATE scim_users SET locked_account = 1 WHERE org_id = $1 AND user_id = $2")
                .bind(ctx.org_id)
                .bind(user_id)
                .execute(&mut *conn)
                .await?;
            touched.insert(ctx.org_id.to_string());
        }
        "account"
    } else {
        if member.is_some() {
            crate::routes::members::remove_membership(&mut *conn, ctx.org_id, user_id).await?;
            touched.insert(ctx.org_id.to_string());
        }
        "organization"
    };
    sqlx::query("UPDATE scim_users SET active = 0, updated_at = $1 WHERE org_id = $2 AND user_id = $3")
        .bind(now)
        .bind(ctx.org_id)
        .bind(user_id)
        .execute(&mut *conn)
        .await?;
    Ok((scope, touched))
}

/// Reactivates `user_id`: unlocks the account when deactivating locked it and nothing else locked
/// it since (an admin's enable or disable clears SCIM's lock, `routes::admin_users`), then applies
/// the group mapping again.
pub async fn reactivate(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, user_id: &str) -> ScimResult<BTreeSet<String>> {
    let link = link(&mut *conn, ctx.org_id, user_id).await?;
    if link.locked_account != 0 {
        sqlx::query("UPDATE users SET disabled = 0 WHERE id = $1").bind(user_id).execute(&mut *conn).await?;
    }
    sqlx::query(
        "UPDATE scim_users SET active = 1, locked_account = 0, updated_at = $1 WHERE org_id = $2 AND user_id = $3",
    )
    .bind(ctx.state.clock.now_ms())
    .bind(ctx.org_id)
    .bind(user_id)
    .execute(&mut *conn)
    .await?;
    sync(conn, ctx, user_id).await
}
