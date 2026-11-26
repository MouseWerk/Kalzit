import { FloatingTooltip } from "../../../components/FloatingTooltip";
import { useI18n } from "../../../i18n/i18n";
import { ANCHOR_GAP_PX, type TooltipAnchor } from "../../../lib/tooltipPlace";
import type { GraphModel } from "../model";
import { countText } from "../plural";
import type { CanvasTarget } from "../SigmaCanvas";
import type { GraphView } from "../view";
import { edgeCard, nodeCard } from "./cardContent";
import "./canvas.css";

/**
 * The info card of a node or an edge (Graph 0.8.1 board, frames 1 and 2): its caption, its labels
 * or type, up to four properties, and a line saying how much more there is. It appears after the
 * pointer rested on the element (or with I for the focused one), beside it and never over it, and
 * takes no pointer itself. Nothing changes color on hovering.
 */
export function InfoCard({
  target,
  model,
  view,
  chosen,
  captionProperty,
}: {
  target: CanvasTarget;
  model: GraphModel;
  view: GraphView;
  /** Properties per label, as the panel's options name them. */
  chosen: Readonly<Record<string, readonly string[]>>;
  captionProperty: string;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const anchor = (): TooltipAnchor => ({
    x: target.x,
    y: target.y,
    gapX: target.reach + ANCHOR_GAP_PX,
    gapY: target.reach + ANCHOR_GAP_PX,
  });
  if (target.kind === "node") {
    const node = view.nodes[target.index];
    if (node === undefined) return null;
    const data = node.node >= 0 ? model.nodes[node.node] : undefined;
    if (data === undefined) {
      return (
        <FloatingTooltip className="graph-card" anchor={anchor}>
          <p className="graph-card__title">{node.caption}</p>
          <p className="graph-card__foot">
            {t("graph.cluster.members", { count: number.format(node.members) })}
          </p>
        </FloatingTooltip>
      );
    }
    const card = nodeCard(data, chosen, captionProperty);
    return (
      <FloatingTooltip className="graph-card" anchor={anchor}>
        {data.labels.length === 0 ? null : (
          <p className="graph-card__kind">{data.labels.join(", ")}</p>
        )}
        <p className="graph-card__title">{data.caption}</p>
        <Properties properties={card.properties} />
        <p className="graph-card__foot">
          {countText(t, language, "edge", data.degree)}
          {" · "}
          {t("graphCanvas.card.properties", {
            shown: number.format(card.properties.length),
            count: number.format(card.total),
          })}
          {" · "}
          {t("graphCanvas.card.click")}
        </p>
      </FloatingTooltip>
    );
  }
  const edge = view.edges[target.index];
  if (edge === undefined) return null;
  const from = view.nodes[edge.source]?.caption ?? "";
  const to = view.nodes[edge.target]?.caption ?? "";
  const data = edge.edge >= 0 ? model.edges[edge.edge] : undefined;
  if (data === undefined) {
    return (
      <FloatingTooltip className="graph-card" anchor={anchor}>
        <p className="graph-card__title">
          {t("graphCanvas.edge.merged", { count: number.format(edge.count), from, to })}
        </p>
      </FloatingTooltip>
    );
  }
  const card = edgeCard(data);
  return (
    <FloatingTooltip className="graph-card" anchor={anchor}>
      <p className="graph-card__kind">{data.type}</p>
      <p className="graph-card__title">{t("graphCanvas.edge.ends", { from, to })}</p>
      <Properties properties={card.properties} />
      <p className="graph-card__foot">
        {t("graphCanvas.card.properties", {
          shown: number.format(card.properties.length),
          count: number.format(card.total),
        })}
        {" · "}
        {t("graphCanvas.card.click")}
      </p>
    </FloatingTooltip>
  );
}

function Properties({ properties }: { properties: readonly { key: string; text: string }[] }) {
  if (properties.length === 0) return null;
  return (
    <dl className="graph-card__properties">
      {properties.map((property) => (
        <div key={property.key}>
          <dt>{property.key}</dt>
          <dd>{property.text}</dd>
        </div>
      ))}
    </dl>
  );
}
