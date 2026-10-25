import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "../features/admin/api";
import { changeTime, fetchRecentChanges, relativeTime } from "./startData";

const listAudit = vi.hoisted(() => vi.fn());
vi.mock("../features/admin/api", async (original) => ({
  ...(await original<typeof import("../features/admin/api")>()),
  listAudit,
}));

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const format = (language: string) =>
  new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });

describe("relative times on the start page", () => {
  const en = (ago: number) => relativeTime(format("en"), NOW - ago, NOW, "just now");
  const de = (ago: number) => relativeTime(format("de"), NOW - ago, NOW, "gerade eben");

  it("says just now under a minute and for a time ahead of now", () => {
    expect(en(30_000)).toBe("just now");
    expect(de(30_000)).toBe("gerade eben");
    expect(en(-4 * 24 * HOUR)).toBe("just now");
  });

  it("rounds to the largest whole unit, in the UI language", () => {
    expect(en(90 * MINUTE)).toMatch(/^(1|2) hr\. ago$/);
    expect(en(23 * HOUR)).toBe("23 hr. ago");
    expect(de(23 * HOUR)).toBe("vor 23 Std.");
    expect(en(36 * HOUR)).toMatch(/^(yesterday|2 days ago)$/);
    expect(de(36 * HOUR)).toMatch(/^(gestern|vor 2 Tagen)$/);
  });
});

describe("change times on the start page", () => {
  it("shows the time of day for today and the day and month before, by the whole date", () => {
    expect(changeTime(NOW - HOUR, NOW, "de", "Europe/Berlin")).toBe("13:00");
    expect(changeTime(NOW - 30 * HOUR, NOW, "de", "Europe/Berlin")).toBe("19.10.");
    // The same day and month a year earlier is not today.
    expect(changeTime(Date.UTC(2025, 9, 20, 11), NOW, "de", "Europe/Berlin")).toBe("20.10.");
  });
});

const event = (id: string, action: string): AuditEvent => ({
  id,
  orgId: "o1",
  actorUserId: "u1",
  actorName: "Ada",
  actorAddress: null,
  action,
  resourceType: null,
  resourceId: null,
  summary: {},
  createdAt: NOW,
});

describe("recent changes", () => {
  it("leaves out sign-ins and reads past a page full of them", async () => {
    listAudit
      .mockResolvedValueOnce({
        items: Array.from({ length: 3 }, (_, i) => event(`a${i}`, "auth.signed_in")),
        nextCursor: "c1",
      })
      .mockResolvedValueOnce({
        items: [event("d1", "dashboard.saved"), event("a9", "auth.session_ended")],
        nextCursor: null,
      });
    const changes = await fetchRecentChanges("o1", 5);
    expect(changes.map((c) => c.id)).toEqual(["d1"]);
    expect(listAudit).toHaveBeenCalledTimes(2);
  });
});
