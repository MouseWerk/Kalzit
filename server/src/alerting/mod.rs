//! Alerting (docs/PLAN.md section 13, docs/api/alerting.md): the stored model of rules, contact
//! points, silences, notification policies and history, the organization's alerting identity and
//! the limits in force. The scheduler evaluates the rules (`scheduler`, `evaluate`); direct rules
//! notify their contact points, rules routed through the policy tree (`policy`) fill groups that
//! the group dispatcher sends (`groups`); the outbox delivers by mail, webhook, Slack and Teams
//! (`outbox`, `message`, `group_message`, `webhook`, `chat`). The routes live in
//! `routes::alerting`.

pub mod chat;
pub mod contact_points;
pub mod eval;
pub mod evaluate;
pub mod group_message;
pub mod groups;
pub mod history;
pub mod instances;
pub mod limits;
pub mod message;
pub mod outbox;
pub mod policy;
pub mod rule;
pub mod scheduler;
pub mod service_account;
pub mod silences;
pub mod webhook;
