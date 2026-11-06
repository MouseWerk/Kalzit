import { useI18n } from "../../i18n/i18n";
import type { RampName } from "./colors";
import type { PropertyPaint } from "./paint";
import type { NodeShape } from "./shapes";
import "./graph.css";
import "../../features/dashboards/ui/shared.css";

/**
 * The legend under a graph (its footer on the board): each label with its shape, color and count, a click hides its nodes
 * or shows them again (the button says which with `aria-pressed`). Colors by a number property
 * show the ramp's range and the nodes without a value. The swatch has the label's node shape and
 * carries its palette color (neutral when nodes are colored by something else); it is the data's
 * color, never a state. Drawn in `currentColor`, it keeps its shape with forced colors, where
 * every node has the same color and the shape is what tells labels apart.
 */
export function Legend({
  labels,
  hidden,
  onToggle,
  swatches,
  property,
  ramp,
  propertyName,
  sizeNote = null,
}: {
  labels: readonly { label: string; group: number; shape: NodeShape; count: number }[];
  hidden: ReadonlySet<string>;
  onToggle: (label: string) => void;
  /** Whether labels carry their colors (colors by label). */
  swatches: boolean;
  property: PropertyPaint | null;
  ramp: RampName;
  propertyName: string;
  /** What the node sizes stand for ("Size by number of edges"), or null when all are equal. */
  sizeNote?: string | null;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  return (
    <div className="graph-legend">
      <ul className="graph-legend__list" aria-label={t("graph.legend.title")}>
        {labels.map(({ label, group, shape, count }) => {
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
                <ShapeSwatch shape={shape} tone={swatches && group >= 0 ? (group % 8) + 1 : null} />
                <span>{name}</span>
                <span className="graph-legend__count">{number.format(count)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {sizeNote === null ? null : <p className="graph-legend__note">{sizeNote}</p>}
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

/**
 * A node's shape at legend size, in the label's palette color (`tone`, 1 to 8) or the muted text
 * color. The shape's name is not read out: the button already names the label.
 */
export function ShapeSwatch({ shape, tone }: { shape: NodeShape; tone: number | null }) {
  return (
    <svg
      className={`graph-legend__swatch graph-legend__swatch--${tone ?? "neutral"}`}
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
      data-shape={shape}
    >
      {shape === "square" ? (
        <rect x="1.1" y="1.1" width="7.8" height="7.8" />
      ) : shape === "diamond" ? (
        <path d="M5 0 10 5 5 10 0 5Z" />
      ) : (
        <circle cx="5" cy="5" r="4.4" />
      )}
    </svg>
  );
}
