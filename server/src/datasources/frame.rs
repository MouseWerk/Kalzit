//! Builds result frames row by row within the limits: at most `max_rows` rows, and a response
//! size budget shared by all queries of one request. Hitting a limit stops reading and marks the
//! frame `rowsTruncated` with a notice instead of failing the query.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::Value;

use crate::shapes::{Field, FieldType, Frame, FrameMeta, Notice, NoticeSeverity};

/// Bytes left for the results of one request; queries running in parallel draw from it.
#[derive(Clone, Debug)]
pub struct ResponseBudget(Arc<AtomicUsize>);

impl ResponseBudget {
    pub fn new(max_bytes: usize) -> Self {
        Self(Arc::new(AtomicUsize::new(max_bytes)))
    }

    /// Reserves `bytes`; false (and nothing reserved) when not enough is left.
    pub fn take(&self, bytes: usize) -> bool {
        self.0.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| left.checked_sub(bytes)).is_ok()
    }

    pub fn remaining(&self) -> usize {
        self.0.load(Ordering::SeqCst)
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
    pub fn notice(&mut self, severity: NoticeSeverity, text: impl Into<String>) {
        let text = text.into();
        if !self.notices.iter().any(|n| n.text == text) {
            self.notices.push(Notice { severity, text });
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
            self.truncate(format!("only the first {} rows are shown (row limit)", self.max_rows));
            return false;
        }
        let size: usize = row.iter().map(json_size).sum::<usize>() + row.len();
        if !self.budget.take(size) {
            self.truncate("the result was cut off at the response size limit".to_string());
            return false;
        }
        for (column, value) in self.columns.iter_mut().zip(row) {
            column.values.push(value);
        }
        self.rows += 1;
        true
    }

    fn truncate(&mut self, notice: String) {
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
