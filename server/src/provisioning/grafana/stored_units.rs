//! A correction for dashboards imported from Grafana before the import took units over: their
//! field options may still hold Grafana's unit ids (`currencyEUR`, `Bps`), which panels do not
//! print. At each start the server maps those ids with the import's own table (`fields::unit`)
//! and stores the result as a new version of the dashboard, so the old one stays in its history.
//! Only dashboards with a Grafana import report are read; units Kalzit knows and ids the table
//! does not know stay as they are, so a second run changes nothing.

use serde_json::{Value, json};
use sqlx::AnyPool;

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
}

/// Runs the correction. A dashboard saved meanwhile (by another server starting at the same
/// time) is left for the next start.
pub async fn run(pool: &AnyPool, now: i64) -> Result<Corrected, sqlx::Error> {
    let rows = sqlx::query_as::<_, (String, i64, String)>(
        "SELECT d.id, d.version, v.model FROM dashboards d \
         JOIN dashboard_import_reports r ON r.dashboard_id = d.id \
         JOIN dashboard_versions v ON v.dashboard_id = d.id AND v.version = d.version \
         WHERE r.source = 'grafana'",
    )
    .fetch_all(pool)
    .await?;
    let mut done = Corrected::default();
    for (id, version, text) in rows {
        let Ok(mut model) = serde_json::from_str::<Value>(&text) else { continue };
        let units = map_units(&mut model);
        if units == 0 {
            continue;
        }
        let mut tx = crate::db::begin(pool).await?;
        let moved = sqlx::query("UPDATE dashboards SET version = $1 WHERE id = $2 AND version = $3")
            .bind(version + 1)
            .bind(&id)
            .bind(version)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if moved == 0 {
            tx.rollback().await?;
            continue;
        }
        sqlx::query(
            "INSERT INTO dashboard_versions (dashboard_id, version, model, message, author_id, restored_from, created_at) \
             VALUES ($1, $2, $3, $4, NULL, NULL, $5)",
        )
        .bind(&id)
        .bind(version + 1)
        .bind(model.to_string())
        .bind(format!("Units taken over from the Grafana import (correction {VERSION})"))
        .bind(now)
        .execute(&mut *tx)
        .await?;
        crate::db::commit(tx).await?;
        done.dashboards += 1;
        done.units += units as u64;
    }
    Ok(done)
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
