import type { ReactNode } from "react";
import { useI18n } from "../../../i18n/i18n";
import { type GraphEvaluation, SHIFTED_DASH, shiftedShape } from "./apply";
import { colorText, scopeText, thenText, whenText } from "./describe";
import type { RuleReport } from "./evaluate";
import { EdgeSwatch, IconGlyph, NodeSwatch } from "./Swatch";
import type { EdgeRule, GraphStyle, NodeRule, RuleShape } from "./schema";
import "../graph.css";
import "./style.css";

/**
 * The legend of the style rules, under the legend of the basis (Graph081 board, frame 8): an
 * entry per rule that is on, with what it draws and how many it hits; a rule "per unique value"
 * lists its values with their colors and counts. A click on a node entry selects its hits. Every
 * entry names its rule in words, so the legend also reads without colors.
 */
export function StyleLegend({
  rules: style,
  evaluation,
  onSelectRule,
  onSelectValue,
}: {
  rules: GraphStyle;
  evaluation: GraphEvaluation;
  /** Selects the nodes a node rule hits; absent where nothing can be selected. */
  onSelectRule?: ((rule: number) => void) | undefined;
  /** Selects the nodes a value of a rule "per unique value" colors (null: the other values). */
  onSelectValue?: ((rule: number, value: string | null) => void) | undefined;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const entries = [
    ...style.nodes.map((rule, i) => ({
      kind: "nodes" as const,
      rule,
      index: i,
      report: evaluation.nodes.rules[i],
    })),
    ...style.edges.map((rule, i) => ({
      kind: "edges" as const,
      rule,
      index: i,
      report: evaluation.edges.rules[i],
    })),
  ].filter((entry) => entry.rule.on && entry.report?.state === "active");
  if (entries.length === 0) return null;
  return (
    <ul className="graph-style-legend" aria-label={t("graphStyle.legend.title")}>
      {entries.map(({ kind, rule, index, report }) => {
        const key = `${kind}-${rule.id}`;
        const words = `${whenText(t, rule.when)} (${scopeText(t, rule.scope, kind)}): ${thenText(t, rule)}`;
        const values = (report as RuleReport).values;
        if (values !== null && rule.when.kind === "values") {
          const shown = values.shown.filter((slot) => slot.count > 0);
          return (
            <li key={key} className="graph-style-legend__group">
              <span className="graph-style-legend__heading">
                {t("graphStyle.legend.colorBy", { property: rule.when.property })}
              </span>
              <ul className="graph-style-legend__values">
                {shown.map((slot) => (
                  <li key={slot.value}>
                    <LegendEntry
                      swatch={
                        kind === "nodes" ? (
                          <NodeSwatch
                            color={slot.color}
                            shape={slot.shifted ? (shiftedShape("circle") as RuleShape) : "circle"}
                          />
                        ) : (
                          <EdgeSwatch
                            color={slot.color}
                            dash={slot.shifted ? SHIFTED_DASH : "solid"}
                          />
                        )
                      }
                      text={slot.value}
                      title={`${slot.value}: ${colorText(t, slot.color)}`}
                      count={number.format(slot.count)}
                      onClick={
                        kind === "nodes" && onSelectValue !== undefined
                          ? () => onSelectValue(index, slot.value)
                          : undefined
                      }
                      selectLabel={t("graphStyle.legend.selectValue", { value: slot.value })}
                    />
                  </li>
                ))}
                {values.other.values > 0 ? (
                  <li>
                    <LegendEntry
                      swatch={
                        kind === "nodes" ? (
                          <NodeSwatch color="neutral" />
                        ) : (
                          <EdgeSwatch color="neutral" />
                        )
                      }
                      text={t("graphStyle.values.other", {
                        count: number.format(values.other.values),
                      })}
                      title={colorText(t, "neutral")}
                      count={number.format(values.other.count)}
                      onClick={
                        kind === "nodes" && onSelectValue !== undefined
                          ? () => onSelectValue(index, null)
                          : undefined
                      }
                      selectLabel={t("graphStyle.legend.selectOther")}
                    />
                  </li>
                ) : null}
              </ul>
            </li>
          );
        }
        const set = rule.set as NodeRule["set"] & EdgeRule["set"];
        const swatch =
          kind === "nodes" ? (
            <>
              <NodeSwatch color={set.color} shape={set.shape} border={set.border} />
              {set.icon === undefined ? null : <IconGlyph name={set.icon} />}
              {set.badge === undefined ? null : (
                <span className="graph-style__badge">{set.badge}</span>
              )}
            </>
          ) : (
            <EdgeSwatch color={set.color} dash={set.dash} width={set.width} />
          );
        return (
          <li key={key}>
            <LegendEntry
              swatch={swatch}
              text={legendText(rule)}
              title={words}
              count={number.format((report as RuleReport).matched)}
              onClick={
                kind === "nodes" && onSelectRule !== undefined
                  ? () => onSelectRule(index)
                  : undefined
              }
              selectLabel={t("graphStyle.legend.selectRule", { rule: words })}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The short text of an entry: the condition's value, else the label or type it is for. */
function legendText(rule: NodeRule | EdgeRule): string {
  const when = rule.when;
  if (when.kind === "condition") {
    return `${when.property} ${when.value}${when.op === "between" ? ` – ${when.to}` : ""}`.trim();
  }
  return rule.scope;
}

function LegendEntry({
  swatch,
  text,
  title,
  count,
  onClick,
  selectLabel,
}: {
  swatch: ReactNode;
  text: string;
  title: string;
  count: string;
  onClick: (() => void) | undefined;
  selectLabel: string;
}) {
  const inner = (
    <>
      <span className="graph-style-legend__swatch">{swatch}</span>
      <span className="graph-style-legend__text">{text === "" ? title : text}</span>{" "}
      <span className="graph-legend__count">{count}</span>
      <span className="visually-hidden">{` (${title})`}</span>
    </>
  );
  if (onClick === undefined) {
    return (
      <span className="graph-style-legend__item" title={title}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="graph-style-legend__item graph-style-legend__item--button"
      title={selectLabel}
      onClick={onClick}
    >
      {inner}
    </button>
  );
}
