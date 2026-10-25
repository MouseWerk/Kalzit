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

/**
 * Binary by content, never by name or signature (several signatures are plain ASCII that a text
 * file may start with): a NUL byte in the first 8 KB. Everything else is text and is checked
 * whatever it is called; text that is not valid UTF-8 fails its own test instead of being skipped.
 */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Text files below `dir`, paths relative to the UI root; binary files are left out. */
function textFiles(dir: string): { path: string; bytes: Uint8Array; text: string }[] {
  return walk(dir).flatMap((path) => {
    const bytes = readFileSync(path);
    return isBinary(bytes)
      ? []
      : [
          {
            path: relative(UI_ROOT, path).replaceAll("\\", "/"),
            bytes,
            text: bytes.toString("utf8"),
          },
        ];
  });
}

const sourceFiles = textFiles(SRC);

/**
 * The opening JSX tags whose class list holds `truncate`, with their line. The tag ends at the
 * first `>` outside braces, so `onClick={() => ...}` does not end it early.
 */
function truncatedTags(text: string): { line: number; text: string }[] {
  const tags: { line: number; text: string }[] = [];
  for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const classes = match[1] ?? match[2] ?? match[3] ?? "";
    if (!/(^|\s)truncate(\s|$)/.test(classes)) {
      continue;
    }
    const start = text.lastIndexOf("<", match.index);
    let depth = 0;
    let end = start;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        end = i;
        break;
      }
    }
    tags.push({ line: text.slice(0, start).split("\n").length, text: text.slice(start, end + 1) });
  }
  return tags;
}

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
  const checkedFiles = [...sourceFiles, ...textFiles(resolve(UI_ROOT, "public"))];

  it("keeps every file that is not binary in UTF-8", () => {
    const offenders = checkedFiles.filter(({ bytes }) => !isUtf8(bytes)).map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("contains no emoji", () => {
    for (const { path, text } of checkedFiles) {
      expect(/\p{Extended_Pictographic}/u.test(text), path).toBe(false);
    }
  });

  it("skips only files that are binary by content", () => {
    const text = (value: string) => new TextEncoder().encode(value);
    const fonts = resolve(SRC, "assets/fonts");
    const woff2 = readdirSync(fonts).filter((name) => name.endsWith(".woff2"));
    expect(woff2.length).toBeGreaterThan(0);
    for (const name of woff2) {
      expect(isBinary(readFileSync(resolve(fonts, name))), name).toBe(true);
    }
    // A PNG signature followed by its IHDR chunk length.
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
    expect(isBinary(Uint8Array.of(...png))).toBe(true);
    expect(isBinary(text("plain\u0000text"))).toBe(true);
    // Text that starts like a binary signature is still text, and its emoji is still caught.
    expect(isBinary(text("GIF89a looks like an image header \u{1F600}"))).toBe(false);
    expect(isBinary(text("wOF2: notes on the font format \u{1F600}"))).toBe(false);
    expect(isBinary(text("wOFF RIFF export const a = 1;"))).toBe(false);
    expect(isBinary(text("/* fake.woff2 */ .a { content: '\u{1F600}'; }"))).toBe(false);
    expect(isBinary(text("<svg></svg>"))).toBe(false);
  });

  it("checks text with a stray non-UTF-8 byte instead of skipping it", () => {
    const withByte = (value: string) => Uint8Array.of(...new TextEncoder().encode(value), 0xff);
    const decoded = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");
    // A .ts file with one invalid byte: not skipped, flagged as not UTF-8, its fetch still found.
    const source = withByte('export const load = () => fetch("/api/x");\n');
    expect(isBinary(source)).toBe(false);
    expect(isUtf8(source)).toBe(false);
    expect(/\bfetch\(/.test(decoded(source))).toBe(true);
    // A .txt file with an emoji and an invalid byte: not skipped, and the emoji is still caught.
    const notes = withByte("notes \u{1F600}\n");
    expect(isBinary(notes)).toBe(false);
    expect(isUtf8(notes)).toBe(false);
    expect(/\p{Extended_Pictographic}/u.test(decoded(notes))).toBe(true);
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

  it("gives every element cut off with an ellipsis a title, so its full text can be read", () => {
    const offenders: string[] = [];
    for (const { path, text } of appCode.filter(({ path }) => path.endsWith(".tsx"))) {
      for (const tag of truncatedTags(text)) {
        if (!/\stitle=/.test(tag.text)) {
          offenders.push(`${path}:${tag.line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("finds truncated tags over several lines and with arrow functions in attributes", () => {
    const tags = truncatedTags(
      '<a\n  className="x truncate"\n  onClick={() => go()}\n  title={name}\n>{name}</a>\n<span className={`truncate`}>{y}</span>',
    );
    expect(tags.map((tag) => [tag.line, /\stitle=/.test(tag.text)])).toEqual([
      [1, true],
      [6, false],
    ]);
  });

  it("keeps the theme boot script in step with the theme module", () => {
    const boot = readFileSync(resolve(UI_ROOT, "public/theme-boot.js"), "utf8");
    expect(boot).toContain(`"${THEME_STORAGE_KEY}"`);
    const listed = /const themes = \[([^\]]*)\]/.exec(boot)?.[1] ?? "";
    expect(listed.split(",").map((theme) => theme.trim().replaceAll('"', ""))).toEqual([...THEMES]);
  });
});
