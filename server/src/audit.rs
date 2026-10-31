//! The audit log. Every change of rights, settings, data sources, dashboards and every sign-in is
//! recorded with `record`, inside the transaction of the change, so a change without its audit
//! entry cannot be committed.

use std::future::Future;

use serde_json::Value;

/// One entry. `action` is `<area>.<verb>` (`setup.completed`, `auth.signed_in`, `team.created`).
/// `summary` must never contain secrets (passwords, tokens, connection strings with credentials).
pub struct AuditEvent<'a> {
    pub org_id: Option<&'a str>,
    pub actor_user_id: Option<&'a str>,
    pub actor_address: Option<String>,
    pub action: &'a str,
    pub resource_type: Option<&'a str>,
    pub resource_id: Option<&'a str>,
    pub summary: Value,
    pub at_ms: i64,
}

/// The API token a request was made with (`auth::api_token`): its id and visible prefix, never the
/// token itself.
#[derive(Clone, Debug)]
pub struct ActingToken {
    pub id: String,
    pub prefix: String,
}

tokio::task_local! {
    static TOKEN: ActingToken;
}

/// Runs a request made with an API token: every entry `record` writes meanwhile names the token
/// next to its service account, whichever handler writes it.
pub async fn with_token<F: Future>(token: ActingToken, f: F) -> F::Output {
    TOKEN.scope(token, f).await
}

/// The token of the request being handled, if it was made with one.
pub fn acting_token() -> Option<ActingToken> {
    TOKEN.try_with(Clone::clone).ok()
}

pub async fn record(conn: &mut sqlx::AnyConnection, event: &AuditEvent<'_>) -> Result<(), sqlx::Error> {
    record_with_id(conn, &uuid::Uuid::now_v7().to_string(), event).await
}

/// `record` with the entry's id chosen by the caller, for an entry a later one names (the closing
/// entry of a rate-limited address's refused API tokens, `auth::api_token`).
pub async fn record_with_id(
    conn: &mut sqlx::AnyConnection,
    id: &str,
    event: &AuditEvent<'_>,
) -> Result<(), sqlx::Error> {
    let token = acting_token();
    sqlx::query(
        "INSERT INTO audit_events (id, org_id, actor_user_id, actor_address, action, resource_type, resource_id, \
         summary, created_at, actor_token_id, actor_token_prefix) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
    )
    .bind(id)
    .bind(event.org_id)
    .bind(event.actor_user_id)
    .bind(event.actor_address.as_deref())
    .bind(event.action)
    .bind(event.resource_type)
    .bind(event.resource_id)
    .bind(event.summary.to_string())
    .bind(event.at_ms)
    .bind(token.as_ref().map(|t| t.id.clone()))
    .bind(token.as_ref().map(|t| t.prefix.clone()))
    .execute(conn)
    .await?;
    Ok(())
}
