import type { DashboardLayout, LayoutItem } from "./api";
import "./dashboards.css";

/** The grid's columns, as on the server and in the dashboard grid. */
const COLUMNS = 24;

/** The sketch shows the top of the dashboard: at most this many grid rows. */
const MAX_ROWS = 18;

/** The fewest grid rows the sketch spans, so a short dashboard does not stretch its panels. */
const MIN_ROWS = 12;

/** Gap between boxes, in grid units. */
const GAP = 0.35;

/** The kinds of glyph a box carries, from its panel type. */
type Glyph = "line" | "bars" | "stat" | "table" | "graph" | "text" | "plain";

function glyphOf(type: string): Glyph {
  if (/timeseries|trend|xy|line|state|candle/i.test(type)) return "line";
  if (/bar|histogram|heatmap/i.test(type)) return "bars";
  if (/stat|gauge|pie/i.test(type)) return "stat";
  if (/table|log|document|trace/i.test(type)) return "table";
  if (/graph|node|network|map|geo/i.test(type)) return "graph";
  if (/text|news|link|list/i.test(type)) return "text";
  return "plain";
}

/** One of the data palette's first colors per glyph, so a sketch reads like its dashboard. */
const COLOR: Record<Glyph, number> = {
  line: 1,
  bars: 3,
  stat: 5,
  table: 8,
  graph: 6,
  text: 8,
  plain: 1,
};

function Glyph({ item, glyph }: { item: Box; glyph: Glyph }) {
  const { x, y, w, h } = item;
  // Drawn inside the box, a margin of a fifth of the shorter side.
  const m = Math.min(w, h) * 0.2;
  const left = x + m;
  const top = y + m;
  const width = Math.max(w - 2 * m, 0.1);
  const height = Math.max(h - 2 * m, 0.1);
  const color = `var(--chart-${COLOR[glyph]})`;
  switch (glyph) {
    case "line": {
      const steps = [0.7, 0.55, 0.62, 0.35, 0.45, 0.15, 0.25];
      const points = steps
        .map((v, i) => `${left + (width * i) / (steps.length - 1)},${top + height * v}`)
        .join(" ");
      return (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={0.25}
          strokeLinejoin="round"
        />
      );
    }
    case "bars": {
      const values = [0.55, 0.85, 0.4, 0.7, 0.3];
      const bar = width / (values.length * 1.6);
      return (
        <g fill={color}>
          {values.map((v, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed decoration, never reordered
              key={i}
              x={left + i * bar * 1.6}
              y={top + height * (1 - v)}
              width={bar}
              height={height * v}
            />
          ))}
        </g>
      );
    }
    case "stat":
      return (
        <rect
          x={left}
          y={top + height * 0.35}
          width={width * 0.6}
          height={Math.min(height * 0.3, 1.2)}
          rx={0.2}
          fill={color}
        />
      );
    case "table":
    case "text": {
      const lines = Math.max(1, Math.min(4, Math.floor(height / 1.2)));
      return (
        <g fill="var(--text-muted)" opacity={0.45}>
          {Array.from({ length: lines }, (_, i) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed decoration, never reordered
              key={i}
              x={left}
              y={top + (height * i) / lines}
              width={width * (i % 2 === 0 ? 1 : 0.7)}
              height={Math.min(0.35, height / lines / 2)}
              rx={0.1}
            />
          ))}
        </g>
      );
    }
    case "graph": {
      const nodes = [
        [0.15, 0.5],
        [0.45, 0.15],
        [0.75, 0.55],
        [0.5, 0.85],
      ] as const;
      const at = ([u, v]: readonly [number, number]) =>
        [left + width * u, top + height * v] as const;
      const r = Math.min(width, height) * 0.08;
      return (
        <g stroke={color} fill={color} strokeWidth={0.15}>
          {[
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 0],
          ].map(([a, b]) => {
            const [x1, y1] = at(nodes[a ?? 0] ?? nodes[0]);
            const [x2, y2] = at(nodes[b ?? 0] ?? nodes[0]);
            return <line key={`${a}-${b}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
          {nodes.map((node) => {
            const [cx, cy] = at(node);
            return <circle key={`${node[0]}-${node[1]}`} cx={cx} cy={cy} r={r} />;
          })}
        </g>
      );
    }
    default:
      return null;
  }
}

type Box = LayoutItem;

/**
 * A schematic picture of a dashboard: its panels as boxes where they sit on the grid, each with
 * a neutral glyph for its kind in the data palette, and rows as thin bands. No data is loaded;
 * the layout comes with the list. Decoration only: the tile's link names the dashboard.
 */
export function DashboardSketch({ layout }: { layout: DashboardLayout | undefined }) {
  const items = (layout?.items ?? []).filter((item) => item.y < MAX_ROWS);
  const bottom = items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const rows = Math.min(Math.max(bottom, MIN_ROWS), MAX_ROWS);
  return (
    <div className="dashboard-sketch" aria-hidden="true">
      {items.length === 0 ? null : (
        <svg
          className="dashboard-sketch__svg"
          viewBox={`${-GAP} ${-GAP} ${COLUMNS + 2 * GAP} ${rows + 2 * GAP}`}
          preserveAspectRatio="xMidYMin meet"
          aria-hidden="true"
        >
          {items.map((item, index) => {
            const box: Box = {
              ...item,
              x: Math.min(item.x, COLUMNS - 1) + GAP / 2,
              y: item.y + GAP / 2,
              w: Math.max(Math.min(item.w, COLUMNS - item.x) - GAP, 0.2),
              h: Math.max(Math.min(item.h, rows - item.y) - GAP, 0.2),
            };
            if (item.type === "row") {
              return (
                <rect
                  // biome-ignore lint/suspicious/noArrayIndexKey: the layout has no ids; its order is fixed
                  key={index}
                  x={box.x}
                  y={box.y + box.h * 0.35}
                  width={box.w}
                  height={Math.max(box.h * 0.3, 0.15)}
                  rx={0.1}
                  fill="var(--border)"
                />
              );
            }
            const glyph = glyphOf(item.type);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the layout has no ids; its order is fixed
              <g key={index}>
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={0.3}
                  fill={
                    glyph === "table" || glyph === "text"
                      ? "var(--bg-raised)"
                      : `var(--chart-${COLOR[glyph]}-bg)`
                  }
                  stroke="var(--border)"
                  strokeWidth={0.08}
                />
                <Glyph item={box} glyph={glyph} />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
