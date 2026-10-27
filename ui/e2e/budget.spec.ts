import { rmSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { Api, regionDashboard, SQL, unique } from "./support/api";
import { DENSE_ROWS } from "./support/fixture-db";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";
import { panelAction } from "./support/ui";

/**
 * Performance budgets for editing (docs/design/feel.md section 10, fix 5), in Chromium with the
 * CPU slowed down four times: typing 40 keys into a panel's query stays under 50 ms p95 Event
 * Timing per key (58 ms on Windows runners, see `TYPING_P95_MS`), and its longest main-thread
 * task stays under 34 ms (the modal editor's were 38 to 45 ms, this page's 27 to 30 ms, on the
 * machine the numbers were taken on); dragging a panel across the grid makes no long task over
 * 50 ms.
 *
 * While these run, a file named by KALZIT_E2E_QUIET_FILE exists (when the variable is set): the
 * CI's TCP watch on Windows pauses meanwhile, so it takes no CPU from the measurements.
 *
 * Event Timing comes in 8 ms steps and includes waiting for the next frame, so it hardly tells
 * the two editors apart. Two checks do: the number of components React draws per key (counted
 * through React's hook for developer tools, so it does not depend on the machine: 11 here, 36 in
 * the modal editor), and the longest task, read from a Chrome trace, measured against the
 * machine: a fixed piece of script is timed first, and the 34 ms grow with it on a slower
 * machine (a CI runner), never shrink on a faster one.
 *
 * Each budget is measured in three rounds and the best round counts: other work on the machine
 * only ever adds time, so the best round is the closest to what the page itself costs. Every
 * round prints its numbers, so a regression shows them in the log.
 */

const THROTTLE = 4;
const KEYS = 40;
const ROUNDS = 3;
const BUDGET_MS = 50;
/**
 * Event Timing's step: durations come rounded to 8 ms and include the wait for the next frame.
 * On the Windows runners the same page reads one step more than on the Linux ones at the same
 * calibration: over 38 runs (October 2026) the best round was 24 to 48 ms on Windows (48 in 17
 * of them) and 32 to 40 ms on Linux, and Windows runs failed at 56 ms with calibrations of 188
 * and 204 ms, where Linux reads 40. The typing budget there is one step more; a regression of
 * two steps still fails on both.
 */
const EVENT_TIMING_STEP_MS = 8;
const TYPING_P95_MS = BUDGET_MS + (process.platform === "win32" ? EVENT_TIMING_STEP_MS : 0);
/** The longest task while typing, on the reference machine. */
const TYPING_TASK_MS = 34;
/** The calibration script's time at 4x on the reference machine. */
const REFERENCE_CALIBRATION_MS = 140;

/** Times a fixed piece of script in the page (sorting numbers), at the current throttling. */
async function calibrate(page: Page): Promise<number> {
  return page.evaluate(() => {
    const start = performance.now();
    const values: number[] = [];
    for (let i = 0; i < 200_000; i++) {
      values.push((i * 7919) % 10_007);
    }
    values.sort((a, b) => a - b);
    return performance.now() - start;
  });
}

/**
 * Components drawn per key while typing: 11 on this page (the query's editor and what it holds),
 * 36 in the modal editor before it, which drew the whole editor on every key.
 */
const RENDERS_PER_KEY = 20;

/** The longest task of the page's main thread in a Chrome trace, in ms. */
function longestTask(buffer: Buffer): number {
  const trace = JSON.parse(buffer.toString()) as { traceEvents: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(trace) ? trace : trace.traceEvents;
  // The renderer's main thread is the one that dispatches the page's events.
  const dispatches = new Map<number, number>();
  for (const event of events) {
    if (event.name === "EventDispatch") {
      dispatches.set(event.tid, (dispatches.get(event.tid) ?? 0) + 1);
    }
  }
  const main = [...dispatches.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  let longest = 0;
  for (const event of events) {
    if (event.tid === main && event.name === "RunTask" && event.dur !== undefined) {
      longest = Math.max(longest, event.dur / 1000);
    }
  }
  return longest;
}

/**
 * Counts the components React draws while `__countRenders` is set, through the hook React's
 * production build offers to developer tools: after each commit, every function component that
 * did work in it (a fiber with the PerformedWork flag that is new since the last commit; one
 * React skipped stays the same object). Unlike timings, the count does not depend on the
 * machine.
 */
function installRenderCounter(): void {
  type Fiber = {
    flags: number;
    type: unknown;
    child: Fiber | null;
    sibling: Fiber | null;
  };
  const store = window as unknown as {
    __countRenders: boolean;
    __renders: number;
    __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown;
  };
  store.__countRenders = false;
  store.__renders = 0;
  let previous = new WeakSet<Fiber>();
  store.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      if (!store.__countRenders) {
        return;
      }
      const seen = new WeakSet<Fiber>();
      const stack: Fiber[] = [root.current];
      while (stack.length > 0) {
        const fiber = stack.pop() as Fiber;
        seen.add(fiber);
        if (typeof fiber.type === "function" && (fiber.flags & 1) !== 0 && !previous.has(fiber)) {
          store.__renders += 1;
        }
        if (fiber.sibling !== null) stack.push(fiber.sibling);
        if (fiber.child !== null) stack.push(fiber.child);
      }
      previous = seen;
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
  };
}

interface TraceEvent {
  name: string;
  tid: number;
  dur?: number;
}

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "CPU throttling needs the DevTools protocol",
);
// One after the other, so the two budgets never share the CPU either.
test.describe.configure({ mode: "serial" });

const QUIET_FILE = process.env.KALZIT_E2E_QUIET_FILE ?? "";
test.beforeAll(() => {
  if (QUIET_FILE !== "") {
    writeFileSync(QUIET_FILE, "performance budgets running\n");
  }
});
test.afterAll(() => {
  if (QUIET_FILE !== "") {
    rmSync(QUIET_FILE, { force: true });
  }
});

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

test(`typing in a panel's query stays under ${TYPING_P95_MS} ms p95 at 4x CPU throttling`, async ({
  page,
  browser,
  world,
}) => {
  await page.addInitScript(installRenderCounter);
  await openForEditing(page, world.sourceId);
  await panelAction(page, "Sales", "dashboards.panel.editNamed");
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
  // The machine's speed at the same throttling: the best of three timings.
  await throttle(THROTTLE);
  const calibration = Math.min(await calibrate(page), await calibrate(page), await calibrate(page));
  await throttle(1);
  const taskBudget = TYPING_TASK_MS * Math.max(1, calibration / REFERENCE_CALIBRATION_MS);
  const rounds: number[] = [];
  const tasks: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    await throttle(THROTTLE);
    await reset(page);
    await browser.startTracing(page, {
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel"],
    });
    for (const key of text) {
      await page.keyboard.type(key);
    }
    const { interactions } = await recorded(page);
    const task = longestTask(await browser.stopTracing());
    await throttle(1);
    const result = p95(interactions, KEYS);
    rounds.push(result);
    tasks.push(task);
    process.stdout.write(
      `budget: typing ${KEYS} keys at ${THROTTLE}x, round ${round + 1}: p95 ${result} ms, max ${Math.max(0, ...interactions)} ms, longest task ${task.toFixed(1)} ms (budget ${taskBudget.toFixed(1)} ms, calibration ${calibration.toFixed(1)} ms)\n`,
    );
  }
  // A round without throttling or tracing, counting what React draws per key.
  await page.evaluate(() => {
    const store = window as unknown as { __countRenders: boolean; __renders: number };
    store.__renders = 0;
    store.__countRenders = true;
  });
  for (const key of text) {
    await page.keyboard.type(key);
  }
  await page.waitForTimeout(300);
  const perKey =
    (await page.evaluate(() => {
      const store = window as unknown as { __countRenders: boolean; __renders: number };
      store.__countRenders = false;
      return store.__renders;
    })) / KEYS;
  process.stdout.write(`budget: typing draws ${perKey.toFixed(1)} components per key\n`);
  await expect(query).toContainText(SQL.byRegion.slice(0, 20));
  expect(Math.min(...rounds)).toBeLessThan(TYPING_P95_MS);
  expect(Math.min(...tasks)).toBeLessThan(taskBudget);
  expect(perKey).toBeLessThan(RENDERS_PER_KEY);
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
  // The first drag of a page is a warm-up and not counted: it made a long task (55 to 207 ms) in
  // 73 of 75 CI runs on Linux and Windows (October 2026), the code paths of dragging running for
  // the first time; the best-round rule left it out anyway, so only two rounds were measured, and
  // a Windows runner failed once with 53 and 50 ms in those two.
  for (let round = -1; round < ROUNDS; round++) {
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
    if (round >= 0) {
      rounds.push(worst);
    }
    process.stdout.write(
      `budget: dragging a panel at ${THROTTLE}x, ${round < 0 ? "warm-up" : `round ${round + 1}`}: ${long.length} long tasks, longest ${worst.toFixed(0)} ms\n`,
    );
    // The drop moved the panel to the other half.
    await expect
      .poll(async () => Math.abs(((await card.boundingBox())?.x ?? box.x) - box.x))
      .toBeGreaterThan(100);
  }
  expect(Math.min(...rounds)).toBeLessThan(BUDGET_MS);
});

/** The calibration script's time at full speed on the reference machine. */
const REFERENCE_CALIBRATION_1X_MS = 56;
/**
 * The longest task while three 100,000-point charts (hatched, hue gradient, stacked to 100 %) are
 * built and drawn again on the canvas: 58 to 67 ms on the reference machine; the budget leaves
 * room for a busy runner and grows with the calibration on a slower one.
 */
const STYLES_TASK_MS = 150;

/**
 * Counts, on each chart canvas, how often uPlot clears it, which it does once per draw
 * (`data-draws`). A chart built again brings a new canvas, which starts without a count.
 */
function installDrawCounter(): void {
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (
    this: CanvasRenderingContext2D,
    ...args
  ) {
    const canvas = this.canvas;
    if (canvas.closest?.(".ts__uplot") !== null) {
      canvas.dataset.draws = String(Number(canvas.dataset.draws ?? "0") + 1);
    }
    return clear.apply(this, args);
  };
}

/** How many chart canvases there are and how many of them drew since their counts were zeroed. */
function drawnCanvases(page: Page): Promise<{ canvases: number; drawn: number }> {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".ts__uplot canvas")];
    return {
      canvases: canvases.length,
      drawn: canvases.filter((canvas) => Number(canvas.dataset.draws ?? "0") > 0).length,
    };
  });
}

/** The most values any field of a query answer holds. */
function mostValues(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((most: number, item) => Math.max(most, mostValues(item)), 0);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const own = Array.isArray(record.values) ? record.values.length : 0;
    return Math.max(own, ...Object.values(record).map(mostValues));
  }
  return 0;
}

test("three 100,000-point charts with hatch, gradient and stacking draw again within budget", async ({
  page,
  browser,
  world,
}) => {
  const target = (sql: string) => [{ refId: "A", datasourceId: world.sourceId, query: { sql } }];
  const panel = (id: string, title: string, y: number, sql: string, defaults: object) => ({
    id,
    type: "timeseries",
    title,
    grid: { x: 0, y, w: 24, h: 6 },
    targets: target(sql),
    fieldConfig: { defaults, overrides: [] },
  });
  const owner = await Api.owner();
  const id = await owner.createDashboard({
    schemaVersion: 1,
    title: unique("Dichte"),
    timeRange: { from: "now-30h", to: "now" },
    variables: [],
    panels: [
      panel("hatch", "Hatched", 0, "SELECT ts AS time, a FROM dense ORDER BY ts", {
        fill: "hatch",
        gradientMode: "opacity",
      }),
      panel("hue", "Hue gradient", 6, "SELECT ts AS time, a, b FROM dense ORDER BY ts", {
        fill: "solid",
        gradientMode: "hue",
      }),
      panel("stacked", "Stacked to 100 %", 12, "SELECT ts AS time, a, b FROM dense ORDER BY ts", {
        stack: "percent",
        fill: "solid",
      }),
    ],
  });
  await owner.dispose();
  await page.addInitScript(installDrawCounter);
  // Every panel's answer, to check that each chart really holds 100,000 points.
  const answers: Promise<number>[] = [];
  page.on("response", (response) => {
    if (/\/panels\/[^/]+\/query$/.test(new URL(response.url()).pathname)) {
      answers.push(response.json().then(mostValues));
    }
  });
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  await expect(page.locator(".ts__uplot canvas")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  const points = await Promise.all(answers);
  // At least one answer per panel (a refresh may add more), each with every point.
  expect(points.length).toBeGreaterThanOrEqual(3);
  expect(points.every((count) => count === DENSE_ROWS)).toBe(true);
  const calibration = await calibrate(page);
  const budget = STYLES_TASK_MS * Math.max(1, calibration / REFERENCE_CALIBRATION_1X_MS);
  const rounds: number[] = [];
  // A theme change builds every chart again and draws it on the canvas: paths, the hatch tile,
  // the gradients and the stacked fills, at full speed. Each round must draw all three.
  for (let round = 0; round < ROUNDS; round++) {
    await page.evaluate(() => {
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>(".ts__uplot canvas")) {
        canvas.dataset.draws = "0";
      }
    });
    await browser.startTracing(page, {
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel"],
    });
    await page.evaluate(
      (theme) => {
        document.documentElement.dataset.theme = theme;
      },
      round % 2 === 0 ? "dark" : "light",
    );
    // Every one of the three charts drew again, not one chart three times.
    await expect.poll(() => drawnCanvases(page)).toEqual({ canvases: 3, drawn: 3 });
    await page.waitForTimeout(300);
    const task = longestTask(await browser.stopTracing());
    rounds.push(task);
    process.stdout.write(
      `budget: three 100k-point styled charts drawn again, round ${round + 1}: longest task ${task.toFixed(0)} ms (budget ${budget.toFixed(0)} ms, calibration ${calibration.toFixed(1)} ms)\n`,
    );
  }
  await expect(page.locator(".ts__uplot canvas")).toHaveCount(3);
  expect(Math.min(...rounds)).toBeGreaterThan(0);
  expect(Math.min(...rounds)).toBeLessThan(budget);
});
