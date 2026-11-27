import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGO_PATH } from "../components/Icon";
import {
  CENTER,
  CORE,
  CRYSTAL,
  CRYSTAL_CORNERS,
  CRYSTAL_INNER,
  GRAPH_EDGES,
  GRAPH_NODES,
  NODE_RADIUS,
  SCENE,
  TIERS,
  VIEW,
} from "./doppelbrechung";

/** Every number pair of a path made of absolute moves and lines only. */
function points(path: string): [number, number][] {
  const numbers = (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    pairs.push([numbers[index] as number, numbers[index + 1] as number]);
  }
  return pairs;
}

describe("the picture in the sign-in panel", () => {
  it("draws the crystal as Kalzit's mark, only larger", () => {
    // The mark's outline and its corner inside, as the icon set draws them (24 by 24).
    expect(LOGO_PATH.startsWith("M3.1 8.25 7.6 3.95l11.5-2 1.8 13.6-4 4.4L5.6 22.05Z")).toBe(true);
    const mark: [number, number][] = [
      [3.1, 8.25],
      [7.6, 3.95],
      [19.1, 1.95],
      [20.9, 15.55],
      [16.9, 19.95],
      [5.6, 22.05],
      [14.6, 6.35],
    ];
    const drawn = [...CRYSTAL_CORNERS, CRYSTAL_INNER];
    const [m0, m1] = [mark[0] as [number, number], mark[1] as [number, number]];
    const [d0, d1] = [drawn[0] as [number, number], drawn[1] as [number, number]];
    const scale = (d1[0] - d0[0]) / (m1[0] - m0[0]);
    mark.forEach(([x, y], index) => {
      const [dx, dy] = drawn[index] as readonly [number, number];
      expect(Math.abs(d0[0] + (x - m0[0]) * scale - dx), `corner ${index} x`).toBeLessThan(1);
      expect(Math.abs(d0[1] + (y - m0[1]) * scale - dy), `corner ${index} y`).toBeLessThan(1);
    });
    expect(points(CRYSTAL.outline)).toEqual(CRYSTAL_CORNERS.map(([x, y]) => [x, y]));
  });

  it("joins every node of the graph to another, and no edge leads nowhere or twice", () => {
    const seen = new Set<string>();
    const joined = new Set<number>();
    for (const [from, to] of GRAPH_EDGES) {
      expect(GRAPH_NODES[from], `edge from ${from}`).toBeDefined();
      expect(GRAPH_NODES[to], `edge to ${to}`).toBeDefined();
      expect(from).not.toBe(to);
      const key = [Math.min(from, to), Math.max(from, to)].join("-");
      expect(seen.has(key), `edge ${key} twice`).toBe(false);
      seen.add(key);
      joined.add(from).add(to);
    }
    expect(joined.size).toBe(GRAPH_NODES.length);
  });

  it("keeps the nodes apart, so none covers another", () => {
    GRAPH_NODES.forEach((a, i) => {
      GRAPH_NODES.slice(i + 1).forEach((b, j) => {
        const distance = Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]);
        expect(distance, `nodes ${i} and ${i + 1 + j}`).toBeGreaterThan(NODE_RADIUS * 4);
      });
    });
  });

  it("fits the board's drawing into the part every panel shows", () => {
    const near = [
      ...CRYSTAL_CORNERS.map(([x, y]) => [x, y] as [number, number]),
      ...GRAPH_NODES.filter((node) => node.tier === "near").map(
        (node) => [node.at[0], node.at[1]] as [number, number],
      ),
    ];
    for (const [x, y] of near) {
      expect(Math.abs(x - CENTER[0]) + NODE_RADIUS).toBeLessThanOrEqual(CORE.width / 2);
      expect(Math.abs(y - CENTER[1]) + NODE_RADIUS).toBeLessThanOrEqual(CORE.height / 2);
    }
  });

  it("keeps the whole drawing inside its box, with the crystal in the middle", () => {
    expect(VIEW.x + VIEW.width / 2).toBe(CENTER[0]);
    expect(VIEW.y + VIEW.height / 2).toBe(CENTER[1]);
    for (const { at } of GRAPH_NODES) {
      expect(at[0] + NODE_RADIUS).toBeLessThan(VIEW.x + VIEW.width);
      expect(at[1] - NODE_RADIUS).toBeGreaterThan(VIEW.y);
      expect(at[1] + NODE_RADIUS).toBeLessThan(VIEW.y + VIEW.height);
    }
  });

  it("is lines only: no words, no figures, no curves", () => {
    for (const tier of TIERS) {
      const { lines, nodes } = SCENE[tier];
      expect(lines).toMatch(/^[MHVhZ\d\s.-]+$/);
      expect(nodes).toMatch(/^[MZ\d\s.-]*$/);
    }
    // The table, the document and the graph all reach into the crystal.
    expect(SCENE.near.lines).toContain("M40 250H");
    expect(SCENE.near.lines).toContain("M300 300h");
    expect(SCENE.near.lines).toContain("M470 250 540 200");
  });

  it("sizes the picture in the tokens from the same numbers", () => {
    const tokens = readFileSync(resolve(import.meta.dirname, "../styles/tokens.css"), "utf8");
    const byHeight = ((VIEW.height / CORE.height) * 100).toFixed(1);
    const byWidth = ((VIEW.height / CORE.width) * 100).toFixed(1);
    expect(tokens).toContain(`--size-access-art: min(${byHeight}cqh, ${byWidth}cqw);`);
    expect(tokens).toContain(`--aspect-access-art: ${VIEW.width} / ${VIEW.height};`);
  });
});
