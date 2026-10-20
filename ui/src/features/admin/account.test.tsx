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
    await user.type(name, "Ada King");
    await user.tab();
    expect(await screen.findByText("Your name was saved.")).toBeTruthy();
    expect(server.state.user.name).toBe("Ada King");
    const account = screen.getByRole("button", { name: /Account/ });
    await waitFor(() => expect(account.textContent).toContain("Ada King"));

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.state.user.name).toBe("Ada Lovelace"));
  });

  it("changes the password with one explicit save and field errors", async () => {
    const { user, admin } = await openAdmin("/account");
    const section = await screen.findByRole("region", { name: "Password" });
    const submit = within(section).getByRole("button", { name: "Change password" });

    await user.click(submit);
    const current = within(section).getByLabelText("Current password");
    expect(current.getAttribute("aria-invalid")).toBe("true");
    expect(within(section).getAllByText("Enter your password.")).toHaveLength(2);
    expect(document.activeElement).toBe(current);

    await user.type(within(section).getByLabelText("Current password"), "wrong password");
    await user.type(within(section).getByLabelText("New password"), "a fresh long password");
    await user.type(within(section).getByLabelText("Repeat new password"), "a different one");
    await user.click(submit);
    expect(within(section).getByText("The passwords do not match.")).toBeTruthy();

    await user.clear(within(section).getByLabelText("Repeat new password"));
    await user.type(within(section).getByLabelText("Repeat new password"), "a fresh long password");
    await user.click(submit);
    expect(await within(section).findByText("The current password is not correct.")).toBeTruthy();
    expect(admin.password).toBe(TEST_PASSWORD);

    await user.clear(within(section).getByLabelText("Current password"));
    await user.type(within(section).getByLabelText("Current password"), TEST_PASSWORD);
    await user.click(submit);
    expect(await within(section).findByText("Your password was changed.")).toBeTruthy();
    expect(admin.password).toBe("a fresh long password");
    expect((within(section).getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("lists sessions, ends one, and asks before ending all others", async () => {
    const { user, admin } = await openAdmin("/account");
    const list = await screen.findByRole("list", { name: "Sessions" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("This browser")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Unknown browser")).toBeTruthy();

    await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("The session was ended.")).toBeTruthy();
    expect(admin.sessions.map((session) => session.id)).toEqual(["s1", "s3"]);

    await user.click(screen.getByRole("button", { name: "Sign out everywhere else…" }));
    const dialog = screen.getByRole("dialog", { name: "Sign out everywhere else" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Sign out everywhere else" }));
    expect(await screen.findByText("All other sessions were ended.")).toBeTruthy();
    expect(admin.sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  it("explains where a permission comes from, and Escape closes only the popover", async () => {
    const { user, server } = await openAdmin("/account", {
      permissions: ["dashboards:read", "audit:read"],
    });
    const why = await screen.findByRole("button", { name: "Why do I have audit:read?" });
    await user.click(why);
    const popover = screen.getByRole("dialog", { name: "Where this permission comes from" });
    expect(await within(popover).findByText("Your role in the organization: owner")).toBeTruthy();
    expect(server.calls.map((call) => call.path)).toContain(
      "/api/orgs/o1/explain?permission=audit%3Aread",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(why);
  });
});
