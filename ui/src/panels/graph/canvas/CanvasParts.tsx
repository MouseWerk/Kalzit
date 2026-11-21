import { type RefObject, useEffect, useId, useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import type { CanvasHandle } from "../SigmaCanvas";
import { followCanvas } from "./follow";
import "./canvas.css";

/** Hidden elements named in the list before "and N more". */
export const HIDDEN_LISTED = 50;

/**
 * The bar under a selection of two or more elements (Graph 0.8.1 board, frame 4), at the bottom
 * of the canvas: what is selected and the same actions as the context menu.
 */
export function SelectionBar({
  text,
  only,
  onInvert,
  onHide,
  onOnly,
}: {
  /** "5 nodes, 4 edges". */
  text: string;
  only: boolean;
  onInvert: () => void;
  onHide: () => void;
  onOnly: () => void;
}) {
  const { t } = useI18n();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of controls, not a field set
    <div className="graph-selbar" role="group" aria-label={t("graphCanvas.selection.bar")}>
      <span className="graph-selbar__count">{text}</span>
      <button type="button" className="button button--ghost button--small" onClick={onInvert}>
        {t("graphCanvas.selection.invertShort")}
      </button>
      <button type="button" className="button button--ghost button--small" onClick={onHide}>
        {t("graphCanvas.hide")}
      </button>
      <button
        type="button"
        className="button button--ghost button--small"
        aria-pressed={only}
        onClick={onOnly}
      >
        {t("graphCanvas.selection.onlyShort")}
      </button>
    </div>
  );
}

export interface HiddenEntry {
  /** A node id or an edge id. */
  id: string;
  caption: string;
}

/**
 * What the person hid (frame 4, step C): a quiet button on the canvas that opens the list, with
 * "Show" per element and for all. Hiding takes elements out of the view only.
 */
export function HiddenList({
  entries,
  onShow,
  onShowAll,
}: {
  entries: readonly HiddenEntry[];
  onShow: (id: string) => void;
  onShowAll: () => void;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (entries.length === 0) return null;
  const count = number.format(entries.length);
  return (
    <div className="graph-hidden">
      {open ? (
        <div className="graph-hidden__list" id={listId}>
          <p className="graph-hidden__title">{t("graphCanvas.hidden.byYou", { count })}</p>
          <ul className="graph-sheet__list">
            {entries.slice(0, HIDDEN_LISTED).map((entry) => (
              <li key={entry.id} className="graph-sheet__item">
                <span>{entry.caption}</span>
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
          {entries.length > HIDDEN_LISTED ? (
            <p className="graph__note">
              {t("graph.sheet.moreNeighbours", {
                count: number.format(entries.length - HIDDEN_LISTED),
              })}
            </p>
          ) : null}
          <button
            type="button"
            className="button button--secondary button--small"
            aria-keyshortcuts="Shift+H"
            onClick={() => {
              setOpen(false);
              onShowAll();
            }}
          >
            {t("graphCanvas.hidden.showAll")}{" "}
            <span className="kbd" aria-hidden="true">
              {t("graphCanvas.key.shiftH")}
            </span>
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="button button--ghost button--small graph-hidden__open"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="eyeOff" />
        {t("graphCanvas.hidden.count", { count })}
      </button>
    </div>
  );
}

/**
 * "Show pinned" (decision 7): a small neutral mark at every pinned node, off unless asked for.
 * The marks follow the canvas frame by frame; they are decoration, the side sheet, the step bar
 * and the table always name what is pinned.
 */
export function PinMarks({
  canvas,
  ready,
  stage,
  nodes,
}: {
  canvas: RefObject<CanvasHandle | null>;
  /** Whether the canvas is there (it loads lazily). */
  ready: boolean;
  stage: RefObject<HTMLElement | null>;
  /** The pinned nodes that are drawn (view indexes); keep its identity while it holds the same. */
  nodes: readonly number[];
}) {
  const [marks, setMarks] = useState<{ key: number; x: number; y: number }[]>([]);
  useEffect(() => {
    const handle = canvas.current;
    if (!ready || handle === null) return;
    const read = () => {
      const box = stage.current?.getBoundingClientRect();
      if (box === undefined) return;
      const next = nodes.flatMap((node) => {
        const at = handle.targetOf("node", node);
        return at === null
          ? []
          : [
              {
                key: node,
                x: at.x - box.left + at.reach * 0.7,
                y: at.y - box.top - at.reach * 0.7,
              },
            ];
      });
      setMarks((current) =>
        current.length === next.length &&
        current.every((m, i) => {
          const n = next[i];
          return n !== undefined && m.key === n.key && m.x === n.x && m.y === n.y;
        })
          ? current
          : next,
      );
    };
    return followCanvas(handle, read);
  }, [canvas, ready, stage, nodes]);
  return (
    <svg className="graph__marks" aria-hidden="true">
      {marks.map((mark) => (
        <circle key={mark.key} className="graph__pin-mark" cx={mark.x} cy={mark.y} r={3} />
      ))}
    </svg>
  );
}
