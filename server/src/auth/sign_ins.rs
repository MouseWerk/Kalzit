//! Recent sign-ins (docs/api/access.md, "Recent sign-ins"): every completed sign-in, whichever
//! way it came (password, break-glass, OpenID Connect, SAML, LDAP), is recorded in the audit log
//! as `auth.signed_in` by `record`, with its method, provider, second factor, session, address
//! and browser. `list` reads a person's sign-ins and refused attempts back from the audit log, so
//! they follow its retention (`audit.retention_days`).

use axum::http::{HeaderMap, header};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::net::RequestInfo;

/// The longest browser description kept with a sign-in, in characters.
const MAX_USER_AGENT_CHARS: usize = 256;

/// How the first step of a sign-in went: `first_step` is `password`, `directory` or `provider`
/// (`auth::second_factor::FirstStep::label`).
#[derive(Clone, Debug)]
pub struct Via {
    pub first_step: String,
    pub break_glass: bool,
    pub provider_id: Option<String>,
    /// The provider checked a second factor and Kalzit takes its word for it.
    pub provider_mfa: bool,
}

/// The browser of a request as it describes itself, without control characters and cut to a
/// sensible length; `None` without one.
pub fn user_agent(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::USER_AGENT)?.to_str().ok()?;
    let clean: String = raw.chars().filter(|c| !c.is_control()).take(MAX_USER_AGENT_CHARS).collect();
    let clean = clean.trim().to_string();
    (!clean.is_empty()).then_some(clean)
}

/// Records the completed sign-in of `user_id` into session `session_id`, inside the transaction
/// that opens the session. `second_factor` is Kalzit's own method of the second step, if any.
#[expect(clippy::too_many_arguments, reason = "the parts of one sign-in, recorded as they are")]
pub async fn record(
    tx: &mut sqlx::AnyConnection,
    info: &RequestInfo,
    headers: &HeaderMap,
    user_id: &str,
    session_id: &str,
    via: &Via,
    second_factor: Option<&str>,
    now: i64,
) -> Result<(), sqlx::Error> {
    let provider: Option<(String, String, String)> = match &via.provider_id {
        Some(id) => {
            sqlx::query_as("SELECT slug, name, kind FROM sso_providers WHERE id = $1")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?
        }
        None => None,
    };
    let method = match (&provider, via.break_glass, via.first_step.as_str()) {
        (_, true, _) => "break_glass".to_string(),
        (Some((_, _, kind)), _, _) => kind.clone(),
        (None, _, "directory") => "ldap".to_string(),
        (None, _, "provider") => "provider".to_string(),
        _ => "password".to_string(),
    };
    let mut summary = Map::new();
    summary.insert("method".into(), json!(method));
    if let Some((slug, name, _)) = &provider {
        summary.insert("provider".into(), json!(slug));
        summary.insert("providerName".into(), json!(name));
        summary.insert("providerMfa".into(), json!(via.provider_mfa));
    }
    if let Some(m) = second_factor {
        summary.insert("secondFactor".into(), json!(m));
    }
    summary.insert("sessionId".into(), json!(session_id));
    if let Some(agent) = user_agent(headers) {
        summary.insert("userAgent".into(), json!(agent));
    }
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "auth.signed_in",
        resource_type: Some("user"),
        resource_id: Some(user_id),
        summary: Value::Object(summary),
        at_ms: now,
    };
    crate::audit::record(tx, &event).await
}

/// One sign-in or refused attempt as the lists show it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub id: String,
    pub at: i64,
    /// `success` or `refused`.
    pub result: &'static str,
    /// Why an attempt was refused: `credentials`, `disabled`, `password_off`, `second_factor`, or
    /// the reason a provider's sign-in was refused (`sso.unmapped`, ...).
    pub reason: Option<String>,
    /// `password`, `break_glass`, `oidc`, `saml`, `ldap` or `provider` (a provider since removed).
    pub method: Option<String>,
    /// The provider's slug and name, as they were at the sign-in.
    pub provider: Option<String>,
    pub provider_name: Option<String>,
    /// Kalzit's second factor (`passkey`, `totp`, `recovery`), or `provider` when the provider
    /// checked one and Kalzit takes its word for it.
    pub second_factor: Option<String>,
    pub address: Option<String>,
    pub user_agent: Option<String>,
    /// The sign-in that opened the session of this request.
    pub current: bool,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    action: String,
    actor_address: Option<String>,
    resource_id: Option<String>,
    summary: String,
    created_at: i64,
}

fn text(summary: &Value, key: &str) -> Option<String> {
    summary.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The sign-ins of `user_id`, newest first, in pages of `paging`. `current_session` marks the
/// entry that opened that session.
pub async fn list(
    db: &sqlx::AnyPool,
    user_id: &str,
    paging: &crate::routes::support::Paging,
    current_session: Option<&str>,
) -> Result<crate::shapes::Page<SignIn>, sqlx::Error> {
    // Two indexed halves: the person's own entries (signed in, wrong password, wrong second
    // factor), and the refusals of a provider that had found the person, which name the provider
    // as their resource and the person as their actor.
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, action, actor_address, resource_id, summary, created_at FROM ( \
         SELECT id, action, actor_address, resource_id, summary, created_at FROM audit_events \
         WHERE org_id IS NULL AND resource_type = 'user' AND resource_id = $1 \
         AND action IN ('auth.signed_in', 'auth.sign_in_failed', 'auth.second_factor_failed') \
         AND (created_at < $2 OR (created_at = $2 AND id < $3)) \
         UNION ALL \
         SELECT id, action, actor_address, resource_id, summary, created_at FROM audit_events \
         WHERE actor_user_id = $1 AND action = 'auth.sso_failed' \
         AND (created_at < $2 OR (created_at = $2 AND id < $3)) \
         ) s ORDER BY created_at DESC, id DESC LIMIT $4",
    )
    .bind(user_id)
    .bind(paging.before_time())
    .bind(paging.before_id())
    .bind(paging.fetch_limit())
    .fetch_all(db)
    .await?;
    // Providers by id, for the refusals of a provider (their entries name only its slug).
    let providers: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, name, kind FROM sso_providers").fetch_all(db).await?;
    let items = rows.into_iter().map(|r| view(r, &providers, current_session)).collect();
    Ok(paging.page(items, |s: &SignIn| (s.at, s.id.as_str())))
}

fn view(row: Row, providers: &[(String, String, String)], current_session: Option<&str>) -> SignIn {
    let summary: Value = serde_json::from_str(&row.summary).unwrap_or(Value::Null);
    let mut out = SignIn {
        id: row.id,
        at: row.created_at,
        result: "refused",
        reason: None,
        method: text(&summary, "method"),
        provider: text(&summary, "provider"),
        provider_name: text(&summary, "providerName"),
        second_factor: None,
        address: row.actor_address,
        user_agent: text(&summary, "userAgent"),
        current: false,
    };
    match row.action.as_str() {
        "auth.signed_in" => {
            out.result = "success";
            out.second_factor = text(&summary, "secondFactor").or_else(|| {
                summary.get("providerMfa").and_then(Value::as_bool).filter(|t| *t).map(|_| "provider".into())
            });
            // Entries from before the method was recorded: a provider's slug, or a password.
            if out.method.is_none() {
                out.method = Some(if out.provider.is_some() { "provider" } else { "password" }.into());
            }
            out.current = current_session.is_some_and(|c| text(&summary, "sessionId").as_deref() == Some(c));
        }
        "auth.second_factor_failed" => {
            out.reason = Some("second_factor".into());
            out.second_factor = text(&summary, "method");
            out.method = None;
        }
        "auth.sso_failed" => {
            out.reason = text(&summary, "reason");
            let found = providers.iter().find(|(id, ..)| row.resource_id.as_deref() == Some(id.as_str()));
            out.method = Some(found.map_or("provider", |(_, _, kind)| kind.as_str()).to_string());
            out.provider_name = found.map(|(_, name, _)| name.clone());
        }
        _ => {
            out.reason = Some(text(&summary, "reason").unwrap_or_else(|| "credentials".into()));
            out.method.get_or_insert_with(|| "password".into());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(action: &str, summary: Value) -> Row {
        Row {
            id: "e1".into(),
            action: action.into(),
            actor_address: Some("10.20.4.17".into()),
            resource_id: Some("p1".into()),
            summary: summary.to_string(),
            created_at: 5,
        }
    }

    #[test]
    fn entries_become_sign_ins() {
        let providers = vec![("p1".to_string(), "Müller SSO".to_string(), "saml".to_string())];
        let ok = view(
            row(
                "auth.signed_in",
                json!({ "method": "oidc", "provider": "sso", "providerName": "SSO", "secondFactor": "passkey",
                        "sessionId": "s1", "userAgent": "Firefox" }),
            ),
            &providers,
            Some("s1"),
        );
        assert_eq!(
            (ok.result, ok.method.as_deref(), ok.second_factor.as_deref()),
            ("success", Some("oidc"), Some("passkey"))
        );
        assert!(ok.current);
        let trusted = view(row("auth.signed_in", json!({ "provider": "sso", "providerMfa": true })), &providers, None);
        assert_eq!((trusted.method.as_deref(), trusted.second_factor.as_deref()), (Some("provider"), Some("provider")));
        let old = view(row("auth.signed_in", json!({})), &providers, Some("s1"));
        assert_eq!((old.method.as_deref(), old.current), (Some("password"), false));
        let wrong = view(row("auth.sign_in_failed", json!({ "userId": "u" })), &providers, None);
        assert_eq!((wrong.result, wrong.reason.as_deref()), ("refused", Some("credentials")));
        let factor = view(row("auth.second_factor_failed", json!({ "method": "totp" })), &providers, None);
        assert_eq!((factor.reason.as_deref(), factor.second_factor.as_deref()), (Some("second_factor"), Some("totp")));
        let sso =
            view(row("auth.sso_failed", json!({ "provider": "sso", "reason": "sso.unmapped" })), &providers, None);
        assert_eq!(
            (sso.method.as_deref(), sso.provider_name.as_deref(), sso.reason.as_deref()),
            (Some("saml"), Some("Müller SSO"), Some("sso.unmapped"))
        );
    }

    #[test]
    fn user_agents_are_cleaned_and_cut() {
        let mut headers = HeaderMap::new();
        assert_eq!(user_agent(&headers), None);
        headers.insert(header::USER_AGENT, "Mozilla/5.0\t(Windows)".parse().unwrap());
        assert_eq!(user_agent(&headers).as_deref(), Some("Mozilla/5.0(Windows)"));
        headers.insert(header::USER_AGENT, "x".repeat(400).parse().unwrap());
        assert_eq!(user_agent(&headers).map(|a| a.len()), Some(MAX_USER_AGENT_CHARS));
    }
}
