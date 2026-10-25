import { describe, expect, it } from "vitest";
import { tabForKey } from "./tabKeys";

describe("tabForKey", () => {
  const tabs = ["result", "table", "json"] as const;

  it("steps with the arrows, wrapping around, and jumps with Home and End", () => {
    expect(tabForKey(tabs, "result", "ArrowRight")).toBe("table");
    expect(tabForKey(tabs, "json", "ArrowRight")).toBe("result");
    expect(tabForKey(tabs, "result", "ArrowLeft")).toBe("json");
    expect(tabForKey(tabs, "table", "Home")).toBe("result");
    expect(tabForKey(tabs, "table", "End")).toBe("json");
  });

  it("leaves other keys alone and works for any number of tabs", () => {
    expect(tabForKey(tabs, "table", "Enter")).toBeUndefined();
    expect(tabForKey(["a", "b", "c", "d"], "c", "ArrowRight")).toBe("d");
    expect(tabForKey([], "a", "Home")).toBeUndefined();
  });
});
