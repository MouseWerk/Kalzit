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
    /// The budget of the directory entry the login names is used up.
    Limited,
    /// A directory confirmed the person.
    Confirmed { provider: Box<ProviderRow>, person: Box<Person> },
}

/// What one directory said.
enum One {
    Unknown,
    Unreachable,
    Limited,
    Confirmed(Box<Person>),
}

/// One sign-in asks one directory for at most this long (connections, searches and the bind).
pub const SIGN_IN_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

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
/// for admins (`auth.sso_failed`) and the next directory is asked. `charge` counts an attempt
/// against the budget of the directory entry the login names (`ldap:<provider>:<entry id>`), so
/// every spelling of the same login (`DOMAIN\name`, the UPN, the address) shares it; it answers
/// `false` when the budget is used up.
pub async fn attempt(
    state: &AppState,
    info: &RequestInfo,
    typed: &str,
    password: &str,
    charge: &(dyn Fn(&str) -> bool + Send + Sync),
) -> ApiResult<Attempt> {
    let providers = enabled(state).await?;
    let mut unreachable = false;
    if providers.is_empty() || typed.trim().is_empty() || password.is_empty() {
        return Ok(Attempt::NotConfirmed { unreachable });
    }
    for provider in providers {
        let one =
            tokio::time::timeout(SIGN_IN_DEADLINE, attempt_one(state, info, &provider, typed, password, charge)).await;
        match one {
            Ok(Ok(One::Confirmed(person))) => return Ok(Attempt::Confirmed { provider: Box::new(provider), person }),
            Ok(Ok(One::Limited)) => return Ok(Attempt::Limited),
            Ok(Ok(One::Unknown)) => {}
            Ok(Ok(One::Unreachable)) => unreachable = true,
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                unreachable = true;
                let detail = format!("the directory did not finish within {} seconds", SIGN_IN_DEADLINE.as_secs());
                let ids = Some((provider.id.as_str(), provider.slug.as_str()));
                crate::routes::sso::record_failure(state, info, ids, None, "ldap.unreachable", &detail).await;
            }
        }
    }
    Ok(Attempt::NotConfirmed { unreachable })
}

async fn attempt_one(
    state: &AppState,
    info: &RequestInfo,
    provider: &ProviderRow,
    typed: &str,
    password: &str,
    charge: &(dyn Fn(&str) -> bool + Send + Sync),
) -> ApiResult<One> {
    let connector = state.sso.ldap(state);
    let ids = (provider.id.as_str(), provider.slug.as_str());
    let note = |cause: &'static str, detail: String| async move {
        crate::routes::sso::record_failure(state, info, Some(ids), None, cause, &detail).await;
    };
    let config = provider.ldap()?;
    let Some(secret) = store::secret(&state.db, &state.secrets, &provider.id, ldap::BIND_PASSWORD).await? else {
        note("ldap.service_bind_failed", "the provider has no bind password".into()).await;
        return Ok(One::Unknown);
    };
    let mut dir = match ldap::service(&connector, &config, &secret).await {
        Ok(d) => d,
        Err(e) => {
            let unreachable = !matches!(e, LdapFail::Bind { .. });
            note(e.cause(), e.to_string()).await;
            return Ok(if unreachable { One::Unreachable } else { One::Unknown });
        }
    };
    let found = match dir.find(&config, typed).await {
        Ok(f) => f,
        Err(e) => {
            note(e.cause(), e.to_string()).await;
            dir.close().await;
            return Ok(One::Unreachable);
        }
    };
    let entry = match found.as_slice() {
        [] => {
            dir.close().await;
            return Ok(One::Unknown);
        }
        [one] => one.clone(),
        _ => {
            note("ldap.ambiguous_login", "more than one entry matches the login".into()).await;
            dir.close().await;
            return Ok(One::Unknown);
        }
    };
    if entry.disabled {
        // Answered like a wrong password: the directory refuses the bind of such an account too.
        note("ldap.disabled_in_directory", format!("{} is disabled in the directory", entry.dn)).await;
        dir.close().await;
        return Ok(One::Unknown);
    }
    let key = entry.id.clone().unwrap_or_else(|| entry.dn.to_lowercase());
    if !charge(&format!("ldap:{}:{key}", provider.id)) {
        dir.close().await;
        return Ok(One::Limited);
    }
    // The groups are read with the service account before its connection closes, so a sign-in
    // holds one directory connection at a time.
    let groups = dir.groups(&config, &entry).await;
    dir.close().await;
    let groups = match groups {
        Ok(g) => g,
        Err(e) => {
            note("ldap.search_failed", format!("reading the groups failed: {e}")).await;
            return Ok(One::Unreachable);
        }
    };
    match ldap::verify_password(&connector, &config, &entry.dn, password).await {
        Ok(true) => {}
        Ok(false) => return Ok(One::Unknown),
        Err(e) => {
            note(e.cause(), e.to_string()).await;
            return Ok(One::Unreachable);
        }
    }
    let mapped = mapped_groups(state, &provider.id).await?;
    let Some(person) = person(&config, &entry, groups, &mapped) else {
        note("ldap.id_missing", format!("{} has no {}", entry.dn, config.id_attribute())).await;
        return Ok(One::Unknown);
    };
    Ok(One::Confirmed(Box::new(person)))
}

/// The account linked to `subject` at `provider_id`, when the sync disabled it (and no admin
/// enabled or disabled it since, which removes the record): its id and the run that disabled it.
async fn sync_disabled_account(
    state: &AppState,
    provider_id: &str,
    subject: &str,
) -> ApiResult<Option<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT u.id, d.run_id FROM ldap_deactivations d JOIN sso_identities i \
         ON i.user_id = d.user_id AND i.provider_id = d.provider_id JOIN users u ON u.id = d.user_id \
         WHERE d.provider_id = $1 AND i.subject = $2 AND u.disabled = 1",
    )
    .bind(provider_id)
    .bind(subject)
    .fetch_optional(&state.db)
    .await?)
}

/// Enables again an account the sync disabled in `run_id`, once a directory sign-in of the person
/// is complete (with Kalzit's second factor when one is asked, `auth::second_factor`). Answers
/// `false`, changing nothing, when that record is gone: an admin enabled or disabled the account
/// since, or a later run disabled it again.
pub async fn enable_sync_disabled(
    conn: &mut sqlx::AnyConnection,
    address: Option<std::net::IpAddr>,
    user_id: &str,
    run_id: &str,
    now: i64,
) -> ApiResult<bool> {
    let record: Option<(String,)> =
        sqlx::query_as("SELECT provider_id FROM ldap_deactivations WHERE user_id = $1 AND run_id = $2")
            .bind(user_id)
            .bind(run_id)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((provider_id,)) = record else { return Ok(false) };
    let removed = sqlx::query("DELETE FROM ldap_deactivations WHERE user_id = $1 AND run_id = $2")
        .bind(user_id)
        .bind(run_id)
        .execute(&mut *conn)
        .await?
        .rows_affected();
    // An account SCIM deactivated stays locked; the sync's record of its own lock is gone all the same.
    if removed == 0 || crate::scim::locked_by_scim(&mut *conn, user_id).await? {
        return Ok(false);
    }
    sqlx::query("UPDATE users SET disabled = 0 WHERE id = $1").bind(user_id).execute(&mut *conn).await?;
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(user_id),
        actor_address: address.map(|a| a.to_string()),
        action: "user.enabled",
        resource_type: Some("user"),
        resource_id: Some(user_id),
        summary: json!({ "userId": user_id, "cause": "ldap_sign_in", "providerId": provider_id }),
        at_ms: now,
    };
    crate::audit::record(conn, &event).await?;
    Ok(true)
}

/// Puts back the disabled flag the sign-in lifted inside its transaction only.
async fn keep_disabled(conn: &mut sqlx::AnyConnection, user_id: Option<&str>) -> ApiResult<()> {
    if let Some(id) = user_id {
        sqlx::query("UPDATE users SET disabled = 1 WHERE id = $1").bind(id).execute(conn).await?;
    }
    Ok(())
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
    // An account the sync disabled is enabled again, in the transaction that opens the session,
    // or after the second step (`auth::second_factor::take_pending`), never before. For the
    // account's checks the flag is lifted inside this first transaction only.
    let sync_disabled = sync_disabled_account(state, &provider.id, &person.subject).await?;
    let lifted = sync_disabled.as_ref().map(|(id, _)| id.clone());
    let mut tx = crate::db::begin(&state.db).await?;
    if let Some(id) = &lifted {
        sqlx::query("UPDATE users SET disabled = 0 WHERE id = $1").bind(id).execute(&mut *tx).await?;
    }
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
        keep_disabled(&mut tx, lifted.as_deref()).await?;
        crate::db::commit(tx).await?;
        super::rights_changed(state, &touched).await;
        if linked.user.is_server_admin == 0 {
            let refusal = Refusal::new("unmapped", "sso.unmapped", "no group of the person is mapped");
            return Err(refuse(Refusal { user_id: Some(linked.user.id.clone()), ..refusal }).await);
        }
        tx = crate::db::begin(&state.db).await?;
    }
    keep_disabled(&mut tx, lifted.as_deref()).await?;
    crate::db::commit(tx).await?;
    // The one plan for the second step, from which both the answer and the enabling follow.
    let sync_run = sync_disabled.as_ref().map(|(_, run)| run.as_str());
    let first = FirstStep::Directory { provider_id: &provider.id, sync_run };
    let plan = crate::routes::second_factor::plan(state, info, &linked.user, first, now).await?;
    let mut tx = crate::db::begin(&state.db).await?;
    if plan.is_none()
        && let Some((id, run)) = &sync_disabled
        && !enable_sync_disabled(&mut tx, Some(info.client_ip), id, run, now).await?
    {
        // An admin or a newer sync run changed the account meanwhile: it stays disabled.
        drop(tx);
        let refusal = Refusal::new("disabled", "sso.account_disabled", "the account is disabled");
        return Err(refuse(Refusal { user_id: Some(id.clone()), ..refusal }).await);
    }
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
