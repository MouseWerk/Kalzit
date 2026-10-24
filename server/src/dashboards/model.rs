//! The dashboard model: JSON with a `schemaVersion`. Stored models are migrated to the current
//! version on read, one step per version (docs/ARCHITECTURE.md, "Dashboards"); saved models are
//! migrated the same way and then validated.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The version this server writes. A model with a higher version comes from a newer Kalzit and is
/// refused rather than guessed at.
///
/// - 1: first version; `transformations` had no defined content (the documents UI stored its
///   projections there).
/// - 2: one combined version. `transformations` holds analysis steps (`crate::analysis`), and the
///   dashboard features add rows, repeats, links, tags, annotation queries, panel time options,
///   library panel references and multi-value variables. Those are optional and empty by default
///   and version 1 had none of them, so the one step `v1_to_v2` only converts `transformations`.
///   A library panel slot (`libraryPanelId`) has no steps, targets or links of its own; the
///   library panel holds them (the slot rule in `validate`). The dashboard time options
///   (`timeZone` ... `sharedCursor`) joined version 2 later, optional and left out while unset; a
///   server from before them refuses a model that sets one (docs/api/settings-dashboards.md).
pub const SCHEMA_VERSION: u64 = 2;

/// `STEPS[i]` turns a model of schemaVersion `i + 1` into `i + 2`; each step has its own test.
/// A step changes only what its version changed and sets the new `schemaVersion`.
type Step = fn(Value) -> Result<Value, String>;
const STEPS: &[Step] = &[v1_to_v2];

/// Version 2 reads a panel's `transformations` as analysis steps. In version 1 the documents UI
/// stored its projections there as `{"type": "toFrame", "refId", "columns"}`; they become steps
/// (`id`, `frame`), keeping only what version 2 accepts: columns with a path, a known type and a
/// name not used before. Everything else had no defined meaning in version 1 and is dropped.
fn v1_to_v2(mut model: Value) -> Result<Value, String> {
    if let Some(panels) = model.get_mut("panels").and_then(Value::as_array_mut) {
        for panel in panels {
            let Some(p) = panel.as_object_mut() else { continue };
            let Some(old) = p.get("transformations").and_then(Value::as_array) else {
                if p.contains_key("transformations") {
                    p.insert("transformations".into(), Value::Array(Vec::new()));
                }
                continue;
            };
            let targets: BTreeSet<String> = p
                .get("targets")
                .and_then(Value::as_array)
                .map(|t| t.iter().filter_map(|t| t.get("refId")?.as_str().map(String::from)).collect())
                .unwrap_or_default();
            // A projection of a query the panel does not have would refuse the model; of several
            // for one query, the last one stored is the one the documents UI applied.
            let mut seen = BTreeSet::new();
            let mut steps: Vec<Value> = old
                .iter()
                .rev()
                .filter_map(v1_projection)
                .filter(|s| {
                    let frame = s["frame"].as_str().unwrap_or_default().to_string();
                    targets.contains(&frame) && seen.insert(frame)
                })
                .collect();
            steps.reverse();
            p.insert("transformations".into(), Value::Array(steps));
        }
    }
    model["schemaVersion"] = Value::from(2);
    Ok(model)
}

/// A version 1 projection as a version 2 step; `None` for anything else or nothing left.
fn v1_projection(step: &Value) -> Option<Value> {
    use crate::analysis::{MAX_PATH_CHARS, MAX_PROJECTION_COLUMNS};
    const TYPES: &[&str] = &["string", "number", "int64", "bool", "time"];
    if step.get("type")?.as_str()? != "toFrame" {
        return None;
    }
    let ref_id = step.get("refId")?.as_str()?;
    if ref_id.is_empty() || ref_id.chars().count() > MAX_ID_CHARS {
        return None;
    }
    let mut names = BTreeSet::new();
    let mut columns = Vec::new();
    for c in step.get("columns")?.as_array()? {
        let Some(path) = c.get("path").and_then(Value::as_str) else { continue };
        let ok = |s: &str, max: usize| !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control);
        if !ok(path, MAX_PATH_CHARS) {
            continue;
        }
        let mut column = serde_json::Map::new();
        column.insert("path".into(), Value::from(path));
        let name = c.get("name").and_then(Value::as_str).filter(|n| ok(n, MAX_TITLE_CHARS));
        if let Some(n) = name {
            column.insert("name".into(), Value::from(n));
        }
        if let Some(t) = c.get("type").and_then(Value::as_str).filter(|t| TYPES.contains(t)) {
            column.insert("type".into(), Value::from(t));
        }
        if columns.len() == MAX_PROJECTION_COLUMNS || !names.insert(name.unwrap_or(path).to_string()) {
            continue;
        }
        columns.push(Value::Object(column));
    }
    if columns.is_empty() {
        return None;
    }
    // Stable, since stored version 1 models are migrated on every read.
    Some(
        serde_json::json!({ "id": format!("projection-{ref_id}"), "type": "toFrame", "frame": ref_id, "columns": columns }),
    )
}

/// The grid has 24 columns; rows are unbounded but a dashboard this tall is a mistake.
pub const GRID_COLUMNS: u32 = 24;
const MAX_GRID_Y: u32 = 10_000;
const MAX_PANEL_HEIGHT: u32 = 200;
const MAX_PANELS: usize = 500;
const MAX_TARGETS: usize = 50;
/// The stored model, serialized. Every save keeps a copy in the history, so this bounds the
/// history's growth too; real dashboards stay far below it.
pub const MAX_MODEL_BYTES: usize = 1024 * 1024;
const MAX_VARIABLES: usize = 100;
const MAX_ROWS: usize = 100;
pub const MAX_TAGS: usize = 20;
pub const MAX_TAG_CHARS: usize = 50;
const MAX_LINKS: usize = 50;
const MAX_PANEL_LINKS: usize = 20;
const MAX_ANNOTATION_QUERIES: usize = 20;
const MAX_URL_CHARS: usize = 2048;
const MAX_PER_ROW: u32 = 24;
/// Annotation colors are entries of the chart palette (`--chart-1` ... `--chart-8`).
const ANNOTATION_COLORS: u32 = 8;
const MAX_ID_CHARS: usize = 64;
pub const MAX_TITLE_CHARS: usize = 200;
/// Refreshing faster than this only loads the data sources.
const MIN_REFRESH_SECONDS: u32 = 5;
const MAX_REFRESH_SECONDS: u32 = 24 * 3600;
const MAX_REFRESH_INTERVALS: usize = 20;
/// A now delay is short: seconds to days.
const NOW_DELAY_UNITS: &[char] = &['s', 'm', 'h', 'd'];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardModel {
    pub schema_version: u64,
    pub title: String,
    pub time_range: TimeRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_seconds: Option<u32>,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub panels: Vec<Panel>,
    /// Words for finding the dashboard, for links to dashboards by tag and for playlists.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Collapsible groups of panels, in display order below the panels outside every row.
    #[serde(default)]
    pub rows: Vec<Row>,
    /// Queries whose rows become annotations on every time panel.
    #[serde(default)]
    pub annotations: Vec<AnnotationQuery>,
    #[serde(default)]
    pub links: Vec<DashboardLink>,
    /// The zone times are read and shown in: an IANA name or `browser` (the viewer's browser).
    /// Absent: each viewer's own preference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    /// The first day of a week for `now/w`; absent: each viewer's own preference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week_start: Option<WeekStart>,
    /// The month (1 to 12) the fiscal year starts with, for `fy` and `fQ`; absent: January.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiscal_year_start_month: Option<u32>,
    /// `now` stands this far back (`1m`), so the newest, still incomplete data is left out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now_delay: Option<String>,
    /// The automatic refresh intervals offered, in seconds, ascending; empty: Kalzit's list.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refresh_intervals: Vec<u32>,
    /// Whether time panels show the pointer's time in every other time panel too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_cursor: Option<SharedCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WeekStart {
    Monday,
    Sunday,
    Saturday,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SharedCursor {
    Off,
    /// A line at the same time in every time panel.
    Crosshair,
    /// The line and the values at that time.
    Tooltip,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Row {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Saved as the editor left it; viewers open and close rows without saving.
    #[serde(default)]
    pub collapsed: bool,
    /// The row and its panels are shown once per value of this multi-value variable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<RowRepeat>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowRepeat {
    pub variable: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepeatDirection {
    /// Copies side by side, wrapping after `maxPerRow`.
    Horizontal,
    /// Copies below each other.
    Vertical,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelRepeat {
    pub variable: String,
    pub direction: RepeatDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_per_row: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationQuery {
    pub id: String,
    pub name: String,
    pub datasource_id: String,
    pub query: Value,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// 1 to 8, an entry of the chart palette; none uses the neutral annotation color.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<u32>,
}

fn yes() -> bool {
    true
}

/// A link in the dashboard's header.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum DashboardLink {
    /// The dashboards carrying `tag`, as a list to pick from.
    #[serde(rename_all = "camelCase")]
    Dashboards {
        tag: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        new_tab: bool,
    },
    /// A fixed address; variables (`${name}`) are filled in by the viewer's browser.
    #[serde(rename_all = "camelCase")]
    Url {
        title: String,
        url: String,
        #[serde(default)]
        new_tab: bool,
    },
}

/// A panel's data link: an address with variables, shown in the panel's header.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PanelLink {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub new_tab: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TimeRange {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VariableType {
    /// Options come from a query against `datasourceId`.
    Query,
    /// Options listed in `options`.
    Custom,
    Constant,
    Textbox,
    Interval,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Variable {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: VariableType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datasource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<Value>,
    /// Several values may be picked at once (custom and query variables); repeats need it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub multi: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Panel {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    pub grid: Grid,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default)]
    pub transformations: Vec<Value>,
    #[serde(default = "empty_object")]
    pub options: Value,
    #[serde(default = "empty_object")]
    pub field_config: Value,
    /// The row the panel belongs to; its grid then counts from the top of that row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<PanelRepeat>,
    /// A relative range of its own instead of the dashboard's (`now-24h`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_from: Option<String>,
    /// Moves the range back by this much (`1d`), to compare with an earlier period.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_shift: Option<String>,
    #[serde(default)]
    pub links: Vec<PanelLink>,
    /// The panel shows this library panel: queries, type and options come from there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_panel_id: Option<String>,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grid {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub ref_id: String,
    pub datasource_id: String,
    pub query: Value,
    /// Kept with the panel but not run (the editor's "hide"); absent means it runs.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hide: bool,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde hands the field over by reference
fn is_false(value: &bool) -> bool {
    !*value
}

impl DashboardModel {
    /// Every stored query as (data source, query text): panel targets and query variables.
    pub fn stored_queries(&self) -> BTreeSet<(&str, String)> {
        let targets =
            self.panels.iter().flat_map(|p| p.targets.iter().map(|t| (t.datasource_id.as_str(), t.query.to_string())));
        let variables = self.variables.iter().filter_map(|v| {
            v.datasource_id.as_deref().map(|id| (id, v.query.as_ref().map_or_else(String::new, |q| q.to_string())))
        });
        let annotations = self.annotations.iter().map(|a| (a.datasource_id.as_str(), a.query.to_string()));
        targets.chain(variables).chain(annotations).collect()
    }

    /// Every data source the stored queries use: panel targets, query variables and annotation
    /// queries.
    pub fn datasource_ids(&self) -> BTreeSet<&str> {
        let targets = self.panels.iter().flat_map(|p| p.targets.iter().map(|t| t.datasource_id.as_str()));
        let variables = self.variables.iter().filter_map(|v| v.datasource_id.as_deref());
        let annotations = self.annotations.iter().map(|a| a.datasource_id.as_str());
        targets.chain(variables).chain(annotations).collect()
    }

    /// The library panels the dashboard shows.
    pub fn library_panel_ids(&self) -> BTreeSet<&str> {
        self.panels.iter().filter_map(|p| p.library_panel_id.as_deref()).collect()
    }
}

/// Checks the options and field options of the panels a write adds or changes: every panel of a
/// new dashboard, and on a save or restore those whose type, options or field options differ
/// from the `previous` model's panel with the same id. Only writes run it, so a stored dashboard
/// that predates a rule keeps loading and querying, and can still be saved while that panel is
/// left as it is.
///
/// The error names the panel (its title, else its id) and what is wrong with it.
pub fn check_panel_options(model: &DashboardModel, previous: Option<&DashboardModel>) -> Result<(), (String, String)> {
    for (i, p) in model.panels.iter().enumerate() {
        let unchanged = previous
            .and_then(|m| m.panels.iter().find(|old| old.id == p.id))
            .is_some_and(|old| old.kind == p.kind && old.options == p.options && old.field_config == p.field_config);
        if !unchanged {
            super::panel_options::check(&p.kind, &p.options, &p.field_config).map_err(|e| {
                let name = if p.title.trim().is_empty() { p.id.clone() } else { p.title.clone() };
                (name, format!("model.panels[{i}].{e}"))
            })?;
        }
    }
    Ok(())
}

/// Migrates a stored or submitted model to `SCHEMA_VERSION` and parses and validates it. Panel
/// options are left to `check_panel_options`, which writes run on top.
pub fn parse(raw: Value) -> Result<DashboardModel, String> {
    let current = migrate(raw)?;
    let model: DashboardModel = serde_json::from_value(current).map_err(|e| format!("model: {e}"))?;
    // Measured as stored (defaults filled in), so what is kept is what is limited; before the
    // detailed checks, so an oversized model is refused for its size whatever it holds.
    let bytes = serde_json::to_vec(&model).map_err(|e| format!("model: {e}"))?.len();
    if bytes > MAX_MODEL_BYTES {
        return Err(format!("model takes {bytes} bytes; at most {MAX_MODEL_BYTES} are allowed"));
    }
    validate(&model)?;
    Ok(model)
}

pub fn migrate(raw: Value) -> Result<Value, String> {
    migrate_with(raw, STEPS, SCHEMA_VERSION)
}

fn migrate_with(mut model: Value, steps: &[Step], current: u64) -> Result<Value, String> {
    let Some(mut version) = model.get("schemaVersion").and_then(Value::as_u64) else {
        return Err("model.schemaVersion must be a whole number".into());
    };
    if version == 0 {
        return Err("model.schemaVersion starts at 1".into());
    }
    if version > current {
        return Err(format!(
            "model.schemaVersion {version} comes from a newer Kalzit; this server reads up to {current}"
        ));
    }
    while version < current {
        let step =
            steps.get(version as usize - 1).ok_or_else(|| format!("no migration from schemaVersion {version}"))?;
        model = step(model).map_err(|e| format!("migrating from schemaVersion {version}: {e}"))?;
        let next = model.get("schemaVersion").and_then(Value::as_u64);
        if next != Some(version + 1) {
            return Err(format!("migration from schemaVersion {version} did not produce {}", version + 1));
        }
        version += 1;
    }
    Ok(model)
}

fn check_text(what: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let chars = value.chars().count();
    if chars < min || chars > max {
        return Err(format!("{what} needs {min} to {max} characters"));
    }
    if value.chars().any(char::is_control) {
        return Err(format!("{what} contains control characters"));
    }
    Ok(())
}

fn check_id(what: &str, value: &str) -> Result<(), String> {
    check_text(what, value, 1, MAX_ID_CHARS)?;
    if value.trim() != value {
        return Err(format!("{what} must not start or end with spaces"));
    }
    Ok(())
}

/// Variable names appear in queries as `$name`, so they are identifiers.
fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

pub fn validate(model: &DashboardModel) -> Result<(), String> {
    if model.schema_version != SCHEMA_VERSION {
        return Err(format!("model.schemaVersion must be {SCHEMA_VERSION}"));
    }
    if model.title.trim().is_empty() {
        return Err("model.title must not be empty".into());
    }
    check_text("model.title", &model.title, 1, MAX_TITLE_CHARS)?;
    check_range(&model.time_range).map_err(|e| format!("model.timeRange: {e}"))?;
    if let Some(r) = model.refresh_seconds
        && !(MIN_REFRESH_SECONDS..=MAX_REFRESH_SECONDS).contains(&r)
    {
        return Err(format!("model.refreshSeconds must be {MIN_REFRESH_SECONDS} to {MAX_REFRESH_SECONDS}"));
    }
    check_time_options(model)?;

    if model.variables.len() > MAX_VARIABLES {
        return Err(format!("model.variables takes at most {MAX_VARIABLES} entries"));
    }
    let mut names = BTreeSet::new();
    for (i, v) in model.variables.iter().enumerate() {
        let at = format!("model.variables[{i}]");
        if v.name.chars().count() > MAX_ID_CHARS || !is_identifier(&v.name) {
            return Err(format!("{at}.name must be a name of letters, digits and _ (up to {MAX_ID_CHARS})"));
        }
        if !names.insert(v.name.as_str()) {
            return Err(format!("{at}.name {} is used twice", v.name));
        }
        if let Some(label) = &v.label {
            check_text(&format!("{at}.label"), label, 0, MAX_TITLE_CHARS)?;
        }
        match (v.kind, &v.datasource_id) {
            (VariableType::Query, Some(id)) => check_id(&format!("{at}.datasourceId"), id)?,
            (VariableType::Query, None) => return Err(format!("{at}.datasourceId is required for a query variable")),
            (_, Some(_)) => return Err(format!("{at}.datasourceId belongs only to query variables")),
            (_, None) => {}
        }
        if v.multi && !matches!(v.kind, VariableType::Custom | VariableType::Query) {
            return Err(format!("{at}.multi is only for custom and query variables"));
        }
    }
    // What a repeat may name: a variable offering several values at once.
    let repeatable = |at: &str, name: &str| -> Result<(), String> {
        match model.variables.iter().find(|v| v.name == name) {
            Some(v) if v.multi => Ok(()),
            Some(_) => Err(format!("{at}.variable {name} must allow several values (multi)")),
            None => Err(format!("{at}.variable {name} is not a variable of this dashboard")),
        }
    };

    check_tags("model.tags", &model.tags)?;

    if model.rows.len() > MAX_ROWS {
        return Err(format!("model.rows takes at most {MAX_ROWS} entries"));
    }
    let mut row_ids = BTreeSet::new();
    for (i, r) in model.rows.iter().enumerate() {
        let at = format!("model.rows[{i}]");
        check_id(&format!("{at}.id"), &r.id)?;
        if !row_ids.insert(r.id.as_str()) {
            return Err(format!("{at}.id {} is used twice", r.id));
        }
        check_text(&format!("{at}.title"), &r.title, 0, MAX_TITLE_CHARS)?;
        if let Some(repeat) = &r.repeat {
            repeatable(&format!("{at}.repeat"), &repeat.variable)?;
        }
    }

    if model.annotations.len() > MAX_ANNOTATION_QUERIES {
        return Err(format!("model.annotations takes at most {MAX_ANNOTATION_QUERIES} entries"));
    }
    let mut annotation_ids = BTreeSet::new();
    for (i, a) in model.annotations.iter().enumerate() {
        let at = format!("model.annotations[{i}]");
        check_id(&format!("{at}.id"), &a.id)?;
        if !annotation_ids.insert(a.id.as_str()) {
            return Err(format!("{at}.id {} is used twice", a.id));
        }
        check_text(&format!("{at}.name"), &a.name, 1, MAX_TITLE_CHARS)?;
        check_id(&format!("{at}.datasourceId"), &a.datasource_id)?;
        if let Some(color) = a.color
            && !(1..=ANNOTATION_COLORS).contains(&color)
        {
            return Err(format!("{at}.color must be 1 to {ANNOTATION_COLORS}"));
        }
    }

    if model.links.len() > MAX_LINKS {
        return Err(format!("model.links takes at most {MAX_LINKS} entries"));
    }
    for (i, link) in model.links.iter().enumerate() {
        let at = format!("model.links[{i}]");
        match link {
            DashboardLink::Dashboards { tag, title, .. } => {
                check_tag(&format!("{at}.tag"), tag)?;
                check_text(&format!("{at}.title"), title, 0, MAX_TITLE_CHARS)?;
            }
            DashboardLink::Url { title, url, .. } => {
                check_text(&format!("{at}.title"), title, 1, MAX_TITLE_CHARS)?;
                check_url(&format!("{at}.url"), url)?;
            }
        }
    }

    if model.panels.len() > MAX_PANELS {
        return Err(format!("model.panels takes at most {MAX_PANELS} entries"));
    }
    let mut ids = BTreeSet::new();
    for (i, p) in model.panels.iter().enumerate() {
        let at = format!("model.panels[{i}]");
        check_id(&format!("{at}.id"), &p.id)?;
        if !ids.insert(p.id.as_str()) {
            return Err(format!("{at}.id {} is used twice", p.id));
        }
        let row = match &p.row_id {
            Some(row_id) => Some(
                model
                    .rows
                    .iter()
                    .find(|r| &r.id == row_id)
                    .ok_or_else(|| format!("{at}.rowId {row_id} is not a row of this dashboard"))?,
            ),
            None => None,
        };
        if let Some(repeat) = &p.repeat {
            repeatable(&format!("{at}.repeat"), &repeat.variable)?;
            if row.is_some_and(|r| r.repeat.is_some()) {
                return Err(format!("{at}.repeat: a panel in a repeated row repeats with its row"));
            }
            if let Some(n) = repeat.max_per_row
                && !(1..=MAX_PER_ROW).contains(&n)
            {
                return Err(format!("{at}.repeat.maxPerRow must be 1 to {MAX_PER_ROW}"));
            }
        }
        if let Some(library) = &p.library_panel_id {
            check_id(&format!("{at}.libraryPanelId"), library)?;
            if !p.targets.is_empty() {
                return Err(format!("{at}.targets must be empty: the library panel holds the queries"));
            }
            // The slot holds the place only; steps and links are the library panel's.
            if !p.transformations.is_empty() {
                return Err(format!("{at}.transformations must be empty: the library panel holds them"));
            }
            if !p.links.is_empty() {
                return Err(format!("{at}.links must be empty: the library panel holds them"));
            }
        }
        check_panel_time(&at, p.time_from.as_deref(), p.time_shift.as_deref())?;
        check_panel_links(&at, &p.links)?;
        check_id(&format!("{at}.type"), &p.kind)?;
        check_text(&format!("{at}.title"), &p.title, 0, MAX_TITLE_CHARS)?;
        check_grid(&p.grid).map_err(|e| format!("{at}.grid: {e}"))?;
        if p.targets.len() > MAX_TARGETS {
            return Err(format!("{at}.targets takes at most {MAX_TARGETS} entries"));
        }
        let mut ref_ids = BTreeSet::new();
        for (j, t) in p.targets.iter().enumerate() {
            let at = format!("{at}.targets[{j}]");
            check_id(&format!("{at}.refId"), &t.ref_id)?;
            if !ref_ids.insert(t.ref_id.as_str()) {
                return Err(format!("{at}.refId {} is used twice in this panel", t.ref_id));
            }
            check_id(&format!("{at}.datasourceId"), &t.datasource_id)?;
        }
        // Steps work on the frames of this panel's own queries.
        crate::analysis::check_steps(&p.transformations, &ref_ids, &format!("{at}.transformations"))?;
    }
    Ok(())
}

fn check_grid(g: &Grid) -> Result<(), String> {
    if g.w == 0 || g.w > GRID_COLUMNS {
        return Err(format!("w must be 1 to {GRID_COLUMNS}"));
    }
    // Checked: x and w come from the client and may be anything up to u32::MAX.
    if g.x.checked_add(g.w).is_none_or(|end| end > GRID_COLUMNS) {
        return Err(format!("x + w must not exceed {GRID_COLUMNS} columns"));
    }
    if g.h == 0 || g.h > MAX_PANEL_HEIGHT {
        return Err(format!("h must be 1 to {MAX_PANEL_HEIGHT}"));
    }
    if g.y > MAX_GRID_Y {
        return Err(format!("y must be 0 to {MAX_GRID_Y}"));
    }
    Ok(())
}

/// A tag: 1 to 50 characters without control characters or surrounding spaces.
pub fn check_tag(what: &str, tag: &str) -> Result<(), String> {
    check_text(what, tag, 1, MAX_TAG_CHARS)?;
    if tag.trim() != tag {
        return Err(format!("{what} must not start or end with spaces"));
    }
    Ok(())
}

/// Up to 20 tags, each once regardless of letter case.
pub fn check_tags(what: &str, tags: &[String]) -> Result<(), String> {
    if tags.len() > MAX_TAGS {
        return Err(format!("{what} takes at most {MAX_TAGS} entries"));
    }
    let mut seen = BTreeSet::new();
    for (i, tag) in tags.iter().enumerate() {
        check_tag(&format!("{what}[{i}]"), tag)?;
        if !seen.insert(tag.to_lowercase()) {
            return Err(format!("{what}[{i}] {tag} is used twice"));
        }
    }
    Ok(())
}

/// Schemes a link may open. Anything else, `javascript:`, `data:` and `vbscript:` included, could
/// run code or load content in the viewer's browser.
const LINK_SCHEMES: &[&str] = &["http", "https", "mailto"];

/// A link address: `http://`, `https://` or `mailto:` written out at the start, or a path on this
/// server (`/dashboards/...`, not `//host`). Variables may appear anywhere after that, so the
/// scheme never comes from a variable; the browser checks the filled-in address again.
pub fn check_url(what: &str, url: &str) -> Result<(), String> {
    check_text(what, url, 1, MAX_URL_CHARS)?;
    if url.trim() != url {
        return Err(format!("{what} must not start or end with spaces"));
    }
    if url.starts_with('/') {
        return if url.starts_with("//") || url.starts_with("/\\") {
            Err(format!("{what} must name the scheme (https://) for another server"))
        } else {
            Ok(())
        };
    }
    let scheme = url.split_once(':').map(|(scheme, _)| scheme.to_ascii_lowercase());
    match scheme {
        Some(s) if LINK_SCHEMES.contains(&s.as_str()) => {
            let rest = &url[s.len() + 1..];
            if s != "mailto" && !rest.starts_with("//") {
                return Err(format!("{what} must start with {s}://"));
            }
            Ok(())
        }
        _ => Err(format!("{what} must start with http://, https://, mailto: or /")),
    }
}

/// The dashboard's own time zone, fiscal year, now delay and refresh intervals.
fn check_time_options(model: &DashboardModel) -> Result<(), String> {
    if let Some(zone) = &model.time_zone
        && zone != "browser"
        && zone.parse::<chrono_tz::Tz>().is_err()
    {
        return Err("model.timeZone must be \"browser\" or a known time zone such as Europe/Berlin".into());
    }
    if let Some(month) = model.fiscal_year_start_month
        && !(1..=12).contains(&month)
    {
        return Err("model.fiscalYearStartMonth must be 1 to 12".into());
    }
    if let Some(delay) = &model.now_delay
        && !(is_duration(delay) && delay.ends_with(NOW_DELAY_UNITS))
    {
        return Err("model.nowDelay must be a length in seconds, minutes, hours or days like \"1m\"".into());
    }
    if model.refresh_intervals.len() > MAX_REFRESH_INTERVALS {
        return Err(format!("model.refreshIntervals takes at most {MAX_REFRESH_INTERVALS} entries"));
    }
    for (i, seconds) in model.refresh_intervals.iter().enumerate() {
        if !(MIN_REFRESH_SECONDS..=MAX_REFRESH_SECONDS).contains(seconds) {
            return Err(format!(
                "model.refreshIntervals[{i}] must be {MIN_REFRESH_SECONDS} to {MAX_REFRESH_SECONDS} seconds"
            ));
        }
        if i > 0 && model.refresh_intervals[i - 1] >= *seconds {
            return Err(format!("model.refreshIntervals[{i}] must be longer than the one before"));
        }
    }
    Ok(())
}

/// `timeFrom` is a range relative to now that ends now (`now-24h`, `now-7d/d`); `timeShift` a
/// length (`1d`, `2w`).
fn check_panel_time(at: &str, from: Option<&str>, shift: Option<&str>) -> Result<(), String> {
    if let Some(from) = from
        && !(from.starts_with("now-") && is_time(from))
    {
        return Err(format!("{at}.timeFrom must be relative like \"now-24h\""));
    }
    if let Some(shift) = shift
        && !is_duration(shift)
    {
        return Err(format!("{at}.timeShift must be a length like \"1d\""));
    }
    Ok(())
}

/// One to five digits and a unit: `90m`, `1d`, `2w`, `1M`, `1y`.
pub fn is_duration(text: &str) -> bool {
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    let mut unit = text[digits..].chars();
    (1..=5).contains(&digits)
        && text[..digits].parse::<u32>().is_ok_and(|n| n > 0)
        && unit.next().is_some_and(|u| UNITS.contains(&u))
        && unit.next().is_none()
}

fn check_panel_links(at: &str, links: &[PanelLink]) -> Result<(), String> {
    if links.len() > MAX_PANEL_LINKS {
        return Err(format!("{at}.links takes at most {MAX_PANEL_LINKS} entries"));
    }
    for (j, link) in links.iter().enumerate() {
        check_text(&format!("{at}.links[{j}].title"), &link.title, 1, MAX_TITLE_CHARS)?;
        check_url(&format!("{at}.links[{j}].url"), &link.url)?;
    }
    Ok(())
}

/// What a library panel stores: a panel without its place (`id`, `grid`, `rowId`, `repeat`),
/// with the `schemaVersion` it was written with. Older ones are migrated on read like a
/// dashboard, by the same steps.
pub const LIBRARY_PLACE_FIELDS: &[&str] = &["id", "grid", "rowId", "repeat", "libraryPanelId"];

/// Migrates and validates a library panel's content; answers it with defaults filled in and the
/// current `schemaVersion`. Messages name the place as `model.targets[0]...`.
pub fn parse_library_panel(raw: Value) -> Result<Value, String> {
    let Value::Object(mut fields) = raw else { return Err("model must be an object".into()) };
    if let Some(place) = LIBRARY_PLACE_FIELDS.iter().find(|f| fields.contains_key(**f)) {
        return Err(format!("model.{place}: the dashboard decides where a library panel goes"));
    }
    let version = fields.remove("schemaVersion").ok_or("model.schemaVersion must be a whole number")?;
    fields.insert("id".into(), Value::from("library"));
    fields.insert("grid".into(), serde_json::json!({ "x": 0, "y": 0, "w": 1, "h": 1 }));
    // A dashboard around the panel runs the same migrations and checks as any dashboard.
    let wrapped = serde_json::json!({
        "schemaVersion": version,
        "title": "library",
        "timeRange": { "from": "now-1h", "to": "now" },
        "panels": [Value::Object(fields)],
    });
    let model = parse(wrapped).map_err(|e| e.replace("model.panels[0]", "model"))?;
    let panel = model.panels.into_iter().next().ok_or("model: the panel went missing")?;
    let mut out = serde_json::to_value(&panel).map_err(|e| format!("model: {e}"))?;
    let out_fields = out.as_object_mut().ok_or("model must be an object")?;
    for place in LIBRARY_PLACE_FIELDS {
        out_fields.remove(*place);
    }
    out_fields.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    Ok(out)
}

/// The library panel content as a panel, for running its queries.
pub fn library_panel_as_panel(content: &Value) -> Result<Panel, String> {
    let mut fields = content.as_object().cloned().ok_or("library panel model must be an object")?;
    fields.remove("schemaVersion");
    fields.insert("id".into(), Value::from("library"));
    fields.insert("grid".into(), serde_json::json!({ "x": 0, "y": 0, "w": 1, "h": 1 }));
    serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())
}

/// A time range as JSON (`{"from": "now-6h", "to": "now"}`), for settings that hold one.
pub fn check_time_range(value: &Value) -> Result<(), String> {
    let range: TimeRange =
        serde_json::from_value(value.clone()).map_err(|_| "must be {\"from\", \"to\"}".to_string())?;
    check_range(&range)
}

fn check_range(range: &TimeRange) -> Result<(), String> {
    for (what, t) in [("from", &range.from), ("to", &range.to)] {
        if !is_time(t) {
            return Err(format!("{what} must be \"now\", relative like \"now-6h\" or an ISO time"));
        }
    }
    Ok(())
}

/// `now`, `now-6h`, `now-1d/d`, `now+15m`, `now-1fy/fy`; or an ISO 8601 date or date-time with
/// zone.
fn is_time(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix("now") {
        return is_relative(rest);
    }
    is_iso_time(s)
}

const UNITS: &[char] = &['s', 'm', 'h', 'd', 'w', 'M', 'y'];
/// Fiscal year and fiscal quarter, counted from the dashboard's `fiscalYearStartMonth`.
const FISCAL_UNITS: &[&str] = &["fy", "fQ"];

/// The unit at the start of `text` and what follows it.
fn strip_unit(text: &str) -> Option<&str> {
    if let Some(rest) = FISCAL_UNITS.iter().find_map(|u| text.strip_prefix(u)) {
        return Some(rest);
    }
    let mut chars = text.chars();
    chars.next().filter(|u| UNITS.contains(u)).map(|_| chars.as_str())
}

fn is_relative(mut rest: &str) -> bool {
    while let Some(after_sign) = rest.strip_prefix(['+', '-']) {
        let digits = after_sign.chars().take_while(char::is_ascii_digit).count();
        // Five digits cover a century in hours; more is a typo.
        if digits == 0 || digits > 5 {
            return false;
        }
        let Some(tail) = strip_unit(&after_sign[digits..]) else { return false };
        rest = tail;
    }
    match rest.strip_prefix('/') {
        Some(unit) => strip_unit(unit).is_some_and(str::is_empty),
        None => rest.is_empty(),
    }
}

fn is_iso_time(s: &str) -> bool {
    let bytes = s.as_bytes();
    let num = |range: std::ops::Range<usize>, max: u32| -> Option<u32> {
        let part = s.get(range)?;
        if !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok().filter(|n| *n <= max)
    };
    let date_ok = s.len() >= 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && num(0..4, 9999).is_some()
        && num(5..7, 12).is_some_and(|m| m >= 1)
        && num(8..10, 31).is_some_and(|d| d >= 1);
    if !date_ok {
        return false;
    }
    if s.len() == 10 {
        return true;
    }
    if bytes[10] != b'T' || s.len() < 16 || bytes[13] != b':' {
        return false;
    }
    if num(11..13, 23).is_none() || num(14..16, 59).is_none() {
        return false;
    }
    let mut rest = &s[16..];
    if let Some(secs) = rest.strip_prefix(':') {
        if secs.get(..2).is_none_or(|p| !p.bytes().all(|b| b.is_ascii_digit()) || p > "60") {
            return false;
        }
        rest = &secs[2..];
        if let Some(frac) = rest.strip_prefix('.') {
            let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 || digits > 9 {
                return false;
            }
            rest = &frac[digits..];
        }
    }
    match rest {
        "Z" => true,
        offset => {
            let ob = offset.as_bytes();
            offset.len() == 6
                && matches!(ob[0], b'+' | b'-')
                && ob[3] == b':'
                && offset[1..3].parse::<u32>().is_ok_and(|h| h <= 23)
                && offset[4..6].parse::<u32>().is_ok_and(|m| m <= 59)
                && offset[1..3].bytes().chain(offset[4..6].bytes()).all(|b| b.is_ascii_digit())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "schemaVersion": 2,
            "title": "Umsatz Übersicht",
            "timeRange": { "from": "now-6h", "to": "now" },
            "variables": [
                { "name": "region", "type": "query", "datasourceId": "ds-2", "query": "SELECT region FROM r" },
                { "name": "step", "type": "custom", "options": ["1m", "5m"] }
            ],
            "panels": [
                { "id": "p1", "type": "timeseries", "title": "Bestellungen", "grid": { "x": 0, "y": 0, "w": 12, "h": 8 },
                  "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT 1" } },
                               { "refId": "B", "datasourceId": "ds-1", "query": {} } ] },
                { "id": "p2", "type": "text", "grid": { "x": 12, "y": 0, "w": 12, "h": 8 } }
            ]
        })
    }

    /// The model with one field set (added if missing); the last path element is an object key.
    fn with(mut model: Value, path: &[&str], value: Value) -> Value {
        let (key, parent) = path.split_last().unwrap();
        let pointer: String = parent.iter().map(|p| format!("/{p}")).collect();
        model.pointer_mut(&pointer).unwrap().as_object_mut().unwrap().insert(key.to_string(), value);
        model
    }

    #[test]
    fn a_valid_model_round_trips_with_defaults_filled_in() {
        let model = parse(sample()).unwrap();
        assert_eq!(model.panels[1].targets.len(), 0);
        let back = serde_json::to_value(&model).unwrap();
        assert_eq!(back["panels"][1]["options"], json!({}));
        assert_eq!(back["panels"][1]["fieldConfig"], json!({}));
        assert_eq!(parse(back).unwrap(), model);
        assert_eq!(model.datasource_ids().into_iter().collect::<Vec<_>>(), ["ds-1", "ds-2"]);
    }

    #[test]
    fn invalid_models_are_refused_with_the_place() {
        for (path, value, expect) in [
            (vec!["panels", "0", "grid", "w"], json!(0), "panels[0].grid: w"),
            (vec!["panels", "0", "grid", "w"], json!(25), "panels[0].grid: w"),
            (vec!["panels", "1", "grid", "x"], json!(13), "panels[1].grid: x + w"),
            (vec!["panels", "0", "grid", "h"], json!(0), "panels[0].grid: h"),
            (vec!["panels", "0", "grid", "y"], json!(-1), "model"),
            (vec!["panels", "1", "id"], json!("p1"), "panels[1].id p1 is used twice"),
            (vec!["panels", "0", "id"], json!(""), "panels[0].id"),
            (vec!["panels", "0", "targets", "1", "refId"], json!("A"), "refId A is used twice"),
            (vec!["panels", "0", "targets", "0", "datasourceId"], json!(""), "datasourceId"),
            (vec!["variables", "1", "name"], json!("region"), "used twice"),
            (vec!["variables", "1", "name"], json!("1st"), "variables[1].name"),
            (vec!["variables", "0", "datasourceId"], Value::Null, "required for a query variable"),
            (vec!["variables", "1", "datasourceId"], json!("ds-1"), "only to query variables"),
            (vec!["title"], json!("  "), "model.title"),
            (vec!["title"], json!("x".repeat(201)), "model.title"),
            (vec!["timeRange", "from"], json!("gestern"), "timeRange"),
            (vec!["refreshSeconds"], json!(1), "refreshSeconds"),
            (vec!["unknownField"], json!(1), "unknown field"),
            (vec!["panels", "0", "colour"], json!("red"), "unknown field"),
        ] {
            let err = parse(with(sample(), &path, value)).unwrap_err();
            assert!(err.contains(expect), "{path:?}: {err}");
        }
    }

    #[test]
    fn panel_options_are_checked_where_a_write_changes_them() {
        let checked = |model: Value, previous: Option<&DashboardModel>| {
            let model = parse(model).expect("reading never checks panel options");
            check_panel_options(&model, previous)
        };
        let odd = with(sample(), &["panels", "0", "options"], json!({ "lineWidth": 9 }));
        let (panel, err) = checked(odd.clone(), None).unwrap_err();
        assert_eq!(panel, "Bestellungen", "panels are named by their title");
        assert!(err.contains("model.panels[0].options.lineWidth"), "{err}");
        let (_, err) =
            checked(with(sample(), &["panels", "0", "fieldConfig"], json!({ "defaults": { "decimals": 99 } })), None)
                .unwrap_err();
        assert!(err.contains("model.panels[0].fieldConfig"), "{err}");
        // A stored panel that predates the rule may stay as it is; changing it means fixing it.
        let stored = parse(odd.clone()).unwrap();
        assert!(checked(with(odd.clone(), &["title"], json!("Neu")), Some(&stored)).is_ok());
        let changed = with(odd.clone(), &["panels", "0", "options"], json!({ "lineWidth": 8 }));
        assert!(checked(changed, Some(&stored)).is_err());
        let retyped = with(odd, &["panels", "0", "type"], json!("stat"));
        assert!(checked(retyped, Some(&stored)).is_err(), "another type is another panel");
        assert!(checked(sample(), None).is_ok());
    }

    #[test]
    fn graph_panels_stored_before_their_check_keep_saving_while_unchanged() {
        let checked = |model: Value, previous: Option<&DashboardModel>| {
            let model = parse(model).expect("reading never checks panel options");
            check_panel_options(&model, previous)
        };
        let network = with(sample(), &["panels", "1", "type"], json!("network"));
        let odd = with(network, &["panels", "1", "options"], json!({ "nodeLimit": 50_000, "layout": "radial" }));
        let (_, err) = checked(odd.clone(), None).unwrap_err();
        assert!(err.contains("model.panels[1].options"), "{err}");
        let stored = parse(odd.clone()).unwrap();
        assert!(checked(with(odd.clone(), &["title"], json!("Neu")), Some(&stored)).is_ok());
        let changed = with(odd.clone(), &["panels", "1", "options"], json!({ "nodeLimit": 40_000 }));
        assert!(checked(changed, Some(&stored)).unwrap_err().1.contains("options.nodeLimit"));
        let fixed = with(odd, &["panels", "1", "options"], json!({ "nodeLimit": 5_000, "cluster": "off" }));
        assert!(checked(fixed, Some(&stored)).is_ok());
    }

    #[test]
    fn huge_grid_numbers_are_refused_without_overflow() {
        for (x, w) in [(u32::MAX, 1), (1, u32::MAX), (u32::MAX, u32::MAX), (u32::MAX, 0)] {
            let mut model = with(sample(), &["panels", "0", "grid", "x"], json!(x));
            model = with(model, &["panels", "0", "grid", "w"], json!(w));
            let err = parse(model).unwrap_err();
            assert!(err.contains("panels[0].grid"), "{x} {w}: {err}");
        }
    }

    #[test]
    fn sizes_and_counts_are_bounded() {
        let big = with(sample(), &["panels", "0", "options"], json!({ "text": "x".repeat(MAX_MODEL_BYTES) }));
        assert!(parse(big).unwrap_err().contains("at most 1048576"));
        let many =
            with(sample(), &["panels", "0", "transformations"], json!(vec![json!({}); crate::analysis::MAX_STEPS + 1]));
        assert!(parse(many).unwrap_err().contains("transformations takes at most"));
        let targets: Vec<Value> =
            (0..=MAX_TARGETS).map(|i| json!({ "refId": format!("R{i}"), "datasourceId": "ds", "query": {} })).collect();
        assert!(parse(with(sample(), &["panels", "0", "targets"], json!(targets))).unwrap_err().contains("targets"));
        let variables: Vec<Value> =
            (0..=MAX_VARIABLES).map(|i| json!({ "name": format!("v{i}"), "type": "constant" })).collect();
        assert!(parse(with(sample(), &["variables"], json!(variables))).unwrap_err().contains("variables"));
        let panels: Vec<Value> = (0..=MAX_PANELS)
            .map(|i| json!({ "id": format!("p{i}"), "type": "text", "grid": { "x": 0, "y": 0, "w": 1, "h": 1 } }))
            .collect();
        assert!(parse(with(sample(), &["panels"], json!(panels))).unwrap_err().contains("panels"));
    }

    #[test]
    fn panel_ids_may_be_unicode() {
        let model = with(sample(), &["panels", "0", "id"], json!("Übersicht 1"));
        assert!(parse(model).is_ok());
    }

    #[test]
    fn times_accept_relative_and_iso_forms() {
        for ok in [
            "now",
            "now-6h",
            "now-1d/d",
            "now/w",
            "now+15m",
            "now-1M-2d",
            "now/fy",
            "now-1fy/fy",
            "now-2fQ/fQ",
            "now+1fQ",
            "2026-02-28",
            "2026-10-20T08:15Z",
            "2026-10-20T08:15:30.123+02:00",
            "2026-10-20T23:59:60Z",
        ] {
            assert!(is_time(ok), "{ok}");
        }
        for bad in [
            "",
            "now-",
            "now-6",
            "now-6x",
            "now/",
            "now/dd",
            "now-999999h",
            "now/f",
            "now-1fq",
            "now-1FY",
            "now/fyy",
            "now/fy/d",
            "now-fy",
            "2026-13-01",
            "2026-10-20T24:00Z",
            "2026-10-20T08:15",
            "2026-10-20 08:15Z",
            "2026-10-20T08:15+2",
            "2026-1ä-20",
            "tomorrow",
        ] {
            assert!(!is_time(bad), "{bad}");
        }
    }

    #[test]
    fn time_options_are_optional_and_checked() {
        let plain = parse(sample()).unwrap();
        let out = serde_json::to_value(&plain).unwrap();
        for key in ["timeZone", "weekStart", "fiscalYearStartMonth", "nowDelay", "refreshIntervals", "sharedCursor"] {
            assert!(out.get(key).is_none(), "{key} is left out while unset");
        }
        let mut full = sample();
        for (key, value) in [
            ("timeZone", json!("America/Argentina/Buenos_Aires")),
            ("weekStart", json!("sunday")),
            ("fiscalYearStartMonth", json!(4)),
            ("nowDelay", json!("5m")),
            ("refreshIntervals", json!([10, 60, 900])),
            ("sharedCursor", json!("tooltip")),
        ] {
            full = with(full, &[key], value);
        }
        let model = parse(full.clone()).unwrap();
        assert_eq!(model.fiscal_year_start_month, Some(4));
        assert_eq!(model.shared_cursor, Some(SharedCursor::Tooltip));
        assert_eq!(serde_json::to_value(&model).unwrap()["refreshIntervals"], json!([10, 60, 900]));
        assert!(parse(with(sample(), &["timeZone"], json!("browser"))).is_ok());
        assert!(parse(with(sample(), &["sharedCursor"], json!("off"))).is_ok());
        for (key, value, expect) in [
            ("timeZone", json!("Europe/../etc"), "model.timeZone"),
            ("timeZone", json!(""), "model.timeZone"),
            ("timeZone", json!("Europe/Atlantis"), "model.timeZone"),
            ("weekStart", json!("friday"), "unknown variant"),
            ("fiscalYearStartMonth", json!(0), "fiscalYearStartMonth"),
            ("fiscalYearStartMonth", json!(13), "fiscalYearStartMonth"),
            ("nowDelay", json!("1y"), "model.nowDelay"),
            ("nowDelay", json!("0m"), "model.nowDelay"),
            ("nowDelay", json!("-1m"), "model.nowDelay"),
            ("refreshIntervals", json!([1]), "refreshIntervals[0]"),
            ("refreshIntervals", json!([60, 30]), "refreshIntervals[1]"),
            ("refreshIntervals", json!([60, 60]), "refreshIntervals[1]"),
            ("refreshIntervals", json!([86_401]), "refreshIntervals[0]"),
            ("refreshIntervals", json!((1..=21).map(|i| i * 10).collect::<Vec<_>>()), "at most 20"),
            ("sharedCursor", json!("always"), "unknown variant"),
        ] {
            let err = parse(with(sample(), &[key], value.clone())).unwrap_err();
            assert!(err.contains(expect), "{key} {value}: {err}");
        }
        // Fiscal units belong to the range grammar everywhere a range is stored.
        assert!(parse(with(sample(), &["timeRange"], json!({ "from": "now-1fy/fy", "to": "now-1fy/fy" }))).is_ok());
    }

    #[test]
    fn the_step_list_covers_every_version() {
        assert_eq!(STEPS.len() as u64, SCHEMA_VERSION - 1);
        assert_eq!(migrate(sample()).unwrap(), sample(), "the current version passes unchanged");
    }

    #[test]
    fn a_version_1_model_parses_with_empty_version_2_parts() {
        let v1 = with(sample(), &["schemaVersion"], json!(1));
        let model = parse(v1).unwrap();
        assert_eq!(model.schema_version, SCHEMA_VERSION);
        assert!(model.rows.is_empty() && model.tags.is_empty() && model.links.is_empty());
        assert!(model.annotations.is_empty());
        assert!(model.panels.iter().all(|p| p.row_id.is_none()
            && p.repeat.is_none()
            && p.links.is_empty()
            && p.time_from.is_none()
            && p.time_shift.is_none()
            && p.library_panel_id.is_none()));
        assert!(model.variables.iter().all(|v| !v.multi));
    }

    /// Every part version 2 adds, valid.
    fn sample_v2() -> Value {
        let mut m = sample();
        m["variables"][1]["multi"] = json!(true);
        m["tags"] = json!(["Vertrieb", "Österreich"]);
        m["rows"] = json!([
            { "id": "r1", "title": "Details", "collapsed": true },
            { "id": "r2", "title": "Je Schritt", "repeat": { "variable": "step" } }
        ]);
        m["annotations"] = json!([
            { "id": "a1", "name": "Releases", "datasourceId": "ds-3", "query": { "sql": "SELECT 1" }, "color": 3 }
        ]);
        m["links"] = json!([
            { "type": "dashboards", "tag": "Vertrieb", "title": "Mehr Vertrieb" },
            { "type": "url", "title": "Wiki", "url": "https://wiki.example.de/${region}", "newTab": true }
        ]);
        m["panels"][0]["timeFrom"] = json!("now-24h");
        m["panels"][0]["timeShift"] = json!("1d");
        m["panels"][0]["repeat"] = json!({ "variable": "step", "direction": "horizontal", "maxPerRow": 4 });
        m["panels"][0]["links"] = json!([{ "title": "Bestellung", "url": "/dashboards/x?var-id=${__value}" }]);
        m["panels"][1]["rowId"] = json!("r1");
        m["panels"][1]["libraryPanelId"] = json!("lib-1");
        m
    }

    #[test]
    fn version_2_parts_round_trip() {
        let model = parse(sample_v2()).unwrap();
        assert_eq!(model.rows.len(), 2);
        assert!(model.rows[0].collapsed && !model.rows[1].collapsed);
        assert!(model.annotations[0].enabled, "annotation queries are on by default");
        assert_eq!(model.library_panel_ids().into_iter().collect::<Vec<_>>(), ["lib-1"]);
        assert!(model.datasource_ids().contains("ds-3"), "annotation queries are stored queries");
        let back = serde_json::to_value(&model).unwrap();
        assert_eq!(back["links"][1]["newTab"], true);
        assert_eq!(back["links"][0]["newTab"], false);
        assert_eq!(parse(back).unwrap(), model);
    }

    #[test]
    fn version_2_parts_are_checked() {
        for (path, value, expect) in [
            (vec!["rows", "1", "id"], json!("r1"), "rows[1].id r1 is used twice"),
            (vec!["rows", "1", "repeat", "variable"], json!("region"), "must allow several values"),
            (vec!["rows", "1", "repeat", "variable"], json!("nope"), "is not a variable"),
            (vec!["panels", "1", "rowId"], json!("r9"), "rowId r9 is not a row"),
            (vec!["panels", "0", "repeat", "maxPerRow"], json!(25), "maxPerRow"),
            (vec!["panels", "0", "repeat", "direction"], json!("diagonal"), "unknown variant"),
            (vec!["panels", "0", "timeFrom"], json!("2026-10-01"), "timeFrom"),
            (vec!["panels", "0", "timeFrom"], json!("now"), "timeFrom"),
            (vec!["panels", "0", "timeShift"], json!("1x"), "timeShift"),
            (vec!["panels", "0", "timeShift"], json!("0d"), "timeShift"),
            (vec!["panels", "0", "links", "0", "url"], json!("javascript:alert(1)"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "url"], json!("JavaScript:alert(1)"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "url"], json!("${target}"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "url"], json!(" https://x.de"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "url"], json!("data:text/html,x"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "url"], json!("//evil.example"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "url"], json!("https:evil"), "links[0].url"),
            (vec!["panels", "0", "links", "0", "title"], json!(""), "links[0].title"),
            (vec!["links", "1", "url"], json!("vbscript:x"), "links[1].url"),
            (vec!["links", "0", "tag"], json!(""), "links[0].tag"),
            (vec!["links", "1", "kind"], json!("x"), "unknown field"),
            (vec!["tags"], json!(["a", "A"]), "used twice"),
            (vec!["tags"], json!([" a"]), "tags[0]"),
            (vec!["annotations", "0", "color"], json!(9), "color"),
            (vec!["annotations", "0", "name"], json!(""), "annotations[0].name"),
            (vec!["variables", "0", "multi"], json!(true), "ok"),
            (vec!["variables", "1", "type"], json!("textbox"), "multi is only"),
            (
                vec!["panels", "1", "targets"],
                json!([{ "refId": "A", "datasourceId": "ds", "query": {} }]),
                "library panel holds",
            ),
            (vec!["panels", "1", "transformations"], json!([{ "type": "x" }]), "transformations must be empty"),
            (vec!["panels", "1", "links"], json!([{ "title": "x", "url": "/x" }]), "links must be empty"),
        ] {
            let result = parse(with(sample_v2(), &path, value.clone()));
            if expect == "ok" {
                assert!(result.is_ok(), "{path:?}: {result:?}");
                continue;
            }
            let err = result.unwrap_err();
            assert!(err.contains(expect), "{path:?} = {value}: {err}");
        }
        // A panel may not repeat inside a repeated row.
        let mut nested = sample_v2();
        nested["panels"][0]["rowId"] = json!("r2");
        assert!(parse(nested).unwrap_err().contains("repeats with its row"));
        let too_many: Vec<Value> = (0..=MAX_TAGS).map(|i| json!(format!("t{i}"))).collect();
        assert!(parse(with(sample_v2(), &["tags"], json!(too_many))).unwrap_err().contains("tags takes at most"));
    }

    #[test]
    fn links_accept_web_mail_and_local_addresses() {
        for ok in ["https://x.de/a?b=${v}", "HTTP://x.de", "mailto:team@example.de", "/dashboards/1", "/d?x=//y"] {
            assert!(check_url("url", ok).is_ok(), "{ok}");
        }
        for bad in ["", "x.de", "ftp://x.de", "javascript://%0aalert(1)", "/\\evil", "https:/x", "\u{0}https://x"] {
            assert!(check_url("url", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn library_panels_use_the_panel_rules_and_the_same_migrations() {
        let content = json!({ "schemaVersion": 1, "type": "timeseries", "title": "Umsatz",
                              "targets": [ { "refId": "A", "datasourceId": "ds-1", "query": { "sql": "SELECT 1" } } ] });
        let parsed = parse_library_panel(content).unwrap();
        assert_eq!(parsed["schemaVersion"], SCHEMA_VERSION);
        assert_eq!(parsed["fieldConfig"], json!({}), "defaults are filled in");
        assert!(parsed.get("id").is_none() && parsed.get("grid").is_none());
        assert_eq!(library_panel_as_panel(&parsed).unwrap().targets.len(), 1);
        for (field, value, expect) in [
            ("grid", json!({ "x": 0, "y": 0, "w": 1, "h": 1 }), "model.grid"),
            ("libraryPanelId", json!("x"), "model.libraryPanelId"),
            ("type", json!(""), "model.type"),
            ("links", json!([{ "title": "x", "url": "javascript:1" }]), "model.links[0].url"),
            ("schemaVersion", json!(99), "newer Kalzit"),
        ] {
            let mut bad = parsed.clone();
            bad[field] = value;
            let err = parse_library_panel(bad).unwrap_err();
            assert!(err.contains(expect), "{field}: {err}");
        }
        let mut missing = parsed;
        missing.as_object_mut().unwrap().remove("schemaVersion");
        assert!(parse_library_panel(missing).is_err());
    }

    #[test]
    fn durations_are_counts_with_a_unit() {
        for ok in ["1d", "90m", "2w", "1M", "1y", "99999s"] {
            assert!(is_duration(ok), "{ok}");
        }
        for bad in ["", "d", "0d", "1", "1dd", "-1d", "123456s", "1.5h"] {
            assert!(!is_duration(bad), "{bad}");
        }
    }

    #[test]
    fn version_1_projections_become_steps_and_the_rest_is_dropped() {
        let mut v1 = with(sample(), &["schemaVersion"], json!(1));
        v1 = with(
            v1,
            &["panels", "0", "transformations"],
            json!([
                { "id": "x", "anything": true },
                7,
                { "type": "toFrame", "refId": "A", "columns": [
                    { "path": "at" }, { "path": "" }, { "path": "items.0.price", "name": "Preis", "type": "number" },
                    { "path": "raw", "type": "json" }, { "path": "n", "name": "" }, { "path": "at" }, { "path": "b", "name": "Preis" }
                ] },
                { "type": "toFrame", "refId": "B", "columns": [{ "path": "" }] }
            ]),
        );
        let v2 = v1_to_v2(v1.clone()).unwrap();
        assert_eq!(v2["schemaVersion"], 2);
        assert_eq!(
            v2["panels"][0]["transformations"],
            json!([{ "id": "projection-A", "type": "toFrame", "frame": "A", "columns": [
                { "path": "at" }, { "path": "items.0.price", "name": "Preis", "type": "number" },
                { "path": "raw" }, { "path": "n" }
            ] }]),
            "the projection keeps what version 2 accepts; one without columns goes"
        );
        assert!(v2["panels"][1].get("transformations").is_none(), "absent stays absent");
        assert_eq!(v2["panels"][0]["targets"], v1["panels"][0]["targets"], "nothing else changes");
        assert_eq!(v1_to_v2(v1.clone()).unwrap(), v2, "the same on every read");
        let model = parse(v1).expect("a stored version 1 model still reads");
        assert_eq!(model.panels[0].transformations.len(), 1);
    }

    /// Projections of a query the panel lacks would make the stored model unreadable; of two for
    /// one query, the last is the one the documents UI applied.
    #[test]
    fn version_1_projections_of_missing_queries_go_and_the_last_per_query_stays() {
        let mut v1 = with(sample(), &["schemaVersion"], json!(1));
        v1 = with(
            v1,
            &["panels", "0", "transformations"],
            json!([
                { "type": "toFrame", "refId": "Z", "columns": [{ "path": "a" }] },
                { "type": "toFrame", "refId": "A", "columns": [{ "path": "erste" }] },
                { "type": "toFrame", "refId": "B", "columns": [{ "path": "b" }] },
                { "type": "toFrame", "refId": "A", "columns": [{ "path": "zweite" }] }
            ]),
        );
        let v2 = v1_to_v2(v1.clone()).unwrap();
        assert_eq!(
            v2["panels"][0]["transformations"],
            json!([
                { "id": "projection-B", "type": "toFrame", "frame": "B", "columns": [{ "path": "b" }] },
                { "id": "projection-A", "type": "toFrame", "frame": "A", "columns": [{ "path": "zweite" }] }
            ])
        );
        assert!(parse(v1).is_ok(), "the stored model reads");
    }

    #[test]
    fn library_panel_slots_have_no_steps_and_library_content_checks_its_own() {
        let step = json!([{ "id": "s", "type": "calculate", "frame": "A", "name": "x", "expression": "1" }]);
        // A slot: no queries and no steps; the library panel holds them.
        let slot = with(sample(), &["panels", "0", "targets"], json!([]));
        let slot = with(slot, &["panels", "0", "libraryPanelId"], json!("lib-1"));
        let with_steps = with(slot.clone(), &["panels", "0", "transformations"], step.clone());
        let err = parse(with_steps).unwrap_err();
        assert!(err.contains("model.panels[0].transformations must be empty"), "{err}");
        assert!(parse(slot).is_ok(), "a slot with empty transformations is accepted");
        // The library panel's own steps are checked against its own queries.
        let content = json!({ "schemaVersion": SCHEMA_VERSION, "type": "table",
                              "targets": [{ "refId": "A", "datasourceId": "ds-1", "query": {} }],
                              "transformations": step });
        let parsed = parse_library_panel(content.clone()).unwrap();
        assert_eq!(parsed["transformations"][0]["frame"], "A");
        let mut other = content;
        other["transformations"][0]["frame"] = json!("B");
        let err = parse_library_panel(other).unwrap_err();
        assert!(err.contains("model.transformations[0]: there is no query B"), "{err}");
    }

    #[test]
    fn panels_keep_validated_analysis_steps() {
        let steps = json!([
            { "id": "s1", "type": "calculate", "frame": "A", "name": "Brutto", "expression": "[betrag] * 1.19" },
            { "id": "s2", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "outer", "disabled": true }
        ]);
        let model = parse(with(sample(), &["panels", "0", "transformations"], steps.clone())).unwrap();
        assert_eq!(model.panels[0].transformations, steps.as_array().unwrap().clone());
        for (bad, expect) in [
            (
                json!([{ "id": "s", "type": "calculate", "frame": "A", "name": "x", "expression": "1 +" }]),
                "model.panels[0].transformations[0].expression: unexpected input at 4",
            ),
            (
                json!([{ "id": "s", "type": "calculate", "frame": "C", "name": "x", "expression": "1" }]),
                "model.panels[0].transformations[0]: there is no query C",
            ),
            (json!([{ "id": "s", "type": "zauber" }]), "model.panels[0].transformations[0]: unknown variant"),
        ] {
            let err = parse(with(sample(), &["panels", "0", "transformations"], bad)).unwrap_err();
            assert!(err.contains(expect), "{err}");
        }
        // A panel without queries has no frames for steps to work on.
        let err = parse(with(
            sample(),
            &["panels", "1", "transformations"],
            json!([
                { "id": "s", "type": "calculate", "frame": "A", "name": "x", "expression": "1" }
            ]),
        ))
        .unwrap_err();
        assert!(err.contains("panels[1].transformations[0]: there is no query A"), "{err}");
    }

    #[test]
    fn newer_or_missing_versions_are_refused_clearly() {
        let err = migrate(with(sample(), &["schemaVersion"], json!(SCHEMA_VERSION + 1))).unwrap_err();
        assert!(err.contains("newer Kalzit") && err.contains(&format!("up to {SCHEMA_VERSION}")), "{err}");
        for bad in [json!(0), json!("1"), Value::Null, json!(-1)] {
            assert!(migrate(with(sample(), &["schemaVersion"], bad.clone())).is_err(), "{bad}");
        }
    }

    /// The step runner with made-up steps, since version 1 has none yet.
    #[test]
    fn steps_run_in_order_and_must_advance_the_version() {
        fn one_to_two(mut m: Value) -> Result<Value, String> {
            m["schemaVersion"] = json!(2);
            m["trail"] = json!("a");
            Ok(m)
        }
        fn two_to_three(mut m: Value) -> Result<Value, String> {
            m["schemaVersion"] = json!(3);
            m["trail"] = json!(format!("{}b", m["trail"].as_str().unwrap()));
            Ok(m)
        }
        fn forgets_the_version(m: Value) -> Result<Value, String> {
            Ok(m)
        }
        let steps: &[Step] = &[one_to_two, two_to_three];
        let v1 = json!({ "schemaVersion": 1 });
        assert_eq!(migrate_with(v1.clone(), steps, 3).unwrap(), json!({ "schemaVersion": 3, "trail": "ab" }));
        let v2 = json!({ "schemaVersion": 2, "trail": "x" });
        assert_eq!(migrate_with(v2, steps, 3).unwrap()["trail"], "xb");
        let err = migrate_with(v1.clone(), &[forgets_the_version], 2).unwrap_err();
        assert!(err.contains("did not produce 2"), "{err}");
        assert!(migrate_with(v1, &[], 2).unwrap_err().contains("no migration from schemaVersion 1"));
    }

    #[test]
    fn time_range_settings_use_the_same_rules() {
        assert!(check_time_range(&json!({ "from": "now-24h", "to": "now" })).is_ok());
        assert!(check_time_range(&json!({ "from": "now-24h" })).is_err());
        assert!(check_time_range(&json!("now-24h")).is_err());
    }
}
