import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Select } from "../../components/Select";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { hasQuery } from "../datasources/queryKinds";
import { previewVariableOptions } from "./api";
import {
  ALL_VALUE,
  anyAll,
  cleanVariable,
  isAll,
  MAX_ALL_VALUES,
  type StaticOption,
  VARIABLE_SORTS,
  type VariableModel,
  type VariableRefresh,
  type VariableSort,
  type VariableValue,
  type VariableValues,
} from "./model";
import type { TextRange } from "./timeRange";
import { resolveRange } from "./timeRange";
import { errorMessage } from "./ui/errors";
import "./dashboards.css";

/** "intern = _int, unbekannt": fixed options as typed, shown name before the value. */
export function parseStaticOptions(text: string): StaticOption[] {
  const out: StaticOption[] = [];
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (entry === "") continue;
    const at = entry.indexOf(" = ");
    if (at === -1) {
      out.push({ value: entry });
    } else {
      const label = entry.slice(0, at).trim();
      const value = entry.slice(at + 3).trim();
      if (value !== "") out.push(label === "" || label === value ? { value } : { value, label });
    }
  }
  return out;
}

export function staticOptionsText(options: readonly StaticOption[] | undefined): string {
  return (options ?? [])
    .map((o) =>
      o.label === undefined || o.label === o.value ? o.value : `${o.label} = ${o.value}`,
    )
    .join(", ");
}

/**
 * "All" for custom and query variables: offered or not, its custom value (empty: the list of
 * every value) and whether the dashboard opens with it.
 */
export function AllOptionEditor({
  variable,
  onChange,
}: {
  variable: VariableModel;
  onChange: (patch: Partial<VariableModel>) => void;
}) {
  const { t } = useI18n();
  const multi = variable.multi === true;
  const all: VariableValue = multi ? [ALL_VALUE] : ALL_VALUE;
  const opensAll = isAll(variable.current as VariableValue | undefined);
  return (
    <fieldset className="variable-editor__group">
      <legend className="field__label">{t("dashboards.variables.allGroup")}</legend>
      <label className="variable-editor__switch">
        {t("dashboards.variables.includeAll")}
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={variable.includeAll === true}
          aria-checked={variable.includeAll === true}
          onChange={(event) => {
            const includeAll = event.currentTarget.checked;
            // Offering "All" makes it the start; taking it away leaves no stale "All" behind.
            onChange(
              includeAll
                ? { includeAll, current: all }
                : { includeAll, current: opensAll ? (multi ? [] : "") : variable.current },
            );
          }}
        />
      </label>
      {variable.includeAll === true ? (
        <>
          <TextField
            label={t("dashboards.variables.allValue")}
            hint={t("dashboards.variables.allValueHint")}
            value={variable.allValue ?? ""}
            onValueChange={(allValue) => onChange({ allValue })}
            maxLength={1000}
            placeholder={t("dashboards.variables.allValueEmpty")}
            mono
            autoComplete="off"
          />
          <label className="variable-editor__switch">
            {t("dashboards.variables.opensAll")}
            <input
              type="checkbox"
              role="switch"
              className="settings-switch"
              checked={opensAll}
              aria-checked={opensAll}
              onChange={(event) =>
                onChange({ current: event.currentTarget.checked ? all : multi ? [] : "" })
              }
            />
          </label>
        </>
      ) : null}
    </fieldset>
  );
}

/**
 * A query variable's options after the query: regex, order, when they are read again and fixed
 * extra values (board ParityEditors, frame 9). The server applies all of them.
 */
export function QueryVariableOptions({
  variable,
  regexError,
  onChange,
}: {
  variable: VariableModel;
  /** The server's sentence for a regex it refused, from the preview. */
  regexError: string | undefined;
  onChange: (patch: Partial<VariableModel>) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [extras, setExtras] = useState(staticOptionsText(variable.staticOptions));
  return (
    <div className="variable-editor__row">
      <TextField
        label={t("dashboards.variables.regex")}
        hint={t("dashboards.variables.regexHint")}
        error={regexError}
        value={variable.regex ?? ""}
        onValueChange={(regex) => onChange({ regex })}
        placeholder="/(?<text>.+)-prod/"
        maxLength={1000}
        mono
        autoComplete="off"
      />
      <div className="field">
        <label className="field__label" htmlFor={`${id}-sort`}>
          {t("dashboards.variables.sort")}
        </label>
        <Select
          id={`${id}-sort`}
          value={variable.sort ?? ""}
          onChange={(next) => {
            const sort = VARIABLE_SORTS.find((s) => s === next);
            onChange({ sort: sort as VariableSort | undefined });
          }}
        >
          <option value="">{t("dashboards.variables.sort.none")}</option>
          {VARIABLE_SORTS.map((sort) => (
            <option key={sort} value={sort}>
              {t(`dashboards.variables.sort.${sort}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-refresh`}>
          {t("dashboards.variables.refresh")}
        </label>
        <Select
          id={`${id}-refresh`}
          value={variable.refresh ?? "timeRange"}
          aria-describedby={`${id}-refresh-hint`}
          onChange={(next) => onChange({ refresh: next as VariableRefresh })}
        >
          <option value="load">{t("dashboards.variables.refresh.load")}</option>
          <option value="timeRange">{t("dashboards.variables.refresh.timeRange")}</option>
        </Select>
        <p className="field__hint" id={`${id}-refresh-hint`}>
          {t("dashboards.variables.refreshHint")}
        </p>
      </div>
      <TextField
        label={t("dashboards.variables.staticOptions")}
        hint={t("dashboards.variables.staticOptionsHint")}
        value={extras}
        onValueChange={(text) => {
          setExtras(text);
          onChange({ staticOptions: parseStaticOptions(text) });
        }}
        autoComplete="off"
      />
    </div>
  );
}

/** Waits until `value` has not changed for `ms`, so typing does not ask the source per key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The values a query variable offers as it is being edited: shown name and value, how many, how
 * long the query took, and how many the regex left out. Runs as a free query with the other
 * variables' start values, so it needs the right to query the source. Another query variable at
 * "All" is filled in by the server from the saved dashboard `dashboardId`, as the bar's options
 * are.
 */
export function VariablePreview({
  orgId,
  dashboardId,
  variable,
  kind,
  timeRange,
  values,
  onRegexError,
}: {
  orgId: string;
  dashboardId?: string | undefined;
  variable: VariableModel;
  /** The kind of the variable's data source, which tells what a whole query of it is. */
  kind?: string | undefined;
  timeRange: TextRange;
  /** The other variables' start values, as sent. */
  values: VariableValues;
  onRegexError: (message: string | undefined) => void;
}) {
  const { t } = useI18n();
  // The variable and its source's kind as they were when typing paused: the preview asks for
  // that, and only once its query is whole, so a source picked before the query is typed does
  // not send an empty one (the server refuses it).
  const settled = useSettled(
    JSON.stringify({ variable: cleanVariable(variable), kind: kind ?? null }),
    400,
  );
  const asked = JSON.parse(settled) as { variable: VariableModel; kind: string | null };
  const inputs = Object.fromEntries(Object.entries(values).filter(([n]) => n !== variable.name));
  const preview = useQuery({
    queryKey: ["variable-preview", orgId, settled, timeRange.from, timeRange.to, inputs],
    queryFn: async ({ signal }) => {
      const resolved = resolveRange(timeRange, Date.now());
      const range = resolved.ok ? resolved.range : { from: Date.now() - 3_600_000, to: Date.now() };
      const started = performance.now();
      const answer = await previewVariableOptions(
        orgId,
        {
          variable: asked.variable,
          timeRange: range,
          variables: inputs,
          ...(dashboardId !== undefined && anyAll(inputs) ? { dashboardId } : {}),
        },
        signal,
      );
      return { answer, ms: Math.round(performance.now() - started) };
    },
    enabled:
      asked.variable.datasourceId !== undefined &&
      asked.variable.datasourceId !== "" &&
      hasQuery(asked.variable.query, asked.kind ?? undefined),
    retry: false,
  });
  const regexRefused =
    preview.error !== null &&
    typeof preview.error === "object" &&
    "field" in preview.error &&
    preview.error.field === "regex";
  const regexError = regexRefused ? errorMessage(t, preview.error) : undefined;
  useEffect(() => onRegexError(regexError), [regexError, onRegexError]);
  const data = preview.data;
  const shown = data?.answer.options.slice(0, 7) ?? [];
  const more = (data?.answer.options.length ?? 0) - shown.length;
  return (
    <section className="variable-preview" aria-label={t("dashboards.variables.preview")}>
      <div className="variable-preview__head">
        <span className="field__label">{t("dashboards.variables.preview")}</span>
        {data === undefined ? null : (
          <span className="variable-preview__meta">
            {t("dashboards.variables.previewMeta", {
              count: data.answer.options.length,
              ms: data.ms,
            })}
          </span>
        )}
      </div>
      {preview.isError && !regexRefused ? (
        <p className="field__error">{errorMessage(t, preview.error)}</p>
      ) : null}
      {data === undefined ? (
        preview.isFetching ? (
          <p className="field__hint">{t("dashboards.variables.previewLoading")}</p>
        ) : null
      ) : (
        <div
          className={
            preview.isFetching ? "variable-preview__list is-stale" : "variable-preview__list"
          }
        >
          {variable.includeAll === true ? (
            <div className="variable-preview__row">
              <span>{t("dashboards.variables.all")}</span>
              <span className="variable-preview__value">
                {variable.allValue
                  ? variable.allValue
                  : t("dashboards.variables.previewAllValues", {
                      count: data.answer.options.length,
                    })}
              </span>
            </div>
          ) : null}
          {shown.map((option) => (
            <div key={option.value} className="variable-preview__row">
              <span>{option.label}</span>
              <span className="variable-preview__value">{option.value}</span>
            </div>
          ))}
          {more > 0 ? (
            <p className="field__hint">{t("dashboards.variables.previewMore", { count: more })}</p>
          ) : null}
          <p className="field__hint">
            {data.answer.unmatched === undefined
              ? t("dashboards.variables.previewHint")
              : t("dashboards.variables.previewUnmatched", { count: data.answer.unmatched })}
          </p>
          {variable.includeAll === true &&
          !variable.allValue &&
          data.answer.options.length > MAX_ALL_VALUES ? (
            <p className="field__hint">{t("dashboards.variables.allTooLong")}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
