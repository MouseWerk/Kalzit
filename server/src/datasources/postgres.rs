//! PostgreSQL (and TimescaleDB): one read-only transaction per query, rolled back afterwards,
//! with a server-side statement timeout. A source that turns out to be Kalzit's own database
//! (same system identifier and database) is refused after connecting.

use std::sync::Arc;
use std::time::Duration;

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
        let mut tx = c.begin_with("BEGIN READ ONLY").await.map_err(failed)?;
        // The server stops the statement itself, also when this request is dropped mid-query.
        let timeout_ms = req.limits.timeout.as_millis().max(1);
        (&mut *tx)
            .execute(sqlx::AssertSqlSafe(format!("SET LOCAL statement_timeout = {timeout_ms}")))
            .await
            .map_err(failed)?;
        // Timestamps without a zone are read as UTC, like the macros' values.
        (&mut *tx).execute("SET LOCAL TimeZone = 'UTC'").await.map_err(failed)?;
        // The statement checker reads backslashes in '...' literally, as the SQL standard does.
        (&mut *tx).execute("SET LOCAL standard_conforming_strings = on").await.map_err(failed)?;
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
        let mut query = statement.query();
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
        {
            let mut rows = query.fetch(&mut *tx);
            while let Some(row) = rows.try_next().await.map_err(failed)? {
                let values = decoders.iter().enumerate().map(|(i, d)| d.decode(&row, i)).collect();
                if !frame.push_row(values) {
                    break;
                }
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
            "NUMERIC" | "MONEY" if name == "NUMERIC" => Self::Numeric,
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
            Self::Int2 | Self::Int4 | Self::Oid | Self::Float4 | Self::Float8 | Self::Numeric => FieldType::Number,
            Self::Int8 => FieldType::Int64,
            Self::Text | Self::Uuid | Self::Time | Self::Interval | Self::Unsupported => FieldType::String,
            Self::TimestampTz | Self::Timestamp | Self::Date => FieldType::Time,
            Self::Json => FieldType::Json,
        }
    }

    fn decode(self, row: &PgRow, i: usize) -> Value {
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
                    .and_then(|raw| raw.as_bytes().ok().and_then(numeric_to_f64))
                    .map_or(Value::Null, finite);
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

/// PostgreSQL's binary NUMERIC: digit count, weight, sign, scale, then base-10000 digits. Read
/// into a float, which is what a chart needs; NaN and infinities have no JSON form.
fn numeric_to_f64(bytes: &[u8]) -> Option<f64> {
    let word = |i: usize| bytes.get(i..i + 2).map(|b| i16::from_be_bytes([b[0], b[1]]));
    let ndigits = word(0)? as usize;
    let weight = word(2)? as i32;
    let sign = word(4)? as u16;
    if sign == 0xC000 || sign == 0xD000 || sign == 0xF000 {
        return None;
    }
    let mut value = 0.0_f64;
    for k in 0..ndigits {
        let digit = f64::from(word(8 + 2 * k)?);
        value += digit * 10_000f64.powi(weight - k as i32);
    }
    Some(if sign == 0x4000 { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeric_binary_format() {
        // 12345.678 = digits [1, 2345, 6780], weight 1, positive, scale 3.
        let bytes = [0, 3, 0, 1, 0, 0, 0, 3, 0, 1, 0x09, 0x29, 0x1A, 0x7C];
        assert!((numeric_to_f64(&bytes).unwrap() - 12345.678).abs() < 1e-9);
        // -0.05 = digits [500], weight -1, negative.
        let bytes = [0, 1, 0xFF, 0xFF, 0x40, 0, 0, 2, 0x01, 0xF4];
        assert!((numeric_to_f64(&bytes).unwrap() + 0.05).abs() < 1e-12);
        assert_eq!(numeric_to_f64(&[0, 0, 0, 0, 0xC0, 0, 0, 0]), None);
        assert_eq!(numeric_to_f64(&[0, 0, 0, 0, 0, 0, 0, 0]), Some(0.0));
        assert_eq!(numeric_to_f64(&[0, 2]), None);
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
