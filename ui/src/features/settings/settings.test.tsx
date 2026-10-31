import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { checkAccent } from "../../appearance/contrast";
import { installFakeServer } from "../../test/fakeServer";
import { generatedUnion } from "../../test/generated";
import { renderApp } from "../../test/renderApp";
import { openAdmin, sent } from "../admin/test/openAdmin";
import { buildIndex, search } from "./search";
import { SECTIONS } from "./sections";

function nav() {
  return screen.findByRole("navigation", { name: "Settings sections" });
}

/** The row of a setting, once its section has loaded. */
function row(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const element = document.getElementById(id);
    if (element === null) {
      throw new Error(`no row ${id}`);
    }
    return element;
  });
}

describe("settings shell", () => {
  it("groups the sections Server, Organization and Personal with export at the bottom", async () => {
    await openAdmin("/settings/appearance", { isServerAdmin: true });
    const sections = await nav();
    for (const name of [
      "Appearance and brand",
      "General",
      "Network, HTTPS and proxy",
      "Sessions and security",
      "Sign-in",
      "Email",
      "Data sources and targets",
      "Storage and retention",
      "Updates",
      "Organization Analytical Engines",
      "Profile and language",
      "Sign-in and security",
      "Keyboard shortcuts",
      "Export / import settings",
    ]) {
      expect(within(sections).getByRole("link", { name }), name).toBeTruthy();
    }
    const current = within(sections).getByRole("link", { name: "Appearance and brand" });
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(
      await screen.findByRole("heading", { level: 2, name: "Appearance and brand" }),
    ).toBeTruthy();
  });

  it("shows members only their personal sections and refuses server sections", async () => {
    await openAdmin("/settings/appearance", { isServerAdmin: false, permissions: [] });
    expect(await screen.findByText("You cannot open this section.")).toBeTruthy();
    const sections = await nav();
    expect(within(sections).queryByRole("link", { name: "Appearance and brand" })).toBeNull();
    expect(within(sections).getByRole("link", { name: "Profile and language" })).toBeTruthy();
    expect(within(sections).queryByRole("link", { name: "Export / import settings" })).toBeNull();
  });

  it("scrolls the navigation to the current entry, also for an address with quotes", async () => {
    const reveal = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    await openAdmin("/settings/transfer", { isServerAdmin: true });
    const sections = await nav();
    const current = within(sections).getByRole("link", { name: "Export / import settings" });
    expect(current.getAttribute("aria-current")).toBe("page");
    // The entry was measured to bring it into view.
    await waitFor(() =>
      expect(reveal.mock.contexts.some((element) => element === current)).toBe(true),
    );
    reveal.mockRestore();
  });

  it("does not break on a section address with a quote in it", async () => {
    await openAdmin('/settings/a"b', { isServerAdmin: true });
    const sections = await nav();
    expect(within(sections).getByRole("link", { name: "General" })).toBeTruthy();
    expect(within(sections).queryByRole("link", { current: "page" })).toBeNull();
  });

  it("moves between sections with the arrow keys", async () => {
    const { user } = await openAdmin("/settings/appearance", { isServerAdmin: true });
    const sections = await nav();
    within(sections).getByRole("link", { name: "Appearance and brand" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("General");
  });

  it("finds a setting by a German word in the English UI and jumps to its row", async () => {
    const { user } = await openAdmin("/settings/profile", { isServerAdmin: true });
    const field = await screen.findByRole("combobox", { name: "Search settings" });
    await user.type(field, "Aufbewahrung");
    const results = screen.getByRole("listbox", { name: "Matching settings" });
    expect(within(results).getByRole("option", { name: /Audit log retention/ })).toBeTruthy();
    await user.clear(field);
    await user.type(field, "max_rows{Enter}");
    expect(
      await screen.findByRole("heading", { level: 2, name: "Data sources and targets" }),
    ).toBeTruthy();
    await waitFor(async () =>
      expect((await row("datasources.max_rows")).className).toContain("settings-row--found"),
    );
  });

  it("says when nothing matches", async () => {
    const { user } = await openAdmin("/settings/profile", { isServerAdmin: true });
    await user.type(await screen.findByRole("combobox", { name: "Search settings" }), "zzqx");
    expect(screen.getByText("No setting matches “zzqx”.")).toBeTruthy();
  });

  it("leads the old addresses to their sections", async () => {
    await openAdmin("/admin/server/settings", { isServerAdmin: true });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Appearance and brand" }),
    ).toBeTruthy();
  });

  it("keeps the link to one setting through an old address", async () => {
    const { location } = await openAdmin("/admin/server/settings#appearance.product_name", {
      isServerAdmin: true,
    });
    await waitFor(() => expect(location().pathname).toBe("/settings/appearance"));
    expect(location().hash).toBe("appearance.product_name");
    const sections = await nav();
    expect(
      within(sections)
        .getByRole("link", { name: "Appearance and brand" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("shows the sign-in page in the server's default theme when the visitor chose none", async () => {
    const server = installFakeServer({ signedIn: false });
    server.state.branding.defaultTheme = "dark";
    renderApp("/login");
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    // Not remembered: a later default reaches the visitor too.
    expect(window.localStorage.getItem("kalzit.theme")).toBeNull();
  });

  it("places every setting of the registry in a section", () => {
    const placed = new Set(SECTIONS.flatMap((section) => section.keys ?? []));
    expect(generatedUnion("SettingKey").filter((key) => !placed.has(key as never))).toEqual([]);
  });

  it("searches only sections the user may open", () => {
    const access = {
      permissions: { has: () => false, isServerAdmin: false, loaded: true },
      orgId: undefined,
    };
    const index = buildIndex(SECTIONS, access);
    expect(search(index, "smtp")).toEqual([]);
    expect(search(index, "Tastenkürzel")[0]?.sectionId).toBe("shortcuts");
  });
});

describe("server settings rows", () => {
  it("shows the source of locked values as a badge", async () => {
    await openAdmin("/settings/datasources", { isServerAdmin: true });
    await screen.findByRole("heading", { level: 2, name: "Data sources and targets" });
    const timeout = within(await row("datasources.query_timeout_secs"));
    // One short word as the badge; the lock line says where the value is set.
    expect(timeout.getByText("locked")).toBeTruthy();
    expect(timeout.queryByText(/from kalzit\.toml/)).toBeNull();
    // The control stays, turned off, with the sentence that says where the value is set.
    const field = timeout.getByRole("spinbutton") as HTMLInputElement;
    expect(field.value).toBe("30");
    expect(field.matches(":disabled")).toBe(true);
    const hint = timeout.getByText(
      "Set in kalzit.toml. Change it there; it cannot be changed here.",
    );
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
    const free = within(await row("datasources.max_rows")).getByRole("spinbutton");
    expect(free.matches(":disabled")).toBe(false);
  });

  it("commits nothing from a locked value, so there is nothing to undo", async () => {
    const { user, server } = await openAdmin("/settings/datasources", { isServerAdmin: true });
    const timeout = within(await row("datasources.query_timeout_secs"));
    const field = timeout.getByRole("spinbutton");
    await user.click(field);
    await user.keyboard("45{Enter}");
    expect(sent(server, "PATCH")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("names where a value from the environment or the configuration only is set", async () => {
    await openAdmin("/settings/storage", { isServerAdmin: true });
    const retention = within(await row("audit.retention_days"));
    expect(
      retention.getByText(/^Set by an environment variable \(KALZIT_\*\)\. Change it there/),
    ).toBeTruthy();
    expect(retention.getByRole("spinbutton").matches(":disabled")).toBe(true);
  });

  it("names a long choice in the select's title, so a cut value stays readable", async () => {
    const long = "America/Argentina/ComodRivadavia";
    await openAdmin("/settings/general", {
      isServerAdmin: true,
      setup: (admin) => {
        admin.serverSettings.push({
          key: "appearance.time_zone",
          scope: "server",
          value: long,
          default: "browser",
          source: "database",
          editable: true,
          version: 1,
          description: "",
          updatedAt: null,
          updatedBy: null,
        });
      },
    });
    const zone = (await screen.findByRole("combobox", {
      name: "Time zone",
    })) as HTMLSelectElement;
    expect(zone.value).toBe(long);
    expect(zone.title).toBe(long);
    expect(zone.classList.contains("settings-select")).toBe(true);
  });

  it("keeps the update settings on the Updates page and links there", async () => {
    await openAdmin("/settings/updates", { isServerAdmin: true });
    await screen.findByRole("heading", { level: 2, name: "Updates" });
    expect(screen.getByText(/^Channel, daily check and maintenance window are set/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Updates" }).getAttribute("href")).toBe(
      "/admin/server/updates",
    );
    expect(document.getElementById("updates.channel")).toBeNull();
  });

  it("shows the query cache now and empties it", async () => {
    const { user, server, admin } = await openAdmin("/settings/datasources", {
      isServerAdmin: true,
    });
    const status = await screen.findByText(/12 answers kept/);
    expect(status.textContent).toBe(
      "12 answers kept, 3.4 MB of 268.4 MB. 75% of 40 loads came from the cache (30) since the server started.",
    );
    await user.click(screen.getByRole("button", { name: "Empty cache" }));
    await waitFor(() => expect(admin.queryCache.entries).toBe(0));
    expect(sent(server, "DELETE")).toEqual(["/api/admin/query-cache"]);
    expect(await screen.findByText(/^0 answers kept/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Empty cache" })).toHaveProperty("disabled", true);
  });

  it("names a value from the environment and one from the configuration only", async () => {
    await openAdmin("/settings/storage", { isServerAdmin: true });
    await screen.findByRole("heading", { level: 2, name: "Storage and retention" });
    const retention = within(await row("audit.retention_days"));
    expect(retention.getByText("locked")).toBeTruthy();
    expect(retention.getByText(/^Set by an environment variable/)).toBeTruthy();
  });

  it("focuses a locked row when a search jumps to it", async () => {
    await openAdmin("/settings/datasources#datasources.query_timeout_secs", {
      isServerAdmin: true,
    });
    const timeout = await row("datasources.query_timeout_secs");
    // Its control is turned off and cannot take the focus, so the row does.
    await waitFor(() => expect(document.activeElement).toBe(timeout));
  });

  it("puts the update settings found by search on the Updates page", () => {
    const access = {
      permissions: { has: () => true, isServerAdmin: true, loaded: true },
      orgId: undefined,
    };
    const index = buildIndex(SECTIONS, access);
    const found = search(index, "updates.window")[0];
    expect(found).toMatchObject({ rowId: "updates.window", page: "/admin/server/updates" });
    expect(search(index, "updates.keep_versions")[0]?.page).toBeUndefined();
  });

  it("applies the default theme at once, with undo", async () => {
    const { user, admin, server } = await openAdmin("/settings/appearance", {
      isServerAdmin: true,
    });
    const theme = await screen.findByRole("radiogroup", { name: "Default theme" });
    expect(
      within(theme)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["Light", "Dark", "System", "High contrast"]);
    await user.click(within(theme).getByRole("radio", { name: "Dark" }));
    expect(await screen.findByText("“Default theme” was saved.")).toBeTruthy();
    const stored = admin.serverSettings.find((s) => s.key === "appearance.default_theme");
    expect(stored).toMatchObject({ value: "dark", version: 1 });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    // It had no value of its own: undo resets it rather than storing a copy of the default.
    await waitFor(() =>
      expect(stored).toMatchObject({ value: "system", version: 2, source: "default" }),
    );
    const batches = server.calls.filter((call) => call.path === "/api/admin/settings/batch");
    expect(batches.at(-1)?.body).toEqual({
      changes: [{ key: "appearance.default_theme", reset: true, version: 1 }],
    });
  });

  it("sends a change made while another is saving afterwards, instead of dropping it", async () => {
    const { user, admin } = await openAdmin("/settings/appearance", { isServerAdmin: true });
    const theme = await screen.findByRole("radiogroup", { name: "Default theme" });
    // Hold the first save on its way.
    const fake = globalThis.fetch;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first && init?.method === "PATCH") {
        first = false;
        await held;
      }
      return fake(input, init);
    });
    try {
      await user.click(within(theme).getByRole("radio", { name: "Dark" }));
      await user.click(within(theme).getByRole("radio", { name: "Light" }));
      release();
      const stored = admin.serverSettings.find((s) => s.key === "appearance.default_theme");
      // The second change goes after the first, over the version the first one saved.
      await waitFor(() => expect(stored).toMatchObject({ value: "light", version: 2 }));
    } finally {
      vi.stubGlobal("fetch", fake);
    }
  });

  /** Holds the first PATCH until `release` is called; restore with `vi.stubGlobal("fetch", fake)`. */
  function holdFirstPatch() {
    const fake = globalThis.fetch;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first && init?.method === "PATCH") {
        first = false;
        await held;
      }
      return fake(input, init);
    });
    return { fake, release: () => release() };
  }

  it("drops a waiting change of a setting whose save failed, and sends no second save", async () => {
    const { user, admin, server } = await openAdmin("/settings/appearance", {
      isServerAdmin: true,
    });
    const theme = await screen.findByRole("radiogroup", { name: "Default theme" });
    const { fake, release } = holdFirstPatch();
    try {
      await user.click(within(theme).getByRole("radio", { name: "Dark" }));
      await user.click(within(theme).getByRole("radio", { name: "Light" }));
      server.failNext("/api/admin/settings/appearance.default_theme", 503, "busy", "PATCH");
      release();
      expect(await screen.findByText(/server is busy/)).toBeTruthy();
      const stored = admin.serverSettings.find((s) => s.key === "appearance.default_theme");
      expect(stored).toMatchObject({ value: "system", version: 0 });
      expect(sent(server, "PATCH")).toHaveLength(1);
    } finally {
      vi.stubGlobal("fetch", fake);
    }
  });

  it("drops a waiting change when its setting's save ends in the conflict dialog", async () => {
    const { user, admin, server } = await openAdmin("/settings/appearance", {
      isServerAdmin: true,
    });
    const theme = await screen.findByRole("radiogroup", { name: "Default theme" });
    const stored = admin.serverSettings.find((s) => s.key === "appearance.default_theme");
    if (stored === undefined) {
      throw new Error("fixture setting missing");
    }
    const { fake, release } = holdFirstPatch();
    try {
      await user.click(within(theme).getByRole("radio", { name: "Dark" }));
      await user.click(within(theme).getByRole("radio", { name: "Light" }));
      // Someone else saves first.
      Object.assign(stored, { value: "contrast", version: 4, source: "database" });
      release();
      expect(await screen.findByRole("dialog")).toBeTruthy();
      // Only the first save was sent; the waiting one did not go over the stored value.
      expect(sent(server, "PATCH")).toHaveLength(1);
      expect(stored).toMatchObject({ value: "contrast", version: 4 });
    } finally {
      vi.stubGlobal("fetch", fake);
    }
  });

  it("applies a changed default theme to the open app, and takes it back with undo", async () => {
    const { user } = await openAdmin("/settings/appearance", { isServerAdmin: true });
    const theme = await screen.findByRole("radiogroup", { name: "Default theme" });
    await user.click(within(theme).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("system"));
  });

  it("says a personal theme wins over the default, and keeps it", async () => {
    const { user, server } = await openAdmin("/settings/appearance", {
      isServerAdmin: true,
      setupServer: (fake) => {
        fake.state.preferences.theme = "light";
      },
    });
    const theme = await screen.findByRole("radiogroup", { name: "Default theme" });
    const note = await screen.findByText(/You use your own theme/);
    expect(within(note).getByRole("link", { name: "Profile" }).getAttribute("href")).toBe(
      "/settings/profile",
    );
    await user.click(within(theme).getByRole("radio", { name: "Dark" }));
    await screen.findByText("“Default theme” was saved.");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(server.state.preferences.theme).toBe("light");
  });

  it("saves a number on Enter once, and shows a rejected value at the field", async () => {
    const { user, admin, server } = await openAdmin("/settings/datasources", {
      isServerAdmin: true,
    });
    await screen.findByRole("heading", { level: 2, name: "Data sources and targets" });
    const field = within(await row("datasources.max_rows")).getByRole(
      "spinbutton",
    ) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, "5000{Enter}");
    await waitFor(() =>
      expect(admin.serverSettings.find((s) => s.key === "datasources.max_rows")?.value).toBe(5000),
    );
    await user.tab();
    expect(sent(server, "PATCH")).toEqual(["/api/admin/settings/datasources.max_rows"]);
    await user.clear(field);
    await user.type(field, "0{Enter}");
    expect(
      await screen.findByText("The server did not accept this value. Check it and try again."),
    ).toBeTruthy();
  });

  it("does not save on the Enter that confirms an input method's candidate", async () => {
    const { user, server } = await openAdmin("/settings/datasources", { isServerAdmin: true });
    await screen.findByRole("heading", { level: 2, name: "Data sources and targets" });
    const field = within(await row("datasources.max_rows")).getByRole("spinbutton");
    await user.clear(field);
    await user.type(field, "7");
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(sent(server, "PATCH")).toEqual([]);
  });

  it("refuses a custom accent without enough contrast before sending it", async () => {
    const { user, server } = await openAdmin("/settings/appearance", {
      isServerAdmin: true,
      setup: (admin) => {
        admin.serverSettings.push({
          ...structuredClone(admin.serverSettings[2]),
          key: "appearance.accent",
          value: "copper",
          default: "copper",
        } as (typeof admin.serverSettings)[number]);
      },
    });
    await user.click(await screen.findByRole("radio", { name: "Custom…" }));
    const dialog = await screen.findByRole("dialog", { name: "Custom accent color" });
    const hex = within(dialog).getByRole("textbox", { name: "Color code" });
    await user.clear(hex);
    await user.type(hex, "#ffd400");
    expect(within(dialog).getByText(/Too little contrast/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Use color" }));
    expect(sent(server, "PATCH")).toEqual([]);
    await user.clear(hex);
    await user.type(hex, "#2563eb");
    await user.click(within(dialog).getByRole("button", { name: "Use color" }));
    await waitFor(() =>
      expect(sent(server, "PATCH")).toEqual(["/api/admin/settings/appearance.accent"]),
    );
  });
});

describe("organization settings", () => {
  it("chooses the default time range with the picker, with undo", async () => {
    const { user, admin } = await openAdmin("/admin/settings");
    const picker = await screen.findByRole("button", { name: "Default time range: Last 6 hours" });
    await user.click(picker);
    const dialog = await screen.findByRole("dialog", { name: "Time range" });
    await user.click(within(dialog).getByRole("button", { name: "Last 24 hours" }));
    expect(await screen.findByText("“Default time range” was saved.")).toBeTruthy();
    expect(admin.orgSettings[0]).toMatchObject({ value: { from: "now-24h", to: "now" } });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(admin.orgSettings[0]).toMatchObject({
        value: { from: "now-6h", to: "now" },
        version: 2,
      }),
    );
  });

  it("names the setting and both values in the conflict dialog", async () => {
    const { user, admin } = await openAdmin("/settings/organization");
    const picker = await screen.findByRole("button", { name: "Default time range: Last 6 hours" });
    Object.assign(admin.orgSettings[0] ?? {}, {
      value: { from: "now-30d", to: "now" },
      version: 2,
    });
    await user.click(picker);
    const ranges = await screen.findByRole("dialog", { name: "Time range" });
    await user.click(within(ranges).getByRole("button", { name: "Last 2 days" }));
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(within(dialog).getByText("Last 30 days")).toBeTruthy();
    expect(within(dialog).getByText("Last 2 days")).toBeTruthy();
  });

  it("shows settings read-only without settings:write", async () => {
    await openAdmin("/settings/organization", { permissions: ["settings:read"] });
    await screen.findByRole("heading", { level: 2, name: "Organization Analytical Engines" });
    const range = within(await row("org.dashboards.default_time_range"));
    expect(range.getByText("read only")).toBeTruthy();
    expect(range.getByText("Last 6 hours")).toBeTruthy();
    expect(range.queryByRole("button")).toBeNull();
  });
});

describe("export and import", () => {
  it("imports a file after showing its changes, and undoes the import", async () => {
    const { user, admin, server } = await openAdmin("/settings/transfer", { isServerAdmin: true });
    await screen.findByRole("heading", { level: 2, name: "Export / import settings" });
    const file = new File(
      [
        JSON.stringify({
          format: "kalzit.settings",
          formatVersion: 1,
          scope: "server",
          settings: {
            "datasources.max_rows": 500,
            "appearance.default_theme": "system",
            "audit.retention_days": 9,
          },
        }),
      ],
      "settings.json",
      { type: "application/json" },
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) {
      throw new Error("no file input");
    }
    await user.upload(input, file);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Will change")).toBeTruthy();
    expect(within(table).getByText("Unchanged")).toBeTruthy();
    expect(within(table).getByText("Locked")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Apply 1 changes" }));
    expect(await screen.findByText("1 settings were imported.")).toBeTruthy();
    const rows = admin.serverSettings.find((s) => s.key === "datasources.max_rows");
    expect(rows).toMatchObject({ value: 500, version: 1 });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    // The setting had no value of its own, so undo resets it instead of storing the default;
    // the version keeps counting.
    await waitFor(() =>
      expect(rows).toMatchObject({ value: 100000, version: 2, source: "default" }),
    );
    const batches = server.calls.filter((call) => call.path === "/api/admin/settings/batch");
    expect(batches.at(-1)?.body).toEqual({
      changes: [{ key: "datasources.max_rows", reset: true, version: 1 }],
    });
  });

  it("undoes a logo upload and a removal", async () => {
    const { user, server } = await openAdmin("/settings/appearance", { isServerAdmin: true });
    const input = await waitFor(() => {
      const element = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (element === null) {
        throw new Error("no file input");
      }
      return element;
    });
    await user.upload(
      input,
      new File([new Uint8Array([137, 80, 78, 71])], "logo.png", { type: "image/png" }),
    );
    expect(await screen.findByText("The logo was saved.")).toBeTruthy();
    expect(server.state.branding.logo).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("The change to the logo was undone.")).toBeTruthy();
    expect(server.state.branding.logo).toBeNull();
    expect(sent(server, "POST")).toContain("/api/admin/branding/logo/restore");
  });

  it("refuses a file that is not JSON", async () => {
    const { user } = await openAdmin("/settings/transfer", { isServerAdmin: true });
    await screen.findByRole("heading", { level: 2, name: "Export / import settings" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      input as HTMLInputElement,
      new File(["nope"], "x.json", { type: "application/json" }),
    );
    expect(await screen.findByText("The file is not valid JSON.")).toBeTruthy();
  });
});

describe("accent contrast", () => {
  it("matches the server's rules for the shared cases", () => {
    // server/src/appearance.rs, CASES: color, passes, dark label.
    const cases: [string, boolean, boolean][] = [
      ["#2563eb", true, false],
      ["#0f766e", true, false],
      ["#1e3a8a", false, false],
      ["#7c3aed", true, false],
      ["#e5534b", true, true],
      ["#ffffff", false, true],
      ["#000000", false, false],
      ["#808080", true, true],
      ["#ffd400", false, true],
    ];
    for (const [hex, passes, dark] of cases) {
      const check = checkAccent(hex);
      expect(check?.passes, hex).toBe(passes);
      expect(check?.darkLabel, hex).toBe(dark);
    }
    expect(checkAccent("red")).toBeNull();
  });
});
