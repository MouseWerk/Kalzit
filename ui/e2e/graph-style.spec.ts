import type { Locator, Page } from "@playwright/test";
import { Api, type Member, unique } from "./support/api";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
import { boltTarget, GRAPH_FIXTURE, serviceAddress } from "./support/services";
import { expect, signIn, signInOwner, test } from "./support/test";
import { panelAction } from "./support/ui";

/**
 * Style rules of graph data (Graph081 board, frames 8 to 11), against the shop graph of
 * e2e/fixtures/graph-shop.cypher in Neo4j: a rule made in the panel editor and its legend entry,
 * the order by keyboard, "per unique value" with an honest count, copying rules between panels,
 * a viewer's own change that is never saved, and a table made from the graph.
 */

const STEP_MS = 15_000;

/** Every node of the fixture: 5 categories, 4 products, 5 customers and 8 orders, 22 names. */
const ALL = "MATCH (n) RETURN n";
const ALL_NODES = 22;
const CUSTOMERS = "MATCH (c:Customer) RETURN c";

const SIGMA_WEBGL_NOTICES = [
  /^warning: \[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels/,
];

test.beforeEach(({ consoleGuard }) => {
  for (const notice of SIGMA_WEBGL_NOTICES) consoleGuard.allow(notice);
});

const PANELS = {
  made: "Made in the editor",
  values: "Names by value",
  source: "Rules to copy",
  copy: "Copy target",
  table: "Customers as a table",
} as const;

/** A rule as the server stores it (`options.style`, version 1). */
function rule(id: string, when: Record<string, unknown>, set: Record<string, unknown>) {
  return { id, on: true, scope: "", when, set };
}

const PER_NAME = {
  version: 1,
  nodes: [rule("r1", { kind: "values", property: "name", colors: [] }, {})],
  edges: [],
};
const CUSTOMERS_GOOD = {
  version: 1,
  nodes: [
    { ...rule("r1", { kind: "always" }, { color: "good", badge: "VIP" }), scope: "Customer" },
  ],
  edges: [],
};

function styleDashboard(title: string, datasourceId: string) {
  const panel = (
    id: string,
    type: string,
    name: string,
    y: number,
    x: number,
    cypher: string,
    options: Record<string, unknown> = {},
    more: Record<string, unknown> = {},
  ) => ({
    id,
    type,
    title: name,
    grid: { x, y, w: 12, h: 9 },
    targets: [{ refId: "A", datasourceId, query: { cypher } }],
    options,
    ...more,
  });
  return {
    schemaVersion: 1,
    title,
    timeRange: { from: "now-6h", to: "now" },
    panels: [
      panel("made", "network", PANELS.made, 0, 0, ALL),
      panel("values", "network", PANELS.values, 0, 12, ALL, { style: PER_NAME }),
      panel("source", "network", PANELS.source, 9, 0, CUSTOMERS, { style: CUSTOMERS_GOOD }),
      panel("copy", "network", PANELS.copy, 9, 12, CUSTOMERS),
      panel(
        "table",
        "table",
        PANELS.table,
        18,
        0,
        CUSTOMERS,
        { style: CUSTOMERS_GOOD },
        {
          transformations: [
            {
              id: "0199f0a0-1c2e-7a4b-9e1d-3f5a6b7c8d90",
              type: "toFrame",
              frame: "A",
              rows: "nodes",
              columns: [{ path: "@labels" }, { path: "name" }, { path: "city" }],
            },
          ],
          fieldConfig: {
            defaults: {
              thresholds: { mode: "absolute", steps: [{ value: null, tone: "ok" }] },
            },
            overrides: [],
          },
        },
      ),
    ],
  };
}

const card = (page: Page, title: string) => page.getByRole("article", { name: title, exact: true });
const rulesLegend = (scope: Locator | Page) =>
  scope.getByRole("list", { name: t("graphStyle.legend.title"), exact: true });
const styleGroup = (page: Page) =>
  page.getByRole("group", { name: t("graphStyle.title"), exact: true });

test.describe("graph style rules", () => {
  test.use({ viewport: { width: 1440, height: 1800 } });

  let dashboardId = "";
  let viewer: Member | null = null;

  test.beforeAll(async () => {
    const address = serviceAddress("KALZIT_E2E_NEO4J");
    const owner = await Api.owner();
    try {
      const sourceId = await owner.createSource(
        unique("Shop graph for style rules"),
        "neo4j",
        { ...boltTarget(address), user: GRAPH_FIXTURE.neo4jUser },
        { password: GRAPH_FIXTURE.neo4jPassword },
      );
      dashboardId = await owner.createDashboard(styleDashboard(unique("Style rules"), sourceId));
      viewer = await owner.createMember(unique("Vera Viewer"), "viewer");
    } finally {
      await owner.dispose();
    }
  });

  test("a rule made in the panel editor shows in the legend; the keyboard moves it", async ({
    page,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    await panelAction(page, PANELS.made, "dashboards.panel.editNamed");
    const style = styleGroup(page);
    await expect(style).toBeVisible({ timeout: STEP_MS });

    await test.step("a rule for every node with a badge", async () => {
      await style.getByRole("button", { name: t("graphStyle.add"), exact: true }).click();
      await selectOption(
        style.getByLabel(t("graphStyle.form.addTarget"), { exact: true }),
        "badge",
      );
      await expect(rulesLegend(page)).toContainText(String(ALL_NODES), { timeout: STEP_MS });
    });

    await test.step("Alt+Down moves the rule and keeps the focus on its header", async () => {
      await style.getByRole("button", { name: t("graphStyle.rule.done"), exact: true }).click();
      await style.getByRole("button", { name: t("graphStyle.add"), exact: true }).click();
      await style.getByRole("button", { name: t("graphStyle.rule.done"), exact: true }).click();
      const first = style.getByRole("button", {
        name: new RegExp(`^${t("graphStyle.rule.number", { n: 1 })}:`),
      });
      await first.focus();
      await page.keyboard.press("Alt+ArrowDown");
      await expect(
        style.getByText(t("graphStyle.announce.moved", { from: 1, to: 2 }), { exact: true }),
      ).toBeAttached();
      const focused = page.locator(":focus");
      await expect(focused).toHaveAccessibleName(
        new RegExp(`^${t("graphStyle.rule.number", { n: 2 })}:`),
      );
    });
  });

  test("per unique value: 12 of 22 values, the rest as other, a legend click selects", async ({
    page,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page, PANELS.values);
    const legend = rulesLegend(panel);
    await expect(legend).toBeVisible({ timeout: STEP_MS });
    await expect(
      legend.getByText(t("graphStyle.values.other", { count: ALL_NODES - 12 }), { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: /^Style/ }).click();
    const sheet = panel.getByRole("region", { name: t("graphStyle.sheet.label"), exact: true });
    await expect(
      sheet.getByText(t("graphStyle.values.count", { shown: 12, total: ALL_NODES }), {
        exact: true,
      }),
    ).toBeVisible();
    await legend.getByRole("button", { name: /^Ana 1/ }).click();
    await expect(panel).toContainText(t("graph.summary.selection", { name: "Ana" }));
  });

  test("rules copied from another panel are a copy: changing them leaves the first panel", async ({
    page,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    await panelAction(page, PANELS.copy, "dashboards.panel.editNamed");
    const style = styleGroup(page);
    await selectOption(
      style.getByLabel(t("graphStyle.copy.label"), { exact: true }),
      PANELS.source,
    );
    await style.getByRole("button", { name: t("graphStyle.copy.apply"), exact: true }).click();
    const switchOne = style.getByRole("checkbox", {
      name: t("graphStyle.rule.on", { n: 1 }),
      exact: true,
    });
    await expect(switchOne).toBeChecked();
    await switchOne.uncheck();
    await page.getByRole("button", { name: t("dashboards.editor.apply"), exact: true }).click();

    await panelAction(page, PANELS.source, "dashboards.panel.editNamed");
    await expect(
      styleGroup(page).getByRole("checkbox", {
        name: t("graphStyle.rule.on", { n: 1 }),
        exact: true,
      }),
    ).toBeChecked();
  });

  test("a viewer's change in the sheet is the view's own: never saved, Reset restores", async ({
    page,
  }) => {
    if (viewer === null) throw new Error("no viewer");
    await signIn(page, viewer.email, viewer.password);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        /\/dashboards\//.test(request.url()) &&
        ["PUT", "POST", "PATCH"].includes(request.method())
      ) {
        writes.push(`${request.method()} ${request.url()}`);
      }
    });
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page, PANELS.source);
    const legend = rulesLegend(panel);
    await expect(legend).toBeVisible({ timeout: STEP_MS });

    await panel.getByRole("button", { name: /^Style/ }).click();
    const sheet = panel.getByRole("region", { name: t("graphStyle.sheet.label"), exact: true });
    await expect(sheet).toContainText(t("graphStyle.sheet.viewOnly"));
    await sheet
      .getByRole("checkbox", { name: t("graphStyle.rule.on", { n: 1 }), exact: true })
      .uncheck();
    await expect(legend).toBeHidden();
    await sheet.getByRole("button", { name: t("graphStyle.sheet.reset"), exact: true }).click();
    await expect(legend).toBeVisible();

    // Reset leaves the sheet open (a click on "Style" now would close it).
    await sheet
      .getByRole("checkbox", { name: t("graphStyle.rule.on", { n: 1 }), exact: true })
      .uncheck();
    await expect(legend).toBeHidden();
    await page.reload();
    await expect(rulesLegend(card(page, PANELS.source))).toBeVisible({ timeout: STEP_MS });
    expect(writes).toEqual([]);
  });

  test("a table made from the graph shows the color as a dot, and the rule wins over thresholds", async ({
    page,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${dashboardId}`, { timeout: STEP_MS });
    const panel = card(page, PANELS.table);
    await expect(panel.getByRole("cell", { name: /Ana/ })).toBeVisible({ timeout: STEP_MS });
    await expect(panel.getByText(`${t("graphStyle.color.good")}: `).first()).toBeAttached();
    await expect(panel.getByText("VIP").first()).toBeVisible();
    await expect(
      panel.getByText(t("graphStyle.table.ruleWins", { column: "name", rule: 1 }), {
        exact: true,
      }),
    ).toBeVisible();
  });
});
