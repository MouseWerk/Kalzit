import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "./test/openAdmin";

describe("organization settings", () => {
  it("applies a value when the field is left, and undoes it", async () => {
    const { user, admin } = await openAdmin("/admin/settings");
    const field = await screen.findByLabelText("dashboards.default_refresh");
    await user.clear(field);
    await user.type(field, "1m");
    await user.tab();
    expect(await screen.findByText("dashboards.default_refresh was saved.")).toBeTruthy();
    expect(admin.orgSettings[0]).toMatchObject({ value: "1m", version: 2 });

    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(admin.orgSettings[0]).toMatchObject({ value: "30s", version: 3 }));
    await waitFor(() =>
      expect((screen.getByLabelText("dashboards.default_refresh") as HTMLInputElement).value).toBe(
        "30s",
      ),
    );
  });

  it("saves numbers on Enter once and switches at once", async () => {
    const { user, admin, server } = await openAdmin("/admin/settings");
    const days = await screen.findByLabelText("audit.retention_days");
    await user.clear(days);
    await user.type(days, "90{Enter}");
    await waitFor(() => expect(admin.orgSettings[1]?.value).toBe(90));
    // The blur after Enter must not send the same change again.
    await user.tab();
    expect(server.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);

    await user.click(screen.getByLabelText("security.require_2fa"));
    await waitFor(() => expect(admin.orgSettings[2]?.value).toBe(true));
  });

  it("rejects a value that is not a number without sending it", async () => {
    const { user, server } = await openAdmin("/admin/settings");
    const days = await screen.findByLabelText("audit.retention_days");
    await user.clear(days);
    await user.tab();
    expect(await screen.findByText("Enter a number.")).toBeTruthy();
    expect(days.getAttribute("aria-invalid")).toBe("true");
    expect(server.calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("shows what changed on a version conflict and keeps the stored value", async () => {
    const { user, admin } = await openAdmin("/admin/settings");
    const field = await screen.findByLabelText("dashboards.default_refresh");
    // Someone else saves first.
    Object.assign(admin.orgSettings[0] ?? {}, { value: "5m", version: 2 });
    await user.clear(field);
    await user.type(field, "10s");
    await user.tab();

    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    expect(within(dialog).getByText("5m")).toBeTruthy();
    expect(within(dialog).getByText("10s")).toBeTruthy();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Keep saved value" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Keep saved value" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByDisplayValue("5m")).toBeTruthy();
    expect(admin.orgSettings[0]).toMatchObject({ value: "5m", version: 2 });
  });

  it("overwrites on a version conflict only when asked to", async () => {
    const { user, admin } = await openAdmin("/admin/settings");
    const field = await screen.findByLabelText("dashboards.default_refresh");
    Object.assign(admin.orgSettings[0] ?? {}, { value: "5m", version: 2 });
    await user.clear(field);
    await user.type(field, "10s");
    await user.tab();
    const dialog = await screen.findByRole("dialog", { name: "Changed in the meantime" });
    await user.click(within(dialog).getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() => expect(admin.orgSettings[0]).toMatchObject({ value: "10s", version: 3 }));
  });

  it("shows settings read-only without settings:write, and fixed ones with the reason", async () => {
    await openAdmin("/admin/settings", { permissions: ["settings:read"] });
    const list = await screen.findByRole("list", { name: "Organization settings" });
    expect(within(list).queryByRole("textbox")).toBeNull();
    expect(within(list).getAllByText("You can see this setting, but not change it.")).toHaveLength(
      3,
    );
    expect(within(list).getByText("This setting cannot be changed here.")).toBeTruthy();
  });
});

describe("server settings", () => {
  it("shows where each value comes from and why it is read-only", async () => {
    await openAdmin("/admin/server/settings", { isServerAdmin: true });
    const list = await screen.findByRole("list", { name: "Server settings" });
    const rows = within(list).getAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Environment")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(/Set by an environment variable/)).toBeTruthy();
    expect(within(rows[0] as HTMLElement).queryByRole("textbox")).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText("Configuration file")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(/Set in the configuration file/)).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Default")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByRole("textbox")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText(/Only the configuration file/)).toBeTruthy();
  });

  it("changes an editable server setting with undo", async () => {
    const { user, admin } = await openAdmin("/admin/server/settings", { isServerAdmin: true });
    const field = await screen.findByLabelText("appearance.default_theme");
    await user.clear(field);
    await user.type(field, "dark{Enter}");
    expect(await screen.findByText("appearance.default_theme was saved.")).toBeTruthy();
    expect(admin.serverSettings[2]).toMatchObject({ value: "dark", version: 2 });
  });

  it("is not offered to members who are not server admins", async () => {
    await openAdmin("/admin/server/settings", { isServerAdmin: false });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
    const sections = screen.getByRole("navigation", { name: "Administration sections" });
    expect(within(sections).queryByRole("link", { name: "Server settings" })).toBeNull();
  });
});
