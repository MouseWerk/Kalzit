//! Shared state and the HTTP routes.

use std::sync::Arc;

use anyhow::Result;
use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use sqlx::AnyPool;
use tower_http::trace::TraceLayer;

use crate::auth::ratelimit::RateLimiter;
use crate::clock::Clock;
use crate::config::Config;
use crate::datasources::DataSources;
use crate::error::ApiError;
use crate::routes::setup::SetupGate;
use crate::routes::{self, health};
use crate::secrets::Keyring;
use crate::{db, net, web};

#[derive(Clone)]
pub struct AppState {
    pub db: AnyPool,
    pub config: Arc<Config>,
    pub clock: Arc<dyn Clock>,
    pub login_limiter: Arc<RateLimiter>,
    pub setup: Arc<SetupGate>,
    pub secrets: Arc<Keyring>,
    pub datasources: Arc<DataSources>,
    /// The server's own writes outside requests (`db::Background`).
    pub background: Arc<db::Background>,
    /// Session last-seen updates in flight (`auth::session::Touches`).
    pub touches: Arc<crate::auth::session::Touches>,
}

impl AppState {
    pub async fn new(config: Config, db: AnyPool, clock: Arc<dyn Clock>, setup_code: Option<String>) -> Result<Self> {
        let setup = SetupGate::init(&db, &config.paths.data_dir, setup_code).await?;
        crate::auth::password::prewarm().await;
        let sec = &config.security;
        let login_limiter = RateLimiter::new(sec.login_max_failures, sec.login_window_secs);
        let secrets = Arc::new(Keyring::load_for_server(&config.paths.data_dir, &db).await?);
        let datasources = Arc::new(DataSources::new(&config, db.clone(), secrets.clone()));
        let touch_limit = crate::auth::session::Touches::limit_for(&db);
        // The touches, plus one for each of the two hourly jobs.
        let background = Arc::new(db::Background::new(&db, &config.database_url(), touch_limit + 2));
        let touches = Arc::new(crate::auth::session::Touches::new(background.clone(), touch_limit));
        Ok(Self {
            db,
            config: Arc::new(config),
            clock,
            login_limiter: Arc::new(login_limiter),
            setup: Arc::new(setup),
            secrets,
            datasources,
            background,
            touches,
        })
    }
}

#[expect(clippy::disallowed_methods, reason = "assembles the route tables with the unversioned health endpoints")]
pub fn router(state: AppState) -> Router {
    let api = routes::table::build(routes::all(), &state).fallback(|| async { ApiError::not_found() });

    // Layers run outside-in from the last one added: trace, request info, security headers,
    // origin check, then the route.
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .nest("/api", api)
        .fallback(web::static_files)
        // Each request gets its own "committed" flag, so errors after a commit are not "busy".
        .layer(axum::middleware::from_fn(db::scope_requests))
        .layer(from_fn_with_state(state.clone(), net::origin_check))
        .layer(from_fn_with_state(state.clone(), net::security_headers))
        .layer(from_fn_with_state(state.clone(), net::request_info))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
