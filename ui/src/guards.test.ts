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

// Signatures of the binary formats the UI ships: woff2, woff, PNG, JPEG, GIF, WebP (RIFF), ICO.
const MAGIC = [
  [0x77, 0x4f, 0x46, 0x32],
  [0x77, 0x4f, 0x46, 0x46],
  [0x89, 0x50, 0x4e, 0x47],
  [0xff, 0xd8, 0xff],
  [0x47, 0x49, 0x46, 0x38],
  [0x52, 0x49, 0x46, 0x46],
  [0x00, 0x00, 0x01, 0x00],
];

/**
 * Binary by content, not by name: a known signature or a NUL byte in the first kilobyte. Binary
 * bytes would match text rules by chance; a text file with a binary extension is still checked.
 */
function isBinary(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  return MAGIC.some((magic) => magic.every((byte, i) => head[i] === byte)) || head.includes(0);
}

/** Text files below `dir`, paths relative to the UI root; binary files are left out. */
function textFiles(dir: string): { path: string; text: string }[] {
  return walk(dir).flatMap((path) => {
    const bytes = readFileSync(path);
    return isBinary(bytes)
      ? []
      : [{ path: relative(UI_ROOT, path).replaceAll("\\", "/"), text: bytes.toString("utf8") }];
  });
}

const sourceFiles = textFiles(SRC);

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
    const files = [...sourceFiles, ...textFiles(resolve(UI_ROOT, "public"))];
    for (const { path, text } of files) {
      expect(/\p{Extended_Pictographic}/u.test(text), path).toBe(false);
    }
  });

  it("skips only files that are binary by content", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const font = readFileSync(resolve(SRC, "assets/fonts/newsreader-latin-wght-normal.woff2"));
    expect(isBinary(font)).toBe(true);
    expect(isBinary(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))).toBe(true);
    expect(isBinary(text("plain\u0000text"))).toBe(true);
    // A text file is read whatever its name, so an emoji in a "fake.woff2" is still caught.
    expect(isBinary(text("/* fake.woff2 */ .a { content: '\u{1F600}'; }"))).toBe(false);
    expect(isBinary(text("<svg></svg>"))).toBe(false);
  });

  it("draws the favicon's stroke on the svg itself, so it shows without its style", () => {
    const svg = readFileSync(resolve(UI_ROOT, "public/favicon.svg"), "utf8");
    expect(/<svg\b[^>]*\sstroke="#[0-9a-f]{3,6}"/i.test(svg)).toBe(true);
    // The style may only switch the color for dark mode.
    const style = /<style>([\s\S]*?)<\/style>/.exec(svg)?.[1] ?? "";
    expect(
      style.replace(/@media \(prefers-color-scheme: dark\) \{[^{}]*\{[^{}]*\} \}/, "").trim(),
    ).toBe("");
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
