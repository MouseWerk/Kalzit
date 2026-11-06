import { type ReactNode, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import type { ResultRecord } from "./api";
import "./chat.css";

/** Rows, documents or nodes shown of one result; the rest is counted. */
const SHOWN = 50;

function cell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Field {
  name: string;
  type: string;
  values: unknown[];
}

function fieldsOf(data: Record<string, unknown>): Field[] {
  const fields = Array.isArray(data.fields) ? data.fields : [];
  return fields.filter(isRecord).map((field) => ({
    name: typeof field.name === "string" ? field.name : "",
    type: typeof field.type === "string" ? field.type : "",
    values: Array.isArray(field.values) ? field.values : [],
  }));
}

/** Series a time series shows at most; more stay in the table. */
const MAX_SERIES = 6;
const NUMERIC = new Set(["number", "int64", "decimal"]);

/** A moment as milliseconds: a number, or a date text. */
function millis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function number(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/** The time field and the numeric fields of a frame, when it can be drawn over time. */
function timeSeriesOf(fields: readonly Field[]): { time: Field; series: Field[] } | undefined {
  const time = fields.find((field) => field.type === "time" || field.type === "date");
  const series = fields.filter((field) => NUMERIC.has(field.type)).slice(0, MAX_SERIES);
  return time === undefined || series.length === 0 ? undefined : { time, series };
}

/** Width and height of the drawing in its own units; it scales to the card. */
const W = 600;
const H = 160;

function TimeSeries({ time, series }: { time: Field; series: Field[] }) {
  const { t, language } = useI18n();
  const points = time.values.map(millis);
  const xs = points.filter((x): x is number => x !== undefined);
  const ys = series.flatMap((field) => field.values.map(number).filter((y) => y !== undefined));
  if (xs.length < 2 || ys.length === 0) {
    return <p className="ask-result__note">{t("ai.chat.result.noSeries")}</p>;
  }
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(...ys)];
  const sx = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * W;
  const sy = (y: number) => H - ((y - y0) / Math.max(Number.EPSILON, y1 - y0)) * H;
  const date = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" });
  const label = t("ai.chat.result.seriesLabel", {
    names: series.map((field) => field.name).join(", "),
    from: date.format(x0),
    to: date.format(x1),
  });
  return (
    <figure className="ask-series">
      <svg
        className="ask-series__chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {series.map((field, index) => {
          const line = points
            .map((x, row) => {
              const y = number(field.values[row]);
              return x === undefined || y === undefined ? null : `${sx(x)},${sy(y)}`;
            })
            .filter((point) => point !== null)
            .join(" ");
          return (
            <polyline
              key={field.name}
              className={`ask-series__line ask-series__line--${index + 1}`}
              points={line}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      <figcaption className="ask-series__legend">
        {series.map((field, index) => (
          <span key={field.name} className="ask-series__key">
            <span
              className={`ask-series__swatch ask-series__line--${index + 1}`}
              aria-hidden="true"
            />
            {field.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** What the card of a result says about it in its head. */
interface CardHead {
  title: string | undefined;
  /** The source it came from, when the title names the table read. */
  source: string | undefined;
  durationMs: number | undefined;
}

/**
 * A result as its own card (board DataChat.dc.html): what was read and from where, rows and
 * time, the view switch on the right, the result, and its notes at the foot.
 */
function ResultCard({
  head,
  rows,
  switcher,
  notes,
  children,
}: {
  head: CardHead;
  rows: number;
  switcher?: ReactNode;
  notes: ReactNode;
  children: ReactNode;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const facts = [
    head.source,
    head.durationMs === undefined
      ? t("ai.chat.result.rows", { count: number.format(rows) })
      : t("ai.chat.tool.rowsMs", { rows: number.format(rows), ms: number.format(head.durationMs) }),
  ].filter((part) => part !== undefined);
  return (
    <section className="ask-result-card" aria-label={head.title ?? t("ai.chat.result.label")}>
      <header className="ask-result-card__head">
        <span className="ask-result-card__titles">
          <span className="ask-result-card__title">{head.title ?? t("ai.chat.result.label")}</span>
          <span className="ask-result__note">{facts.join(" · ")}</span>
        </span>
        {switcher}
      </header>
      <div className="ask-result">{children}</div>
      {notes}
    </section>
  );
}

/**
 * A frame as a table, or over time where it has a time field and numbers ("Tabelle |
 * Zeitreihe" on the board).
 */
function FrameResult({
  refId,
  fields,
  rows,
  notes,
  head,
}: {
  refId: string;
  fields: Field[];
  rows: number;
  notes: ReactNode;
  head: CardHead;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<"table" | "series">("table");
  const series = timeSeriesOf(fields);
  const shown = Array.from({ length: Math.min(rows, SHOWN) }, (_, index) => index);
  const switcher =
    series === undefined ? undefined : (
      <fieldset className="ask-switch">
        <legend className="visually-hidden">{t("ai.chat.result.view")}</legend>
        {(["table", "series"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="ask-switch__option"
            aria-pressed={view === option}
            onClick={() => setView(option)}
          >
            {option === "table" ? t("ai.chat.result.asTable") : t("ai.chat.result.asSeries")}
          </button>
        ))}
      </fieldset>
    );
  return (
    <ResultCard head={head} rows={rows} switcher={switcher} notes={notes}>
      {series !== undefined && view === "series" ? (
        <TimeSeries time={series.time} series={series.series} />
      ) : (
        <>
          <div className="ask-result__scroll">
            <table className="ask-result__table">
              <caption className="visually-hidden">
                {t("ai.chat.result.caption", { ref: refId })}
              </caption>
              <thead>
                <tr>
                  {fields.map((field, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns may share a name.
                    <th key={index} scope="col" data-numeric={NUMERIC.has(field.type) || undefined}>
                      {field.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row}>
                    {fields.map((field, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns may share a name.
                      <td key={index} data-numeric={NUMERIC.has(field.type) || undefined}>
                        {cell(field.values[row])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows > SHOWN ? (
            <p className="ask-result__note">{t("ai.chat.result.more", { count: rows - SHOWN })}</p>
          ) : null}
        </>
      )}
    </ResultCard>
  );
}

/**
 * One result of a tool call in its own shape, as it went to the model (excluded values replaced,
 * cut to the row limit): a frame as a table, documents as JSON, a graph as its nodes. Text only;
 * nothing in it is run or followed.
 */
export function ResultView({
  result,
  title,
  source,
  durationMs,
}: {
  result: ResultRecord;
  /** What was read ("Tabelle bestellungen"), else the source's name. */
  title?: string | undefined;
  source?: string | undefined;
  durationMs?: number | undefined;
}) {
  const { t } = useI18n();
  const data = result.data;
  if (data === undefined) {
    return null;
  }
  const head: CardHead = { title, source, durationMs };
  const notes =
    result.truncated || result.excludedValues > 0 ? (
      <footer className="ask-result-card__foot">
        {result.truncated ? (
          <p className="ask-result__note">{t("ai.chat.truncated", { rows: result.rows })}</p>
        ) : null}
        {result.excludedValues > 0 ? (
          <p className="ask-result__note">
            {t("ai.chat.excluded", { count: result.excludedValues })}
          </p>
        ) : null}
      </footer>
    ) : null;
  if (data.shape === "frame") {
    const fields = fieldsOf(data);
    const rows = Math.max(0, ...fields.map((field) => field.values.length));
    if (rows === 0) {
      return (
        <ResultCard head={head} rows={0} notes={notes}>
          <p className="ask-result__note">{t("ai.chat.result.empty")}</p>
        </ResultCard>
      );
    }
    return (
      <FrameResult refId={result.refId} fields={fields} rows={rows} notes={notes} head={head} />
    );
  }
  if (data.shape === "documents") {
    const documents = Array.isArray(data.documents) ? data.documents : [];
    return (
      <ResultCard head={head} rows={documents.length} notes={notes}>
        <p className="ask-result__note">
          {t("ai.chat.result.documents", { count: documents.length })}
        </p>
        {documents.slice(0, SHOWN).map((document, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: documents are shown in their order.
          <pre key={index} className="ask-result__document">
            {JSON.stringify(document, null, 2)}
          </pre>
        ))}
        {documents.length > SHOWN ? (
          <p className="ask-result__note">
            {t("ai.chat.result.more", { count: documents.length - SHOWN })}
          </p>
        ) : null}
      </ResultCard>
    );
  }
  if (data.shape === "graph") {
    const nodes = (Array.isArray(data.nodes) ? data.nodes : []).filter(isRecord);
    const edges = Array.isArray(data.edges) ? data.edges : [];
    return (
      <ResultCard head={head} rows={nodes.length} notes={notes}>
        <p className="ask-result__note">
          {t("ai.chat.result.graph", { nodes: nodes.length, edges: edges.length })}
        </p>
        <div className="ask-result__scroll">
          <table className="ask-result__table">
            <caption className="visually-hidden">
              {t("ai.chat.result.caption", { ref: result.refId })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("ai.chat.result.labels")}</th>
                <th scope="col">{t("ai.chat.result.properties")}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.slice(0, SHOWN).map((node, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: nodes are shown in their order.
                <tr key={index}>
                  <td>{Array.isArray(node.labels) ? node.labels.join(", ") : ""}</td>
                  <td>{cell(node.properties)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nodes.length > SHOWN ? (
          <p className="ask-result__note">
            {t("ai.chat.result.more", { count: nodes.length - SHOWN })}
          </p>
        ) : null}
      </ResultCard>
    );
  }
  return null;
}
