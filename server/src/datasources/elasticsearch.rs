//! Elasticsearch and OpenSearch over their HTTP API, through the one client factory
//! (`crate::http`), which checks every connection and redirect target.
//!
//! Read-only by construction: the plugin builds every URL itself from a fixed list of read
//! endpoints (`Endpoint`), and every URL is checked against that list again right before it is
//! sent, so no query can reach `_update_by_query`, `_delete_by_query`, `_bulk` or any other
//! endpoint. Index names are checked so they cannot add path segments. Query DSL is checked
//! before it is sent: a fixed set of top-level keys, and scripts only inline, in Painless or
//! Lucene expressions, never referring to `ctx` (the variable through which update and ingest
//! scripts change documents); stored scripts and `scripted_metric` are refused
//! (docs/api/datasources.md, "Elasticsearch and OpenSearch").
//!
//! Hits stay `documents`. Aggregations become a `frame` by the mapping in `aggs_to_rows`.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::Detail;
use super::frame::{Charge, Column, FrameBuilder, ResponseBudget};
use super::http_json::{basic_auth, header_value, parse_url, variable_name};
use super::json_documents::DocumentsBuilder;
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema, Table, TableColumn,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{FieldType, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.url", SettingType::String).target().required(),
    SettingField::new("basicAuthUser", "datasources.settings.basicAuthUser", SettingType::String).target(),
    SettingField::new("basicAuthPassword", "datasources.settings.basicAuthPassword", SettingType::String).secret(),
    SettingField::new("apiKey", "datasources.settings.apiKey", SettingType::String).secret(),
    SettingField::new("bearerToken", "datasources.settings.bearerToken", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    SettingField::new("index", "datasources.settings.index", SettingType::String),
    SettingField::new("timeField", "datasources.settings.timeField", SettingType::String)
        .default(DefaultValue::Text("@timestamp")),
];
/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Health and schema answers are read up to this size.
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Hits a query answers when it does not say.
const DEFAULT_SIZE: u64 = 500;
/// Elasticsearch's default `index.max_result_window`.
const MAX_WINDOW: u64 = 10_000;
/// `track_total_hits` counts at most this far (`true` means this).
pub const MAX_TRACK_TOTAL_HITS: u64 = 100_000;
/// Query text and DSL are refused beyond these sizes.
const MAX_QUERY_BYTES: usize = 256 * 1024;
const MAX_SCRIPT_BYTES: usize = 16 * 1024;
const MAX_DSL_DEPTH: usize = 64;
const MAX_SCHEMA_INDICES: usize = 1_000;
const MAX_SCHEMA_FIELDS: usize = 5_000;

/// The top-level keys a Query DSL body may have; everything else is refused.
const DSL_KEYS: &[&str] = &[
    "query",
    "aggs",
    "aggregations",
    "sort",
    "_source",
    "fields",
    "docvalue_fields",
    "stored_fields",
    "size",
    "from",
    "track_total_hits",
    "search_after",
    "highlight",
    "post_filter",
    "min_score",
    "script_fields",
    "runtime_mappings",
    "collapse",
    "terminate_after",
    "track_scores",
    "version",
    "seq_no_primary_term",
    "indices_boost",
    "rescore",
];

/// The aggregations that put documents into buckets; every other aggregation is a metric (or a
/// pipeline aggregation, which answers like one).
const BUCKET_AGGS: &[&str] = &[
    "adjacency_matrix",
    "auto_date_histogram",
    "categorize_text",
    "children",
    "composite",
    "date_histogram",
    "date_range",
    "diversified_sampler",
    "filter",
    "filters",
    "frequent_item_sets",
    "geo_distance",
    "geohash_grid",
    "geohex_grid",
    "geotile_grid",
    "global",
    "histogram",
    "ip_prefix",
    "ip_range",
    "missing",
    "multi_terms",
    "nested",
    "parent",
    "random_sampler",
    "range",
    "rare_terms",
    "reverse_nested",
    "sampler",
    "significant_terms",
    "significant_text",
    "terms",
    "time_series",
    "variable_width_histogram",
];
/// Bucket aggregations with one bucket and no key: they only narrow the documents.
const SINGLE_BUCKET_AGGS: &[&str] = &[
    "children",
    "diversified_sampler",
    "filter",
    "global",
    "missing",
    "nested",
    "parent",
    "random_sampler",
    "reverse_nested",
    "sampler",
];

pub fn kind() -> Kind {
    Kind {
        name: "Elasticsearch / OpenSearch",
        hint_key: "datasources.kinds.elasticsearch.hint",
        settings: SETTINGS,
        plugin: Arc::new(Elasticsearch),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    basic_auth_user: Option<String>,
    ca_cert: Option<String>,
    index: Option<String>,
    time_field: Option<String>,
}

/// `{"lucene": "status:500"}` or `{"dsl": {...}}`, with optional `index`, `timeField` and `size`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EsQuery {
    index: Option<String>,
    lucene: Option<String>,
    dsl: Option<Value>,
    time_field: Option<String>,
    size: Option<u64>,
}

pub struct Elasticsearch;

// ---- endpoints ----

/// The only requests Kalzit sends to a search cluster.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint<'a> {
    /// `GET /`: cluster name and version.
    Info,
    /// `POST /{index}/_search`
    Search(&'a str),
    /// `POST /{index}/_count`
    Count(&'a str),
    /// `GET /{index}/_mapping`
    Mapping(&'a str),
    /// `GET /{index}/_field_caps?fields=*`
    FieldCaps(&'a str),
    /// `GET /_cat/indices[/{index}]?format=json&h=index`
    CatIndices(Option<&'a str>),
}

/// The endpoints a URL may name below the source's base path: `""` (info), `_cat/indices`,
/// or one index pattern followed by one of these.
const INDEX_ENDPOINTS: &[&str] = &["_search", "_count", "_mapping", "_field_caps"];

impl Endpoint<'_> {
    fn method(self) -> Method {
        match self {
            Endpoint::Search(_) | Endpoint::Count(_) => Method::POST,
            _ => Method::GET,
        }
    }

    /// The URL below `base` (which ends with `/`).
    pub fn url(self, base: &Url) -> Result<Url, SourceError> {
        let mut url = base.clone();
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| SourceError::failed("settings.stored_invalid", "the stored URL cannot carry a path"))?;
            segments.pop_if_empty();
            match self {
                Endpoint::Info => {
                    segments.push("");
                }
                Endpoint::Search(i) => {
                    segments.push(i).push("_search");
                }
                Endpoint::Count(i) => {
                    segments.push(i).push("_count");
                }
                Endpoint::Mapping(i) => {
                    segments.push(i).push("_mapping");
                }
                Endpoint::FieldCaps(i) => {
                    segments.push(i).push("_field_caps");
                }
                Endpoint::CatIndices(i) => {
                    segments.push("_cat").push("indices");
                    if let Some(i) = i {
                        segments.push(i);
                    }
                }
            }
        }
        match self {
            Endpoint::CatIndices(_) => {
                url.query_pairs_mut().append_pair("format", "json").append_pair("h", "index");
            }
            Endpoint::FieldCaps(_) => {
                url.query_pairs_mut().append_pair("fields", "*");
            }
            _ => {}
        }
        check_endpoint(base, self.method(), &url)?;
        Ok(url)
    }
}

/// Refuses every URL that is not one of the read endpoints below `base`, whatever built it.
pub fn check_endpoint(base: &Url, method: Method, url: &Url) -> Result<(), SourceError> {
    let refused = || {
        SourceError::rejected(
            "elasticsearch.endpoint_not_allowed",
            format!("{method} {} is not a read endpoint", url.path()),
        )
        .with("path", url.path())
    };
    if url.origin() != base.origin() {
        return Err(refused());
    }
    let Some(rest) = url.path().strip_prefix(base.path()) else { return Err(refused()) };
    let segments: Vec<&str> = if rest.is_empty() { Vec::new() } else { rest.split('/').collect() };
    let get = method == Method::GET;
    // The query keys each endpoint may carry, each at most once: no `scroll`, `pipeline`,
    // `request_cache` or anything else Kalzit does not send itself.
    let (ok, query_keys): (bool, &[&str]) = match segments.as_slice() {
        [] | [""] => (get, &[]),
        ["_cat", "indices"] => (get, &["format", "h"]),
        ["_cat", "indices", index] => (get && check_index(&percent_decode(index)).is_ok(), &["format", "h"]),
        [index, endpoint] if INDEX_ENDPOINTS.contains(endpoint) => {
            let read_method = match *endpoint {
                "_search" | "_count" => get || method == Method::POST,
                _ => get,
            };
            let keys: &[&str] = if *endpoint == "_field_caps" { &["fields"] } else { &[] };
            (read_method && check_index(&percent_decode(index)).is_ok(), keys)
        }
        _ => (false, &[]),
    };
    let mut seen = Vec::new();
    let query_ok = url.query_pairs().all(|(k, _)| {
        let fresh = !seen.contains(&k);
        seen.push(k.clone());
        fresh && query_keys.contains(&k.as_ref())
    });
    if ok && query_ok && url.fragment().is_none() { Ok(()) } else { Err(refused()) }
}

/// Percent-decoding of one path segment; invalid escapes are kept as written.
fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// An index name or pattern list (`logs-*,metrics-2026.*,-logs-alt`): letters, digits and
/// `. _ - * :` per comma-separated part, no part starting with `_` or being `.` or `..`, so a
/// name can neither add a path segment nor name an endpoint. Date math (`<logs-{now/d}>`) is not
/// supported.
pub fn check_index(index: &str) -> Result<(), SourceError> {
    let refused = || {
        SourceError::rejected(
            "elasticsearch.index_invalid",
            "the index must be a name or pattern of letters, digits and . _ - * : (comma-separated)",
        )
        .with("index", index)
    };
    if index.is_empty() || index.len() > 1024 {
        return Err(refused());
    }
    for part in index.split(',') {
        let name = part.strip_prefix('-').unwrap_or(part);
        let valid_chars = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '*' | ':'));
        if name.is_empty() || !valid_chars || name.starts_with('_') || name == "." || name == ".." {
            return Err(refused());
        }
        // `cluster:index` names a remote cluster; the index part follows the same rule.
        if let Some((_, idx)) = name.split_once(':')
            && (idx.is_empty() || idx.starts_with('_') || idx.contains(':'))
        {
            return Err(refused());
        }
    }
    Ok(())
}

// ---- the query check ----

fn reject(reason: &'static str, message: impl Into<String>) -> SourceError {
    SourceError::rejected(reason, message)
}

/// Checks a Query DSL body before it is sent (see the module documentation).
pub fn check_dsl(dsl: &Value) -> Result<(), SourceError> {
    let Value::Object(map) = dsl else {
        return Err(reject("elasticsearch.dsl_not_object", "dsl must be a JSON object"));
    };
    if dsl.to_string().len() > MAX_QUERY_BYTES {
        return Err(reject("elasticsearch.query_too_large", "the query is too large"));
    }
    for key in map.keys() {
        if !DSL_KEYS.contains(&key.as_str()) {
            return Err(reject("elasticsearch.dsl_key_not_allowed", format!("{key} is not allowed in a search body"))
                .with("key", key));
        }
    }
    walk_dsl(dsl, 0)
}

/// The query inside a `wrapper` query: `{"query": "<base64 of JSON>"}`.
fn unwrap_query(wrapper: &Value) -> Result<Value, SourceError> {
    use base64::Engine as _;
    let invalid = || reject("elasticsearch.wrapper_invalid", "a wrapper query must hold a base64-encoded JSON query");
    let encoded = wrapper.get("query").and_then(Value::as_str).ok_or_else(invalid)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.trim()).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

fn walk_dsl(value: &Value, depth: usize) -> Result<(), SourceError> {
    if depth > MAX_DSL_DEPTH {
        return Err(reject("elasticsearch.dsl_too_deep", "the query is nested too deeply"));
    }
    match value {
        Value::Object(map) => {
            for (key, v) in map {
                if key == "scripted_metric" || key.ends_with("_script") {
                    return Err(reject(
                        "elasticsearch.script_not_allowed",
                        format!("{key} runs scripts that keep state and is not allowed"),
                    )
                    .with("context", key));
                }
                if key == "script" {
                    check_script(v)?;
                }
                if key == "wrapper" && v.is_object() {
                    // `wrapper` carries a whole query in base64; the check reads it too.
                    walk_dsl(&unwrap_query(v)?, depth + 1)?;
                }
                walk_dsl(v, depth + 1)?;
            }
            Ok(())
        }
        Value::Array(items) => items.iter().try_for_each(|v| walk_dsl(v, depth + 1)),
        _ => Ok(()),
    }
}

/// An inline script in Painless or Lucene expressions that does not use `ctx`.
fn check_script(script: &Value) -> Result<(), SourceError> {
    let (source, lang) = match script {
        Value::String(s) => (s.as_str(), None),
        // The `script` query wraps its script: `{"script": {"script": ...}}`; the walk checks the
        // inner one.
        Value::Object(map) if map.contains_key("script") && !map.contains_key("source") && !map.contains_key("id") => {
            return Ok(());
        }
        Value::Object(map) => {
            if map.contains_key("id") {
                return Err(reject(
                    "elasticsearch.stored_script",
                    "stored scripts are not allowed; write the script inline",
                ));
            }
            if let Some(key) = map.keys().find(|k| !matches!(k.as_str(), "source" | "lang" | "params" | "options")) {
                return Err(reject("elasticsearch.script_invalid", format!("{key} is not allowed in a script"))
                    .with("key", key));
            }
            let Some(source) = map.get("source").and_then(Value::as_str) else {
                return Err(
                    reject("elasticsearch.script_invalid", "a script needs its source as text").with("key", "source")
                );
            };
            (source, map.get("lang"))
        }
        // A field named `script` in a document query, not a script.
        _ => return Ok(()),
    };
    match lang {
        None => {}
        Some(Value::String(l)) if l == "painless" || l == "expression" => {}
        Some(other) => {
            let lang = other.as_str().unwrap_or("?").to_string();
            return Err(
                reject("elasticsearch.script_lang", format!("scripts in {lang} are not allowed")).with("lang", lang)
            );
        }
    }
    if source.len() > MAX_SCRIPT_BYTES {
        return Err(reject("elasticsearch.script_too_large", "the script is too large"));
    }
    if mentions_word(source, "ctx") {
        return Err(reject(
            "elasticsearch.script_writes",
            "the script uses ctx, through which scripts change documents; search scripts read through doc and params",
        ));
    }
    Ok(())
}

/// Whether `word` occurs in `text` as an identifier (not inside a longer name).
fn mentions_word(text: &str, word: &str) -> bool {
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    text.match_indices(word).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].chars().next();
        !before.is_some_and(ident) && !after.is_some_and(ident)
    })
}

/// At most one bucket aggregation per level, so every row is one path through the buckets.
fn check_aggs_shape(aggs: &Map<String, Value>, depth: usize) -> Result<(), SourceError> {
    if depth > MAX_DSL_DEPTH {
        return Err(reject("elasticsearch.dsl_too_deep", "the query is nested too deeply"));
    }
    let mut buckets = Vec::new();
    for (name, def) in aggs {
        let Some(def) = def.as_object() else {
            return Err(reject("elasticsearch.aggregation_invalid", format!("aggregation {name} must be an object"))
                .with("name", name));
        };
        let ty = agg_type(def).ok_or_else(|| {
            reject("elasticsearch.aggregation_invalid", format!("aggregation {name} has no type")).with("name", name)
        })?;
        if ty == "top_hits" {
            return Err(reject(
                "elasticsearch.aggregation_not_supported",
                format!("{ty} answers documents, not values; query the hits instead"),
            )
            .with("name", name)
            .with("type", ty));
        }
        if BUCKET_AGGS.contains(&ty) {
            buckets.push(name.as_str());
        }
        if let Some(sub) = sub_aggs(def) {
            check_aggs_shape(sub, depth + 1)?;
        }
    }
    if buckets.len() > 1 {
        let names = buckets.join(", ");
        return Err(reject(
            "elasticsearch.sibling_buckets",
            format!("only one bucket aggregation per level can become a table; found {names}"),
        )
        .with("names", names));
    }
    Ok(())
}

fn agg_type(def: &Map<String, Value>) -> Option<&str> {
    def.keys().map(String::as_str).find(|k| !matches!(*k, "aggs" | "aggregations" | "meta"))
}

fn sub_aggs(def: &Map<String, Value>) -> Option<&Map<String, Value>> {
    def.get("aggs").or_else(|| def.get("aggregations")).and_then(Value::as_object)
}

// ---- variables and macros ----

fn variable_value<'a>(name: &str, vars: &'a BTreeMap<String, Value>) -> Result<&'a Value, SourceError> {
    let value = vars.get(name).ok_or_else(|| {
        reject("elasticsearch.variable_missing", format!("variable {name} has no value")).with("name", name)
    })?;
    let scalar = |v: &Value| matches!(v, Value::String(_) | Value::Number(_) | Value::Bool(_));
    let ok = match value {
        Value::Array(items) => items.iter().all(scalar),
        v => scalar(v),
    };
    if !ok {
        return Err(reject(
            "elasticsearch.variable_type",
            format!("variable {name} must be a string, number, boolean or a list of them"),
        )
        .with("name", name));
    }
    Ok(value)
}

fn macro_value(name: &str, req: &SourceQuery) -> Result<Value, SourceError> {
    Ok(match name {
        "__timeFrom" => json!(req.range.from),
        "__timeTo" => json!(req.range.to),
        "__interval" => json!(super::sql::format_interval(req.interval_ms.max(1) as i64)),
        "__interval_ms" => json!(req.interval_ms),
        other => {
            return Err(reject("elasticsearch.macro_unknown", format!("unknown macro ${other}")).with("name", other));
        }
    })
}

/// Replaces every DSL string that is exactly `$name` (or `${name}`) with the variable's JSON
/// value, and the macros `$__timeFrom`, `$__timeTo` (Unix ms), `$__interval` (`30s`) and
/// `$__interval_ms`. Values are placed as JSON values, never spliced into text.
fn substitute(value: &mut Value, req: &SourceQuery) -> Result<(), SourceError> {
    match value {
        Value::String(s) => {
            if let Some(name) = variable_name(s) {
                *value = match name.strip_prefix("__") {
                    Some(_) => macro_value(name, req)?,
                    None => variable_value(name, &req.variables)?.clone(),
                };
            }
            Ok(())
        }
        Value::Array(items) => items.iter_mut().try_for_each(|v| substitute(v, req)),
        Value::Object(map) => map.values_mut().try_for_each(|v| substitute(v, req)),
        _ => Ok(()),
    }
}

fn phrase_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn scalar_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Expands `$name` in a Lucene query: outside a phrase into a quoted phrase (a list into
/// `("a" OR "b")`), inside a phrase into the escaped text. `$__timeFrom` and `$__timeTo` become
/// Unix milliseconds.
fn expand_lucene(text: &str, req: &SourceQuery) -> Result<String, SourceError> {
    let mut out = String::with_capacity(text.len());
    let mut in_phrase = false;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' => {
                out.push(c);
                if let Some((_, next)) = chars.next() {
                    out.push(next);
                }
                continue;
            }
            '"' => {
                in_phrase = !in_phrase;
                out.push(c);
                continue;
            }
            '$' => {}
            _ => {
                out.push(c);
                continue;
            }
        }
        let rest = &text[i + 1..];
        let (name, len) = if let Some(inner) = rest.strip_prefix('{') {
            match inner.find('}') {
                Some(end) => (&inner[..end], end + 2),
                None => {
                    out.push(c);
                    continue;
                }
            }
        } else {
            let len = rest.find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).unwrap_or(rest.len());
            (&rest[..len], len)
        };
        if name.is_empty() || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            out.push(c);
            continue;
        }
        for _ in 0..len {
            chars.next();
        }
        if name.starts_with("__") {
            match name {
                "__timeFrom" | "__timeTo" => out.push_str(&scalar_text(&macro_value(name, req)?)),
                other => {
                    return Err(
                        reject("elasticsearch.macro_unknown", format!("unknown macro ${other}")).with("name", other)
                    );
                }
            }
            continue;
        }
        let value = variable_value(name, &req.variables)?;
        match (value, in_phrase) {
            (Value::Array(_), true) => {
                return Err(reject(
                    "elasticsearch.variable_list_in_phrase",
                    format!("variable {name} is a list and cannot go inside a quoted phrase"),
                )
                .with("name", name));
            }
            (Value::Array(items), false) => {
                let parts: Vec<String> =
                    items.iter().map(|v| format!("\"{}\"", phrase_escape(&scalar_text(v)))).collect();
                if parts.is_empty() {
                    out.push_str("\"\"");
                } else {
                    out.push_str(&format!("({})", parts.join(" OR ")));
                }
            }
            (v, true) => out.push_str(&phrase_escape(&scalar_text(v))),
            (v, false) => out.push_str(&format!("\"{}\"", phrase_escape(&scalar_text(v)))),
        }
    }
    Ok(out)
}

// ---- the search body ----

struct Search {
    index: String,
    body: Value,
    /// The answer is the aggregation frame (the query had aggregations).
    aggs: Option<Map<String, Value>>,
}

fn build_search(q: EsQuery, s: &Settings, req: &SourceQuery) -> Result<Search, SourceError> {
    let index = q.index.or_else(|| s.index.clone()).filter(|i| !i.trim().is_empty()).ok_or_else(|| {
        reject("elasticsearch.index_missing", "name an index in the query or in the data source's settings")
    })?;
    check_index(&index)?;
    let time_field = q.time_field.or_else(|| s.time_field.clone()).unwrap_or_else(|| "@timestamp".into());
    let (mut body, user_query) = match (q.lucene, q.dsl) {
        (Some(_), Some(_)) => {
            return Err(reject("elasticsearch.query_form", "send either lucene or dsl, not both"));
        }
        (Some(text), None) => {
            if text.len() > MAX_QUERY_BYTES {
                return Err(reject("elasticsearch.query_too_large", "the query is too large"));
            }
            let expanded = expand_lucene(&text, req)?;
            let query = if expanded.trim().is_empty() {
                json!({ "match_all": {} })
            } else {
                json!({ "query_string": { "query": expanded } })
            };
            (Map::new(), query)
        }
        (None, Some(mut dsl)) => {
            substitute(&mut dsl, req)?;
            check_dsl(&dsl)?;
            let Value::Object(mut map) = dsl else { unreachable!("check_dsl accepts only objects") };
            let query = map.remove("query").unwrap_or_else(|| json!({ "match_all": {} }));
            (map, query)
        }
        (None, None) => (Map::new(), json!({ "match_all": {} })),
    };
    let mut filter = Vec::new();
    if !time_field.trim().is_empty() {
        filter.push(json!({ "range": { time_field: {
            "gte": req.range.from, "lte": req.range.to, "format": "epoch_millis" } } }));
    }
    body.insert("query".into(), json!({ "bool": { "must": [user_query], "filter": filter } }));
    let aggs = match body.remove("aggregations").or_else(|| body.remove("aggs")) {
        Some(Value::Object(a)) => {
            check_aggs_shape(&a, 0)?;
            body.insert("aggs".into(), Value::Object(a.clone()));
            Some(a)
        }
        Some(_) => return Err(reject("elasticsearch.aggregation_invalid", "aggs must be an object")),
        None => None,
    };
    let max = (req.limits.max_rows as u64).min(MAX_WINDOW);
    let size = if aggs.is_some() {
        0
    } else {
        body.get("size").and_then(Value::as_u64).or(q.size).unwrap_or(DEFAULT_SIZE).min(max)
    };
    body.insert("size".into(), json!(size));
    let total = match body.get("track_total_hits") {
        Some(Value::Bool(false)) => json!(false),
        Some(Value::Number(n)) => json!(n.as_u64().unwrap_or(0).min(MAX_TRACK_TOTAL_HITS)),
        Some(Value::Bool(true)) => json!(MAX_TRACK_TOTAL_HITS),
        Some(_) => {
            return Err(reject("elasticsearch.track_total_hits", "track_total_hits must be true, false or a number"));
        }
        None => json!(MAX_WINDOW),
    };
    body.insert("track_total_hits".into(), total);
    body.insert("timeout".into(), json!(format!("{}s", req.limits.timeout.as_secs().max(1))));
    Ok(Search { index, body: Value::Object(body), aggs })
}

// ---- aggregations to a frame ----

/// One output column: its type, or `None` for a bucket key typed by its values.
struct Columns {
    order: Vec<String>,
    types: HashMap<String, Option<FieldType>>,
}

impl Columns {
    fn add(&mut self, name: &str, ty: Option<FieldType>) {
        if !self.types.contains_key(name) {
            self.order.push(name.to_string());
            self.types.insert(name.to_string(), ty);
        }
    }
}

struct Rows {
    columns: Columns,
    rows: Vec<Vec<(String, Value)>>,
    max: usize,
    skipped: Vec<String>,
}

/// The aggregation answer as rows (docs/api/datasources.md, "Aggregations"): each row is one
/// path from the top through the bucket aggregations to a deepest bucket.
///
/// - A bucket aggregation adds a column named like it with the bucket's key: Unix ms (`time`)
///   for `date_histogram` and `auto_date_histogram`, otherwise `key_as_string` when the server
///   sends one, else `key`; such a column is `number` when all its keys are numbers, otherwise
///   `string`. `composite` adds one column per source (`name.source`); keyed buckets (`filters`,
///   `keyed: true`) use the bucket's name. Single-bucket aggregations (`filter`, `nested`, ...)
///   add no column.
/// - The deepest bucket adds `doc_count`.
/// - A metric aggregation adds a `number` column named like it from `value`; multi-value metrics
///   add `name.key` per value (`percentiles`: `name.95.0`) or per numeric field (`stats`:
///   `name.avg`, ...). A metric at an outer level repeats on every row below it.
/// - Without any bucket aggregation the answer is one row of metrics.
fn aggs_to_rows(req_aggs: &Map<String, Value>, resp: &Map<String, Value>, max: usize) -> Rows {
    let mut rows = Rows {
        columns: Columns { order: Vec::new(), types: HashMap::new() },
        rows: Vec::new(),
        max,
        skipped: Vec::new(),
    };
    walk_level(req_aggs, resp, Vec::new(), &mut rows, false);
    rows
}

fn walk_level(
    req: &Map<String, Value>,
    resp: &Map<String, Value>,
    mut prefix: Vec<(String, Value)>,
    out: &mut Rows,
    in_bucket: bool,
) {
    if out.rows.len() > out.max {
        return;
    }
    let mut bucket: Option<(&String, &Map<String, Value>, &str)> = None;
    for (name, def) in req {
        let Some(def) = def.as_object() else { continue };
        let Some(ty) = agg_type(def) else { continue };
        if BUCKET_AGGS.contains(&ty) {
            bucket = Some((name, def, ty));
            continue;
        }
        let Some(value) = resp.get(name) else { continue };
        let metrics = metric_values(name, value);
        if metrics.is_empty() {
            if !out.skipped.contains(name) {
                out.skipped.push(name.clone());
            }
            continue;
        }
        for (column, v) in metrics {
            out.columns.add(&column, Some(FieldType::Number));
            prefix.push((column, v));
        }
    }
    let Some((name, def, ty)) = bucket else {
        if in_bucket && let Some(count) = resp.get("doc_count") {
            out.columns.add("doc_count", Some(FieldType::Number));
            prefix.push(("doc_count".into(), count.clone()));
        }
        out.rows.push(prefix);
        return;
    };
    let sub = sub_aggs(def).cloned().unwrap_or_default();
    let Some(answer) = resp.get(name).and_then(Value::as_object) else { return };
    if SINGLE_BUCKET_AGGS.contains(&ty) {
        walk_level(&sub, answer, prefix, out, true);
        return;
    }
    let buckets: Vec<(Option<String>, &Map<String, Value>)> = match answer.get("buckets") {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).map(|b| (None, b)).collect(),
        Some(Value::Object(keyed)) => {
            keyed.iter().filter_map(|(k, b)| b.as_object().map(|b| (Some(k.clone()), b))).collect()
        }
        _ => Vec::new(),
    };
    for (keyed_name, b) in buckets {
        if out.rows.len() > out.max {
            return;
        }
        let mut row = prefix.clone();
        for (column, v, ty) in bucket_keys(name, ty, keyed_name, b) {
            out.columns.add(&column, ty);
            row.push((column, v));
        }
        walk_level(&sub, b, row, out, true);
    }
}

/// The key columns one bucket adds.
fn bucket_keys(
    name: &str,
    ty: &str,
    keyed_name: Option<String>,
    b: &Map<String, Value>,
) -> Vec<(String, Value, Option<FieldType>)> {
    if let Some(k) = keyed_name {
        return vec![(name.to_string(), Value::String(k), Some(FieldType::String))];
    }
    match ty {
        "date_histogram" | "auto_date_histogram" => {
            vec![(
                name.to_string(),
                b.get("key").filter(|k| k.is_number()).cloned().unwrap_or(Value::Null),
                Some(FieldType::Time),
            )]
        }
        "composite" => b
            .get("key")
            .and_then(Value::as_object)
            .map(|k| k.iter().map(|(src, v)| (format!("{name}.{src}"), v.clone(), None)).collect())
            .unwrap_or_default(),
        _ => {
            let key = match (b.get("key_as_string"), b.get("key")) {
                (Some(Value::String(s)), _) => Value::String(s.clone()),
                (_, Some(k @ (Value::String(_) | Value::Number(_)))) => k.clone(),
                (_, Some(other)) => Value::String(other.to_string()),
                _ => Value::Null,
            };
            vec![(name.to_string(), key, None)]
        }
    }
}

/// The values a metric aggregation answers, as `(column, number or null)`.
fn metric_values(name: &str, v: &Value) -> Vec<(String, Value)> {
    let number = |v: &Value| if v.is_number() || v.is_null() { Some(v.clone()) } else { None };
    let Some(obj) = v.as_object() else { return Vec::new() };
    if obj.contains_key("buckets") || obj.contains_key("hits") || obj.contains_key("top") {
        return Vec::new();
    }
    if let Some(value) = obj.get("value") {
        return number(value).map(|v| vec![(name.to_string(), v)]).unwrap_or_default();
    }
    match obj.get("values") {
        Some(Value::Object(values)) => {
            return values.iter().filter_map(|(k, v)| number(v).map(|v| (format!("{name}.{k}"), v))).collect();
        }
        Some(Value::Array(items)) => {
            return items
                .iter()
                .filter_map(|i| Some((format!("{name}.{}", scalar_text(i.get("key")?)), number(i.get("value")?)?)))
                .collect();
        }
        _ => {}
    }
    let mut out = Vec::new();
    for (field, value) in obj {
        if field.ends_with("_as_string") || field == "meta" {
            continue;
        }
        match value {
            Value::Object(inner) => {
                for (sub, v) in inner {
                    if let Some(v) = number(v) {
                        out.push((format!("{name}.{field}.{sub}"), v));
                    }
                }
            }
            v => {
                if let Some(v) = number(v) {
                    out.push((format!("{name}.{field}"), v));
                }
            }
        }
    }
    out
}

/// The rows as a frame: key columns typed by their values, cut at the limits.
fn rows_to_frame(rows: Rows, max_rows: usize, budget: ResponseBudget) -> FrameBuilder {
    let Rows { columns, rows, skipped, .. } = rows;
    let types: Vec<FieldType> = columns
        .order
        .iter()
        .map(|c| match columns.types[c] {
            Some(t) => t,
            None => {
                let all_numbers = rows
                    .iter()
                    .flat_map(|r| r.iter().filter(|(n, _)| n == c))
                    .all(|(_, v)| v.is_number() || v.is_null());
                if all_numbers { FieldType::Number } else { FieldType::String }
            }
        })
        .collect();
    let frame_columns = columns.order.iter().zip(&types).map(|(n, t)| Column::new(n.clone(), Some(*t))).collect();
    let mut frame = FrameBuilder::new(frame_columns, max_rows, budget);
    for row in rows {
        let map: HashMap<String, Value> = row.into_iter().collect();
        let values = columns
            .order
            .iter()
            .zip(&types)
            .map(|(c, t)| match (map.get(c), t) {
                (Some(Value::Number(n)), FieldType::String) => Value::String(n.to_string()),
                (Some(v), _) => v.clone(),
                (None, _) => Value::Null,
            })
            .collect();
        if !frame.push_row(values) {
            break;
        }
    }
    for name in skipped {
        frame.notice(
            NoticeSeverity::Info,
            Detail::new(
                "elasticsearch.aggregation_skipped",
                format!("aggregation {name} answers no numbers and is left out"),
            )
            .with("name", name),
        );
    }
    frame
}

// ---- the client ----

struct Client {
    http: HttpClient,
    base: Url,
    headers: HeaderMap,
    basic_token: Option<String>,
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let mut base = parse_url(&s.url, false).map_err(SourceError::Failed)?;
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        let http = crate::http::client(HttpOptions {
            timeout: CLIENT_TIMEOUT,
            extra_root_pem: s.ca_cert,
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::Failed(e.detail()))?;
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        let invalid = "elasticsearch.credentials_invalid";
        let mut basic_token = None;
        if let Some(user) = s.basic_auth_user.filter(|u| !u.is_empty()) {
            let (value, token) = basic_auth(&user, conn.secret("basicAuthPassword").unwrap_or(""));
            headers.insert(AUTHORIZATION, header_value(&value, invalid)?);
            basic_token = Some(token);
        } else if let Some(key) = conn.secret("apiKey") {
            headers.insert(AUTHORIZATION, header_value(&format!("ApiKey {key}"), invalid)?);
        } else if let Some(token) = conn.secret("bearerToken") {
            headers.insert(AUTHORIZATION, header_value(&format!("Bearer {token}"), invalid)?);
        }
        Ok(Client { http, base, headers, basic_token })
    })
    .await
}

impl Client {
    fn scrub(&self, text: &str) -> String {
        match &self.basic_token {
            Some(t) => text.replace(t, "***"),
            None => text.to_string(),
        }
    }

    fn failed(&self, e: HttpError) -> SourceError {
        match e {
            HttpError::Blocked(b) => SourceError::Blocked(b.0),
            // A redirect to anything but a read endpoint.
            HttpError::Refused(d) => SourceError::Rejected(d),
            other => SourceError::Failed(other.detail().scrubbed(|t| self.scrub(t))),
        }
    }

    /// Sends one request to a read endpoint and answers the JSON, or the server's error. With
    /// a charge, the body is charged to the request's budget as it arrives.
    async fn call(
        &self,
        endpoint: Endpoint<'_>,
        body: Option<&Value>,
        max_bytes: usize,
        charge: Option<&mut Charge>,
    ) -> Result<Value, SourceError> {
        let url = endpoint.url(&self.base)?;
        let mut headers = self.headers.clone();
        let body = body.map(|b| {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            b.to_string().into_bytes()
        });
        // Every hop, redirects included, must be a read endpoint below the base URL.
        let base = &self.base;
        let hop = |m: &Method, u: &Url| check_endpoint(base, m.clone(), u).map_err(|e| e.detail());
        let response = self
            .http
            .send_checked(endpoint.method(), url, headers, body, Some(&hop))
            .await
            .map_err(|e| self.failed(e))?;
        let status = response.status();
        let bytes = match charge {
            Some(charge) => crate::http::read_counted(response, max_bytes, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max_bytes).await,
        }
        .map_err(|e| self.failed(e))?;
        let parsed: Option<Value> = serde_json::from_slice(&bytes).ok();
        if !status.is_success() {
            let message = parsed.as_ref().and_then(error_reason).map(|m| self.scrub(&m));
            return Err(match message {
                Some(m) => SourceError::failed("elasticsearch.error", format!("the server answered {status}: {m}"))
                    .with("status", status.as_u16())
                    .with("detail", m),
                None => not_an_api_response(status),
            });
        }
        parsed.ok_or_else(|| not_an_api_response(status))
    }
}

fn not_an_api_response(status: reqwest::StatusCode) -> SourceError {
    SourceError::failed(
        "elasticsearch.not_an_api_response",
        format!("the server answered {status} without a search API response"),
    )
    .with("status", status.as_u16())
}

/// The reason in an error answer: `error.root_cause[0].reason`, `error.reason`, or `error`.
fn error_reason(v: &Value) -> Option<String> {
    let error = v.get("error")?;
    if let Some(s) = error.as_str() {
        return Some(s.to_string());
    }
    let root = error.get("root_cause").and_then(|r| r.get(0)).and_then(|r| r.get("reason")).and_then(Value::as_str);
    let reason = root.or_else(|| error.get("reason").and_then(Value::as_str))?;
    let ty = error.get("type").and_then(Value::as_str);
    Some(match ty {
        Some(t) => format!("{t}: {reason}"),
        None => reason.to_string(),
    })
}

/// Field paths and types of a mapping's `properties`; objects add their fields, multi-fields
/// add `name.sub`.
fn mapping_fields(props: &Map<String, Value>, prefix: &str, out: &mut Vec<TableColumn>) {
    for (name, def) in props {
        if out.len() >= MAX_SCHEMA_FIELDS {
            return;
        }
        let path = if prefix.is_empty() { name.clone() } else { format!("{prefix}.{name}") };
        let ty = def.get("type").and_then(Value::as_str);
        if let Some(inner) = def.get("properties").and_then(Value::as_object) {
            if let Some(t) = ty {
                out.push(TableColumn { name: path.clone(), data_type: t.to_string() });
            }
            mapping_fields(inner, &path, out);
        } else {
            out.push(TableColumn { name: path.clone(), data_type: ty.unwrap_or("object").to_string() });
        }
        if let Some(multi) = def.get("fields").and_then(Value::as_object) {
            mapping_fields(multi, &path, out);
        }
    }
}

fn engine_of(info: &Value) -> (&'static str, String) {
    let version = info["version"]["number"].as_str().unwrap_or("").to_string();
    let engine = if info["version"]["distribution"] == "opensearch" { "OpenSearch" } else { "Elasticsearch" };
    (engine, version)
}

#[async_trait::async_trait]
impl DataSourcePlugin for Elasticsearch {
    fn kind(&self) -> &'static str {
        "elasticsearch"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Documents, Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url, false).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if let Some(index) = s.index.as_deref().filter(|i| !i.is_empty())
            && let Err(e) = check_index(index)
        {
            return Err(FieldError { field: "index", detail: e.detail().with("field", "index") });
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            match c.call(Endpoint::Info, None, MAX_SMALL_RESPONSE, None).await {
                Ok(info) => {
                    let (engine, version) = engine_of(&info);
                    Ok(Health::connected(engine, &version, false))
                }
                // A login that may only read indices cannot read the cluster info; a count on
                // the default index shows that searching works.
                Err(SourceError::Failed(d)) if d.params.get("status").is_some_and(|s| s == "403") => {
                    let s: Settings = conn.settings_as()?;
                    let Some(index) = s.index.filter(|i| !i.is_empty()) else { return Err(SourceError::Failed(d)) };
                    check_index(&index)?;
                    c.call(Endpoint::Count(&index), Some(&json!({})), MAX_SMALL_RESPONSE, None).await?;
                    Ok(Health {
                        ok: true,
                        code: None,
                        detail: Detail::new(
                            "health.search_answered",
                            "the search API answered; the login may not read the cluster version",
                        ),
                    })
                }
                Err(e) => Err(e),
            }
        };
        match check.await {
            Ok(h) => h,
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let s: Settings = conn.settings_as()?;
        let pattern = s.index.filter(|i| !i.is_empty());
        if let Some(p) = &pattern {
            check_index(p)?;
        }
        let listed = c.call(Endpoint::CatIndices(pattern.as_deref()), None, MAX_SMALL_RESPONSE, None).await?;
        let mut names: Vec<String> = listed
            .as_array()
            .map(|a| {
                a.iter().filter_map(|i| i["index"].as_str().map(String::from)).filter(|n| !n.starts_with('.')).collect()
            })
            .unwrap_or_default();
        names.sort();
        names.truncate(MAX_SCHEMA_INDICES);
        let mappings =
            c.call(Endpoint::Mapping(pattern.as_deref().unwrap_or("*")), None, MAX_SMALL_RESPONSE, None).await?;
        let indices = names
            .into_iter()
            .map(|name| {
                let mut columns = Vec::new();
                if let Some(props) = mappings[&name]["mappings"]["properties"].as_object() {
                    mapping_fields(props, "", &mut columns);
                }
                Table { schema: None, name, columns }
            })
            .collect();
        Ok(SourceSchema::Indices { indices })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: EsQuery = req.parse()?;
        let s: Settings = conn.settings_as()?;
        let search = build_search(q, &s, &req)?;
        let c = client(conn).await?;
        let budget = req.limits.budget.clone();
        let mut charge = budget.charge();
        let mut answer =
            c.call(Endpoint::Search(&search.index), Some(&search.body), budget.remaining(), Some(&mut charge)).await?;
        let result = match &search.aggs {
            Some(req_aggs) => {
                let empty = Map::new();
                let resp = answer.get("aggregations").and_then(Value::as_object).unwrap_or(&empty);
                let rows = aggs_to_rows(req_aggs, resp, req.limits.max_rows);
                let mut frame = rows_to_frame(rows, req.limits.max_rows, budget.clone());
                frame.executed_query(search.body.to_string());
                if answer["timed_out"] == true {
                    frame.notice(
                        NoticeSeverity::Warning,
                        Detail::new("elasticsearch.timed_out", "the search timed out; the result may be incomplete"),
                    );
                }
                if let Some(failed) = answer["_shards"]["failed"].as_u64().filter(|f| *f > 0) {
                    frame.notice(
                        NoticeSeverity::Warning,
                        Detail::new(
                            "elasticsearch.shard_failures",
                            format!("{failed} shards failed; the result may be incomplete"),
                        )
                        .with("count", failed),
                    );
                }
                QueryResult::Frame { frame: frame.finish() }
            }
            None => {
                // The hits move into the documents, so the raw answer's charge is given back
                // first and the documents are charged as they are added.
                let hits = match answer.pointer_mut("/hits/hits").map(Value::take) {
                    Some(Value::Array(h)) => h,
                    _ => Vec::new(),
                };
                drop(answer);
                drop(charge);
                let mut docs = DocumentsBuilder::new(req.limits.max_rows, budget.clone());
                for hit in hits {
                    if !docs.push(hit) {
                        break;
                    }
                }
                QueryResult::Documents { documents: docs.finish() }
            }
        };
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::json_documents::test_connection;
    use crate::datasources::targets::TargetPolicy;
    use crate::shapes::TimeRange;
    use axum::Router;
    use axum::response::IntoResponse;

    fn req(query: Value, variables: Value) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query,
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 30_000,
            max_data_points: None,
            variables: serde_json::from_value(variables).unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
        }
    }

    fn settings() -> Settings {
        Settings {
            url: "http://es:9200".into(),
            basic_auth_user: None,
            ca_cert: None,
            index: Some("logs-*".into()),
            time_field: None,
        }
    }

    fn build(query: Value) -> Result<Search, SourceError> {
        let r = req(query.clone(), json!({ "land": "Öster\"reich", "ids": [1, 2], "obj": { "script": "x" } }));
        build_search(serde_json::from_value(query).unwrap(), &settings(), &r)
    }

    fn reason(r: Result<Search, SourceError>) -> &'static str {
        match r {
            Ok(_) => "accepted",
            Err(e) => e.detail().reason,
        }
    }

    #[test]
    fn only_read_endpoints_are_reachable() {
        let base = Url::parse("http://es.intern:9200/proxy/").unwrap();
        let path = |e: Endpoint| e.url(&base).unwrap().to_string();
        assert_eq!(path(Endpoint::Info), "http://es.intern:9200/proxy/");
        assert_eq!(path(Endpoint::Search("logs-*")), "http://es.intern:9200/proxy/logs-*/_search");
        assert_eq!(path(Endpoint::Count("a,b")), "http://es.intern:9200/proxy/a,b/_count");
        assert_eq!(path(Endpoint::Mapping("x")), "http://es.intern:9200/proxy/x/_mapping");
        assert_eq!(path(Endpoint::FieldCaps("x")), "http://es.intern:9200/proxy/x/_field_caps?fields=*");
        assert_eq!(path(Endpoint::CatIndices(None)), "http://es.intern:9200/proxy/_cat/indices?format=json&h=index");
        // Index names cannot name an endpoint or add a path.
        for bad in [
            "x/_delete_by_query",
            "_update_by_query",
            "..",
            "x/../_bulk",
            "_all",
            "a b",
            "x?y",
            "%2e%2e",
            "logs-{now/d}",
            "x,_delete_by_query",
        ] {
            assert!(Endpoint::Search(bad).url(&base).is_err(), "{bad}");
            assert_eq!(check_index(bad).unwrap_err().detail().reason, "elasticsearch.index_invalid", "{bad}");
        }
        // Whatever builds a URL, only the read endpoints pass the final check.
        let check = |m: Method, p: &str| check_endpoint(&base, m, &base.join(p).unwrap()).is_ok();
        assert!(check(Method::POST, "logs/_search"));
        assert!(check(Method::GET, "logs/_mapping"));
        assert!(check(Method::GET, "_cat/indices"));
        for (m, p) in [
            (Method::POST, "logs/_update_by_query"),
            (Method::POST, "logs/_delete_by_query"),
            (Method::POST, "_bulk"),
            (Method::POST, "logs/_doc"),
            (Method::PUT, "logs"),
            (Method::DELETE, "logs/_search"),
            (Method::POST, "logs/_mapping"),
            (Method::POST, "_search/scroll"),
            (Method::GET, "_cluster/settings"),
            (Method::POST, "_scripts/x"),
            (Method::GET, "_cat/indices/_all"),
            (Method::POST, "logs/_search/template"),
        ] {
            assert!(!check(m.clone(), p), "{m} {p}");
        }
        let other = Url::parse("http://anders:9200/proxy/logs/_search").unwrap();
        assert!(check_endpoint(&base, Method::POST, &other).is_err(), "another origin");
        let outside = Url::parse("http://es.intern:9200/logs/_search").unwrap();
        assert!(check_endpoint(&base, Method::POST, &outside).is_err(), "outside the base path");
    }

    #[test]
    fn scripts_are_refused_unless_read_only() {
        let ok = |q: Value| assert_eq!(reason(build(json!({ "dsl": q }))), "accepted");
        let bad = |q: Value| reason(build(json!({ "dsl": q })));
        ok(
            json!({ "query": { "script": { "script": { "source": "doc['n'].value > params.x", "params": { "x": 1 } } } } }),
        );
        ok(json!({ "script_fields": { "doppelt": { "script": "doc['n'].value * 2" } } }));
        ok(
            json!({ "runtime_mappings": { "t": { "type": "long", "script": { "source": "emit(doc['n'].value)", "lang": "painless" } } } }),
        );
        ok(json!({ "query": { "term": { "script": "ein Feld namens script" } } }));
        ok(json!({ "aggs": { "s": { "sum": { "script": { "source": "doc['n'].value", "lang": "expression" } } } } }));
        assert_eq!(
            bad(json!({ "query": { "script": { "script": "ctx._source.n = 1" } } })),
            "elasticsearch.script_writes"
        );
        assert_eq!(
            bad(json!({ "script_fields": { "x": { "script": { "source": "ctx.op = 'delete'" } } } })),
            "elasticsearch.script_writes"
        );
        assert_eq!(
            bad(json!({ "query": { "script": { "script": { "id": "gespeichert" } } } })),
            "elasticsearch.stored_script"
        );
        assert_eq!(
            bad(json!({ "query": { "script": { "script": { "source": "1", "lang": "mustache" } } } })),
            "elasticsearch.script_lang"
        );
        assert_eq!(
            bad(json!({ "query": { "script": { "script": { "source": "1", "file": "x" } } } })),
            "elasticsearch.script_invalid"
        );
        assert_eq!(
            bad(
                json!({ "aggs": { "m": { "scripted_metric": { "init_script": "state.x = []", "map_script": "1", "combine_script": "1", "reduce_script": "1" } } } })
            ),
            "elasticsearch.script_not_allowed"
        );
        assert_eq!(bad(json!({ "script": { "source": "ctx._source.x = 1" } })), "elasticsearch.dsl_key_not_allowed");
        assert_eq!(bad(json!({ "pit": { "id": "x" } })), "elasticsearch.dsl_key_not_allowed");
        assert_eq!(bad(json!({ "aggs": { "h": { "top_hits": {} } } })), "elasticsearch.aggregation_not_supported");
        assert_eq!(
            bad(json!({ "aggs": { "a": { "terms": { "field": "x" } }, "b": { "terms": { "field": "y" } } } })),
            "elasticsearch.sibling_buckets"
        );
        assert!(mentions_word("x + ctx.y", "ctx") && !mentions_word("myctx + ctx2", "ctx"));
        // A variable cannot bring a script in: objects are not variable values.
        assert_eq!(bad(json!({ "query": { "bool": { "filter": "$obj" } } })), "elasticsearch.variable_type");
        let mut deep = json!(1);
        for _ in 0..80 {
            deep = json!({ "bool": { "must": [deep] } });
        }
        assert_eq!(bad(json!({ "query": deep })), "elasticsearch.dsl_too_deep");
    }

    #[test]
    fn bodies_keep_the_limits_and_the_time_filter() {
        let s = build(json!({ "lucene": "land:$land AND name:\"x $land\"", "size": 50_000 })).unwrap();
        assert_eq!(s.index, "logs-*");
        assert_eq!(
            s.body["query"]["bool"]["must"][0]["query_string"]["query"],
            "land:\"Öster\\\"reich\" AND name:\"x Öster\\\"reich\""
        );
        let range = &s.body["query"]["bool"]["filter"][0]["range"]["@timestamp"];
        assert_eq!((range["gte"].as_i64(), range["lte"].as_i64()), (Some(1_800_000_000_000), Some(1_800_003_600_000)));
        assert_eq!(s.body["size"], 1000, "clamped to the row limit");
        assert_eq!(s.body["track_total_hits"], MAX_WINDOW);
        assert_eq!(s.body["timeout"], "5s");

        let s = build(json!({ "dsl": { "track_total_hits": true, "query": { "terms": { "id": "$ids" } } }, "index": "andere", "timeField": "" })).unwrap();
        assert_eq!(s.index, "andere");
        assert_eq!(s.body["track_total_hits"], MAX_TRACK_TOTAL_HITS);
        assert_eq!(s.body["query"]["bool"]["must"][0]["terms"]["id"], json!([1, 2]));
        assert_eq!(s.body["query"]["bool"]["filter"], json!([]), "an empty time field means no filter");
        let s = build(json!({ "dsl": { "track_total_hits": 10_000_000 } })).unwrap();
        assert_eq!(s.body["track_total_hits"], MAX_TRACK_TOTAL_HITS);
        let s = build(json!({ "dsl": { "size": 10, "aggs": { "t": { "date_histogram": { "field": "@timestamp", "fixed_interval": "$__interval" } } } } })).unwrap();
        assert_eq!(s.body["size"], 0, "aggregations answer a frame, not hits");
        assert_eq!(s.body["aggs"]["t"]["date_histogram"]["fixed_interval"], "30s");

        assert_eq!(reason(build(json!({ "lucene": "a", "dsl": {} }))), "elasticsearch.query_form");
        assert_eq!(reason(build(json!({ "lucene": "$fehlt" }))), "elasticsearch.variable_missing");
        assert_eq!(reason(build(json!({ "lucene": "\"$ids\"" }))), "elasticsearch.variable_list_in_phrase");
        assert_eq!(reason(build(json!({ "lucene": "x", "index": "_all" }))), "elasticsearch.index_invalid");
        assert_eq!(reason(build(json!({ "dsl": { "query": "$__wer" } }))), "elasticsearch.macro_unknown");
        let s = build(json!({ "lucene": "id:$ids OR preis:\\$5" })).unwrap();
        assert_eq!(s.body["query"]["bool"]["must"][0]["query_string"]["query"], "id:(\"1\" OR \"2\") OR preis:\\$5");
    }

    #[test]
    fn aggregations_map_to_a_frame() {
        let req_aggs = json!({
            "zeit": { "date_histogram": { "field": "@timestamp", "fixed_interval": "1h" }, "aggs": {
                "land": { "terms": { "field": "land" }, "aggs": {
                    "summe": { "sum": { "field": "betrag" } },
                    "p": { "percentiles": { "field": "betrag", "percents": [50, 95] } }
                } },
                "schnitt": { "avg": { "field": "betrag" } }
            } }
        });
        let resp = json!({
            "zeit": { "buckets": [
                { "key": 1_800_000_000_000_i64, "key_as_string": "2027-01-15T08:00:00Z", "doc_count": 3,
                  "schnitt": { "value": 5.0 },
                  "land": { "buckets": [
                      { "key": "AT", "doc_count": 2, "summe": { "value": 10.0 }, "p": { "values": { "50.0": 4.0, "95.0": 6.0 } } },
                      { "key": "CH", "doc_count": 1, "summe": { "value": 5.0 }, "p": { "values": { "50.0": null, "95.0": null } } }
                  ] } },
                { "key": 1_800_003_600_000_i64, "doc_count": 0, "schnitt": { "value": null }, "land": { "buckets": [] } }
            ] }
        });
        let rows = aggs_to_rows(req_aggs.as_object().unwrap(), resp.as_object().unwrap(), 100);
        let frame = rows_to_frame(rows, 100, ResponseBudget::new(1 << 20)).finish();
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        // Aggregations at one level come in name order (JSON objects are kept sorted).
        assert_eq!(names, ["zeit", "schnitt", "land", "p.50.0", "p.95.0", "summe", "doc_count"]);
        let types: Vec<FieldType> = frame.fields().iter().map(|f| f.field_type).collect();
        assert_eq!(types[0], FieldType::Time);
        assert_eq!(types[2], FieldType::String);
        assert!(types[3..].iter().all(|t| *t == FieldType::Number));
        assert_eq!(frame.rows(), 2, "an hour without buckets below has no row");
        let f = frame.fields();
        assert_eq!(f[0].values, [json!(1_800_000_000_000_i64), json!(1_800_000_000_000_i64)]);
        assert_eq!(f[1].values, [json!(5.0), json!(5.0)], "an outer metric repeats");
        assert_eq!(f[2].values, [json!("AT"), json!("CH")]);
        assert_eq!(f[3].values, [json!(4.0), Value::Null]);
        assert_eq!(f[5].values, [json!(10.0), json!(5.0)]);
        assert_eq!(f[6].values, [json!(2), json!(1)]);
    }

    #[test]
    fn other_aggregation_forms_map_too() {
        // Only metrics: one row.
        let req_aggs = json!({ "n": { "value_count": { "field": "x" } }, "s": { "stats": { "field": "x" } } });
        let resp = json!({ "n": { "value": 7 }, "s": { "count": 7, "min": 1.0, "max": 3.0, "avg": 2.0, "sum": 14.0 } });
        let frame = rows_to_frame(
            aggs_to_rows(req_aggs.as_object().unwrap(), resp.as_object().unwrap(), 10),
            10,
            ResponseBudget::new(1 << 20),
        )
        .finish();
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["n", "s.avg", "s.count", "s.max", "s.min", "s.sum"]);
        assert_eq!(frame.rows(), 1);

        // Keyed filters, a numeric histogram, composite sources, a single-bucket filter.
        let req_aggs = json!({
            "nur_at": { "filter": { "term": { "land": "AT" } }, "aggs": {
                "art": { "filters": { "filters": { "fehler": {}, "ok": {} } }, "aggs": {
                    "h": { "histogram": { "field": "dauer", "interval": 10 } } } } } }
        });
        let resp = json!({ "nur_at": { "doc_count": 5, "art": { "buckets": {
            "fehler": { "doc_count": 2, "h": { "buckets": [{ "key": 0.0, "doc_count": 2 }] } },
            "ok": { "doc_count": 3, "h": { "buckets": [{ "key": 10.0, "doc_count": 3 }] } }
        } } } });
        let frame = rows_to_frame(
            aggs_to_rows(req_aggs.as_object().unwrap(), resp.as_object().unwrap(), 10),
            10,
            ResponseBudget::new(1 << 20),
        )
        .finish();
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["art", "h", "doc_count"]);
        assert_eq!(frame.fields()[0].values, [json!("fehler"), json!("ok")]);
        assert_eq!(frame.fields()[1].field_type, FieldType::Number);

        let req_aggs = json!({ "c": { "composite": { "sources": [] } } });
        let resp = json!({ "c": { "buckets": [{ "key": { "land": "AT", "jahr": 2026 }, "doc_count": 4 }, { "key": { "land": "CH", "jahr": "x" }, "doc_count": 1 }] } });
        let frame = rows_to_frame(
            aggs_to_rows(req_aggs.as_object().unwrap(), resp.as_object().unwrap(), 10),
            10,
            ResponseBudget::new(1 << 20),
        )
        .finish();
        let f = frame.fields();
        assert_eq!(f.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["c.jahr", "c.land", "doc_count"]);
        assert_eq!(f[0].field_type, FieldType::String, "mixed keys are text");
        assert_eq!(f[0].values, [json!("2026"), json!("x")]);

        // The row limit cuts with a notice; a metric without numbers is left out with one.
        let req_aggs = json!({ "t": { "terms": { "field": "x" } }, "g": { "geo_bounds": { "field": "ort" } } });
        let buckets: Vec<Value> = (0..20).map(|i| json!({ "key": i, "doc_count": 1 })).collect();
        let resp = json!({ "t": { "buckets": buckets }, "g": { "bounds": { "top_left": "x" } } });
        let frame = rows_to_frame(
            aggs_to_rows(req_aggs.as_object().unwrap(), resp.as_object().unwrap(), 5),
            5,
            ResponseBudget::new(1 << 20),
        )
        .finish();
        assert_eq!(frame.rows(), 5);
        let codes: Vec<&str> = frame.meta().unwrap().notices.iter().map(|n| n.code.as_str()).collect();
        assert!(
            codes.contains(&"frame.row_limit") && codes.contains(&"elasticsearch.aggregation_skipped"),
            "{codes:?}"
        );
    }

    #[test]
    fn settings_are_checked() {
        assert!(Elasticsearch.check_settings(&json!({ "url": "https://es.intern:9200", "index": "logs-*" })).is_ok());
        let field = |v: Value| Elasticsearch.check_settings(&v).unwrap_err().field;
        assert_eq!(field(json!({ "url": "https://elastic:pw@es.intern" })), "url");
        assert_eq!(field(json!({ "url": "https://es.intern/?x=1" })), "url");
        assert_eq!(field(json!({ "url": "https://es.intern", "index": "a/_delete_by_query" })), "index");
        let mut props = Vec::new();
        mapping_fields(
            json!({ "land": { "type": "keyword" }, "name": { "type": "text", "fields": { "raw": { "type": "keyword" } } },
                    "kunde": { "properties": { "id": { "type": "long" } } } })
            .as_object()
            .unwrap(),
            "",
            &mut props,
        );
        let names: Vec<String> = props.iter().map(|c| format!("{}:{}", c.name, c.data_type)).collect();
        assert_eq!(names, ["kunde.id:long", "land:keyword", "name:text", "name.raw:keyword"]);
    }

    /// A fake search server: answers what a cluster would and records the requests.
    async fn fake_cluster(seen: Arc<std::sync::Mutex<Vec<String>>>) -> std::net::SocketAddr {
        let app = Router::new().fallback(move |method: Method, uri: axum::http::Uri, headers: axum::http::HeaderMap, body: String| {
            let seen = seen.clone();
            async move {
                let auth = headers.get(AUTHORIZATION).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
                seen.lock().unwrap().push(format!("{method} {uri} {auth}"));
                let path = uri.path();
                let answer = if path == "/" {
                    json!({ "cluster_name": "c", "version": { "number": "2.19.1", "distribution": "opensearch" } })
                } else if path.ends_with("/_search") {
                    let body: Value = serde_json::from_str(&body).unwrap();
                    if body.get("aggs").is_some() {
                        json!({ "hits": { "hits": [] }, "aggregations": { "land": { "buckets": [{ "key": "AT", "doc_count": 2 }] } } })
                    } else {
                        json!({ "timed_out": false, "hits": { "total": { "value": 2 }, "hits": [
                            { "_index": "logs-1", "_id": "1", "_score": 1.0, "_source": { "land": "AT" } },
                            { "_index": "logs-1", "_id": "2", "_score": 1.0, "_source": { "land": "CH" } }
                        ] } })
                    }
                } else if path.starts_with("/_cat/indices") {
                    json!([{ "index": "logs-1" }, { "index": ".hidden" }])
                } else if path.ends_with("/_mapping") {
                    json!({ "logs-1": { "mappings": { "properties": { "land": { "type": "keyword" } } } } })
                } else {
                    return (axum::http::StatusCode::BAD_REQUEST, axum::Json(json!({ "error": { "type": "x", "reason": "nein" } }))).into_response();
                };
                axum::Json(answer).into_response()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        addr
    }

    #[tokio::test]
    async fn queries_health_and_schema_through_the_client_factory() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let addr = fake_cluster(seen.clone()).await;
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let conn = test_connection(
            json!({ "url": format!("http://{addr}"), "index": "logs-*" }),
            &[("apiKey", "schluessel")],
            policy,
        )
        .await;
        let h = Elasticsearch.health(&conn).await;
        assert!(h.ok, "{h:?}");
        assert_eq!((h.detail.params["engine"].as_str(), h.detail.params["version"].as_str()), ("OpenSearch", "2.19.1"));

        let r = Elasticsearch.query(&conn, req(json!({ "lucene": "land:AT" }), json!({}))).await.unwrap();
        let QueryResult::Documents { documents } = r else { panic!("documents") };
        assert_eq!(documents.documents.len(), 2);
        assert_eq!(documents.documents[0]["_source"]["land"], "AT");
        assert!(documents.schema.iter().any(|f| f.path == "_source.land"));

        let r = Elasticsearch
            .query(&conn, req(json!({ "dsl": { "aggs": { "land": { "terms": { "field": "land" } } } } }), json!({})))
            .await
            .unwrap();
        let QueryResult::Frame { frame } = r else { panic!("frame") };
        assert_eq!(frame.fields()[0].values, [json!("AT")]);
        assert!(frame.meta().unwrap().executed_query.as_deref().unwrap().contains("\"aggs\""));

        let SourceSchema::Indices { indices } = Elasticsearch.schema(&conn).await.unwrap() else { panic!("indices") };
        assert_eq!(indices.len(), 1, "hidden indices are left out");
        assert_eq!(indices[0].columns[0].name, "land");

        let seen = seen.lock().unwrap().clone();
        assert!(seen.iter().all(|r| r.ends_with("ApiKey schluessel")), "{seen:?}");
        assert!(seen.iter().any(|r| r.starts_with("POST /logs-*/_search")), "{seen:?}");
        assert!(seen.iter().all(|r| !r.contains("_by_query")), "{seen:?}");
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::datasources::json_documents::test_connection;
    use crate::datasources::targets::TargetPolicy;
    use crate::shapes::TimeRange;
    use axum::Router;
    use axum::response::IntoResponse;
    use base64::Engine as _;

    fn req(query: Value) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query,
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 30_000,
            max_data_points: None,
            variables: BTreeMap::new(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows: 1000, budget: ResponseBudget::new(1 << 20) },
        }
    }

    fn settings() -> Settings {
        Settings {
            url: "http://es:9200".into(),
            basic_auth_user: None,
            ca_cert: None,
            index: Some("logs".into()),
            time_field: None,
        }
    }

    fn reason(query: Value) -> &'static str {
        match build_search(serde_json::from_value(query.clone()).unwrap(), &settings(), &req(query)) {
            Ok(_) => "accepted",
            Err(e) => e.detail().reason,
        }
    }

    /// A cluster behind a proxy (or a compromised one) answers the search with a 307 to
    /// `_delete_by_query` on the same origin. The client follows it with method, body and
    /// Authorization, and the endpoint list is never asked.
    #[tokio::test]
    async fn redirects_cannot_reach_write_endpoints() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let app =
            Router::new().fallback(move |method: Method, uri: axum::http::Uri, headers: axum::http::HeaderMap| {
                let log = log.clone();
                async move {
                    let auth = headers.get(AUTHORIZATION).map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
                    log.lock().unwrap().push(format!("{method} {} {auth}", uri.path()));
                    if uri.path().ends_with("/_search") {
                        return (
                            axum::http::StatusCode::TEMPORARY_REDIRECT,
                            [(axum::http::header::LOCATION, "/logs/_delete_by_query?conflicts=proceed")],
                        )
                            .into_response();
                    }
                    axum::Json(json!({ "deleted": 42, "hits": { "hits": [] } })).into_response()
                }
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let policy = TargetPolicy::new(&std::env::temp_dir().join("kalzit-none"), "sqlite::memory:", &[], &[]);
        let conn =
            test_connection(json!({ "url": format!("http://{addr}"), "index": "logs" }), &[("apiKey", "k")], policy)
                .await;
        let r = Elasticsearch.query(&conn, req(json!({ "lucene": "*" }))).await;
        let seen = seen.lock().unwrap().clone();
        assert!(seen.iter().all(|r| !r.contains("_by_query")), "a write endpoint was reached: {seen:?}");
        let e = r.expect_err("the redirect is refused");
        assert_eq!((e.code(), e.detail().reason), ("query_rejected", "elasticsearch.endpoint_not_allowed"));
    }

    /// `wrapper` carries a base64-encoded query that the DSL check never sees: stored scripts
    /// and `ctx` pass inside it.
    #[test]
    fn wrapper_queries_do_not_hide_scripts() {
        let inner = json!({ "script": { "script": { "id": "gespeichert" } } }).to_string();
        let b64 = base64::engine::general_purpose::STANDARD.encode(inner);
        assert_eq!(
            reason(json!({ "dsl": { "query": { "wrapper": { "query": b64 } } } })),
            "elasticsearch.stored_script"
        );
    }

    #[test]
    fn known_script_and_index_bypasses_are_refused() {
        let cases = [
            (json!({ "dsl": { "sort": { "_script": { "type": "number", "script": "1" } } } }), "script_not_allowed"),
            (
                json!({ "dsl": { "query": { "function_score": { "script_score": { "script": "ctx._source.x = 1" } } } } }),
                "script_writes",
            ),
            (
                json!({ "dsl": { "query": { "script": { "script": { "source": "ctx /* c */ ._source" } } } } }),
                "script_writes",
            ),
            (json!({ "dsl": { "query": { "script": { "script": { "id": "x" } } } } }), "stored_script"),
            (
                json!({ "dsl": { "runtime_mappings": { "f": { "type": "long", "script": { "source": "emit(1)", "lang": "mustache" } } } } }),
                "script_lang",
            ),
            (json!({ "dsl": { "aggs": { "a": { "scripted_metric": {} } } } }), "script_not_allowed"),
            (
                json!({ "dsl": { "aggs": { "h": { "date_histogram": { "field": "t" }, "aggs": { "b": { "bucket_script": {} } } } } } }),
                "script_not_allowed",
            ),
            (
                json!({ "dsl": { "script_fields": { "f": { "script": { "source": "1", "inline": "ctx" } } } } }),
                "script_invalid",
            ),
            (json!({ "dsl": { "pit": { "id": "x" } } }), "dsl_key_not_allowed"),
            (json!({ "dsl": { "timeout": "1h" } }), "dsl_key_not_allowed"),
            (json!({ "index": "a/b" }), "index_invalid"),
            (json!({ "index": ".." }), "index_invalid"),
            (json!({ "index": "a%2Fb" }), "index_invalid"),
            (json!({ "index": "_all" }), "index_invalid"),
            (json!({ "index": "logs,_all" }), "index_invalid"),
            (json!({ "index": "<logs-{now/d}>" }), "index_invalid"),
            (json!({ "index": "logs?pipeline=x" }), "index_invalid"),
            (json!({ "index": "c:_doc" }), "index_invalid"),
        ];
        let mut wrong = Vec::new();
        for (q, want) in cases {
            let got = reason(q.clone());
            if got != format!("elasticsearch.{want}") {
                wrong.push(format!("{q} -> {got} (wanted {want})"));
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// The final URL check looks at the path only; a query string passes it.
    #[test]
    fn the_endpoint_check_covers_the_query_string() {
        let base = Url::parse("http://es:9200/").unwrap();
        let mut wrong = Vec::new();
        for (m, p) in [
            (Method::POST, "logs/_search?scroll=1m"),
            (Method::POST, "logs/_search?pre_filter_shard_size=1&request_cache=false"),
            (Method::GET, "logs/_mapping?pipeline=x"),
            (Method::POST, "_msearch"),
            (Method::POST, "logs/_search/template"),
            (Method::POST, "_sql"),
            (Method::POST, "logs/_eql/search"),
            (Method::POST, "logs/_update_by_query"),
            (Method::PUT, "logs/_search"),
            (Method::DELETE, "logs/_search"),
            (Method::POST, "logs/_mapping"),
            (Method::POST, "_cat/indices"),
            (Method::POST, "logs/_search/../_delete_by_query"),
            (Method::POST, "%6cogs/_search%2F..%2F_bulk"),
        ] {
            let url = base.join(p).unwrap();
            if check_endpoint(&base, m.clone(), &url).is_ok() {
                wrong.push(format!("{m} {url}"));
            }
        }
        assert!(wrong.is_empty(), "accepted: {wrong:#?}");
    }
}
