//! The reduce step: a result in its native shape to one number per instance. Frames give one
//! instance per series, documents and graphs one per rule. Nothing is converted between shapes,
//! and a value where a number is expected is never read as one when it is text.
//!
//! Which fields of a frame are series: every `number`, `int64` and `decimal` field. In a long
//! table (a frame with text fields) the text fields name the series of each row, and every number
//! field is a series per combination of them. A numeric id column is therefore a series of its
//! own, not a label; the preview shows the series with their labels and the fields they came from
//! ([`Reduction::value_fields`], [`Reduction::label_fields`]), and the query decides by what it
//! selects (cast the id to text to make it a label).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{EvalError, Labels};
use crate::alerting::rule::{self, DocumentFunction, DocumentMode, FrameFunction, GraphCount, PathStep, Reduce};
use crate::shapes::{DocumentSet, FieldType, Frame, GraphSet, QueryResult, Shape};

/// The label that names the field of a series when the field has no labels of its own (a SQL
/// column), so two columns of one row stay two instances.
pub const FIELD_LABEL: &str = "__field__";

/// A reduced value: a number, or no value at all (a series with only empty values, a reducer
/// other than `count` over nothing).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reduced {
    Value(f64),
    NoValue,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SeriesValue {
    pub labels: Labels,
    /// The field the series came from (empty for documents and graphs).
    pub field: String,
    pub value: Reduced,
}

/// The reduce step's answer, also what the editor's preview shows.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reduction {
    /// One entry per instance, in result order. Empty for a frame without a single series.
    pub series: Vec<SeriesValue>,
    /// Documents that did not count because the field is missing or empty (named in the preview).
    pub skipped_documents: usize,
    /// The frame fields that became series, and the text fields that labelled them.
    pub value_fields: Vec<String>,
    pub label_fields: Vec<String>,
    /// The source cut the result: the values are of what arrived only.
    pub truncated: Option<EvalError>,
}

/// Reduces `result` as `spec` says. More than `max_instances` series is an error, as is a
/// result in another shape than the spec's. A cut result is reduced as far as it arrived and
/// marked in `truncated`; [`super::outcome`] decides whether that may count.
pub fn reduce(spec: &Reduce, result: &QueryResult, max_instances: usize) -> Result<Reduction, EvalError> {
    match (spec, result) {
        (Reduce::Frame { function }, QueryResult::Frame { frame }) => reduce_frame(*function, frame, max_instances),
        (Reduce::Documents { mode, path, function }, QueryResult::Documents { documents }) => {
            reduce_documents(*mode, path.as_deref(), *function, documents)
        }
        (Reduce::Graph { count, label }, QueryResult::Graph { graph }) => {
            let truncated = graph
                .truncated
                .as_ref()
                .map(|t| EvalError::Truncated { limit: Some(t.limit), reason: t.reason.clone() });
            Ok(Reduction {
                series: vec![SeriesValue {
                    labels: Labels::new(),
                    field: String::new(),
                    value: Reduced::Value(count_graph(*count, label.as_deref(), graph)?),
                }],
                truncated,
                ..Reduction::default()
            })
        }
        (spec, result) => Err(EvalError::WrongShape {
            expected: shape_name(match spec {
                Reduce::Frame { .. } => Shape::Frame,
                Reduce::Documents { .. } => Shape::Documents,
                Reduce::Graph { .. } => Shape::Graph,
            })
            .into(),
            got: shape_name(result.shape()).into(),
        }),
    }
}

/// Whether the reduce step counts, so a cut result gives a lower bound of the true value.
pub fn is_count(spec: &Reduce) -> bool {
    matches!(
        spec,
        Reduce::Frame { function: FrameFunction::Count }
            | Reduce::Documents { mode: DocumentMode::Count, .. }
            | Reduce::Graph { .. }
    )
}

fn shape_name(shape: Shape) -> &'static str {
    match shape {
        Shape::Frame => "frame",
        Shape::Documents => "documents",
        Shape::Graph => "graph",
    }
}

/// Running reduction over one series or field, in one pass.
#[derive(Default)]
struct Acc {
    count: u64,
    min: f64,
    max: f64,
    sum: f64,
    /// Incremental mean, so values near the largest double do not overflow to infinity.
    mean: f64,
    /// The value with the latest time (ties: the later row); without times the last row.
    last: Option<(Option<f64>, f64)>,
    first: Option<f64>,
}

impl Acc {
    fn push(&mut self, value: f64, time: Option<f64>) {
        self.count += 1;
        if self.count == 1 {
            self.min = value;
            self.max = value;
            self.mean = value;
            self.first = Some(value);
        } else {
            self.min = self.min.min(value);
            self.max = self.max.max(value);
            self.mean += (value - self.mean) / self.count as f64;
        }
        self.sum += value;
        // `None` times sort before every time, so rows with a time win over rows without.
        if self.last.is_none_or(|(t, _)| time >= t) {
            self.last = Some((time, value));
        }
    }

    fn mean(&self) -> f64 {
        // The incremental mean of equal infinities is NaN (inf - inf); the plain one is right then.
        if self.mean.is_nan() { self.sum / self.count as f64 } else { self.mean }
    }

    fn frame(&self, function: FrameFunction) -> Reduced {
        if function == FrameFunction::Count {
            return Reduced::Value(self.count as f64);
        }
        if self.count == 0 {
            return Reduced::NoValue;
        }
        Reduced::Value(match function {
            FrameFunction::Last => self.last.map_or(f64::NAN, |(_, v)| v),
            FrameFunction::Min => self.min,
            FrameFunction::Max => self.max,
            FrameFunction::Mean => self.mean(),
            FrameFunction::Sum => self.sum,
            FrameFunction::Count => unreachable!("handled above"),
        })
    }

    fn field(&self, function: DocumentFunction) -> Reduced {
        if self.count == 0 {
            return Reduced::NoValue;
        }
        Reduced::Value(match function {
            DocumentFunction::First => self.first.unwrap_or(f64::NAN),
            DocumentFunction::Min => self.min,
            DocumentFunction::Max => self.max,
            DocumentFunction::Mean => self.mean(),
            DocumentFunction::Sum => self.sum,
        })
    }
}

/// A reduced NaN (+Infinity plus -Infinity) is no number; never compared, always an error.
fn checked(value: Reduced, field: &str) -> Result<Reduced, EvalError> {
    match value {
        Reduced::Value(v) if v.is_nan() => Err(EvalError::NaN { field: field.to_string() }),
        other => Ok(other),
    }
}

/// What a JSON value is, as the `found` parameter of [`EvalError::NotANumber`].
fn kind(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "bool".into(),
        Value::Number(_) => "number".into(),
        Value::String(_) => "text".into(),
        Value::Array(_) => "array".into(),
        Value::Object(_) => match typed(value) {
            Some((t, _)) => t.to_string(),
            None => "object".into(),
        },
    }
}

/// `{"$type": kind, "value": text}` (see `shapes::typed`).
fn typed(value: &Value) -> Option<(&str, &str)> {
    let map = value.as_object()?;
    if map.len() != 2 {
        return None;
    }
    Some((map.get("$type")?.as_str()?, map.get("value")?.as_str()?))
}

/// Typed values that are numbers in their database.
const NUMERIC_TYPES: &[&str] = &["int32", "int64", "long", "double", "float", "decimal", "number"];

/// The number a value holds: `Ok(None)` for no value (null, NaN), an error for anything that is
/// not a number. `text_is_number` is for Int64 and Decimal fields, whose numbers are decimal
/// strings so no digit is lost; anywhere else text is an error.
fn number(value: &Value, text_is_number: bool, field: &str) -> Result<Option<f64>, EvalError> {
    let not_a_number = || EvalError::NotANumber { field: field.to_string(), found: kind(value) };
    let parsed = match value {
        Value::Null => return Ok(None),
        Value::Number(n) => n.as_f64().ok_or_else(not_a_number)?,
        Value::String(s) if text_is_number => parse_decimal(s).ok_or_else(not_a_number)?,
        Value::Object(_) => match typed(value) {
            Some((t, text)) if NUMERIC_TYPES.contains(&t) => parse_decimal(text).ok_or_else(not_a_number)?,
            _ => return Err(not_a_number()),
        },
        _ => return Err(not_a_number()),
    };
    Ok(if parsed.is_nan() { None } else { Some(parsed) })
}

/// A decimal number as databases write it: digits with one optional sign, exponent, `NaN`,
/// `Infinity` (`inf`, `+Inf`). Not hex, not empty, no surrounding spaces, no second sign.
fn parse_decimal(text: &str) -> Option<f64> {
    let unsigned = text.strip_prefix(['+', '-']).unwrap_or(text);
    if unsigned.is_empty()
        || unsigned.starts_with(['+', '-'])
        || !unsigned.starts_with(|c: char| c.is_alphanumeric() || c == '.')
    {
        return None;
    }
    if text.ends_with(|c: char| c.is_whitespace()) {
        return None;
    }
    text.parse::<f64>().ok()
}

/// A time value in Unix milliseconds; anything else counts as no time.
fn time(value: &Value) -> Option<f64> {
    value.as_f64().filter(|t| t.is_finite())
}

fn reduce_frame(function: FrameFunction, frame: &Frame, max_instances: usize) -> Result<Reduction, EvalError> {
    let fields = frame.fields();
    let values: Vec<usize> = fields
        .iter()
        .enumerate()
        .filter(|(_, f)| matches!(f.field_type, FieldType::Number | FieldType::Int64 | FieldType::Decimal))
        .map(|(i, _)| i)
        .collect();
    let time_field = fields
        .iter()
        .position(|f| f.field_type == FieldType::Time)
        .or_else(|| fields.iter().position(|f| f.field_type == FieldType::Date));
    // A long table: its text columns name the series of each row.
    let label_fields: Vec<usize> =
        fields.iter().enumerate().filter(|(_, f)| f.field_type == FieldType::String).map(|(i, _)| i).collect();
    let truncated = frame
        .meta()
        .filter(|m| m.rows_truncated)
        .map(|_| EvalError::Truncated { limit: None, reason: Some("rows_truncated".into()) });
    let mut reduction = Reduction {
        value_fields: values.iter().map(|&f| fields[f].name.clone()).collect(),
        label_fields: label_fields.iter().map(|&f| fields[f].name.clone()).collect(),
        truncated,
        ..Reduction::default()
    };

    let rows = frame.rows();
    if values.is_empty() || rows == 0 {
        return Ok(reduction);
    }
    let too_many = |groups: usize| groups.saturating_mul(values.len()) > max_instances;

    // Rows per label combination, in order of first appearance.
    let mut groups: Vec<(Labels, Vec<usize>)> = Vec::new();
    if label_fields.is_empty() {
        groups.push((Labels::new(), (0..rows).collect()));
    } else {
        let mut index: HashMap<Vec<Option<&str>>, usize> = HashMap::new();
        for row in 0..rows {
            let key: Vec<Option<&str>> = label_fields.iter().map(|&f| fields[f].values[row].as_str()).collect();
            let at = match index.get(&key) {
                Some(&at) => at,
                None => {
                    // Stop as soon as there are too many, not after grouping a huge table.
                    if too_many(groups.len() + 1) {
                        return Err(EvalError::TooManySeries { limit: max_instances });
                    }
                    let labels = label_fields
                        .iter()
                        .zip(&key)
                        .filter_map(|(&f, v)| v.map(|v| (fields[f].name.clone(), v.to_string())))
                        .collect();
                    groups.push((labels, Vec::new()));
                    index.insert(key, groups.len() - 1);
                    groups.len() - 1
                }
            };
            groups[at].1.push(row);
        }
    }
    if too_many(groups.len()) {
        return Err(EvalError::TooManySeries { limit: max_instances });
    }

    let mut seen = HashSet::with_capacity(groups.len() * values.len());
    for &f in &values {
        let field = &fields[f];
        let text_is_number = field.field_type != FieldType::Number;
        for (group_labels, group_rows) in &groups {
            let mut labels = group_labels.clone();
            match &field.labels {
                Some(own) if !own.is_empty() => labels.extend(own.iter().map(|(k, v)| (k.clone(), v.clone()))),
                _ => {
                    labels.insert(FIELD_LABEL.to_string(), field.name.clone());
                }
            }
            if !seen.insert(labels.clone()) {
                return Err(EvalError::DuplicateSeries { labels: label_text(&labels) });
            }
            let mut acc = Acc::default();
            for &row in group_rows {
                if let Some(v) = number(&field.values[row], text_is_number, &field.name)? {
                    acc.push(v, time_field.and_then(|t| time(&fields[t].values[row])));
                }
            }
            let value = checked(acc.frame(function), &field.name)?;
            reduction.series.push(SeriesValue { labels, field: field.name.clone(), value });
        }
    }
    Ok(reduction)
}

/// `{a="1", b="2"}`, for texts.
pub fn label_text(labels: &Labels) -> String {
    let inner: Vec<String> = labels.iter().map(|(k, v)| format!("{k}={v:?}")).collect();
    format!("{{{}}}", inner.join(", "))
}

/// The value at a parsed path; `None` when it is missing. The wrapper of a document that has its
/// own `$type` key is looked through; other typed values are leaves.
fn value_at<'a>(document: &'a Value, steps: &[PathStep]) -> Option<&'a Value> {
    let mut current = document;
    for step in steps {
        if let Some(map) = current.as_object()
            && map.len() == 2
            && map.get("$type").and_then(Value::as_str) == Some("document")
            && let Some(inner @ Value::Object(_)) = map.get("value")
        {
            current = inner;
        }
        current = match (step, current) {
            (PathStep::Index(i), Value::Array(items)) => items.get(*i)?,
            (PathStep::Key(k), Value::Array(items)) if k.bytes().all(|b| b.is_ascii_digit()) => {
                items.get(k.parse::<usize>().ok()?)?
            }
            (PathStep::Key(k), Value::Object(_)) if typed(current).is_none() => current.get(k)?,
            _ => return None,
        };
    }
    Some(current)
}

fn reduce_documents(
    mode: DocumentMode,
    path: Option<&str>,
    function: Option<DocumentFunction>,
    set: &DocumentSet,
) -> Result<Reduction, EvalError> {
    let truncated = match (&set.truncated, &set.next_cursor) {
        (Some(t), _) => Some(EvalError::Truncated { limit: Some(t.limit), reason: t.reason.clone() }),
        (None, Some(_)) => Some(EvalError::Truncated { limit: None, reason: Some("next_cursor".into()) }),
        (None, None) => None,
    };
    let (path, function) = match (mode, path, function) {
        // Zero documents is a value, not missing data.
        (DocumentMode::Count, None, None) => {
            return Ok(Reduction {
                series: vec![SeriesValue {
                    labels: Labels::new(),
                    field: String::new(),
                    value: Reduced::Value(set.documents.len() as f64),
                }],
                truncated,
                ..Reduction::default()
            });
        }
        (DocumentMode::Field, Some(path), Some(function)) => (path, function),
        _ => return Err(EvalError::InvalidRule),
    };
    let steps = rule::parse_path(path).ok_or(EvalError::InvalidRule)?;
    let mut acc = Acc::default();
    let mut skipped = 0;
    for document in &set.documents {
        let document: Value = serde_json::from_str(document.get()).map_err(|_| EvalError::QueryFailed)?;
        match value_at(&document, &steps) {
            Some(value) => match number(value, false, path)? {
                Some(v) => acc.push(v, None),
                None => skipped += 1,
            },
            None => skipped += 1,
        }
    }
    let value = checked(acc.field(function), path)?;
    // A field missing in every document is no data: no instance value, so the caller decides.
    Ok(Reduction {
        series: vec![SeriesValue { labels: Labels::new(), field: path.to_string(), value }],
        skipped_documents: skipped,
        truncated,
        ..Reduction::default()
    })
}

fn count_graph(count: GraphCount, label: Option<&str>, graph: &GraphSet) -> Result<f64, EvalError> {
    let n = match (count, label) {
        (GraphCount::Nodes, None) => graph.nodes.len(),
        (GraphCount::Nodes, Some(label)) => graph.nodes.iter().filter(|n| n.labels.iter().any(|l| l == label)).count(),
        (GraphCount::Edges, None) => graph.edges.len(),
        (GraphCount::Edges, Some(t)) => graph.edges.iter().filter(|e| e.edge_type == t).count(),
        // A result without paths is not "zero paths": the query returned none to count.
        (GraphCount::Paths, _) => graph.paths.as_ref().ok_or(EvalError::NoPaths)?.len(),
    };
    Ok(n as f64)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use proptest::prelude::*;
    use serde_json::json;

    use super::*;
    use crate::shapes::{Edge, Field, FrameMeta, GraphPath, Node, OrderedJson, Truncated};

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn labelled(name: &str, labels: &[(&str, &str)], values: Vec<Value>) -> Field {
        Field {
            labels: Some(labels.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
            ..field(name, FieldType::Number, values)
        }
    }

    fn frame(fields: Vec<Field>) -> QueryResult {
        QueryResult::Frame { frame: Frame::new(fields).unwrap() }
    }

    fn labels(pairs: &[(&str, &str)]) -> Labels {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn frame_spec(function: FrameFunction) -> Reduce {
        Reduce::Frame { function }
    }

    fn one(result: Result<Reduction, EvalError>) -> Reduced {
        let reduction = result.unwrap();
        assert_eq!(reduction.series.len(), 1, "{reduction:?}");
        reduction.series[0].value
    }

    fn values(reduction: &Reduction) -> Vec<(Labels, Reduced)> {
        reduction.series.iter().map(|s| (s.labels.clone(), s.value)).collect()
    }

    #[test]
    fn frame_functions_on_one_series() {
        let result = frame(vec![
            field("time", FieldType::Time, vec![json!(3000), json!(1000), json!(2000), json!(4000)]),
            field("v", FieldType::Number, vec![json!(5), json!(-1), json!(null), json!(2.5)]),
        ]);
        let cases = [
            (FrameFunction::Last, 2.5),
            (FrameFunction::Min, -1.0),
            (FrameFunction::Max, 5.0),
            (FrameFunction::Mean, 6.5 / 3.0),
            (FrameFunction::Sum, 6.5),
            (FrameFunction::Count, 3.0),
        ];
        for (function, want) in cases {
            match one(reduce(&frame_spec(function), &result, 100)) {
                Reduced::Value(v) => assert!((v - want).abs() < 1e-12, "{function:?}: {v} != {want}"),
                other => panic!("{function:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn last_takes_the_latest_time_not_the_last_row() {
        let result = frame(vec![
            field("v", FieldType::Number, vec![json!(1), json!(2), json!(3)]),
            field("time", FieldType::Time, vec![json!(300), json!(100), json!(200)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Last), &result, 100)), Reduced::Value(1.0));
        // The latest time with a value: the null at the latest time does not count.
        let result = frame(vec![
            field("v", FieldType::Number, vec![json!(1), json!(null)]),
            field("time", FieldType::Time, vec![json!(100), json!(200)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Last), &result, 100)), Reduced::Value(1.0));
        // Same time twice: the later row.
        let result = frame(vec![
            field("v", FieldType::Number, vec![json!(1), json!(2)]),
            field("time", FieldType::Time, vec![json!(100), json!(100)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Last), &result, 100)), Reduced::Value(2.0));
        // Without a time field, the last row; a Date field counts as time.
        let result = frame(vec![field("v", FieldType::Number, vec![json!(7), json!(8), json!(9)])]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Last), &result, 100)), Reduced::Value(9.0));
        let result = frame(vec![
            field("day", FieldType::Date, vec![json!(86_400_000), json!(0)]),
            field("v", FieldType::Number, vec![json!(7), json!(8)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Last), &result, 100)), Reduced::Value(7.0));
    }

    #[test]
    fn a_series_with_only_empty_values_has_no_value_but_a_count() {
        let result = frame(vec![field("v", FieldType::Number, vec![json!(null), json!(null)])]);
        for function in
            [FrameFunction::Last, FrameFunction::Min, FrameFunction::Max, FrameFunction::Mean, FrameFunction::Sum]
        {
            assert_eq!(one(reduce(&frame_spec(function), &result, 100)), Reduced::NoValue, "{function:?}");
        }
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Count), &result, 100)), Reduced::Value(0.0));
    }

    #[test]
    fn frames_without_series_reduce_to_nothing() {
        let empty_rows =
            frame(vec![field("time", FieldType::Time, vec![]), labelled("value", &[("job", "api")], vec![])]);
        let only_text = frame(vec![field("name", FieldType::String, vec![json!("a")])]);
        let no_fields = frame(vec![]);
        for result in [empty_rows, only_text, no_fields] {
            let reduction = reduce(&frame_spec(FrameFunction::Count), &result, 100).unwrap();
            assert!(reduction.series.is_empty(), "{result:?}");
        }
    }

    #[test]
    fn wide_frames_give_one_series_per_field_with_its_labels() {
        let result = frame(vec![
            field("time", FieldType::Time, vec![json!(1), json!(2)]),
            labelled("value", &[("job", "api"), ("instance", "a")], vec![json!(1), json!(2)]),
            labelled("value", &[("job", "api"), ("instance", "b")], vec![json!(10), json!(20)]),
        ]);
        let reduction = reduce(&frame_spec(FrameFunction::Max), &result, 100).unwrap();
        assert_eq!(
            values(&reduction),
            vec![
                (labels(&[("instance", "a"), ("job", "api")]), Reduced::Value(2.0)),
                (labels(&[("instance", "b"), ("job", "api")]), Reduced::Value(20.0)),
            ]
        );
    }

    #[test]
    fn columns_without_labels_are_named_by_a_field_label() {
        let result = frame(vec![
            field("errors", FieldType::Number, vec![json!(1), json!(2)]),
            field("requests", FieldType::Int64, vec![json!("10"), json!("9007199254740992")]),
        ]);
        let reduction = reduce(&frame_spec(FrameFunction::Sum), &result, 100).unwrap();
        assert_eq!(
            values(&reduction),
            vec![
                (labels(&[(FIELD_LABEL, "errors")]), Reduced::Value(3.0)),
                (labels(&[(FIELD_LABEL, "requests")]), Reduced::Value(9_007_199_254_741_002.0)),
            ]
        );
    }

    #[test]
    fn long_tables_give_one_series_per_label_combination() {
        let result = frame(vec![
            field("time", FieldType::Time, vec![json!(1), json!(1), json!(2), json!(2), json!(3)]),
            field("host", FieldType::String, vec![json!("a"), json!("b"), json!("a"), json!("b"), json!(null)]),
            field("cpu", FieldType::Decimal, vec![json!("0.5"), json!("0.7"), json!("0.9"), json!("0.1"), json!("1")]),
            field("up", FieldType::Bool, vec![json!(true), json!(true), json!(true), json!(true), json!(false)]),
        ]);
        let reduction = reduce(&frame_spec(FrameFunction::Last), &result, 100).unwrap();
        assert_eq!(
            values(&reduction),
            vec![
                (labels(&[("host", "a"), (FIELD_LABEL, "cpu")]), Reduced::Value(0.9)),
                (labels(&[("host", "b"), (FIELD_LABEL, "cpu")]), Reduced::Value(0.1)),
                // A row without a host is its own series, without the host label.
                (labels(&[(FIELD_LABEL, "cpu")]), Reduced::Value(1.0)),
            ]
        );
        assert_eq!(reduction.value_fields, vec!["cpu"]);
        assert_eq!(reduction.label_fields, vec!["host"]);
    }

    #[test]
    fn numeric_id_columns_are_series_and_the_preview_says_so() {
        let result = frame(vec![
            field("host", FieldType::String, vec![json!("a"), json!("b")]),
            field("host_id", FieldType::Number, vec![json!(17), json!(18)]),
            field("load", FieldType::Number, vec![json!(0.5), json!(0.7)]),
        ]);
        let reduction = reduce(&frame_spec(FrameFunction::Last), &result, 100).unwrap();
        assert_eq!(reduction.value_fields, vec!["host_id", "load"]);
        assert_eq!(reduction.label_fields, vec!["host"]);
        let fields: Vec<&str> = reduction.series.iter().map(|s| s.field.as_str()).collect();
        assert_eq!(fields, vec!["host_id", "host_id", "load", "load"]);
    }

    #[test]
    fn identical_labels_are_an_error() {
        let result =
            frame(vec![labelled("a", &[("job", "x")], vec![json!(1)]), labelled("b", &[("job", "x")], vec![json!(2)])]);
        let error = reduce(&frame_spec(FrameFunction::Last), &result, 100).unwrap_err();
        assert_eq!(error, EvalError::DuplicateSeries { labels: "{job=\"x\"}".into() });
    }

    #[test]
    fn more_series_than_the_limit_are_an_error() {
        let hosts: Vec<Value> = (0..101).map(|i| json!(format!("h{i}"))).collect();
        let result = frame(vec![
            field("host", FieldType::String, hosts),
            field("v", FieldType::Number, (0..101).map(|i| json!(i)).collect()),
        ]);
        assert_eq!(
            reduce(&frame_spec(FrameFunction::Last), &result, 100).unwrap_err(),
            EvalError::TooManySeries { limit: 100 }
        );
        assert_eq!(reduce(&frame_spec(FrameFunction::Last), &result, 101).unwrap().series.len(), 101);
        // Two value fields double the series.
        let result = frame(vec![
            field("host", FieldType::String, (0..60).map(|i| json!(format!("h{i}"))).collect()),
            field("v", FieldType::Number, (0..60).map(|i| json!(i)).collect()),
            field("w", FieldType::Number, (0..60).map(|i| json!(i)).collect()),
        ]);
        assert_eq!(
            reduce(&frame_spec(FrameFunction::Last), &result, 100).unwrap_err(),
            EvalError::TooManySeries { limit: 100 }
        );
    }

    #[test]
    fn text_in_a_number_field_is_an_error_never_a_number() {
        let cases = [
            (field("v", FieldType::Number, vec![json!(1), json!("2")]), "text"),
            (field("v", FieldType::Number, vec![json!(true)]), "bool"),
            (field("v", FieldType::Number, vec![json!([1])]), "array"),
            (field("v", FieldType::Number, vec![json!({ "a": 1 })]), "object"),
            (field("v", FieldType::Number, vec![json!({ "$type": "date", "value": "2026-01-01" })]), "date"),
            (field("v", FieldType::Int64, vec![json!("12abc")]), "text"),
            (field("v", FieldType::Decimal, vec![json!(" 1.5")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("1.5 ")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("0x10")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("+-1")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("--1")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("-")]), "text"),
        ];
        for (f, found) in cases {
            let result = frame(vec![f]);
            for function in [FrameFunction::Last, FrameFunction::Count] {
                assert_eq!(
                    reduce(&frame_spec(function), &result, 100).unwrap_err(),
                    EvalError::NotANumber { field: "v".into(), found: found.into() },
                    "{result:?}"
                );
            }
        }
        // One sign is fine.
        let result =
            frame(vec![field("v", FieldType::Decimal, vec![json!("-1.5"), json!("+2"), json!(".5"), json!("1e3")])]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Sum), &result, 100)), Reduced::Value(1001.0));
    }

    #[test]
    fn nan_is_no_value_and_infinities_are_numbers() {
        let result = frame(vec![field(
            "v",
            FieldType::Number,
            vec![json!({ "$type": "float", "value": "NaN" }), json!({ "$type": "double", "value": "Infinity" })],
        )]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Count), &result, 100)), Reduced::Value(1.0));
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Max), &result, 100)), Reduced::Value(f64::INFINITY));
        let result = frame(vec![field("v", FieldType::Decimal, vec![json!("NaN"), json!("-Infinity"), json!("+Inf")])]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Min), &result, 100)), Reduced::Value(f64::NEG_INFINITY));
        // +Infinity and -Infinity sum to NaN: an error, not a silent comparison.
        assert_eq!(
            reduce(&frame_spec(FrameFunction::Sum), &result, 100).unwrap_err(),
            EvalError::NaN { field: "v".into() }
        );
        let result = frame(vec![field("v", FieldType::Decimal, vec![json!("Infinity"), json!("Infinity")])]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Mean), &result, 100)), Reduced::Value(f64::INFINITY));
    }

    #[test]
    fn huge_series_reduce_in_one_pass() {
        let n = 200_000;
        let result = frame(vec![
            field("time", FieldType::Time, (0..n).map(|i| json!(i)).collect()),
            field("v", FieldType::Number, (0..n).map(|i| json!(i % 1000)).collect()),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Count), &result, 100)), Reduced::Value(n as f64));
        assert_eq!(
            one(reduce(&frame_spec(FrameFunction::Last), &result, 100)),
            Reduced::Value(((n - 1) % 1000) as f64)
        );
        match one(reduce(&frame_spec(FrameFunction::Mean), &result, 100)) {
            Reduced::Value(v) => assert!((v - 499.5).abs() < 1e-9, "{v}"),
            other => panic!("{other:?}"),
        }
        let big = frame(vec![field("v", FieldType::Number, vec![json!(f64::MAX), json!(f64::MAX)])]);
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Mean), &big, 100)), Reduced::Value(f64::MAX));
        assert_eq!(one(reduce(&frame_spec(FrameFunction::Sum), &big, 100)), Reduced::Value(f64::INFINITY));
    }

    #[test]
    fn cut_frames_are_marked() {
        let cut = QueryResult::Frame {
            frame: Frame::new(vec![field("v", FieldType::Number, vec![json!(1)])])
                .unwrap()
                .with_meta(FrameMeta { rows_truncated: true, ..FrameMeta::default() }),
        };
        let reduction = reduce(&frame_spec(FrameFunction::Count), &cut, 100).unwrap();
        assert_eq!(
            reduction.truncated,
            Some(EvalError::Truncated { limit: None, reason: Some("rows_truncated".into()) })
        );
        let whole = frame(vec![field("v", FieldType::Number, vec![json!(1)])]);
        assert_eq!(reduce(&frame_spec(FrameFunction::Count), &whole, 100).unwrap().truncated, None);
    }

    fn documents(docs: &[Value]) -> QueryResult {
        QueryResult::Documents {
            documents: DocumentSet {
                documents: docs.iter().cloned().map(OrderedJson::from).collect(),
                ..DocumentSet::default()
            },
        }
    }

    fn doc_count() -> Reduce {
        Reduce::Documents { mode: DocumentMode::Count, path: None, function: None }
    }

    fn doc_field(path: &str, function: DocumentFunction) -> Reduce {
        Reduce::Documents { mode: DocumentMode::Field, path: Some(path.into()), function: Some(function) }
    }

    #[test]
    fn document_count_is_a_value_even_when_zero() {
        assert_eq!(one(reduce(&doc_count(), &documents(&[]), 100)), Reduced::Value(0.0));
        assert_eq!(one(reduce(&doc_count(), &documents(&[json!({}), json!({ "a": "x" })]), 100)), Reduced::Value(2.0));
    }

    #[test]
    fn document_field_functions() {
        let docs = documents(&[
            json!({ "queue": { "depth": 4 } }),
            json!({ "queue": {} }),
            json!({ "queue": { "depth": { "$type": "int64", "value": "10" } } }),
            json!({ "queue": { "depth": null } }),
            json!({ "queue": { "depth": -2.5 } }),
        ]);
        let cases = [
            (DocumentFunction::First, 4.0),
            (DocumentFunction::Min, -2.5),
            (DocumentFunction::Max, 10.0),
            (DocumentFunction::Mean, 11.5 / 3.0),
            (DocumentFunction::Sum, 11.5),
        ];
        for (function, want) in cases {
            let reduction = reduce(&doc_field("$.queue.depth", function), &docs, 100).unwrap();
            assert_eq!(reduction.skipped_documents, 2);
            match reduction.series[0].value {
                Reduced::Value(v) => assert!((v - want).abs() < 1e-12, "{function:?}: {v}"),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn document_paths_reach_into_arrays_and_wrapped_documents() {
        let docs = documents(&[
            json!({ "items": [{ "price": 3 }, { "price": 5 }] }),
            json!({ "o": { "$type": "document", "value": { "n": 7 } } }),
        ]);
        assert_eq!(one(reduce(&doc_field("$.items.1.price", DocumentFunction::Sum), &docs, 100)), Reduced::Value(5.0));
        assert_eq!(one(reduce(&doc_field("$.items[1].price", DocumentFunction::Sum), &docs, 100)), Reduced::Value(5.0));
        assert_eq!(one(reduce(&doc_field("$.items[0].price", DocumentFunction::Sum), &docs, 100)), Reduced::Value(3.0));
        assert_eq!(one(reduce(&doc_field("$.o.n", DocumentFunction::First), &docs, 100)), Reduced::Value(7.0));
        // `[n]` indexes arrays only; a key "0" of an object is reached by `.0`.
        let docs = documents(&[json!({ "m": { "0": 4 } })]);
        assert_eq!(one(reduce(&doc_field("$.m.0", DocumentFunction::First), &docs, 100)), Reduced::Value(4.0));
        assert_eq!(one(reduce(&doc_field("$.m[0]", DocumentFunction::First), &docs, 100)), Reduced::NoValue);
        // A typed value is a leaf, not something to walk into.
        let docs = documents(&[json!({ "id": { "$type": "objectId", "value": "65f0" } })]);
        assert_eq!(one(reduce(&doc_field("$.id.value", DocumentFunction::First), &docs, 100)), Reduced::NoValue);
    }

    #[test]
    fn paths_saving_refuses_are_an_error_here_never_no_value() {
        let docs = documents(&[json!({ "a": { "b": 1 } })]);
        for bad in ["a.b", "$.a.", "$.a..b", "$..a", "$", "$.a[x]"] {
            assert_eq!(
                reduce(&doc_field(bad, DocumentFunction::First), &docs, 100).unwrap_err(),
                EvalError::InvalidRule,
                "{bad}"
            );
        }
        let broken = Reduce::Documents { mode: DocumentMode::Field, path: None, function: Some(DocumentFunction::Max) };
        assert_eq!(reduce(&broken, &docs, 100).unwrap_err(), EvalError::InvalidRule);
    }

    #[test]
    fn a_field_missing_everywhere_has_no_value() {
        let docs = documents(&[json!({ "a": 1 }), json!({ "b": null })]);
        let reduction = reduce(&doc_field("$.c", DocumentFunction::Max), &docs, 100).unwrap();
        assert_eq!(reduction.series[0].value, Reduced::NoValue);
        assert_eq!(reduction.skipped_documents, 2);
        let reduction = reduce(&doc_field("$.c", DocumentFunction::Sum), &documents(&[]), 100).unwrap();
        assert_eq!(reduction.series[0].value, Reduced::NoValue);
    }

    #[test]
    fn document_fields_with_other_types_are_errors() {
        let cases = [
            (json!({ "v": "12" }), "text"),
            (json!({ "v": false }), "bool"),
            (json!({ "v": [1, 2] }), "array"),
            (json!({ "v": { "x": 1 } }), "object"),
            (json!({ "v": { "$type": "date", "value": "2026-11-10" } }), "date"),
            (json!({ "v": { "$type": "decimal", "value": "abc" } }), "decimal"),
        ];
        for (doc, found) in cases {
            // Mixed with good documents, the bad one still fails the evaluation.
            let docs = documents(&[json!({ "v": 1 }), doc.clone()]);
            assert_eq!(
                reduce(&doc_field("$.v", DocumentFunction::First), &docs, 100).unwrap_err(),
                EvalError::NotANumber { field: "$.v".into(), found: found.into() },
                "{doc}"
            );
        }
        // Decimals and doubles with their database type are numbers; NaN is no value.
        let docs = documents(&[
            json!({ "v": { "$type": "decimal", "value": "1.25" } }),
            json!({ "v": { "$type": "double", "value": "NaN" } }),
        ]);
        let reduction = reduce(&doc_field("$.v", DocumentFunction::Sum), &docs, 100).unwrap();
        assert_eq!(reduction.series[0].value, Reduced::Value(1.25));
        assert_eq!(reduction.skipped_documents, 1);
    }

    #[test]
    fn cut_document_sets_are_marked() {
        let cut = |truncated: Option<Truncated>, next_cursor: Option<String>| QueryResult::Documents {
            documents: DocumentSet {
                documents: vec![OrderedJson::from(json!({ "v": 1 }))],
                truncated,
                next_cursor,
                ..DocumentSet::default()
            },
        };
        let by_limit = cut(Some(Truncated { limit: 500, reason: Some("documents.limit".into()) }), None);
        assert_eq!(
            reduce(&doc_count(), &by_limit, 100).unwrap().truncated,
            Some(EvalError::Truncated { limit: Some(500), reason: Some("documents.limit".into()) })
        );
        let by_cursor = cut(None, Some("c".into()));
        assert_eq!(
            reduce(&doc_field("$.v", DocumentFunction::Max), &by_cursor, 100).unwrap().truncated,
            Some(EvalError::Truncated { limit: None, reason: Some("next_cursor".into()) })
        );
        assert_eq!(reduce(&doc_count(), &cut(None, None), 100).unwrap().truncated, None);
    }

    fn graph(paths: Option<Vec<GraphPath>>, truncated: Option<Truncated>) -> QueryResult {
        let node = |id: &str, labels: &[&str]| Node {
            id: id.into(),
            labels: labels.iter().map(|l| l.to_string()).collect(),
            properties: BTreeMap::new(),
        };
        let edge = |id: &str, t: &str| Edge {
            id: id.into(),
            edge_type: t.into(),
            from: "a".into(),
            to: "b".into(),
            properties: BTreeMap::new(),
        };
        QueryResult::Graph {
            graph: GraphSet {
                nodes: vec![node("a", &["Server"]), node("b", &["Server", "Db"]), node("c", &["Client"])],
                edges: vec![edge("e1", "CALLS"), edge("e2", "CALLS"), edge("e3", "READS")],
                paths,
                truncated,
                ..GraphSet::default()
            },
        }
    }

    fn one_path() -> Option<Vec<GraphPath>> {
        Some(vec![GraphPath { nodes: vec!["a".into(), "b".into()], edges: vec!["e1".into()] }])
    }

    #[test]
    fn graph_counts() {
        let cases = [
            (GraphCount::Nodes, None, 3.0),
            (GraphCount::Nodes, Some("Server"), 2.0),
            (GraphCount::Nodes, Some("Nope"), 0.0),
            (GraphCount::Edges, None, 3.0),
            (GraphCount::Edges, Some("CALLS"), 2.0),
            (GraphCount::Paths, None, 1.0),
        ];
        for (count, label, want) in cases {
            let spec = Reduce::Graph { count, label: label.map(String::from) };
            assert_eq!(one(reduce(&spec, &graph(one_path(), None), 100)), Reduced::Value(want), "{count:?} {label:?}");
        }
        // An empty graph counts 0 nodes and edges, and 0 paths when it has an empty path list.
        let empty = |paths| QueryResult::Graph { graph: GraphSet { paths, ..GraphSet::default() } };
        for count in [GraphCount::Nodes, GraphCount::Edges] {
            assert_eq!(one(reduce(&Reduce::Graph { count, label: None }, &empty(None), 100)), Reduced::Value(0.0));
        }
        let paths = Reduce::Graph { count: GraphCount::Paths, label: None };
        assert_eq!(one(reduce(&paths, &empty(Some(vec![])), 100)), Reduced::Value(0.0));
        // No path list at all: the query returned no paths, which is not "zero paths".
        assert_eq!(reduce(&paths, &empty(None), 100).unwrap_err(), EvalError::NoPaths);
        assert_eq!(reduce(&paths, &graph(None, None), 100).unwrap_err(), EvalError::NoPaths);
    }

    #[test]
    fn cut_graphs_are_marked() {
        let cut = graph(one_path(), Some(Truncated { limit: 3, reason: Some("graph.node_limit".into()) }));
        let reduction = reduce(&Reduce::Graph { count: GraphCount::Nodes, label: None }, &cut, 100).unwrap();
        assert_eq!(
            reduction.truncated,
            Some(EvalError::Truncated { limit: Some(3), reason: Some("graph.node_limit".into()) })
        );
    }

    #[test]
    fn a_result_in_another_shape_is_an_error() {
        let graph = graph(None, None);
        let error = reduce(&frame_spec(FrameFunction::Last), &graph, 100).unwrap_err();
        assert_eq!(error, EvalError::WrongShape { expected: "frame".into(), got: "graph".into() });
        let error = reduce(&Reduce::Graph { count: GraphCount::Paths, label: None }, &documents(&[]), 100).unwrap_err();
        assert_eq!(error, EvalError::WrongShape { expected: "graph".into(), got: "documents".into() });
        let error = reduce(&doc_count(), &frame(vec![]), 100).unwrap_err();
        assert_eq!(error, EvalError::WrongShape { expected: "documents".into(), got: "frame".into() });
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// Over any finite values: min <= mean <= max, sum and count agree with a plain fold, and
        /// last is the value of the latest time.
        #[test]
        fn frame_functions_agree_with_plain_folds(
            rows in prop::collection::vec((-1e12f64..1e12, 0i64..1_000), 1..200)
        ) {
            let result = frame(vec![
                field("time", FieldType::Time, rows.iter().map(|(_, t)| json!(t)).collect()),
                field("v", FieldType::Number, rows.iter().map(|(v, _)| json!(v)).collect()),
            ]);
            let get = |f| match one(reduce(&frame_spec(f), &result, 100)) {
                Reduced::Value(v) => v,
                Reduced::NoValue => panic!("no value"),
            };
            let (min, max, mean) = (get(FrameFunction::Min), get(FrameFunction::Max), get(FrameFunction::Mean));
            let tolerance = 1e-6 * max.abs().max(min.abs()).max(1.0);
            prop_assert!(min - tolerance <= mean && mean <= max + tolerance);
            prop_assert_eq!(get(FrameFunction::Count), rows.len() as f64);
            prop_assert_eq!(min, rows.iter().map(|r| r.0).fold(f64::INFINITY, f64::min));
            prop_assert_eq!(max, rows.iter().map(|r| r.0).fold(f64::NEG_INFINITY, f64::max));
            let sum: f64 = rows.iter().map(|r| r.0).sum();
            prop_assert!((get(FrameFunction::Sum) - sum).abs() <= 1e-6 * sum.abs().max(1.0));
            let latest = rows.iter().map(|r| r.1).max().unwrap();
            let last = rows.iter().rev().find(|r| r.1 == latest).unwrap().0;
            prop_assert_eq!(get(FrameFunction::Last), last);
        }

        /// Any JSON in a number field either reduces or fails cleanly; it never panics and never
        /// turns text into a number.
        #[test]
        fn arbitrary_values_never_panic(values in prop::collection::vec(prop_oneof![
            Just(json!(null)),
            any::<bool>().prop_map(|b| json!(b)),
            any::<i64>().prop_map(|n| json!(n)),
            "\\PC{0,8}".prop_map(|s| json!(s)),
        ], 0..30)) {
            let has_text = values.iter().any(|v| v.is_string() || v.is_boolean());
            let result = frame(vec![field("v", FieldType::Number, values)]);
            let reduced = reduce(&frame_spec(FrameFunction::Sum), &result, 100);
            prop_assert_eq!(reduced.is_err(), has_text);
        }

        /// Decimal text either parses as Rust's float parser does, or is refused; it never panics.
        #[test]
        fn decimal_text_never_panics(text in "[-+ .0-9eEaInfity]{0,8}") {
            if let Some(v) = parse_decimal(&text) {
                prop_assert_eq!(Some(v.to_bits()), text.parse::<f64>().ok().map(f64::to_bits));
            }
        }
    }
}
