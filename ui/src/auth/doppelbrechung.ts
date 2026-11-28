/**
 * The picture in the panel of the pages before the app (board Auth.dc.html, frames 3A and 13,
 * variant B "Doppelbrechung"): the lines of a table, a document and a graph run behind a calcite
 * crystal and become clear and double inside it, as calcite shows everything behind it twice.
 * Here is the drawing itself, as numbers; Backdrop.tsx draws it and auth.css colors it.
 *
 * All of it is abstract: lines for rows, keys and edges, no words and no figures, so the picture
 * claims nothing the product does not do.
 *
 * Units are the board's (its drawing is 700 by 760). The crystal is Kalzit's mark; a test holds
 * the two against each other. Around the board's drawing the table goes on to the left and the
 * graph to the right, fainter with the distance, for the panel of a very wide window. Both run
 * out of the drawing's box with open lines, so neither ends at an edge inside a panel.
 */

/** A point in the drawing's units. */
export type Point = readonly [x: number, y: number];

/** How far from the crystal a part lies: it is drawn fainter with each step. */
export type Tier = "near" | "mid" | "far";
export const TIERS: readonly Tier[] = ["far", "mid", "near"];

/** The corners of the crystal, clockwise from the left one, and the corner inside. */
export const CRYSTAL_CORNERS: readonly Point[] = [
  [168, 266],
  [268, 170],
  [524, 126],
  [564, 428],
  [475, 526],
  [224, 573],
];
export const CRYSTAL_INNER: Point = [424, 224];

/** The middle of the crystal: the picture is placed by it. */
export const CENTER: Point = [366, 350];

/**
 * The drawing's box, the same distance to every side of the crystal's middle, and the part of
 * it that always fits into the panel: the crystal with the table, document and graph of the
 * board. What lies outside that part shows only where the panel has room for it.
 */
export const VIEW = { x: CENTER[0] - 1250, y: CENTER[1] - 600, width: 2500, height: 1200 } as const;
export const CORE = { width: 720, height: 900 } as const;

/** How far the second image inside the crystal stands from the first. */
export const ECHO: Point = [11, 7];

const point = ([x, y]: Point) => `${x} ${y}`;
const polygon = (points: readonly Point[]) => `M${points.map(point).join(" ")}Z`;

const [LEFT, TOP_LEFT, TOP_RIGHT, RIGHT, BOTTOM_RIGHT] = CRYSTAL_CORNERS as [
  Point,
  Point,
  Point,
  Point,
  Point,
  Point,
];

export const CRYSTAL = {
  /** The outer edge, from the left corner over the top and back along the bottom. */
  outline: polygon(CRYSTAL_CORNERS),
  /** The three edges that meet inside. */
  ridges: `M${point(LEFT)} ${point(CRYSTAL_INNER)} ${point(BOTTOM_RIGHT)}M${point(CRYSTAL_INNER)} ${point(TOP_RIGHT)}`,
  /** The face on top and the one on the right, each a flat tint; the front has none. */
  top: polygon([LEFT, TOP_LEFT, TOP_RIGHT, CRYSTAL_INNER]),
  side: polygon([CRYSTAL_INNER, TOP_RIGHT, RIGHT, BOTTOM_RIGHT]),
} as const;

/*
 * The table: rows and columns, and a short line in each cell where a value stands. The board's
 * four column lines lie half behind the crystal; more go on to the left, and the rows run on
 * past the last of them to the drawing's left bound.
 */
const TABLE_ROWS = [250, 290, 330, 370, 410, 450] as const;
const TABLE_COLUMNS: readonly { x: number; tier: Tier }[] = [
  { x: -810, tier: "far" },
  { x: -725, tier: "far" },
  { x: -640, tier: "far" },
  { x: -555, tier: "far" },
  { x: -470, tier: "far" },
  { x: -385, tier: "far" },
  { x: -300, tier: "far" },
  { x: -215, tier: "far" },
  { x: -130, tier: "mid" },
  { x: -45, tier: "mid" },
  { x: 40, tier: "near" },
  { x: 120, tier: "near" },
  { x: 205, tier: "near" },
  { x: 290, tier: "near" },
];
/** The values of the three columns of the board, row by row: text, text, a number at the right. */
const TABLE_VALUES: readonly (readonly [number, number, number])[] = [
  [44, 30, 26],
  [58, 46, 34],
  [36, 38, 22],
  [52, 24, 30],
  [40, 42, 26],
];
const CELL_INSET = 14;

function tablePaths(): Record<Tier, string> {
  const top = TABLE_ROWS[0];
  const bottom = TABLE_ROWS[TABLE_ROWS.length - 1] as number;
  const paths: Record<Tier, string[]> = { near: [], mid: [], far: [] };
  // Each tier draws the rows from its first column line to the next tier's.
  for (const tier of TIERS) {
    const own = TABLE_COLUMNS.filter((column) => column.tier === tier);
    const first = own[0]?.x;
    if (first === undefined) {
      continue;
    }
    // The farthest rows start at the drawing's bound: open, with no line closing the table.
    const from = tier === "far" ? VIEW.x : first;
    const after = TABLE_COLUMNS.find((column) => column.x > (own[own.length - 1]?.x ?? from));
    const to = after?.x ?? (own[own.length - 1]?.x as number);
    for (const y of TABLE_ROWS) {
      paths[tier].push(`M${from} ${y}H${to}`);
    }
    for (const { x } of own) {
      paths[tier].push(`M${x} ${top}V${bottom}`);
    }
  }
  const near = TABLE_COLUMNS.filter((column) => column.tier === "near").map((column) => column.x);
  TABLE_VALUES.forEach((row, index) => {
    const y = (TABLE_ROWS[index] as number) + 20;
    row.forEach((length, cell) => {
      const left = near[cell] as number;
      const right = near[cell + 1] as number;
      // The last column holds numbers: they end at the right.
      const start = cell === row.length - 1 ? right - CELL_INSET - length : left + CELL_INSET;
      paths.near.push(`M${start} ${y}h${length}`);
    });
  });
  return { near: paths.near.join(""), mid: paths.mid.join(""), far: paths.far.join("") };
}

/*
 * The document: a key and its value per line, children indented under their parent, with the
 * rule that ties siblings together. It lies inside the crystal alone: structure that shows only
 * there.
 */
const DOCUMENT_LINES: readonly { x: number; y: number; key: number; value?: number }[] = [
  { x: 300, y: 300, key: 64 },
  { x: 322, y: 335, key: 34, value: 58 },
  { x: 322, y: 370, key: 46 },
  { x: 344, y: 405, key: 30, value: 72 },
  { x: 344, y: 440, key: 40, value: 28 },
  { x: 322, y: 475, key: 28, value: 60 },
];
const DOCUMENT_GAP = 12;
const DOCUMENT_RULES = "M306 314V475M328 384V440";

function documentPath(): string {
  const lines = DOCUMENT_LINES.map(({ x, y, key, value }) =>
    value === undefined
      ? `M${x} ${y}h${key}`
      : `M${x} ${y}h${key}M${x + key + DOCUMENT_GAP} ${y}h${value}`,
  );
  return `${lines.join("")}${DOCUMENT_RULES}`;
}

/*
 * The graph: nodes as the rhombus of Kalzit's icons, edges from middle to middle (the nodes are
 * filled, so an edge ends at a node's rim). The board's seven nodes lie around the crystal's right
 * face; the others go on to the right.
 */
export const GRAPH_NODES: readonly { at: Point; tier: Tier }[] = [
  { at: [470, 250], tier: "near" },
  { at: [540, 200], tier: "near" },
  { at: [590, 300], tier: "near" },
  { at: [430, 330], tier: "near" },
  { at: [640, 380], tier: "near" },
  { at: [520, 390], tier: "near" },
  { at: [560, 470], tier: "near" },
  { at: [712, 246], tier: "mid" },
  { at: [736, 452], tier: "mid" },
  { at: [668, 548], tier: "mid" },
  { at: [822, 338], tier: "far" },
  { at: [846, 176], tier: "far" },
  { at: [900, 486], tier: "far" },
  { at: [978, 372], tier: "far" },
  { at: [806, 590], tier: "far" },
  { at: [1030, 236], tier: "far" },
  { at: [1084, 500], tier: "far" },
  { at: [1150, 356], tier: "far" },
  { at: [1196, 196], tier: "far" },
  { at: [1250, 520], tier: "far" },
  { at: [1322, 318], tier: "far" },
  { at: [1392, 566], tier: "far" },
  { at: [1436, 188], tier: "far" },
  { at: [1516, 404], tier: "far" },
  { at: [1572, 262], tier: "far" },
];
export const GRAPH_EDGES: readonly (readonly [from: number, to: number])[] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [2, 4],
  [2, 5],
  [3, 5],
  [5, 6],
  [1, 7],
  [2, 7],
  [4, 8],
  [6, 9],
  [8, 9],
  [7, 10],
  [7, 11],
  [8, 12],
  [10, 13],
  [12, 13],
  [9, 14],
  [14, 12],
  [11, 15],
  [13, 15],
  [13, 16],
  [15, 17],
  [15, 18],
  [16, 17],
  [16, 19],
  [17, 20],
  [18, 20],
  [18, 22],
  [19, 21],
  [20, 23],
  [21, 23],
  [22, 24],
  [23, 24],
];
/** Edges that leave the drawing at its right bound, to nodes that are not in the picture. */
export const GRAPH_OPEN_EDGES: readonly (readonly [from: number, to: Point])[] = [
  [24, [1640, 222]],
  [23, [1640, 452]],
  [21, [1640, 628]],
];
/** Half a node's diagonal. */
export const NODE_RADIUS = 12;

const ORDER: Record<Tier, number> = { near: 0, mid: 1, far: 2 };

function graphPaths(): Record<Tier, { edges: string; nodes: string }> {
  const paths: Record<Tier, { edges: string[]; nodes: string[] }> = {
    near: { edges: [], nodes: [] },
    mid: { edges: [], nodes: [] },
    far: { edges: [], nodes: [] },
  };
  for (const [from, to] of GRAPH_EDGES) {
    const a = GRAPH_NODES[from];
    const b = GRAPH_NODES[to];
    if (a === undefined || b === undefined) {
      continue;
    }
    // An edge is as faint as its farther end.
    const tier = ORDER[a.tier] >= ORDER[b.tier] ? a.tier : b.tier;
    paths[tier].edges.push(`M${point(a.at)} ${point(b.at)}`);
  }
  for (const [from, to] of GRAPH_OPEN_EDGES) {
    const a = GRAPH_NODES[from];
    if (a !== undefined) {
      paths.far.edges.push(`M${point(a.at)} ${point(to)}`);
    }
  }
  for (const { at, tier } of GRAPH_NODES) {
    const [x, y] = at;
    const r = NODE_RADIUS;
    paths[tier].nodes.push(`M${x} ${y - r} ${x + r} ${y} ${x} ${y + r} ${x - r} ${y}Z`);
  }
  const join = (tier: Tier) => ({
    edges: paths[tier].edges.join(""),
    nodes: paths[tier].nodes.join(""),
  });
  return { near: join("near"), mid: join("mid"), far: join("far") };
}

/** What one tier of the drawing holds: the lines, and the graph's nodes, which are filled. */
export interface Scene {
  lines: string;
  nodes: string;
}

function build(): Record<Tier, Scene> {
  const table = tablePaths();
  const graph = graphPaths();
  return {
    near: { lines: `${table.near}${documentPath()}${graph.near.edges}`, nodes: graph.near.nodes },
    mid: { lines: `${table.mid}${graph.mid.edges}`, nodes: graph.mid.nodes },
    far: { lines: `${table.far}${graph.far.edges}`, nodes: graph.far.nodes },
  };
}

/**
 * The drawing by tier. "near" is the board's drawing and the only part that reaches into the
 * crystal; it is drawn three times: faint behind it, and clear and double inside.
 */
export const SCENE: Record<Tier, Scene> = build();
