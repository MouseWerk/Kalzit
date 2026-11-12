//! Contact points: their settings as stored, the webhook signing secrets in the encrypted secret
//! store, and the shortened forms people without `alerts:contacts` see (docs/api/alerting.md,
//! "Contact points").

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{ApiError, ApiResult};
use crate::secrets::{Blob, Keyring};

pub const KINDS: &[&str] = &["mail", "webhook", "slack", "teams"];
/// The kinds whose URL is the secret: Slack's and Teams' incoming webhooks.
pub const CHAT_KINDS: &[&str] = &["slack", "teams"];
/// The secret field of a Slack or Teams URL.
pub const URL_FIELD: &str = "url";
pub const LANGUAGES: &[&str] = &["de", "en"];
pub const MAX_RECIPIENTS: usize = 20;
/// The secret field, and the one kept for a day after a rotation.
pub const SECRET_FIELD: &str = "current";
pub const PREVIOUS_SECRET_FIELD: &str = "previous";
/// How long the previous secret signs too after a rotation.
pub const PREVIOUS_VALID_MS: i64 = 24 * 3_600_000;
const SECRET_BYTES: usize = 32;

/// The owner of a contact point's secrets in the associated data (`secrets`).
pub fn secret_owner(contact_point_id: &str) -> String {
    format!("alert-contact-point:{contact_point_id}")
}

/// What a contact point stores besides its secret: recipients (mail) or the URL (webhook), and
/// the language of the messages. Slack and Teams keep their URL as the secret and here only its
/// host and last four characters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipients: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub language: String,
    /// Slack and Teams: the URL's host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Slack and Teams: the URL's last four characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url_end: Option<String>,
}

/// The last four characters of a URL, all people see of a Slack or Teams URL after saving.
pub fn url_end(url: &str) -> String {
    let chars: Vec<char> = url.chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

/// The incoming webhook URL of a Slack or Teams contact point.
pub async fn chat_url(db: &sqlx::AnyPool, keyring: &Keyring, contact_point_id: &str) -> ApiResult<Zeroizing<String>> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT key_id, nonce, ciphertext FROM alert_contact_point_secrets WHERE contact_point_id = $1 AND field = $2",
    )
    .bind(contact_point_id)
    .bind(URL_FIELD)
    .fetch_optional(db)
    .await?;
    let Some((key_id, nonce, ciphertext)) = row else {
        return Err(ApiError::internal("alert contact point", format!("{contact_point_id} has no url")));
    };
    keyring
        .decrypt(&secret_owner(contact_point_id), URL_FIELD, &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("decrypting a contact point's url", e))
}

/// A new webhook secret: 32 random bytes as 64 hex digits.
pub fn new_secret() -> Zeroizing<String> {
    Zeroizing::new(hex::encode(rand::random::<[u8; SECRET_BYTES]>()))
}

/// Stores (replacing) one secret field of a contact point inside the caller's transaction.
pub async fn store_secret(
    conn: &mut sqlx::AnyConnection,
    keyring: &Keyring,
    contact_point_id: &str,
    field: &str,
    plain: &str,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM alert_contact_point_secrets WHERE contact_point_id = $1 AND field = $2")
        .bind(contact_point_id)
        .bind(field)
        .execute(&mut *conn)
        .await?;
    let blob = keyring.encrypt(&secret_owner(contact_point_id), field, plain);
    sqlx::query(
        "INSERT INTO alert_contact_point_secrets (contact_point_id, field, key_id, nonce, ciphertext) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(contact_point_id)
    .bind(field)
    .bind(&blob.key_id)
    .bind(&blob.nonce)
    .bind(&blob.ciphertext)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The secrets a webhook delivery signs with at `now`: the current one, and the previous one
/// while it is still valid. Each gives one `v1` value in `Kalzit-Signature`.
pub async fn signing_secrets(
    db: &sqlx::AnyPool,
    keyring: &Keyring,
    contact_point_id: &str,
    now: i64,
) -> ApiResult<Vec<Zeroizing<String>>> {
    let until: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT previous_secret_until FROM alert_contact_points WHERE id = $1")
            .bind(contact_point_id)
            .fetch_optional(db)
            .await?;
    let previous_valid = until.and_then(|(u,)| u).is_some_and(|u| u > now);
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT field, key_id, nonce, ciphertext FROM alert_contact_point_secrets WHERE contact_point_id = $1 \
         ORDER BY field",
    )
    .bind(contact_point_id)
    .fetch_all(db)
    .await?;
    let owner = secret_owner(contact_point_id);
    let mut out = Vec::new();
    for field in [SECRET_FIELD, PREVIOUS_SECRET_FIELD] {
        if field == PREVIOUS_SECRET_FIELD && !previous_valid {
            continue;
        }
        if let Some((_, key_id, nonce, ciphertext)) = rows.iter().find(|r| r.0 == field) {
            let blob = Blob { key_id: key_id.clone(), nonce: nonce.clone(), ciphertext: ciphertext.clone() };
            let plain = keyring
                .decrypt(&owner, field, &blob)
                .map_err(|e| ApiError::internal("decrypting a contact point's webhook secret", e))?;
            out.push(plain);
        }
    }
    Ok(out)
}

/// An address as people without `alerts:contacts` and the audit log see it: the first character
/// of the local part and the domain (`j…@mousewerk.test`).
pub fn shorten_address(address: &str) -> String {
    match address.rsplit_once('@') {
        Some((local, domain)) => {
            let first: String = local.chars().take(1).collect();
            format!("{first}…@{domain}")
        }
        None => "…".to_string(),
    }
}

/// The host of a webhook URL, all people without `alerts:contacts` see of it.
pub fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortened_forms_hide_the_details() {
        assert_eq!(shorten_address("j.berger@mousewerk.test"), "j…@mousewerk.test");
        assert_eq!(shorten_address("kaputt"), "…");
        assert_eq!(
            host_of("https://hooks.lager.mousewerk.test/kalzit?token=abc").as_deref(),
            Some("hooks.lager.mousewerk.test")
        );
    }

    #[test]
    fn secrets_are_32_random_bytes() {
        let (a, b) = (new_secret(), new_secret());
        assert_eq!(a.len(), 64);
        assert_ne!(*a, *b);
    }
}
