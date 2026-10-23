import type { ReactNode } from "react";
import "../panels.css";
import "../viz.css";

/**
 * Small drawings of each panel type for the panel picker, made only of palette and tone
 * classes so they follow the theme. Decorative: the picker names every type in text.
 */

function Frame({ children }: { children: ReactNode }) {
  return (
    <svg className="preview" viewBox="0 0 64 40" aria-hidden="true">
      {children}
    </svg>
  );
}

export function TimeSeriesPreview() {
  return (
    <Frame>
      <path className="preview__line series-1" d="M2 30L12 22L22 26L32 12L42 18L52 8L62 14" />
      <path className="preview__line series-2" d="M2 34L12 30L22 32L32 26L42 28L52 22L62 24" />
    </Frame>
  );
}

export function StatPreview() {
  return (
    <Frame>
      <rect className="preview__block" x="14" y="6" width="36" height="14" rx="2" />
      <path
        className="preview__area series-1"
        d="M2 38L12 32L22 34L32 26L42 30L52 22L62 24L62 40L2 40Z"
      />
      <path className="preview__line series-1" d="M2 38L12 32L22 34L32 26L42 30L52 22L62 24" />
    </Frame>
  );
}

export function BarPreview() {
  return (
    <Frame>
      {[14, 24, 10, 30, 20].map((h, i) => (
        <rect
          key={h}
          className="preview__fill series-1"
          x={4 + i * 12}
          y={38 - h}
          width="8"
          height={h}
        />
      ))}
    </Frame>
  );
}

export function TablePreview() {
  return (
    <Frame>
      <rect className="preview__block" x="2" y="4" width="60" height="6" />
      {[14, 22, 30].map((y) => (
        <g key={y}>
          <rect className="preview__muted" x="2" y={y} width="26" height="4" />
          <rect className="preview__muted" x="34" y={y} width="28" height="4" />
        </g>
      ))}
    </Frame>
  );
}

export function GaugePreview() {
  return (
    <Frame>
      <path className="preview__track" d="M14 34A20 20 0 1 1 50 34" />
      <path className="preview__stroke tone--ok" d="M14 34A20 20 0 0 1 38 15" />
    </Frame>
  );
}

export function BarGaugePreview() {
  return (
    <Frame>
      {[44, 30, 52].map((w, i) => (
        <g key={w}>
          <rect className="preview__muted" x="4" y={6 + i * 11} width="56" height="7" />
          <rect
            className={`preview__fill ${i === 2 ? "tone--critical" : "tone--ok"}`}
            x="4"
            y={6 + i * 11}
            width={w}
            height="7"
          />
        </g>
      ))}
    </Frame>
  );
}

export function PiePreview() {
  return (
    <Frame>
      <path className="preview__fill series-1" d="M32 20L32 2A18 18 0 0 1 49 26Z" />
      <path className="preview__fill series-2" d="M32 20L49 26A18 18 0 0 1 18 31Z" />
      <path className="preview__fill series-3" d="M32 20L18 31A18 18 0 0 1 32 2Z" />
    </Frame>
  );
}

export function HeatmapPreview() {
  const cells = [3, 5, 2, 7, 4, 1, 6, 8, 3, 5, 2, 4, 7, 6, 1, 3, 5, 8, 2, 4, 6, 3, 1, 5];
  return (
    <Frame>
      {cells.map((level, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
          key={i}
          className={`heat-${level}`}
          x={2 + (i % 8) * 7.6}
          y={4 + Math.floor(i / 8) * 11}
          width="7"
          height="10"
        />
      ))}
    </Frame>
  );
}

export function HistogramPreview() {
  return (
    <Frame>
      {[4, 10, 20, 30, 22, 12, 6, 2].map((h, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
          key={i}
          className="preview__fill series-3"
          x={2 + i * 7.6}
          y={38 - h}
          width="7"
          height={h}
        />
      ))}
    </Frame>
  );
}

export function StateTimelinePreview() {
  return (
    <Frame>
      <rect className="preview__fill tone--ok" x="2" y="6" width="34" height="10" />
      <rect className="preview__fill tone--warn" x="36" y="6" width="12" height="10" />
      <rect className="preview__fill tone--ok" x="48" y="6" width="14" height="10" />
      <rect className="preview__fill tone--ok" x="2" y="22" width="16" height="10" />
      <rect className="preview__fill tone--critical" x="18" y="22" width="20" height="10" />
      <rect className="preview__fill tone--ok" x="38" y="22" width="24" height="10" />
    </Frame>
  );
}

export function StatusHistoryPreview() {
  const tones = ["ok", "ok", "warn", "ok", "critical", "ok", "ok", "ok"];
  return (
    <Frame>
      {[6, 22].map((y, row) =>
        tones.map((tone, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed drawing
            key={`${y}-${i}`}
            className={`preview__fill tone--${row === 1 && i === 2 ? "ok" : tone}`}
            x={2 + i * 7.6}
            y={y}
            width="6.6"
            height="10"
          />
        )),
      )}
    </Frame>
  );
}

export function TextPreview() {
  return (
    <Frame>
      <rect className="preview__block" x="4" y="6" width="34" height="6" />
      {[18, 25, 32].map((y, i) => (
        <rect key={y} className="preview__muted" x="4" y={y} width={i === 2 ? 36 : 56} height="3" />
      ))}
    </Frame>
  );
}

/** Nodes as dots of their label's color, joined by neutral edges. */
function Nodes({ nodes, edges }: { nodes: [number, number, number][]; edges: [number, number][] }) {
  return (
    <>
      {edges.map(([from, to]) => {
        const a = nodes[from] as [number, number, number];
        const b = nodes[to] as [number, number, number];
        return (
          <line
            key={`${from}-${to}`}
            className="preview__edge"
            x1={a[0]}
            y1={a[1]}
            x2={b[0]}
            y2={b[1]}
          />
        );
      })}
      {nodes.map(([x, y, series]) => (
        <circle
          key={`${x}-${y}`}
          className={`preview__fill series-${series}`}
          cx={x}
          cy={y}
          r="3.5"
        />
      ))}
    </>
  );
}

export function NetworkPreview() {
  return (
    <Frame>
      <Nodes
        nodes={[
          [10, 12, 1],
          [24, 26, 1],
          [8, 32, 2],
          [36, 10, 3],
          [42, 28, 2],
          [56, 16, 1],
          [54, 34, 3],
        ]}
        edges={[
          [0, 1],
          [1, 2],
          [1, 3],
          [1, 4],
          [3, 5],
          [4, 5],
          [4, 6],
        ]}
      />
    </Frame>
  );
}

export function HierarchyPreview() {
  return (
    <Frame>
      <Nodes
        nodes={[
          [32, 6, 1],
          [18, 20, 2],
          [46, 20, 2],
          [8, 34, 3],
          [24, 34, 3],
          [40, 34, 3],
          [56, 34, 3],
        ]}
        edges={[
          [0, 1],
          [0, 2],
          [1, 3],
          [1, 4],
          [2, 5],
          [2, 6],
        ]}
      />
    </Frame>
  );
}

export function PathPreview() {
  return (
    <Frame>
      {[12, 28].map((y, row) => (
        <g key={y}>
          {[0, 1, 2].map((i) => (
            <rect
              key={i}
              className={row === 0 ? "preview__block" : "preview__muted"}
              x={4 + i * 22}
              y={y - 4}
              width="12"
              height="8"
              rx="2"
            />
          ))}
          {[0, 1].map((i) => (
            <path key={i} className="preview__edge" d={`M${17 + i * 22} ${y}H${25 + i * 22}`} />
          ))}
        </g>
      ))}
    </Frame>
  );
}

/** For panel types without a drawing of their own. */
export function GenericPreview() {
  return (
    <Frame>
      <rect className="preview__muted" x="4" y="4" width="56" height="32" rx="3" />
    </Frame>
  );
}
