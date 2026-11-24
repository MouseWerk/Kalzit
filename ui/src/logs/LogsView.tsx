import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { DocumentSet, Frame } from "../api/generated/shapes";
import { IconButton } from "../components/IconButton";
import { Select } from "../components/Select";
import { useI18n } from "../i18n/i18n";
import { type FilterMode, type FilterOutcome, filterQuery, filtersKind } from "./filters";
import { fullTime, lineTime } from "./format";
import { LogsVolume } from "./LogsVolume";
import type { Level } from "./levels";
import {
  DEDUP_MODES,
  dedupe,
  fieldPaths,
  type LogField,
  type LogFieldChoice,
  type LogGroup,
  type LogLine,
  type LogSource,
  logSourceOf,
  MAX_JSON_CHARS,
  type ResolvedFields,
  resolveFields,
  sortLines,
  toLogLines,
  valueShare,
  WHOLE_DOCUMENT,
} from "./model";
import {
  type LogViewPrefs,
  readFieldChoice,
  readViewPrefs,
  TIME_FORMATS,
  writeFieldChoice,
  writeViewPrefs,
} from "./prefs";
import { type Volume, volumeFromFrame, volumeFromLines, volumeStep } from "./volume";
import "./logs.css";

/**
 * The logs view of Explore (board Logs.dc.html, frames 1 to 4): the volume by level over the
 * range, a bar that changes only the view, and the lines with time, level and text. A line opens
 * in place with its labels and fields; "Filter for" and "Filter out" change the query visibly and
 * run it. The documents are never changed: the view reads them by the field mapping it shows.
 *
 * Extension points for the next steps (a panel type, live tail, "Show context"): the view takes
 * its documents, volume and actions as props and keeps no state of the page, so a panel can host
 * it with stored options in place of the browser's.
 */

/** The count query's state as the page ran it (Loki), or "none" where the source has none. */
export type VolumeAnswer =
  | { state: "none" }
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "ready"; frame: Frame };

export interface LogsViewProps {
  kind: string;
  datasourceId: string;
  /** The query's documents, the pages loaded so far included. */
  documents: DocumentSet;
  range: { from: number; to: number };
  volume: VolumeAnswer;
  /** The query in the editor, which filters are added to. */
  query: unknown;
  /** The time field of an Elasticsearch or OpenSearch query or source. */
  timeField?: string | undefined;
  /** Puts a changed query into the editor and runs it; absent where the view may not. */
  onQuery?: ((next: unknown) => void) | undefined;
  /** Text still waiting in a field of the editor: filters wait for it. */
  draftPending?: boolean;
  onRange?: ((from: number, to: number) => void) | undefined;
  /** Asks for the oldest lines first, where more lines are in the range than loaded. */
  onOrder?: ((order: "newest" | "oldest") => void) | undefined;
  /** Which end of the range the source answered: its newest lines (default) or its oldest. */
  sourceOrder?: "newest" | "oldest";
}

/** Lines drawn at first; more follow as the list is scrolled to its end (frame 14). */
const PAGE = 200;
/** A line shows at most this much text; the rest is behind "Show the whole line". */
const MAX_LINE_CHARS = 10_000;

export function LogsView(props: LogsViewProps) {
  const { kind, datasourceId, documents, range, volume } = props;
  const { t, language, timeZone } = useI18n();
  const number = new Intl.NumberFormat(language);
  const source: LogSource = logSourceOf(kind);
  const [prefs, setPrefs] = useState<LogViewPrefs>(readViewPrefs);
  const [choice, setChoice] = useState<LogFieldChoice>(() => readFieldChoice(datasourceId));
  const [hidden, setHidden] = useState<Set<Level>>(new Set());
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const fieldsId = useId();

  function update(patch: Partial<LogViewPrefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writeViewPrefs(next);
  }

  function choose(patch: LogFieldChoice) {
    const next: LogFieldChoice = { ...choice, ...patch };
    for (const key of ["time", "text", "level"] as const) {
      if (next[key] === undefined || next[key] === "") delete next[key];
    }
    setChoice(next);
    writeFieldChoice(datasourceId, next);
  }

  const fields = useMemo(
    () => resolveFields(source, documents.documents, choice, props.timeField),
    [source, documents.documents, choice, props.timeField],
  );
  const lines = useMemo(
    () => toLogLines(documents.documents, source, fields),
    [documents.documents, source, fields],
  );
  const sorted = useMemo(() => sortLines(lines, prefs.order), [lines, prefs.order]);
  const visible = useMemo(
    () => (hidden.size === 0 ? sorted : sorted.filter((line) => !hidden.has(line.level))),
    [sorted, hidden],
  );
  const groups = useMemo(() => dedupe(visible, prefs.dedup), [visible, prefs.dedup]);
  const shownVolume: Volume = useMemo(() => {
    const step = volumeStep(range.to - range.from);
    return volume.state === "ready"
      ? volumeFromFrame(volume.frame, range, step)
      : volumeFromLines(lines, range, step);
  }, [volume, lines, range]);
  const paths = useMemo(() => fieldPaths(documents.documents), [documents.documents]);
  const truncated = documents.truncated !== undefined || documents.nextCursor !== undefined;
  const noLevel = lines.length > 0 && lines.every((line) => line.levelRaw === null);
  const canFilter = props.onQuery !== undefined && filtersKind(kind) && fieldsReady(fields, source);

  function filter(field: LogField, mode: FilterMode, line: LogLine) {
    if (props.onQuery === undefined) return;
    if (props.draftPending === true) {
      setProblem(t("documents.filter.refused.draft"));
      return;
    }
    const next: FilterOutcome = filterQuery(kind, props.query, field, mode, line.json !== null);
    if ("refused" in next) {
      setProblem(t(`logs.filter.refused.${next.refused}`));
      return;
    }
    setProblem(null);
    props.onQuery(next.query);
  }

  function setOrder(order: "newest" | "oldest") {
    update({ order });
    // More lines in the range than loaded: the oldest ones come from the source, not the list.
    if (truncated && props.onOrder !== undefined) {
      props.onOrder(order);
    }
  }

  function toggleColumn(key: string) {
    update({
      columns: prefs.columns.includes(key)
        ? prefs.columns.filter((c) => c !== key)
        : [...prefs.columns, key].slice(0, 8),
    });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t("logs.copied"));
    } catch {
      setStatus(t("logs.copyFailed"));
    }
  }

  // Without a text field the view asks once and shows nothing wrong meanwhile (frame 10).
  const askText = source !== "loki" && fields.text === null;
  const volumeNote =
    volume.state === "loading"
      ? t("logs.volume.counting")
      : volume.state === "failed"
        ? t("logs.volume.failed", { reason: volume.message })
        : null;
  const oldest = sorted.reduce<number | null>(
    (min, line) =>
      line.timeMs === null ? min : min === null ? line.timeMs : Math.min(min, line.timeMs),
    null,
  );

  return (
    <div className="logs">
      {askText ? null : (
        <LogsVolume
          volume={shownVolume}
          loaded={lines.length}
          note={volumeNote}
          hidden={hidden}
          onLevels={setHidden}
          onRange={props.onRange}
        />
      )}
      <div className="logs__bar" role="toolbar" aria-label={t("logs.bar")}>
        <fieldset className="logs__seg">
          <legend className="visually-hidden">{t("logs.order.label")}</legend>
          {(["newest", "oldest"] as const).map((order) => (
            <button
              key={order}
              type="button"
              aria-pressed={prefs.order === order}
              onClick={() => setOrder(order)}
            >
              {t(`logs.order.${order}`)}
            </button>
          ))}
        </fieldset>
        <div className="preference">
          <label htmlFor={`${fieldsId}-time`}>{t("logs.time.label")}</label>
          <Select
            id={`${fieldsId}-time`}
            value={prefs.time}
            onChange={(next) => update({ time: next as LogViewPrefs["time"] })}
          >
            {TIME_FORMATS.map((format) => (
              <option key={format} value={format}>
                {t(`logs.time.${format}`)}
              </option>
            ))}
          </Select>
        </div>
        <button
          type="button"
          className="button button--secondary button--small"
          aria-pressed={prefs.wrap}
          onClick={() => update({ wrap: !prefs.wrap })}
        >
          {t("logs.wrap")}
        </button>
        <button
          type="button"
          className="button button--secondary button--small"
          aria-pressed={prefs.prettify}
          onClick={() => update({ prettify: !prefs.prettify })}
        >
          {t("logs.prettify")}
        </button>
        <div className="preference">
          <label htmlFor={`${fieldsId}-dedup`}>{t("logs.dedup.label")}</label>
          <Select
            id={`${fieldsId}-dedup`}
            value={prefs.dedup}
            onChange={(next) => update({ dedup: next as LogViewPrefs["dedup"] })}
          >
            {DEDUP_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`logs.dedup.${mode}`)}
              </option>
            ))}
          </Select>
        </div>
        <button
          type="button"
          className="button button--secondary button--small"
          aria-expanded={fieldsOpen || askText}
          aria-controls={`${fieldsId}-fields`}
          onClick={() => setFieldsOpen(!fieldsOpen)}
        >
          {t("logs.fields.button")}
        </button>
      </div>
      {fieldsOpen || askText ? (
        <FieldChoice
          id={`${fieldsId}-fields`}
          fields={fields}
          source={source}
          paths={paths}
          ask={askText}
          onChoose={choose}
        />
      ) : null}
      {noLevel && !askText ? <p className="logs__tip">{t("logs.noLevel")}</p> : null}
      {/* A remembered "Oldest first" on a cut result of the newest lines: said, not hidden. */}
      {truncated &&
      prefs.order === "oldest" &&
      (props.sourceOrder ?? "newest") === "newest" &&
      lines.length > 0 ? (
        <p className="logs__tip">
          {t("logs.order.newestLoaded", { count: number.format(lines.length) })}{" "}
          {props.onOrder === undefined ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => props.onOrder?.("oldest")}
            >
              {t("logs.order.loadOldest")}
            </button>
          )}
        </p>
      ) : null}
      {problem === null ? null : (
        <p className="field__error" role="alert">
          {problem}
        </p>
      )}
      {askText ? null : lines.length === 0 ? (
        <div className="logs__empty">
          <h3>{t("logs.empty.title")}</h3>
          <p>{t("logs.empty.text")}</p>
        </div>
      ) : (
        <LineList
          groups={groups}
          lines={lines}
          prefs={prefs}
          canFilter={canFilter}
          onFilter={filter}
          onColumn={toggleColumn}
          onCopy={(text) => void copy(text)}
        />
      )}
      <p className="logs__status">
        {prefs.dedup !== "none" && groups.length !== visible.length
          ? t("logs.status.merged", {
              count: number.format(lines.length),
              shown: number.format(groups.length),
            })
          : t("logs.status.count", { count: number.format(lines.length) })}
        {hidden.size > 0 && visible.length < lines.length
          ? ` · ${t("logs.status.hidden", { count: number.format(lines.length - visible.length) })}`
          : ""}
      </p>
      {truncated && lines.length > 0 ? (
        <p className="logs__limit">
          {oldest === null
            ? t("logs.status.limitPlain", { count: number.format(lines.length) })
            : t("logs.status.limit", {
                count: number.format(lines.length),
                time: lineTime(oldest, "date", language, timeZone, t),
              })}
        </p>
      ) : null}
      <p className="visually-hidden" role="status">
        {status}
      </p>
    </div>
  );
}

/** Whether the view has what it needs to show lines (the text field may still be asked for). */
function fieldsReady(fields: ResolvedFields, source: LogSource): boolean {
  return source === "loki" || fields.text !== null;
}

function FieldChoice({
  id,
  fields,
  source,
  paths,
  ask,
  onChoose,
}: {
  id: string;
  fields: ResolvedFields;
  source: LogSource;
  paths: string[];
  ask: boolean;
  onChoose: (patch: LogFieldChoice) => void;
}) {
  const { t } = useI18n();
  const auto = (path: string | null | undefined, none: string) =>
    path === null || path === undefined ? none : t("logs.fields.auto", { path });
  const rows: { key: "time" | "text" | "level"; label: string; value: string; autoText: string }[] =
    [
      {
        key: "time",
        label: t("logs.fields.time"),
        value: fields.auto.time ? "" : (fields.time ?? ""),
        autoText: auto(fields.time, t("logs.fields.autoNone")),
      },
      {
        key: "text",
        label: t("logs.fields.text"),
        value: fields.auto.text ? "" : (fields.text ?? ""),
        autoText: auto(
          fields.text === WHOLE_DOCUMENT ? t("logs.fields.whole") : fields.text,
          t("logs.fields.autoNone"),
        ),
      },
      {
        key: "level",
        label: t("logs.fields.level"),
        value: fields.auto.level ? "" : (fields.levels[0] ?? ""),
        autoText:
          source === "loki"
            ? t("logs.fields.autoLoki")
            : auto(fields.levels[0], t("logs.fields.autoText")),
      },
    ];
  return (
    <section id={id} className="logs__fields" aria-label={t("logs.fields.title")}>
      {ask ? (
        <div className="logs__ask">
          <h3>{t("logs.fields.askTitle")}</h3>
          <p>
            {fields.time === null
              ? t("logs.fields.askTextNoTime")
              : t("logs.fields.askText", { time: fields.time })}
          </p>
        </div>
      ) : (
        <p className="field__hint">{t("logs.fields.lead")}</p>
      )}
      <div className="logs__field-row">
        {rows.map((row) => (
          <div key={row.key} className="field">
            <label className="field__label" htmlFor={`${id}-${row.key}`}>
              {row.label}
            </label>
            <Select
              id={`${id}-${row.key}`}
              value={row.value}
              onChange={(next) => onChoose({ [row.key]: next === "" ? undefined : next })}
            >
              <option value="">{row.autoText}</option>
              {row.key === "text" ? (
                <option value={WHOLE_DOCUMENT}>{t("logs.fields.whole")}</option>
              ) : null}
              {paths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
    </section>
  );
}

function LineList({
  groups,
  lines,
  prefs,
  canFilter,
  onFilter,
  onColumn,
  onCopy,
}: {
  groups: LogGroup[];
  lines: LogLine[];
  prefs: LogViewPrefs;
  canFilter: boolean;
  onFilter: (field: LogField, mode: FilterMode, line: LogLine) => void;
  onColumn: (key: string) => void;
  onCopy: (text: string) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => Date.now(), []);

  // Rows: each group's first line, and its other lines where the group is unfolded.
  const rows = useMemo(() => {
    const out: { line: LogLine; count: number; member: boolean }[] = [];
    for (const group of groups) {
      out.push({ line: group.line, count: group.members.length, member: false });
      if (group.members.length > 1 && expanded.has(group.line.id)) {
        for (const line of group.members.slice(1)) out.push({ line, count: 1, member: true });
      }
    }
    return out;
  }, [groups, expanded]);
  const drawn = rows.slice(0, shown);

  useEffect(() => {
    const end = endRef.current;
    if (end === null || shown >= rows.length || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setShown((count) => count + PAGE);
      }
    });
    observer.observe(end);
    return () => observer.disconnect();
  }, [shown, rows.length]);

  function focusRow(index: number) {
    const clamped = Math.max(0, Math.min(drawn.length - 1, index));
    setActive(clamped);
    listRef.current?.querySelector<HTMLElement>(`[data-row="${clamped}"]`)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>, index: number, line: LogLine) {
    if (event.target !== event.currentTarget) return;
    switch (event.key) {
      case "ArrowDown":
        focusRow(index + 1);
        break;
      case "ArrowUp":
        focusRow(index - 1);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(drawn.length - 1);
        break;
      case "Enter":
      case " ":
        setOpen(open === line.id ? null : line.id);
        break;
      case "Escape":
        if (open === null) return;
        setOpen(null);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const showTime = prefs.time !== "off";
  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: the list of lines is a grid of rows */}
      <div
        ref={listRef}
        className={prefs.wrap ? "logs__list logs__list--wrap" : "logs__list"}
        role="grid"
        aria-label={t("logs.list")}
        aria-rowcount={rows.length}
      >
        {drawn.map(({ line, count, member }, index) => {
          const isOpen = open === line.id;
          const columns = prefs.columns.map(
            (key) =>
              [...line.labels, ...line.fields].find((field) => field.key === key)?.text ?? "",
          );
          return (
            // biome-ignore lint/a11y/useSemanticElements: a row of the grid
            <div
              key={`${line.id}-${member ? "m" : "g"}`}
              className={isOpen ? "logs__row logs__row--open" : "logs__row"}
              role="row"
              aria-rowindex={index + 1}
              aria-expanded={isOpen}
              tabIndex={index === active ? 0 : -1}
              data-row={index}
              data-member={member ? "" : undefined}
              onClick={(event) => {
                // Clicks inside the open details act there; only the line itself opens and closes.
                if ((event.target as Element).closest(".logs__details") !== null) return;
                setActive(index);
                setOpen(isOpen ? null : line.id);
              }}
              onKeyDown={(event) => onKeyDown(event, index, line)}
            >
              {showTime ? (
                // biome-ignore lint/a11y/useSemanticElements: a cell of the grid
                <span className="logs__time" role="gridcell" tabIndex={-1}>
                  {lineTime(line.timeMs, prefs.time, language, timeZone, t, now)}
                </span>
              ) : null}
              {/* biome-ignore lint/a11y/useSemanticElements: a cell of the grid */}
              <span className="logs__level" role="gridcell" tabIndex={-1}>
                <LevelMark level={line.level} />
              </span>
              {columns.map((value, column) => (
                // biome-ignore lint/a11y/useSemanticElements: a cell of the grid
                <span
                  key={prefs.columns[column]}
                  className="logs__column"
                  role="gridcell"
                  tabIndex={-1}
                >
                  {value}
                </span>
              ))}
              {/* biome-ignore lint/a11y/useSemanticElements: a cell of the grid */}
              <span className="logs__text" role="gridcell" tabIndex={-1}>
                <LineText line={line} prettify={prefs.prettify} />
                {count > 1 ? (
                  <button
                    type="button"
                    className="logs__count"
                    aria-expanded={expanded.has(line.id)}
                    onClick={(event) => {
                      event.stopPropagation();
                      const next = new Set(expanded);
                      if (next.has(line.id)) next.delete(line.id);
                      else next.add(line.id);
                      setExpanded(next);
                    }}
                  >
                    ×{count}
                    <span className="visually-hidden">{t("logs.dedup.same", { count })}</span>
                  </button>
                ) : null}
              </span>
              {isOpen ? (
                // biome-ignore lint/a11y/useSemanticElements: the open line's details, one cell of the grid
                <div className="logs__details-cell" role="gridcell" tabIndex={-1}>
                  <LineDetails
                    line={line}
                    lines={lines}
                    columns={prefs.columns}
                    canFilter={canFilter}
                    onFilter={onFilter}
                    onColumn={onColumn}
                    onCopy={onCopy}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {shown < rows.length ? (
        <div ref={endRef} className="logs__more">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => setShown(shown + PAGE)}
          >
            {t("logs.showMore", { count: Math.min(PAGE, rows.length - shown) })}
          </button>
        </div>
      ) : null}
    </>
  );
}

export function LevelMark({ level }: { level: Level }) {
  const { t } = useI18n();
  return (
    <span className="logs-level" data-level={level}>
      <span className="logs-level__dot" data-level={level} aria-hidden="true" />
      {t(`logs.level.${level}`)}
    </span>
  );
}

function LineText({ line, prettify }: { line: LogLine; prettify: boolean }) {
  const { t } = useI18n();
  const [whole, setWhole] = useState(false);
  if (prettify && line.json !== null) {
    return <pre className="logs__json">{JSON.stringify(line.json, null, 2)}</pre>;
  }
  const long = line.text.length > MAX_LINE_CHARS;
  return (
    <>
      <span className="logs__message" title={line.text.length > 200 ? undefined : line.text}>
        {long && !whole ? `${line.text.slice(0, MAX_LINE_CHARS)}…` : line.text}
      </span>
      {prettify &&
      line.json === null &&
      line.text.trim().startsWith("{") &&
      line.text.length > MAX_JSON_CHARS ? (
        <span className="logs__hint">{t("logs.prettifyTooBig")}</span>
      ) : null}
      {long && !whole ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={(event) => {
            event.stopPropagation();
            setWhole(true);
          }}
        >
          {t("logs.wholeLine")}
        </button>
      ) : null}
    </>
  );
}

function LineDetails({
  line,
  lines,
  columns,
  canFilter,
  onFilter,
  onColumn,
  onCopy,
}: {
  line: LogLine;
  lines: LogLine[];
  columns: string[];
  canFilter: boolean;
  onFilter: (field: LogField, mode: FilterMode, line: LogLine) => void;
  onColumn: (key: string) => void;
  onCopy: (text: string) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 0 });
  const groups: { title: string; fields: LogField[] }[] = [
    { title: t("logs.labels"), fields: line.labels },
    {
      title: line.fields[0]?.origin === "line" ? t("logs.lineFields") : t("logs.docFields"),
      fields: line.fields,
    },
  ];
  return (
    <section className="logs__details" aria-label={t("logs.details")}>
      <div className="logs__details-head">
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => onCopy(line.text)}
        >
          {t("logs.copyLine")}
        </button>
        {line.timeMs === null ? null : (
          <span className="logs__full-time">{fullTime(line.timeMs, language, timeZone)}</span>
        )}
        {line.levelRaw === null ? null : (
          <span className="logs__full-time">{t("logs.levelRaw", { value: line.levelRaw })}</span>
        )}
      </div>
      {groups
        .filter((group) => group.fields.length > 0)
        .map((group) => (
          <div key={group.title} className="logs__group">
            <h4 className="logs__group-title">{group.title}</h4>
            <table className="logs__fields-table">
              <tbody>
                {group.fields.map((field) => {
                  const share = valueShare(lines, field);
                  const label = { key: field.key, value: field.text };
                  return (
                    <tr key={`${field.origin}-${field.path}`}>
                      <th scope="row">{field.key}</th>
                      <td className="logs__value">{field.text}</td>
                      <td className="logs__share" title={t("logs.shareHint")}>
                        {percent.format(share)}
                      </td>
                      <td className="logs__actions">
                        {canFilter ? (
                          <>
                            <IconButton
                              icon="zoomIn"
                              label={t("logs.filterFor", label)}
                              onClick={() => onFilter(field, "include", line)}
                            />
                            <IconButton
                              icon="zoomOut"
                              label={t("logs.filterOut", label)}
                              onClick={() => onFilter(field, "exclude", line)}
                            />
                          </>
                        ) : null}
                        <IconButton
                          icon="table"
                          label={
                            columns.includes(field.key)
                              ? t("logs.hideColumn", { key: field.key })
                              : t("logs.showColumn", { key: field.key })
                          }
                          aria-pressed={columns.includes(field.key)}
                          onClick={() => onColumn(field.key)}
                        />
                        <IconButton
                          icon="copy"
                          label={t("logs.copyValue", { key: field.key })}
                          onClick={() => onCopy(field.text)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </section>
  );
}
