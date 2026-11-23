//! A mail as it goes over the wire (RFC 5322 with MIME): plain text and an HTML version side by
//! side (`multipart/alternative`), both UTF-8 in base64, headers with non-ASCII text as encoded
//! words (RFC 2047). Images the HTML shows (the mark in the header) travel inside the mail next to
//! the HTML (`multipart/related`, RFC 2387) and are referenced by their Content-ID, so nothing is
//! loaded from the network. No tracking: no remote images, no per-recipient link parameters.
//! Files (reports) go after the text in `multipart/mixed`, each in base64 with its name (RFC 2231).

use base64::Engine;

/// What a mail says, in one language.
#[derive(Debug, Clone)]
pub struct Content {
    pub subject: String,
    pub text: String,
    pub html: String,
    /// Images the HTML references as `cid:<content_id>`; empty for a mail without any.
    pub images: Vec<InlineImage>,
}

/// An image inside the mail that the HTML shows by its Content-ID (RFC 2392), never a file the
/// recipient is meant to save.
#[derive(Debug, Clone)]
pub struct InlineImage {
    /// Without the angle brackets; the HTML says `cid:` and this.
    pub content_id: String,
    pub content_type: &'static str,
    /// The file name clients show if they list the image anyway.
    pub name: &'static str,
    pub data: std::borrow::Cow<'static, [u8]>,
}

/// A file sent with a mail.
#[derive(Debug, Clone)]
pub struct Attachment {
    /// The file's name as the recipient sees it.
    pub name: String,
    pub content_type: &'static str,
    pub data: Vec<u8>,
}

pub struct Message<'a> {
    pub from_name: &'a str,
    pub from_address: &'a str,
    pub to: &'a str,
    pub reply_to: Option<&'a str>,
    pub content: &'a Content,
    pub attachments: &'a [Attachment],
    /// A one-click unsubscribe address (RFC 8058), for mails to people outside Kalzit.
    pub unsubscribe: Option<&'a str>,
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
    base64_bytes(text.as_bytes())
}

fn base64_bytes(bytes: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
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
        if let Some(url) = self.unsubscribe {
            header("List-Unsubscribe", &format!("<{}>", one_line(url)));
            header("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
        }
        let mixed = format!("kalzit-mixed-{id}");
        if self.attachments.is_empty() {
            header("Content-Type", &format!("multipart/alternative; boundary=\"{boundary}\""));
            out.push_str("\r\n");
        } else {
            header("Content-Type", &format!("multipart/mixed; boundary=\"{mixed}\""));
            out.push_str("\r\n");
            out.push_str(&format!("--{mixed}\r\n"));
            out.push_str(&format!("Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\r\n"));
        }
        let text_part = |out: &mut String, kind: &str, body: &str| {
            out.push_str(&format!("Content-Type: {kind}; charset=utf-8\r\n"));
            out.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
            out.push_str(&base64_lines(body));
        };
        out.push_str(&format!("--{boundary}\r\n"));
        text_part(&mut out, "text/plain", &self.content.text);
        out.push_str(&format!("--{boundary}\r\n"));
        if self.content.images.is_empty() {
            text_part(&mut out, "text/html", &self.content.html);
        } else {
            // The HTML with the images it shows; clients that show only the text never see them.
            let related = format!("kalzit-related-{id}");
            out.push_str(&format!(
                "Content-Type: multipart/related; type=\"text/html\"; boundary=\"{related}\"\r\n\r\n"
            ));
            out.push_str(&format!("--{related}\r\n"));
            text_part(&mut out, "text/html", &self.content.html);
            for image in &self.content.images {
                let name = one_line(image.name);
                out.push_str(&format!("--{related}\r\n"));
                out.push_str(&format!("Content-Type: {}; name=\"{name}\"\r\n", one_line(image.content_type)));
                out.push_str("Content-Transfer-Encoding: base64\r\n");
                out.push_str(&format!("Content-ID: <{}>\r\n", one_line(&image.content_id)));
                out.push_str(&format!("Content-Disposition: inline; filename=\"{name}\"\r\n\r\n"));
                out.push_str(&base64_bytes(&image.data));
            }
            out.push_str(&format!("--{related}--\r\n"));
        }
        out.push_str(&format!("--{boundary}--\r\n"));
        if !self.attachments.is_empty() {
            for file in self.attachments {
                out.push_str(&format!("--{mixed}\r\n"));
                out.push_str(&format!("Content-Type: {}\r\n", one_line(file.content_type)));
                out.push_str(&format!("Content-Disposition: attachment; {}\r\n", file_name(&file.name)));
                out.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
                out.push_str(&base64_bytes(&file.data));
            }
            out.push_str(&format!("--{mixed}--\r\n"));
        }
        out.into_bytes()
    }
}

/// The `filename` parameter of an attachment: plain ASCII quoted, anything else percent-encoded
/// as UTF-8 (RFC 2231), with an ASCII stand-in for clients that do not read that form.
fn file_name(name: &str) -> String {
    let name = one_line(name);
    let plain = name.chars().all(|c| c.is_ascii_graphic() || c == ' ') && !name.contains(['"', '\\']);
    if plain {
        return format!("filename=\"{name}\"");
    }
    let fallback: String =
        name.chars().map(|c| if c.is_ascii_alphanumeric() || ".-_ ".contains(c) { c } else { '_' }).collect();
    let mut encoded = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b".-_".contains(&b) {
            encoded.push(char::from(b));
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content() -> Content {
        Content {
            subject: "Jonas Albers lädt dich zu Müller & Söhne Analytics ein".into(),
            text: "Hallo\nzweite Zeile".into(),
            html: "<p>Hallo</p>".into(),
            images: Vec::new(),
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
            attachments: &[],
            unsubscribe: None,
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
            attachments: &[],
            unsubscribe: None,
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

    #[test]
    fn attachments_follow_the_text_with_their_names() {
        let c = content();
        let files = [
            Attachment {
                name: "Umsatz März.pdf".into(),
                content_type: "application/pdf",
                data: vec![0x25, 0x50, 0xff],
            },
            Attachment {
                name: "umsatz.csv".into(),
                content_type: "text/csv; charset=utf-8",
                data: b"a,b\r\n".to_vec(),
            },
        ];
        let m = Message {
            from_name: "Kalzit",
            from_address: "kalzit@example.com",
            to: "nora@example.com",
            reply_to: None,
            content: &c,
            attachments: &files,
            unsubscribe: Some("https://kalzit.example/api/reports/unsubscribe/abc"),
            date_ms: 0,
        };
        let text = String::from_utf8(m.render()).unwrap();
        assert!(text.contains("Content-Type: multipart/mixed; boundary=\"kalzit-mixed-"), "{text}");
        assert!(text.contains("Content-Type: multipart/alternative; boundary=\"kalzit-"));
        assert!(text.contains("filename=\"Umsatz M_rz.pdf\"; filename*=UTF-8''Umsatz%20M%C3%A4rz.pdf"), "{text}");
        assert!(text.contains("Content-Disposition: attachment; filename=\"umsatz.csv\""));
        assert!(text.contains(&base64_bytes(&[0x25, 0x50, 0xff])));
        assert!(text.trim_end().ends_with("--"), "the outer part is closed");
        assert!(text.contains("List-Unsubscribe: <https://kalzit.example/api/reports/unsubscribe/abc>\r\n"));
        assert!(text.contains("List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n"));
        assert!(text.lines().all(|l| l.len() <= 998));
    }
}
