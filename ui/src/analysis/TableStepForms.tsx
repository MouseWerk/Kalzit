import type { ReactNode } from "react";
import type { Field } from "../api/generated/shapes";
import { Icon } from "../components/Icon";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { isNumeric } from "../panels/frame";
import { AGGS, type Agg } from "./calculations";
import { Checks, Choice, FieldChoice, NumberField, Text, withCurrent } from "./stepFields";
import {
  CONVERT_TO,
  type Conversion,
  type ConvertTo,
  fieldPattern,
  type KeepDrop,
  type LimitFrom,
  type MatchMode,
  type NamedFrame,
  type ReduceMode,
  ROW_OPS,
  type RowCondition,
  type RowOp,
  runSteps,
  type Step,
} from "./steps";

/** Rows a limit keeps at most (server/src/analysis/mod.rs, `MAX_LIMIT`). */
export const MAX_LIMIT = 1_000_000;

export type TableStep = Extract<
  Step,
  {
    type:
      | "organize"
      | "filterFields"
      | "filterRows"
      | "limit"
      | "convert"
      | "reduceSeries"
      | "stack"
      | "seriesToRows";
  }
>;

export const TABLE_FORM_TYPES: readonly TableStep["type"][] = [
  "organize",
  "filterFields",
  "filterRows",
  "limit",
  "convert",
  "reduceSeries",
  "stack",
  "seriesToRows",
];

export const isTableFormStep = (step: Step): step is TableStep =>
  (TABLE_FORM_TYPES as readonly string[]).includes(step.type);

/** The ops that take no value, and the one that takes two. */
const NO_VALUE: readonly RowOp[] = ["empty", "notEmpty"];

/** The number of rows (and fields) the step leaves of its input, run on its own. */
function kept(step: Step, input: NamedFrame | undefined): { rows: number; fields: number } | null {
  if (input === undefined) return null;
  const run = runSteps([{ ...step, disabled: false } as Step], [input]);
  const out = run.failed === undefined ? run.frames.find((f) => f.name === input.name) : undefined;
  if (out === undefined) return null;
  return { rows: out.frame.fields[0]?.values.length ?? 0, fields: out.frame.fields.length };
}

/**
 * The forms of the table steps that arrange a table (Parity board, frame 15): organize, filter
 * fields and rows, limit, convert, reduce, stack and series to rows. Each starts with its help.
 */
export function TableStepForm({
  step,
  onChange,
  refIds,
  input,
  frameChoice,
}: {
  step: TableStep;
  onChange: (step: Step) => void;
  refIds: readonly string[];
  input: readonly NamedFrame[];
  frameChoice: ReactNode;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<TableStep>) => onChange({ ...step, ...patch } as Step);
  const help = <p className="field__hint step__wide">{t(`analysis.help.${step.type}`)}</p>;
  if (step.type === "stack" || step.type === "seriesToRows") {
    const min = step.type === "stack" ? 2 : 1;
    return (
      <div className="step__form">
        {help}
        <Checks
          legend={t("analysis.combine.frames")}
          options={withCurrent(refIds, step.frames).map((r) => [r, r])}
          value={step.frames}
          onChange={(frames) => {
            const ordered = withCurrent(refIds, frames).filter((r) => frames.includes(r));
            if (ordered.length >= min) set({ frames: ordered });
          }}
        />
        {step.type === "stack" && step.frames.length < 2 ? (
          <p className="field__hint step__wide">{t("analysis.combine.needsTwo")}</p>
        ) : null}
      </div>
    );
  }
  const nf = input.find((f) => f.name === step.frame);
  const fields = nf?.frame.fields ?? [];
  switch (step.type) {
    case "organize":
      return (
        <div className="step__form">
          {help}
          {frameChoice}
          <OrganizeList step={step} fields={fields} onChange={(next) => onChange(next)} />
          <p className="field__hint step__wide">{t("analysis.organize.hint")}</p>
        </div>
      );
    case "filterFields": {
      let patternError: string | null = null;
      if (step.pattern !== undefined) {
        try {
          fieldPattern(step.pattern);
        } catch {
          patternError = t("datasources.reason.steps.pattern", { pattern: step.pattern });
        }
      }
      const result = kept(step, nf);
      return (
        <div className="step__form">
          {help}
          {frameChoice}
          <KeepDropChoice
            label={t("analysis.filterFields.mode")}
            value={step.mode}
            onChange={(mode) => set({ mode })}
          />
          <Checks
            legend={t("analysis.filterFields.names")}
            options={withCurrent(
              fields.map((f) => f.name),
              step.names ?? [],
            ).map((n) => [n, n])}
            value={step.names ?? []}
            onChange={(names) => {
              const { names: _, ...rest } = step;
              onChange((names.length === 0 ? rest : { ...step, names }) as Step);
            }}
          />
          <div className="step__wide">
            <Text
              label={t("analysis.filterFields.pattern")}
              value={step.pattern ?? ""}
              onChange={(pattern) => {
                const { pattern: _, ...rest } = step;
                onChange((pattern === "" ? rest : { ...step, pattern }) as Step);
              }}
            />
            {patternError === null ? null : <p className="field__error">{patternError}</p>}
            <p className="field__hint">{t("analysis.filterFields.patternHelp")}</p>
          </div>
          {result === null ? null : (
            <p className="field__hint step__wide">
              {t("analysis.filterFields.kept", { kept: result.fields, total: fields.length })}
            </p>
          )}
        </div>
      );
    }
    case "filterRows": {
      const result = kept(step, nf);
      const setCondition = (i: number, next: RowCondition) =>
        set({ conditions: step.conditions.map((c, j) => (j === i ? next : c)) });
      return (
        <div className="step__form">
          {help}
          {frameChoice}
          <KeepDropChoice
            label={t("analysis.filterRows.mode")}
            value={step.mode}
            onChange={(mode) => set({ mode })}
          />
          <Choice
            label={t("analysis.filterRows.match")}
            value={step.match}
            options={(["all", "any"] as const).map((m) => [m, t(`analysis.match.${m}`)])}
            onChange={(match) => set({ match: match as MatchMode })}
          />
          <fieldset className="step__aggregations">
            <legend className="field__label">{t("analysis.filterRows.conditions")}</legend>
            {step.conditions.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
              <div className="step__aggregation" key={i}>
                <FieldChoice
                  label={t("analysis.field.field")}
                  value={c.field}
                  fields={fields}
                  onChange={(field) => setCondition(i, { ...c, field })}
                />
                <Choice
                  label={t("analysis.filterRows.op")}
                  value={c.op}
                  options={ROW_OPS.map((op) => [op, t(`analysis.rowOp.${op}`)])}
                  onChange={(value) => {
                    const op = value as RowOp;
                    const { value: v, to: _, ...rest } = c;
                    if (NO_VALUE.includes(op)) setCondition(i, { ...rest, op });
                    else if (op === "between") {
                      setCondition(i, { ...rest, op, value: v ?? "", to: c.to ?? "" });
                    } else setCondition(i, { ...rest, op, value: v ?? "" });
                  }}
                />
                {NO_VALUE.includes(c.op) ? null : (
                  <Text
                    label={t("analysis.filterRows.value")}
                    value={String(c.value ?? "")}
                    onChange={(value) => setCondition(i, { ...c, value })}
                  />
                )}
                {c.op === "between" ? (
                  <Text
                    label={t("analysis.filterRows.to")}
                    value={String(c.to ?? "")}
                    onChange={(to) => setCondition(i, { ...c, to })}
                  />
                ) : null}
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("analysis.filterRows.remove", { n: i + 1 })}
                  disabled={step.conditions.length === 1}
                  onClick={() => set({ conditions: step.conditions.filter((_, j) => j !== i) })}
                >
                  {t("analysis.steps.remove")}
                </button>
              </div>
            ))}
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() =>
                set({
                  conditions: [
                    ...step.conditions,
                    { field: fields[0]?.name ?? "", op: "notEmpty" },
                  ],
                })
              }
            >
              {t("analysis.filterRows.add")}
            </button>
          </fieldset>
          {result === null ? null : (
            <p className="field__hint step__wide">
              {t("analysis.filterRows.kept", {
                kept: result.rows,
                total: nf?.frame.fields[0]?.values.length ?? 0,
              })}
            </p>
          )}
        </div>
      );
    }
    case "limit":
      return (
        <div className="step__form">
          {help}
          {frameChoice}
          <NumberField
            label={t("analysis.limit.count")}
            value={step.count}
            min={1}
            max={MAX_LIMIT}
            onChange={(count) => set({ count })}
          />
          <Choice
            label={t("analysis.limit.from")}
            value={step.from ?? "first"}
            options={(["first", "last"] as const).map((f) => [f, t(`analysis.limitFrom.${f}`)])}
            onChange={(from) => {
              const { from: _, ...rest } = step;
              onChange((from === "first" ? rest : { ...step, from: from as LimitFrom }) as Step);
            }}
          />
        </div>
      );
    case "convert": {
      const setConversion = (i: number, next: Conversion) =>
        set({ conversions: step.conversions.map((c, j) => (j === i ? next : c)) });
      return (
        <div className="step__form">
          {help}
          {frameChoice}
          <fieldset className="step__aggregations">
            <legend className="field__label">{t("analysis.field.fields")}</legend>
            {step.conversions.map((c, i) => {
              const source = fields.find((f) => f.name === c.field);
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
                <div className="step__aggregation" key={i}>
                  <FieldChoice
                    label={t("analysis.field.field")}
                    value={c.field}
                    fields={fields.filter(
                      (f) =>
                        f.name === c.field || !step.conversions.some((o) => o.field === f.name),
                    )}
                    onChange={(field) => setConversion(i, { ...c, field })}
                  />
                  <Choice
                    label={t("analysis.convert.to")}
                    value={c.to}
                    options={CONVERT_TO.map((to) => [to, t(`analysis.convertTo.${to}`)])}
                    onChange={(to) => {
                      const { format: _, ...rest } = c;
                      setConversion(
                        i,
                        to === "time" ? { ...c, to } : { ...rest, to: to as ConvertTo },
                      );
                    }}
                  />
                  {c.to === "time" && (source === undefined || source.type === "string") ? (
                    <Text
                      label={t("analysis.convert.format")}
                      value={c.format ?? ""}
                      onChange={(format) => {
                        const { format: _, ...rest } = c;
                        setConversion(i, format === "" ? rest : { ...c, format });
                      }}
                    />
                  ) : null}
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.convert.remove", { n: i + 1 })}
                    disabled={step.conversions.length === 1}
                    onClick={() => set({ conversions: step.conversions.filter((_, j) => j !== i) })}
                  >
                    {t("analysis.steps.remove")}
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => {
                const free = fields.find((f) => !step.conversions.some((c) => c.field === f.name));
                set({
                  conversions: [...step.conversions, { field: free?.name ?? "", to: "number" }],
                });
              }}
            >
              {t("analysis.convert.add")}
            </button>
          </fieldset>
          {step.conversions.some((c) => c.to === "time") ? (
            <p className="field__hint step__wide">{t("analysis.convert.formatHelp")}</p>
          ) : null}
        </div>
      );
    }
    case "reduceSeries": {
      const series = fields.filter((f) => isNumeric(f.type)).map((f) => f.name);
      return (
        <div className="step__form">
          {help}
          {frameChoice}
          <Choice
            label={t("analysis.reduce.mode")}
            value={step.mode}
            options={(["rows", "columns"] as const).map((m) => [m, t(`analysis.reduceMode.${m}`)])}
            onChange={(mode) => set({ mode: mode as ReduceMode })}
          />
          <Checks
            legend={t("analysis.reduce.calculations")}
            options={AGGS.map((a) => [a, t(`analysis.stat.${a}` as MessageKey)])}
            value={step.calculations}
            onChange={(selected) => {
              const calculations = AGGS.filter((a) => selected.includes(a));
              if (calculations.length > 0) set({ calculations: calculations as Agg[] });
            }}
          />
          <Checks
            legend={t("analysis.reduce.fields")}
            options={withCurrent(series, step.fields ?? []).map((n) => [n, n])}
            value={step.fields ?? []}
            onChange={(selected) => {
              const { fields: _, ...rest } = step;
              onChange((selected.length === 0 ? rest : { ...step, fields: selected }) as Step);
            }}
          />
          <p className="field__hint step__wide">{t("analysis.reduce.fieldsHint")}</p>
        </div>
      );
    }
  }
}

function KeepDropChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: KeepDrop;
  onChange: (value: KeepDrop) => void;
}) {
  const { t } = useI18n();
  return (
    <Choice
      label={label}
      value={value}
      options={(["keep", "drop"] as const).map((m) => [m, t(`analysis.keepDrop.${m}`)])}
      onChange={(next) => onChange(next as KeepDrop)}
    />
  );
}

/**
 * The fields in the order the step puts them, each with whether it shows and a new name. Names
 * the step lists that the result lacks stay in the list, marked, so a field the query lost for
 * now keeps its settings.
 */
function OrganizeList({
  step,
  fields,
  onChange,
}: {
  step: Extract<Step, { type: "organize" }>;
  fields: readonly Field[];
  onChange: (step: Step) => void;
}) {
  const { t } = useI18n();
  const present = [...new Set(fields.map((f) => f.name))];
  const order = step.order ?? [];
  const names = [...order, ...present.filter((n) => !order.includes(n))].filter(
    (n, i, all) => all.indexOf(n) === i,
  );
  // Settings for fields the result lacks follow the order too.
  for (const n of [...(step.hide ?? []), ...Object.keys(step.rename ?? {})]) {
    if (!names.includes(n)) names.push(n);
  }
  if (names.length === 0) {
    return <p className="field__hint step__wide">{t("analysis.organize.noFields")}</p>;
  }
  const hidden = new Set(step.hide ?? []);
  const rename = step.rename ?? {};
  const write = (patch: { order?: string[]; hide?: string[]; rename?: Record<string, string> }) => {
    const next: Record<string, unknown> = { ...step, ...patch };
    for (const key of ["order", "hide"] as const) {
      if ((next[key] as string[] | undefined)?.length === 0) delete next[key];
    }
    if (Object.keys((next.rename as Record<string, string> | undefined) ?? {}).length === 0) {
      delete next.rename;
    }
    onChange(next as Step);
  };
  const move = (i: number, by: number) => {
    const next = [...names];
    const [n] = next.splice(i, 1);
    if (n === undefined) return;
    next.splice(i + by, 0, n);
    write({ order: next });
  };
  return (
    <fieldset className="step__organize step__wide">
      <legend className="field__label">{t("analysis.organize.fields")}</legend>
      <ol className="step__organize-list">
        {names.map((n, i) => {
          const missing = !present.includes(n);
          return (
            <li key={n} className="step__organize-row">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={!hidden.has(n)}
                  aria-label={t("analysis.organize.show", { field: n })}
                  onChange={(event) =>
                    write({
                      hide: event.currentTarget.checked
                        ? [...hidden].filter((h) => h !== n)
                        : [...hidden, n],
                    })
                  }
                />
                <span className={missing ? "step__organize-missing" : undefined}>
                  {missing ? t("analysis.organize.missing", { field: n }) : n}
                </span>
              </label>
              <input
                className="input"
                value={rename[n] ?? ""}
                placeholder={n}
                aria-label={t("analysis.organize.newName", { field: n })}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  const { [n]: _, ...rest } = rename;
                  write({ rename: value === "" ? rest : { ...rest, [n]: value } });
                }}
              />
              <span className="step__organize-moves">
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("analysis.organize.up", { field: n })}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <Icon name="arrowUp" />
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("analysis.organize.down", { field: n })}
                  disabled={i === names.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <Icon name="arrowDown" />
                </button>
              </span>
            </li>
          );
        })}
      </ol>
    </fieldset>
  );
}
