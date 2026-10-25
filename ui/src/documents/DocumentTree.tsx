import { type KeyboardEvent, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { isComposingKey } from "../lib/ime";
import { useStyleVars } from "../panels/styleVars";
import { useElementSize } from "../panels/useElementSize";
import { filterable, filterablePath } from "./filter";
import { typeLabel, valueSummary } from "./labels";
import { filterPath, mongoPath, type Segment } from "./paths";
import { entriesOf, typeOf } from "./values";
import "./documents.css";
import "../features/dashboards/ui/shared.css";

/** Fixed row height in px, which is what lets the tree render only the rows in view. */
export const TREE_ROW_HEIGHT = 28;
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 12;
/** Elements of an array or fields of an object shown before "Show more". */
export const PAGE = 100;

interface Row {
  id: string;
  /** Index of the item (document or array element) the row belongs to. */
  item: number;
  /** Path from the item to the value; empty for the item itself. */
  segments: Segment[];
  level: number;
  name: string;
  value: unknown;
  expandable: boolean;
  expanded: boolean;
  /** Siblings and the row's place among them, for screen readers (most siblings are not drawn). */
  size: number;
  position: number;
  /** Row index of the parent; -1 at the top. */
  parent: number;
  /** A "Show more" row of the parent: how many entries it still hides. */
  more?: number;
}

const rowId = (item: number, segments: readonly Segment[]) => JSON.stringify([item, ...segments]);

/**
 * The rows of the open part of the tree, in reading order. Only opened objects and arrays are
 * walked, so a collapsed list of 10,000 documents costs one row each.
 */
export function flattenTree(
  items: readonly unknown[],
  expanded: ReadonlySet<string>,
  shown: ReadonlyMap<string, number>,
  itemLabel: (index: number) => string,
): Row[] {
  const rows: Row[] = [];
  const open = (
    parent: number,
    item: number,
    value: unknown,
    segments: Segment[],
    level: number,
  ) => {
    const parentId = rowId(item, segments);
    const entries = entriesOf(value);

    const limit = shown.get(parentId) ?? PAGE;
    for (const [position, [key, child]] of entries.slice(0, limit).entries()) {
      const childSegments = [...segments, key];
      const id = rowId(item, childSegments);
      const expandable = entriesOf(child).length > 0;
      const isOpen = expandable && expanded.has(id);
      rows.push({
        id,
        item,
        segments: childSegments,
        level,
        name: typeof key === "number" ? `[${key}]` : key,
        value: child,
        expandable,
        expanded: isOpen,
        size: entries.length,
        position: position + 1,
        parent,
      });
      if (isOpen) {
        open(rows.length - 1, item, child, childSegments, level + 1);
      }
    }
    if (entries.length > limit) {
      rows.push({
        id: `${parentId}+more`,
        item,
        segments,
        level,
        name: "",
        value: undefined,
        expandable: false,
        expanded: false,
        size: entries.length,
        position: limit + 1,
        parent,
        more: entries.length - limit,
      });
    }
  };
  items.forEach((value, item) => {
    const id = rowId(item, []);
    const expandable = entriesOf(value).length > 0;
    const isOpen = expandable && expanded.has(id);
    rows.push({
      id,
      item,
      segments: [],
      level: 1,
      name: itemLabel(item),
      value,
      expandable,
      expanded: isOpen,
      size: items.length,
      position: item + 1,
      parent: -1,
    });
    if (isOpen) {
      open(rows.length - 1, item, value, [], 2);
    }
  });
  return rows;
}

export interface DocumentTreeProps {
  items: readonly unknown[];
  /** Name of an item's row: "Document 3", or "[3]" for elements of an array. */
  itemLabel: (index: number) => string;
  /**
   * Where the items sit in their document, for drilldowns into an array: the path to the array.
   * Absent when the items are whole documents.
   */
  prefix?: readonly Segment[] | undefined;
  /** Accessible name of the tree. */
  label: string;
  /** Click-to-filter: a filter path without array indexes, and the value as it came. */
  onFilter?: ((path: string, value: unknown) => void) | undefined;
  /** Opens a non-empty array as a list of its own. */
  onOpenList?: ((item: number, segments: Segment[]) => void) | undefined;
}

/**
 * Documents as an expandable tree, virtualized like the table panel: fixed row heights, only the
 * rows in view are drawn. Keyboard as in the WAI-ARIA tree pattern (arrows, Home, End, Page Up and
 * Down, Enter); the tree keeps focus and points at the active row with aria-activedescendant, so
 * scrolling a row out of view never drops focus. The bar above acts on the active row.
 */
export function DocumentTree({
  items,
  itemLabel,
  prefix,
  label,
  onFilter,
  onOpenList,
}: DocumentTreeProps) {
  const { t, language } = useI18n();
  const baseId = useId();
  const hintId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(listRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const rows = flattenTree(items, expanded, shown, itemLabel);
  const activeIndex = activeId === null ? -1 : rows.findIndex((row) => row.id === activeId);
  const active = rows[activeIndex];
  const total = rows.length;
  const visible = Math.max(1, Math.ceil(height / TREE_ROW_HEIGHT));
  const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, start + visible + 2 * OVERSCAN);

  useStyleVars(listRef, { "--tree-row-height": `${TREE_ROW_HEIGHT}px` });
  useStyleVars(topRef, { "--tree-spacer": `${start * TREE_ROW_HEIGHT}px` });
  useStyleVars(bottomRef, { "--tree-spacer": `${(total - end) * TREE_ROW_HEIGHT}px` });

  const domId = (index: number) => `${baseId}-row-${index}`;
  const fullSegments = (row: Row): Segment[] =>
    prefix === undefined ? row.segments : [...prefix, row.item, ...row.segments];

  function toggle(row: Row, open = !row.expanded) {
    if (!row.expandable) {
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (open) {
        next.add(row.id);
      } else {
        next.delete(row.id);
      }
      return next;
    });
  }

  function showMore(row: Row) {
    const parentId = rowId(row.item, row.segments);
    setShown((current) => new Map(current).set(parentId, (current.get(parentId) ?? PAGE) + PAGE));
  }

  /** Makes a row active and scrolls it into view. */
  function activate(index: number) {
    const row = rows[Math.max(0, Math.min(total - 1, index))];
    if (row === undefined) {
      return;
    }
    const position = rows.indexOf(row);
    setActiveId(row.id);
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const top = position * TREE_ROW_HEIGHT;
    let next = list.scrollTop;
    if (top < next) {
      next = top;
    } else if (top + TREE_ROW_HEIGHT > next + height) {
      next = top + TREE_ROW_HEIGHT - height;
    }
    if (next !== list.scrollTop) {
      list.scrollTop = next;
      setScrollTop(next);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (total === 0 || isComposingKey(event)) {
      return;
    }
    const current = activeIndex === -1 ? 0 : activeIndex;
    const row = rows[current];
    let handled = true;
    switch (event.key) {
      case "ArrowDown":
        activate(activeIndex === -1 ? 0 : current + 1);
        break;
      case "ArrowUp":
        activate(current - 1);
        break;
      case "Home":
        activate(0);
        break;
      case "End":
        activate(total - 1);
        break;
      case "PageDown":
        activate(current + visible);
        break;
      case "PageUp":
        activate(current - visible);
        break;
      case "ArrowRight":
        if (row?.expandable && !row.expanded) {
          toggle(row, true);
        } else if (row?.expanded) {
          activate(current + 1);
        }
        break;
      case "ArrowLeft":
        if (row?.expanded) {
          toggle(row, false);
        } else if (row !== undefined && row.parent >= 0) {
          activate(row.parent);
        }
        break;
      case "Enter":
      case " ":
        if (row?.more !== undefined) {
          showMore(row);
        } else if (row !== undefined) {
          toggle(row);
        }
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      if (activeIndex === -1 && row !== undefined && event.key !== "ArrowDown") {
        setActiveId(row.id);
      }
    }
  }

  async function copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
      setStatus(t("documents.tree.copied", { path }));
    } catch {
      setStatus(t("documents.tree.copyFailed"));
    }
  }

  const drawn = [];
  for (let index = start; index < end; index++) {
    const row = rows[index] as Row;
    drawn.push(
      <TreeRow
        key={row.id}
        id={domId(index)}
        row={row}
        active={index === activeIndex}
        summary={row.more === undefined ? valueSummary(t, row.value, language) : ""}
        type={row.more === undefined ? typeLabel(t, typeOf(row.value)) : ""}
        moreLabel={
          row.more === undefined
            ? ""
            : t("documents.tree.showMore", { count: Math.min(PAGE, row.more), rest: row.more })
        }
        onClick={() => {
          // Rows are not tab stops; focus stays on the tree, which points at the active row.
          listRef.current?.focus();
          setActiveId(row.id);
          if (row.more !== undefined) {
            showMore(row);
          } else {
            toggle(row);
          }
        }}
      />,
    );
  }

  // A whole document has no path; an element of a drilled-down array has one.
  const hasPath =
    active !== undefined &&
    active.more === undefined &&
    (active.segments.length > 0 || prefix !== undefined);
  const path = hasPath ? mongoPath(fullSegments(active)) : "";
  // A key with a dot or a leading $ cannot be named in a filter path, so it offers none.
  const canFilter =
    hasPath &&
    onFilter !== undefined &&
    filterable(active.value) &&
    filterablePath(fullSegments(active));
  const canOpen =
    hasPath && onOpenList !== undefined && Array.isArray(active.value) && active.value.length > 0;

  return (
    <div className="doc-tree">
      <div className="doc-tree__bar">
        {hasPath ? (
          <code className="doc-tree__path truncate" title={path}>
            {path}
          </code>
        ) : (
          <span className="doc-tree__hint">{t("documents.tree.hint")}</span>
        )}
        {hasPath ? (
          <div className="doc-tree__actions">
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => void copyPath(path)}
            >
              {t("documents.tree.copyPath")}
            </button>
            {canFilter ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  onFilter?.(filterPath(fullSegments(active)), active.value);
                  setStatus(
                    t("documents.tree.filtered", { path: filterPath(fullSegments(active)) }),
                  );
                }}
              >
                {t("documents.tree.filter")}
              </button>
            ) : null}
            {canFilter && active.value === null ? (
              <span className="doc-tree__hint">{t("documents.tree.nullHint")}</span>
            ) : null}
            {canOpen ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onOpenList?.(active.item, active.segments)}
              >
                {t("documents.tree.openList")}
              </button>
            ) : null}
          </div>
        ) : null}
        <span className="visually-hidden" id={hintId}>
          {t("documents.tree.keys")}
        </span>
        <span className="visually-hidden" role="status">
          {status}
        </span>
      </div>
      <div
        ref={listRef}
        className="doc-tree__list"
        role="tree"
        aria-label={label}
        aria-describedby={hintId}
        aria-activedescendant={
          activeIndex >= start && activeIndex < end ? domId(activeIndex) : undefined
        }
        tabIndex={0}
        onFocus={(event) => {
          // Focus arrives on the tree itself: the first row becomes the active one, so arrow
          // keys and screen readers start from a row instead of from nothing.
          if (event.target === event.currentTarget && activeId === null && rows[0] !== undefined) {
            setActiveId(rows[0].id);
          }
        }}
        onKeyDown={onKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {/* Spacers hold the height of the rows out of view; they are not rows to read. */}
        <div className="doc-tree__spacer" ref={topRef} role="none" />
        {drawn}
        <div className="doc-tree__spacer" ref={bottomRef} role="none" />
      </div>
    </div>
  );
}

function TreeRow({
  id,
  row,
  active,
  summary,
  type,
  moreLabel,
  onClick,
}: {
  id: string;
  row: Row;
  active: boolean;
  summary: string;
  type: string;
  moreLabel: string;
  onClick: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useStyleVars(ref, { "--tree-level": row.level - 1 });
  const className = active ? "doc-tree__row doc-tree__row--active" : "doc-tree__row";
  if (row.more !== undefined) {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles keys for every row
      <div
        ref={ref}
        id={id}
        className={`${className} doc-tree__row--more`}
        role="treeitem"
        aria-level={row.level}
        aria-setsize={row.size}
        aria-posinset={row.position}
        aria-selected={active}
        tabIndex={-1}
        onClick={onClick}
      >
        <span className="doc-tree__indent" aria-hidden="true" />
        <span className="doc-tree__more">{moreLabel}</span>
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles keys for every row
    <div
      ref={ref}
      id={id}
      className={className}
      role="treeitem"
      aria-level={row.level}
      aria-setsize={row.size}
      aria-posinset={row.position}
      aria-selected={active}
      aria-expanded={row.expandable ? row.expanded : undefined}
      tabIndex={-1}
      onClick={onClick}
    >
      <span className="doc-tree__indent" aria-hidden="true" />
      <span className="doc-tree__toggle" aria-hidden="true">
        {row.expandable ? (row.expanded ? "▾" : "▸") : ""}
      </span>
      <span className="doc-tree__key">{row.name}</span>
      <span className="doc-tree__type">{type}</span>
      <span className="doc-tree__value truncate" title={summary}>
        {summary}
      </span>
    </div>
  );
}
