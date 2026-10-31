//! SCIM 2.0 provisioning (RFC 7643, RFC 7644; docs/api/scim.md): an organization's directory
//! (Entra ID, Okta, ...) creates, changes and deactivates the people and groups of that
//! organization with the organization's SCIM token. Nothing is ever deleted: a DELETE deactivates
//! like `active: false`, so dashboards and the audit log stay intact.
//!
//! Every request names its organization in the path (`/scim/v2/o/{orgId}/...`) and carries that
//! organization's SCIM token; both are checked on every request (`auth::api_token`), and a refused
//! token is counted, rate-limited and audited like a service account token. The token works on
//! these routes only, and service account tokens never work here.
//!
//! Groups go through the group mapping (`sso::mapping`): the rules that give a role in this
//! organization, whichever provider they were made for, match a group's `displayName` or
//! `externalId`. SCIM never touches service accounts, the break-glass admin, the last owner of the
//! organization or a server admin's account.

mod filter;
mod groups;
mod patch;
mod provision;
mod schema;
mod users;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Router};
use serde_json::{Value, json};

use crate::app::AppState;
use crate::auth::api_token::{self, ScimCaller};
use crate::error::ApiError;
use crate::net::RequestInfo;

/// Where the SCIM routes start; an organization's base URL is `{PREFIX}/o/{orgId}`.
pub const PREFIX: &str = "/scim/v2";
pub const CONTENT_TYPE: &str = "application/scim+json";
pub const ERROR_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:Error";
pub const LIST_SCHEMA: &str = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
/// A page holds at most this many resources, and this many when `count` is not given.
pub const MAX_RESULTS: i64 = 200;
pub const DEFAULT_COUNT: i64 = 100;
/// Requests larger than this are refused before they are read.
pub const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The SCIM routes: one route for everything below `PREFIX`, since every answer, also "no such
/// route", is a SCIM message and every request is signed in with the SCIM token first.
#[expect(clippy::disallowed_methods, reason = "SCIM routes sign in with the organization's SCIM token in `handle`")]
pub fn router() -> Router<AppState> {
    Router::new()
        .route(&format!("{PREFIX}/{{*rest}}"), axum::routing::any(handle))
        .route(PREFIX, axum::routing::any(|| async { ScimError::not_found().into_response() }))
}

/// The organization's base URL for directories: `server.public_url` (or the request's host) with
/// `/scim/v2/o/{orgId}`.
pub fn base_url(state: &AppState, info: &RequestInfo, org_id: &str) -> String {
    format!("{}{PREFIX}/o/{org_id}", crate::sso::public_base(state, info))
}

/// An error in the form of RFC 7644, section 3.12. `reason` is Kalzit's own code (docs/api/scim.md,
/// "Reasons"), written to the audit log next to a refused change.
#[derive(Debug)]
pub struct ScimError {
    pub status: StatusCode,
    pub scim_type: Option<&'static str>,
    pub detail: String,
    pub reason: Option<&'static str>,
    retry_after_secs: Option<u32>,
}

impl ScimError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self { status, scim_type: None, detail: detail.into(), reason: None, retry_after_secs: None }
    }

    pub fn scim_type(mut self, scim_type: &'static str) -> Self {
        self.scim_type = Some(scim_type);
        self
    }

    pub fn because(mut self, reason: &'static str) -> Self {
        self.reason = Some(reason);
        self
    }

    /// `400` with a `scimType`.
    pub fn bad(scim_type: &'static str, detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail).scim_type(scim_type)
    }

    /// `409 uniqueness`.
    pub fn taken(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, detail).scim_type("uniqueness")
    }

    /// `403`: SCIM may not do this to this account or membership.
    pub fn protected(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, detail)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "no such resource")
    }

    fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "the SCIM token is missing or not valid")
    }
}

impl From<ApiError> for ScimError {
    fn from(e: ApiError) -> Self {
        let mut out = Self::new(e.status, e.message);
        out.retry_after_secs = e.retry_after_secs.map(std::num::NonZeroU32::get);
        out
    }
}

impl From<sqlx::Error> for ScimError {
    fn from(e: sqlx::Error) -> Self {
        ApiError::from(e).into()
    }
}

impl IntoResponse for ScimError {
    fn into_response(self) -> Response {
        let mut body = json!({
            "schemas": [ERROR_SCHEMA],
            "status": self.status.as_u16().to_string(),
            "detail": self.detail,
        });
        if let Some(t) = self.scim_type {
            body["scimType"] = json!(t);
        }
        let mut res = scim_json(self.status, &body);
        if let Some(secs) = self.retry_after_secs {
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(secs));
        }
        if self.status == StatusCode::UNAUTHORIZED {
            res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        }
        res
    }
}

pub type ScimResult<T> = Result<T, ScimError>;

/// A SCIM answer: `body` as `application/scim+json`.
pub fn scim_json(status: StatusCode, body: &Value) -> Response {
    let mut res = (status, body.to_string()).into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(CONTENT_TYPE));
    res
}

/// A request that passed the token check: its organization, its token and how to name resources.
pub struct Ctx<'a> {
    pub state: &'a AppState,
    pub info: &'a RequestInfo,
    pub caller: &'a ScimCaller,
    pub org_id: &'a str,
    /// The organization's base URL (`base_url`).
    pub base: String,
    /// The sign-in settings a change needs (`provision::Policy`).
    pub policy: provision::Policy,
}

impl Ctx<'_> {
    pub fn location(&self, kind: &str, id: &str) -> String {
        format!("{}/{kind}/{id}", self.base)
    }
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    filter: Option<String>,
    start_index: Option<String>,
    count: Option<String>,
    excluded_attributes: Option<String>,
    attributes: Option<String>,
}

/// The page of a list: `startIndex` counts from 1; anything below is 1. `count` above
/// `MAX_RESULTS` is `MAX_RESULTS`, below 0 is 0 (only `totalResults`).
#[derive(Debug)]
pub struct Paging {
    pub start_index: i64,
    pub count: i64,
}

impl ListQuery {
    fn paging(&self) -> ScimResult<Paging> {
        let number = |raw: &Option<String>, what: &str| -> ScimResult<Option<i64>> {
            raw.as_deref()
                .map(|v| {
                    v.trim()
                        .parse::<i64>()
                        .map_err(|_| ScimError::bad("invalidValue", format!("{what} is not a number")))
                })
                .transpose()
        };
        let start_index = number(&self.start_index, "startIndex")?.unwrap_or(1).max(1);
        let count = number(&self.count, "count")?.unwrap_or(DEFAULT_COUNT).clamp(0, MAX_RESULTS);
        Ok(Paging { start_index, count })
    }

    /// Whether the answer leaves out `attr` (`excludedAttributes`, or `attributes` without it).
    fn excludes(&self, attr: &str) -> bool {
        let names = |raw: &Option<String>| -> Vec<String> {
            raw.as_deref()
                .unwrap_or_default()
                .split(',')
                .map(|a| a.trim().rsplit(':').next().unwrap_or_default().to_ascii_lowercase())
                .filter(|a| !a.is_empty())
                .collect()
        };
        let excluded = names(&self.excluded_attributes);
        let wanted = names(&self.attributes);
        excluded.iter().any(|a| a == attr) || (!wanted.is_empty() && !wanted.iter().any(|a| a == attr))
    }
}

/// A `ListResponse` of `resources`, the page `paging` of `total`.
pub fn list_response(total: i64, paging: &Paging, resources: Vec<Value>) -> Response {
    let body = json!({
        "schemas": [LIST_SCHEMA],
        "totalResults": total,
        "startIndex": paging.start_index,
        "itemsPerPage": resources.len(),
        "Resources": resources,
    });
    scim_json(StatusCode::OK, &body)
}

/// The body of a request as JSON; SCIM clients send `application/scim+json` or
/// `application/json`.
pub fn json_body(headers: &HeaderMap, body: &Bytes) -> ScimResult<Value> {
    let content_type = headers.get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let mime = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    if !mime.is_empty() && mime != CONTENT_TYPE && mime != "application/json" {
        return Err(ScimError::bad("invalidSyntax", format!("the content type {mime} is not JSON"))
            .because("scim.body_invalid"));
    }
    let value: Value = serde_json::from_slice(body).map_err(|e| {
        ScimError::bad("invalidSyntax", format!("the body is not JSON: {e}")).because("scim.body_invalid")
    })?;
    if !value.is_object() {
        return Err(ScimError::bad("invalidSyntax", "the body is not a JSON object").because("scim.body_invalid"));
    }
    Ok(value)
}

/// Unix ms as SCIM's `dateTime`.
pub fn date_time(ms: i64) -> String {
    crate::analysis::expr::iso_time(ms)
}

/// Every request below `PREFIX`: the path, the token and the organization's switch, then the
/// resource.
async fn handle(
    State(state): State<AppState>,
    Extension(info): Extension<RequestInfo>,
    Path(rest): Path<String>,
    Query(query): Query<Vec<(String, String)>>,
    method: Method,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Response {
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let (org_id, resource) = match segments.as_slice() {
        ["o", org, resource @ ..] if canonical_uuid(org) => (org.to_string(), resource.to_vec()),
        _ => return ScimError::not_found().into_response(),
    };
    let caller = match sign_in(&state, &info, &headers, &org_id).await {
        Ok(caller) => caller,
        Err(e) => return e.into_response(),
    };
    // Read with its limit here, so a body that is too large is answered as a SCIM message.
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
        return ScimError::new(StatusCode::PAYLOAD_TOO_LARGE, "the body is larger than 1 MiB")
            .because("scim.body_invalid")
            .into_response();
    };
    let writes = !matches!(method, Method::GET | Method::HEAD);
    let policy = if writes {
        match provision::Policy::load(&state, &org_id).await {
            Ok(policy) => policy,
            Err(e) => return e.into_response(),
        }
    } else {
        provision::Policy::none()
    };
    let ctx = Ctx {
        state: &state,
        info: &info,
        caller: &caller,
        org_id: &org_id,
        base: base_url(&state, &info, &org_id),
        policy,
    };
    let query = list_query(query);
    let answer =
        crate::audit::with_token(caller.acting(), route(&ctx, &method, &resource, &query, &headers, &body)).await;
    match answer {
        Ok(res) => res,
        Err(e) => {
            if writes && e.status.is_client_error() && e.status != StatusCode::NOT_FOUND {
                record_refused(&ctx, &method, &resource, &e).await;
            }
            e.into_response()
        }
    }
}

fn canonical_uuid(raw: &str) -> bool {
    uuid::Uuid::parse_str(raw).map(|u| u.hyphenated().to_string()).ok().as_deref() == Some(raw)
}

/// The query parameters by their SCIM names, which compare case-insensitively.
fn list_query(pairs: Vec<(String, String)>) -> ListQuery {
    let mut q = ListQuery::default();
    for (key, value) in pairs {
        match key.to_ascii_lowercase().as_str() {
            "filter" => q.filter = Some(value),
            "startindex" => q.start_index = Some(value),
            "count" => q.count = Some(value),
            "excludedattributes" => q.excluded_attributes = Some(value),
            "attributes" => q.attributes = Some(value),
            _ => {}
        }
    }
    q
}

/// The SCIM token of the request for `org_id`, checked like a service account token, and the
/// organization's switch.
async fn sign_in(state: &AppState, info: &RequestInfo, headers: &HeaderMap, org_id: &str) -> ScimResult<ScimCaller> {
    let Some(token) = api_token::bearer(headers) else {
        return Err(ScimError::unauthorized());
    };
    let caller = api_token::authenticate_scim(state, info, &token, org_id).await.map_err(|e| {
        // A token of another organization answers like any other refused token here.
        if e.status == StatusCode::TOO_MANY_REQUESTS { ScimError::from(e) } else { ScimError::unauthorized() }
    })?;
    if !enabled(&state.read_db, org_id).await? {
        return Err(
            ScimError::protected("SCIM provisioning is turned off for this organization").because("scim.disabled")
        );
    }
    caller.record_use(state, info);
    Ok(caller)
}

/// The organization whose SCIM still owns `user_id`, an account it made: only while nobody can sign
/// in to it yet (no password and no provider identity linked), its owner never confirmed the
/// address themselves, it belongs to no other organization, and it is not a server admin, the
/// break-glass admin or a service account. Only then may that SCIM change the account's name and
/// address, lock it, and vouch for its address at the first single sign-on (docs/api/scim.md,
/// "Accounts"). Once one of these no longer holds, the ownership ends for good (`release`), so the
/// first sign-in method linked to the account ends it. Inside a write transaction.
pub async fn owner_org(
    conn: &mut sqlx::AnyConnection,
    user_id: &str,
    break_glass: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT s.org_id, u.email_confirmed, u.is_server_admin, u.service_account, \
         CASE WHEN u.password_hash IS NULL THEN 0 ELSE 1 END, \
         (SELECT COUNT(*) FROM sso_identities i WHERE i.user_id = u.id) FROM scim_users s \
         JOIN users u ON u.id = s.user_id WHERE s.user_id = $1 AND s.created_account = 1 \
         ORDER BY s.created_at LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((org_id, confirmed, server_admin, service, password, identities)) = row else { return Ok(None) };
    let (elsewhere,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM org_members WHERE user_id = $1 AND org_id <> $2")
        .bind(user_id)
        .bind(&org_id)
        .fetch_one(&mut *conn)
        .await?;
    let owned = confirmed == 0
        && server_admin == 0
        && service == 0
        && password == 0
        && identities == 0
        && elsewhere == 0
        && break_glass != Some(user_id);
    if !owned {
        release(conn, user_id, None).await?;
        return Ok(None);
    }
    Ok(Some(org_id))
}

/// Whether a single sign-on may link a provider's person to the unconfirmed account `user_id` by
/// its address: SCIM made it, still owns it (`owner_org`: so this is the first sign-in method linked to
/// it, with no password and no identity) and the SCIM user is active. This counts for that sign-in
/// only; the address stays unconfirmed for everything else.
pub async fn vouches_for_sign_in(
    conn: &mut sqlx::AnyConnection,
    user_id: &str,
    break_glass: Option<&str>,
) -> Result<bool, sqlx::Error> {
    let Some(org_id) = owner_org(&mut *conn, user_id, break_glass).await? else { return Ok(false) };
    let active: Option<(i64,)> = sqlx::query_as("SELECT active FROM scim_users WHERE org_id = $1 AND user_id = $2")
        .bind(&org_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(active.is_some_and(|(a,)| a != 0))
}

/// Ends SCIM's ownership of `user_id` for good (see `owner_org`): its owner confirmed the address,
/// it joined another organization than `keep_org`, or it became a server admin. The SCIM user
/// stays; only the account is out of SCIM's hands.
pub async fn release(conn: &mut sqlx::AnyConnection, user_id: &str, keep_org: Option<&str>) -> Result<(), sqlx::Error> {
    match keep_org {
        Some(org_id) => {
            sqlx::query("UPDATE scim_users SET created_account = 0 WHERE user_id = $1 AND org_id <> $2")
                .bind(user_id)
                .bind(org_id)
                .execute(conn)
                .await?;
        }
        None => {
            sqlx::query("UPDATE scim_users SET created_account = 0 WHERE user_id = $1")
                .bind(user_id)
                .execute(conn)
                .await?;
        }
    }
    Ok(())
}

/// Whether SCIM deactivated and locked `user_id` (`scim_users.locked_account`): the directory
/// sync's enabling an account again must leave such an account locked (`sso::sync`).
pub async fn locked_by_scim(conn: &mut sqlx::AnyConnection, user_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM scim_users WHERE user_id = $1 AND locked_account = 1")
        .bind(user_id)
        .fetch_optional(conn)
        .await?;
    Ok(row.is_some())
}

/// Whether the organization's SCIM switch is on (no row: on).
pub async fn enabled<'c, E>(db: E, org_id: &str) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT enabled FROM scim_orgs WHERE org_id = $1").bind(org_id).fetch_optional(db).await?;
    Ok(row.is_none_or(|(on,)| on != 0))
}

async fn route(
    ctx: &Ctx<'_>,
    method: &Method,
    resource: &[&str],
    query: &ListQuery,
    headers: &HeaderMap,
    body: &Bytes,
) -> ScimResult<Response> {
    let read = || matches!(*method, Method::GET | Method::HEAD);
    match resource {
        ["ServiceProviderConfig"] if read() => Ok(schema::service_provider_config(ctx)),
        ["ResourceTypes"] if read() => Ok(schema::resource_types(ctx)),
        ["ResourceTypes", name] if read() => schema::resource_type(ctx, name),
        ["Schemas"] if read() => Ok(schema::schemas(ctx)),
        ["Schemas", id] if read() => schema::schema(ctx, id),
        ["Users"] => match *method {
            Method::GET | Method::HEAD => users::list(ctx, query).await,
            Method::POST => users::create(ctx, json_body(headers, body)?).await,
            _ => Err(method_not_allowed()),
        },
        ["Users", id] => match *method {
            Method::GET | Method::HEAD => users::get(ctx, id, query).await,
            Method::PUT => users::replace(ctx, id, json_body(headers, body)?).await,
            Method::PATCH => users::patch(ctx, id, json_body(headers, body)?).await,
            Method::DELETE => users::delete(ctx, id).await,
            _ => Err(method_not_allowed()),
        },
        ["Groups"] => match *method {
            Method::GET | Method::HEAD => groups::list(ctx, query).await,
            Method::POST => groups::create(ctx, json_body(headers, body)?).await,
            _ => Err(method_not_allowed()),
        },
        ["Groups", id] => match *method {
            Method::GET | Method::HEAD => groups::get(ctx, id, query).await,
            Method::PUT => groups::replace(ctx, id, json_body(headers, body)?).await,
            Method::PATCH => groups::patch(ctx, id, json_body(headers, body)?).await,
            Method::DELETE => groups::delete(ctx, id).await,
            _ => Err(method_not_allowed()),
        },
        ["ServiceProviderConfig" | "ResourceTypes" | "Schemas", ..] => Err(method_not_allowed()),
        ["Bulk"] => Err(ScimError::new(StatusCode::NOT_IMPLEMENTED, "bulk operations are not supported")),
        ["Me"] => Err(ScimError::new(StatusCode::NOT_IMPLEMENTED, "/Me is not supported")),
        _ => Err(ScimError::not_found()),
    }
}

fn method_not_allowed() -> ScimError {
    ScimError::new(StatusCode::METHOD_NOT_ALLOWED, "this method is not supported here")
}

/// Writes `scim.request_refused` for a change the server refused (not for a token refusal, which
/// `auth::api_token` records): the method, the resource, the status and the reason. Outside the
/// refused change's transaction, which was rolled back; a busy database does not change the
/// answer.
async fn record_refused(ctx: &Ctx<'_>, method: &Method, resource: &[&str], e: &ScimError) {
    let summary = json!({
        "method": method.as_str(),
        "resource": resource.join("/"),
        "status": e.status.as_u16(),
        "scimType": e.scim_type,
        "reason": e.reason,
        "detail": e.detail,
    });
    let event = crate::audit::AuditEvent {
        org_id: Some(ctx.org_id),
        actor_user_id: None,
        actor_address: Some(ctx.info.client_ip.to_string()),
        action: "scim.request_refused",
        resource_type: Some("api_token"),
        resource_id: Some(&ctx.caller.token_id),
        summary,
        at_ms: ctx.state.clock.now_ms(),
    };
    let recorded = match ctx.state.db.acquire().await {
        Ok(mut conn) => crate::audit::with_token(ctx.caller.acting(), crate::audit::record(&mut conn, &event)).await,
        Err(e) => Err(e),
    };
    if let Err(err) = recorded {
        tracing::warn!(client = %ctx.info.client_ip, "recording a refused SCIM request in the audit log failed: {err}");
    }
}

/// Writes an audit entry of a SCIM change in its transaction; the token is named by the request's
/// scope (`audit::with_token`), and there is no acting person.
pub async fn audit(
    conn: &mut sqlx::AnyConnection,
    ctx: &Ctx<'_>,
    action: &str,
    resource: (&str, &str),
    summary: Value,
) -> Result<(), sqlx::Error> {
    let event = crate::audit::AuditEvent {
        org_id: Some(ctx.org_id),
        actor_user_id: None,
        actor_address: Some(ctx.info.client_ip.to_string()),
        action,
        resource_type: Some(resource.0),
        resource_id: Some(resource.1),
        summary,
        at_ms: ctx.state.clock.now_ms(),
    };
    crate::audit::record(conn, &event).await
}

/// A SCIM boolean: JSON `true`/`false`, or the strings Entra ID sends (`"True"`, `"False"`).
pub fn boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::String(s) if s.eq_ignore_ascii_case("true") => Some(true),
        Value::String(s) if s.eq_ignore_ascii_case("false") => Some(false),
        _ => None,
    }
}

/// A text attribute: trimmed, at most `max` characters, no control characters; empty is `None`.
pub fn text(value: &Value, what: &str, max: usize) -> ScimResult<Option<String>> {
    let raw = match value {
        Value::Null => return Ok(None),
        Value::String(s) => s.trim(),
        // Some directories send numbers for ids.
        Value::Number(n) => return Ok(Some(n.to_string())),
        _ => {
            return Err(ScimError::bad("invalidValue", format!("{what} is not a string")).because("scim.value_invalid"));
        }
    };
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.chars().count() > max || raw.chars().any(char::is_control) {
        return Err(ScimError::bad(
            "invalidValue",
            format!("{what} has more than {max} characters or control characters"),
        )
        .because("scim.value_invalid"));
    }
    Ok(Some(raw.to_string()))
}

/// The value of `key` in a JSON object, with the attribute name compared case-insensitively.
pub fn field<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object.as_object()?.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn booleans_accept_entra_strings() {
        assert_eq!(boolean(&json!(false)), Some(false));
        assert_eq!(boolean(&json!("False")), Some(false));
        assert_eq!(boolean(&json!("TRUE")), Some(true));
        assert_eq!(boolean(&json!("no")), None);
        assert_eq!(boolean(&json!(0)), None);
    }

    #[test]
    fn paging_is_bounded() {
        let q = ListQuery { start_index: Some("0".into()), count: Some("5000".into()), ..Default::default() };
        let p = q.paging().unwrap();
        assert_eq!((p.start_index, p.count), (1, MAX_RESULTS));
        let q = ListQuery { count: Some("-3".into()), ..Default::default() };
        assert_eq!(q.paging().unwrap().count, 0);
        let q = ListQuery { start_index: Some("x".into()), ..Default::default() };
        assert_eq!(q.paging().unwrap_err().scim_type, Some("invalidValue"));
        assert_eq!(ListQuery::default().paging().unwrap().count, DEFAULT_COUNT);
    }

    #[test]
    fn excluded_attributes_are_read_by_name() {
        let q = ListQuery { excluded_attributes: Some("members".into()), ..Default::default() };
        assert!(q.excludes("members"));
        let q = ListQuery {
            attributes: Some("urn:ietf:params:scim:schemas:core:2.0:Group:displayName".into()),
            ..Default::default()
        };
        assert!(q.excludes("members") && !q.excludes("displayname"));
        assert!(!ListQuery::default().excludes("members"));
    }

    #[test]
    fn texts_are_bounded() {
        assert_eq!(text(&json!("  Anna "), "x", 10).unwrap().as_deref(), Some("Anna"));
        assert_eq!(text(&json!(""), "x", 10).unwrap(), None);
        assert_eq!(text(&json!(42), "x", 10).unwrap().as_deref(), Some("42"));
        assert!(text(&json!("a\u{7}b"), "x", 10).is_err());
        assert!(text(&json!("abcdefghijk"), "x", 10).is_err());
        assert!(text(&json!([1]), "x", 10).is_err());
    }
}
