import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../api/generated/shapes";
import { WithLegend } from "./fieldConfig/Legend";
import { getPanel } from "./registry";
import type { AnyPanelPlugin } from "./types";

/**
 * Reading a computed style restyles the page first when anything changed since. While a dragged
 * panel is dropped, the dashboard renders with its styles changed; one read in a chart's render
 * then restyled the whole dashboard in that task (budget.spec.ts, dragging a panel). The root
 * font size comes with a box's measured size instead (useElementSize), read where layout is
 * current. Without a ResizeObserver (jsdom) nothing is measured, so every read here would be
 * one made while rendering.
 */
describe("charts read no computed style while rendering", () => {
  it("lays out a legend without reading a computed style", () => {
    const read = vi.spyOn(window, "getComputedStyle");
    render(
      <WithLegend legend={<p>Legend</p>} placement="bottom">
        <p>Drawing</p>
      </WithLegend>,
    );
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText("Legend")).toBeTruthy();
  });

  it("lays out stat values without reading a computed style", () => {
    const plugin = getPanel("stat") as AnyPanelPlugin;
    const { Panel } = plugin;
    const frame: Frame = {
      fields: [
        { name: "a", type: "number", values: [1, 2, 3] },
        { name: "b", type: "number", values: [4, 5, 6] },
      ],
    };
    const read = vi.spyOn(window, "getComputedStyle");
    render(
      <Panel
        frames={[frame]}
        options={plugin.options({})}
        timeRange={{ from: 0, to: 100_000 }}
        title="Panel"
      />,
    );
    // Before any role query: those read computed styles themselves (whether an element is hidden).
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(screen.getAllByRole("listitem").length).toBe(2);
  });
});
