import { type ReactNode, useId, useRef } from "react";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import {
  backward,
  drawable,
  drawableExtent,
  forward,
  type ValueScale,
  valueScale,
} from "../axisScale";
import type { ThresholdStep } from "../fieldConfig/fieldConfig";
import { toneClass } from "../fieldConfig/fieldConfig";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import { chartData } from "./align";
import type { AxisPlan } from "./axes";
import { ChartShell, chartAxes, type TimeSeriesChartProps } from "./ChartShell";
import { PX_PER_TIME_TICK, PX_PER_VALUE_TICK, TIME_LABEL_OVERHANG } from "./layout";
import { linePath, type Scale, timeTicks } from "./series";
import { FREE_CLASS, type SeriesStyle } from "./styles";
import { shownThresholds, thresholdBands, thresholdLines } from "./thresholdBands";
import "../panels.css";

/** Width of a value axis without a fixed width (the SVG chart does not measure its labels). */
const AXIS_SIZE = 56;
/** Room for an axis label turned along the axis. */
const TITLE_ROOM = 16;
/** Room left of the plot when there is no left axis. */
const PAD_LEFT = 8;
const AXIS_BOTTOM = 22;
const PAD_TOP = 8;
const PAD_RIGHT = TIME_LABEL_OVERHANG;
/** Points and bars are drawn one by one only up to this many per series; more draw as a line. */
const MAX_MARKS = 2000;

const DAY = 24 * 60 * 60 * 1000;

/** A number token of the theme, or the fallback where styles are not computed (tests). */
function tokenNumber(name: string, fallback: number): number {
  const value = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue(name),
  );
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The fill under a line as SVG, one closed shape per run of present values, so a missing value
 * leaves a gap in the fill as in the line. A stacked line fills to its own baseline, walked back;
 * others fill to zero (`zero` is its y in px).
 */
export function areaPath(
  xs: readonly number[],
  ys: readonly (number | null)[],
  base: Float64Array | null,
  scale: Scale,
  right: number,
  interpolation: SeriesStyle["interpolation"],
  zero: number,
): string {
  // Walked backward, a step after the point is a step before it.
  const backward =
    interpolation === "stepAfter"
      ? "stepBefore"
      : interpolation === "stepBefore"
        ? "stepAfter"
        : interpolation;
  const shapes: string[] = [];
  let start = -1;
  for (let i = 0; i <= ys.length; i++) {
    const present = i < ys.length && ys[i] !== null && ys[i] !== undefined;
    if (present && start === -1) {
      start = i;
    } else if (!present && start !== -1) {
      const runX = xs.slice(start, i);
      const top = linePath(runX, ys.slice(start, i), scale, right, interpolation);
      if (base === null) {
        const left = scale.x(runX[0] as number).toFixed(1);
        shapes.push(`${top}V${zero.toFixed(1)}H${left}Z`);
      } else {
        const back = linePath(
          [...runX].reverse(),
          Array.from(base.subarray(start, i)).reverse(),
          scale,
          right,
          backward,
        ).replace("M", "L");
        shapes.push(`${top}${back}Z`);
      }
      start = -1;
    }
  }
  return shapes.join("");
}

/**
 * A group that carries a free colour as `--free-color` (set through the CSSOM), which the
 * `series-free` class reads; other colours come from their class alone.
 */
function ColorGroup({ freeColor, children }: { freeColor: string | null; children: ReactNode }) {
  const ref = useRef<SVGGElement>(null);
  useStyleVars(ref, freeColor === null ? {} : { "--free-color": freeColor });
  return <g ref={ref}>{children}</g>;
}

/** The colour class and free colour of a threshold step. */
function stepLook(step: ThresholdStep): { colorClass: string; freeColor: string | null } {
  return step.color === undefined
    ? { colorClass: toneClass(step.tone), freeColor: null }
    : { colorClass: FREE_CLASS, freeColor: step.color };
}

/** The thresholds a series asks for: tinted bands behind the series, dashed lines over them. */
function ThresholdMarks({
  styles,
  scale,
  min,
  max,
  left,
  width,
  layer,
}: {
  styles: readonly SeriesStyle[];
  scale: Scale;
  min: number;
  max: number;
  left: number;
  width: number;
  layer: "bands" | "lines";
}): ReactNode {
  const shown = shownThresholds(styles);
  if (shown === null) {
    return null;
  }
  const { thresholds, display } = shown;
  if (layer === "bands") {
    if (display !== "areas" && display !== "linesAndAreas") return null;
    return thresholdBands(thresholds, min, max).map((band, index) => {
      const look = stepLook(band.step);
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: bands are in axis order; two steps may share a value
        <ColorGroup key={index} freeColor={look.freeColor}>
          <rect
            className={`ts__threshold-band ${look.colorClass}`}
            x={left}
            y={scale.y(band.to)}
            width={width}
            height={Math.max(0, scale.y(band.from) - scale.y(band.to))}
          />
        </ColorGroup>
      );
    });
  }
  if (display !== "lines" && display !== "linesAndAreas") return null;
  return thresholdLines(thresholds, min, max).map((line, index) => {
    const look = stepLook(line.step);
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: lines are in step order; two steps may share a value
      <ColorGroup key={index} freeColor={look.freeColor}>
        <line
          className={`ts__threshold-line ${look.colorClass}`}
          x1={left}
          x2={left + width}
          y1={scale.y(line.value)}
          y2={scale.y(line.value)}
        />
      </ColorGroup>
    );
  });
}

/** The marks of one series: bars, points or a line with its fill, in the series' colour. */
function SeriesMarks(props: Parameters<typeof Marks>[0]): ReactNode {
  return (
    <ColorGroup freeColor={props.look.freeColor}>
      <Marks {...props} />
    </ColorGroup>
  );
}

/** The marks of one series: bars, points or a line with its fill. */
function Marks({
  look: style,
  xs,
  ys,
  base,
  scale,
  left,
  right,
  ids,
}: {
  look: SeriesStyle;
  xs: readonly number[];
  ys: readonly (number | null)[];
  base: Float64Array | null;
  scale: Scale;
  left: number;
  right: number;
  ids: { hatch: string; fade: string };
}): ReactNode {
  const present = ys.reduce<number>((count, y) => count + (y === null ? 0 : 1), 0);
  const zero = scale.y(0);
  if (style.drawStyle === "bars" && present <= MAX_MARKS) {
    const step = xs.length > 1 ? (right - left) / Math.max(xs.length, 1) : 10;
    const width = Math.max(1, step * style.barWidth);
    const shift = style.barAlignment === -1 ? width : style.barAlignment === 1 ? 0 : width / 2;
    return (
      <g className={`ts__bars ${style.colorClass}`} fillOpacity={style.fillOpacity * style.opacity}>
        {xs.map((x, i) => {
          const y = ys[i];
          if (y === null || y === undefined) return null;
          const y0 = base === null ? zero : scale.y(base[i] ?? 0);
          const top = Math.min(scale.y(y), y0);
          return (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: one bar per point, in time order
              key={i}
              x={scale.x(x) - shift}
              y={top}
              width={width}
              height={Math.abs(y0 - scale.y(y))}
            />
          );
        })}
      </g>
    );
  }
  if (style.drawStyle === "points" && present <= MAX_MARKS) {
    return (
      <g className={`ts__points ${style.colorClass}`} opacity={style.opacity}>
        {xs.map((x, i) => {
          const y = ys[i];
          return y === null || y === undefined ? null : (
            // biome-ignore lint/suspicious/noArrayIndexKey: one point per row, in time order
            <circle key={i} cx={scale.x(x)} cy={scale.y(y)} r={style.pointSize / 2} />
          );
        })}
      </g>
    );
  }
  const d = linePath(xs, ys, scale, right, style.interpolation);
  const area =
    style.fill === "none" || d === ""
      ? null
      : areaPath(xs, ys, base, scale, right, style.interpolation, zero);
  return (
    <>
      {area === null ? null : (
        <path
          className={`ts__area ${style.colorClass}`}
          d={area}
          fill={style.fill === "hatch" ? `url(#${ids.hatch})` : undefined}
          fillOpacity={style.fill === "hatch" ? undefined : style.fillOpacity}
          mask={style.gradient === "none" ? undefined : `url(#${ids.fade})`}
        />
      )}
      {style.lineWidth === 0 ? null : (
        <path
          className={`ts__line ${style.colorClass}`}
          d={d}
          strokeWidth={style.lineWidth}
          strokeOpacity={style.opacity}
          strokeDasharray={style.dash.length === 0 ? undefined : style.dash.join(" ")}
          strokeLinecap={style.lineStyle === "dotted" ? "round" : undefined}
        />
      )}
    </>
  );
}

/** The scale and look of one value axis as the SVG chart draws it. */
interface DrawnAxis {
  plan: AxisPlan;
  scale: ValueScale;
  /** A value's place in px from the top of the box. */
  y: (value: number) => number;
}

/** The text of an axis label, turned along the axis at its outer edge. */
function AxisTitle({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <text
      className="ts__label ts__axis-title"
      x={x}
      y={y}
      textAnchor="middle"
      transform={`rotate(-90 ${x} ${y})`}
    >
      {text}
    </text>
  );
}

/**
 * The time series drawn as SVG paths, reduced to a few points per pixel column. uPlot draws the
 * chart in browsers (`UplotTimeSeriesChart`); this one is shown while uPlot loads and where there
 * is no canvas, such as the tests. It follows the series' styles in a simpler way: a smooth line
 * is drawn straight, and a gradient fill fades by opacity. Each value axis (left, right) has its
 * own scale, linear, logarithmic or log around zero (`axisScale.ts`).
 */
export function SvgTimeSeriesChart({
  series,
  styles,
  timeRange,
  title,
  legend,
  tooltip,
  format,
  axes: givenAxes,
  axisOf: givenAxisOf,
  axisFormat,
  note,
  numberAxis,
}: TimeSeriesChartProps) {
  const { language, timeZone } = useI18n();
  const { axes, axisOf } = chartAxes({ series, styles, axes: givenAxes, axisOf: givenAxisOf });
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const id = useId();
  const ids = { hatch: `${id}-hatch`, fade: `${id}-fade` };

  const left = axes.find((a) => a.side === "left" && a.show);
  const right = axes.find((a) => a.side === "right" && a.show);
  const room = (axis: AxisPlan | undefined, fallback: number) =>
    axis === undefined
      ? fallback
      : (axis.width ?? AXIS_SIZE) + (axis.label === undefined ? 0 : TITLE_ROOM);
  const plotLeft = room(left, PAD_LEFT);
  const plotWidth = Math.max(width - plotLeft - room(right, PAD_RIGHT), 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD_TOP, 10);
  const { x: xs, stacked } = chartData(series, styles);
  // Values a log axis cannot draw (≤ 0) are left out of their series, as gaps.
  const drawnYs = stacked.ys.map((ys, index) => {
    const plan = axes.find((a) => a.key === axisOf[index]);
    const kind = plan?.spec.scale ?? "linear";
    return kind === "log" ? ys.map((v) => (v === null || !drawable(kind, v) ? null : v)) : ys;
  });
  const tickCount = Math.max(2, Math.floor(plotHeight / PX_PER_VALUE_TICK));
  const drawnAxes: DrawnAxis[] = axes.map((plan) => {
    const values = plan.series.flatMap((index) => drawnYs[index] ?? []);
    const scale = valueScale(drawableExtent(plan.spec.scale, values), plan.spec, tickCount);
    return {
      plan,
      scale,
      // Zero on a log axis (the foot of a bar or a fill) is the bottom of the plot.
      y: (value: number) => {
        const at = scale.fraction(value);
        return PAD_TOP + plotHeight - (Number.isFinite(at) ? at : 0) * plotHeight;
      },
    };
  });
  const main = drawnAxes[0];
  const yOf = (index: number) =>
    (drawnAxes.find((a) => a.plan.key === axisOf[index]) ?? main)?.y ?? (() => PAD_TOP);
  const { from, to } = timeRange;
  const xOf = (time: number) => plotLeft + ((time - from) / (to - from || 1)) * plotWidth;
  const mainScale: Scale = { x: xOf, y: main?.y ?? (() => PAD_TOP) };
  const xTickCount = Math.max(2, Math.floor(plotWidth / PX_PER_TIME_TICK));
  // A number axis (the Trend panel) has round numbers as ticks, a time axis round times.
  const { ticks: xTicks, step } =
    numberAxis === undefined
      ? timeTicks(from, to, xTickCount, timeZone)
      : { ticks: niceTicks(from, to, xTickCount).filter((x) => x >= from && x <= to), step: 0 };
  const timeLabel = new Intl.DateTimeFormat(
    language,
    step >= DAY
      ? { day: "2-digit", month: "2-digit", ...zoneOption(timeZone) }
      : { hour: "2-digit", minute: "2-digit", ...zoneOption(timeZone) },
  );
  const xTickLabel = numberAxis?.format ?? ((x: number) => timeLabel.format(x));
  const hatched = styles.find((s) => s.fill === "hatch");
  // The same token the canvas chart reads, so both hatch alike.
  const hatchSpacing = hatched === undefined ? 0 : tokenNumber("--chart-hatch-spacing", 6);
  const mainMin = main?.scale.min ?? 0;
  const mainMax = main?.scale.max ?? 1;

  return (
    <ChartShell
      series={series}
      styles={styles}
      title={title}
      legend={legend}
      tooltip={tooltip}
      format={format}
      note={note}
      boxRef={boxRef}
      plot={{ left: plotLeft, width: plotWidth, top: PAD_TOP, height: plotHeight }}
      timeAt={(x) => from + ((x - plotLeft) / plotWidth) * (to - from)}
      valueAt={(y) => {
        if (main === undefined) return Number.NaN;
        const { scale: kind, base } = main.plan.spec;
        const low = forward(kind, base, mainMin);
        const high = forward(kind, base, mainMax);
        return backward(kind, base, low + ((PAD_TOP + plotHeight - y) / plotHeight) * (high - low));
      }}
      xFormat={numberAxis?.format}
    >
      {(cursorX) => (
        <svg className="ts__svg" width={width} height={height} aria-hidden="true">
          <defs>
            {hatched === undefined ? null : (
              <ColorGroup freeColor={hatched.freeColor}>
                <pattern
                  id={ids.hatch}
                  className={hatched.colorClass}
                  width={hatchSpacing}
                  height={hatchSpacing}
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <line className="ts__hatch" x1={0} y1={0} x2={0} y2={hatchSpacing} />
                </pattern>
              </ColorGroup>
            )}
            <linearGradient id={`${ids.fade}-ramp`} x1={0} y1={0} x2={0} y2={1}>
              <stop className="ts__fade-from" offset={0} />
              <stop className="ts__fade-to" offset={1} />
            </linearGradient>
            <mask id={ids.fade}>
              <rect
                x={plotLeft}
                y={PAD_TOP}
                width={plotWidth}
                height={plotHeight}
                fill={`url(#${ids.fade}-ramp)`}
              />
            </mask>
          </defs>
          {drawnAxes.map(({ plan, scale, y }) => {
            const onLeft = plan.side === "left";
            const edge = onLeft ? plotLeft : plotLeft + plotWidth;
            const colorClass =
              plan.color === "series" ? (styles[plan.series[0] ?? 0]?.colorClass ?? "") : "";
            return (
              <g
                key={plan.key}
                className={`ts__axis ts__axis--${plan.side}${colorClass === "" ? "" : ` ts__axis--series ${colorClass}`}`}
              >
                {scale.ticks.map((tick) => (
                  <g key={`${plan.key}${tick}`}>
                    {plan.grid ? (
                      <line
                        className="ts__grid"
                        x1={plotLeft}
                        x2={plotLeft + plotWidth}
                        y1={y(tick)}
                        y2={y(tick)}
                      />
                    ) : null}
                    {plan.show ? (
                      <text
                        className="ts__label"
                        x={onLeft ? edge - 6 : edge + 6}
                        y={y(tick)}
                        textAnchor={onLeft ? "end" : "start"}
                      >
                        {axisFormat(tick, plan.key, scale.ticks)}
                      </text>
                    ) : null}
                  </g>
                ))}
                {plan.show && plan.line ? (
                  <line
                    className="ts__axis-line"
                    x1={edge}
                    x2={edge}
                    y1={PAD_TOP}
                    y2={PAD_TOP + plotHeight}
                  />
                ) : null}
                {plan.show && plan.label !== undefined ? (
                  <AxisTitle
                    x={onLeft ? TITLE_ROOM / 2 : width - TITLE_ROOM / 2}
                    y={PAD_TOP + plotHeight / 2}
                    text={plan.label}
                  />
                ) : null}
              </g>
            );
          })}
          {xTicks.map((tick) => (
            <text
              key={`x${tick}`}
              className="ts__label"
              x={xOf(tick)}
              y={height - 6}
              textAnchor="middle"
            >
              {xTickLabel(tick)}
            </text>
          ))}
          <ThresholdMarks
            styles={styles}
            scale={mainScale}
            min={mainMin}
            max={mainMax}
            left={plotLeft}
            width={plotWidth}
            layer="bands"
          />
          {styles.map((style, index) => (
            <SeriesMarks
              // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
              key={index}
              look={style}
              xs={xs}
              ys={drawnYs[index] ?? []}
              base={stacked.baselines[index] ?? null}
              scale={{ x: xOf, y: yOf(index) }}
              left={plotLeft}
              right={plotLeft + plotWidth}
              ids={ids}
            />
          ))}
          <ThresholdMarks
            styles={styles}
            scale={mainScale}
            min={mainMin}
            max={mainMax}
            left={plotLeft}
            width={plotWidth}
            layer="lines"
          />
          {cursorX === null ? null : (
            <line
              className="ts__cursor"
              x1={cursorX}
              x2={cursorX}
              y1={PAD_TOP}
              y2={PAD_TOP + plotHeight}
            />
          )}
        </svg>
      )}
    </ChartShell>
  );
}
