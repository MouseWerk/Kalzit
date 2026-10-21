import { describe, expect, it, vi } from "vitest";
import { isApiError } from "../../api/client";
import {
  explainPermission,
  listGrants,
  listMySessions,
  listOrgSettings,
  listRoles,
  listTeamMembers,
} from "./api";

/** Answers every request with `body`, as a server that drifted from the contract would. */
function answer(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

async function rejection(call: () => Promise<unknown>) {
  try {
    await call();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const ROLE = {
  id: "viewer",
  name: "viewer",
  description: "",
  builtin: true,
  permissions: ["dashboards:read"],
  createdAt: null,
};

describe("admin API shapes (docs/api/access.md, docs/api/settings-dashboards.md)", () => {
  it("reads lists only as Page<T>, so a bare array fails loudly", async () => {
    answer([ROLE]);
    expect(isApiError(await rejection(() => listRoles("o1")), "invalid_response")).toBe(true);
    answer({ items: [ROLE], nextCursor: null });
    expect(await listRoles("o1")).toEqual([ROLE]);
  });

  it("reads grants and settings pages", async () => {
    answer([]);
    expect(
      isApiError(await rejection(() => listGrants("o1", "dashboard", "d1")), "invalid_response"),
    ).toBe(true);
    expect(isApiError(await rejection(() => listOrgSettings("o1")), "invalid_response")).toBe(true);
  });

  it("reads an explanation with its sources, not a bare list", async () => {
    answer([{ kind: "orgRole", name: "owner" }]);
    expect(
      isApiError(await rejection(() => explainPermission("o1", "users:read")), "invalid_response"),
    ).toBe(true);
    const explanation = {
      permission: "users:read",
      allowed: true,
      sources: [{ kind: "teamRole", teamId: "t1", teamName: "A", role: "r1", roleName: "R" }],
    };
    answer(explanation);
    expect(await explainPermission("o1", "users:read")).toEqual(explanation);
  });

  it("reads a team member's role as `role` with `addedAt`", async () => {
    answer({
      items: [{ userId: "u", email: "e@x.io", name: "N", teamRole: "member" }],
      nextCursor: null,
    });
    expect(isApiError(await rejection(() => listTeamMembers("o1", "t1")), "invalid_response")).toBe(
      true,
    );
  });

  it("reads sessions with expiresAt", async () => {
    answer({
      items: [{ id: "s", createdAt: 1, lastSeenAt: 2, current: true, userAgent: "Firefox" }],
      nextCursor: null,
    });
    expect(isApiError(await rejection(() => listMySessions()), "invalid_response")).toBe(true);
  });
});
