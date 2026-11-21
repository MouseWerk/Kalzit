import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphModel } from "../model";
import type { GraphView, Visibility } from "../view";
import { exportScope, scopeCounts } from "./dataScope";
import { isWinAnsi, pdfColor, picturePdf, type TextImage } from "./pdf";
import { composePicture, type MeasureAt, type Op, type PictureParts } from "./picture";
import { pngScale } from "./raster";
import { frameScene, recolorScene, type Scene, type SceneNode } from "./scene";
import { pictureSvg, xmlText } from "./svg";

function node(index: number, x: number, y: number, more: Partial<SceneNode> = {}): SceneNode {
  return {
    index,
    x,
    y,
    radius: 8,
    shape: "circle",
    color: "#336699",
    label: null,
    labelShown: false,
    labelForced: false,
    selected: false,
    rank: index,
    ...more,
  };
}

/** Three nodes in the panel, a fourth the camera left out to the right. */
function scene(): Scene {
  return {
    width: 400,
    height: 300,
    nodes: [
      node(0, 100, 100, { label: "Ada & <Co>", labelShown: true, color: "#112233" }),
      node(1, 300, 100, { shape: "square", label: "Bob" }),
      node(2, 200, 250, {
        shape: "diamond",
        label: "Zoë",
        labelShown: true,
        labelForced: true,
        selected: true,
      }),
      node(3, 900, 100, { label: "Far" }),
    ],
    edges: [
      { source: 0, target: 1, color: "#999999", width: 1, arrow: true, label: "KNOWS" },
      { source: 2, target: 2, color: "#999999", width: 1, arrow: false, label: null },
      { source: 1, target: 3, color: "#999999", width: 2, arrow: false, label: null },
    ],
    colors: { text: "#000000", background: "#ffffff", selection: "#eeeeee" },
    font: '"Instrument Sans Variable", system-ui, sans-serif',
    boldWeight: "600",
    labelSize: 14,
  };
}

const measure: MeasureAt = (text, size) => text.length * size * 0.5;
const labelMeasure = (text: string) => measure(text, 14, false);

const PARTS: PictureParts = {
  background: "#ffffff",
  caption: { title: "Customers", lines: ["Graph DB", "1 Jan – 2 Jan"] },
  legend: {
    entries: [
      { name: "Person", shape: "circle", color: "#112233", count: "3" },
      { name: "Order", shape: "square", color: "#336699", count: "1" },
    ],
    ramp: null,
    notes: ["Size by number of edges"],
  },
  note: "3 of 4 nodes shown",
  title: "Customers",
};

function ops(kind: Op["kind"], list: readonly Op[]): Op[] {
  return list.filter((op) => op.kind === kind);
}

describe("the scene of a picture", () => {
  it("keeps the visible part as the panel shows it", () => {
    const framed = frameScene(scene(), "view", labelMeasure);
    expect([framed.width, framed.height, framed.clipped]).toEqual([400, 300, true]);
    // Only the labels the panel shows right now.
    expect([...framed.labelled]).toEqual([0, 2]);
    expect(framed.nodes.map((n) => [n.x, n.y])).toEqual(scene().nodes.map((n) => [n.x, n.y]));
  });

  it("fits the whole graph and decides again which labels have room", () => {
    const framed = frameScene(scene(), "all", labelMeasure);
    expect(framed.clipped).toBe(false);
    expect(framed.nodes).toHaveLength(4);
    for (const n of framed.nodes) {
      expect(n.x - n.radius).toBeGreaterThanOrEqual(0);
      expect(n.x + n.radius).toBeLessThanOrEqual(framed.width);
      expect(n.y - n.radius).toBeGreaterThanOrEqual(0);
      expect(n.y + n.radius).toBeLessThanOrEqual(framed.height);
    }
    // Fitted into the panel's width: the far node moved in, the order from left to right stays.
    const xs = framed.nodes.map((n) => n.x);
    expect(xs[3]).toBeLessThan(400);
    expect(xs[0]).toBeLessThan(xs[1] as number);
    // Decided again: the two labels the panel did not show have room now, while the first would
    // cover the node next to it once the graph is fitted, so it is left out.
    expect([...framed.labelled].sort()).toEqual([1, 2, 3]);
    expect(framed.edges).toHaveLength(3);
  });

  it("leaves a label out that would cover a node, unless it is forced", () => {
    const close = scene();
    close.nodes = [
      node(0, 100, 100, { label: "A long label over the next node", rank: 1 }),
      node(1, 130, 100, { label: "B", rank: 0 }),
      node(2, 100, 200, { label: "Forced over its neighbour", labelForced: true }),
      node(3, 130, 200),
    ];
    close.edges = [];
    close.width = 60;
    close.height = 160;
    const framed = frameScene(close, "all", labelMeasure);
    expect([...framed.labelled].sort()).toEqual([1, 2]);
  });

  it("keeps only the selection and the edges inside it", () => {
    const framed = frameScene(scene(), "selection", labelMeasure);
    expect(framed.nodes.map((n) => n.index)).toEqual([2]);
    expect(framed.edges).toEqual([
      { source: 0, target: 0, color: "#999999", width: 1, arrow: false, label: null },
    ]);
    expect([...framed.labelled]).toEqual([0]);
    expect(framed.width).toBeGreaterThanOrEqual(120);
    const none = frameScene({ ...scene(), nodes: [node(0, 1, 1)] }, "selection", labelMeasure);
    expect(none.nodes).toHaveLength(0);
  });

  it("takes the colors of another palette, place by place", () => {
    const light = recolorScene(
      scene(),
      ["#112233", "#999999", "#000000", "#FFFFFF", "#eeeeee"],
      ["#aabbcc", "#555555", "#111111", "#fafafa", "#dddddd"],
    );
    expect(light.nodes.map((n) => n.color)).toEqual(["#aabbcc", "#336699", "#336699", "#336699"]);
    expect(light.edges[0]?.color).toBe("#555555");
    expect(light.colors).toEqual({ text: "#111111", background: "#fafafa", selection: "#dddddd" });
  });
});

describe("the page of a picture", () => {
  it("puts caption, drawing, legend and the count line on one page", () => {
    const framed = frameScene(scene(), "view", labelMeasure);
    const picture = composePicture(framed, PARTS, measure);
    expect(picture.layers.map((layer) => layer.name)).toEqual(["caption", "graph", "legend"]);
    const [caption, graph, legend] = picture.layers;
    expect(ops("text", caption?.ops ?? []).map((op) => (op as { text: string }).text)).toEqual([
      "Customers",
      "Graph DB",
      "1 Jan – 2 Jan",
    ]);
    // The visible part is cut at the panel's edges, under the caption.
    expect(graph?.clip).toEqual({ x: 0, y: 77, width: 400, height: 300 });
    const texts = ops("text", legend?.ops ?? []).map((op) => (op as { text: string }).text);
    expect(texts).toEqual([
      "Person  3",
      "Order  1",
      "Size by number of edges",
      "3 of 4 nodes shown",
    ]);
    expect(picture.width).toBe(400);
    expect(picture.height).toBeGreaterThan(300 + 77);
  });

  it("draws edges from shape to shape, arrows, loops and the labels on top", () => {
    const framed = frameScene(scene(), "view", labelMeasure);
    const picture = composePicture(framed, { ...PARTS, caption: null, legend: null }, measure);
    const graph = picture.layers[0]?.ops ?? [];
    const lines = ops("line", graph) as Extract<Op, { kind: "line" }>[];
    // From the circle's rim to the arrow's base before the square's side.
    expect(lines[0]).toMatchObject({ x1: 108, y1: 100, x2: 287, y2: 100, stroke: "#999999" });
    const arrow = ops("polygon", graph)[0] as Extract<Op, { kind: "polygon" }>;
    expect(arrow.points.slice(0, 2)).toEqual([292, 100]);
    expect(ops("ring", graph)).toHaveLength(1);
    // Shapes: a circle, a square (rect) and a diamond (polygon), in the nodes' colors.
    expect(ops("circle", graph).map((op) => (op as { fill: string }).fill)).toContain("#112233");
    const kinds = graph.map((op) => op.kind);
    expect(kinds.lastIndexOf("line")).toBeLessThan(kinds.indexOf("circle"));
    const texts = ops("text", graph) as Extract<Op, { kind: "text" }>[];
    expect(texts.map((op) => [op.text, op.bold, op.anchor])).toEqual([
      ["KNOWS", false, "middle"],
      ["Ada & <Co>", false, "start"],
      ["Zoë", true, "start"],
    ]);
    // A selected node's label sits on the selection tint.
    expect(ops("rect", graph).some((op) => (op as { fill: string }).fill === "#eeeeee")).toBe(true);
  });

  it("leaves the canvas color out of a transparent picture", () => {
    const framed = frameScene(scene(), "view", labelMeasure);
    const picture = composePicture(framed, { ...PARTS, background: null }, measure);
    expect(picture.background).toBeNull();
    const fills = picture.layers
      .flatMap((layer) => layer.ops)
      .filter((op) => op.kind === "rect")
      .map((op) => (op as { fill: string }).fill);
    expect(fills).not.toContain("#ffffff");
    // The selection tint stays: it marks the selected node.
    expect(fills).toContain("#eeeeee");
  });
});

describe("svg", () => {
  const picture = () => composePicture(frameScene(scene(), "view", labelMeasure), PARTS, measure);

  it("is a standalone document of vector shapes with every text as text", () => {
    const svg = pictureSvg(picture());
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns=')).toBe(true);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('viewBox="0 0 400 ');
    expect(svg).toContain("<title>Customers</title>");
    expect(svg).toContain('<g id="graph" clip-path="url(#clip-1)">');
    expect(svg).toContain('<clipPath id="clip-1"><rect x="0" y="77" width="400" height="300"/>');
    expect(svg.match(/<text /g)).toHaveLength(10);
    expect(svg).toContain(">Ada &amp; &lt;Co&gt;</text>");
    expect(svg).toContain('font-weight="600"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('<circle cx="100" cy="177" r="8" fill="#112233"/>');
    expect(svg).toContain('fill="none" stroke="#999999"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.getAttribute("font-family")).toBe(
      '"Instrument Sans Variable", system-ui, sans-serif',
    );
  });

  it("carries no script, no link, no style attribute and no outside reference", () => {
    const svg = pictureSvg(picture());
    expect(svg).not.toMatch(/<script|<style|<foreignObject|<image|<a\b/);
    expect(svg).not.toMatch(/\sstyle=|\son\w+=|href=|url\((?!#clip-)/);
  });

  it("embeds the font faces it is given, and nothing that would end their block early", () => {
    const svg = pictureSvg(
      picture(),
      '@font-face{font-family:"X";src:url("data:font/woff2;base64,AA")}]]>',
    );
    expect(svg).toContain('<defs><style><![CDATA[@font-face{font-family:"X";');
    expect(svg.match(/\]\]>/g)).toHaveLength(1);
  });

  it("escapes text and attributes, and replaces what XML cannot hold", () => {
    expect(xmlText('a<b>&"c"')).toBe("a&lt;b&gt;&amp;&quot;c&quot;");
    expect(xmlText("x\u0001y￾z")).toBe("x�y�z");
    expect(xmlText("line\nbreak")).toBe("line&#10;break");
    const odd = scene();
    odd.nodes = [
      node(0, 50, 50, { label: '</text><script>alert("x")</script>', labelShown: true }),
      node(1, 50, 90, { color: '"/><script>', label: "ok", labelShown: true }),
    ];
    odd.edges = [];
    const svg = pictureSvg(
      composePicture(
        frameScene(odd, "view", labelMeasure),
        { ...PARTS, title: "<T&T>", caption: null, legend: null, note: null },
        measure,
      ),
    );
    expect(svg).not.toContain("<script");
    expect(svg).toContain("<title>&lt;T&amp;T&gt;</title>");
    expect(svg).toContain('fill="&quot;/&gt;&lt;script&gt;"');
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelectorAll("script")).toHaveLength(0);
    expect(doc.querySelectorAll("text")[0]?.textContent).toBe('</text><script>alert("x")</script>');
  });

  it("has no background in a transparent picture", () => {
    const framed = frameScene(scene(), "view", labelMeasure);
    const svg = pictureSvg(composePicture(framed, { ...PARTS, background: null }, measure));
    expect(svg).not.toContain('<rect width="400"');
    expect(pictureSvg(picture())).toContain('" fill="#ffffff"/>\n<g id="caption">');
  });
});

describe("pdf", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The file as text, one character per byte; streams are left uncompressed for the tests. */
  async function pdf(
    parts: Partial<PictureParts> = {},
    page: "fit" | "a4" = "fit",
    rasterText?: () => TextImage | null,
  ) {
    vi.stubGlobal("CompressionStream", undefined);
    const framed = frameScene(scene(), "view", labelMeasure);
    const picture = composePicture(framed, { ...PARTS, ...parts }, measure);
    const bytes = await picturePdf(picture, rasterText ? { page, rasterText } : { page });
    return { text: String.fromCharCode(...bytes), picture, bytes };
  }

  it("is one page of the picture's size with a sound table of its objects", async () => {
    const { text, picture } = await pdf();
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const width = picture.width * 0.75;
    const height = picture.height * 0.75;
    expect(text).toContain(`/MediaBox [0 0 ${width} ${height}]`);
    expect(text).toContain("/Count 1");
    // Every entry of the table points at the start of its object.
    const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = [...text.slice(start).matchAll(/(\d{10}) 00000 n /g)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(7);
    entries.forEach((offset, i) => {
      expect(text.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
    // The stream's length is the length of its data.
    const length = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const from = text.indexOf("stream\n") + "stream\n".length;
    expect(text.slice(from + length, from + length + "\nendstream".length)).toBe("\nendstream");
  });

  it("writes vector shapes and text in Helvetica, flipped to read upright", async () => {
    const { text } = await pdf();
    expect(text).toContain("/BaseFont /Helvetica /Encoding /WinAnsiEncoding");
    expect(text).toContain("/BaseFont /Helvetica-Bold");
    // "Customers" in the bold font, as a hex string.
    expect(text).toContain("/F2 15 Tf");
    expect(text).toContain("<437573746f6d657273> Tj");
    // "Zoë": the umlaut is one Windows-1252 byte.
    expect(text).toContain("<5a6feb> Tj");
    expect(text).toMatch(/1 0 0 -1 [\d.]+ [\d.]+ Tm/);
    // The background, the clip of the visible part, a line and a filled circle.
    expect(text).toContain("1 1 1 rg\n0 0 300 ");
    expect(text).toContain("0 77 400 300 re W n");
    expect(text).toContain("0.6 0.6 0.6 RG\n1 w\n108 177 m\n287 177 l\nS");
    expect(text).toMatch(/0\.067 0\.133 0\.2 rg\n108 177 m\n[\d. ]+ c\n/);
    expect(text).toContain("/Title <feff0043");
    expect(text).not.toContain("/Filter");
  });

  it("fits the picture onto A4 landscape", async () => {
    const { text } = await pdf({}, "a4");
    expect(text).toContain("/MediaBox [0 0 841.89 595.28]");
    // The whole page takes the background.
    expect(text).toContain("0 0 841.89 595.28 re f");
  });

  it("puts a text Helvetica cannot write in as an image, else as question marks", async () => {
    expect(isWinAnsi("Zoë – „Ärger“ €")).toBe(true);
    expect(isWinAnsi("Привет")).toBe(false);
    const image: TextImage = {
      pixelWidth: 2,
      pixelHeight: 1,
      rgb: new Uint8Array([1, 2, 3, 4, 5, 6]),
      alpha: new Uint8Array([255, 0]),
      width: 40,
      height: 20,
      ascent: 14,
    };
    const parts = { caption: { title: "Привет", lines: [] } };
    const drawn = await pdf(parts, "fit", () => image);
    expect(drawn.text).toContain("/Im0 Do");
    expect(drawn.text).toContain("/XObject << /Im0 8 0 R >>");
    expect(drawn.text).toContain(
      "/Subtype /Image /Width 2 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask 9 0 R",
    );
    expect(drawn.text).toContain("/ColorSpace /DeviceGray /Length 2 >>");
    const plain = await pdf(parts);
    expect(plain.text).toContain("<3f3f3f3f3f3f> Tj");
    expect(plain.text).not.toContain("/XObject");
  });

  it("reads the colors CSS writes", () => {
    expect(pdfColor("#fff")).toEqual([1, 1, 1]);
    expect(pdfColor("#336699").map((v) => Math.round(v * 255))).toEqual([51, 102, 153]);
    expect(pdfColor("rgb(255, 0, 51)").map((v) => Math.round(v * 255))).toEqual([255, 0, 51]);
    expect(pdfColor("oklch(50% 0.1 20)")).toEqual([0, 0, 0]);
  });
});

describe("png", () => {
  it("keeps a large picture inside what a canvas can hold", () => {
    expect(pngScale(800, 600, 2)).toBe(2);
    expect(pngScale(10_000, 600, 2)).toBeCloseTo(1.6384);
    expect(pngScale(16_000, 16_000, 2) * 16_000).toBeLessThanOrEqual(16_384);
  });
});

describe("the part of the graph a data file holds", () => {
  // Nodes a, b and c drawn on their own, d and e as one group.
  const model = {
    nodes: ["a", "b", "c", "d", "e"].map((id) => ({ id })),
  } as unknown as GraphModel;
  const view = {
    nodes: [
      { node: 0, members: 1 },
      { node: 1, members: 1 },
      { node: 2, members: 1 },
      { node: -1, members: 2 },
    ],
    edges: [{ count: 1 }, { count: 3 }],
    nodeOf: Int32Array.from([0, 1, 2, 3, 3]),
  } as unknown as GraphView;
  const visibility: Visibility = {
    nodes: Uint8Array.from([1, 1, 0, 1]),
    edges: Uint8Array.from([1, 0]),
  };
  const drawn = {
    ...scene(),
    nodes: [node(0, 10.126, 20), node(1, 30, 40.5), node(3, 50, 60)],
  };

  it("counts nodes, not the groups that stand for them", () => {
    expect(scopeCounts(model, view, visibility, new Set([1, 2, 3]))).toEqual({
      total: 5,
      visible: 4,
      selected: 3,
      edges: 1,
    });
  });

  it("names nothing for everything loaded, else the visible or the selected nodes", () => {
    const selected = new Set([1, 2, 3]);
    expect(exportScope("loaded", model, view, visibility, selected, null)).toBeUndefined();
    expect(exportScope("visible", model, view, visibility, selected, null)).toEqual({
      nodes: ["a", "b", "d", "e"],
    });
    // A hidden node is not exported with the selection; a selected group gives all its nodes.
    expect(exportScope("selection", model, view, visibility, selected, null)).toEqual({
      nodes: ["b", "d", "e"],
    });
  });

  it("sends where single nodes are drawn, only those the file holds", () => {
    expect(exportScope("loaded", model, view, visibility, new Set(), drawn)).toEqual({
      positions: { a: [10.13, 20], b: [30, 40.5] },
    });
    expect(exportScope("selection", model, view, visibility, new Set([1]), drawn)).toEqual({
      nodes: ["b"],
      positions: { b: [30, 40.5] },
    });
  });
});
