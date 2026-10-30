//! The end of a sign-in through a provider, the same for every kind: the account (linked, matched
//! by a confirmed email, or created), the group mapping, and the session.

use std::collections::BTreeSet;

use serde_json::json;

use super::mapping;
use super::oidc::Person;
use super::store::ProviderRow;
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::error::ApiResult;
use crate::net::RequestInfo;

/// Why the sign-in ends without a session: the outcome the person is told, and the cause for
/// the audit log.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub outcome: &'static str,
    pub reason: &'static str,
    pub detail: String,
    pub user_id: Option<String>,
}

impl Refusal {
    pub fn new(outcome: &'static str, reason: &'static str, detail: impl Into<String>) -> Self {
        Self { outcome, reason, detail: detail.into(), user_id: None }
    }
}

/// Whether the account's email is confirmed. Accounts whose email was never proven (made from an
/// invitation link copied without mail) come with the mail and invitations change (PR #161,
/// `users.email_confirmed`); until it is merged, every account was made by an admin or the setup
/// and counts as confirmed.
async fn email_confirmed(_conn: &mut sqlx::AnyConnection, _user_id: &str) -> ApiResult<bool> {
    Ok(true)
}

#[derive(sqlx::FromRow)]
struct Account {
    id: String,
    email: String,
    name: String,
    is_server_admin: i64,
    disabled: i64,
}

const ACCOUNT_COLUMNS: &str = "SELECT id, email, name, is_server_admin, disabled FROM users";

/// What a finished first step gives the session code.
pub struct SignedIn {
    pub user: SessionUser,
    pub created: bool,
    /// Organizations whose rights changed (for the query cache and the other servers).
    pub touched: BTreeSet<String>,
}

/// Finds or makes the account of `person` at `provider`, applies the group mapping and records
/// the identity, inside `conn` (a transaction). A refusal changes nothing that matters: the
/// caller rolls back.
pub async fn account(
    conn: &mut sqlx::AnyConnection,
    state: &AppState,
    info: &RequestInfo,
    provider: &ProviderRow,
    person: &Person,
    now: i64,
) -> ApiResult<Result<SignedIn, Refusal>> {
    let linked: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM sso_identities WHERE provider_id = $1 AND subject = $2")
            .bind(&provider.id)
            .bind(&person.subject)
            .fetch_optional(&mut *conn)
            .await?;
    let mut created = false;
    let account: Account = match linked {
        Some((user_id,)) => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!("{ACCOUNT_COLUMNS} WHERE id = $1")))
                .bind(&user_id)
                .fetch_one(&mut *conn)
                .await?
        }
        None => {
            let Some(email) = person.email.as_deref().and_then(|e| crate::routes::normalize_email(e).ok()) else {
                return Ok(Err(Refusal::new("failed", "sso.email_missing", "the provider sent no usable email")));
            };
            let existing: Option<Account> =
                sqlx::query_as(sqlx::AssertSqlSafe(format!("{ACCOUNT_COLUMNS} WHERE email = $1")))
                    .bind(&email)
                    .fetch_optional(&mut *conn)
                    .await?;
            match existing {
                Some(a) => {
                    if !person.email_verified || !email_confirmed(&mut *conn, &a.id).await? {
                        let mut r = Refusal::new(
                            "email_taken",
                            "sso.email_unverified",
                            "an account has this email, but the provider or the account did not confirm it",
                        );
                        r.user_id = Some(a.id);
                        return Ok(Err(r));
                    }
                    a
                }
                None if provider.create_accounts != 0 => {
                    let id = crate::routes::new_id();
                    let name = person
                        .name
                        .clone()
                        .or_else(|| person.username.clone())
                        .unwrap_or_else(|| email.split('@').next().unwrap_or_default().to_string());
                    let name: String = name.chars().filter(|c| !c.is_control()).take(100).collect();
                    sqlx::query(
                        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at) \
                         VALUES ($1, $2, $3, NULL, 0, 0, $4)",
                    )
                    .bind(&id)
                    .bind(&email)
                    .bind(&name)
                    .bind(now)
                    .execute(&mut *conn)
                    .await?;
                    created = true;
                    Account { id, email, name, is_server_admin: 0, disabled: 0 }
                }
                None => {
                    return Ok(Err(Refusal::new(
                        "no_account",
                        "sso.no_account",
                        "no account matches and the provider does not create accounts",
                    )));
                }
            }
        }
    };
    if account.disabled != 0 {
        let mut r = Refusal::new("disabled", "sso.account_disabled", "the account is disabled");
        r.user_id = Some(account.id);
        return Ok(Err(r));
    }
    // The break-glass admin is never changed by a group mapping.
    let break_glass = super::local_policy(state).await?.break_glass;
    let mut touched = BTreeSet::new();
    let mut changes = Vec::new();
    if break_glass.as_deref() != Some(account.id.as_str()) {
        let rules = mapping::rules(&mut *conn, &provider.id).await?;
        let outcome = mapping::resolve(&rules, &person.groups, &super::unmapped(state).await?);
        if outcome.refused && account.is_server_admin == 0 {
            let mut r = Refusal::new("unmapped", "sso.unmapped", "no group of the person is mapped");
            r.user_id = Some(account.id);
            return Ok(Err(r));
        }
        if !outcome.refused {
            (changes, touched) = mapping::apply(&mut *conn, &provider.id, &account.id, &outcome, now).await?;
        }
    }
    // The identity, with the groups of this sign-in.
    sqlx::query(
        "INSERT INTO sso_identities (provider_id, subject, user_id, username, created_at, last_sign_in_at) \
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider_id, subject) DO UPDATE SET \
         username = excluded.username, last_sign_in_at = excluded.last_sign_in_at",
    )
    .bind(&provider.id)
    .bind(&person.subject)
    .bind(&account.id)
    .bind(person.username.as_deref())
    .bind(now)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM sso_identity_groups WHERE provider_id = $1 AND subject = $2")
        .bind(&provider.id)
        .bind(&person.subject)
        .execute(&mut *conn)
        .await?;
    for group in &person.groups {
        sqlx::query("INSERT INTO sso_identity_groups (provider_id, subject, group_name) VALUES ($1, $2, $3)")
            .bind(&provider.id)
            .bind(&person.subject)
            .bind(group)
            .execute(&mut *conn)
            .await?;
    }
    sqlx::query("UPDATE sso_providers SET last_sign_in_at = $1 WHERE id = $2")
        .bind(now)
        .bind(&provider.id)
        .execute(&mut *conn)
        .await?;
    let event = |action: &'static str, summary| crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&account.id),
        actor_address: Some(info.client_ip.to_string()),
        action,
        resource_type: Some("user"),
        resource_id: Some(&account.id),
        summary,
        at_ms: now,
    };
    if created {
        crate::audit::record(conn, &event("auth.sso_account_created", json!({ "provider": provider.slug }))).await?;
    }
    if !changes.is_empty() {
        let summary = json!({ "provider": provider.slug, "changes": changes });
        crate::audit::record(conn, &event("sso.memberships_changed", summary)).await?;
    }
    let user = SessionUser {
        id: account.id,
        email: account.email,
        name: account.name,
        is_server_admin: account.is_server_admin,
    };
    Ok(Ok(SignedIn { user, created, touched }))
}
