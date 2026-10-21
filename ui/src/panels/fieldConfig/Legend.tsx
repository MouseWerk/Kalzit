import type { ReactNode } from "react";
import { useI18n } from "../../i18n/i18n";
import type { LegendOptions, LegendValue } from "./legend";
import "../panels.css";
import "../viz.css";

export interface LegendItem {
  name: string;
  /** A palette or tone class (`series-3`, `tone--warn`) for the swatch. */
  colorClass: string;
  /** Formatted values per legend value; missing ones show empty. */
  values?: Partial<Record<LegendValue, string>>;
}

const VALUE_KEYS = {
  last: "panels.legend.value.last",
  min: "panels.legend.value.min",
  max: "panels.legend.value.max",
  mean: "panels.legend.value.mean",
} as const;

/** The legend as a wrapping list or a table with a column per value. */
export function Legend({ items, options }: { items: readonly LegendItem[]; options: LegendOptions }) {
  const { t } = useI18n();
  if (options.mode === "hidden" || items.length === 0) {
    return null;
  }
  if (options.mode === "table") {
    return (
      <div className="viz-legend viz-legend--table">
        <table className="viz-legend__table">
          <thead>
            <tr>
              <th scope="col">{t("panels.legend.name")}</th>
              {options.values.map((value) => (
                <th key={value} scope="col" className="viz-legend__number">
                  {t(VALUE_KEYS[value])}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: series keep their order; names can repeat
              <tr key={index}>
                <th scope="row" className="viz-legend__name">
                  <span className={`ts__swatch ${item.colorClass}`} />
                  <span className="truncate" title={item.name}>
                    {item.name}
                  </span>
                </th>
                {options.values.map((value) => (
                  <td key={value} className="viz-legend__number">
                    {item.values?.[value] ?? ""}
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
          <span className={`ts__swatch ${item.colorClass}`} />
          <span className="truncate" title={item.name}>
            {item.name}
          </span>
          {options.values.map((value) => (
            <span key={value} className="viz-legend__value">
              {t(VALUE_KEYS[value])} {item.values?.[value] ?? ""}
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
    <div className={`viz-layout viz-layout--${placement}`}>
      <div className="viz-layout__main">{children}</div>
      {legend}
    </div>
  );
}
