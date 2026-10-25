//! Dashboards: the model and the checks a save goes through. The routes live in
//! `routes/dashboards.rs`.

pub mod library;
pub mod model;
pub mod panel_options;
pub mod pattern_syntax;

use sqlx::AnyPool;

use crate::authz::{self, OrgCtx, Permission, Resource};
use crate::error::{ApiError, ApiResult};
use model::DashboardModel;

/// Stored queries run with the rights of whoever views the dashboard, so whoever saves one must be
/// allowed to query every data source its new or changed queries use; otherwise an editor could
/// reach a data source through a panel they could not query directly. The right is checked when
/// a query is saved, not when it runs.
///
/// Queries already in `previous` (the stored version) with the same data source and text are not
/// checked again, as long as no variable changed in what affects queries (`variables_for_queries`), so someone may rename or rearrange a dashboard whose queries they could not
/// write themselves. Each newly used id must name a data source of this organization (one in the
/// trash counts, it can come back): `422 validation` otherwise. A source the caller may not query
/// (or not see) is `403 forbidden`, naming it.
/// What of a variable affects the stored queries.
type QueryRelevant<'a> =
    (&'a str, model::VariableType, Option<&'a serde_json::Value>, Option<&'a serde_json::Value>, Option<&'a str>);

/// What of the variables affects the stored queries: names, types, a constant's value, a custom
/// variable's options and a query variable's source and query. Labels and the current selection
/// of other variables do not.
fn variables_for_queries(model: &DashboardModel) -> Vec<QueryRelevant<'_>> {
    use model::VariableType::{Constant, Custom};
    model
        .variables
        .iter()
        .map(|v| {
            let fixed = match v.kind {
                Constant => v.current.as_ref(),
                Custom => v.options.as_ref(),
                _ => None,
            };
            (v.name.as_str(), v.kind, fixed, v.query.as_ref(), v.datasource_id.as_deref())
        })
        .collect()
}

pub async fn check_dashboard_sources(
    db: &AnyPool,
    ctx: &OrgCtx,
    model: &DashboardModel,
    previous: Option<&DashboardModel>,
) -> ApiResult<()> {
    // Variables shape what every stored query reads (a constant's value, a custom variable's
    // options, a variable's type), so any change to them makes every query count as changed.
    let unchanged = match previous {
        Some(p) if variables_for_queries(p) == variables_for_queries(model) => p.stored_queries(),
        _ => Default::default(),
    };
    let changed: std::collections::BTreeSet<&str> =
        model.stored_queries().into_iter().filter(|q| !unchanged.contains(q)).map(|(id, _)| id).collect();
    for id in changed {
        if !authz::resource_exists(db, &ctx.org_id, Resource::Datasource(id)).await? {
            return Err(ApiError::validation(format!("data source {id} does not exist")).with_field("model"));
        }
        match authz::check_resource(db, ctx, Permission::DatasourcesQuery, Resource::Datasource(id)).await {
            Ok(()) => {}
            Err(e) if e.code == "not_found" || e.code == "forbidden" => {
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
            at_ms: 0,
        }
    }

    #[tokio::test]
    async fn saving_needs_query_rights_on_every_source() {
        // One connection, so every query sees the same in-memory database with the migrations.
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let model = model::parse(json!({
            "schemaVersion": 1, "title": "T", "timeRange": { "from": "now-1h", "to": "now" },
            "variables": [ { "name": "v", "type": "query", "datasourceId": "ds-var" } ]
        }))
        .unwrap();
        // Annotation queries are stored queries like any other: changing one needs the right.
        let mut annotated = model.clone();
        annotated.annotations.push(model::AnnotationQuery {
            id: "a".into(),
            name: "A".into(),
            datasource_id: "ds-ann".into(),
            query: json!({ "sql": "SELECT 1" }),
            enabled: true,
            color: None,
        });
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesQuery]), &annotated, Some(&annotated))
            .await
            .map(|_| ());
        assert!(e.is_ok(), "an unchanged annotation query is not checked again");
        // An id that names no data source of the organization is refused, whatever the rights.
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesQuery]), &model, None).await.unwrap_err();
        assert_eq!((e.code, e.field), ("validation", Some("model")));
        sqlx::query("INSERT INTO orgs (id, name, created_at) VALUES ('o', 'O', 0)").execute(&db).await.unwrap();
        sqlx::query(
            "INSERT INTO datasources (id, org_id, name, kind, settings, created_at, updated_at)              VALUES ('ds-var', 'o', 'V', 'sqlite', '{}', 0, 0)",
        )
        .execute(&db)
        .await
        .unwrap();
        assert!(check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesQuery]), &model, None).await.is_ok());
        // Sees data sources but may not query them: refused, naming the variable's source.
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesRead]), &model, None).await.unwrap_err();
        assert_eq!(e.code, "forbidden");
        assert!(e.message.contains("ds-var"), "{}", e.message);
        // Does not see the data source at all: refused as not allowed, naming it.
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DashboardsWrite]), &model, None).await.unwrap_err();
        assert_eq!(e.code, "forbidden");
        assert!(e.message.contains("ds-var"), "{}", e.message);
        // An unchanged stored query needs no right on its source.
        assert!(check_dashboard_sources(&db, &ctx(&[Permission::DashboardsWrite]), &model, Some(&model)).await.is_ok());
        // A new annotation query is checked like a panel's.
        let e = check_dashboard_sources(&db, &ctx(&[Permission::DatasourcesQuery]), &annotated, Some(&model))
            .await
            .unwrap_err();
        assert!(e.message.contains("ds-ann"), "{}", e.message);
    }
}
