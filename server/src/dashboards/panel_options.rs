//! Checks of the options and field options of the built-in frame panels (`ui/src/panels/`). Each
//! panel type's `options` and the shared `fieldConfig` are parsed into closed shapes with bounds,
//! so a saved dashboard cannot carry unknown keys, oversized lists or unsafe links. The UI keeps
//! the same limits (`ui/src/panels/fieldConfig/fieldConfig.ts`). Panel types this module does not
//! know (document and graph panels, plugins) are left to their own checks.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// A unit id or `suffix:` plus up to 40 characters of a custom suffix.
pub const MAX_UNIT_CHARS: usize = 40 + "suffix:".len();
pub const MAX_DECIMALS: u32 = 10;
pub const MAX_THRESHOLD_STEPS: usize = 20;
pub const MAX_MAPPINGS: usize = 100;
pub const MAX_OVERRIDES: usize = 50;
/// Names, mapped texts, patterns and matchers.
pub const MAX_TEXT_CHARS: usize = 200;
pub const MAX_NO_VALUE_CHARS: usize = 100;
pub const MAX_LINK_CHARS: usize = 2000;
pub const MIN_COLUMN_WIDTH: u32 = 40;
pub const MAX_COLUMN_WIDTH: u32 = 1000;
/// The text panel's content.
pub const MAX_CONTENT_CHARS: usize = 20_000;

/// The panel types whose options this module checks.
pub const PANEL_TYPES: &[&str] = &[
    "timeseries",
    "stat",
    "bar",
    "table",
    "gauge",
    "bargauge",
    "piechart",
    "heatmap",
    "histogram",
    "state-timeline",
    "status-history",
    "text",
];

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Tone {
    Ok,
    Warn,
    Critical,
    Neutral,
    #[serde(rename = "chart-1")]
    Chart1,
    #[serde(rename = "chart-2")]
    Chart2,
    #[serde(rename = "chart-3")]
    Chart3,
    #[serde(rename = "chart-4")]
    Chart4,
    #[serde(rename = "chart-5")]
    Chart5,
    #[serde(rename = "chart-6")]
    Chart6,
    #[serde(rename = "chart-7")]
    Chart7,
    #[serde(rename = "chart-8")]
    Chart8,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ThresholdMode {
    Absolute,
    Percentage,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThresholdStep {
    value: Option<f64>,
    #[allow(dead_code)]
    tone: Tone,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Thresholds {
    #[allow(dead_code)]
    mode: ThresholdMode,
    steps: Vec<ThresholdStep>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
// The tones are checked by parsing; nothing reads them afterwards.
#[allow(dead_code)]
enum Mapping {
    Value { value: String, text: Option<String>, tone: Option<Tone> },
    Range { from: Option<f64>, to: Option<f64>, text: Option<String>, tone: Option<Tone> },
    Regex { pattern: String, text: Option<String>, tone: Option<Tone> },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum CellDisplay {
    Auto,
    ColorText,
    ColorBackground,
    Gauge,
    Link,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FieldOptions {
    unit: Option<String>,
    decimals: Option<u32>,
    min: Option<f64>,
    max: Option<f64>,
    thresholds: Option<Thresholds>,
    mappings: Option<Vec<Mapping>>,
    no_value: Option<String>,
    display_name: Option<String>,
    #[allow(dead_code)]
    color: Option<Tone>,
    #[allow(dead_code)]
    cell_display: Option<CellDisplay>,
    link: Option<String>,
    width: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MatcherType {
    Name,
    Regex,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Matcher {
    #[serde(rename = "type")]
    #[allow(dead_code)]
    kind: MatcherType,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Override {
    matcher: Matcher,
    #[serde(default)]
    properties: FieldOptions,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldConfig {
    #[serde(default)]
    defaults: FieldOptions,
    #[serde(default)]
    overrides: Vec<Override>,
}

/// One closed set of names, as the options store them.
macro_rules! choice {
    ($name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        #[derive(Debug, Deserialize)]
        enum $name {
            $(#[serde(rename = $text)] #[allow(dead_code)] $variant),+
        }
    };
}

choice!(LegendMode { List = "list", Table = "table", Hidden = "hidden" });
choice!(Placement { Bottom = "bottom", Right = "right" });
choice!(LegendValue { Last = "last", Min = "min", Max = "max", Mean = "mean" });
choice!(TooltipMode { Single = "single", All = "all", Hidden = "hidden" });
choice!(Reducer { Last = "last", Mean = "mean", Min = "min", Max = "max", Sum = "sum" });
choice!(ColorMode { None = "none", Value = "value", Background = "background" });
choice!(GraphMode { None = "none", Area = "area" });
choice!(TextMode { Auto = "auto", Value = "value", ValueAndName = "valueAndName", Name = "name" });
choice!(DisplayMode { Basic = "basic", Lcd = "lcd" });
choice!(Orientation { Horizontal = "horizontal", Vertical = "vertical" });
choice!(PieType { Pie = "pie", Donut = "donut" });
choice!(PieLabels { None = "none", Percent = "percent", Name = "name", Value = "value" });
choice!(HeatmapMode { Calculate = "calculate", Buckets = "buckets" });
choice!(HeatmapScale { Linear = "linear", Sqrt = "sqrt" });
choice!(TextFormat { Markdown = "markdown", Plain = "plain" });

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Legend {
    #[allow(dead_code)]
    mode: LegendMode,
    #[allow(dead_code)]
    placement: Placement,
    #[serde(default)]
    values: Vec<LegendValue>,
}

/// A time series stored its series name template under `legend` before the legend options.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LegendOrTemplate {
    Template(String),
    Legend(Legend),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Tooltip {
    #[allow(dead_code)]
    mode: TooltipMode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct TimeSeriesOptions {
    series_name: Option<String>,
    line_width: Option<u8>,
    legend: Option<LegendOrTemplate>,
    tooltip: Option<Tooltip>,
    show_legend: Option<bool>,
    unit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct StatOptions {
    reducer: Option<Reducer>,
    color_mode: Option<ColorMode>,
    graph_mode: Option<GraphMode>,
    text_mode: Option<TextMode>,
    sparkline: Option<bool>,
    unit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct BarOptions {
    show_values: Option<bool>,
    legend: Option<Legend>,
    tooltip: Option<Tooltip>,
    unit: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct TableOptions {
    column_filters: Option<bool>,
    pagination: Option<bool>,
    page_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct GaugeOptions {
    reducer: Option<Reducer>,
    show_threshold_markers: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct BarGaugeOptions {
    reducer: Option<Reducer>,
    display_mode: Option<DisplayMode>,
    orientation: Option<Orientation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct PieOptions {
    pie_type: Option<PieType>,
    reducer: Option<Reducer>,
    labels: Option<PieLabels>,
    legend: Option<Legend>,
    tooltip: Option<Tooltip>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct HeatmapOptions {
    mode: Option<HeatmapMode>,
    x_buckets: Option<u32>,
    y_buckets: Option<u32>,
    scale: Option<HeatmapScale>,
    tooltip: Option<Tooltip>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct HistogramOptions {
    bucket_count: Option<u32>,
    bucket_size: Option<f64>,
    combine: Option<bool>,
    legend: Option<Legend>,
    tooltip: Option<Tooltip>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct StateOptions {
    legend: Option<Legend>,
    tooltip: Option<Tooltip>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct TextOptions {
    mode: Option<TextFormat>,
    content: Option<String>,
}

fn parse<T: DeserializeOwned>(what: &str, value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("{what}: {e}"))
}

/// Length in characters and, for one-line texts, no control characters.
fn check_text(what: &str, value: &str, max: usize, multiline: bool) -> Result<(), String> {
    if value.chars().count() > max {
        return Err(format!("{what} takes at most {max} characters"));
    }
    let control = |c: char| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t'));
    if value.chars().any(control) {
        return Err(format!("{what} contains control characters"));
    }
    Ok(())
}

fn check_range(what: &str, value: Option<u32>, min: u32, max: u32) -> Result<(), String> {
    match value {
        Some(v) if !(min..=max).contains(&v) => Err(format!("{what} must be {min} to {max}")),
        _ => Ok(()),
    }
}

/// Links a cell may open: web and mail addresses, paths on this server, or the cell's own value
/// (`${__value}`, checked again by the UI once filled in). `javascript:` and the like never pass.
/// A backslash is refused anywhere: browsers read `/\host` as `//host`, another site.
fn is_safe_link(link: &str) -> bool {
    let lower = link.trim_start().to_ascii_lowercase();
    !lower.contains('\\')
        && (["http://", "https://", "mailto:", "./", "?", "#", "${__value}"].iter().any(|p| lower.starts_with(p))
            || (lower.starts_with('/') && !lower.starts_with("//")))
}

/// Largest compiled size of a pattern: the crate's own default. The syntax check keeps Unicode-wide
/// atoms to 100 (`pattern_syntax::MAX_WIDE`), which stays below it, so this limit never refuses a
/// pattern first; a hundred `\w` take most of it.
const MAX_PATTERN_BYTES: usize = 10 * (1 << 20);

/// Patterns use RE2 syntax, which the UI runs with a linear-time engine (re2js): no
/// backreferences or lookaround, so no pattern can make a page hang. Only syntax both engines
/// read alike passes (`pattern_syntax`), and one that does not compile here is not stored.
fn check_pattern(what: &str, pattern: &str) -> Result<(), String> {
    check_text(what, pattern, MAX_TEXT_CHARS, false)?;
    if super::pattern_syntax::refused_syntax(pattern) {
        return Err(format!("{what} is not a valid regular expression (RE2 syntax, no lookaround or backreferences)"));
    }
    regex::RegexBuilder::new(pattern)
        .size_limit(MAX_PATTERN_BYTES)
        .build()
        .map(|_| ())
        .map_err(|_| format!("{what} is not a valid regular expression (RE2 syntax, no lookaround or backreferences)"))
}

fn check_options(at: &str, o: &FieldOptions) -> Result<(), String> {
    if let Some(unit) = &o.unit {
        check_text(&format!("{at}.unit"), unit, MAX_UNIT_CHARS, false)?;
    }
    if let Some(d) = o.decimals
        && d > MAX_DECIMALS
    {
        return Err(format!("{at}.decimals must be 0 to {MAX_DECIMALS}"));
    }
    if let (Some(min), Some(max)) = (o.min, o.max)
        && min >= max
    {
        return Err(format!("{at}.min must be below max"));
    }
    if let Some(t) = &o.thresholds {
        let what = format!("{at}.thresholds.steps");
        if t.steps.is_empty() || t.steps.len() > MAX_THRESHOLD_STEPS {
            return Err(format!("{what} takes 1 to {MAX_THRESHOLD_STEPS} steps"));
        }
        if t.steps[0].value.is_some() {
            return Err(format!("{what}[0] is the base step and has no value"));
        }
        // Any order: the editor keeps a step in place while its value is typed, readers sort.
        if let Some(i) = t.steps.iter().skip(1).position(|step| step.value.is_none()) {
            return Err(format!("{what}[{}].value is required", i + 1));
        }
    }
    if let Some(mappings) = &o.mappings {
        if mappings.len() > MAX_MAPPINGS {
            return Err(format!("{at}.mappings takes at most {MAX_MAPPINGS} entries"));
        }
        for (i, m) in mappings.iter().enumerate() {
            let what = format!("{at}.mappings[{i}]");
            let (matched, text) = match m {
                Mapping::Value { value, text, .. } => (Some(value), text),
                Mapping::Regex { pattern, text, .. } => {
                    check_pattern(&format!("{what}.pattern"), pattern)?;
                    (Some(pattern), text)
                }
                Mapping::Range { from, to, text, .. } => {
                    if let (Some(from), Some(to)) = (from, to)
                        && from > to
                    {
                        return Err(format!("{what}.from must not be above to"));
                    }
                    (None, text)
                }
            };
            if let Some(matched) = matched {
                check_text(&format!("{what}.value"), matched, MAX_TEXT_CHARS, false)?;
            }
            if let Some(text) = text {
                check_text(&format!("{what}.text"), text, MAX_TEXT_CHARS, false)?;
            }
        }
    }
    if let Some(text) = &o.no_value {
        check_text(&format!("{at}.noValue"), text, MAX_NO_VALUE_CHARS, false)?;
    }
    if let Some(text) = &o.display_name {
        check_text(&format!("{at}.displayName"), text, MAX_TEXT_CHARS, false)?;
    }
    if let Some(link) = &o.link {
        check_text(&format!("{at}.link"), link, MAX_LINK_CHARS, false)?;
        if !is_safe_link(link) {
            return Err(format!("{at}.link must be a web or mail address or a path on this server"));
        }
    }
    check_range(&format!("{at}.width"), o.width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH)
}

/// Checks the shared field options of a panel.
fn check_field_config(value: &Value) -> Result<(), String> {
    let config: FieldConfig = parse("fieldConfig", value)?;
    check_options("fieldConfig.defaults", &config.defaults)?;
    if config.overrides.len() > MAX_OVERRIDES {
        return Err(format!("fieldConfig.overrides takes at most {MAX_OVERRIDES} entries"));
    }
    for (i, o) in config.overrides.iter().enumerate() {
        let at = format!("fieldConfig.overrides[{i}]");
        check_text(&format!("{at}.matcher.value"), &o.matcher.value, MAX_TEXT_CHARS, false)?;
        if matches!(o.matcher.kind, MatcherType::Regex) {
            check_pattern(&format!("{at}.matcher.value"), &o.matcher.value)?;
        }
        check_options(&format!("{at}.properties"), &o.properties)?;
    }
    Ok(())
}

fn check_legend(legend: Option<&Legend>) -> Result<(), String> {
    if let Some(legend) = legend
        && legend.values.len() > 4
    {
        return Err("options.legend.values takes at most 4 entries".into());
    }
    Ok(())
}

/// Checks a panel's `options` and `fieldConfig` when its type is one of `PANEL_TYPES`. Errors
/// name the place (`options.pageSize must be ...`).
pub fn check(kind: &str, options: &Value, field_config: &Value) -> Result<(), String> {
    if !PANEL_TYPES.contains(&kind) {
        return Ok(());
    }
    // The text panel uses no field options, but whatever it stores is checked like the others.
    check_field_config(field_config)?;
    let unit = |unit: &Option<String>| match unit {
        Some(u) => check_text("options.unit", u, MAX_UNIT_CHARS, false),
        None => Ok(()),
    };
    match kind {
        "timeseries" => {
            let o: TimeSeriesOptions = parse("options", options)?;
            if let Some(name) = &o.series_name {
                check_text("options.seriesName", name, MAX_TEXT_CHARS, false)?;
            }
            match &o.legend {
                Some(LegendOrTemplate::Template(t)) => check_text("options.legend", t, MAX_TEXT_CHARS, false)?,
                Some(LegendOrTemplate::Legend(l)) => check_legend(Some(l))?,
                None => {}
            }
            if let Some(w) = o.line_width
                && !(1..=3).contains(&w)
            {
                return Err("options.lineWidth must be 1 to 3".into());
            }
            unit(&o.unit)
        }
        "stat" => {
            let o: StatOptions = parse("options", options)?;
            unit(&o.unit)
        }
        "bar" => {
            let o: BarOptions = parse("options", options)?;
            check_legend(o.legend.as_ref())?;
            unit(&o.unit)
        }
        "table" => {
            let o: TableOptions = parse("options", options)?;
            check_range("options.pageSize", o.page_size, 5, 1000)
        }
        "gauge" => parse::<GaugeOptions>("options", options).map(|_| ()),
        "bargauge" => parse::<BarGaugeOptions>("options", options).map(|_| ()),
        "piechart" => {
            let o: PieOptions = parse("options", options)?;
            check_legend(o.legend.as_ref())
        }
        "heatmap" => {
            let o: HeatmapOptions = parse("options", options)?;
            check_range("options.xBuckets", o.x_buckets, 2, 200)?;
            check_range("options.yBuckets", o.y_buckets, 2, 100)
        }
        "histogram" => {
            let o: HistogramOptions = parse("options", options)?;
            check_range("options.bucketCount", o.bucket_count, 2, 200)?;
            if let Some(size) = o.bucket_size
                && size <= 0.0
            {
                return Err("options.bucketSize must be above 0".into());
            }
            check_legend(o.legend.as_ref())
        }
        "state-timeline" | "status-history" => {
            let o: StateOptions = parse("options", options)?;
            check_legend(o.legend.as_ref())
        }
        "text" => {
            let o: TextOptions = parse("options", options)?;
            if let Some(content) = &o.content {
                check_text("options.content", content, MAX_CONTENT_CHARS, true)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field_config() -> Value {
        json!({
            "defaults": {
                "unit": "bytes", "decimals": 2, "min": 0, "max": 100,
                "thresholds": { "mode": "absolute", "steps": [
                    { "value": null, "tone": "ok" }, { "value": 70, "tone": "warn" }, { "value": 90, "tone": "critical" }
                ] },
                "mappings": [
                    { "type": "value", "value": "1", "text": "Up", "tone": "ok" },
                    { "type": "range", "from": null, "to": 0, "text": "Down" },
                    { "type": "regex", "pattern": "^err", "tone": "critical" }
                ],
                "noValue": "–", "displayName": "Speicher", "color": "chart-3"
            },
            "overrides": [
                { "matcher": { "type": "name", "value": "url" },
                  "properties": { "cellDisplay": "link", "link": "https://example.org/q?v=${__value}", "width": 120 } },
                { "matcher": { "type": "regex", "value": "^cpu" }, "properties": { "unit": "suffix:Kerne" } }
            ]
        })
    }

    #[test]
    fn valid_options_of_every_panel_pass() {
        let legend = json!({ "mode": "table", "placement": "right", "values": ["last", "max"] });
        let tooltip = json!({ "mode": "single" });
        for (kind, options) in [
            ("timeseries", json!({ "seriesName": "{{job}}", "lineWidth": 2, "legend": legend, "tooltip": tooltip })),
            ("timeseries", json!({ "unit": "ms", "legend": "{{job}}", "lineWidth": 1, "showLegend": false })),
            (
                "stat",
                json!({ "reducer": "max", "colorMode": "background", "graphMode": "area", "textMode": "valueAndName" }),
            ),
            ("stat", json!({ "reducer": "last", "unit": "B", "sparkline": true })),
            ("bar", json!({ "showValues": true, "legend": legend, "tooltip": tooltip })),
            ("table", json!({ "columnFilters": true, "pagination": true, "pageSize": 50 })),
            ("table", json!({})),
            ("gauge", json!({ "reducer": "mean", "showThresholdMarkers": false })),
            ("bargauge", json!({ "reducer": "last", "displayMode": "lcd", "orientation": "vertical" })),
            ("piechart", json!({ "pieType": "donut", "reducer": "sum", "labels": "name", "legend": legend })),
            (
                "heatmap",
                json!({ "mode": "buckets", "xBuckets": 40, "yBuckets": 10, "scale": "sqrt", "tooltip": tooltip }),
            ),
            ("histogram", json!({ "bucketCount": 20, "bucketSize": 2.5, "combine": true })),
            ("state-timeline", json!({ "legend": legend, "tooltip": tooltip })),
            ("status-history", json!({})),
            ("text", json!({ "mode": "markdown", "content": "# Umsatz\n\n$region <b>bleibt Text</b>" })),
        ] {
            check(kind, &options, &field_config()).unwrap_or_else(|e| panic!("{kind}: {e}"));
        }
    }

    #[test]
    fn unknown_panel_types_are_left_alone() {
        assert!(check("documents", &json!({ "anything": 1 }), &json!({ "free": true })).is_ok());
    }

    #[test]
    fn invalid_options_are_refused_with_the_place() {
        for (kind, options, expect) in [
            ("table", json!({ "pageSize": 4 }), "options.pageSize"),
            ("table", json!({ "pageSize": 1001 }), "options.pageSize"),
            ("table", json!({ "rowColors": true }), "unknown field"),
            ("timeseries", json!({ "lineWidth": 9 }), "options.lineWidth"),
            ("timeseries", json!({ "legend": { "mode": "grid", "placement": "bottom" } }), "options"),
            ("stat", json!({ "colorMode": "rainbow" }), "options"),
            ("heatmap", json!({ "xBuckets": 1 }), "options.xBuckets"),
            ("heatmap", json!({ "yBuckets": 500 }), "options.yBuckets"),
            ("histogram", json!({ "bucketSize": 0 }), "options.bucketSize"),
            ("histogram", json!({ "bucketCount": 1000 }), "options.bucketCount"),
            (
                "bar",
                json!({ "legend": { "mode": "list", "placement": "bottom", "values": ["last", "min", "max", "mean", "last"] } }),
                "legend.values",
            ),
            ("text", json!({ "content": "x".repeat(MAX_CONTENT_CHARS + 1) }), "options.content"),
            ("text", json!({ "html": "<script>" }), "unknown field"),
            ("gauge", json!({ "reducer": "median" }), "options"),
        ] {
            let err = check(kind, &options, &json!({})).unwrap_err();
            assert!(err.contains(expect), "{kind} {options}: {err}");
        }
    }

    #[test]
    fn invalid_and_oversized_field_options_are_refused() {
        let with = |path: &str, value: Value| {
            // Sets the value at the path, adding the last key when the sample does not have it.
            let mut config = field_config();
            let (parent, key) = path.rsplit_once('/').unwrap();
            match config.pointer_mut(parent).unwrap() {
                Value::Object(map) => {
                    map.insert(key.to_string(), value);
                }
                Value::Array(items) => items[key.parse::<usize>().unwrap()] = value,
                other => panic!("{parent} is {other}"),
            }
            check("stat", &json!({}), &config)
        };
        for (path, value, expect) in [
            ("/defaults/unit", json!("x".repeat(MAX_UNIT_CHARS + 1)), "defaults.unit"),
            ("/defaults/decimals", json!(11), "defaults.decimals"),
            ("/defaults/decimals", json!(-1), "fieldConfig"),
            ("/defaults/min", json!(100), "min must be below max"),
            ("/defaults/thresholds/steps/0/value", json!(5), "base step"),
            ("/defaults/thresholds/steps/1/value", Value::Null, "steps[1].value"),
            ("/defaults/thresholds/steps", json!([]), "1 to 20"),
            ("/defaults/thresholds/steps/1/tone", json!("pink"), "fieldConfig"),
            ("/defaults/mappings/1/from", json!(5), "from must not be above"),
            ("/defaults/mappings/0/type", json!("special"), "fieldConfig"),
            ("/defaults/mappings/0/text", json!("x".repeat(MAX_TEXT_CHARS + 1)), "mappings[0].text"),
            ("/defaults/mappings/2/pattern", json!("a\u{7}b"), "control characters"),
            ("/defaults/noValue", json!("x".repeat(MAX_NO_VALUE_CHARS + 1)), "noValue"),
            ("/defaults/color", json!("#ff0000"), "fieldConfig"),
            ("/overrides/0/properties/link", json!("javascript:alert(1)"), "link must be"),
            ("/overrides/0/properties/link", json!("//evil.example/x"), "link must be"),
            ("/overrides/0/properties/width", json!(10), "width must be"),
            ("/overrides/0/properties/cellDisplay", json!("sparkline"), "fieldConfig"),
            ("/overrides/1/matcher/type", json!("type"), "fieldConfig"),
            ("/overrides/1/properties/colour", json!("red"), "unknown field"),
        ] {
            let err = with(path, value.clone()).unwrap_err();
            assert!(err.contains(expect), "{path} = {value}: {err}");
        }
        let many = |n: usize, item: Value| vec![item; n];
        let mut config = field_config();
        config["defaults"]["mappings"] = json!(many(MAX_MAPPINGS + 1, json!({ "type": "value", "value": "1" })));
        assert!(check("stat", &json!({}), &config).unwrap_err().contains("at most 100"));
        let mut config = field_config();
        config["overrides"] =
            json!(many(MAX_OVERRIDES + 1, json!({ "matcher": { "type": "name", "value": "a" }, "properties": {} })));
        assert!(check("stat", &json!({}), &config).unwrap_err().contains("at most 50"));
        let mut steps = vec![json!({ "value": null, "tone": "ok" })];
        steps.extend((0..MAX_THRESHOLD_STEPS).map(|i| json!({ "value": i, "tone": "warn" })));
        let mut config = field_config();
        config["defaults"]["thresholds"]["steps"] = json!(steps);
        assert!(check("stat", &json!({}), &config).unwrap_err().contains("1 to 20"));
    }

    #[test]
    fn patterns_must_be_re2_syntax() {
        let with_pattern = |pattern: &str| {
            let config = json!({ "defaults": { "mappings": [{ "type": "regex", "pattern": pattern, "text": "x" }] },
                                 "overrides": [] });
            check("stat", &json!({}), &config)
        };
        assert!(with_pattern("^err(or)?\\b").is_ok());
        assert!(with_pattern("(a+)+$").is_ok(), "linear-time engines run it safely");
        for bad in ["(a)\\1", "(?<=a)b", "(?=a)", "(unclosed", "[z-a]"] {
            let err = with_pattern(bad).unwrap_err();
            assert!(err.contains("not a valid regular expression"), "{bad}: {err}");
        }
        let override_with = |value: &str| {
            let config = json!({ "overrides": [{ "matcher": { "type": "regex", "value": value }, "properties": {} }] });
            check("table", &json!({}), &config)
        };
        assert!(override_with("^cpu_").is_ok());
        assert!(override_with("(?!x)").unwrap_err().contains("matcher.value"));
        // A name matcher is plain text, not a pattern.
        let by_name = json!({ "overrides": [{ "matcher": { "type": "name", "value": "(" }, "properties": {} }] });
        assert!(check("table", &json!({}), &by_name).is_ok());
    }

    /// Every panel's default options with the field options the UI editor writes, generated by
    /// `ui/src/panels/contract.test.ts`: what the UI saves, the server accepts.
    #[test]
    fn the_ui_fixture_passes() {
        let fixture: Vec<Value> = serde_json::from_str(include_str!("panel_options_fixture.json")).unwrap();
        assert!(fixture.len() >= PANEL_TYPES.len());
        for entry in &fixture {
            let kind = entry["type"].as_str().unwrap();
            assert!(PANEL_TYPES.contains(&kind), "{kind} has no server check");
            check(kind, &entry["options"], &entry["fieldConfig"]).unwrap_or_else(|e| panic!("{kind}: {e}"));
        }
    }

    /// The shared pattern cases, also checked against re2js by
    /// `ui/src/panels/fieldConfig/patternSyntax.test.ts`.
    #[test]
    fn patterns_agree_with_the_ui() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("pattern_fixture.json")).unwrap();
        assert!(cases.len() > 300);
        let wrong: Vec<String> = cases
            .iter()
            .filter_map(|case| {
                let pattern = case["pattern"].as_str().unwrap();
                let valid = case["valid"].as_bool().unwrap();
                (check_pattern("p", pattern).is_ok() != valid).then(|| format!("{pattern}: expected {valid}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    #[test]
    fn null_in_an_override_clears_the_default() {
        let config = json!({
            "defaults": { "unit": "ms", "thresholds": { "mode": "absolute", "steps": [{ "value": null, "tone": "ok" }] } },
            "overrides": [{ "matcher": { "type": "name", "value": "a" },
                            "properties": { "unit": null, "thresholds": null, "mappings": null, "color": null } }]
        });
        check("stat", &json!({}), &config).unwrap();
    }

    #[test]
    fn the_text_panel_checks_its_field_options_too() {
        assert!(check("text", &json!({ "content": "x" }), &json!({})).is_ok());
        assert!(check("text", &json!({}), &json!({ "anything": 1 })).unwrap_err().contains("fieldConfig"));
    }

    #[test]
    fn safe_links_pass() {
        for ok in
            ["https://a.example/x", "http://a", "mailto:a@b.example", "/d/abc", "./x", "?q=1", "#top", "${__value}"]
        {
            assert!(is_safe_link(ok), "{ok}");
        }
        for bad in [
            "javascript:alert(1)",
            "JavaScript:x",
            "data:text/html,x",
            "//evil.example",
            "/\\evil.example",
            "https://a.example\\@evil",
            "vbscript:x",
            "ftp://x",
        ] {
            assert!(!is_safe_link(bad), "{bad}");
        }
    }
}
