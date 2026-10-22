//! CSV, JSON and NDJSON files from directories a server admin allowed
//! (`datasources.file_dirs`), by the same rules as SQLite files: never Kalzit's data directory,
//! symlinks resolved before the check, the same answer for a missing and a refused file.
//!
//! CSV becomes a `frame` with typed columns (`csv::infer`); JSON and NDJSON stay `documents`.
//! Files are read on a blocking thread, within the row limit, the response budget and the
//! query's time limit, so a huge file costs only what the answer may hold.

use std::cell::Cell;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;

use super::Detail;
use super::csv::{self, CsvError, Decimal, MAX_COLUMNS};
use super::frame::{Column, FrameBuilder, ResponseBudget};
use super::json_documents::DocumentsBuilder;
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema, Table, TableColumn,
};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("path", "datasources.settings.path", SettingType::String).target().required(),
    SettingField::new("format", "datasources.settings.format", SettingType::Select)
        .options(&["auto", "csv", "json", "ndjson"])
        .default(DefaultValue::Text("auto")),
    SettingField::new("delimiter", "datasources.settings.delimiter", SettingType::Select)
        .options(&["auto", "comma", "semicolon", "tab", "pipe"])
        .default(DefaultValue::Text("auto")),
    SettingField::new("decimal", "datasources.settings.decimal", SettingType::Select)
        .options(&["auto", "point", "comma"])
        .default(DefaultValue::Text("auto")),
    SettingField::new("header", "datasources.settings.header", SettingType::Bool).default(DefaultValue::Bool(true)),
];
/// A JSON file (not NDJSON) may be at most this large.
const MAX_JSON_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Rows or documents the schema is read from, within this many bytes.
const SCHEMA_SAMPLE: usize = 1_000;
const SCHEMA_BYTES: usize = 16 * 1024 * 1024;
/// How long reading the schema may take.
const SCHEMA_TIMEOUT: Duration = Duration::from_secs(30);
/// Bytes a JSON parser reads between checks of the time limit.
const DEADLINE_BYTES: usize = 1024 * 1024;
const READ_BUFFER: usize = 64 * 1024;

pub fn kind() -> Kind {
    Kind { name: "CSV/JSON file", hint_key: "datasources.kinds.file.hint", settings: SETTINGS, plugin: Arc::new(Files) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    path: String,
    format: Option<String>,
    delimiter: Option<String>,
    decimal: Option<String>,
    header: Option<bool>,
}

/// A file query has no fields: the source names the file.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileQuery {}

pub struct Files;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Format {
    Csv,
    Json,
    Ndjson,
}

impl Format {
    fn label(self) -> &'static str {
        match self {
            Format::Csv => "CSV",
            Format::Json => "JSON",
            Format::Ndjson => "NDJSON",
        }
    }
}

/// What to read and how, from the settings.
#[derive(Clone, Debug)]
struct Plan {
    path: PathBuf,
    format: Format,
    /// `None`: found in the first line.
    delimiter: Option<u8>,
    decimal: Decimal,
    header: bool,
}

fn extension(path: &str) -> String {
    Path::new(path).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

/// The format and the delimiter it implies (`.tsv` is tab-separated).
fn format_of(s: &Settings) -> Result<(Format, Option<u8>), Detail> {
    let ext = extension(&s.path);
    let format = match s.format.as_deref().unwrap_or("auto") {
        "csv" => Format::Csv,
        "json" => Format::Json,
        "ndjson" => Format::Ndjson,
        _ => match ext.as_str() {
            "csv" | "tsv" | "txt" => Format::Csv,
            "json" => Format::Json,
            "ndjson" | "jsonl" => Format::Ndjson,
            _ => {
                return Err(Detail::new(
                    "settings.file_format_unknown",
                    "the format cannot be told from the file name; choose csv, json or ndjson",
                ));
            }
        },
    };
    let delimiter = match s.delimiter.as_deref().unwrap_or("auto") {
        "comma" => Some(b','),
        "semicolon" => Some(b';'),
        "tab" => Some(b'\t'),
        "pipe" => Some(b'|'),
        _ if ext == "tsv" => Some(b'\t'),
        _ => None,
    };
    Ok((format, delimiter))
}

fn plan(conn: &Connection) -> Result<Plan, SourceError> {
    let s: Settings = conn.settings_as()?;
    let path = conn.policy().check_file_path(&s.path)?;
    let (format, delimiter) = format_of(&s).map_err(SourceError::Failed)?;
    let decimal = match s.decimal.as_deref() {
        Some("point") => Decimal::Point,
        Some("comma") => Decimal::Comma,
        _ => Decimal::Auto,
    };
    Ok(Plan { path, format, delimiter, decimal, header: s.header.unwrap_or(true) })
}

fn read_failed(e: impl std::fmt::Display) -> SourceError {
    SourceError::failed("file.read_failed", format!("cannot read the file: {e}")).with("detail", e)
}

fn open(path: &Path) -> Result<BufReader<File>, SourceError> {
    let file = File::open(path).map_err(read_failed)?;
    Ok(BufReader::with_capacity(READ_BUFFER, file))
}

/// Runs blocking file work off the async threads. The work gets a deadline that also reports
/// cancellation: when the query's future is dropped (time limit, client gone), the flag is set
/// and the work stops at its next check instead of reading on in its thread.
async fn blocking<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce(Deadline) -> Result<T, SourceError> + Send + 'static,
) -> Result<T, SourceError> {
    let deadline = Deadline::new(Instant::now() + timeout, timeout);
    let _cancel_on_drop = CancelOnDrop(deadline.cancel.clone());
    tokio::task::spawn_blocking(move || work(deadline))
        .await
        .map_err(|e| SourceError::failed("internal", e.to_string()))?
}

/// Sets the flag when dropped, also when the future that holds it is dropped unfinished.
struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// Stops a read that runs past the query's time limit or whose query went away (the async
/// timeout cannot stop a blocking thread). Checked before every record and line.
struct Deadline {
    at: Instant,
    timeout: Duration,
    cancel: Arc<AtomicBool>,
}

impl Deadline {
    fn new(at: Instant, timeout: Duration) -> Self {
        Self { at, timeout, cancel: Arc::new(AtomicBool::new(false)) }
    }

    fn check(&self) -> Result<(), SourceError> {
        if self.cancel.load(Ordering::SeqCst) || Instant::now() > self.at {
            return Err(SourceError::Timeout(self.timeout.as_secs()));
        }
        Ok(())
    }
}

/// A reader that checks the deadline every `DEADLINE_BYTES`, for parsers that read on their own
/// (a whole JSON file), and stops an array element that grows past its byte limit before the
/// parser holds it whole.
struct DeadlineReader<'a, R> {
    inner: R,
    deadline: &'a Deadline,
    since_check: usize,
    element: ElementBytes,
}

/// Bytes read since the current array element began, and how many it may take; shared with the
/// visitor that starts each element.
#[derive(Clone)]
struct ElementBytes {
    read: Rc<Cell<usize>>,
    limit: Rc<Cell<usize>>,
}

impl ElementBytes {
    fn unlimited() -> Self {
        Self { read: Rc::new(Cell::new(0)), limit: Rc::new(Cell::new(usize::MAX)) }
    }

    /// A new element begins that may take `limit` bytes.
    fn start(&self, limit: usize) {
        self.read.set(0);
        self.limit.set(limit);
    }
}

impl<'a, R> DeadlineReader<'a, R> {
    fn new(inner: R, deadline: &'a Deadline) -> Self {
        Self { inner, deadline, since_check: 0, element: ElementBytes::unlimited() }
    }
}

impl<R: Read> Read for DeadlineReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.since_check >= DEADLINE_BYTES {
            self.since_check = 0;
            if self.deadline.check().is_err() {
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, DEADLINE_PASSED));
            }
        }
        let n = self.inner.read(buf)?;
        self.since_check += n;
        let element = self.element.read.get() + n;
        self.element.read.set(element);
        if element > self.element.limit.get() {
            return Err(std::io::Error::other(ELEMENT_TOO_LARGE));
        }
        Ok(n)
    }
}

const ELEMENT_TOO_LARGE: &str = "an array element is larger than the answer may hold";

const DEADLINE_PASSED: &str = "the time limit passed";

fn csv_error(e: CsvError) -> SourceError {
    match e {
        CsvError::UnclosedQuote { line } => {
            SourceError::failed("csv.unclosed_quote", format!("a quoted field from line {line} is never closed"))
                .with("line", line)
        }
        CsvError::Io(e) => read_failed(e),
        CsvError::TooLarge => SourceError::failed("internal", "a record exceeded the limit"),
        CsvError::TooManyFields => too_many_columns(),
    }
}

fn too_many_columns() -> SourceError {
    SourceError::failed("csv.too_many_columns", format!("the file has more than {MAX_COLUMNS} columns"))
        .with("max", MAX_COLUMNS)
}

/// Bytes of the budget held for records read but not yet converted; each row's share is given
/// back as the row moves into the frame (which charges its own size), the rest when dropped.
struct RawCharge {
    budget: ResponseBudget,
    held: usize,
}

impl RawCharge {
    fn take(&mut self, bytes: usize) -> bool {
        let ok = self.budget.take(bytes);
        if ok {
            self.held += bytes;
        }
        ok
    }

    fn release(&mut self, bytes: usize) {
        let bytes = bytes.min(self.held);
        self.budget.give_back(bytes);
        self.held -= bytes;
    }
}

impl Drop for RawCharge {
    fn drop(&mut self) {
        self.budget.give_back(self.held);
    }
}

/// The records of a CSV file as read, up to `max_rows` data rows and the budget.
struct CsvRows {
    names: Vec<String>,
    /// Each row with the bytes it took in the file.
    rows: Vec<(Vec<String>, usize)>,
    /// Reading stopped at the response budget.
    size_cut: bool,
    legacy_encoding: bool,
    /// Rows with more fields than the header.
    extra_fields: usize,
    charge: RawCharge,
}

fn read_csv_rows(
    plan: &Plan,
    max_rows: usize,
    budget: &ResponseBudget,
    deadline: &Deadline,
) -> Result<CsvRows, SourceError> {
    deadline.check()?;
    let mut input = open(&plan.path)?;
    csv::skip_bom(&mut input).map_err(read_failed)?;
    let mut reader = csv::Reader::new(input, b',');
    let delimiter = match plan.delimiter {
        Some(d) => d,
        None => csv::detect_delimiter(reader.peek().map_err(read_failed)?),
    };
    reader.set_delimiter(delimiter);
    let mut charge = RawCharge { budget: budget.clone(), held: 0 };
    // The raw records may hold half of what is left, so the frame they become still fits.
    let raw_limit = budget.remaining() / 2;
    let mut size_cut = false;
    let mut legacy_encoding = false;
    let mut header = None;
    if plan.header {
        match reader.next_record(raw_limit) {
            Ok(Some(rec)) => {
                if rec.fields.len() > MAX_COLUMNS {
                    return Err(too_many_columns());
                }
                if charge.take(rec.bytes) {
                    legacy_encoding |= rec.windows_1252;
                    header = Some(rec.fields);
                } else {
                    size_cut = true;
                }
            }
            Ok(None) => header = Some(Vec::new()),
            Err(CsvError::TooLarge) => size_cut = true,
            Err(e) => return Err(csv_error(e)),
        }
    }
    let mut rows = Vec::new();
    // One row past the limit, so the frame knows it was cut.
    while !size_cut && rows.len() <= max_rows {
        deadline.check()?;
        match reader.next_record(raw_limit.saturating_sub(charge.held)) {
            Ok(Some(rec)) => {
                if header.is_none() && rec.fields.len() > MAX_COLUMNS {
                    return Err(too_many_columns());
                }
                if !charge.take(rec.bytes) {
                    size_cut = true;
                    break;
                }
                legacy_encoding |= rec.windows_1252;
                rows.push((rec.fields, rec.bytes));
            }
            Ok(None) => break,
            Err(CsvError::TooLarge) => size_cut = true,
            Err(e) => return Err(csv_error(e)),
        }
    }
    let count = match &header {
        Some(h) => h.len(),
        None => rows.iter().map(|(r, _)| r.len()).max().unwrap_or(0),
    };
    let extra_fields = rows.iter().filter(|(r, _)| r.len() > count).count();
    let names = csv::column_names(header.as_deref().unwrap_or(&[]), count);
    Ok(CsvRows { names, rows, size_cut, legacy_encoding, extra_fields, charge })
}

/// The column types and the decimal mark each column was read with.
fn column_types(rows: &[(Vec<String>, usize)], count: usize, decimal: Decimal) -> Vec<(FieldType, Decimal)> {
    (0..count)
        .map(|i| {
            let values: Vec<Option<&str>> = rows.iter().map(|(r, _)| r.get(i).map(String::as_str)).collect();
            let ty = csv::infer(&values, decimal);
            let present: Vec<&str> = values.iter().flatten().map(|v| v.trim()).filter(|v| !v.is_empty()).collect();
            (ty, csv::resolve_decimal(&present, decimal))
        })
        .collect()
}

fn read_csv(
    plan: &Plan,
    max_rows: usize,
    budget: &ResponseBudget,
    deadline: &Deadline,
) -> Result<FrameBuilder, SourceError> {
    let CsvRows { names, rows, size_cut, legacy_encoding, extra_fields, mut charge } =
        read_csv_rows(plan, max_rows, budget, deadline)?;
    let types = column_types(&rows, names.len(), plan.decimal);
    let columns = names.iter().zip(&types).map(|(n, (t, _))| Column::new(n.clone(), Some(*t))).collect();
    let mut frame = FrameBuilder::new(columns, max_rows, budget.clone());
    for (row, bytes) in rows {
        let values =
            types.iter().enumerate().map(|(i, (t, d))| csv::convert(row.get(i).map(String::as_str), *t, *d)).collect();
        drop(row);
        charge.release(bytes);
        if !frame.push_row(values) {
            break;
        }
    }
    drop(charge);
    if size_cut && !frame.is_full() {
        frame.mark_truncated(Detail::new("frame.size_limit", "the result was cut off at the response size limit"));
    }
    if legacy_encoding {
        frame.notice(
            NoticeSeverity::Info,
            Detail::new("csv.legacy_encoding", "the file is not UTF-8 and was read as Windows-1252"),
        );
    }
    if extra_fields > 0 {
        let n = extra_fields;
        frame.notice(
            NoticeSeverity::Warning,
            Detail::new(
                "csv.extra_fields",
                format!("{n} rows have more fields than the header; the extra ones are left out"),
            )
            .with("count", n),
        );
    }
    Ok(frame)
}

fn json_invalid(line: Option<usize>, e: serde_json::Error) -> SourceError {
    match line {
        Some(l) => SourceError::failed("file.ndjson_line_invalid", format!("line {l} is not valid JSON: {e}"))
            .with("line", l)
            .with("detail", e),
        None => SourceError::failed("file.json_invalid", format!("the file is not valid JSON: {e}")).with("detail", e),
    }
}

fn too_large(limit: u64) -> SourceError {
    SourceError::failed("file.too_large", format!("the JSON file is larger than {limit} bytes")).with("bytes", limit)
}

/// The elements of a top-level array go into the documents one by one; once the documents are
/// full, the rest of the array is only checked to be JSON, without being kept. Each element
/// may take at most the bytes the answer has left, counted while it is read.
struct Elements<'a> {
    docs: &'a mut DocumentsBuilder,
    budget: &'a ResponseBudget,
    element: ElementBytes,
}

impl<'de> serde::de::Visitor<'de> for Elements<'_> {
    type Value = ();

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array")
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while !self.docs.is_full() {
            self.element.start(self.budget.remaining());
            match seq.next_element::<Value>()? {
                Some(v) => {
                    self.docs.push(v);
                }
                None => return Ok(()),
            }
        }
        self.element.start(usize::MAX);
        while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
        Ok(())
    }
}

/// A JSON file: the elements of a top-level array, read one by one so only the documents kept
/// are held (an array file of any size up to `MAX_JSON_FILE_BYTES` can be sampled), or any
/// other value as one document, which must fit the budget.
fn read_json(
    plan: &Plan,
    max_docs: usize,
    budget: &ResponseBudget,
    deadline: &Deadline,
) -> Result<DocumentsBuilder, SourceError> {
    deadline.check()?;
    let mut docs = DocumentsBuilder::new(max_docs, budget.clone());
    let len = std::fs::metadata(&plan.path).map_err(read_failed)?.len();
    if len > MAX_JSON_FILE_BYTES {
        return Err(too_large(MAX_JSON_FILE_BYTES));
    }
    let mut input = open(&plan.path)?;
    csv::skip_bom(&mut input).map_err(read_failed)?;
    let first = input.fill_buf().map_err(read_failed)?.iter().find(|b| !b.is_ascii_whitespace()).copied();
    let is_array = first == Some(b'[');
    // Anything but an array is parsed whole, so it must fit what the answer may hold.
    let mut charge = budget.charge();
    if !is_array && !charge.add(len as usize) {
        return Err(too_large(budget.remaining() as u64));
    }
    let reader = DeadlineReader::new(input, deadline);
    let element = reader.element.clone();
    let mut de = serde_json::Deserializer::from_reader(reader);
    let parsed = if is_array {
        serde::Deserializer::deserialize_seq(&mut de, Elements { docs: &mut docs, budget, element })
    } else {
        <Value as serde::Deserialize>::deserialize(&mut de).map(|v| {
            docs.push(v);
        })
    };
    if let Err(e) = parsed.and_then(|()| de.end()) {
        if e.is_io() && e.to_string().contains(DEADLINE_PASSED) {
            return Err(SourceError::Timeout(deadline.timeout.as_secs()));
        }
        if e.is_io() && e.to_string().contains(ELEMENT_TOO_LARGE) {
            // The element that did not fit ends the answer, like any document that does not.
            docs.mark_truncated();
            return Ok(docs);
        }
        return Err(if e.is_io() { read_failed(e) } else { json_invalid(None, e) });
    }
    drop(charge);
    Ok(docs)
}

fn read_ndjson(
    plan: &Plan,
    max_docs: usize,
    budget: &ResponseBudget,
    deadline: &Deadline,
) -> Result<DocumentsBuilder, SourceError> {
    let mut docs = DocumentsBuilder::new(max_docs, budget.clone());
    let mut input = open(&plan.path)?;
    csv::skip_bom(&mut input).map_err(read_failed)?;
    let mut line = Vec::new();
    let mut number = 0usize;
    // Blank lines hold nothing, but reading them still counts against the budget.
    let mut skipped = 0usize;
    loop {
        number += 1;
        deadline.check()?;
        line.clear();
        let limit = budget.remaining().saturating_sub(skipped) as u64 + 1;
        let read = (&mut input).take(limit).read_until(b'\n', &mut line).map_err(read_failed)?;
        if read == 0 {
            break;
        }
        if read as u64 >= limit && !line.ends_with(b"\n") {
            docs.mark_truncated();
            break;
        }
        let text = line.trim_ascii();
        if text.is_empty() {
            skipped += read;
            if skipped > budget.remaining() {
                docs.mark_truncated();
                break;
            }
            continue;
        }
        let value: Value = serde_json::from_slice(text).map_err(|e| json_invalid(Some(number), e))?;
        if !docs.push(value) {
            break;
        }
    }
    Ok(docs)
}

#[async_trait::async_trait]
impl DataSourcePlugin for Files {
    fn kind(&self) -> &'static str {
        "file"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame, Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        if !Path::new(&s.path).is_absolute() {
            return Err(FieldError::new(
                "path",
                "settings.path_relative",
                "the path must be absolute, like /srv/daten/umsatz.csv or C:\\Daten\\umsatz.csv",
            ));
        }
        format_of(&s).map_err(|d| FieldError { field: "format", detail: d.with("field", "format") })?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let plan = plan(conn)?;
            let format = plan.format;
            let bytes = blocking(SCHEMA_TIMEOUT, move |_| {
                let len = std::fs::metadata(&plan.path).map_err(read_failed)?.len();
                File::open(&plan.path).map_err(read_failed)?;
                Ok(len)
            })
            .await?;
            Ok::<_, SourceError>((format, bytes))
        };
        match check.await {
            Ok((format, bytes)) => Health {
                ok: true,
                code: None,
                detail: Detail::new(
                    "health.file_readable",
                    format!("the {} file can be read ({bytes} bytes)", format.label()),
                )
                .with("format", format.label())
                .with("bytes", bytes),
            },
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let plan = plan(conn)?;
        blocking(SCHEMA_TIMEOUT, move |deadline| {
            let budget = ResponseBudget::new(SCHEMA_BYTES);
            match plan.format {
                Format::Csv => {
                    let read = read_csv_rows(&plan, SCHEMA_SAMPLE, &budget, &deadline)?;
                    let types = column_types(&read.rows, read.names.len(), plan.decimal);
                    let columns = read
                        .names
                        .iter()
                        .zip(&types)
                        .map(|(name, (t, _))| TableColumn { name: name.clone(), data_type: field_type_name(*t).into() })
                        .collect();
                    let name = plan.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    Ok(SourceSchema::Tables { tables: vec![Table { schema: None, name, columns }] })
                }
                Format::Json | Format::Ndjson => {
                    let docs = match plan.format {
                        Format::Json => read_json(&plan, SCHEMA_SAMPLE, &budget, &deadline)?,
                        _ => read_ndjson(&plan, SCHEMA_SAMPLE, &budget, &deadline)?,
                    };
                    Ok(SourceSchema::Fields { fields: docs.finish().schema })
                }
            }
        })
        .await
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let _: FileQuery = req.parse()?;
        let plan = plan(conn)?;
        let limits = req.limits.clone();
        blocking(limits.timeout, move |deadline| match plan.format {
            Format::Csv => {
                let frame = read_csv(&plan, limits.max_rows, &limits.budget, &deadline)?;
                Ok(QueryResult::Frame { frame: frame.finish() })
            }
            Format::Json => Ok(QueryResult::Documents {
                documents: read_json(&plan, limits.max_rows, &limits.budget, &deadline)?.finish(),
            }),
            Format::Ndjson => Ok(QueryResult::Documents {
                documents: read_ndjson(&plan, limits.max_rows, &limits.budget, &deadline)?.finish(),
            }),
        })
        .await
    }
}

/// The frame type's name as the schema shows it.
fn field_type_name(t: FieldType) -> &'static str {
    match t {
        FieldType::Time => "time",
        FieldType::Number => "number",
        FieldType::Int64 => "int64",
        FieldType::String => "string",
        FieldType::Bool => "bool",
        FieldType::Json => "json",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::targets::TargetPolicy;
    use crate::shapes::TimeRange;
    use serde_json::json;
    use std::collections::BTreeMap;

    struct Dir {
        root: tempfile::TempDir,
    }

    impl Dir {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(root.path().join("dateien")).unwrap();
            std::fs::create_dir_all(root.path().join("data")).unwrap();
            Self { root }
        }

        fn write(&self, name: &str, content: &[u8]) -> String {
            let path = self.root.path().join("dateien").join(name);
            std::fs::write(&path, content).unwrap();
            path.to_string_lossy().to_string()
        }

        async fn conn(&self, settings: Value) -> Connection {
            let dirs = vec![self.root.path().join("dateien").to_string_lossy().to_string()];
            let policy =
                TargetPolicy::new(&self.root.path().join("data"), "sqlite::memory:", &[], &[]).with_file_dirs(&dirs);
            crate::datasources::json_documents::test_connection(settings, &[], policy).await
        }
    }

    fn req(max_rows: usize, bytes: usize) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 0, to: 1 },
            interval_ms: 1000,
            max_data_points: None,
            variables: BTreeMap::new(),
            identifier_variables: None,
            cursor: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows, budget: ResponseBudget::new(bytes) },
        }
    }

    fn frame(result: QueryResult) -> crate::shapes::Frame {
        match result {
            QueryResult::Frame { frame } => frame,
            other => panic!("not a frame: {other:?}"),
        }
    }

    #[tokio::test]
    async fn german_csv_becomes_a_typed_frame() {
        let d = Dir::new();
        let text = "\u{FEFF}Land;Betrag;Datum;PLZ;Bezahlt\r\n\"Österreich; Wien\";1.234,5;01.03.2026;01067;true\r\nSchweiz;7,25;2026-03-02;10115;false\r\nDeutschland;;;;\r\n";
        let path = d.write("umsatz.csv", text.as_bytes());
        let f = frame(Files.query(&d.conn(json!({ "path": path })).await, req(100, 1 << 20)).await.unwrap());
        let types: Vec<FieldType> = f.fields().iter().map(|f| f.field_type).collect();
        assert_eq!(types, [FieldType::String, FieldType::Number, FieldType::Time, FieldType::String, FieldType::Bool]);
        assert_eq!(f.fields()[0].name, "Land");
        assert_eq!(f.fields()[0].values, [json!("Österreich; Wien"), json!("Schweiz"), json!("Deutschland")]);
        assert_eq!(f.fields()[1].values, [json!(1234.5), json!(7.25), Value::Null]);
        assert_eq!(f.fields()[2].values[0], json!(1_772_323_200_000_i64));
        assert_eq!(f.fields()[3].values[0], json!("01067"));
        assert!(!f.meta().unwrap().rows_truncated);
    }

    #[tokio::test]
    async fn huge_csv_files_are_bounded_by_rows_and_bytes() {
        let d = Dir::new();
        let mut text = String::from("id,wert\n");
        for i in 0..50_000 {
            text.push_str(&format!("{i},{}.5\n", i * 2));
        }
        let path = d.write("gross.csv", text.as_bytes());
        let conn = d.conn(json!({ "path": path })).await;
        let f = frame(Files.query(&conn, req(10, 1 << 20)).await.unwrap());
        assert_eq!(f.rows(), 10);
        assert_eq!(f.fields()[0].field_type, FieldType::Int64);
        assert_eq!(f.fields()[0].values[9], json!("9"));
        let meta = f.meta().unwrap();
        assert!(meta.rows_truncated && meta.notices[0].code == "frame.row_limit", "{meta:?}");

        let f = frame(Files.query(&conn, req(1_000_000, 4096)).await.unwrap());
        assert!(f.rows() > 0 && f.rows() < 1000, "{} rows", f.rows());
        assert!(f.meta().unwrap().notices.iter().any(|n| n.code == "frame.size_limit"));

        // A single line longer than the budget is cut, not read whole.
        let path = d.write("eine-zeile.csv", format!("a\n{}\n", "x".repeat(100_000)).as_bytes());
        let f = frame(Files.query(&d.conn(json!({ "path": path })).await, req(10, 4096)).await.unwrap());
        assert_eq!(f.rows(), 0);
        assert!(f.meta().unwrap().rows_truncated);
    }

    #[tokio::test]
    async fn json_and_ndjson_stay_documents() {
        let d = Dir::new();
        let path =
            d.write("kunden.json", "\u{FEFF}[{\"name\":\"Jörg\",\"tags\":[\"a\"]},{\"name\":\"Anna\"}]".as_bytes());
        let r = Files.query(&d.conn(json!({ "path": path })).await, req(100, 1 << 20)).await.unwrap();
        let QueryResult::Documents { documents } = r else { panic!("documents") };
        assert_eq!(documents.documents, [json!({ "name": "Jörg", "tags": ["a"] }), json!({ "name": "Anna" })]);
        assert!(documents.schema.iter().any(|f| f.path == "tags[]"));

        let path = d.write("log.ndjson", b"{\"a\":1}\n\n{\"a\":2}\r\n{\"a\":3}\n");
        let conn = d.conn(json!({ "path": path })).await;
        let QueryResult::Documents { documents } = Files.query(&conn, req(2, 1 << 20)).await.unwrap() else {
            panic!("documents")
        };
        assert_eq!(documents.documents, [json!({ "a": 1 }), json!({ "a": 2 })]);
        assert_eq!(documents.truncated, Some(crate::shapes::Truncated { limit: 2 }));

        let path = d.write("kaputt.ndjson", b"{\"a\":1}\n{kaputt\n");
        let e = Files.query(&d.conn(json!({ "path": path })).await, req(10, 1 << 20)).await.unwrap_err();
        assert_eq!((e.detail().reason, e.detail().params["line"].as_str()), ("file.ndjson_line_invalid", "2"));

        // A single value is parsed whole, so it must fit the budget.
        let path = d.write("gross.json", format!("{{\"x\":\"{}\"}}", "x".repeat(10_000)).as_bytes());
        let e = Files.query(&d.conn(json!({ "path": path })).await, req(10, 1000)).await.unwrap_err();
        assert_eq!(e.detail().reason, "file.too_large");
        // An array is read element by element: what does not fit cuts the answer.
        let path = d.write("gross-liste.json", format!("[{{\"a\":1}},\"{}\",3]", "x".repeat(10_000)).as_bytes());
        let QueryResult::Documents { documents } =
            Files.query(&d.conn(json!({ "path": path })).await, req(10, 1000)).await.unwrap()
        else {
            panic!("documents")
        };
        assert_eq!(documents.documents, [json!({ "a": 1 })]);
        assert_eq!(documents.truncated, Some(crate::shapes::Truncated { limit: 1 }));
        // Invalid JSON after the documents kept is still found.
        let path = d.write("kaputt.json", b"[1, 2, kaputt]");
        let e = Files.query(&d.conn(json!({ "path": path })).await, req(1, 1 << 20)).await.unwrap_err();
        assert_eq!(e.detail().reason, "file.json_invalid");
    }

    #[tokio::test]
    async fn files_outside_the_allowed_directories_are_refused() {
        let d = Dir::new();
        let outside = d.root.path().join("data").join("geheim.csv");
        std::fs::write(&outside, "a\n1\n").unwrap();
        let conn = d.conn(json!({ "path": outside.to_string_lossy() })).await;
        let e = Files.query(&conn, req(10, 1 << 20)).await.unwrap_err();
        assert!(matches!(e, SourceError::Blocked(_)), "{e}");
        assert_eq!(e.detail().reason, "target.file_path_refused");
        let h = Files.health(&conn).await;
        assert!(!h.ok && h.code == Some("datasource_target_blocked"), "{h:?}");

        let path = d.write("ok.csv", b"a\n1\n");
        let h = Files.health(&d.conn(json!({ "path": path })).await).await;
        assert!(h.ok, "{h:?}");
        assert_eq!(h.detail.reason, "health.file_readable");
    }

    #[tokio::test]
    async fn the_schema_lists_typed_columns() {
        let d = Dir::new();
        let path = d.write("werte.tsv", b"name\tmenge\nx\t3\n");
        let SourceSchema::Tables { tables } = Files.schema(&d.conn(json!({ "path": path })).await).await.unwrap()
        else {
            panic!("tables")
        };
        assert_eq!(tables[0].name, "werte.tsv");
        assert_eq!(tables[0].columns[1].name, "menge");
        assert_eq!(tables[0].columns[1].data_type, "int64");
    }

    #[test]
    fn settings_need_an_absolute_path_and_a_known_format() {
        assert!(Files.check_settings(&json!({ "path": "/srv/daten/a.csv" })).is_ok() || cfg!(windows));
        assert_eq!(Files.check_settings(&json!({ "path": "a.csv" })).unwrap_err().field, "path");
        let abs = std::env::temp_dir().join("daten.bin").to_string_lossy().to_string();
        let e = Files.check_settings(&json!({ "path": abs })).unwrap_err();
        assert_eq!((e.field, e.detail.reason), ("format", "settings.file_format_unknown"));
        assert!(Files.check_settings(&json!({ "path": abs, "format": "ndjson" })).is_ok());
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use crate::datasources::targets::TargetPolicy;

    fn setup() -> (tempfile::TempDir, TargetPolicy, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let files = root.path().join("dateien");
        std::fs::create_dir_all(&files).unwrap();
        std::fs::create_dir_all(root.path().join("data")).unwrap();
        std::fs::write(files.join("a.csv"), b"x\n1\n").unwrap();
        let p = TargetPolicy::new(&root.path().join("data"), "sqlite::memory:", &[], &[])
            .with_file_dirs(&[files.to_string_lossy().to_string()]);
        (root, p, files)
    }

    fn plan(path: PathBuf, format: Format) -> Plan {
        Plan { path, format, delimiter: Some(b','), decimal: Decimal::Auto, header: true }
    }

    fn later() -> Deadline {
        Deadline::new(Instant::now() + Duration::from_secs(60), Duration::from_secs(60))
    }

    /// Device paths, network shares and reserved device names are refused; alternate data
    /// streams and the trailing dots and spaces Windows drops name the allowed file itself, so
    /// whatever passes lies in the allowed directory.
    #[cfg(windows)]
    #[test]
    fn windows_special_paths() {
        let (_root, p, files) = setup();
        let _ = std::fs::write(files.join("a.csv:geheim"), b"stream\n1\n");
        let canonical = strip(std::fs::canonicalize(&files).unwrap());
        let f = |s: &str| files.join(s).to_string_lossy().to_string();
        let refused = [
            format!("{}{}", "\\\\?\\", f("a.csv")),
            format!("{}{}", "\\\\.\\", f("a.csv")),
            format!("{}{}", "\\\\localhost\\", "c$\\x.csv"),
            format!("{}{}", "\\\\?\\UNC\\localhost\\", "c$\\x.csv"),
            f("CON"),
            f("NUL"),
            f("nul.csv"),
            f("COM1"),
            format!(r"\?\{}", f("a.csv")),
            format!(r"\.\{}", f("a.csv")),
            r"\?\GLOBALROOT\Device\HarddiskVolume1\x".to_string(),
            r"\localhost\c$\x.csv".to_string(),
            format!("{}:geheim", files.to_string_lossy()),
        ];
        for raw in refused {
            assert!(p.check_file_path(&raw).is_err(), "{raw} was allowed");
        }
        for raw in [f("a.csv"), f("a.csv:geheim"), f("a.csv::$DATA"), f("a.csv."), f("a.csv ")] {
            if let Ok(path) = p.check_file_path(&raw) {
                assert!(path.starts_with(&canonical), "{raw} -> {}", path.display());
            }
        }
    }

    #[cfg(windows)]
    fn strip(p: PathBuf) -> PathBuf {
        let s = p.to_string_lossy().to_string();
        PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s))
    }

    /// The deadline is checked before every record, and blank lines count against the byte
    /// limit, so a file of blank lines is not read whole past the time limit or the budget.
    #[test]
    fn blank_lines_respect_the_deadline() {
        let (_root, _p, files) = setup();
        let mut text = b"x\n".to_vec();
        text.extend(std::iter::repeat_n(b'\n', 32 * 1024 * 1024));
        text.extend_from_slice(b"1\n");
        let path = files.join("leer.csv");
        std::fs::write(&path, &text).unwrap();
        let deadline = Deadline::new(Instant::now() - Duration::from_secs(1), Duration::from_secs(1));
        let budget = ResponseBudget::new(64 * 1024);
        let r = read_csv_rows(&plan(path.clone(), Format::Csv), 100, &budget, &deadline);
        assert!(matches!(r, Err(SourceError::Timeout(_))), "past the deadline");
        // Within the time limit the blank lines stop at the budget instead.
        let started = Instant::now();
        let rows = read_csv_rows(&plan(path, Format::Csv), 100, &budget, &later()).unwrap();
        assert!(rows.size_cut && rows.rows.is_empty());
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }

    #[test]
    fn cancelled_reads_stop() {
        let (_root, _p, files) = setup();
        for (name, format) in [("a.csv", Format::Csv), ("a.ndjson", Format::Ndjson), ("a.json", Format::Json)] {
            std::fs::write(files.join(name), b"[1]\n").unwrap();
            let deadline = later();
            deadline.cancel.store(true, Ordering::SeqCst);
            let budget = ResponseBudget::new(1 << 20);
            let p = plan(files.join(name), format);
            let r = match format {
                Format::Csv => read_csv_rows(&p, 10, &budget, &deadline).map(|_| ()),
                Format::Ndjson => read_ndjson(&p, 10, &budget, &deadline).map(|_| ()),
                Format::Json => read_json(&p, 10, &budget, &deadline).map(|_| ()),
            };
            assert!(matches!(r, Err(SourceError::Timeout(_))), "{name}");
        }
    }

    #[tokio::test]
    async fn a_dropped_query_sets_the_cancel_flag() {
        let (tx, rx) = std::sync::mpsc::channel();
        let work = blocking(Duration::from_secs(60), move |deadline| {
            tx.send(deadline.cancel.clone()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            Ok(())
        });
        // Dropped before the work is done, as the query timeout drops it.
        let _ = tokio::time::timeout(Duration::from_millis(50), work).await;
        let flag = rx.recv().unwrap();
        assert!(flag.load(Ordering::SeqCst));
    }

    /// The JSON parser reads through a reader that checks the deadline every megabyte.
    #[test]
    fn json_parsing_keeps_to_the_deadline() {
        let text = vec![b' '; 4 * DEADLINE_BYTES];
        let deadline = Deadline::new(Instant::now() - Duration::from_secs(1), Duration::from_secs(1));
        let mut reader = DeadlineReader::new(&text[..], &deadline);
        let mut out = Vec::new();
        let e = std::io::Read::read_to_end(&mut reader, &mut out).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::TimedOut);
        assert!(out.len() <= 2 * DEADLINE_BYTES, "read {} bytes past the deadline", out.len());
        // The parser's error from that reader is the query's timeout.
        let mut de = serde_json::Deserializer::from_reader(DeadlineReader::new(&text[..], &deadline));
        let e = <Value as serde::Deserialize>::deserialize(&mut de).unwrap_err();
        assert!(e.is_io() && e.to_string().contains(DEADLINE_PASSED), "{e}");
    }

    /// The schema of a JSON array larger than the schema's byte limit is sampled from its first
    /// documents instead of failing.
    #[test]
    fn large_json_arrays_have_a_schema() {
        let (_root, _p, files) = setup();
        let mut text = String::from("[");
        let item = format!("{{\"name\":\"{}\",\"n\":1}},", "x".repeat(1000));
        while text.len() < SCHEMA_BYTES + 1024 * 1024 {
            text.push_str(&item);
        }
        text.push_str("{\"name\":\"z\",\"n\":2}]");
        std::fs::write(files.join("gross.json"), &text).unwrap();
        let docs = read_json(
            &plan(files.join("gross.json"), Format::Json),
            SCHEMA_SAMPLE,
            &ResponseBudget::new(SCHEMA_BYTES),
            &later(),
        )
        .unwrap();
        let schema = docs.finish().schema;
        assert!(schema.iter().any(|f| f.path == "name"), "{schema:?}");
    }

    #[test]
    fn wide_files_and_large_headers_are_bounded() {
        let (_root, _p, files) = setup();
        let wide = vec!["a"; MAX_COLUMNS + 1].join(",") + "\n1\n";
        std::fs::write(files.join("breit.csv"), &wide).unwrap();
        let budget = ResponseBudget::new(1 << 20);
        let e = read_csv_rows(&plan(files.join("breit.csv"), Format::Csv), 10, &budget, &later()).err().unwrap();
        assert_eq!((e.detail().reason, e.detail().params["max"].as_str()), ("csv.too_many_columns", "10000"));
        // The header is charged: one longer than half the budget cuts the result.
        let header = "h".repeat(10_000) + "\n1\n";
        std::fs::write(files.join("kopf.csv"), &header).unwrap();
        let rows = read_csv_rows(&plan(files.join("kopf.csv"), Format::Csv), 10, &ResponseBudget::new(4096), &later())
            .unwrap();
        assert!(rows.size_cut);
        std::fs::write(files.join("nur-kopf.csv"), b"spalte_a,spalte_b\n").unwrap();
        let budget = ResponseBudget::new(1 << 20);
        let rows = read_csv_rows(&plan(files.join("nur-kopf.csv"), Format::Csv), 10, &budget, &later()).unwrap();
        assert_eq!(budget.remaining(), (1 << 20) - 18, "the header is held");
        drop(rows);
        assert_eq!(budget.remaining(), 1 << 20);
    }
}

#[cfg(test)]
mod bounded_reads_tests {
    use super::*;

    fn later() -> Deadline {
        Deadline::new(Instant::now() + Duration::from_secs(600), Duration::from_secs(600))
    }

    /// A 24 MiB header of commas under the default 50 MiB budget: the reader stops at the
    /// column cap instead of first turning the record into 24 million fields.
    #[test]
    fn wide_header_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("breit.csv");
        let mut text = vec![b','; 24 * 1024 * 1024];
        text.push(b'\n');
        std::fs::write(&path, &text).unwrap();
        drop(text);
        let plan = Plan { path, format: Format::Csv, delimiter: Some(b','), decimal: Decimal::Auto, header: true };
        let started = Instant::now();
        let r = read_csv_rows(&plan, 10, &ResponseBudget::new(50 * 1024 * 1024), &later());
        assert_eq!(r.err().map(|e| e.detail().reason), Some("csv.too_many_columns"));
        assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
        // The reader itself stops at the field after the cap, without reading the rest.
        let line = vec![b','; 1024 * 1024];
        let mut input = std::io::Cursor::new(&line[..]);
        let mut reader = csv::Reader::new(std::io::BufReader::with_capacity(4096, &mut input), b',');
        assert_eq!(reader.next_record(usize::MAX), Err(CsvError::TooManyFields));
        drop(reader);
        assert!(input.position() < 64 * 1024, "read {} bytes", input.position());
    }

    /// One array element far larger than the budget is stopped while it is read, not parsed
    /// whole first: the parser reads little more than the budget.
    #[test]
    fn big_array_element_memory() {
        let mut text = String::from("[1,[");
        while text.len() < 8 * 1024 * 1024 {
            text.push_str("0,");
        }
        text.push_str("0]]");
        let budget = ResponseBudget::new(1024 * 1024);
        let deadline = later();
        let mut input = std::io::Cursor::new(text.as_bytes());
        let reader = DeadlineReader::new(&mut input, &deadline);
        let element = reader.element.clone();
        let mut docs = DocumentsBuilder::new(10, budget.clone());
        let mut de = serde_json::Deserializer::from_reader(reader);
        let e = serde::Deserializer::deserialize_seq(&mut de, Elements { docs: &mut docs, budget: &budget, element })
            .unwrap_err();
        assert!(e.to_string().contains(ELEMENT_TOO_LARGE), "{e}");
        drop(de);
        assert!(input.position() < 2 * 1024 * 1024, "read {} bytes", input.position());

        // Through `read_json`: the documents before the element are kept and the answer is cut.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gross.json");
        std::fs::write(&path, &text).unwrap();
        let plan = Plan { path, format: Format::Json, delimiter: None, decimal: Decimal::Auto, header: true };
        let docs = read_json(&plan, 10, &ResponseBudget::new(1024 * 1024), &later()).unwrap().finish();
        assert_eq!(docs.documents, [serde_json::json!(1)]);
        assert_eq!(docs.truncated, Some(crate::shapes::Truncated { limit: 1 }));
    }
}
