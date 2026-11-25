import { describe, expect, it } from "vitest";
import { levelFromText, normalizeLevel } from "./levels";

describe("level normalization", () => {
  it("reads the words of every source as one of seven levels, without regard to case", () => {
    const cases: [unknown, string][] = [
      ["CRITICAL", "critical"],
      ["fatal", "critical"],
      ["Emerg", "critical"],
      ["alert", "critical"],
      ["panic", "critical"],
      ["error", "error"],
      ["ERR", "error"],
      ["eror", "error"],
      ["warn", "warning"],
      ["Warning", "warning"],
      ["info", "info"],
      ["information", "info"],
      ["notice", "info"],
      ["debug", "debug"],
      ["dbg", "debug"],
      ["trace", "trace"],
      [" info ", "info"],
    ];
    for (const [value, level] of cases) {
      expect(normalizeLevel(value), String(value)).toBe(level);
    }
  });

  it("reads syslog numbers 0 to 7, as numbers and as text", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(normalizeLevel)).toEqual([
      "critical",
      "critical",
      "critical",
      "error",
      "warning",
      "info",
      "info",
      "debug",
    ]);
    expect(normalizeLevel("3")).toBe("error");
    expect(normalizeLevel(8)).toBe("unknown");
    expect(normalizeLevel(2.5)).toBe("unknown");
  });

  it("calls everything else unknown", () => {
    for (const value of ["", "loud", "denied", null, undefined, {}, true]) {
      expect(normalizeLevel(value)).toBe("unknown");
    }
  });

  it("finds a level in the text: a level key first, else a level word in capitals", () => {
    expect(levelFromText('level=warn app=api msg="slow query"')).toEqual({
      level: "warning",
      raw: "warn",
    });
    expect(levelFromText('{"msg":"x","level":"error"}')?.level).toBe("error");
    expect(levelFromText("severity: 3 disk almost full")?.level).toBe("error");
    expect(levelFromText("2026-11-24 14:37:12 [WARN] pool at 90 %")?.level).toBe("warning");
    expect(levelFromText("ERROR payment declined")?.level).toBe("error");
    // A lower-case word in the message is no level; the key wins over a word later on.
    expect(levelFromText("no error here")).toBeNull();
    expect(levelFromText("level=info retried after ERROR")?.level).toBe("info");
    expect(levelFromText("health ok")).toBeNull();
  });
});
