import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocumentSet, Field, Frame, GraphSchema, GraphSet } from "../api/generated/shapes";
import type { WeekStart } from "../lib/timeSettings";
import { compile, DetailError, FIELD_TYPE_OF, parse, toCell, UTC_CALENDAR } from "./expr";
import { asSteps, type NamedInput, runSteps } from "./steps";

/**
 * The cases the server's engine passes too (`server/src/analysis/conformance.json`), so a panel
 * and its export show the same numbers.
 */
interface Cases {
  frames: Record<string, Field[]>;
  documents: Record<string, DocumentSet>;
  graphs: Record<string, GraphSet>;
  expressions: {
    frame: string;
    expression: string;
    type?: string;
    ulp?: boolean;
    calendar?: { timeZone?: string; weekStart?: WeekStart };
    values?: unknown[];
    error?: { reason: string; params: Record<string, string> };
  }[];
  steps: {
    name: string;
    frames: Record<string, string>;
    steps: unknown[];
    expect?: Record<
      string,
      { names?: string[]; fields: { name: string; type: string; values: unknown[] }[] }
    >;
    gone?: string[];
    expectGraphs?: Record<string, { nodes: string[]; edges: string[]; schema: GraphSchema }>;
    outputOrder?: string[];
    error?: { index: number; reason: string; params: Record<string, string> };
  }[];
}

const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../server/src/analysis/conformance.json"),
    "utf8",
  ),
) as Cases;

const frame = (name: string): Frame => ({
  fields: structuredClone(cases.frames[name] ?? []),
});

/** The bits of a double, to measure units in the last place. */
function bits(x: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return view.getBigInt64(0);
}

/**
 * Numbers agree exactly; a case marked `ulp` (exp, ln, log10, pow, whose platform libraries may
 * round the last bit differently) within one unit in the last place.
 */
function close(a: unknown, b: unknown, ulp: boolean): boolean {
  if (typeof a === "number" && typeof b === "number") {
    if (a === b) return true;
    if (!ulp || Math.sign(a) !== Math.sign(b)) return false;
    const d = bits(a) - bits(b);
    return d === 1n || d === -1n;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

function expectValues(
  got: readonly unknown[],
  want: readonly unknown[],
  what: string,
  ulp = false,
) {
  expect(got.length, what).toBe(want.length);
  got.forEach((g, i) => {
    expect(close(g, want[i], ulp), `${what}[${i}]: ${String(g)} vs ${String(want[i])}`).toBe(true);
  });
}

describe("conformance with the server's engine", () => {
  it("reads the cases", () => {
    expect(cases.expressions.length).toBeGreaterThan(40);
    expect(cases.steps.length).toBeGreaterThan(15);
  });

  const title = (c: Cases["expressions"][number]) =>
    c.calendar === undefined ? c.expression : `${c.expression} in ${JSON.stringify(c.calendar)}`;
  it.each(cases.expressions.map((c) => [title(c), c] as const))("expression %s", (_, c) => {
    const f = frame(c.frame);
    const rows = f.fields[0]?.values.length ?? 0;
    const calendar = { ...UTC_CALENDAR, ...c.calendar };
    try {
      const compiled = compile(parse(c.expression), f.fields, calendar);
      const got = Array.from({ length: rows }, (_, row) =>
        toCell(compiled.result, compiled.eval(row)),
      );
      expect(c.error, "expected an error").toBeUndefined();
      expectValues(got, c.values ?? [], c.expression, c.ulp === true);
      expect(compiled.result === "null" ? "number" : FIELD_TYPE_OF[compiled.result]).toBe(c.type);
    } catch (e) {
      if (!(e instanceof DetailError) || c.error === undefined) throw e;
      expect(e.detail.reason).toBe(c.error.reason);
      expect(e.detail.params).toEqual(c.error.params);
    }
  });

  it.each(cases.steps.map((c) => [c.name, c] as const))("steps: %s", (_, c) => {
    // Inputs in the order of their refIds sorted, as the server's JSON objects give them.
    const inputs: NamedInput[] = Object.entries(c.frames)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, source]) => {
        const set = cases.documents[source];
        const graph = cases.graphs[source];
        if (set !== undefined) return { name, documents: structuredClone(set) };
        if (graph !== undefined) return { name, graph: structuredClone(graph) };
        return { name, frame: frame(source) };
      });
    const run = runSteps(asSteps(c.steps), inputs);
    if (c.error !== undefined) {
      expect(run.failed?.index).toBe(c.error.index);
      expect(run.failed?.error.reason).toBe(c.error.reason);
      expect(run.failed?.error.params).toEqual(c.error.params);
      return;
    }
    expect(run.failed).toBeUndefined();
    if (c.outputOrder !== undefined) {
      expect(run.frames.map((f) => f.name)).toEqual(c.outputOrder);
    }
    for (const [name, want] of Object.entries(c.expect ?? {})) {
      const got = run.frames.find((f) => f.name === name)?.frame;
      expect(got, name).toBeDefined();
      if (want.names !== undefined) {
        expect(got?.fields.map((f) => f.name)).toEqual(want.names);
      }
      for (const field of want.fields) {
        const f = got?.fields.find((x) => x.name === field.name);
        expect(f?.type, field.name).toBe(field.type);
        expectValues(f?.values ?? [], field.values, `${c.name} ${field.name}`);
      }
    }
    for (const [name, want] of Object.entries(c.expectGraphs ?? {})) {
      const got = run.graphs.find((g) => g.name === name)?.graph;
      expect(got?.nodes.map((n) => n.id)).toEqual(want.nodes);
      expect(got?.edges.map((e) => e.id)).toEqual(want.edges);
      expect(got?.schema).toEqual(want.schema);
    }
    for (const gone of c.gone ?? []) {
      expect(run.frames.some((f) => f.name === gone)).toBe(false);
    }
  });
});
