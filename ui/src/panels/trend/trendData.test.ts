import { describe, expect, it } from "vitest";
import { runSteps, type Step } from "../../analysis/steps";
import type { Frame } from "../../api/generated/shapes";
import { nameFrame } from "../frame";
import { ascent, buildTrend, fixStep, trendIssue, trendX } from "./trendData";

const lots = (sizes: (number | null)[]): Frame => ({
  fields: [
    { name: "losgroesse", type: "number", values: sizes },
    { name: "preis", type: "number", values: sizes.map((s, i) => (s === null ? null : 100 - i)) },
  ],
});

describe("ascending X", () => {
  it("tells strictly ascending, a value falling back and a value repeated apart", () => {
    expect(ascent([1, 2, null, 5])).toEqual({ kind: "ascending" });
    expect(ascent([1, 10, 100, 10, 1000])).toEqual({ kind: "falls", row: 3, value: 10 });
    expect(ascent([1, 100, 100, 100, 200])).toEqual({ kind: "repeats", value: 100, count: 3 });
    // A value that falls back wins over a repeated one: sorting comes first.
    expect(ascent([1, 1, 0])).toEqual({ kind: "falls", row: 2, value: 0 });
    // int64 text counts as numbers.
    expect(ascent(["1", "2", "3"])).toEqual({ kind: "ascending" });
  });

  it("picks the first ascending number field automatically", () => {
    const frame: Frame = {
      fields: [
        { name: "preis", type: "number", values: [5, 3, 4] },
        { name: "tage", type: "number", values: [1, 7, 30] },
      ],
    };
    expect(trendX(frame)?.name).toBe("tage");
    expect(trendX(frame, "preis")?.name).toBe("preis");
    // None ascends: the first number field, so the hint can name it.
    expect(trendX(lots([10, 1, 100]))?.name).toBe("losgroesse");
  });
});

describe("issues and the steps that fix them", () => {
  it("names the row where X falls back and offers sorting by X", () => {
    const frame = lots([1, 10, 100, 10, 1000]);
    nameFrame(frame, "B");
    const issue = trendIssue(frame, trendX(frame));
    expect(issue).toEqual({ kind: "falls", field: "losgroesse", row: 3, rows: 5, value: 10 });
    const step = fixStep(frame, issue as NonNullable<typeof issue>);
    expect(step).toEqual({ type: "sort", frame: "B", by: [{ field: "losgroesse" }] });
    // With the step in the list, the same data fit.
    const run = runSteps(
      [{ id: "s", ...(step as Exclude<typeof step, null>) } as Step],
      [{ name: "B", frame }],
    );
    const sorted = run.frames[0]?.frame as Frame;
    expect(sorted.fields[0]?.values).toEqual([1, 10, 10, 100, 1000]);
    expect(trendIssue(sorted, trendX(sorted))).toEqual({
      kind: "repeats",
      field: "losgroesse",
      value: 10,
      count: 2,
    });
  });

  it("offers grouping by X with the mean of every other number field for repeated values", () => {
    const frame = lots([1, 100, 100, 200]);
    const issue = trendIssue(frame, trendX(frame));
    expect(issue).toEqual({ kind: "repeats", field: "losgroesse", value: 100, count: 2 });
    const step = fixStep(frame, issue as NonNullable<typeof issue>);
    expect(step).toEqual({
      type: "group",
      frame: "A",
      by: ["losgroesse"],
      aggregations: [{ field: "preis", op: "mean", name: "preis" }],
    });
    const run = runSteps(
      [{ id: "g", ...(step as Exclude<typeof step, null>) } as Step],
      [{ name: "A", frame }],
    );
    const grouped = run.frames[0]?.frame as Frame;
    expect(grouped.fields.map((f) => f.values)).toEqual([
      [1, 100, 200],
      [100, 98.5, 97],
    ]);
    expect(trendIssue(grouped, trendX(grouped))).toBeNull();
  });

  it("names a text X with an example, and X without anything to draw", () => {
    const weeks: Frame = {
      fields: [
        { name: "kw", type: "string", values: [null, "KW 47", "KW 48"] },
        { name: "umsatz", type: "number", values: [1, 2, 3] },
      ],
    };
    expect(trendIssue(weeks, trendX(weeks))).toEqual({
      kind: "text",
      field: "kw",
      example: "KW 47",
    });
    expect(fixStep(weeks, { kind: "text", field: "kw", example: "KW 47" })).toBeNull();
    const alone: Frame = { fields: [{ name: "x", type: "number", values: [1, 2] }] };
    expect(trendIssue(alone, trendX(alone))).toEqual({ kind: "noSeries", field: "x" });
    expect(trendIssue(alone, undefined, "gone")).toEqual({ kind: "missing", field: "gone" });
  });
});

describe("trend series", () => {
  it("draws every other number field over X, without sorting anything", () => {
    const frame: Frame = {
      fields: [
        { name: "tage", type: "number", values: [0, 7, 30, 90] },
        { name: "abo", type: "number", values: [100, 92, 80, null] },
        { name: "einmal", type: "number", values: [100, 60, 41, 30] },
        { name: "notiz", type: "string", values: ["a", "b", "c", "d"] },
      ],
    };
    const { data, issue } = buildTrend([frame], undefined);
    expect(issue).toBeNull();
    expect(data?.x.name).toBe("tage");
    expect(data?.extent).toEqual({ min: 0, max: 90 });
    expect(data?.series.map((s) => s.name)).toEqual(["abo", "einmal"]);
    expect(Array.from(data?.series[0]?.times ?? [])).toEqual([0, 7, 30, 90]);
    expect(Number.isNaN(data?.series[0]?.values[3])).toBe(true);
    // Data that do not fit draw nothing; the issue says why.
    const unsorted = buildTrend([lots([3, 1, 2])], undefined);
    expect(unsorted.data).toBeNull();
    expect(unsorted.issue?.issue.kind).toBe("falls");
  });
});
