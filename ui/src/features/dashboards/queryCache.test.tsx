import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PanelQueryRequest } from "../../api/generated/shapes";
import { type MessageKey, type MessageParams, translate } from "../../i18n/i18n";
import type { PanelModel } from "./model";
import { outcomesOf } from "./results";
import { cacheText, spanText } from "./ui/Inspect";
import { usePanelResults } from "./usePanelResults";

vi.mock("../datasources/useSourceKinds", () => ({ useSourceKinds: () => () => "postgres" }));

/** The bodies the panel route was sent, in order. */
const sentBodies = vi.hoisted(() => [] as PanelQueryRequest[]);

vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  runPanelQuery: (_org: string, _dashboard: string, _panel: string, body: PanelQueryRequest) => {
    sentBodies.push(body);
    return Promise.resolve({
      results: {
        A: {
          result: { shape: "frame", frame: { fields: [] } },
          cache: { status: "hit", ageMs: 1000, ttlMs: 60000 },
        },
      },
    });
  },
}));

const en = (key: MessageKey, params?: MessageParams) => translate("en", key, params);
const de = (key: MessageKey, params?: MessageParams) => translate("de", key, params);

describe("query cache in the inspector", () => {
  it("says where an answer came from and for how long it is kept", () => {
    expect(cacheText(en, "en", { status: "hit", ageMs: 42_000, ttlMs: 60_000 })).toBe(
      "From the server cache, 42 seconds old (kept for 60 seconds).",
    );
    expect(cacheText(en, "en", { status: "miss", ageMs: 0, ttlMs: 300_000 })).toBe(
      "Ran in the data source; kept in the server cache for 5 minutes.",
    );
    expect(cacheText(en, "en", { status: "refresh", ageMs: 0, ttlMs: 60_000 })).toBe(
      "Refreshed in the data source; kept in the server cache for 60 seconds.",
    );
    expect(cacheText(en, "en", { status: "miss", ageMs: 0, ttlMs: 0 })).toBe(
      "Ran in the data source; not kept in the server cache.",
    );
    expect(cacheText(de, "de", { status: "hit", ageMs: 3_600_000, ttlMs: 86_400_000 })).toBe(
      "Aus dem Server-Cache, 60 Minuten alt (behalten für 24 Stunden).",
    );
  });

  it("writes spans in their largest whole unit", () => {
    expect(spanText(0, "en")).toBe("0 seconds");
    expect(spanText(119_000, "en")).toBe("119 seconds");
    expect(spanText(7_200_000, "en")).toBe("2 hours");
    expect(spanText(3 * 86_400_000, "en")).toBe("3 days");
  });

  it("keeps the cache state of each outcome", () => {
    const outcomes = outcomesOf(
      {
        results: {
          A: {
            result: { shape: "frame", frame: { fields: [] } },
            cache: { status: "hit", ageMs: 5, ttlMs: 60_000 },
          },
          B: { result: { shape: "frame", frame: { fields: [] } } },
        },
      },
      ["A", "B"],
    );
    expect(outcomes[0]).toMatchObject({ refId: "A", cache: { status: "hit", ageMs: 5 } });
    expect(outcomes[1]).not.toHaveProperty("cache");
  });
});

describe("Refresh passes the server's query cache by", () => {
  const panel: PanelModel = {
    id: "p1",
    type: "table",
    title: "Orders",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: "pg", query: { sql: "SELECT 1" } }],
    transformations: [],
    options: {},
    fieldConfig: {},
  };

  it("sends refresh only for the run after the Refresh button", async () => {
    sentBodies.length = 0;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const input = (run: number, manual: number) => ({
      orgId: "o1",
      dashboardId: "d1",
      panel,
      range: { from: 0, to: 60_000 },
      variables: {},
      source: "stored" as const,
      run,
      manual,
    });
    const { rerender, result } = renderHook((props) => usePanelResults(props), {
      wrapper,
      initialProps: input(0, 0),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    // An auto refresh: a new run, the same manual count.
    rerender(input(1, 0));
    await waitFor(() => expect(sentBodies).toHaveLength(2));
    // The Refresh button: both counts move.
    rerender(input(2, 1));
    await waitFor(() => expect(sentBodies).toHaveLength(3));
    expect(sentBodies.map((body) => body.refresh === true)).toEqual([false, false, true]);
    expect(result.current.data?.[0]).toMatchObject({ cache: { status: "hit" } });
  });
});
