import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RE2JS } from "re2js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { findMapping } from "./fieldConfig";
import { compilePattern, loadPatternEngine } from "./pattern";

/**
 * The pattern cases the server checks as well (`panel_options::tests::patterns_agree_with_the_ui`):
 * a pattern is accepted only when re2js and the Rust `regex` crate both compile it and read it
 * alike, so the editor and the server never disagree about one.
 */
const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../../server/src/dashboards/pattern_fixture.json"),
    "utf8",
  ),
) as { pattern: string; valid: boolean }[];

beforeAll(async () => {
  await loadPatternEngine();
});

describe("pattern syntax", () => {
  it("agrees with the server on every shared case", () => {
    expect(cases.length).toBeGreaterThan(300);
    const wrong = cases
      .filter(({ pattern, valid }) => (compilePattern(pattern) !== null) !== valid)
      .map(({ pattern, valid }) => `${pattern}: expected ${valid}`);
    expect(wrong).toEqual([]);
  });

  it("tests each distinct value once per pattern", () => {
    const test = vi.spyOn(RE2JS.prototype, "test");
    const mappings = [{ type: "regex" as const, pattern: "^web-\\d+$", text: "Web" }];
    const values = Array.from({ length: 3000 }, (_, i) => ["web-1", "web-2", "db-1"][i % 3]);
    for (const value of values) findMapping(value, mappings);
    expect(test).toHaveBeenCalledTimes(3);
    test.mockRestore();
  });
});
