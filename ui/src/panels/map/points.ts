import { isRecord } from "../../api/client";
import type { DocumentSet, Edge, Field, Frame, GraphSet } from "../../api/generated/shapes";
import { valueAt } from "../../documents/paths";
import {
  DEFAULT_THRESHOLDS,
  type FieldConfig,
  fieldOptionsFor,
  thresholdStep,
} from "../fieldConfig/fieldConfig";
import { toNumber } from "../frame";
import { nodeCaption, propertyText, readNumber } from "../graph/adapter";
import { HEAT_STEPS } from "../heatmap/index";
import { type Country, type CountryIndex, looksLikeCode, suggestCountry } from "./countries";
import { decodeGeohash, isGeohash } from "./geohash";
import { basisTone, labelGroups, type MapTone, NODE_RADIUS } from "./graphStyle";
import type { EdgeMode, MapLayer } from "./options";
import { project, type World } from "./projection";
import { CODE_NAMES, findLatLonKeys, GEOHASH_NAMES, named, POINT_NAMES } from "./suggest";

/**
 * What each layer of the map shows, read from each shape as it is: rows of frames and documents
 * placed by coordinates, a point value, a geohash or a country code; nodes of a graph with a
 * `point` or two number properties, and the edges between them. Nothing is converted into
 * another shape; what has no place is counted with its reason, never dropped silently.
 */

export interface MapPoint {
  id: string;
  name: string;
  /** The legend entry: a node's first label, else the layer. */
  label: string;
  lat: number;
  lon: number;
  world: World;
  /** The number of the layer's value field, for size, colour and the tooltip. */
  value: number | null;
  tone: MapTone;
  radius: number;
}

export interface MapArea {
  id: string;
  country: Country;
  /** The data's own key ("DE", "DEU", or an alias). */
  key: string;
  value: number | null;
  tone: MapTone;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  type: string;
}

/** Why a row is not on the map. */
export type MissingReason = "noPlace" | "latRange" | "lonRange" | "geohash" | "code";

export interface MissingRow {
  id: string;
  name: string;
  reason: MissingReason;
  /** The value that did not fit, for the list ("91.2", "UK"). */
  detail: string;
}

/** A code no country has, how often it came, and the country it probably means. */
export interface UnknownCode {
  key: string;
  count: number;
  suggestion: Country | null;
}

export interface LayerData {
  index: number;
  layer: MapLayer;
  /** What the counts name: nodes of graphs, else rows and documents. */
  kind: "graph" | "rows";
  points: MapPoint[];
  areas: MapArea[];
  /** Edges whose two ends are on the map. */
  edges: MapEdge[];
  missing: MissingRow[];
  unknownCodes: UnknownCode[];
  /** Rows, documents or nodes the layer read. */
  total: number;
  /** Smallest and largest value of the value field, for the scale and the legend. */
  range: { min: number; max: number } | null;
  /** The value field's name as the data has it, for the tooltip and the legend. */
  valueName: string;
  /** The layer waits for the country areas to load. */
  waiting: boolean;
  /** Graph legend: one entry per first label. */
  labels: { label: string; tone: MapTone; count: number }[];
}

/** Unknown codes of a layer that get a suggestion. */
export const SUGGESTED_CODES = 50;

/** The largest number of points a layer places; a larger result says how many it left out. */
export const MAX_POINTS = 20_000;

/** WGS 84 in two and three dimensions; other reference systems are not geographic. */
const GEOGRAPHIC_SRIDS = new Set([4326, 4979]);

export interface LatLon {
  lat: number;
  lon: number;
}

type Placed = { place: LatLon } | { reason: MissingReason; detail: string };

function latLon(lat: unknown, lon: unknown): Placed {
  const [a, b] = [readNumber(lat), readNumber(lon)];
  if (a === null || b === null) {
    return { reason: "noPlace", detail: "" };
  }
  if (!Number.isFinite(a) || Math.abs(a) > 90) {
    return { reason: "latRange", detail: String(a) };
  }
  if (!Number.isFinite(b) || Math.abs(b) > 180) {
    return { reason: "lonRange", detail: String(b) };
  }
  return { place: { lat: a, lon: b } };
}

function placeOrNull(placed: Placed): LatLon | null {
  return "place" in placed ? placed.place : null;
}

/**
 * A place in one value: a typed `point` of a graph database (WGS 84), a GeoJSON point, an object
 * with latitude and longitude, or `POINT(lon lat)`.
 */
export function readPoint(value: unknown): LatLon | null {
  if (typeof value === "string") {
    const wkt = /^\s*POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)\s*$/i.exec(value);
    return wkt === null ? null : placeOrNull(latLon(wkt[2], wkt[1]));
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.$type === "point") {
    const srid = readNumber(value.srid);
    return srid !== null && GEOGRAPHIC_SRIDS.has(srid)
      ? placeOrNull(latLon(value.y, value.x))
      : null;
  }
  if (value.type === "Point" && Array.isArray(value.coordinates)) {
    return placeOrNull(latLon(value.coordinates[1], value.coordinates[0]));
  }
  const lat = value.latitude ?? value.lat;
  const lon = value.longitude ?? value.lon ?? value.lng;
  return lat === undefined || lon === undefined ? null : placeOrNull(latLon(lat, lon));
}

/** A row of a frame or a document, read by key. */
interface Record_ {
  id: string;
  keys: readonly string[];
  get: (key: string) => unknown;
}

/** The keys a layer reads for one source of rows, resolved once per frame or document set. */
interface Keys {
  mode: "point" | "coords" | "geohash" | "lookup" | "none";
  point?: string | undefined;
  lat?: string | undefined;
  lon?: string | undefined;
  geohash?: string | undefined;
  key?: string | undefined;
}

/** The keys of `keys` a layer uses, by its options or else by their usual names. */
export function resolveKeys(
  layer: MapLayer,
  keys: readonly string[],
  sample: (key: string) => unknown,
): Keys {
  const given = (name: string) => (name === "" ? undefined : name);
  const coordsKeys = (): Keys | null => {
    // A field named like a place ("ort", "location") counts only when its value reads as a point:
    // it often holds a city's name.
    const usual = named(keys, POINT_NAMES);
    const point =
      given(layer.pointField) ??
      (usual !== undefined && readPoint(sample(usual)) !== null ? usual : undefined);
    const pair =
      layer.latField !== "" && layer.lonField !== ""
        ? { lat: layer.latField, lon: layer.lonField }
        : findLatLonKeys(keys);
    if (point === undefined && pair === null) {
      // A point value under another name: the first key whose value reads as one.
      const found = keys.find((k) => {
        const v = sample(k);
        return typeof v !== "string" && readPoint(v) !== null;
      });
      return found === undefined ? null : { mode: "point", point: found };
    }
    return { mode: pair === null ? "point" : "coords", point, lat: pair?.lat, lon: pair?.lon };
  };
  const geohashKeys = (): Keys | null => {
    const key = given(layer.geohashField) ?? named(keys, GEOHASH_NAMES);
    return key === undefined ? null : { mode: "geohash", geohash: key };
  };
  const lookupKeys = (): Keys | null => {
    const key =
      given(layer.keyField) ??
      named(keys, CODE_NAMES) ??
      keys.find((k) => looksLikeCode(sample(k)));
    return key === undefined ? null : { mode: "lookup", key };
  };
  const none: Keys = { mode: "none" };
  switch (layer.kind === "areas" ? "lookup" : layer.place) {
    case "coords":
      return coordsKeys() ?? none;
    case "geohash":
      return geohashKeys() ?? none;
    case "lookup":
      return lookupKeys() ?? none;
    default:
      // Auto: coordinates first, then a geohash, then a code, each found by name.
      return (
        coordsKeys() ??
        geohashKeys() ??
        (named(keys, CODE_NAMES) === undefined ? null : lookupKeys()) ??
        none
      );
  }
}

type Located =
  | { place: LatLon; country?: Country; key?: string }
  | { reason: MissingReason; detail: string; key?: string };

function locate(
  record: Record_,
  keys: Keys,
  layer: MapLayer,
  countries: CountryIndex | null,
): Located {
  switch (keys.mode) {
    case "point":
    case "coords": {
      if (keys.point !== undefined) {
        const point = readPoint(record.get(keys.point));
        if (point !== null) return { place: point };
      }
      if (keys.lat !== undefined && keys.lon !== undefined) {
        return latLon(record.get(keys.lat), record.get(keys.lon));
      }
      return { reason: "noPlace", detail: "" };
    }
    case "geohash": {
      const raw = keys.geohash === undefined ? undefined : record.get(keys.geohash);
      if (raw === null || raw === undefined || raw === "") {
        return { reason: "noPlace", detail: "" };
      }
      const text = String(raw).trim();
      const place = isGeohash(text) ? decodeGeohash(text) : null;
      return place === null ? { reason: "geohash", detail: text } : { place };
    }
    case "lookup": {
      const raw = keys.key === undefined ? undefined : record.get(keys.key);
      if (raw === null || raw === undefined || String(raw).trim() === "") {
        return { reason: "noPlace", detail: "" };
      }
      const key = String(raw).trim();
      const code = Object.hasOwn(layer.aliases, key)
        ? (layer.aliases[key] as string)
        : key.toUpperCase();
      const country = countries?.byCode.get(code);
      return country === undefined
        ? { reason: "code", detail: key, key }
        : { place: { lat: country.lat, lon: country.lon }, country, key };
    }
    default:
      return { reason: "noPlace", detail: "" };
  }
}

const ROW_NAME_KEYS = ["name", "title", "label", "city", "stadt", "ort", "id"];

/** Radius of a point whose value runs from `min` to `max`, by area between the layer's sizes. */
function sizedRadius(
  value: number | null,
  range: { min: number; max: number } | null,
  layer: MapLayer,
): number {
  if (value === null || range === null || !(range.max > range.min)) {
    return layer.valueField === "" ? NODE_RADIUS : (layer.sizeFrom + layer.sizeTo) / 2;
  }
  const share = Math.sqrt(Math.max(0, (value - range.min) / (range.max - range.min)));
  return layer.sizeFrom + (layer.sizeTo - layer.sizeFrom) * share;
}

/** Step of the light-to-dark scale (1 to `HEAT_STEPS`) for a value in `range`. */
export function scaleStep(value: number, range: { min: number; max: number }): number {
  if (!(range.max > range.min)) return HEAT_STEPS;
  const share = (value - range.min) / (range.max - range.min);
  return Math.min(HEAT_STEPS, Math.max(1, Math.ceil(share * HEAT_STEPS) || 1));
}

function toneOf(
  layer: MapLayer,
  index: number,
  value: number | null,
  range: { min: number; max: number } | null,
  config: FieldConfig,
  field: Field | undefined,
): MapTone {
  if (layer.color === "single" || value === null) {
    return layer.color === "single" ? (index % 8) + 1 : null;
  }
  if (layer.color === "thresholds") {
    const options = field === undefined ? config.defaults : fieldOptionsFor(field, config);
    const step = thresholdStep(
      value,
      options.thresholds ?? DEFAULT_THRESHOLDS,
      range ?? { min: 0, max: 100 },
    );
    return { tone: step.tone };
  }
  return range === null ? { heat: HEAT_STEPS } : { heat: scaleStep(value, range) };
}

/** The rows a layer reads, from the frames and document sets it is set to. */
function rowSources(
  frames: readonly Frame[],
  documents: readonly DocumentSet[],
  result: number,
): { prefix: string; records: Record_[]; field: (key: string) => Field | undefined }[] {
  const sources: {
    prefix: string;
    records: Record_[];
    field: (key: string) => Field | undefined;
  }[] = [];
  frames.forEach((frame, n) => {
    if (result !== 0 && result !== n + 1) return;
    const keys = frame.fields.map((f) => f.name);
    const byName = new Map(frame.fields.map((f) => [f.name, f]));
    const rows = frame.fields.reduce((most, f) => Math.max(most, f.values.length), 0);
    const records: Record_[] = [];
    for (let row = 0; row < rows; row++) {
      records.push({
        id: `f${n}:${row}`,
        keys,
        get: (key) => byName.get(key)?.values[row],
      });
    }
    sources.push({ prefix: `f${n}`, records, field: (key) => byName.get(key) });
  });
  documents.forEach((set, n) => {
    if (result !== 0 && result !== frames.length + n + 1) return;
    const records = set.documents.map((document, row) => ({
      id: `d${n}:${row}`,
      keys: isRecord(document) ? Object.keys(document) : [],
      get: (key: string) => valueAt(document, key),
    }));
    sources.push({ prefix: `d${n}`, records, field: () => undefined });
  });
  return sources;
}

function rowLayer(
  layer: MapLayer,
  index: number,
  input: { frames: readonly Frame[]; documents: readonly DocumentSet[] },
  config: FieldConfig,
  countries: CountryIndex | null,
): LayerData {
  const out = emptyLayer(layer, index, "rows");
  const sources = rowSources(input.frames, input.documents, layer.result);
  // The value field's range over every row the layer reads, for sizes and the scale.
  let [min, max] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const valueKey = layer.valueField;
  if (valueKey !== "") {
    for (const { records } of sources) {
      for (const record of records) {
        const v = toNumber(record.get(valueKey));
        if (v !== null) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
  }
  out.range = Number.isFinite(min) ? { min, max } : null;
  out.valueName = valueKey;
  const unknown = new Map<string, number>();
  const areas = new Map<string, MapArea>();
  for (const { records, field } of sources) {
    const first = records[0];
    if (first === undefined) continue;
    const sample = (key: string) =>
      records
        .slice(0, 20)
        .map((r) => r.get(key))
        .find((v) => v !== null && v !== undefined);
    const keys = resolveKeys(layer, first.keys, sample);
    if (keys.mode === "lookup" && countries === null) {
      out.waiting = true;
    }
    // The name of a place: the layer's caption, a usual name field, the code it was looked up
    // by, else the first text field ("region"); the row number only when there is none.
    const captionKey =
      layer.caption !== ""
        ? layer.caption
        : (named(first.keys, ROW_NAME_KEYS) ??
          keys.key ??
          first.keys.find((k) => k !== keys.geohash && typeof sample(k) === "string") ??
          "");
    const valueField = valueKey === "" ? undefined : field(valueKey);
    for (const record of records) {
      out.total++;
      const name = (captionKey === "" ? "" : propertyText(record.get(captionKey))) || "";
      const value = valueKey === "" ? null : toNumber(record.get(valueKey));
      const found = locate(record, keys, layer, countries);
      if (!("place" in found)) {
        if (found.reason === "code" && countries === null) {
          // Not known yet: the areas are still loading.
          out.total--;
          continue;
        }
        out.missing.push({
          id: record.id,
          name: name || `${out.total}`,
          reason: found.reason,
          detail: found.detail,
        });
        if (found.reason === "code" && found.key !== undefined) {
          unknown.set(found.key, (unknown.get(found.key) ?? 0) + 1);
        }
        continue;
      }
      const tone = toneOf(layer, index, value, out.range, config, valueField);
      if (layer.kind === "areas") {
        const country = (found as { country?: Country }).country;
        if (country === undefined) continue;
        // Several rows of one country: the areas show the sum of their values.
        const kept = areas.get(country.alpha2);
        if (kept === undefined) {
          areas.set(country.alpha2, {
            id: `${index}:${country.alpha2}`,
            country,
            key: (found as { key?: string }).key ?? country.alpha2,
            value,
            tone,
          });
        } else if (value !== null) {
          kept.value = (kept.value ?? 0) + value;
        }
        continue;
      }
      if (out.points.length >= MAX_POINTS) continue;
      out.points.push({
        id: record.id,
        name: name || (found as { key?: string }).key || `${out.total}`,
        label: String(index),
        ...found.place,
        world: project(found.place.lat, found.place.lon),
        value,
        tone,
        radius: sizedRadius(value, out.range, layer),
      });
    }
  }
  out.areas = [...areas.values()];
  if (out.areas.some((a) => a.value !== null)) {
    // Summed values make the range of the areas themselves.
    const values = out.areas.flatMap((a) => (a.value === null ? [] : [a.value]));
    out.range = { min: Math.min(...values), max: Math.max(...values) };
    for (const area of out.areas) {
      const valueField = sources[0]?.field(valueKey);
      area.tone = toneOf(layer, index, area.value, out.range, config, valueField);
    }
  }
  // Suggestions for the first unknown keys only: the hint names three, the button adds a few.
  out.unknownCodes = [...unknown.entries()].map(([key, count], at) => ({
    key,
    count,
    suggestion: countries === null || at >= SUGGESTED_CODES ? null : suggestCountry(key, countries),
  }));
  return out;
}

function graphLayer(
  layer: MapLayer,
  index: number,
  graphs: readonly GraphSet[],
  edgeMode: EdgeMode,
): LayerData {
  const out = emptyLayer(layer, index, "graph");
  const nodes = new Map(graphs.flatMap((g) => g.nodes).map((node) => [node.id, node]));
  // Each edge once, as first met (results of several queries can repeat one).
  const edges = new Map<string, Edge>();
  for (const edge of graphs.flatMap((g) => g.edges)) {
    if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }
  const groups = labelGroups([...nodes.values()]);
  const placed = new Set<string>();
  const counts = new Map<string, { label: string; tone: MapTone; count: number }>();
  for (const node of nodes.values()) {
    const name = nodeCaption(node, layer.caption);
    const label = node.labels[0] ?? "";
    const record: Record_ = {
      id: node.id,
      keys: Object.keys(node.properties),
      get: (key) => node.properties[key],
    };
    const keys = resolveKeys(
      { ...layer, place: layer.place === "lookup" ? "auto" : layer.place },
      record.keys,
      record.get,
    );
    const found = locate(record, keys, layer, null);
    out.total++;
    if (!("place" in found)) {
      out.missing.push({ id: node.id, name, reason: found.reason, detail: found.detail });
      continue;
    }
    if (out.points.length >= MAX_POINTS) continue;
    const tone = basisTone(node, groups);
    out.points.push({
      id: node.id,
      name,
      label,
      ...found.place,
      world: project(found.place.lat, found.place.lon),
      value: null,
      tone,
      radius: NODE_RADIUS,
    });
    placed.add(node.id);
    const entry = counts.get(label) ?? { label, tone, count: 0 };
    entry.count++;
    counts.set(label, entry);
  }
  out.labels = [...counts.values()];
  if (edgeMode !== "none") {
    for (const edge of edges.values()) {
      if (placed.has(edge.from) && placed.has(edge.to)) {
        out.edges.push({ id: edge.id, from: edge.from, to: edge.to, type: edge.type });
      }
    }
  }
  return out;
}

function emptyLayer(layer: MapLayer, index: number, kind: "graph" | "rows"): LayerData {
  return {
    index,
    layer,
    kind,
    points: [],
    areas: [],
    edges: [],
    missing: [],
    unknownCodes: [],
    total: 0,
    range: null,
    valueName: "",
    waiting: false,
    labels: [],
  };
}

/**
 * Everything each layer places. A points layer over a panel with graphs draws the graph on the
 * map; otherwise layers read rows of frames and documents. Areas read rows only.
 */
export function mapLayers(
  input: {
    frames: readonly Frame[];
    documents?: readonly DocumentSet[] | undefined;
    graphs?: readonly GraphSet[] | undefined;
  },
  layers: readonly MapLayer[],
  config: FieldConfig,
  countries: CountryIndex | null,
  edges: EdgeMode = "straight",
): LayerData[] {
  const graphs = input.graphs ?? [];
  const rows = { frames: input.frames, documents: input.documents ?? [] };
  return layers.map((layer, index) =>
    layer.kind === "points" && graphs.length > 0
      ? graphLayer(layer, index, graphs, edges)
      : rowLayer(layer, index, rows, config, countries),
  );
}

/** Whether any layer looks codes up, so the map loads the country areas. */
export function needsCountries(
  layers: readonly MapLayer[],
  input: { frames: readonly Frame[]; documents?: readonly DocumentSet[] | undefined },
): boolean {
  return layers.some((layer) => {
    if (layer.kind === "areas" || layer.place === "lookup") return true;
    if (layer.place !== "auto") return false;
    // Auto finds a code field by name; only then are the areas needed.
    const names = [
      ...input.frames.flatMap((f) => f.fields.map((field) => field.name)),
      ...(input.documents ?? []).flatMap((set) => {
        const first = set.documents[0];
        return isRecord(first) ? Object.keys(first) : [];
      }),
    ];
    return (
      named(names, CODE_NAMES) !== undefined &&
      findLatLonKeys(names) === null &&
      named(names, POINT_NAMES) === undefined &&
      named(names, GEOHASH_NAMES) === undefined
    );
  });
}

/** Ways to place rows that the data offers, for the hint when nothing is on the map. */
export interface PlaceCandidates {
  coords: { lat: string; lon: string } | null;
  geohash: string | null;
  code: string | null;
}

function textFields(frames: readonly Frame[]): Field[] {
  return frames.flatMap((f) => f.fields.filter((field) => field.type === "string"));
}

/**
 * Looks at the values themselves: a text field whose values are mostly geohashes or country
 * codes, two number fields within the ranges of latitude and longitude. Used only to offer a
 * choice; the layer changes when someone picks it.
 */
export function placeCandidates(
  frames: readonly Frame[],
  countries: CountryIndex | null,
): PlaceCandidates {
  const mostly = (field: Field, test: (v: unknown) => boolean) => {
    const values = field.values.filter((v) => v !== null && v !== undefined && v !== "");
    const sample = values.slice(0, 200);
    return sample.length > 0 && sample.filter(test).length * 4 >= sample.length * 3;
  };
  const texts = textFields(frames);
  const code =
    texts.find((f) =>
      mostly(f, (v) => looksLikeCode(v) && (countries?.byCode.has(v.trim().toUpperCase()) ?? true)),
    )?.name ?? null;
  const geohash =
    texts.find((f) => f.name !== code && mostly(f, (v) => isGeohash(v) && String(v).length >= 4))
      ?.name ?? null;
  let coords: { lat: string; lon: string } | null = null;
  for (const frame of frames) {
    const numbers = frame.fields.filter((f) => ["number", "int64", "decimal"].includes(f.type));
    const inRange = (f: Field, limit: number) =>
      mostly(f, (v) => {
        const n = toNumber(v);
        return n !== null && Math.abs(n) <= limit && !Number.isInteger(n);
      });
    const lat = numbers.find((f) => inRange(f, 90));
    const lon = numbers.find((f) => f !== lat && inRange(f, 180));
    if (lat !== undefined && lon !== undefined) {
      coords = { lat: lat.name, lon: lon.name };
      break;
    }
  }
  return { coords, geohash, code };
}
