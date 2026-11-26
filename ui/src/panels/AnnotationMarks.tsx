import { type KeyboardEvent, useRef } from "react";
import { useI18n } from "../i18n/i18n";
import { matchesShortcut } from "../shortcuts/registry";
import type { PanelAnnotation, PanelAnnotations } from "./annotations";
import { useStyleVars } from "./styleVars";
import "./annotations.css";
import "./panels.css";

/** The registry's key for adding an annotation at the keyboard readout ("A"). */
export function isAddAnnotationKey(event: KeyboardEvent): boolean {
  return matchesShortcut("chart.annotateKey", event);
}

interface AnnotationMarksProps {
  annotations: PanelAnnotations;
  /** Where the plot area lies in the chart box, in CSS pixels. */
  plot: { left: number; width: number; top?: number | undefined; height?: number | undefined };
  /** The times at the plot's left and right edge. */
  from: number;
  to: number;
}

/**
 * Annotations on a time axis: a thin line for a point in time, a light band for a span, each in
 * its own color and with a small marker on the time axis that names it and opens it. Lines and
 * bands cover the plot area only, so many annotations over a dense chart leave the series
 * readable. Marks outside the shown range are left out.
 */
export function AnnotationMarks({ annotations, plot, from, to }: AnnotationMarksProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  useStyleVars(
    layerRef,
    plot.top === undefined || plot.height === undefined
      ? {}
      : { "--ann-top": `${plot.top}px`, "--ann-h": `${plot.height}px` },
  );
  const span = to - from;
  if (!(span > 0)) {
    return null;
  }
  const xAt = (time: number) => plot.left + ((time - from) / span) * plot.width;
  const shown = annotations.marks.filter((m) => (m.timeEnd ?? m.time) >= from && m.time <= to);
  if (shown.length === 0) {
    return null;
  }
  return (
    <div className="ann-layer" ref={layerRef}>
      {shown.map((mark) => {
        const start = Math.max(xAt(mark.time), plot.left);
        const end = Math.min(xAt(mark.timeEnd ?? mark.time), plot.left + plot.width);
        return (
          <Mark
            key={mark.key}
            mark={mark}
            x={start}
            width={Math.max(end - start, 0)}
            onOpen={() => annotations.onOpen(mark)}
          />
        );
      })}
    </div>
  );
}

function Mark({
  mark,
  x,
  width,
  onOpen,
}: {
  mark: PanelAnnotation;
  x: number;
  width: number;
  onOpen: () => void;
}) {
  const { t, language } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useStyleVars(ref, { "--ann-x": `${x}px`, "--ann-w": `${width}px` });
  const when = new Date(mark.time).toLocaleString(language);
  const color = mark.color === undefined ? "" : ` series-${mark.color}`;
  return (
    <div ref={ref} className={`ann${mark.timeEnd === null ? "" : " ann--span"}${color}`}>
      {/* The line or band, drawn in SVG so its strength comes from fill and stroke opacity. */}
      <svg className="ann__mark" aria-hidden="true">
        {mark.timeEnd === null ? (
          <line className="ann__line" x1="0.5" x2="0.5" y1="0" y2="100%" />
        ) : (
          <rect className="ann__band" width="100%" height="100%" />
        )}
      </svg>
      <button
        type="button"
        className="ann__handle"
        title={mark.text}
        aria-label={t("annotations.markLabel", { text: mark.text, time: when })}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onKeyDown={(event) => event.stopPropagation()}
      />
    </div>
  );
}
