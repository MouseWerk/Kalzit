import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Frame } from "../../api/generated/shapes";
import { installFakeServer } from "../../test/fakeServer";
import { type PanelHost, PanelHostContext } from "../host";
import { getPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import { forgetMapInfo, MapEndpointsContext, NO_MAP_IMAGES, publicLinkMap } from "./source";
import { FAILED_TILES, visibleTiles } from "./tiles";

const SOURCE = {
  enabled: true,
  urlTemplate: "https://karten.example.org/tiles/{z}/{x}/{y}.png",
  attribution: "\u00a9 Beispiel-Kartendienst und Mitwirkende",
  maxZoom: 14,
  cacheMaxMb: 2048,
  cacheTtlDays: 7,
};

const CITIES = {
  fields: [
    { name: "stadt", type: "string", values: ["Berlin", "Paris"] },
    { name: "lat", type: "number", values: [52.52, 48.86] },
    { name: "lon", type: "number", values: [13.4, 2.35] },
  ],
} as unknown as Frame;

afterEach(() => forgetMapInfo());

describe("the map images a view needs", () => {
  it("takes the zoom level nearest to the view and covers the stage", () => {
    // The world is 1024 px wide: zoom 2, four by four pictures of 256 px.
    const tiles = visibleTiles({ x: 0, y: 0 }, 1024, { width: 512, height: 300 }, 14);
    expect(tiles.map((t) => `${t.z}/${t.x}/${t.y}`)).toEqual(["2/0/0", "2/1/0", "2/0/1", "2/1/1"]);
    expect(tiles[3]).toMatchObject({ left: 256, top: 256, size: 256 });
  });

  it("never asks above the source's highest zoom; beyond it the pictures grow", () => {
    const tiles = visibleTiles({ x: -40_000, y: -40_000 }, 2 ** 20, { width: 300, height: 200 }, 6);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([6]));
    expect(tiles[0]?.size).toBe(2 ** 20 / 2 ** 6);
  });

  it("asks only for pictures that exist: none west of the world, none past its edge", () => {
    const tiles = visibleTiles({ x: 200, y: 100 }, 512, { width: 2000, height: 2000 }, 14);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(2 ** tile.z);
      expect(tile.y).toBeLessThan(2 ** tile.z);
    }
    expect(tiles).toHaveLength(4);
    expect(visibleTiles({ x: 0, y: 0 }, 0, { width: 100, height: 100 }, 14)).toEqual([]);
  });

  it("asks this server for every picture, the session's routes or a public link's own", () => {
    expect(publicLinkMap("a/b").tile(3, 4, 5)).toBe("/api/public/dashboards/a%2Fb/map/tiles/3/4/5");
    expect(publicLinkMap("tok").info).toBe("/api/public/dashboards/tok/map");
    expect(NO_MAP_IMAGES.info).toBeNull();
  });
});

async function renderMap(endpoints?: typeof NO_MAP_IMAGES) {
  const plugin = getPanel("map") as AnyPanelPlugin;
  const { Panel } = plugin;
  const panel = (
    <PanelHostContext value={{} as PanelHost}>
      <Panel
        frames={[CITIES]}
        options={plugin.options({})}
        timeRange={{ from: 0, to: 1 }}
        title="Lager"
      />
    </PanelHostContext>
  );
  render(
    endpoints === undefined ? (
      panel
    ) : (
      <MapEndpointsContext value={endpoints}>{panel}</MapEndpointsContext>
    ),
  );
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
}

describe("map images on the map panel", () => {
  it("draws outlines and asks nobody while the server has no map images", async () => {
    installFakeServer({ signedIn: true });
    await renderMap();
    expect(await screen.findByText(/no map images/)).toBeTruthy();
    expect(document.querySelectorAll("image")).toHaveLength(0);
    expect(screen.getAllByText("Outlines: Natural Earth, public domain").length).toBeGreaterThan(0);
  });

  it("lays the pictures from this server under the points, with the source's attribution", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.map.view = { ...server.areas.map.view, source: SOURCE, version: 1 };
    await renderMap();
    expect(await screen.findByText(/map images on/)).toBeTruthy();
    const images = [...document.querySelectorAll("image")];
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute("href")).toMatch(/^\/api\/map\/tiles\/\d+\/\d+\/\d+$/);
    }
    expect(screen.getByText(SOURCE.attribution)).toBeTruthy();
    // Land and water come from the pictures; the outlines are the way without them.
    expect(screen.queryByTestId("map-outlines")).toBeNull();
  });

  it("falls back to the outlines and says so when the pictures do not load", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.map.view = { ...server.areas.map.view, source: SOURCE, version: 1 };
    await renderMap();
    await screen.findByText(/map images on/);
    const images = [...document.querySelectorAll("image")];
    for (const image of images.slice(0, Math.max(FAILED_TILES, images.length))) {
      fireEvent.error(image);
    }
    expect(await screen.findByText("The map images are not loading right now.")).toBeTruthy();
    expect(screen.getByText(/no map images/)).toBeTruthy();
    expect(document.querySelectorAll("image")).toHaveLength(0);
  });

  it("draws outlines at once while the server says its source failed lately", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.map.view = { ...server.areas.map.view, source: SOURCE, version: 1 };
    server.areas.map.available = false;
    await renderMap();
    expect(await screen.findByText("The map images are not loading right now.")).toBeTruthy();
    expect(document.querySelectorAll("image")).toHaveLength(0);
  });

  it("has no map images on a public snapshot, whatever the server has", async () => {
    const server = installFakeServer({ signedIn: true });
    server.areas.map.view = { ...server.areas.map.view, source: SOURCE, version: 1 };
    await renderMap(NO_MAP_IMAGES);
    expect(await screen.findByText(/no map images/)).toBeTruthy();
    expect(document.querySelectorAll("image")).toHaveLength(0);
    expect(server.calls.some((call) => call.path.startsWith("/api/map"))).toBe(false);
  });
});
