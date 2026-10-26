//! Field distributions computed in the source (docs/api/datasources.md, "Field distribution"):
//! how the values of one field path are spread over the whole result of a document query, not
//! only over the documents a page loaded. MongoDB appends aggregation stages to the query;
//! kinds that cannot compute one in the source answer `distribution.unsupported`, and the UI
//! counts the loaded documents instead (and says so).
//!
//! The request runs exactly like the query it describes: the same authorization (the route
//! checked it), time limit, concurrency slots, connection and read-only checks.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use serde_json::Value;

use super::{Detail, SourceError, SourceQuery, api_error, resolve_in_org, sql};
use crate::app::AppState;
use crate::authz::OrgCtx;
use crate::error::{ApiError, ApiResult};
use crate::shapes::{FieldDistribution, TimeRange};

/// Steps of a path at most, and bytes of all its keys together.
pub const MAX_PATH_STEPS: usize = 64;
pub const MAX_PATH_BYTES: usize = 4 * 1024;
pub const MAX_TOP: u32 = 100;
pub const DEFAULT_TOP: u32 = 10;
pub const MAX_BINS: u32 = 100;
pub const DEFAULT_BINS: u32 = 20;
/// Distinct values are counted up to this many; more answer `distinctCapped`.
pub const DISTINCT_CAP: u64 = 100_000;

/// One step of a field path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathStep {
    /// A key, as stored: dots, `$` and any other character are part of it.
    Key(String),
    /// Every element of the array here (`[]` in a schema path).
    Elements,
}

/// What to compute, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DistributionSpec {
    pub path: Vec<PathStep>,
    pub top: usize,
    pub bins: usize,
}

fn invalid(reason: &'static str, field: &'static str, message: impl Into<String>) -> ApiError {
    ApiError::validation(message).with_field(field).because(reason)
}

impl DistributionSpec {
    /// The request's path and sizes, or `422 validation` naming the field.
    pub fn new(path: &[Option<String>], top: Option<u32>, bins: Option<u32>) -> ApiResult<Self> {
        if path.is_empty() || path.len() > MAX_PATH_STEPS {
            return Err(invalid("distribution.path_length", "path", format!("a path has 1 to {MAX_PATH_STEPS} steps"))
                .param("max", MAX_PATH_STEPS));
        }
        let bytes: usize = path.iter().flatten().map(String::len).sum();
        if bytes > MAX_PATH_BYTES {
            return Err(invalid(
                "distribution.path_too_long",
                "path",
                format!("a path holds at most {MAX_PATH_BYTES} bytes"),
            )
            .param("max", MAX_PATH_BYTES));
        }
        if path.iter().flatten().any(|k| k.contains('\0')) {
            return Err(invalid("distribution.path_invalid", "path", "a key may not hold a NUL character"));
        }
        if path.iter().all(Option::is_none) {
            return Err(invalid("distribution.path_invalid", "path", "a path names at least one key"));
        }
        let size = |v: Option<u32>, default: u32, max: u32, field: &'static str| -> ApiResult<usize> {
            match v.unwrap_or(default) {
                n @ 1.. if n <= max => Ok(n as usize),
                _ => Err(invalid("distribution.size", field, format!("{field} is 1 to {max}")).param("max", max)),
            }
        };
        Ok(DistributionSpec {
            path: path.iter().map(|s| s.clone().map_or(PathStep::Elements, PathStep::Key)).collect(),
            top: size(top, DEFAULT_TOP, MAX_TOP, "top")?,
            bins: size(bins, DEFAULT_BINS, MAX_BINS, "bins")?,
        })
    }
}

/// The source's answer to "unsupported": the UI then counts the loaded documents.
pub fn unsupported(kind: &str) -> SourceError {
    SourceError::rejected(
        "distribution.unsupported",
        format!("{kind} sources compute no field distribution; the loaded documents are counted instead"),
    )
    .with("kind", kind)
}

/// Computes the distribution of `spec.path` over the result of `query` on a data source of the
/// caller's organization. **The caller has authorized it** (`datasources:query` for a free query,
/// `dashboards:read` for a stored one). Errors are those of running the query.
#[expect(clippy::too_many_arguments, reason = "the parts of one query request, passed through")]
pub async fn run(
    state: &AppState,
    ctx: &OrgCtx,
    datasource_id: &str,
    query: Value,
    range: TimeRange,
    interval_ms: Option<u64>,
    variables: &BTreeMap<String, Value>,
    identifier_variables: Option<&BTreeSet<String>>,
    spec: &DistributionSpec,
) -> ApiResult<FieldDistribution> {
    let registry = &state.datasources;
    let ds = resolve_in_org(&state.db, &ctx.org_id, datasource_id).await?;
    let Some(kind) = registry.kind(&ds.kind) else {
        let detail =
            Detail::new("datasource.kind_unavailable", format!("the data source kind {} is not available", ds.kind))
                .with("kind", &ds.kind);
        return Err(api_error(SourceError::Failed(detail), None));
    };
    let budget = registry.response_budget(state).await?;
    let limits = registry.limits(state, &ds, budget).await?;
    let timeout = limits.timeout;
    let started = Instant::now();
    let run = async {
        // Waiting for a free slot counts against the time limit, as for queries.
        let _slots = registry.slots(state, &ctx.user.id).await?;
        let conn = registry.connection(state, &ds).await?;
        let req = SourceQuery {
            ref_id: "distribution".into(),
            query,
            range,
            interval_ms: sql::interval_ms(range, interval_ms, None),
            max_data_points: None,
            variables: variables.clone(),
            identifier_variables: identifier_variables.cloned(),
            limits,
            cursor: None,
        };
        let result = kind.plugin.distribution(&conn, req, spec).await;
        Ok::<_, SourceError>((conn, result))
    };
    match tokio::time::timeout(timeout, run).await {
        Err(_) => Err(api_error(SourceError::Timeout(timeout.as_secs()), None)),
        Ok(Err(e)) => Err(api_error(e, None)),
        Ok(Ok((_, Ok(d)))) => {
            tracing::debug!(datasource = %ds.id, ms = started.elapsed().as_millis() as u64, "distribution done");
            Ok(d)
        }
        Ok(Ok((conn, Err(e)))) => Err(api_error(e, Some(&conn))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(steps: &[Option<&str>]) -> Vec<Option<String>> {
        steps.iter().map(|s| s.map(str::to_owned)).collect()
    }

    #[test]
    fn paths_and_sizes_are_checked() {
        let spec = DistributionSpec::new(&path(&[Some("items"), None, Some("preis.netto")]), None, None).unwrap();
        assert_eq!(
            spec,
            DistributionSpec {
                path: vec![PathStep::Key("items".into()), PathStep::Elements, PathStep::Key("preis.netto".into())],
                top: 10,
                bins: 20,
            }
        );
        let reason = |p: &[Option<&str>], top: Option<u32>, bins: Option<u32>| {
            DistributionSpec::new(&path(p), top, bins).unwrap_err().reason.map(|r| r.code).unwrap_or_default()
        };
        assert_eq!(reason(&[], None, None), "distribution.path_length");
        assert_eq!(reason(&[None], None, None), "distribution.path_invalid");
        assert_eq!(reason(&[Some("a\0b")], None, None), "distribution.path_invalid");
        assert_eq!(reason(&[Some(&"x".repeat(MAX_PATH_BYTES + 1))], None, None), "distribution.path_too_long");
        let long: Vec<Option<&str>> = vec![Some("a"); MAX_PATH_STEPS + 1];
        assert_eq!(reason(&long, None, None), "distribution.path_length");
        assert_eq!(reason(&[Some("a")], Some(0), None), "distribution.size");
        assert_eq!(reason(&[Some("a")], None, Some(MAX_BINS + 1)), "distribution.size");
        assert!(DistributionSpec::new(&path(&[Some("Größe \u{1F642}")]), Some(MAX_TOP), Some(1)).is_ok());
    }
}
