import type { Page } from "@playwright/test";
import { t } from "./support/i18n";
import { DIALOG_BODIES, findOverflow } from "./support/overflow";
import { MAIN_PAGES, openMainPage } from "./support/pages";
import { expect, signInOwner, test } from "./support/test";

async function expectNothingSticksOut(page: Page): Promise<void> {
  const overflow = await findOverflow(page);
  expect(overflow.offenders).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
}

// German words run longer, so both languages are checked.
for (const variant of [
  { locale: "en-US", language: "en" },
  { locale: "de-DE", language: "de" },
] as const) {
  test.describe(`360 px wide, ${variant.language}`, () => {
    test.use({ viewport: { width: 360, height: 740 }, locale: variant.locale });

    for (const main of MAIN_PAGES) {
      test(`${main.name}: nothing sticks out to the right`, async ({ page, world }) => {
        await signInOwner(page, variant.language);
        await openMainPage(page, main, world, variant.language);
        await expectNothingSticksOut(page);
        // The trail in the top bar names the page everywhere, the settings and Explore included,
        // and marks only the page itself as current (not the levels above it).
        const current = page.locator('.breadcrumbs [aria-current="page"]');
        await expect(current).toHaveCount(1);
        expect(((await current.textContent()) ?? "").trim()).not.toBe("");
      });
    }
  });
}

/**
 * The other widths the UI has to hold: a large phone, both sides of the 48rem breakpoint (768 and
 * 1024), a narrow desktop window (900) and a wide desktop. On the pages with the most layout (lists, the dashboard and its
 * editor, settings, forms), in English; the full set runs at 360 px above.
 */
const KEY_PAGES = new Set([
  "home",
  "dashboards",
  "dashboard",
  "panel editor",
  "dashboard settings",
  "explore result",
  "data sources",
  "data source kinds",
  "data source",
  "members",
  "server settings",
  "account",
]);

for (const viewport of [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 900, height: 720 },
  { width: 1024, height: 768 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`${viewport.width} px wide`, () => {
    test.use({ viewport, locale: "en-US" });

    for (const main of MAIN_PAGES.filter((m) => KEY_PAGES.has(m.name))) {
      test(`${main.name}: nothing sticks out to the right`, async ({ page, world }) => {
        await signInOwner(page, "en");
        await openMainPage(page, main, world, "en");
        await expectNothingSticksOut(page);
      });
    }
  });
}

/**
 * What the UI pass of 2026-11 found squeezed or split (docs/quality/ui-pass-2026-11.md), measured
 * so it stays put: the member and report rows on a laptop, in German, whose words run longest, and
 * the one toolbar row of the dashboard and of Explore on a desktop.
 */
const mainPage = (name: string) => {
  const found = MAIN_PAGES.find((main) => main.name === name);
  if (found === undefined) {
    throw new Error(`no main page ${name}`);
  }
  return found;
};

/** How many rows the boxes stand in: tops further apart than half a control start a new row. */
const rowsOf = (tops: number[]) =>
  [...tops].sort((a, b) => a - b).filter((top, i, all) => i === 0 || top - (all[i - 1] ?? top) > 16)
    .length;

test.describe("a laptop's width in German", () => {
  test.use({ viewport: { width: 1024, height: 768 }, locale: "de-DE" });

  test("members: the role is readable and the address stays on one line", async ({
    page,
    world,
  }) => {
    await signInOwner(page, "de");
    await openMainPage(page, mainPage("members"), world, "de");
    const table = page.getByRole("table", { name: t("admin.members.title", {}, "de") });
    const roles = table.getByRole("combobox");
    await expect(roles.first()).toBeVisible();
    // The closed select shows its whole value ("Eigentümer"), not an initial and an ellipsis.
    const cut = await roles.evaluateAll((selects) =>
      selects.map((select) => {
        const label = select.querySelector(".select__label") ?? select;
        return label.scrollWidth - label.clientWidth;
      }),
    );
    expect(Math.max(...cut)).toBeLessThanOrEqual(0);
    // One line per address: cut with an ellipsis if need be, and whole in its title.
    const addresses = await table.locator(".admin-person .admin-table__mono").evaluateAll((all) =>
      all.map((address) => ({
        lines: Math.round(
          address.getBoundingClientRect().height /
            Number.parseFloat(getComputedStyle(address).lineHeight),
        ),
        titled: address.getAttribute("title") === address.textContent,
      })),
    );
    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses).toEqual(addresses.map(() => ({ lines: 1, titled: true })));
    await expectNothingSticksOut(page);
  });

  test("reports: a row is as tall as its name and content, not five lines", async ({
    page,
    world,
  }) => {
    await signInOwner(page, "de");
    await openMainPage(page, mainPage("reports"), world, "de");
    const rows = page.getByRole("table").locator("tbody tr");
    const heights = await rows.evaluateAll((all) =>
      all.map((row) => row.getBoundingClientRect().height),
    );
    expect(heights.length).toBeGreaterThan(0);
    // The seeded report's long name on two lines, its content and its format and creator on one
    // each, and the cell's padding.
    expect(Math.max(...heights)).toBeLessThanOrEqual(104);
    // Schedule, format, recipients and the dates stay on one line each.
    const wrapped = await rows
      .first()
      .locator("td[data-label]")
      .evaluateAll(
        (cells) =>
          cells.filter(
            (cell) =>
              cell.getBoundingClientRect().height >
              2 * Number.parseFloat(getComputedStyle(cell).lineHeight) + 16,
          ).length,
      );
    expect(wrapped).toBe(0);
    await expectNothingSticksOut(page);
  });
});

for (const variant of [
  { locale: "en-US", language: "en" },
  { locale: "de-DE", language: "de" },
] as const) {
  test.describe(`a desktop's width, ${variant.language}`, () => {
    test.use({ viewport: { width: 1440, height: 900 }, locale: variant.locale });

    test("dashboard: the filters and the tools share one row", async ({ page, world }) => {
      await signInOwner(page, variant.language);
      await openMainPage(page, mainPage("dashboard"), world, variant.language);
      const tops = await page
        .locator(".dash-toolbar .variables__item, .dash-toolbar__tools button")
        .evaluateAll((all) =>
          all
            .map((control) => control.getBoundingClientRect())
            .filter((box) => box.width > 0)
            .map((box) => box.top + box.height / 2),
        );
      expect(tops.length).toBeGreaterThan(3);
      expect(rowsOf(tops)).toBe(1);
    });

    test("Explore: the data source and the tools share one row", async ({ page, world }) => {
      await signInOwner(page, variant.language);
      await openMainPage(page, mainPage("explore"), world, variant.language);
      const toolbar = page.locator(".explore__toolbar");
      await expect(
        toolbar.getByRole("button", { name: t("explore.run", {}, variant.language) }),
      ).toBeVisible();
      const tops = await toolbar.locator("button").evaluateAll((all) =>
        all
          .map((control) => control.getBoundingClientRect())
          .filter((box) => box.width > 0)
          .map((box) => box.top + box.height / 2),
      );
      expect(tops.length).toBeGreaterThan(4);
      expect(rowsOf(tops)).toBe(1);
      // History keeps its name whether it shows its word or only its icon.
      await expect(
        toolbar.getByRole("button", {
          name: t("explore.history.button", {}, variant.language),
          exact: true,
        }),
      ).toBeVisible();
    });
  });
}

test.describe("a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "de-DE" });

  test("a deep trail shows the parent and the page on one line", async ({ page, world }) => {
    await signInOwner(page, "de");
    await openMainPage(page, mainPage("plugin page"), world, "de");
    const trail = page.getByRole("navigation", { name: t("shell.breadcrumbs", {}, "de") });
    await expect(trail.locator('[aria-current="page"]')).toHaveCount(1);
    const items = await trail.locator(".breadcrumbs__item").evaluateAll((all) =>
      all.map((item) => {
        const box = item.getBoundingClientRect();
        return { shown: box.width > 0, top: Math.round(box.top) };
      }),
    );
    // Settings / Plugins / the plugin: the first level goes, the other two share one line.
    expect(items.length).toBeGreaterThan(2);
    const shown = items.filter((item) => item.shown);
    expect(shown).toHaveLength(2);
    expect(new Set(shown.map((item) => item.top)).size).toBe(1);
    await expect(trail.getByRole("link", { name: t("settings.title", {}, "de") })).toBeHidden();
  });
});

/**
 * Probes that the check above can fail: content too wide for a dialog whose body scrolls
 * (overflow: auto) must be caught, not hidden behind the body's scrollbar.
 */
test.describe("the overflow check itself", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  const PROBES = {
    "a 900 px block": (body: Element) => {
      const block = document.createElement("div");
      block.style.width = "900px";
      block.style.height = "4px";
      body.append(block);
    },
    // Preformatted, so it cannot wrap: a plain long word wraps in these dialogs by design
    // (overflow-wrap: break-word) and overflows nothing.
    "an unbreakable 80-character line": (body: Element) => {
      const line = document.createElement("pre");
      line.textContent = "x".repeat(80);
      body.append(line);
    },
  } as const;

  for (const [name, inject] of Object.entries(PROBES)) {
    for (const main of MAIN_PAGES.filter((m) => m.name === "add member")) {
      test(`${name} in the ${main.name} dialog is caught`, async ({ page, world }) => {
        test.fail(true, "the probe makes the dialog too wide on purpose");
        await signInOwner(page);
        await openMainPage(page, main, world, "en");
        await page.locator(DIALOG_BODIES).first().evaluate(inject);
        await expectNothingSticksOut(page);
      });
    }
  }
});
