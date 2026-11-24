import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from "react";
import { FloatingTooltip, type FloatingTooltipHandle } from "../../components/FloatingTooltip";
import { useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import {
  ANCHOR_GAP_PX,
  POINTER_GAP_PX,
  type TooltipAnchor,
  visibleBox,
} from "../../lib/tooltipPlace";
import { isMac } from "../../shortcuts/platform";
import { shortcutSpoken } from "../../shortcuts/registry";
import { AnnotationMarks, isAddAnnotationKey } from "../AnnotationMarks";
import { usePanelAnnotations } from "../annotations";
import { useSharedCursor } from "../crosshair";
import { Legend, type LegendItem, Swatch, WithLegend } from "../fieldConfig/Legend";
import { type LegendOptions, seriesStats, type TooltipMode } from "../fieldConfig/legendOptions";
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
  /** A value axis tick as text; the axis' other ticks decide how many digits it takes. */
  axisFormat: (value: number, ticks: readonly number[]) => string;
  /** Fixed ends of the value axis from the field options; open ends follow the data. */
  yRange?: { min?: number | undefined; max?: number | undefined };
  /**
   * An X axis of numbers instead of time (the Trend panel): `timeRange` is then the span of the
   * numbers, the ticks are round numbers written by `format`, and the dashboard's shared cursor
   * and annotations, which are times, stay off.
   */
  numberAxis?: NumberAxis;
}

/** How a number X axis writes its values. */
export interface NumberAxis {
  format: (x: number) => string;
}

/** The shared cursor of a chart that takes no part in the dashboard's (a number axis). */
const NO_SHARED_CURSOR: ReturnType<typeof useSharedCursor> = {
  mode: "off",
  time: null,
  publish: () => {},
};

/** Series colors cycle through this many palette entries (`--chart-1` ... `--chart-8`). */
export const SERIES_COLORS = 8;

/** Where the plot area lies inside the chart box, in CSS pixels. */
export interface PlotArea {
  left: number;
  width: number;
  /** The plot's top and height; annotations stand on its time axis where these are known. */
  top?: number | undefined;
  height?: number | undefined;
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
  /** The X axis is numbers written this way (`numberAxis`), not times. */
  xFormat?: ((x: number) => string) | undefined;
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
  xFormat,
  children,
}: ChartShellProps) {
  const { t, language, timeZone } = useI18n();
  const hintId = useId();
  const tooltipRef = useRef<FloatingTooltipHandle>(null);
  // Where the pointer is, in the viewport: the tooltip's place while this chart is hovered.
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);
  // Whether the plot has keyboard focus and the cursor follows the keyboard (not the pointer).
  const [focused, setFocused] = useState(false);
  const [byKeyboard, setByKeyboard] = useState(false);
  // Annotations and the shared cursor are times; a number axis has neither.
  const panelAnnotations = usePanelAnnotations();
  const annotations = xFormat === undefined ? panelAnnotations : null;
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
  const dashboardCursor = useSharedCursor();
  const sharedCursor = xFormat === undefined ? dashboardCursor : NO_SHARED_CURSOR;
  const xLabel = (x: number) =>
    xFormat === undefined ? new Date(x).toLocaleString(language, zoneOption(timeZone)) : xFormat(x);
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
          xLabel(cursorTime),
          ...readout.map(
            (row) =>
              `${row.name}: ${Number.isNaN(row.value) ? t("dashboards.panels.noValue") : format(row.index, row.value)}`,
          ),
        ].join(", ");

  // The tooltip lies above the whole page (FloatingTooltip). Under this chart's own pointer it
  // sits beside the pointer; for the keyboard's cursor and for the time another panel points at
  // it sits beside the cursor line at the top of what shows of the plot and stays inside it:
  // never under a sticky bar or over another panel, and not shown when it does not fit there.
  function tooltipAnchor(): TooltipAnchor | null {
    const pointer = pointerRef.current;
    if (cursorX !== null && !byKeyboard && pointer !== null) {
      return { ...pointer, gapX: POINTER_GAP_PX, gapY: POINTER_GAP_PX };
    }
    const box = boxRef.current;
    const shown = box === null || shownX === null ? null : visibleBox(box);
    if (box === null || shownX === null || shown === null) {
      return null;
    }
    const x = box.getBoundingClientRect().left + shownX;
    if (x < shown.left || x > shown.right) {
      return null;
    }
    return { x, y: shown.top, gapX: ANCHOR_GAP_PX, gapY: ANCHOR_GAP_PX, within: shown };
  }

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
    // A move that changes no value on show renders nothing; the tooltip still follows.
    pointerRef.current = { x: event.clientX, y: event.clientY };
    tooltipRef.current?.place();
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
            if (onAdd !== undefined && (isMac() ? event.metaKey : event.ctrlKey)) {
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
              {t("annotations.addHint", { click: shortcutSpoken("chart.annotateClick", language) })}
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
            <FloatingTooltip ref={tooltipRef} className="ts__tooltip" anchor={tooltipAnchor}>
              <div className="ts__tooltip-time">{xLabel(cursorTime)}</div>
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
            </FloatingTooltip>
          )}
        </div>
      </div>
    </WithLegend>
  );
}
