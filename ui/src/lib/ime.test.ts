import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isComposingKey } from "./ime";

describe("isComposingKey", () => {
  it("is true while composing, in either form, and for keyCode 229", () => {
    expect(isComposingKey({ isComposing: true })).toBe(true);
    expect(isComposingKey({ nativeEvent: { isComposing: true } })).toBe(true);
    // Some browsers report the confirming key after isComposing is already false.
    expect(isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
  });

  it("is false for a plain key", () => {
    expect(isComposingKey({ nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isComposingKey({})).toBe(false);
  });
});

const SRC = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = resolve(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** A key check for Enter or Escape: `key === "Enter"`, `key !== 'Escape'` or `case "Enter":`. */
const HANDLER = /(key\s*[!=]==\s*["'](Enter|Escape)["']|case\s+["'](Enter|Escape)["']\s*:)/g;
const GUARD = /isComposing|isComposingKey|keyCode\s*===\s*229/;
/** Lines around a check in which the composition guard has to stand. */
const REACH = 45;

describe("Enter and Escape handlers", () => {
  it("each check for input method composition near the key test", () => {
    const missing: string[] = [];
    for (const path of walk(SRC)) {
      if (!/\.tsx?$/.test(path) || /\.test\.tsx?$/.test(path)) {
        continue;
      }
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        HANDLER.lastIndex = 0;
        if (!HANDLER.test(line)) {
          return;
        }
        const near = lines.slice(Math.max(0, index - REACH), index + REACH + 1).join("\n");
        if (!GUARD.test(near)) {
          missing.push(`${relative(SRC, path).replaceAll("\\", "/")}:${index + 1}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });
});
