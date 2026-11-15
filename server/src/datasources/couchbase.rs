//! Couchbase Server 7.x over the query service's REST API (`POST /query/service`, usually port
//! 8093 or 18093), through `json_api.rs`. Queries are SQL++ (N1QL) `SELECT` statements
//! (`{"sqlpp": "..."}`), with dashboard variables and macros sent as named parameters (`$name`),
//! never as text in the statement.
//!
//! Three things keep a source read-only:
//!
//! 1. The statement, checked by `sqlpp.rs` before anything is sent: one `SELECT`, no word that
//!    starts a writing, schema, rights or transaction statement.
//! 2. Every statement is sent with `readonly: true`, so the query service itself refuses one that
//!    would write (error 1000), whatever the check missed.
//! 3. The login: Kalzit reads the user's roles (`system:my_user_info`) when it sets up the
//!    connection and in Test connection, and refuses a user with any role beyond reading
//!    (`READ_ROLES`), or whose roles it cannot read, unless a data source admin set
//!    `allowWriteCapableUser` (needed where the edition offers no reading roles).
//!
//! Results are `documents`, one per result row (values that are not objects as `{"value": ...}`).

use std::collections::BTreeSet;
use std::sync::Arc;

use reqwest::Method;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::document_schema::SchemaSampler;
use super::json_api::{self, JsonApi, Reasons};
use super::json_documents::DocumentsBuilder;
use super::mongodb::{CollectionSchema, IndexKey, IndexSchema};
use super::{
    Connection, DataSourcePlugin, DefaultValue, Detail, FieldError, Health, Kind, SettingField, SettingType,
    SourceError, SourceQuery, SourceSchema,
};
use crate::shapes::{QueryResult, Shape};

pub mod sqlpp;

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.queryServiceUrl", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    // Deciding that only the statement check and the read-only request protect the data is an
    // admin's decision, so the field is a target field.
    SettingField::new("allowWriteCapableUser", "datasources.settings.allowWriteCapableUser", SettingType::Bool)
        .target()
        .default(DefaultValue::Bool(false)),
    SettingField::new("bucket", "datasources.settings.bucket", SettingType::String),
];

const REASONS: Reasons = Reasons {
    engine: "Couchbase",
    redirect: "couchbase.redirect_refused",
    credentials: "couchbase.credentials_invalid",
};
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Collections whose documents are sampled for the schema.
const SAMPLED_COLLECTIONS: usize = 50;
const SAMPLE_DOCUMENTS: usize = 20;
const MAX_COLLECTIONS: usize = 1_000;
/// The query service's error for a write in a read-only request.
const READONLY_VIOLATION: i64 = 1000;
/// The query service's error for a statement the user has no rights for.
const INSUFFICIENT_RIGHTS: i64 = 13014;

/// Roles that only read: data, the query catalog, statistics and settings.
const READ_ROLES: &[&str] = &[
    "query_select",
    "query_system_catalog",
    "data_reader",
    "data_monitoring",
    "ro_admin",
    "ro_security_admin",
    "analytics_reader",
    "analytics_select",
    "fts_searcher",
    "views_reader",
    "external_stats_reader",
];

pub fn kind() -> Kind {
    Kind {
        name: "Couchbase",
        hint_key: "datasources.kinds.couchbase.hint",
        settings: SETTINGS,
        plugin: Arc::new(Couchbase),
    }
}

pub struct Couchbase;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    user: Option<String>,
    ca_cert: Option<String>,
    allow_write_capable_user: Option<bool>,
    bucket: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SqlppQuery {
    sqlpp: String,
}

struct Client {
    api: JsonApi,
    allow_write: bool,
}

/// A bucket, scope or collection name: letters, digits, `_`, `-`, `%` and, in buckets, `.`.
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 251
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'%' | b'.'))
}

fn quoted(name: &str) -> String {
    format!("`{name}`")
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let api = JsonApi::new(conn, &s.url, s.user.as_deref(), s.ca_cert.clone(), REASONS)?;
        let c = Client { api, allow_write: s.allow_write_capable_user.unwrap_or(false) };
        c.checked_roles().await?;
        Ok(c)
    })
    .await
}

impl Client {
    /// Runs one statement with `readonly: true` and answers its results, reading at most
    /// `max` bytes (charged to the budget's `charge` when given).
    async fn statement(
        &self,
        statement: &str,
        params: Map<String, Value>,
        timeout_ms: u128,
        max: usize,
        charge: Option<&mut super::frame::Charge>,
    ) -> Result<Vec<Value>, SourceError> {
        let mut body = json!({
            "statement": statement,
            "readonly": true,
            "timeout": format!("{}ms", timeout_ms.max(1)),
        });
        for (k, v) in params {
            body[format!("${k}")] = v;
        }
        let url = self.api.url(&["query", "service"])?;
        let a = self.api.send(Method::POST, url, Some(&body), max, charge).await?;
        let parsed: Option<Value> = serde_json::from_slice(&a.body).ok();
        // The query service answers 401 both for a refused login and for missing rights on a
        // keyspace (error 13014); only the first is a refused login.
        let missing_rights = parsed
            .as_ref()
            .and_then(|p| p.get("errors")?.as_array()?.first()?.get("code")?.as_i64())
            .is_some_and(|code| code == INSUFFICIENT_RIGHTS);
        if !missing_rights && let Some(e) = self.api.unauthorized(&a) {
            return Err(e);
        }
        let mut answer = parsed.ok_or_else(|| {
            SourceError::failed(
                "couchbase.not_an_api_response",
                format!("the server answered {} without a Couchbase query service response", a.status),
            )
            .with("status", a.status.as_u16())
        })?;
        let failed = answer.get("status").and_then(Value::as_str).is_some_and(|s| s != "success");
        if let Some(first) = answer.get("errors").and_then(Value::as_array).and_then(|e| e.first())
            && (failed || !a.status.is_success())
        {
            let code = first.get("code").and_then(Value::as_i64).unwrap_or(0);
            let msg = self.api.scrub(first.get("msg").and_then(Value::as_str).unwrap_or("unknown error").trim());
            if code == READONLY_VIOLATION {
                return Err(SourceError::Rejected(
                    Detail::new(
                        "couchbase.readonly_violation",
                        format!("Couchbase refused the statement in a read-only request: {msg}"),
                    )
                    .with("detail", msg),
                ));
            }
            return Err(SourceError::failed(
                "couchbase.error",
                format!("Couchbase answered {} (error {code}): {msg}", a.status),
            )
            .with("status", a.status.as_u16())
            .with("detail", format!("{code}: {msg}")));
        }
        if !a.status.is_success() || failed {
            return Err(SourceError::failed(
                "couchbase.error",
                format!("Couchbase answered {} without results", a.status),
            )
            .with("status", a.status.as_u16())
            .with("detail", a.status.to_string()));
        }
        match answer.get_mut("results").map(Value::take) {
            Some(Value::Array(items)) => Ok(items),
            _ => Ok(Vec::new()),
        }
    }

    async fn small(&self, statement: &str, params: Map<String, Value>) -> Result<Vec<Value>, SourceError> {
        self.statement(statement, params, 30_000, MAX_SMALL_RESPONSE, None).await
    }

    /// The roles beyond reading, or the refusal (see the module documentation).
    async fn checked_roles(&self) -> Result<Vec<String>, SourceError> {
        let roles = match self.small("SELECT RAW u.roles FROM system:my_user_info AS u", Map::new()).await {
            Ok(r) => Some(roles_from(&r)).filter(|r| !r.is_empty()),
            // A login that may not read its own roles (or a server without the keyspace).
            Err(SourceError::Failed(d)) if d.reason == "couchbase.error" => None,
            Err(e) => return Err(e),
        };
        let writes = match roles {
            Some(roles) => roles.into_iter().filter(|r| !READ_ROLES.contains(&r.as_str())).collect::<Vec<_>>(),
            None if self.allow_write => return Ok(vec!["unknown".to_string()]),
            None => {
                return Err(SourceError::failed(
                    "couchbase.privileges_unverifiable",
                    "cannot read the Couchbase user's roles, so Kalzit cannot check that it only reads",
                ));
            }
        };
        if writes.is_empty() || self.allow_write {
            return Ok(writes);
        }
        let list = writes.join(", ");
        Err(SourceError::failed(
            "couchbase.user_can_write",
            format!("the Couchbase user has roles beyond reading ({list}); use a user with only query_select and data_reader"),
        )
        .with("privileges", list))
    }
}

/// The role names in `system:my_user_info`'s roles, sorted and once each.
fn roles_from(results: &[Value]) -> Vec<String> {
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            Value::Object(m) => {
                if let Some(r) = m.get("role").and_then(Value::as_str) {
                    out.push(r.to_string());
                }
                m.values().filter(|x| x.is_array() || x.is_object()).for_each(|x| walk(x, out));
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    results.iter().for_each(|r| walk(r, &mut out));
    out.sort();
    out.dedup();
    out
}

/// The named parameters the statement uses: macros (`$__timeFrom`, `$__timeTo` in Unix ms,
/// `$__interval_ms`) and dashboard variables.
fn parameters(checked: &sqlpp::Checked, req: &SourceQuery) -> Result<Map<String, Value>, SourceError> {
    let mut out = Map::new();
    for name in &checked.params {
        let value = match name.as_str() {
            "__timeFrom" => json!(req.range.from),
            "__timeTo" => json!(req.range.to),
            "__interval_ms" => json!(req.interval_ms),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("couchbase.macro_unknown", format!("unknown macro ${m}")).with("name", m)
                );
            }
            var => req.variables.get(var).cloned().ok_or_else(|| {
                SourceError::rejected("couchbase.variable_missing", format!("variable {var} has no value"))
                    .with("name", var)
            })?,
        };
        out.insert(name.clone(), value);
    }
    Ok(out)
}

/// `bucket.scope.collection` of one row of `system:keyspaces`: a collection names its bucket and
/// scope; a row without them is a bucket, which stands for its default collection.
fn keyspace(row: &Value) -> Option<(String, String, String)> {
    let get = |k: &str| row.get(k).and_then(Value::as_str).filter(|s| is_name(s)).map(String::from);
    match (get("b"), get("s")) {
        (Some(b), Some(s)) => Some((b, s, get("c")?)),
        (None, None) => Some((get("c")?, "_default".into(), "_default".into())),
        _ => None,
    }
}

/// The keyspaces of `rows`, each once, in order.
fn keyspaces(rows: &[Value]) -> Vec<(String, String, String)> {
    let mut seen = BTreeSet::new();
    rows.iter().filter_map(keyspace).filter(|k| seen.insert(k.clone())).collect()
}

#[async_trait::async_trait]
impl DataSourcePlugin for Couchbase {
    fn kind(&self) -> &'static str {
        "couchbase"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Documents]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        json_api::parse_base_url(&s.url).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if let Some(b) = s.bucket.as_deref().filter(|b| !b.is_empty())
            && !is_name(b)
        {
            return Err(FieldError::new(
                "bucket",
                "settings.name_invalid",
                "the bucket name has letters, digits and _ - % . only",
            ));
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            let version = c
                .small("SELECT RAW ds_version()", Map::new())
                .await?
                .first()
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // The cached client checked the user when it was built; Test connection checks again.
            let writes = c.checked_roles().await?;
            Ok::<_, SourceError>((version, writes))
        };
        match check.await {
            Ok((full, writes)) => {
                // `7.6.2-3721-community`: the version, the build, the edition.
                let mut parts = full.splitn(3, '-');
                let version = parts.next().unwrap_or("").to_string();
                let edition = parts.nth(1).unwrap_or("").to_string();
                let mut h = if writes.is_empty() {
                    Health::connected("Couchbase", &version, false)
                } else {
                    let list = writes.join(", ");
                    Health {
                        ok: true,
                        code: None,
                        detail: Detail::new(
                            "health.connected_write_capable",
                            format!(
                                "Couchbase {version}; the user may write ({list}), so only Kalzit's statement check and the read-only request keep queries read-only"
                            ),
                        )
                        .with("engine", "Couchbase")
                        .with("version", &version)
                        .with("privileges", &list),
                        warnings: Vec::new(),
                    }
                };
                if !edition.is_empty() {
                    h.detail = h.detail.with("edition", edition);
                }
                h
            }
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let s: Settings = conn.settings_as()?;
        let bucket = s.bucket.filter(|b| !b.is_empty());
        let mut params = Map::new();
        // Collections name their bucket and scope; a bucket's own row stands for its default
        // collection (the only one on a bucket without scopes).
        let mut statement =
            "SELECT k.`bucket` AS b, k.`scope` AS s, k.name AS c FROM system:keyspaces AS k".to_string();
        if let Some(b) = &bucket {
            statement.push_str(" WHERE k.`bucket` = $bucket OR (k.`bucket` IS MISSING AND k.name = $bucket)");
            params.insert("bucket".into(), json!(b));
        }
        statement.push_str(&format!(" ORDER BY b, s, c LIMIT {MAX_COLLECTIONS}"));
        let rows = c.small(&statement, params).await?;
        let indexes = c
            .small(
                "SELECT i.name, i.index_key, i.is_primary, i.bucket_id, i.scope_id, i.keyspace_id \
                 FROM system:indexes AS i",
                Map::new(),
            )
            .await
            .unwrap_or_default();
        let mut collections = Vec::new();
        for (n, row) in keyspaces(&rows).into_iter().enumerate() {
            let (b, sc, col) = row;
            let name = format!("{b}.{sc}.{col}");
            let mut sampler = SchemaSampler::default();
            if n < SAMPLED_COLLECTIONS {
                let statement = format!(
                    "SELECT RAW d FROM {}.{}.{} AS d LIMIT {SAMPLE_DOCUMENTS}",
                    quoted(&b),
                    quoted(&sc),
                    quoted(&col)
                );
                // A collection without an index to scan has no sample.
                if let Ok(docs) = c.small(&statement, Map::new()).await {
                    docs.iter().for_each(|d| sampler.add(d));
                }
            }
            let sampled = sampler.len() as u32;
            let own = |i: &&Value| {
                let field = |k: &str| i.get(k).and_then(Value::as_str);
                // Indexes of a named collection name the bucket in `bucket_id`; those of a
                // bucket's default collection only in `keyspace_id`.
                match field("bucket_id") {
                    Some(bucket_id) => {
                        bucket_id == b
                            && field("scope_id") == Some(sc.as_str())
                            && field("keyspace_id") == Some(col.as_str())
                    }
                    None => field("keyspace_id") == Some(b.as_str()) && sc == "_default" && col == "_default",
                }
            };
            let index_schemas = indexes
                .iter()
                .filter(own)
                .filter_map(|i| {
                    let name = i.get("name")?.as_str()?.to_string();
                    let primary = i.get("is_primary").and_then(Value::as_bool) == Some(true);
                    let keys = if primary {
                        vec![IndexKey { field: "META().id".into(), kind: json!(1) }]
                    } else {
                        i.get("index_key")?
                            .as_array()?
                            .iter()
                            .filter_map(|k| k.as_str())
                            .map(|k| IndexKey { field: k.trim_matches('`').to_string(), kind: json!(1) })
                            .collect()
                    };
                    Some(IndexSchema { name, keys, unique: false })
                })
                .collect();
            collections.push(CollectionSchema {
                name,
                collection_type: "collection",
                indexes: index_schemas,
                fields: sampler.finish(),
                sampled,
            });
        }
        Ok(SourceSchema::Collections { database: bucket.unwrap_or_default(), collections })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: SqlppQuery = req.parse()?;
        let checked = sqlpp::check(&q.sqlpp).map_err(SourceError::Rejected)?;
        let params = parameters(&checked, &req)?;
        let c = client(conn).await?;
        let mut charge = req.limits.budget.charge();
        let run = c.statement(
            &q.sqlpp,
            params,
            req.limits.timeout.as_millis(),
            req.limits.budget.remaining(),
            Some(&mut charge),
        );
        let items = match tokio::time::timeout(req.limits.timeout, run).await {
            Ok(r) => r?,
            Err(_) => return Err(SourceError::Timeout(req.limits.timeout.as_secs())),
        };
        let mut docs = DocumentsBuilder::new(req.limits.max_rows, req.limits.budget.clone());
        docs.executed_query(q.sqlpp.clone());
        for item in items {
            if !docs.push(json_api::as_document(json_api::safe_numbers(item))) {
                break;
            }
        }
        let result = QueryResult::Documents { documents: docs.finish() };
        drop(charge);
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
