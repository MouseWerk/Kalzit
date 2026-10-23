import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PanelModel } from "../features/dashboards/model";
import { PanelBody } from "../features/dashboards/PanelCard";

/**
 * re2js loads on first use. This file never loads it itself: the panel has to start the load
 * and draw again once it is there, or regex mappings would stay unapplied until new data came.
 */
describe("patterns before re2js has loaded", () => {
  it("draws the panel again with its mappings once re2js is there", async () => {
    const panel: PanelModel = {
      id: "p",
      type: "table",
      title: "Keys",
      grid: { x: 0, y: 0, w: 6, h: 6 },
      targets: [{ refId: "A", datasourceId: "ds", query: { sql: "SELECT key FROM k" } }],
      transformations: [],
      options: {},
      fieldConfig: {
        defaults: { mappings: [{ type: "regex", pattern: "^secret-", text: "MAPPED" }] },
        overrides: [],
      },
    };
    render(
      <PanelBody
        panel={panel}
        title="Keys"
        range={{ from: 0, to: 1 }}
        pending={false}
        error={null}
        outcomes={[
          {
            refId: "A",
            result: {
              shape: "frame",
              frame: { fields: [{ name: "key", type: "string", values: ["secret-123", "plain"] }] },
            },
          },
        ]}
      />,
    );
    // First drawn before re2js is there: the value shows unmapped.
    expect(screen.getByText("secret-123")).toBeTruthy();
    const before = screen.getByRole("table");
    expect(await screen.findByText("MAPPED", undefined, { timeout: 4000 })).toBeTruthy();
    // Drawn anew, not patched: with the React Compiler a reused element would keep the old
    // cells, so the panel must not depend on something else happening to redraw it.
    expect(screen.getByRole("table")).not.toBe(before);
    expect(screen.queryByText("secret-123")).toBeNull();
    expect(screen.getByText("plain")).toBeTruthy();
  });
});
