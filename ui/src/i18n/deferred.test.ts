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
  /**
   * The modules that may use an area's keys, one by one. Each is reached only through the area's
   * gate (`loadArea("<area>").then(() => import(...))`) or from another module of this list, so
   * its texts are there before it draws. A new module of an area is added here, or it may not
   * use the area's keys.
   */
  const GATED: Record<(typeof DEFERRED_AREAS)[number], readonly string[]> = {
    sharing: [
      "features/sharing/ShareDialog.tsx",
      "features/sharing/ShareDialogs.tsx",
      "features/sharing/SharesList.tsx",
      "features/sharing/SharesPage.tsx",
      "features/sharing/PublicPages.tsx",
      "features/sharing/SnapshotPage.tsx",
      "features/sharing/SharedBoard.tsx",
      "features/sharing/limits.ts",
      "features/sharing/model.ts",
    ],
    provisioning: [
      "features/provisioning/ManagedBadge.tsx",
      "features/provisioning/ProvisioningPage.tsx",
      "features/provisioning/GrafanaImportPage.tsx",
      "features/provisioning/ImportReport.tsx",
    ],
    reports: [
      "features/reports/ReportsPage.tsx",
      "features/reports/ReportEditorPage.tsx",
      "features/reports/ReportRunsPage.tsx",
      "features/reports/PreviewDialog.tsx",
      "features/reports/RecipientsField.tsx",
      "features/reports/shared.tsx",
      "features/reports/model.ts",
      "features/reports/reasons.ts",
    ],
    traces: [
      "panels/trace/TracePanel.tsx",
      "panels/trace/TraceList.tsx",
      "panels/trace/Waterfall.tsx",
      "panels/trace/SpanDetail.tsx",
      "features/datasources/editors/TraceQueryEditor.tsx",
      "analysis/TraceStepForm.tsx",
    ],
    serverAdmin: [
      "features/settings/CorsSection.tsx",
      "features/settings/RegistrationSection.tsx",
      "features/admin/org/Registrations.tsx",
      "auth/RegisterPage.tsx",
      "features/settings/BackupsSection.tsx",
    ],
    apps: [
      "features/plugins/apps/AppPage.tsx",
      "features/plugins/apps/OrgAppsSection.tsx",
      "features/plugins/apps/PluginAppCard.tsx",
      "features/plugins/apps/parts.tsx",
    ],
    map: ["panels/map/MapPanel.tsx", "panels/map/MapEditor.tsx"],
  };

  /**
   * The ways into each area (`loadArea("<area>").then(() => import(...))`), counted exactly: a
   * new one is added here, and one that went away is noticed.
   */
  const GATES: Record<(typeof DEFERRED_AREAS)[number], number> = {
    sharing: 8,
    provisioning: 5,
    reports: 4,
    traces: 4,
    serverAdmin: 5,
    apps: 5,
    // The map's panel and its editor.
    map: 2,
  };

  const files = sources(SRC).map((path) => ({
    name: relative(SRC, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));
  const names = new Set(files.map((file) => file.name));

  /** The module a relative import of `from` names, if it is one of the sources. */
  function resolved(from: string, specifier: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const base = join(from, "..", specifier).replaceAll("\\", "/");
    return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((name) => names.has(name));
  }

  it.each(DEFERRED_AREAS)("%s: are used only in the modules named as gated", async (area) => {
    const keys = new Set(Object.keys(await AREA_LOADERS[area].en()));
    expect(keys.size).toBeGreaterThan(20);
    const gated = new Set(GATED[area]);
    const offenders: string[] = [];
    for (const { name, text } of files) {
      if (gated.has(name) || name.startsWith("i18n/") || name.includes("/test/")) continue;
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

  it.each(DEFERRED_AREAS)("%s: gated modules are reached only through the gate", (area) => {
    const gated = new Set(GATED[area]);
    for (const name of gated) {
      expect(names.has(name), `${name} is named as gated and does not exist`).toBe(true);
    }
    const offenders: string[] = [];
    let gates = 0;
    for (const { name, text } of files) {
      // Value imports: a type-only import brings no code and needs no texts.
      for (const [statement, specifier] of text.matchAll(
        /^import\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gm,
      )) {
        const target = resolved(name, specifier ?? "");
        if (target !== undefined && gated.has(target) && !gated.has(name)) {
          offenders.push(`${name} imports ${target} outside the gate: ${statement.split("\n")[0]}`);
        }
      }
      // Lazy imports: each one right behind this area's `loadArea`.
      for (const match of text.matchAll(/import\("([^"]+)"\)/g)) {
        const target = resolved(name, match[1] ?? "");
        if (target === undefined || !gated.has(target)) continue;
        const before = text.slice(Math.max(0, (match.index ?? 0) - 80), match.index);
        if (new RegExp(`loadArea\\("${area}"\\)\\s*\\.then\\(\\(\\) =>\\s*$`).test(before)) {
          gates += 1;
        } else {
          offenders.push(`${name} imports ${target} without loadArea("${area}")`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // The walk found every gate, so it is not vacuous.
    expect(gates).toBe(GATES[area]);
  });
});
