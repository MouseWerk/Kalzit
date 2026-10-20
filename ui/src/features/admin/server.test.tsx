import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "./test/openAdmin";

describe("server users", () => {
  it("lists every account and marks the signed-in one", async () => {
    await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Users" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText("(you)")).toBeTruthy();
    expect(
      (
        within(list).getByRole("checkbox", {
          name: "Ada Lovelace is a server admin",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("explains that the last server admin stays", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Users" });
    await user.click(
      within(list).getByRole("checkbox", { name: "Ada Lovelace is a server admin" }),
    );
    expect(
      await screen.findByText(
        "This is the last server admin. Make another user a server admin first; the server always needs one.",
      ),
    ).toBeTruthy();
    expect(admin.users[0]?.isServerAdmin).toBe(true);

    await user.click(within(list).getByRole("checkbox", { name: "Ada Lovelace is locked" }));
    expect(await screen.findByText(/This is the last server admin/)).toBeTruthy();
    expect(admin.users[0]?.disabled).toBe(false);
  });

  it("locks a user at once and undoes it", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Users" });
    await user.click(within(list).getByRole("checkbox", { name: "Grace Hopper is locked" }));
    expect(
      await screen.findByText("Grace Hopper is locked and can no longer sign in."),
    ).toBeTruthy();
    expect(admin.users[1]?.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Grace Hopper can sign in again.")).toBeTruthy();
    expect(admin.users[1]?.disabled).toBe(false);
  });

  it("creates a user after checking the fields as the server does", async () => {
    const { user, admin } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    await screen.findByRole("list", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "New user…" }));
    const dialog = screen.getByRole("dialog", { name: "New user" });
    await user.type(within(dialog).getByLabelText("Name"), "Katherine Johnson");
    await user.type(within(dialog).getByLabelText("Email address"), "katherine");
    await user.type(within(dialog).getByLabelText("Password"), "short");
    await user.click(within(dialog).getByRole("button", { name: "Create user" }));
    expect(within(dialog).getByText("Enter an email address like name@example.com.")).toBeTruthy();
    expect(within(dialog).getByText("The password needs at least 12 characters.")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("Email address"));

    await user.type(within(dialog).getByLabelText("Email address"), "@example.com");
    await user.type(within(dialog).getByLabelText("Password"), " and longer");
    await user.click(within(dialog).getByRole("button", { name: "Create user" }));
    expect(await screen.findByText("Katherine Johnson was created.")).toBeTruthy();
    expect(admin.users.map((candidate) => candidate.email)).toContain("katherine@example.com");
  });

  it("sets a password for a user", async () => {
    const { user, server } = await openAdmin("/admin/server/users", { isServerAdmin: true });
    await screen.findByRole("list", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Set password of Grace Hopper…" }));
    const dialog = screen.getByRole("dialog", { name: "New password for Grace Hopper" });
    await user.type(within(dialog).getByLabelText("New password"), "a long new password");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("The password of Grace Hopper was changed.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "PATCH")).toEqual([
      { method: "PATCH", path: "/api/admin/users/u2", body: { password: "a long new password" } },
    ]);
  });

  it("is hidden from members who are not server admins", async () => {
    await openAdmin("/admin", { isServerAdmin: false });
    const sections = await screen.findByRole("navigation", { name: "Administration sections" });
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
    await user.type(within(dialog).getByLabelText("Organization name"), "Difference Engines");
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
    ).toEqual(["/admin/settings", "/admin/audit"]);
    const server = screen.getByRole("region", { name: "Server" });
    expect(within(server).getAllByRole("link")).toHaveLength(4);
  });

  it("marks the current section in the section navigation", async () => {
    await openAdmin("/admin/teams");
    const sections = await screen.findByRole("navigation", { name: "Administration sections" });
    await waitFor(() =>
      expect(
        within(sections).getByRole("link", { name: "Teams" }).getAttribute("aria-current"),
      ).toBe("page"),
    );
  });
});
