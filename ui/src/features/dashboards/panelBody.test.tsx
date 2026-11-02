import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PanelPlugin } from "../../panels/types";
import { expectConsoleOutput } from "../../test/console";
import type { PanelModel } from "./model";
import { PanelBody } from "./PanelCard";
import type { TargetOutcome } from "./results";

/** A panel that fails to draw while its options say so, as a renderer that cannot start does. */
const failing: PanelPlugin<{ fail: boolean }> = {
  type: "failing",
  name: "dashboards.panels.table",
  shapes: ["frame"],
  options: (stored) => ({ fail: (stored as { fail?: boolean } | null)?.fail === true }),
  Panel: ({ options }) => {
    if (options.fail) throw new Error("renderer could not start");
    return <p>drawn</p>;
  },
  Editor: () => null,
};

vi.mock("../../panels/registry", async (actual) => {
  const registry = await actual<typeof import("../../panels/registry")>();
  return {
    ...registry,
    getPanel: (type: string) => (type === "failing" ? failing : registry.getPanel(type)),
  };
});

const outcomes: TargetOutcome[] = [
  {
    refId: "A",
    result: { shape: "frame", frame: { fields: [{ name: "n", type: "number", values: [1] }] } },
  },
];

function panel(type: string, options: unknown): PanelModel {
  return {
    id: "p",
    type,
    title: "Panel",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: "ds", query: { sql: "SELECT 1" } }],
    transformations: [],
    options,
    fieldConfig: {},
  };
}

function body(model: PanelModel) {
  return (
    <PanelBody
      panel={model}
      title="Panel"
      range={{ from: 0, to: 1 }}
      pending={false}
      error={null}
      outcomes={outcomes}
    />
  );
}

describe("a panel body whose panel fails while drawing", () => {
  it("keeps the failure in the panel and draws again when the options or the type change", () => {
    expectConsoleOutput(/renderer could not start/);
    const view = render(
      <div>
        <p>beside</p>
        {body(panel("failing", { fail: true }))}
      </div>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/This panel could not be drawn/);
    expect(screen.getByText("beside")).toBeTruthy();

    // The editor changes an option, with the same data: drawing is tried again.
    view.rerender(
      <div>
        <p>beside</p>
        {body(panel("failing", { fail: false }))}
      </div>,
    );
    expect(screen.getByText("drawn")).toBeTruthy();

    // Failing again, then another panel type with the same data.
    view.rerender(<div>{body(panel("failing", { fail: true }))}</div>);
    expect(screen.queryByText("drawn")).toBeNull();
    view.rerender(<div>{body(panel("table", {}))}</div>);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("table")).toBeTruthy();
  });
});

describe("a panel body while loading or after a data source error", () => {
  it("shows a skeleton, not a spinner or text, while the first answer is on its way", () => {
    render(
      <PanelBody
        panel={panel("table", {})}
        title="Panel"
        range={{ from: 0, to: 1 }}
        pending
        error={null}
        outcomes={[]}
      />,
    );
    const skeleton = screen.getByText("Loading…").parentElement as HTMLElement;
    expect(skeleton.textContent).toBe("Loading…");
    expect(skeleton.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    // No live region per panel: a dashboard of loading panels would announce each one.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers Retry beside a failed request and beside a query's error", () => {
    const onRetry = vi.fn();
    const view = render(
      <PanelBody
        panel={panel("table", {})}
        title="Panel"
        range={{ from: 0, to: 1 }}
        pending={false}
        error={new Error("connection refused")}
        outcomes={[]}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    view.rerender(
      <PanelBody
        panel={panel("table", {})}
        title="Panel"
        range={{ from: 0, to: 1 }}
        pending={false}
        error={null}
        outcomes={[{ refId: "A", error: { code: "datasource", message: "timed out" } }]}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("alert").querySelector("li")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(2);

    // While the queries run again, Retry waits.
    view.rerender(
      <PanelBody
        panel={panel("table", {})}
        title="Panel"
        range={{ from: 0, to: 1 }}
        pending={false}
        error={null}
        outcomes={[{ refId: "A", error: { code: "datasource", message: "timed out" } }]}
        onRetry={onRetry}
        fetching
      />,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", true);
  });
});

describe("a state timeline over several queries", () => {
  const status = (refId: string, values: string[]): TargetOutcome => ({
    refId,
    result: {
      shape: "frame",
      frame: {
        fields: [
          { name: "time", type: "time", values: values.map((_, i) => i * 1000) },
          { name: "state", type: "string", values },
        ],
      },
    },
  });

  it("draws one row per query, not only the first query's", () => {
    const model: PanelModel = {
      ...panel("state-timeline", {}),
      targets: ["A", "B", "C"].map((refId) => ({
        refId,
        datasourceId: "ds",
        query: { sql: "SELECT 1" },
      })),
    };
    const { container } = render(
      <PanelBody
        panel={model}
        title="Services"
        range={{ from: 0, to: 3000 }}
        pending={false}
        error={null}
        outcomes={[
          status("A", ["ok", "down"]),
          status("B", ["degraded", "ok"]),
          status("C", ["ok", "ok"]),
        ]}
      />,
    );
    const names = [...container.querySelectorAll(".state__name")].map((n) => n.textContent);
    expect(names).toEqual(["state (A)", "state (B)", "state (C)"]);
  });
});
