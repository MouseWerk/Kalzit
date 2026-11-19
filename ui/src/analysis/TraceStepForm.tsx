import { type ReactNode, useId, useState } from "react";
import type { SpanKind, SpanStatus, TraceSet } from "../api/generated/shapes";
import { useI18n } from "../i18n/i18n";
import { PROPERTY_OPS, type PropertyFilter, type PropertyOp } from "./graphSteps";
import { Checks, Choice, keptValue, optional, optionalList, Text, valueFor } from "./StepsEditor";
import type { Step, TraceStepOf } from "./steps";
import { MAX_TRACE_LIST, SPAN_KINDS } from "./traceSteps";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";

/** A list of names typed with commas, such as services or attribute keys. */
function NamesField({
  label,
  hint,
  value,
  suggestions,
  onChange,
}: {
  label: string;
  hint?: string;
  value: readonly string[];
  suggestions: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value.join(", "));
  // A list changed from outside (undo) replaces the typed text; what is typed stays as typed.
  const [shown, setShown] = useState(value);
  const parsed = (raw: string) => [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ];
  if (shown !== value) {
    setShown(value);
    if (parsed(text).join("\n") !== value.join("\n")) setText(value.join(", "));
  }
  return (
    <div className="field step__wide">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      <input
        id={id}
        className="input"
        value={text}
        list={suggestions.length === 0 ? undefined : `${id}-list`}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => {
          setText(event.currentTarget.value);
          onChange(parsed(event.currentTarget.value).slice(0, MAX_TRACE_LIST));
        }}
      />
      {suggestions.length === 0 ? null : (
        <datalist id={`${id}-list`}>
          {suggestions.slice(0, 200).map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** A duration bound in milliseconds that may be empty. */
function OptionalNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="number"
        min={0}
        defaultValue={value ?? ""}
        onChange={(event) => {
          const raw = event.currentTarget.value.trim();
          const n = Number(raw);
          if (raw === "") onChange(undefined);
          else if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
      />
    </div>
  );
}

/** The forms of the trace steps (board Traces, frames 7 and 8). */
export interface TraceStepFormProps {
  step: TraceStepOf & Step;
  trace: TraceSet | undefined;
  frameChoice: ReactNode;
  onChange: (step: Step) => void;
}

export function TraceStepForm({ step, trace, frameChoice, onChange }: TraceStepFormProps) {
  const { t } = useI18n();
  const hint = (text: string) => <p className="field__hint step__wide">{text}</p>;
  const spans = trace?.spans ?? [];
  const names = (pick: (span: TraceSet["spans"][number]) => string) =>
    [...new Set(spans.slice(0, 5000).map(pick))].sort();
  switch (step.type) {
    case "filterSpans": {
      const filter = step.attribute;
      const setFilter = (next: PropertyFilter | undefined) => {
        const { attribute: _, ...rest } = step;
        onChange(next === undefined ? rest : { ...rest, attribute: next });
      };
      const valueText = filter?.value === undefined ? "" : String(filter.value);
      const bound = (key: "minDurationMs" | "maxDurationMs", value: number | undefined) => {
        const { [key]: _, ...rest } = step;
        onChange((value === undefined ? rest : { ...rest, [key]: value }) as Step);
      };
      return (
        <div className="step__form">
          {frameChoice}
          <NamesField
            label={t("traces.col.services")}
            hint={t("traces.step.listHint")}
            value={step.services ?? []}
            suggestions={names((span) => span.service)}
            onChange={(next) => onChange(optionalList(step, "services", next))}
          />
          <NamesField
            label={t("traces.step.operations")}
            value={step.operations ?? []}
            suggestions={names((span) => span.operation)}
            onChange={(next) => onChange(optionalList(step, "operations", next))}
          />
          <Choice
            label={t("traces.status")}
            value={step.status ?? ""}
            options={[
              ["", t("traces.show.all")],
              ["error", t("traces.error")],
              ["ok", t("traces.ok")],
              ["unset", t("traces.step.unset")],
            ]}
            onChange={(status) => onChange(optional(step, "status", status as SpanStatus | ""))}
          />
          <OptionalNumber
            label={t("traces.step.minMs")}
            value={step.minDurationMs}
            onChange={(value) => bound("minDurationMs", value)}
          />
          <OptionalNumber
            label={t("traces.step.maxMs")}
            value={step.maxDurationMs}
            onChange={(value) => bound("maxDurationMs", value)}
          />
          <Checks
            legend={t("traces.kind")}
            options={SPAN_KINDS.map((kind) => [kind, kind])}
            value={step.kinds ?? []}
            onChange={(next) => onChange(optionalList(step, "kinds", next as SpanKind[]))}
          />
          <Text
            label={t("traces.step.attribute")}
            value={filter?.key ?? ""}
            onChange={(key) =>
              setFilter(
                key === "" ? undefined : { key, op: filter?.op ?? "exists", ...keptValue(filter) },
              )
            }
          />
          {filter === undefined ? null : (
            <>
              <Choice
                label={t("analysis.graph.op")}
                value={filter.op}
                options={PROPERTY_OPS.map((op) => [op, t(`analysis.op.${op}`)])}
                onChange={(op) => {
                  const next = op as PropertyOp;
                  setFilter(
                    next === "exists"
                      ? { key: filter.key, op: next }
                      : { key: filter.key, op: next, ...valueFor(next, valueText) },
                  );
                }}
              />
              {filter.op === "exists" ? null : (
                <Text
                  label={t("analysis.graph.value")}
                  value={valueText}
                  onChange={(text) =>
                    setFilter({ key: filter.key, op: filter.op, ...valueFor(filter.op, text) })
                  }
                />
              )}
            </>
          )}
        </div>
      );
    }
    case "spanTable":
      return (
        <div className="step__form">
          {frameChoice}
          <NamesField
            label={t("traces.step.columns")}
            hint={t("traces.step.columnsHint")}
            value={step.attributes ?? []}
            suggestions={[
              ...new Set(spans.slice(0, 500).flatMap((span) => Object.keys(span.attributes))),
            ].sort()}
            onChange={(next) => onChange(optionalList(step, "attributes", next))}
          />
        </div>
      );
    case "serviceMap":
    case "spanTree":
      return (
        <div className="step__form">
          {frameChoice}
          {hint(t("traces.step.graphHint"))}
          {step.confirmLarge === true ? (
            <label className="checkbox step__wide">
              <input
                type="checkbox"
                checked
                onChange={() => {
                  const { confirmLarge: _, ...rest } = step;
                  onChange(rest);
                }}
              />
              <span>{t("traces.step.large")}</span>
            </label>
          ) : null}
        </div>
      );
    default:
      return frameChoice === null ? null : <div className="step__form">{frameChoice}</div>;
  }
}
