import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AREA_LOADERS, DEFERRED_AREAS } from "./deferred";
import {
  catalogs,
  forgetAreas,
  loadAllLanguages,
  loadArea,
  loadLanguage,
  setLanguage,
  translate,
} from "./i18n";

/**
 * The areas whose texts load with their pages (deferred.ts). The setup loads every area before
 * a test runs, as it loads both languages; these tests take that away again and load them the
 * way a page does, and one reads the sources, since loaded texts would hide a key used where
 * its area has not been asked for.
 */

const SRC = resolve(import.meta.dirname, "..");

/** German as a fresh page has it: not loaded, and no area asked for yet. */
function startOver(): void {
  delete catalogs.de;
  forgetAreas();
}

/** A loader that answers when the test says so. */
function held<T>(value: () => T) {
  let release = () => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  return { load: () => gate.then(value), release };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setLanguage("en");
  await loadAllLanguages();
  await Promise.all(DEFERRED_AREAS.map(loadArea));
});

describe("areas that load with their pages", () => {
  it("joins a language that is still on its way, so no page shows raw keys", async () => {
    const texts = await AREA_LOADERS.sharing.de();
    startOver();
    // The area's chunk arrives late: long after the language began to load.
    const chunk = held(() => texts);
    vi.spyOn(AREA_LOADERS.sharing, "de").mockImplementation(chunk.load);
    const language = loadLanguage("de");
    // A page asks for its area while the language is on its way.
    const area = loadArea("sharing");
    chunk.release();
    await Promise.all([language, area]);
    expect(catalogs.de?.["sharing.done"]).toBe("Fertig");
    expect(translate("de", "sharing.done")).toBe("Fertig");
  });

  it("joins a language whose load began before the area was asked for", async () => {
    startOver();
    const language = loadLanguage("de");
    await language;
    // Loaded without the area; the page that needs it asks now.
    expect(catalogs.de?.["sharing.done"]).toBeUndefined();
    await loadArea("sharing");
    expect(catalogs.de?.["sharing.done"]).toBe("Fertig");
    // And the other area stays out until a page of it is opened.
    expect(catalogs.de?.["provisioning.open"]).toBeUndefined();
  });

  it("comes along when the language is switched later", async () => {
    startOver();
    // Only English is loaded when the page opens; German follows with the switch.
    await loadArea("sharing");
    expect(catalogs.de).toBeUndefined();
    setLanguage("de");
    await loadLanguage("de");
    expect(translate("de", "sharing.done")).toBe("Fertig");
    expect(translate("en", "sharing.done")).toBe("Done");
  });

  it("reports a chunk that fails to who asked, keeps the language, and can be tried again", async () => {
    startOver();
    const failing = vi
      .spyOn(AREA_LOADERS.sharing, "de")
      .mockRejectedValueOnce(new Error("chunk gone"))
      .mockRejectedValueOnce(new Error("chunk gone"));
    // The language loads although one of its areas did not.
    const asked = loadArea("sharing");
    const german = await loadLanguage("de");
    await asked;
    expect(german["common.retry"]).toBe("Erneut versuchen");
    // The page that needs the area hears of the failure.
    await expect(loadArea("sharing")).rejects.toThrow("chunk gone");
    expect(catalogs.de?.["sharing.done"]).toBeUndefined();
    // The next attempt fetches again.
    failing.mockRestore();
    await loadArea("sharing");
    expect(catalogs.de?.["sharing.done"]).toBe("Fertig");
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("keys of a deferred area", () => {
  // Modules of an area that load outside its gate: other pages import them directly, before
  // anyone asked for the area's texts.
  const UNGATED = new Set([
    "features/provisioning/Managed.tsx",
    "features/provisioning/importNotice.ts",
    "features/provisioning/api.ts",
    "features/sharing/api.ts",
  ]);

  it.each(DEFERRED_AREAS)("%s: are used only behind the area's gate", async (area) => {
    const keys = new Set(Object.keys(await AREA_LOADERS[area].en()));
    expect(keys.size).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const path of sources(SRC)) {
      const name = relative(SRC, path).replaceAll("\\", "/");
      const gated = name.startsWith(`features/${area}/`) && !UNGATED.has(name);
      if (gated || name.startsWith("i18n/") || name.includes("/test/")) continue;
      const text = readFileSync(path, "utf8");
      for (const [, literal] of text.matchAll(/["'`]([a-z][\w.]+)["'`]/g)) {
        if (literal !== undefined && keys.has(literal)) {
          offenders.push(`${name}: ${literal}`);
        }
      }
      // A key built at run time (`sharing.reason.${code}`) cannot be told from here: none at all.
      if (new RegExp(`["'\`]${area}\\.[\\w.]*\\$\\{`).test(text)) {
        offenders.push(`${name}: a key built from "${area}."`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the ungated modules exist, so the list above is not stale", () => {
    for (const name of UNGATED) {
      expect(() => readFileSync(join(SRC, name), "utf8"), name).not.toThrow();
    }
  });
});
