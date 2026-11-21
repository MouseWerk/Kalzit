import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listCssFiles, stripComments } from "./test/cssParse";

/**
 * Kalzit must work in an air-gapped environment: the production page loads nothing from another
 * origin. Outside systems (data sources, AI, mail, sign-in providers, the plugin catalog, the
 * update check) are optional or configured by an admin, and are never part of the page itself.
 * See docs/guide/offline.md. The server's content security policy has its own test
 * (`net::tests::the_csp_allows_no_outside_origin`).
 */

const SRC_DIR = resolve(import.meta.dirname);
const UI_DIR = resolve(SRC_DIR, "..");

const OUTSIDE = /^\s*(?:https?:)?\/\//i;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Where a stylesheet fetches from: every `url(...)` argument and `@import` target. */
function cssResources(source: string): string[] {
  const css = stripComments(source);
  const urls = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)].map((m) => m[2] ?? "");
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)].map(
    (m) => m[1] ?? "",
  );
  return [...urls, ...imports];
}

describe("offline operation", () => {
  it("loads nothing from another origin in the production entry page", () => {
    const html = read(resolve(UI_DIR, "index.html")).replace(/<!--[\s\S]*?-->/g, "");
    const attributes = [
      ...html.matchAll(/\b(?:src|href|srcset|poster|action|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi),
    ].map((m) => m[1] ?? m[2] ?? "");
    expect(attributes.length).toBeGreaterThan(0);
    expect(attributes.filter((value) => OUTSIDE.test(value))).toEqual([]);
    // Nothing in the page tag soup either: no stylesheet, script or font from the internet.
    expect(html).not.toMatch(/<(?:link|script|img|iframe|source)\b[^>]*\bhttps?:\/\//i);
  });

  it("loads nothing from another origin in the stylesheets", () => {
    const names = listCssFiles(SRC_DIR);
    expect(names.length).toBeGreaterThan(5);
    const outside: string[] = [];
    for (const name of names) {
      for (const resource of cssResources(read(resolve(SRC_DIR, name)))) {
        if (OUTSIDE.test(resource)) {
          outside.push(`${name}: ${resource}`);
        }
      }
    }
    // The layer order file next to the page is a stylesheet, too.
    for (const resource of cssResources(read(resolve(UI_DIR, "public", "layers.css")))) {
      if (OUTSIDE.test(resource)) {
        outside.push(`public/layers.css: ${resource}`);
      }
    }
    expect(outside).toEqual([]);
  });

  it("recognises an outside resource in a stylesheet", () => {
    const css = `@import "https://fonts.example/x.css"; a { background: url(http://x.test/a.png) }
      /* url(https://in-a-comment.test/ok.png) */ b { background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>") }`;
    expect(cssResources(css).filter((r) => OUTSIDE.test(r))).toEqual([
      "http://x.test/a.png",
      "https://fonts.example/x.css",
    ]);
  });

  it("ships the licence text it links from About", () => {
    expect(read(resolve(UI_DIR, "public", "LICENSE.txt"))).toBe(
      read(resolve(UI_DIR, "..", "LICENSE")),
    );
  });
});
