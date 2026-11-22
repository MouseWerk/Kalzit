import { useI18n } from "../../../i18n/i18n";
import { DataLinkList } from "../../DataLinkViews";
import type { OpenLink } from "../../dataLinks";
import { propertyText } from "../adapter";
import { edgeSummary, propertyType } from "../inspect";
import type { GraphModel } from "../model";
import type { GraphView } from "../view";
import "../graph.css";
import "./canvas.css";
import "../../../features/dashboards/ui/shared.css";

/** Parallel edges listed in the sheet before "and N more". */
export const PARALLEL_SHOWN = 5;

/** The other edges between the two ends of a model edge, either way, in the model's order. */
export function parallelEdges(model: GraphModel, edge: number): number[] {
  const data = model.edges[edge];
  if (data === undefined) return [];
  const out: number[] = [];
  model.edges.forEach((other, i) => {
    const same = other.source === data.source && other.target === data.target;
    const back = other.source === data.target && other.target === data.source;
    if (same || back) out.push(i);
  });
  return out;
}

/** The types of the model edges a merged edge stands for, with their counts, most first. */
export function mergedTypes(
  model: GraphModel,
  view: GraphView,
  edge: number,
): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  view.edgeOf.forEach((at, i) => {
    if (at !== edge) return;
    const type = model.edges[i]?.type ?? "";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  });
  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export interface EdgeSheetActions {
  /** Selects one node (an end of the edge). */
  selectNode: (index: number) => void;
  /** Selects both ends of the edge. */
  selectEnds: (edge: number) => void;
  /** Selects another edge between the same nodes (a view index). */
  selectEdge: (edge: number) => void;
  hide: (edge: number) => void;
}

/**
 * The side sheet of a selected edge (Graph 0.8.1 board, frame 2), where the node's sheet stands:
 * its type, its ends, its typed properties and the other edges between the same two nodes. An
 * edge between groups stands for many: the sheet names how many, with their types and counts.
 */
export function EdgeSheet({
  model,
  view,
  edge,
  links = [],
  actions,
}: {
  model: GraphModel;
  view: GraphView;
  /** The selected edge (a view index). */
  edge: number;
  links?: readonly OpenLink[];
  actions: EdgeSheetActions;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const drawn = view.edges[edge];
  if (drawn === undefined) return null;
  const from = view.nodes[drawn.source];
  const to = view.nodes[drawn.target];
  const data = drawn.edge >= 0 ? model.edges[drawn.edge] : undefined;
  const ends = t("graphCanvas.edge.ends", { from: from?.caption ?? "", to: to?.caption ?? "" });
  const parallel = data === undefined ? [] : parallelEdges(model, drawn.edge);
  const position = parallel.indexOf(drawn.edge);
  return (
    <section
      className="graph__details"
      aria-label={t("graphCanvas.edge.details", { type: data?.type ?? "", ends })}
    >
      <section className="graph-sheet__section">
        <p className="graph-sheet__kicker">{t("graphCanvas.edge.kicker")}</p>
        <h3 className="graph__details-title">
          {data === undefined
            ? t("graphCanvas.edge.merged", {
                count: number.format(drawn.count),
                from: from?.caption ?? "",
                to: to?.caption ?? "",
              })
            : data.type}
        </h3>
        {data === undefined ? (
          <ul className="graph-sheet__list">
            {mergedTypes(model, view, edge).map(({ type, count }) => (
              <li key={type} className="graph-sheet__item">
                <span className="graph-sheet__type-name">{type}</span>
                <span className="graph-sheet__muted">{number.format(count)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="graph__note">{ends}</p>
            <p className="graph-sheet__id">
              <span className="graph-sheet__key">{t("graph.sheet.id")}</span> <code>{data.id}</code>
            </p>
          </>
        )}
        <h4 className="graph-sheet__heading">{t("graphCanvas.edge.fromTo")}</h4>
        <ul className="graph-sheet__list">
          {[
            { node: drawn.source, caption: from?.caption ?? "", role: t("graphCanvas.edge.start") },
            { node: drawn.target, caption: to?.caption ?? "", role: t("graphCanvas.edge.end") },
          ].map((end) => (
            <li key={end.role} className="graph-sheet__item">
              <button
                type="button"
                className="graph-sheet__link"
                onClick={() => actions.selectNode(end.node)}
              >
                {end.caption}
              </button>
              <span className="graph-sheet__muted">{end.role}</span>
            </li>
          ))}
        </ul>
        {data === undefined ? null : (
          <>
            <h4 className="graph-sheet__heading">{t("graph.sheet.properties")}</h4>
            {Object.keys(data.properties).length === 0 ? (
              <p className="graph__note">{t("graphCanvas.edge.noProperties")}</p>
            ) : (
              <dl className="graph-sheet__properties">
                {Object.entries(data.properties).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{propertyText(value)}</dd>
                    <dd className="graph-sheet__type">{t(`graph.type.${propertyType(value)}`)}</dd>
                  </div>
                ))}
              </dl>
            )}
            {links.length === 0 ? null : (
              <>
                <h4 className="graph-sheet__heading">{t("panels.dataLinks.title")}</h4>
                <DataLinkList links={links} label={t("panels.dataLinks.of", { name: data.type })} />
              </>
            )}
            {parallel.length < 2 ? null : (
              <>
                <h4 className="graph-sheet__heading">{t("graphCanvas.edge.between")}</h4>
                <p className="graph__note">
                  {t("graphCanvas.edge.parallel", {
                    count: number.format(parallel.length),
                    at: number.format(position + 1),
                  })}
                </p>
                <ul className="graph-sheet__list">
                  {parallel
                    .filter((other) => other !== drawn.edge)
                    .slice(0, PARALLEL_SHOWN)
                    .map((other) => {
                      const otherData = model.edges[other];
                      const at = view.edgeOf[other] ?? -1;
                      if (otherData === undefined) return null;
                      const summary = edgeSummary(otherData.properties);
                      return (
                        <li key={otherData.id} className="graph-sheet__item">
                          {at >= 0 ? (
                            <button
                              type="button"
                              className="graph-sheet__link"
                              onClick={() => actions.selectEdge(at)}
                            >
                              {otherData.type}
                            </button>
                          ) : (
                            <span>{otherData.type}</span>
                          )}
                          {summary === "" ? null : (
                            <span className="graph-sheet__muted">{summary}</span>
                          )}
                        </li>
                      );
                    })}
                </ul>
                {parallel.length - 1 > PARALLEL_SHOWN ? (
                  <p className="graph__note">
                    {t("graph.sheet.moreNeighbours", {
                      count: number.format(parallel.length - 1 - PARALLEL_SHOWN),
                    })}
                  </p>
                ) : null}
              </>
            )}
          </>
        )}
        <div className="graph__actions">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => actions.selectEnds(edge)}
          >
            {t("graphCanvas.edge.selectEnds")}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            aria-keyshortcuts="H"
            onClick={() => actions.hide(edge)}
          >
            {t("graphCanvas.hide")}{" "}
            <span className="kbd" aria-hidden="true">
              H
            </span>
          </button>
        </div>
      </section>
    </section>
  );
}
