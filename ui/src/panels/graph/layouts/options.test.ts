import { describe, expect, it } from "vitest";
import {
  canRearrange,
  LAYOUT_MODES,
  MAX_LAYOUT_TIME_LABELS,
  parseGraphOptions,
  usesSeed,
} from "../options";
import { layoutOptions, layoutSettings } from "./inputs";

describe("the layout options of a graph panel", () => {
  it("default to the panel's own layout with ordering by label, axes shown, lanes per label", () => {
    const options = parseGraphOptions({});
    expect(options).toMatchObject({
      layout: "",
      layoutOrder: "label",
      layoutOrderDirection: "asc",
      layoutX: "",
      layoutY: "",
      layoutPoint: "",
      layoutAxes: true,
      layoutTime: {},
      layoutLanes: "label",
    });
  });

  it("reads every layout and falls back from anything else", () => {
    for (const mode of LAYOUT_MODES) expect(parseGraphOptions({ layout: mode }).layout).toBe(mode);
    expect(parseGraphOptions({ layout: "map" }).layout).toBe("");
    expect(parseGraphOptions({ layoutOrder: "size" }).layoutOrder).toBe("label");
    expect(parseGraphOptions({ layoutLanes: "none" }).layoutLanes).toBe("label");
    expect(parseGraphOptions({ layoutAxes: false }).layoutAxes).toBe(false);
  });

  it("keeps the properties as text and the time property per label within its limit", () => {
    const options = parseGraphOptions({
      layoutX: "umsatz",
      layoutY: 5,
      layoutPoint: "standort",
      layoutTime: { Kunde: "seit", Leer: "", "": "x", Zahl: 3 },
    });
    expect(options).toMatchObject({ layoutX: "umsatz", layoutY: "", layoutPoint: "standort" });
    expect(options.layoutTime).toEqual({ Kunde: "seit" });
    const many = Object.fromEntries(
      Array.from({ length: MAX_LAYOUT_TIME_LABELS + 10 }, (_, i) => [`L${i}`, "t"]),
    );
    expect(Object.keys(parseGraphOptions({ layoutTime: many }).layoutTime)).toHaveLength(
      MAX_LAYOUT_TIME_LABELS,
    );
    expect(parseGraphOptions({ layoutTime: "seit" }).layoutTime).toEqual({});
  });

  it("round-trip through the settings the layout menu edits", () => {
    const stored = parseGraphOptions({
      layout: "timeline",
      layoutOrderDirection: "desc",
      layoutTime: { Kunde: "seit" },
      layoutLanes: "one",
    });
    const settings = layoutSettings(stored, "force");
    expect(settings).toMatchObject({ mode: "timeline", descending: true, lanes: "one" });
    expect(parseGraphOptions({ ...stored, ...layoutOptions(settings) })).toEqual(stored);
    // A hierarchy panel stays a hierarchy whatever its options say.
    expect(layoutSettings(stored, "hierarchy").mode).toBe("hierarchy");
  });
});

describe("which layouts can be arranged again", () => {
  it("are forces and radial; only forces read the seed", () => {
    expect(LAYOUT_MODES.filter(canRearrange)).toEqual(["force", "radial"]);
    expect(LAYOUT_MODES.filter(usesSeed)).toEqual(["force"]);
  });
});
