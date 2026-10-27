import { useState } from "react";
import { useI18n } from "../../i18n/i18n";
import type { GraphModel } from "./model";
import type { GraphView, Visibility } from "./view";
import "./graph.css";
import "../../features/dashboards/ui/shared.css";

/** Rows shown at first and added per "Show more", so 20,000 nodes never land in the page at once. */
export const TABLE_PAGE = 100;

interface GraphTableProps {
  model: GraphModel;
  view: GraphView;
  visibility: Visibility;
  /** Selected view indexes. */
  selected: ReadonlySet<number>;
  /** A row's button: selects the node, or with Shift adds it to the selection. */
  onSelect: (node: number, additive: boolean) => void;
  /** Accessible name prefix: the panel title. */
  title: string;
}

/**
 * The graph as two tables, nodes and edges: the screen reader and keyboard view of the drawing,
 * and the whole panel where the browser cannot draw it. A row's button selects the node in the
 * drawing too.
 */
export function GraphTable({
  model,
  view,
  visibility,
  selected,
  onSelect,
  title,
}: GraphTableProps) {
  const { t, language } = useI18n();
  const [nodeRows, setNodeRows] = useState(TABLE_PAGE);
  const [edgeRows, setEdgeRows] = useState(TABLE_PAGE);
  const number = new Intl.NumberFormat(language);
  const shownNodes = view.nodes.flatMap((_, i) => (visibility.nodes[i] === 1 ? [i] : []));
  const shownEdges = view.edges.flatMap((_, i) => (visibility.edges[i] === 1 ? [i] : []));
  const caption = (i: number) => view.nodes[i]?.caption ?? "";

  return (
    <div className="graph-table">
      <table className="graph-table__table">
        <caption className="graph-table__caption">
          {t("graph.table.nodes", { title, count: number.format(shownNodes.length) })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("graph.table.name")}</th>
            <th scope="col">{t("graph.table.labels")}</th>
            <th scope="col">{t("graph.table.degree")}</th>
          </tr>
        </thead>
        <tbody>
          {shownNodes.slice(0, nodeRows).map((i) => {
            const node = view.nodes[i];
            if (node === undefined) return null;
            const data = node.node >= 0 ? model.nodes[node.node] : undefined;
            return (
              <tr key={node.key}>
                <th scope="row">
                  <button
                    type="button"
                    className="graph-table__select"
                    aria-pressed={selected.has(i)}
                    onClick={(event) =>
                      onSelect(i, event.shiftKey || event.ctrlKey || event.metaKey)
                    }
                  >
                    {node.caption}
                  </button>
                </th>
                <td>
                  {data === undefined
                    ? t("graph.table.group", { count: number.format(node.members) })
                    : data.labels.join(", ")}
                </td>
                <td className="graph-table__number">
                  {data === undefined ? "" : number.format(data.degree)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shownNodes.length > nodeRows ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setNodeRows((n) => n + TABLE_PAGE)}
        >
          {t("graph.table.more", {
            shown: number.format(nodeRows),
            count: number.format(shownNodes.length),
          })}
        </button>
      ) : null}
      <table className="graph-table__table">
        <caption className="graph-table__caption">
          {t("graph.table.edges", { title, count: number.format(shownEdges.length) })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("graph.table.from")}</th>
            <th scope="col">{t("graph.table.type")}</th>
            <th scope="col">{t("graph.table.to")}</th>
          </tr>
        </thead>
        <tbody>
          {shownEdges.slice(0, edgeRows).map((i) => {
            const edge = view.edges[i];
            if (edge === undefined) return null;
            const data = edge.edge >= 0 ? model.edges[edge.edge] : undefined;
            return (
              <tr key={edge.key}>
                <td>{caption(edge.source)}</td>
                <td>
                  {data === undefined
                    ? t("graph.table.merged", { count: number.format(edge.count) })
                    : data.type}
                </td>
                <td>{caption(edge.target)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shownEdges.length > edgeRows ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setEdgeRows((n) => n + TABLE_PAGE)}
        >
          {t("graph.table.more", {
            shown: number.format(edgeRows),
            count: number.format(shownEdges.length),
          })}
        </button>
      ) : null}
    </div>
  );
}
