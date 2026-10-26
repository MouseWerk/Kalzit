import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/** Each step gets its own limit, so a failure names the step instead of the test's timeout. */
const STEP_MS = 15_000;

const ORDERS = [
  { number: "A-1041", status: "paid", customer: { city: "Hamburg" }, total: 92.3 },
  { number: "A-1042", status: "shipped", customer: { city: "München" }, total: 249 },
  { number: "A-1043", status: "paid", customer: { city: "Köln" }, total: 128.9 },
] as const;

/**
 * A small JSON API of its own, on a free port of the loopback address (never a fixed one): the
 * orders below `data.items`, filtered by `?status=`, as many shop APIs answer. It records the
 * requests, so the test sees what Kalzit asked.
 */
async function startApi(requests: string[]): Promise<{ server: Server; base: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.method !== "GET" || url.pathname !== "/api/orders") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    const status = url.searchParams.get("status");
    const items = ORDERS.filter((order) => status === null || order.status === status);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: { items }, page: 1 }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}/api/` };
}

test("an HTTP JSON source answers the API's documents in Explore, with a parameter", async ({
  page,
}) => {
  const requests: string[] = [];
  const { server, base } = await startApi(requests);
  try {
    const name = unique("Shop-API");
    const owner = await Api.owner();
    try {
      await owner.createSource(name, "http_json", { url: base, documentsPath: "data.items" });
    } finally {
      await owner.dispose();
    }
    const result = page.getByRole("region", { name: t("explore.result") });

    await test.step("the path answers every order as a document", async () => {
      await signInOwner(page);
      await page.goto("/explore", { timeout: STEP_MS });
      await page
        .getByLabel(t("explore.datasource"))
        .selectOption({ label: name }, { timeout: STEP_MS });
      await page
        .getByLabel(t("datasources.editor.http.path"), { exact: true })
        .fill("orders", { timeout: STEP_MS });
      await page.getByRole("button", { name: t("explore.run") }).click({ timeout: STEP_MS });
      await expect(result).toContainText(t("documents.summary.countMany", { count: 3 }), {
        timeout: STEP_MS,
      });
      await expect(result.getByRole("tree").first()).toBeVisible({ timeout: STEP_MS });
      expect(requests).toContain("GET /api/orders");
    });

    await test.step("a parameter goes into the request's query string", async () => {
      await page
        .getByRole("button", { name: t("datasources.editor.http.addParam") })
        .click({ timeout: STEP_MS });
      await page
        .getByLabel(t("datasources.editor.http.paramName", { n: 1 }), { exact: true })
        .fill("status", { timeout: STEP_MS });
      await page
        .getByLabel(t("datasources.editor.http.paramValue", { n: 1 }), { exact: true })
        .fill("paid", { timeout: STEP_MS });
      await page.getByRole("button", { name: t("explore.run") }).click({ timeout: STEP_MS });
      await expect(result).toContainText(t("documents.summary.countMany", { count: 2 }), {
        timeout: STEP_MS,
      });
      expect(requests).toContain("GET /api/orders?status=paid");
    });

    await test.step("the schema shows the nested fields of the answer", async () => {
      await page
        .getByLabel(t("explore.visualization"), { exact: true })
        .selectOption("schema", { timeout: STEP_MS });
      await expect(result.getByText("customer.city", { exact: true }).first()).toBeVisible({
        timeout: STEP_MS,
      });
    });
  } finally {
    // Kalzit keeps its connections open for reuse; close them, or close would wait for them.
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
