import type { Locator, Page } from "@playwright/test";
import { Api, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
import { expect, signInOwner, test, type World } from "./support/test";

// Edit mode does what the mouse asks: a real click on Edit in a selected panel's header opens
// the panel editor (the header's drag starts only after the pointer moved), selecting a panel
// never narrows the canvas (the outline's room is taken as edit mode starts), and the panel
// editor shows the dashboard's variables above its preview.

/** Three panels side by side in one row, and the region variable they use. */
async function seedDashboard(world: World): Promise<string> {
  const owner = await Api.owner();
  try {
    const panel = (id: string, title: string, x: number) => ({
      id,
      type: "timeseries",
      title,
      grid: { x, y: 0, w: 8, h: 8 },
      targets: [{ refId: "A", datasourceId: world.sourceId, query: { sql: SQL.byRegion } }],
    });
    return await owner.createDashboard({
      schemaVersion: 1,
      title: unique("Bearbeiten wie geklickt"),
      timeRange: { from: "now-6h", to: "now" },
      variables: [
        {
          name: "region",
          label: "Region",
          type: "query",
          datasourceId: world.sourceId,
          query: { sql: SQL.regions },
        },
      ],
      panels: [
        panel("p1", "Umsatz", 0),
        panel("p2", "Bestellungen", 8),
        panel("p3", "Retouren", 16),
      ],
    });
  } finally {
    await owner.dispose();
  }
}

const card = (page: Page, id: string): Locator => page.locator(`[data-panel-id="${id}"]`);

/** Where a panel stands and how wide it is, rounded to whole pixels. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  return { x: Math.round(box?.x ?? 0), width: Math.round(box?.width ?? 0) };
}

/** Waits two frames, so a layout change after a click would have landed. */
async function settle(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

test.describe("editing a dashboard with the mouse", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  test("a real click on Edit in the selected panel's header opens the panel editor", async ({
    page,
    world,
  }) => {
    const dashboardId = await seedDashboard(world);
    await signInOwner(page, "en");
    await page.goto(`/dashboards/${dashboardId}?edit=true`);
    const umsatz = card(page, "p1");
    await expect(umsatz).toBeVisible();
    await umsatz.locator(".panel-card__body").click();
    await expect(umsatz).toHaveAttribute("aria-current", "true");
    await umsatz
      .getByRole("group", { name: t("dashboards.panel.actionsFor", { title: "Umsatz" }) })
      .getByRole("button", { name: t("dashboards.panel.editNamed", { title: "Umsatz" }) })
      .click();
    await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboardId}/panels/p1/edit`));
  });

  test("selecting a panel leaves every panel where it was", async ({ page, world }) => {
    const dashboardId = await seedDashboard(world);
    await signInOwner(page, "en");
    await page.goto(`/dashboards/${dashboardId}?edit=true`);
    for (const id of ["p1", "p2", "p3"]) {
      await expect(card(page, id)).toBeVisible();
    }
    await settle(page);
    const before = await Promise.all(["p1", "p2", "p3"].map((id) => boxOf(card(page, id))));
    await card(page, "p2").locator(".panel-card__body").click();
    await expect(card(page, "p2")).toHaveAttribute("aria-current", "true");
    await settle(page);
    const after = await Promise.all(["p1", "p2", "p3"].map((id) => boxOf(card(page, id))));
    expect(after).toEqual(before);
    // The menu of another panel opens on the first click and selects that panel.
    await card(page, "p3")
      .getByRole("button", { name: t("dashboards.panel.menuNamed", { title: "Retouren" }) })
      .click();
    await expect(
      page.getByRole("menu", { name: t("dashboards.panel.menuNamed", { title: "Retouren" }) }),
    ).toBeVisible();
    await expect(card(page, "p3")).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Escape");
    await settle(page);
    expect(await Promise.all(["p1", "p2", "p3"].map((id) => boxOf(card(page, id))))).toEqual(
      before,
    );
  });

  test("the panel editor's preview runs with a variable value chosen in the editor", async ({
    page,
    world,
  }) => {
    const dashboardId = await seedDashboard(world);
    await signInOwner(page, "en");
    await page.goto(`/dashboards/${dashboardId}/panels/p1/edit`);
    const editor = page.getByRole("region", { name: t("dashboards.editor.title") });
    const region = editor.getByRole("combobox", { name: "Region" });
    await expect(region).toBeVisible();
    const ran = page.waitForRequest(
      (request) =>
        request.method() === "POST" && (request.postData() ?? "").includes('"region":"West"'),
    );
    await selectOption(region, "West");
    await ran;
  });
});
