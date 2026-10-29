//! First start: while no user exists, a one-time setup code lets the person who runs the server
//! create the first organization and its owner. The code is written to a file in the data
//! directory (only someone with access to the server can read it), never to the log.
//!
//! The code of the previous start is remembered (as a hash) so that someone who copied the old
//! code learns that it was replaced, instead of only that it is wrong. It never opens setup.

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
use crate::auth::ratelimit::Counted;
use crate::auth::{SessionUser, password, session};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::settings::{self, Scope, SettingDef};

pub const TOKEN_FILE: &str = "setup-token.txt";
/// A fixed code from the environment must not be guessable; the generated one has 24 hex digits.
const MIN_FIXED_CODE_CHARS: usize = 16;

/// The key of the budget all client addresses share for wrong setup codes.
const ALL_ADDRESSES_KEY: &str = "setup:all";

pub struct SetupGate {
    /// `None` once setup is done. The lock also serializes concurrent setup attempts.
    state: Mutex<Option<OpenGate>>,
}

type CodeHash = [u8; 32];

struct OpenGate {
    code_hash: CodeHash,
    /// The generated code of the previous start, if its file was still there.
    previous_hash: Option<CodeHash>,
    file: Option<PathBuf>,
    hint: CodeHint,
}

/// Where the person setting up finds the code, for the setup page's help text. Never a path.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodeHint {
    /// The generated file in the data directory.
    File,
    /// The same file, in a container: read with `kalzit setup-code` through the container tool.
    Docker,
    /// `KALZIT_SETUP_TOKEN`, chosen by whoever installed the server.
    Fixed,
}

impl CodeHint {
    fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Docker => "docker",
            Self::Fixed => "fixed",
        }
    }
}

impl SetupGate {
    /// Opens the gate when the database has no users. `fixed_code` (from `KALZIT_SETUP_TOKEN`)
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
                        "KALZIT_SETUP_TOKEN needs at least {MIN_FIXED_CODE_CHARS} letters or digits; \
                         leave it unset to get a generated code"
                    );
                }
                OpenGate { code_hash: hash_code(&code), previous_hash: None, file: None, hint: CodeHint::Fixed }
            }
            None => {
                // Read before it is replaced; an unreadable file only means no hint about it.
                let previous_hash = match read_code(data_dir) {
                    Ok(previous) => previous.map(|c| hash_code(&c)),
                    Err(e) => {
                        tracing::warn!("reading the previous setup code: {e}");
                        None
                    }
                };
                let code = generate_code();
                let file = data_dir.join(TOKEN_FILE);
                write_private(&file, &format!("{code}\n"))
                    .with_context(|| format!("writing the setup code to {}", file.display()))?;
                tracing::info!(
                    "first start: open Kalzit in the browser and enter the setup code from {}",
                    file.display()
                );
                let hint = if crate::updates::platform::in_container() { CodeHint::Docker } else { CodeHint::File };
                OpenGate { code_hash: hash_code(&code), previous_hash, file: Some(file), hint }
            }
        };
        Ok(Self { state: Mutex::new(Some(gate)) })
    }

    pub async fn is_open(&self) -> bool {
        self.state.lock().await.is_some()
    }

    /// Closes the gate: another server on the same database finished setup (`cluster`).
    pub async fn close(&self) {
        let mut gate = self.state.lock().await;
        if gate.is_some() {
            close_gate(&mut gate);
            tracing::info!("setup was completed on another server");
        }
    }

    /// Where to find the code while setup is open (`file`, `docker` or `fixed`).
    pub async fn code_hint(&self) -> Option<&'static str> {
        self.state.lock().await.as_ref().map(|g| g.hint.as_str())
    }
}

/// The generated setup code from the data directory, for `kalzit setup-code` (a container image
/// without a shell has no `cat`). `None` when there is none: setup is done, the server has not
/// started yet, or the code comes from `KALZIT_SETUP_TOKEN`.
pub fn read_code(data_dir: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(data_dir.join(TOKEN_FILE)) {
        Ok(text) => Ok(Some(text.trim().to_string()).filter(|c| !c.is_empty())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
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

fn hash_code(code: &str) -> CodeHash {
    Sha256::digest(normalize_code(code).as_bytes()).into()
}

/// Compares two hashes in time that does not depend on where they differ.
fn same_hash(a: &CodeHash, b: &CodeHash) -> bool {
    use subtle::ConstantTimeEq;
    a.ct_eq(b).into()
}

enum CodeMatch {
    Current,
    Previous,
    Wrong,
}

impl OpenGate {
    /// Both hashes are always compared, so the time does not tell which one was close.
    fn matches(&self, code: &str) -> CodeMatch {
        let hash = hash_code(code);
        let current = same_hash(&hash, &self.code_hash);
        let previous = self.previous_hash.as_ref().is_some_and(|p| same_hash(&hash, p));
        if current {
            CodeMatch::Current
        } else if previous {
            CodeMatch::Previous
        } else {
            CodeMatch::Wrong
        }
    }
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
    // Private from its first moment: mode 0600, or on Windows its own protected ACL instead of
    // whatever the folder passes on.
    #[cfg(windows)]
    let mut file = crate::data_dir::acl::create_file(path, crate::data_dir::acl::FILE_SDDL)?;
    #[cfg(not(windows))]
    let mut file = {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?
    };
    file.write_all(content.as_bytes())
}

fn remove_file_if_present(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("removing {}: {e}", path.display()),
    }
}

pub fn routes() -> Vec<super::table::RouteDef> {
    use crate::authz::Access::Public;
    use axum::http::Method;
    vec![
        super::table::route(Method::GET, "/setup", Public, status),
        super::table::route(Method::POST, "/setup", Public, complete),
        super::table::route(Method::POST, "/setup/check", Public, check),
    ]
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
    Json(match state.setup.code_hint().await {
        Some(hint) => json!({ "needed": true, "codeHint": hint }),
        None => json!({ "needed": false }),
    })
}

/// Counts one attempt for the client (IPv4 per address, IPv6 per /48, so a site gets no more
/// tries by using more of its /64 networks; the sign-in limits, `security.login_*`); the key
/// is for the refund of a correct code. Only wrong codes use up budgets, so no one can use up
/// the budget of the person who has the code from elsewhere.
///
/// Wrong codes from all addresses together have a budget too (`security.setup_*`). Used up, it
/// refuses every address that is not clean (`ratelimit::CLEAN_ADDRESS_FAILURES`) before its code
/// is compared, while a clean address is still checked and gets in with the right code. A guess
/// spread over many addresses so gets a few tries per address instead of the full per-address
/// budget, which keeps a fixed code from `KALZIT_SETUP_TOKEN` (16 characters at least) out of
/// reach as well.
fn acquire(state: &AppState, info: &RequestInfo) -> ApiResult<(String, Counted)> {
    use crate::auth::ratelimit::{CLEAN_ADDRESS_FAILURES, network_key, site_key};
    let key = site_key("setup", info.client_ip);
    let now = state.clock.monotonic_ms();
    let refused = |wait| ApiError::rate_limited("too many setup code attempts, wait", wait);
    let counted = state.setup_limiter.try_acquire(&key, &network_key(info.client_ip), now).map_err(refused)?;
    if counted.earlier > CLEAN_ADDRESS_FAILURES
        && let Some(wait) = state.setup_all_limiter.wait(ALL_ADDRESSES_KEY, now)
    {
        state.setup_limiter.refund(&key, &counted);
        return Err(refused(wait));
    }
    Ok((key, counted))
}

/// Checks `token` against the open gate: `Ok` for the current code (the attempt is refunded),
/// `setup_token_expired` for the code of the previous start, `invalid_setup_token` otherwise;
/// both of these count for all addresses together. The code is never logged or repeated.
fn verify(state: &AppState, open: &OpenGate, token: &str, limit: &(String, Counted)) -> ApiResult<()> {
    let found = open.matches(token);
    if !matches!(found, CodeMatch::Current) {
        state.setup_all_limiter.record(ALL_ADDRESSES_KEY, ALL_ADDRESSES_KEY, state.clock.monotonic_ms());
    }
    match found {
        CodeMatch::Current => {
            state.setup_limiter.refund(&limit.0, &limit.1);
            Ok(())
        }
        CodeMatch::Previous => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "setup_token_expired",
            "this setup code is from an earlier start of the server; use the current one",
        )),
        CodeMatch::Wrong => {
            Err(ApiError::new(StatusCode::FORBIDDEN, "invalid_setup_token", "the setup code is not correct"))
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRequest {
    token: String,
}

/// Checks the setup code alone, so the setup page can confirm it before asking for the rest.
pub async fn check(
    State(state): State<AppState>,
    axum::Extension(info): axum::Extension<RequestInfo>,
    JsonBody(req): JsonBody<CheckRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let limit_key = acquire(&state, &info)?;
    let gate = state.setup.state.lock().await;
    let Some(open) = gate.as_ref() else {
        // Not a guess: once setup is done, no code opens anything.
        state.setup_limiter.refund(&limit_key.0, &limit_key.1);
        return Err(setup_done());
    };
    verify(&state, open, &req.token, &limit_key)?;
    Ok(Json(json!({ "valid": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetupRequest {
    token: String,
    org_name: String,
    name: String,
    email: String,
    password: String,
    /// Server defaults the setup page asks for; left out, they stay as they are.
    language: Option<String>,
    theme: Option<String>,
    /// The new organization's time zone.
    time_zone: Option<String>,
}

/// A setting chosen during setup: its definition and value, checked with the settings rules.
fn setup_setting(
    key: &str,
    scope: Scope,
    value: Option<&str>,
    field: &'static str,
) -> ApiResult<Option<(&'static SettingDef, serde_json::Value)>> {
    let Some(value) = value else { return Ok(None) };
    let def = settings::find(key, scope).ok_or_else(|| ApiError::internal("setup", format!("no setting {key}")))?;
    let value = json!(value);
    settings::validate(def, &value).map_err(|e| ApiError::validation(e).with_field(field))?;
    Ok(Some((def, value)))
}

/// Stores a setting chosen during setup and records it like the settings API does (key and
/// version, never the value). Runs inside the setup transaction.
async fn store_setup_setting(
    tx: &mut sqlx::AnyConnection,
    org_id: Option<&str>,
    key: &str,
    value: &serde_json::Value,
    user_id: &str,
    info: &RequestInfo,
    now: i64,
) -> ApiResult<()> {
    let stored: Option<(i64,)> = match org_id {
        None => {
            sqlx::query_as("SELECT version FROM server_settings WHERE key = $1")
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        }
        Some(org) => {
            sqlx::query_as("SELECT version FROM org_settings WHERE org_id = $1 AND key = $2")
                .bind(org)
                .bind(key)
                .fetch_optional(&mut *tx)
                .await?
        }
    };
    let expected = stored.map_or(0, |(v,)| v);
    let Some(version) = settings::store(&mut *tx, org_id, key, value, expected, user_id, now).await? else {
        return Err(ApiError::internal("setup", format!("storing {key} lost a race inside its transaction")));
    };
    let event = crate::audit::AuditEvent {
        org_id,
        actor_user_id: Some(user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "settings.updated",
        resource_type: Some("setting"),
        resource_id: Some(key),
        summary: json!({ "key": key, "version": version, "setup": true }),
        at_ms: now,
    };
    crate::audit::record(tx, &event).await?;
    Ok(())
}

pub async fn complete(
    State(state): State<AppState>,
    axum::Extension(info): axum::Extension<RequestInfo>,
    JsonBody(req): JsonBody<SetupRequest>,
) -> ApiResult<impl IntoResponse> {
    let now = state.clock.now_ms();
    let limit_key = acquire(&state, &info)?;

    let mut gate = state.setup.state.lock().await;
    let Some(open) = gate.as_ref() else {
        return Err(setup_done());
    };
    verify(&state, open, &req.token, &limit_key)?;

    let org_name = clean_name(&req.org_name, "organization name").map_err(|e| e.with_field("orgName"))?;
    let name = clean_name(&req.name, "name").map_err(|e| e.with_field("name"))?;
    let email = normalize_email(&req.email).map_err(|e| e.with_field("email"))?;
    password::check_policy(&req.password).map_err(|e| ApiError::validation(e).with_field("password"))?;
    let server_settings = [
        setup_setting("appearance.default_language", Scope::Server, req.language.as_deref(), "language")?,
        setup_setting("appearance.default_theme", Scope::Server, req.theme.as_deref(), "theme")?,
    ];
    let org_time_zone = setup_setting("appearance.time_zone", Scope::Org, req.time_zone.as_deref(), "timeZone")?;
    let hash = password::hash(req.password).await?;

    let org_id = new_id();
    let user_id = new_id();
    let mut tx = crate::db::begin(&state.db).await?;
    // The one row of `setup_lock` (fixed key) is written first: of two servers on one database
    // doing setup at once, the second waits for the first and then fails on the key, on
    // PostgreSQL as on SQLite. An early return rolls everything back.
    let claimed = sqlx::query("INSERT INTO setup_lock (id, done_at) VALUES (1, $1)").bind(now).execute(&mut *tx).await;
    match claimed {
        Ok(_) => {}
        Err(e) if super::support::is_unique_violation(&e) => {
            // Another server on the same database finished setup first; this one is done too.
            close_gate(&mut gate);
            return Err(setup_done());
        }
        Err(e) => return Err(e.into()),
    }
    let (users,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users").fetch_one(&mut *tx).await?;
    if users > 0 {
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
    let event = crate::audit::AuditEvent {
        org_id: Some(&org_id),
        actor_user_id: Some(&user_id),
        actor_address: Some(info.client_ip.to_string()),
        action: "setup.completed",
        resource_type: Some("org"),
        resource_id: Some(&org_id),
        summary: json!({}),
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    for (def, value) in server_settings.iter().flatten() {
        store_setup_setting(&mut tx, None, def.key, value, &user_id, &info, now).await?;
    }
    if let Some((def, value)) = &org_time_zone {
        store_setup_setting(&mut tx, Some(&org_id), def.key, value, &user_id, &info, now).await?;
    }
    // The session and the answer are part of the transaction: once it is committed, nothing may
    // fail as "busy, nothing changed".
    let token = session::create(&mut *tx, &state.config.sessions, now, &user_id).await?;
    let user = SessionUser { id: user_id.clone(), email, name, is_server_admin: 1 };
    let answer = me(&mut *tx, user).await?;
    // The other servers on the same database close their gate (`cluster`).
    crate::cluster::record(&mut tx, state.cluster.id(), &crate::cluster::Change::SetupDone).await?;
    crate::db::commit(tx).await?;
    let cache = settings::cache(&state);
    cache.invalidate(None);
    cache.invalidate(Some(&org_id));

    close_gate(&mut gate);
    drop(gate);
    tracing::info!(user = %user_id, org = %org_id, "setup complete");

    let mut headers = HeaderMap::new();
    headers.insert(header::SET_COOKIE, session::set_cookie(&token, &state.config.sessions, info.https));
    Ok((headers, Json(answer)))
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

    #[test]
    fn the_setup_code_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(TOKEN_FILE);
        write_private(&file, "abc\n").unwrap();
        // Written again on the next start: replaced, still private.
        write_private(&file, "def\n").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "def\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        #[cfg(windows)]
        {
            // Its own protected entries, not the ones the (temporary) folder passes on.
            let sddl = crate::data_dir::acl::dacl_sddl(&file).unwrap();
            assert!(sddl.split("D:").nth(1).unwrap_or_default().starts_with('P'), "not protected: {sddl}");
            let aces = crate::data_dir::acl::aces(&sddl);
            let mut trustees: Vec<&str> = aces.iter().map(|(_, _, t)| t.as_str()).collect();
            trustees.sort_unstable();
            assert_eq!(trustees, ["BA", "OW", "SY"], "{sddl}");
            assert!(aces.iter().all(|(flags, _, _)| flags.is_empty()), "explicit entries only: {sddl}");
        }
    }

    #[test]
    fn the_setup_code_is_read_back_without_its_line_end() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_code(dir.path()).unwrap(), None);
        write_private(&dir.path().join(TOKEN_FILE), "1a2b-3c4d\n").unwrap();
        assert_eq!(read_code(dir.path()).unwrap().as_deref(), Some("1a2b-3c4d"));
    }
}
