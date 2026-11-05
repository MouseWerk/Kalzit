import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHORTCUT_AREAS } from "../../shell/ShortcutsHelp";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { emptyModel, type PanelModel } from "./model";
import { clearCopiedPanel, panelShortcutOf } from "./panelShortcuts";
import { addDashboard } from "./test/fakeDashboards";

const panel = (id: string, title: string, extra: Partial<PanelModel> = {}): PanelModel => ({
  id,
  type: "table",
  title,
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
  transformations: [],
  options: {},
  fieldConfig: {},
  ...extra,
});

function setup() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addDashboard(server.areas.dashboards, "d-main", {
    ...emptyModel("Main"),
    panels: [panel("p1", "Orders"), panel("p2", "Stock", { grid: { x: 12, y: 0, w: 12, h: 8 } })],
  });
  return server;
}

afterEach(() => clearCopiedPanel());

async function openEditing() {
  const rendered = renderApp("/dashboards/d-main?edit=true");
  const card = await screen.findByRole("article", { name: "Orders" });
  return { ...rendered, card };
}

/** Selects the panel by a click on its body (the header starts a drag). */
async function select(user: ReturnType<typeof renderApp>["user"], card: HTMLElement) {
  await user.click(card.querySelector(".panel-card__body") as HTMLElement);
}

const count = (name: string) => screen.queryAllByRole("article", { name }).length;
const rail = () => screen.getByRole("complementary", { name: "Dashboard tools" });

describe("edit mode after its board", () => {
  it("shows an Editing tag and the board's button labels, not a status paragraph", async () => {
    setup();
    await openEditing();
    const tag = document.querySelector(".dashboard__tag");
    expect(tag?.textContent).toBe("Editing");
    // The tag sits in a live region, so entering edit mode is announced.
    expect(tag?.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(/^Edit mode/)).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish editing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save dashboard" })).toHaveProperty("disabled", true);
    expect(within(rail()).getByRole("button", { name: "Dashboard settings" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "Export (JSON)" })).toBeTruthy();
  });

  it("names the rail's tools as the board does", async () => {
    setup();
    renderApp("/dashboards/d-main");
    await screen.findByRole("article", { name: "Orders" });
    for (const name of [
      "Outline",
      "Filters and variables",
      "Annotations on/off",
      "Share and copy link",
      "Export (JSON)",
      "Full screen",
      "Versions and history",
      "Dashboard info",
    ]) {
      expect(within(rail()).getByRole("button", { name })).toBeTruthy();
    }
  });

  it("opens the Add pane from the button at the end of the canvas", async () => {
    setup();
    const { user } = await openEditing();
    await user.click(screen.getByRole("button", { name: "Add panel or row" }));
    const pane = screen.getByRole("region", { name: "Add" });
    expect(document.activeElement).toBe(within(pane).getByRole("searchbox"));
    expect(within(pane).getByRole("button", { name: /^Row/ })).toBeTruthy();
  });

  it("has no add button at the canvas' end outside edit mode", async () => {
    setup();
    renderApp("/dashboards/d-main");
    await screen.findByRole("article", { name: "Orders" });
    expect(screen.queryByRole("button", { name: "Add panel or row" })).toBeNull();
    expect(document.querySelector(".dashboard__tag")).toBeNull();
  });
});

describe("panel shortcuts while editing", () => {
  it("duplicates the selected panel with Ctrl+D, and Undo takes the copy back", async () => {
    setup();
    const { user, card } = await openEditing();
    await select(user, card);
    await user.keyboard("{Control>}d{/Control}");
    await waitFor(() => expect(count("Orders")).toBe(2));
    expect(await screen.findByText("Duplicated “Orders”.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save dashboard" })).toHaveProperty(
      "disabled",
      false,
    );
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(count("Orders")).toBe(1));
  });

  it("deletes the focused panel with Delete, and Undo puts it back", async () => {
    setup();
    const { user } = await openEditing();
    const stock = screen.getByRole("article", { name: "Stock" });
    within(stock).getByRole("button", { name: "Panel menu of “Stock”" }).focus();
    await user.keyboard("{Delete}");
    await waitFor(() => expect(screen.queryByRole("article", { name: "Stock" })).toBeNull());
    expect(await screen.findByText("Deleted “Stock”.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("article", { name: "Stock" })).toBeTruthy();
    expect([count("Orders"), count("Stock")]).toEqual([1, 1]);
  });

  it("copies with Ctrl+C and pastes with Ctrl+V, also from the Add pane", async () => {
    setup();
    const { user, card } = await openEditing();
    await select(user, card);
    await user.keyboard("{Control>}c{/Control}");
    expect(
      await screen.findByText("Copied “Orders”. Paste it with Ctrl+V, in another dashboard too."),
    ).toBeTruthy();
    await user.keyboard("{Control>}v{/Control}");
    await waitFor(() => expect(count("Orders")).toBe(2));
    expect(await screen.findByText("Pasted “Orders”.")).toBeTruthy();

    await user.click(within(rail()).getByRole("button", { name: "Add" }));
    const pane = screen.getByRole("region", { name: "Add" });
    await user.click(within(pane).getByRole("button", { name: /^Paste copied panel/ }));
    await waitFor(() => expect(count("Orders")).toBe(3));
  });

  it("opens the selected panel in the editor with E", async () => {
    setup();
    const { user, card, location } = await openEditing();
    await select(user, card);
    await user.keyboard("e");
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main/panels/p1/edit"));
  });

  it("leaves keys typed into a field alone", async () => {
    setup();
    const { user, card } = await openEditing();
    await select(user, card);
    const filter = within(screen.getByRole("navigation", { name: "Outline" })).getByRole(
      "searchbox",
      { name: "Filter panels" },
    );
    await user.click(filter);
    await user.keyboard("e{Delete}{Control>}d{/Control}");
    expect([count("Orders"), count("Stock")]).toEqual([1, 1]);
    expect(screen.queryByRole("region", { name: "Edit panel" })).toBeNull();
  });

  it("does nothing outside edit mode", async () => {
    setup();
    const { user } = renderApp("/dashboards/d-main");
    const stock = await screen.findByRole("article", { name: "Stock" });
    within(stock).getByRole("button", { name: "Panel menu of “Stock”" }).focus();
    await user.keyboard("{Delete}{Control>}d{/Control}");
    expect([count("Orders"), count("Stock")]).toEqual([1, 1]);
  });

  it("are listed in the shortcut help", () => {
    const area = SHORTCUT_AREAS.find((a) => a.title === "shell.shortcuts.area.dashboards");
    expect(area?.shortcuts.map((s) => s.label)).toEqual(
      expect.arrayContaining([
        "shell.shortcuts.panelEdit",
        "shell.shortcuts.panelDuplicate",
        "shell.shortcuts.panelCopy",
        "shell.shortcuts.panelPaste",
        "shell.shortcuts.panelRemove",
      ]),
    );
  });
});

describe("panelShortcutOf", () => {
  const press = (init: KeyboardEventInit, target: Element = document.body) => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: target });
    return event;
  };

  it("reads Ctrl on Windows and Linux, Cmd on macOS", () => {
    expect(panelShortcutOf(press({ key: "d", ctrlKey: true }), false)).toBe("duplicate");
    expect(panelShortcutOf(press({ key: "d", metaKey: true }), false)).toBeNull();
    expect(panelShortcutOf(press({ key: "c", metaKey: true }), true)).toBe("copy");
    expect(panelShortcutOf(press({ key: "V", ctrlKey: true }), false)).toBe("paste");
    expect(panelShortcutOf(press({ key: "Delete" }), false)).toBe("remove");
    expect(panelShortcutOf(press({ key: "Backspace" }), false)).toBeNull();
    expect(panelShortcutOf(press({ key: "Backspace" }), true)).toBe("remove");
    expect(panelShortcutOf(press({ key: "e" }), false)).toBe("edit");
    expect(panelShortcutOf(press({ key: "e", shiftKey: true }), false)).toBeNull();
    expect(panelShortcutOf(press({ key: "d", ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it("never fires in fields, editors or widgets with keys of their own", () => {
    const input = document.createElement("input");
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    const grid = document.createElement("div");
    grid.setAttribute("role", "grid");
    const cell = document.createElement("span");
    grid.append(cell);
    for (const target of [input, editor, cell]) {
      expect(panelShortcutOf(press({ key: "Delete" }, target), false)).toBeNull();
    }
  });
});

describe("the inspector's time override", () => {
  it("is a switch that shows the panel's own range and keeps it while switched off", async () => {
    setup();
    const { user, card } = await openEditing();
    await select(user, card);
    const inspector = await screen.findByRole("complementary", { name: "Orders" });
    const toggle = within(inspector).getByRole("switch", { name: "Override time range" });
    expect(toggle).toHaveProperty("checked", false);
    expect(within(inspector).queryByRole("textbox", { name: "Own time range" })).toBeNull();

    await user.click(toggle);
    const from = within(inspector).getByRole("textbox", { name: "Own time range" });
    await user.type(from, "now-24h");
    expect(
      within(inspector).getByText("Applies to this panel only; its title shows the note."),
    ).toBeTruthy();

    await user.click(toggle);
    expect(within(inspector).queryByRole("textbox", { name: "Own time range" })).toBeNull();
    await user.click(toggle);
    expect(within(inspector).getByRole("textbox", { name: "Own time range" })).toHaveProperty(
      "value",
      "now-24h",
    );
  });
});
