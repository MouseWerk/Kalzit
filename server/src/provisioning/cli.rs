//! `kalzit provision plan|apply|export` and `kalzit import grafana`: they read files on this
//! machine and talk to a running server's API with a service account's token
//! (`KALZIT_API_TOKEN`), the only way files reach a server. The values of the environment
//! variables data source files name are read here and sent with the request, over HTTPS (plain
//! HTTP only to this machine). Text output follows the system language (German or English);
//! `--output json` prints the API's answer, whose field names are English.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde_json::{Value, json};

use super::document::{self, DEFAULT_SET};
use super::engine::{Action, ApplyResult, Export, Plan, RequestFile, SetRequest};
use super::files;
use super::grafana::{ImportReport, ItemStatus};

/// The longest answer read from the server (an export of a large organization).
const MAX_ANSWER_BYTES: usize = 256 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    De,
    En,
}

/// German when the system speaks German, else English: `LC_ALL`, `LC_MESSAGES`, `LANG`, and on
/// Windows the user's interface language.
pub fn system_lang() -> Lang {
    for var in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(v) = std::env::var(var)
            && !v.is_empty()
        {
            return if v.to_ascii_lowercase().starts_with("de") { Lang::De } else { Lang::En };
        }
    }
    #[cfg(windows)]
    {
        // SAFETY: a plain query without arguments.
        let id = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
        // The primary language is the low 10 bits; German is 0x07.
        if id & 0x3ff == 0x07 {
            return Lang::De;
        }
    }
    Lang::En
}

/// The texts of the command line, in both languages.
fn t(lang: Lang, key: &str) -> &'static str {
    let de = lang == Lang::De;
    match key {
        "create" => {
            if de {
                "anlegen"
            } else {
                "create"
            }
        }
        "update" => {
            if de {
                "ändern"
            } else {
                "update"
            }
        }
        "adopt" => {
            if de {
                "übernehmen"
            } else {
                "adopt"
            }
        }
        "delete" => {
            if de {
                "löschen"
            } else {
                "delete"
            }
        }
        "unchanged" => {
            if de {
                "unverändert"
            } else {
                "unchanged"
            }
        }
        "orphaned" => {
            if de {
                "verwaist"
            } else {
                "orphaned"
            }
        }
        "drifted" => {
            if de {
                "abgewichen"
            } else {
                "drifted"
            }
        }
        "summary" => {
            if de {
                "{create} anlegen, {update} ändern, {adopt} übernehmen, {delete} löschen, {unchanged} unverändert, \
                 {orphaned} verwaist, {drifted} abgewichen"
            } else {
                "{create} to create, {update} to update, {adopt} to adopt, {delete} to delete, {unchanged} unchanged, \
                 {orphaned} orphaned, {drifted} drifted"
            }
        }
        "orphans_hint" => {
            if de {
                "Verwaiste Ressourcen bleiben verwaltet und schreibgeschützt; --prune löscht sie."
            } else {
                "Orphaned resources stay managed and read-only; --prune deletes them."
            }
        }
        "applied" => {
            if de {
                "Angewendet."
            } else {
                "Applied."
            }
        }
        "nothing" => {
            if de {
                "Nichts zu tun."
            } else {
                "Nothing to do."
            }
        }
        "warning" => {
            if de {
                "Warnung"
            } else {
                "warning"
            }
        }
        "exported" => {
            if de {
                "{n} Dateien nach {dir} geschrieben."
            } else {
                "Wrote {n} files to {dir}."
            }
        }
        "skipped" => {
            if de {
                "ausgelassen"
            } else {
                "skipped"
            }
        }
        "converted" => {
            if de {
                "übernommen"
            } else {
                "converted"
            }
        }
        "approximated" => {
            if de {
                "angenähert"
            } else {
                "approximated"
            }
        }
        "import_summary" => {
            if de {
                "{converted} übernommen, {approximated} angenähert, {skipped} ausgelassen"
            } else {
                "{converted} converted, {approximated} approximated, {skipped} skipped"
            }
        }
        "imported" => {
            if de {
                "Dashboard angelegt: {id}"
            } else {
                "Dashboard created: {id}"
            }
        }
        "dry_run" => {
            if de {
                "Probelauf: nichts gespeichert."
            } else {
                "Dry run: nothing saved."
            }
        }
        _ => "",
    }
}

fn fill(template: &str, values: &[(&str, String)]) -> String {
    let mut out = template.to_string();
    for (k, v) in values {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// How to reach the server.
pub struct Connection {
    pub server: String,
    pub org: Option<String>,
    pub json: bool,
}

struct Client {
    http: crate::http::HttpClient,
    base: Url,
    token: String,
}

fn client(server: &str) -> Result<Client> {
    client_with(server, std::env::var("KALZIT_API_TOKEN").unwrap_or_default())
}

fn client_with(server: &str, token: String) -> Result<Client> {
    if token.trim().is_empty() {
        bail!("set KALZIT_API_TOKEN to a token of a service account of the organization (docs/guide/provisioning.md)");
    }
    let mut base = Url::parse(server.trim()).with_context(|| format!("--server {server} is not a URL"))?;
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    let local = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    match base.scheme() {
        "https" => {}
        "http" if local => {}
        _ => bail!(
            "--server must be https:// (plain http only to this machine), since the token and secrets travel with it"
        ),
    }
    // The target rules of data sources do not apply here; only metadata addresses stay refused.
    let policy = crate::datasources::targets::TargetPolicy::new(&std::env::temp_dir(), "", &[], &[]);
    let http = crate::http::client(crate::http::HttpOptions {
        timeout: TIMEOUT,
        extra_root_pem: None,
        policy: Arc::new(policy),
    })
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(Client { http, base, token })
}

impl Client {
    async fn call(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Value> {
        let url = self.base.join(path.trim_start_matches('/')).context("building the request URL")?;
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", self.token.trim()))
            .context("the token has invalid characters")?;
        auth.set_sensitive(true);
        headers.insert(AUTHORIZATION, auth);
        let bytes = match body {
            Some(b) => {
                headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
                Some(serde_json::to_vec(b)?)
            }
            None => None,
        };
        let response =
            self.http.send_with_body(method, url, headers, bytes).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let status = response.status();
        let raw = crate::http::read_limited(response, MAX_ANSWER_BYTES).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let value: Value = serde_json::from_slice(&raw).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = value["error"]["message"].as_str().map(String::from).unwrap_or_else(|| status.to_string());
            let code = value["error"]["code"].as_str().unwrap_or("error");
            bail!("{code}: {message}");
        }
        Ok(value)
    }
}

/// The organization and set of a folder: the flags, else the folder's `org.yaml`.
fn org_and_set(conn: &Connection, folder: &files::SetFolder, set: Option<&str>) -> Result<(String, String)> {
    let org = conn
        .org
        .clone()
        .or_else(|| folder.org.as_ref().and_then(|o| o.id.clone()))
        .context("name the organization with --org or an org.yaml with its id")?;
    if let (Some(flag), Some(file)) = (&conn.org, folder.org.as_ref().and_then(|o| o.id.as_ref()))
        && flag != file
    {
        bail!("--org {flag} differs from the organization {file} in org.yaml");
    }
    let set = set
        .map(String::from)
        .or_else(|| folder.org.as_ref().and_then(|o| o.set.clone()))
        .unwrap_or_else(|| DEFAULT_SET.to_string());
    document::check_set(&set).map_err(|e| anyhow::anyhow!(e))?;
    Ok((org, set))
}

fn request(dir: &Path, conn: &Connection, set: Option<&str>, prune: bool) -> Result<(String, SetRequest)> {
    let folder = files::read_folder(dir)?;
    let (org, set) = org_and_set(conn, &folder, set)?;
    let resource_files: Vec<document::SourceFile> =
        folder.files.into_iter().filter(|f| !document::is_org_file(&f.path)).collect();
    // The files are checked here first, so a problem is reported without a round trip; the
    // server checks them again.
    let docs = document::parse_all(&resource_files)
        .map_err(|problems| anyhow::anyhow!(problems.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n")))?;
    let mut secret_values = BTreeMap::new();
    for name in document::referenced_env(&docs) {
        if let Ok(value) = std::env::var(&name) {
            secret_values.insert(name, value);
        }
    }
    let files = resource_files
        .into_iter()
        .map(|f| {
            let content = String::from_utf8(f.bytes).map_err(|_| anyhow::anyhow!("{} is not UTF-8 text", f.path))?;
            Ok(RequestFile { path: f.path, content })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((org, SetRequest { set: Some(set), files, prune, secret_values }))
}

fn action_text(lang: Lang, action: Action) -> &'static str {
    t(lang, action.as_str())
}

/// A plan as text.
pub fn plan_text(lang: Lang, plan: &Plan) -> String {
    let mut out = String::new();
    for c in &plan.changes {
        let mut line =
            format!("{:<12} {:<11} {:<30} {}", action_text(lang, c.action), c.kind.document_kind(), c.uid, c.name);
        if c.drifted {
            line.push_str(&format!(" [{}]", t(lang, "drifted")));
        }
        if !c.fields.is_empty() {
            line.push_str(&format!(" ({})", c.fields.join(", ")));
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    let n = &plan.counts;
    out.push_str(&fill(
        t(lang, "summary"),
        &[
            ("create", n.create.to_string()),
            ("update", n.update.to_string()),
            ("adopt", n.adopt.to_string()),
            ("delete", n.delete.to_string()),
            ("unchanged", n.unchanged.to_string()),
            ("orphaned", n.orphaned.to_string()),
            ("drifted", n.drifted.to_string()),
        ],
    ));
    if n.orphaned > 0 {
        out.push('\n');
        out.push_str(t(lang, "orphans_hint"));
    }
    out
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

pub async fn plan(dir: &Path, conn: &Connection, set: Option<&str>, prune: bool) -> Result<String> {
    let lang = system_lang();
    let (org, body) = request(dir, conn, set, prune)?;
    let client = client(&conn.server)?;
    let answer = client.call(Method::POST, &format!("api/orgs/{org}/provisioning/plan"), Some(&json!(body))).await?;
    if conn.json {
        return Ok(pretty(&answer));
    }
    let plan: Plan = serde_json::from_value(answer).context("reading the server's answer")?;
    Ok(plan_text(lang, &plan))
}

pub async fn apply(dir: &Path, conn: &Connection, set: Option<&str>, prune: bool) -> Result<String> {
    let lang = system_lang();
    let (org, body) = request(dir, conn, set, prune)?;
    let client = client(&conn.server)?;
    let answer = client.call(Method::POST, &format!("api/orgs/{org}/provisioning/apply"), Some(&json!(body))).await?;
    if conn.json {
        return Ok(pretty(&answer));
    }
    let result: ApplyResult = serde_json::from_value(answer).context("reading the server's answer")?;
    let mut out = plan_text(lang, &result.plan);
    out.push('\n');
    let changed = result.plan.changes.iter().any(|c| !matches!(c.action, Action::Unchanged | Action::Orphaned));
    out.push_str(t(lang, if changed { "applied" } else { "nothing" }));
    for w in &result.warnings {
        out.push_str(&format!("\n{}: {} {}: {}", t(lang, "warning"), w.kind.document_kind(), w.uid, w.message));
    }
    Ok(out)
}

pub async fn export(dir: &Path, conn: &Connection, set: Option<&str>) -> Result<String> {
    let lang = system_lang();
    let org = conn.org.clone().context("name the organization with --org")?;
    let set = set.unwrap_or(DEFAULT_SET);
    document::check_set(set).map_err(|e| anyhow::anyhow!(e))?;
    let client = client(&conn.server)?;
    let mut url_path = format!("api/orgs/{org}/provisioning/export?set=");
    url_path.push_str(&url::form_urlencoded::byte_serialize(set.as_bytes()).collect::<String>());
    let answer = client.call(Method::GET, &url_path, None).await?;
    let export: Export = serde_json::from_value(answer.clone()).context("reading the server's answer")?;
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    for f in &export.files {
        files::write_file(dir, &f.path, &f.content)?;
    }
    if conn.json {
        let skipped = serde_json::to_value(&export.skipped).unwrap_or_default();
        let paths: Vec<&str> = export.files.iter().map(|f| f.path.as_str()).collect();
        return Ok(pretty(&json!({ "set": export.set, "files": paths, "skipped": skipped })));
    }
    let mut out =
        fill(t(lang, "exported"), &[("n", export.files.len().to_string()), ("dir", dir.display().to_string())]);
    for s in &export.skipped {
        out.push_str(&format!(
            "\n{:<12} {:<11} {} ({}): {}",
            t(lang, "skipped"),
            s.kind.document_kind(),
            s.resource_id,
            s.name,
            s.reason
        ));
    }
    Ok(out)
}

/// An import report as text.
pub fn report_text(lang: Lang, report: &ImportReport) -> String {
    let mut out = String::new();
    for item in &report.items {
        let status = match item.status {
            ItemStatus::Converted => t(lang, "converted"),
            ItemStatus::Approximated => t(lang, "approximated"),
            ItemStatus::Skipped => t(lang, "skipped"),
        };
        out.push_str(&format!("{status:<13} {}", item.name));
        for note in &item.notes {
            out.push_str(&format!("\n{:<13}   {note}", ""));
        }
        out.push('\n');
    }
    out.push_str(&fill(
        t(lang, "import_summary"),
        &[
            ("converted", report.counts.converted.to_string()),
            ("approximated", report.counts.approximated.to_string()),
            ("skipped", report.counts.skipped.to_string()),
        ],
    ));
    out
}

/// `--map GRAFANA=KALZIT`: a Grafana data source (uid, name, `${DS_X}` input or `default`) to the
/// id of a Kalzit data source.
pub fn parse_mapping(raw: &[String]) -> Result<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    for m in raw {
        let (from, to) =
            m.rsplit_once('=').with_context(|| format!("--map {m}: expected GRAFANA=KALZIT_DATA_SOURCE_ID"))?;
        if from.trim().is_empty() || to.trim().is_empty() {
            bail!("--map {m}: expected GRAFANA=KALZIT_DATA_SOURCE_ID");
        }
        out.insert(from.trim().to_string(), to.trim().to_string());
    }
    Ok(out)
}

pub async fn import_grafana(
    file: &Path,
    conn: &Connection,
    mapping: BTreeMap<String, String>,
    folder_id: Option<String>,
    dry_run: bool,
) -> Result<String> {
    let lang = system_lang();
    let org = conn.org.clone().context("name the organization with --org")?;
    let text = std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
    let dashboard: Value = serde_json::from_slice(&text).with_context(|| format!("{} is not JSON", file.display()))?;
    let client = client(&conn.server)?;
    let body = json!({ "dashboard": dashboard, "datasources": mapping, "folderId": folder_id, "dryRun": dry_run });
    let answer = client.call(Method::POST, &format!("api/orgs/{org}/dashboards/import/grafana"), Some(&body)).await?;
    if conn.json {
        return Ok(pretty(&answer));
    }
    let report: ImportReport =
        serde_json::from_value(answer["report"].clone()).context("reading the server's answer")?;
    let mut out = report_text(lang, &report);
    out.push('\n');
    match answer["dashboard"]["id"].as_str() {
        Some(id) => out.push_str(&fill(t(lang, "imported"), &[("id", id.to_string())])),
        None => out.push_str(t(lang, "dry_run")),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provisioning::ResourceKind;
    use crate::provisioning::engine::{Change, Counts};

    #[test]
    fn plans_read_in_both_languages() {
        let plan = Plan {
            org_id: "o".into(),
            set: "default".into(),
            prune: false,
            changes: vec![Change {
                kind: ResourceKind::Dashboard,
                uid: "ops".into(),
                name: "Ops".into(),
                action: Action::Update,
                resource_id: Some("x".into()),
                path: "dashboards/ops.yaml".into(),
                drifted: true,
                fields: vec!["model.panels".into()],
            }],
            counts: Counts { update: 1, drifted: 1, orphaned: 1, ..Counts::default() },
        };
        let en = plan_text(Lang::En, &plan);
        assert!(en.starts_with("update       Dashboard   ops"), "{en}");
        assert!(
            en.contains("[drifted] (model.panels)") && en.contains("1 to update") && en.contains("--prune"),
            "{en}"
        );
        let de = plan_text(Lang::De, &plan);
        assert!(de.starts_with("ändern") && de.contains("[abgewichen]") && de.contains("1 ändern"), "{de}");
    }

    #[test]
    fn mappings_and_servers_are_checked() {
        let m = parse_mapping(&["prom-uid=0199".into(), "${DS_PG}=0200".into()]).unwrap();
        assert_eq!(m["${DS_PG}"], "0200");
        assert!(parse_mapping(&["nothing".into()]).is_err());
        assert!(parse_mapping(&["=x".into()]).is_err());
        let token = || "kz_sa_test".to_string();
        assert!(client_with("https://kalzit.example.com", String::new()).is_err());
        assert!(client_with("http://kalzit.example.com", token()).is_err());
        assert!(client_with("http://127.0.0.1:3001", token()).is_ok());
        assert!(client_with("https://kalzit.example.com/sub", token()).unwrap().base.as_str().ends_with("/sub/"));
    }
}
