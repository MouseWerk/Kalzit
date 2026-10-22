import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Field, Frame } from "../api/generated/shapes";
import { compile, DetailError, FIELD_TYPE_OF, parse, toCell } from "./expr";
import { asSteps, type NamedFrame, runSteps } from "./steps";

/**
 * The cases the server's engine passes too (`server/src/analysis/conformance.json`), so a panel
 * and its export show the same numbers.
 */
interface Cases {
  frames: Record<string, Field[]>;
  expressions: {
    frame: string;
    expression: string;
    type?: string;
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

function close(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-3);
  }
  return a === b;
}

function expectValues(got: readonly unknown[], want: readonly unknown[], what: string) {
  expect(got.length, what).toBe(want.length);
  got.forEach((g, i) => {
    expect(close(g, want[i]), `${what}[${i}]: ${String(g)} vs ${String(want[i])}`).toBe(true);
  });
}

describe("conformance with the server's engine", () => {
  it("reads the cases", () => {
    expect(cases.expressions.length).toBeGreaterThan(40);
    expect(cases.steps.length).toBeGreaterThan(15);
  });

  it.each(cases.expressions.map((c) => [c.expression, c] as const))("expression %s", (_, c) => {
    const f = frame(c.frame);
    const rows = f.fields[0]?.values.length ?? 0;
    try {
      const compiled = compile(parse(c.expression), f.fields);
      expect(c.error, "expected an error").toBeUndefined();
      const got = Array.from({ length: rows }, (_, row) =>
        toCell(compiled.result, compiled.eval(row)),
      );
      expectValues(got, c.values ?? [], c.expression);
      expect(compiled.result === "null" ? "number" : FIELD_TYPE_OF[compiled.result]).toBe(c.type);
    } catch (e) {
      if (!(e instanceof DetailError) || c.error === undefined) throw e;
      expect(e.detail.reason).toBe(c.error.reason);
      expect(e.detail.params).toEqual(c.error.params);
    }
  });

  it.each(cases.steps.map((c) => [c.name, c] as const))("steps: %s", (_, c) => {
    const frames: NamedFrame[] = Object.entries(c.frames).map(([name, source]) => ({
      name,
      frame: frame(source),
    }));
    const run = runSteps(asSteps(c.steps), frames);
    if (c.error !== undefined) {
      expect(run.failed?.index).toBe(c.error.index);
      expect(run.failed?.error.reason).toBe(c.error.reason);
      expect(run.failed?.error.params).toEqual(c.error.params);
      return;
    }
    expect(run.failed).toBeUndefined();
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
    for (const gone of c.gone ?? []) {
      expect(run.frames.some((f) => f.name === gone)).toBe(false);
    }
  });
});
