import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, THEMES } from "./theme/theme";

/** Rules over the source tree that a reviewer would otherwise have to remember. */

const UI_ROOT = resolve(import.meta.dirname, "..");
const SRC = resolve(UI_ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Binary assets (the bundled fonts) are not text; their bytes would match any text rule by chance.
const BINARY = /\.(woff2?|ttf|otf|png|jpe?g|gif|webp|ico)$/i;

const sourceFiles = walk(SRC)
  .filter((path) => !BINARY.test(path))
  .map((path) => ({
    path: relative(UI_ROOT, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));

const isTestCode = (path: string) => /\.test\.tsx?$/.test(path) || path.startsWith("src/test/");
const appCode = sourceFiles.filter(({ path }) => /\.(ts|tsx)$/.test(path) && !isTestCode(path));

describe("index.html", () => {
  const html = readFileSync(resolve(UI_ROOT, "index.html"), "utf8");

  it("has no inline script, so the CSP can stay script-src 'self'", () => {
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
      expect(tag, "every script needs a src").toMatch(/\bsrc="/);
    }
    for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(body?.trim(), "a script with a src has no body").toBe("");
    }
  });

  it("has no inline style or event handler attributes", () => {
    expect(/<style\b/i.test(html)).toBe(false);
    expect(/\sstyle=/i.test(html)).toBe(false);
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("loads nothing from other hosts", () => {
    expect(/(src|href)="(https?:)?\/\//.test(html)).toBe(false);
  });
});

describe("network access", () => {
  it("goes through the API client only", () => {
    const offenders = appCode
      .filter(({ path }) => path !== "src/api/client.ts")
      .filter(({ text }) =>
        /\bfetch\(|XMLHttpRequest|new WebSocket\(|new EventSource\(|sendBeacon\(/.test(text),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});

describe("source hygiene", () => {
  it("contains no emoji", () => {
    const files = [
      ...sourceFiles,
      ...walk(resolve(UI_ROOT, "public")).map((path) => ({
        path,
        text: readFileSync(path, "utf8"),
      })),
    ];
    for (const { path, text } of files) {
      expect(/\p{Extended_Pictographic}/u.test(text), path).toBe(false);
    }
  });

  it("uses classes instead of inline styles, and never raw HTML", () => {
    for (const { path, text } of appCode) {
      expect(/\bstyle=\{/.test(text), `${path} uses a style prop`).toBe(false);
      expect(text.includes("dangerouslySetInnerHTML"), path).toBe(false);
    }
  });

  it("keeps the theme boot script in step with the theme module", () => {
    const boot = readFileSync(resolve(UI_ROOT, "public/theme-boot.js"), "utf8");
    expect(boot).toContain(`"${THEME_STORAGE_KEY}"`);
    const listed = /const themes = \[([^\]]*)\]/.exec(boot)?.[1] ?? "";
    expect(listed.split(",").map((theme) => theme.trim().replaceAll('"', ""))).toEqual([...THEMES]);
  });
});
