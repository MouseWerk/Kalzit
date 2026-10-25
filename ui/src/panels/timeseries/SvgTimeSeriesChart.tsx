import { type ReactNode, useId, useRef } from "react";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import type { ThresholdStep } from "../fieldConfig/fieldConfig";
import { toneClass } from "../fieldConfig/fieldConfig";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import { chartData } from "./align";
import { ChartShell, type TimeSeriesChartProps } from "./ChartShell";
import { PX_PER_TIME_TICK, TIME_LABEL_OVERHANG } from "./layout";
import { linePath, niceTicks, type Scale, timeTicks, valueExtent } from "./series";
import { FREE_CLASS, type SeriesStyle } from "./styles";
import { shownThresholds, thresholdBands, thresholdLines } from "./thresholdBands";
import "../panels.css";

const AXIS_LEFT = 56;
const AXIS_BOTTOM = 22;
const PAD_TOP = 8;
const PAD_RIGHT = TIME_LABEL_OVERHANG;
/** Roughly one value label per 40 px and one time label per 110 px, so labels never collide. */
const PX_PER_VALUE_TICK = 40;
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
  right,
  ids,
}: {
  look: SeriesStyle;
  xs: readonly number[];
  ys: readonly (number | null)[];
  base: Float64Array | null;
  scale: Scale;
  right: number;
  ids: { hatch: string; fade: string };
}): ReactNode {
  const present = ys.reduce<number>((count, y) => count + (y === null ? 0 : 1), 0);
  const zero = scale.y(0);
  if (style.drawStyle === "bars" && present <= MAX_MARKS) {
    const step = xs.length > 1 ? (right - AXIS_LEFT) / Math.max(xs.length, 1) : 10;
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

/**
 * The time series drawn as SVG paths, reduced to a few points per pixel column. uPlot draws the
 * chart in browsers (`UplotTimeSeriesChart`); this one is shown while uPlot loads and where there
 * is no canvas, such as the tests. It follows the series' styles in a simpler way: a smooth line
 * is drawn straight, and a gradient fill fades by opacity.
 */
export function SvgTimeSeriesChart({
  series,
  styles,
  timeRange,
  title,
  legend,
  tooltip,
  format,
  axisFormat,
  yRange,
}: TimeSeriesChartProps) {
  const { language, timeZone } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const id = useId();
  const ids = { hatch: `${id}-hatch`, fade: `${id}-fade` };

  const plotWidth = Math.max(width - AXIS_LEFT - PAD_RIGHT, 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD_TOP, 10);
  const { x: xs, stacked } = chartData(series, styles);
  const drawn = stacked.ys.map((values) => ({ values }));
  const data = valueExtent(drawn) ?? { min: 0, max: 1 };
  const extent = { min: yRange?.min ?? data.min, max: yRange?.max ?? data.max };
  const padding = extent.max === extent.min ? Math.abs(extent.max) * 0.1 || 1 : 0;
  const yTicks = niceTicks(
    extent.min - padding,
    extent.max + padding,
    Math.max(2, Math.floor(plotHeight / PX_PER_VALUE_TICK)),
  );
  // Fixed ends from the field options are kept exactly; open ends round out to a tick.
  const yMin = yRange?.min ?? Math.min(yTicks[0] ?? extent.min, extent.min - padding);
  const yMax = yRange?.max ?? Math.max(yTicks.at(-1) ?? extent.max, extent.max + padding);
  const { from, to } = timeRange;
  const scale: Scale = {
    x: (time) => AXIS_LEFT + ((time - from) / (to - from || 1)) * plotWidth,
    y: (value) => PAD_TOP + plotHeight - ((value - yMin) / (yMax - yMin || 1)) * plotHeight,
  };
  const { ticks: xTicks, step } = timeTicks(
    from,
    to,
    Math.max(2, Math.floor(plotWidth / PX_PER_TIME_TICK)),
    timeZone,
  );
  const timeLabel = new Intl.DateTimeFormat(
    language,
    step >= DAY
      ? { day: "2-digit", month: "2-digit", ...zoneOption(timeZone) }
      : { hour: "2-digit", minute: "2-digit", ...zoneOption(timeZone) },
  );
  const hatched = styles.find((s) => s.fill === "hatch");
  // The same token the canvas chart reads, so both hatch alike.
  const hatchSpacing = hatched === undefined ? 0 : tokenNumber("--chart-hatch-spacing", 6);

  return (
    <ChartShell
      series={series}
      styles={styles}
      title={title}
      legend={legend}
      tooltip={tooltip}
      format={format}
      boxRef={boxRef}
      plot={{ left: AXIS_LEFT, width: plotWidth }}
      timeAt={(x) => from + ((x - AXIS_LEFT) / plotWidth) * (to - from)}
      valueAt={(y) => yMin + ((PAD_TOP + plotHeight - y) / plotHeight) * (yMax - yMin)}
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
                x={AXIS_LEFT}
                y={PAD_TOP}
                width={plotWidth}
                height={plotHeight}
                fill={`url(#${ids.fade}-ramp)`}
              />
            </mask>
          </defs>
          {yTicks
            .filter((tick) => tick >= yMin && tick <= yMax)
            .map((tick) => (
              <g key={`y${tick}`}>
                <line
                  className="ts__grid"
                  x1={AXIS_LEFT}
                  x2={AXIS_LEFT + plotWidth}
                  y1={scale.y(tick)}
                  y2={scale.y(tick)}
                />
                <text className="ts__label" x={AXIS_LEFT - 6} y={scale.y(tick)} textAnchor="end">
                  {axisFormat(tick)}
                </text>
              </g>
            ))}
          {xTicks.map((tick) => (
            <text
              key={`x${tick}`}
              className="ts__label"
              x={scale.x(tick)}
              y={height - 6}
              textAnchor="middle"
            >
              {timeLabel.format(tick)}
            </text>
          ))}
          <ThresholdMarks
            styles={styles}
            scale={scale}
            min={yMin}
            max={yMax}
            left={AXIS_LEFT}
            width={plotWidth}
            layer="bands"
          />
          {styles.map((style, index) => (
            <SeriesMarks
              // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
              key={index}
              look={style}
              xs={xs}
              ys={stacked.ys[index] ?? []}
              base={stacked.baselines[index] ?? null}
              scale={scale}
              right={AXIS_LEFT + plotWidth}
              ids={ids}
            />
          ))}
          <ThresholdMarks
            styles={styles}
            scale={scale}
            min={yMin}
            max={yMax}
            left={AXIS_LEFT}
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
