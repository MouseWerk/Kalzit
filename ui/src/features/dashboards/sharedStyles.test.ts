import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jsdom applies no stylesheets, so this checks the wiring: a dashboards module that other areas
 * render (the dialog, the time range picker, Inspect, the panel body) must import the stylesheet
 * its classes come from. Otherwise it is unstyled until a dashboard page happened to load it;
 * Explore's "Add to dashboard" dialog showed up as plain text below the page.
 */
const SRC = resolve(import.meta.dirname, "../..");
const FEATURE = resolve(SRC, "features/dashboards");
const SHEET = resolve(FEATURE, "dashboards.css");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Modules of the dashboards feature that files outside it import. */
function sharedModules(): string[] {
  const shared = new Set<string>();
  for (const file of sources(SRC)) {
    if (file.startsWith(FEATURE)) {
      continue;
    }
    for (const [, path] of readFileSync(file, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
      const target = resolve(dirname(file), path ?? "");
      if (target.startsWith(FEATURE)) {
        shared.add(`${target}.tsx`);
      }
    }
  }
  return [...shared].filter((path) => sources(FEATURE).includes(path));
}

const classesOf = (path: string) =>
  [...readFileSync(path, "utf8").matchAll(/\.([a-z][\w-]*)/g)].map(([, name]) => name);

// Classes of the global stylesheets (buttons, fields) are always there; dashboards.css only
// refines some of them in its own context.
const globalClasses = new Set(
  readdirSync(resolve(SRC, "styles"))
    .filter((name) => name.endsWith(".css"))
    .flatMap((name) => classesOf(resolve(SRC, "styles", name))),
);
const sheetClasses = new Set(classesOf(SHEET).filter((name) => !globalClasses.has(name)));

/** Class names in string literals of a module that dashboards.css defines. */
function classesFromSheet(source: string): string[] {
  // Every word of a className attribute, and BEM-like words (with - or _) of any other literal;
  // a plain word elsewhere is more likely a value ("dashboard" as a resource type).
  const attributes = [...source.matchAll(/className="([^"]*)"/g)].flatMap(([, text]) =>
    (text ?? "").split(" "),
  );
  const literals = [...source.matchAll(/["`]([a-z][\w -]*)["`]/g)]
    .flatMap(([, text]) => (text ?? "").split(" "))
    .filter((word) => /[-_]/.test(word));
  const words = [...attributes, ...literals];
  return [...new Set(words.filter((word) => sheetClasses.has(word)))];
}

describe("dashboard styles used by other areas", () => {
  const modules = sharedModules();

  it("finds the shared modules", () => {
    const names = modules.map((path) => relative(FEATURE, path).replaceAll("\\", "/"));
    expect(names).toEqual(expect.arrayContaining(["ui/Dialog.tsx", "TimeRangePicker.tsx"]));
  });

  it.each(modules.map((path) => [relative(FEATURE, path).replaceAll("\\", "/"), path]))(
    "%s imports the stylesheet of the classes it renders",
    (_, path) => {
      const source = readFileSync(path ?? "", "utf8");
      const used = classesFromSheet(source);
      if (used.length === 0) {
        return;
      }
      const sheet = relative(dirname(path ?? ""), SHEET).replaceAll("\\", "/");
      const specifier = sheet.startsWith(".") ? sheet : `./${sheet}`;
      expect(source, `uses ${used.join(", ")}`).toContain(`import "${specifier}";`);
    },
  );
});
