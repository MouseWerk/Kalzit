import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newMapping, newOverride, newStep } from "./fieldConfig/FieldConfigEditor";
import { DEFAULT_THRESHOLDS, type FieldConfig } from "./fieldConfig/fieldConfig";
import { GRAPH_LIMITS } from "./fieldConfig/graphStyle";
import { CUSTOM_PREFIX } from "./fieldConfig/units";
import { MAX_EXPAND_LIMIT } from "./graph/adapter";
import { CLUSTER_MODES, COLOR_BY, MAX_NODE_LIMIT, parseGraphOptions } from "./graph/options";
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
    // The graph style at both ends of every bound, and per series through overrides.
    {
      defaults: {
        drawStyle: "line",
        lineInterpolation: "smooth",
        lineWidth: GRAPH_LIMITS.maxLineWidth,
        lineStyle: "dotted",
        fill: "hatch",
        fillOpacity: 100,
        gradientMode: "scheme",
        showPoints: "always",
        pointSize: GRAPH_LIMITS.maxPointSize,
        connectGaps: "threshold",
        connectGapsBelow: GRAPH_LIMITS.maxDuration,
        breakAfter: GRAPH_LIMITS.minDuration,
        stack: "percent",
        stackGroup: "x".repeat(GRAPH_LIMITS.stackGroupChars),
        barAlignment: "after",
        barWidth: GRAPH_LIMITS.maxBarWidth,
        comparison: false,
      },
      overrides: [
        {
          matcher: { type: "name", value: "previous" },
          properties: {
            comparison: true,
            drawStyle: "bars",
            lineInterpolation: "stepBefore",
            lineWidth: 0,
            lineStyle: null,
            fill: "none",
            fillOpacity: 0,
            gradientMode: "hue",
            showPoints: "never",
            pointSize: GRAPH_LIMITS.minPointSize,
            connectGaps: "always",
            connectGapsBelow: GRAPH_LIMITS.minDuration,
            breakAfter: GRAPH_LIMITS.maxDuration,
            stack: "normal",
            stackGroup: "B",
            barAlignment: "before",
            barWidth: GRAPH_LIMITS.minBarWidth,
          },
        },
        {
          matcher: { type: "regex", value: "^p" },
          properties: { drawStyle: "points", stack: "none", gradientMode: "opacity", fill: null },
        },
      ],
    },
  ];
}

/** Text as long as the editors' fields take (`maxLength`). */
const LONGEST = "x".repeat(100);

/**
 * Options the graph editors write beyond the defaults: every choice and both ends of each
 * number. The network and hierarchy editors store what `parseGraphOptions` returns, the path
 * editor its three texts.
 */
function editorOptions(type: string): unknown[] {
  if (type === "network" || type === "hierarchy") {
    return [
      ...COLOR_BY.map((colorBy, i) =>
        parseGraphOptions({
          caption: LONGEST,
          colorBy,
          sizeBy: "size",
          edgeWidthBy: "weight",
          nodeLimit: MAX_NODE_LIMIT,
          cluster: CLUSTER_MODES[i],
          timeProperty: "since",
          explorer: true,
          expandLimit: MAX_EXPAND_LIMIT,
          variable: "$customer",
          variableProperty: LONGEST,
        }),
      ),
      parseGraphOptions({ sizeBy: "", nodeLimit: 1, expandLimit: 1, explorer: false }),
    ];
  }
  if (type === "path") {
    return [{ caption: LONGEST, variable: "customer", variableProperty: LONGEST }];
  }
  // State panels: known state words switched off, as the editor's check box stores it.
  if (type === "state-timeline" || type === "status-history") {
    return [PANELS.find((panel) => panel.type === type)?.options({ colorStateWords: false })];
  }
  return [];
}

function fixture(): string {
  // Every built-in panel; the server checks each type in `panel_options`. Field options are kept
  // when a panel changes type, so every panel is stored with every kind the editor writes.
  const entries = PANELS.flatMap((panel) => [
    ...editorFieldConfigs().map((fieldConfig) => ({
      type: panel.type,
      options: panel.options({}),
      fieldConfig,
    })),
    ...editorOptions(panel.type).map((options) => ({
      type: panel.type,
      options,
      fieldConfig: { defaults: {}, overrides: [] },
    })),
  ]);
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
