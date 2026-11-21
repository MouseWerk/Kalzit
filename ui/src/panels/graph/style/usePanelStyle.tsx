import { type ReactNode, useMemo, useState } from "react";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { usePanelHost } from "../../host";
import { propertyText } from "../adapter";
import type { GraphModel } from "../model";
import type { GraphPanelOptions } from "../options";
import type { GraphView } from "../view";
import { edgeItems, nodeItems, ruleNodes, valueNodes } from "./apply";
import { StyleLegend } from "./StyleLegend";
import { StyleSheet } from "./StyleSheet";
import { type GraphStyle, ruleCount } from "./schema";
import { useGraphStyle, vocabularyOf } from "./useGraphStyle";

/**
 * Everything a graph panel shows of its style rules, in one place so the panel itself changes
 * little: the looks the drawing takes, the sheet "Stil" with its button, and the legend of the
 * rules. A viewer's change in the sheet lasts for this view; in the panel editor's preview it
 * changes the panel's options.
 */
export function usePanelStyle({
  options,
  model,
  view,
  onSelect,
}: {
  options: GraphPanelOptions;
  model: GraphModel;
  view: GraphView;
  /** Selects view nodes (a legend entry's hits). */
  onSelect: (nodes: number[]) => void;
}) {
  const { t } = useI18n();
  const host = usePanelHost();
  const [own, setOwn] = useState<GraphStyle | null>(null);
  const [open, setOpen] = useState(false);
  const style = own ?? options.style;
  const { evaluation, styled } = useGraphStyle(model, view, style);
  const items = useMemo(() => ({ nodes: nodeItems(model), edges: edgeItems(model) }), [model]);
  const vocabulary = useMemo(() => vocabularyOf(model), [model]);
  const saves = host.editOptions !== undefined;

  const change = (next: GraphStyle) => {
    if (host.editOptions !== undefined) {
      host.editOptions({ ...options, style: next } as unknown as Record<string, unknown>);
      setOwn(null);
    } else {
      setOwn(next);
    }
  };

  const sheet: ReactNode = open ? (
    <StyleSheet
      saves={saves}
      changed={own !== null}
      onReset={() => setOwn(null)}
      onClose={() => setOpen(false)}
      style={style}
      onChange={change}
      items={items}
      vocabulary={vocabulary}
      basis={basisText(t, options)}
    />
  ) : null;

  const legend: ReactNode =
    evaluation === null ? null : (
      <StyleLegend
        style={style}
        evaluation={evaluation}
        onSelectRule={(rule) => onSelect(ruleNodes(view, evaluation, rule))}
        onSelectValue={(rule, value) => {
          const report = evaluation.nodes.rules[rule]?.values;
          const when = style.nodes[rule]?.when;
          if (report === null || report === undefined || when?.kind !== "values") return;
          const shown = new Set(report.shown.map((slot) => slot.value));
          onSelect(
            valueNodes(view, model, evaluation, rule, when.property, value, shown, propertyText),
          );
        }}
      />
    );

  return {
    style,
    styled,
    evaluation,
    /** The header button's state: rules in the panel, and whether the sheet is open. */
    button: { count: ruleCount(style), open, toggle: () => setOpen((o) => !o) },
    sheet,
    legend,
  };
}

/** The basis in words, for the editor's first lines (Graph081 board, frame 8). */
export function basisText(
  t: Translate,
  options: Pick<GraphPanelOptions, "colorBy" | "colorProperty" | "sizeBy">,
): { color: string; size: string; shape: string } {
  const color =
    options.colorBy === "property"
      ? t("graphStyle.basis.byProperty", { name: options.colorProperty })
      : t(`graph.options.colorBy.${options.colorBy}`);
  const size =
    options.sizeBy === ""
      ? t("graphStyle.basis.sameSize")
      : options.sizeBy === "degree"
        ? t("graphStyle.basis.byDegree")
        : t("graphStyle.basis.byProperty", { name: options.sizeBy });
  return { color, size, shape: t("graphStyle.basis.perLabel") };
}
