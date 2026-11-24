import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryOutcome, QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { pickOption } from "../../test/select";

const LOKI_ID = "ds-loki";

/** Log lines as Loki's documents (docs/api/datasources.md, "Loki"), newest first. */
function lokiAnswer(to: number): QueryOutcome {
  const lines: [number, string, Record<string, string>][] = [
    [
      to - 60_000,
      "payment declined order=48213 psp=adyen",
      { app: "api", host: "web-3", level: "error" },
    ],
    [
      to - 120_000,
      "POST /api/checkout 200 customer=3921",
      { app: "api", host: "web-1", level: "info" },
    ],
    [
      to - 121_000,
      "POST /api/checkout 200 customer=3921",
      { app: "api", host: "web-1", level: "info" },
    ],
    [to - 180_000, 'level=warn msg="psp latency high"', { app: "api", host: "web-3" }],
  ];
  return {
    result: {
      shape: "documents",
      documents: {
        documents: lines.map(([ms, line, labels]) => ({
          time: { $type: "date", value: String(ms) },
          timestampNs: `${ms}000000`,
          line,
          labels,
        })),
        schema: [],
        notices: [],
      },
    },
  };
}

/** The count query's answer: the lines per minute and level over the hour. */
function countAnswer(to: number): QueryOutcome {
  return {
    result: {
      shape: "frame",
      frame: {
        fields: [
          { name: "time", type: "time", values: [to - 60_000, to] },
          { name: "error", type: "number", labels: { level: "error" }, values: [212, 3] },
          { name: "info", type: "number", labels: { level: "info" }, values: [14_000, 902] },
        ],
        meta: { rowsTruncated: false, notices: [] },
      },
    },
  };
}

function open() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  const created = Date.UTC(2026, 10, 20);
  server.areas.datasources.datasources.push({
    id: LOKI_ID,
    name: "Loki Produktion",
    kind: "loki",
    settings: { url: "http://loki.internal:3100" },
    secrets: {},
    createdAt: created,
    updatedAt: created,
  });
  server.areas.datasources.respond = (item, range) => {
    const logql = String((item.query as { logql?: string }).logql ?? "");
    return logql.startsWith("sum by") ? countAnswer(range.to) : lokiAnswer(range.to);
  };
  return { server, ...renderApp("/explore") };
}

const sent = (server: ReturnType<typeof open>["server"]) =>
  (server.areas.datasources.queries as unknown as QueryRequest[]).flatMap((r) => r.queries);

afterEach(() => {
  window.localStorage.clear();
});

describe("Explore: the logs view", () => {
  it("opens a Loki result on Logs with level words, the volume of the count query and the same documents", async () => {
    const { server, user } = open();
    await pickOption(user, await screen.findByRole("combobox", { name: "Data source" }), LOKI_ID);
    fireEvent.change(screen.getByRole("textbox", { name: "Query" }), {
      target: { value: '{app="api"}' },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));

    const list = await screen.findByRole("grid", { name: "Log lines" });
    expect(screen.getByRole("tab", { name: "Logs" }).getAttribute("aria-selected")).toBe("true");
    const rows = within(list).getAllByRole("row");
    expect(rows).toHaveLength(4);
    // Level as a word, the one without a label read from the text.
    expect(within(rows[0] as HTMLElement).getByText("Error")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Warning")).toBeTruthy();

    // The count query ran beside the lines, over the same selector, and is not the line query.
    await waitFor(() =>
      expect(sent(server).map((q) => (q.query as { logql: string }).logql)).toContain(
        'sum by (level, detected_level) (count_over_time({app="api"} [$__interval]))',
      ),
    );
    const volume = screen.getByRole("region", { name: "Volume by level" });
    expect(await within(volume).findByText(/whole range/)).toBeTruthy();
    expect(within(volume).getByRole("button", { name: /Info\s*14,902/ })).toBeTruthy();

    // Inspect lists the count query as a query of its own.
    await user.click(screen.getByRole("tab", { name: "Inspect" }));
    expect(screen.getByRole("region", { name: "Query volume" })).toBeTruthy();

    // Documents shows the same documents: nothing was converted.
    await user.click(screen.getByRole("tab", { name: "Documents" }));
    expect(screen.queryByRole("grid", { name: "Log lines" })).toBeNull();
    expect(screen.getAllByText(/4 documents/).length).toBeGreaterThan(0);
  });

  it("filters for a label visibly in the LogQL and merges duplicates in the view only", async () => {
    const { server, user } = open();
    await pickOption(user, await screen.findByRole("combobox", { name: "Data source" }), LOKI_ID);
    fireEvent.change(screen.getByRole("textbox", { name: "Query" }), {
      target: { value: '{app="api"}' },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    const list = await screen.findByRole("grid", { name: "Log lines" });

    // The bar changes the view only: no query runs for it.
    const runs = sent(server).length;
    await pickOption(user, screen.getByRole("combobox", { name: "Duplicates" }), "exact");
    expect(screen.getByText("4 lines, shown as 3")).toBeTruthy();
    expect(sent(server)).toHaveLength(runs);

    await user.click(within(list).getAllByRole("row")[0] as HTMLElement);
    const details = screen.getByRole("region", { name: "Details of the line" });
    expect(within(details).getByText("Source labels")).toBeTruthy();
    expect(within(details).getByText("Fields from the line")).toBeTruthy();
    await user.click(within(details).getByRole("button", { name: "Filter for host = web-3" }));

    await waitFor(() =>
      expect(
        sent(server).some(
          (q) => (q.query as { logql: string }).logql === '{app="api"} | host = "web-3"',
        ),
      ).toBe(true),
    );
    // The editor shows what the click wrote.
    expect((screen.getByRole("textbox", { name: "Query" }) as HTMLTextAreaElement).value).toBe(
      '{app="api"} | host = "web-3"',
    );
  });
});
