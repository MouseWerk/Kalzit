import { useEffect, useId, useRef, useState } from "react";
import { isRecord } from "../../api/client";
import type { FieldSchema } from "../../api/generated/shapes";
import {
  type Bin,
  type Distribution,
  distribution,
  fromServer,
} from "../../documents/distribution";
import { filterable, filterablePath } from "../../documents/filter";
import { typeLabel, valueSummary } from "../../documents/labels";
import { type PathStep, stepsOf } from "../../documents/paths";
import { MAX_PATH_CHARS } from "../../documents/projection";
import { schemaOf } from "../../documents/schema";
import { SetPicker } from "../../documents/shared";
import { NUMERIC_TYPES, typeOf } from "../../documents/values";
import { errorMessage } from "../../features/dashboards/ui/errors";
import { useI18n } from "../../i18n/i18n";
import { dateTimeFormat } from "../frame";
import { EmptyPanel } from "../shared";
import { useStyleVars } from "../styleVars";
import type { DistributionRunner, PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../../documents/documents.css";
import { DistributionPreview } from "../picker/previews";

export interface DistributionOptions {
  /** The schema path to show (`items[].price`); the first numeric path when empty. */
  path: string;
}

const LEAF = new Set(["object", "array"]);

/** Paths that hold values to count: not objects and arrays themselves, but their contents. */
function valuePaths(schema: readonly FieldSchema[]): FieldSchema[] {
  return schema.filter((field) => field.types.some((type) => !LEAF.has(type.name)));
}

function defaultPath(schema: readonly FieldSchema[]): string {
  const numeric = schema.find((field) =>
    field.types.some((type) => NUMERIC_TYPES.has(type.name) || type.name === "date"),
  );
  return numeric?.path ?? schema[0]?.path ?? "";
}

function Share({ share }: { share: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useStyleVars(ref, { "--share": `${Math.round(share * 1000) / 10}%` });
  return (
    <span className="schema__meter" aria-hidden="true">
      <span className="schema__meter-fill" ref={ref} />
    </span>
  );
}

function Histogram({
  bins,
  label,
  format,
}: {
  bins: readonly Bin[];
  label: string;
  format: (value: number) => string;
}) {
  const max = Math.max(1, ...bins.map((bin) => bin.count));
  return (
    <figure className="dist__histogram">
      <svg
        className="dist__svg"
        viewBox={`0 0 ${bins.length} 100`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {bins.map((bin, i) => {
          const height = (bin.count / max) * 100;
          return (
            <rect
              key={bin.from}
              className="dist__bar"
              x={i + 0.05}
              y={100 - height}
              width={0.9}
              height={height}
            >
              <title>{`${format(bin.from)} – ${format(bin.to)}: ${bin.count}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="dist__axis">
        <span>{format(bins[0]?.from ?? 0)}</span>
        <span>{format(bins.at(-1)?.to ?? 0)}</span>
      </figcaption>
    </figure>
  );
}

/** The distribution over the whole result, as the server computes it. */
type Whole =
  | { status: "loading" }
  | { status: "done"; result: Distribution }
  | { status: "failed"; message: string };

/**
 * Asks the server for the distribution of `steps` in set `index` whenever the field, the set or
 * the result changes; the request before is cancelled then (and when the panel goes away).
 * `null` when the server is not asked: the source cannot, or the page offers no way to ask.
 */
function useWholeDistribution(
  run: DistributionRunner | undefined,
  index: number,
  steps: PathStep[] | null,
  revision: string | number | undefined,
): { whole: Whole | null; retry: () => void } {
  const { t } = useI18n();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; whole: Whole } | null>(null);
  const key =
    run === undefined || steps === null
      ? null
      : JSON.stringify([index, steps, revision ?? null, attempt]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key holds everything the request depends on; the runner is a new function on every render
  useEffect(() => {
    if (key === null || run === undefined || steps === null) {
      return;
    }
    const controller = new AbortController();
    setState({ key, whole: { status: "loading" } });
    run(index, { path: steps }, controller.signal).then(
      (answer) => {
        if (!controller.signal.aborted) {
          setState({ key, whole: { status: "done", result: fromServer(answer) } });
        }
      },
      (problem: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key, whole: { status: "failed", message: errorMessage(t, problem) } });
        }
      },
    );
    return () => controller.abort();
  }, [key]);
  const whole: Whole | null =
    key === null ? null : state?.key === key ? state.whole : { status: "loading" };
  return { whole, retry: () => setAttempt((n) => n + 1) };
}

/**
 * How the values of one field path are spread: counts, minimum and maximum, a histogram for
 * numbers and dates, and the most common values. Inside arrays every element counts. Sources
 * that can (MongoDB) count the whole result in the database; otherwise the loaded documents are
 * counted, and the panel says which.
 */
function DistributionPanel({
  documents = [],
  options,
  title,
  onFilter,
  distribution: runner,
  revision,
}: PanelProps<DistributionOptions>) {
  const { t, language, timeZone } = useI18n();
  const pathId = useId();
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const position = Math.min(index, documents.length - 1);
  const set = documents[position];
  const schema = set === undefined ? [] : valuePaths(schemaOf(set));
  const known = (path: string) => schema.some((field) => field.path === path);
  const path =
    chosen !== null && known(chosen)
      ? chosen
      : known(options.path)
        ? options.path
        : defaultPath(schema);
  const steps = set === undefined || path === "" ? null : stepsOf(set.documents, path);
  const { whole, retry } = useWholeDistribution(
    set?.distributable === true ? runner : undefined,
    position,
    steps,
    revision,
  );
  if (set === undefined) {
    return <EmptyPanel reason="noData" />;
  }
  if (path === "" || steps === null) {
    return <EmptyPanel reason="noValues" />;
  }
  const result = whole?.status === "done" ? whole.result : distribution(set.documents, steps);
  const overAll = whole?.status === "done";
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 4 });
  const scopeCount = overAll ? result.total : set.documents.length;
  const count = number.format(scopeCount);
  const scope = overAll
    ? scopeCount === 1
      ? t("documents.distribution.scope.allOne")
      : t("documents.distribution.scope.all", { count })
    : scopeCount === 1
      ? t("documents.distribution.scope.loadedOne")
      : t("documents.distribution.scope.loaded", { count });
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const format = (value: number) =>
    result.scale === "date"
      ? dateTimeFormat(language, timeZone).format(value)
      : number.format(value);
  const show = (value: unknown) =>
    typeof value === "number" ? format(value) : valueSummary(t, value, language);
  // A filter path names the keys without array steps; a key with a dot or an operator-like key
  // ($...) cannot be named in one.
  const keys = steps.filter((step): step is string => step !== null);
  const filterPathOf = keys.join(".");
  const pathFilterable = filterablePath(keys);
  const share = (n: number) => (result.values === 0 ? 0 : n / result.values);

  return (
    <div className="doc-panel">
      <div className="doc-panel__bar">
        <SetPicker count={documents.length} index={position} onChange={setIndex} />
        <div className="preference">
          <label htmlFor={pathId}>{t("documents.distribution.path")}</label>
          <select
            id={pathId}
            className="select"
            value={path}
            onChange={(event) => setChosen(event.currentTarget.value)}
          >
            {schema.map((field) => (
              <option key={field.path} value={field.path}>
                {field.path}
              </option>
            ))}
          </select>
        </div>
      </div>
      <section className="dist" aria-label={title} aria-busy={whole?.status === "loading"}>
        <p className="dist__scope" aria-live="polite">
          <span>{scope}</span>
          {whole?.status === "loading" ? (
            <span>{t("documents.distribution.scope.loading")}</span>
          ) : null}
        </p>
        {whole?.status === "failed" ? (
          <p className="dist__scope dist__scope--failed" role="alert">
            <span>{t("documents.distribution.scope.failed", { message: whole.message })}</span>
            <button type="button" className="button button--ghost button--small" onClick={retry}>
              {t("common.retry")}
            </button>
          </p>
        ) : null}
        <dl className="dist__stats">
          <div>
            <dt>{t("documents.distribution.values")}</dt>
            <dd>{number.format(result.values)}</dd>
          </div>
          <div>
            <dt>{t("documents.distribution.documents")}</dt>
            <dd>{number.format(result.documents)}</dd>
          </div>
          <div>
            <dt>{t("documents.distribution.missing")}</dt>
            <dd>{number.format(result.missing)}</dd>
          </div>
          <div>
            <dt>{t("documents.distribution.nulls")}</dt>
            <dd>{number.format(result.nulls)}</dd>
          </div>
          <div>
            <dt>{t("documents.distribution.distinct")}</dt>
            <dd>
              {result.distinctCapped
                ? t("documents.distribution.distinctCapped", {
                    count: number.format(result.distinct),
                  })
                : number.format(result.distinct)}
            </dd>
          </div>
          {result.min === undefined ? null : (
            <div>
              <dt>{t("documents.distribution.min")}</dt>
              <dd>{show(result.min)}</dd>
            </div>
          )}
          {result.max === undefined ? null : (
            <div>
              <dt>{t("documents.distribution.max")}</dt>
              <dd>{show(result.max)}</dd>
            </div>
          )}
        </dl>
        {result.bins.length === 0 ? null : (
          <Histogram
            bins={result.bins}
            format={format}
            label={t("documents.distribution.histogram", {
              path,
              bins: result.bins.length,
              min: format(result.bins[0]?.from ?? 0),
              max: format(result.bins.at(-1)?.to ?? 0),
            })}
          />
        )}
        <h3 className="dist__heading">{t("documents.distribution.top")}</h3>
        <ol className="dist__top">
          {result.top.map((entry) => (
            <li
              key={`${typeOf(entry.value)}:${JSON.stringify(entry.value)}`}
              className="dist__entry"
            >
              <span className="dist__value truncate" title={valueSummary(t, entry.value, language)}>
                {valueSummary(t, entry.value, language)}
              </span>
              <span className="doc-tree__type">{typeLabel(t, typeOf(entry.value))}</span>
              <Share share={share(entry.count)} />
              <span className="dist__count">
                {number.format(entry.count)} ({percent.format(share(entry.count))})
              </span>
              {onFilter !== undefined && pathFilterable && filterable(entry.value) ? (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("documents.distribution.filterValue", {
                    value: valueSummary(t, entry.value, language),
                  })}
                  onClick={() =>
                    onFilter({ index: position, path: filterPathOf, value: entry.value })
                  }
                >
                  {t("documents.tree.filter")}
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function DistributionEditor({ options, onChange }: PanelEditorProps<DistributionOptions>) {
  const { t } = useI18n();
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("documents.distribution.path")}
      </label>
      <p className="field__hint" id={hintId}>
        {t("documents.distribution.pathHint")}
      </p>
      <input
        id={id}
        className="input input--mono"
        value={options.path}
        maxLength={MAX_PATH_CHARS}
        aria-describedby={hintId}
        onChange={(event) => onChange({ path: event.currentTarget.value })}
      />
    </div>
  );
}

export const distributionPanel: PanelPlugin<DistributionOptions> = {
  type: "distribution",
  name: "documents.panels.distribution",
  description: "documents.describe.distribution",
  Preview: DistributionPreview,
  shapes: ["documents"],
  options: (stored) => ({
    path: isRecord(stored) && typeof stored.path === "string" ? stored.path : "",
  }),
  Panel: DistributionPanel,
  Editor: DistributionEditor,
};
