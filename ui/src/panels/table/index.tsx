import { useId, useRef, useState } from "react";
import type { Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { compareValues, formatValue, int64Key, rowCount } from "../frame";
import { EmptyPanel } from "../shared";
import { useStyleVars } from "../styleVars";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";

export type TableOptions = Record<string, never>;

/** Fixed row height in px, which is what lets the table render only the rows in view. */
export const ROW_HEIGHT = 32;
/** Rows rendered above and below the visible ones, so fast scrolling shows no blank rows. */
const OVERSCAN = 10;

type Sort = { column: number; direction: "ascending" | "descending" } | null;

/** Row order for a sort; null values stay at the end in both directions. */
export function sortedRows(frame: Frame, sort: Sort): Uint32Array {
  const count = rowCount(frame);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    order[i] = i;
  }
  const field = sort === null ? undefined : frame.fields[sort.column];
  if (sort === null || field === undefined) {
    return order;
  }
  const sign = sort.direction === "ascending" ? 1 : -1;
  const { type } = field;
  // int64 is compared as BigInt; converting once per sort keeps 100,000 rows fast.
  const values =
    type === "int64" ? field.values.map((v) => int64Key(v) ?? (v === null ? null : String(v))) : field.values;
  return order.sort((a, b) => {
    const left = values[a];
    const right = values[b];
    const leftMissing = left === null || left === undefined;
    const rightMissing = right === null || right === undefined;
    if (leftMissing || rightMissing) {
      return Number(leftMissing) - Number(rightMissing);
    }
    return sign * compareValues(type, left, right) || a - b;
  });
}

function nextSort(current: Sort, column: number): Sort {
  if (current === null || current.column !== column) {
    return { column, direction: "ascending" };
  }
  return current.direction === "ascending" ? { column, direction: "descending" } : null;
}

function FrameTable({ frame, title }: { frame: Frame; title: string }) {
  const { t, language } = useI18n();
  const scrollRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLTableRowElement>(null);
  const bottomRef = useRef<HTMLTableRowElement>(null);
  const { height } = useElementSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [sort, setSort] = useState<Sort>(null);
  const order = sortedRows(frame, sort);
  const total = order.length;
  const visible = Math.ceil(height / ROW_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, start + visible + 2 * OVERSCAN);

  useStyleVars(scrollRef, { "--vt-row-height": `${ROW_HEIGHT}px` });
  useStyleVars(topRef, { "--vt-spacer": `${start * ROW_HEIGHT}px` });
  useStyleVars(bottomRef, { "--vt-spacer": `${(total - end) * ROW_HEIGHT}px` });

  const rows = [];
  for (let position = start; position < end; position++) {
    const row = order[position] as number;
    rows.push(
      <tr key={row} className="vt__row" aria-rowindex={position + 2}>
        {frame.fields.map((field, column) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; columns cannot
          <td key={column} className={`vt__cell vt__cell--${field.type}`}>
            {formatValue(field.type, field.values[row], language)}
          </td>
        ))}
      </tr>,
    );
  }

  return (
    <section
      className="vt"
      ref={scrollRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs focus to scroll by keyboard
      tabIndex={0}
      aria-label={title}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <table className="vt__table" aria-rowcount={total + 1}>
        <thead>
          <tr aria-rowindex={1}>
            {frame.fields.map((field, column) => {
              const direction = sort?.column === column ? sort.direction : undefined;
              return (
                <th
                  // biome-ignore lint/suspicious/noArrayIndexKey: names can repeat; columns cannot
                  key={column}
                  scope="col"
                  className={`vt__head vt__cell--${field.type}`}
                  aria-sort={direction ?? "none"}
                >
                  <button
                    type="button"
                    className="vt__sort"
                    onClick={() => setSort(nextSort(sort, column))}
                    title={t("dashboards.panels.sortBy", { column: field.name })}
                  >
                    <span className="truncate">{field.name}</span>
                    <span className="vt__sort-mark" aria-hidden="true">
                      {direction === "ascending" ? "▲" : direction === "descending" ? "▼" : ""}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {/* Spacers hold the height of the rows out of view; they are not rows to read. */}
          {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an empty spacer, not a row */}
          <tr className="vt__spacer" ref={topRef} role="presentation">
            <td colSpan={frame.fields.length} />
          </tr>
          {rows}
          {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an empty spacer, not a row */}
          <tr className="vt__spacer" ref={bottomRef} role="presentation">
            <td colSpan={frame.fields.length} />
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function TablePanel({ frames, title }: PanelProps<TableOptions>) {
  const { t } = useI18n();
  const selectId = useId();
  const [index, setIndex] = useState(0);
  const frame = frames[Math.min(index, frames.length - 1)];
  if (frame === undefined || frame.fields.length === 0) {
    return <EmptyPanel reason="noData" />;
  }
  return (
    <div className="table-panel">
      {frames.length > 1 ? (
        <div className="preference table-panel__picker">
          <label htmlFor={selectId}>{t("dashboards.panels.result")}</label>
          <select
            id={selectId}
            className="select"
            value={index}
            onChange={(event) => setIndex(Number(event.currentTarget.value))}
          >
            {frames.map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one entry per result, in order
              <option key={i} value={i}>
                {t("dashboards.panels.resultNumber", { number: i + 1 })}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <FrameTable key={index} frame={frame} title={title} />
    </div>
  );
}

function TableEditor(_: PanelEditorProps<TableOptions>) {
  const { t } = useI18n();
  return <p className="field__hint">{t("dashboards.panels.tableHint")}</p>;
}

export const tablePanel: PanelPlugin<TableOptions> = {
  type: "table",
  name: "dashboards.panels.table",
  shapes: ["frame"],
  options: () => ({}),
  Panel: TablePanel,
  Editor: TableEditor,
};
