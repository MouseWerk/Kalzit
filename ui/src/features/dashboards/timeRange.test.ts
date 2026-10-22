import { afterAll, describe, expect, it } from "vitest";
import { intervalFor, isRelative, presetOf, resolveRange, resolveTime } from "./timeRange";

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
