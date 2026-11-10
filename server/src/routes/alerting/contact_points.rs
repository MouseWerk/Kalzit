//! Contact points (docs/api/alerting.md, "Contact points"). Organization admins
//! (`alerts:contacts`) create, change and delete them and rotate webhook secrets; everyone with
//! `alerts:read` sees name, kind, the last delivery, shortened recipients and the webhook host.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::known_id;
use crate::alerting::contact_points::{
    self as store, KINDS, LANGUAGES, MAX_RECIPIENTS, PREVIOUS_SECRET_FIELD, PREVIOUS_VALID_MS, SECRET_FIELD, Settings,
    host_of, shorten_address,
};
use crate::alerting::rule::invalid;
use crate::app::AppState;
use crate::authz::{OrgCtx, Permission, lock_org};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::routes::support::{Actor, audit, conflict, is_unique_violation};
use crate::shapes::Page;

const MAX_URL_CHARS: usize = 2048;

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    name: String,
    kind: String,
    settings: String,
    previous_secret_until: Option<i64>,
    last_delivery_at: Option<i64>,
    last_delivery_ok: Option<i64>,
    last_delivery_error: Option<String>,
    version: i64,
    updated_at: i64,
    rules: i64,
}

const COLUMNS: &str = "SELECT c.id, c.name, c.kind, c.settings, c.previous_secret_until, c.last_delivery_at, \
     c.last_delivery_ok, c.last_delivery_error, c.version, c.updated_at, \
     (SELECT COUNT(*) FROM alert_rule_contact_points l WHERE l.contact_point_id = c.id) AS rules \
     FROM alert_contact_points c WHERE c.org_id = $1";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastDelivery {
    at: i64,
    ok: bool,
    /// Why it failed (`503`, `timeout`), never content.
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContactPoint {
    id: String,
    name: String,
    kind: String,
    language: String,
    /// Whether this view carries the details (`alerts:contacts`): full recipients and the URL.
    details: bool,
    /// Mail: the recipients, shortened (`j…@mousewerk.test`) without `alerts:contacts`.
    #[serde(skip_serializing_if = "Option::is_none")]
    recipients: Option<Vec<String>>,
    /// Webhook: the host, for everyone.
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    /// Webhook: the full URL, with `alerts:contacts` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    /// Webhook over `http://`: the payload and its signature travel unencrypted.
    insecure: bool,
    /// Until when the previous webhook secret still signs after a rotation (`alerts:contacts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_secret_until: Option<i64>,
    last_delivery: Option<LastDelivery>,
    /// Rules that notify it.
    rules: i64,
    version: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    #[serde(flatten)]
    contact_point: ContactPoint,
    /// A webhook's signing secret, in this answer only.
    #[serde(skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
}

fn view(row: Row, details: bool, now: i64) -> ContactPoint {
    let settings: Settings = serde_json::from_str(&row.settings).unwrap_or(Settings {
        recipients: Vec::new(),
        url: None,
        language: "de".into(),
    });
    let is_mail = row.kind == "mail";
    let recipients = is_mail.then(|| {
        if details {
            settings.recipients.clone()
        } else {
            settings.recipients.iter().map(|r| shorten_address(r)).collect()
        }
    });
    let url = settings.url.clone();
    ContactPoint {
        id: row.id,
        name: row.name,
        kind: row.kind,
        language: settings.language,
        details,
        recipients,
        host: url.as_deref().and_then(host_of),
        insecure: url.as_deref().is_some_and(|u| u.starts_with("http://")),
        url: url.filter(|_| details),
        previous_secret_until: row.previous_secret_until.filter(|u| details && *u > now),
        last_delivery: row.last_delivery_at.map(|at| LastDelivery {
            at,
            ok: row.last_delivery_ok.unwrap_or(0) != 0,
            error: row.last_delivery_error,
        }),
        rules: row.rules,
        version: row.version,
        updated_at: row.updated_at,
    }
}

async fn load<'e, E>(db: E, org_id: &str, id: &str) -> ApiResult<Row>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    known_id(id)?;
    let row: Option<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLUMNS} AND c.id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(db)
        .await?;
    row.ok_or_else(ApiError::not_found)
}

pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<Page<ContactPoint>>> {
    let details = ctx.permissions.contains(&Permission::AlertsContacts);
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(COLUMNS)).bind(&ctx.org_id).fetch_all(&state.db).await?;
    let now = state.clock.now_ms();
    let mut items: Vec<ContactPoint> = rows.into_iter().map(|r| view(r, details, now)).collect();
    items.sort_by(|a, b| crate::collation::compare(&a.name, &b.name).then_with(|| a.id.cmp(&b.id)));
    Ok(Json(Page { items, next_cursor: None }))
}

pub async fn detail(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<ContactPoint>> {
    let details = ctx.permissions.contains(&Permission::AlertsContacts);
    let row = load(&state.db, &ctx.org_id, &id).await?;
    Ok(Json(view(row, details, state.clock.now_ms())))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Body {
    name: String,
    /// `mail` or `webhook`; fixed once created (`PUT` must repeat it).
    kind: String,
    #[serde(default = "default_language")]
    language: String,
    #[serde(default)]
    recipients: Vec<String>,
    url: Option<String>,
    /// Required for `PUT`.
    version: Option<i64>,
}

fn default_language() -> String {
    "de".into()
}

/// A webhook URL: http or https, a host, no credentials or fragment, not Kalzit itself, and
/// allowed by the data source target policy (private networks yes, metadata addresses never).
async fn check_url(state: &AppState, raw: &str) -> ApiResult<String> {
    let bad = |message: &str| invalid("url", message.to_string(), "alerts.webhook_url_invalid");
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > MAX_URL_CHARS || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(bad("url needs 1 to 2048 characters without spaces"));
    }
    let url = url::Url::parse(raw).map_err(|_| bad("url is not an address"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(bad("url must start with http:// or https://"));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(bad("url must not contain credentials or a fragment"));
    }
    let Some(host) = url.host_str() else { return Err(bad("url has no host")) };
    let blocked = |detail: crate::datasources::Detail| {
        ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "datasource_target_blocked", detail.message)
            .with_field("url")
            .with_reason(detail.reason, detail.params)
    };
    if crate::routes::ai::is_kalzit_itself(state, &url) {
        return Err(blocked(crate::datasources::Detail::new(
            "alerts.webhook_url_kalzit",
            "url points at this Kalzit server",
        )));
    }
    let policy = state.datasources.policy(state).await?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    policy.precheck_host(host).map_err(|b| blocked(b.0))?;
    Ok(url.to_string())
}

fn check_recipients(raw: &[String]) -> ApiResult<Vec<String>> {
    if raw.is_empty() || raw.len() > MAX_RECIPIENTS {
        return Err(ApiError::validation(format!("a mail contact point has 1 to {MAX_RECIPIENTS} recipients"))
            .with_field("recipients")
            .because("alerts.recipients_invalid")
            .param("max", MAX_RECIPIENTS));
    }
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let address = crate::routes::normalize_email(r).map_err(|_| {
            ApiError::validation(format!("{r} is not an email address"))
                .with_field("recipients")
                .because("alerts.recipients_invalid")
                .param("max", MAX_RECIPIENTS)
        })?;
        if !out.contains(&address) {
            out.push(address);
        }
    }
    Ok(out)
}

/// Checks a body against its kind; answers the name and the settings to store.
async fn check_body(state: &AppState, body: &Body) -> ApiResult<(String, Settings)> {
    let name = crate::routes::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    if !LANGUAGES.contains(&body.language.as_str()) {
        return Err(invalid("language", "language is de or en", "alerts.language_invalid"));
    }
    let settings = match body.kind.as_str() {
        "mail" => {
            if body.url.is_some() {
                return Err(invalid("url", "a mail contact point has no url", "alerts.webhook_url_invalid"));
            }
            if !crate::mail::settings::effective(state).await?.configured() {
                return Err(conflict("no mail server is set up (Administration > Mail)")
                    .with_field("kind")
                    .because("alerts.mail_not_configured"));
            }
            Settings { recipients: check_recipients(&body.recipients)?, url: None, language: body.language.clone() }
        }
        "webhook" => {
            if !body.recipients.is_empty() {
                return Err(invalid("recipients", "a webhook has no recipients", "alerts.recipients_invalid"));
            }
            let Some(url) = &body.url else {
                return Err(invalid("url", "a webhook needs a url", "alerts.webhook_url_invalid"));
            };
            Settings {
                recipients: Vec::new(),
                url: Some(check_url(state, url).await?),
                language: body.language.clone(),
            }
        }
        other => {
            return Err(ApiError::validation(format!("{other} is not a contact point kind ({})", KINDS.join(", ")))
                .with_field("kind")
                .because("alerts.kind_invalid"));
        }
    };
    Ok((name, settings))
}

/// What the audit log keeps of a contact point: no URL path or query, recipients shortened.
fn audit_summary(id: &str, name: &str, kind: &str, settings: &Settings) -> Value {
    json!({
        "contactPointId": id,
        "name": name,
        "kind": kind,
        "recipients": settings.recipients.iter().map(|r| shorten_address(r)).collect::<Vec<_>>(),
        "host": settings.url.as_deref().and_then(host_of),
    })
}

fn name_taken() -> ApiError {
    conflict("a contact point with this name exists").with_field("name").because("alerts.contact_point_name_taken")
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<Body>,
) -> ApiResult<(StatusCode, Json<Created>)> {
    if body.version.is_some() {
        return Err(invalid("version", "a new contact point has no version", "alerts.version_unexpected"));
    }
    let (name, settings) = check_body(&state, &body).await?;
    let id = crate::routes::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let inserted = sqlx::query(
        "INSERT INTO alert_contact_points (id, org_id, name, kind, settings, version, created_by, created_at, \
         updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $6, $7)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&name)
    .bind(&body.kind)
    .bind(serde_json::to_string(&settings).unwrap_or_default())
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await;
    match inserted {
        Err(e) if is_unique_violation(&e) => return Err(name_taken()),
        other => other?,
    };
    let secret = match body.kind.as_str() {
        "webhook" => {
            let secret = store::new_secret();
            store::store_secret(&mut tx, &state.secrets, &id, SECRET_FIELD, &secret).await?;
            Some(secret)
        }
        _ => None,
    };
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = audit_summary(&id, &name, &body.kind, &settings);
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_contact_point.created", ("alert_contact_point", &id), summary)
        .await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    crate::db::commit(tx).await?;
    Ok((
        StatusCode::CREATED,
        Json(Created { contact_point: view(row, true, now), secret: secret.map(|s| s.to_string()) }),
    ))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<Body>,
) -> ApiResult<Json<ContactPoint>> {
    let before = load(&state.db, &ctx.org_id, &id).await?;
    let Some(expected) = body.version else {
        return Err(invalid("version", "version is the version the change is based on", "alerts.version_required"));
    };
    if body.kind != before.kind {
        return Err(invalid("kind", "the kind of a contact point cannot change", "alerts.kind_invalid"));
    }
    let (name, settings) = check_body(&state, &body).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let changed = sqlx::query(
        "UPDATE alert_contact_points SET name = $1, settings = $2, version = version + 1, updated_by = $3, \
         updated_at = $4 WHERE id = $5 AND org_id = $6 AND version = $7",
    )
    .bind(&name)
    .bind(serde_json::to_string(&settings).unwrap_or_default())
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(expected)
    .execute(&mut *tx)
    .await;
    let changed = match changed {
        Err(e) if is_unique_violation(&e) => return Err(name_taken()),
        other => other?.rows_affected(),
    };
    if changed == 0 {
        drop(tx);
        let current = view(load(&state.db, &ctx.org_id, &id).await?, true, now);
        return Err(ApiError::version_conflict(serde_json::to_value(current).unwrap_or_default()));
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = audit_summary(&id, &name, &body.kind, &settings);
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_contact_point.updated", ("alert_contact_point", &id), summary)
        .await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    crate::db::commit(tx).await?;
    Ok(Json(view(row, true, now)))
}

/// Deletes a contact point no rule uses; one in use answers `409 alerts.contact_point_in_use`.
pub async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    if row.rules > 0 {
        return Err(conflict(format!("{} rules notify this contact point; remove it from them first", row.rules))
            .because("alerts.contact_point_in_use")
            .param("rules", row.rules));
    }
    sqlx::query("DELETE FROM alert_contact_points WHERE id = $1 AND org_id = $2")
        .bind(&id)
        .bind(&ctx.org_id)
        .execute(&mut *tx)
        .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: state.clock.now_ms() };
    let summary = json!({ "contactPointId": id, "name": row.name, "kind": row.kind });
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_contact_point.deleted", ("alert_contact_point", &id), summary)
        .await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rotated {
    /// The new secret, in this answer only.
    secret: String,
    /// The previous secret signs too until then (24 hours).
    previous_secret_until: i64,
}

/// A new webhook secret. The one before stays valid for 24 hours, so receivers can switch; a
/// second rotation within that time replaces the previous one with the current one.
pub async fn rotate_secret(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Rotated>> {
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let row = load(&mut *tx, &ctx.org_id, &id).await?;
    if row.kind != "webhook" {
        return Err(conflict("only webhooks have a secret").because("alerts.not_a_webhook"));
    }
    let current: Option<(String, String, String)> = sqlx::query_as(
        "SELECT key_id, nonce, ciphertext FROM alert_contact_point_secrets WHERE contact_point_id = $1 AND field = $2",
    )
    .bind(&id)
    .bind(SECRET_FIELD)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((key_id, nonce, ciphertext)) = current {
        let blob = crate::secrets::Blob { key_id, nonce, ciphertext };
        let plain = state
            .secrets
            .decrypt(&store::secret_owner(&id), SECRET_FIELD, &blob)
            .map_err(|e| ApiError::internal("decrypting a contact point's webhook secret", e))?;
        store::store_secret(&mut tx, &state.secrets, &id, PREVIOUS_SECRET_FIELD, &plain).await?;
    }
    let secret = store::new_secret();
    store::store_secret(&mut tx, &state.secrets, &id, SECRET_FIELD, &secret).await?;
    let until = now + PREVIOUS_VALID_MS;
    sqlx::query(
        "UPDATE alert_contact_points SET previous_secret_until = $1, version = version + 1, updated_by = $2, \
         updated_at = $3 WHERE id = $4",
    )
    .bind(until)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({ "contactPointId": id, "previousValidUntil": until });
    audit(
        &mut tx,
        &actor,
        Some(&ctx.org_id),
        "alert_contact_point.secret_rotated",
        ("alert_contact_point", &id),
        summary,
    )
    .await?;
    crate::db::commit(tx).await?;
    Ok(Json(Rotated { secret: secret.to_string(), previous_secret_until: until }))
}
