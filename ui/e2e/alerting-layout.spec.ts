import type { Locator, Page } from "@playwright/test";
import { Api, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { findOverflow } from "./support/overflow";
import { expect, signInOwner, test } from "./support/test";

/**
 * How the alerting screens hold at a phone's, a medium and a wide window's width (the UI pass of
 * 2026-11, docs/quality/ui-pass-2026-11.md): no list widens the page or is cut off, a rule is two
 * lines at 1024 px, a policy's own values are one line, and the rule editor's choices are as wide
 * as their options.
 */

let owner: Api;
let ruleName: string;
let ruleId: string;
let pointName: string;
let policyName: string;
let ownPolicyName: string;
let comment: string;
let silenceEnds: number;
/** What this file made, taken away again in afterAll: other files share the organization. */
const made = {
  rules: [] as string[],
  policies: [] as string[],
  points: [] as string[],
  silences: [] as string[],
};
const org = (path: string) => `/api/orgs/${owner.orgId}${path}`;

test.beforeAll(async ({ world }) => {
  owner = await Api.owner();
  const id = async (answer: { status(): number; json(): Promise<unknown> }) => {
    expect([200, 201]).toContain(answer.status());
    return ((await answer.json()) as { id: string }).id;
  };
  await owner.context.put(org(`/datasources/${world.sourceId}/alerting`), {
    data: { enabled: true },
  });
  // A label value of this run alone, so nothing here matches what another file or worker made.
  const team = unique("lager").replace(/[^a-z0-9_]/gi, "_");
  pointName = unique("Bereitschaft Lager");
  made.points.push(
    await id(
      await owner.context.post(org("/alerting/contact-points"), {
        data: {
          name: pointName,
          kind: "webhook",
          language: "en",
          url: "http://127.0.0.1:9/kalzit",
        },
      }),
    ),
  );
  // The source's name is a long one, as people give them (support/test.ts).
  ruleName = unique("Umsatz Nord");
  ruleId = await id(
    await owner.context.post(org("/alerting/rules"), {
      data: {
        name: ruleName,
        datasourceId: world.sourceId,
        query: { query: { sql: SQL.series }, steps: [], variables: { region: "Nord" } },
        reduce: { shape: "frame", function: "max" },
        condition: { op: "gt", value: 1_000_000 },
        labels: { team },
      },
    }),
  );
  made.rules.push(ruleId);
  const policies = (await (await owner.context.get(org("/alerting/policies"))).json()) as {
    items: { id: string; isRoot: boolean }[];
  };
  const parentId = policies.items.find((item) => item.isRoot)?.id ?? "";
  // One policy that leaves grouping and times to the one above ...
  policyName = unique("Lager");
  made.policies.push(
    await id(
      await owner.context.post(org("/alerting/policies"), {
        data: { parentId, name: policyName, matchers: [{ label: "team", op: "=", value: team }] },
      }),
    ),
  );
  // ... and one that sets all four itself (it matches no rule).
  ownPolicyName = unique("Eigene Zeiten");
  made.policies.push(
    await id(
      await owner.context.post(org("/alerting/policies"), {
        data: {
          parentId,
          name: ownPolicyName,
          matchers: [{ label: "layout", op: "=", value: team }],
          groupBy: ["alertname"],
          groupWaitSecs: 60,
          groupIntervalSecs: 600,
          repeatIntervalSecs: 7200,
        },
      }),
    ),
  );
  comment = unique("Wartung am Lagerrechner");
  silenceEnds = lateEvening(Date.now());
  made.silences.push(
    await id(
      await owner.context.post(org("/alerting/silences"), {
        data: {
          matchers: [{ label: "team", op: "=", value: team }],
          endsAt: silenceEnds,
          comment,
        },
      }),
    ),
  );
});

test.afterAll(async () => {
  // A silence cannot be deleted; ended, it leaves the list of active ones.
  for (const silence of made.silences) {
    await owner.context.post(org(`/alerting/silences/${silence}/expire`));
  }
  for (const rule of made.rules) {
    await owner.context.delete(org(`/alerting/rules/${rule}`));
  }
  for (const policy of made.policies) {
    await owner.context.delete(org(`/alerting/policies/${policy}`));
  }
  for (const point of made.points) {
    await owner.context.delete(org(`/alerting/contact-points/${point}`));
  }
  await owner.dispose();
});

/**
 * 22:58 UTC on the first day at least two hours ahead: an end with a two-digit afternoon hour
 * ("10:58 PM", "22:58"), the longest time a rule's state line can say.
 */
function lateEvening(now: number): number {
  const at = new Date(now);
  at.setUTCHours(22, 58, 0, 0);
  if (at.getTime() < now + 2 * 3_600_000) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime();
}

interface ListPage {
  name: string;
  path: string;
  ready: (page: Page) => Promise<void>;
}

const LISTS: ListPage[] = [
  {
    name: "rules",
    path: "/alerting",
    ready: async (page) => {
      await expect(page.getByRole("link", { name: ruleName })).toBeVisible();
    },
  },
  {
    name: "contact points",
    path: "/alerting/contact-points",
    ready: async (page) => {
      await expect(page.getByText(pointName, { exact: true })).toBeVisible();
    },
  },
  {
    name: "silences",
    path: "/alerting/silences",
    ready: async (page) => {
      await expect(page.getByText(comment).first()).toBeVisible();
    },
  },
  {
    name: "policies",
    path: "/alerting/policies",
    ready: async (page) => {
      await expect(
        page.getByRole("treeitem", { name: new RegExp(`^${policyName}, `) }),
      ).toBeVisible();
    },
  },
];

/** Frames that may scroll sideways when they must; on these pages none has to. */
const FRAMES = ".alert-table-wrap, .alert-ptree";

async function expectListFits(page: Page): Promise<void> {
  const overflow = await findOverflow(page);
  expect(overflow.offenders).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
  // Nothing is cut off inside its frame either: no list scrolls sideways.
  const scrolling = await page
    .locator(FRAMES)
    .evaluateAll((frames) =>
      frames
        .filter((frame) => frame.scrollWidth > frame.clientWidth + 1)
        .map((frame) => `${frame.className}: ${frame.scrollWidth} px in ${frame.clientWidth} px`),
    );
  expect(scrolling).toEqual([]);
}

/** The text of an element as it is shown: without the parts the style sheet hides. */
const shownText = (selector: string, within: Locator) =>
  within
    .locator(selector)
    .first()
    .evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = "";
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if ((node.parentElement?.getClientRects().length ?? 0) > 0) text += node.textContent ?? "";
      }
      return text;
    });

/** The height of one line of the element's own text. */
const lineHeight = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));

for (const variant of [
  { locale: "en-US", language: "en" },
  { locale: "de-DE", language: "de" },
] as const) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    test.describe(`${viewport.width} px wide, ${variant.language}`, () => {
      test.use({ viewport, locale: variant.locale });

      for (const list of LISTS) {
        test(`${list.name}: the list fits, on the page and in its frame`, async ({ page }) => {
          await signInOwner(page, variant.language);
          await page.goto(list.path);
          await list.ready(page);
          await expectListFits(page);
        });
      }

      // What the rule's state line says depends on the clock: the time while the silence ends
      // the same day, the day once it ends on another. Both at their longest, set by the
      // browser's clock, so the list cannot fit by the luck of the hour the run starts at.
      for (const moment of [
        { name: "the same day", before: 58 * 60_000, says: /(22:58|10:58\sPM)$/ },
        { name: "another day", before: 26 * 3_600_000, says: /\d{2}[./]\d{2}\.?$/ },
      ]) {
        test(`rules: the list fits when the silence ends ${moment.name}`, async ({ page }) => {
          await signInOwner(page, variant.language);
          await page.clock.setFixedTime(silenceEnds - moment.before);
          await page.goto("/alerting");
          const row = page
            .getByRole("row")
            .filter({ has: page.getByRole("link", { name: ruleName }) });
          await expect(row.locator(".alert-state-cell .alert-sub").first()).toHaveText(moment.says);
          await expectListFits(page);
        });
      }
    });
  }
}

test.describe("1024 px wide", () => {
  test.use({ viewport: { width: 1024, height: 768 }, locale: "de-DE" });

  test("a rule is short lines: source and shape under its name, the interval under the condition", async ({
    page,
  }) => {
    await signInOwner(page, "de");
    await page.goto("/alerting");
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: ruleName }) });
    await expect(row).toBeVisible();
    // The folded columns are gone, and each of their values is still said once.
    await expect(row.locator(".alert-rules__wide").first()).toBeHidden();
    await expect(row.locator(".alert-rules__roomy")).toBeHidden();
    for (const fold of await row.locator(".alert-rules__fold, .alert-rules__fold-tight").all()) {
      await expect(fold).toBeVisible();
    }
    await expect(row.getByText("frame", { exact: true }).filter({ visible: true })).toHaveCount(1);
    // The name, the state, the source and the interval keep to one line each; the long name of
    // the source ends in an ellipsis instead of wrapping or widening the table.
    const line = await lineHeight(page, ".alert-rule-name");
    for (const selector of [
      ".alert-rule-name",
      ".alert-state",
      ".alert-rules__fold .alert-source__name",
      ".alert-rules__fold.alert-nowrap",
    ]) {
      const box = await row.locator(selector).first().boundingBox();
      expect(box?.height ?? 0, selector).toBeGreaterThan(0);
      expect(box?.height ?? 0, selector).toBeLessThan(line * 1.5);
    }
    // The condition is two lines at most ("max je Serie >", its value), not a word per line.
    const condition = await row.locator(".alert-rules__condition .alert-mono-cell").boundingBox();
    expect(condition?.height ?? 0).toBeGreaterThan(0);
    expect(condition?.height ?? 0).toBeLessThan(line * 2.5);
    const cut = await row
      .locator(".alert-rules__fold .alert-source__name")
      .evaluate((name) => name.scrollWidth > name.clientWidth);
    expect(cut).toBe(true);
    await expect(row.locator(".alert-rules__fold .alert-source")).toHaveAttribute("title", /\S/);
    // This rule has a label and is silenced, so its name and its state take three lines each
    // (name, labels, source; state, "silenced until", evaluated): never the four lines of
    // wrapped values the rows had at this width.
    await expect(row.locator(".alert-state-cell .alert-sub").first()).toBeVisible();
    const silenced = await row.locator(".alert-state-cell .alert-sub").first().boundingBox();
    expect(silenced?.height ?? 0).toBeLessThan(line * 1.5);
    expect((await row.boundingBox())?.height ?? 0).toBeLessThan(line * 5);
    // The row's menu is in reach: the table does not run out of its frame.
    await expect(row.getByRole("button", { name: new RegExp(ruleName) }).last()).toBeInViewport();
  });
});

test.describe("1440 px wide", () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: "de-DE" });

  test("a policy writes its own values on one line and says inherited once", async ({ page }) => {
    await signInOwner(page, "de");
    await page.goto("/alerting/policies");
    // A policy that sets all four: the bare values under the heading that names them.
    const own = page.getByRole("treeitem", { name: new RegExp(`^${ownPolicyName}, `) });
    await expect(own).toBeVisible();
    const times = own.locator(".alert-times");
    expect(await shownText(".alert-times", own)).toMatch(
      /^alertname · \d+ \S+ · \d+ \S+ · \d+ \S+$/,
    );
    const line = await lineHeight(page, ".alert-times");
    expect((await times.boundingBox())?.height ?? 0).toBeLessThan(line * 1.5);
    // The heading that names the four values is one line too.
    const heading = page.locator(".alert-prow--head .alert-times");
    expect((await heading.boundingBox())?.height ?? 0).toBeLessThan(line * 1.5);
    // The policy below sets neither grouping nor times: the one word, not one per value.
    const child = page.getByRole("treeitem", { name: new RegExp(`^${policyName}, `) });
    await expect(child.locator(".alert-times")).toHaveText(
      t("alerting.policies.inherited", {}, "de"),
    );
  });
});

test.describe("390 px wide", () => {
  test.use({ viewport: { width: 390, height: 844 }, locale: "de-DE" });

  test("a policy names its times, since the heading that would is hidden", async ({ page }) => {
    await signInOwner(page, "de");
    await page.goto("/alerting/policies");
    const own = page.getByRole("treeitem", { name: new RegExp(`^${ownPolicyName}, `) });
    await expect(own).toBeVisible();
    await expect(page.locator(".alert-prow--head")).toBeHidden();
    const said = await shownText(".alert-times", own);
    // "Warten 1 min", "Intervall 10 min", "Wiederholen 2 h": never a bare number.
    const name = (key: "wait" | "interval" | "repeat") =>
      t(`alerting.policies.own.${key}`, { value: "" }, "de").trim();
    expect(said).toMatch(
      new RegExp(
        `^alertname · ${name("wait")} \\d+ \\S+ · ${name("interval")} \\d+ \\S+ · ${name("repeat")} \\d+ \\S+$`,
      ),
    );
  });
});

test.describe("the rule editor at 1440 px", () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: "de-DE" });

  test("draws its choices as wide as their options and starts both columns on one line", async ({
    page,
  }) => {
    await signInOwner(page, "de");
    await page.goto(`/alerting/rules/${ruleId}`);
    await expect(page.getByRole("heading", { level: 1, name: ruleName })).toBeVisible();
    const groups = page.getByRole("radiogroup");
    await expect(groups.first()).toBeVisible();
    for (const group of await groups.all()) {
      // The well ends with its last option (its padding and frame aside).
      const well = await group.boundingBox();
      const last = await group.getByRole("radio").last().boundingBox();
      if (well === null || last === null) throw new Error("a segmented control without a box");
      expect(well.x + well.width - (last.x + last.width)).toBeLessThan(8);
    }
    const form = await page.locator(".alert-editor__form > .alert-card").first().boundingBox();
    const side = await page.locator(".alert-editor__side > :first-child").boundingBox();
    expect(Math.abs((form?.y ?? 0) - (side?.y ?? 100))).toBeLessThan(1);
  });
});
