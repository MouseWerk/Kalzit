//! Notification policies (docs/api/alerting.md, "Notification policies"): the tree of an
//! organization, its route check and its active groups. Everyone with `alerts:read` sees them;
//! creating, changing, moving and deleting needs `alerts:contacts` (organization admins), since
//! the tree decides where reduced values are sent. Every change is audited with names, matchers
//! and contact point ids, never URLs.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::known_id;
use super::rules::{PathStep, path_of};
use crate::alerting::evaluate::alert_labels;
use crate::alerting::groups::{self, GroupView};
use crate::alerting::limits;
use crate::alerting::policy::{
    self as store, EACH_INSTANCE, Effective, Escalation, MAX_CONTACT_POINTS, MAX_ESCALATION_WAIT_SECS, MAX_ESCALATIONS,
    MAX_GROUP_BY, MAX_GROUP_INTERVAL_SECS, MAX_GROUP_WAIT_SECS, MAX_MATCHERS, MAX_REPEAT_INTERVAL_SECS,
    MIN_ESCALATION_WAIT_SECS, MIN_GROUP_INTERVAL_SECS, Tree, group_of,
};
use crate::alerting::rule::{invalid, is_label_name};
use crate::alerting::silences::{self, Matcher};
use crate::app::AppState;
use crate::authz::{DatasourceAccess, OrgCtx, lock_org};
use crate::error::{ApiError, ApiResult};
use crate::extract::JsonBody;
use crate::net::RequestInfo;
use crate::routes::support::{Actor, QueryParams, audit, conflict};
use crate::shapes::Page;

const MAX_NAME_CHARS: usize = 100;

/// A member of a group with what the group sent of it.
type SentRow = (String, String, String, Option<String>, Option<i64>);

use super::data_visible;

/// Siblings have names of their own (compared without case).
async fn name_free(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    parent_id: &str,
    name: &str,
    except: Option<&str>,
) -> ApiResult<()> {
    let names: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM alert_policies WHERE org_id = $1 AND parent_id = $2")
            .bind(org_id)
            .bind(parent_id)
            .fetch_all(&mut *conn)
            .await?;
    let wanted = name.to_lowercase();
    if names.iter().any(|(id, n)| Some(id.as_str()) != except && n.to_lowercase() == wanted) {
        return Err(conflict("another policy at this place has the name")
            .with_field("name")
            .because("alerts.policy_name_taken"));
    }
    Ok(())
}
/// Label sets one route check takes.
const MAX_ROUTE_LABEL_SETS: usize = 100;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyView {
    id: String,
    parent_id: Option<String>,
    position: i64,
    depth: usize,
    is_root: bool,
    name: String,
    matchers: Vec<Matcher>,
    group_by: Option<Vec<String>>,
    group_wait_secs: Option<i64>,
    group_interval_secs: Option<i64>,
    repeat_interval_secs: Option<i64>,
    #[serde(rename = "continue")]
    continue_matching: bool,
    contact_point_ids: Vec<String>,
    escalations: Vec<Escalation>,
    effective: Effective,
    active_groups: i64,
    version: i64,
    created_by: Option<String>,
    created_at: i64,
    updated_by: Option<String>,
    updated_by_name: Option<String>,
    updated_at: i64,
}

/// The tree with its root made where missing.
async fn load_tree(state: &AppState, org_id: &str) -> ApiResult<Tree> {
    let mut conn = state.db.acquire().await?;
    store::ensure_root(&mut conn, org_id, state.clock.now_ms()).await?;
    Ok(Tree::new(org_id, store::load(&mut conn, org_id).await?))
}

/// Every policy of the tree as the API answers it, depth first.
async fn views(state: &AppState, org_id: &str, tree: &Tree) -> ApiResult<Vec<PolicyView>> {
    let mut conn = state.db.acquire().await?;
    let active = groups::active_per_policy(&mut conn, org_id).await?;
    let names: Vec<(String, String)> = sqlx::query_as(
        "SELECT p.id, u.name FROM alert_policies p JOIN users u ON u.id = p.updated_by WHERE p.org_id = $1",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let names: BTreeMap<String, String> = names.into_iter().collect();
    Ok(tree
        .nodes()
        .iter()
        .map(|n| {
            let p = &n.policy;
            PolicyView {
                id: p.id.clone(),
                parent_id: p.parent_id.clone(),
                position: p.position,
                depth: n.depth,
                is_root: p.is_root(),
                name: p.name.clone(),
                matchers: p.matchers.clone(),
                group_by: p.group_by.clone(),
                group_wait_secs: p.group_wait_secs,
                group_interval_secs: p.group_interval_secs,
                repeat_interval_secs: p.repeat_interval_secs,
                continue_matching: p.continue_matching,
                contact_point_ids: p.contact_point_ids.clone(),
                escalations: p.escalations.clone(),
                effective: n.effective.clone(),
                active_groups: active.get(&p.id).copied().unwrap_or(0),
                version: p.version,
                created_by: p.created_by.clone(),
                created_at: p.created_at,
                updated_by: p.updated_by.clone(),
                updated_by_name: names.get(&p.id).cloned(),
                updated_at: p.updated_at,
            }
        })
        .collect())
}

async fn view_of(state: &AppState, org_id: &str, id: &str) -> ApiResult<PolicyView> {
    let tree = load_tree(state, org_id).await?;
    views(state, org_id, &tree).await?.into_iter().find(|v| v.id == id).ok_or_else(ApiError::not_found)
}

pub async fn list(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
) -> ApiResult<Json<Page<PolicyView>>> {
    let tree = load_tree(&state, &ctx.org_id).await?;
    Ok(Json(Page { items: views(&state, &ctx.org_id, &tree).await?, next_cursor: None }))
}

pub async fn detail(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<Json<PolicyView>> {
    known_id(&id)?;
    Ok(Json(view_of(&state, &ctx.org_id, &id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Body {
    /// Required for `POST`, not taken by `PUT` (moving has its own route).
    parent_id: Option<String>,
    name: String,
    #[serde(default)]
    matchers: Vec<Matcher>,
    #[serde(default)]
    group_by: Option<Vec<String>>,
    #[serde(default)]
    group_wait_secs: Option<i64>,
    #[serde(default)]
    group_interval_secs: Option<i64>,
    #[serde(default)]
    repeat_interval_secs: Option<i64>,
    #[serde(default, rename = "continue")]
    continue_matching: bool,
    #[serde(default)]
    contact_point_ids: Vec<String>,
    #[serde(default)]
    escalations: Vec<Escalation>,
    /// Required for `PUT`.
    version: Option<i64>,
}

/// A body that passed every check that needs no database.
struct Clean {
    name: String,
    matchers: Vec<Matcher>,
    group_by: Option<Vec<String>>,
    group_wait_secs: Option<i64>,
    group_interval_secs: Option<i64>,
    repeat_interval_secs: Option<i64>,
    continue_matching: bool,
    contact_point_ids: Vec<String>,
    escalations: Vec<Escalation>,
}

impl Clean {
    /// Every contact point of the policy and its steps.
    fn contact_points(&self) -> BTreeSet<&String> {
        self.contact_point_ids.iter().chain(self.escalations.iter().flat_map(|e| e.contact_point_ids.iter())).collect()
    }
}

fn timing_invalid(message: impl Into<String>, field: &'static str) -> ApiError {
    invalid(field, message, "alerts.policy_timing_invalid")
}

fn dedup(ids: &[String]) -> Vec<String> {
    ids.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect()
}

/// Checks a body. `is_root` for the root, `parent` the effective values of the parent (for the
/// repeat interval's lower bound), `min_interval_secs` the organization's shortest interval.
fn check_body(body: Body, is_root: bool, parent: Option<&Effective>, min_interval_secs: u64) -> ApiResult<Clean> {
    let name = body.name.trim().to_string();
    let chars = name.chars().count();
    if chars == 0 || chars > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(invalid(
            "name",
            format!("name needs 1 to {MAX_NAME_CHARS} characters"),
            "alerts.policy_name_invalid",
        ));
    }
    if is_root && name != store::ROOT_NAME {
        return Err(invalid("name", "the root keeps its name", "alerts.policy_name_invalid"));
    }
    if body.matchers.len() > MAX_MATCHERS || (is_root && !body.matchers.is_empty()) {
        return Err(invalid(
            "matchers",
            format!("a policy has at most {MAX_MATCHERS} matchers, the root none"),
            "alerts.policy_matchers_invalid",
        )
        .param("max", MAX_MATCHERS));
    }
    silences::check_each(&body.matchers, "matchers", "alerts.policy_matchers_invalid").map_err(|e| {
        if e.reason.as_ref().is_some_and(|r| r.code == "alerts.policy_matchers_invalid") {
            e.param("max", MAX_MATCHERS)
        } else {
            e
        }
    })?;
    let group_by = match body.group_by {
        None if is_root => {
            return Err(
                invalid("groupBy", "the root sets groupBy", "alerts.group_by_invalid").param("max", MAX_GROUP_BY)
            );
        }
        None => None,
        Some(list) => {
            let list = dedup(&list);
            let each = list.iter().any(|l| l == EACH_INSTANCE);
            let bad = list.len() > MAX_GROUP_BY
                || (each && list.len() > 1)
                || list.iter().any(|l| l != EACH_INSTANCE && !is_label_name(l));
            if bad {
                return Err(invalid(
                    "groupBy",
                    format!("groupBy is up to {MAX_GROUP_BY} label names, or [\"...\"] alone"),
                    "alerts.group_by_invalid",
                )
                .param("max", MAX_GROUP_BY));
            }
            Some(list)
        }
    };
    if is_root
        && (body.group_wait_secs.is_none() || body.group_interval_secs.is_none() || body.repeat_interval_secs.is_none())
    {
        return Err(timing_invalid("the root sets every time", "groupWaitSecs"));
    }
    if let Some(wait) = body.group_wait_secs
        && !(0..=MAX_GROUP_WAIT_SECS).contains(&wait)
    {
        return Err(timing_invalid(format!("groupWaitSecs is 0 to {MAX_GROUP_WAIT_SECS}"), "groupWaitSecs"));
    }
    let min_interval = MIN_GROUP_INTERVAL_SECS.max(i64::try_from(min_interval_secs).unwrap_or(i64::MAX));
    if let Some(interval) = body.group_interval_secs
        && !(min_interval..=MAX_GROUP_INTERVAL_SECS).contains(&interval)
    {
        return Err(timing_invalid(
            format!("groupIntervalSecs is {min_interval} to {MAX_GROUP_INTERVAL_SECS}"),
            "groupIntervalSecs",
        ));
    }
    let interval = body.group_interval_secs.or(parent.map(|p| p.group_interval_secs)).unwrap_or(min_interval);
    if let Some(repeat) = body.repeat_interval_secs
        && repeat != 0
        && !(interval..=MAX_REPEAT_INTERVAL_SECS).contains(&repeat)
    {
        return Err(timing_invalid(
            format!("repeatIntervalSecs is 0 (off) or the group interval ({interval}) to {MAX_REPEAT_INTERVAL_SECS}"),
            "repeatIntervalSecs",
        ));
    }
    if is_root && body.continue_matching {
        return Err(invalid("continue", "the root has no continue", "alerts.policy_continue_invalid"));
    }
    let contact_point_ids = dedup(&body.contact_point_ids);
    if contact_point_ids.len() > MAX_CONTACT_POINTS {
        return Err(invalid(
            "contactPointIds",
            format!("a policy has at most {MAX_CONTACT_POINTS} contact points"),
            "alerts.policy_contact_points_invalid",
        )
        .param("max", MAX_CONTACT_POINTS));
    }
    let steps_bad =
        |message: String| invalid("escalations", message, "alerts.escalations_invalid").param("max", MAX_ESCALATIONS);
    if body.escalations.len() > MAX_ESCALATIONS {
        return Err(steps_bad(format!("a policy has at most {MAX_ESCALATIONS} escalation steps")));
    }
    let mut escalations = Vec::with_capacity(body.escalations.len());
    let mut previous_wait = 0;
    for (i, step) in body.escalations.into_iter().enumerate() {
        let level = i64::try_from(i).unwrap_or(0) + 1;
        if step.level != level {
            return Err(steps_bad("the steps have the levels 1, 2, 3 in order".into()));
        }
        if !(MIN_ESCALATION_WAIT_SECS..=MAX_ESCALATION_WAIT_SECS).contains(&step.wait_secs)
            || step.wait_secs <= previous_wait
        {
            return Err(steps_bad(format!(
                "a step waits {MIN_ESCALATION_WAIT_SECS} to {MAX_ESCALATION_WAIT_SECS} seconds, longer than the one before"
            )));
        }
        previous_wait = step.wait_secs;
        let ids = dedup(&step.contact_point_ids);
        if ids.is_empty() || ids.len() > MAX_CONTACT_POINTS {
            return Err(steps_bad(format!("a step has 1 to {MAX_CONTACT_POINTS} contact points")));
        }
        escalations.push(Escalation { level, wait_secs: step.wait_secs, contact_point_ids: ids });
    }
    Ok(Clean {
        name,
        matchers: body.matchers,
        group_by,
        group_wait_secs: body.group_wait_secs,
        group_interval_secs: body.group_interval_secs,
        repeat_interval_secs: body.repeat_interval_secs,
        continue_matching: body.continue_matching,
        contact_point_ids,
        escalations,
    })
}

/// The contact points must all be in the organization (an id of another one is not found).
async fn check_contact_points(conn: &mut sqlx::AnyConnection, org_id: &str, clean: &Clean) -> ApiResult<()> {
    for id in clean.contact_points() {
        let found: Option<(String,)> =
            sqlx::query_as("SELECT id FROM alert_contact_points WHERE id = $1 AND org_id = $2")
                .bind(id)
                .bind(org_id)
                .fetch_optional(&mut *conn)
                .await?;
        if found.is_none() {
            return Err(ApiError::not_found().with_field("contactPointIds"));
        }
    }
    Ok(())
}

/// Replaces the policy's contact points and escalation steps.
async fn link(conn: &mut sqlx::AnyConnection, id: &str, clean: &Clean) -> ApiResult<()> {
    sqlx::query("DELETE FROM alert_policy_contact_points WHERE policy_id = $1").bind(id).execute(&mut *conn).await?;
    sqlx::query("DELETE FROM alert_policy_escalations WHERE policy_id = $1").bind(id).execute(&mut *conn).await?;
    let levels = std::iter::once((0, &clean.contact_point_ids))
        .chain(clean.escalations.iter().map(|e| (e.level, &e.contact_point_ids)));
    for (level, ids) in levels {
        for cp in ids {
            sqlx::query(
                "INSERT INTO alert_policy_contact_points (policy_id, level, contact_point_id) VALUES ($1, $2, $3)",
            )
            .bind(id)
            .bind(level)
            .bind(cp)
            .execute(&mut *conn)
            .await?;
        }
    }
    for step in &clean.escalations {
        sqlx::query("INSERT INTO alert_policy_escalations (policy_id, level, wait_secs) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(step.level)
            .bind(step.wait_secs)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

fn summary(id: &str, clean: &Clean) -> Value {
    json!({
        "policyId": id,
        "name": clean.name,
        "matchers": clean.matchers,
        "contactPointIds": clean.contact_point_ids,
        "escalations": clean.escalations,
    })
}

/// The tree's height below `index` (0 for a leaf).
fn height(tree: &Tree, index: usize) -> usize {
    tree.node(index).children.iter().map(|c| 1 + height(tree, *c)).max().unwrap_or(0)
}

fn too_deep(max: u64) -> ApiError {
    conflict(format!("policies go at most {max} levels below the root"))
        .because("alerts.policy_depth")
        .param("max", max)
}

pub async fn create(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    JsonBody(body): JsonBody<Body>,
) -> ApiResult<(StatusCode, Json<PolicyView>)> {
    if body.version.is_some() {
        return Err(invalid("version", "a new policy has no version", "alerts.version_unexpected"));
    }
    let Some(parent_id) = body.parent_id.clone() else {
        return Err(ApiError::not_found().with_field("parentId"));
    };
    known_id(&parent_id).map_err(|e| e.with_field("parentId"))?;
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let tree = load_tree(&state, &ctx.org_id).await?;
    let Some(parent) = tree.find(&parent_id) else { return Err(ApiError::not_found().with_field("parentId")) };
    let clean = check_body(body, false, Some(&tree.node(parent).effective), limits.min_interval_secs)?;
    if tree.node(parent).depth + 1 > usize::try_from(limits.max_policy_depth).unwrap_or(usize::MAX) {
        return Err(too_deep(limits.max_policy_depth));
    }
    let id = crate::routes::new_id();
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM alert_policies WHERE org_id = $1")
        .bind(&ctx.org_id)
        .fetch_one(&mut *tx)
        .await?;
    if u64::try_from(count).unwrap_or(0) >= limits.max_policies_per_org {
        return Err(conflict(format!("this organization has its {} policies", limits.max_policies_per_org))
            .because("alerts.too_many_policies")
            .param("max", limits.max_policies_per_org));
    }
    let parent_found: Option<(String,)> = sqlx::query_as("SELECT id FROM alert_policies WHERE id = $1 AND org_id = $2")
        .bind(&parent_id)
        .bind(&ctx.org_id)
        .fetch_optional(&mut *tx)
        .await?;
    if parent_found.is_none() {
        return Err(ApiError::not_found().with_field("parentId"));
    }
    check_contact_points(&mut tx, &ctx.org_id, &clean).await?;
    name_free(&mut tx, &ctx.org_id, &parent_id, &clean.name, None).await?;
    let (position,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(position) + 1, 0) FROM alert_policies WHERE parent_id = $1")
            .bind(&parent_id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query(
        "INSERT INTO alert_policies (id, org_id, parent_id, position, name, matchers, group_by, group_wait_secs, \
         group_interval_secs, repeat_interval_secs, continue_matching, version, created_by, created_at, updated_by, \
         updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, $12, $13, $12, $13)",
    )
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(&parent_id)
    .bind(position)
    .bind(&clean.name)
    .bind(serde_json::to_string(&clean.matchers).expect("matchers always serialize"))
    .bind(clean.group_by.as_ref().map(|g| serde_json::to_string(g).expect("labels always serialize")))
    .bind(clean.group_wait_secs)
    .bind(clean.group_interval_secs)
    .bind(clean.repeat_interval_secs)
    .bind(i64::from(clean.continue_matching))
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    link(&mut tx, &id, &clean).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let mut summary = summary(&id, &clean);
    summary["parentId"] = json!(parent_id);
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_policy.created", ("alert_policy", &id), summary).await?;
    crate::db::commit(tx).await?;
    Ok((StatusCode::CREATED, Json(view_of(&state, &ctx.org_id, &id).await?)))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<Body>,
) -> ApiResult<Json<PolicyView>> {
    known_id(&id)?;
    let Some(expected) = body.version else {
        return Err(invalid("version", "version is the version the change is based on", "alerts.version_required"));
    };
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let tree = load_tree(&state, &ctx.org_id).await?;
    let Some(index) = tree.find(&id) else { return Err(ApiError::not_found()) };
    let node = tree.node(index);
    if body.parent_id.as_ref().is_some_and(|p| node.policy.parent_id.as_ref() != Some(p)) {
        return Err(invalid("parentId", "moving a policy has its own route", "alerts.policy_move_invalid"));
    }
    let parent = node.parent.map(|p| tree.node(p).effective.clone());
    let clean = check_body(body, node.policy.is_root(), parent.as_ref(), limits.min_interval_secs)?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    check_contact_points(&mut tx, &ctx.org_id, &clean).await?;
    if let Some(parent) = &node.policy.parent_id {
        name_free(&mut tx, &ctx.org_id, parent, &clean.name, Some(&id)).await?;
    }
    let changed = sqlx::query(
        "UPDATE alert_policies SET name = $1, matchers = $2, group_by = $3, group_wait_secs = $4, \
         group_interval_secs = $5, repeat_interval_secs = $6, continue_matching = $7, version = version + 1, \
         updated_by = $8, updated_at = $9 WHERE id = $10 AND org_id = $11 AND version = $12",
    )
    .bind(&clean.name)
    .bind(serde_json::to_string(&clean.matchers).expect("matchers always serialize"))
    .bind(clean.group_by.as_ref().map(|g| serde_json::to_string(g).expect("labels always serialize")))
    .bind(clean.group_wait_secs)
    .bind(clean.group_interval_secs)
    .bind(clean.repeat_interval_secs)
    .bind(i64::from(clean.continue_matching))
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&id)
    .bind(&ctx.org_id)
    .bind(expected)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed == 0 {
        drop(tx);
        let current = view_of(&state, &ctx.org_id, &id).await?;
        return Err(ApiError::version_conflict(serde_json::to_value(current).unwrap_or_default()));
    }
    link(&mut tx, &id, &clean).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_policy.updated", ("alert_policy", &id), summary(&id, &clean))
        .await?;
    crate::db::commit(tx).await?;
    Ok(Json(view_of(&state, &ctx.org_id, &id).await?))
}

/// Deletes a policy with the policies below it; its groups go with it, their instances take their new way
/// at the next evaluation.
pub async fn delete(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    known_id(&id)?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let tree = Tree::new(&ctx.org_id, store::load(&mut tx, &ctx.org_id).await?);
    let Some(index) = tree.find(&id) else { return Err(ApiError::not_found()) };
    let node = tree.node(index);
    if node.policy.is_root() {
        return Err(conflict("the root cannot be deleted").because("alerts.policy_root"));
    }
    // The policies below go with it. What their groups sent is owed as a resolve to the contact
    // points that had it; the next evaluation of each rule sends it to those its instances do not
    // reach on their new way (`evaluate::owed_elsewhere`).
    let subtree = tree.subtree(index);
    for policy in &subtree {
        let gone = tree.node(*policy);
        let groups: Vec<(String, i64)> =
            sqlx::query_as("SELECT id, escalation_level FROM alert_groups WHERE policy_id = $1 ORDER BY id")
                .bind(&gone.policy.id)
                .fetch_all(&mut *tx)
                .await?;
        for (group_id, level) in groups {
            let mut had: BTreeSet<String> = gone.effective.contact_point_ids.iter().cloned().collect();
            for step in gone.policy.escalations.iter().filter(|s| s.level <= level) {
                had.extend(step.contact_point_ids.iter().cloned());
            }
            let sent: Vec<SentRow> = sqlx::query_as(
                "SELECT rule_id, fingerprint, labels, sent_state, sent_state_since FROM alert_group_pending \
                 WHERE group_id = $1 ORDER BY rule_id, fingerprint",
            )
            .bind(&group_id)
            .fetch_all(&mut *tx)
            .await?;
            for (rule_id, fingerprint, labels, sent_state, since) in sent {
                if let (Some(s), Some(since)) = (sent_state, since)
                    && s != "ok"
                {
                    crate::alerting::evaluate::owe_elsewhere(
                        &mut tx,
                        &rule_id,
                        &ctx.org_id,
                        &fingerprint,
                        &labels,
                        since,
                        &had,
                        now,
                    )
                    .await?;
                }
            }
        }
    }
    let names: Vec<&str> = subtree.iter().map(|i| tree.node(*i).policy.name.as_str()).collect();
    // Deepest first, so no row is left without its parent.
    for policy in subtree.iter().rev() {
        sqlx::query("DELETE FROM alert_policies WHERE id = $1")
            .bind(&tree.node(*policy).policy.id)
            .execute(&mut *tx)
            .await?;
    }
    // The siblings close up.
    close_up(&mut tx, node.policy.parent_id.as_deref().unwrap_or_default()).await?;
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({
        "policyId": id,
        "name": node.policy.name,
        "matchers": node.policy.matchers,
        "contactPointIds": node.policy.contact_point_ids,
        "deletedBelow": names.len() - 1,
        "names": names,
    });
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_policy.deleted", ("alert_policy", &id), summary).await?;
    crate::db::commit(tx).await?;
    Ok(StatusCode::NO_CONTENT)
}

// Numbers the children of `parent_id` 0, 1, 2, ... in their order.
async fn close_up(conn: &mut sqlx::AnyConnection, parent_id: &str) -> ApiResult<()> {
    let ids: Vec<(String,)> =
        sqlx::query_as("SELECT id FROM alert_policies WHERE parent_id = $1 ORDER BY position, id")
            .bind(parent_id)
            .fetch_all(&mut *conn)
            .await?;
    for (i, (id,)) in ids.into_iter().enumerate() {
        sqlx::query("UPDATE alert_policies SET position = $1 WHERE id = $2")
            .bind(i64::try_from(i).unwrap_or(0))
            .bind(&id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveBody {
    parent_id: String,
    position: i64,
}

/// Moves a policy (with everything below it) to another place in the tree, at once.
pub async fn move_policy(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    Extension(info): Extension<RequestInfo>,
    Path((_, id)): Path<(String, String)>,
    JsonBody(body): JsonBody<MoveBody>,
) -> ApiResult<Json<Page<PolicyView>>> {
    known_id(&id)?;
    known_id(&body.parent_id).map_err(|e| e.with_field("parentId"))?;
    let limits = limits::for_org(&state, &ctx.org_id).await?;
    let now = state.clock.now_ms();
    let mut tx = crate::db::begin(&state.db).await?;
    lock_org(&mut tx, &ctx.org_id).await?;
    let tree = Tree::new(&ctx.org_id, store::load(&mut tx, &ctx.org_id).await?);
    let Some(index) = tree.find(&id) else { return Err(ApiError::not_found()) };
    let node = tree.node(index);
    if node.policy.is_root() {
        return Err(conflict("the root cannot be moved").because("alerts.policy_root"));
    }
    let Some(target) = tree.find(&body.parent_id) else { return Err(ApiError::not_found().with_field("parentId")) };
    if tree.subtree(index).contains(&target) {
        return Err(invalid("parentId", "a policy cannot move below itself", "alerts.policy_move_invalid"));
    }
    let depth = tree.node(target).depth + 1 + height(&tree, index);
    if depth > usize::try_from(limits.max_policy_depth).unwrap_or(usize::MAX) {
        return Err(too_deep(limits.max_policy_depth));
    }
    name_free(&mut tx, &ctx.org_id, &body.parent_id, &node.policy.name, Some(&id)).await?;
    let old_parent = node.policy.parent_id.clone().unwrap_or_default();
    let old_position = node.policy.position;
    let mut siblings: Vec<String> =
        tree.node(target).children.iter().map(|c| tree.node(*c).policy.id.clone()).filter(|s| *s != id).collect();
    let at = usize::try_from(body.position.max(0)).unwrap_or(usize::MAX).min(siblings.len());
    siblings.insert(at, id.clone());
    sqlx::query(
        "UPDATE alert_policies SET parent_id = $1, version = version + 1, updated_by = $2, updated_at = $3 WHERE id = $4",
    )
    .bind(&body.parent_id)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    for (i, sibling) in siblings.iter().enumerate() {
        sqlx::query("UPDATE alert_policies SET position = $1 WHERE id = $2")
            .bind(i64::try_from(i).unwrap_or(0))
            .bind(sibling)
            .execute(&mut *tx)
            .await?;
    }
    if old_parent != body.parent_id {
        close_up(&mut tx, &old_parent).await?;
    }
    let actor = Actor { user_id: &ctx.user.id, info: &info, at_ms: now };
    let summary = json!({
        "policyId": id,
        "name": node.policy.name,
        "from": { "parentId": old_parent, "position": old_position },
        "to": { "parentId": body.parent_id, "position": at },
    });
    audit(&mut tx, &actor, Some(&ctx.org_id), "alert_policy.moved", ("alert_policy", &id), summary).await?;
    crate::db::commit(tx).await?;
    let tree = load_tree(&state, &ctx.org_id).await?;
    Ok(Json(Page { items: views(&state, &ctx.org_id, &tree).await?, next_cursor: None }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RouteBody {
    labels: Option<Vec<BTreeMap<String, String>>>,
    rule_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteView {
    policy_id: String,
    path: Vec<PathStep>,
    contact_point_ids: Vec<String>,
    group_by: Vec<String>,
    group_labels: BTreeMap<String, String>,
    group_wait_secs: i64,
    group_interval_secs: i64,
    repeat_interval_secs: i64,
    escalations: Vec<Escalation>,
    delivers: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteItem {
    labels: BTreeMap<String, String>,
    /// With `ruleId`, when the caller may neither read nor query the rule's source: `labels` and
    /// the group labels hold the rule's own labels and `alertname` only, never the instance's.
    data_hidden: bool,
    fingerprint: Option<String>,
    routes: Vec<RouteView>,
}

#[derive(Serialize)]
pub struct Routed {
    items: Vec<RouteItem>,
}

fn route_views(tree: &Tree, labels: &BTreeMap<String, String>) -> Vec<RouteView> {
    tree.routes(labels)
        .into_iter()
        .map(|index| {
            let node = tree.node(index);
            let (_, group_labels) = group_of(&node.policy.id, &node.effective.group_by, labels);
            RouteView {
                policy_id: node.policy.id.clone(),
                path: path_of(tree, index),
                contact_point_ids: node.effective.contact_point_ids.clone(),
                group_by: node.effective.group_by.clone(),
                group_labels,
                group_wait_secs: node.effective.group_wait_secs,
                group_interval_secs: node.effective.group_interval_secs,
                repeat_interval_secs: node.effective.repeat_interval_secs,
                escalations: node.policy.escalations.clone(),
                delivers: node.effective.delivers,
            }
        })
        .collect()
}

/// "Weg prüfen": the ways label sets, or a stored rule's instances, take through the tree now.
pub async fn route(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    JsonBody(body): JsonBody<RouteBody>,
) -> ApiResult<Json<Routed>> {
    let bad = || {
        invalid(
            "labels",
            format!("a route check takes 1 to {MAX_ROUTE_LABEL_SETS} label sets or a ruleId"),
            "alerts.route_labels_invalid",
        )
    };
    let tree = load_tree(&state, &ctx.org_id).await?;
    let items = match (body.labels, body.rule_id) {
        (Some(sets), None) if !sets.is_empty() && sets.len() <= MAX_ROUTE_LABEL_SETS => sets
            .into_iter()
            .map(|labels| RouteItem {
                routes: route_views(&tree, &labels),
                labels,
                data_hidden: false,
                fingerprint: None,
            })
            .collect(),
        (None, Some(rule_id)) => {
            known_id(&rule_id).map_err(|e| e.with_field("ruleId"))?;
            let rule: Option<(String, String, String)> =
                sqlx::query_as("SELECT name, labels, datasource_id FROM alert_rules WHERE id = $1 AND org_id = $2")
                    .bind(&rule_id)
                    .bind(&ctx.org_id)
                    .fetch_optional(&state.db)
                    .await?;
            let Some((name, rule_labels, datasource_id)) = rule else {
                return Err(ApiError::not_found().with_field("ruleId"));
            };
            let access = DatasourceAccess::load(&state.db, &ctx).await?;
            let hidden = !data_visible(&access, &datasource_id);
            let shown = alert_labels(&BTreeMap::new(), &rule_labels, &name);
            let instances: Vec<(String, String)> = sqlx::query_as(
                "SELECT fingerprint, labels FROM alert_instances WHERE rule_id = $1 ORDER BY fingerprint",
            )
            .bind(&rule_id)
            .fetch_all(&state.db)
            .await?;
            let sets: Vec<(Option<String>, BTreeMap<String, String>)> = if instances.is_empty() {
                vec![(None, BTreeMap::new())]
            } else {
                instances.into_iter().map(|(f, l)| (Some(f), serde_json::from_str(&l).unwrap_or_default())).collect()
            };
            sets.into_iter()
                .enumerate()
                .map(|(index, (fingerprint, labels))| {
                    if !hidden {
                        let labels = alert_labels(&labels, &rule_labels, &name);
                        let routes = route_views(&tree, &labels);
                        return RouteItem { routes, labels, data_hidden: false, fingerprint };
                    }
                    // What the data says stays hidden: the way is that of the rule's own labels
                    // and `alertname`, so no policy's matchers tell anything about the instance's.
                    let routes = route_views(&tree, &shown);
                    // The fingerprint is a hash of the hidden labels: an id of this answer instead.
                    let fingerprint = fingerprint.map(|_| super::hidden_fingerprint(index));
                    RouteItem { routes, labels: shown.clone(), data_hidden: true, fingerprint }
                })
                .collect()
        }
        _ => return Err(bad()),
    };
    Ok(Json(Routed { items }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupsQuery {
    policy_id: Option<String>,
}

/// The organization's active groups (of one policy).
pub async fn list_groups(
    State(state): State<AppState>,
    Extension(ctx): Extension<OrgCtx>,
    QueryParams(q): QueryParams<GroupsQuery>,
) -> ApiResult<Json<Page<GroupView>>> {
    if let Some(p) = &q.policy_id {
        known_id(p)?;
    }
    // A group's labels come from its instances: shown only to people who may read or query the
    // sources of all its rules.
    let access = DatasourceAccess::load(&state.db, &ctx).await?;
    let sources: Vec<(String, String)> = sqlx::query_as("SELECT id, datasource_id FROM alert_rules WHERE org_id = $1")
        .bind(&ctx.org_id)
        .fetch_all(&state.db)
        .await?;
    let visible: HashSet<String> =
        sources.into_iter().filter(|(_, ds)| data_visible(&access, ds)).map(|(id, _)| id).collect();
    let items = groups::views(&state, &ctx.org_id, q.policy_id.as_deref(), &visible).await?;
    Ok(Json(Page { items, next_cursor: None }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(value: Value) -> Body {
        serde_json::from_value(value).unwrap()
    }

    fn reason(e: ApiError) -> String {
        e.reason.map(|r| r.code).unwrap_or_default()
    }

    #[test]
    fn bodies_are_checked() {
        let ok = json!({ "name": "Lager", "matchers": [{ "label": "team", "op": "=", "value": "lager" }] });
        assert!(check_body(body(ok.clone()), false, None, 30).is_ok());
        let cases = [
            (json!({ "name": " " }), false, "alerts.policy_name_invalid"),
            (
                json!({ "name": "Wurzel", "groupBy": ["alertname"], "groupWaitSecs": 30, "groupIntervalSecs": 300,
                     "repeatIntervalSecs": 0 }),
                true,
                "alerts.policy_name_invalid",
            ),
            (
                json!({ "name": "Standard", "groupWaitSecs": 30, "groupIntervalSecs": 300, "repeatIntervalSecs": 0 }),
                true,
                "alerts.group_by_invalid",
            ),
            (json!({ "name": "Standard", "groupBy": [] }), true, "alerts.policy_timing_invalid"),
            (
                json!({ "name": "Standard", "groupBy": [], "groupWaitSecs": 30, "groupIntervalSecs": 300,
                     "repeatIntervalSecs": 0, "continue": true }),
                true,
                "alerts.policy_continue_invalid",
            ),
            (
                json!({ "name": "Standard", "groupBy": [], "groupWaitSecs": 30, "groupIntervalSecs": 300,
                     "repeatIntervalSecs": 0, "matchers": [{ "label": "a", "op": "=", "value": "b" }] }),
                true,
                "alerts.policy_matchers_invalid",
            ),
            (json!({ "name": "x", "groupBy": ["...", "team"] }), false, "alerts.group_by_invalid"),
            (json!({ "name": "x", "groupBy": ["te am"] }), false, "alerts.group_by_invalid"),
            (json!({ "name": "x", "groupWaitSecs": 3601 }), false, "alerts.policy_timing_invalid"),
            (json!({ "name": "x", "groupIntervalSecs": 10 }), false, "alerts.policy_timing_invalid"),
            (
                json!({ "name": "x", "groupIntervalSecs": 600, "repeatIntervalSecs": 300 }),
                false,
                "alerts.policy_timing_invalid",
            ),
            (
                json!({ "name": "x", "matchers": [{ "label": "a", "op": "!~", "value": "(" }] }),
                false,
                "alerts.matcher_regex_invalid",
            ),
            (
                json!({ "name": "x", "contactPointIds": ["1", "2", "3", "4", "5", "6"] }),
                false,
                "alerts.policy_contact_points_invalid",
            ),
            (
                json!({ "name": "x", "escalations": [{ "level": 2, "waitSecs": 900, "contactPointIds": ["a"] }] }),
                false,
                "alerts.escalations_invalid",
            ),
            (
                json!({ "name": "x", "escalations": [{ "level": 1, "waitSecs": 60, "contactPointIds": ["a"] }] }),
                false,
                "alerts.escalations_invalid",
            ),
            (
                json!({ "name": "x", "escalations": [
                { "level": 1, "waitSecs": 900, "contactPointIds": ["a"] },
                { "level": 2, "waitSecs": 900, "contactPointIds": ["a"] }] }),
                false,
                "alerts.escalations_invalid",
            ),
            (
                json!({ "name": "x", "escalations": [{ "level": 1, "waitSecs": 900, "contactPointIds": [] }] }),
                false,
                "alerts.escalations_invalid",
            ),
        ];
        for (value, root, expected) in cases {
            let got = check_body(body(value.clone()), root, None, 30).err().map(reason);
            assert_eq!(got.as_deref(), Some(expected), "{value}");
        }
        // A min interval above 30 seconds raises the group interval's lower bound.
        assert!(check_body(body(json!({ "name": "x", "groupIntervalSecs": 60 })), false, None, 120).is_err());
        // The repeat interval is checked against the inherited group interval.
        let parent = Effective {
            group_by: vec![],
            group_wait_secs: 30,
            group_interval_secs: 900,
            repeat_interval_secs: 3600,
            contact_point_ids: vec![],
            contact_points_from: None,
            delivers: false,
        };
        assert!(check_body(body(json!({ "name": "x", "repeatIntervalSecs": 600 })), false, Some(&parent), 30).is_err());
        assert!(check_body(body(json!({ "name": "x", "repeatIntervalSecs": 0 })), false, Some(&parent), 30).is_ok());
    }
}
