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
import { AnnotationMarks, isAddAnnotationKey } from "../AnnotationMarks";
import { usePanelAnnotations } from "../annotations";
import { useSharedCursor } from "../crosshair";
import { Legend, type LegendItem, Swatch, WithLegend } from "../fieldConfig/Legend";
import { type LegendOptions, seriesStats, type TooltipMode } from "../fieldConfig/legendOptions";
import { useStyleVars } from "../styleVars";
import { nearestIndex, type Series } from "./series";
import type { SeriesStyle } from "./styles";
import "../panels.css";
import "../viz.css";
import { zoneOption } from "../../lib/timeSettings";

export interface TimeSeriesChartProps {
  series: readonly Series[];
  /** How each series is drawn, resolved from its graph style options (`styles.ts`). */
  styles: readonly SeriesStyle[];
  timeRange: { from: number; to: number };
  title: string;
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

/** Where the plot area lies inside the chart box, in CSS pixels. */
export interface PlotArea {
  left: number;
  width: number;
}

interface ChartShellProps {
  series: readonly Series[];
  /** Each series' swatch in legend and tooltip comes from its style. */
  styles: readonly SeriesStyle[];
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
  styles,
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
  const { t, language, timeZone } = useI18n();
  const hintId = useId();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);
  // Whether the plot has keyboard focus and the cursor follows the keyboard (not the pointer).
  const [focused, setFocused] = useState(false);
  const [byKeyboard, setByKeyboard] = useState(false);
  const annotations = usePanelAnnotations();
  const annotateHintId = useId();
  const onAdd = annotations?.onAdd;

  // Escape clears the keyboard readout first; only the next Escape reaches a dialog around the
  // chart. Layers are handled in a document capture listener, so stopping the event in the
  // plot's own handler would come too late.
  useEscapeLayer(focused && byKeyboard && cursorX !== null, () => {
    setCursorX(null);
    setByKeyboard(false);
  });
  // The dashboard's shared cursor: this chart publishes the time under its pointer and draws the
  // time another panel points at while its own pointer is elsewhere.
  const sharedCursor = useSharedCursor();
  const plotFrom = timeAt(plot.left);
  const plotTo = timeAt(plot.left + plot.width);
  const otherX =
    cursorX !== null ||
    sharedCursor.time === null ||
    sharedCursor.time < plotFrom ||
    sharedCursor.time > plotTo ||
    plotTo <= plotFrom
      ? null
      : plot.left + ((sharedCursor.time - plotFrom) / (plotTo - plotFrom)) * plot.width;
  const shownX = cursorX ?? otherX;
  const cursorTime =
    cursorX === null ? (otherX === null ? null : sharedCursor.time) : timeAt(cursorX);
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
          new Date(cursorTime).toLocaleString(language, zoneOption(timeZone)),
          ...readout.map(
            (row) =>
              `${row.name}: ${Number.isNaN(row.value) ? t("dashboards.panels.noValue") : format(row.index, row.value)}`,
          ),
        ].join(", ");
  useStyleVars(tooltipRef, { "--hover-x": `${shownX ?? 0}px` });

  // The single tooltip shows the series whose value is nearest to the pointer.
  let shown = readout;
  if (
    tooltip === "single" &&
    !byKeyboard &&
    cursorX !== null &&
    cursorY !== null &&
    valueAt !== undefined
  ) {
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
    // "A" adds an annotation where the keyboard readout stands.
    if (onAdd !== undefined && isAddAnnotationKey(event) && event.target === event.currentTarget) {
      event.preventDefault();
      onAdd(timeAt(cursorX ?? plot.left + plot.width / 2));
      return;
    }
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
    const inside = x >= plot.left && x <= plot.left + plot.width;
    setByKeyboard(false);
    setCursorX(inside ? x : null);
    sharedCursor.publish(inside ? timeAt(x) : null);
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
    return {
      name: s.name,
      colorClass: styles[index]?.swatchClass ?? "",
      freeColor: styles[index]?.freeColor ?? null,
      values,
    };
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
          aria-describedby={onAdd === undefined ? hintId : `${hintId} ${annotateHintId}`}
          onKeyDown={onKeyDown}
          onClick={(event) => {
            // Ctrl+click (Cmd+click on macOS) adds an annotation at that time.
            if (onAdd !== undefined && (event.ctrlKey || event.metaKey)) {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = Math.min(
                Math.max(event.clientX - rect.left, plot.left),
                plot.left + plot.width,
              );
              onAdd(timeAt(x));
            }
          }}
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
            sharedCursor.publish(null);
          }}
          onPointerMove={onPointerMove}
          onPointerLeave={() => {
            sharedCursor.publish(null);
            if (!byKeyboard) {
              setCursorX(null);
            }
          }}
        >
          <span className="visually-hidden" id={hintId}>
            {t("dashboards.panels.readoutHint")}
          </span>
          {onAdd === undefined ? null : (
            <span className="visually-hidden" id={annotateHintId}>
              {t("annotations.addHint")}
            </span>
          )}
          <span className="visually-hidden" role="status">
            {spoken}
          </span>
          {children(shownX)}
          {annotations === null ? null : (
            <AnnotationMarks
              annotations={annotations}
              plot={plot}
              from={timeAt(plot.left)}
              to={timeAt(plot.left + plot.width)}
            />
          )}
          {cursorTime === null ||
          tooltip === "hidden" ||
          (cursorX === null && sharedCursor.mode !== "tooltip") ? null : (
            <div
              // Past the middle the tooltip opens to the left, so the edge never cuts it off.
              className={
                (shownX ?? 0) > plot.left + plot.width / 2
                  ? "ts__tooltip ts__tooltip--flip"
                  : "ts__tooltip"
              }
              ref={tooltipRef}
              aria-hidden="true"
            >
              <div className="ts__tooltip-time">
                {new Date(cursorTime).toLocaleString(language, zoneOption(timeZone))}
              </div>
              {shown.map((row) => (
                <div key={row.index} className="ts__tooltip-row">
                  <Swatch
                    className={styles[row.index]?.swatchClass ?? ""}
                    freeColor={styles[row.index]?.freeColor}
                  />
                  <span className="truncate" title={row.name}>
                    {row.name}
                  </span>
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
