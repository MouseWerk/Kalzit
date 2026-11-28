import { isRecord } from "../../../api/client";
import { isCoordinate } from "../../map/projection";
import { findLatLonKeys } from "../../map/suggest";
import { readNumber, readTime } from "../adapter";
import type { LayoutMode, LayoutRequest } from "../layoutProtocol";
import type { GraphModel, ModelNode } from "../model";
import type { GraphPanelOptions, LayoutLanes, LayoutOrder } from "../options";
import type { GraphView } from "../view";

/**
 * What the layouts need from the result besides nodes and edges, read on the page and handed to
 * the layout worker as flat arrays: the order of a circle or grid, the two values of the
 * coordinates, the times and lanes of the timeline. And whether a layout can apply to a result at
 * all, with the reason when it cannot (Graph081 board, frames 12 and 14).
 */

/** A hierarchy lays out at most this many drawn nodes; a closed group counts as one. */
export const HIERARCHY_NODE_LIMIT = 10_000;

/** The layout a view shows and its options: the panel's stored ones until the viewer changes them. */
export interface LayoutSettings {
  mode: LayoutMode;
  order: LayoutOrder;
  descending: boolean;
  /**
   * Coordinates: two number properties, or a `point` property, which wins when set. The map reads
   * the same: `x` is the longitude and `y` the latitude.
   */
  x: string;
  y: string;
  point: string;
  axes: boolean;
  /** Timeline: the time property per label; a label without an entry takes its best one. */
  time: Readonly<Record<string, string>>;
  lanes: LayoutLanes;
}

/**
 * The settings a panel's options give its layout. `mode` is the panel type's own layout: a
 * network opens with the stored one, a hierarchy panel always as a hierarchy.
 */
export function layoutSettings(options: GraphPanelOptions, mode: LayoutMode): LayoutSettings {
  return {
    mode: mode === "hierarchy" || options.layout === "" ? mode : options.layout,
    order: options.layoutOrder,
    descending: options.layoutOrderDirection === "desc",
    x: options.layoutX,
    y: options.layoutY,
    point: options.layoutPoint,
    axes: options.layoutAxes,
    time: options.layoutTime,
    lanes: options.layoutLanes,
  };
}

/** The options that store these settings, for the panel editor. */
export function layoutOptions(settings: LayoutSettings): Partial<GraphPanelOptions> {
  return {
    layout: settings.mode,
    layoutOrder: settings.order,
    layoutOrderDirection: settings.descending ? "desc" : "asc",
    layoutX: settings.x,
    layoutY: settings.y,
    layoutPoint: settings.point,
    layoutAxes: settings.axes,
    layoutTime: { ...settings.time },
    layoutLanes: settings.lanes,
  };
}

/** A `point` value as its two coordinates (docs/api/datasources.md), or null. */
export function readPoint(value: unknown): [number, number] | null {
  if (!isRecord(value) || value.$type !== "point") return null;
  const x = readNumber(value.x);
  const y = readNumber(value.y);
  return x === null || y === null ? null : [x, y];
}

/** A value that is a point in time by its type or its text; a bare number is not taken for one. */
function isTime(value: unknown): boolean {
  return typeof value !== "number" && readTime(value) !== null;
}

/** A property key and how many nodes carry a usable value for it. */
export interface PropertyUse {
  key: string;
  count: number;
}

export interface LayoutProperties {
  /** Number properties, the most widely used first. */
  numbers: PropertyUse[];
  points: PropertyUse[];
  times: PropertyUse[];
  /** Time properties per label index (-1: nodes without a label), the most widely used first. */
  timesByLabel: Map<number, PropertyUse[]>;
}

function ranked(counts: Map<string, number>): PropertyUse[] {
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The properties of a result the coordinates and the timeline can use. */
export function layoutProperties(model: GraphModel): LayoutProperties {
  const numbers = new Map<string, number>();
  const points = new Map<string, number>();
  const times = new Map<string, number>();
  const byLabel = new Map<number, Map<string, number>>();
  const add = (counts: Map<string, number>, key: string) =>
    counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const node of model.nodes) {
    for (const [key, value] of Object.entries(node.properties)) {
      if (readPoint(value) !== null) {
        add(points, key);
      } else if (isTime(value)) {
        add(times, key);
        let own = byLabel.get(node.label);
        if (own === undefined) {
          own = new Map();
          byLabel.set(node.label, own);
        }
        add(own, key);
      } else if (readNumber(value) !== null) {
        add(numbers, key);
      }
    }
  }
  return {
    numbers: ranked(numbers),
    points: ranked(points),
    times: ranked(times),
    timesByLabel: new Map([...byLabel].map(([label, counts]) => [label, ranked(counts)])),
  };
}

/** Number properties tried as a pair when the panel names none. */
const PAIR_CANDIDATES = 8;

export type CoordinateChoice =
  | { kind: "point"; point: string }
  | { kind: "xy"; x: string; y: string };

function both(model: GraphModel, x: string, y: string): number {
  let count = 0;
  for (const node of model.nodes) {
    if (readNumber(node.properties[x]) !== null && readNumber(node.properties[y]) !== null) count++;
  }
  return count;
}

/**
 * Which properties the coordinates read: the panel's `point` property, else its two number
 * properties, else the pair of number properties most nodes carry both of, else the most widely
 * used `point`. Null when the result has nothing of the kind.
 */
export function coordinateChoice(
  model: GraphModel,
  properties: LayoutProperties,
  settings: Pick<LayoutSettings, "x" | "y" | "point">,
): CoordinateChoice | null {
  const has = (list: PropertyUse[], key: string) => key !== "" && list.some((p) => p.key === key);
  if (has(properties.points, settings.point)) return { kind: "point", point: settings.point };
  const x = has(properties.numbers, settings.x) ? settings.x : null;
  const y = has(properties.numbers, settings.y) ? settings.y : null;
  if (x !== null && y !== null) return { kind: "xy", x, y };
  const candidates = properties.numbers.slice(0, PAIR_CANDIDATES).map((p) => p.key);
  let best: { x: string; y: string; count: number } | null = null;
  for (const a of x === null ? candidates : [x]) {
    for (const b of y === null ? candidates : [y]) {
      // Without a choice of the panel, each pair is tried once, in the order of the list.
      if (a === b || (x === null && y === null && candidates.indexOf(a) > candidates.indexOf(b))) {
        continue;
      }
      const count = both(model, a, b);
      if (count > 0 && (best === null || count > best.count)) best = { x: a, y: b, count };
    }
  }
  if (best !== null) return { kind: "xy", x: best.x, y: best.y };
  const point = properties.points[0];
  return point === undefined ? null : { kind: "point", point: point.key };
}

/** Where the map layout reads a node's place: a `point`, or latitude and longitude. */
export type MapChoice =
  | { kind: "point"; point: string }
  | { kind: "latLon"; lat: string; lon: string };

/** Whether every node with both values has them in the range of latitude and longitude. */
function onEarth(model: GraphModel, lat: string, lon: string): boolean {
  let any = false;
  for (const node of model.nodes) {
    const la = readNumber(node.properties[lat]);
    const lo = readNumber(node.properties[lon]);
    if (la === null || lo === null) continue;
    if (!isCoordinate(la, lo)) return false;
    any = true;
  }
  return any;
}

/**
 * Which properties the map layout reads: the panel's `point` property, else its two number
 * properties when they are latitude and longitude (y and x), else the two number properties with
 * the usual names (lat and lon, Breite and Länge, ...), else the most widely used `point`. Null
 * when the result has nothing of the kind.
 */
export function mapChoice(
  model: GraphModel,
  properties: LayoutProperties,
  settings: Pick<LayoutSettings, "x" | "y" | "point">,
): MapChoice | null {
  const has = (list: PropertyUse[], key: string) => key !== "" && list.some((p) => p.key === key);
  if (has(properties.points, settings.point)) return { kind: "point", point: settings.point };
  if (
    has(properties.numbers, settings.x) &&
    has(properties.numbers, settings.y) &&
    onEarth(model, settings.y, settings.x)
  ) {
    return { kind: "latLon", lat: settings.y, lon: settings.x };
  }
  const pair = findLatLonKeys(properties.numbers.map((p) => p.key));
  if (pair !== null && onEarth(model, pair.lat, pair.lon)) return { kind: "latLon", ...pair };
  const point = properties.points[0];
  return point === undefined ? null : { kind: "point", point: point.key };
}

/** The time property of each label (by label index): the panel's, else the label's most used. */
export function timeChoice(
  model: GraphModel,
  properties: LayoutProperties,
  settings: Pick<LayoutSettings, "time">,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const [label, list] of properties.timesByLabel) {
    const name = model.labels[label];
    // Only the label's own entry, never a key an object inherits (a label named "constructor").
    const own =
      name !== undefined && Object.hasOwn(settings.time, name) ? settings.time[name] : undefined;
    const key = list.some((p) => p.key === own) ? own : list[0]?.key;
    if (key !== undefined) out.set(label, key);
  }
  return out;
}

/** What a layout reads from the result, as the fields of its request. */
export type LayoutInput = Pick<
  LayoutRequest,
  "centers" | "order" | "values" | "uniform" | "times" | "lanes"
>;

/** Why a layout cannot apply to a result (the menu says it, and the panel when it is chosen). */
export type LayoutReason = "noCoordinates" | "noPlace" | "noTime" | "tooLarge";

export interface LayoutPlan {
  /** Null: the layout applies. */
  reason: LayoutReason | null;
  input: LayoutInput;
  /** Nodes the layout places by a value of their own; the others stand in its strip. */
  placed: number;
  total: number;
}

function modelNode(model: GraphModel, view: GraphView, index: number): ModelNode | undefined {
  const node = view.nodes[index];
  return node === undefined || node.node < 0 ? undefined : model.nodes[node.node];
}

/** The label of a view node, a group's included; -1 without one. */
function labelOf(model: GraphModel, view: GraphView, index: number): number {
  const node = view.nodes[index];
  if (node === undefined) return -1;
  return node.node < 0 ? node.cluster : (model.nodes[node.node]?.label ?? -1);
}

/** The view's nodes in the order a circle or grid places them. */
export function nodeOrder(
  model: GraphModel,
  view: GraphView,
  order: LayoutOrder,
  descending: boolean,
  language: string,
): Uint32Array {
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  const caption = (i: number) => view.nodes[i]?.caption ?? "";
  const degree = (i: number) => modelNode(model, view, i)?.degree ?? 0;
  const byName = (a: number, b: number) => collator.compare(caption(a), caption(b));
  const compare =
    order === "name"
      ? byName
      : order === "degree"
        ? (a: number, b: number) => degree(a) - degree(b) || byName(a, b)
        : (a: number, b: number) =>
            labelOf(model, view, a) - labelOf(model, view, b) || byName(a, b);
  const direction = descending ? -1 : 1;
  const indexes = Uint32Array.from(view.nodes, (_, i) => i);
  // Ties keep the result's order, so the same data always gives the same places.
  return indexes.sort((a, b) => direction * compare(a, b) || a - b);
}

/**
 * How a layout applies to a result: what it reads, how many nodes it can place, or why it cannot
 * apply. `centers` are the view keys of the radial layout's middle.
 */
export function planLayout(
  model: GraphModel,
  view: GraphView,
  properties: LayoutProperties,
  settings: LayoutSettings,
  centers: readonly string[],
  language: string,
): LayoutPlan {
  const total = view.nodes.length;
  const all: LayoutPlan = { reason: null, input: {}, placed: total, total };
  switch (settings.mode) {
    case "force":
      return all;
    case "hierarchy":
      return total > HIERARCHY_NODE_LIMIT ? { ...all, reason: "tooLarge" } : all;
    case "radial": {
      const keys = new Set(centers);
      const found = view.nodes.flatMap((node, i) => (keys.has(node.key) ? [i] : []));
      return { ...all, input: { centers: Uint32Array.from(found) } };
    }
    case "circular":
    case "grid":
      return {
        ...all,
        input: { order: nodeOrder(model, view, settings.order, settings.descending, language) },
      };
    case "coordinates": {
      const choice = coordinateChoice(model, properties, settings);
      const values = new Float64Array(total * 2).fill(Number.NaN);
      let placed = 0;
      if (choice !== null) {
        for (let i = 0; i < total; i++) {
          const data = modelNode(model, view, i);
          if (data === undefined) continue;
          const at =
            choice.kind === "point"
              ? readPoint(data.properties[choice.point])
              : ([
                  readNumber(data.properties[choice.x]),
                  readNumber(data.properties[choice.y]),
                ] as const);
          if (at === null || at[0] === null || at[1] === null) continue;
          values[2 * i] = at[0];
          values[2 * i + 1] = at[1];
          placed++;
        }
      }
      return {
        reason: placed === 0 ? "noCoordinates" : null,
        input: { values, uniform: choice?.kind === "point" },
        placed,
        total,
      };
    }
    case "map": {
      const choice = mapChoice(model, properties, settings);
      // Longitude, then latitude: x and y of the map.
      const values = new Float64Array(total * 2).fill(Number.NaN);
      let placed = 0;
      if (choice !== null) {
        for (let i = 0; i < total; i++) {
          const data = modelNode(model, view, i);
          if (data === undefined) continue;
          const at =
            choice.kind === "point"
              ? readPoint(data.properties[choice.point])
              : ([
                  readNumber(data.properties[choice.lon]),
                  readNumber(data.properties[choice.lat]),
                ] as const);
          if (at === null || at[0] === null || at[1] === null || !isCoordinate(at[1], at[0])) {
            continue;
          }
          values[2 * i] = at[0];
          values[2 * i + 1] = at[1];
          placed++;
        }
      }
      return { reason: placed === 0 ? "noPlace" : null, input: { values }, placed, total };
    }
    case "timeline": {
      const choice = timeChoice(model, properties, settings);
      const times = new Float64Array(total).fill(Number.NaN);
      const lanes = new Int32Array(total);
      let placed = 0;
      for (let i = 0; i < total; i++) {
        const data = modelNode(model, view, i);
        if (data === undefined) continue;
        lanes[i] = data.label;
        const key = choice.get(data.label);
        const time = key === undefined ? null : readTime(data.properties[key]);
        if (time === null || typeof data.properties[key as string] === "number") continue;
        times[i] = time;
        placed++;
      }
      return {
        reason: placed === 0 ? "noTime" : null,
        input: settings.lanes === "label" ? { times, lanes } : { times },
        placed,
        total,
      };
    }
  }
}
