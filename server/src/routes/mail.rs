//! The mail server, for server administrators (docs/api/mail.md, "Mail server"). The settings are
//! dependent fields, so they are saved in one step after a check that connects and signs in; a
//! test mail sends one message with the values in the form, saved or not.

use axum::extract::State;
use axum::http::{Method, StatusCode};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::Access;
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::mail::settings::{self, SettingsSource, SmtpSettings};
use crate::mail::{self, smtp, templates};
use crate::net::RequestInfo;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/admin/mail", Access::ServerAdmin, view),
        route(Method::PUT, "/admin/mail", Access::ServerAdmin, save),
        route(Method::POST, "/admin/mail/test", Access::ServerAdmin, test),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailView {
    /// `null`: no mail server.
    settings: Option<SmtpSettings>,
    /// A password is stored (never sent back).
    has_password: bool,
    source: SettingsSource,
    /// The settings page may change them (not set by the file or the environment).
    editable: bool,
    version: i64,
    /// `server.public_url`, which every link in a mail starts with; without it no links are sent.
    public_url: Option<String>,
}

async fn load_view(state: &AppState) -> ApiResult<MailView> {
    let effective = settings::effective(state).await?;
    let editable = matches!(effective.source, SettingsSource::Default | SettingsSource::Database);
    Ok(MailView {
        has_password: effective.password.is_some(),
        settings: effective.settings,
        source: effective.source,
        editable,
        version: effective.version,
        public_url: mail::public_url(state),
    })
}

async fn view(State(state): State<AppState>) -> ApiResult<Json<MailView>> {
    Ok(Json(load_view(&state).await?))
}

/// The password a request names: `None` keeps the stored one (when the server and account stay
/// the same), `""` clears it, anything else replaces it.
fn password_field(raw: Option<String>) -> ApiResult<Option<Zeroizing<String>>> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.chars().count() > settings::MAX_PASSWORD_CHARS || raw.chars().any(char::is_control) {
        return Err(ApiError::validation("the password is too long or has control characters")
            .with_field("password")
            .because("mail.password_invalid"));
    }
    Ok(Some(Zeroizing::new(raw)))
}

/// The password to use with `settings`: the one sent, else the stored one when it belongs to the
/// same server and account (so changing the host cannot send the stored password elsewhere).
async fn password_for(
    state: &AppState,
    settings: &SmtpSettings,
    sent: Option<Zeroizing<String>>,
) -> ApiResult<Option<Zeroizing<String>>> {
    if let Some(sent) = sent {
        return Ok(Some(sent).filter(|p| !p.is_empty()));
    }
    if settings.username.is_empty() {
        return Ok(None);
    }
    let (stored, _) = settings::load_stored(&state.db).await?;
    let same = stored.as_ref().is_some_and(|s| s.same_account(settings));
    let password = if same { settings::load_password(&state.db, &state.secrets).await? } else { None };
    match password {
        Some(p) => Ok(Some(p)),
        None => Err(ApiError::validation("enter the password for this server and user")
            .with_field("password")
            .because("mail.password_required")),
    }
}

fn not_editable() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "conflict", "the mail server is set in kalzit.toml or the environment")
        .because("mail.set_in_file")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBody {
    /// `null` removes the mail server.
    settings: Option<SmtpSettings>,
    #[serde(default)]
    password: Option<String>,
    version: i64,
}

async fn save(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<SaveBody>,
) -> ApiResult<Json<MailView>> {
    let current = settings::effective(&state).await?;
    if !matches!(current.source, SettingsSource::Default | SettingsSource::Database) {
        return Err(not_editable());
    }
    let sent = password_field(body.password)?;
    let normalized = body.settings.map(SmtpSettings::normalized);
    let password = match &normalized {
        Some(s) => {
            settings::check(s, true)?;
            let password = password_for(&state, s, sent).await?;
            // The same check a test mail makes, up to the sign-in; nothing is sent.
            let connector = mail::connector(&state).await?;
            let hello = smtp::hello_name(state.config.server.public_url.as_deref());
            smtp::deliver(&connector, s, password.as_deref().map(|p| p.as_str()), &hello, None)
                .await
                .map_err(smtp::SendError::into_api)?;
            password
        }
        None => None,
    };
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    let stored = match &normalized {
        Some(s) => {
            let value = serde_json::to_value(s).map_err(|e| ApiError::internal("mail settings", e))?;
            crate::settings::store(&mut tx, None, settings::SETTINGS_KEY, &value, body.version, &user.id, now).await?
        }
        None => crate::settings::reset(&mut tx, None, settings::SETTINGS_KEY, body.version, &user.id, now).await?,
    };
    if stored.is_none() {
        drop(tx);
        return Err(ApiError::version_conflict(json!(load_view(&state).await?)));
    }
    let password_changed = match &normalized {
        Some(s) if s.username.is_empty() => {
            settings::store_password(&mut tx, &state.secrets, None).await?;
            current.password.is_some()
        }
        Some(_) => {
            settings::store_password(&mut tx, &state.secrets, password.as_deref().map(|p| p.as_str())).await?;
            password.as_deref() != current.password.as_deref()
        }
        None => {
            settings::store_password(&mut tx, &state.secrets, None).await?;
            current.password.is_some()
        }
    };
    let summary = match &normalized {
        Some(s) => json!({
            "host": s.host,
            "port": s.port,
            "security": s.security.name(),
            "signIn": !s.username.is_empty(),
            "passwordChanged": password_changed,
        }),
        None => json!({ "removed": true }),
    };
    let event = crate::audit::AuditEvent {
        org_id: None,
        actor_user_id: Some(&user.id),
        actor_address: Some(info.client_ip.to_string()),
        action: "mail.settings_changed",
        resource_type: Some("mail"),
        resource_id: None,
        summary,
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    crate::settings::cache(&state).invalidate(None);
    Ok(Json(load_view(&state).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestBody {
    /// The values in the form; `null` tests the settings in force.
    #[serde(default)]
    settings: Option<SmtpSettings>,
    #[serde(default)]
    password: Option<String>,
    to: String,
}

/// Test mails per administrator in the connection test window (`routes::datasources::PROBE_*`).
async fn test(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    JsonBody(body): JsonBody<TestBody>,
) -> ApiResult<Json<smtp::Delivered>> {
    let to = super::normalize_email(&body.to).map_err(|e| e.with_field("to"))?;
    let sent = password_field(body.password)?;
    let effective = settings::effective(&state).await?;
    let (smtp_settings, password) = match body.settings.map(SmtpSettings::normalized) {
        Some(s) => {
            if !matches!(effective.source, SettingsSource::Default | SettingsSource::Database) {
                return Err(not_editable());
            }
            settings::check(&s, true)?;
            let password = password_for(&state, &s, sent).await?;
            (s, password)
        }
        None => match effective.settings {
            Some(s) => (s, effective.password),
            None => {
                return Err(ApiError::new(StatusCode::CONFLICT, "conflict", "no mail server is set up")
                    .because("mail.not_configured"));
            }
        },
    };
    let mono = state.clock.monotonic_ms();
    let key = format!("mail-test:{}", user.id);
    state
        .probe_limiter
        .try_acquire(&key, &key, mono)
        .map_err(|wait| ApiError::rate_limited("too many test mails, wait a few minutes", wait))?;
    let lang = mail::language(&state, Some(&user.id)).await?;
    let content = templates::test_mail(lang, &mail::host(&state));
    let effective = settings::Effective {
        settings: Some(smtp_settings),
        password,
        source: effective.source,
        version: effective.version,
    };
    let delivered = mail::send(&state, &effective, &to, &content).await.map_err(smtp::SendError::into_api)?;
    Ok(Json(delivered))
}
