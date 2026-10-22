import type { GraphSet, QueryOutcome } from "../../../api/generated/shapes";
import { EXPAND_NODE_VARIABLE } from "../../../panels/graph/adapter";

/**
 * Graph answers of the fake Neo4j source, in the `graph` shape (api/generated/shapes.ts): a small
 * shop with customers, products and orders. A Cypher query answers this graph; one mentioning
 * `shortestPath` answers it with a path; one with `LIMIT 1` is cut at the node limit, with
 * `truncated.reason` and the notice the server sends; the explorer's expand query answers the
 * node's neighbourhood, taken from NEIGHBOURHOOD so expansions add nodes the first answer lacks.
 */

export const NEO4J_ID = "ds-neo4j";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const DB = "6f1c2a9e-4b7d-4f20-9a3e-81d5c0b7e214";

/**
 * Neo4j 5 element ids (`4:<database>:<number>` for nodes, `5:...` for relationships), the form
 * the server passes on. Bolt 4.4 sends only the number, which the expand query matches with
 * `id(n) = toInteger($nodeId)`.
 */
export const ID = {
  ada: `4:${DB}:0`,
  grace: `4:${DB}:1`,
  lamp: `4:${DB}:2`,
  desk: `4:${DB}:12`,
  oak: `4:${DB}:17`,
  b1: `5:${DB}:0`,
  b2: `5:${DB}:1`,
  b3: `5:${DB}:2`,
  m1: `5:${DB}:3`,
} as const;

export const FAKE_GRAPH: GraphSet = {
  nodes: [
    { id: ID.ada, labels: ["Customer"], properties: { name: "Ada", customerId: "42" } },
    { id: ID.grace, labels: ["Customer"], properties: { name: "Grace", customerId: "43" } },
    { id: ID.lamp, labels: ["Product"], properties: { name: "Lamp", price: 30 } },
    { id: ID.desk, labels: ["Product"], properties: { name: "Desk", price: 250 } },
  ],
  edges: [
    { id: ID.b1, type: "BOUGHT", from: ID.ada, to: ID.lamp, properties: { at: T0, quantity: 2 } },
    {
      id: ID.b2,
      type: "BOUGHT",
      from: ID.ada,
      to: ID.desk,
      properties: { at: T0 + 10 * DAY, quantity: 1 },
    },
    {
      id: ID.b3,
      type: "BOUGHT",
      from: ID.grace,
      to: ID.lamp,
      properties: { at: T0 + 20 * DAY, quantity: 5 },
    },
  ],
  schema: {
    labels: ["Customer", "Product"],
    edgeTypes: ["BOUGHT"],
    propertyKeys: { Customer: ["name", "customerId"], Product: ["name", "price"] },
  },
};

/** Neighbours the first answer does not contain, by node element id. */
const NEIGHBOURHOOD: Record<string, GraphSet> = {
  [ID.desk]: {
    nodes: [
      { id: ID.desk, labels: ["Product"], properties: { name: "Desk", price: 250 } },
      { id: ID.oak, labels: ["Supplier"], properties: { name: "Oak & Co" } },
    ],
    edges: [{ id: ID.m1, type: "MADE_BY", from: ID.desk, to: ID.oak, properties: {} }],
    schema: {
      labels: ["Product", "Supplier"],
      edgeTypes: ["MADE_BY"],
      propertyKeys: { Supplier: ["name"] },
    },
  },
};

/** The schema answer of graph kinds: property keys for the whole source. */
export const FAKE_GRAPH_SCHEMA = {
  kind: "graph",
  labels: ["Customer", "Product", "Supplier"],
  edgeTypes: ["BOUGHT", "MADE_BY"],
  propertyKeys: ["at", "customerId", "name", "price", "quantity"],
};

const EMPTY: GraphSet = {
  nodes: [],
  edges: [],
  schema: { labels: [], edgeTypes: [], propertyKeys: {} },
};

/**
 * The answer of the fake graph source to a Cypher query. The explorer's expand query comes in
 * both forms of adapter.ts: by element id (Neo4j 5) and by internal number (Bolt 4.4, Memgraph).
 */
export function graphOutcome(cypher: string, variables: Record<string, unknown>): QueryOutcome {
  const nodeId = String(variables[EXPAND_NODE_VARIABLE] ?? "");
  if (/WHERE elementId\(n\) = \$nodeId RETURN n, r, m LIMIT \d+$/.test(cypher)) {
    return { result: { shape: "graph", graph: NEIGHBOURHOOD[nodeId] ?? EMPTY } };
  }
  if (/WHERE id\(n\) = toInteger\(\$nodeId\) RETURN n, r, m LIMIT \d+$/.test(cypher)) {
    const key = Object.keys(NEIGHBOURHOOD).find((id) => id.endsWith(`:${nodeId}`));
    return { result: { shape: "graph", graph: (key && NEIGHBOURHOOD[key]) || EMPTY } };
  }
  if (/shortestPath/i.test(cypher)) {
    return {
      result: {
        shape: "graph",
        graph: {
          ...FAKE_GRAPH,
          paths: [
            {
              nodes: [ID.grace, ID.lamp, ID.ada, ID.desk],
              edges: [ID.b3, ID.b1, ID.b2],
            },
          ],
        },
      },
    };
  }
  if (/LIMIT 1\b/.test(cypher)) {
    return { result: { shape: "graph", graph: cutGraph(FAKE_GRAPH, 4) } };
  }
  return { result: { shape: "graph", graph: FAKE_GRAPH } };
}

/**
 * A graph as the server answers one cut at its node limit (docs/api/datasources.md, "Graph
 * results"): `truncated.reason` and the notice, fields the generated type gets with the server
 * side of M3, so they are added here as the wire carries them.
 */
export function cutGraph(graph: GraphSet, limit: number): GraphSet {
  const wire = {
    ...graph,
    truncated: { limit, reason: "graph.node_limit" },
    notices: [
      {
        severity: "warning",
        code: "graph.node_limit",
        params: { limit: String(limit) },
        text: `The graph was cut at ${limit} nodes.`,
      },
    ],
  };
  return wire as GraphSet;
}
