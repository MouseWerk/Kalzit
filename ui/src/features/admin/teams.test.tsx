import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, openAdmin } from "./test/openAdmin";

describe("teams", () => {
  it("lists teams with their member count and creates one", async () => {
    const { user, admin } = await openAdmin("/admin/teams");
    const list = await screen.findByRole("list", { name: "Teams" });
    expect(within(list).getByRole("link", { name: "Analysts" })).toBeTruthy();
    expect(within(list).getByText("1 member")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "New team…" }));
    const dialog = screen.getByRole("dialog", { name: "New team" });
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));
    expect(within(dialog).getByText("Enter a name.")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Team name"), "  Operations ");
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));
    expect(await screen.findByText("Team “Operations” was created.")).toBeTruthy();
    expect(admin.teams.map((team) => team.name)).toContain("Operations");
    expect(await within(list).findByText("0 members")).toBeTruthy();
  });

  it("says when a team name is taken", async () => {
    const { user } = await openAdmin("/admin/teams");
    await screen.findByRole("list", { name: "Teams" });
    await user.click(screen.getByRole("button", { name: "New team…" }));
    const dialog = screen.getByRole("dialog", { name: "New team" });
    await user.type(within(dialog).getByLabelText("Team name"), "Analysts");
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));
    expect(await within(dialog).findByText(/A team with this name already exists/)).toBeTruthy();
  });

  it("deletes a team after confirming", async () => {
    const { user, admin } = await openAdmin("/admin/teams");
    await screen.findByRole("list", { name: "Teams" });
    await user.click(screen.getByRole("button", { name: "Delete Analysts…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete team" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Team “Analysts” was deleted.")).toBeTruthy();
    expect(admin.teams).toHaveLength(0);
  });

  it("manages the members of a team and their team role, with undo", async () => {
    const { user, admin } = await openAdmin("/admin/teams/t1");
    expect(await screen.findByRole("heading", { level: 1, name: "Analysts" })).toBeTruthy();
    const members = await screen.findByRole("list", { name: "Members" });
    const role = within(members).getByRole("combobox", { name: "Team role of Grace Hopper" });
    await user.selectOptions(role, "member");
    expect(await screen.findByText("Grace Hopper is now Member of the team.")).toBeTruthy();
    expect(admin.teams[0]?.members[0]?.role).toBe("member");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Grace Hopper is now Maintainer of the team.")).toBeTruthy();
    expect(admin.teams[0]?.members[0]?.role).toBe("maintainer");

    await user.click(screen.getByRole("button", { name: "Add member…" }));
    const dialog = screen.getByRole("dialog", { name: "Add member to team" });
    const picker = await within(dialog).findByLabelText("Member");
    await user.selectOptions(picker, "u3");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Alan Turing was added to the team.")).toBeTruthy();
    expect(admin.teams[0]?.members.map((member) => member.userId)).toEqual(["u2", "u3"]);

    await user.click(screen.getByRole("button", { name: "Remove Alan Turing from the team…" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Alan Turing was removed from the team.")).toBeTruthy();
    expect(admin.teams[0]?.members.map((member) => member.userId)).toEqual(["u2"]);
  });

  it("gives the team roles at once, with undo", async () => {
    const { user, admin } = await openAdmin("/admin/teams/t1");
    const roles = await screen.findByRole("group", { name: "Roles of the team" });
    const auditor = await within(roles).findByRole("checkbox", { name: "Auditor" });
    await user.click(auditor);
    expect(await screen.findByText("The roles of the team were changed.")).toBeTruthy();
    expect(admin.teams[0]?.roles).toEqual(["r1"]);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(admin.teams[0]?.roles).toEqual([]));
  });

  it("hides changes without teams:write and teams:members", async () => {
    await openAdmin("/admin/teams/t1", { permissions: ["teams:read", "roles:read", "audit:read"] });
    const members = await screen.findByRole("list", { name: "Members" });
    expect(within(members).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename…" })).toBeNull();
    const roles = await screen.findByRole("group", { name: "Roles of the team" });
    for (const box of await within(roles).findAllByRole("checkbox")) {
      expect((box as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("renames a team", async () => {
    const { user, admin } = await openAdmin("/admin/teams/t1");
    await screen.findByRole("heading", { level: 1, name: "Analysts" });
    await user.click(screen.getByRole("button", { name: "Rename…" }));
    const field = within(screen.getByRole("dialog", { name: "Rename team" })).getByLabelText(
      "Team name",
    );
    expect((field as HTMLInputElement).value).toBe("Analysts");
    await user.clear(field);
    await user.type(field, "Data team");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Data team" })).toBeTruthy();
    expect(admin.teams[0]?.name).toBe("Data team");
  });

  it("hides deleting a team whose roles the user does not hold", async () => {
    await openAdmin("/admin/teams", {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== "audit:read"),
      setup: (admin) => {
        Object.assign(admin.teams[0] ?? {}, { roles: ["r1"] });
      },
    });
    const list = await screen.findByRole("list", { name: "Teams" });
    expect(within(list).getByRole("link", { name: "Analysts" })).toBeTruthy();
    expect(within(list).queryByRole("button", { name: "Delete Analysts…" })).toBeNull();
  });

  it("never offers the owner role, and stops at 20 roles", async () => {
    await openAdmin("/admin/teams/t1", {
      setup: (admin) => {
        for (let index = 0; index < 20; index++) {
          admin.roles.push({
            id: `x${index}`,
            name: `Role ${index}`,
            description: "",
            builtin: false,
            permissions: [],
            createdAt: 0,
          });
        }
        Object.assign(admin.teams[0] ?? {}, {
          roles: Array.from({ length: 20 }, (_, index) => `x${index}`),
        });
      },
    });
    const roles = await screen.findByRole("group", { name: "Roles of the team" });
    await within(roles).findByRole("checkbox", { name: "Auditor" });
    expect(within(roles).queryByRole("checkbox", { name: "Owner" })).toBeNull();
    // Full: unchecked roles cannot be added, checked ones can still be removed.
    expect(
      (within(roles).getByRole("checkbox", { name: "Auditor" }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (within(roles).getByRole("checkbox", { name: "Role 0" }) as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("does not let anyone take away a team role they do not hold", async () => {
    await openAdmin("/admin/teams/t1", {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== "audit:read"),
      setup: (admin) => {
        Object.assign(admin.teams[0] ?? {}, { roles: ["r1"] });
      },
    });
    const roles = await screen.findByRole("group", { name: "Roles of the team" });
    const auditor = await within(roles).findByRole("checkbox", { name: "Auditor" });
    expect((auditor as HTMLInputElement).checked).toBe(true);
    expect((auditor as HTMLInputElement).disabled).toBe(true);
    // Changing members would give or take that role too.
    expect(
      screen.getByText(
        "The team's roles have permissions you do not have, so you cannot add or remove its members.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add member…" })).toBeNull();
  });

  it("does not offer any team role while the team has one the user does not hold", async () => {
    await openAdmin("/admin/teams/t1", {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== "audit:read"),
      setup: (admin) => {
        Object.assign(admin.teams[0] ?? {}, { roles: ["r1"] });
      },
    });
    const roles = await screen.findByRole("group", { name: "Roles of the team" });
    // The user holds everything the viewer role has, but the server also checks the Auditor role
    // the team has now, so adding the viewer role would be refused.
    const viewer = await within(roles).findByRole("checkbox", { name: "Viewer" });
    expect((viewer as HTMLInputElement).checked).toBe(false);
    expect((viewer as HTMLInputElement).disabled).toBe(true);
  });

  it("lets a maintainer of the team manage its members without teams:members", async () => {
    const { user, admin } = await openAdmin("/admin/teams/t1", {
      permissions: ["teams:read", "users:read", "audit:read"],
      setup: (state) => {
        state.teams[0]?.members.push({
          userId: "u1",
          email: "ada@example.com",
          name: "Ada Lovelace",
          role: "maintainer",
          addedAt: 0,
        });
      },
    });
    const members = await screen.findByRole("list", { name: "Members" });
    await user.selectOptions(
      within(members).getByRole("combobox", { name: "Team role of Grace Hopper" }),
      "member",
    );
    await waitFor(() => expect(admin.teams[0]?.members[0]?.role).toBe("member"));
  });

  it("keeps a way out of the add dialog when everyone is in the team already", async () => {
    const { user } = await openAdmin("/admin/teams/t1", {
      setup: (admin) => {
        const team = admin.teams[0];
        if (team !== undefined) {
          team.members = admin.members.map((member) => ({
            userId: member.userId,
            email: member.email,
            name: member.name,
            role: "member" as const,
            addedAt: 0,
          }));
        }
      },
    });
    await screen.findByRole("list", { name: "Members" });
    const open = screen.getByRole("button", { name: "Add member…" });
    await user.click(open);
    const dialog = screen.getByRole("dialog", { name: "Add member to team" });
    expect(
      await within(dialog).findByText("Every member of the organization is already in this team."),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(open);
  });

  it("does not undo the team's roles when someone changed them in the meantime", async () => {
    const { user, admin } = await openAdmin("/admin/teams/t1");
    const roles = await screen.findByRole("group", { name: "Roles of the team" });
    await user.click(await within(roles).findByRole("checkbox", { name: "Auditor" }));
    await screen.findByText("The roles of the team were changed.");
    Object.assign(admin.teams[0] ?? {}, { roles: ["editor", "r1"] });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(/Not undone: someone else changed this/)).toBeTruthy();
    expect(admin.teams[0]?.roles).toEqual(["editor", "r1"]);
  });
});
