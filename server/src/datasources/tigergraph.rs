//! TigerGraph 3.10+ and 4.x over HTTP, through the one client factory (`crate::http`).
//!
//! - Interpreted queries (`{"gsql": "INTERPRET QUERY ..."}`) go to the GSQL server: 4.x
//!   `POST /gsql/v1/queries/interpret?graph=g`, 3.x `POST /gsqlserver/interpreted_query`, with the
//!   user and password (basic auth).
//! - Installed queries (`{"installed": "name"}`) go to REST++ `GET /query/{graph}/{name}`, with a
//!   token from the user's secret (4.x `POST /gsql/v1/tokens`, 3.x `POST /requesttoken`), kept until
//!   shortly before it expires and fetched again when REST++ refuses it.
//! - Parameters are typed REST++ query parameters from the query's declared parameters, never text
//!   in the GSQL code: `params` in the query, or else the dashboard variable of the same name.
//!
//! TigerGraph has no read transaction, so two things keep it read-only (docs/PLAN.md, section 5):
//!
//! 1. The user must be a reader: only `queryreader` (or a role with no more than `READ_SCHEMA`,
//!    `READ_LOADINGJOB`, `EXECUTE_LOADINGJOB`, `READ_DATA`, `READ_QUERY` and, from 4.1, the
//!    per-query `EXECUTE_QUERY`). Kalzit reads the user's roles and privileges when it sets up the
//!    connection (after every change of the source, and every ten minutes) and in Test connection,
//!    and refuses the source when the user may do more. 4.x: `GET /gsql/v1/users/{name}`; when
//!    that is not allowed, and on 3.x, the fixed command `SHOW USER`.
//! 2. The query text is checked by `gsql.rs`. An installed query runs only when its text is
//!    readable (4.x `GET /gsql/v1/queries/{name}?graph=g`, which needs `READ_QUERY`; 3.x has no
//!    such endpoint) and passes the check, or, when the text cannot be read, when its name is in
//!    the source's `approvedQueries`, which a data source admin keeps. Then only the reader user
//!    protects the data.
//!
//! Kalzit never calls REST++ upsert, delete or loading endpoints.
//!
//! Results: vertex sets and edges from `PRINT` become a `graph` (a node id is `Type:id`; edge ids
//! are derived from the type and the ends); other printed values become a `frame`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::Detail;
use super::frame::{Charge, Column, FrameBuilder};
use super::graph::{GraphBuilder, GraphLimits, float_value, int_value};
use super::gsql::{self, Form, ParamType};
use super::{
    Connection, DataSourcePlugin, FieldError, Health, Kind, SettingField, SettingType, SourceError, SourceQuery,
    SourceSchema,
};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{Edge, FieldType, Node, NoticeSeverity, QueryResult, Shape};

const SETTINGS: &[SettingField] = &[
    SettingField::new("url", "datasources.settings.gsqlUrl", SettingType::String).target().required(),
    SettingField::new("restppUrl", "datasources.settings.restppUrl", SettingType::String).target(),
    SettingField::new("graph", "datasources.settings.graph", SettingType::String).target().required(),
    SettingField::new("user", "datasources.settings.user", SettingType::String).target().required(),
    SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
    SettingField::new("secret", "datasources.settings.restppSecret", SettingType::String).secret(),
    SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
    // Which installed queries may run without a readable text decides what runs with the stored
    // secrets, so changing the list needs the admin level, like a target.
    SettingField::new("approvedQueries", "datasources.settings.approvedQueries", SettingType::Text).target(),
    SettingField::new("maxNodes", "datasources.settings.maxNodes", SettingType::Number),
    SettingField::new("maxEdges", "datasources.settings.maxEdges", SettingType::Number),
];
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;
/// Tokens Kalzit asks for live this long; one is replaced a minute before it expires.
const TOKEN_LIFETIME_SECS: u64 = 3600;
const TOKEN_MARGIN: Duration = Duration::from_secs(60);
/// How long a checked installed query's text is trusted before it is read again.
const TEXT_CACHE: Duration = Duration::from_secs(60);
const MAX_SCHEMA_NAMES: usize = 10_000;

/// Privileges a reader may hold. `EXECUTE_LOADINGJOB` belongs to the built-in `queryreader`
/// role; Kalzit never runs loading jobs (the GSQL check refuses `RUN`, and REST++ loading
/// endpoints are never called), but the docs advise a custom role without it.
const READ_PRIVILEGES: &[&str] =
    &["READ_SCHEMA", "READ_LOADINGJOB", "EXECUTE_LOADINGJOB", "READ_DATA", "READ_QUERY", "EXECUTE_QUERY"];

pub fn kind() -> Kind {
    Kind {
        name: "TigerGraph",
        hint_key: "datasources.kinds.tigergraph.hint",
        settings: SETTINGS,
        plugin: Arc::new(TigerGraph),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    url: String,
    restpp_url: Option<String>,
    graph: String,
    user: String,
    ca_cert: Option<String>,
    approved_queries: Option<String>,
    max_nodes: Option<u64>,
    max_edges: Option<u64>,
}

/// `{"gsql": "INTERPRET QUERY ..."}` or `{"installed": "name"}`, each with optional `params`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TgQuery {
    gsql: Option<String>,
    installed: Option<String>,
    #[serde(default)]
    params: Map<String, Value>,
}

pub struct TigerGraph;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Api {
    /// 4.x: `/gsql/v1/...`
    V4,
    /// 3.x: `/gsqlserver/...`
    V3,
}

struct Client {
    http: HttpClient,
    gsql: Url,
    restpp: Url,
    graph: String,
    user: String,
    basic: Option<HeaderValue>,
    basic_token: Option<String>,
    secret: Option<String>,
    approved: Vec<String>,
    api: Api,
    token: Mutex<Option<(String, Instant)>>,
    texts: Mutex<HashMap<String, (Instant, Result<Vec<gsql::Param>, Detail>)>>,
}

fn parse_url(raw: &str) -> Result<Url, Detail> {
    let url = Url::parse(raw.trim())
        .map_err(|e| Detail::new("settings.url_invalid", format!("the URL is not valid: {e}")).with("detail", e))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Detail::new("settings.url_scheme", "the URL must start with http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Detail::new("settings.url_credentials", "the URL must not contain credentials"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(Detail::new("settings.url_query", "the URL must not contain a query or fragment"));
    }
    if url.host_str().is_none() {
        return Err(Detail::new("settings.url_no_host", "the URL needs a host"));
    }
    Ok(url)
}

fn with_slash(mut url: Url) -> Url {
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    url
}

fn is_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn approved_list(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn failed_http(e: HttpError, scrub: &dyn Fn(&str) -> String) -> SourceError {
    match e {
        HttpError::Blocked(b) => SourceError::Blocked(b.0),
        other => SourceError::Failed(other.detail().scrubbed(scrub)),
    }
}

async fn client(conn: &Connection) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let s: Settings = conn.settings_as()?;
        let gsql = with_slash(parse_url(&s.url).map_err(SourceError::Failed)?);
        let restpp = match s.restpp_url.as_deref().filter(|u| !u.trim().is_empty()) {
            Some(u) => with_slash(parse_url(u).map_err(SourceError::Failed)?),
            None => gsql.join("restpp/").map_err(|e| SourceError::failed("internal", e.to_string()))?,
        };
        let http = crate::http::client(HttpOptions {
            timeout: CLIENT_TIMEOUT,
            extra_root_pem: s.ca_cert.clone(),
            policy: Arc::new(conn.policy().clone()),
        })
        .map_err(|e| SourceError::Failed(e.detail()))?;
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", s.user, conn.secret("password").unwrap_or("")));
        let basic = HeaderValue::from_str(&format!("Basic {token}")).map_err(|_| {
            SourceError::failed("tigergraph.credentials_invalid", "the credentials contain characters a header cannot carry")
        })?;
        let mut c = Client {
            http,
            gsql,
            restpp,
            graph: s.graph.clone(),
            user: s.user.clone(),
            basic: Some(basic),
            basic_token: Some(token),
            secret: conn.secret("secret").map(String::from),
            approved: approved_list(s.approved_queries.as_deref()),
            api: Api::V4,
            token: Mutex::new(None),
            texts: Mutex::new(HashMap::new()),
        };
        c.api = c.detect_api().await?;
        c.check_reader().await?;
        Ok(c)
    })
    .await
}

/// An answer of the GSQL server or REST++: the status and the parsed body.
struct Answer {
    status: StatusCode,
    body: Value,
}

impl Client {
    fn scrub(&self, text: &str) -> String {
        let mut out = text.to_string();
        if let Some(t) = &self.basic_token {
            out = out.replace(t, "***");
        }
        if let Ok(guard) = self.token.lock()
            && let Some((t, _)) = guard.as_ref()
        {
            out = out.replace(t, "***");
        }
        out
    }

    fn failed(&self, e: HttpError) -> SourceError {
        failed_http(e, &|t| self.scrub(t))
    }

    /// Sends a request and reads the body (at most `max` bytes, charged to `charge` when given).
    async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Option<HeaderValue>,
        body: Option<(Vec<u8>, &'static str)>,
        extra: &[(&'static str, String)],
        max: usize,
        charge: Option<&mut Charge>,
    ) -> Result<(StatusCode, Vec<u8>), SourceError> {
        let mut headers = HeaderMap::new();
        if let Some(a) = auth {
            headers.insert(AUTHORIZATION, a);
        }
        if let Some((_, content_type)) = &body {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
        }
        for (k, v) in extra {
            if let Ok(v) = HeaderValue::from_str(v) {
                headers.insert(*k, v);
            }
        }
        let response =
            self.http.send_body(method, url, headers, body.map(|(b, _)| b)).await.map_err(|e| self.failed(e))?;
        let status = response.status();
        let bytes = match charge {
            Some(charge) => crate::http::read_counted(response, max, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max).await,
        }
        .map_err(|e| self.failed(e))?;
        Ok((status, bytes))
    }

    /// A JSON answer of the GSQL server with basic auth.
    async fn gsql_json(&self, method: Method, path: &str, query: &[(&str, &str)]) -> Result<Answer, SourceError> {
        let mut url = self.gsql.join(path).map_err(|e| SourceError::failed("internal", e.to_string()))?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let (status, bytes) = self.call(method, url, self.basic.clone(), None, &[], MAX_SMALL_RESPONSE, None).await?;
        Ok(Answer { status, body: self.parse(status, &bytes)? })
    }

    fn parse(&self, status: StatusCode, bytes: &[u8]) -> Result<Value, SourceError> {
        serde_json::from_slice(bytes).map_err(|_| {
            SourceError::failed(
                "tigergraph.not_an_api_response",
                format!("the server answered {status} without a TigerGraph API response"),
            )
            .with("status", status.as_u16())
        })
    }

    fn api_error(&self, status: StatusCode, body: &Value) -> SourceError {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.trim().is_empty())
            .unwrap_or("unknown error")
            .trim();
        let message = self.scrub(message);
        SourceError::failed("tigergraph.error", format!("TigerGraph answered {status}: {message}"))
            .with("status", status.as_u16())
            .with("detail", message)
    }

    fn ok_or_error(&self, a: Answer) -> Result<Value, SourceError> {
        if !a.status.is_success() || a.body.get("error").and_then(Value::as_bool) == Some(true) {
            return Err(self.api_error(a.status, &a.body));
        }
        Ok(a.body)
    }

    /// 4.x answers the schema under `/gsql/v1`; 3.x only under `/gsqlserver`.
    async fn detect_api(&self) -> Result<Api, SourceError> {
        let v4 = self.gsql_json(Method::GET, &format!("gsql/v1/schema/graphs/{}", self.graph), &[]).await;
        match v4 {
            Ok(a) if a.status == StatusCode::NOT_FOUND && a.body.get("error").is_none() => Ok(Api::V3),
            Ok(_) => Ok(Api::V4),
            Err(SourceError::Failed(d)) if d.reason == "tigergraph.not_an_api_response" => {
                // A 404 page that is not JSON: no `/gsql/v1`, so 3.x.
                let v3 = self.gsql_json(Method::GET, "gsqlserver/gsql/schema", &[("graph", &self.graph)]).await?;
                self.ok_or_error(v3)?;
                Ok(Api::V3)
            }
            Err(e) => Err(e),
        }
    }

    async fn gsql_command(&self, command: &str) -> Result<String, SourceError> {
        let path = match self.api {
            Api::V4 => "gsql/v1/statements",
            Api::V3 => "gsqlserver/gsql/file",
        };
        let url = self.gsql.join(path).map_err(|e| SourceError::failed("internal", e.to_string()))?;
        let body = Some((command.as_bytes().to_vec(), "text/plain"));
        let (status, bytes) = self.call(Method::POST, url, self.basic.clone(), body, &[], MAX_SMALL_RESPONSE, None).await?;
        let text = String::from_utf8_lossy(&bytes).to_string();
        if !status.is_success() {
            let body = serde_json::from_str(&text).unwrap_or(json!({ "message": text }));
            return Err(self.api_error(status, &body));
        }
        Ok(text)
    }

    /// Refuses a user who may do more than read (see the module documentation).
    async fn check_reader(&self) -> Result<(), SourceError> {
        let rights = match self.api {
            Api::V4 => {
                // The name goes in as one encoded path segment.
                let mut url = self.gsql.join("gsql/v1/users/").map_err(|e| SourceError::failed("internal", e.to_string()))?;
                url.path_segments_mut()
                    .map_err(|_| SourceError::failed("internal", "the GSQL URL cannot take a path"))?
                    .pop_if_empty()
                    .push(&self.user);
                let (status, bytes) =
                    self.call(Method::GET, url, self.basic.clone(), None, &[], MAX_SMALL_RESPONSE, None).await?;
                let a = Answer { status, body: self.parse(status, &bytes).unwrap_or(Value::Null) };
                if a.status.is_success() && a.body.get("error").and_then(Value::as_bool) != Some(true) {
                    rights_from_json(&a.body, &self.user)
                } else {
                    None
                }
            }
            Api::V3 => None,
        };
        let rights = match rights {
            Some(r) => r,
            None => rights_from_show_user(&self.gsql_command("SHOW USER").await?, &self.graph).ok_or_else(|| {
                SourceError::failed(
                    "tigergraph.privileges_unverifiable",
                    "cannot read the TigerGraph user's roles and privileges, so Kalzit cannot check that it only reads",
                )
            })?,
        };
        let too_much = rights.excess();
        if too_much.is_empty() {
            Ok(())
        } else {
            let list = too_much.join(", ");
            Err(SourceError::failed(
                "tigergraph.user_can_write",
                format!("the TigerGraph user may do more than read ({list}); use a user with only the queryreader role"),
            )
            .with("privileges", list))
        }
    }

    /// A REST++ token, fetched when there is none or it is about to expire. `None` when the user
    /// has no secret and the API cannot issue one from the password (3.x): REST++ then has to run
    /// without authentication.
    async fn token(&self, renew: bool) -> Result<Option<String>, SourceError> {
        if !renew
            && let Some((t, until)) = self.token.lock().expect("token lock").as_ref()
            && Instant::now() + TOKEN_MARGIN < *until
        {
            return Ok(Some(t.clone()));
        }
        let lifetime = TOKEN_LIFETIME_SECS.to_string();
        let (url, body, auth) = match (self.api, &self.secret) {
            (Api::V4, secret) => {
                let mut body = json!({ "graph": self.graph, "lifetime": lifetime });
                if let Some(s) = secret {
                    body["secret"] = json!(s);
                }
                (self.gsql.join("gsql/v1/tokens"), body, self.basic.clone())
            }
            (Api::V3, Some(s)) => (self.restpp.join("requesttoken"), json!({ "secret": s, "lifetime": lifetime }), None),
            (Api::V3, None) => return Ok(None),
        };
        let url = url.map_err(|e| SourceError::failed("internal", e.to_string()))?;
        let body = Some((body.to_string().into_bytes(), "application/json"));
        let (status, bytes) = self.call(Method::POST, url, auth, body, &[], MAX_SMALL_RESPONSE, None).await?;
        let parsed = self.parse(status, &bytes)?;
        let value = self.ok_or_error(Answer { status, body: parsed })?;
        let token = value
            .get("token")
            .or_else(|| value.pointer("/results/token"))
            .and_then(Value::as_str)
            .ok_or_else(|| SourceError::failed("tigergraph.no_token", "TigerGraph answered without a token"))?
            .to_string();
        let until = Instant::now() + Duration::from_secs(TOKEN_LIFETIME_SECS);
        *self.token.lock().expect("token lock") = Some((token.clone(), until));
        Ok(Some(token))
    }

    /// The checked parameters of an installed query, or why it may not run.
    async fn installed_params(&self, name: &str) -> Result<Option<Vec<gsql::Param>>, SourceError> {
        if let Some((at, checked)) = self.texts.lock().expect("text cache lock").get(name)
            && at.elapsed() < TEXT_CACHE
        {
            return checked.clone().map(Some).map_err(SourceError::Rejected);
        }
        let text = match self.api {
            Api::V4 => {
                let a = self
                    .gsql_json(Method::GET, &format!("gsql/v1/queries/{name}"), &[("graph", &self.graph)])
                    .await?;
                let ok = a.status.is_success() && a.body.get("error").and_then(Value::as_bool) != Some(true);
                if ok { find_text(&a.body, "queryContent").or_else(|| find_text(&a.body, "code")) } else { None }
            }
            Api::V3 => None,
        };
        let Some(text) = text else {
            if self.approved.iter().any(|a| a == name) {
                return Ok(None);
            }
            return Err(SourceError::rejected(
                "tigergraph.query_text_unreadable",
                format!(
                    "the text of {name} cannot be read to check it; a data source admin can approve the query by name"
                ),
            )
            .with("name", name));
        };
        let checked = gsql::check(&text, Form::Installed).and_then(|c| {
            if c.name.as_deref().is_some_and(|n| !n.eq_ignore_ascii_case(name)) {
                return Err(Detail::new("gsql.not_one_query", "the installed text belongs to another query"));
            }
            match c.graph {
                Some(g) if !g.eq_ignore_ascii_case(&self.graph) => Err(other_graph(&g)),
                _ => Ok(c.params),
            }
        });
        self.texts.lock().expect("text cache lock").insert(name.to_string(), (Instant::now(), checked.clone()));
        checked.map(Some).map_err(SourceError::Rejected)
    }
}

fn other_graph(g: &str) -> Detail {
    Detail::new("gsql.other_graph", format!("the query is for the graph {g}, not the data source's graph")).with("graph", g)
}

fn find_text(v: &Value, key: &str) -> Option<String> {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(s)) = m.get(key) {
                return Some(s.clone());
            }
            m.values().find_map(|v| find_text(v, key))
        }
        Value::Array(a) => a.iter().find_map(|v| find_text(v, key)),
        _ => None,
    }
}

/// A user's rights as TigerGraph reports them.
#[derive(Debug, Default, PartialEq)]
struct Rights {
    superuser: bool,
    roles: Vec<String>,
    /// `None` when only roles are known.
    privileges: Option<Vec<String>>,
}

impl Rights {
    /// What the user may do beyond reading: privileges outside `READ_PRIVILEGES`, or, when only
    /// roles are known, roles other than `queryreader`.
    fn excess(&self) -> Vec<String> {
        if self.superuser {
            return vec!["superuser".into()];
        }
        let mut out: Vec<String> = match &self.privileges {
            Some(p) => p.iter().filter(|p| !READ_PRIVILEGES.contains(&p.to_ascii_uppercase().as_str())).cloned().collect(),
            None => self.roles.iter().filter(|r| !r.eq_ignore_ascii_case("queryreader")).cloned().collect(),
        };
        if self.privileges.is_none() && self.roles.is_empty() {
            out.push("unknown roles".into());
        }
        out.sort();
        out.dedup();
        out
    }
}

/// Strings anywhere below `key` in `v`.
fn strings_under(v: &Value, key: &str, out: &mut Vec<String>, inside: bool) {
    match v {
        Value::String(s) if inside => out.push(s.clone()),
        Value::Array(a) => a.iter().for_each(|v| strings_under(v, key, out, inside)),
        Value::Object(m) => {
            for (k, v) in m {
                strings_under(v, key, out, inside || k == key);
            }
        }
        _ => {}
    }
}

/// The user object of `GET /gsql/v1/users/{name}`: `roles` (per graph), `privileges` (per graph,
/// lists under `privileges`), `isSuperUser`.
fn rights_from_json(body: &Value, user: &str) -> Option<Rights> {
    let candidates: Vec<&Value> = match body.get("results") {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(v @ Value::Object(_)) => vec![v],
        _ => vec![body],
    };
    let u = candidates.into_iter().find(|c| c.get("name").and_then(Value::as_str).is_none_or(|n| n == user))?;
    let roles_v = u.get("roles")?;
    let mut roles = Vec::new();
    strings_under(roles_v, "roles", &mut roles, true);
    let privileges = u.get("privileges").map(|p| {
        let mut out = Vec::new();
        strings_under(p, "privileges", &mut out, false);
        if out.is_empty() {
            strings_under(p, "privileges", &mut out, true);
        }
        out
    });
    Some(Rights { superuser: u.get("isSuperUser").and_then(Value::as_bool).unwrap_or(false), roles, privileges })
}

/// The text of `SHOW USER`: lines such as `- Global Roles: queryreader` and
/// `- Graph 'social' Roles: queryreader`.
fn rights_from_show_user(text: &str, graph: &str) -> Option<Rights> {
    let mut roles = Vec::new();
    let mut found = false;
    for line in text.lines() {
        let line = line.trim().trim_start_matches('-').trim();
        let Some((label, value)) = line.split_once(':') else { continue };
        let label = label.trim();
        if !label.to_ascii_lowercase().ends_with("roles") {
            continue;
        }
        let global = label.to_ascii_lowercase().starts_with("global");
        let this_graph = label.contains(&format!("'{graph}'")) || label.contains(&format!("\"{graph}\""));
        // Roles on other graphs do not reach this one; global roles do.
        if global || this_graph || !label.contains('\'') {
            found = true;
            roles.extend(value.split(',').map(|r| r.trim().to_string()).filter(|r| !r.is_empty()));
        }
    }
    let superuser = roles.iter().any(|r| r.eq_ignore_ascii_case("superuser"));
    found.then_some(Rights { superuser, roles, privileges: None })
}

// ---- parameters ----

fn param_error(name: &str, expected: &str) -> SourceError {
    SourceError::rejected("tigergraph.param_type", format!("the parameter {name} must be {expected}"))
        .with("name", name)
        .with("type", expected)
}

fn scalar_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// One value as REST++ query pairs, by the declared type.
fn typed_pairs(name: &str, key: &str, ty: &ParamType, v: &Value, out: &mut Vec<(String, String)>) -> Result<(), SourceError> {
    let text = match ty {
        ParamType::Int | ParamType::Uint => {
            let i = match v {
                Value::Number(n) => n.as_i64().or_else(|| n.as_u64().map(|u| u as i64)),
                Value::String(s) => s.trim().parse::<i64>().ok(),
                _ => None,
            };
            let expected = if *ty == ParamType::Uint { "a whole number of at least 0" } else { "a whole number" };
            match i {
                Some(i) if *ty == ParamType::Int || i >= 0 => i.to_string(),
                _ => return Err(param_error(name, expected)),
            }
        }
        ParamType::Float => match v {
            Value::Number(n) => n.to_string(),
            Value::String(s) if s.trim().parse::<f64>().is_ok() => s.trim().to_string(),
            _ => return Err(param_error(name, "a number")),
        },
        ParamType::Bool => match v {
            Value::Bool(b) => b.to_string(),
            Value::String(s) if s == "true" || s == "false" => s.clone(),
            _ => return Err(param_error(name, "true or false")),
        },
        ParamType::String => scalar_text(v).ok_or_else(|| param_error(name, "text"))?,
        ParamType::Datetime => match v {
            Value::Number(n) => {
                let ms = n.as_i64().ok_or_else(|| param_error(name, "a time"))?;
                let t = chrono::DateTime::from_timestamp_millis(ms).ok_or_else(|| param_error(name, "a time"))?;
                t.format("%Y-%m-%d %H:%M:%S").to_string()
            }
            Value::String(s) if chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").is_ok() => s.clone(),
            _ => return Err(param_error(name, "a time (YYYY-MM-DD HH:MM:SS or Unix milliseconds)")),
        },
        ParamType::Vertex(Some(_)) => scalar_text(v).ok_or_else(|| param_error(name, "a vertex id"))?,
        ParamType::Vertex(None) => {
            let (Some(t), Some(id)) = (v.get("type").and_then(Value::as_str), v.get("id").and_then(scalar_text)) else {
                return Err(param_error(name, "a vertex as {\"type\": ..., \"id\": ...}"));
            };
            out.push((key.to_string(), id));
            out.push((format!("{key}.type"), t.to_string()));
            return Ok(());
        }
        ParamType::Many(inner) => {
            let items: Vec<&Value> = match v {
                Value::Array(a) => a.iter().collect(),
                other => vec![other],
            };
            for (i, item) in items.into_iter().enumerate() {
                let key = if matches!(**inner, ParamType::Vertex(None)) { format!("{key}[{i}]") } else { key.to_string() };
                typed_pairs(name, &key, inner, item, out)?;
            }
            return Ok(());
        }
    };
    out.push((key.to_string(), text));
    Ok(())
}

/// Query pairs for the declared parameters (typed), or for every given value when the text and
/// so the types are unknown (an approved installed query).
fn query_pairs(
    declared: Option<&[gsql::Param]>,
    given: &Map<String, Value>,
    variables: &BTreeMap<String, Value>,
) -> Result<Vec<(String, String)>, SourceError> {
    let mut out = Vec::new();
    let value = |name: &str| given.get(name).or_else(|| variables.get(name));
    match declared {
        Some(params) => {
            if let Some(unknown) = given.keys().find(|k| !params.iter().any(|p| &p.name == *k)) {
                return Err(SourceError::rejected(
                    "tigergraph.param_unknown",
                    format!("the query has no parameter {unknown}"),
                )
                .with("name", unknown));
            }
            for p in params {
                if let Some(v) = value(&p.name) {
                    typed_pairs(&p.name, &p.name, &p.ty, v, &mut out)?;
                }
            }
        }
        None => {
            for (name, v) in given {
                if !gsql_name(name) {
                    return Err(param_error(name, "named with letters, digits and _"));
                }
                let ty = match v {
                    Value::Array(_) => ParamType::Many(Box::new(ParamType::String)),
                    Value::Object(_) => ParamType::Vertex(None),
                    _ => ParamType::String,
                };
                typed_pairs(name, name, &ty, v, &mut out)?;
            }
        }
    }
    Ok(out)
}

fn gsql_name(s: &str) -> bool {
    is_name(s)
}

// ---- results ----

fn tg_value(v: &Value) -> Value {
    match v {
        Value::Number(n) => match (n.as_i64(), n.as_u64(), n.as_f64()) {
            (Some(i), _, _) => int_value(i),
            (None, Some(u), _) => crate::shapes::typed("int64", u.to_string()),
            (_, _, Some(f)) => float_value(f),
            _ => Value::Null,
        },
        Value::Array(a) => Value::Array(a.iter().map(tg_value).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), tg_value(v))).collect()),
        other => other.clone(),
    }
}

fn is_vertex(v: &Value) -> bool {
    v.get("v_id").is_some() && v.get("v_type").is_some()
}

fn is_edge(v: &Value) -> bool {
    v.get("e_type").is_some() && v.get("from_id").is_some() && v.get("to_id").is_some()
}

fn is_graph(v: &Value) -> bool {
    is_vertex(v) || is_edge(v) || v.as_array().is_some_and(|a| a.iter().any(is_graph))
}

fn id_text(v: Option<&Value>) -> String {
    v.and_then(scalar_text).unwrap_or_default()
}

/// The composite node id: the vertex type and its primary id.
fn node_id(ty: &str, id: &str) -> String {
    format!("{ty}:{id}")
}

fn attributes(v: &Value) -> BTreeMap<String, Value> {
    v.get("attributes").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), tg_value(v))).collect()).unwrap_or_default()
}

/// Builds a graph or a frame from the `results` of a query.
struct TgResult {
    graph: GraphBuilder,
    /// Edge ids per derived base, with the attributes of each, so parallel edges (discriminators)
    /// get distinct ids and the same edge printed twice keeps one.
    edge_ids: HashMap<String, Vec<BTreeMap<String, Value>>>,
}

impl TgResult {
    fn add(&mut self, v: &Value) -> bool {
        if is_vertex(v) {
            let ty = v["v_type"].as_str().unwrap_or("").to_string();
            let node = Node { id: node_id(&ty, &id_text(v.get("v_id"))), labels: vec![ty], properties: attributes(v) };
            return self.graph.add_node(node);
        }
        if is_edge(v) {
            let from_type = v.get("from_type").and_then(Value::as_str).unwrap_or("").to_string();
            let to_type = v.get("to_type").and_then(Value::as_str).unwrap_or("").to_string();
            let from = node_id(&from_type, &id_text(v.get("from_id")));
            let to = node_id(&to_type, &id_text(v.get("to_id")));
            let ty = v["e_type"].as_str().unwrap_or("").to_string();
            let directed = v.get("directed").and_then(Value::as_bool).unwrap_or(true);
            let props = attributes(v);
            // An undirected edge is the same edge from either end.
            let (a, b) = if directed || from <= to { (&from, &to) } else { (&to, &from) };
            let sep = if directed { "->" } else { "--" };
            let base = format!("{ty}:{a}{sep}{b}");
            let seen = self.edge_ids.entry(base.clone()).or_default();
            let n = match seen.iter().position(|p| *p == props) {
                Some(n) => n,
                None => {
                    seen.push(props.clone());
                    seen.len() - 1
                }
            };
            let id = if n == 0 { base } else { format!("{base}#{}", n + 1) };
            let edge = Edge { id, edge_type: ty, from, to, properties: props };
            return self.graph.add_edge(edge, &[from_type], &[to_type]);
        }
        match v {
            Value::Array(a) => a.iter().all(|i| !is_graph(i) || self.add(i)),
            _ => true,
        }
    }
}

/// The printed values: one `(key, value)` per key of every object in `results`, in order.
fn printed(results: &Value) -> Vec<(String, &Value)> {
    let mut out = Vec::new();
    for item in results.as_array().map(Vec::as_slice).unwrap_or_default() {
        if let Some(m) = item.as_object() {
            for (k, v) in m {
                out.push((k.clone(), v));
            }
        }
    }
    out
}

fn to_result(results: &Value, req: &SourceQuery, settings: &Value, executed: String) -> QueryResult {
    let values = printed(results);
    if values.iter().any(|(_, v)| is_graph(v)) {
        let limits = GraphLimits::from_settings(settings, req.limits.max_rows, req.limits.budget.clone());
        let mut r = TgResult { graph: GraphBuilder::new(limits), edge_ids: HashMap::new() };
        let mut omitted = Vec::new();
        for (k, v) in &values {
            if is_graph(v) {
                if !r.add(v) {
                    break;
                }
            } else if !omitted.contains(k) {
                omitted.push(k.clone());
            }
        }
        if !omitted.is_empty() {
            let list = omitted.join(", ");
            r.graph.notice(
                NoticeSeverity::Info,
                Detail::new(
                    "graph.columns_omitted",
                    format!("{list} hold no vertices or edges and are not part of the graph; print them in another query for a table"),
                )
                .with("columns", list),
            );
        }
        return QueryResult::Graph { graph: r.graph.finish() };
    }
    // One printed list of objects (tuples, `PRINT x[x.a, x.b]` of non-vertices): one row each.
    // Otherwise one row with every printed value.
    let rows: Vec<Map<String, Value>> = match values.as_slice() {
        [(_, Value::Array(items))] if items.iter().all(Value::is_object) => {
            items.iter().filter_map(|i| i.as_object().cloned()).collect()
        }
        _ => {
            let mut row = Map::new();
            for (k, v) in &values {
                row.insert(k.clone(), (*v).clone());
            }
            vec![row]
        }
    };
    let mut names: Vec<String> = Vec::new();
    for r in &rows {
        for k in r.keys() {
            if !names.contains(k) {
                names.push(k.clone());
            }
        }
    }
    let types: Vec<FieldType> = names.iter().map(|n| column_type(rows.iter().filter_map(|r| r.get(n)))).collect();
    let columns = names.iter().zip(&types).map(|(n, t)| Column::new(n.clone(), Some(*t))).collect();
    let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
    frame.executed_query(executed);
    for r in &rows {
        let row = names
            .iter()
            .zip(&types)
            .map(|(n, t)| match (t, r.get(n)) {
                (_, None | Some(Value::Null)) => Value::Null,
                (FieldType::Int64, Some(v)) => json!(v.to_string()),
                (FieldType::Json, Some(v)) => tg_value(v),
                (_, Some(v)) => v.clone(),
            })
            .collect();
        if !frame.push_row(row) {
            break;
        }
    }
    QueryResult::Frame { frame: frame.finish() }
}

fn column_type<'a>(values: impl Iterator<Item = &'a Value>) -> FieldType {
    let mut seen: Option<FieldType> = None;
    for v in values {
        let t = match v {
            Value::Null => continue,
            Value::Bool(_) => FieldType::Bool,
            Value::Number(n) if n.is_i64() || n.is_u64() => FieldType::Int64,
            Value::Number(_) => FieldType::Number,
            Value::String(_) => FieldType::String,
            _ => FieldType::Json,
        };
        seen = Some(match (seen, t) {
            (None, t) => t,
            (Some(a), b) if a == b => a,
            (Some(FieldType::Int64 | FieldType::Number), FieldType::Int64 | FieldType::Number) => FieldType::Number,
            _ => FieldType::Json,
        });
    }
    seen.unwrap_or(FieldType::String)
}

#[async_trait::async_trait]
impl DataSourcePlugin for TigerGraph {
    fn kind(&self) -> &'static str {
        "tigergraph"
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Graph, Shape::Frame]
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        parse_url(&s.url).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
        if let Some(u) = s.restpp_url.as_deref().filter(|u| !u.trim().is_empty()) {
            parse_url(u).map_err(|d| FieldError { field: "restppUrl", detail: d.with("field", "restppUrl") })?;
        }
        if !is_name(&s.graph) {
            return Err(FieldError::new("graph", "settings.name_invalid", "the graph name has letters, digits and _ only"));
        }
        let user_ok = !s.user.is_empty()
            && s.user.len() <= 128
            && s.user.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@'));
        if !user_ok {
            return Err(FieldError::new(
                "user",
                "settings.name_invalid",
                "the user name has letters, digits and _ - . @ only",
            ));
        }
        if let Some(bad) = approved_list(s.approved_queries.as_deref()).into_iter().find(|q| !is_name(q)) {
            return Err(FieldError::new(
                "approvedQueries",
                "settings.name_invalid",
                format!("{bad} is not a query name (letters, digits and _)"),
            ));
        }
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        for (field, value) in [("maxNodes", s.max_nodes), ("maxEdges", s.max_edges)] {
            if value == Some(0) {
                return Err(
                    FieldError::new(field, "settings.out_of_range", format!("{field} must be at least 1")).with("min", 1)
                );
            }
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let check = async {
            let c = client(conn).await?;
            // The cached client checked the user when it was built; Test connection checks again.
            c.check_reader().await?;
            let token = c.token(false).await?;
            let mut url = c.restpp.join("version").map_err(|e| SourceError::failed("internal", e.to_string()))?;
            url.set_query(None);
            let auth = token.and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok());
            let (status, bytes) = c.call(Method::GET, url, auth, None, &[], MAX_SMALL_RESPONSE, None).await?;
            let text = String::from_utf8_lossy(&bytes).to_string();
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(String::from))
                .unwrap_or(text);
            let version = status.is_success().then(|| version_from(&message)).flatten();
            let fallback = match c.api {
                Api::V4 => "4",
                Api::V3 => "3",
            };
            Ok::<_, SourceError>((version.unwrap_or_else(|| fallback.to_string()), edition_from(&message)))
        };
        match check.await {
            Ok((version, edition)) => {
                let mut h = Health::connected("TigerGraph", &version, false);
                if let Some(e) = edition {
                    h.detail = h.detail.with("edition", e);
                }
                h
            }
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let c = client(conn).await?;
        let a = match c.api {
            Api::V4 => c.gsql_json(Method::GET, &format!("gsql/v1/schema/graphs/{}", c.graph), &[]).await?,
            Api::V3 => c.gsql_json(Method::GET, "gsqlserver/gsql/schema", &[("graph", &c.graph)]).await?,
        };
        let body = c.ok_or_error(a)?;
        let results = body.get("results").unwrap_or(&body);
        let names = |key: &str| -> Vec<String> {
            results
                .get(key)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|t| t.get("Name").and_then(Value::as_str).map(String::from)).take(MAX_SCHEMA_NAMES).collect())
                .unwrap_or_default()
        };
        let mut keys: Vec<String> = ["VertexTypes", "EdgeTypes"]
            .iter()
            .flat_map(|k| results.get(*k).and_then(Value::as_array).cloned().unwrap_or_default())
            .flat_map(|t| t.get("Attributes").and_then(Value::as_array).cloned().unwrap_or_default())
            .filter_map(|a| a.get("AttributeName").and_then(Value::as_str).map(String::from))
            .collect();
        keys.sort();
        keys.dedup();
        keys.truncate(MAX_SCHEMA_NAMES);
        let mut queries = match c.api {
            Api::V4 => match c.gsql_json(Method::GET, "gsql/v1/queries", &[("graph", &c.graph)]).await {
                Ok(a) if a.status.is_success() => query_names(a.body.get("results").unwrap_or(&a.body)),
                _ => Vec::new(),
            },
            Api::V3 => Vec::new(),
        };
        for approved in &c.approved {
            if !queries.contains(approved) {
                queries.push(approved.clone());
            }
        }
        queries.sort();
        Ok(SourceSchema::Graph { labels: names("VertexTypes"), edge_types: names("EdgeTypes"), property_keys: keys, queries })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        let q: TgQuery = req.parse()?;
        let c = client(conn).await?;
        let max_bytes = req.limits.budget.remaining();
        let timeout_ms = req.limits.timeout.as_millis().to_string();
        let mut charge = req.limits.budget.charge();
        let (status, bytes, executed) = match (q.gsql, q.installed) {
            (Some(text), None) => {
                let checked = gsql::check(&text, Form::Interpret).map_err(SourceError::Rejected)?;
                if let Some(g) = checked.graph.as_deref().filter(|g| !g.eq_ignore_ascii_case(&c.graph)) {
                    return Err(SourceError::Rejected(other_graph(g)));
                }
                let pairs = query_pairs(Some(&checked.params), &q.params, &req.variables)?;
                let mut url = match c.api {
                    Api::V4 => c.gsql.join("gsql/v1/queries/interpret"),
                    Api::V3 => c.gsql.join("gsqlserver/interpreted_query"),
                }
                .map_err(|e| SourceError::failed("internal", e.to_string()))?;
                {
                    let mut qp = url.query_pairs_mut();
                    if c.api == Api::V4 {
                        qp.append_pair("graph", &c.graph);
                    }
                    qp.extend_pairs(&pairs);
                }
                let body = Some((text.clone().into_bytes(), "text/plain"));
                let headers = [("gsql-timeout", timeout_ms.clone())];
                let (s, b) =
                    c.call(Method::POST, url, c.basic.clone(), body, &headers, max_bytes, Some(&mut charge)).await?;
                (s, b, text)
            }
            (None, Some(name)) => {
                if !is_name(&name) {
                    return Err(SourceError::rejected("tigergraph.query_name", format!("{name} is not a query name"))
                        .with("name", &name));
                }
                let declared = c.installed_params(&name).await?;
                let pairs = query_pairs(declared.as_deref(), &q.params, &req.variables)?;
                let mut url = c
                    .restpp
                    .join(&format!("query/{}/{name}", c.graph))
                    .map_err(|e| SourceError::failed("internal", e.to_string()))?;
                url.query_pairs_mut().extend_pairs(&pairs);
                let headers =
                    [("gsql-timeout", timeout_ms.clone()), ("response-limit", max_bytes.max(1).to_string())];
                let mut renew = false;
                loop {
                    let token = c.token(renew).await?;
                    let had_token = token.is_some();
                    let auth = token.and_then(|t| HeaderValue::from_str(&format!("Bearer {t}")).ok());
                    let (s, b) =
                        c.call(Method::GET, url.clone(), auth, None, &headers, max_bytes, Some(&mut charge)).await?;
                    // An expired or revoked token: fetch a new one once.
                    if s == StatusCode::UNAUTHORIZED && !renew && had_token {
                        renew = true;
                        continue;
                    }
                    break (s, b, format!("{} {}", name, url.query().unwrap_or("")));
                }
            }
            _ => {
                return Err(SourceError::rejected(
                    "query.invalid_form",
                    "the query needs either gsql (an interpreted query) or installed (a query name)",
                )
                .with("detail", "either gsql or installed"));
            }
        };
        let body = c.parse(status, &bytes)?;
        drop(bytes);
        let body = c.ok_or_error(Answer { status, body })?;
        let results = body.get("results").cloned().unwrap_or(Value::Array(Vec::new()));
        drop(body);
        let result = to_result(&results, &req, conn.settings(), executed);
        // The raw answer is gone; only the result's own charge remains.
        drop(charge);
        Ok(result)
    }
}

fn query_names(v: &Value) -> Vec<String> {
    let mut out: Vec<String> = match v {
        Value::Array(a) => a
            .iter()
            .filter_map(|q| q.as_str().map(String::from).or_else(|| q.get("name").and_then(Value::as_str).map(String::from)))
            .collect(),
        Value::Object(m) => m.keys().cloned().collect(),
        _ => Vec::new(),
    };
    out.retain(|n| is_name(n));
    out.truncate(MAX_SCHEMA_NAMES);
    out
}

/// "TigerGraph version: 4.1.0" or "release_3.10.1_..." to the version.
fn version_from(message: &str) -> Option<String> {
    for line in message.lines() {
        let l = line.to_ascii_lowercase();
        if let Some(at) = l.find("version:") {
            let v = line[at + 8..].trim();
            if v.starts_with(|c: char| c.is_ascii_digit()) {
                return Some(v.split_whitespace().next().unwrap_or(v).to_string());
            }
        }
        if let Some(at) = l.find("release_") {
            let v: String = line[at + 8..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn edition_from(message: &str) -> Option<String> {
    message.lines().find_map(|line| {
        let (label, value) = line.split_once(':')?;
        label.to_ascii_lowercase().contains("edition").then(|| value.trim().to_string()).filter(|v| !v.is_empty())
    })
}

#[cfg(test)]
mod tests;
