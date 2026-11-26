//! Converts a Grafana dashboard (their public JSON format, `schemaVersion` 6 to 41 with the old
//! `rows` layout below 16 and `gridPos` from 16 on) to a Kalzit dashboard model, with a report per
//! item: converted, approximated (and what changed) or skipped (and why). Clean-room: written from
//! the published format only. Nothing runs and nothing is contacted: data sources are mapped by
//! the caller, from a Grafana data source's uid or name to a Kalzit data source and its kind.
//! Skipped panels are left out, not kept as empty placeholders (docs/guide/grafana-import.md).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::dashboards::model::{self, MAX_VARIABLE_TEXT_CHARS};
use crate::dashboards::variables::{ALL, OptionRegex};

mod fields;
pub mod stored_units;

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
        // Parameters name what the file holds: short and on one line, whatever it holds.
        self.params.insert(key.into(), truncate(&value.to_string(), 80));
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
    ImportNote { code: code.into(), params: BTreeMap::new(), text: truncate(&text.into(), 400) }
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
const SQL_MACROS: &[&str] = &[
    "__timeFilter",
    "__timeFrom",
    "__timeTo",
    "__interval",
    "__interval_ms",
    "__time",
    "__timeEpoch",
    "__timeGroup",
    "__timeGroupAlias",
    "__unixEpochFilter",
    "__unixEpochNanoFilter",
    "__unixEpochFrom",
    "__unixEpochTo",
    "__unixEpochNanoFrom",
    "__unixEpochNanoTo",
    "__unixEpochGroup",
    "__unixEpochGroupAlias",
];

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

    /// The panel's converted queries, and the series name templates (`legendFormat`) of the
    /// Prometheus and Loki ones among them.
    fn targets(&mut self, panel: &Value, title: &str) -> (Vec<Value>, Vec<String>) {
        let panel_source = panel.get("datasource");
        let mut out = Vec::new();
        let mut legends = Vec::new();
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
                    if matches!(target.kind.as_str(), "prometheus" | "loki")
                        && let Some(legend) = text(t, "legendFormat").filter(|l| l != "__auto")
                    {
                        legends.push(legend);
                    }
                    out.push(q);
                    self.report.add(ItemKind::Query, name, notes, false);
                }
                Err(why) => self.report.add(ItemKind::Query, name, vec![why], true),
            }
        }
        (out, legends)
    }

    /// The panel's field options (`fieldConfig`) in Kalzit's form, as far as its type shows them.
    /// `renamed` holds the display names an organize step gives, by own column name.
    fn field_config(
        kind: &str,
        panel: &Value,
        renamed: &BTreeMap<String, String>,
        notes: &mut Vec<ImportNote>,
    ) -> Value {
        let f = fields::Fields { kind, groups: fields::groups(kind) };
        if !f.groups.frame {
            return json!({});
        }
        let config = panel.get("fieldConfig").cloned().unwrap_or(Value::Null);
        let mut defaults = config.get("defaults").map(|d| f.defaults(d, notes)).unwrap_or_default();
        // The heatmap's value axis unit is the unit of its bucket bounds.
        if kind == "heatmap"
            && !defaults.contains_key("unit")
            && let Some(u) = panel.pointer("/options/yAxis/unit").and_then(Value::as_str).filter(|u| !u.is_empty())
            && let Some(u) = fields::unit(u, notes)
        {
            defaults.insert("unit".into(), json!(u));
        }
        // A bar chart coloured by a palette ignores its thresholds in Grafana; here they would
        // colour the bars, so they go unless the colours come from them.
        let color_mode = config.pointer("/defaults/color/mode").and_then(Value::as_str).unwrap_or("");
        if kind == "bar"
            && !color_mode.is_empty()
            && color_mode != "thresholds"
            && !color_mode.starts_with("continuous-")
        {
            defaults.remove("thresholds");
        }
        let raw = config.get("overrides").and_then(Value::as_array).cloned().unwrap_or_default();
        // Grafana's overrides match the new names; Kalzit matches a column's own name.
        let own_names: BTreeMap<String, String> =
            renamed.iter().map(|(own, shown)| (shown.clone(), own.clone())).collect();
        let mut overrides = f.overrides(&raw, &own_names, notes);
        // An organize step's display names become each column's display name, beside what an
        // override already sets for it.
        for (own, shown) in renamed {
            let room = overrides.len() < crate::dashboards::panel_options::MAX_OVERRIDES;
            match overrides.iter_mut().find(|o| o["matcher"] == json!({ "type": "name", "value": own })) {
                Some(o) => {
                    if o["properties"].get("displayName").is_none() {
                        o["properties"]["displayName"] = json!(shown);
                    }
                }
                None if room => overrides.push(json!({
                    "matcher": { "type": "name", "value": own },
                    "properties": { "displayName": shown },
                })),
                None => {}
            }
        }
        let mut out = json!({ "defaults": defaults });
        if !overrides.is_empty() {
            out["overrides"] = json!(overrides);
        }
        out
    }

    /// The first calculation of `reduceOptions.calcs`, as Kalzit's reducer; one without a
    /// counterpart is reported and the panel keeps its default.
    fn reducer(options: &Value, notes: &mut Vec<ImportNote>) -> Option<&'static str> {
        let calc = options.get("reduceOptions")?.get("calcs")?.as_array()?.first()?.as_str()?;
        let reducer = match calc {
            "lastNotNull" | "last" => Some("last"),
            "mean" => Some("mean"),
            "min" => Some("min"),
            "max" => Some("max"),
            "sum" => Some("sum"),
            _ => None,
        };
        if reducer.is_none() {
            notes.push(
                note("reducer", format!("the calculation {calc} has no counterpart; the panel uses its default"))
                    .with("calc", calc),
            );
        }
        reducer
    }

    /// The legend (`with_values`: the panel shows last, min, max and mean in it).
    fn legend(o: &Value, with_values: bool, notes: &mut Vec<ImportNote>) -> Option<Value> {
        let legend = o.get("legend").filter(|l| l.is_object())?;
        let mode = match text(legend, "displayMode").as_deref() {
            Some("table") => "table",
            Some("hidden") => "hidden",
            _ => "list",
        };
        let shown = legend.get("showLegend").and_then(Value::as_bool) != Some(false);
        let placement = if text(legend, "placement").as_deref() == Some("right") { "right" } else { "bottom" };
        let mut out = json!({ "mode": if shown { mode } else { "hidden" }, "placement": placement });
        let mut values = Vec::new();
        let mut other = Vec::new();
        for calc in legend.get("calcs").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let value = match calc {
                "lastNotNull" | "last" => Some("last"),
                "min" => Some("min"),
                "max" => Some("max"),
                "mean" => Some("mean"),
                _ => None,
            };
            match value.filter(|_| with_values) {
                Some(v) if !values.contains(&v) => values.push(v),
                Some(_) => {}
                None => other.push(calc),
            }
        }
        if !values.is_empty() {
            out["values"] = json!(values);
        }
        if !other.is_empty() {
            let list = other.join(", ");
            notes.push(
                note("legend_calcs", format!("the legend values {list} have no counterpart here and were dropped"))
                    .with("calcs", list),
            );
        }
        Some(out)
    }

    fn tooltip(o: &Value, notes: &mut Vec<ImportNote>) -> Option<Value> {
        let tooltip = o.get("tooltip").filter(|t| t.is_object())?;
        if text(tooltip, "sort").is_some_and(|s| s != "none") {
            notes.push(note("tooltip_sort", "the tooltip's sort order is not taken over"));
        }
        let mode = match text(tooltip, "mode").as_deref() {
            Some("multi") => "all",
            Some("none") => "hidden",
            Some("single") => "single",
            _ => return None,
        };
        Some(json!({ "mode": mode }))
    }

    /// The panel's options in Kalzit's form, as far as they have one. `legends` are the series
    /// name templates of its queries.
    fn options(kind: &str, panel: &Value, legends: &[String], notes: &mut Vec<ImportNote>) -> Value {
        let o = panel.get("options").cloned().unwrap_or(Value::Null);
        let mut out = Map::new();
        let pick = |v: Option<&str>, allowed: &[&str]| v.filter(|v| allowed.contains(v)).map(|v| json!(v));
        if matches!(kind, "timeseries" | "bar" | "piechart" | "histogram" | "state-timeline" | "status-history")
            && let Some(l) = Self::legend(&o, matches!(kind, "timeseries" | "bar"), notes)
        {
            out.insert("legend".into(), l);
        }
        if matches!(
            kind,
            "timeseries" | "bar" | "piechart" | "histogram" | "heatmap" | "state-timeline" | "status-history"
        ) && let Some(t) = Self::tooltip(&o, notes)
        {
            out.insert("tooltip".into(), t);
        }
        let mut templates: Vec<&String> = Vec::new();
        for l in legends {
            if !templates.contains(&l) {
                templates.push(l);
            }
        }
        if kind == "timeseries" {
            // One template names every series; with several, the first with a label in it.
            if let Some(first) = templates.iter().find(|t| t.contains("{{")).or(templates.first()) {
                out.insert("seriesName".into(), json!(truncate(first, 200)));
                if templates.len() > 1 {
                    notes.push(
                        note(
                            "legend_format_mixed",
                            format!("its queries name series differently; the template {first} names them all"),
                        )
                        .with("template", first.as_str()),
                    );
                }
            }
        } else if !templates.is_empty() {
            notes.push(note(
                "legend_format",
                "the legend format is only taken over on time series; series keep their label names here",
            ));
        }
        match kind {
            "stat" => {
                if let Some(r) = Self::reducer(&o, notes) {
                    out.insert("reducer".into(), json!(r));
                }
                let color_mode = match o.get("colorMode").and_then(Value::as_str) {
                    Some("background" | "background_solid") => Some("background"),
                    Some(m @ ("none" | "value")) => Some(m),
                    _ => None,
                };
                if let Some(m) = color_mode {
                    out.insert("colorMode".into(), json!(m));
                }
                if let Some(v) = pick(o.get("graphMode").and_then(Value::as_str), &["none", "area"]) {
                    out.insert("graphMode".into(), v);
                }
                let text_mode = match o.get("textMode").and_then(Value::as_str) {
                    Some("value_and_name" | "valueAndName") => Some("valueAndName"),
                    Some(m @ ("auto" | "value" | "name")) => Some(m),
                    Some("none") => {
                        notes.push(note("stat_text_none", "the stat panel without text shows its value"));
                        None
                    }
                    _ => None,
                };
                if let Some(m) = text_mode {
                    out.insert("textMode".into(), json!(m));
                }
            }
            "gauge" => {
                if let Some(r) = Self::reducer(&o, notes) {
                    out.insert("reducer".into(), json!(r));
                }
                if let Some(b) = o.get("showThresholdMarkers").and_then(Value::as_bool) {
                    out.insert("showThresholdMarkers".into(), json!(b));
                }
            }
            "bargauge" => {
                if let Some(r) = Self::reducer(&o, notes) {
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
                if let Some(v) = pick(o.get("valueMode").and_then(Value::as_str), &["text", "color", "hidden"]) {
                    out.insert("valueDisplay".into(), v);
                }
                if let Some(v) = pick(o.get("namePlacement").and_then(Value::as_str), &["left", "top", "hidden"]) {
                    out.insert("namePlacement".into(), v);
                }
            }
            "piechart" => {
                if let Some(v) = pick(o.get("pieType").and_then(Value::as_str), &["pie", "donut"]) {
                    out.insert("pieType".into(), v);
                }
                if let Some(r) = Self::reducer(&o, notes) {
                    out.insert("reducer".into(), json!(r));
                }
                let mut values: Vec<&str> = Vec::new();
                for v in o.pointer("/legend/values").and_then(Value::as_array).into_iter().flatten() {
                    if let Some(v) = v.as_str().filter(|v| ["value", "percent"].contains(v) && !values.contains(v)) {
                        values.push(v);
                    }
                }
                if !values.is_empty() {
                    out.insert("legendValues".into(), json!(values));
                }
            }
            "bar" => {
                match o.get("showValue").and_then(Value::as_str) {
                    Some("always") => {
                        out.insert("showValues".into(), json!(true));
                    }
                    Some("never") => {
                        out.insert("showValues".into(), json!(false));
                    }
                    _ => {}
                }
                if o.get("orientation").and_then(Value::as_str) == Some("horizontal") {
                    notes.push(note(
                        "bar_orientation",
                        "horizontal bars became upright ones; Kalzit's bar chart has no horizontal form yet",
                    ));
                }
                if o.get("stacking").and_then(Value::as_str).is_some_and(|s| s != "none") {
                    notes.push(note("bar_stacking", "stacked bars became bars side by side"));
                }
            }
            "histogram" => {
                if let Some(n) = o.get("bucketCount").and_then(Value::as_u64) {
                    out.insert("bucketCount".into(), json!(n.clamp(2, 200)));
                }
                if let Some(size) = o.get("bucketSize").and_then(Value::as_f64).filter(|s| *s > 0.0) {
                    out.insert("bucketSize".into(), json!(size));
                }
                if let Some(b) = o.get("combine").and_then(Value::as_bool) {
                    out.insert("combine".into(), json!(b));
                }
            }
            "heatmap" => Self::heatmap(&o, &mut out, notes),
            "table" => {
                if panel.pointer("/fieldConfig/defaults/custom/filterable").and_then(Value::as_bool) == Some(true) {
                    out.insert("columnFilters".into(), json!(true));
                }
                if let Some(footer) = Self::table_footer(&o, notes) {
                    out.insert("footer".into(), footer);
                }
                if o.get("sortBy").and_then(Value::as_array).is_some_and(|s| !s.is_empty()) {
                    notes.push(note("table_sort", "the table's starting sort order is not taken over"));
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

    /// A table's footer (`options.footer`): its first calculation, for the fields it names, or
    /// for every number column when it names none. Grafana's names map to Kalzit's; where the
    /// two calculate differently (a counter-aware delta, population against sample spread, a
    /// row count against a count per number column) the footer is kept and a note says so.
    fn table_footer(o: &Value, notes: &mut Vec<ImportNote>) -> Option<Value> {
        let footer = o.get("footer")?;
        if footer.get("show").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        let reducers: Vec<&str> =
            footer.get("reducer").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
        if reducers.len() > 1 {
            notes.push(note("footer_calcs", "the table footer keeps its first calculation only"));
        }
        let approximated = |notes: &mut Vec<ImportNote>, grafana: &str, kalzit: &str| {
            notes.push(
                note(
                    "footer_approximated",
                    format!("the table footer's {grafana} became {kalzit}, which calculates slightly differently"),
                )
                .with("grafana", grafana)
                .with("kalzit", kalzit),
            );
        };
        let calc: String = if footer.get("countRows").and_then(Value::as_bool) == Some(true) {
            // Grafana counts the rows once; Kalzit counts the values of each number column.
            approximated(notes, "countRows", "count");
            "count".into()
        } else {
            match reducers.first().copied() {
                Some("lastNotNull") => "last".into(),
                Some("last") => "lastRow".into(),
                Some("firstNotNull") => "first".into(),
                Some("first") => "firstRow".into(),
                Some("distinctCount") => "distinct".into(),
                Some("diff") => "delta".into(),
                Some("diffperc") => "deltaPercent".into(),
                Some(r @ ("sum" | "mean" | "min" | "max" | "count" | "range" | "median")) => r.into(),
                // Grafana's delta adds up the increases of a counter, across resets.
                Some("delta") => {
                    approximated(notes, "delta", "delta");
                    "delta".into()
                }
                // Grafana's spread is the population one, Kalzit's the sample one (n - 1).
                Some("stdDev") => {
                    approximated(notes, "stdDev", "stddev");
                    "stddev".into()
                }
                Some("variance") => {
                    approximated(notes, "variance", "variance");
                    "variance".into()
                }
                Some(p)
                    if p.strip_prefix('p').is_some_and(|n| {
                        !n.starts_with('0') && n.parse::<u8>().is_ok_and(|n| (1..=99).contains(&n))
                    }) =>
                {
                    p.into()
                }
                _ => {
                    notes
                        .push(note("footer_calc", "the table footer’s calculation has no counterpart and was dropped"));
                    return None;
                }
            }
        };
        let fields: Vec<String> = match footer.get("fields") {
            Some(Value::Array(names)) => names.iter().filter_map(Value::as_str).map(str::to_string).take(100).collect(),
            _ => Vec::new(),
        };
        let mut out = json!({ "show": true, "over": "all", "columns": [] });
        if fields.is_empty() {
            out["numbers"] = json!(calc);
        } else {
            out["columns"] = fields
                .iter()
                .filter(|f| !f.is_empty() && f.chars().count() <= 200 && !f.chars().any(char::is_control))
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .map(|f| json!({ "column": f, "calc": calc }))
                .collect();
        }
        Some(out)
    }

    /// The heatmap: whether it counts values into buckets or reads buckets, their counts, and
    /// its colour scale.
    fn heatmap(o: &Value, out: &mut Map<String, Value>, notes: &mut Vec<ImportNote>) {
        // Before the `calculate` switch the heatmap counted (`dataFormat: timeseries`) unless it
        // read buckets (`tsbuckets`).
        let calculate = match o.get("calculate").and_then(Value::as_bool) {
            Some(c) => c,
            None => o.get("dataFormat").and_then(Value::as_str) != Some("tsbuckets"),
        };
        out.insert("mode".into(), json!(if calculate { "calculate" } else { "buckets" }));
        if calculate {
            let mut sized = false;
            for (axis, max) in [("xBuckets", 200), ("yBuckets", 100)] {
                let Some(b) = o.pointer(&format!("/calculation/{axis}")) else { continue };
                let value =
                    b.get("value").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())));
                match (text(b, "mode").as_deref(), value) {
                    (Some("count") | None, Some(n)) => {
                        out.insert(axis.into(), json!(n.clamp(2, max)));
                    }
                    (Some("size"), Some(_)) => sized = true,
                    _ => {}
                }
                if b.pointer("/scale/type").and_then(Value::as_str).is_some_and(|s| s == "log") {
                    sized = true;
                }
            }
            if sized {
                notes.push(note(
                    "heatmap_buckets",
                    "bucket sizes and log buckets are not taken over; the heatmap uses bucket counts",
                ));
            }
        }
        let color_mode = o.pointer("/color/mode").and_then(Value::as_str);
        if o.pointer("/color/scale").and_then(Value::as_str) == Some("exponential") {
            out.insert("scale".into(), json!("sqrt"));
            let exponent = o.pointer("/color/exponent").and_then(Value::as_f64).unwrap_or(0.5);
            if (exponent - 0.5).abs() > 0.05 {
                notes.push(note("heatmap_scale", "the heatmap's colour scale became the square root one"));
            }
        }
        let scheme = match color_mode {
            Some("opacity") => Some("opacity".to_string()),
            Some("scheme") => text(o.get("color").unwrap_or(&Value::Null), "scheme"),
            _ => None,
        };
        if let Some(scheme) = scheme {
            notes.push(
                note("heatmap_colors", format!("the colours {scheme} became Kalzit's heat colours"))
                    .with("scheme", scheme),
            );
        }
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
            "heatmap" => "heatmap",
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
        let (targets, legends) = if kind == "text" { (Vec::new(), Vec::new()) } else { self.targets(panel, &title) };
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
        let options = Self::options(kind, panel, &legends, &mut notes);
        let transformations = panel.get("transformations").and_then(Value::as_array).cloned().unwrap_or_default();
        let renamed = fields::renames(&transformations);
        transformation_notes(&transformations, &mut notes);
        let field_config = Self::field_config(kind, panel, &renamed, &mut notes);
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
        // Query options: the points per series, the smallest interval (">30s" reads as "30s"),
        // the cache time (seconds without a unit) and whether the header hides its time note.
        if let Some(points) = panel.get("maxDataPoints").and_then(Value::as_u64)
            && let Ok(points) = u32::try_from(points)
            && (1..=model::MAX_PANEL_DATA_POINTS).contains(&points)
        {
            out["maxDataPoints"] = json!(points);
        }
        if let Some(interval) = text(panel, "interval").filter(|i| !i.starts_with('$')) {
            let plain = interval.trim_start_matches('>').to_string();
            if model::fixed_duration_ms(&plain).is_some_and(|ms| ms <= model::MAX_MIN_INTERVAL_MS) {
                out["minInterval"] = json!(plain);
            } else {
                notes.push(
                    note(
                        "min_interval",
                        format!("the smallest interval {interval} is not a plain length and was dropped"),
                    )
                    .with("interval", &interval),
                );
            }
        }
        if let Some(timeout) = text(panel, "cacheTimeout") {
            let plain =
                if timeout.chars().all(|c| c.is_ascii_digit()) { format!("{timeout}s") } else { timeout.clone() };
            if model::fixed_duration_ms(&plain).is_some_and(|ms| ms <= crate::datasources::cache::MAX_TTL_SECS * 1000) {
                out["cacheTimeout"] = json!(plain);
            }
        }
        if panel.get("hideTimeOverride").and_then(Value::as_bool) == Some(true) {
            out["hideTimeNote"] = json!(true);
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
                out["type"] = json!("query");
                out["datasourceId"] = json!(target.id);
                out["query"] = query;
                query_options(v, &mut out, &mut notes);
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
        let include_all = multi_ok && v.get("includeAll").and_then(Value::as_bool) == Some(true);
        if include_all {
            out["includeAll"] = json!(true);
            match text(v, "allValue") {
                Some(all) if all.chars().count() <= MAX_VARIABLE_TEXT_CHARS && !all.chars().any(char::is_control) => {
                    out["allValue"] = json!(all);
                }
                Some(_) => notes.push(note("all_value_dropped", "the custom value for \"All\" is too long")),
                None => {}
            }
        }
        if multi_ok && v.get("allowCustomValue").and_then(Value::as_bool) == Some(true) {
            out["allowCustom"] = json!(true);
        }
        if matches!(kind.as_str(), "query" | "custom" | "interval")
            && let Some(c) = current
        {
            let all =
                c.as_str() == Some(ALL) || c.as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(ALL)));
            if !all {
                out["current"] = c;
            } else if include_all {
                out["current"] = json!(ALL);
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

/// Grafana's regex, sort and refresh of a query variable, as Kalzit's (`dashboards::model`).
fn query_options(v: &Value, out: &mut Value, notes: &mut Vec<ImportNote>) {
    if let Some(regex) = text(v, "regex") {
        let fits = regex.chars().count() <= MAX_VARIABLE_TEXT_CHARS && !regex.chars().any(char::is_control);
        match OptionRegex::parse(&regex) {
            Ok(_) if fits => out["regex"] = json!(regex),
            Ok(_) => notes.push(
                note(
                    "variable_regex_too_long",
                    format!(
                        "the regex filter is longer than {MAX_VARIABLE_TEXT_CHARS} characters or holds control \
                         characters and is left out"
                    ),
                )
                .with("max", MAX_VARIABLE_TEXT_CHARS),
            ),
            Err(e) => notes
                .push(note("variable_regex_invalid", format!("the regex filter is left out: {e}")).with("detail", e)),
        }
    }
    let sort = match v.get("sort").and_then(Value::as_i64) {
        Some(1) => Some("alphabetical"),
        Some(2) => Some("alphabeticalDesc"),
        Some(3) => Some("numerical"),
        Some(4) => Some("numericalDesc"),
        Some(5) => Some("caseInsensitive"),
        Some(6) => Some("caseInsensitiveDesc"),
        Some(n @ (7 | 8)) => {
            notes.push(note("variable_sort_natural", "natural sort became sort by name"));
            Some(if n == 7 { "alphabetical" } else { "alphabeticalDesc" })
        }
        _ => None,
    };
    if let Some(sort) = sort {
        out["sort"] = json!(sort);
    }
    match v.get("refresh").and_then(Value::as_i64) {
        Some(1) => out["refresh"] = json!("load"),
        Some(2) => out["refresh"] = json!("timeRange"),
        _ => {}
    }
}

/// A panel's options that fail Kalzit's checks: the option the check names (`options.lineWidth`)
/// goes along on its own, so the UI's sentence holds no English; the check's text stays the detail.
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

/// The panel's transformations: an organize step's display names are taken over (see
/// `fields::renames`); its hidden columns and order, and every other step, are reported.
fn transformation_notes(transformations: &[Value], notes: &mut Vec<ImportNote>) {
    let mut other = BTreeSet::new();
    for t in transformations {
        if t.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let id = text(t, "id").unwrap_or_default();
        if id != "organize" {
            other.insert(if id.is_empty() { "?".to_string() } else { id });
            continue;
        }
        let options = t.get("options").cloned().unwrap_or(Value::Null);
        let hidden = options
            .get("excludeByName")
            .and_then(Value::as_object)
            .is_some_and(|o| o.values().any(|v| v.as_bool() == Some(true)));
        if hidden {
            notes.push(note("organize_hidden", "columns the organize step hides are shown"));
        }
        if options.get("indexByName").and_then(Value::as_object).is_some_and(|o| !o.is_empty()) {
            notes.push(note("organize_order", "the column order of the organize step is not taken over"));
        }
    }
    for id in other {
        notes.push(
            note("transformation", format!("the transformation {id} is not taken over")).with("transformation", id),
        );
    }
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
        // The time macros Grafana's SQL sources know run unchanged.
        let grouped = "SELECT $__timeGroupAlias(t, $__interval, 0), $__unixEpochGroup(u, '1m') FROM x                        WHERE $__unixEpochFilter(u) AND $__unixEpochNanoFrom() < n AND $__time(t) IS NOT NULL";
        assert_eq!(sql_query(grouped, &mut notes), grouped);
        assert!(notes.is_empty(), "{notes:?}");
        sql_query("SELECT $__unknownMacro(t)", &mut notes);
        assert_eq!(notes[0].code, "sql_macro");
        assert_eq!(notes[0].params["macro"], "$__unknownMacro");
        assert!(notes[0].text.contains("$__unknownMacro"), "{notes:?}");
    }

    #[test]
    fn variable_options_come_along_or_say_why_not() {
        let input = json!({
            "schemaVersion": 39, "title": "Vars", "panels": [],
            "templating": { "list": [
                { "name": "job", "type": "query", "datasource": { "type": "prometheus", "uid": "prom-uid" },
                  "query": { "query": "up" }, "regex": "/(?<text>.+/", "sort": 7, "includeAll": true,
                  "current": { "value": "$__all" }, "allowCustomValue": true },
                { "name": "level", "type": "textbox", "query": "x", "includeAll": true }
            ] }
        });
        let c = convert(&input, &sources()).unwrap();
        let job = &c.model["variables"][0];
        assert!(job.get("regex").is_none());
        assert_eq!((job["sort"].clone(), job["includeAll"].clone()), (json!("alphabetical"), json!(true)));
        assert_eq!((job["current"].clone(), job["allowCustom"].clone()), (json!("$__all"), json!(true)));
        assert!(job.get("allValue").is_none());
        let codes: Vec<&str> = item(&c.report, "variable job").notes.iter().map(|n| n.code.as_str()).collect();
        assert_eq!(codes, ["variable_regex_invalid", "variable_sort_natural"]);
        assert!(!item(&c.report, "variable job").notes[0].params["detail"].is_empty());
        // A regex Kalzit could run but not store: its own code, with the limit the UI names.
        let mut notes = Vec::new();
        let mut out = json!({});
        query_options(&json!({ "regex": "a".repeat(MAX_VARIABLE_TEXT_CHARS + 1) }), &mut out, &mut notes);
        assert!(out.get("regex").is_none());
        assert_eq!(notes[0].code, "variable_regex_too_long");
        assert_eq!(notes[0].params["max"], MAX_VARIABLE_TEXT_CHARS.to_string());
        // "All" belongs only to variables with a list of values.
        assert!(c.model["variables"][1].get("includeAll").is_none());
        model::parse(c.model.clone()).unwrap();
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
    fn query_options_and_table_footers_are_carried() {
        let prom = json!({ "type": "prometheus", "uid": "prom-uid" });
        let input = json!({
            "schemaVersion": 39, "title": "Options",
            "panels": [
                { "id": 1, "type": "table", "title": "Totals", "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
                  "datasource": prom, "targets": [{ "refId": "A", "expr": "up" }],
                  "maxDataPoints": 500, "interval": ">30s", "cacheTimeout": "60", "hideTimeOverride": true,
                  "options": { "footer": { "show": true, "reducer": ["sum", "mean"], "fields": "" } } },
                { "id": 2, "type": "table", "title": "Named", "gridPos": { "x": 12, "y": 0, "w": 12, "h": 8 },
                  "datasource": prom, "targets": [{ "refId": "A", "expr": "up" }],
                  "maxDataPoints": 0, "interval": "1w",
                  "options": { "footer": { "show": true, "reducer": ["lastNotNull"], "fields": ["Value", "Value"] } } }
            ]
        });
        let c = convert(&input, &sources()).unwrap();
        let totals = &c.model["panels"][0];
        assert_eq!(totals["maxDataPoints"], 500);
        assert_eq!(totals["minInterval"], "30s");
        assert_eq!(totals["cacheTimeout"], "60s");
        assert_eq!(totals["hideTimeNote"], true);
        assert_eq!(
            totals["options"]["footer"],
            json!({ "show": true, "over": "all", "columns": [], "numbers": "sum" })
        );
        let codes: Vec<_> = item(&c.report, "panel 1 \"Totals\"").notes.iter().map(|n| n.code.clone()).collect();
        assert!(codes.contains(&"footer_calcs".to_string()), "{codes:?}");
        let named = &c.model["panels"][1];
        assert!(named.get("maxDataPoints").is_none() && named.get("minInterval").is_none());
        assert_eq!(named["options"]["footer"]["columns"], json!([{ "column": "Value", "calc": "last" }]));
        let codes: Vec<_> = item(&c.report, "panel 2 \"Named\"").notes.iter().map(|n| n.code.clone()).collect();
        assert!(codes.contains(&"min_interval".to_string()), "{codes:?}");
    }

    #[test]
    fn table_footer_calculations_map_and_say_where_they_differ() {
        let footer_of = |footer: Value| {
            let input = json!({
                "schemaVersion": 39, "title": "Footer",
                "panels": [{ "id": 1, "type": "table", "title": "T", "gridPos": { "x": 0, "y": 0, "w": 12, "h": 8 },
                  "datasource": { "type": "prometheus", "uid": "prom-uid" }, "targets": [{ "refId": "A", "expr": "up" }],
                  "options": { "footer": footer } }]
            });
            let c = convert(&input, &sources()).unwrap();
            let notes: Vec<(String, Option<String>)> = item(&c.report, "panel 1 \"T\"")
                .notes
                .iter()
                .map(|n| (n.code.clone(), n.params.get("grafana").cloned()))
                .collect();
            (c.model["panels"][0]["options"].get("footer").cloned(), notes)
        };
        let calc = |footer: &Option<Value>| footer.as_ref().map(|f| f["numbers"].clone());
        let approximated = |notes: &[(String, Option<String>)], grafana: &str| {
            notes.iter().any(|(code, g)| code == "footer_approximated" && g.as_deref() == Some(grafana))
        };
        // Same calculation under another name: no note.
        for (grafana, kalzit) in
            [("diff", "delta"), ("diffperc", "deltaPercent"), ("p95", "p95"), ("lastNotNull", "last")]
        {
            let (footer, notes) = footer_of(json!({ "show": true, "reducer": [grafana] }));
            assert_eq!(calc(&footer), Some(json!(kalzit)), "{grafana}");
            assert!(!notes.iter().any(|(code, _)| code.starts_with("footer")), "{grafana}: {notes:?}");
        }
        // Calculated differently: kept, with a note.
        for (grafana, kalzit) in [("delta", "delta"), ("stdDev", "stddev"), ("variance", "variance")] {
            let (footer, notes) = footer_of(json!({ "show": true, "reducer": [grafana] }));
            assert_eq!(calc(&footer), Some(json!(kalzit)), "{grafana}");
            assert!(approximated(&notes, grafana), "{grafana}: {notes:?}");
        }
        let (footer, notes) = footer_of(json!({ "show": true, "reducer": ["sum"], "countRows": true }));
        assert_eq!(calc(&footer), Some(json!("count")));
        assert!(approximated(&notes, "countRows"), "{notes:?}");
        // No counterpart, or out of range: dropped with a note.
        for grafana in ["allValues", "p0", "p100", "p05"] {
            let (footer, notes) = footer_of(json!({ "show": true, "reducer": [grafana] }));
            assert!(footer.is_none(), "{grafana}");
            assert!(notes.iter().any(|(code, _)| code == "footer_calc"), "{grafana}: {notes:?}");
        }
        // Off: nothing.
        assert!(footer_of(json!({ "show": false, "reducer": ["sum"] })).0.is_none());
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
