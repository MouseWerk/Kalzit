import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page, Response } from "@playwright/test";
import { Api } from "../support/api";
import { createWorld, type World } from "../support/test";
import { type Extras, seedExtras } from "../sweep/pages";
import { type Frozen, SEED_FILE } from "./stage";

/** What the setup seeded once for every screen, with fixed names (KALZIT_E2E_STABLE_NAMES). */
export interface Seed {
  orgId: string;
  world: World;
  extras: Extras;
  /** A file source on a JSON file of orders: Explore shows its documents. */
  documentsSourceId: string;
  /** A Neo4j source; its answers come from the pages (no Neo4j runs beside the visual run). */
  graphSourceId: string;
  /**
   * A public link whose window reaches back to the fixed moment the pages show: the server checks
   * a visitor's time range against its own clock, which is the real one.
   */
  publicToken: string;
  frozen: Frozen;
  /** Text the server makes up anew in every run (the instance id), masked in the pictures. */
  dynamic: string[];
}

export const DOCUMENTS_SOURCE = "Bestellungen (JSON)";
export const GRAPH_SOURCE = "Shop-Graph";

const REGIONS = ["Nord", "Ost", "Süd", "West"] as const;
const STATUS = ["offen", "bezahlt", "versendet", "bezahlt"] as const;
const PRODUCTS = [
  ["Schreibtischlampe", 39.9],
  ["Monitorarm", 89],
  ["Bürostuhl", 249],
  ["Kabelkanal", 12.5],
] as const;

/** Twelve orders with a nested customer and a list of items, the same in every run. */
function orders(): unknown[] {
  return Array.from({ length: 12 }, (_, index) => {
    const product = PRODUCTS[index % PRODUCTS.length] ?? PRODUCTS[0];
    const quantity = (index % 3) + 1;
    return {
      orderId: `A-2025-${String(1040 + index)}`,
      status: STATUS[index % STATUS.length],
      customer: {
        name: ["Ana Berg", "Ben Kraus", "Clara Wendt", "David Ohm"][index % 4],
        region: REGIONS[index % REGIONS.length],
      },
      items: [{ product: product[0], quantity, price: product[1] }],
      total: Math.round(quantity * product[1] * 100) / 100,
    };
  });
}

async function ok<T>(answer: Awaited<ReturnType<APIRequestContext["get"]>>, what: string) {
  if (!answer.ok()) {
    throw new Error(`${what}: HTTP ${answer.status()} ${await answer.text()}`);
  }
  return (await answer.json()) as T;
}

/**
 * Waits until the alert rule was evaluated once, so its state does not change between the
 * pictures of one run.
 */
async function ruleEvaluated(request: APIRequestContext, orgId: string, ruleId: string) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const rule = await ok<{ lastEvaluatedAt?: number | null; rule?: { lastEvaluatedAt?: number } }>(
      await request.get(`/api/orgs/${orgId}/alerting/rules/${ruleId}`),
      "read the alert rule",
    );
    if ((rule.lastEvaluatedAt ?? rule.rule?.lastEvaluatedAt ?? null) !== null) {
      return;
    }
    await new Promise((done) => setTimeout(done, 1000));
  }
  throw new Error("the alert rule was not evaluated within 5 minutes");
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest window the server allows (`sharing.max_expiry_days` at its maximum). */
const LONGEST_DAYS = 3650;

/**
 * A public link to the dashboard whose window covers the fixed moment: the server checks the
 * visitor's range against the real time, and the pages show a moment more than a year back. The
 * longest window the server allows reaches ten years back, so this holds until mid-2035. The
 * setting is raised only for the link's creation and reset to its default right after (the link
 * keeps its window), so Verwaltung > Teilen shows the default as on any server.
 */
async function longWindowLink(
  request: APIRequestContext,
  orgId: string,
  dashboardId: string,
): Promise<string> {
  const settings = await ok<{ items: { key: string; version: number }[] }>(
    await request.get("/api/admin/settings"),
    "read the settings",
  );
  const version = settings.items.find((item) => item.key === "sharing.max_expiry_days")?.version;
  const raised = await ok<{ version: number }>(
    await request.patch("/api/admin/settings/sharing.max_expiry_days", {
      data: { value: LONGEST_DAYS, version: version ?? 0 },
    }),
    "allow the longest window",
  );
  const link = await ok<{ token: string }>(
    await request.post(`/api/orgs/${orgId}/dashboards/${dashboardId}/public-links`, {
      data: {
        maxWindowMs: LONGEST_DAYS * DAY_MS,
        timeRange: { from: "now-6h", to: "now" },
        variables: { region: "Nord" },
      },
    }),
    "create the public link",
  );
  await ok(
    await request.post("/api/admin/settings/batch", {
      data: {
        changes: [{ key: "sharing.max_expiry_days", version: raised.version, reset: true }],
      },
    }),
    "reset the longest window",
  );
  return link.token;
}

/**
 * Opens a page and keeps the JSON answers of the requests `pattern` matches, keyed by their exact
 * address (a regular expression source), for the screens to get the same answers later.
 */
async function recordAnswers(page: Page, path: string, pattern: RegExp): Promise<Frozen> {
  const answers: Frozen = {};
  const pending: Promise<void>[] = [];
  const listener = (response: Response) => {
    const url = new URL(response.url());
    const address = `${url.pathname}${url.search}`;
    if (response.request().method() === "GET" && pattern.test(address) && response.ok()) {
      pending.push(
        response.json().then((body: unknown) => {
          answers[`^${address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`] = body;
        }),
      );
    }
  };
  page.on("response", listener);
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await Promise.all(pending);
  page.off("response", listener);
  if (Object.keys(answers).length === 0) {
    throw new Error(`${path} asked nothing that matches ${pattern}`);
  }
  return answers;
}

/**
 * Seeds the server once after setup: the page checks' world and the sweep's extras (both with
 * fixed names), a documents source, a graph source and a recently viewed dashboard. `page`
 * carries the owner's session.
 */
export async function seedVisual(page: Page): Promise<Seed> {
  const request = page.request;
  const world = await createWorld();
  const extras = await seedExtras(world);
  const owner = await Api.owner();
  let documentsSourceId: string;
  let graphSourceId: string;
  try {
    const files = process.env.KALZIT_E2E_FILES ?? "";
    const path = join(files, "bestellungen.json");
    writeFileSync(path, `${JSON.stringify(orders(), null, 2)}\n`, "utf8");
    documentsSourceId = await owner.createFileSource(DOCUMENTS_SOURCE, path);
    graphSourceId = await owner.createSource(
      GRAPH_SOURCE,
      "neo4j",
      { host: "127.0.0.1", port: 9, user: "neo4j" },
      { password: "visual-run" },
    );
  } finally {
    await owner.dispose();
  }
  const orgId = owner.orgId;
  // The dashboard was opened once: Start lists it under the recent ones.
  const viewed = await request.post(`/api/orgs/${orgId}/dashboards/${world.dashboardId}/views`);
  if (viewed.status() !== 204) {
    throw new Error(`record a view: HTTP ${viewed.status()}`);
  }
  const publicToken = await longWindowLink(request, orgId, world.dashboardId);
  const cluster = await ok<{ instances: { id: string; host: string }[] }>(
    await request.get("/api/admin/instances"),
    "read the instances",
  );
  // The build: its commit and date change with every build, not with the screens.
  const about = await ok<{ commit?: string; buildDate?: string }>(
    await request.get("/api/about"),
    "read the build",
  );
  const dynamic = cluster.instances
    .flatMap((one) => [one.id, one.id.slice(0, 8), one.host])
    .concat(about.commit ?? "", about.buildDate ?? "")
    .filter((text) => text.length >= 3 && text !== "unknown");
  // How many answers the query cache keeps and how often it was hit grows with the run.
  const cache = await ok<unknown>(await request.get("/api/admin/query-cache"), "read the cache");
  await ruleEvaluated(request, orgId, extras.ruleId);
  // Explore keeps what was run; the pages that run queries would add to it in any order.
  const history = await ok<unknown>(
    await request.get(`/api/orgs/${orgId}/explore/history`),
    "read the Explore history",
  );
  // The usage counts grow with every dashboard and query the run opens: the page shows them as
  // they are now, before any screen was taken.
  const usage = await recordAnswers(page, "/admin/usage", /\/usage(\/unused)?\?/);
  const seed: Seed = {
    orgId,
    world,
    extras,
    documentsSourceId,
    graphSourceId,
    publicToken,
    frozen: {
      "/explore/history(\\?|$)": history,
      "^/api/admin/query-cache$": cache,
      ...usage,
    },
    dynamic,
  };
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  return seed;
}

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as Seed;
}
