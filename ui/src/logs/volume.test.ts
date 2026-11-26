import { describe, expect, it } from "vitest";
import type { Frame } from "../api/generated/shapes";
import type { LogLine } from "./model";
import {
  axisTop,
  isLogQuery,
  lokiVolumeQuery,
  volumeFromFrame,
  volumeFromLines,
  volumeStep,
  withoutComments,
} from "./volume";

const HOUR = 3_600_000;

describe("volume", () => {
  it("picks a bar width that keeps about sixty bars over the range", () => {
    expect(volumeStep(HOUR)).toBe(60_000);
    expect(volumeStep(15 * 60_000)).toBe(15_000);
    expect(volumeStep(24 * HOUR)).toBe(30 * 60_000);
    expect(volumeStep(1)).toBe(1_000);
  });

  it("builds Loki's count query over the same selector and pipeline, without comments", () => {
    expect(lokiVolumeQuery({ logql: '{app="api"} |= "order" # only orders' }, 60_000)).toEqual({
      logql:
        'sum by (level, detected_level) (count_over_time({app="api"} |= "order" [$__interval]))',
      minStepMs: 60_000,
    });
    // A metric query or an instant query has no lines to count.
    expect(lokiVolumeQuery({ logql: 'rate({app="api"}[1m])' }, 60_000)).toBeNull();
    expect(lokiVolumeQuery({ logql: '{app="api"}', instant: true }, 60_000)).toBeNull();
  });

  it("keeps a # inside quotes", () => {
    expect(withoutComments('{a="#1"} |= `#x` # c\n| json')).toBe('{a="#1"} |= `#x` \n| json');
    expect(isLogQuery('# a comment\n{a="b"}')).toBe(true);
    expect(isLogQuery('sum(rate({a="b"}[1m]))')).toBe(false);
  });

  it("reads the count query's series by level label, each sample counting the step before it", () => {
    const frame: Frame = {
      fields: [
        { name: "time", type: "time", values: [60_000, 120_000] },
        { name: "error", type: "number", labels: { level: "error" }, values: [2, null] },
        { name: "info", type: "number", labels: { detected_level: "info" }, values: [5, 7] },
        { name: "{}", type: "number", labels: {}, values: [1, 0] },
      ],
      meta: { rowsTruncated: false, notices: [] },
    };
    const volume = volumeFromFrame(frame, { from: 0, to: 120_000 }, 60_000);
    expect(volume.basis).toBe("count");
    expect(
      volume.buckets.map((bucket) => [
        bucket.from,
        bucket.counts.error,
        bucket.counts.info,
        bucket.counts.unknown,
      ]),
    ).toEqual([
      [0, 2, 5, 1],
      [60_000, 0, 7, 0],
    ]);
    expect(volume.totals).toMatchObject({ error: 2, info: 12, unknown: 1, warning: 0 });
  });

  it("counts the loaded lines per bar when there is no count query, and says so", () => {
    const lines = [10_000, 20_000, 70_000, 200_000].map(
      (ms, id) =>
        ({
          id,
          timeMs: ms,
          level: id === 2 ? "error" : "info",
        }) as LogLine,
    );
    const volume = volumeFromLines(lines, { from: 0, to: 120_000 }, 60_000);
    expect(volume.basis).toBe("loaded");
    expect(volume.buckets).toHaveLength(2);
    // The line outside the range is in no bar.
    expect(volume.totals).toMatchObject({ info: 2, error: 1 });
  });

  it("rounds the axis to a readable top", () => {
    expect(axisTop(0)).toBe(1);
    expect(axisTop(7)).toBe(10);
    expect(axisTop(212)).toBe(250);
    expect(axisTop(400)).toBe(500);
  });
});
