import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { Frame, GraphSet } from "../../api/generated/shapes";
import { installFakeServer } from "../../test/fakeServer";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { forgetMapInfo, MapEndpointsContext, NO_MAP_IMAGES, publicLinkMap } from "./source";

const RANGE = { from: 0, to: 1 };
const point = (lat: number, lon: number) => ({ $type: "point", srid: 4326, x: lon, y: lat });

const ROUTES = {
  nodes: [
    {
      id: "n1",
      labels: ["Lager"],
      properties: { name: "Lager Nord", standort: point(53.55, 9.99) },
    },
    {
      id: "n2",
      labels: ["Lager"],
      properties: { name: "Lager Süd", standort: point(48.14, 11.58) },
    },
    {
      id: "n3",
      labels: ["Kunde"],
      properties: { name: "Anna Weber", standort: point(53.08, 8.8) },
    },
    { id: "n4", labels: ["Kunde"], properties: { name: "Petra Lang" } },
  ],
  edges: [
    { id: "e1", type: "LIEFERT", from: "n1", to: "n3", properties: {} },
    { id: "e2", type: "UMLAGERUNG", from: "n1", to: "n2", properties: {} },
  ],
} as unknown as GraphSet;

const SOURCE = {
  enabled: true,
  urlTemplate: "https://karten.example.org/tiles/{z}/{x}/{y}.png",
  attribution: "© Beispiel-Kartendienst und Mitwirkende",
  maxZoom: 14,
  cacheMaxMb: 2048,
  cacheTtlDays: 7,
};

async function renderMap(
  input: { graphs?: GraphSet[]; frames?: Frame[] },
  options: unknown = {},
  endpoints?: Parameters<typeof MapEndpointsContext>[0]["value"],
) {
  const plugin = getPanel("map") as AnyPanelPlugin;
  const { Panel } = plugin;
  const panel = (
    <Panel
      frames={input.frames ?? []}
      graphs={input.graphs?.map((graph) => ({ refId: "A", datasourceId: "ds", graph }))}
      options={plugin.options(options)}
      timeRange={RANGE}
      title="Lieferwege"
    />
  );
  const view = render(
    endpoints === undefined ? (
      panel
    ) : (
      <MapEndpointsContext value={endpoints}>{panel}</MapEndpointsContext>
    ),
  );
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
  return view;
}

beforeEach(() => {
  forgetMapInfo();
});

describe("map panel without map images", () => {
  it("draws the graph's places over the outlines and names what has no coordinates", async () => {
    const server = installFakeServer({ signedIn: true });
    await renderMap({ graphs: [ROUTES] });
    expect(screen.getByText(/^3 of 4 nodes on the map, 2 edges\./, { selector: "p" })).toBeTruthy();
    expect(screen.getByText(/1 without coordinates · without map images/)).toBeTruthy();
    const drawing = screen.getByRole("group", { name: "Lieferwege: 3 places" });
    expect(within(drawing).getByRole("button", { name: "Lager Nord" })).toBeTruthy();
    expect(screen.getByText("Without coordinates")).toBeTruthy();
    expect(screen.getByText("Petra Lang")).toBeTruthy();
    expect(screen.getAllByText("Outlines: Natural Earth, public domain").length).toBeGreaterThan(0);
    // Only this server is asked: whether there are map images, and no picture at all.
    await waitFor(() => expect(server.calls.some((c) => c.path === "/api/map")).toBe(true));
    expect(server.calls.every((c) => c.path.startsWith("/api/") || c.path.includes(".kzo"))).toBe(
      true,
    );
    expect(screen.queryByTestId("map-tiles")).toBeNull();
  });

  it("selects a node, clears it with Escape, and offers the same places as a table", async () => {
    installFakeServer({ signedIn: true });
    const user = userEvent.setup();
    await renderMap({ graphs: [ROUTES] });
    await user.click(screen.getByRole("button", { name: "Lager Nord" }));
    expect(screen.getByText(/Selection: Lager Nord/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("application"), { key: "Escape" });
    expect(screen.queryByText(/Selection: Lager Nord/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(within(table).getByText("No coordinates")).toBeTruthy();
  });

  it("says why nothing is on the map when no node has a place", async () => {
    installFakeServer({ signedIn: true });
    const empty = {
      nodes: [{ id: "a", labels: ["Kunde"], properties: { name: "Ohne Ort" } }],
      edges: [],
    } as unknown as GraphSet;
    await renderMap({ graphs: [empty] });
    expect(screen.getByText("Nothing for the map")).toBeTruthy();
    expect(screen.getByText(/None of the 1 nodes has a point/)).toBeTruthy();
  });
});

describe("map panel with map images", () => {
  it("loads them from this server only, with the attribution, and falls back to outlines when they fail", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.map.view = { ...server.areas.map.view, source: SOURCE, version: 1 };
    const { container } = await renderMap({ graphs: [ROUTES] });
    const tiles = await screen.findByTestId("map-tiles");
    const images = [...tiles.querySelectorAll("image")];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute("href")).toMatch(/^\/api\/map\/tiles\/\d+\/\d+\/\d+$/);
    }
    expect(screen.getAllByText(SOURCE.attribution).length).toBeGreaterThan(0);
    expect(screen.getByText(/map images on/)).toBeTruthy();
    expect(container.innerHTML).not.toContain("karten.example.org");
    fireEvent.error(images[0] as Element);
    expect(await screen.findByText("The map images are not loading right now.")).toBeTruthy();
    expect(screen.queryByTestId("map-tiles")).toBeNull();
  });

  it("asks through the link's own routes on a public link, and nothing on a public snapshot", async () => {
    const server = installFakeServer({ signedIn: false });
    await renderMap({ graphs: [ROUTES] }, {}, publicLinkMap("tok-123"));
    await waitFor(() =>
      expect(server.calls.some((c) => c.path === "/api/public/dashboards/tok-123/map")).toBe(true),
    );
    forgetMapInfo();
    server.calls.length = 0;
    await renderMap({ graphs: [ROUTES] }, {}, NO_MAP_IMAGES);
    expect(server.calls.some((c) => c.path.startsWith("/api/") && c.path.includes("map"))).toBe(
      false,
    );
  });
});
