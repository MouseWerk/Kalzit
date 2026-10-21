//! The server's own database: SQLite by default, PostgreSQL for larger installations. Both run
//! the same portable migrations through sqlx's `Any` driver.

use anyhow::{Context, Result};
use sqlx::AnyPool;
use sqlx::any::AnyPoolOptions;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub async fn connect(url: &str, max_connections: u32) -> Result<AnyPool> {
    sqlx::any::install_default_drivers();
    let pool = AnyPoolOptions::new()
        .max_connections(max_connections)
        .connect(url)
        .await
        .with_context(|| format!("connecting to the database ({})", redact(url)))?;
    MIGRATOR.run(&pool).await.context("running database migrations")?;
    Ok(pool)
}

/// The URL for log lines and error messages, rebuilt from its parsed parts only: scheme, user
/// name, `***` for a password, host, port and path, and the query with the values of harmless
/// keys. Every other value becomes `***`. When the text is ambiguous (see [`ambiguity`]), only
/// scheme, user and host are shown, since a password may have spilled into port, path or query.
pub fn redact(url: &str) -> String {
    let Ok(parsed) = url::Url::parse(url) else { return "<unparseable database url>".into() };
    let ambiguous = ambiguity(url).is_some();
    let mut out = format!("{}:", parsed.scheme());
    if parsed.has_authority() {
        out.push_str("//");
        let user = parsed.username();
        match (user.is_empty(), parsed.password().is_some()) {
            (false, true) => out.push_str(&format!("{user}:***@")),
            (false, false) => out.push_str(&format!("{user}@")),
            (true, true) => out.push_str(":***@"),
            (true, false) => {}
        }
        out.push_str(parsed.host_str().unwrap_or_default());
    }
    if ambiguous {
        let rest = parsed.port().is_some() || !matches!(parsed.path(), "" | "/") || parsed.query().is_some();
        if rest {
            out.push_str("/***");
        }
        return out;
    }
    if let Some(port) = parsed.port() {
        out.push_str(&format!(":{port}"));
    }
    out.push_str(parsed.path());
    if parsed.query().is_some() {
        let pairs: Vec<String> = parsed
            .query_pairs()
            .map(|(key, value)| {
                let shown = if HARMLESS_PARAMS.contains(&key.to_ascii_lowercase().as_str()) {
                    url::form_urlencoded::byte_serialize(value.as_bytes()).collect::<String>()
                } else {
                    "***".to_string()
                };
                format!("{}={shown}", url::form_urlencoded::byte_serialize(key.as_bytes()).collect::<String>())
            })
            .collect();
        out.push('?');
        out.push_str(&pairs.join("&"));
    }
    out
}

/// Query keys whose values are shown in logs (compared after decoding, without case). Every
/// other value, credentials included, is masked.
const HARMLESS_PARAMS: &[&str] = &[
    "sslmode",
    "ssl-mode",
    "application_name",
    "connect_timeout",
    "target_session_attrs",
    "mode",
    "cache",
    "sslrootcert",
    "ssl-ca",
    "charset",
    "timezone",
];

/// A warning when `url` reads differently than its author probably meant: a second `@`, or a
/// `?` or `#` before the last `@`, means a special character in the password was not
/// percent-encoded. The driver then splits the URL at another place, too.
pub fn ambiguity(url: &str) -> Option<String> {
    let last_at = url.rfind('@')?;
    let ambiguous = url.matches('@').count() > 1 || url[..last_at].contains(['?', '#']);
    ambiguous.then(|| {
        "the database URL has a second `@`, or a `?` or `#` before its last `@`; percent-encode special \
         characters in the password (`@` as %40, `?` as %3F, `#` as %23, `/` as %2F), otherwise the driver \
         reads the URL differently than intended"
            .to_string()
    })
}

/// Deletes sessions that have ended, every hour. Sessions are otherwise only deleted when their
/// cookie is presented again, and most expired cookies never come back.
pub fn spawn_session_cleanup(state: crate::app::AppState) {
    const INTERVAL: std::time::Duration = std::time::Duration::from_secs(3600);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(INTERVAL);
        loop {
            tick.tick().await;
            let now = state.clock.now_ms();
            match crate::auth::session::delete_ended(&state.db, &state.config.sessions, now).await {
                Ok(0) => {}
                Ok(n) => tracing::debug!("removed {n} ended sessions"),
                Err(e) => tracing::warn!("removing ended sessions failed, will retry in an hour: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{ambiguity, redact};

    #[test]
    fn redact_hides_password() {
        assert_eq!(redact("postgres://kalzit:s3cr3t@db:5432/kalzit"), "postgres://kalzit:***@db:5432/kalzit");
        assert_eq!(redact("sqlite:data/kalzit.db?mode=rwc"), "sqlite:data/kalzit.db?mode=rwc");
        assert_eq!(
            redact("sqlite:C:/ProgramData/Kalzit/data/kalzit.db?mode=rwc"),
            "sqlite:C:/ProgramData/Kalzit/data/kalzit.db?mode=rwc"
        );
        assert_eq!(
            redact("postgres://db/kalzit?user=u&Password=secret&sslmode=require"),
            "postgres://db/kalzit?user=***&Password=***&sslmode=require"
        );
        assert_eq!(redact("postgres://kalzit%40x:p%40ss@db/kalzit"), "postgres://kalzit%40x:***@db/kalzit");
        assert_eq!(redact("postgres://kalzit@db/kalzit"), "postgres://kalzit@db/kalzit");
        assert_eq!(redact("postgres://db/kalzit"), "postgres://db/kalzit");
        assert_eq!(redact("not a url"), "<unparseable database url>");
    }

    /// Each URL with the strings that must not appear in the log line, and the host that must.
    #[test]
    fn no_password_form_leaks() {
        let cases: &[(&str, &[&str], Option<&str>)] = &[
            // Raw special characters in the password move it into port, path or query.
            ("postgres://u:9123?x=1@db/k", &["9123"], None),
            ("postgres://u:7?a=1@host:5432", &["7"], None),
            ("postgres://u:771?2=3@4@db", &["771"], None),
            ("postgres://:pasecret?ss=1@db", &["pasecret", "ss=1"], None),
            ("postgres://u/x:pwsecret?a=b@db", &["pwsecret"], None),
            ("postgres://u:asecret@b?c=dsecret@db", &["asecret", "dsecret"], None),
            ("postgres://u:asecret?b=csecret@d@db", &["asecret", "csecret"], None),
            ("postgres://u:asecret?b@c=dsecret@db", &["asecret", "dsecret"], None),
            ("postgres://kalzit:a?bsecret@db/kalzit", &["bsecret"], None),
            ("postgres://kalzit:a#bsecret@db/kalzit", &["bsecret"], None),
            ("postgres://kalzit:a/bsecret@db/kalzit", &["bsecret"], None),
            // Encoded keys are compared after decoding; unknown keys are masked as well.
            ("postgres://db/k?pass%77ord=secret1", &["secret1"], Some("db")),
            ("postgres://db/k?password%3Dx=1&PASSWORD=secret2", &["secret2", "=1"], Some("db")),
            ("postgres://db/k?options=-c%20x&pwd=secret3&sslpassword=secret4", &["secret3", "secret4"], Some("db")),
            // An `@` in the query: the host stays intact, the password is masked.
            ("postgres://host:5432/db?application_name=a@b&password=secret5", &["secret5"], Some("postgres://host")),
            ("postgres://[::1]:5432/db?application_name=a@b&password=secret6", &["secret6"], Some("postgres://[::1]")),
            ("postgres://u:secret7@[2001:db8::1]:5432/db", &["secret7"], Some("@[2001:db8::1]:5432")),
        ];
        for (url, secrets, host) in cases {
            let out = redact(url);
            for secret in *secrets {
                assert!(!out.contains(secret), "{url} leaks {secret}: {out}");
            }
            if let Some(host) = host {
                assert!(out.contains(host), "{url} lost its host: {out}");
            }
        }
    }

    #[test]
    fn ambiguous_urls_are_reported() {
        for url in ["postgres://u:a@b@db", "postgres://u:a?b@db", "postgres://u:a#b@db", "postgres://db/k?x=a@b"] {
            let warning = ambiguity(url).unwrap_or_else(|| panic!("{url}"));
            assert!(warning.contains("percent-encode"), "{warning}");
        }
        for url in ["postgres://u:p%40ss@db/k?sslmode=require", "postgres://db/k", "sqlite:data/kalzit.db?mode=rwc"] {
            assert_eq!(ambiguity(url), None, "{url}");
        }
    }
}
