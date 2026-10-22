import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The panel registry is part of every dashboard. What it loads statically ships with every
 * dashboard, so the graph panels' components, their renderer and the graph libraries must load
 * only with the first graph panel (lazy.tsx). This follows the static imports from the registry
 * as the bundler does: `import type` and dynamic `import()` do not count.
 */
const SRC = resolve(import.meta.dirname, "../..");

function resolveModule(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find(
    (path) => existsSync(path) && statSync(path).isFile(),
  );
}

function staticClosure(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (path: string) => {
    if (files.has(path)) return;
    files.add(path);
    const source = readFileSync(path, "utf8");
    for (const [, spec] of source.matchAll(
      /^(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?"([^"]+)";/gm,
    )) {
      if (spec === undefined || spec.endsWith(".css") || spec.endsWith(".json")) continue;
      if (spec.startsWith(".")) {
        const target = resolveModule(path, spec);
        if (target !== undefined) visit(target);
      } else {
        packages.add(spec);
      }
    }
  };
  visit(entry);
  return { files, packages };
}

describe("graph panel bundle", () => {
  const { files, packages } = staticClosure(resolve(SRC, "panels/registry.ts"));
  const loaded = [...files].map((path) => relative(SRC, path).replaceAll("\\", "/"));

  it("follows the registry's imports", () => {
    expect(loaded).toEqual(
      expect.arrayContaining(["panels/network/index.tsx", "panels/graph/options.ts"]),
    );
  });

  it("keeps the graph panels' components and libraries out of the registry's static imports", () => {
    const heavy = loaded.filter((path) =>
      /^panels\/(graph\/(GraphPanels?|GraphEditor|GraphTable|SigmaCanvas|metrics|layoutEngine)\.tsx?|path\/PathPanel\.tsx)$/.test(
        path,
      ),
    );
    expect(heavy).toEqual([]);
    expect([...packages].filter((name) => /^(sigma|graphology)/.test(name))).toEqual([]);
  });
});
