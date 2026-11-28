import "./patterns.css";
import { type PointerEvent, useRef, useState } from "react";
import type { GraphSourceSchema, Pattern, PatternEdge } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { edgesOf, labelSlot, layoutPattern, type Placed, type Selection } from "./pattern";
import { conditionPhrase } from "./sentence";

/** The radius of a drawn node, in the drawing's units. */
const RADIUS = 22;

interface PatternDrawingProps {
  pattern: Pattern;
  schema: GraphSourceSchema | undefined;
  /** What the drawing shows, in words: the pattern's sentence. */
  label: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** A double click on the free area. */
  onAddNode: () => void;
  /** An edge drawn from one node to another. */
  onConnect: (from: string, to: string) => void;
}

/**
 * The drawing of a pattern (board Graph083, frames 1, 2 and 5): nodes as circles with their name
 * and label, edges as arrows with their type, optional parts dashed, conditions as small signs
 * under the element. A selected element is tinted and its text heavier; no coloured outline.
 * It is a picture named by the pattern's sentence: the pointer picks and draws here, while the
 * list (frame 25) is the same pattern for the keyboard and screen readers.
 */
export function PatternDrawing({
  pattern,
  schema,
  label,
  selection,
  onSelect,
  onAddNode,
  onConnect,
}: PatternDrawingProps) {
  const { t } = useI18n();
  const layout = layoutPattern(pattern);
  const at = new Map(layout.nodes.map((p) => [p.id, p]));
  const svg = useRef<SVGSVGElement>(null);
  // An edge being drawn from a node: where it starts, and where the pointer is.
  const [drag, setDrag] = useState<{ from: string; x: number; y: number } | null>(null);

  function point(event: PointerEvent): { x: number; y: number } {
    const box = svg.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - box.left) / box.width) * layout.width,
      y: ((event.clientY - box.top) / box.height) * layout.height,
    };
  }

  const isSelected = (kind: "node" | "edge", id: string) =>
    selection !== null && selection.kind === kind && selection.id === id;

  return (
    <svg
      ref={svg}
      className="pattern-drawing"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={label}
      onDoubleClick={(event) => {
        if (event.target === svg.current) onAddNode();
      }}
      onPointerMove={(event) => {
        if (drag !== null) setDrag({ ...drag, ...point(event) });
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
    >
      <defs>
        <marker
          id="pattern-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="pattern-drawing__arrow" />
        </marker>
      </defs>
      {edgesOf(pattern).map((edge) => {
        const a = at.get(edge.from);
        const b = at.get(edge.to);
        if (a === undefined || b === undefined) return null;
        return (
          <DrawnEdge
            key={edge.id}
            edge={edge}
            a={a}
            b={b}
            parallel={edgesOf(pattern).filter(
              (e) =>
                (e.from === edge.from && e.to === edge.to) ||
                (e.from === edge.to && e.to === edge.from),
            )}
            selected={isSelected("edge", edge.id)}
            onSelect={() => onSelect({ kind: "edge", id: edge.id })}
          />
        );
      })}
      {drag === null
        ? null
        : (() => {
            const a = at.get(drag.from);
            return a === undefined ? null : (
              <line className="pattern-drawing__drag" x1={a.x} y1={a.y} x2={drag.x} y2={drag.y} />
            );
          })()}
      {pattern.nodes.map((node) => {
        const p = at.get(node.id);
        if (p === undefined) return null;
        const labels = node.labels ?? [];
        const selected = isSelected("node", node.id);
        const conditions = node.conditions ?? [];
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: a part of a picture, picked by pointer
          <g
            key={node.id}
            className={selected ? "pattern-node pattern-node--selected" : "pattern-node"}
            transform={`translate(${p.x} ${p.y})`}
            data-element={`node:${node.id}`}
            data-slot={labelSlot(schema, labels[0])}
            onClick={() => onSelect({ kind: "node", id: node.id })}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              setDrag({ from: node.id, ...point(event) });
            }}
            onPointerUp={(event) => {
              if (drag !== null && drag.from !== node.id) {
                event.stopPropagation();
                onConnect(drag.from, node.id);
              }
              setDrag(null);
            }}
          >
            <circle className="pattern-node__shape" r={RADIUS} />
            <text className="pattern-node__id" textAnchor="middle" dy="0.35em">
              {node.id}
            </text>
            <text className="pattern-node__label" textAnchor="middle" y={RADIUS + 16}>
              {labels.length === 0 ? t("graphPatterns.drawing.any") : labels.join(" | ")}
            </text>
            {conditions.slice(0, 2).map((c, i) => (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; their place is it
                key={`${c.property}-${i}`}
                className="pattern-node__condition"
                textAnchor="middle"
                y={RADIUS + 32 + i * 14}
              >
                {conditionPhrase(t, c)}
              </text>
            ))}
            {conditions.length > 2 ? (
              <text className="pattern-node__condition" textAnchor="middle" y={RADIUS + 60}>
                {t("graphPatterns.drawing.more", { count: conditions.length - 2 })}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function DrawnEdge({
  edge,
  a,
  b,
  parallel,
  selected,
  onSelect,
}: {
  edge: PatternEdge;
  a: Placed;
  b: Placed;
  parallel: PatternEdge[];
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useI18n();
  // Two edges between the same nodes bend apart, so both stay readable.
  const index = parallel.findIndex((e) => e.id === edge.id);
  const bend = parallel.length < 2 ? 0 : (index - (parallel.length - 1) / 2) * 36;
  const [start, end] = edge.direction === "in" ? [b, a] : [a, b];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const sx = start.x + ux * RADIUS;
  const sy = start.y + uy * RADIUS;
  const ex = end.x - ux * (RADIUS + 2);
  const ey = end.y - uy * (RADIUS + 2);
  const mx = (sx + ex) / 2 - uy * bend;
  const my = (sy + ey) / 2 + ux * bend;
  const d = `M${sx},${sy} Q${mx},${my} ${ex},${ey}`;
  const types = (edge.types ?? []).join(" | ") || t("graphPatterns.drawing.anyType");
  const hops = (edge.maxHops ?? 1) > 1 ? ` ${edge.minHops ?? 1}..${edge.maxHops}` : "";
  const className = [
    "pattern-edge",
    selected ? "pattern-edge--selected" : "",
    edge.optional === true ? "pattern-edge--optional" : "",
  ]
    .filter((c) => c !== "")
    .join(" ");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a part of a picture, picked by pointer
    <g className={className} data-element={`edge:${edge.id}`} onClick={onSelect}>
      {/* A wider, invisible line takes the pointer, so a thin edge is easy to hit. */}
      <path className="pattern-edge__hit" d={d} />
      <path
        className="pattern-edge__line"
        d={d}
        markerEnd={edge.direction === "both" ? undefined : "url(#pattern-arrow)"}
      />
      <text className="pattern-edge__label" x={mx} y={my - 6} textAnchor="middle">
        {`${types}${hops}`}
      </text>
    </g>
  );
}
