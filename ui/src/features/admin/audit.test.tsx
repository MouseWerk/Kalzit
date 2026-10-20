import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "./test/openAdmin";

function auditCalls(server: { calls: { path: string }[] }, base: string) {
  return server.calls.map((call) => call.path).filter((path) => path.startsWith(base));
}

describe("audit log", () => {
  it("shows events newest first with readable action names", async () => {
    await openAdmin("/admin/audit");
    const list = await screen.findByRole("list", { name: "Events" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Team created")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Ada Lovelace from 192.0.2.10")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("team t1")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Signed in")).toBeTruthy();
    // An action this UI has no text for is shown as it is, never hidden.
    expect(within(rows[2] as HTMLElement).getByText("custom.unknown_action")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Kalzit")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('{"fields":["value"]}')).toBeTruthy();
  });

  it("filters by action, person and date", async () => {
    const { user, server } = await openAdmin("/admin/audit");
    await screen.findByRole("list", { name: "Events" });
    const filters = screen.getByRole("search", { name: "Filter the audit log" });

    await user.selectOptions(within(filters).getByLabelText("Action"), "auth.signed_in");
    const list = await screen.findByRole("list", { name: "Events" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
    expect(auditCalls(server, "/api/orgs/o1/audit").at(-1)).toBe(
      "/api/orgs/o1/audit?action=auth.signed_in",
    );

    await user.selectOptions(within(filters).getByLabelText("Person"), "u1");
    expect(await screen.findByText("No events match the filters.")).toBeTruthy();

    await user.selectOptions(within(filters).getByLabelText("Action"), "");
    await user.type(within(filters).getByLabelText("From"), "2026-03-04");
    await waitFor(() =>
      expect(auditCalls(server, "/api/orgs/o1/audit").at(-1)).toMatch(
        /^\/api\/orgs\/o1\/audit\?actor=u1&from=\d+$/,
      ),
    );
    expect(
      await within(screen.getByRole("list", { name: "Events" })).findByText("Team created"),
    ).toBeTruthy();
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
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Events" })).getAllByRole("listitem"),
      ).toHaveLength(2),
    );
    expect((newer as HTMLButtonElement).disabled).toBe(true);
    await user.click(older);
    expect(
      await within(screen.getByRole("list", { name: "Events" })).findByText(
        "custom.unknown_action",
      ),
    ).toBeTruthy();
    expect((older as HTMLButtonElement).disabled).toBe(true);
    await user.click(newer);
    expect(
      await within(screen.getByRole("list", { name: "Events" })).findByText("Team created"),
    ).toBeTruthy();
  });

  it("reads the server audit log from the admin route", async () => {
    const { server } = await openAdmin("/admin/server/audit", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Events" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(auditCalls(server, "/api/admin/audit")).toEqual(["/api/admin/audit"]);
  });

  it("shows no access to the org audit log without audit:read", async () => {
    await openAdmin("/admin/audit", { permissions: ["users:write"] });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
  });
});
