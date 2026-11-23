import { type ReactNode, useRef } from "react";
import { useI18n } from "../../i18n/i18n";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import type { LegendOptions, LegendValue } from "./legendOptions";
import "../panels.css";
import "../viz.css";

export interface LegendItem {
  name: string;
  /** A palette or tone class (`series-3`, `tone--warn`) for the swatch. */
  colorClass: string;
  /** A free colour (`#rrggbb`) the `series-free` class reads; null or absent for the others. */
  freeColor?: string | null | undefined;
  /** Formatted values per column key; missing ones show empty. */
  values?: Partial<Record<string, string>>;
}

/**
 * A series' colour swatch: its class, and a free colour set as `--free-color` through the CSSOM
 * (the content security policy allows no style attribute).
 */
export function Swatch({
  className,
  freeColor,
}: {
  className: string;
  freeColor?: string | null | undefined;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useStyleVars(
    ref,
    freeColor === null || freeColor === undefined ? {} : { "--free-color": freeColor },
  );
  return <span ref={ref} className={`ts__swatch ${className}`} />;
}

const VALUE_KEYS = {
  last: "panels.legend.value.last",
  min: "panels.legend.value.min",
  max: "panels.legend.value.max",
  mean: "panels.legend.value.mean",
} as const;

/**
 * The legend as a wrapping list or a table with a column per value. The columns are the legend
 * values of the options unless the panel names its own (a pie shows value and percent).
 */
export function Legend({
  items,
  options,
  columns,
}: {
  items: readonly LegendItem[];
  options: LegendOptions;
  columns?: readonly { key: string; label: string }[];
}) {
  const { t } = useI18n();
  if (options.mode === "hidden" || items.length === 0) {
    return null;
  }
  const shown =
    columns ??
    options.values.map((value: LegendValue) => ({ key: value, label: t(VALUE_KEYS[value]) }));
  if (options.mode === "table") {
    return (
      <div className="viz-legend viz-legend--table">
        <table className="viz-legend__table">
          <thead>
            <tr>
              <th scope="col">{t("panels.legend.name")}</th>
              {shown.map((column) => (
                <th key={column.key} scope="col" className="viz-legend__number">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
              <tr key={index}>
                <th scope="row" className="viz-legend__name">
                  <Swatch className={item.colorClass} freeColor={item.freeColor} />
                  <span className="truncate" title={item.name}>
                    {item.name}
                  </span>
                </th>
                {shown.map((column) => (
                  <td key={column.key} className="viz-legend__number">
                    {item.values?.[column.key] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <ul className="viz-legend viz-legend--list">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
        <li key={index} className="ts__legend-item">
          <Swatch className={item.colorClass} freeColor={item.freeColor} />
          <span className="truncate" title={item.name}>
            {item.name}
          </span>
          {shown.map((column) => (
            <span key={column.key} className="viz-legend__value">
              {column.label} {item.values?.[column.key] ?? ""}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

/** A legend on the right needs this many rem; below it goes under the drawing (as in viz.css). */
const RIGHT_FROM_REM = 30;
/** Below this many rem the legend shows names only; the tooltip still has the values. */
const NAMES_ONLY_BELOW_REM = 20;
/** The drawing keeps at least this height in px when the legend stands below it. */
export const MIN_PLOT_HEIGHT = 80;
/** A legend with less room than this (px) is left out instead of showing a sliver of it. */
const MIN_LEGEND_HEIGHT = 24;
/** The gap between drawing and legend below it (--space-1), in px. */
const STACK_GAP = 4;

export interface LegendFit {
  /** The legend stands below the drawing. */
  stacked: boolean;
  /** Px the legend may take below the drawing; null beside it. */
  room: number | null;
  /** No room for even one line of legend. */
  hidden: boolean;
  /** Names only, no value columns. */
  namesOnly: boolean;
}

/**
 * How a legend fits a panel of the given size: the drawing keeps a least height and gives the
 * rest to the legend below it, a legend without room for a line is left out, and a narrow panel
 * shows names only. A chart in a small panel so stays a chart instead of a cut-off legend.
 */
export function legendFit(
  width: number,
  height: number,
  placement: LegendOptions["placement"],
  rem = 16,
): LegendFit {
  // A short, wide panel keeps a legend on the right even below RIGHT_FROM_REM: the drawing
  // there is as wide as it is high anyway, and below it the legend would get a line or two.
  const stacked = placement === "bottom" || (width < RIGHT_FROM_REM * rem && width < height * 2);
  const namesOnly = width < NAMES_ONLY_BELOW_REM * rem;
  if (!stacked) {
    return { stacked, room: null, hidden: false, namesOnly };
  }
  const room = Math.max(Math.floor(height - MIN_PLOT_HEIGHT - STACK_GAP), 0);
  return { stacked, room, hidden: room < MIN_LEGEND_HEIGHT, namesOnly };
}

/** The root font size in px, for sizes given in rem. */
function rootRem(): number {
  if (typeof document === "undefined") {
    return 16;
  }
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

/** A drawing with its legend below or to the right (below on narrow panels anyway). */
export function WithLegend({
  legend,
  placement,
  children,
}: {
  legend: ReactNode;
  placement: LegendOptions["placement"];
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(boxRef);
  const fit = legendFit(width, height, placement, rootRem());
  useStyleVars(boxRef, fit.room === null ? {} : { "--legend-room": `${fit.room}px` });
  const classes = [
    "viz-layout",
    `viz-layout--${placement}`,
    fit.stacked ? "viz-layout--stacked" : "",
    placement === "right" && !fit.stacked ? "viz-layout--beside" : "",
    fit.namesOnly ? "viz-layout--names-only" : "",
  ]
    .filter((name) => name !== "")
    .join(" ");
  return (
    // The outer box is the size container: a container query cannot style the container itself.
    <div className="viz-layout-box" ref={boxRef}>
      <div className={classes}>
        <div className="viz-layout__main">{children}</div>
        {fit.hidden ? null : legend}
      </div>
    </div>
  );
}
