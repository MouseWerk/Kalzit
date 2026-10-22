//! `documents` results from JSON (Elasticsearch hits, JSON and NDJSON files, HTTP JSON): a
//! builder that keeps the document and response size limits, notes why a result was cut, and
//! samples the schema (docs/api/datasources.md, "The documents shape").

use serde_json::Value;

use super::detail::Detail;
use super::document_schema::{SAMPLE_DOCUMENTS, SchemaSampler};
use super::frame::{ResponseBudget, json_size};
use crate::shapes::{DocumentSet, Notice, NoticeSeverity, OrderedJson, Truncated};

/// Collects documents up to `max` and the response budget. The first document that does not fit
/// ends the result, which is then marked truncated with a notice saying which limit cut it.
pub struct DocumentsBuilder {
    docs: Vec<OrderedJson>,
    sampler: SchemaSampler,
    max: usize,
    budget: ResponseBudget,
    truncated: bool,
    notices: Vec<Notice>,
    executed_query: Option<String>,
}

impl DocumentsBuilder {
    pub fn new(max: usize, budget: ResponseBudget) -> Self {
        Self {
            docs: Vec::new(),
            sampler: SchemaSampler::default(),
            max: max.max(1),
            budget,
            truncated: false,
            notices: Vec::new(),
            executed_query: None,
        }
    }

    /// Adds a document; false (and nothing added) when a limit was reached.
    pub fn push(&mut self, doc: Value) -> bool {
        if self.truncated {
            return false;
        }
        if self.docs.len() >= self.max {
            let message = format!("only the first {} documents are shown (document limit)", self.max);
            self.cut(Detail::new("documents.limit", message).with("limit", self.max));
            return false;
        }
        if !self.budget.take(json_size(&doc) + 1) {
            self.mark_truncated();
            return false;
        }
        if self.sampler.len() < SAMPLE_DOCUMENTS {
            self.sampler.add(&doc);
        }
        self.docs.push(doc.into());
        true
    }

    /// Marks the result cut off at the response size limit by the source itself (a line too
    /// long for the budget, say).
    pub fn mark_truncated(&mut self) {
        if !self.truncated {
            self.cut(Detail::new("documents.size_limit", "the result was cut off at the response size limit"));
        }
    }

    fn cut(&mut self, detail: Detail) {
        self.truncated = true;
        self.notice(NoticeSeverity::Warning, detail);
    }

    /// Adds a notice once, however often it is reported.
    pub fn notice(&mut self, severity: NoticeSeverity, detail: Detail) {
        let notice = detail.notice(severity);
        if !self.notices.contains(&notice) {
            self.notices.push(notice);
        }
    }

    pub fn executed_query(&mut self, query: impl Into<String>) {
        self.executed_query = Some(query.into());
    }

    pub fn is_full(&self) -> bool {
        self.truncated
    }

    pub fn len(&self) -> usize {
        self.docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// The documents with their schema. `truncated.limit` is the number of documents kept.
    pub fn finish(self) -> DocumentSet {
        let truncated = self.truncated.then(|| Truncated { limit: u32::try_from(self.docs.len()).unwrap_or(u32::MAX) });
        DocumentSet {
            documents: self.docs,
            schema: self.sampler.finish(),
            next_cursor: None,
            truncated,
            notices: self.notices,
            executed_query: self.executed_query,
        }
    }
}

/// A connection for the unit tests of the JSON-based kinds.
#[cfg(test)]
pub(crate) async fn test_connection(
    settings: Value,
    secrets: &[(&str, &str)],
    policy: super::targets::TargetPolicy,
) -> super::Connection {
    let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
    let secrets = secrets.iter().map(|(k, v)| (k.to_string(), zeroize::Zeroizing::new(v.to_string()))).collect();
    super::Connection::new(
        "ds",
        settings,
        secrets,
        std::sync::Arc::new(policy),
        std::sync::Arc::new(super::OwnDatabase::new(db, "sqlite::memory:")),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn documents_keep_to_the_count_and_the_budget() {
        let mut b = DocumentsBuilder::new(2, ResponseBudget::new(1 << 20));
        assert!(b.push(json!({ "a": 1 })));
        assert!(b.push(json!({ "a": 2 })));
        assert!(!b.push(json!({ "a": 3 })));
        let set = b.finish();
        assert_eq!(set.documents.len(), 2);
        assert_eq!(set.truncated, Some(Truncated { limit: 2 }));
        assert_eq!(set.notices.len(), 1);
        assert_eq!(set.notices[0].code, "documents.limit");
        assert_eq!(set.notices[0].params.as_ref().unwrap()["limit"], "2");
        assert_eq!(set.schema[0].path, "a");

        let mut b = DocumentsBuilder::new(100, ResponseBudget::new(30));
        assert!(b.push(json!({ "a": "x" })));
        assert!(!b.push(json!({ "a": "y".repeat(40) })));
        assert!(b.is_full());
        b.mark_truncated();
        let set = b.finish();
        assert_eq!(set.truncated, Some(Truncated { limit: 1 }));
        assert_eq!(set.notices.iter().map(|n| n.code.as_str()).collect::<Vec<_>>(), ["documents.size_limit"]);

        let untouched = DocumentsBuilder::new(10, ResponseBudget::new(1 << 20)).finish();
        assert_eq!(untouched.truncated, None);
        assert!(untouched.notices.is_empty());
    }
}
