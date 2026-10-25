//! Builds result frames row by row within the limits: at most `max_rows` rows, and a response
//! size budget shared by all queries of one request. Hitting a limit stops reading and marks the
//! frame `rowsTruncated` with a notice instead of failing the query.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

use super::detail::Detail;
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

/// Roughly the bytes a value adds to the JSON answer. Cheap and slightly generous; the budget
/// guards memory, not an exact byte count.
pub fn json_size(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 24,
        Value::String(s) => s.len() + 2 + s.bytes().filter(|b| matches!(b, b'"' | b'\\') || *b < 0x20).count() * 5,
        Value::Array(_) | Value::Object(_) => value.to_string().len(),
    }
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
}

impl FrameBuilder {
    pub fn new(columns: Vec<Column>, max_rows: usize, budget: ResponseBudget) -> Self {
        Self { columns, rows: 0, max_rows, budget, truncated: false, notices: Vec::new(), executed_query: None }
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
        let size: usize = row.iter().map(json_size).sum::<usize>() + row.len();
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

    pub fn finish(self) -> Frame {
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
        let budget = ResponseBudget::new(100);
        let mut a = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        let mut b = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        assert!(a.push_row(vec![json!("x".repeat(60))]));
        assert!(!b.push_row(vec![json!("y".repeat(60))]));
        assert!(b.is_full(), "a builder stops at the first row that does not fit");
        let mut c = FrameBuilder::new(vec![Column::new("s", None)], 1000, budget.clone());
        assert!(c.push_row(vec![json!("kurz")]));
        assert!(budget.remaining() < 100);
        let frame = a.finish();
        assert_eq!(frame.fields()[0].field_type, FieldType::String, "unknown types default to string");
        assert!(!frame.meta().unwrap().rows_truncated);
    }
}
