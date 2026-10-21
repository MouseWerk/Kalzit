import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import type { TimeRange } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { fetchVariableOptions } from "./api";
import type { VariableModel } from "./model";
import { errorMessage } from "./ui/errors";

/** The value each variable starts with: its stored current value, else the first fixed value. */
export function initialVariables(variables: readonly VariableModel[]): Record<string, string> {
  return Object.fromEntries(variables.map((v) => [v.name, v.current ?? v.options?.[0] ?? ""]));
}

interface VariablesBarProps {
  orgId: string;
  dashboardId: string;
  variables: readonly VariableModel[];
  values: Record<string, string>;
  range: TimeRange;
  onChange: (name: string, value: string) => void;
}

/** One control per dashboard variable, above the panels. */
export function VariablesBar({
  orgId,
  dashboardId,
  variables,
  values,
  range,
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
            range={range}
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
  range,
  onChange,
}: {
  orgId: string;
  dashboardId: string;
  variable: VariableModel;
  value: string;
  values: Record<string, string>;
  range: TimeRange;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(value);
  // Other variables can feed this one's query, so they are part of what it depends on.
  const others = Object.fromEntries(
    Object.entries(values).filter(([name]) => name !== variable.name),
  );
  const options = useQuery({
    queryKey: ["variable-options", orgId, dashboardId, variable.name, range.from, range.to, others],
    queryFn: () =>
      fetchVariableOptions(orgId, dashboardId, variable.name, {
        timeRange: range,
        variables: others,
      }),
    enabled: variable.type === "query",
    staleTime: 60_000,
    retry: false,
  });
  const label = variable.label ?? variable.name;

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
        ? (variable.options ?? []).map((v) => ({ value: v, label: v }))
        : (options.data ?? []);
    const known = list.some((option) => option.value === value);
    control = (
      <select
        id={id}
        className="select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-describedby={options.isError ? `${id}-error` : undefined}
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
      {options.isError ? (
        <span className="field__error" id={`${id}-error`}>
          {errorMessage(t, options.error)}
        </span>
      ) : null}
    </div>
  );
}
