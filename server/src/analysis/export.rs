//! Export files from a frame: CSV, JSON and Excel (docs/api/datasources.md, "Export"). Documents
//! (JSON, NDJSON) and graphs (GraphML, JSON) get their own encoders with M2 and M3; the route
//! already picks the encoder by the shape of the result.
//!
//! Excel files are written with `rust_xlsxwriter`: maintained by the author of the Python
//! XlsxWriter and libxlsxwriter, pure Rust, no default features, and it writes real cells (numbers,
//! dates, booleans), never formulas. Writing them on the server keeps the export behind the
//! server's permission check; a browser library would need the data in the browser first.

use rust_xlsxwriter::{Format, Workbook};
use serde_json::Value;

use super::expr::{iso_time, number_text};
use crate::datasources::detail::Detail;
use crate::shapes::{ExportFormat, ExportLanguage, FieldType, Frame, QueryResult};

/// An encoded file.
#[derive(Debug)]
pub struct File {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
    pub extension: &'static str,
}

/// Excel's sheet limits: rows including the header, and columns.
pub const XLSX_MAX_ROWS: usize = 1_048_576;
pub const XLSX_MAX_COLUMNS: usize = 16_384;
const XLSX_MAX_TEXT: usize = 32_767;

pub fn encode(frame: &Frame, name: &str, format: ExportFormat, language: ExportLanguage) -> Result<File, Detail> {
    match format {
        ExportFormat::Csv => Ok(File { bytes: csv(frame, language), content_type: "text/csv; charset=utf-8", extension: "csv" }),
        ExportFormat::Json => Ok(File {
            bytes: serde_json::to_vec(&QueryResult::Frame { frame: frame.clone() })
                .map_err(|e| Detail::new("export.failed", format!("the file could not be written: {e}")).with("detail", &e))?,
            content_type: "application/json",
            extension: "json",
        }),
        ExportFormat::Xlsx => Ok(File {
            bytes: xlsx(frame, name)?,
            content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            extension: "xlsx",
        }),
    }
}

/// Text cells Excel would read as a formula (`=`, `+`, `-`, `@`, tab, carriage return at the
/// start) get a leading `'`, so a value from the data can never run as one.
fn defuse(text: &str) -> String {
    if text.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{text}") } else { text.to_string() }
}

fn csv_cell(value: &Value, field_type: FieldType, language: ExportLanguage) -> String {
    let decimal = |s: String| if language == ExportLanguage::De { s.replace('.', ",") } else { s };
    match (field_type, value) {
        (_, Value::Null) => String::new(),
        (FieldType::Time, Value::Number(n)) => n.as_i64().map(iso_time).unwrap_or_default(),
        (FieldType::Number, Value::Number(n)) => n.as_f64().map(|x| decimal(number_text(x))).unwrap_or_default(),
        (FieldType::Int64, Value::String(s)) => s.clone(),
        (FieldType::Json, v) => v.to_string(),
        (_, Value::String(s)) => defuse(s),
        (_, Value::Bool(b)) => b.to_string(),
        (_, v) => v.to_string(),
    }
}

fn quote(cell: &str, separator: char) -> String {
    let needs = cell.contains([separator, '"', '\n', '\r'])
        || cell.starts_with([' ', '\t'])
        || cell.ends_with([' ', '\t']);
    if needs { format!("\"{}\"", cell.replace('"', "\"\"")) } else { cell.to_string() }
}

/// RFC 4180 CSV with a byte order mark, so Excel opens it as UTF-8, and CRLF line ends. Times
/// are ISO 8601 in UTC; numbers keep every digit and use the language's decimal mark.
pub fn csv(frame: &Frame, language: ExportLanguage) -> Vec<u8> {
    let separator = if language == ExportLanguage::De { ';' } else { ',' };
    let sep = separator.to_string();
    let mut out = String::from("\u{FEFF}");
    let header: Vec<String> = frame.fields().iter().map(|f| quote(&defuse(&f.name), separator)).collect();
    out.push_str(&header.join(&sep));
    out.push_str("\r\n");
    for row in 0..frame.rows() {
        let cells: Vec<String> =
            frame.fields().iter().map(|f| quote(&csv_cell(&f.values[row], f.field_type, language), separator)).collect();
        out.push_str(&cells.join(&sep));
        out.push_str("\r\n");
    }
    out.into_bytes()
}

/// A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`.
fn sheet_name(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !"[]:*?/\\".contains(*c) && !c.is_control()).take(31).collect();
    let clean = clean.trim_matches('\'').to_string();
    if clean.trim().is_empty() { "Kalzit".into() } else { clean }
}

fn truncate(text: &str) -> &str {
    match text.char_indices().nth(XLSX_MAX_TEXT) {
        Some((i, _)) => &text[..i],
        None => text,
    }
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
            let row = r as u32 + 1;
            let result = match (field.field_type, value) {
                (_, Value::Null) => continue,
                (FieldType::Time, Value::Number(n)) => match n.as_i64() {
                    Some(ms) => match excel_date(ms) {
                        Some(d) => sheet.write_number_with_format(row, col, d, &date),
                        None => sheet.write_string(row, col, iso_time(ms)),
                    },
                    None => continue,
                },
                (FieldType::Int64, Value::String(s)) => match s.parse::<i64>() {
                    Ok(n) if n.unsigned_abs() <= 1 << 53 => sheet.write_number(row, col, n as f64),
                    _ => sheet.write_string(row, col, s),
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
    book.save_to_buffer().map_err(xlsx_error)
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
    use crate::shapes::Field;
    use serde_json::json;
    use std::io::Read;

    fn field(name: &str, field_type: FieldType, values: Vec<Value>) -> Field {
        Field { name: name.into(), field_type, unit: None, values, labels: None }
    }

    fn sample() -> Frame {
        Frame::new(vec![
            field("zeit", FieldType::Time, vec![json!(1_767_225_600_000_i64), Value::Null, json!(-2_208_988_800_000_i64)]),
            field("betrag", FieldType::Number, vec![json!(1234.5), json!(-0.25), json!(1e21)]),
            field("stück", FieldType::Int64, vec![json!("9007199254740993"), json!("7"), Value::Null]),
            field("text", FieldType::String, vec![json!("a;b,\"c\""), json!("=HYPERLINK(\"x\")"), json!(" Zeile\nzwei ")]),
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
        assert_eq!(lines[1], "2026-01-01T00:00:00.000Z;1234,5;9007199254740993;\"a;b,\"\"c\"\"\";true;\"{\"\"a\"\":[1,\"\"x\"\"]}\"");
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
        assert!(lines[1].starts_with("2026-01-01T00:00:00.000Z,1234.5,9007199254740993,\"a;b,\"\"c\"\"\",true,"), "{}", lines[1]);
        assert!(lines[2].starts_with(",-0.25,7,"), "{}", lines[2]);
    }

    #[test]
    fn header_names_are_defused_and_quoted_too() {
        let frame = Frame::new(vec![field("=SUM(A1)", FieldType::Number, vec![json!(1)]), field("a,b", FieldType::Number, vec![json!(2)])]).unwrap();
        let text = String::from_utf8(csv(&frame, ExportLanguage::En)).unwrap();
        assert!(text.starts_with("\u{FEFF}'=SUM(A1),\"a,b\"\r\n1,2\r\n"), "{text:?}");
        assert_eq!(String::from_utf8(csv(&Frame::new(vec![]).unwrap(), ExportLanguage::De)).unwrap(), "\u{FEFF}\r\n");
    }

    #[test]
    fn json_is_the_result_envelope() {
        let file = encode(&sample(), "A", ExportFormat::Json, ExportLanguage::De).unwrap();
        let back: QueryResult = serde_json::from_slice(&file.bytes).unwrap();
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
        let file = encode(&sample(), "Umsatz: A/B", ExportFormat::Xlsx, ExportLanguage::De).unwrap();
        assert_eq!(&file.bytes[..2], b"PK", "a zip archive");
        let (sheet, strings) = sheet_xml(&file.bytes);
        // 2026-01-01 is Excel day 46023; numbers stay numbers, the big int64 stays text.
        assert!(sheet.contains("<v>46023</v>"), "{sheet}");
        assert!(sheet.contains("<v>1234.5</v>") && sheet.contains("<v>-0.25</v>"), "{sheet}");
        assert!(sheet.contains("<v>7</v>"), "{sheet}");
        assert!(sheet.contains(r#"t="b""#), "booleans are boolean cells: {sheet}");
        assert!(!sheet.contains("<f>"), "no formulas: {sheet}");
        assert!(strings.contains("9007199254740993"), "{strings}");
        assert!(strings.contains("=HYPERLINK"), "kept as text: {strings}");
        assert!(strings.contains("1900-01-01T00:00:00.000Z"), "before 1900-03-01 as text: {strings}");
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&file.bytes[..])).unwrap();
        let mut book = String::new();
        zip.by_name("xl/workbook.xml").unwrap().read_to_string(&mut book).unwrap();
        assert!(book.contains(r#"name="Umsatz AB""#), "{book}");
    }

    #[test]
    fn excel_limits_and_long_text() {
        let long = Frame::new(vec![field("t", FieldType::String, vec![json!("ä".repeat(40_000))])]).unwrap();
        let (_, strings) = sheet_xml(&xlsx(&long, "x").unwrap());
        assert_eq!(strings.matches('ä').count(), XLSX_MAX_TEXT);
        let wide = Frame::new((0..=XLSX_MAX_COLUMNS).map(|i| field(&format!("f{i}"), FieldType::Number, vec![])).collect()).unwrap();
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
    }
}
