//! The field options of a Grafana panel (`fieldConfig`: units, colours, thresholds, value
//! mappings, the graph style and overrides) in Kalzit's form, read from the published JSON
//! format only. Each option goes only where the Kalzit panel's editor shows it, so an imported
//! panel holds nothing its options do not show (docs/guide/grafana-import.md); what has no
//! counterpart is reported.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use super::{ImportNote, note, text, truncate};
use crate::dashboards::panel_options::{self, MAX_MAPPINGS, MAX_OVERRIDES, MAX_TEXT_CHARS};

/// The field option groups a Kalzit panel type shows in its editor (`fieldOptions` of the panel
/// plugins in `ui/src/panels/`). The standard ones (unit, decimals, display name, no value) go
/// with every frame panel.
#[derive(Clone, Copy, Default)]
pub(super) struct Groups {
    /// Any field options at all (not the text and graph panels).
    pub frame: bool,
    pub range: bool,
    pub thresholds: bool,
    pub mappings: bool,
    pub color: bool,
    /// The time series' graph style, colour scheme, free colours and threshold display.
    pub graph: bool,
    /// Cell display, link and width of tables.
    pub table: bool,
}

pub(super) fn groups(kind: &str) -> Groups {
    let all = Groups { frame: true, range: true, thresholds: true, mappings: true, color: true, ..Groups::default() };
    match kind {
        "timeseries" => Groups { graph: true, ..all },
        "stat" | "gauge" | "bargauge" | "bar" => all,
        "table" => Groups { table: true, ..all },
        "piechart" => Groups { range: false, thresholds: false, ..all },
        "state-timeline" | "status-history" => Groups { range: false, ..all },
        "histogram" => Groups { thresholds: false, mappings: false, ..all },
        "heatmap" => Groups { thresholds: false, mappings: false, color: false, ..all },
        _ => Groups::default(),
    }
}

/// Grafana unit ids that are Kalzit catalog ids with the same meaning.
const SAME_UNITS: &[&str] = &[
    "none",
    "short",
    "percent",
    "percentunit",
    "ppm",
    "bytes",
    "decbytes",
    "ops",
    "reqps",
    "ns",
    "ms",
    "s",
    "m",
    "h",
    "d",
    "watt",
    "volt",
    "hertz",
    "celsius",
    "fahrenheit",
    "kelvin",
];

/// Grafana unit ids with a Kalzit catalog unit of another id.
const UNIT_ALIASES: &[(&str, &str)] = &[
    ("µs", "us"),
    ("dtdurationms", "ms"),
    ("dtdurations", "s"),
    // Grafana's `bps` is SI (kb/s) and `binBps` binary (KiB/s), as Kalzit's units of those ids.
    ("bps", "bitsps"),
    ("binBps", "bytesps"),
    ("decbits", "bits"),
    ("amp", "ampere"),
    ("watth", "watthour"),
    ("dateTimeAsLocal", "dateTime"),
    ("dateTimeAsSystem", "dateTime"),
    ("dateTimeFromNow", "fromNow"),
];

/// Grafana unit ids whose nearest Kalzit unit writes the value differently: these date formats
/// show local time, which Kalzit's `dateTime` does in the viewer's language (its `dateIso` would
/// show UTC).
const UNIT_NEAREST: &[(&str, &str)] = &[
    ("dateTimeAsIso", "dateTime"),
    ("dateTimeAsIsoNoDateIfToday", "dateTime"),
    ("dateTimeAsUS", "dateTime"),
    ("dateTimeAsUSNoDateIfToday", "dateTime"),
    ("dateTimeAsLocalNoDateIfToday", "dateTime"),
];

/// Kalzit's catalog unit ids (`ui/src/panels/fieldConfig/units.ts`), currencies aside.
const KALZIT_UNITS: &[&str] = &[
    "none",
    "short",
    "percent",
    "percentunit",
    "ppm",
    "bytes",
    "decbytes",
    "bits",
    "bytesps",
    "bitsps",
    "ops",
    "reqps",
    "rpm",
    "ns",
    "us",
    "ms",
    "s",
    "m",
    "h",
    "d",
    "watt",
    "watthour",
    "volt",
    "ampere",
    "hertz",
    "celsius",
    "fahrenheit",
    "kelvin",
    "dateTime",
    "dateIso",
    "fromNow",
];

/// Whether a stored unit is one Kalzit writes: a catalog id, a currency of the catalog or a
/// custom suffix.
pub(super) fn is_kalzit_unit(id: &str) -> bool {
    KALZIT_UNITS.contains(&id)
        || id.starts_with("suffix:")
        || id.strip_prefix("currency:").is_some_and(|c| CURRENCIES.contains(&c))
}

/// Grafana unit ids without a Kalzit catalog unit: the custom suffix that writes them. The value
/// keeps its own scale (a value in KiB stays a number of KiB).
const UNIT_SUFFIXES: &[(&str, &str)] = &[
    // Binary bits and SI bytes per second: Kalzit's units of these kinds scale in the other steps.
    ("bits", "b"),
    ("binbps", "b/s"),
    ("Bps", "B/s"),
    ("kbytes", "KiB"),
    ("mbytes", "MiB"),
    ("gbytes", "GiB"),
    ("tbytes", "TiB"),
    ("pbytes", "PiB"),
    ("deckbytes", "kB"),
    ("decmbytes", "MB"),
    ("decgbytes", "GB"),
    ("dectbytes", "TB"),
    ("decpbytes", "PB"),
    ("KBs", "kB/s"),
    ("MBs", "MB/s"),
    ("GBs", "GB/s"),
    ("TBs", "TB/s"),
    ("Kbits", "kb/s"),
    ("Mbits", "Mb/s"),
    ("Gbits", "Gb/s"),
    ("Tbits", "Tb/s"),
    ("pps", "packets/s"),
    ("cps", "counts/s"),
    ("rps", "reads/s"),
    ("wps", "writes/s"),
    ("iops", "I/O ops/s"),
    ("cpm", "counts/min"),
    ("opm", "ops/min"),
    ("rpm", "reads/min"),
    ("wpm", "writes/min"),
    ("humidity", "%H"),
    ("dB", "dB"),
    ("kwatt", "kW"),
    ("mwatt", "mW"),
    ("kwatth", "kWh"),
    ("kvolt", "kV"),
    ("mvolt", "mV"),
    ("mamp", "mA"),
    ("kamp", "kA"),
    ("khertz", "kHz"),
    ("mhertz", "MHz"),
    ("ghertz", "GHz"),
    ("pixel", "px"),
    ("lengthmm", "mm"),
    ("lengthm", "m"),
    ("lengthkm", "km"),
    ("massg", "g"),
    ("masskg", "kg"),
    ("velocityms", "m/s"),
    ("velocitykmh", "km/h"),
    ("pressurebar", "bar"),
    ("pressurehpa", "hPa"),
    ("degree", "°"),
];

/// Currencies of Kalzit's unit catalog (`ui/src/panels/fieldConfig/units.ts`).
const CURRENCIES: &[&str] = &["EUR", "USD", "GBP", "CHF", "JPY", "CNY", "SEK", "NOK", "DKK", "PLN", "CZK"];

fn currency(code: &str) -> Option<String> {
    CURRENCIES.contains(&code).then(|| format!("currency:{code}"))
}

fn suffix(text: &str) -> String {
    format!("suffix:{}", truncate(text, 40))
}

/// A Grafana unit id in Kalzit's form: a catalog id, a custom suffix (`suffix:...`, reported
/// as approximated where the unit itself has none) or nothing (reported as unknown).
pub(super) fn unit(id: &str, notes: &mut Vec<ImportNote>) -> Option<String> {
    let approximated = |notes: &mut Vec<ImportNote>, shown: &str| {
        notes.push(
            note("unit_approximated", format!("the unit {id} has no Kalzit counterpart and became the suffix {shown}"))
                .with("unit", id)
                .with("suffix", shown),
        );
    };
    if SAME_UNITS.contains(&id) {
        return Some(id.to_string());
    }
    if let Some((_, kalzit)) = UNIT_ALIASES.iter().find(|(g, _)| *g == id) {
        return Some((*kalzit).to_string());
    }
    if let Some((_, kalzit)) = UNIT_NEAREST.iter().find(|(g, _)| *g == id) {
        notes.push(
            note("unit_nearest", format!("the unit {id} became the nearest Kalzit unit, {kalzit}"))
                .with("unit", id)
                .with("nearest", *kalzit),
        );
        return Some((*kalzit).to_string());
    }
    if let Some(code) =
        id.strip_prefix("currency").filter(|c| c.len() == 3 && c.chars().all(|c| c.is_ascii_uppercase()))
    {
        return Some(currency(code).unwrap_or_else(|| {
            approximated(notes, code);
            suffix(code)
        }));
    }
    if let Some((_, shown)) = UNIT_SUFFIXES.iter().find(|(g, _)| *g == id) {
        approximated(notes, shown);
        return Some(suffix(shown));
    }
    // Grafana's custom units: `suffix:` is Kalzit's own form, the others keep their text.
    if let Some((form, rest)) = id.split_once(':') {
        let rest = rest.trim();
        match form {
            "suffix" if !rest.is_empty() => return Some(suffix(rest)),
            "currency" if currency(rest).is_some() => return currency(rest),
            "prefix" | "si" | "count" | "currency" if !rest.is_empty() => {
                approximated(notes, rest);
                return Some(suffix(rest));
            }
            _ => {}
        }
    }
    notes.push(note("unit_unknown", format!("the unit {id} is not known to Kalzit and was dropped")).with("unit", id));
    None
}

/// A Grafana colour: one of Kalzit's tones, a free colour, transparent, or none that fits.
#[derive(Debug, PartialEq)]
pub(super) enum Color {
    Tone(&'static str),
    Free(String),
    Transparent,
    Unknown,
}

/// `rgb(r, g, b)` or `rgba(r, g, b, a)` as `#rrggbb`.
fn rgb(color: &str) -> Option<String> {
    let inner = color.strip_prefix("rgba(").or_else(|| color.strip_prefix("rgb("))?.strip_suffix(')')?;
    let parts: Vec<u8> = inner.split(',').take(3).map(|p| p.trim().parse::<u8>()).collect::<Result<_, _>>().ok()?;
    (parts.len() == 3).then(|| format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2]))
}

pub(super) fn color(raw: &str) -> Color {
    let c = raw.trim().to_lowercase();
    if c == "transparent" {
        return Color::Transparent;
    }
    if c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Color::Free(c);
    }
    if let Some(hex) = rgb(&c) {
        return Color::Free(hex);
    }
    // Named colours and their shades (`dark-red`, `semi-dark-green`, `light-blue`).
    for (word, tone) in [
        ("green", "ok"),
        ("yellow", "warn"),
        ("orange", "warn"),
        ("red", "critical"),
        ("blue", "chart-1"),
        ("purple", "chart-6"),
        ("text", "neutral"),
    ] {
        if c.contains(word) {
            return Color::Tone(tone);
        }
    }
    Color::Unknown
}

/// Thresholds in Kalzit's form, or `None` when there are no steps.
pub(super) fn thresholds(raw: &Value, notes: &mut Vec<ImportNote>) -> Option<Value> {
    let mode = if text(raw, "mode").as_deref() == Some("percentage") { "percentage" } else { "absolute" };
    let mut steps = Vec::new();
    let (mut guessed, mut transparent) = (false, false);
    for (i, step) in raw.get("steps").and_then(Value::as_array).into_iter().flatten().take(20).enumerate() {
        let value = if i == 0 { None } else { step.get("value").and_then(Value::as_f64) };
        if i > 0 && value.is_none() {
            continue;
        }
        let mut s = json!({ "value": value });
        match color(&text(step, "color").unwrap_or_default()) {
            Color::Tone(tone) => s["tone"] = json!(tone),
            Color::Free(hex) => {
                s["tone"] = json!("neutral");
                s["color"] = json!(hex);
            }
            Color::Transparent => {
                transparent = true;
                s["tone"] = json!("neutral");
            }
            Color::Unknown => {
                guessed = true;
                s["tone"] = json!("neutral");
            }
        }
        steps.push(s);
    }
    if guessed {
        notes.push(note("threshold_colors", "threshold colours without a counterpart became neutral"));
    }
    if transparent {
        notes.push(note(
            "threshold_transparent",
            "the transparent threshold colour became neutral; Kalzit has no transparent tone",
        ));
    }
    (!steps.is_empty()).then(|| json!({ "mode": mode, "steps": steps }))
}

/// A mapping's result: its text and the tone of its colour.
fn mapped(result: &Value, out: &mut Value, colors: &mut bool) {
    if let Some(t) = result.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        out["text"] = json!(truncate(t, MAX_TEXT_CHARS));
    }
    if let Some(c) = text(result, "color") {
        match color(&c) {
            Color::Tone(tone) => out["tone"] = json!(tone),
            _ => *colors = true,
        }
    }
}

/// Value mappings in Kalzit's form: value, range and regex; Grafana's special matches (null,
/// NaN, true, false, empty) are reported. The older form (`type` 1 and 2) is read too.
pub(super) fn mappings(raw: &[Value], notes: &mut Vec<ImportNote>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let (mut colors, mut invalid) = (false, false);
    let mut special = BTreeSet::new();
    for m in raw {
        let options = m.get("options").cloned().unwrap_or(Value::Null);
        match (m.get("type").and_then(Value::as_str), m.get("type").and_then(Value::as_i64)) {
            (Some("value"), _) => {
                let mut entries: Vec<(i64, &String, &Value)> = options
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(k, v)| (v.get("index").and_then(Value::as_i64).unwrap_or(i64::MAX), k, v))
                    .collect();
                entries.sort_by_key(|(index, _, _)| *index);
                for (_, value, result) in entries {
                    let mut entry = json!({ "type": "value", "value": truncate(value, MAX_TEXT_CHARS) });
                    mapped(result, &mut entry, &mut colors);
                    out.push(entry);
                }
            }
            (Some("range"), _) => {
                let (from, to) =
                    (options.get("from").and_then(Value::as_f64), options.get("to").and_then(Value::as_f64));
                if let (Some(f), Some(t)) = (from, to)
                    && f > t
                {
                    invalid = true;
                    continue;
                }
                let mut entry = json!({ "type": "range", "from": from, "to": to });
                mapped(options.get("result").unwrap_or(&Value::Null), &mut entry, &mut colors);
                out.push(entry);
            }
            (Some("regex"), _) => {
                let pattern = text(&options, "pattern").unwrap_or_default();
                if pattern.is_empty() || panel_options::check_pattern("pattern", &pattern).is_err() {
                    invalid = true;
                    continue;
                }
                let mut entry = json!({ "type": "regex", "pattern": pattern });
                mapped(options.get("result").unwrap_or(&Value::Null), &mut entry, &mut colors);
                out.push(entry);
            }
            (Some("special"), _) => {
                special.insert(text(&options, "match").unwrap_or_else(|| "special".into()));
            }
            // The older form: 1 maps a value, 2 a range, with the text beside it.
            (None, Some(1)) => {
                let value = match m.get("value") {
                    Some(Value::String(s)) => s.clone(),
                    Some(v) if !v.is_null() => v.to_string(),
                    _ => continue,
                };
                let mut entry = json!({ "type": "value", "value": truncate(&value, MAX_TEXT_CHARS) });
                mapped(m, &mut entry, &mut colors);
                out.push(entry);
            }
            (None, Some(2)) => {
                let bound = |k: &str| {
                    m.get(k)
                        .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
                        .filter(|f: &f64| f.is_finite())
                };
                let (from, to) = (bound("from"), bound("to"));
                if let (Some(f), Some(t)) = (from, to)
                    && f > t
                {
                    invalid = true;
                    continue;
                }
                let mut entry = json!({ "type": "range", "from": from, "to": to });
                mapped(m, &mut entry, &mut colors);
                out.push(entry);
            }
            _ => invalid = true,
        }
    }
    if out.len() > MAX_MAPPINGS {
        out.truncate(MAX_MAPPINGS);
        invalid = true;
    }
    if !special.is_empty() {
        let list = special.into_iter().collect::<Vec<_>>().join(", ");
        notes.push(
            note("mapping_special", format!("special value mappings ({list}) have no counterpart and were dropped"))
                .with("match", list),
        );
    }
    if colors {
        notes.push(note("mapping_colors", "value mapping colours without a counterpart were dropped"));
    }
    if invalid {
        notes.push(note("mapping_invalid", "value mappings Kalzit cannot read were dropped"));
    }
    out
}

/// Grafana's continuous colour schemes, with Kalzit's nearest scheme and whether it is the same.
fn scheme(mode: &str) -> Option<(&'static str, bool)> {
    let name = mode.strip_prefix("continuous-")?;
    Some(match name {
        "GrYlRd" => ("greenYellowRed", true),
        "RdYlGr" | "BlYlRd" | "YlRd" | "reds" => ("greenYellowRed", false),
        "blues" => ("blues", true),
        _ => ("blues", false),
    })
}

/// What a link of a field becomes: Kalzit fills `${__value}` only.
fn field_link(url: &str, notes: &mut Vec<ImportNote>) -> Option<String> {
    let url: String = url.chars().filter(|c| !c.is_control()).collect();
    let url = url.trim().replace("${__value.raw}", "${__value}").replace("${__value.text}", "${__value}");
    let rest = url.replace("${__value}", "");
    if rest.contains("${__") {
        notes.push(note("link_placeholders", "the link uses placeholders Kalzit does not fill; check its address"));
    }
    if ["/d/", "/d-solo/", "/explore", "/goto/"].iter().any(|p| url.starts_with(p)) {
        notes.push(
            note("link_grafana_path", format!("the link {url} points to a Grafana page; check its address"))
                .with("url", truncate(&url, 80)),
        );
    }
    (url.chars().count() <= panel_options::MAX_LINK_CHARS && panel_options::is_safe_link(&url)).then_some(url)
}

/// The panel being converted, for the field options it shows.
pub(super) struct Fields<'a> {
    pub kind: &'a str,
    pub groups: Groups,
}

/// An option the panel type does not show, reported once per name.
fn not_shown(option: &str, notes: &mut Vec<ImportNote>) {
    if !notes.iter().any(|n| n.code == "option_not_shown" && n.params.get("option").map(String::as_str) == Some(option))
    {
        notes.push(
            note("option_not_shown", format!("{option} is not shown by this panel type in Kalzit and was dropped"))
                .with("option", option),
        );
    }
}

impl Fields<'_> {
    /// Sets one Grafana field property (`unit`, `custom.lineWidth`, ...) in `out`. Returns
    /// whether it is known; unknown ones are reported for overrides only, since the defaults of
    /// an export list every option with its default value.
    pub fn property(&self, id: &str, v: &Value, out: &mut Map<String, Value>, notes: &mut Vec<ImportNote>) -> bool {
        let g = self.groups;
        let str_of = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        match id {
            "unit" => {
                if let Some(u) = str_of(v).and_then(|u| unit(&u, notes)) {
                    out.insert("unit".into(), json!(u));
                }
            }
            "decimals" => {
                if let Some(d) = v.as_u64() {
                    out.insert("decimals".into(), json!(d.min(10)));
                }
            }
            "min" | "max" => {
                if let Some(n) = v.as_f64() {
                    if g.range {
                        out.insert(id.into(), json!(n));
                    } else {
                        not_shown(id, notes);
                    }
                }
            }
            "displayName" => {
                if let Some(name) = str_of(v) {
                    out.insert("displayName".into(), json!(truncate(&name, MAX_TEXT_CHARS)));
                }
            }
            "noValue" => {
                if let Some(none) = str_of(v) {
                    out.insert("noValue".into(), json!(truncate(&none, 100)));
                }
            }
            "thresholds" => {
                if v.is_object() {
                    if g.thresholds {
                        if let Some(t) = thresholds(v, notes) {
                            out.insert("thresholds".into(), t);
                        }
                    } else if self.kind != "heatmap" {
                        // A heatmap colours by its own ramp; exports carry default steps there.
                        not_shown("thresholds", notes);
                    }
                }
            }
            "mappings" => {
                if let Some(list) = v.as_array().filter(|l| !l.is_empty()) {
                    if g.mappings {
                        let m = mappings(list, notes);
                        if !m.is_empty() {
                            out.insert("mappings".into(), json!(m));
                        }
                    } else {
                        not_shown("mappings", notes);
                    }
                }
            }
            "color" => self.color(v, out, notes),
            "links" => {
                let links = v.as_array().cloned().unwrap_or_default();
                let Some(first) = links.first() else { return true };
                if !g.table {
                    notes.push(note("field_links", "links of fields are only taken over on tables"));
                    return true;
                }
                if links.len() > 1 {
                    notes.push(note("links_first", "only the first link of a field is kept"));
                }
                if let Some(url) = text(first, "url").and_then(|u| field_link(&u, notes)) {
                    out.insert("link".into(), json!(url));
                    out.entry("cellDisplay").or_insert(json!("link"));
                }
            }
            "custom.cellOptions" | "custom.displayMode" => {
                let display = if id == "custom.cellOptions" { text(v, "type") } else { str_of(v) };
                let Some(display) = display else { return true };
                let kalzit = match display.as_str() {
                    "auto" | "basic" => None,
                    "color-text" => Some("color-text"),
                    "color-background" | "color-background-solid" => Some("color-background"),
                    "gauge" | "gradient-gauge" | "lcd-gauge" | "basic-gauge" => Some("gauge"),
                    other => {
                        notes.push(
                            note(
                                "cell_display",
                                format!("the cell display {other} has no counterpart and was dropped"),
                            )
                            .with("display", other),
                        );
                        return true;
                    }
                };
                if let Some(kalzit) = kalzit
                    && g.table
                {
                    out.insert("cellDisplay".into(), json!(kalzit));
                }
            }
            "custom.width" => {
                if let Some(w) = v.as_u64().filter(|_| g.table) {
                    out.insert("width".into(), json!(w.clamp(40, 1000)));
                }
            }
            "custom.hidden" => {
                if v.as_bool() == Some(true) {
                    notes.push(note("column_hidden", "hidden columns are shown; Kalzit cannot hide a column yet"));
                }
            }
            "custom.hideFrom" => {
                if v.as_object().is_some_and(|o| o.values().any(|b| b.as_bool() == Some(true))) {
                    notes.push(note("hide_from", "hiding series from the legend, tooltip or chart is not taken over"));
                }
            }
            "custom.axisLabel" | "custom.scaleDistribution" | "custom.transform" => {
                let changed = match id {
                    "custom.axisLabel" => str_of(v).is_some(),
                    "custom.scaleDistribution" => text(v, "type").is_some_and(|t| t != "linear"),
                    _ => str_of(v).is_some_and(|t| t != "constant"),
                };
                if changed && g.graph {
                    notes.push(note("axis_options", "axis label, log scale and transforms are not taken over"));
                }
            }
            _ if id.starts_with("custom.") => return self.graph_style(&id["custom.".len()..], v, out, notes),
            _ => return false,
        }
        true
    }

    /// `color`: a fixed colour, a scheme, or the thresholds.
    fn color(&self, v: &Value, out: &mut Map<String, Value>, notes: &mut Vec<ImportNote>) {
        let g = self.groups;
        let mode = text(v, "mode").unwrap_or_default();
        let fixed = |out: &mut Map<String, Value>, notes: &mut Vec<ImportNote>| {
            if !g.color {
                not_shown("color", notes);
                return;
            }
            match color(&text(v, "fixedColor").unwrap_or_default()) {
                Color::Tone(tone) => {
                    out.insert("color".into(), json!(tone));
                }
                Color::Free(hex) if g.graph => {
                    out.insert("color".into(), json!(hex));
                }
                _ => notes.push(note("color_free", "a colour without a counterpart on this panel was dropped")),
            }
        };
        match mode.as_str() {
            "" | "palette-classic" | "palette-classic-by-name" => {}
            "fixed" => fixed(out, notes),
            "shades" if g.graph => {
                fixed(out, notes);
                out.insert("colorScheme".into(), json!("single"));
            }
            "thresholds" if g.graph => {
                out.insert("colorScheme".into(), json!("thresholds"));
            }
            // Other panels colour by their thresholds already.
            "thresholds" => {}
            m => match scheme(m) {
                Some((nearest, same)) if g.graph => {
                    out.insert("colorScheme".into(), json!(nearest));
                    if !same {
                        notes.push(
                            note(
                                "color_scheme_nearest",
                                format!("the colour scheme {m} became the nearest one, {nearest}"),
                            )
                            .with("scheme", m)
                            .with("nearest", nearest),
                        );
                    }
                }
                // The bar chart colours bars by thresholds: green to red becomes three steps.
                Some(("greenYellowRed", _)) if self.kind == "bar" => {
                    out.insert(
                        "thresholds".into(),
                        json!({ "mode": "percentage", "steps": [
                            { "value": null, "tone": "ok" }, { "value": 34, "tone": "warn" }, { "value": 67, "tone": "critical" }
                        ] }),
                    );
                    notes.push(
                        note(
                            "color_scheme_thresholds",
                            format!("the colour scheme {m} became threshold colours from green over yellow to red"),
                        )
                        .with("scheme", m),
                    );
                }
                _ => notes.push(
                    note("color_scheme", format!("the colour scheme {m} has no counterpart on this panel"))
                        .with("scheme", m),
                ),
            },
        }
    }

    /// The time series' graph style (`custom.*`); other panels ignore Grafana's drawing options.
    fn graph_style(&self, key: &str, v: &Value, out: &mut Map<String, Value>, notes: &mut Vec<ImportNote>) -> bool {
        let known = [
            "drawStyle",
            "lineInterpolation",
            "lineWidth",
            "fillOpacity",
            "gradientMode",
            "showPoints",
            "pointSize",
            "lineStyle",
            "spanNulls",
            "insertNulls",
            "stacking",
            "barAlignment",
            "barWidthFactor",
            "thresholdsStyle",
        ];
        if !known.contains(&key) {
            return false;
        }
        if !self.groups.graph {
            return true;
        }
        let s = v.as_str();
        let mut set = |k: &str, value: Value| {
            out.insert(k.into(), value);
        };
        match key {
            "drawStyle" => {
                if let Some(d) = s.filter(|d| ["line", "bars", "points"].contains(d)) {
                    set("drawStyle", json!(d));
                }
            }
            "lineInterpolation" => {
                if let Some(i) = s.filter(|i| ["linear", "smooth", "stepBefore", "stepAfter"].contains(i)) {
                    set("lineInterpolation", json!(i));
                }
            }
            "lineWidth" => {
                if let Some(w) = v.as_f64() {
                    set("lineWidth", json!((w.round() as i64).clamp(0, 10)));
                }
            }
            "fillOpacity" => {
                if let Some(o) = v.as_f64() {
                    let o = (o.round() as i64).clamp(0, 100);
                    set("fill", json!(if o > 0 { "solid" } else { "none" }));
                    set("fillOpacity", json!(o));
                }
            }
            "gradientMode" => {
                if let Some(m) = s.filter(|m| ["none", "opacity", "hue", "scheme"].contains(m)) {
                    set("gradientMode", json!(m));
                }
            }
            "showPoints" => {
                if let Some(p) = s.filter(|p| ["auto", "always", "never"].contains(p)) {
                    set("showPoints", json!(p));
                }
            }
            "pointSize" => {
                if let Some(p) = v.as_f64() {
                    set("pointSize", json!((p.round() as i64).clamp(1, 40)));
                }
            }
            "lineStyle" => match text(v, "fill").as_deref() {
                Some("dash") => set("lineStyle", json!("dashed")),
                Some("dot") => set("lineStyle", json!("dotted")),
                Some("solid") => set("lineStyle", json!("solid")),
                _ => {}
            },
            "spanNulls" => match v {
                Value::Bool(true) => set("connectGaps", json!("always")),
                Value::Bool(false) => set("connectGaps", json!("never")),
                Value::Number(n) => {
                    if let Some(ms) = n.as_u64().filter(|ms| (1..=365 * 86_400_000).contains(ms)) {
                        set("connectGaps", json!("threshold"));
                        set("connectGapsBelow", json!(ms));
                    }
                }
                _ => {}
            },
            "insertNulls" => {
                if let Some(ms) = v.as_u64().filter(|ms| (1..=365 * 86_400_000).contains(ms)) {
                    set("breakAfter", json!(ms));
                }
            }
            "stacking" => {
                if let Some(m) = text(v, "mode").filter(|m| ["none", "normal", "percent"].contains(&m.as_str())) {
                    set("stack", json!(m));
                    if let Some(group) = text(v, "group").filter(|g| g != "A" && m != "none") {
                        set("stackGroup", json!(truncate(&group, 50)));
                    }
                }
            }
            "barAlignment" => match v.as_i64() {
                Some(-1) => set("barAlignment", json!("before")),
                Some(0) => set("barAlignment", json!("center")),
                Some(1) => set("barAlignment", json!("after")),
                _ => {}
            },
            "barWidthFactor" => {
                if let Some(f) = v.as_f64() {
                    set("barWidth", json!(((f * 100.0).round() as i64).clamp(10, 100)));
                }
            }
            "thresholdsStyle" => {
                let mode = text(v, "mode").unwrap_or_default();
                let display = match mode.as_str() {
                    "off" => Some("off"),
                    "line" => Some("lines"),
                    "area" => Some("areas"),
                    "line+area" => Some("linesAndAreas"),
                    "dashed" => Some("lines"),
                    "dashed+area" => Some("linesAndAreas"),
                    _ => None,
                };
                if mode.starts_with("dashed") || display.is_none() && !mode.is_empty() {
                    notes.push(
                        note(
                            "threshold_style",
                            format!("the threshold style {mode} became the nearest Kalzit display"),
                        )
                        .with("style", &mode),
                    );
                }
                if let Some(d) = display.filter(|d| *d != "off") {
                    set("thresholdDisplay", json!(d));
                }
            }
            _ => {}
        }
        true
    }

    /// The defaults: every top-level option and every `custom` one.
    pub fn defaults(&self, defaults: &Value, notes: &mut Vec<ImportNote>) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in defaults.as_object().into_iter().flatten() {
            if key == "custom" {
                for (inner, value) in value.as_object().into_iter().flatten() {
                    self.property(&format!("custom.{inner}"), value, &mut out, notes);
                }
            } else {
                self.property(key, value, &mut out, notes);
            }
        }
        out
    }

    /// The overrides by name, by pattern and by a list of names, with `renamed` (a column's
    /// display name to its own name, from an organize step) undone, since Kalzit matches a field
    /// by its own name.
    pub fn overrides(
        &self,
        raw: &[Value],
        renamed: &BTreeMap<String, String>,
        notes: &mut Vec<ImportNote>,
    ) -> Vec<Value> {
        let mut out = Vec::new();
        let mut dropped = BTreeSet::new();
        let mut unknown = BTreeSet::new();
        for o in raw {
            let matcher = o.get("matcher").cloned().unwrap_or(Value::Null);
            let id = text(&matcher, "id").unwrap_or_default();
            let options = matcher.get("options").cloned().unwrap_or(Value::Null);
            // Without control characters; names longer than Kalzit keeps are left out below.
            let name_of = |n: &str| truncate(renamed.get(n).map_or(n, String::as_str), MAX_TEXT_CHARS + 1);
            let matchers: Vec<Value> = match id.as_str() {
                "byName" => {
                    options.as_str().map(|n| vec![json!({ "type": "name", "value": name_of(n) })]).unwrap_or_default()
                }
                "byNames" => options
                    .get("names")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(|n| json!({ "type": "name", "value": name_of(n) }))
                    .collect(),
                "byRegexp" => {
                    let pattern = options.as_str().unwrap_or_default().to_string();
                    if pattern.is_empty() || panel_options::check_pattern("pattern", &pattern).is_err() {
                        notes.push(
                            note(
                                "override_pattern",
                                format!("the override pattern {pattern} is not a valid Kalzit pattern and was dropped"),
                            )
                            .with("pattern", truncate(&pattern, 80)),
                        );
                        continue;
                    }
                    vec![json!({ "type": "regex", "value": pattern })]
                }
                other => {
                    dropped.insert(if other.is_empty() { "?".to_string() } else { truncate(other, 80) });
                    continue;
                }
            };
            let mut properties = Map::new();
            for p in o.get("properties").and_then(Value::as_array).into_iter().flatten() {
                let pid = text(p, "id").unwrap_or_default();
                let value = p.get("value").unwrap_or(&Value::Null);
                if !self.property(&pid, value, &mut properties, notes) {
                    unknown.insert(truncate(&pid, 80));
                }
            }
            if properties.is_empty() {
                continue;
            }
            for m in matchers {
                if m["value"].as_str().is_some_and(|v| v.chars().count() <= MAX_TEXT_CHARS) {
                    out.push(json!({ "matcher": m, "properties": properties.clone() }));
                }
            }
        }
        // Each property and matcher once, and not more than a few of them.
        for pid in unknown.into_iter().take(20) {
            notes.push(
                note("override_property", format!("the override property {pid} has no counterpart and was dropped"))
                    .with("property", pid),
            );
        }
        for matcher in dropped.into_iter().take(20) {
            notes.push(
                note(
                    "override_matcher",
                    format!("overrides that match {matcher} have no counterpart and were dropped"),
                )
                .with("matcher", matcher),
            );
        }
        if out.len() > MAX_OVERRIDES {
            out.truncate(MAX_OVERRIDES);
            notes.push(note("overrides_cut", "only the first 50 overrides were kept").with("max", MAX_OVERRIDES));
        }
        out
    }
}

/// The display names an organize step gives (`renameByName`): own name to display name.
pub(super) fn renames(transformations: &[Value]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for t in transformations.iter().filter(|t| text(t, "id").as_deref() == Some("organize")) {
        let by_name = t.get("options").and_then(|o| o.get("renameByName")).and_then(Value::as_object);
        for (own, shown) in by_name.into_iter().flatten() {
            if let Some(shown) = shown.as_str().map(str::trim).filter(|s| !s.is_empty() && *s != own) {
                out.insert(own.clone(), truncate(shown, MAX_TEXT_CHARS));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_map_to_the_catalog_a_suffix_or_nothing() {
        let mut notes = Vec::new();
        for (grafana, kalzit) in [
            ("currencyEUR", "currency:EUR"),
            ("currencyUSD", "currency:USD"),
            ("percent", "percent"),
            ("percentunit", "percentunit"),
            ("ms", "ms"),
            ("s", "s"),
            ("bytes", "bytes"),
            ("decbytes", "decbytes"),
            ("bps", "bitsps"),
            ("binBps", "bytesps"),
            ("short", "short"),
            ("none", "none"),
            ("reqps", "reqps"),
            ("µs", "us"),
            ("dateTimeAsLocal", "dateTime"),
            ("dateTimeFromNow", "fromNow"),
            ("suffix:Kerne", "suffix:Kerne"),
            ("currency:CHF", "currency:CHF"),
        ] {
            assert_eq!(unit(grafana, &mut notes).as_deref(), Some(kalzit), "{grafana}");
        }
        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(unit("kbytes", &mut notes).as_deref(), Some("suffix:KiB"));
        assert_eq!(unit("currencyBRL", &mut notes).as_deref(), Some("suffix:BRL"));
        assert_eq!(unit("rpm", &mut notes).as_deref(), Some("suffix:reads/min"));
        assert_eq!(unit("prefix:CHF ", &mut notes).as_deref(), Some("suffix:CHF"));
        assert_eq!(notes.iter().filter(|n| n.code == "unit_approximated").count(), 4);
        assert_eq!(notes[0].params["unit"], "kbytes");
        assert_eq!(notes[0].params["suffix"], "KiB");
        assert_eq!(unit("flux-capacitance", &mut notes), None);
        assert_eq!(notes.last().unwrap().code, "unit_unknown");

        // Byte scales that differ (SI against binary) become a suffix, not a unit that scales
        // in other steps; local date formats take the local one, reported as the nearest.
        let mut notes = Vec::new();
        assert_eq!(unit("Bps", &mut notes).as_deref(), Some("suffix:B/s"));
        assert_eq!(unit("binbps", &mut notes).as_deref(), Some("suffix:b/s"));
        assert_eq!(unit("bits", &mut notes).as_deref(), Some("suffix:b"));
        assert_eq!(unit("decbits", &mut notes).as_deref(), Some("bits"));
        assert_eq!(notes.iter().filter(|n| n.code == "unit_approximated").count(), 3);
        let mut notes = Vec::new();
        assert_eq!(unit("dateTimeAsIso", &mut notes).as_deref(), Some("dateTime"));
        assert_eq!((notes[0].code.as_str(), notes[0].params["nearest"].as_str()), ("unit_nearest", "dateTime"));

        assert!(is_kalzit_unit("currency:EUR") && is_kalzit_unit("rpm") && is_kalzit_unit("suffix:x"));
        assert!(!is_kalzit_unit("currencyEUR") && !is_kalzit_unit("currency:BRL") && !is_kalzit_unit("Bps"));
    }

    #[test]
    fn texts_from_the_file_cannot_break_the_field_options() {
        let f = Fields { kind: "table", groups: groups("table") };
        let mut notes = Vec::new();
        let long = "x".repeat(300);
        let overrides = f.overrides(
            &[
                json!({ "matcher": { "id": "byName", "options": "a\u{7}b" }, "properties": [
                    { "id": "links", "value": [{ "url": "https://example.org/?q=${__value.raw}\n" }] },
                    { "id": "custom.unknown", "value": 1 }, { "id": "custom.unknown", "value": 2 } ] }),
                json!({ "matcher": { "id": "byName", "options": long }, "properties": [{ "id": "decimals", "value": 1 }] }),
                json!({ "matcher": { "id": format!("by{long}") }, "properties": [] }),
            ],
            &BTreeMap::new(),
            &mut notes,
        );
        assert_eq!(
            overrides,
            vec![json!({ "matcher": { "type": "name", "value": "ab" }, "properties": {
                "link": "https://example.org/?q=${__value}", "cellDisplay": "link" } })]
        );
        let unknown: Vec<&ImportNote> = notes.iter().filter(|n| n.code == "override_property").collect();
        assert_eq!(unknown.len(), 1, "{notes:?}");
        let matcher = notes.iter().find(|n| n.code == "override_matcher").unwrap();
        assert_eq!(matcher.params["matcher"].chars().count(), 80);
        // An old range mapping with its ends the wrong way round is left out, not stored.
        let mut notes = Vec::new();
        assert!(mappings(&[json!({ "type": 2, "from": "10", "to": "1", "text": "x" })], &mut notes).is_empty());
        assert_eq!(notes[0].code, "mapping_invalid");
        // Bounds that are no finite number are left open.
        let open = mappings(&[json!({ "type": 2, "from": "NaN", "to": "inf", "text": "x" })], &mut Vec::new());
        assert_eq!(open, vec![json!({ "type": "range", "from": null, "to": null, "text": "x" })]);
        let checked = json!({ "defaults": {}, "overrides": overrides });
        assert!(panel_options::check("table", &json!({}), &checked).is_ok());
    }

    #[test]
    fn colours_take_the_nearest_tone() {
        assert_eq!(color("dark-green"), Color::Tone("ok"));
        assert_eq!(color("semi-dark-orange"), Color::Tone("warn"));
        assert_eq!(color("red"), Color::Tone("critical"));
        assert_eq!(color("light-blue"), Color::Tone("chart-1"));
        assert_eq!(color("purple"), Color::Tone("chart-6"));
        assert_eq!(color("#AABBCC"), Color::Free("#aabbcc".into()));
        assert_eq!(color("rgba(255, 0, 16, 0.5)"), Color::Free("#ff0010".into()));
        assert_eq!(color("transparent"), Color::Transparent);
        assert_eq!(color("chartreuse-ish"), Color::Unknown);
    }

    #[test]
    fn mappings_of_every_kind() {
        let mut notes = Vec::new();
        let m = mappings(
            &[
                json!({ "type": "value", "options": {
                    "b": { "text": "Bee", "color": "red", "index": 1 }, "a": { "text": "Ay", "color": "#123456", "index": 0 } } }),
                json!({ "type": "range", "options": { "from": 0, "to": 10, "result": { "text": "low", "color": "green" } } }),
                json!({ "type": "regex", "options": { "pattern": "^err", "result": { "text": "Error" } } }),
                json!({ "type": "regex", "options": { "pattern": "(?=x)", "result": { "text": "x" } } }),
                json!({ "type": "special", "options": { "match": "null", "result": { "text": "-" } } }),
                json!({ "id": 1, "type": 1, "value": "1", "text": "On" }),
            ],
            &mut notes,
        );
        assert_eq!(
            m,
            vec![
                json!({ "type": "value", "value": "a", "text": "Ay" }),
                json!({ "type": "value", "value": "b", "text": "Bee", "tone": "critical" }),
                json!({ "type": "range", "from": 0.0, "to": 10.0, "text": "low", "tone": "ok" }),
                json!({ "type": "regex", "pattern": "^err", "text": "Error" }),
                json!({ "type": "value", "value": "1", "text": "On" }),
            ]
        );
        let codes: Vec<&str> = notes.iter().map(|n| n.code.as_str()).collect();
        assert_eq!(codes, ["mapping_special", "mapping_colors", "mapping_invalid"]);
        assert_eq!(notes[0].params["match"], "null");
    }
}
