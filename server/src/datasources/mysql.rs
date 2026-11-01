//! MySQL and MariaDB: one `START TRANSACTION READ ONLY` per query, rolled back afterwards, with a
//! server-side execution limit where the server has one. The driver never offers LOCAL INFILE,
//! so a hostile server cannot make Kalzit send local files (tested below with a fake server).

use std::sync::Arc;
use std::time::Duration;

use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column as _, Executor, Row, SqlSafeStr, Statement, TypeInfo, ValueRef};

use super::Detail;
use super::connect::{self, SqlPool};
use super::frame::{Column, FrameBuilder};
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
        .default(DefaultValue::Number(3306)),
    SettingField::new("database", "datasources.settings.database", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target().required(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("sslMode", "datasources.settings.sslMode", SettingType::Select)
        .target()
        .options(&["disabled", "preferred", "required", "verify_ca", "verify_identity"])
        .default(DefaultValue::Text("preferred")),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
const POOL_SIZE: u32 = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SCHEMA_COLUMNS: i64 = 20_000;

pub fn kind() -> Kind {
    Kind {
        name: "MySQL / MariaDB",
        hint_key: "datasources.kinds.mysql.hint",
        settings: SETTINGS,
        plugin: Arc::new(MySql),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    host: String,
    port: Option<u64>,
    database: String,
    user: String,
    ssl_mode: Option<String>,
    ca_cert: Option<String>,
}

fn ssl_mode(s: Option<&str>) -> MySqlSslMode {
    match s {
        Some("disabled") => MySqlSslMode::Disabled,
        Some("required") => MySqlSslMode::Required,
        Some("verify_ca") => MySqlSslMode::VerifyCa,
        Some("verify_identity") => MySqlSslMode::VerifyIdentity,
        _ => MySqlSslMode::Preferred,
    }
}

pub struct MySql;

async fn pool(conn: &Connection) -> Result<Arc<SqlPool<sqlx::MySql>>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let port = s.port.unwrap_or(3306) as u16;
        let mode = ssl_mode(s.ssl_mode.as_deref());
        let addr = conn.policy().pick_address(&s.host, port, CONNECT_TIMEOUT).await?;
        let address = connect::address(&s.host, port);
        // As for PostgreSQL: the checked address, except where the certificate must match the name.
        let host = if matches!(mode, MySqlSslMode::VerifyIdentity) { s.host.clone() } else { addr.ip().to_string() };
        let mut options = MySqlConnectOptions::new()
            .host(&host)
            .port(addr.port())
            .username(&s.user)
            .database(&s.database)
            .ssl_mode(mode)
            .charset("utf8mb4")
            // The session's sql_mode is set in after_connect, exactly; the driver must not add to it.
            .pipes_as_concat(false)
            .no_engine_substitution(false)
            // DATETIME values are read and the macros' times are bound as UTC.
            .timezone(Some("+00:00".to_string()));
        if let Some(password) = conn.secret("password") {
            options = options.password(password);
        }
        if let Some(pem) = s.ca_cert.filter(|p| !p.trim().is_empty()) {
            options = options.ssl_ca_from_pem(pem.into_bytes());
        }
        let recheck = matches!(mode, MySqlSslMode::VerifyIdentity).then(|| (conn.policy_arc(), s.host.clone(), port));
        // As for PostgreSQL: lazy, so connect failures are named by `SqlPool::acquire`, and tested
        // before use, so a connection that broke while idle is replaced; setup errors are kept.
        let setup = connect::SetupErrors::default();
        let kept = setup.clone();
        let probe_recheck = recheck.clone();
        let pool = MySqlPoolOptions::new()
            .max_connections(POOL_SIZE)
            .min_connections(0)
            .acquire_timeout(CONNECT_TIMEOUT)
            .test_before_acquire(true)
            .idle_timeout(Duration::from_secs(300))
            .after_connect(move |c, _| {
                let recheck = recheck.clone();
                let kept = kept.clone();
                Box::pin(async move {
                    let step = async {
                        if let Some((policy, host, port)) = recheck {
                            super::recheck_name(&policy, &host, port).await?;
                        }
                        pin_sql_mode(c).await
                    };
                    kept.keep(step.await, failed)
                })
            })
            .connect_lazy_with(options);
        let pool = SqlPool::new(pool, addr, address, CONNECT_TIMEOUT, setup, probe_recheck);
        drop(pool.acquire(failed).await?);
        Ok(pool)
    })
    .await
}

fn failed(e: sqlx::Error) -> SourceError {
    match e {
        sqlx::Error::Configuration(inner) if inner.is::<super::targets::Blocked>() => {
            SourceError::Blocked(super::blocked_detail(inner.as_ref()))
        }
        // 1792 (SQLSTATE 25006): cannot execute statement in a READ ONLY transaction.
        sqlx::Error::Database(db)
            if db.code().as_deref() == Some("25006")
                || db.try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>().is_some_and(|e| e.number() == 1792) =>
        {
            SourceError::rejected("query.write_refused", format!("the query tried to write: {}", db.message()))
                .with("detail", db.message())
        }
        // 1045: access denied (wrong password or no such user); 1698: access denied without a
        // password (a login bound to the system user).
        sqlx::Error::Database(db)
            if db
                .try_downcast_ref::<sqlx::mysql::MySqlDatabaseError>()
                .is_some_and(|e| matches!(e.number(), 1045 | 1698)) =>
        {
            connect::auth_failed(db.message())
        }
        sqlx::Error::Database(db) => SourceError::from_source(db.message()),
        sqlx::Error::Io(io) if connect::is_dead(io.kind()) => connect::lost(io),
        other => SourceError::from_source(other.to_string()),
    }
}

/// The sql_mode the statement checker assumes: backslash escapes in strings and `"` as a string
/// quote. `ANSI_QUOTES` or `NO_BACKSLASH_ESCAPES` from the server's default would make the server
/// read the text differently from the checker, so every session gets exactly this mode.
pub const SQL_MODE: &str = "NO_ENGINE_SUBSTITUTION";

/// Sets `SQL_MODE` on a new connection and verifies it took effect.
async fn pin_sql_mode(c: &mut sqlx::MySqlConnection) -> Result<(), sqlx::Error> {
    c.execute(sqlx::AssertSqlSafe(format!("SET SESSION sql_mode = '{SQL_MODE}'"))).await?;
    let (mode,): (String,) = sqlx::query_as("SELECT CAST(@@SESSION.sql_mode AS CHAR)").fetch_one(&mut *c).await?;
    let mode = mode.to_ascii_uppercase();
    if mode.contains("ANSI_QUOTES") || mode.contains("NO_BACKSLASH_ESCAPES") || mode.contains("ANSI") {
        return Err(sqlx::Error::Configuration(format!("the server keeps sql_mode {mode}").into()));
    }
    Ok(())
}

/// Server-side limit for the statements of this session: `max_execution_time` (MySQL, ms) or
/// `max_statement_time` (MariaDB, seconds). Each server rejects the other's variable. A server
/// that takes neither is refused: a query it runs could not be stopped after the client gives up.
async fn limit_session(c: &mut sqlx::MySqlConnection, timeout: Duration) -> Result<(), SourceError> {
    let ms = timeout.as_millis().max(1);
    match c.execute(sqlx::AssertSqlSafe(format!("SET SESSION max_execution_time = {ms}"))).await {
        Ok(_) => return Ok(()),
        // A broken connection is not a server without the variable.
        Err(e) if connect::sqlx_dead(&e) => return Err(failed(e)),
        Err(_) => {}
    }
    let secs = timeout.as_secs_f64().max(0.001);
    match c.execute(sqlx::AssertSqlSafe(format!("SET SESSION max_statement_time = {secs}"))).await {
        Ok(_) => Ok(()),
        Err(e) if connect::sqlx_dead(&e) => Err(failed(e)),
        Err(_) => Err(SourceError::failed(
            "mysql.no_time_limit",
            "the server supports neither max_execution_time nor max_statement_time, so query times cannot be limited",
        )),
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for MySql {
    fn kind(&self) -> &'static str {
        "mysql"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        super::check_host("host", &s.host)?;
        super::check_port("port", s.port)?;
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let pool = pool(conn).await?;
            let mut c = pool.acquire(failed).await?;
            let (version,): (String,) = sqlx::query_as("SELECT VERSION()").fetch_one(&mut *c).await.map_err(failed)?;
            Ok::<_, SourceError>(version)
        };
        match check.await {
            Ok(version) if version.to_ascii_lowercase().contains("mariadb") => {
                Health::connected("MariaDB", &version, false)
            }
            Ok(version) => Health::connected("MySQL", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let mut c = pool.acquire(failed).await?;
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT CAST(TABLE_SCHEMA AS CHAR), CAST(TABLE_NAME AS CHAR), CAST(COLUMN_NAME AS CHAR), \
             CAST(DATA_TYPE AS CHAR) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() \
             ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT ?",
        )
        .bind(MAX_SCHEMA_COLUMNS)
        .fetch_all(&mut *c)
        .await
        .map_err(failed)?;
        Ok(SourceSchema::Tables { tables: super::postgres::group_columns(rows) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::MySql).await?;
        let pool = pool(conn).await?;
        let mut c = pool.acquire(failed).await?;
        // The first round trip: a connection that broke after its check fails here, before any
        // result, and the query runs once more on a fresh connection (it only reads).
        match limit_session(&mut c, req.limits.timeout).await {
            Err(e) if connect::is_lost(&e) => {
                // Closed before the next is taken, so dead connections never hold the pool's slots.
                c.close_on_drop();
                drop(c);
                c = pool.acquire(failed).await?;
                limit_session(&mut c, req.limits.timeout).await?;
            }
            other => other?,
        }
        #[expect(clippy::disallowed_methods, reason = "user database, read-only transaction")]
        let mut tx = sqlx::Connection::begin_with(&mut *c, "START TRANSACTION READ ONLY").await.map_err(failed)?;
        let statement =
            (&mut *tx).prepare(sqlx::AssertSqlSafe(prepared.sql.clone()).into_sql_str()).await.map_err(failed)?;
        // The types known when preparing; MariaDB reports parameters in the select list only
        // with the result, so the first row's column types replace these.
        let mut decoders: Vec<Decoder> =
            statement.columns().iter().map(|c| Decoder::for_type(c.type_info().name())).collect();
        let mut type_names: Vec<String> =
            statement.columns().iter().map(|c| c.type_info().name().to_string()).collect();
        let columns = statement
            .columns()
            .iter()
            .zip(&decoders)
            .map(|(c, d)| Column::new(c.name(), Some(d.field_type())))
            .collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
        frame.executed_query(prepared.sql.clone());
        let names: Vec<String> = statement.columns().iter().map(|c| c.name().to_string()).collect();
        let mut query = statement.query();
        for bind in prepared.binds {
            query = match bind {
                Bind::Null => query.bind(None::<String>),
                Bind::Bool(b) => query.bind(b),
                Bind::Int(i) => query.bind(i),
                Bind::Float(f) => query.bind(f),
                Bind::Text(t) => query.bind(t),
                Bind::Time(ms) => query.bind(super::bind_time(ms)?.naive_utc()),
                Bind::Interval(ms) => query.bind(sql::format_interval(ms)),
            };
        }
        let mut binary_notice = false;
        let mut stopped_early = false;
        {
            let mut rows = query.fetch(&mut *tx);
            let mut first = true;
            while let Some(row) = rows.try_next().await.map_err(failed)? {
                if first {
                    first = false;
                    decoders = row.columns().iter().map(|c| Decoder::for_type(c.type_info().name())).collect();
                    type_names = row.columns().iter().map(|c| c.type_info().name().to_string()).collect();
                    for (column, d) in frame.columns_mut().iter_mut().zip(&decoders) {
                        column.field_type = Some(d.field_type());
                    }
                }
                let values = decoders
                    .iter()
                    .enumerate()
                    .map(|(i, d)| {
                        let (value, unreadable) = d.decode(&row, i);
                        binary_notice |= unreadable;
                        value
                    })
                    .collect();
                if !frame.push_row(values) {
                    stopped_early = true;
                    break;
                }
            }
        }
        if binary_notice {
            frame.notice(
                NoticeSeverity::Warning,
                Detail::new("frame.binary_hidden", "binary values that are not text are shown empty"),
            );
        }
        for ((name, type_name), d) in names.iter().zip(&type_names).zip(&decoders) {
            if matches!(d, Decoder::Unsupported) {
                let message = format!("{name} has the type {type_name}, which is not shown; convert it in the query");
                let detail =
                    Detail::new("frame.type_unsupported", message).with("column", name).with("type", type_name);
                frame.notice(NoticeSeverity::Warning, detail);
            }
        }
        if stopped_early {
            // The rest of the result is still coming; a rollback would first read all of it.
            // Closing the connection makes the server stop the statement (its next write fails)
            // and roll the transaction back; the pool opens a new connection when needed.
            drop(tx);
            let _ = sqlx::Connection::close_hard(c.detach()).await;
        } else {
            tx.rollback().await.map_err(failed)?;
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

#[derive(Clone, Copy, Debug)]
enum Decoder {
    Bool,
    Int,
    BigInt,
    UnsignedBigInt,
    Unsigned,
    Year,
    Float,
    Double,
    Decimal,
    Text,
    Binary,
    DateTime,
    Date,
    Time,
    Json,
    Unsupported,
}

impl Decoder {
    fn for_type(name: &str) -> Self {
        match name {
            "BOOLEAN" => Self::Bool,
            "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" => Self::Int,
            "BIGINT" => Self::BigInt,
            "BIGINT UNSIGNED" => Self::UnsignedBigInt,
            "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED" => Self::Unsigned,
            "YEAR" => Self::Year,
            "FLOAT" => Self::Float,
            "DOUBLE" => Self::Double,
            "DECIMAL" => Self::Decimal,
            "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => Self::Text,
            "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" => Self::Binary,
            "DATETIME" | "TIMESTAMP" => Self::DateTime,
            "DATE" => Self::Date,
            "TIME" => Self::Time,
            "JSON" => Self::Json,
            _ => Self::Unsupported,
        }
    }

    fn field_type(self) -> FieldType {
        match self {
            Self::Bool => FieldType::Bool,
            Self::Int | Self::Unsigned | Self::Year | Self::Float | Self::Double => FieldType::Number,
            Self::Decimal => FieldType::Decimal,
            Self::BigInt | Self::UnsignedBigInt => FieldType::Int64,
            Self::Text | Self::Binary | Self::Time | Self::Unsupported => FieldType::String,
            Self::DateTime => FieldType::Time,
            Self::Date => FieldType::Date,
            Self::Json => FieldType::Json,
        }
    }

    /// The value, and whether it was binary data that could not be shown.
    fn decode(self, row: &MySqlRow, i: usize) -> (Value, bool) {
        if row.try_get_raw(i).map_or(true, |v| v.is_null()) {
            return (Value::Null, false);
        }
        let v = match self {
            Self::Bool => row.try_get::<bool, _>(i).map(|b| json!(b)),
            Self::Int => row.try_get::<i64, _>(i).map(|n| json!(n)),
            Self::Unsigned => row.try_get::<u64, _>(i).map(|n| json!(n)),
            Self::BigInt => row.try_get::<i64, _>(i).map(|n| json!(n.to_string())),
            Self::UnsignedBigInt => row.try_get::<u64, _>(i).map(|n| json!(n.to_string())),
            Self::Year => row.try_get_unchecked::<i64, _>(i).map(|n| json!(n)),
            Self::Float => row.try_get::<f32, _>(i).map(|f| finite(f64::from(f))),
            Self::Double => row.try_get::<f64, _>(i).map(finite),
            // DECIMAL travels as text in both protocols, every digit kept ("12.50").
            Self::Decimal => row.try_get_unchecked::<String, _>(i).map(|s| decimal_text(&s)),
            Self::Text => row.try_get_unchecked::<String, _>(i).map(|s| json!(s)),
            Self::Binary => {
                let text = row.try_get_unchecked::<Vec<u8>, _>(i).ok().and_then(|b| String::from_utf8(b).ok());
                return match text {
                    Some(t) => (json!(t), false),
                    None => (Value::Null, true),
                };
            }
            Self::DateTime => row.try_get::<chrono::NaiveDateTime, _>(i).map(|t| json!(super::naive_to_ms(t))),
            Self::Date => row
                .try_get::<chrono::NaiveDate, _>(i)
                .map(|d| d.and_hms_opt(0, 0, 0).map_or(Value::Null, |t| json!(super::naive_to_ms(t)))),
            Self::Time => row.try_get::<chrono::NaiveTime, _>(i).map(|t| json!(t.to_string())),
            Self::Json => row.try_get::<Value, _>(i),
            Self::Unsupported => return (Value::Null, false),
        };
        (v.unwrap_or(Value::Null), false)
    }
}

fn finite(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// A DECIMAL as the server wrote it, when it is a plain decimal (sign, digits, point).
fn decimal_text(s: &str) -> Value {
    let digits = s.strip_prefix('-').unwrap_or(s);
    let plain = !digits.is_empty()
        && digits.bytes().filter(|b| *b == b'.').count() <= 1
        && digits.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && digits.bytes().any(|b| b.is_ascii_digit());
    if plain { Value::String(s.to_string()) } else { Value::Null }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::datasources::targets::TargetPolicy;

    const CLIENT_LOCAL_FILES: u32 = 0x80;

    async fn write_packet(s: &mut tokio::net::TcpStream, seq: u8, payload: &[u8]) {
        let len = payload.len() as u32;
        let mut p = vec![len as u8, (len >> 8) as u8, (len >> 16) as u8, seq];
        p.extend_from_slice(payload);
        s.write_all(&p).await.unwrap();
    }

    async fn read_packet(s: &mut tokio::net::TcpStream) -> Option<Vec<u8>> {
        let mut head = [0u8; 4];
        s.read_exact(&mut head).await.ok()?;
        let len = head[0] as usize | (head[1] as usize) << 8 | (head[2] as usize) << 16;
        let mut body = vec![0u8; len];
        s.read_exact(&mut body).await.ok()?;
        Some(body)
    }

    /// A fake MySQL server that accepts any login and answers the first query with a LOCAL
    /// INFILE request for a file, the way a hostile server would. It reports the client's
    /// capability flags and every packet the client sent after the request.
    async fn hostile_server() -> (u16, tokio::task::JoinHandle<(u32, Vec<Vec<u8>>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                // Protocol 41, LOCAL_FILES, secure connection, plugin auth, connect with db, transactions.
                let caps: u32 = 0x0200 | 0x0080 | 0x8000 | 0x0008_0000 | 0x0008 | 0x2000;
                let mut hs = vec![10u8];
                hs.extend_from_slice(b"8.0.36-fake\0");
                hs.extend_from_slice(&7u32.to_le_bytes());
                hs.extend_from_slice(b"abcdefgh\0");
                hs.extend_from_slice(&(caps as u16).to_le_bytes());
                hs.push(45);
                hs.extend_from_slice(&2u16.to_le_bytes());
                hs.extend_from_slice(&((caps >> 16) as u16).to_le_bytes());
                hs.push(21);
                hs.extend_from_slice(&[0u8; 10]);
                hs.extend_from_slice(b"ijklmnopqrst\0");
                hs.extend_from_slice(b"mysql_native_password\0");
                write_packet(&mut s, 0, &hs).await;
                // A connection closed before answering is the address probe; wait for the next.
                let Some(response) = read_packet(&mut s).await else { continue };
                let client_caps = u32::from_le_bytes([response[0], response[1], response[2], response[3]]);
                write_packet(&mut s, 2, &[0, 0, 0, 2, 0, 0, 0]).await;
                let mut after = Vec::new();
                if read_packet(&mut s).await.is_some() {
                    let mut request = vec![0xFB];
                    request.extend_from_slice(b"/etc/passwd");
                    write_packet(&mut s, 1, &request).await;
                    while let Ok(Some(p)) = tokio::time::timeout(Duration::from_secs(2), read_packet(&mut s)).await {
                        after.push(p);
                    }
                }
                return (client_caps, after);
            }
        });
        (port, task)
    }

    #[tokio::test]
    async fn the_client_never_offers_or_answers_local_infile() {
        let (port, server) = hostile_server().await;
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let conn = Connection::new(
            "ds",
            json!({ "host": "127.0.0.1", "port": port, "database": "d", "user": "u", "sslMode": "disabled" }),
            BTreeMap::new(),
            Arc::new(policy),
            Arc::new(crate::datasources::OwnDatabase::new(db, "sqlite::memory:")),
        );
        assert!(pool(&conn).await.is_err(), "the fake server never completes a session");
        let (client_caps, after) = server.await.unwrap();
        assert_eq!(client_caps & CLIENT_LOCAL_FILES, 0, "the client must not offer LOCAL INFILE");
        // A client that honoured the request would answer with the file's content.
        assert!(after.iter().all(|p| p.first() == Some(&0x01) || p.is_empty()), "the client answered: {after:?}");
    }
}
