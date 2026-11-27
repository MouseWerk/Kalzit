import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Frame, GraphSet } from "../../api/generated/shapes";
import { EMPTY_FIELD_CONFIG } from "../fieldConfig/fieldConfig";
import { clusterEdges, clusterPoints } from "./cluster";
import { decodeCountries, suggestCountry } from "./countries";
import { decodeGeohash, isGeohash } from "./geohash";
import { MAX_LAYERS, newLayer, parseMapOptions } from "./options";
import { decodeOutlines, OutlineError } from "./outlines";
import { mapLayers, needsCountries, placeCandidates, readPoint, scaleStep } from "./points";
import { fitView, project, worldView } from "./projection";
import { frameHasPlaces, graphHasPlaces } from "./suggest";

const SIZE = { width: 640, height: 400 };
const COUNTRIES = decodeCountries(
  new Uint8Array(readFileSync(resolve(import.meta.dirname, "outlines/countries.kzc"))),
);

const frame = (fields: [string, string, unknown[]][]): Frame =>
  ({
    fields: fields.map(([name, type, values]) => ({ name, type, values })),
  }) as unknown as Frame;

const point = (lat: number, lon: number) => ({ $type: "point", srid: 4326, x: lon, y: lat });

/** Umsatz je Stadt (board frame 3), with the two rows of frame 5 that have no place. */
const CITIES = frame([
  ["stadt", "string", ["Berlin", "Paris", "Lager Süd", "Testfiliale"]],
  ["lat", "number", [52.52, 48.86, null, 91.2]],
  ["lon", "number", [13.4, 2.35, null, 13.4]],
  ["umsatz", "number", [48_200, 12_000, 5, 7]],
]);

const COUNTRY_SALES = frame([
  ["land", "string", ["DE", "FRA", "UK", "XX"]],
  ["umsatz", "number", [117_133, 56_020, 30_000, 1]],
]);

const layers = (...kinds: Parameters<typeof newLayer>[0][]) => kinds.map(newLayer);

describe("map options", () => {
  it("start with one points layer and keep bounds", () => {
    const options = parseMapOptions({});
    expect(options.layers).toEqual([newLayer("points")]);
    expect(options.outlines).toBe("regions");
    expect(options.tooltip.mode).toBe("all");
    const wild = parseMapOptions({
      layers: Array.from({ length: 6 }, () => ({
        kind: "areas",
        place: "coords",
        color: "single",
        result: 99,
        sizeFrom: 30,
        sizeTo: 3,
        aliases: { UK: "GB", bad: "not a code", "": "DE" },
      })),
      clusterDistance: 500,
    });
    expect(wild.layers).toHaveLength(MAX_LAYERS);
    const [first] = wild.layers;
    // Areas are always looked up and coloured by value; sizes stay ordered.
    expect(first?.place).toBe("lookup");
    expect(first?.color).toBe("scale");
    expect(first?.result).toBe(0);
    expect([first?.sizeFrom, first?.sizeTo]).toEqual([3, 30]);
    expect(first?.aliases).toEqual({ UK: "GB" });
    expect(wild.clusterDistance).toBe(12);
  });
});

describe("places", () => {
  it("read points of every common form", () => {
    expect(readPoint(point(52.5, 13.4))).toEqual({ lat: 52.5, lon: 13.4 });
    expect(readPoint({ type: "Point", coordinates: [2.35, 48.86] })).toEqual({
      lat: 48.86,
      lon: 2.35,
    });
    expect(readPoint("POINT(13.4 52.5)")).toEqual({ lat: 52.5, lon: 13.4 });
    expect(readPoint({ lat: 91, lon: 0 })).toBeNull();
    expect(readPoint({ $type: "point", srid: 7203, x: 1, y: 2 })).toBeNull();
  });

  it("decode geohash cells to their middle", () => {
    const berlin = decodeGeohash("u33db");
    expect(berlin?.lat).toBeCloseTo(52.5, 0);
    expect(berlin?.lon).toBeCloseTo(13.4, 0);
    expect(isGeohash("u09tv")).toBe(true);
    expect(isGeohash("ua!")).toBe(false);
    expect(isGeohash("abc")).toBe(false);
    expect(decodeGeohash("toolongforagh")).toBeNull();
  });

  it("know every country by its two and three letter code", () => {
    expect(COUNTRIES.countries.length).toBeGreaterThan(200);
    const germany = COUNTRIES.byCode.get("DE");
    expect(germany?.alpha3).toBe("DEU");
    expect(COUNTRIES.byCode.get("DEU")).toBe(germany);
    // The middle of the largest part: mainland France, not French Guiana.
    const france = COUNTRIES.byCode.get("FR");
    expect(france?.lat).toBeGreaterThan(42);
    expect(france?.lon).toBeGreaterThan(-5);
    expect(france?.path.startsWith("M")).toBe(true);
    expect(() => decodeCountries(new Uint8Array([1, 2, 3]))).toThrow(OutlineError);
    expect(() => decodeOutlines(new Uint8Array(16))).toThrow(OutlineError);
  });

  it("suggest the country a key probably means, by alias or by name", () => {
    expect(suggestCountry("UK", COUNTRIES)?.alpha2).toBe("GB");
    expect(suggestCountry("Deutschland", COUNTRIES)?.alpha2).toBe("DE");
    expect(suggestCountry("Germany", COUNTRIES)?.alpha2).toBe("DE");
    expect(suggestCountry("XX", COUNTRIES)).toBeNull();
  });
});

describe("points layer", () => {
  it("places rows by coordinates and names each row without a place with its reason", () => {
    const [data] = mapLayers(
      { frames: [CITIES] },
      [{ ...newLayer("points"), valueField: "umsatz" }],
      EMPTY_FIELD_CONFIG,
      null,
    );
    expect(data?.total).toBe(4);
    expect(data?.points.map((p) => p.name)).toEqual(["Berlin", "Paris"]);
    expect(data?.missing.map((m) => [m.name, m.reason, m.detail])).toEqual([
      ["Lager Süd", "noPlace", ""],
      ["Testfiliale", "latRange", "91.2"],
    ]);
    // Size by value, between the layer's sizes (by area).
    const [berlin, paris] = data?.points ?? [];
    expect(berlin?.radius).toBe(16);
    expect(paris?.radius).toBeGreaterThan(4);
    expect(paris?.radius).toBeLessThan(16);
    expect(data?.range).toEqual({ min: 5, max: 48_200 });
  });

  it("names a place by the first text field when no usual name field is there", () => {
    const regions = frame([
      ["region", "string", ["Nord", "Süd"]],
      ["lat", "number", [53.55, 48.14]],
      ["lon", "number", [9.99, 11.58]],
    ]);
    const [data] = mapLayers({ frames: [regions] }, layers("points"), EMPTY_FIELD_CONFIG, null);
    expect(data?.points.map((p) => p.name)).toEqual(["Nord", "Süd"]);
  });

  it("places rows by geohash, and by country code at the middle of the country", () => {
    const cells = frame([
      ["zelle", "string", ["u33db", "u09tv", "nope!"]],
      ["umsatz", "number", [48_215, 44_020, 1]],
    ]);
    const [geo] = mapLayers({ frames: [cells] }, layers("points"), EMPTY_FIELD_CONFIG, null);
    expect(geo?.points).toHaveLength(2);
    expect(geo?.missing[0]).toMatchObject({ reason: "geohash", detail: "nope!" });
    const [byCode] = mapLayers(
      { frames: [COUNTRY_SALES] },
      layers("points"),
      EMPTY_FIELD_CONFIG,
      COUNTRIES,
    );
    expect(byCode?.points.map((p) => p.name)).toEqual(["DE", "FRA"]);
    expect(byCode?.unknownCodes.map((c) => [c.key, c.suggestion?.alpha2 ?? null])).toEqual([
      ["UK", "GB"],
      ["XX", null],
    ]);
  });

  it("draws a graph's nodes and the edges between placed nodes", () => {
    const graph = {
      nodes: [
        { id: "a", labels: ["Lager"], properties: { name: "Nord", standort: point(53.5, 10) } },
        { id: "b", labels: ["Kunde"], properties: { name: "Süd", standort: point(48.1, 11.6) } },
        { id: "c", labels: ["Kunde"], properties: { name: "Ohne" } },
      ],
      edges: [
        { id: "e1", type: "LIEFERT", from: "a", to: "b", properties: {} },
        { id: "e2", type: "LIEFERT", from: "a", to: "c", properties: {} },
      ],
    } as unknown as GraphSet;
    const [data] = mapLayers(
      { frames: [], graphs: [graph] },
      layers("points"),
      EMPTY_FIELD_CONFIG,
      null,
    );
    expect(data?.kind).toBe("graph");
    expect(data?.points).toHaveLength(2);
    expect(data?.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(data?.labels.map((l) => l.label).sort()).toEqual(["Kunde", "Lager"]);
    const none = mapLayers(
      { frames: [], graphs: [graph] },
      layers("points"),
      EMPTY_FIELD_CONFIG,
      null,
      "none",
    );
    expect(none[0]?.edges).toEqual([]);
  });
});

describe("areas layer", () => {
  it("fills countries by code, adds up rows of one country and counts unknown codes", () => {
    const twice = frame([
      ["country", "string", ["DE", "DEU", "FR", "UK"]],
      ["umsatz", "number", [100, 50, 30, 10]],
    ]);
    const [areas] = mapLayers(
      { frames: [twice] },
      [{ ...newLayer("areas"), valueField: "umsatz" }],
      EMPTY_FIELD_CONFIG,
      COUNTRIES,
    );
    expect(areas?.areas.map((a) => [a.country.alpha2, a.value])).toEqual([
      ["DE", 150],
      ["FR", 30],
    ]);
    expect(areas?.range).toEqual({ min: 30, max: 150 });
    expect(areas?.areas[0]?.tone).toEqual({ heat: 8 });
    expect(areas?.areas[1]?.tone).toEqual({ heat: 1 });
    expect(areas?.unknownCodes).toHaveLength(1);
  });

  it("applies the layer's own code pairs and the panel's thresholds", () => {
    const config = {
      defaults: {
        thresholds: {
          mode: "absolute" as const,
          steps: [
            { value: null, tone: "ok" as const },
            { value: 50_000, tone: "critical" as const },
          ],
        },
      },
      overrides: [],
    };
    const [areas] = mapLayers(
      { frames: [COUNTRY_SALES] },
      [{ ...newLayer("areas"), valueField: "umsatz", color: "thresholds", aliases: { UK: "GB" } }],
      config,
      COUNTRIES,
    );
    expect(areas?.areas.map((a) => [a.country.alpha2, a.tone])).toEqual([
      ["DE", { tone: "critical" }],
      ["FR", { tone: "critical" }],
      ["GB", { tone: "ok" }],
    ]);
    expect(areas?.unknownCodes.map((c) => c.key)).toEqual(["XX"]);
  });

  it("waits for the country areas without calling a code unknown", () => {
    const [areas] = mapLayers(
      { frames: [COUNTRY_SALES] },
      layers("areas"),
      EMPTY_FIELD_CONFIG,
      null,
    );
    expect(areas?.waiting).toBe(true);
    expect(areas?.missing).toEqual([]);
    expect(needsCountries(layers("areas"), { frames: [] })).toBe(true);
    expect(needsCountries(layers("points"), { frames: [CITIES] })).toBe(false);
    expect(needsCountries(layers("points"), { frames: [COUNTRY_SALES] })).toBe(true);
  });

  it("reads only the result a layer is set to", () => {
    const [both, second] = mapLayers(
      { frames: [CITIES, COUNTRY_SALES] },
      [newLayer("points"), { ...newLayer("areas"), result: 2 }],
      EMPTY_FIELD_CONFIG,
      COUNTRIES,
    );
    expect(both?.total).toBe(8);
    expect(second?.total).toBe(4);
    expect(second?.areas).toHaveLength(2);
  });
});

describe("hints and suggestions", () => {
  it("offer the fields the values look like", () => {
    const odd = frame([
      ["x1", "number", [52.52, 48.86]],
      ["x2", "number", [13.41, 2.35]],
      ["cellname", "string", ["u33db", "u09tv"]],
      ["nation", "string", ["DE", "FR"]],
    ]);
    expect(placeCandidates([odd], COUNTRIES)).toEqual({
      coords: { lat: "x1", lon: "x2" },
      geohash: "cellname",
      code: "nation",
    });
  });

  it("know frames and graphs with places", () => {
    expect(frameHasPlaces(CITIES)).toBe(true);
    expect(frameHasPlaces(COUNTRY_SALES)).toBe(false);
    expect(
      graphHasPlaces({
        nodes: [{ id: "a", labels: [], properties: { p: point(1, 2) } }],
        edges: [],
      } as unknown as GraphSet),
    ).toBe(true);
  });

  it("step the scale from light to dark", () => {
    expect(scaleStep(0, { min: 0, max: 100 })).toBe(1);
    expect(scaleStep(100, { min: 0, max: 100 })).toBe(8);
    expect(scaleStep(5, { min: 5, max: 5 })).toBe(8);
  });
});

describe("view and bundles", () => {
  it("fits the data and bundles near points", () => {
    const [data] = mapLayers({ frames: [CITIES] }, layers("points"), EMPTY_FIELD_CONFIG, null);
    const points = data?.points ?? [];
    const view = fitView(
      points.map((p) => p.world),
      SIZE,
    );
    expect(view.zoom).toBeGreaterThan(3);
    const far = worldView(SIZE);
    // Zoomed out to the world, Berlin and Paris lie within 40 px and form one bundle.
    expect(clusterPoints(points, far, SIZE, 40)).toHaveLength(1);
    expect(clusterPoints(points, view, SIZE, 12)).toHaveLength(2);
    expect(clusterEdges([], [])).toEqual([]);
    expect(project(0, 0)).toEqual({ x: 0.5, y: 0.5 });
  });
});
