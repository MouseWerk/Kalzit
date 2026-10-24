import { Api, regionDashboard, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * The dashboard header and time picker in a real browser: the time shortcuts, the shared cursor
 * across time series panels and the compact header on a phone.
 */

/** The region dashboard with a second time series panel and a shared cursor with tooltip. */
async function sharedDashboard(sourceId: string): Promise<{ id: string; title: string }> {
  const owner = await Api.owner();
  const title = unique("Gemeinsam");
  const model = regionDashboard(title, sourceId) as { panels: Record<string, unknown>[] };
  const first = model.panels[0] as Record<string, unknown>;
  const id = await owner.createDashboard({
    ...model,
    schemaVersion: 2,
    sharedCursor: "tooltip",
    panels: [
      first,
      { ...first, id: "p2", title: "Sales again", grid: { x: 12, y: 0, w: 12, h: 8 } },
    ],
  });
  await owner.dispose();
  return { id, title };
}

test("t and the arrow keys move the range; the shortcuts are listed in the help", async ({
  page,
  world,
}) => {
  await signInOwner(page);
  await page.goto(`/dashboards/${world.dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
  await page.keyboard.press("t");
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/from=now-12h&to=now-6h|to=now-6h.*from=now-12h/);
  await page.keyboard.press("t");
  await page.keyboard.press("z");
  await expect(page).toHaveURL(/from=now-15h/);
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: t("shell.shortcuts.title") });
  await expect(help.getByText(t("shell.shortcuts.timeBack"))).toBeVisible();
  await expect(help.getByText(t("shell.shortcuts.timeZoomOut"))).toBeVisible();
});

test("the shared cursor draws the same time in every time series panel within one frame", async ({
  page,
  world,
}) => {
  const { id } = await sharedDashboard(world.sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole("group", { name: "Sales", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Sales again" })).toBeVisible();
  await expect(page.locator(".uplot")).toHaveCount(2);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const drawn = await page.evaluate(async () => {
    const [first, second] = document.querySelectorAll<HTMLElement>(".ts__plot");
    if (first === undefined || second === undefined) {
      return null;
    }
    const box = first.getBoundingClientRect();
    first.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
    // The next frame: both lines must already stand there.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const x = (plot: HTMLElement) =>
      plot.querySelector<HTMLElement>(".ts__cursor-line")?.style.getPropertyValue("--cursor-x") ??
      null;
    return {
      first: x(first),
      second: x(second),
      tooltip: second.querySelector(".ts__tooltip") !== null,
    };
  });
  expect(drawn).not.toBeNull();
  expect(drawn?.second).not.toBeNull();
  // The same time at the same place: both panels are as wide, to a fraction of a pixel.
  expect(Number.parseFloat(drawn?.second ?? "")).toBeCloseTo(
    Number.parseFloat(drawn?.first ?? ""),
    1,
  );
  expect(drawn?.tooltip).toBe(true);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the header takes two rows and the overflow menu holds the other actions", async ({
    page,
    world,
  }) => {
    await signInOwner(page);
    await page.goto(`/dashboards/${world.dashboardId}`);
    await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
    // Two rows of buttons, never a third; the filters below them are choices, not buttons.
    const rows = await page
      .locator(".dash-toolbar button:not(.dash-filters button)")
      .evaluateAll((buttons) => {
        const tops = buttons.map((b) => b.getBoundingClientRect().top).sort((a, b) => a - b);
        return tops.filter((top, i) => i === 0 || top - (tops[i - 1] ?? top) > 12).length;
      });
    expect(rows).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: t("dashboards.edit"), exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: t("toolbar.more"), exact: true }).click();
    const menu = page.getByRole("menu", { name: t("toolbar.more") });
    for (const key of ["dashboards.edit", "dashboards.versions", "dashboardTools.view.tv"]) {
      await expect(menu.getByRole("menuitem", { name: t(key), exact: true })).toBeVisible();
    }
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});
