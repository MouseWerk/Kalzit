# CSV and JSON over HTTP

An example data source plugin for Kalzit, written with the Rust SDK (`kalzit-plugin-sdk`). It
reads a CSV or JSON file from an HTTP or HTTPS URL and answers it as a frame. Plugin id:
`dev.kalzit.csv-http`.

## Settings

| Field | What |
|---|---|
| URL | The file, `http://` or `https://`. The only network target the plugin declares; redirects are not followed. |
| Format | `auto` (by the content type and the first character), `csv` or `json`. |
| Bearer token | Secret. Sent as `Authorization: Bearer <token>` when set. |

## Query

All fields are optional:

```json
{ "delimiter": ";", "header": true }
```

for CSV (`delimiter` one character, `\t` for tabs; `header: false` names the columns `c1`,
`c2`, ...), and

```json
{ "pointer": "/data/items" }
```

for JSON: the JSON pointer of an array of objects (the whole document when empty). Columns are
the keys of the objects, in alphabetical order.

Column types are recognized per column: numbers, `true`/`false`, dates (`2026-10-28`, as
midnight UTC) and times (`2026-10-28T10:00:00Z`, also with an offset or without a zone, which
counts as UTC). Everything else is text (CSV) or JSON (nested JSON values). Files are read up to
the query's byte limit, at most 64 MiB.

## Build and package

```sh
cargo build --release -p kalzit-csv-http
cargo run -p kalzit-plugin-tool --bin kalzit-plugin -- package \
  --manifest examples/plugins/csv-http/kalzit-plugin.toml \
  --file bin/linux-x64/kalzit-csv-http=target/release/kalzit-csv-http \
  --file README.md=examples/plugins/csv-http/README.md \
  --platform linux-x64 \
  --key-file my-plugin-key \
  --out csv-http.kalzit-plugin.zip
```

Ids under `dev.kalzit.` need Kalzit's own plugin key: the release workflow signs this example
with it. To try your own build, change `id` in `kalzit-plugin.toml` to a name of your own (such
as `dev.example.csv-http`) and in `src/main.rs` (`KIND`), sign it with your key, and add your
public key on the server (Settings > Plugins). The plugin author guide
(`docs/plugins/authoring.md`) has the whole way.

## License

AGPL-3.0-only, like Kalzit.
