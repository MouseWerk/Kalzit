//! Oracle Database over its TNS protocol, with a pure Rust driver (`oracle-rs`): no Oracle
//! Client is needed to build Kalzit or to run it, on Windows or Linux.
//!
//! Read-only as the other SQL sources: the statement check (`sql::check_statement` with
//! Oracle's dialect: one `SELECT`/`WITH`, no locking clauses, no database links, no packages that
//! reach the network or files or run SQL given as text), and every query in a transaction opened
//! with `SET TRANSACTION READ ONLY` and rolled back after, so Oracle itself refuses a change
//! (ORA-01456). The settings form asks for a login with only `CREATE SESSION` and `SELECT`
//! grants, the real boundary.
//!
//! The driver connects to the address Kalzit resolved and checked, never to a name; the listener
//! may not redirect it elsewhere (the driver refuses redirects). With TLS the certificate is
//! checked against the configured host name.

use std::io::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use oracle_rs::{ColumnInfo, LobValue, OracleType, Value as OraValue};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Detail;
use super::frame::{Column, FrameBuilder};
use super::pool::{ConnPool, Lease, Pooled};
use super::sql::{self, Bind, Engine};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("host", "datasources.settings.host", SettingType::String).target().required(),
    SettingField::new("port", "datasources.settings.port", SettingType::Number)
        .target()
        .default(DefaultValue::Number(1521)),
    SettingField::new("serviceName", "datasources.settings.serviceName", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target().required(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("tls", "datasources.settings.tls", SettingType::Bool).target().default(DefaultValue::Bool(false)),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Rows per round trip after the first answer.
const FETCH_ROWS: u32 = 500;
const MAX_SCHEMA_COLUMNS: usize = 20_000;
/// How long closing an abandoned connection may take.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// Oracle's error numbers Kalzit tells apart.
const INVALID_LOGIN: u32 = 1017;
const ACCOUNT_LOCKED: u32 = 28000;
const PASSWORD_EXPIRED: u32 = 28001;
const READ_ONLY_TRANSACTION: u32 = 1456;

pub fn kind() -> Kind {
    Kind { name: "Oracle", hint_key: "datasources.kinds.oracle.hint", settings: SETTINGS, plugin: Arc::new(Oracle) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    host: String,
    port: Option<u64>,
    service_name: String,
    user: String,
    tls: Option<bool>,
    ca_cert: Option<String>,
}

pub struct Oracle;

struct Conn {
    conn: oracle_rs::Connection,
    /// A result was left open or a call failed midway: never reuse.
    broken: bool,
    /// Leases so far. The driver keeps the server's cursors open, so a session is closed after
    /// `MAX_USES` before it nears Oracle's `OPEN_CURSORS` (300 by default).
    uses: u32,
}

/// Leases of one session, a few statements each.
const MAX_USES: u32 = 50;

impl Pooled for Conn {
    fn reusable(&mut self) -> bool {
        !self.broken && self.uses < MAX_USES && !self.conn.is_closed()
    }

    /// Logs off; the server ends what the session was doing with it.
    async fn abandon(self) {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, self.conn.close()).await;
    }
}

pub(crate) fn failed(e: oracle_rs::Error) -> SourceError {
    use oracle_rs::Error as E;
    match e {
        E::OracleError { code, message } | E::ServerError { code, message } => match code {
            INVALID_LOGIN | ACCOUNT_LOCKED | PASSWORD_EXPIRED => {
                super::connect::auth_failed(format!("ORA-{code:05}: {}", message.trim()))
            }
            READ_ONLY_TRANSACTION => SourceError::rejected(
                "query.write_refused",
                format!("the query tried to write: ORA-{code:05}: {}", message.trim()),
            )
            .with("detail", message.trim()),
            _ => {
                let text = format!("ORA-{code:05}: {}", message.trim());
                SourceError::failed("oracle.error", format!("Oracle answered an error: {text}"))
                    .with("code", format!("ORA-{code:05}"))
                    .with("detail", text)
            }
        },
        E::InvalidCredentials | E::AuthenticationFailed(_) => super::connect::auth_failed(e.to_string()),
        E::InvalidServiceName { .. } | E::InvalidSid { .. } | E::ConnectionRefused { .. } => {
            let text = e.to_string();
            SourceError::failed(
                "oracle.listener_refused",
                format!("the Oracle listener refused the connection: {text}"),
            )
            .with("detail", text)
        }
        E::ConnectionRedirect(_) | E::ConnectionRedirected { .. } => SourceError::failed(
            "oracle.redirect_refused",
            "the Oracle listener redirected the connection to another address, which Kalzit does not follow",
        ),
        E::NativeNetworkEncryptionRequired => SourceError::failed(
            "oracle.encryption_required",
            "the server requires Oracle native network encryption; use TLS (TCPS) instead",
        ),
        E::Io(io) if super::connect::is_dead(io.kind()) => super::connect::lost(io),
        E::ConnectionClosed | E::ConnectionClosedByServer(_) => super::connect::lost(e.to_string()),
        other => SourceError::from_source(other.to_string()),
    }
}

async fn pool(conn: &Connection) -> Result<Arc<ConnPool<Conn>>, SourceError> {
    conn.shared(|| async { Ok(ConnPool::new(POOL_SIZE, IDLE_TIMEOUT)) }).await
}

/// The host as the driver writes it into `host:port`: IPv6 in brackets.
fn host_text(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) => format!("[{v6}]"),
        IpAddr::V4(v4) => v4.to_string(),
    }
}

/// The driver's configuration for one checked address.
fn config(
    addr: SocketAddr,
    s: &Settings,
    password: &str,
    ca_file: Option<&std::path::Path>,
) -> Result<oracle_rs::Config, SourceError> {
    let mut config =
        oracle_rs::Config::new(host_text(addr.ip()), addr.port(), s.service_name.trim(), s.user.trim(), password)
            .connect_timeout(CONNECT_TIMEOUT)
            .stmtcachesize(0);
    if s.tls.unwrap_or(false) {
        // The certificate is checked against the configured name, not the address.
        let mut tls = oracle_rs::TlsConfig::new().with_server_name(s.host.trim_matches(['[', ']']));
        if let Some(path) = ca_file {
            tls = tls.with_ca_cert(path.to_string_lossy());
        }
        config = config.tls_config(tls);
    }
    Ok(config)
}

async fn open(conn: &Connection) -> Result<Conn, SourceError> {
    crate::http::ensure_crypto_provider();
    let s: Settings = conn.settings_as()?;
    let port = s.port.unwrap_or(1521) as u16;
    let addrs = conn.policy().resolve_all(&s.host, port).await?;
    let password = conn.secret("password").unwrap_or("");
    // The driver reads a CA from a file: the PEM is written to a private temporary file for
    // the connect and removed after.
    let ca = match s.ca_cert.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(pem) if s.tls.unwrap_or(false) => {
            let mut file = tempfile::NamedTempFile::new().map_err(|e| SourceError::from_source(e.to_string()))?;
            file.write_all(pem.as_bytes()).map_err(|e| SourceError::from_source(e.to_string()))?;
            Some(file)
        }
        _ => None,
    };
    let address = super::connect::address(&s.host, port);
    let mut last = None;
    for addr in addrs {
        let config = config(addr, &s, password, ca.as_ref().map(|f| f.path()))?;
        match tokio::time::timeout(CONNECT_TIMEOUT, oracle_rs::Connection::connect_with_config(config)).await {
            Ok(Ok(c)) => return Ok(Conn { conn: c, broken: false, uses: 0 }),
            // `localhost` may be ::1 and 127.0.0.1 with the listener on one: try the next.
            Ok(Err(oracle_rs::Error::Io(io))) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
                last = Some(SourceError::Failed(super::connect::connect_failed(&address, &io, CONNECT_TIMEOUT)));
            }
            Ok(Err(e)) => return Err(failed(e)),
            Err(_) => last = Some(SourceError::Failed(super::connect::timed_out(&address, CONNECT_TIMEOUT))),
        }
    }
    Err(last.unwrap_or_else(|| SourceError::Failed(super::connect::timed_out(&address, CONNECT_TIMEOUT))))
}

async fn lease(conn: &Connection, pool: &Arc<ConnPool<Conn>>) -> Result<Lease<Conn>, SourceError> {
    let mut lease = pool.checkout(|| open(conn)).await?;
    lease.uses += 1;
    Ok(lease)
}

/// A bound value as the driver sends it: times as UTC text in the format the placeholder's
/// `TO_TIMESTAMP` reads (`sql::engine_placeholder`), intervals as seconds, booleans as 1 and 0
/// (Oracle SQL has no boolean before 23ai).
pub(crate) fn bind_value(bind: &Bind) -> Result<OraValue, SourceError> {
    Ok(match bind {
        Bind::Null => OraValue::Null,
        Bind::Bool(b) => OraValue::Integer(i64::from(*b)),
        Bind::Int(i) => OraValue::Integer(*i),
        Bind::Float(f) => OraValue::Float(*f),
        Bind::Text(t) => OraValue::String(t.clone()),
        Bind::Time(ms) => OraValue::String(super::bind_time(*ms)?.format("%Y-%m-%d %H:%M:%S%.3f").to_string()),
        Bind::Interval(ms) => OraValue::Float(*ms as f64 / 1000.0),
    })
}

/// The field type of a column, from its Oracle type.
fn field_type(c: &ColumnInfo) -> FieldType {
    match c.oracle_type {
        // NUMBER(p) with up to 15 digits fits a double exactly; other NUMBERs stay exact text.
        OracleType::Number if c.scale == 0 && (1..=15).contains(&c.precision) => FieldType::Number,
        OracleType::Number => FieldType::Decimal,
        OracleType::BinaryFloat | OracleType::BinaryDouble | OracleType::BinaryInteger => FieldType::Number,
        OracleType::Date | OracleType::Timestamp | OracleType::TimestampTz | OracleType::TimestampLtz => {
            FieldType::Time
        }
        OracleType::Boolean => FieldType::Bool,
        OracleType::Json | OracleType::Vector => FieldType::Json,
        _ if c.is_json => FieldType::Json,
        _ => FieldType::String,
    }
}

/// What a result needs to say about its values.
#[derive(Default)]
struct Notes {
    binary: bool,
    lob_skipped: bool,
    unsupported: bool,
}

fn finite(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// One value as its column's field type wants it.
fn convert(value: &OraValue, field_type: FieldType, notes: &mut Notes) -> Value {
    let naive = |y: i32, mo: u8, d: u8, h: u8, mi: u8, s: u8, us: u32| {
        chrono::NaiveDate::from_ymd_opt(y, u32::from(mo), u32::from(d))
            .and_then(|day| day.and_hms_micro_opt(u32::from(h), u32::from(mi), u32::from(s), us))
    };
    match value {
        OraValue::Null => Value::Null,
        OraValue::String(s) if field_type == FieldType::Json => serde_json::from_str(s).unwrap_or(json!(s)),
        OraValue::String(s) => json!(s),
        OraValue::Integer(i) => match field_type {
            FieldType::Decimal | FieldType::String => json!(i.to_string()),
            _ => json!(i),
        },
        OraValue::Float(f) => match field_type {
            FieldType::Decimal => json!(crate::analysis::expr::number_text(*f)),
            _ => finite(*f),
        },
        OraValue::Number(n) => match field_type {
            FieldType::Number => n.as_str().parse::<f64>().map_or(Value::Null, finite),
            _ => json!(n.as_str()),
        },
        OraValue::Date(d) => naive(d.year, d.month, d.day, d.hour, d.minute, d.second, 0)
            .map_or(Value::Null, |t| json!(super::naive_to_ms(t))),
        OraValue::Timestamp(ts) => {
            naive(ts.year, ts.month, ts.day, ts.hour, ts.minute, ts.second, ts.microsecond).map_or(Value::Null, |t| {
                // A value with a zone is that local time; UTC is the time less its offset.
                let offset = i64::from(ts.tz_hour_offset) * 3_600_000 + i64::from(ts.tz_minute_offset) * 60_000;
                json!(super::naive_to_ms(t) - offset)
            })
        }
        OraValue::Boolean(b) => json!(b),
        OraValue::Json(v) => v.clone(),
        OraValue::RowId(r) => json!(r.to_string()),
        OraValue::Bytes(b) => match std::str::from_utf8(b) {
            Ok(t) if field_type == FieldType::String => json!(t),
            _ => {
                notes.binary = true;
                Value::Null
            }
        },
        OraValue::Lob(LobValue::Inline(bytes)) => match std::str::from_utf8(bytes) {
            Ok(t) => json!(t),
            Err(_) => {
                notes.binary = true;
                Value::Null
            }
        },
        OraValue::Lob(LobValue::Empty) => json!(""),
        OraValue::Lob(LobValue::Null) => Value::Null,
        OraValue::Lob(LobValue::Locator(_)) => {
            notes.lob_skipped = true;
            Value::Null
        }
        OraValue::Vector(_) | OraValue::Cursor(_) | OraValue::Collection(_) => {
            notes.unsupported = true;
            Value::Null
        }
    }
}

impl Conn {
    /// Opens the transaction every query runs in: Oracle refuses any change inside it.
    async fn begin_read_only(&mut self) -> Result<(), SourceError> {
        self.broken = true;
        self.conn.execute("SET TRANSACTION READ ONLY", &[]).await.map_err(failed)?;
        self.broken = false;
        Ok(())
    }

    /// Runs `sql` and reads its rows into `frame`-ready values, up to `max_rows`, fetching more
    /// as needed. Answers the columns, the rows and whether rows were left unread.
    async fn rows(
        &mut self,
        sql: &str,
        binds: &[OraValue],
        max_rows: usize,
        mut keep: impl FnMut(&[ColumnInfo], Vec<Value>) -> bool,
        notes: &mut Notes,
    ) -> Result<(Vec<ColumnInfo>, bool), SourceError> {
        self.broken = true;
        let mut result = match self.conn.query(sql, binds).await {
            Ok(result) => result,
            // Oracle refused the statement (an unknown table, say): the session is fine.
            Err(e @ oracle_rs::Error::OracleError { .. }) => {
                self.broken = false;
                return Err(failed(e));
            }
            Err(e) => return Err(failed(e)),
        };
        let columns = result.columns.clone();
        let types: Vec<FieldType> = columns.iter().map(field_type).collect();
        let mut read = 0usize;
        loop {
            for row in &result.rows {
                let values = row.values().iter().zip(&types).map(|(v, t)| convert(v, *t, notes)).collect();
                read += 1;
                if read > max_rows || !keep(&columns, values) {
                    // The cursor stays open with rows in it: this connection is not reused.
                    return Ok((columns, true));
                }
            }
            if !result.has_more_rows {
                break;
            }
            result = self.conn.fetch_more(result.cursor_id, &columns, FETCH_ROWS).await.map_err(failed)?;
        }
        self.broken = false;
        Ok((columns, false))
    }

    /// `rows` for a statement of Kalzit's own: all values, at most `max_rows`.
    async fn all(&mut self, sql: &str, max_rows: usize) -> Result<Vec<Vec<Value>>, SourceError> {
        let mut out = Vec::new();
        let mut notes = Notes::default();
        let (_, cut) = self
            .rows(
                sql,
                &[],
                max_rows,
                |_, row| {
                    out.push(row);
                    true
                },
                &mut notes,
            )
            .await?;
        if cut {
            self.broken = true;
        }
        Ok(out)
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for Oracle {
    fn kind(&self) -> &'static str {
        "oracle"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        super::check_host("host", &s.host)?;
        super::check_port("port", s.port)?;
        // A service name, not a connect descriptor: no spaces, parentheses or `=`.
        let service = s.service_name.trim();
        if service.is_empty()
            || !service.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '$' | '#'))
        {
            return Err(FieldError::new(
                "serviceName",
                "settings.service_name_invalid",
                "the service name may hold letters, digits and _ - . $ # only",
            ));
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let pool = pool(conn).await?;
            let mut lease = lease(conn, &pool).await?;
            let version = lease
                .all("SELECT version FROM product_component_version WHERE product LIKE 'Oracle%' AND ROWNUM = 1", 1)
                .await?;
            let admin = lease
                .all(
                    "SELECT COUNT(*) FROM session_roles \
                     WHERE role IN ('DBA', 'IMP_FULL_DATABASE', 'DATAPUMP_IMP_FULL_DATABASE')",
                    1,
                )
                .await?;
            lease.release();
            let version = version.first().and_then(|r| r.first()).and_then(Value::as_str).unwrap_or("").to_string();
            let admin = admin.first().and_then(|r| r.first()).is_some_and(|v| v != &json!(0) && v != &json!("0"));
            Ok::<_, SourceError>((version, admin))
        };
        match check.await {
            Ok((version, admin)) => Health::connected("Oracle", &version, admin),
            Err(e) => Health::failed(&e),
        }
    }

    /// The columns of the tables and views the login can read, outside Oracle's own schemas.
    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let mut lease = lease(conn, &pool).await?;
        let found = lease
            .all(
                &format!(
                    "SELECT owner, table_name, column_name, data_type FROM all_tab_columns \
                     WHERE owner NOT IN (SELECT username FROM all_users WHERE oracle_maintained = 'Y') \
                     ORDER BY owner, table_name, column_id FETCH FIRST {MAX_SCHEMA_COLUMNS} ROWS ONLY"
                ),
                MAX_SCHEMA_COLUMNS,
            )
            .await?;
        lease.release();
        let text = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or("").to_string();
        let rows = found.iter().map(|r| (text(r.first()), text(r.get(1)), text(r.get(2)), text(r.get(3)))).collect();
        Ok(SourceSchema::Tables { tables: super::postgres::group_columns(rows) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::Oracle).await?;
        let binds = prepared.binds.iter().map(bind_value).collect::<Result<Vec<_>, _>>()?;
        let pool = pool(conn).await?;
        let mut lease = lease(conn, &pool).await?;
        // The first round trip: a pooled connection whose server went away fails here, before
        // any result, and the query runs once more on a fresh one, safe as it only reads.
        match lease.begin_read_only().await {
            Err(e) if super::connect::is_lost(&e) && lease.reused() => {
                lease.discard();
                lease = self::lease(conn, &pool).await?;
                lease.begin_read_only().await?;
            }
            other => other?,
        }
        let mut frame: Option<FrameBuilder> = None;
        let mut notes = Notes::default();
        let max_rows = req.limits.max_rows;
        let budget = req.limits.budget.clone();
        let read = lease
            .rows(
                &prepared.sql,
                &binds,
                // One more than the limit, so the frame says it was cut.
                max_rows.saturating_add(1),
                |columns, row| {
                    let f = frame.get_or_insert_with(|| {
                        let cols = columns.iter().map(|c| Column::new(c.name.clone(), Some(field_type(c)))).collect();
                        FrameBuilder::new(cols, max_rows, budget.clone())
                    });
                    f.push_row(row)
                },
                &mut notes,
            )
            .await;
        let (columns, cut) = match read {
            Ok(done) => done,
            Err(e) => {
                // Oracle refused the statement: end the transaction and keep the session.
                if !lease.broken && lease.conn.rollback().await.is_ok() {
                    lease.release();
                }
                return Err(e);
            }
        };
        if cut {
            // Closing the session ends the transaction and the open cursor.
            lease.discard();
        } else {
            lease.conn.rollback().await.map_err(failed)?;
            lease.release();
        }
        let mut frame = frame.unwrap_or_else(|| {
            let cols = columns.iter().map(|c| Column::new(c.name.clone(), Some(field_type(c)))).collect();
            FrameBuilder::new(cols, max_rows, req.limits.budget.clone())
        });
        frame.executed_query(prepared.sql);
        if notes.binary {
            frame.notice(
                NoticeSeverity::Warning,
                Detail::new("frame.binary_hidden", "binary values that are not text are shown empty"),
            );
        }
        if notes.lob_skipped {
            frame.notice(
                NoticeSeverity::Info,
                Detail::new(
                    "oracle.lob_skipped",
                    "large CLOB and BLOB values are shown empty; read a part of them in the query, such as \
                     TO_CHAR(SUBSTR(col, 1, 4000))",
                ),
            );
        }
        if notes.unsupported {
            frame.notice(
                NoticeSeverity::Info,
                Detail::new(
                    "oracle.type_unsupported",
                    "values of object, cursor and vector types are shown empty; convert them in the query",
                ),
            );
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::shapes::TimeRange;

    fn prepare(text: &str) -> Result<sql::Prepared, sql::Rejected> {
        let vars = BTreeMap::from([("land".to_string(), json!("Öster'reich")), ("ids".into(), json!([1, 2]))]);
        let ctx = sql::Context {
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 60_000,
            variables: &vars,
            identifiers: None,
            identifier_variables: None,
        };
        sql::prepare(text, Engine::Oracle, &ctx)
    }

    fn reason(text: &str) -> &'static str {
        prepare(text).unwrap_err().reason
    }

    #[test]
    fn macros_and_variables_are_bound_by_position() {
        let p = prepare(
            "SELECT TRUNC(t, 'MI') AS t, COUNT(*) FROM events WHERE $__timeFilter(t) AND land = $land \
             AND id IN ($ids) GROUP BY TRUNC(t, 'MI') ORDER BY 1 FETCH FIRST 100 ROWS ONLY",
        )
        .unwrap();
        assert_eq!(
            p.sql,
            "SELECT TRUNC(t, 'MI') AS t, COUNT(*) FROM events WHERE (t BETWEEN \
             TO_TIMESTAMP(:1, 'YYYY-MM-DD HH24:MI:SS.FF3') AND TO_TIMESTAMP(:2, 'YYYY-MM-DD HH24:MI:SS.FF3')) \
             AND land = :3 AND id IN (:4, :5) GROUP BY TRUNC(t, 'MI') ORDER BY 1 FETCH FIRST 100 ROWS ONLY"
        );
        assert!(matches!(bind_value(&p.binds[0]).unwrap(), OraValue::String(s) if s == "2027-01-15 08:00:00.000"));
        assert!(matches!(bind_value(&p.binds[2]).unwrap(), OraValue::String(s) if s == "Öster'reich"));
        assert!(matches!(bind_value(&Bind::Interval(90_000)).unwrap(), OraValue::Float(f) if f == 90.0));
        assert!(matches!(bind_value(&Bind::Bool(true)).unwrap(), OraValue::Integer(1)));
        let p = prepare("SELECT * FROM m WHERE t > SYSTIMESTAMP - $__interval").unwrap();
        assert!(p.sql.contains("NUMTODSINTERVAL(:1, 'SECOND')"), "{}", p.sql);
        // Dictionary views keep their $; a variable inside a string stays text.
        prepare("SELECT banner FROM v$version").unwrap();
        prepare("SELECT sid FROM v$session WHERE username = $land").unwrap();
        assert_eq!(prepare("SELECT '$land' AS x FROM dual").unwrap().sql, "SELECT '$land' AS x FROM dual");
    }

    #[test]
    fn writes_links_and_outside_reads_are_refused() {
        assert_eq!(reason("INSERT INTO t VALUES (1)"), "sql.not_select");
        assert_eq!(reason("DELETE FROM t"), "sql.not_select");
        assert_eq!(reason("UPDATE t SET a = 1"), "sql.not_select");
        assert_eq!(reason("SELECT 1 FROM dual; DROP TABLE t"), "sql.multiple_statements");
        assert_eq!(reason("SELECT * FROM t FOR UPDATE"), "sql.locking_clause");
        assert_eq!(reason("SELECT * FROM t@remote_db"), "sql.database_link");
        assert_eq!(reason("SELECT * FROM \"T\"@\"LINK\""), "sql.database_link");
        assert_eq!(reason("SELECT q'[x]' FROM dual"), "sql.quote_delimited_string");
        assert_eq!(reason("SELECT nq'{x}' FROM dual"), "sql.quote_delimited_string");
        assert_eq!(reason("SELECT * FROM t WHERE a = :1"), "sql.placeholder");
        assert_eq!(reason("SELECT * FROM t WHERE a = :name"), "sql.placeholder");
        for call in [
            "SELECT UTL_HTTP.REQUEST('http://169.254.169.254/') FROM dual",
            "SELECT sys.utl_http.request('http://x/') FROM dual",
            "SELECT HTTPURITYPE('http://x/').getclob() FROM dual",
            "SELECT DBMS_XMLGEN.GETXML('select * from secrets') FROM dual",
            "SELECT UTL_INADDR.GET_HOST_ADDRESS('x') FROM dual",
            "SELECT BFILENAME('DIR', 'f') FROM dual",
            "SELECT DBMS_PIPE.RECEIVE_MESSAGE('x', 10) FROM dual",
        ] {
            assert_eq!(reason(call), "sql.function_not_allowed", "{call}");
        }
        // Reads pass, Oracle's own syntax included.
        for read in [
            "SELECT * FROM t WHERE ROWNUM <= 10",
            "SELECT owner, COUNT(*) FROM all_tables GROUP BY owner ORDER BY 2 DESC FETCH FIRST 10 ROWS ONLY",
            "SELECT NVL(a, 0), TO_CHAR(SYSDATE, 'YYYY-MM-DD') FROM dual",
            "SELECT TO_CHAR(SUBSTR(doc, 1, 4000)) FROM docs",
            "WITH x AS (SELECT 1 AS n FROM dual) SELECT n FROM x",
            "SELECT /*+ INDEX(t) */ * FROM t -- Kommentar",
        ] {
            prepare(read).unwrap_or_else(|e| panic!("{read}: {e:?}"));
        }
    }

    #[test]
    fn identifier_variables_never_carry_double_quotes() {
        let names: std::collections::BTreeSet<String> = ["EVENTS", "A\"B"].iter().map(|s| s.to_string()).collect();
        for (value, ok) in [("EVENTS", true), ("A\"B", false)] {
            let vars = BTreeMap::from([("t".to_string(), json!(value))]);
            let ctx = sql::Context {
                range: TimeRange { from: 0, to: 1 },
                interval_ms: 1000,
                variables: &vars,
                identifiers: Some(&names),
                identifier_variables: None,
            };
            let p = sql::prepare("SELECT * FROM ${t:identifier}", Engine::Oracle, &ctx);
            match ok {
                true => assert_eq!(p.unwrap().sql, "SELECT * FROM \"EVENTS\""),
                false => assert_eq!(p.unwrap_err().reason, "sql.identifier_characters"),
            }
        }
    }

    fn column(oracle_type: OracleType, precision: i16, scale: i16) -> ColumnInfo {
        let mut c = ColumnInfo::new("C", oracle_type);
        c.precision = precision;
        c.scale = scale;
        c
    }

    #[test]
    fn values_keep_their_exactness_and_times_are_utc() {
        assert_eq!(field_type(&column(OracleType::Number, 10, 0)), FieldType::Number);
        assert_eq!(field_type(&column(OracleType::Number, 0, -127)), FieldType::Decimal);
        assert_eq!(field_type(&column(OracleType::Number, 12, 2)), FieldType::Decimal);
        assert_eq!(field_type(&column(OracleType::TimestampTz, 0, 0)), FieldType::Time);
        let mut n = Notes::default();
        let num = OraValue::Number(oracle_rs::types::OracleNumber::new("12345678901234567890.25"));
        assert_eq!(convert(&num, FieldType::Decimal, &mut n), json!("12345678901234567890.25"));
        assert_eq!(convert(&OraValue::Integer(7), FieldType::Number, &mut n), json!(7));
        assert_eq!(convert(&OraValue::Integer(7), FieldType::Decimal, &mut n), json!("7"));
        let date = OraValue::Date(oracle_rs::types::OracleDate::new(2027, 1, 15, 8, 0, 0));
        assert_eq!(convert(&date, FieldType::Time, &mut n), json!(1_800_000_000_000_i64));
        let ts =
            OraValue::Timestamp(oracle_rs::types::OracleTimestamp::with_timezone(2027, 1, 15, 10, 0, 0, 500_000, 2, 0));
        assert_eq!(convert(&ts, FieldType::Time, &mut n), json!(1_800_000_000_500_i64));
        assert_eq!(convert(&OraValue::Bytes(vec![0xff]), FieldType::String, &mut n), Value::Null);
        assert!(n.binary);
    }

    #[test]
    fn oracle_errors_are_named_by_their_number() {
        let e = failed(oracle_rs::Error::OracleError { code: 1017, message: "invalid credential".into() });
        assert_eq!(e.detail().reason, "source.auth_failed");
        let e = failed(oracle_rs::Error::OracleError {
            code: 1456,
            message: "may not perform insert/delete/update operation inside a READ ONLY transaction".into(),
        });
        assert_eq!((e.code(), e.detail().reason), ("query_rejected", "query.write_refused"));
        let e = failed(oracle_rs::Error::OracleError { code: 942, message: "table or view does not exist".into() });
        assert_eq!(e.detail().reason, "oracle.error");
        assert_eq!(e.detail().params["code"], "ORA-00942");
        let e = failed(oracle_rs::Error::ConnectionRedirect("x".into()));
        assert_eq!(e.detail().reason, "oracle.redirect_refused");
    }

    #[test]
    fn settings_are_checked() {
        let base = json!({ "host": "db.intern", "serviceName": "FREEPDB1", "user": "leser" });
        assert!(Oracle.check_settings(&base).is_ok());
        let mut bad = base.clone();
        bad["serviceName"] = json!("(DESCRIPTION=(ADDRESS=(HOST=evil)))");
        assert_eq!(Oracle.check_settings(&bad).unwrap_err().field, "serviceName");
        let mut bad = base.clone();
        bad["host"] = json!("db.intern:1521");
        assert_eq!(Oracle.check_settings(&bad).unwrap_err().field, "host");
    }

    /// Against a real Oracle (`KALZIT_TEST_ORACLE_URL`, as in tests/datasources_more.rs): a
    /// write sent past the statement check is refused by the read-only transaction itself.
    #[tokio::test]
    async fn the_read_only_transaction_refuses_writes_the_check_did_not_see() {
        let Ok(url) = std::env::var("KALZIT_TEST_ORACLE_URL") else {
            eprintln!("KALZIT_TEST_ORACLE_URL not set, test not run");
            return;
        };
        let u = reqwest::Url::parse(&url).unwrap();
        let settings = json!({
            "host": u.host_str().unwrap(),
            "port": u.port().unwrap_or(1521),
            "serviceName": u.path().trim_start_matches('/'),
            "user": u.username(),
        });
        let password = u.password().unwrap_or("").to_string();
        let policy = super::super::targets::TargetPolicy::new(
            &std::env::temp_dir().join("kalzit-none"),
            "sqlite::memory:",
            &[],
            &[],
        );
        let conn =
            super::super::json_documents::test_connection(settings, &[("password", password.as_str())], policy).await;
        let c = open(&conn).await.unwrap();
        let _ = c.conn.execute("CREATE TABLE kalzit_ro_probe (n NUMBER)", &[]).await;
        c.conn.execute("SET TRANSACTION READ ONLY", &[]).await.unwrap();
        let e = c.conn.execute("INSERT INTO kalzit_ro_probe VALUES (1)", &[]).await.map_err(failed).unwrap_err();
        assert_eq!(e.detail().reason, "query.write_refused", "{e:?}");
        c.conn.rollback().await.unwrap();
        let _ = c.conn.execute("DROP TABLE kalzit_ro_probe", &[]).await;
    }
}
