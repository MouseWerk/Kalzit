//! What this server is, for Settings, About: version, build and database kind (docs/api/shell.md,
//! "About"). Never paths, host names or settings.

use axum::Json;
use axum::extract::State;
use axum::http::Method;
use serde::Serialize;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::authz::Access;

pub fn routes() -> Vec<RouteDef> {
    vec![route(Method::GET, "/about", Access::Authenticated, about)]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct About {
    version: &'static str,
    /// Short commit id, or "unknown" when the build had no git.
    commit: &'static str,
    /// Build date, `YYYY-MM-DD`.
    build_date: &'static str,
    /// `windows`, `linux`, `macos`, ...
    platform: &'static str,
    /// `x64`, `arm64`, ...
    arch: &'static str,
    /// `sqlite` or `postgres`.
    database: &'static str,
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

async fn about(State(state): State<AppState>) -> Json<About> {
    let url = state.config.database_url();
    let database = if url.starts_with("postgres:") || url.starts_with("postgresql:") { "postgres" } else { "sqlite" };
    Json(About {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("KALZIT_BUILD_COMMIT"),
        build_date: env!("KALZIT_BUILD_DATE"),
        platform: std::env::consts::OS,
        arch: arch_name(),
        database,
    })
}
