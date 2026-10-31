//! `/Users` (RFC 7643, section 4.1): the people of the organization's directory and the Kalzit
//! accounts they are.
//!
//! A new SCIM user is linked to the account with its address when there is exactly one, it is a
//! person's (never a service account), its address is confirmed and it is not a server admin or
//! the break-glass admin; otherwise a new account is made. A new account's address is unconfirmed,
//! like any account whose owner never showed they read the mailbox (docs/api/mail.md); only a
//! single sign-on into that same account takes SCIM's word for it (`super::vouches_for_sign_in`).
//! SCIM changes the name and address only of an account it still owns (`super::owner_org`); for any
//! other account it keeps what the directory sends next to it.

use std::collections::BTreeSet;

use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::patch::{AttrPath, Op, OpKind, operations, values};
use super::provision;
use super::schema::USER_SCHEMA;
use super::{Ctx, ListQuery, ScimError, ScimResult, boolean, date_time, field, filter, list_response, scim_json, text};

const MAX_TEXT: usize = 256;
const MAX_EMAILS: usize = 20;
/// The longest name an account has (`routes::clean_name`).
const MAX_ACCOUNT_NAME: usize = 100;

#[derive(Clone, Debug, Default, PartialEq)]
struct Email {
    value: String,
    kind: Option<String>,
    primary: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct NameParts {
    formatted: Option<String>,
    family_name: Option<String>,
    given_name: Option<String>,
    middle_name: Option<String>,
}

impl NameParts {
    fn slot(&mut self, sub: &str) -> Option<&mut Option<String>> {
        match sub {
            "formatted" => Some(&mut self.formatted),
            "familyname" => Some(&mut self.family_name),
            "givenname" => Some(&mut self.given_name),
            "middlename" => Some(&mut self.middle_name),
            _ => None,
        }
    }

    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// What Kalzit keeps of a SCIM user.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UserData {
    user_name: String,
    external_id: Option<String>,
    name: NameParts,
    display_name: Option<String>,
    emails: Vec<Email>,
    active: bool,
}

fn invalid(detail: impl Into<String>) -> ScimError {
    ScimError::bad("invalidValue", detail).because("scim.value_invalid")
}

fn parse_email(value: &Value) -> ScimResult<Option<Email>> {
    match value {
        Value::Object(_) => {
            let Some(address) = field(value, "value").map(|v| text(v, "emails.value", crate::routes::MAX_EMAIL_CHARS))
            else {
                return Ok(None);
            };
            let Some(address) = address? else { return Ok(None) };
            Ok(Some(Email {
                value: address,
                kind: field(value, "type").map(|v| text(v, "emails.type", 50)).transpose()?.flatten(),
                primary: field(value, "primary").and_then(boolean).unwrap_or(false),
            }))
        }
        Value::String(_) => Ok(text(value, "emails.value", crate::routes::MAX_EMAIL_CHARS)?.map(|value| Email {
            value,
            kind: None,
            primary: false,
        })),
        _ => Err(invalid("an email is an object with a value")),
    }
}

fn parse_emails(value: &Value) -> ScimResult<Vec<Email>> {
    let mut out: Vec<Email> = Vec::new();
    for item in values(value) {
        if let Some(e) = parse_email(item)?
            && !out.iter().any(|o| o.value.eq_ignore_ascii_case(&e.value))
        {
            out.push(e);
        }
    }
    if out.len() > MAX_EMAILS {
        return Err(invalid(format!("at most {MAX_EMAILS} emails")));
    }
    Ok(out)
}

fn set_name_parts(name: &mut NameParts, value: &Value) -> ScimResult<()> {
    let Some(object) = value.as_object() else { return Err(invalid("name is an object")) };
    for (key, v) in object {
        if let Some(slot) = name.slot(&key.to_ascii_lowercase()) {
            *slot = text(v, "name", MAX_TEXT)?;
        }
    }
    Ok(())
}

impl UserData {
    /// The user in a POST or PUT body, and whether it says `active`.
    fn from_json(body: &Value) -> ScimResult<(Self, bool)> {
        let user_name =
            field(body, "userName").map(|v| text(v, "userName", MAX_TEXT)).transpose()?.flatten().ok_or_else(|| {
                ScimError::bad("invalidValue", "userName is required").because("scim.user_name_missing")
            })?;
        let mut data = Self { user_name, active: true, ..Self::default() };
        data.external_id = field(body, "externalId").map(|v| text(v, "externalId", MAX_TEXT)).transpose()?.flatten();
        data.display_name = field(body, "displayName").map(|v| text(v, "displayName", MAX_TEXT)).transpose()?.flatten();
        if let Some(name) = field(body, "name").filter(|v| !v.is_null()) {
            set_name_parts(&mut data.name, name)?;
        }
        if let Some(emails) = field(body, "emails").filter(|v| !v.is_null()) {
            data.emails = parse_emails(emails)?;
        }
        let active = field(body, "active");
        if let Some(a) = active {
            data.active = boolean(a).ok_or_else(|| invalid("active is true or false"))?;
        }
        Ok((data, active.is_some()))
    }

    fn from_row(row: &Row) -> Self {
        let attributes: Value = serde_json::from_str(&row.attributes).unwrap_or(Value::Null);
        let mut data = Self {
            user_name: row.user_name.clone(),
            external_id: row.external_id.clone(),
            active: row.active != 0,
            ..Self::default()
        };
        if let Some(name) = attributes.get("name") {
            let _ = set_name_parts(&mut data.name, name);
        }
        data.display_name = attributes.get("displayName").and_then(Value::as_str).map(str::to_string);
        if let Some(emails) = attributes.get("emails") {
            data.emails = parse_emails(emails).unwrap_or_default();
        }
        data
    }

    /// The stored `attributes` column.
    fn attributes(&self) -> Value {
        json!({
            "name": self.name_json(),
            "displayName": self.display_name,
            "emails": self.emails.iter().map(email_json).collect::<Vec<_>>(),
        })
    }

    fn name_json(&self) -> Value {
        let n = &self.name;
        let mut out = serde_json::Map::new();
        for (key, value) in [
            ("formatted", &n.formatted),
            ("familyName", &n.family_name),
            ("givenName", &n.given_name),
            ("middleName", &n.middle_name),
        ] {
            if let Some(v) = value {
                out.insert(key.into(), json!(v));
            }
        }
        Value::Object(out)
    }

    /// The account's address: the primary email, else the first, else `userName` when it is an
    /// address.
    fn email(&self) -> Option<String> {
        let chosen = self.emails.iter().find(|e| e.primary).or_else(|| self.emails.first());
        chosen
            .and_then(|e| crate::routes::normalize_email(&e.value).ok())
            .or_else(|| crate::routes::normalize_email(&self.user_name).ok())
    }

    /// The account's name: `displayName`, else `name.formatted`, else given and family name, else
    /// the part of `userName` before an `@`.
    fn person_name(&self) -> String {
        let n = &self.name;
        let joined =
            [n.given_name.as_deref(), n.family_name.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" ");
        let name = self
            .display_name
            .clone()
            .or_else(|| n.formatted.clone())
            .or_else(|| (!joined.is_empty()).then_some(joined))
            .unwrap_or_else(|| self.user_name.split('@').next().unwrap_or_default().to_string());
        name.chars().filter(|c| !c.is_control()).take(MAX_ACCOUNT_NAME).collect()
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
        let remove = kind == OpKind::Remove;
        let given = || value.ok_or_else(|| invalid("the operation needs a value"));
        match path.attr.as_str() {
            "username" => {
                if remove {
                    return Err(ScimError::bad("mutability", "userName is required").because("scim.user_name_missing"));
                }
                self.user_name = text(given()?, "userName", MAX_TEXT)?.ok_or_else(|| {
                    ScimError::bad("invalidValue", "userName is required").because("scim.user_name_missing")
                })?;
            }
            "externalid" => {
                self.external_id = if remove { None } else { text(given()?, "externalId", MAX_TEXT)? };
            }
            "displayname" => {
                self.display_name = if remove { None } else { text(given()?, "displayName", MAX_TEXT)? };
            }
            "active" => {
                if !remove {
                    self.active = boolean(given()?).ok_or_else(|| invalid("active is true or false"))?;
                }
            }
            "name" => match &path.sub {
                Some(sub) => {
                    let new = if remove { None } else { text(given()?, "name", MAX_TEXT)? };
                    if let Some(slot) = self.name.slot(sub) {
                        *slot = new;
                    }
                }
                None if remove => self.name = NameParts::default(),
                None => {
                    if kind == OpKind::Replace {
                        self.name = NameParts::default();
                    }
                    set_name_parts(&mut self.name, given()?)?;
                }
            },
            "emails" => self.apply_emails(kind, path, value)?,
            "groups" => {
                return Err(
                    ScimError::bad("mutability", "a user's groups change through the groups").because("scim.read_only")
                );
            }
            // Attributes Kalzit does not keep (title, phone numbers, extensions, ...) are accepted
            // and left out, so a directory's full mapping does not fail.
            _ => {}
        }
        Ok(())
    }

    fn apply_emails(&mut self, kind: OpKind, path: &AttrPath, value: Option<&Value>) -> ScimResult<()> {
        let given = || value.ok_or_else(|| invalid("the operation needs a value"));
        if let Some((attr, wanted)) = &path.filter {
            let matches = |e: &Email| match attr.as_str() {
                "type" => e.kind.as_deref().is_some_and(|k| k.eq_ignore_ascii_case(wanted)),
                "value" => e.value.eq_ignore_ascii_case(wanted),
                "primary" => e.primary.to_string() == wanted.to_ascii_lowercase(),
                _ => false,
            };
            if kind == OpKind::Remove {
                self.emails.retain(|e| !matches(e));
                return Ok(());
            }
            let position = self.emails.iter().position(matches);
            match path.sub.as_deref() {
                Some("value") => {
                    let Some(address) = text(given()?, "emails.value", crate::routes::MAX_EMAIL_CHARS)? else {
                        return Ok(());
                    };
                    match position {
                        Some(i) => self.emails[i].value = address,
                        None => {
                            let kind = (attr == "type").then(|| wanted.clone());
                            let primary = self.emails.is_empty();
                            self.emails.push(Email { value: address, kind, primary });
                        }
                    }
                }
                Some("primary") => {
                    let primary = boolean(given()?).ok_or_else(|| invalid("primary is true or false"))?;
                    if let Some(i) = position {
                        self.emails[i].primary = primary;
                    }
                }
                Some(_) => {}
                None => {
                    if let Some(new) = parse_email(given()?)? {
                        match position {
                            Some(i) => self.emails[i] = new,
                            None => self.emails.push(new),
                        }
                    }
                }
            }
        } else {
            match (kind, path.sub.as_deref()) {
                (OpKind::Remove, _) => match value {
                    Some(v) => {
                        let gone = parse_emails(v)?;
                        self.emails.retain(|e| !gone.iter().any(|g| g.value.eq_ignore_ascii_case(&e.value)));
                    }
                    None => self.emails.clear(),
                },
                (_, Some("value")) => {
                    if let Some(address) = text(given()?, "emails.value", crate::routes::MAX_EMAIL_CHARS)? {
                        match self.emails.iter().position(|e| e.primary).or(if self.emails.is_empty() {
                            None
                        } else {
                            Some(0)
                        }) {
                            Some(i) => self.emails[i].value = address,
                            None => self.emails.push(Email { value: address, kind: None, primary: true }),
                        }
                    }
                }
                (_, Some(_)) => {}
                (OpKind::Add, None) => {
                    for e in parse_emails(given()?)? {
                        match self.emails.iter().position(|o| o.value.eq_ignore_ascii_case(&e.value)) {
                            Some(i) => self.emails[i] = e,
                            None => self.emails.push(e),
                        }
                    }
                }
                (_, None) => self.emails = parse_emails(given()?)?,
            }
        }
        if self.emails.len() > MAX_EMAILS {
            return Err(invalid(format!("at most {MAX_EMAILS} emails")));
        }
        Ok(())
    }
}

fn email_json(e: &Email) -> Value {
    let mut out = json!({ "value": e.value, "primary": e.primary });
    if let Some(kind) = &e.kind {
        out["type"] = json!(kind);
    }
    out
}

#[derive(sqlx::FromRow)]
struct Row {
    user_id: String,
    user_name: String,
    external_id: Option<String>,
    attributes: String,
    active: i64,
    version: i64,
    created_at: i64,
    updated_at: i64,
    email: String,
}

/// `$1` is the organization. Service accounts are never SCIM users; the join keeps it that way.
const COLUMNS: &str = "SELECT s.user_id, s.user_name, s.external_id, s.attributes, s.active, \
     s.version, s.created_at, s.updated_at, u.email FROM scim_users s JOIN users u ON u.id = s.user_id \
     WHERE s.org_id = $1 AND u.service_account = 0";

async fn load(conn: &mut sqlx::AnyConnection, org_id: &str, user_id: &str) -> ScimResult<Row> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLUMNS} AND s.user_id = $2")))
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(ScimError::not_found)
}

async fn groups_of(conn: &mut sqlx::AnyConnection, org_id: &str, user_id: &str) -> ScimResult<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT g.id, g.display_name FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id \
         WHERE m.user_id = $1 AND g.org_id = $2 AND g.deactivated_at IS NULL ORDER BY g.display_name, g.id",
    )
    .bind(user_id)
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?)
}

fn resource(ctx: &Ctx<'_>, row: &Row, groups: &[(String, String)]) -> Value {
    let data = UserData::from_row(row);
    let emails: Vec<Value> = if data.emails.is_empty() {
        vec![json!({ "value": row.email, "type": "work", "primary": true })]
    } else {
        data.emails.iter().map(email_json).collect()
    };
    let mut out = json!({
        "schemas": [USER_SCHEMA],
        "id": row.user_id,
        "userName": row.user_name,
        "active": row.active != 0,
        "emails": emails,
        "groups": groups.iter().map(|(id, name)| json!({
            "value": id,
            "display": name,
            "$ref": ctx.location("Groups", id),
        })).collect::<Vec<_>>(),
        "meta": {
            "resourceType": "User",
            "created": date_time(row.created_at),
            "lastModified": date_time(row.updated_at),
            "location": ctx.location("Users", &row.user_id),
            "version": format!("W/\"{}\"", row.version),
        },
    });
    if let Some(e) = &row.external_id {
        out["externalId"] = json!(e);
    }
    if !data.name.is_empty() {
        out["name"] = data.name_json();
    }
    if let Some(d) = &data.display_name {
        out["displayName"] = json!(d);
    }
    out
}

async fn answer(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, user_id: &str) -> ScimResult<Value> {
    let row = load(&mut *conn, ctx.org_id, user_id).await?;
    let groups = groups_of(&mut *conn, ctx.org_id, user_id).await?;
    Ok(resource(ctx, &row, &groups))
}

enum Arg {
    Text(String),
    Int(i64),
}

pub async fn list(ctx: &Ctx<'_>, query: &ListQuery) -> ScimResult<Response> {
    let paging = query.paging()?;
    let mut sql = String::new();
    let mut args: Vec<Arg> = vec![Arg::Text(ctx.org_id.to_string())];
    if let Some(raw) = query.filter.as_deref().filter(|f| !f.trim().is_empty()) {
        for eq in filter::parse(raw)? {
            let n = args.len() + 1;
            match eq.attr.as_str() {
                "username" => {
                    sql.push_str(&format!(" AND s.user_name_key = ${n}"));
                    args.push(Arg::Text(eq.text().to_lowercase()));
                }
                "externalid" => {
                    sql.push_str(&format!(" AND s.external_id = ${n}"));
                    args.push(Arg::Text(eq.text()));
                }
                "id" => {
                    sql.push_str(&format!(" AND s.user_id = ${n}"));
                    args.push(Arg::Text(eq.text()));
                }
                "active" => {
                    let on = boolean(&eq.value).ok_or_else(|| {
                        ScimError::bad("invalidFilter", "active is true or false").because("scim.filter_unsupported")
                    })?;
                    sql.push_str(&format!(" AND s.active = ${n}"));
                    args.push(Arg::Int(i64::from(on)));
                }
                other => {
                    return Err(ScimError::bad("invalidFilter", format!("users cannot be filtered by {other}"))
                        .because("scim.filter_unsupported"));
                }
            }
        }
    }
    let mut conn = ctx.state.read_db.acquire().await?;
    let count_sql = format!(
        "SELECT COUNT(*) FROM scim_users s JOIN users u ON u.id = s.user_id \
         WHERE s.org_id = $1 AND u.service_account = 0{sql}"
    );
    let mut count = sqlx::query_as::<_, (i64,)>(sqlx::AssertSqlSafe(count_sql));
    for a in &args {
        count = match a {
            Arg::Text(t) => count.bind(t.clone()),
            Arg::Int(i) => count.bind(*i),
        };
    }
    let (total,) = count.fetch_one(&mut *conn).await?;
    let mut resources = Vec::new();
    if paging.count > 0 {
        let n = args.len() + 1;
        let page_sql = format!("{COLUMNS}{sql} ORDER BY s.created_at, s.user_id LIMIT ${n} OFFSET ${}", n + 1);
        let mut page = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(page_sql));
        for a in &args {
            page = match a {
                Arg::Text(t) => page.bind(t.clone()),
                Arg::Int(i) => page.bind(*i),
            };
        }
        let rows = page.bind(paging.count).bind(paging.start_index - 1).fetch_all(&mut *conn).await?;
        for row in &rows {
            let groups = if query.excludes("groups") {
                Vec::new()
            } else {
                groups_of(&mut conn, ctx.org_id, &row.user_id).await?
            };
            resources.push(resource(ctx, row, &groups));
        }
    }
    Ok(list_response(total, &paging, resources))
}

pub async fn get(ctx: &Ctx<'_>, id: &str, _query: &ListQuery) -> ScimResult<Response> {
    let mut conn = ctx.state.read_db.acquire().await?;
    Ok(scim_json(StatusCode::OK, &answer(&mut conn, ctx, id).await?))
}

fn created(location: String, body: &Value) -> Response {
    let mut res = scim_json(StatusCode::CREATED, body);
    if let Ok(v) = HeaderValue::from_str(&location) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    res
}

fn user_name_taken() -> ScimError {
    ScimError::taken("another user of this organization has this userName").because("scim.user_name_taken")
}

async fn ensure_user_name_free(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    user_name: &str,
    except: Option<&str>,
) -> ScimResult<()> {
    let taken: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM scim_users WHERE org_id = $1 AND user_name_key = $2")
            .bind(org_id)
            .bind(user_name.to_lowercase())
            .fetch_optional(&mut *conn)
            .await?;
    match taken {
        Some((id,)) if Some(id.as_str()) != except => Err(user_name_taken()),
        _ => Ok(()),
    }
}

#[derive(sqlx::FromRow)]
struct Existing {
    id: String,
    is_server_admin: i64,
    email_confirmed: i64,
}

/// The account a new SCIM user with `email` is: `Some(id)` to link, `None` to make one.
async fn existing_account(conn: &mut sqlx::AnyConnection, ctx: &Ctx<'_>, email: &str) -> ScimResult<Option<String>> {
    let matches = crate::routes::all_accounts_with_email(&mut *conn, email).await?;
    let taken = || ScimError::taken("another account has this email").because("scim.email_taken");
    // A service account's made-up address names no person; it is never linked.
    if matches.iter().any(|(_, service)| *service) || matches.len() > 1 {
        return Err(taken());
    }
    let Some((id, _)) = matches.into_iter().next() else { return Ok(None) };
    let account: Existing = sqlx::query_as("SELECT id, is_server_admin, email_confirmed FROM users WHERE id = $1")
        .bind(&id)
        .fetch_one(&mut *conn)
        .await?;
    if account.is_server_admin != 0 || ctx.policy.break_glass() == Some(account.id.as_str()) {
        return Err(ScimError::protected("a server admin's account is never linked through SCIM")
            .because("scim.account_protected"));
    }
    if account.email_confirmed == 0 {
        return Err(ScimError::taken("an account has this email, but its owner has not confirmed it")
            .because("scim.email_unconfirmed"));
    }
    let linked: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM scim_users WHERE org_id = $1 AND user_id = $2")
        .bind(ctx.org_id)
        .bind(&account.id)
        .fetch_optional(&mut *conn)
        .await?;
    if linked.is_some() {
        return Err(ScimError::taken("this account is already a user of this organization's directory")
            .because("scim.account_linked"));
    }
    Ok(Some(account.id))
}

pub async fn create(ctx: &Ctx<'_>, body: Value) -> ScimResult<Response> {
    let (data, _) = UserData::from_json(&body)?;
    let email = data.email().ok_or_else(|| {
        ScimError::bad("invalidValue", "the user needs an email address").because("scim.email_missing")
    })?;
    let now = ctx.state.clock.now_ms();
    let mut tx = crate::db::begin(&ctx.state.db).await?;
    crate::authz::lock_org(&mut tx, ctx.org_id).await?;
    ensure_user_name_free(&mut tx, ctx.org_id, &data.user_name, None).await?;
    let (user_id, made) = match existing_account(&mut tx, ctx, &email).await? {
        Some(id) => (id, false),
        None => {
            let id = crate::routes::new_id();
            // No password and an unconfirmed address: the person signs in through a provider or
            // sets a password with a reset link, which also confirms the address.
            sqlx::query(
                "INSERT INTO users (id, email, name, password_hash, is_server_admin, disabled, created_at, \
                 email_confirmed) VALUES ($1, $2, $3, NULL, 0, $4, $5, 0)",
            )
            .bind(&id)
            .bind(&email)
            .bind(data.person_name())
            .bind(i64::from(!data.active))
            .bind(now)
            .execute(&mut *tx)
            .await?;
            (id, true)
        }
    };
    sqlx::query(
        "INSERT INTO scim_users (org_id, user_id, user_name, user_name_key, external_id, attributes, active, \
         created_account, locked_account, version, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)",
    )
    .bind(ctx.org_id)
    .bind(&user_id)
    .bind(&data.user_name)
    .bind(data.user_name.to_lowercase())
    .bind(data.external_id.as_deref())
    .bind(data.attributes().to_string())
    .bind(i64::from(data.active))
    .bind(i64::from(made))
    .bind(i64::from(made && !data.active))
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    let summary = json!({
        "userId": user_id,
        "userName": data.user_name,
        "accountCreated": made,
        "active": data.active,
    });
    super::audit(&mut tx, ctx, "scim.user_created", ("user", &user_id), summary).await?;
    if !made {
        // Linking an existing person's account puts it in this organization: recorded on its own,
        // with the token and the organization, and counted on the SCIM card.
        let summary = json!({ "userId": user_id, "userName": data.user_name, "orgId": ctx.org_id });
        super::audit(&mut tx, ctx, "scim.user_linked", ("user", &user_id), summary).await?;
    }
    let touched = provision::sync(&mut tx, ctx, &user_id).await?;
    let body = answer(&mut tx, ctx, &user_id).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(ctx.state, &touched).await;
    Ok(created(ctx.location("Users", &user_id), &body))
}

pub async fn replace(ctx: &Ctx<'_>, id: &str, body: Value) -> ScimResult<Response> {
    let (new, says_active) = UserData::from_json(&body)?;
    let body = save(ctx, id, |current| {
        let mut new = new;
        if !says_active {
            new.active = current.active;
        }
        Ok(new)
    })
    .await?;
    Ok(scim_json(StatusCode::OK, &body))
}

pub async fn patch(ctx: &Ctx<'_>, id: &str, body: Value) -> ScimResult<Response> {
    let ops = operations(&body)?;
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

/// A DELETE deactivates (owner decision: SCIM never deletes).
pub async fn delete(ctx: &Ctx<'_>, id: &str) -> ScimResult<Response> {
    save(ctx, id, |current| Ok(UserData { active: false, ..current.clone() })).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Changes the SCIM user `id` to what `change` makes of it: its attributes, the account's name and
/// address while SCIM owns the account, and deactivating or reactivating. Answers the resource.
async fn save(ctx: &Ctx<'_>, id: &str, change: impl FnOnce(&UserData) -> ScimResult<UserData>) -> ScimResult<Value> {
    let now = ctx.state.clock.now_ms();
    let mut tx = crate::db::begin(&ctx.state.db).await?;
    // The account's row first, then the organization (the lock order in `authz`).
    sqlx::query("UPDATE users SET disabled = disabled WHERE id = $1 AND service_account = 0")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    crate::authz::lock_org(&mut tx, ctx.org_id).await?;
    let row = load(&mut tx, ctx.org_id, id).await?;
    let current = UserData::from_row(&row);
    let next = change(&current)?;
    // Deactivating and reactivating change the account or its membership: never for protected
    // accounts and roles. Attributes alone only change what SCIM keeps of them.
    if next.active != current.active
        && let Some(e) = provision::protection(&mut tx, ctx, id).await?
    {
        return Err(e);
    }
    if next == current {
        let body = answer(&mut tx, ctx, id).await?;
        crate::db::commit(tx).await?;
        return Ok(body);
    }
    let mut fields: Vec<&str> = Vec::new();
    if next.user_name != current.user_name {
        ensure_user_name_free(&mut tx, ctx.org_id, &next.user_name, Some(id)).await?;
        fields.push("userName");
    }
    if next.external_id != current.external_id {
        fields.push("externalId");
    }
    if next.name != current.name || next.display_name != current.display_name {
        fields.push("name");
    }
    if next.emails != current.emails {
        fields.push("emails");
    }
    // The account itself only while this SCIM owns it (nobody signs in to it yet) and it is not
    // protected (owner, a role beyond an admin's, server admin, break-glass, service account).
    if super::owner_org(&mut tx, id, ctx.policy.break_glass()).await?.as_deref() == Some(ctx.org_id)
        && provision::protection(&mut tx, ctx, id).await?.is_none()
    {
        update_account(&mut tx, id, &row, &current, &next).await?;
    }
    sqlx::query(
        "UPDATE scim_users SET user_name = $1, user_name_key = $2, external_id = $3, attributes = $4, \
         version = version + 1, updated_at = $5 WHERE org_id = $6 AND user_id = $7",
    )
    .bind(&next.user_name)
    .bind(next.user_name.to_lowercase())
    .bind(next.external_id.as_deref())
    .bind(next.attributes().to_string())
    .bind(now)
    .bind(ctx.org_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    if !fields.is_empty() {
        let summary = json!({ "userId": id, "fields": fields });
        super::audit(&mut tx, ctx, "scim.user_updated", ("user", id), summary).await?;
    }
    let mut touched = BTreeSet::new();
    if current.active && !next.active {
        let (scope, gone) = provision::deactivate(&mut tx, ctx, id).await?;
        touched.extend(gone);
        let summary = json!({ "userId": id, "scope": scope });
        super::audit(&mut tx, ctx, "scim.user_deactivated", ("user", id), summary).await?;
    } else if !current.active && next.active {
        touched.extend(provision::reactivate(&mut tx, ctx, id).await?);
        super::audit(&mut tx, ctx, "scim.user_reactivated", ("user", id), json!({ "userId": id })).await?;
    }
    let body = answer(&mut tx, ctx, id).await?;
    crate::db::commit(tx).await?;
    crate::sso::rights_changed(ctx.state, &touched).await;
    Ok(body)
}

/// The name and address of an account this organization's SCIM still owns, after the directory
/// changed them. A new address
/// must not belong to another account, and it is unconfirmed again.
async fn update_account(
    conn: &mut sqlx::AnyConnection,
    id: &str,
    row: &Row,
    current: &UserData,
    next: &UserData,
) -> ScimResult<()> {
    let name = next.person_name();
    if name != current.person_name() && !name.is_empty() {
        sqlx::query("UPDATE users SET name = $1 WHERE id = $2").bind(&name).bind(id).execute(&mut *conn).await?;
    }
    if let Some(email) = next.email()
        && !crate::routes::same_email(&email, &row.email)
    {
        let others = crate::routes::all_accounts_with_email(&mut *conn, &email).await?;
        if others.iter().any(|(other, _)| other != id) {
            return Err(ScimError::taken("another account has this email").because("scim.email_taken"));
        }
        sqlx::query("UPDATE users SET email = $1, email_confirmed = 0 WHERE id = $2")
            .bind(&email)
            .bind(id)
            .execute(&mut *conn)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(kind: OpKind, path: Option<&str>, value: Option<Value>) -> Op {
        Op { kind, path: path.map(|p| AttrPath::of(p).unwrap()), value }
    }

    fn anna() -> UserData {
        UserData::from_json(&json!({
            "userName": "Anna.Berg@mueller.example",
            "name": { "givenName": "Anna", "familyName": "Berg" },
            "emails": [{ "value": "anna.berg@mueller.example", "type": "work", "primary": true }],
            "active": true,
        }))
        .unwrap()
        .0
    }

    #[test]
    fn users_read_from_entra_and_okta_bodies() {
        let a = anna();
        assert_eq!(a.email().as_deref(), Some("anna.berg@mueller.example"));
        assert_eq!(a.person_name(), "Anna Berg");
        let (b, says) =
            UserData::from_json(&json!({ "userName": "jonas@mueller.example", "active": "False" })).unwrap();
        assert!(says && !b.active);
        assert_eq!(b.email().as_deref(), Some("jonas@mueller.example"), "userName as the address");
        assert_eq!(b.person_name(), "jonas");
        assert!(UserData::from_json(&json!({ "displayName": "x" })).is_err());
        let (c, says) = UserData::from_json(&json!({ "userName": "x" })).unwrap();
        assert!(!says && c.active && c.email().is_none());
    }

    #[test]
    fn entra_patches_apply() {
        let mut a = anna();
        a.apply(&op(OpKind::Replace, Some("active"), Some(json!("False")))).unwrap();
        assert!(!a.active);
        a.apply(&op(OpKind::Add, Some(r#"emails[type eq "work"].value"#), Some(json!("anna@neu.example")))).unwrap();
        assert_eq!(a.email().as_deref(), Some("anna@neu.example"));
        a.apply(&op(OpKind::Replace, Some("name.givenName"), Some(json!("Anni")))).unwrap();
        assert_eq!(a.person_name(), "Anni Berg");
        a.apply(&op(OpKind::Replace, Some("displayName"), Some(json!("Anni B.")))).unwrap();
        assert_eq!(a.person_name(), "Anni B.");
        a.apply(&op(OpKind::Add, Some("externalId"), Some(json!("7c1e")))).unwrap();
        assert_eq!(a.external_id.as_deref(), Some("7c1e"));
        a.apply(&op(OpKind::Remove, Some("externalId"), None)).unwrap();
        assert_eq!(a.external_id, None);
        // Extension attributes are accepted and not kept.
        let before = a.clone();
        a.apply(&op(
            OpKind::Add,
            Some("urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department"),
            Some(json!("Vertrieb")),
        ))
        .unwrap();
        a.apply(&op(OpKind::Replace, Some("title"), Some(json!("Leitung")))).unwrap();
        assert_eq!(a, before);
        assert!(a.apply(&op(OpKind::Remove, Some("userName"), None)).is_err());
        assert!(a.apply(&op(OpKind::Add, Some("groups"), Some(json!([{ "value": "g" }])))).is_err());
    }

    #[test]
    fn okta_patches_without_a_path_apply() {
        let mut a = anna();
        a.apply(&op(OpKind::Replace, None, Some(json!({ "active": false })))).unwrap();
        assert!(!a.active);
        a.apply(&op(OpKind::Replace, None, Some(json!({ "name.familyName": "Brandt", "active": true })))).unwrap();
        assert!(a.active);
        assert_eq!(a.person_name(), "Anna Brandt");
        a.apply(&op(OpKind::Replace, Some("emails"), Some(json!([{ "value": "ab@x.example", "primary": true }]))))
            .unwrap();
        assert_eq!(a.emails.len(), 1);
        assert!(a.apply(&op(OpKind::Replace, None, Some(json!("x")))).is_err());
    }

    #[test]
    fn stored_attributes_round_trip() {
        let a = anna();
        let row = Row {
            user_id: "u".into(),
            user_name: a.user_name.clone(),
            external_id: None,
            attributes: a.attributes().to_string(),
            active: 1,
            version: 1,
            created_at: 0,
            updated_at: 0,
            email: "anna.berg@mueller.example".into(),
        };
        assert_eq!(UserData::from_row(&row), a);
    }
}
