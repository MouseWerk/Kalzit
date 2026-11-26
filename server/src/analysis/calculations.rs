//! The calculations that reduce many cells to one value, shared by the steps that summarize:
//! group, pivot and reduce. Empty cells are left out of every calculation. The UI computes the
//! same in `ui/src/analysis/calculations.ts`.

use serde_json::Value;

use super::Agg;
use super::stats;
use super::steps::{int_of, num_value, number_at};
use crate::shapes::{Field, FieldType};

/// The type of `op` over a field of type `t`, or `None` when `op` cannot read it: `count`
/// any field (a number), `first`, `last`, `firstRow` and `lastRow` any field (its own type),
/// `min` and `max` numbers, times and text (their own type), the others numbers only (a number).
pub fn result_type(op: Agg, t: FieldType) -> Option<FieldType> {
    use FieldType::*;
    match (op, t) {
        (Agg::Count, _) => Some(Number),
        (Agg::First | Agg::Last | Agg::FirstRow | Agg::LastRow, t) => Some(t),
        (Agg::Min | Agg::Max, t @ (Number | Int64 | Decimal | Time | Date | String)) => Some(t),
        (
            Agg::Sum | Agg::Mean | Agg::Median | Agg::Stddev | Agg::Variance | Agg::Percentile(_),
            Number | Int64 | Decimal,
        ) => Some(Number),
        _ => None,
    }
}

/// Reduces the cells of `rows` of `field` by `op`; empty cells are left out.
pub fn aggregate(field: &Field, op: Agg, rows: &[usize]) -> Value {
    let cells = || rows.iter().map(|&r| &field.values[r]).filter(|v| !v.is_null());
    let nums = || -> Vec<f64> { rows.iter().filter_map(|&r| number_at(&field.values[r])).collect() };
    match op {
        Agg::Count => Value::from(cells().count()),
        Agg::First => cells().next().cloned().unwrap_or(Value::Null),
        Agg::Last => cells().next_back().cloned().unwrap_or(Value::Null),
        Agg::FirstRow => rows.first().map_or(Value::Null, |&r| field.values[r].clone()),
        Agg::LastRow => rows.last().map_or(Value::Null, |&r| field.values[r].clone()),
        Agg::Sum => {
            let v = nums();
            num_value((!v.is_empty()).then(|| stats::sum(&v)))
        }
        Agg::Mean => num_value(stats::mean(&nums())),
        Agg::Median => num_value(stats::percentile(&stats::sorted(&nums()), 50.0)),
        Agg::Stddev => num_value(stats::stddev(&nums())),
        Agg::Variance => num_value(stats::variance(&nums())),
        Agg::Percentile(p) => num_value(stats::percentile(&stats::sorted(&nums()), f64::from(p))),
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
