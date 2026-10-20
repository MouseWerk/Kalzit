import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { generatedUnion } from "../../test/generated";
import { PERMISSION_GROUPS, PERMISSION_TEXT } from "./catalog";
import { openAdmin } from "./test/openAdmin";

describe("permission catalog", () => {
  it("puts every permission of the server into exactly one group, with a text", () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect([...grouped].sort()).toEqual(generatedUnion("Permission").sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(Object.keys(PERMISSION_TEXT).sort()).toEqual([...grouped].sort());
  });
});

describe("roles", () => {
  it("lists built-in roles as fixed and custom roles with delete", async () => {
    await openAdmin("/admin/roles");
    const list = await screen.findByRole("list", { name: "Roles" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual([
      "Owner",
      "Admin",
      "Editor",
      "Viewer",
      "Auditor",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("Built-in")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(
      within(rows[4] as HTMLElement).getByRole("button", { name: "Delete Auditor…" }),
    ).toBeTruthy();
  });

  it("shows a built-in role read-only, grouped by area with what each permission allows", async () => {
    await openAdmin("/admin/roles/editor");
    expect(await screen.findByRole("heading", { level: 2, name: "Editor" })).toBeTruthy();
    expect(screen.getByText(/Built-in roles cannot be changed/)).toBeTruthy();
    const group = screen.getByRole("group", { name: "Dashboards and folders" });
    const write = within(group).getByRole("checkbox", { name: "dashboards:write" });
    expect((write as HTMLInputElement).checked).toBe(true);
    expect((write as HTMLInputElement).disabled).toBe(true);
    expect(write.getAttribute("aria-describedby")).not.toBeNull();
    expect(document.getElementById(write.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Create and change dashboards.",
    );
    for (const box of screen.getAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("creates a role and opens it", async () => {
    const { user, admin, location } = await openAdmin("/admin/roles");
    await screen.findByRole("list", { name: "Roles" });
    await user.click(screen.getByRole("link", { name: "New role" }));
    await screen.findByRole("heading", { level: 2, name: "New role" });
    await user.type(screen.getByLabelText("Name"), "Publisher");
    await user.type(screen.getByLabelText("Description"), "Shares dashboards");
    await user.click(screen.getByRole("checkbox", { name: "dashboards:share" }));
    await user.click(screen.getByRole("button", { name: "Create role" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Publisher" })).toBeTruthy();
    const created = admin.roles.find((role) => role.name === "Publisher");
    expect(created?.permissions).toEqual(["dashboards:share"]);
    expect(location().pathname).toBe(`/admin/roles/${created?.id}`);
  });

  it("does not let anyone add permissions they do not hold", async () => {
    const { user } = await openAdmin("/admin/roles/r1", {
      permissions: ["roles:read", "roles:write", "audit:read", "dashboards:read"],
    });
    const box = await screen.findByRole("checkbox", { name: "dashboards:write" });
    expect((box as HTMLInputElement).disabled).toBe(true);
    expect(
      document.getElementById(box.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("You can only give permissions you have yourself.");
    // A held permission can be added, and one the role has can always be taken away.
    const read = screen.getByRole("checkbox", { name: "dashboards:read" });
    expect((read as HTMLInputElement).disabled).toBe(false);
    await user.click(read);
    expect(await screen.findByText("Role “Auditor” was saved.")).toBeTruthy();
  });

  it("saves each change of a custom role at once and undoes it", async () => {
    const { user, admin } = await openAdmin("/admin/roles/r1");
    const box = await screen.findByRole("checkbox", { name: "teams:read" });
    await user.click(box);
    expect(await screen.findByText("Role “Auditor” was saved.")).toBeTruthy();
    expect(admin.roles.find((role) => role.id === "r1")?.permissions).toEqual([
      "audit:read",
      "teams:read",
    ]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(admin.roles.find((role) => role.id === "r1")?.permissions).toEqual(["audit:read"]),
    );

    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Reviewer{Enter}");
    await waitFor(() =>
      expect(admin.roles.find((role) => role.id === "r1")?.name).toBe("Reviewer"),
    );
  });

  it("maps a refused grant to a readable text", async () => {
    const { user, server } = await openAdmin("/admin/roles/r1");
    const box = await screen.findByRole("checkbox", { name: "teams:read" });
    server.failNext("/api/orgs/o1/roles/r1", 403, "forbidden", "PATCH");
    await user.click(box);
    expect(
      await screen.findByText("You cannot give permissions you do not have yourself."),
    ).toBeTruthy();
  });

  it("deletes a custom role after confirming", async () => {
    const { user, admin } = await openAdmin("/admin/roles");
    await screen.findByRole("list", { name: "Roles" });
    await user.click(screen.getByRole("button", { name: "Delete Auditor…" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Role “Auditor” was deleted.")).toBeTruthy();
    expect(admin.roles.map((role) => role.id)).not.toContain("r1");
  });

  it("hides creating and deleting without roles:write", async () => {
    await openAdmin("/admin/roles", { permissions: ["roles:read", "audit:read"] });
    const list = await screen.findByRole("list", { name: "Roles" });
    expect(screen.queryByRole("link", { name: "New role" })).toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
  });
});
