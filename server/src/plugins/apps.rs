//! App plugins on the server (docs/api/plugins.md, "App plugins"): which installed apps may be
//! shown, the frame documents of their pages, their storage per organization and the rules an
//! organization sets for them.
//!
//! An app's pages run in the browser like panels, each in `<iframe sandbox="allow-scripts">` with
//! the bundle inline and a policy without any network (`panels::bundle_frame`). A page never calls
//! Kalzit itself: it asks Kalzit's own page around it through the app message API, which does
//! only what the manifest's capabilities name and an administrator approved, always with the
//! signed-in person's rights and read-only: read dashboards and saved analyses, run saved
//! analyses, and keep data in the app's own storage (`app_storage`, at most `STORAGE_BYTES` per
//! app and organization). Never secrets, sessions or writes to Kalzit's data.
//!
//! An organization may block an app (the plugin block every plugin has) or let only members of a
//! role and above use it (`app_org_settings`, default `viewer`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use kalzit_plugin_api::manifest::{App, Manifest};

use super::HostError;
use crate::locks::RwLockExt;

/// What one app may keep per organization, keys and values together.
pub const STORAGE_BYTES: i64 = 50 * 1024 * 1024;
/// The largest single value.
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;
/// The roles an organization may require for an app, from the least.
pub const ROLES: &[&str] = &["viewer", "editor", "admin", "owner"];

/// An app that may be shown now: approved, enabled, signed with a key still trusted and for a
/// Kalzit this new. Blocks and roles of organizations are checked per request.
#[derive(Clone, Debug)]
pub struct ActiveApp {
    pub manifest: Arc<Manifest>,
    pub package_dir: PathBuf,
}

impl ActiveApp {
    pub fn app(&self) -> &App {
        self.manifest.app.as_ref().expect("an app manifest names its pages")
    }

    pub fn can(&self, capability: &str) -> bool {
        self.app().capabilities.iter().any(|c| c == capability)
    }
}

/// The apps that may be shown, by id.
#[derive(Default)]
pub struct AppRegistry {
    active: RwLock<HashMap<String, ActiveApp>>,
}

impl AppRegistry {
    pub fn insert(&self, id: &str, app: ActiveApp) {
        self.active.write_or_recover().insert(id.to_string(), app);
    }

    pub fn remove(&self, id: &str) -> bool {
        self.active.write_or_recover().remove(id).is_some()
    }

    pub fn get(&self, id: &str) -> Option<ActiveApp> {
        self.active.read_or_recover().get(id).cloned()
    }

    /// Every active app, by id.
    pub fn all(&self) -> Vec<(String, ActiveApp)> {
        let mut all: Vec<(String, ActiveApp)> =
            self.active.read_or_recover().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }
}

/// At install, after the package was checked against its manifest: every page bundle must be one
/// Kalzit can serve.
pub fn check_bundles(manifest: &Manifest, package_dir: &Path) -> Result<(), HostError> {
    let app = manifest.app.as_ref().ok_or_else(|| HostError::new("plugin.bundle_invalid", "an app names its pages"))?;
    for page in &app.pages {
        super::panels::check_bundle_at(package_dir, &page.path)?;
    }
    Ok(())
}

/// The frame of the page `page` of `app`.
pub fn frame(id: &str, app: &ActiveApp, page: &str) -> Result<Option<super::panels::Frame>, HostError> {
    let Some(page) = app.app().pages.iter().find(|p| p.id == page) else { return Ok(None) };
    super::panels::bundle_frame(id, &app.manifest, &app.package_dir, &page.path).map(Some)
}

/// The rank of a role an organization may require; custom roles count as `viewer`.
pub fn rank(role: &str) -> usize {
    ROLES.iter().position(|r| *r == role).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_rank_from_viewer_to_owner() {
        assert!(rank("owner") > rank("admin") && rank("admin") > rank("editor") && rank("editor") > rank("viewer"));
        assert_eq!(rank("analyst"), rank("viewer"));
    }
}
