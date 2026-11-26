import { describe, expect, it } from "vitest";
import type { Frame } from "../api/generated/shapes";
import { aggregate, resultType } from "./calculations";
import {
  boolOfText,
  fieldPattern,
  MAX_MATCH_CHARS,
  matchHead,
  type NamedFrame,
  parseTime,
  runSteps,
  type Step,
  safePattern,
} from "./steps";

const T0 = 1_767_225_600_000; // 2026-01-01
const DAY = 86_400_000;

const sales = (): NamedFrame => ({
  name: "A",
  frame: {
    fields: [
      { name: "zeit", type: "time", values: [T0, T0 + DAY, T0 + 2 * DAY] },
      { name: "land", type: "string", values: ["AT", "CH", null] },
      { name: "betrag", type: "number", unit: "EUR", values: [10, 20, 30] },
    ],
  },
});

function run(steps: Step[], inputs: NamedFrame[] = [sales()]) {
  const out = runSteps(steps, inputs);
  if (out.failed !== undefined) throw new Error(out.failed.error.reason);
  return out.frames;
}

const frameOf = (frames: NamedFrame[], name = "A") =>
  frames.find((f) => f.name === name)?.frame as Frame;
const names = (frame: Frame) => frame.fields.map((f) => f.name);
const values = (frame: Frame, name: string) => frame.fields.find((f) => f.name === name)?.values;

describe("table steps", () => {
  it("organize keeps a field the step does not name, at the end and shown", () => {
    const frame = frameOf(
      run([{ id: "o", type: "organize", frame: "A", order: ["betrag"], rename: { land: "Land" } }]),
    );
    expect(names(frame)).toEqual(["betrag", "zeit", "Land"]);
    // Units and values stay as they were.
    expect(frame.fields[0]?.unit).toBe("EUR");
    expect(values(frame, "Land")).toEqual(["AT", "CH", null]);
  });

  it("filter fields keeps by name or pattern, or leaves them out", () => {
    const keep = frameOf(
      run([{ id: "f", type: "filterFields", frame: "A", mode: "keep", pattern: "^(zeit|land)$" }]),
    );
    expect(names(keep)).toEqual(["zeit", "land"]);
    const drop = frameOf(
      run([{ id: "f", type: "filterFields", frame: "A", mode: "drop", names: ["land"] }]),
    );
    expect(names(drop)).toEqual(["zeit", "betrag"]);
    expect(() => fieldPattern("(")).toThrow();
  });

  it("takes only the pattern subset both engines read the same and in bounded time", () => {
    for (const ok of [
      "^cpu_(user|system)$",
      "a{2,5}?",
      "[a-z\\-]+",
      "x\\.y",
      "(ab)*",
      "",
      "a|",
      "ä+",
      ".*cpu.*",
      ".*?a+b*.*?",
      "[a-z]+_[0-9]+",
      "(a|b)(c|d)x+",
      "a?aaaa",
      "[^a]{400}",
    ]) {
      expect(safePattern(ok), ok).toBe(true);
    }
    for (const bad of [
      "(?=a)",
      "(?i)a",
      "(?:a)",
      "(a)\\1",
      "\\d+",
      "\\w",
      "\\bx",
      "(a+)+",
      "((a*)b)*",
      "a{2",
      "a{3,2}",
      "a{1001}",
      "}",
      "]",
      "[a&&b]",
      "[[:alpha:]]",
      "[]",
      "*a",
      "a**",
      "^*",
      "\\ ",
      "(ab|cd)*",
      "(a|a)*",
      "(a|aa)+",
      "((a|b)c){2}",
      "a*b*c*",
      ".*a.*b.*c.*d",
      "a+b+\\.*",
      "a?a?a?a?aaaa",
      "(a|b)x+y+",
      "(a|b)(a|b)(a|b)(a|b)(a|b)(a|b)(a|b)x+",
      "[^a]{401}",
      "(abcdefghijklmnopq){1000}",
    ]) {
      expect(safePattern(bad), bad).toBe(false);
    }
    expect(safePattern("(a|b)".repeat(12))).toBe(true);
    expect(safePattern("(a|b)".repeat(13))).toBe(false);
    expect(safePattern("x".repeat(2000))).toBe(true);
    expect(safePattern("x".repeat(2001))).toBe(false);
    // `.` passes over line ends; a pattern reads the first 150 characters, as on the server.
    const dot = fieldPattern("a.b");
    expect([dot.test("a b"), dot.test("a\rb"), dot.test("a\u2028b")]).toEqual([true, false, false]);
    const long = `${"a".repeat(MAX_MATCH_CHARS)}x`;
    expect(fieldPattern("x$").test(long)).toBe(true);
    expect(fieldPattern("x$").test(matchHead(long))).toBe(false);
    expect(Array.from(matchHead("\u{1F600}".repeat(300))).length).toBe(MAX_MATCH_CHARS);
    expect(fieldPattern("x\\.*").test("x")).toBe(true);
    expect(parseTime(`2026-01-01T00:00:00.${"0".repeat(60)}`, undefined)).toBeNull();
  });

  it("filter rows: any condition, keep or drop", () => {
    const step = (mode: "keep" | "drop"): Step => ({
      id: "r",
      type: "filterRows",
      frame: "A",
      mode,
      match: "any",
      conditions: [
        { field: "betrag", op: "gte", value: "30" },
        { field: "land", op: "eq", value: "AT" },
      ],
    });
    expect(values(frameOf(run([step("keep")])), "betrag")).toEqual([10, 30]);
    expect(values(frameOf(run([step("drop")])), "betrag")).toEqual([20]);
  });

  it("limit takes the first or the last rows", () => {
    expect(
      values(frameOf(run([{ id: "l", type: "limit", frame: "A", count: 2 }])), "betrag"),
    ).toEqual([10, 20]);
    expect(
      values(
        frameOf(run([{ id: "l", type: "limit", frame: "A", count: 1, from: "last" }])),
        "betrag",
      ),
    ).toEqual([30]);
  });

  it("convert keeps the unit only for numbers and the place of the field", () => {
    const frame = frameOf(
      run([
        {
          id: "c",
          type: "convert",
          frame: "A",
          conversions: [
            { field: "betrag", to: "string" },
            { field: "zeit", to: "number" },
          ],
        },
      ]),
    );
    expect(names(frame)).toEqual(["zeit", "land", "betrag"]);
    expect(frame.fields[2]).toEqual({
      name: "betrag",
      type: "string",
      values: ["10", "20", "30"],
    });
    expect(frame.fields[0]).toMatchObject({ type: "number", values: [T0, T0 + DAY, T0 + 2 * DAY] });
  });

  it("reads times as ISO 8601 or by a format, and true or false from text", () => {
    expect(parseTime("2026-01-01", undefined)).toBe(T0);
    expect(parseTime("2026-01-01T01:00+01:00", undefined)).toBe(T0);
    expect(parseTime("01.01.2026 00:00", "DD.MM.YYYY HH:mm")).toBe(T0);
    expect(parseTime("2026-02-29", undefined)).toBeNull();
    expect(parseTime("01/01/2026", "DD.MM.YYYY")).toBeNull();
    expect(boolOfText(" True ")).toBe(true);
    expect(boolOfText("0")).toBe(false);
    expect(boolOfText("ja")).toBeNull();
  });

  it("reduce brings every series to one row or one field per calculation", () => {
    const rows = frameOf(
      run([{ id: "r", type: "reduceSeries", frame: "A", mode: "rows", calculations: ["max"] }]),
    );
    expect(names(rows)).toEqual(["field", "max"]);
    expect(values(rows, "max")).toEqual([30]);
    expect(rows.fields[1]?.unit).toBe("EUR");
    const columns = frameOf(
      run([
        {
          id: "r",
          type: "reduceSeries",
          frame: "A",
          mode: "columns",
          calculations: ["first", "count"],
          fields: ["land"],
        },
      ]),
    );
    expect(names(columns)).toEqual(["first(land)", "count(land)"]);
    expect(values(columns, "first(land)")).toEqual(["AT"]);
  });

  it("stack and series to rows put queries together at the place of the first", () => {
    const b: NamedFrame = {
      name: "B",
      frame: {
        fields: [
          { name: "zeit", type: "time", values: [T0] },
          { name: "betrag", type: "number", unit: "EUR", values: [5] },
        ],
      },
    };
    const stacked = run([{ id: "s", type: "stack", frames: ["A", "B"] }], [sales(), b]);
    expect(stacked.map((f) => f.name)).toEqual(["A"]);
    expect(values(frameOf(stacked), "land")).toEqual(["AT", "CH", null, null]);
    expect(frameOf(stacked).fields[2]?.unit).toBe("EUR");
    const long = frameOf(
      run([{ id: "s", type: "seriesToRows", frames: ["A", "B"] }], [sales(), b]),
    );
    expect(names(long)).toEqual(["time", "metric", "value"]);
    expect(values(long, "value")).toEqual([10, 5, 20, 30]);
    expect(long.fields[2]?.unit).toBe("EUR");
  });

  it("the shared calculations: types and values", () => {
    const f = { name: "x", type: "int64" as const, values: ["7", null, "9007199254740993"] };
    expect(aggregate(f, "firstRow", [0, 1])).toBe("7");
    expect(aggregate(f, "lastRow", [0, 1])).toBeNull();
    expect(resultType("p95", "number")).toBe("number");
    expect(resultType("p101" as "p95", "number")).toBeNull();
    expect(resultType("max", "int64")).toBe("int64");
    expect(resultType("sum", "string")).toBeNull();
    expect(aggregate(f, "max", [0, 1, 2])).toBe("9007199254740993");
    expect(aggregate(f, "count", [0, 1, 2])).toBe(2);
    expect(aggregate(f, "last", [0, 1])).toBe("7");
  });
});
