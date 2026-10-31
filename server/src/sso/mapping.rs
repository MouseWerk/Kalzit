//! Group mapping (docs/api/sso.md, "Model"): the groups a provider sends become memberships in
//! organizations and teams. `resolve` decides; `apply` writes it at a sign-in. Shared by every
//! provider kind (OIDC now, SAML and LDAP later).

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{Value, json};

use crate::error::ApiResult;

/// The roles a mapping may give, lowest first.
pub const MAPPABLE_ROLES: &[&str] = &["viewer", "editor", "admin"];
/// The roles the unmapped rule may give.
pub const DEFAULT_ROLES: &[&str] = &["viewer", "editor"];

/// The rank of a built-in role; custom roles have none (mappings leave them alone).
pub fn rank(role: &str) -> Option<u8> {
    match role {
        "viewer" => Some(1),
        "editor" => Some(2),
        "admin" => Some(3),
        "owner" => Some(4),
        _ => None,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, sqlx::FromRow)]
pub struct Rule {
    pub id: String,
    pub group_name: String,
    pub org_id: String,
    pub team_id: Option<String>,
    pub role: String,
    pub idp_decides: i64,
}

/// What happens to people without a matching group.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unmapped {
    pub refuse: bool,
    pub org_id: Option<String>,
    pub role: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrgOutcome {
    pub org_id: String,
    pub role: String,
    /// The group the role came from; `None` for the default role.
    pub group: Option<String>,
    /// Teams, each with whether an "IdP entscheidet" mapping gave it.
    #[serde(skip)]
    pub teams: BTreeMap<String, bool>,
    pub idp_decides: bool,
    pub default: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub refused: bool,
    pub orgs: Vec<OrgOutcome>,
}

/// The memberships `groups` give under `rules` (the rules of the provider the person signed in
/// through): per organization the highest mapped role, teams added up; an organization is
/// "IdP entscheidet" when one of its matching rules is.
pub fn resolve(rules: &[Rule], groups: &[String], unmapped: &Unmapped) -> Outcome {
    let mut orgs: BTreeMap<&str, OrgOutcome> = BTreeMap::new();
    for rule in rules.iter().filter(|r| groups.contains(&r.group_name)) {
        let Some(rank_new) = rank(&rule.role) else { continue };
        let idp = rule.idp_decides != 0;
        let entry = orgs.entry(&rule.org_id).or_insert_with(|| OrgOutcome {
            org_id: rule.org_id.clone(),
            role: rule.role.clone(),
            group: Some(rule.group_name.clone()),
            teams: BTreeMap::new(),
            idp_decides: false,
            default: false,
        });
        if rank_new > rank(&entry.role).unwrap_or(0) {
            entry.role = rule.role.clone();
            entry.group = Some(rule.group_name.clone());
        }
        entry.idp_decides |= idp;
        if let Some(team) = &rule.team_id {
            let managed = entry.teams.entry(team.clone()).or_insert(false);
            *managed |= idp;
        }
    }
    if orgs.is_empty() {
        if unmapped.refuse {
            return Outcome { refused: true, orgs: Vec::new() };
        }
        let orgs = unmapped
            .org_id
            .iter()
            .map(|org| OrgOutcome {
                org_id: org.clone(),
                role: unmapped.role.clone(),
                group: None,
                teams: BTreeMap::new(),
                idp_decides: false,
                default: true,
            })
            .collect();
        return Outcome { refused: false, orgs };
    }
    Outcome { refused: false, orgs: orgs.into_values().collect() }
}

/// The rules of `provider_id`.
pub async fn rules<'c, E>(db: E, provider_id: &str) -> ApiResult<Vec<Rule>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    Ok(sqlx::query_as(
        "SELECT id, group_name, org_id, team_id, role, idp_decides FROM sso_group_mappings WHERE provider_id = $1 \
         ORDER BY created_at, id",
    )
    .bind(provider_id)
    .fetch_all(db)
    .await?)
}

/// The rules of every provider that give a role in `org_id`: the group mapping SCIM groups of that
/// organization go through (docs/api/scim.md, "Groups and roles").
pub async fn org_rules<'c, E>(db: E, org_id: &str) -> ApiResult<Vec<Rule>>
where
    E: sqlx::Executor<'c, Database = sqlx::Any>,
{
    Ok(sqlx::query_as(
        "SELECT id, group_name, org_id, team_id, role, idp_decides FROM sso_group_mappings WHERE org_id = $1 \
         ORDER BY created_at, id",
    )
    .bind(org_id)
    .fetch_all(db)
    .await?)
}

/// Whether an "IdP entscheidet" mapping (of a provider or of the organization's SCIM directory)
/// decides `user_id`'s role in `org_id`.
pub async fn is_managed(conn: &mut sqlx::AnyConnection, org_id: &str, user_id: &str) -> ApiResult<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM sso_managed WHERE org_id = $1 AND user_id = $2 AND team_id = '' \
         UNION ALL SELECT 1 FROM scim_managed WHERE org_id = $3 AND user_id = $4 AND team_id = ''",
    )
    .bind(org_id)
    .bind(user_id)
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.is_some())
}

/// Where the memberships an "IdP entscheidet" mapping gave are kept: per provider
/// (`sso_managed`), or per organization for its SCIM directory (`scim_managed`).
#[derive(Clone, Copy)]
enum Managed<'a> {
    Provider(&'a str),
    Scim(&'a str),
}

impl Managed<'_> {
    fn key(&self) -> &str {
        match self {
            Self::Provider(id) | Self::Scim(id) => id,
        }
    }

    fn select(&self) -> &'static str {
        match self {
            Self::Provider(_) => "SELECT org_id, team_id FROM sso_managed WHERE user_id = $1 AND provider_id = $2",
            Self::Scim(_) => "SELECT org_id, team_id FROM scim_managed WHERE user_id = $1 AND org_id = $2",
        }
    }

    fn clear(&self) -> &'static str {
        match self {
            Self::Provider(_) => "DELETE FROM sso_managed WHERE user_id = $1 AND provider_id = $2",
            Self::Scim(_) => "DELETE FROM scim_managed WHERE user_id = $1 AND org_id = $2",
        }
    }

    /// `$1` the user, `$2` the key, `$3` the organization, `$4` the team; `$5` and `$6` the
    /// organization and the user again.
    fn insert(&self) -> &'static str {
        match self {
            Self::Provider(_) => {
                "INSERT INTO sso_managed (user_id, provider_id, org_id, team_id) SELECT $1, $2, $3, $4 \
                 WHERE EXISTS (SELECT 1 FROM org_members WHERE org_id = $5 AND user_id = $6)"
            }
            Self::Scim(_) => {
                "INSERT INTO scim_managed (user_id, org_id, team_id) SELECT $1, $2, $4 \
                 WHERE $3 = $2 AND EXISTS (SELECT 1 FROM org_members WHERE org_id = $5 AND user_id = $6)"
            }
        }
    }
}

/// Writes `outcome` for `user_id` after a sign-in through `provider_id`, inside the sign-in's
/// transaction. Answers the changes (for the audit entry) and the organizations whose rights
/// changed. Owners are never changed, so no organization loses its last owner.
pub async fn apply(
    conn: &mut sqlx::AnyConnection,
    provider_id: &str,
    user_id: &str,
    outcome: &Outcome,
    now: i64,
) -> ApiResult<(Vec<Value>, BTreeSet<String>)> {
    apply_to(conn, Managed::Provider(provider_id), user_id, outcome, now).await
}

/// `apply` for the SCIM directory of `org_id`: `outcome` names only that organization, and what
/// "IdP entscheidet" gave is kept per organization (`scim_managed`).
pub async fn apply_scim(
    conn: &mut sqlx::AnyConnection,
    org_id: &str,
    user_id: &str,
    outcome: &Outcome,
    now: i64,
) -> ApiResult<(Vec<Value>, BTreeSet<String>)> {
    debug_assert!(outcome.orgs.iter().all(|o| o.org_id == org_id), "SCIM maps into its own organization only");
    apply_to(conn, Managed::Scim(org_id), user_id, outcome, now).await
}

async fn apply_to(
    conn: &mut sqlx::AnyConnection,
    managed: Managed<'_>,
    user_id: &str,
    outcome: &Outcome,
    now: i64,
) -> ApiResult<(Vec<Value>, BTreeSet<String>)> {
    let mut changes = Vec::new();
    let mut touched = BTreeSet::new();
    let before: Vec<(String, String)> =
        sqlx::query_as(managed.select()).bind(user_id).bind(managed.key()).fetch_all(&mut *conn).await?;
    let mut managed_now: BTreeSet<(String, String)> = BTreeSet::new();
    for org in &outcome.orgs {
        // A role the provider decided before follows the groups now, also downwards.
        let was_managed = before.iter().any(|(o, t)| o == &org.org_id && t.is_empty());
        crate::authz::lock_org(&mut *conn, &org.org_id).await?;
        let exists: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM orgs WHERE id = $1").bind(&org.org_id).fetch_optional(&mut *conn).await?;
        if exists.is_none() {
            continue;
        }
        let current: Option<(String,)> =
            sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
                .bind(&org.org_id)
                .bind(user_id)
                .fetch_optional(&mut *conn)
                .await?;
        match current {
            None => {
                sqlx::query("INSERT INTO org_members (org_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)")
                    .bind(&org.org_id)
                    .bind(user_id)
                    .bind(&org.role)
                    .bind(now)
                    .execute(&mut *conn)
                    .await?;
                changes.push(json!({ "orgId": org.org_id, "added": org.role }));
                touched.insert(org.org_id.clone());
            }
            Some((role,)) if role != "owner" => {
                let decided = org.idp_decides || was_managed;
                let change = match rank(&role) {
                    Some(have) => have < rank(&org.role).unwrap_or(0) || (decided && role != org.role),
                    // A custom role: only "IdP entscheidet" replaces it.
                    None => decided,
                };
                if change {
                    sqlx::query("UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3")
                        .bind(&org.role)
                        .bind(&org.org_id)
                        .bind(user_id)
                        .execute(&mut *conn)
                        .await?;
                    changes.push(json!({ "orgId": org.org_id, "from": role, "to": org.role }));
                    touched.insert(org.org_id.clone());
                }
            }
            Some(_) => {}
        }
        if org.idp_decides {
            managed_now.insert((org.org_id.clone(), String::new()));
        }
        for (team, idp) in &org.teams {
            let in_org: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM teams WHERE id = $1 AND org_id = $2")
                .bind(team)
                .bind(&org.org_id)
                .fetch_optional(&mut *conn)
                .await?;
            if in_org.is_none() {
                continue;
            }
            let added = sqlx::query(
                "INSERT INTO team_members (team_id, user_id, role, created_at) VALUES ($1, $2, 'member', $3) \
                 ON CONFLICT (team_id, user_id) DO NOTHING",
            )
            .bind(team)
            .bind(user_id)
            .bind(now)
            .execute(&mut *conn)
            .await?
            .rows_affected();
            if added == 1 {
                changes.push(json!({ "orgId": org.org_id, "teamAdded": team }));
                touched.insert(org.org_id.clone());
            }
            if *idp {
                managed_now.insert((org.org_id.clone(), team.clone()));
            }
        }
    }
    // What "IdP entscheidet" gave before and no group gives now ends; organizations first
    // collected, so a team row of a removed organization is not handled twice.
    let in_outcome: BTreeSet<&str> = outcome.orgs.iter().map(|o| o.org_id.as_str()).collect();
    for (org_id, team_id) in before.iter().filter(|key| !managed_now.contains(*key)) {
        if team_id.is_empty() {
            if in_outcome.contains(org_id.as_str()) {
                continue;
            }
            crate::authz::lock_org(&mut *conn, org_id).await?;
            let role: Option<(String,)> =
                sqlx::query_as("SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2")
                    .bind(org_id)
                    .bind(user_id)
                    .fetch_optional(&mut *conn)
                    .await?;
            if role.as_ref().is_some_and(|(r,)| r != "owner") {
                crate::routes::members::remove_membership(&mut *conn, org_id, user_id).await?;
                changes.push(json!({ "orgId": org_id, "removed": true }));
                touched.insert(org_id.clone());
            }
        } else {
            let removed = sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
                .bind(team_id)
                .bind(user_id)
                .execute(&mut *conn)
                .await?
                .rows_affected();
            if removed == 1 {
                changes.push(json!({ "orgId": org_id, "teamRemoved": team_id }));
                touched.insert(org_id.clone());
            }
        }
    }
    sqlx::query(managed.clear()).bind(user_id).bind(managed.key()).execute(&mut *conn).await?;
    for (org_id, team_id) in &managed_now {
        // A membership ended by hand meanwhile is not managed any more.
        sqlx::query(managed.insert())
            .bind(user_id)
            .bind(managed.key())
            .bind(org_id)
            .bind(team_id)
            .bind(org_id)
            .bind(user_id)
            .execute(&mut *conn)
            .await?;
    }
    Ok((changes, touched))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(group: &str, org: &str, team: Option<&str>, role: &str, idp: bool) -> Rule {
        Rule {
            id: format!("{group}-{org}"),
            group_name: group.into(),
            org_id: org.into(),
            team_id: team.map(str::to_string),
            role: role.into(),
            idp_decides: i64::from(idp),
        }
    }

    fn groups(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    const LET_IN: Unmapped = Unmapped { refuse: false, org_id: None, role: String::new() };

    #[test]
    fn the_highest_role_wins_and_teams_add_up() {
        let rules = [
            rule("alle", "o1", None, "viewer", false),
            rule("vertrieb", "o1", Some("t-vertrieb"), "editor", false),
            rule("admins", "o1", Some("t-plattform"), "admin", true),
            rule("nord", "o2", None, "editor", true),
        ];
        let out = resolve(&rules, &groups(&["alle", "vertrieb", "admins"]), &LET_IN);
        assert!(!out.refused);
        assert_eq!(out.orgs.len(), 1);
        let o1 = &out.orgs[0];
        assert_eq!((o1.role.as_str(), o1.group.as_deref()), ("admin", Some("admins")));
        assert!(o1.idp_decides);
        assert_eq!(o1.teams, BTreeMap::from([("t-plattform".into(), true), ("t-vertrieb".into(), false)]));
        // The order of rules does not matter.
        let mut reversed = rules.clone();
        reversed.reverse();
        assert_eq!(resolve(&reversed, &groups(&["alle", "vertrieb", "admins"]), &LET_IN).orgs[0].role, "admin");
        let out = resolve(&rules, &groups(&["alle"]), &LET_IN);
        assert_eq!(out.orgs[0].role, "viewer");
        assert!(!out.orgs[0].idp_decides);
    }

    #[test]
    fn groups_compare_exactly() {
        let rules = [rule("Admins", "o1", None, "admin", false)];
        assert!(resolve(&rules, &groups(&["admins"]), &LET_IN).orgs.is_empty());
    }

    #[test]
    fn people_without_a_group_get_the_default_or_are_refused() {
        let rules = [rule("x", "o1", None, "admin", false)];
        let default = Unmapped { refuse: false, org_id: Some("o9".into()), role: "viewer".into() };
        let out = resolve(&rules, &groups(&["y"]), &default);
        assert_eq!(out.orgs.len(), 1);
        assert!(out.orgs[0].default && out.orgs[0].group.is_none() && !out.orgs[0].idp_decides);
        assert_eq!((out.orgs[0].org_id.as_str(), out.orgs[0].role.as_str()), ("o9", "viewer"));
        assert_eq!(resolve(&rules, &groups(&[]), &LET_IN), Outcome::default());
        let refuse = Unmapped { refuse: true, org_id: Some("o9".into()), role: "viewer".into() };
        assert!(resolve(&rules, &groups(&["y"]), &refuse).refused);
        // A matching group is never refused, and the default is not added on top.
        let out = resolve(&rules, &groups(&["x"]), &refuse);
        assert!(!out.refused && out.orgs.len() == 1 && !out.orgs[0].default);
    }

    #[test]
    fn roles_rank() {
        assert!(rank("viewer") < rank("editor") && rank("editor") < rank("admin") && rank("admin") < rank("owner"));
        assert_eq!(rank("0190-custom"), None);
    }
}
