import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { selectOption } from "./support/select";
import { expect, signInOwner, test } from "./support/test";
import { fillQuery } from "./support/ui";

// The logs view of Explore (board Logs.dc.html) against the real server, with a Loki source whose
// answers are given here: no Loki runs beside the tests. The page asks the server as always; only
// the query route's answer for this source is replaced.

const MINUTE = 60_000;

function lokiLines(to: number) {
  const rows: [number, string, Record<string, string>][] = [
    [
      to - 1 * MINUTE,
      "payment declined order=48213 psp=adyen",
      { app: "api", host: "web-3", level: "error" },
    ],
    [
      to - 2 * MINUTE,
      "POST /api/checkout 200 customer=3921",
      { app: "api", host: "web-1", level: "info" },
    ],
    [
      to - 2 * MINUTE - 500,
      "POST /api/checkout 200 customer=3921",
      { app: "api", host: "web-1", level: "info" },
    ],
    [
      to - 3 * MINUTE,
      '{"msg":"order created","order":48212}',
      { app: "api", host: "web-2", level: "info" },
    ],
    [to - 4 * MINUTE, 'level=warn msg="psp latency high"', { app: "api", host: "web-3" }],
  ];
  return {
    shape: "documents",
    documents: {
      documents: rows.map(([ms, line, labels]) => ({
        time: { $type: "date", value: String(ms) },
        timestampNs: `${ms}000000`,
        line,
        labels,
      })),
      schema: [],
      notices: [],
    },
  };
}

function lokiCount(to: number) {
  return {
    shape: "frame",
    frame: {
      fields: [
        { name: "time", type: "time", values: [to - 2 * MINUTE, to - MINUTE] },
        { name: "error", type: "number", labels: { level: "error" }, values: [12, 3] },
        { name: "warn", type: "number", labels: { level: "warn" }, values: [40, 7] },
        { name: "info", type: "number", labels: { level: "info" }, values: [900, 812] },
      ],
      meta: { rowsTruncated: false, notices: [] },
    },
  };
}

test.use({ viewport: { width: 1440, height: 900 } });

test("reads Loki lines in the logs view and filters for a label in the LogQL", async ({ page }) => {
  const owner = await Api.owner();
  const name = unique("Loki");
  const sourceId = await owner.createSource(name, "loki", { url: "http://127.0.0.1:3100" });
  await owner.dispose();
  const asked: string[] = [];
  await page.route(/\/api\/orgs\/[^/]+\/query$/, async (route) => {
    const body = route.request().postDataJSON() as {
      queries: { refId: string; datasourceId: string; query: { logql?: string } }[];
      timeRange: { to: number };
    };
    const item = body.queries[0];
    if (item === undefined || item.datasourceId !== sourceId) {
      return route.continue();
    }
    const logql = item.query.logql ?? "";
    asked.push(logql);
    const result = logql.startsWith("sum by")
      ? lokiCount(body.timeRange.to)
      : lokiLines(body.timeRange.to);
    return route.fulfill({ json: { results: { [item.refId]: { result } } } });
  });
  // The editor completes LogQL from the source's labels; without a Loki the server answers 502.
  await page.route(new RegExp(`/api/orgs/[^/]+/datasources/${sourceId}/schema$`), (route) =>
    route.fulfill({
      json: {
        kind: "labels",
        labels: ["app", "host", "level"],
        values: { app: ["api"], host: ["web-1", "web-2", "web-3"], level: ["error", "info"] },
      },
    }),
  );

  await signInOwner(page, "en");
  await page.goto("/explore");
  await selectOption(page.getByLabel(t("explore.datasource")), { label: name });
  await fillQuery(page, '{app="api"}');
  await page.getByRole("button", { name: t("explore.run") }).click();

  const result = page.getByRole("region", { name: t("explore.result") });
  const list = result.getByRole("grid", { name: t("logs.list") });
  await expect(list.getByRole("row")).toHaveCount(5);
  await expect(result.getByRole("tab", { name: t("explore.tab.logs") })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Levels are words; the line without a level label has it from its text.
  await expect(list.getByRole("row").nth(0)).toContainText(t("logs.level.error"));
  await expect(list.getByRole("row").nth(4)).toContainText(t("logs.level.warning"));

  // The volume counts the whole range with a count query of its own.
  const volume = result.getByRole("region", { name: t("logs.volume.title") });
  await expect(volume.getByRole("button", { name: /Info\s*1,712/ })).toBeVisible();
  expect(asked).toContain(
    'sum by (level, detected_level) (count_over_time({app="api"} [$__interval]))',
  );

  // Duplicates merge in the view; prettified JSON is indented.
  await selectOption(result.getByLabel(t("logs.dedup.label")), { value: "exact" });
  await expect(list.getByRole("row")).toHaveCount(4);
  await result.getByRole("button", { name: t("logs.prettify") }).click();
  await expect(list.getByText('"msg": "order created"')).toBeVisible();

  // A line opens in place; "Filter for" writes the filter into the LogQL and runs it.
  await list.getByRole("row").nth(0).click();
  const details = list.getByRole("region", { name: t("logs.details") });
  await expect(details.getByText(t("logs.labels"))).toBeVisible();
  await details
    .getByRole("button", { name: t("logs.filterFor", { key: "host", value: "web-3" }) })
    .click();
  await expect(page.locator(".cm-content").first()).toHaveText('{app="api"} | host = "web-3"');
  await expect.poll(() => asked).toContain('{app="api"} | host = "web-3"');

  // The documents behind the lines are the same; switching shows them unchanged.
  await result.getByRole("tab", { name: t("explore.tab.documents") }).click();
  await expect(result.getByRole("tree").first()).toBeVisible();
});
