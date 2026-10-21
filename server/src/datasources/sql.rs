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
    Expr, ObjectName, ObjectNamePart, Query, Select, SetExpr, Statement, TableFactor, Visit, Visitor,
};
use sqlparser::dialect::{Dialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::shapes::TimeRange;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Postgres,
    MySql,
    Sqlite,
    MsSql,
}

/// Why a query is not run. Answered as `query_rejected` with this text.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Rejected(pub String);

fn reject<T>(msg: impl Into<String>) -> Result<T, Rejected> {
    Err(Rejected(msg.into()))
}

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
    "pg_advisory_lock",
    "pg_advisory_lock_shared",
    "pg_try_advisory_lock",
    "pg_try_advisory_lock_shared",
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
                let value = variable(ctx, name)?;
                let allowed = ctx.identifiers.ok_or_else(|| Rejected("identifier variables need the schema".into()))?;
                let names: Vec<&Value> = match value {
                    Value::Array(items) => items.iter().collect(),
                    other => vec![other],
                };
                if names.is_empty() {
                    return reject(format!("variable {name} has no value"));
                }
                let mut quoted = Vec::new();
                for n in names {
                    let Some(n) = n.as_str().filter(|n| allowed.contains(*n)) else {
                        return reject(format!("variable {name} is not a table or column of this data source"));
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
    ctx.variables.get(name).ok_or_else(|| Rejected(format!("variable {name} has no value")))
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
            return reject(format!("variable {name} must be a string, number, boolean or a list of them"));
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
        return reject("MySQL executable comments (/*! ... */) are not allowed");
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
            let close = sql[i..].find('}').map(|p| i + p).ok_or_else(|| Rejected("unclosed ${...}".into()))?;
            let inner = &sql[i + 2..close];
            let (name, format) = match inner.split_once(':') {
                Some((n, f)) => (n, Some(f)),
                None => (inner, None),
            };
            if !valid_variable_name(name) {
                return reject(format!("invalid variable name in ${{{inner}}}"));
            }
            let piece = match format {
                None => Piece::Variable(name),
                Some("identifier") => Piece::Identifier(name),
                Some(other) => return reject(format!("unknown variable format :{other}; only :identifier exists")),
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
            return reject("write variables as $name; parameter placeholders are not supported");
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
        Some(c) if c.is_whitespace() => reject("write -- comments with an ordinary space after the dashes"),
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
                return reject("$__timeFilter needs a column: $__timeFilter(created_at)");
            }
            let close = sql[name_end..]
                .find(')')
                .map(|p| name_end + p)
                .ok_or_else(|| Rejected("unclosed $__timeFilter(".into()))?;
            let column = sql[name_end + 1..close].trim();
            if !is_column_reference(column) {
                return reject("$__timeFilter takes a column name such as created_at or t.\"Zeitpunkt\"");
            }
            Ok((Piece::TimeFilter(column), close + 1))
        }
        other => reject(format!("unknown macro ${other}")),
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
    reject("unclosed quote")
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
    reject("unclosed [")
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
    reject("unclosed comment")
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
        None => reject("unclosed dollar-quoted string"),
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
        return reject("NEXT VALUE FOR changes a sequence and is not allowed");
    }
    let statements = Parser::parse_sql(dialect(engine).as_ref(), sql)
        .map_err(|e| Rejected(format!("the query could not be checked: {e}")))?;
    let [statement] = statements.as_slice() else {
        return reject(if statements.is_empty() { "the query is empty" } else { "only one statement is allowed" });
    };
    if !matches!(statement, Statement::Query(_)) {
        return reject("only SELECT and WITH queries are allowed");
    }
    match statement.visit(&mut ReadOnlyCheck) {
        ControlFlow::Break(reason) => Err(Rejected(reason)),
        ControlFlow::Continue(()) => Ok(()),
    }
}

struct ReadOnlyCheck;

fn last_name_part(name: &ObjectName) -> Option<String> {
    match name.0.last()? {
        ObjectNamePart::Identifier(ident) => Some(ident.value.to_ascii_lowercase()),
        ObjectNamePart::Function(f) => Some(f.name.value.to_ascii_lowercase()),
    }
}

fn forbidden(name: &ObjectName) -> ControlFlow<String> {
    match last_name_part(name) {
        Some(n) if FORBIDDEN_FUNCTIONS.contains(&n.as_str()) => {
            ControlFlow::Break(format!("{n} is not allowed: it reaches files, other servers or other sessions"))
        }
        _ => ControlFlow::Continue(()),
    }
}

impl Visitor for ReadOnlyCheck {
    type Break = String;

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<String> {
        // Also reached for statements nested in a query, such as `WITH d AS (DELETE ...)`.
        if matches!(statement, Statement::Query(_)) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break("only SELECT and WITH queries are allowed".into())
        }
    }

    fn pre_visit_query(&mut self, query: &Query) -> ControlFlow<String> {
        if !query.locks.is_empty() {
            return ControlFlow::Break("locking clauses (FOR UPDATE, FOR SHARE) are not allowed".into());
        }
        if matches!(*query.body, SetExpr::Insert(_) | SetExpr::Update(_) | SetExpr::Delete(_) | SetExpr::Merge(_)) {
            return ControlFlow::Break("only SELECT and WITH queries are allowed".into());
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<String> {
        if select.into.is_some() {
            return ControlFlow::Break("SELECT ... INTO is not allowed".into());
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_table_factor(&mut self, factor: &TableFactor) -> ControlFlow<String> {
        // `FROM LATERAL f(...)` and `FROM f(...)` are table factors, not expressions.
        match factor {
            TableFactor::Function { name, .. } => forbidden(name),
            TableFactor::Table { name, args: Some(_), .. } => forbidden(name),
            _ => ControlFlow::Continue(()),
        }
    }

    fn pre_visit_relation(&mut self, relation: &ObjectName) -> ControlFlow<String> {
        // Table functions such as OPENROWSET(...) appear as relations.
        forbidden(relation)
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<String> {
        match expr {
            Expr::Function(f) => forbidden(&f.name),
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
        }
    }

    fn rejected(sql: &str, engine: Engine) -> String {
        let vars = BTreeMap::new();
        match prepare(sql, engine, &ctx(&vars)) {
            Err(Rejected(reason)) => reason,
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
        assert!(e.0.contains("not a table or column"), "{e}");
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
}
