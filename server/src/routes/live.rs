//! Live updates over a WebSocket: `GET /orgs/{orgId}/live` (docs/api/live.md).
//!
//! The handshake needs the session cookie and an `Origin` of this server (or none, as from a
//! non-browser client). A subscription is a panel's stored queries, for whoever may read the
//! dashboard, or free queries, which need `datasources:query` on each source; both are authorized
//! when subscribing and again every `Limits::recheck`, so a revoked session, membership or right
//! ends them. Results come from shared feeds (`crate::live`).

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use axum::Extension;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{Notify, mpsc, watch};
use tokio::time::Instant;

use super::query::{PanelRun, check_variables, panel_run};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::session;
use crate::authz::{Access, OrgCtx, Permission, Resource, check_resource};
use crate::datasources::{api_error_body, check_interval, check_items, check_range};
use crate::error::{ApiError, ApiResult};
use crate::live::{Feed, FeedState, Limits, MAX_REFRESH, Published, RangeRule, Slot, Spec};
use crate::net::RequestInfo;
use crate::shapes::{ErrorBody, LiveMessage, LiveSubscribe, LiveUnsubscribe};

pub fn routes() -> Vec<RouteDef> {
    // Membership by the access layer; every subscription is authorized in the handler.
    vec![route(Method::GET, "/orgs/{orgId}/live", Access::OrgMember, live)]
}

/// The largest message a client may send.
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// The longest `lastMs`: a hundred years.
const MAX_LAST_MS: u64 = 100 * 365 * 24 * 3_600_000;
const MAX_ID_CHARS: usize = 64;

/// Close codes, next to the reason in `closing` and in the close frame.
const CLOSE_GOING_AWAY: u16 = 1001;
const CLOSE_UNAUTHENTICATED: u16 = 4001;
const CLOSE_FORBIDDEN: u16 = 4003;
const CLOSE_IDLE: u16 = 4008;
const CLOSE_SLOW: u16 = 4009;
const CLOSE_TOO_MANY: u16 = 4029;

async fn live(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    info: Option<Extension<RequestInfo>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    crate::net::check_origin(&state, &headers, info.as_ref().map(|i| &i.0))?;
    let token =
        session::read_cookie(&headers, info.as_ref().is_some_and(|i| i.https)).ok_or_else(ApiError::unauthenticated)?;
    // Refusals are sent over the socket: a browser does not show a failed handshake's answer.
    let admitted = state.live.admit(&ctx.user.id);
    Ok(ws.max_message_size(MAX_MESSAGE_BYTES).on_upgrade(move |socket| async move {
        match admitted {
            Ok(slot) => Connection::new(state, token, ctx, slot).run(socket).await,
            Err(e) => {
                let code =
                    if e.code == "rate_limited" || e.reason.as_ref().is_some_and(|r| r.code == "live.server_busy") {
                        CLOSE_TOO_MANY
                    } else {
                        CLOSE_GOING_AWAY
                    };
                let (mut sink, _) = socket.split();
                let timeout = state.live.limits().send_timeout;
                close(&mut sink, code, api_error_body(e), timeout).await;
            }
        }
    }))
}

/// Why a connection ends: its close code and what the `closing` message says.
struct Close(u16, Box<ErrorBody>);

fn close_with(code: u16, e: ApiError) -> Close {
    Close(code, Box::new(api_error_body(e)))
}

fn unauthenticated() -> Close {
    close_with(CLOSE_UNAUTHENTICATED, ApiError::unauthenticated().because("live.unauthenticated"))
}

fn no_longer_member() -> Close {
    close_with(
        CLOSE_FORBIDDEN,
        ApiError::forbidden("no longer a member of this organization").because("live.forbidden"),
    )
}

type Sink = futures_util::stream::SplitSink<WebSocket, Message>;

/// Sends `closing` and the close frame; a client that does not take them in time is left.
async fn close(sink: &mut Sink, code: u16, error: ErrorBody, timeout: std::time::Duration) {
    let reason = error.reason.clone().unwrap_or_else(|| error.code.clone());
    let text = serde_json::to_string(&LiveMessage::Closing { error }).unwrap_or_default();
    let _ = tokio::time::timeout(timeout, async {
        sink.send(Message::Text(text.into())).await?;
        sink.send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from(reason) }))).await
    })
    .await;
}

/// A text message of `msg`.
fn text(msg: &LiveMessage) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_default().into())
}

/// A `result` message, from the results the feed serialized once for all its subscribers.
fn result_text(id: &str, published: &Published) -> String {
    let id = serde_json::to_string(id).unwrap_or_default();
    format!(r#"{{"type":"result","id":{id},"at":{},"results":{}}}"#, published.at, published.json)
}

/// The outgoing queue of a connection; one message too many marks the client as slow.
#[derive(Clone)]
struct Out {
    tx: mpsc::Sender<Message>,
    overflow: Arc<Notify>,
}

impl Out {
    /// Queues `msg`; false when the queue is full (the connection then closes) or gone.
    fn push(&self, msg: Message) -> bool {
        match self.tx.try_send(msg) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.overflow.notify_one();
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
}

/// Sends a feed's status and results to one subscription until the feed or the queue is gone.
async fn forward(id: String, refresh_ms: u64, mut rx: watch::Receiver<FeedState>, out: Out) {
    let mut sent_status = None;
    let mut sent_seq = 0;
    loop {
        let state = rx.borrow_and_update().clone();
        if let Some(mode) = state.mode
            && sent_status != Some((mode, state.reason))
        {
            sent_status = Some((mode, state.reason));
            let reason = state.reason.map(str::to_string);
            if !out.push(text(&LiveMessage::Status { id: id.clone(), mode, refresh_ms, reason })) {
                return;
            }
        }
        if let Some(published) = &state.results
            && published.seq != sent_seq
        {
            sent_seq = published.seq;
            if !out.push(Message::Text(result_text(&id, published).into())) {
                return;
            }
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

struct Subscription {
    request: LiveSubscribe,
    feed: Arc<Feed>,
    forward: tokio::task::AbortHandle,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.forward.abort();
    }
}

struct Connection {
    state: AppState,
    token: String,
    org_id: String,
    user_id: String,
    limits: Limits,
    subscriptions: HashMap<String, Subscription>,
    _slot: Slot,
}

/// Why the caller's context could not be built again.
enum CtxError {
    /// The session or the membership ended: the connection closes.
    Ended(Close),
    /// A database error; tried again later.
    Failed(ApiError),
}

impl Connection {
    fn new(state: AppState, token: String, ctx: OrgCtx, slot: Slot) -> Self {
        let limits = state.live.limits();
        Self {
            state,
            token,
            org_id: ctx.org_id,
            user_id: ctx.user.id,
            limits,
            subscriptions: HashMap::new(),
            _slot: slot,
        }
    }

    /// The caller as of now: the session still valid and the same user, still a member, with
    /// the current permissions.
    async fn fresh_ctx(&self) -> Result<OrgCtx, CtxError> {
        let s = &self.state;
        let now = s.clock.now_ms();
        let user = session::lookup(&s.read_db, &s.db, &s.touches, &s.config.sessions, now, &self.token)
            .await
            .map_err(CtxError::Failed)?;
        let Some(user) = user.filter(|u| u.id == self.user_id) else { return Err(CtxError::Ended(unauthenticated())) };
        match super::table::org_ctx(s, user, self.org_id.clone()).await {
            Ok(ctx) => Ok(ctx),
            Err(e) if e.code == "not_found" => Err(CtxError::Ended(no_longer_member())),
            Err(e) => Err(CtxError::Failed(e)),
        }
    }

    async fn run(mut self, socket: WebSocket) {
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::channel(self.limits.queue);
        let out = Out { tx, overflow: Arc::new(Notify::new()) };
        let mut stop = self.state.live.stopping();
        let start = Instant::now();
        let mut ping = tokio::time::interval_at(start + self.limits.ping, self.limits.ping);
        let mut recheck = tokio::time::interval_at(start + self.limits.recheck, self.limits.recheck);
        // A slow check or send is not made up for with a burst of ticks.
        ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        recheck.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut heard = start;
        let mut idle_since = Some(start);
        let ended = loop {
            let idle_at = idle_since.map(|t| t + self.limits.idle);
            tokio::select! {
                biased;
                () = stopped(&mut stop) => {
                    break Some(close_with(CLOSE_GOING_AWAY, crate::live::shutting_down()));
                }
                () = out.overflow.notified() => {
                    let e = ApiError::busy().because("live.slow_client");
                    break Some(close_with(CLOSE_SLOW, e));
                }
                Some(msg) = rx.recv() => {
                    match tokio::time::timeout(self.limits.send_timeout, sink.send(msg)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(_)) => break None,
                        Err(_) => break Some(close_with(CLOSE_SLOW, ApiError::busy().because("live.slow_client"))),
                    }
                }
                incoming = stream.next() => {
                    let msg = match incoming {
                        Some(Ok(msg)) => msg,
                        Some(Err(_)) | None => break None,
                    };
                    heard = Instant::now();
                    match msg {
                        Message::Text(t) => {
                            if let Some(close) = self.handle(t.as_str(), &out).await {
                                break Some(close);
                            }
                        }
                        Message::Binary(_) => {
                            out.push(text(&LiveMessage::Error { id: None, error: invalid("send text messages") }));
                        }
                        Message::Close(_) => break None,
                        Message::Ping(_) | Message::Pong(_) => {}
                    }
                }
                _ = ping.tick() => {
                    if heard.elapsed() > self.limits.silence {
                        break Some(close_with(CLOSE_IDLE, ApiError::busy().because("live.idle_timeout")));
                    }
                    let sent = tokio::time::timeout(self.limits.send_timeout, sink.send(Message::Ping(Default::default())));
                    if !matches!(sent.await, Ok(Ok(()))) {
                        break None;
                    }
                }
                _ = recheck.tick() => {
                    if let Some(close) = self.recheck(&out).await {
                        break Some(close);
                    }
                }
                () = sleep_until(idle_at) => {
                    break Some(close_with(CLOSE_IDLE, ApiError::busy().because("live.idle_timeout")));
                }
            }
            idle_since = if self.subscriptions.is_empty() { idle_since.or(Some(Instant::now())) } else { None };
        };
        // The feeds of this connection stop unless others use them.
        self.subscriptions.clear();
        if let Some(Close(code, error)) = ended {
            close(&mut sink, code, *error, self.limits.send_timeout).await;
        }
    }

    /// One client message. `Some` closes the connection.
    async fn handle(&mut self, raw: &str, out: &Out) -> Option<Close> {
        let value: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(e) => {
                out.push(text(&LiveMessage::Error { id: None, error: invalid(&e.to_string()) }));
                return None;
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("subscribe") => match serde_json::from_value::<LiveSubscribe>(value) {
                Ok(sub) => self.subscribe(sub, out).await,
                Err(e) => {
                    out.push(text(&LiveMessage::Error { id: message_id(raw), error: invalid(&e.to_string()) }));
                    None
                }
            },
            Some("unsubscribe") => {
                match serde_json::from_value::<LiveUnsubscribe>(value) {
                    Ok(un) => {
                        self.subscriptions.remove(&un.id);
                    }
                    Err(e) => {
                        out.push(text(&LiveMessage::Error { id: message_id(raw), error: invalid(&e.to_string()) }));
                    }
                }
                None
            }
            _ => {
                out.push(text(&LiveMessage::Error {
                    id: None,
                    error: invalid("type must be subscribe or unsubscribe"),
                }));
                None
            }
        }
    }

    async fn subscribe(&mut self, request: LiveSubscribe, out: &Out) -> Option<Close> {
        let id = request.id.clone();
        let refuse = |error: ErrorBody| {
            out.push(text(&LiveMessage::Error { id: Some(id.clone()), error }));
            None
        };
        if self.subscriptions.contains_key(&id) {
            return refuse(api_error_body(
                ApiError::validation(format!("a subscription {id:?} exists already")).because("live.duplicate_id"),
            ));
        }
        let max = self.limits.subscriptions_per_connection;
        if self.subscriptions.len() >= max {
            return refuse(api_error_body(
                ApiError::validation(format!("at most {max} subscriptions per connection"))
                    .because("live.too_many_subscriptions")
                    .param("max", max),
            ));
        }
        let ctx = match self.fresh_ctx().await {
            Ok(ctx) => ctx,
            Err(CtxError::Ended(close)) => return Some(close),
            Err(CtxError::Failed(e)) => return refuse(api_error_body(e)),
        };
        let spec = match resolve(&self.state, &ctx, &request, &self.limits).await {
            Ok(spec) => spec,
            Err(e) => return refuse(api_error_body(e)),
        };
        let subscription = self.start(&ctx, request, spec, out);
        self.subscriptions.insert(id, subscription);
        None
    }

    fn start(&self, ctx: &OrgCtx, request: LiveSubscribe, spec: Spec, out: &Out) -> Subscription {
        let feed = self.state.live.feed(&self.state, ctx, spec);
        let task = tokio::spawn(forward(request.id.clone(), feed.refresh_ms, feed.subscribe(), out.clone()));
        Subscription { request, feed, forward: task.abort_handle() }
    }

    /// Checks the session, the membership and every subscription again. A subscription the
    /// caller may no longer run ends with `live.forbidden`; one whose queries changed (the
    /// dashboard was edited) moves to the new queries.
    async fn recheck(&mut self, out: &Out) -> Option<Close> {
        let ctx = match self.fresh_ctx().await {
            Ok(ctx) => ctx,
            Err(CtxError::Ended(close)) => return Some(close),
            Err(CtxError::Failed(e)) => {
                tracing::debug!("live: access not checked again: {}", e.message);
                return None;
            }
        };
        let ids: Vec<String> = self.subscriptions.keys().cloned().collect();
        for id in ids {
            let Some(sub) = self.subscriptions.get(&id) else { continue };
            match resolve(&self.state, &ctx, &sub.request, &self.limits).await {
                Ok(spec) if spec.key() == sub.feed.key => {}
                Ok(spec) => {
                    let request = sub.request.clone();
                    let moved = self.start(&ctx, request, spec, out);
                    self.subscriptions.insert(id, moved);
                }
                // Busy or failing database: the next check decides.
                Err(e) if matches!(e.code, "busy" | "internal") => {}
                Err(e) => {
                    self.subscriptions.remove(&id);
                    let mut error = api_error_body(e);
                    error.reason = Some("live.forbidden".into());
                    error.params = None;
                    out.push(text(&LiveMessage::Error { id: Some(id), error }));
                }
            }
        }
        None
    }
}

/// Resolves once the server stops.
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopping| *stopping).await;
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// The `id` of a message that did not parse as a whole, so the error can name it.
fn message_id(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value.get("id").and_then(Value::as_str).map(str::to_string)
}

fn invalid(detail: &str) -> ErrorBody {
    api_error_body(invalid_error(detail))
}

fn invalid_error(detail: &str) -> ApiError {
    ApiError::validation(format!("the message is not valid: {detail}"))
        .because("live.invalid_message")
        .param("detail", detail)
}

/// The spec of a subscription, authorized for `ctx`: a panel's stored queries of a dashboard the
/// caller may read, or free queries on sources the caller may query.
async fn resolve(state: &AppState, ctx: &OrgCtx, sub: &LiveSubscribe, limits: &Limits) -> ApiResult<Spec> {
    if sub.id.is_empty() || sub.id.chars().count() > MAX_ID_CHARS {
        return Err(invalid_error("id needs 1 to 64 characters"));
    }
    let range = match (sub.time_range, sub.last_ms) {
        (Some(range), None) => RangeRule::Fixed(range),
        (None, Some(ms)) if (1..=MAX_LAST_MS).contains(&ms) => RangeRule::Last(ms),
        (None, Some(_)) => return Err(invalid_error("lastMs must be 1 ms to 100 years")),
        _ => return Err(invalid_error("give either timeRange or lastMs")),
    };
    check_range(range.at(state.clock.now_ms()))?;
    check_interval(sub.interval_ms)?;
    let min = limits.min_refresh.as_millis() as u64;
    let refresh_ms = sub.refresh_ms.unwrap_or(limits.default_refresh.as_millis() as u64);
    let refresh_ms = refresh_ms.clamp(min, (MAX_REFRESH.as_millis() as u64).max(min));
    let (items, variables, identifiers) = match (&sub.panel, &sub.queries) {
        (Some(panel), None) => {
            let none = BTreeMap::new();
            let PanelRun { items, variables, identifiers } = panel_run(
                state,
                ctx,
                &panel.dashboard_id,
                &panel.panel_id,
                &sub.variables,
                sub.limit,
                &none,
                || Ok(()),
            )
            .await?;
            if !items.is_empty() {
                check_items(&items)?;
            }
            (items, variables, Some(identifiers))
        }
        (None, Some(items)) => {
            check_items(items)?;
            check_variables(&sub.variables)?;
            if sub.limit.is_some() {
                return Err(invalid_error("free queries carry their own limit"));
            }
            if items.iter().any(|i| i.cursor.is_some()) {
                return Err(invalid_error("live results start at the first page; drop cursor"));
            }
            let mut checked = std::collections::BTreeSet::new();
            for item in items {
                if checked.insert(item.datasource_id.as_str()) {
                    let resource = Resource::Datasource(&item.datasource_id);
                    check_resource(&state.db, ctx, Permission::DatasourcesQuery, resource).await?;
                }
            }
            (items.clone(), sub.variables.clone(), None)
        }
        _ => return Err(invalid_error("give either panel or queries")),
    };
    Ok(Spec {
        org_id: ctx.org_id.clone(),
        items,
        range,
        interval_ms: sub.interval_ms,
        max_data_points: sub.max_data_points,
        variables,
        identifiers,
        refresh_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::QueryOutcome;

    #[test]
    fn result_messages_match_their_type() {
        let published =
            Published { seq: 1, at: 42, json: r#"{"A":{"error":{"code":"internal","message":"x"}}}"#.into() };
        let raw = result_text("p\"1", &published);
        let parsed: LiveMessage = serde_json::from_str(&raw).unwrap();
        let LiveMessage::Result { id, at, results } = &parsed else { panic!("{raw}") };
        assert_eq!((id.as_str(), *at), ("p\"1", 42));
        assert!(matches!(results.get("A"), Some(QueryOutcome::Err { .. })));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), serde_json::from_str::<Value>(&raw).unwrap());
    }
}
