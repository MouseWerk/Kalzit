import { afterAll, describe, expect, it } from "vitest";
import { timeTicks } from "./series";

// Set while the file is collected; the cases are about local hours across a DST change.
const previousZone = process.env.TZ;
process.env.TZ = "Europe/Berlin";

afterAll(() => {
  if (previousZone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = previousZone;
  }
});

const hours = (ticks: number[]) => ticks.map((t) => new Date(t).getHours());

describe("time axis ticks", () => {
  it("stay on local 3-hour marks across the spring change", () => {
    // 2026-03-29: clocks jump from 02:00 to 03:00 in Berlin.
    const from = new Date(2026, 2, 28, 22).getTime();
    const to = new Date(2026, 2, 29, 13).getTime();
    const { ticks, step } = timeTicks(from, to, 6);
    expect(step).toBe(3 * 3_600_000);
    expect(hours(ticks)).toEqual([0, 3, 6, 9, 12]);
  });

  it("stay on local 6-hour marks across the autumn change", () => {
    // 2026-10-25: clocks go back from 03:00 to 02:00.
    const from = new Date(2026, 9, 24, 20).getTime();
    const to = new Date(2026, 9, 26, 1).getTime();
    const { ticks } = timeTicks(from, to, 6);
    expect(hours(ticks)).toEqual([0, 6, 12, 18, 0]);
  });

  it("put day ticks on local midnight", () => {
    const from = new Date(2026, 9, 20, 15).getTime();
    const to = new Date(2026, 9, 27, 15).getTime();
    const { ticks } = timeTicks(from, to, 8);
    expect(ticks.every((t) => new Date(t).getHours() === 0)).toBe(true);
    expect(ticks).toHaveLength(7);
  });
});
