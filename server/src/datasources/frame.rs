//! Builds result frames row by row within the limits: at most `max_rows` rows, and a response
//! size budget shared by all queries of one request. Hitting a limit stops reading and marks the
//! frame `rowsTruncated` with a notice instead of failing the query.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

use super::detail::Detail;
use super::sql::{Fill, FillMode};
use crate::shapes::{Field, FieldType, Frame, FrameMeta, Notice, NoticeSeverity};

/// Bytes left for the results of one request; queries running in parallel draw from it. When
/// created `within` a server-wide pool, every byte is also drawn from that pool, and what the
/// request drew goes back to it when the request's last budget handle is dropped.
#[derive(Clone, Debug)]
pub struct ResponseBudget(Arc<Budget>);

#[derive(Debug)]
struct Budget {
    left: AtomicUsize,
    server: Option<Arc<AtomicUsize>>,
    drawn: AtomicUsize,
}

impl Drop for Budget {
    fn drop(&mut self) {
        if let Some(server) = &self.server {
            server.fetch_add(*self.drawn.get_mut(), Ordering::SeqCst);
        }
    }
}

fn reserve(counter: &AtomicUsize, bytes: usize) -> bool {
    // A compare-exchange loop rather than `fetch_update`, which newer toolchains deprecate under
    // another name; this compiles the same everywhere.
    let mut left = counter.load(Ordering::SeqCst);
    loop {
        let Some(rest) = left.checked_sub(bytes) else { return false };
        match counter.compare_exchange_weak(left, rest, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => return true,
            Err(now) => left = now,
        }
    }
}

impl ResponseBudget {
    pub fn new(max_bytes: usize) -> Self {
        Self(Arc::new(Budget { left: AtomicUsize::new(max_bytes), server: None, drawn: AtomicUsize::new(0) }))
    }

    /// A request budget that also draws from the server-wide pool of in-flight result bytes.
    pub fn within(max_bytes: usize, server: Arc<AtomicUsize>) -> Self {
        Self(Arc::new(Budget { left: AtomicUsize::new(max_bytes), server: Some(server), drawn: AtomicUsize::new(0) }))
    }

    /// Reserves `bytes`; false (and nothing reserved) when not enough is left.
    pub fn take(&self, bytes: usize) -> bool {
        if !reserve(&self.0.left, bytes) {
            return false;
        }
        if let Some(server) = &self.0.server
            && !reserve(server, bytes)
        {
            self.0.left.fetch_add(bytes, Ordering::SeqCst);
            return false;
        }
        self.0.drawn.fetch_add(bytes, Ordering::SeqCst);
        true
    }

    /// Returns bytes taken earlier, once they are no longer held.
    pub fn give_back(&self, bytes: usize) {
        self.0.left.fetch_add(bytes, Ordering::SeqCst);
        if let Some(server) = &self.0.server {
            server.fetch_add(bytes, Ordering::SeqCst);
        }
        self.0.drawn.fetch_sub(bytes, Ordering::SeqCst);
    }

    pub fn remaining(&self) -> usize {
        self.0.left.load(Ordering::SeqCst)
    }

    /// A reservation that grows as data arrives and is given back when dropped.
    pub fn charge(&self) -> Charge {
        Charge { budget: self.clone(), bytes: 0 }
    }
}

/// Bytes held while a response is read and parsed; given back on drop, also on failure.
#[derive(Debug)]
pub struct Charge {
    budget: ResponseBudget,
    bytes: usize,
}

impl Charge {
    /// Adds `bytes`; false when the budget has no room for them.
    pub fn add(&mut self, bytes: usize) -> bool {
        let ok = self.budget.take(bytes);
        if ok {
            self.bytes += bytes;
        }
        ok
    }
}

impl Drop for Charge {
    fn drop(&mut self) {
        self.budget.give_back(self.bytes);
    }
}

/// Bytes one `serde_json::Value` takes inline (in its column, array or map entry).
const VALUE_INLINE: usize = std::mem::size_of::<Value>();
/// Bytes a `String` takes inline, before its text on the heap.
const STRING_INLINE: usize = std::mem::size_of::<String>();
/// Bookkeeping per map entry (B-tree node share), beyond the key and the value.
const ENTRY_OVERHEAD: usize = 16;

/// Heap bytes of a string's text: its capacity, rounded up to the allocator's 16-byte steps.
fn heap(capacity: usize) -> usize {
    if capacity == 0 { 0 } else { capacity.div_ceil(16) * 16 }
}

/// The bytes a string's text holds while the answer is built: its heap capacity, at least its
/// JSON form with quotes and escapes, which the answer is written as.
fn text_size(s: &str, capacity: usize) -> usize {
    let escapes = s.bytes().filter(|b| matches!(b, b'"' | b'\\') || *b < 0x20).count() * 5;
    heap(capacity).max(s.len() + 2 + escapes)
}

/// The bytes an owned string holds: its inline part plus its text (as `text_size`).
pub fn string_size(s: &String) -> usize {
    STRING_INLINE + text_size(s, s.capacity())
}

/// The bytes a value holds in memory while the answer is built: the value itself (32 bytes for
/// every value, also a null or a number), the text of its strings, and for arrays and objects
/// their spare capacity, keys and entries. Not exact, but no longer far below the real heap use
/// for many small values or nested documents; the budget guards memory.
pub fn value_size(value: &Value) -> usize {
    VALUE_INLINE
        + match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => 0,
            Value::String(s) => text_size(s, s.capacity()),
            Value::Array(items) => {
                (items.capacity() - items.len()) * VALUE_INLINE + items.iter().map(value_size).sum::<usize>()
            }
            Value::Object(map) => map.iter().map(|(k, v)| string_size(k) + ENTRY_OVERHEAD + value_size(v)).sum(),
        }
}

/// The bytes a map of properties holds (graph nodes and edges).
pub fn map_size(map: &BTreeMap<String, Value>) -> usize {
    map.iter().map(|(k, v)| string_size(k) + ENTRY_OVERHEAD + value_size(v)).sum()
}

pub struct Column {
    pub name: String,
    /// Unknown until the first value that is not null, for engines with dynamic types.
    pub field_type: Option<FieldType>,
    pub labels: Option<BTreeMap<String, String>>,
    values: Vec<Value>,
}

impl Column {
    pub fn new(name: impl Into<String>, field_type: Option<FieldType>) -> Self {
        Self { name: name.into(), field_type, labels: None, values: Vec::new() }
    }

    /// Changes the column's type and converts the values read so far, for engines that type
    /// each value and reveal a wider column type only later (a decimal after whole numbers).
    pub fn retype(&mut self, field_type: FieldType, convert: impl Fn(&Value) -> Value) {
        self.field_type = Some(field_type);
        for value in &mut self.values {
            *value = convert(value);
        }
    }
}

pub struct FrameBuilder {
    columns: Vec<Column>,
    rows: usize,
    max_rows: usize,
    budget: ResponseBudget,
    truncated: bool,
    notices: Vec<Notice>,
    executed_query: Option<String>,
    fill: Option<Fill>,
}

impl FrameBuilder {
    pub fn new(columns: Vec<Column>, max_rows: usize, budget: ResponseBudget) -> Self {
        Self {
            columns,
            rows: 0,
            max_rows,
            budget,
            truncated: false,
            notices: Vec::new(),
            executed_query: None,
            fill: None,
        }
    }

    /// Fills the time buckets without a row when the frame is finished, as the query's
    /// `$__timeGroup(col, interval, fill)` asks (`sql::Prepared::fill`).
    pub fn fill_gaps(&mut self, fill: Option<Fill>) {
        self.fill = fill;
    }

    pub fn columns_mut(&mut self) -> &mut [Column] {
        &mut self.columns
    }

    pub fn executed_query(&mut self, sql: impl Into<String>) {
        self.executed_query = Some(sql.into());
    }

    /// Adds a notice once, however often it is reported.
    pub fn notice(&mut self, severity: NoticeSeverity, detail: Detail) {
        let params = (!detail.params.is_empty()).then_some(detail.params);
        if !self.notices.iter().any(|n| n.code == detail.reason && n.params == params) {
            self.notices.push(Notice { severity, code: detail.reason.to_string(), params, text: detail.message });
        }
    }

    pub fn is_full(&self) -> bool {
        self.truncated
    }

    /// Appends one row (one value per column). Returns false when a limit was reached; the row
    /// is then not added and the caller stops reading.
    pub fn push_row(&mut self, row: Vec<Value>) -> bool {
        debug_assert_eq!(row.len(), self.columns.len());
        if self.truncated {
            return false;
        }
        if self.rows >= self.max_rows {
            let message = format!("only the first {} rows are shown (row limit)", self.max_rows);
            self.truncate(Detail::new("frame.row_limit", message).with("rows", self.max_rows));
            return false;
        }
        let size: usize = row.iter().map(value_size).sum();
        if !self.budget.take(size) {
            self.truncate(Detail::new("frame.size_limit", "the result was cut off at the response size limit"));
            return false;
        }
        for (column, value) in self.columns.iter_mut().zip(row) {
            column.values.push(value);
        }
        self.rows += 1;
        true
    }

    /// Marks the frame cut off by a limit the source hit itself (while reading a file, say).
    pub fn mark_truncated(&mut self, notice: Detail) {
        self.truncate(notice);
    }

    fn truncate(&mut self, notice: Detail) {
        self.truncated = true;
        self.notice(NoticeSeverity::Warning, notice);
    }

    /// Adds a row for every bucket of the fill's range that has none, between the rows read. The
    /// time column is the one named `time`, else the first time column; its values must rise
    /// from row to row (one row per bucket, ordered by time), or nothing is added and a notice
    /// says why. A result cut by a limit is not filled.
    fn apply_fill(&mut self, fill: Fill) {
        if self.truncated || fill.step_ms <= 0 || fill.from > fill.to {
            return;
        }
        let is_time = |c: &Column| c.field_type == Some(FieldType::Time);
        let Some(t) = self
            .columns
            .iter()
            .position(|c| is_time(c) && c.name == "time")
            .or_else(|| self.columns.iter().position(is_time))
        else {
            self.notice(
                NoticeSeverity::Warning,
                Detail::new("frame.fill_no_time", "the gaps were not filled: the result has no time column"),
            );
            return;
        };
        let times: Option<Vec<i64>> = self.columns[t].values.iter().map(Value::as_i64).collect();
        let Some(times) = times.filter(|ts| ts.windows(2).all(|w| w[0] < w[1])) else {
            let name = self.columns[t].name.clone();
            let message = format!(
                "the gaps were not filled: {name} must hold one time per row, rising (ORDER BY {name}, one row per bucket)"
            );
            self.notice(NoticeSeverity::Warning, Detail::new("frame.fill_order", message).with("column", name));
            return;
        };
        // The number of buckets first, without overflow and before anything is allocated: a range of
        // years at a step of a second asks for far more rows than any result may hold.
        let too_many = |b: &mut Self| {
            let message = format!("the gaps were not filled: that would take more than {} rows", b.max_rows);
            b.notice(NoticeSeverity::Warning, Detail::new("frame.fill_row_limit", message).with("rows", b.max_rows));
        };
        let step = fill.step_ms;
        let first = fill.from.div_euclid(step).checked_mul(step);
        let buckets = first.and_then(|f| fill.to.checked_sub(f)).map(|span| span / step).and_then(|n| n.checked_add(1));
        let (Some(first), Some(buckets)) = (first, buckets) else {
            too_many(self);
            return;
        };
        if usize::try_from(buckets).map_or(true, |n| n > self.max_rows) {
            too_many(self);
            return;
        }
        let slots = || Slots { times: &times, row: 0, bucket: 0, buckets, first, step };
        let missing = slots().filter(|s| matches!(s, Slot::Gap(_))).count();
        if missing == 0 {
            return;
        }
        if self.rows.saturating_add(missing) > self.max_rows {
            too_many(self);
            return;
        }
        let types: Vec<Option<FieldType>> = self.columns.iter().map(|c| c.field_type).collect();
        let fixed = |field_type: Option<FieldType>, v: f64| match field_type {
            Some(FieldType::Number) => serde_json::Number::from_f64(v).map_or(Value::Null, Value::Number),
            Some(FieldType::Int64) if v.fract() == 0.0 && v.abs() < 9.0e18 => Value::String((v as i64).to_string()),
            Some(FieldType::Decimal) => Value::String(v.to_string()),
            _ => Value::Null,
        };
        // What the added rows hold, reserved before they are made. A filled row costs the same as
        // the row it copies (or a fixed size), so each size is worked out once, not per gap, and
        // counting stops once it is more than the budget has left.
        let left = self.budget.remaining();
        let row_size = |row: Option<usize>| -> usize {
            self.columns
                .iter()
                .enumerate()
                .map(|(c, column)| match (fill.mode, row) {
                    _ if c == t => VALUE_INLINE,
                    (FillMode::Previous, Some(i)) => value_size(&column.values[i]),
                    (FillMode::Value(v), _) => value_size(&fixed(types[c], v)),
                    _ => VALUE_INLINE,
                })
                .sum()
        };
        let mut added = 0_usize;
        let mut gap_size = row_size(None);
        let mut sized = true;
        let mut last_row = None;
        for slot in slots() {
            match slot {
                Slot::Row(i) => {
                    last_row = Some(i);
                    sized = !matches!(fill.mode, FillMode::Previous);
                }
                Slot::Gap(_) => {
                    if !sized {
                        gap_size = row_size(last_row);
                        sized = true;
                    }
                    added = added.saturating_add(gap_size);
                    if added > left {
                        break;
                    }
                }
            }
        }
        if added > left || !self.budget.take(added) {
            let message = "the gaps were not filled: the result would exceed the response size limit";
            self.notice(NoticeSeverity::Warning, Detail::new("frame.size_limit", message));
            return;
        }
        let rows = self.rows + missing;
        let mut read: Vec<std::vec::IntoIter<Value>> =
            self.columns.iter_mut().map(|c| std::mem::take(&mut c.values).into_iter()).collect();
        let mut merged: Vec<Vec<Value>> = self.columns.iter().map(|_| Vec::with_capacity(rows)).collect();
        for slot in (Slots { times: &times, row: 0, bucket: 0, buckets, first, step }) {
            for (c, values) in merged.iter_mut().enumerate() {
                let value = match slot {
                    Slot::Row(_) => read[c].next().unwrap_or(Value::Null),
                    Slot::Gap(at) if c == t => Value::from(at),
                    Slot::Gap(_) => match fill.mode {
                        FillMode::Null => Value::Null,
                        FillMode::Previous => values.last().cloned().unwrap_or(Value::Null),
                        FillMode::Value(v) => fixed(types[c], v),
                    },
                };
                values.push(value);
            }
        }
        for (column, values) in self.columns.iter_mut().zip(merged) {
            column.values = values;
        }
        self.rows = rows;
    }

    pub fn finish(mut self) -> Frame {
        if let Some(fill) = self.fill.take() {
            self.apply_fill(fill);
        }
        let fields = self
            .columns
            .into_iter()
            .map(|c| Field {
                name: c.name,
                field_type: c.field_type.unwrap_or(FieldType::String),
                unit: None,
                values: c.values,
                labels: c.labels,
            })
            .collect();
        let frame = Frame::new(fields).expect("every row adds one value to every column");
        frame.with_meta(FrameMeta {
            executed_query: self.executed_query,
            rows_truncated: self.truncated,
            notices: self.notices,
        })
    }
}

/// One row of a filled frame, in time order: a row read (its index) or a bucket without one.
#[derive(Clone, Copy, Debug)]
enum Slot {
    Row(usize),
    Gap(i64),
}

/// The rows read and the buckets `first`, `first + step`, ... (`buckets` of them) without a row,
/// merged by time, one at a time. `times` rise strictly.
struct Slots<'a> {
    times: &'a [i64],
    row: usize,
    bucket: i64,
    buckets: i64,
    first: i64,
    step: i64,
}

impl Iterator for Slots<'_> {
    type Item = Slot;

    fn next(&mut self) -> Option<Slot> {
        loop {
            // Within the range checked by the caller, so no bucket start overflows.
            let bucket = (self.bucket < self.buckets).then(|| self.first + self.bucket * self.step);
            match (self.times.get(self.row), bucket) {
                (None, None) => return None,
                (Some(&at), Some(b)) if b == at => self.bucket += 1,
                (Some(&at), Some(b)) if b < at => {
                    self.bucket += 1;
                    return Some(Slot::Gap(b));
                }
                (None, Some(b)) => {
                    self.bucket += 1;
                    return Some(Slot::Gap(b));
                }
                (Some(_), _) => {
                    self.row += 1;
                    return Some(Slot::Row(self.row - 1));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn charges_are_given_back_and_requests_return_their_bytes_to_the_server() {
        let server = Arc::new(AtomicUsize::new(150));
        let a = ResponseBudget::within(100, server.clone());
        let b = ResponseBudget::within(100, server.clone());
        {
            let mut charge = a.charge();
            assert!(charge.add(80));
            assert!(!charge.add(30), "over the request's budget");
            // The server pool limits requests together.
            assert!(!b.take(80));
            assert!(b.take(70));
        }
        assert_eq!(a.remaining(), 100, "the charge was given back");
        assert_eq!(server.load(Ordering::SeqCst), 80);
        drop(b);
        assert_eq!(server.load(Ordering::SeqCst), 150, "a finished request returns what it drew");
        let held = a.clone();
        assert!(held.take(10));
        drop(a);
        assert_eq!(server.load(Ordering::SeqCst), 140, "only the last handle returns the bytes");
        drop(held);
        assert_eq!(server.load(Ordering::SeqCst), 150);
    }

    #[test]
    fn row_limit_truncates_with_a_notice() {
        let mut b = FrameBuilder::new(vec![Column::new("a", Some(FieldType::Number))], 2, ResponseBudget::new(1 << 20));
        assert!(b.push_row(vec![json!(1)]));
        assert!(b.push_row(vec![json!(2)]));
        assert!(!b.push_row(vec![json!(3)]));
        let frame = b.finish();
        assert_eq!(frame.rows(), 2);
        let meta = frame.meta().unwrap();
        assert!(meta.rows_truncated);
        assert_eq!(meta.notices.len(), 1);
    }

    #[test]
    fn the_budget_is_shared() {
        let budget = ResponseBudget::new(200);
        let mut a = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        let mut b = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        assert!(a.push_row(vec![json!("x".repeat(100))]));
        assert!(!b.push_row(vec![json!("y".repeat(100))]));
        assert!(b.is_full(), "a builder stops at the first row that does not fit");
        let mut c = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        assert!(c.push_row(vec![json!("kurz")]));
        assert!(budget.remaining() < 200);
        let frame = a.finish();
        assert_eq!(frame.fields()[0].field_type, FieldType::String, "unknown types default to string");
        assert!(!frame.meta().unwrap().rows_truncated);
    }

    #[test]
    fn sizes_follow_the_memory_a_value_holds() {
        // Every value takes its inline 32 bytes, also nulls and numbers.
        assert_eq!(value_size(&Value::Null), 32);
        assert_eq!(value_size(&json!(1.5)), 32);
        // Large strings count their text, or their capacity where that is larger.
        let big = "x".repeat(4 << 20);
        assert!(value_size(&json!(big)) >= 4 << 20);
        let mut spare = String::with_capacity(8 << 20);
        spare.push('x');
        assert!(value_size(&Value::String(spare)) >= 8 << 20, "spare capacity is held memory too");
        // Escapes grow the JSON text the answer is written as.
        assert!(value_size(&json!("\"".repeat(1 << 20))) >= 6 << 20);
        // Documents count keys, entries and nested values.
        let doc = json!({ "name": "Müller", "tags": ["a", "b"], "nested": { "n": 1 } });
        let flat = doc.to_string().len();
        assert!(value_size(&doc) > 4 * flat, "{} vs {flat}", value_size(&doc));
    }

    #[test]
    fn large_strings_and_many_small_values_hit_the_budget() {
        // 16 MB of 1 MB strings: the sixteenth no longer fits next to the overhead.
        let budget = ResponseBudget::new(16 << 20);
        let mut b = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        let mut rows = 0;
        while b.push_row(vec![json!("x".repeat(1 << 20))]) {
            rows += 1;
        }
        assert_eq!(rows, 15);
        assert!(b.finish().meta().unwrap().rows_truncated);
        // A million nulls hold 32 MB, not the 5 MB their JSON text takes.
        let budget = ResponseBudget::new(16 << 20);
        let mut b = FrameBuilder::new(vec![Column::new("n", None)], 1_000_000, budget);
        let mut rows = 0;
        while b.push_row(vec![Value::Null]) {
            rows += 1;
        }
        assert_eq!(rows, (16 << 20) / 32);
    }

    fn filled(rows: &[(i64, Option<f64>)], mode: FillMode, max_rows: usize) -> Frame {
        let columns = vec![Column::new("time", Some(FieldType::Time)), Column::new("n", Some(FieldType::Number))];
        let mut b = FrameBuilder::new(columns, max_rows, ResponseBudget::new(1 << 20));
        for (t, n) in rows {
            assert!(b.push_row(vec![json!(t), n.map_or(Value::Null, |n| json!(n))]));
        }
        b.fill_gaps(Some(Fill { step_ms: 10, mode, from: 3, to: 45 }));
        b.finish()
    }

    fn values(frame: &Frame, field: usize) -> Value {
        serde_json::to_value(frame).unwrap()["fields"][field]["values"].clone()
    }

    #[test]
    fn fill_adds_the_missing_buckets_of_the_range() {
        let rows = [(10, Some(1.0)), (30, Some(3.0))];
        let f = filled(&rows, FillMode::Null, 100);
        // Buckets from the one holding 3 (0) to 40, the last one starting before 45.
        assert_eq!(values(&f, 0), json!([0, 10, 20, 30, 40]));
        assert_eq!(values(&f, 1), json!([null, 1.0, null, 3.0, null]));
        let f = filled(&rows, FillMode::Previous, 100);
        assert_eq!(values(&f, 1), json!([null, 1.0, 1.0, 3.0, 3.0]));
        let f = filled(&rows, FillMode::Value(0.0), 100);
        assert_eq!(values(&f, 1), json!([0.0, 1.0, 0.0, 3.0, 0.0]));
        assert!(f.meta().unwrap().notices.is_empty());

        // Unordered or repeated times, too many rows, no time column: nothing added, a notice.
        let f = filled(&[(30, Some(3.0)), (10, Some(1.0))], FillMode::Null, 100);
        assert_eq!(values(&f, 0), json!([30, 10]));
        assert_eq!(f.meta().unwrap().notices[0].code, "frame.fill_order");
        let f = filled(&rows, FillMode::Null, 4);
        assert_eq!(values(&f, 0), json!([10, 30]));
        assert_eq!(f.meta().unwrap().notices[0].code, "frame.fill_row_limit");
        let mut b =
            FrameBuilder::new(vec![Column::new("t", Some(FieldType::String))], 10, ResponseBudget::new(1 << 20));
        assert!(b.push_row(vec![json!("2026-01-01 00:00:00")]));
        b.fill_gaps(Some(Fill { step_ms: 10, mode: FillMode::Null, from: 0, to: 20 }));
        assert_eq!(b.finish().meta().unwrap().notices[0].code, "frame.fill_no_time");
    }

    #[test]
    fn fill_refuses_huge_and_overflowing_ranges_before_allocating() {
        let year = 365 * 86_400_000_i64;
        for (from, to, step) in [
            // Ten years at a step of one second: about 315 million buckets.
            (0, 10 * year, 1_000),
            // Ranges at the ends of the time axis, where `to - first` overflows.
            (i64::MIN, i64::MAX, 1_000),
            (i64::MIN + 1, 0, 1),
            (-1, i64::MAX, 3),
        ] {
            let columns = vec![Column::new("time", Some(FieldType::Time)), Column::new("n", Some(FieldType::Number))];
            let mut b = FrameBuilder::new(columns, 1_000_000, ResponseBudget::new(1 << 20));
            assert!(b.push_row(vec![json!(0), json!(1)]));
            b.fill_gaps(Some(Fill { step_ms: step, mode: FillMode::Previous, from, to }));
            let frame = b.finish();
            assert_eq!(frame.rows(), 1, "{from}..{to} by {step}");
            assert_eq!(frame.meta().unwrap().notices[0].code, "frame.fill_row_limit", "{from}..{to} by {step}");
        }
    }

    #[test]
    fn fill_stays_within_the_response_budget() {
        let columns = vec![Column::new("time", Some(FieldType::Time)), Column::new("s", Some(FieldType::String))];
        let budget = ResponseBudget::new(4096);
        let mut b = FrameBuilder::new(columns, 1000, budget.clone());
        assert!(b.push_row(vec![json!(0), json!("x".repeat(1000))]));
        b.fill_gaps(Some(Fill { step_ms: 10, mode: FillMode::Previous, from: 0, to: 100 }));
        let frame = b.finish();
        assert_eq!(frame.rows(), 1);
        assert_eq!(frame.meta().unwrap().notices[0].code, "frame.size_limit");
        assert!(!frame.meta().unwrap().rows_truncated, "the rows read are all there");
    }
}
