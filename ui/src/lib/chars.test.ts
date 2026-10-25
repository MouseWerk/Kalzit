import { describe, expect, it } from "vitest";
import { clipChars } from "./chars";

describe("clipChars", () => {
  // U+1D538 (a letter outside the Basic Multilingual Plane): two UTF-16 units, one character.
  const wide = "\u{1D538}";

  it("counts characters as the server does, not UTF-16 units", () => {
    expect(clipChars(`ab${wide}${wide}`, 3)).toBe(`ab${wide}`);
    expect(clipChars(`${wide}${wide}`, 2)).toBe(`${wide}${wide}`);
    expect(clipChars("abc", 5)).toBe("abc");
    expect(clipChars("abc", 0)).toBe("");
  });

  it("never leaves a lone surrogate", () => {
    const clipped = clipChars(`a${wide}`, 2);
    expect(clipped).toBe(`a${wide}`);
    // No high surrogate without its low half.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipChars(`a${wide}b`, 2))).toBe(false);
  });
});
