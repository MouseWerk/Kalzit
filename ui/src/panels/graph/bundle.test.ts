import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The graph panels' code ships only with the first graph panel. This follows what the app loads
 * from its entry as the bundler does: static imports (a type-only `import type` aside, also when
 * mixed into one statement with values), and the pages the router loads on demand (`import()`
 * outside the panels). The lazy panel loaders in panels/ are what keeps the graph code out, so
 * their `import()` is not followed. Of the graph area, only an allowlist may be reached.
 */
const SRC = resolve(import.meta.dirname, "../..");
const rel = (path: string) => relative(SRC, path).replaceAll("\\", "/");

/** Graph-area modules that may load with every page: the panel descriptors and what they read. */
const ALLOWED = new Set([
  "panels/graph/options.ts",
  "panels/graph/adapter.ts",
  "panels/network/index.tsx",
  "panels/hierarchy/index.tsx",
  "panels/path/index.tsx",
]);
const GRAPH_AREA = /^panels\/(graph|network|hierarchy|path)\//;
const GRAPH_PACKAGES = /^(sigma|graphology)(\/|-|$)/;

function resolveModule(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
}

/** Specifiers a module loads: static imports and re-exports with a value, and `import()`. */
export function importsOf(source: string, followDynamic: boolean): string[] {
  const found: string[] = [];
  for (const [, rawClause, spec] of source.matchAll(
    /^(?:import|export)\s+([^"';]*?)\s*(?:from\s+)?"([^"]+)";/gm,
  )) {
    const clause = (rawClause ?? "").trim();
    // `import type { A } from` and `import { type A, type B } from` bring no code.
    const named = /^\{([^}]*)\}$/.exec(clause)?.[1];
    const typeOnly =
      /^type\s/.test(clause) ||
      named
        ?.split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .every((part) => part.startsWith("type "));
    if (!typeOnly && spec !== undefined) found.push(spec);
  }
  if (followDynamic) {
    for (const [, spec] of source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) {
      if (spec !== undefined) found.push(spec);
    }
  }
  return found;
}

function closure(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (path: string) => {
    if (files.has(path)) return;
    files.add(path);
    const source = readFileSync(path, "utf8");
    const followDynamic = !rel(path).startsWith("panels/");
    for (const spec of importsOf(source, followDynamic)) {
      if (/\.(css|json)$/.test(spec)) continue;
      if (spec.startsWith(".")) {
        const target = resolveModule(path, spec);
        if (target !== undefined) visit(target);
      } else {
        packages.add(spec);
      }
    }
  };
  visit(entry);
  return { files: [...files].map(rel), packages: [...packages] };
}

describe("graph panel bundle", () => {
  const { files, packages } = closure(resolve(SRC, "main.tsx"));

  it("follows the app from its entry into the pages and the panel registry", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "features/dashboards/DashboardPage.tsx",
        "features/explore/ExplorePage.tsx",
        "panels/registry.ts",
        "panels/graph/options.ts",
      ]),
    );
  });

  it("reaches only the allowlisted graph modules and no graph library", () => {
    expect(files.filter((path) => GRAPH_AREA.test(path) && !ALLOWED.has(path))).toEqual([]);
    expect(packages.filter((name) => GRAPH_PACKAGES.test(name))).toEqual([]);
  });

  it("reads mixed and type-only imports as the bundler does", () => {
    const source = [
      'import Graph, { type Attributes } from "graphology";',
      'import type { A } from "./types";',
      'import { type B, type C } from "./other";',
      'import { type D, value } from "./mixed";',
      'export { thing } from "./again";',
      'const later = () => import("./lazy");',
    ].join("\n");
    expect(importsOf(source, false)).toEqual(["graphology", "./mixed", "./again"]);
    expect(importsOf(source, true)).toContain("./lazy");
  });
});
