# KPI tile

An example panel plugin for Kalzit: the latest value of a number field, its change against the
value before it, and a sparkline of the field. Plugin id: `dev.kalzit.panel-kpi`. It speaks the
panel message API version 1 (`plugin-api/panel/v1/kalzit-panel.d.ts`, docs/api/plugins.md,
"Panel message API").

Once installed, approved and enabled (Settings > Plugins), "KPI tile" is a visualization in the
panel editor like the built-in ones; Kalzit runs it in a sandboxed frame without network and
builds its options editor from the manifest's `[[panel.options]]`.

## Options

The panel's JSON options, all optional, declared in the manifest so Kalzit can check them:

```json
{ "field": "cpu", "decimals": 1, "label": "CPU" }
```

`field` picks the number field (by name); without it the first number field of the first frame
is shown. `decimals` fixes the decimal places (0 to 10). `label` replaces the panel's title above
the value.

## What it sends

- `ready` once it listens.
- `log` (`warn`) once when the option `field` names no number field of the result.

It draws only with Kalzit's design tokens (`--text`, `--text-muted`, `--bg-raised`,
`--success-text`, `--danger-text`, the font and space tokens) that arrive with `init` and
`theme`, writes text with `textContent` only, and reads messages only from its parent window.

## Package

A panel is one ES module without network access; everything it needs is inside `panel.js`.

```sh
cargo run -p kalzit-plugin-tool --bin kalzit-plugin -- package \
  --manifest examples/plugins/panel-kpi/kalzit-plugin.toml \
  --file panel.js=examples/plugins/panel-kpi/panel.js \
  --file README.md=examples/plugins/panel-kpi/README.md \
  --key-file my-plugin-key \
  --out panel-kpi.kalzit-plugin.zip
```

## License

AGPL-3.0-only, like Kalzit.
