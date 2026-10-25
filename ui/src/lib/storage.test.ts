import { afterEach, describe, expect, it } from "vitest";
import { removeRetiredPreferences } from "./storage";

afterEach(() => window.localStorage.clear());

describe("retired preferences", () => {
  it("removes the rail's folded state for every account and keeps the rest", () => {
    window.localStorage.setItem("kalzit.dashboardRail.u1", "collapsed");
    window.localStorage.setItem("kalzit.dashboardRail.u2", "open");
    window.localStorage.setItem("kalzit.sidebar", "collapsed");
    removeRetiredPreferences();
    expect(window.localStorage.getItem("kalzit.dashboardRail.u1")).toBeNull();
    expect(window.localStorage.getItem("kalzit.dashboardRail.u2")).toBeNull();
    expect(window.localStorage.getItem("kalzit.sidebar")).toBe("collapsed");
  });
});
