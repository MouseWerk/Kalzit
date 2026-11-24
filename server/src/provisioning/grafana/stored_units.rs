//! A correction for dashboards imported from Grafana before the import took units over: their
//! field options may still hold Grafana's unit ids (`currencyEUR`, `Bps`), which panels do not
//! print. At start, until a run of this version went through (`DONE_KEY`), the server maps those
//! ids with the import's own table (`fields::unit`) and stores the result as a new version of the
//! dashboard, so the old one stays in its history, with an audit entry per dashboard. Only
//! dashboards with a Grafana import report are read; units Kalzit knows and ids the table does not
//! know stay as they are, so a run changes nothing a second time.

use serde_json::{Value, json};
use sqlx::AnyPool;

use crate::app::AppState;

use super::fields;

/// The rule set's version, named in the log and in the message of the versions it writes.
pub const VERSION: u32 = 1;

/// Maps one stored unit; whether it changed.
fn map_unit(slot: &mut Value) -> bool {
    let Some(id) = slot.as_str() else { return false };
    if fields::is_kalzit_unit(id) {
        return false;
    }
    match fields::unit(id, &mut Vec::new()) {
        Some(kalzit) if kalzit != id => {
            *slot = json!(kalzit);
            true
        }
        _ => false,
    }
}

/// Maps the Grafana unit ids in a model's field options (defaults and overrides of every panel);
/// returns how many changed.
pub fn map_units(model: &mut Value) -> usize {
    let mut changed = 0;
    for panel in model.get_mut("panels").and_then(Value::as_array_mut).into_iter().flatten() {
        let Some(config) = panel.get_mut("fieldConfig") else { continue };
        if let Some(unit) = config.pointer_mut("/defaults/unit") {
            changed += usize::from(map_unit(unit));
        }
        for o in config.get_mut("overrides").and_then(Value::as_array_mut).into_iter().flatten() {
            if let Some(unit) = o.pointer_mut("/properties/unit") {
                changed += usize::from(map_unit(unit));
            }
        }
    }
    changed
}

/// What a run changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Corrected {
    pub dashboards: u64,
    pub units: u64,
    /// Dashboards that could not be corrected this time (saved meanwhile, or an error); the next
    /// start tries them again.
    pub left: u64,
}

/// The row in `server_settings` that says which version of the correction ran through.
pub const DONE_KEY: &str = "migrations.grafana_units";
/// Dashboards read per page.
const PAGE: i64 = 100;
/// The message of the versions it writes, in both UI languages (version messages are text).
const MESSAGE: &str = "Grafana units taken over · Grafana-Einheiten übernommen";

async fn done(pool: &AnyPool) -> Result<bool, sqlx::Error> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM server_settings WHERE key = $1").bind(DONE_KEY).fetch_optional(pool).await?;
    Ok(row.and_then(|(v,)| v.trim().parse::<u32>().ok()).is_some_and(|v| v >= VERSION))
}

async fn mark_done(pool: &AnyPool, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO server_settings (key, value, version, updated_by, updated_at) VALUES ($1, $2, 1, NULL, $3) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, version = server_settings.version + 1, \
         updated_at = excluded.updated_at",
    )
    .bind(DONE_KEY)
    .bind(VERSION.to_string())
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Corrects one dashboard: a new version with the mapped units, its audit entry, and the
/// version retention. `Ok(false)` when it was saved meanwhile.
async fn correct(
    pool: &AnyPool,
    (org, id, version): (&str, &str, i64),
    model: &Value,
    units: usize,
    keep: i64,
    now: i64,
) -> Result<bool, sqlx::Error> {
    let mut tx = crate::db::begin(pool).await?;
    let moved = sqlx::query("UPDATE dashboards SET version = $1 WHERE id = $2 AND version = $3")
        .bind(version + 1)
        .bind(id)
        .bind(version)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if moved == 0 {
        tx.rollback().await?;
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO dashboard_versions (dashboard_id, version, model, message, author_id, restored_from, created_at) \
         VALUES ($1, $2, $3, $4, NULL, NULL, $5)",
    )
    .bind(id)
    .bind(version + 1)
    .bind(model.to_string())
    .bind(MESSAGE)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    if keep > 0 {
        sqlx::query("DELETE FROM dashboard_versions WHERE dashboard_id = $1 AND version <= $2")
            .bind(id)
            .bind(version + 1 - keep)
            .execute(&mut *tx)
            .await?;
    }
    let event = crate::audit::AuditEvent {
        org_id: Some(org),
        actor_user_id: None,
        actor_address: None,
        action: "dashboard.units_corrected",
        resource_type: Some("dashboard"),
        resource_id: Some(id),
        summary: json!({ "version": version + 1, "units": units, "correction": VERSION }),
        at_ms: now,
    };
    crate::audit::record(&mut tx, &event).await?;
    crate::db::commit(tx).await?;
    Ok(true)
}

/// Runs the correction, unless a run of this version went through before. Reads dashboards with
/// a Grafana import report page by page; dashboards in the trash and dashboards managed by
/// provisioning files (whose next apply would write them back) are left alone. A dashboard that
/// fails is logged and left for the next start, which then runs again.
pub async fn run(state: &AppState) -> Result<Corrected, sqlx::Error> {
    let pool = &state.db;
    let mut done_now = Corrected::default();
    if done(pool).await? {
        return Ok(done_now);
    }
    let keep =
        crate::settings::get(state, "dashboards.version_retention").await.ok().and_then(|v| v.as_i64()).unwrap_or(0);
    let now = state.clock.now_ms();
    let mut after = String::new();
    loop {
        let rows = sqlx::query_as::<_, (String, String, i64, String)>(
            "SELECT d.id, d.org_id, d.version, v.model FROM dashboards d \
             JOIN dashboard_import_reports r ON r.dashboard_id = d.id \
             JOIN dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.version \
             WHERE r.source = 'grafana' AND d.deleted_at IS NULL AND d.id > $1 \
             AND NOT EXISTS (SELECT 1 FROM provisioned_resources p WHERE p.kind = 'dashboard' AND p.resource_id = d.id) \
             ORDER BY d.id LIMIT $2",
        )
        .bind(&after)
        .bind(PAGE)
        .fetch_all(pool)
        .await?;
        let Some(last) = rows.last() else { break };
        after = last.0.clone();
        let full = rows.len() as i64 == PAGE;
        for (id, org, version, text) in rows {
            let Ok(mut model) = serde_json::from_str::<Value>(&text) else { continue };
            let units = map_units(&mut model);
            if units == 0 {
                continue;
            }
            match correct(pool, (&org, &id, version), &model, units, keep, now).await {
                Ok(true) => {
                    done_now.dashboards += 1;
                    done_now.units += units as u64;
                }
                Ok(false) => done_now.left += 1,
                Err(e) => {
                    tracing::warn!("the Grafana units of dashboard {id} were not corrected: {e}");
                    done_now.left += 1;
                }
            }
        }
        if !full {
            break;
        }
    }
    if done_now.left == 0 {
        mark_done(pool, now).await?;
    }
    Ok(done_now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_grafana_ids_and_keeps_everything_else() {
        let mut model = json!({ "panels": [
            { "fieldConfig": { "defaults": { "unit": "currencyEUR" }, "overrides": [
                { "matcher": { "type": "name", "value": "a" }, "properties": { "unit": "Bps" } },
                { "matcher": { "type": "name", "value": "b" }, "properties": { "unit": "rpm" } },
                { "matcher": { "type": "name", "value": "c" }, "properties": { "unit": "flux-capacitance" } },
                { "matcher": { "type": "name", "value": "d" }, "properties": { "unit": null } }
            ] } },
            { "fieldConfig": { "defaults": { "unit": "suffix:Kerne" } } },
            { "type": "text" }
        ] });
        assert_eq!(map_units(&mut model), 2);
        assert_eq!(model["panels"][0]["fieldConfig"]["defaults"]["unit"], "currency:EUR");
        let units: Vec<&Value> = model["panels"][0]["fieldConfig"]["overrides"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| &o["properties"]["unit"])
            .collect();
        // Kalzit's own `rpm` stays, an unknown id stays (nothing is lost), a cleared unit stays.
        assert_eq!(units, [&json!("suffix:B/s"), &json!("rpm"), &json!("flux-capacitance"), &Value::Null]);
        assert_eq!(model["panels"][1]["fieldConfig"]["defaults"]["unit"], "suffix:Kerne");
        // A second run changes nothing.
        assert_eq!(map_units(&mut model), 0);
    }
}
