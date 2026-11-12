//! The notification policy tree of an organization (docs/PLAN.md section 13, "Routing, Gruppierung, Eskalation";
//! docs/api/alerting.md, "Notification policies"): the stored policies, their effective values
//! with inheritance resolved, and the ways an instance's labels take through the tree. Free of
//! the network; [`load`] reads the tree inside the caller's connection or transaction.
//!
//! Matching: every instance starts at the root, which matches everything. At each policy the
//! children are checked in their order; the first that matches takes the instance and it goes on
//! in that child's children. A matching child with `continue` lets the following siblings be
//! checked too. When no child matches, the way ends at the policy the instance is at. `group_by`
//! and the three times are inherited while a policy leaves them empty, contact points only while
//! it has none of its own; escalation steps are never inherited.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::AnyConnection;

use super::eval::Labels;
use super::silences::{Compiled, Matcher};
use crate::error::{ApiError, ApiResult};

/// The root's name.
pub const ROOT_NAME: &str = "Standard";
/// `group_by` of "Jede Instanz einzeln": one group per instance.
pub const EACH_INSTANCE: &str = "...";
/// The root's times when the update made it, and of a root that is still missing.
pub const ROOT_GROUP_WAIT_SECS: i64 = 30;
pub const ROOT_GROUP_INTERVAL_SECS: i64 = 300;
pub const ROOT_REPEAT_INTERVAL_SECS: i64 = 4 * 3600;

pub const MAX_MATCHERS: usize = 10;
pub const MAX_GROUP_BY: usize = 10;
pub const MAX_CONTACT_POINTS: usize = 5;
pub const MAX_ESCALATIONS: usize = 3;
pub const MAX_GROUP_WAIT_SECS: i64 = 3600;
pub const MIN_GROUP_INTERVAL_SECS: i64 = 30;
pub const MAX_GROUP_INTERVAL_SECS: i64 = 86_400;
pub const MAX_REPEAT_INTERVAL_SECS: i64 = 7 * 86_400;
pub const MIN_ESCALATION_WAIT_SECS: i64 = 300;
pub const MAX_ESCALATION_WAIT_SECS: i64 = 86_400;

/// One escalation step: after `wait_secs` of firing, the group goes to its contact points too.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Escalation {
    pub level: i64,
    pub wait_secs: i64,
    pub contact_point_ids: Vec<String>,
}

/// A policy as stored.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub id: String,
    pub org_id: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub name: String,
    pub matchers: Vec<Matcher>,
    /// `None` inherits.
    pub group_by: Option<Vec<String>>,
    pub group_wait_secs: Option<i64>,
    pub group_interval_secs: Option<i64>,
    /// `Some(0)` is off.
    pub repeat_interval_secs: Option<i64>,
    pub continue_matching: bool,
    pub contact_point_ids: Vec<String>,
    pub escalations: Vec<Escalation>,
    pub version: i64,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_by: Option<String>,
    pub updated_at: i64,
}

impl Stored {
    /// The root an organization has before anything was stored: no contact points.
    pub fn default_root(org_id: &str, now: i64) -> Self {
        Stored {
            id: org_id.to_string(),
            org_id: org_id.to_string(),
            parent_id: None,
            position: 0,
            name: ROOT_NAME.to_string(),
            matchers: Vec::new(),
            group_by: Some(vec![super::rule::RULE_NAME_LABEL.to_string()]),
            group_wait_secs: Some(ROOT_GROUP_WAIT_SECS),
            group_interval_secs: Some(ROOT_GROUP_INTERVAL_SECS),
            repeat_interval_secs: Some(ROOT_REPEAT_INTERVAL_SECS),
            continue_matching: false,
            contact_point_ids: Vec::new(),
            escalations: Vec::new(),
            version: 1,
            created_by: None,
            created_at: now,
            updated_by: None,
            updated_at: now,
        }
    }

    pub fn is_root(&self) -> bool {
        self.parent_id.is_none()
    }
}

type Row = (
    String,
    String,
    Option<String>,
    i64,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    i64,
    i64,
    Option<String>,
    i64,
    Option<String>,
    i64,
);

/// Makes the organization's root when it has none yet (an organization made after the update).
pub async fn ensure_root(conn: &mut AnyConnection, org_id: &str, now: i64) -> ApiResult<()> {
    let root = Stored::default_root(org_id, now);
    sqlx::query(
        "INSERT INTO alert_policies (id, org_id, parent_id, position, name, matchers, group_by, group_wait_secs, \
         group_interval_secs, repeat_interval_secs, continue_matching, version, created_at, updated_at) \
         VALUES ($1, $1, NULL, 0, $2, '[]', $3, $4, $5, $6, 0, 1, $7, $7) ON CONFLICT DO NOTHING",
    )
    .bind(org_id)
    .bind(&root.name)
    .bind(serde_json::to_string(&root.group_by).expect("labels always serialize"))
    .bind(root.group_wait_secs)
    .bind(root.group_interval_secs)
    .bind(root.repeat_interval_secs)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Every policy of the organization, with its contact points and escalation steps, in no order.
pub async fn load(conn: &mut AnyConnection, org_id: &str) -> ApiResult<Vec<Stored>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, org_id, parent_id, position, name, matchers, group_by, group_wait_secs, group_interval_secs, \
         repeat_interval_secs, continue_matching, version, created_by, created_at, updated_by, updated_at \
         FROM alert_policies WHERE org_id = $1",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let links: Vec<(String, i64, String)> = sqlx::query_as(
        "SELECT l.policy_id, l.level, l.contact_point_id FROM alert_policy_contact_points l \
         JOIN alert_policies p ON p.id = l.policy_id WHERE p.org_id = $1 ORDER BY l.contact_point_id",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let steps: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT e.policy_id, e.level, e.wait_secs FROM alert_policy_escalations e \
         JOIN alert_policies p ON p.id = e.policy_id WHERE p.org_id = $1 ORDER BY e.level",
    )
    .bind(org_id)
    .fetch_all(&mut *conn)
    .await?;
    let broken =
        |id: &str, what: &str| ApiError::internal("alert policy", format!("stored {what} of {id} does not parse"));
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let matchers: Vec<Matcher> = serde_json::from_str(&r.5).map_err(|_| broken(&r.0, "matchers"))?;
        let group_by: Option<Vec<String>> = match &r.6 {
            Some(text) => Some(serde_json::from_str(text).map_err(|_| broken(&r.0, "group_by"))?),
            None => None,
        };
        let contact_point_ids =
            links.iter().filter(|(p, level, _)| *p == r.0 && *level == 0).map(|(_, _, c)| c.clone()).collect();
        let escalations = steps
            .iter()
            .filter(|(p, _, _)| *p == r.0)
            .map(|(_, level, wait)| Escalation {
                level: *level,
                wait_secs: *wait,
                contact_point_ids: links
                    .iter()
                    .filter(|(p, l, _)| *p == r.0 && l == level)
                    .map(|(_, _, c)| c.clone())
                    .collect(),
            })
            .collect();
        out.push(Stored {
            id: r.0,
            org_id: r.1,
            parent_id: r.2,
            position: r.3,
            name: r.4,
            matchers,
            group_by,
            group_wait_secs: r.7,
            group_interval_secs: r.8,
            repeat_interval_secs: r.9,
            continue_matching: r.10 != 0,
            contact_point_ids,
            escalations,
            version: r.11,
            created_by: r.12,
            created_at: r.13,
            updated_by: r.14,
            updated_at: r.15,
        });
    }
    Ok(out)
}

/// What applies to the instances that end at a policy, inheritance resolved.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    pub group_by: Vec<String>,
    pub group_wait_secs: i64,
    pub group_interval_secs: i64,
    /// 0 is off.
    pub repeat_interval_secs: i64,
    pub contact_point_ids: Vec<String>,
    /// The policy the contact points come from (itself or an ancestor), `None` when none has any.
    pub contact_points_from: Option<String>,
    /// A contact point is reached: the effective ones or one of an escalation step.
    pub delivers: bool,
}

impl Effective {
    /// The repeat interval as it acts: off, or at least the group interval.
    pub fn repeat_ms(&self) -> Option<i64> {
        (self.repeat_interval_secs > 0)
            .then(|| self.repeat_interval_secs.max(self.group_interval_secs).saturating_mul(1000))
    }
}

/// One policy of the tree.
#[derive(Clone, Debug)]
pub struct Node {
    pub policy: Stored,
    /// 0 for the root.
    pub depth: usize,
    pub parent: Option<usize>,
    /// In sibling order.
    pub children: Vec<usize>,
    pub effective: Effective,
    matchers: Compiled,
}

/// The tree of one organization, depth first in sibling order (the root first).
#[derive(Clone, Debug)]
pub struct Tree {
    nodes: Vec<Node>,
}

impl Tree {
    /// Builds the tree from the stored policies. Without a stored root (an organization that has
    /// not opened its policies yet) the root is the default one. Policies whose parent is missing
    /// are left out.
    pub fn new(org_id: &str, mut policies: Vec<Stored>) -> Tree {
        policies.sort_by(|a, b| a.position.cmp(&b.position).then_with(|| a.id.cmp(&b.id)));
        let root = match policies.iter().position(Stored::is_root) {
            Some(i) => policies.remove(i),
            None => Stored::default_root(org_id, 0),
        };
        let mut tree = Tree { nodes: Vec::with_capacity(policies.len() + 1) };
        let effective = root_effective(&root);
        tree.nodes.push(Node {
            matchers: Compiled::new(&[]),
            policy: root,
            depth: 0,
            parent: None,
            children: Vec::new(),
            effective,
        });
        tree.add_children(0, &mut policies);
        tree
    }

    fn add_children(&mut self, parent: usize, rest: &mut Vec<Stored>) {
        let parent_id = self.nodes[parent].policy.id.clone();
        let mut i = 0;
        let mut mine = Vec::new();
        while i < rest.len() {
            if rest[i].parent_id.as_deref() == Some(parent_id.as_str()) {
                mine.push(rest.remove(i));
            } else {
                i += 1;
            }
        }
        for policy in mine {
            let effective = inherit(&self.nodes[parent].effective, &policy);
            let index = self.nodes.len();
            self.nodes.push(Node {
                matchers: Compiled::new(&policy.matchers),
                depth: self.nodes[parent].depth + 1,
                parent: Some(parent),
                children: Vec::new(),
                effective,
                policy,
            });
            self.nodes[parent].children.push(index);
            self.add_children(index, rest);
        }
    }

    pub fn nodes(&self) -> &[Node] {
        &self.nodes
    }

    pub fn root(&self) -> &Node {
        &self.nodes[0]
    }

    pub fn find(&self, id: &str) -> Option<usize> {
        self.nodes.iter().position(|n| n.policy.id == id)
    }

    pub fn node(&self, index: usize) -> &Node {
        &self.nodes[index]
    }

    /// The policies from the root to `index`.
    pub fn path(&self, index: usize) -> Vec<&Node> {
        let mut out = vec![&self.nodes[index]];
        let mut at = index;
        while let Some(parent) = self.nodes[at].parent {
            out.push(&self.nodes[parent]);
            at = parent;
        }
        out.reverse();
        out
    }

    /// `index` and everything below it.
    pub fn subtree(&self, index: usize) -> Vec<usize> {
        let mut out = vec![index];
        let mut i = 0;
        while i < out.len() {
            out.extend(self.nodes[out[i]].children.iter().copied());
            i += 1;
        }
        out
    }

    /// The ways `labels` take: the policy each ends at, in tree order.
    pub fn routes(&self, labels: &Labels) -> Vec<usize> {
        let mut out = Vec::new();
        self.walk(0, labels, &mut out);
        out
    }

    fn walk(&self, index: usize, labels: &Labels, out: &mut Vec<usize>) -> bool {
        let node = &self.nodes[index];
        if index != 0 && !node.matchers.matches(labels) {
            return false;
        }
        let mut taken = false;
        for &child in &node.children {
            if self.walk(child, labels, out) {
                taken = true;
                if !self.nodes[child].policy.continue_matching {
                    break;
                }
            }
        }
        if !taken {
            out.push(index);
        }
        true
    }
}

fn root_effective(root: &Stored) -> Effective {
    let contact_point_ids = root.contact_point_ids.clone();
    let delivers = !contact_point_ids.is_empty() || root.escalations.iter().any(|e| !e.contact_point_ids.is_empty());
    Effective {
        group_by: root.group_by.clone().unwrap_or_else(|| vec![super::rule::RULE_NAME_LABEL.to_string()]),
        group_wait_secs: root.group_wait_secs.unwrap_or(ROOT_GROUP_WAIT_SECS),
        group_interval_secs: root.group_interval_secs.unwrap_or(ROOT_GROUP_INTERVAL_SECS),
        repeat_interval_secs: root.repeat_interval_secs.unwrap_or(ROOT_REPEAT_INTERVAL_SECS),
        contact_points_from: (!contact_point_ids.is_empty()).then(|| root.id.clone()),
        contact_point_ids,
        delivers,
    }
}

fn inherit(parent: &Effective, policy: &Stored) -> Effective {
    let (contact_point_ids, contact_points_from) = if policy.contact_point_ids.is_empty() {
        (parent.contact_point_ids.clone(), parent.contact_points_from.clone())
    } else {
        (policy.contact_point_ids.clone(), Some(policy.id.clone()))
    };
    let delivers = !contact_point_ids.is_empty() || policy.escalations.iter().any(|e| !e.contact_point_ids.is_empty());
    Effective {
        group_by: policy.group_by.clone().unwrap_or_else(|| parent.group_by.clone()),
        group_wait_secs: policy.group_wait_secs.unwrap_or(parent.group_wait_secs),
        group_interval_secs: policy.group_interval_secs.unwrap_or(parent.group_interval_secs),
        repeat_interval_secs: policy.repeat_interval_secs.unwrap_or(parent.repeat_interval_secs),
        contact_point_ids,
        contact_points_from,
        delivers,
    }
}

/// The labels policies and silences see of an instance: its own, the rule's (which win), and the
/// rule's name under `alertname`.
pub fn alert_labels(instance: &Labels, rule_labels: &Labels, rule_name: &str) -> Labels {
    let mut all = instance.clone();
    all.extend(rule_labels.iter().map(|(k, v)| (k.clone(), v.clone())));
    all.insert(super::rule::RULE_NAME_LABEL.to_string(), rule_name.to_string());
    all
}

/// The group of `labels` at a policy grouping by `group_by`: its key (SHA-256 of the policy id
/// and the group's labels, each length-prefixed) and its labels.
pub fn group_of(policy_id: &str, group_by: &[String], labels: &Labels) -> (String, Labels) {
    let group_labels: Labels = if group_by.iter().any(|g| g == EACH_INSTANCE) {
        labels.clone()
    } else {
        group_by.iter().filter_map(|name| labels.get(name).map(|v| (name.clone(), v.clone()))).collect()
    };
    (key(policy_id, &group_labels, false), group_labels)
}

/// The catch-all group of a policy, for new instances beyond the organization's active groups.
pub fn catch_all_key(policy_id: &str) -> String {
    key(policy_id, &BTreeMap::new(), true)
}

fn key(policy_id: &str, labels: &Labels, catch_all: bool) -> String {
    let mut hash = Sha256::new();
    let mut part = |text: &str| {
        hash.update((text.len() as u64).to_be_bytes());
        hash.update(text.as_bytes());
    };
    part(policy_id);
    if catch_all {
        part("\u{0}catch-all");
    }
    for (k, v) in labels {
        part(k);
        part(v);
    }
    hex::encode(hash.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerting::silences::MatchOp;

    fn labels(pairs: &[(&str, &str)]) -> Labels {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn m(label: &str, op: MatchOp, value: &str) -> Matcher {
        Matcher { label: label.into(), op, value: value.into() }
    }

    fn policy(id: &str, parent: &str, position: i64, matchers: Vec<Matcher>) -> Stored {
        Stored {
            id: id.into(),
            parent_id: Some(parent.into()),
            position,
            name: id.into(),
            matchers,
            group_by: None,
            group_wait_secs: None,
            group_interval_secs: None,
            repeat_interval_secs: None,
            ..Stored::default_root("o", 0)
        }
    }

    /// The tree of the board: Standard › Lager › Lager kritisch, Lager-API Nacht; Tickets für
    /// Kritisches (continue); Vertrieb.
    fn board() -> Tree {
        let mut root = Stored::default_root("o", 0);
        root.contact_point_ids = vec!["cp-standard".into()];
        let mut lager = policy("lager", "o", 0, vec![m("team", MatchOp::Eq, "lager")]);
        lager.contact_point_ids = vec!["cp-lager".into()];
        let mut kritisch = policy(
            "kritisch",
            "lager",
            0,
            vec![m("severity", MatchOp::Eq, "kritisch"), m("instance", MatchOp::NotRegex, "lager-api-test.*")],
        );
        kritisch.group_wait_secs = Some(0);
        kritisch.group_by = Some(vec!["alertname".into(), "team".into()]);
        kritisch.escalations =
            vec![Escalation { level: 1, wait_secs: 900, contact_point_ids: vec!["cp-on-call".into()] }];
        let nacht = policy(
            "nacht",
            "lager",
            1,
            vec![m("alertname", MatchOp::Regex, "Lager-API.*"), m("region", MatchOp::Ne, "test")],
        );
        let mut tickets = policy("tickets", "o", 1, vec![m("severity", MatchOp::Regex, "kritisch|hoch")]);
        tickets.continue_matching = true;
        tickets.contact_point_ids = vec!["cp-tickets".into()];
        tickets.group_by = Some(vec![EACH_INSTANCE.into()]);
        tickets.repeat_interval_secs = Some(0);
        let vertrieb = policy("vertrieb", "o", 2, vec![m("team", MatchOp::Eq, "vertrieb")]);
        // Stored in no particular order, with an orphan.
        let orphan = policy("orphan", "gone", 0, Vec::new());
        Tree::new("o", vec![vertrieb, nacht, tickets, kritisch, orphan, lager, root])
    }

    fn ids(tree: &Tree, routes: &[usize]) -> Vec<String> {
        routes.iter().map(|i| tree.node(*i).policy.id.clone()).collect()
    }

    #[test]
    fn instances_take_the_first_matching_child_and_continue_when_asked() {
        type Case<'a> = (&'a [(&'a str, &'a str)], &'a [&'a str]);
        let tree = board();
        let cases: &[Case] = &[
            // Nothing below the root matches: the root.
            (&[("alertname", "Nachtlauf Inventur")], &["o"]),
            // Lager, nothing below it: Lager.
            (&[("team", "lager"), ("alertname", "Kommissionier-Rückstand")], &["lager"]),
            // The first child of Lager wins over the second, which would match too.
            (
                &[
                    ("team", "lager"),
                    ("severity", "kritisch"),
                    ("alertname", "Lager-API Latenz"),
                    ("instance", "lager-api-1"),
                ],
                &["kritisch"],
            ),
            // `!~` keeps the test instance out of "kritisch": "nacht" is next.
            (
                &[
                    ("team", "lager"),
                    ("severity", "kritisch"),
                    ("alertname", "Lager-API Latenz"),
                    ("instance", "lager-api-test-1"),
                ],
                &["nacht"],
            ),
            // `!=` on a missing label matches; "Lager" ends at "nacht".
            (&[("team", "lager"), ("alertname", "Lager-API Fehler")], &["nacht"]),
            (&[("team", "lager"), ("alertname", "Lager-API Fehler"), ("region", "test")], &["lager"]),
            // Tickets has continue: the instance goes on to Vertrieb too.
            (&[("team", "vertrieb"), ("severity", "hoch")], &["tickets", "vertrieb"]),
            // Lager comes before Tickets and has no continue: only Lager's way.
            (&[("team", "lager"), ("severity", "hoch")], &["lager"]),
            // A regular expression matches the whole value only.
            (&[("severity", "hochkritisch")], &["o"]),
            (&[("severity", "kritisch")], &["tickets"]),
        ];
        for (input, expected) in cases {
            let got = ids(&tree, &tree.routes(&labels(input)));
            assert_eq!(got, *expected, "{input:?}");
        }
    }

    #[test]
    fn values_are_inherited_until_a_policy_sets_them() {
        let tree = board();
        let kritisch = tree.node(tree.find("kritisch").unwrap());
        assert_eq!(kritisch.depth, 2);
        assert_eq!(kritisch.effective.group_wait_secs, 0);
        assert_eq!(kritisch.effective.group_interval_secs, ROOT_GROUP_INTERVAL_SECS);
        assert_eq!(kritisch.effective.repeat_interval_secs, ROOT_REPEAT_INTERVAL_SECS);
        assert_eq!(kritisch.effective.group_by, ["alertname", "team"]);
        assert_eq!(kritisch.effective.contact_point_ids, ["cp-lager"]);
        assert_eq!(kritisch.effective.contact_points_from.as_deref(), Some("lager"));
        let nacht = tree.node(tree.find("nacht").unwrap());
        assert_eq!(nacht.effective.group_by, ["alertname"]);
        assert!(nacht.policy.escalations.is_empty(), "escalation steps are not inherited");
        let tickets = tree.node(tree.find("tickets").unwrap());
        assert_eq!(tickets.effective.repeat_interval_secs, 0);
        assert_eq!(tickets.effective.repeat_ms(), None);
        assert_eq!(tree.root().effective.repeat_ms(), Some(ROOT_REPEAT_INTERVAL_SECS * 1000));
        assert!(tree.find("orphan").is_none(), "a policy without its parent is left out");
        let path: Vec<&str> = tree.path(tree.find("nacht").unwrap()).iter().map(|n| n.policy.name.as_str()).collect();
        assert_eq!(path, ["Standard", "lager", "nacht"]);
        // Depth first in sibling order.
        let order: Vec<&str> = tree.nodes().iter().map(|n| n.policy.id.as_str()).collect();
        assert_eq!(order, ["o", "lager", "kritisch", "nacht", "tickets", "vertrieb"]);
        assert_eq!(tree.subtree(tree.find("lager").unwrap()).len(), 3);
    }

    #[test]
    fn a_root_without_contact_points_does_not_deliver() {
        let tree = Tree::new("o", Vec::new());
        assert_eq!(tree.root().policy.id, "o");
        assert!(!tree.root().effective.delivers);
        assert_eq!(tree.routes(&labels(&[("x", "y")])), [0]);
        let mut escalating = policy("e", "o", 0, Vec::new());
        escalating.escalations = vec![Escalation { level: 1, wait_secs: 600, contact_point_ids: vec!["cp".into()] }];
        let tree = Tree::new("o", vec![escalating]);
        assert!(tree.node(1).effective.delivers, "an escalation step delivers");
    }

    #[test]
    fn groups_follow_group_by() {
        let all = labels(&[("alertname", "Latenz"), ("team", "lager"), ("instance", "a")]);
        let (k1, g1) = group_of("p", &["alertname".to_string(), "team".to_string()], &all);
        assert_eq!(g1, labels(&[("alertname", "Latenz"), ("team", "lager")]));
        let other = labels(&[("alertname", "Latenz"), ("team", "lager"), ("instance", "b")]);
        assert_eq!(group_of("p", &["alertname".to_string(), "team".to_string()], &other).0, k1);
        assert_ne!(group_of("q", &["alertname".to_string(), "team".to_string()], &other).0, k1, "per policy");
        let (each_a, ga) = group_of("p", &[EACH_INSTANCE.to_string()], &all);
        assert_eq!(ga, all);
        assert_ne!(group_of("p", &[EACH_INSTANCE.to_string()], &other).0, each_a);
        let (one, g) = group_of("p", &[], &all);
        assert!(g.is_empty());
        assert_eq!(group_of("p", &[], &other).0, one);
        assert_ne!(catch_all_key("p"), one);
        // The rule's labels win over the instance's, and `alertname` is the rule's name.
        let full = alert_labels(&labels(&[("team", "x"), ("host", "a")]), &labels(&[("team", "lager")]), "R");
        assert_eq!(full, labels(&[("alertname", "R"), ("host", "a"), ("team", "lager")]));
    }
}
