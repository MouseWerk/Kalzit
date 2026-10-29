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

    /// The detail as a notice on a result.
    pub fn notice(self, severity: crate::shapes::NoticeSeverity) -> crate::shapes::Notice {
        let params = (!self.params.is_empty()).then_some(self.params);
        crate::shapes::Notice { severity, code: self.reason.to_string(), params, text: self.message }
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
        "dashboards",
        "analysis",
        "source",
        "sqlite",
        "mysql",
        "mssql",
        "prometheus",
        "elasticsearch",
        "file",
        "csv",
        "http_json",
        "http",
        "server",
        "health",
        "frame",
        "steps",
        "expression",
        "export",
        "graph",
        "cypher",
        "gsql",
        "bolt",
        "memgraph",
        "tigergraph",
        "mongodb",
        "documents",
        "distribution",
        "updates",
        "live",
        "plugin",
        // Documented in docs/api/ai.md.
        "ai",
    ];

    /// Literals in these namespaces that are not reasons: audit actions and secret store files.
    const NOT_REASONS: &[&str] = &[
        // AI settings keys and audit actions.
        "ai.allow_org_providers",
        "ai.called",
        "ai.chat_retention_days",
        "ai.enabled",
        "ai.max_concurrent",
        "ai.max_concurrent_per_org",
        "ai.max_concurrent_per_user",
        "ai.max_rows_to_model",
        "ai.max_tool_calls",
        "ai.provider_",
        "ai.provider_chat",
        "ai.provider_explain",
        "ai.provider_summarize",
        "ai.notice_acknowledged",
        "ai.notice_text",
        "ai.org_enabled",
        "ai.org_tokens_per_month",
        "ai.provider_created",
        "ai.provider_deleted",
        "ai.provider_tested",
        "ai.provider_updated",
        "ai.request_timeout_secs",
        "ai.tool_called",
        "ai.user_requests_per_day",
        "ai.user_tokens_per_day",
        "datasource.ai_access_changed",
        // Audit actions of saved analyses.
        "analysis.created",
        "analysis.deleted",
        "analysis.owner_changed",
        "analysis.purged",
        "analysis.restored",
        "analysis.updated",
        // Settings keys, written like reasons.
        "dashboards.default_time_range",
        "dashboards.new_in_team_space",
        "dashboards.version_retention",
        "datasource.created",
        "datasource.deleted",
        "datasource.purged",
        "datasource.restored",
        "datasource.updated",
        "secrets.key",
        "secrets.lock",
        "server.http_addr",
        "server.https_addr",
        "server.public_url",
        "server.redirect_http_to_https",
        "settings.updated",
        "updates.channel",
        "updates.check_daily",
        "updates.health_timeout_secs",
        "updates.keep_versions",
        "updates.window",
    ];

    /// Calls whose arguments name a reason. A `"x.y"` literal in their arguments must be in one of
    /// `NAMESPACES`, so a reason in a new namespace cannot slip past the comparison with the docs.
    const REASON_CALLS: &[&str] = &[
        "because(",
        "with_reason(",
        "Detail::new(",
        "FieldError::new(",
        "Rejected::new(",
        "Blocked::new(",
        "SourceError::rejected(",
        "SourceError::failed(",
        "reject(",
    ];

    /// Whether `literal` has the form of a reason: `word.word` in lower case.
    fn reason_like(literal: &str) -> Option<(&str, &str)> {
        let (ns, name) = literal.split_once('.')?;
        let word = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase() || c == '_');
        (word(ns) && word(name)).then_some((ns, name))
    }

    /// The string literals in the arguments of the call whose `(` ends `code[..start]`.
    fn call_literals(code: &str, start: usize) -> Vec<&str> {
        let bytes = code.as_bytes();
        let (mut depth, mut i, mut out) = (1, start, Vec::new());
        while i < bytes.len() && depth > 0 {
            match bytes[i] {
                b'(' => depth += 1,
                b')' => depth -= 1,
                b'"' => {
                    let begin = i + 1;
                    i += 1;
                    while i < bytes.len() && bytes[i] != b'"' {
                        i += if bytes[i] == b'\\' { 2 } else { 1 };
                    }
                    out.push(&code[begin..i.min(code.len())]);
                }
                _ => {}
            }
            i += 1;
        }
        out
    }

    /// Reason-like literals at reason call sites whose namespace is unknown.
    fn unknown_namespaces(path: &Path, code: &str, out: &mut Vec<String>) {
        for call in REASON_CALLS {
            for (at, _) in code.match_indices(call) {
                for literal in call_literals(code, at + call.len()) {
                    if let Some((ns, _)) = reason_like(literal)
                        && !NAMESPACES.contains(&ns)
                    {
                        out.push(format!("{}: {literal} in {call}...)", path.display()));
                    }
                }
            }
        }
    }

    /// Every `"namespace.name"` literal in the server's non-test code, and reason call sites with
    /// a literal of an unknown namespace.
    fn reasons_in_code(dir: &Path, out: &mut BTreeSet<String>, unknown: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                reasons_in_code(&path, out, unknown);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy();
            if !name.ends_with(".rs") || name.contains("test") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
            let code = text.split("#[cfg(test)]\nmod tests").next().unwrap();
            let code: String =
                code.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            unknown_namespaces(&path, &code, unknown);
            for line in code.lines() {
                let mut rest = line;
                while let Some(start) = rest.find('"') {
                    let after = &rest[start + 1..];
                    let Some(end) = after.find('"') else { break };
                    let literal = &after[..end];
                    if let Some((ns, _)) = reason_like(literal)
                        && NAMESPACES.contains(&ns)
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

    #[test]
    fn reason_calls_with_an_unknown_namespace_are_found() {
        let code = r#"Err(ApiError::validation("x").because("quota.exceeded"))
            .because("request.limit") Detail::new("health.connected", format!("a {}", f("b")))
            FieldError::new("port", "port.bad", "the port")"#;
        let mut unknown = Vec::new();
        unknown_namespaces(Path::new("x.rs"), code, &mut unknown);
        assert_eq!(unknown.len(), 2, "{unknown:?}");
        assert!(unknown[0].contains("quota.exceeded") && unknown[1].contains("port.bad"), "{unknown:?}");
    }

    /// Keeps docs/api/datasources.md in step with the reasons the server answers with.
    #[test]
    fn every_reason_is_documented_and_every_documented_reason_exists() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut code = BTreeSet::new();
        let mut unknown = Vec::new();
        reasons_in_code(&root.join("src"), &mut code, &mut unknown);
        assert!(unknown.is_empty(), "reasons in a namespace the docs check does not know: {unknown:?}");
        for not in NOT_REASONS {
            assert!(code.remove(*not), "{not} is listed as a non-reason but no longer appears in the code");
        }
        let mut docs = BTreeSet::new();
        // The AI and plugin routes document their own reasons; they share the target and request
        // reasons.
        for file in ["datasources.md", "ai.md", "plugins.md"] {
            let doc = std::fs::read_to_string(root.join("../docs/api").join(file)).unwrap().replace("\r\n", "\n");
            docs.extend(reasons_in_docs(&doc));
        }
        let undocumented: Vec<_> = code.difference(&docs).collect();
        let unknown: Vec<_> = docs.difference(&code).collect();
        assert!(
            undocumented.is_empty() && unknown.is_empty(),
            "in the code but not in docs/api/datasources.md, ai.md or plugins.md: {undocumented:?}; documented but not in the code: {unknown:?}"
        );
        assert!(code.len() > 100, "the scan found only {} reasons", code.len());
    }
}
