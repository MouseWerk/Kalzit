//! Neo4j and Memgraph over Bolt (`bolt.rs`). Queries are Cypher, checked by `cypher.rs`, run in a
//! read transaction (`BEGIN {mode: "r"}`) that is always rolled back, with variables and macros
//! bound as parameters.
//!
//! Neo4j enforces the read transaction on the server: a write in it fails. Memgraph accepts the
//! read mode but does not enforce it, so for Memgraph the login's privileges decide. Every new
//! Memgraph connection first checks whether the user may write: it runs each writing clause
//! (`CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE`) on `MATCH (n) WHERE false`, which matches nothing,
//! inside a transaction that is rolled back. Memgraph checks privileges before it runs a query,
//! so a read-only user gets "not authorized" for each, and a user who may write gets an empty
//! result without anything being changed. A source whose user may write is refused, unless a
//! data source admin set `allowWriteCapableUser` (needed for Memgraph Community, which has no
//! read-only users); then Test connection says so and only the Cypher check protects the data.
//!
//! Results: nodes, relationships and paths become a `graph` (paths stay paths); a result without
//! them becomes a `frame`. Columns of other values next to graph values are left out of a graph,
//! with a notice naming them.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use super::Detail;
use super::bolt::{self, BoltConn, BoltError, Bv, PullEnd};
use super::cypher::Checked;
use super::frame::{Column, FrameBuilder};
use super::graph::{GraphBuilder, GraphLimits, float_value, int_value};
use super::pool::{ConnPool, Lease, Pooled};
use super::{
    Connection, DataSourcePlugin, DefaultValue, FieldError, Health, Kind, SettingField, SettingType, SourceError,
    SourceQuery, SourceSchema,
};
use crate::shapes::{Edge, FieldType, GraphPath, Node, NoticeSeverity, QueryResult, Shape};

const fn common() -> [SettingField; 10] {
    [
        SettingField::new("host", "datasources.settings.host", SettingType::String).target().required(),
        SettingField::new("port", "datasources.settings.port", SettingType::Number)
            .target()
            .default(DefaultValue::Number(7687)),
        SettingField::new("database", "datasources.settings.database", SettingType::String).target(),
        SettingField::new("user", "datasources.settings.user", SettingType::String).target(),
        SettingField::new("password", "datasources.settings.password", SettingType::String).secret(),
        SettingField::new("encrypt", "datasources.settings.encrypt", SettingType::Bool)
            .target()
            .default(DefaultValue::Bool(false)),
        SettingField::new("trustServerCertificate", "datasources.settings.trustServerCertificate", SettingType::Bool)
            .target()
            .default(DefaultValue::Bool(false)),
        SettingField::new("caCert", "datasources.settings.caCert", SettingType::Text).target(),
        SettingField::new("maxNodes", "datasources.settings.maxNodes", SettingType::Number),
        SettingField::new("maxEdges", "datasources.settings.maxEdges", SettingType::Number),
    ]
}

const NEO4J_SETTINGS: &[SettingField] = &common();
const MEMGRAPH_SETTINGS: &[SettingField] = &{
    let c = common();
    [
        c[0],
        c[1],
        c[2],
        c[3],
        c[4],
        c[5],
        c[6],
        c[7],
        c[8],
        c[9],
        // Deciding that only the Cypher check protects the data is an admin's decision, so the
        // field is a target field (it needs the admin level and the secrets again to change).
        SettingField::new("allowWriteCapableUser", "datasources.settings.allowWriteCapableUser", SettingType::Bool)
            .target()
            .default(DefaultValue::Bool(false)),
    ]
};

const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// A pooled Memgraph connection older than this has its user's privileges checked again before use.
const RECHECK: Duration = Duration::from_secs(60);
/// Records asked for per PULL.
const BATCH: i64 = 1000;
/// The largest single message read, whatever the budget.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;
/// Names the schema answers per list.
const MAX_SCHEMA_NAMES: usize = 10_000;

pub fn neo4j() -> Kind {
    Kind {
        name: "Neo4j",
        hint_key: "datasources.kinds.neo4j.hint",
        settings: NEO4J_SETTINGS,
        plugin: Arc::new(GraphDb(Flavor::Neo4j)),
    }
}

pub fn memgraph() -> Kind {
    Kind {
        name: "Memgraph",
        hint_key: "datasources.kinds.memgraph.hint",
        settings: MEMGRAPH_SETTINGS,
        plugin: Arc::new(GraphDb(Flavor::Memgraph)),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Flavor {
    Neo4j,
    Memgraph,
}

impl Flavor {
    fn engine(self) -> &'static str {
        match self {
            Flavor::Neo4j => "Neo4j",
            Flavor::Memgraph => "Memgraph",
        }
    }
}

pub struct GraphDb(Flavor);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    host: String,
    port: Option<u64>,
    database: Option<String>,
    user: Option<String>,
    encrypt: Option<bool>,
    trust_server_certificate: Option<bool>,
    ca_cert: Option<String>,
    max_nodes: Option<u64>,
    max_edges: Option<u64>,
    allow_write_capable_user: Option<bool>,
}

/// `{"cypher": "MATCH ..."}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CypherQuery {
    cypher: String,
}

/// `{"communities": {"nodeIds": [...]}}`: the communities of these nodes, by the database's own
/// algorithm (see `communities`). The graph panel asks for it above the size it computes itself.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CommunitiesQuery {
    communities: CommunityNodes,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommunityNodes {
    node_ids: Vec<String>,
}

/// The most nodes one community request may name.
const MAX_COMMUNITY_NODES: usize = 100_000;

/// A connection and what Kalzit learned when it opened it.
struct Opened {
    conn: BoltConn,
    /// Memgraph: the writing clauses the user may run (empty when read-only or for Neo4j).
    write_privileges: Vec<&'static str>,
    /// When the privileges were last checked.
    checked: Instant,
}

/// Bolt has no pool of its own; this one (`pool.rs`) bounds the open connections and closes idle
/// ones. One the server closed while it waited (a restart) is dropped, not handed out.
impl Pooled for Opened {
    fn reusable(&mut self) -> bool {
        !self.conn.broken && self.conn.is_alive()
    }

    /// Given up mid-query (timeout, cancelled request, a limit reached): interrupted and closed
    /// (`BoltConn::interrupt`), which stops the server's query and ends its transaction.
    async fn abandon(self) {
        self.conn.interrupt().await;
    }
}

/// What a source's connections share: the pool and the gate of community requests.
struct Shared {
    pool: Arc<ConnPool<Opened>>,
    /// One community request at a time per source (see `communities`).
    communities: Arc<tokio::sync::Semaphore>,
}

async fn shared(conn: &Connection) -> Result<Arc<Shared>, SourceError> {
    conn.shared(|| async {
        Ok(Shared {
            pool: Arc::new(ConnPool::new(POOL_SIZE, IDLE_TIMEOUT)),
            communities: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    })
    .await
}

async fn pool(conn: &Connection) -> Result<Arc<ConnPool<Opened>>, SourceError> {
    Ok(shared(conn).await?.pool.clone())
}

async fn lease(flavor: Flavor, conn: &Connection, pool: &Arc<ConnPool<Opened>>) -> Result<Lease<Opened>, SourceError> {
    loop {
        let mut lease = pool.checkout(|| open(flavor, conn)).await?;
        // A user's privileges can change while a connection waits in the pool; every pooled
        // connection due for it is checked, also one taken after a broken one.
        if !(lease.reused() && needs_recheck(flavor, lease.checked.elapsed())) {
            return Ok(lease);
        }
        let s: Settings = conn.settings_as()?;
        match checked_privileges(&mut lease.conn, &s).await {
            Ok(privileges) => {
                lease.write_privileges = privileges;
                lease.checked = Instant::now();
                return Ok(lease);
            }
            // The check is the connection's first round trip: one that broke while it waited
            // is closed, with the other idle ones, and the next one is taken (most likely a
            // fresh one, which needs no check).
            Err(e) if super::connect::is_lost(&e) => lease.discard(),
            Err(e) => return Err(e),
        }
    }
}

/// Whether a pooled connection has its user's privileges checked again before use.
fn needs_recheck(flavor: Flavor, since_check: Duration) -> bool {
    flavor == Flavor::Memgraph && since_check > RECHECK
}

async fn open(flavor: Flavor, conn: &Connection) -> Result<Opened, SourceError> {
    let s: Settings = conn.settings_as()?;
    let tls = s
        .encrypt
        .unwrap_or(false)
        .then(|| bolt::Tls { ca_pem: s.ca_cert.clone(), trust_any: s.trust_server_certificate.unwrap_or(false) });
    let opts = bolt::ConnectOptions {
        host: &s.host,
        port: s.port.unwrap_or(7687) as u16,
        user: s.user.as_deref(),
        password: conn.secret("password"),
        tls,
        timeout: CONNECT_TIMEOUT,
    };
    let mut c = bolt::connect(conn.policy(), opts).await?;
    let mut write_privileges = Vec::new();
    if flavor == Flavor::Memgraph {
        write_privileges = checked_privileges(&mut c, &s).await?;
    }
    Ok(Opened { conn: c, write_privileges, checked: Instant::now() })
}

/// The Memgraph user's writing clauses, or the refusal when it may write and the settings do not
/// allow that.
async fn checked_privileges(c: &mut BoltConn, s: &Settings) -> Result<Vec<&'static str>, SourceError> {
    let write_privileges = memgraph_write_privileges(c, s.database.as_deref()).await?;
    if !write_privileges.is_empty() && !s.allow_write_capable_user.unwrap_or(false) {
        let list = write_privileges.join(", ");
        return Err(SourceError::failed(
            "memgraph.user_can_write",
            format!(
                "the Memgraph user has privileges beyond reading ({list}: writing clauses, reading server \
                 files, users, triggers, streams or settings); use a user without them, or allow a \
                 write-capable user in the settings"
            ),
        )
        .with("privileges", list));
    }
    Ok(write_privileges)
}

/// How a probe runs and what its answer means.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Probe {
    /// A writing clause on nothing, in a transaction that is rolled back. Success means the
    /// privilege; another failure than a refusal means Kalzit cannot tell.
    Clause,
    /// `LOAD CSV` of a file that does not exist, on no rows, rolled back: past the privilege
    /// check, any answer (also "file not found") means the privilege.
    ReadFile,
    /// A harmless `SHOW` (auto-commit, as Memgraph runs such queries only outside transactions):
    /// success means the privilege; another failure means the feature is missing here.
    Show,
}

const PROBES: &[(&str, Probe, &str)] = &[
    ("CREATE", Probe::Clause, "MATCH (n) WHERE false CREATE (n)-[:KALZIT_PROBE]->(n)"),
    ("MERGE", Probe::Clause, "MATCH (n) WHERE false MERGE (n)-[:KALZIT_PROBE]->(n)"),
    ("SET", Probe::Clause, "MATCH (n) WHERE false SET n.kalzit_probe = 1"),
    ("REMOVE", Probe::Clause, "MATCH (n) WHERE false REMOVE n.kalzit_probe"),
    ("DELETE", Probe::Clause, "MATCH (n) WHERE false DETACH DELETE n"),
    (
        "READ_FILE",
        Probe::ReadFile,
        "UNWIND [] AS x LOAD CSV FROM '/kalzit-probe-that-does-not-exist.csv' NO HEADER AS row RETURN row",
    ),
    ("AUTH", Probe::Show, "SHOW USERS"),
    ("TRIGGER", Probe::Show, "SHOW TRIGGERS"),
    ("STREAM", Probe::Show, "SHOW STREAMS"),
    ("CONFIG", Probe::Show, "SHOW CONFIG"),
];

/// Memgraph's refusal of a query the user lacks the privilege for, and a replica's or read-only
/// instance's refusal of any write: either way the write cannot happen.
fn is_denied(message: &str) -> bool {
    let m = message.to_lowercase();
    ["not authorized", "privilege", "permission", "forbidden on the replica", "replica", "read-only", "read only"]
        .iter()
        .any(|w| m.contains(w))
}

/// The writing clauses Memgraph lets this user run (see the module documentation).
async fn memgraph_write_privileges(c: &mut BoltConn, db: Option<&str>) -> Result<Vec<&'static str>, SourceError> {
    let mut allowed = Vec::new();
    for (privilege, kind, probe) in PROBES {
        let in_tx = *kind != Probe::Show;
        if in_tx {
            c.begin(db, CONNECT_TIMEOUT, false).await.map_err(BoltError::into_source)?;
        }
        let ran = async {
            if in_tx {
                c.run(probe, Vec::new()).await?;
            } else {
                c.run_auto(probe, db).await?;
            }
            c.pull(-1, 1 << 20, |_, _| true).await
        }
        .await;
        match (ran, kind) {
            (Ok(_), _) => {
                allowed.push(*privilege);
                if in_tx {
                    c.rollback().await.map_err(BoltError::into_source)?;
                }
            }
            (Err(BoltError::Failure { message, .. }), _) if is_denied(&message) => {
                c.reset().await.map_err(BoltError::into_source)?;
            }
            (Err(BoltError::Failure { .. }), Probe::ReadFile) => {
                allowed.push(*privilege);
                c.reset().await.map_err(BoltError::into_source)?;
            }
            (Err(BoltError::Failure { .. }), Probe::Show) => {
                c.reset().await.map_err(BoltError::into_source)?;
            }
            (Err(BoltError::Failure { message, .. }), Probe::Clause) => {
                return Err(SourceError::failed(
                    "memgraph.privileges_unverifiable",
                    format!("cannot check whether the Memgraph user may write: {message}"),
                )
                .with("detail", message));
            }
            (Err(other), _) => return Err(other.into_source()),
        }
    }
    Ok(allowed)
}

/// Runs `query` in a read transaction and collects every record (small internal queries).
async fn read_all(c: &mut BoltConn, db: Option<&str>, query: &str) -> Result<Vec<Vec<Bv>>, BoltError> {
    c.begin(db, CONNECT_TIMEOUT, true).await?;
    c.run(query, Vec::new()).await?;
    let mut rows = Vec::new();
    loop {
        match c
            .pull(BATCH, MAX_MESSAGE, |r, _| {
                rows.push(r);
                rows.len() <= MAX_SCHEMA_NAMES
            })
            .await?
        {
            PullEnd::More => continue,
            PullEnd::Done => break,
            PullEnd::Stopped => return Err(BoltError::Protocol("too many rows for an internal query".into())),
        }
    }
    c.rollback().await?;
    Ok(rows)
}

/// An auto-commit query whose failure is not an error (version and license information).
async fn try_auto(c: &mut BoltConn, db: Option<&str>, query: &str) -> Option<Vec<Vec<Bv>>> {
    let ran = async {
        c.run_auto(query, db).await?;
        let mut rows = Vec::new();
        c.pull(-1, 1 << 20, |r, _| {
            rows.push(r);
            rows.len() < 1000
        })
        .await?;
        Ok::<_, BoltError>(rows)
    }
    .await;
    match ran {
        Ok(rows) => Some(rows),
        Err(_) => {
            // Back to a usable state; a connection that cannot even reset is dropped by the caller.
            let _ = c.reset().await;
            None
        }
    }
}

/// "Neo4j/5.26.0" or "Neo4j/v5.11.0 compatible graph database server - Memgraph" to a version.
fn agent_version(agent: &str) -> String {
    agent.split('/').nth(1).and_then(|v| v.split_whitespace().next()).unwrap_or("").trim_start_matches('v').to_string()
}

fn texts(rows: &[Vec<Bv>]) -> Vec<String> {
    let mut out: Vec<String> = rows
        .iter()
        .filter_map(|r| r.first().and_then(Bv::as_str).map(String::from))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    out.truncate(MAX_SCHEMA_NAMES);
    out
}

#[async_trait::async_trait]
impl DataSourcePlugin for GraphDb {
    fn kind(&self) -> &'static str {
        match self.0 {
            Flavor::Neo4j => "neo4j",
            Flavor::Memgraph => "memgraph",
        }
    }

    fn shapes(&self) -> &'static [Shape] {
        &[Shape::Graph, Shape::Frame]
    }

    fn capabilities(&self) -> &'static [super::Capability] {
        &[super::Capability::Pushdown]
    }

    fn pushdown(&self, query: &Value, step: &crate::analysis::StepKind, max_rows: usize) -> Option<Value> {
        let q = CypherQuery::deserialize(query).ok()?;
        let dialect = match self.0 {
            Flavor::Neo4j => crate::analysis::pushdown::Dialect::Neo4j,
            Flavor::Memgraph => crate::analysis::pushdown::Dialect::Memgraph,
        };
        crate::analysis::pushdown::cypher(&q.cypher, step, dialect, max_rows).map(|cypher| json!({ "cypher": cypher }))
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        let s = Settings::deserialize(settings)
            .map_err(|e| FieldError::new("settings", "settings.invalid", e.to_string()).with("detail", e))?;
        super::check_host("host", &s.host)?;
        super::check_port("port", s.port)?;
        super::check_pem("caCert", s.ca_cert.as_deref())?;
        for (field, value) in [("maxNodes", s.max_nodes), ("maxEdges", s.max_edges)] {
            if value == Some(0) {
                return Err(FieldError::new(field, "settings.out_of_range", format!("{field} must be at least 1"))
                    .with("min", 1));
            }
        }
        Ok(())
    }

    async fn health(&self, conn: &Connection) -> Health {
        let flavor = self.0;
        let check = async {
            let s: Settings = conn.settings_as()?;
            let db = s.database.as_deref();
            let pool = pool(conn).await?;
            let mut lease = lease(flavor, conn, &pool).await?;
            let agent = lease.conn.server.clone();
            let mut version = agent_version(&agent);
            let mut edition = String::new();
            match flavor {
                Flavor::Neo4j => {
                    let rows = read_all(
                        &mut lease.conn,
                        db,
                        "CALL dbms.components() YIELD name, versions, edition RETURN versions[0], edition",
                    )
                    .await
                    .map_err(BoltError::into_source)?;
                    if let Some(row) = rows.first() {
                        version = row.first().and_then(Bv::as_str).unwrap_or(&version).to_string();
                        edition = row.get(1).and_then(Bv::as_str).unwrap_or("").to_string();
                    }
                }
                Flavor::Memgraph => {
                    // Test connection checks the privileges again, also on a pooled connection.
                    lease.write_privileges = checked_privileges(&mut lease.conn, &s).await?;
                    if let Some(rows) = try_auto(&mut lease.conn, db, "SHOW VERSION").await
                        && let Some(v) = rows.first().and_then(|r| r.first()).and_then(Bv::as_str)
                    {
                        version = v.to_string();
                    }
                    if let Some(rows) = try_auto(&mut lease.conn, db, "SHOW LICENSE INFO").await {
                        let valid = rows.iter().any(|r| {
                            r.first().and_then(Bv::as_str) == Some("is_valid") && r.get(1) == Some(&Bv::Bool(true))
                        });
                        edition = if valid { "enterprise" } else { "community" }.to_string();
                    }
                }
            }
            let write = lease.write_privileges.join(", ");
            lease.release();
            Ok::<_, SourceError>((version, edition, write))
        };
        match check.await {
            Ok((version, edition, write)) => {
                let engine = flavor.engine();
                let mut health = if write.is_empty() {
                    Health::connected(engine, &version, false)
                } else {
                    let detail = Detail::new(
                        "health.connected_write_capable",
                        format!(
                            "{engine} {version}; the user may write ({write}), so only Kalzit's query check keeps \
                             queries read-only"
                        ),
                    )
                    .with("engine", engine)
                    .with("version", &version)
                    .with("privileges", &write);
                    Health { ok: true, code: None, detail, warnings: Vec::new() }
                };
                if !edition.is_empty() {
                    health.detail = health.detail.with("edition", edition);
                }
                health
            }
            Err(e) => Health::failed(&e),
        }
    }

    async fn schema(&self, conn: &Connection) -> Result<SourceSchema, SourceError> {
        let s: Settings = conn.settings_as()?;
        let db = s.database.as_deref();
        let pool = pool(conn).await?;
        let mut lease = lease(self.0, conn, &pool).await?;
        let queries: [&str; 3] = match self.0 {
            Flavor::Neo4j => [
                "CALL db.labels() YIELD label RETURN label",
                "CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType",
                "CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey",
            ],
            // Memgraph has no such procedures without its schema metadata option; a sample of the
            // graph answers the same question within bounded work.
            Flavor::Memgraph => [
                "MATCH (n) WITH n LIMIT 10000 UNWIND labels(n) AS l RETURN DISTINCT l",
                "MATCH ()-[r]->() WITH r LIMIT 10000 RETURN DISTINCT type(r)",
                "MATCH (n) WITH n LIMIT 10000 UNWIND keys(n) AS k RETURN DISTINCT k",
            ],
        };
        let mut lists = Vec::new();
        for q in queries {
            lists.push(texts(&read_all(&mut lease.conn, db, q).await.map_err(BoltError::into_source)?));
        }
        lease.release();
        let [labels, edge_types, property_keys]: [Vec<String>; 3] = lists.try_into().expect("three lists");
        Ok(SourceSchema::Graph {
            labels,
            edge_types,
            property_keys,
            queries: Vec::new(),
            query_params: BTreeMap::new(),
        })
    }

    async fn query(&self, conn: &Connection, req: SourceQuery) -> Result<QueryResult, SourceError> {
        if req.query.get("communities").is_some() {
            let q: CommunitiesQuery = req.parse()?;
            return communities(self.0, conn, &req, &q.communities.node_ids).await;
        }
        let q: CypherQuery = req.parse()?;
        let checked = super::cypher::check(&q.cypher).map_err(SourceError::Rejected)?;
        let s: Settings = conn.settings_as()?;
        let db = s.database.as_deref();
        let pool = pool(conn).await?;
        let first = lease(self.0, conn, &pool).await?;
        let reused = first.reused();
        match run(first, conn, &req, &q.cypher, &checked, db).await {
            // The pooled connection broke before any record arrived (the server restarted after
            // it was checked): once more on a fresh connection, which is safe as the query only
            // reads. A query error is never retried.
            Err(Attempt::Lost(_)) if reused => {
                let fresh = lease(self.0, conn, &pool).await?;
                run(fresh, conn, &req, &q.cypher, &checked, db).await.map_err(Attempt::into_source)
            }
            other => other.map_err(Attempt::into_source),
        }
    }
}

/// How a query attempt failed: the connection broke before any record arrived, or anything else.
enum Attempt {
    Lost(SourceError),
    Failed(SourceError),
}

impl Attempt {
    fn into_source(self) -> SourceError {
        match self {
            Attempt::Lost(e) | Attempt::Failed(e) => e,
        }
    }
}

/// The node key in the community queries: Memgraph's integer id, which Bolt 4.4 sends for Neo4j
/// as well; Neo4j 5's element id otherwise.
fn community_key(numeric: bool) -> &'static str {
    if numeric { "id" } else { "elementId" }
}

/// Memgraph MAGE: Louvain over the given nodes and the relationships between them, in one read
/// query with no state left behind.
fn memgraph_community_query() -> &'static str {
    "MATCH (n) WHERE id(n) IN $ids \
     OPTIONAL MATCH (n)-[r]->(m) WHERE id(m) IN $ids \
     WITH collect(DISTINCT n) AS nodes, collect(r) AS rels \
     CALL community_detection.get_subgraph(nodes, rels) YIELD node, community_id \
     RETURN id(node) AS id, community_id AS community"
}

/// Neo4j GDS needs a projected graph: these three queries project the given nodes and the
/// relationships between them under a name made for this request, stream Louvain over it and
/// drop it. Their text is fixed, the nodes and the name are parameters.
fn neo4j_community_queries(numeric: bool) -> [String; 3] {
    let key = community_key(numeric);
    [
        format!(
            "MATCH (n) WHERE {key}(n) IN $ids \
             OPTIONAL MATCH (n)-->(m) WHERE {key}(m) IN $ids \
             WITH gds.graph.project($graph, n, m, {{}}, {{undirectedRelationshipTypes: ['*']}}) AS g \
             RETURN g.nodeCount AS nodes"
        ),
        format!(
            "CALL gds.louvain.stream($graph) YIELD nodeId, communityId \
             RETURN {key}(gds.util.asNode(nodeId)) AS id, communityId AS community"
        ),
        "CALL gds.graph.drop($graph, false) YIELD graphName RETURN graphName".to_string(),
    ]
}

/// Runs `query` with `params` in a read transaction and collects up to `max_rows` records. After
/// a query error the connection is reset, so it can run the next query.
async fn internal_rows(
    c: &mut BoltConn,
    db: Option<&str>,
    timeout: Duration,
    query: &str,
    params: Vec<(String, Bv)>,
    max_rows: usize,
) -> Result<Vec<Vec<Bv>>, BoltError> {
    let ran = async {
        c.begin(db, timeout, true).await?;
        c.run(query, params).await?;
        let mut rows = Vec::new();
        loop {
            match c
                .pull(BATCH, MAX_MESSAGE, |r, _| {
                    rows.push(r);
                    rows.len() <= max_rows
                })
                .await?
            {
                PullEnd::More => continue,
                PullEnd::Done => break,
                PullEnd::Stopped => return Err(BoltError::Protocol("too many rows for an internal query".into())),
            }
        }
        c.rollback().await?;
        Ok(rows)
    }
    .await;
    if matches!(ran, Err(BoltError::Failure { .. })) {
        let _ = c.reset().await;
    }
    ran
}

/// Lists the graphs left by community requests that could not drop theirs (a connection that
/// broke, a server that stopped): those older than `$age` seconds by the database's clock. A
/// younger one may belong to a request still running on another Kalzit server that shares the
/// database (high availability), so it stays.
const SWEEP_QUERY: &str = "CALL gds.graph.list() YIELD graphName, creationTime \
     WHERE graphName STARTS WITH 'kalzit-communities-' \
     AND creationTime < datetime() - duration({seconds: $age}) RETURN graphName";

/// How much older than a request's time limit a leftover graph must be before a sweep drops it.
const SWEEP_MARGIN: Duration = Duration::from_secs(600);

/// The `$age` of `SWEEP_QUERY` for requests with this time limit, in seconds.
fn sweep_age(timeout: Duration) -> i64 {
    (timeout + SWEEP_MARGIN).as_secs().try_into().unwrap_or(i64::MAX)
}

/// The communities of the given nodes by the database's own algorithm: Memgraph MAGE's
/// `community_detection.get_subgraph`, Neo4j GDS's Louvain on a graph projected for this request
/// (`neo4j_communities`). Answers a frame of `id` and `community`. A database without the library
/// answers its error, and the panel goes without. The user needs `datasources:query` on the
/// source like for any free query (the route checks). One request per source runs at a time.
async fn communities(
    flavor: Flavor,
    conn: &Connection,
    req: &SourceQuery,
    ids: &[String],
) -> Result<QueryResult, SourceError> {
    if ids.is_empty() || ids.len() > MAX_COMMUNITY_NODES {
        return Err(SourceError::rejected(
            "graph.communities_size",
            format!("communities are asked for 1 to {MAX_COMMUNITY_NODES} nodes"),
        ));
    }
    let numbers: Option<Vec<i64>> = ids.iter().map(|id| id.parse::<i64>().ok()).collect();
    let numeric = numbers.is_some();
    let id_list = match (numbers, flavor) {
        (Some(n), _) => Bv::List(n.into_iter().map(Bv::Int).collect()),
        (None, Flavor::Memgraph) => {
            return Err(SourceError::rejected("graph.communities_ids", "Memgraph node ids are numbers"));
        }
        (None, Flavor::Neo4j) => Bv::List(ids.iter().map(|id| Bv::String(id.clone())).collect()),
    };
    let s: Settings = conn.settings_as()?;
    let shared = shared(conn).await?;
    let permit = shared
        .communities
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| SourceError::failed("internal", "internal: the community gate is closed"))?;
    let mut lease = lease(flavor, conn, &shared.pool).await?;
    let timeout = req.limits.timeout;
    let max_rows = ids.len();
    let (rows, executed) = match flavor {
        Flavor::Memgraph => {
            let q = memgraph_community_query();
            let db = s.database.as_deref();
            let rows = internal_rows(&mut lease.conn, db, timeout, q, vec![("ids".into(), id_list)], max_rows).await;
            drop(permit);
            (finish_lease(lease, rows)?, q.to_string())
        }
        Flavor::Neo4j => {
            let [_, stream, _] = neo4j_community_queries(numeric);
            // A task of its own, so a request given up halfway (a closed tab, a timeout) still
            // drops its graph; it keeps the gate until then.
            let task = tokio::spawn(neo4j_communities(lease, s.database, timeout, numeric, id_list, max_rows, permit));
            let rows =
                task.await.map_err(|_| SourceError::failed("internal", "internal: the community task stopped"))??;
            (rows, stream)
        }
    };
    let columns = vec![Column::new("id", Some(FieldType::String)), Column::new("community", Some(FieldType::Number))];
    let mut frame = FrameBuilder::new(columns, max_rows, req.limits.budget.clone());
    frame.executed_query(executed);
    for row in rows {
        let id = match row.first() {
            Some(Bv::Int(i)) => Value::String(i.to_string()),
            Some(Bv::String(s)) => Value::String(s.clone()),
            _ => continue,
        };
        let community = match row.get(1) {
            Some(Bv::Int(i)) => json!(i),
            _ => continue,
        };
        if !frame.push_row(vec![id, community]) {
            break;
        }
    }
    Ok(QueryResult::Frame { frame: frame.finish() })
}

/// Back to the pool when the connection is still good, else closed; answers the rows or the error.
fn finish_lease(lease: Lease<Opened>, rows: Result<Vec<Vec<Bv>>, BoltError>) -> Result<Vec<Vec<Bv>>, SourceError> {
    let dead = lease.conn.broken || matches!(&rows, Err(e) if e.is_dead());
    if dead {
        lease.discard();
    } else {
        lease.release();
    }
    rows.map_err(BoltError::into_source)
}

/// Neo4j GDS: drops what earlier requests left (`SWEEP_QUERY`: graphs older than any request of
/// this time limit, here or on another Kalzit server, could still use), projects the nodes under a name made for this request, streams
/// Louvain and drops the graph, also when the stream failed. Only a broken connection skips the
/// drop; the next request's sweep removes that graph. `permit` is the source's community gate,
/// held until the graph is gone.
async fn neo4j_communities(
    mut lease: Lease<Opened>,
    db: Option<String>,
    timeout: Duration,
    numeric: bool,
    ids: Bv,
    max_rows: usize,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<Vec<Vec<Bv>>, SourceError> {
    let db = db.as_deref();
    let c = &mut lease.conn;
    let [project, stream, drop_graph] = neo4j_community_queries(numeric);
    let named = |name: &Bv| vec![("graph".to_string(), name.clone())];
    let rows = async {
        let left =
            internal_rows(c, db, timeout, SWEEP_QUERY, vec![("age".into(), Bv::Int(sweep_age(timeout)))], 10_000)
                .await?;
        for row in left {
            if let Some(name @ Bv::String(_)) = row.first() {
                internal_rows(c, db, CONNECT_TIMEOUT, &drop_graph, named(name), 1).await?;
            }
        }
        let graph = Bv::String(format!("kalzit-communities-{}", uuid::Uuid::now_v7().simple()));
        let mut projecting = named(&graph);
        projecting.push(("ids".into(), ids));
        let mut rows = internal_rows(c, db, timeout, &project, projecting, 1).await;
        if rows.is_ok() {
            rows = internal_rows(c, db, timeout, &stream, named(&graph), max_rows).await;
        }
        // `false`: a projection that failed left no graph, which is no error.
        if !c.broken {
            let dropped = internal_rows(c, db, CONNECT_TIMEOUT, &drop_graph, named(&graph), 1).await;
            if rows.is_ok()
                && let Err(e) = dropped
            {
                return Err(e);
            }
        }
        rows
    }
    .await;
    drop(permit);
    finish_lease(lease, rows)
}

/// One run of a query on the leased connection, which goes back to the pool after a clean finish.
async fn run(
    mut lease: Lease<Opened>,
    conn: &Connection,
    req: &SourceQuery,
    cypher: &str,
    checked: &Checked,
    db: Option<&str>,
) -> Result<QueryResult, Attempt> {
    let params = parameters(checked, req, lease.conn.utc).map_err(Attempt::Failed)?;
    let mut received = false;
    let outcome = async {
        let c = &mut lease.conn;
        let utc = c.utc;
        c.begin(db, req.limits.timeout, true).await?;
        let fields = c.run(cypher, params).await?;
        let limits = GraphLimits::from_settings(conn.settings(), req.limits.max_rows, req.limits.budget.clone());
        let mut result = Collector::new(fields, utc, limits, req);
        let mut clean = true;
        loop {
            let max_message = req.limits.budget.remaining().saturating_add(1024).min(MAX_MESSAGE);
            let pulled = c
                .pull(BATCH, max_message, |record, size| {
                    received = true;
                    result.push(record, size)
                })
                .await;
            match pulled {
                Ok(PullEnd::More) => continue,
                Ok(PullEnd::Done) => break,
                Ok(PullEnd::Stopped) => {
                    clean = false;
                    break;
                }
                Err(BoltError::TooLarge(_)) => {
                    result.size_limited();
                    clean = false;
                    break;
                }
                Err(e) => return Err(e),
            }
        }
        if clean {
            c.rollback().await?;
        }
        Ok((result, clean))
    }
    .await;
    match outcome {
        Ok((result, clean)) => {
            if clean {
                lease.release();
            }
            Ok(result.finish(cypher.to_string()))
        }
        Err(e) if e.is_dead() => {
            lease.discard();
            let lost = e.into_source();
            Err(if received { Attempt::Failed(lost) } else { Attempt::Lost(lost) })
        }
        Err(e) => Err(Attempt::Failed(e.into_source())),
    }
}

/// The values of the parameters the query uses: macros and the request's variables. Variables are
/// always Bolt parameters, never text in the query. A parameter used as a name (a dynamic label
/// or type, `Checked::identifier_params`) takes only a variable that may be an identifier: on a
/// dashboard a constant or custom one, whose values the dashboard lists (`sql::Context`).
fn parameters(checked: &Checked, req: &SourceQuery, utc: bool) -> Result<Vec<(String, Bv)>, SourceError> {
    let mut out = Vec::new();
    for name in &checked.params {
        if checked.identifier_params.contains(name)
            && (name.starts_with("__") || req.identifier_variables.as_ref().is_some_and(|c| !c.contains(name)))
        {
            return Err(SourceError::rejected(
                "cypher.variable_identifier",
                format!(
                    "${name} names a label, type or property here; only constant and custom variables may, since only their values are listed in the dashboard"
                ),
            )
            .with("name", name));
        }
        let value = match name.as_str() {
            "__timeFrom" => datetime_param(req.range.from, utc),
            "__timeTo" => datetime_param(req.range.to, utc),
            "__timeFromMs" => Bv::Int(req.range.from),
            "__timeToMs" => Bv::Int(req.range.to),
            "__interval_ms" => Bv::Int(req.interval_ms as i64),
            m if m.starts_with("__") => {
                return Err(
                    SourceError::rejected("cypher.macro_unknown", format!("unknown macro ${m}")).with("name", m)
                );
            }
            var => {
                let value = req.variables.get(var).ok_or_else(|| {
                    SourceError::rejected("cypher.variable_missing", format!("variable {var} has no value"))
                        .with("name", var)
                })?;
                to_param(value).ok_or_else(|| {
                    SourceError::rejected(
                        "cypher.variable_type",
                        format!("variable {var} must be a string, number, boolean or a list of them"),
                    )
                    .with("name", var)
                })?
            }
        };
        out.push((name.clone(), value));
    }
    Ok(out)
}

/// A UTC DateTime: Bolt 5's structure, or 4.4's with offset 0 (where local time is UTC).
fn datetime_param(ms: i64, utc: bool) -> Bv {
    let secs = ms.div_euclid(1000);
    let nanos = ms.rem_euclid(1000) * 1_000_000;
    Bv::Struct(if utc { 0x49 } else { 0x46 }, vec![Bv::Int(secs), Bv::Int(nanos), Bv::Int(0)])
}

fn to_param(v: &Value) -> Option<Bv> {
    Some(match v {
        Value::Null => Bv::Null,
        Value::Bool(b) => Bv::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Bv::Int(i),
            None => Bv::Float(n.as_f64()?),
        },
        Value::String(s) => Bv::String(s.clone()),
        Value::Array(items) => Bv::List(items.iter().map(to_param).collect::<Option<_>>()?),
        Value::Object(_) => return None,
    })
}

// ---- values ----

const NODE: u8 = 0x4E;
const REL: u8 = 0x52;
const UNBOUND_REL: u8 = 0x72;
const PATH: u8 = 0x50;

fn is_graph(v: &Bv) -> bool {
    match v {
        Bv::Struct(NODE | REL | PATH, _) => true,
        Bv::List(items) => items.iter().any(is_graph),
        _ => false,
    }
}

fn days_to_date(days: i64) -> Option<chrono::NaiveDate> {
    chrono::NaiveDate::from_ymd_opt(1970, 1, 1)?.checked_add_signed(chrono::TimeDelta::try_days(days)?)
}

fn local_datetime(secs: i64, nanos: i64) -> Option<chrono::NaiveDateTime> {
    chrono::DateTime::from_timestamp(secs, u32::try_from(nanos).ok()?).map(|t| t.naive_utc())
}

fn iso(t: chrono::NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
}

fn offset_text(secs: i64) -> String {
    let sign = if secs < 0 { '-' } else { '+' };
    let a = secs.unsigned_abs();
    if a.is_multiple_of(60) {
        format!("{sign}{:02}:{:02}", a / 3600, a % 3600 / 60)
    } else {
        format!("{sign}{:02}:{:02}:{:02}", a / 3600, a % 3600 / 60, a % 60)
    }
}

fn time_of_day(nanos: i64) -> String {
    let n = nanos.rem_euclid(86_400 * 1_000_000_000);
    let secs = n / 1_000_000_000;
    let frac = n % 1_000_000_000;
    let base = format!("{:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60);
    if frac == 0 { base } else { format!("{base}.{}", format!("{frac:09}").trim_end_matches('0')) }
}

fn int(f: &[Bv], i: usize) -> Option<i64> {
    f.get(i).and_then(Bv::as_int)
}

/// The value as typed JSON, keeping what JSON lacks (`$type`): temporal values, points, large
/// integers, bytes, and nodes and relationships inside values.
fn to_json(v: &Bv, utc: bool) -> Value {
    use crate::shapes::typed;
    match v {
        Bv::Null => Value::Null,
        Bv::Bool(b) => json!(b),
        Bv::Int(i) => int_value(*i),
        Bv::Float(f) => float_value(*f),
        Bv::String(s) => json!(s),
        Bv::Bytes(b) => typed("binary", base64::engine::general_purpose::STANDARD.encode(b)),
        Bv::List(items) => Value::Array(items.iter().map(|i| to_json(i, utc)).collect()),
        Bv::Map(entries) => Value::Object(entries.iter().map(|(k, v)| (k.clone(), to_json(v, utc))).collect()),
        Bv::Struct(tag, f) => temporal(*tag, f).unwrap_or_else(|| match *tag {
            NODE | REL | UNBOUND_REL | PATH => element_json(*tag, f, utc),
            other => typed("unknown", format!("structure 0x{other:02X}")),
        }),
    }
}

fn temporal(tag: u8, f: &[Bv]) -> Option<Value> {
    use crate::shapes::typed;
    Some(match tag {
        0x44 => typed("date", days_to_date(int(f, 0)?)?.format("%Y-%m-%d").to_string()),
        0x54 => typed("time", format!("{}{}", time_of_day(int(f, 0)?), offset_text(int(f, 1)?))),
        0x74 => typed("localTime", time_of_day(int(f, 0)?)),
        0x64 => typed("localDateTime", iso(local_datetime(int(f, 0)?, int(f, 1)?)?)),
        // DateTime with an offset: UTC seconds (Bolt 5, 4.4 with the utc patch) or local seconds.
        0x49 | 0x46 => {
            let offset = int(f, 2)?;
            let local = if tag == 0x49 { int(f, 0)?.checked_add(offset)? } else { int(f, 0)? };
            typed("dateTime", format!("{}{}", iso(local_datetime(local, int(f, 1)?)?), offset_text(offset)))
        }
        // DateTime with a zone name: the instant in UTC (or the local time for legacy 4.4), and
        // the zone.
        0x69 | 0x66 => {
            let zone = f.get(2).and_then(Bv::as_str)?;
            let t = iso(local_datetime(int(f, 0)?, int(f, 1)?)?);
            let value = if tag == 0x69 { format!("{t}Z") } else { t };
            json!({ "$type": "dateTime", "value": value, "zone": zone })
        }
        0x45 => {
            let (months, days, secs, nanos) = (int(f, 0)?, int(f, 1)?, int(f, 2)?, int(f, 3)?);
            let frac = if nanos == 0 {
                String::new()
            } else {
                format!(".{}", format!("{:09}", nanos.abs()).trim_end_matches('0'))
            };
            typed("duration", format!("P{months}M{days}DT{secs}{frac}S"))
        }
        0x58 | 0x59 => {
            let num = |i: usize| match f.get(i) {
                Some(Bv::Float(x)) => float_value(*x),
                _ => Value::Null,
            };
            let mut p = json!({ "$type": "point", "srid": int(f, 0)?, "x": num(1), "y": num(2) });
            if tag == 0x59 {
                p["z"] = num(3);
            }
            p
        }
        _ => return None,
    })
}

/// Milliseconds of a temporal value that names a moment or a day, for a frame's `time` field.
fn time_ms(v: &Bv) -> Option<i64> {
    let Bv::Struct(tag, f) = v else { return None };
    let ms = |secs: i64, nanos: i64| secs.checked_mul(1000)?.checked_add(nanos / 1_000_000);
    match *tag {
        0x44 => int(f, 0)?.checked_mul(86_400_000),
        0x49 | 0x69 | 0x64 | 0x66 => ms(int(f, 0)?, int(f, 1)?),
        0x46 => ms(int(f, 0)?.checked_sub(int(f, 2)?)?, int(f, 1)?),
        _ => None,
    }
}

fn props(v: Option<&Bv>, utc: bool) -> BTreeMap<String, Value> {
    match v {
        Some(Bv::Map(entries)) => entries.iter().map(|(k, v)| (k.clone(), to_json(v, utc))).collect(),
        _ => BTreeMap::new(),
    }
}

/// The element id: Bolt 5's text id, or 4.4's number as text.
fn element_id(f: &[Bv], text_at: usize, int_at: usize) -> String {
    match f.get(text_at) {
        Some(Bv::String(s)) => s.clone(),
        _ => f.get(int_at).and_then(Bv::as_int).map(|i| i.to_string()).unwrap_or_default(),
    }
}

fn to_node(f: &[Bv], utc: bool) -> Node {
    let labels = f
        .get(1)
        .and_then(Bv::as_list)
        .map(|l| l.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    Node { id: element_id(f, 3, 0), labels, properties: props(f.get(2), utc) }
}

fn to_edge(f: &[Bv], utc: bool) -> Edge {
    Edge {
        id: element_id(f, 5, 0),
        edge_type: f.get(3).and_then(Bv::as_str).unwrap_or("").to_string(),
        from: element_id(f, 6, 1),
        to: element_id(f, 7, 2),
        properties: props(f.get(4), utc),
    }
}

/// A node or relationship inside a frame value.
fn element_json(tag: u8, f: &[Bv], utc: bool) -> Value {
    match tag {
        NODE => {
            let n = to_node(f, utc);
            json!({ "$type": "node", "id": n.id, "labels": n.labels, "properties": n.properties })
        }
        REL => {
            let e = to_edge(f, utc);
            json!({ "$type": "edge", "id": e.id, "type": e.edge_type, "from": e.from, "to": e.to, "properties": e.properties })
        }
        UNBOUND_REL => json!({
            "$type": "edge",
            "id": element_id(f, 3, 0),
            "type": f.get(1).and_then(Bv::as_str).unwrap_or(""),
            "properties": props(f.get(2), utc),
        }),
        _ => {
            let parts: Vec<Value> = f.iter().map(|v| to_json(v, utc)).collect();
            json!({ "$type": "path", "parts": parts })
        }
    }
}

// ---- collecting a result ----

/// Collects records into a graph or a frame. The first record with a value decides: graph values
/// in it make a graph, otherwise a frame.
struct Collector {
    fields: Vec<String>,
    utc: bool,
    mode: Option<bool>,
    /// Records before the mode is known (all their values null).
    pending: Vec<Vec<Bv>>,
    graph: GraphBuilder,
    /// Columns that held graph values.
    graph_columns: BTreeSet<usize>,
    /// Records taken into the graph.
    graph_records: usize,
    /// Columns that held other values.
    other_columns: BTreeSet<usize>,
    rows: Vec<Vec<Bv>>,
    max_rows: usize,
    budget: super::frame::ResponseBudget,
    charge: super::frame::Charge,
    size_cut: bool,
}

impl Collector {
    fn new(fields: Vec<String>, utc: bool, limits: GraphLimits, req: &SourceQuery) -> Self {
        let budget = req.limits.budget.clone();
        Self {
            fields,
            utc,
            mode: None,
            pending: Vec::new(),
            graph: GraphBuilder::new(limits),
            graph_columns: BTreeSet::new(),
            graph_records: 0,
            other_columns: BTreeSet::new(),
            rows: Vec::new(),
            max_rows: req.limits.max_rows,
            charge: budget.charge(),
            budget,
            size_cut: false,
        }
    }

    /// Takes one record; false to stop reading.
    fn push(&mut self, record: Vec<Bv>, size: usize) -> bool {
        if self.mode.is_none() {
            if record.iter().all(|v| *v == Bv::Null) {
                self.pending.push(record);
                return self.keep_frame_row_count();
            }
            let graph = record.iter().any(is_graph);
            self.mode = Some(graph);
            for r in std::mem::take(&mut self.pending) {
                if !self.take(r, 0) {
                    return false;
                }
            }
        }
        self.take(record, size)
    }

    fn keep_frame_row_count(&self) -> bool {
        self.pending.len() <= self.max_rows
    }

    fn take(&mut self, record: Vec<Bv>, size: usize) -> bool {
        if self.mode == Some(true) {
            return self.add_graph(record);
        }
        // Frames keep up to one row more than the limit, so the frame builder notices the cut.
        if self.rows.len() > self.max_rows {
            return false;
        }
        if !self.charge.add(size) {
            self.size_cut = true;
            return false;
        }
        self.rows.push(record);
        self.rows.len() <= self.max_rows
    }

    fn add_graph(&mut self, record: Vec<Bv>) -> bool {
        // The row limit counts records here too, also those holding only nodes already seen.
        if self.graph_records >= self.max_rows {
            self.graph.cut_at_rows(self.max_rows);
            return false;
        }
        self.graph_records += 1;
        for (i, v) in record.iter().enumerate() {
            // A graph step run in the database says in this column that it cut the query's rows
            // at the row limit (analysis/pushdown.rs).
            if self.fields.get(i).is_some_and(|f| f == crate::analysis::pushdown::CUT) {
                if *v == Bv::Bool(true) {
                    self.graph.cut_at_rows(self.max_rows);
                }
                continue;
            }
            match v {
                Bv::Null => {}
                v if is_graph(v) => {
                    self.graph_columns.insert(i);
                    if !self.add_element(v) {
                        return false;
                    }
                }
                _ => {
                    self.other_columns.insert(i);
                }
            }
        }
        true
    }

    fn add_element(&mut self, v: &Bv) -> bool {
        let utc = self.utc;
        match v {
            Bv::Struct(NODE, f) => self.graph.add_node(to_node(f, utc)),
            Bv::Struct(REL, f) => self.graph.add_edge(to_edge(f, utc), &[], &[]),
            Bv::Struct(PATH, f) => self.add_path(f),
            Bv::List(items) => items.iter().all(|i| !is_graph(i) || self.add_element(i)),
            _ => true,
        }
    }

    /// A path: nodes, unbound relationships, and indices that walk them (a negative relationship
    /// index is traversed against its direction).
    fn add_path(&mut self, f: &[Bv]) -> bool {
        let utc = self.utc;
        let empty = Vec::new();
        let list = |i: usize| match f.get(i) {
            Some(Bv::List(l)) => l,
            _ => &empty,
        };
        let (nodes, rels, indices) = (list(0), list(1), list(2));
        let node_ids: Vec<(String, Node)> = nodes
            .iter()
            .filter_map(|n| match n {
                Bv::Struct(NODE, nf) => {
                    let node = to_node(nf, utc);
                    Some((node.id.clone(), node))
                }
                _ => None,
            })
            .collect();
        if node_ids.is_empty() {
            return true;
        }
        for (_, n) in &node_ids {
            if !self.graph.add_node(n.clone()) {
                return false;
            }
        }
        let mut path = GraphPath { nodes: vec![node_ids[0].0.clone()], edges: Vec::new() };
        let mut prev = node_ids[0].0.clone();
        for pair in indices.chunks(2) {
            let (Some(r), Some(n)) = (pair.first().and_then(Bv::as_int), pair.get(1).and_then(Bv::as_int)) else {
                break;
            };
            if r == 0 {
                break;
            }
            let Some(Bv::Struct(UNBOUND_REL, rf)) = rels.get(r.unsigned_abs() as usize - 1) else { break };
            let Some((next, _)) = node_ids.get(n as usize) else { break };
            let (from, to) = if r > 0 { (prev.clone(), next.clone()) } else { (next.clone(), prev.clone()) };
            let edge = Edge {
                id: element_id(rf, 3, 0),
                edge_type: rf.get(1).and_then(Bv::as_str).unwrap_or("").to_string(),
                from,
                to,
                properties: props(rf.get(2), utc),
            };
            path.edges.push(edge.id.clone());
            if !self.graph.add_edge(edge, &[], &[]) {
                return false;
            }
            path.nodes.push(next.clone());
            prev = next.clone();
        }
        self.graph.add_path(path)
    }

    fn size_limited(&mut self) {
        self.size_cut = true;
    }

    fn finish(mut self, executed: String) -> QueryResult {
        if self.mode == Some(true) {
            let omitted: Vec<&str> = self
                .other_columns
                .difference(&self.graph_columns)
                .filter_map(|i| self.fields.get(*i).map(String::as_str))
                .collect();
            if !omitted.is_empty() {
                let list = omitted.join(", ");
                self.graph.notice(
                    NoticeSeverity::Info,
                    Detail::new(
                        "graph.columns_omitted",
                        format!("{list} hold no nodes, relationships or paths and are not part of the graph; query them separately for a table"),
                    )
                    .with("columns", list),
                );
            }
            let mut graph = self.graph.finish();
            if self.size_cut && graph.truncated.is_none() {
                graph.truncated = Some(crate::shapes::Truncated { limit: 0, reason: Some("graph.size_limit".into()) });
            }
            return QueryResult::Graph { graph };
        }
        let mut rows = std::mem::take(&mut self.rows);
        if self.mode.is_none() {
            rows = std::mem::take(&mut self.pending);
        }
        let types: Vec<FieldType> =
            (0..self.fields.len()).map(|i| column_type(rows.iter().filter_map(|r| r.get(i)))).collect();
        let columns = self.fields.iter().zip(&types).map(|(name, t)| Column::new(name.clone(), Some(*t))).collect();
        // The buffered bytes go back; the frame takes what its rows need.
        drop(std::mem::replace(&mut self.charge, self.budget.charge()));
        let mut frame = FrameBuilder::new(columns, self.max_rows, self.budget.clone());
        frame.executed_query(executed);
        for row in rows {
            let values = row.iter().zip(&types).map(|(v, t)| frame_value(v, *t, self.utc)).collect();
            if !frame.push_row(values) {
                break;
            }
        }
        if self.size_cut && !frame.is_full() {
            frame.notice(
                NoticeSeverity::Warning,
                Detail::new("frame.size_limit", "the result was cut off at the response size limit"),
            );
        }
        QueryResult::Frame { frame: frame.finish() }
    }
}

/// The field type of a column's values: one type when all values that are not null share it,
/// else `json`.
fn column_type<'a>(values: impl Iterator<Item = &'a Bv>) -> FieldType {
    let mut seen: Option<FieldType> = None;
    for v in values {
        let t = match v {
            Bv::Null => continue,
            Bv::Bool(_) => FieldType::Bool,
            Bv::Int(_) => FieldType::Int64,
            Bv::Float(_) => FieldType::Number,
            Bv::String(_) => FieldType::String,
            v if time_ms(v).is_some() => FieldType::Time,
            _ => FieldType::Json,
        };
        seen = Some(match (seen, t) {
            (None, t) => t,
            (Some(a), b) if a == b => a,
            (Some(FieldType::Int64 | FieldType::Number), FieldType::Int64 | FieldType::Number) => FieldType::Number,
            _ => FieldType::Json,
        });
    }
    seen.unwrap_or(FieldType::String)
}

fn frame_value(v: &Bv, t: FieldType, utc: bool) -> Value {
    match (t, v) {
        (_, Bv::Null) => Value::Null,
        (FieldType::Int64, Bv::Int(i)) => json!(i.to_string()),
        (FieldType::Number, Bv::Int(i)) => json!(*i as f64),
        (FieldType::Number, Bv::Float(f)) => serde_json::Number::from_f64(*f).map_or(Value::Null, Value::Number),
        (FieldType::Time, v) => time_ms(v).map_or(Value::Null, |ms| json!(ms)),
        (FieldType::Bool | FieldType::String, v) => to_json(v, utc),
        (_, v) => to_json(v, utc),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::Limits;
    use crate::datasources::frame::ResponseBudget;
    use crate::shapes::TimeRange;
    use std::sync::Mutex;

    fn req(max_rows: usize) -> SourceQuery {
        SourceQuery {
            ref_id: "A".into(),
            query: json!({}),
            range: TimeRange { from: 1_800_000_000_123, to: 1_800_003_600_000 },
            interval_ms: 15_000,
            max_data_points: None,
            variables: serde_json::from_value(json!({ "land": "Österreich", "ids": [1, 2], "doc": { "a": 1 } }))
                .unwrap(),
            identifier_variables: None,
            limits: Limits { timeout: Duration::from_secs(5), max_rows, budget: ResponseBudget::new(1 << 20) },
            cursor: None,
        }
    }

    fn node5(id: i64, label: &str, name: &str) -> Bv {
        Bv::Struct(
            NODE,
            vec![
                Bv::Int(id),
                Bv::List(vec![Bv::String(label.into())]),
                Bv::Map(vec![("name".into(), Bv::String(name.into()))]),
                Bv::String(format!("4:x:{id}")),
            ],
        )
    }

    fn collector(fields: &[&str], max_rows: usize) -> Collector {
        let r = req(max_rows);
        let limits = GraphLimits::from_settings(&json!({}), max_rows, r.limits.budget.clone());
        Collector::new(fields.iter().map(|f| f.to_string()).collect(), true, limits, &r)
    }

    /// The community queries are fixed server text, not user queries; still, the ones that only
    /// read pass the user check, and the projection and drop are exactly what it refuses.
    #[test]
    fn community_queries_against_the_user_check() {
        use crate::datasources::cypher::check;
        assert!(check(memgraph_community_query()).is_ok());
        for numeric in [true, false] {
            let [project, stream, drop_graph] = neo4j_community_queries(numeric);
            assert!(check(&stream).is_ok(), "{stream}");
            assert_eq!(check(&project).unwrap_err().reason, "cypher.function_not_allowed");
            assert_eq!(check(&drop_graph).unwrap_err().reason, "cypher.procedure_not_allowed");
            assert!(project.contains(&format!("{}(n) IN $ids", community_key(numeric))));
        }
    }

    #[test]
    fn community_requests_are_parsed() {
        let q: CommunitiesQuery = serde_json::from_value(json!({"communities": {"nodeIds": ["1", "2"]}})).unwrap();
        assert_eq!(q.communities.node_ids, ["1", "2"]);
        assert!(serde_json::from_value::<CommunitiesQuery>(json!({"communities": {"nodeIds": [], "x": 1}})).is_err());
        assert!(serde_json::from_value::<CommunitiesQuery>(json!({"communities": {}, "cypher": "x"})).is_err());
    }

    #[test]
    fn parameters_bind_macros_and_variables() {
        let names = |n: &[&str]| Checked { params: n.iter().map(|s| s.to_string()).collect(), ..Default::default() };
        let p = parameters(&names(&["__timeFrom", "__interval_ms", "land", "ids"]), &req(10), true).unwrap();
        let get = |n: &str| p.iter().find(|(k, _)| k == n).unwrap().1.clone();
        assert_eq!(get("__timeFrom"), Bv::Struct(0x49, vec![Bv::Int(1_800_000_000), Bv::Int(123_000_000), Bv::Int(0)]));
        assert_eq!(get("__interval_ms"), Bv::Int(15_000));
        assert_eq!(get("land"), Bv::String("Österreich".into()));
        assert_eq!(get("ids"), Bv::List(vec![Bv::Int(1), Bv::Int(2)]));
        let missing = parameters(&names(&["fehlt"]), &req(10), true).unwrap_err();
        assert_eq!(missing.detail().reason, "cypher.variable_missing");
        let object = parameters(&names(&["doc"]), &req(10), true).unwrap_err();
        assert_eq!(object.detail().reason, "cypher.variable_type");
        let unknown = parameters(&names(&["__nope"]), &req(10), true).unwrap_err();
        assert_eq!(unknown.detail().reason, "cypher.macro_unknown");
    }

    /// Text that would change the query if it were spliced in stays one string parameter, and the
    /// query text is sent as written.
    #[test]
    fn injection_attempts_stay_parameters() {
        let mut r = req(10);
        let attacks =
            ["Ana' OR 1=1 //", "x\"}) DETACH DELETE n //", "$land", "${land}", "`) MATCH (m) DETACH DELETE m //"];
        r.variables.insert("land".into(), json!(attacks[0]));
        r.variables.insert("ids".into(), json!(attacks));
        let checked =
            crate::datasources::cypher::check("MATCH (n) WHERE n.name = $land OR n.name IN $ids RETURN n").unwrap();
        let p = parameters(&checked, &r, true).unwrap();
        let get = |n: &str| p.iter().find(|(k, _)| k == n).unwrap().1.clone();
        assert_eq!(get("land"), Bv::String(attacks[0].into()));
        assert_eq!(get("ids"), Bv::List(attacks.iter().map(|a| Bv::String((*a).into())).collect()));
        // Numbers keep their type; a whole number is an integer.
        r.variables.insert("land".into(), json!(42));
        assert_eq!(parameters(&checked, &r, true).unwrap()[1].1, Bv::Int(42));
    }

    /// A dynamic label takes only variables that may be identifiers, as `${x:identifier}` in SQL.
    #[test]
    fn dynamic_labels_take_only_listed_variables() {
        let checked = crate::datasources::cypher::check("MATCH (n:$($land)) WHERE n.id IN $ids RETURN n").unwrap();
        let mut r = req(10);
        // Explore: every variable is the caller's own.
        assert!(parameters(&checked, &r, true).is_ok());
        // A dashboard where land is a free (query or textbox) variable.
        r.identifier_variables = Some(BTreeSet::new());
        let refused = parameters(&checked, &r, true).unwrap_err();
        assert_eq!(refused.detail().reason, "cypher.variable_identifier");
        // ids is a value, so only land needs to be listed.
        r.identifier_variables = Some(["land".to_string()].into());
        assert!(parameters(&checked, &r, true).is_ok());
        // A dynamic property key follows the same rule.
        let key = crate::datasources::cypher::check("MATCH (n) WHERE n[$land] = 1 RETURN n").unwrap();
        r.identifier_variables = Some(BTreeSet::new());
        assert_eq!(parameters(&key, &r, true).unwrap_err().detail().reason, "cypher.variable_identifier");
        let macro_label = crate::datasources::cypher::check("MATCH (n:$($__interval_ms)) RETURN n").unwrap();
        assert_eq!(parameters(&macro_label, &req(10), true).unwrap_err().detail().reason, "cypher.variable_identifier");
    }

    #[test]
    fn native_types_are_kept() {
        let v = |tag: u8, f: Vec<Bv>| to_json(&Bv::Struct(tag, f), true);
        assert_eq!(v(0x44, vec![Bv::Int(19_723)]), json!({ "$type": "date", "value": "2024-01-01" }));
        // 2024-01-01T10:00:00Z, shown at +02:00.
        assert_eq!(
            v(0x49, vec![Bv::Int(1_704_103_200), Bv::Int(500_000_000), Bv::Int(7200)]),
            json!({ "$type": "dateTime", "value": "2024-01-01T12:00:00.500+02:00" })
        );
        assert_eq!(
            v(0x69, vec![Bv::Int(1_704_103_200), Bv::Int(0), Bv::String("Europe/Berlin".into())]),
            json!({ "$type": "dateTime", "value": "2024-01-01T10:00:00Z", "zone": "Europe/Berlin" })
        );
        assert_eq!(
            v(0x74, vec![Bv::Int(3_661_000_000_001)]),
            json!({ "$type": "localTime", "value": "01:01:01.000000001" })
        );
        assert_eq!(v(0x54, vec![Bv::Int(0), Bv::Int(-19_800)]), json!({ "$type": "time", "value": "00:00:00-05:30" }));
        assert_eq!(
            v(0x45, vec![Bv::Int(14), Bv::Int(3), Bv::Int(5), Bv::Int(500_000_000)]),
            json!({ "$type": "duration", "value": "P14M3DT5.5S" })
        );
        assert_eq!(
            v(0x58, vec![Bv::Int(4326), Bv::Float(13.4), Bv::Float(52.5)]),
            json!({ "$type": "point", "srid": 4326, "x": 13.4, "y": 52.5 })
        );
        assert_eq!(
            to_json(&Bv::Int(9_007_199_254_740_993), true),
            json!({ "$type": "int64", "value": "9007199254740993" })
        );
        assert_eq!(to_json(&Bv::Bytes(vec![1, 2]), true), json!({ "$type": "binary", "value": "AQI=" }));
        assert_eq!(time_ms(&Bv::Struct(0x46, vec![Bv::Int(7200), Bv::Int(0), Bv::Int(7200)])), Some(0));
        assert_eq!(agent_version("Neo4j/5.26.0"), "5.26.0");
        assert_eq!(agent_version("Neo4j/v5.11.0 compatible graph database server - Memgraph"), "5.11.0");
    }

    #[test]
    fn nodes_relationships_and_paths_become_a_graph() {
        let rel = Bv::Struct(
            REL,
            vec![
                Bv::Int(9),
                Bv::Int(1),
                Bv::Int(2),
                Bv::String("KENNT".into()),
                Bv::Map(vec![("seit".into(), Bv::Int(2020))]),
                Bv::String("5:x:9".into()),
                Bv::String("4:x:1".into()),
                Bv::String("4:x:2".into()),
            ],
        );
        let unbound = Bv::Struct(
            UNBOUND_REL,
            vec![Bv::Int(9), Bv::String("KENNT".into()), Bv::Map(vec![]), Bv::String("5:x:9".into())],
        );
        // b <-[KENNT]- a, walked from b: the relationship index is negative.
        let path = Bv::Struct(
            PATH,
            vec![
                Bv::List(vec![node5(2, "Person", "b"), node5(1, "Person", "a")]),
                Bv::List(vec![unbound]),
                Bv::List(vec![Bv::Int(-1), Bv::Int(1)]),
            ],
        );
        let mut c = collector(&["a", "r", "p", "name"], 100);
        assert!(c.push(vec![node5(1, "Person", "a"), rel, path, Bv::String("a".into())], 10));
        let QueryResult::Graph { graph } = c.finish("q".into()) else { panic!("a graph") };
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.nodes[0].id, "4:x:1");
        assert_eq!(graph.nodes[0].properties["name"], "a");
        assert_eq!(graph.edges.len(), 1);
        assert_eq!((graph.edges[0].from.as_str(), graph.edges[0].to.as_str()), ("4:x:1", "4:x:2"));
        assert_eq!(graph.edges[0].properties["seit"], 2020);
        let paths = graph.paths.unwrap();
        assert_eq!(paths[0].nodes, ["4:x:2", "4:x:1"]);
        assert_eq!(paths[0].edges, ["5:x:9"]);
        let notices = graph.notices.unwrap();
        assert_eq!(notices[0].code, "graph.columns_omitted");
        assert_eq!(notices[0].params.as_ref().unwrap()["columns"], "name");
    }

    #[test]
    fn other_values_become_a_frame_with_native_types() {
        let mut c = collector(&["n", "x", "t", "gemischt", "leer"], 2);
        assert!(c.push(vec![Bv::Null, Bv::Null, Bv::Null, Bv::Null, Bv::Null], 5), "undecided");
        assert!(c.push(
            vec![
                Bv::Int(9_007_199_254_740_993),
                Bv::Float(1.5),
                Bv::Struct(0x44, vec![Bv::Int(1)]),
                Bv::Int(1),
                Bv::Null
            ],
            5
        ));
        assert!(
            !c.push(vec![Bv::Int(2), Bv::Int(2), Bv::Null, Bv::String("x".into()), Bv::Null], 5),
            "the limit is reached"
        );
        let QueryResult::Frame { frame } = c.finish("RETURN 1".into()) else { panic!("a frame") };
        let types: Vec<FieldType> = frame.fields().iter().map(|f| f.field_type).collect();
        assert_eq!(types, [FieldType::Int64, FieldType::Number, FieldType::Time, FieldType::Json, FieldType::String]);
        assert_eq!(frame.rows(), 2);
        assert_eq!(frame.fields()[0].values, [Value::Null, json!("9007199254740993")]);
        assert_eq!(frame.fields()[2].values[1], json!(86_400_000));
        assert!(frame.meta().unwrap().rows_truncated);
    }

    #[test]
    fn graph_limits_stop_reading() {
        let r = req(100);
        let limits = GraphLimits::from_settings(&json!({ "maxNodes": 2 }), 100, r.limits.budget.clone());
        let mut c = Collector::new(vec!["n".into()], true, limits, &r);
        assert!(c.push(vec![node5(1, "A", "a")], 1));
        assert!(c.push(vec![node5(2, "A", "b")], 1));
        assert!(!c.push(vec![node5(3, "A", "c")], 1));
        let QueryResult::Graph { graph } = c.finish("q".into()) else { panic!("a graph") };
        assert_eq!(graph.truncated.unwrap().reason.as_deref(), Some("graph.node_limit"));
    }

    #[test]
    fn graph_records_count_against_the_row_limit() {
        let mut c = collector(&["n"], 2);
        assert!(c.push(vec![node5(1, "A", "a")], 1));
        assert!(c.push(vec![node5(1, "A", "a")], 1));
        assert!(!c.push(vec![node5(1, "A", "a")], 1), "the same node again still counts as a record");
        let QueryResult::Graph { graph } = c.finish("q".into()) else { panic!("a graph") };
        assert_eq!(graph.truncated.unwrap().reason.as_deref(), Some("graph.row_limit"));
    }

    #[test]
    fn pooled_memgraph_connections_are_checked_again_after_a_minute() {
        assert!(!needs_recheck(Flavor::Memgraph, Duration::from_secs(59)));
        assert!(needs_recheck(Flavor::Memgraph, Duration::from_secs(61)));
        assert!(!needs_recheck(Flavor::Neo4j, Duration::from_secs(3600)), "Neo4j enforces read transactions");
    }

    #[test]
    fn refusals_of_replicas_count_as_denied() {
        assert!(is_denied("Write queries are forbidden on the replica instance."));
        assert!(is_denied("You are not authorized to execute this query! Please contact your database administrator."));
        assert!(!is_denied("Syntax error at line 1"));
        let probes: Vec<&str> = PROBES.iter().map(|(p, _, _)| *p).collect();
        assert!(probes.contains(&"READ_FILE") && probes.contains(&"AUTH"), "{probes:?}");
    }

    /// What the fake Bolt server does next on a connection that is waiting in the pool.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Restart {
        /// Nothing: it answers as usual.
        None,
        /// It closes every connection right after its query, while the connection waits idle.
        CloseIdle,
        /// It cuts the connection at the next BEGIN without answering, as a server does that went
        /// away after Kalzit last checked the connection.
        CutAtBegin,
    }

    /// A Bolt 5.0 server answering one-row queries, on any number of connections. Returns its
    /// address, the count of connections it accepted and the switch for its next restart.
    async fn restarting_server() -> (std::net::SocketAddr, Arc<std::sync::atomic::AtomicUsize>, Arc<Mutex<Restart>>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let restart = Arc::new(Mutex::new(Restart::None));
        let (count, mode) = (accepted.clone(), restart.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else { return };
                count.fetch_add(1, Ordering::SeqCst);
                let mode = mode.clone();
                tokio::spawn(async move {
                    let mut hs = [0u8; 20];
                    if s.read_exact(&mut hs).await.is_err() {
                        return;
                    }
                    s.write_all(&[0, 0, 0, 5]).await.unwrap();
                    loop {
                        let mut message = Vec::new();
                        loop {
                            let Ok(n) = s.read_u16().await else { return };
                            if n == 0 {
                                break;
                            }
                            let mut buf = vec![0; n as usize];
                            if s.read_exact(&mut buf).await.is_err() {
                                return;
                            }
                            message.extend_from_slice(&buf);
                        }
                        let Ok(Bv::Struct(tag, _)) = bolt::decode(&message) else { return };
                        let now = *mode.lock().unwrap();
                        if tag == 0x11 && now == Restart::CutAtBegin {
                            *mode.lock().unwrap() = Restart::None;
                            return;
                        }
                        let success = |entries: Vec<(&str, Bv)>| {
                            Bv::Struct(0x70, vec![Bv::Map(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())])
                        };
                        let answers = match tag {
                            0x01 => vec![success(vec![("server", Bv::String("Neo4j/5.26.0".into()))])],
                            0x10 => vec![success(vec![("fields", Bv::List(vec![Bv::String("n".into())]))])],
                            0x3F => vec![
                                Bv::Struct(0x71, vec![Bv::List(vec![Bv::Int(1)])]),
                                success(vec![("has_more", Bv::Bool(false))]),
                            ],
                            _ => vec![success(Vec::new())],
                        };
                        for answer in answers {
                            let mut bytes = Vec::new();
                            bolt::encode(&answer, &mut bytes);
                            s.write_all(&(bytes.len() as u16).to_be_bytes()).await.unwrap();
                            s.write_all(&bytes).await.unwrap();
                            s.write_all(&[0, 0]).await.unwrap();
                        }
                        // ROLLBACK ends a query: a restarting server closes the idle connection.
                        if tag == 0x13 && now == Restart::CloseIdle {
                            return;
                        }
                    }
                });
            }
        });
        (addr, accepted, restart)
    }

    async fn graph_connection(addr: std::net::SocketAddr) -> Connection {
        let policy = Arc::new(super::super::targets::TargetPolicy::new(
            &std::env::temp_dir().join("kalzit-none"),
            "sqlite::memory:",
            &[],
            &[],
        ));
        let db = crate::db::connect("sqlite::memory:", 1).await.unwrap();
        Connection::new(
            "ds",
            json!({ "host": "127.0.0.1", "port": addr.port() }),
            BTreeMap::new(),
            policy,
            Arc::new(crate::datasources::OwnDatabase::new(db, "sqlite::memory:")),
        )
    }

    fn one_row() -> SourceQuery {
        SourceQuery { query: json!({ "cypher": "RETURN 1 AS n" }), variables: BTreeMap::new(), ..req(100) }
    }

    #[tokio::test]
    async fn an_idle_connection_the_server_closed_is_replaced_before_use() {
        let (addr, accepted, restart) = restarting_server().await;
        let conn = graph_connection(addr).await;
        let plugin = GraphDb(Flavor::Neo4j);
        *restart.lock().unwrap() = Restart::CloseIdle;
        plugin.query(&conn, one_row()).await.unwrap();
        *restart.lock().unwrap() = Restart::None;
        // The server has closed the pooled connection by now (it restarted).
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The lease drops it before sending anything, rather than finding out at BEGIN.
        let pool = pool(&conn).await.unwrap();
        let fresh = lease(Flavor::Neo4j, &conn, &pool).await.unwrap();
        assert!(!fresh.reused(), "the closed connection was handed out");
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2);
        fresh.release();
        plugin.query(&conn, one_row()).await.unwrap();
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2, "the open one is reused");
    }

    #[tokio::test]
    async fn a_pooled_connection_that_breaks_before_any_record_is_retried_once() {
        let (addr, accepted, restart) = restarting_server().await;
        let conn = graph_connection(addr).await;
        let plugin = GraphDb(Flavor::Neo4j);
        plugin.query(&conn, one_row()).await.unwrap();
        // The pooled connection looks open, but the server cuts it at the next BEGIN ("early eof").
        *restart.lock().unwrap() = Restart::CutAtBegin;
        let result = plugin.query(&conn, one_row()).await;
        assert!(result.is_ok(), "{:?}", result.err().map(|e| e.detail()));
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 2, "one fresh connection");
    }

    #[tokio::test]
    async fn a_fresh_connection_that_breaks_says_so_and_is_not_retried() {
        let (addr, accepted, restart) = restarting_server().await;
        let conn = graph_connection(addr).await;
        *restart.lock().unwrap() = Restart::CutAtBegin;
        let e = GraphDb(Flavor::Neo4j).query(&conn, one_row()).await.unwrap_err();
        let detail = e.detail();
        assert_eq!(detail.reason, "source.connection_lost", "{detail:?}");
        assert!(detail.params.contains_key("detail"));
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_refused_connection_names_the_address() {
        let addr = crate::datasources::connect::tests::closed_port().await;
        let conn = graph_connection(addr).await;
        let e = GraphDb(Flavor::Neo4j).query(&conn, one_row()).await.unwrap_err();
        let detail = e.detail();
        assert_eq!(detail.reason, "source.connect_refused", "{detail:?}");
        assert_eq!(detail.params["address"], addr.to_string());
    }

    /// A Bolt 5.0 server for community requests: it records each query with its `graph`
    /// parameter, answers one row of a graph name and a number, and takes `slow` before
    /// answering the Louvain stream.
    async fn recording_server(slow: Duration) -> (std::net::SocketAddr, Arc<Mutex<Vec<(String, Option<String>)>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else { return };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut hs = [0u8; 20];
                    if s.read_exact(&mut hs).await.is_err() {
                        return;
                    }
                    s.write_all(&[0, 0, 0, 5]).await.unwrap();
                    loop {
                        let mut message = Vec::new();
                        loop {
                            let Ok(n) = s.read_u16().await else { return };
                            if n == 0 {
                                break;
                            }
                            let mut buf = vec![0; n as usize];
                            if s.read_exact(&mut buf).await.is_err() {
                                return;
                            }
                            message.extend_from_slice(&buf);
                        }
                        let Ok(Bv::Struct(tag, fields)) = bolt::decode(&message) else { return };
                        let success = |entries: Vec<(&str, Bv)>| {
                            Bv::Struct(0x70, vec![Bv::Map(entries.into_iter().map(|(k, v)| (k.into(), v)).collect())])
                        };
                        if tag == 0x10 {
                            let query = fields.first().and_then(Bv::as_str).unwrap_or_default().to_string();
                            let graph = match fields.get(1) {
                                Some(Bv::Map(params)) => params.iter().find_map(|(k, v)| match v {
                                    Bv::String(g) if k == "graph" => Some(g.clone()),
                                    // The sweep's age, recorded in the same place.
                                    Bv::Int(a) if k == "age" => Some(format!("age={a}")),
                                    _ => None,
                                }),
                                _ => None,
                            };
                            let is_stream = query.contains("gds.louvain.stream");
                            log.lock().unwrap().push((query, graph));
                            if is_stream {
                                tokio::time::sleep(slow).await;
                            }
                        }
                        let answers = match tag {
                            0x01 => vec![success(vec![("server", Bv::String("Neo4j/5.26.0".into()))])],
                            0x10 => vec![success(vec![(
                                "fields",
                                Bv::List(vec![Bv::String("id".into()), Bv::String("community".into())]),
                            )])],
                            0x3F => vec![
                                Bv::Struct(0x71, vec![Bv::List(vec![Bv::String("4:x:1".into()), Bv::Int(3)])]),
                                success(vec![("has_more", Bv::Bool(false))]),
                            ],
                            _ => vec![success(Vec::new())],
                        };
                        for answer in answers {
                            let mut bytes = Vec::new();
                            bolt::encode(&answer, &mut bytes);
                            if s.write_all(&(bytes.len() as u16).to_be_bytes()).await.is_err()
                                || s.write_all(&bytes).await.is_err()
                                || s.write_all(&[0, 0]).await.is_err()
                            {
                                return;
                            }
                        }
                    }
                });
            }
        });
        (addr, seen)
    }

    fn community_request(ids: &[&str]) -> SourceQuery {
        SourceQuery { query: json!({ "communities": { "nodeIds": ids } }), variables: BTreeMap::new(), ..req(100) }
    }

    /// The graph a request projected is the one it drops.
    fn dropped_after_stream(seen: &[(String, Option<String>)]) -> bool {
        let Some(at) = seen.iter().position(|(q, _)| q.contains("gds.louvain.stream")) else { return false };
        let graph = &seen[at].1;
        graph.is_some() && seen[at + 1..].iter().any(|(q, g)| q.contains("gds.graph.drop") && g == graph)
    }

    #[tokio::test]
    async fn neo4j_communities_project_stream_and_drop() {
        let (addr, seen) = recording_server(Duration::ZERO).await;
        let conn = graph_connection(addr).await;
        let result = GraphDb(Flavor::Neo4j).query(&conn, community_request(&["4:x:1", "4:x:2"])).await.unwrap();
        let QueryResult::Frame { frame } = result else { panic!("a frame") };
        assert_eq!(frame.fields()[0].values, [json!("4:x:1")]);
        assert_eq!(frame.fields()[1].values, [json!(3)]);
        let seen = seen.lock().unwrap().clone();
        // The sweep comes first and drops what it lists ("4:x:1" here), then project, stream, drop.
        assert!(seen[0].0.contains("gds.graph.list"), "{seen:?}");
        // Only graphs older than the time limit (5 s here) plus ten minutes, by the database's
        // clock, so another Kalzit server's running request keeps its graph.
        assert!(seen[0].0.contains("creationTime < datetime() - duration({seconds: $age})"), "{seen:?}");
        assert_eq!(seen[0].1.as_deref(), Some("age=605"), "{seen:?}");
        assert!(seen[1].0.contains("gds.graph.drop") && seen[1].1.as_deref() == Some("4:x:1"), "{seen:?}");
        assert!(
            seen[2].0.contains("gds.graph.project") && seen[2].1.as_deref().unwrap().starts_with("kalzit-communities-")
        );
        assert!(dropped_after_stream(&seen), "{seen:?}");
    }

    #[tokio::test]
    async fn a_cancelled_community_request_still_drops_its_graph() {
        let (addr, seen) = recording_server(Duration::from_millis(400)).await;
        let conn = graph_connection(addr).await;
        let plugin = GraphDb(Flavor::Neo4j);
        // Given up while the stream runs, as a closed tab or a request timeout does.
        let cut = tokio::time::timeout(Duration::from_millis(150), plugin.query(&conn, community_request(&["4:x:1"])));
        assert!(cut.await.is_err(), "the request was still running");
        assert!(!dropped_after_stream(&seen.lock().unwrap()));
        for _ in 0..50 {
            if dropped_after_stream(&seen.lock().unwrap()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(dropped_after_stream(&seen.lock().unwrap()), "{:?}", seen.lock().unwrap());
        // The gate is free again: the next request runs.
        assert!(plugin.query(&conn, community_request(&["4:x:1"])).await.is_ok());
    }

    #[tokio::test]
    async fn community_requests_of_one_source_run_one_at_a_time() {
        let (addr, seen) = recording_server(Duration::from_millis(200)).await;
        let conn = graph_connection(addr).await;
        let plugin = GraphDb(Flavor::Neo4j);
        let (a, b) = tokio::join!(
            plugin.query(&conn, community_request(&["4:x:1"])),
            plugin.query(&conn, community_request(&["4:x:2"]))
        );
        assert!(a.is_ok() && b.is_ok());
        // Each request's queries follow each other: list, drop, project, stream, drop.
        let kinds: Vec<&str> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(q, _)| {
                if q.contains("gds.graph.list") {
                    "list"
                } else if q.contains("gds.graph.project") {
                    "project"
                } else if q.contains("gds.louvain") {
                    "stream"
                } else {
                    "drop"
                }
            })
            .collect();
        assert_eq!(kinds, ["list", "drop", "project", "stream", "drop", "list", "drop", "project", "stream", "drop"]);
    }

    #[test]
    fn settings_are_checked() {
        let kind = memgraph();
        assert!(kind.validate_settings(&json!({ "host": "graph.intern", "allowWriteCapableUser": true })).is_ok());
        assert_eq!(
            kind.validate_settings(&json!({ "host": "graph.intern", "maxNodes": 0 })).unwrap_err().field,
            "maxNodes"
        );
        assert_eq!(
            neo4j().validate_settings(&json!({ "host": "x", "allowWriteCapableUser": true })).unwrap_err().field,
            "settings"
        );
        assert!(kind.settings.iter().any(|f| f.name == "allowWriteCapableUser" && f.target));
    }
}
