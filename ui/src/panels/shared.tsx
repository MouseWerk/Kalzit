import { useId } from "react";
import type { Frame } from "../api/generated/shapes";
import { useI18n } from "../i18n/i18n";
import { rowCount } from "./frame";
import "./panels.css";
import "../features/dashboards/ui/shared.css";

const EMPTY_REASONS = {
  noData: "dashboards.panels.empty.noData",
  noTimeSeries: "dashboards.panels.empty.noTimeSeries",
  noValues: "dashboards.panels.empty.noValues",
} as const;

type EmptyReason = keyof typeof EMPTY_REASONS;

/** What a panel shows when the data has nothing it can draw, and why. */
export function EmptyPanel({ reason }: { reason: EmptyReason }) {
  const { t } = useI18n();
  return <p className="panel-empty">{t(EMPTY_REASONS[reason])}</p>;
}

/**
 * Why there is nothing to draw: without any row the query found no data, which says more than the
 * panel's own reason. An empty result also has no values to tell a column's type by, so a number
 * column can arrive as text and the panel's reason would be wrong.
 */
export function emptyReason(frames: readonly Frame[], otherwise: EmptyReason): EmptyReason {
  return frames.every((frame) => rowCount(frame) === 0) ? "noData" : otherwise;
}

/** A labelled select over fixed choices, as every panel editor needs a few. */
export function SelectField<T extends string>({
  id,
  label,
  value,
  choices,
  onChange,
  hint,
}: {
  id?: string;
  label: string;
  value: T;
  choices: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
  hint?: string;
}) {
  const own = useId();
  const fieldId = id ?? own;
  return (
    <div className="field">
      <label className="field__label" htmlFor={fieldId}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="field__hint" id={`${fieldId}-hint`}>
          {hint}
        </p>
      )}
      <select
        id={fieldId}
        className="select"
        value={value}
        aria-describedby={hint === undefined ? undefined : `${fieldId}-hint`}
        onChange={(event) => {
          const next = choices.find(([choice]) => choice === event.currentTarget.value);
          if (next !== undefined) {
            onChange(next[0]);
          }
        }}
      >
        {choices.map(([choice, text]) => (
          <option key={choice} value={choice}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * A number input that may be empty (undefined). Invalid or out-of-range text is kept while
 * typing and only reported as a value when it parses within the bounds.
 */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  hint?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
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
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step ?? "any"}
        placeholder={placeholder}
        defaultValue={value ?? ""}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => {
          const text = event.currentTarget.value.trim();
          if (text === "") {
            onChange(undefined);
            return;
          }
          const number = Number(text);
          if (
            Number.isFinite(number) &&
            (min === undefined || number >= min) &&
            (max === undefined || number <= max)
          ) {
            onChange(number);
          }
        }}
      />
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  maxLength,
  hint,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  hint?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
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
        className={mono === true ? "input input--mono" : "input"}
        value={value}
        maxLength={maxLength}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <label className="checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {label}
    </label>
  );
}
