//! Alerting (docs/PLAN.md section 13, docs/api/alerting.md): the stored model of rules, contact
//! points, silences and history, the organization's alerting identity and the limits in force.
//! The scheduler evaluates the rules (`scheduler`, `evaluate`), the outbox delivers what they
//! notify by mail and webhook (`outbox`, `message`, `webhook`). The routes live in
//! `routes::alerting`.

pub mod contact_points;
pub mod eval;
pub mod evaluate;
pub mod history;
pub mod instances;
pub mod limits;
pub mod message;
pub mod outbox;
pub mod rule;
pub mod scheduler;
pub mod service_account;
pub mod silences;
pub mod webhook;
