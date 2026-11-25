import { type ReactNode, useRef, useState } from "react";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { type Calc, percentileOf } from "../calcs";
import { useStyleVars } from "../styleVars";
import { useElementSize } from "../useElementSize";
import type { LegendOptions } from "./legendOptions";
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
  /** The same values as numbers, for sorting the table by a column; NaN where there is none. */
  numbers?: Partial<Record<string, number>>;
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

/** The short name of a calculation, as legend columns and chips show it ("Summe", "p95"). */
export function calcLabel(t: Translate, calc: Calc): string {
  const p = percentileOf(calc);
  return p === null ? t(`panels.calc.${calc}` as MessageKey) : `p${p}`;
}

/** In list mode a series shows this many of its values; the table shows all. */
export const LIST_VALUES = 2;

type SortState = { key: string; descending: boolean } | null;

/**
 * The legend as a wrapping list or a table with a column per value. The columns are the legend
 * values of the options unless the panel names its own (a pie shows value and percent). The
 * table sorts by a column on a click on its heading. With a limit, the first series are named
 * and the rest are behind "show all"; the drawing still shows every series.
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
  const [sort, setSort] = useState<SortState>(null);
  const [all, setAll] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const fixedWidth = options.placement === "right" ? options.width : undefined;
  useStyleVars(ref, fixedWidth === undefined ? {} : { "--legend-width": `${fixedWidth}px` });
  if (options.mode === "hidden" || items.length === 0) {
    return null;
  }
  const chosen =
    columns ?? options.values.map((value) => ({ key: value, label: calcLabel(t, value) }));
  const shown = options.mode === "list" ? chosen.slice(0, LIST_VALUES) : chosen;
  const order = items.map((item, index) => ({ item, index }));
  if (options.mode === "table" && sort !== null) {
    const value = (entry: (typeof order)[number]) => entry.item.numbers?.[sort.key] ?? Number.NaN;
    order.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      // Series without a value stay at the end either way.
      if (Number.isNaN(x) || Number.isNaN(y))
        return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
      return sort.descending ? y - x : x - y;
    });
  }
  const limited = options.limit !== undefined && !all && order.length > options.limit;
  const visible = limited ? order.slice(0, options.limit) : order;
  const more = limited ? (
    <>
      <span>{t("panels.legend.someOf", { shown: visible.length, total: order.length })}</span>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={() => setAll(true)}
      >
        {t("panels.legend.showAll")}
      </button>
    </>
  ) : null;
  const className = `viz-legend viz-legend--${options.mode}${fixedWidth === undefined ? "" : " viz-legend--fixed"}`;
  if (options.mode === "table") {
    const sortBy = (key: string) =>
      setSort((current) =>
        current?.key === key
          ? current.descending
            ? { key, descending: false }
            : null
          : { key, descending: true },
      );
    return (
      <div
        className={className}
        ref={(element) => {
          ref.current = element;
        }}
      >
        <table className="viz-legend__table">
          <thead>
            <tr>
              <th scope="col">{t("panels.legend.name")}</th>
              {shown.map((column) => {
                const active = sort?.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    className="viz-legend__number"
                    aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
                  >
                    {columns === undefined ? (
                      <button
                        type="button"
                        className="viz-legend__sort"
                        onClick={() => sortBy(column.key)}
                      >
                        {column.label}
                        {active ? (sort.descending ? " ↓" : " ↑") : null}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ item, index }) => (
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
        {more === null ? null : <p className="viz-legend__more">{more}</p>}
      </div>
    );
  }
  return (
    <ul
      className={className}
      ref={(element) => {
        ref.current = element;
      }}
    >
      {visible.map(({ item, index }) => (
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
      {more === null ? null : <li className="viz-legend__more">{more}</li>}
    </ul>
  );
}

/** A legend on the right needs this many rem; below it goes under the drawing (as in viz.css). */
const RIGHT_FROM_REM = 30;
/**
 * A panel both narrower and lower than these (rem) shows names only in its legend; the tooltip
 * still has the values. A narrow but tall panel (most panels on a phone) keeps its values.
 */
const NAMES_ONLY_BELOW_REM = 20;
const NAMES_ONLY_LOWER_THAN_REM = 10;
/** The drawing keeps at least this height in px when the legend stands below it. */
export const MIN_PLOT_HEIGHT = 80;
/** A legend with less room than this (px) is left out instead of showing a sliver of it. */
const MIN_LEGEND_HEIGHT = 24;
/** The gap between drawing and legend below it (--space-1, a quarter rem). */
const STACK_GAP_REM = 0.25;

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
 * rest to the legend below it, a legend without room for a line is left out, and a panel both
 * narrow and low shows names only. A chart in a small panel so stays a chart instead of a cut-off legend.
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
  const namesOnly = width < NAMES_ONLY_BELOW_REM * rem && height < NAMES_ONLY_LOWER_THAN_REM * rem;
  if (!stacked) {
    return { stacked, room: null, hidden: false, namesOnly };
  }
  const room = Math.max(Math.floor(height - MIN_PLOT_HEIGHT - STACK_GAP_REM * rem), 0);
  return { stacked, room, hidden: room < MIN_LEGEND_HEIGHT, namesOnly };
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
  // The root font size comes with the measured size: read while rendering, it would restyle the
  // whole dashboard at once in the render after a dragged panel is dropped.
  const { width, height, rem } = useElementSize(boxRef);
  const fit = legendFit(width, height, placement, rem);
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
