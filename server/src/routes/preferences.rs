//! The signed-in user's personal preferences: language, theme, time zone, week start and start
//! dashboard (docs/api/shell.md). A preference that is not set follows the server default
//! (`appearance.*`), the browser's time zone, or Monday as the first day of the week.

use axum::extract::State;
use axum::http::Method;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::folders::double_option;
use super::support::{Actor, audit};
use super::table::{RouteDef, route};
use crate::app::AppState;
use crate::auth::SessionUser;
use crate::authz::{self, Access, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::settings;

pub fn routes() -> Vec<RouteDef> {
    vec![
        route(Method::GET, "/me/preferences", Access::Authenticated, get_preferences),
        route(Method::PATCH, "/me/preferences", Access::Authenticated, update_preferences),
    ]
}

pub const LANGUAGES: &[&str] = &["de", "en"];
pub const THEMES: &[&str] = &["system", "light", "dark", "contrast"];
pub const WEEK_STARTS: &[&str] = &["monday", "sunday", "saturday"];
const MAX_TIME_ZONE_CHARS: usize = 64;

#[derive(Default, sqlx::FromRow)]
struct Stored {
    language: Option<String>,
    theme: Option<String>,
    time_zone: Option<String>,
    week_start: Option<String>,
    start_org_id: Option<String>,
    start_dashboard_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartDashboard {
    org_id: String,
    dashboard_id: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    language: Value,
    theme: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// `null`: the server's default language.
    language: Option<String>,
    /// `null`: the server's default theme.
    theme: Option<String>,
    /// An IANA time zone (`Europe/Berlin`); `null`: the browser's.
    time_zone: Option<String>,
    /// `monday`, `sunday` or `saturday`; `null`: Monday (ISO 8601).
    week_start: Option<String>,
    /// Opens when the user enters Kalzit; `null` when unset, or when the dashboard is gone or no
    /// longer readable for them.
    start_dashboard: Option<StartDashboard>,
    /// What applies where a preference is not set.
    defaults: Defaults,
}

async fn load(conn: &mut sqlx::AnyConnection, user_id: &str) -> ApiResult<Stored> {
    let row: Option<Stored> = sqlx::query_as(
        "SELECT language, theme, time_zone, week_start, start_org_id, start_dashboard_id \
         FROM user_preferences WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.unwrap_or_default())
}

/// The user's membership in `org_id` as a context for resource checks, or `None` when they are
/// not a member.
async fn member_ctx(state: &AppState, user: &SessionUser, org_id: &str) -> ApiResult<Option<OrgCtx>> {
    let role: Option<(String,)> = sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(&user.id)
        .fetch_optional(&state.db)
        .await?;
    let Some((role,)) = role else { return Ok(None) };
    let permissions = authz::effective_permissions(&state.db, &user.id, org_id, &role).await?;
    Ok(Some(OrgCtx { user: user.clone(), org_id: org_id.to_string(), role, permissions, at_ms: state.clock.now_ms() }))
}

/// The title of the dashboard if the user may read it and it is not in the trash.
async fn readable_title(state: &AppState, user: &SessionUser, org_id: &str, id: &str) -> ApiResult<Option<String>> {
    let Some(ctx) = member_ctx(state, user, org_id).await? else { return Ok(None) };
    let row: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT title, deleted_at FROM dashboards WHERE org_id = $1 AND id = $2")
            .bind(org_id)
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    let Some((title, None)) = row else { return Ok(None) };
    match authz::check_resource(&state.db, &ctx, Permission::DashboardsRead, Resource::Dashboard(id)).await {
        Ok(()) => Ok(Some(title)),
        Err(e) if e.code == "not_found" || e.code == "forbidden" => Ok(None),
        Err(e) => Err(e),
    }
}

async fn defaults(state: &AppState) -> ApiResult<Defaults> {
    Ok(Defaults {
        language: settings::get(state, "appearance.default_language").await?,
        theme: settings::get(state, "appearance.default_theme").await?,
    })
}

/// The start dashboard with its title, if the user may still open it.
async fn start_of(state: &AppState, user: &SessionUser, stored: &Stored) -> ApiResult<Option<StartDashboard>> {
    let (Some(org_id), Some(dashboard_id)) = (&stored.start_org_id, &stored.start_dashboard_id) else {
        return Ok(None);
    };
    Ok(readable_title(state, user, org_id, dashboard_id).await?.map(|title| StartDashboard {
        org_id: org_id.clone(),
        dashboard_id: dashboard_id.clone(),
        title,
    }))
}

fn answer(stored: Stored, start_dashboard: Option<StartDashboard>, defaults: Defaults) -> Preferences {
    Preferences {
        language: stored.language,
        theme: stored.theme,
        time_zone: stored.time_zone,
        week_start: stored.week_start,
        start_dashboard,
        defaults,
    }
}

async fn get_preferences(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
) -> ApiResult<Json<Preferences>> {
    let stored = load(&mut *state.db.acquire().await?, &user.id).await?;
    let start = start_of(&state, &user, &stored).await?;
    Ok(Json(answer(stored, start, defaults(&state).await?)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartDashboardRef {
    org_id: String,
    dashboard_id: String,
}

/// Each field: absent keeps it, `null` resets it to the default, a value sets it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreferencesPatch {
    #[serde(default, deserialize_with = "double_option")]
    language: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    theme: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    time_zone: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    week_start: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    start_dashboard: Option<Option<StartDashboardRef>>,
}

fn one_of(value: &Option<String>, allowed: &[&str], field: &'static str) -> ApiResult<()> {
    match value {
        Some(v) if !allowed.contains(&v.as_str()) => {
            Err(ApiError::validation(format!("{field} must be one of {}", allowed.join(", "))).with_field(field))
        }
        _ => Ok(()),
    }
}

/// An IANA name such as `Europe/Berlin`, `America/Argentina/Buenos_Aires` or `UTC`. The browser
/// knows the zones; the server only checks the shape, so nothing but a name is ever stored.
pub fn is_time_zone_name(name: &str) -> bool {
    let part = |p: &str| {
        !p.is_empty()
            && p.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
            && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
    };
    name.len() <= MAX_TIME_ZONE_CHARS && name.split('/').count() <= 3 && name.split('/').all(part)
}

async fn update_preferences(
    State(state): State<AppState>,
    Extension(user): Extension<SessionUser>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(patch): JsonBody<PreferencesPatch>,
) -> ApiResult<Json<Preferences>> {
    if let Some(language) = &patch.language {
        one_of(language, LANGUAGES, "language")?;
    }
    if let Some(theme) = &patch.theme {
        one_of(theme, THEMES, "theme")?;
    }
    if let Some(week_start) = &patch.week_start {
        one_of(week_start, WEEK_STARTS, "weekStart")?;
    }
    if let Some(Some(zone)) = &patch.time_zone
        && !is_time_zone_name(zone)
    {
        return Err(
            ApiError::validation("timeZone must be a time zone name such as Europe/Berlin").with_field("timeZone")
        );
    }
    // Everything the answer needs besides the row is read before the transaction, so it never
    // waits for a second connection while holding the database. A dashboard the user cannot open
    // (another organization, hidden, gone, in the trash) is refused alike, so the answer tells
    // nothing about dashboards they cannot see.
    let defaults = defaults(&state).await?;
    let start_ref = match &patch.start_dashboard {
        Some(start) => start.as_ref().map(|s| (s.org_id.clone(), s.dashboard_id.clone())),
        None => {
            let current = load(&mut *state.db.acquire().await?, &user.id).await?;
            current.start_org_id.zip(current.start_dashboard_id)
        }
    };
    let start_title = match &start_ref {
        Some((org_id, dashboard_id)) => readable_title(&state, &user, org_id, dashboard_id).await?,
        None => None,
    };
    if matches!(patch.start_dashboard, Some(Some(_))) && start_title.is_none() {
        return Err(ApiError::validation("startDashboard is not a dashboard you can open").with_field("startDashboard"));
    }

    let mut fields: Vec<&str> = Vec::new();
    let mut tx = crate::db::begin(&state.db).await?;
    let mut stored = load(&mut tx, &user.id).await?;
    if let Some(language) = patch.language {
        stored.language = language;
        fields.push("language");
    }
    if let Some(theme) = patch.theme {
        stored.theme = theme;
        fields.push("theme");
    }
    if let Some(zone) = patch.time_zone {
        stored.time_zone = zone;
        fields.push("timeZone");
    }
    if let Some(week_start) = patch.week_start {
        stored.week_start = week_start;
        fields.push("weekStart");
    }
    if let Some(start) = patch.start_dashboard {
        (stored.start_org_id, stored.start_dashboard_id) = match start {
            Some(s) => (Some(s.org_id), Some(s.dashboard_id)),
            None => (None, None),
        };
        fields.push("startDashboard");
    }
    let now = state.clock.now_ms();
    sqlx::query(
        "INSERT INTO user_preferences (user_id, language, theme, time_zone, week_start, start_org_id, \
         start_dashboard_id, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (user_id) DO UPDATE SET language = excluded.language, theme = excluded.theme, \
         time_zone = excluded.time_zone, week_start = excluded.week_start, start_org_id = excluded.start_org_id, \
         start_dashboard_id = excluded.start_dashboard_id, updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(&stored.language)
    .bind(&stored.theme)
    .bind(&stored.time_zone)
    .bind(&stored.week_start)
    .bind(&stored.start_org_id)
    .bind(&stored.start_dashboard_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let actor = Actor { user_id: &user.id, info: &info, at_ms: now };
    let summary = json!({ "userId": user.id, "fields": fields });
    audit(&mut tx, &actor, None, "user.preferences_updated", ("user", &user.id), summary).await?;
    // The title read above belongs to the start dashboard stored now, unless another change set a
    // different one in between; then the next read names it.
    let stored_ref = stored.start_org_id.clone().zip(stored.start_dashboard_id.clone());
    let start = match (stored_ref, start_title) {
        (Some((org_id, dashboard_id)), Some(title)) if start_ref == Some((org_id.clone(), dashboard_id.clone())) => {
            Some(StartDashboard { org_id, dashboard_id, title })
        }
        _ => None,
    };
    let reply = answer(stored, start, defaults);
    crate::db::commit(tx).await?;
    Ok(Json(reply))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_zone_names_have_the_iana_shape() {
        for good in ["UTC", "Europe/Berlin", "America/Argentina/Buenos_Aires", "Etc/GMT+1", "America/Port-au-Prince"] {
            assert!(is_time_zone_name(good), "{good}");
        }
        for bad in ["", "/", "Europe/", "../etc/passwd", "Europe/Berlin\n", "A/B/C/D", "1Zone", &"a".repeat(65)] {
            assert!(!is_time_zone_name(bad), "{bad}");
        }
    }
}
