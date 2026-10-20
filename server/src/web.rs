//! The web UI, embedded into the binary at build time from `ui/dist`.

use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};

#[derive(rust_embed::Embed)]
#[folder = "../ui/dist"]
// A server built before the UI still starts and says what is missing.
#[allow_missing = true]
struct Assets;

const IMMUTABLE: &str = "public, max-age=31536000, immutable";

pub async fn static_files(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if let Some(file) = (!path.is_empty()).then(|| Assets::get(path)).flatten() {
        // Vite puts content-hashed files under assets/; everything else may change per release.
        let cache = if path.starts_with("assets/") { IMMUTABLE } else { "no-cache" };
        return file_response(path, file, cache);
    }
    if path.starts_with("assets/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    // Client-side routes (/dashboards/...) all load the app shell.
    match Assets::get("index.html") {
        Some(index) => file_response("index.html", index, "no-cache"),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "The web UI is not part of this build. Run `npm --prefix ui run build`, then build the server again.",
        )
            .into_response(),
    }
}

fn file_response(path: &str, file: rust_embed::EmbeddedFile, cache: &'static str) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut res = file.data.into_owned().into_response();
    let h = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(mime.as_ref()) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}
