import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { emptyModel, type PanelModel } from "./model";
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

function setup(extra: PanelModel[] = []) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addDashboard(server.areas.dashboards, "d-main", {
    ...emptyModel("Main"),
    rows: [{ id: "r1", title: "Details", collapsed: false }],
    panels: [
      panel("p1", "Orders"),
      ...extra,
      panel("p2", "Stock", { rowId: "r1", grid: { x: 0, y: 0, w: 6, h: 5 } }),
    ],
  });
  return server;
}

/** The inspector of the selected panel: its own landmark beside the outline. */
function inspectorOf(title: string): Promise<HTMLElement> {
  return screen.findByRole("complementary", { name: title });
}

/** Selects a panel from the outline and returns its inspector. */
async function selectFromOutline(user: ReturnType<typeof renderApp>["user"], title: string) {
  // Selecting any panel opens the outline.
  if (screen.queryByRole("navigation", { name: "Outline" }) === null) {
    await user.click(bodyOf(await screen.findByRole("article", { name: "Orders" })));
  }
  const outline = await screen.findByRole("navigation", { name: "Outline" });
  await user.click(within(outline).getByRole("button", { name: new RegExp(`^${title}`) }));
  return inspectorOf(title);
}

async function openEditing() {
  const rendered = renderApp("/dashboards/d-main?edit=true");
  const card = await screen.findByRole("article", { name: "Orders" });
  return { ...rendered, card };
}

/** The card's body: a click there selects the panel (the header starts a drag). */
function bodyOf(card: HTMLElement): HTMLElement {
  return card.querySelector(".panel-card__body") as HTMLElement;
}

describe("selecting a panel while editing", () => {
  it("marks the panel, shows its size and toolbar, and opens the inspector", async () => {
    setup();
    const { user, card } = await openEditing();
    await user.click(bodyOf(card));
    expect(card.getAttribute("aria-current")).toBe("true");
    expect(card.querySelector(".panel-card__size")?.textContent).toBe("12 × 8");
    const toolbar = within(card).getByRole("group", { name: "Actions for Orders" });
    expect(within(toolbar).getByRole("button", { name: "Edit “Orders”" })).toBeTruthy();
    const outline = await screen.findByRole("navigation", { name: "Outline" });
    const inspector = await inspectorOf("Orders");
    expect(outline.contains(inspector)).toBe(false);
    expect(within(inspector).getByText("Table in no row")).toBeTruthy();
    const entry = within(outline).getByRole("button", { name: /^Orders/ });
    expect(entry.getAttribute("aria-current")).toBe("true");
  });

  it("changes title, description, size, transparency and visualization from the inspector", async () => {
    setup();
    const { user, card } = await openEditing();
    await user.click(bodyOf(card));
    const inspector = await inspectorOf("Orders");

    const title = within(inspector).getByRole("textbox", { name: "Panel title" });
    await user.clear(title);
    await user.type(title, "Orders today");
    expect(await screen.findByRole("article", { name: "Orders today" })).toBeTruthy();

    await user.type(within(inspector).getByRole("textbox", { name: "Description" }), "Per day.");
    const renamed = screen.getByRole("article", { name: "Orders today" });
    expect(within(renamed).getByRole("button", { name: "About Orders today" })).toBeTruthy();

    await user.click(within(inspector).getByRole("button", { name: "6 of 24 columns" }));
    await user.click(within(inspector).getByRole("button", { name: "Height larger" }));
    await waitFor(() =>
      expect(renamed.querySelector(".panel-card__size")?.textContent).toBe("6 × 9"),
    );
    expect(
      within(inspector)
        .getByRole("button", { name: "6 of 24 columns" })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    await user.click(within(inspector).getByRole("switch", { name: "Transparent background" }));
    expect(renamed.className).toContain("panel-card--transparent");

    await user.click(within(inspector).getByRole("button", { name: "Stat" }));
    expect(
      within(inspector).getByRole("button", { name: "Stat" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(inspector).getByText("Stat in no row")).toBeTruthy();
  });

  it("filters the outline and folds a row from its actions", async () => {
    setup();
    const { user, card } = await openEditing();
    await user.click(bodyOf(card));
    const outline = await screen.findByRole("navigation", { name: "Outline" });
    expect(within(outline).getByText("1 row, 2 panels")).toBeTruthy();
    expect(within(outline).getByText("6×5")).toBeTruthy();
    const filter = within(outline).getByRole("searchbox", { name: "Filter panels" });
    await user.type(filter, "zzz");
    expect(within(outline).getByText("No panel matches.")).toBeTruthy();
    await user.clear(filter);
    await user.type(filter, "sto");
    expect(within(outline).queryByRole("button", { name: /^Orders/ })).toBeNull();
    expect(within(outline).getByRole("button", { name: /^Stock/ })).toBeTruthy();
    await user.clear(filter);

    await user.click(within(outline).getByRole("button", { name: "Fold row Details" }));
    expect(await within(outline).findByText("folded")).toBeTruthy();
    expect(within(outline).queryByRole("button", { name: /^Stock/ })).toBeNull();
    await user.click(within(outline).getByRole("button", { name: "Unfold row Details" }));
    expect(await within(outline).findByRole("button", { name: /^Stock/ })).toBeTruthy();
  });

  it("selects a panel from the outline", async () => {
    setup();
    const { user, card } = await openEditing();
    await user.click(bodyOf(card));
    const outline = await screen.findByRole("navigation", { name: "Outline" });
    const entry = within(outline).getByRole("button", { name: /^Stock/ });
    await user.click(entry);
    const inspector = await inspectorOf("Stock");
    expect(within(inspector).getByText("Table in Details")).toBeTruthy();
    // Focus stays where the choice was made.
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(entry);
  });

  it("selects with Enter on the arrange handle, not on every tab stop", async () => {
    setup();
    const { user, card } = await openEditing();
    const handle = within(card).getByRole("button", { name: "Arrange “Orders”" });
    handle.focus();
    expect(card.getAttribute("aria-current")).toBeNull();
    await user.keyboard("{Enter}");
    expect(card.getAttribute("aria-current")).toBe("true");
    // The actions follow the handle in the tab order.
    await user.tab();
    expect(document.activeElement).toBe(
      within(card).getByRole("button", { name: "Edit “Orders”" }),
    );
  });

  it("does not select the panel when a control inside it is used", async () => {
    setup();
    const { user, card } = await openEditing();
    await user.click(within(card).getByRole("button", { name: "Panel menu of “Orders”" }));
    expect(card.getAttribute("aria-current")).toBeNull();
    await user.keyboard("{Escape}");
  });

  it("clamps X to the grid and pushes an overlapped panel down when Y changes", async () => {
    setup([panel("p3", "Returns", { grid: { x: 0, y: 8, w: 12, h: 4 } })]);
    const { user } = await openEditing();
    let inspector = await selectFromOutline(user, "Returns");
    const y = within(inspector).getByRole("spinbutton", { name: "Row (Y)" });
    await user.clear(y);
    // Nothing moves while typing, and an empty field is fine on the way.
    expect((y as HTMLInputElement).value).toBe("");
    await user.type(y, "0");
    await user.tab();
    await waitFor(() => expect((y as HTMLInputElement).value).toBe("0"));

    const x = within(inspector).getByRole("spinbutton", { name: "Column (X)" });
    await user.clear(x);
    await user.type(x, "30{Enter}");
    await waitFor(() => expect((x as HTMLInputElement).value).toBe("12"));
    inspector = await selectFromOutline(user, "Orders");
    const ordersY = within(inspector).getByRole("spinbutton", { name: "Row (Y)" });
    expect((ordersY as HTMLInputElement).value).toBe("4");
  });

  it("shows a description as text, never as markup", async () => {
    const markup = '<img src="x" onerror="window.__hit = 1">';
    setup([panel("p3", "Returns", { grid: { x: 12, y: 0, w: 12, h: 4 }, description: markup })]);
    await openEditing();
    const returns = await screen.findByRole("article", { name: "Returns" });
    expect(returns.querySelector("img")).toBeNull();
    expect(returns.querySelector(".panel-card__about-text")?.textContent).toBe(markup);
  });

  it("keeps each visualization's options when switching back and forth", async () => {
    setup([
      panel("p3", "Returns", {
        type: "stat",
        grid: { x: 12, y: 0, w: 12, h: 4 },
        options: { graphMode: "none" },
      }),
    ]);
    const { user } = await openEditing();
    const inspector = await selectFromOutline(user, "Returns");
    await user.click(within(inspector).getByRole("button", { name: "Table" }));
    expect(within(inspector).getByText("Table in no row")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save…" })).toHaveProperty("disabled", false);
    await user.click(within(inspector).getByRole("button", { name: "Stat" }));
    expect(within(inspector).getByText("Stat in no row")).toBeTruthy();
    // Back to where it started, options included: nothing is left to save.
    expect(screen.getByRole("button", { name: "Save…" })).toHaveProperty("disabled", true);
  });

  it("removes a panel and moves focus to the next outline entry", async () => {
    setup([panel("p3", "Returns", { grid: { x: 0, y: 8, w: 12, h: 4 } })]);
    const { user } = await openEditing();
    const inspector = await selectFromOutline(user, "Orders");
    await user.click(within(inspector).getByRole("button", { name: "Remove" }));
    const outline = screen.getByRole("navigation", { name: "Outline" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(outline).getByRole("button", { name: /^Returns/ }),
      ),
    );
  });

  it("makes a library panel and unlinks one from the inspector", async () => {
    const server = setup([
      panel("p3", "Returns", { grid: { x: 12, y: 0, w: 12, h: 4 }, libraryPanelId: "lib1" }),
    ]);
    server.areas.dashboardFeatures.libraryPanels.push({
      id: "lib1",
      folderId: null,
      name: "Shared returns",
      model: { ...panel("p3", "Returns") },
      version: 1,
    });
    const { user } = await openEditing();
    let inspector = await selectFromOutline(user, "Orders");
    await user.click(within(inspector).getByRole("button", { name: /^Library/ }));
    await user.click(within(inspector).getByRole("button", { name: "Make library panel…" }));
    expect(await screen.findByRole("dialog", { name: "Make library panel" })).toBeTruthy();
    await user.keyboard("{Escape}");

    inspector = await selectFromOutline(user, "Returns");
    await user.click(within(inspector).getByRole("button", { name: /^Library/ }));
    expect(within(inspector).getByText(/“Shared returns”/)).toBeTruthy();
    await user.click(
      within(inspector).getByRole("button", { name: "Keep as a panel of this dashboard only" }),
    );
    expect(
      await within(inspector).findByRole("button", { name: "Make library panel…" }),
    ).toBeTruthy();
  });
});
