//! The mail server: where Kalzit sends invitations, password links and test mails. The fields
//! depend on each other (port and encryption, user and password), so the settings page saves them
//! together after a check (docs/api/mail.md). `kalzit.toml` or `KALZIT_SMTP_*` may set them
//! instead; then they are read-only in the UI.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::app::AppState;
use crate::config::{Config, SmtpConfig, Source};
use crate::error::{ApiError, ApiResult};
use crate::secrets::{Blob, Keyring};

/// The key of the stored settings in `server_settings` (versioned like the other settings).
pub const SETTINGS_KEY: &str = "mail.smtp";
/// The password's row in `server_secrets`.
pub const SECRET_OWNER: &str = "mail";
pub const PASSWORD_FIELD: &str = "smtp_password";

const MAX_HOST_CHARS: usize = 253;
const MAX_USER_CHARS: usize = 254;
const MAX_NAME_CHARS: usize = 100;
/// Longer passwords are refused before they reach a mail server.
pub const MAX_PASSWORD_CHARS: usize = 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Plain connection, then `STARTTLS` before anything else is sent (usually port 587).
    #[default]
    Starttls,
    /// TLS from the first byte (usually port 465).
    Tls,
    /// No encryption: only for a relay on this machine, and only from `kalzit.toml`.
    None,
}

impl Security {
    pub fn name(self) -> &'static str {
        match self {
            Security::Starttls => "starttls",
            Security::Tls => "tls",
            Security::None => "none",
        }
    }

    pub fn default_port(self) -> u16 {
        match self {
            Security::Starttls => 587,
            Security::Tls => 465,
            Security::None => 25,
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "starttls" => Some(Security::Starttls),
            "tls" => Some(Security::Tls),
            "none" => Some(Security::None),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SmtpSettings {
    pub host: String,
    /// 0: the usual port of `security`.
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub security: Security,
    /// Empty: the server takes mail without signing in.
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub from_name: String,
    pub from_address: String,
    /// Optional; where answers to Kalzit's mails go.
    #[serde(default)]
    pub reply_to: String,
}

impl SmtpSettings {
    /// Trims every field, lowercases the host and fills in the port of the encryption.
    pub fn normalized(mut self) -> Self {
        self.host = self.host.trim().trim_end_matches('.').to_ascii_lowercase();
        self.username = self.username.trim().to_string();
        self.from_name = self.from_name.trim().to_string();
        self.from_address = self.from_address.trim().to_lowercase();
        self.reply_to = self.reply_to.trim().to_lowercase();
        if self.port == 0 {
            self.port = self.security.default_port();
        }
        self
    }

    /// Whether a password stored for `other` may be used with these settings: only towards the
    /// same server and account, so a changed host cannot carry the stored password elsewhere.
    pub fn same_account(&self, other: &SmtpSettings) -> bool {
        self.host == other.host && self.port == other.port && self.username == other.username
    }
}

/// A field problem, as the API answers it.
fn field_error(field: &'static str, reason: &'static str, message: &str) -> ApiError {
    ApiError::validation(message.to_string()).with_field(field).because(reason)
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

fn is_address(s: &str) -> bool {
    crate::routes::normalize_email(s).is_ok() && !s.contains(['<', '>', '"', ',', ';', '(', ')', '\\'])
}

/// Whether `host` is a loopback address or `localhost`.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.to_canonical().is_loopback())
}

/// The checks that need no network. `from_ui`: settings from the settings page, which offers
/// STARTTLS and TLS only.
pub fn check(settings: &SmtpSettings, from_ui: bool) -> ApiResult<()> {
    let host = settings.host.trim_start_matches('[').trim_end_matches(']');
    let host_ok = !host.is_empty()
        && host.chars().count() <= MAX_HOST_CHARS
        && (crate::datasources::targets::parse_ip_literal(&settings.host).is_some()
            || crate::datasources::targets::is_host_name(host));
    if !host_ok {
        return Err(field_error("host", "mail.host_invalid", "enter the mail server's host name or address"));
    }
    if settings.port == 0 {
        return Err(field_error("port", "mail.port_invalid", "the port is 1 to 65535"));
    }
    match settings.security {
        Security::None if from_ui => {
            return Err(field_error(
                "security",
                "mail.unencrypted_only_in_file",
                "a mail server without encryption can only be set in kalzit.toml, for a relay on this machine",
            ));
        }
        Security::None if !is_loopback_host(&settings.host) => {
            return Err(field_error(
                "security",
                "mail.unencrypted_not_local",
                "without encryption Kalzit only talks to a relay on this machine (localhost)",
            ));
        }
        _ => {}
    }
    // The usual ports speak one way; the other one hangs or fails without a useful answer.
    if settings.security == Security::Starttls && settings.port == 465 {
        return Err(field_error(
            "port",
            "mail.port_speaks_tls",
            "port 465 speaks TLS directly, but STARTTLS is chosen; use port 587 or choose TLS",
        ));
    }
    if settings.security == Security::Tls && matches!(settings.port, 25 | 587) {
        return Err(ApiError::validation(
            "this port starts without TLS and uses STARTTLS; choose STARTTLS or port 465",
        )
        .with_field("port")
        .because("mail.port_speaks_starttls")
        .param("port", settings.port));
    }
    if settings.username.chars().count() > MAX_USER_CHARS || has_control(&settings.username) {
        return Err(field_error(
            "username",
            "mail.username_invalid",
            "the user name is too long or has control characters",
        ));
    }
    if settings.from_name.chars().count() > MAX_NAME_CHARS || has_control(&settings.from_name) {
        return Err(field_error("fromName", "mail.from_name_invalid", "the sender name has at most 100 characters"));
    }
    if !is_address(&settings.from_address) {
        return Err(field_error("fromAddress", "mail.address_invalid", "enter a complete email address"));
    }
    if !settings.reply_to.is_empty() && !is_address(&settings.reply_to) {
        return Err(field_error("replyTo", "mail.address_invalid", "enter a complete email address"));
    }
    Ok(())
}

/// The settings `kalzit.toml` or the environment give, if any.
pub fn from_config(config: &SmtpConfig) -> anyhow::Result<Option<SmtpSettings>> {
    if config.host.trim().is_empty() {
        return Ok(None);
    }
    let Some(security) = Security::parse(&config.security) else {
        anyhow::bail!("smtp.security must be \"starttls\", \"tls\" or \"none\"");
    };
    let settings = SmtpSettings {
        host: config.host.clone(),
        port: config.port,
        security,
        username: config.username.clone(),
        from_name: config.from_name.clone(),
        from_address: config.from_address.clone(),
        reply_to: config.reply_to.clone(),
    }
    .normalized();
    Ok(Some(settings))
}

/// The start refuses mail settings in the file or environment that the settings page would
/// refuse too, with the field and what is wrong.
pub fn check_config(config: &SmtpConfig) -> anyhow::Result<()> {
    let Some(settings) = from_config(config)? else {
        let set = [&config.username, &config.password, &config.from_address, &config.from_name, &config.reply_to];
        if set.iter().any(|v| !v.trim().is_empty()) {
            anyhow::bail!("smtp.host is not set, so the other smtp settings have no mail server to apply to");
        }
        return Ok(());
    };
    check(&settings, false)
        .map_err(|e| anyhow::anyhow!("smtp.{}: {}", e.field.map(camel_to_snake).unwrap_or_default(), e.message))?;
    if config.password.chars().count() > MAX_PASSWORD_CHARS {
        anyhow::bail!("smtp.password is longer than {MAX_PASSWORD_CHARS} characters");
    }
    Ok(())
}

fn camel_to_snake(field: &str) -> String {
    let mut out = String::new();
    for c in field.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Where the mail settings in force come from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingsSource {
    /// Nothing set: no mail server.
    Default,
    /// The settings page.
    Database,
    File,
    Environment,
}

/// The mail settings in force, with the password.
pub struct Effective {
    pub settings: Option<SmtpSettings>,
    pub password: Option<Zeroizing<String>>,
    pub source: SettingsSource,
    /// The stored version, for the explicit save (0: never saved).
    pub version: i64,
}

impl Effective {
    pub fn configured(&self) -> bool {
        self.settings.is_some()
    }
}

fn config_source(config: &Config) -> SettingsSource {
    if config.source("smtp.host") == Source::Environment { SettingsSource::Environment } else { SettingsSource::File }
}

/// The stored settings and their version (`None` before the first save and after a removal).
pub async fn load_stored<'e, E>(db: E) -> ApiResult<(Option<SmtpSettings>, i64)>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    let row: Option<(String, i64)> = sqlx::query_as("SELECT value, version FROM server_settings WHERE key = $1")
        .bind(SETTINGS_KEY)
        .fetch_optional(db)
        .await?;
    let Some((value, version)) = row else { return Ok((None, 0)) };
    let parsed: Option<SmtpSettings> =
        serde_json::from_str(&value).map_err(|e| ApiError::internal("reading the stored mail settings", e))?;
    Ok((parsed, version))
}

/// The settings in force: from the file or environment when they set a host, else the stored
/// ones.
pub async fn effective(state: &AppState) -> ApiResult<Effective> {
    let (stored, version) = load_stored(&state.db).await?;
    let from_file = from_config(&state.config.smtp).map_err(|e| ApiError::internal("mail settings", e))?;
    if let Some(settings) = from_file {
        let password = Some(state.config.smtp.password.clone()).filter(|p| !p.is_empty()).map(Zeroizing::new);
        return Ok(Effective { settings: Some(settings), password, source: config_source(&state.config), version });
    }
    let password = match &stored {
        Some(_) => load_password(&state.db, &state.secrets).await?,
        None => None,
    };
    let source = if stored.is_some() { SettingsSource::Database } else { SettingsSource::Default };
    Ok(Effective { settings: stored, password, source, version })
}

pub async fn load_password(db: &sqlx::AnyPool, keyring: &Keyring) -> ApiResult<Option<Zeroizing<String>>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT key_id, nonce, ciphertext FROM server_secrets WHERE owner = $1 AND field = $2")
            .bind(SECRET_OWNER)
            .bind(PASSWORD_FIELD)
            .fetch_optional(db)
            .await?;
    let Some((key_id, nonce, ciphertext)) = row else { return Ok(None) };
    let plain = keyring
        .decrypt(SECRET_OWNER, PASSWORD_FIELD, &Blob { key_id, nonce, ciphertext })
        .map_err(|e| ApiError::internal("decrypting the mail server password", e))?;
    Ok(Some(plain))
}

/// Stores (`Some`) or removes (`None`) the password inside the caller's transaction.
pub async fn store_password(
    conn: &mut sqlx::AnyConnection,
    keyring: &Keyring,
    password: Option<&str>,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM server_secrets WHERE owner = $1 AND field = $2")
        .bind(SECRET_OWNER)
        .bind(PASSWORD_FIELD)
        .execute(&mut *conn)
        .await?;
    if let Some(plain) = password.filter(|p| !p.is_empty()) {
        let blob = keyring.encrypt(SECRET_OWNER, PASSWORD_FIELD, plain);
        sqlx::query("INSERT INTO server_secrets (owner, field, key_id, nonce, ciphertext) VALUES ($1, $2, $3, $4, $5)")
            .bind(SECRET_OWNER)
            .bind(PASSWORD_FIELD)
            .bind(&blob.key_id)
            .bind(&blob.nonce)
            .bind(&blob.ciphertext)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> SmtpSettings {
        SmtpSettings {
            host: "smtp.example.com".into(),
            port: 587,
            security: Security::Starttls,
            username: "kalzit@example.com".into(),
            from_name: "Kalzit · Müller & Söhne".into(),
            from_address: "kalzit@example.com".into(),
            reply_to: String::new(),
        }
    }

    fn reason(e: ApiError) -> (String, String) {
        (e.field.unwrap_or_default().to_string(), e.reason.map(|r| r.code).unwrap_or_default())
    }

    #[test]
    fn valid_settings_pass_and_the_port_follows_the_encryption() {
        check(&valid(), true).unwrap();
        let tls = SmtpSettings { port: 0, security: Security::Tls, ..valid() }.normalized();
        assert_eq!(tls.port, 465);
        check(&tls, true).unwrap();
    }

    #[test]
    fn mismatched_ports_and_bad_fields_name_their_field() {
        let cases = [
            (SmtpSettings { port: 465, ..valid() }, "port", "mail.port_speaks_tls"),
            (SmtpSettings { security: Security::Tls, ..valid() }, "port", "mail.port_speaks_starttls"),
            (SmtpSettings { host: "bad host".into(), ..valid() }, "host", "mail.host_invalid"),
            (SmtpSettings { from_address: "kalzit@".into(), ..valid() }, "fromAddress", "mail.address_invalid"),
            (SmtpSettings { reply_to: "a <b@c.de>".into(), ..valid() }, "replyTo", "mail.address_invalid"),
            (SmtpSettings { from_name: "a\r\nBcc: x@y.de".into(), ..valid() }, "fromName", "mail.from_name_invalid"),
            (SmtpSettings { security: Security::None, ..valid() }, "security", "mail.unencrypted_only_in_file"),
        ];
        for (settings, field, code) in cases {
            assert_eq!(reason(check(&settings, true).unwrap_err()), (field.to_string(), code.to_string()));
        }
    }

    #[test]
    fn unencrypted_is_for_a_local_relay_from_the_file_only() {
        let local = SmtpSettings { host: "127.0.0.1".into(), port: 25, security: Security::None, ..valid() };
        check(&local, false).unwrap();
        let remote = SmtpSettings { port: 25, security: Security::None, ..valid() };
        assert_eq!(reason(check(&remote, false).unwrap_err()).1, "mail.unencrypted_not_local");
        assert!(is_loopback_host("[::1]") && is_loopback_host("LOCALHOST") && !is_loopback_host("10.0.0.1"));
    }

    #[test]
    fn the_file_section_is_checked_at_start() {
        let mut config = SmtpConfig::default();
        check_config(&config).unwrap();
        config.from_address = "kalzit@example.com".into();
        assert!(check_config(&config).unwrap_err().to_string().contains("smtp.host"));
        config.host = "smtp.example.com".into();
        config.security = "tls".into();
        config.port = 587;
        assert!(check_config(&config).unwrap_err().to_string().starts_with("smtp.port"));
        config.port = 0;
        check_config(&config).unwrap();
        config.security = "ssl".into();
        assert!(check_config(&config).is_err());
    }

    #[test]
    fn a_stored_password_stays_with_its_server_and_account() {
        let a = valid();
        assert!(a.same_account(&SmtpSettings { from_name: "Other".into(), ..valid() }));
        assert!(!a.same_account(&SmtpSettings { host: "evil.example.com".into(), ..valid() }));
        assert!(!a.same_account(&SmtpSettings { username: "other@example.com".into(), ..valid() }));
    }
}
