//! Signing in with a directory account (docs/api/sso.md, "Signing in: `POST /auth/login`"): the
//! password form asks the enabled LDAP providers first, in their order, then the local accounts
//! (`routes::auth::login_with`). A directory that confirms the person leads to the same account,
//! group mapping and second factor as a provider sign-in (`sso::signin`), with Kalzit's own second
//! factor always (`FirstStep::Directory`).

use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::json;

use super::ldap::{self, DirEntry, LdapConfig, LdapFail};
use super::oidc::{Person, matching_email};
use super::signin::{self, Refusal};
use super::store::{self, ProviderRow};
use crate::app::AppState;
use crate::auth::second_factor::FirstStep;
use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;

/// What the directories said about the typed login and password.
pub enum Attempt {
    /// No directory knows the person or took the password; `unreachable` when one could not be
    /// asked.
    NotConfirmed { unreachable: bool },
    /// A directory confirmed the person.
    Confirmed { provider: Box<ProviderRow>, person: Box<Person> },
}

impl ProviderRow {
    pub fn ldap(&self) -> ApiResult<LdapConfig> {
        serde_json::from_str(&self.config)
            .map_err(|e| ApiError::internal("sso", format!("the settings of provider {} cannot be read: {e}", self.id)))
    }
}

/// The enabled LDAP providers in their order.
pub async fn enabled(state: &AppState) -> ApiResult<Vec<ProviderRow>> {
    Ok(store::all(&state.read_db).await?.into_iter().filter(|p| p.enabled != 0 && p.kind == "ldap").collect())
}

/// The person `entry` (with `groups`) as a provider would send them.
pub fn person(config: &LdapConfig, entry: &DirEntry, groups: Vec<String>, mapped: &[String]) -> Option<Person> {
    let subject = entry.id.clone()?;
    let mut groups: Vec<String> = ldap::spell_as_mapped(ldap::dedup_groups(groups), mapped)
        .into_iter()
        .filter(|g| !g.is_empty() && g.chars().count() <= 256 && !g.chars().any(char::is_control))
        .collect();
    groups.sort();
    groups.dedup();
    groups.truncate(500);
    let email = entry.email.as_deref().map(str::trim).filter(|e| !e.is_empty());
    Some(Person {
        subject,
        username: entry.login.clone(),
        email: email.and_then(matching_email),
        email_as_typed: email
            .filter(|e| matching_email(e).is_some())
            .and_then(|e| crate::routes::normalize_email(e).ok()),
        email_verified: config.trust_email,
        name: entry.name.clone(),
        groups,
        mfa_done: false,
    })
}

/// The group names of `provider_id`'s mappings.
pub async fn mapped_groups(state: &AppState, provider_id: &str) -> ApiResult<Vec<String>> {
    Ok(super::mapping::rules(&state.read_db, provider_id).await?.into_iter().map(|r| r.group_name).collect())
}

/// Asks the enabled directories about `typed` and `password`. Failures of a directory are recorded
/// for admins (`auth.sso_failed`) and the next directory is asked.
pub async fn attempt(state: &AppState, info: &RequestInfo, typed: &str, password: &str) -> ApiResult<Attempt> {
    let providers = enabled(state).await?;
    let mut unreachable = false;
    if providers.is_empty() || typed.trim().is_empty() || password.is_empty() {
        return Ok(Attempt::NotConfirmed { unreachable });
    }
    let connector = state.sso.ldap(state);
    for provider in providers {
        let ids = (provider.id.as_str(), provider.slug.as_str());
        let note = |cause: &'static str, detail: String| async move {
            crate::routes::sso::record_failure(state, info, Some(ids), None, cause, &detail).await;
        };
        let config = provider.ldap()?;
        let Some(secret) = store::secret(&state.db, &state.secrets, &provider.id, ldap::BIND_PASSWORD).await? else {
            note("ldap.service_bind_failed", "the provider has no bind password".into()).await;
            continue;
        };
        let mut dir = match ldap::service(&connector, &config, &secret).await {
            Ok(d) => d,
            Err(e) => {
                unreachable |= !matches!(e, LdapFail::Bind { .. });
                note(e.cause(), e.to_string()).await;
                continue;
            }
        };
        let found = match dir.find(&config, typed).await {
            Ok(f) => f,
            Err(e) => {
                unreachable = true;
                note(e.cause(), e.to_string()).await;
                dir.close().await;
                continue;
            }
        };
        let entry = match found.as_slice() {
            [] => {
                dir.close().await;
                continue;
            }
            [one] => one.clone(),
            _ => {
                note("ldap.ambiguous_login", "more than one entry matches the login".into()).await;
                dir.close().await;
                continue;
            }
        };
        if entry.disabled {
            // Answered like a wrong password: the directory refuses the bind of such an account too.
            note("ldap.disabled_in_directory", format!("{} is disabled in the directory", entry.dn)).await;
            dir.close().await;
            continue;
        }
        // The groups are read with the service account before its connection closes, so a
        // sign-in holds one directory connection at a time.
        let groups = dir.groups(&config, &entry).await;
        dir.close().await;
        let groups = match groups {
            Ok(g) => g,
            Err(e) => {
                unreachable = true;
                note("ldap.search_failed", format!("reading the groups failed: {e}")).await;
                continue;
            }
        };
        match ldap::verify_password(&connector, &config, &entry.dn, password).await {
            Ok(true) => {}
            Ok(false) => continue,
            Err(e) => {
                unreachable = true;
                note(e.cause(), e.to_string()).await;
                continue;
            }
        }
        let mapped = mapped_groups(state, &provider.id).await?;
        let Some(person) = person(&config, &entry, groups, &mapped) else {
            note("ldap.id_missing", format!("{} has no {}", entry.dn, config.id_attribute())).await;
            continue;
        };
        return Ok(Attempt::Confirmed { provider: Box::new(provider), person: Box::new(person) });
    }
    Ok(Attempt::NotConfirmed { unreachable })
}

/// Enables again the account linked to `subject` when the sync disabled it: the directory just
/// confirmed the person.
async fn enable_if_sync_disabled(
    conn: &mut sqlx::AnyConnection,
    info: &RequestInfo,
    provider_id: &str,
    subject: &str,
    now: i64,
) -> ApiResult<()> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT d.user_id FROM ldap_deactivations d JOIN sso_identities i ON i.user_id = d.user_id \
         AND i.provider_id = d.provider_id WHERE d.provider_id = $1 AND i.subject = $2",
    )
    .bind(provider_id)
    .bind(subject)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((user_id,)) = row else { return Ok(()) };
    sqlx::query("UPDATE users SET disabled = 0 WHERE id = $1").bind(&user_id).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM ldap_deactivations WHERE user_id = $1").bind(&user_id).execute(&mut *conn).await?;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "user.enabled",
        resource_type: Some("user"),
        resource_id: Some(&user_id),
        summary: json!({ "userId": user_id, "cause": "ldap_sign_in", "providerId": provider_id }),
        at_ms: now,
    };
    Ok(crate::audit::record(conn, &event).await?)
}

/// Ends a sign-in a directory confirmed: the account, the group mapping and the second factor, as
/// after a provider's callback (`routes::sso::callback`), answered like `POST /auth/login`.
pub async fn finish(
    state: &AppState,
    info: &RequestInfo,
    headers: &HeaderMap,
    provider: &ProviderRow,
    person: &Person,
    forget_browser: bool,
) -> ApiResult<Response> {
    let now = state.clock.now_ms();
    let ids = (provider.id.as_str(), provider.slug.as_str());
    let refuse = |refusal: Refusal| async move {
        let r = crate::routes::sso::record_failure(
            state,
            info,
            Some(ids),
            refusal.user_id.as_deref(),
            refusal.reason,
            &refusal.detail,
        )
        .await;
        ApiError::forbidden("the directory confirmed the person, but the sign-in is refused")
            .because("ldap.sign_in_refused")
            .param("outcome", refusal.outcome)
            .param("ref", r)
    };
    let mut tx = crate::db::begin(&state.db).await?;
    enable_if_sync_disabled(&mut tx, info, &provider.id, &person.subject, now).await?;
    let linked = match signin::account(&mut tx, state, info, provider, ldap::ISSUER, person, now).await? {
        Ok(l) => l,
        Err(refusal) => {
            drop(tx);
            return Err(refuse(refusal).await);
        }
    };
    let outcome = signin::decide(&mut tx, state, &provider.id, &linked, &person.groups).await?;
    if let Some(o) = outcome.as_ref().filter(|o| o.refused) {
        let touched = signin::apply(&mut tx, info, ids, &linked.user.id, o, None, now).await?;
        crate::db::commit(tx).await?;
        super::rights_changed(state, &touched).await;
        if linked.user.is_server_admin == 0 {
            let refusal = Refusal::new("unmapped", "sso.unmapped", "no group of the person is mapped");
            return Err(refuse(Refusal { user_id: Some(linked.user.id.clone()), ..refusal }).await);
        }
        tx = crate::db::begin(&state.db).await?;
    }
    crate::db::commit(tx).await?;
    let first = FirstStep::Directory;
    let plan = crate::routes::second_factor::plan(state, info, &linked.user, first, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    let mapping = outcome.as_ref().filter(|o| !o.refused);
    let touched = match (plan.is_some(), mapping) {
        // The mapping waits for the second step to end well (`signin::apply_deferred`).
        (true, Some(_)) => {
            signin::defer(&mut tx, &linked.user.id, &provider.id, now).await?;
            Default::default()
        }
        (false, Some(o)) => signin::apply(&mut tx, info, ids, &linked.user.id, o, None, now).await?,
        (_, None) => Default::default(),
    };
    let answer = crate::routes::second_factor::finish_first_step(
        tx,
        state,
        info,
        headers,
        linked.user,
        first,
        forget_browser,
        plan,
        now,
    )
    .await?;
    super::rights_changed(state, &touched).await;
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sso::ldap::{Certificate, Encryption, Flavor, Schedule};

    #[test]
    fn people_from_entries() {
        let config = LdapConfig {
            flavor: Flavor::Ldap,
            url: "ldap://127.0.0.1".into(),
            encryption: Encryption::None,
            certificate: Certificate::System,
            ca_pem: None,
            bind_dn: "cn=admin,dc=x".into(),
            user_base_dn: "dc=x".into(),
            login_attribute: "uid".into(),
            user_filter: String::new(),
            group_base_dn: String::new(),
            nested_groups: false,
            email_attribute: "mail".into(),
            name_attribute: "cn".into(),
            trust_email: true,
            sync_schedule: Schedule::Off,
            sync_hour: 2,
            sync_threshold: 10,
        };
        let entry = DirEntry {
            dn: "uid=anna,dc=x".into(),
            id: Some("u-1".into()),
            login: Some("anna".into()),
            email: Some(" Anna@Example.DE ".into()),
            name: Some("Anna".into()),
            ..Default::default()
        };
        let p =
            person(&config, &entry, vec!["cn=Leser,dc=x".into(), "CN=LESER,DC=X".into()], &["CN=Leser,DC=x".into()])
                .unwrap();
        assert_eq!(p.subject, "u-1");
        assert_eq!(p.email.as_deref(), Some("anna@example.de"));
        assert_eq!(p.groups, vec!["CN=Leser,DC=x".to_string()]);
        assert!(p.email_verified && !p.mfa_done);
        assert!(person(&config, &DirEntry { id: None, ..entry }, Vec::new(), &[]).is_none());
    }
}
