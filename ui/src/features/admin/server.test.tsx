import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin, sent } from "./test/openAdmin";

async function usersList() {
  return screen.findByRole("list", { name: "Users" });
}

describe("server users", () => {
  it("lists every account and marks the signed-in one", async () => {
    await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await usersList();
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("(you)")).toBeTruthy();
    const admin = within(list).getByRole("checkbox", { name: "Ada Lovelace is a server admin" });
    expect((admin as HTMLInputElement).checked).toBe(true);
  });

  it("makes someone a server admin at once, with undo", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await usersList();
    await user.click(
      within(list).getByRole("checkbox", { name: "Grace Hopper is a server admin" }),
    );
    expect(await screen.findByText("Grace Hopper is now a server admin.")).toBeTruthy();
    expect(admin.users[1]?.isServerAdmin).toBe(true);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(admin.users[1]?.isServerAdmin).toBe(false));
  });

  it("asks before giving up one's own server admin role, starting on Cancel, without undo", async () => {
    const { user, admin, server, location } = await openAdmin("/admin/server/users", {
      isServerAdmin: true,
      setup: (state) => {
        // Another admin exists, so the server allows it.
        Object.assign(state.users[1] ?? {}, { isServerAdmin: true });
      },
    });
    const list = await usersList();
    await user.click(
      within(list).getByRole("checkbox", { name: "Ada Lovelace is a server admin" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Stop being a server admin" });
    expect(within(dialog).getByText(/cannot undo this yourself/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sent(server, "PATCH")).toEqual([]);

    await user.click(
      within(list).getByRole("checkbox", { name: "Ada Lovelace is a server admin" }),
    );
    const sessionReads = sent(server, "GET").filter((path) => path === "/api/me").length;
    await user.click(screen.getByRole("button", { name: "Stop being a server admin" }));
    await waitFor(() => expect(location().pathname).toBe("/admin"));
    expect(admin.users[0]?.isServerAdmin).toBe(false);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    // The session is read again: the server sections and their controls are gone.
    await waitFor(() => expect(screen.queryByRole("link", { name: "Users" })).toBeNull());
    expect(screen.queryByRole("list", { name: "Users" })).toBeNull();
    expect(sent(server, "GET").filter((path) => path === "/api/me").length).toBeGreaterThan(
      sessionReads,
    );
    // The overview confirms it and lists only the organization's sections, as does the sidebar.
    const status = await screen.findByRole("status");
    expect(within(status).getByText("Ada Lovelace is no longer a server admin.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Server" })).toBeNull();
    expect(screen.getByRole("region", { name: "Organization “Analytical Engines”" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    const sections = within(nav).getByRole("list", { name: "Administration sections" });
    expect(within(sections).queryByRole("link", { name: "Server settings" })).toBeNull();
    expect(within(sections).getByRole("link", { name: "Members" })).toBeTruthy();
  });

  it("explains that the last server admin stays", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await usersList();
    await user.click(
      within(list).getByRole("checkbox", { name: "Ada Lovelace is a server admin" }),
    );
    await user.click(screen.getByRole("button", { name: "Stop being a server admin" }));
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText(
        "This is the last server admin. Make another user a server admin first; the server always needs one.",
      ),
    ).toBeTruthy();
    expect(admin.users[0]?.isServerAdmin).toBe(true);
  });

  it("asks before locking, saying that it signs the user out", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await usersList();
    await user.click(within(list).getByRole("checkbox", { name: "Grace Hopper is locked" }));
    const dialog = screen.getByRole("dialog", { name: "Lock user" });
    expect(within(dialog).getByText(/signed out everywhere at once/)).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Lock" }));
    expect(
      await screen.findByText("Grace Hopper is locked and can no longer sign in."),
    ).toBeTruthy();
    expect(admin.users[1]?.disabled).toBe(true);

    // Unlocking needs no confirmation.
    await user.click(within(list).getByRole("checkbox", { name: "Grace Hopper is locked" }));
    expect(await screen.findByText("Grace Hopper can sign in again.")).toBeTruthy();
    expect(admin.users[1]?.disabled).toBe(false);
  });

  it("explains why the last owner of an organization cannot be locked", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", {
      isServerAdmin: true,
      setup: (state) => {
        // Another server admin exists; Ada is still the only owner of the organization.
        Object.assign(state.users[1] ?? {}, { isServerAdmin: true });
      },
    });
    const list = await usersList();
    await user.click(within(list).getByRole("checkbox", { name: "Ada Lovelace is locked" }));
    await user.click(screen.getByRole("button", { name: "Lock" }));
    expect(
      await within(screen.getByRole("dialog")).findByText(
        /cannot be locked: it is the last server admin, or the last owner of an organization/,
      ),
    ).toBeTruthy();
    expect(admin.users[0]?.disabled).toBe(false);
  });

  it("creates a user, checking fields first and showing the server's answer at the field", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    await usersList();
    await user.click(screen.getByRole("button", { name: "New user…" }));
    const dialog = screen.getByRole("dialog", { name: "New user" });
    await user.click(within(dialog).getByLabelText("Name"));
    await user.paste("Katherine Johnson");
    await user.click(within(dialog).getByLabelText("Email address"));
    await user.paste("katherine");
    await user.click(within(dialog).getByLabelText("Password"));
    await user.paste("short");
    await user.click(within(dialog).getByRole("button", { name: "Create user" }));
    expect(within(dialog).getByText("Enter an email address like name@example.com.")).toBeTruthy();
    expect(within(dialog).getByText("The password needs at least 12 characters.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Email address"));

    // An address another account has: 409 conflict with field email, shown at the field.
    await user.clear(within(dialog).getByLabelText("Email address"));
    await user.click(within(dialog).getByLabelText("Email address"));
    await user.paste("grace@example.com");
    await user.type(within(dialog).getByLabelText("Password"), " and longer");
    await user.click(within(dialog).getByRole("button", { name: "Create user" }));
    const email = within(dialog).getByLabelText("Email address");
    expect(
      await within(dialog).findByText("An account with this email address already exists."),
    ).toBeTruthy();
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(email);

    await user.clear(email);
    await user.click(email);
    await user.paste("katherine@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("Katherine Johnson was created.")).toBeTruthy();
    expect(admin.users.map((candidate) => candidate.email)).toContain("katherine@example.com");
  });

  it("sets a password for a user and says that it signs them out", async () => {
    const { user, server } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    await usersList();
    await user.click(screen.getByRole("button", { name: "Set password of Grace Hopper…" }));
    const dialog = screen.getByRole("dialog", { name: "New password for Grace Hopper" });
    expect(within(dialog).getByText(/signed out everywhere/)).toBeTruthy();
    await user.click(within(dialog).getByLabelText("New password"));
    await user.paste("a long new password");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("The password of Grace Hopper was changed.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/admin/users/u2", body: { password: "a long new password" } },
    ]);
  });

  it("is hidden from members who are not server admins", async () => {
    await openAdmin("/admin", { isServerAdmin: false });
    const sections = await screen.findByRole("list", { name: "Administration sections" });
    expect(within(sections).queryByRole("link", { name: "Users" })).toBeNull();
    expect(within(sections).getByRole("link", { name: "Members" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Server" })).toBeNull();
  });
});

describe("server organizations", () => {
  it("creates an organization with its first owner and renames one", async () => {
    const { user, admin } = await openAdmin("/admin/server/organizations", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Organizations" });
    expect(within(list).getByText("Analytical Engines")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "New organization…" }));
    const dialog = screen.getByRole("dialog", { name: "New organization" });
    await user.click(within(dialog).getByLabelText("Organization name"));
    await user.paste("Difference Engines");
    await user.selectOptions(await within(dialog).findByLabelText("Owner"), "u2");
    await user.click(within(dialog).getByRole("button", { name: "Create organization" }));
    expect(await screen.findByText("Organization “Difference Engines” was created.")).toBeTruthy();
    expect(admin.orgs.map((org) => org.name)).toContain("Difference Engines");

    await user.click(screen.getByRole("button", { name: "Rename Analytical Engines…" }));
    const rename = screen.getByRole("dialog", { name: "Rename organization" });
    const field = within(rename).getByLabelText("Organization name");
    await user.clear(field);
    await user.type(field, "Engines");
    await user.click(within(rename).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(admin.orgs[0]?.name).toBe("Engines"));
  });

  it("says when no account could own a new organization", async () => {
    const { user } = await openAdmin("/admin/server/organizations", {
      isServerAdmin: true,
      setup: (state) => {
        for (const account of state.users) {
          account.disabled = true;
        }
      },
    });
    await screen.findByRole("list", { name: "Organizations" });
    await user.click(screen.getByRole("button", { name: "New organization…" }));
    const dialog = screen.getByRole("dialog", { name: "New organization" });
    expect(await within(dialog).findByText(/There is no account that can sign in/)).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("button", { name: "Create organization" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("pages through owners beyond the first page of accounts", async () => {
    const { user } = await openAdmin("/admin/server/organizations", {
      isServerAdmin: true,
      setup: (state) => {
        state.pageSize = 2;
      },
    });
    await screen.findByRole("list", { name: "Organizations" });
    await user.click(screen.getByRole("button", { name: "New organization…" }));
    const dialog = screen.getByRole("dialog", { name: "New organization" });
    const owner = await within(dialog).findByLabelText("Owner");
    expect(within(owner).getAllByRole("option")).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(within(owner).getAllByRole("option")).toHaveLength(3));
  });
});

describe("administration overview", () => {
  it("lists the sections the member may open, with what each is for", async () => {
    await openAdmin("/admin", {
      permissions: ["audit:read", "settings:read"],
      isServerAdmin: true,
    });
    const org = await screen.findByRole("region", { name: "Organization “Analytical Engines”" });
    expect(
      within(org)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/settings/organization", "/admin/audit"]);
    const server = screen.getByRole("region", { name: "Server" });
    expect(within(server).getAllByRole("link")).toHaveLength(5);
  });

  it("marks the current section in the section navigation", async () => {
    await openAdmin("/admin/teams");
    const sections = await screen.findByRole("list", { name: "Administration sections" });
    await waitFor(() =>
      expect(
        within(sections).getByRole("link", { name: "Teams" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
  });
});
