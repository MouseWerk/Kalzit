import { render, screen } from "@testing-library/react";
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
