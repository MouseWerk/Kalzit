import { type PointerEvent, useRef, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import {
  nearestIndex,
  niceTicks,
  type Scale,
  type Series,
  seriesPath,
  timeTicks,
  valueExtent,
} from "./series";

export interface TimeSeriesChartProps {
  series: readonly Series[];
  timeRange: { from: number; to: number };
  title: string;
  unit: string;
  lineWidth: number;
  showLegend: boolean;
}

/** Series colors cycle through this many palette entries (`--series-1` and so on). */
export const SERIES_COLORS = 8;

const AXIS_LEFT = 56;
const AXIS_BOTTOM = 22;
const PAD_TOP = 8;
const PAD_RIGHT = 12;
/** Roughly one value label per 40 px and one time label per 110 px, so labels never collide. */
const PX_PER_VALUE_TICK = 40;
const PX_PER_TIME_TICK = 110;

const DAY = 24 * 60 * 60 * 1000;

/**
 * The time series chart drawn as SVG paths. It is the renderer until uPlot is available
 * (`renderer.ts` picks it); the decimated paths keep 100,000 points per series responsive.
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
  const [hoverX, setHoverX] = useState<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

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

  const hoverTime =
    hoverX === null ? null : from + ((hoverX - AXIS_LEFT) / plotWidth) * (to - from);
  const readout =
    hoverTime === null
      ? []
      : series.map((s, index) => {
          const i = nearestIndex(s.times, hoverTime);
          return { index, name: s.name, value: i === -1 ? Number.NaN : (s.values[i] as number) };
        });
  useStyleVars(tooltipRef, { "--hover-x": `${hoverX ?? 0}px` });

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    setHoverX(x >= AXIS_LEFT && x <= AXIS_LEFT + plotWidth ? x : null);
  }

  return (
    <div className="ts">
      <div className="ts__plot" ref={boxRef}>
        <svg
          className="ts__svg"
          width={width}
          height={height}
          role="img"
          aria-label={title}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverX(null)}
        >
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
              // Series keep their order between renders; the name alone can repeat.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={index}
              className={`ts__line series-${(index % SERIES_COLORS) + 1}`}
              d={d}
              strokeWidth={lineWidth}
            />
          ))}
          {hoverX === null ? null : (
            <line
              className="ts__cursor"
              x1={hoverX}
              x2={hoverX}
              y1={PAD_TOP}
              y2={PAD_TOP + plotHeight}
            />
          )}
        </svg>
        {hoverTime === null ? null : (
          <div className="ts__tooltip" ref={tooltipRef} aria-hidden="true">
            <div className="ts__tooltip-time">{new Date(hoverTime).toLocaleString(language)}</div>
            {readout.map((row) => (
              <div key={row.index} className="ts__tooltip-row">
                <span className={`ts__swatch series-${(row.index % SERIES_COLORS) + 1}`} />
                <span className="truncate">{row.name}</span>
                <span className="ts__tooltip-value">
                  {Number.isNaN(row.value)
                    ? ""
                    : `${valueLabel.format(row.value)}${unit === "" ? "" : ` ${unit}`}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      {showLegend && series.length > 0 ? (
        <ul className="ts__legend">
          {series.map((s, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: same order as the paths above
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
