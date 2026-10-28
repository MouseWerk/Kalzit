# Writing a Kalzit plugin

This guide takes a data source plugin from an empty crate to a signed package an administrator
installs, with the Rust SDK (`plugin-sdk/`, crate `kalzit-plugin-sdk`) and the packaging tool
`kalzit-plugin` (`plugin-tool/`). The contract behind it: docs/ARCHITECTURE.md, "Plugins", and
docs/api/plugins.md. A complete example is `examples/plugins/csv-http`; a panel plugin example
is `examples/plugins/panel-kpi` (see "Panel plugins" at the end).

## How a data source plugin runs

A data source plugin is a program next to Kalzit, one process per installed plugin, serving all
data sources of its kind. Kalzit starts it when a query of its kind first needs it, in a sandbox
(docs/api/plugins.md, "Sandbox"), and talks to it over gRPC on a local pipe (Windows) or Unix
socket (Linux). The SDK does that part: you implement the `DataSource` trait and call
`kalzit_plugin_sdk::run`.

The rules every plugin keeps:

- **Native shapes.** A query answers as a frame, documents or a graph, the shape the data has.
  Never convert one shape into another on your own; conversions are the user's visible steps.
- **Read-only.** A query that would write is refused with `Error::rejected("query.write_refused", ...)`.
- **Secrets stay secret.** `Connection::secrets` are never logged and never part of an error.
- **Only declared targets.** Connect only to the hosts and URLs the manifest declares
  (`[[permissions.network]]`); the administrator approves exactly those.

## A crate

```toml
[package]
name = "my-plugin"
version = "0.1.0"
edition = "2024"

[dependencies]
kalzit-plugin-sdk = { git = "https://github.com/MouseWerk/Kalzit" }
serde_json = "1"
```

```rust
use kalzit_plugin_sdk::{
    Connection, Context, DataSource, Description, Error, Field, FieldType, Finished, Health, Query, Results, Shape,
};
use serde_json::json;

struct Counter;

impl DataSource for Counter {
    fn describe(&self) -> Description {
        Description::new("dev.example.counter").shape(Shape::Frame)
    }

    async fn health(&self, _ctx: &Context, _conn: &Connection) -> Result<Health, Error> {
        Ok(Health::connected("Counter", "1"))
    }

    async fn query(&self, _ctx: Context, query: Query, out: Results) -> Result<Finished, Error> {
        let n = query.query["n"].as_u64().ok_or_else(|| Error::invalid_query("n is a number"))?;
        let mut frame = out.frame(vec![Field::new("n", FieldType::Number)]).await?;
        for i in 0..n {
            if frame.row(vec![json!(i)]).await?.is_full() {
                break;
            }
        }
        frame.finish().await
    }
}

fn main() -> std::process::ExitCode {
    kalzit_plugin_sdk::run(Counter)
}
```

Call `run` first in `main`: it removes the start's token from the environment before any thread
exists and builds the async runtime. (`kalzit_plugin_sdk::serve` runs inside a runtime of your
own and leaves the environment as it is.)

## The trait

| Method | Required | What |
|---|---|---|
| `describe` | yes | The kind (the manifest's `id`), shapes and capabilities. Must agree with the manifest, or Kalzit refuses the plugin at start. |
| `check_settings` | no | Checks settings as the form sent them, without network. Kalzit checks the manifest's field rules before. Answer a `FieldError` for the field at fault. |
| `health` | yes | "Test connection": `Health::connected(engine, version)`, or an `Error`. |
| `schema` | no | Completion data in a schema form of docs/api/datasources.md (`{"kind": "tables", ...}`, `fields`, `collections`, `graph`). |
| `query` | yes | One query, streamed in its shape. |
| `check_on_save` | no | Capability `CheckOnSave`: checks on the source when it is saved (for example that the login may only read). |
| `watch` | no | Capability `Watch`: a change feed for live updates; the default says "poll". |
| `release` | no | Kalzit forgot a data source: close its pools. Pools are kept per `datasource_id` and `revision`. |

Kalzit calls `check_on_save` and `watch` only when `describe` lists their capability, and the
manifest must list them too (`capabilities = ["check_on_save", "watch"]`).

`Connection` carries the data source: `settings` (the kind's own fields as JSON, without the
common limit fields), `secrets` by name, `datasource_id` and `revision`. `Query` adds the
query in the kind's own JSON form, the time range, the interval, dashboard variables (use them
as bind parameters, never as text in a query), the limits and a cursor for document pages.

## Results

`Results` starts the result in its shape; the writer keeps the order Kalzit expects (start,
batches, end), cuts batches at about 1 MiB and never sends a message above the 16 MiB limit:

- `out.frame(fields)` then `row(values)`: one JSON value per field. Times and dates are numbers of
  Unix milliseconds, `Int64` and `Decimal` values are decimal strings (no digit is lost),
  `Json` takes anything, `null` fits every type. Kalzit refuses values that do not fit.
- `out.documents()` then `document(object)`: JSON objects in the source's key order;
  `next_cursor` for the next page.
- `out.graph()` then `node`, `edge` and `path`: the schema (labels, edge types, property keys)
  is gathered for you.

Each write answers `Flow::Full` once the query's row limit or byte budget is passed: stop reading
from the source and `finish`. The writer lets one row more through than the limit, so Kalzit
cuts the result and tells the user, exactly as for built-in sources. Kalzit enforces the limits
on its side whatever a plugin sends.

`executed_query` shows the query as the source ran it; `notice` adds an info or warning to the
result.

## Errors

Return `Err(Error)` from any method. The kinds map to Kalzit's error codes: `rejected`
(`query_rejected`), `blocked` (`datasource_target_blocked`), `timeout` (`query_timeout`),
`failed` (`datasource_error`). Use reasons of docs/api/datasources.md where they fit, they are
translated in the UI: `source.error`, `source.no_answer`, `query.invalid_form`,
`query.write_refused`, `query.timeout`, `settings.url_invalid`, `settings.host_invalid`, ... Any
other reason reaches the user as `plugin.error` with your reason in its parameters and your
English message.

`Error::unsupported` is a broken call, not a result: Kalzit reports `plugin.unsupported_call`.

## Deadlines and cancellation

`Context::deadline` and `Context::remaining` say when Kalzit gives up on the call; hand them to
your driver. When the deadline passes, the SDK ends the call with a timeout. When Kalzit cancels
a call (the viewer left, the dashboard reloaded), the SDK drops your method's future: the work
stops at its next `.await`, and a driver that cancels on drop stops the database query too.

## Settings and the manifest

The manifest `kalzit-plugin.toml` names the plugin, its settings form and its network targets
(docs/ARCHITECTURE.md, "Manifest"). Write it without `[files]`; the packaging tool adds that.

```toml
manifest = 1
id = "dev.example.counter"          # your reverse domain name; also the kind
name = "Counter"
version = "0.1.0"
kind = "datasource"
min_kalzit = "0.4.0"
shapes = ["frame"]
protocol = 1

[[settings]]
name = "url"
label = { en = "URL", de = "URL" }
type = "string"
required = true
target = true                      # a target field: where secrets go

[[settings]]
name = "token"
label = { en = "Token", de = "Token" }
type = "string"
secret = true

[[permissions.network]]
setting = "url"
form = "url"

[binaries]
windows-x64 = "bin/windows-x64/counter.exe"
linux-x64 = "bin/linux-x64/counter"
```

Ids under `io.kalzit.` and `dev.kalzit.` are Kalzit's own and need Kalzit's key. Labels and help
texts come in English (`en`) and optionally German (`de`).

## Network

Connect only to the targets of the manifest. Kalzit checks the configured targets against the
data source target rules before every call. Kalzit's network connector (a plugin asks Kalzit
for a connection, and the sandbox cuts every other way out) is not in this version; until it is,
plugins connect on their own, and `kalzit_plugin_sdk::net::connect` is the function that will
go through the connector once it lands. Follow no redirects to other hosts, and use no proxies
from the environment.

## Logging

`kalzit_plugin_sdk::log` (and the macros `info!`, `warn!`, `error!`, `debug!`) write one line
to stderr. Kalzit keeps the last 2000 lines per plugin for the administrator and drops more than
200 lines per second. Never print to stdout: it carries the handshake. `debug` writes only when
`KALZIT_PLUGIN_DEBUG` is set, which Kalzit does not pass.

## Testing

- Unit tests: call your methods directly, or drive the gRPC service as `plugin-sdk/tests/serve.rs`
  does: `kalzit_plugin_sdk::serve` on a pipe or socket with your own process id as the host,
  and the generated client with the token.
- Against Kalzit: install the package on a test server (below). For quick rounds an administrator
  may allow unsigned packages there (`PATCH /api/admin/plugin-host` with `allowUnsigned`); an
  unsigned plugin is marked as such, and a broken signature is refused in any case.

## Package and sign

```sh
# Once: a signing key. Keep the file secret, keep an offline copy.
kalzit-plugin keygen --out counter-signing.key
#   public key: <base64>   (give this to administrators)
#   key id: <16 hex digits>

cargo build --release
kalzit-plugin package \
  --manifest kalzit-plugin.toml \
  --file bin/linux-x64/counter=target/release/counter \
  --file bin/windows-x64/counter.exe=path/to/windows/counter.exe \
  --file LICENSE=LICENSE \
  --key-file counter-signing.key \
  --out dev.example.counter-0.1.0.zip

kalzit-plugin verify --package dev.example.counter-0.1.0.zip --public-key <base64>
```

Run the tool from the Kalzit repository with `cargo run -p kalzit-plugin-tool --bin kalzit-plugin --`
or install it with `cargo install --git https://github.com/MouseWerk/Kalzit kalzit-plugin-tool`.

- `--file <path in the package>=<file>` adds a file, `--dir <directory>` every file below it.
  Every file of the package is listed in `[files]` with its SHA-256, and the signature covers the
  manifest, so nothing can be added or changed afterwards.
- `--platform linux-x64` keeps only that entry of `[binaries]`, for a package built on one system.
- The key comes from `--key-file` or `KALZIT_PLUGIN_SIGNING_KEY` (32 bytes, base64);
  `--unsigned` builds a package without a signature.
- `sign --package <zip> --key-file <file>` signs an existing package again.

In CI, keep the key in a protected secret that only release builds see, and sign pull request
builds with a throwaway key (`kalzit-plugin keygen` in the job), as Kalzit's own workflows do
(`.github/workflows/ci.yml` and `release.yml`, jobs `plugins`).

## Install

A server administrator adds the publisher key (`POST /api/admin/plugin-keys`), uploads the package
(`POST /api/admin/plugins`), reviews and approves the network targets it declares, and enables it
(docs/api/plugins.md; the Plugins page in the administration follows). Its kind then appears next to the built-in kinds.

Updates keep the plugin id and key: a newer version signed by the same key replaces the
installed one (an update that adds network targets waits for approval). To move to a new key,
sign a hand-over with the old key (docs/api/plugins.md, "Hand-overs").

## Panel plugins

A panel plugin is one ES module (`[panel] path`, `api = 1`) that runs in a sandboxed iframe
without network and talks to Kalzit with `postMessage`: data in, events out. The message API is
docs/api/plugins.md, "Panel message API", with TypeScript types in
`plugin-api/panel/v1/kalzit-panel.d.ts`; `examples/plugins/panel-kpi` is a complete panel.
Package it the same way (`--file panel.js=...`). Kalzit does not host panel plugins yet; the API
and the packaging are ready for them.
