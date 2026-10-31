//! Providers as stored: their rows and their secrets, encrypted with the secrets key and bound to
//! `sso-provider:<id>` (`secrets::Keyring`), so a blob copied to another provider does not
//! decrypt.

use std::sync::Arc;

use zeroize::Zeroizing;

use super::oidc::OidcConfig;
use crate::error::{ApiError, ApiResult};
use crate::secrets::{Blob, Keyring};

/// The field of an OIDC client secret.
pub const CLIENT_SECRET: &str = "client_secret";

/// The owner a provider's secrets are bound to.
pub fn secret_owner(provider_id: &str) -> String {
    format!("sso-provider:{provider_id}")
}

/// The owner the secret of a test sign-in's form is bound to.
pub fn test_owner(sign_in_id: &str) -> String {
    format!("sso-test:{sign_in_id}")
}

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct ProviderRow {
    pub id: String,
    pub slug: String,
    pub kind: String,
    pub name: String,
    pub position: i64,
    pub enabled: i64,
    pub config: String,
    pub create_accounts: i64,
    pub trust_provider_mfa: i64,
    pub checked_at: Option<i64>,
    pub last_sign_in_at: Option<i64>,
    pub version: i64,
}

pub const PROVIDER_COLUMNS: &str = "SELECT id, slug, kind, name, position, enabled, config, create_accounts, \
     trust_provider_mfa, checked_at, last_sign_in_at, version FROM sso_providers";

impl ProviderRow {
    pub fn oidc(&self) -> ApiResult<OidcConfig> {
        serde_json::from_str(&self.config)
            .map_err(|e| ApiError::internal("sso", format!("the settings of provider {} cannot be read: {e}", self.id)))
    }
}

pub async fn all<'c, E>(db: E) -> ApiResult<Vec<ProviderRow>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{PROVIDER_COLUMNS} ORDER BY position, created_at")))
        .fetch_all(db)
        .await?)
}

pub async fn by_id<'c, E>(db: E, id: &str) -> ApiResult<Option<ProviderRow>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{PROVIDER_COLUMNS} WHERE id = $1")))
        .bind(id)
        .fetch_optional(db)
        .await?)
}

pub async fn by_slug<'c, E>(db: E, slug: &str) -> ApiResult<Option<ProviderRow>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{PROVIDER_COLUMNS} WHERE slug = $1")))
        .bind(slug)
        .fetch_optional(db)
        .await?)
}

/// Stores a provider's secret, replacing the one it had.
pub async fn set_secret(
    conn: &mut sqlx::AnyConnection,
    keyring: &Keyring,
    provider_id: &str,
    field: &str,
    plain: &str,
) -> ApiResult<()> {
    let blob = keyring.encrypt(&secret_owner(provider_id), field, plain);
    sqlx::query(
        "INSERT INTO sso_provider_secrets (provider_id, field, key_id, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (provider_id, field) DO UPDATE SET key_id = excluded.key_id, nonce = excluded.nonce, \
         ciphertext = excluded.ciphertext",
    )
    .bind(provider_id)
    .bind(field)
    .bind(&blob.key_id)
    .bind(&blob.nonce)
    .bind(&blob.ciphertext)
    .execute(conn)
    .await?;
    Ok(())
}

/// A provider's secret, decrypted; wiped when the last holder drops it.
pub async fn secret<'c, E>(
    db: E,
    keyring: &Keyring,
    provider_id: &str,
    field: &str,
) -> ApiResult<Option<Arc<Zeroizing<String>>>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT key_id, nonce, ciphertext FROM sso_provider_secrets WHERE provider_id = $1 AND field = $2",
    )
    .bind(provider_id)
    .bind(field)
    .fetch_optional(db)
    .await?;
    let Some((key_id, nonce, ciphertext)) = row else { return Ok(None) };
    let plain = keyring
        .decrypt(&secret_owner(provider_id), field, &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("sso", format!("the secret of provider {provider_id} cannot be read: {e}")))?;
    Ok(Some(Arc::new(plain)))
}
