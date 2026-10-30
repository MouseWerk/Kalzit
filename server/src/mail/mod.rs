//! Mail: the mail server's settings, the SMTP client, the messages and their texts, and the
//! one-time links invitations and password resets send (docs/ARCHITECTURE.md, "Mail, invitations
//! and password reset").

pub mod cleanup;
pub mod links;
pub mod message;
pub mod settings;
pub mod smtp;
pub mod templates;

#[cfg(test)]
mod fake;

use std::sync::Arc;

use crate::app::AppState;
use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::error::{ApiError, ApiResult};
use crate::plugins::connector::OwnEndpoints;

/// Password reset requests per client address (IPv4 address, IPv6 /64) in `RESET_WINDOW_SECS`.
pub const RESET_PER_ADDRESS: u32 = 10;
/// ... per network (IPv4 /24, IPv6 /48).
pub const RESET_PER_NETWORK: u32 = 30;
pub const RESET_WINDOW_SECS: u64 = 15 * 60;
/// Password reset mails per account (by email, whether or not an account has it) per hour.
pub const RESET_PER_ACCOUNT: u32 = 3;
pub const RESET_ACCOUNT_WINDOW_SECS: u64 = 60 * 60;
/// Links that were unknown, used or expired, per client address in `RESET_WINDOW_SECS`.
pub const LINK_FAILURES: u32 = 20;
/// Invitations (addresses, new or sent again) per organization per hour.
pub const INVITES_PER_ORG: u32 = 100;
/// Password links admins send to one member per hour.
pub const MEMBER_LINKS: u32 = 5;
/// Mails sent in the background at the same time (password links); beyond, a request's mail is
/// dropped with a warning in the log. The answer never depends on it.
const MAX_BACKGROUND_MAILS: usize = 32;

/// The mail parts of the server's state: the rate limits of password resets and links, and what
/// connections to the mail server need.
pub struct Mail {
    pub reset_address: RateLimiter,
    pub reset_network: RateLimiter,
    pub reset_account: RateLimiter,
    pub link_failures: RateLimiter,
    /// Invitations per organization (`INVITES_PER_ORG`).
    pub invites: RateLimiter,
    /// Password links admins send to a member, per member (`MEMBER_LINKS`): apart from the
    /// requests anyone can make, so those never use up an admin's sending and the other way round.
    pub member_links: RateLimiter,
    own: tokio::sync::OnceCell<Arc<OwnEndpoints>>,
    tls: tokio::sync::OnceCell<Arc<rustls::ClientConfig>>,
    background: Arc<tokio::sync::Semaphore>,
}

impl Default for Mail {
    fn default() -> Self {
        Self {
            reset_address: RateLimiter::new(RESET_PER_ADDRESS, RESET_WINDOW_SECS, Capacity::LARGE),
            reset_network: RateLimiter::new(RESET_PER_NETWORK, RESET_WINDOW_SECS, Capacity::LARGE),
            // Anyone can make up emails, so the table is bounded; a full table counts nothing new
            // rather than refusing, so it answers alike for every email.
            reset_account: RateLimiter::new(RESET_PER_ACCOUNT, RESET_ACCOUNT_WINDOW_SECS, Capacity::LARGE),
            link_failures: RateLimiter::new(LINK_FAILURES, RESET_WINDOW_SECS, Capacity::LARGE),
            invites: RateLimiter::new(INVITES_PER_ORG, 3600, Capacity::SMALL),
            member_links: RateLimiter::new(MEMBER_LINKS, 3600, Capacity::SMALL),
            own: tokio::sync::OnceCell::new(),
            tls: tokio::sync::OnceCell::new(),
            background: Arc::new(tokio::sync::Semaphore::new(MAX_BACKGROUND_MAILS)),
        }
    }
}

impl Mail {
    /// Runs `task` (a mail sent after the answer went out) as background work of the server, so
    /// a stop aborts it. Skipped when too many are running already.
    pub fn spawn(&self, state: &AppState, task: impl Future<Output = ()> + Send + 'static) {
        let Ok(permit) = self.background.clone().try_acquire_owned() else {
            tracing::warn!("too many mails are being sent at the moment; one mail was not sent");
            return;
        };
        state.background.spawn(async move {
            let _permit = permit;
            task.await;
        });
    }

    /// Waits until no background mail is in flight (tests).
    pub async fn settle(&self) {
        let _all = self.background.acquire_many(MAX_BACKGROUND_MAILS as u32).await;
    }
}

/// How to reach the mail server now: the target rules in force, Kalzit's own endpoints and the
/// platform's certificates.
pub async fn connector(state: &AppState) -> ApiResult<smtp::Connector> {
    let policy = state.datasources.policy(state).await?;
    let config = state.config.clone();
    let own = state
        .mail
        .own
        .get_or_try_init(|| async move {
            // Resolves the database's host once; blocking, so off the runtime's threads.
            tokio::task::spawn_blocking(move || Arc::new(OwnEndpoints::from_config(&config))).await
        })
        .await
        .map_err(|e| ApiError::internal("Kalzit's own endpoints", e))?
        .clone();
    let tls = state
        .mail
        .tls
        .get_or_try_init(|| async { smtp::platform_tls().map(Arc::new) })
        .await
        .map_err(|e| ApiError::internal("TLS for mail", e))?
        .clone();
    Ok(smtp::Connector { policy, own, tls, step_timeout: smtp::STEP_TIMEOUT })
}

/// The public address links point to (`server.public_url`), without a trailing slash.
pub fn public_url(state: &AppState) -> Option<String> {
    state.config.server.public_url.as_deref().map(|u| u.trim_end_matches('/').to_string()).filter(|u| !u.is_empty())
}

/// The server's host, as mails name their sender.
pub fn host(state: &AppState) -> String {
    public_url(state)
        .and_then(|u| url::Url::parse(&u).ok())
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "Kalzit".to_string())
}

/// A link to a page of the UI with the token in the fragment, which browsers never send to a
/// server: it stays out of access logs, proxies and `Referer`.
pub fn link(public: &str, page: &str, token: &str) -> String {
    format!("{public}/{page}#{token}")
}

/// Whether links can be sent by mail: a mail server and the public address are set.
pub async fn can_send_links(state: &AppState) -> ApiResult<bool> {
    Ok(public_url(state).is_some() && settings::effective(state).await?.configured())
}

/// The language of mails to a user: their own choice, else the server's default.
pub async fn language(state: &AppState, user_id: Option<&str>) -> ApiResult<templates::Lang> {
    if let Some(user_id) = user_id {
        let chosen: Option<(Option<String>,)> =
            sqlx::query_as("SELECT language FROM user_preferences WHERE user_id = $1")
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?;
        if let Some((Some(language),)) = chosen {
            return Ok(templates::Lang::parse(&language));
        }
    }
    let default = crate::settings::get(state, "appearance.default_language").await?;
    Ok(templates::Lang::parse(default.as_str().unwrap_or("en")))
}

/// The time zone mails of an organization name times in: the organization's, else the server's;
/// `None` when neither names one (then UTC).
pub async fn time_zone(state: &AppState, org_id: Option<&str>) -> ApiResult<Option<String>> {
    if let Some(org_id) = org_id {
        let value = crate::settings::get_org(state, org_id, "appearance.time_zone").await?;
        if let Some(zone) = value.as_str().filter(|z| *z != "inherit" && *z != "browser") {
            return Ok(Some(zone.to_string()));
        }
    }
    let value = crate::settings::get(state, "appearance.time_zone").await?;
    Ok(value.as_str().filter(|z| *z != "browser").map(str::to_string))
}

/// Tells a person by mail about a change of their second factor (`auth::second_factor::notify`):
/// in the background, in their language, when the server can send mail. Nothing is sent
/// otherwise; the audit log is the record.
pub fn notify_second_factor(state: &AppState, user_id: &str, notice: crate::auth::second_factor::Notice) {
    let background = state.clone();
    let user_id = user_id.to_string();
    state.mail.spawn(state, async move {
        let run = async {
            let effective = settings::effective(&background).await?;
            if !effective.configured() {
                return Ok(());
            }
            let row: Option<(String,)> = sqlx::query_as("SELECT email FROM users WHERE id = $1 AND disabled = 0")
                .bind(&user_id)
                .fetch_optional(&background.db)
                .await?;
            let Some((email,)) = row else { return Ok(()) };
            let lang = language(&background, Some(&user_id)).await?;
            let content = templates::second_factor_notice(lang, notice, &host(&background));
            send(&background, &effective, &email, &content).await.map_err(smtp::SendError::into_api)?;
            Ok::<(), ApiError>(())
        };
        if let Err(e) = run.await {
            tracing::warn!(user = %user_id, "a second factor notice was not sent: {}", e.message);
        }
    });
}

/// Sends `content` to `to` with the settings in force.
pub async fn send(
    state: &AppState,
    effective: &settings::Effective,
    to: &str,
    content: &message::Content,
) -> Result<smtp::Delivered, smtp::SendError> {
    let Some(smtp_settings) = &effective.settings else {
        return Err(not_configured());
    };
    let connector = connector(state).await.map_err(|e| internal_send_error(&e.message))?;
    let data = message::Message {
        from_name: &smtp_settings.from_name,
        from_address: &smtp_settings.from_address,
        to,
        reply_to: Some(smtp_settings.reply_to.as_str()),
        content,
        date_ms: state.clock.now_ms(),
    }
    .render();
    let hello = smtp::hello_name(state.config.server.public_url.as_deref());
    let mail = smtp::Outgoing { from: &smtp_settings.from_address, to, data: &data };
    smtp::deliver(&connector, smtp_settings, effective.password.as_deref().map(|p| p.as_str()), &hello, Some(&mail))
        .await
}

fn not_configured() -> smtp::SendError {
    smtp::SendError {
        field: None,
        reason: "mail.not_configured",
        params: Default::default(),
        message: "no mail server is set up".into(),
        connection: true,
    }
}

fn internal_send_error(message: &str) -> smtp::SendError {
    smtp::SendError {
        field: None,
        reason: "mail.connection_lost",
        params: [("detail".to_string(), message.to_string())].into(),
        message: message.to_string(),
        connection: true,
    }
}
