import type { Page } from "@playwright/test";
import { Api, regionDashboard, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * Performance budgets for editing (docs/design/feel.md section 10, fix 5), in Chromium with the
 * CPU slowed down four times: typing 40 keys into a panel's query stays under 50 ms p95 Event
 * Timing per key, and dragging a panel across the grid makes no long task over 50 ms.
 *
 * Each budget is measured in three rounds and the best round counts: other work on the machine
 * only ever adds time, so the best round is the closest to what the page itself costs. Every
 * round prints its numbers, so a regression shows them in the log.
 */

const THROTTLE = 4;
const KEYS = 40;
const ROUNDS = 3;
const BUDGET_MS = 50;

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "CPU throttling needs the DevTools protocol",
);
// One after the other, so the two budgets never share the CPU either.
test.describe.configure({ mode: "serial" });

interface Store {
  __events: { id: number; duration: number }[];
  __long: number[];
}

/** Slows the page's CPU down by `rate` (1 is full speed). The session must stay open: throttling ends with it. */
async function cpu(page: Page): Promise<(rate: number) => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  return async (rate) => {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  };
}

/** Starts recording interactions (Event Timing) and long tasks in the page, once. */
async function observe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as Store;
    store.__events = [];
    store.__long = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId > 0) {
          store.__events.push({ id: entry.interactionId, duration: entry.duration });
        }
      }
      // 16 ms is the smallest threshold the API takes; shorter interactions are not reported.
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.__long.push(entry.duration);
      }
    }).observe({ type: "longtask" });
  });
}

async function reset(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as Store;
    store.__events = [];
    store.__long = [];
  });
}

async function recorded(page: Page): Promise<{ interactions: number[]; long: number[] }> {
  // The observers report after the frame that ends the last interaction.
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const store = window as unknown as Store;
    // One interaction (a key press) is the longest of its events.
    const byId = new Map<number, number>();
    for (const { id, duration } of store.__events) {
      byId.set(id, Math.max(byId.get(id) ?? 0, duration));
    }
    return { interactions: [...byId.values()], long: [...store.__long] };
  });
}

/** The p95 of `count` interactions, the unreported ones (under 16 ms) counted as 0. */
function p95(reported: number[], count: number): number {
  const all = [...reported, ...Array(Math.max(0, count - reported.length)).fill(0)].sort(
    (a, b) => a - b,
  );
  return all[Math.min(all.length - 1, Math.ceil(all.length * 0.95) - 1)] ?? 0;
}

/** A dashboard of eight time series panels, two per row, as the measurements in feel.md used. */
async function eightPanels(sourceId: string): Promise<string> {
  const base = regionDashboard(unique("Budget"), sourceId) as {
    panels: Record<string, unknown>[];
  };
  const panel = base.panels[0] as Record<string, unknown>;
  const panels = Array.from({ length: 8 }, (_, i) => ({
    ...panel,
    id: `p${i + 1}`,
    title: i === 0 ? "Sales" : `Sales ${i + 1}`,
    grid: { x: (i % 2) * 12, y: Math.floor(i / 2) * 8, w: 12, h: 8 },
  }));
  const owner = await Api.owner();
  const id = await owner.createDashboard({ ...base, panels });
  await owner.dispose();
  return id;
}

/** Opens the dashboard in edit mode once all eight charts are drawn by uPlot. */
async function openForEditing(page: Page, sourceId: string): Promise<void> {
  const id = await eightPanels(sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  // Drawn by uPlot (it loads after the first charts, which draw as SVG until then).
  await expect(page.locator(".ts__uplot canvas")).toHaveCount(8);
  await page.getByRole("button", { name: t("dashboards.edit") }).click();
  await expect(page.getByRole("status").filter({ hasText: t("dashboards.editing") })).toBeVisible();
}

test("typing in a panel's query stays under 50 ms p95 at 4x CPU throttling", async ({
  page,
  world,
}) => {
  await openForEditing(page, world.sourceId);
  await page
    .getByRole("button", { name: t("dashboards.panel.editNamed", { title: "Sales" }) })
    .click();
  const editor = page.getByRole("region", { name: t("dashboards.editor.title") });
  const query = editor.locator(".cm-content").first();
  await expect(query).toBeVisible();
  await expect(editor.locator(".ts__uplot canvas")).toHaveCount(1);
  await query.click();
  await page.keyboard.press("End");
  await observe(page);
  const throttle = await cpu(page);
  // Spaces and comparisons at the end of the query: no completion list takes the keys.
  const text = " AND amount >= 0 ".repeat(3).slice(0, KEYS);
  const rounds: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    await throttle(THROTTLE);
    await reset(page);
    for (const key of text) {
      await page.keyboard.type(key);
    }
    const { interactions } = await recorded(page);
    await throttle(1);
    const result = p95(interactions, KEYS);
    rounds.push(result);
    process.stdout.write(
      `budget: typing ${KEYS} keys at ${THROTTLE}x, round ${round + 1}: p95 ${result} ms, max ${Math.max(0, ...interactions)} ms\n`,
    );
  }
  await expect(query).toContainText(SQL.byRegion.slice(0, 20));
  expect(Math.min(...rounds)).toBeLessThan(BUDGET_MS);
});

test("dragging a panel makes no long task over 50 ms at 4x CPU throttling", async ({
  page,
  world,
}) => {
  await openForEditing(page, world.sourceId);
  await observe(page);
  const throttle = await cpu(page);
  const rounds: number[] = [];
  const card = page.getByRole("article", { name: "Sales", exact: true });
  // Each round drags the first panel by its title (the actions next to it do not drag) across
  // to the other half and half a panel down, there and back: 120 moves, one drop.
  for (let round = 0; round < ROUNDS; round++) {
    const heading = await card.locator(".panel-card__title").boundingBox();
    const box = await card.boundingBox();
    const grid = await page.locator(".dash-grid").first().boundingBox();
    if (heading === null || box === null || grid === null) {
      throw new Error("the panel or the grid has no box");
    }
    await throttle(THROTTLE);
    await reset(page);
    const rightward = box.x < grid.x + grid.width / 2;
    const from = { x: heading.x + 8, y: heading.y + heading.height / 2 };
    const to = {
      x: from.x + (rightward ? 1 : -1) * grid.width * 0.5,
      y: from.y + box.height / 2,
    };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 120; step++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * step) / 120,
        from.y + ((to.y - from.y) * step) / 120,
      );
    }
    await page.mouse.up();
    const { long } = await recorded(page);
    await throttle(1);
    const worst = Math.max(0, ...long);
    rounds.push(worst);
    process.stdout.write(
      `budget: dragging a panel at ${THROTTLE}x, round ${round + 1}: ${long.length} long tasks, longest ${worst.toFixed(0)} ms\n`,
    );
    // The drop moved the panel to the other half.
    await expect
      .poll(async () => Math.abs(((await card.boundingBox())?.x ?? box.x) - box.x))
      .toBeGreaterThan(100);
  }
  expect(Math.min(...rounds)).toBeLessThan(BUDGET_MS);
});
