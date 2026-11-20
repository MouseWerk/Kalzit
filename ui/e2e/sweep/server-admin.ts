import type { Page, Route } from "@playwright/test";
import type { Registration } from "../../src/auth/registrationApi";
import type { PluginDetail } from "../../src/features/plugins/api";
import type { AppInfo, AppSetting } from "../../src/features/plugins/apps/api";
import type { BackupRun, BackupsView } from "../../src/features/settings/backupsApi";
import type { MailView } from "../../src/features/settings/mailApi";
import { checkoutTrace, searchFrame, TRACE_ID } from "../../src/panels/trace/test/fixture";
import { type Language, t } from "../support/i18n";
import { expect } from "../support/test";
import type { SweepPage } from "./pages";

/**
 * The screens of 0.7.5 in the states the sweep looks at: traces in Explore and on a dashboard,
 * CORS with entries and a checked origin, self-registration (the settings, the requests above the
 * members, the visitor's pages), backups with a target and runs, and app plugins (an app's page,
 * the organization's apps, the plugin page of an app). A fresh server has no Tempo, no mail
 * server, no backup target and no installed app, so their answers are given here; the bodies
 * carry the UI's API types, so a change of shape fails the type check here too.
 */

const NOW = Date.UTC(2026, 10, 14, 9, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

async function answerGet<T>(page: Page, url: RegExp, json: T): Promise<void> {
  await page.route(url, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json }) : route.continue(),
  );
}

/** A Tempo source's answers: a search is a table of traces, a trace id the trace. */
async function tempoAnswers(page: Page): Promise<void> {
  const answer = (query: Record<string, unknown>) =>
    typeof query.traceId === "string"
      ? { shape: "trace", trace: checkoutTrace() }
      : { shape: "frame", frame: searchFrame() };
  // Explore asks freely; only the Tempo source is asked on these pages.
  await page.route(/\/api\/orgs\/[^/]+\/query$/, async (route) => {
    const body = route.request().postDataJSON() as {
      queries: { refId: string; query: Record<string, unknown> }[];
    };
    const item = body.queries[0];
    if (item === undefined || typeof item.query.sql === "string") {
      return route.continue();
    }
    return route.fulfill({ json: { results: { [item.refId]: { result: answer(item.query) } } } });
  });
  // A dashboard's panels run their stored query: the list panel searches, the other holds an id.
  await page.route(/\/api\/orgs\/[^/]+\/dashboards\/[^/]+\/panels\/([^/]+)\/query$/, (route) => {
    const panel = /\/panels\/([^/]+)\/query$/.exec(route.request().url())?.[1];
    const query = panel === "one" ? { traceId: TRACE_ID } : {};
    return route.fulfill({ json: { results: { A: { result: answer(query) } } } });
  });
  await page.route(/\/api\/orgs\/[^/]+\/datasources\/[^/]+\/schema$/, (route) =>
    route.fulfill({
      json: {
        kind: "labels",
        labels: ["resource.service.name", "name", "span.http.status_code"],
        values: { "resource.service.name": ["frontend", "checkout"], name: ["GET /checkout"] },
      },
    }),
  );
}

/** The trace dashboard of the sweep: the list of a search beside one trace as a waterfall. */
export function traceDashboard(title: string, datasourceId: string): Record<string, unknown> {
  const panel = (id: string, name: string, x: number, query: Record<string, unknown>) => ({
    id,
    type: "trace",
    title: name,
    grid: { x, y: 0, w: 12, h: 10 },
    targets: [{ refId: "A", datasourceId, query }],
  });
  return {
    schemaVersion: 1,
    title,
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [
      panel("list", "Langsame Anfragen im Checkout", 0, { service: "frontend" }),
      panel("one", "Bestellung A-2026-118204", 12, { traceId: TRACE_ID }),
    ],
  };
}

async function traceSearch(page: Page, language: Language): Promise<void> {
  await page
    .getByRole("combobox", { name: t("traces.query.service", {}, language) })
    .fill("frontend");
  await page.getByRole("button", { name: t("traces.error", {}, language), exact: true }).click();
  await page.getByRole("button", { name: t("explore.run", {}, language) }).click();
  await expect(
    page.getByRole("table", { name: t("explore.result", {}, language) }).getByRole("row"),
  ).toHaveCount(3);
}

async function traceWaterfall(page: Page, language: Language): Promise<void> {
  await traceSearch(page, language);
  await page
    .getByRole("table", { name: t("explore.result", {}, language) })
    .getByRole("button", { name: t("traces.open", { id: TRACE_ID.slice(0, 8) }, language) })
    .click();
  const grid = page.getByRole("treegrid", { name: t("explore.result", {}, language) });
  await expect(grid.getByRole("row")).toHaveCount(13);
  await grid.locator('[data-span="00f067aa0ba902b7"]').click();
  await expect(
    page
      .getByRole("complementary", { name: t("traces.span", {}, language) })
      .getByText("upstream timeout after 3 retries"),
  ).toBeVisible();
}

/** The server's settings as they are, with some values changed on the way to the page. */
async function settingsWith(page: Page, values: Record<string, unknown>): Promise<void> {
  await page.route(/\/api\/admin\/settings(\?|$)/, async (route: Route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }
    const answer = await route.fetch();
    const body = (await answer.json()) as { items: { key: string; value?: unknown }[] };
    for (const item of body.items) {
      if (item.key in values) {
        item.value = values[item.key];
      }
    }
    return route.fulfill({ response: answer, json: body });
  });
}

const CORS_ORIGINS = [
  "https://portal.kalzit.example",
  "https://*.intern.kalzit.example",
  "https://lagerverwaltung-und-versand.nord.kalzit.example:8443",
];

async function corsInUse(page: Page): Promise<void> {
  await settingsWith(page, {
    "cors.enabled": true,
    "cors.allowed_origins": CORS_ORIGINS,
    "cors.allowed_methods": ["GET", "POST", "PUT"],
    "cors.allowed_headers": ["Authorization", "Content-Type", "X-Request-Id"],
    "cors.allow_credentials": true,
    "cors.max_age_secs": 600,
  });
}

async function mailSetUp(page: Page): Promise<void> {
  await answerGet<MailView>(page, /\/api\/admin\/mail(\?|$)/, {
    settings: {
      host: "smtp.kalzit.example",
      port: 587,
      security: "starttls",
      username: "kalzit",
      fromName: "Kalzit",
      fromAddress: "kalzit@kalzit.example",
      replyTo: "",
    },
    hasPassword: true,
    source: "database",
    editable: true,
    version: 3,
    publicUrl: "https://kalzit.example",
  });
}

/** Self-registration switched on: domains, the organization of the session and approval. */
async function registrationOn(page: Page): Promise<void> {
  const me = (await (await page.request.get("/api/me")).json()) as { orgs: { id: string }[] };
  await settingsWith(page, {
    "registration.enabled": true,
    "registration.allowed_domains": ["kalzit.example", "nordlicht-logistik.example"],
    "registration.default_org": me.orgs[0]?.id ?? "",
    "registration.default_role": "viewer",
    "registration.require_approval": true,
  });
  await mailSetUp(page);
}

const REQUESTS: Registration[] = [
  ["Jonas Keller", "jonas.keller@kalzit.example", 2],
  [
    "Aleksandra Wojciechowska-Brandstetter",
    "aleksandra.wojciechowska@nordlicht-logistik.example",
    5,
  ],
  ["Mia Sommer", "mia.sommer@kalzit.example", 26],
].map(([name, email, hours], index) => ({
  id: `request-${index + 1}`,
  name: String(name),
  email: String(email),
  status: "pending",
  orgId: null,
  role: null,
  createdAt: NOW - Number(hours) * HOUR - 600_000,
  expiresAt: NOW + 7 * DAY,
  confirmedAt: NOW - Number(hours) * HOUR,
}));

async function pendingRequests(page: Page): Promise<void> {
  await answerGet(page, /\/api\/admin\/registrations(\?|$)/, { items: REQUESTS, nextCursor: null });
}

/** What a visitor is offered once registration is on. */
async function registrationOffered(page: Page): Promise<void> {
  await page.route(/\/api\/auth\/registration$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: {
            available: true,
            requiresApproval: true,
            allowedDomains: ["kalzit.example", "nordlicht-logistik.example"],
          },
        })
      : route.fulfill({ status: 202, json: { accepted: true } }),
  );
}

const run = (id: string, hoursAgo: number, fields: Partial<BackupRun> = {}): BackupRun => ({
  id,
  kind: "scheduled",
  targetKind: "s3",
  status: "succeeded",
  fileName: "kalzit-backup-20261114T023000.000Z.zip.enc",
  sizeBytes: 318_000_000,
  reason: null,
  detail: null,
  startedBy: null,
  startedAt: NOW - hoursAgo * HOUR,
  finishedAt: NOW - hoursAgo * HOUR + 41_000,
  ...fields,
});

const RUNS: BackupRun[] = [
  run("run-5", 0, { kind: "manual", status: "running", sizeBytes: null, finishedAt: null }),
  run("run-4", 6),
  run("run-3", 30, {
    status: "failed",
    sizeBytes: null,
    reason: "backup.bucket_not_found",
    detail: "NoSuchBucket: the bucket kalzit-backups does not exist in eu-central-1",
  }),
  run("run-2", 54, { kind: "manual", sizeBytes: 1_204_000_000 }),
  run("run-1", 78, { targetKind: "local", sizeBytes: 296_400_000 }),
];

/** Backups with an S3 target, the schedule on and runs of every kind. */
async function backupsInUse(page: Page): Promise<void> {
  await answerGet<BackupsView>(page, /\/api\/admin\/backups$/, {
    databaseIncluded: false,
    database: "postgres",
    target: {
      kind: "s3",
      endpoint: "https://s3.eu-central.nordlicht-logistik.example",
      region: "eu-central-1",
      bucket: "kalzit-backups-produktion-nord",
      prefix: "prod/",
      pathStyle: false,
      accessKeyId: "AKIAEXAMPLE7Q2M",
    },
    hasSecret: true,
    version: 4,
    schedule: {
      enabled: true,
      intervalHours: 24,
      keepCount: 14,
      encrypt: true,
      nextRunAt: NOW + 18 * HOUR,
    },
    lastRun: RUNS[1] ?? null,
  });
  await answerGet(page, /\/api\/admin\/backups\/runs(\?|$)/, { items: RUNS, nextCursor: null });
}

export const SWEEP_APP: AppInfo = {
  id: "dev.e2etest.capacity",
  name: "Kapazitätsplanung Lager",
  version: "1.2.0",
  description: "Auslastung der Lager und die Prognose für die nächsten Wochen.",
  publisher: "Basalt Labs",
  api: 1,
  capabilities: ["dashboards:read", "analyses:run", "storage"],
  pages: [
    { id: "overview", title: { en: "Overview", de: "Übersicht" } },
    { id: "forecast", title: { en: "Forecast", de: "Prognose" } },
    { id: "settings", title: { en: "Thresholds", de: "Schwellenwerte" } },
  ],
};

/** An installed app with three pages; its frame says it listens and shows a line. */
async function appInstalled(page: Page): Promise<void> {
  await answerGet(page, /\/api\/orgs\/[^/]+\/apps$/, { items: [SWEEP_APP] });
  await page.route(/\/api\/orgs\/[^/]+\/apps\/[^/]+\/pages\/[^/]+\/frame$/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<body style="font:14px system-ui;margin:16px"><p>Lager Nord: 71 %</p><script>
parent.postMessage({ kalzit: "app", api: 1, type: "ready" }, "*");
</script>`,
    }),
  );
}

async function orgApps(page: Page): Promise<void> {
  const setting = (id: string, name: string, fields: Partial<AppSetting>): AppSetting => ({
    id,
    name,
    blocked: false,
    minRole: "viewer",
    capabilities: ["dashboards:read", "storage"],
    usedBytes: 1_480_000,
    ...fields,
  });
  await answerGet(page, /\/api\/orgs\/[^/]+\/app-settings$/, {
    items: [
      setting(SWEEP_APP.id, SWEEP_APP.name, { minRole: "editor" }),
      setting("de.nordlicht.schichtplan", "Schichtplan", { blocked: true, usedBytes: 0 }),
    ],
  });
}

const APP_PLUGIN = { id: SWEEP_APP.id, name: SWEEP_APP.name } as const;

/** The plugin page of an installed, approved app. */
async function appPlugin(page: Page): Promise<void> {
  const base = `/api/admin/plugins/${APP_PLUGIN.id.replaceAll(".", "\\.")}`;
  await answerGet<PluginDetail>(page, new RegExp(`${base}(\\?|$)`), {
    id: APP_PLUGIN.id,
    name: APP_PLUGIN.name,
    version: SWEEP_APP.version,
    kind: "app",
    description: SWEEP_APP.description ?? "",
    publisher: "Basalt Labs",
    license: "Apache-2.0",
    shapes: [],
    capabilities: [],
    appCapabilities: SWEEP_APP.capabilities,
    appPages: SWEEP_APP.pages,
    platforms: [],
    signer: "publisher",
    keyId: "4be1c0ffee09fa21",
    trusted: true,
    approved: true,
    enabled: true,
    running: true,
    permissions: [],
    installedAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    manifest: `id = "${APP_PLUGIN.id}"\nname = "${APP_PLUGIN.name}"\nkind = "app"\n`,
    usedIn: [],
  });
}

async function sectionTitle(page: Page): Promise<void> {
  await expect(page.locator("#settings-section-title")).toBeVisible();
}

const visitorHeading = async (page: Page) => {
  await expect(page.locator("h1").first()).toBeVisible();
};

export const SERVER_ADMIN_PAGES: SweepPage[] = [
  {
    name: "trace search",
    path: (_w, x) => `/explore?source=${x.tempoSourceId}`,
    prepare: tempoAnswers,
    ready: (page, _world, language) => traceSearch(page, language),
  },
  {
    name: "trace waterfall",
    path: (_w, x) => `/explore?source=${x.tempoSourceId}`,
    prepare: tempoAnswers,
    ready: (page, _world, language) => traceWaterfall(page, language),
  },
  {
    name: "trace span events",
    path: (_w, x) => `/explore?source=${x.tempoSourceId}`,
    prepare: tempoAnswers,
    ready: async (page, _world, language) => {
      await traceWaterfall(page, language);
      const detail = page.getByRole("complementary", { name: t("traces.span", {}, language) });
      await detail
        .getByRole("tab", { name: new RegExp(t("traces.tab.events", {}, language)) })
        .click();
      await expect(detail.getByText("connect timeout")).toBeVisible();
    },
  },
  {
    name: "trace dashboard",
    path: (_w, x) => `/dashboards/${x.traceDashboardId}`,
    prepare: tempoAnswers,
    ready: async (page) => {
      await expect(
        page.getByRole("group", { name: "Langsame Anfragen im Checkout" }).getByRole("table"),
      ).toBeVisible();
      await expect(
        page.getByRole("group", { name: "Bestellung A-2026-118204" }).getByRole("treegrid"),
      ).toBeVisible();
    },
  },
  {
    // CORS on, with entries, an entry the page refuses and a checked origin (frames 1 and 2).
    name: "cors in use",
    path: () => "/settings/cors",
    prepare: corsInUse,
    ready: async (page, _world, language) => {
      await sectionTitle(page);
      const field = page.getByRole("textbox", {
        name: t("admin.settings.cors.allowed_origins.label", {}, language),
      });
      await field.fill("https://portal.kalzit.example/api");
      await field.press("Enter");
      await expect(page.getByRole("alert").first()).toBeVisible();
      const check = page.getByRole("form", { name: t("serverAdmin.cors.check", {}, language) });
      await check
        .getByRole("textbox", { name: t("serverAdmin.cors.origin", {}, language) })
        .fill("https://lager.intern.kalzit.example");
      await check
        .getByRole("button", { name: t("admin.updates.step.verify", {}, language) })
        .click();
      await expect(check.locator(".s75-code")).toBeVisible();
    },
  },
  {
    name: "registration in use",
    path: () => "/settings/registration",
    prepare: registrationOn,
    ready: async (page, _world, language) => {
      await sectionTitle(page);
      await expect(
        page.getByRole("switch", {
          name: t("admin.settings.registration.enabled.label", {}, language),
        }),
      ).toBeChecked();
    },
  },
  {
    // The requests from self-registration above the members (frame 5).
    name: "registration requests",
    path: () => "/admin/members",
    prepare: pendingRequests,
    ready: async (page, _world, language) => {
      await expect(
        page.getByRole("table", { name: t("serverAdmin.requests.title", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    name: "decline registration",
    path: () => "/admin/members",
    prepare: pendingRequests,
    ready: async (page, _world, language) => {
      await page
        .getByRole("table", { name: t("serverAdmin.requests.title", {}, language) })
        .getByRole("button", { name: t("sso.unmapped.refuse", {}, language) })
        .first()
        .click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "backup target form",
    path: () => "/settings/backups",
    ready: async (page, _world, language) => {
      await sectionTitle(page);
      await page.getByRole("button", { name: t("serverAdmin.backup.setUp", {}, language) }).click();
      const form = page.getByRole("form", { name: t("serverAdmin.backup.edit", {}, language) });
      await form.getByText(t("serverAdmin.backup.s3", {}, language), { exact: true }).click();
      await expect(
        form.getByRole("textbox", { name: t("serverAdmin.backup.bucket", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    name: "backups in use",
    path: () => "/settings/backups",
    prepare: backupsInUse,
    ready: async (page) => {
      await sectionTitle(page);
      await expect(page.locator(".s75-table tbody tr")).toHaveCount(RUNS.length);
    },
  },
  {
    name: "app page",
    path: () => `/apps/${SWEEP_APP.id}/overview`,
    prepare: appInstalled,
    ready: async (page, _world, language) => {
      await expect(page.locator("iframe.app-frame")).toHaveAttribute("aria-busy", "false");
      await page.getByRole("button", { name: t("apps.about", {}, language) }).click();
      await expect(page.getByText(t("apps.cap.dashboards", {}, language))).toBeVisible();
    },
  },
  {
    // An address of an app that is not installed, or blocked for the organization.
    name: "app unavailable",
    path: () => "/apps/dev.e2etest.gone/overview",
    ready: async (page, _world, language) => {
      await expect(
        page.getByRole("heading", { name: t("apps.unavailable", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    name: "organization apps",
    path: () => "/settings/org-apps",
    prepare: orgApps,
    ready: async (page) => {
      await sectionTitle(page);
      await expect(page.getByRole("region", { name: "Schichtplan" })).toBeVisible();
    },
  },
  {
    name: "app plugin page",
    path: () => `/settings/plugins/${APP_PLUGIN.id}`,
    prepare: appPlugin,
    ready: async (page) => {
      await expect(
        page.getByRole("heading", { level: 2, name: APP_PLUGIN.name, exact: true }),
      ).toBeVisible();
    },
  },
];

/** The visitor's side of self-registration (frame 4). */
export const SERVER_ADMIN_VISITOR_PAGES: SweepPage[] = [
  {
    name: "sign in with registration",
    path: () => "/login",
    signedOut: true,
    prepare: registrationOffered,
    ready: async (page, _world, language) => {
      await expect(
        page.getByRole("link", { name: t("access.signup.title", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    name: "register",
    path: () => "/register",
    signedOut: true,
    prepare: registrationOffered,
    ready: async (page, _world, language) => {
      await expect(
        page.getByRole("heading", { level: 1, name: t("access.signup.title", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    name: "register: inbox",
    path: () => "/register",
    signedOut: true,
    prepare: registrationOffered,
    ready: async (page, _world, language) => {
      await page
        .getByLabel(t("access.login.email", {}, language))
        .fill("aleksandra.wojciechowska@nordlicht-logistik.example");
      await page.getByRole("button", { name: t("access.signup.title", {}, language) }).click();
      await expect(
        page.getByRole("heading", { name: t("serverAdmin.visitor.sentTitle", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    // Behind the mailed link: name and password, with the rules of a new password.
    name: "register: name and password",
    path: () => "/register#token=sweep-registration-link",
    signedOut: true,
    prepare: registrationOffered,
    ready: async (page, _world, language) => {
      await expect(page.getByLabel(t("access.invite.name", {}, language))).toBeVisible();
    },
  },
  {
    name: "register: waiting for approval",
    path: () => "/register#token=sweep-registration-link",
    signedOut: true,
    prepare: async (page) => {
      await registrationOffered(page);
      await page.route(/\/api\/auth\/registration\/confirm$/, (route) =>
        route.fulfill({ json: { status: "pending" } }),
      );
    },
    ready: async (page, _world, language) => {
      await page.getByLabel(t("access.invite.name", {}, language)).fill("Aleksandra Wojciechowska");
      await page
        .getByLabel(t("access.invite.password", {}, language), { exact: true })
        .fill("Kalkspat-Doppelbrechung-2026");
      await page.getByRole("button", { name: t("access.signup.title", {}, language) }).click();
      await expect(
        page.getByRole("heading", { name: t("serverAdmin.visitor.waitTitle", {}, language) }),
      ).toBeVisible();
    },
  },
  {
    // Registration off, as on a fresh server.
    name: "register: closed",
    path: () => "/register",
    signedOut: true,
    ready: visitorHeading,
  },
];
