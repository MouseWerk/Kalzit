import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";
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
  frozen: Frozen;
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

/**
 * Seeds the server once after setup: the page checks' world and the sweep's extras (both with
 * fixed names), a documents source, a graph source and a recently viewed dashboard. `request`
 * carries the owner's session.
 */
export async function seedVisual(request: APIRequestContext): Promise<Seed> {
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
  await ruleEvaluated(request, orgId, extras.ruleId);
  // Explore keeps what was run; the pages that run queries would add to it in any order.
  const history = await ok<unknown>(
    await request.get(`/api/orgs/${orgId}/explore/history`),
    "read the Explore history",
  );
  const seed: Seed = {
    orgId,
    world,
    extras,
    documentsSourceId,
    graphSourceId,
    frozen: { "/explore/history$": history },
  };
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));
  return seed;
}

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as Seed;
}
