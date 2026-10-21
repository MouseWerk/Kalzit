import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "./test/openAdmin";

function auditCalls(server: { calls: { path: string }[] }, base: string) {
  return server.calls.map((call) => call.path).filter((path) => path.startsWith(base));
}

const events = () => screen.getByRole("list", { name: "Events" });

describe("audit log", () => {
  it("shows the organization's events newest first, readable", async () => {
    await openAdmin("/admin/audit");
    const list = await screen.findByRole("list", { name: "Events" });
    const rows = within(list).getAllByRole("listitem");
    // The sign-in is a server event (no organization), so it is not in the org log.
    expect(rows).toHaveLength(3);
    const row = (index: number) => within(rows[index] as HTMLElement);
    expect(row(0).getByText("Team created")).toBeTruthy();
    expect(row(0).getByText("Ada Lovelace from 192.0.2.10")).toBeTruthy();
    expect(row(0).getByText("team t1")).toBeTruthy();
    expect(row(0).getByText("teamId: t1")).toBeTruthy();
    expect(row(1).getByText("Setting changed")).toBeTruthy();
    expect(row(1).getByText("key: dashboards.default_time_range · version: 2")).toBeTruthy();
    expect(row(1).getByText("Kalzit")).toBeTruthy();
    // An action this UI has no text for is shown as it is, never hidden.
    expect(row(2).getByText("plugin.future_action")).toBeTruthy();
    expect(row(2).getByText("fields: name, role")).toBeTruthy();
  });

  it("filters by area, action and person", async () => {
    const { user, server } = await openAdmin("/admin/audit");
    await screen.findByRole("list", { name: "Events" });
    const filters = screen.getByRole("search", { name: "Filter the audit log" });

    // The server filters by prefix, so an area finds all of its actions.
    await user.selectOptions(within(filters).getByLabelText("Action"), "settings.");
    await waitFor(() => expect(within(events()).getAllByRole("listitem")).toHaveLength(1));
    expect(auditCalls(server, "/api/orgs/o1/audit").at(-1)).toBe(
      "/api/orgs/o1/audit?action=settings.",
    );

    await user.selectOptions(within(filters).getByLabelText("Action"), "team.created");
    await user.selectOptions(await within(filters).findByLabelText("Person"), "u1");
    await waitFor(() =>
      expect(auditCalls(server, "/api/orgs/o1/audit").at(-1)).toBe(
        "/api/orgs/o1/audit?actor=u1&action=team.created",
      ),
    );
    expect(await within(events()).findByText("Team created")).toBeTruthy();
  });

  it("sends the end of the chosen day as the start of the next one, and checks the order", async () => {
    const { user, server } = await openAdmin("/admin/audit");
    await screen.findByRole("list", { name: "Events" });
    const filters = screen.getByRole("search", { name: "Filter the audit log" });
    await user.type(within(filters).getByLabelText("From"), "2026-03-02");
    await user.type(within(filters).getByLabelText("To"), "2026-03-02");
    const expectedFrom = new Date(2026, 2, 2).getTime();
    const expectedTo = new Date(2026, 2, 3).getTime();
    await waitFor(() =>
      expect(auditCalls(server, "/api/orgs/o1/audit").at(-1)).toBe(
        `/api/orgs/o1/audit?from=${expectedFrom}&to=${expectedTo}`,
      ),
    );

    await user.clear(within(filters).getByLabelText("To"));
    await screen.findByRole("list", { name: "Events" });
    const before = auditCalls(server, "/api/orgs/o1/audit").length;
    await user.type(within(filters).getByLabelText("To"), "2026-03-01");
    expect(await screen.findByText("Choose an end date on or after the start date.")).toBeTruthy();
    expect(within(filters).getByLabelText("To").getAttribute("aria-invalid")).toBe("true");
    // Nothing is sent while the range is backwards (the server would refuse it).
    expect(auditCalls(server, "/api/orgs/o1/audit")).toHaveLength(before);
  });

  it("pages through older and newer events", async () => {
    const { user } = await openAdmin("/admin/audit", {
      setup: (admin) => {
        admin.pageSize = 2;
      },
    });
    await screen.findByRole("list", { name: "Events" });
    const newer = screen.getByRole("button", { name: "Newer" });
    const older = screen.getByRole("button", { name: "Older" });
    expect(within(events()).getAllByRole("listitem")).toHaveLength(2);
    expect((newer as HTMLButtonElement).disabled).toBe(true);
    await user.click(older);
    expect(await within(events()).findByText("plugin.future_action")).toBeTruthy();
    expect((older as HTMLButtonElement).disabled).toBe(true);
    await user.click(newer);
    expect(await within(events()).findByText("Team created")).toBeTruthy();
  });

  it("reads the server log with sign-ins and narrows it to one organization", async () => {
    const { user, server } = await openAdmin("/admin/server/audit", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText("Signed in")).toBeTruthy();
    expect(within(list).getAllByText("In Analytical Engines").length).toBeGreaterThan(0);
    const filters = screen.getByRole("search", { name: "Filter the audit log" });
    await user.selectOptions(await within(filters).findByLabelText("Organization"), "o1");
    await waitFor(() => expect(within(events()).getAllByRole("listitem")).toHaveLength(3));
    expect(auditCalls(server, "/api/admin/audit").at(-1)).toBe("/api/admin/audit?orgId=o1");
  });

  it("shows no access to the org audit log without audit:read", async () => {
    await openAdmin("/admin/audit", { permissions: ["users:write"] });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
  });
});
