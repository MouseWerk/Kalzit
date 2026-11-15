//! A Redis query: one command written as in `redis-cli` (`HGETALL user:42`), split into
//! arguments, with Kalzit's macros and variables put into them, and checked against the list of
//! commands that only read. Every argument is sent as its own bulk string, so a value can change
//! an argument but never add a command; the command itself can never come from a variable.

use std::collections::BTreeMap;

use serde_json::Value;

use super::super::{SourceError, SourceQuery};

/// How a command's answer becomes a result (`reply.rs`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// One value, or a flat list of them: a `value` column.
    Values,
    /// One answer per argument from `from` on (MGET's keys, HMGET's fields): two columns.
    PerArgument { from: usize, name: &'static str },
    /// Pairs (HGETALL): `field` and `value`.
    Pairs,
    /// Members with scores when `WITHSCORES` is given (ZRANGE and friends), else `Values`.
    Scored,
    /// Fields with values when `WITHVALUES` is given (HRANDFIELD), else `Values`.
    WithValues,
    /// `[cursor, [items]]` of SCAN, HSCAN, SSCAN and ZSCAN.
    Scan { pairs: bool, scored: bool },
    /// INFO's text: `section`, `key`, `value`.
    Info,
    /// Stream entries (XRANGE): one document per entry.
    Stream,
    /// RedisJSON (JSON.GET, JSON.MGET): documents.
    Json,
    /// RediSearch FT.SEARCH: one document per hit.
    Search,
    /// RediSearch FT.AGGREGATE: one document per row.
    Aggregate,
    /// Time series samples (TS.RANGE): `time` and the key's values.
    Samples,
    /// Several series (TS.MRANGE): a time column and one per series, with its labels.
    MultiSamples,
    /// The last sample of several series (TS.MGET): `key`, `time`, `value`.
    LastSamples,
    /// Field and value lists of the info commands (XINFO STREAM, TS.INFO, FT.INFO).
    InfoPairs,
}

/// The commands Kalzit runs: each reads only, answers within one round trip and never blocks.
/// Two-word commands are listed with their subcommand. Everything else is refused, writes and
/// administration, scripts (also the read-only ones, which run any code), blocking reads,
/// `KEYS` (which stops the server while it walks every key; SCAN does not) and `MONITOR` or
/// `SUBSCRIBE`, which never end.
pub const ALLOWED: &[(&str, Shape)] = &[
    // Keys and strings
    ("GET", Shape::Values),
    ("MGET", Shape::PerArgument { from: 1, name: "key" }),
    ("STRLEN", Shape::Values),
    ("GETRANGE", Shape::Values),
    ("SUBSTR", Shape::Values),
    ("LCS", Shape::Values),
    ("EXISTS", Shape::Values),
    ("TYPE", Shape::Values),
    ("TTL", Shape::Values),
    ("PTTL", Shape::Values),
    ("EXPIRETIME", Shape::Values),
    ("PEXPIRETIME", Shape::Values),
    ("DBSIZE", Shape::Values),
    ("RANDOMKEY", Shape::Values),
    ("SCAN", Shape::Scan { pairs: false, scored: false }),
    ("GETBIT", Shape::Values),
    ("BITCOUNT", Shape::Values),
    ("BITPOS", Shape::Values),
    ("OBJECT ENCODING", Shape::Values),
    ("OBJECT FREQ", Shape::Values),
    ("OBJECT IDLETIME", Shape::Values),
    ("OBJECT REFCOUNT", Shape::Values),
    ("MEMORY USAGE", Shape::Values),
    ("INFO", Shape::Info),
    ("TIME", Shape::Values),
    ("PING", Shape::Values),
    // Hashes
    ("HGET", Shape::Values),
    ("HMGET", Shape::PerArgument { from: 2, name: "field" }),
    ("HGETALL", Shape::Pairs),
    ("HKEYS", Shape::Values),
    ("HVALS", Shape::Values),
    ("HLEN", Shape::Values),
    ("HEXISTS", Shape::Values),
    ("HSTRLEN", Shape::Values),
    ("HRANDFIELD", Shape::WithValues),
    ("HSCAN", Shape::Scan { pairs: true, scored: false }),
    ("HTTL", Shape::Values),
    ("HPTTL", Shape::Values),
    // Lists
    ("LRANGE", Shape::Values),
    ("LLEN", Shape::Values),
    ("LINDEX", Shape::Values),
    ("LPOS", Shape::Values),
    // Sets
    ("SMEMBERS", Shape::Values),
    ("SCARD", Shape::Values),
    ("SISMEMBER", Shape::Values),
    ("SMISMEMBER", Shape::PerArgument { from: 2, name: "member" }),
    ("SRANDMEMBER", Shape::Values),
    ("SINTER", Shape::Values),
    ("SINTERCARD", Shape::Values),
    ("SUNION", Shape::Values),
    ("SDIFF", Shape::Values),
    ("SSCAN", Shape::Scan { pairs: false, scored: false }),
    // Sorted sets
    ("ZRANGE", Shape::Scored),
    ("ZRANGEBYSCORE", Shape::Scored),
    ("ZREVRANGE", Shape::Scored),
    ("ZREVRANGEBYSCORE", Shape::Scored),
    ("ZRANGEBYLEX", Shape::Values),
    ("ZREVRANGEBYLEX", Shape::Values),
    ("ZRANDMEMBER", Shape::Scored),
    ("ZCARD", Shape::Values),
    ("ZCOUNT", Shape::Values),
    ("ZLEXCOUNT", Shape::Values),
    ("ZSCORE", Shape::Values),
    ("ZMSCORE", Shape::PerArgument { from: 2, name: "member" }),
    ("ZRANK", Shape::Values),
    ("ZREVRANK", Shape::Values),
    ("ZSCAN", Shape::Scan { pairs: true, scored: true }),
    // HyperLogLog, geo, sort
    ("PFCOUNT", Shape::Values),
    ("GEOPOS", Shape::PerArgument { from: 2, name: "member" }),
    ("GEODIST", Shape::Values),
    ("GEOHASH", Shape::PerArgument { from: 2, name: "member" }),
    ("GEOSEARCH", Shape::Values),
    ("GEORADIUS_RO", Shape::Values),
    ("GEORADIUSBYMEMBER_RO", Shape::Values),
    ("SORT_RO", Shape::Values),
    // Streams
    ("XRANGE", Shape::Stream),
    ("XREVRANGE", Shape::Stream),
    ("XLEN", Shape::Values),
    ("XINFO STREAM", Shape::InfoPairs),
    ("XINFO GROUPS", Shape::Values),
    ("XINFO CONSUMERS", Shape::Values),
    // RedisJSON
    ("JSON.GET", Shape::Json),
    ("JSON.MGET", Shape::Json),
    ("JSON.TYPE", Shape::Values),
    ("JSON.OBJKEYS", Shape::Values),
    ("JSON.OBJLEN", Shape::Values),
    ("JSON.ARRLEN", Shape::Values),
    ("JSON.STRLEN", Shape::Values),
    // RediSearch
    ("FT.SEARCH", Shape::Search),
    ("FT.AGGREGATE", Shape::Aggregate),
    ("FT.INFO", Shape::InfoPairs),
    ("FT._LIST", Shape::Values),
    ("FT.TAGVALS", Shape::Values),
    // RedisTimeSeries
    ("TS.RANGE", Shape::Samples),
    ("TS.REVRANGE", Shape::Samples),
    ("TS.MRANGE", Shape::MultiSamples),
    ("TS.MREVRANGE", Shape::MultiSamples),
    ("TS.GET", Shape::Samples),
    ("TS.MGET", Shape::LastSamples),
    ("TS.INFO", Shape::InfoPairs),
    ("TS.QUERYINDEX", Shape::Values),
];

/// Commands with a subcommand: the first two words name the command.
const WITH_SUBCOMMAND: &[&str] = &["OBJECT", "MEMORY", "XINFO"];

/// Arguments refused on commands that otherwise read: they keep state on the server
/// (`WITHCURSOR` opens a cursor that outlives the query).
const REFUSED_ARGUMENTS: &[(&str, &str)] = &[("FT.AGGREGATE", "WITHCURSOR")];

/// A command ready to send.
#[derive(Debug, PartialEq)]
pub struct Command {
    /// As sent; the first one or two are the command's name.
    pub args: Vec<Vec<u8>>,
    /// The name in upper case (`HGETALL`, `XINFO STREAM`).
    pub name: String,
    pub shape: Shape,
    /// The command as written, with the values put in, for "executed query".
    pub text: String,
}

impl Command {
    /// Whether an argument after the name equals `word`, in any case.
    pub fn has_flag(&self, word: &str) -> bool {
        self.args.iter().skip(1).any(|a| a.eq_ignore_ascii_case(word.as_bytes()))
    }

    /// The argument at `i` as text.
    pub fn arg(&self, i: usize) -> Option<String> {
        self.args.get(i).map(|a| String::from_utf8_lossy(a).into_owned())
    }
}

/// `{"command": "HGETALL user:42"}`.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedisQuery {
    pub command: String,
}

fn rejected(reason: &'static str, message: impl Into<String>) -> SourceError {
    SourceError::rejected(reason, message)
}

/// One word as written: its pieces, so variables are put in only where they were written
/// outside single quotes.
#[derive(Debug, Default)]
struct Word {
    pieces: Vec<Piece>,
}

#[derive(Debug, PartialEq)]
enum Piece {
    Text(Vec<u8>),
    /// `$name` or `${name}`.
    Variable(String),
    /// `$__timeFrom` and friends.
    Macro(String),
}

impl Word {
    fn push_text(&mut self, bytes: &[u8]) {
        match self.pieces.last_mut() {
            Some(Piece::Text(t)) => t.extend_from_slice(bytes),
            _ => self.pieces.push(Piece::Text(bytes.to_vec())),
        }
    }
}

fn is_ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}

fn is_ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

/// A `$` at `i` (in text where variables count): the piece and the index after it, or `None`
/// when it starts no name (`$` in a JSONPath such as `$.name`).
fn dollar(text: &[u8], i: usize) -> Result<Option<(Piece, usize)>, SourceError> {
    if text.get(i + 1) == Some(&b'{') {
        let close = text[i..]
            .iter()
            .position(|b| *b == b'}')
            .map(|p| i + p)
            .ok_or_else(|| rejected("redis.unclosed_variable", "unclosed ${...}"))?;
        let name = String::from_utf8_lossy(&text[i + 2..close]).into_owned();
        if !name.bytes().next().is_some_and(is_ident_start) || !name.bytes().all(is_ident) {
            return Err(rejected("redis.variable_name_invalid", format!("invalid variable name in ${{{name}}}"))
                .with("name", name));
        }
        let piece = if name.starts_with("__") { Piece::Macro(name) } else { Piece::Variable(name) };
        return Ok(Some((piece, close + 1)));
    }
    if !text.get(i + 1).copied().is_some_and(is_ident_start) {
        return Ok(None);
    }
    let end = text[i + 1..].iter().position(|b| !is_ident(*b)).map_or(text.len(), |p| i + 1 + p);
    let name = String::from_utf8_lossy(&text[i + 1..end]).into_owned();
    let piece = if name.starts_with("__") { Piece::Macro(name) } else { Piece::Variable(name) };
    Ok(Some((piece, end)))
}

/// Splits the command as `redis-cli` does: words between spaces; `"..."` with the escapes
/// `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\a` and `\xHH`; `'...'` with only `\'`, and without
/// variables. A quote must be followed by a space or the end.
fn words(text: &str) -> Result<Vec<Word>, SourceError> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() {
            return Ok(out);
        }
        let mut word = Word::default();
        match b[i] {
            b'"' => {
                i += 1;
                loop {
                    let Some(&c) = b.get(i) else {
                        return Err(rejected("redis.unclosed_quote", "unclosed quote in the command"));
                    };
                    match c {
                        b'"' => {
                            i += 1;
                            break;
                        }
                        b'\\' => {
                            let (byte, len) = match b.get(i + 1) {
                                Some(b'x')
                                    if b.get(i + 2).is_some_and(u8::is_ascii_hexdigit)
                                        && b.get(i + 3).is_some_and(u8::is_ascii_hexdigit) =>
                                {
                                    let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
                                    (hex(b[i + 2]) * 16 + hex(b[i + 3]), 4)
                                }
                                Some(b'n') => (b'\n', 2),
                                Some(b'r') => (b'\r', 2),
                                Some(b't') => (b'\t', 2),
                                Some(b'b') => (8, 2),
                                Some(b'a') => (7, 2),
                                Some(&other) if other.is_ascii() => (other, 2),
                                // Before a character that is not ASCII the backslash is itself.
                                Some(_) => (b'\\', 1),
                                None => return Err(rejected("redis.unclosed_quote", "unclosed quote in the command")),
                            };
                            word.push_text(&[byte]);
                            i += len;
                        }
                        b'$' => match dollar(b, i)? {
                            Some((piece, end)) => {
                                word.pieces.push(piece);
                                i = end;
                            }
                            None => {
                                word.push_text(b"$");
                                i += 1;
                            }
                        },
                        _ => {
                            let len = text[i..].chars().next().map_or(1, char::len_utf8);
                            word.push_text(&b[i..i + len]);
                            i += len;
                        }
                    }
                }
            }
            b'\'' => {
                i += 1;
                loop {
                    match (b.get(i), b.get(i + 1)) {
                        (None, _) => return Err(rejected("redis.unclosed_quote", "unclosed quote in the command")),
                        (Some(b'\\'), Some(b'\'')) => {
                            word.push_text(b"'");
                            i += 2;
                        }
                        (Some(b'\''), _) => {
                            i += 1;
                            break;
                        }
                        (Some(&c), _) => {
                            word.push_text(&[c]);
                            i += 1;
                        }
                    }
                }
            }
            _ => {
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    if matches!(b[i], b'"' | b'\'') {
                        return Err(rejected(
                            "redis.quote_inside_word",
                            "a quote may only start a word; quote the whole argument",
                        ));
                    }
                    if b[i] == b'$'
                        && let Some((piece, end)) = dollar(b, i)?
                    {
                        word.pieces.push(piece);
                        i = end;
                        continue;
                    }
                    word.push_text(&b[i..i + 1]);
                    i += 1;
                }
                out.push(word);
                continue;
            }
        }
        if i < b.len() && !b[i].is_ascii_whitespace() {
            return Err(rejected("redis.quote_inside_word", "a quote may only start a word; quote the whole argument"));
        }
        out.push(word);
    }
}

/// A variable's value as text inside an argument.
fn scalar(name: &str, value: &Value) -> Result<Vec<u8>, SourceError> {
    match value {
        Value::String(s) => Ok(s.clone().into_bytes()),
        Value::Number(n) => Ok(n.to_string().into_bytes()),
        Value::Bool(b) => Ok(b.to_string().into_bytes()),
        _ => Err(rejected("redis.variable_type", format!("variable {name} must be a string, number or boolean"))
            .with("name", name)),
    }
}

fn macro_value(name: &str, req: &SourceQuery) -> Result<Vec<u8>, SourceError> {
    let text = match name {
        // Redis keeps times in milliseconds (time series, stream ids), so the macros do too.
        "__timeFrom" => req.range.from.to_string(),
        "__timeTo" => req.range.to.to_string(),
        "__interval" | "__interval_ms" => req.interval_ms.max(1).to_string(),
        other => {
            return Err(rejected("redis.macro_unknown", format!("unknown macro ${other}")).with("name", other));
        }
    };
    Ok(text.into_bytes())
}

/// The arguments of one word: a word that is only a variable with a list value becomes one
/// argument per value (`MGET $keys`); inside a longer word a list is refused.
fn expand(word: &Word, variables: &BTreeMap<String, Value>, req: &SourceQuery) -> Result<Vec<Vec<u8>>, SourceError> {
    let lookup = |name: &str| {
        variables.get(name).ok_or_else(|| {
            rejected("redis.variable_missing", format!("variable {name} has no value")).with("name", name)
        })
    };
    if let [Piece::Variable(name)] = word.pieces.as_slice()
        && let Value::Array(items) = lookup(name)?
    {
        return items.iter().map(|v| scalar(name, v)).collect();
    }
    let mut out = Vec::new();
    for piece in &word.pieces {
        match piece {
            Piece::Text(t) => out.extend_from_slice(t),
            Piece::Macro(m) => out.extend(macro_value(m, req)?),
            Piece::Variable(name) => match lookup(name)? {
                Value::Array(_) => {
                    return Err(rejected(
                        "redis.variable_list_in_argument",
                        format!("variable {name} holds a list; write it as an argument of its own"),
                    )
                    .with("name", name));
                }
                value => out.extend(scalar(name, value)?),
            },
        }
    }
    Ok(vec![out])
}

/// The command's text as a person reads it: plain words as they are, others quoted.
fn display(args: &[Vec<u8>]) -> String {
    args.iter()
        .map(|a| {
            let text = String::from_utf8_lossy(a);
            let plain = !text.is_empty() && text.chars().all(|c| !c.is_whitespace() && c != '"' && c != '\'');
            if plain { text.into_owned() } else { serde_json::to_string(&text).unwrap_or_default() }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parses, fills in and checks the query: the command must be one of `ALLOWED`.
pub fn prepare(req: &SourceQuery) -> Result<Command, SourceError> {
    let query: RedisQuery = req.parse()?;
    let words = words(query.command.trim())?;
    let Some(first) = words.first() else {
        return Err(rejected("redis.empty", "the command is empty"));
    };
    // The command's name is fixed text: a variable may never choose what runs.
    let name_word = |w: &Word| match w.pieces.as_slice() {
        [Piece::Text(t)] => Ok(String::from_utf8_lossy(t).to_ascii_uppercase()),
        _ => Err(rejected("redis.variable_in_command", "the command's name cannot hold a variable or macro")),
    };
    let mut name = name_word(first)?;
    if WITH_SUBCOMMAND.contains(&name.as_str()) {
        let sub = words.get(1).map(name_word).transpose()?.unwrap_or_default();
        name = format!("{name} {sub}");
    }
    let Some(shape) = ALLOWED.iter().find(|(n, _)| *n == name).map(|(_, s)| *s) else {
        if name == "KEYS" {
            return Err(rejected("redis.keys_refused", "KEYS blocks the server while it reads every key; use SCAN"));
        }
        return Err(rejected(
            "redis.command_not_allowed",
            format!("{name} is not allowed: data sources are read-only, and only commands that read are run"),
        )
        .with("name", name));
    };
    let mut args = Vec::new();
    for word in &words {
        args.extend(expand(word, &req.variables, req)?);
    }
    let command = Command { text: display(&args), args, name, shape };
    for (on, word) in REFUSED_ARGUMENTS {
        if command.name == *on && command.has_flag(word) {
            return Err(
                rejected("redis.argument_not_allowed", format!("{word} is not allowed with {on}")).with("name", *word)
            );
        }
    }
    Ok(command)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;

    fn req(command: &str, vars: Value) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({ "command": command }),
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 60_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 100, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
        }
    }

    fn args(command: &str, vars: Value) -> Vec<String> {
        prepare(&req(command, vars)).unwrap().args.iter().map(|a| String::from_utf8_lossy(a).into_owned()).collect()
    }

    fn reason(command: &str) -> &'static str {
        prepare(&req(command, json!({ "k": "x", "ks": ["a", "b"] }))).unwrap_err().detail().reason
    }

    #[test]
    fn words_split_like_redis_cli() {
        assert_eq!(args("hgetall   user:42 ", json!({})), ["hgetall", "user:42"]);
        assert_eq!(args(r#"GET "a b\"c\x41\n""#, json!({})), ["GET", "a b\"cA\n"]);
        assert_eq!(args(r"GET 'it\'s $k'", json!({})), ["GET", "it's $k"], "single quotes keep $ as text");
        assert_eq!(args(r#"JSON.GET doc $.name"#, json!({})), ["JSON.GET", "doc", "$.name"]);
        assert_eq!(args(r#"GET """#, json!({})), ["GET", ""]);
        assert_eq!(reason(r#"GET "open"#), "redis.unclosed_quote");
        assert_eq!(reason(r#"GET a"b""#), "redis.quote_inside_word");
        assert_eq!(reason(r#"GET "a"b"#), "redis.quote_inside_word");
        assert_eq!(reason("   "), "redis.empty");
    }

    #[test]
    fn variables_and_macros_fill_arguments_but_never_the_command() {
        let vars = json!({ "user": "42 OR\r\nFLUSHALL", "keys": ["k1", "k2"], "n": 5 });
        assert_eq!(args("HGET user:$user name", vars.clone()), ["HGET", "user:42 OR\r\nFLUSHALL", "name"]);
        assert_eq!(args("MGET $keys", vars.clone()), ["MGET", "k1", "k2"]);
        assert_eq!(args("LRANGE l 0 ${n}", vars.clone()), ["LRANGE", "l", "0", "5"]);
        assert_eq!(
            args("TS.RANGE t $__timeFrom $__timeTo AGGREGATION avg $__interval", json!({})),
            ["TS.RANGE", "t", "1800000000000", "1800003600000", "AGGREGATION", "avg", "60000"]
        );
        assert_eq!(reason("$k a"), "redis.variable_in_command");
        assert_eq!(reason("OBJECT $k a"), "redis.variable_in_command");
        assert_eq!(reason("GET x$ks"), "redis.variable_list_in_argument");
        assert_eq!(reason("GET $nope"), "redis.variable_missing");
        assert_eq!(reason("GET $__unknown"), "redis.macro_unknown");
        assert_eq!(reason("GET ${a-b}"), "redis.variable_name_invalid");
        assert_eq!(reason("GET ${open"), "redis.unclosed_variable");
        let bad = prepare(&req("GET $o", json!({ "o": { "a": 1 } }))).unwrap_err();
        assert_eq!(bad.detail().reason, "redis.variable_type");
    }

    #[test]
    fn only_commands_that_read_run() {
        for write in [
            "SET a 1",
            "DEL a",
            "FLUSHALL",
            "FLUSHDB",
            "CONFIG SET dir /tmp",
            "EVAL \"return 1\" 0",
            "EVAL_RO \"return 1\" 0",
            "FCALL_RO f 0",
            "SCRIPT LOAD x",
            "MULTI",
            "GETDEL a",
            "GETEX a EX 1",
            "SORT l STORE x",
            "ZRANGESTORE d s 0 -1",
            "GEOSEARCHSTORE d s FROMLONLAT 0 0 BYRADIUS 1 km",
            "BLPOP l 0",
            "XREAD BLOCK 0 STREAMS s $",
            "SUBSCRIBE c",
            "MONITOR",
            "CLIENT LIST",
            "CLIENT KILL ID 1",
            "OBJECT HELP",
            "MEMORY PURGE",
            "XINFO HELP",
            "JSON.SET d $ 1",
            "FT.CREATE i SCHEMA t TEXT",
            "TS.ADD t * 1",
            "MIGRATE h 1 k 0 1",
            "DEBUG SLEEP 10",
            "SHUTDOWN",
            "ACL SETUSER x on",
            "MODULE LOAD /x.so",
            "SELECT 1",
            "AUTH user pw",
        ] {
            let r = reason(write);
            assert_eq!(r, "redis.command_not_allowed", "{write}");
        }
        assert_eq!(reason("KEYS *"), "redis.keys_refused");
        assert_eq!(reason("FT.AGGREGATE idx * WITHCURSOR"), "redis.argument_not_allowed");
        for read in [
            "get a",
            "MGET a b",
            "object encoding a",
            "XINFO STREAM s",
            "ZRANGE z 0 -1 WITHSCORES",
            "JSON.GET d $",
            "FT.SEARCH idx \"@name:Graz\"",
            "TS.MRANGE - + FILTER area=nord",
            "SCAN 0 MATCH user:* COUNT 100",
            "INFO keyspace",
        ] {
            assert!(prepare(&req(read, json!({}))).is_ok(), "{read}");
        }
        let c = prepare(&req("zrange z 0 -1 withscores", json!({}))).unwrap();
        assert_eq!((c.name.as_str(), c.shape), ("ZRANGE", Shape::Scored));
        assert!(c.has_flag("WITHSCORES"));
        assert_eq!(c.text, "zrange z 0 -1 withscores");
        let c = prepare(&req("GET \"a b\"", json!({}))).unwrap();
        assert_eq!(c.text, "GET \"a b\"");
    }
}
