//! Panel plugins on the server (docs/ARCHITECTURE.md, "Panel plugins"): which installed panels
//! may be shown, and the frame document that carries a panel's bundle into the browser.
//!
//! A panel never runs on the server. Kalzit serves its bundle from the checked package only, as
//! one HTML document with the bundle inline: the browser loads it into
//! `<iframe sandbox="allow-scripts">`, and the response carries the same sandbox as its own
//! Content Security Policy, so even opened on its own the bundle runs in an opaque origin with
//! no network (`connect-src 'none'`), no other script (the bundle's hash is the only source),
//! no forms, no base URL and only Kalzit as the page around it. Inline, because a request from
//! the opaque origin carries no session, so a separate bundle request could not be authorized.
//!
//! Every serve reads the bundle from the package directory (which only Kalzit's account may
//! write) and compares its SHA-256 with the manifest's `[files]`; a file that differs is never
//! served.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use base64::Engine;
use kalzit_plugin_api::manifest::{Manifest, WebBundle};
use sha2::{Digest, Sha256};

use super::HostError;
use crate::locks::RwLockExt;

/// The largest bundle Kalzit accepts and serves.
pub const MAX_BUNDLE_BYTES: u64 = 8 * 1024 * 1024;

/// A panel plugin that may be shown now: approved, enabled, signed with a key still trusted and
/// for a Kalzit this new. Blocks of organizations are checked per request.
#[derive(Clone, Debug)]
pub struct ActivePanel {
    pub manifest: Arc<Manifest>,
    pub package_dir: PathBuf,
}

impl ActivePanel {
    pub fn bundle(&self) -> &WebBundle {
        self.manifest.panel.as_ref().expect("a panel manifest names its bundle")
    }
}

/// The panel plugins that may be shown, by id.
#[derive(Default)]
pub struct PanelRegistry {
    active: RwLock<HashMap<String, ActivePanel>>,
}

impl PanelRegistry {
    pub fn insert(&self, id: &str, panel: ActivePanel) {
        self.active.write_or_recover().insert(id.to_string(), panel);
    }

    pub fn remove(&self, id: &str) -> bool {
        self.active.write_or_recover().remove(id).is_some()
    }

    pub fn get(&self, id: &str) -> Option<ActivePanel> {
        self.active.read_or_recover().get(id).cloned()
    }

    /// Every active panel, by id.
    pub fn all(&self) -> Vec<(String, ActivePanel)> {
        let mut all: Vec<(String, ActivePanel)> =
            self.active.read_or_recover().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }
}

/// A plugin panel whose options its manifest does not allow.
#[derive(Debug)]
pub struct OptionsRefused {
    /// The panel's title, else its id.
    pub panel: String,
    /// The plugin (the panel's type).
    pub plugin: String,
    /// `panel.option_unknown` or `panel.option_invalid`.
    pub code: &'static str,
    /// Where and what, as `model.panels[i].options.<name>: <what fits>`.
    pub detail: String,
}

impl OptionsRefused {
    /// The refusal as the API answers it (`422 validation` on `model`, reason
    /// `dashboards.plugin_panel_options`), with `panel` as the caller names the panel and
    /// `detail` as the caller places the option.
    pub fn into_error(self, panel: &str, detail: String) -> crate::error::ApiError {
        crate::error::ApiError::validation(detail.clone())
            .with_field("model")
            .because("dashboards.plugin_panel_options")
            .param("panel", panel)
            .param("plugin", &self.plugin)
            .param("code", self.code)
            .param("detail", detail)
    }
}

/// Checks the options of the panels of plugins that a write adds or changes (a dashboard, a
/// library panel or the visualization of a saved analysis) against the options their manifest
/// declares (`panel::check_options`): only declared keys, each value of its option's type and
/// within its bounds. Panels of plugins that cannot be shown now, and unchanged panels, are left
/// as they are, like unknown types.
pub fn check_dashboard_options(
    registry: &PanelRegistry,
    model: &crate::dashboards::model::DashboardModel,
    previous: Option<&crate::dashboards::model::DashboardModel>,
) -> Result<(), OptionsRefused> {
    for (i, p) in model.panels.iter().enumerate() {
        let Some(panel) = registry.get(&p.kind) else { continue };
        let unchanged = previous
            .and_then(|m| m.panels.iter().find(|old| old.id == p.id))
            .is_some_and(|old| old.kind == p.kind && old.options == p.options);
        if unchanged {
            continue;
        }
        let refused = |code: &'static str, detail: String| OptionsRefused {
            panel: if p.title.trim().is_empty() { p.id.clone() } else { p.title.clone() },
            plugin: p.kind.clone(),
            code,
            detail,
        };
        let options = p.options.as_object().ok_or_else(|| {
            refused("panel.option_invalid", format!("model.panels[{i}].options must be an object"))
        })?;
        kalzit_plugin_api::panel::check_options(&panel.bundle().options, options)
            .map_err(|r| refused(r.code, format!("model.panels[{i}].{}", r.message)))?;
    }
    Ok(())
}

/// A panel plugin `dev.example.tile` with the options `decimals` (integer 0 to 10) and `mode`
/// (`last` or `mean`), for tests of the option checks.
#[cfg(test)]
pub(crate) fn options_panel_for_tests(dir: &Path) -> ActivePanel {
    let text = format!(
        "manifest = 1\nid = \"dev.example.tile\"\nname = \"Tile\"\nversion = \"1.0.0\"\nkind = \"panel\"\n\
         min_kalzit = \"0.1.0\"\nshapes = [\"frame\"]\n\n[panel]\npath = \"dist/panel.js\"\napi = 1\n\n\
         [[panel.options]]\nname = \"decimals\"\nlabel = {{ en = \"Decimals\" }}\ntype = \"integer\"\nmin = 0\nmax = 10\n\n\
         [[panel.options]]\nname = \"mode\"\nlabel = {{ en = \"Mode\" }}\ntype = \"select\"\nchoices = [\"last\", \"mean\"]\n\n\
         [files]\n\"dist/panel.js\" = \"{}\"\n",
        hex::encode(Sha256::digest(b"panel();"))
    );
    let manifest = kalzit_plugin_api::manifest::parse(&text).expect("a valid panel manifest");
    ActivePanel { manifest: Arc::new(manifest), package_dir: dir.to_path_buf() }
}

fn path_in(package_dir: &Path, path: &str) -> PathBuf {
    path.split('/').fold(package_dir.to_path_buf(), |p, part| p.join(part))
}

fn bundle_invalid(message: impl Into<String>) -> HostError {
    HostError::new("plugin.bundle_invalid", message)
}

/// The bundle's text as the frame carries it, from its bytes: UTF-8 without NUL characters and
/// without `</script` or `<!--` (either would let the HTML parser end the script early or read
/// past it; inside a string, write `<\/script` or `<\!--`). Line breaks become `\n`, as the HTML
/// parser makes them, so the hash in the policy matches what the browser hashes.
fn bundle_text(bytes: &[u8]) -> Result<String, HostError> {
    let text = std::str::from_utf8(bytes).map_err(|_| bundle_invalid("the panel bundle is not UTF-8"))?;
    if text.contains('\0') {
        return Err(bundle_invalid("the panel bundle contains a NUL character"));
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("</script") || lower.contains("<!--") {
        return Err(bundle_invalid(
            "the panel bundle contains </script or <!--; write <\\/script or <\\!-- inside strings",
        ));
    }
    Ok(text.replace("\r\n", "\n").replace('\r', "\n"))
}

fn read_limited(path: &Path) -> Result<Vec<u8>, HostError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(MAX_BUNDLE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err(bundle_invalid(format!("the panel bundle is larger than {MAX_BUNDLE_BYTES} bytes"))
            .with("maxBytes", MAX_BUNDLE_BYTES));
    }
    Ok(bytes)
}

/// At install, after the package was checked against its manifest: the bundle must be one
/// Kalzit can serve.
pub fn check_bundle(manifest: &Manifest, package_dir: &Path) -> Result<(), HostError> {
    let bundle = manifest.panel.as_ref().ok_or_else(|| bundle_invalid("a panel names its bundle"))?;
    bundle_text(&read_limited(&path_in(package_dir, &bundle.path))?)?;
    Ok(())
}

/// The frame document of a panel and the policy it is served with.
#[derive(Debug)]
pub struct Frame {
    pub html: String,
    pub csp: String,
}

/// The Content Security Policy of a frame whose only script has `hash` (base64 of its SHA-256).
pub fn frame_policy(hash: &str) -> String {
    [
        // The same sandbox as the iframe's attribute, so the document is sandboxed also when it
        // is opened on its own: an opaque origin, no forms, popups, top navigation or storage.
        "sandbox allow-scripts".to_string(),
        "default-src 'none'".to_string(),
        format!("script-src 'sha256-{hash}'"),
        // A bundle sets its styles at run time; style sheets cannot reach the network here.
        "style-src 'unsafe-inline'".to_string(),
        "img-src data: blob:".to_string(),
        "font-src data:".to_string(),
        "media-src data: blob:".to_string(),
        "connect-src 'none'".to_string(),
        // WebRTC is not covered by connect-src; browsers that know this directive block it.
        "webrtc 'block'".to_string(),
        "frame-src 'none'".to_string(),
        "worker-src 'none'".to_string(),
        "object-src 'none'".to_string(),
        "manifest-src 'none'".to_string(),
        "form-action 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "frame-ancestors 'self'".to_string(),
    ]
    .join("; ")
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Reads the bundle of `panel` from its package, checks it against the manifest's hash and
/// builds the frame. A bundle whose hash differs is refused (`plugin.bundle_changed`) and logged:
/// someone changed a file only Kalzit's account may write.
pub fn frame(id: &str, panel: &ActivePanel) -> Result<Frame, HostError> {
    let bundle = panel.bundle();
    let expected = panel
        .manifest
        .files
        .get(&bundle.path)
        .ok_or_else(|| bundle_invalid("the manifest does not list the panel bundle"))?;
    let bytes = read_limited(&path_in(&panel.package_dir, &bundle.path))?;
    let digest = Sha256::digest(&bytes);
    if hex::encode(digest) != *expected {
        tracing::error!(plugin = %id, "the panel bundle differs from its manifest; it is not served");
        return Err(HostError::new("plugin.bundle_changed", "the panel bundle differs from the one installed"));
    }
    let text = bundle_text(&bytes)?;
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(text.as_bytes()));
    let html = format!(
        "<!doctype html>\n<html><head><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">\
         <meta name=\"color-scheme\" content=\"light dark\"><title>{title}</title></head>\
         <body><script type=\"module\">{text}</script></body></html>\n",
        title = escape_html(&panel.manifest.name),
    );
    Ok(Frame { html, csp: frame_policy(&hash) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panel(dir: &Path, bundle: &[u8], listed: &[u8]) -> ActivePanel {
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        std::fs::write(dir.join("dist").join("panel.js"), bundle).unwrap();
        let text = format!(
            "manifest = 1\nid = \"dev.example.tile\"\nname = \"Tile <b>\"\nversion = \"1.0.0\"\nkind = \"panel\"\n\
             min_kalzit = \"0.1.0\"\nshapes = [\"frame\"]\n\n[panel]\npath = \"dist/panel.js\"\napi = 1\n\n\
             [files]\n\"dist/panel.js\" = \"{}\"\n",
            hex::encode(Sha256::digest(listed))
        );
        let manifest = kalzit_plugin_api::manifest::parse(&text).unwrap();
        ActivePanel { manifest: Arc::new(manifest), package_dir: dir.to_path_buf() }
    }

    #[test]
    fn the_frame_carries_the_bundle_with_its_hash_as_the_only_script() {
        let dir = tempfile::tempdir().unwrap();
        let js = b"window.parent.postMessage({ kalzit: \"panel\", api: 1, type: \"ready\" }, \"*\");\r\n";
        let f = frame("dev.example.tile", &panel(dir.path(), js, js)).unwrap();
        let normalized = "window.parent.postMessage({ kalzit: \"panel\", api: 1, type: \"ready\" }, \"*\");\n";
        assert!(f.html.contains(&format!("<script type=\"module\">{normalized}</script>")), "{}", f.html);
        assert!(f.html.contains("<title>Tile &lt;b&gt;</title>"));
        let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(normalized.as_bytes()));
        assert!(f.csp.contains(&format!("script-src 'sha256-{hash}'")), "{}", f.csp);
        for part in [
            "sandbox allow-scripts;",
            "default-src 'none'",
            "connect-src 'none'",
            "webrtc 'block'",
            "frame-ancestors 'self'",
        ] {
            assert!(f.csp.contains(part), "{part} is missing from {}", f.csp);
        }
        assert!(!f.csp.contains("allow-same-origin"));
    }

    #[test]
    fn plugin_panel_options_are_checked_against_the_manifest_on_save() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PanelRegistry::default();
        registry.insert("dev.example.tile", options_panel_for_tests(dir.path()));
        let model = |options: serde_json::Value| {
            crate::dashboards::model::parse(serde_json::json!({
                "schemaVersion": crate::dashboards::model::SCHEMA_VERSION,
                "panels": [
                    { "id": "p1", "type": "table", "title": "", "options": {} },
                    { "id": "p2", "type": "dev.example.tile", "title": "Kachel", "options": options },
                ]
            }))
            .unwrap()
        };
        let fine = model(serde_json::json!({ "decimals": 10, "mode": "mean" }));
        assert!(check_dashboard_options(&registry, &fine, None).is_ok());
        for (options, code, at) in [
            (serde_json::json!({ "decimals": 11 }), "panel.option_invalid", "model.panels[1].options.decimals"),
            (serde_json::json!({ "mode": "max" }), "panel.option_invalid", "model.panels[1].options.mode"),
            (serde_json::json!({ "colour": "red" }), "panel.option_unknown", "model.panels[1].options.colour"),
        ] {
            let bad = model(options);
            let r = check_dashboard_options(&registry, &bad, None).unwrap_err();
            assert_eq!((r.code, r.panel.as_str(), r.plugin.as_str()), (code, "Kachel", "dev.example.tile"));
            assert!(r.detail.starts_with(at), "{}", r.detail);
            let e = r.into_error("Kachel", "detail".into());
            assert_eq!(e.reason.as_ref().unwrap().code, "dashboards.plugin_panel_options");
            assert_eq!(e.field, Some("model"));
            // Left as it was stored, the panel passes; a plugin that cannot be shown is not checked.
            assert!(check_dashboard_options(&registry, &bad, Some(&bad)).is_ok());
            assert!(check_dashboard_options(&PanelRegistry::default(), &bad, None).is_ok());
        }
    }

    #[test]
    fn a_changed_bundle_is_never_served() {
        let dir = tempfile::tempdir().unwrap();
        let p = panel(dir.path(), b"changed();", b"installed();");
        assert_eq!(frame("dev.example.tile", &p).unwrap_err().reason, "plugin.bundle_changed");
    }

    #[test]
    fn bundles_that_would_break_out_of_the_script_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        for bad in [&b"a = '</SCRIPT><img>';"[..], b"/* <!-- */", b"\xff\xfe", b"a\0b"] {
            let p = panel(dir.path(), bad, bad);
            assert_eq!(check_bundle(&p.manifest, dir.path()).unwrap_err().reason, "plugin.bundle_invalid");
            assert_eq!(frame("dev.example.tile", &p).unwrap_err().reason, "plugin.bundle_invalid");
        }
        let fine = b"a = '<\\/script>';";
        let p = panel(dir.path(), fine, fine);
        assert!(check_bundle(&p.manifest, dir.path()).is_ok());
    }
}
