import { test } from "@playwright/test";

/**
 * The fixture of e2e/fixtures/mongo-orders.js: a database with one collection of orders and a
 * login that may only read it, as Kalzit requires.
 */
export const MONGO_FIXTURE = {
  database: "kalzit_e2e",
  collection: "orders",
  user: "kalzit_reader",
  password: "kalzit-e2e-reader",
  /** Documents in the collection, and of them those with the status "paid". */
  documents: 48,
  paid: 24,
} as const;

/**
 * The fixture of e2e/fixtures/graph-shop.cypher, in Neo4j and in Memgraph: customers, their
 * orders, the products in them and a tree of categories. The Neo4j login is the container's
 * admin (Neo4j Community has no read-only users; Neo4j itself enforces Kalzit's read
 * transaction); Memgraph runs without users, so its source accepts a user who may write.
 */
export const GRAPH_FIXTURE = {
  neo4jUser: "neo4j",
  neo4jPassword: "kalzit-e2e-neo4j",
  /** Customers, orders and products along PLACED and CONTAINS: 5 + 8 + 4 nodes, 16 edges. */
  shop: { nodes: 17, edges: 16 },
  /** The category tree: 5 categories, 4 SUBCATEGORY edges. */
  categories: { nodes: 5, edges: 4 },
} as const;

type Service =
  | "KALZIT_E2E_MONGODB"
  | "KALZIT_E2E_OPENSEARCH"
  | "KALZIT_E2E_NEO4J"
  | "KALZIT_E2E_MEMGRAPH";

/**
 * The address of a database server some specs read beside the fixture files: MongoDB
 * (`host:port`, seeded with e2e/fixtures/mongo-orders.js), OpenSearch (a base URL), Neo4j and
 * Memgraph (`host:port`, seeded with e2e/fixtures/graph-shop.cypher). CI starts them: on Linux as
 * containers (.github/scripts/e2e-services.sh), on Windows, which has no Linux containers, as
 * their native builds (.github/scripts/e2e-services.ps1). Memgraph has no Windows build, so its
 * spec skips on Windows with that reason. In CI a missing service fails instead of passing
 * silently; on a developer's machine without it the spec skips. Call it inside a test or a hook.
 */
export function serviceAddress(variable: Service): string {
  const value = process.env[variable] ?? "";
  const ci = process.env.CI !== undefined && process.env.CI !== "";
  const native = !(variable === "KALZIT_E2E_MEMGRAPH" && process.platform === "win32");
  if (value === "" && ci && native) {
    throw new Error(`${variable} is not set; the e2e job in CI starts this service`);
  }
  test.skip(
    value === "",
    native
      ? `${variable} is not set: start the service (.github/scripts/e2e-services.sh on Linux, e2e-services.ps1 on Windows)`
      : `${variable} is not set: Memgraph has no Windows build; the Linux e2e job runs this spec against it`,
  );
  return value;
}

/** A `host:port` address as the settings of a Bolt source (Neo4j, Memgraph). */
export function boltTarget(address: string): { host: string; port: number } {
  const colon = address.lastIndexOf(":");
  return { host: address.slice(0, colon), port: Number(address.slice(colon + 1)) };
}
