import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { formatDuration, type TraceSummary } from "./model";
import type { TraceColumn } from "./options";
import { cssVars } from "./vars";
import "./trace.css";

type SortKey = "duration" | "start";

/** A clock time with milliseconds, in the time zone in effect. */
export function clockTime(ms: number, language: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    ...(timeZone === null ? {} : { timeZone }),
  }).format(ms);
}

function dayTime(ms: number, language: string, timeZone: string | null, timeOnly = false): string {
  return new Intl.DateTimeFormat(language, {
    ...(timeOnly ? {} : { dateStyle: "short" as const }),
    timeStyle: "medium",
    ...(timeZone === null ? {} : { timeZone }),
  }).format(ms);
}

/**
 * The traces of a result, one row each (board frame 1): the slowest first, with duration over
 * time above. A status is shown only when the source counted errors; nothing is guessed.
 */
export function TraceList({
  rows,
  columns,
  chart,
  title,
  selected,
  onPick,
}: {
  rows: readonly TraceSummary[];
  columns: readonly TraceColumn[];
  chart: boolean;
  /** Accessible name of the table: the panel's title. */
  title: string;
  /** The trace the rest of the page shows (a variable's value), marked in the list. */
  selected?: string | undefined;
  onPick?: ((row: TraceSummary) => void) | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({
    key: "duration",
    down: true,
  });
  const sorted = [...rows].sort((a, b) =>
    sort.down ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key],
  );
  const longest = rows.reduce((max, row) => Math.max(max, row.duration), 0);
  const has = (column: TraceColumn) => columns.includes(column);
  const known = {
    spans: rows.some((row) => row.spans !== undefined),
    services: rows.some((row) => row.services !== undefined),
    status: rows.some((row) => row.errors !== undefined),
  };
  // `trace-list__extra`: a column a narrow list leaves out (trace.css).
  const sortHead = (key: SortKey, label: string, extra = false) => (
    <th
      scope="col"
      className={extra ? "trace-list__num trace-list__extra" : "trace-list__num"}
      aria-sort={sort.key === key ? (sort.down ? "descending" : "ascending") : undefined}
    >
      <button
        type="button"
        className="trace-list__sort target-pad"
        onClick={() => setSort({ key, down: sort.key === key ? !sort.down : true })}
      >
        {label}
        {sort.key === key ? <Icon name={sort.down ? "arrowDown" : "arrowUp"} /> : null}
      </button>
    </th>
  );
  return (
    <>
      {chart && rows.length > 1 ? <DurationChart rows={rows} errorsKnown={known.status} /> : null}
      <div className="trace-list">
        <table className="trace-list__table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("traces.col.id")}</th>
              {has("root") ? (
                <th scope="col" className="trace-list__root-cell">
                  {t("traces.name")}
                </th>
              ) : null}
              {has("spans") && known.spans ? (
                <th scope="col" className="trace-list__num trace-list__extra">
                  {t("traces.col.spans")}
                </th>
              ) : null}
              {has("services") && known.services ? (
                <th scope="col" className="trace-list__num trace-list__extra">
                  {t("traces.col.services")}
                </th>
              ) : null}
              {has("duration") ? sortHead("duration", t("traces.duration")) : null}
              {has("start") ? sortHead("start", t("traces.start"), true) : null}
              {has("status") && known.status ? <th scope="col">{t("traces.status")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const failed = (row.errors ?? 0) > 0;
              return (
                <tr
                  key={row.traceId}
                  className={onPick === undefined ? undefined : "trace-list__row"}
                  aria-current={selected === row.traceId ? "true" : undefined}
                  onClick={onPick === undefined ? undefined : () => onPick(row)}
                >
                  <td>
                    {onPick === undefined ? (
                      <span className="trace-mono" title={row.traceId}>
                        {row.traceId.slice(0, 8)}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="trace-list__id target-pad"
                        title={row.traceId}
                        aria-label={t("traces.open", { id: row.traceId.slice(0, 8) })}
                        onClick={(event) => {
                          event.stopPropagation();
                          onPick(row);
                        }}
                      >
                        {row.traceId.slice(0, 8)}
                      </button>
                    )}
                  </td>
                  {has("root") ? (
                    <td className="trace-list__root-cell">
                      <span className="trace-list__root">
                        <span className="trace-list__service">{row.rootService}</span>
                        <span className="trace-list__operation" title={row.rootOperation}>
                          {row.rootOperation}
                        </span>
                      </span>
                    </td>
                  ) : null}
                  {has("spans") && known.spans ? (
                    <td className="trace-list__num trace-list__extra">{row.spans ?? ""}</td>
                  ) : null}
                  {has("services") && known.services ? (
                    <td className="trace-list__num trace-list__extra">{row.services ?? ""}</td>
                  ) : null}
                  {has("duration") ? (
                    <td>
                      <span className="trace-list__duration">
                        <span className="trace-list__meter" aria-hidden="true">
                          <span
                            className={
                              failed
                                ? "trace-list__fill trace-list__fill--error"
                                : "trace-list__fill"
                            }
                            ref={cssVars({
                              "--share": longest > 0 ? row.duration / longest : 0,
                            })}
                          />
                        </span>
                        {formatDuration(row.duration * 1000, language)}
                      </span>
                    </td>
                  ) : null}
                  {has("start") ? (
                    <td
                      className="trace-list__num trace-list__extra"
                      title={dayTime(row.start, language, timeZone)}
                    >
                      {dayTime(row.start, language, timeZone, true)}
                    </td>
                  ) : null}
                  {has("status") && known.status ? (
                    <td>
                      {failed ? (
                        <span className="trace-error">{t("traces.error")}</span>
                      ) : (
                        t("traces.ok")
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Duration of each trace over time: slow requests and when they happened, at a glance. */
function DurationChart({
  rows,
  errorsKnown,
}: {
  rows: readonly TraceSummary[];
  errorsKnown: boolean;
}) {
  const { t } = useI18n();
  const from = rows.reduce((min, row) => Math.min(min, row.start), Number.POSITIVE_INFINITY);
  const to = rows.reduce((max, row) => Math.max(max, row.start), Number.NEGATIVE_INFINITY);
  const top = rows.reduce((max, row) => Math.max(max, row.duration), 0) || 1;
  const span = to - from || 1;
  // Errors last, so a red dot is never hidden under a neutral one.
  const ordered = [...rows].sort((a, b) => (a.errors ?? 0) - (b.errors ?? 0));
  return (
    <div className="trace-chart">
      <div className="trace-chart__head">
        <span>{t("traces.chart")}</span>
        {errorsKnown ? (
          <span className="trace-chart__legend">
            <span className="trace-chart__key">
              <span className="trace-chart__dot trace-chart__dot--error" />
              {t("traces.chart.errors")}
            </span>
            <span className="trace-chart__key">
              <span className="trace-chart__dot" />
              {t("traces.chart.fine")}
            </span>
          </span>
        ) : null}
      </div>
      <svg
        className="trace-chart__plot"
        viewBox="0 0 400 80"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("traces.chart")}
      >
        {[0, 40, 80].map((y) => (
          <line key={y} className="trace-chart__grid" x1="0" x2="400" y1={y} y2={y} />
        ))}
        {ordered.map((row) => (
          <line
            key={row.traceId}
            className={
              (row.errors ?? 0) > 0
                ? "trace-chart__point trace-chart__point--error"
                : "trace-chart__point"
            }
            x1={4 + ((row.start - from) / span) * 392}
            x2={4 + ((row.start - from) / span) * 392}
            y1={76 - (row.duration / top) * 70}
            y2={76 - (row.duration / top) * 70}
          />
        ))}
      </svg>
    </div>
  );
}
