import { describe, expect, it } from "vitest";
import {
  conditionProblem,
  evaluateRules,
  fillTemplate,
  hasValue,
  parseConditionDate,
  parseConditionNumber,
  type StyleItem,
  type Targets,
  valueSlots,
} from "./evaluate";
import {
  type Condition,
  type ConditionOp,
  MAX_STYLE_RULES,
  MAX_VALUE_COLORS,
  type RuleWhen,
  type StyleRule,
  type ValueType,
} from "./schema";

const NOW = Date.parse("2026-11-21T12:00:00Z");

function rule(
  when: RuleWhen,
  set: Targets,
  more: Partial<StyleRule<Targets>> = {},
): StyleRule<Targets> {
  return { id: `r${Math.random()}`, on: true, scope: "", when, set, ...more };
}

function condition(
  type: ValueType,
  op: ConditionOp,
  value = "",
  to = "",
  property = "p",
  caseSensitive = false,
): Condition {
  return { kind: "condition", property, type, op, value, to, caseSensitive };
}

const item = (properties: Record<string, unknown>, ...kinds: string[]): StyleItem => ({
  kinds,
  properties,
});

/** Which of `values` a condition on property `p` matches. */
function matches(when: Condition, values: unknown[]): boolean[] {
  const items = values.map((value) => item(value === undefined ? {} : { p: value }));
  // One item always carries the property, so the rule does not rest.
  const all = [...items, item({ p: "\u0000sentinel" })];
  const { styles } = evaluateRules([rule(when, { color: "good" })], all, { now: NOW });
  return styles.slice(0, values.length).map((style) => style !== null);
}

describe("conditions on numbers", () => {
  const values = [5, 10, 15, "10", { $type: "int64", value: "10" }, "ten", null, undefined];
  it.each<[ConditionOp, string, string, boolean[]]>([
    ["eq", "10", "", [false, true, false, true, true, false, false, false]],
    ["ne", "10", "", [true, false, true, false, false, false, false, false]],
    ["lt", "10", "", [true, false, false, false, false, false, false, false]],
    ["lte", "10", "", [true, true, false, true, true, false, false, false]],
    ["gt", "10", "", [false, false, true, false, false, false, false, false]],
    ["gte", "10", "", [false, true, true, true, true, false, false, false]],
    ["between", "8", "12", [false, true, false, true, true, false, false, false]],
    // The ends of a range in either order.
    ["between", "15", "10", [false, true, true, true, true, false, false, false]],
    ["exists", "", "", [true, true, true, true, true, true, false, false]],
    ["missing", "", "", [false, false, false, false, false, false, true, true]],
  ])("%s %s %s", (op, value, to, expected) => {
    expect(matches(condition("number", op, value, to), values)).toEqual(expected);
  });

  it("reads a typed number with a comma or a point", () => {
    expect(parseConditionNumber("10000")).toBe(10000);
    expect(parseConditionNumber(" 1,5 ")).toBe(1.5);
    expect(parseConditionNumber("-0.25")).toBe(-0.25);
    expect(parseConditionNumber("zehntausend")).toBeNull();
    expect(parseConditionNumber("")).toBeNull();
    expect(parseConditionNumber("1e3")).toBeNull();
  });
});

describe("conditions on text", () => {
  const values = ["Premium", "premium plus", "Standard", ["Premium", "Neu"], 42, "", undefined];
  it.each<[ConditionOp, string, boolean[]]>([
    ["eq", "premium", [true, false, false, false, false, false, false]],
    ["ne", "premium", [false, true, true, false, true, false, false]],
    ["contains", "PREM", [true, true, false, false, false, false, false]],
    ["notContains", "prem", [false, false, true, false, true, false, false]],
    ["startsWith", "prem", [true, true, false, false, false, false, false]],
    ["exists", "", [true, true, true, true, true, false, false]],
    ["missing", "", [false, false, false, false, false, true, true]],
  ])("%s %s", (op, value, expected) => {
    expect(matches(condition("text", op, value), values)).toEqual(expected);
  });

  it("asks a list only whether it contains an element", () => {
    const list = [["Premium", "Neu"]];
    expect(matches(condition("text", "contains", "neu"), list)).toEqual([true]);
    // Part of an element is not an element.
    expect(matches(condition("text", "contains", "ne"), list)).toEqual([false]);
    expect(matches(condition("text", "eq", "Premium"), list)).toEqual([false]);
    expect(matches(condition("text", "notContains", "x"), list)).toEqual([false]);
    expect(matches(condition("text", "exists"), [list[0], []])).toEqual([true, false]);
  });

  it("compares with case only when the rule says so", () => {
    const sensitive = condition("text", "eq", "premium", "", "p", true);
    expect(matches(sensitive, ["Premium", "premium"])).toEqual([false, true]);
  });
});

describe("conditions on dates", () => {
  const values = [
    "2021-12-31T23:59:59Z",
    "2022-01-01",
    "2022-01-01T18:00:00Z",
    { $type: "date", value: "2022-01-02" },
    Date.parse("2026-11-20T12:00:00Z"),
    "not a date",
    undefined,
  ];
  it.each<[ConditionOp, string, string, boolean[]]>([
    ["on", "2022-01-01", "", [false, true, true, false, false, false, false]],
    ["before", "2022-01-01", "", [true, false, false, false, false, false, false]],
    ["after", "2022-01-01", "", [false, false, false, true, true, false, false]],
    ["between", "2022-01-01", "2022-01-02", [false, true, true, true, false, false, false]],
    ["between", "2022-01-02", "2021-12-31", [true, true, true, true, false, false, false]],
    ["lastDays", "7", "", [false, false, false, false, true, false, false]],
    ["lastDays", "0", "", [false, false, false, false, false, false, false]],
    ["exists", "", "", [true, true, true, true, true, true, false]],
    ["missing", "", "", [false, false, false, false, false, false, true]],
  ])("%s %s %s", (op, value, to, expected) => {
    expect(matches(condition("date", op, value, to), values)).toEqual(expected);
  });

  it("takes an instant as it is and a day as the whole day", () => {
    const at = "2022-01-01T18:00:00Z";
    expect(matches(condition("date", "on", at), [at, "2022-01-01T18:00:01Z"])).toEqual([
      true,
      false,
    ]);
    expect(matches(condition("date", "after", at), [at, "2022-01-01T18:00:01Z"])).toEqual([
      false,
      true,
    ]);
    expect(parseConditionDate("2022-01-01")).toEqual({
      start: Date.parse("2022-01-01T00:00:00Z"),
      end: Date.parse("2022-01-02T00:00:00Z"),
    });
    expect(parseConditionDate("01.01.2022")).toBeNull();
    expect(parseConditionDate("2022-13-40")).toBeNull();
  });
});

describe("conditions on truth values", () => {
  const values = [true, false, "true", 1, null, undefined];
  it.each<[ConditionOp, boolean[]]>([
    ["true", [true, false, false, false, false, false]],
    ["false", [false, true, false, false, false, false]],
    ["exists", [true, true, true, true, false, false]],
    ["missing", [false, false, false, false, true, true]],
  ])("%s", (op, expected) => {
    expect(matches(condition("boolean", op), values)).toEqual(expected);
  });
});

describe("a condition whose value does not fit the type", () => {
  it("names the field and makes the rule invalid instead of matching", () => {
    expect(conditionProblem(condition("number", "gte", "zehntausend"))).toBe("value");
    expect(conditionProblem(condition("number", "between", "1", "x"))).toBe("to");
    expect(conditionProblem(condition("number", "between", "1", "2"))).toBeNull();
    expect(conditionProblem(condition("date", "before", "gestern"))).toBe("value");
    expect(conditionProblem(condition("date", "lastDays", "-1"))).toBe("value");
    expect(conditionProblem(condition("text", "eq", ""))).toBe("value");
    expect(conditionProblem(condition("number", "exists", "whatever"))).toBeNull();
    expect(conditionProblem(condition("boolean", "true"))).toBeNull();

    const items = [item({ p: 20000 })];
    const result = evaluateRules(
      [rule(condition("number", "gte", "zehntausend"), { badge: "Top" })],
      items,
    );
    expect(result.rules[0]?.state).toBe("invalid");
    expect(result.styles).toEqual([null]);
  });
});

describe("the scope of a rule", () => {
  const items = [
    item({ p: 1 }, "Kunde"),
    item({ p: 1 }, "Produkt", "Kunde"),
    item({ p: 1 }, "Produkt"),
    item({ p: 1 }),
  ];
  it("is one label or type, or everything", () => {
    const all = evaluateRules([rule({ kind: "always" }, { color: "good" })], items);
    expect(all.styles.map((s) => s !== null)).toEqual([true, true, true, true]);
    expect(all.rules[0]).toMatchObject({ state: "active", inScope: 4, matched: 4 });

    const one = evaluateRules(
      [rule({ kind: "always" }, { color: "good" }, { scope: "Kunde" })],
      items,
    );
    expect(one.styles.map((s) => s !== null)).toEqual([true, true, false, false]);
    expect(one.rules[0]).toMatchObject({ inScope: 2, matched: 2 });
  });

  it("counts hits among the items of its scope: 2 of 5 customers", () => {
    const customers = [12480, 10150, 7940, 3210, 890].map((umsatz) => item({ umsatz }, "Kunde"));
    const result = evaluateRules(
      [
        rule(
          condition("number", "gte", "10000", "", "umsatz"),
          { badge: "Top" },
          { scope: "Kunde" },
        ),
      ],
      [...customers, item({ umsatz: 99999 }, "Produkt")],
    );
    expect(result.rules[0]).toMatchObject({ inScope: 5, matched: 2 });
    expect(result.styles.map((s) => s?.set.badge)).toEqual([
      "Top",
      "Top",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("every target", () => {
  it("is set as the rule says, for nodes and for edges", () => {
    const node: Targets = {
      color: "chart-3",
      size: 14,
      shape: "hexagon",
      icon: "user",
      border: "dashed",
      label: "{name} (gekündigt)",
      badge: "{rank}",
    };
    const edge: Targets = { color: "critical", width: 3, dash: "dotted", label: "{menge} x", arrow: "none" };
    const [styled] = evaluateRules(
      [rule({ kind: "always" }, node)],
      [item({ name: "Mira Schulz", rank: "Top-Kundin" })],
    ).styles;
    expect(styled?.set).toEqual({
      ...node,
      label: "Mira Schulz (gekündigt)",
      // A badge holds six characters.
      badge: "Top-Ku",
    });
    expect(styled?.from).toEqual({
      color: 0,
      size: 0,
      shape: 0,
      icon: 0,
      border: 0,
      label: 0,
      badge: 0,
    });
    const [line] = evaluateRules([rule({ kind: "always" }, edge)], [item({ menge: 4 }, "KAUFTE")])
      .styles;
    expect(line?.set).toEqual({ ...edge, label: "4 x" });
  });

  it("leaves a label or badge out when its template fills in to nothing", () => {
    const [styled] = evaluateRules(
      [rule({ kind: "always" }, { label: "{nickname}", badge: "{rank}", color: "good" })],
      [item({ name: "Anna" })],
    ).styles;
    expect(styled?.set).toEqual({ color: "good" });
  });

  it("fills templates from own properties only", () => {
    expect(fillTemplate("{a} und {b}", { a: 1, b: true })).toBe("1 und true");
    expect(fillTemplate("{constructor}{__proto__} x", {})).toBe("x");
    expect(fillTemplate("ohne Platzhalter", {})).toBe("ohne Platzhalter");
    expect(fillTemplate("{a}", { a: "x".repeat(200) })).toHaveLength(100);
  });
});

describe("the order of rules", () => {
  const items = [item({ umsatz: 12000, aktiv: false }, "Kunde"), item({ umsatz: 500 }, "Kunde")];

  it("lets the lower rule win on the same target and keeps other targets", () => {
    const rules = [
      rule({ kind: "always" }, { color: "chart-1", icon: "user" }),
      rule(condition("number", "gte", "10000", "", "umsatz"), { color: "chart-2", badge: "Top" }),
      rule(condition("boolean", "false", "", "", "aktiv"), { color: "neutral" }),
    ];
    const result = evaluateRules(rules, items);
    expect(result.styles[0]?.set).toEqual({ color: "neutral", icon: "user", badge: "Top" });
    expect(result.styles[0]?.from).toEqual({ color: 2, icon: 0, badge: 1 });
    expect(result.styles[0]?.rules).toEqual([0, 1, 2]);
    expect(result.styles[1]?.set).toEqual({ color: "chart-1", icon: "user" });
    // What each rule lost, by the rule that took it, counted in items.
    expect(result.rules[0]?.overridden).toEqual([{ by: 2, count: 1 }]);
    expect(result.rules[1]?.overridden).toEqual([{ by: 2, count: 1 }]);
    expect(result.rules[2]?.overridden).toEqual([]);
  });

  it("changes the winner when the order changes", () => {
    const general = rule({ kind: "always" }, { color: "chart-1" });
    const exception = rule(condition("number", "gte", "10000", "", "umsatz"), {
      color: "chart-2",
    });
    expect(evaluateRules([general, exception], items).styles[0]?.set.color).toBe("chart-2");
    expect(evaluateRules([exception, general], items).styles[0]?.set.color).toBe("chart-1");
  });

  it("skips a rule that is switched off but still counts what it would match", () => {
    const off = rule({ kind: "always" }, { color: "chart-1" }, { on: false });
    const result = evaluateRules([off], items);
    expect(result.styles).toEqual([null, null]);
    expect(result.rules[0]).toMatchObject({ state: "off", inScope: 2, matched: 2 });
  });

  it("lets a border of none take back a border set above", () => {
    const result = evaluateRules(
      [
        rule({ kind: "always" }, { border: "dashed" }),
        rule(condition("number", "lt", "1000", "", "umsatz"), { border: "none" }),
      ],
      items,
    );
    expect(result.styles.map((s) => s?.set.border)).toEqual(["dashed", "none"]);
  });
});

describe("a rule whose property the result lacks", () => {
  it("rests and says so instead of failing", () => {
    const items = [item({ name: "Anna" }, "Kunde"), item({ name: "Tom" }, "Kunde")];
    const result = evaluateRules(
      [
        rule({ kind: "values", property: "segment", colors: [] }, {}, { scope: "Kunde" }),
        rule(condition("text", "eq", "Premium", "", "segment"), { badge: "P" }),
        rule(condition("text", "missing", "", "", "segment"), { color: "neutral" }),
      ],
      items,
    );
    expect(result.rules.map((r) => r.state)).toEqual(["dormant", "dormant", "active"]);
    // "Is missing" is about exactly these items.
    expect(result.styles.map((s) => s?.set.color)).toEqual(["neutral", "neutral"]);
  });

  it("is active as soon as one item of its scope carries the property", () => {
    const items = [item({ segment: null }, "Kunde"), item({}, "Kunde")];
    const result = evaluateRules([rule(condition("text", "exists", "", "", "segment"), {})], items);
    expect(result.rules[0]).toMatchObject({ state: "active", matched: 0 });
  });
});

describe("per unique value", () => {
  const branches = (counts: Record<string, number>): StyleItem[] =>
    Object.entries(counts).flatMap(([branche, count]) =>
      Array.from({ length: count }, () => item({ branche }, "Kunde")),
    );

  it("colors the most frequent values first, in a fixed order", () => {
    const items = [
      ...branches({ Handel: 3, Maschinenbau: 5, Energie: 1, Logistik: 3 }),
      item({}, "Kunde"),
    ];
    const result = evaluateRules(
      [rule({ kind: "values", property: "branche", colors: [] }, {})],
      items,
    );
    const report = result.rules[0]?.values;
    expect(report?.shown.map((s) => [s.value, s.count, s.color])).toEqual([
      ["Maschinenbau", 5, "chart-1"],
      // A tie is settled by the text, so the same data always colors the same.
      ["Handel", 3, "chart-2"],
      ["Logistik", 3, "chart-3"],
      ["Energie", 1, "chart-4"],
    ]);
    expect(report).toMatchObject({ total: 4, other: { values: 0, count: 0 }, missing: 1 });
    expect(result.styles[0]?.set).toEqual({ color: "chart-2" });
    // An item without a value keeps the basis.
    expect(result.styles.at(-1)).toBeNull();
    expect(result.rules[0]).toMatchObject({ inScope: 13, matched: 12 });
  });

  it("shows 12 of 48 values and puts the rest under other, in the neutral color", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 48; i++) counts[`Wert ${String(i).padStart(2, "0")}`] = 100 - i;
    const items = branches(counts);
    const result = evaluateRules(
      [rule({ kind: "values", property: "branche", colors: [] }, {})],
      items,
    );
    const report = result.rules[0]?.values;
    expect(report?.shown).toHaveLength(MAX_VALUE_COLORS);
    expect(report?.total).toBe(48);
    expect(report?.other.values).toBe(36);
    expect(report?.other.count).toBe(items.length - report!.shown.reduce((n, s) => n + s.count, 0));
    // The palette has eight colors: the ninth value takes the first again, marked as shifted.
    expect(report?.shown[8]).toMatchObject({ color: "chart-1", shifted: true });
    expect(report?.shown[7]).toMatchObject({ color: "chart-8", shifted: false });
    const ninth = items.findIndex((it) => it.properties.branche === "Wert 08");
    expect(result.styles[ninth]).toMatchObject({ set: { color: "chart-1" }, shifted: true });
    const thirteenth = items.findIndex((it) => it.properties.branche === "Wert 12");
    expect(result.styles[thirteenth]).toMatchObject({ set: { color: "neutral" }, shifted: false });
  });

  it("keeps a value's color when the result changes", () => {
    const pinned = [
      { value: "Handel", color: "chart-5" as const },
      { value: "Energie", color: "good" as const },
    ];
    const before = valueSlots(pinned, new Map([["Handel", 9], ["Energie", 4], ["Logistik", 2]]));
    const after = valueSlots(pinned, new Map([["Logistik", 50], ["Handel", 1], ["Bau", 60]]));
    const color = (slots: typeof before, value: string) =>
      slots.find((s) => s.value === value)?.color;
    expect(color(before, "Handel")).toBe("chart-5");
    expect(color(after, "Handel")).toBe("chart-5");
    // A value the result lacks for now keeps its place and its color.
    expect(after.find((s) => s.value === "Energie")).toMatchObject({ color: "good", count: 0 });
    expect(after.map((s) => s.value)).toEqual(["Handel", "Energie", "Bau", "Logistik"]);
  });

  it("can be overridden by a rule below it, and says for how many", () => {
    const items = branches({ Handel: 2, Energie: 1 });
    const result = evaluateRules(
      [
        rule({ kind: "values", property: "branche", colors: [] }, {}),
        rule(condition("text", "eq", "Energie", "", "branche"), { color: "critical" }),
      ],
      items,
    );
    expect(result.styles.map((s) => s?.set.color)).toEqual(["chart-1", "chart-1", "critical"]);
    expect(result.rules[0]?.overridden).toEqual([{ by: 1, count: 1 }]);
    // The shift belongs to the color of the rule that set it.
    expect(result.styles[2]?.shifted).toBe(false);
  });

  it("counts a number or a truth value by its text", () => {
    const items = [item({ p: 1 }), item({ p: "1" }), item({ p: true }), item({ p: "" })];
    const report = evaluateRules([rule({ kind: "values", property: "p", colors: [] }, {})], items)
      .rules[0]?.values;
    expect(report?.shown.map((s) => [s.value, s.count])).toEqual([
      ["1", 2],
      ["true", 1],
    ]);
    expect(report?.missing).toBe(1);
  });
});

describe("limits", () => {
  it("evaluates at most 50 rules", () => {
    const rules = Array.from({ length: MAX_STYLE_RULES + 5 }, (_, i) =>
      rule({ kind: "always" }, { size: 2 + (i % 30) }),
    );
    const result = evaluateRules(rules, [item({})]);
    expect(result.rules).toHaveLength(MAX_STYLE_RULES);
    expect(result.styles[0]?.from.size).toBe(MAX_STYLE_RULES - 1);
  });

  it("answers for no rules and for no items", () => {
    expect(evaluateRules([], [item({})])).toEqual({ styles: [null], rules: [] });
    const empty = evaluateRules([rule({ kind: "always" }, { color: "good" })], []);
    expect(empty.styles).toEqual([]);
    expect(empty.rules[0]).toMatchObject({ state: "active", inScope: 0, matched: 0 });
  });

  it("stays fast on a graph at the panel's limit", () => {
    const items = Array.from({ length: 20_000 }, (_, i) =>
      item({ umsatz: i, segment: `s${i % 40}`, seit: "2022-01-01" }, i % 2 === 0 ? "Kunde" : "Produkt"),
    );
    const rules = Array.from({ length: MAX_STYLE_RULES }, (_, i) =>
      i % 5 === 0
        ? rule({ kind: "values", property: "segment", colors: [] }, {})
        : rule(condition("number", "gte", String(i * 100), "", "umsatz"), { size: 10 }),
    );
    const start = performance.now();
    const result = evaluateRules(rules, items, { now: NOW });
    expect(result.styles).toHaveLength(20_000);
    expect(performance.now() - start).toBeLessThan(3_000);
  });
});

describe("hasValue", () => {
  it("takes null, nothing, empty text and an empty list as no value", () => {
    expect([null, undefined, "", [], 0, false, "x", [1], {}].map(hasValue)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});
