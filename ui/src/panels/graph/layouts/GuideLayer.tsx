import { lazy, memo, Suspense, useEffect, useState } from "react";
import { loadArea, useI18n } from "../../../i18n/i18n";
import type { LayoutGuide } from "../layoutProtocol";
import "./layouts.css";

/** The map under the layout "Karte": loads with the map panel's texts, on the first map only. */
const MapBackdrop = lazy(() =>
  loadArea("map")
    .then(() => import("../../map/MapBackdrop"))
    .then((m) => ({ default: m.MapBackdrop })),
);

/** Maps a point of the layout (graph units) to the stage (px from its top left). */
export type Project = (x: number, y: number) => { x: number; y: number };

/** Longest stretch of an axis label's text, in px, kept off the strip it sits near. */
const LABEL_GAP = 6;

/**
 * Where the canvas says, after each frame, how the layout maps to the stage. It lives outside
 * React state on purpose: a pan or zoom frame must not re-render the drawing, only the guides
 * that follow it, and only when there are some.
 */
export interface FrameSource {
  /** Called by the canvas after each frame; stable, so handing it on re-renders nothing. */
  emit: (project: Project) => void;
  /** The newest projection is delivered at once, later ones as they come. */
  subscribe: (listener: (project: Project) => void) => () => void;
}

export function createFrameSource(): FrameSource {
  let last: Project | null = null;
  const listeners = new Set<(project: Project) => void>();
  return {
    emit(project) {
      last = project;
      for (const listener of listeners) listener(project);
    },
    subscribe(listener) {
      listeners.add(listener);
      if (last !== null) listener(last);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function formatValue(value: number, locale: string, time: boolean): string {
  if (time) {
    // Times are Unix ms; a date-only value was read as UTC, so the axis reads in UTC, too.
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(value);
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/**
 * The quiet lines behind the graph that say how a layout placed its nodes (Graph081 board, frame
 * 13): the rings of the radial layout, the axes of the coordinates and the timeline, the timeline's
 * lanes and the strip of nodes a layout had no place for, with their number and why. Neutral
 * lines and muted text only. It is decoration for the eyes: what it says is also said above the
 * graph (placedText) and in the table, so it is hidden from assistive technology. Drawn under the
 * canvas, which is transparent, in the canvas' own coordinates (the canvas hands over `project`).
 * Under the layout "Karte" the map lies beneath the lines (MapBackdrop), with its attribution.
 */
export const GuideLayer = memo(function GuideLayer({
  guides,
  axes,
  frames,
}: {
  guides: readonly LayoutGuide[];
  /** Whether the axes are drawn (the panel's option); rings, lanes and the strip always are. */
  axes: boolean;
  frames: FrameSource;
}) {
  // The projection of the newest frame, taken at most once per animation frame, and only while
  // there is something to draw.
  const [shown, setShown] = useState<{ to: Project } | null>(null);
  const drawing = guides.length > 0;
  useEffect(() => {
    if (!drawing) {
      setShown(null);
      return;
    }
    let newest: Project | null = null;
    let queued: number | undefined;
    const unsubscribe = frames.subscribe((project) => {
      newest = project;
      if (queued !== undefined) return;
      queued = requestAnimationFrame(() => {
        queued = undefined;
        if (newest !== null) setShown({ to: newest });
      });
    });
    return () => {
      unsubscribe();
      if (queued !== undefined) cancelAnimationFrame(queued);
    };
  }, [drawing, frames]);
  const project = shown?.to ?? null;
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  if (project === null || guides.length === 0) return null;
  const map = guides.find((guide) => guide.kind === "map");
  const drawn = guides.map((guide, index) => {
    const id = `${guide.kind}:${index}`;
    switch (guide.kind) {
      case "ring": {
        const at = project(guide.x, guide.y);
        const edge = project(guide.x + guide.radius, guide.y);
        const radius = Math.hypot(edge.x - at.x, edge.y - at.y);
        return <circle key={id} className="graph-guides__line" cx={at.x} cy={at.y} r={radius} />;
      }
      case "axis": {
        if (!axes) return null;
        const from = project(guide.x1, guide.y1);
        const to = project(guide.x2, guide.y2);
        const time = guide.axis === "time";
        const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
        const label = (value: number, at: { x: number; y: number }, end: boolean) => (
          <text
            key={end ? "max" : "min"}
            className="graph-guides__text"
            x={horizontal ? at.x : at.x - LABEL_GAP}
            y={horizontal ? at.y - LABEL_GAP : at.y}
            textAnchor={horizontal ? (end ? "end" : "start") : "end"}
            dominantBaseline={horizontal ? "auto" : "middle"}
          >
            {formatValue(value, language, time)}
          </text>
        );
        return (
          <g key={id}>
            <line className="graph-guides__line" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
            {label(guide.min, from, false)}
            {label(guide.max, to, true)}
          </g>
        );
      }
      case "lane": {
        const from = project(guide.x1, guide.y);
        const to = project(guide.x2, guide.y);
        return (
          <line
            key={id}
            className="graph-guides__line graph-guides__line--lane"
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        );
      }
      case "strip": {
        const a = project(guide.x, guide.y);
        const b = project(guide.x + guide.width, guide.y - guide.height);
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return (
          <g key={id}>
            <rect
              className={
                map === undefined
                  ? "graph-guides__strip"
                  : "graph-guides__strip graph-guides__strip--on-map"
              }
              x={x}
              y={y}
              width={Math.abs(b.x - a.x)}
              height={Math.abs(b.y - a.y)}
            />
            <text className="graph-guides__text" x={x} y={y - LABEL_GAP}>
              {t(`graph.layout.strip.${guide.reason}`, { count: number.format(guide.count) })}
            </text>
          </g>
        );
      }
      default:
        return null;
    }
  });
  let backdrop = null;
  if (map !== undefined) {
    const northWest = project(map.x, map.y);
    const northEast = project(map.x + map.side, map.y);
    backdrop = (
      <Suspense fallback={null}>
        <MapBackdrop northWest={northWest} worldPx={northEast.x - northWest.x} />
      </Suspense>
    );
  }
  return (
    <>
      {backdrop}
      <svg className="graph-guides" aria-hidden="true" focusable="false">
        {drawn}
      </svg>
    </>
  );
});
