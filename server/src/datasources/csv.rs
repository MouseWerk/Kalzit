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

/// Fields a record may have; one more ends the read, before the record is held whole.
pub const MAX_COLUMNS: usize = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub enum CsvError {
    /// A record is longer than the bytes left; the caller stops and marks the result cut.
    TooLarge,
    /// A record has more than `MAX_COLUMNS` fields.
    TooManyFields,
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
    input: Source<R>,
    delimiter: u8,
    line: usize,
    /// A `\n` right after a `\r` that ended the previous record belongs to it.
    skip_lf: bool,
}

/// The bytes the reader parses: the input as it is, or UTF-16 (found by its byte order mark,
/// what Excel's "Unicode text" export writes) turned into UTF-8.
enum Source<R: BufRead> {
    Plain(R),
    Utf16(Box<Utf16<R>>),
}

impl<R: BufRead> std::io::Read for Source<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let available = self.fill_buf()?;
        let n = available.len().min(buf.len());
        buf[..n].copy_from_slice(&available[..n]);
        self.consume(n);
        Ok(n)
    }
}

impl<R: BufRead> BufRead for Source<R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        match self {
            Source::Plain(r) => r.fill_buf(),
            Source::Utf16(u) => u.fill_buf(),
        }
    }

    fn consume(&mut self, n: usize) {
        match self {
            Source::Plain(r) => r.consume(n),
            Source::Utf16(u) => u.pos += n,
        }
    }
}

/// UTF-16 to UTF-8, chunk by chunk; an unpaired surrogate or a lone last byte becomes U+FFFD.
struct Utf16<R> {
    inner: R,
    little_endian: bool,
    out: Vec<u8>,
    pos: usize,
    /// The first byte of a code unit split across chunks.
    odd: Option<u8>,
    /// A high surrogate waiting for its low half.
    high: Option<u16>,
    done: bool,
}

impl<R: BufRead> Utf16<R> {
    fn push_char(&mut self, c: char) {
        let mut buf = [0u8; 4];
        self.out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }

    fn push_unit(&mut self, unit: u16) {
        if let Some(high) = self.high.take() {
            if (0xDC00..0xE000).contains(&unit) {
                let c = 0x10000 + ((u32::from(high) - 0xD800) << 10) + (u32::from(unit) - 0xDC00);
                self.push_char(char::from_u32(c).unwrap_or('\u{FFFD}'));
                return;
            }
            self.push_char('\u{FFFD}');
        }
        match unit {
            0xD800..=0xDBFF => self.high = Some(unit),
            0xDC00..=0xDFFF => self.push_char('\u{FFFD}'),
            u => self.push_char(char::from_u32(u32::from(u)).unwrap_or('\u{FFFD}')),
        }
    }

    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        while self.pos >= self.out.len() && !self.done {
            self.out.clear();
            self.pos = 0;
            let chunk = self.inner.fill_buf()?.to_vec();
            self.inner.consume(chunk.len());
            if chunk.is_empty() {
                self.done = true;
                if self.odd.take().is_some() || self.high.take().is_some() {
                    self.push_char('\u{FFFD}');
                }
                break;
            }
            let mut bytes = chunk.into_iter();
            loop {
                let (a, b) = match (self.odd.take(), bytes.next()) {
                    (Some(a), Some(b)) => (a, b),
                    (None, Some(a)) => match bytes.next() {
                        Some(b) => (a, b),
                        None => {
                            self.odd = Some(a);
                            break;
                        }
                    },
                    (odd, None) => {
                        self.odd = odd;
                        break;
                    }
                };
                let unit = if self.little_endian { u16::from_le_bytes([a, b]) } else { u16::from_be_bytes([a, b]) };
                self.push_unit(unit);
            }
        }
        Ok(&self.out[self.pos..])
    }
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
    /// A reader of `input`; a UTF-16 byte order mark at its start switches to reading UTF-16.
    pub fn new(mut input: R, delimiter: u8) -> Self {
        let bom = input.fill_buf().ok().and_then(|b| match b {
            [0xFF, 0xFE, ..] => Some(true),
            [0xFE, 0xFF, ..] => Some(false),
            _ => None,
        });
        let input = match bom {
            Some(little_endian) => {
                input.consume(2);
                Source::Utf16(Box::new(Utf16 {
                    inner: input,
                    little_endian,
                    out: Vec::new(),
                    pos: 0,
                    odd: None,
                    high: None,
                    done: false,
                }))
            }
            None => Source::Plain(input),
        };
        Self { input, delimiter, line: 1, skip_lf: false }
    }

    /// The start of what is still to be read, as UTF-8 (to find the delimiter).
    pub fn peek(&mut self) -> std::io::Result<&[u8]> {
        self.input.fill_buf()
    }

    pub fn set_delimiter(&mut self, delimiter: u8) {
        self.delimiter = delimiter;
    }

    /// The next record that is not an empty line, or `None` at the end. A record longer than
    /// `max_bytes`, counting the empty lines skipped before it, is `TooLarge`; `bytes` of the
    /// record includes them.
    pub fn next_record(&mut self, max_bytes: usize) -> Result<Option<Record>, CsvError> {
        let mut skipped = 0;
        loop {
            match self.read_record(max_bytes.saturating_sub(skipped))? {
                Some(r) if r.fields.len() == 1 && r.fields[0].is_empty() => skipped += r.bytes,
                Some(mut r) => {
                    r.bytes += skipped;
                    return Ok(Some(r));
                }
                None => return Ok(None),
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
                        // Each field costs far more memory than its delimiter byte; stop early.
                        if fields.len() >= MAX_COLUMNS {
                            self.input.consume(used);
                            return Err(CsvError::TooManyFields);
                        }
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
        FieldType::Time | FieldType::Date => parse_time(v).map_or(Value::Null, Value::from),
        // Files are not typed as decimals; a decimal column keeps the number's own text.
        FieldType::Decimal => parse_number(v, decimal)
            .filter(|x| x.is_finite())
            .map_or(Value::Null, |x| Value::String(crate::analysis::expr::number_text(x))),
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
    // One sign at most: `--5` and `+-5` are text.
    if unsigned.starts_with(['+', '-']) {
        return None;
    }
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
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::with_capacity(count);
    // The next suffix to try per base name, so repeats cost one lookup each, not a search.
    let mut next: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for i in 0..count {
        let base = header
            .get(i)
            .map(|h| h.trim())
            .filter(|h| !h.is_empty())
            .map_or_else(|| format!("column_{}", i + 1), String::from);
        let mut name = base.clone();
        if taken.contains(&name) {
            let n = next.entry(base.clone()).or_insert(2);
            loop {
                name = format!("{base}_{n}");
                *n += 1;
                if !taken.contains(&name) {
                    break;
                }
            }
        }
        taken.insert(name.clone());
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

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use std::io::BufReader;
    use std::time::{Duration, Instant};

    /// Small deterministic generator, so the fuzz run is reproducible.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
    }

    fn all_records(text: &[u8], cap: usize, max: usize) -> Vec<Result<Vec<String>, CsvError>> {
        let mut r = Reader::new(BufReader::with_capacity(cap, text), b',');
        let mut out = Vec::new();
        for _ in 0..10_000 {
            match r.next_record(max) {
                Ok(Some(rec)) => out.push(Ok(rec.fields)),
                Ok(None) => break,
                Err(e) => {
                    out.push(Err(e));
                    break;
                }
            }
        }
        out
    }

    /// Random bytes from a CSV-ish alphabet: no panic, and the result must not depend on where
    /// the reader's buffer boundaries fall (a `\r` at the end of one buffer, `\n` at the start of
    /// the next, `""` split across buffers).
    #[test]
    fn fuzz_buffer_boundaries_do_not_change_records() {
        let alphabet: &[u8] = b"ab,\"\r\n;\xFC\xC3\xA4 ";
        let mut rng = Lcg(42);
        for _ in 0..3_000 {
            let len = (rng.next() % 64) as usize;
            let text: Vec<u8> = (0..len).map(|_| alphabet[(rng.next() as usize) % alphabet.len()]).collect();
            let big = all_records(&text, 64 * 1024, 1 << 20);
            for cap in [1, 2, 3, 7] {
                assert_eq!(all_records(&text, cap, 1 << 20), big, "cap {cap}, input {text:?}");
            }
        }
    }

    /// Fields written by the RFC 4180 rules come back as written.
    #[test]
    fn fuzz_round_trip() {
        let alphabet: &[u8] = b"ab,\"\r\n; x";
        let mut rng = Lcg(7);
        for _ in 0..3_000 {
            let cols = 1 + (rng.next() % 4) as usize;
            let rows = 1 + (rng.next() % 4) as usize;
            let mut expected = Vec::new();
            let mut text = String::new();
            for _ in 0..rows {
                let mut row = Vec::new();
                for c in 0..cols {
                    let len = 1 + (rng.next() % 6) as usize;
                    let f: String =
                        (0..len).map(|_| alphabet[(rng.next() as usize) % alphabet.len()] as char).collect();
                    if c > 0 {
                        text.push(',');
                    }
                    text.push('"');
                    text.push_str(&f.replace('"', "\"\""));
                    text.push('"');
                    row.push(f);
                }
                text.push_str(if rng.next().is_multiple_of(2) { "\r\n" } else { "\n" });
                expected.push(Ok(row));
            }
            assert_eq!(all_records(text.as_bytes(), 3, 1 << 20), expected, "{text:?}");
        }
    }

    /// Empty lines are skipped inside `next_record`, each with a fresh byte count, so a file of
    /// blank lines is read to its end however small `max_bytes` is.
    #[test]
    fn empty_lines_count_against_the_byte_limit() {
        let mut text = vec![b'\n'; 8 * 1024 * 1024];
        text.extend_from_slice(b"hinter den Leerzeilen\n");
        let mut r = Reader::new(BufReader::new(&text[..]), b',');
        let got = r.next_record(1024);
        assert!(matches!(got, Err(CsvError::TooLarge)), "8 MiB were read for a 1 KiB limit: {got:?}");
    }

    /// A header of repeated names: `column_names` searches the names so far for every candidate
    /// (quadratic per name, cubic overall). 3,000 equal names are a 6 KB header line.
    #[test]
    fn repeated_header_names_stay_fast() {
        let header: Vec<String> = vec!["a".to_string(); 3_000];
        let started = Instant::now();
        let names = column_names(&header, header.len());
        let took = started.elapsed();
        assert_eq!(names.len(), 3_000);
        assert!(took < Duration::from_secs(1), "3,000 repeated names took {took:?}");
    }

    #[test]
    fn signs_are_read_once() {
        assert_eq!(parse_number("--5", Decimal::Point), None, "--5 is not a number");
        assert_eq!(parse_number("+-5", Decimal::Point), None, "+-5 is not a number");
    }

    /// Excel's "Unicode text" export is UTF-16 LE with a BOM; it reads as Windows-1252 noise.
    #[test]
    fn utf16_files_are_not_read_as_windows_1252() {
        let mut text = vec![0xFF, 0xFE];
        for u in "a;b\r\n1;2\r\n".encode_utf16() {
            text.extend_from_slice(&u.to_le_bytes());
        }
        let mut input = BufReader::new(&text[..]);
        skip_bom(&mut input).unwrap();
        let mut r = Reader::new(input, b';');
        let rec = r.next_record(1 << 20).unwrap().unwrap();
        assert_eq!(rec.fields, ["a", "b"], "UTF-16 read as {:?}", rec.fields);
        assert_eq!(r.next_record(1 << 20).unwrap().unwrap().fields, ["1", "2"]);
        assert_eq!(r.next_record(1 << 20).unwrap(), None);
    }

    /// Big-endian UTF-16 too, with characters outside the BMP split across tiny buffers; an
    /// unpaired surrogate becomes U+FFFD.
    #[test]
    fn utf16_big_endian_and_surrogates() {
        let mut text = vec![0xFE, 0xFF];
        for u in "Grün;😀\n".encode_utf16() {
            text.extend_from_slice(&u.to_be_bytes());
        }
        text.extend_from_slice(&0xD800u16.to_be_bytes());
        text.extend_from_slice(&u16::from(b'x').to_be_bytes());
        let mut r = Reader::new(BufReader::with_capacity(3, &text[..]), b';');
        assert_eq!(r.next_record(1 << 20).unwrap().unwrap().fields, ["Grün", "😀"]);
        assert_eq!(r.next_record(1 << 20).unwrap().unwrap().fields, ["\u{FFFD}x"]);
    }
}

/// CSV files and every cell in them come from users: reading and converting answer with a value
/// or an error, never a panic.
#[cfg(test)]
mod property_tests {
    use super::*;
    use proptest::prelude::*;

    fn read_all(bytes: &[u8], delimiter: Option<u8>) {
        let mut input = std::io::BufReader::with_capacity(16, bytes);
        if skip_bom(&mut input).is_err() {
            return;
        }
        let mut r = Reader::new(input, delimiter.unwrap_or(b','));
        if delimiter.is_none() {
            let Ok(start) = r.peek() else { return };
            let d = detect_delimiter(start);
            r.set_delimiter(d);
        }
        for _ in 0..1000 {
            match r.next_record(256) {
                Ok(Some(rec)) => {
                    let present: Vec<&str> = rec.fields.iter().map(String::as_str).collect();
                    let cells: Vec<Option<&str>> = present.iter().map(|c| Some(*c)).collect();
                    for decimal in [Decimal::Auto, Decimal::Point, Decimal::Comma] {
                        let decimal = resolve_decimal(&present, decimal);
                        let ty = infer(&cells, decimal);
                        for cell in &cells {
                            let _ = convert(*cell, ty, decimal);
                        }
                    }
                    let _ = column_names(&rec.fields, rec.fields.len() + 2);
                }
                Ok(None) | Err(_) => break,
            }
        }
    }

    proptest! {
        // 256 cases (proptest's default), bounded for CI; PROPTEST_CASES raises it locally.
        #![proptest_config(ProptestConfig::default())]

        #[test]
        fn reader_never_panics_on_any_bytes(
            bytes in prop::collection::vec(any::<u8>(), 0..600),
            d in prop::option::of(any::<u8>()),
        ) {
            read_all(&bytes, d);
        }

        #[test]
        fn reader_never_panics_on_csv_like_text(
            text in "\u{FEFF}?([a-z0-9 .,;\t\"|-]{0,12}(\r\n|\n|\r))*",
            d in prop::option::of(prop::sample::select(vec![b',', b';', b'\t', b'|', b'"', b'\n'])),
        ) {
            read_all(text.as_bytes(), d);
        }

        #[test]
        fn cell_parsers_never_panic(v in "\\PC{0,40}", w in "[-+0-9.,eE: TZ]{0,30}") {
            for decimal in [Decimal::Auto, Decimal::Point, Decimal::Comma] {
                let _ = parse_number(&v, decimal);
                let _ = parse_number(&w, decimal);
            }
            let _ = parse_time(&v);
            let _ = parse_time(&w);
        }
    }
}
