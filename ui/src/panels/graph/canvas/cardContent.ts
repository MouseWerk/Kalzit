import { clipChars } from "../../../lib/chars";
import { propertyText } from "../adapter";
import type { ModelEdge, ModelNode } from "../model";
import { CARD_PROPERTIES, ownEntry } from "../options";

/**
 * What the info card of a hovered node or edge shows (Graph 0.8.1 board, frame 1 and decision 6):
 * up to four properties, first the one the caption comes from, then in the order of the result;
 * per label the panel editor can name them instead. Pure, so it is tested without a panel.
 */

/** The pointer rests this long over a node or an edge before its card shows, in ms. */
export const CARD_DELAY_MS = 400;
/** Above this many visible nodes no card shows while the camera moves. */
export const CARD_MOVING_LIMIT = 2_000;

export interface CardProperty {
  key: string;
  text: string;
}

/** The property a node's caption comes from: the one the panel names, else the first that equals it. */
function captionKey(node: ModelNode, captionProperty: string): string | null {
  if (captionProperty !== "" && Object.hasOwn(node.properties, captionProperty)) {
    return captionProperty;
  }
  for (const [key, value] of Object.entries(node.properties)) {
    if (propertyText(value) === node.caption) return key;
  }
  return null;
}

/** A value longer than this is cut on the card, with an ellipsis; the sheet shows all of it. */
export const CARD_VALUE_CHARS = 200;

/** A property's text as the card shows it: at most CARD_VALUE_CHARS characters. */
export function cardText(value: unknown): string {
  const text = propertyText(value);
  const clipped = clipChars(text, CARD_VALUE_CHARS);
  return clipped === text ? text : `${clipped}…`;
}

function texts(properties: Record<string, unknown>, keys: readonly string[]): CardProperty[] {
  return keys
    .filter((key) => Object.hasOwn(properties, key))
    .slice(0, CARD_PROPERTIES)
    .map((key) => ({ key, text: cardText(properties[key]) }));
}

/** The properties on a node's card, and how many the node has in all. */
export function nodeCard(
  node: ModelNode,
  chosen: Readonly<Record<string, readonly string[]>>,
  captionProperty: string,
): { properties: CardProperty[]; total: number } {
  const total = Object.keys(node.properties).length;
  const own = node.labels
    .map((label) => ownEntry(chosen, label))
    .find((list) => list !== undefined);
  if (own !== undefined && own.length > 0) {
    return { properties: texts(node.properties, own), total };
  }
  const first = captionKey(node, captionProperty);
  const keys = Object.keys(node.properties).filter((key) => key !== first);
  return { properties: texts(node.properties, first === null ? keys : [first, ...keys]), total };
}

/** The properties on an edge's card, in the order of the result, and how many it has in all. */
export function edgeCard(edge: ModelEdge): { properties: CardProperty[]; total: number } {
  const keys = Object.keys(edge.properties);
  return { properties: texts(edge.properties, keys), total: keys.length };
}
