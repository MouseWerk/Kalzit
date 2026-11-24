import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Frame, GraphSet } from "../../api/generated/shapes";
import { type PanelHost, PanelHostContext } from "../host";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { decodeCountries } from "./countries";

vi.mock("./countries", async (original) => {
  const actual = await original<typeof import("./countries")>();
  const bytes = readFileSync(resolve(import.meta.dirname, "outlines/countries.kzc"));
  return {
    ...actual,
    loadCountries: () => Promise.resolve(actual.decodeCountries(new Uint8Array(bytes))),
  };
});

const RANGE = { from: 0, to: 1 };

const frame = (fields: [string, string, unknown[]][]): Frame =>
  ({ fields: fields.map(([name, type, values]) => ({ name, type, values })) }) as unknown as Frame;

const CITIES = frame([
  ["stadt", "string", ["Berlin", "Paris", "Lager Süd", "Testfiliale"]],
  ["lat", "number", [52.52, 48.86, null, 91.2]],
  ["lon", "number", [13.4, 2.35, null, 13.4]],
  ["umsatz", "number", [48_200, 12_000, 5, 7]],
]);

const COUNTRY_SALES = frame([
  ["land", "string", ["DE", "FRA", "UK"]],
  ["umsatz", "number", [117_133, 56_020, 30_000]],
]);

async function renderMap(
  input: { frames?: Frame[]; graphs?: GraphSet[] },
  options: unknown = {},
  host: Partial<PanelHost> = {},
) {
  const plugin = getPanel("map") as AnyPanelPlugin;
  const { Panel } = plugin;
  const view = render(
    <PanelHostContext value={host as PanelHost}>
      <Panel
        frames={input.frames ?? []}
        graphs={input.graphs?.map((graph) => ({ refId: "A", datasourceId: "ds", graph }))}
        options={plugin.options(options)}
        timeRange={RANGE}
        title="Umsatz je Stadt"
      />
    </PanelHostContext>,
  );
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
  return view;
}

describe("map panel", () => {
  it("draws rows with coordinates and counts the rows without a place honestly", async () => {
    const user = userEvent.setup();
    await renderMap({ frames: [CITIES] }, { layers: [{ kind: "points", valueField: "umsatz" }] });
    expect(screen.getByText(/^2 of 4 rows on the map/)).toBeTruthy();
    expect(screen.getByText(/2 without a place · no map images/)).toBeTruthy();
    expect(screen.getAllByText("Outlines: Natural Earth, public domain").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "2 without a place" }));
    const list = screen.getByRole("region", { name: "2 rows without a place" });
    expect(within(list).getByText("no coordinates")).toBeTruthy();
    expect(within(list).getByText("latitude 91.2 outside −90 to 90")).toBeTruthy();
    // The legend names the value field and its range.
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(within(legend).getByText("Points, size by umsatz")).toBeTruthy();
  });

  it("reads the places from west to east with the keyboard, with the value", async () => {
    await renderMap({ frames: [CITIES] }, { layers: [{ kind: "points", valueField: "umsatz" }] });
    const map = screen.getByRole("group", { name: "Map: Umsatz je Stadt" });
    const spoken = () =>
      [...document.querySelectorAll(".visually-hidden[role='status']")]
        .map((e) => e.textContent)
        .join("");
    // Paris lies west of Berlin.
    fireEvent.keyDown(map, { key: "ArrowRight" });
    expect(spoken()).toContain("Paris, umsatz: 12");
    fireEvent.keyDown(map, { key: "ArrowRight" });
    expect(spoken()).toContain("Berlin, umsatz: 48");
  });

  it("offers the same places as a table, with the reasons", async () => {
    const user = userEvent.setup();
    await renderMap({ frames: [CITIES] });
    await user.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(within(table).getByText("no coordinates")).toBeTruthy();
  });

  it("fills countries by code and offers the pair for a code it does not know", async () => {
    const editOptions = vi.fn();
    await renderMap(
      { frames: [COUNTRY_SALES] },
      { layers: [{ kind: "areas", valueField: "umsatz" }] },
      { editOptions },
    );
    await screen.findByText(/^2 of 3 countries/);
    expect(screen.getAllByTestId("map-areas")[0]?.querySelectorAll("path")).toHaveLength(2);
    expect(screen.getByText("UK: did you mean GB (United Kingdom)?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Map UK to GB" }));
    expect(editOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: [expect.objectContaining({ kind: "areas", aliases: { UK: "GB" } })],
      }),
    );
  });

  it("adds only the code pairs that still fit the layer, and says how many do not", async () => {
    const editOptions = vi.fn();
    const full = Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, "DE"]));
    const names = frame([
      ["land", "string", ["FR", "UK", "Deutschland"]],
      ["umsatz", "number", [3, 1, 2]],
    ]);
    await renderMap(
      { frames: [names] },
      { layers: [{ kind: "areas", valueField: "umsatz", aliases: full }] },
      { editOptions },
    );
    await screen.findByText("1 more do not fit: a layer keeps at most 50 code pairs.");
    fireEvent.click(screen.getByRole("button", { name: "Map UK to GB" }));
    const [options] = editOptions.mock.calls[0] ?? [];
    expect(Object.keys(options.layers[0].aliases)).toHaveLength(50);
  });

  it("says why nothing is on the map and, in the editor, offers the fields that fit", async () => {
    const editOptions = vi.fn();
    const odd = frame([
      ["x1", "number", [52.52, 48.86]],
      ["x2", "number", [13.41, 2.35]],
    ]);
    await renderMap({ frames: [odd] }, {}, { editOptions });
    expect(screen.getByText("No place found")).toBeTruthy();
    expect(screen.getByText(/None of the 2 rows has coordinates/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Latitude x1, longitude x2" }));
    expect(editOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        layers: [expect.objectContaining({ place: "coords", latField: "x1", lonField: "x2" })],
      }),
    );
  });

  it("explains on a dashboard without buttons", async () => {
    await renderMap({ frames: [frame([["name", "string", ["a"]]])] });
    expect(screen.getByText("Choose the place in the panel editor.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws a graph's nodes with a legend per label", async () => {
    const graph = {
      nodes: [
        {
          id: "a",
          labels: ["Lager"],
          properties: { name: "Nord", standort: { $type: "point", srid: 4326, x: 10, y: 53.5 } },
        },
        { id: "b", labels: ["Kunde"], properties: { name: "Ohne" } },
      ],
      edges: [],
    } as unknown as GraphSet;
    await renderMap({ graphs: [graph] });
    expect(screen.getByText(/^1 of 2 nodes on the map/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Legend" })).getByText("Lager")).toBeTruthy();
  });

  it("decodes the bundled areas the same way the panel does", () => {
    const bytes = readFileSync(resolve(import.meta.dirname, "outlines/countries.kzc"));
    expect(decodeCountries(new Uint8Array(bytes)).byCode.has("GB")).toBe(true);
  });
});
