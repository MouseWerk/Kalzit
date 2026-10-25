import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PanelPlugin } from "../../panels/types";
import type { PanelModel } from "./model";
import { PanelBody } from "./PanelCard";
import { firstLoad, usePanelResults } from "./usePanelResults";

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

/** Each answer resolves only when the test lets it, so the refetch can be watched in flight. */
const answers = vi.hoisted(() => ({ pending: [] as ((value: number) => void)[] }));

vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  runPanelQuery: () =>
    new Promise((resolve) => {
      answers.pending.push((value) =>
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
      );
    }),
}));

const panel: PanelModel = {
  id: "p",
  type: "chart",
  title: "Panel",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: "ds", query: { sql: "SELECT 1" } }],
  transformations: [],
  options: {},
  fieldConfig: {},
};

let refresh: () => void = () => undefined;

/** One panel as the dashboard draws it: its query, then its body. */
function Harness() {
  const [run, setRun] = useState(0);
  refresh = () => setRun((n) => n + 1);
  const results = usePanelResults({
    orgId: "o",
    dashboardId: "d",
    panel,
    range: { from: 0, to: 1 },
    variables: {},
    source: "stored",
    run,
  });
  return (
    <div aria-busy={results.isFetching} data-testid="card">
      <PanelBody
        panel={panel}
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

function answer(value: number) {
  const next = answers.pending.shift();
  if (next === undefined) throw new Error("no query in flight");
  act(() => next(value));
}

describe("a panel that refreshes", () => {
  it("keeps its chart and data on screen while the new answer loads", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
    // The first load shows "Loading", as there is nothing to draw yet.
    expect(screen.getByText("Loading…")).toBeTruthy();
    await waitFor(() => expect(answers.pending).toHaveLength(1));
    answer(1);
    await waitFor(() => expect(screen.getByTestId("chart").textContent).toBe("1"));
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
});
