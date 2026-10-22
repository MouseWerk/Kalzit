import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { isRecord } from "../../../api/client";
import { DocumentTree } from "../../../documents/DocumentTree";
import { filterPaths, schemaOf } from "../../../documents/schema";
import { SetSummary } from "../../../documents/shared";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { errorBodyMessage } from "../../dashboards/ui/errors";
import { runQuery, schemaQuery } from "../api";
import {
  joinPipeline,
  type MongoQuery,
  modeOf,
  parseMongoQuery,
  previewQuery,
  splitPipeline,
  stageNameOf,
  WRITE_STAGES,
} from "../mongoQuery";
import { JsonField } from "./JsonField";
import { type MongoEditorTarget, mongoCompletions, STAGES } from "./mongoCompletion";
import type { QueryEditorProps } from "./QueryEditor";
import "../../../documents/documents.css";
import "./editors.css";
import "../../dashboards/ui/shared.css";

/** Documents a stage preview asks for: enough to see the shape, cheap to run. */
export const PREVIEW_LIMIT = 20;
/** The time range a preview runs with, for pipelines that use the time macros. */
const PREVIEW_RANGE_MS = 60 * 60 * 1000;

/** What a new stage starts with, so it is valid JSON from the first moment. */
const TEMPLATES: Record<string, string> = {
  $match: '{"$match": {}}',
  $group: '{"$group": {"_id": null, "count": {"$sum": 1}}}',
  $limit: '{"$limit": 20}',
  $skip: '{"$skip": 0}',
  $unwind: '{"$unwind": "$"}',
  $lookup: '{"$lookup": {"from": "", "localField": "", "foreignField": "", "as": ""}}',
  $count: '{"$count": "count"}',
  $sample: '{"$sample": {"size": 20}}',
  $unset: '{"$unset": ""}',
  $sortByCount: '{"$sortByCount": "$"}',
  $replaceRoot: '{"$replaceRoot": {"newRoot": "$"}}',
};

const template = (name: string) => TEMPLATES[name] ?? `{${JSON.stringify(name)}: {}}`;

/** The stage name of a stage text, or "" while it does not parse. */
function nameOf(text: string): string {
  try {
    return stageNameOf(JSON.parse(text)) ?? "";
  } catch {
    return "";
  }
}

function stageProblem(t: Translate, value: unknown): string | null {
  const name = stageNameOf(value);
  if (name === null) {
    return t("documents.pipeline.notStage");
  }
  if ((WRITE_STAGES as readonly string[]).includes(name)) {
    return t("documents.pipeline.writeStage", { stage: name });
  }
  return null;
}

/**
 * The MongoDB editor: a collection, then either an aggregation pipeline (stages as a list, each
 * edited as Extended JSON with stage-specific completion, a preview after each stage on demand,
 * and a raw view of the whole pipeline) or a `find` with filter, projection, sort, skip and
 * limit. The query keeps the texts as written (mongoQuery.ts).
 */
export function MongoQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const collectionId = useId();
  const listId = useId();
  const hintId = useId();
  const value = parseMongoQuery(query);
  const mode = modeOf(value);
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  const collections = schema.data?.kind === "collections" ? schema.data.collections : [];
  const [sampled, setSampled] = useState<string[]>([]);
  const known = collections.find((c) => c.name === value.collection);
  const fields = [
    ...new Set([...filterPaths(known?.fields ?? []), ...sampled].filter((f) => f !== "")),
  ];

  return (
    <fieldset className="pipeline">
      <legend className="visually-hidden">{label ?? t("datasources.editor.label")}</legend>
      <div className="pipeline__head">
        <div className="field pipeline__collection">
          <label className="field__label" htmlFor={collectionId}>
            {t("documents.pipeline.collection")}
          </label>
          <input
            id={collectionId}
            className="input input--mono"
            list={listId}
            value={value.collection}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onChange({ ...value, collection: event.currentTarget.value })}
          />
          <datalist id={listId}>
            {collections.map((collection) => (
              <option key={collection.name} value={collection.name} />
            ))}
          </datalist>
        </div>
        <fieldset className="pipeline__mode">
          <legend className="field__label">{t("documents.pipeline.mode")}</legend>
          {(["aggregate", "find"] as const).map((name) => (
            <label key={name} className="radio">
              <input
                type="radio"
                name={`${collectionId}-mode`}
                value={name}
                checked={mode === name}
                onChange={() =>
                  onChange(
                    name === "find"
                      ? { collection: value.collection }
                      : { collection: value.collection, pipeline: "[]" },
                  )
                }
              />
              <span>{t(`documents.pipeline.mode.${name}`)}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t("documents.pipeline.hint")}{" "}
        {t("documents.pipeline.macros")}
        {schema.isError ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      {mode === "aggregate" ? (
        <PipelineEditor
          orgId={orgId}
          datasourceId={datasource.id}
          query={value}
          fields={fields}
          hintId={hintId}
          onChange={onChange}
          onRun={onRun}
          onSampled={setSampled}
        />
      ) : (
        <FindEditor
          query={value}
          fields={fields}
          hintId={hintId}
          onChange={onChange}
          onRun={onRun}
        />
      )}
    </fieldset>
  );
}

interface Entry {
  id: number;
  text: string;
  enabled: boolean;
}

interface Stages {
  entries: Entry[];
  next: number;
  /** The pipeline text these entries stand for, to tell a change from outside. */
  synced: string;
}

function initialStages(pipeline: string): Stages {
  const texts = splitPipeline(pipeline) ?? [];
  return {
    entries: texts.map((text, id) => ({ id, text, enabled: true })),
    next: texts.length,
    synced: pipeline,
  };
}

/**
 * The entries after the pipeline changed from outside: its stages replace the enabled ones in
 * order, disabled stages keep their places, and new stages are added at the end.
 */
function mergeStages(current: Stages, pipeline: string): Stages {
  const texts = splitPipeline(pipeline) ?? [];
  const entries: Entry[] = [];
  let k = 0;
  let next = current.next;
  for (const entry of current.entries) {
    if (!entry.enabled) {
      entries.push(entry);
    } else if (k < texts.length) {
      entries.push({ ...entry, text: texts[k++] as string });
    }
  }
  while (k < texts.length) {
    entries.push({ id: next++, text: texts[k++] as string, enabled: true });
  }
  return { entries, next, synced: pipeline };
}

interface PipelineEditorProps {
  orgId: string;
  datasourceId: string;
  query: MongoQuery;
  fields: readonly string[];
  hintId: string;
  onChange: (query: MongoQuery) => void;
  onRun?: (() => void) | undefined;
  onSampled: (fields: string[]) => void;
}

function PipelineEditor({
  orgId,
  datasourceId,
  query,
  fields,
  hintId,
  onChange,
  onRun,
  onSampled,
}: PipelineEditorProps) {
  const { t } = useI18n();
  const baseId = useId();
  const addId = useId();
  const pipeline = query.pipeline ?? "[]";
  // A stored pipeline that is not an array of stages opens in the raw view, where it can be fixed.
  const [view, setView] = useState<"stages" | "raw">(() =>
    splitPipeline(pipeline) === null ? "raw" : "stages",
  );
  const [toAdd, setToAdd] = useState<string>("$match");
  // Disabled stages are the editor's own: the server's query form has no place for them.
  const [stages, setStages] = useState<Stages>(() => initialStages(pipeline));
  const [focus, setFocus] = useState<string | null>(null);
  if (pipeline !== stages.synced) {
    setStages(mergeStages(stages, pipeline));
  }
  const { entries } = stages;

  useEffect(() => {
    if (focus === null) {
      return;
    }
    setFocus(null);
    const target = document.getElementById(focus);
    if (target instanceof HTMLButtonElement && target.disabled) {
      // At the top or bottom the button just used is off; its partner keeps the place.
      const partner = focus.endsWith("-up") ? "-down" : "-up";
      document.getElementById(focus.replace(/-(up|down)$/, partner))?.focus();
    } else {
      target?.focus();
    }
  }, [focus]);

  function commit(nextEntries: Entry[], next = stages.next) {
    const text = joinPipeline(nextEntries.filter((e) => e.enabled).map((e) => e.text));
    setStages({ entries: nextEntries, next, synced: text });
    onChange({ ...query, pipeline: text });
  }

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    const moved = entries[index];
    const other = entries[target];
    if (moved === undefined || other === undefined) {
      return;
    }
    const nextEntries = [...entries];
    nextEntries[index] = other;
    nextEntries[target] = moved;
    commit(nextEntries);
    setFocus(`${baseId}-${moved.id}-${by === -1 ? "up" : "down"}`);
  }

  const disabledCount = entries.filter((e) => !e.enabled).length;

  return (
    <div className="pipeline__body">
      <fieldset className="pipeline__view">
        <legend className="visually-hidden">{t("documents.pipeline.view")}</legend>
        {(["stages", "raw"] as const).map((name) => (
          <label key={name} className="radio">
            <input
              type="radio"
              name={`${baseId}-view`}
              value={name}
              checked={view === name}
              onChange={() => setView(name)}
            />
            <span>{t(`documents.pipeline.view.${name}`)}</span>
          </label>
        ))}
      </fieldset>
      {disabledCount > 0 ? (
        <p className="field__hint">
          {t("documents.pipeline.disabledNotSaved", { count: disabledCount })}
        </p>
      ) : null}
      {view === "raw" ? (
        <JsonField
          label={t("documents.pipeline.raw")}
          value={pipeline}
          rows={10}
          describedBy={hintId}
          validate={(value) => {
            if (!Array.isArray(value)) {
              return t("documents.pipeline.notArray");
            }
            for (const stage of value) {
              const problem = stageProblem(t, stage);
              if (problem !== null) {
                return problem;
              }
            }
            return null;
          }}
          complete={(text, cursor, explicit) =>
            mongoCompletions(text, cursor, "stage", fields, explicit)
          }
          onChange={(text) => {
            // The raw text runs as typed; disabled stages are not part of it and are dropped.
            const texts = splitPipeline(text) ?? [];
            setStages({
              entries: texts.map((stage, i) => ({
                id: stages.next + i,
                text: stage,
                enabled: true,
              })),
              next: stages.next + texts.length,
              synced: text,
            });
            onChange({ ...query, pipeline: text });
          }}
          onRun={onRun}
        />
      ) : (
        <>
          {entries.length === 0 ? (
            <p className="field__hint">{t("documents.pipeline.noStages")}</p>
          ) : (
            <ol className="pipeline__stages">
              {entries.map((entry, index) => (
                <StageItem
                  key={entry.id}
                  domId={`${baseId}-${entry.id}`}
                  index={index}
                  count={entries.length}
                  entry={entry}
                  fields={fields}
                  hintId={hintId}
                  orgId={orgId}
                  datasourceId={datasourceId}
                  preview={() =>
                    previewQuery(
                      query,
                      entries
                        .slice(0, index + 1)
                        .filter((e) => e.enabled)
                        .map((e) => e.text),
                    )
                  }
                  onText={(text) =>
                    commit(entries.map((e, i) => (i === index ? { ...e, text } : e)))
                  }
                  onEnabled={(enabled) =>
                    commit(entries.map((e, i) => (i === index ? { ...e, enabled } : e)))
                  }
                  onMove={(by) => move(index, by)}
                  onRemove={() => {
                    commit(entries.filter((_, i) => i !== index));
                    setFocus(addId);
                  }}
                  onRun={onRun}
                  onSampled={onSampled}
                />
              ))}
            </ol>
          )}
          <div className="pipeline__add">
            <label className="visually-hidden" htmlFor={`${addId}-stage`}>
              {t("documents.pipeline.addWhich")}
            </label>
            <select
              id={`${addId}-stage`}
              className="select input--mono"
              value={toAdd}
              onChange={(event) => setToAdd(event.currentTarget.value)}
            >
              {STAGES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              id={addId}
              className="button button--secondary"
              onClick={() =>
                commit(
                  [...entries, { id: stages.next, text: template(toAdd), enabled: true }],
                  stages.next + 1,
                )
              }
            >
              {t("documents.pipeline.add")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface StageItemProps {
  domId: string;
  index: number;
  count: number;
  entry: Entry;
  fields: readonly string[];
  hintId: string;
  orgId: string;
  datasourceId: string;
  preview: () => MongoQuery;
  onText: (text: string) => void;
  onEnabled: (enabled: boolean) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onRun?: (() => void) | undefined;
  onSampled: (fields: string[]) => void;
}

function StageItem({
  domId,
  index,
  count,
  entry,
  fields,
  hintId,
  orgId,
  datasourceId,
  preview,
  onText,
  onEnabled,
  onMove,
  onRemove,
  onRun,
  onSampled,
}: StageItemProps) {
  const { t } = useI18n();
  const number = index + 1;
  const [requested, setRequested] = useState<{ query: MongoQuery; at: number } | null>(null);
  return (
    <li
      className={entry.enabled ? "pipeline__stage" : "pipeline__stage pipeline__stage--off"}
      aria-labelledby={`${domId}-title`}
    >
      <div className="pipeline__stage-head">
        <h4 className="pipeline__stage-title" id={`${domId}-title`}>
          {t("documents.pipeline.stage", { number, name: nameOf(entry.text) })}
          {entry.enabled ? "" : ` (${t("documents.pipeline.off")})`}
        </h4>
        <div className="pipeline__stage-actions">
          <label className="checkbox" htmlFor={`${domId}-on`}>
            <input
              id={`${domId}-on`}
              type="checkbox"
              checked={entry.enabled}
              onChange={(event) => onEnabled(event.currentTarget.checked)}
            />
            {t("documents.pipeline.enabled")}
          </label>
          <button
            type="button"
            id={`${domId}-up`}
            className="button button--ghost button--small"
            disabled={index === 0}
            aria-label={t("documents.pipeline.up", { number })}
            onClick={() => onMove(-1)}
          >
            {t("documents.pipeline.upShort")}
          </button>
          <button
            type="button"
            id={`${domId}-down`}
            className="button button--ghost button--small"
            disabled={index === count - 1}
            aria-label={t("documents.pipeline.down", { number })}
            onClick={() => onMove(1)}
          >
            {t("documents.pipeline.downShort")}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            aria-label={t("documents.pipeline.remove", { number })}
            onClick={onRemove}
          >
            {t("documents.pipeline.removeShort")}
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            aria-label={t("documents.pipeline.preview", { number })}
            onClick={() => setRequested({ query: preview(), at: Date.now() })}
          >
            {t("documents.pipeline.previewShort")}
          </button>
        </div>
      </div>
      <JsonField
        label={t("documents.pipeline.stageLabel", { number })}
        value={entry.text}
        describedBy={hintId}
        validate={(value) => stageProblem(t, value)}
        complete={(text, cursor, explicit) =>
          mongoCompletions(text, cursor, "stage", fields, explicit)
        }
        onChange={onText}
        onRun={onRun}
      />
      {requested === null ? null : (
        <StagePreview
          orgId={orgId}
          datasourceId={datasourceId}
          number={number}
          query={requested.query}
          at={requested.at}
          onSampled={onSampled}
        />
      )}
    </li>
  );
}

/** The documents after one stage: the pipeline up to it, run once when asked for. */
function StagePreview({
  orgId,
  datasourceId,
  number,
  query,
  at,
  onSampled,
}: {
  orgId: string;
  datasourceId: string;
  number: number;
  query: MongoQuery;
  at: number;
  onSampled: (fields: string[]) => void;
}) {
  const { t } = useI18n();
  const result = useQuery({
    queryKey: ["mongo-preview", orgId, datasourceId, query, at],
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    queryFn: async ({ signal }) => {
      const response = await runQuery(
        orgId,
        {
          queries: [{ refId: "preview", datasourceId, query, limit: PREVIEW_LIMIT }],
          timeRange: { from: at - PREVIEW_RANGE_MS, to: at },
          variables: {},
        },
        signal,
      );
      return response.results.preview;
    },
  });
  const outcome = result.data;
  const set =
    outcome !== undefined && "result" in outcome && outcome.result.shape === "documents"
      ? outcome.result.documents
      : undefined;

  useEffect(() => {
    if (set !== undefined) {
      onSampled(filterPaths(schemaOf(set)));
    }
  }, [set, onSampled]);

  let body = null;
  if (result.isPending) {
    body = <p className="field__hint">{t("common.loading")}</p>;
  } else if (result.isError) {
    body = <p className="field__error">{t("documents.pipeline.previewFailed")}</p>;
  } else if (outcome !== undefined && "error" in outcome) {
    body = <p className="field__error">{errorBodyMessage(t, outcome.error)}</p>;
  } else if (set === undefined) {
    body = <p className="field__hint">{t("documents.pipeline.previewNotDocuments")}</p>;
  } else {
    body = (
      <>
        <SetSummary set={set} />
        <div className="pipeline__preview-tree">
          <DocumentTree
            items={set.documents}
            itemLabel={(i) => t("documents.tree.document", { number: i + 1 })}
            label={t("documents.pipeline.previewOf", { number })}
          />
        </div>
      </>
    );
  }
  return (
    <section
      className="pipeline__preview"
      aria-label={t("documents.pipeline.previewOf", { number })}
      aria-busy={result.isFetching}
    >
      {body}
    </section>
  );
}

const WHOLE = /^(0|[1-9]\d*)$/;

function FindEditor({
  query,
  fields,
  hintId,
  onChange,
  onRun,
}: {
  query: MongoQuery;
  fields: readonly string[];
  hintId: string;
  onChange: (query: MongoQuery) => void;
  onRun?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const baseId = useId();
  const objectOnly = (value: unknown) =>
    isRecord(value) ? null : t("documents.pipeline.notObject");
  const part = (name: "filter" | "projection" | "sort", target: MongoEditorTarget) => (
    <div className="field">
      <span className="field__label" aria-hidden="true">
        {t(`documents.find.${name}`)}
      </span>
      <JsonField
        label={t(`documents.find.${name}`)}
        value={query[name] ?? ""}
        optional
        rows={3}
        describedBy={hintId}
        validate={objectOnly}
        complete={(text, cursor, explicit) =>
          mongoCompletions(text, cursor, target, fields, explicit)
        }
        onChange={(text) => {
          const next: MongoQuery = { ...query };
          if (text === "") {
            delete next[name];
          } else {
            next[name] = text;
          }
          onChange(next);
        }}
        onRun={onRun}
      />
    </div>
  );
  const number = (name: "skip" | "limit", min: number) => (
    <NumberField
      id={`${baseId}-${name}`}
      label={t(`documents.find.${name}`)}
      error={t(min === 0 ? "documents.find.skipInvalid" : "documents.find.limitInvalid")}
      value={query[name]}
      min={min}
      onChange={(value) => {
        const next: MongoQuery = { ...query };
        if (value === undefined) {
          delete next[name];
        } else {
          next[name] = value;
        }
        onChange(next);
      }}
    />
  );
  return (
    <div className="pipeline__body">
      {part("filter", "filter")}
      {part("projection", "projection")}
      {part("sort", "sort")}
      <div className="pipeline__add">
        {number("skip", 0)}
        {number("limit", 1)}
      </div>
    </div>
  );
}

function NumberField({
  id,
  label,
  error,
  value,
  min,
  onChange,
}: {
  id: string;
  label: string;
  error: string;
  value: number | undefined;
  min: number;
  onChange: (value: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const valid = text.trim() === "" || (WHOLE.test(text.trim()) && Number(text) >= min);
  return (
    <div className="field pipeline__limit">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        inputMode="numeric"
        value={text}
        aria-invalid={valid ? undefined : true}
        aria-describedby={valid ? undefined : `${id}-error`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (next.trim() === "") {
            onChange(undefined);
          } else if (WHOLE.test(next.trim()) && Number(next) >= min) {
            onChange(Number(next.trim()));
          }
        }}
      />
      {valid ? null : (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
