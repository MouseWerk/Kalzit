//! Alerting (docs/PLAN.md section 13, docs/api/alerting.md): the stored model of rules, contact
//! points, silences and history, the organization's alerting identity and the limits in force.
//! The routes live in `routes::alerting`.

pub mod contact_points;
pub mod history;
pub mod limits;
pub mod rule;
pub mod service_account;
pub mod silences;
