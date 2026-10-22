import { useId, useRef, useState } from "react";
import { isRecord } from "../../api/client";
import type { FieldSchema } from "../../api/generated/shapes";
import { type Bin, distribution } from "../../documents/distribution";
import { filterable, filterablePath } from "../../documents/filter";
import { typeLabel, valueSummary } from "../../documents/labels";
import { schemaOf } from "../../documents/schema";
import { SetPicker } from "../../documents/shared";
import { NUMERIC_TYPES, typeOf } from "../../documents/values";
import { useI18n } from "../../i18n/i18n";
import { dateTimeFormat } from "../frame";
import { EmptyPanel } from "../shared";
import { useStyleVars } from "../styleVars";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../../documents/documents.css";

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

/**
 * How the values of one field path are spread: counts, minimum and maximum, a histogram for
 * numbers and dates, and the most common values. Inside arrays every element counts.
 */
function DistributionPanel({
  documents = [],
  options,
  title,
  onFilter,
}: PanelProps<DistributionOptions>) {
  const { t, language } = useI18n();
  const pathId = useId();
  const [index, setIndex] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const position = Math.min(index, documents.length - 1);
  const set = documents[position];
  if (set === undefined) {
    return <EmptyPanel reason="noData" />;
  }
  const schema = valuePaths(schemaOf(set));
  const known = (path: string) => schema.some((field) => field.path === path);
  const path =
    chosen !== null && known(chosen)
      ? chosen
      : known(options.path)
        ? options.path
        : defaultPath(schema);
  if (path === "") {
    return <EmptyPanel reason="noValues" />;
  }
  const result = distribution(set.documents, path);
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 4 });
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const format = (value: number) =>
    result.scale === "date" ? dateTimeFormat(language).format(value) : number.format(value);
  const show = (value: unknown) =>
    typeof value === "number" ? format(value) : valueSummary(t, value, language);
  const filterPathOf = path.replaceAll("[]", "");
  // A path with an operator-like key ($...) cannot be filtered by.
  const pathFilterable = filterablePath(path.replaceAll("[]", "").split("."));

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
      <section className="dist" aria-label={title}>
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
            <dt>{t("documents.distribution.distinct")}</dt>
            <dd>{number.format(result.distinct)}</dd>
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
              <span className="dist__value truncate">{valueSummary(t, entry.value, language)}</span>
              <span className="doc-tree__type">{typeLabel(t, typeOf(entry.value))}</span>
              <Share share={result.values === 0 ? 0 : entry.count / result.values} />
              <span className="dist__count">
                {number.format(entry.count)} ({percent.format(entry.count / result.values)})
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
        aria-describedby={hintId}
        onChange={(event) => onChange({ path: event.currentTarget.value })}
      />
    </div>
  );
}

export const distributionPanel: PanelPlugin<DistributionOptions> = {
  type: "distribution",
  name: "documents.panels.distribution",
  shapes: ["documents"],
  options: (stored) => ({
    path: isRecord(stored) && typeof stored.path === "string" ? stored.path : "",
  }),
  Panel: DistributionPanel,
  Editor: DistributionEditor,
};
