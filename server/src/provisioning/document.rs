//! The files of provisioning: one resource per file, YAML or JSON, in an envelope
//! (`apiVersion`, `kind`, `uid`, `spec`), and the `org.yaml` that names the organization a folder
//! belongs to (docs/guide/provisioning.md, "Files").

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::ResourceKind;

/// The only `apiVersion` this server reads and writes.
pub const API_VERSION: &str = "kalzit/v1";
/// Longest `uid`.
pub const MAX_UID_CHARS: usize = 100;
/// The largest file read (a dashboard model takes at most 1 MiB as stored; YAML is longer).
pub const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
/// The most files one organization's folder may hold.
pub const MAX_FILES: usize = 5000;
/// Names of the file that says which organization a folder belongs to.
pub const ORG_FILES: &[&str] = &["org.yaml", "org.yml", "org.json"];

/// One file as read: its path relative to the organization's folder (`/` between folders) and
/// its bytes.
#[derive(Clone, Debug)]
pub struct SourceFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// A resource document, read and checked for its envelope; the `spec` is checked by its kind.
#[derive(Clone, Debug)]
pub struct Document {
    pub kind: ResourceKind,
    pub uid: String,
    pub spec: Value,
    pub path: String,
    /// SHA-256 of the file's bytes, hex.
    pub checksum: String,
}

/// A problem with one file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct FileProblem {
    pub path: String,
    pub message: String,
}

impl FileProblem {
    pub fn new(path: &str, message: impl Into<String>) -> Self {
        Self { path: path.to_string(), message: message.into() }
    }
}

impl std::fmt::Display for FileProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    api_version: Option<String>,
    kind: String,
    uid: String,
    spec: Value,
}

/// What an `org.yaml` says about the folder: the organization it belongs to (by id; the name is
/// for people reading the file) and the provisioning set, `default` when it names none.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrgFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<String>,
}

/// The set a request names when it names none.
pub const DEFAULT_SET: &str = "default";

/// A set's name follows the rules of a uid, at most 64 characters.
pub fn check_set(name: &str) -> Result<(), String> {
    check_uid(name).map_err(|_| {
        format!("set {name:?} must be 1 to 64 letters, digits, '.', '_' and '-', starting with a letter or digit")
    })?;
    if name.chars().count() > 64 {
        return Err(format!("set {name:?} has more than 64 characters"));
    }
    Ok(())
}

pub fn checksum(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Whether the path names a file provisioning reads: YAML or JSON.
pub fn is_resource_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".yaml", ".yml", ".json"].iter().any(|e| lower.ends_with(e))
}

pub fn is_org_file(path: &str) -> bool {
    ORG_FILES.contains(&path.to_ascii_lowercase().as_str())
}

/// Reads YAML or JSON (by the file's extension) into a JSON value. YAML anchors and aliases are
/// expanded within the parser's limits; values JSON cannot hold (binary, non-string keys) are
/// refused.
pub fn parse_value(path: &str, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_FILE_BYTES {
        return Err(format!("the file is larger than {MAX_FILE_BYTES} bytes"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "the file is not UTF-8 text".to_string())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if path.to_ascii_lowercase().ends_with(".json") {
        serde_json::from_str(text).map_err(|e| format!("not valid JSON: {e}"))
    } else {
        serde_saphyr::from_str::<Value>(text).map_err(|e| format!("not valid YAML: {}", first_line(&e.to_string())))
    }
}

/// The first line of a parser's message (YAML errors draw the place in further lines).
fn first_line(message: &str) -> String {
    message.lines().find(|l| !l.trim().is_empty()).unwrap_or(message).trim().to_string()
}

/// A uid: 1 to 100 letters, digits, `.`, `_` and `-`, starting with a letter or digit.
pub fn check_uid(uid: &str) -> Result<(), String> {
    let ok = !uid.is_empty()
        && uid.chars().count() <= MAX_UID_CHARS
        && uid.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && uid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(format!(
            "uid {uid:?} must be 1 to {MAX_UID_CHARS} letters, digits, '.', '_' and '-', starting with a letter or digit"
        ))
    }
}

fn check_api_version(version: Option<&str>) -> Result<(), String> {
    match version {
        None => Ok(()),
        Some(v) if v == API_VERSION => Ok(()),
        Some(v) => Err(format!("apiVersion {v:?} is not known here; this server reads {API_VERSION}")),
    }
}

/// Reads one resource file.
pub fn parse_document(file: &SourceFile) -> Result<Document, FileProblem> {
    let problem = |m: String| FileProblem::new(&file.path, m);
    let value = parse_value(&file.path, &file.bytes).map_err(problem)?;
    let envelope: Envelope =
        serde_json::from_value(value).map_err(|e| problem(format!("expected apiVersion, kind, uid and spec: {e}")))?;
    check_api_version(envelope.api_version.as_deref()).map_err(problem)?;
    let kind = ResourceKind::from_document_kind(&envelope.kind).ok_or_else(|| {
        problem(format!("kind {:?} is not one of DataSource, Role, Dashboard and AlertRule", envelope.kind))
    })?;
    check_uid(&envelope.uid).map_err(problem)?;
    if !envelope.spec.is_object() {
        return Err(problem("spec must be an object".into()));
    }
    Ok(Document {
        kind,
        uid: envelope.uid,
        spec: envelope.spec,
        path: file.path.clone(),
        checksum: checksum(&file.bytes),
    })
}

/// Reads an `org.yaml`.
pub fn parse_org_file(file: &SourceFile) -> Result<OrgFile, FileProblem> {
    let problem = |m: String| FileProblem::new(&file.path, m);
    let value = parse_value(&file.path, &file.bytes).map_err(problem)?;
    let org: OrgFile = serde_json::from_value(value)
        .map_err(|e| problem(format!("expected kind Organization and id or name: {e}")))?;
    check_api_version(org.api_version.as_deref()).map_err(problem)?;
    if org.kind != "Organization" {
        return Err(problem(format!("kind {:?} must be Organization", org.kind)));
    }
    if org.id.as_deref().is_none_or(|n| n.trim().is_empty()) {
        return Err(problem("an organization file names the organization by its id".into()));
    }
    if let Some(set) = &org.set {
        check_set(set).map_err(problem)?;
    }
    Ok(org)
}

/// Reads every resource file of one organization's folder (the `org.yaml` is left out), with every
/// problem found, so one run reports them all.
pub fn parse_all(files: &[SourceFile]) -> Result<Vec<Document>, Vec<FileProblem>> {
    let mut docs = Vec::new();
    let mut problems = Vec::new();
    if files.len() > MAX_FILES {
        problems.push(FileProblem::new(".", format!("an organization's folder holds at most {MAX_FILES} files")));
        return Err(problems);
    }
    let mut seen: BTreeMap<(ResourceKind, String), String> = BTreeMap::new();
    for file in files.iter().filter(|f| is_resource_file(&f.path) && !is_org_file(&f.path)) {
        match parse_document(file) {
            Ok(doc) => {
                if let Some(first) = seen.insert((doc.kind, doc.uid.clone()), doc.path.clone()) {
                    problems.push(FileProblem::new(
                        &doc.path,
                        format!("uid {} of kind {} is used in {first} already", doc.uid, doc.kind.document_kind()),
                    ));
                } else {
                    docs.push(doc);
                }
            }
            Err(p) => problems.push(p),
        }
    }
    if problems.is_empty() { Ok(docs) } else { Err(problems) }
}

/// How a data source file names a secret: an environment variable, or the value Kalzit's
/// encrypted store already holds for this source (set in the interface or through the API).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store: Option<bool>,
}

impl SecretRef {
    pub fn store() -> Self {
        Self { env: None, store: Some(true) }
    }

    /// The variable this reference reads, after checking the reference's form.
    pub fn check(&self) -> Result<Option<&str>, String> {
        match (&self.env, self.store) {
            (Some(name), None) => {
                check_env_name(name)?;
                Ok(Some(name))
            }
            (None, Some(true)) => Ok(None),
            _ => Err("a secret is { env: NAME } or { store: true }".into()),
        }
    }
}

/// An environment variable a secret may come from: letters, digits and `_`, not starting with a
/// digit, and not one of Kalzit's own (`KALZIT_*`), which hold its keys and settings.
pub fn check_env_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 200
        && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Err(format!("{name:?} is not an environment variable name (letters, digits and _)"));
    }
    if name.to_ascii_uppercase().starts_with("KALZIT_") {
        return Err(format!("{name} is one of Kalzit's own variables; secrets come from other variables"));
    }
    Ok(())
}

/// The environment variables the data source files of a folder read, for a client that sends
/// their values with a request (`kalzit provision ... --server`).
pub fn referenced_env(docs: &[Document]) -> Vec<String> {
    let mut names: Vec<String> = docs
        .iter()
        .filter(|d| d.kind == ResourceKind::Datasource)
        .filter_map(|d| d.spec.get("secrets")?.as_object())
        .flat_map(|m| m.values())
        .filter_map(|v| v.get("env")?.as_str().map(String::from))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// The file text of a resource as export writes it: YAML with the envelope first.
pub fn render(kind: ResourceKind, uid: &str, spec: &Value) -> Result<String, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Out<'a> {
        api_version: &'a str,
        kind: &'a str,
        uid: &'a str,
        spec: &'a Value,
    }
    let out = Out { api_version: API_VERSION, kind: kind.document_kind(), uid, spec };
    serde_saphyr::to_string(&out).map_err(|e| format!("writing YAML: {e}"))
}

/// The file text for `path`: JSON for a `.json` file (one that came as JSON stays JSON), YAML
/// otherwise.
pub fn render_for(path: &str, kind: ResourceKind, uid: &str, spec: &Value) -> Result<String, String> {
    if path.to_ascii_lowercase().ends_with(".json") {
        let out =
            serde_json::json!({ "apiVersion": API_VERSION, "kind": kind.document_kind(), "uid": uid, "spec": spec });
        serde_json::to_string_pretty(&out).map(|s| s + "\n").map_err(|e| format!("writing JSON: {e}"))
    } else {
        render(kind, uid, spec)
    }
}

/// An `org.yaml` as export writes it.
pub fn render_org(id: &str, name: &str, set: &str) -> Result<String, String> {
    let org = OrgFile {
        api_version: Some(API_VERSION.into()),
        kind: "Organization".into(),
        id: Some(id.into()),
        name: Some(name.into()),
        set: Some(set.into()),
    };
    serde_saphyr::to_string(&org).map_err(|e| format!("writing YAML: {e}"))
}

/// A file name from a resource's name: lowercase letters, digits and `-`, at most 60 characters;
/// `fallback` when nothing is left.
pub fn slug(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'ä' => "ae".to_string(),
            'ö' => "oe".to_string(),
            'ü' => "ue".to_string(),
            'ß' => "ss".to_string(),
            c if c.is_ascii_alphanumeric() => c.to_string(),
            _ => "-".to_string(),
        };
        out.push_str(&c);
    }
    let mut collapsed = String::new();
    for c in out.chars() {
        if c == '-' && (collapsed.is_empty() || collapsed.ends_with('-')) {
            continue;
        }
        collapsed.push(c);
    }
    let trimmed: String = collapsed.trim_end_matches('-').chars().take(60).collect();
    let trimmed = trimmed.trim_end_matches('-').to_string();
    if trimmed.is_empty() { fallback.to_string() } else { trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn file(path: &str, text: &str) -> SourceFile {
        SourceFile { path: path.into(), bytes: text.as_bytes().to_vec() }
    }

    #[test]
    fn yaml_and_json_read_alike() {
        let yaml = file(
            "roles/auditors.yaml",
            "apiVersion: kalzit/v1\nkind: Role\nuid: auditors\nspec:\n  name: Auditors\n  permissions: [audit:read]\n",
        );
        let json_file = file(
            "roles/auditors.json",
            r#"{"kind": "Role", "uid": "auditors", "spec": {"name": "Auditors", "permissions": ["audit:read"]}}"#,
        );
        let a = parse_document(&yaml).unwrap();
        let b = parse_document(&json_file).unwrap();
        assert_eq!(a.spec, b.spec);
        assert_eq!(a.kind, ResourceKind::Role);
        assert_eq!(a.spec, json!({ "name": "Auditors", "permissions": ["audit:read"] }));
        assert_ne!(a.checksum, b.checksum);
    }

    #[test]
    fn envelopes_are_checked() {
        let cases = [
            ("kind: Role\nuid: a\nspec: {}\nextra: 1\n", "expected apiVersion"),
            ("apiVersion: kalzit/v2\nkind: Role\nuid: a\nspec: {}\n", "apiVersion"),
            ("kind: Panel\nuid: a\nspec: {}\n", "kind \"Panel\""),
            ("kind: Role\nuid: -a\nspec: {}\n", "uid"),
            ("kind: Role\nuid: a b\nspec: {}\n", "uid"),
            ("kind: Role\nuid: a\nspec: [1]\n", "spec must be an object"),
            ("kind: Role\nuid: a\nspec: {\n", "not valid YAML"),
        ];
        for (text, expected) in cases {
            let e = parse_document(&file("x.yaml", text)).unwrap_err();
            assert!(e.message.contains(expected), "{text}: {}", e.message);
            assert_eq!(e.path, "x.yaml");
        }
        let e = parse_document(&SourceFile { path: "x.yaml".into(), bytes: vec![0xff, 0xfe, 0x00] }).unwrap_err();
        assert!(e.message.contains("UTF-8"));
    }

    #[test]
    fn duplicate_uids_are_reported_with_both_files() {
        let files = [
            file("a.yaml", "kind: Role\nuid: r\nspec: {name: A, permissions: []}\n"),
            file("b.yaml", "kind: Role\nuid: r\nspec: {name: B, permissions: []}\n"),
            file("c.yaml", "kind: Dashboard\nuid: r\nspec: {model: {}}\n"),
            file("README.md", "not read"),
            file("org.yaml", "kind: Organization\nname: X\n"),
        ];
        let problems = parse_all(&files).unwrap_err();
        assert_eq!(problems.len(), 1);
        assert_eq!(problems[0].path, "b.yaml");
        assert!(problems[0].message.contains("a.yaml"));
    }

    #[test]
    fn secret_references_name_one_source() {
        let r: SecretRef = serde_json::from_value(json!({ "env": "PG_PASSWORD" })).unwrap();
        assert_eq!(r.check().unwrap(), Some("PG_PASSWORD"));
        assert_eq!(SecretRef::store().check().unwrap(), None);
        for bad in [json!({ "env": "A", "store": true }), json!({ "store": false }), json!({})] {
            let r: SecretRef = serde_json::from_value(bad.clone()).unwrap();
            assert!(r.check().is_err(), "{bad}");
        }
        assert!(serde_json::from_value::<SecretRef>(json!({ "value": "x" })).is_err());
        assert!(check_env_name("KALZIT_SECRETS_KEY").is_err());
        assert!(check_env_name("kalzit_database_url").is_err());
        assert!(check_env_name("1A").is_err());
        assert!(check_env_name("PG-PASS").is_err());
        assert!(check_env_name("_PG_PASS2").is_ok());
    }

    #[test]
    fn rendered_files_read_back() {
        let spec = json!({ "name": "Main", "query": "SELECT 1\nFROM t -- note: yes", "n": 1.5, "list": ["a", "on"] });
        let text = render(ResourceKind::Datasource, "main", &spec).unwrap();
        assert!(text.starts_with("apiVersion: kalzit/v1\nkind: DataSource\nuid: main\n"), "{text}");
        let doc = parse_document(&file("d.yaml", &text)).unwrap();
        assert_eq!(doc.spec, spec);
        let org = render_org("0199", "Mouse: Werk", "default").unwrap();
        let back = parse_org_file(&file("org.yaml", &org)).unwrap();
        assert_eq!(back.name.as_deref(), Some("Mouse: Werk"));
    }

    #[test]
    fn slugs_are_file_names() {
        assert_eq!(slug("Übersicht: Server / Linux", "x"), "uebersicht-server-linux");
        assert_eq!(slug("---", "dashboard"), "dashboard");
        assert_eq!(slug("A".repeat(100).as_str(), "x").len(), 60);
    }
}
