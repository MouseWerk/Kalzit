import { type KeyboardEvent, type Ref, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { MIN_PASSWORD_LENGTH, passwordStrength } from "./validation";
import "./auth.css";

interface PasswordFieldProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  name: string;
  autoComplete: "current-password" | "new-password";
  hint?: string | undefined;
  error?: string | undefined;
  /** Shows how strong a new password is while it is typed (setup, new accounts). */
  showStrength?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/**
 * A password input with a show/hide toggle and a caps-lock warning. Hint, warning, strength and
 * error are all linked through aria-describedby, so a screen reader reads them with the field.
 */
export function PasswordField({
  label,
  value,
  onValueChange,
  name,
  autoComplete,
  hint,
  error,
  showStrength = false,
  ref,
}: PasswordFieldProps) {
  const { t } = useI18n();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const capsId = `${id}-caps`;
  const strengthId = `${id}-strength`;
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);

  // A shown password is hidden again once the form is sent and when the page goes away (another
  // tab, the back-forward cache), so it never stays readable on a screen left alone.
  useEffect(() => {
    const form = fieldRef.current?.closest("form");
    const hide = () => setVisible(false);
    const hideWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        hide();
      }
    };
    form?.addEventListener("submit", hide);
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", hideWhenHidden);
    return () => {
      form?.removeEventListener("submit", hide);
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", hideWhenHidden);
    };
  }, []);

  const strength = showStrength ? passwordStrength(value) : null;
  const describedBy = [
    error === undefined ? null : errorId,
    capsLock ? capsId : null,
    hint === undefined ? null : hintId,
    strength === null || strength.level === "empty" ? null : strengthId,
  ]
    .filter((part) => part !== null)
    .join(" ");

  // getModifierState is the only reliable source; it is read on every key, so turning Caps Lock
  // off while typing hides the warning again.
  function readCapsLock(event: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(event.getModifierState("CapsLock"));
  }

  let strengthText: string | null = null;
  if (strength !== null) {
    if (strength.level === "short") {
      strengthText = t("password.strengthShort", {
        count: strength.length,
        min: MIN_PASSWORD_LENGTH,
      });
    } else if (strength.level === "fair") {
      strengthText = t("password.strengthFair");
    } else if (strength.level === "strong") {
      strengthText = t("password.strengthStrong");
    }
  }
  const bars = strength === null ? 0 : { empty: 0, short: 1, fair: 2, strong: 3 }[strength.level];

  return (
    <div className="field" ref={fieldRef}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      <div className="password">
        <input
          ref={ref}
          id={id}
          className="input password__input"
          type={visible ? "text" : "password"}
          name={name}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={value}
          onChange={(event) => onValueChange(event.currentTarget.value)}
          onKeyDown={readCapsLock}
          onKeyUp={readCapsLock}
          onBlur={() => setCapsLock(false)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy === "" ? undefined : describedBy}
        />
        <button
          type="button"
          className="password__toggle"
          aria-controls={id}
          aria-label={visible ? t("password.hide") : t("password.show")}
          onClick={() => setVisible(!visible)}
        >
          <Icon name={visible ? "eyeOff" : "eye"} />
        </button>
      </div>
      {/* Mounted while the field is, so the warning is announced when it appears. */}
      <div className="password__status" aria-live="polite">
        {capsLock ? (
          <p className="password__caps" id={capsId}>
            <Icon name="capsLock" />
            <span>{t("password.capsLock")}</span>
          </p>
        ) : null}
      </div>
      {strengthText === null ? null : (
        <div className="strength" id={strengthId}>
          <span className="strength__bars" aria-hidden="true">
            {[1, 2, 3].map((bar) => (
              <span
                key={bar}
                className={bar <= bars ? "strength__bar strength__bar--on" : "strength__bar"}
              />
            ))}
          </span>
          <span className="strength__text">{strengthText}</span>
        </div>
      )}
      {error === undefined ? null : (
        <p className="field__error" id={errorId}>
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
