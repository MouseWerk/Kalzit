import { describe, expect, it } from "vitest";
import type { GraphSet } from "../../api/generated/shapes";
import { graphOutcome, ID } from "../../features/datasources/test/fakeGraph";
import { type Translate, translate } from "../../i18n/i18n";
import {
  countQuery,
  expandQuery,
  explorationQuery,
  nodeCaption,
  nodesQuery,
  readTime,
  typedId,
} from "./adapter";
import { type GraphPalette, hex, mix } from "./colors";
import {
  DEFAULT_STYLE,
  DIM_EDGES_UP_TO,
  edgeColor,
  edgeDisplay,
  nodeDisplay,
  nodeToward,
} from "./drawing";
import { EDGE_CHUNK, handOver } from "./handover";
import { ForceLayout, hierarchyLayout, seedPositions } from "./layoutEngine";
import { communities, components } from "./metrics";
import { buildGraphModel, edgeTimes, edgeWidths, nodeSizes } from "./model";
import {
  AUTO_CLUSTER_EDGES,
  AUTO_CLUSTER_NODES,
  DEFAULT_NODE_LIMIT,
  parseGraphOptions,
} from "./options";
import { countText } from "./plural";
import { type RefreshRequest, refreshVisibility } from "./refresh";
import { labelWidth, layoutRequest } from "./useGraphLayout";
import {
  allVisible,
  buildView,
  type GraphView,
  LABEL_BUDGET,
  labelAllowed,
  labelRanks,
  rampGroup,
  shouldCluster,
  timeSteps,
  visibleAt,
} from "./view";

const schema = { labels: [], edgeTypes: [], propertyKeys: {} };

/** a -> b -> c, a -> c, d alone; edge times on days 1, 2 and 3. */
const SMALL: GraphSet = {
  nodes: [
    { id: "a", labels: ["Person"], properties: { name: "Ada" } },
    { id: "b", labels: ["Person"], properties: { name: "Bob", score: 10 } },
    { id: "c", labels: ["City"], properties: { title: "Graz" } },
    { id: "d", labels: [], properties: {} },
  ],
  edges: [
    { id: "ab", type: "KNOWS", from: "a", to: "b", properties: { since: "2026-01-01" } },
    { id: "bc", type: "LIVES_IN", from: "b", to: "c", properties: { since: "2026-01-02" } },
    { id: "ac", type: "LIVES_IN", from: "a", to: "c", properties: { since: "2026-01-03" } },
    { id: "xz", type: "KNOWS", from: "a", to: "zz", properties: {} },
  ],
  schema: { labels: ["Person", "City"], edgeTypes: [], propertyKeys: {} },
};

function model(sets: GraphSet[] = [SMALL], nodeLimit = 100) {
  return buildGraphModel(sets, { nodeLimit, caption: "" });
}

function view(m = model(), cluster = false, open = new Set<number>()): GraphView {
  return buildView(m, {
    sizes: nodeSizes(m, "degree"),
    widths: edgeWidths(m, ""),
    groups: Int32Array.from(m.nodes, (n) => n.label),
    cluster,
    open,
    clusterCaption: (label, members) => `${label} (${members})`,
    unlabelled: "none",
  });
}

describe("adapter", () => {
  it("reads times from ms, seconds, ISO text and typed values, and nothing else", () => {
    expect(readTime(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(readTime(1_800_000_000)).toBe(1_800_000_000_000);
    expect(readTime("2026-01-02T00:00:00Z")).toBe(Date.UTC(2026, 0, 2));
    expect(readTime({ $type: "dateTime", value: "2026-01-02T00:00:00Z" })).toBe(
      Date.UTC(2026, 0, 2),
    );
    expect(readTime({ $type: "duration", value: "P1D" })).toBeNull();
    expect(readTime("12345")).toBeNull();
    expect(readTime(Number.NaN)).toBeNull();
  });

  it("names nodes by the chosen property, the usual ones, or the readable id", () => {
    const node = { id: "Person:42", labels: ["Person"], properties: { title: "Dr", nick: "x" } };
    expect(nodeCaption(node, "nick")).toBe("x");
    expect(nodeCaption(node, "")).toBe("Dr");
    expect(nodeCaption({ ...node, properties: {} }, "")).toBe("42");
    // A colon that is not a type prefix stays.
    expect(typedId({ id: "4:abc:7", labels: ["Person"], properties: {} })).toBe("4:abc:7");
  });

  it("builds expand queries with the node id as a parameter, and none for TigerGraph", () => {
    const neo = expandQuery("neo4j", "4:abc:7", { limit: 500 });
    expect(neo?.query).toEqual({
      cypher: [
        "MATCH (n)-[e]-(m) WHERE elementId(n) = $nodeId",
        "WITH DISTINCT n, m ORDER BY COUNT { (m)--() } DESC, elementId(m) SKIP 0 LIMIT 200",
        "MATCH (n)-[r]-(m)",
        "RETURN n, r, m",
      ].join("\n"),
    });
    expect(neo?.variables).toEqual({ nodeId: "4:abc:7" });
    // Bolt 4.4 sends the internal number.
    expect(JSON.stringify(expandQuery("neo4j", "17", { limit: 5 })?.query)).toContain(
      "id(n) = toInteger",
    );
    const typed = expandQuery("memgraph", "17", {
      limit: 5,
      skip: 10,
      types: ["KNOWS", "a`b"],
      direction: "out",
    });
    const memgraph = JSON.stringify(typed?.query);
    expect(memgraph).toContain("SKIP 10 LIMIT 5");
    expect(memgraph).toContain("degree(m)");
    // Types are a parameter, never part of the text.
    expect(memgraph).toContain("(n)-[r]->(m) WHERE type(r) IN $edgeTypes");
    expect(memgraph).not.toContain("KNOWS");
    expect(typed?.variables).toEqual({ nodeId: "17", edgeTypes: ["KNOWS", "a`b"] });
    expect(expandQuery("tigergraph", "Person:1", { limit: 5 })).toBeNull();
    expect(JSON.stringify(countQuery("neo4j", "4:a:1", { direction: "in" })?.query)).toContain(
      "(n)<-[e]-(m) WHERE elementId(n) = $nodeId RETURN count(DISTINCT m) AS total",
    );
  });

  it("builds the queries for pinned nodes and for Explore", () => {
    expect(nodesQuery("neo4j", ["4:a:1"])).toEqual({
      query: { cypher: "MATCH (n) WHERE elementId(n) IN $nodeIds RETURN n" },
      variables: { nodeIds: ["4:a:1"] },
    });
    // Numeric ids are matched as numbers, so the database seeks them.
    expect(JSON.stringify(nodesQuery("memgraph", ["1", "2"])?.query)).toContain(
      "id(n) IN [x IN $nodeIds | toInteger(x)]",
    );
    expect(nodesQuery("tigergraph", ["a"])).toBeNull();
    expect(explorationQuery("neo4j", ["4:a:1", '4:a:"2'])).toBe(
      [
        'WITH ["4:a:1", "4:a:\\"2"] AS ids',
        "MATCH (n) WHERE elementId(n) IN ids",
        "OPTIONAL MATCH (n)-[r]->(m) WHERE elementId(m) IN ids",
        "RETURN n, r, m",
      ].join("\n"),
    );
    expect(explorationQuery("memgraph", ["1", "2"])).toContain("WITH [1, 2] AS ids");
    expect(explorationQuery("neo4j", [])).toBeNull();
    expect(
      explorationQuery(
        "neo4j",
        Array.from({ length: 1_001 }, (_, i) => String(i)),
      ),
    ).toBeNull();
  });

  it("keeps panel options within their limits", () => {
    const options = parseGraphOptions({ nodeLimit: 99_999, expandLimit: 0, variable: "$id" });
    expect(options.nodeLimit).toBe(20_000);
    expect(options.expandLimit).toBe(1);
    expect(options.variable).toBe("id");
    expect(parseGraphOptions(null).sizeBy).toBe("degree");
  });
});

describe("model", () => {
  it("merges results by id, counts degrees and edges to missing nodes", () => {
    const more: GraphSet = {
      nodes: [{ id: "a", labels: ["Admin"], properties: { age: 3 } }],
      edges: [{ id: "da", type: "KNOWS", from: "d", to: "a", properties: {} }],
      schema,
    };
    const m = model([SMALL, more]);
    expect(m.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    const a = m.nodes[0];
    expect(a?.labels).toEqual(["Person", "Admin"]);
    expect(a?.properties).toEqual({ name: "Ada", age: 3 });
    expect([a?.degree, a?.inDegree, a?.outDegree]).toEqual([3, 1, 2]);
    expect(m.dangling).toBe(1);
    // A label first seen on a later node joins the colors after the schema's labels.
    expect(m.labels).toEqual(["Person", "City", "Admin"]);
  });

  it("keeps the best connected nodes over the limit and says so", () => {
    // a, b and c have two edges each, d none: ties keep the order of the result.
    const m = model([SMALL], 2);
    expect(m.cut).toBe(true);
    expect(m.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(m.total.nodes).toBe(4);
    expect(m.edges.map((e) => e.id)).toEqual(["ab"]);
  });

  it("takes the source's notices and names the limit of a cut without one", () => {
    const wire = { ...SMALL, truncated: { limit: 4, reason: "graph.edge_limit" } };
    const m = model([wire as GraphSet]);
    expect(m.truncated).toBe(true);
    // A code to translate, not English text of its own.
    expect(m.notices.map((n) => [n.code, n.params?.limit, n.text])).toEqual([
      ["graph.edge_limit", "4", ""],
    ]);
    // Malformed extras are ignored rather than shown.
    const odd = { ...SMALL, notices: [{ code: 7 }, "x"], truncated: { limit: 1, reason: 3 } };
    expect(model([odd as unknown as GraphSet]).notices).toEqual([]);
  });

  it("sizes by degree or property and reads edge times", () => {
    const m = model();
    const sizes = nodeSizes(m, "degree");
    expect(sizes[0]).toBeGreaterThan(sizes[3] as number);
    const byScore = nodeSizes(m, "score");
    expect(byScore[1]).toBeGreaterThan(byScore[0] as number);
    expect([...edgeTimes(m, "since")]).toEqual([
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 2),
      Date.UTC(2026, 0, 3),
    ]);
  });
});

describe("metrics", () => {
  it("finds components, largest first", () => {
    const parts = components(model());
    expect(parts.sizes).toEqual([3, 1]);
    expect([...parts.of]).toEqual([0, 0, 0, 1]);
  });

  it("finds the same communities every time and skips large graphs", async () => {
    // Two triangles joined by one edge.
    const nodes = ["a", "b", "c", "x", "y", "z"].map((id) => ({ id, labels: [], properties: {} }));
    const pairs = ["ab", "bc", "ca", "xy", "yz", "zx", "cx"];
    const edges = pairs.map((p) => ({
      id: p,
      type: "T",
      from: p[0] as string,
      to: p[1] as string,
      properties: {},
    }));
    const m = model([{ nodes, edges, schema }]);
    const first = await communities(m);
    expect(first?.count).toBe(2);
    expect(first?.of[0]).toBe(first?.of[1]);
    expect(first?.of[0]).not.toBe(first?.of[4]);
    expect([...((await communities(m))?.of ?? [])]).toEqual([...(first?.of ?? [])]);
  });
});

describe("view", () => {
  it("groups nodes by label, merges their edges, and opens a group", () => {
    const m = model();
    const grouped = view(m, true);
    expect(grouped.nodes.map((n) => n.caption)).toEqual(["Person (2)", "City (1)", "none (1)"]);
    expect(grouped.edges).toHaveLength(1);
    expect(grouped.edges[0]?.count).toBe(2);
    const opened = view(m, true, new Set([0]));
    expect(opened.nodes.map((n) => n.caption)).toEqual(["Ada", "Bob", "City (1)", "none (1)"]);
    const limits = { nodes: AUTO_CLUSTER_NODES, edges: AUTO_CLUSTER_EDGES };
    // A graph at the default node limit is grouped: the threshold lies below it.
    expect(shouldCluster("auto", { nodes: DEFAULT_NODE_LIMIT, edges: 0 }, limits)).toBe(true);
    // Few nodes but many edges are grouped too, whichever comes first.
    expect(shouldCluster("auto", { nodes: 1_500, edges: 9_000 }, limits)).toBe(true);
    expect(shouldCluster("auto", { nodes: 2_000, edges: 8_000 }, limits)).toBe(false);
    expect(shouldCluster("off", { nodes: 50_000, edges: 0 }, limits)).toBe(false);
    expect(shouldCluster("label", { nodes: 3, edges: 0 }, limits)).toBe(true);
  });

  it("shows the graph at a time: later edges and nodes reached only by them are hidden", () => {
    const m = model();
    const v = view(m);
    const times = edgeTimes(m, "since");
    expect(timeSteps(times)).toHaveLength(3);
    const at = visibleAt(m, v, times, Date.UTC(2026, 0, 1));
    expect([...at.edges]).toEqual([1, 0, 0]);
    // c is reached on day 2 only; d has no timed edge and always shows.
    expect([...at.nodes]).toEqual([1, 1, 0, 1]);
    expect([...allVisible(v).nodes]).toEqual([1, 1, 1, 1]);
  });

  it("shows more labels as one zooms in, best connected first", () => {
    const ranks = labelRanks(view());
    expect(ranks[0]).toBe(0);
    expect(labelAllowed(LABEL_BUDGET - 1, 1, false)).toBe(true);
    expect(labelAllowed(LABEL_BUDGET, 1, false)).toBe(false);
    expect(labelAllowed(LABEL_BUDGET * 3, 0.5, false)).toBe(true);
    expect(labelAllowed(10_000, 1, true)).toBe(true);
  });
});

describe("layout", () => {
  it("lays out layers top down and reverses edges that close a cycle", () => {
    const m = model([
      {
        nodes: ["r", "a", "b", "c"].map((id) => ({ id, labels: [], properties: {} })),
        edges: [
          { id: "1", type: "T", from: "r", to: "a", properties: {} },
          { id: "2", type: "T", from: "a", to: "b", properties: {} },
          { id: "3", type: "T", from: "r", to: "c", properties: {} },
          { id: "4", type: "T", from: "b", to: "r", properties: {} },
        ],
        schema,
      },
    ]);
    const result = hierarchyLayout(layoutRequest(view(m), "hierarchy", 1, new Map()));
    expect(result.reversed).toBe(1);
    expect(result.layers).toBe(3);
    const y = (i: number) => result.positions[2 * i + 1] as number;
    expect(y(0)).toBeGreaterThan(y(1));
    expect(y(1)).toBeGreaterThan(y(2));
    expect(y(3)).toBe(y(1));
  });

  it("spaces a layer's nodes by their size and label, so no label lies over a neighbour", () => {
    // A root with three leaves of long and short names, as in a category tree.
    const names = ["All products", "Office", "Seating", "Electronics"];
    const sizes = Float32Array.from([14, 14, 4, 4]);
    const labels = Float32Array.from(names, (name) => labelWidth(name));
    const result = hierarchyLayout({
      count: 4,
      sources: Uint32Array.from([0, 0, 0]),
      targets: Uint32Array.from([1, 2, 3]),
      weights: new Float32Array(3).fill(1),
      sizes,
      labels,
    });
    const x = (i: number) => result.positions[2 * i] as number;
    const row = [1, 2, 3].sort((a, b) => x(a) - x(b));
    for (let k = 1; k < row.length; k++) {
      const left = row[k - 1] as number;
      const right = row[k] as number;
      // The left node's circle and label end before the right node's circle starts.
      const leftEnd = x(left) + (sizes[left] as number) + (labels[left] as number);
      expect(x(right) - (sizes[right] as number)).toBeGreaterThan(leftEnd);
    }
    // The layer is centred under its root, label included.
    const first = row[0] as number;
    const last = row.at(-1) as number;
    expect(x(first) + x(last) + (labels[last] as number)).toBeCloseTo(0, 3);
  });

  it("estimates label widths by length, capped for long names", () => {
    expect(labelWidth("")).toBe(0);
    expect(labelWidth("Office")).toBeLessThan(labelWidth("Electronics"));
    expect(labelWidth("x".repeat(200))).toBe(labelWidth("x".repeat(24)));
  });

  it("moves nodes with the force layout and keeps positions finite", () => {
    const request = layoutRequest(view(), "force", 1, new Map());
    const layout = new ForceLayout(request, request.start);
    layout.step(20);
    const after = layout.positions();
    expect([...after].every(Number.isFinite)).toBe(true);
    expect([...after]).not.toEqual([...seedPositions(4)]);
  });

  it("starts known nodes where they were and new ones beside a placed neighbour", () => {
    const v = view();
    const placed = new Map<string, [number, number]>([["n:a", [500, 500]]]);
    const start = layoutRequest(v, "force", 1, placed).start;
    expect([start[0], start[1]]).toEqual([500, 500]);
    expect(Math.hypot((start[2] as number) - 500, (start[3] as number) - 500)).toBeCloseTo(12, 3);
  });
});

describe("drawing", () => {
  const palette: GraphPalette = {
    series: ["#111111", "#222222"],
    dimmed: ["#eeeeee", "#dddddd"],
    neutral: "#333333",
    neutralDimmed: "#cccccc",
    edge: "#444444",
    edgeDimmed: "#bbbbbb",
    text: "#000000",
    background: "#ffffff",
    font: "sans-serif",
    boldWeight: "600",
    selection: "#f0f0f0",
    ramps: { blues: ["#b1", "#b2", "#b3", "#b4", "#b5"], gyr: [], grays: [] },
    dimmedRamps: { blues: ["#d1", "#d2", "#d3", "#d4", "#d5"], gyr: [], grays: [] },
  };
  const base = { x: 0, y: 0, size: 5, label: "x" } as never;

  it("dims all but the selection and its neighbours, and gives the selection label and weight", () => {
    const v = view();
    const props = {
      view: v,
      palette,
      visibility: allVisible(v),
      ranks: labelRanks(v),
      selected: new Set([0]),
      neighbours: new Set([1]),
      drawStyle: DEFAULT_STYLE,
    };
    const selected = nodeDisplay(0, base, props, 1);
    // The selection's label sits on the neutral selection tint, the others on the canvas.
    expect(selected.labelBackgroundColor).toBe("#f0f0f0");
    expect(nodeDisplay(1, base, props, 1).labelBackgroundColor).toBe("#ffffff");
    expect(selected.color).toBe("#111111");
    expect(selected.labelVisibility).toBe("visible");
    expect(selected.labelFont).toBe("600 sans-serif");
    expect(selected.size).toBeGreaterThan(5);
    expect(nodeDisplay(1, base, props, 1).color).toBe("#111111");
    const other = nodeDisplay(2, base, props, 1);
    expect(other.color).toBe("#dddddd");
    expect(other.labelVisibility).toBe("hidden");
    // Dropped, so the renderer does not lay it out.
    expect(other.label).toBeNull();
    // No frame or glow of any kind: the renderer's backdrop stays off.
    expect(Object.keys(selected).some((key) => key.startsWith("backdrop"))).toBe(false);
    const none = nodeDisplay(2, base, { ...props, selected: new Set<number>() }, 1);
    expect(none.color).toBe("#222222");
    // Edges the selection does not touch are dimmed too.
    expect(edgeColor({ source: 0, target: 1 }, props)).toBe("#444444");
    expect(edgeColor({ source: 1, target: 2 }, props)).toBe("#bbbbbb");
  });

  it("draws arrows, edge labels and node labels as the panel's style says", () => {
    const v = view();
    const props = {
      view: v,
      palette,
      visibility: allVisible(v),
      ranks: labelRanks(v),
      selected: new Set([0]),
      neighbours: new Set<number>(),
      drawStyle: { ...DEFAULT_STYLE, arrows: "selection" as const, edgeLabels: "always" as const },
    };
    const edge = { size: 1 } as never;
    const touching = v.edges.findIndex((e) => e.source === 0 || e.target === 0);
    const away = v.edges.findIndex((e) => e.source !== 0 && e.target !== 0);
    expect(edgeDisplay(touching, edge, props).head).toBe("arrow");
    expect(edgeDisplay(away, edge, props).head).toBeUndefined();
    expect(edgeDisplay(away, edge, props).label).toBe(v.edges[away]?.type);
    const never = { ...props, drawStyle: { ...props.drawStyle, edgeLabels: "never" as const } };
    expect(edgeDisplay(touching, edge, never).label).toBeNull();
    // Only the selection labelled; every node labelled.
    const onlySelected = {
      ...props,
      drawStyle: { ...DEFAULT_STYLE, labels: "selection" as const },
    };
    expect(
      nodeDisplay(1, base, { ...onlySelected, selected: new Set<number>() }, 1).label,
    ).toBeNull();
    const always = {
      ...props,
      selected: new Set<number>(),
      drawStyle: { ...DEFAULT_STYLE, labels: "always" as const },
    };
    expect(nodeDisplay(1, base, always, 100).labelVisibility).toBe("visible");
  });

  it("colors nodes by a ramp step of the panel's scheme", () => {
    const v = view();
    const ramped = { ...v, nodes: v.nodes.map((n) => ({ ...n, group: rampGroup(3) })) };
    const props = {
      view: ramped,
      palette,
      visibility: allVisible(ramped),
      ranks: labelRanks(ramped),
      selected: new Set<number>(),
      neighbours: new Set<number>(),
      drawStyle: DEFAULT_STYLE,
    };
    expect(nodeDisplay(0, base, props, 1).color).toBe("#b4");
    expect(nodeDisplay(1, base, { ...props, selected: new Set([0]) }, 1).color).toBe("#d4");
  });

  it("keeps the edges of large graphs undimmed, so a selection redraws only nodes", () => {
    const v = view();
    const many = { ...v, edges: Array.from({ length: DIM_EDGES_UP_TO + 1 }, () => v.edges[0]) };
    expect(
      edgeColor(
        { source: 1, target: 2 },
        { view: many as GraphView, palette, selected: new Set([0]) },
      ),
    ).toBe("#444444");
  });

  it("moves the keyboard selection to the nearest node in a direction", () => {
    const v = view();
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 1 },
      { x: 0, y: 10 },
      { x: -10, y: 0 },
    ];
    const toward = (from: number | null, d: "left" | "right" | "up" | "down") =>
      nodeToward(
        v,
        allVisible(v),
        labelRanks(v),
        from,
        d,
        (i) => points[i],
        (p) => p,
      );
    expect(toward(null, "right")).toBe(0);
    expect(toward(0, "right")).toBe(1);
    expect(toward(0, "down")).toBe(2);
    expect(toward(0, "left")).toBe(3);
    expect(toward(0, "up")).toBeNull();
  });

  it("mixes dimmed colors toward the background", () => {
    expect(hex(mix([0, 0, 0], [255, 255, 255], 0.5))).toBe("#808080");
  });
});

describe("handover", () => {
  it("creates the renderer with the nodes and first edges, then adds a chunk per frame", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      labels: [],
      properties: {},
    }));
    const edges = Array.from({ length: EDGE_CHUNK * 2 + 5 }, (_, i) => ({
      id: `e${i}`,
      type: "T",
      from: `n${i % 10}`,
      to: `n${(i + 1) % 10}`,
      properties: {},
    }));
    const v = view(model([{ nodes, edges, schema }]));
    const frames: (() => void)[] = [];
    const created: number[] = [];
    const handover = handOver(
      v,
      seedPositions(10),
      (graph) => created.push(graph.order, graph.size),
      { schedule: (cb) => frames.push(cb), cancel: () => undefined },
    );
    expect(created).toEqual([10, EDGE_CHUNK]);
    frames.shift()?.();
    expect(handover.graph.size).toBe(EDGE_CHUNK * 2);
    frames.shift()?.();
    expect(handover.graph.size).toBe(EDGE_CHUNK * 2 + 5);
    expect(frames).toHaveLength(0);
  });

  it("stops adding edges when cancelled", () => {
    const nodes = [{ id: "a", labels: [], properties: {} }];
    const edges = Array.from({ length: EDGE_CHUNK + 1 }, (_, i) => ({
      id: `e${i}`,
      type: "T",
      from: "a",
      to: "a",
      properties: {},
    }));
    const cancelled: number[] = [];
    const handover = handOver(view(model([{ nodes, edges, schema }])), seedPositions(1), () => 0, {
      schedule: () => 7,
      cancel: (handle) => cancelled.push(handle),
    });
    handover.cancel();
    expect(cancelled).toEqual([7]);
  });
});

describe("refreshing visibility", () => {
  function bigView(edges: number) {
    const v = view();
    return { ...v, edges: Array.from({ length: edges }, () => v.edges[0]) } as GraphView;
  }

  it("draws only the nodes and edges whose visibility changed in large graphs", () => {
    const v = bigView(DIM_EDGES_UP_TO + 1);
    const before = allVisible(v);
    const after = { nodes: before.nodes.slice(), edges: before.edges.slice() };
    after.nodes[2] = 0;
    after.edges[5] = 0;
    const requests: RefreshRequest[] = [];
    refreshVisibility({ refresh: (r) => requests.push(r) }, v, before, after);
    expect(requests).toEqual([
      { skipIndexation: true, partialGraph: { nodes: ["2"], edges: ["e5"] } },
    ]);
    // Nothing changed, nothing drawn.
    refreshVisibility({ refresh: (r) => requests.push(r) }, v, after, after);
    expect(requests).toHaveLength(1);
  });

  it("draws everything the first time and in graphs that dim edges", () => {
    const requests: RefreshRequest[] = [];
    const small = view();
    refreshVisibility(
      { refresh: (r) => requests.push(r) },
      small,
      allVisible(small),
      allVisible(small),
    );
    const big = bigView(DIM_EDGES_UP_TO + 1);
    refreshVisibility({ refresh: (r) => requests.push(r) }, big, null, allVisible(big));
    expect(requests).toEqual([{ skipIndexation: true }, { skipIndexation: true }]);
  });
});

describe("the fake graph source", () => {
  it("answers both forms of the expand query", () => {
    const byElement = expandQuery("neo4j", ID.desk, { limit: 10 });
    const byNumber = expandQuery("memgraph", "12", { limit: 10 });
    for (const request of [byElement, byNumber]) {
      const cypher = String((request?.query as { cypher?: string } | undefined)?.cypher);
      const outcome = graphOutcome(cypher, request?.variables ?? {});
      const graph =
        "result" in outcome && outcome.result.shape === "graph" ? outcome.result.graph : null;
      expect(graph?.nodes.map((n) => n.id)).toEqual([ID.desk, ID.oak]);
    }
  });
});

describe("counts", () => {
  it("use the singular for one and the plural otherwise, in both languages", () => {
    const en: Translate = (key, params) => translate("en", key, params);
    const de: Translate = (key, params) => translate("de", key, params);
    expect(countText(en, "en", "component", 1)).toBe("1 component");
    expect(countText(en, "en", "component", 3)).toBe("3 components");
    expect(countText(en, "en", "edge", 1_200)).toBe("1,200 edges");
    expect(countText(de, "de", "edge", 1)).toBe("1 Kante");
    expect(countText(de, "de", "community", 2)).toBe("2 Communities");
  });
});
