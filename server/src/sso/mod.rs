//! Single sign-on (docs/api/sso.md): identity providers (OpenID Connect, LDAP and Active
//! Directory; SAML uses the same providers, identities and group mapping later), the mapping of their groups to
//! organizations, teams and roles, and the rules for the local password sign-in with its
//! break-glass admin.

pub mod directory;
pub mod jwt;
pub mod ldap;
pub mod mapping;
pub mod oidc;
pub mod signin;
pub mod store;
pub mod sync;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::app::AppState;
use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::config::Config;
use crate::datasources::targets::TargetPolicy;
use crate::error::ApiResult;
use crate::net::RequestInfo;
use oidc::{Cached, Fetcher, OidcConfig, OidcError};

/// How long a sign-in may take at the provider, and how long a test sign-in's result is kept.
pub const SIGN_IN_TTL_MS: i64 = 10 * 60 * 1000;
/// Starts per client address in `START_WINDOW_SECS`.
pub const STARTS_PER_ADDRESS: u32 = 30;
pub const START_WINDOW_SECS: u64 = 10 * 60;
/// Attempts at `POST /auth/login/local` per client address in `LOCAL_WINDOW_SECS`.
pub const LOCAL_ATTEMPTS: u32 = 10;
pub const LOCAL_WINDOW_SECS: u64 = 15 * 60;
/// Requests to a provider wait at most this long.
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(15);

/// The single sign-on parts of the server's state: what Kalzit keeps of providers between
/// sign-ins, and the rate limits of the sign-in routes.
pub struct Sso {
    cache: Mutex<HashMap<String, Cached>>,
    /// Starts of sign-ins through a provider per client address.
    pub start_limiter: RateLimiter,
    /// Attempts at the break-glass form per client address.
    pub local_limiter: RateLimiter,
    policy: Arc<TargetPolicy>,
    /// Connections to directories at once (`ldap::MAX_CONNECTIONS`).
    ldap_limit: Arc<tokio::sync::Semaphore>,
    /// Providers whose sync runs on this server now.
    pub syncing: Mutex<std::collections::HashSet<String>>,
}

impl Sso {
    /// Providers may live in private networks and on this computer, like data sources; Kalzit's
    /// own data and database and metadata addresses stay refused. The data sources' list of
    /// allowed targets does not apply to them.
    pub fn new(config: &Config) -> Self {
        Self {
            cache: Mutex::default(),
            start_limiter: RateLimiter::new(STARTS_PER_ADDRESS, START_WINDOW_SECS, Capacity::SMALL),
            local_limiter: RateLimiter::new(LOCAL_ATTEMPTS, LOCAL_WINDOW_SECS, Capacity::SMALL),
            policy: Arc::new(TargetPolicy::new(&config.paths.data_dir, &config.database_url(), &[], &[])),
            ldap_limit: Arc::new(tokio::sync::Semaphore::new(ldap::MAX_CONNECTIONS)),
            syncing: Mutex::default(),
        }
    }

    /// Kalzit's own ports, which no provider may be.
    fn own_ports(state: &AppState) -> Vec<u16> {
        let own = [state.config.http_addr(), state.config.https_addr()];
        let mut ports: Vec<u16> = own.iter().flatten().map(|l| l.port()).collect();
        // Behind a proxy on this computer, the public port reaches Kalzit too.
        if let Some(port) = state
            .config
            .server
            .public_url
            .as_deref()
            .and_then(|u| url::Url::parse(u).ok())
            .and_then(|u| u.port_or_known_default())
        {
            ports.push(port);
        }
        ports
    }

    /// Connections to directories (`ldap::Connector`), under the same target rules.
    pub fn ldap(&self, state: &AppState) -> ldap::Connector {
        ldap::Connector {
            policy: self.policy.clone(),
            own_ports: Self::own_ports(state),
            limit: self.ldap_limit.clone(),
        }
    }

    /// The requests to a provider; none of them reaches Kalzit itself (`oidc::Fetcher`).
    pub fn client(&self, state: &AppState) -> Fetcher {
        Fetcher::new(self.policy.clone(), Self::own_ports(state), PROVIDER_TIMEOUT)
    }

    /// The discovery document and keys of `config`'s issuer, from the cache unless older than
    /// `oidc::DISCOVERY_TTL` or `fresh`.
    /// `mono` is the server's monotonic clock (`Clock::monotonic_ms`).
    pub async fn provider(
        &self,
        http: &Fetcher,
        config: &OidcConfig,
        fresh: bool,
        mono: i64,
    ) -> Result<Cached, OidcError> {
        let kept = self.lock().get(&config.issuer).cloned();
        if !fresh
            && let Some(c) = kept
            && mono - c.loaded_ms < ms(oidc::DISCOVERY_TTL)
        {
            return Ok(c);
        }
        let discovery = oidc::discover(http, &config.issuer).await?;
        let keys = oidc::load_keys(http, &discovery.jwks_uri).await?;
        let cached = Cached { discovery, keys, loaded_ms: mono, keys_loaded_ms: mono };
        self.lock().insert(config.issuer.clone(), cached.clone());
        Ok(cached)
    }

    /// Checks an ID token; a key the cached set does not have reloads the set once (at most every
    /// `oidc::KEY_RELOAD_INTERVAL`), so keys the provider rotated are found.
    #[expect(clippy::too_many_arguments, reason = "the token, what it must say and the two clocks")]
    pub async fn check_id_token(
        &self,
        http: &Fetcher,
        config: &OidcConfig,
        cached: &Cached,
        token: &str,
        nonce: &str,
        now_ms: i64,
        mono: i64,
    ) -> Result<Map<String, Value>, OidcError> {
        let expected =
            jwt::Expected { issuer: &config.issuer, client_id: &config.client_id, nonce, now_secs: now_ms / 1000 };
        match oidc::check_id_token(token, &cached.keys, &expected) {
            Err(jwt::TokenError::UnknownKey(_)) if self.may_reload_keys(&config.issuer, mono) => {
                let keys = oidc::load_keys(http, &cached.discovery.jwks_uri).await?;
                let claims = oidc::check_id_token(token, &keys, &expected);
                if let Some(c) = self.lock().get_mut(&config.issuer) {
                    c.keys = keys;
                }
                Ok(claims?)
            }
            other => Ok(other?),
        }
    }

    /// Whether the keys of `issuer` may be read again now; claims the reload when they may.
    fn may_reload_keys(&self, issuer: &str, mono: i64) -> bool {
        match self.lock().get_mut(issuer) {
            Some(c) if mono - c.keys_loaded_ms >= ms(oidc::KEY_RELOAD_INTERVAL) => {
                c.keys_loaded_ms = mono;
                true
            }
            Some(_) => false,
            None => true,
        }
    }

    /// Drops what is kept of `issuer` (its settings changed).
    pub fn forget(&self, issuer: &str) {
        self.lock().remove(issuer);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Cached>> {
        self.cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn ms(d: Duration) -> i64 {
    i64::try_from(d.as_millis()).unwrap_or(i64::MAX)
}

/// The address the server is reached at, for redirect URIs: `server.public_url`, else the scheme
/// and host of the request.
pub fn public_base(state: &AppState, info: &RequestInfo) -> String {
    if let Some(url) = &state.config.server.public_url {
        return url.trim_end_matches('/').to_string();
    }
    let scheme = if info.https { "https" } else { "http" };
    let host = info.host.clone().unwrap_or_else(|| "localhost".into());
    format!("{scheme}://{host}")
}

pub fn redirect_uri(base: &str, slug: &str) -> String {
    format!("{base}/auth/oidc/{slug}/callback")
}

/// A path on this server to return to after the sign-in; anything else is `/`. Dot segments are
/// resolved first, as the UI's `safeRedirect` does, so `/..//evil.example` cannot become
/// `//evil.example`.
pub fn safe_return_to(raw: Option<&str>) -> String {
    let Some(p) = raw.filter(|p| {
        p.starts_with('/') && !p.starts_with("//") && p.len() <= 2048 && !p.chars().any(|c| c.is_control() || c == '\\')
    }) else {
        return "/".into();
    };
    let base = url::Url::parse("http://kalzit.invalid/").expect("a valid base");
    let Ok(url) = base.join(p) else { return "/".into() };
    if url.origin() != base.origin() {
        return "/".into();
    }
    let mut out = url.path().to_string();
    if let Some(q) = url.query() {
        out.push('?');
        out.push_str(q);
    }
    if let Some(f) = url.fragment() {
        out.push('#');
        out.push_str(f);
    }
    if out.starts_with("//") { "/".into() } else { out }
}

/// Tells this server's query cache and the other servers that the rights of `orgs` changed
/// (after a group mapping applied), as `routes::table` does for routes that change rights.
pub async fn rights_changed(state: &AppState, orgs: &std::collections::BTreeSet<String>) {
    for org in orgs {
        state.datasources.query_cache().rights_changed_here(Some(org));
        state.cluster.announce(&state.db, crate::cluster::Change::Rights(Some(org.clone()))).await;
    }
}

/// An error id for the person to pass on (`7Q2K-91XD`), which leads admins to the audit entry.
pub fn error_ref() -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let bytes: [u8; 8] = rand::random();
    let chars: String = bytes.iter().map(|b| ALPHABET[usize::from(b % 32)] as char).collect();
    format!("{}-{}", &chars[..4], &chars[4..])
}

/// Slugs: 1 to 40 of `a-z`, `0-9` and `-`, starting with a letter or digit.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 40
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
}

/// The server's rules for the password sign-in.
#[derive(Clone, Debug)]
pub struct LocalPolicy {
    pub local_on: bool,
    pub password_form: String,
    pub break_glass: Option<String>,
}

async fn text_setting(state: &AppState, key: &str) -> ApiResult<String> {
    Ok(crate::settings::get(state, key).await?.as_str().unwrap_or_default().to_string())
}

pub async fn local_policy(state: &AppState) -> ApiResult<LocalPolicy> {
    let break_glass = text_setting(state, "signin.break_glass_user").await?;
    Ok(LocalPolicy {
        local_on: text_setting(state, "signin.local_password").await? != "off",
        password_form: text_setting(state, "signin.password_form").await?,
        break_glass: (!break_glass.is_empty()).then_some(break_glass),
    })
}

pub async fn unmapped(state: &AppState) -> ApiResult<mapping::Unmapped> {
    let org = text_setting(state, "signin.default_org").await?;
    Ok(mapping::Unmapped {
        refuse: text_setting(state, "signin.unmapped").await? == "refuse",
        org_id: (!org.is_empty()).then_some(org),
        role: text_setting(state, "signin.default_role").await?,
    })
}

/// Whether a new member of `org_id` who is not a server admin may sign in with a password: the
/// server's rule and that organization's (an invitation accepted with a password, for example).
pub async fn password_sign_in_allowed_in(state: &AppState, org_id: &str) -> ApiResult<bool> {
    if !local_policy(state).await?.local_on {
        return Ok(false);
    }
    Ok(crate::settings::get_org(state, org_id, "signin.local_password").await?.as_str() != Some("off"))
}

/// Whether a person who gave the right password may sign in with it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PasswordSignIn {
    Allowed,
    /// Password sign-in is off for them, and they are the break-glass admin on the break-glass
    /// form: allowed, recorded and announced to every server admin.
    BreakGlass,
    Off,
}

/// The decision for `user_id`; `break_glass_form` is true for `POST /auth/login/local`.
pub async fn password_sign_in(state: &AppState, user_id: &str, break_glass_form: bool) -> ApiResult<PasswordSignIn> {
    let policy = local_policy(state).await?;
    let mut off = !policy.local_on;
    // An organization's "off" is about its members; it never reaches server admins, who answer to
    // the server's rule alone.
    let (server_admin,): (i64,) = sqlx::query_as("SELECT is_server_admin FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&state.read_db)
        .await?;
    if !off && server_admin == 0 {
        let orgs: Vec<(String,)> = sqlx::query_as("SELECT org_id FROM org_members WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(&state.read_db)
            .await?;
        for (org,) in orgs {
            if crate::settings::get_org(state, &org, "signin.local_password").await?.as_str() == Some("off") {
                off = true;
                break;
            }
        }
    }
    Ok(if !off {
        PasswordSignIn::Allowed
    } else if break_glass_form && policy.break_glass.as_deref() == Some(user_id) {
        PasswordSignIn::BreakGlass
    } else {
        PasswordSignIn::Off
    })
}

/// Tells every server admin that the break-glass admin signed in with a password: by mail
/// (`mail::notify_break_glass`), next to the audit entry (`auth.break_glass_signed_in`) and a
/// warning in the server log.
pub fn announce_break_glass(state: &AppState, user_id: &str, info: &RequestInfo) {
    tracing::warn!(user = user_id, client = %info.client_ip, "the break-glass admin signed in with a password");
    crate::mail::notify_break_glass(state, user_id, info.client_ip);
}

/// Deletes sign-ins through providers that ended, on one server only (`cluster::spawn_job`).
pub fn spawn_cleanup(state: AppState) {
    let schedule = crate::db::Schedule { interval: Duration::from_secs(10 * 60), retries: Vec::new() };
    let job_state = state.clone();
    crate::cluster::spawn_job(&state, "sso:sign-ins", "deleting ended single sign-on attempts", schedule, move || {
        let state = job_state.clone();
        async move {
            let now = state.clock.now_ms();
            sqlx::query("DELETE FROM sso_sign_ins WHERE expires_at <= $1")
                .bind(now)
                .execute(state.background.db())
                .await
                .map_err(|e| crate::db::JobError::Failed(e.to_string()))?;
            // A second step that never came: its half-signed-in state lasted minutes.
            sqlx::query("DELETE FROM sso_pending_mappings WHERE created_at <= $1")
                .bind(now - SIGN_IN_TTL_MS)
                .execute(state.background.db())
                .await
                .map_err(|e| crate::db::JobError::Failed(e.to_string()))?;
            Ok(())
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_paths_stay_on_this_server() {
        assert_eq!(safe_return_to(Some("/dashboards/1?x=2")), "/dashboards/1?x=2");
        for bad in [
            "//evil.example",
            "/\\evil.example",
            "https://evil.example",
            "",
            "x",
            "/a\nb",
            "/a\\b",
            "/..//evil.example",
            "/./..//evil.example/x",
        ] {
            assert_eq!(safe_return_to(Some(bad)), "/", "{bad:?}");
        }
        assert_eq!(safe_return_to(None), "/");
        assert_eq!(safe_return_to(Some("/a/../b/./c?x=1#y")), "/b/c?x=1#y");
    }

    #[test]
    fn slugs_and_error_ids() {
        assert!(valid_slug("mueller-sso") && valid_slug("a1"));
        for bad in ["", "-a", "Müller", "a b", "A", &"a".repeat(41)] {
            assert!(!valid_slug(bad), "{bad}");
        }
        let id = error_ref();
        assert_eq!(id.len(), 9);
        assert_eq!(&id[4..5], "-");
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_uppercase() || c.is_ascii_digit()));
    }
}
