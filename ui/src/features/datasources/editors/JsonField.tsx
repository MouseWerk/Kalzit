import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { CodeEditor } from "./CodeEditor";
import type { CompletionResult } from "./completion";
import "../../../documents/documents.css";

/** Indented, so a stage reads like it does in the MongoDB documentation. */
export function formatJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

export interface JsonFieldProps {
  /** Accessible name of the editor. */
  label: string;
  value: unknown;
  /** Called with valid values only; `undefined` when an optional field is emptied. */
  onChange: (value: unknown) => void;
  /** An error text for a parsed value that does not fit, or null. */
  validate?: (value: unknown) => string | null;
  /** Empty text is allowed and means "not set". */
  optional?: boolean;
  complete?: (text: string, cursor: number, explicit: boolean) => CompletionResult | null;
  onRun?: (() => void) | undefined;
  rows?: number;
  /** Ids of hints that describe the field. */
  describedBy?: string;
}

/**
 * One JSON value edited as text. Every keystroke is kept in the field; only text that parses and
 * passes `validate` reaches the query, and until it does the field says why and the query keeps
 * its last valid value. A value changed from outside (a filter added by click) replaces the text.
 */
export function JsonField({
  label,
  value,
  onChange,
  validate,
  optional = false,
  complete,
  onRun,
  rows = 4,
  describedBy,
}: JsonFieldProps) {
  const { t } = useI18n();
  const errorId = useId();
  const signature = String(JSON.stringify(value));
  const [text, setText] = useState(() => formatJson(value));
  const [synced, setSynced] = useState(signature);
  const [error, setError] = useState<string | null>(null);
  if (signature !== synced) {
    setSynced(signature);
    setText(formatJson(value));
    setError(null);
  }

  function change(next: string) {
    setText(next);
    if (next.trim() === "") {
      if (optional) {
        setError(null);
        setSynced("undefined");
        onChange(undefined);
      } else {
        setError(t("documents.pipeline.empty"));
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(next);
    } catch (problem) {
      setError(
        t("documents.pipeline.invalidJson", {
          detail: problem instanceof Error ? problem.message : String(problem),
        }),
      );
      return;
    }
    const refused = validate?.(parsed) ?? null;
    if (refused !== null) {
      setError(refused);
      return;
    }
    setError(null);
    setSynced(String(JSON.stringify(parsed)));
    onChange(parsed);
  }

  const described = [describedBy, error === null ? undefined : errorId]
    .filter((id) => id !== undefined)
    .join(" ");
  return (
    <div className="json-field">
      <CodeEditor
        language="json"
        label={label}
        value={text}
        onChange={change}
        rows={rows}
        {...(described === "" ? {} : { describedBy: described })}
        {...(complete === undefined ? {} : { complete })}
        {...(onRun === undefined ? {} : { onRun })}
      />
      {error === null ? null : (
        <p className="field__error" id={errorId}>
          {error} {t("documents.pipeline.lastValid")}
        </p>
      )}
    </div>
  );
}
