//! The texts of Kalzit's mails in German ("du") and English: plain text and a simple HTML
//! version with the same content. Every value from outside is escaped in the HTML; nothing is
//! loaded from elsewhere when the mail is opened.

use chrono::TimeZone;

use super::message::Content;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    De,
    En,
}

impl Lang {
    /// `de` for German, English for everything else.
    pub fn parse(raw: &str) -> Self {
        if raw.trim().to_ascii_lowercase().starts_with("de") { Lang::De } else { Lang::En }
    }
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

const MONTHS_DE: [&str; 12] = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
];
const MONTHS_EN: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// A moment as the mails name it: "5. November 2026, 14:20" or "November 5, 2026, 14:20", in
/// `zone` (an IANA name), else in UTC with "UTC" after it.
pub fn moment(ms: i64, zone: Option<&str>, lang: Lang) -> String {
    use chrono::{Datelike, Timelike};
    let tz: Option<chrono_tz::Tz> = zone.and_then(|z| z.parse().ok());
    let (day, month, year, hour, minute, suffix) = match tz {
        Some(tz) => {
            let t = tz.timestamp_millis_opt(ms).single().unwrap_or_else(|| tz.timestamp_millis_opt(0).unwrap());
            (t.day(), t.month0(), t.year(), t.hour(), t.minute(), "")
        }
        None => {
            let t = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default();
            (t.day(), t.month0(), t.year(), t.hour(), t.minute(), " UTC")
        }
    };
    match lang {
        Lang::De => format!("{day}. {} {year}, {hour:02}:{minute:02}{suffix}", MONTHS_DE[month as usize]),
        Lang::En => format!("{} {day}, {year}, {hour:02}:{minute:02}{suffix}", MONTHS_EN[month as usize]),
    }
}

/// The frame every mail shares: paragraphs, an optional button and the line about the sender.
fn html(paragraphs: &[String], button: Option<(&str, &str)>, footer: &str) -> String {
    let mut body = String::new();
    for p in paragraphs {
        body.push_str(&format!("<p style=\"margin:0 0 16px\">{}</p>\n", escape(p)));
    }
    if let Some((label, link)) = button {
        body.push_str(&format!(
            "<p style=\"margin:24px 0\"><a href=\"{}\" style=\"display:inline-block;padding:10px 18px;\
             border-radius:6px;background:#1f2328;color:#ffffff;text-decoration:none;font-weight:600\">{}</a></p>\n\
             <p style=\"margin:0 0 16px;color:#57606a;font-size:13px;word-break:break-all\">{}</p>\n",
            escape(link),
            escape(label),
            escape(link)
        ));
    }
    format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"color-scheme\" content=\"light dark\"></head>\n\
         <body style=\"margin:0;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;\
         line-height:1.5;color:#1f2328\">\n<div style=\"max-width:560px\">\n{body}\
         <p style=\"margin:32px 0 0;color:#57606a;font-size:13px\">{}</p>\n</div>\n</body></html>\n",
        escape(footer)
    )
}

fn text(paragraphs: &[String], link: Option<&str>, footer: &str) -> String {
    let mut out = paragraphs.join("\n\n");
    if let Some(link) = link {
        out.push_str("\n\n");
        out.push_str(link);
    }
    out.push_str("\n\n-- \n");
    out.push_str(footer);
    out.push('\n');
    out
}

pub struct Invitation<'a> {
    pub inviter: &'a str,
    pub org: &'a str,
    /// The role as the recipient reads it ("Bearbeiter", or a custom role's name).
    pub role: &'a str,
    pub team: Option<&'a str>,
    /// `moment` of the expiry.
    pub expires: &'a str,
    pub link: &'a str,
    /// The server's host, for the line about the sender.
    pub host: &'a str,
}

pub fn invitation(lang: Lang, i: &Invitation<'_>) -> Content {
    let (subject, paragraphs, button, footer) = match lang {
        Lang::De => (
            format!("{} lädt dich zu {} ein", i.inviter, i.org),
            vec![
                match i.team {
                    Some(team) => format!("Du bist eingeladen als {} im Team {}.", i.role, team),
                    None => format!("Du bist eingeladen als {}.", i.role),
                },
                format!("Der Link gilt bis {} und genau einmal.", i.expires),
            ],
            "Einladung annehmen",
            format!("Gesendet von {}. Nicht erwartet? Ignorier diese Mail.", i.host),
        ),
        Lang::En => (
            format!("{} invites you to {}", i.inviter, i.org),
            vec![
                match i.team {
                    Some(team) => format!("You are invited as {} in the team {}.", i.role, team),
                    None => format!("You are invited as {}.", i.role),
                },
                format!("The link works until {} and only once.", i.expires),
            ],
            "Accept the invitation",
            format!("Sent by {}. Not expected? Ignore this mail.", i.host),
        ),
    };
    Content {
        text: text(&paragraphs, Some(i.link), &footer),
        html: html(&paragraphs, Some((button, i.link)), &footer),
        subject,
    }
}

pub fn password_reset(lang: Lang, link: &str, host: &str) -> Content {
    let (subject, paragraphs, button, footer) = match lang {
        Lang::De => (
            "Neues Passwort für Kalzit".to_string(),
            vec![
                format!("Für dein Konto bei {host} wurde ein neues Passwort angefordert."),
                "Der Link gilt 60 Minuten und genau einmal.".to_string(),
            ],
            "Neues Passwort festlegen",
            "Warst du das nicht? Ignorier diese Mail; dein Passwort bleibt, wie es ist.".to_string(),
        ),
        Lang::En => (
            "A new password for Kalzit".to_string(),
            vec![
                format!("A new password was requested for your account at {host}."),
                "The link works for 60 minutes and only once.".to_string(),
            ],
            "Set a new password",
            "Not you? Ignore this mail; your password stays as it is.".to_string(),
        ),
    };
    Content {
        text: text(&paragraphs, Some(link), &footer),
        html: html(&paragraphs, Some((button, link)), &footer),
        subject: subject.clone(),
    }
}

/// For an account that signs in without a password of Kalzit's own (single sign-on, directory).
pub fn password_elsewhere(lang: Lang, host: &str) -> Content {
    let (subject, paragraphs, footer) = match lang {
        Lang::De => (
            "Dein Passwort für Kalzit".to_string(),
            vec![
                format!("Für dein Konto bei {host} wurde ein neues Passwort angefordert."),
                "Du meldest dich dort nicht mit einem eigenen Passwort an, sondern über die Anmeldung deiner \
                 Organisation. Dein Passwort änderst du dort; frag sonst deine IT."
                    .to_string(),
            ],
            "Warst du das nicht? Ignorier diese Mail.".to_string(),
        ),
        Lang::En => (
            "Your password for Kalzit".to_string(),
            vec![
                format!("A new password was requested for your account at {host}."),
                "You do not sign in there with a password of your own but through your organization's sign-in. \
                 Change your password there, or ask your IT."
                    .to_string(),
            ],
            "Not you? Ignore this mail.".to_string(),
        ),
    };
    Content { text: text(&paragraphs, None, &footer), html: html(&paragraphs, None, &footer), subject }
}

pub fn test_mail(lang: Lang, host: &str) -> Content {
    let (subject, paragraphs, footer) = match lang {
        Lang::De => (
            "Testmail von Kalzit".to_string(),
            vec!["Diese Mail zeigt, dass Kalzit über den eingerichteten Mailserver senden kann.".to_string()],
            format!("Gesendet von {host}."),
        ),
        Lang::En => (
            "Test mail from Kalzit".to_string(),
            vec!["This mail shows that Kalzit can send through the mail server you set up.".to_string()],
            format!("Sent by {host}."),
        ),
    };
    Content { text: text(&paragraphs, None, &footer), html: html(&paragraphs, None, &footer), subject }
}

/// A built-in role as the recipient reads it; custom roles keep their name.
pub fn role_label(lang: Lang, key: &str, name: &str) -> String {
    let label = match (lang, key) {
        (Lang::De, "owner") => "Eigentümer",
        (Lang::De, "admin") => "Admin",
        (Lang::De, "editor") => "Bearbeiter",
        (Lang::De, "viewer") => "Betrachter",
        (Lang::En, "owner") => "Owner",
        (Lang::En, "admin") => "Admin",
        (Lang::En, "editor") => "Editor",
        (Lang::En, "viewer") => "Viewer",
        _ => return name.to_string(),
    };
    label.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invitations_read_like_the_board_and_escape_what_comes_from_outside() {
        let i = Invitation {
            inviter: "Jonas <b>Albers</b>",
            org: "Müller & Söhne Analytics",
            role: "Bearbeiter",
            team: Some("Vertrieb & <Nord>"),
            expires: "5. November 2026, 14:20",
            link: "https://kalzit.example.com/invite#abc",
            host: "kalzit.example.com",
        };
        let de = invitation(Lang::De, &i);
        // The subject is a header (encoded there), never HTML.
        assert_eq!(de.subject, "Jonas <b>Albers</b> lädt dich zu Müller & Söhne Analytics ein");
        assert!(de.text.contains("Du bist eingeladen als Bearbeiter im Team Vertrieb & <Nord>."));
        assert!(de.text.contains("https://kalzit.example.com/invite#abc"));
        assert!(de.html.contains("im Team Vertrieb &amp; &lt;Nord&gt;."), "{}", de.html);
        assert!(!de.html.contains("<Nord>"));
        assert!(de.html.contains("href=\"https://kalzit.example.com/invite#abc\""));
        assert!(!de.html.contains("<img") && !de.html.contains("http://") && !de.html.contains("src="));
        let en = invitation(Lang::En, &Invitation { team: None, ..i });
        assert!(en.text.contains("You are invited as Bearbeiter."));
    }

    #[test]
    fn moments_follow_language_and_zone() {
        let ms = 1_793_884_800_000; // 2026-11-05T13:20:00Z
        assert_eq!(moment(ms, Some("Europe/Berlin"), Lang::De), "5. November 2026, 14:20");
        assert_eq!(moment(ms, None, Lang::En), "November 5, 2026, 13:20 UTC");
        assert_eq!(moment(ms, Some("browser"), Lang::De), "5. November 2026, 13:20 UTC");
    }

    #[test]
    fn languages_and_roles() {
        assert_eq!(Lang::parse("de-DE"), Lang::De);
        assert_eq!(Lang::parse("fr"), Lang::En);
        assert_eq!(role_label(Lang::De, "editor", "editor"), "Bearbeiter");
        assert_eq!(role_label(Lang::En, "0190-custom", "Analysten"), "Analysten");
    }
}
