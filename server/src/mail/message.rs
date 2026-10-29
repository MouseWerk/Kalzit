//! A mail as it goes over the wire (RFC 5322 with MIME): plain text and a simple HTML version
//! side by side (`multipart/alternative`), both UTF-8 in base64, headers with non-ASCII text as
//! encoded words (RFC 2047). No tracking: no remote images, no per-recipient link parameters.

use base64::Engine;

/// What a mail says, in one language.
#[derive(Debug, Clone)]
pub struct Content {
    pub subject: String,
    pub text: String,
    pub html: String,
}

pub struct Message<'a> {
    pub from_name: &'a str,
    pub from_address: &'a str,
    pub to: &'a str,
    pub reply_to: Option<&'a str>,
    pub content: &'a Content,
    pub date_ms: i64,
}

/// Header values never carry a line break: one would start a header of its own.
fn one_line(s: &str) -> String {
    s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// `text` as encoded words of at most 75 characters each, folded onto continuation lines.
fn encoded_words(text: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut words = Vec::new();
    let mut chunk = String::new();
    for c in text.chars() {
        // 45 bytes of UTF-8 become 60 base64 characters, within the 75 of a word.
        if chunk.len() + c.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", b64.encode(chunk.as_bytes())));
            chunk.clear();
        }
        chunk.push(c);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", b64.encode(chunk.as_bytes())));
    }
    words.join("\r\n ")
}

/// Plain ASCII text as it is; anything else as encoded words.
fn header_text(text: &str) -> String {
    let text = one_line(text);
    if text.is_ascii() { text } else { encoded_words(&text) }
}

/// `Name <address>`, with the name quoted or encoded as needed.
fn mailbox(name: &str, address: &str) -> String {
    let name = one_line(name.trim());
    if name.is_empty() {
        return format!("<{address}>");
    }
    let shown = if !name.is_ascii() {
        encoded_words(&name)
    } else if name.chars().all(|c| c.is_ascii_alphanumeric() || " !#$%&'*+-/=?^_`{|}~".contains(c)) {
        name
    } else {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    };
    format!("{shown} <{address}>")
}

fn base64_lines(text: &str) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let mut out = String::with_capacity(encoded.len() + encoded.len() / 76 * 2 + 2);
    for chunk in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push_str("\r\n");
    }
    out
}

/// RFC 5322 date, in UTC.
fn date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%a, %d %b %Y %H:%M:%S +0000").to_string()
}

/// The domain of an address, for the message id.
fn domain(address: &str) -> &str {
    address.rsplit_once('@').map_or("localhost", |(_, d)| d)
}

impl Message<'_> {
    /// The message with CRLF line ends, ready for `DATA`.
    pub fn render(&self) -> Vec<u8> {
        let id = uuid::Uuid::now_v7().simple().to_string();
        let boundary = format!("kalzit-{id}");
        let mut out = String::new();
        let mut header = |name: &str, value: &str| {
            out.push_str(name);
            out.push_str(": ");
            out.push_str(value);
            out.push_str("\r\n");
        };
        header("From", &mailbox(self.from_name, self.from_address));
        header("To", &format!("<{}>", one_line(self.to)));
        if let Some(reply_to) = self.reply_to.filter(|r| !r.is_empty()) {
            header("Reply-To", &format!("<{}>", one_line(reply_to)));
        }
        header("Subject", &header_text(&self.content.subject));
        header("Date", &date(self.date_ms));
        header("Message-ID", &format!("<{id}@{}>", domain(self.from_address)));
        header("MIME-Version", "1.0");
        // Mails Kalzit sends on its own: no out-of-office answers to them.
        header("Auto-Submitted", "auto-generated");
        header("Content-Type", &format!("multipart/alternative; boundary=\"{boundary}\""));
        out.push_str("\r\n");
        for (kind, body) in [("text/plain", &self.content.text), ("text/html", &self.content.html)] {
            out.push_str(&format!("--{boundary}\r\n"));
            out.push_str(&format!("Content-Type: {kind}; charset=utf-8\r\n"));
            out.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
            out.push_str(&base64_lines(body));
        }
        out.push_str(&format!("--{boundary}--\r\n"));
        out.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content() -> Content {
        Content {
            subject: "Jonas Albers lädt dich zu Müller & Söhne Analytics ein".into(),
            text: "Hallo\nzweite Zeile".into(),
            html: "<p>Hallo</p>".into(),
        }
    }

    fn decode_words(header: &str) -> String {
        header
            .split("\r\n ")
            .map(|w| {
                let inner = w.trim_start_matches("=?UTF-8?B?").trim_end_matches("?=");
                String::from_utf8(base64::engine::general_purpose::STANDARD.decode(inner).unwrap()).unwrap()
            })
            .collect()
    }

    #[test]
    fn headers_are_encoded_and_cannot_be_injected() {
        let content = Content { subject: "Hallo\r\nBcc: x@evil.example".into(), ..content() };
        let m = Message {
            from_name: "Kalzit · Müller & Söhne",
            from_address: "kalzit@example.com",
            to: "nora@example.com",
            reply_to: Some("it@example.com"),
            content: &content,
            date_ms: 1_800_000_000_000,
        };
        let text = String::from_utf8(m.render()).unwrap();
        assert!(text.contains("\r\nSubject: Hallo  Bcc: x@evil.example\r\n"), "{text}");
        assert!(!text.contains("\r\nBcc:"));
        assert!(text.contains("Reply-To: <it@example.com>\r\n"));
        assert!(text.contains("Date: Fri, 15 Jan 2027 08:00:00 +0000\r\n"), "{text}");
        let from = text.lines().find(|l| l.starts_with("From: ")).unwrap();
        assert!(from.starts_with("From: =?UTF-8?B?"), "{from}");
    }

    #[test]
    fn long_subjects_are_folded_into_words_that_decode_back() {
        let encoded = header_text(&content().subject);
        assert!(encoded.split("\r\n ").all(|w| w.len() <= 75), "{encoded}");
        assert_eq!(decode_words(&encoded), content().subject);
    }

    #[test]
    fn both_parts_are_there_in_base64() {
        let c = content();
        let m = Message {
            from_name: "Kalzit",
            from_address: "kalzit@example.com",
            to: "nora@example.com",
            reply_to: None,
            content: &c,
            date_ms: 0,
        };
        let text = String::from_utf8(m.render()).unwrap();
        assert!(text.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(text.contains("Content-Type: text/html; charset=utf-8"));
        assert!(text.contains(&base64_lines("Hallo\nzweite Zeile")));
        assert!(text.lines().all(|l| l.len() <= 998));
        assert!(!text.contains("Reply-To"));
        assert_eq!(mailbox("Ops, Team", "a@b.de"), "\"Ops, Team\" <a@b.de>");
    }
}
