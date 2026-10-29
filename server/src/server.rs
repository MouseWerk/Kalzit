//! Starts the HTTP and HTTPS listeners and shuts them down gracefully.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::extract::Request;
use axum::http::{StatusCode, Uri, header};
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::{Extension, Router};
use axum_server::Handle;
use axum_server::tls_rustls::RustlsConfig;
use tokio::task::JoinSet;
use tower::ServiceExt;

use crate::app::{AppState, router};
use crate::clock::SystemClock;
use crate::config::Config;
use crate::net::{self, ListenerTls, RequestInfo};
use crate::routes::health;
use crate::updates::Handover;
use crate::updates::boot::Trial;
use crate::{db, tls};

/// Time in-flight requests get to finish after a stop signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
/// After a console close or shutdown event Windows ends the process within about five seconds;
/// open requests get less, so the database is closed before that.
#[cfg(windows)]
const WINDOWS_CLOSE_GRACE: Duration = Duration::from_secs(3);
/// How long closing the database may take at a stop, the background writes' own stop included.
/// Normally it is quick; it waits longer for a background write that waits for a lock, which on
/// a loaded machine takes well over its busy timeout, and only a lock another program holds for
/// longer runs it out.
pub const CLOSE_WAIT: Duration = Duration::from_secs(5);

/// A stop asked for from outside the server (the Windows service's control handler), with the
/// grace open requests get and whether the process ends when it is over.
static STOP: tokio::sync::Notify = tokio::sync::Notify::const_new();
static STOP_GRACE: std::sync::Mutex<Option<(Duration, bool)>> = std::sync::Mutex::new(None);

/// Stops the running server the way a stop signal does. A system shutdown leaves little time, so
/// `shutdown` gives open requests the short grace and keeps the database close within it.
/// Called before the server listens, the stop waits and applies as soon as it does.
pub fn request_stop(shutdown: bool) {
    #[cfg(windows)]
    let grace = if shutdown { (WINDOWS_CLOSE_GRACE, true) } else { (SHUTDOWN_GRACE, false) };
    #[cfg(not(windows))]
    let grace = (SHUTDOWN_GRACE, shutdown);
    *STOP_GRACE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(grace);
    STOP.notify_one();
}

/// Called once the listeners are bound (the Windows service reports itself running then).
static ON_STARTED: std::sync::OnceLock<Box<dyn Fn() + Send + Sync>> = std::sync::OnceLock::new();

/// Sets what runs once the server listens; only the first call counts.
pub fn on_started(f: impl Fn() + Send + Sync + 'static) {
    let _ = ON_STARTED.set(Box::new(f));
}

/// How a stop went.
#[derive(Debug)]
pub struct Stopped {
    /// The database closed within its budget, so SQLite checkpointed its WAL.
    pub closed_in_time: bool,
}

/// A started server: the bound addresses (useful with port 0) and the listener tasks.
pub struct Running {
    pub http_addr: Option<SocketAddr>,
    pub https_addr: Option<SocketAddr>,
    handles: Vec<Handle<SocketAddr>>,
    listeners: JoinSet<Result<()>>,
    state: AppState,
    /// When the process ends regardless of the stop (Windows console close and shutdown).
    hard_deadline: Arc<std::sync::Mutex<Option<Instant>>>,
}

impl Running {
    /// Stops accepting connections and gives open requests `SHUTDOWN_GRACE` to finish.
    pub fn shutdown(&self) {
        self.state.live.begin_shutdown();
        for handle in &self.handles {
            handle.graceful_shutdown(Some(SHUTDOWN_GRACE));
        }
    }

    /// Waits until every listener has stopped, then closes the state (`AppState::close`: the
    /// background writes, the data sources' pools and the database); the first listener error
    /// ends the wait. Closing lets SQLite checkpoint its WAL
    /// into the database file, so a copy of `kalzit.db` taken while the server is stopped is
    /// complete on its own. The close gets `CLOSE_WAIT`, less when the process ends sooner; past
    /// that the stop goes on without it.
    pub async fn wait(mut self) -> Result<Stopped> {
        let mut outcome = Ok(());
        while let Some(result) = self.listeners.join_next().await {
            if let Err(e) = result.context("listener task").and_then(|r| r) {
                outcome = Err(e);
                break;
            }
        }
        let deadline = *self.hard_deadline.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let budget = close_budget(deadline, Instant::now());
        let closed_in_time = tokio::time::timeout(budget, self.state.close()).await.is_ok();
        if !closed_in_time {
            tracing::warn!(
                "the database did not close within {budget:?}; a statement still waits for a lock another \
                 program holds. Nothing committed is lost; the next start completes the WAL checkpoint"
            );
        }
        outcome.map(|()| Stopped { closed_in_time })
    }

    /// Database connections in use right now, the background pool's included (tests: with no
    /// request open, these are background writes running or waiting for the lock).
    #[doc(hidden)]
    pub fn connections_in_use(&self) -> u32 {
        let db = &self.state.db;
        let main = db.size().saturating_sub(db.num_idle() as u32);
        main + self.state.background.connections_in_use()
    }
}

/// `CLOSE_WAIT`, or what is left until `hard_deadline` when that comes first.
fn close_budget(hard_deadline: Option<Instant>, now: Instant) -> Duration {
    match hard_deadline {
        Some(deadline) => deadline.saturating_duration_since(now).min(CLOSE_WAIT),
        None => CLOSE_WAIT,
    }
}

/// How a run ended.
#[derive(Debug)]
pub enum Outcome {
    /// A stop signal: the process ends.
    Stopped,
    /// An update or a return: once everything is closed, `updates::boot::handover` starts the
    /// next binary.
    Handover(Handover),
}

/// Runs the server until Ctrl+C or SIGTERM, or until an update hands over to another binary.
/// `trial` is the first start of a new version (`updates::boot`): it confirms once the server
/// is healthy, and hands back for a return when it is not.
pub async fn run(config: Config, trial: Option<Trial>) -> Result<Outcome> {
    // A mistyped or invalid KALZIT_SETTING_* variable stops the start instead of being ignored.
    // Names and values that are not UTF-8 cannot be settings; `Config::load` refuses such
    // KALZIT_* variables already.
    let vars = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
    crate::settings::check_environment(vars).map_err(anyhow::Error::msg)?;
    let setup_code = std::env::var("KALZIT_SETUP_TOKEN").ok().filter(|s| !s.trim().is_empty());
    let running = match start(config, setup_code).await {
        Ok(running) => running,
        Err(e) => {
            // A new version that cannot start (a failed migration) returns to the previous one.
            if let Some(handover) = trial.as_ref().and_then(|t| t.fail(&format!("the start failed: {e:#}"))) {
                tracing::error!("{e:#}");
                return Ok(Outcome::Handover(handover));
            }
            return Err(e);
        }
    };
    if let Some(started) = ON_STARTED.get() {
        started();
    }
    let handles = running.handles.clone();
    let hard_deadline = running.hard_deadline.clone();
    let live = running.state.live.clone();
    tokio::spawn(async move {
        let (grace, hard) = wait_for_stop_signal().await;
        tracing::info!("stop signal received, finishing open requests");
        live.begin_shutdown();
        if hard {
            *hard_deadline.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Instant::now() + grace);
        }
        for handle in handles {
            handle.graceful_shutdown(Some(grace));
        }
    });
    let state = running.state.clone();
    let updates = state.updates.clone();
    let handles = running.handles.clone();
    let waiting = updates.clone();
    let live = state.live.clone();
    tokio::spawn(async move {
        waiting.handover_requested().await;
        tracing::info!("stopping to hand over to another version");
        live.begin_shutdown();
        for handle in handles {
            handle.graceful_shutdown(Some(SHUTDOWN_GRACE));
        }
    });
    updates.record_outcome(&state).await;
    crate::updates::spawn_background(state.clone());
    crate::plugins::catalog::spawn_background(state.clone());
    if let Some(trial) = trial {
        // PostgreSQL: once the migrations of the new version ran, the previous binary cannot
        // start on the schema; the plan says so before anything else can fail.
        if let Ok(schema) = crate::updates::install::schema_version(&state.db).await {
            trial.note_schema(schema);
        }
        let addrs: Vec<SocketAddr> = running.http_addr.into_iter().chain(running.https_addr).collect();
        tokio::spawn(async move {
            match healthy_before(&state, &addrs, trial.deadline()).await {
                Ok(()) => {
                    if let Err(e) = trial.confirm(&state).await {
                        tracing::warn!("confirming the update: {e}");
                    }
                }
                Err(reason) => {
                    if let Some(handover) = trial.fail(&reason) {
                        state.updates.request_handover(handover);
                    }
                }
            }
        });
    }
    running.wait().await?;
    tracing::info!("stopped");
    Ok(match updates.take_handover() {
        Some(handover) => Outcome::Handover(handover),
        None => Outcome::Stopped,
    })
}

/// Waits until the server is healthy: `/readyz` answers through the real router and every
/// listener accepts connections. Gives up shortly before `deadline`, leaving the watchdog
/// room.
async fn healthy_before(state: &AppState, addrs: &[SocketAddr], deadline: Instant) -> Result<(), String> {
    let give_up = deadline.checked_sub(Duration::from_secs(2)).unwrap_or(deadline);
    let mut last;
    loop {
        match check_health(state, addrs).await {
            Ok(()) => return Ok(()),
            Err(e) => last = e,
        }
        if Instant::now() + Duration::from_millis(500) >= give_up {
            return Err(format!("not healthy in time: {last}"));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn check_health(state: &AppState, addrs: &[SocketAddr]) -> Result<(), String> {
    let request = Request::builder().uri("/readyz").body(axum::body::Body::empty()).map_err(|e| e.to_string())?;
    let Ok(response) = router(state.clone()).oneshot(request).await;
    if response.status() != StatusCode::OK {
        return Err(format!("/readyz answered {}", response.status()));
    }
    for addr in addrs {
        // A wildcard address is reached through the loopback interface.
        let target = match addr.ip() {
            ip if ip.is_unspecified() && ip.is_ipv4() => SocketAddr::from(([127, 0, 0, 1], addr.port())),
            ip if ip.is_unspecified() => SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, addr.port())),
            _ => *addr,
        };
        tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(target))
            .await
            .map_err(|_| format!("{target} did not accept a connection in time"))?
            .map_err(|e| format!("{target} refused a connection: {e}"))?;
    }
    Ok(())
}

/// Opens the database, runs migrations and binds the listeners.
pub async fn start(config: Config, setup_code: Option<String>) -> Result<Running> {
    for warning in &config.warnings {
        tracing::warn!("{warning}");
    }
    crate::data_dir::prepare(&config.paths.data_dir)?;
    if let Some(warning) = db::ambiguity(&config.database_url()) {
        tracing::warn!("{warning}");
    }
    let pool = db::connect(&config.database_url(), config.database.max_connections).await?;
    tracing::info!(
        "data directory {}, database {} ready",
        config.paths.data_dir.display(),
        db::redact(&config.database_url())
    );

    // A start that fails from here on closes its pools and stops its background jobs: on Windows
    // the data directory's files stay locked while a pool is open. The `secrets.lock` the
    // keyring holds is released only once the last clone of the state is gone, which the stopped
    // jobs no longer keep.
    let state = match AppState::new(config.clone(), pool.clone(), Arc::new(SystemClock), setup_code).await {
        Ok(state) => state,
        Err(e) => {
            pool.close().await;
            return Err(e);
        }
    };
    db::spawn_session_cleanup(state.clone());
    crate::routes::audit::spawn_retention(state.clone());
    crate::routes::explore_history::spawn_retention(state.clone());
    crate::routes::datasources::spawn_trash_purge(state.clone());
    crate::ai::chats::spawn_retention(state.clone());
    match listen(&config, &state).await {
        Ok(running) => {
            // Orders and renews certificates once the listeners can answer the challenges.
            crate::acme::spawn(state.clone());
            Ok(running)
        }
        Err(e) => {
            state.close().await;
            Err(e)
        }
    }
}

/// Binds the listeners of a started server; on an error the ones already bound are dropped.
async fn listen(config: &Config, state: &AppState) -> Result<Running> {
    let app = router(state.clone());
    let mut running = Running {
        http_addr: None,
        https_addr: None,
        handles: Vec::new(),
        listeners: JoinSet::new(),
        state: state.clone(),
        hard_deadline: Arc::default(),
    };

    if let Some(addr) = config.https_addr() {
        let rustls = if config.tls.cert_file.is_some() {
            let rustls = RustlsConfig::from_config(tls::server_config(&config.tls)?);
            tls::spawn_reload(rustls.clone(), config.tls.clone());
            rustls
        } else {
            // Fail closed: without certificate files, HTTPS starts only when ACME is meant to
            // provide the certificate, never as a permanent self-signed fallback.
            if !state.acme.settings().0.enabled {
                anyhow::bail!(
                    "server.https_addr is set, so tls.cert_file and tls.key_file are required unless ACME is on. \
                     Turn ACME on in Settings, Network (HTTP-01 works before HTTPS is on), or set the files"
                );
            }
            if !state.acme.certificates.has_certificate() {
                tracing::warn!(
                    "HTTPS serves a temporary self-signed certificate until ACME has issued one (Settings, \
                     Network)"
                );
            }
            RustlsConfig::from_config(tls::acme_server_config(&config.tls, state.acme.certificates.clone())?)
        };
        let service =
            app.clone().layer(Extension(ListenerTls(true))).into_make_service_with_connect_info::<SocketAddr>();
        let handle = Handle::new();
        let server = axum_server::bind_rustls(addr, rustls).handle(handle.clone());
        running.listeners.spawn(async move { server.serve(service).await.with_context(|| format!("HTTPS on {addr}")) });
        let bound = listening(&mut running, &handle).await?;
        tracing::info!("listening on https://{bound}");
        running.https_addr = Some(bound);
        running.handles.push(handle);
    }
    if let Some(addr) = config.http_addr() {
        let http_app = match running.https_addr {
            Some(https) if config.server.redirect_http_to_https => {
                redirect_router(app.clone(), https.port(), state.clone())
            }
            _ => app.clone(),
        };
        let service = http_app.layer(Extension(ListenerTls(false))).into_make_service_with_connect_info::<SocketAddr>();
        let handle = Handle::new();
        let server = axum_server::bind(addr).handle(handle.clone());
        running.listeners.spawn(async move { server.serve(service).await.with_context(|| format!("HTTP on {addr}")) });
        let bound = listening(&mut running, &handle).await?;
        tracing::info!("listening on http://{bound}");
        running.http_addr = Some(bound);
        running.handles.push(handle);
    }
    Ok(running)
}

/// The bound address, or the listener's error when binding failed (port in use, no permission).
async fn listening(running: &mut Running, handle: &Handle<SocketAddr>) -> Result<SocketAddr> {
    if let Some(addr) = handle.listening().await {
        return Ok(addr);
    }
    match running.listeners.join_next().await {
        Some(Ok(Err(e))) => Err(e),
        Some(Err(e)) => Err(e).context("listener task"),
        _ => anyhow::bail!("listener stopped before it was ready"),
    }
}

/// Plain HTTP when HTTPS is on: health endpoints and ACME validations answer, everything else
/// moves to HTTPS. A
/// request that a trusted proxy already received over HTTPS is served normally, otherwise a TLS
/// proxy in front of the HTTP port would loop forever.
#[expect(clippy::disallowed_methods, reason = "the HTTP redirect listener has only the health endpoints")]
fn redirect_router(app: Router, https_port: u16, state: AppState) -> Router {
    let public = state.config.server.public_url.clone().filter(|u| u.starts_with("https://"));
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        // HTTP-01 validations are answered here, not redirected.
        .route(crate::acme::CHALLENGE_ROUTE, get(crate::acme::http_challenge))
        .fallback(move |Extension(info): Extension<RequestInfo>, req: Request| {
            let app = app.clone();
            let public = public.clone();
            async move {
                if info.https {
                    return app.oneshot(req).await.unwrap_or_else(|never| match never {});
                }
                redirect_to_https(&req, https_port, public.as_deref())
            }
        })
        .layer(from_fn_with_state(state.clone(), net::request_info))
        .with_state(state)
}

/// The target is `public_url` when it is an HTTPS URL (correct behind port mappings such as
/// Docker `-p 443:3443`), otherwise the requested host on the HTTPS listener's port.
fn redirect_to_https(req: &Request, https_port: u16, public_url: Option<&str>) -> Response {
    let path = req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let target = match public_url {
        Some(public) => format!("{}{path}", public.trim_end_matches('/')),
        None => {
            let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok());
            let Some((hostname, _)) = host.and_then(net::split_host_port) else {
                return (StatusCode::BAD_REQUEST, "missing or invalid Host header").into_response();
            };
            match https_port {
                443 => format!("https://{hostname}{path}"),
                port => format!("https://{hostname}:{port}{path}"),
            }
        }
    };
    match target.parse::<Uri>() {
        Ok(uri) => Redirect::permanent(&uri.to_string()).into_response(),
        Err(_) => (StatusCode::BAD_REQUEST, "invalid request target").into_response(),
    }
}

/// Waits for a request to stop and answers how long open requests get to finish, and whether the
/// process ends when that grace is over (Windows console close and shutdown).
async fn wait_for_stop_signal() -> (Duration, bool) {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("cannot listen for Ctrl+C: {e}");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::warn!("cannot listen for SIGTERM: {e}");
                std::future::pending::<()>().await;
            }
        }
        (SHUTDOWN_GRACE, false)
    };
    // Closing the console window and shutting Windows down also stop the server gracefully, so the
    // database is closed and its WAL checkpointed. Windows ends the process a few seconds after
    // these events, so open requests get a short grace and the database is closed in time. Not
    // signing off: behind a service wrapper, any user signing off would stop the server. As the
    // Windows service, the service control handler stops it through `request_stop`.
    #[cfg(windows)]
    let terminate = async {
        use tokio::signal::windows::{ctrl_close, ctrl_shutdown};
        match (ctrl_close(), ctrl_shutdown()) {
            (Ok(mut close), Ok(mut shutdown)) => {
                tokio::select! {
                    _ = close.recv() => {}
                    _ = shutdown.recv() => {}
                }
            }
            (close, shutdown) => {
                let failed = [close.err(), shutdown.err()].into_iter().flatten().next();
                tracing::warn!("cannot listen for console close and shutdown: {failed:?}");
                std::future::pending::<()>().await;
            }
        }
        (WINDOWS_CLOSE_GRACE, true)
    };
    #[cfg(not(any(unix, windows)))]
    let terminate = std::future::pending::<(Duration, bool)>();
    let requested = async {
        STOP.notified().await;
        STOP_GRACE.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take().unwrap_or((SHUTDOWN_GRACE, false))
    };
    tokio::select! {
        () = ctrl_c => (SHUTDOWN_GRACE, false),
        stop = terminate => stop,
        stop = requested => stop,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_close_gets_its_wait_or_what_is_left_before_a_hard_end() {
        let now = Instant::now();
        assert_eq!(close_budget(None, now), CLOSE_WAIT);
        assert_eq!(close_budget(Some(now + Duration::from_secs(10)), now), CLOSE_WAIT);
        assert_eq!(close_budget(Some(now + Duration::from_millis(500)), now), Duration::from_millis(500));
        assert_eq!(close_budget(Some(now), now + Duration::from_secs(1)), Duration::ZERO);
    }
}
