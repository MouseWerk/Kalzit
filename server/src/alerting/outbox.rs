//! The delivery outbox (docs/PLAN.md section 13, "Zustellung"): an evaluation records the
//! messages to send in the same transaction as its instances and transitions ([`record`]); a
//! worker sends them after the commit ([`deliver_due`]), in the background, up to
//! [`MAX_ATTEMPTS`] times with a pause between attempts.
//!
//! Nothing is sent twice: every instance notification is recorded per contact point under its
//! deduplication key (`eval::Notification::dedup_key`, table `alert_delivery_keys`), and a key that
//! is already there is left out, after a restart or a change of the leader too. A crash before
//! the commit loses nothing (the evaluation repeats), a crash after it finds the message still to
//! send. A message is claimed with a lease while it is being sent, so two workers never send it at
//! once; a sender that dies mid-send leaves it to be tried again once the lease ran out, with the
//! same `Kalzit-Delivery` id, so a receiver can tell the repetition apart. The attempt is counted
//! when it is claimed, so a message that kills its sender is given up after [`MAX_ATTEMPTS`]
//! claims, and mail recipients reached are stored one by one, so a repetition skips them.
//!
//! The worker runs on the leading server only (like the scheduler), so the leases are compared
//! with that one server's clock: two servers with clocks apart never judge the same lease. A
//! change of the leader can overlap with a send of the old leader for at most one attempt; the
//! message then arrives twice with the same `Kalzit-Delivery` id.

use std::collections::BTreeSet;
use std::time::Duration;

use futures_util::future::BoxFuture;
use sqlx::AnyConnection;

use super::contact_points::{self, Settings};
use super::eval::Notification;
use super::message::{self, Instance, Message};
use crate::app::AppState;
use crate::error::ApiResult;
use crate::mail::templates::Lang;

/// Attempts per message: the first right after the evaluation, then after each pause.
pub const MAX_ATTEMPTS: i64 = 3;
/// The pause before the second and the third attempt.
pub const RETRY_AFTER_MS: [i64; 2] = [10_000, 60_000];
/// The longest one attempt may take: 10 seconds for a webhook (`webhook::TIMEOUT`); a mail
/// attempt has 10 seconds per recipient and at most this in all.
pub const ATTEMPT_LIMIT: Duration = Duration::from_secs(60);
/// Time per mail recipient.
const MAIL_RECIPIENT_LIMIT: Duration = Duration::from_secs(10);
/// How long a claimed message is left to its sender before another may try it: far above the
/// longest attempt.
const LEASE_MS: i64 = 5 * 60_000;
/// Messages claimed and sent at once by one worker run.
const BATCH: i64 = 16;

/// Records what `notifications` owe each contact point of the rule as one message per contact
/// point, inside the evaluation's transaction. `template` is the message without instances and
/// id. Notifications whose key a contact point has already been sent are left out. Answers the
/// number of messages recorded.
pub async fn record(
    conn: &mut AnyConnection,
    template: &Message,
    contact_point_ids: &[String],
    notifications: &[Notification],
    now: i64,
) -> ApiResult<usize> {
    let mut recorded = 0;
    for contact_point_id in contact_point_ids {
        let delivery_id = uuid::Uuid::now_v7().to_string();
        let mut fresh: Vec<Instance> = Vec::new();
        for n in notifications {
            let inserted = sqlx::query(
                "INSERT INTO alert_delivery_keys (dedup_key, org_id, delivery_id, created_at) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (dedup_key) DO NOTHING",
            )
            .bind(n.dedup_key(contact_point_id))
            .bind(&template.organization.id)
            .bind(&delivery_id)
            .bind(now)
            .execute(&mut *conn)
            .await?
            .rows_affected();
            if inserted == 1 {
                fresh.push(Instance::from(n));
            }
        }
        if fresh.is_empty() {
            continue;
        }
        let message = Message {
            event: message::message_event(&fresh).to_string(),
            delivery_id: delivery_id.clone(),
            instances: fresh,
            ..template.clone()
        };
        sqlx::query(
            "INSERT INTO alert_deliveries (id, org_id, rule_id, contact_point_id, event, message, attempts, \
             next_attempt_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7)",
        )
        .bind(&delivery_id)
        .bind(&message.organization.id)
        .bind(&message.rule.id)
        .bind(contact_point_id)
        .bind(&message.event)
        .bind(serde_json::to_string(&message).expect("a message always serializes"))
        .bind(now)
        .execute(&mut *conn)
        .await?;
        recorded += 1;
    }
    Ok(recorded)
}

/// One message to one contact point, as a transport sends it.
pub struct Outgoing {
    /// The stored message (`alert_deliveries.id`); `None` for a test send.
    pub delivery_id: Option<String>,
    pub org_id: String,
    pub contact_point_id: String,
    /// `mail` or `webhook`.
    pub kind: String,
    pub settings: Settings,
    pub message: Message,
    /// Mail recipients an earlier attempt reached already.
    pub sent_to: Vec<String>,
}

/// How one attempt ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attempt {
    pub ok: bool,
    /// `ok`, or why not (`503`, `timeout`, `mail.connection_lost`), never content.
    pub result: String,
    /// Mail recipients reached so far, this attempt included.
    pub sent_to: Vec<String>,
}

/// Sends a message: the real channels ([`Channels`]), or a fake in tests.
pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt>;
}

/// The mail and webhook channels of the server.
pub struct Channels(pub AppState);

impl Transport for Channels {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt> {
        Box::pin(send_now(&self.0, out))
    }
}

fn failed(result: &str, sent_to: &[String]) -> Attempt {
    Attempt { ok: false, result: result.to_string(), sent_to: sent_to.to_vec() }
}

/// Sends `out` through its channel once, within `limit`; an attempt that takes longer ends as
/// `timeout` (mail recipients reached before stay reached).
pub async fn send_within(state: &AppState, out: &Outgoing, limit: Duration) -> Attempt {
    match tokio::time::timeout(limit, send_now(state, out)).await {
        Ok(attempt) => attempt,
        Err(_) => {
            let sent_to = match &out.delivery_id {
                Some(id) => stored_sent_to(state, id).await.unwrap_or_else(|| out.sent_to.clone()),
                None => out.sent_to.clone(),
            };
            failed("timeout", &sent_to)
        }
    }
}

async fn stored_sent_to(state: &AppState, delivery_id: &str) -> Option<Vec<String>> {
    let row: Option<(Option<String>,)> = sqlx::query_as("SELECT sent_to FROM alert_deliveries WHERE id = $1")
        .bind(delivery_id)
        .fetch_optional(&state.db)
        .await
        .ok()?;
    row.and_then(|(s,)| s).and_then(|s| serde_json::from_str(&s).ok())
}

/// Sends `out` through its channel once.
async fn send_now(state: &AppState, out: &Outgoing) -> Attempt {
    match out.kind.as_str() {
        "mail" => send_mail(state, out).await,
        "webhook" => {
            let Some(url) = out.settings.url.as_deref() else { return failed("failed", &[]) };
            let now = state.clock.now_ms();
            let secrets =
                match contact_points::signing_secrets(&state.db, &state.secrets, &out.contact_point_id, now).await {
                    Ok(secrets) => secrets,
                    Err(e) => {
                        tracing::warn!("webhook delivery: the secret cannot be read: {}", e.message);
                        return failed("failed", &[]);
                    }
                };
            let max = match super::limits::for_org(state, &out.org_id).await {
                Ok(limits) => usize::try_from(limits.webhook_max_bytes).unwrap_or(usize::MAX),
                Err(e) => {
                    tracing::warn!("webhook delivery: the limits cannot be read: {}", e.message);
                    return failed("failed", &[]);
                }
            };
            let body = out.message.webhook_body(max);
            let secrets: Vec<&str> = secrets.iter().map(|s| s.as_str()).collect();
            let (ok, result) =
                super::webhook::send(state, url, body, &secrets, &out.message.delivery_id, &out.message.event).await;
            Attempt { ok, result, sent_to: Vec::new() }
        }
        _ => failed("failed", &[]),
    }
}

/// Mails every recipient not reached yet, each within 10 seconds; a refusal of one recipient
/// leaves the others sent, a failure of the server or the connection ends the attempt. Each
/// recipient reached is stored at once, so a repeated attempt does not mail them again.
async fn send_mail(state: &AppState, out: &Outgoing) -> Attempt {
    let effective = match crate::mail::settings::effective(state).await {
        Ok(e) if e.configured() => e,
        Ok(_) => return failed("mail.not_configured", &out.sent_to),
        Err(e) => {
            tracing::warn!("alert mail: the mail settings cannot be read: {}", e.message);
            return failed("failed", &out.sent_to);
        }
    };
    let zone = crate::mail::time_zone(state, Some(&out.org_id)).await.ok().flatten();
    let content = out.message.mail(Lang::parse(&out.settings.language), zone.as_deref(), &crate::mail::host(state));
    let mut sent_to = out.sent_to.clone();
    let mut result = "ok".to_string();
    for to in &out.settings.recipients {
        if sent_to.contains(to) {
            continue;
        }
        match tokio::time::timeout(MAIL_RECIPIENT_LIMIT, crate::mail::send(state, &effective, to, &content)).await {
            Ok(Ok(_)) => {
                sent_to.push(to.clone());
                if let Some(id) = &out.delivery_id
                    && let Err(e) = sqlx::query("UPDATE alert_deliveries SET sent_to = $1 WHERE id = $2")
                        .bind(serde_json::to_string(&sent_to).expect("addresses always serialize"))
                        .bind(id)
                        .execute(&state.db)
                        .await
                {
                    tracing::warn!("alert mail {id}: the recipients reached cannot be stored: {e}");
                }
            }
            Ok(Err(e)) => {
                tracing::info!("alert mail {} not sent to one recipient: {}", out.message.delivery_id, e.message);
                result = e.reason.to_string();
                if e.connection {
                    break;
                }
            }
            Err(_) => {
                tracing::info!("alert mail {}: the mail server did not answer in time", out.message.delivery_id);
                result = "timeout".to_string();
                break;
            }
        }
    }
    let all: BTreeSet<&String> = out.settings.recipients.iter().collect();
    let ok = all.iter().all(|r| sent_to.contains(r));
    Attempt { ok, result: if ok { "ok".into() } else { result }, sent_to }
}

/// Writes one attempt of `message` to the history (one entry per instance; a test send has one
/// without a rule) and as the contact point's last delivery.
pub async fn record_attempt(
    conn: &mut AnyConnection,
    org_id: &str,
    contact_point_id: &str,
    message: &Message,
    attempt: i64,
    outcome: &Attempt,
    now: i64,
) -> ApiResult<()> {
    let entries: Vec<(&str, String, &str)> = if message.instances.is_empty() {
        vec![("", "{}".to_string(), message.event.as_str())]
    } else {
        message
            .instances
            .iter()
            .map(|i| {
                let labels = serde_json::to_string(&i.labels).expect("labels always serialize");
                (i.fingerprint.as_str(), labels, i.event.as_str())
            })
            .collect()
    };
    for (fingerprint, labels, event) in entries {
        sqlx::query(
            "INSERT INTO alert_history (id, org_id, rule_id, rule_name, fingerprint, labels, kind, contact_point_id, \
             event, attempt, result, at) VALUES ($1, $2, $3, $4, $5, $6, 'delivery', $7, $8, $9, $10, $11)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(org_id)
        .bind(&message.rule.id)
        .bind(&message.rule.name)
        .bind(fingerprint)
        .bind(labels)
        .bind(contact_point_id)
        .bind(event)
        .bind(attempt)
        .bind(&outcome.result)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    sqlx::query(
        "UPDATE alert_contact_points SET last_delivery_at = $1, last_delivery_ok = $2, last_delivery_error = $3 \
         WHERE id = $4",
    )
    .bind(now)
    .bind(i64::from(outcome.ok))
    .bind((!outcome.ok).then_some(outcome.result.as_str()))
    .bind(contact_point_id)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

type Claimed = (String, String, String, String, i64, Option<String>, String, String);

/// Messages whose last attempt was claimed but never finished (its sender stopped) are given up
/// once every attempt was claimed.
async fn give_up_interrupted(state: &AppState, now: i64) -> ApiResult<()> {
    let stuck: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, contact_point_id, org_id FROM alert_deliveries WHERE done_at IS NULL AND attempts >= $1 \
         AND lease_until IS NOT NULL AND lease_until < $2",
    )
    .bind(MAX_ATTEMPTS)
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for (id, contact_point_id, _) in stuck {
        let done = sqlx::query(
            "UPDATE alert_deliveries SET done_at = $1, result = 'interrupted', lease_until = NULL \
             WHERE id = $2 AND done_at IS NULL AND lease_until < $1",
        )
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?
        .rows_affected();
        if done == 1 {
            tracing::warn!(
                "alert delivery {id} to contact point {contact_point_id} was interrupted {MAX_ATTEMPTS} times; given up"
            );
        }
    }
    Ok(())
}

/// Sends every message that is due now, a batch at a time, until none is left. Answers how many
/// attempts were made.
pub async fn deliver_due(state: &AppState, transport: &dyn Transport) -> ApiResult<usize> {
    let mut total = 0;
    loop {
        let made = deliver_batch(state, transport).await?;
        total += made;
        if made == 0 {
            return Ok(total);
        }
    }
}

async fn deliver_batch(state: &AppState, transport: &dyn Transport) -> ApiResult<usize> {
    let now = state.clock.now_ms();
    give_up_interrupted(state, now).await?;
    let due: Vec<(String,)> = sqlx::query_as(
        "SELECT id FROM alert_deliveries WHERE done_at IS NULL AND attempts < $1 AND next_attempt_at <= $2 \
         AND (lease_until IS NULL OR lease_until < $2) ORDER BY next_attempt_at, id LIMIT $3",
    )
    .bind(MAX_ATTEMPTS)
    .bind(now)
    .bind(BATCH)
    .fetch_all(&state.db)
    .await?;
    let mut work = Vec::new();
    for (id,) in due {
        // The attempt counts from here: a sender that dies in it has used it up.
        let claimed = sqlx::query(
            "UPDATE alert_deliveries SET lease_until = $1, attempts = attempts + 1 WHERE id = $2 AND done_at IS NULL \
             AND attempts < $3 AND (lease_until IS NULL OR lease_until < $4)",
        )
        .bind(now + LEASE_MS)
        .bind(&id)
        .bind(MAX_ATTEMPTS)
        .bind(now)
        .execute(&state.db)
        .await?
        .rows_affected();
        if claimed != 1 {
            continue;
        }
        let row: Option<Claimed> = sqlx::query_as(
            "SELECT d.id, d.org_id, d.contact_point_id, d.message, d.attempts, d.sent_to, c.kind, c.settings \
             FROM alert_deliveries d JOIN alert_contact_points c ON c.id = d.contact_point_id WHERE d.id = $1",
        )
        .bind(&id)
        .fetch_optional(&state.db)
        .await?;
        let Some((id, org_id, contact_point_id, raw, attempt, sent_to, kind, settings)) = row else { continue };
        let (Ok(message), Ok(settings)) =
            (serde_json::from_str::<Message>(&raw), serde_json::from_str::<Settings>(&settings))
        else {
            tracing::warn!("alert delivery {id} cannot be read; it is given up");
            sqlx::query(
                "UPDATE alert_deliveries SET done_at = $1, result = 'failed', lease_until = NULL WHERE id = $2",
            )
            .bind(now)
            .bind(&id)
            .execute(&state.db)
            .await?;
            continue;
        };
        let sent_to: Vec<String> = sent_to.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let out =
            Outgoing { delivery_id: Some(id.clone()), org_id, contact_point_id, kind, settings, message, sent_to };
        work.push((id, attempt, out));
    }
    let made = work.len();
    // Each message is finished as soon as its attempt ends, not after the whole batch.
    let sends = work.into_iter().map(|(id, attempt, out)| async move {
        let outcome = match tokio::time::timeout(ATTEMPT_LIMIT, transport.send(&out)).await {
            Ok(outcome) => outcome,
            Err(_) => failed("timeout", &out.sent_to),
        };
        if let Err(e) = finish(state, &id, attempt, &out, &outcome).await {
            tracing::warn!("alert delivery {id}: the attempt cannot be stored: {}", e.message);
        }
    });
    futures_util::future::join_all(sends).await;
    Ok(made)
}

/// Stores how an attempt ended: done when it arrived or was the last, else due again after the
/// pause.
async fn finish(state: &AppState, id: &str, attempt: i64, out: &Outgoing, outcome: &Attempt) -> ApiResult<()> {
    let now = state.clock.now_ms();
    let done = outcome.ok || attempt >= MAX_ATTEMPTS;
    let pause = RETRY_AFTER_MS.get(usize::try_from(attempt - 1).unwrap_or(0)).copied().unwrap_or(0);
    let mut tx = crate::db::begin(&state.db).await?;
    sqlx::query(
        "UPDATE alert_deliveries SET sent_to = $1, result = $2, lease_until = NULL, \
         done_at = $3, next_attempt_at = $4 WHERE id = $5",
    )
    .bind(serde_json::to_string(&outcome.sent_to).expect("addresses always serialize"))
    .bind(&outcome.result)
    .bind(done.then_some(now))
    .bind(now + pause)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    record_attempt(&mut tx, &out.org_id, &out.contact_point_id, &out.message, attempt, outcome, now).await?;
    crate::db::commit(tx).await?;
    state.metrics.alert_delivery(outcome.ok);
    if !outcome.ok && done {
        tracing::warn!(
            "alert delivery {id} to contact point {} failed {attempt} times ({}); given up",
            out.contact_point_id,
            outcome.result
        );
    }
    Ok(())
}

/// Runs the worker on the leading server: after every evaluation that recorded a message, and
/// every few seconds for the retries and for messages a stopped server left.
pub fn spawn(state: AppState) {
    let stopping = state.background.stopping();
    let background = state.background.clone();
    background.spawn(async move {
        let transport = Channels(state.clone());
        loop {
            let leads = !state.cluster.coordinated() || state.cluster.is_leader();
            if leads && let Err(e) = deliver_due(&state, &transport).await {
                tracing::warn!("alert deliveries: {}", e.message);
            }
            tokio::select! {
                () = stopping.cancelled() => return,
                () = state.alerting.outbox.notified() => {}
                () = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
            }
        }
    });
}
