//! First start: while no user exists, a one-time setup code lets the person who runs the server
//! create the first organization and its owner. The code is written to a file in the data
//! directory (only someone with access to the server can read it), never to the log.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::AnyPool;
use tokio::sync::Mutex;

use super::{clean_name, me, new_id, normalize_email};
use crate::app::AppState;
use crate::auth::{SessionUser, password, session};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;

pub const TOKEN_FILE: &str = "setup-token.txt";
/// A fixed code from the environment must not be guessable; the generated one has 24 hex digits.
const MIN_FIXED_CODE_CHARS: usize = 16;

pub struct SetupGate {
    /// `None` once setup is done. The lock also serializes concurrent setup attempts.
    state: Mutex<Option<OpenGate>>,
}

struct OpenGate {
    code_hash: String,
    file: Option<PathBuf>,
}

impl SetupGate {
    /// Opens the gate when the database has no users. `fixed_code` (from `GRANIT_SETUP_TOKEN`)
    /// replaces the generated code, for automated installs and tests; then no file is written.
    pub async fn init(db: &AnyPool, data_dir: &Path, fixed_code: Option<String>) -> Result<Self> {
        let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(db).await?;
        if users > 0 {
            remove_file_if_present(&data_dir.join(TOKEN_FILE));
            return Ok(Self { state: Mutex::new(None) });
        }
        let gate = match fixed_code {
            Some(code) => {
                if normalize_code(&code).len() < MIN_FIXED_CODE_CHARS {
                    anyhow::bail!(
                        "GRANIT_SETUP_TOKEN needs at least {MIN_FIXED_CODE_CHARS} letters or digits; \
                         leave it unset to get a generated code"
                    );
                }
                OpenGate { code_hash: hash_code(&code), file: None }
            }
            None => {
                let code = generate_code();
                let file = data_dir.join(TOKEN_FILE);
                write_private(&file, &format!("{code}\n"))
                    .with_context(|| format!("writing the setup code to {}", file.display()))?;
                tracing::info!(
                    "first start: open Granit in the browser and enter the setup code from {}",
                    file.display()
                );
                OpenGate { code_hash: hash_code(&code), file: Some(file) }
            }
        };
        Ok(Self { state: Mutex::new(Some(gate)) })
    }

    pub async fn is_open(&self) -> bool {
        self.state.lock().await.is_some()
    }
}

fn generate_code() -> String {
    let hex = hex::encode(rand::random::<[u8; 12]>());
    hex.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap_or_default()).collect::<Vec<_>>().join("-")
}

/// Dashes, spaces and case do not matter when typing the code.
fn normalize_code(code: &str) -> String {
    code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase()
}

fn hash_code(code: &str) -> String {
    hex::encode(Sha256::digest(normalize_code(code).as_bytes()))
}

/// Creates the file so that only the server's own user can read it. On Unix it is created with
/// mode 0600 (no window in which it is world-readable) and never through a pre-existing symlink.
/// On Windows it inherits the data directory's ACL; the service installer (M5) restricts that
/// directory to the service account and administrators.
fn write_private(path: &Path, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    remove_file_if_present(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(content.as_bytes())
}

fn remove_file_if_present(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("removing {}: {e}", path.display()),
    }
}

fn close_gate(gate: &mut Option<OpenGate>) {
    if let Some(file) = gate.take().and_then(|g| g.file) {
        remove_file_if_present(&file);
    }
}

fn setup_done() -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "setup_done", "setup is already complete")
}

pub async fn status(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "needed": state.setup.is_open().await }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupRequest {
    token: String,
    org_name: String,
    name: String,
    email: String,
    password: String,
}

pub async fn complete(
    State(state): State<AppState>,
    axum::Extension(info): axum::Extension<RequestInfo>,
    JsonBody(req): JsonBody<SetupRequest>,
) -> ApiResult<impl IntoResponse> {
    let now = state.clock.now_ms();
    let limit_key = format!("setup-ip:{}", info.client_ip);
    if !state.login_limiter.try_acquire(&[&limit_key], now) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many attempts, wait a few minutes",
        ));
    }

    let mut gate = state.setup.state.lock().await;
    let Some(open) = gate.as_ref() else {
        return Err(setup_done());
    };
    if hash_code(&req.token) != open.code_hash {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_setup_token", "the setup code is not correct"));
    }
    state.login_limiter.refund(&limit_key);

    let org_name = clean_name(&req.org_name, "organization name")?;
    let name = clean_name(&req.name, "name")?;
    let email = normalize_email(&req.email)?;
    password::check_policy(&req.password).map_err(ApiError::validation)?;
    let hash = password::hash(req.password).await.map_err(|e| ApiError::internal("hashing password", e))?;

    let org_id = new_id();
    let user_id = new_id();
    let mut tx = state.db.begin().await?;
    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&mut *tx).await?;
    if users > 0 {
        // Another server on the same database finished setup first; this one is done too.
        close_gate(&mut gate);
        return Err(setup_done());
    }
    sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ($1, $2, $3)")
        .bind(&org_id)
        .bind(&org_name)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at) \
         VALUES ($1, $2, $3, $4, 1, 0, $5)",
    )
    .bind(&user_id)
    .bind(&email)
    .bind(&name)
    .bind(&hash)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, 'owner', $3)")
        .bind(&org_id)
        .bind(&user_id)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    close_gate(&mut gate);
    drop(gate);
    tracing::info!(user = %user_id, org = %org_id, "setup complete");

    let token = session::create(&state.db, &state.config.sessions, now, &user_id).await?;
    let user = SessionUser { id: user_id, email, name, is_server_admin: 1 };
    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, session::set_cookie(&token, &state.config.sessions, info.https));
    Ok((headers, Json(me(&state.db, user).await?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_grouped_and_forgiving() {
        let code = generate_code();
        assert_eq!(code.len(), 29, "{code}");
        assert_eq!(code.matches('-').count(), 5);
        assert_eq!(hash_code(&code), hash_code(&code.replace('-', " ").to_uppercase()));
    }
}
