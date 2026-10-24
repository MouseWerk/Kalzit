//! Where releases come from: the GitHub Releases of MouseWerk/Kalzit. Requests go through the
//! one HTTP client factory (`crate::http`) with timeouts, and reach only the GitHub API and the
//! hosts GitHub serves release files from, over HTTPS; every redirect is checked against the same
//! list before it is followed.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use reqwest::{Method, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::UpdateError;
use super::platform::Platform;
use super::signing::{self, Channel, TrustedKeys};
use super::staging::select_package;
use crate::datasources::detail::Detail;
use crate::datasources::targets::TargetPolicy;
use crate::http::{self, HttpClient, HttpError, HttpOptions};

pub const REPOSITORY: &str = "MouseWerk/Kalzit";
/// The only hosts update requests go to: the API, and where release files are served from.
pub const RELEASE_HOSTS: &[&str] =
    &["api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
pub const API_TIMEOUT: Duration = Duration::from_secs(30);
pub const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// The largest release list read.
const MAX_RELEASES_BYTES: usize = 8 * 1024 * 1024;
/// Releases looked at per check.
const RELEASES_PER_PAGE: u32 = 30;

/// Where to ask, and which hosts are allowed. Production uses `github()`; tests point it at a
/// local fake.
#[derive(Clone, Debug)]
pub struct ReleaseSource {
    pub api_base: Url,
    pub repository: String,
    pub hosts: Vec<String>,
    pub https_only: bool,
}

impl ReleaseSource {
    pub fn github() -> Self {
        Self {
            api_base: Url::parse("https://api.github.com").expect("a valid URL"),
            repository: REPOSITORY.to_string(),
            hosts: RELEASE_HOSTS.iter().map(|h| h.to_string()).collect(),
            https_only: true,
        }
    }
}

/// A release newer than the installed version, with its verified manifest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub version: String,
    pub channel: Channel,
    pub size: u64,
    pub notes: String,
    pub notes_url: Option<String>,
    pub released_at: Option<String>,
    pub minimum_version: Option<String>,
    pub key_id: String,
    pub sha256: String,
    #[serde(default)]
    pub highlights: Vec<signing::Highlight>,
    pub package_url: String,
    /// The manifest and its signature as received (base64), verified again before a download.
    pub manifest: String,
    pub signature: String,
}

/// What a check found.
pub struct Found {
    /// The newest version of the channel, also when it is not newer than the installed one.
    pub latest: Option<String>,
    pub offer: Option<Offer>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    size: u64,
    browser_download_url: String,
}

pub struct Fetcher {
    client: HttpClient,
    source: ReleaseSource,
}

impl Fetcher {
    pub fn new(data_dir: &Path, db_url: &str, source: ReleaseSource, timeout: Duration) -> Result<Self, UpdateError> {
        // The target policy's allow-list holds the release hosts, so a name cannot reach any
        // other address either.
        let policy = TargetPolicy::new(data_dir, db_url, &[], &source.hosts);
        let client = http::client(HttpOptions { timeout, extra_root_pem: None, policy: Arc::new(policy) })
            .map_err(|e| UpdateError::SourceUnreachable(e.to_string()))?;
        Ok(Self { client, source })
    }

    /// Refuses a hop to anything but the release hosts over HTTPS.
    fn check_hop(&self, url: &Url) -> Result<(), Detail> {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let scheme_ok = url.scheme() == "https" || (!self.source.https_only && url.scheme() == "http");
        if scheme_ok && self.source.hosts.contains(&host) {
            Ok(())
        } else {
            Err(Detail::new("updates.source_refused", format!("{host} is not a release host")).with("host", host))
        }
    }

    async fn get(&self, url: Url, accept: &'static str) -> Result<reqwest::Response, UpdateError> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static(accept));
        headers.insert("x-github-api-version", HeaderValue::from_static("2022-11-28"));
        let hop = |_: &Method, u: &Url| self.check_hop(u);
        let response =
            self.client.send_checked(Method::GET, url, headers, None, Some(&hop)).await.map_err(source_error)?;
        if !response.status().is_success() {
            return Err(UpdateError::SourceUnreachable(format!("the server answered {}", response.status())));
        }
        Ok(response)
    }

    async fn get_bytes(&self, url: Url, accept: &'static str, max: usize) -> Result<Vec<u8>, UpdateError> {
        let response = self.get(url, accept).await?;
        http::read_limited(response, max).await.map_err(source_error)
    }

    /// The newest release of `channel` and, when it is newer than `current`, its offer for
    /// `platform` with the verified manifest.
    pub async fn latest(
        &self,
        channel: Channel,
        current: &semver::Version,
        keys: &TrustedKeys,
        platform: &Platform,
    ) -> Result<Found, UpdateError> {
        if keys.is_empty() {
            return Err(UpdateError::NoTrustedKey);
        }
        let mut url = self.source.api_base.clone();
        url.set_path(&format!("/repos/{}/releases", self.source.repository));
        url.set_query(Some(&format!("per_page={RELEASES_PER_PAGE}")));
        let body = self.get_bytes(url, "application/vnd.github+json", MAX_RELEASES_BYTES).await?;
        let releases: Vec<GhRelease> = serde_json::from_slice(&body)
            .map_err(|e| UpdateError::SourceUnreachable(format!("the release list is not valid: {e}")))?;
        let newest = releases
            .into_iter()
            .filter(|r| !r.draft && (channel == Channel::Preview || !r.prerelease))
            .filter_map(|r| {
                let version = semver::Version::parse(r.tag_name.trim_start_matches('v')).ok()?;
                // Stable never offers a pre-release version, even if it was not marked as one.
                (channel == Channel::Preview || version.pre.is_empty()).then_some((version, r))
            })
            .max_by(|a, b| a.0.cmp(&b.0));
        let Some((version, release)) = newest else { return Ok(Found { latest: None, offer: None }) };
        let latest = Some(version.to_string());
        if version <= *current {
            return Ok(Found { latest, offer: None });
        }
        let asset = |name: &str| release.assets.iter().find(|a| a.name == name);
        let manifest_name = format!("kalzit-{version}-manifest.json");
        let incomplete = || UpdateError::ReleaseIncomplete(version.to_string());
        let manifest_asset = asset(&manifest_name).ok_or_else(incomplete)?;
        let signature_asset = asset(&format!("{manifest_name}.sig")).ok_or_else(incomplete)?;
        let manifest_url = Url::parse(&manifest_asset.browser_download_url).map_err(|_| incomplete())?;
        let signature_url = Url::parse(&signature_asset.browser_download_url).map_err(|_| incomplete())?;
        let manifest_bytes =
            self.get_bytes(manifest_url, "application/octet-stream", signing::MAX_MANIFEST_BYTES).await?;
        let signature_bytes =
            self.get_bytes(signature_url, "application/octet-stream", signing::MAX_SIGNATURE_BYTES).await?;
        let manifest = signing::verify_manifest(keys, &manifest_bytes, &signature_bytes)?;
        if manifest.version != version.to_string() {
            return Err(UpdateError::ManifestInvalid(format!(
                "release {version} carries the manifest of {}",
                manifest.version
            )));
        }
        super::version_rules(current, &manifest)?;
        super::channel_rule(channel, &manifest)?;
        let package = select_package(&manifest, platform)?;
        let package_asset = asset(&package.file).filter(|a| a.size == package.size).ok_or_else(incomplete)?;
        Url::parse(&package_asset.browser_download_url).map_err(|_| incomplete())?;
        let offer = Offer {
            version: manifest.version.clone(),
            channel: if version.pre.is_empty() { Channel::Stable } else { Channel::Preview },
            size: package.size,
            notes: manifest.notes.clone(),
            notes_url: manifest.notes_url.clone().or(release.html_url.clone()),
            released_at: manifest.released_at.clone().or(release.published_at.clone()),
            minimum_version: manifest.minimum_version.clone(),
            key_id: package.signature.key_id.clone(),
            sha256: package.sha256.clone(),
            highlights: manifest.highlights.clone(),
            package_url: package_asset.browser_download_url.clone(),
            manifest: BASE64.encode(&manifest_bytes),
            signature: BASE64.encode(&signature_bytes),
        };
        Ok(Found { latest, offer: Some(offer) })
    }

    /// Streams `url` into `target`, at most `expected` bytes, and answers its SHA-256 and size.
    pub async fn download(
        &self,
        url: &Url,
        expected: u64,
        target: &Path,
        progress: &(dyn Fn(u64, u64) + Send + Sync),
    ) -> Result<(String, u64), UpdateError> {
        let mut response = self.get(url.clone(), "application/octet-stream").await?;
        if response.content_length().is_some_and(|len| len > expected) {
            return Err(UpdateError::SizeMismatch);
        }
        let mut file = tokio::fs::File::create(target).await.map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
        let mut hasher = Sha256::new();
        let mut done = 0u64;
        progress(0, expected);
        while let Some(chunk) = response.chunk().await.map_err(|e| source_error(e.into()))? {
            done += chunk.len() as u64;
            if done > expected {
                return Err(UpdateError::SizeMismatch);
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
            progress(done, expected);
        }
        file.flush().await.map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
        file.sync_all().await.map_err(|e| UpdateError::InstallFailed(e.to_string()))?;
        Ok((hex::encode(hasher.finalize()), done))
    }
}

fn source_error(e: HttpError) -> UpdateError {
    match e {
        HttpError::Refused(d) | HttpError::Blocked(crate::datasources::targets::Blocked(d)) => {
            UpdateError::SourceRefused(d.params.get("host").cloned().unwrap_or(d.message))
        }
        HttpError::TooLarge(max) => UpdateError::TooLarge(max as u64),
        other => UpdateError::SourceUnreachable(other.to_string()),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use axum::Router;
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    use serde_json::json;

    use super::super::signing::tests::{keys_for, signed_manifest, test_key};
    use super::*;

    pub(crate) fn local_source(addr: std::net::SocketAddr) -> ReleaseSource {
        ReleaseSource {
            api_base: Url::parse(&format!("http://{addr}")).unwrap(),
            repository: REPOSITORY.into(),
            hosts: vec!["127.0.0.1".into()],
            https_only: false,
        }
    }

    /// A release with its manifest, signature and this platform's package, as GitHub lists it.
    fn release(
        addr: std::net::SocketAddr,
        version: &str,
        prerelease: bool,
        package: &[u8],
        key: &ed25519_dalek::SigningKey,
    ) -> (serde_json::Value, Vec<(String, Vec<u8>)>) {
        let platform = Platform::current();
        let (manifest, sig) = signed_manifest(key, version, &[(platform.os, platform.arch, package)]);
        let package_name = format!("kalzit-{version}-{}-{}", platform.os, platform.arch);
        let manifest_name = format!("kalzit-{version}-manifest.json");
        let files = vec![
            (manifest_name.clone(), manifest),
            (format!("{manifest_name}.sig"), sig),
            (package_name, package.to_vec()),
        ];
        let assets: Vec<_> = files
            .iter()
            .map(|(name, bytes)| {
                json!({ "name": name, "size": bytes.len(),
                        "browser_download_url": format!("http://{addr}/download/{name}") })
            })
            .collect();
        let release = json!({
            "tag_name": format!("v{version}"), "draft": false, "prerelease": prerelease,
            "html_url": "https://github.com/MouseWerk/Kalzit/releases", "assets": assets,
        });
        (release, files)
    }

    /// A fake GitHub serving `releases` (version, prerelease, package) signed with `key`; files
    /// whose name ends with one of `drop_files` are listed but not served.
    pub(crate) async fn serve_releases(
        key: &ed25519_dalek::SigningKey,
        releases: &[(&str, bool, &[u8])],
        drop_files: &[&str],
    ) -> std::net::SocketAddr {
        // Bound first, so the download URLs name the real address.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let mut list = Vec::new();
        let mut files = Vec::new();
        for (version, prerelease, package) in releases {
            let (r, f) = release(addr, version, *prerelease, package, key);
            list.push(r);
            files.extend(f.into_iter().filter(|(name, _)| !drop_files.iter().any(|d| name.ends_with(d))));
        }
        serve_on(listener, json!(list), files);
        addr
    }

    #[expect(clippy::disallowed_methods, reason = "a fake release server, not an API route")]
    fn serve_on(listener: tokio::net::TcpListener, releases: serde_json::Value, files: Vec<(String, Vec<u8>)>) {
        let files = Arc::new(files);
        let app = Router::new()
            .route(
                "/repos/MouseWerk/Kalzit/releases",
                axum::routing::get(move || {
                    let releases = releases.clone();
                    async move { axum::Json(releases) }
                }),
            )
            .route(
                "/download/{file}",
                axum::routing::get(move |axum::extract::Path(file): axum::extract::Path<String>| {
                    let files = files.clone();
                    async move {
                        match files.iter().find(|(name, _)| *name == file) {
                            Some((_, bytes)) => bytes.clone().into_response(),
                            None => StatusCode::NOT_FOUND.into_response(),
                        }
                    }
                }),
            )
            .route(
                "/elsewhere",
                axum::routing::get(|| async {
                    (StatusCode::FOUND, [(header::LOCATION, "http://evil.example/x")]).into_response()
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    }

    fn v(text: &str) -> semver::Version {
        semver::Version::parse(text).unwrap()
    }

    #[tokio::test]
    async fn the_newest_release_of_the_channel_is_offered() {
        let key = test_key(5);
        let server = serve_releases(&key, &[("1.2.0", false, b"stable"), ("1.3.0-rc.1", true, b"preview")], &[]).await;
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(dir.path(), "sqlite::memory:", local_source(server), API_TIMEOUT).unwrap();
        let platform = Platform::current();
        let keys = keys_for(&key);
        let found = fetcher.latest(Channel::Stable, &v("1.1.0"), &keys, &platform).await.unwrap();
        let offer = found.offer.unwrap();
        assert_eq!((offer.version.as_str(), offer.size), ("1.2.0", 6));
        let found = fetcher.latest(Channel::Preview, &v("1.1.0"), &keys, &platform).await.unwrap();
        let offer = found.offer.unwrap();
        assert_eq!((offer.version.as_str(), offer.channel), ("1.3.0-rc.1", Channel::Preview));
        let found = fetcher.latest(Channel::Stable, &v("1.2.0"), &keys, &platform).await.unwrap();
        assert_eq!((found.latest.as_deref(), found.offer.is_none()), (Some("1.2.0"), true));
    }

    #[tokio::test]
    async fn a_release_signed_by_an_unknown_key_or_without_its_signature_is_refused() {
        let key = test_key(5);
        let stranger = test_key(6);
        let platform = Platform::current();
        let server = serve_releases(&stranger, &[("1.2.0", false, b"stable")], &[]).await;
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(dir.path(), "sqlite::memory:", local_source(server), API_TIMEOUT).unwrap();
        let e = fetcher.latest(Channel::Stable, &v("1.1.0"), &keys_for(&key), &platform).await.err().unwrap();
        assert!(matches!(e, UpdateError::UnknownKey(_)), "{e}");
        let e = fetcher.latest(Channel::Stable, &v("1.1.0"), &TrustedKeys::default(), &platform).await.err().unwrap();
        assert!(matches!(e, UpdateError::NoTrustedKey), "{e}");

        let server = serve_releases(&key, &[("1.2.0", false, b"stable")], &[".sig"]).await;
        let fetcher = Fetcher::new(dir.path(), "sqlite::memory:", local_source(server), API_TIMEOUT).unwrap();
        let e = fetcher.latest(Channel::Stable, &v("1.1.0"), &keys_for(&key), &platform).await.err().unwrap();
        assert!(matches!(e, UpdateError::SourceUnreachable(_)), "{e}");
    }

    #[tokio::test]
    async fn requests_reach_only_the_release_hosts() {
        let key = test_key(5);
        let server = serve_releases(&key, &[("1.2.0", false, b"stable")], &[]).await;
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(dir.path(), "sqlite::memory:", local_source(server), API_TIMEOUT).unwrap();
        // A redirect to another host is refused before it is followed.
        let url = Url::parse(&format!("http://{server}/elsewhere")).unwrap();
        let e = fetcher.get_bytes(url, "*/*", 1024).await.unwrap_err();
        assert!(matches!(&e, UpdateError::SourceRefused(host) if host == "evil.example"), "{e}");
        // The production source refuses plain HTTP and hosts that are not GitHub's, before
        // anything is sent.
        let github = Fetcher::new(dir.path(), "sqlite::memory:", ReleaseSource::github(), API_TIMEOUT).unwrap();
        let local = format!("https://{server}/x");
        for raw in ["http://api.github.com/repos", "https://example.com/kalzit", local.as_str()] {
            let e = github.get_bytes(Url::parse(raw).unwrap(), "*/*", 1024).await.unwrap_err();
            assert!(matches!(e, UpdateError::SourceRefused(_)), "{raw}: {e}");
        }
        assert_eq!(ReleaseSource::github().hosts, RELEASE_HOSTS);
    }

    #[tokio::test]
    async fn a_download_stops_at_the_signed_size() {
        let key = test_key(5);
        let server = serve_releases(&key, &[("1.2.0", false, b"0123456789")], &[]).await;
        let dir = tempfile::tempdir().unwrap();
        let fetcher = Fetcher::new(dir.path(), "sqlite::memory:", local_source(server), API_TIMEOUT).unwrap();
        let platform = Platform::current();
        let file = format!("kalzit-1.2.0-{}-{}", platform.os, platform.arch);
        let url = Url::parse(&format!("http://{server}/download/{file}")).unwrap();
        let target = dir.path().join("package");
        let (sha, size) = fetcher.download(&url, 10, &target, &|_, _| {}).await.unwrap();
        assert_eq!((sha, size), (hex::encode(Sha256::digest(b"0123456789")), 10));
        let e = fetcher.download(&url, 9, &target, &|_, _| {}).await.unwrap_err();
        assert!(matches!(e, UpdateError::SizeMismatch), "{e}");
    }
}
