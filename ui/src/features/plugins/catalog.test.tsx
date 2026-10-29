import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FakeServer } from "../../test/fakeServer";
import { openAdmin } from "../admin/test/openAdmin";
import { CATALOG_AT, catalogItem } from "./test/fakeCatalog";
import { fakePlugin } from "./test/fakePlugins";

const calls = (server: FakeServer, method: string, part: string) =>
  server.calls.filter((call) => call.method === method && call.path.includes(part));

async function openCatalog(setup: (server: FakeServer) => void = () => undefined) {
  return openAdmin("/settings/plugins#catalog", { isServerAdmin: true, setupServer: setup });
}

/** The catalog on, loaded and signed by Kalzit, with `items`. */
function ready(server: FakeServer, items = [catalogItem()]) {
  const catalog = server.areas.pluginCatalog;
  catalog.enabled = true;
  catalog.url = "https://plugins.kalzit.dev/index.json";
  catalog.versions = { enabled: 1, url: 1, refreshHours: 0 };
  catalog.state = "ready";
  catalog.index = {
    sequence: 42,
    publishedAt: CATALOG_AT,
    expiresAt: CATALOG_AT + 30 * 86_400_000,
    fetchedAt: CATALOG_AT,
    keyId: "581c30a0d8384cfd",
    signer: "Kalzit",
    host: "plugins.kalzit.dev",
  };
  catalog.items = items;
  catalog.installed = server.areas.plugins.plugins;
}

describe("Plugins, catalog", () => {
  it("is off by default, says it connects nowhere, and turns on with its address", async () => {
    const { user, server } = await openCatalog();
    expect(await screen.findByRole("heading", { name: "The catalog is off" })).toBeTruthy();
    expect(screen.getByText(/While it is off, Kalzit makes no connection for it/)).toBeTruthy();
    expect(screen.getByText("Install from file always works, with the same checks.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Catalog\s*off/ })).toBeTruthy();
    expect(calls(server, "POST", "/plugin-catalog/refresh")).toHaveLength(0);

    // No default host: the address is empty until an administrator enters one.
    const address = screen.getByRole("textbox", {
      name: "Address of the catalog",
    }) as HTMLInputElement;
    expect(address.value).toBe("");
    await user.type(address, "http://mirror.intern/index.json");
    await user.tab();
    expect(
      await screen.findByText("Enter an https:// address without user name or password."),
    ).toBeTruthy();
    expect(server.areas.pluginCatalog.url).toBe("");

    await user.clear(address);
    await user.type(address, "https://mirror.intern/index.json");
    await user.tab();
    await waitFor(() =>
      expect(server.areas.pluginCatalog.url).toBe("https://mirror.intern/index.json"),
    );
    expect(calls(server, "POST", "/plugin-catalog/refresh")).toHaveLength(0);

    server.areas.pluginCatalog.state = "ready";
    server.areas.pluginCatalog.items = [catalogItem()];
    server.areas.pluginCatalog.index = {
      sequence: 1,
      publishedAt: CATALOG_AT,
      expiresAt: CATALOG_AT + 1e9,
      fetchedAt: CATALOG_AT,
      keyId: "581c30a0d8384cfd",
      signer: "Kalzit",
      host: "mirror.intern",
    };
    await user.click(screen.getByRole("switch", { name: "Use the catalog" }));
    await waitFor(() => expect(calls(server, "POST", "/plugin-catalog/refresh")).toHaveLength(1));
    expect(calls(server, "PATCH", "/api/admin/settings/plugins.catalog_enabled")[0]?.body).toEqual({
      value: true,
      version: 0,
    });
    expect(await screen.findByText(/List signed by Kalzit, checked/)).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "BigQuery" })).toBeTruthy();
  });

  it("lists entries with publisher key, version and targets, filters them and offers updates", async () => {
    const { user, server } = await openCatalog((s) => {
      s.areas.plugins.plugins.push(fakePlugin());
      ready(s, [
        catalogItem(),
        catalogItem({
          id: "nordlicht.snowflake",
          name: "Snowflake",
          version: "2.4.0",
          publisher: "Nordlicht Data GmbH",
          keyId: "7f3a91c20d5be4a8",
          keyName: "Nordlicht Data GmbH",
          network: ["*.snowflakecomputing.com:443"],
          installedVersion: "2.3.1",
          action: "update",
        }),
        catalogItem({
          id: "polar.salesforce",
          name: "Salesforce",
          version: "1.1.0",
          publisher: "Polar Metrics",
          keyId: "aa00bb11cc22dd33",
          keyName: undefined,
          action: "untrusted",
        }),
        catalogItem({
          id: "dev.kalzit.sankey",
          name: "Sankey diagram",
          kind: "panel",
          version: "1.2.0",
          network: [],
          action: "installed",
          installedVersion: "1.2.0",
        }),
      ]);
    });
    expect(await screen.findByRole("heading", { name: "BigQuery" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Catalog\s*4/ })).toBeTruthy();
    expect(screen.getAllByText("*.googleapis.com:443").length).toBeGreaterThan(0);
    expect(screen.getByText("Display only")).toBeTruthy();
    expect(screen.getByText("Polar Metrics · not trusted")).toBeTruthy();
    expect(screen.getByText("Installed 2.3.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update to 2.4.0" })).toBeTruthy();

    // Details: the publisher key, the version, the targets and the package.
    await user.click(screen.getByRole("button", { name: "Details of Snowflake" }));
    const details = await screen.findByRole("dialog", { name: "Snowflake 2.4.0" });
    expect(within(details).getByText("7F3A 91C2 0D5B E4A8")).toBeTruthy();
    expect(within(details).getByText("trusted as Nordlicht Data GmbH")).toBeTruthy();
    expect(within(details).getByText("*.snowflakecomputing.com:443")).toBeTruthy();
    expect(within(details).getByText(/2\.4 MB from plugins\.kalzit\.dev/)).toBeTruthy();
    await user.click(within(details).getByRole("button", { name: "Close" }));

    // Categories and search ask the server.
    await user.click(screen.getByRole("button", { name: /Panels/ }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "BigQuery" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Sankey diagram" })).toBeTruthy();
    expect(calls(server, "GET", "kind=panel").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /All/ }));
    await user.type(screen.getByRole("searchbox", { name: "Search the catalog" }), "snow");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "BigQuery" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Snowflake" })).toBeTruthy();
    expect(calls(server, "GET", "q=snow").length).toBeGreaterThan(0);

    // An untrusted publisher leads to its key on the trust tab.
    await user.clear(screen.getByRole("searchbox", { name: "Search the catalog" }));
    await user.click(await screen.findByRole("button", { name: "Check key…" }));
    expect(
      await screen.findByRole("tab", { name: /Signature and trust/, selected: true }),
    ).toBeTruthy();
  });

  it("installs through the same check as a file: steps, grant, approve", async () => {
    const { user, server } = await openCatalog((s) => {
      ready(s);
      s.areas.pluginCatalog.installAnswer = {
        plugin: fakePlugin({
          id: "dev.kalzit.bigquery",
          name: "BigQuery",
          version: "1.4.0",
          publisher: "Kalzit",
          signer: "kalzit",
          keyId: "581c30a0d8384cfd",
          approved: false,
          enabled: false,
          running: false,
          process: undefined,
          permissions: [{ host: "bigquery.googleapis.com", port: "443", protocol: "tls" }],
        }),
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install BigQuery" }));
    const review = await screen.findByRole("dialog", { name: "Install BigQuery 1.4.0" });
    expect(calls(server, "POST", "/api/admin/plugin-catalog/install")[0]?.body).toEqual({
      id: "dev.kalzit.bigquery",
      version: "1.4.0",
    });
    expect(within(review).getByText("Signature valid")).toBeTruthy();
    expect(
      within(review).getByText(/BigQuery 1\.4\.0 · plugins\.kalzit\.dev · 2\.4 MB/),
    ).toBeTruthy();
    await user.click(within(review).getByRole("button", { name: "Install" }));
    expect(await within(review).findByText("Confirm the permissions first.")).toBeTruthy();
    await user.click(within(review).getByRole("checkbox", { name: "I grant these permissions." }));
    await user.click(within(review).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "POST", "/api/admin/plugins/dev.kalzit.bigquery/approve")).toHaveLength(1);
    // Only the catalog route was used, never an upload.
    expect(
      calls(server, "POST", "/api/admin/plugins").filter((c) => c.path === "/api/admin/plugins"),
    ).toHaveLength(0);
  });

  it("names the failed check when the download is not the listed package", async () => {
    const { user } = await openCatalog((s) => {
      ready(s);
      s.areas.pluginCatalog.installAnswer = {
        status: 422,
        code: "validation",
        reason: "catalog.package_mismatch",
        params: { field: "sha256" },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install BigQuery" }));
    const dialog = await screen.findByRole("dialog", { name: "Package refused" });
    expect(
      (await within(dialog).findAllByText(/does not match its catalog entry \(sha256\)/)).length,
    ).toBeGreaterThan(0);
    expect(
      within(dialog).getByText(/The download is not the package the signed list names/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Choose another file" })).toBeNull();
  });

  it("shows an unreachable, an expired and a refused index, and withdrawn versions", async () => {
    const { user, server } = await openCatalog((s) => {
      ready(s, [catalogItem({ action: "revoked", revoked: "CVE-2026-4711" })]);
      s.areas.pluginCatalog.revoked = [
        {
          id: "dev.kalzit.bigquery",
          versions: "<1.4.0",
          reason: "CVE-2026-4711",
          installedVersion: "1.3.0",
        },
      ];
    });
    expect(await screen.findByText("Withdrawn")).toBeTruthy();
    expect(screen.getByText("The catalog has withdrawn installed versions:")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install BigQuery" })).toBeNull();

    // A refresh refused as a rollback keeps the list and says why.
    server.areas.pluginCatalog.refreshAnswer = {
      status: 422,
      code: "validation",
      reason: "catalog.rollback",
      params: { sequence: "41", accepted: "42" },
    };
    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect((await screen.findAllByText(/sequence 41, but 42 was taken already/)).length).toBe(2);
    expect(screen.getByText("The last check failed.")).toBeTruthy();

    server.areas.pluginCatalog.state = "expired";
    server.areas.pluginCatalog.items = [catalogItem()];
    await user.click(screen.getByRole("tab", { name: /Installed/ }));
    await user.click(screen.getByRole("tab", { name: /Catalog/ }));
    expect(await screen.findByText("The catalog list has expired.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Install BigQuery" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    server.areas.pluginCatalog.state = "unreachable";
    server.areas.pluginCatalog.refreshAnswer = {
      status: 502,
      code: "datasource_error",
      reason: "catalog.signature_invalid",
    };
    await user.click(screen.getByRole("button", { name: "Refresh now" }));
    expect(await screen.findByText("The catalog could not be loaded.")).toBeTruthy();
    expect(screen.getAllByText(/does not match its signature/).length).toBeGreaterThan(0);
  });

  it("lets a trusted key sign the catalog only after a confirmation", async () => {
    const { user, server } = await openAdmin("/settings/plugins#trust", {
      isServerAdmin: true,
      setupServer: (s) => {
        s.areas.plugins.keys.push({
          keyId: "7f3a91c20d5be4a8",
          publicKey: "AAAA",
          name: "Nordlicht Data GmbH",
          addedAt: CATALOG_AT,
          plugins: [],
        });
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Allow for the catalog: Nordlicht Data GmbH" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Let Nordlicht Data GmbH sign the catalog?",
    });
    expect(within(dialog).getByText(/7F3A 91C2 0D5B E4A8/)).toBeTruthy();
    expect(calls(server, "PUT", "/catalog")).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Allow for the catalog" }));
    expect(await screen.findByText("May sign the catalog")).toBeTruthy();
    expect(
      calls(server, "PUT", "/api/admin/plugin-keys/7f3a91c20d5be4a8/catalog")[0]?.body,
    ).toEqual({
      maySignCatalog: true,
    });
  });
});
