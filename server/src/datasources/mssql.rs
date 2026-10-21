//! Microsoft SQL Server (tiberius over TLS). SQL Server has no read-only transaction, so the
//! defence is a read-only login (`db_datareader` only, which the settings form asks for), the
//! statement check, and a transaction that is always rolled back.
//!
//! Kalzit opens the TCP connection itself, to the checked address; the configured host name is
//! kept for the TLS certificate check.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use tiberius::{AuthMethod, ColumnData, ColumnType, EncryptionLevel, FromSql, Query, QueryItem};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

use super::Detail;
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
        .default(DefaultValue::Number(1433)),
    SettingField::new("database", "datasources.settings.database", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target().required(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("encrypt", "datasources.settings.encrypt", SettingType::Bool)
        .target()
        .default(DefaultValue::Bool(true)),
    SettingField::new("trustServerCertificate", "datasources.settings.trustServerCertificate", SettingType::Bool)
        .target()
        .default(DefaultValue::Bool(false)),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SCHEMA_COLUMNS: i64 = 20_000;

pub fn kind() -> Kind {
    Kind {
        name: "Microsoft SQL Server",
        hint_key: "datasources.kinds.mssql.hint",
        settings: SETTINGS,
        plugin: Arc::new(MsSql),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    host: String,
    port: Option<u64>,
    database: String,
    user: String,
    encrypt: Option<bool>,
    trust_server_certificate: Option<bool>,
    ca_cert: Option<String>,
}

type Client = tiberius::Client<Compat<TcpStream>>;

/// tiberius has no pool: idle clients wait here (with the time they were returned), the
/// semaphore bounds the open ones.
struct Pool {
    idle: Mutex<Vec<(Client, Instant)>>,
    slots: Semaphore,
}

/// Idle clients older than this are closed instead of reused.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a dropped lease may take to cancel its query and close.
const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);

/// A client on loan; it goes back to the pool only through `release`, after a clean finish. A
/// client dropped mid-query (timeout, cancelled request) sends SQL Server an attention (cancel)
/// so the statement stops on the server, and is then closed.
struct Lease<'p> {
    pool: &'p Pool,
    client: Option<Client>,
    _permit: tokio::sync::SemaphorePermit<'p>,
}

impl Lease<'_> {
    fn client(&mut self) -> &mut Client {
        self.client.as_mut().expect("a lease holds its client until released")
    }

    fn release(mut self) {
        if let Some(c) = self.client.take() {
            self.pool.idle.lock().expect("pool lock").push((c, Instant::now()));
        }
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let Some(mut client) = self.client.take() else { return };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
        runtime.spawn(async move {
            let stop = async {
                let _ = client.cancel_query().await;
                let _ = client.close().await;
            };
            let _ = tokio::time::timeout(CANCEL_TIMEOUT, stop).await;
        });
    }
}

pub struct MsSql;

fn failed(e: tiberius::error::Error) -> SourceError {
    SourceError::from_source(e.to_string())
}

async fn pool(conn: &Connection) -> Result<Arc<Pool>, SourceError> {
    conn.shared(|| async { Ok(Pool { idle: Mutex::new(Vec::new()), slots: Semaphore::new(POOL_SIZE) }) }).await
}

async fn open(conn: &Connection) -> Result<Client, SourceError> {
    crate::http::ensure_crypto_provider();
    let s: Settings = conn.settings_as()?;
    let port = s.port.unwrap_or(1433) as u16;
    let (_, tcp) = conn.policy().connect(&s.host, port, CONNECT_TIMEOUT).await?;
    tcp.set_nodelay(true).map_err(|e| SourceError::from_source(e.to_string()))?;
    let mut config = tiberius::Config::new();
    config.host(&s.host);
    config.port(port);
    config.database(&s.database);
    config.application_name("Kalzit");
    config.authentication(AuthMethod::sql_server(&s.user, conn.secret("password").unwrap_or("")));
    config.encryption(if s.encrypt.unwrap_or(true) { EncryptionLevel::Required } else { EncryptionLevel::Off });
    if s.trust_server_certificate.unwrap_or(false) {
        config.trust_cert();
    } else if let Some(pem) = s.ca_cert.filter(|p| !p.trim().is_empty()) {
        config.trust_cert_ca_bundle(pem.into_bytes());
    }
    let client = tokio::time::timeout(CONNECT_TIMEOUT, tiberius::Client::connect(config, tcp.compat_write()))
        .await
        .map_err(|_| SourceError::failed("mssql.login_timeout", "SQL Server did not complete the login in time"))?
        .map_err(failed)?;
    Ok(client)
}

async fn lease<'p>(conn: &Connection, pool: &'p Pool) -> Result<Lease<'p>, SourceError> {
    let permit =
        pool.slots.acquire().await.map_err(|_| SourceError::failed("server.shutting_down", "the pool is closed"))?;
    let idle = {
        let mut idle = pool.idle.lock().expect("pool lock");
        // Closed by dropping; an idle client has no statement to cancel.
        idle.retain(|(_, since)| since.elapsed() < IDLE_TIMEOUT);
        idle.pop().map(|(c, _)| c)
    };
    let client = match idle {
        Some(c) => c,
        None => open(conn).await?,
    };
    Ok(Lease { pool, client: Some(client), _permit: permit })
}

async fn simple(client: &mut Client, sql: &'static str) -> Result<(), SourceError> {
    client.simple_query(sql).await.map_err(failed)?.into_results().await.map_err(failed)?;
    Ok(())
}

#[async_trait::async_trait]
impl DataSourcePlugin for MsSql {
    fn kind(&self) -> &'static str {
        "mssql"
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
            let mut lease = lease(conn, &pool).await?;
            let row = lease
                .client()
                .simple_query(
                    "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(128)), IS_SRVROLEMEMBER('sysadmin')",
                )
                .await
                .map_err(failed)?
                .into_row()
                .await
                .map_err(failed)?;
            lease.release();
            let row = row.ok_or_else(|| SourceError::failed("source.no_answer", "no answer"))?;
            let version: Option<&str> = row.get(0);
            let sysadmin: Option<i32> = row.get(1);
            Ok::<_, SourceError>((version.unwrap_or("").to_string(), sysadmin == Some(1)))
        };
        match check.await {
            Ok((version, admin)) => Health::connected("SQL Server", &version, admin),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let mut lease = lease(conn, &pool).await?;
        let mut q = Query::new(
            "SELECT TOP (@P1) TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS \
             ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
        );
        q.bind(MAX_SCHEMA_COLUMNS);
        let rows = q.query(lease.client()).await.map_err(failed)?.into_first_result().await.map_err(failed)?;
        lease.release();
        let text = |r: &tiberius::Row, i: usize| r.get::<&str, _>(i).unwrap_or("").to_string();
        let rows = rows.iter().map(|r| (text(r, 0), text(r, 1), text(r, 2), text(r, 3))).collect();
        Ok(SourceSchema::Tables { tables: super::postgres::group_columns(rows) })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let prepared = sql::prepare_query(self, conn, &req, Engine::MsSql).await?;
        let pool = pool(conn).await?;
        let mut lease = lease(conn, &pool).await?;
        // A transaction on the user's SQL Server, through tiberius and raw SQL: not one of Kalzit's
        // own (db::begin), so clippy's rule on sqlx transactions does not apply here.
        simple(lease.client(), "BEGIN TRANSACTION").await?;
        let mut q = Query::new(prepared.sql.clone());
        for bind in prepared.binds {
            match bind {
                Bind::Null => q.bind(None::<String>),
                Bind::Bool(b) => q.bind(b),
                Bind::Int(i) => q.bind(i),
                Bind::Float(f) => q.bind(f),
                Bind::Text(t) => q.bind(t),
                Bind::Time(ms) => q.bind(super::bind_time(ms)?.naive_utc()),
                Bind::Interval(ms) => q.bind(sql::format_interval(ms)),
            }
        }
        let mut frame: Option<FrameBuilder> = None;
        let mut binary = false;
        let mut stopped_early = false;
        {
            let mut stream = q.query(lease.client()).await.map_err(failed)?;
            while let Some(item) = stream.try_next().await.map_err(failed)? {
                match item {
                    QueryItem::Metadata(meta) if meta.result_index() == 0 && frame.is_none() => {
                        let columns =
                            meta.columns().iter().map(|c| Column::new(c.name(), hint(c.column_type()))).collect();
                        frame = Some(FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone()));
                    }
                    QueryItem::Row(row) if row.result_index() == 0 => {
                        let Some(frame) = frame.as_mut() else { continue };
                        let mut values = Vec::with_capacity(row.len());
                        for (column, (_, data)) in frame.columns_mut().iter_mut().zip(row.cells()) {
                            let (value, unreadable) = convert(data, &mut column.field_type);
                            binary |= unreadable;
                            values.push(value);
                        }
                        if !frame.push_row(values) {
                            stopped_early = true;
                            break;
                        }
                    }
                    QueryItem::Metadata(_) | QueryItem::Row(_) => {}
                }
            }
        }
        let mut frame =
            frame.unwrap_or_else(|| FrameBuilder::new(Vec::new(), req.limits.max_rows, req.limits.budget.clone()));
        frame.executed_query(prepared.sql.clone());
        if binary {
            frame.notice(
                NoticeSeverity::Warning,
                Detail::new("frame.binary_hidden", "binary values that are not text are shown empty"),
            );
        }
        if stopped_early {
            // The rest of the result is still on the wire; closing the connection discards it
            // and SQL Server rolls the transaction back.
            drop(lease);
        } else {
            simple(lease.client(), "ROLLBACK TRANSACTION").await?;
            lease.release();
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

/// The field type a column type implies; `None` decides by the first value (`intn` may be any
/// integer size, for instance).
fn hint(t: ColumnType) -> Option<FieldType> {
    match t {
        ColumnType::Bit | ColumnType::Bitn => Some(FieldType::Bool),
        ColumnType::Int8 => Some(FieldType::Int64),
        ColumnType::Int1 | ColumnType::Int2 | ColumnType::Int4 | ColumnType::Float4 | ColumnType::Float8 => {
            Some(FieldType::Number)
        }
        ColumnType::Datetime
        | ColumnType::Datetime4
        | ColumnType::Datetimen
        | ColumnType::Datetime2
        | ColumnType::Daten
        | ColumnType::DatetimeOffsetn => Some(FieldType::Time),
        _ => None,
    }
}

fn finite(f: f64) -> Value {
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// One cell as JSON, fixing the column's type at its first value. The flag says the value was
/// binary data that could not be shown.
fn convert(data: &ColumnData<'static>, field_type: &mut Option<FieldType>) -> (Value, bool) {
    let natural = match data {
        ColumnData::U8(Some(n)) => (FieldType::Number, json!(n)),
        ColumnData::I16(Some(n)) => (FieldType::Number, json!(n)),
        ColumnData::I32(Some(n)) => (FieldType::Number, json!(n)),
        ColumnData::I64(Some(n)) => (FieldType::Int64, json!(n.to_string())),
        ColumnData::F32(Some(f)) => (FieldType::Number, finite(f64::from(*f))),
        ColumnData::F64(Some(f)) => (FieldType::Number, finite(*f)),
        ColumnData::Bit(Some(b)) => (FieldType::Bool, json!(b)),
        ColumnData::String(Some(s)) => (FieldType::String, json!(s)),
        ColumnData::Guid(Some(g)) => (FieldType::String, json!(g.to_string())),
        ColumnData::Numeric(Some(n)) => (FieldType::Number, finite(f64::from(*n))),
        ColumnData::Xml(Some(x)) => (FieldType::String, json!(x.to_string())),
        ColumnData::Binary(Some(b)) => match std::str::from_utf8(b) {
            Ok(t) => (FieldType::String, json!(t)),
            Err(_) => return (Value::Null, true),
        },
        ColumnData::DateTime(Some(_)) | ColumnData::SmallDateTime(Some(_)) | ColumnData::DateTime2(Some(_)) => {
            let t = chrono::NaiveDateTime::from_sql(data).ok().flatten();
            (FieldType::Time, t.map_or(Value::Null, |t| json!(super::naive_to_ms(t))))
        }
        ColumnData::DateTimeOffset(Some(_)) => {
            let t = chrono::DateTime::<chrono::Utc>::from_sql(data).ok().flatten();
            (FieldType::Time, t.map_or(Value::Null, |t| json!(t.timestamp_millis())))
        }
        ColumnData::Date(Some(_)) => {
            let d = chrono::NaiveDate::from_sql(data).ok().flatten().and_then(|d| d.and_hms_opt(0, 0, 0));
            (FieldType::Time, d.map_or(Value::Null, |t| json!(super::naive_to_ms(t))))
        }
        ColumnData::Time(Some(_)) => {
            let t = chrono::NaiveTime::from_sql(data).ok().flatten();
            (FieldType::String, t.map_or(Value::Null, |t| json!(t.to_string())))
        }
        _ => return (Value::Null, false),
    };
    let (natural_type, value) = natural;
    let column_type = *field_type.get_or_insert(natural_type);
    let value = match (column_type, natural_type) {
        (a, b) if a == b => value,
        (FieldType::Int64, FieldType::Number) => json!(value.to_string()),
        (FieldType::Number, FieldType::Int64) => {
            value.as_str().and_then(|s| s.parse::<f64>().ok()).map_or(Value::Null, finite)
        }
        (FieldType::String, _) => json!(value.as_str().map_or_else(|| value.to_string(), String::from)),
        _ => Value::Null,
    };
    (value, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_convert_to_the_column_type() {
        let mut t = None;
        assert_eq!(convert(&ColumnData::I64(Some(9_007_199_254_740_993)), &mut t).0, json!("9007199254740993"));
        assert_eq!(t, Some(FieldType::Int64));
        // An `intn` column whose first value was a bigint keeps strings for smaller values too.
        assert_eq!(convert(&ColumnData::I32(Some(5)), &mut t).0, json!("5"));
        let mut t = None;
        assert_eq!(convert(&ColumnData::String(Some("Grüße".into())), &mut t).0, json!("Grüße"));
        assert_eq!(convert(&ColumnData::I32(None), &mut t), (Value::Null, false));
        let mut t = None;
        assert_eq!(convert(&ColumnData::Binary(Some(vec![0xff, 0x00].into())), &mut t), (Value::Null, true));
        let mut t = None;
        assert_eq!(convert(&ColumnData::F64(Some(f64::NAN)), &mut t).0, Value::Null);
    }
}
