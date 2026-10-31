//! A registered kind served through the data source protocol, inside the server. It is the
//! protocol's reference: every built-in kind answers the same calls an external plugin answers,
//! with the same parts, so what the protocol cannot express shows up here first. The query path
//! of the server keeps calling built-in kinds directly; this adapter is what contract tests and
//! plugin SDKs compare against.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{Stream, StreamExt, stream};
use kalzit_plugin_api::datasource::v1 as pb;
use kalzit_plugin_api::datasource::v1::data_source_server::DataSource;
use serde_json::Value;
use tonic::{Request, Response, Status};
use zeroize::Zeroizing;

use super::wire;
use crate::datasources::frame::ResponseBudget;
use crate::datasources::targets::TargetPolicy;
use crate::datasources::{
    Capability, Connection, Health, Kind, Limits, MAX_HEALTH_TIMEOUT, OwnDatabase, ResumeToken, SourceError,
    SourceQuery,
};
use crate::locks::MutexExt;
use crate::shapes::TimeRange;

/// Rows, documents or graph elements per result part.
const BATCH: usize = 1000;

/// Resume tokens of change feeds kept for `Watch` calls that continue one.
const MAX_TOKENS: usize = 1024;

/// Feed positions with the data source and the opaque token handed out for them.
type Tokens = Arc<Mutex<VecDeque<(String, Vec<u8>, ResumeToken)>>>;

type Parts<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

/// One kind behind the protocol.
pub struct InProcess {
    kind: Arc<Kind>,
    policy: Arc<TargetPolicy>,
    own: Arc<OwnDatabase>,
    /// Connections (and with them the kind's pools) by data source, with their revision.
    connections: Mutex<HashMap<String, (u64, Arc<Connection>)>>,
    /// Feed positions by the opaque token handed out for them, oldest first.
    tokens: Tokens,
}

impl InProcess {
    pub fn new(kind: Arc<Kind>, policy: Arc<TargetPolicy>, own: Arc<OwnDatabase>) -> Self {
        Self { kind, policy, own, connections: Mutex::new(HashMap::new()), tokens: Tokens::default() }
    }

    fn has(&self, capability: Capability) -> bool {
        self.kind.plugin.capabilities().contains(&capability)
    }

    /// The connection of `c`, kept while its revision stays the same.
    fn connection(&self, c: Option<pb::Connection>) -> Result<Arc<Connection>, Status> {
        let c = c.ok_or_else(|| Status::invalid_argument("the connection is missing"))?;
        let mut connections = self.connections.lock_or_recover();
        if let Some((revision, conn)) = connections.get(&c.datasource_id)
            && *revision == c.revision
        {
            return Ok(conn.clone());
        }
        let settings = json_object(&c.settings_json, "settings")?;
        let secrets: BTreeMap<String, Zeroizing<String>> =
            c.secrets.into_iter().map(|(k, v)| (k, Zeroizing::new(v))).collect();
        let conn =
            Arc::new(Connection::new(&c.datasource_id, settings, secrets, self.policy.clone(), self.own.clone()));
        connections.insert(c.datasource_id, (c.revision, conn.clone()));
        Ok(conn)
    }

    /// The position behind `id`, only for the data source whose feed handed it out.
    fn resume(&self, datasource_id: &str, id: Option<&[u8]>) -> Option<ResumeToken> {
        let tokens = self.tokens.lock_or_recover();
        let id = id?;
        tokens.iter().find(|(ds, t, _)| ds == datasource_id && t == id).map(|(_, _, token)| token.clone())
    }
}

/// Keeps a feed position and answers the opaque token for it; the oldest go first.
fn remember(tokens: &Tokens, datasource_id: &str, token: ResumeToken) -> Vec<u8> {
    let id = uuid::Uuid::now_v7().as_bytes().to_vec();
    let mut tokens = tokens.lock_or_recover();
    if tokens.len() == MAX_TOKENS {
        tokens.pop_front();
    }
    tokens.push_back((datasource_id.to_string(), id.clone(), token));
    id
}

/// How long a call may take: until its deadline (`deadline_unix_ms`, when set) and never
/// longer than `max`.
fn time_left(deadline_unix_ms: i64, max: Duration) -> Duration {
    if deadline_unix_ms <= 0 {
        return max;
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let left = Duration::from_millis(u64::try_from(deadline_unix_ms).unwrap_or(0)).saturating_sub(now);
    left.min(max)
}

/// The timeout error for a call that ran `limit`; part of a second counts as a whole one, so a
/// sub-second limit is not reported as zero seconds.
fn timed_out(limit: Duration) -> SourceError {
    SourceError::Timeout(u64::try_from(limit.as_millis().div_ceil(1000)).unwrap_or(u64::MAX).max(1))
}

fn json_object(text: &str, what: &str) -> Result<Value, Status> {
    let value: Value = if text.is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_str(text).map_err(|e| Status::invalid_argument(format!("{what} are not valid JSON: {e}")))?
    };
    if !value.is_object() {
        return Err(Status::invalid_argument(format!("{what} are not a JSON object")));
    }
    Ok(value)
}

/// A protocol query as the kind's query, with its limits.
fn source_query(q: &pb::QueryRequest) -> Result<SourceQuery, Status> {
    let query = serde_json::from_str(&q.query_json)
        .map_err(|e| Status::invalid_argument(format!("the query is not valid JSON: {e}")))?;
    let variables: BTreeMap<String, Value> =
        serde_json::from_value(json_object(&q.variables_json, "variables")?).expect("an object is a map");
    let range = q.range.ok_or_else(|| Status::invalid_argument("the time range is missing"))?;
    let limits = q.limits.ok_or_else(|| Status::invalid_argument("the limits are missing"))?;
    if limits.timeout_ms == 0 || limits.max_rows == 0 || limits.max_response_bytes == 0 {
        return Err(Status::invalid_argument("every limit must be above 0"));
    }
    let identifier_variables: Option<BTreeSet<String>> =
        q.identifier_variables_restricted.then(|| q.identifier_variables.iter().cloned().collect());
    Ok(SourceQuery {
        ref_id: q.ref_id.clone(),
        query,
        range: TimeRange { from: range.from_ms, to: range.to_ms },
        interval_ms: q.interval_ms,
        max_data_points: q.max_data_points,
        variables,
        identifier_variables,
        limits: Limits {
            timeout: Duration::from_millis(limits.timeout_ms),
            max_rows: usize::try_from(limits.max_rows).unwrap_or(usize::MAX),
            budget: ResponseBudget::new(usize::try_from(limits.max_response_bytes).unwrap_or(usize::MAX)),
        },
        cursor: q.cursor.clone(),
    })
}

/// The error as the protocol carries it, without the connection's secrets.
fn scrubbed_error(e: &SourceError, conn: &Connection) -> pb::Error {
    let mut out = wire::error(e);
    if let Some(d) = &mut out.detail {
        scrub_detail(d, conn);
    }
    out
}

fn scrub_detail(d: &mut pb::Detail, conn: &Connection) {
    d.message = conn.scrub(&d.message);
    for value in d.params.values_mut() {
        *value = conn.scrub(value);
    }
}

#[async_trait::async_trait]
impl DataSource for InProcess {
    async fn describe(&self, _: Request<pb::DescribeRequest>) -> Result<Response<pb::DescribeResponse>, Status> {
        let plugin = &self.kind.plugin;
        Ok(Response::new(pb::DescribeResponse {
            protocol_version: kalzit_plugin_api::PROTOCOL_VERSION,
            kind: plugin.kind().to_string(),
            shapes: plugin.shapes().iter().map(|s| wire::shape(*s) as i32).collect(),
            capabilities: plugin.capabilities().iter().filter_map(|c| wire::capability(*c)).map(|c| c as i32).collect(),
        }))
    }

    async fn check_settings(
        &self,
        request: Request<pb::CheckSettingsRequest>,
    ) -> Result<Response<pb::CheckSettingsResponse>, Status> {
        let settings = json_object(&request.get_ref().settings_json, "settings")?;
        let error = self.kind.plugin.check_settings(&settings).err().map(|e| wire::field_error(&e));
        Ok(Response::new(pb::CheckSettingsResponse { error }))
    }

    async fn health(&self, request: Request<pb::HealthRequest>) -> Result<Response<pb::HealthResponse>, Status> {
        let h = request.into_inner();
        let conn = self.connection(h.connection)?;
        let limit = time_left(h.deadline_unix_ms, MAX_HEALTH_TIMEOUT);
        let health = match tokio::time::timeout(limit, self.kind.plugin.health(&conn)).await {
            Ok(health) => health,
            Err(_) => Health::failed(&timed_out(limit)),
        };
        let mut health = wire::health(&health);
        let error_detail = health.error.as_mut().and_then(|e| e.detail.as_mut());
        for d in health.detail.iter_mut().chain(error_detail).chain(health.warnings.iter_mut()) {
            scrub_detail(d, &conn);
        }
        Ok(Response::new(health))
    }

    async fn schema(&self, request: Request<pb::SchemaRequest>) -> Result<Response<pb::SchemaResponse>, Status> {
        use pb::schema_response::Result as Answer;
        let r = request.into_inner();
        let conn = self.connection(r.connection)?;
        let limit = time_left(r.deadline_unix_ms, MAX_HEALTH_TIMEOUT);
        let result = match tokio::time::timeout(limit, self.kind.plugin.schema(&conn)).await {
            Ok(Ok(schema)) => Answer::SchemaJson(serde_json::to_string(&schema).expect("a schema serializes")),
            Ok(Err(e)) => Answer::Error(scrubbed_error(&e, &conn)),
            Err(_) => Answer::Error(scrubbed_error(&timed_out(limit), &conn)),
        };
        Ok(Response::new(pb::SchemaResponse { result: Some(result) }))
    }

    type QueryStream = Parts<pb::QueryChunk>;

    async fn query(&self, request: Request<pb::QueryRequest>) -> Result<Response<Self::QueryStream>, Status> {
        let q = request.into_inner();
        let req = source_query(&q)?;
        let conn = self.connection(q.connection)?;
        let timeout = time_left(q.deadline_unix_ms, req.limits.timeout);
        let parts = match tokio::time::timeout(timeout, self.kind.plugin.query(&conn, req)).await {
            Ok(Ok(result)) => wire::chunks(&result, BATCH),
            Ok(Err(e)) => vec![error_part(scrubbed_error(&e, &conn))],
            Err(_) => vec![error_part(scrubbed_error(&timed_out(timeout), &conn))],
        };
        Ok(Response::new(Box::pin(stream::iter(parts.into_iter().map(Ok)))))
    }

    async fn check_on_save(
        &self,
        request: Request<pb::CheckOnSaveRequest>,
    ) -> Result<Response<pb::CheckOnSaveResponse>, Status> {
        if !self.has(Capability::CheckOnSave) {
            return Err(Status::unimplemented("this kind has no checks on save"));
        }
        let r = request.into_inner();
        let conn = self.connection(r.connection)?;
        let limit = time_left(r.deadline_unix_ms, MAX_HEALTH_TIMEOUT);
        // A check that does not finish in time does not refuse the save, as for built-ins.
        let checked = tokio::time::timeout(limit, self.kind.plugin.check_on_save(&conn)).await.unwrap_or(Ok(()));
        let refusal = checked
            .err()
            .map(|(field, e)| pb::FieldRefusal { field: field.to_string(), error: Some(scrubbed_error(&e, &conn)) });
        Ok(Response::new(pb::CheckOnSaveResponse { refusal }))
    }

    type WatchStream = Parts<pb::WatchEvent>;

    async fn watch(&self, request: Request<pb::WatchRequest>) -> Result<Response<Self::WatchStream>, Status> {
        use pb::watch_event::Event;
        if !self.has(Capability::Watch) {
            return Err(Status::unimplemented("this kind cannot report changes"));
        }
        let w = request.into_inner();
        let q = w.query.ok_or_else(|| Status::invalid_argument("the query is missing"))?;
        let req = source_query(&q)?;
        let conn = self.connection(q.connection)?;
        let resume = self.resume(conn.datasource_id(), w.resume_token.as_deref());
        let event = |e: Event| Ok(pb::WatchEvent { event: Some(e) });
        let events: Self::WatchStream = match self.kind.plugin.watch(&conn, req, resume).await {
            Ok(None) => Box::pin(stream::iter([event(Event::Unsupported(pb::Unsupported {}))])),
            Err(e) => Box::pin(stream::iter([event(Event::Error(scrubbed_error(&e, &conn)))])),
            Ok(Some(feed)) => {
                let tokens = self.tokens.clone();
                Box::pin(feed.map(move |item| match item {
                    Ok(change) => {
                        let token = change.token.map(|t| remember(&tokens, conn.datasource_id(), t));
                        event(Event::Change(pb::Change { changed: change.changed, token }))
                    }
                    Err(e) => event(Event::Error(scrubbed_error(&e, &conn))),
                }))
            }
        };
        Ok(Response::new(events))
    }

    async fn release(&self, request: Request<pb::ReleaseRequest>) -> Result<Response<pb::ReleaseResponse>, Status> {
        let id = request.into_inner().datasource_id;
        self.connections.lock_or_recover().remove(&id);
        Ok(Response::new(pb::ReleaseResponse {}))
    }
}

fn error_part(e: pb::Error) -> pb::QueryChunk {
    pb::QueryChunk { part: Some(pb::query_chunk::Part::Error(e)) }
}

#[cfg(test)]
mod tests {
    use std::any::Any;

    use serde_json::json;

    use super::*;
    use crate::datasources::{Change, ChangeFeed, DataSourcePlugin, FieldError, Health, SourceSchema};
    use crate::shapes::{QueryResult, Shape};

    /// Answers the result its query names, like a plugin with every shape.
    struct Fixtures;

    #[async_trait::async_trait]
    impl DataSourcePlugin for Fixtures {
        fn kind(&self) -> &'static str {
            "dev.example.fixtures"
        }
        fn shapes(&self) -> &'static [Shape] {
            &[Shape::Frame, Shape::Documents, Shape::Graph]
        }
        fn capabilities(&self) -> &'static [Capability] {
            &[Capability::CheckOnSave, Capability::Watch, Capability::Distribution]
        }
        fn check_settings(&self, settings: &Value) -> Result<(), crate::datasources::FieldError> {
            match settings.get("host") {
                Some(Value::String(_)) => Ok(()),
                _ => Err(FieldError::new("host", "settings.required", "host is required")),
            }
        }
        async fn health(&self, conn: &Connection) -> Health {
            let failed = SourceError::from_source(format!("login with {} refused", conn.secret("password").unwrap()));
            if conn.settings()["host"] == "slow" {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
            if conn.settings()["host"] == "down" {
                Health::failed(&failed)
            } else {
                Health::connected("Fixture", "1.0", false)
            }
        }
        async fn schema(&self, _: &Connection) -> Result<SourceSchema, SourceError> {
            Ok(SourceSchema::Metrics { metrics: vec!["up".into()], labels: vec!["job".into()] })
        }
        async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
            match req.query["result"].as_str() {
                Some("frame") => Ok(crate::plugins::test_results::frame()),
                Some("documents") => Ok(crate::plugins::test_results::documents()),
                Some("graph") => Ok(crate::plugins::test_results::graph()),
                Some("slow") => {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Err(SourceError::failed("source.error", "too late"))
                }
                Some("echo") => Ok(QueryResult::Documents {
                    documents: crate::shapes::DocumentSet {
                        documents: vec![
                            json!({
                                "variables": req.variables,
                                "identifiers": req.identifier_variables,
                                "maxRows": req.limits.max_rows,
                                "cursor": req.cursor,
                            })
                            .into(),
                        ],
                        ..Default::default()
                    },
                }),
                _ => Err(SourceError::from_source(format!("bad password {}", conn.secret("password").unwrap()))),
            }
        }
        async fn check_on_save(&self, _: &Connection) -> Result<(), (&'static str, SourceError)> {
            Err(("user", SourceError::rejected("mongodb.login_not_read_only", "the login may write")))
        }
        async fn watch(
            &self,
            _: &Connection,
            req: SourceQuery,
            resume: Option<ResumeToken>,
        ) -> Result<Option<ChangeFeed>, SourceError> {
            if req.query["result"] == "poll" {
                return Ok(None);
            }
            let start = resume.and_then(|t| t.0.downcast_ref::<u32>().copied()).unwrap_or(0);
            let token = |n: u32| Some(ResumeToken(Arc::new(n) as Arc<dyn Any + Send + Sync>));
            Ok(Some(Box::pin(stream::iter([
                Ok(Change { changed: true, token: token(start + 1) }),
                Ok(Change { changed: false, token: token(start + 2) }),
            ]))))
        }
    }

    async fn adapter(kind: Kind, data_dir: &std::path::Path) -> InProcess {
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        let policy = Arc::new(TargetPolicy::new(data_dir, "sqlite::memory:", &[], &[]));
        InProcess::new(Arc::new(kind), policy, Arc::new(OwnDatabase::new(db, "sqlite::memory:")))
    }

    fn fixtures() -> Kind {
        Kind {
            name: "Fixtures",
            hint_key: "datasources.kinds.fixtures.hint",
            settings: &[],
            plugin: Arc::new(Fixtures),
        }
    }

    fn connection(settings: Value, revision: u64) -> Option<pb::Connection> {
        Some(pb::Connection {
            datasource_id: "ds".into(),
            revision,
            settings_json: settings.to_string(),
            secrets: [("password".to_string(), "hunter2-secret".to_string())].into(),
        })
    }

    fn query(conn: Option<pb::Connection>, q: Value) -> pb::QueryRequest {
        pb::QueryRequest {
            connection: conn,
            ref_id: "A".into(),
            query_json: q.to_string(),
            range: Some(pb::TimeRange { from_ms: 0, to_ms: 60_000 }),
            interval_ms: 1000,
            max_data_points: Some(100),
            variables_json: json!({"env": "prod"}).to_string(),
            identifier_variables_restricted: true,
            identifier_variables: vec!["table".into()],
            limits: Some(pb::Limits { timeout_ms: 200, max_rows: 10, max_response_bytes: 1 << 20 }),
            cursor: Some("c1".into()),
            deadline_unix_ms: 0,
        }
    }

    async fn run(adapter: &InProcess, req: pb::QueryRequest) -> wire::Outcome {
        let parts: Vec<_> = adapter.query(Request::new(req)).await.unwrap().into_inner().collect().await;
        wire::assemble(wire::unlimited(), parts.into_iter().map(Result::unwrap)).unwrap()
    }

    #[tokio::test]
    async fn describe_names_the_kind_and_the_protocol_capabilities() {
        let a = adapter(fixtures(), &std::env::temp_dir()).await;
        let d = a.describe(Request::new(pb::DescribeRequest::default())).await.unwrap().into_inner();
        assert_eq!(d.protocol_version, kalzit_plugin_api::PROTOCOL_VERSION);
        assert_eq!(d.kind, "dev.example.fixtures");
        assert_eq!(d.shapes, [pb::Shape::Frame as i32, pb::Shape::Documents as i32, pb::Shape::Graph as i32]);
        // Distribution is not part of protocol version 1.
        assert_eq!(d.capabilities, [pb::Capability::CheckOnSave as i32, pb::Capability::Watch as i32]);
    }

    #[tokio::test]
    async fn every_shape_arrives_as_the_kind_answered_it() {
        let a = adapter(fixtures(), &std::env::temp_dir()).await;
        for (name, expected) in [
            ("frame", crate::plugins::test_results::frame()),
            ("documents", crate::plugins::test_results::documents()),
            ("graph", crate::plugins::test_results::graph()),
        ] {
            let got = run(&a, query(connection(json!({"host": "db"}), 1), json!({"result": name}))).await.unwrap();
            assert_eq!(got, expected, "{name}");
        }
        let echo = run(&a, query(connection(json!({"host": "db"}), 1), json!({"result": "echo"}))).await.unwrap();
        let QueryResult::Documents { documents } = echo else { panic!("documents") };
        assert_eq!(
            documents.documents[0].value(),
            json!({"variables": {"env": "prod"}, "identifiers": ["table"], "maxRows": 10, "cursor": "c1"})
        );
    }

    #[tokio::test]
    async fn errors_and_timeouts_end_the_stream_without_secrets() {
        let a = adapter(fixtures(), &std::env::temp_dir()).await;
        let e = run(&a, query(connection(json!({"host": "db"}), 1), json!({"result": "fail"}))).await.unwrap_err();
        assert_eq!(e.kind, pb::ErrorKind::Failed as i32);
        let detail = e.detail.unwrap();
        assert!(!detail.message.contains("hunter2-secret"), "{}", detail.message);
        assert!(!detail.params.values().any(|v| v.contains("hunter2-secret")));

        let slow = run(&a, query(connection(json!({"host": "db"}), 1), json!({"result": "slow"}))).await.unwrap_err();
        assert_eq!(slow.kind, pb::ErrorKind::Timeout as i32);
        let detail = slow.detail.unwrap();
        assert_eq!(detail.reason, "query.timeout");
        // 200 ms is reported as a second, not as zero seconds.
        assert_eq!(detail.params["seconds"], "1");

        // A deadline in the past ends the call at once.
        let mut late = query(connection(json!({"host": "db"}), 1), json!({"result": "slow"}));
        late.limits.as_mut().unwrap().timeout_ms = 60_000;
        late.deadline_unix_ms = 1;
        let started = std::time::Instant::now();
        let e = run(&a, late).await.unwrap_err();
        assert_eq!(e.kind, pb::ErrorKind::Timeout as i32);
        assert!(started.elapsed() < Duration::from_secs(5));
        let health = a.health(Request::new(pb::HealthRequest {
            connection: connection(json!({"host": "slow"}), 9),
            deadline_unix_ms: 1,
        }));
        let health = health.await.unwrap().into_inner();
        assert_eq!(wire::error_kind(health.error.as_ref().unwrap()), pb::ErrorKind::Timeout);
    }

    #[tokio::test]
    async fn bad_requests_are_refused_as_such() {
        let a = adapter(fixtures(), &std::env::temp_dir()).await;
        let mut no_limits = query(connection(json!({}), 1), json!({}));
        no_limits.limits = None;
        let mut zero = query(connection(json!({}), 1), json!({}));
        zero.limits = Some(pb::Limits { timeout_ms: 0, max_rows: 1, max_response_bytes: 1 });
        let mut not_json = query(connection(json!({}), 1), json!({}));
        not_json.query_json = "{".into();
        let mut list_settings = query(connection(json!({}), 7), json!({}));
        list_settings.connection.as_mut().unwrap().settings_json = "[]".into();
        for req in [no_limits, zero, not_json, list_settings, query(None, json!({}))] {
            let status = a.query(Request::new(req)).await.err().expect("refused");
            assert_eq!(status.code(), tonic::Code::InvalidArgument);
        }
    }

    #[tokio::test]
    async fn settings_health_schema_and_checks_on_save() {
        let a = adapter(fixtures(), &std::env::temp_dir()).await;
        let checked = a
            .check_settings(Request::new(pb::CheckSettingsRequest { settings_json: "{}".into() }))
            .await
            .unwrap()
            .into_inner();
        assert_eq!(checked.error.unwrap().field, "host");

        let ok = a.health(Request::new(pb::HealthRequest {
            deadline_unix_ms: 0,
            connection: connection(json!({"host": "db"}), 1),
        }));
        let ok = ok.await.unwrap().into_inner();
        assert!(ok.ok);
        assert_eq!(ok.detail.unwrap().params["engine"], "Fixture");
        // A new revision is a new connection with the new settings.
        let down = a.health(Request::new(pb::HealthRequest {
            deadline_unix_ms: 0,
            connection: connection(json!({"host": "down"}), 2),
        }));
        let down = down.await.unwrap().into_inner();
        assert!(!down.ok);
        let error = down.error.unwrap();
        assert_eq!(wire::error_kind(&error), pb::ErrorKind::Failed);
        assert!(!error.detail.unwrap().message.contains("hunter2-secret"));

        let schema = a.schema(Request::new(pb::SchemaRequest {
            deadline_unix_ms: 0,
            connection: connection(json!({"host": "db"}), 2),
        }));
        let Some(pb::schema_response::Result::SchemaJson(text)) = schema.await.unwrap().into_inner().result else {
            panic!("a schema")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"kind": "metrics", "metrics": ["up"], "labels": ["job"]})
        );

        let save = a.check_on_save(Request::new(pb::CheckOnSaveRequest {
            deadline_unix_ms: 0,
            connection: connection(json!({}), 3),
        }));
        let refusal = save.await.unwrap().into_inner().refusal.unwrap();
        assert_eq!(refusal.field, "user");
        assert_eq!(refusal.error.unwrap().kind, pb::ErrorKind::Rejected as i32);
    }

    #[tokio::test]
    async fn change_feeds_continue_from_their_tokens() {
        use pb::watch_event::Event;
        let a = adapter(fixtures(), &std::env::temp_dir()).await;
        let watch = |q: Value, resume_token: Option<Vec<u8>>| {
            a.watch(Request::new(pb::WatchRequest { query: Some(query(connection(json!({}), 1), q)), resume_token }))
        };
        let events: Vec<_> = watch(json!({"result": "frame"}), None).await.unwrap().into_inner().collect().await;
        let changes: Vec<pb::Change> = events
            .into_iter()
            .map(|e| match e.unwrap().event {
                Some(Event::Change(c)) => c,
                other => panic!("{other:?}"),
            })
            .collect();
        assert_eq!(changes.iter().map(|c| c.changed).collect::<Vec<_>>(), [true, false]);
        // Continuing after the second position counts on from 2.
        let resumed: Vec<_> =
            watch(json!({"result": "frame"}), changes[1].token.clone()).await.unwrap().into_inner().collect().await;
        let Some(Event::Change(first)) = resumed[0].as_ref().unwrap().event.clone() else { panic!("a change") };
        let held = a.resume("ds", first.token.as_deref()).unwrap();
        assert_eq!(held.0.downcast_ref::<u32>(), Some(&3));
        // A token is only good for the data source whose feed handed it out.
        assert!(a.resume("other", first.token.as_deref()).is_none());

        let poll: Vec<_> = watch(json!({"result": "poll"}), None).await.unwrap().into_inner().collect().await;
        assert!(matches!(poll[0].as_ref().unwrap().event, Some(Event::Unsupported(_))));
    }

    #[tokio::test]
    async fn kinds_without_a_capability_refuse_its_calls() {
        let dir = tempfile::tempdir().unwrap();
        let a = adapter(crate::datasources::sqlite::kind(), dir.path()).await;
        let save = a
            .check_on_save(Request::new(pb::CheckOnSaveRequest {
                deadline_unix_ms: 0,
                connection: connection(json!({}), 1),
            }))
            .await;
        assert_eq!(save.err().unwrap().code(), tonic::Code::Unimplemented);
        let req = pb::WatchRequest { query: Some(query(connection(json!({}), 1), json!({}))), resume_token: None };
        assert_eq!(a.watch(Request::new(req)).await.err().unwrap().code(), tonic::Code::Unimplemented);
    }

    /// A built-in kind answers through the protocol exactly what it answers directly.
    #[tokio::test]
    async fn a_built_in_kind_answers_the_same_through_the_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let file = crate::datasources::sample::ensure(dir.path()).await.unwrap();
        let a = adapter(crate::datasources::sqlite::kind(), dir.path()).await;
        let settings = json!({"path": file.to_string_lossy()});
        let sql = json!({"sql": "SELECT name, id FROM regions ORDER BY name"});
        let mut req = query(connection(settings.clone(), 1), sql);
        req.limits = Some(pb::Limits { timeout_ms: 10_000, max_rows: 100, max_response_bytes: 1 << 20 });
        req.identifier_variables_restricted = false;
        let through = run(&a, req.clone()).await.unwrap();

        let conn = a.connection(connection(settings, 1)).unwrap();
        let direct = crate::datasources::sqlite::kind().plugin.query(&conn, source_query(&req).unwrap()).await.unwrap();
        assert_eq!(through, direct);
        let QueryResult::Frame { frame } = &through else { panic!("a frame") };
        assert!(frame.rows() > 0);

        let health =
            a.health(Request::new(pb::HealthRequest { deadline_unix_ms: 0, connection: req.connection.clone() }));
        assert!(health.await.unwrap().into_inner().ok);
        drop(conn);
        a.release(Request::new(pb::ReleaseRequest { datasource_id: "ds".into() })).await.unwrap();
        assert!(a.connections.lock().unwrap().is_empty());
    }
}
