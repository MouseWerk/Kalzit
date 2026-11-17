//! Kalzit's own PDF renderer for reports: no browser, no outside service, one binary on Windows
//! and Linux. It draws close to the UI, not pixel for pixel: A4 landscape, a cover with the
//! dashboard, time range and variable values, then one card per panel in the dashboard's order.
//!
//! Each result is drawn in its own shape: frames as time series, bars, stat values or a table,
//! documents as an indented tree excerpt, graphs as a static layout of nodes and edges. A panel
//! whose result the renderer cannot draw in its type, or that failed, gets a placeholder with the
//! reason; nothing is converted silently. Charts, tables and graphs are vector paths; text is
//! Instrument Sans (SIL Open Font License, `server/assets/fonts`), embedded as a subset.
//!
//! Everything is bounded: at most 8 series per chart, 25 table rows, 40 lines of documents and
//! 150 graph nodes per panel; what is left out is said under the panel.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use chrono::{NaiveDateTime, NaiveTime, TimeZone};
use chrono_tz::Tz;
use krilla::Document;
use krilla::color::rgb;
use krilla::geom::{Path, PathBuilder, Point};
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, LineCap, LineJoin, Stroke, StrokeDash};
use krilla::surface::Surface;
use krilla::text::{Font, TextDirection};
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;

use super::gather::{Content, Gathered, PanelOut, Results};
use super::model::ReportLanguage;
use crate::analysis::steps::number_at;
use crate::shapes::{DocumentSet, FieldType, Frame, GraphSet};

static LATIN: &[u8] = include_bytes!("../../assets/fonts/instrument-sans-latin.ttf");
static LATIN_EXT: &[u8] = include_bytes!("../../assets/fonts/instrument-sans-latin-ext.ttf");

/// A4 landscape, in points.
const PAGE_W: f32 = 842.0;
const PAGE_H: f32 = 595.0;
const MARGIN: f32 = 36.0;
const FOOTER: f32 = 22.0;
const CARD_PAD: f32 = 12.0;
const CARD_HEAD: f32 = 26.0;
const GAP: f32 = 12.0;
const ROW_H: f32 = 15.0;
const LINE_H: f32 = 13.0;

pub const MAX_SERIES: usize = 8;
pub const MAX_TABLE_ROWS: usize = 25;
pub const MAX_DOCUMENT_LINES: usize = 40;
pub const MAX_GRAPH_NODES: usize = 150;
pub const MAX_GRAPH_EDGES: usize = 2000;
/// Documents a card shows the start of.
pub const MAX_DOCUMENTS: usize = 20;
pub const MAX_POINTS: usize = 2000;
pub const MAX_BARS: usize = 24;
/// Spans a trace's waterfall shows.
pub const MAX_SPANS: usize = 40;
/// Characters of one text the renderer looks at; longer text is cut before it is measured.
const MAX_TEXT_CHARS: usize = 256;
/// Characters of a text panel the renderer reads.
const MAX_PANEL_TEXT_CHARS: usize = 20_000;
/// How long rendering one report may take.
pub const RENDER_DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
const MAX_TEXT_LINES: usize = 30;

type Rgb = (u8, u8, u8);
/// The UI's light theme (`ui/src/styles/tokens.css`), as sRGB.
const TEXT: Rgb = (23, 23, 26);
const MUTED: Rgb = (87, 87, 95);
const BORDER: Rgb = (225, 225, 228);
const GRID: Rgb = (238, 238, 241);
const SURFACE: Rgb = (255, 255, 255);
const BG: Rgb = (248, 248, 249);
/// `--chart-1` to `--chart-8`.
const PALETTE: [Rgb; 8] = [
    (56, 128, 176),
    (107, 66, 2),
    (28, 97, 156),
    (198, 113, 91),
    (24, 89, 61),
    (77, 18, 80),
    (121, 95, 18),
    (40, 40, 44),
];

/// A finished file.
pub struct Rendered {
    pub bytes: Vec<u8>,
    pub pages: usize,
}

/// The texts of the file, in the report's language.
struct Words {
    page: &'static str,
    of: &'static str,
    dashboard: &'static str,
    range: &'static str,
    variables: &'static str,
    generated: &'static str,
    not_shown: &'static str,
    no_data: &'static str,
    more_rows: &'static str,
    more_series: &'static str,
    more_documents: &'static str,
    more_nodes: &'static str,
    more_edges: &'static str,
    more_spans: &'static str,
    more_bars: &'static str,
    document: &'static str,
    not_drawn: &'static str,
    shape_mismatch: &'static str,
}

const DE: Words = Words {
    page: "Seite",
    of: "von",
    dashboard: "Dashboard",
    range: "Zeitraum",
    variables: "Variablen",
    generated: "Erstellt",
    not_shown: "Nicht dargestellt",
    no_data: "Keine Daten im Zeitraum.",
    more_rows: "weitere Zeilen nicht gezeigt (vollständig in der CSV-Datei).",
    more_series: "weitere Reihen nicht gezeigt.",
    more_documents: "weitere Dokumente oder Zeilen nicht gezeigt.",
    more_nodes: "weitere Knoten nicht gezeigt.",
    more_edges: "weitere Beziehungen nicht gezeigt.",
    more_spans: "weitere Spans nicht gezeigt; als Tabelle mit dem Schritt spanTable.",
    more_bars: "weitere Kategorien nicht gezeigt.",
    document: "Dokument",
    not_drawn: "Dieser Panel-Typ wird im PDF noch nicht gezeichnet; die Werte als Tabelle:",
    shape_mismatch: "Das Panel zeigt eine andere Ergebnisform als die Abfrage liefert",
};

const EN: Words = Words {
    page: "Page",
    of: "of",
    dashboard: "Dashboard",
    range: "Time range",
    variables: "Variables",
    generated: "Generated",
    not_shown: "Not shown",
    no_data: "No data in the time range.",
    more_rows: "more rows not shown (all of them in the CSV file).",
    more_series: "more series not shown.",
    more_documents: "more documents or lines not shown.",
    more_nodes: "more nodes not shown.",
    more_edges: "more relationships not shown.",
    more_spans: "more spans not shown; as a table with the spanTable step.",
    more_bars: "more categories not shown.",
    document: "Document",
    not_drawn: "This panel type is not drawn in PDF files yet; its values as a table:",
    shape_mismatch: "The panel shows another result shape than the query returns",
};

fn words(lang: ReportLanguage) -> &'static Words {
    match lang {
        ReportLanguage::De => &DE,
        ReportLanguage::En => &EN,
    }
}

// ---------------------------------------------------------------------------------------------
// Fonts and text

#[derive(Clone, Copy, PartialEq, Eq)]
enum Weight {
    Regular,
    Semibold,
}

struct Face {
    pdf: Font,
    shaper: rustybuzz::Face<'static>,
}

/// Instrument Sans in two weights, each as the Latin file and the Latin Extended one for the
/// characters the first does not have.
struct Fonts {
    faces: [[Face; 2]; 2],
}

impl Fonts {
    fn load() -> Result<Self, String> {
        let face = |data: &'static [u8], weight: f32| -> Result<Face, String> {
            let tag = krilla::text::Tag::new(b"wght");
            let pdf = Font::new_variable(data.into(), 0, &[(tag, weight)]).ok_or("the report font cannot be read")?;
            let mut shaper = rustybuzz::Face::from_slice(data, 0).ok_or("the report font cannot be read")?;
            shaper.set_variation(rustybuzz::ttf_parser::Tag::from_bytes(b"wght"), weight);
            Ok(Face { pdf, shaper })
        };
        Ok(Self {
            faces: [[face(LATIN, 400.0)?, face(LATIN_EXT, 400.0)?], [face(LATIN, 600.0)?, face(LATIN_EXT, 600.0)?]],
        })
    }

    fn pair(&self, weight: Weight) -> &[Face; 2] {
        &self.faces[usize::from(weight == Weight::Semibold)]
    }

    /// The text in runs of one file each.
    fn runs<'t>(&self, text: &'t str, weight: Weight) -> Vec<(usize, &'t str)> {
        let pair = self.pair(weight);
        let mut out: Vec<(usize, &'t str)> = Vec::new();
        let mut start = 0;
        let mut current = None;
        for (i, c) in text.char_indices() {
            let which =
                if pair[0].shaper.glyph_index(c).is_some() || pair[1].shaper.glyph_index(c).is_none() { 0 } else { 1 };
            match current {
                Some(w) if w == which => {}
                Some(w) => {
                    out.push((w, &text[start..i]));
                    start = i;
                    current = Some(which);
                }
                None => current = Some(which),
            }
        }
        if let Some(w) = current {
            out.push((w, &text[start..]));
        }
        out
    }

    fn width(&self, text: &str, size: f32, weight: Weight) -> f32 {
        let pair = self.pair(weight);
        self.runs(text, weight).into_iter().map(|(i, run)| advance(&pair[i].shaper, run, size)).sum()
    }

    /// `text` cut to fit `max` with an ellipsis: at most `MAX_TEXT_CHARS` characters are looked at,
    /// and the cut is found by halving, so a long cell costs a few shapings, not one per character.
    fn fit(&self, text: &str, max: f32, size: f32, weight: Weight) -> String {
        let chars: Vec<char> = text.chars().take(MAX_TEXT_CHARS + 1).collect();
        let whole = chars.len() <= MAX_TEXT_CHARS;
        if whole && self.width(text, size, weight) <= max {
            return text.to_string();
        }
        let with_ellipsis = |n: usize| chars[..n].iter().collect::<String>() + "…";
        // The longest prefix that fits with the ellipsis.
        let (mut lo, mut hi) = (0usize, chars.len().min(MAX_TEXT_CHARS));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if self.width(&with_ellipsis(mid), size, weight) <= max {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        if lo == 0 && self.width("…", size, weight) > max { String::new() } else { with_ellipsis(lo) }
    }
    /// Lines of at most `max` wide, broken between words (a word longer than a line is cut).
    fn wrap(&self, text: &str, max: f32, size: f32, weight: Weight) -> Vec<String> {
        let mut lines = Vec::new();
        let text: String = text.chars().take(MAX_PANEL_TEXT_CHARS).collect();
        for paragraph in text.split('\n') {
            if lines.len() >= MAX_TEXT_LINES {
                break;
            }
            let mut line = String::new();
            for word in paragraph.split_whitespace() {
                if lines.len() >= MAX_TEXT_LINES {
                    break;
                }
                let word: String = word.chars().take(MAX_TEXT_CHARS).collect();
                let word = word.as_str();
                let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                if self.width(&candidate, size, weight) <= max || line.is_empty() {
                    line = candidate;
                } else {
                    lines.push(std::mem::take(&mut line));
                    line = word.to_string();
                }
            }
            lines.push(self.fit(&line, max, size, weight));
        }
        lines
    }
}

fn advance(face: &rustybuzz::Face<'_>, text: &str, size: f32) -> f32 {
    let mut buffer = rustybuzz::UnicodeBuffer::new();
    buffer.push_str(text);
    buffer.guess_segment_properties();
    let shaped = rustybuzz::shape(face, &[], buffer);
    let units: i64 = shaped.glyph_positions().iter().map(|p| i64::from(p.x_advance)).sum();
    units as f32 * size / f32::from(face.units_per_em() as u16)
}

/// Text as one line: no control characters, tabs as spaces.
fn clean(text: &str) -> String {
    text.chars()
        .filter_map(|c| {
            if c == '\t' || c == '\n' || c == '\r' {
                Some(' ')
            } else if c.is_control() {
                None
            } else {
                Some(c)
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Drawing

fn paint(c: Rgb) -> krilla::paint::Paint {
    rgb::Color::new(c.0, c.1, c.2).into()
}

fn fill(c: Rgb) -> Fill {
    Fill { paint: paint(c), opacity: NormalizedF32::ONE, rule: Default::default() }
}

fn stroke(c: Rgb, width: f32) -> Stroke {
    Stroke { paint: paint(c), width, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Default::default() }
}

fn rect_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<Path> {
    let mut pb = PathBuilder::new();
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    pb.finish()
}

fn circle_path(cx: f32, cy: f32, r: f32) -> Option<Path> {
    const K: f32 = 0.552_284_8;
    let mut pb = PathBuilder::new();
    pb.move_to(cx + r, cy);
    pb.cubic_to(cx + r, cy + K * r, cx + K * r, cy + r, cx, cy + r);
    pb.cubic_to(cx - K * r, cy + r, cx - r, cy + K * r, cx - r, cy);
    pb.cubic_to(cx - r, cy - K * r, cx - K * r, cy - r, cx, cy - r);
    pb.cubic_to(cx + K * r, cy - r, cx + r, cy - K * r, cx + r, cy);
    pb.close();
    pb.finish()
}

struct Pen<'a, 'b> {
    s: &'a mut Surface<'b>,
    fonts: &'a Fonts,
}

impl Pen<'_, '_> {
    fn fill_path(&mut self, path: Option<Path>, c: Rgb) {
        if let Some(path) = path {
            self.s.set_stroke(None);
            self.s.set_fill(Some(fill(c)));
            self.s.draw_path(&path);
        }
    }

    fn stroke_path(&mut self, path: Option<Path>, c: Rgb, width: f32, dashed: bool) {
        if let Some(path) = path {
            self.s.set_fill(None);
            let mut st = stroke(c, width);
            if dashed {
                st.dash = Some(StrokeDash { array: vec![3.0, 3.0], offset: 0.0 });
            }
            self.s.set_stroke(Some(st));
            self.s.draw_path(&path);
            self.s.set_stroke(None);
        }
    }

    fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, c: Rgb) {
        self.fill_path(rect_path(x, y, w.max(0.0), h.max(0.0), 0.0), c);
    }

    fn line(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, c: Rgb, width: f32) {
        let mut pb = PathBuilder::new();
        pb.move_to(x1, y1);
        pb.line_to(x2, y2);
        self.stroke_path(pb.finish(), c, width, false);
    }

    /// Text with its baseline at `y`.
    fn text(&mut self, x: f32, y: f32, size: f32, weight: Weight, c: Rgb, text: &str) {
        let text = clean(text);
        if text.is_empty() {
            return;
        }
        self.s.set_stroke(None);
        self.s.set_fill(Some(fill(c)));
        let pair = self.fonts.pair(weight);
        let mut x = x;
        for (i, run) in self.fonts.runs(&text, weight) {
            let face = &pair[i];
            self.s.draw_text(Point::from_xy(x, y), face.pdf.clone(), size, run, false, TextDirection::Auto);
            x += advance(&face.shaper, run, size);
        }
    }

    fn text_right(&mut self, right: f32, y: f32, size: f32, weight: Weight, c: Rgb, text: &str) {
        let w = self.fonts.width(&clean(text), size, weight);
        self.text(right - w, y, size, weight, c, text);
    }

    fn text_center(&mut self, center: f32, y: f32, size: f32, weight: Weight, c: Rgb, text: &str) {
        let w = self.fonts.width(&clean(text), size, weight);
        self.text(center - w / 2.0, y, size, weight, c, text);
    }
}

// ---------------------------------------------------------------------------------------------
// Values

fn group(digits: &str, sep: char) -> String {
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(sep);
        }
        out.push(c);
    }
    out
}

/// A number as the report's language writes it, with at most `decimals` places (fewer when they
/// are zeros).
fn number_with(v: f64, decimals: usize, lang: ReportLanguage) -> String {
    if !v.is_finite() {
        return "–".into();
    }
    let (thousands, point) = match lang {
        ReportLanguage::De => ('.', ','),
        ReportLanguage::En => (',', '.'),
    };
    let text = format!("{:.*}", decimals, v.abs());
    let (int, frac) = text.split_once('.').unwrap_or((&text, ""));
    let frac = frac.trim_end_matches('0');
    let mut out = String::new();
    if v < 0.0 && (int != "0" || !frac.is_empty()) {
        out.push('-');
    }
    out.push_str(&group(int, thousands));
    if !frac.is_empty() {
        out.push(point);
        out.push_str(frac);
    }
    out
}

/// A number with a sensible number of places for its size.
fn number(v: f64, lang: ReportLanguage) -> String {
    let a = v.abs();
    let decimals = if a >= 1000.0 {
        0
    } else if a >= 1.0 || a == 0.0 {
        2
    } else {
        4
    };
    number_with(v, decimals, lang)
}

fn with_unit(text: String, unit: Option<&str>) -> String {
    match unit {
        Some("percent") | Some("%") => format!("{text} %"),
        Some(u) if !u.is_empty() && u.chars().count() <= 8 && u != "none" && u != "short" => format!("{text} {u}"),
        _ => text,
    }
}

fn local(ms: i64, zone: Tz) -> Option<NaiveDateTime> {
    zone.timestamp_millis_opt(ms).single().map(|t| t.naive_local())
}

/// A moment for the cover and tables: `14.11.2026 08:00` or `2026-11-14 08:00`.
fn moment(ms: i64, zone: Tz, lang: ReportLanguage) -> String {
    let Some(t) = local(ms, zone) else { return ms.to_string() };
    match lang {
        ReportLanguage::De => t.format("%d.%m.%Y %H:%M").to_string(),
        ReportLanguage::En => t.format("%Y-%m-%d %H:%M").to_string(),
    }
}

/// A cell's text.
fn cell(value: &Value, field_type: FieldType, zone: Tz, lang: ReportLanguage) -> String {
    match (value, field_type) {
        (Value::Null, _) => String::new(),
        (_, FieldType::Time) => value.as_i64().map_or_else(|| value.to_string(), |ms| moment(ms, zone, lang)),
        (_, FieldType::Date) => value.as_i64().and_then(chrono::DateTime::from_timestamp_millis).map_or_else(
            || value.to_string(),
            |d| d.format(if lang == ReportLanguage::De { "%d.%m.%Y" } else { "%Y-%m-%d" }).to_string(),
        ),
        (_, FieldType::Number) => number_at(value).map_or_else(|| value.to_string(), |n| number(n, lang)),
        (Value::String(s), _) => s.clone(),
        (Value::Bool(b), _) => b.to_string(),
        (other, _) => other.to_string(),
    }
}

fn is_numeric(t: FieldType) -> bool {
    matches!(t, FieldType::Number | FieldType::Int64 | FieldType::Decimal)
}

fn is_time(t: FieldType) -> bool {
    matches!(t, FieldType::Time | FieldType::Date)
}

/// A field's name with its labels (`up{job="api"}` reads `up job=api`).
fn series_name(frame_name: &str, field: &crate::shapes::Field, frames: usize) -> String {
    let mut name = field.name.clone();
    if let Some(labels) = &field.labels
        && !labels.is_empty()
    {
        let parts: Vec<String> = labels.iter().map(|(k, v)| format!("{k}={v}")).collect();
        name = format!("{name} {}", parts.join(", "));
    }
    if frames > 1 { format!("{frame_name}: {name}") } else { name }
}

// ---------------------------------------------------------------------------------------------
// What each panel shows

struct Series {
    name: String,
    points: Vec<(i64, Option<f64>)>,
}

struct BarData {
    categories: Vec<String>,
    series: Vec<(String, Vec<Option<f64>>)>,
    more: usize,
}

struct Stat {
    name: String,
    value: Option<f64>,
}

enum Body<'g> {
    /// A trace's spans as a waterfall: depth, label, start and duration within the trace, error.
    Trace {
        rows: Vec<SpanRow>,
        from: i64,
        to: i64,
        more: usize,
    },
    Lines {
        series: Vec<Series>,
        more: usize,
    },
    Bars(BarData),
    Stats(Vec<Stat>),
    /// `total`: the rows before the result was cut to what is drawn.
    Table {
        frame: &'g Frame,
        total: usize,
        note: Option<&'static str>,
    },
    Documents {
        lines: Vec<(usize, String, String)>,
        more: usize,
    },
    Graph {
        graph: &'g GraphSet,
        nodes: usize,
        edges: usize,
    },
    Text(String),
    Placeholder {
        message: String,
        code: String,
    },
}

const FRAME_KINDS: &[&str] = &[
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
];
const DOCUMENT_KINDS: &[&str] = &["documents", "document", "schema", "distribution"];
const GRAPH_KINDS: &[&str] = &["network", "hierarchy", "path"];

fn shape_names(r: &Results) -> String {
    let mut names = Vec::new();
    if !r.frames.is_empty() {
        names.push("frame");
    }
    if !r.documents.is_empty() {
        names.push("documents");
    }
    if !r.graphs.is_empty() {
        names.push("graph");
    }
    if !r.traces.is_empty() {
        names.push("trace");
    }
    names.join(", ")
}

fn body<'g>(panel: &'g PanelOut, zone: Tz, w: &Words) -> Body<'g> {
    let results = match &panel.content {
        Content::Text(text) => return Body::Text(text.clone()),
        Content::Unavailable { code, message } => {
            return Body::Placeholder { message: message.clone(), code: code.clone() };
        }
        Content::Results(r) => r,
    };
    let kind = panel.kind.as_str();
    if results.frames.is_empty() && results.documents.is_empty() && results.graphs.is_empty() {
        // A trace has one way to be drawn, whatever the panel: its waterfall.
        if let Some((name, trace)) = results.traces.first() {
            let total = results.totals.get(&format!("{name}#spans")).copied().unwrap_or(trace.spans.len());
            return trace_body(trace, total);
        }
        return Body::Placeholder { message: w.no_data.into(), code: "reports.no_data".into() };
    }
    if GRAPH_KINDS.contains(&kind) {
        if let Some((name, graph)) = results.graphs.first() {
            let nodes = results.totals.get(&format!("{name}#nodes")).copied().unwrap_or(graph.nodes.len());
            let edges = results.totals.get(&format!("{name}#edges")).copied().unwrap_or(graph.edges.len());
            return Body::Graph { graph, nodes, edges };
        }
    } else if DOCUMENT_KINDS.contains(&kind) {
        if let Some((name, set)) = results.documents.first() {
            let total = results.totals.get(name).copied().unwrap_or(set.documents.len());
            let (lines, more) = document_lines(set, total, w);
            return Body::Documents { lines, more };
        }
        // The schema and distribution panels read a projection too; a table result is a table.
        if !results.frames.is_empty() {
            return table(results, None);
        }
    } else if FRAME_KINDS.contains(&kind) && !results.frames.is_empty() {
        return frame_body(kind, panel, results, zone, w);
    }
    if !FRAME_KINDS.contains(&kind) && !DOCUMENT_KINDS.contains(&kind) && !GRAPH_KINDS.contains(&kind) {
        // A plugin's panel or a type the renderer does not know.
        if !results.frames.is_empty() {
            return table(results, Some(w.not_drawn));
        }
    }
    Body::Placeholder {
        message: format!("{} ({}: {}).", w.shape_mismatch, kind, shape_names(results)),
        code: "reports.shape_mismatch".into(),
    }
}

fn frame_body<'g>(kind: &str, panel: &'g PanelOut, results: &'g Results, zone: Tz, w: &Words) -> Body<'g> {
    let frames = results.frames.len();
    match kind {
        "timeseries" => {
            let mut series = Vec::new();
            for f in &results.frames {
                let Some(time) = f.frame.fields().iter().find(|x| is_time(x.field_type)) else { continue };
                for field in f.frame.fields().iter().filter(|x| is_numeric(x.field_type)) {
                    let mut points: Vec<(i64, Option<f64>)> = time
                        .values
                        .iter()
                        .zip(&field.values)
                        .filter_map(|(t, v)| Some((t.as_i64()?, number_at(v))))
                        .collect();
                    points.sort_by_key(|p| p.0);
                    if points.len() > MAX_POINTS {
                        let step = points.len().div_ceil(MAX_POINTS);
                        points = points.into_iter().step_by(step).collect();
                    }
                    series.push(Series { name: series_name(&f.name, field, frames), points });
                }
            }
            if series.is_empty() {
                return table(results, None);
            }
            let more = series.len().saturating_sub(MAX_SERIES);
            series.truncate(MAX_SERIES);
            Body::Lines { series, more }
        }
        "bar" => {
            let f = &results.frames[0].frame;
            let label = f
                .fields()
                .iter()
                .find(|x| x.field_type == FieldType::String)
                .or_else(|| f.fields().iter().find(|x| is_time(x.field_type)));
            let values: Vec<&crate::shapes::Field> =
                f.fields().iter().filter(|x| is_numeric(x.field_type)).take(4).collect();
            if values.is_empty() {
                return table(results, None);
            }
            let rows = f.rows();
            let shown = rows.min(MAX_BARS);
            let categories = (0..shown)
                .map(|i| match label {
                    Some(l) => cell(&l.values[i], l.field_type, zone, ReportLanguage::En),
                    None => (i + 1).to_string(),
                })
                .collect();
            let series = values
                .iter()
                .map(|v| (series_name("", v, 1), v.values.iter().take(shown).map(number_at).collect()))
                .collect();
            let total = results.totals.get(&results.frames[0].name).copied().unwrap_or(rows);
            Body::Bars(BarData { categories, series, more: total.saturating_sub(shown) })
        }
        "stat" | "gauge" | "bargauge" => {
            // Reduced while gathering already: each field holds the one value.
            let reducer = if results.reduced {
                "first"
            } else {
                panel.options.get("reducer").and_then(Value::as_str).unwrap_or("last")
            };
            let mut stats = Vec::new();
            for f in &results.frames {
                for field in f.frame.fields().iter().filter(|x| is_numeric(x.field_type)) {
                    let values: Vec<f64> = field.values.iter().filter_map(number_at).collect();
                    stats.push(Stat { name: series_name(&f.name, field, frames), value: reduce(&values, reducer) });
                }
            }
            if stats.is_empty() {
                return table(results, None);
            }
            stats.truncate(12);
            Body::Stats(stats)
        }
        "table" => table(results, None),
        _ => table(results, Some(w.not_drawn)),
    }
}

/// The first table result as a table, with its rows before any cut.
fn table<'g>(results: &'g Results, note: Option<&'static str>) -> Body<'g> {
    let f = &results.frames[0];
    Body::Table { frame: &f.frame, total: results.totals.get(&f.name).copied().unwrap_or(f.frame.rows()), note }
}

pub fn reduce(values: &[f64], reducer: &str) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(match reducer {
        "first" => values[0],
        "min" => values.iter().copied().fold(f64::INFINITY, f64::min),
        "max" => values.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        "mean" | "avg" => values.iter().sum::<f64>() / values.len() as f64,
        "sum" | "total" => values.iter().sum(),
        "count" => values.len() as f64,
        _ => values[values.len() - 1],
    })
}

// ---------------------------------------------------------------------------------------------
// Documents in their own key order

enum Doc {
    Null,
    Bool(bool),
    Number(String),
    Text(String),
    List(Vec<Doc>),
    Map(Vec<(String, Doc)>),
}

impl<'de> Deserialize<'de> for Doc {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Doc;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Doc, E> {
                Ok(Doc::Null)
            }
            fn visit_none<E>(self) -> Result<Doc, E> {
                Ok(Doc::Null)
            }
            fn visit_bool<E>(self, v: bool) -> Result<Doc, E> {
                Ok(Doc::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Doc, E> {
                Ok(Doc::Number(v.to_string()))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Doc, E> {
                Ok(Doc::Number(v.to_string()))
            }
            fn visit_f64<E>(self, v: f64) -> Result<Doc, E> {
                Ok(Doc::Number(v.to_string()))
            }
            fn visit_str<E>(self, v: &str) -> Result<Doc, E> {
                Ok(Doc::Text(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<Doc, E> {
                Ok(Doc::Text(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Doc, A::Error> {
                let mut out = Vec::new();
                while let Some(item) = seq.next_element()? {
                    out.push(item);
                }
                Ok(Doc::List(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Doc, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Doc>()? {
                    out.push((k, v));
                }
                Ok(Doc::Map(out))
            }
        }
        d.deserialize_any(V)
    }
}

impl Doc {
    /// A value typed by its database (`{"$type": "objectId", "value": "..."}`) as one line.
    fn typed(&self) -> Option<String> {
        let Doc::Map(entries) = self else { return None };
        if entries.len() != 2 {
            return None;
        }
        let ty = entries.iter().find(|(k, _)| k == "$type")?;
        let value = entries.iter().find(|(k, _)| k == "value")?;
        match (&ty.1, &value.1) {
            (Doc::Text(t), Doc::Text(v)) => Some(format!("{v} ({t})")),
            (Doc::Text(t), Doc::Null) => Some(format!("– ({t})")),
            _ => None,
        }
    }

    fn scalar(&self) -> Option<String> {
        match self {
            Doc::Null => Some("null".into()),
            Doc::Bool(b) => Some(b.to_string()),
            Doc::Number(n) => Some(n.clone()),
            Doc::Text(t) => Some(format!("\"{t}\"")),
            _ => self.typed(),
        }
    }

    fn lines(&self, depth: usize, key: String, out: &mut Vec<(usize, String, String)>, budget: usize) {
        if out.len() >= budget {
            return;
        }
        if let Some(text) = self.scalar() {
            out.push((depth, key, text));
            return;
        }
        match self {
            Doc::List(items) => {
                out.push((depth, key, format!("[{}]", items.len())));
                for (i, item) in items.iter().take(5).enumerate() {
                    item.lines(depth + 1, format!("[{i}]"), out, budget);
                }
                if items.len() > 5 && out.len() < budget {
                    out.push((depth + 1, "…".into(), String::new()));
                }
            }
            Doc::Map(entries) => {
                out.push((depth, key, format!("{{{}}}", entries.len())));
                for (k, v) in entries {
                    v.lines(depth + 1, k.clone(), out, budget);
                }
            }
            _ => {}
        }
    }
}

fn document_lines(set: &DocumentSet, total: usize, w: &Words) -> (Vec<(usize, String, String)>, usize) {
    let mut lines = Vec::new();
    let mut shown = 0;
    for (i, doc) in set.documents.iter().take(MAX_DOCUMENTS).enumerate() {
        if lines.len() >= MAX_DOCUMENT_LINES {
            break;
        }
        let parsed: Doc = serde_json::from_str(doc.get()).unwrap_or(Doc::Null);
        lines.push((0, format!("{} {}", w.document, i + 1), String::new()));
        match parsed {
            Doc::Map(entries) => {
                for (k, v) in entries {
                    v.lines(1, k, &mut lines, MAX_DOCUMENT_LINES);
                }
            }
            other => other.lines(1, String::new(), &mut lines, MAX_DOCUMENT_LINES),
        }
        shown += 1;
    }
    let cut = lines.len() >= MAX_DOCUMENT_LINES;
    lines.truncate(MAX_DOCUMENT_LINES);
    let more = total.max(set.documents.len()) - shown + usize::from(cut && shown > 0);
    (lines, more)
}

// ---------------------------------------------------------------------------------------------
// Layout

/// The height a body takes at width `w`.
fn body_height(body: &Body<'_>, fonts: &Fonts, w: f32) -> f32 {
    match body {
        Body::Lines { series, more } => {
            170.0 + legend_height(fonts, series.iter().map(|s| s.name.as_str()), w) + note_h(*more)
        }
        Body::Bars(b) => 190.0 + legend_height(fonts, b.series.iter().map(|s| s.0.as_str()), w) + note_h(b.more),
        Body::Stats(stats) => 58.0 * stats.len().div_ceil(4) as f32,
        Body::Table { frame, total, note } => {
            let rows = frame.rows().min(MAX_TABLE_ROWS);
            let cut = *total > rows;
            ROW_H * (rows as f32 + 1.0) + note_h(usize::from(cut)) + if note.is_some() { 18.0 } else { 0.0 }
        }
        Body::Documents { lines, more } => LINE_H * lines.len() as f32 + note_h(*more),
        Body::Trace { rows, more, .. } => 14.0 + ROW_H * rows.len() as f32 + note_h(*more),
        Body::Graph { graph, nodes, edges } => {
            let cut = nodes.saturating_sub(graph.nodes.len().min(MAX_GRAPH_NODES))
                + edges.saturating_sub(graph.edges.len().min(MAX_GRAPH_EDGES));
            250.0 + note_h(cut) + 16.0
        }
        Body::Text(text) => {
            let lines = fonts.wrap(text, w, 9.5, Weight::Regular).len().min(MAX_TEXT_LINES);
            LINE_H * lines.max(1) as f32
        }
        Body::Placeholder { .. } => 40.0,
    }
}

fn note_h(more: usize) -> f32 {
    if more > 0 { 16.0 } else { 0.0 }
}

fn legend_height<'a>(fonts: &Fonts, names: impl Iterator<Item = &'a str>, w: f32) -> f32 {
    let mut rows = 1;
    let mut x = 0.0;
    for name in names {
        let item = 16.0 + fonts.width(&fonts.fit(name, 200.0, 8.0, Weight::Regular), 8.0, Weight::Regular) + 12.0;
        if x > 0.0 && x + item > w {
            rows += 1;
            x = 0.0;
        }
        x += item;
    }
    14.0 * rows as f32 + 4.0
}

/// One page's cards: the card and its top.
struct Placed {
    card: usize,
    y: f32,
    h: f32,
}

// ---------------------------------------------------------------------------------------------
// The document

/// What the cover says besides the panels.
pub struct Cover<'a> {
    pub title: &'a str,
    pub generated_at: i64,
}

/// The PDF file of `g`, within [`RENDER_DEADLINE`].
pub fn render(g: &Gathered, cover: &Cover<'_>, lang: ReportLanguage) -> Result<Rendered, String> {
    render_until(g, cover, lang, std::time::Instant::now() + RENDER_DEADLINE)
}

/// The PDF file of `g`, or an error once `deadline` passed (looked at for every card).
pub fn render_until(
    g: &Gathered,
    cover: &Cover<'_>,
    lang: ReportLanguage,
    deadline: std::time::Instant,
) -> Result<Rendered, String> {
    let late = || {
        (std::time::Instant::now() > deadline)
            .then(|| format!("rendering took longer than {} seconds", RENDER_DEADLINE.as_secs()))
    };
    let fonts = Fonts::load()?;
    let w = words(lang);
    let content_w = PAGE_W - 2.0 * MARGIN;
    let body_w = content_w - 2.0 * CARD_PAD;
    let bodies: Vec<Body<'_>> = g.panels.iter().map(|p| body(p, g.zone, w)).collect();
    // The cover's lines.
    let mut cover_lines: Vec<(Weight, f32, Rgb, String)> =
        vec![(Weight::Semibold, 18.0, TEXT, cover.title.to_string())];
    cover_lines.push((Weight::Regular, 9.5, MUTED, format!("{}: {}", w.dashboard, g.dashboard_title)));
    cover_lines.push((
        Weight::Regular,
        9.5,
        MUTED,
        format!(
            "{}: {} – {} ({})",
            w.range,
            moment(g.range.from, g.zone, lang),
            moment(g.range.to, g.zone, lang),
            g.zone.name()
        ),
    ));
    if !g.variables.is_empty() {
        let values: Vec<String> = g
            .variables
            .iter()
            .map(|(k, v)| match v {
                Value::String(s) => format!("{k} = {s}"),
                Value::Array(items) => {
                    let parts: Vec<String> =
                        items.iter().map(|i| i.as_str().map_or_else(|| i.to_string(), str::to_string)).collect();
                    format!("{k} = {}", parts.join(", "))
                }
                other => format!("{k} = {other}"),
            })
            .collect();
        for (i, line) in
            fonts.wrap(&values.join(" · "), content_w, 9.5, Weight::Regular).into_iter().take(3).enumerate()
        {
            let text = if i == 0 { format!("{}: {line}", w.variables) } else { line };
            cover_lines.push((Weight::Regular, 9.5, MUTED, text));
        }
    }
    cover_lines.push((
        Weight::Regular,
        9.5,
        MUTED,
        format!("{}: {}", w.generated, moment(cover.generated_at, g.zone, lang)),
    ));
    let cover_h = 26.0 + 14.0 * (cover_lines.len() - 1) as f32 + 8.0;

    // Pages: the cover on the first, then the cards, each whole on one page.
    let top = MARGIN;
    let bottom = PAGE_H - MARGIN - FOOTER;
    let max_card = bottom - top;
    let mut pages: Vec<Vec<Placed>> = vec![Vec::new()];
    let mut y = top + cover_h + GAP;
    for (i, b) in bodies.iter().enumerate() {
        if let Some(e) = late() {
            return Err(e);
        }
        let h = (body_height(b, &fonts, body_w) + CARD_HEAD + 2.0 * CARD_PAD).min(max_card);
        if y + h > bottom && !(pages.len() == 1 && pages[0].is_empty() && y <= top + cover_h + GAP) {
            pages.push(Vec::new());
            y = top;
        }
        pages.last_mut().expect("one page at least").push(Placed { card: i, y, h });
        y += h + GAP;
    }
    let total = pages.len();

    let mut document = Document::new();
    document.set_metadata(
        krilla::metadata::Metadata::new()
            .title(cover.title.to_string())
            .language(lang.as_str().to_string())
            .creator("Kalzit".to_string()),
    );
    for (n, placed) in pages.iter().enumerate() {
        let settings = PageSettings::from_wh(PAGE_W, PAGE_H).ok_or("the page size is not valid")?;
        let mut page = document.start_page_with(settings);
        {
            let mut surface = page.surface();
            let mut pen = Pen { s: &mut surface, fonts: &fonts };
            pen.rect(0.0, 0.0, PAGE_W, PAGE_H, BG);
            if n == 0 {
                let mut cy = top + 18.0;
                for (i, (weight, size, color, text)) in cover_lines.iter().enumerate() {
                    let fitted = fonts.fit(text, content_w, *size, *weight);
                    pen.text(MARGIN, cy, *size, *weight, *color, &fitted);
                    cy += if i == 0 { 22.0 } else { 14.0 };
                }
            }
            for p in placed {
                if let Some(e) = late() {
                    return Err(e);
                }
                draw_card(&mut pen, &g.panels[p.card], &bodies[p.card], MARGIN, p.y, content_w, p.h, g.zone, lang, w);
            }
            let footer = format!("Kalzit · {} · {} {} {} {}", cover.title, w.page, n + 1, w.of, total);
            let footer = fonts.fit(&footer, content_w, 8.0, Weight::Regular);
            pen.text(MARGIN, PAGE_H - MARGIN + 6.0, 8.0, Weight::Regular, MUTED, &footer);
            surface.finish();
        }
        page.finish();
    }
    let bytes = document.finish().map_err(|e| format!("the PDF file could not be written: {e:?}"))?;
    Ok(Rendered { bytes, pages: total })
}

#[expect(clippy::too_many_arguments, reason = "a card's place and what it needs to draw")]
fn draw_card(
    pen: &mut Pen<'_, '_>,
    panel: &PanelOut,
    body: &Body<'_>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    zone: Tz,
    lang: ReportLanguage,
    words: &Words,
) {
    pen.fill_path(rect_path(x, y, w, h, 6.0), SURFACE);
    pen.stroke_path(rect_path(x, y, w, h, 6.0), BORDER, 0.75, false);
    let title = if panel.title.trim().is_empty() { panel.kind.clone() } else { panel.title.clone() };
    let fitted = pen.fonts.fit(&title, w - 2.0 * CARD_PAD, 11.0, Weight::Semibold);
    pen.text(x + CARD_PAD, y + CARD_PAD + 10.0, 11.0, Weight::Semibold, TEXT, &fitted);
    let bx = x + CARD_PAD;
    let by = y + CARD_PAD + CARD_HEAD;
    let bw = w - 2.0 * CARD_PAD;
    let bh = h - CARD_HEAD - 2.0 * CARD_PAD;
    match body {
        Body::Lines { series, more } => {
            draw_lines(pen, series, *more, bx, by, bw, bh, zone, lang, words, panel.unit.as_deref())
        }
        Body::Bars(b) => draw_bars(pen, b, bx, by, bw, bh, lang, words),
        Body::Stats(stats) => draw_stats(pen, stats, bx, by, bw, lang, panel.unit.as_deref()),
        Body::Table { frame, total, note } => draw_table(pen, frame, *total, *note, bx, by, bw, bh, zone, lang, words),
        Body::Documents { lines, more } => draw_documents(pen, lines, *more, bx, by, bw, words),
        Body::Graph { graph, nodes, edges } => draw_graph(pen, graph, *nodes, *edges, bx, by, bw, bh, words),
        Body::Trace { rows, from, to, more } => draw_trace(pen, rows, *from, *to, *more, bx, by, bw, lang, words),
        Body::Text(text) => {
            let mut ty = by + 9.0;
            for line in pen.fonts.wrap(text, bw, 9.5, Weight::Regular).into_iter().take(MAX_TEXT_LINES) {
                let (weight, line) = match line.strip_prefix('#') {
                    Some(rest) => (Weight::Semibold, rest.trim_start_matches('#').trim().to_string()),
                    None => (Weight::Regular, line),
                };
                pen.text(bx, ty, 9.5, weight, TEXT, &line);
                ty += LINE_H;
            }
        }
        Body::Placeholder { message, code } => {
            pen.stroke_path(rect_path(bx, by, bw, 34.0, 4.0), BORDER, 0.75, true);
            let text = format!("{}: {message}", words.not_shown);
            let fitted = pen.fonts.fit(&text, bw - 16.0, 9.0, Weight::Regular);
            pen.text(bx + 8.0, by + 14.0, 9.0, Weight::Regular, TEXT, &fitted);
            pen.text(bx + 8.0, by + 27.0, 7.5, Weight::Regular, MUTED, code);
        }
    }
}

fn note(pen: &mut Pen<'_, '_>, x: f32, y: f32, more: usize, text: &str) {
    if more > 0 {
        pen.text(x, y, 8.0, Weight::Regular, MUTED, &format!("{more} {text}"));
    }
}

fn nice_step(span: f64, n: f64) -> f64 {
    let raw = (span / n).max(f64::MIN_POSITIVE);
    let mag = 10f64.powf(raw.log10().floor());
    let norm = raw / mag;
    let nice = if norm < 1.5 {
        1.0
    } else if norm < 3.0 {
        2.0
    } else if norm < 7.0 {
        5.0
    } else {
        10.0
    };
    nice * mag
}

/// A value axis over `lo..hi` with about five ticks: the rounded ends and the ticks.
fn value_axis(lo: f64, hi: f64) -> (f64, f64, Vec<f64>) {
    let (lo, hi) = if lo == hi { (lo - 1.0, hi + 1.0) } else { (lo, hi) };
    let step = nice_step(hi - lo, 4.0);
    let start = (lo / step).floor() * step;
    let end = (hi / step).ceil() * step;
    let mut ticks = Vec::new();
    let mut t = start;
    while t <= end + step / 2.0 && ticks.len() < 20 {
        ticks.push(t);
        t += step;
    }
    (start, end, ticks)
}

fn decimals_for(step: f64) -> usize {
    if step >= 1.0 { 0 } else { ((-step.log10()).ceil() as usize).min(6) }
}

/// Time ticks over `from..to` at round local times.
fn time_ticks(from: i64, to: i64, zone: Tz) -> (Vec<i64>, &'static str) {
    const MIN: i64 = 60_000;
    const DAY: i64 = 1440 * MIN;
    let span = (to - from).max(1);
    let steps = [
        MIN,
        5 * MIN,
        15 * MIN,
        30 * MIN,
        60 * MIN,
        180 * MIN,
        360 * MIN,
        720 * MIN,
        DAY,
        2 * DAY,
        7 * DAY,
        14 * DAY,
        30 * DAY,
        91 * DAY,
        365 * DAY,
    ];
    let step = steps.iter().copied().find(|s| span / s <= 6).unwrap_or(365 * DAY);
    let format = if span <= 2 * DAY {
        "%H:%M"
    } else if span <= 200 * DAY {
        "day"
    } else {
        "month"
    };
    let mut ticks = Vec::new();
    let Some(start) = local(from, zone) else { return (ticks, format) };
    if step < DAY {
        let minutes = i64::from(start.and_utc().timestamp() as i32 % 86_400 / 60).max(0);
        let step_min = step / MIN;
        let first_min = (minutes + step_min - 1) / step_min * step_min;
        let mut t = from - minutes * MIN + first_min * MIN - i64::from(start.and_utc().timestamp_subsec_millis());
        // Seconds of `from` within its minute.
        t -= i64::from(chrono::Timelike::second(&start)) * 1000;
        while t <= to && ticks.len() < 12 {
            if t >= from {
                ticks.push(t);
            }
            t += step;
        }
    } else {
        let days = step / DAY;
        let mut date = start.date();
        if NaiveDateTime::new(date, NaiveTime::MIN) < start {
            date = date.succ_opt().unwrap_or(date);
        }
        while ticks.len() < 12 {
            let Some(t) = super::schedule::instant(NaiveDateTime::new(date, NaiveTime::MIN), zone) else { break };
            if t > to {
                break;
            }
            ticks.push(t);
            let Some(next) = date.checked_add_signed(chrono::Duration::days(days)) else { break };
            date = next;
        }
    }
    (ticks, format)
}

fn tick_label(ms: i64, format: &str, zone: Tz, lang: ReportLanguage) -> String {
    let Some(t) = local(ms, zone) else { return String::new() };
    match (format, lang) {
        ("day", ReportLanguage::De) => t.format("%d.%m.").to_string(),
        ("day", ReportLanguage::En) => t.format("%b %-d").to_string(),
        ("month", ReportLanguage::De) => t.format("%m.%Y").to_string(),
        ("month", ReportLanguage::En) => t.format("%b %Y").to_string(),
        (f, _) => t.format(f).to_string(),
    }
}

fn draw_legend<'a>(pen: &mut Pen<'_, '_>, names: impl Iterator<Item = &'a str>, x: f32, y: f32, w: f32, bars: bool) {
    let (mut lx, mut ly) = (x, y);
    for (i, name) in names.enumerate() {
        let name = pen.fonts.fit(name, 200.0, 8.0, Weight::Regular);
        let item = 16.0 + pen.fonts.width(&name, 8.0, Weight::Regular) + 12.0;
        if lx > x && lx + item > x + w {
            lx = x;
            ly += 14.0;
        }
        let color = PALETTE[i % PALETTE.len()];
        if bars {
            pen.rect(lx, ly - 6.0, 10.0, 7.0, color);
        } else {
            pen.line(lx, ly - 3.0, lx + 11.0, ly - 3.0, color, 2.0);
        }
        pen.text(lx + 15.0, ly, 8.0, Weight::Regular, MUTED, &name);
        lx += item;
    }
}

#[expect(clippy::too_many_arguments, reason = "a chart's place and what it needs to draw")]
fn draw_lines(
    pen: &mut Pen<'_, '_>,
    series: &[Series],
    more: usize,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    zone: Tz,
    lang: ReportLanguage,
    words: &Words,
    unit: Option<&str>,
) {
    let legend_h = legend_height(pen.fonts, series.iter().map(|s| s.name.as_str()), w);
    let chart_h = (h - legend_h - note_h(more)).max(60.0);
    let values = series.iter().flat_map(|s| s.points.iter().filter_map(|p| p.1));
    let (lo, hi) = values.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(v), b.max(v)));
    let times = series.iter().flat_map(|s| s.points.iter().map(|p| p.0));
    let (t0, t1) = times.fold((i64::MAX, i64::MIN), |(a, b), t| (a.min(t), b.max(t)));
    if !lo.is_finite() || t0 > t1 {
        pen.text(x, y + 12.0, 9.0, Weight::Regular, MUTED, words.no_data);
        return;
    }
    let (lo, hi, ticks) = value_axis(lo, hi);
    let decimals = decimals_for(ticks.get(1).map_or(1.0, |t| t - ticks[0]));
    let label_w = ticks
        .iter()
        .map(|t| pen.fonts.width(&with_unit(number_with(*t, decimals, lang), unit), 7.5, Weight::Regular))
        .fold(0.0f32, f32::max)
        + 6.0;
    let (px, pw) = (x + label_w, w - label_w);
    let (py, ph) = (y, chart_h - 16.0);
    let sx = |t: i64| px + if t1 == t0 { pw / 2.0 } else { (t - t0) as f32 / (t1 - t0) as f32 * pw };
    let sy = |v: f64| py + ph - ((v - lo) / (hi - lo)) as f32 * ph;
    for t in &ticks {
        let ty = sy(*t);
        pen.line(px, ty, px + pw, ty, GRID, 0.5);
        pen.text_right(
            px - 4.0,
            ty + 2.5,
            7.5,
            Weight::Regular,
            MUTED,
            &with_unit(number_with(*t, decimals, lang), unit),
        );
    }
    let (tticks, format) = time_ticks(t0, t1, zone);
    for t in tticks {
        let tx = sx(t);
        pen.line(tx, py + ph, tx, py + ph + 3.0, BORDER, 0.5);
        pen.text_center(tx, py + ph + 12.0, 7.5, Weight::Regular, MUTED, &tick_label(t, format, zone, lang));
    }
    pen.line(px, py + ph, px + pw, py + ph, BORDER, 0.75);
    for (i, s) in series.iter().enumerate() {
        let mut pb = PathBuilder::new();
        let mut open = false;
        let mut any = false;
        for (t, v) in &s.points {
            match v {
                Some(v) => {
                    if open {
                        pb.line_to(sx(*t), sy(*v));
                    } else {
                        pb.move_to(sx(*t), sy(*v));
                        open = true;
                    }
                    any = true;
                }
                None => open = false,
            }
        }
        if any {
            pen.stroke_path(pb.finish(), PALETTE[i % PALETTE.len()], 1.5, false);
        }
    }
    draw_legend(pen, series.iter().map(|s| s.name.as_str()), x, y + chart_h + 10.0, w, false);
    note(pen, x, y + chart_h + legend_h + 10.0, more, words.more_series);
}

#[expect(clippy::too_many_arguments, reason = "a chart's place and what it needs to draw")]
fn draw_bars(pen: &mut Pen<'_, '_>, b: &BarData, x: f32, y: f32, w: f32, h: f32, lang: ReportLanguage, words: &Words) {
    let legend_h = legend_height(pen.fonts, b.series.iter().map(|s| s.0.as_str()), w);
    let chart_h = (h - legend_h - note_h(b.more)).max(60.0);
    let values = b.series.iter().flat_map(|s| s.1.iter().filter_map(|v| *v));
    let (lo, hi) = values.fold((0.0f64, 0.0f64), |(a, c), v| (a.min(v), c.max(v)));
    let (lo, hi, ticks) = value_axis(lo, hi);
    let decimals = decimals_for(ticks.get(1).map_or(1.0, |t| t - ticks[0]));
    let label_w = ticks
        .iter()
        .map(|t| pen.fonts.width(&number_with(*t, decimals, lang), 7.5, Weight::Regular))
        .fold(0.0f32, f32::max)
        + 6.0;
    let (px, pw) = (x + label_w, w - label_w);
    let (py, ph) = (y, chart_h - 18.0);
    let sy = |v: f64| py + ph - ((v - lo) / (hi - lo)) as f32 * ph;
    for t in &ticks {
        pen.line(px, sy(*t), px + pw, sy(*t), GRID, 0.5);
        pen.text_right(px - 4.0, sy(*t) + 2.5, 7.5, Weight::Regular, MUTED, &number_with(*t, decimals, lang));
    }
    let n = b.categories.len().max(1);
    let slot = pw / n as f32;
    let groups = b.series.len().max(1);
    let bar_w = (slot * 0.7 / groups as f32).min(28.0);
    for (ci, category) in b.categories.iter().enumerate() {
        let cx = px + slot * (ci as f32 + 0.5);
        let start = cx - bar_w * groups as f32 / 2.0;
        for (si, (_, values)) in b.series.iter().enumerate() {
            if let Some(v) = values.get(ci).copied().flatten() {
                let (top, bottom) = if v >= 0.0 { (sy(v), sy(0.0)) } else { (sy(0.0), sy(v)) };
                pen.rect(start + bar_w * si as f32, top, bar_w * 0.92, bottom - top, PALETTE[si % PALETTE.len()]);
            }
        }
        let label = pen.fonts.fit(category, slot - 2.0, 7.5, Weight::Regular);
        pen.text_center(cx, py + ph + 11.0, 7.5, Weight::Regular, MUTED, &label);
    }
    pen.line(px, sy(0.0), px + pw, sy(0.0), BORDER, 0.75);
    draw_legend(pen, b.series.iter().map(|s| s.0.as_str()), x, y + chart_h + 10.0, w, true);
    note(pen, x, y + chart_h + legend_h + 10.0, b.more, words.more_bars);
}

fn draw_stats(pen: &mut Pen<'_, '_>, stats: &[Stat], x: f32, y: f32, w: f32, lang: ReportLanguage, unit: Option<&str>) {
    let cell_w = w / 4.0;
    for (i, s) in stats.iter().enumerate() {
        let cx = x + cell_w * (i % 4) as f32;
        let cy = y + 58.0 * (i / 4) as f32;
        let value = s.value.map_or_else(|| "–".to_string(), |v| with_unit(number(v, lang), unit));
        let value = pen.fonts.fit(&value, cell_w - 10.0, 22.0, Weight::Semibold);
        pen.text(cx, cy + 24.0, 22.0, Weight::Semibold, PALETTE[i % PALETTE.len()], &value);
        let name = pen.fonts.fit(&s.name, cell_w - 10.0, 8.0, Weight::Regular);
        pen.text(cx, cy + 40.0, 8.0, Weight::Regular, MUTED, &name);
    }
}

#[expect(clippy::too_many_arguments, reason = "a table's place and what it needs to draw")]
fn draw_table(
    pen: &mut Pen<'_, '_>,
    frame: &Frame,
    total: usize,
    lead: Option<&str>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    zone: Tz,
    lang: ReportLanguage,
    words: &Words,
) {
    let mut y = y;
    if let Some(lead) = lead {
        let fitted = pen.fonts.fit(lead, w, 8.5, Weight::Regular);
        pen.text(x, y + 9.0, 8.5, Weight::Regular, MUTED, &fitted);
        y += 18.0;
    }
    let fields = frame.fields();
    // As many columns as fit at 70 points each.
    let max_cols = ((w / 70.0).floor() as usize).max(1);
    let cols: Vec<&crate::shapes::Field> = fields.iter().take(max_cols).collect();
    if cols.is_empty() {
        pen.text(x, y + 10.0, 9.0, Weight::Regular, MUTED, words.no_data);
        return;
    }
    let col_w = w / cols.len() as f32;
    let avail = h - if lead.is_some() { 18.0 } else { 0.0 } - 16.0;
    let fit_rows = ((avail / ROW_H).floor() as usize).saturating_sub(1);
    let rows = frame.rows().min(MAX_TABLE_ROWS).min(fit_rows.max(1));
    for (c, f) in cols.iter().enumerate() {
        let cx = x + col_w * c as f32 + 4.0;
        let name = pen.fonts.fit(&f.name, col_w - 8.0, 8.0, Weight::Semibold);
        if is_numeric(f.field_type) {
            pen.text_right(cx + col_w - 8.0, y + 10.0, 8.0, Weight::Semibold, TEXT, &name);
        } else {
            pen.text(cx, y + 10.0, 8.0, Weight::Semibold, TEXT, &name);
        }
    }
    pen.line(x, y + ROW_H, x + w, y + ROW_H, BORDER, 0.75);
    for r in 0..rows {
        let ry = y + ROW_H * (r as f32 + 1.0);
        if r % 2 == 1 {
            pen.rect(x, ry, w, ROW_H, BG);
        }
        for (c, f) in cols.iter().enumerate() {
            let cx = x + col_w * c as f32 + 4.0;
            let text = cell(&f.values[r], f.field_type, zone, lang);
            let text = pen.fonts.fit(&text, col_w - 8.0, 8.0, Weight::Regular);
            if is_numeric(f.field_type) {
                pen.text_right(cx + col_w - 8.0, ry + 10.5, 8.0, Weight::Regular, TEXT, &text);
            } else {
                pen.text(cx, ry + 10.5, 8.0, Weight::Regular, TEXT, &text);
            }
        }
    }
    let hidden_cols = fields.len() - cols.len();
    let more = total.max(frame.rows()) - rows;
    let ny = y + ROW_H * (rows as f32 + 1.0) + 11.0;
    if more > 0 {
        note(pen, x, ny, more, words.more_rows);
    } else if hidden_cols > 0 {
        let text = match lang {
            ReportLanguage::De => {
                format!("{hidden_cols} weitere Spalten nicht gezeigt (vollständig in der CSV-Datei).")
            }
            ReportLanguage::En => format!("{hidden_cols} more columns not shown (all of them in the CSV file)."),
        };
        pen.text(x, ny, 8.0, Weight::Regular, MUTED, &text);
    }
}

fn draw_documents(
    pen: &mut Pen<'_, '_>,
    lines: &[(usize, String, String)],
    more: usize,
    x: f32,
    y: f32,
    w: f32,
    words: &Words,
) {
    let mut ly = y + 9.0;
    for (depth, key, value) in lines {
        let lx = x + 14.0 * *depth as f32;
        if *depth == 0 {
            pen.text(lx, ly, 8.5, Weight::Semibold, MUTED, key);
        } else if value.is_empty() {
            pen.text(lx, ly, 8.5, Weight::Regular, TEXT, key);
        } else {
            let key_text = format!("{key}: ");
            let kw = pen.fonts.width(&key_text, 8.5, Weight::Semibold);
            pen.text(lx, ly, 8.5, Weight::Semibold, TEXT, &key_text);
            let fitted = pen.fonts.fit(value, (x + w - lx - kw).max(20.0), 8.5, Weight::Regular);
            pen.text(lx + kw, ly, 8.5, Weight::Regular, MUTED, &fitted);
        }
        ly += LINE_H;
    }
    note(pen, x, ly + 2.0, more, words.more_documents);
}

/// A caption for a node: its name, title or label property, else its first label, else its id.
fn caption(node: &crate::shapes::Node) -> String {
    for key in ["name", "title", "label", "caption", "id"] {
        if let Some(Value::String(s)) = node.properties.get(key) {
            return s.clone();
        }
    }
    node.properties
        .values()
        .find_map(|v| v.as_str().map(str::to_string))
        .or_else(|| node.labels.first().cloned())
        .unwrap_or_else(|| node.id.clone())
}

/// Positions in the unit square: a force-directed layout from fixed starting points, so the same
/// graph always looks the same.
pub fn layout(n: usize, edges: &[(usize, usize)]) -> Vec<(f32, f32)> {
    if n == 0 {
        return Vec::new();
    }
    let mut pos: Vec<(f32, f32)> = (0..n)
        .map(|i| {
            let a = i as f32 / n as f32 * std::f32::consts::TAU;
            let r = 0.35 + 0.05 * (i % 3) as f32;
            (0.5 + r * a.cos(), 0.5 + r * a.sin())
        })
        .collect();
    let k = (1.0 / n as f32).sqrt();
    let iterations = 150;
    for step in 0..iterations {
        let temperature = 0.08 * (1.0 - step as f32 / iterations as f32) + 0.002;
        let mut disp = vec![(0.0f32, 0.0f32); n];
        for i in 0..n {
            for j in (i + 1)..n {
                let (dx, dy) = (pos[i].0 - pos[j].0, pos[i].1 - pos[j].1);
                let d = (dx * dx + dy * dy).sqrt().max(0.001);
                let f = k * k / d;
                disp[i].0 += dx / d * f;
                disp[i].1 += dy / d * f;
                disp[j].0 -= dx / d * f;
                disp[j].1 -= dy / d * f;
            }
        }
        for &(a, b) in edges {
            if a == b {
                continue;
            }
            let (dx, dy) = (pos[a].0 - pos[b].0, pos[a].1 - pos[b].1);
            let d = (dx * dx + dy * dy).sqrt().max(0.001);
            let f = d * d / k;
            disp[a].0 -= dx / d * f;
            disp[a].1 -= dy / d * f;
            disp[b].0 += dx / d * f;
            disp[b].1 += dy / d * f;
        }
        for i in 0..n {
            let (dx, dy) = disp[i];
            let d = (dx * dx + dy * dy).sqrt().max(0.0001);
            pos[i].0 += dx / d * d.min(temperature);
            pos[i].1 += dy / d * d.min(temperature);
        }
    }
    // Fitted to the unit square.
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for p in &pos {
        x0 = x0.min(p.0);
        y0 = y0.min(p.1);
        x1 = x1.max(p.0);
        y1 = y1.max(p.1);
    }
    let (sw, sh) = ((x1 - x0).max(0.0001), (y1 - y0).max(0.0001));
    pos.into_iter().map(|p| if n == 1 { (0.5, 0.5) } else { ((p.0 - x0) / sw, (p.1 - y0) / sh) }).collect()
}

#[expect(clippy::too_many_arguments, reason = "a graph's place and what it needs to draw")]
fn draw_graph(
    pen: &mut Pen<'_, '_>,
    graph: &GraphSet,
    total_nodes: usize,
    total_edges: usize,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    words: &Words,
) {
    let nodes: Vec<&crate::shapes::Node> = graph.nodes.iter().take(MAX_GRAPH_NODES).collect();
    let index: BTreeMap<&str, usize> = nodes.iter().enumerate().map(|(i, n)| (n.id.as_str(), i)).collect();
    let edges: Vec<(usize, usize)> = graph
        .edges
        .iter()
        .filter_map(|e| Some((*index.get(e.from.as_str())?, *index.get(e.to.as_str())?)))
        .take(MAX_GRAPH_EDGES)
        .collect();
    let total_nodes = total_nodes.max(graph.nodes.len());
    let total_edges = total_edges.max(graph.edges.len());
    let more = total_nodes - nodes.len();
    let more_edges = total_edges.saturating_sub(edges.len());
    let area_h = (h - 16.0 - note_h(more + more_edges)).max(80.0);
    if nodes.is_empty() {
        pen.text(x, y + 12.0, 9.0, Weight::Regular, MUTED, words.no_data);
        return;
    }
    let pos = layout(nodes.len(), &edges);
    let pad = 24.0;
    let at = |i: usize| (x + pad + pos[i].0 * (w - 2.0 * pad), y + 10.0 + pos[i].1 * (area_h - 20.0));
    for &(a, b) in &edges {
        let (p, q) = (at(a), at(b));
        pen.line(p.0, p.1, q.0, q.1, (190, 190, 196), 0.6);
    }
    let labels: Vec<&str> = graph.schema.labels.iter().map(String::as_str).collect();
    let color = |n: &crate::shapes::Node| {
        let i = n.labels.first().and_then(|l| labels.iter().position(|x| x == l)).unwrap_or(0);
        PALETTE[i % PALETTE.len()]
    };
    let r = if nodes.len() > 60 { 3.0 } else { 5.0 };
    for (i, n) in nodes.iter().enumerate() {
        let (cx, cy) = at(i);
        pen.fill_path(circle_path(cx, cy, r), color(n));
        if nodes.len() <= 60 {
            let text = pen.fonts.fit(&caption(n), 90.0, 7.0, Weight::Regular);
            pen.text_center(cx, cy + r + 8.0, 7.0, Weight::Regular, TEXT, &text);
        }
    }
    let mut lx = x;
    let ly = y + area_h + 10.0;
    for (i, label) in labels.iter().take(8).enumerate() {
        pen.fill_path(circle_path(lx + 4.0, ly - 3.0, 3.5), PALETTE[i % PALETTE.len()]);
        let text = pen.fonts.fit(label, 140.0, 8.0, Weight::Regular);
        pen.text(lx + 11.0, ly, 8.0, Weight::Regular, MUTED, &text);
        lx += 22.0 + pen.fonts.width(&text, 8.0, Weight::Regular);
    }
    let mut counts = String::new();
    let _ = write!(counts, "{total_nodes} · {total_edges}");
    pen.text_right(x + w, ly, 8.0, Weight::Regular, MUTED, &counts);
    if more > 0 {
        note(pen, x, ly + 16.0, more, words.more_nodes);
    } else {
        note(pen, x, ly + 16.0, more_edges, words.more_edges);
    }
}

/// One span of a waterfall.
struct SpanRow {
    depth: usize,
    label: String,
    start: i64,
    duration: f64,
    error: bool,
}

/// The spans in tree order (each after its parent, children by start), with their depth.
fn trace_body(trace: &crate::shapes::TraceSet, total: usize) -> Body<'_> {
    use std::collections::HashMap;
    let spans = &trace.spans;
    let ids: std::collections::HashSet<(&str, &str)> =
        spans.iter().map(|s| (s.trace_id.as_str(), s.span_id.as_str())).collect();
    let mut children: HashMap<(&str, &str), Vec<usize>> = HashMap::new();
    let mut roots = Vec::new();
    for (i, s) in spans.iter().enumerate() {
        match s.parent_span_id.as_deref().filter(|p| ids.contains(&(s.trace_id.as_str(), p))) {
            Some(p) => children.entry((s.trace_id.as_str(), p)).or_default().push(i),
            // A parent the source did not send makes the span a root here.
            None => roots.push(i),
        }
    }
    let by_start = |list: &mut Vec<usize>| list.sort_by_key(|i| (spans[*i].start, *i));
    by_start(&mut roots);
    for list in children.values_mut() {
        by_start(list);
    }
    let mut rows = Vec::new();
    let mut stack: Vec<(usize, usize)> = roots.iter().rev().map(|i| (*i, 0)).collect();
    while let Some((i, depth)) = stack.pop() {
        if rows.len() >= MAX_SPANS {
            break;
        }
        let s = &spans[i];
        rows.push(SpanRow {
            depth: depth.min(12),
            label: format!("{} · {}", s.service, s.operation),
            start: s.start,
            duration: s.duration.max(0.0),
            error: s.status == crate::shapes::SpanStatus::Error,
        });
        if let Some(list) = children.get(&(s.trace_id.as_str(), s.span_id.as_str())) {
            stack.extend(list.iter().rev().map(|c| (*c, depth + 1)));
        }
    }
    let from = spans.iter().map(|s| s.start).min().unwrap_or(0);
    let to = spans.iter().map(|s| s.start.saturating_add(s.duration.max(0.0).ceil() as i64)).max().unwrap_or(from);
    Body::Trace { more: total.max(spans.len()).saturating_sub(rows.len()), rows, from, to }
}

/// A duration in microseconds as people read it.
fn span_duration(us: f64, lang: ReportLanguage) -> String {
    if us >= 1_000_000.0 {
        format!("{} s", number_with(us / 1_000_000.0, 2, lang))
    } else if us >= 1000.0 {
        format!("{} ms", number_with(us / 1000.0, 1, lang))
    } else {
        format!("{} µs", number_with(us, 0, lang))
    }
}

/// The waterfall: a label column with the spans indented by depth, a bar per span within the
/// trace's time, red-toned for errors, and the duration after the bar.
#[expect(clippy::too_many_arguments, reason = "a waterfall's place and what it needs to draw")]
fn draw_trace(
    pen: &mut Pen<'_, '_>,
    rows: &[SpanRow],
    from: i64,
    to: i64,
    more: usize,
    x: f32,
    y: f32,
    w: f32,
    lang: ReportLanguage,
    words: &Words,
) {
    const ERROR: Rgb = (198, 61, 47);
    let label_w = (w * 0.38).min(300.0);
    let (bx, bw) = (x + label_w + 8.0, w - label_w - 70.0);
    let span = (to - from).max(1) as f64;
    pen.text_right(bx + bw, y + 9.0, 7.5, Weight::Regular, MUTED, &span_duration(span, lang));
    pen.text(bx, y + 9.0, 7.5, Weight::Regular, MUTED, "0");
    for (i, r) in rows.iter().enumerate() {
        let ry = y + 14.0 + ROW_H * i as f32;
        if i % 2 == 1 {
            pen.rect(x, ry, w, ROW_H, BG);
        }
        let indent = 8.0 * r.depth as f32;
        let label = pen.fonts.fit(&r.label, label_w - indent, 8.0, Weight::Regular);
        pen.text(x + indent, ry + 10.5, 8.0, Weight::Regular, if r.error { ERROR } else { TEXT }, &label);
        let start = ((r.start - from) as f64 / span) as f32 * bw;
        let len = ((r.duration / span) as f32 * bw).max(1.5);
        pen.fill_path(
            rect_path(bx + start, ry + 4.0, len.min(bw - start).max(1.5), ROW_H - 8.0, 1.5),
            if r.error { ERROR } else { PALETTE[0] },
        );
        pen.text(bx + bw + 6.0, ry + 10.5, 7.5, Weight::Regular, MUTED, &span_duration(r.duration, lang));
    }
    note(pen, x, y + 14.0 + ROW_H * rows.len() as f32 + 11.0, more, words.more_spans);
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::steps::NamedFrame;
    use crate::shapes::{Edge, Field, GraphSchema, Node, OrderedJson, TimeRange};
    use serde_json::json;

    const HOUR: i64 = 3_600_000;
    const T0: i64 = 1_800_000_000_000;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn frame(fields: Vec<Field>) -> Results {
        Results {
            frames: vec![NamedFrame { name: "A".into(), frame: Frame::new(fields).unwrap() }],
            ..Default::default()
        }
    }

    fn panel(id: &str, kind: &str, title: &str, content: Content) -> PanelOut {
        PanelOut { id: id.into(), title: title.into(), kind: kind.into(), options: json!({}), unit: None, content }
    }

    fn series() -> Results {
        let times: Vec<Value> = (0..48).map(|i| json!(T0 + i * HOUR)).collect();
        frame(vec![
            field("time", FieldType::Time, times),
            field("Lager Nord", FieldType::Number, (0..48).map(|i| json!(f64::from(i) * 1.5)).collect()),
            field(
                "Lager Süd",
                FieldType::Number,
                (0..48).map(|i| if i == 10 { Value::Null } else { json!(40 - i) }).collect(),
            ),
        ])
    }

    fn documents() -> Results {
        let docs = (0..12)
            .map(|i| {
                OrderedJson::from_text(format!(
                    r#"{{"bestellung": {i}, "kunde": {{"name": "Müller {i}", "ort": "Köln"}}, "posten": [1, 2]}}"#
                ))
                .unwrap()
            })
            .collect();
        Results {
            documents: vec![(
                "A".into(),
                DocumentSet {
                    documents: docs,
                    schema: vec![],
                    next_cursor: None,
                    truncated: None,
                    notices: vec![],
                    executed_query: None,
                    distributable: false,
                },
            )],
            ..Default::default()
        }
    }

    fn graph() -> Results {
        let node = |id: &str, label: &str, name: &str| Node {
            id: id.into(),
            labels: vec![label.into()],
            properties: [("name".to_string(), json!(name))].into(),
        };
        let edge = |id: &str, from: &str, to: &str| Edge {
            id: id.into(),
            edge_type: "LIEFERT".into(),
            from: from.into(),
            to: to.into(),
            properties: Default::default(),
        };
        Results {
            graphs: vec![(
                "A".into(),
                GraphSet {
                    nodes: vec![
                        node("1", "Lieferant", "Acme"),
                        node("2", "Lager", "Nordlager"),
                        node("3", "Lager", "Suedlager"),
                    ],
                    edges: vec![edge("e1", "1", "2"), edge("e2", "1", "3")],
                    paths: None,
                    schema: GraphSchema { labels: vec!["Lieferant".into(), "Lager".into()], ..Default::default() },
                    truncated: None,
                    notices: None,
                },
            )],
            ..Default::default()
        }
    }

    fn gathered(panels: Vec<PanelOut>) -> Gathered {
        Gathered {
            dashboard_title: "Lager".into(),
            range: TimeRange { from: T0, to: T0 + 48 * HOUR },
            zone: chrono_tz::Europe::Berlin,
            variables: [("region".to_string(), json!("nord"))].into(),
            panels,
        }
    }

    /// The text of every page, without the spaces the extraction may put between glyphs.
    fn text_of(bytes: &[u8]) -> (usize, String) {
        let doc = lopdf::Document::load_mem(bytes).expect("a valid PDF file");
        let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
        let text = doc.extract_text(&pages).expect("text");
        (pages.len(), text.chars().filter(|c| !c.is_whitespace()).collect())
    }

    fn render_all(panels: Vec<PanelOut>, lang: ReportLanguage) -> (Rendered, String) {
        let g = gathered(panels);
        let rendered = render(&g, &Cover { title: "Wochenbericht", generated_at: T0 }, lang).unwrap();
        assert!(rendered.bytes.starts_with(b"%PDF-"));
        let (pages, text) = text_of(&rendered.bytes);
        assert_eq!(pages, rendered.pages);
        (rendered, text)
    }

    #[test]
    fn every_shape_renders_with_its_text() {
        let table = frame(vec![
            field("Region", FieldType::String, (0..40).map(|i| json!(format!("Region{i}"))).collect()),
            field("Umsatz", FieldType::Number, (0..40).map(|i| json!(i * 1000)).collect()),
        ]);
        let bars = frame(vec![
            field("Region", FieldType::String, vec![json!("Nord"), json!("Sued")]),
            field("Umsatz", FieldType::Number, vec![json!(12.5), json!(-3)]),
        ]);
        let stat = frame(vec![field("Offen", FieldType::Number, vec![json!(1), json!(42)])]);
        let panels = vec![
            panel("p1", "timeseries", "Bestand", Content::Results(series())),
            panel("p2", "bar", "Regionen", Content::Results(bars)),
            panel("p3", "stat", "Offen", Content::Results(stat)),
            panel("p4", "table", "Umsatztabelle", Content::Results(table)),
            panel("p5", "documents", "Bestellungen", Content::Results(documents())),
            panel("p6", "network", "Lieferkette", Content::Results(graph())),
            panel("p7", "text", "Hinweis", Content::Text("# Lesehilfe\nDie Zahlen sind vorläufig.".into())),
            panel(
                "p8",
                "piechart",
                "Anteile",
                Content::Unavailable { code: "steps.timeout".into(), message: "the steps took too long".into() },
            ),
            panel("p9", "timeseries", "Falsche Form", Content::Results(documents())),
        ];
        let (rendered, text) = render_all(panels, ReportLanguage::De);
        assert!(rendered.pages >= 3, "{} pages", rendered.pages);
        for expected in [
            "Wochenbericht",
            "Dashboard:Lager",
            "region=nord",
            "Bestand",
            "LagerNord",
            "Regionen",
            "42",
            "Region0",
            "weitereZeilen",
            "Dokument1",
            "Müller0",
            "Nordlager",
            "Lesehilfe",
            "vorläufig",
            "Nichtdargestellt",
            "steps.timeout",
            "reports.shape_mismatch",
            "Seite1von",
        ] {
            assert!(text.contains(expected), "{expected} missing in {text}");
        }
    }

    #[test]
    fn english_files_and_many_panels_flow_onto_pages() {
        let panels: Vec<PanelOut> = (0..12)
            .map(|i| panel(&format!("p{i}"), "timeseries", &format!("Chart{i}"), Content::Results(series())))
            .collect();
        let (rendered, text) = render_all(panels, ReportLanguage::En);
        assert!(rendered.pages >= 6, "{} pages", rendered.pages);
        assert!(
            text.contains("Chart11") && text.contains(&format!("Page{}of{}", rendered.pages, rendered.pages)),
            "{text}"
        );
        let empty =
            render_all(vec![panel("p", "table", "Leer", Content::Results(Results::default()))], ReportLanguage::En).1;
        assert!(empty.contains("Nodatainthetimerange"), "{empty}");
    }

    #[test]
    fn numbers_read_as_the_language_writes_them() {
        assert_eq!(number(1234567.891, ReportLanguage::De), "1.234.568");
        assert_eq!(number(1234567.891, ReportLanguage::En), "1,234,568");
        assert_eq!(number(12.5, ReportLanguage::De), "12,5");
        assert_eq!(number(-0.01234, ReportLanguage::En), "-0.0123");
        assert_eq!(number(f64::NAN, ReportLanguage::En), "–");
        assert_eq!(with_unit(number(5.0, ReportLanguage::De), Some("ms")), "5 ms");
    }

    #[test]
    fn value_axes_are_round() {
        let (lo, hi, ticks) = value_axis(3.2, 97.0);
        assert_eq!((lo, hi), (0.0, 100.0));
        assert_eq!(ticks, [0.0, 20.0, 40.0, 60.0, 80.0, 100.0]);
        let (lo, hi, _) = value_axis(5.0, 5.0);
        assert!(lo < 5.0 && hi > 5.0);
    }

    #[test]
    fn the_layout_is_stable_and_inside_the_square() {
        let edges = [(0, 1), (1, 2), (2, 0), (2, 3)];
        let a = layout(4, &edges);
        assert_eq!(a, layout(4, &edges));
        assert!(a.iter().all(|(x, y)| (0.0..=1.0).contains(x) && (0.0..=1.0).contains(y)));
        assert_eq!(layout(1, &[]), [(0.5, 0.5)]);
    }

    #[test]
    fn documents_keep_their_key_order_and_typed_values() {
        let set = DocumentSet {
            documents: vec![
                crate::shapes::OrderedJson::from_text(
                    r#"{"zeta": 1, "alpha": {"$type": "objectId", "value": "65f0"}, "items": [{"sku": "A-1"}]}"#.into(),
                )
                .unwrap(),
            ],
            schema: vec![],
            next_cursor: None,
            truncated: None,
            notices: vec![],
            executed_query: None,
            distributable: false,
        };
        let (lines, more) = document_lines(&set, 1, &EN);
        let keys: Vec<&str> = lines.iter().map(|l| l.1.as_str()).collect();
        assert_eq!(keys, ["Document 1", "zeta", "alpha", "items", "[0]", "sku"]);
        assert_eq!(lines[2].2, "65f0 (objectId)");
        assert_eq!(more, 0);
    }

    #[test]
    fn a_huge_cell_does_not_stall_rendering() {
        let big = "x".repeat(200 * 1024);
        let words = (0..20_000).map(|i| format!("Wort{i}")).collect::<Vec<_>>().join(" ");
        let table = frame(vec![field("Notiz", FieldType::String, vec![json!(big.clone()), json!(big.clone())])]);
        let panels = vec![
            panel("p1", "table", &big, Content::Results(table)),
            panel("p2", "text", "Text", Content::Text(format!("{big}\n{words}"))),
        ];
        let started = std::time::Instant::now();
        let (rendered, _) = render_all(panels, ReportLanguage::En);
        assert!(rendered.pages >= 1);
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "took {:?}", started.elapsed());
        // A deadline that passed fails the rendering.
        let g = gathered(vec![panel("p", "table", "T", Content::Results(series()))]);
        let past = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let e = render_until(&g, &Cover { title: "T", generated_at: T0 }, ReportLanguage::En, past).err().unwrap();
        assert!(e.contains("longer than"), "{e}");
    }

    #[test]
    fn cut_results_keep_their_counts_for_the_notes() {
        let rows = 40;
        let mut out = panel(
            "p",
            "table",
            "T",
            Content::Results(frame(vec![field("n", FieldType::Number, (0..rows).map(|i| json!(i)).collect())])),
        );
        crate::reports::gather::trim(&mut out);
        let Content::Results(r) = &out.content else { unreachable!() };
        assert_eq!((r.frames[0].frame.rows(), r.totals["A"]), (MAX_TABLE_ROWS, 40));
        let (_, text) = render_all(vec![out], ReportLanguage::En);
        assert!(text.contains("15morerowsnotshown"), "{text}");
        let mut stat = panel(
            "s",
            "stat",
            "S",
            Content::Results(frame(vec![field("v", FieldType::Number, vec![json!(1), json!(5)])])),
        );
        stat.options = json!({ "reducer": "max" });
        crate::reports::gather::trim(&mut stat);
        let (_, text) = render_all(vec![stat], ReportLanguage::En);
        assert!(text.contains('5'), "{text}");
    }

    fn span(
        id: &str,
        parent: Option<&str>,
        service: &str,
        start: i64,
        duration: f64,
        error: bool,
    ) -> crate::shapes::Span {
        crate::shapes::Span {
            trace_id: "4bf92f3577b34da6a3ce929d0e0e4736".into(),
            span_id: id.into(),
            parent_span_id: parent.map(str::to_string),
            service: service.into(),
            operation: format!("op-{id}"),
            start,
            duration,
            status: if error { crate::shapes::SpanStatus::Error } else { crate::shapes::SpanStatus::Ok },
            status_message: None,
            kind: Default::default(),
            attributes: Default::default(),
            resource: Default::default(),
            scope: None,
            events: vec![],
            links: vec![],
        }
    }

    #[test]
    fn traces_draw_as_a_waterfall_in_tree_order() {
        let trace = crate::shapes::TraceSet {
            spans: vec![
                span("a1", None, "frontend", 1_000, 50_000.0, false),
                span("c3", Some("a1"), "lager", 30_000, 5_000.0, true),
                span("b2", Some("a1"), "checkout", 2_000, 20_000.0, false),
                span("d4", Some("b2"), "db", 3_000, 1_500.0, false),
            ],
            ..Default::default()
        };
        let Body::Trace { rows, from, to, more } = trace_body(&trace, 10) else { panic!("a waterfall") };
        let labels: Vec<(usize, &str)> = rows.iter().map(|r| (r.depth, r.label.as_str())).collect();
        assert_eq!(labels, [(0, "frontend · op-a1"), (1, "checkout · op-b2"), (2, "db · op-d4"), (1, "lager · op-c3")]);
        assert!(rows[3].error);
        assert_eq!((from, to, more), (1_000, 51_000, 6));
        let results = Results { traces: vec![("A".into(), trace)], ..Default::default() };
        let (_, text) =
            render_all(vec![panel("t", "table", "Checkout-Trace", Content::Results(results))], ReportLanguage::En);
        for expected in ["Checkout-Trace", "frontend·op-a1", "lager·op-c3", "50ms"] {
            assert!(text.contains(expected), "{expected} missing in {text}");
        }
    }
}
