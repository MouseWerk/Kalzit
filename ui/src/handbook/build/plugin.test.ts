import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HANDBOOK_PAGES, type HandbookSlug } from "../catalog";
import { buildHandbook, checkAnchors } from "./plugin";

/**
 * The handbook as the build makes it from docs/ (decision 9): every page and picture there, both
 * languages matching section by section, and an index per language.
 */

const DOCS = resolve(import.meta.dirname, "../../../../docs");
const built = buildHandbook(DOCS);

describe("the handbook's content", () => {
  it("lists every page of the guide, in English and German", () => {
    const listed = new Set(HANDBOOK_PAGES.flatMap((page) => [page.en, page.de]));
    const files = (dir: string) =>
      readdirSync(join(DOCS, dir)).filter((name) => name.endsWith(".md"));
    for (const name of files("guide")) {
      expect(listed, `docs/guide/${name}`).toContain(`guide/${name}`);
    }
    for (const name of files("guide/de")) {
      expect(listed, `docs/guide/de/${name}`).toContain(`guide/de/${name}`);
    }
  });

  it("has a title for every page and German sections that match the English ones", () => {
    for (const page of built.pages) {
      expect(page.en.title, page.slug).not.toBe("");
      if (page.de !== undefined) {
        expect(
          page.de.headings.map((heading) => heading.level),
          page.slug,
        ).toEqual(page.en.headings.map((heading) => heading.level));
      }
    }
  });

  it("gives each heading of a page its own anchor", () => {
    for (const page of built.pages) {
      for (const version of [page.en, page.de]) {
        if (version === undefined) continue;
        const ids = version.headings.map((heading) => heading.id);
        expect(new Set(ids).size, version.file).toBe(ids.length);
      }
    }
  });

  it("ships only the pictures the pages show", () => {
    expect(built.images.length).toBeGreaterThan(20);
    expect(built.images.every((path) => path.startsWith("docs/screenshots/"))).toBe(true);
  });

  it("indexes both languages", () => {
    expect(built.search.en.entries.length).toBeGreaterThan(300);
    expect(built.search.de.entries.length).toBeGreaterThan(300);
    expect(built.search.de.entries.some((entry) => entry.h === "Bei null anfangen")).toBe(true);
  });

  it("names every page in the type the app's links use", () => {
    // A slug the type does not know cannot be linked from the app; one it knows must exist.
    const slugs: Record<HandbookSlug, true> = {
      overview: true,
      "getting-started": true,
      "query-languages": true,
      dashboards: true,
      panels: true,
      explore: true,
      "saved-analyses": true,
      "calculated-fields": true,
      traces: true,
      export: true,
      performance: true,
      alerting: true,
      "data-sources": true,
      arangodb: true,
      gremlin: true,
      couchbase: true,
      warehouses: true,
      sharing: true,
      reports: true,
      ai: true,
      plugins: true,
      administration: true,
      "account-security": true,
      provisioning: true,
      "grafana-import": true,
      installation: true,
      "linux-binary": true,
      https: true,
      "reverse-proxy": true,
      monitoring: true,
      backup: true,
      upgrading: true,
      offline: true,
      updates: true,
      "high-availability": true,
      winget: true,
      "sdk-typescript": true,
      "sdk-go": true,
      glossary: true,
    };
    expect(HANDBOOK_PAGES.map((page) => page.slug).sort()).toEqual(Object.keys(slugs).sort());
  });
});

describe("links to sections", () => {
  const backup = built.pages.find((page) => page.slug === "backup");
  const section = backup?.en.headings[1]?.id ?? "";
  const german = backup?.de?.headings[1]?.id ?? "";
  const check = (file: string, href: string) => () =>
    checkAnchors(built.pages, [{ file, hrefs: [href] }]);

  it("pass when the heading is there, in either language, or the target is no page of it", () => {
    expect(section).not.toBe("");
    expect(check("guide/backup.md", `#${section}`)).not.toThrow();
    expect(check("guide/explore.md", `backup.md#${section}`)).not.toThrow();
    expect(check("guide/de/explore.md", `backup.md#${german}`)).not.toThrow();
    expect(check("guide/explore.md", `backup.md#${german}`)).not.toThrow();
    expect(check("guide/explore.md", "../api/datasources.md#nowhere")).not.toThrow();
    expect(check("guide/explore.md", "https://example.com/#nowhere")).not.toThrow();
  });

  it("fail the build for a section no heading has", () => {
    expect(check("guide/backup.md", "#no-such-section")).toThrow(/backup has no such section/);
    expect(check("guide/explore.md", "backup.md#no-such-section")).toThrow(/guide\/explore\.md/);
    expect(check("guide/explore.md", "backup.md#%E0%A4%A")).toThrow(/no such section/);
  });
});
