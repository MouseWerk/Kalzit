//! API tokens: the tokens of service accounts (`kz_sa_...`) and the SCIM token of an organization
//! (`kz_scim_...`). A token is random, shown once when it is made and stored only as its SHA-256,
//! like a session token. A service account token signs a request in as its service account, in
//! its organization only, with the account's role (docs/api/access.md, "Service accounts").
//!
//! Every refused token is counted per client address (`AppState::token_limiter`) and recorded in
//! the audit log with the reason; the answer is the same `401` for every reason, so it tells
//! nothing about the token.

use std::net::IpAddr;

use axum::http::{HeaderMap, StatusCode, header};
use ipnet::IpNet;
use serde_json::json;

use crate::app::AppState;
use crate::auth::SessionUser;
use crate::auth::ratelimit::{address_key, network_key};
use crate::error::{ApiError, ApiResult};
use crate::net::RequestInfo;

pub const SERVICE_ACCOUNT_PREFIX: &str = "kz_sa_";
pub const SCIM_PREFIX: &str = "kz_scim_";
/// Random bytes in a token: 40 hex digits, of which the first 8 are its visible prefix, so 128
/// bits stay secret.
const TOKEN_BYTES: usize = 20;
const VISIBLE_HEX: usize = 8;
const DAY_MS: i64 = 86_400_000;
/// The longest a token may live, and the default.
pub const MAX_DAYS: i64 = 365;
pub const DEFAULT_DAYS: i64 = 90;
/// At most this many lines in a token's IP allow list.
pub const MAX_ALLOWED_IPS: usize = 50;
/// How often the last use of a token is written.
const USE_INTERVAL_MS: i64 = 60_000;

/// What a token is for. The string form is the `kind` column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    ServiceAccount,
    Scim,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ServiceAccount => "service_account",
            Self::Scim => "scim",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Self::ServiceAccount => SERVICE_ACCOUNT_PREFIX,
            Self::Scim => SCIM_PREFIX,
        }
    }
}

/// A new token: the text handed out once, its hash and its visible prefix.
pub struct NewToken {
    pub token: String,
    pub hash: String,
    pub prefix: String,
}

pub fn generate(kind: Kind) -> NewToken {
    let random = hex::encode(rand::random::<[u8; TOKEN_BYTES]>());
    let token = format!("{}{random}", kind.prefix());
    let prefix = format!("{}{}", kind.prefix(), &random[..VISIBLE_HEX]);
    NewToken { hash: hash(&token), token, prefix }
}

pub fn hash(token: &str) -> String {
    crate::auth::session::hash_token(token)
}

/// The API token of a request: `Authorization: Bearer kz_...`. Other schemes and other bearer
/// tokens (a proxy's own, in front of Kalzit) are not ours and are left alone, so the session
/// cookie still counts for them.
pub fn bearer(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer")
        && (token.starts_with(SERVICE_ACCOUNT_PREFIX) || token.starts_with(SCIM_PREFIX)))
    .then(|| token.to_string())
}

/// The expiry of a new token: `days` from now, or the time `at`; neither means the default.
/// Refused outside one minute to `MAX_DAYS` days ahead.
pub fn expiry(now_ms: i64, days: Option<i64>, at: Option<i64>) -> ApiResult<i64> {
    let expires = match (days, at) {
        (Some(_), Some(_)) => {
            return Err(ApiError::validation("give expiresInDays or expiresAt, not both").with_field("expiresAt"));
        }
        (Some(days), None) => now_ms.saturating_add(days.saturating_mul(DAY_MS)),
        (None, Some(at)) => at,
        (None, None) => now_ms + DEFAULT_DAYS * DAY_MS,
    };
    if expires <= now_ms || expires > now_ms + MAX_DAYS * DAY_MS {
        let field = if days.is_some() { "expiresInDays" } else { "expiresAt" };
        return Err(ApiError::validation(format!("a token expires within {MAX_DAYS} days"))
            .because("token.expiry_out_of_range")
            .param("maxDays", MAX_DAYS)
            .with_field(field));
    }
    Ok(expires)
}

/// Checks an IP allow list: one address or network (CIDR) per entry, IPv4 or IPv6. Answers the
/// stored form (canonical, one per line; empty for anywhere).
pub fn allow_list(entries: &[String]) -> ApiResult<String> {
    let entries: Vec<&str> = entries.iter().map(|e| e.trim()).filter(|e| !e.is_empty()).collect();
    if entries.len() > MAX_ALLOWED_IPS {
        return Err(ApiError::validation(format!("at most {MAX_ALLOWED_IPS} addresses or networks"))
            .because("token.ip_too_many")
            .param("max", MAX_ALLOWED_IPS)
            .with_field("allowedIps"));
    }
    let mut out = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let net = entry
            .parse::<IpNet>()
            .ok()
            .or_else(|| entry.parse::<IpAddr>().ok().map(IpNet::from))
            .map(canonical_net)
            .ok_or_else(|| {
                ApiError::validation(format!("line {}: {entry} is not an address or network", index + 1))
                    .because("token.ip_invalid")
                    .param("line", index + 1)
                    .param("value", entry)
                    .with_field("allowedIps")
            })?;
        let text = net.trunc().to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    Ok(out.join("\n"))
}

/// IPv4-mapped IPv6 networks as IPv4, so they match clients the way `RequestInfo` names them.
fn canonical_net(net: IpNet) -> IpNet {
    match net {
        IpNet::V6(v6) => match v6.addr().to_ipv4_mapped() {
            Some(v4) if v6.prefix_len() >= 96 => {
                IpNet::new(IpAddr::V4(v4), v6.prefix_len() - 96).unwrap_or(IpNet::V6(v6))
            }
            _ => IpNet::V6(v6),
        },
        v4 => v4,
    }
}

/// Whether `ip` may use a token with the stored allow list `list`.
pub fn ip_allowed(list: &str, ip: IpAddr) -> bool {
    let ip = ip.to_canonical();
    list.trim().is_empty() || list.lines().filter_map(|l| l.parse::<IpNet>().ok()).any(|net| net.contains(&ip))
}

/// The stored allow list as entries, for the API.
pub fn allow_list_entries(list: &str) -> Vec<String> {
    list.lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// The token a request was signed in with, inserted next to the `SessionUser` (its service
/// account) and the `OrgCtx`. Routes that must not be reached with a token refuse when it is
/// there (`refuse_tokens`).
#[derive(Clone, Debug)]
pub struct TokenCaller {
    pub token_id: String,
    pub service_account_id: String,
}

/// For routes a person must call: managing service accounts and the SCIM token.
pub fn refuse_tokens(caller: Option<&TokenCaller>) -> ApiResult<()> {
    match caller {
        None => Ok(()),
        Some(_) => Err(ApiError::forbidden("API tokens cannot manage service accounts or tokens")
            .because("token.not_for_this_route")),
    }
}

/// The answer for every refused token.
fn refused() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "unauthenticated", "the API token is not valid")
}

/// For a route outside organizations (`/me`, `/admin/...`): tokens act in their organization only.
pub fn org_routes_only() -> ApiError {
    ApiError::forbidden("API tokens work only on the routes of their organization").because("token.org_routes_only")
}

#[derive(sqlx::FromRow)]
struct TokenRow {
    id: String,
    org_id: String,
    kind: String,
    prefix: String,
    allowed_ips: String,
    expires_at: i64,
    revoked_at: Option<i64>,
    last_used_at: Option<i64>,
    last_used_address: Option<String>,
    service_account_id: Option<String>,
    account_disabled: Option<i64>,
    user_email: Option<String>,
    user_name: Option<String>,
    user_disabled: Option<i64>,
}

impl TokenRow {
    /// Why the token cannot be used for this request, or `None`.
    fn refusal(&self, now_ms: i64, ip: IpAddr, org_id: &str) -> Option<&'static str> {
        if self.kind != Kind::ServiceAccount.as_str() {
            // The SCIM token is for the SCIM endpoints only.
            Some("wrong_kind")
        } else if self.revoked_at.is_some() {
            Some("revoked")
        } else if now_ms >= self.expires_at {
            Some("expired")
        } else if self.account_disabled != Some(0) || self.user_disabled != Some(0) {
            Some("account_disabled")
        } else if !ip_allowed(&self.allowed_ips, ip) {
            Some("address_not_allowed")
        } else if self.org_id != org_id {
            Some("other_org")
        } else {
            None
        }
    }
}

/// Signs a request in with `token` for the organization `org_id`: the service account as the
/// `SessionUser`, and the token. The role is looked up by the caller like for anyone else.
pub async fn authenticate(
    state: &AppState,
    info: &RequestInfo,
    token: &str,
    org_id: &str,
) -> ApiResult<(SessionUser, TokenCaller)> {
    let mono = state.clock.monotonic_ms();
    let key = address_key("token", info.client_ip);
    let network = network_key(info.client_ip);
    // Counted before the lookup, under the limiter's lock, so parallel guesses cannot all pass;
    // a token that works gives the attempt back.
    let counted = state
        .token_limiter
        .try_acquire(&key, &network, mono)
        .map_err(|wait| ApiError::rate_limited("too many refused API tokens, wait a few minutes", wait))?;
    let row: Option<TokenRow> = sqlx::query_as(
        "SELECT t.id, t.org_id, t.kind, t.prefix, t.allowed_ips, t.expires_at, t.revoked_at, t.last_used_at, \
         t.last_used_address, t.service_account_id, a.disabled AS account_disabled, u.email AS user_email, \
         u.name AS user_name, u.disabled AS user_disabled FROM api_tokens t \
         LEFT JOIN service_accounts a ON a.id = t.service_account_id LEFT JOIN users u ON u.id = a.id \
         WHERE t.token_hash = $1",
    )
    .bind(hash(token))
    .fetch_optional(&state.read_db)
    .await?;
    let now = state.clock.now_ms();
    let refusal = match &row {
        None => Some("unknown"),
        Some(r) => r.refusal(now, info.client_ip, org_id),
    };
    if let Some(reason) = refusal {
        record_refusal(state, info, row.as_ref(), reason, now).await;
        // A token of another organization answers like an organization the caller is not in.
        return Err(if reason == "other_org" { ApiError::not_found() } else { refused() });
    }
    state.token_limiter.refund(&key, &counted);
    let (Some(row), Some(account_id), Some(email), Some(name)) = (
        row.as_ref(),
        row.as_ref().and_then(|r| r.service_account_id.clone()),
        row.as_ref().and_then(|r| r.user_email.clone()),
        row.as_ref().and_then(|r| r.user_name.clone()),
    ) else {
        return Err(refused());
    };
    let address = info.client_ip.to_string();
    let due = row.last_used_at.is_none_or(|at| now - at >= USE_INTERVAL_MS);
    if due || row.last_used_address.as_deref() != Some(address.as_str()) {
        state.touches.token_used(row.id.clone(), now, address);
    }
    let user = SessionUser { id: account_id.clone(), email, name, is_server_admin: 0 };
    Ok((user, TokenCaller { token_id: row.id.clone(), service_account_id: account_id }))
}

/// Writes the audit entry of a refused token. The token itself is never recorded: its prefix when
/// it is known, else only that it was unknown. A busy database does not change the answer.
async fn record_refusal(state: &AppState, info: &RequestInfo, row: Option<&TokenRow>, reason: &str, now: i64) {
    tracing::info!(client = %info.client_ip, reason, "refused an API token");
    let summary = match row {
        Some(r) => json!({ "reason": reason, "prefix": r.prefix, "kind": r.kind }),
        None => json!({ "reason": reason }),
    };
    let event = crate::audit::AuditEvent {
        org_id: row.map(|r| r.org_id.as_str()),
        actor_user_id: None,
        actor_address: Some(info.client_ip.to_string()),
        action: "api_token.refused",
        resource_type: Some("api_token"),
        resource_id: row.map(|r| r.id.as_str()),
        summary,
        at_ms: now,
    };
    let recorded = match state.db.acquire().await {
        Ok(mut conn) => crate::audit::record(&mut conn, &event).await,
        Err(e) => Err(e),
    };
    if let Err(e) = recorded {
        tracing::warn!(client = %info.client_ip, "recording a refused API token in the audit log failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason_of(e: &ApiError) -> Option<&str> {
        e.reason.as_ref().map(|r| r.code.as_str())
    }

    fn param_of<'a>(e: &'a ApiError, name: &str) -> Option<&'a str> {
        e.reason.as_ref().and_then(|r| r.params.get(name)).map(String::as_str)
    }

    #[test]
    fn tokens_have_their_prefix_and_only_the_hash_is_kept() {
        let a = generate(Kind::ServiceAccount);
        assert!(a.token.starts_with("kz_sa_") && a.token.len() == 6 + 40, "{}", a.token);
        assert_eq!(a.prefix, a.token[..14]);
        assert_eq!(a.hash, hash(&a.token));
        assert_ne!(a.hash, a.token);
        let s = generate(Kind::Scim);
        assert!(s.token.starts_with("kz_scim_") && s.prefix.len() == 16);
        assert_ne!(generate(Kind::ServiceAccount).token, a.token);
    }

    #[test]
    fn only_our_bearer_tokens_are_read() {
        let mut h = HeaderMap::new();
        assert_eq!(bearer(&h), None);
        h.insert(header::AUTHORIZATION, "Bearer kz_sa_abc".parse().unwrap());
        assert_eq!(bearer(&h).as_deref(), Some("kz_sa_abc"));
        h.insert(header::AUTHORIZATION, "bearer  kz_scim_abc ".parse().unwrap());
        assert_eq!(bearer(&h).as_deref(), Some("kz_scim_abc"));
        for other in ["Basic a2Fseml0OnB3", "Bearer eyJhbGciOi", "kz_sa_abc", "Token kz_sa_abc"] {
            h.insert(header::AUTHORIZATION, other.parse().unwrap());
            assert_eq!(bearer(&h), None, "{other}");
        }
    }

    #[test]
    fn expiry_defaults_to_90_days_and_stays_within_a_year() {
        let now = 1_800_000_000_000;
        assert_eq!(expiry(now, None, None).unwrap(), now + 90 * DAY_MS);
        assert_eq!(expiry(now, Some(30), None).unwrap(), now + 30 * DAY_MS);
        assert_eq!(expiry(now, Some(365), None).unwrap(), now + 365 * DAY_MS);
        assert_eq!(expiry(now, None, Some(now + 5 * DAY_MS)).unwrap(), now + 5 * DAY_MS);
        for (days, at) in
            [(Some(366), None), (Some(0), None), (Some(-1), None), (None, Some(now)), (None, Some(now + 366 * DAY_MS))]
        {
            let e = expiry(now, days, at).unwrap_err();
            assert_eq!(reason_of(&e), Some("token.expiry_out_of_range"), "{days:?} {at:?}");
        }
        assert_eq!(expiry(now, Some(1), Some(now + 1)).unwrap_err().field, Some("expiresAt"));
    }

    #[test]
    fn allow_lists_are_checked_and_matched() {
        let list =
            allow_list(&["10.20.8.0/24".into(), " 10.20.9.14 ".into(), "".into(), "2001:db8::/48".into()]).unwrap();
        assert_eq!(list, "10.20.8.0/24\n10.20.9.14/32\n2001:db8::/48");
        assert!(ip_allowed(&list, "10.20.8.31".parse().unwrap()));
        assert!(ip_allowed(&list, "::ffff:10.20.9.14".parse().unwrap()), "IPv4-mapped clients match");
        assert!(ip_allowed(&list, "2001:db8:0:1::5".parse().unwrap()));
        assert!(!ip_allowed(&list, "10.20.10.1".parse().unwrap()));
        assert!(ip_allowed("", "192.0.2.1".parse().unwrap()), "an empty list allows every address");
        assert_eq!(allow_list(&["::ffff:10.0.0.0/104".into()]).unwrap(), "10.0.0.0/8");
        assert_eq!(allow_list(&["10.0.0.7/8".into()]).unwrap(), "10.0.0.0/8", "host bits are dropped");

        let e = allow_list(&["10.20.8.0/24".into(), "10.20.9.14".into(), "10.20.0.0/33".into()]).unwrap_err();
        assert_eq!(reason_of(&e), Some("token.ip_invalid"));
        assert_eq!(param_of(&e, "line"), Some("3"));
        assert_eq!(param_of(&e, "value"), Some("10.20.0.0/33"));
        let many: Vec<String> = (0..51).map(|i| format!("10.0.0.{i}")).collect();
        assert_eq!(reason_of(&allow_list(&many).unwrap_err()), Some("token.ip_too_many"));
    }
}
