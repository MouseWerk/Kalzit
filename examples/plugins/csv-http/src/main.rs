//! Example data source plugin for Kalzit: reads a CSV or JSON file from the HTTP or HTTPS URL in
//! its settings and answers it as a frame (README.md).
//!
//! Settings: `url` (the target the manifest declares), `format` (`auto`, `csv`, `json`), and the
//! secret `token` (sent as a bearer token). Query: `{ "delimiter": ";", "header": false }` for
//! CSV, `{ "pointer": "/data/items" }` for JSON; all optional.

mod table;

use std::process::ExitCode;
use std::time::Duration;

use kalzit_plugin_sdk::{
    Connection, Context, DataSource, Description, Error, Field, FieldError, Finished, Health, Notice, Query, Results,
    Shape, Value,
};
use serde_json::json;

const KIND: &str = "dev.kalzit.csv-http";

/// The most a file may have, whatever the query's byte limit says.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// The time a call gets when the host names none.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

struct CsvHttp {
    client: reqwest::Client,
}

/// The URL setting, checked: http or https with a host.
fn url(settings: &Value) -> Result<reqwest::Url, FieldError> {
    let text = settings.get("url").and_then(Value::as_str).unwrap_or_default().trim();
    let url = reqwest::Url::parse(text)
        .map_err(|_| FieldError::new("url", "settings.url_invalid", "the URL is not valid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FieldError::new("url", "settings.url_invalid", "the URL must start with http:// or https://"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(FieldError::new("url", "settings.url_no_host", "the URL has no host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FieldError::new("url", "settings.url_invalid", "put credentials into the token, not the URL"));
    }
    Ok(url)
}

/// A file as fetched: its content type and text, and whether it was cut at the byte limit.
struct Fetched {
    content_type: String,
    text: String,
    cut: bool,
}

/// The file at the connection's URL, read up to `max_bytes` (0: up to `MAX_FILE_BYTES`); a
/// longer file is cut after its last whole line within the limit. Redirects are not followed,
/// so the plugin reaches only the URL the administrator configured.
async fn fetch(client: &reqwest::Client, ctx: &Context, conn: &Connection, max_bytes: u64) -> Result<Fetched, Error> {
    let url = url(&conn.settings).map_err(|f| f.error)?;
    let mut request = client.get(url.clone()).timeout(ctx.remaining().unwrap_or(DEFAULT_TIMEOUT));
    if let Some(token) = conn.secret("token") {
        request = request.bearer_auth(token);
    }
    let mut response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            Error::timeout("the server did not answer in time")
        } else {
            // Without the URL: it may carry a query string the administrator considers private.
            Error::failed("source.no_answer", format!("the server could not be reached: {}", without_url(&e)))
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::source(format!("the server answered {status}")).with("status", status.as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let limit = if max_bytes == 0 { MAX_FILE_BYTES } else { max_bytes.min(MAX_FILE_BYTES) };
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let mut body = Vec::new();
    let mut cut = false;
    while let Some(part) =
        response.chunk().await.map_err(|e| Error::source(format!("reading the file failed: {}", without_url(&e))))?
    {
        body.extend_from_slice(&part);
        if body.len() > limit {
            // Read no further; keep the whole lines within the limit.
            body.truncate(limit);
            body.truncate(body.iter().rposition(|b| *b == b'\n').map_or(0, |p| p + 1));
            cut = true;
            break;
        }
    }
    let text = String::from_utf8(body).map_err(|_| Error::source("the file is not UTF-8 text"))?;
    Ok(Fetched { content_type, text, cut })
}

fn without_url(e: &reqwest::Error) -> String {
    let mut text = e.to_string();
    if let Some(url) = e.url() {
        text = text.replace(url.as_str(), "the URL");
    }
    text
}

/// The file as a table, by the format setting and the query's options, reading at most one row
/// more than `max_rows` (0: all). Parsing runs on a blocking thread, off the async workers.
async fn parse(
    conn: &Connection,
    query: &Value,
    file: Fetched,
    max_rows: u64,
) -> Result<(table::Table, table::Format), Error> {
    let setting = conn.text("format").filter(|f| *f != "auto");
    let format = table::format(setting, &file.content_type, &file.text);
    if file.cut && format == table::Format::Json {
        return Err(
            Error::source("the JSON file is larger than the query's byte limit").with("maxBytes", file.text.len())
        );
    }
    let pointer = query.get("pointer").and_then(Value::as_str).unwrap_or_default().to_string();
    let delimiter = match query.get("delimiter").and_then(Value::as_str) {
        None | Some("") => ',',
        Some("\\t" | "\t") => '\t',
        Some(d) if d.chars().count() == 1 => d.chars().next().unwrap_or(','),
        Some(_) => return Err(Error::invalid_query("the delimiter is one character")),
    };
    let header = query.get("header").and_then(Value::as_bool).unwrap_or(true);
    let text = file.text;
    let parsed = tokio::task::spawn_blocking(move || match format {
        table::Format::Json => table::parse_json(&text, &pointer, max_rows),
        table::Format::Csv => table::parse_csv(&text, delimiter, header, max_rows),
    })
    .await
    .map_err(|e| Error::source(format!("reading the file failed: {e}")))?;
    let t = parsed.map_err(|e| Error::source(format!("the file could not be read: {e}")))?;
    Ok((t, format))
}

/// The rows health and schema read to learn the columns.
const SAMPLE_ROWS: u64 = 1000;

impl DataSource for CsvHttp {
    fn describe(&self) -> Description {
        Description::new(KIND).shape(Shape::Frame)
    }

    fn check_settings(&self, settings: &Value) -> Result<(), FieldError> {
        url(settings).map(|_| ())
    }

    async fn health(&self, ctx: &Context, conn: &Connection) -> Result<Health, Error> {
        let file = fetch(&self.client, ctx, conn, 0).await?;
        let (t, format) = parse(conn, &Value::Null, file, SAMPLE_ROWS).await?;
        let engine = match format {
            table::Format::Csv => "CSV",
            table::Format::Json => "JSON",
        };
        let mut health = Health::connected(engine, "");
        health.detail.message = format!("{engine} with {} columns", t.names.len());
        Ok(health)
    }

    async fn schema(&self, ctx: &Context, conn: &Connection) -> Result<Value, Error> {
        let file = fetch(&self.client, ctx, conn, 0).await?;
        let (t, _) = parse(conn, &Value::Null, file, SAMPLE_ROWS).await?;
        let columns: Vec<Value> = t
            .names
            .iter()
            .zip(&t.types)
            .map(|(n, ty)| json!({ "name": n, "type": format!("{ty:?}").to_lowercase() }))
            .collect();
        Ok(json!({ "kind": "tables", "tables": [{ "name": "data", "columns": columns }] }))
    }

    async fn query(&self, ctx: Context, query: Query, out: Results) -> Result<Finished, Error> {
        if !(query.query.is_object() || query.query.is_null()) {
            return Err(Error::invalid_query("the query is a JSON object"));
        }
        let limits = query.limits;
        let file = fetch(&self.client, &ctx, &query.connection, limits.max_response_bytes).await?;
        let cut = file.cut;
        let (t, _) = parse(&query.connection, &query.query, file, limits.max_rows).await?;
        let fields = t.names.iter().zip(&t.types).map(|(n, ty)| Field::new(n.clone(), *ty)).collect();
        let mut frame = out.frame(fields).await?;
        frame.executed_query(format!("GET {}", url(&query.connection.settings).map_err(|f| f.error)?.path()));
        if cut {
            frame.notice(
                Notice::warning(
                    "csv.file_cut",
                    "the file is larger than the response limit; only its first lines are read",
                )
                .with("maxBytes", limits.max_response_bytes),
            );
        }
        for row in t.rows {
            if frame.row(row).await?.is_full() {
                break;
            }
        }
        frame.finish().await
    }
}
fn main() -> ExitCode {
    // rustls needs one process-wide crypto provider; this plugin uses ring.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(concat!("kalzit-csv-http/", env!("CARGO_PKG_VERSION")))
        .build()
    {
        Ok(client) => client,
        Err(e) => {
            kalzit_plugin_sdk::log::error(&format!("the HTTP client could not be built: {e}"));
            return ExitCode::FAILURE;
        }
    };
    kalzit_plugin_sdk::run(CsvHttp { client })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_checked() {
        assert!(url(&json!({ "url": "https://example.com/data.csv" })).is_ok());
        for (bad, reason) in [
            ("", "settings.url_invalid"),
            ("ftp://example.com/x", "settings.url_invalid"),
            ("https://user:pw@example.com/x", "settings.url_invalid"),
            ("file:///etc/passwd", "settings.url_invalid"),
        ] {
            assert_eq!(url(&json!({ "url": bad })).unwrap_err().error.detail.reason, reason, "{bad}");
        }
    }
}
