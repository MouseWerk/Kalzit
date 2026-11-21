import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Frame, GraphSet } from "../../api/generated/shapes";
import { suggestPanel } from "../registry";
import { bundledWidth, clusterEdges, clusterPoints } from "./cluster";
import { parseMapOptions } from "./options";
import { decodeOutlines, OutlineError } from "./outlines";
import { mapData, readPoint } from "./points";
import { fitView, project, visibleTiles, worldView } from "./projection";
import { frameHasPlaces, graphHasPlaces } from "./suggest";

const OPTIONS = parseMapOptions({});
const SIZE = { width: 640, height: 400 };

const frame = (fields: [string, string, unknown[]][]): Frame =>
  ({
    fields: fields.map(([name, type, values]) => ({ name, type, values })),
  }) as unknown as Frame;

const point = (lat: number, lon: number) => ({ $type: "point", srid: 4326, x: lon, y: lat });

/** Lieferwege (board frame 15): two warehouses, customers, one node without a place. */
const ROUTES: GraphSet = {
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
    {
      id: "n4",
      labels: ["Kunde"],
      properties: { name: "Lea Hoffmann", standort: point(48.1, 11.6) },
    },
    { id: "n5", labels: ["Kunde"], properties: { name: "Petra Lang" } },
  ],
  edges: [
    { id: "e1", type: "LIEFERT", from: "n1", to: "n3", properties: {} },
    { id: "e2", type: "LIEFERT", from: "n2", to: "n4", properties: {} },
    { id: "e3", type: "LIEFERT", from: "n1", to: "n5", properties: {} },
    { id: "e4", type: "UMLAGERUNG", from: "n1", to: "n2", properties: {} },
  ],
} as unknown as GraphSet;

describe("map options", () => {
  it("fall back to the defaults for anything unknown and keep bounds", () => {
    expect(OPTIONS).toEqual({
      coords: "auto",
      pointField: "",
      latField: "",
      lonField: "",
      sizeField: "",
      caption: "",
      outlines: "regions",
      fit: "data",
      edges: "straight",
      clusterDistance: 12,
    });
    const odd = parseMapOptions({
      coords: "polar",
      outlines: "rivers",
      clusterDistance: 81,
      latField: `  ${"b".repeat(120)} `,
    });
    expect([odd.coords, odd.outlines, odd.clusterDistance]).toEqual(["auto", "regions", 12]);
    expect(odd.latField).toHaveLength(100);
    expect(parseMapOptions({ clusterDistance: 0 }).clusterDistance).toBe(0);
  });
});

describe("places", () => {
  it("are read from typed points, GeoJSON, objects and WKT, never from other reference systems", () => {
    expect(readPoint(point(52.52, 13.4))).toEqual({ lat: 52.52, lon: 13.4 });
    expect(readPoint({ $type: "point", srid: 7203, x: 3, y: 4 })).toBeNull();
    expect(readPoint({ type: "Point", coordinates: [13.4, 52.52] })).toEqual({
      lat: 52.52,
      lon: 13.4,
    });
    expect(readPoint({ latitude: 52.52, longitude: 13.4 })).toEqual({ lat: 52.52, lon: 13.4 });
    expect(readPoint("POINT(13.4 52.52)")).toEqual({ lat: 52.52, lon: 13.4 });
    expect(readPoint({ lat: 95, lon: 0 })).toBeNull();
    expect(readPoint("Berlin")).toBeNull();
  });

  it("of a graph: nodes as points, edges between placed nodes, the rest named", () => {
    const data = mapData({ frames: [], graphs: [ROUTES] }, OPTIONS);
    expect(data.kind).toBe("graph");
    expect(data.points.map((p) => p.name)).toEqual([
      "Lager Nord",
      "Lager Süd",
      "Anna Weber",
      "Lea Hoffmann",
    ]);
    expect(data.missing).toEqual([{ id: "n5", name: "Petra Lang", label: "Kunde" }]);
    expect(data.edges.map((e) => e.id)).toEqual(["e1", "e2", "e4"]);
    expect([data.total, data.totalEdges]).toEqual([5, 4]);
    // The label occurring most often takes the first colour of the palette.
    expect(data.legend).toEqual([
      { label: "Lager", tone: 2, count: 2 },
      { label: "Kunde", tone: 1, count: 2 },
    ]);
    expect(mapData({ frames: [], graphs: [ROUTES] }, { ...OPTIONS, edges: "none" }).edges).toEqual(
      [],
    );
  });

  it("of rows: latitude and longitude by name, sized by a number column", () => {
    const rows = frame([
      ["stadt", "string", ["Bremen", "München", "Nirgendwo"]],
      ["lat", "number", [53.08, 48.14, null]],
      ["lon", "number", [8.8, 11.58, null]],
      ["umsatz", "number", [100, 400, 50]],
    ]);
    const data = mapData({ frames: [rows] }, { ...OPTIONS, sizeField: "umsatz" });
    expect(data.kind).toBe("rows");
    expect(data.points.map((p) => [p.name, p.lat, p.lon])).toEqual([
      ["Bremen", 53.08, 8.8],
      ["München", 48.14, 11.58],
    ]);
    expect(data.points[0]?.radius).toBeLessThan(data.points[1]?.radius ?? 0);
    expect(data.missing.map((m) => m.name)).toEqual(["Nirgendwo"]);
    // Named fields win over the usual names.
    const named = mapData(
      {
        frames: [
          frame([
            ["breite_wgs", "number", [1]],
            ["laenge_wgs", "number", [2]],
          ]),
        ],
      },
      { ...OPTIONS, coords: "latLon", latField: "breite_wgs", lonField: "laenge_wgs" },
    );
    expect(named.points.map((p) => [p.lat, p.lon])).toEqual([[1, 2]]);
  });

  it("of documents: a GeoJSON point or two number fields", () => {
    const data = mapData(
      {
        frames: [],
        documents: [
          {
            documents: [
              { name: "Filiale A", geo: { type: "Point", coordinates: [9.99, 53.55] } },
              { name: "Filiale B", ort: { lat: 50.1, lon: 8.7 } },
              { name: "Ohne" },
            ],
          } as never,
        ],
      },
      OPTIONS,
    );
    expect(data.points.map((p) => p.name)).toEqual(["Filiale A", "Filiale B"]);
    expect(data.missing.map((m) => m.name)).toEqual(["Ohne"]);
  });
});

describe("bundling", () => {
  it("joins near points, keeps far ones apart and merges the edges between bundles", () => {
    const data = mapData({ frames: [], graphs: [ROUTES] }, OPTIONS);
    const view = worldView(SIZE);
    const far = clusterPoints(data.points, view, SIZE, 12);
    // At world scale the four places lie within a few pixels: two bundles at most.
    expect(far.length).toBeLessThan(4);
    const near = clusterPoints(
      data.points,
      fitView(
        data.points.map((p) => p.world),
        SIZE,
      ),
      SIZE,
      12,
    );
    expect(near.map((c) => c.points.length).reduce((a, b) => a + b, 0)).toBe(4);
    expect(near.length).toBeGreaterThan(far.length);
    const alone = clusterPoints(data.points, view, SIZE, 0);
    expect(alone).toHaveLength(4);
    expect(clusterEdges(data.edges, alone)).toHaveLength(3);
    // Edges inside one bundle are not drawn.
    expect(clusterEdges(data.edges, far).every((line) => line.from !== line.to)).toBe(true);
    expect(bundledWidth(1, 1)).toBe(1);
    expect(bundledWidth(1, 4)).toBe(3);
    expect(bundledWidth(2, 1024)).toBe(8);
  });
});

describe("map images", () => {
  it("cover the panel with images of the whole zoom level nearest to the view, never above the source", () => {
    const view = { center: project(50, 10), zoom: 6.4 };
    const tiles = visibleTiles(view, SIZE, 14);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.z).toBe(6);
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(64);
      expect(tile.y).toBeLessThan(64);
    }
    expect(new Set(visibleTiles({ ...view, zoom: 11 }, SIZE, 4).map((t) => t.z))).toEqual(
      new Set([4]),
    );
    expect(visibleTiles(worldView(SIZE), SIZE, 14).every((t) => t.z <= 1)).toBe(true);
  });
});

describe("outlines", () => {
  it("decode the shipped files into paths of every kind", () => {
    for (const [file, kinds] of [
      ["world.kzo", ["land", "lake", "country"]],
      ["regions.kzo", ["region"]],
    ] as const) {
      const bytes = readFileSync(resolve(import.meta.dirname, "outlines", file));
      const paths = decodeOutlines(new Uint8Array(bytes));
      for (const kind of kinds) {
        expect(paths[kind].length, `${file}: ${kind}`).toBeGreaterThan(1000);
        expect(paths[kind].startsWith("M")).toBe(true);
      }
    }
  });

  it("refuse what is not an outline file", () => {
    expect(() => decodeOutlines(new Uint8Array([1, 2, 3]))).toThrow(OutlineError);
    const cut = new Uint8Array([0x4b, 0x5a, 0x4f, 0x31, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0x80]);
    expect(() => decodeOutlines(cut)).toThrow("ends early");
  });
});

describe("suggestion", () => {
  it("offers the map for graphs of places and for rows with latitude and longitude", () => {
    expect(graphHasPlaces(ROUTES)).toBe(true);
    expect(suggestPanel([{ shape: "graph", graph: ROUTES } as never])).toBe("map");
    const plain = { nodes: [{ id: "a", labels: [], properties: {} }], edges: [] } as never;
    expect(suggestPanel([{ shape: "graph", graph: plain } as never])).toBe("network");
    const places = frame([
      ["name", "string", ["Bremen"]],
      ["latitude", "number", [53.08]],
      ["longitude", "number", [8.8]],
    ]);
    expect(frameHasPlaces(places)).toBe(true);
    expect(suggestPanel([{ shape: "frame", frame: places } as never])).toBe("map");
    // x and y alone are no places: they name many things.
    const xy = frame([
      ["x", "number", [1]],
      ["y", "number", [2]],
    ]);
    expect(frameHasPlaces(xy)).toBe(false);
  });
});
