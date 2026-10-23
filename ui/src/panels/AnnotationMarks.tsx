import { type KeyboardEvent, useRef } from "react";
import { useI18n } from "../i18n/i18n";
import type { PanelAnnotation, PanelAnnotations } from "./annotations";
import { useStyleVars } from "./styleVars";
import "./annotations.css";
import "./panels.css";

/** "A" without modifiers: add an annotation at the keyboard readout. */
export function isAddAnnotationKey(event: KeyboardEvent): boolean {
  return (
    (event.key === "a" || event.key === "A") && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

interface AnnotationMarksProps {
  annotations: PanelAnnotations;
  /** Where the plot area lies in the chart box, in CSS pixels. */
  plot: { left: number; width: number };
  /** The times at the plot's left and right edge. */
  from: number;
  to: number;
}

/**
 * Annotations on a time axis: a line for a point in time, a band for a span, each with a button
 * at the top that names it and opens it. Marks outside the shown range are left out.
 */
export function AnnotationMarks({ annotations, plot, from, to }: AnnotationMarksProps) {
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
    <div className="ann-layer">
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
