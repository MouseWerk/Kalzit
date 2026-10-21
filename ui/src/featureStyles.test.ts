import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listCssFiles, parseCss } from "./test/cssParse";

/**
 * jsdom applies no stylesheets, so this checks the wiring: every module that renders a class of a
 * feature stylesheet imports that sheet itself. Otherwise the part is unstyled until some other
 * page happened to load the sheet: Explore's dialog, and the query editor on a dashboard opened
 * directly, both showed up that way. Lazily loaded modules are covered like any other, since each
 * module must bring its own sheet.
 *
 * What counts as rendering a class: every word of a `className="..."` attribute, and every word
 * with `-` or `_` in another string or template literal (BEM names; a plain word elsewhere is more
 * likely a value). A template literal like `code-token--${kind}` counts by its static prefix.
 * Not covered: class names built by joining variables, which this cannot follow.
 */
const SRC = import.meta.dirname;
const rel = (path: string) => relative(SRC, path).replaceAll("\\", "/");

function modules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" || entry.name === "generated" ? [] : modules(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function classesOf(css: string): Set<string> {
  const names = new Set<string>();
  for (const rule of parseCss(css)) {
    for (const [, name] of rule.selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      names.add(name ?? "");
    }
  }
  return names;
}

const sheets = listCssFiles(SRC).map((path) => resolve(SRC, path));
const globalSheets = sheets.filter((path) => rel(path).startsWith("styles/"));
const featureSheets = sheets.filter((path) => !rel(path).startsWith("styles/"));
// Buttons, fields and the like are always loaded; a feature sheet only refines them in context.
const globalClasses = new Set(
  globalSheets.flatMap((path) => [...classesOf(readFileSync(path, "utf8"))]),
);
const sheetClasses = new Map(
  featureSheets.map((path) => [
    path,
    new Set([...classesOf(readFileSync(path, "utf8"))].filter((name) => !globalClasses.has(name))),
  ]),
);

/** Class names a module renders, and static prefixes of names it builds (ending in `-`). */
function renderedClasses(source: string): { names: string[]; prefixes: string[] } {
  const words = new Set<string>();
  const prefixes = new Set<string>();
  for (const [, text] of source.matchAll(/className="([^"]*)"/g)) {
    for (const word of (text ?? "").split(/\s+/)) {
      words.add(word);
    }
  }
  for (const [, text, interpolation] of source.matchAll(/["'`]([a-z][\w -]*)(\$\{)?/g)) {
    const parts = (text ?? "").split(/\s+/);
    // `name--${x}`: the last word is only the start of the names it builds. A lone `word-${x}`
    // is more often an id (`panel-${n}`); it counts with a class beside it (`a series-${i}`).
    const built = interpolation !== undefined;
    if (built && parts.length === 1 && !/(--|__)$/.test(parts[0] ?? "")) {
      continue;
    }
    parts.forEach((word, index) => {
      if (!/[-_]/.test(word)) {
        return;
      }
      if (built && index === parts.length - 1) {
        prefixes.add(word);
      } else {
        words.add(word);
      }
    });
  }
  return { names: [...words].filter((word) => word !== ""), prefixes: [...prefixes] };
}

/** A relative module specifier as a file: the path itself, with an extension, or an index. */
function resolveModule(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

/**
 * The stylesheets loaded whenever a module is: those it imports and, through static imports
 * (not `import type`, not a dynamic `import()`), those of every module it imports. A lazily
 * loaded module is checked on its own, so it has to bring its sheet itself.
 */
function loadedSheets(path: string, seen = new Set<string>()): Set<string> {
  if (seen.has(path)) {
    return seen;
  }
  seen.add(path);
  const source = readFileSync(path, "utf8");
  for (const [, spec] of source.matchAll(
    /^(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?"(\.[^"]+)";/gm,
  )) {
    const target = spec?.endsWith(".css")
      ? resolve(dirname(path), spec)
      : resolveModule(path, spec ?? "");
    if (target !== undefined && !seen.has(target)) {
      if (target.endsWith(".css")) {
        seen.add(target);
      } else {
        loadedSheets(target, seen);
      }
    }
  }
  return seen;
}

describe("feature stylesheets", () => {
  it("are found, the query editors' own one included", () => {
    expect(featureSheets.map(rel)).toEqual(
      expect.arrayContaining([
        "features/dashboards/dashboards.css",
        "features/datasources/editors/editors.css",
        "panels/panels.css",
      ]),
    );
  });

  it("finds classes in attributes, literals and built names", () => {
    const sample = [
      'x className="dialog dialog--small"',
      'y "query-editor__step"',
      "`code-token code-token--$" + "{k}`",
      "`panel-$" + "{n}`",
      '"plain"',
    ].join(" ");
    const found = renderedClasses(sample);
    expect(found.names).toEqual(
      expect.arrayContaining(["dialog", "dialog--small", "query-editor__step", "code-token"]),
    );
    expect(found.names).not.toContain("plain");
    expect(found.prefixes).toEqual(["code-token--"]);
  });

  const all = modules(SRC);
  it.each(all.map((path) => [rel(path), path]))(
    "%s loads the sheets of the classes it renders",
    (_, path) => {
      const source = readFileSync(path ?? "", "utf8");
      const { names, prefixes } = renderedClasses(source);
      const imported = [...loadedSheets(path ?? "")];
      const missing: string[] = [];
      for (const name of names) {
        const owners = featureSheets.filter((sheet) => sheetClasses.get(sheet)?.has(name));
        if (owners.length > 0 && !owners.some((sheet) => imported.includes(sheet))) {
          missing.push(`${name} (${owners.map(rel).join(" or ")})`);
        }
      }
      for (const prefix of prefixes) {
        const owners = featureSheets.filter((sheet) =>
          [...(sheetClasses.get(sheet) ?? [])].some((name) => name.startsWith(prefix)),
        );
        if (owners.length > 0 && !owners.some((sheet) => imported.includes(sheet))) {
          missing.push(`${prefix}* (${owners.map(rel).join(" or ")})`);
        }
      }
      expect(missing).toEqual([]);
    },
  );
});
