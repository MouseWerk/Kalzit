import { useId, useState } from "react";
import { isRecord } from "../../api/client";
import { DocumentTree } from "../../documents/DocumentTree";
import { type Segment, valueAt, valueAtSegments } from "../../documents/paths";
import { MAX_PATH_CHARS } from "../../documents/projection";
import { SetPicker, SetSummary } from "../../documents/shared";
import { useI18n } from "../../i18n/i18n";
import { usePanelHost } from "../host";
import { EmptyPanel } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../../documents/documents.css";
import { DocumentsPreview } from "../picker/previews";
import {
  ClickVariableOptions,
  clickOption,
  MAX_VARIABLE_CHARS,
  useClickOptionTexts,
  useClickVariable,
  variableText,
} from "../variableClick";

export interface ExplorerOptions {
  /** Dashboard variable a click on a document or a value sets; empty sets none. */
  variable: string;
  /**
   * Path in the clicked document (or list element) the variable takes; empty takes the clicked
   * value, or `_id` for a whole document.
   */
  variablePath: string;
}

export function parseExplorerOptions(stored: unknown): ExplorerOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    variable: clickOption(value.variable, MAX_VARIABLE_CHARS, true),
    variablePath: clickOption(value.variablePath, MAX_PATH_CHARS),
  };
}

/**
 * The value a click on a row sets the variable to: the value at the option's path in the clicked
 * item, else the clicked value itself, and for a whole item its `_id`.
 */
export function clickedValue(
  item: unknown,
  segments: readonly Segment[],
  value: unknown,
  path: string,
): string | null {
  if (path !== "") {
    return variableText(valueAt(item, path));
  }
  return variableText(segments.length === 0 ? valueAt(item, "_id") : value);
}

/** One step into a nested array: the document it is in and the path to the array. */
interface Drill {
  document: number;
  segments: Segment[];
}

function lastName(segments: readonly Segment[]): string {
  const last = segments.at(-1);
  return typeof last === "number" ? `[${last}]` : (last ?? "");
}

/**
 * The document explorer: every document as an expandable tree with the type of each value. A
 * nested array opens as a list of its own (a drilldown with a way back), never as JSON text.
 */
function ExplorerPanel({
  documents = [],
  title,
  options,
  onFilter,
  revision,
}: PanelProps<ExplorerOptions>) {
  const { t } = useI18n();
  const clicked = useClickVariable(options.variable);
  const [index, setIndex] = useState(0);
  const [trail, setTrail] = useState<Drill[]>([]);
  const position = Math.min(index, documents.length - 1);
  const set = documents[position];
  // A new result (a run, a filter, a page loaded after it) starts at its top: the old trail may
  // not exist in it. The page says when one arrives; without it, a new set object is one.
  const marker = revision ?? set;
  const [trailOf, setTrailOf] = useState({ marker, generation: 0 });
  if (trailOf.marker !== marker) {
    setTrailOf({ marker, generation: trailOf.generation + 1 });
    setTrail([]);
  }
  if (set === undefined) {
    return <EmptyPanel reason="noData" />;
  }
  const here = trail.at(-1);
  const items =
    here === undefined
      ? set.documents
      : (valueAtSegments(set.documents[here.document], here.segments) as unknown[]);

  function open(item: number, segments: Segment[]) {
    setTrail((current) => {
      const top = current.at(-1);
      const next: Drill =
        top === undefined
          ? { document: item, segments }
          : { document: top.document, segments: [...top.segments, item, ...segments] };
      return [...current, next];
    });
  }

  return (
    <div className="doc-panel">
      <div className="doc-panel__bar">
        <SetPicker
          count={documents.length}
          index={position}
          onChange={(next) => {
            setIndex(next);
            setTrail([]);
          }}
        />
        {trail.length === 0 ? (
          <SetSummary set={set} />
        ) : (
          <nav className="doc-panel__trail" aria-label={t("documents.drill.label")}>
            <ol>
              <li>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => setTrail([])}
                >
                  {t("documents.drill.all")}
                </button>
              </li>
              {trail.map((step, i) => (
                <li key={JSON.stringify([step.document, ...step.segments])}>
                  {i === trail.length - 1 ? (
                    <span aria-current="location">
                      {t("documents.drill.step", {
                        number: step.document + 1,
                        name: lastName(step.segments),
                      })}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setTrail(trail.slice(0, i + 1))}
                    >
                      {t("documents.drill.step", {
                        number: step.document + 1,
                        name: lastName(step.segments),
                      })}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
      </div>
      <DocumentTree
        // A new list starts closed, with nothing selected.
        key={`${trailOf.generation}:${position}:${trail.length}`}
        items={Array.isArray(items) ? items : []}
        itemLabel={(i) =>
          here === undefined ? t("documents.tree.document", { number: i + 1 }) : `[${i}]`
        }
        prefix={here?.segments}
        label={title}
        onFilter={
          onFilter === undefined
            ? undefined
            : (path, value) => onFilter({ index: position, path, value })
        }
        onOpenList={open}
        onActivate={
          clicked.variable === null
            ? undefined
            : (item, segments, value) =>
                clicked.click(
                  clickedValue(
                    Array.isArray(items) ? items[item] : undefined,
                    segments,
                    value,
                    options.variablePath,
                  ),
                )
        }
        activateLabel={
          clicked.variable === null
            ? undefined
            : t("panels.variable.setAction", { name: clicked.variable })
        }
      />
      {clicked.variable === null ? null : (
        <p className="visually-hidden" role="status" aria-live="polite">
          {clicked.announcement}
        </p>
      )}
    </div>
  );
}

function ExplorerEditor({ options, onChange }: PanelEditorProps<ExplorerOptions>) {
  const { t } = useI18n();
  const host = usePanelHost();
  const id = useId();
  const texts = useClickOptionTexts(
    t("panels.variable.triggerDocuments"),
    t("panels.variable.path"),
    t("panels.variable.pathHintDocuments"),
  );
  return (
    <>
      <p className="field__hint">{t("documents.panels.explorerHint")}</p>
      <ClickVariableOptions
        id={id}
        names={host.variables?.names ?? []}
        variable={options.variable}
        source={options.variablePath}
        texts={texts}
        maxLength={MAX_PATH_CHARS}
        onChange={(patch) =>
          onChange(
            parseExplorerOptions({
              ...options,
              ...(patch.variable === undefined ? {} : { variable: patch.variable }),
              ...(patch.source === undefined ? {} : { variablePath: patch.source }),
            }),
          )
        }
      />
    </>
  );
}

export const documentsPanel: PanelPlugin<ExplorerOptions> = {
  type: "documents",
  name: "documents.panels.explorer",
  description: "documents.describe.documents",
  Preview: DocumentsPreview,
  shapes: ["documents"],
  options: parseExplorerOptions,
  Panel: ExplorerPanel,
  Editor: ExplorerEditor,
};
