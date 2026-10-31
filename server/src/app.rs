//! Shared state and the HTTP routes.

use std::sync::Arc;

use anyhow::Result;
use axum::Router;
use axum::middleware::from_fn_with_state;
use axum::routing::get;
use sqlx::AnyPool;
use tower_http::trace::TraceLayer;

use crate::auth::ratelimit::{Capacity, RateLimiter};
use crate::clock::Clock;
use crate::config::Config;
use crate::datasources::DataSources;
use crate::error::ApiError;
use crate::routes::setup::SetupGate;
use crate::routes::{self, health};
use crate::secrets::Keyring;
use crate::{db, net, web};

/// The failed sign-ins one IPv6 /48 may collect for all accounts together, as a multiple of
/// `security.login_max_failures` (the budget of one address).
pub const NETWORK_FAILURES_FACTOR: u32 = 5;

#[derive(Clone)]
pub struct AppState {
    pub db: AnyPool,
    /// Read-only connections for the reads of every request: session and permission lookups
    /// (`db::read_pool`). The same pool as `db` on PostgreSQL and for an in-memory database.
    pub read_db: AnyPool,
    pub config: Arc<Config>,
    pub clock: Arc<dyn Clock>,
    /// Sign-in attempts per client address (`routes::auth`). Each class of keys has its own
    /// table, so a flood of one never crowds out another.
    pub login_limiter: Arc<RateLimiter>,
    /// Sign-in attempts per account at one client address.
    pub pair_limiter: Arc<RateLimiter>,
    /// Failed sign-ins per IPv6 /48 for all accounts together (`NETWORK_FAILURES_FACTOR`); used
    /// up, it refuses attempts whose account at that address is not clean
    /// (`ratelimit::CLEAN_ADDRESS_FAILURES`).
    pub network_limiter: Arc<RateLimiter>,
    /// Failed sign-ins and password checks per existing account from all addresses together.
    /// Used up, it refuses every sign-in of the account without a known device (`auth::device`).
    /// Without a cap and never dropped before its window ends (bounded by the number of users).
    pub account_limiter: Arc<RateLimiter>,
    /// The same budget for emails without an account, so a refusal looks the same for both; a
    /// bounded table, since anyone can make up emails.
    pub unknown_account_limiter: Arc<RateLimiter>,
    /// The same budget for such emails while that table is full, in a fixed set of buckets
    /// (`routes::auth::overflow_bucket`).
    pub overflow_limiter: Arc<RateLimiter>,
    /// Successful sign-ins of known devices per account (`ratelimit::MAX_SIGN_INS`).
    pub sign_in_account_limiter: Arc<RateLimiter>,
    /// Successful sign-ins of known devices per client address.
    pub sign_in_address_limiter: Arc<RateLimiter>,
    /// Checks of the current password per user (`POST /me/password`).
    pub password_limiter: Arc<RateLimiter>,
    /// Refused API tokens per client address (`auth::api_token`), with the budget of sign-ins.
    pub token_limiter: Arc<RateLimiter>,
    /// Refused API tokens of addresses past that budget, for their audit entries.
    pub limited_refusals: Arc<crate::auth::api_token::LimitedRefusals>,
    /// Password checks in flight per account (sign-ins and `POST /me/password`).
    pub password_checks: Arc<crate::auth::ratelimit::InFlight>,
    /// Setup code attempts per client address (`routes::setup`).
    pub setup_limiter: Arc<RateLimiter>,
    /// Wrong setup codes from all addresses together (`security.setup_*`).
    pub setup_all_limiter: Arc<RateLimiter>,
    /// Connection tests of unsaved data source settings (`routes::datasources`).
    pub probe_limiter: Arc<RateLimiter>,
    pub setup: Arc<SetupGate>,
    pub secrets: Arc<Keyring>,
    pub datasources: Arc<DataSources>,
    /// The server's own writes outside requests (`db::Background`).
    pub background: Arc<db::Background>,
    /// Session last-seen updates in flight (`auth::session::Touches`).
    pub touches: Arc<crate::auth::session::Touches>,
    /// Exports making their file at the same time (`routes::export::MAX_EXPORTS`).
    pub exports: Arc<tokio::sync::Semaphore>,
    /// Users with an export running (making or sending its file): one each.
    pub export_users: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// The bounds of exports; tests make them small.
    pub export_limits: Arc<std::sync::RwLock<crate::routes::export::Limits>>,
    /// The plugin catalog: its index and installs from it (`plugins::catalog`).
    pub catalog: Arc<crate::plugins::catalog::Catalog>,
    /// Checks, downloads and installations of new versions (`updates`).
    pub updates: Arc<crate::updates::Updates>,
    /// Live update connections and their feeds (`live`).
    pub live: Arc<crate::live::Live>,
    /// AI calls running now (`ai::service`).
    pub ai: Arc<crate::ai::service::AiRuntime>,
    /// Installed plugins and their processes (`plugins::host`).
    pub plugins: Arc<crate::plugins::host::PluginHost>,
    /// Automatic HTTPS certificates (`acme`): their settings, the served certificate and the
    /// challenge answers.
    pub acme: Arc<crate::acme::Acme>,
    /// Mail: the rate limits of password resets and links, and connections to the mail server
    /// (`mail`).
    pub mail: Arc<crate::mail::Mail>,
    /// This server among the servers on the same database: leader, run-once jobs and the
    /// changes they announce to each other (`cluster`).
    pub cluster: Arc<crate::cluster::Cluster>,
    /// Usage counts waiting to be written (`usage`).
    pub usage: Arc<crate::usage::Usage>,
    /// Single sign-on: what is kept of identity providers and the limits of its routes (`sso`).
    pub sso: Arc<crate::sso::Sso>,
}

impl AppState {
    pub async fn new(config: Config, db: AnyPool, clock: Arc<dyn Clock>, setup_code: Option<String>) -> Result<Self> {
        // Files left by exports a stop or a crash cut short; nothing runs yet that could own one.
        crate::routes::export::clear_spool(&config.paths.data_dir);
        let setup = SetupGate::init(&db, &config.paths.data_dir, setup_code).await?;
        crate::auth::password::prewarm().await;
        let sec = &config.security;
        let (max_failures, window_secs) = (sec.login_max_failures, sec.login_window_secs);
        let login = move |capacity| RateLimiter::new(max_failures, window_secs, capacity);
        let network_limiter = RateLimiter::new(
            sec.login_max_failures.saturating_mul(NETWORK_FAILURES_FACTOR),
            sec.login_window_secs,
            Capacity::LARGE,
        );
        // Setup codes per client address count like sign-ins; wrong codes from all addresses
        // together have a budget of their own, which slows a guess spread over many addresses.
        let setup_limiter = login(Capacity::SMALL);
        let setup_all_limiter = RateLimiter::new(sec.setup_max_failures, sec.setup_window_secs, Capacity::SMALL);
        let secrets = Arc::new(Keyring::load_for_server(&config.paths.data_dir, &db).await?);
        // The node id, and the moment before anything shared is loaded: with several servers on one
        // database, what changes from now on is replayed and compared (`cluster::boot`).
        let cluster = Arc::new(crate::cluster::Cluster::new());
        crate::cluster::boot(&cluster, &db, &config.database_url(), &config.paths.data_dir).await?;
        let acme = Arc::new(crate::acme::Acme::load(&config, &secrets, &db).await?);
        let datasources = Arc::new(DataSources::new(&config, db.clone(), secrets.clone()));
        let plugins = Arc::new(
            crate::plugins::host::PluginHost::new(&config.paths.data_dir)
                .with_own_endpoints(crate::plugins::connector::OwnEndpoints::from_config(&config))
                .with_exposed_secrets(crate::plugins::host::exposed_secrets(&config)),
        );
        plugins.load(&db, &datasources).await.map_err(|e| anyhow::anyhow!("loading the plugins: {}", e.message))?;
        let touch_limit = crate::auth::session::Touches::limit_for(&db);
        // The touches, plus one for each of the two hourly jobs.
        let background = Arc::new(db::Background::new(&db, &config.database_url(), touch_limit + 2));
        let touches = Arc::new(crate::auth::session::Touches::new(background.clone(), touch_limit));
        let updates = Arc::new(crate::updates::Updates::new(&config.paths.data_dir, &config.database_url()));
        let read_db = db::read_pool(&db, &config.database_url(), db.options().get_max_connections())
            .unwrap_or_else(|| db.clone());
        let sso = Arc::new(crate::sso::Sso::new(&config));
        let state = Self {
            db,
            read_db,
            config: Arc::new(config),
            clock,
            login_limiter: Arc::new(login(Capacity::LARGE)),
            pair_limiter: Arc::new(login(Capacity::LARGE)),
            network_limiter: Arc::new(network_limiter),
            account_limiter: Arc::new(login(Capacity::UNBOUNDED)),
            unknown_account_limiter: Arc::new(login(Capacity::LARGE)),
            // At most `OVERFLOW_BUCKETS` keys.
            overflow_limiter: Arc::new(login(Capacity::UNBOUNDED)),
            sign_in_account_limiter: Arc::new(RateLimiter::new(
                crate::auth::ratelimit::MAX_SIGN_INS,
                window_secs,
                Capacity::UNBOUNDED,
            )),
            sign_in_address_limiter: Arc::new(RateLimiter::new(
                crate::auth::ratelimit::MAX_SIGN_INS,
                window_secs,
                Capacity::LARGE,
            )),
            password_limiter: Arc::new(login(Capacity::SMALL)),
            token_limiter: Arc::new(login(Capacity::LARGE)),
            limited_refusals: Arc::default(),
            password_checks: Arc::default(),
            setup_limiter: Arc::new(setup_limiter),
            setup_all_limiter: Arc::new(setup_all_limiter),
            probe_limiter: Arc::new(RateLimiter::new(
                crate::routes::datasources::PROBE_MAX,
                crate::routes::datasources::PROBE_WINDOW_SECS,
                Capacity::SMALL,
            )),
            setup: Arc::new(setup),
            secrets,
            datasources,
            background,
            touches,
            exports: Arc::new(tokio::sync::Semaphore::new(crate::routes::export::MAX_EXPORTS)),
            export_users: Arc::default(),
            export_limits: Arc::default(),
            catalog: Arc::default(),
            updates,
            live: Arc::default(),
            ai: Arc::default(),
            plugins,
            acme,
            mail: Arc::default(),
            cluster,
            usage: Arc::default(),
            sso,
        };
        // The connector reads data sources and server settings as they are at each connect;
        // `close` lets go of the state again.
        state.plugins.attach(state.clone());
        Ok(state)
    }

    /// Stops the background writes and closes every database pool this state opened: the
    /// server's, its read pool, the background writes' own and the data sources' SQLite files. Until then the
    /// files in the data directory stay open, and Windows cannot delete them (tests delete their
    /// temporary data directory right after).
    pub async fn close(&self) {
        // First, while the database is open: the next server takes over the lead at once.
        crate::cluster::stop(self).await;
        // Live connections are not requests the listeners wait for; they are told to close.
        self.live.shutdown(crate::live::SHUTDOWN_WAIT).await;
        self.plugins.shutdown().await;
        self.background.stop().await;
        self.datasources.close().await;
        self.read_db.close().await;
        self.db.close().await;
    }
}

/// Ends an app a unit test built on the temporary directory `dir`: closes it, then deletes the
/// directory. A dropped `TempDir` ignores files Windows cannot delete because they are still open,
/// which left every test's databases behind; this fails the test instead.
#[cfg(test)]
pub(crate) async fn finish_test_app(state: AppState, dir: tempfile::TempDir) {
    state.close().await;
    drop(state);
    let path = dir.path().to_path_buf();
    if let Err(e) = dir.close() {
        panic!("the test directory {} was not deleted: {e}", path.display());
    }
}

#[expect(clippy::disallowed_methods, reason = "assembles the route tables with the unversioned health endpoints")]
pub fn router(state: AppState) -> Router {
    let api = routes::table::build(routes::all(), &state).fallback(|| async { ApiError::not_found() });

    let routes = Router::new()
        .route("/healthz", get(health::healthz))
        .route("/readyz", get(health::readyz))
        .route(crate::acme::CHALLENGE_ROUTE, get(crate::acme::http_challenge))
        // The redirect URI of identity providers (docs/api/sso.md); outside `/api`, since it is a
        // page the browser is sent to.
        .route(routes::sso::CALLBACK_ROUTE, get(routes::sso::callback))
        .nest("/api", api)
        .fallback(web::static_files);
    with_layers(routes, state)
}

/// The layers every request passes. They run outside-in from the last one added: trace, request
/// info, security headers, origin check, request id, panic catcher, commit flag, then the route.
fn with_layers(routes: Router<AppState>, state: AppState) -> Router {
    routes
        // Each request gets its own "committed" flag, so errors after a commit are not "busy".
        .layer(axum::middleware::from_fn(db::scope_requests))
        // A panicking handler answers `internal` with the request id instead of dropping the connection.
        .layer(tower_http::catch_panic::CatchPanicLayer::custom(crate::error::panic_response))
        .layer(axum::middleware::from_fn(crate::error::assign_request_id))
        .layer(from_fn_with_state(state.clone(), net::origin_check))
        .layer(from_fn_with_state(state.clone(), net::security_headers))
        .layer(from_fn_with_state(state.clone(), net::request_info))
        .layer(TraceLayer::new_for_http().make_span_with(request_span))
        .with_state(state)
}

/// The span of a request in the trace log, as tower-http makes it, except that the query of a
/// provider's callback (`/auth/oidc/{slug}/callback`, which carries the authorization code and
/// state) is left out.
fn request_span(req: &axum::http::Request<axum::body::Body>) -> tracing::Span {
    let uri = req.uri();
    let shown = if uri.path().starts_with("/auth/oidc/") { uri.path().to_string() } else { uri.to_string() };
    tracing::debug_span!("request", method = %req.method(), uri = %shown, version = ?req.version())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::connect_info::MockConnectInfo;
    use axum::http::{Request, StatusCode};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    /// A panic in a handler, behind the same layers as every route: the answer is `internal` with
    /// the request id in body and header, and the outer layers (security headers) still ran.
    #[expect(clippy::disallowed_methods, reason = "a panicking route behind the real layers")]
    #[tokio::test]
    async fn a_panicking_route_answers_internal_through_the_real_layers() {
        async fn boom() -> &'static str {
            panic!("handler bug")
        }
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::default();
        config.paths.data_dir = dir.path().join("data");
        std::fs::create_dir_all(&config.paths.data_dir).unwrap();
        let pool = db::connect(&config.database_url(), 2).await.unwrap();
        let state = AppState::new(config, pool, Arc::new(crate::clock::SystemClock), None).await.unwrap();
        let routes = Router::new().route("/boom", get(boom)).route("/fine", get(|| async { "ok" }));
        let peer = std::net::SocketAddr::from(([127, 0, 0, 1], 50000));
        let app = with_layers(routes, state.clone()).layer(MockConnectInfo(peer));

        let res = app.clone().oneshot(Request::get("/boom").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(res.headers()["x-content-type-options"], "nosniff");
        let id = res.headers()["x-request-id"].to_str().unwrap().to_string();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "internal");
        assert_eq!(body["error"]["requestId"], id.as_str());
        assert!(!String::from_utf8_lossy(&bytes).contains("handler bug"));

        let res = app.oneshot(Request::get("/fine").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        finish_test_app(state, dir).await;
    }
}
