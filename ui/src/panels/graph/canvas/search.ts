import { propertyText } from "../adapter";
import type { GraphModel } from "../model";

/**
 * The search on a graph panel's canvas (Graph 0.8.1 board, frame 5): captions and properties of
 * the nodes and, when asked, of the edges, without regard to case. It sees only what the panel
 * has loaded, never the database. Pure, so it is tested without a panel.
 */

/** Hits listed under the field; Enter still walks through all of them. */
export const SEARCH_LIST = 50;
/** Characters shown before and after the place a property value matched. */
export const SNIPPET_AROUND = 24;

export interface SearchScope {
  captions: boolean;
  properties: boolean;
  edges: boolean;
}

export const DEFAULT_SCOPE: SearchScope = { captions: true, properties: true, edges: false };

export interface SearchHit {
  kind: "node" | "edge";
  /** Index into the model's nodes or edges. */
  index: number;
  /** The node's caption, or the edge as "from, TYPE, to". */
  caption: string;
  /** The node's first label or the edge's type; "" without one. */
  label: string;
  /** The property the text was found in; null when it was found in the caption. */
  property: string | null;
  /** The text it was found in, and where. */
  text: string;
  start: number;
  end: number;
}

/** Where `needle` (already lower case) starts in `text`, without regard to case; -1 when it does not. */
function find(text: string, needle: string): number {
  const lower = text.toLowerCase();
  // A letter whose lower case is longer than itself would shift the place: such a text matches
  // from its start, so the hit is still found and nothing wrong is underlined.
  const at = lower.indexOf(needle);
  return at >= 0 && lower.length !== text.length ? 0 : at;
}

function inProperties(
  properties: Record<string, unknown>,
  needle: string,
): { property: string; text: string; start: number } | null {
  for (const [property, value] of Object.entries(properties)) {
    const text = propertyText(value);
    const start = find(text, needle);
    if (start >= 0) return { property, text, start };
  }
  return null;
}

/**
 * Every node and edge the query is found in, nodes first, in the model's order; one hit per
 * element (its caption before its properties). An empty query finds nothing.
 */
export function searchGraph(model: GraphModel, query: string, scope: SearchScope): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hits: SearchHit[] = [];
  const size = needle.length;
  const span = (text: string, start: number) => ({
    text,
    start,
    end: Math.min(text.length, start + size),
  });
  model.nodes.forEach((node, index) => {
    const base = {
      kind: "node" as const,
      index,
      caption: node.caption,
      label: node.labels[0] ?? "",
    };
    const at = scope.captions ? find(node.caption, needle) : -1;
    if (at >= 0) {
      hits.push({ ...base, property: null, ...span(node.caption, at) });
      return;
    }
    const found = scope.properties ? inProperties(node.properties, needle) : null;
    if (found !== null) {
      hits.push({ ...base, property: found.property, ...span(found.text, found.start) });
    }
  });
  if (!scope.edges) return hits;
  model.edges.forEach((edge, index) => {
    const from = model.nodes[edge.source]?.caption ?? "";
    const to = model.nodes[edge.target]?.caption ?? "";
    const base = {
      kind: "edge" as const,
      index,
      caption: `${from}, ${edge.type}, ${to}`,
      label: edge.type,
    };
    const at = scope.captions ? find(edge.type, needle) : -1;
    if (at >= 0) {
      hits.push({ ...base, property: null, ...span(edge.type, at) });
      return;
    }
    const found = scope.properties ? inProperties(edge.properties, needle) : null;
    if (found !== null) {
      hits.push({ ...base, property: found.property, ...span(found.text, found.start) });
    }
  });
  return hits;
}

/** A hit's text around the place it matched: what comes before, the match, what comes after. */
export function snippet(
  hit: Pick<SearchHit, "text" | "start" | "end">,
  around = SNIPPET_AROUND,
): { before: string; match: string; after: string; cutBefore: boolean; cutAfter: boolean } {
  const from = Math.max(0, hit.start - around);
  const to = Math.min(hit.text.length, hit.end + around);
  return {
    before: hit.text.slice(from, hit.start),
    match: hit.text.slice(hit.start, hit.end),
    after: hit.text.slice(hit.end, to),
    cutBefore: from > 0,
    cutAfter: to < hit.text.length,
  };
}

/** The hit after (or before) `current`, going round at the ends; -1 without hits. */
export function nextHit(count: number, current: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  return (((current + step) % count) + count) % count;
}
