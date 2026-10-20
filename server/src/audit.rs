//! The audit log. Every change of rights, settings, data sources, dashboards and every sign-in is
//! recorded with `record`, inside the transaction of the change, so a change without its audit
//! entry cannot be committed.

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

pub async fn record(conn: &mut sqlx::AnyConnection, event: &AuditEvent<'_>) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events (id, org_id, actor_user_id, actor_address, action, resource_type, resource_id, \
         summary, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(event.org_id)
    .bind(event.actor_user_id)
    .bind(event.actor_address.as_deref())
    .bind(event.action)
    .bind(event.resource_type)
    .bind(event.resource_id)
    .bind(event.summary.to_string())
    .bind(event.at_ms)
    .execute(conn)
    .await?;
    Ok(())
}
