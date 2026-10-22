import {
  autocompletion,
  type CompletionResult as CodeMirrorCompletions,
  type CompletionContext,
  closeCompletion,
  completionKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Prec, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { useEscapeLayer } from "../../../lib/layers";
import type { CodeEditorProps, CodeLanguage } from "./CodeEditor";
import type { CompletionKind } from "./completion";
import { withEditorStyles } from "./editorStyles";
import { type Token, tokenizeCypher, tokenizeGsql, tokenizePromql, tokenizeSql } from "./syntax";
import "./editors.css";

const TOKENIZERS: Record<CodeLanguage, (text: string) => Token[]> = {
  sql: tokenizeSql,
  promql: tokenizePromql,
  cypher: tokenizeCypher,
  gsql: tokenizeGsql,
};

/** Completion kinds as CodeMirror names its option icons. */
const OPTION_TYPES: Record<CompletionKind, string> = {
  table: "class",
  column: "property",
  keyword: "keyword",
  function: "function",
  macro: "variable",
  metric: "constant",
  label: "property",
  duration: "text",
  nodeLabel: "class",
  edgeType: "type",
  property: "property",
};

const marks = new Map<string, Decoration>();
function mark(kind: string): Decoration {
  let decoration = marks.get(kind);
  if (decoration === undefined) {
    decoration = Decoration.mark({ class: `code-token code-token--${kind}` });
    marks.set(kind, decoration);
  }
  return decoration;
}

/**
 * Highlighting with the same tokenizers (and the same token classes) as the plain editor, for
 * SQL and PromQL alike; queries are short, so the whole text is tokenized per change.
 */
function highlighter(language: CodeLanguage) {
  const build = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    let offset = 0;
    for (const token of TOKENIZERS[language](view.state.doc.toString())) {
      if (token.kind !== "plain" && token.text.length > 0) {
        builder.add(offset, offset + token.text.length, mark(token.kind));
      }
      offset += token.text.length;
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/**
 * The look, from the design tokens. CodeMirror's own styles are not in a cascade layer, so the
 * overrides have to come through its theme rather than from the layered stylesheets.
 */
const theme = EditorView.theme({
  "&": {
    border: "var(--border-width) solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    fontSize: "var(--font-size-sm)",
  },
  "&.cm-focused": { outline: "var(--focus-outline)", outlineOffset: "var(--focus-ring-offset)" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    fontVariantLigatures: "none",
    lineHeight: "var(--line-height)",
    minHeight: "var(--size-editor-min)",
  },
  ".cm-content": { caretColor: "var(--text)", padding: "var(--space-2) 0" },
  ".cm-line": { padding: "0 var(--space-3)" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    { backgroundColor: "var(--bg-active)" },
  ".cm-tooltip": {
    border: "var(--border-width) solid var(--border)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--bg-raised)",
    color: "var(--text)",
    boxShadow: "var(--shadow-menu)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--bg-active)",
    color: "var(--text)",
  },
  ".cm-completionDetail": { color: "var(--text-muted)" },
});

/**
 * The query editor in browsers: CodeMirror 6 with completion from `completion.ts`, Ctrl+Enter
 * (Cmd+Enter) to run, Ctrl+Space for suggestions and Escape to close them. Tab is left to the
 * browser, so the editor never traps the keyboard. Same props as the plain editor.
 */
export function CodeMirrorEditor({
  value,
  onChange,
  language,
  label,
  describedBy,
  complete,
  onRun,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The editor is built once; its callbacks read the newest props from here.
  const propsRef = useRef({ onChange, complete, onRun });
  const attributes = useRef(new Compartment());
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    propsRef.current = { onChange, complete, onRun };
  });

  // Escape closes the open suggestions first, before any dialog around the editor.
  useEscapeLayer(completing, () => {
    if (viewRef.current !== null) {
      closeCompletion(viewRef.current);
    }
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: built once per language; later props arrive through propsRef and the effects below
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) {
      return;
    }
    const source = (context: CompletionContext): CodeMirrorCompletions | null => {
      const result = propsRef.current.complete?.(
        context.state.doc.toString(),
        context.pos,
        context.explicit,
      );
      if (result === undefined || result === null) {
        return null;
      }
      return {
        from: result.from,
        to: result.to,
        options: result.options.map((option) => ({
          label: option.label,
          type: OPTION_TYPES[option.kind],
          ...(option.detail === undefined ? {} : { detail: option.detail }),
        })),
      };
    };
    // The server's CSP blocks CodeMirror's style element; see withEditorStyles.
    const view = withEditorStyles(
      host.ownerDocument,
      () =>
        new EditorView({
          parent: host,
          state: EditorState.create({
            doc: value,
            extensions: [
              history(),
              Prec.high(
                keymap.of([
                  {
                    key: "Mod-Enter",
                    run: (target) => {
                      // Running closes the suggestions; they belong to the text, not the result.
                      closeCompletion(target);
                      propsRef.current.onRun?.();
                      return propsRef.current.onRun !== undefined;
                    },
                  },
                ]),
              ),
              keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
              autocompletion({ override: [source], icons: false }),
              highlighter(language),
              EditorView.lineWrapping,
              theme,
              attributes.current.of(EditorView.contentAttributes.of({})),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  propsRef.current.onChange(update.state.doc.toString());
                }
                setCompleting(completionStatus(update.state) !== null);
              }),
            ],
          }),
        }),
    );
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [language]);

  // The accessible name and description live on the editable element.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) {
      return;
    }
    const attrs: Record<string, string> = { "aria-label": label, spellcheck: "false" };
    if (describedBy !== undefined) {
      attrs["aria-describedby"] = describedBy;
    }
    view.dispatch({
      effects: attributes.current.reconfigure(EditorView.contentAttributes.of(attrs)),
    });
  }, [label, describedBy]);

  // A value set from outside (another data source, a reset) replaces the text.
  useEffect(() => {
    const view = viewRef.current;
    if (view !== null && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="code-editor code-editor--cm" ref={hostRef} />;
}
