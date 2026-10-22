import { describe, expect, it } from "vitest";
import type { Field } from "../api/generated/shapes";
import { compile, DetailError, isoTime, numberText, parse, parseNumber } from "./expr";
import * as stats from "./stats";
import { type NamedFrame, runSteps, type Step, withUnknown } from "./steps";

const fields: Field[] = [
  { name: "zeit", type: "time", values: [1_767_225_600_000, null] },
  { name: "betrag", type: "number", values: [12.5, null] },
  { name: "land", type: "string", values: ["Österreich", null] },
];

/** The reason of what `text` fails with, or "ok". */
function outcome(text: string): string {
  try {
    compile(parse(text), fields);
    return "ok";
  } catch (e) {
    if (e instanceof DetailError) return e.detail.reason;
    throw e;
  }
}

describe("expression language", () => {
  it("refuses huge and deeply nested input with a reason", () => {
    expect(outcome("1+".repeat(1500))).toBe("expression.too_long");
    expect(outcome(`${"(".repeat(100)}1${")".repeat(100)}`)).toBe("expression.too_deep");
    expect(outcome("-".repeat(200))).toBe("expression.too_deep");
    expect(outcome(Array(60).fill("1").join("+"))).toBe("ok");
    expect(outcome(Array(200).fill("1").join("+"))).toBe("expression.too_deep");
    expect(outcome(`concat(${Array(150).fill("'a'").join(",")})`)).toBe(
      "expression.arguments_range",
    );
  });

  it("answers every prefix of hostile input with a reason, never another error", () => {
    const inputs = [
      "if(bezahlt and not isnull(land), round(betrag * 1.19, 2), coalesce(anzahl, -1)) ",
      "[Umsatz (€)] / startOf(zeit + 'x', \"month\") ^ -2 <> 'ä\\n' || !true",
      "concat(text(zeit), [a]]b], 1e308 * 10, 0.5e-3, ((((())))))",
      "\u0000\u{1F600}﻿ [‮] 'unterminated \\",
    ];
    for (const input of inputs) {
      const chars = Array.from(input);
      for (let end = 0; end <= chars.length; end++) {
        expect(() => outcome(chars.slice(0, end).join(""))).not.toThrow();
      }
    }
    const alphabet = Array.from("01.5e+-*/%^()[]'\",<>=!&|abz _ägn");
    let seed = 0x2545f491;
    for (let n = 0; n < 2000; n++) {
      let text = "";
      for (let i = 0; i < seed % 40; i++) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        text += alphabet[seed % alphabet.length];
      }
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      expect(() => outcome(text)).not.toThrow();
    }
  });

  it("writes numbers and times as the server does", () => {
    expect(numberText(-0)).toBe("0");
    expect(numberText(1e21)).toBe("1e+21");
    expect(isoTime(-62_135_596_800_000)).toBe("0001-01-01T00:00:00.000Z");
    expect(isoTime(253_402_300_799_999)).toBe("9999-12-31T23:59:59.999Z");
    expect(parseNumber(" +.5 ")).toBe(0.5);
    for (const bad of ["", "0x10", "Infinity", "1_000", "1,5"]) {
      expect(parseNumber(bad), bad).toBeNull();
    }
  });
});

describe("statistics", () => {
  it("match known values", () => {
    const v = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stats.mean(v)).toBe(5);
    expect(stats.stddev(v)).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(stats.percentile(stats.sorted([3, 1, 4, 1, 5, 9, 2, 6]), 90)).toBeCloseTo(6.9, 12);
    expect(
      stats.correlation([
        [1, 2],
        [2, 4],
        [3, 5],
        [4, 4],
        [5, 5],
      ]),
    ).toBeCloseTo(0.7745966692414834, 12);
    const line = stats.regression([
      [1, 2],
      [2, 4.1],
      [3, 5.9],
      [4, 8.2],
    ]);
    expect(line?.slope).toBeCloseTo(2.04, 12);
    expect(line?.intercept).toBeCloseTo(-0.05, 12);
    expect(stats.movingAverage([1, 2, 3, null, 5, null, null], 3)).toEqual([
      null,
      null,
      2,
      2.5,
      4,
      5,
      5,
    ]);
  });
});

describe("bounds shared with the server", () => {
  const frameOf = (fields: Field[]): NamedFrame => ({ name: "A", frame: { fields } });
  const calc = (id: string, name: string, expression: string): Step => ({
    id,
    type: "calculate",
    frame: "A",
    name,
    expression,
  });

  it("refuses text the server could not read: a lone surrogate", () => {
    expect(outcome("'a\ud800'")).toBe("expression.syntax");
    expect(outcome("'a😀'")).toBe("ok");
  });

  it("refuses trees taller than the server takes", () => {
    let text = "x";
    for (let k = 63; k > 1; k--) {
      const next = `(${text}${"*x".repeat(Math.max(64 - k - 1, 0))})`;
      if (next.length > 1990) break;
      text = next;
    }
    try {
      parse(text);
      throw new Error("parsed");
    } catch (e) {
      expect(e instanceof DetailError && e.detail).toMatchObject({
        reason: "expression.too_deep",
        params: { max: "128" },
      });
    }
  });

  it("caps text per cell and per run", () => {
    const long = frameOf([{ name: "a", type: "string", values: ["x".repeat(20_000)] }]);
    const nested = runSteps([calc("1", "b", "concat(a, a)")], [long]);
    expect(nested.failed?.error.reason).toBe("expression.text_too_long");
    const emoji = frameOf([{ name: "a", type: "string", values: ["😀".repeat(16_384)] }]);
    expect(runSteps([calc("1", "b", "concat(a)")], [emoji]).failed?.error.reason).toBe(
      "expression.text_too_long",
    );
    const many = frameOf([
      { name: "a", type: "string", values: Array(100).fill("x".repeat(1000)) },
    ]);
    const run = runSteps([calc("1", "b", "concat(a, a)"), calc("2", "c", "concat(b, b)")], [many], {
      textBudget: 300_000,
    });
    expect(run.failed).toMatchObject({ index: 1, error: { reason: "steps.too_much_text" } });
  });

  it("measures pivots and joins before building them", () => {
    const n = 100_000;
    const tall = frameOf([
      { name: "r", type: "number", values: Array.from({ length: n }, (_, i) => i) },
      { name: "c", type: "number", values: Array.from({ length: n }, (_, i) => i % 500) },
    ]);
    const pivot: Step = {
      id: "p",
      type: "pivot",
      frame: "A",
      row: "r",
      column: "c",
      value: "c",
      op: "sum",
    };
    expect(runSteps([pivot], [tall]).failed?.error.reason).toBe("steps.too_many_cells");
    const wide = (name: string): NamedFrame => ({
      name,
      frame: {
        fields: [
          { name: "k", type: "number", values: Array(700).fill(1) },
          ...Array.from({ length: 60 }, (_, c) => ({
            name: `f${c}`,
            type: "number" as const,
            values: Array(700).fill(0),
          })),
        ],
      },
    });
    const join: Step = {
      id: "j",
      type: "join",
      left: "A",
      right: "B",
      on: { by: "key", leftField: "k", rightField: "k" },
      mode: "inner",
    };
    expect(runSteps([join], [wide("A"), wide("B")]).failed?.error.reason).toBe(
      "steps.too_many_cells",
    );
  });

  it("keeps stored entries it does not know", () => {
    const stored = [{ id: "x", type: "fromTheFuture" }, calc("1", "b", "1")];
    expect(withUnknown(stored, [calc("2", "c", "2")])).toEqual([
      calc("2", "c", "2"),
      { id: "x", type: "fromTheFuture" },
    ]);
  });

  it("moving averages do not drift after a huge value", () => {
    const v = [1e17, ...Array(3000).fill(0.1)];
    expect(stats.movingAverage(v, 2)[2047]).toBe(0.1);
  });
});

describe("budget", () => {
  it("runs 100,000 rows through three steps in time", () => {
    const n = 100_000;
    const t0 = 1_767_225_600_000;
    const frame: NamedFrame = {
      name: "A",
      frame: {
        fields: [
          {
            name: "zeit",
            type: "time",
            values: Array.from({ length: n }, (_, i) => t0 + i * 60_000),
          },
          {
            name: "land",
            type: "string",
            values: Array.from({ length: n }, (_, i) => ["AT", "CH", "DE"][i % 3]),
          },
          {
            name: "betrag",
            type: "number",
            values: Array.from({ length: n }, (_, i) => (i % 97) * 1.5),
          },
        ],
      },
    };
    const steps: Step[] = [
      {
        id: "1",
        type: "calculate",
        frame: "A",
        name: "brutto",
        expression: "if(land = 'AT', betrag * 1.2, betrag * 1.19)",
      },
      { id: "2", type: "movingAverage", frame: "A", field: "brutto", window: 60, name: "schnitt" },
      {
        id: "3",
        type: "group",
        frame: "A",
        by: ["land"],
        aggregations: [{ field: "schnitt", op: "mean" }],
      },
    ];
    const started = performance.now();
    const run = runSteps(steps, [frame]);
    const took = performance.now() - started;
    expect(run.failed).toBeUndefined();
    expect(run.frames[0]?.frame.fields[0]?.values).toEqual(["AT", "CH", "DE"]);
    // A panel recomputes on every change; CI machines are slower than desks.
    expect(took).toBeLessThan(1500);
  });
});
