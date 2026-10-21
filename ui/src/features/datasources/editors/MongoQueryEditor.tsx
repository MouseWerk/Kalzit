import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { isRecord } from "../../../api/client";
import type { FieldType } from "../../../api/generated/shapes";
import { DocumentTree } from "../../../documents/DocumentTree";
import {
  type FrameProjection,
  PROJECTION_TYPES,
  type ProjectionColumn,
} from "../../../documents/projection";
import { filterPaths, schemaOf } from "../../../documents/schema";
import { SetSummary } from "../../../documents/shared";
import { useI18n } from "../../../i18n/i18n";
import { errorBodyMessage } from "../../dashboards/ui/errors";
import { runQuery, schemaQuery } from "../api";
import {
  allStages,
  fromStages,
  isStage,
  type MongoAggregateQuery,
  type MongoFindQuery,
  type MongoQuery,
  parseMongoQuery,
  previewQuery,
  type Stage,
  stageName,
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
const TEMPLATES: Record<string, unknown> = {
  $match: {},
  $project: {},
  $group: { _id: null, count: { $sum: 1 } },
  $sort: {},
  $limit: 20,
  $skip: 0,
  $unwind: "$",
  $lookup: { from: "", localField: "", foreignField: "", as: "" },
  $count: "count",
  $sample: { size: 20 },
  $unset: "",
  $sortByCount: "$",
  $replaceRoot: { newRoot: "$" },
};

function template(name: string): Stage {
  return { [name]: TEMPLATES[name] ?? {} };
}

/** Collections of the source as its schema route answers them (adapter in api.ts). */
function useCollections(orgId: string, datasourceId: string) {
  const schema = useQuery(schemaQuery(orgId, datasourceId));
  return {
    collections: schema.data?.kind === "collections" ? schema.data.collections : [],
    failed: schema.isError,
  };
}

/**
 * The MongoDB editor: a collection, then either an aggregation pipeline (stages as a list, each
 * edited as JSON with stage-specific completion, a preview after each stage on demand, and a
 * raw view of the whole pipeline) or a `find` with filter, projection, sort and limit. Below
 * both, the visible projection step to a table.
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
  const { collections, failed } = useCollections(orgId, datasource.id);
  const [sampled, setSampled] = useState<string[]>([]);
  const known = collections.find((c) => c.name === value.collection);
  const fields = [
    ...new Set([...filterPaths(known?.fields ?? []), ...sampled].filter((f) => f !== "")),
  ];

  const update = (next: MongoQuery) => onChange(next);

  function switchMode(mode: "aggregate" | "find") {
    if (mode === value.mode) {
      return;
    }
    const base = { collection: value.collection };
    const toFrame = value.toFrame === undefined ? {} : { toFrame: value.toFrame };
    update(
      mode === "find"
        ? { ...base, mode: "find", filter: {}, ...toFrame }
        : { ...base, mode: "aggregate", pipeline: [], ...toFrame },
    );
  }

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
            onChange={(event) => update({ ...value, collection: event.currentTarget.value })}
          />
          <datalist id={listId}>
            {collections.map((collection) => (
              <option key={collection.name} value={collection.name} />
            ))}
          </datalist>
        </div>
        <fieldset className="pipeline__mode">
          <legend className="field__label">{t("documents.pipeline.mode")}</legend>
          {(["aggregate", "find"] as const).map((mode) => (
            <label key={mode} className="radio">
              <input
                type="radio"
                name={`${collectionId}-mode`}
                value={mode}
                checked={value.mode === mode}
                onChange={() => switchMode(mode)}
              />
              <span>{t(`documents.pipeline.mode.${mode}`)}</span>
            </label>
          ))}
        </fieldset>
      </div>
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t("documents.pipeline.hint")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      {value.mode === "aggregate" ? (
        <PipelineEditor
          orgId={orgId}
          datasourceId={datasource.id}
          query={value}
          fields={fields}
          hintId={hintId}
          onChange={update}
          onRun={onRun}
          onSampled={setSampled}
        />
      ) : (
        <FindEditor query={value} fields={fields} hintId={hintId} onChange={update} onRun={onRun} />
      )}
      <ProjectionEditor
        projection={value.toFrame}
        fields={fields}
        onChange={(toFrame) => {
          const next: MongoQuery = { ...value };
          if (toFrame === undefined) {
            delete next.toFrame;
          } else {
            next.toFrame = toFrame;
          }
          update(next);
        }}
      />
    </fieldset>
  );
}

function stageProblem(t: ReturnType<typeof useI18n>["t"], value: unknown): string | null {
  if (!isStage(value)) {
    return t("documents.pipeline.notStage");
  }
  const name = stageName(value);
  if ((WRITE_STAGES as readonly string[]).includes(name)) {
    return t("documents.pipeline.writeStage", { stage: name });
  }
  return null;
}

interface PipelineEditorProps {
  orgId: string;
  datasourceId: string;
  query: MongoAggregateQuery;
  fields: readonly string[];
  hintId: string;
  onChange: (query: MongoAggregateQuery) => void;
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
  const [view, setView] = useState<"stages" | "raw">("stages");
  const [toAdd, setToAdd] = useState<string>("$match");
  // Stable keys for the stages, so moving one keeps its editor and preview.
  const [keys, setKeys] = useState<{ ids: number[]; next: number }>(() => ({
    ids: allStages(query).map((_, i) => i),
    next: allStages(query).length,
  }));
  const [focus, setFocus] = useState<string | null>(null);
  const entries = allStages(query);
  if (keys.ids.length !== entries.length) {
    // Stages added or removed from outside (a filter by click): new ones get new keys.
    const ids = keys.ids.slice(0, entries.length);
    let next = keys.next;
    while (ids.length < entries.length) {
      ids.push(next++);
    }
    setKeys({ ids, next });
  }

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

  function commit(nextEntries: typeof entries, ids: number[], next = keys.next) {
    setKeys({ ids, next });
    onChange(fromStages(query, nextEntries));
  }

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= entries.length) {
      return;
    }
    const nextEntries = [...entries];
    const ids = [...keys.ids];
    [nextEntries[index], nextEntries[target]] = [
      nextEntries[target] as (typeof entries)[number],
      nextEntries[index] as (typeof entries)[number],
    ];
    [ids[index], ids[target]] = [ids[target] as number, ids[index] as number];
    commit(nextEntries, ids);
    setFocus(`${baseId}-${keys.ids[index]}-${by === -1 ? "up" : "down"}`);
  }

  function remove(index: number) {
    commit(
      entries.filter((_, i) => i !== index),
      keys.ids.filter((_, i) => i !== index),
    );
    setFocus(addId);
  }

  function add() {
    commit(
      [...entries, { stage: template(toAdd), enabled: true }],
      [...keys.ids, keys.next],
      keys.next + 1,
    );
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
      {view === "raw" ? (
        <div className="pipeline__raw">
          {disabledCount > 0 ? (
            <p className="field__hint">
              {t("documents.pipeline.rawDisabled", { count: disabledCount })}
            </p>
          ) : null}
          <JsonField
            label={t("documents.pipeline.raw")}
            value={query.pipeline}
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
            onChange={(value) => {
              const stages = (value as Stage[]).map((stage) => ({ stage, enabled: true }));
              commit(
                stages,
                stages.map((_, i) => keys.next + i),
                keys.next + stages.length,
              );
            }}
            onRun={onRun}
          />
        </div>
      ) : (
        <>
          {entries.length === 0 ? (
            <p className="field__hint">{t("documents.pipeline.noStages")}</p>
          ) : (
            <ol className="pipeline__stages">
              {entries.map((entry, index) => {
                const id = keys.ids[index] ?? index;
                return (
                  <StageItem
                    key={id}
                    domId={`${baseId}-${id}`}
                    index={index}
                    count={entries.length}
                    entry={entry}
                    fields={fields}
                    hintId={hintId}
                    orgId={orgId}
                    datasourceId={datasourceId}
                    preview={() => previewQuery(query, index)}
                    onStage={(stage) =>
                      onChange(
                        fromStages(
                          query,
                          entries.map((e, i) => (i === index ? { ...e, stage } : e)),
                        ),
                      )
                    }
                    onEnabled={(enabled) =>
                      onChange(
                        fromStages(
                          query,
                          entries.map((e, i) => (i === index ? { ...e, enabled } : e)),
                        ),
                      )
                    }
                    onMove={(by) => move(index, by)}
                    onRemove={() => remove(index)}
                    onRun={onRun}
                    onSampled={onSampled}
                  />
                );
              })}
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
            <button type="button" id={addId} className="button button--secondary" onClick={add}>
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
  entry: { stage: Stage; enabled: boolean };
  fields: readonly string[];
  hintId: string;
  orgId: string;
  datasourceId: string;
  preview: () => MongoAggregateQuery;
  onStage: (stage: Stage) => void;
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
  onStage,
  onEnabled,
  onMove,
  onRemove,
  onRun,
  onSampled,
}: StageItemProps) {
  const { t } = useI18n();
  const number = index + 1;
  const name = stageName(entry.stage);
  const [requested, setRequested] = useState<{ query: MongoAggregateQuery; at: number } | null>(
    null,
  );
  return (
    <li
      className={entry.enabled ? "pipeline__stage" : "pipeline__stage pipeline__stage--off"}
      aria-labelledby={`${domId}-title`}
    >
      <div className="pipeline__stage-head">
        <h4 className="pipeline__stage-title" id={`${domId}-title`}>
          {t("documents.pipeline.stage", { number, name })}
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
        value={entry.stage}
        describedBy={hintId}
        validate={(value) => stageProblem(t, value)}
        complete={(text, cursor, explicit) =>
          mongoCompletions(text, cursor, "stage", fields, explicit)
        }
        onChange={(value) => onStage(value as Stage)}
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
  query: MongoAggregateQuery;
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

function FindEditor({
  query,
  fields,
  hintId,
  onChange,
  onRun,
}: {
  query: MongoFindQuery;
  fields: readonly string[];
  hintId: string;
  onChange: (query: MongoFindQuery) => void;
  onRun?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const limitId = useId();
  const [limit, setLimit] = useState(query.limit === undefined ? "" : String(query.limit));
  const limitValid = limit.trim() === "" || /^[1-9]\d*$/.test(limit.trim());
  const objectOnly = (value: unknown) =>
    isRecord(value) ? null : t("documents.pipeline.notObject");
  const part = (
    name: "filter" | "projection" | "sort",
    target: MongoEditorTarget,
    optional: boolean,
  ) => (
    <div className="field">
      <span className="field__label" aria-hidden="true">
        {t(`documents.find.${name}`)}
      </span>
      <JsonField
        label={t(`documents.find.${name}`)}
        value={query[name]}
        optional={optional}
        rows={3}
        describedBy={hintId}
        validate={objectOnly}
        complete={(text, cursor, explicit) =>
          mongoCompletions(text, cursor, target, fields, explicit)
        }
        onChange={(value) => {
          const next: MongoFindQuery = { ...query };
          if (value === undefined) {
            if (name === "filter") {
              next.filter = {};
            } else {
              delete next[name];
            }
          } else {
            next[name] = value as Record<string, unknown>;
          }
          onChange(next);
        }}
        onRun={onRun}
      />
    </div>
  );
  return (
    <div className="pipeline__body">
      {part("filter", "filter", false)}
      {part("projection", "projection", true)}
      {part("sort", "sort", true)}
      <div className="field pipeline__limit">
        <label className="field__label" htmlFor={limitId}>
          {t("documents.find.limit")}
        </label>
        <input
          id={limitId}
          className="input"
          inputMode="numeric"
          value={limit}
          aria-invalid={limitValid ? undefined : true}
          aria-describedby={limitValid ? undefined : `${limitId}-error`}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setLimit(text);
            const next: MongoFindQuery = { ...query };
            if (text.trim() === "") {
              delete next.limit;
              onChange(next);
            } else if (/^[1-9]\d*$/.test(text.trim())) {
              next.limit = Number(text.trim());
              onChange(next);
            }
          }}
        />
        {limitValid ? null : (
          <p className="field__error" id={`${limitId}-error`}>
            {t("documents.find.limitInvalid")}
          </p>
        )}
      </div>
    </div>
  );
}

const TYPE_CHOICES: readonly ("" | FieldType)[] = ["", ...PROJECTION_TYPES];

/**
 * The projection step: which field paths become which columns of a table. Without it, panels
 * for tables say they need one; with it, the query's documents arrive as that table.
 */
function ProjectionEditor({
  projection,
  fields,
  onChange,
}: {
  projection: FrameProjection | undefined;
  fields: readonly string[];
  onChange: (projection: FrameProjection | undefined) => void;
}) {
  const { t } = useI18n();
  const baseId = useId();
  const listId = `${baseId}-fields`;
  const columns = projection?.columns ?? [];
  const setColumn = (index: number, patch: Partial<ProjectionColumn>) =>
    onChange({
      columns: columns.map((column, i) => {
        if (i !== index) {
          return column;
        }
        const next: ProjectionColumn = { ...column, ...patch };
        if (next.name === "") {
          delete next.name;
        }
        return next;
      }),
    });
  return (
    <fieldset className="pipeline__projection">
      <legend className="field__label">{t("documents.projection.title")}</legend>
      <p className="field__hint">
        {projection === undefined
          ? t("documents.projection.none")
          : t("documents.projection.active")}
      </p>
      <datalist id={listId}>
        {fields.map((field) => (
          <option key={field} value={field} />
        ))}
      </datalist>
      {projection === undefined ? (
        <div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onChange({ columns: [{ path: "" }] })}
          >
            {t("documents.projection.add")}
          </button>
        </div>
      ) : (
        <>
          <ol className="pipeline__columns">
            {columns.map((column, index) => {
              const number = index + 1;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions; paths can repeat while typing
                <li key={index} className="pipeline__column">
                  <div className="field">
                    <label className="field__label" htmlFor={`${baseId}-${index}-path`}>
                      {t("documents.projection.path", { number })}
                    </label>
                    <input
                      id={`${baseId}-${index}-path`}
                      className="input input--mono"
                      list={listId}
                      value={column.path}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setColumn(index, { path: event.currentTarget.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${baseId}-${index}-name`}>
                      {t("documents.projection.name", { number })}
                    </label>
                    <input
                      id={`${baseId}-${index}-name`}
                      className="input"
                      value={column.name ?? ""}
                      placeholder={column.path}
                      onChange={(event) => setColumn(index, { name: event.currentTarget.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${baseId}-${index}-type`}>
                      {t("documents.projection.type", { number })}
                    </label>
                    <select
                      id={`${baseId}-${index}-type`}
                      className="select"
                      value={column.type ?? ""}
                      onChange={(event) => {
                        const type = event.currentTarget.value as "" | FieldType;
                        const next: ProjectionColumn = { ...column };
                        if (type === "") {
                          delete next.type;
                        } else {
                          next.type = type;
                        }
                        onChange({ columns: columns.map((c, i) => (i === index ? next : c)) });
                      }}
                    >
                      {TYPE_CHOICES.map((type) => (
                        <option key={type} value={type}>
                          {t(`documents.projection.type.${type === "" ? "auto" : type}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("documents.projection.removeColumn", { number })}
                    onClick={() => onChange({ columns: columns.filter((_, i) => i !== index) })}
                  >
                    {t("documents.pipeline.removeShort")}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="pipeline__add">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => onChange({ columns: [...columns, { path: "" }] })}
            >
              {t("documents.projection.addColumn")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => onChange(undefined)}
            >
              {t("documents.projection.remove")}
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
