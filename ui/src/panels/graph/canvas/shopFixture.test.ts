import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The e2e spec of the quick actions (e2e/graph-algorithms.spec.ts) walks the 3 shortest paths
 * from Ana to the monitor arm with J and Shift+J. That needs at least three loopless paths in the
 * graph it draws: the whole shop fixture, its category tree included (customers, orders and
 * products alone form a tree with one path). This reads the fixture and counts them.
 */

const FIXTURE = resolve(import.meta.dirname, "../../../../e2e/fixtures/graph-shop.cypher");

function shopGraph(): { names: Map<string, string>; edges: [string, string][] } {
  const text = readFileSync(FIXTURE, "utf8");
  const names = new Map<string, string>();
  for (const [, variable, name] of text.matchAll(/\((\w+):\w+ \{name: '([^']+)'/g)) {
    names.set(variable as string, name as string);
  }
  const edges: [string, string][] = [];
  for (const [, from, to] of text.matchAll(/\((\w+)\)-\[:\w+[^\]]*\]->\((\w+)\)/g)) {
    edges.push([from as string, to as string]);
  }
  return { names, edges };
}

/** Loopless paths between two nodes, ignoring direction, of at most `max` edges. */
function simplePaths(edges: readonly [string, string][], from: string, to: string, max: number) {
  const around = new Map<string, string[]>();
  for (const [a, b] of edges) {
    around.set(a, [...(around.get(a) ?? []), b]);
    around.set(b, [...(around.get(b) ?? []), a]);
  }
  const found: string[][] = [];
  const walk = (at: string, path: string[]) => {
    if (at === to) {
      found.push(path);
      return;
    }
    if (path.length > max) return;
    for (const next of around.get(at) ?? []) {
      if (!path.includes(next)) walk(next, [...path, next]);
    }
  };
  walk(from, [from]);
  return found;
}

describe("the shop fixture of the quick-action spec", () => {
  it("has at least three loopless paths from Ana to the monitor arm within 8 edges", () => {
    const { names, edges } = shopGraph();
    const id = (name: string) => [...names].find(([, n]) => n === name)?.[0] ?? "";
    expect(names.size).toBe(22);
    const paths = simplePaths(edges, id("Ana"), id("Monitor arm"), 8);
    expect(paths.length).toBeGreaterThanOrEqual(3);
    // Without the category tree there is exactly one, which is why the spec draws it.
    const shop = edges.filter(
      ([a, b]) =>
        !/^(allProducts|office|lighting|seating|desks)$/.test(b) &&
        !/^(allProducts|office)$/.test(a),
    );
    expect(simplePaths(shop, id("Ana"), id("Monitor arm"), 8)).toHaveLength(1);
  });
});
