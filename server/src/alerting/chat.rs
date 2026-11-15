//! Slack and Microsoft Teams (docs/PLAN.md section 13, "Slack und Microsoft Teams"): a message
//! in short ([`Digest`]) as Slack Blocks or a Teams Adaptive Card, posted to the channel's
//! incoming webhook URL (the contact point's secret) the way webhooks go out. Only reduced values;
//! no buttons that act in Kalzit, no bot tokens.
//!
//! Text from labels, names and errors becomes neither a mention nor a link: Slack's `<!channel>`,
//! `<@U123>` and `<url|text>` cannot form, since `<`, `>` and `&` are escaped; Markdown in Teams
//! is escaped; and what both would link by themselves (a bare `https://…`, `www.…`,
//! `host.example`, `name@host.example`) is broken up by an invisible word joiner ([`defuse`]),
//! so it reads the same but is no link. Only Kalzit's own links (the buttons and "and 12 more")
//! are links.

use serde_json::{Value, json};

use super::group_message::{Digest, DigestEntry};
use super::webhook::{self, Posted};
use crate::app::AppState;

/// Slack's limit of blocks per message.
pub const SLACK_MAX_BLOCKS: usize = 50;
/// Slack's limit of a header's text.
const SLACK_HEADER_CHARS: usize = 150;
/// Slack's limit of a section's text.
const SLACK_SECTION_CHARS: usize = 3000;
/// Teams' limit of a message (28 KB), with room for the envelope.
pub const TEAMS_MAX_BYTES: usize = 27 * 1024;

fn cut(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// U+2060 WORD JOINER: invisible, and no line break where it stands.
const WORD_JOINER: char = '\u{2060}';

/// Breaks what a chat would turn into a link by itself: a word joiner after the `:` of `://` and
/// after every dot that a letter follows (`www.`, host names, mail addresses). Numbers, times and
/// sentences ("1.62", "14:01", "10. November") stay as they are.
fn defuse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        out.push(c);
        let next = &text[i + c.len_utf8()..];
        let breaks = match c {
            ':' => next.starts_with("//"),
            '.' => next.chars().next().is_some_and(char::is_alphabetic),
            _ => false,
        };
        if breaks {
            out.push(WORD_JOINER);
        }
    }
    out
}

/// Slack's `mrkdwn` escaping: `&`, `<` and `>`, so no mention, command or `<url|text>` link can
/// form, and [`defuse`], so no bare address is linked either.
fn slack_escape(text: &str) -> String {
    defuse(&slack_entities(text))
}

/// `&`, `<` and `>` as Slack's entities.
fn slack_entities(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Markdown escaping for the text blocks of an Adaptive Card: every character Markdown gives a
/// meaning (links, emphasis, headings, code, quotes, lists) is taken literally, and [`defuse`]
/// keeps bare addresses from being linked.
fn md_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '[' | ']' | '(' | ')' | '*' | '_' | '~' | '#' | '`' | '>' | '<') {
            out.push('\\');
        }
        out.push(c);
    }
    defuse(&out)
}

fn slack_entry(e: &DigestEntry) -> Value {
    let mut first = format!("*{}*", slack_escape(&e.heading));
    if !e.labels.is_empty() {
        first.push_str(&format!(" · {}", slack_escape(&e.labels)));
    }
    if let Some(tag) = &e.tag {
        first.push_str(&format!(" · _{}_", slack_escape(tag)));
    }
    let text = cut(&format!("{first}\n{}", slack_escape(&e.text)), SLACK_SECTION_CHARS);
    json!({ "type": "section", "text": { "type": "mrkdwn", "text": text, "verbatim": true } })
}

/// The Slack message: a header with the state and the group or rule, a line with the
/// organization, a section per instance, "und 12 weitere", and link buttons while the server has
/// a public address. At most [`SLACK_MAX_BLOCKS`] blocks.
pub fn slack(d: &Digest) -> Value {
    let mut blocks = vec![
        json!({ "type": "header", "text": { "type": "plain_text", "text": defuse(&cut(&d.title, SLACK_HEADER_CHARS)), "emoji": false } }),
        json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": slack_escape(&d.subtitle), "verbatim": true }] }),
    ];
    // Room for the header, the context, "more" and the buttons.
    let room = SLACK_MAX_BLOCKS - 4;
    let shown = d.entries.len().min(room);
    blocks.extend(d.entries.iter().take(shown).map(slack_entry));
    let more = d.more + (d.entries.len() - shown);
    if more > 0 {
        let text = Digest { more, ..d.clone() }.more_text().unwrap_or_default();
        let text = match &d.more_link {
            // Kalzit's own link: escaped, but not defused.
            Some(url) => format!("<{}|{}>", slack_entities(url), slack_escape(&text)),
            None => slack_escape(&text),
        };
        blocks.push(json!({ "type": "context", "elements": [{ "type": "mrkdwn", "text": text, "verbatim": true }] }));
    }
    if !d.buttons.is_empty() {
        let elements: Vec<Value> = d
            .buttons
            .iter()
            .map(
                |(label, url)| json!({ "type": "button", "text": { "type": "plain_text", "text": label }, "url": url }),
            )
            .collect();
        blocks.push(json!({ "type": "actions", "elements": elements }));
    }
    json!({ "text": slack_escape(&d.title), "blocks": blocks, "unfurl_links": false, "unfurl_media": false })
}

fn teams_card(d: &Digest, shown: usize) -> Value {
    let mut body = vec![
        json!({ "type": "TextBlock", "text": md_escape(&d.title), "weight": "Bolder", "size": "Medium", "wrap": true }),
        json!({ "type": "TextBlock", "text": md_escape(&d.subtitle), "isSubtle": true, "spacing": "None", "wrap": true }),
    ];
    for e in d.entries.iter().take(shown) {
        let mut heading = e.heading.clone();
        if !e.labels.is_empty() {
            heading.push_str(&format!(" · {}", e.labels));
        }
        if let Some(tag) = &e.tag {
            heading.push_str(&format!(" · {tag}"));
        }
        body.push(json!({
            "type": "Container", "separator": true,
            "items": [
                { "type": "TextBlock", "text": md_escape(&heading), "weight": "Bolder", "wrap": true },
                { "type": "TextBlock", "text": md_escape(&e.text), "spacing": "None", "wrap": true }
            ]
        }));
    }
    let more = d.more + (d.entries.len() - shown);
    if more > 0 {
        let text = Digest { more, ..d.clone() }.more_text().unwrap_or_default();
        body.push(json!({ "type": "TextBlock", "text": md_escape(&text), "isSubtle": true, "wrap": true }));
    }
    let mut actions: Vec<Value> =
        d.buttons.iter().map(|(label, url)| json!({ "type": "Action.OpenUrl", "title": label, "url": url })).collect();
    if more > 0
        && let Some(url) = &d.more_link
    {
        let label = if d.lang == crate::mail::templates::Lang::De { "Alle anzeigen" } else { "Show all" };
        actions.push(json!({ "type": "Action.OpenUrl", "title": label, "url": url }));
    }
    json!({
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "contentUrl": null,
            "content": {
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "type": "AdaptiveCard",
                "version": "1.4",
                "body": body,
                "actions": actions
            }
        }]
    })
}

/// The Teams message: an Adaptive Card with the same content as Slack's, under
/// [`TEAMS_MAX_BYTES`] (instances are left out from the end until it fits).
pub fn teams(d: &Digest) -> Value {
    let mut shown = d.entries.len();
    loop {
        let card = teams_card(d, shown);
        if shown == 0 || serde_json::to_vec(&card).map_or(0, |b| b.len()) <= TEAMS_MAX_BYTES {
            return card;
        }
        shown -= 1;
    }
}

/// Posts `body` to the channel's `url` once.
pub async fn send(state: &AppState, url: &str, body: &Value, delivery_id: &str) -> Posted {
    let body = serde_json::to_vec(body).expect("a message always serializes");
    webhook::post(state, url, Default::default(), body, delivery_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerting::group_message::{Payload, tests::sample};
    use crate::mail::templates::Lang;

    #[test]
    fn slack_messages_are_blocks_with_reduced_values() {
        let digest = Payload::Group(sample()).digest(Lang::De, None);
        let body = slack(&digest);
        assert_eq!(body["text"], "[Feuert] 3 Instanzen · Lager-API Latenz p95");
        let blocks = body["blocks"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "header");
        assert_eq!(blocks[1]["elements"][0]["text"], "MouseWerk · Lager kritisch · 1 neu, 2 weiter");
        assert_eq!(
            blocks[2]["text"]["text"],
            "*Lager-API Latenz p95* · instance=lager-api-3 · _neu_\nfeuert, max = 1,62, Bedingung &gt; 1,5, seit 10. November 2026, 14:01 UTC"
        );
        let actions = blocks.last().unwrap();
        assert_eq!(actions["type"], "actions");
        let labels: Vec<&str> =
            actions["elements"].as_array().unwrap().iter().map(|b| b["text"]["text"].as_str().unwrap()).collect();
        assert_eq!(labels, ["Regel öffnen", "Panel öffnen", "Stummschalten"]);
        assert_eq!(body["unfurl_links"], false);
    }

    #[test]
    fn slack_stays_within_its_limits_and_escapes_mentions() {
        let mut m = sample();
        m.alerts = (0..40).map(|_| m.alerts[0].clone()).collect();
        m.alerts[0].rule.name = "<!channel> & <@U123>".into();
        let digest = Payload::Group(m).digest(Lang::En, None);
        assert_eq!(digest.entries.len(), 10, "10 instances written out");
        assert_eq!(digest.more_text().as_deref(), Some("and 30 more"));
        let body = slack(&digest);
        let blocks = body["blocks"].as_array().unwrap();
        assert!(blocks.len() <= SLACK_MAX_BLOCKS);
        let text = body.to_string();
        assert!(!text.contains("<!channel>") && !text.contains("<@U123>"), "{text}");
        assert!(text.contains("&lt;!channel&gt; &amp; &lt;@U123&gt;"));
        assert!(text.contains("|and 30 more>"), "a link to the list");
    }

    #[test]
    fn teams_cards_carry_the_same_content_under_28_kb() {
        let digest = Payload::Group(sample()).digest(Lang::En, None);
        let body = teams(&digest);
        let card = &body["attachments"][0]["content"];
        assert_eq!(body["attachments"][0]["contentType"], "application/vnd.microsoft.card.adaptive");
        assert_eq!(card["type"], "AdaptiveCard");
        assert_eq!(card["body"][0]["text"], "\\[Firing\\] 3 instances · Lager-API Latenz p95");
        assert_eq!(card["body"][2]["items"][0]["text"], "Lager-API Latenz p95 · instance=lager-api-3 · new");
        assert_eq!(card["actions"][2]["title"], "Silence");
        let mut m = sample();
        m.alerts = (0..10).map(|_| m.alerts[0].clone()).collect();
        for a in &mut m.alerts {
            a.rule.name = "x".repeat(5000);
        }
        let body = teams(&Payload::Group(m).digest(Lang::En, None));
        assert!(serde_json::to_vec(&body).unwrap().len() <= TEAMS_MAX_BYTES);
        let text = body.to_string();
        assert!(text.contains("and "), "instances left out are counted");
    }

    /// What a chat links by itself in text: a scheme, `www.` and anything that looks like a host
    /// name (a letter or digit, a dot, a letter), which covers mail addresses too.
    fn autolinks(text: &str) -> Vec<String> {
        let re = regex::Regex::new(r"(?i)[a-z][a-z0-9+.-]*:/|www\.|[a-z0-9-]\.[a-z]").unwrap();
        re.find_iter(text).map(|m| m.as_str().to_string()).collect()
    }

    /// Every text Slack reads as `mrkdwn` or shows (the fallback text, the header, the context and
    /// the sections), without Kalzit's own buttons.
    fn slack_texts(body: &Value) -> Vec<String> {
        let mut out = vec![body["text"].as_str().unwrap().to_string()];
        for block in body["blocks"].as_array().unwrap() {
            match block["type"].as_str().unwrap() {
                "header" | "section" => out.push(block["text"]["text"].as_str().unwrap().to_string()),
                "context" => out.extend(block["elements"].as_array().unwrap().iter().map(|e| e["text"].to_string())),
                _ => {}
            }
        }
        out
    }

    /// Every text block of a Teams card, without its actions.
    fn teams_texts(card: &Value) -> Vec<String> {
        let mut out = Vec::new();
        for item in card["attachments"][0]["content"]["body"].as_array().unwrap() {
            match item["type"].as_str().unwrap() {
                "TextBlock" => out.push(item["text"].as_str().unwrap().to_string()),
                _ => out
                    .extend(item["items"].as_array().unwrap().iter().map(|i| i["text"].as_str().unwrap().to_string())),
            }
        }
        out
    }

    #[test]
    fn nothing_from_labels_or_names_becomes_a_mention_or_a_link() {
        const HOSTILE: &str = "<!here> <https://x.example|y> https://evil.example/a www.evil.example \
                               evil.example mail@evil.example [klick](https://evil.example)";
        // A group label, an instance label and a rule's name, in a group and a direct rule's message.
        let mut m = sample();
        m.group.labels = [("alertname".to_string(), HOSTILE.to_string())].into();
        m.alerts[0].rule.name = HOSTILE.into();
        m.alerts[0].instance.labels = [("instance".to_string(), HOSTILE.to_string())].into();
        let group = Payload::Group(m).digest(Lang::En, None);
        let mut rule = crate::alerting::message::tests::sample();
        rule.rule.name = HOSTILE.into();
        let direct = Payload::Rule(rule).digest(Lang::En, None);
        for digest in [&group, &direct] {
            let body = slack(digest);
            assert_eq!(body["blocks"][0]["text"]["type"], "plain_text");
            // Slack links nothing by itself in `verbatim` text, the first line against links.
            let json = body.to_string();
            assert_eq!(
                json.matches("\"type\":\"mrkdwn\"").count(),
                json.matches("\"verbatim\":true").count(),
                "{json}"
            );
            for text in slack_texts(&body) {
                assert!(!text.contains("<!here>") && !text.contains("<https:"), "{text}");
                assert_eq!(autolinks(&text), Vec::<String>::new(), "{text}");
            }
            for text in teams_texts(&teams(digest)) {
                assert!(!text.contains("[klick](") && !text.contains("](https"), "{text}");
                assert_eq!(autolinks(&text), Vec::<String>::new(), "{text}");
            }
        }
        // It reads the same: only invisible word joiners were added.
        let heading = slack(&group)["blocks"][2]["text"]["text"].as_str().unwrap().replace(WORD_JOINER, "");
        assert!(
            heading.contains("https://evil.example/a www.evil.example evil.example mail@evil.example"),
            "{heading}"
        );
        let card = teams(&group);
        let heading = card["attachments"][0]["content"]["body"][2]["items"][0]["text"].as_str().unwrap();
        assert!(heading.replace(WORD_JOINER, "").contains("\\[klick\\]\\(https://evil.example\\)"), "{heading}");
        assert_eq!(md_escape("*a* _b_ `c` # > ~"), "\\*a\\* \\_b\\_ \\`c\\` \\# \\> \\~");
        // Numbers, times and sentences keep their characters.
        assert_eq!(
            defuse("max = 1.62, seit 10. November 2026, 14:01 UTC."),
            "max = 1.62, seit 10. November 2026, 14:01 UTC."
        );
        assert_eq!(defuse("http://a.b"), "http:\u{2060}//a.\u{2060}b");
        // Kalzit's own buttons stay links.
        let body = slack(&group);
        let actions = body["blocks"].as_array().unwrap().iter().find(|b| b["type"] == "actions").unwrap();
        assert!(actions["elements"][0]["url"].as_str().unwrap().contains("://"), "{actions}");
    }

    #[test]
    fn a_direct_rules_message_renders_too() {
        let rule = crate::alerting::message::tests::sample();
        let digest = Payload::Rule(rule).digest(Lang::De, None);
        assert_eq!(digest.title, "[Feuert] Lager-API Latenz p95");
        assert_eq!(digest.entries.len(), 2);
        assert_eq!(slack(&digest)["blocks"][1]["elements"][0]["text"], "MouseWerk · team=lager");
    }
}
