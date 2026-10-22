// biome-ignore-all lint/suspicious/noTemplateCurlyInString: link placeholders such as ${__value} are typed by users, not template literals
import { describe, expect, it } from "vitest";
import type { Field } from "../../api/generated/shapes";
import {
  cellLink,
  DEFAULT_THRESHOLDS,
  displayText,
  displayValue,
  type FieldConfig,
  fieldOptionsFor,
  findMapping,
  parseFieldConfig,
  thresholdTone,
} from "./fieldConfig";
import { parseLegend } from "./legendOptions";
import { formatUnit, fromNow, joinFormatted, UNITS } from "./units";
import { legacyUnit, upgradePanel } from "./upgrade";

const NBSP = "\u00a0";
const shown = (value: number, unit: string, language: string, decimals?: number) =>
  joinFormatted(formatUnit(value, unit, decimals, language));

describe("units", () => {
  it("scales data sizes in binary and decimal steps", () => {
    expect(shown(1536, "bytes", "en")).toBe(`1.5${NBSP}KiB`);
    expect(shown(1536, "bytes", "de")).toBe(`1,5${NBSP}KiB`);
    expect(shown(1_500_000, "decbytes", "en")).toBe(`1.5${NBSP}MB`);
    expect(shown(512, "bytes", "en")).toBe(`512${NBSP}B`);
    expect(shown(3 * 1024 ** 3, "bytes", "en", 2)).toBe(`3.00${NBSP}GiB`);
    expect(shown(2_500_000, "bitsps", "de")).toBe(`2,5${NBSP}Mb/s`);
  });

  it("writes durations in the largest fitting unit", () => {
    expect(shown(0.25, "ms", "en")).toBe(`250${NBSP}µs`);
    expect(shown(1500, "ms", "en")).toBe(`1.5${NBSP}s`);
    expect(shown(90, "s", "de")).toBe(`1,5${NBSP}min`);
    expect(shown(36, "h", "en")).toBe(`1.5${NBSP}d`);
  });

  it("writes percent, currency and compact numbers as each language does", () => {
    expect(shown(45.5, "percent", "en")).toBe("45.5%");
    expect(shown(45.5, "percent", "de")).toBe(`45,5${NBSP}%`);
    expect(shown(0.25, "percentunit", "en")).toBe("25%");
    expect(shown(1234.5, "currency:EUR", "de")).toBe(`1.234,50${NBSP}€`);
    expect(shown(1234.5, "currency:EUR", "en")).toBe("€1,234.50");
    expect(shown(1234.5, "currency:USD", "en", 0)).toBe("$1,235");
    expect(shown(1_250_000, "short", "en")).toBe("1.3M");
    expect(shown(1_250_000, "short", "de")).toBe(`1,3${NBSP}Mio.`);
  });

  it("scales SI units and keeps temperatures as they are", () => {
    expect(shown(2500, "watt", "en")).toBe(`2.5${NBSP}kW`);
    expect(shown(0.004, "ampere", "de")).toBe(`4${NBSP}mA`);
    expect(shown(21.5, "celsius", "de")).toBe(`21,5${NBSP}°C`);
    expect(shown(1500, "reqps", "en")).toBe(`1.5k${NBSP}req/s`);
  });

  it("writes times and relative times in the language", () => {
    const now = Date.UTC(2026, 9, 22, 12);
    expect(fromNow(now - 3 * 3_600_000, "en", now)).toBe("3 hours ago");
    expect(fromNow(now - 3 * 3_600_000, "de", now)).toBe("vor 3 Stunden");
    expect(shown(Date.UTC(2026, 9, 22, 12), "dateIso", "en")).toBe("2026-10-22T12:00:00.000Z");
  });

  it("keeps fixed decimals and shows unknown units as a suffix", () => {
    expect(shown(2, "none", "en", 2)).toBe("2.00");
    expect(shown(7, "suffix:Kerne", "de")).toBe(`7${NBSP}Kerne`);
    expect(shown(7, "Stück", "de")).toBe(`7${NBSP}Stück`);
    expect(shown(Number.NaN, "bytes", "en")).toBe("");
  });

  it("has unique ids", () => {
    expect(new Set(UNITS.map((u) => u.id)).size).toBe(UNITS.length);
  });
});

describe("thresholds and mappings", () => {
  it("takes the last step at or below the value", () => {
    const thresholds = {
      mode: "absolute" as const,
      steps: [
        { value: null, tone: "ok" as const },
        { value: 70, tone: "warn" as const },
        { value: 90, tone: "critical" as const },
      ],
    };
    expect(thresholdTone(-1000, thresholds)).toBe("ok");
    expect(thresholdTone(69.9, thresholds)).toBe("ok");
    expect(thresholdTone(70, thresholds)).toBe("warn");
    expect(thresholdTone(95, thresholds)).toBe("critical");
    // Percentage steps compare the position between min and max.
    const percent = { ...thresholds, mode: "percentage" as const };
    expect(thresholdTone(150, percent, { min: 100, max: 200 })).toBe("ok");
    expect(thresholdTone(175, percent, { min: 100, max: 200 })).toBe("warn");
    expect(thresholdTone(195, percent, { min: 100, max: 200 })).toBe("critical");
  });

  it("sorts stored steps and keeps the base first", () => {
    const config = parseFieldConfig({
      defaults: {
        thresholds: {
          mode: "absolute",
          steps: [
            { value: null, tone: "ok" },
            { value: 90, tone: "critical" },
            { value: 50, tone: "warn" },
            { value: 5, tone: "pink" },
          ],
        },
      },
    });
    expect(config.defaults.thresholds?.steps.map((s) => s.value)).toEqual([null, 50, 90]);
  });

  it("uses the first mapping that fits: value, range or pattern", () => {
    const mappings = [
      { type: "value" as const, value: "1", text: "Up", tone: "ok" as const },
      { type: "range" as const, from: null, to: 0, text: "Down", tone: "critical" as const },
      { type: "regex" as const, pattern: "^err", text: "Error" },
      { type: "regex" as const, pattern: "(", text: "never" },
      { type: "value" as const, value: "1", text: "shadowed" },
    ];
    expect(findMapping(1, mappings)?.text).toBe("Up");
    expect(findMapping("1.0", mappings)?.text).toBe("Up");
    expect(findMapping(-3, mappings)?.text).toBe("Down");
    expect(findMapping("error: disk", mappings)?.text).toBe("Error");
    expect(findMapping("ok", mappings)).toBeUndefined();
    expect(findMapping(null, mappings)).toBeUndefined();
  });

  it("formats a value through mappings, unit, decimals and thresholds", () => {
    const options = {
      unit: "percent",
      decimals: 1,
      thresholds: DEFAULT_THRESHOLDS,
      mappings: [{ type: "value" as const, value: "0", text: "Idle" }],
      noValue: "n/a",
    };
    expect(displayValue(85, "number", options, "de")).toMatchObject({
      text: `85,0${NBSP}%`,
      tone: "critical",
    });
    expect(displayValue(0, "number", options, "en")).toMatchObject({ text: "Idle", tone: "ok" });
    expect(displayValue(null, "number", options, "en")).toMatchObject({
      text: "n/a",
      missing: true,
    });
    // Without unit and decimals an int64 keeps every digit; a custom suffix does not change that.
    const big = "9007199254740993";
    expect(displayText(displayValue(big, "int64", {}, "en"))).toBe("9,007,199,254,740,993");
    expect(displayText(displayValue(big, "int64", { unit: "suffix:B" }, "en"))).toBe(
      `9,007,199,254,740,993${NBSP}B`,
    );
    expect(displayText(displayValue("ok", "string", options, "en"))).toBe("ok");
  });
});

describe("field options", () => {
  const field = (name: string, unit?: string, labels?: Record<string, string>): Field => ({
    name,
    type: "number",
    values: [1],
    ...(unit === undefined ? {} : { unit }),
    ...(labels === undefined ? {} : { labels }),
  });

  it("applies the data source unit, then defaults, then overrides in order", () => {
    const config: FieldConfig = {
      defaults: { decimals: 1, color: "chart-2" },
      overrides: [
        { matcher: { type: "regex", value: "^cpu" }, properties: { unit: "percent", decimals: 0 } },
        { matcher: { type: "name", value: "cpu_user" }, properties: { decimals: 3 } },
        { matcher: { type: "regex", value: "(" }, properties: { unit: "bytes" } },
      ],
    };
    expect(fieldOptionsFor(field("mem", "bytes"), EMPTY)).toEqual({ unit: "bytes" });
    expect(fieldOptionsFor(field("mem", "bytes"), config)).toEqual({
      unit: "bytes",
      decimals: 1,
      color: "chart-2",
    });
    expect(fieldOptionsFor(field("cpu_user", "ms"), config)).toEqual({
      unit: "percent",
      decimals: 3,
      color: "chart-2",
    });
    expect(fieldOptionsFor(field("cpu_sys"), config).decimals).toBe(0);
    // Names with labels match as series are written.
    const labelled = field("up", undefined, { job: "api" });
    const byLabel: FieldConfig = {
      defaults: {},
      overrides: [
        { matcher: { type: "name", value: 'up{job="api"}' }, properties: { color: "ok" } },
      ],
    };
    expect(fieldOptionsFor(labelled, byLabel).color).toBe("ok");
  });

  it("reads stored options defensively and within bounds", () => {
    const config = parseFieldConfig({
      defaults: {
        decimals: 99,
        width: 5,
        color: "#f00",
        cellDisplay: "sparkline",
        mappings: [
          { type: "special", match: "null" },
          { type: "value", value: "1" },
        ],
        extra: true,
      },
      overrides: "nope",
    });
    expect(config).toEqual({
      defaults: { decimals: 10, width: 40, mappings: [{ type: "value", value: "1" }] },
      overrides: [],
    });
    expect(parseFieldConfig(null)).toEqual({ defaults: {}, overrides: [] });
  });

  it("makes links only for safe addresses", () => {
    expect(cellLink("https://x.example/q?v=${__value}", "a b&c", "f")).toBe(
      "https://x.example/q?v=a%20b%26c",
    );
    expect(cellLink("/d/${__field}", "1", "host name")).toBe("/d/host%20name");
    expect(cellLink("${__value}", "javascript:alert(1)", "f")).toBeNull();
    expect(cellLink("//evil.example", "1", "f")).toBeNull();
    expect(cellLink("data:text/html,x", "1", "f")).toBeNull();
  });
});

const EMPTY: FieldConfig = { defaults: {}, overrides: [] };

describe("older panels", () => {
  it("move their unit, legend template and switches to the new places", () => {
    const panel = {
      options: { unit: "ms", legend: "{{job}}", showLegend: false, lineWidth: 2 },
      fieldConfig: {},
    };
    expect(upgradePanel(panel)).toEqual({
      options: {
        seriesName: "{{job}}",
        legend: { mode: "hidden", placement: "bottom", values: [] },
        lineWidth: 2,
      },
      fieldConfig: { defaults: { unit: "ms" } },
    });
    expect(upgradePanel({ options: { unit: "Stück", sparkline: false }, fieldConfig: {} })).toEqual(
      {
        options: { graphMode: "none" },
        fieldConfig: { defaults: { unit: "suffix:Stück" } },
      },
    );
    // A unit already set in the field options wins over the old one.
    expect(
      upgradePanel({ options: { unit: "ms" }, fieldConfig: { defaults: { unit: "s" } } })
        .fieldConfig,
    ).toEqual({ defaults: { unit: "s" } });
    const current = { options: { seriesName: "x" }, fieldConfig: {} };
    expect(upgradePanel(current)).toBe(current);
  });

  it("still draw with the old options until they are saved again", () => {
    expect(legacyUnit(EMPTY, "ms").defaults.unit).toBe("ms");
    expect(legacyUnit({ defaults: { unit: "s" }, overrides: [] }, "ms").defaults.unit).toBe("s");
    expect(parseLegend({ showLegend: false }).mode).toBe("hidden");
    expect(parseLegend({ legend: "{{job}}" }).mode).toBe("list");
  });
});
