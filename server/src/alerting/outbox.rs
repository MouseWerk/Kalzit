//! The delivery outbox (docs/PLAN.md section 13, "Zustellung"): an evaluation records the
//! messages to send in the same transaction as its instances and transitions ([`record`]), the
//! group dispatcher records a group's messages in the transaction that marks them sent
//! ([`record_group`]); a worker sends them after the commit ([`deliver_due`]), in the background,
//! up to [`MAX_ATTEMPTS`] times with a pause between attempts.
//!
//! Nothing is sent twice: every instance notification is recorded per contact point under its
//! deduplication key (`eval::dedup_key`, table `alert_delivery_keys`), and a key that
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
//!
//! # Fairness and limits
//!
//! The worker keeps up to [`MAX_IN_FLIGHT`] messages on their way and claims more whenever a
//! slot is free: when a send ends, when an evaluation recorded a message, and every second, never
//! waiting for the slowest send. Organizations take turns (oldest due first within each), with at
//! most [`MAX_IN_FLIGHT_PER_ORG`] messages of one organization and
//! [`MAX_IN_FLIGHT_PER_CONTACT_POINT`] to one contact point at once, so a slow or unreachable
//! receiver of one organization does not hold up the others. After [`BREAKER_FAILURES`] attempts
//! in a row that did not reach the receiver (`timeout`, `connection`, a mail server that cannot
//! be reached), the worker backs off that contact point for [`BREAKER_OPEN_MS`]: its waiting
//! messages are due again after that pause (result `circuit_open`), without using up an attempt;
//! an answer from the receiver releases them at once.
//!
//! An organization has at most [`MAX_PENDING_PER_ORG`] messages waiting and a contact point at
//! most [`MAX_PENDING_PER_CONTACT_POINT`]; a message beyond that is not queued but recorded at
//! once with the result `queue_full`. A message still waiting [`MAX_WAIT_MS`] after it was
//! recorded is given up as `expired`. At most `alerting.max_messages_per_org_hour` messages of an
//! organization go out per hour (first attempts; retries do not count); a message beyond that is
//! given up with the result `rate_limited`. A message that carries a resolve is exempt from the
//! waiting and hourly limits, since each reported firing owes at most one. All of these show in
//! the history like any other delivery; held-back messages do not count as failed deliveries.
//! Group messages ([`record_group`]) go through the same limits, worker and breakers; their
//! resolves travel in a message of their own too.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::FuturesUnordered;
use sqlx::AnyConnection;

use super::contact_points::{self, Settings};
use super::eval::{Event, Notification, State, dedup_key};
use super::group_message::{Alert, GroupMessage, Kind, Payload};
use super::message::{self, Instance, Message};
use crate::app::AppState;
use crate::error::ApiResult;
use crate::locks::MutexExt;
use crate::mail::templates::Lang;

/// Attempts per message: the first right after the evaluation, then after each pause.
pub const MAX_ATTEMPTS: i64 = 3;
/// The pause before the second and the third attempt.
pub const RETRY_AFTER_MS: [i64; 2] = [10_000, 60_000];
/// The longest `Retry-After` of a `429` that moves the next attempt (Slack, Teams).
pub const MAX_RETRY_AFTER_SECS: u64 = 60;
/// The longest one attempt may take: 10 seconds for a webhook (`webhook::TIMEOUT`); a mail
/// attempt has 10 seconds per recipient and at most this in all.
pub const ATTEMPT_LIMIT: Duration = Duration::from_secs(60);
/// Time per mail recipient.
const MAIL_RECIPIENT_LIMIT: Duration = Duration::from_secs(10);
/// How long a claimed message is left to its sender before another may try it: far above the
/// longest attempt.
const LEASE_MS: i64 = 5 * 60_000;
/// Messages on their way at once, in all.
pub const MAX_IN_FLIGHT: usize = 16;
/// Messages of one organization on their way at once.
pub const MAX_IN_FLIGHT_PER_ORG: usize = 4;
/// Messages to one contact point on their way at once.
pub const MAX_IN_FLIGHT_PER_CONTACT_POINT: usize = 2;
/// Attempts in a row that end in `timeout` or `connection` before the worker backs off.
pub const BREAKER_FAILURES: u32 = 3;
/// How long the worker backs off from such a contact point.
pub const BREAKER_OPEN_MS: i64 = 5 * 60_000;
/// Messages of one organization waiting to be sent, at most.
pub const MAX_PENDING_PER_ORG: i64 = 1_000;
/// Messages to one contact point waiting to be sent, at most, so a dead receiver cannot fill
/// its organization's queue.
pub const MAX_PENDING_PER_CONTACT_POINT: i64 = 100;
/// A message still waiting this long after it was recorded (its receiver kept failing or was
/// paused) is given up with the result [`EXPIRED`].
pub const MAX_WAIT_MS: i64 = 3_600_000;
const HOUR_MS: i64 = 3_600_000;
/// How often a run looks for new or newly due messages while sends are on their way.
const TICK: Duration = Duration::from_secs(1);
/// How long a run keeps an organization's message limit before it reads it again.
const LIMIT_REREAD: Duration = Duration::from_secs(60);

/// The result of a message that was not queued because its organization had
/// [`MAX_PENDING_PER_ORG`] waiting.
pub const QUEUE_FULL: &str = "queue_full";
/// The result of a message beyond `alerting.max_messages_per_org_hour`.
pub const RATE_LIMITED: &str = "rate_limited";
/// The result of waiting messages while the worker backs off from their contact point.
pub const CIRCUIT_OPEN: &str = "circuit_open";
/// The result of a message given up after [`MAX_WAIT_MS`].
pub const EXPIRED: &str = "expired";

/// Results held back by a limit before any attempt: no failed delivery of the contact point.
fn held_back(result: &str) -> bool {
    matches!(result, QUEUE_FULL | RATE_LIMITED)
}

/// Results that say the receiver could not be reached at all (no answer, no connection).
fn unreachable(result: &str) -> bool {
    matches!(result, "timeout" | "connection" | "mail.connection_lost" | "mail.no_answer" | "mail.refused")
}

/// Whether a message carries resolves only ([`record`] and [`record_group`] put resolves in a
/// message of their own). A resolve is owed once per firing that was reported, so such a message
/// is exempt from the waiting and hourly limits and does not expire: they never leave an alert
/// open at a receiver.
fn owes_resolve(message: &Payload) -> bool {
    match message {
        Payload::Rule(m) => !m.instances.is_empty() && m.instances.iter().all(|i| i.event == Event::Resolved),
        Payload::Group(m) => !m.alerts.is_empty() && m.alerts.iter().all(|a| a.instance.event == Event::Resolved),
    }
}

/// Messages waiting for the organization and for one contact point.
async fn pending_counts(conn: &mut AnyConnection, org_id: &str, contact_point_id: &str) -> ApiResult<(i64, i64)> {
    let (org,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_deliveries WHERE org_id = $1 AND done_at IS NULL")
        .bind(org_id)
        .fetch_one(&mut *conn)
        .await?;
    let (here,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM alert_deliveries WHERE contact_point_id = $1 AND done_at IS NULL")
            .bind(contact_point_id)
            .fetch_one(&mut *conn)
            .await?;
    Ok((org, here))
}

/// Records a deduplication key; false when it was recorded before.
async fn claim_key(conn: &mut AnyConnection, key: &str, org_id: &str, delivery_id: &str, now: i64) -> ApiResult<bool> {
    let inserted = sqlx::query(
        "INSERT INTO alert_delivery_keys (dedup_key, org_id, delivery_id, created_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (dedup_key) DO NOTHING",
    )
    .bind(key)
    .bind(org_id)
    .bind(delivery_id)
    .bind(now)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    Ok(inserted == 1)
}

/// Frees the key (stage `0`) of the state a rerouted resolve ends at a contact point.
async fn free_key(
    conn: &mut AnyConnection,
    fingerprint: &str,
    contact_point_id: &str,
    state: State,
    since: i64,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM alert_delivery_keys WHERE dedup_key = $1")
        .bind(dedup_key(fingerprint, contact_point_id, state, since, "0"))
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// Stores a recorded message: queued, or (without a resolve, over the waiting caps) done as
/// [`QUEUE_FULL`] and in the history. Answers whether it was queued.
#[allow(clippy::too_many_arguments)]
async fn enqueue(
    conn: &mut AnyConnection,
    payload: &Payload,
    org_id: &str,
    rule_id: &str,
    contact_point_id: &str,
    pending: &mut (i64, i64),
    group: Option<(&str, &str, &str)>,
    now: i64,
) -> ApiResult<bool> {
    let full =
        !owes_resolve(payload) && (pending.0 >= MAX_PENDING_PER_ORG || pending.1 >= MAX_PENDING_PER_CONTACT_POINT);
    let delivery_id = payload.delivery_id();
    sqlx::query(
        "INSERT INTO alert_deliveries (id, org_id, rule_id, contact_point_id, event, message, attempts, \
         next_attempt_at, created_at, done_at, result, group_id, policy_id, stage) \
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7, $8, $9, $10, $11, $12)",
    )
    .bind(delivery_id)
    .bind(org_id)
    .bind(rule_id)
    .bind(contact_point_id)
    .bind(payload.event())
    .bind(serde_json::to_string(payload).expect("a message always serializes"))
    .bind(now)
    .bind(full.then_some(now))
    .bind(full.then_some(QUEUE_FULL))
    .bind(group.map(|g| g.0))
    .bind(group.map(|g| g.1))
    .bind(group.map(|g| g.2))
    .execute(&mut *conn)
    .await?;
    if full {
        tracing::warn!(
            "alert delivery {delivery_id}: too many messages wait for organization {org_id} or contact point \
             {contact_point_id}; not queued"
        );
        record_attempt(conn, org_id, contact_point_id, payload, 0, &failed(QUEUE_FULL, &[]), now).await?;
        return Ok(false);
    }
    pending.0 += 1;
    pending.1 += 1;
    Ok(true)
}

/// How an attempt changed the worker's view of its contact point.
#[derive(Debug, PartialEq, Eq)]
enum BreakerChange {
    None,
    /// The worker backs off until then.
    Opened(i64),
    /// The receiver answered after failures or a pause: its paused messages may go again.
    Closed,
}

/// The contact points the worker backs off from, by id: attempts in a row that did not reach the
/// receiver, and until when it waits (Unix milliseconds of the server's clock). Kept in memory on
/// the leading server; a change of the leader starts afresh.
#[derive(Default)]
pub struct Breakers(std::sync::Mutex<HashMap<String, (u32, i64)>>);

impl Breakers {
    /// Until when the worker backs off from the contact point, if it does at `now`.
    pub fn open_until(&self, contact_point_id: &str, now: i64) -> Option<i64> {
        self.0.lock_or_recover().get(contact_point_id).map(|(_, until)| *until).filter(|until| *until > now)
    }

    /// Counts an attempt's result.
    fn record(&self, contact_point_id: &str, result: &str, now: i64) -> BreakerChange {
        let mut all = self.0.lock_or_recover();
        if !unreachable(result) {
            return match all.remove(contact_point_id) {
                Some(_) => BreakerChange::Closed,
                None => BreakerChange::None,
            };
        }
        let entry = all.entry(contact_point_id.to_string()).or_insert((0, 0));
        // Sends that were on their way when it opened do not count towards the next pause.
        if entry.1 > now {
            return BreakerChange::None;
        }
        entry.0 += 1;
        if entry.0 < BREAKER_FAILURES {
            return BreakerChange::None;
        }
        *entry = (0, now + BREAKER_OPEN_MS);
        BreakerChange::Opened(entry.1)
    }

    /// Forgets everything; for a server that just gained the lead.
    fn clear(&self) {
        self.0.lock_or_recover().clear();
    }

    /// Drops contact points whose pause ended and that have no failures counted (deleted ones
    /// among them).
    fn prune(&self, now: i64) {
        self.0.lock_or_recover().retain(|_, (failures, until)| *failures > 0 || *until > now);
    }
}

/// First attempts per organization in the last hour (Unix milliseconds of the server's clock),
/// for `alerting.max_messages_per_org_hour`. Kept in memory on the leading server; an
/// organization the server has not counted yet starts from the messages first sent in the
/// hour before, as far as the database tells (their record time).
#[derive(Default)]
pub struct SentPerHour(std::sync::Mutex<HashMap<String, std::collections::VecDeque<i64>>>);

impl SentPerHour {
    fn known(&self, org_id: &str) -> bool {
        self.0.lock_or_recover().contains_key(org_id)
    }

    fn seed(&self, org_id: &str, times: Vec<i64>) {
        self.0.lock_or_recover().entry(org_id.to_string()).or_insert_with(|| times.into_iter().collect());
    }

    /// Takes one message of the hour for the organization at `now`; `false` when `limit` were
    /// sent in the hour before.
    fn take(&self, org_id: &str, limit: u64, now: i64) -> bool {
        let mut all = self.0.lock_or_recover();
        let times = all.entry(org_id.to_string()).or_default();
        while times.front().is_some_and(|t| *t <= now - HOUR_MS) {
            times.pop_front();
        }
        if u64::try_from(times.len()).unwrap_or(u64::MAX) >= limit {
            return false;
        }
        times.push_back(now);
        true
    }

    /// Forgets everything; for a server that just gained the lead.
    fn clear(&self) {
        self.0.lock_or_recover().clear();
    }

    /// Drops organizations without a message in the last hour (deleted ones among them).
    fn prune(&self, now: i64) {
        self.0.lock_or_recover().retain(|_, times| times.back().is_some_and(|t| *t > now - HOUR_MS));
    }
}

/// Records what `notifications` owe each contact point of the rule as one message per contact
/// point, inside the evaluation's transaction. `template` is the message without instances and
/// id. Notifications whose key a contact point has already been sent are left out. While the
/// organization has [`MAX_PENDING_PER_ORG`] or the contact point [`MAX_PENDING_PER_CONTACT_POINT`]
/// messages waiting, a new one without a resolve is stored as done with the result
/// [`QUEUE_FULL`] and written to the history instead. Answers the number of messages queued.
pub async fn record(
    conn: &mut AnyConnection,
    template: &Message,
    contact_point_ids: &[String],
    notifications: &[Notification],
    now: i64,
) -> ApiResult<usize> {
    record_with(conn, template, contact_point_ids, notifications, None, now).await
}

/// A resolve of a rule's own message keyed with another stage than its notification's (`r` for
/// one sent because the instance now takes another way), which frees the key of the state it
/// resolves for each contact point it reaches, so a return of the instance is sent again.
pub struct Restage<'a> {
    pub stage: &'a str,
    pub release: Option<State>,
}

/// `record`, with the keys of `restage` when given.
pub async fn record_with(
    conn: &mut AnyConnection,
    template: &Message,
    contact_point_ids: &[String],
    notifications: &[Notification],
    restage: Option<&Restage<'_>>,
    now: i64,
) -> ApiResult<usize> {
    let mut recorded = 0;
    let org_id = template.organization.id.clone();
    for contact_point_id in contact_point_ids {
        let mut pending = pending_counts(conn, &org_id, contact_point_id).await?;
        // Resolves travel in a message of their own, so only resolves skip the limits.
        let ids = [uuid::Uuid::now_v7().to_string(), uuid::Uuid::now_v7().to_string()];
        let mut parts: [Vec<Instance>; 2] = [Vec::new(), Vec::new()];
        for n in notifications {
            let part = usize::from(n.event == Event::Resolved);
            let key = match restage {
                Some(r) => dedup_key(&n.fingerprint, contact_point_id, n.state, n.state_since, r.stage),
                None => n.dedup_key(contact_point_id),
            };
            if claim_key(conn, &key, &org_id, &ids[part], now).await? {
                parts[part].push(Instance::from(n));
                if let Some(released) = restage.and_then(|r| r.release) {
                    free_key(conn, &n.fingerprint, contact_point_id, released, n.state_since).await?;
                }
            }
        }
        for (delivery_id, fresh) in ids.into_iter().zip(parts) {
            if fresh.is_empty() {
                continue;
            }
            let message = Payload::Rule(Message {
                event: message::message_event(&fresh).to_string(),
                delivery_id,
                instances: fresh,
                ..template.clone()
            });
            if enqueue(conn, &message, &org_id, &template.rule.id, contact_point_id, &mut pending, None, now).await? {
                recorded += 1;
            }
        }
    }
    Ok(recorded)
}

/// One instance of a group's message and whether it is recorded under a deduplication key (a
/// change, a repetition, an escalation) or only shown with the others (an instance that keeps
/// firing in a change's message).
pub struct GroupEntry {
    pub alert: Alert,
    pub keyed: bool,
    /// The stage of its key when not the message's (`r` for a rerouted resolve).
    pub stage: Option<String>,
    /// Contact points this entry is not sent to (they still have the instance another way).
    pub skip: BTreeSet<String>,
    /// For a rerouted resolve: the state it resolves, whose key (stage `0`) is freed for each
    /// contact point the resolve reaches.
    pub release: Option<State>,
}

impl GroupEntry {
    pub fn keyed(alert: Alert) -> Self {
        GroupEntry { alert, keyed: true, stage: None, skip: BTreeSet::new(), release: None }
    }

    pub fn shown(alert: Alert) -> Self {
        GroupEntry { alert, keyed: false, stage: None, skip: BTreeSet::new(), release: None }
    }
}

/// Records a group's message for each contact point inside the dispatcher's transaction: per
/// contact point the keyed entries not sent there before (under the group's stage), and with them
/// the shown ones. A contact point that has every keyed entry already gets nothing. Resolves go
/// in a message of their own (exempt from the waiting caps, the hourly limit and expiry, like a
/// rule's); the rest is subject to them as [`record`]. At most
/// [`super::group_message::MAX_ALERTS`] instances are written out, the rest counted. Answers the
/// number of messages queued.
pub async fn record_group(
    conn: &mut AnyConnection,
    template: &GroupMessage,
    contact_point_ids: &[String],
    entries: &[GroupEntry],
    now: i64,
) -> ApiResult<usize> {
    let mut recorded = 0;
    let org_id = template.organization.id.clone();
    for contact_point_id in contact_point_ids {
        let mut pending = pending_counts(conn, &org_id, contact_point_id).await?;
        let ids = [uuid::Uuid::now_v7().to_string(), uuid::Uuid::now_v7().to_string()];
        // [the rest, resolves]
        let mut fresh: [Vec<Alert>; 2] = [Vec::new(), Vec::new()];
        let mut shown: Vec<Alert> = Vec::new();
        for e in entries {
            if !e.keyed {
                shown.push(e.alert.clone());
                continue;
            }
            if e.skip.contains(contact_point_id) {
                continue;
            }
            let i = &e.alert.instance;
            let part = usize::from(i.event == Event::Resolved);
            let stage = e.stage.as_deref().unwrap_or(&template.group.stage);
            let key = dedup_key(&i.fingerprint, contact_point_id, i.state, i.state_since, stage);
            if claim_key(conn, &key, &org_id, &ids[part], now).await? {
                fresh[part].push(e.alert.clone());
                if let Some(resolved) = e.release {
                    free_key(conn, &i.fingerprint, contact_point_id, resolved, i.state_since).await?;
                }
            }
        }
        let [mut rest, resolves] = fresh;
        // The instances that keep firing are shown with the other changes; resolves stay a
        // message of resolves only.
        if !rest.is_empty() {
            rest.extend(shown);
        }
        let messages = [(ids[0].clone(), rest), (ids[1].clone(), resolves)];
        for (delivery_id, mut alerts) in messages {
            if alerts.is_empty() {
                continue;
            }
            let event = match template.group.kind {
                Kind::Change => {
                    let changed: Vec<Instance> =
                        alerts.iter().filter(|a| a.changed).map(|a| a.instance.clone()).collect();
                    message::message_event(&changed).to_string()
                }
                Kind::Repeat => "reminder".to_string(),
                Kind::Escalation => "escalation".to_string(),
            };
            let omitted = alerts.len().saturating_sub(super::group_message::MAX_ALERTS);
            alerts.truncate(super::group_message::MAX_ALERTS);
            let payload = Payload::Group(GroupMessage {
                event,
                delivery_id,
                alerts,
                omitted_alerts: omitted,
                ..template.clone()
            });
            let group = (template.group.id.as_str(), template.group.policy.id.as_str(), template.group.stage.as_str());
            if enqueue(conn, &payload, &org_id, "", contact_point_id, &mut pending, Some(group), now).await? {
                recorded += 1;
            }
        }
    }
    Ok(recorded)
}

/// One message to one contact point, as a transport sends it.
pub struct Outgoing {
    /// The stored message (`alert_deliveries.id`); `None` for a test send.
    pub delivery_id: Option<String>,
    pub org_id: String,
    pub contact_point_id: String,
    /// `mail`, `webhook`, `slack` or `teams`.
    pub kind: String,
    pub settings: Settings,
    pub message: Payload,
    /// Mail recipients an earlier attempt reached already.
    pub sent_to: Vec<String>,
}

/// How one attempt ended.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Attempt {
    pub ok: bool,
    /// `ok`, or why not (`503`, `429`, `timeout`, `mail.connection_lost`), never content.
    pub result: String,
    /// Mail recipients reached so far, this attempt included.
    pub sent_to: Vec<String>,
    /// The receiver's `Retry-After` of a `429` (Slack, Teams), in seconds.
    pub retry_after_secs: Option<u64>,
}

/// Sends a message: the real channels ([`Channels`]), or a fake in tests.
pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt>;
}

/// The mail, webhook, Slack and Teams channels of the server.
pub struct Channels(pub AppState);

impl Transport for Channels {
    fn send<'a>(&'a self, out: &'a Outgoing) -> BoxFuture<'a, Attempt> {
        Box::pin(send_now(&self.0, out))
    }
}

fn failed(result: &str, sent_to: &[String]) -> Attempt {
    Attempt { ok: false, result: result.to_string(), sent_to: sent_to.to_vec(), retry_after_secs: None }
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
                super::webhook::send(state, url, body, &secrets, out.message.delivery_id(), out.message.event()).await;
            Attempt { ok, result, sent_to: Vec::new(), retry_after_secs: None }
        }
        "slack" | "teams" => {
            let url = match contact_points::chat_url(&state.db, &state.secrets, &out.contact_point_id).await {
                Ok(url) => url,
                Err(e) => {
                    tracing::warn!("{} delivery: the url cannot be read: {}", out.kind, e.message);
                    return failed("failed", &[]);
                }
            };
            let zone = crate::mail::time_zone(state, Some(&out.org_id)).await.ok().flatten();
            let digest = out.message.digest(Lang::parse(&out.settings.language), zone.as_deref());
            let body = if out.kind == "slack" { super::chat::slack(&digest) } else { super::chat::teams(&digest) };
            let posted = super::chat::send(state, &url, &body, out.message.delivery_id()).await;
            Attempt {
                ok: posted.ok,
                result: posted.result,
                sent_to: Vec::new(),
                retry_after_secs: posted.retry_after_secs,
            }
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
                tracing::info!("alert mail {} not sent to one recipient: {}", out.message.delivery_id(), e.message);
                result = e.reason.to_string();
                if e.connection {
                    break;
                }
            }
            Err(_) => {
                tracing::info!("alert mail {}: the mail server did not answer in time", out.message.delivery_id());
                result = "timeout".to_string();
                break;
            }
        }
    }
    let all: BTreeSet<&String> = out.settings.recipients.iter().collect();
    let ok = all.iter().all(|r| sent_to.contains(r));
    Attempt { ok, result: if ok { "ok".into() } else { result }, sent_to, retry_after_secs: None }
}

/// Writes one attempt of `message` to the history (one entry per instance; a test send has one
/// without a rule) and as the contact point's last delivery. A group's message records its
/// group, policy and stage with each entry.
pub async fn record_attempt(
    conn: &mut AnyConnection,
    org_id: &str,
    contact_point_id: &str,
    message: &Payload,
    attempt: i64,
    outcome: &Attempt,
    now: i64,
) -> ApiResult<()> {
    let empty = Default::default();
    let mut entries = message.history_entries();
    if entries.is_empty() {
        entries.push(super::group_message::HistoryEntry {
            rule_id: match message {
                Payload::Rule(m) => &m.rule.id,
                Payload::Group(_) => "",
            },
            rule_name: match message {
                Payload::Rule(m) => &m.rule.name,
                Payload::Group(m) => &m.group.policy.name,
            },
            fingerprint: "",
            labels: &empty,
            event: message.event(),
        });
    }
    let group = message.group();
    for e in entries {
        sqlx::query(
            "INSERT INTO alert_history (id, org_id, rule_id, rule_name, fingerprint, labels, kind, contact_point_id, \
             event, attempt, result, at, group_id, policy_id, stage) \
             VALUES ($1, $2, $3, $4, $5, $6, 'delivery', $7, $8, $9, $10, $11, $12, $13, $14)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(org_id)
        .bind(e.rule_id)
        .bind(e.rule_name)
        .bind(e.fingerprint)
        .bind(serde_json::to_string(e.labels).expect("labels always serialize"))
        .bind(contact_point_id)
        .bind(e.event)
        .bind(attempt)
        .bind(&outcome.result)
        .bind(now)
        .bind(group.map(|g| g.id.as_str()))
        .bind(group.map(|g| g.policy.id.as_str()))
        .bind(group.map(|g| g.stage.as_str()))
        .execute(&mut *conn)
        .await?;
    }
    // A message a limit held back says nothing about the receiver.
    if held_back(&outcome.result) {
        return Ok(());
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

/// What the worker has on its way, per organization and contact point.
#[derive(Default)]
struct InFlight {
    total: usize,
    orgs: HashMap<String, usize>,
    contact_points: HashMap<String, usize>,
}

impl InFlight {
    fn add(&mut self, org_id: &str, contact_point_id: &str) {
        self.total += 1;
        *self.orgs.entry(org_id.to_string()).or_default() += 1;
        *self.contact_points.entry(contact_point_id.to_string()).or_default() += 1;
    }

    fn remove(&mut self, org_id: &str, contact_point_id: &str) {
        self.total = self.total.saturating_sub(1);
        if let Some(n) = self.orgs.get_mut(org_id) {
            *n = n.saturating_sub(1);
        }
        if let Some(n) = self.contact_points.get_mut(contact_point_id) {
            *n = n.saturating_sub(1);
        }
    }

    fn org(&self, org_id: &str) -> usize {
        self.orgs.get(org_id).copied().unwrap_or(0)
    }

    fn contact_point(&self, contact_point_id: &str) -> usize {
        self.contact_points.get(contact_point_id).copied().unwrap_or(0)
    }
}

/// A claimed message, ready to send.
struct Work {
    id: String,
    attempt: i64,
    out: Outgoing,
    /// Over the organization's messages per hour: already given up, not sent.
    rate_limited: bool,
}

/// What a run keeps between its claims.
#[derive(Default)]
struct Run {
    in_flight: InFlight,
    /// Each organization's `alerting.max_messages_per_org_hour`, with when it was read.
    limits: HashMap<String, (u64, std::time::Instant)>,
}

/// Sends every message that is due, until none is left and nothing is on its way, with up to
/// [`MAX_IN_FLIGHT`] on their way (see the module's "Fairness and limits"). While sends are on
/// their way the run claims again whenever one ends, an evaluation records a message, or a second
/// passed, so new and newly due messages do not wait for slow sends. Answers how many attempts
/// were made.
///
/// Only the sends run side by side; claiming and storing how a send ended happen one after the
/// other in this loop. A send that is not polled while the loop claims or stores therefore never
/// holds a transaction, so the loop cannot wait for a lock its own sends keep.
pub async fn deliver_due(state: &AppState, transport: &dyn Transport) -> ApiResult<usize> {
    let mut made = 0;
    let mut run = Run::default();
    let now = state.clock.now_ms();
    state.alerting.breakers.prune(now);
    state.alerting.sent.prune(now);
    let mut running: FuturesUnordered<BoxFuture<'_, (Work, Attempt)>> = FuturesUnordered::new();
    loop {
        let claimed = match claim_fair(state, &mut run).await {
            Ok(claimed) => claimed,
            Err(e) => {
                // What is on its way finishes and is stored before the run gives up.
                while let Some((work, outcome)) = running.next().await {
                    store(state, &work, &outcome).await;
                }
                return Err(e);
            }
        };
        for work in claimed {
            run.in_flight.add(&work.out.org_id, &work.out.contact_point_id);
            made += 1;
            running.push(Box::pin(send_one(transport, work)));
        }
        if running.is_empty() {
            return Ok(made);
        }
        let ended = tokio::select! {
            ended = running.next() => ended,
            () = state.alerting.outbox.notified() => None,
            () = tokio::time::sleep(TICK) => None,
        };
        if let Some((work, outcome)) = ended {
            store(state, &work, &outcome).await;
            run.in_flight.remove(&work.out.org_id, &work.out.contact_point_id);
        }
    }
}

/// Sends one claimed message (a rate-limited one is not sent); nothing is stored here.
async fn send_one(transport: &dyn Transport, work: Work) -> (Work, Attempt) {
    let outcome = if work.rate_limited {
        failed(RATE_LIMITED, &work.out.sent_to)
    } else {
        match tokio::time::timeout(ATTEMPT_LIMIT, transport.send(&work.out)).await {
            Ok(outcome) => outcome,
            Err(_) => failed("timeout", &work.out.sent_to),
        }
    };
    (work, outcome)
}

/// Stores how a send ended, and pauses or releases its contact point when the breaker changed.
async fn store(state: &AppState, work: &Work, outcome: &Attempt) {
    let Work { id, attempt, out, rate_limited } = work;
    if let Err(e) = finish(state, id, *attempt, out, outcome, *rate_limited).await {
        tracing::warn!("alert delivery {id}: the attempt cannot be stored: {}", e.message);
    }
    if *rate_limited {
        return;
    }
    let change = state.alerting.breakers.record(&out.contact_point_id, &outcome.result, state.clock.now_ms());
    let done = match change {
        BreakerChange::None => Ok(()),
        BreakerChange::Opened(until) => back_off(state, &out.contact_point_id, until).await,
        BreakerChange::Closed => release(state, &out.contact_point_id).await,
    };
    if let Err(e) = done {
        tracing::warn!("alert deliveries to contact point {}: {}", out.contact_point_id, e.message);
    }
}

/// Makes the waiting messages to a contact point due again at `until`, with the result
/// [`CIRCUIT_OPEN`], without using up an attempt. Runs once when the pause starts.
async fn back_off(state: &AppState, contact_point_id: &str, until: i64) -> ApiResult<()> {
    let now = state.clock.now_ms();
    let paused = sqlx::query(
        "UPDATE alert_deliveries SET next_attempt_at = $1, result = $2 WHERE contact_point_id = $3 \
         AND done_at IS NULL AND next_attempt_at < $1 AND (lease_until IS NULL OR lease_until < $4)",
    )
    .bind(until)
    .bind(CIRCUIT_OPEN)
    .bind(contact_point_id)
    .bind(now)
    .execute(&state.db)
    .await?
    .rows_affected();
    tracing::warn!(
        "alert deliveries to contact point {contact_point_id} did not reach it {BREAKER_FAILURES} times in a row; \
         paused until {until} ({paused} messages waiting)"
    );
    Ok(())
}

/// The receiver answered again: its paused messages are due now.
async fn release(state: &AppState, contact_point_id: &str) -> ApiResult<()> {
    let now = state.clock.now_ms();
    sqlx::query(
        "UPDATE alert_deliveries SET next_attempt_at = $1 WHERE contact_point_id = $2 AND done_at IS NULL \
         AND result = $3 AND next_attempt_at > $1 AND (lease_until IS NULL OR lease_until < $1)",
    )
    .bind(now)
    .bind(contact_point_id)
    .bind(CIRCUIT_OPEN)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Gives up messages that still wait [`MAX_WAIT_MS`] after they were recorded (result
/// [`EXPIRED`], in the history), a hundred at a time, so a receiver that stays unreachable does not
/// keep its contact point's queue full. A message of resolves only (event `resolved`) is owed and
/// does not expire; its attempts still end it once the receiver answers.
async fn give_up_stale(state: &AppState, now: i64) -> ApiResult<()> {
    let stale: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, org_id, contact_point_id, message, attempts FROM alert_deliveries WHERE done_at IS NULL \
         AND created_at < $1 AND event <> $3 AND (lease_until IS NULL OR lease_until < $2) \
         ORDER BY created_at, id LIMIT 100",
    )
    .bind(now - MAX_WAIT_MS)
    .bind(now)
    .bind(super::eval::Event::Resolved.as_str())
    .fetch_all(&state.db)
    .await?;
    for (id, org_id, contact_point_id, raw, attempts) in stale {
        let mut tx = crate::db::begin(&state.db).await?;
        let done = sqlx::query(
            "UPDATE alert_deliveries SET done_at = $1, result = $2, lease_until = NULL WHERE id = $3 \
             AND done_at IS NULL AND (lease_until IS NULL OR lease_until < $1)",
        )
        .bind(now)
        .bind(EXPIRED)
        .bind(&id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if done == 1
            && let Ok(message) = Payload::parse(&raw)
        {
            record_attempt(&mut tx, &org_id, &contact_point_id, &message, attempts, &failed(EXPIRED, &[]), now).await?;
        }
        crate::db::commit(tx).await?;
        if done == 1 {
            tracing::warn!("alert delivery {id} to contact point {contact_point_id} waited too long; given up");
        }
    }
    Ok(())
}

/// The organization's messages per hour, read again at least every minute within a run.
async fn hourly_limit(state: &AppState, run: &mut Run, org_id: &str) -> ApiResult<u64> {
    if let Some((limit, read)) = run.limits.get(org_id)
        && read.elapsed() < LIMIT_REREAD
    {
        return Ok(*limit);
    }
    let limit = super::limits::for_org(state, org_id).await?.max_messages_per_org_hour;
    run.limits.insert(org_id.to_string(), (limit, std::time::Instant::now()));
    if !state.alerting.sent.known(org_id) {
        // Not counted on this server yet (a restart, a new leader): the messages first sent in
        // the hour before, by their record time.
        let times: Vec<(i64,)> = sqlx::query_as(
            "SELECT created_at FROM alert_deliveries WHERE org_id = $1 AND created_at > $2 AND attempts > 0 \
             AND (result IS NULL OR result NOT IN ($3, $4)) ORDER BY created_at",
        )
        .bind(org_id)
        .bind(state.clock.now_ms() - HOUR_MS)
        .bind(RATE_LIMITED)
        .bind(QUEUE_FULL)
        .fetch_all(&state.db)
        .await?;
        state.alerting.sent.seed(org_id, times.into_iter().map(|(t,)| t).collect());
    }
    Ok(limit)
}

/// Claims the next messages for the free slots: organizations take turns, oldest due first,
/// within the limits per organization and contact point, past contact points the worker backs
/// off from. Nothing is claimed on a server that does not lead (any more).
async fn claim_fair(state: &AppState, run: &mut Run) -> ApiResult<Vec<Work>> {
    let mut free = MAX_IN_FLIGHT.saturating_sub(run.in_flight.total);
    if free == 0 || (state.cluster.coordinated() && !state.cluster.is_leader()) {
        return Ok(Vec::new());
    }
    let now = state.clock.now_ms();
    give_up_interrupted(state, now).await?;
    give_up_stale(state, now).await?;
    let pairs: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT org_id, contact_point_id, MIN(next_attempt_at) FROM alert_deliveries WHERE done_at IS NULL \
         AND attempts < $1 AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until < $2) \
         GROUP BY org_id, contact_point_id ORDER BY 3, 1, 2",
    )
    .bind(MAX_ATTEMPTS)
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    // Per organization (oldest due first) its contact points with messages due; paused ones wait.
    let mut orgs: Vec<(String, Vec<String>)> = Vec::new();
    for (org_id, contact_point_id, _) in pairs {
        if state.alerting.breakers.open_until(&contact_point_id, now).is_some() {
            continue;
        }
        match orgs.iter_mut().find(|(o, _)| *o == org_id) {
            Some((_, cps)) => cps.push(contact_point_id),
            None => orgs.push((org_id, vec![contact_point_id])),
        }
    }
    let mut taken = InFlight::default();
    let mut claimed = Vec::new();
    // One message per organization and turn, until the slots are used or nothing more fits.
    while free > 0 {
        let mut progress = false;
        for (org_id, cps) in &mut orgs {
            if free == 0 {
                break;
            }
            if run.in_flight.org(org_id) + taken.org(org_id) >= MAX_IN_FLIGHT_PER_ORG {
                continue;
            }
            // The first contact point with room; it moves to the back, so the next turn of this
            // organization takes another one.
            let Some(at) = cps.iter().position(|cp| {
                run.in_flight.contact_point(cp) + taken.contact_point(cp) < MAX_IN_FLIGHT_PER_CONTACT_POINT
            }) else {
                continue;
            };
            let cp = cps.remove(at);
            let limit = hourly_limit(state, run, org_id).await?;
            progress = true;
            // A contact point with nothing due any more (another worker took it) leaves the turns.
            if let Some(work) = claim_one(state, &cp, now, limit).await? {
                taken.add(org_id, &cp);
                claimed.push(work);
                free -= 1;
                cps.push(cp);
            }
        }
        if !progress {
            break;
        }
    }
    Ok(claimed)
}

/// Claims the oldest due message to the contact point. A first attempt beyond its organization's
/// `limit` per hour (and not owing a resolve) is given up as [`RATE_LIMITED`] right in the claim,
/// so it is never sent later, even when storing its history fails.
async fn claim_one(state: &AppState, contact_point_id: &str, now: i64, limit: u64) -> ApiResult<Option<Work>> {
    loop {
        let due: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM alert_deliveries WHERE contact_point_id = $1 AND done_at IS NULL AND attempts < $2 \
             AND next_attempt_at <= $3 AND (lease_until IS NULL OR lease_until < $3) ORDER BY next_attempt_at, id \
             LIMIT 1",
        )
        .bind(contact_point_id)
        .bind(MAX_ATTEMPTS)
        .bind(now)
        .fetch_optional(&state.db)
        .await?;
        let Some((id,)) = due else { return Ok(None) };
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
            // Another worker took it first.
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
        let (Ok(message), Ok(settings)) = (Payload::parse(&raw), serde_json::from_str::<Settings>(&settings)) else {
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
        // Only a first attempt counts towards the hour; a retry is the same message.
        let rate_limited = attempt == 1 && !owes_resolve(&message) && !state.alerting.sent.take(&org_id, limit, now);
        if rate_limited {
            sqlx::query("UPDATE alert_deliveries SET done_at = $1, result = $2, lease_until = NULL WHERE id = $3")
                .bind(now)
                .bind(RATE_LIMITED)
                .bind(&id)
                .execute(&state.db)
                .await?;
        }
        let sent_to: Vec<String> = sent_to.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let out =
            Outgoing { delivery_id: Some(id.clone()), org_id, contact_point_id, kind, settings, message, sent_to };
        return Ok(Some(Work { id, attempt, out, rate_limited }));
    }
}

/// The pause before the attempt after `attempt`: the usual one, moved later by a `Retry-After`
/// of at most [`MAX_RETRY_AFTER_SECS`].
pub fn pause_after(attempt: i64, retry_after_secs: Option<u64>) -> i64 {
    let usual = RETRY_AFTER_MS.get(usize::try_from(attempt - 1).unwrap_or(0)).copied().unwrap_or(0);
    match retry_after_secs.filter(|s| *s <= MAX_RETRY_AFTER_SECS) {
        Some(secs) => usual.max(i64::try_from(secs).unwrap_or(0) * 1000),
        None => usual,
    }
}

/// Stores how an attempt ended: done when it arrived or was the last, else due again after the
/// pause.
async fn finish(
    state: &AppState,
    id: &str,
    attempt: i64,
    out: &Outgoing,
    outcome: &Attempt,
    give_up: bool,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    let done = outcome.ok || give_up || attempt >= MAX_ATTEMPTS;
    let pause = pause_after(attempt, outcome.retry_after_secs);
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
    if held_back(&outcome.result) {
        return Ok(());
    }
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
        let mut led = false;
        loop {
            let leads = !state.cluster.coordinated() || state.cluster.is_leader();
            // What another leader counted meanwhile is not known here: start afresh.
            if leads && !led {
                state.alerting.breakers.clear();
                state.alerting.sent.clear();
            }
            led = leads;
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

#[cfg(test)]
mod pause_tests {
    use super::*;

    #[test]
    fn a_retry_after_moves_the_next_attempt_up_to_a_minute() {
        assert_eq!(pause_after(1, None), 10_000);
        assert_eq!(pause_after(2, None), 60_000);
        assert_eq!(pause_after(1, Some(12)), 12_000);
        assert_eq!(pause_after(1, Some(3)), 10_000, "never sooner than the usual pause");
        assert_eq!(pause_after(2, Some(30)), 60_000);
        assert_eq!(pause_after(1, Some(60)), 60_000);
        assert_eq!(pause_after(1, Some(61)), 10_000, "beyond a minute the usual pause");
    }
}
