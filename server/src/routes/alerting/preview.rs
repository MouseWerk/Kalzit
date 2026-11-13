//! "Jetzt auswerten" in the rule editor (docs/api/alerting.md, "Preview"): a draft rule evaluated
//! once with the rights of the person editing it, never as the alerting identity. Nothing is
//! stored, and the query cache is neither read nor filled.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::alerting::eval::{self, EvalError, InstanceState, Outcome, Reduced};
use crate::alerting::evaluate::{run_query, time_limit, timing};
use crate::alerting::message::{self, Instance, Links, Message, Organization, RuleInfo};
use crate::alerting::rule::{Condition, ERROR_STATES, NO_DATA_STATES, Reduce, RuleQuery, invalid};
use crate::alerting::{limits, service_account};
use crate::app::AppState;
use crate::authz::{OrgCtx, Permission, Resource, check_resource};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::mail::templates::Lang;
use crate::shapes::{ErrorBody, TimeRange};

const MAX_RANGE_SECS: i64 = 30 * 86_400;

fn default_range() -> i64 {
    600
}
fn default_interval() -> i64 {
    60
}
fn default_no_data() -> String {
    "no_data".into()
}
fn default_error() -> String {
    "error".into()
}
fn default_language() -> String {
    "de".into()
}

/// The parts of a rule the preview needs; the rest of a draft may be sent along and is ignored.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    #[serde(default)]
    name: String,
    datasource_id: String,
    query: RuleQuery,
    #[serde(default = "default_range")]
    range_secs: i64,
    reduce: Value,
    condition: Value,
    #[serde(default = "default_interval")]
    interval_secs: i64,
    #[serde(default)]
    for_secs: i64,
    #[serde(default = "default_no_data")]
    no_data_state: String,
    #[serde(default = "default_error")]
    error_state: String,
    #[serde(default)]
    labels: BTreeMap<String, String>,
    #[serde(default)]
    description: String,
    runbook_url: Option<String>,
    /// The language of the message preview, `de` or `en`.
    #[serde(default = "default_language")]
    language: String,
}

/// One series of the result after the reduce step.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesView {
    labels: BTreeMap<String, String>,
    /// The frame field it came from (empty for documents and graphs).
    field: String,
    /// The reduced value; `null` without one.
    value: Option<f64>,
    /// Whether the value meets the condition; `null` without a value.
    condition_met: Option<bool>,
}

/// One instance as it would be now, starting from nothing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    fingerprint: String,
    labels: BTreeMap<String, String>,
    /// `ok`, `pending`, `firing`, `no_data` or `error`.
    state: &'static str,
    /// The state a pending instance waits for.
    pending_target: Option<&'static str>,
    value: Option<f64>,
    error: Option<EvalError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    subject: String,
    text: String,
    /// The webhook body that would be sent.
    webhook: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    evaluated_at: i64,
    /// Whether the scheduled evaluation could run on the source (its alerting opt-in).
    datasource_opted_in: bool,
    /// The shape the query answered in; `null` when it failed.
    shape: Option<Value>,
    /// The source's error, for the person who may query it; never stored.
    query_error: Option<ErrorBody>,
    /// Why the evaluation ends in the state Error, as `{code, params}`.
    error: Option<EvalError>,
    /// The source cut the result at one of its limits.
    truncated: Option<EvalError>,
    series: Vec<SeriesView>,
    value_fields: Vec<String>,
    label_fields: Vec<String>,
    /// Documents without the field (or with it empty) that did not count.
    skipped_documents: usize,
    max_instances: u64,
    instances: Vec<InstanceView>,
    /// The message the instances that are or would become reported would send.
    message: Option<MessageView>,
}

fn check(body: &Body) -> ApiResult<(Reduce, Condition)> {
    body.query.check()?;
    let reduce = Reduce::parse(&body.reduce)?;
    let condition = Condition::parse(&body.condition)?;
    if body.range_secs < 1 || body.range_secs > MAX_RANGE_SECS {
        return Err(invalid(
            "rangeSecs",
            format!("rangeSecs is 1 to {MAX_RANGE_SECS} seconds"),
            "alerts.range_invalid",
        ));
    }
    if body.interval_secs < 1 || body.interval_secs > 86_400 {
        return Err(ApiError::validation("intervalSecs is 1 to 86400 seconds")
            .with_field("intervalSecs")
            .because("alerts.interval_invalid")
            .param("min", 1)
            .param("max", 86_400));
    }
    if body.for_secs < 0 || body.for_secs > 86_400 {
        return Err(ApiError::validation("forSecs is 0 to 86400 seconds")
            .with_field("forSecs")
            .because("alerts.for_invalid")
            .param("max", 86_400));
    }
    if !NO_DATA_STATES.contains(&body.no_data_state.as_str()) || !ERROR_STATES.contains(&body.error_state.as_str()) {
        return Err(invalid(
            "noDataState",
            "noDataState or errorState is not one of its values",
            "alerts.state_option_invalid",
        ));
    }
    if !crate::alerting::contact_points::LANGUAGES.contains(&body.language.as_str()) {
        return Err(invalid("language", "language is de or en", "alerts.language_invalid"));
    }
    Ok((reduce, condition))
}

fn instance_view(i: &InstanceState) -> InstanceView {
    InstanceView {
        fingerprint: i.fingerprint.clone(),
        labels: i.labels.clone(),
        state: i.state.as_str(),
        pending_target: i.pending.map(|p| p.target.as_str()),
        value: i.last_value,
        error: i.last_error.clone(),
    }
}

/// `POST /orgs/{orgId}/alerting/rules/preview` (`alerts:write`, and `datasources:query` on the
/// source for the caller).
pub async fn preview(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(body): JsonBody<Body>,
) -> ApiResult<Json<Preview>> {
    let (reduce, condition) = check(&body)?;
    let ds = crate::datasources::find_in_org(&state.db, &ctx.org_id, &body.datasource_id, false)
        .await
        .map_err(|e| e.with_field("datasourceId"))?;
    check_resource(&state.db, &ctx, Permission::DatasourcesQuery, Resource::Datasource(&ds.id))
        .await
        .map_err(|e| e.with_field("datasourceId"))?;
    let key = format!("alert-preview:{}", ctx.user.id);
    state
        .alerting
        .previews
        .try_acquire(&key, &key, state.clock.monotonic_ms())
        .map_err(|wait| ApiError::rate_limited("too many previews, wait a moment", wait))?;
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let opted_in = service_account::may_query(&state.db, &ctx.org_id, &ds.id).await?;
    let now = state.clock.now_ms();
    let range = TimeRange { from: now.saturating_sub(body.range_secs.saturating_mul(1000)), to: now };
    let limit = time_limit(body.interval_secs, limits.evaluation_timeout_secs);
    let max_instances = usize::try_from(limits.max_instances_per_rule).unwrap_or(usize::MAX);

    let mut out = Preview {
        evaluated_at: now,
        datasource_opted_in: opted_in,
        shape: None,
        query_error: None,
        error: None,
        truncated: None,
        series: Vec::new(),
        value_fields: Vec::new(),
        label_fields: Vec::new(),
        skipped_documents: 0,
        max_instances: limits.max_instances_per_rule,
        instances: Vec::new(),
        message: None,
    };
    let outcome = match run_query(&state, &ctx, &ds.id, &body.query, range, limit).await {
        Ok(result) => {
            out.shape = serde_json::to_value(result.shape()).ok();
            match eval::reduce(&reduce, &result, max_instances) {
                Ok(reduction) => {
                    out.series = reduction
                        .series
                        .iter()
                        .map(|s| {
                            let value = match s.value {
                                Reduced::Value(v) => Some(v),
                                Reduced::NoValue => None,
                            };
                            SeriesView {
                                labels: s.labels.clone(),
                                field: s.field.clone(),
                                value,
                                condition_met: value.map(|v| condition.holds(v)),
                            }
                        })
                        .collect();
                    out.value_fields = reduction.value_fields;
                    out.label_fields = reduction.label_fields;
                    out.skipped_documents = reduction.skipped_documents;
                    out.truncated = reduction.truncated;
                }
                Err(e) => out.error = Some(e),
            }
            eval::outcome(&reduce, &condition, Ok(&result), max_instances)
        }
        Err((error, cause)) => {
            out.query_error = cause.map(|c| *c);
            Outcome::Error(error)
        }
    };
    if let Outcome::Error(e) = &outcome {
        out.error = Some(e.clone());
    }
    let rule_id = "preview";
    let timing = timing(rule_id, body.interval_secs, body.for_secs, &body.no_data_state, &body.error_state, 0);
    let step = eval::step(&timing, &[], &outcome, now, &|_| None);
    out.instances = step.instances.iter().map(instance_view).collect();

    // The message as it would read once the instances that are on their way are reported.
    let reported: Vec<Instance> = step
        .instances
        .iter()
        .filter_map(|i| {
            let target = if i.state.is_active() { Some(i.state) } else { i.pending.map(|p| p.target) }?;
            let event = match target {
                eval::State::NoData => eval::Event::NoData,
                eval::State::Error => eval::Event::Error,
                _ => eval::Event::Firing,
            };
            Some(Instance {
                fingerprint: i.fingerprint.clone(),
                labels: i.labels.clone(),
                event,
                state: target,
                state_since: now,
                value: i.last_value,
                error: i.last_error.clone(),
                reminder: 0,
                reason: None,
            })
        })
        .collect();
    if !reported.is_empty() {
        let (org_name,): (String,) =
            sqlx::query_as("SELECT name FROM orgs WHERE id = $1").bind(&ctx.org_id).fetch_one(&state.db).await?;
        let name = if body.name.trim().is_empty() { "…".to_string() } else { body.name.trim().to_string() };
        let message = Message {
            version: message::VERSION,
            event: message::message_event(&reported).to_string(),
            delivery_id: "preview".into(),
            organization: Organization { id: ctx.org_id.clone(), name: org_name },
            rule: RuleInfo {
                id: rule_id.into(),
                name,
                description: body.description.clone(),
                runbook_url: body.runbook_url.clone(),
                labels: body.labels.clone(),
                reduce,
                condition,
            },
            instances: reported,
            omitted_instances: 0,
            truncated: false,
            links: Links::default(),
            evaluated_at: now,
        };
        let zone = crate::mail::time_zone(&state, Some(&ctx.org_id)).await?;
        let mail = message.mail(Lang::parse(&body.language), zone.as_deref(), &crate::mail::host(&state));
        let max = usize::try_from(limits.webhook_max_bytes).unwrap_or(usize::MAX);
        out.message = Some(MessageView {
            subject: mail.subject,
            text: mail.text,
            webhook: serde_json::from_slice(&message.webhook_body(max)).unwrap_or(Value::Null),
        });
    }
    Ok(Json(out))
}
