//! The message of a group of instances across rules (docs/PLAN.md section 13, "Routing, Gruppierung, Eskalation"; webhook
//! payload `version: 2`), the payload stored in the outbox ([`Payload`]: a direct rule's message
//! or a group's), and the short form Slack and Teams render ([`Digest`]). Only reduced values,
//! never rows, documents or nodes of a result.

use serde::{Deserialize, Serialize};

use super::eval::{Event, Labels};
use super::message::{
    self, Instance, Links, Message, Organization, RuleInfo, event_word, instance_detail, instance_line, plain_labels,
};
use crate::mail::message::Content;
use crate::mail::templates::{self, Lang};

/// The webhook payload's version of a group's message.
pub const VERSION: u32 = 2;
/// Instances a group's message writes out in mail and webhook; the rest are counted.
pub const MAX_ALERTS: usize = 20;
/// Instances Slack and Teams write out.
pub const MAX_CHAT_ALERTS: usize = 10;

/// A step on the way to the group's policy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathItem {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyRef {
    pub id: String,
    pub name: String,
    pub path: Vec<PathItem>,
}

/// What kind of message a group sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Changes since the group's last message (stage `0`).
    Change,
    /// The group again without changes (stage: the repetition's number).
    Repeat,
    /// An escalation step (stage `e1` to `e3`).
    Escalation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub id: String,
    pub key: String,
    pub labels: Labels,
    pub catch_all: bool,
    pub policy: PolicyRef,
    pub kind: Kind,
    pub stage: String,
    /// The escalation step of an escalation, else 0.
    pub level: u32,
    /// The repetition's number of a repeat, else 0.
    pub repeat: u32,
    pub firing_since: Option<i64>,
}

/// One instance of a group's message, with its rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    #[serde(flatten)]
    pub instance: Instance,
    /// Changed since the group's last message; false for instances that keep firing.
    pub changed: bool,
    pub rule: RuleInfo,
    pub links: Links,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupLinks {
    /// "Stummschalten" with the group's labels as matchers.
    pub silence: Option<String>,
    /// The rule list.
    pub alerts: Option<String>,
}

impl GroupLinks {
    pub fn new(public: Option<&str>, group_labels: &Labels) -> Self {
        let Some(public) = public else { return Self::default() };
        let mut silence = url::Url::parse(&format!("{public}/alerting/silences/new")).ok();
        if let Some(url) = silence.as_mut() {
            let mut query = url.query_pairs_mut();
            for (k, v) in group_labels {
                query.append_pair("label", &format!("{k}={v}"));
            }
        }
        GroupLinks { silence: silence.map(|u| u.to_string()), alerts: Some(format!("{public}/alerting/rules")) }
    }
}

/// The message of one group to one contact point.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMessage {
    pub version: u32,
    /// As `Kalzit-Event` names it: the most important event of the changed instances, `reminder`
    /// for a repeat, `escalation` for an escalation step.
    pub event: String,
    pub delivery_id: String,
    pub organization: Organization,
    pub group: GroupInfo,
    /// Changed instances first, then the ones that keep firing.
    pub alerts: Vec<Alert>,
    /// Instances beyond [`MAX_ALERTS`] or `alerting.webhook_max_bytes`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub omitted_alerts: usize,
    pub links: GroupLinks,
    pub sent_at: i64,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

impl GroupMessage {
    /// The JSON body of a webhook, at most `max_bytes`, as `Message::webhook_body`.
    pub fn webhook_body(&self, max_bytes: usize) -> Vec<u8> {
        let mut message = self.clone();
        loop {
            let body = serde_json::to_vec(&message).expect("a message always serializes");
            if body.len() <= max_bytes || message.alerts.len() <= 1 {
                return body;
            }
            let over = body.len() - max_bytes;
            let per = body.len() / message.alerts.len().max(1);
            let drop = (over / per.max(1)).clamp(1, message.alerts.len() - 1);
            message.alerts.truncate(message.alerts.len() - drop);
            message.omitted_alerts += drop;
        }
    }

    fn total(&self) -> usize {
        self.alerts.len() + self.omitted_alerts
    }

    /// "[Feuert] 3 Instanzen · Lager-API Latenz p95 · MouseWerk", "[Eskaliert, Stufe 1] …".
    pub fn subject(&self, lang: Lang) -> String {
        let word = match (self.group.kind, lang) {
            (Kind::Escalation, Lang::De) => format!("Eskaliert, Stufe {}", self.group.level),
            (Kind::Escalation, Lang::En) => format!("Escalated, step {}", self.group.level),
            _ => event_word(&self.event, lang).to_string(),
        };
        let count = match (self.total(), lang) {
            (1, Lang::De) => "1 Instanz".to_string(),
            (n, Lang::De) => format!("{n} Instanzen"),
            (1, Lang::En) => "1 instance".to_string(),
            (n, Lang::En) => format!("{n} instances"),
        };
        format!("[{word}] {count} · {} · {}", self.group_name(), self.organization.name)
    }

    /// The group in short: the values of its labels, or its policy's name.
    pub fn group_name(&self) -> String {
        if self.group.labels.is_empty() || self.group.labels.len() > 3 {
            return self.group.policy.name.clone();
        }
        self.group.labels.values().cloned().collect::<Vec<_>>().join(", ")
    }

    fn path_text(&self) -> String {
        self.group.policy.path.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(" › ")
    }

    /// "Richtlinie Standard › Lager · Gruppe alertname=… · feuert seit 14:02".
    fn context_line(&self, lang: Lang, zone: Option<&str>) -> String {
        let mut parts = vec![match lang {
            Lang::De => format!("Richtlinie {}", self.path_text()),
            Lang::En => format!("Policy {}", self.path_text()),
        }];
        if !self.group.labels.is_empty() {
            parts.push(match lang {
                Lang::De => format!("Gruppe {}", plain_labels(&self.group.labels)),
                Lang::En => format!("group {}", plain_labels(&self.group.labels)),
            });
        }
        if let Some(since) = self.group.firing_since {
            let at = templates::moment(since, zone, lang);
            parts.push(match lang {
                Lang::De => format!("feuert seit {at}"),
                Lang::En => format!("firing since {at}"),
            });
        }
        parts.join(" · ")
    }

    /// The single rule of the message, when all its instances come from one.
    fn single_rule(&self) -> Option<&Alert> {
        let first = self.alerts.first()?;
        self.alerts.iter().all(|a| a.rule.id == first.rule.id).then_some(first)
    }

    /// The headings of the message's sections and their alerts: changes first ("Neu seit der
    /// letzten Nachricht", "Behoben"), then the instances that keep firing.
    fn sections(&self, lang: Lang) -> Vec<(String, Vec<&Alert>)> {
        let de = lang == Lang::De;
        let mut out = Vec::new();
        let new: Vec<&Alert> =
            self.alerts.iter().filter(|a| a.changed && a.instance.event != Event::Resolved).collect();
        let resolved: Vec<&Alert> =
            self.alerts.iter().filter(|a| a.changed && a.instance.event == Event::Resolved).collect();
        let rest: Vec<&Alert> = self.alerts.iter().filter(|a| !a.changed).collect();
        match self.group.kind {
            Kind::Change => {
                if !new.is_empty() {
                    out.push((if de { "Neu seit der letzten Nachricht" } else { "New since the last message" }, new));
                }
                if !resolved.is_empty() {
                    out.push((if de { "Behoben" } else { "Resolved" }, resolved));
                }
                if !rest.is_empty() {
                    out.push((if de { "Feuert weiter" } else { "Still firing" }, rest));
                }
            }
            Kind::Repeat | Kind::Escalation => {
                let all: Vec<&Alert> = self.alerts.iter().collect();
                if !all.is_empty() {
                    out.push((if de { "Instanzen" } else { "Instances" }, all));
                }
            }
        }
        out.into_iter().map(|(h, a)| (h.to_string(), a)).collect()
    }

    /// The mail in `lang`; times in `zone`, `host` names the sender.
    pub fn mail(&self, lang: Lang, zone: Option<&str>, host: &str) -> Content {
        let de = lang == Lang::De;
        let mut paragraphs = vec![self.context_line(lang, zone)];
        for (heading, alerts) in self.sections(lang) {
            paragraphs.push(format!("{}:", heading));
            for a in alerts {
                paragraphs.push(format!("{} · {}", a.rule.name, instance_line(&a.rule, &a.instance, lang, zone)));
            }
        }
        if self.omitted_alerts > 0 {
            paragraphs.push(match lang {
                Lang::De => format!("Und {} weitere.", self.omitted_alerts),
                Lang::En => format!("And {} more.", self.omitted_alerts),
            });
        }
        let mut links = Vec::new();
        if let Some(single) = self.single_rule() {
            if let Some(url) = &single.links.rule {
                links.push(format!("{}: {url}", if de { "Regel öffnen" } else { "Open rule" }));
            }
            if let Some(url) = &single.links.panel {
                links.push(format!("{}: {url}", if de { "Panel öffnen" } else { "Open panel" }));
            }
            if let Some(url) = &single.rule.runbook_url {
                links.push(format!("{}: {url}", if de { "Anleitung" } else { "Runbook" }));
            }
        }
        if let Some(url) = &self.links.silence {
            links.push(format!("{}: {url}", if de { "Gruppe stummschalten" } else { "Silence group" }));
        }
        if self.omitted_alerts > 0
            && let Some(url) = &self.links.alerts
        {
            links.push(format!("{}: {url}", if de { "Alle anzeigen" } else { "Show all" }));
        }
        paragraphs.extend(links);
        if self.group.kind == Kind::Escalation {
            paragraphs.push(match lang {
                Lang::De => format!("Du bekommst diese Mail über die Eskalationsstufe {}.", self.group.level),
                Lang::En => format!("You get this mail through escalation step {}.", self.group.level),
            });
        }
        let footer = match lang {
            Lang::De => format!(
                "Gesendet von Kalzit ({host}). Nur reduzierte Werte, keine Zeilen, Dokumente oder Knoten aus dem \
                 Ergebnis."
            ),
            Lang::En => {
                format!("Sent by Kalzit ({host}). Reduced values only, no rows, documents or nodes of the result.")
            }
        };
        Content {
            text: templates::text(&paragraphs, None, &footer),
            html: templates::html(&paragraphs, None, &footer),
            subject: self.subject(lang),
        }
    }

    fn digest(&self, lang: Lang, zone: Option<&str>) -> Digest {
        let de = lang == Lang::De;
        let changed = self.alerts.iter().filter(|a| a.changed).count();
        let mut subtitle = vec![self.organization.name.clone(), self.group.policy.name.clone()];
        if self.group.kind == Kind::Change && changed > 0 && changed < self.total() {
            let rest = self.total() - changed;
            subtitle.push(if de {
                format!("{changed} neu, {rest} weiter")
            } else {
                format!("{changed} new, {rest} still")
            });
        }
        let mut entries = Vec::new();
        for (_, alerts) in self.sections(lang) {
            for a in alerts {
                let tag = match (self.group.kind, a.changed, a.instance.event) {
                    (Kind::Change, true, Event::Resolved) => Some(if de { "behoben" } else { "resolved" }),
                    (Kind::Change, true, _) => Some(if de { "neu" } else { "new" }),
                    _ => None,
                };
                let who = if a.instance.labels.is_empty() { String::new() } else { plain_labels(&a.instance.labels) };
                entries.push(DigestEntry {
                    heading: a.rule.name.clone(),
                    labels: who,
                    text: instance_detail(&a.rule, &a.instance, lang, zone),
                    tag: tag.map(str::to_string),
                    link: a.links.rule.clone(),
                });
            }
        }
        let title = self.subject(lang);
        let title = title.rsplit_once(" · ").map_or(title.clone(), |(t, _)| t.to_string());
        let mut buttons = Vec::new();
        if let Some(single) = self.single_rule() {
            if let Some(url) = &single.links.rule {
                buttons.push((if de { "Regel öffnen" } else { "Open rule" }.to_string(), url.clone()));
            }
            if let Some(url) = &single.links.panel {
                buttons.push((if de { "Panel öffnen" } else { "Open panel" }.to_string(), url.clone()));
            }
        }
        if let Some(url) = &self.links.silence {
            buttons.push((if de { "Stummschalten" } else { "Silence" }.to_string(), url.clone()));
        }
        Digest {
            title,
            subtitle: subtitle.join(" · "),
            entries,
            more: self.omitted_alerts,
            more_link: self.links.alerts.clone(),
            buttons,
            lang,
        }
    }
}

/// A message as the outbox stores and sends it: a direct rule's (`version: 1`) or a group's
/// (`version: 2`). Serialized as the message itself.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Payload {
    Rule(Message),
    Group(GroupMessage),
}

/// One history entry a delivery attempt writes per instance.
pub struct HistoryEntry<'a> {
    pub rule_id: &'a str,
    pub rule_name: &'a str,
    pub fingerprint: &'a str,
    pub labels: &'a Labels,
    pub event: &'a str,
}

impl Payload {
    /// The stored JSON: `version: 2` is a group's message, anything else a rule's.
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        let value: serde_json::Value = serde_json::from_str(text)?;
        if value.get("version").and_then(serde_json::Value::as_u64) == Some(u64::from(VERSION)) {
            Ok(Payload::Group(serde_json::from_value(value)?))
        } else {
            Ok(Payload::Rule(serde_json::from_value(value)?))
        }
    }

    pub fn event(&self) -> &str {
        match self {
            Payload::Rule(m) => &m.event,
            Payload::Group(m) => &m.event,
        }
    }

    pub fn delivery_id(&self) -> &str {
        match self {
            Payload::Rule(m) => &m.delivery_id,
            Payload::Group(m) => &m.delivery_id,
        }
    }

    pub fn webhook_body(&self, max_bytes: usize) -> Vec<u8> {
        match self {
            Payload::Rule(m) => m.webhook_body(max_bytes),
            Payload::Group(m) => m.webhook_body(max_bytes),
        }
    }

    pub fn mail(&self, lang: Lang, zone: Option<&str>, host: &str) -> Content {
        match self {
            Payload::Rule(m) => m.mail(lang, zone, host),
            Payload::Group(m) => m.mail(lang, zone, host),
        }
    }

    /// The short form Slack and Teams render, with at most [`MAX_CHAT_ALERTS`] instances.
    pub fn digest(&self, lang: Lang, zone: Option<&str>) -> Digest {
        let mut digest = match self {
            Payload::Rule(m) => rule_digest(m, lang, zone),
            Payload::Group(m) => m.digest(lang, zone),
        };
        if digest.entries.len() > MAX_CHAT_ALERTS {
            digest.more += digest.entries.len() - MAX_CHAT_ALERTS;
            digest.entries.truncate(MAX_CHAT_ALERTS);
        }
        digest
    }

    /// The entries a delivery attempt writes to the history: one per instance, or one without a
    /// rule for a message without instances (a test send).
    pub fn history_entries(&self) -> Vec<HistoryEntry<'_>> {
        match self {
            Payload::Rule(m) => m
                .instances
                .iter()
                .map(|i| HistoryEntry {
                    rule_id: &m.rule.id,
                    rule_name: &m.rule.name,
                    fingerprint: &i.fingerprint,
                    labels: &i.labels,
                    event: i.event.as_str(),
                })
                .collect(),
            Payload::Group(m) => m
                .alerts
                .iter()
                .map(|a| HistoryEntry {
                    rule_id: &a.rule.id,
                    rule_name: &a.rule.name,
                    fingerprint: &a.instance.fingerprint,
                    labels: &a.instance.labels,
                    event: if m.group.kind == Kind::Escalation { "escalation" } else { a.instance.event.as_str() },
                })
                .collect(),
        }
    }

    /// The group, its policy and the stage of a group's message.
    pub fn group(&self) -> Option<&GroupInfo> {
        match self {
            Payload::Group(m) => Some(&m.group),
            Payload::Rule(_) => None,
        }
    }
}

/// A direct rule's message in short.
fn rule_digest(m: &Message, lang: Lang, zone: Option<&str>) -> Digest {
    let de = lang == Lang::De;
    let word = event_word(&m.event, lang);
    let mut entries = Vec::new();
    if m.event == message::TEST_EVENT {
        entries.push(DigestEntry {
            heading: if de { "Testnachricht" } else { "Test message" }.to_string(),
            labels: String::new(),
            text: if de {
                "So sieht eine Benachrichtigung dieses Kontaktpunkts aus. Die Werte sind Beispiele."
            } else {
                "This is what a notification of this contact point looks like. The values are examples."
            }
            .to_string(),
            tag: None,
            link: None,
        });
    }
    for i in &m.instances {
        entries.push(DigestEntry {
            heading: m.rule.name.clone(),
            labels: if i.labels.is_empty() { String::new() } else { plain_labels(&i.labels) },
            text: instance_detail(&m.rule, i, lang, zone),
            tag: None,
            link: None,
        });
    }
    let mut buttons = Vec::new();
    if let Some(url) = &m.links.rule {
        buttons.push((if de { "Regel öffnen" } else { "Open rule" }.to_string(), url.clone()));
    }
    if let Some(url) = &m.links.panel {
        buttons.push((if de { "Panel öffnen" } else { "Open panel" }.to_string(), url.clone()));
    }
    if let Some(url) = &m.links.silence {
        buttons.push((if de { "Stummschalten" } else { "Silence" }.to_string(), url.clone()));
    }
    let subtitle = if m.rule.labels.is_empty() {
        m.organization.name.clone()
    } else {
        format!("{} · {}", m.organization.name, plain_labels(&m.rule.labels))
    };
    Digest {
        title: format!("[{word}] {}", m.rule.name),
        subtitle,
        entries,
        more: m.omitted_instances,
        more_link: m.links.rule.clone(),
        buttons,
        lang,
    }
}

/// A message in short, for Slack and Teams.
#[derive(Clone, Debug, PartialEq)]
pub struct Digest {
    pub title: String,
    pub subtitle: String,
    pub entries: Vec<DigestEntry>,
    /// Instances not written out.
    pub more: usize,
    pub more_link: Option<String>,
    /// Labels and links of the buttons.
    pub buttons: Vec<(String, String)>,
    pub lang: Lang,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DigestEntry {
    /// The rule's name.
    pub heading: String,
    /// The instance's labels, empty without.
    pub labels: String,
    /// State, value and condition, and since when.
    pub text: String,
    /// "neu" or "behoben" in a change.
    pub tag: Option<String>,
    pub link: Option<String>,
}

impl Digest {
    /// "und 12 weitere" / "and 12 more".
    pub fn more_text(&self) -> Option<String> {
        (self.more > 0).then(|| match self.lang {
            Lang::De => format!("und {} weitere", self.more),
            Lang::En => format!("and {} more", self.more),
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::alerting::eval::State;
    use crate::alerting::rule::{Condition, Reduce};
    use serde_json::json;

    fn rule(id: &str, name: &str) -> RuleInfo {
        RuleInfo {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            runbook_url: Some("https://wiki.example/lager-api".into()),
            labels: [("team".to_string(), "lager".to_string())].into(),
            reduce: Reduce::parse(&json!({ "shape": "frame", "function": "max" })).unwrap(),
            condition: Condition::parse(&json!({ "op": "gt", "value": 1.5 })).unwrap(),
        }
    }

    fn alert(rule_id: &str, instance: &str, event: Event, state: State, value: f64, changed: bool) -> Alert {
        Alert {
            instance: Instance {
                fingerprint: format!("f-{instance}"),
                labels: [("instance".to_string(), instance.to_string())].into(),
                event,
                state,
                state_since: 1_794_319_260_000,
                value: Some(value),
                error: None,
                reminder: 0,
                reason: None,
            },
            changed,
            rule: rule(rule_id, "Lager-API Latenz p95"),
            links: Links::new(Some("https://kalzit.example"), rule_id, Some(("d", Some("p1")))),
        }
    }

    pub(crate) fn sample() -> GroupMessage {
        let group_labels: Labels = [("alertname".to_string(), "Lager-API Latenz p95".to_string())].into();
        GroupMessage {
            version: VERSION,
            event: "firing".into(),
            delivery_id: "0190-delivery".into(),
            organization: Organization { id: "o".into(), name: "MouseWerk".into() },
            group: GroupInfo {
                id: "g".into(),
                key: "k".into(),
                labels: group_labels.clone(),
                catch_all: false,
                policy: PolicyRef {
                    id: "p".into(),
                    name: "Lager kritisch".into(),
                    path: vec![
                        PathItem { id: "o".into(), name: "Standard".into() },
                        PathItem { id: "l".into(), name: "Lager".into() },
                        PathItem { id: "p".into(), name: "Lager kritisch".into() },
                    ],
                },
                kind: Kind::Change,
                stage: "0".into(),
                level: 0,
                repeat: 0,
                firing_since: Some(1_794_319_260_000),
            },
            alerts: vec![
                alert("r", "lager-api-3", Event::Firing, State::Firing, 1.62, true),
                alert("r", "lager-api-2", Event::Firing, State::Firing, 1.84, false),
                alert("r", "lager-api-1", Event::Firing, State::Firing, 1.57, false),
            ],
            omitted_alerts: 0,
            links: GroupLinks::new(Some("https://kalzit.example"), &group_labels),
            sent_at: 1_794_319_320_000,
        }
    }

    #[test]
    fn group_mails_put_changes_first_and_name_the_group() {
        let m = sample();
        let de = m.mail(Lang::De, Some("Europe/Berlin"), "kalzit.example");
        assert_eq!(de.subject, "[Feuert] 3 Instanzen · Lager-API Latenz p95 · MouseWerk");
        let text = de.text;
        assert!(
            text.starts_with("Richtlinie Standard › Lager › Lager kritisch · Gruppe alertname=Lager-API Latenz p95")
        );
        let new = text.find("Neu seit der letzten Nachricht:").unwrap();
        let still = text.find("Feuert weiter:").unwrap();
        let third = text.find("instance=lager-api-3").unwrap();
        assert!(new < third && third < still, "{text}");
        assert!(
            text.contains("Lager-API Latenz p95 · instance=lager-api-3: feuert, max = 1,62, Bedingung > 1,5"),
            "{text}"
        );
        assert!(text.contains("Regel öffnen: https://kalzit.example/alerting/rules/r"));
        assert!(
            text.contains("Gruppe stummschalten: https://kalzit.example/alerting/silences/new?label=alertname%3DLager-API+Latenz+p95"),
            "{text}"
        );

        let mut escalated = m.clone();
        escalated.group.kind = Kind::Escalation;
        escalated.group.level = 1;
        escalated.group.stage = "e1".into();
        escalated.event = "escalation".into();
        let de = escalated.mail(Lang::De, None, "h");
        assert_eq!(de.subject, "[Eskaliert, Stufe 1] 3 Instanzen · Lager-API Latenz p95 · MouseWerk");
        assert!(de.text.contains("Du bekommst diese Mail über die Eskalationsstufe 1."));
        let en = escalated.mail(Lang::En, None, "h");
        assert_eq!(en.subject, "[Escalated, step 1] 3 instances · Lager-API Latenz p95 · MouseWerk");
    }

    #[test]
    fn version_2_bodies_carry_the_group_and_each_rule() {
        let m = sample();
        let body: serde_json::Value = serde_json::from_slice(&m.webhook_body(256 * 1024)).unwrap();
        assert_eq!(body["version"], 2);
        assert_eq!(body["group"]["policy"]["path"][1]["name"], "Lager");
        assert_eq!(body["group"]["stage"], "0");
        assert_eq!(body["group"]["kind"], "change");
        assert_eq!(body["alerts"][0]["changed"], true);
        assert_eq!(body["alerts"][0]["value"], 1.62);
        assert_eq!(body["alerts"][0]["rule"]["name"], "Lager-API Latenz p95");
        assert!(body.get("omittedAlerts").is_none());
        // Stored and read back as the same payload.
        let stored = serde_json::to_string(&Payload::Group(m.clone())).unwrap();
        assert_eq!(Payload::parse(&stored).unwrap(), Payload::Group(m.clone()));
        let rule = crate::alerting::message::tests::sample();
        let stored = serde_json::to_string(&Payload::Rule(rule.clone())).unwrap();
        assert_eq!(Payload::parse(&stored).unwrap(), Payload::Rule(rule));
        let mut many = m.clone();
        many.alerts = (0..100).map(|_| m.alerts[0].clone()).collect();
        let small = many.webhook_body(8192);
        assert!(small.len() <= 8192);
        let body: serde_json::Value = serde_json::from_slice(&small).unwrap();
        assert_eq!(body["alerts"].as_array().unwrap().len() + body["omittedAlerts"].as_u64().unwrap() as usize, 100);
        // History entries: one per instance, escalations named so.
        let mut escalated = m;
        escalated.group.kind = Kind::Escalation;
        let p = Payload::Group(escalated);
        assert!(p.history_entries().iter().all(|e| e.event == "escalation" && e.rule_id == "r"));
    }
}
