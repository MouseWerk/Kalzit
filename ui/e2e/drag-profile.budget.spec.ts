// Diagnosis only, reverted after one CI run: profiles the budget drag at 4x and prints the long
// tasks with what they hold. Named *.budget.spec.ts so it runs in the budget project, alone.
import type { Page } from "@playwright/test";
import { Api, regionDashboard, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  tid: number;
  args?: { data?: Record<string, unknown> };
}

async function eightPanels(sourceId: string): Promise<string> {
  const base = regionDashboard(unique("Budget"), sourceId) as { panels: Record<string, unknown>[] };
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

function analyse(buffer: Buffer, label: string): void {
  const trace = JSON.parse(buffer.toString()) as { traceEvents: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(trace) ? trace : trace.traceEvents;
  const dispatches = new Map<number, number>();
  for (const e of events) {
    if (e.name === "EventDispatch") dispatches.set(e.tid, (dispatches.get(e.tid) ?? 0) + 1);
  }
  const main = [...dispatches.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const onMain = events.filter((e) => e.tid === main && e.ph === "X" && e.dur !== undefined);
  const tasks = onMain.filter((e) => e.name === "RunTask" && (e.dur ?? 0) > 30_000);
  process.stdout.write(`${label}: ${tasks.length} tasks over 30 ms\n`);
  for (const task of tasks) {
    const end = task.ts + (task.dur ?? 0);
    const inside = onMain
      .filter((e) => e !== task && e.ts >= task.ts && e.ts + (e.dur ?? 0) <= end)
      .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
    process.stdout.write(`  task ${((task.dur ?? 0) / 1000).toFixed(1)} ms
`);
    const stack: TraceEvent[] = [task];
    for (const e of inside) {
      while (stack.length > 1) {
        const top = stack[stack.length - 1] as TraceEvent;
        if (e.ts >= top.ts + (top.dur ?? 0)) stack.pop();
        else break;
      }
      const depth = stack.length;
      stack.push(e);
      if ((e.dur ?? 0) < 1500 || depth > 6) continue;
      const d = e.args?.data;
      let key = e.name;
      if (e.name === "EventDispatch") key += `:${String(d?.type)}`;
      if (e.name === "FunctionCall")
        key += `:${String(d?.functionName)}@${String(d?.url).split("/").pop()}:${String(d?.lineNumber)}:${String(d?.columnNumber)}`;
      if (e.name === "TimerFire" || e.name === "TimerInstall") key += `:${String(d?.timerId)}`;
      const begin = (e.args as { beginData?: { stackTrace?: Record<string, unknown>[] } })
        ?.beginData;
      const top = begin?.stackTrace?.slice(0, 3);
      if (top !== undefined && top.length > 0) {
        key += ` forced by ${top.map((f) => `${String(f.functionName)}@${String(f.url).split("/").pop()}:${String(f.lineNumber)}:${String(f.columnNumber)}`).join(" < ")}`;
      }
      process.stdout.write(`${"  ".repeat(depth + 1)}${((e.dur ?? 0) / 1000).toFixed(1)} ${key}
`);
    }
  }
}

async function openForEditing(page: Page, sourceId: string): Promise<void> {
  const id = await eightPanels(sourceId);
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  await expect(page.locator(".ts__uplot canvas")).toHaveCount(8);
  await page.getByRole("button", { name: t("dashboards.edit") }).click();
  await expect(
    page.getByRole("status").filter({ hasText: t("dashboards.editingTag") }),
  ).toBeVisible();
}

test("profile: dragging a panel at 4x", async ({ page, browser, world }) => {
  test.setTimeout(240_000);
  await openForEditing(page, world.sourceId);
  const cdp = await page.context().newCDPSession(page);
  const card = page.getByRole("article", { name: "Sales", exact: true });
  const ROUNDS = Number(process.env.PROFILE_ROUNDS ?? "6");
  const worsts: number[] = [];
  for (let round = -1; round < ROUNDS; round++) {
    const heading = await card.locator(".panel-card__title").boundingBox();
    const box = await card.boundingBox();
    const grid = await page.locator(".dash-grid").first().boundingBox();
    if (heading === null || box === null || grid === null) throw new Error("no box");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await browser.startTracing(page, {
      categories: [
        "devtools.timeline",
        "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.stack",
        "v8.execute",
      ],
    });
    const rightward = box.x < grid.x + grid.width / 2;
    const from = { x: heading.x + 8, y: heading.y + heading.height / 2 };
    const to = { x: from.x + (rightward ? 1 : -1) * grid.width * 0.5, y: from.y + box.height / 2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 120; step++) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * step) / 120,
        from.y + ((to.y - from.y) * step) / 120,
      );
      if (step === 119) await page.evaluate(() => performance.mark("before-drop"));
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
    const buffer = await browser.stopTracing();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const trace = JSON.parse(buffer.toString()) as { traceEvents: TraceEvent[] } | TraceEvent[];
    const events = Array.isArray(trace) ? trace : trace.traceEvents;
    const mark = events.find((e) => e.name === "before-drop");
    const tasks = events.filter((e) => e.name === "RunTask" && (e.dur ?? 0) > 50_000);
    process.stdout.write(
      `round ${round}: tasks>50ms ${tasks.map((e) => `${((e.dur ?? 0) / 1000).toFixed(0)}ms@${mark ? ((e.ts - mark.ts) / 1000).toFixed(0) : "?"}ms-after-step119`).join(", ")}\n`,
    );
    if (round >= 0) worsts.push(Math.max(0, ...tasks.map((e) => (e.dur ?? 0) / 1000)));
    analyse(buffer, `round ${round}`);
    // Diagnosis only: a drop that did not move the panel is logged, not failed.
    await page.waitForTimeout(1_000);
    const moved = Math.abs(((await card.boundingBox())?.x ?? box.x) - box.x);
    process.stdout.write(`round ${round}: moved ${moved.toFixed(0)} px\n`);
  }
  process.stdout.write(`worst per round: ${worsts.map((w) => w.toFixed(0)).join(" ")}\n`);
});
