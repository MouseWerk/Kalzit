//! The end of a sign-in through a provider, the same for every kind: the account (linked, matched
//! by a confirmed email, or created), the group mapping, and what waits for Kalzit's second
//! factor.
//!
//! Order (docs/api/sso.md, "Callback"): the account and its identity are settled first, since
//! the second step needs an account to belong to; a new account has no rights until the mapping
//! applies. The mapping only applies once the sign-in is complete: at once without a second step,
//! otherwise after it (`apply_deferred`, called by `routes::second_factor`). Only what takes rights
//! away applies before: a person the unmapped rule refuses loses the memberships the provider
//! decided.

use std::collections::BTreeSet;

use serde_json::json;

use super::mapping::{self, Outcome};
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

    fn of(mut self, user_id: &str) -> Self {
        self.user_id = Some(user_id.to_string());
        self
    }
}

/// Whether the account's email is confirmed: an account made from an invitation link an admin
/// passed on starts unconfirmed (`users.email_confirmed`, docs/api/mail.md), and is never taken
/// over by an email a provider sends.
async fn email_confirmed(conn: &mut sqlx::AnyConnection, user_id: &str) -> ApiResult<bool> {
    let (confirmed,): (i64,) =
        sqlx::query_as("SELECT email_confirmed FROM users WHERE id = $1").bind(user_id).fetch_one(conn).await?;
    Ok(confirmed != 0)
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

/// The account a provider's person signs in to.
pub struct Linked {
    pub user: SessionUser,
    pub created: bool,
    /// The break-glass admin: never changed by a group mapping.
    pub break_glass: bool,
}

/// Finds or makes the account of `person` at `provider` (whose issuer is `issuer`) and records the
/// identity with this sign-in's groups, inside `conn` (a transaction). A refusal changes nothing:
/// the caller rolls back.
pub async fn account(
    conn: &mut sqlx::AnyConnection,
    state: &AppState,
    info: &RequestInfo,
    provider: &ProviderRow,
    issuer: &str,
    person: &Person,
    now: i64,
) -> ApiResult<Result<Linked, Refusal>> {
    let break_glass = super::local_policy(state).await?.break_glass;
    let linked: Option<(String, String)> =
        sqlx::query_as("SELECT user_id, issuer FROM sso_identities WHERE provider_id = $1 AND subject = $2")
            .bind(&provider.id)
            .bind(&person.subject)
            .fetch_optional(&mut *conn)
            .await?;
    let mut created = false;
    let account: Account = match linked {
        // A link made with another issuer is not this person: subjects are only unique per issuer.
        Some((user_id, linked_issuer)) if linked_issuer != issuer => {
            return Ok(Err(Refusal::new(
                "failed",
                "sso.identity_issuer_mismatch",
                "the identity was linked through another issuer",
            )
            .of(&user_id)));
        }
        Some((user_id, _)) => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!("{ACCOUNT_COLUMNS} WHERE id = $1")))
                .bind(&user_id)
                .fetch_one(&mut *conn)
                .await?
        }
        None => {
            let Some(email) = person.email.clone() else {
                return Ok(Err(Refusal::new("failed", "sso.email_missing", "the provider sent no usable email")));
            };
            // The form typed-in addresses keep; accounts are found in any form of the address
            // (`routes::email_key`), whichever form they were made with.
            let as_typed = person.email_as_typed.clone().unwrap_or_else(|| email.clone());
            let ids = crate::routes::accounts_with_email(&mut *conn, &email).await?;
            let mut found: Vec<Account> = Vec::with_capacity(ids.len());
            for id in &ids {
                found.push(
                    sqlx::query_as(sqlx::AssertSqlSafe(format!("{ACCOUNT_COLUMNS} WHERE id = $1")))
                        .bind(id)
                        .fetch_one(&mut *conn)
                        .await?,
                );
            }
            // Two accounts made with two forms of one address before they were compared as one.
            if found.len() > 1 {
                return Ok(Err(Refusal::new(
                    "email_taken",
                    "sso.email_ambiguous",
                    "two accounts have this address in different forms",
                )));
            }
            let existing = found.pop();
            match existing {
                // Server admins and the break-glass admin are linked only on purpose, never by
                // an email a provider sends.
                Some(a) if a.is_server_admin != 0 || break_glass.as_deref() == Some(a.id.as_str()) => {
                    return Ok(Err(Refusal::new(
                        "email_taken",
                        "sso.email_link_admin",
                        "a server admin's account is never linked by email",
                    )
                    .of(&a.id)));
                }
                Some(a) => {
                    if !person.email_verified || !email_confirmed(&mut *conn, &a.id).await? {
                        return Ok(Err(Refusal::new(
                            "email_taken",
                            "sso.email_unverified",
                            "an account has this email, but the provider or the account did not confirm it",
                        )
                        .of(&a.id)));
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
                    // Confirmed only when the provider verified the address (`email_verified` of
                    // the `email` claim, or its `trustEmail` switch): otherwise the account cannot
                    // be added to organizations by it or linked by another provider until its
                    // owner confirms it by mail.
                    sqlx::query(
                        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, \
                         email_confirmed) VALUES ($1, $2, $3, NULL, 0, 0, $4, $5)",
                    )
                    // Kept in the form typed-in addresses have (`routes::normalize_email`), so an
                    // invitation to the same address names this account.
                    .bind(&id)
                    .bind(&as_typed)
                    .bind(&name)
                    .bind(now)
                    .bind(i64::from(person.email_verified))
                    .execute(&mut *conn)
                    .await?;
                    created = true;
                    Account { id, email: as_typed.clone(), name, is_server_admin: 0, disabled: 0 }
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
        return Ok(Err(Refusal::new("disabled", "sso.account_disabled", "the account is disabled").of(&account.id)));
    }
    // A mapping an earlier sign-in kept for its second step belongs to that sign-in only.
    sqlx::query("DELETE FROM sso_pending_mappings WHERE user_id = $1").bind(&account.id).execute(&mut *conn).await?;
    sqlx::query(
        "INSERT INTO sso_identities (provider_id, subject, issuer, user_id, username, created_at, last_sign_in_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider_id, subject) DO UPDATE SET \
         username = excluded.username, last_sign_in_at = excluded.last_sign_in_at",
    )
    .bind(&provider.id)
    .bind(&person.subject)
    .bind(issuer)
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
    if created {
        let event = crate::audit::AuditEvent {
            org_id: None,
            actor_user_id: Some(&account.id),
            actor_address: Some(info.client_ip.to_string()),
            action: "auth.sso_account_created",
            resource_type: Some("user"),
            resource_id: Some(&account.id),
            summary: json!({ "provider": provider.slug }),
            at_ms: now,
        };
        crate::audit::record(conn, &event).await?;
    }
    let is_break_glass = break_glass.as_deref() == Some(account.id.as_str());
    let user = SessionUser {
        id: account.id,
        email: account.email,
        name: account.name,
        is_server_admin: account.is_server_admin,
    };
    Ok(Ok(Linked { user, created, break_glass: is_break_glass }))
}

/// What the group mapping makes of `groups` for `linked`, without changing anything. `None` for
/// the break-glass admin, whom no mapping changes.
pub async fn decide(
    conn: &mut sqlx::AnyConnection,
    state: &AppState,
    provider_id: &str,
    linked: &Linked,
    groups: &[String],
) -> ApiResult<Option<Outcome>> {
    if linked.break_glass {
        return Ok(None);
    }
    let rules = mapping::rules(&mut *conn, provider_id).await?;
    Ok(Some(mapping::resolve(&rules, groups, &super::unmapped(state).await?)))
}

/// Applies `outcome` (a refused one takes away what the provider decided and gives nothing) and
/// records the changes; answers the organizations whose rights changed. `by` is the admin whose
/// change caused it (a changed issuer), else the person's own sign-in.
pub async fn apply(
    conn: &mut sqlx::AnyConnection,
    info: &RequestInfo,
    provider: (&str, &str),
    user_id: &str,
    outcome: &Outcome,
    by: Option<&str>,
    now: i64,
) -> ApiResult<BTreeSet<String>> {
    let effective;
    let outcome = if outcome.refused {
        effective = Outcome { refused: true, orgs: Vec::new() };
        &effective
    } else {
        outcome
    };
    let (changes, touched) = mapping::apply(&mut *conn, provider.0, user_id, outcome, now).await?;
    if !changes.is_empty() {
        let mut summary = json!({ "provider": provider.1, "changes": changes });
        if by.is_some() {
            summary["cause"] = json!("issuer_changed");
        }
        let event = crate::audit::AuditEvent {
            org_id: None,
            actor_user_id: Some(by.unwrap_or(user_id)),
            actor_address: Some(info.client_ip.to_string()),
            action: "sso.memberships_changed",
            resource_type: Some("user"),
            resource_id: Some(user_id),
            summary,
            at_ms: now,
        };
        crate::audit::record(conn, &event).await?;
    }
    Ok(touched)
}

/// Keeps the mapping of a sign-in through `provider_id` for after Kalzit's second factor.
pub async fn defer(conn: &mut sqlx::AnyConnection, user_id: &str, provider_id: &str, now: i64) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO sso_pending_mappings (user_id, provider_id, created_at) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id) DO UPDATE SET provider_id = excluded.provider_id, created_at = excluded.created_at",
    )
    .bind(user_id)
    .bind(provider_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}

/// After a completed second step: applies the mapping a sign-in through a provider kept for it,
/// from the groups of that sign-in, inside the transaction that opens the session. Answers the
/// organizations whose rights changed (empty after a password sign-in).
pub async fn apply_deferred(
    conn: &mut sqlx::AnyConnection,
    state: &AppState,
    info: &RequestInfo,
    user_id: &str,
    now: i64,
) -> ApiResult<BTreeSet<String>> {
    let pending: Option<(String,)> = sqlx::query_as("SELECT provider_id FROM sso_pending_mappings WHERE user_id = $1")
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((provider_id,)) = pending else { return Ok(BTreeSet::new()) };
    sqlx::query("DELETE FROM sso_pending_mappings WHERE user_id = $1").bind(user_id).execute(&mut *conn).await?;
    // A provider paused meanwhile decides nothing any more.
    let Some(provider) = super::store::by_id(&mut *conn, &provider_id).await?.filter(|p| p.enabled != 0) else {
        return Ok(BTreeSet::new());
    };
    let identity: Option<(String,)> =
        sqlx::query_as("SELECT subject FROM sso_identities WHERE provider_id = $1 AND user_id = $2")
            .bind(&provider_id)
            .bind(user_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((subject,)) = identity else { return Ok(BTreeSet::new()) };
    let groups: Vec<(String,)> =
        sqlx::query_as("SELECT group_name FROM sso_identity_groups WHERE provider_id = $1 AND subject = $2")
            .bind(&provider_id)
            .bind(&subject)
            .fetch_all(&mut *conn)
            .await?;
    let groups: Vec<String> = groups.into_iter().map(|(g,)| g).collect();
    if super::local_policy(state).await?.break_glass.as_deref() == Some(user_id) {
        return Ok(BTreeSet::new());
    }
    let rules = mapping::rules(&mut *conn, &provider_id).await?;
    let outcome = mapping::resolve(&rules, &groups, &super::unmapped(state).await?);
    apply(conn, info, (&provider.id, &provider.slug), user_id, &outcome, None, now).await
}
