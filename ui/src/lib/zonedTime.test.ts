import { describe, expect, it } from "vitest";
import { startOfDay, startOfNextDay } from "../features/admin/components/format";
import { resolveRange, resolveTime, toLocalInput } from "../features/dashboards/timeRange";
import { timeTicks } from "../panels/timeseries/series";
import { setTimeZone } from "./timeSettings";
import { fromWall, wallOf } from "./zonedTime";

const HOUR = 3_600_000;
const BERLIN = { timeZone: "Europe/Berlin", weekStart: null };
const NEW_YORK = { timeZone: "America/New_York", weekStart: null };
// Europe leaves summer time on Sunday 2026-10-25 at 03:00 CEST (01:00 UTC).
const SUNDAY_NOON_BERLIN = Date.UTC(2026, 9, 25, 11); // 12:00 CET

describe("wall clock in a chosen time zone", () => {
  it("reads and builds times on both sides of a daylight saving change", () => {
    expect(wallOf(Date.UTC(2026, 9, 24, 22), "Europe/Berlin")).toMatchObject({ day: 25, hour: 0 });
    const midnight = { hour: 0, minute: 0, second: 0, millisecond: 0 };
    expect(fromWall({ year: 2026, month: 10, day: 25, ...midnight }, "Europe/Berlin")).toBe(
      Date.UTC(2026, 9, 24, 22),
    );
    expect(fromWall({ year: 2026, month: 10, day: 26, ...midnight }, "Europe/Berlin")).toBe(
      Date.UTC(2026, 9, 25, 23),
    );
    // 02:30 happens twice that night; the first is meant.
    expect(
      fromWall(
        { year: 2026, month: 10, day: 25, ...midnight, hour: 2, minute: 30 },
        "Europe/Berlin",
      ),
    ).toBe(Date.UTC(2026, 9, 25, 0, 30));
    // 02:30 on 2026-03-29 does not exist; it moves past the gap, as Date does.
    expect(
      fromWall(
        { year: 2026, month: 3, day: 29, ...midnight, hour: 2, minute: 30 },
        "Europe/Berlin",
      ),
    ).toBe(Date.UTC(2026, 2, 29, 1, 30));
  });
});

describe("time ranges in the chosen zone", () => {
  it("rounds today to the zone's midnight, 25 hours on the day summer time ends", () => {
    const today = resolveRange({ from: "now/d", to: "now/d" }, SUNDAY_NOON_BERLIN, BERLIN);
    expect(today).toEqual({
      ok: true,
      range: { from: Date.UTC(2026, 9, 24, 22), to: Date.UTC(2026, 9, 25, 23) - 1 },
    });
    // The same instant is Sunday morning in New York, whose day has 24 hours: America leaves
    // summer time a week later.
    const there = resolveRange({ from: "now/d", to: "now/d" }, SUNDAY_NOON_BERLIN, NEW_YORK);
    expect(there).toEqual({
      ok: true,
      range: { from: Date.UTC(2026, 9, 25, 4), to: Date.UTC(2026, 9, 26, 4) - 1 },
    });
  });

  it("keeps the wall-clock time for days back across the change", () => {
    // Sunday 12:00 CET minus a day is Saturday 12:00 CEST: 25 hours earlier.
    expect(resolveTime("now-1d", SUNDAY_NOON_BERLIN, false, BERLIN)).toBe(
      SUNDAY_NOON_BERLIN - 25 * HOUR,
    );
  });

  it("starts the week on the chosen day, at midnight in the zone", () => {
    const monday = resolveTime("now/w", SUNDAY_NOON_BERLIN, false, BERLIN);
    expect(monday).toBe(Date.UTC(2026, 9, 18, 22)); // Monday 2026-10-19 00:00 CEST
    const sunday = resolveTime("now/w", SUNDAY_NOON_BERLIN, false, {
      timeZone: "Europe/Berlin",
      weekStart: "sunday",
    });
    expect(sunday).toBe(Date.UTC(2026, 9, 24, 22)); // Sunday 2026-10-25 00:00 CEST
  });

  it("reads typed dates and times on the zone's wall clock", () => {
    expect(resolveTime("2026-10-25", 0, false, NEW_YORK)).toBe(Date.UTC(2026, 9, 25, 4));
    expect(resolveTime("2026-10-25T08:30", 0, false, NEW_YORK)).toBe(Date.UTC(2026, 9, 25, 12, 30));
    // An explicit offset wins over the zone.
    expect(resolveTime("2026-10-25T08:30Z", 0, false, NEW_YORK)).toBe(Date.UTC(2026, 9, 25, 8, 30));
    expect(resolveTime("2026-02-30", 0, false, NEW_YORK)).toBeNull();
    expect(resolveTime("2026-10-25T25:00", 0, false, NEW_YORK)).toBeNull();
  });

  it("fills datetime-local inputs and day ticks in the zone", () => {
    setTimeZone("America/New_York");
    expect(toLocalInput(Date.UTC(2026, 9, 25, 12, 30))).toBe("2026-10-25T08:30");
    const { ticks } = timeTicks(Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 27), 8);
    expect(ticks.every((t) => wallOf(t).hour === 0)).toBe(true);
    expect(ticks.length).toBeGreaterThan(5);
  });

  it("filters the audit log by whole days in the zone, 25 hours on the change", () => {
    expect(startOfDay("2026-10-25", "Europe/Berlin")).toBe(Date.UTC(2026, 9, 24, 22));
    expect(startOfNextDay("2026-10-25", "Europe/Berlin")).toBe(Date.UTC(2026, 9, 25, 23));
    expect(startOfDay("2026-10-25", "America/New_York")).toBe(Date.UTC(2026, 9, 25, 4));
  });
});
