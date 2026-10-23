//! Export files from a frame: CSV, JSON and Excel (docs/api/datasources.md, "Export"). Documents
//! (JSON, NDJSON) and graphs (GraphML, JSON) get their own encoders with M2 and M3; the route
//! already picks the encoder by the shape of the result.
//!
//! Excel files are written with `rust_xlsxwriter`: maintained by the author of the Python
//! XlsxWriter and libxlsxwriter, pure Rust, no default features, and it writes real cells (numbers,
//! dates, booleans), never formulas. Writing them on the server keeps the export behind the
//! server's permission check; a browser library would need the data in the browser first.

use std::io::Write;

use rust_xlsxwriter::{Format, Workbook};
use serde_json::Value;

use super::expr::{iso_time, number_text};
use super::steps::{Control, int_of};
use crate::datasources::detail::Detail;
use crate::shapes::{ExportFormat, ExportLanguage, FieldType, Frame, FrameMeta};

/// An encoded file, in chunks the response sends one after the other, so the file is held once.
#[derive(Debug)]
pub struct File {
    pub chunks: Vec<Vec<u8>>,
    pub content_type: &'static str,
    pub extension: &'static str,
}

impl File {
    /// The whole file in one piece (for tests and small callers).
    pub fn bytes(&self) -> Vec<u8> {
        self.chunks.concat()
    }
}

/// Excel's sheet limits: rows including the header, and columns.
pub const XLSX_MAX_ROWS: usize = 1_048_576;
pub const XLSX_MAX_COLUMNS: usize = 16_384;
const XLSX_MAX_TEXT: usize = 32_767;
/// The largest file an export writes; CSV and JSON stop as soon as they would pass it.
pub const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
/// Cells an Excel file may hold: the writer keeps every cell in memory until the file is done
/// (about 360 bytes per cell measured), so this bounds an Excel export near the file limit.
pub const XLSX_MAX_CELLS: usize = 1_000_000;
/// The size of one chunk of a file being written.
const CHUNK: usize = 1024 * 1024;

/// The limits a file is written within; tests make them small.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub file_bytes: usize,
    pub xlsx_cells: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self { file_bytes: MAX_FILE_BYTES, xlsx_cells: XLSX_MAX_CELLS }
    }
}

fn too_large(max: usize) -> Detail {
    Detail::new("export.too_large", format!("the file would be larger than {max} bytes")).with("max", max)
}

/// Collects a file in chunks, failing as soon as it would pass the size limit and looking at the
/// control (cancel flag, deadline) now and then, so a long encode stops in time.
struct Sink<'a> {
    chunks: Vec<Vec<u8>>,
    current: Vec<u8>,
    total: usize,
    max: usize,
    writes: usize,
    control: &'a Control,
    failure: Option<Detail>,
}

impl<'a> Sink<'a> {
    fn new(max: usize, control: &'a Control) -> Self {
        Self {
            chunks: Vec::new(),
            current: Vec::with_capacity(CHUNK),
            total: 0,
            max,
            writes: 0,
            control,
            failure: None,
        }
    }

    fn fail(&mut self, d: Detail) -> std::io::Error {
        self.failure = Some(d);
        std::io::Error::other("export stopped")
    }

    /// The reason the writing stopped, from an error of `write`.
    fn reason(&mut self, e: std::io::Error) -> Detail {
        self.failure.take().unwrap_or_else(|| {
            Detail::new("export.failed", format!("the file could not be written: {e}")).with("detail", &e)
        })
    }

    fn finish(mut self) -> Vec<Vec<u8>> {
        if !self.current.is_empty() {
            self.chunks.push(std::mem::take(&mut self.current));
        }
        self.chunks
    }
}

impl Write for Sink<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.total + buf.len() > self.max {
            return Err(self.fail(too_large(self.max)));
        }
        if let Err(d) = self.control.every(self.writes) {
            return Err(self.fail(d));
        }
        self.writes += 1;
        self.total += buf.len();
        self.current.extend_from_slice(buf);
        if self.current.len() >= CHUNK {
            let full = std::mem::replace(&mut self.current, Vec::with_capacity(CHUNK));
            self.chunks.push(full);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn encode(
    frame: &Frame,
    name: &str,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
) -> Result<File, Detail> {
    encode_within(frame, name, format, language, control, Caps::default())
}

pub fn encode_within(
    frame: &Frame,
    name: &str,
    format: ExportFormat,
    language: ExportLanguage,
    control: &Control,
    caps: Caps,
) -> Result<File, Detail> {
    match format {
        ExportFormat::Csv => Ok(File {
            chunks: csv_within(frame, language, control, caps.file_bytes)?,
            content_type: "text/csv; charset=utf-8",
            extension: "csv",
        }),
        ExportFormat::Json => Ok(File {
            chunks: json_within(frame, control, caps.file_bytes)?,
            content_type: "application/json",
            extension: "json",
        }),
        ExportFormat::Xlsx => Ok(File {
            chunks: vec![xlsx_within(frame, name, control, caps)?],
            content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            extension: "xlsx",
        }),
    }
}

/// The result envelope of the frame, `{"shape": "frame", "frame": {...}}`, written straight from
/// the frame (no copy of it) and without the statement as sent to the database: a file goes
/// elsewhere, the query text stays in Kalzit.
fn json_within(frame: &Frame, control: &Control, max: usize) -> Result<Vec<Vec<u8>>, Detail> {
    let mut sink = Sink::new(max, control);
    let written = (|| -> std::io::Result<()> {
        sink.write_all(br#"{"shape":"frame","frame":{"fields":"#)?;
        serde_json::to_writer(&mut sink, frame.fields()).map_err(std::io::Error::other)?;
        if let Some(meta) = frame.meta() {
            sink.write_all(br#","meta":"#)?;
            let meta = FrameMeta { executed_query: None, ..meta.clone() };
            serde_json::to_writer(&mut sink, &meta).map_err(std::io::Error::other)?;
        }
        sink.write_all(b"}}")
    })();
    match written {
        Ok(()) => Ok(sink.finish()),
        Err(e) => Err(sink.reason(e)),
    }
}

/// Text cells a spreadsheet would read as a formula get a leading `'`, so a value from the data
/// can never run as one: `=`, `+`, `-`, `@` (also their full-width forms) after any leading
/// spaces, line breaks or invisible characters, and a leading tab or carriage return (DDE such as
/// `=cmd|...` starts with `=`).
fn defuse(text: &str) -> String {
    let lead = text.trim_start_matches([' ', '\n', '\u{00A0}', '\u{200B}', '\u{FEFF}', '\u{3000}']);
    let risky = text.starts_with(['\t', '\r'])
        || lead.starts_with(['=', '+', '-', '@', '\t', '\r', '\u{FF1D}', '\u{FF0B}', '\u{FF0D}', '\u{FF20}']);
    if risky { format!("'{text}") } else { text.to_string() }
}

/// A time cell's ms: fractions of a millisecond are cut (floor), never dropped.
fn time_ms(n: &serde_json::Number) -> Option<i64> {
    n.as_i64().or_else(|| n.as_f64().filter(|x| x.is_finite() && x.abs() < 9.2e18).map(|x| x.floor() as i64))
}

fn csv_cell(value: &Value, field_type: FieldType, language: ExportLanguage) -> String {
    let decimal = |s: String| if language == ExportLanguage::De { s.replace('.', ",") } else { s };
    match (field_type, value) {
        (_, Value::Null) => String::new(),
        (FieldType::Time, Value::Number(n)) => time_ms(n).map(iso_time).unwrap_or_default(),
        (FieldType::Number, Value::Number(n)) => n.as_f64().map(|x| decimal(number_text(x))).unwrap_or_default(),
        // Digits as they are; anything else in an int64 field is text and defused.
        (FieldType::Int64, Value::String(s)) => match int_of(value) {
            Some(_) if s.bytes().all(|b| b.is_ascii_digit() || b == b'-') => s.clone(),
            _ => defuse(s),
        },
        (FieldType::Json, v) => v.to_string(),
        (_, Value::String(s)) => defuse(s),
        (_, Value::Bool(b)) => b.to_string(),
        (_, v) => v.to_string(),
    }
}

fn quote(cell: &str, separator: char) -> String {
    let needs =
        cell.contains([separator, '"', '\n', '\r']) || cell.starts_with([' ', '\t']) || cell.ends_with([' ', '\t']);
    if needs { format!("\"{}\"", cell.replace('"', "\"\"")) } else { cell.to_string() }
}

/// RFC 4180 CSV with a byte order mark, so Excel opens it as UTF-8, and CRLF line ends. Times
/// are ISO 8601 in UTC; numbers keep every digit and use the language's decimal mark.
pub fn csv(frame: &Frame, language: ExportLanguage) -> Vec<u8> {
    csv_within(frame, language, &Control::unbounded(), usize::MAX).expect("no limit without a control").concat()
}

/// `csv` within the file size limit, stopping when the control says so. Rows are written one by
/// one into the chunks, so the file is never held twice.
fn csv_within(frame: &Frame, language: ExportLanguage, control: &Control, max: usize) -> Result<Vec<Vec<u8>>, Detail> {
    let separator = if language == ExportLanguage::De { ';' } else { ',' };
    let sep = separator.to_string();
    let mut sink = Sink::new(max, control);
    let written = (|| -> std::io::Result<()> {
        let header: Vec<String> = frame.fields().iter().map(|f| quote(&defuse(&f.name), separator)).collect();
        sink.write_all("\u{FEFF}".as_bytes())?;
        sink.write_all(header.join(&sep).as_bytes())?;
        sink.write_all(b"\r\n")?;
        let mut line = String::new();
        for row in 0..frame.rows() {
            line.clear();
            for (i, f) in frame.fields().iter().enumerate() {
                if i > 0 {
                    line.push_str(&sep);
                }
                line.push_str(&quote(&csv_cell(&f.values[row], f.field_type, language), separator));
            }
            line.push_str("\r\n");
            sink.write_all(line.as_bytes())?;
        }
        Ok(())
    })();
    match written {
        Ok(()) => Ok(sink.finish()),
        Err(e) => Err(sink.reason(e)),
    }
}

/// A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`, not the reserved
/// "History".
fn sheet_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c) && !c.is_control()).take(31).collect();
    let clean = clean.trim_matches('\'').to_string();
    if clean.trim().is_empty() || clean.trim().eq_ignore_ascii_case("history") { "Kalzit".into() } else { clean }
}

/// Text cut at Excel's 32,767 UTF-16 units, never inside a character.
fn truncate(text: &str) -> &str {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        units += c.len_utf16();
        if units > XLSX_MAX_TEXT {
            return &text[..i];
        }
    }
    text
}

/// Days since 1899-12-30, Excel's date numbers; Excel shows dates from 1900-03-01 on.
fn excel_date(ms: i64) -> Option<f64> {
    const FIRST: i64 = -2_203_891_200_000; // 1900-03-01T00:00:00Z
    (ms >= FIRST).then(|| ms as f64 / 86_400_000.0 + 25_569.0)
}

fn xlsx_error(e: rust_xlsxwriter::XlsxError) -> Detail {
    Detail::new("export.failed", format!("the file could not be written: {e}")).with("detail", &e)
}

/// One sheet: a bold, frozen header row and typed cells. Numbers, booleans and times are cells of
/// their type (times in UTC); int64 beyond 2^53 and times before 1900-03-01 are text, so no digit
/// is lost; text longer than Excel's 32,767 characters is cut there.
pub fn xlsx(frame: &Frame, name: &str) -> Result<Vec<u8>, Detail> {
    xlsx_within(frame, name, &Control::unbounded(), Caps::default())
}

fn xlsx_within(frame: &Frame, name: &str, control: &Control, caps: Caps) -> Result<Vec<u8>, Detail> {
    // Refused before a single cell is built: the writer holds them all until the end.
    if frame.rows().saturating_mul(frame.fields().len()) > caps.xlsx_cells {
        return Err(Detail::new(
            "export.too_many_cells",
            format!("an Excel file takes at most {} cells; export as CSV", caps.xlsx_cells),
        )
        .with("max", caps.xlsx_cells));
    }
    if frame.rows() + 1 > XLSX_MAX_ROWS {
        return Err(Detail::new("export.too_many_rows", format!("Excel takes at most {} rows", XLSX_MAX_ROWS - 1))
            .with("max", XLSX_MAX_ROWS - 1));
    }
    if frame.fields().len() > XLSX_MAX_COLUMNS {
        return Err(Detail::new("export.too_many_columns", format!("Excel takes at most {XLSX_MAX_COLUMNS} columns"))
            .with("max", XLSX_MAX_COLUMNS));
    }
    let mut book = Workbook::new();
    let sheet = book.add_worksheet();
    sheet.set_name(sheet_name(name)).map_err(xlsx_error)?;
    let bold = Format::new().set_bold();
    let date = Format::new().set_num_format("yyyy-mm-dd hh:mm:ss.000");
    for (c, field) in frame.fields().iter().enumerate() {
        let col = c as u16;
        sheet.write_string_with_format(0, col, truncate(&field.name), &bold).map_err(xlsx_error)?;
        if field.field_type == FieldType::Time {
            sheet.set_column_width(col, 22).map_err(xlsx_error)?;
        }
        for (r, value) in field.values.iter().enumerate() {
            control.every(r)?;
            let row = r as u32 + 1;
            let result = match (field.field_type, value) {
                (_, Value::Null) => continue,
                (FieldType::Time, Value::Number(n)) => match time_ms(n) {
                    Some(ms) => match excel_date(ms) {
                        Some(d) => sheet.write_number_with_format(row, col, d, &date),
                        None => sheet.write_string(row, col, iso_time(ms)),
                    },
                    None => continue,
                },
                (FieldType::Int64, Value::String(s)) => match int_of(value) {
                    Some(n) if n.unsigned_abs() <= 1 << 53 => sheet.write_number(row, col, n as f64),
                    _ => sheet.write_string(row, col, truncate(s)),
                },
                (_, Value::Number(n)) => match n.as_f64() {
                    Some(x) => sheet.write_number(row, col, x),
                    None => continue,
                },
                (_, Value::Bool(b)) => sheet.write_boolean(row, col, *b),
                (_, Value::String(s)) => sheet.write_string(row, col, truncate(s)),
                (_, other) => sheet.write_string(row, col, truncate(&other.to_string())),
            };
            result.map_err(xlsx_error)?;
        }
    }
    sheet.set_freeze_panes(1, 0).map_err(xlsx_error)?;
    control.check()?;
    let bytes = book.save_to_buffer().map_err(xlsx_error)?;
    if bytes.len() > caps.file_bytes {
        return Err(too_large(caps.file_bytes));
    }
    Ok(bytes)
}

/// A file name of letters, digits, `-` and `_` only, for `Content-Disposition`.
pub fn file_name(base: &str, extension: &str) -> String {
    let mut clean = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            clean.push(c);
        } else if !clean.ends_with('-') {
            clean.push('-');
        }
        if clean.len() >= 80 {
            break;
        }
    }
    let clean = clean.trim_matches('-');
    format!("{}.{extension}", if clean.is_empty() { "kalzit-export" } else { clean })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{Field, QueryResult};
    use serde_json::json;
    use std::io::Read;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn sample() -> Frame {
        Frame::new(vec![
            field(
                "zeit",
                FieldType::Time,
                vec![json!(1_767_225_600_000_i64), Value::Null, json!(-2_208_988_800_000_i64)],
            ),
            field("betrag", FieldType::Number, vec![json!(1234.5), json!(-0.25), json!(1e21)]),
            field("stück", FieldType::Int64, vec![json!("9007199254740993"), json!("7"), Value::Null]),
            field(
                "text",
                FieldType::String,
                vec![json!("a;b,\"c\""), json!("=HYPERLINK(\"x\")"), json!(" Zeile\nzwei ")],
            ),
            field("ok", FieldType::Bool, vec![json!(true), json!(false), Value::Null]),
            field("roh", FieldType::Json, vec![json!({ "a": [1, "x"] }), Value::Null, json!("-1")]),
        ])
        .unwrap()
    }

    #[test]
    fn german_csv_uses_semicolons_decimal_commas_and_a_bom() {
        let text = String::from_utf8(csv(&sample(), ExportLanguage::De)).unwrap();
        assert!(text.starts_with('\u{FEFF}'), "BOM for Excel");
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[0], "zeit;betrag;stück;text;ok;roh");
        assert_eq!(
            lines[1],
            "2026-01-01T00:00:00.000Z;1234,5;9007199254740993;\"a;b,\"\"c\"\"\";true;\"{\"\"a\"\":[1,\"\"x\"\"]}\""
        );
        assert_eq!(lines[2], ";-0,25;7;\"'=HYPERLINK(\"\"x\"\")\";false;");
        // A line break inside a quoted cell stays a bare LF; rows end with CRLF.
        assert_eq!(lines[3], "1900-01-01T00:00:00.000Z;1e+21;;\" Zeile\nzwei \";;\"\"\"-1\"\"\"");
        assert_eq!(lines[4], "", "every row ends with CRLF");
    }

    #[test]
    fn english_csv_uses_commas_and_decimal_points() {
        let text = String::from_utf8(csv(&sample(), ExportLanguage::En)).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[0], "zeit,betrag,stück,text,ok,roh");
        assert!(
            lines[1].starts_with("2026-01-01T00:00:00.000Z,1234.5,9007199254740993,\"a;b,\"\"c\"\"\",true,"),
            "{}",
            lines[1]
        );
        assert!(lines[2].starts_with(",-0.25,7,"), "{}", lines[2]);
    }

    #[test]
    fn header_names_are_defused_and_quoted_too() {
        let frame = Frame::new(vec![
            field("=SUM(A1)", FieldType::Number, vec![json!(1)]),
            field("a,b", FieldType::Number, vec![json!(2)]),
        ])
        .unwrap();
        let text = String::from_utf8(csv(&frame, ExportLanguage::En)).unwrap();
        assert!(text.starts_with("\u{FEFF}'=SUM(A1),\"a,b\"\r\n1,2\r\n"), "{text:?}");
        assert_eq!(String::from_utf8(csv(&Frame::new(vec![]).unwrap(), ExportLanguage::De)).unwrap(), "\u{FEFF}\r\n");
    }

    #[test]
    fn json_is_the_result_envelope() {
        let file = encode(&sample(), "A", ExportFormat::Json, ExportLanguage::De, &Control::unbounded()).unwrap();
        let back: QueryResult = serde_json::from_slice(&file.bytes()).unwrap();
        assert_eq!(back, QueryResult::Frame { frame: sample() });
        assert_eq!(file.content_type, "application/json");
    }

    /// The parts of an xlsx file: a zip archive whose sheet holds the cells.
    fn sheet_xml(bytes: &[u8]) -> (String, String) {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut read = |name: &str| {
            let mut s = String::new();
            zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        (read("xl/worksheets/sheet1.xml"), read("xl/sharedStrings.xml"))
    }

    #[test]
    fn excel_files_hold_typed_cells() {
        let file =
            encode(&sample(), "Umsatz: A/B", ExportFormat::Xlsx, ExportLanguage::De, &Control::unbounded()).unwrap();
        let bytes = file.bytes();
        assert_eq!(&bytes[..2], b"PK", "a zip archive");
        let (sheet, strings) = sheet_xml(&bytes);
        // 2026-01-01 is Excel day 46023; numbers stay numbers, the big int64 stays text.
        assert!(sheet.contains("<v>46023</v>"), "{sheet}");
        assert!(sheet.contains("<v>1234.5</v>") && sheet.contains("<v>-0.25</v>"), "{sheet}");
        assert!(sheet.contains("<v>7</v>"), "{sheet}");
        assert!(sheet.contains(r#"t="b""#), "booleans are boolean cells: {sheet}");
        assert!(!sheet.contains("<f>"), "no formulas: {sheet}");
        assert!(strings.contains("9007199254740993"), "{strings}");
        assert!(strings.contains("=HYPERLINK"), "kept as text: {strings}");
        assert!(strings.contains("1900-01-01T00:00:00.000Z"), "before 1900-03-01 as text: {strings}");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).unwrap();
        let mut book = String::new();
        zip.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
        assert!(book.contains(r#"name="Umsatz AB""#), "{book}");
    }

    #[test]
    fn excel_limits_and_long_text() {
        let long = Frame::new(vec![field("t", FieldType::String, vec![json!("ä".repeat(40_000))])]).unwrap();
        let (_, strings) = sheet_xml(&xlsx(&long, "x").unwrap());
        assert_eq!(strings.matches('ä').count(), XLSX_MAX_TEXT);
        let wide =
            Frame::new((0..=XLSX_MAX_COLUMNS).map(|i| field(&format!("f{i}"), FieldType::Number, vec![])).collect())
                .unwrap();
        assert_eq!(xlsx(&wide, "x").unwrap_err().reason, "export.too_many_columns");
    }

    #[test]
    fn names_for_files_and_sheets() {
        assert_eq!(file_name("Umsatz 2026 / Österreich", "csv"), "Umsatz-2026-sterreich.csv");
        assert_eq!(file_name("../../etc/passwd", "json"), "etc-passwd.json");
        assert_eq!(file_name("", "xlsx"), "kalzit-export.xlsx");
        assert_eq!(file_name("\"\r\n", "csv"), "kalzit-export.csv");
        assert_eq!(sheet_name("[]:*?/\\"), "Kalzit");
        assert_eq!(sheet_name(&"x".repeat(40)).len(), 31);
        assert_eq!(sheet_name("History"), "Kalzit", "Excel reserves it");
        assert_eq!(sheet_name(" history "), "Kalzit");
    }

    #[test]
    fn excel_text_is_cut_by_utf16_units_never_inside_a_character() {
        let text = format!("{}{}", "a".repeat(XLSX_MAX_TEXT - 1), "😀😀");
        let cut = truncate(&text);
        assert_eq!(cut.chars().map(char::len_utf16).sum::<usize>(), XLSX_MAX_TEXT - 1);
        assert!(cut.chars().all(|c| c == 'a'));
    }

    #[test]
    fn odd_int64_text_and_fractional_times_in_csv() {
        let frame = Frame::new(vec![
            field("i", FieldType::Int64, vec![json!("=1+1"), json!("-12"), json!(" 7")]),
            field("t", FieldType::Time, vec![json!(1_767_225_600_000.9), json!(-0.5), Value::Null]),
        ])
        .unwrap();
        let text = String::from_utf8(csv(&frame, ExportLanguage::En)).unwrap();
        let lines: Vec<&str> = text.trim_start_matches('\u{FEFF}').split("\r\n").collect();
        assert_eq!(lines[1], "'=1+1,2026-01-01T00:00:00.000Z");
        assert_eq!(lines[2], "-12,1969-12-31T23:59:59.999Z");
        assert_eq!(lines[3], "\" 7\",");
    }

    fn caps(file_bytes: usize, xlsx_cells: usize) -> Caps {
        Caps { file_bytes, xlsx_cells }
    }

    fn reason_of(format: ExportFormat, frame: &Frame, c: Caps) -> &'static str {
        encode_within(frame, "A", format, ExportLanguage::En, &Control::unbounded(), c)
            .map_or_else(|d| d.reason, |_| "ok")
    }

    /// Excel holds every cell until the file is done, so too many cells are refused first.
    #[test]
    fn excel_files_are_refused_above_the_cell_limit_before_building() {
        let frame = sample(); // 3 rows of 6 fields
        assert_eq!(reason_of(ExportFormat::Xlsx, &frame, caps(MAX_FILE_BYTES, 17)), "export.too_many_cells");
        assert_eq!(reason_of(ExportFormat::Xlsx, &frame, caps(MAX_FILE_BYTES, 18)), "ok");
        // The finished workbook is held to the file limit too.
        assert_eq!(reason_of(ExportFormat::Xlsx, &frame, caps(100, 18)), "export.too_large");
    }

    /// CSV and JSON stop at the first write past the limit; what they wrote is what they send.
    #[test]
    fn csv_and_json_stop_at_the_file_limit() {
        let frame = sample();
        let full = csv(&frame, ExportLanguage::En).len();
        let header = "\u{FEFF}zeit,betrag,stück,text,ok,roh\r\n".len();
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(full, 1)), "ok");
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(full - 1, 1)), "export.too_large", "the last row");
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(header + 1, 1)), "export.too_large", "the first row");
        assert_eq!(reason_of(ExportFormat::Csv, &frame, caps(3, 1)), "export.too_large", "the header");
        let json = encode(&frame, "A", ExportFormat::Json, ExportLanguage::En, &Control::unbounded()).unwrap().bytes();
        assert_eq!(reason_of(ExportFormat::Json, &frame, caps(json.len(), 1)), "ok");
        assert_eq!(reason_of(ExportFormat::Json, &frame, caps(json.len() - 1, 1)), "export.too_large");
        let big = Frame::new(vec![field("t", FieldType::String, vec![json!("x".repeat(1024)); 3 * 1024])]).unwrap();
        let file = encode(&big, "A", ExportFormat::Csv, ExportLanguage::En, &Control::unbounded()).unwrap();
        assert!(file.chunks.len() >= 3, "written in chunks, not one buffer");
    }

    /// The statement as sent to the database stays in Kalzit.
    #[test]
    fn json_files_leave_out_the_executed_statement() {
        let frame = sample().with_meta(FrameMeta {
            executed_query: Some("SELECT secret FROM t".into()),
            rows_truncated: true,
            notices: vec![],
        });
        let bytes = encode(&frame, "A", ExportFormat::Json, ExportLanguage::En, &Control::unbounded()).unwrap().bytes();
        let text = String::from_utf8(bytes).unwrap();
        assert!(!text.contains("SELECT secret"), "{text}");
        let back: QueryResult = serde_json::from_str(&text).unwrap();
        let QueryResult::Frame { frame: back } = back else { panic!() };
        assert_eq!((back.meta().unwrap().rows_truncated, back.rows()), (true, 3));
    }

    #[test]
    fn invisible_characters_before_a_formula_are_defused() {
        for risky in ["\u{200B}=1", "\u{FEFF}+1", "\u{00A0}@x", " \n-1", "\u{3000}=1"] {
            assert!(defuse(risky).starts_with('\''), "{risky:?}");
        }
        assert_eq!(defuse("a=1"), "a=1");
    }

    #[test]
    fn a_control_stops_the_encoder() {
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let err = encode(&sample(), "A", ExportFormat::Csv, ExportLanguage::En, &Control::new(flag, 30)).unwrap_err();
        assert_eq!(err.reason, "steps.cancelled");
    }
}
