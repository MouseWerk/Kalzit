import { useRef } from "react";
import { useI18n } from "../../i18n/i18n";
import { useElementSize } from "../useElementSize";
import { ChartShell, SERIES_COLORS, type TimeSeriesChartProps } from "./ChartShell";
import { niceTicks, type Scale, seriesPath, timeTicks, valueExtent } from "./series";
import "../panels.css";

const AXIS_LEFT = 56;
const AXIS_BOTTOM = 22;
const PAD_TOP = 8;
const PAD_RIGHT = 12;
/** Roughly one value label per 40 px and one time label per 110 px, so labels never collide. */
const PX_PER_VALUE_TICK = 40;
const PX_PER_TIME_TICK = 110;

const DAY = 24 * 60 * 60 * 1000;

/**
 * The time series drawn as SVG paths, reduced to a few points per pixel column. uPlot draws the
 * chart in browsers (`UplotTimeSeriesChart`); this one is shown while uPlot loads and where there
 * is no canvas, such as the tests.
 */
export function SvgTimeSeriesChart({
  series,
  timeRange,
  title,
  unit,
  lineWidth,
  showLegend,
}: TimeSeriesChartProps) {
  const { language } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);

  const plotWidth = Math.max(width - AXIS_LEFT - PAD_RIGHT, 10);
  const plotHeight = Math.max(height - AXIS_BOTTOM - PAD_TOP, 10);
  const extent = valueExtent(series) ?? { min: 0, max: 1 };
  const padding = extent.max === extent.min ? Math.abs(extent.max) * 0.1 || 1 : 0;
  const yTicks = niceTicks(
    extent.min - padding,
    extent.max + padding,
    Math.max(2, Math.floor(plotHeight / PX_PER_VALUE_TICK)),
  );
  const yMin = Math.min(yTicks[0] ?? extent.min, extent.min - padding);
  const yMax = Math.max(yTicks.at(-1) ?? extent.max, extent.max + padding);
  const { from, to } = timeRange;
  const scale: Scale = {
    x: (time) => AXIS_LEFT + ((time - from) / (to - from || 1)) * plotWidth,
    y: (value) => PAD_TOP + plotHeight - ((value - yMin) / (yMax - yMin || 1)) * plotHeight,
  };
  const { ticks: xTicks, step } = timeTicks(
    from,
    to,
    Math.max(2, Math.floor(plotWidth / PX_PER_TIME_TICK)),
  );
  const timeLabel = new Intl.DateTimeFormat(
    language,
    step >= DAY ? { day: "2-digit", month: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
  );
  const valueLabel = new Intl.NumberFormat(language, { maximumFractionDigits: 3 });
  const paths = series.map((s) => seriesPath(s, scale, AXIS_LEFT + plotWidth));

  return (
    <ChartShell
      series={series}
      title={title}
      unit={unit}
      showLegend={showLegend}
      boxRef={boxRef}
      plot={{ left: AXIS_LEFT, width: plotWidth }}
      timeAt={(x) => from + ((x - AXIS_LEFT) / plotWidth) * (to - from)}
    >
      {(cursorX) => (
        <svg className="ts__svg" width={width} height={height} aria-hidden="true">
          {yTicks.map((tick) => (
            <g key={`y${tick}`}>
              <line
                className="ts__grid"
                x1={AXIS_LEFT}
                x2={AXIS_LEFT + plotWidth}
                y1={scale.y(tick)}
                y2={scale.y(tick)}
              />
              <text className="ts__label" x={AXIS_LEFT - 6} y={scale.y(tick)} textAnchor="end">
                {valueLabel.format(tick)}
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
          {paths.map((d, index) => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
              key={index}
              className={`ts__line series-${(index % SERIES_COLORS) + 1}`}
              d={d}
              strokeWidth={lineWidth}
            />
          ))}
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
