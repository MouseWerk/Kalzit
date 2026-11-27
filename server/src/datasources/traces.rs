//! What the trace sources (Tempo, Jaeger) share: a read-only HTTP client that reaches only the
//! kind's read endpoints, the `trace` builder that keeps the span and response size limits,
//! the conversion of OTLP JSON (Tempo) and Jaeger JSON into spans, and the frame of a search
//! result list (docs/guide/traces.md).
//!
//! A trace stays a trace: the sources answer the `trace` shape for traces and a `frame` only for
//! lists (search results, services, operations, tag values). A span table or a service map is a
//! visible step (`analysis::trace`), never something a source makes by itself.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Method, Url};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::Detail;
use super::frame::{Charge, Column, FrameBuilder, ResponseBudget, map_size, string_size};
use super::http_json::parse_url;
use super::http_source::{self, Auth, Scrubber, header_value};
use super::{Connection, FieldError, SourceError, SourceQuery};
use crate::http::{HttpClient, HttpError, HttpOptions};
use crate::shapes::{
    Field, FieldType, Frame, Notice, NoticeSeverity, Span, SpanEvent, SpanKind, SpanLink, SpanScope, SpanStatus,
    TraceSet, Truncated,
};

/// The client's own limit; the query timeout around each call is usually shorter.
const CLIENT_TIMEOUT: Duration = Duration::from_secs(3600);
/// Health, schema and list answers are read up to this size.
pub const MAX_SMALL_RESPONSE: usize = 16 * 1024 * 1024;

/// The settings both trace kinds take; `tenantId` is Tempo's `X-Scope-OrgID`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub url: String,
    pub basic_auth_user: Option<String>,
    pub tenant_id: Option<String>,
    pub ca_cert: Option<String>,
}

/// Checks the settings without the network: the URL and the certificate.
pub fn check_settings(settings: &Value) -> Result<(), FieldError> {
    let s = Settings::deserialize(settings)
        .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
    parse_url(&s.url, false).map_err(|d| FieldError { field: "url", detail: d.with("field", "url") })?;
    super::check_pem("caCert", s.ca_cert.as_deref())?;
    Ok(())
}

/// The reason codes and the name of one trace kind.
pub struct Codes {
    pub engine: &'static str,
    pub endpoint_not_allowed: &'static str,
    pub error: &'static str,
    pub not_an_api_response: &'static str,
    pub credentials_invalid: &'static str,
}

/// The read endpoints of one kind, as path segments below the base URL; `allowed` says whether
/// the segments after the base are one of them.
pub struct Endpoints {
    pub codes: &'static Codes,
    pub allowed: fn(&[&str]) -> bool,
}

/// Refuses every URL that is not one of the kind's read endpoints below `base` (redirects
/// included): only GET, the same origin, no fragment, no `.` or `..` segments.
pub fn check_endpoint(endpoints: &Endpoints, base: &Url, method: &Method, url: &Url) -> Result<(), Detail> {
    let refused = || {
        Detail::new(endpoints.codes.endpoint_not_allowed, format!("{method} {} is not a read endpoint", url.path()))
            .with("path", url.path())
    };
    if *method != Method::GET || url.origin() != base.origin() || url.fragment().is_some() {
        return Err(refused());
    }
    let base_path = base.path().trim_end_matches('/');
    let Some(rest) = url.path().strip_prefix(base_path).and_then(|r| r.strip_prefix('/')) else {
        return Err(refused());
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let plain = segments.iter().all(|s| {
        let decoded = s.to_ascii_lowercase().replace("%2e", ".");
        !s.is_empty() && decoded != "." && decoded != ".."
    });
    if plain && (endpoints.allowed)(&segments) { Ok(()) } else { Err(refused()) }
}

pub struct Client {
    http: HttpClient,
    base: Url,
    headers: HeaderMap,
    scrubber: Scrubber,
    endpoints: &'static Endpoints,
}

/// The client of a source, shared by its queries.
pub async fn client(conn: &Connection, endpoints: &'static Endpoints) -> Result<Arc<Client>, SourceError> {
    conn.shared(|| async {
        let codes = endpoints.codes;
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
        let mut scrubber = Scrubber::new(conn);
        let auth = Auth::basic_or_bearer(
            s.basic_auth_user.as_deref(),
            conn.secret("basicAuthPassword"),
            conn.secret("bearerToken"),
        );
        if let Some(auth) = auth {
            headers.insert(AUTHORIZATION, auth.header(codes.credentials_invalid, &mut scrubber)?);
        }
        if let Some(tenant) = s.tenant_id.filter(|t| !t.trim().is_empty()) {
            headers.insert(
                HeaderName::from_static("x-scope-orgid"),
                header_value(tenant.trim(), codes.credentials_invalid)?,
            );
        }
        Ok(Client { http, base, headers, scrubber, endpoints })
    })
    .await
}

/// A request's answer: its status and body. A 404 is the caller's to read (a trace that is not
/// there); other failures are errors already.
pub struct Answer {
    pub status: reqwest::StatusCode,
    pub body: Vec<u8>,
}

impl Answer {
    pub fn json(&self, codes: &Codes) -> Result<Value, SourceError> {
        serde_json::from_slice(&self.body).map_err(|_| {
            SourceError::failed(
                codes.not_an_api_response,
                format!("the server answered {} without a {} API response", self.status, codes.engine),
            )
            .with("status", self.status.as_u16())
        })
    }
}

impl Client {
    pub fn scrub(&self, text: &str) -> String {
        self.scrubber.scrub(text)
    }

    fn failed(&self, e: HttpError) -> SourceError {
        http_source::failed(e, &self.scrubber)
    }

    /// GETs the endpoint at `path` (segments below the base URL, each encoded) with `params`.
    /// With a charge, the body is charged to the request's budget as it arrives. A 404 comes
    /// back as an answer when `not_found_ok`, so a missing trace can say so.
    pub async fn get(
        &self,
        path: &[&str],
        params: &[(&str, String)],
        max_bytes: usize,
        charge: Option<&mut Charge>,
        not_found_ok: bool,
    ) -> Result<Answer, SourceError> {
        let codes = self.endpoints.codes;
        let mut url = self.base.clone();
        url.path_segments_mut()
            .map_err(|_| SourceError::failed("settings.stored_invalid", "the stored URL cannot carry a path"))?
            .pop_if_empty()
            .extend(path);
        if !params.is_empty() {
            url.query_pairs_mut().extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        }
        // The first request is checked as its redirects are: a path the kind does not read is
        // never sent.
        check_endpoint(self.endpoints, &self.base, &Method::GET, &url).map_err(SourceError::Rejected)?;
        let base = self.base.clone();
        let endpoints = self.endpoints;
        let hop = move |method: &Method, url: &Url| check_endpoint(endpoints, &base, method, url);
        let response = self
            .http
            .send_checked(Method::GET, url, self.headers.clone(), None, Some(&hop))
            .await
            .map_err(|e| self.failed(e))?;
        let status = response.status();
        let body = match charge {
            Some(charge) => crate::http::read_counted(response, max_bytes, |n| charge.add(n)).await,
            None => crate::http::read_limited(response, max_bytes).await,
        }
        .map_err(|e| self.failed(e))?;
        if let Some(e) = http_source::unauthorized(status, &body, &self.scrubber) {
            return Err(e);
        }
        if status == reqwest::StatusCode::NOT_FOUND && not_found_ok {
            return Ok(Answer { status, body });
        }
        if !status.is_success() {
            let text = String::from_utf8_lossy(&body);
            let message = serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|v| error_text(&v))
                .unwrap_or_else(|| text.trim().chars().take(1000).collect());
            let message = self.scrub(&message);
            return Err(SourceError::failed(codes.error, format!("{} answered {status}: {message}", codes.engine))
                .with("status", status.as_u16())
                .with("detail", message));
        }
        Ok(Answer { status, body })
    }

    /// The whole JSON answer of a small read (health, schema, lists).
    pub async fn json(&self, path: &[&str], params: &[(&str, String)]) -> Result<Value, SourceError> {
        self.get(path, params, MAX_SMALL_RESPONSE, None, false).await?.json(self.endpoints.codes)
    }
}

/// The error text of a JSON error answer: Jaeger's `errors[0].msg`, else `message` or `error`.
fn error_text(v: &Value) -> Option<String> {
    v["errors"][0]["msg"].as_str().or(v["message"].as_str()).or(v["error"].as_str()).map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// Ids and variables

/// A trace id from a query: 1 to 32 hex digits, as lower case padded to 32 (16 when it has at
/// most 16, as 64-bit ids of Jaeger are). Anything else is refused, so an id never carries a
/// path or a query into the request.
pub fn check_trace_id(raw: &str) -> Result<String, SourceError> {
    let id = raw.trim();
    if id.is_empty() || id.len() > 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(SourceError::rejected("trace.id_invalid", "a trace id has 1 to 32 hex digits").with("id", id));
    }
    Ok(pad_hex(&id.to_ascii_lowercase()))
}

fn pad_hex(id: &str) -> String {
    let width = if id.len() <= 16 { 16 } else { 32 };
    format!("{id:0>width$}")
}

/// A 128-bit trace id as lower-case hex of 32 digits, for sources whose trace ids are always 128
/// bits (Tempo) but which drop leading zeros in some answers (Tempo's search).
pub fn hex_id_128(raw: &str) -> String {
    let id = hex_id(raw);
    if id.is_empty() || id.len() >= 32 { id } else { format!("{id:0>32}") }
}

/// The trace ids of `trace` that name the asked `id` without its leading zeros (a source that
/// writes a 128-bit id with a zero high half as 64 bits, as Jaeger does) as the id asked for, so
/// the answer carries the id the query named.
pub fn as_asked(trace: &mut TraceSet, id: &str) {
    let short = id.trim_start_matches('0');
    for s in &mut trace.spans {
        if s.trace_id != id && s.trace_id.trim_start_matches('0') == short {
            s.trace_id = id.to_string();
        }
    }
}

/// An id as the source sent it, as lower-case hex: hex as it is (padded), base64 (Tempo's JSON
/// encodes ids that way) decoded. Empty for none.
pub fn hex_id(raw: &str) -> String {
    let raw = raw.trim();
    if raw.is_empty() {
        return String::new();
    }
    // Base64 of an 8- or 16-byte id always ends in `=`, so text of hex digits only is hex.
    if raw.bytes().all(|b| b.is_ascii_hexdigit()) && raw.len() <= 32 {
        return pad_hex(&raw.to_ascii_lowercase());
    }
    match base64::engine::general_purpose::STANDARD.decode(raw) {
        Ok(bytes) if !bytes.is_empty() => hex::encode(bytes),
        _ => raw.to_ascii_lowercase(),
    }
}

// ---------------------------------------------------------------------------------------------
// Search without a query language

/// Traces one search asks for at most, whatever the query says.
pub const MAX_SEARCH_LIMIT: usize = 1000;
/// The longest service, operation or tag text a search may send.
const MAX_TEXT: usize = 1000;
const MAX_TAGS: usize = 20;

/// The number of traces a search asks for: the query's `limit`, else the kind's default, 1 to
/// `MAX_SEARCH_LIMIT`.
pub fn search_limit(limit: Option<u32>, default: usize) -> usize {
    limit.map_or(default, |l| l as usize).clamp(1, MAX_SEARCH_LIMIT)
}

pub fn form_error(message: &str) -> SourceError {
    SourceError::rejected("query.invalid_form", format!("the query is not valid: {message}")).with("detail", message)
}

/// The search fields both kinds take, as written in the query.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchFields {
    pub service: Option<String>,
    pub operation: Option<String>,
    #[serde(default)]
    pub tags: BTreeMap<String, String>,
    pub min_duration: Option<String>,
    pub max_duration: Option<String>,
    pub status: Option<SpanStatus>,
}

impl SearchFields {
    pub fn is_empty(&self) -> bool {
        *self == SearchFields::default()
    }

    /// The fields with their variables put in, each checked.
    pub fn bind(&self, req: &SourceQuery) -> Result<Search, SourceError> {
        if self.tags.len() > MAX_TAGS {
            return Err(form_error(&format!("a search takes at most {MAX_TAGS} tags")));
        }
        let opt = |field: &str, raw: &Option<String>| raw.as_deref().map(|r| checked_text(field, r, req)).transpose();
        let mut tags = BTreeMap::new();
        for (k, v) in &self.tags {
            let key = checked_text("tags", k, req)?;
            if !key.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/".contains(c)) {
                return Err(form_error("a tag name holds letters, digits and . _ - : / only"));
            }
            tags.insert(key, with_variables(v, req)?);
        }
        let dur = |field: &str, raw: &Option<String>| raw.as_deref().map(|r| duration(field, r, req)).transpose();
        Ok(Search {
            service: opt("service", &self.service)?,
            operation: opt("operation", &self.operation)?,
            tags,
            min_duration: dur("minDuration", &self.min_duration)?,
            max_duration: dur("maxDuration", &self.max_duration)?,
            status: self.status,
        })
    }
}

/// A search with its variables put in.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Search {
    pub service: Option<String>,
    pub operation: Option<String>,
    pub tags: BTreeMap<String, String>,
    pub min_duration: Option<String>,
    pub max_duration: Option<String>,
    pub status: Option<SpanStatus>,
}

/// TraceQL text in double quotes.
fn traceql_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A tag value as TraceQL compares it: numbers and true or false as they are, text quoted.
fn traceql_value(v: &str) -> String {
    let t = v.trim();
    if t == "true" || t == "false" || t.parse::<i64>().is_ok() || t.parse::<f64>().is_ok_and(f64::is_finite) {
        t.to_string()
    } else {
        traceql_string(v)
    }
}

/// The TraceQL a search stands for, shown with the answer: one span set whose spans match every
/// field (`{}` for none). A tag without a scope (`http.status_code`) matches span and resource
/// attributes (`.http.status_code`).
pub fn traceql(search: &Search) -> String {
    let mut conds = Vec::new();
    if let Some(s) = &search.service {
        conds.push(format!("resource.service.name = {}", traceql_string(s)));
    }
    if let Some(o) = &search.operation {
        conds.push(format!("name = {}", traceql_string(o)));
    }
    for (k, v) in &search.tags {
        let scoped = ["resource.", "span.", "."].iter().any(|p| k.starts_with(p));
        let key = if scoped { k.clone() } else { format!(".{k}") };
        conds.push(format!("{key} = {}", traceql_value(v)));
    }
    if let Some(d) = &search.min_duration {
        conds.push(format!("duration >= {d}"));
    }
    if let Some(d) = &search.max_duration {
        conds.push(format!("duration <= {d}"));
    }
    if let Some(s) = search.status {
        conds.push(format!("status = {}", s.as_str()));
    }
    if conds.is_empty() { "{}".to_string() } else { format!("{{ {} }}", conds.join(" && ")) }
}

/// A text field with its variables put in, bounded and without control characters.
pub fn checked_text(field: &str, raw: &str, req: &SourceQuery) -> Result<String, SourceError> {
    let value = with_variables(raw, req)?.trim().to_string();
    if value.is_empty() || value.chars().count() > MAX_TEXT || value.chars().any(char::is_control) {
        return Err(form_error(&format!("{field} needs 1 to {MAX_TEXT} characters without control characters")));
    }
    Ok(value)
}

/// A duration as both kinds take it: a number with `us`, `µs`, `ms`, `s`, `m` or `h` (`250ms`,
/// `1.5s`).
pub fn duration(field: &str, raw: &str, req: &SourceQuery) -> Result<String, SourceError> {
    let value = with_variables(raw, req)?.trim().to_string();
    let number_end = value.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(value.len());
    let (number, unit) = value.split_at(number_end);
    let ok = !number.is_empty()
        && number.parse::<f64>().is_ok_and(f64::is_finite)
        && matches!(unit, "us" | "µs" | "ms" | "s" | "m" | "h");
    if !ok {
        return Err(form_error(&format!("{field} is a duration such as 250ms, 1.5s or 2m")));
    }
    Ok(value)
}

/// A field of a query with its variables put in: `$name` and `${name}` become the variable's
/// text. The values go into URL parameters, which encode them, so nothing is escaped here.
pub fn with_variables(text: &str, req: &SourceQuery) -> Result<String, SourceError> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let (name, used) = if let Some(braced) = after.strip_prefix('{') {
            match braced.find('}') {
                Some(end) => (&braced[..end], end + 2),
                None => ("", 0),
            }
        } else {
            let len = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
            (&after[..len], len)
        };
        if name.is_empty() || name.starts_with("__") {
            out.push('$');
            rest = after;
            continue;
        }
        let value = req.variables.get(name).ok_or_else(|| {
            SourceError::rejected("promql.variable_missing", format!("variable {name} has no value")).with("name", name)
        })?;
        match value {
            Value::String(s) => out.push_str(s),
            Value::Number(n) => out.push_str(&n.to_string()),
            Value::Bool(b) => out.push_str(&b.to_string()),
            _ => {
                return Err(SourceError::rejected(
                    "promql.variable_type",
                    format!("variable {name} must be a string, number or boolean here"),
                )
                .with("name", name));
            }
        }
        rest = &after[used..];
    }
    out.push_str(rest);
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// The trace builder

/// What a span holds in memory, counted as the response budget counts values.
pub fn span_size(s: &Span) -> usize {
    const VALUE: usize = 32;
    let events: usize = s.events.iter().map(|e| string_size(&e.name) + map_size(&e.attributes)).sum();
    let links: usize =
        s.links.iter().map(|l| string_size(&l.trace_id) + string_size(&l.span_id) + map_size(&l.attributes)).sum();
    string_size(&s.trace_id)
        + string_size(&s.span_id)
        + s.parent_span_id.as_ref().map_or(VALUE, string_size)
        + string_size(&s.service)
        + string_size(&s.operation)
        + s.status_message.as_ref().map_or(VALUE, string_size)
        // start, duration, status and kind
        + 4 * VALUE
        + map_size(&s.attributes)
        + map_size(&s.resource)
        + events
        + links
        + s.scope.as_ref().map_or(0, |sc| string_size(&sc.name) + sc.version.as_ref().map_or(0, string_size))
}

/// Collects spans up to the row limit and the response budget; the first span that does not fit
/// ends the trace, which is then marked cut with a notice saying which limit cut it.
pub struct TraceBuilder {
    spans: Vec<Span>,
    /// Spans kept per trace (`MAX_SPANS_PER_TRACE`; smaller in tests).
    max_per_trace: usize,
    budget: ResponseBudget,
    truncated: Option<Truncated>,
    notices: Vec<Notice>,
    executed_query: Option<String>,
}

/// Spans kept per trace. A larger trace keeps its root spans and every error span, then the
/// earliest of the others (docs/guide/traces.md).
pub const MAX_SPANS_PER_TRACE: usize = 10_000;

impl TraceBuilder {
    pub fn new(budget: ResponseBudget) -> Self {
        Self::with_limit(MAX_SPANS_PER_TRACE, budget)
    }

    pub fn with_limit(max_per_trace: usize, budget: ResponseBudget) -> Self {
        Self {
            spans: Vec::new(),
            max_per_trace: max_per_trace.max(1),
            budget,
            truncated: None,
            notices: Vec::new(),
            executed_query: None,
        }
    }

    /// Adds a span; false (and nothing added) when the response size limit was reached.
    pub fn push(&mut self, span: Span) -> bool {
        if self.truncated.as_ref().is_some_and(|t| t.reason.as_deref() == Some("trace.size_limit")) {
            return false;
        }
        if !self.budget.take(span_size(&span)) {
            let kept = self.spans.len();
            self.cut(Detail::new("trace.size_limit", "the trace was cut off at the response size limit"), kept);
            return false;
        }
        self.spans.push(span);
        true
    }

    fn cut(&mut self, detail: Detail, limit: usize) {
        self.truncated = Some(Truncated { limit: limit as u32, reason: Some(detail.reason.to_string()) });
        self.notice(NoticeSeverity::Warning, detail);
    }

    pub fn notice(&mut self, severity: NoticeSeverity, detail: Detail) {
        let notice = detail.notice(severity);
        if !self.notices.contains(&notice) {
            self.notices.push(notice);
        }
    }

    pub fn executed_query(&mut self, query: impl Into<String>) {
        self.executed_query = Some(query.into());
    }

    /// The spans by trace, then by start time (then span id, so the order is fixed).
    ///
    /// A span id that appears twice in one trace (a client and a server span sharing it, as some
    /// tracers write them) gets `#2`, `#3`, ... on the later ones, so every span stays its own
    /// node; a notice says how many (`trace.span_id_duplicate`).
    ///
    /// A trace with more than the limit keeps exactly the limit: first its roots (no parent in
    /// the trace), then its error spans, then the earliest others; the set is marked cut
    /// (`trace.span_limit`, with the number of spans kept of those traces).
    pub fn finish(mut self) -> TraceSet {
        self.spans.sort_by(|a, b| {
            a.trace_id.cmp(&b.trace_id).then(a.start.cmp(&b.start)).then_with(|| a.span_id.cmp(&b.span_id))
        });
        let mut kept: Vec<Span> = Vec::with_capacity(self.spans.len());
        let mut cut: Vec<String> = Vec::new();
        let mut kept_of_cut = 0;
        let mut duplicates = 0;
        let mut rest = std::mem::take(&mut self.spans).into_iter().peekable();
        while let Some(first) = rest.next() {
            let mut trace = vec![first];
            while rest.peek().is_some_and(|s| s.trace_id == trace[0].trace_id) {
                trace.push(rest.next().expect("peeked"));
            }
            let mut seen: HashMap<String, usize> = HashMap::new();
            for s in &mut trace {
                let n = seen.entry(s.span_id.clone()).or_insert(0);
                *n += 1;
                if *n > 1 {
                    s.span_id = format!("{}#{n}", s.span_id);
                    duplicates += 1;
                }
            }
            if trace.len() <= self.max_per_trace {
                kept.extend(trace);
                continue;
            }
            cut.push(trace[0].trace_id.clone());
            let ids: std::collections::HashSet<String> = trace.iter().map(|s| s.span_id.clone()).collect();
            // 0: roots, 1: errors, 2: the others; within each, the start order of `trace`.
            let rank = |s: &Span| {
                if s.parent_span_id.as_ref().is_none_or(|p| !ids.contains(p)) {
                    0
                } else if s.status == SpanStatus::Error {
                    1
                } else {
                    2
                }
            };
            let mut order: Vec<usize> = (0..trace.len()).collect();
            order.sort_by_key(|&i| (rank(&trace[i]), i));
            let mut take = vec![false; trace.len()];
            for &i in order.iter().take(self.max_per_trace) {
                take[i] = true;
            }
            kept_of_cut += self.max_per_trace;
            kept.extend(trace.into_iter().zip(take).filter_map(|(s, t)| t.then_some(s)));
        }
        self.spans = kept;
        if duplicates > 0 {
            let message =
                format!("{duplicates} spans share their id with another span of their trace; they got #2, #3, ...");
            self.notice(
                NoticeSeverity::Info,
                Detail::new("trace.span_id_duplicate", message).with("count", duplicates),
            );
        }
        if !cut.is_empty() {
            let max = self.max_per_trace;
            let message = format!(
                "{} traces have more than {max} spans; {kept_of_cut} spans of them are kept, roots and errors first",
                cut.len()
            );
            let detail = Detail::new("trace.span_limit", message)
                .with("limit", max)
                .with("traces", cut.len())
                .with("kept", kept_of_cut);
            if self.truncated.is_none() {
                self.truncated = Some(Truncated { limit: max as u32, reason: Some("trace.span_limit".into()) });
            }
            self.notice(NoticeSeverity::Warning, detail);
        }
        TraceSet {
            spans: self.spans,
            truncated: self.truncated,
            notices: self.notices,
            executed_query: self.executed_query,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// OTLP JSON (Tempo)

/// Unix microseconds from nanoseconds as OTLP JSON writes them (a string or a number).
fn nanos(v: &Value) -> Option<i128> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_i64().map(i128::from).or_else(|| n.as_f64().map(|f| f as i128)),
        _ => None,
    }
}

/// An OTLP `AnyValue` as JSON: text, a number (an `intValue` beyond 2^53 as text, so it keeps
/// every digit), a bool, a list, an object, bytes as base64 text.
fn any_value(v: &Value) -> Value {
    const SAFE: i64 = 1 << 53;
    if let Some(s) = v.get("stringValue") {
        return s.clone();
    }
    if let Some(b) = v.get("boolValue") {
        return b.clone();
    }
    if let Some(i) = v.get("intValue") {
        let n = match i {
            Value::String(s) => s.parse::<i64>().ok(),
            Value::Number(n) => n.as_i64(),
            _ => None,
        };
        return match n {
            Some(n) if (-SAFE..=SAFE).contains(&n) => json!(n),
            Some(n) => json!(n.to_string()),
            None => i.clone(),
        };
    }
    if let Some(d) = v.get("doubleValue") {
        return match d {
            Value::String(s) => {
                s.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or(d.clone(), Value::Number)
            }
            other => other.clone(),
        };
    }
    if let Some(list) = v.get("arrayValue") {
        return Value::Array(list["values"].as_array().map(|a| a.iter().map(any_value).collect()).unwrap_or_default());
    }
    if let Some(kv) = v.get("kvlistValue") {
        return Value::Object(key_values(&kv["values"]).into_iter().collect());
    }
    if let Some(bytes) = v.get("bytesValue") {
        return bytes.clone();
    }
    Value::Null
}

/// OTLP attributes (`[{"key", "value": AnyValue}]`) as a map.
fn key_values(list: &Value) -> BTreeMap<String, Value> {
    list.as_array()
        .map(|a| {
            a.iter().filter_map(|kv| kv["key"].as_str().map(|k| (k.to_string(), any_value(&kv["value"])))).collect()
        })
        .unwrap_or_default()
}

fn otlp_kind(v: &Value) -> SpanKind {
    let code = match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => match s.as_str() {
            "SPAN_KIND_INTERNAL" => 1,
            "SPAN_KIND_SERVER" => 2,
            "SPAN_KIND_CLIENT" => 3,
            "SPAN_KIND_PRODUCER" => 4,
            "SPAN_KIND_CONSUMER" => 5,
            _ => 0,
        },
        _ => 0,
    };
    match code {
        1 => SpanKind::Internal,
        2 => SpanKind::Server,
        3 => SpanKind::Client,
        4 => SpanKind::Producer,
        5 => SpanKind::Consumer,
        _ => SpanKind::Unspecified,
    }
}

fn otlp_status(v: &Value) -> SpanStatus {
    match &v["code"] {
        Value::Number(n) if n.as_i64() == Some(1) => SpanStatus::Ok,
        Value::Number(n) if n.as_i64() == Some(2) => SpanStatus::Error,
        Value::String(s) if s == "STATUS_CODE_OK" => SpanStatus::Ok,
        Value::String(s) if s == "STATUS_CODE_ERROR" => SpanStatus::Error,
        _ => SpanStatus::Unset,
    }
}

/// The spans of an OTLP JSON trace (Tempo's `batches`, or `resourceSpans`, also inside `trace`).
/// Returns false when the builder is full.
pub fn otlp_spans(doc: &Value, out: &mut TraceBuilder) -> bool {
    let root = if doc.get("trace").is_some_and(Value::is_object) { &doc["trace"] } else { doc };
    let empty = Vec::new();
    let resources = root["batches"].as_array().or(root["resourceSpans"].as_array()).unwrap_or(&empty);
    for resource in resources {
        let mut attributes = key_values(&resource["resource"]["attributes"]);
        let service = match attributes.remove("service.name") {
            Some(Value::String(s)) => s,
            Some(other) => other.to_string(),
            None => String::new(),
        };
        let scopes = resource["scopeSpans"].as_array().or(resource["instrumentationLibrarySpans"].as_array());
        for scope in scopes.unwrap_or(&empty) {
            let named = if scope["scope"].is_object() { &scope["scope"] } else { &scope["instrumentationLibrary"] };
            let span_scope = named["name"].as_str().filter(|n| !n.is_empty()).map(|name| SpanScope {
                name: name.to_string(),
                version: named["version"].as_str().filter(|v| !v.is_empty()).map(str::to_string),
            });
            for s in scope["spans"].as_array().unwrap_or(&empty) {
                let start = nanos(&s["startTimeUnixNano"]).unwrap_or(0);
                let end = nanos(&s["endTimeUnixNano"]).unwrap_or(start);
                let parent = hex_id(s["parentSpanId"].as_str().unwrap_or(""));
                let span = Span {
                    trace_id: hex_id(s["traceId"].as_str().unwrap_or("")),
                    span_id: hex_id(s["spanId"].as_str().unwrap_or("")),
                    parent_span_id: (!parent.is_empty()).then_some(parent),
                    service: service.clone(),
                    operation: s["name"].as_str().unwrap_or_default().to_string(),
                    start: start.div_euclid(1000) as i64,
                    duration: (end - start).max(0) as f64 / 1000.0,
                    status: otlp_status(&s["status"]),
                    status_message: s["status"]["message"].as_str().filter(|m| !m.is_empty()).map(str::to_string),
                    kind: otlp_kind(&s["kind"]),
                    attributes: key_values(&s["attributes"]),
                    resource: attributes.clone(),
                    scope: span_scope.clone(),
                    events: s["events"]
                        .as_array()
                        .unwrap_or(&empty)
                        .iter()
                        .map(|e| SpanEvent {
                            time: nanos(&e["timeUnixNano"]).unwrap_or(0).div_euclid(1000) as i64,
                            name: e["name"].as_str().unwrap_or_default().to_string(),
                            attributes: key_values(&e["attributes"]),
                        })
                        .collect(),
                    links: s["links"]
                        .as_array()
                        .unwrap_or(&empty)
                        .iter()
                        .map(|l| SpanLink {
                            trace_id: hex_id(l["traceId"].as_str().unwrap_or("")),
                            span_id: hex_id(l["spanId"].as_str().unwrap_or("")),
                            attributes: key_values(&l["attributes"]),
                        })
                        .collect(),
                };
                if !out.push(span) {
                    return false;
                }
            }
        }
    }
    true
}

// ---------------------------------------------------------------------------------------------
// Jaeger JSON

/// A Jaeger tag value (`{"key", "type", "value"}`) as JSON; `int64` beyond 2^53 as text.
fn jaeger_value(tag: &Value) -> Value {
    let v = &tag["value"];
    match (tag["type"].as_str(), v) {
        (Some("int64"), Value::Number(n)) if n.as_i64().is_some_and(|i| i.unsigned_abs() > 1 << 53) => {
            json!(n.to_string())
        }
        _ => v.clone(),
    }
}

/// Whether Jaeger's `error` tag marks a failed span: `true`, or the text `true` in any case.
/// `false`, `"false"` and anything else do not.
pub fn error_tag(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => s.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn jaeger_tags(list: &Value) -> BTreeMap<String, Value> {
    list.as_array()
        .map(|a| a.iter().filter_map(|t| t["key"].as_str().map(|k| (k.to_string(), jaeger_value(t)))).collect())
        .unwrap_or_default()
}

/// The spans of one Jaeger trace (`{"traceID", "spans", "processes"}`); the first `CHILD_OF`
/// reference (else the first reference) is the parent, the others are links. `span.kind`,
/// `error`, `otel.status_code` and `otel.status_description` become the span's kind and status.
/// Returns false when the builder is full.
pub fn jaeger_spans(trace: &Value, out: &mut TraceBuilder) -> bool {
    let empty = Vec::new();
    let processes = &trace["processes"];
    for s in trace["spans"].as_array().unwrap_or(&empty) {
        let process = &processes[s["processID"].as_str().unwrap_or_default()];
        let process = if process.is_object() { process } else { &s["process"] };
        let mut attributes = jaeger_tags(&s["tags"]);
        let kind = match attributes.remove("span.kind").as_ref().and_then(Value::as_str) {
            Some("server") => SpanKind::Server,
            Some("client") => SpanKind::Client,
            Some("producer") => SpanKind::Producer,
            Some("consumer") => SpanKind::Consumer,
            Some("internal") => SpanKind::Internal,
            _ => SpanKind::Unspecified,
        };
        let error = attributes.remove("error").is_some_and(|v| error_tag(&v));
        let status = match attributes.remove("otel.status_code").as_ref().and_then(Value::as_str) {
            Some("ERROR") => SpanStatus::Error,
            Some("OK") => SpanStatus::Ok,
            _ if error => SpanStatus::Error,
            _ => SpanStatus::Unset,
        };
        let status_message = match attributes.remove("otel.status_description") {
            Some(Value::String(m)) if !m.is_empty() => Some(m),
            _ => None,
        };
        // The scope as Jaeger's OTLP import writes it (`otel.scope.*`, older `otel.library.*`).
        let mut text = |keys: [&str; 2]| match keys.iter().find_map(|k| attributes.remove(*k)) {
            Some(Value::String(s)) if !s.is_empty() => Some(s),
            _ => None,
        };
        let scope_name = text(["otel.scope.name", "otel.library.name"]);
        let scope_version = text(["otel.scope.version", "otel.library.version"]);
        let scope = scope_name.map(|name| SpanScope { name, version: scope_version });
        let refs = s["references"].as_array().unwrap_or(&empty);
        let parent_at = refs.iter().position(|r| r["refType"] == "CHILD_OF").or((!refs.is_empty()).then_some(0));
        let parent_span_id = parent_at.map(|i| hex_id(refs[i]["spanID"].as_str().unwrap_or("")));
        let links = refs
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != parent_at)
            .map(|(_, r)| SpanLink {
                trace_id: hex_id(r["traceID"].as_str().unwrap_or("")),
                span_id: hex_id(r["spanID"].as_str().unwrap_or("")),
                attributes: BTreeMap::from([(
                    "jaeger.refType".to_string(),
                    r["refType"].as_str().map_or(Value::Null, |t| json!(t)),
                )]),
            })
            .collect();
        let events = s["logs"]
            .as_array()
            .unwrap_or(&empty)
            .iter()
            .map(|log| {
                let mut fields = jaeger_tags(&log["fields"]);
                let name = match fields.remove("event") {
                    Some(Value::String(n)) => n,
                    _ => "log".to_string(),
                };
                SpanEvent { time: log["timestamp"].as_i64().unwrap_or(0), name, attributes: fields }
            })
            .collect();
        let span = Span {
            trace_id: hex_id(s["traceID"].as_str().unwrap_or("")),
            span_id: hex_id(s["spanID"].as_str().unwrap_or("")),
            parent_span_id: parent_span_id.filter(|p| !p.is_empty()),
            service: process["serviceName"].as_str().unwrap_or_default().to_string(),
            operation: s["operationName"].as_str().unwrap_or_default().to_string(),
            start: s["startTime"].as_i64().unwrap_or(0),
            duration: s["duration"].as_f64().unwrap_or(0.0),
            status,
            status_message,
            kind,
            attributes,
            resource: jaeger_tags(&process["tags"]),
            scope,
            events,
            links,
        };
        if !out.push(span) {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------------------------
// Lists as frames

/// One trace of a search result list.
pub struct TraceSummary {
    pub trace_id: String,
    pub root_service: Option<String>,
    pub root_operation: Option<String>,
    /// Unix microseconds.
    pub start: i64,
    /// Milliseconds.
    pub duration_ms: f64,
    /// Further number columns of the kind (`matchedSpans`, `spans`, `errors`).
    pub counts: Vec<(&'static str, u64)>,
}

/// The search result list as a frame: `traceId`, `rootService`, `rootOperation`, `start`
/// (time), `duration` (milliseconds) and the kind's counts, one row per trace, within the row
/// limit and the budget. `limit` is the number of traces the search asked for and `found` the
/// number the source answered (before a filter of Kalzit's own): as many as asked for means there
/// may be more.
pub fn summaries_frame(rows: Vec<TraceSummary>, found: usize, req: &SourceQuery, limit: usize, query: String) -> Frame {
    let count_names: Vec<&'static str> =
        rows.first().map(|r| r.counts.iter().map(|c| c.0).collect()).unwrap_or_default();
    let mut columns = vec![
        Column::new("traceId", Some(FieldType::String)),
        Column::new("rootService", Some(FieldType::String)),
        Column::new("rootOperation", Some(FieldType::String)),
        Column::new("start", Some(FieldType::Time)),
        Column::new("duration", Some(FieldType::Number)),
    ];
    columns.extend(count_names.iter().map(|n| Column::new(*n, Some(FieldType::Number))));
    let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
    frame.executed_query(query);
    for r in rows {
        let mut row = vec![
            json!(r.trace_id),
            r.root_service.map_or(Value::Null, Value::String),
            r.root_operation.map_or(Value::Null, Value::String),
            json!(r.start.div_euclid(1000)),
            serde_json::Number::from_f64(r.duration_ms).map_or(Value::Null, Value::Number),
        ];
        row.extend(count_names.iter().map(|n| r.counts.iter().find(|c| c.0 == *n).map_or(Value::Null, |c| json!(c.1))));
        if !frame.push_row(row) {
            break;
        }
    }
    if found >= limit && !frame.is_full() {
        let message = format!("the search asked for {limit} traces; there may be more");
        frame.mark_truncated(Detail::new("trace.search_limit", message).with("limit", limit));
    }
    with_unit(frame.finish(), "duration", "ms")
}

/// A one-column frame of names (services, operations, tag values), in the source's order.
pub fn names_frame(
    column: &str,
    names: Vec<(String, Option<String>)>,
    second: Option<&str>,
    req: &SourceQuery,
) -> Frame {
    let mut columns = vec![Column::new(column, Some(FieldType::String))];
    if let Some(second) = second {
        columns.push(Column::new(second, Some(FieldType::String)));
    }
    let mut frame = FrameBuilder::new(columns, req.limits.max_rows, req.limits.budget.clone());
    for (name, extra) in names {
        let mut row = vec![json!(name)];
        if second.is_some() {
            row.push(extra.map_or(Value::Null, Value::String));
        }
        if !frame.push_row(row) {
            break;
        }
    }
    frame.finish()
}

/// The frame with `unit` on the field `name` (the builder knows no units).
fn with_unit(frame: Frame, name: &str, unit: &str) -> Frame {
    let fields: Vec<Field> = frame
        .fields()
        .iter()
        .cloned()
        .map(|mut f| {
            if f.name == name {
                f.unit = Some(unit.to_string());
            }
            f
        })
        .collect();
    let meta = frame.meta().cloned();
    let out = Frame::new(fields).expect("the same fields");
    match meta {
        Some(meta) => out.with_meta(meta),
        None => out,
    }
}

/// The names in a JSON list (`["a", "b"]`), up to `max`.
pub fn names(data: &Value, max: usize) -> Vec<String> {
    data.as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).take(max).collect())
        .unwrap_or_default()
}

/// Bound search tags (`{"http.status_code": "500"}`) as Jaeger's `tags` parameter.
pub fn tags_json(tags: &BTreeMap<String, String>) -> String {
    let map: Map<String, Value> = tags.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect();
    Value::Object(map).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::shapes::TimeRange;

    pub(crate) fn req(vars: Value, max_rows: usize) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 1_800_000_000_000, to: 1_800_003_600_000 },
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(vars).unwrap(),
            identifier_variables: None,
            limits: Limits {
                timeout: Duration::from_secs(5),
                max_rows,
                budget: ResponseBudget::new(1 << 20),
                pattern: Default::default(),
            },
            cursor: None,
            filters: Vec::new(),
        }
    }

    #[test]
    fn trace_ids_are_hex_only() {
        assert_eq!(check_trace_id(" 4BF92F3577B34DA6A3CE929D0E0E4736 ").unwrap(), "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(check_trace_id("abc").unwrap(), "0000000000000abc");
        assert_eq!(check_trace_id("1234567890abcdef1").unwrap(), "0000000000000001234567890abcdef1");
        for bad in ["", "xyz", "../api", "a/b", "4bf92f3577b34da6a3ce929d0e0e47361", "12 34"] {
            let e = check_trace_id(bad).unwrap_err();
            assert_eq!(e.detail().reason, "trace.id_invalid", "{bad}");
        }
    }

    #[test]
    fn ids_come_as_hex_or_base64() {
        assert_eq!(hex_id("S/kvNXezTaajzpKdDg5HNg=="), "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(hex_id("S/kvNXezTaY="), "4bf92f3577b34da6");
        assert_eq!(hex_id("4BF92F3577B34DA6"), "4bf92f3577b34da6");
        assert_eq!(hex_id("2f3e0cee77ae5dc9c17ade3689eb2e5"), "02f3e0cee77ae5dc9c17ade3689eb2e5");
        assert_eq!(hex_id(""), "");
    }

    /// Jaeger writes a 128-bit id with a zero high half as 64 bits; the answer to a trace by id
    /// carries the id asked for. Another trace's id stays as it is.
    #[test]
    fn a_trace_by_id_carries_the_id_asked_for() {
        let asked = "000000000000000018e80595910894d3";
        let mut trace = TraceSet {
            spans: vec![
                span("18e80595910894d3", "a", None, 1, SpanStatus::Unset),
                span("ffff", "b", None, 2, SpanStatus::Unset),
            ],
            ..TraceSet::default()
        };
        as_asked(&mut trace, asked);
        assert_eq!(trace.spans[0].trace_id, asked);
        assert_eq!(trace.spans[1].trace_id, "ffff");
        assert_eq!(hex_id_128("ab"), "000000000000000000000000000000ab");
        assert_eq!(hex_id_128(""), "");
    }

    #[test]
    fn variables_go_in_as_text() {
        let r = req(json!({ "svc": "kasse", "n": 5, "list": ["a"] }), 10);
        assert_eq!(with_variables("$svc-${svc}/$n $__x", &r).unwrap(), "kasse-kasse/5 $__x");
        assert_eq!(with_variables("kosten $ 5", &r).unwrap(), "kosten $ 5");
        assert_eq!(with_variables("$nope", &r).unwrap_err().detail().reason, "promql.variable_missing");
        assert_eq!(with_variables("$list", &r).unwrap_err().detail().reason, "promql.variable_type");
    }

    #[test]
    fn searches_bind_their_variables_and_write_traceql() {
        let r = req(json!({ "svc": "kas\"se", "n": 502 }), 10);
        let fields: SearchFields = serde_json::from_value(json!({
            "service": "$svc", "operation": "POST /pay", "status": "error",
            "tags": { "http.status_code": "$n", "span.peer": "db 1", "resource.region": "eu" },
            "minDuration": "250ms", "maxDuration": "2s"
        }))
        .unwrap();
        let search = fields.bind(&r).unwrap();
        assert_eq!(search.service.as_deref(), Some("kas\"se"));
        assert_eq!(
            traceql(&search),
            r#"{ resource.service.name = "kas\"se" && name = "POST /pay" && .http.status_code = 502 && resource.region = "eu" && span.peer = "db 1" && duration >= 250ms && duration <= 2s && status = error }"#
        );
        assert_eq!(tags_json(&search.tags), r#"{"http.status_code":"502","resource.region":"eu","span.peer":"db 1"}"#);
        assert_eq!(traceql(&Search::default()), "{}");
        assert!(SearchFields::default().is_empty());
        let bad = |v: Value| {
            serde_json::from_value::<SearchFields>(v).map_err(|_| ()).and_then(|f| f.bind(&r).map_err(|_| ()))
        };
        assert!(bad(json!({ "tags": { "a b": "x" } })).is_err());
        assert!(bad(json!({ "minDuration": "soon" })).is_err());
        assert!(bad(json!({ "service": " " })).is_err());
        assert!(bad(json!({ "status": "broken" })).is_err());
        assert_eq!(search_limit(None, 100), 100);
        assert_eq!(search_limit(Some(5000), 20), MAX_SEARCH_LIMIT);
        assert_eq!(search_limit(Some(0), 20), 1);
    }

    fn span(trace: &str, id: &str, parent: Option<&str>, start: i64, status: SpanStatus) -> Span {
        Span {
            trace_id: trace.into(),
            span_id: id.into(),
            parent_span_id: parent.map(str::to_string),
            service: "s".into(),
            operation: "o".into(),
            start,
            duration: 1.0,
            status,
            status_message: None,
            kind: SpanKind::Internal,
            attributes: BTreeMap::new(),
            resource: BTreeMap::new(),
            scope: None,
            events: vec![],
            links: vec![],
        }
    }

    /// A trace beyond the limit keeps its root and its errors, then the earliest others.
    #[test]
    fn the_builder_keeps_roots_and_errors_of_a_long_trace() {
        let mut b = TraceBuilder::with_limit(3, ResponseBudget::new(1 << 20));
        assert!(b.push(span("t", "a", None, 1, SpanStatus::Unset)));
        for (i, id) in ["b", "c", "d", "e"].iter().enumerate() {
            assert!(b.push(span("t", id, Some("a"), 2 + i as i64, SpanStatus::Ok)));
        }
        assert!(b.push(span("t", "z", Some("a"), 10, SpanStatus::Error)));
        assert!(b.push(span("u", "x", None, 1, SpanStatus::Unset)));
        let set = b.finish();
        let ids: Vec<&str> = set.spans.iter().map(|s| s.span_id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "z", "x"], "root, the error, the earliest other; the short trace whole");
        assert_eq!(set.truncated, Some(Truncated { limit: 3, reason: Some("trace.span_limit".into()) }));
        assert_eq!(set.notices[0].code, "trace.span_limit");
        let params = set.notices[0].params.as_ref().unwrap();
        assert_eq!((params["traces"].as_str(), params["kept"].as_str()), ("1", "3"));
    }

    /// The cap is hard: more roots and errors than the limit still keep only the limit, roots
    /// first, then errors, each in start order.
    #[test]
    fn the_span_cap_holds_with_many_roots_and_errors() {
        let mut b = TraceBuilder::with_limit(3, ResponseBudget::new(1 << 20));
        assert!(b.push(span("t", "r1", None, 1, SpanStatus::Unset)));
        assert!(b.push(span("t", "e1", Some("r1"), 2, SpanStatus::Error)));
        assert!(b.push(span("t", "r2", Some("gone"), 3, SpanStatus::Unset)));
        assert!(b.push(span("t", "e2", Some("r1"), 4, SpanStatus::Error)));
        assert!(b.push(span("t", "e3", Some("r1"), 5, SpanStatus::Error)));
        let set = b.finish();
        let ids: Vec<&str> = set.spans.iter().map(|s| s.span_id.as_str()).collect();
        assert_eq!(ids, ["r1", "e1", "r2"]);
    }

    /// A span id shared by two spans of a trace (client and server) stays two spans.
    #[test]
    fn shared_span_ids_are_told_apart() {
        let mut b = TraceBuilder::new(ResponseBudget::new(1 << 20));
        assert!(b.push(span("t", "a", None, 1, SpanStatus::Unset)));
        assert!(b.push(span("t", "a", Some("a"), 2, SpanStatus::Unset)));
        assert!(b.push(span("t", "a", Some("a"), 3, SpanStatus::Unset)));
        assert!(b.push(span("u", "a", None, 1, SpanStatus::Unset)));
        let set = b.finish();
        let ids: Vec<&str> = set.spans.iter().map(|s| s.span_id.as_str()).collect();
        assert_eq!(ids, ["a", "a#2", "a#3", "a"], "per trace");
        assert_eq!(set.notices[0].code, "trace.span_id_duplicate");
        assert_eq!(set.notices[0].params.as_ref().unwrap()["count"], "2");
        let tree = crate::analysis::trace::span_tree(&set);
        let nodes: std::collections::BTreeSet<&str> = tree.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(nodes.len(), 4, "every span its own node");
    }

    #[test]
    fn only_a_true_error_tag_marks_an_error() {
        for yes in [json!(true), json!("true"), json!("TRUE")] {
            assert!(error_tag(&yes), "{yes}");
        }
        for no in [json!(false), json!("false"), json!("1"), json!(1), Value::Null] {
            assert!(!error_tag(&no), "{no}");
        }
    }

    #[test]
    fn the_response_size_limit_cuts_a_trace() {
        let mut small = TraceBuilder::new(ResponseBudget::new(10));
        assert!(!small.push(span("t", "a", None, 1, SpanStatus::Unset)));
        assert_eq!(small.finish().truncated.unwrap().reason.as_deref(), Some("trace.size_limit"));
    }

    #[test]
    fn the_builder_orders_by_trace_and_start() {
        let span = |id: &str, start: i64| Span {
            trace_id: "t".into(),
            span_id: id.into(),
            parent_span_id: None,
            service: "s".into(),
            operation: "o".into(),
            start,
            duration: 1.0,
            status: SpanStatus::Unset,
            status_message: None,
            kind: SpanKind::Internal,
            attributes: BTreeMap::new(),
            resource: BTreeMap::new(),
            scope: None,
            events: vec![],
            links: vec![],
        };
        let mut b = TraceBuilder::new(ResponseBudget::new(1 << 20));
        assert!(b.push(span("b", 2)));
        assert!(b.push(span("a", 1)));
        let set = b.finish();
        assert_eq!(set.spans.iter().map(|s| s.span_id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(set.truncated.is_none() && set.notices.is_empty());
    }

    #[test]
    fn otlp_json_becomes_spans() {
        let doc: Value = serde_json::from_str(include_str!("../../tests/fixtures/traces/tempo_trace.json")).unwrap();
        let mut b = TraceBuilder::new(ResponseBudget::new(1 << 20));
        assert!(otlp_spans(&doc, &mut b));
        let set = b.finish();
        assert_eq!(set.spans.len(), 3);
        let root = &set.spans[0];
        assert_eq!(root.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
        assert_eq!(root.span_id, "00f067aa0ba902b7");
        assert_eq!(root.parent_span_id, None);
        assert_eq!(root.service, "frontend");
        assert_eq!(root.operation, "GET /cart");
        assert_eq!(root.kind, SpanKind::Server);
        assert_eq!(root.start, 1_800_000_000_000_000);
        assert_eq!(root.duration, 120_000.5);
        assert_eq!(root.resource["host.name"], "web-1");
        assert!(!root.resource.contains_key("service.name"));
        assert_eq!(root.scope, Some(SpanScope { name: "kalzit-test".into(), version: Some("1.0".into()) }));
        assert_eq!(set.spans[1].scope, None, "a scope without a name");
        assert_eq!(root.attributes["http.status_code"], 200);
        assert_eq!(root.attributes["big"], "9007199254740993");
        assert_eq!(root.attributes["ratio"], 0.5);
        assert_eq!(root.attributes["tags"], json!(["a", true]));
        assert_eq!(root.attributes["obj"], json!({ "k": "v" }));
        let child = &set.spans[1];
        assert_eq!(child.parent_span_id.as_deref(), Some("00f067aa0ba902b7"));
        assert_eq!(child.service, "cart");
        assert_eq!(child.status, SpanStatus::Error);
        assert_eq!(child.status_message.as_deref(), Some("redis down"));
        assert_eq!(child.kind, SpanKind::Client);
        assert_eq!(child.events[0].name, "exception");
        assert_eq!(child.events[0].time, 1_800_000_000_050_000);
        assert_eq!(child.events[0].attributes["exception.message"], "timeout");
        assert_eq!(child.links[0].span_id, "00f067aa0ba902b7");
        // Numeric kinds and codes as older Tempo versions send them.
        assert_eq!(set.spans[2].kind, SpanKind::Internal);
        assert_eq!(set.spans[2].status, SpanStatus::Ok);
    }

    #[test]
    fn jaeger_json_becomes_spans() {
        let doc: Value = serde_json::from_str(include_str!("../../tests/fixtures/traces/jaeger_trace.json")).unwrap();
        let mut b = TraceBuilder::new(ResponseBudget::new(1 << 20));
        assert!(jaeger_spans(&doc["data"][0], &mut b));
        let set = b.finish();
        assert_eq!(set.spans.len(), 3);
        let root = &set.spans[0];
        // A 64-bit id without its leading zeros, as Jaeger writes it.
        assert_eq!(root.trace_id, "0af7651916cd43dd");
        assert_eq!(root.span_id, "00000000000000a1");
        assert_eq!(root.service, "frontend");
        assert_eq!(root.kind, SpanKind::Server);
        assert_eq!(root.resource["hostname"], "web-1");
        assert!(!root.attributes.contains_key("span.kind") && !root.attributes.contains_key("otel.scope.name"));
        assert_eq!(root.scope, Some(SpanScope { name: "shop-sdk".into(), version: None }));
        let child = &set.spans[1];
        assert_eq!(child.parent_span_id.as_deref(), Some(root.span_id.as_str()));
        assert_eq!(child.status, SpanStatus::Error);
        assert_eq!(child.status_message.as_deref(), Some("redis down"));
        assert_eq!(child.events[0].name, "exception");
        assert_eq!(child.events[0].attributes["message"], "timeout");
        assert_eq!(child.links.len(), 1);
        assert_eq!(child.links[0].attributes["jaeger.refType"], "FOLLOWS_FROM");
        assert_eq!(set.spans[2].attributes["big"], "9007199254740993");
    }

    #[test]
    fn search_lists_say_when_there_may_be_more() {
        let row = |id: &str| TraceSummary {
            trace_id: id.into(),
            root_service: Some("frontend".into()),
            root_operation: None,
            start: 1_800_000_000_000_500,
            duration_ms: 12.5,
            counts: vec![("matchedSpans", 2)],
        };
        let r = req(json!({}), 100);
        let frame = summaries_frame(vec![row("a"), row("b")], 2, &r, 2, "{}".into());
        assert_eq!(frame.rows(), 2);
        let names: Vec<&str> = frame.fields().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["traceId", "rootService", "rootOperation", "start", "duration", "matchedSpans"]);
        assert_eq!(frame.fields()[3].values[0], json!(1_800_000_000_000_i64));
        assert_eq!(frame.fields()[4].unit.as_deref(), Some("ms"));
        assert_eq!(frame.fields()[2].values[0], Value::Null);
        let meta = frame.meta().unwrap();
        assert!(meta.rows_truncated);
        assert_eq!(meta.notices[0].code, "trace.search_limit");
        let frame = summaries_frame(vec![row("a")], 1, &r, 2, "{}".into());
        assert!(!frame.meta().unwrap().rows_truncated);
        let empty = summaries_frame(vec![], 0, &r, 2, "{}".into());
        assert_eq!(empty.fields().len(), 5);
    }
}
