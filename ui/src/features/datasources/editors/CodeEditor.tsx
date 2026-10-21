import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../../i18n/i18n";
import { useEscapeLayer } from "../../../lib/layers";
import type { CompletionResult } from "./completion";
import { type Token, tokenizePromql, tokenizeSql } from "./syntax";

export type CodeLanguage = "sql" | "promql";

/**
 * The contract every query text editor implements. Query editors depend on this, not on an
 * editor library: the plain text area below works today, and a CodeMirror 6 implementation can
 * replace it in `CodeEditor` without touching the SQL and PromQL editors.
 */
export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  /** Accessible name of the text field. */
  label: string;
  /** Id of a hint that describes the field (shortcuts, macros). */
  describedBy?: string;
  /** Completions at the cursor; `explicit` when the user asked with Ctrl+Space. */
  complete?: (text: string, cursor: number, explicit: boolean) => CompletionResult | null;
  /** Ctrl+Enter (Cmd+Enter on macOS). */
  onRun?: () => void;
  rows?: number;
}

const TOKENIZERS: Record<CodeLanguage, (text: string) => Token[]> = {
  sql: tokenizeSql,
  promql: tokenizePromql,
};

/**
 * Fallback editor: a text area over a highlighted copy of its text. The text area keeps every
 * native behavior (undo, selection, input methods, screen readers); the layer behind it only
 * colors the same characters, which is why both share font, padding and wrapping exactly.
 */
function TextareaCodeEditor({
  value,
  onChange,
  language,
  label,
  describedBy,
  complete,
  onRun,
  rows = 6,
}: CodeEditorProps): ReactNode {
  const { t } = useI18n();
  const listId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const pendingCursor = useRef<number | null>(null);
  const [completion, setCompletion] = useState<CompletionResult | null>(null);
  const [active, setActive] = useState(0);
  const open = completion !== null;

  useEscapeLayer(open, () => setCompletion(null));

  useLayoutEffect(() => {
    const cursor = pendingCursor.current;
    const textarea = textareaRef.current;
    if (cursor !== null && textarea !== null) {
      pendingCursor.current = null;
      textarea.setSelectionRange(cursor, cursor);
    }
  });

  function suggest(text: string, cursor: number, explicit: boolean) {
    const result = complete?.(text, cursor, explicit) ?? null;
    setCompletion(result);
    setActive(0);
  }

  function accept(index: number) {
    const option = completion?.options[index];
    if (completion === null || option === undefined) {
      return;
    }
    const next = value.slice(0, completion.from) + option.label + value.slice(completion.to);
    pendingCursor.current = completion.from + option.label.length;
    setCompletion(null);
    onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      setCompletion(null);
      onRun?.();
      return;
    }
    if (event.key === " " && event.ctrlKey) {
      event.preventDefault();
      suggest(value, event.currentTarget.selectionStart, true);
      return;
    }
    if (completion === null) {
      return;
    }
    const count = completion.options.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(active);
    }
  }

  function syncScroll() {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (textarea !== null && highlight !== null) {
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }
  }

  // Keyed by offset: a token has no identity beyond where it starts in the text.
  const spans: ReactNode[] = [];
  let offset = 0;
  for (const token of TOKENIZERS[language](value)) {
    spans.push(
      <span key={offset} className={`code-token code-token--${token.kind}`}>
        {token.text}
      </span>,
    );
    offset += token.text.length;
  }
  const activeId = open ? `${listId}-${active}` : undefined;

  return (
    <div className="code-editor">
      <pre className="code-editor__highlight" ref={highlightRef} aria-hidden="true">
        {spans}
        {/* A trailing line break keeps the last empty line as tall as in the text area. */}
        {"\n"}
      </pre>
      <textarea
        ref={textareaRef}
        className="code-editor__input"
        value={value}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-label={label}
        aria-describedby={describedBy}
        aria-autocomplete={complete === undefined ? undefined : "list"}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={activeId}
        onChange={(event) => {
          const text = event.currentTarget.value;
          onChange(text);
          suggest(text, event.currentTarget.selectionStart, false);
        }}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        onBlur={() => setCompletion(null)}
      />
      {completion === null ? null : (
        <div
          className="code-editor__completions"
          id={listId}
          role="listbox"
          aria-label={t("datasources.editor.suggestions")}
        >
          {completion.options.map((option, index) => (
            <div
              key={`${option.kind}:${option.label}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className="code-editor__option"
              tabIndex={-1}
              // Chosen on pointer down, which also keeps focus in the text area.
              onPointerDown={(event) => {
                event.preventDefault();
                accept(index);
              }}
            >
              <span className="code-editor__option-label">{option.label}</span>
              <span className="code-editor__option-kind">
                {option.detail ?? t(`datasources.editor.kind.${option.kind}`)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The editor in use. When the CodeMirror 6 packages are available, a `CodeMirrorEditor` with the
 * same props goes here (SQL and PromQL modes, completion sources from `completion.ts`).
 */
export const CodeEditor: (props: CodeEditorProps) => ReactNode = TextareaCodeEditor;
