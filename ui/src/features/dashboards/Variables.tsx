import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useId, useState } from "react";
import { ApiError, isApiError } from "../../api/client";
import type { QueryResponse, TimeRange } from "../../api/generated/shapes";
import { BUSY_RETRY } from "../../api/retry";
import { useI18n } from "../../i18n/i18n";
import { runQuery } from "../datasources/api";
import { fetchVariableOptions, type VariableOption } from "./api";
import { currentValue, optionChoices, storedQueryVariables, type VariableModel } from "./model";
import type { TextRange } from "./timeRange";
import { errorMessage } from "./ui/errors";
import "./dashboards.css";

/** The value each variable starts with: its stored current value, else the first fixed value. */
export function initialVariables(variables: readonly VariableModel[]): Record<string, string> {
  return Object.fromEntries(
    variables.map((v) => [v.name, currentValue(v) ?? optionChoices(v)[0]?.value ?? ""]),
  );
}

interface VariablesBarProps {
  orgId: string;
  dashboardId: string;
  variables: readonly VariableModel[];
  values: Record<string, string>;
  /** The range as stored text; options are read again only when it changes, not as time moves. */
  textRange: TextRange;
  /** The resolved range of the last run, sent with the request. */
  range: TimeRange;
  /** Bumped by "Refresh", which reads the options again too. */
  run: number;
  /**
   * The saved variables, in edit mode. A new or changed query variable runs through the free
   * query route; the options route only knows the saved dashboard.
   */
  stored?: readonly VariableModel[] | undefined;
  onChange: (name: string, value: string) => void;
}

/** Names a query mentions as $name, ${name} or ${name:format}. */
export function referencedNames(query: unknown): Set<string> {
  const text = JSON.stringify(query ?? null);
  return new Set([...text.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1] ?? ""));
}

/** The first frame's first field as values, its second field (if any) as labels. */
function optionsFromResponse(response: QueryResponse): VariableOption[] {
  const outcome = Object.values(response.results)[0];
  if (outcome === undefined) {
    return [];
  }
  if ("error" in outcome) {
    throw new ApiError(outcome.error.code, 200, outcome.error.message);
  }
  if (outcome.result.shape !== "frame") {
    return [];
  }
  const [values, labels] = outcome.result.frame.fields;
  const seen = new Set<string>();
  const options: VariableOption[] = [];
  (values?.values ?? []).forEach((raw, row) => {
    if (raw === null || raw === undefined) {
      return;
    }
    const value = String(raw);
    if (!seen.has(value)) {
      seen.add(value);
      const label = labels?.values[row];
      options.push({ value, label: label === null || label === undefined ? value : String(label) });
    }
  });
  return options;
}

/** One control per dashboard variable, above the panels. */
export function VariablesBar({
  orgId,
  dashboardId,
  variables,
  values,
  textRange,
  range,
  run,
  stored,
  onChange,
}: VariablesBarProps) {
  const { t } = useI18n();
  if (variables.length === 0) {
    return null;
  }
  return (
    <section className="variables" aria-label={t("dashboards.variables.label")}>
      {variables
        // A constant has one fixed value; there is nothing to choose.
        .filter((variable) => variable.type !== "constant")
        .map((variable) => (
          <VariableControl
            key={variable.name}
            orgId={orgId}
            dashboardId={dashboardId}
            variable={variable}
            value={values[variable.name] ?? ""}
            values={values}
            textRange={textRange}
            range={range}
            run={run}
            saved={stored ?? variables}
            draft={
              stored !== undefined &&
              JSON.stringify(stored.find((s) => s.name === variable.name)) !==
                JSON.stringify(variable)
            }
            onChange={(value) => onChange(variable.name, value)}
          />
        ))}
    </section>
  );
}

function VariableControl({
  orgId,
  dashboardId,
  variable,
  value,
  values,
  textRange,
  range,
  run,
  draft,
  saved,
  onChange,
}: {
  orgId: string;
  dashboardId: string;
  variable: VariableModel;
  value: string;
  values: Record<string, string>;
  textRange: TextRange;
  range: TimeRange;
  run: number;
  draft: boolean;
  saved: readonly VariableModel[];
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(value);
  // Only the variables this query mentions feed it; changing any other one asks nothing.
  const mentioned = referencedNames(variable.query);
  const mentionedValues = Object.fromEntries(
    Object.entries(values).filter(([name]) => name !== variable.name && mentioned.has(name)),
  );
  // The options route takes only saved, non-constant variables; a free query takes them all.
  const inputs = draft ? mentionedValues : storedQueryVariables(mentionedValues, saved);
  const options = useQuery({
    queryKey: [
      "variable-options",
      orgId,
      dashboardId,
      variable.name,
      draft ? variable : null,
      textRange.from,
      textRange.to,
      run,
      inputs,
    ],
    queryFn: async ({ signal }) => {
      if (!draft) {
        const answer = await fetchVariableOptions(
          orgId,
          dashboardId,
          variable.name,
          { timeRange: range, variables: inputs },
          signal,
        );
        return answer;
      }
      const response = await runQuery(
        orgId,
        {
          queries: [
            { refId: "A", datasourceId: variable.datasourceId ?? "", query: variable.query },
          ],
          timeRange: range,
          variables: inputs,
        },
        signal,
      );
      return { options: optionsFromResponse(response), truncated: false };
    },
    enabled: variable.type === "query" && (!draft || variable.datasourceId !== undefined),
    // Options belong to the stored range text; "Refresh" or a new range reads them again.
    staleTime: Number.POSITIVE_INFINITY,
    ...BUSY_RETRY,
  });
  const optionsError = options.isError
    ? isApiError(options.error, "not_found")
      ? t("dashboards.variables.notFound")
      : errorMessage(t, options.error)
    : null;
  const label = variable.label ?? variable.name;
  // A query variable without a stored value opens with its first option once they load, as a
  // custom one opens with its first fixed value.
  const first = options.data?.options[0]?.value;
  const opensEmpty = variable.type === "query" && currentValue(variable) === undefined;
  useEffect(() => {
    if (opensEmpty && value === "" && first !== undefined) {
      onChange(first);
    }
  }, [opensEmpty, value, first, onChange]);

  let control: ReactNode;
  if (variable.type === "textbox") {
    control = (
      <input
        id={id}
        className="input variables__input"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={() => text !== value && onChange(text)}
        onKeyDown={(event) => {
          // An Enter that confirms an input method composition is not a submit.
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            onChange(text);
          }
        }}
      />
    );
  } else {
    const list =
      variable.type === "custom" || variable.type === "interval"
        ? optionChoices(variable)
        : (options.data?.options ?? []);
    const known = list.some((option) => option.value === value);
    control = (
      <select
        id={id}
        className="select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-describedby={optionsError === null ? undefined : `${id}-error`}
      >
        {known ? null : (
          <option value={value}>{value === "" ? t("dashboards.variables.none") : value}</option>
        )}
        {list.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="variables__item">
      <label className="variables__label" htmlFor={id}>
        {label}
      </label>
      {control}
      {options.data?.truncated === true ? (
        <span className="field__hint">{t("dashboards.variables.truncated")}</span>
      ) : null}
      {optionsError === null ? null : (
        <span className="field__error" id={`${id}-error`}>
          {optionsError}
        </span>
      )}
    </div>
  );
}
