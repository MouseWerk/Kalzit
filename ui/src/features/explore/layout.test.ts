import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss } from "../../test/cssParse";

/**
 * jsdom applies no stylesheets, so this checks the wiring instead: the layout that gives a panel
 * body its height must come with PanelBody itself, in the panels' own stylesheet. Explore once
 * rendered PanelBody before any dashboard page had loaded dashboards.css; a chart there had no
 * height at all.
 */
const SRC = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");

function declarations(path: string, selector: string) {
  return parseCss(read(path)).find((rule) => rule.selector === selector)?.declarations ?? [];
}

describe("panel body layout outside dashboards", () => {
  it("is in the stylesheet PanelBody imports, not in the dashboard stylesheet", () => {
    expect(read("features/dashboards/PanelCard.tsx")).toContain(
      'import "../../panels/panels.css";',
    );
    expect(declarations("panels/panels.css", ".panel-content")).toContainEqual({
      property: "height",
      value: "100%",
    });
    expect(declarations("panels/panels.css", ".panel-content__viz")).toContainEqual({
      property: "flex",
      value: "1",
    });
    expect(declarations("features/dashboards/dashboards.css", ".panel-content__viz")).toEqual([]);
  });

  it("gives Explore's result a height for the chart to fill", () => {
    expect(declarations("features/explore/explore.css", ".explore__panel")).toContainEqual({
      property: "height",
      value: "var(--size-result)",
    });
  });
});
