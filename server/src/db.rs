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
/// keys. Every other value becomes `***`. An ambiguous URL (see [`ambiguity`]) is shown as
/// `scheme://***` alone: a password with raw special characters may have spilled into any part,
/// port and path included (`u:2024/Summer@db` parses as port 2024 and path `/Summer@db`).
/// `sqlite:` URLs hold a file path and no credentials; they are shown as they are.
pub fn redact(url: &str) -> String {
    if url.starts_with("sqlite:") {
        return url.to_string();
    }
    if ambiguity(url).is_some() {
        let scheme = url.split_once("://").map(|(scheme, _)| scheme).filter(|s| is_scheme(s));
        return scheme.map_or_else(|| "***".to_string(), |scheme| format!("{scheme}://***"));
    }
    let Ok(parsed) = url::Url::parse(url) else { return "<unparseable database url>".into() };
    // `postgres:u:secret@db/k` or `postgres:/u:secret@db`: no `//`, so no authority to take the
    // password from; the rest may be anything.
    if !parsed.has_authority() {
        return format!("{}:***", parsed.scheme());
    }
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

/// A URL scheme: letters, digits, `+`, `-` and `.`, starting with a letter.
pub fn is_scheme(text: &str) -> bool {
    text.starts_with(|c: char| c.is_ascii_alphabetic())
        && text.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
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
    "host",
    "port",
    "dbname",
];

/// A warning when `url` holds an `@` after the end of its authority (the text from `://` to the
/// first `/`, `?` or `#`). Then a special character in the password was not percent-encoded,
/// the driver splits the URL at another place than its author meant, and no part of it can be
/// shown safely.
pub fn ambiguity(url: &str) -> Option<String> {
    let (_, after_scheme) = url.split_once("://")?;
    let authority_end = after_scheme.find(['/', '?', '#']).unwrap_or(after_scheme.len());
    after_scheme[authority_end..].contains('@').then(|| {
        "the database URL has an `@` after its host part, so a special character in the password is not \
         percent-encoded; the driver reads such a URL differently than intended, and the log shows it only \
         as `scheme://***`. Percent-encode the password (`@` as %40, `/` as %2F, `?` as %3F, `#` as %23)"
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
            redact("postgres://db/kalzit?user=u&Password=secret&sslmode=require&dbname=k"),
            "postgres://db/kalzit?user=***&Password=***&sslmode=require&dbname=k"
        );
        assert_eq!(redact("postgres://kalzit%40x:p%40ss@db/kalzit"), "postgres://kalzit%40x:***@db/kalzit");
        assert_eq!(redact("postgres://kalzit@db/kalzit"), "postgres://kalzit@db/kalzit");
        assert_eq!(redact("postgres://db/kalzit"), "postgres://db/kalzit");
        assert_eq!(redact("not a url"), "<unparseable database url>");
        // Ambiguous: nothing but the scheme.
        assert_eq!(redact("postgres://u:2024/Summer@db:5432/kalzit"), "postgres://***");
    }

    struct Case {
        url: &'static str,
        password: &'static str,
        /// Must appear in the output (only for URLs that are not ambiguous).
        host: Option<&'static str>,
    }

    /// No piece of the password of three or more characters may appear in the log line.
    #[test]
    fn no_password_form_leaks() {
        let case = |url, password, host| Case { url, password, host };
        let cases = [
            // Raw special characters in the password move it into port, path or query.
            case("postgres://u:9123?x=1@db/k", "9123?x=1", None),
            case("postgres://u:7?a=1@host:5432", "7?a=1", None),
            case("postgres://u:771?2=3@4@db", "771?2=3@4", None),
            case("postgres://:pzsecret?ss=1@db", "pzsecret?ss=1", None),
            case("postgres://u/x:pwsecret?a=b@db", "pwsecret?a=b", None),
            case("postgres://u:asecret@b?c=dsecret@db", "asecret@b?c=dsecret", None),
            case("postgres://u:asecret?b=csecret@d@db", "asecret?b=csecret@d", None),
            case("postgres://u:asecret?b@c=dsecret@db", "asecret?b@c=dsecret", None),
            case("postgres://kalzit:a?bsecret@db/kalzit", "a?bsecret", None),
            case("postgres://kalzit:a#bsecret@db/kalzit", "a#bsecret", None),
            case("postgres://kalzit:a/bsecret@db/kalzit", "a/bsecret", None),
            case("postgres://u:12/ss@db/k", "12/ss", None),
            case("postgres://u:2024/Summer@db:5432/kalzit", "2024/Summer", None),
            case("postgres://u:9/x?y@db", "9/x?y", None),
            case("postgres://u:pass@word?x=1@db/k", "pass@word?x=1", None),
            case("postgres://u:a@sec#ret@db/k", "a@sec#ret", None),
            // An `@` in the query makes the URL ambiguous as well.
            case("postgres://host:5432/db?application_name=a@b&password=secret5", "secret5", None),
            case("postgres://[::1]:5432/db?application_name=a@b&password=secret6", "secret6", None),
            // Encoded keys are compared after decoding; unknown keys are masked as well.
            case("postgres://db/k?pass%77ord=secret1", "secret1", Some("postgres://db/k")),
            case("postgres://db/k?password%3Dx=1&PASSWORD=secret2", "secret2", Some("postgres://db/k")),
            case("postgres://db/k?options=-c%20x&pwd=secret3", "secret3", Some("postgres://db/k")),
            case("postgres://u:secret7@[2001:db8::1]:5432/db", "secret7", Some("u:***@[2001:db8::1]:5432/db")),
            case("postgres://u:secret%2F8@db:5432/k", "secret%2F8", Some("u:***@db:5432/k")),
            // No `//` after the scheme: no authority, nothing but the scheme is shown.
            case("postgres:/u:secret9@db/k", "secret9", Some("postgres:***")),
            case("postgres:u:secret10@db/k", "secret10", Some("postgres:***")),
            case("mysql:/u:secret11@h:3306/db", "secret11", Some("mysql:***")),
            case("postgres:x://u:secret12@db", "secret12", Some("postgres:***")),
        ];
        for Case { url, password, host } in cases {
            let out = redact(url);
            let chars: Vec<char> = password.chars().collect();
            for start in 0..chars.len() {
                for end in start + 3..=chars.len() {
                    let piece: String = chars[start..end].iter().collect();
                    assert!(!out.contains(&piece), "{url} leaks {piece:?} of its password: {out}");
                }
            }
            if let Some(host) = host {
                assert!(out.contains(host), "{url} lost its host: {out}");
            }
        }
    }

    #[test]
    fn ambiguous_urls_are_reported() {
        for url in [
            "postgres://u:a@b?c@db",
            "postgres://u:a?b@db",
            "postgres://u:a#b@db",
            "postgres://u:2024/Summer@db",
            "postgres://db/k?x=a@b",
        ] {
            let warning = ambiguity(url).unwrap_or_else(|| panic!("{url}"));
            assert!(warning.contains("percent-encode") || warning.contains("Percent-encode"), "{warning}");
        }
        for url in [
            "postgres://u:p%40ss@db/k?sslmode=require",
            "postgres://u:a@b@db",
            "postgres://db/k",
            "sqlite:data/kalzit.db?mode=rwc",
        ] {
            assert_eq!(ambiguity(url), None, "{url}");
        }
    }
}
