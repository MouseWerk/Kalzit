import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentSet, FieldSchema } from "../api/generated/shapes";
import { getPanel } from "../panels/registry";
import { SCHEMA_ROW_HEIGHT } from "../panels/schema";
import type { AnyPanelPlugin } from "../panels/types";
import { TREE_ROW_HEIGHT } from "./DocumentTree";

/**
 * Performance budgets (docs/PLAN.md, section 11): the document explorer stays fluid with 10,000
 * documents, the schema panel with 1,000 paths. Both draw only the rows in view, which the
 * bounded row counts pin; the times are best of three, with room for CI machines.
 */

const CI = process.env.CI !== undefined;
/** Rows a virtual list may draw at the fallback height of 220 px with its overscan. */
const MAX_DRAWN = 40;

/** A deterministic document: typed values, nesting and an array, like an order. */
function generated(i: number): Record<string, unknown> {
  return {
    _id: { $type: "objectId", value: i.toString(16).padStart(24, "0") },
    createdAt: { $type: "date", value: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() },
    status: ["paid", "open", "sent"][i % 3],
    total: { $type: "decimal", value: `${(i % 997) + 0.5}` },
    customer: { name: `Customer ${i % 101}`, address: { city: ["Wien", "Graz", "Linz"][i % 3] } },
    items: Array.from({ length: (i % 4) + 1 }, (_, k) => ({ sku: `S-${k}`, qty: k + 1 })),
  };
}

function renderPanel(type: string, set: DocumentSet) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <Panel
      frames={[]}
      documents={[set]}
      options={plugin.options({})}
      timeRange={{ from: 0, to: 1 }}
      title="Budget"
    />,
  );
}

/** Drawn rows by selector: role queries would cost more than what is measured. */
const treeItems = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];

function best(runs: number, measure: () => number): number {
  let fastest = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run++) {
    fastest = Math.min(fastest, measure());
  }
  return fastest;
}

describe("performance budget", () => {
  const documents = Array.from({ length: 10_000 }, (_, i) => generated(i));

  it("shows 10,000 documents, scrolls and opens one within budget", () => {
    let scrolled = Number.POSITIVE_INFINITY;
    let expanded = Number.POSITIVE_INFINITY;
    const rendered = best(3, () => {
      const start = performance.now();
      const view = renderPanel("documents", { documents, schema: [], notices: [] });
      const took = performance.now() - start;
      expect(treeItems().length).toBeLessThanOrEqual(MAX_DRAWN);

      const tree = document.querySelector<HTMLElement>('[role="tree"]') as HTMLElement;
      const scrollStart = performance.now();
      act(() => {
        tree.scrollTop = 5000 * TREE_ROW_HEIGHT;
        fireEvent.scroll(tree);
      });
      scrolled = Math.min(scrolled, performance.now() - scrollStart);
      const drawn = treeItems();
      expect(drawn.length).toBeLessThanOrEqual(MAX_DRAWN);
      expect(drawn.some((row) => row.getAttribute("aria-posinset") === "5001")).toBe(true);

      const target = drawn.find(
        (row) => row.getAttribute("aria-posinset") === "5001",
      ) as HTMLElement;
      const expandStart = performance.now();
      fireEvent.click(target);
      expanded = Math.min(expanded, performance.now() - expandStart);
      expect(target.getAttribute("aria-expanded")).toBe("true");
      expect(treeItems().length).toBeLessThanOrEqual(MAX_DRAWN);
      view.unmount();
      return took;
    });
    process.stdout.write(
      `explorer: 10,000 documents in ${rendered.toFixed(0)} ms, scroll ${scrolled.toFixed(0)} ms, open ${expanded.toFixed(0)} ms\n`,
    );
    expect(rendered).toBeLessThan(CI ? 1500 : 750);
    expect(scrolled).toBeLessThan(CI ? 400 : 200);
    expect(expanded).toBeLessThan(CI ? 400 : 200);
  });

  it("shows a schema of 1,000 paths and filters it within budget", () => {
    const schema: FieldSchema[] = Array.from({ length: 1000 }, (_, i) => ({
      path: `group${Math.floor(i / 10)}.field${i}`,
      coverage: i % 7 === 0 ? 0.9 : 1,
      types:
        i % 11 === 0
          ? [
              { name: "string", share: 0.5 },
              { name: "int32", share: 0.5 },
            ]
          : [{ name: "string", share: 1 }],
    }));
    let filtered = Number.POSITIVE_INFINITY;
    const rendered = best(3, () => {
      const start = performance.now();
      const view = renderPanel("schema", { documents: [{}], schema, notices: [] });
      const took = performance.now() - start;
      // Header, two spacers and the rows in view.
      expect([...document.querySelectorAll("tr")].length).toBeLessThanOrEqual(MAX_DRAWN);
      expect(document.querySelector("table")?.getAttribute("aria-rowcount")).toBe("1001");

      const table = document.querySelector<HTMLElement>("section.vt") as HTMLElement;
      act(() => {
        table.scrollTop = 900 * SCHEMA_ROW_HEIGHT;
        fireEvent.scroll(table);
      });
      expect(screen.getByText("group90.field900")).toBeTruthy();

      const filterStart = performance.now();
      fireEvent.change(screen.getByLabelText("Find paths"), {
        target: { value: "field99" },
      });
      filtered = Math.min(filtered, performance.now() - filterStart);
      expect(document.querySelector("table")?.getAttribute("aria-rowcount")).toBe("12");
      view.unmount();
      return took;
    });
    process.stdout.write(
      `schema: 1,000 paths in ${rendered.toFixed(0)} ms, search ${filtered.toFixed(0)} ms\n`,
    );
    expect(rendered).toBeLessThan(CI ? 1000 : 500);
    expect(filtered).toBeLessThan(CI ? 400 : 200);
  });
});
