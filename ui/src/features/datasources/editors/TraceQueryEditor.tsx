import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useState } from "react";
import { isRecord } from "../../../api/client";
import type { SpanStatus } from "../../../api/generated/shapes";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { useI18n } from "../../../i18n/i18n";
import { isComposingKey } from "../../../lib/ime";
import { type LabelsSchema, schemaQuery } from "../api";
import {
  DEFAULT_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_TAGS,
  parseTraceSearch,
  searchTraceQl,
  type TraceMode,
  type TraceSearch,
  traceMode,
  traceSearchQuery,
  validDuration,
  validTagName,
  validTraceId,
} from "../traceQuery";
import { CodeEditor } from "./CodeEditor";
import type { QueryEditorProps } from "./QueryEditor";
import "./editors.css";
import "./sourceEditors.css";
import "../../dashboards/ui/shared.css";

const STATUSES: readonly (SpanStatus | "")[] = ["", "error", "ok"];

/** A dashboard variable (`$name`, `${name}`): its value is put in, and checked, on the server. */
const hasVariable = (text: string) => /\$\{?\w/.test(text);
const durationOk = (text: string) => hasVariable(text) || validDuration(text);
const tagNameOk = (name: string) =>
  name.trim() === "" || hasVariable(name) || validTagName(name.trim());

/**
 * The query of a trace source (board Traces, frames 1 and 10): a search without a query language
 * that shows the TraceQL it stands for, TraceQL written by hand (Tempo), or one trace by its id.
 * Jaeger has no TraceQL and searches only inside a service; the form shows only what the source
 * can do.
 */
export function TraceQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  onPendingText,
}: QueryEditorProps) {
  const { t } = useI18n();
  const id = useId();
  const tempo = datasource.kind === "tempo";
  const mode = traceMode(query);
  const parsed = parseTraceSearch(query);
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  const labels: LabelsSchema | undefined =
    schema.data?.kind === "labels" ? (schema.data as LabelsSchema) : undefined;
  // Tempo lists its tags with the values of the service and the span name; Jaeger its services,
  // each with its operations.
  const services = tempo ? (labels?.values["resource.service.name"] ?? []) : (labels?.labels ?? []);
  const tagNames = tempo ? (labels?.labels ?? []) : [];
  // The search fields are kept while another form is shown, so switching back loses nothing.
  // They are also the form's own state while they say what the query says: a tag row without a
  // name yet is in the form, not in the query.
  const [kept, setKept] = useState<TraceSearch>(parsed);
  const search =
    mode === "search" &&
    JSON.stringify(traceSearchQuery(kept)) === JSON.stringify(traceSearchQuery(parsed))
      ? kept
      : parsed;
  const operations = tempo
    ? (labels?.values.name ?? [])
    : (labels?.values[search.service.trim()] ?? []);

  const setSearch = (next: TraceSearch) => {
    setKept(next);
    const bad =
      !durationOk(next.minDuration) ||
      !durationOk(next.maxDuration) ||
      next.tags.some(([key]) => !tagNameOk(key));
    onPendingText?.(bad);
    onChange(traceSearchQuery(next));
  };
  const setMode = (next: TraceMode) => {
    if (next === mode) return;
    onPendingText?.(false);
    if (next === "search") onChange(traceSearchQuery(kept));
    else if (next === "traceql") onChange({ traceql: searchTraceQl(search) });
    else onChange({ traceId: "" });
  };
  const modes: TraceMode[] = tempo ? ["search", "traceql", "traceId"] : ["search", "traceId"];
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !isComposingKey(event)) {
      event.preventDefault();
      onRun?.();
    }
  };
  const traceId = isRecord(query) && typeof query.traceId === "string" ? query.traceId : "";
  const traceql = isRecord(query) && typeof query.traceql === "string" ? query.traceql : "";
  const minBad = !durationOk(search.minDuration);
  const maxBad = !durationOk(search.maxDuration);

  return (
    <div className="query-editor trace-query">
      {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a field set */}
      <div className="trace-query__seg" role="group" aria-label={t("traces.query.mode")}>
        {modes.map((name) => (
          <button
            key={name}
            type="button"
            className="trace-query__option"
            aria-pressed={mode === name}
            onClick={() => setMode(name)}
          >
            {t(`traces.query.${name}`)}
          </button>
        ))}
      </div>
      {mode === "search" ? (
        <>
          <div className="trace-query__grid">
            <div className="field">
              <label className="field__label" htmlFor={`${id}-service`}>
                {t("traces.query.service")}
              </label>
              <input
                id={`${id}-service`}
                className="input"
                value={search.service}
                list={`${id}-services`}
                placeholder={tempo ? t("traces.query.any") : t("traces.query.pickService")}
                aria-describedby={tempo ? undefined : `${id}-jaeger`}
                onChange={(event) => setSearch({ ...search, service: event.currentTarget.value })}
                onKeyDown={onEnter}
              />
              <datalist id={`${id}-services`}>
                {services.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-operation`}>
                {t("traces.query.operation")}
              </label>
              <input
                id={`${id}-operation`}
                className="input"
                value={search.operation}
                list={`${id}-operations`}
                placeholder={
                  !tempo && search.service.trim() === ""
                    ? t("traces.query.afterService")
                    : t("traces.query.any")
                }
                disabled={!tempo && search.service.trim() === ""}
                onChange={(event) => setSearch({ ...search, operation: event.currentTarget.value })}
                onKeyDown={onEnter}
              />
              <datalist id={`${id}-operations`}>
                {operations.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-min`}>
                {t("traces.query.min")}
              </label>
              <input
                id={`${id}-min`}
                className="input"
                value={search.minDuration}
                placeholder="500ms"
                aria-invalid={minBad}
                aria-describedby={minBad ? `${id}-duration` : undefined}
                onChange={(event) =>
                  setSearch({ ...search, minDuration: event.currentTarget.value })
                }
                onKeyDown={onEnter}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-max`}>
                {t("traces.query.max")}
              </label>
              <input
                id={`${id}-max`}
                className="input"
                value={search.maxDuration}
                placeholder={t("traces.query.noLimit")}
                aria-invalid={maxBad}
                aria-describedby={maxBad ? `${id}-duration` : undefined}
                onChange={(event) =>
                  setSearch({ ...search, maxDuration: event.currentTarget.value })
                }
                onKeyDown={onEnter}
              />
            </div>
            <div className="field">
              <span className="field__label" id={`${id}-status`}>
                {t("traces.status")}
              </span>
              {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons */}
              <div className="trace-query__seg" role="group" aria-labelledby={`${id}-status`}>
                {STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    className="trace-query__option"
                    aria-pressed={search.status === status}
                    onClick={() => setSearch({ ...search, status })}
                  >
                    {status === ""
                      ? t("traces.show.all")
                      : status === "error"
                        ? t("traces.error")
                        : t("traces.ok")}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-limit`}>
                {t("traces.query.limit")}
              </label>
              <input
                id={`${id}-limit`}
                className="input"
                type="number"
                min={1}
                max={MAX_SEARCH_LIMIT}
                value={search.limit}
                placeholder={String(tempo ? DEFAULT_LIMIT.tempo : DEFAULT_LIMIT.jaeger)}
                onChange={(event) => setSearch({ ...search, limit: event.currentTarget.value })}
                onKeyDown={onEnter}
              />
            </div>
          </div>
          {minBad || maxBad ? (
            <p className="field__error" id={`${id}-duration`}>
              {t("traces.query.durationBad")}
            </p>
          ) : null}
          <fieldset className="trace-query__tags">
            <legend className="field__label">{t("traces.query.tags")}</legend>
            {search.tags.map(([key, value], index) => {
              const bad = !tagNameOk(key);
              const change = (next: [string, string]) =>
                setSearch({
                  ...search,
                  tags: search.tags.map((tag, at) => (at === index ? next : tag)),
                });
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: tags are edited in place; their order is fixed
                <div key={index} className="trace-query__tag">
                  <input
                    className="input input--mono"
                    value={key}
                    list={`${id}-tags`}
                    placeholder="http.status_code"
                    aria-label={t("traces.query.tagName", { n: index + 1 })}
                    aria-invalid={bad}
                    onChange={(event) => change([event.currentTarget.value, value])}
                    onKeyDown={onEnter}
                  />
                  <span aria-hidden="true">=</span>
                  <input
                    className="input input--mono"
                    value={value}
                    placeholder="500"
                    aria-label={t("traces.query.tagValue", { n: index + 1 })}
                    onChange={(event) => change([key, event.currentTarget.value])}
                    onKeyDown={onEnter}
                  />
                  <IconButton
                    icon="close"
                    label={t("traces.query.tagRemove", { n: index + 1 })}
                    onClick={() =>
                      setSearch({ ...search, tags: search.tags.filter((_, at) => at !== index) })
                    }
                  />
                </div>
              );
            })}
            <datalist id={`${id}-tags`}>
              {tagNames.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {search.tags.length < MAX_TAGS ? (
              <button
                type="button"
                className="button button--ghost button--small trace-query__add"
                onClick={() => {
                  // The row is kept here until it has a name: an unnamed tag is not in the query.
                  setSearch({ ...search, tags: [...search.tags, ["", ""]] });
                }}
              >
                <Icon name="plus" />
                {t("traces.query.tag")}
              </button>
            ) : null}
            {search.tags.some(([key]) => !tagNameOk(key)) ? (
              <p className="field__error">{t("traces.query.tagBad")}</p>
            ) : null}
          </fieldset>
          {tempo ? (
            <div className="trace-query__ql">
              <span className="trace-query__ql-label">{t("traces.query.asTraceQl")}</span>
              <code className="trace-query__ql-code">{searchTraceQl(search)}</code>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setMode("traceql")}
              >
                {t("traces.query.openTraceQl")}
              </button>
            </div>
          ) : (
            <p className="field__hint" id={`${id}-jaeger`}>
              {t("traces.query.jaeger")}
            </p>
          )}
        </>
      ) : null}
      {mode === "traceql" ? (
        <CodeEditor
          value={traceql}
          language="promql"
          label={t("traces.query.traceql")}
          rows={3}
          onChange={(text) => onChange({ traceql: text })}
          {...(onRun === undefined ? {} : { onRun })}
        />
      ) : null}
      {mode === "traceId" ? (
        <div className="field trace-query__id">
          <label className="field__label" htmlFor={`${id}-trace`}>
            {t("traces.col.id")}
          </label>
          <input
            id={`${id}-trace`}
            className="input input--mono"
            value={traceId}
            spellCheck={false}
            aria-invalid={traceId.trim() !== "" && !validTraceId(traceId)}
            aria-describedby={`${id}-trace-hint`}
            onChange={(event) => {
              const next = event.currentTarget.value.trim();
              onPendingText?.(next !== "" && !validTraceId(next));
              onChange({ traceId: next });
            }}
            onKeyDown={onEnter}
          />
          <p
            className={
              traceId.trim() !== "" && !validTraceId(traceId) ? "field__error" : "field__hint"
            }
            id={`${id}-trace-hint`}
          >
            {t("datasources.reason.trace.id_invalid")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
