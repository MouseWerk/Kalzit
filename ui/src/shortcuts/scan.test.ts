import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** The app's source files outside the registry and outside tests. */
function sources(): { path: string; lines: string[] }[] {
  return walk(SRC)
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
    .map((path) => ({ path: relative(SRC, path).replaceAll("\\", "/"), lines: [] as string[] }))
    .filter(({ path }) => !path.startsWith("shortcuts/"))
    .map(({ path }) => ({ path, lines: readFileSync(resolve(SRC, path), "utf8").split("\n") }));
}

function offending(pattern: RegExp): string[] {
  const found: string[] = [];
  for (const { path, lines } of sources()) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        found.push(`${path}:${index + 1}`);
      }
    });
  }
  return found;
}

/**
 * Board Shortcuts, frame 11: every shortcut comes from the registry, so the help, the key caps
 * and `aria-keyshortcuts` can never drift from what the code does.
 */
describe("shortcuts outside the registry", () => {
  it("never write aria-keyshortcuts by hand", () => {
    // shortcutProps(id) or shortcutAria(id) instead.
    expect(offending(/aria-keyshortcuts\s*=\s*(?:["']|\{\s*["'`])/)).toEqual([]);
  });

  it("never compare a pressed character or letter key with a literal", () => {
    // `event.key === "p"`, `key.toLowerCase() !== "s"`, `event.code === "KeyJ"`: a shortcut on a
    // character key is a registry entry matched with matchesShortcut. Space and named keys
    // (Enter, Escape, the arrows of a widget's own navigation) are not characters of a shortcut.
    const character = /\.key(?:\.to(?:Lower|Upper)Case\(\))?\s*[!=]==?\s*["'][^"'\s]["']/;
    const physical = /\.code\s*[!=]==?\s*["'](?:Key[A-Z]|Digit\d)["']/;
    expect(offending(character)).toEqual([]);
    expect(offending(physical)).toEqual([]);
  });

  it("keep key names out of the catalog texts", () => {
    // Keys go into a text through a slot (KeysInText, shortcutText, shortcutSpoken), so they
    // follow the language and the platform.
    const keys = /(?:Strg|Ctrl|Cmd|Alt|Umschalt|Shift)\+|[⌘⌥⇧⌃]|\bEsc(?:ape)?\b/;
    const found: string[] = [];
    for (const language of ["de", "en"]) {
      const dir = resolve(SRC, "i18n", language);
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        if (name === "shortcuts.json") {
          continue;
        }
        const catalog = JSON.parse(readFileSync(resolve(dir, name), "utf8")) as Record<
          string,
          string
        >;
        for (const [key, text] of Object.entries(catalog)) {
          if (keys.test(text)) {
            found.push(`${language}/${name}: ${key}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
