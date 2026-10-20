import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin, sent } from "./test/openAdmin";

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

  it("adds a member by email address and says when there is no such account", async () => {
    const { user, admin } = await openAdmin("/admin/members");
    await membersList();
    admin.members = admin.members.filter((member) => member.userId !== "u2");
    await user.click(screen.getByRole("button", { name: "Add member…" }));
    const dialog = screen.getByRole("dialog", { name: "Add member" });
    const email = within(dialog).getByLabelText("Email address");
    expect(document.activeElement).toBe(email);

    await user.type(email, "nobody@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByText(/No account uses this email address/)).toBeTruthy();

    await user.clear(email);
    await user.type(email, "grace@example.com");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("grace@example.com was added.")).toBeTruthy();
    expect(admin.members.find((member) => member.userId === "u2")?.role).toBe("admin");
  });

  it("shows members read-only without users:write and hides adding without users:invite", async () => {
    await openAdmin("/admin/members", { permissions: ["users:read", "audit:read"] });
    const list = await membersList();
    expect(within(list).queryByRole("combobox")).toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member…" })).toBeNull();
    expect(within(list).getAllByText("Owner").length).toBeGreaterThan(0);
  });

  it("does not offer roles with permissions the user does not hold", async () => {
    // Can manage members, but holds only what the built-in viewer role has.
    const { admin } = await openAdmin("/admin/members", {
      permissions: ["users:read", "users:write", "roles:read", "dashboards:read"],
    });
    const list = await membersList();
    const select = within(list).getByRole("combobox", { name: "Role of Alan Turing" });
    const options = within(select).getAllByRole("option") as HTMLOptionElement[];
    const disabled = options.filter((option) => option.disabled).map((option) => option.value);
    // The fake's admin role holds only dashboards:read and users:write, both held here.
    expect(disabled).toEqual(["owner", "editor", "r1"]);
    expect(admin.roles.map((role) => role.id)).toContain("r1");
  });

  it("says no access when following a link without users:read", async () => {
    await openAdmin("/admin/members", { permissions: ["audit:read"] });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
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
