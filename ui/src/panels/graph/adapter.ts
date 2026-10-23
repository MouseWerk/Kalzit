import { isRecord } from "../../api/client";
import type { GraphSet, Node, Notice } from "../../api/generated/shapes";

/*
 * Everything the graph panels assume about the `graph` shape and the graph sources beyond the
 * generated `GraphSet` type, in one place. The server side (Neo4j, Memgraph, TigerGraph) is built
 * in parallel; when its contract settles, this is the module to adjust.
 *
 * The contract (docs/api/datasources.md, "Graph results", on m3/graph-sources):
 * - Node and edge ids are unique strings within one result and stable across queries of the same
 *   source, so an expanded neighbourhood merges into the graph by id. Neo4j and Memgraph send the
 *   element id (Bolt 4.4: the internal number as text); TigerGraph `Type:id`, split at the first
 *   colon, and edges `Type:<from>-><to>`.
 * - Property values arrive as JSON; values JSON has no type for come as
 *   `{"$type": "int64" | "date" | "dateTime" | "localDateTime" | ..., "value": string}`.
 *   Numbers that are times are read as Unix milliseconds (seconds when below 10^11).
 * - Query forms: Cypher `{"cypher": "..."}`; TigerGraph `{"gsql": "..."}` or
 *   `{"installed": "name", "params"?: {...}}`. Dashboard variables reach the source as parameters
 *   (`$name`), never as text.
 * - The schema route answers `{"kind": "graph", "labels", "edgeTypes", "propertyKeys", "queries"?}`
 *   with property keys as one list for the whole source.
 * - `truncated.reason` and `notices` say which limit cut a graph (`graph.node_limit`, ...). They
 *   are part of the generated `GraphSet`; `graphExtras` still checks each notice, so one odd entry
 *   cannot break the panel.
 */

/** What the source said about a graph beyond the generated type: notices and the cut's reason. */
export interface GraphExtras {
  notices: Notice[];
  /** The notice code of the limit that cut the result (`graph.node_limit`), if it says. */
  truncatedReason: string | null;
}

function readNotice(value: unknown): Notice | null {
  if (!isRecord(value) || typeof value.code !== "string" || value.code === "") {
    return null;
  }
  const params = isRecord(value.params)
    ? Object.fromEntries(
        Object.entries(value.params).flatMap(([k, v]) =>
          typeof v === "string" || typeof v === "number" ? [[k, String(v)]] : [],
        ),
      )
    : undefined;
  return {
    severity: value.severity === "info" ? "info" : "warning",
    code: value.code,
    ...(params === undefined ? {} : { params }),
    text: typeof value.text === "string" ? value.text : "",
  };
}

/** Notices and the cut's reason, whatever the answer carries; nothing when it has none. */
export function graphExtras(set: GraphSet): GraphExtras {
  const raw = set as unknown as Record<string, unknown>;
  const notices = Array.isArray(raw.notices)
    ? raw.notices.flatMap((n) => {
        const notice = readNotice(n);
        return notice === null ? [] : [notice];
      })
    : [];
  const truncated = raw.truncated;
  const reason =
    isRecord(truncated) && typeof truncated.reason === "string" ? truncated.reason : "";
  return { notices, truncatedReason: reason === "" ? null : reason };
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
  const fallback = typedId(node);
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
  return fallback;
}

/**
 * A node's id as people read it: TigerGraph ids are `Type:id`, where the type is already the
 * node's label, so the part after the first colon is enough.
 */
export function typedId(node: Node): string {
  const colon = node.id.indexOf(":");
  if (colon > 0 && node.labels.includes(node.id.slice(0, colon))) {
    return node.id.slice(colon + 1);
  }
  return node.id;
}

/** Above this a number is milliseconds, below it seconds (10^11 s is the year 5138). */
const MS_THRESHOLD = 1e11;

/** Typed values that are points in time (`localDateTime` is read as UTC). */
const TEMPORAL_TYPES = new Set(["date", "dateTime", "localDateTime"]);

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
  if (
    isRecord(value) &&
    typeof value.$type === "string" &&
    TEMPORAL_TYPES.has(value.$type) &&
    typeof value.value === "string"
  ) {
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
 * - Neo4j 5 identifies nodes by `elementId(n)`; Bolt 4.4 sends the internal number, which
 *   `id(n)` matches.
 * - Memgraph by `id(n)`, an integer, sent as text and converted in the query.
 * - TigerGraph has no generic expand: a GSQL query needs the vertex and edge types spelled out
 *   (`Type:id` gives the vertex type, but not the edge types to follow), and interpreted queries
 *   need rights a `queryreader` user may lack. Explorer mode is off there for now.
 */
export function expandQuery(kind: string, nodeId: string, limit: number): ExpandQuery | null {
  const n = Math.max(1, Math.min(MAX_EXPAND_LIMIT, Math.floor(limit)));
  const variables = { [EXPAND_NODE_VARIABLE]: nodeId };
  switch (kind) {
    case "neo4j":
      return {
        query: {
          cypher: /^\d+$/.test(nodeId)
            ? `MATCH (n)-[r]-(m) WHERE id(n) = toInteger($${EXPAND_NODE_VARIABLE}) RETURN n, r, m LIMIT ${n}`
            : `MATCH (n)-[r]-(m) WHERE elementId(n) = $${EXPAND_NODE_VARIABLE} RETURN n, r, m LIMIT ${n}`,
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
