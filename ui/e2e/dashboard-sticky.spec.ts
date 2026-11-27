import type { Page } from "@playwright/test";
import { Api, OWNER_CONTRAST, regionDashboard, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signIn, signInOwner, test } from "./support/test";
import { startEditing } from "./support/ui";

/** The sticky parts of a dashboard, by their place in the window. */
interface Sample {
  /** What scrolled: the main area next to the sidebar, or the document on a phone. */
  scroller: "main" | "document";
  scrollY: number;
  bar: number;
  toolbar: number;
  rail: number;
  railBottom: number;
  pane: number;
}

/** A dashboard of ten panels below each other, long enough to scroll well past the bars. */
async function longDashboard(sourceId: string): Promise<string> {
  const owner = await Api.owner();
  const model = regionDashboard(unique("Lang"), sourceId);
  const [first] = model.panels as Record<string, unknown>[];
  model.panels = Array.from({ length: 10 }, (_, i) => ({
    ...first,
    id: `p${i + 1}`,
    title: `Sales ${i + 1}`,
    grid: { x: 0, y: i * 8, w: 12, h: 8 },
  }));
  const id = await owner.createDashboard(model);
  await owner.dispose();
  return id;
}

/**
 * Scrolls the page's scroll container (the main area next to the sidebar) in small steps from
 * the top to its end, as a wheel does, and records where the top bar, the toolbar, the rail and
 * the open pane are after each step has been painted.
 */
function scrollInSteps(page: Page): Promise<Sample[]> {
  return page.evaluate(async () => {
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`${selector} is missing`);
      return element.getBoundingClientRect();
    };
    const painted = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const main = document.querySelector<HTMLElement>(".shell__main");
    const scroller =
      main !== null && getComputedStyle(main).overflowY === "auto"
        ? main
        : (document.scrollingElement ?? document.documentElement);
    const end = scroller.scrollHeight - scroller.clientHeight;
    const steps = [...Array.from({ length: 41 }, (_, i) => i * 3), 200, 400, end];
    const samples: Sample[] = [];
    for (const y of steps) {
      scroller.scrollTo(0, y);
      await painted();
      samples.push({
        scroller: scroller === main ? "main" : "document",
        scrollY: scroller.scrollTop,
        bar: box(".top-bar").top,
        toolbar: box(".dash-toolbar").top,
        rail: box(".dash-rail__column").top,
        railBottom: box(".dash-rail__column").bottom,
        pane: box(".dash-pane").top,
      });
    }
    return samples;
  });
}

/**
 * Next to the sidebar (every window here is wider than a phone) the main area scrolls, and the
 * top bar stays at the window's top. Every sample within half a pixel of the first: the toolbar,
 * rail and pane rest where they stick. (A notice between the toolbar and the canvas, such as the trash's, scrolls away first
 * and the rail follows it until it is gone; that slide is by design and not checked here.)
 */
function expectNoMovement(samples: Sample[]): void {
  const [rest] = samples;
  if (rest === undefined) throw new Error("no samples");
  expect(Math.abs(rest.bar), "top bar at the window's top").toBeLessThanOrEqual(0.5);
  for (const sample of samples) {
    const at = `at scrollY ${sample.scrollY}`;
    expect(sample.scroller, `what scrolled ${at}`).toBe("main");
    expect(sample.bar, `top bar ${at}`).toBeCloseTo(rest.bar, 0);
    // Right below the top bar from the start, not first a few pixels lower.
    expect(Math.abs(sample.toolbar - rest.toolbar), `toolbar ${at}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(sample.rail - rest.rail), `rail ${at}`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(sample.pane - rest.pane), `pane ${at}`).toBeLessThanOrEqual(0.5);
  }
}

/**
 * The rail runs down to the window's lower edge, less what sticky columns leave free there, and
 * is not pushed up at the page's end (the last samples).
 */
async function expectRailToBottom(page: Page, samples: Sample[], height: number): Promise<void> {
  const free = await tokenPx(page, "--space-sticky-bottom");
  expect(free).toBeGreaterThan(0);
  for (const sample of samples.slice(-3)) {
    const gap = height - sample.railBottom;
    expect(gap, `rail bottom at scrollY ${sample.scrollY}`).toBeGreaterThanOrEqual(-0.5);
    expect(gap, `rail bottom at scrollY ${sample.scrollY}`).toBeLessThanOrEqual(free + 0.5);
  }
}

/** A length token in pixels, as the browser resolves it. */
function tokenPx(page: Page, token: `--${string}`): Promise<number> {
  return page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.blockSize = `var(${name})`;
    document.body.append(probe);
    const px = probe.getBoundingClientRect().height;
    probe.remove();
    return px;
  }, token);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
]) {
  test(`${viewport.width}x${viewport.height}: the toolbar, rail and pane rest where they stick and never move while the dashboard scrolls`, async ({
    page,
    world,
  }) => {
    const id = await longDashboard(world.sourceId);
    await page.setViewportSize(viewport);
    await signInOwner(page);
    await page.goto(`/dashboards/${id}`);
    await expect(page.getByRole("group", { name: "Sales 1", exact: true })).toBeVisible();
    await page.getByRole("button", { name: t("toolbar.rail.outline") }).click();
    await expect(page.locator(".dash-pane")).toBeVisible();

    const samples = await scrollInSteps(page);
    // The page really scrolled, to its end.
    expect(samples[samples.length - 1]?.scrollY ?? 0).toBeGreaterThan(viewport.height);
    expectNoMovement(samples);
    await expectRailToBottom(page, samples, viewport.height);
  });
}

// Windows too low for all of the rail's buttons: viewing (the most buttons) and editing (fewer,
// so a lower window).
for (const { viewport, editing } of [
  { viewport: { width: 1280, height: 500 }, editing: false },
  { viewport: { width: 1280, height: 320 }, editing: true },
]) {
  test(`${viewport.width}x${viewport.height}, ${editing ? "editing" : "viewing"}, contrast theme: the rail scrolls inside itself and clips no focus ring`, async ({
    page,
    world,
  }) => {
    const id = await longDashboard(world.sourceId);
    await page.setViewportSize(viewport);
    // The contrast theme draws the widest focus ring.
    await signIn(page, OWNER_CONTRAST.email, OWNER_CONTRAST.password, "en");
    await page.goto(`/dashboards/${id}`);
    await expect(page.getByRole("group", { name: "Sales 1", exact: true })).toBeVisible();
    const outline = page.getByRole("button", { name: t("toolbar.rail.outline") });
    if (editing) {
      // Edit mode starts with the outline open (its room is taken as editing starts).
      await startEditing(page);
      await expect(outline).toHaveAttribute("aria-expanded", "true");
    } else {
      await outline.click();
    }
    await expect(page.locator(".dash-pane")).toBeVisible();

    const samples = await scrollInSteps(page);
    expectNoMovement(samples);
    await expectRailToBottom(page, samples, viewport.height);

    // Too low for all of its buttons: the column scrolls them inside itself.
    const column = page.locator(".dash-rail__column");
    const overflow = await column.evaluate(
      (element) => element.scrollHeight - element.clientHeight,
    );
    expect(overflow).toBeGreaterThan(0);

    // Every button's ring (its width plus its offset around the button) stays inside the column's
    // visible area, at both ends of its own scroll, so no edge of a ring is cut off.
    const ring = await tokenPx(page, "--space-ring-room");
    expect(ring).toBeGreaterThan(0);
    for (const end of ["start", "end"] as const) {
      const cut = await column.evaluate(
        (element, { end, ring }) => {
          element.scrollTop = end === "start" ? 0 : element.scrollHeight;
          const box = element.getBoundingClientRect();
          const inner = {
            left: box.left + element.clientLeft,
            right: box.left + element.clientLeft + element.clientWidth,
            top: box.top + element.clientTop,
            bottom: box.top + element.clientTop + element.clientHeight,
          };
          const buttons = [...element.querySelectorAll("button")].map((b) =>
            b.getBoundingClientRect(),
          );
          const edge = end === "start" ? buttons[0] : buttons[buttons.length - 1];
          const found: string[] = [];
          for (const [i, b] of buttons.entries()) {
            if (b.left - ring < inner.left - 0.5 || b.right + ring > inner.right + 0.5) {
              found.push(`button ${i} cut at the side`);
            }
          }
          if (edge !== undefined && end === "start" && edge.top - ring < inner.top - 0.5) {
            found.push("first button cut at the top");
          }
          if (edge !== undefined && end === "end" && edge.bottom + ring > inner.bottom + 0.5) {
            found.push("last button cut at the bottom");
          }
          return found;
        },
        { end, ring },
      );
      expect(cut, `scrolled to the ${end}`).toEqual([]);
    }
  });
}
