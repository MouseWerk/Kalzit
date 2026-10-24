import { afterEach, describe, expect, it } from "vitest";
import {
  applyTimeOverride,
  getTimeSettings,
  getUserTimeSettings,
  setTimeOverride,
  setTimeZone,
  setWeekStart,
} from "./timeSettings";

afterEach(() => {
  setTimeOverride(null);
  setTimeZone(null);
  setWeekStart(null);
});

describe("a dashboard's time override", () => {
  it("applies over the user's settings while set and leaves them as they were", () => {
    setTimeZone("Europe/Berlin");
    setTimeOverride({ timeZone: "Asia/Tokyo", weekStart: "sunday", fiscalYearStartMonth: 4 });
    expect(getTimeSettings()).toEqual({
      timeZone: "Asia/Tokyo",
      weekStart: "sunday",
      fiscalYearStartMonth: 4,
    });
    expect(getUserTimeSettings()).toEqual({ timeZone: "Europe/Berlin", weekStart: null });
    setTimeOverride(null);
    expect(getTimeSettings()).toEqual({ timeZone: "Europe/Berlin", weekStart: null });
  });

  it("keeps the user's zone for a zone the browser does not know", () => {
    setTimeZone("Europe/Berlin");
    setTimeOverride({ timeZone: "Mars/Olympus_Mons" });
    expect(getTimeSettings().timeZone).toBe("Europe/Berlin");
    expect(
      applyTimeOverride({ timeZone: null, weekStart: null }, { timeZone: "Mars/Olympus_Mons" })
        .timeZone,
    ).toBeNull();
  });

  it("takes the browser's zone for null, whatever the user chose", () => {
    setTimeZone("Europe/Berlin");
    setTimeOverride({ timeZone: null });
    expect(getTimeSettings().timeZone).toBeNull();
  });
});
