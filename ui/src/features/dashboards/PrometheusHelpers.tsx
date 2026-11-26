import { useId } from "react";
import { isRecord } from "../../api/client";
import { Select } from "../../components/Select";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import "./dashboards.css";

/**
 * The helpers for Prometheus query variables (board ParityEditors, frame 9): four short forms in
 * place of typed functions, with the query behind them shown read-only. The server reads them as
 * `{"helper": ...}` queries (docs/api/datasources.md, "Prometheus helpers").
 */

export const HELPERS = ["labelValues", "labelNames", "metrics", "queryResult"] as const;
export type HelperName = (typeof HELPERS)[number];

/** A helper query, or null for a typed PromQL query (`{"expr": ...}`) or anything else. */
export function helperOf(
  query: unknown,
): (Record<string, unknown> & { helper: HelperName }) | null {
  if (!isRecord(query)) return null;
  const helper = HELPERS.find((h) => h === query.helper);
  return helper === undefined ? null : { ...query, helper };
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * The query behind a helper in the words other tools write it, as the server shows it in its
 * answer: `label_values(up{env="$env"}, job)`, `label_names()`, `metrics(node_.*)`,
 * `query_result(topk(5, up))`.
 */
export function helperText(query: unknown): string {
  const helper = helperOf(query);
  if (helper === null) return "";
  const metric = text(helper.metric);
  const filter = text(helper.filter);
  const selector = filter === "" ? metric : `${metric}{${filter}}`;
  switch (helper.helper) {
    case "labelValues": {
      const label = text(helper.label);
      return selector === "" ? `label_values(${label})` : `label_values(${selector}, ${label})`;
    }
    case "labelNames":
      return `label_names(${selector})`;
    case "metrics":
      return `metrics(${text(helper.regex)})`;
    default:
      return `query_result(${text(helper.expr)})`;
  }
}

/** The fields a helper keeps, without empty optional ones (the server takes no others). */
function cleanHelper(helper: HelperName, fields: Record<string, unknown>): Record<string, unknown> {
  const keep: Record<HelperName, readonly string[]> = {
    labelValues: ["label", "metric", "filter"],
    labelNames: ["metric", "filter"],
    metrics: ["regex"],
    queryResult: ["expr"],
  };
  const out: Record<string, unknown> = { helper };
  for (const key of keep[helper]) {
    const value = fields[key];
    const required = (helper === "labelValues" && key === "label") || helper === "queryResult";
    if (typeof value === "string" && (value !== "" || required)) out[key] = value;
    else if (required) out[key] = "";
  }
  return out;
}

/**
 * "Was abfragen": one of the four helpers or the own query, and the helper's fields. Switching
 * to the own query keeps nothing of the helper; switching between helpers keeps shared fields.
 */
export function PrometheusHelperForm({
  query,
  onChange,
}: {
  query: unknown;
  onChange: (query: unknown) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const helper = helperOf(query);
  const mode = helper?.helper ?? "custom";
  const set = (patch: Record<string, unknown>) => {
    if (helper === null) return;
    onChange(cleanHelper(helper.helper, { ...helper, ...patch }));
  };
  const field = (key: string) => (helper === null ? "" : String(helper[key] ?? ""));
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-mode`}>
          {t("dashboards.variables.helper")}
        </label>
        <Select
          id={`${id}-mode`}
          value={mode}
          onChange={(next) => {
            if (next === "custom") {
              onChange({ expr: "" });
            } else {
              onChange(cleanHelper(next as HelperName, helper ?? {}));
            }
          }}
        >
          {HELPERS.map((h) => (
            <option key={h} value={h}>
              {t(`dashboards.variables.helper.${h}`)}
            </option>
          ))}
          <option value="custom">{t("dashboards.variables.helper.custom")}</option>
        </Select>
      </div>
      {mode === "labelValues" ? (
        <TextField
          label={t("dashboards.variables.helper.label")}
          value={field("label")}
          onValueChange={(label) => set({ label })}
          mono
          autoComplete="off"
        />
      ) : null}
      {mode === "labelValues" || mode === "labelNames" ? (
        <>
          <TextField
            label={t("dashboards.variables.helper.metric")}
            value={field("metric")}
            onValueChange={(metric) => set({ metric })}
            mono
            autoComplete="off"
          />
          <TextField
            label={t("dashboards.variables.helper.filter")}
            hint={t("dashboards.variables.helper.filterHint")}
            value={field("filter")}
            onValueChange={(filter) => set({ filter })}
            mono
            autoComplete="off"
          />
        </>
      ) : null}
      {mode === "metrics" ? (
        <TextField
          label={t("dashboards.variables.helper.regex")}
          value={field("regex")}
          onValueChange={(regex) => set({ regex })}
          mono
          autoComplete="off"
        />
      ) : null}
      {mode === "queryResult" ? (
        <TextField
          label={t("dashboards.variables.helper.expr")}
          hint={t("dashboards.variables.helper.exprHint")}
          value={field("expr")}
          onValueChange={(expr) => set({ expr })}
          mono
          autoComplete="off"
        />
      ) : null}
      {helper === null ? null : (
        <div className="field">
          <span className="field__label" id={`${id}-behind`}>
            {t("dashboards.variables.helper.behind")}
          </span>
          <output className="variable-helper__behind" aria-labelledby={`${id}-behind`}>
            {helperText(helper)}
          </output>
          <p className="field__hint">{t("dashboards.variables.helper.hint")}</p>
        </div>
      )}
    </>
  );
}
