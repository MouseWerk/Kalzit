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

/** Handlers for Enter or Escape that are not about text an input method may be composing. */
const NOT_TEXT_INPUT = new Set([
  // Arrow keys and Enter on a graph node (a canvas, no text field).
  "panels/graph/GraphPanel.tsx",
  // Enter and Space on the arrange handle (a button).
  "features/dashboards/PanelCard.tsx",
]);

describe("Enter and Escape handlers", () => {
  it("check for input method composition in every file that handles them", () => {
    const missing = walk(SRC)
      .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return (
          /key === "(Enter|Escape)"/.test(text) &&
          !/isComposing|isComposingKey|keyCode === 229/.test(text)
        );
      })
      .map((path) => relative(SRC, path).replaceAll("\\", "/"))
      .filter((path) => !NOT_TEXT_INPUT.has(path));
    expect(missing).toEqual([]);
  });
});
