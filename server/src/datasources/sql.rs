//! Shared SQL handling: macros and variables become bind parameters (never text in the query),
//! and the statement check accepts exactly one read-only `SELECT`/`WITH`.
//!
//! The scanner only decides where substitutions happen; it skips strings, quoted identifiers
//! and comments the way the engine does. If it ever disagrees with the engine, the result is a
//! syntax error or a wrong parameter count, never user input inside the SQL text, because values
//! are only ever bound. The real defence remains a read-only database login (and a read-only
//! transaction where the engine has one); this check is the second line.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::ControlFlow;

use serde_json::Value;
use sqlparser::ast::{
    BinaryOperator, Expr, ObjectName, ObjectNamePart, Query, Select, SetExpr, Statement, TableAlias, TableFactor,
    Visit, Visitor,
};
use sqlparser::dialect::{Dialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::keywords::Keyword;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Token, Tokenizer};

use crate::shapes::TimeRange;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Postgres,
    MySql,
    Sqlite,
    MsSql,
}

/// Why a query is not run, answered as `query_rejected` with its reason code.
pub use super::detail::Detail as Rejected;

fn reject<T>(reason: &'static str, msg: impl Into<String>) -> Result<T, Rejected> {
    Err(Rejected::new(reason, msg))
}

/// Above this, a number in a SQLite time column is Unix milliseconds, below it Unix seconds; the
/// same rule the SQLite source reads time values by.
pub const SQLITE_EPOCH_MS_ABOVE: i64 = 100_000_000_000;

/// A value bound to one placeholder. Each engine converts it to its own types.
#[derive(Clone, Debug, PartialEq)]
pub enum Bind {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
    /// Unix milliseconds, bound as the engine's timestamp type.
    Time(i64),
    /// Milliseconds, bound as an interval where the engine has one (PostgreSQL), else as text
    /// such as "30s".
    Interval(i64),
}

#[derive(Debug, PartialEq)]
pub struct Prepared {
    /// The statement as sent: macros and variables replaced by placeholders.
    pub sql: String,
    pub binds: Vec<Bind>,
}

/// What macros and variables expand from.
pub struct Context<'a> {
    pub range: TimeRange,
    pub interval_ms: u64,
    pub variables: &'a BTreeMap<String, Value>,
    /// Names a variable used as an identifier (`${table:identifier}`) may take, from the
    /// source's schema. `None` when the query uses no identifier variables.
    pub identifiers: Option<&'a BTreeSet<String>>,
    /// The variables that may be used as identifiers at all; `None` allows every variable
    /// (free queries, where the caller writes the query anyway). A dashboard's stored queries
    /// allow only variables whose value the server checked against the dashboard's own list.
    pub identifier_variables: Option<&'a BTreeSet<String>>,
}

/// Functions that read or write files, reach other servers, run SQL given as text (which would
/// escape this check), load code or act on other sessions. Matched case-insensitively on the last
/// part of the name, for every engine: a name dangerous in one engine means nothing in another.
const FORBIDDEN_FUNCTIONS: &[&str] = &[
    // MySQL/MariaDB
    "load_file",
    "sys_exec",
    "sys_eval",
    // MySQL/MariaDB named locks outlive the query on a pooled session.
    "get_lock",
    "release_lock",
    "release_all_locks",
    // PostgreSQL: files and directories
    "pg_read_file",
    "pg_read_binary_file",
    "pg_stat_file",
    "pg_ls_dir",
    "pg_ls_logdir",
    "pg_ls_waldir",
    "pg_ls_tmpdir",
    "pg_ls_archive_statusdir",
    "pg_file_write",
    "pg_file_rename",
    "pg_file_unlink",
    "pg_logdir_ls",
    // PostgreSQL: large objects (files on the server, and writes)
    "lo_import",
    "lo_export",
    "lo_create",
    "lo_creat",
    "lo_unlink",
    "lo_put",
    "lo_from_bytea",
    "lo_open",
    "lowrite",
    // PostgreSQL: other servers, SQL given as text, other sessions, configuration
    "dblink",
    "dblink_exec",
    "dblink_connect",
    "dblink_connect_u",
    "dblink_open",
    "dblink_send_query",
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
    "cursor_to_xml",
    "ts_stat",
    "pg_terminate_backend",
    "pg_cancel_backend",
    "pg_reload_conf",
    "pg_rotate_logfile",
    "pg_promote",
    "set_config",
    "pg_switch_wal",
    "pg_switch_xlog",
    "pg_create_restore_point",
    "pg_log_backend_memory_contexts",
    "pg_backup_start",
    "pg_backup_stop",
    "pg_start_backup",
    "pg_stop_backup",
    "pg_wal_replay_pause",
    "pg_wal_replay_resume",
    "pg_notify",
    "pg_import_system_collations",
    "pg_sync_replication_slots",
    "pg_replication_slot_advance",
    "pg_logical_emit_message",
    "nextval",
    "setval",
    // SQL Server
    "openrowset",
    "opendatasource",
    "openquery",
    "fn_get_audit_file",
    "fn_xe_file_target_read_file",
    "fn_trace_gettable",
    // SQLite
    "load_extension",
    "readfile",
    "writefile",
    "edit",
    "fts3_tokenizer",
];

/// One piece of the scanned query.
#[derive(Debug, PartialEq)]
enum Piece<'s> {
    /// SQL text passed through unchanged.
    Text(&'s str),
    /// `$__timeFilter(col)`, with the column expression.
    TimeFilter(&'s str),
    TimeFrom,
    TimeTo,
    Interval,
    IntervalMs,
    /// `$name` or `${name}`.
    Variable(&'s str),
    /// `${name:identifier}`.
    Identifier(&'s str),
}

/// The query form of every SQL kind: `{"sql": "SELECT ..."}`.
#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SqlQuery {
    pub sql: String,
}

/// Prepares a SQL kind's query: macros, variables (identifier variables against the source's
/// schema) and the statement check.
pub async fn prepare_query(
    plugin: &dyn super::DataSourcePlugin,
    conn: &super::Connection,
    req: &super::SourceQuery,
    engine: Engine,
) -> Result<Prepared, super::SourceError> {
    let query: SqlQuery = req.parse()?;
    let identifiers = if uses_identifier_variables(&query.sql, engine) {
        Some(plugin.schema(conn).await?.identifiers())
    } else {
        None
    };
    let ctx = Context {
        range: req.range,
        interval_ms: req.interval_ms,
        variables: &req.variables,
        identifiers: identifiers.as_ref(),
        identifier_variables: req.identifier_variables.as_ref(),
    };
    Ok(prepare(&query.sql, engine, &ctx)?)
}

/// Expands macros and variables into bind parameters and checks the statement.
pub fn prepare(sql: &str, engine: Engine, ctx: &Context<'_>) -> Result<Prepared, Rejected> {
    let pieces = scan(sql, engine)?;
    let mut out = String::with_capacity(sql.len() + 16);
    let mut binds = Vec::new();
    let placeholder = |binds: &mut Vec<Bind>, value: Bind| {
        binds.push(value);
        match engine {
            Engine::Postgres => format!("${}", binds.len()),
            Engine::MsSql => format!("@P{}", binds.len()),
            Engine::MySql | Engine::Sqlite => "?".to_string(),
        }
    };
    for piece in &pieces {
        match piece {
            Piece::Text(t) => out.push_str(t),
            Piece::TimeFilter(col) if engine == Engine::Sqlite => {
                // SQLite has no time type: a column holds text (ISO 8601 with "T" or a space,
                // with or without a zone) or Unix seconds or milliseconds as numbers. Text
                // compares as a time through julianday (exact to the millisecond, like SQLite's
                // own clock), numbers as Unix milliseconds; comparing as text would cut ISO
                // values with "T" at the edges and match no number at all.
                //
                // In front of that exact test, plain ranges an index on the column can serve:
                // the range in seconds, in milliseconds, and as text from the day before to the
                // day after (zone offsets stay within a day). Each holds at least every value the
                // exact test lets through, so the result is the same, only found faster.
                let (from_ms, to_ms) = (ctx.range.from, ctx.range.to);
                let day = |ms: i64, days: i64, fallback: &str| {
                    chrono::DateTime::from_timestamp_millis(ms.saturating_add(days * 86_400_000))
                        .map_or_else(|| fallback.to_string(), |t| t.format("%Y-%m-%d").to_string())
                };
                let s_lo = placeholder(&mut binds, Bind::Float((from_ms - 1) as f64 / 1000.0));
                let s_hi = placeholder(&mut binds, Bind::Float((to_ms + 1) as f64 / 1000.0));
                let ms_lo = placeholder(&mut binds, Bind::Int(from_ms));
                let ms_hi = placeholder(&mut binds, Bind::Int(to_ms));
                let text_lo = placeholder(&mut binds, Bind::Text(day(from_ms, -1, "")));
                let text_hi = placeholder(&mut binds, Bind::Text(day(to_ms, 2, "~")));
                let exact_lo = placeholder(&mut binds, Bind::Int(from_ms));
                let exact_hi = placeholder(&mut binds, Bind::Int(to_ms));
                let from = placeholder(&mut binds, Bind::Time(from_ms));
                let to = placeholder(&mut binds, Bind::Time(to_ms));
                out.push_str(&format!(
                    "(({col} BETWEEN {s_lo} AND {s_hi} OR {col} BETWEEN {ms_lo} AND {ms_hi} \
                     OR {col} BETWEEN {text_lo} AND {text_hi}) \
                     AND (CASE WHEN typeof({col}) IN ('integer', 'real') \
                     THEN (CASE WHEN abs({col}) > {SQLITE_EPOCH_MS_ABOVE} THEN {col} ELSE {col} * 1000 END) \
                     BETWEEN {exact_lo} AND {exact_hi} \
                     ELSE julianday({col}) BETWEEN julianday({from}) AND julianday({to}) END))"
                ));
            }
            Piece::TimeFilter(col) => {
                let from = placeholder(&mut binds, Bind::Time(ctx.range.from));
                let to = placeholder(&mut binds, Bind::Time(ctx.range.to));
                out.push_str(&format!("({col} BETWEEN {from} AND {to})"));
            }
            Piece::TimeFrom => out.push_str(&placeholder(&mut binds, Bind::Time(ctx.range.from))),
            Piece::TimeTo => out.push_str(&placeholder(&mut binds, Bind::Time(ctx.range.to))),
            Piece::Interval => out.push_str(&placeholder(&mut binds, Bind::Interval(ctx.interval_ms as i64))),
            Piece::IntervalMs => out.push_str(&placeholder(&mut binds, Bind::Int(ctx.interval_ms as i64))),
            Piece::Variable(name) => {
                let value = variable(ctx, name)?;
                let values = match value {
                    Value::Array(items) if items.is_empty() => vec![Bind::Null],
                    Value::Array(items) => items.iter().map(|v| scalar(name, v)).collect::<Result<_, _>>()?,
                    other => vec![scalar(name, other)?],
                };
                let parts: Vec<String> = values.into_iter().map(|v| placeholder(&mut binds, v)).collect();
                out.push_str(&parts.join(", "));
            }
            Piece::Identifier(name) => {
                if ctx.identifier_variables.is_some_and(|allowed| !allowed.contains(*name)) {
                    return Err(Rejected::new(
                        "sql.identifier_variable_not_allowed",
                        format!(
                            "variable {name} cannot be an identifier here; only custom and constant dashboard \
                             variables can"
                        ),
                    )
                    .with("name", name));
                }
                let value = variable(ctx, name)?;
                let allowed = ctx.identifiers.ok_or_else(|| {
                    Rejected::new("sql.identifier_needs_schema", "identifier variables need the schema")
                })?;
                let names: Vec<&Value> = match value {
                    Value::Array(items) => items.iter().collect(),
                    other => vec![other],
                };
                if names.is_empty() {
                    return Err(Rejected::new("sql.variable_missing", format!("variable {name} has no value"))
                        .with("name", name));
                }
                let mut quoted = Vec::new();
                for n in names {
                    let Some(n) = n.as_str().filter(|n| allowed.contains(*n)) else {
                        return Err(Rejected::new(
                            "sql.identifier_unknown",
                            format!("variable {name} is not a table or column of this data source"),
                        )
                        .with("name", name));
                    };
                    quoted.push(quote_identifier(engine, n));
                }
                out.push_str(&quoted.join(", "));
            }
        }
    }
    check_statement(&out, engine)?;
    Ok(Prepared { sql: out, binds })
}

/// Whether the query uses `${name:identifier}`, so the caller must load the schema first.
pub fn uses_identifier_variables(sql: &str, engine: Engine) -> bool {
    scan(sql, engine).is_ok_and(|p| p.iter().any(|p| matches!(p, Piece::Identifier(_))))
}

fn variable<'v>(ctx: &'v Context<'_>, name: &str) -> Result<&'v Value, Rejected> {
    ctx.variables.get(name).ok_or_else(|| {
        Rejected::new("sql.variable_missing", format!("variable {name} has no value")).with("name", name)
    })
}

fn scalar(name: &str, value: &Value) -> Result<Bind, Rejected> {
    Ok(match value {
        Value::Null => Bind::Null,
        Value::Bool(b) => Bind::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Bind::Int(i),
            None => Bind::Float(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => Bind::Text(s.clone()),
        Value::Array(_) | Value::Object(_) => {
            return Err(Rejected::new(
                "sql.variable_type",
                format!("variable {name} must be a string, number, boolean or a list of them"),
            )
            .with("name", name));
        }
    })
}

fn quote_identifier(engine: Engine, name: &str) -> String {
    name.split('.')
        .map(|part| match engine {
            Engine::MySql => format!("`{}`", part.replace('`', "``")),
            Engine::MsSql => format!("[{}]", part.replace(']', "]]")),
            Engine::Postgres | Engine::Sqlite => format!("\"{}\"", part.replace('"', "\"\"")),
        })
        .collect::<Vec<_>>()
        .join(".")
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Splits the query into pass-through text and substitutions.
fn scan(sql: &str, engine: Engine) -> Result<Vec<Piece<'_>>, Rejected> {
    // MySQL and MariaDB run the content of these comments as SQL. They are refused anywhere in
    // the text, even inside strings, rather than trusting two parsers to agree on where a
    // comment starts.
    if engine == Engine::MySql && (sql.contains("/*!") || sql.contains("/*M!") || sql.contains("/*m!")) {
        return reject("sql.executable_comment", "MySQL executable comments (/*! ... */) are not allowed");
    }
    let bytes = sql.as_bytes();
    let mut pieces = Vec::new();
    let mut text_start = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Everything the engine treats as opaque is skipped as a whole.
        let skip_to = match c {
            b'\'' => Some(skip_string(bytes, i, b'\'', backslash_escapes(engine, bytes, i))?),
            b'"' => Some(skip_string(bytes, i, b'"', engine == Engine::MySql)?),
            b'`' if matches!(engine, Engine::MySql | Engine::Sqlite) => Some(skip_string(bytes, i, b'`', false)?),
            b'[' if matches!(engine, Engine::MsSql | Engine::Sqlite) => Some(skip_bracket(bytes, i)?),
            b'-' if bytes.get(i + 1) == Some(&b'-') => match line_comment_after_dashes(sql, i + 2, engine)? {
                true => Some(skip_line(bytes, i)),
                false => None,
            },
            b'#' if engine == Engine::MySql => Some(skip_line(bytes, i)),
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                Some(skip_block_comment(bytes, i, matches!(engine, Engine::Postgres | Engine::MsSql))?)
            }
            b'$' if engine == Engine::Postgres => dollar_quote_end(sql, i)?,
            // U&"..." and U&'...' spell names and text with escapes the checker would not decode,
            // so a forbidden function could hide behind them.
            b'U' | b'u'
                if engine == Engine::Postgres
                    && bytes.get(i + 1) == Some(&b'&')
                    && matches!(bytes.get(i + 2), Some(b'"' | b'\'')) =>
            {
                return reject(
                    "sql.unicode_escape",
                    "Unicode-escaped names and strings (U&\"...\", U&'...') are not allowed",
                );
            }
            _ => None,
        };
        if let Some(end) = skip_to {
            i = end;
            continue;
        }
        if c == b'$' && sql[i + 1..].starts_with("__") {
            let (piece, end) = scan_macro(sql, i)?;
            pieces.push(Piece::Text(&sql[text_start..i]));
            pieces.push(piece);
            i = end;
            text_start = end;
            continue;
        }
        if c == b'$' && sql[i + 1..].starts_with('{') {
            let close = sql[i..]
                .find('}')
                .map(|p| i + p)
                .ok_or_else(|| Rejected::new("sql.unclosed_variable", "unclosed ${...}"))?;
            let inner = &sql[i + 2..close];
            let (name, format) = match inner.split_once(':') {
                Some((n, f)) => (n, Some(f)),
                None => (inner, None),
            };
            if !valid_variable_name(name) {
                return Err(Rejected::new(
                    "sql.variable_name_invalid",
                    format!("invalid variable name in ${{{inner}}}"),
                )
                .with("name", inner));
            }
            let piece = match format {
                None => Piece::Variable(name),
                Some("identifier") => Piece::Identifier(name),
                Some(other) => {
                    return Err(Rejected::new(
                        "sql.variable_format_unknown",
                        format!("unknown variable format :{other}; only :identifier exists"),
                    )
                    .with("format", other));
                }
            };
            pieces.push(Piece::Text(&sql[text_start..i]));
            pieces.push(piece);
            i = close + 1;
            text_start = i;
            continue;
        }
        if c == b'$' && sql[i + 1..].chars().next().is_some_and(is_ident_start) {
            let end = sql[i + 1..].find(|ch: char| !is_ident_char(ch)).map_or(sql.len(), |p| i + 1 + p);
            pieces.push(Piece::Text(&sql[text_start..i]));
            pieces.push(Piece::Variable(&sql[i + 1..end]));
            i = end;
            text_start = end;
            continue;
        }
        // Parameters written by hand would be bound to the wrong values or left unbound.
        let positional = match engine {
            Engine::Postgres => c == b'$' && bytes.get(i + 1).is_some_and(u8::is_ascii_digit),
            Engine::MySql => c == b'?',
            Engine::Sqlite => {
                matches!(c, b'?' | b'$' | b'@')
                    || (c == b':' && sql[i + 1..].chars().next().is_some_and(is_ident_start))
            }
            Engine::MsSql => {
                c == b'@'
                    && matches!(bytes.get(i + 1), Some(b'P' | b'p'))
                    && bytes.get(i + 2).is_some_and(u8::is_ascii_digit)
            }
        };
        if positional {
            return reject("sql.placeholder", "write variables as $name; parameter placeholders are not supported");
        }
        // Step over a whole UTF-8 character so slices stay on character boundaries.
        i += sql[i..].chars().next().map_or(1, char::len_utf8);
    }
    pieces.push(Piece::Text(&sql[text_start..]));
    pieces.retain(|p| !matches!(p, Piece::Text("")));
    Ok(pieces)
}

/// Whether `--` (ending before `next`) starts a comment. MySQL and MariaDB need a space or a
/// control character after it; the checker's parser accepts any Unicode whitespace there. Where
/// the two would disagree (a non-ASCII space) the query is refused, so the checked text is the
/// executed text.
fn line_comment_after_dashes(sql: &str, next: usize, engine: Engine) -> Result<bool, Rejected> {
    if engine != Engine::MySql {
        return Ok(true);
    }
    match sql[next..].chars().next() {
        Some(c) if c.is_ascii() => Ok(c.is_ascii_whitespace() || c.is_ascii_control()),
        Some(c) if c.is_whitespace() => {
            reject("sql.dash_comment_space", "write -- comments with an ordinary space after the dashes")
        }
        _ => Ok(false),
    }
}

fn valid_variable_name(name: &str) -> bool {
    name.chars().next().is_some_and(is_ident_start) && name.chars().all(is_ident_char) && !name.starts_with("__")
}

fn scan_macro(sql: &str, start: usize) -> Result<(Piece<'_>, usize), Rejected> {
    let name_end = sql[start + 1..].find(|ch: char| !is_ident_char(ch)).map_or(sql.len(), |p| start + 1 + p);
    let name = &sql[start + 1..name_end];
    let has_parens = sql[name_end..].starts_with('(');
    let empty_parens = sql[name_end..].starts_with("()");
    let simple = |piece| Ok((piece, if empty_parens { name_end + 2 } else { name_end }));
    match name {
        "__timeFrom" => simple(Piece::TimeFrom),
        "__timeTo" => simple(Piece::TimeTo),
        "__interval" => simple(Piece::Interval),
        "__interval_ms" => simple(Piece::IntervalMs),
        "__timeFilter" => {
            if !has_parens {
                return reject("sql.time_filter_column", "$__timeFilter needs a column: $__timeFilter(created_at)");
            }
            let close = sql[name_end..]
                .find(')')
                .map(|p| name_end + p)
                .ok_or_else(|| Rejected::new("sql.unclosed_time_filter", "unclosed $__timeFilter("))?;
            let column = sql[name_end + 1..close].trim();
            if !is_column_reference(column) {
                return reject(
                    "sql.time_filter_column",
                    "$__timeFilter takes a column name such as created_at or t.\"Zeitpunkt\"",
                );
            }
            Ok((Piece::TimeFilter(column), close + 1))
        }
        other => Err(Rejected::new("sql.macro_unknown", format!("unknown macro ${other}")).with("name", other)),
    }
}

/// `col`, `t.col`, `"Quoted Col"`, `` `col` ``, `[col]`: dotted identifiers, nothing else.
fn is_column_reference(s: &str) -> bool {
    !s.is_empty()
        && s.split('.').all(|part| {
            let p = part.trim();
            let quoted = |open: char, close: char| {
                p.len() >= 2
                    && p.starts_with(open)
                    && p.ends_with(close)
                    && !p[1..p.len() - 1].contains([open, close])
                    && !p[1..p.len() - 1].is_empty()
            };
            (p.chars().next().is_some_and(is_ident_start) && p.chars().all(is_ident_char))
                || quoted('"', '"')
                || quoted('`', '`')
                || quoted('[', ']')
        })
}

/// MySQL strings take backslash escapes; PostgreSQL only in `E'...'`.
fn backslash_escapes(engine: Engine, bytes: &[u8], quote: usize) -> bool {
    match engine {
        Engine::MySql => true,
        Engine::Postgres => {
            quote > 0
                && matches!(bytes[quote - 1], b'E' | b'e')
                && (quote < 2 || !is_ident_char(bytes[quote - 2] as char))
        }
        Engine::Sqlite | Engine::MsSql => false,
    }
}

/// The index after a quoted string or identifier; the quote doubled is an escaped quote.
fn skip_string(bytes: &[u8], start: usize, quote: u8, backslash: bool) -> Result<usize, Rejected> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if backslash => i += 2,
            q if q == quote => {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                } else {
                    return Ok(i + 1);
                }
            }
            _ => i += 1,
        }
    }
    reject("sql.unclosed_quote", "unclosed quote")
}

fn skip_bracket(bytes: &[u8], start: usize) -> Result<usize, Rejected> {
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b']' {
            if bytes.get(i + 1) == Some(&b']') {
                i += 2;
                continue;
            }
            return Ok(i + 1);
        }
        i += 1;
    }
    reject("sql.unclosed_bracket", "unclosed [")
}

fn skip_line(bytes: &[u8], start: usize) -> usize {
    bytes[start..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |p| start + p + 1)
}

/// PostgreSQL and SQL Server nest block comments; MySQL and SQLite end at the first `*/`.
fn skip_block_comment(bytes: &[u8], start: usize, nested: bool) -> Result<usize, Rejected> {
    let mut depth = 0;
    let mut i = start;
    while i + 1 < bytes.len() {
        if bytes[i] == b'/' && bytes[i + 1] == b'*' {
            depth += 1;
            i += 2;
            if !nested && depth > 1 {
                depth = 1;
            }
        } else if bytes[i] == b'*' && bytes[i + 1] == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return Ok(i);
            }
        } else {
            i += 1;
        }
    }
    reject("sql.unclosed_comment", "unclosed comment")
}

/// `$$...$$` or `$tag$...$tag$`; `None` when the `$` does not open a dollar-quoted string.
fn dollar_quote_end(sql: &str, start: usize) -> Result<Option<usize>, Rejected> {
    let rest = &sql[start + 1..];
    let tag_len = rest.find(|c: char| !is_ident_char(c)).unwrap_or(rest.len());
    let tag = &rest[..tag_len];
    if !rest[tag_len..].starts_with('$') || tag.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return Ok(None);
    }
    let delimiter = format!("${tag}$");
    let body = start + delimiter.len();
    match sql[body..].find(&delimiter) {
        Some(p) => Ok(Some(body + p + delimiter.len())),
        None => reject("sql.unclosed_dollar_quote", "unclosed dollar-quoted string"),
    }
}

fn dialect(engine: Engine) -> Box<dyn Dialect> {
    match engine {
        Engine::Postgres => Box::new(PostgreSqlDialect {}),
        Engine::MySql => Box::new(MySqlDialect {}),
        Engine::Sqlite => Box::new(SQLiteDialect {}),
        Engine::MsSql => Box::new(MsSqlDialect {}),
    }
}

/// Exactly one `SELECT`/`WITH` without `INTO`, locking clauses, data-modifying parts or forbidden
/// functions.
pub fn check_statement(sql: &str, engine: Engine) -> Result<(), Rejected> {
    // Reading a sequence advances it. Refused by its words, before parsing, so it does not
    // depend on whether the parser knows the T-SQL form.
    let words = sql.to_ascii_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    if engine == Engine::MsSql && words.contains("next value for") {
        return reject("sql.sequence", "NEXT VALUE FOR changes a sequence and is not allowed");
    }
    // Query hints (`OPTION (...)`, which can take table locks) are refused as a keyword token,
    // wherever the parser would put them; in strings, comments and quoted names (`[option]`) the
    // word is no token and does not count.
    if engine == Engine::MsSql {
        let tokens = Tokenizer::new(&MsSqlDialect {}, sql).tokenize().map_err(|e| {
            Rejected::new("sql.parse_error", format!("the query could not be checked: {e}")).with("detail", e)
        })?;
        let hint = tokens
            .iter()
            .any(|t| matches!(t, Token::Word(w) if w.keyword == Keyword::OPTION && w.quote_style.is_none()));
        if hint {
            return reject("sql.query_hint", "query hints (OPTION (...)) are not allowed");
        }
    }
    let statements = Parser::parse_sql(dialect(engine).as_ref(), sql).map_err(|e| {
        Rejected::new("sql.parse_error", format!("the query could not be checked: {e}")).with("detail", e)
    })?;
    let [statement] = statements.as_slice() else {
        return if statements.is_empty() {
            reject("sql.empty", "the query is empty")
        } else {
            reject("sql.multiple_statements", "only one statement is allowed")
        };
    };
    if !matches!(statement, Statement::Query(_)) {
        return reject("sql.not_select", "only SELECT and WITH queries are allowed");
    }
    match statement.visit(&mut ReadOnlyCheck { engine }) {
        ControlFlow::Break(rejected) => Err(rejected),
        ControlFlow::Continue(()) => Ok(()),
    }
}

struct ReadOnlyCheck {
    engine: Engine,
}

/// The only SQL Server table hints a read may carry: reads without locks, and index and plan
/// choices.
const ALLOWED_MSSQL_HINTS: &[&str] = &["nolock", "readuncommitted", "index", "noexpand", "forceseek"];

/// The alias of any table factor, whatever its kind (table, derived table, function, OPENJSON,
/// pivot, nested join and the rest), so a hint list behind an alias is seen everywhere.
fn factor_alias(factor: &TableFactor) -> Option<&TableAlias> {
    match factor {
        TableFactor::Table { alias, .. }
        | TableFactor::Derived { alias, .. }
        | TableFactor::TableFunction { alias, .. }
        | TableFactor::Function { alias, .. }
        | TableFactor::UNNEST { alias, .. }
        | TableFactor::JsonTable { alias, .. }
        | TableFactor::OpenJsonTable { alias, .. }
        | TableFactor::NestedJoin { alias, .. }
        | TableFactor::Pivot { alias, .. }
        | TableFactor::Unpivot { alias, .. }
        | TableFactor::MatchRecognize { alias, .. }
        | TableFactor::XmlTable { alias, .. }
        | TableFactor::SemanticView { alias, .. } => alias.as_ref(),
        _ => None,
    }
}
/// Every SQL Server table hint word, to recognize the old hint form `t (TABLOCKX)` among the
/// arguments of a table-valued function call.
const MSSQL_HINT_WORDS: &[&str] = &[
    "nolock",
    "readuncommitted",
    "holdlock",
    "nowait",
    "paglock",
    "readcommitted",
    "readcommittedlock",
    "readpast",
    "repeatableread",
    "rowlock",
    "serializable",
    "snapshot",
    "tablock",
    "tablockx",
    "updlock",
    "xlock",
    "noexpand",
    "forceseek",
    "forcescan",
    "keepidentity",
    "keepdefaults",
    "ignore_constraints",
    "ignore_triggers",
];

/// The name of a table hint: `TABLOCKX`, or `INDEX` in `INDEX(ix)`.
fn hint_name(hint: &Expr) -> String {
    match hint {
        Expr::Identifier(ident) => ident.value.to_ascii_lowercase(),
        Expr::Function(f) => last_name_part(&f.name).unwrap_or_default(),
        // `INDEX = ix`, the other spelling of `INDEX(ix)`.
        Expr::BinaryOp { left, op: BinaryOperator::Eq, .. } if matches!(**left, Expr::Identifier(_)) => hint_name(left),
        other => other.to_string().to_ascii_lowercase(),
    }
}

fn last_name_part(name: &ObjectName) -> Option<String> {
    match name.0.last()? {
        ObjectNamePart::Identifier(ident) => Some(ident.value.to_ascii_lowercase()),
        ObjectNamePart::Function(f) => Some(f.name.value.to_ascii_lowercase()),
    }
}

/// Families of functions refused by prefix: statistics resets, advisory locks, replication
/// slots and origins (creating, dropping, consuming changes), backups and WAL replay.
const FORBIDDEN_PREFIXES: &[&str] = &[
    "pg_stat_reset",
    "pg_advisory",
    "pg_try_advisory",
    "pg_create_",
    "pg_drop_",
    "pg_copy_",
    "pg_logical_slot_",
    "pg_replication_origin",
    "pg_backup_",
    "pg_wal_replay_",
    "lo_",
    "dblink",
];

/// Refuses a forbidden function, by name. Only function calls are checked (a table called `edit`
/// is fine), and the PostgreSQL prefix families only on PostgreSQL.
fn forbidden(name: &ObjectName, engine: Engine) -> ControlFlow<Rejected> {
    let by_prefix = |n: &str| engine == Engine::Postgres && FORBIDDEN_PREFIXES.iter().any(|p| n.starts_with(p));
    match last_name_part(name) {
        Some(n) if FORBIDDEN_FUNCTIONS.contains(&n.as_str()) || by_prefix(&n) => {
            let message = format!("{n} is not allowed: it reaches files, other servers or other sessions");
            ControlFlow::Break(Rejected::new("sql.function_not_allowed", message).with("name", n))
        }
        _ => ControlFlow::Continue(()),
    }
}

impl Visitor for ReadOnlyCheck {
    type Break = Rejected;

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<Rejected> {
        // Also reached for statements nested in a query, such as `WITH d AS (DELETE ...)`.
        if matches!(statement, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(Rejected::new("sql.not_select", "only SELECT and WITH queries are allowed"))
        }
    }

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<Rejected> {
        if !query.locks.is_empty() {
            return ControlFlow::Break(Rejected::new(
                "sql.locking_clause",
                "locking clauses (FOR UPDATE, FOR SHARE) are not allowed",
            ));
        }
        if matches!(*query.body, SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_)) {
            return ControlFlow::Break(Rejected::new("sql.not_select", "only SELECT and WITH queries are allowed"));
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<Rejected> {
        if select.into.is_some() {
            return ControlFlow::Break(Rejected::new("sql.select_into", "SELECT ... INTO is not allowed"));
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<Rejected> {
        // `FROM LATERAL f(...)` and `FROM f(...)` are table factors, not expressions.
        if self.engine == Engine::MsSql {
            // `FROM t OPTION (TABLE HINT (t, TABLOCKX))` and `FROM t x (TABLOCKX)` parse as
            // aliases with a column list; T-SQL has no such column lists on tables, so a query
            // hint or an old-style table hint is behind them.
            if let Some(alias) = factor_alias(factor) {
                if alias.name.value.eq_ignore_ascii_case("option") && alias.name.quote_style.is_none() {
                    return ControlFlow::Break(Rejected::new(
                        "sql.query_hint",
                        "query hints (OPTION (...)) are not allowed",
                    ));
                }
                // A column list naming only harmless hints is the old form of `WITH (NOLOCK)`.
                let hinted = alias.columns.iter().any(|c| {
                    let name = c.name.value.to_ascii_lowercase();
                    c.data_type.is_some()
                        || (MSSQL_HINT_WORDS.contains(&name.as_str()) && !ALLOWED_MSSQL_HINTS.contains(&name.as_str()))
                });
                if hinted {
                    let message = format!(
                        "the table hints after {} are not allowed; write WITH (NOLOCK) instead",
                        alias.name.value
                    );
                    return ControlFlow::Break(
                        Rejected::new("sql.legacy_table_hint", message).with("alias", &alias.name.value),
                    );
                }
            }
        }
        if let TableFactor::Table { with_hints, args, .. } = factor
            && self.engine == Engine::MsSql
        {
            // Hints written `WITH (...)` and the old form `t (TABLOCKX)`, which parses like
            // table function arguments.
            let mut hints: Vec<String> = with_hints.iter().map(hint_name).collect();
            if let Some(args) = args {
                hints.extend(
                    args.args
                        .iter()
                        .map(|a| a.to_string().to_ascii_lowercase())
                        .filter(|a| MSSQL_HINT_WORDS.contains(&a.as_str())),
                );
            }
            if let Some(bad) = hints.iter().find(|h| !ALLOWED_MSSQL_HINTS.contains(&h.as_str())) {
                let message = format!(
                    "the table hint {bad} is not allowed; only NOLOCK, READUNCOMMITTED, INDEX, NOEXPAND and FORCESEEK are"
                );
                return ControlFlow::Break(Rejected::new("sql.table_hint", message).with("hint", bad));
            }
        }
        // Table functions such as OPENROWSET(...) appear here, with arguments; plain table and
        // view names are not function calls and are not checked.
        match factor {
            TableFactor::Function { name, .. } => forbidden(name, self.engine),
            TableFactor::Table { name, args: Some(_), .. } => forbidden(name, self.engine),
            _ => ControlFlow::Continue(()),
        }
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<Rejected> {
        match expr {
            Expr::Function(f) => forbidden(&f.name, self.engine),
            _ => ControlFlow::Continue(()),
        }
    }
}

/// The interval between points: the requested one, or the time range divided by the points the
/// panel can show, rounded up to a familiar step.
pub fn interval_ms(range: TimeRange, requested: Option<u64>, max_data_points: Option<u32>) -> u64 {
    /// Steps people read at a glance, in milliseconds.
    const STEPS: &[u64] = &[
        1,
        2,
        5,
        10,
        20,
        50,
        100,
        200,
        500,
        1_000,
        2_000,
        5_000,
        10_000,
        15_000,
        30_000,
        60_000,
        120_000,
        300_000,
        600_000,
        900_000,
        1_800_000,
        3_600_000,
        7_200_000,
        10_800_000,
        21_600_000,
        43_200_000,
        86_400_000,
        604_800_000,
    ];
    const DEFAULT_POINTS: u64 = 1_000;
    if let Some(ms) = requested.filter(|ms| *ms > 0) {
        return ms;
    }
    let span = range.to.saturating_sub(range.from).max(0) as u64;
    let points = max_data_points.map_or(DEFAULT_POINTS, |p| u64::from(p.max(1)));
    let raw = span.div_ceil(points).max(1);
    STEPS.iter().copied().find(|s| *s >= raw).unwrap_or(raw)
}

/// `30s`, `5m`, `1h`, `250ms`: the interval as text for engines without an interval type.
pub fn format_interval(ms: i64) -> String {
    for (unit, size) in [("d", 86_400_000), ("h", 3_600_000), ("m", 60_000), ("s", 1_000)] {
        if ms >= size && ms % size == 0 {
            return format!("{}{unit}", ms / size);
        }
    }
    format!("{ms}ms")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ALL: [Engine; 4] = [Engine::Postgres, Engine::MySql, Engine::Sqlite, Engine::MsSql];

    fn ctx(vars: &BTreeMap<String, Value>) -> Context<'_> {
        Context {
            range: TimeRange { from: 1_000, to: 61_000 },
            interval_ms: 30_000,
            variables: vars,
            identifiers: None,
            identifier_variables: None,
        }
    }

    fn rejected(sql: &str, engine: Engine) -> String {
        let vars = BTreeMap::new();
        match prepare(sql, engine, &ctx(&vars)) {
            Err(rejected) => rejected.message,
            Ok(p) => panic!("{engine:?} accepted {sql}: {p:?}"),
        }
    }

    fn accepted(sql: &str, engine: Engine) -> Prepared {
        let vars = BTreeMap::from([("land".to_string(), json!("Österreich")), ("ids".to_string(), json!([1, 2, 3]))]);
        prepare(sql, engine, &ctx(&vars)).unwrap_or_else(|e| panic!("{engine:?} rejected {sql}: {e}"))
    }

    #[test]
    fn plain_selects_pass_unchanged() {
        for engine in ALL {
            let p = accepted("SELECT name, COUNT(*) FROM kunden GROUP BY name", engine);
            assert_eq!(p.sql, "SELECT name, COUNT(*) FROM kunden GROUP BY name");
            assert!(p.binds.is_empty());
            accepted("WITH t AS (SELECT 1 AS x) SELECT x FROM t", engine);
            accepted("SELECT 1;", engine);
        }
    }

    #[test]
    fn macros_become_bind_parameters() {
        let p = accepted("SELECT * FROM m WHERE $__timeFilter(ts) AND bucket = $__interval_ms", Engine::Postgres);
        assert_eq!(p.sql, "SELECT * FROM m WHERE (ts BETWEEN $1 AND $2) AND bucket = $3");
        assert_eq!(p.binds, [Bind::Time(1_000), Bind::Time(61_000), Bind::Int(30_000)]);

        let p = accepted("SELECT * FROM m WHERE ts >= $__timeFrom() AND ts < $__timeTo", Engine::MsSql);
        assert_eq!(p.sql, "SELECT * FROM m WHERE ts >= @P1 AND ts < @P2");

        let p = accepted("SELECT date_bin($__interval, ts, $__timeFrom) FROM m", Engine::Postgres);
        assert_eq!(p.binds, [Bind::Interval(30_000), Bind::Time(1_000)]);

        let p = accepted("SELECT * FROM m WHERE $__timeFilter(`Zeit punkt`)", Engine::MySql);
        assert_eq!(p.sql, "SELECT * FROM m WHERE (`Zeit punkt` BETWEEN ? AND ?)");
    }

    #[test]
    fn variables_are_bound_never_spliced() {
        let p = accepted("SELECT * FROM k WHERE land = $land AND id IN (${ids})", Engine::Sqlite);
        assert_eq!(p.sql, "SELECT * FROM k WHERE land = ? AND id IN (?, ?, ?)");
        assert_eq!(p.binds[0], Bind::Text("Österreich".into()));
        assert_eq!(p.binds[1..], [Bind::Int(1), Bind::Int(2), Bind::Int(3)]);

        // A value that looks like SQL stays a value.
        let vars = BTreeMap::from([("x".to_string(), json!("1; DROP TABLE k; --"))]);
        let p = prepare("SELECT * FROM k WHERE a = $x", Engine::Postgres, &ctx(&vars)).unwrap();
        assert_eq!(p.sql, "SELECT * FROM k WHERE a = $1");
        assert_eq!(p.binds, [Bind::Text("1; DROP TABLE k; --".into())]);

        assert!(rejected("SELECT $fehlt", Engine::Postgres).contains("no value"));
        let vars = BTreeMap::from([("o".to_string(), json!({ "a": 1 }))]);
        assert!(prepare("SELECT $o", Engine::Postgres, &ctx(&vars)).is_err());
        let vars = BTreeMap::from([("leer".to_string(), json!([]))]);
        let p = prepare("SELECT * FROM k WHERE id IN ($leer)", Engine::MySql, &ctx(&vars)).unwrap();
        assert_eq!(p.binds, [Bind::Null]);
    }

    #[test]
    fn substitutions_skip_strings_comments_and_quoted_names() {
        for (sql, engine) in [
            ("SELECT '$land' AS a", Engine::Postgres),
            ("SELECT 'it''s $land' AS a", Engine::Sqlite),
            ("SELECT \"$land\" FROM t", Engine::Postgres),
            ("SELECT 1 -- $land\n", Engine::MySql),
            ("SELECT 1 # $land\n", Engine::MySql),
            ("SELECT 1 /* $land /* nested */ $land */", Engine::Postgres),
            ("SELECT $tag$ $land $tag$", Engine::Postgres),
            ("SELECT $$ $land $$", Engine::Postgres),
            ("SELECT [$land] FROM t", Engine::MsSql),
            ("SELECT 'a\\' $land' AS a", Engine::MySql),
            ("SELECT E'a\\' $land' AS a", Engine::Postgres),
        ] {
            let p = accepted(sql, engine);
            assert!(p.binds.is_empty(), "{engine:?} {sql}: {p:?}");
            assert_eq!(p.sql, sql);
        }
        // Outside the string the variable is replaced; umlauts around it stay intact.
        let p = accepted("SELECT 'Grüße' AS gruß, $land AS ländle", Engine::Postgres);
        assert_eq!(p.sql, "SELECT 'Grüße' AS gruß, $1 AS ländle");
    }

    #[test]
    fn identifier_variables_need_the_schema_allow_list() {
        let vars = BTreeMap::from([
            ("tabelle".to_string(), json!("public.bestellungen")),
            ("böse".to_string(), json!("x")),
            ("spalten".to_string(), json!(["menge", "preis"])),
            ("fremd".to_string(), json!("pg_shadow")),
        ]);
        let allowed: BTreeSet<String> =
            ["public.bestellungen", "bestellungen", "menge", "preis"].iter().map(|s| s.to_string()).collect();
        let mut c = ctx(&vars);
        c.identifiers = Some(&allowed);
        let sql = "SELECT ${spalten:identifier} FROM ${tabelle:identifier}";
        assert!(uses_identifier_variables(sql, Engine::Postgres));
        let p = prepare(sql, Engine::Postgres, &c).unwrap();
        assert_eq!(p.sql, "SELECT \"menge\", \"preis\" FROM \"public\".\"bestellungen\"");
        assert!(p.binds.is_empty());
        let p = prepare(sql, Engine::MsSql, &c).unwrap();
        assert_eq!(p.sql, "SELECT [menge], [preis] FROM [public].[bestellungen]");
        let e = prepare("SELECT * FROM ${fremd:identifier}", Engine::Postgres, &c).unwrap_err();
        assert!(e.message.contains("not a table or column"), "{e}");
        assert!(prepare("SELECT * FROM ${tabelle:raw}", Engine::Postgres, &c).is_err());
        assert!(!uses_identifier_variables("SELECT $tabelle", Engine::Postgres));
        let mut no_schema = ctx(&vars);
        no_schema.identifiers = None;
        assert!(prepare(sql, Engine::Postgres, &no_schema).is_err());
    }

    #[test]
    fn hand_written_placeholders_are_refused() {
        assert!(rejected("SELECT * FROM t WHERE a = $1", Engine::Postgres).contains("placeholders"));
        assert!(rejected("SELECT * FROM t WHERE a = ?", Engine::MySql).contains("placeholders"));
        assert!(rejected("SELECT * FROM t WHERE a = :name", Engine::Sqlite).contains("placeholders"));
        assert!(rejected("SELECT * FROM t WHERE a = @P1", Engine::MsSql).contains("placeholders"));
        // The JSONB operator ? is not a placeholder in PostgreSQL.
        accepted("SELECT doc ? 'key' FROM t", Engine::Postgres);
        assert!(rejected("SELECT $__unbekannt", Engine::Postgres).contains("unknown macro"));
        assert!(rejected("SELECT * FROM t WHERE $__timeFilter(ts OR 1=1)", Engine::Postgres).contains("column"));
    }

    /// The statement check, per engine, for every rule in docs/ARCHITECTURE.md.
    #[test]
    fn writes_and_dangerous_functions_are_rejected_on_every_engine() {
        for engine in ALL {
            for sql in [
                "INSERT INTO t VALUES (1)",
                "UPDATE t SET a = 1",
                "DELETE FROM t",
                "DROP TABLE t",
                "CREATE TABLE x (a INT)",
                "SELECT 1; SELECT 2",
                "SELECT 1; DELETE FROM t",
                "",
            ] {
                rejected(sql, engine);
            }
        }
        let cases: &[(Engine, &[&str])] = &[
            (
                Engine::Postgres,
                &[
                    "SELECT * INTO neu FROM t",
                    "SELECT * FROM t FOR UPDATE",
                    "SELECT * FROM t FOR SHARE",
                    "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
                    "WITH u AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM u",
                    "SELECT pg_read_file('/etc/passwd')",
                    "SELECT pg_catalog.pg_read_binary_file('/etc/passwd')",
                    "SELECT lo_import('/etc/passwd')",
                    "SELECT * FROM dblink('host=x', 'SELECT 1') AS t(a int)",
                    "SELECT query_to_xml('SELECT pg_read_file(''/etc/passwd'')', true, true, '')",
                    "SELECT pg_terminate_backend(1)",
                    "SELECT set_config('x', 'y', false)",
                    "SELECT (SELECT PG_LS_DIR('.'))",
                    "COPY t TO '/tmp/x'",
                    "SET search_path = x",
                    "DO $$ BEGIN END $$",
                ],
            ),
            (
                Engine::MySql,
                &[
                    "SELECT LOAD_FILE('/etc/passwd')",
                    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
                    "SELECT * INTO OUTFILE '/tmp/x' FROM t",
                    "SELECT a INTO @v FROM t",
                    "SELECT * FROM t FOR UPDATE",
                    "SELECT * FROM t LOCK IN SHARE MODE",
                    "SELECT 1 /*!50000 INTO OUTFILE '/tmp/x' */",
                    "SELECT 1 /*M! INTO OUTFILE '/tmp/x' */",
                    "LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t",
                    "SET GLOBAL local_infile = 1",
                ],
            ),
            (
                Engine::Sqlite,
                &[
                    "SELECT load_extension('/tmp/evil')",
                    "SELECT writefile('/tmp/x', 'y')",
                    "SELECT readfile('/etc/passwd')",
                    "ATTACH DATABASE '/tmp/x.db' AS x",
                    "PRAGMA writable_schema = ON",
                    "VACUUM INTO '/tmp/copy.db'",
                    "WITH d AS (SELECT 1) DELETE FROM t",
                ],
            ),
            (
                Engine::MsSql,
                &[
                    "SELECT * INTO neu FROM t",
                    "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1') AS r",
                    "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=x').db.dbo.t",
                    "SELECT * FROM OPENQUERY(linked, 'SELECT 1')",
                    "SELECT * FROM sys.fn_get_audit_file('C:\\x\\*', DEFAULT, DEFAULT)",
                    "EXEC xp_cmdshell 'dir'",
                    "WITH c AS (SELECT 1 AS a) DELETE FROM t",
                ],
            ),
        ];
        for (engine, sqls) in cases {
            for sql in *sqls {
                let reason = rejected(sql, *engine);
                assert!(!reason.is_empty(), "{engine:?} {sql}");
            }
        }
        assert!(rejected("SELECT LOAD_FILE('/etc/passwd')", Engine::MySql).contains("load_file"));
        assert!(rejected("SELECT * FROM t FOR UPDATE", Engine::Postgres).contains("locking"));
        assert!(rejected("SELECT * INTO neu FROM t", Engine::MsSql).contains("INTO"));
        assert!(rejected("SELECT 1 /*!50000 INTO OUTFILE '/x' */", Engine::MySql).contains("executable comments"));
    }

    /// MySQL reads `--` as a comment only before a space or control character; otherwise the
    /// text after it is SQL, and the checker must see it as SQL too.
    #[test]
    fn mysql_dash_comments_follow_the_server() {
        // Not a comment for MySQL: the rest is checked (and here refused).
        rejected("SELECT 1 --x\nUNION SELECT LOAD_FILE('/etc/passwd')", Engine::MySql);
        let p = accepted("SELECT 2 --1", Engine::MySql);
        assert_eq!(p.sql, "SELECT 2 --1");
        let p = accepted("SELECT 2 --$land", Engine::MySql);
        assert_eq!((p.sql.as_str(), p.binds.len()), ("SELECT 2 --?", 1));
        // A comment for MySQL: nothing in it is substituted.
        accepted("SELECT 1 -- $land\n", Engine::MySql);
        accepted("SELECT 1 --\t$land\n", Engine::MySql);
        // Where the parsers would disagree, the query is refused.
        assert!(rejected("SELECT 1 --\u{a0}x\n", Engine::MySql).contains("ordinary space"));
        // Executable comments are refused anywhere, also where a string or comment hides them.
        for sql in ["SELECT '/*!50000'", "SELECT 1 -- /*M! x */\n", "SELECT 1 /* /*m! */"] {
            assert!(rejected(sql, Engine::MySql).contains("executable"), "{sql}");
        }
        // Other engines read every `--` as a comment.
        accepted("SELECT 1 --$land", Engine::Postgres);
    }

    #[test]
    fn functions_in_from_are_checked_too() {
        for sql in [
            "SELECT * FROM LATERAL pg_read_file('/etc/passwd') AS f",
            "SELECT * FROM t, LATERAL pg_ls_dir('.') AS d",
            "SELECT * FROM pg_ls_dir('.') AS d",
        ] {
            assert!(rejected(sql, Engine::Postgres).contains("not allowed"), "{sql}");
        }
        assert!(rejected("SELECT GET_LOCK('x', 1)", Engine::MySql).contains("get_lock"));
        assert!(rejected("SELECT NEXT VALUE FOR dbo.s", Engine::MsSql).contains("sequence"));
        assert!(rejected("SELECT 1 WHERE 2 = (SELECT next  VALUE\n FOR s)", Engine::MsSql).contains("sequence"));
    }

    #[test]
    fn engine_syntax_passes() {
        accepted("SELECT DISTINCT ON (a) a, b::text, c->>'k' FROM t ORDER BY a LIMIT 5", Engine::Postgres);
        accepted("SELECT TOP 10 [Name], CAST(ts AS date) FROM dbo.t ORDER BY 1", Engine::MsSql);
        accepted("SELECT `a`, IFNULL(b, 0) FROM t LIMIT 5 OFFSET 2", Engine::MySql);
        accepted("SELECT * FROM pragma_table_info('t')", Engine::Sqlite);
        accepted("SELECT a FROM t UNION ALL SELECT b FROM u", Engine::Sqlite);
        accepted("SELECT ts, avg(v) FROM m WHERE $__timeFilter(ts) GROUP BY 1 ORDER BY 1", Engine::Postgres);
    }

    #[test]
    fn intervals_round_to_familiar_steps() {
        let hour = TimeRange { from: 0, to: 3_600_000 };
        assert_eq!(interval_ms(hour, None, Some(1_000)), 5_000);
        assert_eq!(interval_ms(hour, None, Some(60)), 60_000);
        assert_eq!(interval_ms(hour, Some(1_234), None), 1_234);
        assert_eq!(interval_ms(TimeRange { from: 10, to: 10 }, None, None), 1);
        assert_eq!(interval_ms(TimeRange { from: 10, to: 0 }, None, Some(0)), 1);
        assert_eq!(format_interval(30_000), "30s");
        assert_eq!(format_interval(300_000), "5m");
        assert_eq!(format_interval(7_200_000), "2h");
        assert_eq!(format_interval(86_400_000), "1d");
        assert_eq!(format_interval(250), "250ms");
    }

    #[test]
    fn postgres_unicode_escapes_are_refused() {
        for sql in [r#"SELECT U&"pg_read_fil\0065"('/etc/passwd')"#, r#"SELECT u&"x" FROM t"#, "SELECT U&'\\0041' AS a"]
        {
            assert!(rejected(sql, Engine::Postgres).contains("Unicode"), "{sql}");
        }
        // Inside a string or comment the letters mean nothing.
        accepted("SELECT 'U&\"x\"' AS a -- U&'y'\n", Engine::Postgres);
        accepted("SELECT menu & 3 FROM t", Engine::Postgres);
    }

    #[test]
    fn postgres_functions_with_side_effects_are_refused() {
        for f in [
            "pg_switch_wal()",
            "pg_create_restore_point('x')",
            "pg_stat_reset()",
            "pg_stat_reset_shared('bgwriter')",
            "pg_logical_slot_get_changes('s', NULL, NULL)",
            "pg_logical_slot_peek_changes('s', NULL, NULL)",
            "pg_create_logical_replication_slot('s', 'pgoutput')",
            "pg_drop_replication_slot('s')",
            "pg_replication_origin_create('o')",
            "pg_log_backend_memory_contexts(1)",
            "pg_backup_start('x')",
            "pg_backup_stop()",
            "pg_promote()",
            "pg_reload_conf()",
            "pg_rotate_logfile()",
            "set_config('a', 'b', false)",
            "pg_advisory_xact_lock(1)",
            "pg_advisory_unlock_all()",
            "pg_notify('c', 'p')",
            "nextval('s')",
            "setval('s', 1)",
        ] {
            let sql = format!("SELECT {f}");
            assert!(rejected(&sql, Engine::Postgres).contains("not allowed"), "{sql}");
        }
        accepted("SELECT pg_size_pretty(1024), lower('A')", Engine::Postgres);
    }

    #[test]
    fn sql_server_table_hints_are_limited_to_reads_without_locks() {
        accepted("SELECT a FROM t WITH (NOLOCK)", Engine::MsSql);
        accepted("SELECT a FROM t WITH (READUNCOMMITTED) JOIN u WITH (NOLOCK) ON t.id = u.id", Engine::MsSql);
        for sql in [
            "SELECT a FROM t WITH (TABLOCKX)",
            "SELECT a FROM t WITH (HOLDLOCK)",
            "SELECT a FROM t WITH (UPDLOCK, ROWLOCK)",
            "SELECT a FROM t WITH (NOLOCK, XLOCK)",
            "SELECT a FROM t JOIN u WITH (PAGLOCK) ON t.id = u.id",
            "WITH c AS (SELECT 1 AS a) SELECT a FROM c WITH (TABLOCK)",
            "SELECT a FROM t (TABLOCKX)",
            "SELECT a FROM t OPTION (TABLE HINT (t, TABLOCKX))",
        ] {
            rejected(sql, Engine::MsSql);
        }
        // A table-valued function's arguments are not hints.
        accepted("SELECT * FROM sys.dm_exec_sql_text(0x01)", Engine::MsSql);
        // Query hints and the old hint form after an alias, also with a comment in between.
        for sql in [
            "SELECT a FROM t OPTION/**/(TABLE HINT (t, TABLOCKX))",
            "SELECT a FROM t option (MAXDOP 1)",
            "SELECT a FROM t x (TABLOCKX)",
            "SELECT a FROM t AS x (HOLDLOCK)",
            "SELECT x.a FROM t x (UPDLOCK) JOIN u ON u.id = x.id",
        ] {
            rejected(sql, Engine::MsSql);
        }
        // OPTION after any kind of table, and hint lists behind other table factors.
        for sql in [
            "SELECT a FROM t CROSS APPLY OPENJSON(t.j) OPTION (TABLE HINT (t, TABLOCKX))",
            "SELECT a FROM t CROSS APPLY OPENJSON(t.j) AS j OPTION (MAXDOP 1)",
            "SELECT a FROM t WHERE a = 1 OPTION (TABLE HINT (t, TABLOCKX))",
            "SELECT a FROM (SELECT 1 AS a) d (TABLOCKX)",
        ] {
            assert!(!rejected(sql, Engine::MsSql).is_empty(), "{sql}");
        }
        // Harmless hints and forms.
        accepted("SELECT a FROM t WITH (INDEX(ix), NOLOCK)", Engine::MsSql);
        accepted("SELECT a FROM t WITH (INDEX = ix)", Engine::MsSql);
        accepted("SELECT a FROM t WITH (FORCESEEK)", Engine::MsSql);
        accepted("SELECT a FROM t x (NOLOCK)", Engine::MsSql);
        accepted("SELECT [option].a FROM t AS [option]", Engine::MsSql);
        accepted("SELECT a FROM t -- option (x)\n", Engine::MsSql);
        accepted("SELECT a FROM v WITH (NOEXPAND)", Engine::MsSql);
        accepted("SELECT 'option (x)' AS a FROM t", Engine::MsSql);
        accepted("SELECT a FROM (VALUES (1)) AS v (a)", Engine::MsSql);
    }

    #[test]
    fn names_that_look_like_forbidden_functions_are_fine_as_tables() {
        for engine in ALL {
            for sql in [
                "SELECT * FROM lo_kunden",
                "SELECT * FROM pg_create_jobs",
                "SELECT * FROM dblinks",
                "SELECT * FROM edit",
            ] {
                accepted(sql, engine);
            }
        }
        accepted("SELECT * FROM pg_replication_origin_status", Engine::Postgres);
        // The PostgreSQL prefix families are PostgreSQL's only.
        accepted("SELECT lo_mein(1)", Engine::MySql);
        rejected("SELECT lo_mein(1)", Engine::Postgres);
    }

    #[test]
    fn identifier_formatting_can_be_limited_to_checked_variables() {
        let vars = BTreeMap::from([("spalte".to_string(), json!("land")), ("frei".to_string(), json!("land"))]);
        let allowed_names: BTreeSet<String> = ["land".to_string()].into();
        let checked: BTreeSet<String> = ["spalte".to_string()].into();
        let mut c = ctx(&vars);
        c.identifiers = Some(&allowed_names);
        c.identifier_variables = Some(&checked);
        assert!(prepare("SELECT ${spalte:identifier} FROM t", Engine::Postgres, &c).is_ok());
        let e = prepare("SELECT ${frei:identifier} FROM t", Engine::Postgres, &c).unwrap_err();
        assert!(e.message.contains("cannot be an identifier"), "{e}");
        // As a plain value the same variable is fine.
        assert!(prepare("SELECT 1 FROM t WHERE a = $frei", Engine::Postgres, &c).is_ok());
    }
}
