import {
  type KeyboardEvent,
  lazy,
  type ReactNode,
  Suspense,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../../i18n/i18n";
import { isComposingKey } from "../../../lib/ime";
import { useEscapeLayer } from "../../../lib/layers";
import type { CompletionResult } from "./completion";
import {
  type Token,
  tokenizeCypher,
  tokenizeFlux,
  tokenizeGsql,
  tokenizeJson,
  tokenizeLogql,
  tokenizeLucene,
  tokenizePromql,
  tokenizeSql,
} from "./syntax";
import "./editors.css";

export type CodeLanguage =
  | "sql"
  | "promql"
  | "logql"
  | "flux"
  | "json"
  | "cypher"
  | "gsql"
  | "lucene";

/**
 * The contract every query text editor implements. Query editors depend on this, not on an
 * editor library: `CodeMirrorEditor` and the plain text area below both take these props.
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
  logql: tokenizeLogql,
  flux: tokenizeFlux,
  json: tokenizeJson,
  cypher: tokenizeCypher,
  gsql: tokenizeGsql,
  lucene: tokenizeLucene,
};

/**
 * Plain editor: a text area over a highlighted copy of its text. The text area keeps every
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
    // Enter and Tab confirm an input method composition; they must not pick a suggestion.
    if (isComposingKey(event)) {
      return;
    }
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
 * CodeMirror measures text with Range.getClientRects, which only a browser with layout has; in
 * jsdom (the tests) the plain editor stays.
 */
const HAS_LAYOUT =
  typeof Range !== "undefined" && typeof Range.prototype.getClientRects === "function";

type EditorModule = { default: (props: CodeEditorProps) => ReactNode };
let loaded: EditorModule | null = null;
let loading: Promise<EditorModule> | null = null;

/**
 * Starts loading CodeMirror, for pages that are about to show a query editor (Explore, edit
 * mode). Loaded in time, the editor appears directly instead of replacing the plain one while
 * someone types in it.
 */
export function preloadCodeEditor(): Promise<EditorModule> | null {
  if (!HAS_LAYOUT) {
    return null;
  }
  loading ??= import("./CodeMirrorEditor").then((module) => {
    loaded = { default: module.CodeMirrorEditor };
    return loaded;
  });
  return loading;
}

// CodeMirror loads with the first query editor, so the start bundle does not carry it. Once it
// has loaded, the thenable resolves at once, so React renders the editor without a fallback.
const LazyCodeMirrorEditor = lazy(() => {
  const ready = loaded;
  if (ready !== null) {
    // A thenable that resolves synchronously; React then needs no fallback render.
    // biome-ignore lint/suspicious/noThenProperty: a thenable is exactly what React.lazy takes
    return { then: (resolve: (module: EditorModule) => void) => resolve(ready) } as never;
  }
  return preloadCodeEditor() as Promise<EditorModule>;
});

/**
 * The query text editor: CodeMirror 6 in browsers, the plain text area while it loads and where
 * there is no layout. Both take the same props.
 */
export function CodeEditor(props: CodeEditorProps): ReactNode {
  if (!HAS_LAYOUT) {
    return <TextareaCodeEditor {...props} />;
  }
  return (
    <Suspense fallback={<TextareaCodeEditor {...props} />}>
      <LazyCodeMirrorEditor {...props} />
    </Suspense>
  );
}
