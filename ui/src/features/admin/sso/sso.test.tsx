import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leavePage } from "../../../lib/leavePage";
import type { FakeServer } from "../../../test/fakeServer";
import { openAdmin } from "../test/openAdmin";
import { sampleMapping, sampleProvider } from "./test/fakeSso";

afterEach(() => {
  vi.restoreAllMocks();
});

async function openSignIn(path: string, arrange: (server: FakeServer) => void = () => {}) {
  const opened = await openAdmin(path, { isServerAdmin: true, setupServer: arrange });
  await screen.findByRole("heading", { level: 2, name: "Sign-in" });
  return opened;
}

function saveButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Save" });
}

describe("sign-in administration, providers", () => {
  it("lists the providers with their place on the sign-in page, status and people", async () => {
    await openSignIn("/settings/signin", (server) => {
      server.areas.sso.providers = [
        sampleProvider(),
        sampleProvider({
          id: "p2",
          slug: "partner",
          name: "Partner Portal",
          position: 1,
          enabled: false,
          people: 0,
        }),
      ];
    });
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const first = rows[1] as HTMLElement;
    expect(within(first).getByText("Müller SSO")).toBeTruthy();
    expect(within(first).getByText("Button 1")).toBeTruthy();
    expect(within(first).getByText("Active")).toBeTruthy();
    const second = rows[2] as HTMLElement;
    expect(within(second).getByText("Paused")).toBeTruthy();
    expect(within(second).getByText("not shown")).toBeTruthy();
  });

  it("keeps Save off until the connection check passed for the values now entered", async () => {
    const { user, server } = await openSignIn("/settings/signin");
    await user.click(await screen.findByRole("button", { name: "Add provider…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add OpenID Connect" });
    await user.type(within(dialog).getByLabelText("Name on the button"), "Partner Portal");
    expect((within(dialog).getByLabelText("Slug") as HTMLInputElement).value).toBe(
      "partner-portal",
    );
    expect(
      (within(dialog).getByLabelText("Redirect URI to enter at the provider") as HTMLInputElement)
        .value,
    ).toBe("https://kalzit.example/auth/oidc/partner-portal/callback");
    await user.type(within(dialog).getByLabelText("Issuer URL"), "https://idp.example/realm");
    await user.type(within(dialog).getByLabelText("Client ID"), "kalzit");
    await user.type(within(dialog).getByLabelText("Client secret"), "top-secret");
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("true");

    // Save without a check creates nothing and says why.
    await user.click(saveButton(dialog));
    expect(server.areas.sso.providers).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    expect(
      await within(dialog).findByText(
        "Connection ok. Discovery read, 2 keys loaded, client accepted (210 ms).",
      ),
    ).toBeTruthy();
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("false");

    // Another issuer needs a new check.
    await user.type(within(dialog).getByLabelText("Issuer URL"), "s");
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    await within(dialog).findByText(/^Connection ok/);

    await user.click(saveButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.areas.sso.providers.map((provider) => provider.slug)).toEqual(["partner-portal"]);
    expect(server.areas.sso.providers[0]?.issuer).toBe("https://idp.example/realms");
    expect(
      await screen.findByText("Partner Portal was added. Its button is now on the sign-in page."),
    ).toBeTruthy();
  });

  it("shows a refused check at its field with a tinted field and the message on top", async () => {
    const { user, server } = await openSignIn("/settings/signin");
    server.areas.sso.checkRefusal = {
      field: "issuer",
      reason: "sso.discovery_unreachable",
      params: { detail: "connection refused" },
    };
    await user.click(await screen.findByRole("button", { name: "Add provider…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add OpenID Connect" });

    // Empty fields are caught before any request, the first one gets focus.
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    const name = within(dialog).getByLabelText("Name on the button");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
    expect(server.areas.sso.checksSent).toHaveLength(0);

    await user.type(name, "Partner");
    await user.type(within(dialog).getByLabelText("Issuer URL"), "https://down.example");
    await user.type(within(dialog).getByLabelText("Client ID"), "kalzit");
    await user.type(within(dialog).getByLabelText("Client secret"), "top-secret");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    const issuer = within(dialog).getByLabelText("Issuer URL");
    await waitFor(() => expect(issuer.getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(issuer);
    const described = (issuer.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "");
    expect(described).toContain("The discovery document cannot be read: connection refused");
    expect(within(dialog).getByRole("alert").textContent).toBe("Check the marked fields.");
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("true");
  });

  it("runs a test sign-in in a new window and shows what the mapping would make of it", async () => {
    const { user } = await openSignIn("/settings/signin", (server) => {
      server.areas.sso.providers = [sampleProvider()];
    });
    const open = vi.spyOn(leavePage, "open").mockReturnValue(true);
    await user.click(await screen.findByRole("button", { name: "Edit Müller SSO" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Müller SSO" });
    // A stored provider whose connection is unchanged saves without a new check.
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("false");
    expect((within(dialog).getByLabelText("Slug") as HTMLInputElement).readOnly).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Test sign-in" }));
    expect(
      await within(dialog).findByText(
        "Test sign-in ok: l.hoffmann · groups kalzit-admins, vertrieb-analyse · would be Admin in Analytical Engines.",
      ),
    ).toBeTruthy();
    expect(open).toHaveBeenCalledWith("https://sso.example/authorize?state=test");
  });

  it("asks before a new issuer removes the links of the people, then saves", async () => {
    const { user, server } = await openSignIn("/settings/signin", (server) => {
      server.areas.sso.providers = [sampleProvider()];
    });
    await user.click(await screen.findByRole("button", { name: "Edit Müller SSO" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Müller SSO" });
    const issuer = within(dialog).getByLabelText("Issuer URL");
    await user.clear(issuer);
    await user.type(issuer, "https://new-sso.example/realms/kalzit");
    await user.type(within(dialog).getByLabelText("Client secret"), "s3cret");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    await within(dialog).findByText(/^Connection ok/);
    await user.click(saveButton(dialog));
    const confirm = await screen.findByRole("dialog", { name: "Change the issuer?" });
    expect(
      within(confirm).getByText(/The link of 3 people to this provider is removed/),
    ).toBeTruthy();
    expect(server.areas.sso.providers[0]?.oidc.issuer).toBe("https://sso.example/realms/kalzit");
    await user.click(within(confirm).getByRole("button", { name: "Remove links and save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.areas.sso.providers[0]?.oidc.issuer).toBe(
      "https://new-sso.example/realms/kalzit",
    );
    expect(server.areas.sso.providers[0]?.people).toBe(0);
  });

  it("changes the order of the buttons with Alt+Arrow, at once and with undo", async () => {
    const { user, server } = await openSignIn("/settings/signin", (server) => {
      server.areas.sso.providers = [
        sampleProvider(),
        sampleProvider({ id: "p2", slug: "partner", name: "Partner Portal", position: 1 }),
      ];
    });
    const handle = await screen.findByRole("button", { name: "Move Müller SSO" });
    handle.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByText("“Sign in with Müller SSO” is now button 2.")).toBeTruthy();
    expect(server.areas.sso.providers.find((p) => p.id === "p1")?.position).toBe(1);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("The previous order applies again.");
    expect(server.areas.sso.providers.find((p) => p.id === "p1")?.position).toBe(0);
  });
});

describe("sign-in administration, group mapping", () => {
  it("removes a mapping at once and undo brings it back", async () => {
    const { user, server } = await openSignIn("/settings/signin#mappings", (server) => {
      server.areas.sso.providers = [sampleProvider()];
      server.areas.sso.mappings = [sampleMapping()];
    });
    const table = await screen.findByRole("table", { name: "Group mapping" });
    expect(within(table).getByText("controlling")).toBeTruthy();
    expect(within(table).getByText("Kalzit adds")).toBeTruthy();
    await user.click(within(table).getByRole("button", { name: "Remove controlling" }));
    expect(
      await screen.findByText("Mapping for “controlling” removed · applies from the next sign-in."),
    ).toBeTruthy();
    expect(server.areas.sso.mappings).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await screen.findByText("Undone.");
    expect(server.areas.sso.mappings).toHaveLength(1);
    expect(server.areas.sso.mappings[0]).toMatchObject({
      group: "controlling",
      orgId: "o1",
      role: "editor",
      idpDecides: false,
    });
  });

  it("changes the rule for people without a matching group with undo", async () => {
    const { user, server } = await openSignIn("/settings/signin#mappings", (server) => {
      server.areas.sso.providers = [sampleProvider()];
    });
    await user.click(await screen.findByRole("radio", { name: "Refuse" }));
    expect(
      await screen.findByText(
        "People without a matching group are now refused · applies from the next sign-in.",
      ),
    ).toBeTruthy();
    expect(server.areas.sso.unmapped.rule).toBe("refuse");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.areas.sso.unmapped.rule).toBe("default"));
  });
});

describe("sign-in administration, local sign-in", () => {
  it("keeps the switch locked while a check is not met and explains why", async () => {
    await openSignIn("/settings/signin#local", (server) => {
      server.areas.sso.providers = [sampleProvider()];
      server.areas.sso.checks = {
        providerReady: { ok: true, name: "Müller SSO" },
        breakGlassReady: { ok: false },
        selfViaProvider: { ok: true },
        passwordOnlyAccounts: 3,
      };
    });
    const toggle = await screen.findByRole("switch", { name: "Sign-in with local password" });
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("Locked until every check under “Checked before turning off” is met."),
    ).toBeTruthy();
    expect(screen.getByText("Müller SSO is active and passed its check")).toBeTruthy();
    expect(screen.getByText("No valid break-glass admin chosen")).toBeTruthy();
  });

  it("changes where the password form stands at once, with undo", async () => {
    const { user, server } = await openSignIn("/settings/signin#local");
    await user.click(await screen.findByRole("radio", { name: "Hidden" }));
    expect(await screen.findByText("The password form is now: Hidden.")).toBeTruthy();
    expect(server.areas.sso.passwordForm).toBe("hidden");
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.areas.sso.passwordForm).toBe("collapsed"));
  });
});
