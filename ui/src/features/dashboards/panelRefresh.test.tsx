import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelPlugin } from "../../panels/types";
import type { PanelModel } from "./model";
import { PanelBody } from "./PanelCard";
import { firstLoad, PANEL_DATA_KEY, usePanelResults } from "./usePanelResults";

/** Counts how often a chart is built, as a uPlot instance is on mount. */
const built = vi.hoisted(() => ({ count: 0 }));

const chart: PanelPlugin<Record<string, never>> = {
  type: "chart",
  name: "dashboards.panels.table",
  shapes: ["frame"],
  options: () => ({}),
  Panel: ({ frames }) => {
    useEffect(() => {
      built.count += 1;
    }, []);
    const values = frames[0]?.fields[0]?.values ?? [];
    return <p data-testid="chart">{values.join(",")}</p>;
  },
  Editor: () => null,
};

vi.mock("../../panels/registry", async (actual) => {
  const registry = await actual<typeof import("../../panels/registry")>();
  return {
    ...registry,
    getPanel: (type: string) => (type === "chart" ? chart : registry.getPanel(type)),
  };
});

vi.mock("../datasources/useSourceKinds", () => ({ useSourceKinds: () => () => "postgres" }));

interface Pending {
  resolve: (value: number) => void;
  reject: (error: Error) => void;
}

/** Each answer resolves only when the test lets it, so the refetch can be watched in flight. */
const answers = vi.hoisted(() => ({ pending: [] as Pending[] }));

vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  runPanelQuery: () =>
    new Promise((resolve, reject) => {
      answers.pending.push({
        resolve: (value) =>
          resolve({
            results: {
              A: {
                result: {
                  shape: "frame",
                  frame: { fields: [{ name: "n", type: "number", values: [value] }] },
                },
              },
            },
          }),
        reject,
      });
    }),
}));

function makePanel(id: string, hidden = false): PanelModel {
  return {
    id,
    type: "chart",
    title: "Panel",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: "ds", query: { sql: "SELECT 1" }, hide: hidden }],
    transformations: [],
    options: {},
    fieldConfig: {},
  };
}

interface Shown {
  panel: PanelModel;
  dashboardId: string;
}

let refresh: () => void = () => undefined;
let show: (next: Shown) => void = () => undefined;

/** One panel as the dashboard draws it: its query, then its body. */
function Harness() {
  const [run, setRun] = useState(0);
  const [shown, setShown] = useState<Shown>({ panel: makePanel("p"), dashboardId: "d" });
  refresh = () => setRun((n) => n + 1);
  show = setShown;
  const results = usePanelResults({
    orgId: "o",
    dashboardId: shown.dashboardId,
    panel: shown.panel,
    range: { from: 0, to: 1 },
    variables: {},
    source: "stored",
    run,
  });
  return (
    <div aria-busy={results.isFetching} data-testid="card">
      <PanelBody
        panel={shown.panel}
        title="Panel"
        range={{ from: 0, to: 1 }}
        pending={firstLoad(results)}
        error={results.error}
        outcomes={results.data ?? []}
        revision={results.dataUpdatedAt}
      />
    </div>
  );
}

function next(): Pending {
  const pending = answers.pending.shift();
  if (pending === undefined) throw new Error("no query in flight");
  return pending;
}

function answer(value: number) {
  const pending = next();
  act(() => pending.resolve(value));
}

/** Renders the panel and lets its first answer (1) arrive; answers the query client. */
async function drawn(client = new QueryClient()) {
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Loading…")).toBeTruthy();
  await waitFor(() => expect(answers.pending).toHaveLength(1));
  answer(1);
  await waitFor(() => expect(screen.getByTestId("chart").textContent).toBe("1"));
  return client;
}

beforeEach(() => {
  built.count = 0;
  answers.pending = [];
});

describe("a panel that refreshes", () => {
  it("keeps its chart and data on screen while the new answer loads", async () => {
    await drawn();
    const first = screen.getByTestId("chart");
    expect(built.count).toBe(1);

    act(() => refresh());
    await waitFor(() => expect(answers.pending).toHaveLength(1));
    // In flight: the old answer stays drawn by the same chart, and the card is only busy.
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.getByTestId("chart")).toBe(first);
    expect(screen.getByTestId("card").getAttribute("aria-busy")).toBe("true");

    answer(2);
    await waitFor(() => expect(screen.getByTestId("chart").textContent).toBe("2"));
    expect(screen.getByTestId("chart")).toBe(first);
    expect(built.count).toBe(1);
    expect(screen.getByTestId("card").getAttribute("aria-busy")).toBe("false");
  });

  it("shows a failed refresh as the failure, not the old answer", async () => {
    await drawn();
    act(() => refresh());
    await waitFor(() => expect(answers.pending).toHaveLength(1));
    const pending = next();
    act(() => pending.reject(new Error("source down")));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Something went wrong/);
    expect(screen.queryByTestId("chart")).toBeNull();
  });

  it("never shows another panel's or another dashboard's answer", async () => {
    await drawn();
    act(() => show({ panel: makePanel("q"), dashboardId: "d" }));
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByTestId("chart")).toBeNull();
    await waitFor(() => expect(answers.pending).toHaveLength(1));
    answer(3);
    await waitFor(() => expect(screen.getByTestId("chart").textContent).toBe("3"));

    // The same panel id on another dashboard is another panel.
    act(() => show({ panel: makePanel("q"), dashboardId: "e" }));
    expect(await screen.findByText("Loading…")).toBeTruthy();
    expect(screen.queryByTestId("chart")).toBeNull();
  });

  it("drops the last answer once no query is left to run", async () => {
    await drawn();
    // The only query is hidden: nothing runs, so nothing of the old answer may stay.
    act(() => show({ panel: makePanel("p", true), dashboardId: "d" }));
    await waitFor(() => expect(screen.queryByText("1")).toBeNull());
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(answers.pending).toHaveLength(0);
  });

  it("keeps only its latest answer in the cache, briefly once unshown", async () => {
    const client = await drawn();
    for (const value of [2, 3, 4]) {
      act(() => refresh());
      await waitFor(() => expect(answers.pending).toHaveLength(1));
      answer(value);
      await waitFor(() => expect(screen.getByTestId("chart").textContent).toBe(String(value)));
    }
    const kept = client.getQueryCache().findAll({ queryKey: [PANEL_DATA_KEY] });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.state.data).toEqual([
      { refId: "A", result: expect.objectContaining({ shape: "frame" }) },
    ]);
    expect(kept[0]?.gcTime).toBeLessThanOrEqual(5_000);
  });
});
