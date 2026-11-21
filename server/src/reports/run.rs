//! One run of a report, from the rights check to the mail (docs/guide/reports.md, "Runs").
//!
//! - The report runs with the **current** rights of the person who created it, checked at every
//!   run: a member of the organization, not disabled, holding `reports:write`, able to read the
//!   dashboard, and `data:export` for CSV files. While one of them is missing the report is
//!   suspended (the run is recorded as `suspended` with the reason); it resumes at the first run
//!   the rights are back. Only the dashboard's stored queries run.
//! - Every member among the recipients must be able to read the dashboard at the run; one who
//!   cannot (or left, or was disabled) is left out and counted. Addresses outside the organization
//!   go out only while the organization allows them (and their domain), never after they
//!   unsubscribed, and their mails carry a one-click unsubscribe address and no other link.
//! - A run fails as a whole: when a panel's query or steps fail, the files are larger than
//!   `reports.max_attachment_bytes` or the mail server cannot be reached, nothing goes to the
//!   recipients, not even part of the report. A failed first attempt is tried once more after five
//!   minutes; when that fails too, the creator gets a mail, at most one per report and day.
//!   Recipients reached by the first attempt are not mailed again.

use std::collections::BTreeSet;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::{Value, json};

use super::gather::{Content, Gathered, Spec};
use super::model::{
    RecipientView, Report, ReportFormat, ReportLanguage, ReportRun, ReportTimeRange, RunError, RunStatus, RunTrigger,
    Suspension,
};
use super::schedule::Schedule;
use crate::app::AppState;
use crate::authz::{OrgCtx, Permission, Resource};
use crate::error::ApiResult;
use crate::mail::message::{Attachment, Content as MailContent};
use crate::mail::templates::{html, text};

/// The pause before the one retry of a failed run.
pub const RETRY_AFTER_MS: i64 = 5 * 60_000;
/// How long a claimed run is left to its worker before it counts as interrupted.
pub const LEASE_MS: i64 = 30 * 60_000;
/// At most one failure mail per report in this time.
pub const FAILURE_MAIL_EVERY_MS: i64 = 86_400_000;
/// Time per recipient.
const MAIL_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------------------------
// The stored report

pub(crate) const COLUMNS: &str = "SELECT r.id, r.org_id, r.name, r.description, r.dashboard_id, r.panel_ids, r.time_from, \
     r.time_to, r.variables, r.schedule, r.time_zone, r.formats, r.language, r.recipients, r.paused, r.next_run_at, \
     r.owner_id, r.suspended_reason, r.suspended_at, r.failure_mailed_at, r.unsubscribe_key, r.version, r.created_by, r.created_at, \
     r.updated_at FROM reports r";

#[derive(Clone, Debug, sqlx::FromRow)]
pub struct Stored {
    pub id: String,
    pub org_id: String,
    pub name: String,
    pub description: String,
    pub dashboard_id: String,
    pub panel_ids: Option<String>,
    pub time_from: Option<String>,
    pub time_to: Option<String>,
    pub variables: String,
    pub schedule: String,
    pub time_zone: String,
    pub formats: String,
    pub language: String,
    pub recipients: String,
    pub paused: i64,
    pub next_run_at: Option<i64>,
    pub owner_id: String,
    pub suspended_reason: Option<String>,
    pub suspended_at: Option<i64>,
    pub failure_mailed_at: Option<i64>,
    pub unsubscribe_key: String,
    pub version: i64,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Stored {
    pub fn panel_ids(&self) -> Option<Vec<String>> {
        self.panel_ids.as_deref().and_then(|p| serde_json::from_str(p).ok())
    }
    pub fn time_range(&self) -> Option<ReportTimeRange> {
        Some(ReportTimeRange { from: self.time_from.clone()?, to: self.time_to.clone()? })
    }
    pub fn variables(&self) -> std::collections::BTreeMap<String, Value> {
        serde_json::from_str(&self.variables).unwrap_or_default()
    }
    pub fn schedule(&self) -> Option<Schedule> {
        serde_json::from_str(&self.schedule).ok()
    }
    pub fn formats(&self) -> Vec<ReportFormat> {
        serde_json::from_str(&self.formats).unwrap_or_default()
    }
    pub fn language(&self) -> ReportLanguage {
        ReportLanguage::parse(&self.language)
    }
    pub fn recipients(&self) -> Vec<super::model::Recipient> {
        serde_json::from_str(&self.recipients).unwrap_or_default()
    }
    pub fn zone(&self) -> chrono_tz::Tz {
        self.time_zone.parse().unwrap_or(chrono_tz::UTC)
    }
    /// The suspension's reason as `{code, message}`.
    pub fn suspension(&self) -> Option<Suspension> {
        let raw = self.suspended_reason.as_deref()?;
        let e: Value = serde_json::from_str(raw).ok()?;
        Some(Suspension {
            code: e["code"].as_str().unwrap_or_default().to_string(),
            message: e["message"].as_str().unwrap_or_default().to_string(),
            since: self.suspended_at.unwrap_or_default(),
        })
    }
}

pub async fn load<'e, E>(db: E, org_id: &str, id: &str) -> ApiResult<Option<Stored>>
where
    E: sqlx::Executor<'e, Database = sqlx::Any>,
{
    if uuid::Uuid::parse_str(id).is_err() {
        return Ok(None);
    }
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!("{COLUMNS} WHERE r.org_id = $1 AND r.id = $2")))
        .bind(org_id)
        .bind(id)
        .fetch_optional(db)
        .await?)
}

pub(crate) const RUN_COLUMNS: &str = "SELECT id, trigger_kind, triggered_by, scheduled_for, status, attempt, created_at, \
     started_at, finished_at, error_code, error_message, recipients, sent, skipped_recipients, csv_withheld, attachment_bytes, \
     pages \
     FROM report_runs";

#[derive(sqlx::FromRow)]
pub struct RunRow {
    pub id: String,
    pub trigger_kind: String,
    pub triggered_by: Option<String>,
    pub scheduled_for: Option<i64>,
    pub status: String,
    pub attempt: i64,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub recipients: i64,
    pub sent: i64,
    pub skipped_recipients: i64,
    pub csv_withheld: i64,
    pub attachment_bytes: Option<i64>,
    pub pages: Option<i64>,
}

impl RunRow {
    pub fn view(self) -> ReportRun {
        ReportRun {
            id: self.id,
            trigger: if self.trigger_kind == "manual" { RunTrigger::Manual } else { RunTrigger::Schedule },
            attempt: self.attempt,
            triggered_by: self.triggered_by,
            scheduled_for: self.scheduled_for,
            status: RunStatus::parse(&self.status),
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
            error: self.error_code.map(|code| RunError { code, message: self.error_message.unwrap_or_default() }),
            recipients: self.recipients,
            sent: self.sent,
            skipped_recipients: self.skipped_recipients,
            csv_withheld: self.csv_withheld,
            attachment_bytes: self.attachment_bytes,
            pages: self.pages,
        }
    }
}

/// The report as answered, with its recipients as they are now and its last run.
pub async fn view(state: &AppState, s: Stored) -> ApiResult<Report> {
    let dashboard_title: Option<(String,)> = sqlx::query_as("SELECT title FROM dashboards WHERE id = $1")
        .bind(&s.dashboard_id)
        .fetch_optional(&state.db)
        .await?;
    let owner_name: Option<(String,)> =
        sqlx::query_as("SELECT name FROM users WHERE id = $1").bind(&s.owner_id).fetch_optional(&state.db).await?;
    let mut recipients = Vec::new();
    for r in s.recipients() {
        match (r.user_id, r.email) {
            (Some(user_id), _) => {
                let row: Option<(String, String)> = sqlx::query_as(
                    "SELECT u.email, u.name FROM users u JOIN org_members m ON m.user_id = u.id AND m.org_id = $1 \
                     WHERE u.id = $2",
                )
                .bind(&s.org_id)
                .bind(&user_id)
                .fetch_optional(&state.db)
                .await?;
                recipients.push(RecipientView {
                    user_id: Some(user_id),
                    email: row.as_ref().map(|r| r.0.clone()),
                    name: row.map(|r| r.1),
                    external: false,
                });
            }
            (None, email) => recipients.push(RecipientView { user_id: None, email, name: None, external: true }),
        }
    }
    let last: Option<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RUN_COLUMNS} WHERE report_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1"
    )))
    .bind(&s.id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Report {
        dashboard_title: dashboard_title.map(|t| t.0).unwrap_or_default(),
        panel_ids: s.panel_ids(),
        time_range: s.time_range(),
        variables: s.variables(),
        schedule: s.schedule().unwrap_or(Schedule::Daily { time: "08:00".into() }),
        formats: s.formats(),
        language: s.language(),
        recipients,
        paused: s.paused != 0,
        next_run_at: if s.paused != 0 { None } else { s.next_run_at },
        owner_name: owner_name.map(|n| n.0),
        suspended: s.suspension(),
        last_run: last.map(RunRow::view),
        id: s.id,
        name: s.name,
        description: s.description,
        dashboard_id: s.dashboard_id,
        time_zone: s.time_zone,
        owner_id: s.owner_id,
        created_by: s.created_by,
        created_at: s.created_at,
        updated_at: s.updated_at,
        version: s.version,
    })
}

// ---------------------------------------------------------------------------------------------
// Rights

/// The member `user_id` of `org_id` as a caller, with their current rights; `None` when they are
/// no member, disabled or gone.
pub async fn member_ctx(state: &AppState, org_id: &str, user_id: &str) -> ApiResult<Option<OrgCtx>> {
    let row: Option<(String, String, String, i64, String)> = sqlx::query_as(
        "SELECT u.id, u.email, u.name, u.is_server_admin, m.role FROM users u \
         JOIN org_members m ON m.user_id = u.id AND m.org_id = $1 WHERE u.id = $2 AND u.disabled = 0",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((id, email, name, is_server_admin, role)) = row else { return Ok(None) };
    let permissions = crate::authz::effective_permissions(&state.db, &id, org_id, &role).await?;
    Ok(Some(OrgCtx {
        user: crate::auth::SessionUser { id, email, name, is_server_admin },
        org_id: org_id.to_string(),
        role,
        permissions,
        at_ms: state.clock.now_ms(),
    }))
}

/// Whether `ctx` may read the dashboard now.
pub async fn reads_dashboard(state: &AppState, ctx: &OrgCtx, dashboard_id: &str) -> ApiResult<bool> {
    match crate::authz::check_resource(&state.db, ctx, Permission::DashboardsRead, Resource::Dashboard(dashboard_id))
        .await
    {
        Ok(()) => {}
        Err(e) if e.code == "not_found" || e.code == "forbidden" => return Ok(false),
        Err(e) => return Err(e),
    }
    let trashed: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT deleted_at FROM dashboards WHERE id = $1 AND org_id = $2")
            .bind(dashboard_id)
            .bind(&ctx.org_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(matches!(trashed, Some((None,))))
}

/// A stable code and an English text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub code: String,
    pub message: String,
}

fn problem(code: &str, message: impl Into<String>) -> Problem {
    Problem { code: code.to_string(), message: message.into() }
}

/// The creator as the caller the report runs as, or what is missing.
pub async fn creator_ctx(state: &AppState, report: &Stored) -> ApiResult<Result<OrgCtx, Problem>> {
    let Some(ctx) = member_ctx(state, &report.org_id, &report.owner_id).await? else {
        return Ok(Err(problem(
            "reports.creator_gone",
            "the person who created this report is no longer an active member of the organization",
        )));
    };
    if !ctx.permissions.contains(&Permission::ReportsWrite) {
        return Ok(Err(problem(
            "reports.creator_no_permission",
            "the person who created this report lost reports:write",
        )));
    }
    if !reads_dashboard(state, &ctx, &report.dashboard_id).await? {
        return Ok(Err(problem(
            "reports.creator_no_dashboard",
            "the person who created this report can no longer read its dashboard, or it is in the trash",
        )));
    }
    if report.formats().contains(&ReportFormat::Csv) && !ctx.permissions.contains(&Permission::DataExport) {
        return Ok(Err(problem(
            "reports.creator_no_export",
            "the person who created this report lost data:export, which CSV files need",
        )));
    }
    Ok(Ok(ctx))
}

// ---------------------------------------------------------------------------------------------
// Mail

/// Why a mail did not go out.
#[derive(Clone, Debug)]
pub struct MailFailure {
    pub reason: String,
    /// The mail server could not be reached at all (as opposed to refusing one address).
    pub connection: bool,
}

/// Sends report mails: the mail server in the server, a fake in the tests.
pub trait Mailer: Send + Sync {
    fn send<'a>(
        &'a self,
        to: &'a str,
        content: &'a MailContent,
        attachments: &'a [Attachment],
        unsubscribe: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), MailFailure>>;
}

/// The mail server of Administration > Mail.
pub struct SmtpMailer {
    pub state: AppState,
}

impl Mailer for SmtpMailer {
    fn send<'a>(
        &'a self,
        to: &'a str,
        content: &'a MailContent,
        attachments: &'a [Attachment],
        unsubscribe: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), MailFailure>> {
        Box::pin(async move {
            let effective = crate::mail::settings::effective(&self.state)
                .await
                .map_err(|e| MailFailure { reason: e.message, connection: true })?;
            if !effective.configured() {
                return Err(MailFailure { reason: "mail.not_configured".into(), connection: true });
            }
            match tokio::time::timeout(
                MAIL_TIMEOUT,
                crate::mail::send_with(&self.state, &effective, to, content, attachments, unsubscribe),
            )
            .await
            {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(MailFailure { reason: e.reason.to_string(), connection: e.connection }),
                Err(_) => Err(MailFailure { reason: "timeout".into(), connection: true }),
            }
        })
    }
}

/// The hash an outside address is kept as among the unsubscribes: an HMAC of the normalized
/// address with the report's own key, so it holds across a rotation of the secrets key.
pub fn address_hash(report_key: &str, email: &str) -> String {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(report_key.as_bytes()).expect("HMAC takes any key");
    mac.update(b"kalzit-report-address\0");
    mac.update(email.trim().to_lowercase().as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn token_mac(report_key: &str, report_id: &str, hash: &str) -> Vec<u8> {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(report_key.as_bytes()).expect("HMAC takes any key");
    mac.update(format!("kalzit-report-unsubscribe\0{report_id}\0{hash}").as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// The token of an unsubscribe address: the report, the address's hash and a signature with the
/// report's key; never the address itself, and independent of the secrets key.
pub fn unsubscribe_token(report_id: &str, report_key: &str, email: &str) -> String {
    let hash = address_hash(report_key, email);
    format!("{report_id}.{hash}.{}", hex::encode(token_mac(report_key, report_id, &hash)))
}

/// The report and address hash a token names, when its signature holds with the report's key.
pub async fn check_unsubscribe_token(db: &sqlx::AnyPool, token: &str) -> ApiResult<Option<(String, String, String)>> {
    let mut parts = token.split('.');
    let (Some(report_id), Some(hash), Some(mac), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Ok(None);
    };
    if uuid::Uuid::parse_str(report_id).is_err() || hash.len() != 64 {
        return Ok(None);
    }
    let Ok(mac) = hex::decode(mac) else { return Ok(None) };
    let row: Option<(String, String)> = sqlx::query_as("SELECT org_id, unsubscribe_key FROM reports WHERE id = $1")
        .bind(report_id)
        .fetch_optional(db)
        .await?;
    let Some((org_id, key)) = row else { return Ok(None) };
    use subtle::ConstantTimeEq;
    let holds: bool = token_mac(&key, report_id, hash).ct_eq(&mac).into();
    Ok(holds.then(|| (org_id, report_id.to_string(), hash.to_string())))
}

/// A new report's unsubscribe key.
pub fn new_unsubscribe_key() -> String {
    let bytes: [u8; 32] = rand::random();
    hex::encode(bytes)
}
fn range_text(g: &Gathered, lang: ReportLanguage) -> String {
    let format = |ms: i64| {
        use chrono::TimeZone;
        g.zone
            .timestamp_millis_opt(ms)
            .single()
            .map(|t| t.format(if lang == ReportLanguage::De { "%d.%m.%Y %H:%M" } else { "%Y-%m-%d %H:%M" }).to_string())
            .unwrap_or_default()
    };
    format!("{} – {} ({})", format(g.range.from), format(g.range.to), g.zone.name())
}

/// The mail with the report.
fn report_mail(
    report: &Stored,
    g: &Gathered,
    files: &[Attachment],
    left_out: &[super::csv::LeftOut],
    creator: &str,
    host: &str,
    unsubscribe: Option<&str>,
) -> MailContent {
    let lang = report.language();
    let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
    let left: Vec<&str> = left_out.iter().map(|l| l.panel.as_str()).collect();
    let mut paragraphs = Vec::new();
    let (subject, footer) = match lang {
        ReportLanguage::De => {
            paragraphs.push(format!(
                "Hier ist der Bericht „{}“ zum Dashboard „{}“, Zeitraum {}.",
                report.name,
                g.dashboard_title,
                range_text(g, lang)
            ));
            if !report.description.is_empty() {
                paragraphs.push(report.description.clone());
            }
            paragraphs.push(format!("Im Anhang: {}.", names.join(", ")));
            if !left.is_empty() {
                paragraphs.push(format!(
                    "Nicht in den CSV-Dateien, weil sie Dokumente, Graphen oder Traces zeigen und keinen Schritt zur Tabelle haben: {}.",
                    left.join(", ")
                ));
            }
            if unsubscribe.is_some() {
                paragraphs.push("Diese Adresse ist als Empfänger des Berichts eingetragen. Abmelden kannst du dich mit einem Klick über den Link unten oder die Abmelde-Funktion deines Mailprogramms.".to_string());
            }
            (
                format!("Bericht: {}", report.name),
                match unsubscribe {
                    Some(_) => format!("Gesendet von Kalzit ({host})."),
                    None => format!("Gesendet von Kalzit ({host}) im Auftrag von {creator}."),
                },
            )
        }
        ReportLanguage::En => {
            paragraphs.push(format!(
                "Here is the report \"{}\" of the dashboard \"{}\", time range {}.",
                report.name,
                g.dashboard_title,
                range_text(g, lang)
            ));
            if !report.description.is_empty() {
                paragraphs.push(report.description.clone());
            }
            paragraphs.push(format!("Attached: {}.", names.join(", ")));
            if !left.is_empty() {
                paragraphs.push(format!(
                    "Not in the CSV files, since they show documents, graphs or traces without a step to a table: {}.",
                    left.join(", ")
                ));
            }
            if unsubscribe.is_some() {
                paragraphs.push("This address is listed as a recipient of the report. Unsubscribe with one click through the link below or your mail program's unsubscribe function.".to_string());
            }
            (
                format!("Report: {}", report.name),
                match unsubscribe {
                    Some(_) => format!("Sent by Kalzit ({host})."),
                    None => format!("Sent by Kalzit ({host}) on behalf of {creator}."),
                },
            )
        }
    };
    let button = unsubscribe.map(|u| (if lang == ReportLanguage::De { "Abmelden" } else { "Unsubscribe" }, u));
    MailContent { subject, text: text(&paragraphs, unsubscribe, &footer), html: html(&paragraphs, button, &footer), images: Vec::new() }
}

/// The mail to the creator after the retry failed too.
fn failure_mail(report: &Stored, error: &Problem, host: &str) -> MailContent {
    let (subject, paragraphs, footer) = match report.language() {
        ReportLanguage::De => (
            format!("Bericht nicht gesendet: {}", report.name),
            vec![
                format!(
                    "Der Bericht „{}“ konnte auch im zweiten Versuch nicht erstellt oder gesendet werden.",
                    report.name
                ),
                format!("Grund: {} ({})", error.message, error.code),
                "Die Empfänger haben nichts bekommen. Den Verlauf siehst du in Kalzit unter Berichte.".to_string(),
            ],
            format!("Gesendet von Kalzit ({host}). Höchstens eine solche Mail pro Bericht und Tag."),
        ),
        ReportLanguage::En => (
            format!("Report not sent: {}", report.name),
            vec![
                format!("The report \"{}\" could not be made or sent, on the second attempt either.", report.name),
                format!("Reason: {} ({})", error.message, error.code),
                "The recipients received nothing. Kalzit shows the history under Reports.".to_string(),
            ],
            format!("Sent by Kalzit ({host}). At most one such mail per report and day."),
        ),
    };
    MailContent { subject, text: text(&paragraphs, None, &footer), html: html(&paragraphs, None, &footer), images: Vec::new() }
}

// ---------------------------------------------------------------------------------------------
// The run

/// Who gets the mail, and whether with the CSV files.
struct Target {
    email: String,
    external: bool,
    /// Only recipients holding `data:export` get the CSV files; outside addresses never do.
    csv: bool,
}

/// Whether `email` belongs to an account of the server (any organization), case-insensitively.
pub async fn is_account(db: &sqlx::AnyPool, email: &str) -> ApiResult<bool> {
    let row: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE LOWER(email) = $1")
        .bind(email.trim().to_lowercase())
        .fetch_optional(db)
        .await?;
    Ok(row.is_some())
}

/// The recipients that may receive the report now, and how many were left out.
async fn targets(state: &AppState, report: &Stored) -> ApiResult<(Vec<Target>, i64)> {
    let mut out: Vec<Target> = Vec::new();
    let mut skipped = 0;
    let external_ok = super::external_allowed(state, &report.org_id).await?;
    let domains = super::external_domains(state, &report.org_id).await?;
    let public = crate::mail::public_url(state).is_some();
    let mut seen = BTreeSet::new();
    for r in report.recipients() {
        match (r.user_id, r.email) {
            (Some(user_id), _) => {
                let ctx = member_ctx(state, &report.org_id, &user_id).await?;
                let ok = match &ctx {
                    Some(ctx) => reads_dashboard(state, ctx, &report.dashboard_id).await?,
                    None => false,
                };
                match ctx.filter(|_| ok) {
                    Some(ctx) if seen.insert(ctx.user.email.to_lowercase()) => {
                        let csv = ctx.permissions.contains(&Permission::DataExport);
                        out.push(Target { email: ctx.user.email, external: false, csv })
                    }
                    Some(_) => {}
                    None => skipped += 1,
                }
            }
            (None, Some(email)) => {
                let hash = address_hash(&report.unsubscribe_key, &email);
                let unsubscribed: Option<(i64,)> = sqlx::query_as(
                    "SELECT created_at FROM report_unsubscribes WHERE report_id = $1 AND email_hash = $2",
                )
                .bind(&report.id)
                .bind(&hash)
                .fetch_optional(&state.db)
                .await?;
                // An address of an account goes by its account, with its read check; never as an
                // outside address.
                let account = is_account(&state.db, &email).await?;
                if !external_ok
                    || !public
                    || account
                    || unsubscribed.is_some()
                    || !super::domain_allowed(&email, &domains)
                {
                    skipped += 1;
                } else if seen.insert(email.to_lowercase()) {
                    out.push(Target { email, external: true, csv: false });
                }
            }
            (None, None) => skipped += 1,
        }
    }
    Ok((out, skipped))
}
/// What a run ended with.
enum Outcome {
    Done {
        status: RunStatus,
        recipients: i64,
        sent: i64,
        skipped: i64,
        csv_withheld: i64,
        bytes: i64,
        pages: Option<i64>,
        note: Option<Problem>,
    },
    Suspended(Problem),
    /// `retry`: worth another attempt (the mail server, a source that did not answer).
    Failed {
        problem: Problem,
        retry: bool,
        sent_to: Vec<String>,
    },
}

/// The failure codes of panels that do not fail a run: the panel shows a placeholder instead.
fn placeholder_only(code: &str) -> bool {
    matches!(code, "reports.panel_removed" | "reports.panel_no_queries")
}

/// What a report shows, run as `ctx`, with the reason the whole report cannot go out.
pub async fn make(
    state: &AppState,
    ctx: &OrgCtx,
    report: &Stored,
    now: i64,
    budget: &super::gather::Budget,
) -> ApiResult<Result<Gathered, Problem>> {
    let panel_ids = report.panel_ids();
    let range = report.time_range();
    let variables = report.variables();
    let spec = Spec {
        dashboard_id: &report.dashboard_id,
        panel_ids: panel_ids.as_deref(),
        time_range: range.as_ref().map(|r| (r.from.as_str(), r.to.as_str())),
        variables: &variables,
        zone: report.zone(),
    };
    let g = match super::gather::gather(state, ctx, &spec, now, budget).await {
        Ok(g) => g,
        Err(e) if e.code == "validation" || e.code == "payload_too_large" => {
            let code = e.reason.as_ref().map_or("validation".to_string(), |r| r.code.clone());
            return Ok(Err(Problem { code, message: e.message }));
        }
        Err(e) if e.code == "not_found" => {
            return Ok(Err(problem("reports.dashboard_unavailable", "the dashboard is gone")));
        }
        Err(e) => return Err(e),
    };
    for p in &g.panels {
        if let Content::Unavailable { code, message } = &p.content
            && !placeholder_only(code)
        {
            let title = if p.title.is_empty() { p.id.as_str() } else { p.title.as_str() };
            return Ok(Err(Problem { code: code.clone(), message: format!("panel {title}: {message}") }));
        }
    }
    Ok(Ok(g))
}

/// A report's files: the PDF, the CSV files (one file, or a zip of several), the panels left out
/// of the CSV files, the PDF's pages and what they show.
pub struct Made {
    pub pdf: Option<Attachment>,
    pub csv: Option<Attachment>,
    pub left_out: Vec<super::csv::LeftOut>,
    pub pages: Option<usize>,
    pub gathered: Gathered,
}

/// Waits for a place to gather and render (`reports::MAX_RENDERING`).
pub async fn rendering_place(state: &AppState) -> Result<tokio::sync::OwnedSemaphorePermit, Problem> {
    state
        .reports
        .rendering
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| problem("reports.internal", "the server is stopping"))
}

/// The files of a report, made while `permit` is held; the CSV files only when `with_csv`.
pub async fn files(
    permit: tokio::sync::OwnedSemaphorePermit,
    report: &Stored,
    g: Gathered,
    now: i64,
    with_csv: bool,
) -> Result<Made, Problem> {
    let formats = report.formats();
    let lang = report.language();
    let title = report.name.clone();
    let base = crate::analysis::export::file_name(&report.name, "pdf");
    let work = move || -> Result<Made, Problem> {
        let _permit = permit;
        let mut made = Made { pdf: None, csv: None, left_out: Vec::new(), pages: None, gathered: g };
        if formats.contains(&ReportFormat::Pdf) {
            let cover = super::pdf::Cover { title: &title, generated_at: now };
            let deadline = std::time::Instant::now() + super::pdf::RENDER_DEADLINE;
            let rendered = super::pdf::render_until(&made.gathered, &cover, lang, deadline)
                .map_err(|e| problem("reports.render_failed", e))?;
            made.pages = Some(rendered.pages);
            made.pdf = Some(Attachment { name: base.clone(), content_type: "application/pdf", data: rendered.bytes });
        }
        if with_csv && formats.contains(&ReportFormat::Csv) {
            let (csv, left) = super::csv::files(&made.gathered, lang);
            made.left_out = left;
            made.csv = match csv.len() {
                0 => None,
                1 => {
                    let f = csv.into_iter().next().expect("one file");
                    Some(Attachment { name: f.name, content_type: "text/csv; charset=utf-8", data: f.data })
                }
                _ => {
                    let data = super::csv::zip(&csv).map_err(|e| problem("reports.render_failed", e))?;
                    let name = base.trim_end_matches(".pdf").to_string() + ".zip";
                    Some(Attachment { name, content_type: "application/zip", data })
                }
            };
        }
        Ok(made)
    };
    tokio::task::spawn_blocking(work).await.map_err(|e| problem("reports.internal", e.to_string()))?
}

/// The size of files in a mail: base64 with a line break every 76 characters.
pub fn encoded_size(files: &[&Attachment]) -> u64 {
    files
        .iter()
        .map(|f| {
            let n = f.data.len() as u64;
            n.div_ceil(3) * 4 + n.div_ceil(57) * 2
        })
        .sum()
}

async fn store_sent_to(state: &AppState, run_id: &str, sent_to: &[String]) {
    let json = serde_json::to_string(sent_to).expect("addresses always serialize");
    if let Err(e) = sqlx::query("UPDATE report_runs SET sent_to = $1 WHERE id = $2")
        .bind(json)
        .bind(run_id)
        .execute(&state.db)
        .await
    {
        tracing::warn!(run = %run_id, "the recipients reached cannot be stored: {e}");
    }
}

async fn attempt(
    state: &AppState,
    mailer: &dyn Mailer,
    report: &Stored,
    run_id: &str,
    sent_before: &[String],
) -> ApiResult<Outcome> {
    let now = state.clock.now_ms();
    let ctx = match creator_ctx(state, report).await? {
        Ok(ctx) => ctx,
        Err(p) => return Ok(Outcome::Suspended(p)),
    };
    let fail = |problem: Problem, retry: bool| Outcome::Failed { problem, retry, sent_to: sent_before.to_vec() };
    let (targets, mut skipped) = targets(state, report).await?;
    if targets.is_empty() {
        return Ok(fail(problem("reports.no_recipients", "no recipient may receive this report now"), false));
    }
    let formats = report.formats();
    let pdf_wanted = formats.contains(&ReportFormat::Pdf);
    let csv_wanted = formats.contains(&ReportFormat::Csv) && targets.iter().any(|t| t.csv);
    let limits = super::limits(state).await?;
    let permit = match rendering_place(state).await {
        Ok(p) => p,
        Err(p) => return Ok(fail(p, true)),
    };
    let budget = super::gather::Budget::new(limits.max_attachment_bytes, !csv_wanted);
    let g = match make(state, &ctx, report, now, &budget).await? {
        Ok(g) => g,
        Err(p) => return Ok(fail(p, true)),
    };
    let made = match files(permit, report, g, now, csv_wanted).await {
        Ok(made) => made,
        Err(p) => return Ok(fail(p, false)),
    };
    let largest: Vec<&Attachment> = made.pdf.iter().chain(made.csv.iter()).collect();
    if largest.is_empty() || (!pdf_wanted && made.csv.is_none()) {
        return Ok(fail(
            problem("reports.nothing_to_send", "the report has no file to send: no PDF and no table for CSV"),
            false,
        ));
    }
    let bytes = encoded_size(&largest);
    if bytes > limits.max_attachment_bytes {
        return Ok(fail(
            problem(
                "reports.attachment_too_large",
                format!(
                    "the files take {bytes} bytes in the mail, more than the {} a report mail may carry",
                    limits.max_attachment_bytes
                ),
            ),
            false,
        ));
    }
    let host = crate::mail::host(state);
    let mut sent_to = sent_before.to_vec();
    let mut refused = 0;
    let mut csv_withheld = 0;
    let mut receiving = 0;
    for t in &targets {
        let mut files: Vec<Attachment> = made.pdf.iter().cloned().collect();
        if t.csv {
            files.extend(made.csv.iter().cloned());
        } else if made.csv.is_some() || formats.contains(&ReportFormat::Csv) {
            csv_withheld += 1;
        }
        if files.is_empty() {
            // A CSV-only report for someone who may not have the CSV files: nothing to send.
            skipped += 1;
            continue;
        }
        receiving += 1;
        if sent_to.contains(&t.email) {
            continue;
        }
        let unsubscribe = if t.external {
            crate::mail::public_url(state).map(|base| {
                format!(
                    "{base}/api/reports/unsubscribe/{}",
                    unsubscribe_token(&report.id, &report.unsubscribe_key, &t.email)
                )
            })
        } else {
            None
        };
        let left_out = if t.csv { made.left_out.as_slice() } else { &[] };
        let content =
            report_mail(report, &made.gathered, &files, left_out, &ctx.user.name, &host, unsubscribe.as_deref());
        match mailer.send(&t.email, &content, &files, unsubscribe.as_deref()).await {
            Ok(()) => {
                sent_to.push(t.email.clone());
                // Stored at once, so a run resumed after a stop does not mail them again.
                store_sent_to(state, run_id, &sent_to).await;
            }
            Err(e) if e.connection => {
                return Ok(Outcome::Failed {
                    problem: problem(&e.reason, "the mail server could not be reached or did not answer"),
                    retry: true,
                    sent_to,
                });
            }
            Err(e) => {
                tracing::info!(report = %report.id, "a report mail was refused for one recipient: {}", e.reason);
                refused += 1;
            }
        }
    }
    if sent_to.is_empty() {
        let p = if refused > 0 {
            problem("reports.all_refused", "the mail server refused every recipient")
        } else {
            problem("reports.no_recipients", "no recipient may receive this report now")
        };
        return Ok(Outcome::Failed { problem: p, retry: false, sent_to });
    }
    let skipped = skipped + refused;
    let note =
        (skipped > 0).then(|| problem("reports.recipients_left_out", format!("{skipped} recipients were left out")));
    Ok(Outcome::Done {
        status: if skipped > 0 { RunStatus::Partial } else { RunStatus::Ok },
        recipients: receiving + skipped - refused,
        sent: i64::try_from(sent_to.len()).unwrap_or(0),
        skipped,
        csv_withheld,
        bytes: i64::try_from(bytes).unwrap_or(i64::MAX),
        pages: made.pages.map(|p| p as i64),
        note,
    })
}
/// Runs the claimed run `run_id` to its end and stores how it ended.
pub async fn execute(state: &AppState, mailer: &dyn Mailer, run_id: &str) -> ApiResult<()> {
    let row: Option<(String, String, i64, Option<String>)> =
        sqlx::query_as("SELECT org_id, report_id, attempt, sent_to FROM report_runs WHERE id = $1")
            .bind(run_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((org_id, report_id, attempt_no, sent_to)) = row else { return Ok(()) };
    let Some(report) = load(&state.db, &org_id, &report_id).await? else { return Ok(()) };
    if !super::enabled_for(state, &org_id).await? {
        // Turned off for the server or the organization after the run was queued.
        sqlx::query(
            "UPDATE report_runs SET status = 'skipped', finished_at = $1, lease_until = NULL, sent_to = NULL, \
             error_code = $3, error_message = $4 WHERE id = $2",
        )
        .bind(state.clock.now_ms())
        .bind(run_id)
        .bind("reports.disabled")
        .bind("reports are turned off")
        .execute(&state.db)
        .await?;
        return Ok(());
    }
    let sent_before: Vec<String> = sent_to.as_deref().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
    let outcome = match attempt(state, mailer, &report, run_id, &sent_before).await {
        Ok(o) => o,
        Err(e) => {
            Outcome::Failed { problem: problem("reports.internal", e.message), retry: true, sent_to: sent_before }
        }
    };
    finish(state, mailer, &report, run_id, attempt_no, outcome).await
}

async fn finish(
    state: &AppState,
    mailer: &dyn Mailer,
    report: &Stored,
    run_id: &str,
    attempt_no: i64,
    outcome: Outcome,
) -> ApiResult<()> {
    let now = state.clock.now_ms();
    match outcome {
        Outcome::Done { status, recipients, sent, skipped, csv_withheld, bytes, pages, note } => {
            let mut tx = crate::db::begin(&state.db).await?;
            sqlx::query(
                "UPDATE report_runs SET status = $1, finished_at = $2, lease_until = NULL, sent_to = NULL, \
                 recipients = $3, sent = $4, skipped_recipients = $5, attachment_bytes = $6, pages = $7, \
                 error_code = $8, error_message = $9, csv_withheld = $11 WHERE id = $10",
            )
            .bind(status.as_str())
            .bind(now)
            .bind(recipients)
            .bind(sent)
            .bind(skipped)
            .bind(bytes)
            .bind(pages)
            .bind(note.as_ref().map(|n| n.code.clone()))
            .bind(note.as_ref().map(|n| n.message.clone()))
            .bind(run_id)
            .bind(csv_withheld)
            .execute(&mut *tx)
            .await?;
            // Rights are back: the report is no longer suspended.
            sqlx::query("UPDATE reports SET suspended_reason = NULL, suspended_at = NULL WHERE id = $1")
                .bind(&report.id)
                .execute(&mut *tx)
                .await?;
            crate::db::commit(tx).await?;
        }
        Outcome::Suspended(p) => {
            let mut tx = crate::db::begin(&state.db).await?;
            sqlx::query(
                "UPDATE report_runs SET status = $1, finished_at = $2, lease_until = NULL, sent_to = NULL, \
                 error_code = $3, error_message = $4 WHERE id = $5",
            )
            .bind(RunStatus::Suspended.as_str())
            .bind(now)
            .bind(&p.code)
            .bind(&p.message)
            .bind(run_id)
            .execute(&mut *tx)
            .await?;
            let reason = json!({ "code": p.code, "message": p.message }).to_string();
            sqlx::query(
                "UPDATE reports SET suspended_reason = $1, suspended_at = COALESCE(suspended_at, $2) WHERE id = $3",
            )
            .bind(&reason)
            .bind(now)
            .bind(&report.id)
            .execute(&mut *tx)
            .await?;
            crate::db::commit(tx).await?;
            tracing::info!(report = %report.id, "report suspended: {}", p.code);
        }
        Outcome::Failed { problem: p, retry, sent_to } => {
            let sent_json = serde_json::to_string(&sent_to).expect("addresses always serialize");
            if retry && attempt_no < 2 {
                sqlx::query(
                    "UPDATE report_runs SET status = $1, attempt = 2, not_before = $2, lease_until = NULL, sent_to = $3, \
                     error_code = $4, error_message = $5 WHERE id = $6",
                )
                .bind(RunStatus::Queued.as_str())
                .bind(now + RETRY_AFTER_MS)
                .bind(&sent_json)
                .bind(&p.code)
                .bind(&p.message)
                .bind(run_id)
                .execute(&state.db)
                .await?;
                tracing::info!(report = %report.id, "report run failed ({}); trying once more in 5 minutes", p.code);
                return Ok(());
            }
            sqlx::query(
                "UPDATE report_runs SET status = $1, finished_at = $2, lease_until = NULL, sent_to = NULL, sent = $3, \
                 error_code = $4, error_message = $5 WHERE id = $6",
            )
            .bind(RunStatus::Failed.as_str())
            .bind(now)
            .bind(i64::try_from(sent_to.len()).unwrap_or(0))
            .bind(&p.code)
            .bind(&p.message)
            .bind(run_id)
            .execute(&state.db)
            .await?;
            tracing::warn!(report = %report.id, "report run failed: {} ({})", p.message, p.code);
            tell_creator(state, mailer, report, &p, now).await?;
        }
    }
    Ok(())
}

/// The failure mail to the creator, at most one per report and day.
async fn tell_creator(state: &AppState, mailer: &dyn Mailer, report: &Stored, p: &Problem, now: i64) -> ApiResult<()> {
    let claimed = sqlx::query(
        "UPDATE reports SET failure_mailed_at = $1 WHERE id = $2 AND (failure_mailed_at IS NULL OR failure_mailed_at <= $3)",
    )
    .bind(now)
    .bind(&report.id)
    .bind(now - FAILURE_MAIL_EVERY_MS)
    .execute(&state.db)
    .await?
    .rows_affected();
    if claimed == 0 {
        return Ok(());
    }
    // A service account's address is made up; it gets no mail.
    let row: Option<(String,)> =
        sqlx::query_as("SELECT email FROM users WHERE id = $1 AND disabled = 0 AND service_account = 0")
            .bind(&report.owner_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((email,)) = row else { return Ok(()) };
    let content = failure_mail(report, p, &crate::mail::host(state));
    if let Err(e) = mailer.send(&email, &content, &[], None).await {
        tracing::warn!(report = %report.id, "the failure mail to the creator was not sent: {}", e.reason);
    }
    Ok(())
}
