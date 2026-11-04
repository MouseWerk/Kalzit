import { type ReactNode, useId, useRef, useState } from "react";
import { isRecord } from "../../api/client";
import type { Field, Frame } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import {
  cellLink,
  type DisplayValue,
  displayNameOf,
  displayText,
  displayValue,
  EMPTY_FIELD_CONFIG,
  type FieldConfig,
  type FieldOptions,
  fieldExtent,
  fieldOptionsFor,
  findMapping,
  toneClass,
} from "../fieldConfig/fieldConfig";
import { compareValues, formatValue, int64Key, isNumeric, rowCount, toNumber } from "../frame";
import { usePanelHost } from "../host";
import { TablePreview } from "../picker/previews";
import { fraction, toneName } from "../reduce";
import { CheckboxField, EmptyPanel, NumberField } from "../shared";
import { useStyleVars } from "../styleVars";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import {
  ClickVariableOptions,
  clickOption,
  MAX_VARIABLE_CHARS,
  useClickOptionTexts,
  useClickVariable,
  variableText,
} from "../variableClick";
import "../viz.css";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";

export interface TableOptions {
  /** A filter field under every column header. */
  columnFilters: boolean;
  /** Pages instead of one scrolled list. */
  pagination: boolean;
  pageSize: number;
  /** Dashboard variable a click on a row sets; empty sets none. */
  variable: string;
  /** Column (its shown name or field name) the variable takes; empty takes the first. */
  variableColumn: string;
}

export const MIN_PAGE_SIZE = 5;
export const MAX_PAGE_SIZE = 1000;
/** Longest column name the click option stores (the server's limit for option texts). */
export const MAX_COLUMN_CHARS = 200;

export function parseTableOptions(stored: unknown): TableOptions {
  const value = isRecord(stored) ? stored : {};
  const size = typeof value.pageSize === "number" ? Math.round(value.pageSize) : 50;
  return {
    columnFilters: value.columnFilters === true,
    pagination: value.pagination === true,
    pageSize: Math.min(Math.max(size, MIN_PAGE_SIZE), MAX_PAGE_SIZE),
    variable: clickOption(value.variable, MAX_VARIABLE_CHARS, true),
    variableColumn: clickOption(value.variableColumn, MAX_COLUMN_CHARS),
  };
}

/**
 * The column a row click takes the variable's value from: the one whose shown name or field
 * name is `name`, the first when `name` is empty, none when no column has that name.
 */
export function pickColumn(
  columns: readonly { name: string; field: Field }[],
  name: string,
): number {
  if (name === "") {
    return columns.length > 0 ? 0 : -1;
  }
  const shown = columns.findIndex((c) => c.name === name);
  return shown >= 0 ? shown : columns.findIndex((c) => c.field.name === name);
}

/** Fixed row height in px, which is what lets the table render only the rows in view. */
export const ROW_HEIGHT = 32;
/** Rows rendered above and below the visible ones, so fast scrolling shows no blank rows. */
const OVERSCAN = 10;
/** From this many columns on, only the columns in view are rendered (the first one stays put). */
export const VIRTUAL_COLUMNS_FROM = 40;
/** Width in px of a column without its own width, while only the columns in view are rendered. */
export const COLUMN_WIDTH = 160;
/** Columns rendered left and right of the visible ones. */
const COLUMN_OVERSCAN = 3;

/** The columns a wide table renders: the first, then `from` up to `to` (exclusive). */
export interface ColumnWindow {
  from: number;
  to: number;
  /** Width in px of the columns between the first and `from`, and after `to`. */
  before: number;
  after: number;
  /** Width in px of all columns. */
  total: number;
}

/**
 * Which columns of a wide table are in view, given each column's width, how far the table is
 * scrolled sideways and how wide its view is. The first column stays in place (sticky), so the
 * columns it covers count as out of view.
 */
export function columnWindow(
  widths: readonly number[],
  scrollLeft: number,
  viewWidth: number,
): ColumnWindow {
  const count = widths.length;
  const first = widths[0] ?? 0;
  const left = scrollLeft + first;
  const right = scrollLeft + viewWidth;
  let from = -1;
  let to = 1;
  let x = first;
  for (let i = 1; i < count; i++) {
    const start = x;
    x += widths[i] ?? 0;
    if (from === -1 && x > left) {
      from = i;
    }
    if (start < right) {
      to = i + 1;
    }
  }
  if (from === -1) {
    from = Math.max(1, count - 1);
  }
  from = Math.max(1, from - COLUMN_OVERSCAN);
  to = Math.min(count, Math.max(to, from) + COLUMN_OVERSCAN);
  let before = 0;
  let after = 0;
  for (let i = 1; i < count; i++) {
    if (i < from) {
      before += widths[i] ?? 0;
    } else if (i >= to) {
      after += widths[i] ?? 0;
    }
  }
  return { from, to, before, after, total: x };
}

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
    type === "int64"
      ? field.values.map((v) => int64Key(v) ?? (v === null ? null : String(v)))
      : field.values;
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

/** A column filter: a comparison for number columns (`>5`, `<=2.5`, `=0`, `!=3`), else text. */
export type ColumnFilter = (raw: unknown) => boolean;

const COMPARISON = /^(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i;

/**
 * Turns what was typed into a filter, or null for an empty one. Number columns accept a
 * comparison; everything else, and numbers without an operator, matches as text without case,
 * against the value and its mapped text.
 */
export function parseFilter(
  text: string,
  field: Field,
  options: FieldOptions,
): ColumnFilter | null {
  const wanted = text.trim();
  if (wanted === "") {
    return null;
  }
  const numeric = isNumeric(field.type);
  const comparison = numeric ? COMPARISON.exec(wanted) : null;
  if (comparison !== null) {
    const operator = comparison[1];
    const bound = Number(comparison[2]);
    return (raw) => {
      const value = toNumber(raw);
      if (value === null) return false;
      switch (operator) {
        case ">":
          return value > bound;
        case ">=":
          return value >= bound;
        case "<":
          return value < bound;
        case "<=":
          return value <= bound;
        case "!=":
          return value !== bound;
        default:
          return value === bound;
      }
    };
  }
  const needle = wanted.toLocaleLowerCase();
  const mappings = options.mappings;
  return (raw) => {
    if (raw === null || raw === undefined) return false;
    const text =
      typeof raw === "string" ? raw : field.type === "json" ? JSON.stringify(raw) : String(raw);
    if (text.toLocaleLowerCase().includes(needle)) return true;
    const mapped = mappings === undefined ? undefined : findMapping(raw, mappings)?.text;
    return mapped?.toLocaleLowerCase().includes(needle) === true;
  };
}

/** The rows in `order` that pass every filter, keeping the order. */
export function filterRows(
  frame: Frame,
  order: Uint32Array,
  filters: readonly (ColumnFilter | null)[],
): Uint32Array {
  const active = filters
    .map((filter, column) => ({ filter, values: frame.fields[column]?.values ?? [] }))
    .filter((f): f is { filter: ColumnFilter; values: unknown[] } => f.filter !== null);
  if (active.length === 0) {
    return order;
  }
  const kept = new Uint32Array(order.length);
  let count = 0;
  for (let i = 0; i < order.length; i++) {
    const row = order[i] as number;
    if (active.every(({ filter, values }) => filter(values[row]))) {
      kept[count++] = row;
    }
  }
  return kept.slice(0, count);
}

/**
 * The columns a wide table renders, in order: the first, those in `view`, and the focused one with
 * its neighbours, wherever the table is scrolled.
 */
export function shownColumns(view: ColumnWindow, focused: number | null, count: number): number[] {
  const set = new Set<number>([0]);
  for (let i = view.from; i < view.to; i++) {
    set.add(i);
  }
  if (focused !== null) {
    for (const i of [focused - 1, focused, focused + 1]) {
      if (i > 0 && i < count) {
        set.add(i);
      }
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * For each shown column that columns out of view follow, the width of those columns (up to the
 * next shown column or the end).
 */
export function columnGaps(
  shown: readonly number[],
  widths: readonly number[],
): Map<number, number> {
  const gaps = new Map<number, number>();
  shown.forEach((index, at) => {
    const next = shown[at + 1] ?? widths.length;
    let width = 0;
    for (let i = index + 1; i < next; i++) {
      width += widths[i] ?? 0;
    }
    if (width > 0) {
      gaps.set(index, width);
    }
  });
  return gaps;
}

function nextSort(current: Sort, column: number): Sort {
  if (current === null || current.column !== column) {
    return { column, direction: "ascending" };
  }
  return current.direction === "ascending" ? { column, direction: "descending" } : null;
}

interface Column {
  field: Field;
  options: FieldOptions;
  name: string;
  /** Min and max for gauge cells and percentage thresholds; computed only when needed. */
  range: { min: number; max: number } | undefined;
}

function columnsOf(frame: Frame, config: FieldConfig): Column[] {
  return frame.fields.map((field) => {
    const options = fieldOptionsFor(field, config);
    const needsRange = options.cellDisplay === "gauge" || options.thresholds?.mode === "percentage";
    const extent = needsRange ? fieldExtent(field) : null;
    return {
      field,
      options,
      name: displayNameOf(field, options),
      range:
        extent === null
          ? undefined
          : { min: options.min ?? Math.min(0, extent.min), max: options.max ?? extent.max },
    };
  });
}

/** One cell as its column's options say: plain, colored text or background, gauge or link. */
function Cell({
  column,
  raw,
  language,
  timeZone,
  colIndex,
}: {
  column: Column;
  raw: unknown;
  language: string;
  timeZone: string | null;
  /** The column's place (from 1) when only the columns in view are rendered. */
  colIndex: number | undefined;
}) {
  const { t } = useI18n();
  const { field, options } = column;
  const plain = Object.keys(options).length === 0;
  // Without options a cell is its value as it came; this is the fast path for big tables.
  const display: DisplayValue | null = plain
    ? null
    : displayValue(raw, field.type, options, language, column.range, timeZone);
  const text =
    display === null ? formatValue(field.type, raw, language, timeZone) : displayText(display);
  const mode = options.cellDisplay ?? "auto";
  const tone = display?.tone;
  const state = toneName(tone);
  const typeClass = `vt__cell vt__cell--${field.type}`;
  const spokenState =
    state === undefined ? null : <span className="visually-hidden">{` (${t(state)})`}</span>;
  if (mode === "color-text" && tone !== undefined) {
    return (
      <td className={`${typeClass} vt__cell--tone ${toneClass(tone)}`} aria-colindex={colIndex}>
        <span className="vt__swatch" aria-hidden="true" />
        {text}
        {spokenState}
      </td>
    );
  }
  if (mode === "color-background" && tone !== undefined) {
    return (
      <td className={`${typeClass} vt__cell--fill ${toneClass(tone)}`} aria-colindex={colIndex}>
        {text}
        {spokenState}
      </td>
    );
  }
  if (mode === "gauge" && display !== null && display.numeric !== null) {
    const share = fraction(display.numeric, column.range ?? { min: 0, max: 100 });
    return (
      <td className={`${typeClass} vt__cell--gauge`} aria-colindex={colIndex}>
        <svg className="vt__gauge" aria-hidden="true" preserveAspectRatio="none">
          <rect className="vt__gauge-track" x="0" y="0" width="100%" height="100%" />
          <rect
            className={`vt__gauge-bar ${toneClass(tone ?? options.color, 0)}`}
            x="0"
            y="0"
            width={`${(share * 100).toFixed(2)}%`}
            height="100%"
          />
        </svg>
        <span className="vt__gauge-text">{text}</span>
        {spokenState}
      </td>
    );
  }
  if (mode === "link" && options.link !== undefined && raw !== null && raw !== undefined) {
    const href = cellLink(options.link, typeof raw === "string" ? raw : String(raw), field.name);
    if (href !== null) {
      return (
        <td className={typeClass} aria-colindex={colIndex}>
          <a className="vt__link" href={href} rel="noopener noreferrer">
            {text}
          </a>
        </td>
      );
    }
  }
  return (
    <td className={typeClass} aria-colindex={colIndex}>
      {text}
      {spokenState}
    </td>
  );
}

function ColWidth({ width }: { width: number | undefined }) {
  const ref = useRef<HTMLTableColElement>(null);
  useStyleVars(ref, width === undefined ? {} : { "--col-width": `${width}px` });
  return <col ref={ref} className={width === undefined ? undefined : "vt__col--fixed"} />;
}

/** The cell of the column a row click reads: its value as a button, the row's keyboard way. */
function PickCell({
  column,
  raw,
  label,
  language,
  timeZone,
  colIndex,
}: {
  column: Column;
  raw: unknown;
  label: string;
  language: string;
  timeZone: string | null;
  colIndex: number | undefined;
}) {
  const { field, options } = column;
  const display =
    Object.keys(options).length === 0
      ? null
      : displayValue(raw, field.type, options, language, column.range, timeZone);
  const text =
    display === null ? formatValue(field.type, raw, language, timeZone) : displayText(display);
  return (
    <td className={`vt__cell vt__cell--${field.type}`} aria-colindex={colIndex}>
      {/* The click reaches the row, which sets the variable. */}
      <button type="button" className="value-pick truncate" aria-label={label} title={text}>
        {text}
      </button>
    </td>
  );
}

function FrameTable({
  frame,
  title,
  config,
  options,
}: {
  frame: Frame;
  title: string;
  config: FieldConfig;
  options: TableOptions;
}) {
  const { t, language, timeZone } = useI18n();
  const clicked = useClickVariable(options.variable);
  const filterId = useId();
  const scrollRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLTableRowElement>(null);
  const bottomRef = useRef<HTMLTableRowElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const { width, height } = useElementSize(scrollRef);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  // The column focus is in (a sort button, a filter, a value): it stays rendered while the table
  // scrolls, and so do its neighbours, so Tab and Shift+Tab reach the next column.
  const [focusedColumn, setFocusedColumn] = useState<number | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  const [filterTexts, setFilterTexts] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const columns = columnsOf(frame, config);
  const filters = options.columnFilters
    ? columns.map((c, i) => parseFilter(filterTexts[i] ?? "", c.field, c.options))
    : [];
  const order = filterRows(frame, sortedRows(frame, sort), filters);
  const total = order.length;
  const headerRows = options.columnFilters ? 2 : 1;

  let start: number;
  let end: number;
  const pages = Math.max(1, Math.ceil(total / options.pageSize));
  const currentPage = Math.min(page, pages - 1);
  if (options.pagination) {
    start = currentPage * options.pageSize;
    end = Math.min(total, start + options.pageSize);
  } else {
    const visible = Math.ceil(height / ROW_HEIGHT);
    start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    end = Math.min(total, start + visible + 2 * OVERSCAN);
  }

  useStyleVars(scrollRef, { "--vt-row-height": `${ROW_HEIGHT}px` });
  useStyleVars(topRef, { "--vt-spacer": `${options.pagination ? 0 : start * ROW_HEIGHT}px` });
  useStyleVars(bottomRef, {
    "--vt-spacer": `${options.pagination ? 0 : (total - end) * ROW_HEIGHT}px`,
  });

  // A very wide table renders only the columns in view, plus the first one, which stays put.
  const widths = columns.map((column) => column.options.width ?? COLUMN_WIDTH);
  const view =
    columns.length >= VIRTUAL_COLUMNS_FROM ? columnWindow(widths, scrollLeft, width) : null;
  const shown =
    view === null
      ? columns.map((_, index) => index)
      : shownColumns(view, focusedColumn, columns.length);
  // The room of the columns out of view: one empty cell after each shown column a gap follows.
  const gaps = view === null ? new Map<number, number>() : columnGaps(shown, widths);
  const colIndex = (index: number) => (view === null ? undefined : index + 1);
  /** The row's cells (one per shown column, in order), with an empty cell in each gap. */
  const spaced = (cells: ReactNode[]): ReactNode[] =>
    view === null
      ? cells
      : shown.flatMap((index, at) =>
          gaps.has(index)
            ? [cells[at], <td key={`gap-${index}`} className="vt__hspacer" aria-hidden="true" />]
            : [cells[at]],
        );
  useStyleVars(tableRef, view === null ? {} : { "--vt-table-width": `${view.total}px` });

  const picked = clicked.variable === null ? -1 : pickColumn(columns, options.variableColumn);
  const pickedField = columns[picked]?.field;

  const rows: ReactNode[] = [];
  for (let position = start; position < end; position++) {
    const row = order[position] as number;
    const cells = shown.map((index) => {
      const column = columns[index] as Column;
      return index === picked ? (
        <PickCell
          key={index}
          column={column}
          raw={column.field.values[row]}
          label={t("panels.variable.setTo", {
            name: clicked.variable ?? "",
            value: variableText(column.field.values[row]) ?? "",
          })}
          language={language}
          timeZone={timeZone}
          colIndex={colIndex(index)}
        />
      ) : (
        <Cell
          key={index}
          column={column}
          raw={column.field.values[row]}
          language={language}
          timeZone={timeZone}
          colIndex={colIndex(index)}
        />
      );
    });
    rows.push(
      pickedField === undefined ? (
        <tr key={row} className="vt__row" aria-rowindex={position + headerRows + 1}>
          {spaced(cells)}
        </tr>
      ) : (
        <tr
          key={row}
          className="vt__row vt__row--pick"
          aria-rowindex={position + headerRows + 1}
          onClick={() => clicked.click(variableText(pickedField.values[row]))}
        >
          {spaced(cells)}
        </tr>
      ),
    );
  }

  return (
    <div className="table-panel__body">
      <section
        className="vt"
        ref={scrollRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs focus to scroll by keyboard
        tabIndex={0}
        aria-label={title}
        onFocus={(event) => {
          const cell =
            event.target instanceof Element ? event.target.closest("[aria-colindex]") : null;
          const place = Number(cell?.getAttribute("aria-colindex"));
          setFocusedColumn(Number.isInteger(place) && place > 0 ? place - 1 : null);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node && event.currentTarget.contains(next))) {
            setFocusedColumn(null);
          }
        }}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
          if (view !== null) {
            setScrollLeft(event.currentTarget.scrollLeft);
          }
        }}
      >
        <table
          ref={tableRef}
          className={view === null ? "vt__table" : "vt__table vt__table--columns"}
          aria-rowcount={total + headerRows}
          aria-colcount={view === null ? undefined : columns.length}
        >
          <colgroup>
            {view === null
              ? columns.map((column, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: one per column, in order
                  <ColWidth key={index} width={column.options.width} />
                ))
              : shown.flatMap((index) => {
                  const gap = gaps.get(index);
                  const col = <ColWidth key={index} width={widths[index]} />;
                  return gap === undefined
                    ? [col]
                    : [col, <ColWidth key={`gap-${index}`} width={gap} />];
                })}
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              {spaced(
                shown.map((index) => {
                  const column = columns[index] as Column;
                  const direction = sort?.column === index ? sort.direction : undefined;
                  return (
                    <th
                      key={index}
                      scope="col"
                      className={`vt__head vt__cell--${column.field.type}`}
                      aria-sort={direction ?? "none"}
                      aria-colindex={colIndex(index)}
                    >
                      <button
                        type="button"
                        className="vt__sort"
                        onClick={() => setSort(nextSort(sort, index))}
                        title={t("dashboards.panels.sortBy", { column: column.name })}
                      >
                        <span className="truncate" title={column.name}>
                          {column.name}
                        </span>
                        <span className="vt__sort-mark" aria-hidden="true">
                          {direction === "ascending" ? (
                            <Icon name="chevronUp" className="icon--inline" />
                          ) : direction === "descending" ? (
                            <Icon name="chevronDown" className="icon--inline" />
                          ) : null}
                        </span>
                      </button>
                    </th>
                  );
                }),
              )}
            </tr>
            {options.columnFilters ? (
              <tr aria-rowindex={2}>
                {spaced(
                  shown.map((index) => {
                    const column = columns[index] as Column;
                    return (
                      <td key={index} className="vt__filter" aria-colindex={colIndex(index)}>
                        <label className="visually-hidden" htmlFor={`${filterId}-${index}`}>
                          {t("panels.table.filterColumn", { column: column.name })}
                        </label>
                        <input
                          id={`${filterId}-${index}`}
                          className="input vt__filter-input"
                          value={filterTexts[index] ?? ""}
                          placeholder={t("panels.table.filterPlaceholder")}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setFilterTexts((texts) => {
                              const next = [...texts];
                              next[index] = value;
                              return next;
                            });
                            setPage(0);
                          }}
                        />
                      </td>
                    );
                  }),
                )}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {/* Spacers hold the height of the rows out of view; they are not rows to read. */}
            {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an empty spacer, not a row */}
            <tr className="vt__spacer" ref={topRef} role="presentation">
              <td colSpan={view === null ? columns.length : shown.length + gaps.size} />
            </tr>
            {rows}
            {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an empty spacer, not a row */}
            <tr className="vt__spacer" ref={bottomRef} role="presentation">
              <td colSpan={view === null ? columns.length : shown.length + gaps.size} />
            </tr>
          </tbody>
        </table>
      </section>
      <div className="live-region" role="status">
        {options.columnFilters && total === 0 && rowCount(frame) > 0 ? (
          <p className="panel-note">{t("panels.table.noMatch")}</p>
        ) : null}
        {clicked.variable !== null && picked < 0 ? (
          <p className="panel-note">
            {t("panels.variable.noColumn", { column: options.variableColumn })}
          </p>
        ) : null}
      </div>
      {clicked.variable === null ? null : (
        <p className="visually-hidden" role="status" aria-live="polite">
          {clicked.announcement}
        </p>
      )}
      {options.pagination && total > 0 ? (
        <nav className="vt__pages" aria-label={t("panels.table.pages")}>
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {t("panels.table.previous")}
          </button>
          <span className="vt__page" aria-live="polite">
            {t("panels.table.pageOf", { page: currentPage + 1, pages })}
          </span>
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={currentPage >= pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            {t("panels.table.next")}
          </button>
        </nav>
      ) : null}
    </div>
  );
}

function TablePanel({
  frames,
  title,
  options,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<TableOptions>) {
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
          <Select id={selectId} value={index} onChange={(next) => setIndex(Number(next))}>
            {frames.map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: one entry per result, in order
              <option key={i} value={i}>
                {t("dashboards.panels.resultNumber", { number: i + 1 })}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <FrameTable key={index} frame={frame} title={title} config={fieldConfig} options={options} />
    </div>
  );
}

function TableEditor({ options, onChange }: PanelEditorProps<TableOptions>) {
  const { t } = useI18n();
  const host = usePanelHost();
  const variableId = useId();
  const texts = useClickOptionTexts(
    t("panels.variable.triggerTable"),
    t("panels.variable.column"),
    t("panels.variable.columnHint"),
  );
  return (
    <>
      <p className="field__hint">{t("dashboards.panels.tableHint")}</p>
      <CheckboxField
        label={t("panels.table.columnFilters")}
        checked={options.columnFilters}
        onChange={(columnFilters) => onChange({ ...options, columnFilters })}
      />
      <CheckboxField
        label={t("panels.table.pagination")}
        checked={options.pagination}
        onChange={(pagination) => onChange({ ...options, pagination })}
      />
      {options.pagination ? (
        <NumberField
          label={t("panels.table.pageSize")}
          value={options.pageSize}
          min={MIN_PAGE_SIZE}
          max={MAX_PAGE_SIZE}
          step={1}
          onChange={(pageSize) =>
            pageSize !== undefined && Number.isInteger(pageSize)
              ? onChange({ ...options, pageSize })
              : undefined
          }
        />
      ) : null}
      <ClickVariableOptions
        id={variableId}
        names={host.variables?.names ?? []}
        variable={options.variable}
        source={options.variableColumn}
        texts={texts}
        maxLength={MAX_COLUMN_CHARS}
        onChange={(patch) =>
          onChange(
            parseTableOptions({
              ...options,
              ...(patch.variable === undefined ? {} : { variable: patch.variable }),
              ...(patch.source === undefined ? {} : { variableColumn: patch.source }),
            }),
          )
        }
      />
    </>
  );
}

export const tablePanel: PanelPlugin<TableOptions> = {
  type: "table",
  name: "dashboards.panels.table",
  description: "panels.describe.table",
  shapes: ["frame"],
  options: parseTableOptions,
  Panel: TablePanel,
  Editor: TableEditor,
  fieldOptions: ["standard", "range", "thresholds", "mappings", "color", "table", "overrides"],
  Preview: TablePreview,
};
