//! Running analysis steps on the frames of one request. Each step reads frames by the reference
//! id of their query and writes its result back under that id; a disabled step is passed over.
//! The UI runs the same steps in `ui/src/analysis/steps.ts`.

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use serde_json::Value;

use super::expr::{self, DAY_MS, number_text};
use super::stats;
use super::{Agg, Aggregation, CompareOutput, JoinMode, JoinOn, Period, Stat, Step, StepKind, TrendOutput};
use crate::datasources::detail::Detail;
use crate::shapes::{DocumentSet, Field, FieldType, Frame, FrameMeta, GraphSet, QueryResult};

/// Rows a join may produce; many-to-many keys could otherwise multiply the result.
pub const MAX_ROWS: usize = 500_000;
/// Fields a pivot may produce.
pub const MAX_COLUMNS: usize = 500;
/// Cells (rows times fields) one step may produce, checked before it builds them.
pub const MAX_CELLS: usize = 5_000_000;
/// Text (UTF-16 units) the steps of one run may make: calculated text and the copies a join makes.
pub const MAX_RUN_TEXT_UNITS: usize = 64 * 1024 * 1024;
/// Rows between two looks at the cancel flag and the deadline.
const CHECK_EVERY: usize = 4096;

/// The bounds and stop signals of one run, and the calendar its calculated fields read times in.
/// The UI's engine has the same budget; the server adds a cancel flag (the client went away) and
/// a deadline (the query timeout).
pub struct Control {
    cancelled: Option<Arc<AtomicBool>>,
    deadline: Option<(Instant, u64)>,
    text_left: Cell<usize>,
    max_cells: usize,
    calendar: expr::Calendar,
}

impl Default for Control {
    fn default() -> Self {
        Self::unbounded()
    }
}

impl Control {
    /// No cancel flag and no deadline, only the budget.
    pub fn unbounded() -> Self {
        Self {
            cancelled: None,
            deadline: None,
            text_left: Cell::new(MAX_RUN_TEXT_UNITS),
            max_cells: MAX_CELLS,
            calendar: expr::Calendar::default(),
        }
    }

    /// The same bounds, with calculated fields reading times in `calendar`.
    pub fn with_calendar(self, calendar: expr::Calendar) -> Self {
        Self { calendar, ..self }
    }

    /// Stops when `cancelled` is set or `timeout_secs` have passed.
    pub fn new(cancelled: Arc<AtomicBool>, timeout_secs: u64) -> Self {
        let deadline = Instant::now() + std::time::Duration::from_secs(timeout_secs);
        Self {
            cancelled: Some(cancelled),
            deadline: Some((deadline, timeout_secs)),
            text_left: Cell::new(MAX_RUN_TEXT_UNITS),
            max_cells: MAX_CELLS,
            calendar: expr::Calendar::default(),
        }
    }

    /// Fails when the run should stop.
    pub fn check(&self) -> Result<(), Detail> {
        if self.cancelled.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(detail("steps.cancelled", "the request was cancelled".into()));
        }
        if let Some((deadline, secs)) = self.deadline
            && Instant::now() >= deadline
        {
            return Err(detail("steps.timeout", format!("the steps took longer than {secs} s")).with("seconds", secs));
        }
        Ok(())
    }

    /// Fails only when the cancel flag is set: for a file being sent to a client, whose pace the
    /// deadline of the queries and steps does not apply to.
    pub fn check_cancelled(&self) -> Result<(), Detail> {
        if self.cancelled.as_ref().is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Err(detail("steps.cancelled", "the request was cancelled".into()));
        }
        Ok(())
    }

    /// `check`, every `CHECK_EVERY` rows.
    pub fn every(&self, row: usize) -> Result<(), Detail> {
        if row.is_multiple_of(CHECK_EVERY) { self.check() } else { Ok(()) }
    }

    fn spend_text(&self, units: usize) -> Result<(), Detail> {
        let left = self.text_left.get();
        if units > left {
            return Err(detail(
                "steps.too_much_text",
                format!("the steps would make more than {MAX_RUN_TEXT_UNITS} characters of text"),
            )
            .with("max", MAX_RUN_TEXT_UNITS));
        }
        self.text_left.set(left - units);
        Ok(())
    }
}

impl Control {
    /// Refuses a result of `rows` times `fields` cells above the limit (`MAX_CELLS`), before it
    /// is built.
    pub(super) fn cells(&self, rows: usize, fields: usize) -> Result<(), Detail> {
        let max = self.max_cells;
        if rows.saturating_mul(fields) > max {
            return Err(
                detail("steps.too_many_cells", format!("the step would make more than {max} cells")).with("max", max)
            );
        }
        Ok(())
    }
}

/// The text (UTF-16 units) of one cell, for the budget.
fn text_units(v: &Value) -> usize {
    match v {
        Value::String(s) => expr::utf16_len(s),
        _ => 0,
    }
}

/// A frame with the reference id of the query it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct NamedFrame {
    pub name: String,
    pub frame: Frame,
}

/// The step that failed (counted from 0) and why.
#[derive(Clone, Debug, PartialEq)]
pub struct StepFailure {
    pub index: usize,
    pub detail: Detail,
}

/// A query's result as steps see it: a frame, documents a projection may turn into one, or a
/// graph the graph steps read.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    Frame(Frame),
    Documents(DocumentSet),
    Graph(GraphSet),
}

/// Runs the enabled steps in order; the first failure stops the run.
pub fn run(steps: &[Step], frames: Vec<NamedFrame>) -> Result<Vec<NamedFrame>, StepFailure> {
    let inputs = frames.into_iter().map(|f| (f.name, Input::Frame(f.frame))).collect();
    run_inputs(steps, inputs, &Control::unbounded())
}

/// `run` over results of any shape the steps read. Steps run in order; a projection (`toFrame`)
/// turns the documents of its query into a frame at the place of that query, and the steps after
/// it work on that frame. Documents are no frame for any other step. Graph steps read the graph
/// of their query; one that makes a frame puts it at the place of that query too. Graphs left at
/// the end are not among the frames.
pub fn run_inputs(
    steps: &[Step],
    inputs: Vec<(String, Input)>,
    control: &Control,
) -> Result<Vec<NamedFrame>, StepFailure> {
    run_shapes(steps, inputs, control, &BTreeSet::new()).map(|(frames, _)| frames)
}

/// The frames, and the graphs no step made a frame of, by reference id.
pub type Shapes = (Vec<NamedFrame>, Vec<(String, GraphSet)>);

/// The frames and the graphs after the steps; steps whose id is in `done` already ran where the
/// query ran (`datasources::run_queries`), and their results are among the inputs.
pub fn run_shapes(
    steps: &[Step],
    inputs: Vec<(String, Input)>,
    control: &Control,
    done: &BTreeSet<String>,
) -> Result<Shapes, StepFailure> {
    let order: Vec<String> = inputs.iter().map(|(name, _)| name.clone()).collect();
    let mut documents: Vec<(String, DocumentSet)> = Vec::new();
    let mut graphs: Vec<(String, GraphSet)> = Vec::new();
    let mut frames: Vec<NamedFrame> = Vec::new();
    for (name, input) in inputs {
        match input {
            Input::Frame(frame) => frames.push(NamedFrame { name, frame }),
            Input::Documents(set) => documents.push((name, set)),
            Input::Graph(graph) => graphs.push((name, graph)),
        }
    }
    // In the place of its query among the frames, so the order stays the queries' order.
    let insert = |frames: &mut Vec<NamedFrame>, name: String, frame: Frame| {
        let rank = |n: &str| order.iter().position(|o| o == n).unwrap_or(usize::MAX);
        let place = frames.iter().take_while(|f| rank(&f.name) < rank(&name)).count();
        frames.insert(place, NamedFrame { name, frame });
    };
    for (index, step) in steps.iter().enumerate() {
        if step.disabled || done.contains(&step.id) {
            continue;
        }
        control.check().map_err(|detail| StepFailure { index, detail })?;
        if step.kind.is_graph_step() {
            let name = step.kind.frames()[0];
            let Some(at) = graphs.iter().position(|(n, _)| n == name) else {
                let detail = detail("steps.not_graph", format!("the result {name} is no graph")).with("frame", name);
                return Err(StepFailure { index, detail });
            };
            match super::graph::apply(&step.kind, &graphs[at].1, control)
                .map_err(|detail| StepFailure { index, detail })?
            {
                super::graph::GraphOut::Graph(graph) => graphs[at].1 = graph,
                super::graph::GraphOut::Frame(frame) => {
                    let (name, _) = graphs.remove(at);
                    insert(&mut frames, name, frame);
                }
            }
            continue;
        }
        let StepKind::ToFrame { frame: name, columns, .. } = &step.kind else {
            apply(&step.kind, &mut frames, control).map_err(|detail| StepFailure { index, detail })?;
            continue;
        };
        if let Some(at) = documents.iter().position(|(n, _)| n == name) {
            let (name, set) = documents.remove(at);
            let frame = super::projection::project(&set, columns);
            insert(&mut frames, name, frame);
        } else if !frames.iter().any(|f| &f.name == name) {
            let detail =
                detail("steps.frame_missing", format!("there is no result {name} to project")).with("frame", name);
            return Err(StepFailure { index, detail });
        }
    }
    Ok((frames, graphs))
}

/// The result of one query after its graph steps (all of them graph steps of that query), as the
/// query route answers it: a frame once a step made one, else the graph.
pub fn run_graph_steps(
    steps: &[Step],
    name: &str,
    result: QueryResult,
    control: &Control,
) -> Result<QueryResult, StepFailure> {
    let QueryResult::Graph { graph } = result else {
        // Graph steps read graphs only; without an enabled one, the result stays as it is.
        return match steps.iter().position(|s| !s.disabled) {
            Some(index) => Err(StepFailure {
                index,
                detail: detail("steps.not_graph", format!("the result {name} is no graph")).with("frame", name),
            }),
            None => Ok(result),
        };
    };
    let (mut frames, mut graphs) =
        run_shapes(steps, vec![(name.to_string(), Input::Graph(graph))], control, &BTreeSet::new())?;
    Ok(match (frames.pop(), graphs.pop()) {
        (Some(f), _) => QueryResult::Frame { frame: f.frame },
        (None, Some((_, graph))) => QueryResult::Graph { graph },
        (None, None) => unreachable!("a graph stays a graph or becomes a frame"),
    })
}

fn detail(reason: &'static str, message: String) -> Detail {
    Detail::new(reason, message)
}

fn type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Time => "time",
        FieldType::Number => "number",
        FieldType::Int64 => "int64",
        FieldType::String => "string",
        FieldType::Bool => "bool",
        FieldType::Json => "json",
        FieldType::Decimal => "decimal",
        FieldType::Date => "date",
    }
}

fn wrong_type(field: &Field) -> Detail {
    detail("steps.field_type", format!("field {} ({}) cannot be used here", field.name, type_name(field.field_type)))
        .with("field", &field.name)
        .with("type", type_name(field.field_type))
}

fn position(frames: &[NamedFrame], name: &str) -> Result<usize, Detail> {
    frames.iter().position(|f| f.name == name).ok_or_else(|| {
        detail("steps.frame_missing", format!("there is no table {name} to work on")).with("frame", name)
    })
}

fn field_index(frame: &Frame, name: &str) -> Result<usize, Detail> {
    let mut found = frame.fields().iter().enumerate().filter(|(_, f)| f.name == name).map(|(i, _)| i);
    match (found.next(), found.next()) {
        (Some(i), None) => Ok(i),
        (None, _) => Err(detail("steps.field_missing", format!("there is no field {name}")).with("field", name)),
        _ => Err(detail("steps.field_ambiguous", format!("several fields are named {name}")).with("field", name)),
    }
}

/// Times and days: both are Unix ms on a time line.
fn is_time(t: FieldType) -> bool {
    matches!(t, FieldType::Time | FieldType::Date)
}

/// A decimal's text in one form, so equal decimals group and join together: no leading zeros,
/// no trailing zeros after the point, no point without a fraction, no negative zero ("-012.50"
/// is "-12.5"). Text that is no plain decimal stays as it is.
pub fn canonical_decimal(s: &str) -> String {
    let t = s.trim();
    let (negative, digits) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    let plain = |p: &str| p.bytes().all(|b| b.is_ascii_digit());
    if !plain(whole) || !plain(fraction) || (whole.is_empty() && fraction.is_empty()) {
        return s.to_string();
    }
    let whole = whole.trim_start_matches('0');
    let fraction = fraction.trim_end_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let body = if fraction.is_empty() { whole.to_string() } else { format!("{whole}.{fraction}") };
    if negative && body != "0" { format!("-{body}") } else { body }
}

fn numeric_field<'a>(frame: &'a Frame, name: &str) -> Result<&'a Field, Detail> {
    let f = &frame.fields()[field_index(frame, name)?];
    match f.field_type {
        FieldType::Number | FieldType::Int64 | FieldType::Decimal => Ok(f),
        _ => Err(wrong_type(f)),
    }
}

fn first_time_field(nf: &NamedFrame) -> Result<usize, Detail> {
    nf.frame.fields().iter().position(|f| is_time(f.field_type)).ok_or_else(|| {
        detail("steps.no_time_field", format!("table {} has no time field", nf.name)).with("frame", &nf.name)
    })
}

fn time_field(nf: &NamedFrame, name: Option<&str>) -> Result<usize, Detail> {
    match name {
        None => first_time_field(nf),
        Some(n) => {
            let i = field_index(&nf.frame, n)?;
            let f = &nf.frame.fields()[i];
            if is_time(f.field_type) { Ok(i) } else { Err(wrong_type(f)) }
        }
    }
}

fn check_free(frame: &Frame, name: &str) -> Result<(), Detail> {
    if frame.fields().iter().any(|f| f.name == name) {
        return Err(detail("steps.name_taken", format!("a field is already named {name}")).with("name", name));
    }
    Ok(())
}

/// A cell as a number: numbers, int64 text (by the shared number grammar, `expr::parse_number`)
/// and times; anything else is empty.
pub fn number_at(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|x| x.is_finite()),
        Value::String(s) => expr::parse_number(s),
        _ => None,
    }
}

/// An int64 cell as an exact integer: an optional sign and digits, spaces around allowed, within
/// the range of i128. Both engines read int64 text this way.
pub fn int_of(value: &Value) -> Option<i128> {
    match value {
        Value::String(s) => {
            let t = s.trim_matches(|c: char| c.is_ascii_whitespace());
            let digits = t.strip_prefix(['+', '-']).unwrap_or(t);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            t.parse::<i128>().ok()
        }
        Value::Number(n) => n.as_i64().map(i128::from),
        _ => None,
    }
}

fn numbers(field: &Field) -> Vec<Option<f64>> {
    field.values.iter().map(number_at).collect()
}

fn num_value(x: Option<f64>) -> Value {
    expr::to_json(x.map_or(expr::V::Null, expr::V::Num))
}

fn new_field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
    Field { name: name.to_string(), field_type, unit: None, values, labels: None }
}

fn frame_of(fields: Vec<Field>, meta: Option<&FrameMeta>) -> Result<Frame, Detail> {
    // Every step builds its fields from the same list of rows.
    let frame = Frame::new(fields).expect("step results have fields of equal length");
    Ok(match meta {
        Some(m) => frame.with_meta(m.clone()),
        None => frame,
    })
}

fn with_field(frame: &Frame, field: Field) -> Result<Frame, Detail> {
    let mut fields = frame.fields().to_vec();
    fields.push(field);
    frame_of(fields, frame.meta())
}

/// A cell as the text that groups and joins compare: numbers as JavaScript writes them, int64
/// digits, times in ms; `None` for empty. JSON cells have no key.
fn key_of(value: &Value, t: FieldType) -> Option<String> {
    match (t, value) {
        (_, Value::Null) => None,
        (FieldType::Int64, Value::String(s)) => Some(int_of(value).map_or_else(|| s.clone(), |n| n.to_string())),
        (FieldType::Decimal, Value::String(s)) => Some(canonical_decimal(s)),
        (_, Value::Number(n)) => n.as_f64().map(number_text),
        (_, Value::String(s)) => Some(s.clone()),
        (_, Value::Bool(b)) => Some(b.to_string()),
        _ => None,
    }
}

fn keyable(field: &Field) -> Result<(), Detail> {
    if field.field_type == FieldType::Json { Err(wrong_type(field)) } else { Ok(()) }
}

fn apply(kind: &StepKind, frames: &mut Vec<NamedFrame>, control: &Control) -> Result<(), Detail> {
    if let StepKind::Join { left, right, on, mode } = kind {
        return join(frames, left, right, on, *mode, control);
    }
    let index = position(frames, kind.frames()[0])?;
    let nf = &frames[index];
    let frame = &nf.frame;
    let result = match kind {
        StepKind::Calculate { name, expression, .. } => {
            check_free(frame, name)?;
            let parsed = expr::parse(expression)?;
            let compiled = expr::compile_in(&parsed, frame.fields(), control.calendar)?;
            control.cells(frame.rows(), frame.fields().len() + 1)?;
            let mut values = Vec::with_capacity(frame.rows());
            for row in 0..frame.rows() {
                control.every(row)?;
                let cell = compiled.cell(frame.fields(), row)?;
                control.spend_text(text_units(&cell))?;
                values.push(cell);
            }
            with_field(frame, new_field(name, compiled.result.field_type(), values))?
        }
        StepKind::Reduce { fields, stats, percentiles, .. } => reduce(frame, fields, stats, percentiles)?,
        StepKind::Trend { field, x, output, name, .. } => trend(nf, field, x.as_deref(), *output, name.as_deref())?,
        StepKind::MovingAverage { field, window, name, .. } => {
            check_free(frame, name)?;
            let f = numeric_field(frame, field)?;
            let values = stats::moving_average(&numbers(f), *window as usize).into_iter().map(num_value).collect();
            with_field(frame, new_field(name, FieldType::Number, values))?
        }
        StepKind::Correlate { x, y, .. } => {
            let (fx, fy) = (numeric_field(frame, x)?, numeric_field(frame, y)?);
            let points: Vec<(f64, f64)> =
                numbers(fx).into_iter().zip(numbers(fy)).filter_map(|(a, b)| Some((a?, b?))).collect();
            let r = stats::correlation(&points);
            frame_of(
                vec![
                    new_field("x", FieldType::String, vec![Value::from(x.as_str())]),
                    new_field("y", FieldType::String, vec![Value::from(y.as_str())]),
                    new_field("r", FieldType::Number, vec![num_value(r)]),
                    new_field("n", FieldType::Number, vec![Value::from(points.len())]),
                ],
                frame.meta(),
            )?
        }
        StepKind::Compare { field, time, period, output, name, .. } => {
            compare(nf, field, time.as_deref(), *period, *output, name)?
        }
        StepKind::Group { by, aggregations, .. } => group(frame, by, aggregations, control)?,
        StepKind::Pivot { row, column, value, op, .. } => pivot(frame, row, column, value, *op, control)?,
        StepKind::Join { .. }
        | StepKind::ToFrame { .. }
        | StepKind::CountLabels { .. }
        | StepKind::CountEdgeTypes { .. }
        | StepKind::DegreeDistribution { .. }
        | StepKind::TopDegree { .. }
        | StepKind::SharedNeighbours { .. } => unreachable!("joins above, projections and graph steps in run_shapes"),
    };
    frames[index].frame = result;
    Ok(())
}

fn reduce(frame: &Frame, fields: &[String], wanted: &[Stat], percentiles: &[f64]) -> Result<Frame, Detail> {
    let mut columns: Vec<(String, Vec<Value>)> = Vec::new();
    for s in wanted {
        match s {
            Stat::Percentile => {
                for p in percentiles {
                    columns.push((format!("p{}", number_text(*p)), Vec::new()));
                }
            }
            other => columns.push((stat_name(*other).to_string(), Vec::new())),
        }
    }
    let mut names = Vec::new();
    for name in fields {
        let f = numeric_field(frame, name)?;
        names.push(Value::from(name.as_str()));
        let values: Vec<f64> = numbers(f).into_iter().flatten().collect();
        let sorted = stats::sorted(&values);
        let mut column = columns.iter_mut();
        for s in wanted {
            let mut push = |v: Value| {
                if let Some((_, c)) = column.next() {
                    c.push(v);
                }
            };
            match s {
                Stat::Count => push(Value::from(values.len())),
                Stat::Sum => push(num_value((!values.is_empty()).then(|| stats::sum(&values)))),
                Stat::Mean => push(num_value(stats::mean(&values))),
                Stat::Median => push(num_value(stats::percentile(&sorted, 50.0))),
                Stat::Min => push(num_value(stats::min(&values))),
                Stat::Max => push(num_value(stats::max(&values))),
                Stat::Stddev => push(num_value(stats::stddev(&values))),
                Stat::Percentile => {
                    for p in percentiles {
                        push(num_value(stats::percentile(&sorted, *p)));
                    }
                }
            }
        }
    }
    let mut out = vec![new_field("field", FieldType::String, names)];
    out.extend(columns.into_iter().map(|(name, values)| new_field(&name, FieldType::Number, values)));
    frame_of(out, frame.meta())
}

fn stat_name(s: Stat) -> &'static str {
    match s {
        Stat::Count => "count",
        Stat::Sum => "sum",
        Stat::Mean => "mean",
        Stat::Median => "median",
        Stat::Min => "min",
        Stat::Max => "max",
        Stat::Stddev => "stddev",
        Stat::Percentile => "percentile",
    }
}

fn trend(
    nf: &NamedFrame,
    field: &str,
    x: Option<&str>,
    output: TrendOutput,
    name: Option<&str>,
) -> Result<Frame, Detail> {
    let frame = &nf.frame;
    let y = numbers(numeric_field(frame, field)?);
    // x: the named field, else the first time field, else the row number.
    let (xs, over_time): (Vec<Option<f64>>, bool) = match x {
        Some(x) => {
            let f = &frame.fields()[field_index(frame, x)?];
            match f.field_type {
                FieldType::Number | FieldType::Int64 | FieldType::Decimal | FieldType::Time | FieldType::Date => {
                    (numbers(f), is_time(f.field_type))
                }
                _ => return Err(wrong_type(f)),
            }
        }
        None => match frame.fields().iter().find(|f| is_time(f.field_type)) {
            Some(f) => (numbers(f), true),
            None => ((0..frame.rows()).map(|i| Some(i as f64)).collect(), false),
        },
    };
    let points: Vec<(f64, f64)> = xs.iter().zip(&y).filter_map(|(a, b)| Some(((*a)?, (*b)?))).collect();
    let line = stats::regression(&points);
    match output {
        TrendOutput::Fitted => {
            let name = name.unwrap_or("trend");
            check_free(frame, name)?;
            let values =
                xs.iter().map(|x| num_value(line.and_then(|l| x.map(|x| l.intercept + l.slope * x)))).collect();
            with_field(frame, new_field(name, FieldType::Number, values))
        }
        TrendOutput::Summary => {
            let per = if over_time { DAY_MS } else { 1.0 };
            frame_of(
                vec![
                    new_field("field", FieldType::String, vec![Value::from(field)]),
                    new_field("slope", FieldType::Number, vec![num_value(line.map(|l| l.slope * per))]),
                    new_field("intercept", FieldType::Number, vec![num_value(line.map(|l| l.intercept))]),
                    new_field("r2", FieldType::Number, vec![num_value(line.and_then(|l| l.r2))]),
                    new_field("n", FieldType::Number, vec![Value::from(points.len())]),
                ],
                frame.meta(),
            )
        }
    }
}

fn compare(
    nf: &NamedFrame,
    field: &str,
    time: Option<&str>,
    period: Period,
    output: CompareOutput,
    name: &str,
) -> Result<Frame, Detail> {
    let frame = &nf.frame;
    check_free(frame, name)?;
    let values = numbers(numeric_field(frame, field)?);
    let times: Vec<Option<f64>> = numbers(&frame.fields()[time_field(nf, time)?]);
    let mut at: HashMap<i64, f64> = HashMap::new();
    for (t, v) in times.iter().zip(&values) {
        if let (Some(t), Some(v)) = (t, v) {
            at.entry(*t as i64).or_insert(*v);
        }
    }
    let earlier = |t: f64| match period {
        Period::Week => t - 7.0 * DAY_MS,
        Period::Month => expr::add_months(t, -1),
        Period::Year => expr::add_months(t, -12),
    };
    let out = times
        .iter()
        .zip(&values)
        .map(|(t, v)| {
            let previous = t.and_then(|t| at.get(&(earlier(t) as i64)).copied());
            num_value(match output {
                CompareOutput::Previous => previous,
                CompareOutput::Difference => v.zip(previous).map(|(v, p)| v - p),
                CompareOutput::Percent => {
                    v.zip(previous).filter(|(_, p)| *p != 0.0).map(|(v, p)| (v - p) / p.abs() * 100.0)
                }
            })
        })
        .collect();
    with_field(frame, new_field(name, FieldType::Number, out))
}

/// Rows grouped by a key, in the order each key first appears.
fn groups(keys: impl Iterator<Item = Vec<Option<String>>>, control: &Control) -> Result<Vec<Vec<usize>>, Detail> {
    let mut index: HashMap<Vec<Option<String>>, usize> = HashMap::new();
    let mut out: Vec<Vec<usize>> = Vec::new();
    for (row, key) in keys.enumerate() {
        control.every(row)?;
        let next = out.len();
        let g = *index.entry(key).or_insert(next);
        if g == next {
            out.push(Vec::new());
        }
        out[g].push(row);
    }
    Ok(out)
}

/// Checks that `op` can aggregate `field` and gives the result's type.
fn agg_type(field: &Field, op: Agg) -> Result<FieldType, Detail> {
    use FieldType::*;
    match (op, field.field_type) {
        (Agg::Count, _) => Ok(Number),
        (Agg::First | Agg::Last, t) => Ok(t),
        (Agg::Min | Agg::Max, t @ (Number | Int64 | Decimal | Time | Date | String)) => Ok(t),
        (Agg::Sum | Agg::Mean | Agg::Median | Agg::Stddev, Number | Int64 | Decimal) => Ok(Number),
        _ => Err(wrong_type(field)),
    }
}

/// Aggregates the cells of `rows`; empty cells are left out.
fn aggregate(field: &Field, op: Agg, rows: &[usize]) -> Value {
    let cells = || rows.iter().map(|&r| &field.values[r]).filter(|v| !v.is_null());
    let nums = || -> Vec<f64> { rows.iter().filter_map(|&r| number_at(&field.values[r])).collect() };
    match op {
        Agg::Count => Value::from(cells().count()),
        Agg::First => cells().next().cloned().unwrap_or(Value::Null),
        Agg::Last => cells().next_back().cloned().unwrap_or(Value::Null),
        Agg::Sum => {
            let v = nums();
            num_value((!v.is_empty()).then(|| stats::sum(&v)))
        }
        Agg::Mean => num_value(stats::mean(&nums())),
        Agg::Median => num_value(stats::percentile(&stats::sorted(&nums()), 50.0)),
        Agg::Stddev => num_value(stats::stddev(&nums())),
        Agg::Min | Agg::Max => {
            let less = |a: &Value, b: &Value| -> bool {
                match field.field_type {
                    FieldType::Int64 => match (int_of(a), int_of(b)) {
                        (Some(x), Some(y)) => x < y,
                        _ => number_at(a) < number_at(b),
                    },
                    FieldType::String => {
                        a.as_str().unwrap_or_default().chars().lt(b.as_str().unwrap_or_default().chars())
                    }
                    _ => number_at(a) < number_at(b),
                }
            };
            let mut best: Option<&Value> = None;
            for v in cells() {
                if field.field_type != FieldType::String && number_at(v).is_none() {
                    continue;
                }
                best = Some(match best {
                    None => v,
                    Some(b) if (op == Agg::Min && less(v, b)) || (op == Agg::Max && less(b, v)) => v,
                    Some(b) => b,
                });
            }
            best.cloned().unwrap_or(Value::Null)
        }
    }
}

fn group(frame: &Frame, by: &[String], aggregations: &[Aggregation], control: &Control) -> Result<Frame, Detail> {
    let by_fields: Vec<&Field> =
        by.iter().map(|n| field_index(frame, n).map(|i| &frame.fields()[i])).collect::<Result<_, _>>()?;
    for f in &by_fields {
        keyable(f)?;
    }
    let mut out_names: Vec<String> = by.to_vec();
    let mut plan = Vec::new();
    for a in aggregations {
        let f = &frame.fields()[field_index(frame, &a.field)?];
        let t = agg_type(f, a.op)?;
        let name = a.output_name();
        if out_names.contains(&name) {
            return Err(detail("steps.name_taken", format!("a field is already named {name}")).with("name", &name));
        }
        out_names.push(name.clone());
        plan.push((f, a.op, t, name));
    }
    let rows = groups(
        (0..frame.rows()).map(|r| by_fields.iter().map(|f| key_of(&f.values[r], f.field_type)).collect()),
        control,
    )?;
    control.cells(rows.len(), by.len() + plan.len())?;
    let mut fields: Vec<Field> = by_fields
        .iter()
        .map(|f| Field {
            name: f.name.clone(),
            field_type: f.field_type,
            unit: f.unit.clone(),
            labels: f.labels.clone(),
            values: rows.iter().map(|g| f.values[g[0]].clone()).collect(),
        })
        .collect();
    for (f, op, t, name) in plan {
        let mut field = new_field(&name, t, rows.iter().map(|g| aggregate(f, op, g)).collect());
        if !matches!(op, Agg::Count) {
            field.unit = f.unit.clone();
        }
        fields.push(field);
    }
    frame_of(fields, frame.meta())
}

fn pivot(frame: &Frame, row: &str, column: &str, value: &str, op: Agg, control: &Control) -> Result<Frame, Detail> {
    let rf = &frame.fields()[field_index(frame, row)?];
    let cf = &frame.fields()[field_index(frame, column)?];
    let vf = &frame.fields()[field_index(frame, value)?];
    keyable(rf)?;
    keyable(cf)?;
    let t = agg_type(vf, op)?;
    let row_groups = groups((0..frame.rows()).map(|r| vec![key_of(&rf.values[r], rf.field_type)]), control)?;
    let col_groups = groups((0..frame.rows()).map(|r| vec![key_of(&cf.values[r], cf.field_type)]), control)?;
    if col_groups.len() > MAX_COLUMNS {
        return Err(detail("steps.too_many_columns", format!("the pivot would make more than {MAX_COLUMNS} fields"))
            .with("max", MAX_COLUMNS));
    }
    control.cells(row_groups.len(), col_groups.len() + 1)?;
    // The rows of each cell (row group, column group).
    let mut column_of = vec![0; frame.rows()];
    for (c, g) in col_groups.iter().enumerate() {
        for &r in g {
            column_of[r] = c;
        }
    }
    let mut cells: HashMap<(usize, usize), Vec<usize>> = HashMap::new();
    for (g, rows) in row_groups.iter().enumerate() {
        for &r in rows {
            cells.entry((g, column_of[r])).or_default().push(r);
        }
    }
    let mut fields = vec![Field {
        name: rf.name.clone(),
        field_type: rf.field_type,
        unit: rf.unit.clone(),
        labels: rf.labels.clone(),
        values: row_groups.iter().map(|g| rf.values[g[0]].clone()).collect(),
    }];
    for (c, g) in col_groups.iter().enumerate() {
        control.check()?;
        let first = &cf.values[g[0]];
        let name = match (cf.field_type, number_at(first)) {
            (FieldType::Time, Some(ms)) => expr::iso_time(ms as i64),
            (FieldType::Date, Some(ms)) => expr::iso_time(ms as i64)[..10].to_string(),
            _ => key_of(first, cf.field_type).unwrap_or_else(|| "null".into()),
        };
        if fields.iter().any(|f| f.name == name) {
            return Err(detail("steps.name_taken", format!("a field is already named {name}")).with("name", &name));
        }
        let values = (0..row_groups.len())
            .map(|g| aggregate(vf, op, cells.get(&(g, c)).map_or(&[][..], Vec::as_slice)))
            .collect();
        let mut field = new_field(&name, t, values);
        if !matches!(op, Agg::Count) {
            field.unit = vf.unit.clone();
        }
        fields.push(field);
    }
    frame_of(fields, frame.meta())
}

/// Whether two key fields can be compared: numbers, int64 and decimals with each other, times
/// with days (both Unix ms), or the same type.
fn same_family(a: FieldType, b: FieldType) -> bool {
    use FieldType::*;
    matches!((a, b), (Number | Int64 | Decimal, Number | Int64 | Decimal))
        || (is_time(a) && is_time(b))
        || (a == b && a != Json)
}

fn join(
    frames: &mut Vec<NamedFrame>,
    left: &str,
    right: &str,
    on: &JoinOn,
    mode: JoinMode,
    control: &Control,
) -> Result<(), Detail> {
    let li = position(frames, left)?;
    let ri = position(frames, right)?;
    let (l, r) = (&frames[li], &frames[ri]);
    let (lk, rk) = match on {
        JoinOn::Time => (first_time_field(l)?, first_time_field(r)?),
        JoinOn::Key { left_field, right_field } => {
            (field_index(&l.frame, left_field)?, field_index(&r.frame, right_field)?)
        }
    };
    let (lkf, rkf) = (&l.frame.fields()[lk], &r.frame.fields()[rk]);
    keyable(lkf)?;
    keyable(rkf)?;
    if !same_family(lkf.field_type, rkf.field_type) {
        return Err(detail(
            "steps.key_types",
            format!(
                "{} ({}) cannot be matched with {} ({})",
                lkf.name,
                type_name(lkf.field_type),
                rkf.name,
                type_name(rkf.field_type)
            ),
        )
        .with("left", type_name(lkf.field_type))
        .with("right", type_name(rkf.field_type)));
    }
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    for (row, v) in rkf.values.iter().enumerate() {
        if let Some(k) = key_of(v, rkf.field_type) {
            by_key.entry(k).or_default().push(row);
        }
    }
    let too_many = || {
        detail("steps.too_many_rows", format!("the join would make more than {MAX_ROWS} rows")).with("max", MAX_ROWS)
    };
    // The result has the key and every other field of both sides; checked as pairs grow, before
    // a single cell is copied.
    let width = l.frame.fields().len() + r.frame.fields().len() - 1;
    let fits = |pairs: usize| -> Result<(), Detail> {
        if pairs > MAX_ROWS {
            return Err(too_many());
        }
        control.cells(pairs, width)
    };
    let mut pairs: Vec<(Option<usize>, Option<usize>)> = Vec::new();
    let mut matched = vec![false; r.frame.rows()];
    for (row, v) in lkf.values.iter().enumerate() {
        control.every(row)?;
        let hits = key_of(v, lkf.field_type).and_then(|k| by_key.get(&k));
        match hits {
            Some(hits) => {
                for &j in hits {
                    matched[j] = true;
                    pairs.push((Some(row), Some(j)));
                    if pairs.len().is_multiple_of(CHECK_EVERY) {
                        fits(pairs.len())?;
                        control.check()?;
                    }
                }
            }
            None if mode != JoinMode::Inner => pairs.push((Some(row), None)),
            None => {}
        }
        fits(pairs.len())?;
    }
    if mode == JoinMode::Outer {
        pairs.extend(matched.iter().enumerate().filter(|(_, m)| !**m).map(|(j, _)| (None, Some(j))));
        fits(pairs.len())?;
    }
    // The text the copies take, against the run's budget.
    let row_text = |f: &Frame| -> Vec<usize> {
        (0..f.rows()).map(|i| f.fields().iter().map(|x| text_units(&x.values[i])).sum()).collect()
    };
    let (lt, rt) = (row_text(&l.frame), row_text(&r.frame));
    let copied: usize = pairs.iter().map(|(i, j)| i.map_or(0, |i| lt[i]) + j.map_or(0, |j| rt[j])).sum();
    control.spend_text(copied)?;
    let key_cell = |p: &(Option<usize>, Option<usize>)| -> Value {
        match p {
            (Some(i), _) => lkf.values[*i].clone(),
            (None, Some(j)) => convert_key(&rkf.values[*j], rkf.field_type, lkf.field_type),
            (None, None) => Value::Null,
        }
    };
    if matches!(on, JoinOn::Time) {
        // A time series stays in time order; rows without a time go last. The sort is stable.
        pairs.sort_by(|a, b| {
            let (ta, tb) = (number_at(&key_cell(a)), number_at(&key_cell(b)));
            match (ta, tb) {
                (Some(x), Some(y)) => x.total_cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            }
        });
    }
    let mut fields = vec![Field {
        name: lkf.name.clone(),
        field_type: lkf.field_type,
        unit: lkf.unit.clone(),
        labels: lkf.labels.clone(),
        values: pairs.iter().map(key_cell).collect(),
    }];
    for (nf, key, is_left) in [(l, lk, true), (r, rk, false)] {
        for (i, f) in nf.frame.fields().iter().enumerate() {
            if i == key {
                continue;
            }
            let values = pairs
                .iter()
                .map(|p| {
                    let row = if is_left { p.0 } else { p.1 };
                    row.map_or(Value::Null, |r| f.values[r].clone())
                })
                .collect();
            fields.push(Field {
                name: format!("{}.{}", nf.name, f.name),
                field_type: f.field_type,
                unit: f.unit.clone(),
                labels: f.labels.clone(),
                values,
            });
        }
    }
    let meta = match (l.frame.meta(), r.frame.meta()) {
        (None, None) => None,
        (a, b) => {
            let a = a.cloned().unwrap_or_default();
            let b = b.cloned().unwrap_or_default();
            Some(FrameMeta {
                executed_query: None,
                rows_truncated: a.rows_truncated || b.rows_truncated,
                notices: a.notices.into_iter().chain(b.notices).collect(),
            })
        }
    };
    let joined = frame_of(fields, meta.as_ref())?;
    frames[li].frame = joined;
    frames.remove(ri);
    Ok(())
}

/// A key cell of the right frame in the type of the left key field: numbers, int64 and decimals
/// mix (int64 and decimals as their decimal text); times and days are both Unix ms.
fn convert_key(value: &Value, from: FieldType, to: FieldType) -> Value {
    use FieldType::*;
    match (from, to) {
        (Int64 | Decimal, Number) => num_value(number_at(value)),
        (Number | Decimal, Int64) | (Number | Int64, Decimal) => key_of(value, from).map_or(Value::Null, Value::String),
        _ => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::parse_step;
    use serde_json::json;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn named(name: &str, fields: Vec<Field>) -> NamedFrame {
        NamedFrame { name: name.into(), frame: Frame::new(fields).unwrap() }
    }

    fn steps(raw: Value) -> Vec<Step> {
        raw.as_array().unwrap().iter().map(|s| parse_step(s).unwrap()).collect()
    }

    fn values(nf: &NamedFrame, name: &str) -> Vec<Value> {
        nf.frame.fields().iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no field {name}")).values.clone()
    }

    fn names(nf: &NamedFrame) -> Vec<&str> {
        nf.frame.fields().iter().map(|f| f.name.as_str()).collect()
    }

    const DAY: i64 = 86_400_000;
    const T0: i64 = 1_767_225_600_000; // 2026-01-01

    fn sales() -> NamedFrame {
        named(
            "A",
            vec![
                field("zeit", FieldType::Time, (0..4).map(|d| json!(T0 + d * DAY)).collect()),
                field("land", FieldType::String, vec![json!("AT"), json!("CH"), json!("AT"), Value::Null]),
                field("betrag", FieldType::Number, vec![json!(10), json!(20), json!(30.5), Value::Null]),
                field("stueck", FieldType::Int64, vec![json!("1"), json!("2"), json!("3"), json!("9007199254740993")]),
            ],
        )
    }

    #[test]
    fn calculate_adds_a_typed_field_and_refuses_taken_names() {
        let out = run(
            &steps(json!([{ "id": "1", "type": "calculate", "frame": "A", "name": "brutto", "expression": "round(betrag * 1.2, 2)" }])),
            vec![sales()],
        )
        .unwrap();
        assert_eq!(values(&out[0], "brutto"), [json!(12.0), json!(24.0), json!(36.6), Value::Null]);
        assert_eq!(out[0].frame.fields()[4].field_type, FieldType::Number);
        let err = run(
            &steps(json!([{ "id": "1", "type": "calculate", "frame": "A", "name": "land", "expression": "1" }])),
            vec![sales()],
        )
        .unwrap_err();
        assert_eq!((err.index, err.detail.reason), (0, "steps.name_taken"));
        let err = run(
            &steps(json!([
                { "id": "0", "type": "calculate", "frame": "A", "name": "aus", "expression": "1", "disabled": true },
                { "id": "1", "type": "calculate", "frame": "A", "name": "x", "expression": "land * 2" }
            ])),
            vec![sales()],
        )
        .unwrap_err();
        assert_eq!((err.index, err.detail.reason), (1, "expression.operand_types"));
        let err = run(
            &steps(json!([{ "id": "1", "type": "calculate", "frame": "B", "name": "x", "expression": "1" }])),
            vec![sales()],
        )
        .unwrap_err();
        assert_eq!(err.detail.reason, "steps.frame_missing");
    }

    #[test]
    fn joins_by_time_span_queries() {
        let sessions = named(
            "B",
            vec![
                field("time", FieldType::Time, vec![json!(T0 + DAY), json!(T0), json!(T0 + 9 * DAY)]),
                field("sitzungen", FieldType::Number, vec![json!(4), json!(5), json!(1)]),
            ],
        );
        let s = steps(json!([
            { "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "inner" },
            { "id": "c", "type": "calculate", "frame": "A", "name": "proSitzung", "expression": "A.betrag / B.sitzungen" }
        ]));
        let out = run(&s, vec![sales(), sessions.clone()]).unwrap();
        assert_eq!(out.len(), 1, "the right table is used up");
        assert_eq!(names(&out[0]), ["zeit", "A.land", "A.betrag", "A.stueck", "B.sitzungen", "proSitzung"]);
        assert_eq!(values(&out[0], "zeit"), [json!(T0), json!(T0 + DAY)]);
        assert_eq!(values(&out[0], "proSitzung"), [json!(2.0), json!(5.0)]);

        let outer = steps(
            json!([{ "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "outer" }]),
        );
        let out = run(&outer, vec![sales(), sessions.clone()]).unwrap();
        let times: Vec<i64> = values(&out[0], "zeit").iter().map(|v| v.as_i64().unwrap()).collect();
        assert_eq!(times, [T0, T0 + DAY, T0 + 2 * DAY, T0 + 3 * DAY, T0 + 9 * DAY], "in time order");
        assert_eq!(values(&out[0], "B.sitzungen"), [json!(5), json!(4), Value::Null, Value::Null, json!(1)]);
        assert_eq!(values(&out[0], "A.betrag")[4], Value::Null);

        let left = steps(
            json!([{ "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "left" }]),
        );
        assert_eq!(run(&left, vec![sales(), sessions]).unwrap()[0].frame.rows(), 4);
    }

    #[test]
    fn joins_by_key_match_numbers_with_int64_and_never_empty_keys() {
        let prices = named(
            "B",
            vec![
                field("nr", FieldType::Number, vec![json!(2), json!(3), json!(3), Value::Null]),
                field("preis", FieldType::Number, vec![json!(1.5), json!(2), json!(2.5), json!(9)]),
            ],
        );
        let s = steps(json!([{ "id": "j", "type": "join", "left": "A", "right": "B",
            "on": { "by": "key", "leftField": "stueck", "rightField": "nr" }, "mode": "outer" }]));
        let out = run(&s, vec![sales(), prices]).unwrap();
        assert_eq!(
            values(&out[0], "stueck"),
            [json!("1"), json!("2"), json!("3"), json!("3"), json!("9007199254740993"), Value::Null]
        );
        assert_eq!(values(&out[0], "B.preis"), [Value::Null, json!(1.5), json!(2), json!(2.5), Value::Null, json!(9)]);
        let bad = steps(json!([{ "id": "j", "type": "join", "left": "A", "right": "B",
            "on": { "by": "key", "leftField": "land", "rightField": "nr" }, "mode": "outer" }]));
        let prices = named("B", vec![field("nr", FieldType::Number, vec![json!(1)])]);
        assert_eq!(run(&bad, vec![sales(), prices]).unwrap_err().detail.reason, "steps.key_types");
        let no_time = named("B", vec![field("nr", FieldType::Number, vec![json!(1)])]);
        let by_time = steps(
            json!([{ "id": "j", "type": "join", "left": "A", "right": "B", "on": { "by": "time" }, "mode": "inner" }]),
        );
        assert_eq!(run(&by_time, vec![sales(), no_time]).unwrap_err().detail.reason, "steps.no_time_field");
    }

    #[test]
    fn many_to_many_joins_are_bounded() {
        let ones = |name: &str, n: usize| named(name, vec![field("k", FieldType::Number, vec![json!(1); n])]);
        let s = steps(json!([{ "id": "j", "type": "join", "left": "A", "right": "B",
            "on": { "by": "key", "leftField": "k", "rightField": "k" }, "mode": "inner" }]));
        assert_eq!(run(&s, vec![ones("A", 1000), ones("B", 1000)]).unwrap_err().detail.reason, "steps.too_many_rows");
        assert_eq!(run(&s, vec![ones("A", 100), ones("B", 100)]).unwrap()[0].frame.rows(), 10_000);
    }

    #[test]
    fn statistics_per_field() {
        let s = steps(json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["betrag", "stueck"],
            "stats": ["count", "sum", "mean", "median", "min", "max", "stddev", "percentile"], "percentiles": [90, 12.5] }]));
        let out = run(&s, vec![sales()]).unwrap();
        assert_eq!(names(&out[0]), ["field", "count", "sum", "mean", "median", "min", "max", "stddev", "p90", "p12.5"]);
        assert_eq!(values(&out[0], "field"), [json!("betrag"), json!("stueck")]);
        assert_eq!(values(&out[0], "count"), [json!(3), json!(4)]);
        assert_eq!(values(&out[0], "sum")[0], json!(60.5));
        assert_eq!(values(&out[0], "median")[0], json!(20.0));
        assert!((values(&out[0], "p90")[0].as_f64().unwrap() - 28.4).abs() < 1e-9);
        let err = run(
            &steps(json!([{ "id": "r", "type": "reduce", "frame": "A", "fields": ["land"], "stats": ["sum"] }])),
            vec![sales()],
        )
        .unwrap_err();
        assert_eq!(err.detail.reason, "steps.field_type");
        assert_eq!(err.detail.params.get("type").map(String::as_str), Some("string"));
    }

    #[test]
    fn trend_moving_average_correlation_and_previous_periods() {
        let s = steps(json!([
            { "id": "t", "type": "trend", "frame": "A", "field": "betrag", "output": "fitted", "name": "trend" },
            { "id": "m", "type": "movingAverage", "frame": "A", "field": "betrag", "window": 2, "name": "schnitt" }
        ]));
        let out = run(&s, vec![sales()]).unwrap();
        let trend: Vec<f64> = values(&out[0], "trend").iter().map(|v| v.as_f64().unwrap()).collect();
        // betrag 10, 20, 30.5 over days 0, 1, 2: slope 10.25 per day, intercept 9.916...
        assert!((trend[3] - trend[2] - 10.25).abs() < 1e-9, "{trend:?}");
        assert_eq!(values(&out[0], "schnitt"), [Value::Null, json!(15.0), json!(25.25), json!(30.5)]);

        let summary =
            steps(json!([{ "id": "t", "type": "trend", "frame": "A", "field": "betrag", "output": "summary" }]));
        let out = run(&summary, vec![sales()]).unwrap();
        assert!((values(&out[0], "slope")[0].as_f64().unwrap() - 10.25).abs() < 1e-9);
        assert_eq!(values(&out[0], "n"), [json!(3)]);

        let corr = steps(json!([{ "id": "c", "type": "correlate", "frame": "A", "x": "betrag", "y": "stueck" }]));
        let r = values(&run(&corr, vec![sales()]).unwrap()[0], "r")[0].as_f64().unwrap();
        assert!(r > 0.99 && r <= 1.0, "{r}");

        // Daily values over two years; compare each with a week, a month and a year earlier.
        let days: Vec<i64> = (0..800).collect();
        let daily = named(
            "A",
            vec![
                field("t", FieldType::Time, days.iter().map(|d| json!(T0 - 400 * DAY + d * DAY)).collect()),
                field("v", FieldType::Number, days.iter().map(|d| json!(*d)).collect()),
            ],
        );
        let cmp = steps(json!([
            { "id": "w", "type": "compare", "frame": "A", "field": "v", "period": "week", "output": "difference", "name": "w" },
            { "id": "m", "type": "compare", "frame": "A", "field": "v", "period": "month", "output": "previous", "name": "m" },
            { "id": "y", "type": "compare", "frame": "A", "field": "v", "period": "year", "output": "percent", "name": "y" }
        ]));
        let out = run(&cmp, vec![daily]).unwrap();
        assert_eq!(values(&out[0], "w")[6], Value::Null, "no week before the first");
        assert_eq!(values(&out[0], "w")[7], json!(7.0));
        // Row 400 is 2026-01-01; a month earlier is 2025-12-01, 31 days before (row 369).
        assert_eq!(values(&out[0], "m")[400], json!(369.0));
        // A year before 2026-01-01 is row 35; (400 - 35) / 35 * 100.
        let y = values(&out[0], "y")[400].as_f64().unwrap();
        assert!((y - 365.0 / 35.0 * 100.0).abs() < 1e-9, "{y}");
    }

    #[test]
    fn group_and_pivot() {
        let s = steps(json!([{ "id": "g", "type": "group", "frame": "A", "by": ["land"], "aggregations": [
            { "field": "betrag", "op": "sum" }, { "field": "betrag", "op": "count", "name": "n" },
            { "field": "stueck", "op": "max" }, { "field": "zeit", "op": "first" } ] }]));
        let out = run(&s, vec![sales()]).unwrap();
        assert_eq!(names(&out[0]), ["land", "sum(betrag)", "n", "max(stueck)", "first(zeit)"]);
        assert_eq!(values(&out[0], "land"), [json!("AT"), json!("CH"), Value::Null]);
        assert_eq!(values(&out[0], "sum(betrag)"), [json!(40.5), json!(20.0), Value::Null]);
        assert_eq!(values(&out[0], "n"), [json!(2), json!(1), json!(0)]);
        assert_eq!(values(&out[0], "max(stueck)"), [json!("3"), json!("2"), json!("9007199254740993")]);
        assert_eq!(out[0].frame.fields()[3].field_type, FieldType::Int64);
        assert_eq!(out[0].frame.fields()[4].field_type, FieldType::Time);

        let wide = named(
            "A",
            vec![
                field("land", FieldType::String, vec![json!("AT"), json!("AT"), json!("CH"), json!("AT")]),
                field("jahr", FieldType::Int64, vec![json!("2025"), json!("2026"), json!("2026"), json!("2026")]),
                field("betrag", FieldType::Number, vec![json!(1), json!(2), json!(3), json!(4)]),
            ],
        );
        let p = steps(
            json!([{ "id": "p", "type": "pivot", "frame": "A", "row": "land", "column": "jahr", "value": "betrag", "op": "sum" }]),
        );
        let out = run(&p, vec![wide.clone()]).unwrap();
        assert_eq!(names(&out[0]), ["land", "2025", "2026"]);
        assert_eq!(values(&out[0], "2025"), [json!(1.0), Value::Null]);
        assert_eq!(values(&out[0], "2026"), [json!(6.0), json!(3.0)]);
        let many = named(
            "A",
            vec![
                field("r", FieldType::Number, vec![json!(1); 600]),
                field("c", FieldType::Number, (0..600).map(|i| json!(i)).collect()),
            ],
        );
        let p = steps(
            json!([{ "id": "p", "type": "pivot", "frame": "A", "row": "r", "column": "c", "value": "c", "op": "count" }]),
        );
        assert_eq!(run(&p, vec![many]).unwrap_err().detail.reason, "steps.too_many_columns");
        let bad = steps(
            json!([{ "id": "g", "type": "group", "frame": "A", "by": ["land"], "aggregations": [{ "field": "land", "op": "sum" }] }]),
        );
        assert_eq!(run(&bad, vec![wide]).unwrap_err().detail.reason, "steps.field_type");
    }

    /// Nested `concat` grows a cell about a thousandfold per step; the cap stops it at the first.
    #[test]
    fn text_cannot_grow_without_bound() {
        let refs = |f: &str| format!("concat({})", vec![f; 99].join(","));
        let nested = |f: &str| format!("concat({})", vec![refs(f); 9].join(","));
        let s = steps(json!([
            { "id": "1", "type": "calculate", "frame": "A", "name": "b", "expression": nested("a") },
            { "id": "2", "type": "calculate", "frame": "A", "name": "c", "expression": nested("b") },
        ]));
        let a = named("A", vec![field("a", FieldType::String, vec![json!("0123456789")])]);
        let err = run(&s, vec![a]).unwrap_err();
        assert_eq!((err.index, err.detail.reason), (1, "expression.text_too_long"));
        assert_eq!(err.detail.params.get("max").map(String::as_str), Some("32767"));
    }

    /// The copies of text a join makes count against the run's budget.
    #[test]
    fn joins_spend_the_text_budget() {
        let side = |name: &str| {
            named(
                name,
                vec![
                    field("k", FieldType::Number, (0..10).map(|i| json!(i)).collect()),
                    field("t", FieldType::String, vec![json!("x".repeat(100)); 10]),
                ],
            )
        };
        let j = steps(json!([{ "id": "j", "type": "join", "left": "A", "right": "B",
            "on": { "by": "key", "leftField": "k", "rightField": "k" }, "mode": "inner" }]));
        let inputs =
            || vec![("A".to_string(), Input::Frame(side("A").frame)), ("B".to_string(), Input::Frame(side("B").frame))];
        // 10 rows of 200 units each.
        let enough = Control { text_left: Cell::new(2000), ..Control::unbounded() };
        assert!(run_inputs(&j, inputs(), &enough).is_ok());
        let short = Control { text_left: Cell::new(1999), ..Control::unbounded() };
        assert_eq!(run_inputs(&j, inputs(), &short).unwrap_err().detail.reason, "steps.too_much_text");
    }

    /// Calculate and group are measured before they build, as join and pivot are.
    #[test]
    fn calculate_and_group_are_bounded_in_cells() {
        let small = || Control { max_cells: 7, ..Control::unbounded() };
        let one = |s: Value| -> Result<Vec<NamedFrame>, StepFailure> {
            run_inputs(&steps(s), vec![("A".to_string(), Input::Frame(sales().frame))], &small())
        };
        // 4 rows of 4 fields, one more is 20 cells.
        let calc = json!([{ "id": "1", "type": "calculate", "frame": "A", "name": "x", "expression": "1" }]);
        assert_eq!(one(calc).unwrap_err().detail.reason, "steps.too_many_cells");
        // 3 groups of a key and an aggregation are 6 cells; a second aggregation makes 9.
        let fits = json!([{ "id": "g", "type": "group", "frame": "A", "by": ["land"],
            "aggregations": [{ "field": "betrag", "op": "sum" }] }]);
        assert!(one(fits).is_ok());
        let over = json!([{ "id": "g", "type": "group", "frame": "A", "by": ["land"],
            "aggregations": [{ "field": "betrag", "op": "sum" }, { "field": "betrag", "op": "max" }] }]);
        assert_eq!(one(over).unwrap_err().detail.reason, "steps.too_many_cells");
    }

    /// Every cell of text a run makes counts against one budget.
    #[test]
    fn the_run_has_a_text_budget() {
        let frame = named("A", vec![field("a", FieldType::String, vec![json!("x".repeat(1000)); 100])]);
        let s = steps(json!([
            { "id": "1", "type": "calculate", "frame": "A", "name": "b", "expression": "concat(a, a)" },
            { "id": "2", "type": "calculate", "frame": "A", "name": "c", "expression": "concat(b, b)" },
        ]));
        let control = Control { text_left: Cell::new(300_000), ..Control::unbounded() };
        let inputs = vec![("A".to_string(), Input::Frame(frame.frame))];
        let err = run_inputs(&s, inputs, &control).unwrap_err();
        // 200,000 units for b fit; c's 400,000 do not.
        assert_eq!((err.index, err.detail.reason), (1, "steps.too_much_text"));
    }

    /// Joins and pivots are measured before they are built.
    #[test]
    fn joins_and_pivots_are_bounded_in_cells() {
        let n = 100_000;
        let tall = named(
            "A",
            vec![
                field("r", FieldType::Number, (0..n).map(|i| json!(i)).collect()),
                field("c", FieldType::Number, (0..n).map(|i| json!(i % 500)).collect()),
            ],
        );
        let p = steps(
            json!([{ "id": "p", "type": "pivot", "frame": "A", "row": "r", "column": "c", "value": "c", "op": "sum" }]),
        );
        assert_eq!(run(&p, vec![tall]).unwrap_err().detail.reason, "steps.too_many_cells");
        let wide = |name: &str| {
            named(
                name,
                std::iter::once(field("k", FieldType::Number, vec![json!(1); 700]))
                    .chain((0..60).map(|c| field(&format!("f{c}"), FieldType::Number, vec![json!(0); 700])))
                    .collect(),
            )
        };
        let j = steps(json!([{ "id": "j", "type": "join", "left": "A", "right": "B",
            "on": { "by": "key", "leftField": "k", "rightField": "k" }, "mode": "inner" }]));
        let err = run(&j, vec![wide("A"), wide("B")]).unwrap_err();
        assert_eq!(err.detail.reason, "steps.too_many_cells", "490,000 rows of 121 fields");
    }

    /// The server's runs stop when the client is gone or the time is up.
    #[test]
    fn runs_stop_when_cancelled_or_late() {
        let s = steps(json!([{ "id": "1", "type": "calculate", "frame": "A", "name": "x", "expression": "1" }]));
        let input = || vec![("A".to_string(), Input::Frame(sales().frame))];
        let flag = Arc::new(AtomicBool::new(true));
        let err = run_inputs(&s, input(), &Control::new(flag, 30)).unwrap_err();
        assert_eq!(err.detail.reason, "steps.cancelled");
        let err = run_inputs(&s, input(), &Control::new(Arc::new(AtomicBool::new(false)), 0)).unwrap_err();
        assert_eq!(err.detail.reason, "steps.timeout");
        assert!(run_inputs(&s, input(), &Control::new(Arc::new(AtomicBool::new(false)), 30)).is_ok());
    }

    /// int64 text follows the shared number grammar: spaces around and a sign are fine.
    #[test]
    fn int64_text_reads_as_both_engines_read_it() {
        let f = named("A", vec![field("i", FieldType::Int64, vec![json!(" 5"), json!("+7"), json!("x"), json!("-3")])]);
        let s = steps(json!([{ "id": "1", "type": "calculate", "frame": "A", "name": "n", "expression": "i + 0" }]));
        let out = run(&s, vec![f.clone()]).unwrap();
        assert_eq!(values(&out[0], "n"), [json!(5.0), json!(7.0), Value::Null, json!(-3.0)]);
        let g = steps(json!([{ "id": "2", "type": "reduce", "frame": "A", "fields": ["i"], "stats": ["min", "max"] }]));
        let out = run(&g, vec![f.clone()]).unwrap();
        assert_eq!((values(&out[0], "min")[0].clone(), values(&out[0], "max")[0].clone()), (json!(-3.0), json!(7.0)));
        // Group keys and min and max of int64 read the same text the same way.
        let m = steps(json!([{ "id": "3", "type": "group", "frame": "A", "by": ["i"],
            "aggregations": [{ "field": "i", "op": "max", "name": "top" }] }]));
        let out = run(&m, vec![f]).unwrap();
        assert_eq!(
            values(&out[0], "top"),
            [json!(" 5"), json!("+7"), Value::Null, json!("-3")],
            "unreadable int64 is no value"
        );
        assert_eq!(int_of(&json!(" 5")), Some(5));
        assert_eq!(int_of(&json!("5.0")), None);
        assert_eq!(key_of(&json!(" +5 "), FieldType::Int64), Some("5".into()));
    }

    /// The budget: 100,000 rows through three steps.
    #[test]
    fn a_hundred_thousand_rows_through_three_steps_in_time() {
        let n = 100_000;
        let frame = named(
            "A",
            vec![
                field("zeit", FieldType::Time, (0..n).map(|i| json!(T0 + i * 60_000)).collect()),
                field("land", FieldType::String, (0..n).map(|i| json!(["AT", "CH", "DE"][(i % 3) as usize])).collect()),
                field("betrag", FieldType::Number, (0..n).map(|i| json!((i % 97) as f64 * 1.5)).collect()),
            ],
        );
        let s = steps(json!([
            { "id": "1", "type": "calculate", "frame": "A", "name": "brutto", "expression": "if(land = 'AT', betrag * 1.2, betrag * 1.19)" },
            { "id": "2", "type": "movingAverage", "frame": "A", "field": "brutto", "window": 60, "name": "schnitt" },
            { "id": "3", "type": "group", "frame": "A", "by": ["land"], "aggregations": [{ "field": "schnitt", "op": "mean" }] }
        ]));
        let started = std::time::Instant::now();
        let out = run(&s, vec![frame]).unwrap();
        let took = started.elapsed();
        assert_eq!(out[0].frame.rows(), 3);
        // Generous for unoptimized test builds on CI machines; release builds take a fraction.
        assert!(took < std::time::Duration::from_secs(5), "took {took:?}");
    }
}
