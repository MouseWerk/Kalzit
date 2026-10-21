import { isRecord } from "../../api/client";
import type { GraphSet, Node } from "../../api/generated/shapes";

/*
 * Everything the graph panels assume about the `graph` shape and the graph sources beyond the
 * generated `GraphSet` type, in one place. The server side (Neo4j, Memgraph, TigerGraph) is built
 * in parallel; when its contract settles, this is the module to adjust.
 *
 * Assumptions:
 * - Node and edge ids are unique strings within one result and stable across queries of the same
 *   source, so an expanded neighbourhood merges into the graph by id.
 * - Property values arrive as JSON. Values JSON has no type for use the documents' typed form
 *   `{"$type": "date" | "int64" | ..., "value": string}`; temporal values are either that, an ISO
 *   8601 string, or a number of Unix milliseconds (seconds when below 10^11, as SQLite times).
 * - Cypher sources take the query form `{"cypher": "..."}`; dashboard variables reach Cypher as
 *   parameters (`$name`), never as text.
 * - The schema route answers `{"kind": "graph", "labels", "edgeTypes", "propertyKeys"}` for graph
 *   sources, the same fields as `GraphSchema`.
 */

/** Data source kinds whose results are graphs. */
export const GRAPH_KINDS = ["neo4j", "memgraph", "tigergraph"] as const;
/** Kinds queried in Cypher. */
export const CYPHER_KINDS = ["neo4j", "memgraph"] as const;

export function isCypherKind(kind: string): boolean {
  return (CYPHER_KINDS as readonly string[]).includes(kind);
}

/** Property keys tried, in order, for a node's caption when the panel names none. */
const CAPTION_KEYS = ["name", "title", "label", "displayName", "caption", "id", "key"];

/** A property value as short text for captions, tables and variables. */
export function propertyText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (isRecord(value) && typeof value.$type === "string" && "value" in value) {
    return String(value.value);
  }
  return JSON.stringify(value);
}

/**
 * The text a node is shown with: the named property, else the first of the usual name
 * properties, else its first label and id.
 */
export function nodeCaption(node: Node, property: string): string {
  if (property !== "") {
    const text = propertyText(node.properties[property]);
    if (text !== "") {
      return text;
    }
  }
  for (const key of CAPTION_KEYS) {
    const text = propertyText(node.properties[key]);
    if (text !== "") {
      return text;
    }
  }
  return node.id;
}

/** Above this a number is milliseconds, below it seconds (10^11 s is the year 5138). */
const MS_THRESHOLD = 1e11;

/** A temporal property as Unix milliseconds, or null when it is not one. */
export function readTime(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.abs(value) > MS_THRESHOLD ? value : value * 1000;
  }
  if (typeof value === "string") {
    // Only date-like text: a bare number in a string is an id more often than a time.
    if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return null;
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (isRecord(value) && value.$type === "date" && typeof value.value === "string") {
    return readTime(value.value);
  }
  return null;
}

/** A property as a number for sizes and widths: numbers, int64 text and typed numbers. */
export function readNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (isRecord(value) && (value.$type === "int64" || value.$type === "decimal")) {
    return readNumber(value.value);
  }
  return null;
}

/** A graph result as the server should send it, with defaults where a field is missing. */
export function normalizeGraph(value: GraphSet): GraphSet {
  return {
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
    ...(Array.isArray(value.paths) ? { paths: value.paths } : {}),
    schema: {
      labels: value.schema?.labels ?? [],
      edgeTypes: value.schema?.edgeTypes ?? [],
      propertyKeys: value.schema?.propertyKeys ?? {},
    },
    ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
  };
}

/** The variable the expand query receives the node id in. */
export const EXPAND_NODE_VARIABLE = "nodeId";
/** At most this many neighbours per expansion step, whatever the panel asks for. */
export const MAX_EXPAND_LIMIT = 200;

export interface ExpandQuery {
  query: unknown;
  variables: Record<string, unknown>;
}

/**
 * The generic "expand" query of explorer mode: the node, its direct neighbours and the edges to
 * them, at most `limit` of them. The node id goes in as a parameter; the limit is a number this
 * module produces, so it is safe as text.
 *
 * - Neo4j identifies nodes by `elementId(n)` (a string).
 * - Memgraph by `id(n)`, an integer, sent as text and converted in the query.
 * - TigerGraph has no generic expand yet: a GSQL query for it needs the vertex type, and the
 *   server's result mapping for it is still being built. Explorer mode is off there.
 */
export function expandQuery(kind: string, nodeId: string, limit: number): ExpandQuery | null {
  const n = Math.max(1, Math.min(MAX_EXPAND_LIMIT, Math.floor(limit)));
  const variables = { [EXPAND_NODE_VARIABLE]: nodeId };
  switch (kind) {
    case "neo4j":
      return {
        query: {
          cypher: `MATCH (n)-[r]-(m) WHERE elementId(n) = $${EXPAND_NODE_VARIABLE} RETURN n, r, m LIMIT ${n}`,
        },
        variables,
      };
    case "memgraph":
      return {
        query: {
          cypher: `MATCH (n)-[r]-(m) WHERE id(n) = toInteger($${EXPAND_NODE_VARIABLE}) RETURN n, r, m LIMIT ${n}`,
        },
        variables,
      };
    default:
      return null;
  }
}
