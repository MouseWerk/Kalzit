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

function setup() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addDashboard(server.areas.dashboards, "d-main", {
    ...emptyModel("Main"),
    rows: [{ id: "r1", title: "Details", collapsed: false }],
    panels: [
      panel("p1", "Orders"),
      panel("p2", "Stock", { rowId: "r1", grid: { x: 0, y: 0, w: 6, h: 5 } }),
    ],
  });
  return server;
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
    const toolbar = within(card).getByRole("toolbar", { name: "Actions for Orders" });
    expect(within(toolbar).getByRole("button", { name: "Edit “Orders”" })).toBeTruthy();
    const outline = await screen.findByRole("navigation", { name: "Outline" });
    const inspector = within(outline).getByRole("region", { name: "Orders" });
    expect(within(inspector).getByText("Table in no row")).toBeTruthy();
    const entry = within(outline).getByRole("button", { name: /^Orders/ });
    expect(entry.getAttribute("aria-current")).toBe("true");
  });

  it("changes title, description, size, transparency and visualization from the inspector", async () => {
    setup();
    const { user, card } = await openEditing();
    await user.click(bodyOf(card));
    const outline = await screen.findByRole("navigation", { name: "Outline" });
    const inspector = within(outline).getByRole("region", { name: "Orders" });

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
    expect(within(outline).getByText("1 rows, 2 panels")).toBeTruthy();
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
    await user.click(within(outline).getByRole("button", { name: /^Stock/ }));
    expect(await within(outline).findByRole("region", { name: "Stock" })).toBeTruthy();
    expect(within(outline).getByText("Table in Details")).toBeTruthy();
  });
});
