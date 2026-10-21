//! What the data source routes tell people: a stable `reason` code the UI translates, its
//! `params`, and an English `message` for logs and API clients (and as the UI's fallback). Every
//! code is listed in docs/api/datasources.md.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct Detail {
    pub reason: &'static str,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl Detail {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self { reason, params: BTreeMap::new(), message: message.into() }
    }

    /// Adds a parameter the translated text can use (`{name}`).
    pub fn with(mut self, key: &str, value: impl ToString) -> Self {
        self.params.insert(key.to_string(), value.to_string());
        self
    }

    /// The same detail with `scrub` applied to the message and every parameter, so no secret
    /// leaves the server through either.
    pub fn scrubbed(&self, scrub: impl Fn(&str) -> String) -> Self {
        Self {
            reason: self.reason,
            params: self.params.iter().map(|(k, v)| (k.clone(), scrub(v))).collect(),
            message: scrub(&self.message),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::Path;

    /// The namespaces reason codes live in.
    const NAMESPACES: &[&str] = &[
        "request",
        "datasource",
        "settings",
        "secrets",
        "target",
        "query",
        "sql",
        "promql",
        "variables",
        "source",
        "sqlite",
        "mysql",
        "mssql",
        "prometheus",
        "http",
        "server",
        "health",
        "frame",
    ];

    /// Literals in these namespaces that are not reasons: audit actions and secret store files.
    const NOT_REASONS: &[&str] = &[
        "datasource.created",
        "datasource.deleted",
        "datasource.restored",
        "datasource.updated",
        "secrets.key",
        "secrets.lock",
        "settings.updated",
    ];

    /// Every `"namespace.name"` literal in the server's non-test code.
    fn reasons_in_code(dir: &Path, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                reasons_in_code(&path, out);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy();
            if !name.ends_with(".rs") || name.contains("test") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
            let code = text.split("#[cfg(test)]\nmod tests").next().unwrap();
            for line in code.lines().filter(|l| !l.trim_start().starts_with("//")) {
                let mut rest = line;
                while let Some(start) = rest.find('"') {
                    let after = &rest[start + 1..];
                    let Some(end) = after.find('"') else { break };
                    let literal = &after[..end];
                    if let Some((ns, name)) = literal.split_once('.')
                        && NAMESPACES.contains(&ns)
                        && !name.is_empty()
                        && name.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                    {
                        out.insert(literal.to_string());
                    }
                    rest = &after[end + 1..];
                }
            }
        }
    }

    /// The reasons the first column of every table in the docs' "Reasons" section names.
    fn reasons_in_docs(doc: &str) -> BTreeSet<String> {
        let start = doc.find("## Reasons").expect("a Reasons section");
        let end = doc[start..].find("## Not here yet").map_or(doc.len(), |e| start + e);
        let mut out = BTreeSet::new();
        for line in doc[start..end].lines().filter(|l| l.starts_with("| `")) {
            let first = line.split('|').nth(1).unwrap_or_default();
            for token in first.split('`').skip(1).step_by(2) {
                if token.contains('.') {
                    out.insert(token.to_string());
                }
            }
        }
        out
    }

    /// Keeps docs/api/datasources.md in step with the reasons the server answers with.
    #[test]
    fn every_reason_is_documented_and_every_documented_reason_exists() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut code = BTreeSet::new();
        reasons_in_code(&root.join("src"), &mut code);
        for not in NOT_REASONS {
            assert!(code.remove(*not), "{not} is listed as a non-reason but no longer appears in the code");
        }
        let doc = std::fs::read_to_string(root.join("../docs/api/datasources.md")).unwrap().replace("\r\n", "\n");
        let docs = reasons_in_docs(&doc);
        let undocumented: Vec<_> = code.difference(&docs).collect();
        let unknown: Vec<_> = docs.difference(&code).collect();
        assert!(
            undocumented.is_empty() && unknown.is_empty(),
            "in the code but not in docs/api/datasources.md: {undocumented:?}; documented but not in the code: {unknown:?}"
        );
        assert!(code.len() > 100, "the scan found only {} reasons", code.len());
    }
}
