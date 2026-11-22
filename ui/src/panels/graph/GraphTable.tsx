import { type KeyboardEvent, type MouseEvent, useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import type { HiddenEntry } from "./canvas/CanvasParts";
import { DEFAULT_SCOPE, searchGraph } from "./canvas/search";
import type { GraphModel } from "./model";
import type { GraphView, Visibility } from "./view";
import "./graph.css";
import "./canvas/canvas.css";
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
  /** Pinned node ids, and the row action that pins or releases a node. */
  pinned?: readonly string[];
  onTogglePin?: (id: string) => void;
  /** Selected edges (view indexes), and the edge row's button: selects it with its sheet. */
  selectedEdges?: ReadonlySet<number>;
  onSelectEdge?: (edge: number, additive: boolean) => void;
  /** What the person hid, listed with "Show" (Graph 0.8.1 board, frame 19). */
  hidden?: readonly HiddenEntry[];
  /** Shows one hidden element again, or all of them (no id). */
  onShow?: (id?: string) => void;
  /** The view's keys (undo, redo, back to the drawing). */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** Replaces the selection with these nodes (the check boxes' range and "Select all"). */
  onSelectMany?: (nodes: readonly number[]) => void;
  /** Opens the canvas menu for a row (right click, Shift+F10 or the menu key). */
  onRowMenu?: (row: { kind: "node" | "edge"; index: number }, at: { x: number; y: number }) => void;
}

/**
 * The graph as two tables, nodes and edges: the screen reader and keyboard view of the drawing,
 * and the whole panel where the browser cannot draw it (Graph 0.8.1 board, frame 19). A row's
 * button selects the node or the edge in the drawing too; a node's row pins or releases it, the
 * place column says what is pinned, and what the person hid is listed with "Show". The search
 * field filters the rows by caption and properties.
 */
export function GraphTable({
  model,
  view,
  visibility,
  selected,
  onSelect,
  title,
  pinned = [],
  onTogglePin,
  selectedEdges,
  onSelectEdge,
  hidden = [],
  onShow,
  onKeyDown,
  onSelectMany,
  onRowMenu,
}: GraphTableProps) {
  const { t, language } = useI18n();
  const [nodeRows, setNodeRows] = useState(TABLE_PAGE);
  const [edgeRows, setEdgeRows] = useState(TABLE_PAGE);
  const [query, setQuery] = useState("");
  // The row whose check box was used last: Shift+click selects the range from there.
  const [anchor, setAnchor] = useState<number | null>(null);
  const searchId = useId();
  const hiddenId = useId();
  const number = new Intl.NumberFormat(language);
  // The search filters the rows: nodes it finds, and edges it finds or that touch a found node.
  const found = useMemo(() => {
    if (query.trim() === "") return null;
    const hits = searchGraph(model, query, { ...DEFAULT_SCOPE, edges: true });
    return {
      nodes: new Set(hits.flatMap((hit) => (hit.kind === "node" ? [hit.index] : []))),
      edges: new Set(hits.flatMap((hit) => (hit.kind === "edge" ? [hit.index] : []))),
    };
  }, [model, query]);
  // The view nodes the search found: a node, or a group holding a found node.
  const foundRows = useMemo(() => {
    if (found === null) return null;
    const rows = new Set<number>();
    for (const m of found.nodes) {
      const at = view.nodeOf[m] ?? -1;
      if (at >= 0) rows.add(at);
    }
    return rows;
  }, [found, view]);
  const nodeFound = (i: number) => foundRows === null || foundRows.has(i);
  const edgeFound = (i: number) => {
    if (found === null) return true;
    const edge = view.edges[i];
    if (edge === undefined) return false;
    return found.edges.has(edge.edge) || nodeFound(edge.source) || nodeFound(edge.target);
  };
  const shownNodes = view.nodes.flatMap((_, i) =>
    visibility.nodes[i] === 1 && nodeFound(i) ? [i] : [],
  );
  const shownEdges = view.edges.flatMap((_, i) =>
    visibility.edges[i] === 1 && edgeFound(i) ? [i] : [],
  );
  const caption = (i: number) => view.nodes[i]?.caption ?? "";
  const pins = new Set(pinned);
  const allSelected = shownNodes.length > 0 && shownNodes.every((i) => selected.has(i));
  /** The row's menu: from a right click at the pointer, from the keyboard at the row. */
  const rowMenu =
    onRowMenu === undefined
      ? () => ({})
      : (row: { kind: "node" | "edge"; index: number }) => ({
          onContextMenu: (event: MouseEvent<HTMLTableRowElement>) => {
            if (event.shiftKey) return;
            event.preventDefault();
            onRowMenu(row, { x: event.clientX, y: event.clientY });
          },
          onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
            if (!((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) return;
            event.preventDefault();
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            onRowMenu(row, { x: box.left + box.width / 3, y: box.bottom });
          },
        });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the view's keys reach the rows' buttons from here
    <div className="graph-table" onKeyDown={onKeyDown}>
      <div className="graph-table__search">
        <label className="visually-hidden" htmlFor={searchId}>
          {t("graphCanvas.search.inTable")}
        </label>
        <input
          id={searchId}
          className="input graph-table__search-input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("graphCanvas.search.inTable")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <table className="graph-table__table">
        <caption className="graph-table__caption">
          {t("graph.table.nodes", { title, count: number.format(shownNodes.length) })}
        </caption>
        <thead>
          <tr>
            {onSelectMany === undefined ? null : (
              <th scope="col" className="graph-table__check">
                <input
                  type="checkbox"
                  aria-label={t("graphCanvas.table.selectAll")}
                  checked={allSelected}
                  onChange={() => onSelectMany(allSelected ? [] : shownNodes)}
                />
              </th>
            )}
            <th scope="col">{t("graph.table.name")}</th>
            <th scope="col">{t("graph.table.labels")}</th>
            <th scope="col">{t("graph.table.degree")}</th>
            <th scope="col">{t("graphCanvas.table.place")}</th>
            {onTogglePin === undefined ? null : (
              <th scope="col">
                <span className="visually-hidden">{t("graphCanvas.table.actions")}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {shownNodes.slice(0, nodeRows).map((i) => {
            const node = view.nodes[i];
            if (node === undefined) return null;
            const data = node.node >= 0 ? model.nodes[node.node] : undefined;
            const isPinned = data !== undefined && pins.has(data.id);
            return (
              <tr key={node.key} {...rowMenu({ kind: "node", index: i })}>
                {onSelectMany === undefined ? null : (
                  <td className="graph-table__check">
                    <input
                      type="checkbox"
                      aria-label={t("graphCanvas.table.selectRow", { name: node.caption })}
                      checked={selected.has(i)}
                      onClick={(event) => {
                        const from = anchor === null ? -1 : shownNodes.indexOf(anchor);
                        const to = shownNodes.indexOf(i);
                        setAnchor(i);
                        if (event.shiftKey && from >= 0 && to >= 0) {
                          const range = shownNodes.slice(
                            Math.min(from, to),
                            Math.max(from, to) + 1,
                          );
                          onSelectMany([...new Set([...selected, ...range])]);
                        } else {
                          onSelect(i, true);
                        }
                      }}
                      onChange={() => undefined}
                    />
                  </td>
                )}
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
                <td>{isPinned ? t("graph.pin.pinned") : ""}</td>
                {onTogglePin === undefined ? null : (
                  <td>
                    {data === undefined ? null : (
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={
                          isPinned
                            ? t("graph.pin.removeNamed", { name: node.caption })
                            : t("graphCanvas.table.pinNamed", { name: node.caption })
                        }
                        onClick={() => onTogglePin(data.id)}
                      >
                        {isPinned ? t("graph.pin.remove") : t("graph.pin.add")}
                      </button>
                    )}
                  </td>
                )}
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
            const type =
              data === undefined
                ? t("graph.table.merged", { count: number.format(edge.count) })
                : data.type;
            return (
              <tr key={edge.key} {...rowMenu({ kind: "edge", index: i })}>
                <td>{caption(edge.source)}</td>
                <td>
                  {onSelectEdge === undefined ? (
                    type
                  ) : (
                    <button
                      type="button"
                      className="graph-table__select"
                      aria-pressed={selectedEdges?.has(i) === true}
                      onClick={(event) =>
                        onSelectEdge(i, event.shiftKey || event.ctrlKey || event.metaKey)
                      }
                    >
                      {type}
                    </button>
                  )}
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
      {hidden.length === 0 || onShow === undefined ? null : (
        <section className="graph-table__hidden" aria-labelledby={hiddenId}>
          <h3 className="graph-table__caption" id={hiddenId}>
            {t("graphCanvas.hidden.byYou", { count: number.format(hidden.length) })}
          </h3>
          <ul className="graph-table__hidden-list">
            {hidden.map((entry) => (
              <li key={entry.id}>
                <span>{entry.caption}</span>{" "}
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("graphCanvas.hidden.showNamed", { name: entry.caption })}
                  onClick={() => onShow(entry.id)}
                >
                  {t("graphCanvas.hidden.show")}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="button button--secondary button--small"
            aria-keyshortcuts="Shift+H"
            onClick={() => onShow()}
          >
            {t("graphCanvas.hidden.showAll")}
          </button>
        </section>
      )}
    </div>
  );
}
