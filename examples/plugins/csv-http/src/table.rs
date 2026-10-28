//! CSV and JSON into a table with typed columns: numbers, booleans, times, dates and text are
//! recognized per column; anything else stays text (CSV) or JSON (JSON).

use kalzit_plugin_sdk::FieldType;
use serde_json::{Map, Value};

/// A parsed file: column names, their types, and rows of values that fit them.
#[derive(Debug, PartialEq)]
pub struct Table {
    pub names: Vec<String>,
    pub types: Vec<FieldType>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
}

/// The format a setting names (`csv`, `json`), else what the content type or the first
/// character says.
pub fn format(setting: Option<&str>, content_type: &str, body: &str) -> Format {
    match setting {
        Some("csv") => Format::Csv,
        Some("json") => Format::Json,
        _ if content_type.contains("json") => Format::Json,
        _ if body.trim_start().starts_with(['[', '{']) => Format::Json,
        _ => Format::Csv,
    }
}

/// The most columns a file may have; a wider one is refused before its rows are read.
pub const MAX_COLUMNS: usize = 10_000;

fn too_wide() -> String {
    format!("the file has more than {MAX_COLUMNS} columns")
}

/// Splits CSV text (RFC 4180: quoted fields with doubled quotes, CRLF or LF) into at most
/// `max_records` records (blank lines carry none); a record of more than `MAX_COLUMNS` fields is
/// refused as soon as it gets there.
fn records(text: &str, delimiter: char, max_records: usize) -> Result<Vec<Vec<String>>, String> {
    let mut out = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.strip_prefix('\u{feff}').unwrap_or(text).chars().peekable();
    let mut at_start = true;
    let end_field = |record: &mut Vec<String>, field: &mut String| -> Result<(), String> {
        if record.len() >= MAX_COLUMNS {
            return Err(too_wide());
        }
        record.push(std::mem::take(field));
        Ok(())
    };
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' | '\r' => {
                end_field(&mut record, &mut field)?;
                let done = std::mem::take(&mut record);
                if !(done.len() == 1 && done[0].is_empty()) {
                    out.push(done);
                    if out.len() >= max_records {
                        return Ok(out);
                    }
                }
                at_start = true;
                continue;
            }
            c if c == delimiter => end_field(&mut record, &mut field)?,
            _ => field.push(c),
        }
        at_start = false;
    }
    if quoted {
        return Err("a quoted field is not closed".into());
    }
    if !at_start || !field.is_empty() || !record.is_empty() {
        end_field(&mut record, &mut field)?;
        if !(record.len() == 1 && record[0].is_empty()) {
            out.push(record);
        }
    }
    Ok(out)
}

/// Unique, non-empty column names.
fn names(raw: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut taken = std::collections::HashSet::new();
    for (i, name) in raw.enumerate() {
        let base = if name.trim().is_empty() { format!("c{}", i + 1) } else { name.trim().to_string() };
        let mut candidate = base.clone();
        let mut n = 2;
        while taken.contains(&candidate) {
            candidate = format!("{base}_{n}");
            n += 1;
        }
        taken.insert(candidate.clone());
        out.push(candidate);
    }
    out
}

/// The rows to read for a row limit (0: none): one more than the limit, so the host sees that
/// the result was cut and says so.
fn wanted(max_rows: u64) -> usize {
    if max_rows == 0 { usize::MAX } else { usize::try_from(max_rows).unwrap_or(usize::MAX).saturating_add(1) }
}

pub fn parse_csv(text: &str, delimiter: char, header: bool, max_rows: u64) -> Result<Table, String> {
    let mut records = records(text, delimiter, wanted(max_rows).saturating_add(usize::from(header)))?;
    if records.is_empty() {
        return Ok(Table { names: vec![], types: vec![], rows: vec![] });
    }
    let width = records.iter().map(Vec::len).max().unwrap_or(0);
    let names = if header {
        let head = records.remove(0);
        if let Some((i, r)) = records.iter().enumerate().find(|(_, r)| r.len() > head.len()) {
            return Err(format!("row {} has {} fields, the header {}", i + 2, r.len(), head.len()));
        }
        names(head.into_iter())
    } else {
        names((0..width).map(|_| String::new()))
    };
    let types: Vec<FieldType> =
        (0..names.len()).map(|c| infer_text(records.iter().filter_map(|r| r.get(c)).map(String::as_str))).collect();
    let rows = records
        .iter()
        .map(|r| (0..names.len()).map(|c| r.get(c).map_or(Value::Null, |s| text_value(s, types[c]))).collect())
        .collect();
    Ok(Table { names, types, rows })
}

/// The array at `pointer` (a JSON pointer such as `/data/items`; the whole document when
/// empty), each element an object: one column per key. Reads the elements up to the row limit.
pub fn parse_json(text: &str, pointer: &str, max_rows: u64) -> Result<Table, String> {
    let doc: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let at = if pointer.is_empty() { Some(&doc) } else { doc.pointer(pointer) };
    let items = at
        .and_then(Value::as_array)
        .ok_or_else(|| format!("no array at {:?}", if pointer.is_empty() { "/" } else { pointer }))?;
    let items = &items[..items.len().min(wanted(max_rows))];
    let mut objects: Vec<&Map<String, Value>> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        objects.push(item.as_object().ok_or_else(|| format!("element {i} is not an object"))?);
    }
    let mut names: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for o in &objects {
        for k in o.keys() {
            if seen.insert(k.as_str()) {
                if names.len() >= MAX_COLUMNS {
                    return Err(too_wide());
                }
                names.push(k.clone());
            }
        }
    }
    let types: Vec<FieldType> = names.iter().map(|n| infer_json(objects.iter().filter_map(|o| o.get(n)))).collect();
    let rows = objects
        .iter()
        .map(|o| {
            names
                .iter()
                .zip(&types)
                .map(|(n, t)| match o.get(n) {
                    None | Some(Value::Null) => Value::Null,
                    Some(Value::String(s)) if matches!(t, FieldType::Time | FieldType::Date) => text_value(s, *t),
                    Some(v) => v.clone(),
                })
                .collect()
        })
        .collect();
    Ok(Table { names, types, rows })
}

/// The type of a CSV column: the narrowest that every non-empty cell fits.
fn infer_text<'a>(cells: impl Iterator<Item = &'a str>) -> FieldType {
    let mut candidates = [FieldType::Number, FieldType::Bool, FieldType::Date, FieldType::Time];
    let mut alive = [true; 4];
    let mut any = false;
    for cell in cells.map(str::trim).filter(|c| !c.is_empty()) {
        any = true;
        for (i, t) in candidates.iter().enumerate() {
            alive[i] &= fits(cell, *t);
        }
        if !alive.iter().any(|a| *a) {
            return FieldType::String;
        }
    }
    if !any {
        return FieldType::String;
    }
    candidates.iter_mut().zip(alive).find(|(_, a)| *a).map_or(FieldType::String, |(t, _)| *t)
}

fn infer_json<'a>(values: impl Iterator<Item = &'a Value>) -> FieldType {
    let mut kind: Option<FieldType> = None;
    let mut texts: Vec<&str> = Vec::new();
    for v in values {
        let t = match v {
            Value::Null => continue,
            Value::Number(_) => FieldType::Number,
            Value::Bool(_) => FieldType::Bool,
            Value::String(s) => {
                texts.push(s);
                FieldType::String
            }
            _ => FieldType::Json,
        };
        match kind {
            None => kind = Some(t),
            Some(k) if k != t => return FieldType::Json,
            _ => {}
        }
    }
    match kind {
        Some(FieldType::String) => {
            if texts.iter().all(|s| fits(s, FieldType::Date)) {
                FieldType::Date
            } else if texts.iter().all(|s| fits(s, FieldType::Time)) {
                FieldType::Time
            } else {
                FieldType::String
            }
        }
        Some(t) => t,
        None => FieldType::String,
    }
}

fn fits(cell: &str, t: FieldType) -> bool {
    match t {
        FieldType::Number => number(cell).is_some(),
        FieldType::Bool => matches!(cell.to_ascii_lowercase().as_str(), "true" | "false"),
        FieldType::Date => cell.len() == 10 && unix_ms(cell).is_some(),
        FieldType::Time => unix_ms(cell).is_some(),
        _ => true,
    }
}

fn number(cell: &str) -> Option<Value> {
    if !cell.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E'))
        || !cell.bytes().any(|b| b.is_ascii_digit())
    {
        return None;
    }
    if let Ok(i) = cell.parse::<i64>() {
        return Some(Value::from(i));
    }
    let f: f64 = cell.parse().ok()?;
    serde_json::Number::from_f64(f).map(Value::Number)
}

fn text_value(cell: &str, t: FieldType) -> Value {
    let cell = cell.trim();
    if cell.is_empty() && t != FieldType::String {
        return Value::Null;
    }
    match t {
        FieldType::Number => number(cell).unwrap_or(Value::Null),
        FieldType::Bool => Value::Bool(cell.eq_ignore_ascii_case("true")),
        FieldType::Date | FieldType::Time => unix_ms(cell).map_or(Value::Null, Value::from),
        _ => Value::String(cell.to_string()),
    }
}

/// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn digits(s: &str, from: usize, len: usize) -> Option<i64> {
    let part = s.get(from..from + len)?;
    part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
}

/// `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DD[T ]HH:MM[:SS[.fff]][Z|±HH:MM]` (UTC when no zone)
/// in Unix milliseconds.
pub fn unix_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (digits(s, 0, 4)?, digits(s, 5, 2)?, digits(s, 8, 2)?);
    let month_days = [
        31,
        if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&m) || d < 1 || d > month_days[(m - 1) as usize] {
        return None;
    }
    let day_ms = days_from_civil(y, m, d) * 86_400_000;
    if b.len() == 10 {
        return Some(day_ms);
    }
    if !matches!(b[10], b'T' | b' ') || b.len() < 16 || b[13] != b':' {
        return None;
    }
    let (hh, mm) = (digits(s, 11, 2)?, digits(s, 14, 2)?);
    let mut at = 16;
    let mut ss = 0;
    let mut ms = 0;
    if b.get(at) == Some(&b':') {
        ss = digits(s, 17, 2)?;
        at = 19;
        if b.get(at) == Some(&b'.') {
            let start = at + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            if end == start {
                return None;
            }
            let frac = &s[start..end.min(start + 3)];
            ms = frac.parse::<i64>().ok()? * 10_i64.pow(3 - frac.len() as u32);
            at = end;
        }
    }
    if hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let offset_min = match &s[at..] {
        "" | "Z" | "z" => 0,
        zone => {
            let sign = match zone.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let rest = zone[1..].replace(':', "");
            if rest.len() != 4 {
                return None;
            }
            let (oh, om) = (digits(&rest, 0, 2)?, digits(&rest, 2, 2)?);
            sign * (oh * 60 + om)
        }
    };
    Some(day_ms + ((hh * 60 + mm - offset_min) * 60 + ss) * 1000 + ms)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn csv_columns_get_their_types() {
        let text = "\u{feff}time,host,cpu,up,note\r\n2026-10-28T10:00:00Z,a,0.5,true,\"x, \"\"y\"\"\"\n2026-10-28T10:01:00Z,b,12,false,\n\n";
        let t = parse_csv(text, ',', true, 0).unwrap();
        assert_eq!(t.names, ["time", "host", "cpu", "up", "note"]);
        assert_eq!(
            t.types,
            [FieldType::Time, FieldType::String, FieldType::Number, FieldType::Bool, FieldType::String]
        );
        assert_eq!(t.rows[0], [json!(1_793_181_600_000_i64), json!("a"), json!(0.5), json!(true), json!("x, \"y\"")]);
        assert_eq!(t.rows[1][2], json!(12));
        assert_eq!(t.rows[1][4], json!(""));
    }

    #[test]
    fn csv_without_header_and_other_delimiters() {
        let t = parse_csv("1;2\n3;\n", ';', false, 0).unwrap();
        assert_eq!(t.names, ["c1", "c2"]);
        assert_eq!(t.rows, [vec![json!(1), json!(2)], vec![json!(3), Value::Null]]);
        assert!(parse_csv("a\n\"open\n", ',', true, 0).is_err());
        assert!(parse_csv("a\n1,2\n", ',', true, 0).unwrap_err().contains("row 2"));
        let t = parse_csv("a,a,\n1,2,3\n", ',', true, 0).unwrap();
        assert_eq!(t.names, ["a", "a_2", "c3"]);
    }

    #[test]
    fn json_arrays_of_objects() {
        let text = r#"{"data":{"items":[{"day":"2026-10-28","n":1,"tags":["x"]},{"day":"2026-10-29","n":2.5,"tags":null,"extra":true}]}}"#;
        let t = parse_json(text, "/data/items", 0).unwrap();
        assert_eq!(t.names, ["day", "n", "tags", "extra"]);
        assert_eq!(t.types, [FieldType::Date, FieldType::Number, FieldType::Json, FieldType::Bool]);
        assert_eq!(t.rows[1], [json!(1_793_232_000_000_i64), json!(2.5), Value::Null, json!(true)]);
        assert!(parse_json(text, "/nope", 0).is_err());
        assert!(parse_json("[1]", "", 0).unwrap_err().contains("element 0"));
    }

    #[test]
    fn times_parse_with_zones() {
        assert_eq!(unix_ms("1970-01-01"), Some(0));
        assert_eq!(unix_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(unix_ms("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(unix_ms("1970-01-01 00:00"), Some(0));
        for bad in ["1970-13-01", "1970-02-30", "1970-01-01T24:00", "1970-01-01T00:00+1", "hello", "2026-10-28X"] {
            assert_eq!(unix_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_format_is_detected() {
        assert_eq!(format(None, "application/json; charset=utf-8", ""), Format::Json);
        assert_eq!(format(None, "text/plain", " [1]"), Format::Json);
        assert_eq!(format(None, "text/csv", "a,b"), Format::Csv);
        assert_eq!(format(Some("csv"), "application/json", "[]"), Format::Csv);
    }

    #[test]
    fn reading_stops_at_the_row_limit() {
        let text: String = std::iter::once("n\n".to_string()).chain((0..100_000).map(|i| format!("{i}\n"))).collect();
        let t = parse_csv(&text, ',', true, 10).unwrap();
        assert_eq!(t.rows.len(), 11, "one row more than the limit");
        let json = format!("[{}]", (0..1000).map(|i| format!("{{\"n\":{i}}}")).collect::<Vec<_>>().join(","));
        assert_eq!(parse_json(&json, "", 5).unwrap().rows.len(), 6);
    }

    #[test]
    fn a_huge_single_line_is_refused_at_the_column_cap() {
        // One line of 20,000 fields and no newline: refused once the cap is passed, also
        // without a header, and the columns of a JSON file count the same.
        let line = vec!["x"; 2 * MAX_COLUMNS].join(",");
        assert!(parse_csv(&line, ',', true, 0).unwrap_err().contains("columns"));
        assert!(parse_csv(&line, ',', false, 1).unwrap_err().contains("columns"));
        let wide: String = (0..=MAX_COLUMNS).map(|i| format!("\"k{i}\":1")).collect::<Vec<_>>().join(",");
        assert!(parse_json(&format!("[{{{wide}}}]"), "", 0).unwrap_err().contains("columns"));
        // A long single field is fine.
        let t = parse_csv(&"y".repeat(5 * 1024 * 1024), ',', false, 0).unwrap();
        assert_eq!(t.rows.len(), 1);
    }
}
