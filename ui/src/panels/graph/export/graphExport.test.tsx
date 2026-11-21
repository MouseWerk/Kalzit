import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type PanelHost, PanelHostContext } from "../../host";
import type { GraphModel } from "../model";
import type { GraphView, Visibility } from "../view";
import { GraphExport, type GraphExportProps } from "./GraphExport";

const props: GraphExportProps = {
  title: "Shop",
  scene: () => null,
  root: { current: null },
  palette: {} as unknown as NonNullable<GraphExportProps["palette"]>,
  model: { nodes: [], edges: [] } as unknown as GraphModel,
  view: { nodes: [], edges: [], nodeOf: new Int32Array() } as unknown as GraphView,
  visibility: { nodes: new Uint8Array(), edges: new Uint8Array() } as Visibility,
  selected: new Set(),
  legend: {
    labels: [],
    hidden: new Set(),
    swatches: false,
    property: null,
    ramp: "blue" as unknown as GraphExportProps["legend"]["ramp"],
    propertyName: "",
    sizeNote: null,
  },
};

async function openMenu(host: PanelHost) {
  render(
    <PanelHostContext value={host}>
      <GraphExport {...props} />
    </PanelHostContext>,
  );
  await userEvent.setup().click(screen.getByRole("button", { name: "Export" }));
}

const names = () => screen.getAllByRole("menuitem").map((item) => item.textContent ?? "");

describe("the export menu of a graph panel", () => {
  it("offers the three pictures and one locked entry without data:export", async () => {
    await openMenu({ exportData: { allowed: false, stored: false, run: vi.fn() } });
    const items = names();
    expect(items).toHaveLength(4);
    expect(items[0]).toMatch(/^PNG/);
    expect(items[1]).toMatch(/^SVG/);
    expect(items[2]).toMatch(/^PDF/);
    const locked = screen.getByRole("menuitem", { name: /^GraphML, JSON, CSV/ });
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    expect(locked.textContent).toContain("needs data:export");
  });

  it("offers no data formats where the page has no export, such as a public link", async () => {
    await openMenu({});
    expect(names().map((n) => n.slice(0, 3))).toEqual(["PNG", "SVG", "PDF"]);
    expect(screen.queryByText(/GraphML/)).toBeNull();
  });

  it("offers all four data formats with data:export", async () => {
    await openMenu({ exportData: { allowed: true, stored: false, run: vi.fn() } });
    const items = names();
    expect(items).toHaveLength(7);
    for (const label of ["GraphML", "JSON", "CSV: nodes", "CSV: edges"]) {
      expect(screen.getByRole("menuitem", { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.queryByText(/needs data:export/)).toBeNull();
  });
});
