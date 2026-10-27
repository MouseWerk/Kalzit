import { useI18n } from "../../i18n/i18n";
import type { RampName } from "./colors";
import type { PropertyPaint } from "./paint";
import "./graph.css";
import "../../features/dashboards/ui/shared.css";

/**
 * The legend under a graph: each label with its color and count, a click hides its nodes or
 * shows them again (the button says which with `aria-pressed`). Colors by a number property show
 * the ramp's range and the nodes without a value. The swatch carries the label's palette color;
 * it is the data's color, never a state.
 */
export function Legend({
  labels,
  hidden,
  onToggle,
  swatches,
  property,
  ramp,
  propertyName,
}: {
  labels: readonly { label: string; group: number; count: number }[];
  hidden: ReadonlySet<string>;
  onToggle: (label: string) => void;
  /** Whether labels carry their colors (colors by label). */
  swatches: boolean;
  property: PropertyPaint | null;
  ramp: RampName;
  propertyName: string;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  return (
    <div className="graph-legend">
      <ul className="graph-legend__list" aria-label={t("graph.legend.title")}>
        {labels.map(({ label, group, count }) => {
          const name = label === "" ? t("graph.cluster.unlabelled") : label;
          const shown = !hidden.has(label);
          return (
            <li key={label}>
              <button
                type="button"
                className="graph-legend__item"
                aria-pressed={shown}
                title={shown ? t("graph.legend.hide", { name }) : t("graph.legend.show", { name })}
                onClick={() => onToggle(label)}
              >
                {swatches ? (
                  <span
                    className={`graph-legend__swatch graph-legend__swatch--${group < 0 ? "neutral" : (group % 8) + 1}`}
                    aria-hidden="true"
                  />
                ) : null}
                <span>{name}</span>
                <span className="graph-legend__count">{number.format(count)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {property === null ? null : (
        <p className="graph-legend__range">
          {property.values.length > 0 ? (
            <span>
              {t("graph.legend.values", { name: propertyName, count: property.values.length })}
            </span>
          ) : property.min === null || property.max === null ? null : (
            <>
              <span>{propertyName}</span>{" "}
              <span
                className={`graph-legend__ramp graph-legend__ramp--${ramp}`}
                aria-hidden="true"
              />{" "}
              <span>
                {t("graph.legend.range", {
                  min: number.format(property.min),
                  max: number.format(property.max),
                })}
              </span>
            </>
          )}
          {property.missing > 0 ? (
            <span className="graph-legend__count">
              {" "}
              {t("graph.legend.missing", { count: number.format(property.missing) })}
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}
