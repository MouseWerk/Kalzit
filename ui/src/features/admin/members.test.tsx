import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLE_PERMISSIONS } from "./catalog";
import { ALL_PERMISSIONS, openAdmin, sent } from "./test/openAdmin";

const EDITOR_PERMISSIONS = [...BUILT_IN_ROLE_PERMISSIONS.editor];

async function membersList() {
  return screen.findByRole("list", { name: "Members" });
}

describe("members", () => {
  it("lists the members with their roles", async () => {
    await openAdmin("/admin/members");
    const list = await membersList();
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("grace@example.com")).toBeTruthy();
    const role = within(list).getByRole("combobox", { name: "Role of Grace Hopper" });
    expect((role as HTMLSelectElement).value).toBe("editor");
    expect(document.title).toBe("Members – Kalzit");
  });

  it("changes a role at once and undoes it", async () => {
    const { user, server, admin } = await openAdmin("/admin/members");
    const list = await membersList();
    await user.selectOptions(
      within(list).getByRole("combobox", { name: "Role of Grace Hopper" }),
      "viewer",
    );
    expect(await screen.findByText("Grace Hopper is now Viewer.")).toBeTruthy();
    expect(admin.members.find((member) => member.userId === "u2")?.role).toBe("viewer");
    expect(sent(server, "PATCH")).toContain("/api/orgs/o1/members/u2");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Grace Hopper is Editor again.")).toBeTruthy();
    expect(admin.members.find((member) => member.userId === "u2")?.role).toBe("editor");
  });

  it("explains that the last owner cannot be demoted", async () => {
    const { user, admin } = await openAdmin("/admin/members");
    const list = await membersList();
    await user.selectOptions(
      within(list).getByRole("combobox", { name: "Role of Ada Lovelace" }),
      "admin",
    );
    const message = await screen.findByText(
      "This is the last owner of the organization. Make another member an owner first; an organization always needs one.",
    );
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(admin.members.find((member) => member.userId === "u1")?.role).toBe("owner");
  });

  it("asks before removing, starting on Cancel, and explains the last owner", async () => {
    const { user, admin } = await openAdmin("/admin/members");
    await membersList();
    const remove = screen.getByRole("button", { name: "Remove Ada Lovelace…" });
    await user.click(remove);
    const dialog = screen.getByRole("dialog", { name: "Remove member" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));

    // Enter on the focused Cancel closes without removing anyone.
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(remove);

    await user.click(remove);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      await within(screen.getByRole("dialog")).findByText(/This is the last owner/),
    ).toBeTruthy();
    expect(admin.members).toHaveLength(3);
  });

  it("removes a member after confirming", async () => {
    const { user, admin } = await openAdmin("/admin/members");
    await membersList();
    await user.click(screen.getByRole("button", { name: "Remove Alan Turing…" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Alan Turing was removed.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(admin.members.map((member) => member.userId)).not.toContain("u3");
  });

  it("adds a member by email address, with the server's answers at the field", async () => {
    const { user, admin } = await openAdmin("/admin/members");
    await membersList();
    await user.click(screen.getByRole("button", { name: "Add member…" }));
    const dialog = screen.getByRole("dialog", { name: "Add member" });
    const email = within(dialog).getByLabelText("Email address");
    expect(document.activeElement).toBe(email);

    // No account has it: 422 validation with field email.
    await user.click(email);
    await user.paste("nobody@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(/No account uses this email address/)).toBeTruthy();
    expect(email.getAttribute("aria-invalid")).toBe("true");

    // Already a member: 409 conflict with field email.
    await user.clear(email);
    await user.click(email);
    await user.paste("grace@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText("This person is already a member.")).toBeTruthy();

    admin.members = admin.members.filter((member) => member.userId !== "u2");
    await user.clear(email);
    await user.click(email);
    await user.paste(" Grace@Example.com ");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Grace@Example.com was added.")).toBeTruthy();
    expect(admin.members.find((member) => member.userId === "u2")?.role).toBe("admin");
  });

  it("adds members with users:write, not users:invite", async () => {
    await openAdmin("/admin/members", {
      permissions: ["users:read", "users:invite", "audit:read"],
    });
    await membersList();
    expect(screen.queryByRole("button", { name: "Add member…" })).toBeNull();
  });

  it("shows members read-only without users:write", async () => {
    await openAdmin("/admin/members", { permissions: ["users:read", "audit:read"] });
    const list = await membersList();
    expect(within(list).queryByRole("combobox")).toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member…" })).toBeNull();
    expect(within(list).getAllByText("Owner").length).toBeGreaterThan(0);
  });

  it("does not let an admin change an owner, nor offer roles above their own", async () => {
    // Everything the built-in admin role has: all but org:delete.
    const { user, server } = await openAdmin("/admin/members", {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== "org:delete"),
    });
    const list = await membersList();
    // The owner holds more than an admin: no role picker and no remove button for them.
    expect(within(list).queryByRole("combobox", { name: "Role of Ada Lovelace" })).toBeNull();
    expect(within(list).queryByRole("button", { name: "Remove Ada Lovelace…" })).toBeNull();
    const select = within(list).getByRole("combobox", { name: "Role of Alan Turing" });
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    expect(options.filter((option) => option.disabled).map((option) => option.value)).toEqual([
      "owner",
    ]);
    await user.selectOptions(select, "r1");
    expect(await screen.findByText("Alan Turing is now Auditor.")).toBeTruthy();
    expect(sent(server, "PATCH")).toEqual(["/api/orgs/o1/members/u3"]);
  });

  it("without roles:read offers only the built-in roles the user holds", async () => {
    await openAdmin("/admin/members", {
      permissions: ["users:read", "users:write", ...EDITOR_PERMISSIONS],
    });
    const list = await membersList();
    const select = within(list).getByRole("combobox", { name: "Role of Alan Turing" });
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((option) => [option.value, option.disabled])).toEqual([
      ["owner", true],
      ["admin", true],
      ["editor", false],
      ["viewer", false],
    ]);
  });

  it("maps a refused change to a readable text", async () => {
    const { user, server } = await openAdmin("/admin/members");
    const list = await membersList();
    server.failNext("/api/orgs/o1/members/u3", 403, "forbidden", "PATCH");
    await user.selectOptions(
      within(list).getByRole("combobox", { name: "Role of Alan Turing" }),
      "editor",
    );
    expect(
      await screen.findByText(
        "You can only change or remove members, and give roles, whose permissions you hold yourself.",
      ),
    ).toBeTruthy();
  });

  it("says no access when following a link without users:read", async () => {
    await openAdmin("/admin/members", { permissions: ["audit:read"] });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
  });

  it("locks a role an “IdP decides” group mapping sets", async () => {
    await openAdmin("/admin/members", {
      setup: (admin) => {
        const grace = admin.members.find((member) => member.userId === "u2");
        if (grace !== undefined) {
          grace.idpManaged = true;
        }
      },
    });
    const list = await membersList();
    const grace = within(list).getAllByRole("listitem")[1] as HTMLElement;
    expect(within(grace).getByText("IdP decides")).toBeTruthy();
    expect(within(grace).getByText("Editor")).toBeTruthy();
    expect(within(list).queryByRole("combobox", { name: "Role of Grace Hopper" })).toBeNull();
    expect(within(list).queryByRole("button", { name: "Remove Grace Hopper…" })).toBeNull();
    expect(within(list).getByRole("combobox", { name: "Role of Alan Turing" })).toBeTruthy();
  });

  it("explains a role the provider took over after the list was read", async () => {
    const { user, admin } = await openAdmin("/admin/members");
    const list = await membersList();
    const grace = admin.members.find((member) => member.userId === "u2");
    if (grace !== undefined) {
      grace.idpManaged = true;
    }
    await user.selectOptions(
      within(list).getByRole("combobox", { name: "Role of Grace Hopper" }),
      "viewer",
    );
    const message = await screen.findByText(
      "An “IdP decides” group mapping sets this member’s role. Change it at the provider.",
    );
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(admin.members.find((member) => member.userId === "u2")?.role).toBe("editor");
    // The list is read again and shows the lock.
    expect(await within(list).findByText("IdP decides")).toBeTruthy();
  });

  it("moves between rows with the arrow keys", async () => {
    const { user } = await openAdmin("/admin/members");
    const list = await membersList();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    (rows[0] as HTMLElement).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(rows[2]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
  });
});
