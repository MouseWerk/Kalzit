import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { Api, SQL, unique } from "../support/api";
import { t } from "../support/i18n";
import { MAIN_PAGES, type MainPage } from "../support/pages";
import { expect, type World } from "../support/test";
import { startEditing } from "../support/ui";

/**
 * The pages the sweep visits: the main pages the layout and accessibility checks already open
 * (support/pages.ts), every other address of the router with what it needs to show content, each
 * section of the settings and the pages before sign-in. `routes.sweep.ts` holds the list against
 * the router, so a new route without a page here fails there.
 */

/** What the pages beyond the main ones need, made once per worker through the API. */
export interface Extras {
  teamId: string;
  roleId: string;
  ruleId: string;
  policyId: string;
  rootPolicyId: string;
  analysisId: string;
  playlistId: string;
  reportId: string;
}

export interface SweepPage extends Omit<MainPage, "path"> {
  path: (world: World, extras: Extras) => string;
  /** Opened without a session, as a visitor sees it. */
  signedOut?: boolean;
}

async function created(
  answer: { status(): number; json(): Promise<unknown>; text(): Promise<string> },
  what: string,
) {
  if (answer.status() !== 201 && answer.status() !== 200) {
    throw new Error(`${what}: HTTP ${answer.status()} ${await answer.text()}`);
  }
  return ((await answer.json()) as { id: string }).id;
}

/** A team, a role, an alert rule with its routing, a saved analysis, a playlist and a report. */
export async function seedExtras(world: World): Promise<Extras> {
  const owner = await Api.owner();
  const org = (path: string) => `/api/orgs/${owner.orgId}${path}`;
  try {
    const me = (await (await owner.context.get("/api/me")).json()) as { id: string };
    const teamId = await owner.createTeam(unique("Vertrieb Nord und Süd"), [me.id]);
    const roleId = await created(
      await owner.context.post(org("/roles"), {
        data: {
          name: unique("Berichte lesen"),
          description: "Liest Dashboards und Berichte, ändert nichts.",
          permissions: ["dashboards:read"],
        },
      }),
      "create role",
    );
    // Alerting: the source opted in, a contact point, a rule on the dashboard's panel, a policy
    // below the root and a silence.
    await owner.context.put(org(`/datasources/${world.sourceId}/alerting`), {
      data: { enabled: true },
    });
    await created(
      await owner.context.post(org("/alerting/contact-points"), {
        data: {
          name: unique("Bereitschaft Lager"),
          kind: "webhook",
          language: "en",
          url: "http://127.0.0.1:9/kalzit",
        },
      }),
      "create contact point",
    );
    const ruleId = await created(
      await owner.context.post(org("/alerting/rules"), {
        data: {
          name: unique("Umsatz der Region Nord zu hoch"),
          datasourceId: world.sourceId,
          query: { query: { sql: SQL.series }, steps: [], variables: { region: "Nord" } },
          reduce: { shape: "frame", function: "max" },
          condition: { op: "gt", value: 1_000_000 },
          dashboardId: world.dashboardId,
          panelId: "p1",
        },
      }),
      "create rule",
    );
    const policies = (await (await owner.context.get(org("/alerting/policies"))).json()) as {
      items: { id: string; isRoot: boolean }[];
    };
    const rootPolicyId = policies.items.find((item) => item.isRoot)?.id ?? "";
    const policyId = await created(
      await owner.context.post(org("/alerting/policies"), {
        data: {
          parentId: rootPolicyId,
          name: unique("Lager"),
          matchers: [{ label: "team", op: "=", value: "lager" }],
        },
      }),
      "create policy",
    );
    await created(
      await owner.context.post(org("/alerting/silences"), {
        data: {
          matchers: [{ label: "team", op: "=", value: "lager" }],
          endsAt: Date.now() + 3_600_000,
          comment: "Wartung am Lagerrechner",
        },
      }),
      "create silence",
    );
    const analysisId = await owner.createAnalysis({
      schemaVersion: 1,
      title: unique("Umsatz je Region"),
      description: "Für die Wochenrunde",
      timeRange: { from: "now-6h", to: "now" },
      targets: [
        {
          refId: "A",
          datasourceId: world.sourceId,
          query: {
            sql: "SELECT region, ROUND(SUM(amount)) AS total FROM sales WHERE $__timeFilter(ts) GROUP BY region ORDER BY region",
          },
        },
      ],
      steps: [],
      visualization: { type: "table", options: {} },
    });
    const playlistId = await created(
      await owner.context.post(org("/playlists"), {
        data: {
          name: unique("Wandbildschirm Vertrieb"),
          intervalSeconds: 60,
          items: [{ type: "dashboard", dashboardId: world.dashboardId }],
        },
      }),
      "create playlist",
    );
    const reportId = await created(
      await owner.context.post(org("/reports"), {
        data: {
          name: unique("Wochenbericht Vertrieb Nord und Süd"),
          dashboardId: world.dashboardId,
          schedule: { kind: "weekly", time: "07:00", weekdays: ["mon", "wed", "fri"] },
          timeZone: "Europe/Berlin",
          formats: ["pdf"],
          language: "en",
          recipients: [{ userId: me.id }],
        },
      }),
      "create report",
    );
    return { teamId, roleId, ruleId, policyId, rootPolicyId, analysisId, playlistId, reportId };
  } finally {
    await owner.dispose();
  }
}

/** The first heading of the page's content. */
async function anyHeading(page: Page): Promise<void> {
  await expect(page.locator("main h1, main h2, h1").first()).toBeVisible();
}

async function sectionReady(page: Page): Promise<void> {
  await expect(page.locator("#settings-section-title")).toBeVisible();
}

/** The settings sections, read from the list the settings page itself is built from. */
function settingsSections(): string[] {
  const file = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "features",
    "settings",
    "sections.ts",
  );
  return [...readFileSync(file, "utf8").matchAll(/^ {4}id: "([\w-]+)",$/gm)].map(
    (match) => match[1] ?? "",
  );
}

const main: SweepPage[] = MAIN_PAGES.map((page) => ({
  ...page,
  path: (world) => page.path(world),
}));
const mainPaths = new Set(
  MAIN_PAGES.map((page) =>
    page.path({ sourceId: "s", sourceName: "", dashboardId: "d", dashboardTitle: "" }),
  ),
);

const sections: SweepPage[] = settingsSections()
  .filter((id) => !mainPaths.has(`/settings/${id}`))
  .map((id) => ({ name: `settings: ${id}`, path: () => `/settings/${id}`, ready: sectionReady }));

const app: SweepPage[] = [
  { name: "administration", path: () => "/admin", ready: anyHeading },
  { name: "settings", path: () => "/settings", ready: sectionReady },
  { name: "team", path: (_w, x) => `/admin/teams/${x.teamId}`, ready: anyHeading },
  { name: "role", path: (_w, x) => `/admin/roles/${x.roleId}`, ready: anyHeading },
  {
    name: "dashboard editing",
    path: (w) => `/dashboards/${w.dashboardId}`,
    ready: async (page, world, language) => {
      await expect(page.getByRole("heading", { name: world.dashboardTitle })).toBeVisible();
      await expect(page.getByRole("group", { name: "Sales" })).toBeVisible();
      await startEditing(page, language);
    },
  },
  {
    name: "new panel",
    path: (w) => `/dashboards/${w.dashboardId}/panels/new`,
    ready: async (page) => {
      await anyHeading(page);
      await expect(page.locator(".cm-editor").first()).toBeVisible();
    },
  },
  {
    name: "playlist playing",
    path: (_w, x) => `/dashboards/playlists/${x.playlistId}/play`,
    ready: async (page, world) => {
      await expect(page.getByRole("heading", { name: world.dashboardTitle })).toBeVisible();
    },
  },
  { name: "saved analysis", path: (_w, x) => `/explore/saved/${x.analysisId}`, ready: anyHeading },
  {
    name: "saved analysis history",
    path: (_w, x) => `/explore/saved/${x.analysisId}/versions`,
    ready: anyHeading,
  },
  { name: "report", path: (_w, x) => `/reports/${x.reportId}`, ready: anyHeading },
  { name: "report runs", path: (_w, x) => `/reports/${x.reportId}/runs`, ready: anyHeading },
  {
    name: "alert rules",
    path: () => "/alerting",
    ready: async (page) => {
      await anyHeading(page);
      await expect(
        page.getByRole("link", { name: /Umsatz der Region Nord/ }).first(),
      ).toBeVisible();
    },
  },
  { name: "new alert rule", path: () => "/alerting/rules/new", ready: anyHeading },
  { name: "alert rule", path: (_w, x) => `/alerting/rules/${x.ruleId}`, ready: anyHeading },
  {
    name: "contact points",
    path: () => "/alerting/contact-points",
    ready: async (page) => {
      await anyHeading(page);
      await expect(page.getByText(/Bereitschaft Lager/).first()).toBeVisible();
    },
  },
  {
    name: "notification policies",
    path: () => "/alerting/policies",
    ready: async (page) => {
      await anyHeading(page);
      await expect(page.getByRole("treeitem").first()).toBeVisible();
    },
  },
  {
    name: "new notification policy",
    path: (_w, x) => `/alerting/policies/new?parent=${x.rootPolicyId}`,
    ready: anyHeading,
  },
  {
    name: "notification policy",
    path: (_w, x) => `/alerting/policies/${x.policyId}`,
    ready: anyHeading,
  },
  {
    name: "silences",
    path: () => "/alerting/silences",
    ready: async (page) => {
      await anyHeading(page);
      await expect(page.getByText("Wartung am Lagerrechner").first()).toBeVisible();
    },
  },
  { name: "alert history", path: () => "/alerting/history", ready: anyHeading },
  {
    name: "new data source form",
    path: () => "/data-sources/new?kind=postgres",
    ready: async (page) => {
      await anyHeading(page);
      await expect(page.getByRole("textbox").nth(1)).toBeVisible();
    },
  },
  {
    name: "page not found",
    path: () => "/this-page-does-not-exist",
    ready: async (page, _world, language) => {
      await expect(
        page.getByRole("heading", { name: t("notFound.title", {}, language) }),
      ).toBeVisible();
    },
  },
];

const visitor = (name: string, path: string): SweepPage => ({
  name,
  path: () => path,
  signedOut: true,
  ready: async (page) => {
    await expect(page.locator("h1").first()).toBeVisible();
  },
});

/** The pages before the app: a link page without its token shows its "link not valid" state. */
const signedOut: SweepPage[] = [
  visitor("sign in", "/login"),
  visitor("local sign in", "/anmelden/lokal"),
  visitor("setup, already done", "/setup"),
  visitor("invitation link", "/invite"),
  visitor("password link", "/reset-password"),
  visitor("mail confirmation link", "/confirm-email"),
  visitor("help: getting started", "/help/getting-started"),
  visitor("help: installation", "/help/installation"),
];

export const SWEEP_PAGES: readonly SweepPage[] = [...main, ...sections, ...app, ...signedOut];

/**
 * Routes no page above reaches, each with its reason. Routes that only send people on to another
 * address need no entry.
 */
export const UNVISITED_ROUTES: Readonly<Record<string, string>> = {
  "/anmelden/sso-test":
    "the end of a test sign-in through an identity provider, which the e2e server has none of",
};
