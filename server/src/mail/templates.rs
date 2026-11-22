//! The texts of Kalzit's mails in German ("du") and English, and the one frame every mail shares
//! (docs/design/blueprint/Mails.dc.html, frames 2 to 9 and 13): a header with the mark and the
//! product name, a word for the kind of mail, one heading, short paragraphs, facts as a two-column
//! list, at most one button with the same link as text below it, a calm box with what to know
//! (how long a link works, what happens when you do nothing or it was not you), and a footer of
//! three lines: why you get the mail, who sent it, and that it came automatically.
//!
//! Every mail goes out as plain text (wrapped at 72 characters, links never broken) and as HTML
//! with the same content in the same order. The HTML is light with all colors inline, the safe
//! base for every client; a dark version is an addition in the head for clients that read
//! `prefers-color-scheme`. Every value from outside is escaped. Nothing is loaded from the
//! network: system fonts, the mark as an image inside the mail (Content-ID), no tracking, and
//! links only to the server's own address.

use std::borrow::Cow;

use chrono::TimeZone;

use super::message::{Content, InlineImage};

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

    fn code(self) -> &'static str {
        match self {
            Lang::De => "de",
            Lang::En => "en",
        }
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

/// How long a link works, next to its end: "60 Minuten", "24 hours".
pub fn span(ms: i64, lang: Lang) -> String {
    const HOUR: i64 = 3_600_000;
    let (n, de, en) = if ms >= 2 * HOUR && ms % HOUR == 0 {
        (ms / HOUR, "Stunden", "hours")
    } else {
        ((ms / 60_000).max(1), "Minuten", "minutes")
    };
    match lang {
        Lang::De => format!("{n} {de}"),
        Lang::En => format!("{n} {en}"),
    }
}

/// A list of names as a sentence says it: "A", "A oder B", "A, B or C".
fn either(names: &[&str], lang: Lang) -> String {
    let or = match lang {
        Lang::De => "oder",
        Lang::En => "or",
    };
    match names {
        [] => String::new(),
        [one] => (*one).to_string(),
        [head @ .., last] => format!("{} {or} {last}", head.join(", ")),
    }
}

/// The product name every mail carries when the server has none of its own.
pub const KALZIT: &str = "Kalzit";

/// The Kalzit mark as the header shows it: the calcite rhombohedron in the mail's copper, 44 px
/// for sharp screens, shown at 22 px. A copper that reads on white and on near-black, so clients
/// that turn a light mail dark on their own keep it visible.
pub static MARK_PNG: &[u8] = include_bytes!("../../assets/mail/mark.png");
/// The Content-ID the header's image goes by (`message::InlineImage`).
pub const MARK_CID: &str = "mark@kalzit";

/// The image in a mail's header: Kalzit's mark, or the server's own logo (Administration >
/// Appearance) when it is a PNG or JPEG of a size mail clients take.
#[derive(Clone, Debug)]
pub struct Mark {
    pub content_type: &'static str,
    pub name: &'static str,
    pub data: Cow<'static, [u8]>,
    /// The size shown, in CSS pixels.
    pub width: u32,
    pub height: u32,
}

/// The largest own logo a mail carries; a larger one leaves the name alone in the header.
pub const MAX_LOGO_BYTES: usize = 64 * 1024;
/// The height a logo is shown at, and the widest it may get.
const LOGO_HEIGHT: u32 = 22;
const LOGO_MAX_WIDTH: u32 = 160;

impl Mark {
    pub fn kalzit() -> Self {
        Mark { content_type: "image/png", name: "kalzit.png", data: Cow::Borrowed(MARK_PNG), width: 22, height: 22 }
    }

    /// The server's own logo, if a mail can carry it: PNG or JPEG (WebP is not shown by many
    /// clients), at most `MAX_LOGO_BYTES`, with a size that can be read from its header.
    pub fn logo(content_type: &str, data: Vec<u8>) -> Option<Self> {
        if data.len() > MAX_LOGO_BYTES {
            return None;
        }
        let (content_type, name, size) = match content_type {
            "image/png" => ("image/png", "logo.png", png_size(&data)?),
            "image/jpeg" => ("image/jpeg", "logo.jpg", jpeg_size(&data)?),
            _ => return None,
        };
        let (w, h) = size;
        if w == 0 || h == 0 {
            return None;
        }
        let width = (u64::from(w) * u64::from(LOGO_HEIGHT)).div_ceil(u64::from(h)).clamp(1, u64::from(LOGO_MAX_WIDTH));
        let height = if width == u64::from(LOGO_MAX_WIDTH) {
            (u64::from(h) * u64::from(LOGO_MAX_WIDTH)).div_ceil(u64::from(w)).clamp(1, u64::from(LOGO_HEIGHT))
        } else {
            u64::from(LOGO_HEIGHT)
        };
        Some(Mark { content_type, name, data: Cow::Owned(data), width: width as u32, height: height as u32 })
    }
}

/// Width and height from a PNG's header chunk.
fn png_size(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || !data.starts_with(b"\x89PNG\r\n\x1a\n") || &data[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(data[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(data[20..24].try_into().ok()?);
    Some((w, h))
}

/// Width and height from a JPEG's start-of-frame segment.
fn jpeg_size(data: &[u8]) -> Option<(u32, u32)> {
    if !data.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xff {
            return None;
        }
        let marker = data[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        let len = usize::from(u16::from_be_bytes([data[i + 2], data[i + 3]]));
        // Start of frame, except the markers in that range that are something else.
        if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
            let at = i + 4;
            if at + 5 > data.len() {
                return None;
            }
            let h = u16::from_be_bytes([data[at + 1], data[at + 2]]);
            let w = u16::from_be_bytes([data[at + 3], data[at + 4]]);
            return Some((u32::from(w), u32::from(h)));
        }
        i += 2 + len;
    }
    None
}

/// The button's fill and label in the light version and in the dark one, as `#rrggbb`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button {
    pub light: (String, String),
    pub dark: (String, String),
}

const WHITE: &str = "#ffffff";
/// The near-black label of the dark scheme's primary button.
const NEAR_BLACK: &str = "#1a1209";

/// The vetted accents of the UI (`appearance::ACCENTS`) as mail colors: the light fill and the
/// dark one. The labels are white and the near-black, as in the app. Copper is Kalzit's own,
/// the main action of the app (board decision 2).
const ACCENT_FILLS: &[(&str, &str, &str)] = &[
    ("copper", "#8f5129", "#d79a6b"),
    ("blue", "#285e9f", "#90baf1"),
    ("teal", "#086b6c", "#80c6c5"),
    ("green", "#2c6d3e", "#88ca95"),
    ("violet", "#644b9e", "#bbaceb"),
    ("rose", "#98374d", "#eaa0aa"),
    ("amber", "#7e5403", "#ddae6c"),
    ("graphite", "#5d5d64", "#b6b7be"),
];

impl Button {
    fn of(light: &str, light_label: &str, dark: &str, dark_label: &str) -> Self {
        Button { light: (light.into(), light_label.into()), dark: (dark.into(), dark_label.into()) }
    }

    /// Sunstone copper.
    pub fn copper() -> Self {
        Button::of("#8f5129", WHITE, "#d79a6b", NEAR_BLACK)
    }

    /// The button of the server's accent (`appearance.accent`) when its label keeps 4.5:1 in
    /// both versions, else copper (board frame 13, "Eigener Name und Logo").
    pub fn for_accent(accent: &str) -> Self {
        if let Some((_, light, dark)) = ACCENT_FILLS.iter().find(|(name, _, _)| *name == accent) {
            let button = Button::of(light, WHITE, dark, NEAR_BLACK);
            return if button.reads() { button } else { Button::copper() };
        }
        let Some(check) = crate::appearance::check_accent(accent) else { return Button::copper() };
        // A custom color is one fill for both versions; the server checked it against both themes.
        let fill = accent.to_ascii_lowercase();
        let label = if check.dark_label { NEAR_BLACK } else { WHITE };
        let button = Button::of(&fill, label, &fill, label);
        if button.reads() { button } else { Button::copper() }
    }

    fn reads(&self) -> bool {
        reads(&self.light.0, &self.light.1) && reads(&self.dark.0, &self.dark.1)
    }
}

fn reads(fill: &str, label: &str) -> bool {
    use crate::appearance::{MIN_TEXT_CONTRAST, contrast, luminance, parse_hex};
    match (parse_hex(fill), parse_hex(label)) {
        (Some(f), Some(l)) => contrast(luminance(f), luminance(l)) >= MIN_TEXT_CONTRAST,
        _ => false,
    }
}

/// What every mail of this server carries: the product name, the server's host, the image in
/// the header (none: the name alone, Settings > Email) and the button's colors.
#[derive(Clone, Debug)]
pub struct Brand {
    pub product: String,
    pub host: String,
    pub mark: Option<Mark>,
    pub button: Button,
}

impl Brand {
    /// Kalzit's own look: the name, the mark and copper.
    pub fn kalzit(host: &str) -> Self {
        Brand {
            product: KALZIT.to_string(),
            host: host.to_string(),
            mark: Some(Mark::kalzit()),
            button: Button::copper(),
        }
    }

    fn own_name(&self) -> bool {
        self.product != KALZIT
    }
}

/// One mail in the shared frame, in one language.
#[derive(Clone, Debug)]
pub struct Mail {
    pub lang: Lang,
    pub subject: String,
    /// The word above the heading: Einladung, Sicherheit, Konto, Verwaltung, Test.
    pub kind: String,
    pub heading: String,
    pub paragraphs: Vec<String>,
    /// Name and value, shown as a two-column list.
    pub facts: Vec<(String, String)>,
    /// The one button: its label and the link (always to the server's own address).
    pub button: Option<(String, String)>,
    /// The box with what to know: a sentence in bold and the rest after it.
    pub note: Option<(String, String)>,
    /// The first line of the footer: why the person gets this mail.
    pub why: String,
    /// The organization the mail is about, in the header and the footer.
    pub org: Option<String>,
}

/// The text part's width; links stay whole on a line of their own.
pub const TEXT_WIDTH: usize = 72;

/// `text` wrapped at `TEXT_WIDTH`, the first line after `first`, the others after `rest`.
fn wrap(text: &str, first: &str, rest: &str) -> String {
    let mut out = String::new();
    let mut line = first.to_string();
    let mut len = first.chars().count();
    let mut empty = true;
    for word in text.split_whitespace() {
        let w = word.chars().count();
        if !empty && len + 1 + w > TEXT_WIDTH {
            out.push_str(&line);
            out.push('\n');
            line = rest.to_string();
            len = rest.chars().count();
            empty = true;
        }
        if !empty {
            line.push(' ');
            len += 1;
        }
        line.push_str(word);
        len += w;
        empty = false;
    }
    out.push_str(&line);
    out
}

// The light version: the safe base, inline on every element (board frame 3, "Kontrast").
const OUT: &str = "#f4f4f5";
const CARD: &str = "#ffffff";
const TEXT: &str = "#1f2328";
const MUTED: &str = "#59606a";
const LINE: &str = "#e3e4e8";
const WELL: &str = "#f6f6f7";
const FONT: &str = "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
const MONO: &str = "ui-monospace,Menlo,Consolas,monospace";

impl Mail {
    fn sent_by(&self, brand: &Brand) -> String {
        let (product, host) = (&brand.product, &brand.host);
        let mut line = match (self.lang, &self.org) {
            (Lang::De, Some(org)) => format!("Gesendet von {product} auf {host} für {org}."),
            (Lang::De, None) => format!("Gesendet von {product} auf {host}."),
            (Lang::En, Some(org)) => format!("Sent by {product} on {host} for {org}."),
            (Lang::En, None) => format!("Sent by {product} on {host}."),
        };
        // Kalzit is named once in the footer, also under a name of the server's own.
        if brand.own_name() {
            line.push_str(&match self.lang {
                Lang::De => format!(" {product} läuft auf {KALZIT}."),
                Lang::En => format!(" {product} runs on {KALZIT}."),
            });
        }
        line
    }

    fn automatic(&self) -> &'static str {
        match self.lang {
            Lang::De => "Diese Mail wurde automatisch gesendet und lädt nichts aus dem Netz nach.",
            Lang::En => "This mail was sent automatically and loads nothing from the network.",
        }
    }

    fn copy_link(&self) -> &'static str {
        match self.lang {
            Lang::De => "Oder kopiere diesen Link in deinen Browser:",
            Lang::En => "Or copy this link into your browser:",
        }
    }

    /// The mail in both parts, with the header's image when the brand has one.
    pub fn render(&self, brand: &Brand) -> Content {
        let images = brand
            .mark
            .as_ref()
            .map(|m| {
                vec![InlineImage {
                    content_id: MARK_CID.to_string(),
                    content_type: m.content_type,
                    name: m.name,
                    data: m.data.clone(),
                }]
            })
            .unwrap_or_default();
        Content { subject: self.subject.clone(), text: self.text(brand), html: self.html(brand), images }
    }

    fn text(&self, brand: &Brand) -> String {
        let mut blocks: Vec<String> = Vec::new();
        let top = match &self.org {
            Some(org) => format!("{} · {org}", brand.product.to_uppercase()),
            None => brand.product.to_uppercase(),
        };
        let heading = wrap(&self.heading, "", "");
        let underline = "=".repeat(heading.lines().map(|l| l.chars().count()).max().unwrap_or(0));
        blocks.push(format!("{}\n{}\n{heading}\n{underline}", wrap(&top, "", ""), wrap(&self.kind, "", "")));
        for p in &self.paragraphs {
            blocks.push(wrap(p, "", ""));
        }
        if !self.facts.is_empty() {
            let lines: Vec<String> =
                self.facts.iter().map(|(name, value)| wrap(&format!("{name}: {value}"), "  ", "    ")).collect();
            blocks.push(lines.join("\n"));
        }
        if let Some((label, link)) = &self.button {
            blocks.push(format!("{}\n{link}", wrap(&format!("{label}:"), "", "")));
        }
        if let Some((lead, rest)) = &self.note {
            blocks.push(wrap(&format!("{lead} {rest}"), "", ""));
        }
        let footer =
            [wrap(&self.why, "", ""), wrap(&self.sent_by(brand), "", ""), wrap(self.automatic(), "", "")].join("\n");
        // "-- " starts the signature, which clients may fold away.
        let mut out = blocks.join("\n\n");
        out.push_str("\n\n-- \n");
        out.push_str(&footer);
        out.push('\n');
        out
    }

    fn html(&self, brand: &Brand) -> String {
        let (light_fill, light_label) = &brand.button.light;
        let (dark_fill, dark_label) = &brand.button.dark;
        let mut h = String::with_capacity(8 * 1024);
        h.push_str(&format!(
            "<!doctype html>\n<html lang=\"{lang}\" dir=\"ltr\">\n<head>\n<meta charset=\"utf-8\">\n\
             <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
             <meta name=\"color-scheme\" content=\"light dark\">\n\
             <meta name=\"supported-color-schemes\" content=\"light dark\">\n\
             <title>{title}</title>\n<style>\n\
             :root{{color-scheme:light dark;supported-color-schemes:light dark}}\n\
             @media (prefers-color-scheme: dark){{\n\
             .k-out{{background:#141416 !important}}\n\
             .k-card{{background:#1b1b1e !important;border-color:#2e2e33 !important}}\n\
             .k-text{{color:#ececef !important}}\n\
             .k-muted{{color:#a6a6ae !important}}\n\
             .k-line{{border-color:#2e2e33 !important}}\n\
             .k-well{{background:#18181b !important}}\n\
             .k-link{{color:#ececef !important}}\n\
             .k-btn{{background:{dark_fill} !important;color:{dark_label} !important}}\n\
             }}\n\
             @media (max-width:480px){{\n\
             .k-frame{{padding:0 !important}}\n\
             .k-card{{border-radius:0 !important;border-left:0 !important;border-right:0 !important}}\n\
             .k-pad{{padding-left:16px !important;padding-right:16px !important}}\n\
             .k-org{{display:none !important}}\n\
             .k-btn{{display:block !important;text-align:center !important}}\n\
             }}\n\
             </style>\n</head>\n",
            lang = self.lang.code(),
            title = escape(&self.subject),
        ));
        h.push_str(&format!(
            "<body class=\"k-out\" style=\"margin:0;padding:0;background:{OUT};font-family:{FONT};font-size:15px;\
             line-height:1.55;color:{TEXT}\">\n\
             <table role=\"presentation\" class=\"k-out\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" \
             style=\"background:{OUT}\"><tr><td class=\"k-frame\" align=\"center\" style=\"padding:24px 16px\">\n\
             <table role=\"presentation\" class=\"k-card\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" \
             style=\"max-width:560px;background:{CARD};border:1px solid {LINE};border-radius:12px;\
             border-collapse:separate\">\n"
        ));
        // Header: the mark and the name, the organization on the right.
        let mark = brand.mark.as_ref().map_or(String::new(), |m| {
            format!(
                "<td style=\"padding:0 10px 0 0;vertical-align:middle;width:{w}px\"><img src=\"cid:{MARK_CID}\" \
                 width=\"{w}\" height=\"{hh}\" alt=\"\" style=\"display:block;border:0;width:{w}px;height:{hh}px\"></td>",
                w = m.width,
                hh = m.height
            )
        });
        let org = self.org.as_ref().map_or(String::new(), |org| {
            format!(
                "<td class=\"k-org k-muted\" align=\"right\" style=\"vertical-align:middle;font-size:13px;color:{MUTED}\">\
                 {}</td>",
                escape(org)
            )
        });
        h.push_str(&format!(
            "<tr><td class=\"k-pad k-line\" style=\"padding:18px 28px;border-bottom:1px solid {LINE}\">\
             <table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\"><tr>{mark}\
             <td class=\"k-text\" style=\"vertical-align:middle;font-weight:600;font-size:15px;color:{TEXT}\">{}</td>\
             {org}</tr></table></td></tr>\n",
            escape(&brand.product)
        ));
        // Body.
        h.push_str("<tr><td class=\"k-pad\" style=\"padding:26px 28px 8px\">\n");
        h.push_str(&format!(
            "<p class=\"k-muted\" style=\"margin:0 0 6px;font-size:13px;color:{MUTED}\">{}</p>\n\
             <h1 class=\"k-text\" style=\"margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:600;color:{TEXT}\">\
             {}</h1>\n",
            escape(&self.kind),
            escape(&self.heading)
        ));
        for p in &self.paragraphs {
            h.push_str(&format!("<p class=\"k-text\" style=\"margin:0 0 14px;color:{TEXT}\">{}</p>\n", escape(p)));
        }
        if !self.facts.is_empty() {
            h.push_str(
                "<table cellpadding=\"0\" cellspacing=\"0\" border=\"0\" width=\"100%\" \
                 style=\"border-collapse:collapse;margin:0 0 16px;font-size:14px\">\n",
            );
            let last = self.facts.len() - 1;
            for (i, (name, value)) in self.facts.iter().enumerate() {
                let bottom = if i == last { format!(";border-bottom:1px solid {LINE}") } else { String::new() };
                h.push_str(&format!(
                    "<tr><th scope=\"row\" class=\"k-muted k-line\" style=\"text-align:left;font-weight:400;width:38%;\
                     padding:7px 12px 7px 0;vertical-align:top;color:{MUTED};border-top:1px solid {LINE}{bottom}\">{}</th>\
                     <td class=\"k-text k-line\" style=\"padding:7px 0;vertical-align:top;color:{TEXT};\
                     border-top:1px solid {LINE}{bottom}\">{}</td></tr>\n",
                    escape(name),
                    escape(value)
                ));
            }
            h.push_str("</table>\n");
        }
        if let Some((label, link)) = &self.button {
            let href = escape(link);
            h.push_str(&format!(
                "<p style=\"margin:4px 0 14px\"><a class=\"k-btn\" href=\"{href}\" style=\"display:inline-block;\
                 background:{light_fill};color:{light_label};font-weight:600;font-size:15px;line-height:20px;\
                 padding:12px 22px;border-radius:8px;text-decoration:none\">{}</a></p>\n\
                 <p class=\"k-muted\" style=\"margin:0 0 16px;font-size:13px;color:{MUTED}\">{}<br>\
                 <a class=\"k-link\" href=\"{href}\" style=\"font-family:{MONO};font-size:13px;color:{TEXT};\
                 text-decoration:underline;word-break:break-all\">{href}</a></p>\n",
                escape(label),
                escape(self.copy_link()),
            ));
        }
        if let Some((lead, rest)) = &self.note {
            h.push_str(&format!(
                "<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" border=\"0\" \
                 style=\"margin:0 0 18px\"><tr><td class=\"k-well k-text\" style=\"background:{WELL};border-radius:8px;\
                 padding:12px 14px;font-size:14px;color:{TEXT}\"><strong>{}</strong> {}</td></tr></table>\n",
                escape(lead),
                escape(rest)
            ));
        }
        h.push_str("</td></tr>\n");
        // Footer, always three lines.
        h.push_str(&format!(
            "<tr><td class=\"k-pad k-line k-muted\" style=\"padding:16px 28px 22px;border-top:1px solid {LINE};\
             font-size:13px;line-height:1.55;color:{MUTED}\">\n\
             <p style=\"margin:0 0 6px\">{}</p>\n<p style=\"margin:0 0 6px\">{}</p>\n<p style=\"margin:0\">{}</p>\n\
             </td></tr>\n</table>\n</td></tr></table>\n</body>\n</html>\n",
            escape(&self.why),
            escape(&self.sent_by(brand)),
            escape(self.automatic())
        ));
        h
    }
}

/// The frame of alert and report mails until they move onto `Mail` (board decision 10, step 2):
/// paragraphs, an optional button and the line about the sender.
pub(crate) fn html(paragraphs: &[String], button: Option<(&str, &str)>, footer: &str) -> String {
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

/// The text part of alert and report mails until they move onto `Mail`.
pub(crate) fn text(paragraphs: &[String], link: Option<&str>, footer: &str) -> String {
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

fn de_en(lang: Lang, de: impl Into<String>, en: impl Into<String>) -> String {
    match lang {
        Lang::De => de.into(),
        Lang::En => en.into(),
    }
}

/// "Der Link gilt bis …, und genau einmal." with the span for short links.
fn link_works(lang: Lang, expires: &str, valid: Option<&str>) -> String {
    let until = match valid {
        Some(valid) => format!("{expires} ({valid})"),
        None => expires.to_string(),
    };
    de_en(
        lang,
        format!("Der Link gilt bis {until}, und genau einmal."),
        format!("The link works until {until}, and only once."),
    )
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
    /// The providers the organization signs in through, when it has no passwords of its own;
    /// the button still leads to the invitation page (board decision 3).
    pub sso: &'a [&'a str],
}

pub fn invitation(lang: Lang, brand: &Brand, i: &Invitation<'_>) -> Content {
    let (inviter, org, product) = (i.inviter, i.org, &brand.product);
    let subject = de_en(lang, format!("{inviter} lädt dich zu {org} ein"), format!("{inviter} invites you to {org}"));
    let sso = (!i.sso.is_empty()).then(|| either(i.sso, lang));
    let mut intro = de_en(
        lang,
        format!("{inviter} hat dich in die Organisation {org} eingeladen."),
        format!("{inviter} has invited you to the organization {org}."),
    );
    if let Some(sso) = &sso {
        intro.push(' ');
        intro.push_str(&de_en(
            lang,
            format!("Dort meldet man sich über {sso} an; ein eigenes Passwort für {product} brauchst du nicht."),
            format!("There you sign in through {sso}; you do not need a password of your own for {product}."),
        ));
    }
    let mut facts = vec![(de_en(lang, "Rolle", "Role"), i.role.to_string())];
    if let Some(team) = i.team {
        facts.push(("Team".to_string(), team.to_string()));
    }
    if let Some(sso) = &sso {
        facts.push((
            de_en(lang, "Anmeldung", "Sign-in"),
            de_en(lang, format!("{sso}, mit deinem Firmenkonto"), format!("{sso}, with your company account")),
        ));
    }
    facts.push((de_en(lang, "Gültig bis", "Valid until"), i.expires.to_string()));
    let works = link_works(lang, i.expires, None);
    let note = match &sso {
        None => (
            works,
            de_en(
                lang,
                "Nicht erwartet? Dann ignoriere diese Mail; es entsteht kein Konto und niemand erfährt davon.",
                "Not expected? Then ignore this mail; no account is created and nobody is told.",
            ),
        ),
        Some(sso) => (
            de_en(
                lang,
                format!("Der Knopf führt zu {product}, nicht direkt zu {sso}."),
                format!("The button leads to {product}, not straight to {sso}."),
            ),
            de_en(
                lang,
                format!(
                    "Dort siehst du die Einladung und gehst weiter zur Anmeldung über {sso}. {works} Nicht erwartet? \
                     Dann ignoriere diese Mail."
                ),
                format!(
                    "There you see the invitation and go on to the sign-in through {sso}. {works} Not expected? Then \
                     ignore this mail."
                ),
            ),
        ),
    };
    Mail {
        lang,
        heading: subject.clone(),
        subject,
        kind: de_en(lang, "Einladung", "Invitation"),
        paragraphs: vec![intro],
        facts,
        button: Some((de_en(lang, "Einladung annehmen", "Accept the invitation"), i.link.to_string())),
        note: Some(note),
        why: de_en(
            lang,
            format!("Du bekommst diese Mail, weil {inviter} diese Adresse eingeladen hat."),
            format!("You get this mail because {inviter} invited this address."),
        ),
        org: Some(org.to_string()),
    }
    .render(brand)
}

/// An admin who sent a password link from the members page, and their organization.
pub struct SentBy<'a> {
    pub admin: &'a str,
    pub org: &'a str,
}

pub struct Reset<'a> {
    pub link: &'a str,
    /// `moment` of the expiry.
    pub expires: &'a str,
    /// `span` of how long the link works.
    pub valid: &'a str,
    /// The admin who sent it; `None` when someone asked on the sign-in page.
    pub sent_by: Option<SentBy<'a>>,
}

pub fn password_reset(lang: Lang, brand: &Brand, r: &Reset<'_>) -> Content {
    let product = &brand.product;
    let works = link_works(lang, r.expires, Some(r.valid));
    let (subject, intro, rest, why, org) = match &r.sent_by {
        None => (
            de_en(
                lang,
                format!("Neues Passwort für dein Konto bei {product}"),
                format!("A new password for your account at {product}"),
            ),
            de_en(
                lang,
                format!("Für dein Konto bei {product} wurde ein neues Passwort angefordert."),
                format!("A new password was requested for your account at {product}."),
            ),
            de_en(
                lang,
                "Warst du das nicht? Dann ignoriere diese Mail; dein Passwort bleibt, wie es ist. Kommt so eine Mail \
                 öfter, sag einem Admin Bescheid.",
                "Not you? Then ignore this mail; your password stays as it is. If such mails keep coming, tell an \
                 admin.",
            ),
            de_en(
                lang,
                "Du bekommst diese Mail, weil jemand auf der Anmeldeseite „Passwort vergessen?“ mit deiner Adresse \
                 benutzt hat.",
                "You get this mail because someone used “Forgot password?” on the sign-in page with your address.",
            ),
            None,
        ),
        Some(SentBy { admin, org }) => (
            de_en(
                lang,
                format!("{admin} hat dir einen Link für ein neues Passwort geschickt"),
                format!("{admin} sent you a link for a new password"),
            ),
            de_en(
                lang,
                format!(
                    "{admin}, Admin von {org}, hat dir einen Link geschickt, mit dem du ein neues Passwort festlegst."
                ),
                format!("{admin}, admin of {org}, sent you a link to set a new password with."),
            ),
            de_en(
                lang,
                format!("Nicht erwartet? Frag {admin}, bevor du den Link benutzt."),
                format!("Not expected? Ask {admin} before you use the link."),
            ),
            de_en(
                lang,
                "Du bekommst diese Mail, weil ein Admin deiner Organisation den Link für dein Konto angefordert hat.",
                "You get this mail because an admin of your organization asked for the link for your account.",
            ),
            Some(org.to_string()),
        ),
    };
    Mail {
        lang,
        subject,
        kind: de_en(lang, "Konto", "Account"),
        heading: de_en(lang, "Lege ein neues Passwort fest", "Set a new password"),
        paragraphs: vec![intro],
        facts: Vec::new(),
        button: Some((de_en(lang, "Neues Passwort festlegen", "Set a new password"), r.link.to_string())),
        note: Some((works, rest)),
        why,
        org,
    }
    .render(brand)
}

/// For an account that signs in without a password of Kalzit's own (single sign-on, directory):
/// names the provider when the account has one.
pub fn password_elsewhere(lang: Lang, brand: &Brand, provider: Option<&str>) -> Content {
    let product = &brand.product;
    let (subject, heading, through) = match provider {
        Some(p) => (
            de_en(
                lang,
                format!("Dein Passwort für {product} liegt bei {p}"),
                format!("Your password for {product} is kept by {p}"),
            ),
            de_en(lang, format!("Dein Passwort änderst du bei {p}"), format!("You change your password at {p}")),
            de_en(
                lang,
                format!("über die Anmeldung deiner Organisation, {p}"),
                format!("through your organization's sign-in, {p}"),
            ),
        ),
        None => (
            de_en(
                lang,
                format!("Dein Passwort für {product} liegt bei der Anmeldung deiner Organisation"),
                format!("Your password for {product} is kept by your organization's sign-in"),
            ),
            de_en(
                lang,
                "Dein Passwort änderst du bei der Anmeldung deiner Organisation",
                "You change your password at your organization's sign-in",
            ),
            de_en(lang, "über die Anmeldung deiner Organisation", "through your organization's sign-in"),
        ),
    };
    Mail {
        lang,
        subject,
        kind: de_en(lang, "Konto", "Account"),
        heading,
        paragraphs: vec![
            de_en(
                lang,
                format!(
                    "Für dein Konto bei {product} wurde ein neues Passwort angefordert. Du meldest dich dort aber nicht \
                     mit einem eigenen Passwort an, sondern {through}."
                ),
                format!(
                    "A new password was requested for your account at {product}. But you do not sign in there with a \
                     password of your own, you sign in {through}."
                ),
            ),
            de_en(
                lang,
                "Dein Passwort änderst du dort. Wenn du nicht weißt, wie, frag deine IT.",
                "You change your password there. If you do not know how, ask your IT.",
            ),
        ],
        facts: Vec::new(),
        button: None,
        note: Some((
            de_en(lang, "Warst du das nicht?", "Not you?"),
            de_en(lang, "Dann ignoriere diese Mail; es hat sich nichts geändert.", "Then ignore this mail; nothing has changed."),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil jemand auf der Anmeldeseite „Passwort vergessen?“ mit deiner Adresse \
             benutzt hat.",
            "You get this mail because someone used “Forgot password?” on the sign-in page with your address.",
        ),
        org: None,
    }
    .render(brand)
}

/// What to do after a security notice someone else may have caused.
fn not_you(lang: Lang) -> (String, String) {
    (
        de_en(lang, "Warst du das? Dann ist nichts zu tun.", "Was that you? Then there is nothing to do."),
        de_en(
            lang,
            "Warst du das nicht? Sag sofort einem Admin deiner Organisation Bescheid und ändere dein Passwort.",
            "Not you? Tell an admin of your organization right away and change your password.",
        ),
    )
}

/// A change of the second factor (`auth::second_factor::Notice`), board frame 7. No link: what
/// to do is to sign in as usual, or to tell an admin. `at` is the `moment` it happened.
pub fn second_factor_notice(
    lang: Lang,
    brand: &Brand,
    notice: crate::auth::second_factor::Notice,
    at: &str,
) -> Content {
    use crate::auth::second_factor::Notice;
    let product = &brand.product;
    let (heading, what, note) = match notice {
        Notice::Locked => (
            de_en(lang, "Der zweite Faktor macht eine Pause", "The second factor takes a break"),
            de_en(
                lang,
                format!(
                    "Bei der Anmeldung an deinem Konto bei {product} wurde der zweite Faktor zu oft falsch eingegeben. \
                     Er ist für eine Weile gesperrt; dein Konto ist nicht gesperrt."
                ),
                format!(
                    "The second factor was entered wrongly too often when signing in to your account at {product}. \
                     It is locked for a while; your account is not locked."
                ),
            ),
            (
                de_en(lang, "Warst du das nicht?", "Not you?"),
                de_en(
                    lang,
                    "Dann kennt vielleicht jemand dein Passwort: ändere es und sag einem Admin deiner Organisation \
                     Bescheid.",
                    "Then someone may know your password: change it and tell an admin of your organization.",
                ),
            ),
        ),
        Notice::RecoveryCodeUsed => (
            de_en(lang, "Anmeldung mit einem Wiederherstellungscode", "Signed in with a recovery code"),
            de_en(
                lang,
                format!("Dein Konto bei {product} wurde mit einem Wiederherstellungscode angemeldet."),
                format!("Your account at {product} was signed in with a recovery code."),
            ),
            not_you(lang),
        ),
        Notice::Changed => (
            de_en(
                lang,
                "Der zweite Faktor deines Kontos wurde geändert",
                "The second factor of your account was changed",
            ),
            de_en(
                lang,
                format!("Der zweite Faktor deines Kontos bei {product} hat sich geändert."),
                format!("The second factor of your account at {product} has changed."),
            ),
            not_you(lang),
        ),
        Notice::Reset => (
            de_en(lang, "Ein Admin hat deinen zweiten Faktor zurückgesetzt", "An admin reset your second factor"),
            de_en(
                lang,
                format!(
                    "Ein Admin hat den zweiten Faktor deines Kontos bei {product} zurückgesetzt. Bei der nächsten \
                     Anmeldung richtest du einen neuen ein, wenn er verlangt ist."
                ),
                format!(
                    "An admin reset the second factor of your account at {product}. At your next sign-in you set up \
                     a new one where it is required."
                ),
            ),
            not_you(lang),
        ),
        Notice::WrongPasswords => (
            de_en(
                lang,
                "Dein Passwort wurde mehrmals falsch eingegeben",
                "Your password was entered wrongly several times",
            ),
            de_en(
                lang,
                format!(
                    "In einer Sitzung, die bei deinem Konto bei {product} angemeldet ist, wurde dein Passwort \
                     mehrmals hintereinander falsch eingegeben. Unter Konto > Anmeldung und Sicherheit siehst du \
                     deine Sitzungen und beendest die, die du nicht kennst."
                ),
                format!(
                    "In a session signed in to your account at {product}, your password was entered wrongly several \
                     times in a row. Under Account > Sign-in and security you see your sessions and end the ones you \
                     do not know."
                ),
            ),
            not_you(lang),
        ),
    };
    let why = match notice {
        Notice::WrongPasswords => de_en(
            lang,
            "Du bekommst diese Mail, wenn in einer Sitzung deines Kontos das Passwort mehrmals falsch eingegeben \
             wird; sie lässt sich nicht abbestellen.",
            "You get this mail when the password is entered wrongly several times in a session of your account; it \
             cannot be turned off.",
        ),
        _ => de_en(
            lang,
            "Du bekommst diese Mail bei allem, was den zweiten Faktor deines Kontos betrifft; sie lässt sich nicht \
             abbestellen.",
            "You get this mail for everything that concerns the second factor of your account; it cannot be turned \
             off.",
        ),
    };
    Mail {
        lang,
        subject: heading.clone(),
        kind: de_en(lang, "Sicherheit", "Security"),
        heading,
        paragraphs: vec![what],
        facts: vec![(de_en(lang, "Wann", "When"), at.to_string())],
        button: None,
        note: Some(note),
        why,
        org: None,
    }
    .render(brand)
}

/// To every server admin: the break-glass admin signed in with a password while password
/// sign-in is off (docs/api/sso.md). Names who and from where, never a secret; the button opens
/// the audit log (`audit_link`, when the server has a public address).
pub fn break_glass_sign_in(
    lang: Lang,
    brand: &Brand,
    name: &str,
    address: &str,
    at: &str,
    audit_link: Option<&str>,
) -> Content {
    let heading = de_en(lang, "Der Notfall-Admin hat sich angemeldet", "The break-glass admin signed in");
    Mail {
        lang,
        subject: heading.clone(),
        kind: de_en(lang, "Verwaltung · Sicherheit", "Administration · Security"),
        heading,
        paragraphs: vec![de_en(
            lang,
            format!("Das Konto „{name}“ hat sich mit Passwort über die Notfall-Anmeldung angemeldet, an den Anbietern vorbei."),
            format!("The account “{name}” signed in with a password through the break-glass sign-in, past the providers."),
        )],
        facts: vec![
            (de_en(lang, "Wann", "When"), at.to_string()),
            (de_en(lang, "Von", "From"), address.to_string()),
            ("Server".to_string(), brand.host.clone()),
        ],
        button: audit_link.map(|link| (de_en(lang, "Audit-Log öffnen", "Open the audit log"), link.to_string())),
        note: Some((
            de_en(lang, "War das abgesprochen? Dann ist nichts zu tun.", "Was that agreed on? Then there is nothing to do."),
            de_en(
                lang,
                "Wenn nicht: prüfe das Audit-Log und die Anmeldung über die Anbieter, und ändere das Passwort des \
                 Notfall-Admins.",
                "If not: check the audit log and the sign-in through providers, and change the break-glass admin's \
                 password.",
            ),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil du Server-Admin bist. Sie geht bei jeder Notfall-Anmeldung an alle \
             Server-Admins.",
            "You get this mail because you are a server admin. It goes to every server admin at each break-glass \
             sign-in.",
        ),
        org: None,
    }
    .render(brand)
}

/// To every server admin: the sync of an LDAP provider halted before locking more accounts than
/// its threshold allows (docs/api/sso.md, "Sync"). Nothing changed; an admin decides, on the page
/// `link` opens.
pub fn ldap_sync_halted(
    lang: Lang,
    brand: &Brand,
    provider: &str,
    would: usize,
    accounts: usize,
    threshold: u8,
    link: Option<&str>,
) -> Content {
    let percent = if accounts == 0 { 100 } else { (would * 100).div_ceil(accounts) };
    Mail {
        lang,
        subject: de_en(lang, format!("Abgleich mit „{provider}“ angehalten"), format!("Sync with “{provider}” halted")),
        kind: de_en(lang, "Verwaltung", "Administration"),
        heading: de_en(
            lang,
            format!("Der Abgleich mit „{provider}“ wurde angehalten"),
            format!("The sync with “{provider}” was halted"),
        ),
        paragraphs: vec![
            de_en(
                lang,
                format!(
                    "Der Abgleich mit dem LDAP-Verzeichnis hätte {would} von {accounts} Konten gesperrt ({percent} %, \
                     Grenze {threshold} %). Er hat nichts geändert."
                ),
                format!(
                    "The sync with the LDAP directory would have locked {would} of {accounts} accounts ({percent} %, \
                     limit {threshold} %). It changed nothing."
                ),
            ),
            de_en(
                lang,
                "Oft steckt ein falscher Filter oder ein leerer Basis-DN dahinter.",
                "A wrong filter or an empty base DN is often the cause.",
            ),
        ],
        facts: Vec::new(),
        button: link.map(|link| (de_en(lang, "Liste prüfen", "Check the list"), link.to_string())),
        note: Some((
            de_en(
                lang,
                "In Einstellungen > Anmeldung siehst du beim Anbieter, welche Konten betroffen wären, und kannst den \
                 Abgleich trotzdem anwenden.",
                "In Settings > Sign-in you see at the provider which accounts would be affected, and can apply the \
                 sync anyway.",
            ),
            de_en(
                lang,
                "Tust du nichts, bleibt alles, wie es ist; der nächste Abgleich prüft erneut.",
                "If you do nothing, everything stays as it is; the next sync checks again.",
            ),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil du Server-Admin bist.",
            "You get this mail because you are a server admin.",
        ),
        org: None,
    }
    .render(brand)
}

/// The link that confirms an account's address (`routes::email_confirmation`).
pub fn confirm_email(lang: Lang, brand: &Brand, link: &str, expires: &str, valid: &str) -> Content {
    let product = &brand.product;
    Mail {
        lang,
        subject: de_en(
            lang,
            format!("Bestätige deine E-Mail-Adresse für {product}"),
            format!("Confirm your email address for {product}"),
        ),
        kind: de_en(lang, "Konto", "Account"),
        heading: de_en(lang, "Bestätige deine E-Mail-Adresse", "Confirm your email address"),
        paragraphs: vec![de_en(
            lang,
            format!("Diese Adresse soll zu deinem Konto bei {product} gehören."),
            format!("This address is to belong to your account at {product}."),
        )],
        facts: Vec::new(),
        button: Some((de_en(lang, "Adresse bestätigen", "Confirm address"), link.to_string())),
        note: Some((
            link_works(lang, expires, Some(valid)),
            de_en(
                lang,
                "Warst du das nicht? Dann ignoriere diese Mail; die Adresse bleibt unbestätigt.",
                "Not you? Then ignore this mail; the address stays unconfirmed.",
            ),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil in einem Konto die Bestätigung dieser Adresse angefordert wurde.",
            "You get this mail because an account asked to confirm this address.",
        ),
        org: None,
    }
    .render(brand)
}

/// The link that confirms the address of a self-registration (`routes::registration`).
pub fn registration_confirm(
    lang: Lang,
    brand: &Brand,
    link: &str,
    expires: &str,
    valid: &str,
    approval: bool,
) -> Content {
    let product = &brand.product;
    let mut intro = de_en(
        lang,
        format!(
            "Mit dieser Adresse wurde ein Konto bei {product} angefragt. Nach der Bestätigung wählst du Name und Passwort."
        ),
        format!(
            "An account at {product} was requested with this address. After the confirmation you choose a name and password."
        ),
    );
    if approval {
        intro.push(' ');
        intro.push_str(&de_en(
            lang,
            "Danach gibt ein Admin das Konto frei; du bekommst dann eine Mail.",
            "After that an admin approves the account; you get a mail then.",
        ));
    }
    Mail {
        lang,
        subject: de_en(
            lang,
            format!("Bestätige deine Adresse für ein Konto bei {product}"),
            format!("Confirm your address for an account at {product}"),
        ),
        kind: de_en(lang, "Konto", "Account"),
        heading: de_en(lang, "Bestätige deine Adresse", "Confirm your address"),
        paragraphs: vec![intro],
        facts: Vec::new(),
        button: Some((de_en(lang, "Adresse bestätigen", "Confirm address"), link.to_string())),
        note: Some((
            link_works(lang, expires, Some(valid)),
            de_en(
                lang,
                "Warst du das nicht? Dann ignoriere diese Mail; ohne Bestätigung entsteht kein Konto.",
                "Not you? Then ignore this mail; without a confirmation no account is made.",
            ),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil jemand diese Adresse auf der Seite „Konto erstellen“ eingegeben hat.",
            "You get this mail because someone entered this address on the page “Create account”.",
        ),
        org: None,
    }
    .render(brand)
}

/// A registration an admin approved: the account exists, the person signs in.
pub fn registration_approved(lang: Lang, brand: &Brand, link: &str) -> Content {
    let product = &brand.product;
    Mail {
        lang,
        subject: de_en(lang, format!("Dein Konto bei {product} ist freigegeben"), format!("Your account at {product} is approved")),
        kind: de_en(lang, "Konto", "Account"),
        heading: de_en(lang, "Dein Konto ist freigegeben", "Your account is approved"),
        paragraphs: vec![de_en(
            lang,
            format!("Ein Admin hat dein Konto bei {product} freigegeben. Du meldest dich mit deiner Adresse und deinem Passwort an."),
            format!("An admin approved your account at {product}. You sign in with your address and password."),
        )],
        facts: Vec::new(),
        button: Some((de_en(lang, "Anmelden", "Sign in"), link.to_string())),
        note: Some((
            de_en(lang, "Du hast kein Konto angefragt?", "You did not ask for an account?"),
            de_en(lang, "Sag einem Admin Bescheid.", "Tell an admin."),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil du ein Konto angefragt hast und es jetzt freigegeben ist.",
            "You get this mail because you asked for an account and it is approved now.",
        ),
        org: None,
    }
    .render(brand)
}

/// To every server admin: a confirmed registration waits for approval. Names no address; the
/// list is in the administration. `days`: how long the request waits before it lapses.
pub fn registration_pending(lang: Lang, brand: &Brand, link: &str, days: i64) -> Content {
    let heading = de_en(lang, "Eine Registrierung wartet auf Freigabe", "A registration awaits approval");
    Mail {
        lang,
        subject: heading.clone(),
        kind: de_en(lang, "Verwaltung", "Administration"),
        heading,
        paragraphs: vec![de_en(
            lang,
            format!("Eine Person hat ihre Adresse bei {} bestätigt und wartet auf die Freigabe.", brand.product),
            format!("A person confirmed their address at {} and awaits approval.", brand.product),
        )],
        facts: Vec::new(),
        button: Some((de_en(lang, "Registrierungen ansehen", "View registrations"), link.to_string())),
        note: Some((
            de_en(
                lang,
                format!("Tust du nichts, verfällt die Anfrage nach {days} Tagen."),
                format!("If you do nothing, the request lapses after {days} days."),
            ),
            de_en(
                lang,
                "Die Selbstregistrierung schaltest du unter Einstellungen > Registrierung aus.",
                "You turn self-registration off under Settings > Registration.",
            ),
        )),
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil du Server-Admin bist und Registrierungen eine Freigabe brauchen.",
            "You get this mail because you are a server admin and registrations need an approval.",
        ),
        org: None,
    }
    .render(brand)
}

/// The mail server a test mail went through, as the mail names it.
pub struct TestServer<'a> {
    /// "smtp.example.com:587, STARTTLS".
    pub server: &'a str,
    /// The sender's name.
    pub sender: &'a str,
    /// `moment` of sending.
    pub sent: &'a str,
}

pub fn test_mail(lang: Lang, brand: &Brand, t: &TestServer<'_>) -> Content {
    let product = &brand.product;
    Mail {
        lang,
        subject: de_en(lang, format!("Testmail von {product}"), format!("Test mail from {product}")),
        kind: "Test".to_string(),
        heading: de_en(lang, "Der Mailserver funktioniert", "The mail server works"),
        paragraphs: vec![de_en(
            lang,
            format!(
                "Diese Mail zeigt, dass {product} über den eingerichteten Mailserver senden kann. So sehen alle Mails \
                 von {product} aus: Kopf, Überschrift, Inhalt, Fuß."
            ),
            format!(
                "This mail shows that {product} can send through the mail server you set up. This is how every mail \
                 from {product} looks: header, heading, content, footer."
            ),
        )],
        facts: vec![
            ("Server".to_string(), t.server.to_string()),
            (de_en(lang, "Absender", "Sender"), t.sender.to_string()),
            (de_en(lang, "Gesendet", "Sent"), t.sent.to_string()),
        ],
        button: None,
        note: None,
        why: de_en(
            lang,
            "Du bekommst diese Mail, weil du in Einstellungen > E-Mail „Testmail senden“ gewählt hast.",
            "You get this mail because you chose “Send test mail” in Settings > Email.",
        ),
        org: None,
    }
    .render(brand)
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
    use crate::auth::second_factor::Notice;

    const PUBLIC: &str = "https://kalzit.example.com";

    fn brand() -> Brand {
        Brand::kalzit("kalzit.example.com")
    }

    fn own_brand() -> Brand {
        Brand { product: "Sunstone Insights".into(), ..brand() }
    }

    fn invitation_of<'a>(sso: &'a [&'a str]) -> Invitation<'a> {
        Invitation {
            inviter: "Jonas <b>Albers</b>",
            org: "Müller & Söhne Analytics",
            role: "Bearbeiter",
            team: Some("Vertrieb & <Nord>"),
            expires: "5. November 2026, 14:20",
            link: "https://kalzit.example.com/invite#abc",
            sso,
        }
    }

    /// Every mail of `templates.rs` in both languages, with values that need escaping.
    fn every_mail(brand: &Brand) -> Vec<(&'static str, Content)> {
        let mut out = Vec::new();
        for lang in [Lang::De, Lang::En] {
            let link = format!("{PUBLIC}/reset-password#tok");
            out.push(("invitation", invitation(lang, brand, &invitation_of(&[]))));
            out.push(("invitation-sso", invitation(lang, brand, &invitation_of(&["Müller SSO"]))));
            let reset = Reset { link: &link, expires: "5. November 2026, 15:20", valid: "60 Minuten", sent_by: None };
            out.push(("reset", password_reset(lang, brand, &reset)));
            let by_admin = Reset { sent_by: Some(SentBy { admin: "Jonas <A>", org: "Müller & Söhne" }), ..reset };
            out.push(("reset-admin", password_reset(lang, brand, &by_admin)));
            out.push(("elsewhere", password_elsewhere(lang, brand, Some("Müller <SSO>"))));
            out.push(("elsewhere-plain", password_elsewhere(lang, brand, None)));
            for notice in
                [Notice::Locked, Notice::RecoveryCodeUsed, Notice::Changed, Notice::Reset, Notice::WrongPasswords]
            {
                out.push(("second-factor", second_factor_notice(lang, brand, notice, "5. November 2026, 14:20")));
            }
            let audit = format!("{PUBLIC}/admin/audit");
            out.push(("break-glass", break_glass_sign_in(lang, brand, "not<fall>", "198.51.100.7", "x", Some(&audit))));
            let signin = format!("{PUBLIC}/settings/signin");
            out.push(("ldap", ldap_sync_halted(lang, brand, "Zentrale & <Co>", 212, 342, 20, Some(&signin))));
            let confirm = format!("{PUBLIC}/confirm-email#tok");
            out.push(("confirm", confirm_email(lang, brand, &confirm, "6. November 2026, 14:20", "24 Stunden")));
            let register = format!("{PUBLIC}/register#tok");
            out.push(("register", registration_confirm(lang, brand, &register, "x", "24 Stunden", true)));
            out.push(("approved", registration_approved(lang, brand, &format!("{PUBLIC}/login"))));
            out.push(("pending", registration_pending(lang, brand, &format!("{PUBLIC}/admin/members"), 14)));
            let test = TestServer { server: "smtp.example.com:587, STARTTLS", sender: "Ops <Team>", sent: "x" };
            out.push(("test", test_mail(lang, brand, &test)));
        }
        out
    }

    /// Every `http://` or `https://` address in `s`, up to the next quote, space or tag.
    fn urls(s: &str) -> Vec<&str> {
        let mut out = Vec::new();
        let mut rest = s;
        while let Some(at) = rest.find("http") {
            let tail = &rest[at..];
            if tail.starts_with("http://") || tail.starts_with("https://") {
                let end = tail.find(|c: char| c.is_whitespace() || c == '"' || c == '<').unwrap_or(tail.len());
                out.push(&tail[..end]);
                rest = &tail[end..];
            } else {
                rest = &tail[4..];
            }
        }
        out
    }

    #[test]
    fn every_mail_has_the_frame_in_both_parts() {
        for (name, c) in every_mail(&brand()) {
            // HTML: one heading, the header's image by its Content-ID, the three footer lines.
            assert_eq!(c.html.matches("<h1").count(), 1, "{name}");
            assert!(c.html.starts_with("<!doctype html>\n<html lang=\""), "{name}");
            assert!(c.html.contains(&format!("src=\"cid:{MARK_CID}\"")), "{name}");
            assert!(c.html.contains("alt=\"\""), "{name}: the name stands next to the mark");
            assert!(c.html.contains("@media (prefers-color-scheme: dark)"), "{name}");
            assert!(c.html.contains("role=\"presentation\""), "{name}");
            assert!(c.html.matches("class=\"k-btn\"").count() <= 1, "{name}: at most one button");
            let auto = ["lädt nichts aus dem Netz nach.", "loads nothing from the network."];
            assert!(auto.iter().any(|a| c.html.contains(a) && c.text.contains(a)), "{name}");
            assert!(c.html.contains("Kalzit") && c.text.contains("Kalzit"), "{name}");
            // The image travels with the mail.
            assert_eq!(c.images.len(), 1, "{name}");
            assert_eq!(c.images[0].content_id, MARK_CID);
            assert_eq!(c.images[0].content_type, "image/png");
            // Text: the signature line, wrapped at 72 except for lines that are a link alone.
            assert!(c.text.contains("\n\n-- \n"), "{name}");
            for line in c.text.lines() {
                assert!(
                    line.chars().count() <= TEXT_WIDTH || (urls(line).len() == 1 && line.trim() == urls(line)[0]),
                    "{name}: {line:?} is longer than {TEXT_WIDTH}"
                );
            }
            assert!(!c.subject.contains('\n'), "{name}");
        }
    }

    #[test]
    fn mails_load_nothing_and_link_only_to_the_server() {
        for (name, c) in every_mail(&brand()) {
            for part in [&c.html, &c.text] {
                for url in urls(part) {
                    assert!(url.starts_with(&format!("{PUBLIC}/")), "{name}: {url} is not the server's own");
                }
            }
            // The only image is the one inside the mail; no style sheet, font or script from elsewhere.
            assert_eq!(c.html.matches("<img").count(), 1, "{name}");
            assert_eq!(c.html.matches("src=").count(), 1, "{name}");
            for banned in ["<link", "@import", "url(", "<script", "@font-face", "background-image"] {
                assert!(!c.html.contains(banned), "{name}: {banned}");
            }
        }
    }

    #[test]
    fn everything_from_outside_is_escaped_in_the_html() {
        for (name, c) in every_mail(&brand()) {
            for raw in ["<b>", "<Nord>", "<A>", "<SSO>", "<fall>", "<Co>", "<Team>", "Müller & Söhne"] {
                assert!(!c.html.contains(raw), "{name}: {raw} is not escaped");
            }
        }
        let de = invitation(Lang::De, &brand(), &invitation_of(&[]));
        // The subject is a header (encoded there), never HTML.
        assert_eq!(de.subject, "Jonas <b>Albers</b> lädt dich zu Müller & Söhne Analytics ein");
        assert!(de.html.contains("<title>Jonas &lt;b&gt;Albers&lt;/b&gt; lädt dich"), "{}", de.html);
        assert!(de.html.contains(">Vertrieb &amp; &lt;Nord&gt;</td>"), "{}", de.html);
        assert!(de.text.contains("  Team: Vertrieb & <Nord>"), "{}", de.text);
        assert!(de.html.contains("href=\"https://kalzit.example.com/invite#abc\""));
    }

    #[test]
    fn the_invitation_reads_like_the_board() {
        let de = invitation(Lang::De, &brand(), &invitation_of(&[]));
        let text = de.text;
        assert!(
            text.starts_with("KALZIT · Müller & Söhne Analytics\nEinladung\nJonas <b>Albers</b> lädt dich"),
            "{text}"
        );
        assert!(
            text.contains("\n  Rolle: Bearbeiter\n  Team: Vertrieb & <Nord>\n  Gültig bis: 5. November 2026, 14:20")
        );
        assert!(text.contains("Einladung annehmen:\nhttps://kalzit.example.com/invite#abc\n"), "{text}");
        assert!(text.contains("Der Link gilt bis 5. November 2026, 14:20, und genau einmal."), "{text}");
        // The footer lines wrap at 72 characters like every paragraph; the sentence stays whole.
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains("Du bekommst diese Mail, weil Jonas <b>Albers</b> diese Adresse eingeladen hat."),
            "{text}"
        );
        assert!(text.contains("Gesendet von Kalzit auf kalzit.example.com für Müller & Söhne Analytics."), "{text}");
        assert!(!text.contains("läuft auf"), "Kalzit is named once");
        let en = invitation(Lang::En, &brand(), &Invitation { team: None, ..invitation_of(&[]) });
        assert!(en.text.contains("  Role: Bearbeiter\n  Valid until:"), "{}", en.text);
        assert!(en.html.contains("<html lang=\"en\""));
    }

    #[test]
    fn an_sso_invitation_names_the_provider_and_still_leads_to_the_invitation_page() {
        let c = invitation(Lang::De, &brand(), &invitation_of(&["Müller SSO"]));
        let text = c.text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(text.contains("Dort meldet man sich über Müller SSO an"), "{text}");
        assert!(text.contains("Anmeldung: Müller SSO, mit deinem Firmenkonto"), "{text}");
        assert!(text.contains("Der Knopf führt zu Kalzit, nicht direkt zu Müller SSO."), "{text}");
        assert_eq!(urls(&c.html), vec!["https://kalzit.example.com/invite#abc"; 3]);
        let two = invitation(Lang::En, &brand(), &invitation_of(&["A", "B", "C"]));
        assert!(two.text.split_whitespace().collect::<Vec<_>>().join(" ").contains("through A, B or C;"));
    }

    #[test]
    fn an_own_product_name_stands_everywhere_and_kalzit_once_in_the_footer() {
        let b = own_brand();
        for (name, c) in every_mail(&b) {
            let text = c.text.split_whitespace().collect::<Vec<_>>().join(" ");
            assert_eq!(text.matches("Kalzit").count(), 1, "{name}: {text}");
            assert!(
                text.contains("Sunstone Insights läuft auf Kalzit.")
                    || text.contains("Sunstone Insights runs on Kalzit.")
            );
            assert!(c.text.starts_with("SUNSTONE INSIGHTS"), "{name}");
            assert!(c.html.contains(">Sunstone Insights</td>"), "{name}");
            assert!(!c.subject.contains("Kalzit"), "{name}: {}", c.subject);
        }
        let reset = Reset { link: "https://kalzit.example.com/r#t", expires: "x", valid: "60 minutes", sent_by: None };
        assert_eq!(
            password_reset(Lang::En, &b, &reset).subject,
            "A new password for your account at Sunstone Insights"
        );
        assert_eq!(password_reset(Lang::De, &brand(), &reset).subject, "Neues Passwort für dein Konto bei Kalzit");
    }

    #[test]
    fn the_mark_can_be_turned_off_and_an_own_logo_replaces_it() {
        let b = Brand { mark: None, ..brand() };
        let c = test_mail(Lang::De, &b, &TestServer { server: "s", sender: "k", sent: "x" });
        assert!(c.images.is_empty());
        assert!(!c.html.contains("<img") && c.html.contains(">Kalzit</td>"));
        // A logo of 200 x 50 is shown 88 x 22; one too wide is capped at 160.
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&200u32.to_be_bytes());
        png.extend_from_slice(&50u32.to_be_bytes());
        let logo = Mark::logo("image/png", png.clone()).unwrap();
        assert_eq!((logo.width, logo.height), (88, 22));
        let mut wide = png[..16].to_vec();
        wide.extend_from_slice(&1000u32.to_be_bytes());
        wide.extend_from_slice(&50u32.to_be_bytes());
        let logo = Mark::logo("image/png", wide).unwrap();
        assert_eq!((logo.width, logo.height), (160, 8));
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 60, 3];
        let logo = Mark::logo("image/jpeg", jpeg.to_vec()).unwrap();
        assert_eq!((logo.width, logo.height), (44, 22));
        assert!(Mark::logo("image/webp", png.clone()).is_none());
        assert!(Mark::logo("image/png", vec![0; MAX_LOGO_BYTES + 1]).is_none());
        assert_eq!(png_size(MARK_PNG), Some((44, 44)));
    }

    #[test]
    fn the_button_follows_the_accent_when_its_label_reads() {
        assert_eq!(Button::for_accent("copper"), Button::copper());
        assert_eq!(Button::for_accent("teal").light.0, "#086b6c");
        // Every vetted accent keeps its own colors: its labels read in both versions.
        for (name, light, _) in ACCENT_FILLS {
            assert_eq!(&Button::for_accent(name).light.0, light, "{name}");
        }
        // A dark custom color carries a white label, a light one the near-black.
        assert_eq!(Button::for_accent("#1F4E79").light, ("#1f4e79".to_string(), WHITE.to_string()));
        assert_eq!(Button::for_accent("#9fd3c7").dark, ("#9fd3c7".to_string(), NEAR_BLACK.to_string()));
        assert_eq!(Button::for_accent("pink"), Button::copper());
        let teal = Brand { button: Button::for_accent("teal"), ..brand() };
        let c = registration_approved(Lang::De, &teal, "https://kalzit.example.com/login");
        assert!(c.html.contains("background:#086b6c;color:#ffffff"), "{}", c.html);
        assert!(c.html.contains(".k-btn{background:#80c6c5 !important;color:#1a1209 !important}"));
    }

    #[test]
    fn security_mails_say_what_to_do_when_it_was_not_you() {
        for notice in [Notice::Locked, Notice::RecoveryCodeUsed, Notice::Changed, Notice::Reset, Notice::WrongPasswords]
        {
            let c = second_factor_notice(Lang::De, &brand(), notice, "5. November 2026, 14:20");
            assert!(c.text.contains("Warst du das nicht?"), "{}", c.text);
            assert!(c.text.contains("  Wann: 5. November 2026, 14:20"));
            assert!(!c.html.contains("k-btn\" href"), "no link in security mails");
            assert!(urls(&c.html).is_empty() && urls(&c.text).is_empty());
        }
        let c = break_glass_sign_in(
            Lang::En,
            &brand(),
            "rescue",
            "198.51.100.7",
            "x",
            Some("https://kalzit.example.com/admin/audit"),
        );
        assert!(c.text.contains("Open the audit log:\nhttps://kalzit.example.com/admin/audit"), "{}", c.text);
        let c = break_glass_sign_in(Lang::En, &brand(), "rescue", "198.51.100.7", "x", None);
        assert!(!c.text.contains("http"));
    }

    #[test]
    fn short_links_name_their_end_and_span() {
        assert_eq!(span(60 * 60_000, Lang::De), "60 Minuten");
        assert_eq!(span(24 * 3_600_000, Lang::En), "24 hours");
        let reset = Reset {
            link: "https://kalzit.example.com/r#t",
            expires: "5. November 2026, 15:20",
            valid: "60 Minuten",
            sent_by: None,
        };
        let text = password_reset(Lang::De, &brand(), &reset).text;
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(text.contains("Der Link gilt bis 5. November 2026, 15:20 (60 Minuten), und genau einmal."), "{text}");
    }

    #[test]
    fn wrapping_keeps_words_and_links_whole() {
        let long = format!("Ein Satz mit {} am Ende und noch mehr Worten danach.", "https://example.com/".repeat(5));
        let wrapped = wrap(&long, "", "");
        assert!(wrapped.lines().any(|l| l == "https://example.com/".repeat(5)), "{wrapped}");
        assert_eq!(wrapped.split_whitespace().collect::<Vec<_>>().join(" "), long);
        assert_eq!(wrap("a b", "  ", "    "), "  a b");
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
