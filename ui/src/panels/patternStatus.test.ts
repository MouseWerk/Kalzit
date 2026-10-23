import { describe, expect, it } from "vitest";
import { isInvalidPattern, patternStatus } from "./fieldConfig/pattern";

/** Before re2js has loaded (this file never loads it first), the editor must not call a pattern valid. */
describe("pattern status while re2js loads", () => {
  it("tells the editor a pattern is being checked rather than calling it valid", () => {
    expect(patternStatus("^web-\\d+$")).toBe("checking");
    expect(isInvalidPattern("^web-\\d+$")).toBe(false);
    // What the shared syntax refuses is known without re2js.
    expect(patternStatus("(?x)a")).toBe("invalid");
    expect(patternStatus("")).toBe("valid");
  });
});
