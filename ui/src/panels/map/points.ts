import { isRecord } from "../../api/client";
import type { DocumentSet, Edge, Frame, GraphSet } from "../../api/generated/shapes";
import { valueAt } from "../../documents/paths";
import { toNumber } from "../frame";
import { nodeCaption, propertyText, readNumber } from "../graph/adapter";
import {
  basisTone,
  edgeStyle,
  evaluateMapStyle,
  labelGroups,
  type MapTone,
  NODE_RADIUS,
  nodeStyle,
} from "./graphStyle";
import type { MapOptions } from "./options";
import { isCoordinate, project, type World } from "./projection";
import { findLatLonKeys, named, POINT_NAMES } from "./suggest";

/**
 * What the map shows of a result, read from each shape as it is: nodes of a graph with a
 * `point` or two number properties (and the edges between them), documents with a GeoJSON point
 * or two number fields, rows of a frame with latitude and longitude. Nothing is converted into
 * another shape; what has no place is counted and named, never dropped silently.
 */

export interface MapPoint {
  id: string;
  name: string;
  /** The legend entry it belongs to: a node's first label, a frame's or set's position. */
  label: string;
  lat: number;
  lon: number;
  world: World;
  /** Its tone: the palette color of its label or a style rule's color (graphStyle.ts). */
  tone: MapTone;
  /** The tone of its legend entry: the basis, which a rule's color does not change. */
  labelTone: MapTone;
  radius: number;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  dashed: boolean;
  width: number;
  /** A style rule's color; null draws the edges' own tone. */
  tone: MapTone;
}

export interface MapData {
  /** What the counts name: nodes of graphs, else rows and documents. */
  kind: "graph" | "rows";
  points: MapPoint[];
  /** Edges whose two ends are on the map. */
  edges: MapEdge[];
  /** Nodes, rows or documents without a place, by name, in result order. */
  missing: { id: string; name: string; label: string }[];
  /** All nodes, rows or documents of the result. */
  total: number;
  /** Edges of the result, on the map or not. */
  totalEdges: number;
  legend: { label: string; tone: MapTone; count: number }[];
}

/** The largest number of points the map places; a larger result says how many it left out. */
export const MAX_POINTS = 20_000;

/** WGS 84 in two and three dimensions; other reference systems are not geographic. */
const GEOGRAPHIC_SRIDS = new Set([4326, 4979]);

export interface LatLon {
  lat: number;
  lon: number;
}

function latLon(lat: unknown, lon: unknown): LatLon | null {
  const [a, b] = [readNumber(lat), readNumber(lon)];
  return a !== null && b !== null && isCoordinate(a, b) ? { lat: a, lon: b } : null;
}

/**
 * A place in one value: a typed `point` of a graph database (WGS 84), a GeoJSON point, an object
 * with latitude and longitude, or `POINT(lon lat)`.
 */
export function readPoint(value: unknown): LatLon | null {
  if (typeof value === "string") {
    const wkt = /^\s*POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)\s*$/i.exec(value);
    return wkt === null ? null : latLon(wkt[2], wkt[1]);
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.$type === "point") {
    const srid = readNumber(value.srid);
    return srid !== null && GEOGRAPHIC_SRIDS.has(srid) ? latLon(value.y, value.x) : null;
  }
  if (value.type === "Point" && Array.isArray(value.coordinates)) {
    return latLon(value.coordinates[1], value.coordinates[0]);
  }
  const lat = value.latitude ?? value.lat;
  const lon = value.longitude ?? value.lon ?? value.lng;
  return lat === undefined || lon === undefined ? null : latLon(lat, lon);
}

/** The place of a record (a node's properties, a document) under the panel's options. */
export function placeOf(
  record: Record<string, unknown>,
  options: MapOptions,
  get: (key: string) => unknown = (key) => record[key],
): LatLon | null {
  const keys = Object.keys(record);
  if (options.coords !== "latLon") {
    if (options.pointField !== "") {
      const point = readPoint(get(options.pointField));
      if (point !== null || options.coords === "point") {
        return point;
      }
    } else {
      const usual = named(keys, POINT_NAMES);
      const candidates = usual === undefined ? keys : [usual, ...keys.filter((k) => k !== usual)];
      for (const key of candidates) {
        // Text is only read as a point where the options name the field.
        const value = record[key];
        const point = typeof value === "string" ? null : readPoint(value);
        if (point !== null) {
          return point;
        }
      }
      if (options.coords === "point") {
        return null;
      }
    }
  }
  if (options.latField !== "" && options.lonField !== "") {
    return latLon(get(options.latField), get(options.lonField));
  }
  const pair = findLatLonKeys(keys);
  return pair === null ? null : latLon(record[pair.lat], record[pair.lon]);
}

function point(
  id: string,
  name: string,
  label: string,
  place: LatLon,
  tone: MapTone,
  radius: number,
  labelTone: MapTone = tone,
): MapPoint {
  return {
    id,
    name,
    label,
    ...place,
    world: project(place.lat, place.lon),
    tone,
    labelTone,
    radius,
  };
}

const ROW_NAME_KEYS = ["name", "title", "label", "city", "stadt", "ort", "id"];

/** Radius of a row point whose size column runs from `min` to `max`. */
function sizedRadius(value: number | null, min: number, max: number): number {
  if (value === null || !(max > min)) {
    return NODE_RADIUS;
  }
  return 4 + 10 * Math.sqrt((value - min) / (max - min));
}

function framePoints(frame: Frame, index: number, options: MapOptions, out: MapData): void {
  const names = frame.fields.map((f) => f.name);
  const field = (name: string) => frame.fields.find((f) => f.name === name);
  const pair =
    options.latField !== "" && options.lonField !== ""
      ? { lat: options.latField, lon: options.lonField }
      : findLatLonKeys(names);
  const latField = pair === null ? undefined : field(pair.lat);
  const lonField = pair === null ? undefined : field(pair.lon);
  const pointField =
    options.coords === "latLon"
      ? undefined
      : field(options.pointField !== "" ? options.pointField : (named(names, POINT_NAMES) ?? ""));
  const captionKey = options.caption !== "" ? options.caption : (named(names, ROW_NAME_KEYS) ?? "");
  const captionField = field(captionKey);
  const sizeField = options.sizeField === "" ? undefined : field(options.sizeField);
  let [min, max] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const raw of sizeField?.values ?? []) {
    const v = toNumber(raw);
    if (v !== null) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  const rows = frame.fields.reduce((n, f) => Math.max(n, f.values.length), 0);
  const label = String(index);
  const tone = (index % 8) + 1;
  for (let row = 0; row < rows; row++) {
    const id = `f${index}:${row}`;
    const name = propertyText(captionField?.values[row]) || `${row + 1}`;
    let place = pointField === undefined ? null : readPoint(pointField.values[row]);
    if (place === null && options.coords !== "point" && latField && lonField) {
      place = latLon(toNumber(latField.values[row]), toNumber(lonField.values[row]));
    }
    out.total++;
    if (place === null) {
      out.missing.push({ id, name, label });
    } else if (out.points.length < MAX_POINTS) {
      const size = sizeField === undefined ? null : toNumber(sizeField.values[row]);
      out.points.push(point(id, name, label, place, tone, sizedRadius(size, min, max)));
    }
  }
}

function documentPoints(set: DocumentSet, index: number, options: MapOptions, out: MapData): void {
  const label = String(index);
  const tone = (index % 8) + 1;
  set.documents.forEach((document, row) => {
    const id = `d${index}:${row}`;
    const record = isRecord(document) ? document : {};
    const captionKey =
      options.caption !== "" ? options.caption : (named(Object.keys(record), ROW_NAME_KEYS) ?? "");
    const name =
      (captionKey === "" ? "" : propertyText(valueAt(document, captionKey))) || `${row + 1}`;
    const place = placeOf(record, options, (key) => valueAt(document, key));
    out.total++;
    if (place === null) {
      out.missing.push({ id, name, label });
    } else if (out.points.length < MAX_POINTS) {
      out.points.push(point(id, name, label, place, tone, NODE_RADIUS));
    }
  });
}

function graphPoints(graphs: readonly GraphSet[], options: MapOptions, out: MapData): void {
  const nodes = new Map(graphs.flatMap((g) => g.nodes).map((node) => [node.id, node]));
  // Each edge once, as first met (results of several queries can repeat one).
  const edges = new Map<string, Edge>();
  for (const edge of graphs.flatMap((g) => g.edges)) {
    if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }
  const groups = labelGroups([...nodes.values()]);
  const looks = evaluateMapStyle(options.style, [...nodes.values()], [...edges.values()]);
  const placed = new Set<string>();
  let at = -1;
  for (const node of nodes.values()) {
    at++;
    const name = nodeCaption(node, options.caption);
    const label = node.labels[0] ?? "";
    const place = placeOf(node.properties, options);
    out.total++;
    if (place === null) {
      out.missing.push({ id: node.id, name, label });
    } else if (out.points.length < MAX_POINTS) {
      const style = nodeStyle(node, groups, looks.nodes[at] ?? null);
      out.points.push(
        point(node.id, name, label, place, style.tone, style.radius, basisTone(node, groups)),
      );
      placed.add(node.id);
    }
  }
  let edgeAt = -1;
  for (const edge of edges.values()) {
    edgeAt++;
    out.totalEdges++;
    if (options.edges !== "none" && placed.has(edge.from) && placed.has(edge.to)) {
      const style = edgeStyle(edge, looks.edges[edgeAt] ?? null);
      out.edges.push({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        type: edge.type,
        dashed: style.dashed,
        width: style.width,
        tone: style.tone,
      });
    }
  }
}

/**
 * Everything the map places. Graphs win when a panel has them (the map is then the graph on a
 * map); otherwise rows of frames and documents are points.
 */
export function mapData(
  input: {
    frames: readonly Frame[];
    documents?: readonly DocumentSet[] | undefined;
    graphs?: readonly GraphSet[] | undefined;
  },
  options: MapOptions,
): MapData {
  const graphs = input.graphs ?? [];
  const out: MapData = {
    kind: graphs.length > 0 ? "graph" : "rows",
    points: [],
    edges: [],
    missing: [],
    total: 0,
    totalEdges: 0,
    legend: [],
  };
  if (graphs.length > 0) {
    graphPoints(graphs, options, out);
  } else {
    input.frames.forEach((frame, index) => {
      framePoints(frame, index, options, out);
    });
    (input.documents ?? []).forEach((set, index) => {
      documentPoints(set, input.frames.length + index, options, out);
    });
  }
  const legend = new Map<string, { label: string; tone: MapTone; count: number }>();
  for (const { label, labelTone } of out.points) {
    const entry = legend.get(label) ?? { label, tone: labelTone, count: 0 };
    entry.count++;
    legend.set(label, entry);
  }
  out.legend = [...legend.values()];
  return out;
}
