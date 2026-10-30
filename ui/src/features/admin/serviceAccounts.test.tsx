import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { checkAllowList, validAccountName, validIpEntry } from "./org/serviceAccountRules";
import { openAdmin, sent } from "./test/openAdmin";

async function accountsTable() {
  return screen.findByRole("table");
}

describe("service accounts", () => {
  it("lists the accounts with role and tokens, and opens one with its tokens", async () => {
    const { user } = await openAdmin("/admin/service-accounts");
    const table = await accountsTable();
    expect(within(table).getByText("Viewer")).toBeTruthy();
    expect(within(table).getByText("1 active")).toBeTruthy();
    expect(document.title).toBe("Service accounts – Kalzit");

    await user.click(within(table).getByRole("button", { name: "export-nightly" }));
    const detail = await screen.findByRole("region", { name: "export-nightly" });
    const tokens = await within(detail).findByRole("table", { name: "Tokens" });
    expect(within(tokens).getByText("backup01")).toBeTruthy();
    expect(within(tokens).getByText("kz_sa_7f3a9c2e…")).toBeTruthy();
    expect(within(tokens).getByText("10.20.8.0/24")).toBeTruthy();
    // Owner is never offered for a service account.
    const role = within(detail).getByRole("combobox", { name: "Role of export-nightly" });
    expect(within(role).queryByRole("option", { name: "Owner" })).toBeNull();
  });

  it("creates an account and checks its name first", async () => {
    const { user, server, areas } = await openAdmin("/admin/service-accounts").then((opened) => ({
      ...opened,
      areas: opened.server.areas,
    }));
    await accountsTable();
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const dialog = screen.getByRole("dialog", { name: "Create service account" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Export Nightly");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(within(dialog).getByText(/lowercase letters, digits or hyphens/)).toBeTruthy();
    expect(sent(server, "POST")).not.toContain("/api/orgs/o1/service-accounts");

    await user.clear(within(dialog).getByRole("textbox", { name: "Name" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "ci-dashboards");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("region", { name: "ci-dashboards" })).toBeTruthy();
    expect(areas.serviceAccounts.accounts.map((account) => account.name)).toContain(
      "ci-dashboards",
    );
  });

  it("explains a taken name at the field, in the server's reason", async () => {
    const { user } = await openAdmin("/admin/service-accounts");
    await accountsTable();
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    const dialog = screen.getByRole("dialog", { name: "Create service account" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "export-nightly");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(
      await within(dialog).findByText(
        "A service account with this name exists already. Choose another name.",
      ),
    ).toBeTruthy();
  });

  it("makes a token, names a wrong IP line, and shows the token once", async () => {
    const { user, server } = await openAdmin("/admin/service-accounts");
    const table = await accountsTable();
    await user.click(within(table).getByRole("button", { name: "export-nightly" }));
    const detail = await screen.findByRole("region", { name: "export-nightly" });
    await user.click(await within(detail).findByRole("button", { name: "Create token" }));
    const dialog = screen.getByRole("dialog", { name: "Token for export-nightly" });
    await user.type(within(dialog).getByRole("textbox", { name: "Token name" }), "backup02");
    expect(within(dialog).getByRole("radio", { name: "90 days" })).toHaveProperty("checked", true);
    const ips = within(dialog).getByRole("textbox", { name: "Allowed IP addresses (optional)" });
    await user.type(ips, "10.20.8.0/24{Enter}10.20.0.0/33");
    expect(within(dialog).getByRole("alert").textContent).toBe(
      "Line 2: “10.20.0.0/33” is neither a valid address nor a valid range.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    expect(sent(server, "POST").some((path) => path.endsWith("/tokens"))).toBe(false);

    await user.type(ips, "{Backspace}2");
    await user.click(within(dialog).getByRole("radio", { name: "30 days" }));
    await user.click(within(dialog).getByRole("button", { name: "Create token" }));
    const shown = await screen.findByRole("dialog", { name: "Token created" });
    expect(within(shown).getByText(/^kz_sa_00000001/)).toBeTruthy();
    const body = server.calls.find((call) => call.path.endsWith("/tokens"))?.body;
    expect(body).toEqual({
      name: "backup02",
      expiresInDays: 30,
      allowedIps: ["10.20.8.0/24", "10.20.0.0/32"],
    });
    const done = within(shown).getByRole("button", { name: "Done" });
    expect(done.getAttribute("aria-disabled")).toBe("true");
    await user.click(done);
    expect(screen.getByRole("dialog", { name: "Token created" })).toBeTruthy();
    await user.click(within(shown).getByRole("checkbox", { name: "I have saved the token" }));
    await user.click(done);
    expect(screen.queryByRole("dialog", { name: "Token created" })).toBeNull();
  });

  it("asks before revoking a token and greys it out afterwards", async () => {
    const { user } = await openAdmin("/admin/service-accounts");
    const table = await accountsTable();
    await user.click(within(table).getByRole("button", { name: "export-nightly" }));
    const detail = await screen.findByRole("region", { name: "export-nightly" });
    await user.click(
      await within(detail).findByRole("button", { name: "Revoke the token “backup01”" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Revoke the token “backup01”?" });
    expect(within(dialog).getByText(/fail at once \(401\)/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }));
    expect(await within(detail).findByText(/^Revoked on .* by Ada Lovelace$/)).toBeTruthy();
  });

  it("creates the SCIM token and replaces it only after asking", async () => {
    const { user, server } = await openAdmin("/admin/service-accounts");
    const card = await screen.findByRole("region", { name: "SCIM provisioning" });
    await user.click(await within(card).findByRole("button", { name: "Create token" }));
    const shown = await screen.findByRole("dialog", { name: "Token created" });
    expect(within(shown).getByText(/^kz_scim_/)).toBeTruthy();
    await user.click(within(shown).getByRole("checkbox", { name: "I have saved the token" }));
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    expect(await within(card).findByText("only token")).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Create a new token" }));
    const ask = screen.getByRole("dialog", { name: "Replace the SCIM token?" });
    await user.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(sent(server, "POST").filter((path) => path.endsWith("/scim-token"))).toHaveLength(1);
  });

  it("offers the SCIM token only to someone with an admin's permissions", async () => {
    await openAdmin("/admin/service-accounts", {
      permissions: ["serviceaccounts:write", "users:write", "dashboards:read"],
    });
    await accountsTable();
    expect(screen.queryByRole("region", { name: "SCIM provisioning" })).toBeNull();
  });

  it("hides the page without the permission", async () => {
    await openAdmin("/admin/service-accounts", { permissions: ["users:read", "users:write"] });
    expect(await screen.findByText("No access")).toBeTruthy();
  });
});

describe("service account rules", () => {
  it("accepts the names the server accepts", () => {
    expect(validAccountName("export-nightly")).toBe(true);
    expect(validAccountName("ci2")).toBe(true);
    for (const bad of ["", "-x", "Export", "a b", "a_b", "x".repeat(51)]) {
      expect(validAccountName(bad), bad).toBe(false);
    }
  });

  it("checks IP lines like the server", () => {
    for (const good of ["10.20.8.0/24", "10.20.9.14", "2001:db8::/48", "::1", "::ffff:10.0.0.1"]) {
      expect(validIpEntry(good), good).toBe(true);
    }
    for (const bad of [
      "10.20.0.0/33",
      "10.20.0",
      "010.0.0.1",
      "2001:db8::/129",
      "host.example",
      "1.2.3.4/8/9",
    ]) {
      expect(validIpEntry(bad), bad).toBe(false);
    }
    expect(checkAllowList("\n 10.0.0.1 \n\n")).toEqual({ ok: true, entries: ["10.0.0.1"] });
    expect(checkAllowList("10.0.0.1\nx")).toEqual({ ok: false, line: 2, value: "x" });
    expect(checkAllowList(Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`).join("\n"))).toEqual({
      ok: false,
      tooMany: true,
    });
  });
});
