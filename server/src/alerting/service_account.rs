//! The alerting identity of an organization: a service account of the kind `alerting` that the
//! scheduled evaluation runs as, never as the person who wrote a rule (docs/PLAN.md section 13).
//!
//! It is fixed: it has no membership and so no role, no API tokens (the token routes need a
//! membership), no password and no sign-in, and the service account routes neither list nor
//! change nor delete it. Its rights are not stored anywhere a person could edit: `context` gives
//! it `datasources:query` and nothing else, and `may_query` limits that to the sources opted in
//! to alerting. It is made on first use, once per organization, and goes with the organization.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::auth::SessionUser;
use crate::authz::{OrgCtx, Permission};
use crate::error::{ApiError, ApiResult};

pub const KIND: &str = "alerting";
/// The account's name. Names people give service accounts are lowercase, so this one cannot be
/// taken by them.
pub const NAME: &str = "Alerting";
/// The fixed rights.
pub const PERMISSIONS: [Permission; 1] = [Permission::DatasourcesQuery];

#[derive(Clone, Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: String,
}

async fn find(conn: &mut sqlx::AnyConnection, org_id: &str) -> ApiResult<Option<Identity>> {
    Ok(sqlx::query_as("SELECT id, name FROM service_accounts WHERE org_id = $1 AND kind = $2")
        .bind(org_id)
        .bind(KIND)
        .fetch_optional(&mut *conn)
        .await?)
}

/// The organization's alerting identity, made if it has none yet. Call it inside a transaction
/// that already holds the organization's lock (`authz::lock_org`) or on a pooled connection; two
/// concurrent first uses on PostgreSQL are kept to one account by that lock.
pub async fn ensure(conn: &mut sqlx::AnyConnection, org_id: &str, now: i64) -> ApiResult<Identity> {
    if let Some(found) = find(conn, org_id).await? {
        return Ok(found);
    }
    let id = crate::routes::new_id();
    // No password, never signs in; the email column needs a unique value no mail server accepts.
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, service_account, \
         email_confirmed) VALUES ($1, $2, $3, NULL, 0, 0, $4, 1, 0)",
    )
    .bind(&id)
    .bind(format!("{id}@alerting.invalid"))
    .bind(NAME)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "INSERT INTO service_accounts (id, org_id, name, description, disabled, created_by, created_at, sort_name, kind) \
         VALUES ($1, $2, $3, $4, 0, NULL, $5, $6, $7)",
    )
    .bind(&id)
    .bind(org_id)
    .bind(NAME)
    .bind("Evaluates the alert rules of this organization.")
    .bind(now)
    .bind(crate::collation::key(NAME))
    .bind(KIND)
    .execute(&mut *conn)
    .await?;
    Ok(Identity { id, name: NAME.to_string() })
}

/// The organization's alerting identity, if it was made (at the first opt-in of a data source
/// or the first rule). Reading never makes one.
pub async fn existing(db: &sqlx::AnyPool, org_id: &str) -> ApiResult<Option<Identity>> {
    let mut conn = db.acquire().await?;
    find(&mut conn, org_id).await
}

/// The caller context one evaluation runs with: the alerting identity with its fixed rights,
/// for one data source. The source's opt-in is checked here, so no evaluation can query a
/// source that is not opted in (`alerts.datasource_not_opted_in`; the rule goes to the error
/// state).
pub async fn context_for_source(
    db: &sqlx::AnyPool,
    identity: &Identity,
    org_id: &str,
    datasource_id: &str,
    now: i64,
) -> ApiResult<OrgCtx> {
    if !may_query(db, org_id, datasource_id).await? {
        return Err(not_opted_in());
    }
    Ok(context(identity, org_id, now))
}

fn context(identity: &Identity, org_id: &str, now: i64) -> OrgCtx {
    OrgCtx {
        user: SessionUser {
            id: identity.id.clone(),
            email: format!("{}@alerting.invalid", identity.id),
            name: identity.name.clone(),
            is_server_admin: 0,
        },
        org_id: org_id.to_string(),
        role: KIND.to_string(),
        permissions: PERMISSIONS.into_iter().collect::<BTreeSet<_>>(),
        at_ms: now,
    }
}

/// Whether the alerting identity may query the data source: it is in the organization, not in
/// the trash, and opted in to alerting.
pub async fn may_query<'e, E>(db: E, org_id: &str, datasource_id: &str) -> ApiResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT alerting_enabled FROM datasources WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL")
            .bind(datasource_id)
            .bind(org_id)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some_and(|(on,)| on != 0))
}

/// The refusal for a source that is not opted in, for the rule routes and the evaluation.
pub fn not_opted_in() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::CONFLICT,
        "conflict",
        "the data source is not opted in to alerting; whoever may edit it can turn alerting on",
    )
    .with_field("datasourceId")
    .because("alerts.datasource_not_opted_in")
}
