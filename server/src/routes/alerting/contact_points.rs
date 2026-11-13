//! Contact points (docs/api/alerting.md, "Contact points"). Organization admins
//! (`alerts:contacts`) create, change and delete them and rotate webhook secrets; everyone with
//! `alerts:read` sees name, kind, the last delivery, shortened recipients and the webhook host.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::known_id;
use zeroize::Zeroizing;

use crate::alerting::contact_points::{
    self as store, CHAT_KINDS, KINDS, LANGUAGES, MAX_RECIPIENTS, PREVIOUS_SECRET_FIELD, PREVIOUS_VALID_MS,
    SECRET_FIELD, Settings, URL_FIELD, host_of, shorten_address, url_end,
};
use crate::alerting::eval::{Event, State as AlertState};
use crate::alerting::group_message::Payload;
use crate::alerting::message::{self, Instance, Links, Message, Organization, RuleInfo};
use crate::alerting::outbox::{self, Outgoing};
use crate::alerting::rule::{Condition, FrameFunction, Op, Reduce, invalid};
use crate::alerting::scheduler::TESTS_PER_ORG_MINUTE;
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
    policies: i64,
}

const COLUMNS: &str = "SELECT c.id, c.name, c.kind, c.settings, c.previous_secret_until, c.last_delivery_at, \
     c.last_delivery_ok, c.last_delivery_error, c.version, c.updated_at, \
     (SELECT COUNT(*) FROM alert_rule_contact_points l WHERE l.contact_point_id = c.id) AS rules, \
     (SELECT COUNT(DISTINCT p.policy_id) FROM alert_policy_contact_points p WHERE p.contact_point_id = c.id) AS policies \
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
    /// Slack and Teams: the last four characters of the URL (the URL itself is never answered).
    #[serde(skip_serializing_if = "Option::is_none")]
    url_end: Option<String>,
    /// Webhook over `http://`: the payload and its signature travel unencrypted.
    insecure: bool,
    /// Until when the previous webhook secret still signs after a rotation (`alerts:contacts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_secret_until: Option<i64>,
    last_delivery: Option<LastDelivery>,
    /// Rules that notify it.
    rules: i64,
    /// Policies (or their escalation steps) that use it.
    policies: i64,
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
        host: None,
        url_end: None,
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
        host: url.as_deref().and_then(host_of).or(settings.host),
        insecure: url.as_deref().is_some_and(|u| u.starts_with("http://")),
        url: url.filter(|_| details),
        url_end: settings.url_end.filter(|_| details),
        previous_secret_until: row.previous_secret_until.filter(|u| details && *u > now),
        last_delivery: row.last_delivery_at.map(|at| LastDelivery {
            at,
            ok: row.last_delivery_ok.unwrap_or(0) != 0,
            error: row.last_delivery_error,
        }),
        rules: row.rules,
        policies: row.policies,
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
/// Slack's and Teams' incoming webhook URLs (`chat`) are `https://` only.
async fn check_url(state: &AppState, raw: &str, chat: bool) -> ApiResult<String> {
    let reason = if chat { "alerts.chat_url_invalid" } else { "alerts.webhook_url_invalid" };
    let bad = |message: &str| invalid("url", message.to_string(), reason);
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > MAX_URL_CHARS || raw.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(bad("url needs 1 to 2048 characters without spaces"));
    }
    let url = url::Url::parse(raw).map_err(|_| bad("url is not an address"))?;
    if chat && url.scheme() != "https" {
        return Err(bad("url must start with https://"));
    }
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

/// A checked body: the name, the settings to store, and for Slack and Teams a new URL to store as
/// the secret (`None` keeps the stored one).
struct Checked {
    name: String,
    settings: Settings,
    chat_url: Option<Zeroizing<String>>,
}

/// Checks a body against its kind. `stored` are the settings of the contact point a `PUT`
/// changes: Slack and Teams keep their URL when the body has none.
async fn check_body(state: &AppState, body: &Body, stored: Option<&Settings>) -> ApiResult<Checked> {
    let name = crate::routes::clean_name(&body.name, "name").map_err(|e| e.with_field("name"))?;
    if !LANGUAGES.contains(&body.language.as_str()) {
        return Err(invalid("language", "language is de or en", "alerts.language_invalid"));
    }
    let language = body.language.clone();
    let mut chat_url = None;
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
            Settings { recipients: check_recipients(&body.recipients)?, url: None, language, host: None, url_end: None }
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
                url: Some(check_url(state, url, false).await?),
                language,
                host: None,
                url_end: None,
            }
        }
        kind if CHAT_KINDS.contains(&kind) => {
            if !body.recipients.is_empty() {
                return Err(invalid("recipients", "a channel has no recipients", "alerts.recipients_invalid"));
            }
            match (&body.url, stored) {
                (Some(url), _) => {
                    let url = Zeroizing::new(check_url(state, url, true).await?);
                    let settings = Settings {
                        recipients: Vec::new(),
                        url: None,
                        language,
                        host: host_of(&url),
                        url_end: Some(url_end(&url)),
                    };
                    chat_url = Some(url);
                    settings
                }
                (None, Some(stored)) => Settings { language, ..stored.clone() },
                (None, None) => {
                    return Err(invalid("url", "a channel needs its incoming webhook url", "alerts.chat_url_invalid"));
                }
            }
        }
        other => {
            return Err(ApiError::validation(format!("{other} is not a contact point kind ({})", KINDS.join(", ")))
                .with_field("kind")
                .because("alerts.kind_invalid"));
        }
    };
    Ok(Checked { name, settings, chat_url })
}

/// What the audit log keeps of a contact point: no URL path or query, recipients shortened.
fn audit_summary(id: &str, name: &str, kind: &str, settings: &Settings) -> Value {
    json!({
        "contactPointId": id,
        "name": name,
        "kind": kind,
        "recipients": settings.recipients.iter().map(|r| shorten_address(r)).collect::<Vec<_>>(),
        "host": settings.url.as_deref().and_then(host_of).or_else(|| settings.host.clone()),
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
    let Checked { name, settings, chat_url } = check_body(&state, &body, None).await?;
    let id = crate::routes::new_id();
    let now = state.clock.now_ms();
    let max = crate::alerting::limits::for_org(&state, &ctx.org_id).await?.max_contact_points_per_org;
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_contact_points WHERE org_id = $1")
        .bind(&ctx.org_id)
        .fetch_one(&mut *tx)
        .await?;
    if u64::try_from(count).unwrap_or(0) >= max {
        return Err(conflict(format!("this organization has its {max} contact points"))
            .because("alerts.too_many_contact_points_in_org")
            .param("max", max));
    }
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
    if let Some(url) = &chat_url {
        store::store_secret(&mut tx, &state.secrets, &id, URL_FIELD, url).await?;
    }
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
    let stored: Option<Settings> = serde_json::from_str(&before.settings).ok();
    let Checked { name, settings, chat_url } = check_body(&state, &body, stored.as_ref()).await?;
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
    if let Some(url) = &chat_url {
        store::store_secret(&mut tx, &state.secrets, &id, URL_FIELD, url).await?;
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let mut summary = audit_summary(&id, &name, &body.kind, &settings);
    summary["urlReplaced"] = json!(chat_url.is_some());
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
    if row.rules > 0 || row.policies > 0 {
        let names: Vec<(String,)> = sqlx::query_as(
            "SELECT DISTINCT p.name FROM alert_policies p JOIN alert_policy_contact_points l ON l.policy_id = p.id \
             WHERE l.contact_point_id = $1 ORDER BY p.name",
        )
        .bind(&id)
        .fetch_all(&mut *tx)
        .await?;
        let names: Vec<String> = names.into_iter().map(|(n,)| n).collect();
        return Err(conflict(format!(
            "{} rules and {} policies use this contact point; remove it from them first",
            row.rules, row.policies
        ))
        .because("alerts.contact_point_in_use")
        .param("rules", row.rules)
        .param("policies", names.join(", ")));
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tested {
    /// Whether the test arrived.
    ok: bool,
    /// `ok`, the status of the receiver's answer (`503`), or why there was none (`timeout`,
    /// `blocked`, `connection`, `mail.*`), never content.
    result: String,
    duration_ms: i64,
    /// The receiver's `Retry-After` of a `429` (Slack, Teams).
    retry_after_secs: Option<u64>,
}

/// The longest a test send waits for its answer (a webhook has 10 seconds of it).
const TEST_LIMIT: std::time::Duration = std::time::Duration::from_secs(20);

/// The example message of a test send: one firing instance with made-up values, in the contact
/// point's language.
fn test_message(org_id: &str, org_name: &str, language: &str, now: i64) -> Message {
    let de = language == "de";
    let labels = [("instance".to_string(), if de { "beispiel-1" } else { "example-1" }.to_string())].into();
    Message {
        version: message::VERSION,
        event: message::TEST_EVENT.into(),
        delivery_id: uuid::Uuid::now_v7().to_string(),
        organization: Organization { id: org_id.to_string(), name: org_name.to_string() },
        rule: RuleInfo {
            id: String::new(),
            name: if de { "Beispielregel" } else { "Example rule" }.into(),
            description: String::new(),
            runbook_url: None,
            labels: Default::default(),
            reduce: Reduce::Frame { function: FrameFunction::Last },
            condition: Condition { op: Op::Gt, value: Some(1.5), low: None, high: None },
        },
        instances: vec![Instance {
            fingerprint: String::new(),
            labels,
            event: Event::Firing,
            state: AlertState::Firing,
            state_since: now,
            value: Some(1.84),
            error: None,
            reminder: 0,
            reason: None,
        }],
        omitted_instances: 0,
        truncated: false,
        links: Links::default(),
        evaluated_at: now,
    }
}

/// Sends an example message (`Kalzit-Event: test`) to the contact point now, at most 5 per minute
/// and contact point. The result is the contact point's last delivery, in the history and audited.
pub async fn test(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<Tested>> {
    let row = load(&state.db, &ctx.org_id, &id).await?;
    let now_mono = state.clock.monotonic_ms();
    // The contact point's own limit first, so a refused send does not use up the organization's.
    let key = format!("alert-test:{id}");
    state
        .alerting
        .tests
        .try_acquire(&key, &key, now_mono)
        .map_err(|wait| ApiError::rate_limited("at most 5 test sends per minute and contact point", wait))?;
    let org_key = format!("alert-test-org:{}", ctx.org_id);
    state.alerting.org_tests.try_acquire(&org_key, &org_key, now_mono).map_err(|wait| {
        ApiError::rate_limited(format!("at most {TESTS_PER_ORG_MINUTE} test sends per minute and organization"), wait)
    })?;
    let settings: Settings =
        serde_json::from_str(&row.settings).map_err(|e| ApiError::internal("stored contact point settings", e))?;
    let (org_name,): (String,) =
        sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&ctx.org_id).fetch_one(&state.db).await?;
    let now = state.clock.now_ms();
    let out = Outgoing {
        delivery_id: None,
        org_id: ctx.org_id.clone(),
        contact_point_id: id.clone(),
        kind: row.kind.clone(),
        message: Payload::Rule(test_message(&ctx.org_id, &org_name, &settings.language, now)),
        settings: settings.clone(),
        sent_to: Vec::new(),
    };
    let started = std::time::Instant::now();
    let attempt = outbox::send_within(&state, &out, TEST_LIMIT).await;
    let duration_ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    outbox::record_attempt(&mut tx, &ctx.org_id, &id, &out.message, 1, &attempt, now).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let mut summary = audit_summary(&id, &row.name, &row.kind, &settings);
    summary["ok"] = json!(attempt.ok);
    summary["result"] = json!(attempt.result);
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_contact_point.tested", ("alert_contact_point", &id), summary)
        .await?;
    crate::db::commit(tx).await?;
    Ok(Json(Tested { ok: attempt.ok, result: attempt.result, duration_ms, retry_after_secs: attempt.retry_after_secs }))
}
