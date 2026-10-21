import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../i18n/i18n";
import { useStyleVars } from "../styleVars";
import { nearestIndex, type Series } from "./series";

export interface TimeSeriesChartProps {
  series: readonly Series[];
  timeRange: { from: number; to: number };
  title: string;
  unit: string;
  lineWidth: number;
  showLegend: boolean;
}

/** Series colors cycle through this many palette entries (`--chart-1` ... `--chart-8`). */
export const SERIES_COLORS = 8;

/** Where the plot area lies inside the chart box, in CSS pixels. */
export interface PlotArea {
  left: number;
  width: number;
}

interface ChartShellProps {
  series: readonly Series[];
  title: string;
  unit: string;
  showLegend: boolean;
  boxRef: RefObject<HTMLDivElement | null>;
  plot: PlotArea;
  /** The time at a horizontal position in the box. */
  timeAt: (x: number) => number;
  /** The drawing; it gets the cursor position to draw, or null. */
  children: (cursorX: number | null) => ReactNode;
}

/**
 * Everything around a time series drawing that both renderers share: the focusable plot with
 * the keyboard readout and its live region, the hover tooltip and the legend. Left and Right
 * move the cursor by a fiftieth of the width (Shift: a tenth), Home and End jump, Escape clears.
 */
export function ChartShell({
  series,
  title,
  unit,
  showLegend,
  boxRef,
  plot,
  timeAt,
  children,
}: ChartShellProps) {
  const { t, language } = useI18n();
  const hintId = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const valueLabel = new Intl.NumberFormat(language, { maximumFractionDigits: 3 });
  const cursorTime = cursorX === null ? null : timeAt(cursorX);
  const readout =
    cursorTime === null
      ? []
      : series.map((s, index) => {
          const i = nearestIndex(s.times, cursorTime);
          return { index, name: s.name, value: i === -1 ? Number.NaN : (s.values[i] as number) };
        });
  const valueText = (value: number) =>
    `${valueLabel.format(value)}${unit === "" ? "" : ` ${unit}`}`;
  const spoken =
    cursorTime === null
      ? ""
      : [
          new Date(cursorTime).toLocaleString(language),
          ...readout.map(
            (row) =>
              `${row.name}: ${Number.isNaN(row.value) ? t("dashboards.panels.noValue") : valueText(row.value)}`,
          ),
        ].join(", ");
  useStyleVars(tooltipRef, { "--hover-x": `${cursorX ?? 0}px` });

  const clamp = (x: number) => Math.min(Math.max(x, plot.left), plot.left + plot.width);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = cursorX ?? plot.left + plot.width / 2;
    const step = plot.width / (event.shiftKey ? 10 : 50);
    const keys: Record<string, number> = {
      ArrowLeft: current - step,
      ArrowRight: current + step,
      Home: plot.left,
      End: plot.left + plot.width,
    };
    const next = keys[event.key];
    if (next !== undefined) {
      event.preventDefault();
      setCursorX(clamp(next));
    } else if (event.key === "Escape" && cursorX !== null) {
      event.stopPropagation();
      setCursorX(null);
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    setCursorX(x >= plot.left && x <= plot.left + plot.width ? x : null);
  }

  return (
    <div className="ts">
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable plot, not a set of form fields */}
      <div
        className="ts__plot"
        ref={boxRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot takes focus for the keyboard readout
        tabIndex={0}
        role="group"
        aria-label={title}
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onFocus={() => setCursorX((x) => x ?? plot.left + plot.width / 2)}
        onBlur={() => setCursorX(null)}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setCursorX(null)}
      >
        <span className="visually-hidden" id={hintId}>
          {t("dashboards.panels.readoutHint")}
        </span>
        <span className="visually-hidden" role="status">
          {spoken}
        </span>
        {children(cursorX)}
        {cursorTime === null ? null : (
          <div className="ts__tooltip" ref={tooltipRef} aria-hidden="true">
            <div className="ts__tooltip-time">{new Date(cursorTime).toLocaleString(language)}</div>
            {readout.map((row) => (
              <div key={row.index} className="ts__tooltip-row">
                <span className={`ts__swatch series-${(row.index % SERIES_COLORS) + 1}`} />
                <span className="truncate">{row.name}</span>
                <span className="ts__tooltip-value">
                  {Number.isNaN(row.value) ? "" : valueText(row.value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {showLegend && series.length > 0 ? (
        <ul className="ts__legend">
          {series.map((s, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
            <li key={index} className="ts__legend-item">
              <span className={`ts__swatch series-${(index % SERIES_COLORS) + 1}`} />
              <span className="truncate" title={s.name}>
                {s.name}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
