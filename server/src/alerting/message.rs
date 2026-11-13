//! The message one evaluation of a rule sends to one contact point (docs/PLAN.md section 13,
//! "Benachrichtigungen"): the rule, the organization and every instance that changed, with its
//! labels and its reduced value only, never rows, documents or nodes of the result. It is stored
//! as JSON in the delivery outbox (`alerting::outbox`) and sent as it is: as the webhook body, or
//! as a mail in the contact point's language.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::eval::{EvalError, Event, Labels, Notification, ResolveReason, State};
use super::rule::{Condition, DocumentMode, GraphCount, Op, Reduce};
use crate::mail::message::Content;
use crate::mail::templates::{self, Lang};

/// The webhook payload's version.
pub const VERSION: u32 = 1;
/// The event of a test send (`Kalzit-Event: test`).
pub const TEST_EVENT: &str = "test";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
}

/// What the message says about the rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub runbook_url: Option<String>,
    pub labels: BTreeMap<String, String>,
    pub reduce: Reduce,
    pub condition: Condition,
}

/// One instance in the message.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub fingerprint: String,
    pub labels: Labels,
    pub event: Event,
    /// The state reported: `ok` for resolved, for a reminder the state that lasts.
    pub state: State,
    /// The start of the reported state; for resolved, the start of the state that ended.
    pub state_since: i64,
    /// The reduced value, `null` without one (no data, an error, a series that is gone).
    pub value: Option<f64>,
    /// Why the evaluation failed, as `{code, params}`.
    pub error: Option<EvalError>,
    /// 0 for the change itself, n for the n-th reminder.
    pub reminder: u32,
    /// Why a resolved instance went back to OK (`series_gone`, `replaced`).
    pub reason: Option<ResolveReason>,
}

impl From<&Notification> for Instance {
    fn from(n: &Notification) -> Self {
        Instance {
            fingerprint: n.fingerprint.clone(),
            labels: n.labels.clone(),
            event: n.event,
            state: n.state,
            state_since: n.state_since,
            value: n.value,
            error: n.error.clone(),
            reminder: n.reminder,
            reason: n.reason,
        }
    }
}

/// Links to the UI; `None` while the server has no public address (`server.public_url`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Links {
    pub rule: Option<String>,
    pub panel: Option<String>,
    pub silence: Option<String>,
}

impl Links {
    /// The links of a rule under `public` (the server's public address, without a trailing
    /// slash). Whoever opens one signs in first and sees only what they may.
    pub fn new(public: Option<&str>, rule_id: &str, dashboard: Option<(&str, Option<&str>)>) -> Self {
        let Some(public) = public else { return Self::default() };
        Links {
            rule: Some(format!("{public}/alerting/rules/{rule_id}")),
            panel: dashboard.map(|(dashboard_id, panel_id)| match panel_id {
                Some(panel_id) => format!("{public}/dashboards/{dashboard_id}?panel={panel_id}"),
                None => format!("{public}/dashboards/{dashboard_id}"),
            }),
            silence: Some(format!("{public}/alerting/silences/new?ruleId={rule_id}")),
        }
    }
}

/// The message of one rule's evaluation to one contact point.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub version: u32,
    /// The message's event, as `Kalzit-Event` names it: the most important of its instances
    /// (firing, error, no data, reminder, resolved), or `test`.
    pub event: String,
    /// Unique per message; it stays the same for every attempt (`Kalzit-Delivery`).
    pub delivery_id: String,
    pub organization: Organization,
    pub rule: RuleInfo,
    pub instances: Vec<Instance>,
    /// Instances left out so the webhook body stays within `alerting.webhook_max_bytes`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub omitted_instances: usize,
    /// Parts of the message were shortened or left out so the webhook body stays within
    /// `alerting.webhook_max_bytes` even with a single instance (see [`Message::webhook_body`]).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub links: Links,
    /// The scheduled time of the evaluation (Unix milliseconds).
    pub evaluated_at: i64,
}

fn is_zero(n: &usize) -> bool {
    *n == 0
}

/// The length a label value of a webhook body is shortened to when the body is too large even
/// with one instance.
pub const SHORT_LABEL_CHARS: usize = 64;

/// Cuts `text` to `max` characters, the last one an ellipsis, when it is longer.
fn shorten(text: &mut String, max: usize) {
    if text.chars().count() > max {
        let kept: String = text.chars().take(max.saturating_sub(1)).collect();
        *text = kept + "…";
    }
}

/// The event of a message with these instances: firing before error before no data before
/// reminder before resolved.
pub fn message_event(instances: &[Instance]) -> &'static str {
    [Event::Firing, Event::Error, Event::NoData, Event::Reminder, Event::Resolved]
        .into_iter()
        .find(|e| instances.iter().any(|i| i.event == *e))
        .map_or("resolved", Event::as_str)
}

impl Message {
    /// The JSON body of a webhook, never more than `max_bytes`. Instances are left out from the
    /// end (counted in `omittedInstances`) until it fits. When the first instance alone is still
    /// too large, `truncated` is set and, step by step until it fits: its label values are
    /// shortened to [`SHORT_LABEL_CHARS`] characters (ending in `…`), its labels and error are
    /// left out, the rule's description and labels are left out, the instance itself is left
    /// out, and at last only the identifying fields remain.
    pub fn webhook_body(&self, max_bytes: usize) -> Vec<u8> {
        let encode = |m: &Message| serde_json::to_vec(m).expect("a message always serializes");
        let mut message = self.clone();
        loop {
            let body = encode(&message);
            if body.len() <= max_bytes {
                return body;
            }
            if message.instances.len() <= 1 {
                break;
            }
            // Drop about the share that is too much, at least one.
            let over = body.len() - max_bytes;
            let per = body.len() / message.instances.len().max(1);
            let drop = (over / per.max(1)).clamp(1, message.instances.len() - 1);
            message.instances.truncate(message.instances.len() - drop);
            message.omitted_instances += drop;
        }
        message.truncated = true;
        let steps: [fn(&mut Message); 4] = [
            |m| {
                for i in &mut m.instances {
                    for value in i.labels.values_mut() {
                        shorten(value, SHORT_LABEL_CHARS);
                    }
                }
            },
            |m| {
                for i in &mut m.instances {
                    i.labels.clear();
                    i.error = None;
                }
            },
            |m| {
                m.rule.description.clear();
                m.rule.labels.clear();
            },
            |m| {
                m.omitted_instances += m.instances.len();
                m.instances.clear();
            },
        ];
        for step in steps {
            step(&mut message);
            let body = encode(&message);
            if body.len() <= max_bytes {
                return body;
            }
        }
        // Only what identifies the message; far below the smallest allowed limit (1024 bytes).
        serde_json::to_vec(&serde_json::json!({
            "version": message.version,
            "event": message.event,
            "deliveryId": message.delivery_id,
            "organization": { "id": message.organization.id },
            "rule": { "id": message.rule.id },
            "instances": [],
            "omittedInstances": message.omitted_instances,
            "truncated": true,
            "evaluatedAt": message.evaluated_at,
        }))
        .expect("a message always serializes")
    }

    /// The mail in `lang`; times in `zone` (an IANA name, else UTC), `host` names the sender.
    pub fn mail(&self, lang: Lang, zone: Option<&str>, host: &str) -> Content {
        let word = |de: &'static str, en: &'static str| if lang == Lang::De { de } else { en };
        let subject_word = event_word(&self.event, lang);
        let subject = format!("[{subject_word}] {} · {}", self.rule.name, self.organization.name);
        let mut paragraphs = Vec::new();
        if self.event == TEST_EVENT {
            paragraphs.push(
                word(
                    "Testnachricht: So sieht eine Benachrichtigung dieses Kontaktpunkts aus. Die Werte sind Beispiele.",
                    "Test message: this is what a notification of this contact point looks like. The values are \
                     examples.",
                )
                .to_string(),
            );
        }
        for i in &self.instances {
            paragraphs.push(self.instance_line(i, lang, zone));
        }
        if self.omitted_instances > 0 {
            paragraphs.push(match lang {
                Lang::De => format!("Dazu {} weitere Instanzen.", self.omitted_instances),
                Lang::En => format!("And {} more instances.", self.omitted_instances),
            });
        }
        if !self.rule.labels.is_empty() {
            paragraphs.push(format!("Labels: {}", plain_labels(&self.rule.labels)));
        }
        if !self.rule.description.trim().is_empty() {
            paragraphs.push(self.rule.description.trim().to_string());
        }
        let mut links = Vec::new();
        if let Some(url) = &self.links.rule {
            links.push(format!("{}: {url}", word("Regel öffnen", "Open rule")));
        }
        if let Some(url) = &self.links.panel {
            links.push(format!("{}: {url}", word("Panel öffnen", "Open panel")));
        }
        if let Some(url) = &self.links.silence {
            links.push(format!("{}: {url}", word("Stummschalten", "Silence")));
        }
        if let Some(url) = &self.rule.runbook_url {
            links.push(format!("{}: {url}", word("Anleitung", "Runbook")));
        }
        paragraphs.extend(links);
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
            subject,
        }
    }

    /// "instance=lager-api-1: last = 1,84, Bedingung > 1,5, seit 13:41" and the like.
    fn instance_line(&self, i: &Instance, lang: Lang, zone: Option<&str>) -> String {
        let who = if i.labels.is_empty() { self.rule.name.clone() } else { plain_labels(&i.labels) };
        let since = templates::moment(i.state_since, zone, lang);
        let condition = condition_text(&self.rule.condition, lang);
        let reduced = reduce_text(&self.rule.reduce);
        let value = i.value.map(|v| format!("{reduced} = {}", number(v, lang)));
        let error = i.error.as_ref().map(|e| error_text(e, lang));
        match (i.event, lang) {
            (Event::Resolved, Lang::De) => {
                let why = match i.reason {
                    Some(ResolveReason::SeriesGone) => ", Serie nicht mehr vorhanden",
                    Some(ResolveReason::Replaced) => ", ersetzt durch die Serien des Ergebnisses",
                    None => "",
                };
                match value {
                    Some(v) => format!("{who}: behoben{why}, {v}, {condition}; gemeldet seit {since}"),
                    None => format!("{who}: behoben{why}; gemeldet seit {since}"),
                }
            }
            (Event::Resolved, Lang::En) => {
                let why = match i.reason {
                    Some(ResolveReason::SeriesGone) => ", series no longer present",
                    Some(ResolveReason::Replaced) => ", replaced by the series of the result",
                    None => "",
                };
                match value {
                    Some(v) => format!("{who}: resolved{why}, {v}, {condition}; reported since {since}"),
                    None => format!("{who}: resolved{why}; reported since {since}"),
                }
            }
            (_, _) => {
                let since_word = if lang == Lang::De { "seit" } else { "since" };
                let state = state_word(i.state, lang);
                let reminder = match (i.reminder, lang) {
                    (0, _) => String::new(),
                    (n, Lang::De) => format!(" (Erinnerung {n})"),
                    (n, Lang::En) => format!(" (reminder {n})"),
                };
                match (value, error) {
                    (_, Some(error)) => format!("{who}: {state}{reminder}: {error}, {since_word} {since}"),
                    (Some(v), None) => format!("{who}: {state}{reminder}, {v}, {condition}, {since_word} {since}"),
                    (None, None) => format!("{who}: {state}{reminder}, {since_word} {since}"),
                }
            }
        }
    }
}

/// `team=lager, instance=lager-api-1`.
fn plain_labels(labels: &BTreeMap<String, String>) -> String {
    labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(", ")
}

/// The subject's word for a message event.
pub fn event_word(event: &str, lang: Lang) -> &'static str {
    match (event, lang) {
        ("firing", Lang::De) => "Feuert",
        ("resolved", Lang::De) => "Behoben",
        ("no_data", Lang::De) => "Keine Daten",
        ("error", Lang::De) => "Fehler",
        ("reminder", Lang::De) => "Erinnerung",
        ("test", Lang::De) => "Test",
        ("firing", _) => "Firing",
        ("resolved", _) => "Resolved",
        ("no_data", _) => "No data",
        ("error", _) => "Error",
        ("reminder", _) => "Reminder",
        _ => "Test",
    }
}

fn state_word(state: State, lang: Lang) -> &'static str {
    match (state, lang) {
        (State::Ok, Lang::De) => "OK",
        (State::Pending, Lang::De) => "ausstehend",
        (State::Firing, Lang::De) => "feuert",
        (State::NoData, Lang::De) => "keine Daten",
        (State::Error, Lang::De) => "Fehler",
        (State::Ok, Lang::En) => "OK",
        (State::Pending, Lang::En) => "pending",
        (State::Firing, Lang::En) => "firing",
        (State::NoData, Lang::En) => "no data",
        (State::Error, Lang::En) => "error",
    }
}

/// A number as people read it: up to four decimals without trailing zeros, with a decimal comma
/// in German.
pub fn number(v: f64, lang: Lang) -> String {
    if !v.is_finite() {
        return v.to_string();
    }
    // Four decimals, and for small values enough for four significant digits (0.00001234), up to
    // 12 decimals; anything smaller reads as 0.
    let decimals = if v != 0.0 && v.abs() < 1.0 {
        let leading_zeros = (-v.abs().log10().floor()) as usize;
        (leading_zeros + 3).clamp(4, 12)
    } else {
        4
    };
    let mut text = format!("{v:.decimals$}");
    if text.contains('.') {
        text = text.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    if text == "-0" {
        text = "0".into();
    }
    if lang == Lang::De { text.replace('.', ",") } else { text }
}

/// "Bedingung > 1,5" or "condition outside 10 to 20".
pub fn condition_text(c: &Condition, lang: Lang) -> String {
    let n = |v: Option<f64>| number(v.unwrap_or(f64::NAN), lang);
    let word = if lang == Lang::De { "Bedingung" } else { "condition" };
    let op = match c.op {
        Op::Gt => ">",
        Op::Gte => "≥",
        Op::Lt => "<",
        Op::Lte => "≤",
        Op::Eq => "=",
        Op::Ne => "≠",
        Op::Outside | Op::Inside => {
            let range = match (c.op, lang) {
                (Op::Outside, Lang::De) => "außerhalb von",
                (Op::Inside, Lang::De) => "innerhalb von",
                (Op::Outside, Lang::En) => "outside",
                _ => "inside",
            };
            let to = if lang == Lang::De { "bis" } else { "to" };
            return format!("{word} {range} {} {to} {}", n(c.low), n(c.high));
        }
    };
    format!("{word} {op} {}", n(c.value))
}

/// The reduce step in short: `last`, `count`, `max($.queue.depth)`, `nodes:Dienst`.
pub fn reduce_text(r: &Reduce) -> String {
    match r {
        Reduce::Frame { function } => stored_name(function),
        Reduce::Documents { mode: DocumentMode::Count, .. } => "count".into(),
        Reduce::Documents { path, function, .. } => {
            let f = function.as_ref().map_or_else(|| "first".to_string(), stored_name);
            format!("{f}({})", path.as_deref().unwrap_or("$"))
        }
        Reduce::Graph { count, label } => {
            let what = match count {
                GraphCount::Nodes => "nodes",
                GraphCount::Edges => "edges",
                GraphCount::Paths => "paths",
            };
            match label {
                Some(label) => format!("{what}:{label}"),
                None => what.to_string(),
            }
        }
    }
}

/// The stored spelling of a reduce function (`last`, `max`).
fn stored_name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

/// An evaluation error as the message says it (the stored code, translated).
pub fn error_text(e: &EvalError, lang: Lang) -> String {
    let de = lang == Lang::De;
    match e {
        EvalError::QueryFailed => if de { "Abfrage fehlgeschlagen" } else { "query failed" }.into(),
        EvalError::Timeout => if de { "Zeitlimit überschritten" } else { "timed out" }.into(),
        EvalError::SourceNotEnabled => {
            if de { "Quelle nicht für Alerting freigegeben" } else { "source not opted in to alerting" }.into()
        }
        EvalError::InvalidRule => if de { "Regel nicht auswertbar" } else { "rule cannot be evaluated" }.into(),
        EvalError::WrongShape { expected, got } => {
            if de {
                format!("Abfrage liefert {got}, die Regel erwartet {expected}")
            } else {
                format!("the query returned {got}, the rule expects {expected}")
            }
        }
        EvalError::NotANumber { field, found } => {
            if de {
                format!("{field} enthält {found}, keine Zahl")
            } else {
                format!("{field} holds {found}, not a number")
            }
        }
        EvalError::NaN { field } => {
            if de {
                format!("{field} ergibt keine Zahl (NaN)")
            } else {
                format!("{field} reduces to NaN")
            }
        }
        EvalError::TooManySeries { limit } => {
            if de {
                format!("zu viele Serien (mehr als {limit})")
            } else {
                format!("too many series (more than {limit})")
            }
        }
        EvalError::DuplicateSeries { labels } => {
            if de {
                format!("zwei Serien mit denselben Labels: {labels}")
            } else {
                format!("two series with the same labels: {labels}")
            }
        }
        EvalError::Truncated { limit, .. } => match (limit, de) {
            (Some(l), true) => format!("Ergebnis an einer Grenze der Quelle abgeschnitten ({l})"),
            (None, true) => "Ergebnis an einer Grenze der Quelle abgeschnitten".into(),
            (Some(l), false) => format!("result cut at a limit of the source ({l})"),
            (None, false) => "result cut at a limit of the source".into(),
        },
        EvalError::NoPaths => if de { "keine Pfade im Ergebnis" } else { "no paths in the result" }.into(),
        EvalError::LabelTooLong { what, max } => match (what.as_str(), de) {
            ("count", true) => format!("zu viele Labels aus den Daten (höchstens {max})"),
            ("name", true) => format!("ein Label-Name aus den Daten ist zu lang (höchstens {max} Zeichen)"),
            (_, true) => format!("ein Label-Wert aus den Daten ist zu lang (höchstens {max} Zeichen)"),
            ("count", false) => format!("too many labels from the data (at most {max})"),
            ("name", false) => format!("a label name from the data is too long (at most {max} characters)"),
            (_, false) => format!("a label value from the data is too long (at most {max} characters)"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn sample() -> Message {
        Message {
            version: VERSION,
            event: "firing".into(),
            delivery_id: "0190-delivery".into(),
            organization: Organization { id: "o".into(), name: "MouseWerk".into() },
            rule: RuleInfo {
                id: "r".into(),
                name: "Lager-API Latenz p95".into(),
                description: "Antwortzeit der Lager-API".into(),
                runbook_url: Some("https://wiki.example/lager-api".into()),
                labels: [("team".to_string(), "lager".to_string())].into(),
                reduce: Reduce::parse(&json!({ "shape": "frame", "function": "max" })).unwrap(),
                condition: Condition::parse(&json!({ "op": "gt", "value": 1.5 })).unwrap(),
            },
            instances: vec![
                Instance {
                    fingerprint: "f1".into(),
                    labels: [("instance".to_string(), "lager-api-1".to_string())].into(),
                    event: Event::Firing,
                    state: State::Firing,
                    state_since: 1_794_319_260_000,
                    value: Some(1.84),
                    error: None,
                    reminder: 0,
                    reason: None,
                },
                Instance {
                    fingerprint: "f2".into(),
                    labels: [("instance".to_string(), "lager-api-2".to_string())].into(),
                    event: Event::Resolved,
                    state: State::Ok,
                    state_since: 1_794_319_200_000,
                    value: None,
                    error: None,
                    reminder: 0,
                    reason: Some(ResolveReason::SeriesGone),
                },
            ],
            omitted_instances: 0,
            truncated: false,
            links: Links::new(Some("https://kalzit.example"), "r", Some(("d", Some("p1")))),
            evaluated_at: 1_794_319_320_000,
        }
    }

    #[test]
    fn mails_follow_the_language_and_carry_reduced_values_only() {
        let m = sample();
        let de = m.mail(Lang::De, Some("Europe/Berlin"), "kalzit.example");
        assert_eq!(de.subject, "[Feuert] Lager-API Latenz p95 · MouseWerk");
        assert!(
            de.text
                .contains("instance=lager-api-1: feuert, max = 1,84, Bedingung > 1,5, seit 10. November 2026, 15:01"),
            "{}",
            de.text
        );
        assert!(de.text.contains("instance=lager-api-2: behoben, Serie nicht mehr vorhanden"), "{}", de.text);
        assert!(de.text.contains("Labels: team=lager"));
        assert!(de.text.contains("Regel öffnen: https://kalzit.example/alerting/rules/r"));
        assert!(de.text.contains("Panel öffnen: https://kalzit.example/dashboards/d?panel=p1"));
        assert!(de.text.contains("Stummschalten: https://kalzit.example/alerting/silences/new?ruleId=r"));
        assert!(de.text.contains("Anleitung: https://wiki.example/lager-api"));
        assert!(de.html.contains("Bedingung &gt; 1,5"));

        let en = m.mail(Lang::En, None, "kalzit.example");
        assert_eq!(en.subject, "[Firing] Lager-API Latenz p95 · MouseWerk");
        assert!(
            en.text.contains(
                "instance=lager-api-1: firing, max = 1.84, condition > 1.5, since November 10, 2026, 14:01 UTC"
            ),
            "{}",
            en.text
        );
        assert!(en.text.contains("instance=lager-api-2: resolved, series no longer present"), "{}", en.text);
        assert!(en.text.contains("Open rule: https://kalzit.example/alerting/rules/r"));

        // An error is its translated code, never a source's text.
        let mut failed = m.clone();
        failed.event = "error".into();
        failed.instances = vec![Instance {
            event: Event::Error,
            state: State::Error,
            value: None,
            error: Some(EvalError::NotANumber { field: "$.depth".into(), found: "text".into() }),
            ..m.instances[0].clone()
        }];
        let de = failed.mail(Lang::De, None, "h");
        assert_eq!(de.subject, "[Fehler] Lager-API Latenz p95 · MouseWerk");
        assert!(de.text.contains("Fehler: $.depth enthält text, keine Zahl"), "{}", de.text);
    }

    #[test]
    fn numbers_and_conditions_read_naturally() {
        assert_eq!(number(1.84, Lang::De), "1,84");
        assert_eq!(number(1022.0, Lang::En), "1022");
        assert_eq!(number(0.000_01, Lang::En), "0.00001");
        assert_eq!(number(0.000_012_345_6, Lang::De), "0,00001235");
        assert_eq!(number(1e-15, Lang::En), "0");
        assert_eq!(number(-2.5, Lang::De), "-2,5");
        let outside = Condition::parse(&json!({ "op": "outside", "low": 10, "high": 20.5 })).unwrap();
        assert_eq!(condition_text(&outside, Lang::De), "Bedingung außerhalb von 10 bis 20,5");
        assert_eq!(condition_text(&outside, Lang::En), "condition outside 10 to 20.5");
        let field =
            Reduce::parse(&json!({ "shape": "documents", "mode": "field", "path": "$.q.depth", "function": "max" }))
                .unwrap();
        assert_eq!(reduce_text(&field), "max($.q.depth)");
        let nodes = Reduce::parse(&json!({ "shape": "graph", "count": "nodes", "label": "Dienst" })).unwrap();
        assert_eq!(reduce_text(&nodes), "nodes:Dienst");
    }

    #[test]
    fn the_event_is_the_most_important_one_and_the_body_fits() {
        let m = sample();
        assert_eq!(message_event(&m.instances), "firing");
        assert_eq!(message_event(&m.instances[1..]), "resolved");
        let body: serde_json::Value = serde_json::from_slice(&m.webhook_body(256 * 1024)).unwrap();
        assert_eq!(body["version"], 1);
        assert_eq!(body["instances"][0]["value"], 1.84);
        assert_eq!(body["instances"][1]["reason"], "series_gone");
        assert!(body.get("omittedInstances").is_none());
        let mut many = m.clone();
        many.instances = (0..200).map(|_| m.instances[0].clone()).collect();
        let small = many.webhook_body(4096);
        assert!(small.len() <= 4096, "{}", small.len());
        let body: serde_json::Value = serde_json::from_slice(&small).unwrap();
        let kept = body["instances"].as_array().unwrap().len();
        assert_eq!(kept + body["omittedInstances"].as_u64().unwrap() as usize, 200);
        assert!(body.get("truncated").is_none());
    }

    #[test]
    fn the_webhook_limit_holds_even_for_one_large_instance() {
        let mut m = sample();
        m.instances.truncate(1);
        m.instances[0].labels =
            (0..20).map(|i| (format!("label{i}"), "x".repeat(256))).collect::<BTreeMap<String, String>>();
        let full = serde_json::to_vec(&m).unwrap().len();
        assert!(full > 4096, "{full}");
        // Label values shortened, the rest kept.
        let body = m.webhook_body(4096);
        assert!(body.len() <= 4096, "{}", body.len());
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["truncated"], true);
        let value = parsed["instances"][0]["labels"]["label0"].as_str().unwrap();
        assert_eq!(value.chars().count(), SHORT_LABEL_CHARS);
        assert!(value.ends_with('…'));
        assert_eq!(parsed["instances"][0]["value"], 1.84);
        // Smaller still: labels gone, then the rule's description, then the instance, then all
        // but the identifying fields; never above the limit.
        m.rule.description = "d".repeat(2000);
        for max in [1024, 1500, 2500, 3000] {
            let body = m.webhook_body(max);
            assert!(body.len() <= max, "{max}: {}", body.len());
            let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(parsed["truncated"], true, "{max}");
            assert_eq!(parsed["deliveryId"], "0190-delivery");
        }
        let small: serde_json::Value = serde_json::from_slice(&m.webhook_body(1024)).unwrap();
        assert_eq!(small["rule"]["description"], "");
        assert!(small["instances"].as_array().unwrap().iter().all(|i| i["labels"] == json!({})), "{small}");
        // Even a rule whose name alone is too large: only the identifying fields.
        m.rule.name = "n".repeat(5000);
        let body = m.webhook_body(1024);
        assert!(body.len() <= 1024, "{}", body.len());
        let tiny: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(tiny["omittedInstances"], 1);
        assert_eq!(tiny["instances"], json!([]));
        assert_eq!(tiny["rule"], json!({ "id": "r" }));
        assert_eq!(tiny["truncated"], true);
    }
}
