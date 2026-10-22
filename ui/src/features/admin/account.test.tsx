import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TEST_PASSWORD } from "../../test/fakeServer";
import { openAdmin } from "./test/openAdmin";

describe("own account", () => {
  it("is open to every member, including viewers", async () => {
    await openAdmin("/account", { permissions: ["dashboards:read"] });
    expect(await screen.findByRole("heading", { level: 1, name: "Your account" })).toBeTruthy();
    expect(document.title).toBe("Your account – Kalzit");
  });

  it("saves the name when the field is left, updates the shell and undoes it", async () => {
    const { user, server } = await openAdmin("/account");
    const name = await screen.findByLabelText("Name");
    await user.clear(name);
    await user.click(name);
    await user.paste("Ada King");
    await user.tab();
    expect(await screen.findByText("Your name was saved.")).toBeTruthy();
    expect(server.state.user.name).toBe("Ada King");
    const account = screen.getByRole("button", { name: /Account/ });
    await waitFor(() => expect(account.textContent).toContain("Ada King"));

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.state.user.name).toBe("Ada Lovelace"));
  });

  it("says that changing the password signs out everywhere else", async () => {
    await openAdmin("/account");
    const section = await screen.findByRole("region", { name: "Password" });
    expect(
      within(section).getByText(
        "Changing the password signs you out everywhere else; this browser stays signed in.",
      ),
    ).toBeTruthy();
  });

  it("changes the password with one explicit save and errors at the fields", async () => {
    const { user, admin } = await openAdmin("/account");
    const section = await screen.findByRole("region", { name: "Password" });
    const submit = within(section).getByRole("button", { name: "Change password" });

    await user.click(submit);
    const current = within(section).getByLabelText("Current password");
    expect(current.getAttribute("aria-invalid")).toBe("true");
    expect(within(section).getAllByText("Enter your password.")).toHaveLength(2);
    expect(document.activeElement).toBe(current);

    await user.click(current);
    await user.paste("wrong password");
    await user.click(within(section).getByLabelText("New password"));
    await user.paste("a fresh long password");
    await user.click(within(section).getByLabelText("Repeat new password"));
    await user.paste("a different one");
    await user.click(submit);
    expect(within(section).getByText("The passwords do not match.")).toBeTruthy();

    // A wrong current password is answered as a validation error of the field "current".
    await user.clear(within(section).getByLabelText("Repeat new password"));
    await user.click(within(section).getByLabelText("Repeat new password"));
    await user.paste("a fresh long password");
    await user.click(submit);
    expect(await within(section).findByText("The current password is not correct.")).toBeTruthy();
    expect(document.activeElement).toBe(current);
    expect(admin.password).toBe(TEST_PASSWORD);

    await user.clear(current);
    await user.click(current);
    await user.paste(TEST_PASSWORD);
    await user.click(submit);
    // The confirmation is a toast in the app's notification region, outside the section.
    expect(await screen.findByText("Your password was changed.")).toBeTruthy();
    expect(admin.password).toBe("a fresh long password");
    expect((current as HTMLInputElement).value).toBe("");
    // The server ended the other sessions; the list shows only this browser now.
    const sessions = screen.getByRole("list", { name: "Sessions" });
    await waitFor(() => expect(within(sessions).getAllByRole("listitem")).toHaveLength(1));
  });

  it("lists sessions with their times, ends one, and asks before ending all others", async () => {
    const { user, admin } = await openAdmin("/account");
    const list = await screen.findByRole("list", { name: "Sessions" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("This browser")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(/^Last used .+, expires .+$/)).toBeTruthy();

    const end = within(rows[1] as HTMLElement).getByRole("button", {
      name: /^End the session signed in /,
    });
    expect(end.textContent).toBe("End this session");
    await user.click(end);
    expect(await screen.findByText("The session was ended.")).toBeTruthy();
    expect(admin.sessions.map((session) => session.id)).toEqual(["s1", "s3"]);

    await user.click(screen.getByRole("button", { name: "Sign out everywhere else…" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out everywhere else" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Sign out everywhere else" }));
    expect(await screen.findByText("All other sessions were ended.")).toBeTruthy();
    expect(admin.sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  it("explains every kind of source, and Escape closes only the popover", async () => {
    const { user, server, admin } = await openAdmin("/account", {
      permissions: ["dashboards:read", "audit:read"],
      setup: (state) => {
        state.explain = [
          { kind: "orgRole", role: "editor" },
          { kind: "customRole", roleId: "r1", roleName: "Auditor" },
          {
            kind: "teamRole",
            teamId: "t1",
            teamName: "Analysts",
            role: "viewer",
            roleName: "viewer",
          },
          {
            kind: "grant",
            grantId: "g1",
            subjectType: "team",
            subjectId: "t1",
            resourceType: "folder",
            resourceId: "f0",
            level: "edit",
          },
        ];
      },
    });
    expect(admin.explain).toHaveLength(4);
    const why = await screen.findByRole("button", {
      name: "Why do I have this permission? Read the audit log of the organization.",
    });
    await user.click(why);
    const popover = screen.getByRole("dialog", { name: "Where this permission comes from" });
    expect(await within(popover).findByText("Your role in the organization: Editor")).toBeTruthy();
    expect(within(popover).getByText("Your role “Auditor”")).toBeTruthy();
    expect(within(popover).getByText("The role Viewer of your team “Analysts”")).toBeTruthy();
    expect(
      within(popover).getByText("Access “Can edit” on a folder above, given to one of your teams"),
    ).toBeTruthy();
    expect(server.calls.map((call) => call.path)).toContain(
      "/api/orgs/o1/explain?permission=audit%3Aread",
    );

    // Clicking its text keeps it open.
    await user.click(within(popover).getByText("Your role “Auditor”"));
    expect(screen.getByRole("dialog", { name: "Where this permission comes from" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(why);
  });
});
