//! `/Groups` (RFC 7643, section 4.2): the groups of the organization's directory. A group gives
//! nothing by itself; the group mapping turns its `displayName` or `externalId` into a role and
//! teams in this organization, and every change of a group's name or members applies the mapping
//! to the people concerned at once. Members are SCIM users of this organization; a DELETE
//! deactivates the group, which then stops counting.

use std::collections::BTreeSet;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::patch::{AttrPath, Op, OpKind, operations, values};
use super::provision;
use super::schema::GROUP_SCHEMA;
use super::{Ctx, ListQuery, ScimError, ScimResult, date_time, field, filter, list_response, scim_json, text};

const MAX_TEXT: usize = 256;
/// At most this many members in one group.
const MAX_MEMBERS: usize = 50_000;
/// At most this many members named in one request (all operations of a PATCH together).
pub const MAX_MEMBERS_PER_REQUEST: usize = 10_000;
/// Member ids checked per query.
const CHUNK: usize = 500;

fn too_many(detail: String) -> ScimError {
    ScimError::bad("tooMany", detail).because("scim.too_many")
}

/// Refuses a request that names more than `MAX_MEMBERS_PER_REQUEST` members.
fn ensure_request_size(named: usize) -> ScimResult<()> {
    if named > MAX_MEMBERS_PER_REQUEST {
        return Err(too_many(format!("a request names at most {MAX_MEMBERS_PER_REQUEST} members")));
    }
    Ok(())
}

/// The members a PATCH names, over all its operations.
fn members_named(ops: &[Op]) -> usize {
    ops.iter()
        .map(|op| {
            let value = match &op.path {
                Some(path) if path.attr == "members" => op.value.as_ref(),
                Some(_) => None,
                None => op.value.as_ref().and_then(|v| field(v, "members")),
            };
            value.map_or(0, |v| values(v).len())
        })
        .sum()
}

#[derive(Clone, Debug, Default, PartialEq)]
struct GroupData {
    display_name: String,
    external_id: Option<String>,
    /// Member ids (SCIM user ids), in the order they came, without repeats.
    members: Vec<String>,
}

fn invalid(detail: impl Into<String>) -> ScimError {
    ScimError::bad("invalidValue", detail).because("scim.value_invalid")
}

fn display_name(value: &Value) -> ScimResult<String> {
    text(value, "displayName", MAX_TEXT)?
        .ok_or_else(|| ScimError::bad("invalidValue", "displayName is required").because("scim.group_name_missing"))
}

/// The member ids in an add, remove or replace value: `[{ "value": "..." }]` or a single one.
fn member_ids(value: &Value) -> ScimResult<Vec<String>> {
    let mut out = Vec::new();
    for item in values(value) {
        let id = match item {
            Value::Object(_) => field(item, "value").map(|v| text(v, "members.value", MAX_TEXT)).transpose()?.flatten(),
            Value::String(_) => text(item, "members.value", MAX_TEXT)?,
            _ => return Err(invalid("a member is an object with a value")),
        };
        if let Some(id) = id
            && !out.contains(&id)
        {
            out.push(id);
        }
    }
    Ok(out)
}

impl GroupData {
    fn from_json(body: &Value) -> ScimResult<Self> {
        let display_name = display_name(field(body, "displayName").ok_or_else(|| {
            ScimError::bad("invalidValue", "displayName is required").because("scim.group_name_missing")
        })?)?;
        let external_id = field(body, "externalId").map(|v| text(v, "externalId", MAX_TEXT)).transpose()?.flatten();
        let members = match field(body, "members").filter(|v| !v.is_null()) {
            Some(m) => {
                ensure_request_size(values(m).len())?;
                member_ids(m)?
            }
            None => Vec::new(),
        };
        Ok(Self { display_name, external_id, members })
    }

    fn add_members(&mut self, ids: Vec<String>) {
        for id in ids {
            if !self.members.contains(&id) {
                self.members.push(id);
            }
        }
    }

    fn apply(&mut self, op: &Op) -> ScimResult<()> {
        match &op.path {
            Some(path) => self.apply_path(op.kind, path, op.value.as_ref()),
            None => {
                let object = op
                    .value
                    .as_ref()
                    .and_then(Value::as_object)
                    .ok_or_else(|| invalid("an operation without a path needs an object of attributes"))?;
                for (key, value) in object {
                    self.apply_path(op.kind, &AttrPath::of(key)?, Some(value))?;
                }
                Ok(())
            }
        }
    }

    fn apply_path(&mut self, kind: OpKind, path: &AttrPath, value: Option<&Value>) -> ScimResult<()> {
        let given = || value.ok_or_else(|| invalid("the operation needs a value"));
        match path.attr.as_str() {
            "displayname" => {
                if kind == OpKind::Remove {
                    return Err(
                        ScimError::bad("mutability", "displayName is required").because("scim.group_name_missing")
                    );
                }
                self.display_name = display_name(given()?)?;
            }
            "externalid" => {
                self.external_id = if kind == OpKind::Remove { None } else { text(given()?, "externalId", MAX_TEXT)? };
            }
            "members" => match (kind, &path.filter) {
                // Okta: `members[value eq "id"]`.
                (OpKind::Remove, Some((attr, wanted))) if attr == "value" => self.members.retain(|m| m != wanted),
                (_, Some(_)) => {
                    return Err(
                        ScimError::bad("invalidPath", "members are named by value").because("scim.path_invalid")
                    );
                }
                // Entra: `remove` with the members as its value; without one, all of them.
                (OpKind::Remove, None) => match value {
                    Some(v) => {
                        let gone = member_ids(v)?;
                        self.members.retain(|m| !gone.contains(m));
                    }
                    None => self.members.clear(),
                },
                (OpKind::Add, None) => self.add_members(member_ids(given()?)?),
                (OpKind::Replace, None) => self.members = member_ids(given()?)?,
            },
            // `id`, `schemas` and `meta` in an Okta object, and attributes Kalzit does not keep.
            _ => {}
        }
        Ok(())
    }
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    display_name: String,
    external_id: Option<String>,
    version: i64,
    created_at: i64,
    updated_at: i64,
}

/// `$1` is the organization; deactivated groups are gone for SCIM.
const COLUMNS: &str = "SELECT g.id, g.display_name, g.external_id, g.version, g.created_at, g.updated_at \
     FROM scim_groups g WHERE g.org_id = $1 AND g.deactivated_at IS NULL";

async fn load(conn: &mut sqlx::AnyConnection, org_id: &str, id: &str) -> ScimResult<Row> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLUMNS} AND g.id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(ScimError::not_found)
}

/// The members of a group: id and account name, in the order of their ids.
async fn members_of(conn: &mut sqlx::AnyConnection, group_id: &str) -> ScimResult<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT m.user_id, u.name FROM scim_group_members m JOIN users u ON u.id = m.user_id \
         WHERE m.group_id = $1 ORDER BY m.user_id",
    )
    .bind(group_id)
    .fetch_all(&mut *conn)
    .await?)
}

fn resource(ctx: &Ctx<'_>, row: &Row, members: Option<&[(String, String)]>) -> Value {
    let mut out = json!({
        "schemas": [GROUP_SCHEMA],
        "id": row.id,
        "displayName": row.display_name,
        "meta": {
            "resourceType": "Group",
            "created": date_time(row.created_at),
            "lastModified": date_time(row.updated_at),
            "location": ctx.location("Groups", &row.id),
            "version": format!("W/\"{}\"", row.version),
        },
    });
    if let Some(e) = &row.external_id {
        out["externalId"] = json!(e);
    }
    if let Some(members) = members {
        out["members"] = json!(
            members
                .iter()
                .map(|(id, name)| json!({ "value": id, "display": name, "$ref": ctx.location("Users", id) }))
                .collect::<Vec<_>>()
        );
    }
    out
}

async fn answer(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, id: &str, with_members: bool) -> ScimResult<Value> {
    let row = load(&mut *conn, ctx.org_id, id).await?;
    let members = if with_members { Some(members_of(&mut *conn, id).await?) } else { None };
    Ok(resource(ctx, &row, members.as_deref()))
}

pub async fn list(ctx: &Ctx<'_>, query: &ListQuery) -> ScimResult<Response> {
    let paging = query.paging()?;
    let mut sql = String::new();
    let mut args: Vec<String> = vec![ctx.org_id.to_string()];
    if let Some(raw) = query.filter.as_deref().filter(|f| !f.trim().is_empty()) {
        for eq in filter::parse(raw)? {
            let n = args.len() + 1;
            match eq.attr.as_str() {
                "displayname" => {
                    sql.push_str(&format!(" AND g.display_name_key = ${n}"));
                    args.push(eq.text().to_lowercase());
                }
                "externalid" => {
                    sql.push_str(&format!(" AND g.external_id = ${n}"));
                    args.push(eq.text());
                }
                "id" => {
                    sql.push_str(&format!(" AND g.id = ${n}"));
                    args.push(eq.text());
                }
                other => {
                    return Err(ScimError::bad("invalidFilter", format!("groups cannot be filtered by {other}"))
                        .because("scim.filter_unsupported"));
                }
            }
        }
    }
    let mut conn = ctx.state.read_db.acquire().await?;
    let count_sql = format!("SELECT COUNT(*) FROM scim_groups g WHERE g.org_id = $1 AND g.deactivated_at IS NULL{sql}");
    let mut count = sqlx::query_as::<_, (i64,)>(sqlx::AssertSqlSafe(count_sql));
    for a in &args {
        count = count.bind(a.clone());
    }
    let (total,) = count.fetch_one(&mut *conn).await?;
    let mut resources = Vec::new();
    if paging.count > 0 {
        let n = args.len() + 1;
        let page_sql = format!("{COLUMNS}{sql} ORDER BY g.created_at, g.id LIMIT ${n} OFFSET ${}", n + 1);
        let mut page = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(page_sql));
        for a in &args {
            page = page.bind(a.clone());
        }
        let rows = page.bind(paging.count).bind(paging.start_index - 1).fetch_all(&mut *conn).await?;
        // Entra asks with `excludedAttributes=members`; a list without it carries them.
        let with_members = !query.excludes("members");
        for row in &rows {
            let members = if with_members { Some(members_of(&mut conn, &row.id).await?) } else { None };
            resources.push(resource(ctx, row, members.as_deref()));
        }
    }
    Ok(list_response(total, &paging, resources))
}

pub async fn get(ctx: &Ctx<'_>, id: &str, query: &ListQuery) -> ScimResult<Response> {
    let mut conn = ctx.state.read_db.acquire().await?;
    Ok(scim_json(StatusCode::OK, &answer(&mut conn, ctx, id, !query.excludes("members")).await?))
}

fn group_name_taken() -> ScimError {
    ScimError::taken("another group of this organization has this displayName").because("scim.group_name_taken")
}

async fn ensure_name_free(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    name: &str,
    except: Option<&str>,
) -> ScimResult<()> {
    let taken: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM scim_groups WHERE org_id = $1 AND display_name_key = $2 AND deactivated_at IS NULL",
    )
    .bind(org_id)
    .bind(name.to_lowercase())
    .fetch_optional(&mut *conn)
    .await?;
    match taken {
        Some((id,)) if Some(id.as_str()) != except => Err(group_name_taken()),
        _ => Ok(()),
    }
}

/// Refuses member ids that are not SCIM users of this organization: SCIM never adds anyone else
/// (service accounts, people of other organizations) to a group.
async fn ensure_members_known(conn: &mut sqlx::AnyConnection, org_id: &str, ids: &[String]) -> ScimResult<()> {
    if ids.len() > MAX_MEMBERS {
        return Err(too_many(format!("a group has at most {MAX_MEMBERS} members")));
    }
    for chunk in ids.chunks(CHUNK) {
        let marks: Vec<String> = (0..chunk.len()).map(|i| format!("${}", i + 2)).collect();
        let sql = format!(
            "SELECT s.user_id FROM scim_users s JOIN users u ON u.id = s.user_id \
             WHERE s.org_id = $1 AND u.service_account = 0 AND s.user_id IN ({})",
            marks.join(", ")
        );
        let mut query = sqlx::query_as::<_, (String,)>(sqlx::AssertSqlSafe(sql)).bind(org_id);
        for id in chunk {
            query = query.bind(id);
        }
        let known: BTreeSet<String> = query.fetch_all(&mut *conn).await?.into_iter().map(|(id,)| id).collect();
        if let Some(id) = chunk.iter().find(|id| !known.contains(*id)) {
            return Err(ScimError::bad("invalidValue", format!("{id} is not a user of this organization's directory"))
                .because("scim.member_unknown"));
        }
    }
    Ok(())
}

/// Writes the member list of a group and answers the people whose groups changed.
async fn write_members(conn: &mut sqlx::AnyConnection, group_id: &str, members: &[String]) -> ScimResult<Vec<String>> {
    let before: Vec<(String,)> = sqlx::query_as("SELECT user_id FROM scim_group_members WHERE group_id = $1")
        .bind(group_id)
        .fetch_all(&mut *conn)
        .await?;
    let before: BTreeSet<String> = before.into_iter().map(|(id,)| id).collect();
    let after: BTreeSet<String> = members.iter().cloned().collect();
    for gone in before.difference(&after) {
        sqlx::query("DELETE FROM scim_group_members WHERE group_id = $1 AND user_id = $2")
            .bind(group_id)
            .bind(gone)
            .execute(&mut *conn)
            .await?;
    }
    for new in after.difference(&before) {
        sqlx::query("INSERT INTO scim_group_members (group_id, user_id) VALUES ($1, $2)")
            .bind(group_id)
            .bind(new)
            .execute(&mut *conn)
            .await?;
    }
    Ok(before.symmetric_difference(&after).cloned().collect())
}

/// Applies the group mapping to `people` and answers the organizations whose rights changed.
async fn sync_all(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, people: &[String]) -> ScimResult<BTreeSet<String>> {
    let mut touched = BTreeSet::new();
    for user_id in people {
        touched.extend(provision::sync(&mut *conn, ctx, user_id).await?);
    }
    Ok(touched)
}

pub async fn create(ctx: &Ctx<'_>, body: Value) -> ScimResult<Response> {
    let data = GroupData::from_json(&body)?;
    let now = ctx.state.clock.now_ms();
    let mut tx = crate::db::begin(&ctx.state.db).await?;
    crate::authz::lock_org(&mut tx, ctx.org_id).await?;
    ensure_name_free(&mut tx, ctx.org_id, &data.display_name, None).await?;
    ensure_members_known(&mut tx, ctx.org_id, &data.members).await?;
    let id = crate::routes::new_id();
    sqlx::query(
        "INSERT INTO scim_groups (id, org_id, display_name, display_name_key, external_id, version, created_at, \
         updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)",
    )
    .bind(&id)
    .bind(ctx.org_id)
    .bind(&data.display_name)
    .bind(data.display_name.to_lowercase())
    .bind(data.external_id.as_deref())
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let changed = write_members(&mut tx, &id, &data.members).await?;
    let summary = json!({ "groupId": id, "displayName": data.display_name, "members": data.members.len() });
    super::audit(&mut tx, ctx, "scim.group_created", ("scim_group", &id), summary).await?;
    let touched = sync_all(&mut tx, ctx, &changed).await?;
    let body = answer(&mut tx, ctx, &id, true).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(ctx.state, &touched).await;
    let mut res = scim_json(StatusCode::CREATED, &body);
    if let Ok(v) = HeaderValue::from_str(&ctx.location("Groups", &id)) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    Ok(res)
}

pub async fn replace(ctx: &Ctx<'_>, id: &str, body: Value) -> ScimResult<Response> {
    let new = GroupData::from_json(&body)?;
    let body = save(ctx, id, |_| Ok(new)).await?;
    Ok(scim_json(StatusCode::OK, &body))
}

/// Answers the group as it is after the operations (RFC 7644 allows `200` with it or `204`).
pub async fn patch(ctx: &Ctx<'_>, id: &str, body: Value) -> ScimResult<Response> {
    let ops = operations(&body)?;
    ensure_request_size(members_named(&ops))?;
    let body = save(ctx, id, |current| {
        let mut next = current.clone();
        for op in &ops {
            next.apply(op)?;
        }
        Ok(next)
    })
    .await?;
    Ok(scim_json(StatusCode::OK, &body))
}

/// A DELETE deactivates the group: it disappears from SCIM and stops counting for the mapping.
pub async fn delete(ctx: &Ctx<'_>, id: &str) -> ScimResult<Response> {
    let now = ctx.state.clock.now_ms();
    let mut tx = crate::db::begin(&ctx.state.db).await?;
    crate::authz::lock_org(&mut tx, ctx.org_id).await?;
    let row = load(&mut tx, ctx.org_id, id).await?;
    sqlx::query("UPDATE scim_groups SET deactivated_at = $1, updated_at = $2 WHERE id = $3")
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let people: Vec<String> = members_of(&mut tx, id).await?.into_iter().map(|(id, _)| id).collect();
    let summary = json!({ "groupId": id, "displayName": row.display_name, "members": people.len() });
    super::audit(&mut tx, ctx, "scim.group_deactivated", ("scim_group", id), summary).await?;
    let touched = sync_all(&mut tx, ctx, &people).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(ctx.state, &touched).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn save(ctx: &Ctx<'_>, id: &str, change: impl FnOnce(&GroupData) -> ScimResult<GroupData>) -> ScimResult<Value> {
    let now = ctx.state.clock.now_ms();
    let mut tx = crate::db::begin(&ctx.state.db).await?;
    crate::authz::lock_org(&mut tx, ctx.org_id).await?;
    let row = load(&mut tx, ctx.org_id, id).await?;
    let mut members: Vec<String> = members_of(&mut tx, id).await?.into_iter().map(|(id, _)| id).collect();
    members.sort();
    let current = GroupData { display_name: row.display_name.clone(), external_id: row.external_id.clone(), members };
    let mut next = change(&current)?;
    next.members.sort();
    next.members.dedup();
    if next == current {
        let body = answer(&mut tx, ctx, id, true).await?;
        crate::db::commit(tx).await?;
        return Ok(body);
    }
    let renamed = next.display_name != current.display_name || next.external_id != current.external_id;
    if next.display_name.to_lowercase() != current.display_name.to_lowercase() {
        ensure_name_free(&mut tx, ctx.org_id, &next.display_name, Some(id)).await?;
    }
    ensure_members_known(&mut tx, ctx.org_id, &next.members).await?;
    sqlx::query(
        "UPDATE scim_groups SET display_name = $1, display_name_key = $2, external_id = $3, version = version + 1, \
         updated_at = $4 WHERE id = $5",
    )
    .bind(&next.display_name)
    .bind(next.display_name.to_lowercase())
    .bind(next.external_id.as_deref())
    .bind(now)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let changed = write_members(&mut tx, id, &next.members).await?;
    let added: Vec<&String> = next.members.iter().filter(|m| !current.members.contains(m)).collect();
    let removed: Vec<&String> = current.members.iter().filter(|m| !next.members.contains(m)).collect();
    let mut summary = json!({ "groupId": id, "displayName": next.display_name });
    if renamed {
        summary["renamedFrom"] = json!(current.display_name);
    }
    if !added.is_empty() {
        summary["added"] = json!(added);
    }
    if !removed.is_empty() {
        summary["removed"] = json!(removed);
    }
    super::audit(&mut tx, ctx, "scim.group_updated", ("scim_group", id), summary).await?;
    // A new name can match other rules: everyone in the group is mapped again.
    let people: Vec<String> = if renamed {
        current.members.iter().chain(next.members.iter()).cloned().collect::<BTreeSet<_>>().into_iter().collect()
    } else {
        changed
    };
    let touched = sync_all(&mut tx, ctx, &people).await?;
    let body = answer(&mut tx, ctx, id, true).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(ctx.state, &touched).await;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(kind: OpKind, path: Option<&str>, value: Option<Value>) -> Op {
        Op { kind, path: path.map(|p| AttrPath::of(p).unwrap()), value }
    }

    #[test]
    fn member_changes_of_entra_and_okta_apply() {
        let mut g =
            GroupData::from_json(&json!({ "displayName": "Vertrieb", "members": [{ "value": "u1" }] })).unwrap();
        g.apply(&op(OpKind::Add, Some("members"), Some(json!([{ "value": "u2" }, { "value": "u1" }])))).unwrap();
        assert_eq!(g.members, ["u1", "u2"]);
        g.apply(&op(OpKind::Remove, Some("members"), Some(json!([{ "value": "u1" }])))).unwrap();
        assert_eq!(g.members, ["u2"]);
        g.apply(&op(OpKind::Remove, Some(r#"members[value eq "u2"]"#), None)).unwrap();
        assert!(g.members.is_empty());
        g.apply(&op(OpKind::Replace, Some("members"), Some(json!([{ "value": "u3" }])))).unwrap();
        assert_eq!(g.members, ["u3"]);
        g.apply(&op(OpKind::Replace, None, Some(json!({ "id": "x", "displayName": "Vertrieb Nord" })))).unwrap();
        assert_eq!(g.display_name, "Vertrieb Nord");
        g.apply(&op(OpKind::Remove, Some("members"), None)).unwrap();
        assert!(g.members.is_empty());
        assert!(g.apply(&op(OpKind::Remove, Some("displayName"), None)).is_err());
        assert!(GroupData::from_json(&json!({ "members": [] })).is_err());
    }
}
