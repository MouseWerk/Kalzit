import { describe, expect, it } from "vitest";
import { ALL_VALUE, cleanVariable, parseModel, sentValues, type VariableModel } from "./model";
import { multiSummary } from "./VariableMultiSelect";
import { parseStaticOptions, staticOptionsText } from "./VariableOptionsEditor";
import { initialVariables } from "./Variables";

const region: VariableModel = {
  name: "region",
  type: "custom",
  options: ["Nord", { value: "sued", label: "Süd" }],
  multi: true,
  includeAll: true,
};

describe("“All” of a variable", () => {
  it("opens with “All” when nothing else is stored", () => {
    expect(initialVariables([region])).toEqual({ region: [ALL_VALUE] });
    expect(initialVariables([{ ...region, multi: false }])).toEqual({ region: ALL_VALUE });
    expect(initialVariables([{ ...region, current: ["Nord"] }])).toEqual({ region: ["Nord"] });
  });

  it("sends every value, or the custom value as one value; never the marker", () => {
    const query: VariableModel = { name: "job", type: "query", includeAll: true };
    const values = { region: [ALL_VALUE], job: ALL_VALUE, other: "x" };
    expect(sentValues(values, [region, query], { job: ["api", "web"] })).toEqual({
      region: ["Nord", "sued"],
      job: ["api", "web"],
      other: "x",
    });
    expect(sentValues(values, [{ ...region, allValue: "%" }, query], {})).toMatchObject({
      region: "%",
      job: [],
    });
    // Without "All" picked, the same object goes on (no new identity per render).
    const picked = { region: ["Nord"] };
    expect(sentValues(picked, [region], {})).toBe(picked);
  });

  it("summarizes “All” in the picker", () => {
    const text = { all: "All", none: "None", more: (n: number) => `+${n}`, count: String };
    expect(multiSummary([ALL_VALUE], [], false, text)).toBe("All");
  });

  it("keeps the new options through a round trip and drops what does not belong", () => {
    const stored = {
      ...region,
      allValue: "%",
      allowCustom: true,
      current: ALL_VALUE,
    };
    const parsed = parseModel({ variables: [stored] }, "x").variables[0];
    expect(parsed).toEqual(stored);
    // A textbox has no "All", no regex and no extras; "All" as its start goes too.
    expect(
      cleanVariable({
        name: "t",
        type: "textbox",
        includeAll: true,
        allValue: "x",
        regex: "a",
        staticOptions: [{ value: "a" }],
        current: ALL_VALUE,
      }),
    ).toEqual({ name: "t", type: "textbox" });
    expect(cleanVariable({ ...region, allValue: "" })).not.toHaveProperty("allValue");
  });

  it("reads fixed extra values as name = value", () => {
    const parsed = parseStaticOptions("intern = _int, unbekannt, , a = a");
    expect(parsed).toEqual([
      { value: "_int", label: "intern" },
      { value: "unbekannt" },
      { value: "a" },
    ]);
    expect(staticOptionsText(parsed)).toBe("intern = _int, unbekannt, a");
  });
});
