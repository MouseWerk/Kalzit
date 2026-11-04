//! The web UI, embedded into the binary at build time from `ui/dist`.

use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

use crate::app::AppState;

#[derive(rust_embed::Embed)]
#[folder = "../ui/dist"]
// A server built before the UI still starts and says what is missing.
#[allow_missing = true]
struct Assets;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub async fn static_files(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(file) = (!path.is_empty()).then(|| Assets::get(path)).flatten() {
        // Vite puts content-hashed files under assets/; everything else may change per release.
        let cache = if path.starts_with("assets/") { IMMUTABLE } else { "no-cache" };
        return file_response(path, file.data.into_owned(), cache);
    }
    if path.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Client-side routes (/dashboards/...) all load the app shell.
    match Assets::get("index.html") {
        Some(index) => {
            let html = index_html(&String::from_utf8_lossy(&index.data), &state.config.server.base_path);
            file_response("index.html", html.into_bytes(), "no-cache")
        }
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "The web UI is not part of this build. Run `npm --prefix ui run build`, then build the server again.",
        )
            .into_response(),
    }
}

/// The app shell for the sub-path `base` (`server.base_path`, empty at the root). The bundle is
/// built with relative addresses (`./assets/...`, ui/vite.config.ts); here they become absolute
/// below the sub-path, so they also hold on a deep link such as `/kalzit/dashboards/x`. The app
/// reads the sub-path from a meta tag (ui/src/lib/basePath.ts).
pub fn index_html(html: &str, base: &str) -> String {
    let html = html.replace("=\"./", &format!("=\"{base}/"));
    if base.is_empty() {
        return html;
    }
    // `base` has only unreserved URL characters (`config::normalize_base_path`), nothing to escape.
    html.replacen("<head>", &format!("<head>\n    <meta name=\"kalzit-base-path\" content=\"{base}\" />"), 1)
}

fn file_response(path: &str, data: Vec<u8>, cache: &'static str) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut res = data.into_response();
    let h = res.headers_mut();
    // Text the browser would otherwise have to guess the encoding of (the third-party notices).
    let content_type = if mime.type_() == mime_guess::mime::TEXT && mime.get_param("charset").is_none() {
        format!("{mime}; charset=utf-8")
    } else {
        mime.to_string()
    };
    if let Ok(v) = HeaderValue::from_str(&content_type) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUILT: &str = "<!doctype html>\n<html>\n  <head>\n    <link rel=\"stylesheet\" href=\"./layers.css\" />\n    \
                         <script type=\"module\" crossorigin src=\"./assets/index-abc.js\"></script>\n  </head>\n</html>\n";

    #[test]
    fn the_app_shell_loads_its_files_from_the_root_or_the_sub_path() {
        let root = index_html(BUILT, "");
        assert!(root.contains("href=\"/layers.css\"") && root.contains("src=\"/assets/index-abc.js\""), "{root}");
        assert!(!root.contains("kalzit-base-path"));

        let sub = index_html(BUILT, "/tools/kalzit");
        assert!(sub.contains("href=\"/tools/kalzit/layers.css\""), "{sub}");
        assert!(sub.contains("src=\"/tools/kalzit/assets/index-abc.js\""), "{sub}");
        assert!(sub.contains("<meta name=\"kalzit-base-path\" content=\"/tools/kalzit\" />"), "{sub}");
        assert!(!sub.contains("\"./"));
    }
}
