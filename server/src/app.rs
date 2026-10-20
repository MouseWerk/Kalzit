//! Shared state and the HTTP routes.

use std::sync::Arc;

use anyhow::Result;
use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use sqlx::AnyPool;
use tower_http::trace::TraceLayer;

use crate::auth::ratelimit::RateLimiter;
use crate::clock::Clock;
use crate::config::Config;
use crate::error::ApiError;
use crate::routes::setup::SetupGate;
use crate::routes::{auth, health, setup};
use crate::{net, web};

#[derive(Clone)]
pub struct AppState {
    pub db: AnyPool,
    pub config: Arc<Config>,
    pub clock: Arc<dyn Clock>,
    pub login_limiter: Arc<RateLimiter>,
    pub setup: Arc<SetupGate>,
}

impl AppState {
    pub async fn new(config: Config, db: AnyPool, clock: Arc<dyn Clock>, setup_code: Option<String>) -> Result<Self> {
        let setup = SetupGate::init(&db, &config.paths.data_dir, setup_code).await?;
        let sec = &config.security;
        let login_limiter = RateLimiter::new(sec.login_max_failures, sec.login_window_secs);
        Ok(Self { db, config: Arc::new(config), clock, login_limiter: Arc::new(login_limiter), setup: Arc::new(setup) })
    }
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/setup", get(setup::status).post(setup::complete))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/me", get(auth::current))
        .fallback(|| async { ApiError::not_found() });

    // Layers run outside-in from the last one added: trace, request info, security headers,
    // origin check, then the route.
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .nest("/api", api)
        .fallback(web::static_files)
        .layer(from_fn_with_state(state.clone(), net::origin_check))
        .layer(from_fn_with_state(state.clone(), net::security_headers))
        .layer(from_fn_with_state(state.clone(), net::request_info))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
