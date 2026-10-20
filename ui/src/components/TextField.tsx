import { type InputHTMLAttributes, type Ref, useId } from "react";
import { Icon } from "./Icon";

type NativeInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "value" | "onChange" | "aria-invalid" | "aria-describedby" | "className"
>;

interface TextFieldProps extends NativeInputProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Shown up front, before any error, so rules are known before the first attempt. */
  hint?: string | undefined;
  error?: string | undefined;
  mono?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/**
 * A labelled input. Hint and error are linked through aria-describedby, so a screen reader reads
 * the rule and the problem together with the field when it receives focus.
 */
export function TextField({
  label,
  value,
  onValueChange,
  hint,
  error,
  mono = false,
  ref,
  ...inputProps
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error === undefined ? null : errorId, hint === undefined ? null : hintId]
    .filter((part) => part !== null)
    .join(" ");

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <input
        {...inputProps}
        ref={ref}
        id={id}
        className={mono ? "input input--mono" : "input"}
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === "" ? undefined : describedBy}
      />
      {error === undefined ? null : (
        <p className="field__error" id={errorId}>
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
