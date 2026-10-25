import { afterAll, describe, expect, it } from "vitest";
import {
  delayedNow,
  formatDuration,
  intervalFor,
  isRelative,
  parseDuration,
  presetOf,
  rangeFromClipboard,
  rangeToClipboard,
  resolveRange,
  resolveTime,
  shiftRange,
  zoomOutRange,
} from "./timeRange";

// Resolution follows the browser's time zone. A zone with daylight saving time makes the DST
// cases real; the clock is always passed in, never read.
// Set while the file is collected, since the describe blocks below compute times right away.
const previousZone = process.env.TZ;
process.env.TZ = "Europe/Berlin";

afterAll(() => {
  if (previousZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = previousZone;
  }
});

const HOUR = 3_600_000;
/** Local wall-clock time in Berlin, for readable expectations. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime();

describe("time zone setup", () => {
  it("runs in a zone with daylight saving time", () => {
    // Berlin is UTC+1 in winter and UTC+2 in summer.
    expect(new Date(Date.UTC(2026, 0, 15, 12)).getHours()).toBe(13);
    expect(new Date(Date.UTC(2026, 6, 15, 12)).getHours()).toBe(14);
  });
});

describe("resolveTime", () => {
  const now = local(2026, 10, 20, 14, 37, 12, 345);

  it("resolves now and fixed offsets", () => {
    expect(resolveTime("now", now)).toBe(now);
    expect(resolveTime("now-6h", now)).toBe(now - 6 * HOUR);
    expect(resolveTime("now-15m", now)).toBe(now - 15 * 60_000);
    expect(resolveTime("now+30s", now)).toBe(now + 30_000);
    expect(resolveTime(" now-1h ", now)).toBe(now - HOUR);
  });

  it("chains steps and rounds", () => {
    expect(resolveTime("now-1d-2h", now)).toBe(local(2026, 10, 19, 12, 37, 12, 345));
    expect(resolveTime("now/d", now)).toBe(local(2026, 10, 20));
    expect(resolveTime("now/d", now, true)).toBe(local(2026, 10, 20, 23, 59, 59, 999));
    expect(resolveTime("now-1d/d", now)).toBe(local(2026, 10, 19));
    expect(resolveTime("now/h", now)).toBe(local(2026, 10, 20, 14));
    expect(resolveTime("now/M", now)).toBe(local(2026, 10, 1));
    expect(resolveTime("now/y", now)).toBe(local(2026, 1, 1));
  });

  it("starts weeks on Monday", () => {
    // 2026-10-20 is a Tuesday.
    expect(resolveTime("now/w", now)).toBe(local(2026, 10, 19));
    expect(resolveTime("now/w", now, true)).toBe(local(2026, 10, 25, 23, 59, 59, 999));
    // A Sunday belongs to the week that started six days before.
    expect(resolveTime("now/w", local(2026, 10, 25, 9))).toBe(local(2026, 10, 19));
  });

  it("keeps the day when going back months, clamped to the month's end", () => {
    expect(resolveTime("now-1M", local(2026, 3, 31, 10))).toBe(local(2026, 2, 28, 10));
    expect(resolveTime("now-1y", local(2028, 2, 29, 10))).toBe(local(2027, 2, 28, 10));
  });

  it("reads absolute times: ISO with an offset, local date and time, and a date alone", () => {
    expect(resolveTime("2026-10-20T08:00:00.000Z", now)).toBe(Date.UTC(2026, 9, 20, 8));
    expect(resolveTime("2026-10-20T08:15:00+02:00", now)).toBe(Date.UTC(2026, 9, 20, 6, 15));
    expect(resolveTime("2026-10-20T08:00", now)).toBe(local(2026, 10, 20, 8));
    // A date alone is local midnight, not UTC midnight (which would be 02:00 in Berlin).
    expect(resolveTime("2026-10-20", now)).toBe(local(2026, 10, 20));
    expect(resolveTime("2026-02-30", now)).toBeNull();
  });

  it("refuses what the server's time grammar refuses", () => {
    // Epoch milliseconds, steps of more than five digits.
    expect(resolveTime("1760947200000", now)).toBeNull();
    expect(resolveTime("now-100000m", now)).toBeNull();
    expect(resolveTime("now-99999m", now)).toBe(now - 99_999 * 60_000);
    expect(resolveTime("now-1d+2h/h", now)).toBe(local(2026, 10, 19, 16));
  });

  it("rejects what is not a time", () => {
    for (const text of ["", "yesterday", "now-", "now-6x", "now/q", "20-10-2026", "now-6h/d/d"]) {
      expect(resolveTime(text, now), text).toBeNull();
    }
    expect(isRelative("now-6h")).toBe(true);
    expect(isRelative("2026-10-20")).toBe(false);
  });
});

describe("daylight saving time", () => {
  // Clocks went forward on 2026-03-29 at 02:00 (to 03:00) and go back on 2026-10-25 at 03:00.
  it("goes back one calendar day across the spring change: 23 hours", () => {
    const now = local(2026, 3, 29, 12);
    expect(resolveTime("now-1d", now)).toBe(local(2026, 3, 28, 12));
    expect(now - (resolveTime("now-1d", now) ?? 0)).toBe(23 * HOUR);
    expect(now - (resolveTime("now-24h", now) ?? 0)).toBe(24 * HOUR);
  });

  it("rounds to the hour and minute within the repeated hour's own pass", () => {
    // 02:30 on 2026-10-25 happens twice: first at 00:30 UTC (summer time), then at 01:30 UTC.
    const firstPass = Date.UTC(2026, 9, 25, 0, 30, 15);
    const secondPass = Date.UTC(2026, 9, 25, 1, 30, 15);
    expect(resolveTime("now/h", firstPass)).toBe(Date.UTC(2026, 9, 25, 0));
    expect(resolveTime("now/h", secondPass)).toBe(Date.UTC(2026, 9, 25, 1));
    expect(resolveTime("now/m", secondPass)).toBe(Date.UTC(2026, 9, 25, 1, 30));
    expect(resolveTime("now/h", secondPass, true)).toBe(Date.UTC(2026, 9, 25, 2) - 1);
    // A zone half an hour off UTC starts its hours at :30 UTC.
    const kolkata = { timeZone: "Asia/Kolkata", weekStart: null };
    expect(resolveTime("now/h", Date.UTC(2026, 9, 25, 7, 10), false, kolkata)).toBe(
      Date.UTC(2026, 9, 25, 6, 30),
    );
  });

  it("goes back one calendar day across the autumn change: 25 hours", () => {
    const now = local(2026, 10, 25, 12);
    expect(now - (resolveTime("now-1d", now) ?? 0)).toBe(25 * HOUR);
  });

  it("makes today 23 or 25 hours long on change days", () => {
    const spring = resolveRange({ from: "now/d", to: "now/d" }, local(2026, 3, 29, 12));
    const autumn = resolveRange({ from: "now/d", to: "now/d" }, local(2026, 10, 25, 12));
    expect(spring.ok && spring.range.to + 1 - spring.range.from).toBe(23 * HOUR);
    expect(autumn.ok && autumn.range.to + 1 - autumn.range.from).toBe(25 * HOUR);
  });
});

describe("midnight", () => {
  it("treats exactly midnight as the start of the new day", () => {
    const midnight = local(2026, 10, 21);
    expect(resolveTime("now/d", midnight)).toBe(midnight);
    expect(resolveTime("now/d", midnight, true)).toBe(local(2026, 10, 21, 23, 59, 59, 999));
    expect(resolveTime("now-1d/d", midnight)).toBe(local(2026, 10, 20));
  });

  it("keeps a millisecond before midnight in the old day", () => {
    const late = local(2026, 10, 20, 23, 59, 59, 999);
    expect(resolveTime("now/d", late)).toBe(local(2026, 10, 20));
  });

  it("resolves yesterday as the whole previous day", () => {
    const range = resolveRange(
      { from: "now-1d/d", to: "now-1d/d" },
      local(2026, 10, 21, 0, 0, 0, 1),
    );
    expect(range).toEqual({
      ok: true,
      range: { from: local(2026, 10, 20), to: local(2026, 10, 20, 23, 59, 59, 999) },
    });
  });
});

describe("resolveRange", () => {
  const now = local(2026, 10, 20, 14);

  it("names the end that is wrong", () => {
    expect(resolveRange({ from: "soon", to: "now" }, now)).toEqual({
      ok: false,
      error: "invalidFrom",
    });
    expect(resolveRange({ from: "now-1h", to: "later" }, now)).toEqual({
      ok: false,
      error: "invalidTo",
    });
    expect(resolveRange({ from: "now", to: "now-1h" }, now)).toEqual({
      ok: false,
      error: "fromAfterTo",
    });
  });

  it("recognizes the quick ranges and spreads the interval over the points", () => {
    expect(presetOf({ from: "now-6h", to: "now" })?.from).toBe("now-6h");
    expect(presetOf({ from: "now-5h", to: "now" })).toBeUndefined();
    expect(intervalFor({ from: 0, to: 6 * HOUR })).toBe(21_600);
    expect(intervalFor({ from: 0, to: 60_000 })).toBe(1000);
  });
});

describe("fiscal years and quarters", () => {
  // A fiscal year starting in April, in the browser's zone (Berlin).
  const april = { timeZone: null, weekStart: null, fiscalYearStartMonth: 4 };
  const now = local(2027, 2, 10, 9);

  it("rounds to the fiscal year and quarter of the start month", () => {
    expect(resolveTime("now/fy", now, false, april)).toBe(local(2026, 4, 1));
    expect(resolveTime("now/fy", now, true, april)).toBe(local(2027, 3, 31, 23, 59, 59, 999));
    // February is in the fourth quarter of a year from April: January to March.
    expect(resolveTime("now/fQ", now, false, april)).toBe(local(2027, 1, 1));
    expect(resolveTime("now-1fQ/fQ", now, false, april)).toBe(local(2026, 10, 1));
    expect(resolveTime("now-1fy/fy", now, true, april)).toBe(local(2026, 3, 31, 23, 59, 59, 999));
    expect(resolveTime("now-1fy", now, false, april)).toBe(local(2026, 2, 10, 9));
  });

  it("is the calendar year without a start month", () => {
    const calendar = { timeZone: null, weekStart: null };
    expect(resolveTime("now/fy", now, false, calendar)).toBe(resolveTime("now/y", now));
    expect(resolveTime("now/fQ", now, false, calendar)).toBe(local(2027, 1, 1));
  });

  it("counts wall-clock days across daylight saving changes", () => {
    // The quarter from January to March holds the spring change: one hour short.
    const winter = resolveRange({ from: "now/fQ", to: "now/fQ" }, now, april);
    expect(winter.ok && winter.range.from).toBe(local(2027, 1, 1));
    expect(winter.ok && winter.range.to + 1 - winter.range.from).toBe((90 * 24 - 1) * HOUR);
    // A year from October holds both changes and starts at midnight after the autumn one.
    const october = { ...april, fiscalYearStartMonth: 10 };
    const autumn = resolveRange({ from: "now/fy", to: "now/fy" }, local(2026, 10, 25, 12), october);
    expect(autumn.ok && autumn.range.from).toBe(local(2026, 10, 1));
    expect(autumn.ok && autumn.range.to + 1).toBe(local(2027, 10, 1));
    expect(autumn.ok && autumn.range.to + 1 - autumn.range.from).toBe(365 * 24 * HOUR);
  });

  it("counts in the zone in effect, not the browser's", () => {
    // New York while the browser is in Berlin: 1 April starts at local midnight in New York.
    const york = { timeZone: "America/New_York", weekStart: null, fiscalYearStartMonth: 4 };
    const start = resolveTime("now/fy", now, false, york);
    expect(start).toBe(Date.UTC(2026, 3, 1, 4));
    // Its quarter from January to March ends at New York's midnight, one hour short (DST).
    const quarter = resolveRange({ from: "now/fQ", to: "now/fQ" }, now, york);
    expect(quarter.ok && quarter.range.from).toBe(Date.UTC(2027, 0, 1, 5));
    expect(quarter.ok && quarter.range.to + 1).toBe(Date.UTC(2027, 3, 1, 4));
  });

  it("is part of the grammar like every other unit", () => {
    expect(isRelative("now-2fQ/fQ")).toBe(true);
    for (const text of ["now/f", "now-1fq", "now-1FY", "now/fy/d"]) {
      expect(resolveTime(text, now), text).toBeNull();
    }
  });
});

describe("moving and widening a range", () => {
  const now = local(2026, 10, 20, 14);
  const settings = { timeZone: null, weekStart: null };

  it("moves relative ranges by their own length and keeps them relative", () => {
    expect(shiftRange({ from: "now-6h", to: "now" }, -1, now, settings)).toEqual({
      from: "now-12h",
      to: "now-6h",
    });
    expect(shiftRange({ from: "now-12h", to: "now-6h" }, 1, now, settings)).toEqual({
      from: "now-6h",
      to: "now",
    });
    expect(shiftRange({ from: "now-90m", to: "now" }, -1, now, settings)).toEqual({
      from: "now-3h",
      to: "now-90m",
    });
    expect(shiftRange({ from: "now-7d", to: "now" }, -1, now, settings)).toEqual({
      from: "now-2w",
      to: "now-1w",
    });
    expect(shiftRange({ from: "now/d", to: "now/d" }, -1, now, settings)).toEqual({
      from: "now-1d/d",
      to: "now-1d/d",
    });
    expect(shiftRange({ from: "now-1w/w", to: "now/w" }, 1, now, settings)).toEqual({
      from: "now+1w/w",
      to: "now+2w/w",
    });
    expect(shiftRange({ from: "now-1fy/fy", to: "now-1fy/fy" }, -1, now, settings)).toEqual({
      from: "now-2fy/fy",
      to: "now-2fy/fy",
    });
  });

  it("moves anything else as absolute times", () => {
    const moved = shiftRange({ from: "now-1d", to: "now-6h" }, -1, now, settings);
    const before = resolveRange({ from: "now-1d", to: "now-6h" }, now, settings);
    const after = moved === null ? null : resolveRange(moved, now, settings);
    expect(moved?.from).toMatch(/Z$/);
    expect(before.ok && after?.ok && after.range.to).toBe(before.ok && before.range.from);
    const absolute = { from: "2026-10-20T08:00:00.000Z", to: "2026-10-20T10:00:00.000Z" };
    expect(shiftRange(absolute, 1, now, settings)).toEqual({
      from: "2026-10-20T10:00:00.000Z",
      to: "2026-10-20T12:00:00.000Z",
    });
    expect(shiftRange({ from: "later", to: "now" }, 1, now, settings)).toBeNull();
  });

  it("zooms out to twice the range, keeping a range that ends now ending now", () => {
    expect(zoomOutRange({ from: "now-6h", to: "now" }, now, settings)).toEqual({
      from: "now-12h",
      to: "now",
    });
    expect(zoomOutRange({ from: "now-12h", to: "now-6h" }, now, settings)).toEqual({
      from: "now-15h",
      to: "now-3h",
    });
    // Never past now when it ended before now.
    expect(zoomOutRange({ from: "now-2h", to: "now-30m" }, now, settings)).toEqual({
      from: "now-3h",
      to: "now",
    });
    expect(zoomOutRange({ from: "now/w", to: "now/w" }, now, settings)).toEqual({
      from: "now-1w/w",
      to: "now/w",
    });
    const absolute = { from: "2026-10-20T08:00:00.000Z", to: "2026-10-20T10:00:00.000Z" };
    expect(zoomOutRange(absolute, now, settings)).toEqual({
      from: "2026-10-20T07:00:00.000Z",
      to: "2026-10-20T11:00:00.000Z",
    });
  });
});

describe("copy and paste, lengths and the now delay", () => {
  const now = local(2026, 10, 20, 14);

  it("copies a range as JSON and pastes it back, or two times in one line", () => {
    const range = { from: "now-6h", to: "now" };
    expect(rangeFromClipboard(rangeToClipboard(range), now)).toEqual(range);
    expect(rangeFromClipboard("now-1d/d to now-1d/d", now)).toEqual({
      from: "now-1d/d",
      to: "now-1d/d",
    });
    // A local time typed without a zone is stored in UTC, as the picker stores it.
    expect(rangeFromClipboard("2026-10-20T08:00, 2026-10-20T10:00", now)).toEqual({
      from: "2026-10-20T06:00:00.000Z",
      to: "2026-10-20T08:00:00.000Z",
    });
    for (const text of ["", "hello", '{"from": 1}', '{"from":"now","to":"now-1h"}']) {
      expect(rangeFromClipboard(text, now), text).toBeNull();
    }
  });

  it("reads and writes lengths in seconds", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("1d")).toBe(86_400);
    for (const text of ["", "0m", "5", "1w", "-1m", "123456s"]) {
      expect(parseDuration(text), text).toBeNull();
    }
    expect([90, 300, 3600, 86_400, 5400].map(formatDuration)).toEqual([
      "90s",
      "5m",
      "1h",
      "1d",
      "90m",
    ]);
  });

  it("moves now back by the delay", () => {
    expect(delayedNow(now, "5m")).toBe(now - 5 * 60_000);
    expect(delayedNow(now, undefined)).toBe(now);
    expect(delayedNow(now, "soon")).toBe(now);
  });
});
