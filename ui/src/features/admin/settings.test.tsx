import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FakeAdminState } from "./test/fakeAdmin";
import { openAdmin, sent } from "./test/openAdmin";

const RANGE = "dashboards.default_time_range";
const RANGE_LABEL = "Default time range";
/** A setting whose value is JSON, shown as a JSON field: one a newer server could add. */
const JSON_KEY = "future.limits";

async function fieldOf(key: string) {
  return (await screen.findByLabelText(key)) as HTMLInputElement;
}

/** The organization's settings with a JSON setting next to the time range, as index 1. */
function withJsonSetting(admin: FakeAdminState): void {
  admin.orgSettings.push({
    ...structuredClone(admin.orgSettings[0]),
    key: JSON_KEY,
    value: { rows: 10 },
    default: { rows: 10 },
    description: "Limits from a newer server.",
  } as (typeof admin.orgSettings)[number]);
}

function openJson() {
  return openAdmin("/admin/settings", { setup: withJsonSetting });
}

describe("organization settings", () => {
  it("chooses the default time range with the time range picker, with undo", async () => {
    const { user, admin } = await openAdmin("/admin/settings");
    const picker = await screen.findByRole("button", {
      name: "Default time range: Last 6 hours",
    });
    expect(screen.getByText("Default: Last 6 hours")).toBeTruthy();
    await user.click(picker);
    const dialog = await screen.findByRole("dialog", { name: "Time range" });
    await user.click(within(dialog).getByRole("button", { name: "Last 24 hours" }));
    expect(await screen.findByText("“Default time range” was saved.")).toBeTruthy();
    expect(admin.orgSettings[0]).toMatchObject({ value: { from: "now-24h", to: "now" } });
    expect(
      await screen.findByRole("button", { name: "Default time range: Last 24 hours" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(admin.orgSettings[0]).toMatchObject({
        value: { from: "now-6h", to: "now" },
        version: 2,
      }),
    );
  });

  it("names the setting and both ranges in the conflict dialog", async () => {
    const { user, admin } = await openAdmin("/admin/settings");
    const picker = await screen.findByRole("button", {
      name: "Default time range: Last 6 hours",
    });
    Object.assign(admin.orgSettings[0] ?? {}, {
      value: { from: "now-30d", to: "now" },
      version: 2,
    });
    await user.click(picker);
    const ranges = await screen.findByRole("dialog", { name: "Time range" });
    await user.click(within(ranges).getByRole("button", { name: "Last 2 days" }));
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(within(dialog).getByText(/Someone else saved “Default time range”/)).toBeTruthy();
    expect(within(dialog).getByText("Last 30 days")).toBeTruthy();
    expect(within(dialog).getByText("Last 2 days")).toBeTruthy();
  });

  it("applies a JSON value when the field is left, with undo", async () => {
    const { user, admin } = await openJson();
    const field = await fieldOf(JSON_KEY);
    expect(field.value).toBe('{"rows":10}');
    await user.clear(field);
    await user.click(field);
    await user.paste('{"rows":20}');
    await user.tab();
    expect(await screen.findByText(`“${JSON_KEY}” was saved.`)).toBeTruthy();
    expect(admin.orgSettings[1]).toMatchObject({ value: { rows: 20 }, version: 1 });

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(admin.orgSettings[1]).toMatchObject({ value: { rows: 10 }, version: 2 }),
    );
    // The field stays the same element across saves, so focus is not lost.
    await waitFor(() =>
      expect((screen.getByLabelText(JSON_KEY) as HTMLInputElement).value).toBe('{"rows":10}'),
    );
    expect(screen.getByLabelText(JSON_KEY)).toBe(field);
  });

  it("undoes with the version the change produced, so a change in between is a conflict", async () => {
    const { user, admin } = await openJson();
    const field = await fieldOf(JSON_KEY);
    await user.clear(field);
    await user.click(field);
    await user.paste('{"rows":30}');
    await user.tab();
    await screen.findByText(`“${JSON_KEY}” was saved.`);
    // Someone else saves after this change and before the undo.
    Object.assign(admin.orgSettings[1] ?? {}, { value: { rows: 70 }, version: 5 });
    await user.click(screen.getByRole("button", { name: "Undo" }));
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(within(dialog).getByText('{"rows":70}')).toBeTruthy();
    expect(admin.orgSettings[1]?.version).toBe(5);
  });

  it("shows what changed on a version conflict and keeps the stored value", async () => {
    const { user, admin } = await openJson();
    const field = await fieldOf(JSON_KEY);
    Object.assign(admin.orgSettings[1] ?? {}, { value: { rows: 300 }, version: 2 });
    await user.clear(field);
    await user.click(field);
    await user.paste('{"rows":2}');
    await user.tab();

    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(within(dialog).getByText('{"rows":300}')).toBeTruthy();
    expect(within(dialog).getByText('{"rows":2}')).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Keep saved value" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Keep saved value" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(field.value).toBe('{"rows":300}'));
    expect(admin.orgSettings[1]?.version).toBe(2);
  });

  it("overwrites on a version conflict only when asked to", async () => {
    const { user, admin } = await openJson();
    const field = await fieldOf(JSON_KEY);
    Object.assign(admin.orgSettings[1] ?? {}, { value: { rows: 300 }, version: 2 });
    await user.clear(field);
    await user.click(field);
    await user.paste('{"rows":2}');
    await user.tab();
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    await user.click(within(dialog).getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() =>
      expect(admin.orgSettings[1]).toMatchObject({ value: { rows: 2 }, version: 3 }),
    );
  });

  it("takes the stored value from the conflict answer, without reading the list first", async () => {
    const { user, admin, server } = await openJson();
    const field = await fieldOf(JSON_KEY);
    Object.assign(admin.orgSettings[1] ?? {}, { value: { rows: 900 }, version: 4 });
    // The list would answer something else; the dialog must show the conflict's `current`.
    server.failNext("/api/orgs/o1/settings", 500, "internal", "GET");
    await user.clear(field);
    await user.click(field);
    await user.paste('{"rows":2}');
    await user.tab();
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(within(dialog).getByText('{"rows":900}')).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() => expect(admin.orgSettings[1]?.version).toBe(5));
  });

  it("reports an error instead of a stale conflict when the answer has no stored value", async () => {
    const { user, server } = await openJson();
    const field = await fieldOf(JSON_KEY);
    server.failNext(`/api/orgs/o1/settings/${JSON_KEY}`, 409, "version_conflict", "PATCH");
    await user.clear(field);
    await user.click(field);
    await user.paste('{"rows":2}');
    await user.tab();
    expect(await screen.findByText(/The server sent an unexpected response/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("rejects text that is not JSON without sending it", async () => {
    const { user, server } = await openJson();
    const field = await fieldOf(JSON_KEY);
    await user.clear(field);
    await user.type(field, "last week");
    await user.tab();
    expect(await screen.findByText("Enter a valid JSON value.")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(sent(server, "PATCH")).toEqual([]);
  });

  it("shows a value the server rejects at its field", async () => {
    const { user } = await openJson();
    const field = await fieldOf(JSON_KEY);
    await user.clear(field);
    await user.type(field, "42");
    await user.tab();
    expect(
      await screen.findByText("The server did not accept this value. Check it and try again."),
    ).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the label as heading, the key quietly below it, and the description from the catalog", async () => {
    await openAdmin("/admin/settings");
    const list = await screen.findByRole("list", { name: "Organization settings" });
    const row = within(within(list).getAllByRole("listitem")[0] as HTMLElement);
    expect(row.getByText(RANGE_LABEL).tagName).toBe("LABEL");
    expect(row.getByText(RANGE).tagName).toBe("CODE");
    expect(row.getByText(RANGE).getAttribute("translate")).toBe("no");
    expect(row.getByText("Time range of new dashboards in this organization.")).toBeTruthy();
    // The fake server's English description is not shown for a setting the UI knows.
    expect(row.queryByText(`The setting ${RANGE}`)).toBeNull();
  });

  it("falls back to the key and the server's description for a setting the UI does not know", async () => {
    await openAdmin("/admin/settings", {
      setup: (admin) => {
        admin.orgSettings.push({
          ...structuredClone(admin.orgSettings[0]),
          key: "future.setting",
          value: 3,
          default: 3,
          description: "A setting from a newer server.",
        } as (typeof admin.orgSettings)[number]);
      },
    });
    const field = await fieldOf("future.setting");
    expect(field.value).toBe("3");
    const description = screen.getByText("A setting from a newer server.");
    expect(description.getAttribute("lang")).toBe("en");
  });

  it("shows settings read-only without settings:write", async () => {
    await openAdmin("/admin/settings", { permissions: ["settings:read"] });
    const list = await screen.findByRole("list", { name: "Organization settings" });
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).queryByRole("button")).toBeNull();
    expect(within(list).getByText("Last 6 hours")).toBeTruthy();
    expect(within(list).getByText("You can see this setting, but not change it.")).toBeTruthy();
  });
});

describe("server settings", () => {
  it("shows where each value comes from and why it is read-only", async () => {
    await openAdmin("/admin/server/settings", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Server settings" });
    const rows = within(list).getAllByRole("listitem");
    const row = (index: number) => within(rows[index] as HTMLElement);
    expect(row(0).getByText("Environment")).toBeTruthy();
    expect(row(0).getByText(/Set by an environment variable/)).toBeTruthy();
    expect(row(0).queryByRole("spinbutton")).toBeNull();
    expect(row(1).getByText("Configuration file")).toBeTruthy();
    expect(row(1).getByText(/Set in the configuration file/)).toBeTruthy();
    expect(row(2).getByText("Default")).toBeTruthy();
    expect(row(3).getByRole("spinbutton")).toBeTruthy();
    // Session settings live in the configuration and are never changeable in the UI.
    expect(row(4).getByText(/Only the configuration file/)).toBeTruthy();
  });

  it("offers settings with fixed choices as a select with readable names", async () => {
    const { user, admin } = await openAdmin("/admin/server/settings", { isServerAdmin: true });
    const theme = await screen.findByLabelText("Default theme");
    expect(
      within(theme)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["System", "Light", "Dark", "High contrast"]);
    await user.selectOptions(theme, "dark");
    expect(await screen.findByText("“Default theme” was saved.")).toBeTruthy();
    expect(admin.serverSettings[2]).toMatchObject({ value: "dark", version: 1 });
  });

  it("saves a number on Enter once, and shows a rejected value at the field", async () => {
    const { user, admin, server } = await openAdmin("/admin/server/settings", {
      isServerAdmin: true,
    });
    const rows = await fieldOf("Maximum rows per query");
    await user.clear(rows);
    await user.type(rows, "5000{Enter}");
    await waitFor(() => expect(admin.serverSettings[3]?.value).toBe(5000));
    // The blur after Enter must not send the same change again.
    await user.tab();
    expect(sent(server, "PATCH")).toEqual(["/api/admin/settings/datasources.max_rows"]);

    await user.clear(rows);
    await user.type(rows, "0{Enter}");
    expect(
      await screen.findByText("The server did not accept this value. Check it and try again."),
    ).toBeTruthy();
  });

  it("does not save on the Enter that confirms an input method's candidate", async () => {
    const { user, server } = await openAdmin("/admin/server/settings", { isServerAdmin: true });
    const rows = await fieldOf("Maximum rows per query");
    await user.clear(rows);
    await user.type(rows, "7");
    rows.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );
    expect(sent(server, "PATCH")).toEqual([]);
  });

  it("is not offered to members who are not server admins", async () => {
    await openAdmin("/admin/server/settings", { isServerAdmin: false });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    const sections = screen.getByRole("list", { name: "Administration sections" });
    expect(within(sections).queryByRole("link", { name: "Server settings" })).toBeNull();
  });
});
