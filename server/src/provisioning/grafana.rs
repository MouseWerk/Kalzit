//! Converts a Grafana dashboard (their public JSON format, `schemaVersion` 6 to 41 with the old
//! `rows` layout below 16 and `gridPos` from 16 on) to a Kalzit dashboard model, with a report per
//! item: converted, approximated (and what changed) or skipped (and why). Clean-room: written from
//! the published format only. Nothing runs and nothing is contacted: data sources are mapped by
//! the caller, from a Grafana data source's uid or name to a Kalzit data source and its kind.
//! Skipped panels are left out, not kept as empty placeholders (docs/guide/grafana-import.md).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::dashboards::model;

/// The oldest and newest `schemaVersion` the converter reads.
pub const MIN_SCHEMA_VERSION: i64 = 6;
pub const MAX_SCHEMA_VERSION: i64 = 41;
/// Height in px of one grid row in the old layout, for converting row heights.
const LEGACY_ROW_PX: f64 = 30.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Converted,
    Approximated,
    Skipped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Dashboard,
    Panel,
    Row,
    Query,
    Variable,
    Annotation,
    Link,
}

/// One item of the report: what it was, and what became of it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    pub kind: ItemKind,
    /// Names the item in the Grafana dashboard on its own: `panel 4 "CPU"`, `variable host`.
    pub name: String,
    /// The item's title alone (`CPU`, `host`; empty when it has none), for a list that shows the
    /// kind next to it. Absent in reports of an older server.
    #[serde(default)]
    pub title: Option<String>,
    pub status: ItemStatus,
    /// What changed (approximated) or why it was left out (skipped); empty when converted.
    pub notes: Vec<ImportNote>,
}

/// One note of an item: a code the UI words in its language with `params`, and the English text
/// for the command line and for a code the UI does not know yet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportNote {
    /// `legend_format`, `no_mapping`, ...; the UI's key is `provisioning.note.<code>`.
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub text: String,
}

impl ImportNote {
    fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.into(), value.to_string());
        self
    }
}

/// Reads a note in either form: the current one, or the plain text of an older server.
impl<'de> Deserialize<'de> for ImportNote {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Text(String),
            Note {
                code: String,
                #[serde(default)]
                params: BTreeMap<String, String>,
                text: String,
            },
        }
        Ok(match Wire::deserialize(d)? {
            Wire::Text(text) => Self { code: String::new(), params: BTreeMap::new(), text },
            Wire::Note { code, params, text } => Self { code, params, text },
        })
    }
}

fn note(code: &str, text: impl Into<String>) -> ImportNote {
    ImportNote { code: code.into(), params: BTreeMap::new(), text: text.into() }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub converted: u32,
    pub approximated: u32,
    pub skipped: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// `grafana`.
    pub source: String,
    pub source_version: Option<i64>,
    pub title: String,
    pub items: Vec<ImportItem>,
    pub counts: ImportCounts,
}

/// A Kalzit data source a Grafana one maps to.
#[derive(Clone, Debug)]
pub struct SourceTarget {
    pub id: String,
    pub kind: String,
}

/// The result of a conversion: the model (not saved) and its report.
#[derive(Clone, Debug)]
pub struct Conversion {
    pub model: Value,
    pub report: ImportReport,
}

struct Report {
    items: Vec<ImportItem>,
}

/// An item's name on its own and its title alone (see [`ImportItem`]).
#[derive(Clone)]
struct Named {
    name: String,
    title: String,
}

fn named(name: String, title: impl Into<String>) -> Named {
    Named { name, title: title.into() }
}

impl Report {
    fn add(&mut self, kind: ItemKind, named: Named, notes: Vec<ImportNote>, skipped: bool) {
        let status = if skipped {
            ItemStatus::Skipped
        } else if notes.is_empty() {
            ItemStatus::Converted
        } else {
            ItemStatus::Approximated
        };
        self.items.push(ImportItem { kind, name: named.name, title: Some(named.title), status, notes });
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect()
}

/// A data source reference of the dashboard JSON, as the keys a mapping may use.
struct SourceRef {
    keys: Vec<String>,
    /// Empty for the dashboard's default data source.
    label: String,
    /// Grafana's own pseudo sources (mixed, dashboard, the built-in one, expressions).
    special: bool,
}

fn source_ref(raw: Option<&Value>, inputs: &BTreeMap<String, String>) -> SourceRef {
    let strip = |s: &str| s.trim_start_matches("${").trim_start_matches('$').trim_end_matches('}').to_string();
    let special_name = |s: &str| {
        matches!(s, "-- Mixed --" | "-- Dashboard --" | "-- Grafana --" | "grafana" | "__expr__" | "-- Expression --")
    };
    match raw {
        None | Some(Value::Null) => SourceRef { keys: vec!["default".into()], label: String::new(), special: false },
        Some(Value::String(s)) => {
            let mut keys = vec![s.clone()];
            if s.starts_with('$') {
                let inner = strip(s);
                keys.push(inner.clone());
                if let Some(name) = inputs.get(&inner) {
                    keys.push(name.clone());
                }
            }
            SourceRef { label: s.clone(), special: special_name(s), keys }
        }
        Some(obj) => {
            let uid = text(obj, "uid").unwrap_or_default();
            let kind = text(obj, "type").unwrap_or_default();
            let mut keys = Vec::new();
            if !uid.is_empty() {
                keys.push(uid.clone());
                if uid.starts_with('$') {
                    let inner = strip(&uid);
                    keys.push(inner.clone());
                    if let Some(name) = inputs.get(&inner) {
                        keys.push(name.clone());
                    }
                }
            }
            if keys.is_empty() {
                keys.push("default".into());
            }
            let special = special_name(&uid) || matches!(kind.as_str(), "datasource" | "grafana" | "__expr__");
            SourceRef { label: if uid.is_empty() { kind } else { uid }, special, keys }
        }
    }
}

impl SourceRef {
    fn no_mapping(&self) -> ImportNote {
        if self.label.is_empty() {
            note("no_mapping_default", "no mapping for the default data source")
        } else {
            note("no_mapping", format!("no mapping for the data source {}", self.label)).with("source", &self.label)
        }
    }
}

struct Converter<'a> {
    sources: &'a BTreeMap<String, SourceTarget>,
    inputs: BTreeMap<String, String>,
    report: Report,
    /// Variables converted, with whether they take several values.
    variables: BTreeMap<String, bool>,
    panel_ids: BTreeSet<String>,
}

/// Macros of Grafana's SQL sources that Kalzit's SQL handling knows (with `()` dropped where it
/// takes none).
const SQL_MACROS: &[&str] = &["__timeFilter", "__timeFrom", "__timeTo", "__interval", "__interval_ms"];

/// Grafana's old variable syntax `[[name]]` becomes `$name`; `${name:format}` loses the format.
fn plain_variables(query: &str, notes: &mut Vec<ImportNote>) -> String {
    let mut out = String::with_capacity(query.len());
    let mut rest = query;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("]]") {
            Some(end) => {
                let name = &rest[start + 2..start + 2 + end];
                let name = name.split(':').next().unwrap_or(name);
                out.push('$');
                out.push_str(name);
                rest = &rest[start + 2 + end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    let mut cleaned = String::with_capacity(out.len());
    let mut rest = out.as_str();
    let mut formats = false;
    while let Some(start) = rest.find("${") {
        cleaned.push_str(&rest[..start]);
        match rest[start..].find('}') {
            Some(end) => {
                let inner = &rest[start + 2..start + end];
                match inner.split_once(':') {
                    Some((name, _)) => {
                        formats = true;
                        cleaned.push('$');
                        cleaned.push_str(name);
                    }
                    None => {
                        cleaned.push('$');
                        cleaned.push_str(inner);
                    }
                }
                rest = &rest[start + end + 1..];
            }
            None => {
                cleaned.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    cleaned.push_str(rest);
    if formats {
        notes.push(note(
            "variable_formats",
            "variable formats (${name:format}) were dropped; Kalzit binds variable values as parameters",
        ));
    }
    cleaned
}

fn sql_query(raw: &str, notes: &mut Vec<ImportNote>) -> String {
    let mut sql = plain_variables(raw, notes);
    for name in ["__timeFrom", "__timeTo"] {
        sql = sql.replace(&format!("${name}()"), &format!("${name}"));
    }
    let mut unknown = BTreeSet::new();
    let mut rest = sql.as_str();
    while let Some(i) = rest.find("$__") {
        let tail = &rest[i + 1..];
        let end = tail.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(tail.len());
        let name = &tail[..end];
        if !SQL_MACROS.contains(&name) {
            unknown.insert(name.to_string());
        }
        rest = &tail[end..];
    }
    for name in unknown {
        notes.push(
            note(
                "sql_macro",
                format!("${name} has no Kalzit counterpart; rewrite that part of the query before it runs"),
            )
            .with("macro", format!("${name}")),
        );
    }
    sql
}

impl Converter<'_> {
    fn target_of(&self, source: &SourceRef) -> Option<&SourceTarget> {
        source.keys.iter().find_map(|k| self.sources.get(k))
    }

    /// One query of a panel, a variable or an annotation in the Kalzit kind's own form.
    fn query(&self, kind: &str, t: &Value, notes: &mut Vec<ImportNote>) -> Result<Value, ImportNote> {
        let no_expression = || note("no_expression", "the query has no expression");
        let builder = || note("query_builder", "built with Grafana's query builder; no query text to take over");
        let raw = |key: &str| text(t, key);
        match kind {
            "prometheus" => {
                let expr = raw("expr").ok_or_else(no_expression)?;
                let mut q = json!({ "expr": plain_variables(&expr, notes) });
                if t.get("instant").and_then(Value::as_bool) == Some(true)
                    && t.get("range").and_then(Value::as_bool) != Some(true)
                {
                    q["instant"] = json!(true);
                }
                if raw("legendFormat").is_some_and(|l| l != "__auto") {
                    notes
                        .push(note("legend_format", "the legend format is not carried; series keep their label names"));
                }
                Ok(q)
            }
            "loki" => {
                let expr = raw("expr").ok_or_else(no_expression)?;
                let mut q = json!({ "logql": plain_variables(&expr, notes) });
                if let Some(n) = t.get("maxLines").and_then(Value::as_u64) {
                    q["limit"] = json!(n);
                }
                Ok(q)
            }
            "postgres" | "mysql" | "mssql" | "sqlite" | "clickhouse" => {
                let sql = raw("rawSql").or_else(|| raw("query")).ok_or_else(|| {
                    note("query_builder_sql", "built with Grafana's query builder; no SQL text to take over")
                })?;
                if t.get("format").and_then(Value::as_str) == Some("time_series") {
                    notes.push(note(
                        "time_series_format",
                        "Grafana's time series format is not carried; the query answers a table",
                    ));
                }
                Ok(json!({ "sql": sql_query(&sql, notes) }))
            }
            "elasticsearch" => {
                let mut q = json!({ "lucene": raw("query").unwrap_or_else(|| "*".into()) });
                if let Some(field) = raw("timeField") {
                    q["timeField"] = json!(field);
                }
                let metrics = t.get("metrics").and_then(Value::as_array).map_or(0, Vec::len);
                let buckets = t.get("bucketAggs").and_then(Value::as_array).map_or(0, Vec::len);
                if metrics > 0 || buckets > 0 {
                    notes.push(note(
                        "aggregations",
                        "metric and bucket aggregations are not carried; the query answers documents",
                    ));
                }
                Ok(q)
            }
            "influxdb" => {
                let query = raw("query").ok_or_else(builder)?;
                let query = plain_variables(&query, notes);
                if query.contains("from(bucket") || query.contains("|>") {
                    Ok(json!({ "flux": query }))
                } else if t.get("rawQuery").and_then(Value::as_bool) == Some(false) {
                    Err(builder())
                } else {
                    Ok(json!({ "influxql": query }))
                }
            }
            other => {
                Err(note("source_kind", format!("queries of Kalzit data sources of type {other} are not converted"))
                    .with("kind", other))
            }
        }
    }

    fn targets(&mut self, panel: &Value, title: &str) -> Vec<Value> {
        let panel_source = panel.get("datasource");
        let mut out = Vec::new();
        let mut ref_ids = BTreeSet::new();
        for (i, t) in panel.get("targets").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let ref_id = text(t, "refId").unwrap_or_else(|| ((b'A' + (i % 26) as u8) as char).to_string());
            let name = named(
                format!("query {ref_id} of panel \"{title}\""),
                if title.is_empty() { ref_id.clone() } else { format!("{title} · {ref_id}") },
            );
            let source = source_ref(t.get("datasource").filter(|d| !d.is_null()).or(panel_source), &self.inputs);
            if source.special {
                self.report.add(
                    ItemKind::Query,
                    name,
                    vec![
                        note(
                            "grafana_source",
                            format!("{} is Grafana's own; it has no Kalzit counterpart", source.label),
                        )
                        .with("source", &source.label),
                    ],
                    true,
                );
                continue;
            }
            let Some(target) = self.target_of(&source).cloned() else {
                self.report.add(ItemKind::Query, name, vec![source.no_mapping()], true);
                continue;
            };
            if !ref_ids.insert(ref_id.clone()) || ref_id.chars().count() > 64 {
                self.report.add(
                    ItemKind::Query,
                    name,
                    vec![note("ref_id", "its refId is used twice or too long")],
                    true,
                );
                continue;
            }
            let mut notes = Vec::new();
            match self.query(&target.kind, t, &mut notes) {
                Ok(query) => {
                    let mut q = json!({ "refId": ref_id, "datasourceId": target.id, "query": query });
                    if t.get("hide").and_then(Value::as_bool) == Some(true) {
                        q["hide"] = json!(true);
                    }
                    out.push(q);
                    self.report.add(ItemKind::Query, name, notes, false);
                }
                Err(why) => self.report.add(ItemKind::Query, name, vec![why], true),
            }
        }
        out
    }

    fn field_config(&self, panel: &Value, notes: &mut Vec<ImportNote>) -> Value {
        let Some(defaults) = panel.get("fieldConfig").and_then(|f| f.get("defaults")) else { return json!({}) };
        let mut out = Map::new();
        if let Some(unit) = text(defaults, "unit") {
            if unit.chars().count() <= 40 {
                out.insert("unit".into(), json!(unit));
            } else {
                notes.push(note("unit_too_long", "the unit is too long and was dropped"));
            }
        }
        if let Some(d) = defaults.get("decimals").and_then(Value::as_u64) {
            out.insert("decimals".into(), json!(d.min(10)));
        }
        for key in ["min", "max"] {
            if let Some(n) = defaults.get(key).and_then(Value::as_f64) {
                out.insert(key.into(), json!(n));
            }
        }
        if let Some(name) = text(defaults, "displayName") {
            out.insert("displayName".into(), json!(truncate(&name, 200)));
        }
        if let Some(none) = text(defaults, "noValue") {
            out.insert("noValue".into(), json!(truncate(&none, 100)));
        }
        if let Some(thresholds) = defaults.get("thresholds") {
            let mode =
                if text(thresholds, "mode").as_deref() == Some("percentage") { "percentage" } else { "absolute" };
            let mut steps = Vec::new();
            let mut guessed = false;
            for step in thresholds.get("steps").and_then(Value::as_array).into_iter().flatten().take(20) {
                let color = text(step, "color").unwrap_or_default().to_lowercase();
                let (tone, free) = if color.contains("green") {
                    ("ok", None)
                } else if color.contains("yellow") || color.contains("orange") {
                    ("warn", None)
                } else if color.contains("red") {
                    ("critical", None)
                } else if color.len() == 7
                    && color.starts_with('#')
                    && color[1..].chars().all(|c| c.is_ascii_hexdigit())
                {
                    ("neutral", Some(color.clone()))
                } else {
                    guessed = true;
                    ("neutral", None)
                };
                let mut s = json!({ "value": step.get("value").and_then(Value::as_f64), "tone": tone });
                if let Some(free) = free {
                    s["color"] = json!(free);
                }
                steps.push(s);
            }
            if guessed {
                notes.push(note("threshold_colors", "threshold colours without a counterpart became neutral"));
            }
            if !steps.is_empty() {
                out.insert("thresholds".into(), json!({ "mode": mode, "steps": steps }));
            }
        }
        if defaults.get("mappings").and_then(Value::as_array).is_some_and(|m| !m.is_empty()) {
            notes.push(note("value_mappings", "value mappings are not carried"));
        }
        if panel
            .get("fieldConfig")
            .and_then(|f| f.get("overrides"))
            .and_then(Value::as_array)
            .is_some_and(|o| !o.is_empty())
        {
            notes.push(note("overrides", "field overrides are not carried"));
        }
        json!({ "defaults": out })
    }

    fn reducer(options: &Value) -> Option<&'static str> {
        let calc = options.get("reduceOptions")?.get("calcs")?.as_array()?.first()?.as_str()?;
        match calc {
            "lastNotNull" | "last" => Some("last"),
            "mean" => Some("mean"),
            "min" => Some("min"),
            "max" => Some("max"),
            "sum" => Some("sum"),
            _ => None,
        }
    }

    /// The panel's options in Kalzit's form, as far as they have one.
    fn options(kind: &str, panel: &Value, notes: &mut Vec<ImportNote>) -> Value {
        let o = panel.get("options").cloned().unwrap_or(Value::Null);
        let mut out = Map::new();
        let pick = |v: Option<&str>, allowed: &[&str]| v.filter(|v| allowed.contains(v)).map(|v| json!(v));
        match kind {
            "timeseries" => {
                if let Some(legend) = o.get("legend") {
                    let mode = match text(legend, "displayMode").as_deref() {
                        Some("table") => "table",
                        Some("hidden") => "hidden",
                        _ => "list",
                    };
                    let placement =
                        if text(legend, "placement").as_deref() == Some("right") { "right" } else { "bottom" };
                    let shown = legend.get("showLegend").and_then(Value::as_bool) != Some(false);
                    out.insert(
                        "legend".into(),
                        json!({ "mode": if shown { mode } else { "hidden" }, "placement": placement }),
                    );
                }
                if let Some(tooltip) = o.get("tooltip") {
                    let mode = match text(tooltip, "mode").as_deref() {
                        Some("multi") => "all",
                        Some("none") => "hidden",
                        _ => "single",
                    };
                    out.insert("tooltip".into(), json!({ "mode": mode }));
                }
            }
            "stat" => {
                if let Some(r) = Self::reducer(&o) {
                    out.insert("reducer".into(), json!(r));
                }
                if let Some(v) = pick(o.get("colorMode").and_then(Value::as_str), &["none", "value", "background"]) {
                    out.insert("colorMode".into(), v);
                }
                if let Some(v) = pick(o.get("graphMode").and_then(Value::as_str), &["none", "area"]) {
                    out.insert("graphMode".into(), v);
                }
                if let Some(v) =
                    pick(o.get("textMode").and_then(Value::as_str), &["auto", "value", "valueAndName", "name"])
                {
                    out.insert("textMode".into(), v);
                }
            }
            "gauge" => {
                if let Some(r) = Self::reducer(&o) {
                    out.insert("reducer".into(), json!(r));
                }
                if let Some(b) = o.get("showThresholdMarkers").and_then(Value::as_bool) {
                    out.insert("showThresholdMarkers".into(), json!(b));
                }
            }
            "bargauge" => {
                if let Some(r) = Self::reducer(&o) {
                    out.insert("reducer".into(), json!(r));
                }
                match o.get("displayMode").and_then(Value::as_str) {
                    Some("lcd") => {
                        out.insert("displayMode".into(), json!("lcd"));
                    }
                    Some("gradient") => notes.push(note("gradient", "the gradient display became the basic one")),
                    _ => {}
                }
                if let Some(v) = pick(o.get("orientation").and_then(Value::as_str), &["horizontal", "vertical"]) {
                    out.insert("orientation".into(), v);
                }
            }
            "piechart" => {
                if let Some(v) = pick(o.get("pieType").and_then(Value::as_str), &["pie", "donut"]) {
                    out.insert("pieType".into(), v);
                }
                if let Some(r) = Self::reducer(&o) {
                    out.insert("reducer".into(), json!(r));
                }
            }
            "text" => {
                let content = o.get("content").or_else(|| panel.get("content")).and_then(Value::as_str).unwrap_or("");
                let mode = o.get("mode").or_else(|| panel.get("mode")).and_then(Value::as_str).unwrap_or("markdown");
                let format = match mode {
                    "markdown" => "markdown",
                    "html" => {
                        notes.push(note("html_text", "HTML content is shown as plain text"));
                        "plain"
                    }
                    _ => "plain",
                };
                let mut content: String =
                    content.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect();
                if content.chars().count() > 20_000 {
                    content = content.chars().take(20_000).collect();
                    notes.push(note("text_cut", "the text was cut to 20000 characters").with("max", 20_000));
                }
                out.insert("mode".into(), json!(format));
                out.insert("content".into(), json!(content));
            }
            _ => {}
        }
        Value::Object(out)
    }

    fn panel_id(&mut self, panel: &Value, index: usize) -> String {
        let base =
            panel.get("id").and_then(Value::as_i64).map_or_else(|| format!("panel-{index}"), |id| format!("p{id}"));
        let mut id = base.clone();
        let mut n = 2;
        while !self.panel_ids.insert(id.clone()) {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }

    /// A panel, or `None` when it is skipped. `grid` is the place already worked out.
    fn panel(
        &mut self,
        panel: &Value,
        index: usize,
        grid: (i64, i64, i64, i64),
        row_id: Option<&str>,
    ) -> Option<Value> {
        let grafana_type = text(panel, "type").unwrap_or_default();
        let title_text = text(panel, "title").unwrap_or_default();
        let name = named(
            format!(
                "panel {} \"{}\"",
                panel.get("id").map_or_else(|| index.to_string(), ToString::to_string),
                title_text
            ),
            truncate(&title_text, model::MAX_TITLE_CHARS),
        );
        if panel.get("libraryPanel").is_some() {
            self.report.add(
                ItemKind::Panel,
                name,
                vec![note("library_panel", "a library panel; its content is not in the dashboard JSON")],
                true,
            );
            return None;
        }
        let mut notes = Vec::new();
        let kind = match grafana_type.as_str() {
            "timeseries" => "timeseries",
            "graph" => {
                notes.push(note(
                    "graph_panel",
                    "the old graph panel became a time series; its own display options are not carried",
                ));
                "timeseries"
            }
            "stat" => "stat",
            "singlestat" | "grafana-singlestat-panel" => {
                notes.push(note("singlestat_panel", "the old singlestat panel became a stat panel"));
                "stat"
            }
            "gauge" => "gauge",
            "bargauge" => "bargauge",
            "table" => "table",
            "table-old" => {
                notes
                    .push(note("table_panel", "the old table panel became a table; its column styles are not carried"));
                "table"
            }
            "piechart" => "piechart",
            "grafana-piechart-panel" => {
                notes.push(note("piechart_panel", "the pie chart plugin became the pie chart panel"));
                "piechart"
            }
            "barchart" => "bar",
            "heatmap" => {
                notes.push(note("heatmap_buckets", "the heatmap's bucket options are not carried"));
                "heatmap"
            }
            "histogram" => "histogram",
            "state-timeline" => "state-timeline",
            "status-history" => "status-history",
            "text" => "text",
            "nodeGraph" => {
                notes.push(note("node_graph", "the node graph became a network panel; it needs a graph-shaped result"));
                "network"
            }
            other => {
                let why = if other.is_empty() {
                    note("panel_no_type", "the panel has no type")
                } else {
                    note("panel_type", format!("Kalzit has no counterpart of the panel type {other}"))
                        .with("type", other)
                };
                self.report.add(ItemKind::Panel, name, vec![why], true);
                return None;
            }
        };
        let title = truncate(&title_text, model::MAX_TITLE_CHARS);
        let targets = if kind == "text" { Vec::new() } else { self.targets(panel, &title) };
        if kind != "text" && targets.is_empty() {
            self.report.add(ItemKind::Panel, name, vec![note("no_queries", "no query of it could be converted")], true);
            return None;
        }
        let (mut x, y, mut w, mut h) = grid;
        if !(1..=24).contains(&w) || x < 0 || x + w > 24 || !(1..=200).contains(&h) {
            w = w.clamp(1, 24);
            x = x.clamp(0, 24 - w);
            h = h.clamp(1, 200);
            notes.push(note("grid_fitted", "its place was fitted into the 24 columns"));
        }
        let options = Self::options(kind, panel, &mut notes);
        let field_config = if kind == "text" { json!({}) } else { self.field_config(panel, &mut notes) };
        let id = self.panel_id(panel, index);
        let mut out = json!({
            "id": id,
            "type": kind,
            "title": title,
            "grid": { "x": x, "y": y.clamp(0, 10_000), "w": w, "h": h },
            "targets": targets,
            "options": options,
            "fieldConfig": field_config,
        });
        if let Some(row) = row_id {
            out["rowId"] = json!(row);
        }
        let ref_ids: Vec<String> = targets.iter().filter_map(|t| t["refId"].as_str().map(str::to_string)).collect();
        let steps = steps_of(panel, &ref_ids, &mut notes);
        if !steps.is_empty() {
            out["transformations"] = json!(steps);
        }
        if let Some(d) = text(panel, "description") {
            let d: String = d
                .chars()
                .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
                .take(model::MAX_DESCRIPTION_CHARS)
                .collect();
            if !d.trim().is_empty() {
                out["description"] = json!(d);
            }
        }
        if panel.get("transparent").and_then(Value::as_bool) == Some(true) {
            out["transparent"] = json!(true);
        }
        if let Some(from) = text(panel, "timeFrom") {
            let from = if from.starts_with("now") { from } else { format!("now-{from}") };
            if from.starts_with("now-") && from.len() < 30 {
                out["timeFrom"] = json!(from);
            }
        }
        if let Some(shift) = text(panel, "timeShift") {
            if model::is_duration(&shift) {
                out["timeShift"] = json!(shift);
            } else {
                notes.push(
                    note("time_shift", format!("the time shift {shift} is not a plain length and was dropped"))
                        .with("shift", &shift),
                );
            }
        }
        if let Some(repeat) = text(panel, "repeat") {
            if self.variables.get(&repeat) == Some(&true) && row_id.is_none_or(|_| true) {
                let direction =
                    if text(panel, "repeatDirection").as_deref() == Some("v") { "vertical" } else { "horizontal" };
                let mut r = json!({ "variable": repeat, "direction": direction });
                if let Some(n) = panel.get("maxPerRow").and_then(Value::as_u64).filter(|n| (1..=24).contains(n)) {
                    r["maxPerRow"] = json!(n);
                }
                out["repeat"] = r;
            } else {
                notes.push(repeat_dropped(&repeat));
            }
        }
        let mut links = Vec::new();
        for link in panel.get("links").and_then(Value::as_array).into_iter().flatten().take(20) {
            let (Some(title), Some(url)) = (text(link, "title"), text(link, "url")) else { continue };
            if model::check_url("url", &url).is_ok() {
                links.push(json!({ "title": truncate(&title, 200), "url": url, "newTab": link.get("targetBlank").and_then(Value::as_bool).unwrap_or(false) }));
            } else {
                notes.push(
                    note(
                        "panel_link",
                        format!("the link {title} was dropped: its address is not http, https, mailto or a path"),
                    )
                    .with("title", &title),
                );
            }
        }
        if !links.is_empty() {
            out["links"] = json!(links);
        }
        // A panel whose options fail Kalzit's checks keeps the defaults rather than failing.
        if let Err(e) = crate::dashboards::panel_options::check(kind, &out["options"], &out["fieldConfig"]) {
            notes.push(options_default(&e));
            out["options"] = if kind == "text" { json!({ "content": "" }) } else { json!({}) };
            out["fieldConfig"] = json!({});
        }
        self.report.add(ItemKind::Panel, name, notes, false);
        Some(out)
    }

    fn variable(&mut self, v: &Value) -> Option<Value> {
        let name = text(v, "name").unwrap_or_default();
        let label = named(format!("variable {name}"), name.clone());
        let kind = text(v, "type").unwrap_or_default();
        let valid = !name.is_empty()
            && name.len() <= 64
            && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            self.report.add(
                ItemKind::Variable,
                label,
                vec![note("variable_name", "its name is not a Kalzit variable name (letters, digits, _)")],
                true,
            );
            return None;
        }
        if self.variables.contains_key(&name) {
            self.report.add(ItemKind::Variable, label, vec![note("variable_twice", "the name is used twice")], true);
            return None;
        }
        let mut notes = Vec::new();
        let multi = v.get("multi").and_then(Value::as_bool) == Some(true);
        let query_text = match v.get("query") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(o)) => o.get("query").and_then(Value::as_str).map(String::from),
            _ => None,
        };
        let current = v.get("current").and_then(|c| c.get("value")).cloned().filter(|c| !c.is_null());
        let mut out = json!({ "name": name });
        if let Some(l) = text(v, "label") {
            out["label"] = json!(truncate(&l, 200));
        }
        match kind.as_str() {
            "query" => {
                let source = source_ref(v.get("datasource"), &self.inputs);
                let Some(target) = (!source.special).then(|| self.target_of(&source).cloned()).flatten() else {
                    self.report.add(ItemKind::Variable, label, vec![source.no_mapping()], true);
                    return None;
                };
                let Some(q) = query_text else {
                    self.report.add(
                        ItemKind::Variable,
                        label,
                        vec![note("variable_no_query", "it has no query")],
                        true,
                    );
                    return None;
                };
                let helper = ["label_values(", "label_names(", "metrics(", "query_result("]
                    .iter()
                    .find(|h| q.trim_start().starts_with(**h));
                if let Some(helper) = helper {
                    self.report.add(
                        ItemKind::Variable,
                        label,
                        vec![
                            note("variable_helper", format!("Grafana's {helper}) helper has no Kalzit counterpart"))
                                .with("helper", format!("{helper})")),
                        ],
                        true,
                    );
                    return None;
                }
                let query = match self.query(&target.kind, &json!({ "expr": q, "rawSql": q, "query": q }), &mut notes) {
                    Ok(q) => q,
                    Err(why) => {
                        self.report.add(ItemKind::Variable, label, vec![why], true);
                        return None;
                    }
                };
                notes.retain(|n| n.code != "legend_format");
                out["type"] = json!("query");
                out["datasourceId"] = json!(target.id);
                out["query"] = query;
                if text(v, "regex").is_some() {
                    notes.push(note("variable_regex", "the regex filter of the values is not carried"));
                }
            }
            "custom" => {
                let mut options: Vec<Value> = Vec::new();
                if let Some(q) = &query_text {
                    for part in q.split(',').map(str::trim).filter(|p| !p.is_empty()) {
                        match part.split_once(" : ") {
                            Some((label, value)) => {
                                options.push(json!({ "value": value.trim(), "label": label.trim() }))
                            }
                            None => options.push(json!(part)),
                        }
                    }
                }
                out["type"] = json!("custom");
                out["options"] = json!(options);
            }
            "constant" => {
                out["type"] = json!("constant");
                out["current"] = json!(query_text.unwrap_or_default());
            }
            "textbox" => {
                out["type"] = json!("textbox");
                if let Some(q) = &query_text {
                    out["current"] = json!(q);
                }
            }
            "interval" => {
                let options: Vec<String> = query_text
                    .unwrap_or_default()
                    .split(',')
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .map(String::from)
                    .collect();
                if v.get("auto").and_then(Value::as_bool) == Some(true) {
                    notes.push(note("auto_interval", "the automatic interval option is not carried"));
                }
                out["type"] = json!("interval");
                out["options"] = json!(options);
            }
            other => {
                let why = match other {
                    "datasource" => {
                        note("variable_datasource", "variables that pick a data source come later in Kalzit")
                    }
                    "adhoc" => note("variable_adhoc", "ad hoc filters come later in Kalzit"),
                    _ => note("variable_type", format!("Kalzit has no counterpart of the variable type {other}"))
                        .with("type", other),
                };
                self.report.add(ItemKind::Variable, label, vec![why], true);
                return None;
            }
        }
        let multi_ok = matches!(kind.as_str(), "query" | "custom");
        if multi && multi_ok {
            out["multi"] = json!(true);
        }
        if v.get("includeAll").and_then(Value::as_bool) == Some(true) {
            notes.push(note("all_option", "the \"All\" option is not carried"));
        }
        if matches!(kind.as_str(), "query" | "custom" | "interval")
            && let Some(c) = current
        {
            let all = c.as_str() == Some("$__all")
                || c.as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some("$__all")));
            if !all {
                out["current"] = c;
            }
        }
        self.variables.insert(name, multi && multi_ok);
        self.report.add(ItemKind::Variable, label, notes, false);
        Some(out)
    }

    fn annotation(&mut self, a: &Value, index: usize) -> Option<Value> {
        let own_name = text(a, "name");
        // An annotation without a name keeps a numbered one in the model and on the command line;
        // its title stays empty, which the UI words in its language.
        let name = own_name.clone().unwrap_or_else(|| format!("annotation {}", index + 1));
        let label = named(format!("annotation {name}"), own_name.unwrap_or_default());
        if a.get("builtIn").and_then(Value::as_i64) == Some(1) {
            self.report.add(
                ItemKind::Annotation,
                label,
                vec![note("builtin_annotations", "Grafana's built-in annotations stay in Grafana")],
                true,
            );
            return None;
        }
        let source = source_ref(a.get("datasource"), &self.inputs);
        let Some(target) = (!source.special).then(|| self.target_of(&source).cloned()).flatten() else {
            self.report.add(ItemKind::Annotation, label, vec![source.no_mapping()], true);
            return None;
        };
        let mut notes = Vec::new();
        let raw = a.get("target").cloned().filter(Value::is_object).unwrap_or_else(|| a.clone());
        let mut raw = raw;
        if raw.get("rawSql").is_none()
            && let Some(q) = text(a, "rawQuery")
        {
            raw["rawSql"] = json!(q);
        }
        match self.query(&target.kind, &raw, &mut notes) {
            Ok(query) => {
                notes.retain(|n| n.code != "legend_format");
                self.report.add(ItemKind::Annotation, label, notes, false);
                Some(json!({
                    "id": format!("annotation-{}", index + 1),
                    "name": truncate(&name, 200),
                    "datasourceId": target.id,
                    "query": query,
                    "enabled": a.get("enable").and_then(Value::as_bool).unwrap_or(true),
                }))
            }
            Err(why) => {
                self.report.add(ItemKind::Annotation, label, vec![why], true);
                None
            }
        }
    }

    fn link(&mut self, l: &Value) -> Option<Value> {
        let title = text(l, "title").unwrap_or_default();
        let label = named(format!("link {title}"), title.clone());
        let new_tab = l.get("targetBlank").and_then(Value::as_bool).unwrap_or(false);
        match text(l, "type").as_deref() {
            Some("dashboards") => {
                let tags: Vec<String> = l
                    .get("tags")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect();
                let Some(tag) = tags.first().filter(|t| t.chars().count() <= 50) else {
                    self.report.add(
                        ItemKind::Link,
                        label,
                        vec![note("link_no_tag", "a link to dashboards without a tag")],
                        true,
                    );
                    return None;
                };
                let notes = if tags.len() > 1 {
                    vec![note("link_first_tag", format!("only the first tag ({tag}) is kept")).with("tag", tag)]
                } else {
                    Vec::new()
                };
                self.report.add(ItemKind::Link, label, notes, false);
                Some(json!({ "type": "dashboards", "tag": tag, "title": truncate(&title, 200), "newTab": new_tab }))
            }
            Some("link") => {
                let url = text(l, "url").unwrap_or_default();
                if title.is_empty() || model::check_url("url", &url).is_err() {
                    self.report.add(
                        ItemKind::Link,
                        label,
                        vec![note("link_invalid", "it needs a title and an http, https, mailto or path address")],
                        true,
                    );
                    return None;
                }
                self.report.add(ItemKind::Link, label, Vec::new(), false);
                Some(json!({ "type": "url", "title": truncate(&title, 200), "url": url, "newTab": new_tab }))
            }
            other => {
                self.report.add(
                    ItemKind::Link,
                    label,
                    vec![
                        note("link_type", format!("links of type {} are not converted", other.unwrap_or("none")))
                            .with("type", other.unwrap_or("none")),
                    ],
                    true,
                );
                None
            }
        }
    }
}

/// A panel's options that fail Kalzit's checks: the option the check names (`options.lineWidth`)
/// goes along on its own, so the UI's sentence holds no English; the check's text stays the detail.
/// Grafana's calculation names and Kalzit's; the others have no counterpart.
fn reducer(name: &str) -> Option<String> {
    Some(match name {
        "lastNotNull" => "last".into(),
        "last" => "lastRow".into(),
        "firstNotNull" => "first".into(),
        "first" => "firstRow".into(),
        "mean" | "sum" | "min" | "max" | "count" | "median" | "variance" => name.into(),
        "stdDev" => "stddev".into(),
        // Grafana's percentiles are p1 to p99.
        p => crate::analysis::Agg::parse(p).filter(|a| matches!(a, crate::analysis::Agg::Percentile(_)))?.name(),
    })
}

/// A note for a Grafana calculation that became a Kalzit one that differs in a detail.
fn reducer_note(name: &str) -> Option<ImportNote> {
    match name {
        "last" | "first" => Some(
            note(
                "step_reducer_row",
                format!("{name} became the cell of the {name} row, which may be empty; first and last value skip empty cells"),
            )
            .with("reducer", name),
        ),
        "stdDev" | "variance" => Some(
            note(
                "step_reducer_sample",
                format!("Grafana computes {name} over all values (population); Kalzit uses the sample (n - 1)"),
            )
            .with("reducer", name),
        ),
        _ => None,
    }
}

/// A Grafana name pattern as Kalzit reads it. As in Grafana (`stringToJsRegex`), the form
/// `/body/flags` is found anywhere and loses its slashes, while a pattern without them must match
/// the whole name: `cpu` becomes `^cpu$` (and `a|b` becomes `^a|b$`, as Grafana reads it). Flags
/// change what matches and have no counterpart, so a pattern with them is not taken over.
fn name_pattern(raw: &str) -> Result<String, String> {
    if let Some(rest) = raw.strip_prefix('/')
        && let Some(end) = rest.rfind('/')
    {
        let (body, flags) = (&rest[..end], &rest[end + 1..]);
        if !flags.chars().all(|c| c == 'g') {
            return Err(flags.to_string());
        }
        return Ok(body.to_string());
    }
    Ok(format!("^{raw}$"))
}

/// A pattern for a note: at most 80 characters, cut with an ellipsis.
fn short_pattern(pattern: &str) -> String {
    if pattern.chars().count() <= 80 {
        return pattern.to_string();
    }
    let mut short: String = pattern.chars().take(79).collect();
    short.push('\u{2026}');
    short
}

/// Whether a Grafana date format uses only the parts Kalzit reads (`YYYY`, `MM`, `DD`, `HH`,
/// `mm`, `ss`, `SSS`) besides characters that stand for themselves.
fn plain_time_format(format: &str) -> bool {
    let mut rest = format.to_string();
    for token in ["YYYY", "SSS", "MM", "DD", "HH", "mm", "ss"] {
        rest = rest.replace(token, "");
    }
    !rest.chars().any(|c| c.is_ascii_alphabetic())
}

/// A Grafana value condition (`filterByValue`) as a Kalzit row condition.
fn row_condition(filter: &Value, notes: &mut Vec<ImportNote>) -> Option<Value> {
    let field = text(filter, "fieldName")?;
    let config = filter.get("config")?;
    let matcher = text(config, "id").unwrap_or_default();
    let options = config.get("options").cloned().unwrap_or(json!({}));
    let scalar = |key: &str| options.get(key).filter(|v| v.is_number() || v.is_string() || v.is_boolean()).cloned();
    let op = match matcher.as_str() {
        "isNull" => return Some(json!({ "field": field, "op": "empty" })),
        "isNotNull" => return Some(json!({ "field": field, "op": "notEmpty" })),
        "equal" => "eq",
        "notEqual" => "ne",
        "greater" => "gt",
        "greaterOrEqual" => "gte",
        "lower" => "lt",
        "lowerOrEqual" => "lte",
        "regex" => "matches",
        "range" => {
            if let (Some(from), Some(to)) = (scalar("from"), scalar("to"))
                && !from.is_boolean()
                && !to.is_boolean()
            {
                return Some(json!({ "field": field, "op": "between", "value": from, "to": to }));
            }
            ""
        }
        _ => "",
    };
    let value = scalar("value");
    match (op, value) {
        ("matches", Some(Value::String(p))) => {
            if crate::analysis::table::field_pattern(&p).is_err() {
                let short = short_pattern(&p);
                notes.push(
                    note(
                        "step_condition_pattern",
                        format!(
                            "the condition on {field} with the pattern {short} is no regular expression Kalzit can read and was left out"
                        ),
                    )
                    .with("field", &field)
                    .with("pattern", &short),
                );
                return None;
            }
            Some(json!({ "field": field, "op": op, "value": p }))
        }
        ("matches", _) | ("", _) | (_, None) => {
            notes.push(
                note("step_matcher", format!("the condition {matcher} on {field} has no counterpart and was left out"))
                    .with("matcher", &matcher)
                    .with("field", &field),
            );
            None
        }
        (op, Some(v)) => Some(json!({ "field": field, "op": op, "value": v })),
    }
}

/// The panel's Grafana transformations as Kalzit steps, each checked as a panel checks its steps;
/// what has no counterpart is left out with a note. Steps that work on one table work on the
/// first query until a step put the queries together.
fn steps_of(panel: &Value, ref_ids: &[String], notes: &mut Vec<ImportNote>) -> Vec<Value> {
    let Some(first) = ref_ids.first() else { return Vec::new() };
    let refs: BTreeSet<&str> = ref_ids.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    let mut combined = ref_ids.len() == 1;
    let list = panel.get("transformations").and_then(Value::as_array).into_iter().flatten();
    for (i, tr) in list.take(crate::analysis::MAX_STEPS).enumerate() {
        let kind = text(tr, "id").unwrap_or_default();
        let o = tr.get("options").cloned().unwrap_or(json!({}));
        let names = |v: Option<&Value>| -> Vec<String> {
            v.and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|n| n.as_str().map(str::to_string))
                .take(crate::analysis::MAX_FIELD_LIST)
                .collect()
        };
        let mut per_frame = true;
        let step = match kind.as_str() {
            "organize" => {
                let hide: Vec<String> = o
                    .get("excludeByName")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter(|(_, v)| v.as_bool() == Some(true))
                    .map(|(k, _)| k.clone())
                    .collect();
                let mut indexed: Vec<(i64, String)> = o
                    .get("indexByName")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter_map(|(k, v)| v.as_i64().map(|n| (n, k.clone())))
                    .collect();
                indexed.sort();
                let rename: Map<String, Value> = o
                    .get("renameByName")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flatten()
                    .filter(|(_, v)| v.as_str().is_some_and(|s| !s.is_empty()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                let mut step = json!({ "type": "organize", "frame": first });
                if !indexed.is_empty() {
                    step["order"] = json!(indexed.into_iter().map(|(_, k)| k).collect::<Vec<_>>());
                }
                if !hide.is_empty() {
                    step["hide"] = json!(hide);
                }
                if !rename.is_empty() {
                    step["rename"] = Value::Object(rename);
                }
                Some(step)
            }
            "filterFieldsByName" => {
                let (mode, spec) = match (o.get("include"), o.get("exclude")) {
                    (Some(spec), _) => ("keep", spec),
                    (None, Some(spec)) => ("drop", spec),
                    (None, None) => ("keep", &Value::Null),
                };
                let mut step = json!({ "type": "filterFields", "frame": first, "mode": mode });
                let list = names(spec.get("names"));
                if !list.is_empty() {
                    step["names"] = json!(list);
                }
                if let Some(p) = text(spec, "pattern").filter(|p| !p.is_empty()) {
                    match name_pattern(&p) {
                        Ok(body) if crate::analysis::table::field_pattern(&body).is_err() => {
                            let short = short_pattern(&p);
                            notes.push(
                                note(
                                    "step_pattern",
                                    format!("the pattern {short} is no regular expression Kalzit can read; the step was left out"),
                                )
                                .with("pattern", &short),
                            );
                            continue;
                        }
                        Ok(body) if !body.is_empty() => step["pattern"] = json!(body),
                        Ok(_) => {}
                        Err(flags) => {
                            notes.push(
                                note(
                                    "step_pattern_flags",
                                    format!("the pattern {p} uses the flags {flags}, which Kalzit does not read; the step was left out"),
                                )
                                .with("pattern", &p)
                                .with("flags", &flags),
                            );
                            continue;
                        }
                    }
                }
                (o.get("byVariable").and_then(Value::as_bool) != Some(true)).then_some(step)
            }
            "filterByValue" => {
                let conditions: Vec<Value> = o
                    .get("filters")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .take(crate::analysis::MAX_CONDITIONS)
                    .filter_map(|f| row_condition(f, notes))
                    .collect();
                let mode = if text(&o, "type").as_deref() == Some("exclude") { "drop" } else { "keep" };
                let match_ = if text(&o, "match").as_deref() == Some("all") { "all" } else { "any" };
                Some(json!({ "type": "filterRows", "frame": first, "mode": mode, "match": match_,
                             "conditions": conditions }))
            }
            "limit" => {
                let count = o.get("limitField").and_then(Value::as_u64).unwrap_or(10);
                let count = count.clamp(1, u64::from(crate::analysis::MAX_LIMIT));
                Some(json!({ "type": "limit", "frame": first, "count": count }))
            }
            "convertFieldType" => {
                let mut seen = BTreeSet::new();
                let mut conversions = Vec::new();
                for c in o.get("conversions").and_then(Value::as_array).into_iter().flatten() {
                    let Some(field) = text(c, "targetField").filter(|f| !f.is_empty()) else { continue };
                    let destination = text(c, "destinationType").unwrap_or_default();
                    let to = match destination.as_str() {
                        "number" => "number",
                        "string" => "string",
                        "time" => "time",
                        "boolean" => "bool",
                        _ => {
                            notes.push(
                                note(
                                    "step_conversion",
                                    format!(
                                        "the conversion of {field} to {destination} has no counterpart and was left out"
                                    ),
                                )
                                .with("field", &field)
                                .with("type", &destination),
                            );
                            continue;
                        }
                    };
                    if !seen.insert(field.clone()) {
                        continue;
                    }
                    let mut conversion = json!({ "field": field, "to": to });
                    if let Some(format) = text(c, "dateFormat").filter(|f| !f.is_empty() && to == "time") {
                        if plain_time_format(&format) {
                            conversion["format"] = json!(format);
                        } else {
                            notes.push(
                                note(
                                    "step_time_format",
                                    format!("the time format {format} uses parts Kalzit does not read; ISO 8601 is read instead"),
                                )
                                .with("format", &format),
                            );
                        }
                    }
                    conversions.push(conversion);
                }
                Some(json!({ "type": "convert", "frame": first, "conversions": conversions }))
            }
            "reduce" => {
                let mut calculations: Vec<String> = Vec::new();
                for r in names(o.get("reducers")) {
                    match reducer(&r) {
                        Some(c) if !calculations.contains(&c) => {
                            notes.extend(reducer_note(&r));
                            calculations.push(c);
                        }
                        Some(_) => {}
                        None => notes.push(
                            note("step_reducer", format!("the calculation {r} has no counterpart and was left out"))
                                .with("reducer", &r),
                        ),
                    }
                }
                let mode = if text(&o, "mode").as_deref() == Some("reduceFields") { "columns" } else { "rows" };
                Some(json!({ "type": "reduceSeries", "frame": first, "mode": mode, "calculations": calculations }))
            }
            "merge" if !combined => {
                per_frame = false;
                notes.push(note(
                    "step_merge",
                    "merge became stack tables: rows with equal values are not combined into one",
                ));
                Some(json!({ "type": "stack", "frames": ref_ids }))
            }
            // One query, or the queries already are one table: nothing to merge.
            "merge" => continue,
            "seriesToRows" => {
                per_frame = false;
                // Once the queries are one table, only the first is left to read.
                let frames: Vec<&str> =
                    if combined { vec![first.as_str()] } else { ref_ids.iter().map(String::as_str).collect() };
                Some(json!({ "type": "seriesToRows", "frames": frames }))
            }
            _ => {
                notes.push(
                    note("step_dropped", format!("Grafana's {kind} has no Kalzit step and was left out"))
                        .with("kind", &kind),
                );
                continue;
            }
        };
        let Some(mut step) = step else {
            notes.push(
                note("step_empty", format!("Grafana's {kind} had nothing Kalzit could take over and was left out"))
                    .with("kind", &kind),
            );
            continue;
        };
        step["id"] = json!(format!("g{}", i + 1));
        if tr.get("disabled").and_then(Value::as_bool) == Some(true) {
            step["disabled"] = json!(true);
        }
        if crate::analysis::check_steps(std::slice::from_ref(&step), &refs, "transformations").is_err() {
            notes.push(
                note("step_empty", format!("Grafana's {kind} had nothing Kalzit could take over and was left out"))
                    .with("kind", &kind),
            );
            continue;
        }
        if per_frame && !combined {
            notes.push(
                note("step_first_query", format!("{kind} works on query {first} only"))
                    .with("kind", &kind)
                    .with("refId", first),
            );
        }
        if !per_frame {
            combined = true;
        }
        out.push(step);
    }
    out
}

fn options_default(detail: &str) -> ImportNote {
    let field: String = detail
        .split_whitespace()
        .next()
        .filter(|w| w.starts_with("options.") || w.starts_with("fieldConfig."))
        .map(|w| w.trim_end_matches([':', ',', ';']).to_string())
        .unwrap_or_default();
    let text = format!("options fell back to the defaults ({detail})");
    if field.is_empty() {
        note("options_default", text).with("detail", detail)
    } else {
        note("options_default_field", text).with("field", field).with("detail", detail)
    }
}

/// A panel's or row's repeat over a variable that does not take several values.
fn repeat_dropped(repeat: &str) -> ImportNote {
    note(
        "repeat_dropped",
        format!("the repeat over {repeat} was dropped: that variable does not take several values here"),
    )
    .with("variable", repeat)
}

/// A Grafana time (`now-6h`, an ISO time or Unix milliseconds as text) in Kalzit's form.
fn time(raw: Option<&str>, fallback: &str) -> (String, bool) {
    let Some(raw) = raw.map(str::trim).filter(|r| !r.is_empty()) else { return (fallback.into(), true) };
    if raw.starts_with("now") {
        return (raw.to_string(), false);
    }
    if let Ok(ms) = raw.parse::<i64>()
        && let Some(t) = chrono::DateTime::from_timestamp_millis(ms)
    {
        return (t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), false);
    }
    if chrono::DateTime::parse_from_rfc3339(raw).is_ok() {
        return (raw.to_string(), false);
    }
    (fallback.into(), true)
}

/// Seconds of a Grafana length (`30s`, `5m`, `1h`, `1d`).
fn seconds(raw: &str) -> Option<u32> {
    let raw = raw.trim();
    let digits = raw.chars().take_while(char::is_ascii_digit).count();
    let n: u32 = raw[..digits].parse().ok()?;
    let factor = match &raw[digits..] {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => return None,
    };
    n.checked_mul(factor)
}

/// Converts a Grafana dashboard JSON (the dashboard itself, or an export wrapping it in
/// `dashboard`). `sources` maps a Grafana data source's uid or name (or `${DS_X}` input, or
/// `default` for panels without one) to a Kalzit data source.
pub fn convert(input: &Value, sources: &BTreeMap<String, SourceTarget>) -> Result<Conversion, String> {
    let dash = input.get("dashboard").filter(|d| d.is_object() && input.get("panels").is_none()).unwrap_or(input);
    if !dash.is_object() {
        return Err("the file is not a Grafana dashboard (expected a JSON object)".into());
    }
    if dash.get("elements").is_some() || (dash.get("kind").is_some() && dash.get("spec").is_some()) {
        return Err(
            "this is Grafana's newer dashboard schema (v2, elements and layouts), which the import does not read; \
                    export the dashboard as classic JSON"
                .into(),
        );
    }
    let version = dash.get("schemaVersion").and_then(Value::as_i64);
    if let Some(v) = version
        && !(MIN_SCHEMA_VERSION..=MAX_SCHEMA_VERSION).contains(&v)
    {
        return Err(format!(
            "schemaVersion {v} is not read; the import reads {MIN_SCHEMA_VERSION} to {MAX_SCHEMA_VERSION}"
        ));
    }
    if dash.get("panels").is_none() && dash.get("rows").is_none() {
        return Err("the JSON has neither panels nor rows; is it a Grafana dashboard?".into());
    }
    let mut inputs = BTreeMap::new();
    for i in input.get("__inputs").or_else(|| dash.get("__inputs")).and_then(Value::as_array).into_iter().flatten() {
        if let (Some(name), Some(label)) = (text(i, "name"), text(i, "label").or_else(|| text(i, "pluginName"))) {
            inputs.insert(name, label);
        }
    }
    let mut c = Converter {
        sources,
        inputs,
        report: Report { items: Vec::new() },
        variables: BTreeMap::new(),
        panel_ids: BTreeSet::new(),
    };
    let title_raw = text(dash, "title").unwrap_or_else(|| "Imported dashboard".into());
    let title = truncate(&title_raw, model::MAX_TITLE_CHARS);
    let mut dashboard_notes = Vec::new();

    let mut variables = Vec::new();
    for v in
        dash.get("templating").and_then(|t| t.get("list")).and_then(Value::as_array).into_iter().flatten().take(100)
    {
        if let Some(v) = c.variable(v) {
            variables.push(v);
        }
    }

    let mut panels: Vec<Value> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    if let Some(list) = dash.get("panels").and_then(Value::as_array) {
        // gridPos layout: a row panel starts a row; the panels after it (or inside it, collapsed)
        // belong to it, placed from its top.
        let pos = |p: &Value, k: &str| p.get("gridPos").and_then(|g| g.get(k)).and_then(Value::as_i64).unwrap_or(0);
        let mut sorted: Vec<&Value> = list.iter().collect();
        sorted.sort_by_key(|p| (pos(p, "y"), pos(p, "x")));
        let mut current_row: Option<(String, i64)> = None;
        let mut index = 0;
        for p in sorted {
            index += 1;
            if text(p, "type").as_deref() == Some("row") {
                let id = format!("row-{}", p.get("id").map_or(index.to_string(), ToString::to_string));
                let row_title = text(p, "title").unwrap_or_default();
                let mut row = json!({ "id": id, "title": truncate(&row_title, 200), "collapsed": p.get("collapsed").and_then(Value::as_bool).unwrap_or(false) });
                let mut notes = Vec::new();
                if let Some(repeat) = text(p, "repeat") {
                    if c.variables.get(&repeat) == Some(&true) {
                        row["repeat"] = json!({ "variable": repeat });
                    } else {
                        notes.push(repeat_dropped(&repeat));
                    }
                }
                c.report.add(ItemKind::Row, named(format!("row \"{row_title}\""), row_title.clone()), notes, false);
                rows.push(row);
                let top = pos(p, "y");
                current_row = Some((id.clone(), top));
                for inner in p.get("panels").and_then(Value::as_array).into_iter().flatten() {
                    index += 1;
                    let grid = (pos(inner, "x"), (pos(inner, "y") - top - 1).max(0), pos(inner, "w"), pos(inner, "h"));
                    if let Some(panel) = c.panel(inner, index, grid, Some(&id)) {
                        panels.push(panel);
                    }
                }
                continue;
            }
            let (row_id, offset) = match &current_row {
                Some((id, top)) => (Some(id.as_str()), top + 1),
                None => (None, 0),
            };
            let grid = (pos(p, "x"), (pos(p, "y") - offset).max(0), pos(p, "w"), pos(p, "h"));
            let row_id = row_id.map(String::from);
            if let Some(panel) = c.panel(p, index, grid, row_id.as_deref()) {
                panels.push(panel);
            }
        }
    } else if let Some(list) = dash.get("rows").and_then(Value::as_array) {
        // The old layout: rows of panels with a width in twelfths (`span`) and a row height in px.
        dashboard_notes.push(note("row_layout", "the old row layout was laid out on the 24-column grid"));
        let mut index = 0;
        for (r, row) in list.iter().enumerate() {
            let height_px = match row.get("height") {
                Some(Value::String(s)) => s.trim_end_matches("px").trim().parse::<f64>().unwrap_or(250.0),
                Some(Value::Number(n)) => n.as_f64().unwrap_or(250.0),
                _ => 250.0,
            };
            let h = ((height_px / LEGACY_ROW_PX).ceil() as i64).clamp(1, 200);
            let row_title = text(row, "title").unwrap_or_default();
            let shown = row.get("showTitle").and_then(Value::as_bool).unwrap_or(false) || list.len() > 1;
            let row_id = shown.then(|| format!("row-{}", r + 1));
            if let Some(id) = &row_id {
                rows.push(json!({ "id": id, "title": truncate(&row_title, 200), "collapsed": row.get("collapse").and_then(Value::as_bool).unwrap_or(false) }));
                c.report.add(
                    ItemKind::Row,
                    named(format!("row \"{row_title}\""), row_title.clone()),
                    Vec::new(),
                    false,
                );
            }
            let (mut x, mut y) = (0i64, 0i64);
            for p in row.get("panels").and_then(Value::as_array).into_iter().flatten() {
                index += 1;
                let span = p.get("span").and_then(Value::as_f64).unwrap_or(12.0);
                let w = ((span * 2.0).round() as i64).clamp(1, 24);
                if x + w > 24 {
                    x = 0;
                    y += h;
                }
                if let Some(panel) = c.panel(p, index, (x, y, w, h), row_id.as_deref()) {
                    panels.push(panel);
                }
                x += w;
            }
        }
    }

    let mut annotations = Vec::new();
    for (i, a) in
        dash.get("annotations").and_then(|a| a.get("list")).and_then(Value::as_array).into_iter().flatten().enumerate()
    {
        if annotations.len() < 20
            && let Some(a) = c.annotation(a, i)
        {
            annotations.push(a);
        }
    }
    let mut links = Vec::new();
    for l in dash.get("links").and_then(Value::as_array).into_iter().flatten().take(50) {
        if let Some(l) = c.link(l) {
            links.push(l);
        }
    }

    let time_obj = dash.get("time").cloned().unwrap_or(Value::Null);
    let (from, from_guessed) = time(time_obj.get("from").and_then(Value::as_str), "now-6h");
    let (to, to_guessed) = time(time_obj.get("to").and_then(Value::as_str), "now");
    if from_guessed || to_guessed {
        dashboard_notes.push(note("time_range", "the time range could not be read and is the last 6 hours"));
    }
    let mut out = json!({
        "schemaVersion": model::SCHEMA_VERSION,
        "title": title,
        "timeRange": { "from": from, "to": to },
        "variables": variables,
        "panels": panels,
        "rows": rows,
        "annotations": annotations,
        "links": links,
    });
    let mut tags: Vec<String> = Vec::new();
    for tag in dash.get("tags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let tag = tag.trim();
        if !tag.is_empty()
            && tag.chars().count() <= 50
            && !tags.iter().any(|t| t.eq_ignore_ascii_case(tag))
            && tags.len() < 20
        {
            tags.push(tag.to_string());
        }
    }
    out["tags"] = json!(tags);
    if let Some(r) = text(dash, "refresh") {
        match seconds(&r).filter(|s| (5..=86_400).contains(s)) {
            Some(s) => out["refreshSeconds"] = json!(s),
            None => dashboard_notes.push(
                note("refresh", format!("the refresh {r} is outside 5 seconds to a day and was dropped"))
                    .with("refresh", &r),
            ),
        }
    }
    match text(dash, "timezone").as_deref() {
        None | Some("") => {}
        Some("browser") => out["timeZone"] = json!("browser"),
        Some("utc") => out["timeZone"] = json!("UTC"),
        Some(zone) if zone.parse::<chrono_tz::Tz>().is_ok() => out["timeZone"] = json!(zone),
        Some(zone) => dashboard_notes
            .push(note("time_zone", format!("the time zone {zone} is not known and was dropped")).with("zone", zone)),
    }
    if let Some(day) = text(dash, "weekStart").filter(|d| ["monday", "sunday", "saturday"].contains(&d.as_str())) {
        out["weekStart"] = json!(day);
    }
    if let Some(month) = dash.get("fiscalYearStartMonth").and_then(Value::as_u64).filter(|m| (1..=11).contains(m)) {
        out["fiscalYearStartMonth"] = json!(month + 1);
    }
    let picker = dash.get("timepicker").cloned().unwrap_or(Value::Null);
    if let Some(delay) = text(&picker, "nowDelay") {
        if model::is_duration(&delay) && delay.ends_with(['s', 'm', 'h', 'd']) {
            out["nowDelay"] = json!(delay);
        } else {
            dashboard_notes.push(note("now_delay", format!("the now delay {delay} was dropped")).with("delay", &delay));
        }
    }
    let mut intervals: Vec<u32> = picker
        .get("refresh_intervals")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(seconds)
        .filter(|s| (5..=86_400).contains(s))
        .collect();
    intervals.sort_unstable();
    intervals.dedup();
    intervals.truncate(20);
    if !intervals.is_empty() {
        out["refreshIntervals"] = json!(intervals);
    }
    match dash.get("graphTooltip").and_then(Value::as_i64) {
        Some(1) => out["sharedCursor"] = json!("crosshair"),
        Some(2) => out["sharedCursor"] = json!("tooltip"),
        _ => {}
    }
    if dash.get("panels").is_none() && dash.get("rows").is_some() {
        // reported above
    }
    c.report.items.insert(
        0,
        ImportItem {
            kind: ItemKind::Dashboard,
            name: format!("dashboard \"{title_raw}\""),
            title: Some(title.clone()),
            status: if dashboard_notes.is_empty() { ItemStatus::Converted } else { ItemStatus::Approximated },
            notes: dashboard_notes,
        },
    );

    // The result goes through the same checks as every save.
    let parsed =
        model::parse(out).map_err(|e| format!("the converted dashboard does not pass Kalzit's checks: {e}"))?;
    model::check_panel_options(&parsed, None)
        .map_err(|(panel, e)| format!("the converted panel {panel} does not pass Kalzit's checks: {e}"))?;
    let model = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
    let mut counts = ImportCounts::default();
    for item in &c.report.items {
        match item.status {
            ItemStatus::Converted => counts.converted += 1,
            ItemStatus::Approximated => counts.approximated += 1,
            ItemStatus::Skipped => counts.skipped += 1,
        }
    }
    Ok(Conversion {
        model,
        report: ImportReport {
            source: "grafana".into(),
            source_version: version,
            title: title_raw,
            items: c.report.items,
            counts,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sources() -> BTreeMap<String, SourceTarget> {
        let mut m = BTreeMap::new();
        m.insert("prom-uid".into(), SourceTarget { id: "ds-prom".into(), kind: "prometheus".into() });
        m.insert("Postgres".into(), SourceTarget { id: "ds-pg".into(), kind: "postgres".into() });
        m.insert("DS_PROMETHEUS".into(), SourceTarget { id: "ds-prom".into(), kind: "prometheus".into() });
        m
    }

    fn item<'a>(r: &'a ImportReport, name: &str) -> &'a ImportItem {
        r.items.iter().find(|i| i.name.contains(name)).unwrap_or_else(|| panic!("no item {name}: {:#?}", r.items))
    }

    #[test]
    fn transformations_become_steps_and_the_rest_is_reported() {
        let dash = json!({
            "schemaVersion": 39,
            "title": "Steps",
            "panels": [{
                "id": 1, "type": "table", "title": "T", "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
                "datasource": { "uid": "Postgres" },
                "targets": [{ "refId": "A", "rawSql": "select 1" }, { "refId": "B", "rawSql": "select 2" }],
                "transformations": [
                    { "id": "merge", "options": {} },
                    { "id": "organize", "options": {
                        "excludeByName": { "secret": true, "kept": false },
                        "indexByName": { "b": 1, "a": 0 },
                        "renameByName": { "a": "Alpha", "b": "" } } },
                    { "id": "filterFieldsByName", "options": { "include": { "names": ["Alpha"], "pattern": "/^c/" } } },
                    { "id": "filterFieldsByName", "options": { "include": { "pattern": "/^c/i" } } },
                    { "id": "filterByValue", "options": { "type": "exclude", "match": "all", "filters": [
                        { "fieldName": "Alpha", "config": { "id": "greater", "options": { "value": 5 } } },
                        { "fieldName": "Alpha", "config": { "id": "range", "options": { "from": 1, "to": 9 } } },
                        { "fieldName": "c", "config": { "id": "isNull", "options": {} } },
                        { "fieldName": "c", "config": { "id": "substring", "options": { "value": "x" } } } ] } },
                    { "id": "limit", "options": { "limitField": 20 }, "disabled": true },
                    { "id": "convertFieldType", "options": { "conversions": [
                        { "targetField": "t", "destinationType": "time", "dateFormat": "DD.MM.YYYY" },
                        { "targetField": "u", "destinationType": "time", "dateFormat": "MMM Do" },
                        { "targetField": "e", "destinationType": "enum" } ] } },
                    { "id": "reduce", "options": { "mode": "reduceFields", "reducers": ["lastNotNull", "p95", "mean", "last", "stdDev", "range"] } },
                    { "id": "seriesToRows", "options": {} },
                    { "id": "calculateField", "options": {} }
                ]
            }]
        });
        let out = convert(&dash, &sources()).unwrap();
        let panel = &out.model["panels"][0];
        let steps = panel["transformations"].as_array().unwrap();
        let types: Vec<&str> = steps.iter().map(|s| s["type"].as_str().unwrap()).collect();
        assert_eq!(
            types,
            ["stack", "organize", "filterFields", "filterRows", "limit", "convert", "reduceSeries", "seriesToRows"]
        );
        assert_eq!(steps[0]["frames"], json!(["A", "B"]));
        assert_eq!(steps[1]["order"], json!(["a", "b"]));
        assert_eq!(steps[1]["hide"], json!(["secret"]));
        assert_eq!(steps[1]["rename"], json!({ "a": "Alpha" }));
        assert_eq!(
            steps[2],
            json!({ "id": "g3", "type": "filterFields", "frame": "A", "mode": "keep",
                                     "names": ["Alpha"], "pattern": "^c" })
        );
        assert_eq!(steps[3]["mode"], "drop");
        assert_eq!(steps[3]["match"], "all");
        assert_eq!(
            steps[3]["conditions"],
            json!([{ "field": "Alpha", "op": "gt", "value": 5 },
                   { "field": "Alpha", "op": "between", "value": 1, "to": 9 },
                   { "field": "c", "op": "empty" }])
        );
        assert_eq!(steps[4]["disabled"], true);
        assert_eq!(
            steps[5]["conversions"],
            json!([{ "field": "t", "to": "time", "format": "DD.MM.YYYY" },
                                                   { "field": "u", "to": "time" }])
        );
        assert_eq!(steps[6]["calculations"], json!(["last", "p95", "mean", "lastRow", "stddev"]));
        assert_eq!(steps[6]["mode"], "columns");
        let codes: Vec<&str> = item(&out.report, "panel 1 \"T\"").notes.iter().map(|n| n.code.as_str()).collect();
        for code in [
            "step_merge",
            "step_matcher",
            "step_time_format",
            "step_conversion",
            "step_reducer",
            "step_dropped",
            "step_reducer_row",
            "step_reducer_sample",
            "step_pattern_flags",
        ] {
            assert!(codes.contains(&code), "{code}: {codes:?}");
        }
        // After the merge every step works on the one table left.
        assert!(!codes.contains(&"step_first_query"), "{codes:?}");
        // The converted dashboard passes the model's checks, steps included.
        crate::dashboards::model::parse(out.model.clone()).unwrap();
        // In order, every step reads only queries no earlier step used up.
        let mut alive: BTreeSet<String> = ["A".to_string(), "B".to_string()].into();
        for raw in steps {
            let step = crate::analysis::parse_step(raw).unwrap();
            let frames = step.kind.frames();
            assert!(frames.iter().all(|f| alive.contains(*f)), "{raw} reads a used-up query");
            if matches!(
                step.kind,
                crate::analysis::StepKind::Stack { .. } | crate::analysis::StepKind::SeriesToRows { .. }
            ) {
                for f in &frames[1..] {
                    alive.remove(*f);
                }
            }
        }
        assert_eq!(steps[7]["frames"], json!(["A"]));
    }

    #[test]
    fn name_patterns_match_as_in_grafana_and_bad_regexes_cost_only_their_condition() {
        let panel = |transformations: Value| {
            let dash = json!({
                "schemaVersion": 39, "title": "P",
                "panels": [{
                    "id": 1, "type": "table", "title": "T", "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
                    "datasource": { "uid": "Postgres" },
                    "targets": [{ "refId": "A", "rawSql": "select 1" }],
                    "transformations": transformations
                }]
            });
            let out = convert(&dash, &sources()).unwrap();
            let steps = out.model["panels"][0]["transformations"].as_array().cloned().unwrap_or_default();
            let notes = item(&out.report, "panel 1 \"T\"").notes.clone();
            (steps, notes)
        };
        // A pattern without slashes matches the whole name, the slash form anywhere.
        let (steps, _) = panel(json!([
            { "id": "filterFieldsByName", "options": { "include": { "pattern": "cpu" } } },
            { "id": "filterFieldsByName", "options": { "include": { "pattern": "/cpu/" } } }
        ]));
        assert_eq!(steps[0]["pattern"], "^cpu$");
        assert_eq!(steps[1]["pattern"], "cpu");
        let frame: crate::shapes::Frame = serde_json::from_value(json!({ "fields": [
            { "name": "cpu", "type": "number", "values": [1] },
            { "name": "cpu_user", "type": "number", "values": [2] } ] }))
        .unwrap();
        let kept = |pattern: &str| {
            let out =
                crate::analysis::table::filter_fields(&frame, crate::analysis::KeepDrop::Keep, &[], Some(pattern))
                    .unwrap();
            out.fields().iter().map(|f| f.name.clone()).collect::<Vec<_>>()
        };
        assert_eq!(kept(steps[0]["pattern"].as_str().unwrap()), ["cpu"]);
        assert_eq!(kept(steps[1]["pattern"].as_str().unwrap()), ["cpu", "cpu_user"]);
        // A name pattern Kalzit cannot read leaves the step out and names the pattern.
        let (steps, notes) = panel(json!([
            { "id": "filterFieldsByName", "options": { "include": { "pattern": "/\\d+/" } } }
        ]));
        assert!(steps.is_empty());
        assert!(notes.iter().any(|n| n.code == "step_pattern" && n.params["pattern"] == "/\\d+/"), "{notes:?}");
        // A condition with an unreadable regex goes alone; the step goes when none is left.
        let long = format!("(a|b)+{}", "x".repeat(100));
        let (steps, notes) = panel(json!([
            { "id": "filterByValue", "options": { "type": "include", "match": "any", "filters": [
                { "fieldName": "a", "config": { "id": "regex", "options": { "value": "\\d+" } } },
                { "fieldName": "a", "config": { "id": "regex", "options": { "value": long } } },
                { "fieldName": "a", "config": { "id": "regex", "options": { "value": "^x" } } } ] } },
            { "id": "filterByValue", "options": { "type": "include", "match": "any", "filters": [
                { "fieldName": "a", "config": { "id": "regex", "options": { "value": "(a|aa)+" } } } ] } }
        ]));
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["conditions"], json!([{ "field": "a", "op": "matches", "value": "^x" }]));
        let bad: Vec<&str> =
            notes.iter().filter(|n| n.code == "step_condition_pattern").map(|n| n.params["pattern"].as_str()).collect();
        assert_eq!(bad.len(), 3, "{notes:?}");
        assert_eq!(bad[0], "\\d+");
        assert_eq!(bad[1].chars().count(), 80);
        assert!(bad[1].ends_with('\u{2026}'));
        assert!(notes.iter().any(|n| n.code == "step_empty"), "{notes:?}");
    }

    #[test]
    fn plain_variables_take_kalzit_syntax() {
        let mut notes = Vec::new();
        assert_eq!(plain_variables("a [[host]] b ${env} c", &mut notes), "a $host b $env c");
        assert!(notes.is_empty());
        assert_eq!(plain_variables("x ${host:csv}", &mut notes), "x $host");
        assert_eq!(notes.len(), 1);
        let mut notes = Vec::new();
        assert_eq!(
            sql_query("WHERE $__timeFilter(t) AND t < $__timeTo()", &mut notes),
            "WHERE $__timeFilter(t) AND t < $__timeTo"
        );
        assert!(notes.is_empty());
        sql_query("SELECT $__timeGroup(t, '1m')", &mut notes);
        assert_eq!(notes[0].code, "sql_macro");
        assert_eq!(notes[0].params["macro"], "$__timeGroup");
        assert!(notes[0].text.contains("$__timeGroup"), "{notes:?}");
    }

    #[test]
    fn newer_and_unknown_formats_are_refused() {
        let none = BTreeMap::new();
        assert!(convert(&json!({ "elements": {}, "layout": {} }), &none).unwrap_err().contains("v2"));
        assert!(
            convert(&json!({ "schemaVersion": 99, "panels": [] }), &none).unwrap_err().contains("schemaVersion 99")
        );
        assert!(convert(&json!({ "title": "x" }), &none).is_err());
        assert!(convert(&json!([1]), &none).is_err());
    }

    #[test]
    fn rows_place_their_panels_from_their_top() {
        let input = json!({
            "schemaVersion": 39, "title": "Rows",
            "panels": [
                { "id": 1, "type": "stat", "title": "Top", "gridPos": { "x": 0, "y": 0, "w": 6, "h": 4 },
                  "datasource": { "type": "prometheus", "uid": "prom-uid" }, "targets": [{ "refId": "A", "expr": "up" }] },
                { "id": 2, "type": "row", "title": "Details", "collapsed": false, "gridPos": { "x": 0, "y": 4, "w": 24, "h": 1 } },
                { "id": 3, "type": "timeseries", "title": "In row", "gridPos": { "x": 0, "y": 5, "w": 30, "h": 8 },
                  "datasource": { "type": "prometheus", "uid": "prom-uid" }, "targets": [{ "refId": "A", "expr": "rate(x[5m])" }] },
                { "id": 4, "type": "row", "title": "Closed", "collapsed": true, "gridPos": { "x": 0, "y": 13, "w": 24, "h": 1 },
                  "panels": [
                    { "id": 5, "type": "text", "title": "Note", "gridPos": { "x": 0, "y": 16, "w": 12, "h": 3 },
                      "options": { "mode": "markdown", "content": "# Hi" } }
                  ] }
            ]
        });
        let c = convert(&input, &sources()).unwrap();
        let panels = c.model["panels"].as_array().unwrap();
        assert_eq!(panels.len(), 3);
        assert!(panels[0].get("rowId").is_none());
        assert_eq!(panels[1]["rowId"], "row-2");
        assert_eq!(panels[1]["grid"], json!({ "x": 0, "y": 0, "w": 24, "h": 8 }));
        assert_eq!(panels[2]["rowId"], "row-4");
        assert_eq!(panels[2]["grid"]["y"], 2);
        assert_eq!(c.model["rows"][1]["collapsed"], true);
        assert_eq!(item(&c.report, "panel 3 \"In row\"").status, ItemStatus::Approximated);
    }

    #[test]
    fn items_carry_their_title_and_notes_their_code() {
        let input = json!({
            "schemaVersion": 39, "title": "Codes",
            "annotations": { "list": [{ "datasource": { "type": "prometheus", "uid": "elsewhere" } }] }, "timezone": "Mars/Base", "time": { "from": "now-1h", "to": "now" },
            "panels": [
                { "id": 1, "type": "row", "title": "Details", "gridPos": { "x": 0, "y": 0, "w": 24, "h": 1 } },
                { "id": 2, "type": "worldmap", "title": "Sites", "gridPos": { "x": 0, "y": 1, "w": 6, "h": 4 } },
                { "id": 3, "type": "stat", "title": "Up", "gridPos": { "x": 6, "y": 1, "w": 6, "h": 4 },
                  "datasource": { "type": "prometheus", "uid": "elsewhere" }, "targets": [{ "refId": "B", "expr": "up" }] }
            ]
        });
        let c = convert(&input, &sources()).unwrap();
        let dashboard = item(&c.report, "dashboard \"Codes\"");
        assert_eq!(dashboard.title.as_deref(), Some("Codes"));
        assert_eq!(dashboard.notes[0].code, "time_zone");
        assert_eq!(dashboard.notes[0].params["zone"], "Mars/Base");
        assert_eq!(item(&c.report, "row \"Details\"").title.as_deref(), Some("Details"));
        let sites = item(&c.report, "panel 2 \"Sites\"");
        assert_eq!(sites.title.as_deref(), Some("Sites"));
        assert_eq!(sites.notes[0].code, "panel_type");
        assert_eq!(sites.notes[0].params["type"], "worldmap");
        let annotation = item(&c.report, "annotation annotation 1");
        assert_eq!(annotation.title.as_deref(), Some(""));
        assert_eq!(c.model["annotations"].as_array().map_or(0, Vec::len), 0);
        let query = item(&c.report, "query B of panel \"Up\"");
        assert_eq!(query.title.as_deref(), Some("Up · B"));
        assert_eq!(query.notes[0].code, "no_mapping");
        assert_eq!(query.notes[0].params["source"], "elsewhere");
        let note = options_default("options.lineWidth must be 1 to 3");
        assert_eq!(note.code, "options_default_field");
        assert_eq!(note.params["field"], "options.lineWidth");
        assert!(note.text.contains("must be 1 to 3"), "{note:?}");
        assert_eq!(options_default("invalid type: string").code, "options_default");
        // Reports stored by an older server: plain notes and no title.
        let old: ImportItem = serde_json::from_value(
            json!({ "kind": "panel", "name": "panel 1 \"A\"", "status": "skipped", "notes": ["why"] }),
        )
        .unwrap();
        assert_eq!(old.title, None);
        assert_eq!(old.notes, vec![super::note("", "why")]);
    }
}
