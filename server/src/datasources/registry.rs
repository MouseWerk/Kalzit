//! The data source kinds a server knows. Built-in kinds are registered at start through the same
//! `register` an installed plugin uses later (docs/ARCHITECTURE.md, "Plugins"); a kind registered
//! by a plugin can be removed again, a built-in cannot, and nothing can take a name already in
//! use.

use std::sync::{Arc, RwLock};

use super::Kind;

/// Where a kind comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    /// Compiled into the server.
    BuiltIn,
    /// An installed plugin (its manifest `id` is the kind's name).
    Plugin { version: String },
}

/// Why a kind was not registered or removed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RegistryError {
    #[error("the data source kind {0} is already registered")]
    Taken(String),
    #[error("the data source kind {0} is built in")]
    BuiltIn(String),
    #[error("the data source kind {0} is not registered")]
    Unknown(String),
}

struct Entry {
    kind: Arc<Kind>,
    origin: Origin,
}

/// The registered kinds, in registration order (built-ins first, as the kind list shows them).
#[derive(Default)]
pub struct KindRegistry {
    entries: RwLock<Vec<Entry>>,
}

impl KindRegistry {
    /// The kinds compiled into the server, in the order the UI lists them.
    pub fn built_in() -> Self {
        let registry = Self::default();
        for kind in [
            super::postgres::kind(),
            super::mysql::kind(),
            super::sqlite::kind(),
            super::mssql::kind(),
            super::clickhouse::kind(),
            super::prometheus::kind(),
            super::influxdb::kind(),
            super::loki::kind(),
            super::elasticsearch::kind(),
            super::file::kind(),
            super::http_json::kind(),
            super::mongodb::kind(),
            super::neo4j::neo4j(),
            super::neo4j::memgraph(),
            super::tigergraph::kind(),
        ] {
            registry.register(kind, Origin::BuiltIn).expect("built-in kinds have distinct names");
        }
        registry
    }

    /// Adds a kind under its plugin's name (`DataSourcePlugin::kind`).
    pub fn register(&self, kind: Kind, origin: Origin) -> Result<Arc<Kind>, RegistryError> {
        let mut entries = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let name = kind.kind();
        if entries.iter().any(|e| e.kind.kind() == name) {
            return Err(RegistryError::Taken(name.to_string()));
        }
        let kind = Arc::new(kind);
        entries.push(Entry { kind: kind.clone(), origin });
        Ok(kind)
    }

    /// Removes a plugin's kind. Data sources of that kind stay stored and answer
    /// `datasource.kind_unavailable` until it is registered again; queries already running keep
    /// their `Arc<Kind>` and finish.
    pub fn unregister(&self, name: &str) -> Result<Arc<Kind>, RegistryError> {
        let mut entries = self.entries.write().unwrap_or_else(|e| e.into_inner());
        let at =
            entries.iter().position(|e| e.kind.kind() == name).ok_or_else(|| RegistryError::Unknown(name.into()))?;
        if entries[at].origin == Origin::BuiltIn {
            return Err(RegistryError::BuiltIn(name.into()));
        }
        Ok(entries.remove(at).kind)
    }

    pub fn get(&self, name: &str) -> Option<Arc<Kind>> {
        let entries = self.entries.read().unwrap_or_else(|e| e.into_inner());
        entries.iter().find(|e| e.kind.kind() == name).map(|e| e.kind.clone())
    }

    pub fn origin(&self, name: &str) -> Option<Origin> {
        let entries = self.entries.read().unwrap_or_else(|e| e.into_inner());
        entries.iter().find(|e| e.kind.kind() == name).map(|e| e.origin.clone())
    }

    /// Every kind, in registration order.
    pub fn all(&self) -> Vec<Arc<Kind>> {
        let entries = self.entries.read().unwrap_or_else(|e| e.into_inner());
        entries.iter().map(|e| e.kind.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasources::{
        Capability, DataSourcePlugin, FieldError, Health, SourceError, SourceQuery, SourceSchema,
    };
    use crate::shapes::{QueryResult, Shape};

    struct Fake(&'static str);

    #[async_trait::async_trait]
    impl DataSourcePlugin for Fake {
        fn kind(&self) -> &'static str {
            self.0
        }
        fn shapes(&self) -> &'static [Shape] {
            &[Shape::Frame]
        }
        fn check_settings(&self, _: &serde_json::Value) -> Result<(), FieldError> {
            Ok(())
        }
        async fn health(&self, _: &crate::datasources::Connection) -> Health {
            Health::connected("Fake", "1", false)
        }
        async fn schema(&self, _: &crate::datasources::Connection) -> Result<SourceSchema, SourceError> {
            Ok(SourceSchema::Metrics { metrics: vec![], labels: vec![] })
        }
        async fn query(&self, _: &crate::datasources::Connection, _: SourceQuery) -> Result<QueryResult, SourceError> {
            Err(SourceError::failed("source.error", "fake"))
        }
    }

    fn fake(name: &'static str) -> Kind {
        Kind { name: "Fake", hint_key: "datasources.kinds.fake.hint", settings: &[], plugin: Arc::new(Fake(name)) }
    }

    fn refused(result: Result<Arc<Kind>, RegistryError>) -> RegistryError {
        match result {
            Ok(kind) => panic!("{} was accepted", kind.kind()),
            Err(e) => e,
        }
    }

    fn plugin() -> Origin {
        Origin::Plugin { version: "1.0.0".into() }
    }

    /// The kind list as before the registry: same kinds, same order, same shapes and forms.
    #[test]
    fn the_built_in_kinds_are_unchanged() {
        let registry = KindRegistry::built_in();
        let names: Vec<&str> = registry.all().iter().map(|k| k.kind()).collect();
        assert_eq!(
            names,
            [
                "postgres",
                "mysql",
                "sqlite",
                "mssql",
                "clickhouse",
                "prometheus",
                "influxdb",
                "loki",
                "elasticsearch",
                "file",
                "http_json",
                "mongodb",
                "neo4j",
                "memgraph",
                "tigergraph"
            ]
        );
        for kind in registry.all() {
            assert_eq!(registry.origin(kind.kind()), Some(Origin::BuiltIn));
            assert!(!kind.plugin.shapes().is_empty(), "{}", kind.kind());
        }
        let caps = |name: &str| registry.get(name).unwrap().plugin.capabilities();
        assert_eq!(caps("mongodb"), [Capability::CheckOnSave, Capability::Watch, Capability::Distribution]);
        assert_eq!(caps("neo4j"), [Capability::Pushdown]);
        assert_eq!(caps("memgraph"), [Capability::Pushdown]);
        for name in names.iter().filter(|n| !["mongodb", "neo4j", "memgraph"].contains(n)) {
            assert!(caps(name).is_empty(), "{name}");
        }
        // checks_on_save follows the capability.
        assert!(registry.get("mongodb").unwrap().plugin.checks_on_save());
        assert!(!registry.get("postgres").unwrap().plugin.checks_on_save());
    }

    #[test]
    fn plugin_kinds_come_and_go_but_built_ins_stay() {
        let registry = KindRegistry::built_in();
        let before = registry.all().len();
        registry.register(fake("dev.example.fake"), plugin()).unwrap();
        assert_eq!(registry.all().len(), before + 1);
        assert_eq!(registry.all().last().unwrap().kind(), "dev.example.fake");
        assert_eq!(registry.origin("dev.example.fake"), Some(plugin()));

        assert_eq!(
            refused(registry.register(fake("dev.example.fake"), plugin())),
            RegistryError::Taken("dev.example.fake".into())
        );
        assert_eq!(refused(registry.register(fake("postgres"), plugin())), RegistryError::Taken("postgres".into()));
        assert_eq!(refused(registry.unregister("postgres")), RegistryError::BuiltIn("postgres".into()));

        let held = registry.get("dev.example.fake").unwrap();
        registry.unregister("dev.example.fake").unwrap();
        assert!(registry.get("dev.example.fake").is_none());
        // A query that already holds the kind keeps it.
        assert_eq!(held.kind(), "dev.example.fake");
        assert_eq!(refused(registry.unregister("dev.example.fake")), RegistryError::Unknown("dev.example.fake".into()));
        assert_eq!(registry.all().len(), before);
    }
}
