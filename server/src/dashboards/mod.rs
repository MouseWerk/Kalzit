//! Dashboards: the model and the checks a save goes through. The routes live in
//! `routes/dashboards.rs`.

pub mod model;

use sqlx::AnyPool;

use crate::authz::{self, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use model::DashboardModel;

/// Stored queries run with the rights of whoever views the dashboard, so whoever saves one must be
/// allowed to query every data source its panels and query variables use; otherwise an editor
/// could reach a data source through a panel they could not query directly.
///
/// That each id names a data source of this organization is checked here too once data sources
/// exist (migration 0006); the orchestrator adds that lookup when both streams are merged.
pub async fn check_dashboard_sources(db: &AnyPool, ctx: &OrgCtx, model: &DashboardModel) -> ApiResult<()> {
    for id in model.datasource_ids() {
        match authz::check_resource(db, ctx, Permission::DatasourcesQuery, Resource::Datasource(id)).await {
            Ok(()) => {}
            // The caller cannot see this data source, so it does not exist for them.
            Err(e) if e.code == "not_found" => {
                return Err(ApiError::validation(format!("data source {id} does not exist")).with_field("model"));
            }
            Err(e) if e.code == "forbidden" => {
                return Err(ApiError::forbidden(format!("you may not query data source {id}")));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::SessionUser;
    use serde_json::json;

    fn ctx(permissions: &[Permission]) -> OrgCtx {
        OrgCtx {
            user: SessionUser { id: "u".into(), email: "u@example.de".into(), name: "U".into(), is_server_admin: 0 },
            org_id: "o".into(),
            role: "custom".into(),
            permissions: permissions.iter().copied().collect(),
        }
    }

    #[tokio::test]
    async fn saving_needs_query_rights_on_every_source() {
        sqlx::any::install_default_drivers();
        let db = AnyPool::connect("sqlite::memory:").await.unwrap();
        let model = model::parse(json!({
            "schemaVersion": 1, "title": "T", "timeRange": { "from": "now-1h", "to": "now" },
            "variables": [ { "name": "v", "type": "query", "datasourceId": "ds-var" } ]
        }))
        .unwrap();
        assert!(check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesQuery]), &model).await.is_ok());
        // Sees data sources but may not query them: refused, naming the variable's source.
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesRead]), &model).await.unwrap_err();
        assert_eq!(e.code, "forbidden");
        assert!(e.message.contains("ds-var"), "{}", e.message);
        // Does not see data sources at all: for them the id does not exist.
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DashboardsWrite]), &model).await.unwrap_err();
        assert_eq!((e.code, e.field), ("validation", Some("model")));
    }
}
