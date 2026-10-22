import { type ReactNode, useId, useState } from "react";
import type { Field, Frame } from "../api/generated/shapes";
import { reasonText } from "../features/datasources/reasons";
import { type MessageKey, type Translate, useI18n } from "../i18n/i18n";
import { formatValue } from "../panels/frame";
import { DetailError, FUNCTIONS, parse } from "./expr";
import {
  AGGS,
  type Agg,
  type Aggregation,
  MAX_STEPS,
  MAX_WINDOW,
  type NamedFrame,
  runSteps,
  STATS,
  STEP_TYPES,
  type Step,
  type StepKind,
  type StepType,
} from "./steps";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";

/** Rows the preview shows. */
const PREVIEW_ROWS = 20;

interface StepsEditorProps {
  steps: readonly Step[];
  onChange: (steps: Step[]) => void;
  /** The queries' reference ids, which steps work on. */
  refIds: readonly string[];
  /** The queries' frames as answered; empty until they ran. */
  frames: readonly NamedFrame[];
}

const numeric = (f: Field) => f.type === "number" || f.type === "int64";

/**
 * Edits a list of analysis steps: add, reorder, turn off, remove, and a preview of the frames
 * after any step. The steps run here as they will in the panel (docs/api/analysis.md).
 */
export function StepsEditor({ steps, onChange, refIds, frames }: StepsEditorProps) {
  const { t } = useI18n();
  const headingId = useId();
  const addId = useId();
  const [adding, setAdding] = useState<StepType>("calculate");
  // The step whose result the preview shows; -1 shows the queries' results.
  const [previewAt, setPreviewAt] = useState(-1);
  const run = runSteps(steps, frames);
  const hasData = frames.length > 0;

  const update = (index: number, step: Step) =>
    onChange(steps.map((s, i) => (i === index ? step : s)));
  const move = (index: number, by: number) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    if (step === undefined) return;
    next.splice(index + by, 0, step);
    onChange(next);
    if (previewAt === index) setPreviewAt(index + by);
  };
  const remove = (index: number) => {
    onChange(steps.filter((_, i) => i !== index));
    if (previewAt >= index) setPreviewAt(previewAt - 1);
  };
  /** The frames a step reads: what the step before it made, or the queries' results. */
  const inputOf = (index: number): readonly NamedFrame[] => {
    for (let i = index - 1; i >= 0; i--) {
      const out = run.steps[i]?.frames;
      if (out !== undefined) return out;
      if (run.steps[i]?.skipped !== true) return [];
    }
    return frames;
  };
  const previewFrames =
    previewAt < 0 ? frames : (run.steps[previewAt]?.frames ?? inputOf(previewAt + 1));

  return (
    <section className="steps" aria-labelledby={headingId}>
      <h3 className="steps__heading" id={headingId}>
        {t("analysis.steps.title")}
      </h3>
      <p className="field__hint">{t("analysis.steps.lead")}</p>
      {steps.length === 0 ? <p className="field__hint">{t("analysis.steps.empty")}</p> : null}
      <ol className="steps__list">
        {steps.map((step, index) => {
          const outcome = run.steps[index];
          const n = index + 1;
          let status: ReactNode;
          if (step.disabled === true) {
            status = t("analysis.steps.status.off");
          } else if (outcome?.error !== undefined) {
            status = (
              <span className="steps__error" role="alert">
                {reasonText(t, {
                  reason: outcome.error.reason,
                  params: outcome.error.params,
                  fallback: outcome.error.message,
                }) ?? outcome.error.message}
              </span>
            );
          } else if (!hasData) {
            status = t("analysis.steps.status.noData");
          } else if (outcome?.skipped === true) {
            status = t("analysis.steps.status.notRun");
          } else {
            const target = outcome?.frames?.find((f) => stepTarget(step) === f.name)?.frame;
            status = t("analysis.steps.status.rows", {
              rows: target?.fields[0]?.values.length ?? 0,
              fields: target?.fields.length ?? 0,
            });
          }
          return (
            <li key={step.id} className="step" aria-label={t("analysis.steps.number", { n })}>
              <div className="step__header">
                <span className="step__number">{n}</span>
                <span className="step__title">{t(`analysis.kind.${step.type}`)}</span>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={step.disabled !== true}
                    onChange={(event) => {
                      const { disabled: _, ...rest } = step;
                      update(
                        index,
                        event.currentTarget.checked ? (rest as Step) : { ...step, disabled: true },
                      );
                    }}
                  />
                  <span>{t("analysis.steps.enabled")}</span>
                </label>
                <div className="step__actions">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-pressed={previewAt === index}
                    aria-label={t("analysis.steps.previewNamed", { n })}
                    onClick={() => setPreviewAt(previewAt === index ? -1 : index)}
                  >
                    {t("analysis.steps.preview")}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.steps.up", { n })}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <span aria-hidden="true">↑</span>
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.steps.down", { n })}
                    disabled={index === steps.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <span aria-hidden="true">↓</span>
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("analysis.steps.removeNamed", { n })}
                    onClick={() => remove(index)}
                  >
                    {t("analysis.steps.remove")}
                  </button>
                </div>
              </div>
              <StepForm
                step={step}
                onChange={(next) => update(index, next)}
                refIds={refIds}
                input={inputOf(index)}
              />
              <p className="step__status">{status}</p>
            </li>
          );
        })}
      </ol>
      {steps.length < MAX_STEPS ? (
        <div className="steps__add">
          <label className="visually-hidden" htmlFor={addId}>
            {t("analysis.steps.addType")}
          </label>
          <select
            id={addId}
            className="select"
            value={adding}
            onChange={(event) => setAdding(event.currentTarget.value as StepType)}
          >
            {STEP_TYPES.filter((type) => type !== "join" || refIds.length > 1).map((type) => (
              <option key={type} value={type}>
                {t(`analysis.kind.${type}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              const input = run.frames.length > 0 ? run.frames : frames;
              onChange([...steps, newStep(adding, refIds, input, t)]);
            }}
          >
            {t("analysis.steps.add")}
          </button>
        </div>
      ) : null}
      {steps.length > 0 ? (
        <Preview
          frames={previewFrames}
          title={
            previewAt < 0
              ? t("analysis.preview.input")
              : t("analysis.preview.after", { n: previewAt + 1 })
          }
          onShowInput={previewAt < 0 ? undefined : () => setPreviewAt(-1)}
        />
      ) : null}
    </section>
  );
}

/** The frame a step writes. */
function stepTarget(step: StepKind): string {
  return step.type === "join" ? step.left : step.frame;
}

/** A new step of a kind, filled in from the frames it will read. */
export function newStep(
  type: StepType,
  refIds: readonly string[],
  input: readonly NamedFrame[],
  t: Translate,
): Step {
  const id = crypto.randomUUID();
  const frame = refIds[0] ?? "A";
  const fields = input.find((f) => f.name === frame)?.frame.fields ?? [];
  const firstNumber = fields.find(numeric)?.name ?? "";
  const firstOther = fields.find((f) => !numeric(f) && f.type !== "time")?.name ?? "";
  switch (type) {
    case "calculate":
      return { id, type, frame, name: t("analysis.default.calculate"), expression: firstNumber };
    case "join":
      return {
        id,
        type,
        left: frame,
        right: refIds[1] ?? frame,
        on: { by: "time" },
        mode: "outer",
      };
    case "reduce":
      return {
        id,
        type,
        frame,
        fields: firstNumber === "" ? [] : [firstNumber],
        stats: ["sum", "mean", "min", "max"],
      };
    case "trend":
      return {
        id,
        type,
        frame,
        field: firstNumber,
        output: "fitted",
        name: t("analysis.default.trend"),
      };
    case "movingAverage":
      return {
        id,
        type,
        frame,
        field: firstNumber,
        window: 7,
        name: t("analysis.default.movingAverage"),
      };
    case "correlate":
      return {
        id,
        type,
        frame,
        x: firstNumber,
        y: fields.filter(numeric)[1]?.name ?? firstNumber,
      };
    case "compare":
      return {
        id,
        type,
        frame,
        field: firstNumber,
        period: "week",
        output: "difference",
        name: t("analysis.default.compare"),
      };
    case "group":
      return {
        id,
        type,
        frame,
        by: firstOther === "" ? [] : [firstOther],
        aggregations: firstNumber === "" ? [] : [{ field: firstNumber, op: "sum" }],
      };
    case "pivot":
      return {
        id,
        type,
        frame,
        row: firstOther,
        column: fields.filter((f) => !numeric(f) && f.type !== "time")[1]?.name ?? firstOther,
        value: firstNumber,
        op: "sum",
      };
  }
}

// ---- forms ----

interface FormProps {
  step: Step;
  onChange: (step: Step) => void;
  refIds: readonly string[];
  input: readonly NamedFrame[];
}

function StepForm({ step, onChange, refIds, input }: FormProps) {
  const { t } = useI18n();
  const fieldsOf = (name: string) => input.find((f) => f.name === name)?.frame.fields ?? [];
  // Each kind's own fields; the shared frame choice comes first.
  const set = <K extends StepKind>(patch: Partial<K>) => onChange({ ...step, ...patch } as Step);
  const frameChoice =
    step.type === "join" ? null : (
      <Choice
        label={t("analysis.field.frame")}
        value={step.frame}
        options={refIds.map((r) => [r, r])}
        onChange={(frame) => set({ frame })}
        hidden={refIds.length < 2}
      />
    );
  switch (step.type) {
    case "calculate":
      return (
        <div className="step__form">
          {frameChoice}
          <Text
            label={t("analysis.field.name")}
            value={step.name}
            onChange={(name) => set({ name })}
          />
          <ExpressionField step={step} onChange={(expression) => set({ expression })} />
        </div>
      );
    case "join": {
      const on = step.on;
      return (
        <div className="step__form">
          <Choice
            label={t("analysis.field.left")}
            value={step.left}
            options={refIds.map((r) => [r, r])}
            onChange={(left) => set({ left })}
          />
          <Choice
            label={t("analysis.field.right")}
            value={step.right}
            options={refIds.map((r) => [r, r])}
            onChange={(right) => set({ right })}
          />
          <Choice
            label={t("analysis.field.on")}
            value={on.by}
            options={[
              ["time", t("analysis.on.time")],
              ["key", t("analysis.on.key")],
            ]}
            onChange={(by) =>
              set({
                on: by === "time" ? { by: "time" } : { by: "key", leftField: "", rightField: "" },
              })
            }
          />
          {on.by === "key" ? (
            <>
              <FieldChoice
                label={t("analysis.field.leftField")}
                value={on.leftField}
                fields={fieldsOf(step.left)}
                onChange={(leftField) => set({ on: { ...on, leftField } })}
              />
              <FieldChoice
                label={t("analysis.field.rightField")}
                value={on.rightField}
                fields={fieldsOf(step.right)}
                onChange={(rightField) => set({ on: { ...on, rightField } })}
              />
            </>
          ) : null}
          <Choice
            label={t("analysis.field.mode")}
            value={step.mode}
            options={(["inner", "left", "outer"] as const).map((m) => [m, t(`analysis.mode.${m}`)])}
            onChange={(mode) => set({ mode: mode as typeof step.mode })}
          />
        </div>
      );
    }
    case "reduce": {
      const fields = fieldsOf(step.frame).filter(numeric);
      return (
        <div className="step__form">
          {frameChoice}
          <Checks
            legend={t("analysis.field.fields")}
            options={withCurrent(
              fields.map((f) => f.name),
              step.fields,
            ).map((n) => [n, n])}
            value={step.fields}
            onChange={(selected) => set({ fields: selected })}
          />
          <Checks
            legend={t("analysis.field.stats")}
            options={STATS.map((s) => [s, t(`analysis.stat.${s}`)])}
            value={step.stats}
            onChange={(selected) => {
              const stats = STATS.filter((s) => selected.includes(s));
              const next: Partial<typeof step> = { stats };
              if (stats.includes("percentile") && (step.percentiles ?? []).length === 0) {
                next.percentiles = [90];
              }
              if (!stats.includes("percentile")) next.percentiles = [];
              set(next);
            }}
          />
          {step.stats.includes("percentile") ? (
            <PercentilesField
              value={step.percentiles ?? []}
              onChange={(percentiles) => set({ percentiles })}
            />
          ) : null}
        </div>
      );
    }
    case "trend":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.field")}
            value={step.field}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(field) => set({ field })}
          />
          <FieldChoice
            label={t("analysis.field.x")}
            value={step.x ?? ""}
            fields={fieldsOf(step.frame).filter((f) => numeric(f) || f.type === "time")}
            empty={t("analysis.field.xDefault")}
            onChange={(x) => {
              const { x: _, ...rest } = step;
              onChange(x === "" ? (rest as Step) : { ...step, x });
            }}
          />
          <Choice
            label={t("analysis.field.output")}
            value={step.output}
            options={[
              ["fitted", t("analysis.trend.fitted")],
              ["summary", t("analysis.trend.summary")],
            ]}
            onChange={(output) => {
              const { name: _, ...rest } = step;
              onChange(
                output === "summary"
                  ? ({ ...rest, output: "summary" } as Step)
                  : { ...step, output: "fitted", name: step.name ?? t("analysis.default.trend") },
              );
            }}
          />
          {step.output === "fitted" ? (
            <Text
              label={t("analysis.field.name")}
              value={step.name ?? ""}
              onChange={(name) => set({ name })}
            />
          ) : null}
        </div>
      );
    case "movingAverage":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.field")}
            value={step.field}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(field) => set({ field })}
          />
          <NumberField
            label={t("analysis.field.window")}
            value={step.window}
            min={1}
            max={MAX_WINDOW}
            onChange={(window) => set({ window })}
          />
          <Text
            label={t("analysis.field.name")}
            value={step.name}
            onChange={(name) => set({ name })}
          />
        </div>
      );
    case "correlate":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.corrX")}
            value={step.x}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(x) => set({ x })}
          />
          <FieldChoice
            label={t("analysis.field.corrY")}
            value={step.y}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(y) => set({ y })}
          />
        </div>
      );
    case "compare":
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.field")}
            value={step.field}
            fields={fieldsOf(step.frame).filter(numeric)}
            onChange={(field) => set({ field })}
          />
          <FieldChoice
            label={t("analysis.field.time")}
            value={step.time ?? ""}
            fields={fieldsOf(step.frame).filter((f) => f.type === "time")}
            empty={t("analysis.field.timeDefault")}
            onChange={(time) => {
              const { time: _, ...rest } = step;
              onChange(time === "" ? (rest as Step) : { ...step, time });
            }}
          />
          <Choice
            label={t("analysis.field.period")}
            value={step.period}
            options={(["week", "month", "year"] as const).map((p) => [
              p,
              t(`analysis.period.${p}`),
            ])}
            onChange={(period) => set({ period: period as typeof step.period })}
          />
          <Choice
            label={t("analysis.field.output")}
            value={step.output}
            options={(["previous", "difference", "percent"] as const).map((o) => [
              o,
              t(`analysis.compare.${o}`),
            ])}
            onChange={(output) => set({ output: output as typeof step.output })}
          />
          <Text
            label={t("analysis.field.name")}
            value={step.name}
            onChange={(name) => set({ name })}
          />
          <p className="field__hint step__wide">{t("analysis.compare.hint")}</p>
        </div>
      );
    case "group":
      return (
        <GroupForm
          step={step}
          fields={fieldsOf(step.frame)}
          frameChoice={frameChoice}
          onChange={(next) => onChange({ ...step, ...next })}
        />
      );
    case "pivot": {
      const fields = fieldsOf(step.frame);
      const keys = fields.filter((f) => f.type !== "json");
      return (
        <div className="step__form">
          {frameChoice}
          <FieldChoice
            label={t("analysis.field.row")}
            value={step.row}
            fields={keys}
            onChange={(row) => set({ row })}
          />
          <FieldChoice
            label={t("analysis.field.column")}
            value={step.column}
            fields={keys}
            onChange={(column) => set({ column })}
          />
          <FieldChoice
            label={t("analysis.field.value")}
            value={step.value}
            fields={fields}
            onChange={(value) => set({ value })}
          />
          <Choice
            label={t("analysis.field.op")}
            value={step.op}
            options={AGGS.map((a) => [a, aggLabel(t, a)])}
            onChange={(op) => set({ op: op as Agg })}
          />
        </div>
      );
    }
  }
}

function aggLabel(t: Translate, op: Agg): string {
  return t(`analysis.stat.${op}` as MessageKey);
}

/** The options, plus the current values a stale list lacks, so nothing is lost silently. */
function withCurrent(options: readonly string[], current: readonly string[]): string[] {
  return [...options, ...current.filter((c) => c !== "" && !options.includes(c))];
}

function GroupForm({
  step,
  fields,
  frameChoice,
  onChange,
}: {
  step: Extract<Step, { type: "group" }>;
  fields: readonly Field[];
  frameChoice: ReactNode;
  onChange: (patch: { by?: string[]; aggregations?: Aggregation[] }) => void;
}) {
  const { t } = useI18n();
  const legendId = useId();
  const keys = fields.filter((f) => f.type !== "json").map((f) => f.name);
  const setAgg = (index: number, patch: Partial<Aggregation>) =>
    onChange({
      aggregations: step.aggregations.map((a, i) => {
        if (i !== index) return a;
        const next = { ...a, ...patch };
        if (next.name === "") delete next.name;
        return next;
      }),
    });
  return (
    <div className="step__form">
      {frameChoice}
      <Checks
        legend={t("analysis.field.by")}
        options={withCurrent(keys, step.by).map((n) => [n, n])}
        value={step.by}
        onChange={(by) => onChange({ by })}
      />
      <fieldset className="step__aggregations" aria-labelledby={legendId}>
        <span className="field__label" id={legendId}>
          {t("analysis.field.aggregations")}
        </span>
        {step.aggregations.map((a, i) => (
          // The list has no ids; position is what the user edits.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position
          <div className="step__aggregation" key={i}>
            <FieldChoice
              label={t("analysis.field.field")}
              value={a.field}
              fields={fields}
              onChange={(field) => setAgg(i, { field })}
            />
            <Choice
              label={t("analysis.field.op")}
              value={a.op}
              options={AGGS.map((op) => [op, aggLabel(t, op)])}
              onChange={(op) => setAgg(i, { op: op as Agg })}
            />
            <Text
              label={t("analysis.field.aggName")}
              value={a.name ?? ""}
              onChange={(name) => setAgg(i, { name })}
            />
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label={t("analysis.group.remove", { n: i + 1 })}
              onClick={() =>
                onChange({ aggregations: step.aggregations.filter((_, j) => j !== i) })
              }
            >
              {t("analysis.steps.remove")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() =>
            onChange({
              aggregations: [
                ...step.aggregations,
                { field: fields.find(numeric)?.name ?? fields[0]?.name ?? "", op: "sum" },
              ],
            })
          }
        >
          {t("analysis.group.add")}
        </button>
      </fieldset>
    </div>
  );
}

function ExpressionField({
  step,
  onChange,
}: {
  step: Extract<Step, { type: "calculate" }>;
  onChange: (expression: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  let syntaxError: string | null = null;
  try {
    parse(step.expression);
  } catch (e) {
    if (e instanceof DetailError) {
      syntaxError =
        reasonText(t, { reason: e.detail.reason, params: e.detail.params, fallback: e.message }) ??
        e.message;
    }
  }
  return (
    <div className="field step__wide">
      <label className="field__label" htmlFor={id}>
        {t("analysis.field.expression")}
      </label>
      <textarea
        id={id}
        className="input input--mono step__expression"
        value={step.expression}
        spellCheck={false}
        aria-invalid={syntaxError !== null}
        aria-describedby={`${id}-help${syntaxError === null ? "" : ` ${id}-error`}`}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {syntaxError === null ? null : (
        <p className="field__error" id={`${id}-error`}>
          {syntaxError}
        </p>
      )}
      <p className="field__hint" id={`${id}-help`}>
        {t("analysis.field.expressionHelp", {
          functions: FUNCTIONS.map(([name]) => (name === "startof" ? "startOf" : name)).join(", "),
        })}
      </p>
    </div>
  );
}

function Text({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
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
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
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
        min={min}
        max={max}
        value={value}
        onChange={(event) => {
          const n = Math.round(Number(event.currentTarget.value));
          if (Number.isFinite(n)) onChange(Math.min(Math.max(n, min), max));
        }}
      />
    </div>
  );
}

function PercentilesField({
  value,
  onChange,
}: {
  value: readonly number[];
  onChange: (value: number[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(value.join(", "));
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("analysis.field.percentiles")}
      </label>
      <input
        id={id}
        className="input"
        value={text}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          // "90, 99" and "90 99,5" both read: spaces or semicolons separate, a comma inside a
          // number is the German decimal mark.
          const parsed = next
            .split(/[\s;]+/)
            .map((p) => p.replace(/,$/, "").replace(",", "."))
            .filter((p) => p !== "")
            .map(Number)
            .filter(
              (p, i, all) => Number.isFinite(p) && p >= 0 && p <= 100 && all.indexOf(p) === i,
            );
          if (parsed.length > 0) onChange(parsed.slice(0, 10));
        }}
      />
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  hidden = false,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
  hidden?: boolean;
}) {
  const id = useId();
  if (hidden) return null;
  const list = options.some(([v]) => v === value) ? options : [[value, value] as const, ...options];
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {list.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A field of the step's input; free text until the query ran and its fields are known. */
function FieldChoice({
  label,
  value,
  fields,
  onChange,
  empty,
}: {
  label: string;
  value: string;
  fields: readonly Field[];
  onChange: (value: string) => void;
  /** Offers "none" with this text (an optional field). */
  empty?: string;
}) {
  if (fields.length === 0) {
    return <Text label={label} value={value} onChange={onChange} />;
  }
  const names = withCurrent(
    fields.map((f) => f.name),
    [value],
  );
  const options: [string, string][] = names.map((n) => [n, n]);
  if (empty !== undefined) options.unshift(["", empty]);
  return <Choice label={label} value={value} options={options} onChange={onChange} />;
}

function Checks({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly (readonly [string, string])[];
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="step__checks step__wide">
      <legend className="field__label">{legend}</legend>
      {options.map(([v, text]) => (
        <label key={v} className="checkbox">
          <input
            type="checkbox"
            checked={value.includes(v)}
            onChange={(event) =>
              onChange(event.currentTarget.checked ? [...value, v] : value.filter((x) => x !== v))
            }
          />
          <span>{text}</span>
        </label>
      ))}
    </fieldset>
  );
}

// ---- preview ----

function Preview({
  frames,
  title,
  onShowInput,
}: {
  frames: readonly NamedFrame[];
  title: string;
  onShowInput: (() => void) | undefined;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const current = frames.find((f) => f.name === chosen) ?? frames[0];
  return (
    <section className="steps__preview" aria-labelledby={`${id}-title`}>
      <div className="steps__preview-bar">
        <h4 className="steps__heading" id={`${id}-title`}>
          {title}
        </h4>
        {frames.length > 1 ? (
          <Choice
            label={t("analysis.preview.frame")}
            value={current?.name ?? ""}
            options={frames.map((f) => [f.name, f.name])}
            onChange={setChosen}
          />
        ) : null}
        {onShowInput === undefined ? null : (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onShowInput}
          >
            {t("analysis.preview.showInput")}
          </button>
        )}
      </div>
      {current === undefined ? (
        <p className="field__hint">{t("analysis.preview.none")}</p>
      ) : (
        <PreviewTable frame={current.frame} language={language} />
      )}
    </section>
  );
}

function PreviewTable({ frame, language }: { frame: Frame; language: string }) {
  const { t } = useI18n();
  const rows = frame.fields[0]?.values.length ?? 0;
  const shown = Math.min(rows, PREVIEW_ROWS);
  if (rows === 0) return <p className="field__hint">{t("analysis.preview.empty")}</p>;
  return (
    <div className="steps__table">
      <table className="data-table">
        <thead>
          <tr>
            {frame.fields.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: field names may repeat
              <th key={i} scope="col">
                {f.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: shown }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
            <tr key={row}>
              {frame.fields.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: field names may repeat
                <td key={i}>{formatValue(f.type, f.values[row], language)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows > shown ? (
        <p className="field__hint">{t("analysis.preview.rows", { shown, rows })}</p>
      ) : null}
    </div>
  );
}
