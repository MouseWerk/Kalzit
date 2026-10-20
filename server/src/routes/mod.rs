pub mod auth;
pub mod health;
pub mod setup;

use serde::Serialize;
use sqlx::AnyPool;

use crate::auth::SessionUser;
use crate::error::{ApiError, ApiResult};

const MAX_NAME_CHARS: usize = 100;
/// RFC 5321 limit for a forward path.
const MAX_EMAIL_CHARS: usize = 254;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub id: String,
    pub email: String,
    pub name: String,
    pub is_server_admin: bool,
    pub orgs: Vec<OrgMembership>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct OrgMembership {
    pub id: String,
    pub name: String,
    pub role: String,
}

pub async fn me(db: &AnyPool, user: SessionUser) -> ApiResult<Me> {
    let orgs: Vec<OrgMembership> = sqlx::query_as(
        "SELECT o.id, o.name, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id \
         WHERE m.user_id = $1 ORDER BY o.name",
    )
    .bind(&user.id)
    .fetch_all(db)
    .await?;
    Ok(Me { id: user.id, email: user.email, name: user.name, is_server_admin: user.is_server_admin != 0, orgs })
}

/// Trims and lowercases an email address and checks its rough shape. Delivery is what proves an
/// address; this only rejects obvious typos.
pub fn normalize_email(raw: &str) -> ApiResult<String> {
    let email = raw.trim().to_lowercase();
    let valid = email.chars().count() <= MAX_EMAIL_CHARS
        && !email.chars().any(char::is_whitespace)
        && matches!(email.split_once('@'), Some((local, domain)) if !local.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.'));
    if valid { Ok(email) } else { Err(ApiError::validation("email is not a valid address")) }
}

pub fn clean_name(raw: &str, what: &str) -> ApiResult<String> {
    let name = raw.trim();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS {
        return Err(ApiError::validation(format!("{what} needs 1 to {MAX_NAME_CHARS} characters")));
    }
    if name.chars().any(char::is_control) {
        return Err(ApiError::validation(format!("{what} contains control characters")));
    }
    Ok(name.to_string())
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_is_normalized() {
        assert_eq!(normalize_email("  Jörg@Example.DE ").unwrap(), "jörg@example.de");
        for bad in ["", "a", "a@b", "@b.de", "a@.de", "a@b.", "a b@c.de"] {
            assert!(normalize_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(clean_name("  Müller GmbH ", "name").unwrap(), "Müller GmbH");
        assert!(clean_name("   ", "name").is_err());
        assert!(clean_name(&"x".repeat(101), "name").is_err());
        assert!(clean_name("a\u{0007}b", "name").is_err());
    }
}
