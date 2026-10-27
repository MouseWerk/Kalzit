import { propertyText, readNumber } from "./adapter";
import { RAMP_STEPS } from "./colors";
import { GRAPH_COLORS, type GraphModel } from "./model";
import { type GraphPanelOptions, LABEL_TONES } from "./options";
import { rampGroup } from "./view";

/**
 * Which color each node gets, as a group the renderer turns into a theme color (drawing.ts): a
 * palette index for labels, communities, components and text values, a ramp step for numbers,
 * -1 (neutral) for nodes without the property. Colors stand for data only, never for a state.
 */

/** The palette index of a label: its own color when the panel gives it one, else its order. */
export function labelGroupOf(
  model: Pick<GraphModel, "labels">,
  labelColors: GraphPanelOptions["labelColors"],
): (label: number) => number {
  return (label) => {
    if (label < 0) return -1;
    const tone = labelColors[model.labels[label] ?? ""];
    const own = tone === undefined ? -1 : LABEL_TONES.indexOf(tone);
    return own >= 0 ? own : label % GRAPH_COLORS;
  };
}

/** What a color by property found: the range of numbers, the text values, nodes without it. */
export interface PropertyPaint {
  groups: Int32Array;
  /** Numbers: the range the ramp spans. */
  min: number | null;
  max: number | null;
  /** Text values in order of appearance (their palette index is their position). */
  values: string[];
  /** Nodes without a value. */
  missing: number;
}

/**
 * Colors by a node property: numbers along the ramp's five steps between the range's ends (the
 * result's own, or the panel's fixed ones), text values in palette order. A node without the
 * property, or with a value the scheme cannot place, is neutral.
 */
export function propertyPaint(
  model: GraphModel,
  options: Pick<
    GraphPanelOptions,
    "colorProperty" | "colorScheme" | "colorRange" | "colorMin" | "colorMax"
  >,
): PropertyPaint {
  const groups = new Int32Array(model.nodes.length).fill(-1);
  const key = options.colorProperty;
  let missing = 0;
  if (options.colorScheme === "values") {
    const values: string[] = [];
    model.nodes.forEach((node, i) => {
      const text = key === "" ? "" : propertyText(node.properties[key]);
      if (text === "") {
        missing++;
        return;
      }
      let at = values.indexOf(text);
      if (at < 0) {
        at = values.length;
        values.push(text);
      }
      groups[i] = at % GRAPH_COLORS;
    });
    return { groups, min: null, max: null, values, missing };
  }
  const numbers = model.nodes.map((node) => (key === "" ? null : readNumber(node.properties[key])));
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const n of numbers) {
    if (n !== null) {
      low = Math.min(low, n);
      high = Math.max(high, n);
    }
  }
  const fixed = options.colorRange === "fixed";
  const min = fixed && options.colorMin !== null ? options.colorMin : low;
  const max = fixed && options.colorMax !== null ? options.colorMax : high;
  numbers.forEach((n, i) => {
    if (n === null || !Number.isFinite(min) || !Number.isFinite(max)) {
      missing++;
      return;
    }
    const span = max - min;
    const share = span <= 0 ? 0.5 : (n - min) / span;
    const step = Math.min(RAMP_STEPS - 1, Math.max(0, Math.floor(share * RAMP_STEPS)));
    groups[i] = rampGroup(step);
  });
  return {
    groups,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    values: [],
    missing,
  };
}
