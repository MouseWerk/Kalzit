import { type PointerEvent, useId, useRef, useState } from "react";
import type { Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { valueAxis } from "../axis";
import {
  displayNameOf,
  displayText,
  displayValue,
  type FieldConfig,
  type FieldOptions,
  fieldOptionsFor,
} from "../fieldConfig/fieldConfig";
import { Legend, WithLegend } from "../fieldConfig/Legend";
import type { LegendOptions, TooltipMode } from "../fieldConfig/legendOptions";
import { axisTickFormat } from "../fieldConfig/units";
import { toNumber } from "../frame";
import { Readout, type ReadoutItem } from "../readout";
import { linePath } from "../timeseries/series";
import { useElementSize } from "../useElementSize";
import {
  COLOR_STEPS,
  colorStep,
  densityGrid,
  pointSize,
  sampleEvenly,
  type XYData,
  type XYShow,
  type XYSizes,
} from "./xyData";
import "../viz.css";
import "./xy.css";

const AXIS_LEFT = 56;
const AXIS_BOTTOM = 22;
const PAD_TOP = 8;
const PAD_RIGHT = 16;
/** About one value label per 40 px up and one per 90 px across, so labels never collide. */
const PX_PER_Y_TICK = 40;
const PX_PER_X_TICK = 90;
/** How near the pointer has to be to a point to read it out, in px. */
const NEAR_PX = 16;
/** A drag smaller than this is a click, not a zoom. */
const MIN_BRUSH_PX = 6;
/** Size of a density cell in px. */
const CELL_PX = 10;

interface Range {
  min: number;
  max: number;
}

/** The visible part of the chart after a drag: per axis, in data units. */
export interface XYView {
  x: Range;
  y: Range;
}

/** One drawn point: its series and its place in it. */
interface Drawn {
  s: number;
  i: number;
}

export interface XYChartProps {
  data: XYData;
  frames: readonly Frame[];
  config: FieldConfig;
  show: XYShow;
  sizes: XYSizes;
  /** 0 to 1. */
  opacity: number;
  /** The field the series are split by, for the readout's heading. */
  seriesBy: string | undefined;
  title: string;
  legend: LegendOptions;
  tooltip: TooltipMode;
}

/** The points to draw: all of them, or `MAX_XY_POINTS` evenly chosen; in X order for the keyboard. */
export function drawnPoints(data: XYData): { drawn: Drawn[]; sampled: boolean } {
  // Sampled over one flat index across the series; objects only for the points drawn.
  const offsets: number[] = [];
  let total = 0;
  for (const s of data.series) {
    offsets.push(total);
    total += s.xs.length;
  }
  const at = (k: number): Drawn => {
    let si = offsets.length - 1;
    while (si > 0 && (offsets[si] as number) > k) si--;
    return { s: si, i: k - (offsets[si] as number) };
  };
  const picked = sampleEvenly(total);
  const drawn =
    picked === null ? Array.from({ length: total }, (_, k) => at(k)) : Array.from(picked, at);
  const xOf = (d: Drawn) => data.series[d.s]?.xs[d.i] as number;
  drawn.sort((a, b) => xOf(a) - xOf(b) || a.s - b.s || a.i - b.i);
  return { drawn, sampled: picked !== null };
}

/**
 * The XY chart's drawing: two number axes, a point per row (or lines through a series in the
 * order of X), sized and coloured by fields when chosen. The pointer reads the nearest point;
 * arrow keys walk the points in X order. A dragged rectangle zooms in for this view only and a
 * double click goes back. Above `MAX_XY_POINTS` it draws an even sample, says so and offers a
 * density view of all points; the axes always cover every point.
 */
export function XYChart({
  data,
  frames,
  config,
  show,
  sizes,
  opacity,
  seriesBy,
  title,
  legend,
  tooltip,
}: XYChartProps) {
  const { t, language } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const clipId = `${useId()}-clip`;
  const { width, height } = useElementSize(boxRef);
  const [view, setView] = useState<XYView | null>(null);
  const [density, setDensity] = useState(false);
  const [brush, setBrush] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  const plotWidth = Math.max(width - AXIS_LEFT - PAD_RIGHT, 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD_TOP, 10);
  const xAxis = valueAxis(
    data.x.min,
    data.x.max,
    Math.max(2, Math.floor(plotWidth / PX_PER_X_TICK)),
    view === null ? { min: data.xOptions.min, max: data.xOptions.max } : view.x,
  );
  const yAxis = valueAxis(
    data.y.min,
    data.y.max,
    Math.max(2, Math.floor(plotHeight / PX_PER_Y_TICK)),
    view === null ? { min: config.defaults.min, max: config.defaults.max } : view.y,
  );
  const xSpan = xAxis.max - xAxis.min || 1;
  const ySpan = yAxis.max - yAxis.min || 1;
  const px = (x: number) => AXIS_LEFT + ((x - xAxis.min) / xSpan) * plotWidth;
  const py = (y: number) => PAD_TOP + plotHeight - ((y - yAxis.min) / ySpan) * plotHeight;
  const dataX = (p: number) => xAxis.min + ((p - AXIS_LEFT) / plotWidth) * xSpan;
  const dataY = (p: number) => yAxis.min + ((PAD_TOP + plotHeight - p) / plotHeight) * ySpan;
  const unit = (o: FieldOptions) => (o.unit === "none" ? undefined : o.unit);
  const xTick = axisTickFormat(xAxis.ticks, unit(data.xOptions), data.xOptions.decimals, language);
  const yTick = axisTickFormat(yAxis.ticks, unit(data.yOptions), data.yOptions.decimals, language);

  const { drawn, sampled } = drawnPoints(data);
  const inView = (x: number, y: number) =>
    x >= xAxis.min && x <= xAxis.max && y >= yAxis.min && y <= yAxis.max;
  const visible = drawn.filter((d) => {
    const s = data.series[d.s];
    return s !== undefined && inView(s.xs[d.i] as number, s.ys[d.i] as number);
  });

  const sizeOptions =
    data.sizeField === undefined ? undefined : fieldOptionsFor(data.sizeField, config);
  const colorOptions =
    data.colorField === undefined ? undefined : fieldOptionsFor(data.colorField, config);
  const cell = (frame: number, field: typeof data.sizeField, row: number) => {
    if (field === undefined) return null;
    const f = frames[frame]?.fields.find((x) => x.name === field.name);
    // As buildXY reads them: a value that is no number has none (smallest size, first step).
    return toNumber(f?.values[row]);
  };
  const fmt = (v: number | null, o: FieldOptions) =>
    v === null ? "" : displayText(displayValue(v, "number", o, language));
  // The readout of a point: a text field of its row and its series as the heading, then the
  // values of X, Y, size and colour.
  const items: ReadoutItem[] = density
    ? []
    : visible.map((d) => {
        const s = data.series[d.s];
        if (s === undefined) return { label: "", rows: [] };
        const row = s.rows[d.i] as number;
        const frame = frames[s.frame];
        const text = frame?.fields.find((f) => f.type === "string" && f.name !== seriesBy);
        const label = [text?.values[row], seriesBy === undefined ? undefined : s.name]
          .filter((v) => v !== null && v !== undefined && v !== "")
          .join(" · ");
        const rows = [
          {
            name: displayNameOf(data.xField, data.xOptions),
            value: fmt(s.xs[d.i] as number, data.xOptions),
          },
          {
            name: seriesBy === undefined ? s.name : displayNameOf(s.yField, s.options),
            value: fmt(s.ys[d.i] as number, s.options),
            colorClass: s.colorClass,
          },
        ];
        if (data.sizeField !== undefined && sizeOptions !== undefined) {
          rows.push({
            name: displayNameOf(data.sizeField, sizeOptions),
            value: fmt(cell(s.frame, data.sizeField, row), sizeOptions),
          } as (typeof rows)[number]);
        }
        if (
          data.colorField !== undefined &&
          colorOptions !== undefined &&
          data.colorField !== data.sizeField
        ) {
          rows.push({
            name: displayNameOf(data.colorField, colorOptions),
            value: fmt(cell(s.frame, data.colorField, row), colorOptions),
          } as (typeof rows)[number]);
        }
        return { label, rows };
      });

  const radius = (d: Drawn) => {
    const s = data.series[d.s];
    if (s === undefined || data.sizeField === undefined) return sizes.sizeMin / 2 + 1.5;
    return (
      pointSize(cell(s.frame, data.sizeField, s.rows[d.i] as number), data.sizeExtent, sizes) / 2
    );
  };
  const fillClass = (d: Drawn) => {
    const s = data.series[d.s];
    if (s === undefined) return "";
    if (data.colorField === undefined) return s.colorClass;
    return `ramp-blues-${colorStep(cell(s.frame, data.colorField, s.rows[d.i] as number), data.colorExtent)}`;
  };

  function pointerAt(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  const insidePlot = (p: { x: number; y: number }) =>
    p.x >= AXIS_LEFT &&
    p.x <= AXIS_LEFT + plotWidth &&
    p.y >= PAD_TOP &&
    p.y <= PAD_TOP + plotHeight;
  const clampX = (x: number) => Math.min(Math.max(x, AXIS_LEFT), AXIS_LEFT + plotWidth);
  const clampY = (y: number) => Math.min(Math.max(y, PAD_TOP), PAD_TOP + plotHeight);

  /** The visible point nearest to the pointer, within reach. */
  function nearest(p: { x: number; y: number }): number | null {
    let best: number | null = null;
    let bestDistance = NEAR_PX * NEAR_PX;
    visible.forEach((d, index) => {
      const s = data.series[d.s];
      if (s === undefined) return;
      const dx = px(s.xs[d.i] as number) - p.x;
      const dy = py(s.ys[d.i] as number) - p.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return best;
  }

  const legendItems =
    data.series.length > 1 || seriesBy !== undefined
      ? data.series.map((s) => ({ name: s.name, colorClass: s.colorClass }))
      : [];
  const count = new Intl.NumberFormat(language);
  const lines = show !== "points" && !density;
  const points = show !== "lines" && !density;
  const grid = density
    ? densityGrid(
        data.series,
        { min: xAxis.min, max: xAxis.max },
        { min: yAxis.min, max: yAxis.max },
        Math.max(1, Math.floor(plotWidth / CELL_PX)),
        Math.max(1, Math.floor(plotHeight / CELL_PX)),
      )
    : null;
  const columns = Math.max(1, Math.floor(plotWidth / CELL_PX));
  const rowsOfGrid = Math.max(1, Math.floor(plotHeight / CELL_PX));

  // The axes and marks, built here and not in the readout's callback, so a hover that only moves
  // the ring leaves the thousands of points as they are.
  const marks = (
    <>
      {yAxis.ticks
        .filter((tick) => tick >= yAxis.min && tick <= yAxis.max)
        .map((tick) => (
          <g key={`y${tick}`}>
            <line
              className="ts__grid"
              x1={AXIS_LEFT}
              x2={AXIS_LEFT + plotWidth}
              y1={py(tick)}
              y2={py(tick)}
            />
            <text className="ts__label" x={AXIS_LEFT - 6} y={py(tick)} textAnchor="end">
              {yTick(tick)}
            </text>
          </g>
        ))}
      {xAxis.ticks
        .filter((tick) => tick >= xAxis.min && tick <= xAxis.max)
        .map((tick) => (
          <g key={`x${tick}`}>
            <line
              className="ts__grid"
              x1={px(tick)}
              x2={px(tick)}
              y1={PAD_TOP}
              y2={PAD_TOP + plotHeight}
            />
            <text className="ts__label" x={px(tick)} y={height - 6} textAnchor="middle">
              {xTick(tick)}
            </text>
          </g>
        ))}
      <g clipPath={`url(#${clipId})`}>
        {grid === null
          ? null
          : grid.cells.map((c) => (
              <rect
                key={`${c.column}:${c.row}`}
                className={`xy__cell ramp-blues-${Math.min(
                  COLOR_STEPS,
                  Math.ceil((c.count / (grid.max || 1)) * COLOR_STEPS),
                )}`}
                x={AXIS_LEFT + (c.column * plotWidth) / columns}
                y={PAD_TOP + plotHeight - ((c.row + 1) * plotHeight) / rowsOfGrid}
                width={plotWidth / columns}
                height={plotHeight / rowsOfGrid}
              />
            ))}
        {lines
          ? data.series.map((s, si) => {
              const order = s.xs
                .map((_, i) => i)
                .sort((a, b) => (s.xs[a] as number) - (s.xs[b] as number));
              return (
                <path
                  // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
                  key={si}
                  className={`xy__line ${s.colorClass}`}
                  d={linePath(
                    order.map((i) => s.xs[i] as number),
                    order.map((i) => s.ys[i] as number),
                    { x: px, y: py },
                    AXIS_LEFT + plotWidth,
                  )}
                />
              );
            })
          : null}
        {points
          ? visible.map((d) => {
              const s = data.series[d.s];
              if (s === undefined) return null;
              return (
                <circle
                  key={`${d.s}:${d.i}`}
                  className={`xy__point ${fillClass(d)}`}
                  cx={px(s.xs[d.i] as number)}
                  cy={py(s.ys[d.i] as number)}
                  r={radius(d)}
                  fillOpacity={opacity}
                />
              );
            })
          : null}
      </g>
    </>
  );

  const bar = (
    <div className="xy__bar">
      {sampled ? (
        <span>
          {density
            ? t("panels.xy.densityNote", { total: count.format(data.total) })
            : t("panels.xy.sampled", {
                drawn: count.format(drawn.length),
                total: count.format(data.total),
              })}
        </span>
      ) : null}
      {sampled ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setDensity((d) => !d)}
        >
          {density ? t("panels.xy.showPoints") : t("panels.xy.showDensity")}
        </button>
      ) : null}
      {view === null ? null : (
        <>
          <span>
            {t("panels.xy.view", {
              x: `${xTick(view.x.min)} – ${xTick(view.x.max)}`,
              y: `${yTick(view.y.min)} – ${yTick(view.y.max)}`,
            })}
          </span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setView(null)}
          >
            {t("panels.xy.reset")}
          </button>
        </>
      )}
      {data.sizeField === undefined || sizeOptions === undefined ? null : (
        <span>
          {t("panels.xy.sizeNote", {
            field: displayNameOf(data.sizeField, sizeOptions),
            from: count.format(sizes.sizeMin),
            to: count.format(sizes.sizeMax),
          })}
        </span>
      )}
      {data.colorField === undefined ||
      data.colorExtent === undefined ||
      colorOptions === undefined ? null : (
        <span className="xy__scale">
          {fmt(data.colorExtent.min, colorOptions)}
          {Array.from({ length: COLOR_STEPS }, (_, i) => `ramp-blues-${i + 1}`).map((ramp) => (
            <span key={ramp} className={`xy__scale-step ${ramp}`} aria-hidden="true" />
          ))}
          {fmt(data.colorExtent.max, colorOptions)}
        </span>
      )}
    </div>
  );
  const hasBar =
    sampled || view !== null || data.sizeField !== undefined || data.colorField !== undefined;

  return (
    <WithLegend
      placement={legend.placement}
      legend={legendItems.length === 0 ? null : <Legend options={legend} items={legendItems} />}
    >
      <div className="xy">
        {hasBar ? bar : null}
        <Readout title={title} items={items} tooltip={tooltip} className="xy__plot">
          {(active, hover) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: pointer zoom; the keyboard walks the points in the readout
            <div
              className="xy__box"
              ref={boxRef}
              onPointerDown={(event) => {
                const p = pointerAt(event);
                if (event.button !== 0 || !insidePlot(p)) return;
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setBrush({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
              }}
              onPointerMove={(event) => {
                const p = pointerAt(event);
                if (brush !== null) {
                  setBrush({ ...brush, x1: clampX(p.x), y1: clampY(p.y) });
                  return;
                }
                if (!density) hover(insidePlot(p) ? nearest(p) : null);
              }}
              onPointerUp={() => {
                if (brush === null) return;
                const w = Math.abs(brush.x1 - brush.x0);
                const h = Math.abs(brush.y1 - brush.y0);
                setBrush(null);
                if (w < MIN_BRUSH_PX || h < MIN_BRUSH_PX) return;
                const xs = [dataX(brush.x0), dataX(brush.x1)].sort((a, b) => a - b);
                const ys = [dataY(brush.y0), dataY(brush.y1)].sort((a, b) => a - b);
                setView({
                  x: { min: xs[0] as number, max: xs[1] as number },
                  y: { min: ys[0] as number, max: ys[1] as number },
                });
              }}
              onPointerCancel={() => setBrush(null)}
              onDoubleClick={() => setView(null)}
            >
              <svg className="xy__svg" width={width} height={height} aria-hidden="true">
                <defs>
                  <clipPath id={clipId}>
                    <rect x={AXIS_LEFT} y={PAD_TOP} width={plotWidth} height={plotHeight} />
                  </clipPath>
                </defs>
                {marks}
                {active === null || visible[active] === undefined ? null : (
                  <circle
                    className="xy__ring"
                    cx={px(
                      data.series[(visible[active] as Drawn).s]?.xs[
                        (visible[active] as Drawn).i
                      ] as number,
                    )}
                    cy={py(
                      data.series[(visible[active] as Drawn).s]?.ys[
                        (visible[active] as Drawn).i
                      ] as number,
                    )}
                    r={radius(visible[active] as Drawn) + 3}
                  />
                )}
                {brush === null ? null : (
                  <rect
                    className="xy__brush"
                    x={Math.min(brush.x0, brush.x1)}
                    y={Math.min(brush.y0, brush.y1)}
                    width={Math.abs(brush.x1 - brush.x0)}
                    height={Math.abs(brush.y1 - brush.y0)}
                  />
                )}
              </svg>
            </div>
          )}
        </Readout>
      </div>
    </WithLegend>
  );
}
