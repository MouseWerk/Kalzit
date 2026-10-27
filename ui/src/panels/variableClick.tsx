import { useId, useState } from "react";
import { isRecord } from "../api/client";
import { useI18n } from "../i18n/i18n";
import { clipChars } from "../lib/chars";
import { setVariableFromClick, usePanelHost } from "./host";
import "../features/dashboards/ui/shared.css";

/**
 * A clicked value as the text a variable takes: text as is, numbers and booleans as their text,
 * typed values (`{"$type": "int64", "value": "..."}`, object ids, dates) as their value. Objects,
 * lists and missing values give none: a variable holds one plain value.
 */
export function variableText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (isRecord(value) && typeof value.$type === "string" && value.$type !== "document") {
    const inner = value.value;
    if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") {
      return String(inner);
    }
  }
  return null;
}

/** Longest variable name a panel stores (the server's limit for graph texts). */
export const MAX_VARIABLE_CHARS = 100;

/**
 * A one-line click option as stored: control characters taken out (the server refuses them),
 * the ends trimmed, cut to `max` characters; a variable name without a leading `$`.
 */
export function clickOption(value: unknown, max: number, variable = false): string {
  if (typeof value !== "string") {
    return "";
  }
  // \p{Cc}: the characters Rust's `char::is_control` names.
  const text = clipChars(value.replace(/\p{Cc}/gu, "").trim(), max);
  return variable ? text.replace(/^\$/, "") : text;
}

/** The texts of a click option: what a click sets, and the field the value comes from. */
export interface ClickOptionTexts {
  /** Label of the variable list ("Clicking a row sets"). */
  trigger: string;
  hint: string;
  /** Hint when the dashboard has no variables. */
  none: string;
  off: string;
  source: string;
  sourceHint: string;
}

/**
 * Which dashboard variable a click in a panel sets, and from which property, path or column: the
 * one pattern of the graph, path, document and table panels. The list offers the dashboard's
 * variables, plus a stored name the dashboard no longer has, so it is not lost silently.
 */
export function ClickVariableOptions({
  id,
  names,
  variable,
  source,
  texts,
  maxLength = 100,
  onChange,
}: {
  id: string;
  names: readonly string[];
  variable: string;
  source: string;
  texts: ClickOptionTexts;
  maxLength?: number;
  onChange: (patch: { variable?: string; source?: string }) => void;
}) {
  const sourceId = useId();
  const [text, setText] = useState(source);
  // A value changed from outside (undo, another editor) replaces the typed text; the stored form
  // of what is typed (trimmed) leaves it alone.
  const [shown, setShown] = useState(source);
  if (shown !== source) {
    setShown(source);
    if (clickOption(text, maxLength) !== source) {
      setText(source);
    }
  }
  const choices = names.includes(variable) || variable === "" ? names : [variable, ...names];
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {texts.trigger}
        </label>
        <p className="field__hint" id={`${id}-hint`}>
          {names.length === 0 ? texts.none : texts.hint}
        </p>
        <select
          id={id}
          className="select"
          value={variable}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange({ variable: event.currentTarget.value })}
        >
          <option value="">{texts.off}</option>
          {choices.map((name) => (
            <option key={name} value={name}>
              ${name}
            </option>
          ))}
        </select>
      </div>
      {variable === "" ? null : (
        <div className="field">
          <label className="field__label" htmlFor={sourceId}>
            {texts.source}
          </label>
          <p className="field__hint" id={`${sourceId}-hint`}>
            {texts.sourceHint}
          </p>
          <input
            id={sourceId}
            className="input input--mono"
            value={text}
            maxLength={maxLength}
            aria-describedby={`${sourceId}-hint`}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setText(next);
              onChange({ source: next });
            }}
          />
        </div>
      )}
    </>
  );
}

/**
 * The click-to-set-a-variable behaviour of a panel: the variable when the dashboard has it (else
 * null, and clicks set nothing), and `click`, which sets it and says what happened in
 * `announcement` for a live region. A click without a value (an empty cell, a missing path)
 * leaves the variable as it is and says so.
 */
export function useClickVariable(name: string) {
  const { t } = useI18n();
  const host = usePanelHost();
  const [announcement, setAnnouncement] = useState("");
  const variable = name !== "" && host.variables?.names.includes(name) === true ? name : null;
  function click(value: string | null) {
    if (variable === null) {
      return;
    }
    if (value === null || value === "") {
      setAnnouncement(t("panels.variable.empty", { name: variable }));
      return;
    }
    const outcome = setVariableFromClick(host, variable, value);
    setAnnouncement(
      outcome === "set"
        ? t("panels.variable.announce", { name: variable, value })
        : t("panels.variable.refused", { name: variable, value }),
    );
  }
  return { variable, click, announcement };
}

/** The click option texts of the document and table panels. */
export function useClickOptionTexts(
  trigger: string,
  source: string,
  sourceHint: string,
): ClickOptionTexts {
  const { t } = useI18n();
  return {
    trigger,
    hint: t("panels.variable.hint"),
    none: t("panels.variable.none"),
    off: t("panels.variable.off"),
    source,
    sourceHint,
  };
}
