//! Sign in, sign out and the current user.

use axum::extract::State;
use axum::http::Uri;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::{Extension, Json};
use serde::Deserialize;

use super::{MAX_EMAIL_CHARS, Me, me};
use crate::app::AppState;
use crate::auth::{CurrentUser, SessionUser, password, session};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    /// "This is not my browser": no device cookie is issued, and one the browser has is removed.
    #[serde(default, rename = "forgetBrowser")]
    pub forget_browser: bool,
}

/// "Sign out and forget this browser" (`?forgetBrowser=true` or `=1`): the device cookie is
/// removed as well. Read leniently: whatever else the query holds, signing out never fails.
fn forget_browser(uri: &Uri) -> bool {
    uri.query().unwrap_or_default().split('&').any(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        key == "forgetBrowser" && matches!(value.to_ascii_lowercase().as_str(), "true" | "1")
    })
}

#[derive(sqlx::FromRow)]
struct LoginRow {
    id: String,
    email: String,
    name: String,
    password_hash: Option<String>,
    is_server_admin: i64,
    disabled: i64,
}

pub fn routes() -> Vec<super::table::RouteDef> {
    use super::table::route;
    use crate::authz::Access::{Authenticated, Public};
    use axum::http::Method;
    vec![
        route(Method::POST, "/auth/login", Public, login),
        // Signing out works without a valid session too: it clears the cookie either way.
        route(Method::POST, "/auth/logout", Public, logout),
        route(Method::GET, "/me", Authenticated, current),
    ]
}

/// How long a sign-in waits for a password check slot of its account (`ratelimit::InFlight`).
const CHECK_SLOT_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Overflow buckets for emails without an account while their table is full.
pub const OVERFLOW_BUCKETS: u16 = 4096;

/// The overflow bucket of `email`: an HMAC with the key derived from the secrets key, so the
/// bucket of an email cannot be known or aimed at from outside.
pub fn overflow_bucket(state: &AppState, email: &str) -> String {
    let mac = state.secrets.sign(format!("kalzit-login-overflow\0{email}").as_bytes());
    format!("overflow:{}", u16::from_be_bytes([mac[0], mac[1]]) % OVERFLOW_BUCKETS)
}

fn rate_limited(wait: std::time::Duration) -> ApiError {
    ApiError::rate_limited("too many failed sign-ins, wait a few minutes", wait)
}

fn invalid_credentials() -> ApiError {
    // Same answer for unknown email, wrong password and disabled account, so the response does
    // not reveal which accounts exist.
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_credentials", "email or password is not correct")
}

pub async fn login(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    headers: HeaderMap,
    JsonBody(req): JsonBody<LoginRequest>,
) -> ApiResult<impl IntoResponse> {
    login_with(state, info, headers, req, false).await
}

/// The form a typed login is counted and looked up in: trimmed and lowercased, and a Windows
/// `DOMAIN\name` as `name` (as the directory search reads it, `sso::ldap::LdapConfig::login_filter`),
/// so every spelling of one login shares its budgets. An address keeps its backslash (`a\b@x.de`
/// is an address): only a name without `@` loses the domain.
pub fn login_key(typed: &str) -> String {
    let login = typed.trim().to_lowercase();
    match login.rsplit_once('\\') {
        Some((_, name)) if !name.contains('@') => name.to_string(),
        _ => login,
    }
}

/// The password sign-in; `break_glass_form` for the break-glass form (`POST /auth/login/local`,
/// docs/api/sso.md), the only one the break-glass admin may use while password sign-in is off.
pub async fn login_with(
    state: AppState,
    info: RequestInfo,
    headers: HeaderMap,
    req: LoginRequest,
    break_glass_form: bool,
) -> ApiResult<axum::response::Response> {
    let now = state.clock.now_ms();
    // No account can have such an email or password, so these are refused before they cost a
    // hash or a rate-limit entry.
    let email = login_key(&req.email);
    if email.chars().count() > MAX_EMAIL_CHARS || req.password.chars().count() > password::MAX_PASSWORD_CHARS {
        return Err(invalid_credentials());
    }
    use crate::auth::ratelimit::{CLEAN_ADDRESS_FAILURES, account_key, address_key, network_key};
    let mono = state.clock.monotonic_ms();
    let ip_key = address_key("login", info.client_ip);
    let network = network_key(info.client_ip);
    // The account's budget at this address: guesses from elsewhere never use it up.
    let pair_key = format!("account:{email}|{ip_key}");
    let account_key = account_key(&email);
    let ip_counted = state.login_limiter.try_acquire(&ip_key, &network, mono).map_err(rate_limited)?;
    let refuse = |wait| {
        state.login_limiter.refund(&ip_key, &ip_counted);
        rate_limited(wait)
    };
    let pair_counted = state.pair_limiter.try_acquire(&pair_key, &network, mono).map_err(refuse)?;
    // Refused after both counted: neither attempt counts.
    let refuse = |wait| {
        state.pair_limiter.refund(&pair_key, &pair_counted);
        refuse(wait)
    };

    let row: Option<LoginRow> = sqlx::query_as(
        "SELECT id, email, name, password_hash, is_server_admin, disabled FROM users \
             WHERE email = $1 AND service_account = 0",
    )
    .bind(&email)
    .fetch_optional(&state.read_db)
    .await?;
    // The waits named below are the whole window, so they tell nothing about the account or
    // the network.
    let window = state.login_limiter.window();
    // The shared budgets are counted before the password is checked, under their lock, so
    // parallel guesses cannot pass them all; a correct password gives the attempts back.
    // An IPv6 site (/48) whose failures for all accounts are used up: only attempts whose account
    // at this address is clean go on, so others' typos never make the owner dirty.
    let ipv6 = info.client_ip.to_canonical().is_ipv6();
    let site_counted = if !ipv6 {
        None
    } else if pair_counted.earlier > CLEAN_ADDRESS_FAILURES {
        Some(state.network_limiter.try_acquire(&network, &network, mono).map_err(|_| refuse(window))?)
    } else {
        state.network_limiter.record(&network, &network, mono)
    };
    let refuse = |wait| {
        if let Some(counted) = &site_counted {
            state.network_limiter.refund(&network, counted);
        }
        refuse(wait)
    };
    // The account's budget: in a table without a cap for accounts that exist, so no flood can
    // push it out; in a bounded one for emails without an account, which answers alike. A browser
    // the account signed in with before is not held to it, but its failures count; everyone else
    // is held to it.
    let device = crate::auth::device::read_cookie(&headers, info.https);
    let known_device = row.as_ref().zip(device.as_deref()).is_some_and(|(r, value)| {
        crate::auth::device::is_known(&state.secrets, value, &r.id, r.password_hash.as_deref(), now)
    });
    let accounts = if row.is_some() { &state.account_limiter } else { &state.unknown_account_limiter };
    // A full table of emails without an account leaves the email uncounted rather than refused,
    // since the table of accounts always takes one; the answer stays the same for both.
    // Such an email then counts in one of a fixed set of overflow buckets instead (chosen by a
    // keyed hash of the email, so nobody can aim at a bucket), with the same budget: it still
    // reaches its refusal after about as many failures as an account does.
    let counted_in = if known_device {
        accounts.record(&account_key, &network, mono).map(|c| (accounts, account_key.clone(), c))
    } else {
        match accounts.try_count(&account_key, &network, mono).map_err(|_| refuse(window))? {
            Some(c) => Some((accounts, account_key.clone(), c)),
            None => {
                let bucket = overflow_bucket(&state, &email);
                let c = state.overflow_limiter.try_acquire(&bucket, &bucket, mono).map_err(|_| refuse(window))?;
                Some((&state.overflow_limiter, bucket, c))
            }
        }
    };
    let refuse = |wait| {
        if let Some((limiter, key, counted)) = &counted_in {
            limiter.refund(key, counted);
        }
        refuse(wait)
    };
    // At most a few checks of one account at once, taken only after its budgets passed; more
    // wait briefly for a slot, then are refused. Known devices have slots of their own and their
    // own hashing threads, so guesses holding the others cannot keep the owner out.
    // Sign-ins of known devices, which are checked on threads of their own, also have a budget
    // of successes per account and per address, so an account that signs in over and over cannot
    // keep those threads busy for the others.
    if known_device
        && (state.sign_in_account_limiter.wait(&account_key, mono).is_some()
            || state.sign_in_address_limiter.wait(&ip_key, mono).is_some())
    {
        return Err(refuse(window));
    }
    use crate::auth::ratelimit::{MAX_IN_FLIGHT_PER_ACCOUNT, MAX_TRUSTED_IN_FLIGHT_PER_ACCOUNT};
    let (slot_key, slots, lane) = if known_device {
        (format!("device:{account_key}"), MAX_TRUSTED_IN_FLIGHT_PER_ACCOUNT, &*password::TRUSTED)
    } else {
        (account_key.clone(), MAX_IN_FLIGHT_PER_ACCOUNT, &*password::SHARED)
    };
    let Some(_checking) = state.password_checks.enter(&slot_key, slots, CHECK_SLOT_WAIT).await else {
        return Err(refuse(std::time::Duration::from_secs(1)));
    };
    // Directory accounts first, then local ones (docs/api/sso.md, "LDAP and Active Directory"),
    // inside the same budgets; never on the break-glass form, which is for local accounts only.
    let mut directory_unreachable = false;
    if !break_glass_form {
        use crate::sso::directory::{self, Attempt};
        // The directory entry the login names has a budget of its own as well, shared by every
        // spelling of the login that finds it (name, address, UPN).
        let entry_counted: std::sync::Mutex<Vec<(String, crate::auth::ratelimit::Counted)>> = Default::default();
        let charge = |key: &str| match state.account_limiter.try_count(key, &network, mono) {
            Ok(Some(counted)) => {
                entry_counted
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((key.to_string(), counted));
                true
            }
            Ok(None) => true,
            Err(_) => false,
        };
        match directory::attempt(&state, &info, req.email.trim(), &req.password, &charge).await? {
            Attempt::Confirmed { provider, person } => {
                state.pair_limiter.reset(&pair_key);
                state.login_limiter.refund(&ip_key, &ip_counted);
                if let Some(counted) = &site_counted {
                    state.network_limiter.refund(&network, counted);
                }
                if let Some((limiter, key, counted)) = &counted_in {
                    limiter.refund(key, counted);
                }
                for (key, counted) in entry_counted.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter() {
                    state.account_limiter.refund(key, counted);
                }
                return directory::finish(&state, &info, &headers, &provider, &person, req.forget_browser).await;
            }
            Attempt::Limited => return Err(refuse(window)),
            Attempt::NotConfirmed { unreachable } => directory_unreachable = unreachable,
        }
    }
    let stored = row.as_ref().and_then(|r| r.password_hash.clone());
    let Some(ok) = password::verify(req.password, stored, lane).await else {
        return Err(refuse(std::time::Duration::from_secs(1)));
    };
    fn event<'a>(
        info: &RequestInfo,
        now: i64,
        action: &'a str,
        user_id: Option<&'a str>,
        reason: Option<&str>,
    ) -> crate::audit::AuditEvent<'a> {
        crate::audit::AuditEvent {
            org_id: None,
            actor_user_id: None,
            actor_address: Some(info.client_ip.to_string()),
            action,
            resource_type: Some("user"),
            // The account's own recent sign-ins list its refused attempts (`auth::sign_ins`).
            resource_id: user_id,
            summary: match (user_id, reason) {
                (Some(id), Some(reason)) => serde_json::json!({ "userId": id, "reason": reason, "method": "password" }),
                (Some(id), None) => serde_json::json!({ "userId": id }),
                _ => serde_json::json!({}),
            },
            at_ms: now,
        }
    }
    let audit = |action, user_id, reason| event(&info, now, action, user_id, reason);
    let known_id = row.as_ref().map(|r| r.id.clone());
    let Some(row) = row.filter(|r| ok && r.disabled == 0) else {
        tracing::info!(client = %info.client_ip, "failed sign-in");
        // The id of an existing account is recorded, never the email that was typed. Whether the
        // password was right for a disabled account is recorded only for the account itself.
        // A failed sign-in answers the same whatever happens to its audit entry: a busy database
        // must not turn it into "try again", which would invite repeated password guesses past
        // the point where the attempt was already counted.
        let reason = if ok { "disabled" } else { "credentials" };
        let event = audit("auth.sign_in_failed", known_id.as_deref(), known_id.as_ref().map(|_| reason));
        let recorded = match state.db.acquire().await {
            Ok(mut conn) => crate::audit::record(&mut conn, &event).await,
            Err(e) => Err(e),
        };
        if let Err(e) = recorded {
            tracing::warn!(client = %info.client_ip, "recording a failed sign-in in the audit log failed: {e}");
        }
        // A directory could not be asked: said whether or not a local account has this login, so
        // the answer tells nothing about local accounts.
        if directory_unreachable {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "the directory cannot be reached, try again in a moment",
            )
            .because("ldap.directory_unreachable"));
        }
        return Err(invalid_credentials());
    };
    if known_device {
        state.sign_in_account_limiter.record(&account_key, &network, mono);
        state.sign_in_address_limiter.record(&ip_key, &network, mono);
    }
    state.pair_limiter.reset(&pair_key);
    state.login_limiter.refund(&ip_key, &ip_counted);
    if let Some(counted) = &site_counted {
        state.network_limiter.refund(&network, counted);
    }
    if let Some((limiter, key, counted)) = &counted_in {
        limiter.refund(key, counted);
    }

    // Password sign-in may be off for this account (docs/api/sso.md); said only after the right
    // password, so nobody can probe accounts with it.
    use crate::sso::PasswordSignIn;
    let decision = crate::sso::password_sign_in(&state, &row.id, break_glass_form).await?;
    if decision == PasswordSignIn::Off {
        // Recorded for the account's recent sign-ins; the answer stays the same if that fails.
        let event = audit("auth.sign_in_failed", Some(&row.id), Some("password_off"));
        let recorded = match state.db.acquire().await {
            Ok(mut conn) => crate::audit::record(&mut conn, &event).await,
            Err(e) => Err(e),
        };
        if let Err(e) = recorded {
            tracing::warn!(client = %info.client_ip, "recording a refused sign-in in the audit log failed: {e}");
        }
        return Err(ApiError::forbidden("password sign-in is off for this account; sign in through a provider")
            .because("sso.password_sign_in_off"));
    }
    // Whether a second step follows (`second_factor`), read before the transaction so it holds
    // no second connection.
    let user = SessionUser {
        id: row.id.clone(),
        email: row.email.clone(),
        name: row.name.clone(),
        is_server_admin: row.is_server_admin,
    };
    let first = crate::auth::second_factor::FirstStep::Password {
        password_hash: row.password_hash.as_deref(),
        break_glass: decision == PasswordSignIn::BreakGlass,
    };
    let mut plan = super::second_factor::plan(&state, &info, &user, first, now).await?;
    // The break-glass admin never gets in with a password alone: without a second factor (it can
    // only be gone through a database change), one is set up first.
    if decision == PasswordSignIn::BreakGlass && plan.is_none() {
        plan = Some(super::second_factor::forced_setup(&state, &info, &user, None, now).await?);
    }

    let mut tx = crate::db::begin(&state.db).await?;
    // Lock the user row and confirm it still holds the hash we verified and is still enabled. A
    // password change or a disable takes the same lock, so a sign-in that raced one either sees
    // the change and fails here, or commits first and has its session ended by the change.
    let still_valid = sqlx::query(
        "UPDATE users SET password_hash = password_hash WHERE id = $1 AND password_hash = $2 AND disabled = 0",
    )
    .bind(&row.id)
    .bind(row.password_hash.as_deref())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if still_valid == 0 {
        return Err(invalid_credentials());
    }
    if decision == PasswordSignIn::BreakGlass {
        let mut event = audit("auth.break_glass_signed_in", None, None);
        event.actor_user_id = Some(&row.id);
        event.resource_id = Some(&row.id);
        crate::audit::record(&mut tx, &event).await?;
    }
    // The session opens now, or the second step starts (`routes::second_factor`). Everything the
    // answer needs is read before the commit: once it is committed, nothing may fail as "busy,
    // nothing changed".
    let answer = super::second_factor::finish_first_step(
        tx,
        &state,
        &info,
        &headers,
        user,
        first,
        req.forget_browser,
        plan,
        now,
    )
    .await?;
    if decision == PasswordSignIn::BreakGlass {
        crate::sso::announce_break_glass(&state, &row.id, &info);
    }
    Ok(answer)
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    uri: Uri,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    if let Some(token) = session::read_cookie(&headers, info.https) {
        let mut tx = crate::db::begin(&state.db).await?;
        let user: Option<(String,)> = sqlx::query_as("SELECT user_id FROM sessions WHERE token_hash = $1")
            .bind(session::hash_token(&token))
            .fetch_optional(&mut *tx)
            .await?;
        session::delete(&mut *tx, &token).await?;
        // Only a session that still existed is recorded; an old cookie signs out silently.
        if let Some((user_id,)) = &user {
            let event = crate::audit::AuditEvent {
                org_id: None,
                actor_user_id: Some(user_id),
                actor_address: Some(info.client_ip.to_string()),
                action: "auth.signed_out",
                resource_type: Some("user"),
                resource_id: Some(user_id),
                summary: serde_json::json!({}),
                at_ms: state.clock.now_ms(),
            };
            crate::audit::record(&mut tx, &event).await?;
        }
        crate::db::commit(tx).await?;
    }
    // Signing out during the second step of a sign-in ends that too.
    let pending = crate::auth::second_factor::read_pending_cookie(&headers, info.https);
    if let Some(token) = &pending {
        sqlx::query("DELETE FROM sign_in_challenges WHERE token_hash = $1")
            .bind(session::hash_token(token))
            .execute(&state.db)
            .await?;
    }
    let mut out = HeaderMap::new();
    out.insert(header::SET_COOKIE, session::clear_cookie(info.https));
    if pending.is_some() {
        out.append(header::SET_COOKIE, crate::auth::second_factor::clear_pending_cookie(info.https));
    }
    // The device cookie survives a plain sign-out, so the owner keeps the known-device budget in
    // their own browser; on request it goes too.
    if forget_browser(&uri) {
        out.append(header::SET_COOKIE, crate::auth::device::clear_cookie(info.https));
    }
    Ok((StatusCode::NO_CONTENT, out))
}

pub async fn current(State(state): State<AppState>, CurrentUser(user): CurrentUser) -> ApiResult<Json<Me>> {
    let mut conn = state.read_db.acquire().await?;
    Ok(Json(me(&mut conn, user).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forget_browser_is_read_leniently() {
        let read = |q: &str| forget_browser(&q.parse::<Uri>().unwrap());
        assert!(read("/api/auth/logout?forgetBrowser=true"));
        assert!(read("/api/auth/logout?forgetBrowser=1"));
        assert!(read("/api/auth/logout?x=%zz&forgetBrowser=TRUE&y"));
        assert!(!read("/api/auth/logout"));
        assert!(!read("/api/auth/logout?forgetBrowser=false"));
        assert!(!read("/api/auth/logout?forgetBrowser"));
        assert!(!read("/api/auth/logout?forgetbrowser=true"));
    }
}
