//! Redis and Valkey over RESP2, with Redis Stack's JSON, search and time series commands.
//!
//! Read-only by an allow-list in the server: a query is one command, and only commands that
//! read, answer in one round trip and never block are sent (`command::ALLOWED`); every other
//! command is refused before it reaches Redis. A user with only the `@read` commands
//! (`ACL SETUSER kalzit on >... ~* +@read +@connection +info`) is the boundary on the Redis side.
//! Keys are browsed with SCAN, never KEYS. Kalzit opens the socket to the checked address
//! itself, with TLS against the configured name when asked (`socket`).

pub mod command;
pub mod reply;
pub mod resp;

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufStream};

use super::pool::{ConnPool, Lease, Pooled};
use super::socket::{self, Stream};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::shapes::{QueryResult, Shape};
use resp::{Reply, RespError};

const SETTINGS: &[SettingField] = &[
    SettingField::new("host", "datasources.settings.host", SettingType::String).target().required(),
    SettingField::new("port", "datasources.settings.port", SettingType::Number)
        .target()
        .default(DefaultValue::Number(6379)),
    SettingField::new("database", "datasources.settings.databaseIndex", SettingType::Number)
        .target()
        .default(DefaultValue::Number(0)),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("tls", "datasources.settings.tls", SettingType::Bool).target().default(DefaultValue::Bool(false)),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
];
const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Idle connections older than this are closed instead of reused.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Keys the schema lists, read with SCAN in pages of `SCAN_COUNT`.
const MAX_SCHEMA_KEYS: usize = 1_000;
const SCAN_COUNT: usize = 500;
/// Pages a schema read takes at most, so a database of mostly expired keys does not keep it busy.
const MAX_SCAN_PAGES: usize = 50;
/// Health and schema answers are small; this bounds a misbehaving server.
const SMALL_REPLY: usize = 4 * 1024 * 1024;
/// Highest database index Redis has by default (`databases 16`); a server may have more.
const MAX_DATABASE: u64 = 1_000_000;

pub fn kind() -> Kind {
    Kind { name: "Redis", hint_key: "datasources.kinds.redis.hint", settings: SETTINGS, plugin: Arc::new(Redis) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    host: String,
    port: Option<u64>,
    database: Option<u64>,
    user: Option<String>,
    tls: Option<bool>,
    ca_cert: Option<String>,
}

pub struct Redis;

/// One connection: the stream and, for plain TCP, a second handle on its socket.
struct Conn {
    stream: BufStream<Box<dyn Stream>>,
    probe: Option<std::net::TcpStream>,
    /// A reply was read only in part, or the stream failed: never reuse.
    broken: bool,
}

impl Pooled for Conn {
    fn reusable(&mut self) -> bool {
        !self.broken && self.probe.as_ref().is_none_or(super::pool::socket_open)
    }

    /// Redis runs one command at a time and has nothing to cancel; closing is enough.
    async fn abandon(mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), self.stream.shutdown()).await;
    }
}

/// A Redis error reply as a source error: a refused command of the ACL is named as such.
pub(crate) fn server_error(text: &str) -> SourceError {
    let code = text.split_whitespace().next().unwrap_or("");
    if code == "NOPERM" {
        return SourceError::failed("redis.no_permission", format!("Redis refused the command for this user: {text}"))
            .with("detail", text);
    }
    if matches!(code, "WRONGPASS" | "NOAUTH") {
        return super::connect::auth_failed(text);
    }
    SourceError::failed("redis.error", format!("Redis answered an error: {text}")).with("detail", text)
}

fn resp_failed(e: RespError) -> SourceError {
    match e {
        RespError::Io(io) if super::connect::is_dead(io.kind()) => super::connect::lost(io),
        RespError::Io(io) => SourceError::from_source(io.to_string()),
        RespError::TooLarge => SourceError::failed(
            "redis.reply_too_large",
            "the answer is larger than the response size limit; narrow the command (a range, a COUNT)",
        ),
        RespError::Protocol(p) => {
            SourceError::failed("redis.not_redis", format!("the server does not answer like Redis: {p}"))
        }
    }
}

impl Conn {
    /// Sends one command and reads its reply within `budget` bytes. A failure leaves the
    /// connection broken, as the rest of a reply may still be on the wire.
    async fn call(&mut self, args: &[Vec<u8>], budget: usize) -> Result<Reply, SourceError> {
        self.broken = true;
        self.stream.write_all(&resp::encode(args)).await.map_err(|e| resp_failed(e.into()))?;
        self.stream.flush().await.map_err(|e| resp_failed(e.into()))?;
        let mut left = budget;
        let reply = resp::read(&mut self.stream, &mut left).await.map_err(resp_failed)?;
        self.broken = false;
        Ok(reply)
    }

    /// A command whose error reply is a failure.
    async fn ok(&mut self, args: &[&[u8]]) -> Result<Reply, SourceError> {
        let args: Vec<Vec<u8>> = args.iter().map(|a| a.to_vec()).collect();
        match self.call(&args, SMALL_REPLY).await? {
            Reply::Error(e) => Err(server_error(&e)),
            other => Ok(other),
        }
    }
}

async fn pool(conn: &Connection) -> Result<Arc<ConnPool<Conn>>, SourceError> {
    conn.shared(|| async { Ok(ConnPool::new(POOL_SIZE, IDLE_TIMEOUT)) }).await
}

async fn open(conn: &Connection) -> Result<Conn, SourceError> {
    let s: Settings = conn.settings_as()?;
    let port = s.port.unwrap_or(6379) as u16;
    let tls = s.tls.unwrap_or(false).then_some(socket::Tls { ca_pem: s.ca_cert.as_deref() });
    let opened = socket::open(conn.policy(), &s.host, port, CONNECT_TIMEOUT, tls, "redis.tls").await?;
    let mut c = Conn { stream: BufStream::new(opened.stream), probe: opened.probe, broken: false };
    let login = async {
        let user = s.user.as_deref().filter(|u| !u.trim().is_empty());
        match (user, conn.secret("password")) {
            (Some(user), Some(password)) => c.ok(&[b"AUTH", user.as_bytes(), password.as_bytes()]).await?,
            (Some(user), None) => c.ok(&[b"AUTH", user.as_bytes(), b""]).await?,
            (None, Some(password)) => c.ok(&[b"AUTH", password.as_bytes()]).await?,
            (None, None) => c.ok(&[b"PING"]).await?,
        };
        if let Some(db) = s.database.filter(|d| *d > 0) {
            c.ok(&[b"SELECT", db.to_string().as_bytes()]).await?;
        }
        Ok::<_, SourceError>(())
    };
    tokio::time::timeout(CONNECT_TIMEOUT, login)
        .await
        .map_err(|_| SourceError::failed("redis.login_timeout", "Redis did not complete the login in time"))??;
    Ok(c)
}

async fn lease(conn: &Connection, pool: &Arc<ConnPool<Conn>>) -> Result<Lease<Conn>, SourceError> {
    pool.checkout(|| open(conn)).await
}

/// Runs one command; a pooled connection that turns out closed (the server restarted) before
/// any answer is replaced once, which is safe as every command Kalzit sends only reads.
async fn run(conn: &Connection, args: &[Vec<u8>], budget: usize) -> Result<Reply, SourceError> {
    let pool = pool(conn).await?;
    let mut lease = lease(conn, &pool).await?;
    let reply = match lease.call(args, budget).await {
        Err(e) if super::connect::is_lost(&e) && lease.reused() => {
            lease.discard();
            lease = self::lease(conn, &pool).await?;
            lease.call(args, budget).await?
        }
        other => other?,
    };
    lease.release();
    Ok(reply)
}

/// One key of the schema: its name and Redis type (`string`, `hash`, `ReJSON-RL`, `TSDB-TYPE`).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct KeyInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: String,
}

#[async_trait::async_trait]
impl DataSourcePlugin for Redis {
    fn kind(&self) -> &'static str {
        "redis"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Frame, Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        super::check_host("host", &s.host)?;
        super::check_port("port", s.port)?;
        if s.database.is_some_and(|d| d > MAX_DATABASE) {
            return Err(FieldError::new("database", "settings.out_of_range", "database must be 0 to 1000000")
                .with("min", 0)
                .with("max", MAX_DATABASE));
        }
        if s.user.as_deref().is_some_and(|u| u.chars().any(char::is_whitespace)) {
            return Err(FieldError::new("user", "settings.user_invalid", "the user name must not contain spaces"));
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let pool = pool(conn).await?;
            let mut lease = lease(conn, &pool).await?;
            let info = lease.ok(&[b"INFO", b"server"]).await?;
            lease.release();
            Ok::<_, SourceError>(info.text().unwrap_or_default())
        };
        match check.await {
            Ok(info) => {
                let field = |name: &str| {
                    info.lines().find_map(|l| l.trim().strip_prefix(name)?.strip_prefix(':').map(str::to_string))
                };
                // Valkey answers both; its own version comes first.
                match field("valkey_version") {
                    Some(v) => Health::connected("Valkey", &v, false),
                    None => Health::connected("Redis", &field("redis_version").unwrap_or_default(), false),
                }
            }
            Err(e) => Health::failed(&e),
        }
    }

    /// Up to `MAX_SCHEMA_KEYS` keys found with SCAN, with their types asked in one pipeline.
    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let pool = pool(conn).await?;
        let mut lease = lease(conn, &pool).await?;
        let mut names: Vec<Vec<u8>> = Vec::new();
        let mut cursor = b"0".to_vec();
        let mut complete = false;
        for _ in 0..MAX_SCAN_PAGES {
            let count = SCAN_COUNT.to_string();
            let reply = lease.ok(&[b"SCAN", &cursor, b"COUNT", count.as_bytes()]).await?;
            let Reply::Array(parts) = reply else { break };
            let mut parts = parts.into_iter();
            let (Some(next), Some(Reply::Array(keys))) = (parts.next(), parts.next()) else { break };
            for key in keys {
                if let Reply::Bulk(k) = key
                    && names.len() < MAX_SCHEMA_KEYS
                {
                    names.push(k);
                }
            }
            cursor = match next {
                Reply::Bulk(c) => c,
                other => other.text().unwrap_or_default().into_bytes(),
            };
            if cursor == b"0" {
                complete = true;
                break;
            }
            if names.len() >= MAX_SCHEMA_KEYS {
                break;
            }
        }
        names.sort();
        names.dedup();
        // TYPE for every key at once: written together, answered in order.
        let mut out = Vec::new();
        for name in &names {
            out.extend(resp::encode(&[b"TYPE".to_vec(), name.clone()]));
        }
        lease.broken = true;
        lease.stream.write_all(&out).await.map_err(|e| resp_failed(e.into()))?;
        lease.stream.flush().await.map_err(|e| resp_failed(e.into()))?;
        let mut keys = Vec::with_capacity(names.len());
        let mut budget = SMALL_REPLY;
        for name in names {
            let t = resp::read(&mut lease.stream, &mut budget).await.map_err(resp_failed)?;
            keys.push(KeyInfo {
                name: String::from_utf8_lossy(&name).into_owned(),
                key_type: t.text().unwrap_or_default(),
            });
        }
        lease.broken = false;
        lease.release();
        Ok(SourceSchema::Keys { keys, complete })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let command = command::prepare(&req)?;
        // The reply is read whole before it becomes a result; the budget bounds it.
        let budget = req.limits.budget.remaining().max(1024);
        let reply = run(conn, &command.args, budget).await?;
        reply::result(&command, reply, &req)
    }
}

/// The settings of a test connection, for the unit tests of the kind.
#[cfg(test)]
fn settings(extra: std::collections::BTreeMap<&str, Value>) -> Value {
    let mut map = serde_json::Map::new();
    map.insert("host".into(), Value::String("cache.intern".into()));
    for (k, v) in extra {
        map.insert(k.into(), v);
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn settings_are_checked() {
        let check = |extra: BTreeMap<&str, Value>| Redis.check_settings(&settings(extra));
        assert!(check(BTreeMap::new()).is_ok());
        assert!(check(BTreeMap::from([("database", json!(3)), ("tls", json!(true))])).is_ok());
        assert_eq!(check(BTreeMap::from([("database", json!(2_000_000))])).unwrap_err().field, "database");
        assert_eq!(check(BTreeMap::from([("user", json!("a b"))])).unwrap_err().field, "user");
        assert_eq!(check(BTreeMap::from([("port", json!(70_000))])).unwrap_err().field, "port");
        assert_eq!(check(BTreeMap::from([("host", json!("user@redis"))])).unwrap_err().field, "host");
        assert!(check(BTreeMap::from([("unknown", json!(1))])).is_err());
    }

    #[test]
    fn errors_are_named_by_their_code() {
        assert_eq!(server_error("NOPERM User kalzit has no permissions").detail().reason, "redis.no_permission");
        assert_eq!(server_error("WRONGPASS invalid username-password pair").detail().reason, "source.auth_failed");
        assert_eq!(server_error("ERR unknown command").detail().reason, "redis.error");
        assert_eq!(resp_failed(RespError::TooLarge).detail().reason, "redis.reply_too_large");
        let lost = resp_failed(RespError::Io(std::io::ErrorKind::UnexpectedEof.into()));
        assert!(super::super::connect::is_lost(&lost));
    }

    /// A fake Redis on a local port: answers AUTH, SELECT, SCAN, TYPE and GET, and records
    /// every command it receives.
    async fn fake_redis() -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::AsyncBufReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let mut s = tokio::io::BufStream::new(socket);
                    loop {
                        let mut header = String::new();
                        if s.read_line(&mut header).await.unwrap_or(0) == 0 {
                            return;
                        }
                        let n: usize = header.trim().trim_start_matches('*').parse().unwrap_or(0);
                        let mut args = Vec::new();
                        for _ in 0..n {
                            let mut len = String::new();
                            s.read_line(&mut len).await.unwrap();
                            let mut arg = String::new();
                            s.read_line(&mut arg).await.unwrap();
                            args.push(arg.trim_end().to_string());
                        }
                        log.lock().unwrap().push(args.join(" "));
                        let answer: Vec<u8> = match args[0].to_ascii_uppercase().as_str() {
                            "AUTH" if args.get(2).map(String::as_str) == Some("falsch") => {
                                b"-WRONGPASS invalid username-password pair or user is disabled.\r\n".to_vec()
                            }
                            "AUTH" | "SELECT" => b"+OK\r\n".to_vec(),
                            "INFO" => {
                                let info = "# Server\r\nredis_version:8.2.1\r\n";
                                format!("${}\r\n{info}\r\n", info.len()).into_bytes()
                            }
                            "SCAN" => b"*2\r\n$1\r\n0\r\n*2\r\n$6\r\nuser:1\r\n$4\r\nzahl\r\n".to_vec(),
                            "TYPE" if args[1] == "user:1" => b"+hash\r\n".to_vec(),
                            "TYPE" => b"+string\r\n".to_vec(),
                            "GET" => b"$2\r\n42\r\n".to_vec(),
                            _ => b"-ERR unknown command\r\n".to_vec(),
                        };
                        s.write_all(&answer).await.unwrap();
                        s.flush().await.unwrap();
                    }
                });
            }
        });
        (port, seen)
    }

    async fn connection(port: u16, password: &str) -> Connection {
        let policy = super::super::targets::TargetPolicy::new(
            &std::env::temp_dir().join("kalzit-none"),
            "sqlite::memory:",
            &[],
            &[],
        );
        super::super::json_documents::test_connection(
            json!({ "host": "127.0.0.1", "port": port, "user": "leser", "database": 2 }),
            &[("password", password)],
            policy,
        )
        .await
    }

    /// One step of a test against the fake, which never takes long.
    async fn step<T>(name: &str, f: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(10), f).await.unwrap_or_else(|_| panic!("{name} timed out"))
    }

    #[tokio::test]
    async fn logs_in_selects_reads_and_browses_keys() {
        let (port, seen) = fake_redis().await;
        let conn = connection(port, "geheim").await;
        let h = step("health", Redis.health(&conn)).await;
        assert!(h.ok, "{:?}", h.detail);
        assert_eq!(h.detail.params["engine"], "Redis");
        assert_eq!(h.detail.params["version"], "8.2.1");
        let SourceSchema::Keys { keys, complete } = step("schema", Redis.schema(&conn)).await.unwrap() else {
            panic!("keys")
        };
        assert!(complete);
        assert_eq!(keys[0], KeyInfo { name: "user:1".into(), key_type: "hash".into() });
        assert_eq!(keys[1].key_type, "string");
        let req = SourceQuery {
            ref_id: "A".into(),
            query: json!({ "command": "GET zahl" }),
            range: crate::shapes::TimeRange { from: 0, to: 1 },
            interval_ms: 1000,
            max_data_points: None,
            variables: BTreeMap::new(),
            identifier_variables: None,
            limits: super::super::Limits {
                timeout: Duration::from_secs(5),
                max_rows: 10,
                budget: super::super::frame::ResponseBudget::new(1 << 20),
            },
            cursor: None,
        };
        let QueryResult::Frame { frame } = step("query", Redis.query(&conn, req)).await.unwrap() else {
            panic!("frame")
        };
        assert_eq!(frame.fields()[0].values, [json!(42.0)]);
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen[0], "AUTH leser geheim");
        assert_eq!(seen[1], "SELECT 2");
        assert!(seen.iter().all(|c| !c.starts_with("KEYS")), "{seen:?}");

        let wrong = connection(port, "falsch").await;
        let h = step("wrong", Redis.health(&wrong)).await;
        assert!(!h.ok);
        assert_eq!(h.detail.reason, "source.auth_failed");
    }
}
