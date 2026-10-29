//! What this server is, for Settings, About (docs/api/shell.md, "About"). Every signed-in user
//! gets the version and build date; the commit, platform and database kind go to server
//! administrators only. Never paths, host names or settings.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::Serialize;

use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::Access;

pub fn routes() -> Vec<RouteDef> {
    vec![route(Method::GET, "/about", Access::Authenticated, about)]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct About {
    version: &'static str,
    /// Build date, `YYYY-MM-DD`.
    build_date: &'static str,
    /// Short commit id, or "unknown" when the build had none. Server administrators only.
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<&'static str>,
    /// `windows`, `linux`, `macos`, ... Server administrators only.
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<&'static str>,
    /// `x64`, `arm64`, ... Server administrators only.
    #[serde(skip_serializing_if = "Option::is_none")]
    arch: Option<&'static str>,
    /// `sqlite` or `postgres`. Server administrators only.
    #[serde(skip_serializing_if = "Option::is_none")]
    database: Option<&'static str>,
    /// Reason codes of configuration an administrator should change (`Config::warning_codes`).
    /// Server administrators only, and only when there is one.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    config_warnings: Vec<&'static str>,
}

fn arch_name() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

async fn about(State(state): State<AppState>, Extension(user): Extension<SessionUser>) -> Json<About> {
    let mut about = About {
        version: env!("CARGO_PKG_VERSION"),
        build_date: env!("KALZIT_BUILD_DATE"),
        commit: None,
        platform: None,
        arch: None,
        database: None,
        config_warnings: Vec::new(),
    };
    if user.is_server_admin != 0 {
        let url = state.config.database_url();
        about.commit = Some(env!("KALZIT_BUILD_COMMIT"));
        about.platform = Some(std::env::consts::OS);
        about.arch = Some(arch_name());
        about.database =
            Some(if url.starts_with("postgres:") || url.starts_with("postgresql:") { "postgres" } else { "sqlite" });
        about.config_warnings = state.config.warning_codes();
    }
    Json(about)
}
