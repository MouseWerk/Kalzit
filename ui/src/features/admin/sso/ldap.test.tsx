import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { FakeServer } from "../../../test/fakeServer";
import { openAdmin } from "../test/openAdmin";
import { sampleLdapProvider, sampleProvider, sampleSync, sampleSyncRun } from "./test/fakeSso";

async function openSignIn(arrange: (server: FakeServer) => void = () => {}) {
  const opened = await openAdmin("/settings/signin", { isServerAdmin: true, setupServer: arrange });
  await screen.findByRole("heading", { level: 2, name: "Sign-in" });
  return opened;
}

async function openNewLdap(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: "Add provider…" }));
  const chooser = await screen.findByRole("dialog", { name: "Add provider" });
  await user.click(within(chooser).getByRole("radio", { name: /^LDAP or Active Directory/ }));
  await user.click(within(chooser).getByRole("button", { name: "Continue" }));
  return screen.findByRole("dialog", { name: "Add LDAP" });
}

async function fillRequired(user: UserEvent, dialog: HTMLElement) {
  const field = (label: string) => within(dialog).getByLabelText(label);
  await user.type(field("Name"), "Verzeichnis Zentrale");
  await user.type(field("Server URL"), "ldaps://dc01.example:636");
  await user.type(field("Bind DN"), "CN=svc,DC=example");
  await user.type(field("Bind password"), "bind-secret");
  await user.type(field("Base DN for people"), "OU=People,DC=example");
}

function saveButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Save" });
}

describe("sign-in administration, LDAP provider", () => {
  it("lists an LDAP provider in the password form, without a handle", async () => {
    await openSignIn((server) => {
      server.areas.sso.providers = [sampleProvider(), sampleLdapProvider({ position: 1 })];
    });
    const table = await screen.findByRole("table");
    const row = within(table).getByText("Verzeichnis Zentrale").closest("tr") as HTMLElement;
    expect(within(row).getByText("LDAP · Active Directory")).toBeTruthy();
    expect(within(row).getByText("Password form")).toBeTruthy();
    expect(within(row).getByText("ldaps://dc01.example:636")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: /^Move/ })).toBeNull();
    expect(row.getAttribute("draggable")).toBe("false");
  });

  it("checks the connection, then saves with the check's token", async () => {
    const { user, server } = await openSignIn();
    const dialog = await openNewLdap(user);
    await fillRequired(user, dialog);
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("true");

    await user.type(within(dialog).getByLabelText("Login name of the test person"), "l.hoffmann");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    expect(
      await within(dialog).findByText(/^Connection ok over TLS 1\.3, service account bound/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/^Test person found: l\.hoffmann/)).toBeTruthy();
    const sent = server.areas.sso.checksSent[0] as Record<string, unknown>;
    expect(sent.testLogin).toBe("l.hoffmann");
    expect((sent.ldap as Record<string, unknown>).bindPassword).toBe("bind-secret");
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("false");

    await user.click(saveButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = server.areas.sso.ldapSaved[0] as Record<string, unknown>;
    expect(saved.checkToken).toMatch(/^ldap-token-/);
    expect(saved).not.toHaveProperty("testLogin");
    expect(server.areas.sso.providers.map((provider) => provider.slug)).toEqual([
      "verzeichnis-zentrale",
    ]);
  });

  it("shows a refused check at its field with the message on top", async () => {
    const { user, server } = await openSignIn();
    server.areas.sso.checkRefusal = {
      field: "bindPassword",
      reason: "ldap.bind_failed",
      params: { code: "49", detail: "data 52e" },
    };
    const dialog = await openNewLdap(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    const password = within(dialog).getByLabelText("Bind password");
    await waitFor(() => expect(password.getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(password);
    const described = (password.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described).toContain("49: credentials invalid (data 52e). Check password and bind DN.");
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Connection failed. Check one field.",
    );
  });

  it("offers unencrypted connections only with a hint and catches a contradicting URL", async () => {
    const { user, server } = await openSignIn();
    const dialog = await openNewLdap(user);
    await fillRequired(user, dialog);
    await user.click(within(dialog).getByRole("radio", { name: "None" }));
    expect(
      within(dialog).getByText(/^Only for a server on this computer or in a private network/),
    ).toBeTruthy();
    // ldaps:// with "None" contradicts itself: refused before any request.
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    expect(
      await within(dialog).findByText(/^Address and encryption contradict each other/),
    ).toBeTruthy();
    expect(server.areas.sso.checksSent).toHaveLength(0);

    const url = within(dialog).getByLabelText("Server URL");
    await user.clear(url);
    await user.type(url, "ldap://127.0.0.1:389");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    expect(await within(dialog).findByText(/^Connection ok without encryption/)).toBeTruthy();
    expect(
      ((server.areas.sso.checksSent[0] as Record<string, unknown>).ldap as Record<string, unknown>)
        .encryption,
    ).toBe("none");
  });

  it("never fills in the stored bind password and keeps it without a new check", async () => {
    const { user, server } = await openSignIn((server) => {
      server.areas.sso.providers = [sampleLdapProvider()];
    });
    await user.click(await screen.findByRole("button", { name: "Edit Verzeichnis Zentrale" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Verzeichnis Zentrale" });
    const password = within(dialog).getByLabelText("Bind password") as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.placeholder).toBe("stored");
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("false");
    const filter = within(dialog).getByLabelText("Additional filter (optional)");
    await user.type(filter, "(department=IT)");
    await user.click(saveButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = server.areas.sso.ldapSaved[0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("checkToken");
    expect(saved.ldap as Record<string, unknown>).not.toHaveProperty("bindPassword");
    expect(server.areas.sso.providers[0]?.ldap?.userFilter).toBe("(department=IT)");

    // Another bind DN needs the password again.
    await user.click(await screen.findByRole("button", { name: "Edit Verzeichnis Zentrale" }));
    const again = await screen.findByRole("dialog", { name: "Edit Verzeichnis Zentrale" });
    await user.type(within(again).getByLabelText("Bind DN"), "x");
    expect(saveButton(again).getAttribute("aria-disabled")).toBe("true");
    await user.click(within(again).getByRole("button", { name: "Check connection" }));
    expect(await within(again).findByText(/^Enter the bind password: a new provider/)).toBeTruthy();
  });
});

describe("sign-in administration, LDAP sync", () => {
  it("shows a halted run and asks for the second factor before applying it", async () => {
    const { user, server } = await openSignIn((server) => {
      server.areas.sso.providers = [sampleLdapProvider()];
      server.areas.sso.syncs.l1 = sampleSync({
        runs: [
          sampleSyncRun({
            id: "r2",
            status: "halted",
            deactivated: 0,
            changed: 0,
            wouldDeactivate: 58,
            accounts: 412,
          }),
          sampleSyncRun(),
        ],
        deactivated: [
          {
            userId: "u9",
            name: "Greta Vogel",
            email: "greta@example.com",
            login: "g.vogel",
            reason: "disabled_in_directory",
            at: Date.UTC(2026, 9, 29, 2),
          },
        ],
        pending: {
          r2: [
            {
              userId: "u3",
              name: "Emil Schröder",
              email: "emil@example.com",
              login: "e.schroeder",
              reason: "not_in_directory",
            },
          ],
        },
      });
      server.security.totp = true;
    });
    await user.click(await screen.findByRole("button", { name: "More for Verzeichnis Zentrale" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sync…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sync of Verzeichnis Zentrale" });
    const runs = within(dialog).getByRole("table", { name: "Runs" });
    expect(within(runs).getByText("Halted before locking")).toBeTruthy();
    expect(within(runs).getByText("58 of 412 would be locked (14 %), limit 10 %")).toBeTruthy();
    expect(within(dialog).getByText("Locked in the directory")).toBeTruthy();

    await user.click(within(runs).getByRole("button", { name: "Review…" }));
    const review = await screen.findByRole("dialog", { name: "Halted sync" });
    expect(within(review).getByText("No longer in the directory")).toBeTruthy();
    await user.click(within(review).getByRole("button", { name: "Apply anyway…" }));
    const confirm = await screen.findByRole("dialog", { name: "Apply the sync anyway?" });
    expect(within(confirm).getByText("Confirm with your second factor first.")).toBeTruthy();
    expect(server.areas.sso.syncs.l1?.runs[0]?.status).toBe("halted");
    await user.type(within(confirm).getByLabelText("Six-digit code"), server.security.code);
    await waitFor(() => expect(server.areas.sso.syncs.l1?.runs[1]?.status).toBe("applied"));
    expect(server.areas.sso.syncs.l1?.runs[0]?.trigger).toBe("apply");
  });

  it("says that applying needs a second factor when the admin has none", async () => {
    const { user } = await openSignIn((server) => {
      server.areas.sso.providers = [sampleLdapProvider()];
      server.areas.sso.syncs.l1 = sampleSync({
        runs: [sampleSyncRun({ id: "r2", status: "halted", wouldDeactivate: 20, accounts: 50 })],
        pending: { r2: [] },
      });
    });
    await user.click(await screen.findByRole("button", { name: "More for Verzeichnis Zentrale" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sync…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sync of Verzeichnis Zentrale" });
    await user.click(within(dialog).getByRole("button", { name: "Review…" }));
    const review = await screen.findByRole("dialog", { name: "Halted sync" });
    expect(await within(review).findByText(/^“Apply anyway” needs a second factor/)).toBeTruthy();
    expect(
      within(review).getByRole("button", { name: "Apply anyway…" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("runs a sync on demand", async () => {
    const { user, server } = await openSignIn((server) => {
      server.areas.sso.providers = [sampleLdapProvider()];
      server.areas.sso.syncs.l1 = sampleSync({ runs: [] });
    });
    await user.click(await screen.findByRole("button", { name: "More for Verzeichnis Zentrale" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sync…" }));
    const dialog = await screen.findByRole("dialog", { name: "Sync of Verzeichnis Zentrale" });
    expect(within(dialog).getByText("No sync has run yet.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Sync now" }));
    expect(
      await screen.findByText("Sync finished: 412 checked, 6 changed, 3 locked."),
    ).toBeTruthy();
    expect(server.areas.sso.syncs.l1?.runs).toHaveLength(1);
  });
});
