//! A plugin process as a data source kind: `Remote` implements `DataSourcePlugin` by calling the
//! process over gRPC, so routes, limits, live updates and the target rules stay the same for
//! every kind. Results go through `wire::Assembler` with the query's limits; whatever the
//! plugin sends, the host cuts it to those limits or fails the query.
//!
//! Errors: the reasons a plugin answers with reach the API only when they are reasons Kalzit
//! itself documents for data sources (`PASSED_ON`); any other reason becomes `plugin.error`
//! with the plugin's reason as the parameter `reason`. Failures of the process or the protocol
//! have reasons of their own (`plugin.*`, docs/api/plugins.md).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use kalzit_plugin_api::datasource::v1 as pb;
use kalzit_plugin_api::manifest::Manifest;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::supervisor::{Client, Supervisor};
use super::{HostError, intern, wire};
use crate::datasources::{
    Capability, Change, ChangeFeed, Connection, DataSourcePlugin, Detail, FieldError, Health, MAX_HEALTH_TIMEOUT,
    ResumeToken, SourceError, SourceQuery, SourceSchema,
};
use crate::shapes::{QueryResult, Shape};

/// Reasons of Kalzit's own catalog a plugin may answer with; the UI translates them.
const PASSED_ON: &[&str] = &[
    "health.connected",
    "health.connected_admin_login",
    "source.error",
    "source.no_answer",
    "query.invalid_form",
    "query.write_refused",
    "query.timeout",
    "query.time_out_of_range",
    "settings.required",
    "settings.invalid",
    "settings.host_invalid",
    "settings.host_credentials",
    "settings.port_invalid",
    "settings.url_invalid",
    "settings.url_scheme",
    "settings.url_credentials",
    "settings.url_no_host",
    "settings.pem_invalid",
    "target.not_allowed",
    "target.metadata_address",
    "target.own_database",
    "target.unresolvable",
    "target.unreachable",
];

/// The schema forms of docs/api/datasources.md a plugin may answer.
const SCHEMA_FORMS: &[&str] = &["tables", "metrics", "indices", "fields", "collections", "graph"];

/// Parameters of one plugin detail kept at most, and their longest key and value.
const MAX_PARAMS: usize = 20;
const MAX_PARAM_KEY: usize = 64;
const MAX_PARAM_VALUE: usize = 2_000;
const MAX_MESSAGE: usize = 4_000;

fn cut(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}...", &text[..at]),
        None => text.to_string(),
    }
}

/// A plugin's detail as Kalzit's: a reason of `PASSED_ON` stays, any other becomes
/// `plugin.error` with the plugin's reason in `reason`; the plugin's id is always in `plugin`.
pub fn detail_from(plugin: &str, d: Option<pb::Detail>) -> Detail {
    let d = d.unwrap_or_default();
    let message = cut(&d.message, MAX_MESSAGE);
    let mut detail = match PASSED_ON.iter().find(|r| **r == d.reason) {
        Some(reason) => Detail::new(reason, message),
        None => {
            let own: String = d
                .reason
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                .take(MAX_PARAM_KEY * 2)
                .collect();
            Detail::new("plugin.error", message).with("reason", own)
        }
    };
    for (k, v) in d.params.into_iter().take(MAX_PARAMS) {
        if k != "plugin" && k != "reason" {
            detail.params.insert(cut(&k, MAX_PARAM_KEY), cut(&v, MAX_PARAM_VALUE));
        }
    }
    detail.with("plugin", plugin)
}

/// A plugin's error as a source error of the same kind.
pub fn error_from(plugin: &str, e: pb::Error, limit: Duration) -> SourceError {
    let kind = wire::error_kind(&e);
    let detail = detail_from(plugin, e.detail);
    match kind {
        pb::ErrorKind::Rejected => SourceError::Rejected(detail),
        pb::ErrorKind::Blocked => SourceError::Blocked(detail),
        pb::ErrorKind::Timeout => SourceError::Timeout(limit.as_secs().max(1)),
        _ => SourceError::Failed(detail),
    }
}

fn host_error(plugin: &str, e: HostError) -> SourceError {
    let mut detail = Detail::new(e.reason, e.message);
    detail.params = e.params;
    SourceError::Failed(detail.with("plugin", plugin))
}

/// A broken call: the deadline as a timeout, a missing RPC as unsupported, the rest as a failed
/// call of the plugin.
fn status_error(plugin: &str, s: tonic::Status, limit: Duration) -> SourceError {
    match s.code() {
        tonic::Code::DeadlineExceeded | tonic::Code::Cancelled => SourceError::Timeout(limit.as_secs().max(1)),
        tonic::Code::Unimplemented => SourceError::Failed(
            Detail::new("plugin.unsupported_call", format!("the plugin does not implement this call: {}", s.message()))
                .with("plugin", plugin),
        ),
        code => SourceError::Failed(
            Detail::new(
                "plugin.call_failed",
                format!("the call to the plugin failed ({code:?}): {}", cut(s.message(), 500)),
            )
            .with("plugin", plugin)
            .with("detail", cut(s.message(), 500)),
        ),
    }
}

fn protocol_error(plugin: &str, message: String) -> SourceError {
    SourceError::Failed(Detail::new("plugin.protocol", message).with("plugin", plugin))
}

/// The shapes and capabilities as the registry keeps them: `&'static` slices, one per
/// combination.
fn static_shapes(manifest: &Manifest) -> &'static [Shape] {
    const ALL: [&[Shape]; 8] = [
        &[],
        &[Shape::Frame],
        &[Shape::Documents],
        &[Shape::Frame, Shape::Documents],
        &[Shape::Graph],
        &[Shape::Frame, Shape::Graph],
        &[Shape::Documents, Shape::Graph],
        &[Shape::Frame, Shape::Documents, Shape::Graph],
    ];
    let has = |name: &str| manifest.shapes.iter().any(|s| s == name);
    ALL[usize::from(has("frame")) | usize::from(has("documents")) << 1 | usize::from(has("graph")) << 2]
}

fn static_capabilities(manifest: &Manifest) -> &'static [Capability] {
    const ALL: [&[Capability]; 4] =
        [&[], &[Capability::CheckOnSave], &[Capability::Watch], &[Capability::CheckOnSave, Capability::Watch]];
    let has = |name: &str| manifest.capabilities.iter().any(|c| c == name);
    ALL[usize::from(has("check_on_save")) | usize::from(has("watch")) << 1]
}

/// A plugin process behind the data source contract.
pub struct Remote {
    kind: &'static str,
    shapes: &'static [Shape],
    capabilities: &'static [Capability],
    manifest: Arc<Manifest>,
    supervisor: Arc<Supervisor>,
}

impl Remote {
    pub fn new(supervisor: Arc<Supervisor>) -> Self {
        let manifest = supervisor.manifest().clone();
        Self {
            kind: intern(&manifest.id),
            shapes: static_shapes(&manifest),
            capabilities: static_capabilities(&manifest),
            manifest,
            supervisor,
        }
    }

    async fn client(&self) -> Result<Client, SourceError> {
        self.supervisor.client().await.map_err(|e| host_error(self.kind, e))
    }

    /// A settings field of this kind by name, as the registry names it.
    fn field(&self, name: &str) -> &'static str {
        match self.manifest.settings.iter().find(|s| s.name == name) {
            Some(s) => intern(&s.name),
            None => "settings",
        }
    }

    /// The data source as the protocol carries it. The revision changes with the settings and
    /// the secrets, so the plugin keeps a pool per revision.
    fn connection(&self, conn: &Connection) -> pb::Connection {
        let mut secrets = BTreeMap::new();
        for s in self.manifest.settings.iter().filter(|s| s.secret) {
            if let Some(v) = conn.secret(&s.name) {
                secrets.insert(s.name.clone(), v.to_string());
            }
        }
        let settings_json = conn.settings().to_string();
        let mut hash = Sha256::new();
        hash.update(conn.datasource_id().as_bytes());
        hash.update([0]);
        hash.update(settings_json.as_bytes());
        for (k, v) in &secrets {
            hash.update([0]);
            hash.update(k.as_bytes());
            hash.update([0]);
            hash.update(v.as_bytes());
        }
        let digest = hash.finalize();
        let revision = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
        pb::Connection { datasource_id: conn.datasource_id().to_string(), revision, settings_json, secrets }
    }

    /// The target rules for the targets the manifest takes from the settings, before the plugin
    /// connects: a host or URL that is refused (Kalzit's own database and metadata addresses,
    /// `datasources.allowed_targets`) fails the call here. The plugin connects on its own, so
    /// this is a check of the configured target, not of the connection it makes.
    async fn check_targets(&self, conn: &Connection) -> Result<(), SourceError> {
        for target in &self.manifest.permissions.network {
            let Some(setting) = &target.setting else { continue };
            let Some(value) = conn.settings().get(setting).and_then(Value::as_str) else { continue };
            let (host, port) = match target.form.as_deref() {
                Some("url") => {
                    let Ok(url) = url::Url::parse(value) else { continue };
                    let Some(host) = url.host_str().map(|h| h.trim_matches(['[', ']']).to_string()) else { continue };
                    (host, url.port_or_known_default().unwrap_or(443))
                }
                _ => {
                    let port = target
                        .port_setting
                        .as_ref()
                        .and_then(|p| conn.settings().get(p))
                        .and_then(Value::as_u64)
                        .and_then(|p| u16::try_from(p).ok())
                        .or(target.default_port)
                        .unwrap_or(0);
                    (value.to_string(), port)
                }
            };
            conn.policy().resolve_all(&host, port).await?;
        }
        Ok(())
    }

    fn deadline(timeout: Duration) -> i64 {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
        i64::try_from((now + timeout).as_millis()).unwrap_or(i64::MAX)
    }

    fn query_request(&self, conn: &Connection, req: &SourceQuery) -> pb::QueryRequest {
        pb::QueryRequest {
            connection: Some(self.connection(conn)),
            ref_id: req.ref_id.clone(),
            query_json: req.query.to_string(),
            range: Some(pb::TimeRange { from_ms: req.range.from, to_ms: req.range.to }),
            interval_ms: req.interval_ms,
            max_data_points: req.max_data_points,
            variables_json: serde_json::to_string(&req.variables).unwrap_or_else(|_| "{}".into()),
            identifier_variables_restricted: req.identifier_variables.is_some(),
            identifier_variables: req.identifier_variables.iter().flatten().cloned().collect(),
            limits: Some(pb::Limits {
                timeout_ms: u64::try_from(req.limits.timeout.as_millis()).unwrap_or(u64::MAX).max(1),
                max_rows: req.limits.max_rows.max(1) as u64,
                max_response_bytes: req.limits.budget.remaining().max(1) as u64,
            }),
            cursor: req.cursor.clone(),
            deadline_unix_ms: Self::deadline(req.limits.timeout),
        }
    }
}

fn with_timeout<T>(message: T, timeout: Duration) -> tonic::Request<T> {
    let mut request = tonic::Request::new(message);
    request.set_timeout(timeout);
    request
}

#[async_trait::async_trait]
impl DataSourcePlugin for Remote {
    fn kind(&self) -> &'static str {
        self.kind
    }

    fn shapes(&self) -> &'static [Shape] {
        self.shapes
    }

    fn capabilities(&self) -> &'static [Capability] {
        self.capabilities
    }

    /// The manifest's form rules run in `Kind::validate_settings`; the plugin's own checks in
    /// `check_settings_remote`.
    fn check_settings(&self, _settings: &Value) -> Result<(), FieldError> {
        Ok(())
    }

    /// A plugin that cannot be started or reached does not refuse the settings (the form rules
    /// were checked); queries and "Test connection" report it.
    async fn check_settings_remote(&self, settings: &Value) -> Result<(), FieldError> {
        let Ok(mut client) = self.client().await else { return Ok(()) };
        let request =
            with_timeout(pb::CheckSettingsRequest { settings_json: settings.to_string() }, MAX_HEALTH_TIMEOUT);
        let Ok(answer) = client.check_settings(request).await else { return Ok(()) };
        match answer.into_inner().error {
            None => Ok(()),
            Some(e) => {
                let field = self.field(&e.field);
                let detail = detail_from(self.kind, e.detail).with("field", field);
                Err(FieldError { field, detail })
            }
        }
    }

    async fn health(&self, conn: &Connection) -> Health {
        if let Err(e) = self.check_targets(conn).await {
            return Health::failed(&e);
        }
        let mut client = match self.client().await {
            Ok(c) => c,
            Err(e) => return Health::failed(&e),
        };
        let request = pb::HealthRequest {
            connection: Some(self.connection(conn)),
            deadline_unix_ms: Self::deadline(MAX_HEALTH_TIMEOUT),
        };
        let answer = match client.health(with_timeout(request, MAX_HEALTH_TIMEOUT)).await {
            Ok(a) => a.into_inner(),
            Err(s) => return Health::failed(&status_error(self.kind, s, MAX_HEALTH_TIMEOUT)),
        };
        if !answer.ok {
            let error = answer.error.unwrap_or_default();
            return Health::failed(&error_from(self.kind, error, MAX_HEALTH_TIMEOUT));
        }
        let mut detail = detail_from(self.kind, answer.detail);
        if !detail.reason.starts_with("health.") {
            detail = Detail { reason: "plugin.connected", ..detail };
        }
        Health {
            ok: true,
            code: None,
            detail,
            warnings: answer.warnings.into_iter().map(|w| detail_from(self.kind, Some(w))).collect(),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        use pb::schema_response::Result as Answer;
        self.check_targets(conn).await?;
        let mut client = self.client().await?;
        let request = pb::SchemaRequest {
            connection: Some(self.connection(conn)),
            deadline_unix_ms: Self::deadline(MAX_HEALTH_TIMEOUT),
        };
        let answer = client
            .schema(with_timeout(request, MAX_HEALTH_TIMEOUT))
            .await
            .map_err(|s| status_error(self.kind, s, MAX_HEALTH_TIMEOUT))?
            .into_inner();
        match answer.result {
            Some(Answer::SchemaJson(text)) => {
                let value: Value = serde_json::from_str(&text)
                    .map_err(|e| protocol_error(self.kind, format!("the schema is not valid JSON: {e}")))?;
                let form = value.get("kind").and_then(Value::as_str).unwrap_or_default();
                if !value.is_object() || !SCHEMA_FORMS.contains(&form) {
                    return Err(protocol_error(self.kind, format!("the schema form {form:?} is not one Kalzit knows")));
                }
                Ok(SourceSchema::Plugin(value))
            }
            Some(Answer::Error(e)) => Err(error_from(self.kind, e, MAX_HEALTH_TIMEOUT)),
            None => Err(protocol_error(self.kind, "the schema answer is empty".into())),
        }
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        self.check_targets(conn).await?;
        let mut client = self.client().await?;
        let timeout = req.limits.timeout;
        let limits = wire::Limits::for_query(&req.limits);
        let request = with_timeout(self.query_request(conn, &req), timeout);
        let run = async {
            let mut stream = client.query(request).await.map_err(|s| status_error(self.kind, s, timeout))?.into_inner();
            let mut assembler = wire::Assembler::new(limits);
            loop {
                match stream.message().await {
                    // Returning drops the stream, which ends the call in the plugin.
                    Ok(Some(chunk)) => match assembler.push(chunk) {
                        Ok(Some(Ok(result))) => return Ok(result),
                        Ok(Some(Err(e))) => return Err(error_from(self.kind, e, timeout)),
                        Ok(None) => {}
                        Err(e) => return Err(protocol_error(self.kind, e.to_string())),
                    },
                    Ok(None) => {
                        return Err(protocol_error(self.kind, "the result ended without its end or an error".into()));
                    }
                    Err(s) => return Err(status_error(self.kind, s, timeout)),
                }
            }
        };
        tokio::time::timeout(timeout, run).await.unwrap_or(Err(SourceError::Timeout(timeout.as_secs().max(1))))
    }

    async fn check_on_save(&self, conn: &Connection) -> Result<(), (&'static str, SourceError)> {
        if !self.capabilities.contains(&Capability::CheckOnSave) {
            return Ok(());
        }
        let mut client = self.client().await.map_err(|e| ("settings", e))?;
        let request = pb::CheckOnSaveRequest {
            connection: Some(self.connection(conn)),
            deadline_unix_ms: Self::deadline(MAX_HEALTH_TIMEOUT),
        };
        let answer = match client.check_on_save(with_timeout(request, MAX_HEALTH_TIMEOUT)).await {
            Ok(a) => a.into_inner(),
            // A source or plugin that cannot be reached does not refuse the save.
            Err(_) => return Ok(()),
        };
        match answer.refusal {
            None => Ok(()),
            Some(r) => {
                Err((self.field(&r.field), error_from(self.kind, r.error.unwrap_or_default(), MAX_HEALTH_TIMEOUT)))
            }
        }
    }

    async fn watch(
        &self,
        conn: &Connection,
        req: SourceQuery,
        resume: Option<ResumeToken>,
    ) -> Result<Option<ChangeFeed>, SourceError> {
        use futures_util::StreamExt;
        use pb::watch_event::Event;
        if !self.capabilities.contains(&Capability::Watch) {
            return Ok(None);
        }
        self.check_targets(conn).await?;
        let mut client = self.client().await?;
        let timeout = req.limits.timeout;
        let resume_token = resume.and_then(|t| t.0.downcast_ref::<Vec<u8>>().cloned());
        let request = pb::WatchRequest { query: Some(self.query_request(conn, &req)), resume_token };
        let mut stream = client
            .watch(tonic::Request::new(request))
            .await
            .map_err(|s| status_error(self.kind, s, timeout))?
            .into_inner();
        let plugin = self.kind;
        let first = match tokio::time::timeout(timeout, stream.message()).await {
            Err(_) => return Err(SourceError::Timeout(timeout.as_secs().max(1))),
            Ok(Err(s)) => return Err(status_error(plugin, s, timeout)),
            Ok(Ok(None)) => return Ok(None),
            Ok(Ok(Some(event))) => event,
        };
        let change = move |event: pb::WatchEvent| -> Option<Result<Change, SourceError>> {
            match event.event {
                Some(Event::Change(c)) => Some(Ok(Change {
                    changed: c.changed,
                    token: c.token.map(|t| ResumeToken(Arc::new(t) as Arc<dyn std::any::Any + Send + Sync>)),
                })),
                Some(Event::Error(e)) => Some(Err(error_from(plugin, e, timeout))),
                // An event of a newer protocol minor, or `unsupported` after the start: skipped.
                Some(Event::Unsupported(_)) | None => None,
            }
        };
        if matches!(first.event, Some(Event::Unsupported(_))) {
            return Ok(None);
        }
        let head = futures_util::stream::iter(change(first));
        let rest = futures_util::stream::unfold(stream, move |mut stream| async move {
            loop {
                match stream.message().await {
                    Ok(Some(event)) => {
                        if let Some(item) = change(event) {
                            return Some((item, stream));
                        }
                    }
                    Ok(None) => return None,
                    Err(s) => return Some((Err(status_error(plugin, s, timeout)), stream)),
                }
            }
        });
        // An error ends the feed.
        let feed = head.chain(rest).scan(false, |ended, item| {
            let out = if *ended { None } else { Some(item) };
            if matches!(out, Some(Err(_))) {
                *ended = true;
            }
            futures_util::future::ready(out)
        });
        Ok(Some(Box::pin(feed)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail(reason: &str) -> Option<pb::Detail> {
        Some(pb::Detail {
            reason: reason.into(),
            params: [("host".to_string(), "db".to_string()), ("plugin".to_string(), "fake".to_string())].into(),
            message: "text".into(),
        })
    }

    #[test]
    fn known_reasons_pass_and_others_become_plugin_errors() {
        let d = detail_from("dev.example.t", detail("source.error"));
        assert_eq!(d.reason, "source.error");
        assert_eq!(d.params["plugin"], "dev.example.t");
        assert_eq!(d.params["host"], "db");

        let d = detail_from("dev.example.t", detail("redis.auth <script>"));
        assert_eq!(d.reason, "plugin.error");
        assert_eq!(d.params["reason"], "redis.authscript");
        assert_eq!(d.params["plugin"], "dev.example.t", "the plugin cannot name another plugin");

        let e = error_from("dev.example.t", pb::Error { kind: 99, detail: detail("x") }, Duration::from_secs(3));
        assert!(matches!(e, SourceError::Failed(_)), "an unknown kind counts as failed");
        let e = error_from(
            "dev.example.t",
            pb::Error { kind: pb::ErrorKind::Timeout as i32, detail: None },
            Duration::from_millis(200),
        );
        assert!(matches!(e, SourceError::Timeout(1)));
    }

    #[test]
    fn long_texts_are_cut() {
        let d = detail_from(
            "p",
            Some(pb::Detail { reason: "source.error".into(), params: BTreeMap::new(), message: "x".repeat(10_000) }),
        );
        assert!(d.message.len() <= MAX_MESSAGE + 3);
    }
}
