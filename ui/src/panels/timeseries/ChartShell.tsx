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
import { useEscapeLayer } from "../../lib/layers";
import { toneClass } from "../fieldConfig/fieldConfig";
import { Legend, type LegendItem, WithLegend } from "../fieldConfig/Legend";
import { type LegendOptions, seriesStats, type TooltipMode } from "../fieldConfig/legendOptions";
import { useStyleVars } from "../styleVars";
import { nearestIndex, type Series } from "./series";
import "../panels.css";
import "../viz.css";

export interface TimeSeriesChartProps {
  series: readonly Series[];
  timeRange: { from: number; to: number };
  title: string;
  lineWidth: number;
  legend: LegendOptions;
  tooltip: TooltipMode;
  /** A value of series `index` as text, with its unit, decimals and mappings. */
  format: (index: number, value: number) => string;
  /** A value axis tick as text. */
  axisFormat: (value: number) => string;
  /** Fixed ends of the value axis from the field options; open ends follow the data. */
  yRange?: { min?: number | undefined; max?: number | undefined };
}

/** Series colors cycle through this many palette entries (`--chart-1` ... `--chart-8`). */
export const SERIES_COLORS = 8;

/** The color class of a series: its fixed color from the field options, else its palette entry. */
export function seriesClass(series: Series, index: number): string {
  return toneClass(series.options?.color, index);
}

/** Where the plot area lies inside the chart box, in CSS pixels. */
export interface PlotArea {
  left: number;
  width: number;
}

interface ChartShellProps {
  series: readonly Series[];
  title: string;
  legend: LegendOptions;
  tooltip: TooltipMode;
  format: (index: number, value: number) => string;
  boxRef: RefObject<HTMLDivElement | null>;
  plot: PlotArea;
  /** The time at a horizontal position in the box. */
  timeAt: (x: number) => number;
  /** The value at a vertical position in the box, for the single-series tooltip. */
  valueAt?: (y: number) => number;
  /** The drawing; it gets the cursor position to draw, or null. */
  children: (cursorX: number | null) => ReactNode;
}

/**
 * Everything around a time series drawing that both renderers share: the focusable plot with
 * the keyboard readout and its live region, the hover tooltip and the legend. Left and Right
 * move the cursor by a fiftieth of the width (Shift: a tenth), Home and End jump, Escape clears.
 * The keyboard readout always names every series; the tooltip shows all of them, only the one
 * nearest to the pointer, or nothing, as the tooltip option says.
 */
export function ChartShell({
  series,
  title,
  legend,
  tooltip,
  format,
  boxRef,
  plot,
  timeAt,
  valueAt,
  children,
}: ChartShellProps) {
  const { t, language } = useI18n();
  const hintId = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);
  // Whether the plot has keyboard focus and the cursor follows the keyboard (not the pointer).
  const [focused, setFocused] = useState(false);
  const [byKeyboard, setByKeyboard] = useState(false);

  // Escape clears the keyboard readout first; only the next Escape reaches a dialog around the
  // chart. Layers are handled in a document capture listener, so stopping the event in the
  // plot's own handler would come too late.
  useEscapeLayer(focused && byKeyboard && cursorX !== null, () => {
    setCursorX(null);
    setByKeyboard(false);
  });
  const cursorTime = cursorX === null ? null : timeAt(cursorX);
  const readout =
    cursorTime === null
      ? []
      : series.map((s, index) => {
          const i = nearestIndex(s.times, cursorTime);
          return { index, name: s.name, value: i === -1 ? Number.NaN : (s.values[i] as number) };
        });
  // Read out only what the keyboard asked for; hovering would make a screen reader chatter.
  const spoken =
    cursorTime === null || !byKeyboard
      ? ""
      : [
          new Date(cursorTime).toLocaleString(language),
          ...readout.map(
            (row) =>
              `${row.name}: ${Number.isNaN(row.value) ? t("dashboards.panels.noValue") : format(row.index, row.value)}`,
          ),
        ].join(", ");
  useStyleVars(tooltipRef, { "--hover-x": `${cursorX ?? 0}px` });

  // The single tooltip shows the series whose value is nearest to the pointer.
  let shown = readout;
  if (tooltip === "single" && !byKeyboard && cursorY !== null && valueAt !== undefined) {
    const target = valueAt(cursorY);
    const present = readout.filter((row) => !Number.isNaN(row.value));
    const nearest = present.reduce<(typeof readout)[number] | undefined>(
      (best, row) =>
        best === undefined || Math.abs(row.value - target) < Math.abs(best.value - target)
          ? row
          : best,
      undefined,
    );
    shown = nearest === undefined ? [] : [nearest];
  }

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
      setByKeyboard(true);
      setCursorX(clamp(next));
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    setByKeyboard(false);
    setCursorX(x >= plot.left && x <= plot.left + plot.width ? x : null);
    setCursorY(event.clientY - rect.top);
  }

  const legendItems: LegendItem[] = series.map((s, index) => {
    const stats = legend.values.length === 0 ? null : seriesStats(s.values);
    const values: LegendItem["values"] = {};
    if (stats !== null) {
      for (const key of legend.values) {
        const value = stats[key];
        values[key] = Number.isNaN(value) ? "" : format(index, value);
      }
    }
    return { name: s.name, colorClass: seriesClass(s, index), values };
  });

  return (
    <WithLegend
      placement={legend.placement}
      legend={<Legend items={legendItems} options={legend} />}
    >
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
          onFocus={(event) => {
            setFocused(true);
            // Keyboard focus starts the readout in the middle; a click only focuses.
            if (event.currentTarget.matches(":focus-visible")) {
              setByKeyboard(true);
              setCursorX((x) => x ?? plot.left + plot.width / 2);
            }
          }}
          onBlur={() => {
            setFocused(false);
            setByKeyboard(false);
            setCursorX(null);
          }}
          onPointerMove={onPointerMove}
          onPointerLeave={() => {
            if (!byKeyboard) {
              setCursorX(null);
            }
          }}
        >
          <span className="visually-hidden" id={hintId}>
            {t("dashboards.panels.readoutHint")}
          </span>
          <span className="visually-hidden" role="status">
            {spoken}
          </span>
          {children(cursorX)}
          {cursorTime === null || tooltip === "hidden" ? null : (
            <div className="ts__tooltip" ref={tooltipRef} aria-hidden="true">
              <div className="ts__tooltip-time">
                {new Date(cursorTime).toLocaleString(language)}
              </div>
              {shown.map((row) => (
                <div key={row.index} className="ts__tooltip-row">
                  <span
                    className={`ts__swatch ${seriesClass(series[row.index] as Series, row.index)}`}
                  />
                  <span className="truncate">{row.name}</span>
                  <span className="ts__tooltip-value">
                    {Number.isNaN(row.value) ? "" : format(row.index, row.value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </WithLegend>
  );
}
