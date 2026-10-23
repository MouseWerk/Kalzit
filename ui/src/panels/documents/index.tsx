import { useState } from "react";
import { DocumentTree } from "../../documents/DocumentTree";
import { type Segment, valueAtSegments } from "../../documents/paths";
import { SetPicker, SetSummary } from "../../documents/shared";
import { useI18n } from "../../i18n/i18n";
import { EmptyPanel } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../../documents/documents.css";
import { DocumentsPreview } from "../picker/previews";

export type ExplorerOptions = Record<string, never>;

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
function ExplorerPanel({ documents = [], title, onFilter, revision }: PanelProps<ExplorerOptions>) {
  const { t } = useI18n();
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
      />
    </div>
  );
}

function ExplorerEditor(_: PanelEditorProps<ExplorerOptions>) {
  const { t } = useI18n();
  return <p className="field__hint">{t("documents.panels.explorerHint")}</p>;
}

export const documentsPanel: PanelPlugin<ExplorerOptions> = {
  type: "documents",
  name: "documents.panels.explorer",
  description: "documents.describe.documents",
  Preview: DocumentsPreview,
  shapes: ["documents"],
  options: () => ({}),
  Panel: ExplorerPanel,
  Editor: ExplorerEditor,
};
