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

type Service = "KALZIT_E2E_MONGODB" | "KALZIT_E2E_OPENSEARCH";

/**
 * The address of a database server some specs read beside the fixture files: MongoDB
 * (`host:port`, seeded with e2e/fixtures/mongo-orders.js) and OpenSearch (a base URL). CI starts
 * both on Linux (.github/scripts/e2e-services.sh). Windows runners cannot run Linux containers,
 * so there the spec is skipped with this reason and the Windows checklist of the release covers
 * these sources by hand. On Linux in CI a missing service fails instead of passing silently.
 * Call it inside a test or a hook.
 */
export function serviceAddress(variable: Service): string {
  const value = process.env[variable] ?? "";
  const ci = process.env.CI !== undefined && process.env.CI !== "";
  if (value === "" && ci && process.platform === "linux") {
    throw new Error(`${variable} is not set; the e2e job in CI starts this service on Linux`);
  }
  test.skip(
    value === "",
    `${variable} is not set: the service runs in CI on Linux only (Windows runners have no Linux containers); the Windows checklist covers it`,
  );
  return value;
}
