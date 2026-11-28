import type { ReactNode } from "react";
import type { LayoutMode } from "../layoutProtocol";
import "./layouts.css";

/**
 * A small drawing of each layout for the layout menu (Graph081 board, frame 12), in the current
 * text color: dots where the layout puts nodes, thin lines for edges, rings and axes. Decoration
 * only; the row's name and sentence carry the meaning.
 */

function dots(points: readonly (readonly [number, number])[]): ReactNode {
  return points.map(([x, y]) => (
    <circle key={`${x}-${y}`} cx={x} cy={y} r={1.7} fill="currentColor" stroke="none" />
  ));
}

const DRAWINGS: Record<LayoutMode, ReactNode> = {
  force: (
    <>
      <path d="M5 7l6 4 6-5M11 11l-4 7M11 11l7 6" />
      {dots([
        [5, 7],
        [11, 11],
        [17, 6],
        [7, 18],
        [18, 17],
      ])}
    </>
  ),
  hierarchy: (
    <>
      <path d="M12 5 6 12M12 5l6 7M6 12l-2 7M6 12l3 7M18 12v7" />
      {dots([
        [12, 5],
        [6, 12],
        [18, 12],
        [4, 19],
        [9, 19],
        [18, 19],
      ])}
    </>
  ),
  radial: (
    <>
      <circle cx={12} cy={12} r={4.5} />
      <circle cx={12} cy={12} r={9} />
      {dots([
        [12, 12],
        [12, 7.5],
        [8.1, 14.2],
        [15.9, 14.2],
        [12, 3],
        [19.8, 16.5],
        [4.2, 16.5],
      ])}
    </>
  ),
  circular: (
    <>
      <circle cx={12} cy={12} r={8} />
      {dots([
        [12, 4],
        [18.9, 8],
        [18.9, 16],
        [12, 20],
        [5.1, 16],
        [5.1, 8],
      ])}
    </>
  ),
  grid: dots([
    [5, 6],
    [12, 6],
    [19, 6],
    [5, 12],
    [12, 12],
    [19, 12],
    [5, 18],
    [12, 18],
    [19, 18],
  ]),
  coordinates: (
    <>
      <path d="M4 4v16h16" />
      {dots([
        [8, 15],
        [11, 10],
        [15, 12],
        [18, 6],
      ])}
    </>
  ),
  map: (
    <>
      <path d="M4 7l5-2 6 2 5-2v12l-5 2-6-2-5 2zM9 5v12M15 7v12" />
      {dots([
        [6.5, 11],
        [12, 13],
        [17.5, 9],
      ])}
    </>
  ),
  timeline: (
    <>
      <path d="M3 8h18M3 16h18" />
      {dots([
        [6, 8],
        [13, 8],
        [18, 8],
        [9, 16],
        [16, 16],
      ])}
    </>
  ),
};

export function LayoutGlyph({ mode }: { mode: LayoutMode }) {
  return (
    <svg
      className="graph-layouts__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {DRAWINGS[mode]}
    </svg>
  );
}
