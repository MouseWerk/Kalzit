import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Span } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useElementSize } from "../useElementSize";
import {
  axisTicks,
  criticalPath,
  formatDuration,
  type SpanRow,
  spanRows,
  type TraceView,
  treeDepth,
} from "./model";
import { type SpanActions, SpanDetail } from "./SpanDetail";
import { clockTime } from "./TraceList";
import { cssVars } from "./vars";
import "./trace.css";

type Show = "all" | "errors" | "critical";

/** Rows drawn above and below the visible ones, so scrolling never shows a gap. */
const OVERSCAN = 8;
/** Rows drawn where there is no layout to measure (tests without a browser). */
const UNMEASURED_ROWS = 200;
/** Rows of the overview; deeper spans share the last one. */
const OVERVIEW_ROWS = 12;
/** Spans the overview draws; more would only repeat pixels. */
const OVERVIEW_SPANS = 2000;

function rowHeight(): number {
  const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return 1.75 * (Number.isFinite(root) && root > 0 ? root : 16);
}

/**
 * One trace as a waterfall (board frames 2, 3 and 5): the tree of spans with a bar per span on
 * the time axis, an overview of the whole trace to zoom in, and the detail of the chosen span.
 * A treegrid: Up and Down move, Right and Left open and close, Enter opens the detail.
 */
export function Waterfall({
  trace,
  title,
  compact,
  collapseDepth,
  events,
  actions,
  onSpanClick,
}: {
  trace: TraceView;
  /** Accessible name of the grid. */
  title: string;
  /** A dashboard panel: no facts line, a narrower name column, the detail as an overlay. */
  compact: boolean;
  collapseDepth: number;
  events: boolean;
  actions: SpanActions;
  /** A click on a span, beyond selecting it (a panel setting a variable). */
  onSpanClick?: ((span: Span) => void) | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const rows = useMemo(() => spanRows(trace.spans), [trace]);
  const critical = useMemo(() => criticalPath(trace.spans), [trace]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        collapseDepth > 0
          ? rows
              .filter((row) => row.children > 0 && row.depth + 1 >= collapseDepth)
              .map((row) => row.span.spanId)
          : [],
      ),
  );
  const [show, setShow] = useState<Show>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  // The part of the trace the lanes show, as fractions of its duration.
  const [zoom, setZoom] = useState<{ from: number; to: number }>({ from: 0, to: 1 });
  const [scrollTop, setScrollTop] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const { height } = useElementSize(gridRef);

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    // A filter keeps the matching spans and their ancestors, so the tree stays a tree.
    let keep: Set<string> | null = null;
    if (show !== "all" || needle !== "") {
      keep = new Set();
      const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
      for (const span of trace.spans) {
        const matches =
          (show === "all" ||
            (show === "errors" ? span.status === "error" : critical.has(span.spanId))) &&
          (needle === "" ||
            span.service.toLocaleLowerCase().includes(needle) ||
            span.operation.toLocaleLowerCase().includes(needle));
        let at: Span | undefined = matches ? span : undefined;
        while (at !== undefined && !keep.has(at.spanId)) {
          keep.add(at.spanId);
          at = at.parentSpanId === undefined ? undefined : byId.get(at.parentSpanId);
        }
      }
    }
    const out: SpanRow[] = [];
    let hiddenBelow = -1;
    for (const row of rows) {
      if (hiddenBelow >= 0 && row.depth > hiddenBelow) continue;
      hiddenBelow = -1;
      if (keep !== null && !keep.has(row.span.spanId)) continue;
      out.push(row);
      if (closed.has(row.span.spanId)) hiddenBelow = row.depth;
    }
    return out;
  }, [rows, closed, show, needle, critical, trace]);

  const total = Math.max(trace.duration, 1);
  const windowStart = zoom.from * total;
  const windowLength = Math.max((zoom.to - zoom.from) * total, 1);
  const selectedSpan = trace.spans.find((span) => span.spanId === selected);
  const rowPx = rowHeight();
  const first = height > 0 ? Math.max(0, Math.floor(scrollTop / rowPx) - 1 - OVERSCAN) : 0;
  const count = height > 0 ? Math.ceil(height / rowPx) + 2 * OVERSCAN : UNMEASURED_ROWS;
  const activeId = active ?? selected ?? visible[0]?.span.spanId ?? null;
  const activeIndex = visible.findIndex((row) => row.span.spanId === activeId);
  // The rows in view, and always the active one: it holds the keyboard focus, and a row that
  // left the page would take the focus with it (to the body, where arrows do nothing).
  const drawn = visible.slice(first, first + count).map((row, offset) => ({
    row,
    index: first + offset,
  }));
  if (activeIndex >= 0 && (activeIndex < first || activeIndex >= first + count)) {
    drawn.push({ row: visible[activeIndex] as SpanRow, index: activeIndex });
  }
  // The row the keyboard moved to takes the focus once the render that holds it is on the page.
  const wantFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = wantFocus.current;
    if (id === null) return;
    const row = gridRef.current?.querySelector<HTMLElement>(`[data-span="${CSS.escape(id)}"]`);
    if (row !== null && row !== undefined) {
      wantFocus.current = null;
      row.focus({ preventScroll: true });
    }
  });

  const toggle = (id: string) =>
    setClosed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  function pick(row: SpanRow) {
    setSelected(row.span.spanId);
    setActive(row.span.spanId);
    setDetail(true);
    onSpanClick?.(row.span);
  }
  function focusRow(id: string) {
    wantFocus.current = id;
    setActive(id);
    const index = visible.findIndex((row) => row.span.spanId === id);
    const grid = gridRef.current;
    if (grid !== null && index >= 0 && height > 0) {
      const top = index * rowPx;
      if (top < grid.scrollTop) grid.scrollTop = top;
      else if (top + 2 * rowPx > grid.scrollTop + height) grid.scrollTop = top + 2 * rowPx - height;
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = visible.findIndex((row) => row.span.spanId === activeId);
    const row = visible[index];
    // Keys typed into the search, and keys of an input method, are not the grid's.
    if (row === undefined || isComposingKey(event)) return;
    if (!(event.target instanceof HTMLElement) || event.target.closest('[role="row"]') === null) {
      return;
    }
    const id = row.span.spanId;
    let handled = true;
    if (event.key === "ArrowDown") {
      const next = visible[index + 1];
      if (next !== undefined) focusRow(next.span.spanId);
    } else if (event.key === "ArrowUp") {
      const previous = visible[index - 1];
      if (previous !== undefined) focusRow(previous.span.spanId);
    } else if (event.key === "Home") {
      focusRow((visible[0] as SpanRow).span.spanId);
    } else if (event.key === "End") {
      focusRow((visible.at(-1) as SpanRow).span.spanId);
    } else if (event.key === "ArrowRight") {
      if (row.children > 0 && closed.has(id)) toggle(id);
      else if (row.children > 0 && visible[index + 1] !== undefined) {
        focusRow((visible[index + 1] as SpanRow).span.spanId);
      }
    } else if (event.key === "ArrowLeft") {
      if (row.children > 0 && !closed.has(id)) toggle(id);
      else {
        const parent = visible
          .slice(0, index)
          .reverse()
          .find((other) => other.depth < row.depth);
        if (parent !== undefined) focusRow(parent.span.spanId);
      }
    } else if (event.key === "Enter" || event.key === " ") {
      pick(row);
    } else if (event.key === "Escape" && detail) {
      setDetail(false);
    } else {
      handled = false;
    }
    if (handled) event.preventDefault();
  }

  const parents = rows.filter((row) => row.children > 0);
  const errors = trace.errors;
  return (
    <div className="trace">
      {compact ? null : (
        <dl className="trace-facts">
          <div>
            <dt>{t("traces.col.id")}</dt>
            <dd className="trace-mono">{trace.traceId}</dd>
          </div>
          <div>
            <dt>{t("traces.start")}</dt>
            <dd>{clockTime(trace.start / 1000, language, timeZone)}</dd>
          </div>
          <div>
            <dt>{t("traces.duration")}</dt>
            <dd>{formatDuration(trace.duration, language)}</dd>
          </div>
          <div>
            <dt>{t("traces.col.spans")}</dt>
            <dd>{trace.spans.length}</dd>
          </div>
          <div>
            <dt>{t("traces.col.services")}</dt>
            <dd>{trace.services.length}</dd>
          </div>
          <div>
            <dt>{t("traces.depth")}</dt>
            <dd>{treeDepth(rows)}</dd>
          </div>
          {errors === 0 ? null : (
            <div>
              <dt>{t("traces.error")}</dt>
              <dd className="trace-error">{t("traces.spanCount", { count: errors })}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="trace__bar">
        <label className="trace-search">
          <Icon name="search" />
          <input
            type="search"
            className="trace-search__input"
            value={query}
            placeholder={t("traces.find")}
            aria-label={t("traces.find")}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a field set */}
        <div className="trace-seg" role="group" aria-label={t("traces.show")}>
          {(["all", "errors", "critical"] as const).map((name) => (
            <button
              key={name}
              type="button"
              className="trace-seg__option"
              aria-pressed={show === name}
              onClick={() => setShow(name)}
            >
              {t(`traces.show.${name}`)}
            </button>
          ))}
        </div>
        <span className="trace__spacer" />
        {zoom.from > 0 || zoom.to < 1 ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setZoom({ from: 0, to: 1 })}
          >
            {t("traces.zoomOut")}
          </button>
        ) : null}
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={closed.size === 0}
          onClick={() => setClosed(new Set())}
        >
          {t("traces.expand")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={parents.length === 0 || closed.size === parents.length}
          onClick={() => setClosed(new Set(parents.map((row) => row.span.spanId)))}
        >
          {t("traces.collapse")}
        </button>
      </div>
      <div className="trace-body">
        <div className="trace-main">
          <Overview trace={trace} rows={rows} zoom={zoom} onZoom={setZoom} />
          <div
            ref={gridRef}
            className={compact ? "trace-grid trace-grid--narrow" : "trace-grid"}
            role="treegrid"
            aria-label={title}
            aria-rowcount={visible.length + 1}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            onKeyDown={onKeyDown}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: the header row of the treegrid */}
            <div className="trace-grid__head" role="row" aria-rowindex={1} tabIndex={-1}>
              {/* biome-ignore lint/a11y/useSemanticElements: a column header of the treegrid */}
              <span className="trace-grid__label" role="columnheader" tabIndex={-1}>
                {t("traces.name")}
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: a column header of the treegrid */}
              <span
                className="trace-axis"
                role="columnheader"
                tabIndex={-1}
                aria-label={t("traces.duration")}
              >
                {axisTicks(windowLength).map((tick, index) => (
                  <span
                    key={tick}
                    className="trace-axis__tick"
                    aria-hidden="true"
                    ref={cssVars({ "--at": index / 4 })}
                  >
                    {formatDuration(windowStart + tick, language)}
                  </span>
                ))}
              </span>
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: the rows of the treegrid */}
            <div
              className="trace-grid__rows"
              role="rowgroup"
              ref={cssVars({ "--rows": visible.length })}
            >
              {drawn.map(({ row, index }) => {
                const { span } = row;
                const isClosed = closed.has(span.spanId);
                const failed = span.status === "error";
                const x = (span.start - trace.start - windowStart) / windowLength;
                const w = span.duration / windowLength;
                // Clipped to the lane: a span that starts before the zoomed part begins at 0.
                const left = Math.min(Math.max(x, 0), 1);
                const width = Math.max(Math.min(x + w, 1) - left, 0);
                const dim = show === "critical" && !critical.has(span.spanId);
                return (
                  // biome-ignore lint/a11y/useSemanticElements: a row of the treegrid
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the grid handles keys for every row
                  <div
                    key={span.spanId}
                    className={dim ? "trace-row trace-row--dim" : "trace-row"}
                    role="row"
                    data-span={span.spanId}
                    aria-level={row.depth + 1}
                    aria-rowindex={index + 2}
                    aria-expanded={row.children > 0 ? !isClosed : undefined}
                    aria-selected={selected === span.spanId}
                    tabIndex={activeId === span.spanId ? 0 : -1}
                    ref={cssVars({ "--index": index, "--depth": row.depth })}
                    onClick={() => pick(row)}
                    onFocus={() => setActive(span.spanId)}
                  >
                    {/* biome-ignore lint/a11y/useSemanticElements: a cell of the treegrid */}
                    <span
                      className="trace-row__name"
                      role="gridcell"
                      tabIndex={-1}
                      // The level too: past the twelfth the indent no longer grows.
                      title={`${row.depth + 1} · ${span.service}: ${span.operation}`}
                    >
                      <span className="trace-row__indent" />
                      {row.children > 0 ? (
                        <button
                          type="button"
                          className="trace-row__toggle"
                          tabIndex={-1}
                          aria-expanded={!isClosed}
                          aria-label={t(isClosed ? "traces.openSpan" : "traces.closeSpan")}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(span.spanId);
                          }}
                        >
                          <Icon name="chevron" />
                        </button>
                      ) : (
                        <span className="trace-row__leaf" />
                      )}
                      <span className="trace-row__service">{span.service}</span>
                      <span className="trace-row__operation">{span.operation}</span>
                      {isClosed ? (
                        <span className="trace-row__more">
                          {t("traces.spanCount", { count: row.descendants })}
                        </span>
                      ) : null}
                      {failed ? <span className="trace-row__flag">{t("traces.error")}</span> : null}
                    </span>
                    {/* biome-ignore lint/a11y/useSemanticElements: a cell of the treegrid */}
                    <span className="trace-row__lane" role="gridcell" tabIndex={-1}>
                      <span
                        className={
                          failed ? "trace-row__span trace-row__span--error" : "trace-row__span"
                        }
                        ref={cssVars({ "--x": left, "--w": width })}
                      >
                        {events && span.duration > 0
                          ? span.events.map((event, at) => (
                              <span
                                // biome-ignore lint/suspicious/noArrayIndexKey: events have no id
                                key={at}
                                className="trace-row__event"
                                ref={cssVars({
                                  "--e": Math.min(
                                    Math.max((event.time - span.start) / span.duration, 0),
                                    1,
                                  ),
                                })}
                              />
                            ))
                          : null}
                      </span>
                      <span
                        className="trace-row__time"
                        ref={cssVars({ "--x": left, "--w": width })}
                      >
                        {formatDuration(span.duration, language)}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {detail && selectedSpan !== undefined ? (
          <SpanDetail
            key={selectedSpan.spanId}
            span={selectedSpan}
            trace={trace}
            overlay={compact}
            actions={actions}
            onClose={() => {
              setDetail(false);
              if (selected !== null) focusRow(selected);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The whole trace in a strip: every span a thin line at its depth. Dragging picks the part the
 * waterfall shows, a double click shows everything again. Decoration for a screen reader, which
 * has the durations as text in every row and "Whole trace" as a button.
 */
function Overview({
  trace,
  rows,
  zoom,
  onZoom,
}: {
  trace: TraceView;
  rows: readonly SpanRow[];
  zoom: { from: number; to: number };
  onZoom: (zoom: { from: number; to: number }) => void;
}) {
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const total = Math.max(trace.duration, 1);
  const at = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1) : 0;
  };
  const shown = drag ?? zoom;
  const from = Math.min(shown.from, shown.to);
  const to = Math.max(shown.from, shown.to);
  const lines = rows.length > OVERVIEW_SPANS ? rows.slice(0, OVERVIEW_SPANS) : rows;
  const whole = from === 0 && to === 1;
  return (
    <div
      className="trace-overview"
      aria-hidden="true"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = at(event);
        setDrag({ from: start, to: start });
      }}
      onPointerMove={(event) => {
        if (drag !== null) setDrag({ from: drag.from, to: at(event) });
      }}
      onPointerUp={() => {
        if (drag !== null && Math.abs(drag.to - drag.from) > 0.01) {
          onZoom({ from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) });
        }
        setDrag(null);
      }}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={() => onZoom({ from: 0, to: 1 })}
    >
      <svg
        className="trace-overview__plot"
        aria-hidden="true"
        viewBox={`0 0 1000 ${OVERVIEW_ROWS * 3 + 4}`}
        preserveAspectRatio="none"
      >
        {whole ? null : (
          <rect
            className="trace-overview__window"
            x={from * 1000}
            y="0"
            width={(to - from) * 1000}
            height={OVERVIEW_ROWS * 3 + 4}
          />
        )}
        {lines.map(({ span, depth }) => (
          <rect
            key={span.spanId}
            className={
              span.status === "error"
                ? "trace-overview__span trace-overview__span--error"
                : "trace-overview__span"
            }
            x={((span.start - trace.start) / total) * 1000}
            y={2 + Math.min(depth, OVERVIEW_ROWS - 1) * 3}
            width={Math.max((span.duration / total) * 1000, 2)}
            height="2"
          />
        ))}
      </svg>
    </div>
  );
}
