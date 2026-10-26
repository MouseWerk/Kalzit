import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { serviceAddress } from "./support/services";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

/** Sales as a shop logs them; recent, so Explore's default range (the last hour) finds them. */
function salesDocuments(now: number): Record<string, unknown>[] {
  const rows: [string, number][] = [
    ["Nord", 120.5],
    ["Süd", 80],
    ["Nord", 99.5],
    ["West", 42],
    ["Süd", 18],
    ["Nord", 30],
  ];
  return rows.map(([region, amount], index) => ({
    "@timestamp": now - (index + 1) * 60_000,
    region,
    amount,
  }));
}

async function cluster(base: string, method: string, path: string, body?: string, type?: string) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": type ?? "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

test("OpenSearch in Explore: a search answers hits as documents, an aggregation a table", async ({
  page,
}) => {
  const base = serviceAddress("KALZIT_E2E_OPENSEARCH").replace(/\/$/, "");
  const index = `kalzit-e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await cluster(
    base,
    "PUT",
    `/${index}`,
    JSON.stringify({
      mappings: {
        properties: {
          "@timestamp": { type: "date" },
          region: { type: "keyword" },
          amount: { type: "double" },
        },
      },
    }),
  );
  const bulk = salesDocuments(Date.now())
    .map((doc) => `{"index":{}}\n${JSON.stringify(doc)}\n`)
    .join("");
  const indexed = await cluster(
    base,
    "POST",
    `/${index}/_bulk?refresh=true`,
    bulk,
    "application/x-ndjson",
  );
  expect(indexed.errors).toBe(false);

  const name = unique("Verkaufslog");
  const owner = await Api.owner();
  try {
    await owner.createSource(name, "elasticsearch", { url: base, index });
  } finally {
    await owner.dispose();
  }
  const result = page.getByRole("region", { name: t("explore.result") });
  const run = page.getByRole("button", { name: t("explore.run") });

  try {
    await test.step("a Lucene search answers its hits as documents", async () => {
      await signInOwner(page);
      await page.goto("/explore", { timeout: STEP_MS });
      await page
        .getByLabel(t("explore.datasource"))
        .selectOption({ label: name }, { timeout: STEP_MS });
      await fillQuery(page, "region:Nord");
      await run.click({ timeout: STEP_MS });
      await expect(result).toContainText(t("documents.summary.countMany", { count: 3 }), {
        timeout: STEP_MS,
      });
      await expect(page.getByLabel(t("explore.visualization"), { exact: true })).toHaveValue(
        "documents",
      );
      await expect(result.getByRole("tree").first()).toBeVisible({ timeout: STEP_MS });
    });

    await test.step("an aggregation in the Query DSL answers a table, one row per bucket", async () => {
      await page
        .getByRole("radio", { name: t("datasources.editor.search.mode.dsl"), exact: true })
        .check({ timeout: STEP_MS });
      await fillQuery(
        page,
        JSON.stringify({
          aggs: {
            region: {
              terms: { field: "region", order: { _key: "asc" } },
              aggs: { total: { sum: { field: "amount" } } },
            },
          },
        }),
      );
      await run.click({ timeout: STEP_MS });
      // The answer is a frame now: shown as a table, one row per bucket.
      await page
        .getByLabel(t("explore.visualization"), { exact: true })
        .selectOption("table", { timeout: STEP_MS });
      await expect(result.getByText("Süd", { exact: true }).first()).toBeVisible({
        timeout: STEP_MS,
      });
      await expect(result.getByText("250", { exact: true }).first()).toBeVisible({
        timeout: STEP_MS,
      });
      await result.getByRole("tab", { name: t("explore.tab.inspect") }).click({ timeout: STEP_MS });
      await expect(result).toContainText(/3 rows, \d+ fields/, { timeout: STEP_MS });
    });
  } finally {
    await cluster(base, "DELETE", `/${index}`);
  }
});
