//! Field distributions in MongoDB (docs/api/datasources.md, "Field distribution"): stages
//! appended to the query's own stages, so the database counts the whole result.
//!
//! The values at a path are gathered per document into an array `a` with `$getField`, which
//! takes the key as a literal: keys with dots, a leading `$`, umlauts or emoji are read as they
//! are stored, and never become an operator or a dotted path. An array step (`[]`) takes every
//! element there. One `$unwind` then gives a row per value (and one per document without any,
//! so documents can be counted), and a `$facet` counts types, top values, distinct values and
//! the range of numbers, dates and texts in one pass. Equal-width histogram bins need the range
//! first, so they are a second aggregation over the same query.
//!
//! Every stage built here is on the reading list and is checked like a query's
//! (`pipeline::check_built`).

use bson::{Bson, Document, doc};
use serde_json::Value;

use super::documents::Converter;
use crate::datasources::distribution::{DISTINCT_CAP, DistributionSpec, PathStep};
use crate::datasources::frame::ResponseBudget;
use crate::shapes::{DistributionBin, DistributionScale, FieldDistribution, TypeCount, ValueCount};

/// The `$type` names of numbers.
const NUMBERS: [&str; 4] = ["double", "int", "long", "decimal"];
const CONTAINERS: [&str; 2] = ["object", "array"];

/// An expression for the values at `path` in the current document, as an array: the document
/// itself, then per key the field of every object so far that has it, per `[]` the elements of
/// every array so far.
pub fn values_expr(path: &[PathStep]) -> Bson {
    let mut expr = Bson::Array(vec![Bson::String("$$ROOT".into())]);
    for step in path {
        let each = match step {
            PathStep::Key(key) => {
                let field = doc! { "$getField": { "field": { "$literal": key.as_str() }, "input": "$$this" } };
                // `$getField` fails on values that are not objects, and `$cond` evaluates only the
                // branch it takes; a missing field adds nothing.
                doc! { "$cond": [
                    { "$eq": [{ "$type": "$$this" }, "object"] },
                    { "$cond": [{ "$eq": [{ "$type": field.clone() }, "missing"] }, [], [field]] },
                    [],
                ] }
            }
            PathStep::Elements => doc! { "$cond": [{ "$isArray": "$$this" }, "$$this", []] },
        };
        expr = doc! { "$reduce": { "input": expr, "initialValue": [], "in": { "$concatArrays": ["$$value", each] } } }
            .into();
    }
    expr
}

/// `$expr` for "the value `a` has one of these types".
fn type_in(types: &[&str]) -> Document {
    doc! { "$in": [{ "$type": "$a" }, types.iter().map(|t| Bson::String((*t).into())).collect::<Vec<_>>()] }
}

/// A row that holds a value (not the stand-in of a document without one).
fn a_value(expr: Document) -> Document {
    doc! { "$match": { "i": { "$ne": null }, "$expr": expr } }
}

/// The value as a finite double (dates as Unix milliseconds); other values are null.
fn as_double() -> Document {
    doc! { "$set": { "d": { "$convert": { "input": "$a", "to": "double", "onError": null, "onNull": null } } } }
}

fn finite() -> Document {
    doc! { "$match": { "d": { "$gt": f64::NEG_INFINITY, "$lt": f64::INFINITY } } }
}

/// The range of the values of `types`: count, typed min and max, and both as doubles.
fn range_facet(types: &[&str]) -> Bson {
    Bson::Array(
        [
            a_value(type_in(types)),
            as_double(),
            finite(),
            doc! { "$group": {
                "_id": null, "n": { "$sum": 1 }, "min": { "$min": "$a" }, "max": { "$max": "$a" },
                "lo": { "$min": "$d" }, "hi": { "$max": "$d" },
            } },
        ]
        .into_iter()
        .map(Bson::Document)
        .collect(),
    )
}

fn stages(list: Vec<Document>) -> Bson {
    Bson::Array(list.into_iter().map(Bson::Document).collect())
}

/// The stages after the query's own that count everything but the histogram.
pub fn summary_stages(spec: &DistributionSpec) -> Vec<Document> {
    let leaf = || a_value(doc! { "$not": [type_in(&CONTAINERS)] });
    let mut facets = Document::new();
    facets.insert(
        "docs",
        stages(vec![doc! { "$group": {
            "_id": null,
            // One row per document has the index 0, or none when the document has no value.
            "total": { "$sum": { "$cond": [{ "$lte": ["$i", 0] }, 1, 0] } },
            "present": { "$sum": { "$cond": [{ "$eq": ["$i", 0] }, 1, 0] } },
        } }]),
    );
    facets.insert(
        "types",
        stages(vec![
            doc! { "$match": { "i": { "$ne": null } } },
            doc! { "$group": { "_id": { "$type": "$a" }, "n": { "$sum": 1 } } },
            doc! { "$sort": { "n": -1, "_id": 1 } },
        ]),
    );
    facets.insert(
        "top",
        stages(vec![
            leaf(),
            doc! { "$group": { "_id": "$a", "n": { "$sum": 1 } } },
            doc! { "$sort": { "n": -1, "_id": 1 } },
            doc! { "$limit": spec.top as i64 },
        ]),
    );
    facets.insert(
        "distinct",
        stages(vec![
            leaf(),
            doc! { "$group": { "_id": "$a" } },
            doc! { "$limit": (DISTINCT_CAP + 1) as i64 },
            doc! { "$count": "n" },
        ]),
    );
    facets.insert("numbers", range_facet(&NUMBERS));
    facets.insert("dates", range_facet(&["date"]));
    facets.insert(
        "texts",
        stages(vec![
            a_value(type_in(&["string"])),
            doc! { "$group": { "_id": null, "min": { "$min": "$a" }, "max": { "$max": "$a" } } },
        ]),
    );
    vec![
        doc! { "$project": { "_id": 0, "a": values_expr(&spec.path) } },
        doc! { "$unwind": { "path": "$a", "includeArrayIndex": "i", "preserveNullAndEmptyArrays": true } },
        doc! { "$facet": facets },
    ]
}

/// The stages after the query's own that count values of `scale` into `bins` equal-width bins
/// from `lo` to `hi` (`lo < hi`).
pub fn histogram_stages(spec: &DistributionSpec, scale: DistributionScale, lo: f64, hi: f64) -> Vec<Document> {
    let types: &[&str] = match scale {
        DistributionScale::Number => &NUMBERS,
        DistributionScale::Date => &["date"],
    };
    let bins = spec.bins as i64;
    let width = (hi - lo) / spec.bins as f64;
    vec![
        doc! { "$project": { "_id": 0, "a": values_expr(&spec.path) } },
        doc! { "$unwind": { "path": "$a", "includeArrayIndex": "i" } },
        a_value(type_in(types)),
        as_double(),
        doc! { "$match": { "d": { "$gte": lo, "$lte": hi } } },
        doc! { "$group": {
            "_id": { "$min": [bins - 1, { "$floor": { "$divide": [{ "$subtract": ["$d", lo] }, width] } }] },
            "n": { "$sum": 1 },
        } },
    ]
}

/// A count in an answer, whichever number type the server chose.
fn count(d: &Document, key: &str) -> u64 {
    match d.get(key) {
        Some(Bson::Int32(n)) => (*n).max(0) as u64,
        Some(Bson::Int64(n)) => (*n).max(0) as u64,
        Some(Bson::Double(n)) if *n >= 0.0 => *n as u64,
        _ => 0,
    }
}

fn number(d: &Document, key: &str) -> Option<f64> {
    match d.get(key)? {
        Bson::Double(n) => Some(*n),
        Bson::Int32(n) => Some(f64::from(*n)),
        Bson::Int64(n) => Some(*n as f64),
        _ => None,
    }
}

/// The first document of facet `name`.
fn first<'a>(answer: &'a Document, name: &str) -> Option<&'a Document> {
    answer.get_array(name).ok()?.first()?.as_document()
}

fn rows<'a>(answer: &'a Document, name: &str) -> impl Iterator<Item = &'a Document> {
    answer.get_array(name).into_iter().flatten().filter_map(Bson::as_document)
}

/// The range a histogram needs: the scale, its bounds as doubles and how many values it holds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Range {
    pub scale: DistributionScale,
    pub lo: f64,
    pub hi: f64,
    pub n: u64,
}

/// Reads the summary's single answer document. `budget` bounds what values add to the response;
/// top values that no longer fit end the list.
pub fn read_summary(answer: &Document, budget: &ResponseBudget) -> (FieldDistribution, Option<Range>) {
    let mut out = FieldDistribution::default();
    if let Some(docs) = first(answer, "docs") {
        out.total = count(docs, "total");
        out.documents = count(docs, "present");
        out.missing = out.total.saturating_sub(out.documents);
    }
    for row in rows(answer, "types") {
        let name = row.get_str("_id").unwrap_or("missing").to_string();
        let n = count(row, "n");
        if !CONTAINERS.contains(&name.as_str()) {
            out.values += n;
        }
        if name == "null" {
            out.nulls = n;
        }
        out.types.push(TypeCount { name, count: n });
    }
    let distinct = first(answer, "distinct").map_or(0, |d| count(d, "n"));
    out.distinct_capped = distinct > DISTINCT_CAP;
    out.distinct = distinct.min(DISTINCT_CAP);
    let mut converter = Converter::default();
    let mut typed = |value: &Bson| -> Option<Value> {
        let value = converter.value_at(value, "").to_value();
        budget.take(value.to_string().len() + 16).then_some(value)
    };
    for row in rows(answer, "top") {
        let Some(value) = row.get("_id").and_then(&mut typed) else { break };
        out.top.push(ValueCount { value, count: count(row, "n") });
    }
    // The scale follows the most common kind of value, so a few stray texts in a number field
    // still give the numbers' range (as the UI does for loaded documents).
    let numbers = first(answer, "numbers");
    let dates = first(answer, "dates");
    let n_numbers = numbers.map_or(0, |d| count(d, "n"));
    let n_dates = dates.map_or(0, |d| count(d, "n"));
    let (scale, bounds) = if n_numbers > 0 && n_numbers >= n_dates {
        (Some(DistributionScale::Number), numbers)
    } else if n_dates > 0 {
        (Some(DistributionScale::Date), dates)
    } else {
        (None, first(answer, "texts"))
    };
    out.scale = scale;
    if let Some(b) = bounds {
        out.min = b.get("min").and_then(&mut typed);
        out.max = b.get("max").and_then(&mut typed);
    }
    let range = match (scale, bounds) {
        (Some(scale), Some(b)) => match (number(b, "lo"), number(b, "hi")) {
            (Some(lo), Some(hi)) if lo.is_finite() && hi.is_finite() && lo <= hi => {
                Some(Range { scale, lo, hi, n: count(b, "n") })
            }
            _ => None,
        },
        _ => None,
    };
    (out, range)
}

/// The bins from the histogram's answer rows (`_id` the bin index, `n` its count); a range of a
/// single value is one bin and needs no second aggregation.
pub fn bins(range: Range, bins: usize, answer: &[Document]) -> Vec<DistributionBin> {
    if range.lo == range.hi {
        return vec![DistributionBin { from: range.lo, to: range.hi, count: range.n }];
    }
    let width = (range.hi - range.lo) / bins as f64;
    let mut out: Vec<DistributionBin> = (0..bins)
        .map(|i| DistributionBin {
            from: range.lo + i as f64 * width,
            to: if i == bins - 1 { range.hi } else { range.lo + (i + 1) as f64 * width },
            count: 0,
        })
        .collect();
    for row in answer {
        let Some(index) = number(row, "_id") else { continue };
        if index >= 0.0
            && let Some(bin) = out.get_mut(index as usize)
        {
            bin.count += count(row, "n");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::mongodb::pipeline::check_built;

    fn spec(path: &[Option<&str>]) -> DistributionSpec {
        let path: Vec<Option<String>> = path.iter().map(|s| s.map(str::to_owned)).collect();
        DistributionSpec::new(&path, None, None).unwrap()
    }

    #[test]
    fn keys_are_literals_whatever_they_hold() {
        let expr = values_expr(&spec(&[Some("kunde.name"), Some("$preis"), Some("Größe \u{1F642}")]).path);
        let text = expr.to_string();
        // Each key is a literal field name: never a dotted path or an operator.
        for key in ["kunde.name", "$preis", "Größe \u{1F642}"] {
            assert!(text.contains(&format!("\"$literal\": \"{key}\"")), "{key}: {text}");
            assert!(!text.contains(&format!("\"${key}\"")), "{key} read as a field path: {text}");
        }
        // The keys are values, never keys of the built stages, so the operator scan passes.
        check_built(&summary_stages(&spec(&[Some("$where"), Some("a.b")]))).unwrap();
    }

    #[test]
    fn array_steps_take_every_element() {
        let Bson::Document(outer) = values_expr(&spec(&[Some("items"), None, Some("preis")]).path) else {
            panic!("a document")
        };
        // Outermost the last step (`preis`), reading the elements step, reading `items`.
        let elements = outer.get_document("$reduce").unwrap().get_document("input").unwrap();
        let reduce = elements.get_document("$reduce").unwrap();
        let each = reduce.get_document("in").unwrap().get_array("$concatArrays").unwrap();
        assert_eq!(
            each[1].as_document().unwrap().get_array("$cond").unwrap()[0],
            Bson::Document(doc! { "$isArray": "$$this" })
        );
        let items = reduce.get_document("input").unwrap().get_document("$reduce").unwrap();
        assert_eq!(items.get_array("input").unwrap(), &vec![Bson::String("$$ROOT".into())]);
    }

    #[test]
    fn built_stages_only_read() {
        let s = spec(&[Some("n")]);
        let summary = summary_stages(&s);
        check_built(&summary).unwrap();
        let names: Vec<&str> = summary.iter().map(|d| d.keys().next().unwrap().as_str()).collect();
        assert_eq!(names, ["$project", "$unwind", "$facet"]);
        let facets = summary[2].get_document("$facet").unwrap();
        let keys: Vec<&str> = facets.keys().map(String::as_str).collect();
        assert_eq!(keys, ["docs", "types", "top", "distinct", "numbers", "dates", "texts"]);
        let top = facets.get_array("top").unwrap();
        assert_eq!(top.last().unwrap().as_document().unwrap().get_i64("$limit").unwrap(), 10);
        check_built(&histogram_stages(&s, DistributionScale::Number, 0.0, 10.0)).unwrap();

        // The check refuses a writing stage, also inside $facet.
        assert!(check_built(&[doc! { "$out": "x" }]).is_err());
        assert!(check_built(&[doc! { "$facet": { "a": [{ "$merge": { "into": "x" } }] } }]).is_err());
        assert!(check_built(&[doc! { "$match": { "$where": "1" } }]).is_err());
    }

    #[test]
    fn the_summary_is_read_with_typed_values() {
        let answer = doc! {
            "docs": [{ "_id": null, "total": 5_i64, "present": 4 }],
            "types": [{ "_id": "int", "n": 3 }, { "_id": "null", "n": 1 }, { "_id": "object", "n": 2 }],
            "top": [{ "_id": 2_i64, "n": 2 }, { "_id": null, "n": 1 }],
            "distinct": [{ "n": 3 }],
            "numbers": [{ "_id": null, "n": 3, "min": 1, "max": 9_007_199_254_740_993_i64, "lo": 1.0, "hi": 9.0 }],
            "dates": [],
            "texts": [{ "_id": null, "min": "a", "max": "z" }],
        };
        let budget = ResponseBudget::new(1 << 20);
        let (d, range) = read_summary(&answer, &budget);
        assert_eq!((d.total, d.documents, d.missing, d.values, d.nulls, d.distinct), (5, 4, 1, 4, 1, 3));
        assert!(!d.distinct_capped);
        assert_eq!(d.types.len(), 3);
        assert_eq!(d.top[0].value, serde_json::json!({ "$type": "int64", "value": "2" }));
        assert_eq!(d.top[1].value, Value::Null);
        assert_eq!(d.scale, Some(DistributionScale::Number));
        assert_eq!(d.min, Some(serde_json::json!(1)));
        assert_eq!(d.max, Some(serde_json::json!({ "$type": "int64", "value": "9007199254740993" })));
        let range = range.unwrap();
        assert_eq!((range.lo, range.hi, range.n), (1.0, 9.0, 3));

        let rows = [doc! { "_id": 0.0, "n": 2 }, doc! { "_id": 3.0, "n": 1 }];
        let b = bins(range, 4, &rows);
        assert_eq!(b.iter().map(|b| b.count).collect::<Vec<_>>(), [2, 0, 0, 1]);
        assert_eq!((b[0].from, b[3].to), (1.0, 9.0));
        let one = bins(Range { lo: 4.0, hi: 4.0, ..range }, 20, &[]);
        assert_eq!(one, [DistributionBin { from: 4.0, to: 4.0, count: 3 }]);

        // An empty result: zeros and no scale.
        let (d, range) = read_summary(&doc! {}, &budget);
        assert_eq!((d.total, d.values, d.scale, range), (0, 0, None, None));

        // Texts only: their range, no histogram.
        let texts =
            doc! { "texts": [{ "_id": null, "min": "Apfel", "max": "Zitrone" }], "distinct": [{ "n": 100_001 }] };
        let (d, range) = read_summary(&texts, &budget);
        assert_eq!((d.min, d.max, range), (Some(serde_json::json!("Apfel")), Some(serde_json::json!("Zitrone")), None));
        assert_eq!((d.distinct, d.distinct_capped), (DISTINCT_CAP, true));
    }
}
