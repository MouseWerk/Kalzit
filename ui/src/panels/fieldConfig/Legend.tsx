import { type ReactNode, useRef } from "react";
import { useI18n } from "../../i18n/i18n";
import { useStyleVars } from "../styleVars";
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
  return (
    // The outer box is the size container: a container query cannot style the container itself.
    <div className="viz-layout-box">
      <div className={`viz-layout viz-layout--${placement}`}>
        <div className="viz-layout__main">{children}</div>
        {legend}
      </div>
    </div>
  );
}
