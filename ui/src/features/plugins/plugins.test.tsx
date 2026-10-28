import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FakeServer } from "../../test/fakeServer";
import { openAdmin } from "../admin/test/openAdmin";
import { keyBase64, keyIdOf, parsePublicKey, sha256Hex } from "./fingerprint";
import { countdown, groupedKeyId } from "./status";
import { AT, fakePlugin, type WirePlugin } from "./test/fakePlugins";

const calls = (server: FakeServer, method: string, part: string) =>
  server.calls.filter((call) => call.method === method && call.path.includes(part));

function withPlugins(...plugins: WirePlugin[]) {
  return (server: FakeServer) => {
    server.areas.plugins.plugins.push(...plugins);
  };
}

async function openPlugins(path: string, setup: (server: FakeServer) => void = () => undefined) {
  return openAdmin(path, { isServerAdmin: true, setupServer: setup });
}

/** A file as the file input hands it over. */
function packageFile(name = "nordlicht-snowflake-2.4.0.zip") {
  return new File([new Uint8Array(1_840_000)], name, { type: "application/zip" });
}

describe("fingerprints", () => {
  it("computes SHA-256 like the standard", () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // Two blocks.
    expect(
      sha256Hex(
        new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("reads a key as hex, base64 or SubjectPublicKeyInfo, and names it by its key id", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const base64 = keyBase64(bytes);
    const spki = keyBase64(
      Uint8Array.from([
        0x30,
        0x2a,
        0x30,
        0x05,
        0x06,
        0x03,
        0x2b,
        0x65,
        0x70,
        0x03,
        0x21,
        0x00,
        ...bytes,
      ]),
    );
    for (const text of [hex, base64, `kalzit-ed25519 ${base64}`, spki]) {
      expect(parsePublicKey(text), text).toEqual(bytes);
    }
    expect(
      parsePublicKey(
        `-----BEGIN PUBLIC KEY-----\n${spki.slice(0, 30)}\n${spki.slice(30)}\n-----END PUBLIC KEY-----`,
      ),
    ).toEqual(bytes);
    expect(parsePublicKey("not a key")).toBeNull();
    expect(parsePublicKey(keyBase64(new Uint8Array(31)))).toBeNull();
    expect(keyIdOf(bytes)).toBe(sha256Hex(bytes).slice(0, 16));
    // Kalzit's plugin main key and its id from plugin-api's `key_id` (signing.rs).
    const kalzit = parsePublicKey("6RZV2LeoOy9gDyW7Izi8OXRoDbMjsWQ3FiZabeC4D6c=");
    expect(kalzit === null ? null : keyIdOf(kalzit)).toBe("581c30a0d8384cfd");
    expect(groupedKeyId("7f3a91c20d5be4a8")).toBe("7F3A 91C2 0D5B E4A8");
  });

  it("counts down in minutes and seconds", () => {
    expect(countdown(100_000, 0)).toBe("1:40");
    expect(countdown(0, 5000)).toBe("0:00");
    expect(countdown(3_723_000, 0)).toBe("1:02:03");
  });
});

describe("Plugins, installed", () => {
  it("lists publisher, signature with key id, version and update, targets and status", async () => {
    const now = Date.now();
    await openPlugins(
      "/settings/plugins",
      withPlugins(
        fakePlugin({
          pending: {
            version: "2.4.0",
            signer: "publisher",
            keyId: "7f3a91c20d5be4a8",
            permissions: [],
            addedPermissions: [],
          },
        }),
        fakePlugin({
          id: "brueckner.hana",
          name: "SAP HANA",
          publisher: "Brückner IT",
          keyId: "2b916e04a7f377d0",
          permissions: [
            {
              setting: "host",
              form: "host",
              portSetting: "port",
              defaultPort: "30015",
              protocol: "tcp",
            },
          ],
          process: {
            state: "waiting",
            starts: 4,
            failures: 4,
            retryAt: now + 100_000,
            lastError: { reason: "plugin.crashed", message: "exit code 0xC0000005", at: now },
            sandbox: [],
            sandboxMissing: [],
          },
        }),
        fakePlugin({
          id: "ritter.jira",
          name: "Jira Cloud",
          enabled: false,
          running: false,
          process: undefined,
        }),
        fakePlugin({
          id: "dev.local.test",
          name: "Test",
          signer: "unsigned",
          keyId: undefined,
          publisher: undefined,
          approved: false,
          enabled: false,
          running: false,
          process: undefined,
        }),
        fakePlugin({
          id: "old.key",
          name: "Old key",
          trusted: false,
          running: false,
          process: undefined,
        }),
      ),
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Plugins" })).toBeTruthy();
    const table = await screen.findByRole("table");
    const row = (name: string) =>
      within(table).getByRole("link", { name }).closest("tr") as HTMLElement;

    const snowflake = row("Snowflake");
    expect(within(snowflake).getByText("Nordlicht Data GmbH")).toBeTruthy();
    expect(within(snowflake).getByText("Signed")).toBeTruthy();
    expect(within(snowflake).getByText("7F3A 91C2 0D5B E4A8")).toBeTruthy();
    expect(within(snowflake).getByText("2.4.0 waits for approval")).toBeTruthy();
    expect(within(snowflake).getByText("acme.snowflakecomputing.com:443 (tls)")).toBeTruthy();
    expect(within(snowflake).getByText("Running")).toBeTruthy();

    const hana = row("SAP HANA");
    expect(within(hana).getByText("Crashed")).toBeTruthy();
    expect(within(hana).getByText(/Restart in 1:(39|40) · attempt 4 of 6/)).toBeTruthy();
    expect(
      within(hana).getByText("The host in “host”, port in “port”, default 30015 (tcp)"),
    ).toBeTruthy();
    expect(within(row("Jira Cloud")).getByText("Turned off")).toBeTruthy();
    const unsigned = row("Test");
    expect(within(unsigned).getByText("Unsigned")).toBeTruthy();
    expect(within(unsigned).getByText("Waiting for approval")).toBeTruthy();
    expect(within(unsigned).getByText("Publisher not named")).toBeTruthy();
    expect(within(row("Old key")).getByText("Stopped: key not trusted")).toBeTruthy();

    // The strip counts the problems (crashed, untrusted) and the waiting update.
    const strip = screen.getByRole("region", { name: "Plugins at a glance" });
    expect(within(strip).getByText("Problems").nextElementSibling?.textContent).toBe("2");
    expect(within(strip).getByText("Snowflake 2.4.0")).toBeTruthy();
    expect(screen.getByText("Server: windows-x64")).toBeTruthy();
  });

  it("filters to problems and names the Landlock refusal of a plugin that is not loaded", async () => {
    const { user } = await openPlugins(
      "/settings/plugins",
      withPlugins(
        fakePlugin(),
        fakePlugin({
          id: "x.y",
          name: "Linux only",
          running: false,
          process: undefined,
          sandboxWarning: "landlock_missing",
        }),
      ),
    );
    await screen.findByRole("table");
    await user.click(screen.getByRole("button", { name: /^Problems/ }));
    const table = screen.getByRole("table");
    expect(within(table).queryByRole("link", { name: "Snowflake" })).toBeNull();
    const row = within(table)
      .getByRole("link", { name: "Linux only" })
      .closest("tr") as HTMLElement;
    expect(within(row).getByText("Not loaded")).toBeTruthy();
    expect(within(row).getByText(/offers no Landlock/)).toBeTruthy();
  });

  it("shows a band while unsigned plugins are allowed, which turns them off", async () => {
    const { user, server } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.allowUnsigned = true;
      s.areas.plugins.plugins.push(fakePlugin({ signer: "unsigned", keyId: undefined }));
    });
    const band = await screen.findByText("Unsigned plugins are allowed.");
    expect(band.closest("p")?.textContent).toContain("Unsigned plugins installed: 1.");
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByText("Unsigned plugins are allowed.")).toBeNull());
    expect(calls(server, "PATCH", "/api/admin/plugin-host").at(-1)?.body).toEqual({
      allowUnsigned: false,
    });
  });

  it("offers the plugins only to server admins", async () => {
    await openAdmin("/settings/plugins", { isServerAdmin: false });
    expect(await screen.findByText("You cannot open this section.")).toBeTruthy();
  });
});

describe("Plugins, install from file", () => {
  it("shows the checks from the server's answer, asks for the grant, then approves and starts", async () => {
    const { user, server } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.installAnswer = {
        plugin: fakePlugin({
          approved: false,
          enabled: false,
          running: false,
          process: undefined,
          permissions: [
            { host: "acme.snowflakecomputing.com", port: "443", protocol: "tls" },
            { setting: "account", form: "url", protocol: "https" },
          ],
        }),
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());

    const review = await screen.findByRole("dialog", { name: "Install Snowflake 2.3.1" });
    expect(within(review).getByText("Package read")).toBeTruthy();
    expect(within(review).getByText(/nordlicht-snowflake-2\.4\.0\.zip · 1\.8 MB/)).toBeTruthy();
    expect(within(review).getByText("Signature valid")).toBeTruthy();
    expect(
      within(review).getByText("Nordlicht Data GmbH · key 7F3A 91C2 0D5B E4A8 · trusted"),
    ).toBeTruthy();
    expect(within(review).getByText("Checksums match")).toBeTruthy();
    expect(
      within(review).getByText("Contains linux-x64, windows-x64 · this server: windows-x64"),
    ).toBeTruthy();
    expect(within(review).getByText("The address in the setting “account” (https)")).toBeTruthy();
    // Nothing runs before the grant.
    await user.click(within(review).getByRole("button", { name: "Install" }));
    expect(await within(review).findByText("Confirm the permissions first.")).toBeTruthy();
    expect(calls(server, "POST", "/approve")).toHaveLength(0);

    await user.click(within(review).getByRole("checkbox", { name: "I grant these permissions." }));
    await user.click(within(review).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      calls(server, "POST", "/api/admin/plugins/nordlicht.snowflake/approve")[0]?.body,
    ).toEqual({
      version: "2.3.1",
    });
    expect(calls(server, "POST", "/api/admin/plugins/nordlicht.snowflake/enable")).toHaveLength(1);
    expect(calls(server, "POST", "/api/admin/plugins")[0]?.path).toBe("/api/admin/plugins");
    expect(await screen.findByText("Snowflake 2.3.1 is installed.")).toBeTruthy();
  });

  it("installs a removed plugin's id from another publisher only after the typed server name", async () => {
    const previous = "7f3a91c20d5be4a8";
    const { user, server } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.installAnswer = {
        status: 409,
        code: "conflict",
        reason: "plugin.publisher_changed",
        params: { datasources: "3", previousKeyId: previous, removedVersion: "2.3.1" },
      };
      s.areas.plugins.confirmedInstallAnswer = {
        plugin: fakePlugin({ approved: false, enabled: false, running: false, process: undefined }),
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());

    const change = await screen.findByRole("dialog", { name: "Install from another publisher?" });
    expect(
      within(change).getByText(
        "Data sources of this plugin, in every organization and in the trash: 3",
      ),
    ).toBeTruthy();
    expect(
      within(change).getByText(`Key of the removed plugin: ${groupedKeyId(previous)}`),
    ).toBeTruthy();
    expect(within(change).getByText("Removed version: 2.3.1")).toBeTruthy();
    expect(within(change).getByText(/clears the stored passwords and keys/)).toBeTruthy();

    // Not without the server's name.
    const name = window.location.hostname;
    const input = within(change).getByRole("textbox", {
      name: `To confirm, type the server’s name: ${name}`,
    });
    await user.type(input, "wrong");
    await user.click(within(change).getByRole("button", { name: "Install and clear passwords" }));
    expect(await within(change).findByText("That is not the server’s name.")).toBeTruthy();
    expect(calls(server, "POST", "/api/admin/plugins")).toHaveLength(1);

    await user.clear(input);
    await user.type(input, name);
    await user.click(within(change).getByRole("button", { name: "Install and clear passwords" }));
    await screen.findByRole("dialog", { name: "Install Snowflake 2.3.1" });
    expect(calls(server, "POST", "/api/admin/plugins").map((call) => call.path)).toEqual([
      "/api/admin/plugins",
      "/api/admin/plugins?confirmPublisherChange=true",
    ]);
  });

  it("names an unknown former key when a removed unsigned plugin comes back", async () => {
    const { user } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.installAnswer = {
        status: 409,
        code: "conflict",
        reason: "plugin.publisher_changed",
        params: { datasources: "1" },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());
    const change = await screen.findByRole("dialog", { name: "Install from another publisher?" });
    expect(
      within(change).getByText("Key of the removed plugin: unsigned or not known"),
    ).toBeTruthy();
    expect(within(change).queryByText(/Removed version/)).toBeNull();
  });

  it("marks the targets an update adds and approves the waiting version", async () => {
    const installed = fakePlugin();
    const { user, server } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.plugins.push(installed);
      s.areas.plugins.installAnswer = {
        plugin: {
          ...installed,
          pending: {
            version: "2.4.0",
            signer: "publisher",
            keyId: "7f3a91c20d5be4a8",
            permissions: [
              ...installed.permissions,
              { host: "acme.privatelink.snowflakecomputing.com", port: "443", protocol: "tls" },
            ],
            addedPermissions: [
              { host: "acme.privatelink.snowflakecomputing.com", port: "443", protocol: "tls" },
            ],
          },
        },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());
    const review = await screen.findByRole("dialog", { name: "Install Snowflake 2.4.0" });
    expect(
      within(review).getByText("Data source from Nordlicht Data GmbH · update of 2.3.1"),
    ).toBeTruthy();
    expect(within(review).getByText("Update of 2.3.1, waits for approval")).toBeTruthy();
    const added = within(review)
      .getByText("acme.privatelink.snowflakecomputing.com:443 (tls)")
      .closest("li") as HTMLElement;
    expect(added.dataset.new).toBe("true");
    expect(within(added).getByText("new in 2.4.0")).toBeTruthy();
    const same = within(review)
      .getByText("acme.snowflakecomputing.com:443 (tls)")
      .closest("li") as HTMLElement;
    expect(within(same).getByText("as before")).toBeTruthy();
    expect(
      within(review).getByText(/Changes against the installed version are marked/),
    ).toBeTruthy();
    await user.click(within(review).getByRole("checkbox", { name: "I grant these permissions." }));
    await user.click(within(review).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "POST", "/approve")[0]?.body).toEqual({ version: "2.4.0" });
    // It runs already: no enable.
    expect(calls(server, "POST", "/enable")).toHaveLength(0);
  });

  it("takes a new plugin back when the review is cancelled", async () => {
    const { user, server } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.installAnswer = {
        plugin: fakePlugin({ approved: false, enabled: false, running: false, process: undefined }),
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());
    const review = await screen.findByRole("dialog", { name: "Install Snowflake 2.3.1" });
    await user.click(within(review).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "DELETE", "/api/admin/plugins/nordlicht.snowflake")).toHaveLength(1);
  });

  it.each([
    [
      "plugin.signature_invalid",
      undefined,
      "Signature does not match the content",
      "Always refused, also when unsigned plugins are allowed.",
    ],
    [
      "plugin.platform_missing",
      { platform: "windows-x64" },
      "No matching platform",
      "Ask the publisher for a package for windows-x64.",
    ],
    [
      "plugin.kalzit_too_old",
      { minKalzit: "0.6.0" },
      "Needs a newer Kalzit",
      "The plugin needs Kalzit 0.6.0 or newer.",
    ],
    [
      "plugin.package_invalid",
      { issues: "package.unlisted_file" },
      "Files do not match the manifest",
      "package.unlisted_file",
    ],
  ])("names the refused step for %s", async (reason, params, title, text) => {
    const { user } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.installAnswer = {
        status: 422,
        code: "validation",
        reason,
        ...(params === undefined ? {} : { params }),
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());
    const refused = await screen.findByRole("dialog", { name: "Package refused" });
    const alert = within(refused).getByRole("alert");
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain("Not installed.");
    expect(refused.textContent).toContain(text);
    const failed = refused.querySelector('[data-state="failed"]');
    expect(failed?.textContent).toContain(title);
    // The steps after the refused one were skipped.
    expect(refused.querySelectorAll('[data-state="skipped"]').length).toBeGreaterThan(0);
  });

  it("leads from an untrusted key to adding it, comparing the fingerprint with the package's", async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
    const keyId = keyIdOf(bytes);
    const { user, server } = await openPlugins("/settings/plugins", (s) => {
      s.areas.plugins.installAnswer = {
        status: 422,
        code: "validation",
        reason: "plugin.signer_untrusted",
        params: { keyId },
      };
    });
    await user.click(await screen.findByRole("button", { name: "Install from file…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install from file" });
    await user.upload(within(dialog).getByLabelText(/Drop the package here/), packageFile());
    const refused = await screen.findByRole("dialog", { name: "Package refused" });
    expect(refused.textContent).toContain("Publisher not trusted");
    expect(refused.textContent).toContain(`signed with key ${keyId}`);
    await user.click(within(refused).getByRole("button", { name: "Check key and trust…" }));

    const add = await screen.findByRole("dialog", { name: "Add key" });
    expect(
      screen.getByRole("tab", { name: /Signature and trust/ }).getAttribute("aria-selected"),
    ).toBe("true");
    await user.type(within(add).getByRole("textbox", { name: "Publisher" }), "Polar Metrics");
    const field = within(add).getByRole("textbox", { name: "Public key (Ed25519)" });
    await user.click(field);
    // Another key than the package's: named as such, and it cannot be added from here.
    await user.paste(keyBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 1)));
    expect(
      within(add).getByText(/This is not the key that signed the refused package/),
    ).toBeTruthy();
    expect(
      (within(add).getByRole("button", { name: "Add key" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.clear(field);
    await user.paste(keyBase64(bytes));
    expect(within(add).getByText(groupedKeyId(keyId))).toBeTruthy();
    expect(within(add).getByText("Matches the key that signed the refused package.")).toBeTruthy();
    expect(
      (within(add).getByRole("button", { name: "Add key" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    // Not before the comparison is confirmed.
    await user.click(within(add).getByRole("button", { name: "Add key" }));
    expect(await within(add).findByText("Compare the fingerprint first.")).toBeTruthy();
    expect(calls(server, "POST", "/api/admin/plugin-keys")).toHaveLength(0);
    await user.click(within(add).getByRole("checkbox", { name: "I compared the fingerprint." }));
    await user.click(within(add).getByRole("button", { name: "Add key" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "POST", "/api/admin/plugin-keys")[0]?.body).toEqual({
      name: "Polar Metrics",
      publicKey: keyBase64(bytes),
    });
  });
});

describe("Plugins, signature and trust", () => {
  it("lists the keys with fingerprints and removes one after naming the plugins it stops", async () => {
    const { user, server } = await openPlugins("/settings/plugins#trust", (s) => {
      s.areas.plugins.plugins.push(fakePlugin());
      s.areas.plugins.keys.push({
        keyId: "7f3a91c20d5be4a8",
        publicKey: "AAAA",
        name: "Nordlicht Data GmbH",
        addedAt: AT,
        plugins: ["nordlicht.snowflake"],
      });
      s.areas.plugins.pendingByKey["7f3a91c20d5be4a8"] = ["brueckner.hana"];
    });
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Compiled into this Kalzit")).toBeTruthy();
    expect(within(table).getByText("Cannot be removed")).toBeTruthy();
    expect(within(table).getByText("ed25519 7F3A 91C2 0D5B E4A8")).toBeTruthy();

    await user.click(
      within(table).getByRole("button", { name: "Remove key of Nordlicht Data GmbH" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Remove the key of Nordlicht Data GmbH?",
    });
    // Focus starts on Cancel.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText(/Removing it stops them now/)).toBeTruthy();
    expect(within(dialog).getByText("nordlicht.snowflake")).toBeTruthy();
    expect(within(dialog).getByText("brueckner.hana")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Remove and stop" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const deletes = calls(server, "DELETE", "/api/admin/plugin-keys/");
    expect(deletes.map((call) => call.path)).toEqual([
      "/api/admin/plugin-keys/7f3a91c20d5be4a8",
      "/api/admin/plugin-keys/7f3a91c20d5be4a8?confirm=true",
    ]);
    expect(await screen.findByText(/Stopped: nordlicht\.snowflake/)).toBeTruthy();
  });

  it("refuses a pasted text that is no key", async () => {
    const { user } = await openPlugins("/settings/plugins#trust");
    await user.click(await screen.findByRole("button", { name: "Add key" }));
    const add = await screen.findByRole("dialog", { name: "Add key" });
    const field = within(add).getByRole("textbox", { name: "Public key (Ed25519)" });
    await user.click(field);
    await user.paste("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ");
    expect(within(add).getByText("This is not an Ed25519 public key.")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("allows unsigned plugins only after the warning and the typed server name", async () => {
    const { user, server } = await openPlugins("/settings/plugins#trust");
    const toggle = await screen.findByRole("switch", { name: "Allow unsigned plugins" });
    expect(screen.getByText("High risk.", { selector: "strong" })).toBeTruthy();
    await user.click(toggle);
    const dialog = await screen.findByRole("dialog", { name: "Allow unsigned plugins?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    const name = window.location.hostname;
    const input = within(dialog).getByRole("textbox", {
      name: `To confirm, type the server’s name: ${name}`,
    });
    // The exact text to type stands visibly next to the field.
    expect(within(dialog).getByText(name, { selector: "strong" })).toBeTruthy();
    await user.type(input, "wrong");
    await user.click(within(dialog).getByRole("button", { name: "Allow" }));
    expect(await within(dialog).findByText("That is not the server’s name.")).toBeTruthy();
    expect(calls(server, "PATCH", "/api/admin/plugin-host")).toHaveLength(0);
    await user.clear(input);
    await user.type(input, name);
    await user.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "PATCH", "/api/admin/plugin-host")[0]?.body).toEqual({
      allowUnsigned: true,
    });
    expect(
      (screen.getByRole("switch", { name: "Allow unsigned plugins" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText("Unsigned plugins are allowed.", { selector: "strong" })).toBeTruthy();
  });

  it("shows the Landlock switch on Linux servers", async () => {
    const { user, server } = await openPlugins("/settings/plugins#trust", (s) => {
      s.areas.plugins.platform = "linux-x64";
    });
    expect(
      await screen.findByText(
        "This Linux server offers no Landlock. Without this switch, plugins do not start here.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Run plugins without Landlock" }));
    const dialog = await screen.findByRole("dialog", { name: "Run plugins without Landlock?" });
    await user.type(within(dialog).getByRole("textbox"), window.location.hostname);
    await user.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "PATCH", "/api/admin/plugin-host")[0]?.body).toEqual({
      allowWithoutLandlock: true,
    });
  });
});

describe("Plugins, catalog", () => {
  it("is off with an explanation, and its switch is locked until a later version", async () => {
    await openPlugins("/settings/plugins#catalog");
    expect(await screen.findByRole("heading", { name: "The catalog is off" })).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Use the catalog" }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Comes with a later version.")).toBeTruthy();
  });
});

describe("Plugins, details", () => {
  it("shows the manifest, the sandbox, the log and where it is used, and removes it", async () => {
    const { user, server, location } = await openPlugins(
      "/settings/plugins/nordlicht.snowflake",
      (s) => {
        s.areas.plugins.plugins.push(fakePlugin());
        s.areas.plugins.usedIn["nordlicht.snowflake"] = [
          { id: "d1", name: "Data Warehouse", orgId: "o1", orgName: "Analytical Engines" },
          { id: "d2", name: "Marketing", orgId: "o2", orgName: "Kampagnen GmbH" },
        ];
        s.areas.plugins.logs["nordlicht.snowflake"] = [
          { at: AT, stream: "stdout", text: "query done" },
          { at: AT, stream: "stderr", text: "warning: slow" },
        ];
      },
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Snowflake" })).toBeTruthy();
    expect(screen.getByText("Restricted token")).toBeTruthy();
    expect(screen.getByText("Network isolation")).toBeTruthy();
    expect(screen.getByText("18244")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Manifest" }));
    expect(screen.getByText(/id = "nordlicht\.snowflake"/)).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Log" }));
    expect(await screen.findByText("query done")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^stderr/ }));
    expect(screen.queryByText("query done")).toBeNull();
    expect(screen.getByText("warning: slow")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /Used in/ }));
    expect(screen.getByText("2 data sources in 2 organizations")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Data Warehouse" })).toBeTruthy();
    expect(screen.getByText("Kampagnen GmbH")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Snowflake?" });
    expect(dialog.textContent).toContain(
      "2 data sources in 2 organizations use this plugin. They stay with their settings and answer “kind not available” until it is installed again.",
    );
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(location().pathname).toBe("/settings/plugins"));
    expect(calls(server, "DELETE", "/api/admin/plugins/nordlicht.snowflake")).toHaveLength(1);
  });

  it("says when a crashed plugin starts again and restarts it now", async () => {
    const { user, server } = await openPlugins("/settings/plugins/brueckner.hana", (s) => {
      s.areas.plugins.plugins.push(
        fakePlugin({
          id: "brueckner.hana",
          name: "SAP HANA",
          process: {
            state: "stopped",
            starts: 7,
            failures: 7,
            lastError: { reason: "plugin.exited", message: "exit code 126", at: AT },
            sandbox: ["restricted_token"],
            sandboxMissing: [],
          },
        }),
      );
    });
    expect(await screen.findByText("Stopped after repeated failures")).toBeTruthy();
    expect(
      screen.getAllByText(/The plugin process ended before it was ready/).length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(calls(server, "POST", "/brueckner.hana/restart")).toHaveLength(1));
  });

  it("approves a waiting update, marking what it adds, and turns a plugin off", async () => {
    const { user, server } = await openPlugins("/settings/plugins/nordlicht.snowflake", (s) => {
      s.areas.plugins.plugins.push(
        fakePlugin({
          pending: {
            version: "2.4.0",
            signer: "publisher",
            keyId: "7f3a91c20d5be4a8",
            permissions: [{ host: "new.example", port: "443", protocol: "tls" }],
            addedPermissions: [{ host: "new.example", port: "443", protocol: "tls" }],
          },
        }),
      );
    });
    await user.click(await screen.findByRole("button", { name: "Approve update to 2.4.0…" }));
    const dialog = await screen.findByRole("dialog", { name: "Approve Snowflake 2.4.0" });
    expect(within(dialog).getByText("new in 2.4.0")).toBeTruthy();
    await user.click(within(dialog).getByRole("checkbox", { name: "I grant these permissions." }));
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls(server, "POST", "/approve")[0]?.body).toEqual({ version: "2.4.0" });
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() =>
      expect(calls(server, "POST", "/nordlicht.snowflake/disable")).toHaveLength(1),
    );
  });
});

describe("Plugins of the organization", () => {
  it("blocks and unblocks a plugin for the organization", async () => {
    const { user, server } = await openPlugins("/settings/org-plugins", withPlugins(fakePlugin()));
    const toggle = await screen.findByRole("switch", { name: "Offered: Snowflake" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    await waitFor(() =>
      expect(calls(server, "PUT", "/api/orgs/o1/plugins/nordlicht.snowflake/block")).toHaveLength(
        1,
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("switch", { name: "Offered: Snowflake" }) as HTMLInputElement).checked,
      ).toBe(false),
    );
    await user.click(screen.getByRole("switch", { name: "Offered: Snowflake" }));
    await waitFor(() =>
      expect(
        calls(server, "DELETE", "/api/orgs/o1/plugins/nordlicht.snowflake/block"),
      ).toHaveLength(1),
    );
  });

  it("is hidden without plugins:configure", async () => {
    await openAdmin("/settings/org-plugins", { permissions: ["settings:read"] });
    expect(await screen.findByText("You cannot open this section.")).toBeTruthy();
  });
});
