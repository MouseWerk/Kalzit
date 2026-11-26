import type { Locator, Page } from "@playwright/test";
import { FAKE_GRAPH_SCHEMA, graphOutcome } from "../../src/features/datasources/test/fakeGraph";
import { type Language, t } from "../support/i18n";
import { expect } from "../support/test";
import { fillQuery } from "../support/ui";
import { SWEEP_PAGES, type SweepPage } from "../sweep/pages";
import type { Seed } from "./seed";

/**
 * The screens the visual comparison takes pictures of: every page of the UI sweep (sweep/pages.ts,
 * which its own test holds against the router, so a new route lands here too), plus Explore with
 * the result shapes the sweep does not open (documents and graph). The setup steps are taken
 * by setup.visual.ts, on the fresh server.
 */
export interface Screen {
  name: string;
  path: (seed: Seed) => string;
  signedOut: boolean;
  prepare?: (page: Page) => Promise<void>;
  ready: (page: Page, seed: Seed, language: Language) => Promise<void>;
  /** Parts of the page that change while it is shown (a countdown), masked in the picture. */
  masks?: (page: Page) => Locator[];
}

const fromSweep = (page: SweepPage): Screen => ({
  name: page.name,
  path: (seed) => page.path(seed.world, seed.extras),
  signedOut: page.signedOut === true,
  ...(page.prepare === undefined ? {} : { prepare: page.prepare }),
  ready: (opened, seed, language) => page.ready(opened, seed.world, language),
});

/**
 * Pages that need another state here. The sweep makes a new report on each visit of the reports
 * list, which would add a row to every later picture; here the list shows the report the setup
 * made. The public dashboard opens the link whose window reaches the fixed moment (seed.ts).
 */
const OVERRIDES: Readonly<Record<string, Partial<Screen>>> = {
  "public dashboard": { path: (seed) => `/public/dashboards/${seed.publicToken}` },
  // "Send again in 59 s" counts down once a second from the moment the link was sent.
  "register: inbox": {
    masks: (page) => [page.getByRole("button", { name: /^Send again in \d+ s$/ })],
  },
  reports: {
    ready: async (page, _seed, language) => {
      await expect(
        page.getByRole("heading", { name: t("reports.title", {}, language), exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: /^Wochenbericht Vertrieb/ })).toBeVisible();
    },
  },
};

/**
 * Steps after a sweep page reached its state. The page scrolls the CORS check's result into view;
 * scrolled, the sticky sidebar and settings list were drawn a pixel apart from run to run at
 * 1280 px (also with whole-pixel scroll positions short of the page's end; the cause is not
 * found). The picture shows the page from its top instead: the result is in view at 2560 and
 * 3440 px, where nothing scrolls.
 */
const AFTER: Readonly<Record<string, (page: Page) => Promise<void>>> = {
  "cors in use": async (page) => {
    await page.evaluate(() => window.scrollTo(0, 0));
  },
};

/** The Neo4j source's answers: the fake graph of the UI tests, and its schema. */
async function graphAnswers(page: Page): Promise<void> {
  await page.route(/\/api\/orgs\/[^/]+\/query$/, async (route) => {
    const body = route.request().postDataJSON() as {
      queries: { refId: string; query: Record<string, unknown> }[];
      variables?: Record<string, unknown>;
    };
    const item = body.queries[0];
    if (item === undefined || typeof item.query.cypher !== "string") {
      return route.fallback();
    }
    return route.fulfill({
      json: { results: { [item.refId]: graphOutcome(item.query.cypher, body.variables ?? {}) } },
    });
  });
  await page.route(/\/api\/orgs\/[^/]+\/datasources\/[^/]+\/schema(\?|$)/, (route) =>
    route.fulfill({ json: FAKE_GRAPH_SCHEMA }),
  );
}

const SHOP = "MATCH (c:Customer)-[b:BOUGHT]->(p:Product) RETURN c, b, p";

const EXTRA: Screen[] = [
  {
    name: "explore documents",
    path: (seed) => `/explore?source=${seed.documentsSourceId}`,
    signedOut: false,
    ready: async (page, _seed, language) => {
      const run = page.getByRole("button", { name: t("explore.run", {}, language) });
      await expect(run).toBeEnabled();
      await run.click();
      await expect(
        page.getByRole("region", { name: t("explore.result", {}, language) }),
      ).toContainText(t("documents.summary.countMany", { count: 12 }, language));
    },
  },
  {
    name: "explore graph",
    path: (seed) => `/explore?source=${seed.graphSourceId}`,
    signedOut: false,
    prepare: graphAnswers,
    ready: async (page, _seed, language) => {
      await fillQuery(page, SHOP);
      await page.getByRole("button", { name: t("explore.run", {}, language) }).click();
      await expect(
        page.getByRole("region", { name: t("explore.result", {}, language) }).locator("canvas"),
      ).not.toHaveCount(0);
    },
  },
];

export const SCREENS: readonly Screen[] = [
  ...SWEEP_PAGES.map((page) => {
    const screen: Screen = { ...fromSweep(page), ...OVERRIDES[page.name] };
    const after = AFTER[page.name];
    return after === undefined
      ? screen
      : {
          ...screen,
          ready: async (opened: Page, seed: Seed, language: Language) => {
            await screen.ready(opened, seed, language);
            await after(opened);
          },
        };
  }),
  ...EXTRA,
];
