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

export const FAKE_GRAPH: GraphSet = {
  nodes: [
    { id: "c1", labels: ["Customer"], properties: { name: "Ada", customerId: "42" } },
    { id: "c2", labels: ["Customer"], properties: { name: "Grace", customerId: "43" } },
    { id: "p1", labels: ["Product"], properties: { name: "Lamp", price: 30 } },
    { id: "p2", labels: ["Product"], properties: { name: "Desk", price: 250 } },
  ],
  edges: [
    { id: "b1", type: "BOUGHT", from: "c1", to: "p1", properties: { at: T0, quantity: 2 } },
    {
      id: "b2",
      type: "BOUGHT",
      from: "c1",
      to: "p2",
      properties: { at: T0 + 10 * DAY, quantity: 1 },
    },
    {
      id: "b3",
      type: "BOUGHT",
      from: "c2",
      to: "p1",
      properties: { at: T0 + 20 * DAY, quantity: 5 },
    },
  ],
  schema: {
    labels: ["Customer", "Product"],
    edgeTypes: ["BOUGHT"],
    propertyKeys: { Customer: ["name", "customerId"], Product: ["name", "price"] },
  },
};

/** Neighbours the first answer does not contain, by node id. */
const NEIGHBOURHOOD: Record<string, GraphSet> = {
  p2: {
    nodes: [
      { id: "p2", labels: ["Product"], properties: { name: "Desk", price: 250 } },
      { id: "s1", labels: ["Supplier"], properties: { name: "Oak & Co" } },
    ],
    edges: [{ id: "m1", type: "MADE_BY", from: "p2", to: "s1", properties: {} }],
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

/** The answer of the fake graph source to a Cypher query. */
export function graphOutcome(cypher: string, variables: Record<string, unknown>): QueryOutcome {
  if (cypher.includes("elementId(n)")) {
    const id = String(variables[EXPAND_NODE_VARIABLE] ?? "");
    const graph = NEIGHBOURHOOD[id] ?? {
      nodes: [],
      edges: [],
      schema: { labels: [], edgeTypes: [], propertyKeys: {} },
    };
    return { result: { shape: "graph", graph } };
  }
  if (/shortestPath/i.test(cypher)) {
    return {
      result: {
        shape: "graph",
        graph: {
          ...FAKE_GRAPH,
          paths: [{ nodes: ["c2", "p1", "c1", "p2"], edges: ["b3", "b1", "b2"] }],
        },
      },
    };
  }
  if (/LIMIT 1\b/.test(cypher)) {
    return {
      result: {
        shape: "graph",
        graph: {
          ...FAKE_GRAPH,
          truncated: { limit: 4, reason: "graph.node_limit" },
          notices: [
            {
              severity: "warning",
              code: "graph.node_limit",
              params: { limit: "4" },
              text: "The graph was cut at 4 nodes.",
            },
          ],
        },
      },
    };
  }
  return { result: { shape: "graph", graph: FAKE_GRAPH } };
}
