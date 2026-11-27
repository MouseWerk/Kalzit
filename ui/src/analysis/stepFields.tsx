import { useId } from "react";
import type { Field } from "../api/generated/shapes";
import { Select } from "../components/Select";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";

/*
 * The small form fields the step forms share: text, numbers, a choice, a field of the input and
 * check boxes.
 */

/** The options, plus the current values a stale list lacks, so nothing is lost silently. */
export function withCurrent(options: readonly string[], current: readonly string[]): string[] {
  return [...options, ...current.filter((c) => c !== "" && !options.includes(c))];
}

export function Text({
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

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  decimals = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** The allowed range or what the value means, under the field. */
  hint?: string | undefined;
  /** Takes fractions (a damping, a tolerance), not only whole numbers. */
  decimals?: boolean;
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
        step={decimals ? "any" : undefined}
        value={value}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => {
          const raw = Number(event.currentTarget.value);
          const n = decimals ? raw : Math.round(raw);
          if (Number.isFinite(n)) onChange(Math.min(Math.max(n, min), max));
        }}
      />
      {hint === undefined ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Choice({
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
      <Select id={id} value={value} onChange={(next) => onChange(next)}>
        {list.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </Select>
    </div>
  );
}

/** A field of the step's input; free text until the query ran and its fields are known. */
export function FieldChoice({
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

export function Checks({
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
