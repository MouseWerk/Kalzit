//! Stored AI configuration: providers (server-wide, or an organization's override) with their
//! keys encrypted like data source secrets, and the data sources whose results AI may read.

use std::sync::Arc;

use zeroize::Zeroizing;

use crate::secrets::{Blob, Keyring, LoadError};

/// The field of a provider's API key in `ai_provider_secrets`.
pub const KEY_FIELD: &str = "api_key";

/// The owner a provider's secrets are bound to in the associated data: never a data source id,
/// which is a bare UUID.
pub fn secret_owner(provider_id: &str) -> String {
    format!("ai-provider:{provider_id}")
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ProviderRow {
    pub id: String,
    pub org_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub base_url: String,
    pub model: String,
    pub is_default: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub updated_by: Option<String>,
    pub token_limit_field: Option<String>,
    pub last_test_ok: Option<i64>,
    pub last_test_reason: Option<String>,
    pub last_tested_at: Option<i64>,
}

impl ProviderRow {
    /// Its last connection test passed, and nothing that test depends on changed since.
    pub fn tested_ok(&self) -> bool {
        self.last_test_ok == Some(1)
    }
}

const COLUMNS: &str = "id, org_id, name, kind, base_url, model, is_default, created_at, updated_at, updated_by, \
                       token_limit_field, last_test_ok, last_test_reason, last_tested_at";

/// Forgets the last connection test (its address, model or key changed).
pub async fn clear_test(conn: &mut sqlx::AnyConnection, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE ai_providers SET last_test_ok = NULL, last_test_reason = NULL, last_tested_at = NULL WHERE id = $1",
    )
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}

/// Forgets every acknowledgement of the notice for a provider (its address changed, so the
/// notice would name another destination).
pub async fn forget_notices(conn: &mut sqlx::AnyConnection, provider_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM ai_notice_acks WHERE provider_id = $1").bind(provider_id).execute(conn).await?;
    Ok(())
}

/// Keeps the outcome of a connection test on the provider.
pub async fn record_test(
    conn: &mut sqlx::AnyConnection,
    id: &str,
    ok: bool,
    reason: Option<&str>,
    now: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE ai_providers SET last_test_ok = $1, last_test_reason = $2, last_tested_at = $3 WHERE id = $4")
        .bind(i64::from(ok))
        .bind(reason)
        .bind(now)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Whether the user acknowledged the first-use notice for this provider.
pub async fn notice_acknowledged(db: &sqlx::AnyPool, user_id: &str, provider_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT acknowledged_at FROM ai_notice_acks WHERE user_id = $1 AND provider_id = $2")
            .bind(user_id)
            .bind(provider_id)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// Records the acknowledgement; returns false when it was already there.
pub async fn acknowledge_notice(
    conn: &mut sqlx::AnyConnection,
    user_id: &str,
    provider_id: &str,
    now: i64,
) -> Result<bool, sqlx::Error> {
    let done = sqlx::query(
        "INSERT INTO ai_notice_acks (user_id, provider_id, acknowledged_at) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, provider_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(provider_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// The providers of one scope (`None`: server-wide), the default first, then by name.
pub async fn list<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: Option<&str>,
) -> Result<Vec<ProviderRow>, sqlx::Error> {
    match org_id {
        None => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM ai_providers WHERE org_id IS NULL ORDER BY is_default DESC, name, id"
            )))
            .fetch_all(db)
            .await
        }
        Some(org) => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {COLUMNS} FROM ai_providers WHERE org_id = $1 ORDER BY is_default DESC, name, id"
            )))
            .bind(org)
            .fetch_all(db)
            .await
        }
    }
}

/// One provider of the scope, or `None` (another scope's provider is not found either).
pub async fn find<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    org_id: Option<&str>,
    id: &str,
) -> Result<Option<ProviderRow>, sqlx::Error> {
    let row: Option<ProviderRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {COLUMNS} FROM ai_providers WHERE id = $1")))
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.filter(|r| r.org_id.as_deref() == org_id))
}

/// The provider in effect for members of `org_id`: the organization's default when
/// organizations may have their own (`allow_org`), else the server's default.
pub async fn in_effect(db: &sqlx::AnyPool, org_id: &str, allow_org: bool) -> Result<Option<ProviderRow>, sqlx::Error> {
    if allow_org && let Some(own) = list(db, Some(org_id)).await?.into_iter().find(|p| p.is_default != 0) {
        return Ok(Some(own));
    }
    Ok(list(db, None).await?.into_iter().find(|p| p.is_default != 0))
}

pub async fn key_set<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(db: E, id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT field FROM ai_provider_secrets WHERE provider_id = $1 AND field = $2")
            .bind(id)
            .bind(KEY_FIELD)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// Stores (`Some`) or removes (`None`) a provider's key.
pub async fn set_key(
    conn: &mut sqlx::AnyConnection,
    keyring: &Keyring,
    id: &str,
    key: Option<&str>,
) -> Result<(), sqlx::Error> {
    match key {
        None => {
            sqlx::query("DELETE FROM ai_provider_secrets WHERE provider_id = $1 AND field = $2")
                .bind(id)
                .bind(KEY_FIELD)
                .execute(conn)
                .await?;
        }
        Some(plain) => {
            let blob = keyring.encrypt(&secret_owner(id), KEY_FIELD, plain);
            sqlx::query(
                "INSERT INTO ai_provider_secrets (provider_id, field, key_id, nonce, ciphertext) \
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (provider_id, field) DO UPDATE SET \
                 key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext",
            )
            .bind(id)
            .bind(KEY_FIELD)
            .bind(&blob.key_id)
            .bind(&blob.nonce)
            .bind(&blob.ciphertext)
            .execute(conn)
            .await?;
        }
    }
    Ok(())
}

/// The decrypted key of a provider, if it has one. Wiped when the last holder drops it.
pub async fn load_key(
    db: &sqlx::AnyPool,
    keyring: &Keyring,
    id: &str,
) -> Result<Option<Arc<Zeroizing<String>>>, LoadError> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT key_id, nonce, ciphertext FROM ai_provider_secrets WHERE provider_id = $1 AND field = $2",
    )
    .bind(id)
    .bind(KEY_FIELD)
    .fetch_optional(db)
    .await?;
    let Some((key_id, nonce, ciphertext)) = row else { return Ok(None) };
    let plain = keyring
        .decrypt(&secret_owner(id), KEY_FIELD, &Blob { key_id, nonce, ciphertext })
        .map_err(|error| LoadError::Secret { field: KEY_FIELD.into(), error })?;
    Ok(Some(Arc::new(plain)))
}

/// What AI may read of one data source. Without a stored row: closed, nothing excluded.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DatasourceAccess {
    /// The opt-in: schema and results may go to the provider.
    pub readable: bool,
    /// Field names or paths whose values AI never receives (`ai::redact`).
    pub excluded_fields: Vec<String>,
}

pub async fn datasource_access<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    datasource_id: &str,
) -> Result<DatasourceAccess, sqlx::Error> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT readable, excluded_fields FROM ai_datasource_access WHERE datasource_id = $1")
            .bind(datasource_id)
            .fetch_optional(db)
            .await?;
    Ok(match row {
        None => DatasourceAccess::default(),
        // A list that does not parse excludes nothing it could name, so it closes the source.
        Some((readable, fields)) => match serde_json::from_str::<Vec<String>>(&fields) {
            Ok(excluded_fields) => DatasourceAccess { readable: readable != 0, excluded_fields },
            Err(_) => DatasourceAccess { readable: false, excluded_fields: Vec::new() },
        },
    })
}

/// Whether AI may read this data source (its schema and results).
pub async fn datasource_readable<'e, E: sqlx::Executor<'e, Database = sqlx::Any>>(
    db: E,
    datasource_id: &str,
) -> Result<bool, sqlx::Error> {
    Ok(datasource_access(db, datasource_id).await?.readable)
}

/// The data sources of `org_id` AI may read, in use or in the trash.
pub async fn readable_datasources(db: &sqlx::AnyPool, org_id: &str) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT a.datasource_id FROM ai_datasource_access a JOIN datasources d ON d.id = a.datasource_id \
         WHERE d.org_id = $1 AND a.readable = 1 ORDER BY a.datasource_id",
    )
    .bind(org_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Stores what AI may read of a data source.
pub async fn set_datasource_access(
    conn: &mut sqlx::AnyConnection,
    datasource_id: &str,
    access: &DatasourceAccess,
    user_id: &str,
    now: i64,
) -> Result<(), sqlx::Error> {
    let fields = serde_json::to_string(&access.excluded_fields).expect("a list of texts serializes");
    sqlx::query(
        "INSERT INTO ai_datasource_access (datasource_id, readable, excluded_fields, updated_by, updated_at) \
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (datasource_id) DO UPDATE SET readable = excluded.readable, \
         excluded_fields = excluded.excluded_fields, updated_by = excluded.updated_by, \
         updated_at = excluded.updated_at",
    )
    .bind(datasource_id)
    .bind(i64::from(access.readable))
    .bind(fields)
    .bind(user_id)
    .bind(now)
    .execute(conn)
    .await?;
    Ok(())
}
