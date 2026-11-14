//! The report as the API takes and answers it (docs/guide/reports.md), and as it is stored. The
//! UI's types come from these (`ui/src/api/generated/shapes.ts`).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::schedule::Schedule;

pub const MAX_NAME_CHARS: usize = 200;
pub const MAX_DESCRIPTION_CHARS: usize = 1000;
/// Panels a report may name.
pub const MAX_PANELS: usize = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ReportFormat {
    /// One PDF file with every panel, drawn by Kalzit's own renderer.
    Pdf,
    /// One CSV file per table result; several go in a zip file.
    Csv,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ReportLanguage {
    De,
    En,
}

impl ReportLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportLanguage::De => "de",
            ReportLanguage::En => "en",
        }
    }

    pub fn parse(raw: &str) -> Self {
        if raw == "de" { ReportLanguage::De } else { ReportLanguage::En }
    }

    pub fn mail(self) -> crate::mail::templates::Lang {
        match self {
            ReportLanguage::De => crate::mail::templates::Lang::De,
            ReportLanguage::En => crate::mail::templates::Lang::En,
        }
    }
}

/// A recipient: a member of the organization by id, or an address outside it (only while the
/// organization allows that, `reports.allow_external_recipients`). Exactly one of the two.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipient {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub email: Option<String>,
}

/// A time range as the dashboard writes it, resolved at each run (`reports::range`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(deny_unknown_fields)]
pub struct ReportTimeRange {
    pub from: String,
    pub to: String,
}

/// The body of `POST /reports`, `PUT /reports/{id}` (with `version`) and `POST /reports/preview`.
#[derive(Clone, Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportInput {
    pub name: String,
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub description: Option<String>,
    pub dashboard_id: String,
    /// The panels in the report, in the dashboard's order; absent or `null` for all of them.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub panel_ids: Option<Vec<String>>,
    /// Absent or `null`: the dashboard's own range.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub time_range: Option<ReportTimeRange>,
    /// Fixed values of the dashboard's variables; the others take the dashboard's saved value.
    #[serde(default)]
    #[cfg_attr(test, ts(optional = nullable, type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    pub schedule: Schedule,
    /// An IANA time zone: when the schedule runs and how times in the report read.
    pub time_zone: String,
    pub formats: Vec<ReportFormat>,
    pub language: ReportLanguage,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<Vec<Recipient>>", optional))]
    pub recipients: Vec<Recipient>,
    #[serde(default)]
    #[cfg_attr(test, ts(as = "Option<bool>", optional))]
    pub paused: bool,
    /// The version an update started from.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub version: Option<i64>,
}

/// A recipient as answered: members with their name and address as they are now.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RecipientView {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub user_id: Option<String>,
    /// `null` for a member who left the organization (left out of every run).
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub name: Option<String>,
    /// An address outside the organization.
    pub external: bool,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub id: String,
    pub name: String,
    pub description: String,
    pub dashboard_id: String,
    pub dashboard_title: String,
    pub panel_ids: Option<Vec<String>>,
    pub time_range: Option<ReportTimeRange>,
    #[cfg_attr(test, ts(type = "Record<string, unknown>"))]
    pub variables: BTreeMap<String, Value>,
    pub schedule: Schedule,
    pub time_zone: String,
    pub formats: Vec<ReportFormat>,
    pub language: ReportLanguage,
    pub recipients: Vec<RecipientView>,
    pub paused: bool,
    /// The next scheduled run; `null` while paused or while reports are off.
    pub next_run_at: Option<i64>,
    /// Whose current rights the runs use: who created the report.
    pub owner_id: String,
    pub owner_name: Option<String>,
    /// Set while a right the report needs is missing (the creator's, or the creator left); the
    /// report resumes at the first scheduled time the right is back. Missed times are not made up.
    pub suspended: Option<Suspension>,
    pub last_run: Option<ReportRun>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub version: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RunTrigger {
    Schedule,
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    /// Sent to every recipient.
    Ok,
    /// Sent, but some recipients were left out (no longer members, without read rights on the
    /// dashboard, external addresses no longer allowed or unsubscribed).
    Partial,
    Failed,
    /// Not run: a right the report needs is missing (the report is suspended).
    Suspended,
    /// A scheduled time that passed while no server ran or reports were off; not made up.
    Skipped,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Queued => "queued",
            RunStatus::Running => "running",
            RunStatus::Ok => "ok",
            RunStatus::Partial => "partial",
            RunStatus::Failed => "failed",
            RunStatus::Suspended => "suspended",
            RunStatus::Skipped => "skipped",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "queued" => RunStatus::Queued,
            "running" => RunStatus::Running,
            "ok" => RunStatus::Ok,
            "partial" => RunStatus::Partial,
            "suspended" => RunStatus::Suspended,
            "skipped" => RunStatus::Skipped,
            _ => RunStatus::Failed,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Suspension {
    pub code: String,
    pub message: String,
    pub since: i64,
}

/// Why a run failed or left recipients out: a stable code the UI translates and an English text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct RunError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReportRun {
    pub id: String,
    pub trigger: RunTrigger,
    /// 1, or 2 for the one retry five minutes after a failure.
    pub attempt: i64,
    pub triggered_by: Option<String>,
    pub scheduled_for: Option<i64>,
    pub status: RunStatus,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error: Option<RunError>,
    pub recipients: i64,
    pub sent: i64,
    pub skipped_recipients: i64,
    /// Recipients who got the PDF only: without `data:export`, and every outside address.
    pub csv_withheld: i64,
    pub attachment_bytes: Option<i64>,
    pub pages: Option<i64>,
}

/// The limits in force for an organization's reports.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReportLimits {
    pub max_reports_per_org: u64,
    pub max_runs_per_org_hour: u64,
    pub max_recipients: u64,
    pub max_attachment_bytes: u64,
    pub history_retention_days: u64,
}

/// `GET /reports/status`: whether reports run, what limits apply and whether mail can go out.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ReportsStatus {
    /// Reports run on this server (`reports.enabled`).
    pub enabled: bool,
    /// A mail server is set up; without one every run fails.
    pub mail_configured: bool,
    /// The organization allows addresses outside it.
    pub allow_external_recipients: bool,
    /// ... in these mail domains only; empty for any.
    pub external_domains: Vec<String>,
    pub limits: ReportLimits,
    pub reports: i64,
}

/// The answer of `POST /reports/{id}/send`: the run that was queued.
#[derive(Clone, Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SendNow {
    pub run: ReportRun,
}
