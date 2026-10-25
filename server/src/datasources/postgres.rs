//! PostgreSQL (and TimescaleDB): one read-only transaction per query, rolled back afterwards,
//! with a server-side statement timeout. A source that turns out to be Kalzit's own database
//! (same system identifier and database) is refused after connecting.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::postgres::types::PgInterval;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column as _, Connection as _, Executor, Row, SqlSafeStr, Statement, TypeInfo, ValueRef};

use super::Detail;
use super::frame::{Column, FrameBuilder};
use super::sql::{self, Bind, Engine};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema, Table, TableColumn,
};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("host", "datasources.settings.host", SettingType::String).target().required(),
    SettingField::new("port", "datasources.settings.port", SettingType::Number)
        .target()
        .default(DefaultValue::Number(5432)),
    SettingField::new("database", "datasources.settings.database", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target().required(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("sslMode", "datasources.settings.sslMode", SettingType::Select)
        .target()
        .options(&["disable", "prefer", "require", "verify-ca", "verify-full"])
        .default(DefaultValue::Text("prefer")),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
const POOL_SIZE: u32 = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Columns listed in the schema.
const MAX_SCHEMA_COLUMNS: i64 = 20_000;
/// Rows read from the query's cursor per round trip.
const FETCH_BATCH: usize = 1000;
/// The cursor a query is read through; closed with the transaction it lives in.
const CURSOR: &str = "kalzit_rows";

pub fn kind() -> Kind {
    Kind {
        name: "PostgreSQL",
        hint_key: "datasources.kinds.postgres.hint",
        settings: SETTINGS,
        plugin: Arc::new(Postgres),
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

fn ssl_mode(s: Option<&str>) -> PgSslMode {
    match s {
        Some("disable") => PgSslMode::Disable,
        Some("require") => PgSslMode::Require,
        Some("verify-ca") => PgSslMode::VerifyCa,
        Some("verify-full") => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}

/// The marker error of a connection that reached Kalzit's own database.
#[derive(Debug, thiserror::Error)]
#[error("Kalzit's own database cannot be a data source")]
struct OwnDatabase;

#[derive(Debug, thiserror::Error)]
#[error("cannot verify that the target is not Kalzit's own database: {0}")]
struct IdentityUnknown(String);

pub struct Postgres;

const IDENTITY_SQL: &str =
    "SELECT CAST(system_identifier AS TEXT), CAST(current_database() AS TEXT) FROM pg_control_system()";

async fn pool(conn: &Connection) -> Result<Arc<PgPool>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let port = s.port.unwrap_or(5432) as u16;
        let mode = ssl_mode(s.ssl_mode.as_deref());
        let addr = conn.policy().pick_address(&s.host, port, CONNECT_TIMEOUT).await?;
        // The driver connects to the checked address. With verify-full it must connect by name,
        // because the driver checks the certificate against the host it connects to and has no
        // separate TLS name. It then resolves the name itself for every new connection, so
        // after_connect resolves and checks the name again; a rebound address could only reach a
        // server holding a valid certificate for that name anyway.
        let host = if matches!(mode, PgSslMode::VerifyFull) { s.host.clone() } else { addr.ip().to_string() };
        let mut options = PgConnectOptions::new_without_pgpass()
            .host(&host)
            .port(addr.port())
            .username(&s.user)
            .database(&s.database)
            .ssl_mode(mode)
            .application_name("Kalzit");
        if let Some(password) = conn.secret("password") {
            options = options.password(password);
        }
        if let Some(pem) = s.ca_cert.filter(|p| !p.trim().is_empty()) {
            options = options.ssl_root_cert_from_pem(pem.into_bytes());
        }
        let own = conn.own_database().postgres_identity().await?;
        let recheck = matches!(mode, PgSslMode::VerifyFull).then(|| (conn.policy_arc(), s.host.clone(), port));
        // One connection outside the pool first: a pool whose connections are all refused only
        // reports a timeout, which would hide why (Kalzit's own database).
        if let Some(own) = &own {
            let mut probe = sqlx::PgConnection::connect_with(&options).await.map_err(failed)?;
            let checked = check_identity(&mut probe, own).await;
            let _ = sqlx::Connection::close(probe).await;
            checked.map_err(failed)?;
        }
        PgPoolOptions::new()
            .max_connections(POOL_SIZE)
            .min_connections(0)
            .acquire_timeout(CONNECT_TIMEOUT)
            .idle_timeout(Duration::from_secs(300))
            .after_connect(move |c, _| {
                let own = own.clone();
                let recheck = recheck.clone();
                Box::pin(async move {
                    if let Some((policy, host, port)) = recheck {
                        super::recheck_name(&policy, &host, port).await?;
                    }
                    // Every new connection is checked, not only the first: the pool reconnects.
                    match own {
                        Some(own) => check_identity(c, &own).await,
                        None => Ok(()),
                    }
                })
            })
            .connect_with(options)
            .await
            .map_err(failed)
    })
    .await
}

/// Refuses a connection to Kalzit's own database (`own` is its system identifier and name).
async fn check_identity(c: &mut sqlx::PgConnection, own: &(String, String)) -> Result<(), sqlx::Error> {
    let identity: (String, String) = sqlx::query_as(IDENTITY_SQL)
        .fetch_one(&mut *c)
        .await
        .map_err(|e| sqlx::Error::Configuration(Box::new(IdentityUnknown(e.to_string()))))?;
    if identity == *own {
        return Err(sqlx::Error::Configuration(Box::new(OwnDatabase)));
    }
    Ok(())
}

fn failed(e: sqlx::Error) -> SourceError {
    match e {
        sqlx::Error::Configuration(inner) if inner.is::<OwnDatabase>() || inner.is::<super::targets::Blocked>() => {
            SourceError::Blocked(super::blocked_detail(inner.as_ref()))
        }
        sqlx::Error::Configuration(inner) if inner.is::<IdentityUnknown>() => {
            SourceError::failed("target.own_database_unverifiable", inner.to_string())
        }
        sqlx::Error::Database(db) => {
            if db.code().as_deref() == Some("57014") {
                SourceError::failed("query.statement_timeout", "the query was cancelled by the statement timeout")
            } else if db.code().as_deref() == Some("25006") {
                SourceError::rejected("query.write_refused", format!("the query tried to write: {}", db.message()))
                    .with("detail", db.message())
            } else {
                SourceError::from_source(db.message())
            }
        }
        other => SourceError::from_source(other.to_string()),
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for Postgres {
    fn kind(&self) -> &'static str {
        "postgres"
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
            let mut c = pool.acquire().await.map_err(failed)?;
            #[expect(clippy::disallowed_methods, reason = "user database, read-only transaction")]
            let mut tx = c.begin_with("BEGIN READ ONLY").await.map_err(failed)?;
            let (version, superuser): (String, bool) = sqlx::query_as(
                "SELECT current_setting('server_version'), COALESCE((SELECT rolsuper FROM pg_roles \
                 WHERE rolname = current_user), false)",
            )
            .fetch_one(&mut *tx)
            .await
            .map_err(failed)?;
            tx.rollback().await.map_err(failed)?;
            Ok::<_, SourceError>((version, superuser))
        };
        match check.await {
            Ok((version, admin)) => Health::connected("PostgreSQL", &version, admin),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let mut c = pool.acquire().await.map_err(failed)?;
        #[expect(clippy::disallowed_methods, reason = "user database, read-only transaction")]
        let mut tx = c.begin_with("BEGIN READ ONLY").await.map_err(failed)?;
        let rows: Vec<(String, String, String, String)> = sqlx::query_as(
            "SELECT CAST(table_schema AS TEXT), CAST(table_name AS TEXT), CAST(column_name AS TEXT), \
             CAST(data_type AS TEXT) FROM information_schema.columns \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             ORDER BY table_schema, table_name, ordinal_position LIMIT $1",
        )
        .bind(MAX_SCHEMA_COLUMNS)
        .fetch_all(&mut *tx)
        .await
        .map_err(failed)?;
        tx.rollback().await.map_err(failed)?;
        Ok(SourceSchema::Tables { tables: group_columns(rows) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::Postgres).await?;
        let pool = pool(conn).await?;
        let mut c = pool.acquire().await.map_err(failed)?;
        #[expect(clippy::disallowed_methods, reason = "user database, read-only transaction")]
        let mut tx = c.begin_with("BEGIN READ ONLY").await.map_err(failed)?;
        // The server stops the statement itself, also when this request is dropped mid-query.
        let deadline = Instant::now() + req.limits.timeout;
        let timeout_ms = req.limits.timeout.as_millis().max(1);
        (&mut *tx)
            .execute(sqlx::AssertSqlSafe(format!("SET LOCAL statement_timeout = {timeout_ms}")))
            .await
            .map_err(failed)?;
        // Timestamps without a zone are read as UTC, like the macros' values.
        (&mut *tx).execute("SET LOCAL TimeZone = 'UTC'").await.map_err(failed)?;
        // The statement checker reads backslashes in '...' literally, as the SQL standard does.
        (&mut *tx).execute("SET LOCAL standard_conforming_strings = on").await.map_err(failed)?;
        // The query is read through a cursor; planned for all its rows, as the plain statement
        // would be, not for the first tenth (the default for cursors).
        (&mut *tx).execute("SET LOCAL cursor_tuple_fraction = 1.0").await.map_err(failed)?;
        let statement =
            (&mut *tx).prepare(sqlx::AssertSqlSafe(prepared.sql.clone()).into_sql_str()).await.map_err(failed)?;
        let decoders: Vec<Decoder> =
            statement.columns().iter().map(|c| Decoder::for_type(c.type_info().name())).collect();
        let columns = statement
            .columns()
            .iter()
            .zip(&decoders)
            .map(|(c, d)| Column::new(c.name(), Some(d.field_type())))
            .collect();
        let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
        frame.executed_query(prepared.sql.clone());
        for (col, d) in statement.columns().iter().zip(&decoders) {
            if matches!(d, Decoder::Unsupported) {
                let message = format!(
                    "{} has the type {}, which is not shown; cast it to text in the query",
                    col.name(),
                    col.type_info().name()
                );
                let detail = Detail::new("frame.type_unsupported", message)
                    .with("column", col.name())
                    .with("type", col.type_info().name());
                frame.notice(NoticeSeverity::Warning, detail);
            }
        }
        // The query runs as a cursor and is read in batches of at most the row limit plus one
        // (the row that shows the cut): a query with more rows stops on the server instead of
        // sending all of them, and the rollback closes the cursor. Prepared, so the server infers
        // the parameter types exactly as for the query itself.
        let declare = (&mut *tx)
            .prepare(
                sqlx::AssertSqlSafe(format!("DECLARE {CURSOR} NO SCROLL CURSOR FOR {}", prepared.sql)).into_sql_str(),
            )
            .await
            .map_err(failed)?;
        let mut query = declare.query();
        for bind in prepared.binds {
            query = match bind {
                Bind::Null => query.bind(None::<String>),
                Bind::Bool(b) => query.bind(b),
                Bind::Int(i) => query.bind(i),
                Bind::Float(f) => query.bind(f),
                Bind::Text(t) => query.bind(t),
                Bind::Time(ms) => query.bind(super::bind_time(ms)?),
                Bind::Interval(ms) => {
                    query.bind(PgInterval { months: 0, days: 0, microseconds: ms.saturating_mul(1000) })
                }
            };
        }
        query.execute(&mut *tx).await.map_err(failed)?;
        // MONEY travels as a count of the smallest unit; how many fraction digits that has
        // depends on the server's `lc_monetary`, so it is asked, never assumed.
        let money_scale = if decoders.iter().any(|d| matches!(d, Decoder::Money)) {
            let (scale,): (i32,) =
                sqlx::query_as("SELECT scale(1::money::numeric)").fetch_one(&mut *tx).await.map_err(failed)?;
            u32::try_from(scale).unwrap_or(0).min(18)
        } else {
            0
        };
        let batch = req.limits.max_rows.saturating_add(1).min(FETCH_BATCH);
        // Not cached: FETCH describes the rows of whichever cursor is open when it is prepared.
        let fetch = format!("FETCH FORWARD {batch} FROM {CURSOR}");
        'read: loop {
            // Each FETCH is a statement of its own: it may only take the time the query has left,
            // so a cut-off request never keeps the server working for longer than the timeout.
            let left = deadline.saturating_duration_since(Instant::now()).as_millis();
            if left == 0 {
                return Err(SourceError::failed(
                    "query.statement_timeout",
                    "the query was cancelled by the statement timeout",
                ));
            }
            (&mut *tx)
                .execute(sqlx::AssertSqlSafe(format!("SET LOCAL statement_timeout = {left}")))
                .await
                .map_err(failed)?;
            let mut rows = sqlx::query(sqlx::AssertSqlSafe(fetch.clone())).persistent(false).fetch(&mut *tx);
            let mut read = 0;
            while let Some(row) = rows.try_next().await.map_err(failed)? {
                read += 1;
                let values = decoders.iter().enumerate().map(|(i, d)| d.decode(&row, i, money_scale)).collect();
                if !frame.push_row(values) {
                    break 'read;
                }
            }
            if read < batch {
                break;
            }
        }
        tx.rollback().await.map_err(failed)?;
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// `(schema, table, column, type)` rows, ordered by table, as tables.
pub fn group_columns(rows: Vec<(String, String, String, String)>) -> Vec<Table> {
    let mut tables: Vec<Table> = Vec::new();
    for (schema, table, column, data_type) in rows {
        let same = tables.last().is_some_and(|t| t.name == table && t.schema.as_deref() == Some(&schema));
        if !same {
            tables.push(Table { schema: Some(schema), name: table, columns: Vec::new() });
        }
        if let Some(t) = tables.last_mut() {
            t.columns.push(TableColumn { name: column, data_type });
        }
    }
    tables
}

/// How one column is read, decided once from its type.
#[derive(Clone, Copy, Debug)]
enum Decoder {
    Bool,
    Int2,
    Int4,
    Int8,
    Oid,
    Float4,
    Float8,
    Numeric,
    Money,
    Text,
    Uuid,
    TimestampTz,
    Timestamp,
    Date,
    Time,
    Interval,
    Json,
    Unsupported,
}

impl Decoder {
    fn for_type(name: &str) -> Self {
        match name {
            "BOOL" => Self::Bool,
            "INT2" => Self::Int2,
            "INT4" => Self::Int4,
            "INT8" => Self::Int8,
            "OID" => Self::Oid,
            "FLOAT4" => Self::Float4,
            "FLOAT8" => Self::Float8,
            "NUMERIC" => Self::Numeric,
            "MONEY" => Self::Money,
            "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "UNKNOWN" | "citext" => Self::Text,
            "UUID" => Self::Uuid,
            "TIMESTAMPTZ" => Self::TimestampTz,
            "TIMESTAMP" => Self::Timestamp,
            "DATE" => Self::Date,
            "TIME" => Self::Time,
            "INTERVAL" => Self::Interval,
            "JSON" | "JSONB" => Self::Json,
            _ => Self::Unsupported,
        }
    }

    fn field_type(self) -> FieldType {
        match self {
            Self::Bool => FieldType::Bool,
            Self::Int2 | Self::Int4 | Self::Oid | Self::Float4 | Self::Float8 => FieldType::Number,
            Self::Numeric | Self::Money => FieldType::Decimal,
            Self::Int8 => FieldType::Int64,
            Self::Text | Self::Uuid | Self::Time | Self::Interval | Self::Unsupported => FieldType::String,
            Self::TimestampTz | Self::Timestamp => FieldType::Time,
            Self::Date => FieldType::Date,
            Self::Json => FieldType::Json,
        }
    }

    /// One cell; `money_scale` is the fraction digits of the server's MONEY.
    fn decode(self, row: &PgRow, i: usize, money_scale: u32) -> Value {
        if row.try_get_raw(i).map_or(true, |v| v.is_null()) {
            return Value::Null;
        }
        let v = match self {
            Self::Bool => row.try_get::<bool, _>(i).map(|b| json!(b)),
            Self::Int2 => row.try_get::<i16, _>(i).map(|n| json!(n)),
            Self::Int4 => row.try_get::<i32, _>(i).map(|n| json!(n)),
            Self::Int8 => row.try_get::<i64, _>(i).map(|n| json!(n.to_string())),
            Self::Oid => row.try_get::<sqlx::postgres::types::Oid, _>(i).map(|o| json!(o.0)),
            Self::Float4 => row.try_get::<f32, _>(i).map(|f| finite(f64::from(f))),
            Self::Float8 => row.try_get::<f64, _>(i).map(finite),
            Self::Numeric => {
                return row
                    .try_get_raw(i)
                    .ok()
                    .and_then(|raw| raw.as_bytes().ok().and_then(numeric_text))
                    .map_or(Value::Null, Value::String);
            }
            Self::Money => {
                return row
                    .try_get_raw(i)
                    .ok()
                    .and_then(|raw| raw.as_bytes().ok().and_then(|b| money_text(b, money_scale)))
                    .map_or(Value::Null, Value::String);
            }
            Self::Text => row.try_get::<String, _>(i).map(|s| json!(s)),
            Self::Uuid => {
                let raw = row.try_get_raw(i).ok().and_then(|r| r.as_bytes().ok().map(<[u8]>::to_vec));
                return raw.and_then(|b| uuid::Uuid::from_slice(&b).ok()).map_or(Value::Null, |u| json!(u.to_string()));
            }
            Self::TimestampTz => {
                row.try_get::<chrono::DateTime<chrono::Utc>, _>(i).map(|t| json!(t.timestamp_millis()))
            }
            Self::Timestamp => row.try_get::<chrono::NaiveDateTime, _>(i).map(|t| json!(super::naive_to_ms(t))),
            Self::Date => row
                .try_get::<chrono::NaiveDate, _>(i)
                .map(|d| d.and_hms_opt(0, 0, 0).map_or(Value::Null, |t| json!(super::naive_to_ms(t)))),
            Self::Time => row.try_get::<chrono::NaiveTime, _>(i).map(|t| json!(t.to_string())),
            Self::Interval => row.try_get::<PgInterval, _>(i).map(|iv| json!(format_interval(&iv))),
            Self::Json => row.try_get::<Value, _>(i),
            Self::Unsupported => return Value::Null,
        };
        v.unwrap_or(Value::Null)
    }
}

fn finite(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// ISO 8601, like `P1M2DT3.5S`.
fn format_interval(iv: &PgInterval) -> String {
    let seconds = iv.microseconds as f64 / 1_000_000.0;
    format!("P{}M{}DT{}S", iv.months, iv.days, seconds)
}

/// PostgreSQL's binary NUMERIC as exact decimal text with its scale ("-12.50"): digit count,
/// weight, sign and display scale, then base-10000 digits. NaN and infinities have no decimal
/// form and are empty.
fn numeric_text(bytes: &[u8]) -> Option<String> {
    let word = |i: usize| bytes.get(i..i + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let ndigits = usize::from(word(0)?);
    let weight = i64::from(word(2)? as i16);
    let negative = match word(4)? {
        0x0000 => false,
        0x4000 => true,
        _ => return None,
    };
    let scale = usize::from(word(6)?);
    let digits: Vec<u16> = (0..ndigits).map(|k| word(8 + 2 * k)).collect::<Option<_>>()?;
    if digits.iter().any(|d| *d > 9999) || scale > 16_383 {
        return None;
    }
    // The base-10000 digit at a weight (10000^weight); zero outside the stored digits.
    let at = |w: i64| usize::try_from(weight - w).ok().and_then(|k| digits.get(k)).copied().unwrap_or(0);
    let mut out = String::new();
    if weight < 0 {
        out.push('0');
    } else {
        out.push_str(&at(weight).to_string());
        for w in (0..weight).rev() {
            out.push_str(&format!("{:04}", at(w)));
        }
    }
    if scale > 0 {
        let mut fraction = String::new();
        for g in 1..=scale.div_ceil(4) as i64 {
            fraction.push_str(&format!("{:04}", at(-g)));
        }
        fraction.truncate(scale);
        out.push('.');
        out.push_str(&fraction);
    }
    let zero = out.bytes().all(|b| b == b'0' || b == b'.');
    Some(if negative && !zero { format!("-{out}") } else { out })
}

/// PostgreSQL's binary MONEY: a 64-bit count of the smallest unit, with `scale` fraction digits
/// (the server's `lc_monetary`: 2 for euros and dollars, 0 for yen), as decimal text such as
/// "-1234.56".
fn money_text(bytes: &[u8], scale: u32) -> Option<String> {
    let units = i64::from_be_bytes(bytes.try_into().ok()?);
    let sign = if units < 0 { "-" } else { "" };
    let abs = units.unsigned_abs();
    if scale == 0 {
        return Some(format!("{sign}{abs}"));
    }
    let unit = 10_u64.pow(scale);
    Some(format!("{sign}{}.{:0width$}", abs / unit, abs % unit, width = scale as usize))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// NUMERIC bytes: digit count, weight, sign, scale and the base-10000 digits.
    fn numeric(weight: i16, negative: bool, scale: u16, digits: &[u16]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend((digits.len() as u16).to_be_bytes());
        out.extend(weight.to_be_bytes());
        out.extend(if negative { 0x4000_u16 } else { 0 }.to_be_bytes());
        out.extend(scale.to_be_bytes());
        for d in digits {
            out.extend(d.to_be_bytes());
        }
        out
    }

    #[test]
    fn numeric_binary_format_is_exact_text() {
        assert_eq!(numeric_text(&numeric(1, false, 3, &[1, 2345, 6780])).as_deref(), Some("12345.678"));
        assert_eq!(numeric_text(&numeric(-1, true, 2, &[500])).as_deref(), Some("-0.05"));
        // The scale keeps trailing zeros: 12.50 stays 12.50.
        assert_eq!(numeric_text(&numeric(0, false, 2, &[12, 5000])).as_deref(), Some("12.50"));
        // Whole numbers with zeros the digits leave out: 1 0000 0000 = 10^8.
        assert_eq!(numeric_text(&numeric(2, false, 0, &[1])).as_deref(), Some("100000000"));
        // Digits a float rounds: 0.1 + 0.2 and the largest exact decimals stay as they are.
        assert_eq!(numeric_text(&numeric(-1, false, 1, &[1000])).as_deref(), Some("0.1"));
        assert_eq!(
            numeric_text(&numeric(4, false, 4, &[1, 2345, 6789, 123, 4567, 8901])).as_deref(),
            Some("12345678901234567.8901")
        );
        // 0.0000 1200: the digit 1200 at the weight 10000^-2.
        assert_eq!(numeric_text(&numeric(-2, false, 6, &[1200])).as_deref(), Some("0.000012"));
        assert_eq!(numeric_text(&numeric(-2, false, 8, &[12])).as_deref(), Some("0.00000012"));
        assert_eq!(numeric_text(&numeric(0, false, 0, &[])).as_deref(), Some("0"));
        assert_eq!(numeric_text(&numeric(0, false, 3, &[])).as_deref(), Some("0.000"));
        assert_eq!(numeric_text(&numeric(0, true, 0, &[])).as_deref(), Some("0"), "no negative zero");
        // NaN, infinities, broken input.
        assert_eq!(numeric_text(&[0, 0, 0, 0, 0xC0, 0, 0, 0]), None);
        assert_eq!(numeric_text(&[0, 0, 0, 0, 0xD0, 0, 0, 0]), None);
        assert_eq!(numeric_text(&[0, 2]), None);
        assert_eq!(numeric_text(&numeric(0, false, 0, &[10_000])), None);
    }

    #[test]
    fn money_is_cents_as_decimal_text() {
        assert_eq!(money_text(&123_456_i64.to_be_bytes(), 2).as_deref(), Some("1234.56"));
        assert_eq!(money_text(&(-5_i64).to_be_bytes(), 2).as_deref(), Some("-0.05"));
        assert_eq!(money_text(&i64::MIN.to_be_bytes(), 2).as_deref(), Some("-92233720368547758.08"));
        // Yen have no fraction digits, a Bahraini dinar three.
        assert_eq!(money_text(&123_456_i64.to_be_bytes(), 0).as_deref(), Some("123456"));
        assert_eq!(money_text(&(-5_i64).to_be_bytes(), 3).as_deref(), Some("-0.005"));
        assert_eq!(money_text(&[0, 1], 2), None);
    }

    #[test]
    fn columns_group_into_tables() {
        let row = |s: &str, t: &str, c: &str| (s.to_string(), t.to_string(), c.to_string(), "text".to_string());
        let tables = group_columns(vec![row("public", "a", "x"), row("public", "a", "y"), row("verkauf", "a", "z")]);
        assert_eq!(tables.len(), 2);
        assert_eq!(tables[0].columns.len(), 2);
        assert_eq!(tables[1].schema.as_deref(), Some("verkauf"));
    }
}
