import type { Page } from "@playwright/test";
import { Api, regionDashboard, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/** The sticky parts of a dashboard, by their place in the window. */
interface Sample {
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
 * Scrolls the page in small steps from the top to its end, as a wheel does, and records where
 * the top bar, the toolbar, the rail and the open pane are after each step has been painted.
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
    const end = document.documentElement.scrollHeight - window.innerHeight;
    const steps = [...Array.from({ length: 41 }, (_, i) => i * 3), 200, 400, end];
    const samples: Sample[] = [];
    for (const y of steps) {
      window.scrollTo(0, y);
      await painted();
      samples.push({
        scrollY: window.scrollY,
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
    const [rest] = samples;
    if (rest === undefined) throw new Error("no samples");
    const last = samples[samples.length - 1];
    // The page really scrolled, to its end.
    expect(last?.scrollY ?? 0).toBeGreaterThan(viewport.height);

    for (const sample of samples) {
      const at = `at scrollY ${sample.scrollY}`;
      expect(sample.bar, `top bar ${at}`).toBeCloseTo(rest.bar, 0);
      // Right below the top bar from the start, not first a few pixels lower.
      expect(Math.abs(sample.toolbar - rest.toolbar), `toolbar ${at}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(sample.rail - rest.rail), `rail ${at}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(sample.pane - rest.pane), `pane ${at}`).toBeLessThanOrEqual(0.5);
    }

    // The rail runs down to the window's lower edge, less what sticky columns leave free there,
    // and is not pushed up at the page's end.
    const free = await tokenPx(page, "--space-sticky-bottom");
    expect(free).toBeGreaterThan(0);
    for (const sample of samples.slice(-3)) {
      const gap = viewport.height - sample.railBottom;
      expect(gap, `rail bottom at scrollY ${sample.scrollY}`).toBeGreaterThanOrEqual(-0.5);
      expect(gap, `rail bottom at scrollY ${sample.scrollY}`).toBeLessThanOrEqual(free + 0.5);
    }
  });
}
