//! The reduce step: a result in its native shape to one number per instance. Frames give one
//! instance per series, documents and graphs one per rule. Nothing is converted between shapes,
//! and a value where a number is expected is never read as one when it is text.

use std::collections::HashMap;

use serde_json::Value;

use super::{DocumentsReduce, EvalError, FieldReducer, FrameReducer, GraphCount, Labels, ReduceSpec};
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
    pub value: Reduced,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reduction {
    /// One entry per instance, in result order. Empty for a frame without a single series.
    pub series: Vec<SeriesValue>,
    /// Documents that did not count because the field is missing or empty (named in the preview).
    pub skipped_documents: usize,
}

/// Reduces `result` as `spec` says. More than `max_instances` series is an error, as is a
/// result in another shape than the spec's.
pub fn reduce(spec: &ReduceSpec, result: &QueryResult, max_instances: usize) -> Result<Reduction, EvalError> {
    match (spec, result) {
        (ReduceSpec::Frame { reducer }, QueryResult::Frame { frame }) => reduce_frame(*reducer, frame, max_instances),
        (ReduceSpec::Documents { of }, QueryResult::Documents { documents }) => reduce_documents(of, documents),
        (ReduceSpec::Graph { count }, QueryResult::Graph { graph }) => Ok(Reduction {
            series: vec![SeriesValue { labels: Labels::new(), value: Reduced::Value(count_graph(count, graph)) }],
            skipped_documents: 0,
        }),
        (spec, result) => Err(EvalError::WrongShape {
            expected: shape_name(match spec {
                ReduceSpec::Frame { .. } => Shape::Frame,
                ReduceSpec::Documents { .. } => Shape::Documents,
                ReduceSpec::Graph { .. } => Shape::Graph,
            })
            .into(),
            got: shape_name(result.shape()).into(),
        }),
    }
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

    fn frame(&self, reducer: FrameReducer) -> Reduced {
        if reducer == FrameReducer::Count {
            return Reduced::Value(self.count as f64);
        }
        if self.count == 0 {
            return Reduced::NoValue;
        }
        Reduced::Value(match reducer {
            FrameReducer::Last => self.last.map_or(f64::NAN, |(_, v)| v),
            FrameReducer::Min => self.min,
            FrameReducer::Max => self.max,
            FrameReducer::Mean => self.mean(),
            FrameReducer::Sum => self.sum,
            FrameReducer::Count => unreachable!("handled above"),
        })
    }

    fn field(&self, reducer: FieldReducer) -> Reduced {
        if self.count == 0 {
            return Reduced::NoValue;
        }
        Reduced::Value(match reducer {
            FieldReducer::First => self.first.unwrap_or(f64::NAN),
            FieldReducer::Min => self.min,
            FieldReducer::Max => self.max,
            FieldReducer::Mean => self.mean(),
            FieldReducer::Sum => self.sum,
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

/// What a JSON value is, for the error text.
fn kind(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(_) => "a bool".into(),
        Value::Number(_) => "a number".into(),
        Value::String(_) => "text".into(),
        Value::Array(_) => "an array".into(),
        Value::Object(_) => match typed(value) {
            Some((t, _)) => format!("a value of type {t}"),
            None => "an object".into(),
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

/// A decimal number as databases write it: digits, sign, exponent, `NaN`, `Infinity` (`inf`,
/// `+Inf`). Not hex, not empty, no surrounding spaces.
fn parse_decimal(text: &str) -> Option<f64> {
    let t = text.strip_prefix('+').unwrap_or(text);
    if t.is_empty() || t.starts_with(['+', ' ']) || t.ends_with(' ') {
        return None;
    }
    t.parse::<f64>().ok()
}

/// A time value in Unix milliseconds; anything else counts as no time.
fn time(value: &Value) -> Option<f64> {
    value.as_f64().filter(|t| t.is_finite())
}

fn reduce_frame(reducer: FrameReducer, frame: &Frame, max_instances: usize) -> Result<Reduction, EvalError> {
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

    let rows = frame.rows();
    if values.is_empty() || rows == 0 {
        return Ok(Reduction::default());
    }

    // Rows per label combination, in order of first appearance.
    let mut groups: Vec<(Labels, Vec<usize>)> = Vec::new();
    if label_fields.is_empty() {
        groups.push((Labels::new(), (0..rows).collect()));
    } else {
        let mut index: HashMap<Vec<Option<&str>>, usize> = HashMap::new();
        for row in 0..rows {
            let key: Vec<Option<&str>> = label_fields.iter().map(|&f| fields[f].values[row].as_str()).collect();
            let at = *index.entry(key).or_insert_with_key(|key| {
                let labels = label_fields
                    .iter()
                    .zip(key)
                    .filter_map(|(&f, v)| v.map(|v| (fields[f].name.clone(), v.to_string())))
                    .collect();
                groups.push((labels, Vec::new()));
                groups.len() - 1
            });
            groups[at].1.push(row);
        }
    }

    let count = groups.len().saturating_mul(values.len());
    if count > max_instances {
        return Err(EvalError::TooManySeries { limit: max_instances });
    }

    let mut series = Vec::with_capacity(count);
    let mut seen = std::collections::HashSet::with_capacity(count);
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
            series.push(SeriesValue { labels, value: checked(acc.frame(reducer), &field.name)? });
        }
    }
    Ok(Reduction { series, skipped_documents: 0 })
}

/// `{a="1", b="2"}`, for texts.
pub fn label_text(labels: &Labels) -> String {
    let inner: Vec<String> = labels.iter().map(|(k, v)| format!("{k}={v:?}")).collect();
    format!("{{{}}}", inner.join(", "))
}

/// The parts of a document path: `$.queue.depth` and `queue.depth` are both `queue`, `depth`.
pub(super) fn path_parts(path: &str) -> Vec<&str> {
    let rest = path.strip_prefix('$').map_or(path, |r| r.strip_prefix('.').unwrap_or(r));
    if rest.is_empty() { Vec::new() } else { rest.split('.').collect() }
}

/// The value at a path; `None` when it is missing. Array elements by index, and the wrapper of
/// a document that has its own `$type` key is looked through.
fn value_at<'a>(document: &'a Value, parts: &[&str]) -> Option<&'a Value> {
    let mut current = document;
    for part in parts {
        if let Some(map) = current.as_object()
            && map.len() == 2
            && map.get("$type").and_then(Value::as_str) == Some("document")
            && let Some(inner @ Value::Object(_)) = map.get("value")
        {
            current = inner;
        }
        current = match current {
            Value::Array(items) if !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()) => {
                items.get(part.parse::<usize>().ok()?)?
            }
            Value::Object(_) if typed(current).is_none() => current.get(*part)?,
            _ => return None,
        };
    }
    Some(current)
}

fn reduce_documents(of: &DocumentsReduce, set: &DocumentSet) -> Result<Reduction, EvalError> {
    let (path, reducer) = match of {
        DocumentsReduce::Count => {
            // Zero documents is a value, not missing data.
            return Ok(Reduction {
                series: vec![SeriesValue { labels: Labels::new(), value: Reduced::Value(set.documents.len() as f64) }],
                skipped_documents: 0,
            });
        }
        DocumentsReduce::Field { path, reducer } => (path, *reducer),
    };
    let parts = path_parts(path);
    let mut acc = Acc::default();
    let mut skipped = 0;
    for document in &set.documents {
        let document: Value = serde_json::from_str(document.get())
            .map_err(|e| EvalError::QueryFailed { message: format!("unreadable document: {e}") })?;
        match value_at(&document, &parts) {
            Some(value) => match number(value, false, path)? {
                Some(v) => acc.push(v, None),
                None => skipped += 1,
            },
            None => skipped += 1,
        }
    }
    let value = checked(acc.field(reducer), path)?;
    // A field missing in every document is no data: no instance value, so the caller decides.
    Ok(Reduction { series: vec![SeriesValue { labels: Labels::new(), value }], skipped_documents: skipped })
}

fn count_graph(count: &GraphCount, graph: &GraphSet) -> f64 {
    (match count {
        GraphCount::Nodes { label: None } => graph.nodes.len(),
        GraphCount::Nodes { label: Some(label) } => graph.nodes.iter().filter(|n| n.labels.contains(label)).count(),
        GraphCount::Edges { edge_type: None } => graph.edges.len(),
        GraphCount::Edges { edge_type: Some(t) } => graph.edges.iter().filter(|e| &e.edge_type == t).count(),
        GraphCount::Paths => graph.paths.as_ref().map_or(0, Vec::len),
    }) as f64
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use proptest::prelude::*;
    use serde_json::json;

    use super::*;
    use crate::shapes::{Edge, Field, GraphPath, Node, OrderedJson};

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

    fn frame_spec(reducer: FrameReducer) -> ReduceSpec {
        ReduceSpec::Frame { reducer }
    }

    fn one(result: Result<Reduction, EvalError>) -> Reduced {
        let reduction = result.unwrap();
        assert_eq!(reduction.series.len(), 1, "{reduction:?}");
        reduction.series[0].value
    }

    #[test]
    fn frame_reducers_on_one_series() {
        let result = frame(vec![
            field("time", FieldType::Time, vec![json!(3000), json!(1000), json!(2000), json!(4000)]),
            field("v", FieldType::Number, vec![json!(5), json!(-1), json!(null), json!(2.5)]),
        ]);
        let cases = [
            (FrameReducer::Last, 2.5),
            (FrameReducer::Min, -1.0),
            (FrameReducer::Max, 5.0),
            (FrameReducer::Mean, 6.5 / 3.0),
            (FrameReducer::Sum, 6.5),
            (FrameReducer::Count, 3.0),
        ];
        for (reducer, want) in cases {
            match one(reduce(&frame_spec(reducer), &result, 100)) {
                Reduced::Value(v) => assert!((v - want).abs() < 1e-12, "{reducer:?}: {v} != {want}"),
                other => panic!("{reducer:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn last_takes_the_latest_time_not_the_last_row() {
        let result = frame(vec![
            field("v", FieldType::Number, vec![json!(1), json!(2), json!(3)]),
            field("time", FieldType::Time, vec![json!(300), json!(100), json!(200)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Last), &result, 100)), Reduced::Value(1.0));
        // The latest time with a value: the null at the latest time does not count.
        let result = frame(vec![
            field("v", FieldType::Number, vec![json!(1), json!(null)]),
            field("time", FieldType::Time, vec![json!(100), json!(200)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Last), &result, 100)), Reduced::Value(1.0));
        // Same time twice: the later row.
        let result = frame(vec![
            field("v", FieldType::Number, vec![json!(1), json!(2)]),
            field("time", FieldType::Time, vec![json!(100), json!(100)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Last), &result, 100)), Reduced::Value(2.0));
        // Without a time field, the last row; a Date field counts as time.
        let result = frame(vec![field("v", FieldType::Number, vec![json!(7), json!(8), json!(9)])]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Last), &result, 100)), Reduced::Value(9.0));
        let result = frame(vec![
            field("day", FieldType::Date, vec![json!(86_400_000), json!(0)]),
            field("v", FieldType::Number, vec![json!(7), json!(8)]),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Last), &result, 100)), Reduced::Value(7.0));
    }

    #[test]
    fn a_series_with_only_empty_values_has_no_value_but_a_count() {
        let result = frame(vec![field("v", FieldType::Number, vec![json!(null), json!(null)])]);
        for reducer in [FrameReducer::Last, FrameReducer::Min, FrameReducer::Max, FrameReducer::Mean, FrameReducer::Sum]
        {
            assert_eq!(one(reduce(&frame_spec(reducer), &result, 100)), Reduced::NoValue, "{reducer:?}");
        }
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Count), &result, 100)), Reduced::Value(0.0));
    }

    #[test]
    fn frames_without_series_reduce_to_nothing() {
        let empty_rows =
            frame(vec![field("time", FieldType::Time, vec![]), labelled("value", &[("job", "api")], vec![])]);
        let only_text = frame(vec![field("name", FieldType::String, vec![json!("a")])]);
        let no_fields = frame(vec![]);
        for result in [empty_rows, only_text, no_fields] {
            let reduction = reduce(&frame_spec(FrameReducer::Count), &result, 100).unwrap();
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
        let reduction = reduce(&frame_spec(FrameReducer::Max), &result, 100).unwrap();
        assert_eq!(
            reduction.series,
            vec![
                SeriesValue { labels: labels(&[("instance", "a"), ("job", "api")]), value: Reduced::Value(2.0) },
                SeriesValue { labels: labels(&[("instance", "b"), ("job", "api")]), value: Reduced::Value(20.0) },
            ]
        );
    }

    #[test]
    fn columns_without_labels_are_named_by_a_field_label() {
        let result = frame(vec![
            field("errors", FieldType::Number, vec![json!(1), json!(2)]),
            field("requests", FieldType::Int64, vec![json!("10"), json!("9007199254740992")]),
        ]);
        let reduction = reduce(&frame_spec(FrameReducer::Sum), &result, 100).unwrap();
        assert_eq!(reduction.series[0].labels, labels(&[(FIELD_LABEL, "errors")]));
        assert_eq!(reduction.series[0].value, Reduced::Value(3.0));
        assert_eq!(reduction.series[1].labels, labels(&[(FIELD_LABEL, "requests")]));
        assert_eq!(reduction.series[1].value, Reduced::Value(9_007_199_254_741_002.0));
    }

    #[test]
    fn long_tables_give_one_series_per_label_combination() {
        let result = frame(vec![
            field("time", FieldType::Time, vec![json!(1), json!(1), json!(2), json!(2), json!(3)]),
            field("host", FieldType::String, vec![json!("a"), json!("b"), json!("a"), json!("b"), json!(null)]),
            field("cpu", FieldType::Decimal, vec![json!("0.5"), json!("0.7"), json!("0.9"), json!("0.1"), json!("1")]),
            field("up", FieldType::Bool, vec![json!(true), json!(true), json!(true), json!(true), json!(false)]),
        ]);
        let reduction = reduce(&frame_spec(FrameReducer::Last), &result, 100).unwrap();
        assert_eq!(
            reduction.series,
            vec![
                SeriesValue { labels: labels(&[("host", "a"), (FIELD_LABEL, "cpu")]), value: Reduced::Value(0.9) },
                SeriesValue { labels: labels(&[("host", "b"), (FIELD_LABEL, "cpu")]), value: Reduced::Value(0.1) },
                // A row without a host is its own series, without the host label.
                SeriesValue { labels: labels(&[(FIELD_LABEL, "cpu")]), value: Reduced::Value(1.0) },
            ]
        );
    }

    #[test]
    fn identical_labels_are_an_error() {
        let result =
            frame(vec![labelled("a", &[("job", "x")], vec![json!(1)]), labelled("b", &[("job", "x")], vec![json!(2)])]);
        let error = reduce(&frame_spec(FrameReducer::Last), &result, 100).unwrap_err();
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
            reduce(&frame_spec(FrameReducer::Last), &result, 100).unwrap_err(),
            EvalError::TooManySeries { limit: 100 }
        );
        assert_eq!(reduce(&frame_spec(FrameReducer::Last), &result, 101).unwrap().series.len(), 101);
    }

    #[test]
    fn text_in_a_number_field_is_an_error_never_a_number() {
        let cases = [
            (field("v", FieldType::Number, vec![json!(1), json!("2")]), "text"),
            (field("v", FieldType::Number, vec![json!(true)]), "a bool"),
            (field("v", FieldType::Number, vec![json!([1])]), "an array"),
            (field("v", FieldType::Number, vec![json!({ "a": 1 })]), "an object"),
            (
                field("v", FieldType::Number, vec![json!({ "$type": "date", "value": "2026-01-01" })]),
                "a value of type date",
            ),
            (field("v", FieldType::Int64, vec![json!("12abc")]), "text"),
            (field("v", FieldType::Decimal, vec![json!(" 1.5")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("")]), "text"),
            (field("v", FieldType::Decimal, vec![json!("0x10")]), "text"),
        ];
        for (f, found) in cases {
            let result = frame(vec![f]);
            for reducer in [FrameReducer::Last, FrameReducer::Count] {
                assert_eq!(
                    reduce(&frame_spec(reducer), &result, 100).unwrap_err(),
                    EvalError::NotANumber { field: "v".into(), found: found.into() },
                    "{result:?}"
                );
            }
        }
    }

    #[test]
    fn nan_is_no_value_and_infinities_are_numbers() {
        let result = frame(vec![field(
            "v",
            FieldType::Number,
            vec![json!({ "$type": "float", "value": "NaN" }), json!({ "$type": "double", "value": "Infinity" })],
        )]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Count), &result, 100)), Reduced::Value(1.0));
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Max), &result, 100)), Reduced::Value(f64::INFINITY));
        let result = frame(vec![field("v", FieldType::Decimal, vec![json!("NaN"), json!("-Infinity"), json!("+Inf")])]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Min), &result, 100)), Reduced::Value(f64::NEG_INFINITY));
        // +Infinity and -Infinity sum to NaN: an error, not a silent comparison.
        assert_eq!(
            reduce(&frame_spec(FrameReducer::Sum), &result, 100).unwrap_err(),
            EvalError::NaN { field: "v".into() }
        );
        let result = frame(vec![field("v", FieldType::Decimal, vec![json!("Infinity"), json!("Infinity")])]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Mean), &result, 100)), Reduced::Value(f64::INFINITY));
    }

    #[test]
    fn huge_series_reduce_in_one_pass() {
        let n = 200_000;
        let result = frame(vec![
            field("time", FieldType::Time, (0..n).map(|i| json!(i)).collect()),
            field("v", FieldType::Number, (0..n).map(|i| json!(i % 1000)).collect()),
        ]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Count), &result, 100)), Reduced::Value(n as f64));
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Last), &result, 100)), Reduced::Value(((n - 1) % 1000) as f64));
        match one(reduce(&frame_spec(FrameReducer::Mean), &result, 100)) {
            Reduced::Value(v) => assert!((v - 499.5).abs() < 1e-9, "{v}"),
            other => panic!("{other:?}"),
        }
        let big = frame(vec![field("v", FieldType::Number, vec![json!(f64::MAX), json!(f64::MAX)])]);
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Mean), &big, 100)), Reduced::Value(f64::MAX));
        assert_eq!(one(reduce(&frame_spec(FrameReducer::Sum), &big, 100)), Reduced::Value(f64::INFINITY));
    }

    fn documents(docs: &[Value]) -> QueryResult {
        QueryResult::Documents {
            documents: DocumentSet {
                documents: docs.iter().cloned().map(OrderedJson::from).collect(),
                ..DocumentSet::default()
            },
        }
    }

    fn doc_field(path: &str, reducer: FieldReducer) -> ReduceSpec {
        ReduceSpec::Documents { of: DocumentsReduce::Field { path: path.into(), reducer } }
    }

    #[test]
    fn document_count_is_a_value_even_when_zero() {
        let count = ReduceSpec::Documents { of: DocumentsReduce::Count };
        assert_eq!(one(reduce(&count, &documents(&[]), 100)), Reduced::Value(0.0));
        assert_eq!(one(reduce(&count, &documents(&[json!({}), json!({ "a": "x" })]), 100)), Reduced::Value(2.0));
    }

    #[test]
    fn document_field_reducers() {
        let docs = documents(&[
            json!({ "queue": { "depth": 4 } }),
            json!({ "queue": {} }),
            json!({ "queue": { "depth": { "$type": "int64", "value": "10" } } }),
            json!({ "queue": { "depth": null } }),
            json!({ "queue": { "depth": -2.5 } }),
        ]);
        let cases = [
            (FieldReducer::First, 4.0),
            (FieldReducer::Min, -2.5),
            (FieldReducer::Max, 10.0),
            (FieldReducer::Mean, 11.5 / 3.0),
            (FieldReducer::Sum, 11.5),
        ];
        for (reducer, want) in cases {
            for path in ["$.queue.depth", "queue.depth"] {
                let reduction = reduce(&doc_field(path, reducer), &docs, 100).unwrap();
                assert_eq!(reduction.skipped_documents, 2);
                match reduction.series[0].value {
                    Reduced::Value(v) => assert!((v - want).abs() < 1e-12, "{reducer:?}: {v}"),
                    other => panic!("{other:?}"),
                }
            }
        }
    }

    #[test]
    fn document_paths_reach_into_arrays_and_wrapped_documents() {
        let docs = documents(&[
            json!({ "items": [{ "price": 3 }, { "price": 5 }] }),
            json!({ "o": { "$type": "document", "value": { "n": 7 } } }),
        ]);
        assert_eq!(one(reduce(&doc_field("$.items.1.price", FieldReducer::Sum), &docs, 100)), Reduced::Value(5.0));
        assert_eq!(one(reduce(&doc_field("$.o.n", FieldReducer::First), &docs, 100)), Reduced::Value(7.0));
        // A typed value is a leaf, not something to walk into.
        let docs = documents(&[json!({ "id": { "$type": "objectId", "value": "65f0" } })]);
        assert_eq!(one(reduce(&doc_field("$.id.value", FieldReducer::First), &docs, 100)), Reduced::NoValue);
    }

    #[test]
    fn a_field_missing_everywhere_has_no_value() {
        let docs = documents(&[json!({ "a": 1 }), json!({ "b": null })]);
        let reduction = reduce(&doc_field("$.c", FieldReducer::Max), &docs, 100).unwrap();
        assert_eq!(reduction.series[0].value, Reduced::NoValue);
        assert_eq!(reduction.skipped_documents, 2);
        let reduction = reduce(&doc_field("$.c", FieldReducer::Sum), &documents(&[]), 100).unwrap();
        assert_eq!(reduction.series[0].value, Reduced::NoValue);
    }

    #[test]
    fn document_fields_with_other_types_are_errors() {
        let cases = [
            (json!({ "v": "12" }), "text"),
            (json!({ "v": false }), "a bool"),
            (json!({ "v": [1, 2] }), "an array"),
            (json!({ "v": { "x": 1 } }), "an object"),
            (json!({ "v": { "$type": "date", "value": "2026-11-10" } }), "a value of type date"),
            (json!({ "v": { "$type": "decimal", "value": "abc" } }), "a value of type decimal"),
        ];
        for (doc, found) in cases {
            // Mixed with good documents, the bad one still fails the evaluation.
            let docs = documents(&[json!({ "v": 1 }), doc.clone()]);
            assert_eq!(
                reduce(&doc_field("$.v", FieldReducer::First), &docs, 100).unwrap_err(),
                EvalError::NotANumber { field: "$.v".into(), found: found.into() },
                "{doc}"
            );
        }
        // Decimals and doubles with their database type are numbers; NaN is no value.
        let docs = documents(&[
            json!({ "v": { "$type": "decimal", "value": "1.25" } }),
            json!({ "v": { "$type": "double", "value": "NaN" } }),
        ]);
        let reduction = reduce(&doc_field("$.v", FieldReducer::Sum), &docs, 100).unwrap();
        assert_eq!(reduction.series[0].value, Reduced::Value(1.25));
        assert_eq!(reduction.skipped_documents, 1);
    }

    fn graph() -> QueryResult {
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
                paths: Some(vec![GraphPath { nodes: vec!["a".into(), "b".into()], edges: vec!["e1".into()] }]),
                ..GraphSet::default()
            },
        }
    }

    #[test]
    fn graph_counts() {
        let cases = [
            (GraphCount::Nodes { label: None }, 3.0),
            (GraphCount::Nodes { label: Some("Server".into()) }, 2.0),
            (GraphCount::Nodes { label: Some("Nope".into()) }, 0.0),
            (GraphCount::Edges { edge_type: None }, 3.0),
            (GraphCount::Edges { edge_type: Some("CALLS".into()) }, 2.0),
            (GraphCount::Paths, 1.0),
        ];
        for (count, want) in cases {
            let spec = ReduceSpec::Graph { count: count.clone() };
            assert_eq!(one(reduce(&spec, &graph(), 100)), Reduced::Value(want), "{count:?}");
        }
        // An empty graph and a graph without paths count 0: a value, not missing data.
        let empty = QueryResult::Graph { graph: GraphSet::default() };
        for count in [GraphCount::Nodes { label: None }, GraphCount::Edges { edge_type: None }, GraphCount::Paths] {
            assert_eq!(one(reduce(&ReduceSpec::Graph { count }, &empty, 100)), Reduced::Value(0.0));
        }
    }

    #[test]
    fn a_result_in_another_shape_is_an_error() {
        let error = reduce(&frame_spec(FrameReducer::Last), &graph(), 100).unwrap_err();
        assert_eq!(error, EvalError::WrongShape { expected: "frame".into(), got: "graph".into() });
        let error = reduce(&ReduceSpec::Graph { count: GraphCount::Paths }, &documents(&[]), 100).unwrap_err();
        assert_eq!(error, EvalError::WrongShape { expected: "graph".into(), got: "documents".into() });
        let error = reduce(&ReduceSpec::Documents { of: DocumentsReduce::Count }, &frame(vec![]), 100).unwrap_err();
        assert_eq!(error, EvalError::WrongShape { expected: "documents".into(), got: "frame".into() });
    }

    proptest! {
        #![proptest_config(ProptestConfig::default())]

        /// Over any finite values: min <= mean <= max, sum and count agree with a plain fold, and
        /// last is the value of the latest time.
        #[test]
        fn frame_reducers_agree_with_plain_folds(
            rows in prop::collection::vec((-1e12f64..1e12, 0i64..1_000), 1..200)
        ) {
            let result = frame(vec![
                field("time", FieldType::Time, rows.iter().map(|(_, t)| json!(t)).collect()),
                field("v", FieldType::Number, rows.iter().map(|(v, _)| json!(v)).collect()),
            ]);
            let get = |r| match one(reduce(&frame_spec(r), &result, 100)) {
                Reduced::Value(v) => v,
                Reduced::NoValue => panic!("no value"),
            };
            let (min, max, mean) = (get(FrameReducer::Min), get(FrameReducer::Max), get(FrameReducer::Mean));
            let tolerance = 1e-6 * max.abs().max(min.abs()).max(1.0);
            prop_assert!(min - tolerance <= mean && mean <= max + tolerance);
            prop_assert_eq!(get(FrameReducer::Count), rows.len() as f64);
            prop_assert_eq!(min, rows.iter().map(|r| r.0).fold(f64::INFINITY, f64::min));
            prop_assert_eq!(max, rows.iter().map(|r| r.0).fold(f64::NEG_INFINITY, f64::max));
            let sum: f64 = rows.iter().map(|r| r.0).sum();
            prop_assert!((get(FrameReducer::Sum) - sum).abs() <= 1e-6 * sum.abs().max(1.0));
            let latest = rows.iter().map(|r| r.1).max().unwrap();
            let last = rows.iter().rev().find(|r| r.1 == latest).unwrap().0;
            prop_assert_eq!(get(FrameReducer::Last), last);
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
            let reduced = reduce(&frame_spec(FrameReducer::Sum), &result, 100);
            prop_assert_eq!(reduced.is_err(), has_text);
        }
    }
}
