import { describe, expect, it } from "vitest";
import { fakeAdmin } from "../features/admin/test/fakeAdmin";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { ACTIVITY_DAYS, fetchActivity } from "./startData";

const DAY = 24 * 60 * 60 * 1000;
// Noon, so the days stay the same in any time zone the tests run in.
const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function event(id: string, action: string, daysAgo: number) {
  return {
    id,
    orgId: "o1",
    action,
    actorUserId: TEST_USER.id,
    actorName: TEST_USER.name,
    actorAddress: null,
    resourceType: null,
    resourceId: null,
    summary: {},
    createdAt: NOW - daysAgo * DAY,
  };
}

function serverWith(events: ReturnType<typeof event>[]) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, orgs: [{ id: "o1", name: "Org", role: "owner" }] },
  });
  const admin = fakeAdmin(server);
  admin.audit = events;
  return { server, admin };
}

describe("activity on the start page", () => {
  it("counts changes per day and leaves sign-ins out", async () => {
    const { server } = serverWith([
      event("e1", "dashboard.saved", 0),
      event("e2", "auth.signed_in", 0),
      event("e3", "team.created", 0),
      event("e4", "member.added", 2),
    ]);
    const activity = await fetchActivity("o1", NOW);
    expect(activity.total).toEqual({ value: 3, more: false });
    expect(activity.perDay).toHaveLength(ACTIVITY_DAYS);
    expect(activity.perDay.at(-1)).toBe(2);
    expect(activity.perDay.at(-3)).toBe(1);
    // Asked for full pages, not the server's default of 50.
    expect(server.calls.some((call) => /audit\?.*limit=200/.test(call.path))).toBe(true);
  });

  it("counts in the total only what the bars show, not events dated after today", async () => {
    // A server clock that was set back left an event dated tomorrow.
    serverWith([event("e0", "dashboard.saved", -1), event("e1", "dashboard.saved", 0)]);
    const activity = await fetchActivity("o1", NOW);
    expect(activity.total).toEqual({ value: 1, more: false });
    expect(activity.perDay.reduce((sum: number, n) => sum + (n ?? 0), 0)).toBe(1);
  });

  it("marks the days a capped reading did not reach as unknown, not quiet", async () => {
    const { admin } = serverWith(
      Array.from({ length: 7 }, (_, index) => event(`e${index}`, "dashboard.saved", index)),
    );
    // One event per page: the five pages the reading allows end two days short.
    admin.pageSize = 1;
    const activity = await fetchActivity("o1", NOW);
    expect(activity.total).toEqual({ value: 5, more: true });
    expect(activity.perDay).toEqual([null, null, null, 1, 1, 1, 1]);
  });
});
