import "./editors.css";
import { type ReactNode, useState } from "react";
import { isRecord } from "../../../api/client";
import type { Pattern } from "../../../api/generated/shapes";
import { LazyPiece, pieceSource } from "../../../components/LazyPiece";
import { loadArea, useI18n } from "../../../i18n/i18n";
import { errorMessage } from "../../dashboards/ui/errors";
import { compilePattern, parsePattern } from "../../graphPatterns/api";
import type { ModeNoteProps, PatternBuilderProps } from "../../graphPatterns/PatternBuilder";
import { sampleVariables, textForEditing } from "../../graphPatterns/pattern";
import { reasonText } from "../reasons";
import type { QueryEditorProps } from "./QueryEditor";

/*
 * The two forms of a graph source's query editor (board Graph083, decision 1): "Muster" to draw,
 * and the text (Cypher or GSQL). Only one of them is in force (decision 2): the pattern writes the
 * text, or the text runs and the pattern shows its last drawn state, greyed, until "Als Muster
 * öffnen" reads the text back.
 */

// The builder loads with its texts when the pattern is first shown.
const BUILDER = pieceSource<PatternBuilderProps>(() =>
  loadArea("graphPatterns")
    .then(() => import("../../graphPatterns/PatternBuilder"))
    .then((module) => ({ default: module.PatternBuilder })),
);

// What is in force: the text, with the last drawn pattern greyed, or a note after the switch.
const NOTE = pieceSource<ModeNoteProps>(() =>
  loadArea("graphPatterns")
    .then(() => import("../../graphPatterns/PatternBuilder"))
    .then((module) => ({ default: module.ModeNote })),
);

// "Was der Baukasten kann": the subset of Cypher and GSQL the way back reads (frame 10).
const CAN_DO = pieceSource<Record<string, never>>(() =>
  loadArea("graphPatterns")
    .then(() => import("../../graphPatterns/PatternBuilder"))
    .then((module) => ({ default: module.CanDoHelp })),
);

/** The pattern of a query, when it is one. */
function patternIn(query: unknown): Pattern | undefined {
  if (!isRecord(query) || !isRecord(query.pattern) || !Array.isArray(query.pattern.nodes)) {
    return undefined;
  }
  return query.pattern as unknown as Pattern;
}

interface GraphModesProps extends QueryEditorProps {
  language: "Cypher" | "GSQL";
  /** The text of a text query, "" for a pattern. */
  text: string;
  /** A text query of this form, with the values Kalzit's own parameters had (GSQL). */
  textQuery: (text: string, params?: Record<string, unknown>) => unknown;
  /** The parameters a text query carries (GSQL), for the way back. */
  textParams?: Record<string, unknown> | undefined;
  /** Whether the text form can go back to a pattern at all (not an installed GSQL query). */
  drawable: boolean;
  children: ReactNode;
}

export function GraphModes({
  language,
  text,
  textQuery,
  textParams,
  drawable,
  children,
  ...props
}: GraphModesProps) {
  const { t } = useI18n();
  const pattern = patternIn(props.query);
  // The pattern last drawn and the text it wrote: the text keeps the pattern until it changes.
  const [drawn, setDrawn] = useState<{ pattern: Pattern; text: string } | null>(null);
  const [staleShown, setStaleShown] = useState(false);
  const [switched, setSwitched] = useState(false);
  const [back, setBack] = useState<
    | { state: "busy" }
    | { state: "refused"; message: string }
    | { state: "failed"; message: string }
    | null
  >(null);
  const textChanged = drawn !== null && drawn.text !== text;

  async function openAsPattern() {
    setBack({ state: "busy" });
    try {
      const parsed = await parsePattern(props.orgId, props.datasource.id, text, textParams ?? {});
      if (parsed.representable && parsed.pattern !== undefined) {
        setBack(null);
        setStaleShown(false);
        setSwitched(false);
        props.onChange({ pattern: parsed.pattern });
        return;
      }
      setBack({
        state: "refused",
        message:
          reasonText(t, {
            reason: parsed.reason ?? "pattern.not_representable",
            params: parsed.params,
            fallback: parsed.message,
          }) ?? "",
      });
    } catch (error) {
      setBack({ state: "failed", message: errorMessage(t, error) });
    }
  }

  function choosePattern() {
    if (pattern !== undefined) return;
    if (text.trim() === "") {
      props.onChange({ pattern: { nodes: [] } });
      return;
    }
    if (drawn !== null && drawn.text === text) {
      props.onChange({ pattern: drawn.pattern });
      setSwitched(false);
      return;
    }
    setStaleShown(true);
  }

  const patternTab = pattern !== undefined || staleShown;
  return (
    <div className="graph-modes">
      {drawable ? (
        // biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a field set
        <div
          className="graph-modes__switch"
          role="group"
          aria-label={t("datasources.editor.pattern.mode")}
        >
          <button
            type="button"
            className="graph-modes__item"
            aria-pressed={patternTab}
            onClick={choosePattern}
          >
            {t("datasources.editor.pattern.pattern")}
          </button>
          <button
            type="button"
            className="graph-modes__item"
            aria-pressed={!patternTab}
            onClick={() => {
              setStaleShown(false);
              if (pattern === undefined) return;
              // Into the text with the query the pattern writes, as "In Cypher bearbeiten" does.
              const variables = sampleVariables(pattern.parameters ?? [], props.samples ?? {});
              const toText = (generated: string, params?: Record<string, unknown>) => {
                setDrawn({ pattern, text: generated });
                setSwitched(true);
                props.onPendingText?.(false);
                props.onChange(textQuery(generated, params));
              };
              if (pattern.nodes.length === 0) {
                toText("");
                return;
              }
              compilePattern(props.orgId, props.datasource.id, pattern, variables)
                .then((compiled) => {
                  const editable = textForEditing(
                    compiled.text,
                    compiled.parameters,
                    language === "GSQL" ? "gsql" : "cypher",
                  );
                  toText(editable.text, editable.params);
                })
                .catch(() => toText(""));
            }}
          >
            {language}
          </button>
        </div>
      ) : null}
      {pattern !== undefined ? (
        <LazyPiece
          source={BUILDER}
          props={{
            orgId: props.orgId,
            datasource: props.datasource,
            pattern,
            onChange: (next) => props.onChange({ pattern: next }),
            onRun: props.onRun,
            samples: props.samples,
            onSamples: props.onSamples,
            onPendingText: props.onPendingText,
            onSaveTemplate: props.onSaveTemplate,
            onEditAsText: (generated, params) => {
              setDrawn({ pattern, text: generated });
              setSwitched(true);
              props.onPendingText?.(false);
              props.onChange(textQuery(generated, params));
            },
          }}
          pending={<p className="loading">{t("common.loading")}</p>}
        />
      ) : staleShown ? (
        <div className="graph-modes__note" role="note">
          <LazyPiece
            source={NOTE}
            props={
              drawn === null
                ? { kind: "textOnly" }
                : {
                    kind: "stale",
                    pattern: drawn.pattern,
                    onRestore: () => {
                      setStaleShown(false);
                      props.onChange({ pattern: drawn.pattern });
                    },
                  }
            }
          />
          <div className="graph-modes__actions">
            <button
              type="button"
              className="button button--secondary button--small"
              disabled={back?.state === "busy"}
              onClick={() => void openAsPattern()}
            >
              {t("datasources.editor.pattern.open")}
            </button>
          </div>
          <BackResult back={back} />
        </div>
      ) : (
        <>
          {switched && !textChanged ? (
            <div className="graph-modes__note" role="note">
              <LazyPiece
                source={NOTE}
                props={{ kind: "switched", onDismiss: () => setSwitched(false) }}
              />
            </div>
          ) : null}
          {children}
          {drawable && text.trim() !== "" ? (
            <div className="graph-modes__back">
              <button
                type="button"
                className="button button--ghost button--small"
                disabled={back?.state === "busy"}
                onClick={() => void openAsPattern()}
              >
                {t("datasources.editor.pattern.open")}
              </button>
              <BackResult back={back} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function BackResult({
  back,
}: {
  back:
    | { state: "busy" }
    | { state: "refused"; message: string }
    | { state: "failed"; message: string }
    | null;
}) {
  if (back === null || back.state === "busy") return null;
  return (
    <div className="graph-modes__result" role="status">
      <p>{back.message}</p>
      {back.state === "refused" ? <LazyPiece source={CAN_DO} props={{}} /> : null}
    </div>
  );
}
