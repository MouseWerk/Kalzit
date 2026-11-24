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
use crate::shapes::{AdhocFilter, FilterOperator, MAX_ADHOC_FILTERS};

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
    /// Ad hoc filters the dashboard may still hold: the model allows 20 over all ad hoc variables.
    adhoc_filters_left: usize,
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
                if o.pointer("/footer/show").and_then(Value::as_bool) == Some(true) {
                    notes.push(note("table_footer", "the table footer is not available in Kalzit yet"));
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
                // Prometheus sources take the helpers as Kalzit's own helper queries.
                if helper.is_some() && target.kind == "prometheus" {
                    match prometheus_helper(&plain_variables(&q, &mut notes)) {
                        Ok(query) => {
                            out["type"] = json!("query");
                            out["datasourceId"] = json!(target.id);
                            out["query"] = query;
                            query_options(v, &mut out, &mut notes);
                        }
                        Err(why) => {
                            self.report.add(ItemKind::Variable, label, vec![why], true);
                            return None;
                        }
                    }
                } else if let Some(helper) = helper {
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
                } else {
                    let query =
                        match self.query(&target.kind, &json!({ "expr": q, "rawSql": q, "query": q }), &mut notes) {
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
                    query_options(v, &mut out, &mut notes);
                }
            }
            "custom" if switch_pair(query_text.as_deref(), v).is_some() => {
                let (on, off) = switch_pair(query_text.as_deref(), v).unwrap_or_default();
                let current = current.as_ref().and_then(Value::as_str).filter(|c| *c == on || *c == off);
                notes.push(
                    note("variable_custom_switch", format!("the two values {on} and {off} became a switch"))
                        .with("on", &on)
                        .with("off", &off),
                );
                out["type"] = json!("switch");
                out["current"] = json!(current.unwrap_or(&off));
                out["onValue"] = json!(on);
                out["offValue"] = json!(off);
            }
            "datasource" => match self.datasource_variable(v, multi, &mut notes) {
                Ok(fields) => merge(&mut out, fields),
                Err(why) => {
                    self.report.add(ItemKind::Variable, label, vec![why], true);
                    return None;
                }
            },
            "adhoc" => match self.adhoc_variable(v, &mut notes) {
                Ok(fields) => merge(&mut out, fields),
                Err(why) => {
                    self.report.add(ItemKind::Variable, label, vec![why], true);
                    return None;
                }
            },
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
                let why = note("variable_type", format!("Kalzit has no counterpart of the variable type {other}"))
                    .with("type", other);
                self.report.add(ItemKind::Variable, label, vec![why], true);
                return None;
            }
        }
        let multi_ok = matches!(out["type"].as_str(), Some("query" | "custom"));
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
        if matches!(out["type"].as_str(), Some("query" | "custom" | "interval"))
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

    /// A Grafana `datasource` variable: the kind it offers, the regex on names, and a default
    /// source of that kind among the mapped ones (its current pick when that maps).
    fn datasource_variable(&self, v: &Value, multi: bool, notes: &mut Vec<ImportNote>) -> Result<Value, ImportNote> {
        let plugin = text(v, "query").unwrap_or_default();
        let Some(kind) = kalzit_kind(&plugin) else {
            return Err(note(
                "variable_datasource_kind",
                format!("Kalzit has no data sources of the type {plugin} to pick from"),
            )
            .with("kind", &plugin));
        };
        let picked = v
            .get("current")
            .and_then(|c| c.get("value"))
            .and_then(Value::as_str)
            .map(|s| source_ref(Some(&Value::String(s.to_string())), &self.inputs));
        let default = picked
            .and_then(|r| self.target_of(&r).cloned())
            .filter(|t| t.kind == kind)
            .or_else(|| self.sources.values().find(|t| t.kind == kind).cloned());
        let Some(default) = default else {
            return Err(note(
                "variable_datasource_no_source",
                format!("no mapped data source of the type {kind} can be its default"),
            )
            .with("kind", kind));
        };
        if multi {
            notes.push(note("variable_datasource_multi", "it picks one data source; several at once are not carried"));
        }
        let mut out = json!({ "type": "datasource", "datasourceKind": kind, "current": default.id });
        query_options(&json!({ "regex": v.get("regex").cloned().unwrap_or(Value::Null) }), &mut out, notes);
        Ok(out)
    }

    /// A Grafana `adhoc` variable: the mapped source, if its kind can apply filters, and the
    /// filters it opens with, as far as Kalzit has their comparison.
    fn adhoc_variable(&mut self, v: &Value, notes: &mut Vec<ImportNote>) -> Result<Value, ImportNote> {
        let source = source_ref(v.get("datasource"), &self.inputs);
        let Some(target) = (!source.special).then(|| self.target_of(&source).cloned()).flatten() else {
            return Err(source.no_mapping());
        };
        let operators = adhoc_operators(&target.kind);
        if operators.is_empty() {
            return Err(note(
                "variable_adhoc_kind",
                format!("data sources of the type {} cannot apply ad hoc filters", target.kind),
            )
            .with("kind", &target.kind));
        }
        let mut filters = Vec::new();
        let mut dropped = 0usize;
        for f in v.get("filters").and_then(Value::as_array).into_iter().flatten() {
            let key = text(f, "key").unwrap_or_default();
            let operator = text(f, "operator").unwrap_or_default();
            let value = match f.get("value") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => String::new(),
            };
            let candidate: Result<AdhocFilter, _> =
                serde_json::from_value(json!({ "key": key.trim(), "operator": operator, "value": value }));
            // Only comparisons the source applies, in a form the server takes, within the
            // dashboard's 20 over all its ad hoc variables.
            match candidate {
                Ok(filter)
                    if filters.len() < self.adhoc_filters_left
                        && operators.contains(&filter.operator)
                        && crate::shapes::check_filters(std::slice::from_ref(&filter)).is_ok() =>
                {
                    filters.push(filter)
                }
                _ => dropped += 1,
            }
        }
        self.adhoc_filters_left -= filters.len();
        if dropped > 0 {
            notes.push(
                note(
                    "variable_adhoc_filters",
                    format!(
                        "{dropped} filters were left out: a comparison the source does not apply, a form \
                         Kalzit does not take, or more than {MAX_ADHOC_FILTERS} in the dashboard"
                    ),
                )
                .with("count", dropped)
                .with("max", MAX_ADHOC_FILTERS),
            );
        }
        let mut out = json!({ "type": "adhoc", "datasourceId": target.id });
        if !filters.is_empty() {
            out["current"] = json!(filters);
        }
        Ok(out)
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

/// The comparisons the server applies as ad hoc filters for a kind the import converts: label
/// matchers for Prometheus and Loki, everything for Elasticsearch, no patterns for SQL; none for
/// a kind that cannot apply filters (`DataSourcePlugin::adhoc_filters`, ui `operatorsFor`).
fn adhoc_operators(kind: &str) -> &'static [FilterOperator] {
    use FilterOperator::{Equal, Greater, Less, Matches, NotEqual, NotMatches};
    match kind {
        "prometheus" | "loki" => &[Equal, NotEqual, Matches, NotMatches],
        "elasticsearch" => &[Equal, NotEqual, Matches, NotMatches, Less, Greater],
        "postgres" | "mysql" | "sqlite" | "mssql" | "clickhouse" => &[Equal, NotEqual, Less, Greater],
        _ => &[],
    }
}

/// The Kalzit kind of a Grafana data source plugin id, for the kinds the import converts.
fn kalzit_kind(plugin: &str) -> Option<&'static str> {
    Some(match plugin.trim() {
        "prometheus" => "prometheus",
        "loki" => "loki",
        "postgres" | "grafana-postgresql-datasource" => "postgres",
        "mysql" => "mysql",
        "mssql" => "mssql",
        "frser-sqlite-datasource" | "sqlite" => "sqlite",
        "grafana-clickhouse-datasource" | "clickhouse" => "clickhouse",
        "elasticsearch" => "elasticsearch",
        "influxdb" => "influxdb",
        _ => return None,
    })
}

/// Copies the fields of `from` into `out`.
fn merge(out: &mut Value, from: Value) {
    if let (Some(out), Value::Object(from)) = (out.as_object_mut(), from) {
        out.extend(from);
    }
}

/// A custom variable of exactly two values that read as on and off (`true,false`, `on,off`,
/// `yes,no`, `1,0`, `enabled,disabled`, in either order), offering neither several values, "All"
/// nor typed ones: the switch's on and off values.
fn switch_pair(query: Option<&str>, v: &Value) -> Option<(String, String)> {
    let flag = |key: &str| v.get(key).and_then(Value::as_bool) == Some(true);
    if flag("multi") || flag("includeAll") || flag("allowCustomValue") {
        return None;
    }
    let parts: Vec<&str> = query?.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    let [a, b] = parts.as_slice() else { return None };
    if a.contains(" : ") || b.contains(" : ") {
        return None;
    }
    const PAIRS: &[(&str, &str)] =
        &[("true", "false"), ("on", "off"), ("yes", "no"), ("1", "0"), ("enabled", "disabled")];
    PAIRS.iter().find_map(|(on, off)| {
        if a.eq_ignore_ascii_case(on) && b.eq_ignore_ascii_case(off) {
            Some((a.to_string(), b.to_string()))
        } else if b.eq_ignore_ascii_case(on) && a.eq_ignore_ascii_case(off) {
            Some((b.to_string(), a.to_string()))
        } else {
            None
        }
    })
}

/// The index of the `)` that closes the `(` at `open`, skipping quoted text; `None` if none.
fn closing_paren(text: &str, open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in text.char_indices().skip_while(|(i, _)| *i < open) {
        match quote {
            Some(_) if escaped => escaped = false,
            Some(_) if c == '\\' => escaped = true,
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '"' | '\'' | '`' => quote = Some(c),
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => {
                    depth -= 1;
                    if depth == 0 {
                        return (c == ')').then_some(i);
                    }
                }
                _ => {}
            },
        }
    }
    None
}

/// The last comma outside brackets and quotes, which ends `label_values(selector, label)`.
fn last_top_comma(text: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut found = None;
    for (i, c) in text.char_indices() {
        match quote {
            Some(_) if escaped => escaped = false,
            Some(_) if c == '\\' => escaped = true,
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None => match c {
                '"' | '\'' | '`' => quote = Some(c),
                '(' | '{' | '[' => depth += 1,
                ')' | '}' | ']' => depth -= 1,
                ',' if depth == 0 => found = Some(i),
                _ => {}
            },
        }
    }
    found
}

/// A series selector as metric and label filter: `up{env="prod"}`, `{job="x"}` or `up`.
fn selector_parts(selector: &str) -> Option<(Option<String>, Option<String>)> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Some((None, None));
    }
    let is_metric = |m: &str| {
        let mut chars = m.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == ':')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':')
    };
    match selector.find('{') {
        None => is_metric(selector).then(|| (Some(selector.to_string()), None)),
        Some(open) => {
            let metric = selector[..open].trim();
            let close = closing_paren_brace(selector, open)?;
            if close != selector.len() - 1 || (!metric.is_empty() && !is_metric(metric)) {
                return None;
            }
            let filter = selector[open + 1..close].trim();
            Some(((!metric.is_empty()).then(|| metric.to_string()), (!filter.is_empty()).then(|| filter.to_string())))
        }
    }
}

/// The index of the `}` closing the `{` at `open`, skipping quoted text.
fn closing_paren_brace(text: &str, open: usize) -> Option<usize> {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for (i, c) in text.char_indices().skip_while(|(i, _)| *i <= open) {
        match quote {
            Some(_) if escaped => escaped = false,
            Some(_) if c == '\\' => escaped = true,
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if matches!(c, '"' | '\'' | '`') => quote = Some(c),
            None if c == '{' => return None,
            None if c == '}' => return Some(i),
            None => {}
        }
    }
    None
}

/// Grafana's Prometheus variable helpers as Kalzit's helper queries (docs/api/datasources.md,
/// "Prometheus helpers"): `label_values([selector,] label)`, `label_names([selector])`,
/// `metrics([regex])`, `query_result(expr)`.
fn prometheus_helper(q: &str) -> Result<Value, ImportNote> {
    let q = q.trim();
    let unparsed = || {
        note("variable_helper_unparsed", format!("the helper {q} could not be read and was left out"))
            .with("query", truncate(q, 200))
    };
    let open = q.find('(').ok_or_else(unparsed)?;
    let close = closing_paren(q, open).ok_or_else(unparsed)?;
    if !q[close + 1..].trim().is_empty() {
        return Err(unparsed());
    }
    let name = q[..open].trim();
    let inner = q[open + 1..close].trim();
    let with_selector = |mut out: Value, selector: &str| -> Result<Value, ImportNote> {
        let (metric, filter) = selector_parts(selector).ok_or_else(unparsed)?;
        if let Some(m) = metric {
            out["metric"] = json!(m);
        }
        if let Some(f) = filter {
            out["filter"] = json!(f);
        }
        Ok(out)
    };
    match name {
        "label_values" => {
            let (selector, label) = match last_top_comma(inner) {
                Some(at) => (&inner[..at], inner[at + 1..].trim()),
                None => ("", inner),
            };
            let label_ok = label.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !label_ok {
                return Err(unparsed());
            }
            with_selector(json!({ "helper": "labelValues", "label": label }), selector)
        }
        "label_names" => with_selector(json!({ "helper": "labelNames" }), inner),
        "metrics" => {
            let mut out = json!({ "helper": "metrics" });
            if !inner.is_empty() {
                out["regex"] = json!(inner);
            }
            Ok(out)
        }
        "query_result" if !inner.is_empty() => Ok(json!({ "helper": "queryResult", "expr": inner })),
        _ => Err(unparsed()),
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
        adhoc_filters_left: MAX_ADHOC_FILTERS,
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
    fn prometheus_helpers_become_helper_queries() {
        assert_eq!(
            prometheus_helper("label_values(up{env=\"$env\", job=~\"a,b\"}, instance)").unwrap(),
            json!({ "helper": "labelValues", "label": "instance", "metric": "up", "filter": "env=\"$env\", job=~\"a,b\"" })
        );
        assert_eq!(prometheus_helper("label_values(job)").unwrap(), json!({ "helper": "labelValues", "label": "job" }));
        assert_eq!(
            prometheus_helper("label_values({job=\"x\"}, pod)").unwrap(),
            json!({ "helper": "labelValues", "label": "pod", "filter": "job=\"x\"" })
        );
        assert_eq!(prometheus_helper("label_names()").unwrap(), json!({ "helper": "labelNames" }));
        assert_eq!(prometheus_helper("label_names(up)").unwrap(), json!({ "helper": "labelNames", "metric": "up" }));
        assert_eq!(prometheus_helper("metrics(node_.*)").unwrap(), json!({ "helper": "metrics", "regex": "node_.*" }));
        assert_eq!(prometheus_helper("metrics()").unwrap(), json!({ "helper": "metrics" }));
        assert_eq!(
            prometheus_helper("query_result(topk(5, sum by (job) (rate(x[5m]))))").unwrap(),
            json!({ "helper": "queryResult", "expr": "topk(5, sum by (job) (rate(x[5m])))" })
        );
        for bad in [
            "label_values(up, a b)",
            "label_values(rate(up[5m]), job)",
            "query_result()",
            "label_values(up",
            "metrics(x) y",
        ] {
            assert_eq!(prometheus_helper(bad).unwrap_err().code, "variable_helper_unparsed", "{bad}");
        }
    }

    /// Helpers, data source variables, ad hoc filters and two-valued custom variables convert,
    /// and every variable made passes the model's checks.
    #[test]
    fn new_variable_kinds_come_along_or_say_why_not() {
        let input = json!({
            "schemaVersion": 39, "title": "Kinds", "panels": [],
            "templating": { "list": [
                { "name": "job", "type": "query", "datasource": { "type": "prometheus", "uid": "prom-uid" },
                  "query": { "query": "label_values(up{env=\"${env}\"}, job)" }, "sort": 1, "refresh": 2 },
                { "name": "pgv", "type": "query", "datasource": { "type": "postgres", "uid": "Postgres" },
                  "query": "label_values(x)" },
                { "name": "src", "type": "datasource", "query": "prometheus", "regex": "/prod/",
                  "current": { "value": "DS_PROMETHEUS" } },
                { "name": "nosrc", "type": "datasource", "query": "loki" },
                { "name": "odd", "type": "datasource", "query": "grafana-x-datasource" },
                { "name": "filters", "type": "adhoc", "datasource": { "type": "prometheus", "uid": "prom-uid" },
                  "filters": [ { "key": "env", "operator": "=", "value": "prod" },
                               { "key": "pod", "operator": "=|", "value": "a" },
                               { "key": "", "operator": "=", "value": "x" } ] },
                { "name": "flag", "type": "custom", "query": "false, true", "current": { "value": "true" } },
                { "name": "pick", "type": "custom", "query": "true, false", "multi": true }
            ] }
        });
        let c = convert(&input, &sources()).unwrap();
        let vars = c.model["variables"].as_array().unwrap();
        let of = |name: &str| vars.iter().find(|v| v["name"] == name).cloned();
        assert_eq!(
            of("job").unwrap(),
            json!({ "name": "job", "type": "query", "datasourceId": "ds-prom", "sort": "alphabetical",
                    "refresh": "timeRange",
                    "query": { "helper": "labelValues", "label": "job", "metric": "up", "filter": "env=\"$env\"" } })
        );
        assert!(of("pgv").is_none());
        assert_eq!(item(&c.report, "variable pgv").notes[0].code, "variable_helper");
        assert_eq!(
            of("src").unwrap(),
            json!({ "name": "src", "type": "datasource", "datasourceKind": "prometheus", "current": "ds-prom",
                    "regex": "/prod/" })
        );
        assert_eq!(item(&c.report, "variable nosrc").notes[0].code, "variable_datasource_no_source");
        assert_eq!(item(&c.report, "variable odd").notes[0].code, "variable_datasource_kind");
        assert_eq!(
            of("filters").unwrap(),
            json!({ "name": "filters", "type": "adhoc", "datasourceId": "ds-prom",
                    "current": [{ "key": "env", "operator": "=", "value": "prod" }] })
        );
        let filters = item(&c.report, "variable filters");
        assert_eq!(
            (filters.notes[0].code.as_str(), filters.notes[0].params["count"].as_str()),
            ("variable_adhoc_filters", "2")
        );
        assert_eq!(
            of("flag").unwrap(),
            json!({ "name": "flag", "type": "switch", "onValue": "true", "offValue": "false", "current": "true" })
        );
        assert_eq!(item(&c.report, "variable flag").notes[0].code, "variable_custom_switch");
        assert_eq!(of("pick").unwrap()["type"], "custom");
        model::parse(c.model.clone()).unwrap();
    }

    /// The dashboard holds at most 20 filters over all its ad hoc variables, and each keeps only
    /// the comparisons its source applies; what is left out is counted in the note.
    #[test]
    fn ad_hoc_filters_keep_the_limit_and_their_comparisons() {
        let filters = |n: usize, op: &str| -> Vec<Value> {
            (0..n).map(|i| json!({ "key": format!("k{i}"), "operator": op, "value": "v" })).collect()
        };
        let all = |extra: Vec<Value>| -> Vec<Value> {
            ["=", "!=", "=~", "!~", "<", ">"]
                .iter()
                .map(|op| json!({ "key": "k", "operator": op, "value": "1" }))
                .chain(extra)
                .collect()
        };
        let mut sources = sources();
        sources.insert("es".into(), SourceTarget { id: "ds-es".into(), kind: "elasticsearch".into() });
        let input = json!({
            "schemaVersion": 39, "title": "Filters", "panels": [],
            "templating": { "list": [
                { "name": "a", "type": "adhoc", "datasource": { "type": "prometheus", "uid": "prom-uid" },
                  "filters": filters(12, "=") },
                { "name": "b", "type": "adhoc", "datasource": { "type": "prometheus", "uid": "prom-uid" },
                  "filters": filters(10, "!=") }
            ] }
        });
        let c = convert(&input, &sources).unwrap();
        let count = |name: &str| {
            c.model["variables"].as_array().unwrap().iter().find(|v| v["name"] == name).unwrap()["current"]
                .as_array()
                .map_or(0, Vec::len)
        };
        assert_eq!((count("a"), count("b")), (12, 8));
        let b = item(&c.report, "variable b");
        assert_eq!((b.notes[0].code.as_str(), b.notes[0].params["count"].as_str()), ("variable_adhoc_filters", "2"));
        model::parse(c.model.clone()).unwrap();

        let ops = |kind_uid: &str, kind: &str| -> Vec<String> {
            let input = json!({
                "schemaVersion": 39, "title": "Ops", "panels": [],
                "templating": { "list": [
                    { "name": "f", "type": "adhoc", "datasource": { "type": kind, "uid": kind_uid }, "filters": all(vec![]) }
                ] }
            });
            let c = convert(&input, &sources).unwrap();
            model::parse(c.model.clone()).unwrap();
            c.model["variables"][0]["current"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["operator"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(ops("prom-uid", "prometheus"), ["=", "!=", "=~", "!~"]);
        assert_eq!(ops("Postgres", "postgres"), ["=", "!=", "<", ">"]);
        assert_eq!(ops("es", "elasticsearch"), ["=", "!=", "=~", "!~", "<", ">"]);
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
