//! CSV reading and typing for file sources: an RFC 4180 reader (quoted fields with `""`,
//! delimiters and line breaks inside quotes, `\n` or `\r\n`) that reads one record at a time
//! within a byte limit, and the column type inference documented in docs/api/datasources.md
//! ("CSV columns").

use std::io::BufRead;

use serde_json::Value;

use crate::shapes::FieldType;

/// How decimal numbers are written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decimal {
    /// A point, unless a value of the column has a comma; then every value must read with a comma.
    Auto,
    /// `12.5`, `1e3`.
    Point,
    /// `12,5`, `1.234,5` (points group thousands).
    Comma,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CsvError {
    /// A record is longer than the bytes left; the caller stops and marks the result cut.
    TooLarge,
    /// The file ends inside a quoted field; `line` is where the field began.
    UnclosedQuote {
        line: usize,
    },
    Io(String),
}

/// One record: its fields, the bytes it took in the file, and whether it was not UTF-8 and was
/// read as Windows-1252 (what Excel writes in German Windows).
#[derive(Debug, PartialEq, Eq)]
pub struct Record {
    pub fields: Vec<String>,
    pub bytes: usize,
    pub windows_1252: bool,
}

pub struct Reader<R: BufRead> {
    input: R,
    delimiter: u8,
    line: usize,
    /// A `\n` right after a `\r` that ended the previous record belongs to it.
    skip_lf: bool,
}

/// Skips a UTF-8 byte order mark at the start.
pub fn skip_bom<R: BufRead>(input: &mut R) -> std::io::Result<()> {
    let buf = input.fill_buf()?;
    if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        input.consume(3);
    }
    Ok(())
}

/// The delimiter of the first line: whichever of `,` `;` tab `|` occurs most often outside
/// quotes; a tie goes to the earlier in that list, a line with none to `,`.
pub fn detect_delimiter(start: &[u8]) -> u8 {
    const CANDIDATES: &[u8; 4] = b",;\t|";
    let mut counts = [0usize; 4];
    let mut quoted = false;
    for &b in start {
        match b {
            b'"' => quoted = !quoted,
            b'\n' | b'\r' if !quoted => break,
            _ if !quoted => {
                if let Some(i) = CANDIDATES.iter().position(|c| *c == b) {
                    counts[i] += 1;
                }
            }
            _ => {}
        }
    }
    let mut best = 0;
    for i in 1..CANDIDATES.len() {
        if counts[i] > counts[best] {
            best = i;
        }
    }
    CANDIDATES[best]
}

impl<R: BufRead> Reader<R> {
    pub fn new(input: R, delimiter: u8) -> Self {
        Self { input, delimiter, line: 1, skip_lf: false }
    }

    /// The next record that is not an empty line, or `None` at the end. A record longer than
    /// `max_bytes` is `TooLarge`.
    pub fn next_record(&mut self, max_bytes: usize) -> Result<Option<Record>, CsvError> {
        loop {
            match self.read_record(max_bytes)? {
                Some(r) if r.fields.len() == 1 && r.fields[0].is_empty() => continue,
                other => return Ok(other),
            }
        }
    }

    fn read_record(&mut self, max_bytes: usize) -> Result<Option<Record>, CsvError> {
        let mut fields: Vec<Vec<u8>> = Vec::new();
        let mut field: Vec<u8> = Vec::new();
        let mut quoted = false;
        // A `"` inside quotes: either the first of `""` or the closing quote.
        let mut quote_pending = false;
        // The field began with a quote (so a later `"` outside quotes is kept as text).
        let mut was_quoted = false;
        let mut bytes = 0usize;
        let mut started = false;
        let start_line = self.line;
        loop {
            let buf = self.input.fill_buf().map_err(|e| CsvError::Io(e.to_string()))?;
            if buf.is_empty() {
                if quoted && !quote_pending {
                    return Err(CsvError::UnclosedQuote { line: start_line });
                }
                if !started {
                    return Ok(None);
                }
                fields.push(field);
                return Ok(Some(decode(fields, bytes)));
            }
            let mut used = 0;
            let mut done = false;
            for &b in buf {
                used += 1;
                if self.skip_lf {
                    self.skip_lf = false;
                    if b == b'\n' {
                        continue;
                    }
                }
                bytes += 1;
                if bytes > max_bytes {
                    self.input.consume(used);
                    return Err(CsvError::TooLarge);
                }
                started = true;
                if quoted {
                    if quote_pending {
                        quote_pending = false;
                        if b == b'"' {
                            field.push(b'"');
                            continue;
                        }
                        quoted = false;
                        // Falls through: the byte after the closing quote is read normally.
                    } else {
                        if b == b'"' {
                            quote_pending = true;
                        } else {
                            if b == b'\n' {
                                self.line += 1;
                            }
                            field.push(b);
                        }
                        continue;
                    }
                }
                match b {
                    b'"' if field.is_empty() && !was_quoted => {
                        quoted = true;
                        was_quoted = true;
                    }
                    b'\n' | b'\r' => {
                        self.line += 1;
                        self.skip_lf = b == b'\r';
                        done = true;
                        break;
                    }
                    d if d == self.delimiter => {
                        fields.push(std::mem::take(&mut field));
                        was_quoted = false;
                    }
                    other => field.push(other),
                }
            }
            self.input.consume(used);
            if done {
                fields.push(field);
                return Ok(Some(decode(fields, bytes)));
            }
        }
    }
}

fn decode(fields: Vec<Vec<u8>>, bytes: usize) -> Record {
    if fields.iter().all(|f| std::str::from_utf8(f).is_ok()) {
        let fields = fields.into_iter().map(|f| String::from_utf8(f).expect("checked above")).collect();
        return Record { fields, bytes, windows_1252: false };
    }
    Record { fields: fields.iter().map(|f| windows_1252(f)).collect(), bytes, windows_1252: true }
}

/// Windows-1252: Latin-1 with printable characters in 0x80 to 0x9F.
fn windows_1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{81}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}', '\u{02C6}',
        '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{8D}', '\u{017D}', '\u{8F}', '\u{90}', '\u{2018}',
        '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}',
        '\u{203A}', '\u{0153}', '\u{9D}', '\u{017E}', '\u{0178}',
    ];
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => HIGH[(b - 0x80) as usize],
            other => other as char,
        })
        .collect()
}

// ---- types ----

/// The type of a column from its values (`None` and blank values do not count), in this order:
/// `bool` when every value is `true` or `false`, `int64` when every value is a whole number,
/// `number` when every value is a decimal number, `time` when every value is a date or time,
/// otherwise `string`. A column without values is `string`.
pub fn infer(values: &[Option<&str>], decimal: Decimal) -> FieldType {
    let present: Vec<&str> = values.iter().flatten().map(|v| v.trim()).filter(|v| !v.is_empty()).collect();
    if present.is_empty() {
        return FieldType::String;
    }
    if present.iter().all(|v| v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("false")) {
        return FieldType::Bool;
    }
    if present.iter().all(|v| parse_int(v).is_some()) {
        return FieldType::Int64;
    }
    let decimal = resolve_decimal(&present, decimal);
    if present.iter().all(|v| parse_number(v, decimal).is_some()) {
        return FieldType::Number;
    }
    if present.iter().all(|v| parse_time(v).is_some()) {
        return FieldType::Time;
    }
    FieldType::String
}

/// `Auto` decided for one column: a comma when any of its values has one.
pub fn resolve_decimal(present: &[&str], decimal: Decimal) -> Decimal {
    match decimal {
        Decimal::Auto if present.iter().any(|v| v.contains(',')) => Decimal::Comma,
        Decimal::Auto => Decimal::Point,
        other => other,
    }
}

/// The value of a cell in a column of `ty`; blank cells and values that do not fit are `null`.
pub fn convert(raw: Option<&str>, ty: FieldType, decimal: Decimal) -> Value {
    let Some(raw) = raw else { return Value::Null };
    let v = raw.trim();
    if v.is_empty() {
        return Value::Null;
    }
    match ty {
        FieldType::Bool => Value::Bool(v.eq_ignore_ascii_case("true")),
        FieldType::Int64 => parse_int(v).map_or(Value::Null, |n| Value::String(n.to_string())),
        FieldType::Number => {
            parse_number(v, decimal).and_then(serde_json::Number::from_f64).map_or(Value::Null, Value::Number)
        }
        FieldType::Time => parse_time(v).map_or(Value::Null, Value::from),
        FieldType::String | FieldType::Json => Value::String(raw.to_string()),
    }
}

/// Digits with an optional sign; a leading zero (`01067`, a postal code) makes it text.
fn parse_int(v: &str) -> Option<i64> {
    let digits = v.strip_prefix(['+', '-']).unwrap_or(v);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) || has_leading_zero(digits) {
        return None;
    }
    v.parse().ok()
}

fn has_leading_zero(integer_part: &str) -> bool {
    integer_part.len() > 1 && integer_part.starts_with('0')
}

/// A decimal number. With a point: `-12.5`, `.5`, `1e3`. With a comma: `12,5`, `-0,25`, and
/// thousands grouped by points (`1.234.567,89`). A leading zero before further digits is text.
pub fn parse_number(v: &str, decimal: Decimal) -> Option<f64> {
    let unsigned = v.strip_prefix(['+', '-']).unwrap_or(v);
    let negative = v.starts_with('-');
    let value = match decimal {
        Decimal::Comma => {
            let (int, frac) = match unsigned.split_once(',') {
                Some((i, f)) => (i, Some(f)),
                None => (unsigned, None),
            };
            let int = if int.contains('.') {
                let groups: Vec<&str> = int.split('.').collect();
                let ok = (1..=3).contains(&groups[0].len())
                    && groups[1..].iter().all(|g| g.len() == 3)
                    && groups.iter().all(|g| g.bytes().all(|b| b.is_ascii_digit()));
                if !ok || groups[0].starts_with('0') {
                    return None;
                }
                groups.concat()
            } else {
                int.to_string()
            };
            if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || has_leading_zero(&int) {
                return None;
            }
            if let Some(f) = frac
                && (f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()))
            {
                return None;
            }
            format!("{int}.{}", frac.unwrap_or("0")).parse::<f64>().ok()?
        }
        Decimal::Point | Decimal::Auto => {
            let mantissa = unsigned.split(['e', 'E']).next().unwrap_or("");
            let int = mantissa.split('.').next().unwrap_or("");
            let shape_ok = !unsigned.is_empty()
                && unsigned.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
                && mantissa.bytes().any(|b| b.is_ascii_digit());
            if !shape_ok || has_leading_zero(int) {
                return None;
            }
            unsigned.parse::<f64>().ok()?
        }
    };
    value.is_finite().then_some(if negative { -value } else { value })
}

/// Unix milliseconds of an ISO 8601 date or date and time (`2026-03-01`, `2026-03-01 10:15`,
/// `2026-03-01T10:15:30.5Z`, `2026-03-01T10:15:30+01:00`) or a German date (`01.03.2026`,
/// `01.03.2026 10:15[:30]`). Without an offset the time is UTC.
pub fn parse_time(v: &str) -> Option<i64> {
    use chrono::{DateTime, NaiveDate, NaiveDateTime};
    if v.len() < 8 || v.len() > 40 || !v.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    const OFFSET: &[&str] = &["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%d %H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M:%S%.f%z"];
    for f in OFFSET {
        if let Ok(t) = DateTime::parse_from_str(v, f) {
            return in_range(t.timestamp_millis());
        }
    }
    let naive = v.strip_suffix(['Z', 'z']).unwrap_or(v);
    const NAIVE: &[&str] = &[
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
        "%d.%m.%Y %H:%M:%S",
        "%d.%m.%Y %H:%M",
    ];
    for f in NAIVE {
        if let Ok(t) = NaiveDateTime::parse_from_str(naive, f) {
            return in_range(t.and_utc().timestamp_millis());
        }
    }
    for f in ["%Y-%m-%d", "%d.%m.%Y"] {
        if let Ok(d) = NaiveDate::parse_from_str(naive, f) {
            return in_range(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
        }
    }
    None
}

fn in_range(ms: i64) -> Option<i64> {
    (super::MIN_TIME_MS..=super::MAX_TIME_MS).contains(&ms).then_some(ms)
}

/// Column names from a header record: trimmed, `column_<n>` when blank, `_2`, `_3` appended to
/// repeats.
pub fn column_names(header: &[String], count: usize) -> Vec<String> {
    let mut names: Vec<String> = Vec::with_capacity(count);
    for i in 0..count {
        let base = header
            .get(i)
            .map(|h| h.trim())
            .filter(|h| !h.is_empty())
            .map_or_else(|| format!("column_{}", i + 1), String::from);
        let mut name = base.clone();
        let mut n = 2;
        while names.contains(&name) {
            name = format!("{base}_{n}");
            n += 1;
        }
        names.push(name);
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn records(text: &[u8], delimiter: u8) -> Vec<Vec<String>> {
        let mut input = std::io::BufReader::new(text);
        skip_bom(&mut input).unwrap();
        let mut r = Reader::new(input, delimiter);
        let mut out = Vec::new();
        while let Some(rec) = r.next_record(1 << 20).unwrap() {
            out.push(rec.fields);
        }
        out
    }

    #[test]
    fn quotes_line_breaks_and_the_byte_order_mark() {
        let text =
            "\u{FEFF}name;notiz;betrag\r\n\"Müller; Söhne\";\"sagt \"\"hallo\"\"\nzweite Zeile\";12,5\r\n\nx;;\n";
        let rows = records(text.as_bytes(), b';');
        assert_eq!(rows.len(), 3, "{rows:?}");
        assert_eq!(rows[0], ["name", "notiz", "betrag"], "the BOM is not part of the first name");
        assert_eq!(rows[1], ["Müller; Söhne", "sagt \"hallo\"\nzweite Zeile", "12,5"]);
        assert_eq!(rows[2], ["x", "", ""]);
        assert_eq!(records(b"a,b", b','), [["a", "b"]], "the last record needs no line break");
        assert_eq!(records(b"a\"b,\"c\"d\n", b','), [["a\"b", "cd"]], "stray quotes are kept as text");

        let mut r = Reader::new(std::io::BufReader::new(&b"a,\"offen\nb\n"[..]), b',');
        assert_eq!(r.next_record(1 << 20), Err(CsvError::UnclosedQuote { line: 1 }));
    }

    #[test]
    fn records_are_bounded_and_windows_1252_is_read() {
        let long = format!("{}\nkurz\n", "x".repeat(1000));
        let mut r = Reader::new(std::io::BufReader::new(long.as_bytes()), b',');
        assert_eq!(r.next_record(100), Err(CsvError::TooLarge));
        // Excel on German Windows writes Windows-1252: 0xFC is ü, 0x80 the euro sign.
        let mut r = Reader::new(std::io::BufReader::new(&b"Gr\xFCn;5 \x80\n"[..]), b';');
        let rec = r.next_record(100).unwrap().unwrap();
        assert_eq!(rec.fields, ["Grün", "5 €"]);
        assert!(rec.windows_1252);
        assert_eq!(rec.bytes, 9);
    }

    #[test]
    fn the_delimiter_is_found_in_the_first_line() {
        assert_eq!(detect_delimiter(b"a;b;c\n1,5;2,5;3"), b';');
        assert_eq!(detect_delimiter(b"a,b,c\n"), b',');
        assert_eq!(detect_delimiter(b"\"a;b\",c\n"), b',', "delimiters inside quotes do not count");
        assert_eq!(detect_delimiter(b"a\tb\n"), b'\t');
        assert_eq!(detect_delimiter(b"einspaltig\n"), b',');
    }

    #[test]
    fn columns_are_typed_by_their_values() {
        let col = |v: &[&str]| infer(&v.iter().map(|s| Some(*s)).collect::<Vec<_>>(), Decimal::Auto);
        assert_eq!(col(&["true", "FALSE", ""]), FieldType::Bool);
        assert_eq!(col(&["1", "-20", "+3"]), FieldType::Int64);
        assert_eq!(col(&["01067", "10115"]), FieldType::String, "postal codes keep their leading zero");
        assert_eq!(col(&["1.5", "2", "1e3"]), FieldType::Number);
        assert_eq!(col(&["12,5", "1.234,56", "7"]), FieldType::Number);
        assert_eq!(col(&["12,5", "abc"]), FieldType::String);
        assert_eq!(col(&["2026-03-01", "01.03.2026 10:15", "2026-03-01T10:15:30.5Z"]), FieldType::Time);
        assert_eq!(col(&["2026", "2027"]), FieldType::Int64, "a year alone is a number");
        assert_eq!(col(&["", " "]), FieldType::String);
        assert_eq!(col(&["9223372036854775808"]), FieldType::Number, "beyond int64 is a number");

        // With the decimal comma chosen, a point groups thousands.
        assert_eq!(parse_number("1.234", Decimal::Comma), Some(1234.0));
        assert_eq!(parse_number("1.234", Decimal::Point), Some(1.234));
        assert_eq!(parse_number("-0,25", Decimal::Comma), Some(-0.25));
        assert_eq!(parse_number("12.34,5", Decimal::Comma), None);
        assert_eq!(parse_number("1,5", Decimal::Point), None);
        assert_eq!(parse_number("inf", Decimal::Point), None);
        assert_eq!(parse_number("1e999", Decimal::Point), None);
    }

    #[test]
    fn values_are_converted_to_their_column_type() {
        assert_eq!(convert(Some("12,5"), FieldType::Number, Decimal::Comma), json!(12.5));
        assert_eq!(convert(Some("+42"), FieldType::Int64, Decimal::Auto), json!("42"));
        assert_eq!(convert(Some(""), FieldType::Int64, Decimal::Auto), Value::Null);
        assert_eq!(convert(None, FieldType::String, Decimal::Auto), Value::Null);
        assert_eq!(convert(Some("True"), FieldType::Bool, Decimal::Auto), json!(true));
        assert_eq!(
            convert(Some("2026-03-01T10:00:00+01:00"), FieldType::Time, Decimal::Auto),
            json!(1_772_355_600_000_i64)
        );
        assert_eq!(convert(Some("01.03.2026"), FieldType::Time, Decimal::Auto), json!(1_772_323_200_000_i64));
        assert_eq!(convert(Some(" Wien "), FieldType::String, Decimal::Auto), json!(" Wien "));
    }

    #[test]
    fn header_names_are_unique() {
        let header = vec!["id".to_string(), " ".to_string(), "id".to_string()];
        assert_eq!(column_names(&header, 4), ["id", "column_2", "id_2", "column_4"]);
    }
}
