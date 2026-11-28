import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type {
  GraphSourceSchema,
  ParameterType,
  Pattern,
  PatternParameter,
} from "../../api/generated/shapes";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { writeClipboard } from "../../lib/clipboard";
import { isComposingKey } from "../../lib/ime";
import { useSettled } from "../../lib/useSettled";
import { errorMessage } from "../dashboards/ui/errors";
import { runQuery } from "../datasources/api";
import { compilePattern, GRAPH_PATTERNS_KEY, graphSchemaQuery } from "./api";
import { conditionError, ElementPanel } from "./ElementPanel";
import { GraphSchemaView } from "./GraphSchemaView";
import { PasteValuesDialog } from "./PasteValuesDialog";
import { PatternDrawing } from "./PatternDrawing";
import {
  addEdge,
  addNode,
  DEFAULT_LIMIT,
  dialectOf,
  edgeById,
  edgesOf,
  elementOrder,
  isListType,
  nodeById,
  type PatternDialect,
  propertiesOf,
  removeElement,
  reverseEdge,
  type Selection,
  sampleVariables,
  textForEditing,
  typedSample,
  updateEdge,
  valueKind,
  warningsOf,
  withParameters,
} from "./pattern";
import { conditionPhrase, nodePhrase, patternSentence, TYPE_TEXT } from "./sentence";
import "../datasources/editors/editors.css";
import "./patterns.css";

/** How long the drawing rests before the query beside it is written again. */
const COMPILE_SETTLE_MS = 300;

export interface PatternBuilderProps {
  orgId: string;
  datasource: { id: string; kind: string };
  pattern: Pattern;
  onChange: (pattern: Pattern) => void;
  onRun?: (() => void) | undefined;
  /**
   * Explore: a sample value per parameter (Probewert), sent with the run. Without it (the panel
   * editor) each parameter takes the dashboard variable of the same name.
   */
  samples?: Readonly<Record<string, unknown>> | undefined;
  onSamples?: ((samples: Record<string, unknown>) => void) | undefined;
  /** "In Cypher bearbeiten": the generated text goes into the text editor. */
  onEditAsText: (text: string, params?: Record<string, unknown>) => void;
  /** The builder holds a value that does not fit, so the query waits. */
  onPendingText?: ((pending: boolean) => void) | undefined;
  /** "Als Suchvorlage speichern", where the page can save. */
  onSaveTemplate?: (() => void) | undefined;
}

/**
 * The pattern builder (board Graph083, frames 1 to 9): draw nodes and edges, pick their types,
 * conditions, direction, lengths and optional parts; the sentence and the generated query stand
 * beside it, always. The query comes from the server (`patterns/compile`), so what is shown is what
 * runs. The list is the same pattern without the drawing, and the default on a narrow screen.
 */
export function PatternBuilder({
  orgId,
  datasource,
  pattern,
  onChange,
  onRun,
  samples,
  onSamples,
  onEditAsText,
  onPendingText,
  onSaveTemplate,
}: PatternBuilderProps) {
  const { t, language } = useI18n();
  const id = useId();
  const dialect: PatternDialect = dialectOf(datasource.kind) ?? "cypher";
  const languageName = dialect === "gsql" ? "GSQL" : "Cypher";
  const schemaQuery = useQuery(graphSchemaQuery(orgId, datasource.id));
  const schema: GraphSourceSchema | undefined = schemaQuery.data;
  const [selection, setSelection] = useState<Selection>(() => {
    const first = pattern.nodes[0];
    return first === undefined ? null : { kind: "node", id: first.id };
  });
  const [view, setView] = useState<"drawing" | "list">(() =>
    typeof window !== "undefined" && window.matchMedia?.("(width < 48rem)").matches === true
      ? "list"
      : "drawing",
  );
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [paste, setPaste] = useState<PatternParameter | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [copied, setCopied] = useState(false);
  const [limitText, setLimitText] = useState(String(pattern.limit ?? DEFAULT_LIMIT));
  const panel = useRef<HTMLDivElement>(null);
  const live = samples !== undefined && onSamples !== undefined;
  const parameters = pattern.parameters ?? [];
  const variables = live ? sampleVariables(parameters, samples) : {};

  // A selection whose element is gone falls back to nothing.
  const current =
    selection === null
      ? null
      : selection.kind === "node"
        ? nodeById(pattern, selection.id) === undefined
          ? null
          : selection
        : edgeById(pattern, selection.id) === undefined
          ? null
          : selection;

  function change(next: Pattern, select?: Selection, announce?: string) {
    onChange(withParameters(next, schema));
    if (select !== undefined) setSelection(select);
    if (announce !== undefined) setAnnouncement(announce);
  }

  const warnings = warningsOf(pattern, schema, dialect);
  const gsqlOptional = warnings.some((w) => w.kind === "gsqlOptional");
  // Values that do not fit, and parameters without a value, hold the run (frame 6).
  const badConditions = [
    ...pattern.nodes.map((n) => ({
      id: n.id,
      kind: "node" as const,
      conditions: n.conditions ?? [],
    })),
    ...edgesOf(pattern).map((e) => ({
      id: e.id,
      kind: "edge" as const,
      conditions: e.conditions ?? [],
    })),
  ].flatMap((owner) =>
    owner.conditions
      .filter((c) => {
        const props = propertiesOf(pattern, schema, { kind: owner.kind, id: owner.id });
        return (
          conditionError(c, valueKind(props.find((p) => p.name === c.property)?.types)) !==
          undefined
        );
      })
      .map((c) => ({ owner: owner.id, condition: c })),
  );
  const missing = live ? parameters.filter((p) => !(p.name in variables)) : [];
  const pending = badConditions.length > 0 || missing.length > 0 || gsqlOptional;
  useEffect(() => {
    onPendingText?.(pending);
  }, [pending, onPendingText]);

  // The query beside the drawing, written by the server once the drawing rests.
  const settled = useSettled({ pattern, variables }, COMPILE_SETTLE_MS);
  const compiled = useQuery({
    queryKey: [GRAPH_PATTERNS_KEY, orgId, "compile", datasource.id, settled],
    queryFn: ({ signal }) =>
      compilePattern(orgId, datasource.id, settled.pattern, settled.variables, signal),
    enabled: settled.pattern.nodes.length > 0 && !gsqlOptional,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const lastText = useRef<string | undefined>(undefined);
  useEffect(() => {
    const text = compiled.data?.text;
    if (text !== undefined && lastText.current !== undefined && text !== lastText.current) {
      setAnnouncement(t("graphPatterns.announce.updated"));
    }
    lastText.current = text;
  }, [compiled.data?.text, t]);

  // "Treffer zählen": a second, counting query, only on request (decision 8).
  const [counted, setCounted] = useState<
    { state: "busy" } | { state: "done"; n: number } | { state: "failed"; message: string } | null
  >(null);
  async function countMatches() {
    setCounted({ state: "busy" });
    try {
      const now = Date.now();
      const response = await runQuery(orgId, {
        queries: [
          {
            refId: "A",
            datasourceId: datasource.id,
            query: { pattern: { ...pattern, count: true } },
          },
        ],
        timeRange: { from: now - 3_600_000, to: now },
        variables,
      });
      const outcome = response.results.A;
      if (outcome !== undefined && "result" in outcome && outcome.result.shape === "frame") {
        const value = outcome.result.frame.fields[0]?.values[0];
        setCounted({ state: "done", n: Number(value ?? 0) });
      } else {
        const message =
          outcome !== undefined && "error" in outcome
            ? outcome.error.message
            : t("graphPatterns.count.failed");
        setCounted({ state: "failed", message });
      }
    } catch (error) {
      setCounted({ state: "failed", message: errorMessage(t, error) });
    }
  }

  function addFirstNode(label?: string) {
    const added = addNode(pattern, label === undefined ? [] : [label]);
    change(
      added.pattern,
      { kind: "node", id: added.id },
      t("graphPatterns.announce.nodeAdded", {
        id: added.id,
        nodes: added.pattern.nodes.length,
        edges: edgesOf(added.pattern).length,
      }),
    );
  }

  function onKey(event: KeyboardEvent<HTMLElement>) {
    // A key that composes text (an input method) is no shortcut.
    if (isComposingKey(event)) return;
    const target = event.target as Element;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!pending) onRun?.();
      return;
    }
    // The builder's keys work in the drawing and the list only, never while typing in a field.
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      target.closest(".pattern__canvas") === null
    ) {
      return;
    }
    const element = target.closest("[data-element]")?.getAttribute("data-element");
    if ((event.key === "Enter" || event.key === " ") && element !== null && element !== undefined) {
      event.preventDefault();
      const [kind, elementId] = element.split(":");
      setSelection({ kind: kind === "edge" ? "edge" : "node", id: elementId ?? "" });
      // Enter goes on into the element's fields, as the board's keys say.
      if (event.key === "Enter") {
        requestAnimationFrame(() =>
          panel.current?.querySelector<HTMLElement>("input, button")?.focus(),
        );
      }
      return;
    }
    switch (event.key) {
      case "n":
      case "N":
        event.preventDefault();
        addFirstNode();
        return;
      case "e":
      case "E": {
        if (current?.kind !== "node") return;
        event.preventDefault();
        const other = pattern.nodes.find((n) => n.id !== current.id);
        let next = pattern;
        let to = other?.id;
        if (to === undefined) {
          const added = addNode(next);
          next = added.pattern;
          to = added.id;
        }
        const edge = addEdge(next, current.id, to);
        change(
          edge.pattern,
          { kind: "edge", id: edge.id },
          t("graphPatterns.announce.edgeAdded", { id: edge.id, from: current.id, to }),
        );
        return;
      }
      case "r":
      case "R":
        if (current?.kind === "edge") {
          event.preventDefault();
          change(reverseEdge(pattern, current.id));
        }
        return;
      case "o":
      case "O":
        if (current?.kind === "edge") {
          event.preventDefault();
          const edge = edgeById(pattern, current.id);
          change(updateEdge(pattern, current.id, { optional: edge?.optional !== true }));
        }
        return;
      case "b":
      case "B":
        if (current !== null) {
          event.preventDefault();
          panel.current
            ?.querySelector<HTMLButtonElement>(".pattern-panel__conditions > button")
            ?.click();
        }
        return;
      case "Delete":
      case "Backspace":
        if (current !== null) {
          event.preventDefault();
          change(
            removeElement(pattern, current),
            null,
            t("graphPatterns.announce.removed", { id: current.id }),
          );
        }
        return;
      case "l":
      case "L":
        event.preventDefault();
        setView((v) => (v === "drawing" ? "list" : "drawing"));
        return;
      default:
    }
  }

  const sentence = patternSentence(t, language, pattern);
  const editable = textForEditing(
    compiled.data?.text ?? "",
    compiled.data?.parameters ?? {},
    dialect,
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the builder's keys work wherever its focus is
    <div className="pattern" onKeyDown={onKey}>
      <div className="pattern__bar">
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => addFirstNode()}
        >
          {t("graphPatterns.bar.addNode")}
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a field set */}
        <div className="pattern-segmented" role="group" aria-label={t("graphPatterns.bar.view")}>
          {(["drawing", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className="pattern-segmented__item"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {t(v === "drawing" ? "graphPatterns.bar.drawing" : "graphPatterns.bar.list")}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-pressed={schemaOpen}
          onClick={() => setSchemaOpen((open) => !open)}
        >
          {t("graphPatterns.bar.schema")}
        </button>
        {onSaveTemplate === undefined ? null : (
          <button
            type="button"
            className="button button--ghost button--small pattern__save"
            disabled={pattern.nodes.length === 0}
            onClick={onSaveTemplate}
          >
            {t("graphPatterns.bar.saveTemplate")}
          </button>
        )}
      </div>
      {schemaOpen ? (
        <GraphSchemaView
          orgId={orgId}
          datasource={datasource}
          onUseLabel={(label) => {
            addFirstNode(label);
            setSchemaOpen(false);
          }}
        />
      ) : null}
      <div className="pattern__body">
        <div className="pattern__canvas">
          {pattern.nodes.length === 0 ? (
            <EmptyPattern schema={schema} onAdd={addFirstNode} />
          ) : view === "drawing" ? (
            <>
              <PatternDrawing
                pattern={pattern}
                schema={schema}
                label={sentence}
                selection={current}
                onSelect={setSelection}
                onAddNode={() => addFirstNode()}
                onConnect={(from, to) => {
                  const edge = addEdge(pattern, from, to);
                  change(
                    edge.pattern,
                    { kind: "edge", id: edge.id },
                    t("graphPatterns.announce.edgeAdded", { id: edge.id, from, to }),
                  );
                }}
              />
              <p className="field__hint">{t("graphPatterns.drawing.hint")}</p>
            </>
          ) : (
            <PatternList
              pattern={pattern}
              selection={current}
              onSelect={setSelection}
              onAdd={() => addFirstNode()}
            />
          )}
        </div>
        <div className="pattern__side" ref={panel}>
          {current === null ? (
            <p className="field__hint">
              {pattern.nodes.length === 0
                ? t("graphPatterns.panel.startHint")
                : t("graphPatterns.panel.chooseHint")}
            </p>
          ) : (
            <ElementPanel
              key={`${current.kind}:${current.id}`}
              pattern={pattern}
              schema={schema}
              dialect={dialect}
              selection={current}
              onChange={change}
              onPaste={(name) => {
                const p = parameters.find((x) => x.name === name);
                if (p !== undefined) setPaste(p);
              }}
            />
          )}
        </div>
      </div>
      {sentence === "" ? null : <p className="pattern__sentence">{sentence}</p>}
      <Warnings
        warnings={warnings}
        onChooseType={() => {
          const first = pattern.nodes[0];
          if (first !== undefined) setSelection({ kind: "node", id: first.id });
        }}
      />
      {pattern.nodes.length === 0 ? null : (
        <div className="pattern__limit">
          <label className="pattern-panel__hops" htmlFor={`${id}-limit`}>
            {t("graphPatterns.limit.before")}
          </label>
          <input
            id={`${id}-limit`}
            className="input pattern-panel__number"
            inputMode="numeric"
            value={limitText}
            aria-describedby={`${id}-limit-hint`}
            aria-invalid={/^\d+$/.test(limitText) && Number(limitText) >= 1 ? undefined : true}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setLimitText(text);
              if (/^\d+$/.test(text) && Number(text) >= 1) {
                const next = { ...pattern };
                if (Number(text) === DEFAULT_LIMIT) delete next.limit;
                else next.limit = Number(text);
                change(next);
              }
            }}
          />
          <span>{t("graphPatterns.limit.after")}</span>
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={pending || counted?.state === "busy"}
            onClick={() => void countMatches()}
          >
            {t("graphPatterns.count.button")}
          </button>
          <span role="status" className="pattern__counted">
            {counted === null || counted.state === "busy"
              ? ""
              : counted.state === "done"
                ? t("graphPatterns.count.done", { count: counted.n.toLocaleString(language) })
                : counted.message}
          </span>
          <p className="field__hint pattern__limit-hint" id={`${id}-limit-hint`}>
            {t("graphPatterns.limit.hint")}
          </p>
        </div>
      )}
      {pattern.nodes.length === 0 ? null : (
        <section className="pattern__query" aria-labelledby={`${id}-query`}>
          <div className="pattern__query-head">
            <h3 className="pattern-schema__caption" id={`${id}-query`}>
              {t("graphPatterns.query.title")}
            </h3>
            <span className="field__hint">
              {t("graphPatterns.query.follows", { language: languageName })}
            </span>
            <button
              type="button"
              className="button button--ghost button--small"
              disabled={compiled.data === undefined}
              onClick={() =>
                void writeClipboard(compiled.data?.text ?? "").then((ok) => setCopied(ok))
              }
            >
              {copied ? t("graphPatterns.query.copied") : t("graphPatterns.query.copy")}
            </button>
            <button
              type="button"
              className="button button--secondary button--small"
              disabled={compiled.data === undefined || compiled.isError}
              onClick={() => onEditAsText(editable.text, editable.params)}
            >
              {t("graphPatterns.query.editAsText", { language: languageName })}
            </button>
          </div>
          {gsqlOptional ? (
            <p className="field__hint">{t("graphPatterns.query.gsqlOptional")}</p>
          ) : compiled.isError ? (
            <p className="field__error" role="alert">
              {errorMessage(t, compiled.error)}
            </p>
          ) : (
            <pre className="pattern__text" aria-busy={compiled.isFetching}>
              {compiled.data?.text ?? t("graphPatterns.query.writing")}
            </pre>
          )}
          <p className="field__hint">{t("graphPatterns.query.hint")}</p>
        </section>
      )}
      {parameters.length === 0 ? null : (
        <ParametersTable
          parameters={parameters}
          samples={samples}
          onSamples={live ? onSamples : undefined}
          onType={(name, type) =>
            change({
              ...pattern,
              parameters: parameters.map((p) => (p.name === name ? { ...p, type } : p)),
            })
          }
          onPaste={setPaste}
        />
      )}
      <p className="field__hint">{t("graphPatterns.keys")}</p>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      {paste === null ? null : (
        <PasteValuesDialog
          name={paste.name}
          type={isListType(paste.type) ? paste.type : "stringList"}
          initial={(() => {
            const value = samples?.[paste.name];
            return Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
          })()}
          onAccept={(values, type) => {
            if (type !== paste.type) {
              change({
                ...pattern,
                parameters: parameters.map((p) => (p.name === paste.name ? { ...p, type } : p)),
              });
            }
            onSamples?.({ ...(samples ?? {}), [paste.name]: values.join("\n") });
          }}
          onClose={() => setPaste(null)}
        />
      )}
    </div>
  );
}

function EmptyPattern({
  schema,
  onAdd,
}: {
  schema: GraphSourceSchema | undefined;
  onAdd: (label?: string) => void;
}) {
  const { t, language } = useI18n();
  return (
    <div className="pattern-empty">
      <h3 className="pattern-empty__title">{t("graphPatterns.empty.title")}</h3>
      <p>{t("graphPatterns.empty.text")}</p>
      {schema === undefined || schema.labels.length === 0 ? (
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => onAdd()}
        >
          {t("graphPatterns.bar.addNode")}
        </button>
      ) : (
        <>
          <ul className="pattern-empty__labels" aria-label={t("graphPatterns.empty.labels")}>
            {schema.labels.slice(0, 12).map((l) => (
              <li key={l.name}>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => onAdd(l.name)}
                >
                  {l.count === undefined
                    ? l.name
                    : t("graphPatterns.panel.labelCount", {
                        name: l.name,
                        count: l.count.toLocaleString(language),
                      })}
                </button>
              </li>
            ))}
          </ul>
          <p className="field__hint">{t("graphPatterns.empty.labelsHint")}</p>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => onAdd()}
          >
            {t("graphPatterns.empty.anyNode")}
          </button>
        </>
      )}
    </div>
  );
}

/** The pattern as a list (frame 25): one row per element in the order of the query. */
export function PatternList({
  pattern,
  selection,
  onSelect,
  onAdd,
}: {
  pattern: Pattern;
  selection: Selection;
  onSelect?: ((selection: Selection) => void) | undefined;
  onAdd?: (() => void) | undefined;
}) {
  const { t, language } = useI18n();
  return (
    <div className="pattern-list">
      <ul aria-label={t("graphPatterns.list.label")}>
        {elementOrder(pattern).map((element) => {
          const selected = selection?.kind === element.kind && selection.id === element.id;
          let text = "";
          if (element.kind === "node") {
            const node = nodeById(pattern, element.id);
            if (node === undefined) return null;
            const conditions = (node.conditions ?? []).map((c) => conditionPhrase(t, c));
            text = [nodePhrase(t, language, node), ...conditions].join(" · ");
          } else {
            const edge = edgeById(pattern, element.id);
            if (edge === undefined) return null;
            const types = (edge.types ?? []).join(" | ") || t("graphPatterns.drawing.anyType");
            const [from, to] =
              edge.direction === "in" ? [edge.to, edge.from] : [edge.from, edge.to];
            text = t(
              edge.direction === "both" ? "graphPatterns.list.edgeBoth" : "graphPatterns.list.edge",
              {
                id: edge.id,
                types,
                from,
                to,
                length:
                  (edge.maxHops ?? 1) > 1
                    ? t("graphPatterns.list.hops", {
                        min: edge.minHops ?? 1,
                        max: edge.maxHops ?? 1,
                      })
                    : t("graphPatterns.list.one"),
              },
            );
            if (edge.optional === true) text = `${text} · ${t("graphPatterns.list.optional")}`;
          }
          return (
            <li key={`${element.kind}:${element.id}`}>
              {onSelect === undefined ? (
                <span className="pattern-list__row">{text}</span>
              ) : (
                <button
                  type="button"
                  className="pattern-list__row"
                  aria-pressed={selected}
                  data-element={`${element.kind}:${element.id}`}
                  onClick={() => onSelect(element)}
                >
                  <span className="pattern-list__kind">
                    {t(
                      element.kind === "node"
                        ? "graphPatterns.list.node"
                        : "graphPatterns.list.edgeKind",
                    )}
                  </span>{" "}
                  {text}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {onAdd === undefined ? null : (
        <button type="button" className="button button--secondary button--small" onClick={onAdd}>
          {t("graphPatterns.bar.addNode")}
        </button>
      )}
    </div>
  );
}

function Warnings({
  warnings,
  onChooseType,
}: {
  warnings: ReturnType<typeof warningsOf>;
  onChooseType: () => void;
}) {
  const { t } = useI18n();
  const shown = warnings.filter((w) => w.kind === "open" || w.kind === "edgeNotInSchema");
  if (shown.length === 0) return null;
  return (
    <div className="pattern__warnings">
      {shown.map((w) =>
        w.kind === "open" ? (
          <div key="open" className="pattern-note" role="note">
            <p>{t("graphPatterns.warning.open")}</p>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={onChooseType}
            >
              {t("graphPatterns.warning.chooseType")}
            </button>
          </div>
        ) : w.kind === "edgeNotInSchema" ? (
          <div key={`edge-${w.edge}`} className="pattern-note" role="note">
            <p>
              {t("graphPatterns.warning.edgeNotInSchema", { type: w.type, from: w.from, to: w.to })}
            </p>
          </div>
        ) : null,
      )}
    </div>
  );
}

function ParametersTable({
  parameters,
  samples,
  onSamples,
  onType,
  onPaste,
}: {
  parameters: PatternParameter[];
  samples: Readonly<Record<string, unknown>> | undefined;
  onSamples: ((samples: Record<string, unknown>) => void) | undefined;
  onType: (name: string, type: ParameterType) => void;
  onPaste: (parameter: PatternParameter) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const types = (list: boolean): ParameterType[] =>
    list
      ? ["stringList", "integerList", "floatList", "idList"]
      : ["string", "integer", "float", "boolean"];
  return (
    <section className="pattern__parameters" aria-labelledby={`${id}-title`}>
      <h3 className="pattern-schema__caption" id={`${id}-title`}>
        {t("graphPatterns.parameters.title")}
      </h3>
      <table className="pattern-table">
        <thead>
          <tr>
            <th scope="col">{t("graphPatterns.parameters.variable")}</th>
            <th scope="col">{t("graphPatterns.parameters.type")}</th>
            <th scope="col">{t("graphPatterns.parameters.from")}</th>
            {onSamples === undefined ? null : (
              <th scope="col">{t("graphPatterns.parameters.sample")}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {parameters.map((p) => {
            const raw = samples?.[p.name];
            const typed = typedSample(p.type, raw);
            const list = isListType(p.type);
            const empty = raw === undefined || raw === "";
            return (
              <tr key={p.name}>
                <th scope="row">
                  <code>${p.name}</code>
                </th>
                <td>
                  <Select
                    aria-label={t("graphPatterns.parameters.typeOf", { name: p.name })}
                    value={p.type}
                    onChange={(type) => onType(p.name, type as ParameterType)}
                  >
                    {types(list).map((type) => (
                      <option key={type} value={type}>
                        {t(TYPE_TEXT[type])}
                      </option>
                    ))}
                  </Select>
                </td>
                <td>
                  {t(
                    onSamples === undefined
                      ? "graphPatterns.parameters.fromDashboard"
                      : "graphPatterns.parameters.fromSample",
                  )}
                </td>
                {onSamples === undefined ? null : (
                  <td>
                    {list ? (
                      <span className="pattern-panel__row">
                        <span>
                          {Array.isArray(typed)
                            ? t("graphPatterns.parameters.values", { count: typed.length })
                            : t("graphPatterns.parameters.noValues")}
                        </span>
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => onPaste(p)}
                        >
                          {t("graphPatterns.condition.paste")}
                        </button>
                      </span>
                    ) : p.type === "boolean" ? (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={raw === true}
                          onChange={(event) =>
                            onSamples({ ...(samples ?? {}), [p.name]: event.currentTarget.checked })
                          }
                        />
                        {t("graphPatterns.parameters.true")}
                      </label>
                    ) : (
                      <input
                        className="input"
                        aria-label={t("graphPatterns.parameters.sampleOf", { name: p.name })}
                        value={
                          typeof raw === "string" || typeof raw === "number" ? String(raw) : ""
                        }
                        aria-invalid={!empty && typed === undefined ? true : undefined}
                        onChange={(event) =>
                          onSamples({ ...(samples ?? {}), [p.name]: event.currentTarget.value })
                        }
                      />
                    )}
                    {typed !== undefined ? null : empty ? (
                      <p className="field__error">
                        {t("graphPatterns.parameters.missing", { name: p.name })}
                      </p>
                    ) : (
                      <p className="field__error">
                        {t("graphPatterns.parameters.wrongType", {
                          name: p.name,
                          type: t(TYPE_TEXT[p.type]),
                        })}
                      </p>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="field__hint">
        {t(
          onSamples === undefined
            ? "graphPatterns.parameters.hintDashboard"
            : "graphPatterns.parameters.hint",
        )}
      </p>
    </section>
  );
}

export interface ModeNoteProps {
  /** The text runs and no pattern was drawn, the text runs beside a greyed pattern, or the text just took over. */
  kind: "textOnly" | "stale" | "switched";
  pattern?: Pattern | undefined;
  onRestore?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
}

/** Which of the two forms is in force (board Graph083, frame 9; decision 2). */
export function ModeNote({ kind, pattern, onRestore, onDismiss }: ModeNoteProps) {
  const { t } = useI18n();
  return (
    <>
      <p>
        {t(
          kind === "textOnly"
            ? "graphPatterns.modes.textOnly"
            : kind === "stale"
              ? "graphPatterns.modes.stale"
              : "graphPatterns.modes.switched",
        )}
      </p>
      {pattern === undefined ? null : (
        <div className="graph-modes__stale">
          <PatternList pattern={pattern} selection={null} />
        </div>
      )}
      {onRestore === undefined ? null : (
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={onRestore}
        >
          {t("graphPatterns.modes.restore")}
        </button>
      )}
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={onDismiss}
        >
          {t("graphPatterns.modes.understood")}
        </button>
      )}
    </>
  );
}

/** "Was der Baukasten kann" (board Graph083, frame 10): what the way back reads, and what not. */
export function CanDoHelp() {
  const { t } = useI18n();
  return (
    <details>
      <summary>{t("graphPatterns.back.canDo")}</summary>
      <p>{t("graphPatterns.back.canDoCypher")}</p>
      <p>{t("graphPatterns.back.canDoGsql")}</p>
      <p>{t("graphPatterns.back.cannot")}</p>
    </details>
  );
}
