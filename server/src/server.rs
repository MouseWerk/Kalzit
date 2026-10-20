//! Starts the HTTP and HTTPS listeners and shuts them down gracefully.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

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
use crate::{db, tls};

/// Time in-flight requests get to finish after a stop signal.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// A started server: the bound addresses (useful with port 0) and the listener tasks.
pub struct Running {
    pub http_addr: Option<SocketAddr>,
    pub https_addr: Option<SocketAddr>,
    handles: Vec<Handle<SocketAddr>>,
    listeners: JoinSet<Result<()>>,
}

impl Running {
    /// Stops accepting connections and gives open requests `SHUTDOWN_GRACE` to finish.
    pub fn shutdown(&self) {
        for handle in &self.handles {
            handle.graceful_shutdown(Some(SHUTDOWN_GRACE));
        }
    }

    /// Waits until every listener has stopped; the first listener error ends the wait.
    pub async fn wait(mut self) -> Result<()> {
        while let Some(result) = self.listeners.join_next().await {
            result.context("listener task")??;
        }
        Ok(())
    }
}

/// Runs the server until Ctrl+C or SIGTERM.
pub async fn run(config: Config) -> Result<()> {
    let setup_code = std::env::var("KALZIT_SETUP_TOKEN").ok().filter(|s| !s.trim().is_empty());
    let running = start(config, setup_code).await?;
    let handles = running.handles.clone();
    tokio::spawn(async move {
        wait_for_stop_signal().await;
        tracing::info!("stop signal received, finishing open requests");
        for handle in handles {
            handle.graceful_shutdown(Some(SHUTDOWN_GRACE));
        }
    });
    running.wait().await?;
    tracing::info!("stopped");
    Ok(())
}

/// Opens the database, runs migrations and binds the listeners.
pub async fn start(config: Config, setup_code: Option<String>) -> Result<Running> {
    std::fs::create_dir_all(&config.paths.data_dir)
        .with_context(|| format!("creating the data directory {}", config.paths.data_dir.display()))?;
    let pool = db::connect(&config.database_url(), config.database.max_connections).await?;
    tracing::info!("database ready ({})", db::redact(&config.database_url()));

    let state = AppState::new(config.clone(), pool, Arc::new(SystemClock), setup_code).await?;
    db::spawn_session_cleanup(state.clone());
    let app = router(state.clone());
    let mut running = Running { http_addr: None, https_addr: None, handles: Vec::new(), listeners: JoinSet::new() };

    if let Some(addr) = config.https_addr() {
        let rustls = RustlsConfig::from_config(tls::server_config(&config.tls)?);
        tls::spawn_reload(rustls.clone(), config.tls.clone());
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

/// Plain HTTP when HTTPS is on: health endpoints answer, everything else moves to HTTPS. A
/// request that a trusted proxy already received over HTTPS is served normally, otherwise a TLS
/// proxy in front of the HTTP port would loop forever.
fn redirect_router(app: Router, https_port: u16, state: AppState) -> Router {
    let public = state.config.server.public_url.clone().filter(|u| u.starts_with("https://"));
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
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

async fn wait_for_stop_signal() {
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
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
}
