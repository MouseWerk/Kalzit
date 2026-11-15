//! ClickHouse over its native TCP protocol (port 9000, or 9440 with TLS), next to the HTTP
//! interface of `clickhouse`. Kalzit opens the socket to the checked address and TLS itself
//! (`socket`) and hands it to the protocol client.
//!
//! The same guards as over HTTP: the statement check (`sql::check_statement` for ClickHouse:
//! one `SELECT`/`WITH`, no `SETTINGS` or `FORMAT`, no table functions that reach files or other
//! servers), `readonly=1` with every query after Kalzit's own settings, so the server refuses
//! writes, DDL and setting changes, and macros and variables as server-side query parameters
//! (`{p1:Int64}`), never as text. A query that runs too long is cancelled on the server, and one
//! stopped at the row or size limit too.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use nativeclick::block::Block;
use nativeclick::{ClientOptions, NativeclickError, QueryOptions, Type, Value as ChValue};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::Detail;
use super::clickhouse::{clickhouse_error, param_value};
use super::frame::{Column, FrameBuilder};
use super::pool::{ConnPool, Lease, Pooled};
use super::socket;
use super::sql::{self, Engine};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("host", "datasources.settings.host", SettingType::String).target().required(),
    SettingField::new("port", "datasources.settings.port", SettingType::Number)
        .target()
        .default(DefaultValue::Number(9000)),
    SettingField::new("database", "datasources.settings.database", SettingType::String)
        .target()
        .default(DefaultValue::Text("default")),
    SettingField::new("user", "datasources.settings.user", SettingType::String)
        .target()
        .default(DefaultValue::Text("default")),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("tls", "datasources.settings.tls", SettingType::Bool).target().default(DefaultValue::Bool(false)),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_SCHEMA_COLUMNS: usize = 20_000;

pub fn kind() -> Kind {
    Kind {
        name: "ClickHouse (native protocol)",
        hint_key: "datasources.kinds.clickhouse_native.hint",
        settings: SETTINGS,
        plugin: Arc::new(ClickHouseNative),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    host: String,
    port: Option<u64>,
    database: Option<String>,
    user: Option<String>,
    tls: Option<bool>,
    ca_cert: Option<String>,
}

pub struct ClickHouseNative;

/// One protocol connection. The client runs its connection on a task of its own; dropping the
/// last handle closes it.
struct Conn {
    client: nativeclick::Client,
}

impl Pooled for Conn {
    fn reusable(&mut self) -> bool {
        !self.client.is_closed()
    }

    /// Dropping a query's block stream cancels it on the server; closing the connection ends
    /// whatever is left.
    async fn abandon(self) {}
}

fn failed(e: NativeclickError, timeout: Duration) -> SourceError {
    match e {
        NativeclickError::ServerException { code, message, .. } => {
            clickhouse_error(Some(&code.to_string()), &format!("Code: {code}. {message}"))
        }
        NativeclickError::Io(io) if super::connect::is_dead(io.kind()) => super::connect::lost(io),
        NativeclickError::ConnectionClosed => super::connect::lost("the server closed the connection"),
        NativeclickError::Timeout => SourceError::Timeout(timeout.as_secs().max(1)),
        other => SourceError::from_source(other.to_string()),
    }
}

async fn pool(conn: &Connection) -> Result<Arc<ConnPool<Conn>>, SourceError> {
    conn.shared(|| async { Ok(ConnPool::new(POOL_SIZE, IDLE_TIMEOUT)) }).await
}

async fn open(conn: &Connection) -> Result<Conn, SourceError> {
    let s: Settings = conn.settings_as()?;
    let port = s.port.unwrap_or(9000) as u16;
    let tls = s.tls.unwrap_or(false).then_some(socket::Tls { ca_pem: s.ca_cert.as_deref() });
    let opened = socket::open(conn.policy(), &s.host, port, CONNECT_TIMEOUT, tls, "clickhouse.tls").await?;
    let (read, write) = tokio::io::split(opened.stream);
    let options = ClientOptions {
        username: s.user.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| "default".into()),
        password: conn.secret("password").unwrap_or("").to_string(),
        default_database: s.database.filter(|d| !d.trim().is_empty()).unwrap_or_else(|| "default".into()),
        connect_timeout: Some(CONNECT_TIMEOUT),
        ..ClientOptions::default()
    };
    let client = tokio::time::timeout(CONNECT_TIMEOUT, nativeclick::Client::connect_stream(read, write, options))
        .await
        .map_err(|_| SourceError::failed("clickhouse.login_timeout", "ClickHouse did not complete the login in time"))?
        .map_err(|e| failed(e, CONNECT_TIMEOUT))?;
    Ok(Conn { client })
}

async fn lease(conn: &Connection, pool: &Arc<ConnPool<Conn>>) -> Result<Lease<Conn>, SourceError> {
    pool.checkout(|| open(conn)).await
}

/// Kalzit's settings for one query: the server-side time limit, then read-only mode (last: after
/// it, no setting may change), and the values of the query's parameters.
/// Before them, the result limits: the server stops at `max_rows + 1` rows (one more than the
/// frame keeps, so the frame says it was cut) or `max_bytes`, and sends blocks of at most
/// `BLOCK_ROWS` rows, so no single block is larger than a query may answer.
fn options(timeout: Duration, binds: &[sql::Bind], max_rows: usize, max_bytes: usize) -> QueryOptions {
    let mut options = QueryOptions::new()
        .setting("max_execution_time", timeout.as_secs().max(1))
        .setting("max_result_rows", max_rows.saturating_add(1))
        .setting("max_result_bytes", max_bytes.max(1))
        .setting("result_overflow_mode", "break")
        .setting("max_block_size", BLOCK_ROWS)
        .setting("readonly", 1)
        .timeout(timeout);
    for (i, bind) in binds.iter().enumerate() {
        options = options.param(format!("p{}", i + 1), param_value(bind));
    }
    options
}

/// A small statement of Kalzit's own read whole, at most `max_rows` rows, its values as JSON.
async fn rows(client: &nativeclick::Client, statement: &str, max_rows: usize) -> Result<Vec<Vec<Value>>, SourceError> {
    let timeout = super::MAX_HEALTH_TIMEOUT;
    let options = options(timeout, &[], max_rows, SMALL_RESULT_BYTES);
    let mut blocks = client.with_options(options).query_raw(statement).await.map_err(|e| failed(e, timeout))?;
    let mut out = Vec::new();
    let mut notes = Notes::default();
    while let Some(block) = blocks.next().await {
        let block = block.map_err(|e| failed(e, timeout))?;
        let left = max_rows.saturating_sub(out.len());
        out.extend(block_rows(block, left, &mut notes)?.into_iter().take(left));
        if out.len() >= max_rows {
            break;
        }
    }
    Ok(out)
}

/// Rows per block the server is asked for.
const BLOCK_ROWS: usize = 8192;
/// What health and schema answers may take.
const SMALL_RESULT_BYTES: usize = 16 * 1024 * 1024;

/// What a result needs to say about its values.
#[derive(Default)]
struct Notes {
    /// Text that was not UTF-8, shown empty.
    binary: bool,
}

fn hostile_block(why: &str) -> SourceError {
    SourceError::failed("clickhouse.block_invalid", format!("the server sent a block Kalzit does not read: {why}"))
        .with("detail", why)
}

/// A block's rows, at most `max_rows + 1` of them, each value converted by its column's type.
/// The row count is the server's word: a block that claims rows its columns do not hold, or rows
/// without any column, is refused, and nothing is reserved beyond what the columns hold.
fn block_rows(block: Block, max_rows: usize, notes: &mut Notes) -> Result<Vec<Vec<Value>>, SourceError> {
    let claimed = usize::try_from(block.rows).unwrap_or(usize::MAX);
    if claimed > 0 && block.column_data.is_empty() {
        return Err(hostile_block("rows without columns"));
    }
    if block.column_types.len() != block.column_data.len() {
        return Err(hostile_block("columns without types"));
    }
    if block.column_data.values().any(|values| values.len() < claimed) {
        return Err(hostile_block("more rows than its columns hold"));
    }
    let types: Vec<Type> = block.column_types.values().cloned().collect();
    let rows = claimed.min(max_rows.saturating_add(1));
    let mut columns: Vec<std::vec::IntoIter<ChValue>> =
        block.column_data.into_values().map(|values| values.into_iter()).collect();
    let mut out = Vec::with_capacity(rows);
    for _ in 0..rows {
        let row = columns
            .iter_mut()
            .zip(&types)
            .map(|(values, t)| values.next().map_or(Value::Null, |v| decode(t, v, notes)))
            .collect();
        out.push(row);
    }
    Ok(out)
}

/// The type inside `Nullable`, `LowCardinality` and `SimpleAggregateFunction`.
fn base(t: &Type) -> &Type {
    match t {
        Type::Nullable(inner) | Type::LowCardinality(inner) | Type::SimpleAggregateFunction(_, inner) => base(inner),
        other => other,
    }
}

/// The field type of a column, from its ClickHouse type.
fn field_type(t: &Type) -> FieldType {
    match base(t) {
        Type::Int8
        | Type::Int16
        | Type::Int32
        | Type::UInt8
        | Type::UInt16
        | Type::UInt32
        | Type::Float32
        | Type::Float64
        | Type::BFloat16 => FieldType::Number,
        Type::Int64 | Type::UInt64 | Type::Int128 | Type::UInt128 | Type::Int256 | Type::UInt256 => FieldType::Int64,
        Type::Interval(_) => FieldType::Int64,
        Type::Decimal32(_) | Type::Decimal64(_) | Type::Decimal128(_) | Type::Decimal256(_) => FieldType::Decimal,
        Type::Bool => FieldType::Bool,
        Type::Date | Type::Date32 => FieldType::Date,
        Type::DateTime(_) | Type::DateTime64(_, _) => FieldType::Time,
        Type::Array(_)
        | Type::Map(_, _)
        | Type::Tuple(_)
        | Type::NamedTuple(_)
        | Type::Json(_)
        | Type::Variant(_)
        | Type::Dynamic(_)
        | Type::Point
        | Type::Ring
        | Type::Polygon
        | Type::MultiPolygon
        | Type::LineString
        | Type::MultiPoint
        | Type::MultiLineString
        | Type::Geometry => FieldType::Json,
        _ => FieldType::String,
    }
}

fn days_ms(days: i64) -> Value {
    json!(days.saturating_mul(86_400_000))
}

/// One value as the column's field type wants it: numbers as numbers, 64-bit and wider integers
/// and decimals as exact text, times as Unix milliseconds, containers as JSON.
fn decode(t: &Type, v: ChValue, notes: &mut Notes) -> Value {
    let t = base(t);
    match v {
        ChValue::Null => Value::Null,
        ChValue::Int8(x) => json!(x),
        ChValue::Int16(x) => json!(x),
        ChValue::Int32(x) => json!(x),
        ChValue::UInt8(x) => json!(x),
        ChValue::UInt16(x) => json!(x),
        ChValue::UInt32(x) => json!(x),
        ChValue::Int64(x) if field_type(t) == FieldType::Int64 => json!(x.to_string()),
        ChValue::Int64(x) => json!(x),
        ChValue::UInt64(x) => json!(x.to_string()),
        ChValue::Int128(x) => json!(x.to_string()),
        ChValue::UInt128(x) => json!(x.to_string()),
        ChValue::Int256(x) => json!(x.to_string()),
        ChValue::UInt256(x) => json!(x.to_string()),
        ChValue::Float32(x) => serde_json::Number::from_f64(f64::from(x)).map_or(Value::Null, Value::Number),
        ChValue::Float64(x) => serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number),
        ChValue::BFloat16(x) => x.to_string().parse::<f64>().ok().map_or(Value::Null, |f| json!(f)),
        d @ (ChValue::Decimal32(..) | ChValue::Decimal64(..) | ChValue::Decimal128(..) | ChValue::Decimal256(..)) => {
            json!(d.to_string())
        }
        ChValue::Bool(b) => json!(b),
        ChValue::String(bytes) => match String::from_utf8(bytes) {
            // A JSON column arrives as its text.
            Ok(text) if matches!(t, Type::Json(_)) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
            Ok(text) if matches!(t, Type::FixedString(_)) => json!(text.trim_end_matches('\0')),
            Ok(text) => json!(text),
            Err(_) => {
                notes.binary = true;
                Value::Null
            }
        },
        ChValue::Uuid(u) => json!(u.to_string()),
        ChValue::Ipv4(ip) => json!(ip.to_string()),
        ChValue::Ipv6(ip) => json!(ip.to_string()),
        ChValue::Date(d) => days_ms(i64::from(d.0)),
        ChValue::Date32(d) => days_ms(i64::from(d.0)),
        ChValue::DateTime(dt) => json!(i64::from(dt.1) * 1000),
        ChValue::DateTime64(dt) => {
            let ticks = dt.1 as i64;
            let ms = match dt.2 {
                p if p >= 3 => ticks.div_euclid(10_i64.pow((p - 3) as u32)),
                p => ticks.saturating_mul(10_i64.pow((3 - p) as u32)),
            };
            json!(ms)
        }
        ChValue::Time(seconds) => {
            let sign = if seconds < 0 { "-" } else { "" };
            let s = seconds.unsigned_abs();
            json!(format!("{sign}{:02}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60))
        }
        v @ ChValue::Time64(..) => json!(v.to_string()),
        ChValue::Enum8(i) => match t {
            Type::Enum8(names) => names.iter().find(|(_, n)| *n == i).map_or(json!(i), |(name, _)| json!(name)),
            _ => json!(i),
        },
        ChValue::Enum16(i) => match t {
            Type::Enum16(names) => names.iter().find(|(_, n)| *n == i).map_or(json!(i), |(name, _)| json!(name)),
            _ => json!(i),
        },
        ChValue::Array(items) => {
            let inner = match t {
                Type::Array(inner) => inner.as_ref().clone(),
                _ => Type::String,
            };
            Value::Array(items.into_iter().map(|i| decode_json(&inner, i, notes)).collect())
        }
        ChValue::Tuple(items) => match t {
            Type::NamedTuple(fields) => {
                let mut map = Map::new();
                for ((name, ft), item) in fields.iter().zip(items) {
                    map.insert(name.clone(), decode_json(ft, item, notes));
                }
                Value::Object(map)
            }
            Type::Tuple(types) => {
                Value::Array(types.iter().zip(items).map(|(ft, item)| decode_json(ft, item, notes)).collect())
            }
            _ => Value::Array(items.into_iter().map(|i| decode_json(&Type::String, i, notes)).collect()),
        },
        ChValue::Map(keys, values) => {
            let (kt, vt) = match t {
                Type::Map(k, v) => (k.as_ref().clone(), v.as_ref().clone()),
                _ => (Type::String, Type::String),
            };
            let keys: Vec<Value> = keys.into_iter().map(|k| decode_json(&kt, k, notes)).collect();
            let values: Vec<Value> = values.into_iter().map(|v| decode_json(&vt, v, notes)).collect();
            if keys.iter().all(Value::is_string) {
                Value::Object(
                    keys.into_iter().zip(values).map(|(k, v)| (k.as_str().unwrap_or("").to_string(), v)).collect(),
                )
            } else {
                Value::Array(keys.into_iter().zip(values).map(|(k, v)| json!([k, v])).collect())
            }
        }
        ChValue::Dynamic(d) => {
            let inner = *d;
            decode_json(&inner.type_.clone(), inner.value, notes)
        }
        ChValue::Point(p) => json!(p.0),
        ChValue::Ring(r) => json!(r.0.iter().map(|p| p.0).collect::<Vec<_>>()),
        ChValue::Polygon(p) => {
            json!(p.0.iter().map(|r| r.0.iter().map(|p| p.0).collect::<Vec<_>>()).collect::<Vec<_>>())
        }
        ChValue::MultiPolygon(m) => json!(
            m.0.iter()
                .map(|p| p.0.iter().map(|r| r.0.iter().map(|p| p.0).collect::<Vec<_>>()).collect::<Vec<_>>())
                .collect::<Vec<_>>()
        ),
        // Values of types a later protocol version adds: their text.
        other => json!(other.to_string()),
    }
}

/// A value inside a container: as `decode`, but times stay numbers and integers numbers where
/// they fit, as JSON readers expect.
fn decode_json(t: &Type, v: ChValue, notes: &mut Notes) -> Value {
    match v {
        ChValue::Int64(x) if x.unsigned_abs() < (1 << 53) => json!(x),
        ChValue::UInt64(x) if x < (1 << 53) => json!(x),
        other => decode(t, other, notes),
    }
}

#[async_trait::async_trait]
impl DataSourcePlugin for ClickHouseNative {
    fn kind(&self) -> &'static str {
        "clickhouse_native"
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
            let lease = lease(conn, &pool).await?;
            let found = rows(&lease.client, "SELECT version()", 1).await?;
            lease.release();
            Ok::<_, SourceError>(
                found.first().and_then(|r| r.first()).and_then(Value::as_str).unwrap_or("").to_string(),
            )
        };
        match check.await {
            Ok(version) => Health::connected("ClickHouse", &version, false),
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let lease = lease(conn, &pool).await?;
        let found = rows(
            &lease.client,
            &format!(
                "SELECT database, table, name, type FROM system.columns WHERE database = currentDatabase() \
                 ORDER BY table, position LIMIT {MAX_SCHEMA_COLUMNS}"
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
        let prepared = sql::prepare_query(self, conn, &req, Engine::ClickHouse).await?;
        let pool = pool(conn).await?;
        let mut lease = lease(conn, &pool).await?;
        let timeout = req.limits.timeout;
        let start = |client: nativeclick::Client| {
            let statement = prepared.sql.clone();
            let options = options(timeout, &prepared.binds, req.limits.max_rows, req.limits.budget.remaining());
            async move { client.with_options(options).query_raw(statement).await }
        };
        // A pooled connection that closed while idle fails before any answer: once more on a
        // fresh one, which is safe as the query only reads.
        let mut blocks = match start(lease.client.clone()).await.map_err(|e| failed(e, timeout)) {
            Err(e) if super::connect::is_lost(&e) && lease.reused() => {
                lease.discard();
                lease = self::lease(conn, &pool).await?;
                start(lease.client.clone()).await.map_err(|e| failed(e, timeout))?
            }
            other => other?,
        };
        let mut frame: Option<FrameBuilder> = None;
        let mut notes = Notes::default();
        let mut unsupported: Vec<(String, String)> = Vec::new();
        let mut stopped = false;
        'read: while let Some(block) = blocks.next().await {
            let block = block.map_err(|e| failed(e, timeout))?;
            if frame.is_none() && !block.column_types.is_empty() {
                let columns = block
                    .column_types
                    .iter()
                    .map(|(name, t)| {
                        if matches!(base(t), Type::Nothing | Type::Interval(_)) {
                            unsupported.push((name.clone(), t.to_string()));
                        }
                        Column::new(name.clone(), Some(field_type(t)))
                    })
                    .collect();
                frame = Some(FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone()));
            }
            let Some(f) = frame.as_mut() else { continue };
            for row in block_rows(block, req.limits.max_rows, &mut notes)? {
                if !f.push_row(row) {
                    stopped = true;
                    break 'read;
                }
            }
        }
        // Dropping the stream before its end cancels the query on the server.
        drop(blocks);
        if stopped {
            // The cancel's answer is still on the way; the connection is not reused.
            lease.discard();
        } else {
            lease.release();
        }
        let mut frame =
            frame.unwrap_or_else(|| FrameBuilder::new(Vec::new(), req.limits.max_rows, req.limits.budget.clone()));
        frame.executed_query(prepared.sql);
        if notes.binary {
            frame.notice(
                NoticeSeverity::Warning,
                Detail::new("frame.binary_hidden", "binary values that are not text are shown empty"),
            );
        }
        for (name, type_name) in unsupported {
            let message = format!("{name} has the type {type_name}, which is shown as text; convert it in the query");
            frame.notice(
                NoticeSeverity::Info,
                Detail::new("frame.type_unsupported", message).with("column", name).with("type", type_name),
            );
        }
        Ok(QueryResult::Frame { frame: frame.finish() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nativeclick::{Date, DateTime, DynDateTime64, Tz};

    fn one(t: Type, v: ChValue) -> Value {
        decode(&t, v, &mut Notes::default())
    }

    #[test]
    fn types_map_to_field_types() {
        assert_eq!(field_type(&Type::Nullable(Box::new(Type::UInt32))), FieldType::Number);
        assert_eq!(field_type(&Type::LowCardinality(Box::new(Type::String))), FieldType::String);
        assert_eq!(field_type(&Type::Int64), FieldType::Int64);
        assert_eq!(field_type(&Type::Decimal64(2)), FieldType::Decimal);
        assert_eq!(field_type(&Type::DateTime64(3, Tz::UTC)), FieldType::Time);
        assert_eq!(field_type(&Type::Date32), FieldType::Date);
        assert_eq!(field_type(&Type::Array(Box::new(Type::String))), FieldType::Json);
        assert_eq!(field_type(&Type::Bool), FieldType::Bool);
    }

    #[test]
    fn values_keep_their_exactness_and_times_are_milliseconds() {
        assert_eq!(one(Type::Int64, ChValue::Int64(9_007_199_254_740_993)), json!("9007199254740993"));
        assert_eq!(one(Type::UInt32, ChValue::UInt32(7)), json!(7));
        assert_eq!(one(Type::Decimal64(2), ChValue::Decimal64(2, 1250)), json!("12.50"));
        assert_eq!(one(Type::Decimal32(3), ChValue::Decimal32(3, -5)), json!("-0.005"));
        assert_eq!(one(Type::Float64, ChValue::Float64(f64::NAN)), Value::Null);
        assert_eq!(
            one(Type::DateTime(Tz::UTC), ChValue::DateTime(DateTime(Tz::UTC, 1_800_000_000))),
            json!(1_800_000_000_000_i64)
        );
        assert_eq!(
            one(Type::DateTime64(6, Tz::UTC), ChValue::DateTime64(DynDateTime64(Tz::UTC, 1_800_000_000_123_456, 6))),
            json!(1_800_000_000_123_i64)
        );
        assert_eq!(one(Type::Date, ChValue::Date(Date(1))), json!(86_400_000));
        assert_eq!(one(Type::FixedString(4), ChValue::String(b"ab\0\0".to_vec())), json!("ab"));
        assert_eq!(one(Type::Enum8(vec![("rot".into(), 1), ("blau".into(), 2)]), ChValue::Enum8(2)), json!("blau"));
        assert_eq!(
            one(
                Type::Array(Box::new(Type::Nullable(Box::new(Type::Int64)))),
                ChValue::Array(vec![ChValue::Int64(1), ChValue::Null])
            ),
            json!([1, null])
        );
        assert_eq!(
            one(
                Type::Map(Box::new(Type::String), Box::new(Type::UInt8)),
                ChValue::Map(vec![ChValue::String(b"a".to_vec())], vec![ChValue::UInt8(1)])
            ),
            json!({ "a": 1 })
        );
        assert_eq!(
            one(
                Type::NamedTuple(vec![("x".into(), Type::Int32), ("y".into(), Type::String)]),
                ChValue::Tuple(vec![ChValue::Int32(1), ChValue::String(b"z".to_vec())])
            ),
            json!({ "x": 1, "y": "z" })
        );
        assert_eq!(one(Type::Json(String::new()), ChValue::String(br#"{"a":[1]}"#.to_vec())), json!({ "a": [1] }));
        assert_eq!(one(Type::Time, ChValue::Time(3_725)), json!("01:02:05"));
        let mut notes = Notes::default();
        assert_eq!(decode(&Type::String, ChValue::String(vec![0xff]), &mut notes), Value::Null);
        assert!(notes.binary);
    }

    #[test]
    fn readonly_comes_after_the_time_limit_and_parameters_are_escaped() {
        let o = options(
            Duration::from_secs(30),
            &[sql::Bind::Text("Öster'reich\\".into()), sql::Bind::Int(5)],
            100,
            1 << 20,
        );
        let s = |n: &str, v: &str| (n.to_string(), v.to_string());
        assert_eq!(
            o.settings,
            [
                s("max_execution_time", "30"),
                s("max_result_rows", "101"),
                s("max_result_bytes", "1048576"),
                s("result_overflow_mode", "break"),
                s("max_block_size", "8192"),
                s("readonly", "1"),
            ],
            "the limits come before read-only mode, which comes last"
        );
        assert_eq!(o.parameters[0], ("p1".to_string(), "Öster\\'reich\\\\".to_string()));
        assert_eq!(o.parameters[1], ("p2".to_string(), "5".to_string()));
        assert_eq!(o.timeout, Some(Duration::from_secs(30)));
    }

    fn block(rows: u64, columns: Vec<(&str, Type, Vec<ChValue>)>) -> Block {
        let mut b = Block {
            info: nativeclick::block::BlockInfo::default(),
            rows,
            column_types: nativeclick::IndexMap::new(),
            column_data: nativeclick::IndexMap::new(),
        };
        for (name, t, values) in columns {
            b.column_types.insert(name.to_string(), t);
            b.column_data.insert(name.to_string(), values);
        }
        b
    }

    #[test]
    fn hostile_blocks_are_refused_and_nothing_is_reserved_for_their_claims() {
        let mut notes = Notes::default();
        let reason = |b: Block, notes: &mut Notes| block_rows(b, 100, notes).unwrap_err().detail().reason;
        assert_eq!(reason(block(1 << 40, vec![]), &mut notes), "clickhouse.block_invalid");
        let short = block(1 << 40, vec![("n", Type::UInt8, vec![ChValue::UInt8(1)])]);
        assert_eq!(reason(short, &mut notes), "clickhouse.block_invalid");
        let mut untyped = block(1, vec![("n", Type::UInt8, vec![ChValue::UInt8(1)])]);
        untyped.column_types.clear();
        assert_eq!(reason(untyped, &mut notes), "clickhouse.block_invalid");
        // An honest block larger than the limit gives one row more than the limit, no more.
        let big = block(500, vec![("n", Type::UInt32, (0..500).map(ChValue::UInt32).collect())]);
        let rows = block_rows(big, 10, &mut notes).unwrap();
        assert_eq!(rows.len(), 11);
        assert_eq!(rows[10], [json!(10)]);
        assert!(block_rows(block(0, vec![]), 10, &mut notes).unwrap().is_empty());
    }

    #[test]
    fn server_exceptions_are_named_by_their_code() {
        let e = failed(
            NativeclickError::ServerException {
                code: 164,
                name: "DB::Exception".into(),
                message: "Cannot execute query in readonly mode".into(),
                stack_trace: String::new(),
            },
            Duration::from_secs(1),
        );
        assert_eq!(e.detail().reason, "query.write_refused");
        let e = failed(
            NativeclickError::ServerException {
                code: 516,
                name: "DB::Exception".into(),
                message: "default: Authentication failed".into(),
                stack_trace: String::new(),
            },
            Duration::from_secs(1),
        );
        assert_eq!(e.detail().reason, "source.auth_failed");
        assert!(matches!(failed(NativeclickError::Timeout, Duration::from_secs(9)), SourceError::Timeout(9)));
    }

    #[test]
    fn settings_are_checked() {
        let ok = ClickHouseNative.check_settings(&json!({ "host": "ch.intern", "port": 9440, "tls": true }));
        assert!(ok.is_ok());
        let e = ClickHouseNative.check_settings(&json!({ "host": "http://ch.intern" })).unwrap_err();
        assert_eq!(e.field, "host");
        assert!(ClickHouseNative.check_settings(&json!({ "host": "ch", "url": "x" })).is_err());
    }

    /// Against a real ClickHouse (`KALZIT_TEST_CLICKHOUSE_NATIVE_URL`, as in
    /// tests/datasources_sql_kv.rs): a statement sent past the check with Kalzit's settings is
    /// refused by the server's read-only mode itself.
    #[tokio::test]
    async fn readonly_mode_refuses_writes_the_check_did_not_see() {
        let Ok(url) = std::env::var("KALZIT_TEST_CLICKHOUSE_NATIVE_URL") else {
            eprintln!("KALZIT_TEST_CLICKHOUSE_NATIVE_URL not set, test not run");
            return;
        };
        let u = reqwest::Url::parse(&url).unwrap();
        let settings = json!({
            "host": u.host_str().unwrap(),
            "port": u.port().unwrap_or(9000),
            "database": u.path().trim_start_matches('/'),
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
        let timeout = Duration::from_secs(10);
        let refusal = match c
            .client
            .with_options(options(timeout, &[], 10, SMALL_RESULT_BYTES))
            .query_raw("CREATE TABLE kalzit_ro_probe (n UInt8) ENGINE = Memory")
            .await
        {
            Err(e) => failed(e, timeout),
            Ok(mut blocks) => loop {
                match blocks.next().await {
                    Some(Err(e)) => break failed(e, timeout),
                    Some(Ok(_)) => continue,
                    None => panic!("the server ran a CREATE TABLE in read-only mode"),
                }
            },
        };
        assert_eq!(refusal.detail().reason, "query.write_refused", "{refusal:?}");
    }
}
