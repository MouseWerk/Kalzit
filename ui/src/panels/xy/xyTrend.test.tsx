import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../../api/generated/shapes";
import { type PanelHost, PanelHostContext } from "../host";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";

const RANGE = { from: 0, to: 100_000 };

function draw(type: string, frames: Frame[], options: unknown = {}, host: PanelHost = {}) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <PanelHostContext value={host}>
      <Panel frames={frames} options={plugin.options(options)} timeRange={RANGE} title="Chart" />
    </PanelHostContext>,
  );
}

const basket: Frame = {
  fields: [
    { name: "kunde", type: "string", values: ["Aurora GmbH", "Bergwerk AG", "Calcit & Co."] },
    { name: "region", type: "string", values: ["Nord", "Ost", "Süd"] },
    { name: "warenkorb", type: "number", values: [58.2, 96, 142] },
    { name: "lieferzeit", type: "number", values: [2.4, 3.6, 5.1] },
  ],
};

describe("XY chart", () => {
  it("draws a point per row, a legend per series and reads points with the keyboard", () => {
    const { container } = draw("xy", [basket], { seriesBy: "region" });
    expect(container.querySelectorAll(".xy__point")).toHaveLength(3);
    expect(screen.getByText("Nord")).toBeTruthy();
    const plot = screen.getByRole("group", { name: "Chart" });
    plot.focus();
    fireEvent.keyDown(plot, { key: "End" });
    // The last point in X order, named by its row's text and series.
    expect(screen.getByRole("status").textContent).toContain("Calcit & Co. · Süd");
    expect(screen.getByRole("status").textContent).toContain("warenkorb: 142");
    expect(container.querySelector(".xy__ring")).not.toBeNull();
  });

  it("joins points in the order of X for lines and says when it samples", () => {
    const n = 12_500;
    const many: Frame = {
      fields: [
        { name: "x", type: "number", values: Array.from({ length: n }, (_, i) => i) },
        { name: "y", type: "number", values: Array.from({ length: n }, (_, i) => i % 7) },
      ],
    };
    const { container } = draw("xy", [many]);
    expect(container.querySelectorAll(".xy__point")).toHaveLength(12_000);
    expect(screen.getByText(/12,000 of 12,500 points drawn, evenly sampled/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show as density" }));
    expect(container.querySelectorAll(".xy__point")).toHaveLength(0);
    expect(container.querySelectorAll(".xy__cell").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Show as points" }));
    expect(container.querySelectorAll(".xy__point")).toHaveLength(12_000);

    const lines = draw("xy", [basket], { show: "lines" }).container;
    expect(lines.querySelectorAll(".xy__point")).toHaveLength(0);
    expect(lines.querySelector(".xy__line")?.getAttribute("d")).toMatch(/^M/);
  });

  it("asks for a second number and offers the bar chart in the editor", () => {
    const changeType = vi.fn();
    const one: Frame = {
      fields: [
        { name: "region", type: "string", values: ["Nord", "Ost"] },
        { name: "umsatz", type: "number", values: [1, 2] },
      ],
    };
    draw("xy", [one], {}, { changeType, addStep: vi.fn() });
    expect(screen.getByText("Two number fields needed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show as bar chart" }));
    expect(changeType).toHaveBeenCalledWith("bar");
  });
});

const lots: Frame = {
  fields: [
    { name: "losgroesse", type: "number", values: [1, 10, 100, 10, 1000] },
    { name: "preis", type: "number", values: [9, 8, 6, 8, 4] },
  ],
};

describe("Trend", () => {
  it("draws series over an ascending number with number ticks", () => {
    const frame: Frame = {
      fields: [
        { name: "tage", type: "number", values: [0, 30, 60, 90] },
        { name: "abo", type: "number", values: [100, 92, 80, 71] },
        { name: "einmal", type: "number", values: [100, 60, 41, 30] },
      ],
    };
    const { container } = draw("trend", [frame]);
    expect(container.querySelectorAll(".ts__line")).toHaveLength(2);
    // The X labels sit at the bottom: round numbers over 0 to 90, not dates or times.
    const bottom = [...container.querySelectorAll("text.ts__label")].filter(
      (l) => l.getAttribute("text-anchor") === "middle",
    );
    const labels = bottom.map((l) => l.textContent);
    expect(labels).toEqual(["0", "20", "40", "60", "80"]);
    expect(labels.some((l) => l?.includes(":"))).toBe(false);
  });

  it("never sorts by itself: it shows the hint and adds the Sort step on request", () => {
    const addStep = vi.fn();
    const changeType = vi.fn();
    const { container } = draw("trend", [lots], {}, { addStep, changeType });
    expect(container.querySelector(".ts__line")).toBeNull();
    expect(screen.getByText("The X values do not ascend")).toBeTruthy();
    expect(screen.getByText(/falls back to 10 in row 4 of 5/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add the step “Sort”" }));
    expect(addStep).toHaveBeenCalledWith({
      type: "sort",
      frame: "A",
      by: [{ field: "losgroesse" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Show as XY chart" }));
    expect(changeType).toHaveBeenCalledWith("xy");
  });

  it("offers grouping for repeated values and only explains on a dashboard", () => {
    const repeated: Frame = {
      fields: [
        { name: "losgroesse", type: "number", values: [1, 100, 100] },
        { name: "preis", type: "number", values: [9, 6, 7] },
      ],
    };
    const addStep = vi.fn();
    draw("trend", [repeated], {}, { addStep, changeType: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Add the step “Group” (mean)" }));
    expect(addStep).toHaveBeenCalledWith(
      expect.objectContaining({ type: "group", by: ["losgroesse"] }),
    );
    const viewing = draw("trend", [lots]).container;
    expect(viewing.querySelector(".fit-hint")).not.toBeNull();
    expect(viewing.querySelectorAll(".fit-hint button")).toHaveLength(0);
  });
});
