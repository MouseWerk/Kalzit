import type { Page } from "@playwright/test";
import { Api, regionDashboard, unique } from "./support/api";
import { expect, signInOwner, test } from "./support/test";

/**
 * Hover tooltips in a real browser: a chart's tooltip lies above the whole page (at the end of
 * the body, fixed, on the tooltip layer), so its panel cannot clip it and neither a neighbouring
 * panel, a sticky table heading nor the toolbar can cover it; at the viewport's edges it flips
 * or shifts and stays whole.
 */

const TABLE = "Sales table";

/** The region dashboard with a table beside its time series panel. */
async function dashboardWithTable(sourceId: string): Promise<string> {
  const owner = await Api.owner();
  const model = regionDashboard(unique("Tooltips"), sourceId) as {
    panels: Record<string, unknown>[];
  };
  const first = model.panels[0] as Record<string, unknown>;
  const id = await owner.createDashboard({
    ...model,
    panels: [
      first,
      { ...first, id: "p2", type: "table", title: TABLE, grid: { x: 12, y: 0, w: 12, h: 8 } },
    ],
  });
  await owner.dispose();
  return id;
}

interface Seen {
  box: { left: number; top: number; right: number; bottom: number };
  viewport: { width: number; height: number };
  parent: string;
  position: string;
  layer: number;
  layers: { bar: number; sticky: number; menu: number; popover: number };
}

/** The time series tooltip on screen, with what decides whether anything can clip or cover it. */
async function tooltip(page: Page): Promise<Seen> {
  const tip = page.locator(".ts__tooltip[data-placed]");
  await expect(tip).toBeVisible();
  return await tip.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const root = getComputedStyle(document.documentElement);
    const token = (name: string) => Number(root.getPropertyValue(name));
    return {
      box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      parent: element.parentElement?.tagName ?? "",
      position: style.position,
      layer: Number(style.zIndex),
      layers: {
        bar: token("--z-bar"),
        sticky: token("--z-sticky"),
        menu: token("--z-menu"),
        popover: token("--z-popover"),
      },
    };
  });
}

function expectWhole(seen: Seen) {
  expect(seen.box.left).toBeGreaterThanOrEqual(0);
  expect(seen.box.top).toBeGreaterThanOrEqual(0);
  expect(seen.box.right).toBeLessThanOrEqual(seen.viewport.width);
  expect(seen.box.bottom).toBeLessThanOrEqual(seen.viewport.height);
}

test("a chart's tooltip lies above the page and stays whole at every edge", async ({
  page,
  world,
}) => {
  const id = await dashboardWithTable(world.sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  const card = page.getByRole("article", { name: "Sales", exact: true });
  const plot = card.locator(".ts__plot");
  await expect(page.locator(".uplot")).toHaveCount(1);
  await expect(page.getByRole("article", { name: TABLE, exact: true })).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

  await test.step("at the panel's right edge, beside the table: out of the panel, not clipped", async () => {
    const box = await plot.boundingBox();
    const cardBox = await card.boundingBox();
    if (box === null || cardBox === null) throw new Error("the time series panel is not on screen");
    await page.mouse.move(box.x + box.width * 0.92, box.y + box.height / 2);
    const seen = await tooltip(page);
    // Not inside the panel: nothing of the page clips it or confines its layer.
    expect(seen.parent).toBe("BODY");
    expect(seen.position).toBe("fixed");
    for (const below of Object.values(seen.layers)) {
      expect(seen.layer).toBeGreaterThan(below);
    }
    // It reaches out of its panel, over the neighbouring table, and all of it is on screen.
    expect(seen.box.right).toBeGreaterThan(cardBox.x + cardBox.width);
    expectWhole(seen);
  });

  await test.step("at the top of the panel, right under the toolbar", async () => {
    const box = await plot.boundingBox();
    if (box === null) throw new Error("the time series panel is not on screen");
    await page.mouse.move(box.x + box.width * 0.4, box.y + 3);
    expectWhole(await tooltip(page));
  });

  await test.step("at the viewport's bottom edge it opens upwards", async () => {
    const box = await plot.boundingBox();
    if (box === null) throw new Error("the time series panel is not on screen");
    // A window that ends in the middle of the plot.
    const width = page.viewportSize()?.width ?? 1280;
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width, height: Math.round(box.y + box.height * 0.6) });
    const cut = await plot.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    if (cut === null) throw new Error("the time series panel is not on screen");
    await page.mouse.move(cut.x + cut.width * 0.4, height - 6);
    const seen = await tooltip(page);
    expectWhole(seen);
    expect(seen.box.bottom).toBeLessThanOrEqual(height - 6);
  });
});

const OTHER = "Sales again";

/**
 * Two tall time series panels side by side with a shared cursor that shows values, and a third
 * below them so the page scrolls.
 */
async function sharedDashboard(sourceId: string): Promise<string> {
  const owner = await Api.owner();
  const model = regionDashboard(unique("Gemeinsame Tooltips"), sourceId) as {
    panels: Record<string, unknown>[];
  };
  const first = model.panels[0] as Record<string, unknown>;
  const id = await owner.createDashboard({
    ...model,
    schemaVersion: 2,
    sharedCursor: "tooltip",
    panels: [
      { ...first, grid: { x: 0, y: 0, w: 12, h: 14 } },
      { ...first, id: "p2", title: OTHER, grid: { x: 12, y: 0, w: 12, h: 14 } },
      { ...first, id: "p3", title: "Sales below", grid: { x: 0, y: 14, w: 24, h: 14 } },
    ],
  });
  await owner.dispose();
  return id;
}

interface Shared {
  /** The bottom edge of the sticky bars. */
  bars: number;
  viewport: { width: number; height: number };
  /** The plot of the panel that is not hovered. */
  plot: { left: number; top: number; right: number; bottom: number };
  /** The placed tooltips that stand in that plot's columns: its own, wherever they are. */
  tips: { left: number; top: number; right: number; bottom: number }[];
  /** Every tooltip on show. */
  all: number;
}

async function shared(page: Page): Promise<Shared> {
  return await page.evaluate((title) => {
    const edges = (element: Element) => {
      const { left, top, right, bottom } = element.getBoundingClientRect();
      return { left, top, right, bottom };
    };
    const plot = [...document.querySelectorAll(".ts__plot")].find(
      (element) => element.getAttribute("aria-label") === title,
    );
    if (plot === undefined) throw new Error("the other panel's plot is missing");
    const at = edges(plot);
    const placed = [...document.querySelectorAll(".ts__tooltip[data-placed]")].map(edges);
    return {
      bars: Math.max(
        ...[...document.querySelectorAll("[data-sticky-bar]")].map(
          (bar) => bar.getBoundingClientRect().bottom,
        ),
      ),
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      plot: at,
      tips: placed.filter((tip) => tip.right > at.left && tip.left < at.right),
      all: placed.length,
    };
  }, OTHER);
}

/** Scrolls what the dashboard scrolls in (the page, or a scroll box around the panels). */
async function scrollPage(page: Page, by: number): Promise<void> {
  await page.evaluate((amount) => {
    const scrolls = (element: Element) =>
      element.scrollHeight > element.clientHeight + 1 &&
      /auto|scroll/.test(getComputedStyle(element).overflowY);
    let box = document.querySelector(".ts__plot")?.parentElement ?? null;
    while (box !== null && !scrolls(box)) {
      box = box.parentElement;
    }
    (box ?? document.scrollingElement ?? document.documentElement).scrollBy(0, amount);
  }, by);
}

test("a shared cursor's tooltips stay inside their own panels", async ({ page, world }) => {
  const id = await sharedDashboard(world.sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  const hovered = page.getByRole("group", { name: "Sales", exact: true });
  const other = page.getByRole("group", { name: OTHER, exact: true });
  await expect(page.locator(".uplot")).toHaveCount(3);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const width = page.viewportSize()?.width ?? 1280;

  /** Moves the pointer onto the hovered plot, `down` px below the top of what shows of it. */
  const hover = async (down: number) => {
    const box = await hovered.boundingBox();
    if (box === null) throw new Error("the hovered panel is not on screen");
    const { bars } = await shared(page);
    await page.mouse.move(box.x + box.width * 0.4, Math.max(box.y, bars) + down);
  };

  await test.step("beside its cursor line, inside its own plot", async () => {
    await hover(40);
    await expect(page.locator(".ts__tooltip[data-placed]")).toHaveCount(2);
    const seen = await shared(page);
    expect(seen.tips).toHaveLength(1);
    const [tip] = seen.tips;
    expect(tip?.left).toBeGreaterThanOrEqual(seen.plot.left);
    expect(tip?.right).toBeLessThanOrEqual(seen.plot.right);
    expect(tip?.top).toBeGreaterThanOrEqual(seen.plot.top);
    expect(tip?.bottom).toBeLessThanOrEqual(seen.plot.bottom);
  });

  await test.step("half under the sticky toolbar: below the bars, never over them", async () => {
    const box = await other.boundingBox();
    if (box === null) throw new Error("the other panel is not on screen");
    await page.mouse.move(0, 0);
    await scrollPage(page, Math.round(box.height * 0.5));
    // The page has scrolled: the plot's top is under the bars now.
    await expect.poll(async () => (await shared(page)).plot.top).toBeLessThan(box.y - 20);
    const before = await shared(page);
    expect(before.plot.top).toBeLessThan(before.bars);
    await hover(40);
    await expect(page.locator(".ts__tooltip[data-placed]")).toHaveCount(2);
    const seen = await shared(page);
    expect(seen.tips).toHaveLength(1);
    const [tip] = seen.tips;
    expect(tip?.top).toBeGreaterThanOrEqual(seen.bars);
    expect(tip?.bottom).toBeLessThanOrEqual(seen.plot.bottom);
    expect(tip?.left).toBeGreaterThanOrEqual(seen.plot.left);
    expect(tip?.right).toBeLessThanOrEqual(seen.plot.right);
  });

  await test.step("at the bottom of the window: inside its plot, or not shown at all", async () => {
    await page.mouse.move(0, 0);
    await scrollPage(page, -5000);
    await expect
      .poll(async () => {
        const seen = await shared(page);
        return seen.plot.top - seen.bars;
      })
      .toBeGreaterThanOrEqual(0);
    const top = (await shared(page)).plot.top;
    // The window ends 30 px into the plots: no tooltip fits into what shows of them.
    await page.setViewportSize({ width, height: Math.round(top + 30) });
    await hover(15);
    // The hovered chart's own tooltip floats freely and stays whole.
    await expect(page.locator(".ts__tooltip[data-placed]")).toHaveCount(1);
    const cut = await shared(page);
    // The other panel's is not shown: it does not flip up over what lies above its plot.
    expect(cut.tips).toEqual([]);

    // With room in the plot it shows again, inside the plot and the window.
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width, height: Math.round(top + 260) });
    await hover(40);
    await expect(page.locator(".ts__tooltip[data-placed]")).toHaveCount(2);
    const roomy = await shared(page);
    expect(roomy.tips).toHaveLength(1);
    expect(roomy.tips[0]?.top).toBeGreaterThanOrEqual(roomy.plot.top);
    expect(roomy.tips[0]?.bottom).toBeLessThanOrEqual(roomy.viewport.height);
  });
});

test("an icon button's tooltip lies above the page, not inside its bar", async ({
  page,
  world,
}) => {
  await signInOwner(page);
  await page.goto(`/dashboards/${world.dashboardId}`);
  await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
  const picker = page.locator(".time-picker__button");
  await picker.hover();
  const tip = page.locator("body > .tip[data-placed]");
  await expect(tip).toBeVisible();
  const seen = await tip.evaluate((element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return {
      box: { left, top, right, bottom },
      position: getComputedStyle(element).position,
      inBar: element.closest(".dash-toolbar, .top-bar") !== null,
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    };
  });
  expect(seen.position).toBe("fixed");
  expect(seen.inBar).toBe(false);
  expect(seen.box.left).toBeGreaterThanOrEqual(0);
  expect(seen.box.right).toBeLessThanOrEqual(seen.width);
  expect(seen.box.bottom).toBeLessThanOrEqual(seen.height);
  // Under its button.
  const button = await picker.boundingBox();
  expect(seen.box.top).toBeGreaterThanOrEqual((button?.y ?? 0) + (button?.height ?? 0));
  // Gone with the pointer.
  await page.mouse.move(0, 0);
  await expect(page.locator(".tip")).toHaveCount(0);
});
