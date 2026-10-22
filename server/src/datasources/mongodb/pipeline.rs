//! MongoDB queries: parsing the Extended JSON the editor sends (key order kept), binding variables
//! and macros as typed BSON values, and the read-only check (docs/api/datasources.md, "MongoDB").
//!
//! The check runs on the bound BSON, exactly what is sent:
//! - every stage, also in `$lookup`, `$unionWith` and `$facet` pipelines, must be on the list of
//!   reading stages; `$out` and `$merge` are writes;
//! - `$where`, `$function` and `$accumulator` (server-side JavaScript) and `$out`/`$merge` are
//!   refused as keys at any depth, in any letter case;
//! - JavaScript code values are refused;
//! - operator keys with invisible characters, spaces or look-alike letters are refused, since they
//!   only serve to hide an operator from a check like this one;
//! - collections must be plain names in the source's database, not `system.*`.

use std::collections::BTreeMap;

use bson::{Bson, Document};
use serde_json::Value;

use crate::datasources::SourceError;
use crate::shapes::TimeRange;

/// Stages that only read. Everything else, including stages added in future server versions, is
/// refused until it is reviewed.
const READING_STAGES: &[&str] = &[
    "$addFields",
    "$bucket",
    "$bucketAuto",
    "$count",
    "$densify",
    "$facet",
    "$fill",
    "$geoNear",
    "$graphLookup",
    "$group",
    "$limit",
    "$lookup",
    "$match",
    "$project",
    "$redact",
    "$replaceRoot",
    "$replaceWith",
    "$sample",
    "$search",
    "$searchMeta",
    "$set",
    "$setWindowFields",
    "$skip",
    "$sort",
    "$sortByCount",
    "$unionWith",
    "$unset",
    "$unwind",
    "$vectorSearch",
];

/// Stages that write.
const WRITE_STAGES: &[&str] = &["$out", "$merge"];

/// Keys refused at any depth (compared in lower case): server-side JavaScript and the write stages.
const FORBIDDEN_KEYS: &[&str] = &["$where", "$function", "$accumulator", "$out", "$merge"];

/// Whether a value is read as a query (filters, `$match`: values are literal) or as an
/// aggregation expression (a string starting with `$` is a field path there, so a variable's value
/// is wrapped in `$literal`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ctx {
    Raw,
    Expr,
}

fn reject(reason: &'static str, message: impl Into<String>) -> SourceError {
    SourceError::rejected(reason, message)
}

/// The query's values for macros and variables.
pub struct Binder<'a> {
    pub range: TimeRange,
    pub interval_ms: u64,
    pub variables: &'a BTreeMap<String, Value>,
}

/// Extended JSON text (canonical or relaxed) as BSON, with the key order as written.
pub fn parse(field: &'static str, text: &str) -> Result<Bson, SourceError> {
    serde_json::from_str::<Bson>(text).map_err(|e| {
        reject("mongodb.json_invalid", format!("{field} is not valid Extended JSON: {e}"))
            .with("field", field)
            .with("detail", e)
    })
}

/// A JSON document field (`filter`, `projection`, `sort`); empty text is no document.
pub fn parse_document(field: &'static str, text: Option<&str>) -> Result<Option<Document>, SourceError> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else { return Ok(None) };
    match parse(field, text)? {
        Bson::Document(d) => Ok(Some(d)),
        _ => Err(reject("mongodb.not_a_document", format!("{field} must be a JSON object")).with("field", field)),
    }
}

/// A collection the query may read: a plain name, not a system collection.
pub fn check_collection(name: &str) -> Result<(), SourceError> {
    let bad = name.trim().is_empty() || name.len() > 255 || name.contains('\0') || name.contains('$');
    if bad {
        return Err(
            reject("mongodb.collection_invalid", format!("{name:?} is not a collection name")).with("name", name)
        );
    }
    if name.starts_with("system.") {
        return Err(reject("mongodb.system_collection", format!("{name} is a system collection")).with("name", name));
    }
    Ok(())
}

impl Binder<'_> {
    /// A pipeline: bound and checked.
    pub fn pipeline(&self, text: &str) -> Result<Vec<Document>, SourceError> {
        let Bson::Array(stages) = parse("pipeline", text)? else {
            return Err(reject("mongodb.pipeline_not_array", "the pipeline must be a JSON array of stages"));
        };
        let stages = self.stages(stages)?;
        for stage in &stages {
            scan_doc(stage)?;
        }
        Ok(stages)
    }

    /// A `find` filter (a query) or sort, bound and checked.
    pub fn query_document(&self, doc: Document) -> Result<Document, SourceError> {
        let doc = self.doc(doc, Ctx::Raw)?;
        scan_doc(&doc)?;
        Ok(doc)
    }

    /// A `find` projection (which may hold expressions), bound and checked.
    pub fn projection(&self, doc: Document) -> Result<Document, SourceError> {
        let doc = self.doc(doc, Ctx::Expr)?;
        scan_doc(&doc)?;
        Ok(doc)
    }

    fn stages(&self, stages: Vec<Bson>) -> Result<Vec<Document>, SourceError> {
        stages.into_iter().map(|s| self.stage(s)).collect()
    }

    fn stage(&self, stage: Bson) -> Result<Document, SourceError> {
        let Bson::Document(doc) = stage else {
            return Err(reject("mongodb.stage_invalid", "every stage must be an object with one stage name"));
        };
        if doc.len() != 1 {
            return Err(reject("mongodb.stage_invalid", "every stage must be an object with one stage name"));
        }
        let (name, body) = doc.into_iter().next().expect("one entry");
        if WRITE_STAGES.contains(&name.as_str()) {
            return Err(reject("mongodb.write_stage", format!("{name} writes data")).with("stage", &name));
        }
        check_key(&name)?;
        if !READING_STAGES.contains(&name.as_str()) {
            return Err(
                reject("mongodb.stage_not_allowed", format!("the stage {name} is not allowed")).with("stage", &name)
            );
        }
        let body = match name.as_str() {
            "$match" | "$limit" | "$skip" | "$sort" | "$count" | "$sample" | "$unwind" | "$unset" | "$search"
            | "$searchMeta" | "$vectorSearch" | "$geoNear" => self.value(body, Ctx::Raw)?,
            "$lookup" => self.lookup(body)?,
            "$unionWith" => self.union_with(body)?,
            "$facet" => self.facet(body)?,
            "$graphLookup" => self.graph_lookup(body)?,
            _ => self.value(body, Ctx::Expr)?,
        };
        let mut out = Document::new();
        out.insert(name, body);
        Ok(out)
    }

    fn lookup(&self, body: Bson) -> Result<Bson, SourceError> {
        let Bson::Document(doc) = body else { return self.value(body, Ctx::Raw) };
        let mut out = Document::new();
        for (k, v) in doc {
            let v = match k.as_str() {
                "from" => {
                    foreign_collection(&v)?;
                    v
                }
                "pipeline" => self.nested_pipeline(v)?,
                "let" => self.value(v, Ctx::Expr)?,
                _ => self.value(v, Ctx::Raw)?,
            };
            out.insert(k, v);
        }
        Ok(Bson::Document(out))
    }

    fn union_with(&self, body: Bson) -> Result<Bson, SourceError> {
        match body {
            Bson::String(_) => {
                foreign_collection(&body)?;
                Ok(body)
            }
            Bson::Document(doc) => {
                let mut out = Document::new();
                for (k, v) in doc {
                    let v = match k.as_str() {
                        "coll" => {
                            foreign_collection(&v)?;
                            v
                        }
                        "pipeline" => self.nested_pipeline(v)?,
                        _ => self.value(v, Ctx::Raw)?,
                    };
                    out.insert(k, v);
                }
                Ok(Bson::Document(out))
            }
            other => self.value(other, Ctx::Raw),
        }
    }

    fn facet(&self, body: Bson) -> Result<Bson, SourceError> {
        let Bson::Document(doc) = body else { return self.value(body, Ctx::Raw) };
        let mut out = Document::new();
        for (k, v) in doc {
            check_key(&k)?;
            out.insert(k, self.nested_pipeline(v)?);
        }
        Ok(Bson::Document(out))
    }

    fn graph_lookup(&self, body: Bson) -> Result<Bson, SourceError> {
        let Bson::Document(doc) = body else { return self.value(body, Ctx::Raw) };
        let mut out = Document::new();
        for (k, v) in doc {
            let v = match k.as_str() {
                "from" => {
                    foreign_collection(&v)?;
                    v
                }
                "restrictSearchWithMatch" => self.value(v, Ctx::Raw)?,
                _ => self.value(v, Ctx::Expr)?,
            };
            out.insert(k, v);
        }
        Ok(Bson::Document(out))
    }

    fn nested_pipeline(&self, v: Bson) -> Result<Bson, SourceError> {
        match v {
            Bson::Array(stages) => Ok(Bson::Array(self.stages(stages)?.into_iter().map(Bson::Document).collect())),
            _ => Err(reject("mongodb.pipeline_not_array", "a nested pipeline must be a JSON array of stages")),
        }
    }

    fn value(&self, v: Bson, ctx: Ctx) -> Result<Bson, SourceError> {
        match v {
            Bson::String(s) => self.string(s, ctx),
            Bson::Array(items) => {
                Ok(Bson::Array(items.into_iter().map(|i| self.value(i, ctx)).collect::<Result<_, _>>()?))
            }
            Bson::Document(doc) => Ok(Bson::Document(self.doc(doc, ctx)?)),
            other => Ok(other),
        }
    }

    fn doc(&self, doc: Document, ctx: Ctx) -> Result<Document, SourceError> {
        let mut out = Document::new();
        let keys: Vec<String> = doc.keys().cloned().collect();
        for (k, v) in doc {
            if k.contains("${") {
                return Err(reject("mongodb.variable_in_key", "variables can only stand for values, not for keys"));
            }
            if k == "$__timeFilter" {
                if ctx != Ctx::Raw {
                    return Err(reject(
                        "mongodb.time_filter_context",
                        "$__timeFilter works in $match and filters; in expressions compare with $__timeFrom and $__timeTo",
                    ));
                }
                let field = match &v {
                    Bson::String(f) if !f.trim().is_empty() && !f.starts_with('$') => f.clone(),
                    _ => {
                        return Err(reject(
                            "mongodb.time_filter_field",
                            "$__timeFilter needs the name of a date field, as in {\"$__timeFilter\": \"ts\"}",
                        ));
                    }
                };
                if keys.contains(&field) || out.contains_key(&field) {
                    return Err(reject(
                        "mongodb.time_filter_conflict",
                        format!("{field} is filtered twice; combine the conditions with $and"),
                    )
                    .with("field", &field));
                }
                let mut range = Document::new();
                range.insert("$gte", self.time(self.range.from)?);
                range.insert("$lte", self.time(self.range.to)?);
                out.insert(field, range);
                continue;
            }
            if k.starts_with("$__") {
                return Err(reject("mongodb.macro_unknown", format!("{k} is not a macro")).with("name", &k));
            }
            let child = match (ctx, k.as_str()) {
                (Ctx::Raw, "$expr") => Ctx::Expr,
                (Ctx::Expr, "$literal") => Ctx::Raw,
                _ => ctx,
            };
            let v = self.value(v, child)?;
            out.insert(k, v);
        }
        Ok(out)
    }

    fn time(&self, ms: i64) -> Result<Bson, SourceError> {
        crate::datasources::bind_time(ms)?;
        Ok(Bson::DateTime(bson::DateTime::from_millis(ms)))
    }

    fn string(&self, s: String, ctx: Ctx) -> Result<Bson, SourceError> {
        if let Some(name) = s.strip_prefix("$__") {
            return match name {
                "timeFrom" => self.time(self.range.from),
                "timeTo" => self.time(self.range.to),
                "interval_ms" => Ok(Bson::Int64(self.interval_ms.min(i64::MAX as u64) as i64)),
                _ => Err(reject("mongodb.macro_unknown", format!("{s} is not a macro")).with("name", &s)),
            };
        }
        if let Some(name) = s.strip_prefix("${").and_then(|r| r.strip_suffix('}')) {
            if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                return Err(reject("mongodb.variable_name_invalid", format!("{name:?} is not a variable name"))
                    .with("name", name));
            }
            let Some(value) = self.variables.get(name) else {
                return Err(
                    reject("mongodb.variable_missing", format!("the variable {name} has no value")).with("name", name)
                );
            };
            let bound = variable_value(name, value)?;
            return Ok(match ctx {
                Ctx::Raw => bound,
                // In an expression a string such as "$price" would read a field; $literal keeps
                // the value a value.
                Ctx::Expr => {
                    let mut lit = Document::new();
                    lit.insert("$literal", bound);
                    Bson::Document(lit)
                }
            });
        }
        if s.contains("${") {
            return Err(reject(
                "mongodb.variable_in_text",
                "a variable must be the whole value (\"${name}\"); it is never spliced into text",
            ));
        }
        Ok(Bson::String(s))
    }
}

/// A variable's value as a typed BSON value: text, number, boolean, or a list of those.
fn variable_value(name: &str, value: &Value) -> Result<Bson, SourceError> {
    let scalar = |v: &Value| -> Option<Bson> {
        match v {
            Value::String(s) => Some(Bson::String(s.clone())),
            Value::Bool(b) => Some(Bson::Boolean(*b)),
            Value::Number(n) => n.as_i64().map(Bson::Int64).or_else(|| n.as_f64().map(Bson::Double)),
            _ => None,
        }
    };
    let bad = || {
        reject(
            "mongodb.variable_type",
            format!("the variable {name} must be text, a number, a boolean or a list of them"),
        )
        .with("name", name)
    };
    match value {
        Value::Array(items) => {
            Ok(Bson::Array(items.iter().map(|i| scalar(i).ok_or_else(bad)).collect::<Result<_, _>>()?))
        }
        other => scalar(other).ok_or_else(bad),
    }
}

/// `from`, `coll`: a collection of the same database.
fn foreign_collection(v: &Bson) -> Result<(), SourceError> {
    match v {
        Bson::String(name) => check_collection(name),
        _ => Err(reject(
            "mongodb.collection_invalid",
            "a collection must be named as text; other databases cannot be read",
        )
        .with("name", v.to_string())),
    }
}

/// Characters that do not show (controls, format characters, spaces).
fn invisible(c: char) -> bool {
    c.is_control()
        || c.is_whitespace()
        || matches!(c,
            '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}' | '\u{1160}' | '\u{17B4}' | '\u{17B5}'
            | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{206F}' | '\u{3164}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}'
            | '\u{FFF0}'..='\u{FFF8}' | '\u{E0000}'..='\u{E0FFF}')
}

/// The key with invisible characters removed and look-alike dollars and full-width letters mapped
/// to ASCII; `true` when anything changed.
fn normalize(key: &str) -> (String, bool) {
    let mut out = String::with_capacity(key.len());
    let mut changed = false;
    for c in key.chars() {
        let mapped = match c {
            c if invisible(c) => None,
            '\u{FF04}' | '\u{FE69}' => Some('$'),
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0),
            c => Some(c),
        };
        match mapped {
            Some(m) if m == c => out.push(m),
            Some(m) => {
                changed = true;
                out.push(m);
            }
            None => changed = true,
        }
    }
    (out, changed)
}

/// Text for a key in a message, with characters that do not show written as `\u{...}`.
fn visible(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_graphic() { c.to_string() } else { format!("\\u{{{:x}}}", c as u32) }).collect()
}

fn check_key(key: &str) -> Result<(), SourceError> {
    let (norm, changed) = normalize(key);
    if !norm.starts_with('$') {
        return Ok(());
    }
    if changed || !norm.is_ascii() {
        let shown = visible(key);
        return Err(reject(
            "mongodb.key_obfuscated",
            format!("the key {shown} looks like an operator written with hidden or look-alike characters"),
        )
        .with("key", shown));
    }
    let lower = norm.to_ascii_lowercase();
    if let Some(op) = FORBIDDEN_KEYS.iter().find(|f| **f == lower) {
        return Err(reject("mongodb.operator_not_allowed", format!("{norm} is not allowed")).with("operator", *op));
    }
    Ok(())
}

fn scan_doc(doc: &Document) -> Result<(), SourceError> {
    for (k, v) in doc {
        check_key(k)?;
        scan(v)?;
    }
    Ok(())
}

fn scan(v: &Bson) -> Result<(), SourceError> {
    match v {
        Bson::Document(d) => scan_doc(d),
        Bson::Array(items) => items.iter().try_for_each(scan),
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => {
            Err(reject("mongodb.javascript", "JavaScript code is not allowed in a query"))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binder(vars: &BTreeMap<String, Value>) -> Binder<'_> {
        Binder {
            range: TimeRange { from: 1_700_000_000_000, to: 1_800_000_000_000 },
            interval_ms: 30_000,
            variables: vars,
        }
    }

    fn reason(text: &str) -> &'static str {
        let vars = BTreeMap::new();
        match binder(&vars).pipeline(text) {
            Ok(p) => panic!("accepted: {p:?}"),
            Err(e) => e.detail().reason,
        }
    }

    fn ok(text: &str) -> Vec<Document> {
        let vars: BTreeMap<String, Value> = [
            ("land".to_string(), json!("Österreich")),
            ("ids".to_string(), json!([1, 2])),
            ("feld".to_string(), json!("$preis")),
        ]
        .into();
        binder(&vars).pipeline(text).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    /// Wraps `inner` (a stage) at every place a pipeline can nest.
    fn nestings(inner: &str) -> Vec<String> {
        vec![
            format!("[{inner}]"),
            format!(r#"[{{"$match": {{}}}}, {inner}]"#),
            format!(r#"[{{"$lookup": {{"from": "b", "as": "x", "pipeline": [{inner}]}}}}]"#),
            format!(r#"[{{"$unionWith": {{"coll": "b", "pipeline": [{inner}]}}}}]"#),
            format!(r#"[{{"$facet": {{"a": [{inner}]}}}}]"#),
            format!(
                r#"[{{"$facet": {{"a": [{{"$lookup": {{"from": "b", "as": "x", "pipeline": [{{"$unionWith": {{"coll": "c", "pipeline": [{inner}]}}}}]}}}}]}}}}]"#
            ),
        ]
    }

    #[test]
    fn write_stages_are_refused_at_any_depth() {
        for stage in
            [r#"{"$out": "kopie"}"#, r#"{"$merge": {"into": "kopie"}}"#, r#"{"$out": {"db": "x", "coll": "y"}}"#]
        {
            for p in nestings(stage) {
                assert_eq!(reason(&p), "mongodb.write_stage", "{p}");
            }
        }
    }

    #[test]
    fn stages_outside_the_reading_list_are_refused_at_any_depth() {
        for stage in [
            r#"{"$currentOp": {}}"#,
            r#"{"$listSessions": {}}"#,
            r#"{"$collStats": {"count": {}}}"#,
            r#"{"$indexStats": {}}"#,
            r#"{"$planCacheStats": {}}"#,
            r#"{"$changeStream": {}}"#,
            r#"{"$documents": [{"a": 1}]}"#,
            r#"{"$rankFusion": {"input": {"pipelines": {"a": [{"$out": "x"}]}}}}"#,
            r#"{"$Match": {}}"#,
            r#"{"match": {}}"#,
        ] {
            for p in nestings(stage) {
                assert_eq!(reason(&p), "mongodb.stage_not_allowed", "{p}");
            }
        }
        assert_eq!(reason(r#"[{"$match": {}, "$limit": 1}]"#), "mongodb.stage_invalid");
        assert_eq!(reason(r#"[{}]"#), "mongodb.stage_invalid");
        assert_eq!(reason(r#"["$match"]"#), "mongodb.stage_invalid");
        assert_eq!(reason(r#"{"$match": {}}"#), "mongodb.pipeline_not_array");
        assert_eq!(
            reason(r#"[{"$lookup": {"from": "b", "as": "x", "pipeline": {"$match": {}}}}]"#),
            "mongodb.pipeline_not_array"
        );
        assert_eq!(reason(r#"[{"$match": "#), "mongodb.json_invalid");
    }

    #[test]
    fn javascript_operators_are_refused_at_any_depth_and_in_any_case() {
        let ops = [
            r#"{"$match": {"$where": "this.a > 1"}}"#,
            r#"{"$match": {"$expr": {"$function": {"body": "function() { return true }", "args": [], "lang": "js"}}}}"#,
            r#"{"$match": {"$and": [{"a": 1}, {"$expr": {"$eq": [{"$function": {"body": "x", "args": [], "lang": "js"}}, 1]}}]}}"#,
            r#"{"$group": {"_id": null, "x": {"$accumulator": {"init": "function() {}", "accumulate": "f", "accumulateArgs": [], "merge": "f", "lang": "js"}}}}"#,
            r#"{"$project": {"x": {"$cond": [true, {"$function": {"body": "x", "args": [], "lang": "js"}}, 0]}}}"#,
            r#"{"$addFields": {"deep": {"a": {"b": {"c": [{"d": {"$function": {}}}]}}}}}"#,
            r#"{"$match": {"$WHERE": "1"}}"#,
            r#"{"$project": {"x": {"$Function": {}}}}"#,
            r#"{"$group": {"_id": null, "x": {"$ACCUMULATOR": {}}}}"#,
            r#"{"$project": {"$merge": 1}}"#,
            r#"{"$setWindowFields": {"output": {"x": {"$Out": 1}}}}"#,
        ];
        for op in ops {
            for p in nestings(op) {
                assert_eq!(reason(&p), "mongodb.operator_not_allowed", "{p}");
            }
        }
        // $expr with $function also in a find filter.
        let vars = BTreeMap::new();
        let filter =
            parse_document("filter", Some(r#"{"$expr": {"$function": {"body": "x", "args": [], "lang": "js"}}}"#))
                .unwrap()
                .unwrap();
        assert_eq!(binder(&vars).query_document(filter).unwrap_err().detail().reason, "mongodb.operator_not_allowed");
        let projection = parse_document("projection", Some(r#"{"x": {"$function": {}}}"#)).unwrap().unwrap();
        assert_eq!(binder(&vars).projection(projection).unwrap_err().detail().reason, "mongodb.operator_not_allowed");
    }

    #[test]
    fn javascript_code_values_are_refused() {
        for p in nestings(r#"{"$match": {"a": {"$code": "function() { return 1 }"}}}"#) {
            assert_eq!(reason(&p), "mongodb.javascript", "{p}");
        }
        for p in nestings(r#"{"$project": {"a": {"$literal": {"$code": "x", "$scope": {}}}}}"#) {
            assert_eq!(reason(&p), "mongodb.javascript", "{p}");
        }
    }

    #[test]
    fn hidden_and_look_alike_characters_in_operator_keys_are_refused() {
        let keys = [
            "$wh\u{200B}ere",      // zero-width space
            "\u{200B}$where",      // before the dollar
            "\u{FEFF}$function",   // byte order mark
            "$func\u{00AD}tion",   // soft hyphen
            "\u{FF04}where",       // full-width dollar
            "\u{FE69}where",       // small dollar
            "$\u{FF57}here",       // full-width w
            " $where",             // a space
            "$where\u{0000}",      // NUL
            "$wh\u{202E}ere",      // right-to-left override
            "$wh\u{E0041}ere",     // tag character
            "$wher\u{0435}",       // Cyrillic e
            "$\u{0391}ccumulator", // Greek capital alpha
        ];
        for key in keys {
            let mut filter = serde_json::Map::new();
            filter.insert(key.to_string(), json!("this.a"));
            let stage = serde_json::to_string(&json!({ "$match": filter })).unwrap();
            for p in nestings(&stage) {
                assert_eq!(reason(&p), "mongodb.key_obfuscated", "{key:?} in {p}");
            }
        }
        // The same characters in plain field names are data, not operators.
        ok("[{\"$match\": {\"Straße\u{200B}name\": 1, \"full name\": 2, \"naïve\": 3}}]");
        // A stage name written that way is refused too.
        assert_eq!(reason(r#"[{"＄out": "x"}]"#), "mongodb.key_obfuscated");
        assert_eq!(reason(r#"[{"$OUT": "x"}]"#), "mongodb.operator_not_allowed");
    }

    #[test]
    fn collections_stay_in_the_database() {
        assert_eq!(
            reason(r#"[{"$lookup": {"from": "system.users", "as": "x", "localField": "a", "foreignField": "b"}}]"#),
            "mongodb.system_collection"
        );
        assert_eq!(
            reason(r#"[{"$lookup": {"from": {"db": "admin", "coll": "x"}, "as": "x", "pipeline": []}}]"#),
            "mongodb.collection_invalid"
        );
        assert_eq!(reason(r#"[{"$unionWith": "system.profile"}]"#), "mongodb.system_collection");
        assert_eq!(reason(r#"[{"$unionWith": {"coll": "a$b"}}]"#), "mongodb.collection_invalid");
        assert_eq!(
            reason(
                r#"[{"$graphLookup": {"from": "system.js", "startWith": "$a", "connectFromField": "a", "connectToField": "b", "as": "c"}}]"#
            ),
            "mongodb.system_collection"
        );
        assert!(check_collection("bestellungen").is_ok());
        assert!(check_collection("system.views").is_err());
        assert!(check_collection("").is_err());
    }

    #[test]
    fn reading_pipelines_pass_with_their_order_kept() {
        let p = ok(r#"[{"$match": {"status": "bezahlt", "_id": {"$oid": "65f0c1a2b3c4d5e6f7a8b9c0"}}},
                {"$lookup": {"from": "kunden", "localField": "k", "foreignField": "_id", "as": "kunde"}},
                {"$facet": {"a": [{"$count": "n"}], "b": [{"$sortByCount": "$land"}]}},
                {"$sort": {"zeit": -1, "betrag": 1, "aaa": 1}}]"#);
        assert_eq!(p.len(), 4);
        assert!(matches!(p[0].get_document("$match").unwrap().get("_id"), Some(Bson::ObjectId(_))));
        let sort: Vec<&String> = p[3].get_document("$sort").unwrap().keys().collect();
        assert_eq!(sort, ["zeit", "betrag", "aaa"], "the key order is what $sort means");
    }

    #[test]
    fn variables_and_macros_are_typed_values() {
        let p = ok(r#"[{"$match": {"land": "${land}", "id": {"$in": "${ids}"}, "$__timeFilter": "ts",
                            "$expr": {"$eq": ["$feld", "${feld}"]}}},
                {"$project": {"x": "${feld}", "von": "$__timeFrom", "schritt": "$__interval_ms"}}]"#);
        let m = p[0].get_document("$match").unwrap();
        assert_eq!(m.get("land"), Some(&Bson::String("Österreich".into())));
        assert_eq!(m.get_document("id").unwrap().get("$in"), Some(&Bson::Array(vec![Bson::Int64(1), Bson::Int64(2)])));
        let ts = m.get_document("ts").unwrap();
        assert_eq!(ts.get("$gte"), Some(&Bson::DateTime(bson::DateTime::from_millis(1_700_000_000_000))));
        assert_eq!(ts.get("$lte"), Some(&Bson::DateTime(bson::DateTime::from_millis(1_800_000_000_000))));
        // In an expression the value "$preis" stays a value instead of reading the field.
        let eq = m.get_document("$expr").unwrap().get_array("$eq").unwrap();
        assert_eq!(eq[0], Bson::String("$feld".into()), "field paths the query writes stay field paths");
        assert_eq!(eq[1], Bson::Document(bson::doc! { "$literal": "$preis" }));
        let proj = p[1].get_document("$project").unwrap();
        assert_eq!(proj.get("x"), Some(&Bson::Document(bson::doc! { "$literal": "$preis" })));
        assert!(matches!(proj.get("von"), Some(Bson::DateTime(_))));
        assert_eq!(proj.get("schritt"), Some(&Bson::Int64(30_000)));

        assert_eq!(reason(r#"[{"$match": {"a": "${fehlt}"}}]"#), "mongodb.variable_missing");
        assert_eq!(reason(r#"[{"$match": {"a": "Wert ${land}"}}]"#), "mongodb.variable_in_text");
        assert_eq!(reason(r#"[{"$match": {"${land}": 1}}]"#), "mongodb.variable_in_key");
        assert_eq!(reason(r#"[{"$match": {"a": "${la nd}"}}]"#), "mongodb.variable_name_invalid");
        assert_eq!(reason(r#"[{"$match": {"a": "$__jetzt"}}]"#), "mongodb.macro_unknown");
        assert_eq!(reason(r#"[{"$match": {"$__zeit": "ts"}}]"#), "mongodb.macro_unknown");
        assert_eq!(reason(r#"[{"$match": {"$__timeFilter": 1}}]"#), "mongodb.time_filter_field");
        assert_eq!(reason(r#"[{"$match": {"ts": 1, "$__timeFilter": "ts"}}]"#), "mongodb.time_filter_conflict");
        assert_eq!(reason(r#"[{"$project": {"a": {"$__timeFilter": "ts"}}}]"#), "mongodb.time_filter_context");
        let vars: BTreeMap<String, Value> = [("o".to_string(), json!({ "$where": "1" }))].into();
        let e = binder(&vars).pipeline(r#"[{"$match": {"a": "${o}"}}]"#).unwrap_err();
        assert_eq!(e.detail().reason, "mongodb.variable_type", "objects could carry operators");
    }
}
