import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newMapping, newOverride, newStep } from "./fieldConfig/FieldConfigEditor";
import { DEFAULT_THRESHOLDS, type FieldConfig } from "./fieldConfig/fieldConfig";
import { CUSTOM_PREFIX } from "./fieldConfig/units";
import { PANELS } from "./registry";

/**
 * The contract between the panel editor and the server's option checks: every panel's default
 * options, combined with the field options the editor writes, are stored in
 * `server/src/dashboards/panel_options_fixture.json`; the server test
 * `panel_options::tests::the_ui_fixture_passes` runs each through `check`. When this test fails
 * after a deliberate change, run it with UPDATE_FIXTURE=1 and commit the new fixture.
 */
const FIXTURE = resolve(
  import.meta.dirname,
  "../../../server/src/dashboards/panel_options_fixture.json",
);

/** Field options as the editor writes them, from empty to every kind of entry. */
function editorFieldConfigs(): FieldConfig[] {
  return [
    { defaults: {}, overrides: [] },
    {
      defaults: {
        unit: CUSTOM_PREFIX,
        decimals: 0,
        min: 0,
        max: 100,
        thresholds: {
          ...DEFAULT_THRESHOLDS,
          steps: [...DEFAULT_THRESHOLDS.steps, newStep(80)],
        },
        mappings: [newMapping("value"), newMapping("range"), newMapping("regex")],
        noValue: "",
        displayName: "Name",
        color: "chart-3",
        cellDisplay: "link",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder users type
        link: "${__value}",
        width: 120,
      },
      overrides: [
        newOverride(),
        {
          matcher: { type: "regex", value: "^cpu" },
          properties: { unit: null, thresholds: null, mappings: null, decimals: 2 },
        },
      ],
    },
  ];
}

function fixture(): string {
  // The panels whose options the server checks in `panel_options`: frame, document and
  // standalone panels; other panel types (graphs) bring their own checks.
  const checked = PANELS.filter(
    (panel) =>
      panel.standalone === true ||
      panel.shapes.includes("frame") ||
      panel.shapes.includes("documents"),
  );
  const entries = checked.flatMap((panel) =>
    editorFieldConfigs().map((fieldConfig) => ({
      type: panel.type,
      options: panel.options({}),
      fieldConfig,
    })),
  );
  return `${JSON.stringify(entries, null, 2)}\n`;
}

describe("panel options contract", () => {
  it("matches the fixture the server checks", () => {
    const current = fixture();
    if (process.env.UPDATE_FIXTURE !== undefined) {
      writeFileSync(FIXTURE, current);
    }
    expect(readFileSync(FIXTURE, "utf8").replaceAll("\r\n", "\n")).toBe(current);
  });
});
