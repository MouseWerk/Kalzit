import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { isRecord } from "../../../api/client";
import { useI18n } from "../../../i18n/i18n";
import { datasourceQuery, schemaQuery } from "../api";
import { parseGsqlQuery } from "../queryKinds";
import { CodeEditor } from "./CodeEditor";
import type { QueryEditorProps } from "./QueryEditor";
import "./editors.css";
import "../../dashboards/ui/shared.css";

/**
 * Where the graph's name goes when the source's settings cannot be read (members who may only
 * query). The server refuses any other graph than the source's, so the gap is left visible for
 * the user to fill, not filled with a guess.
 */
export const GRAPH_GAP = "<graph>";

/** The graph the template names: the source's own, or a visible gap when it is not known. */
export function templateGraph(setting: unknown): { graph: string; known: boolean } {
  return typeof setting === "string" && setting !== ""
    ? { graph: setting, known: true }
    : { graph: GRAPH_GAP, known: false };
}

/** A starting point for an interpreted query: the one body TigerGraph allows, for the graph. */
export function gsqlTemplate(graph: string): string {
  return `INTERPRET QUERY () FOR GRAPH ${graph} {\n  Start = {ANY};\n  PRINT Start;\n}`;
}

/** The params field as typed: a JSON object, or the reason it is not one. */
export function parseParams(text: string): { params?: Record<string, unknown>; error?: true } {
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { params: value } : { error: true };
  } catch {
    return { error: true };
  }
}

/**
 * TigerGraph (docs/api/datasources.md, "TigerGraph"): an interpreted GSQL query, written as one
 * `INTERPRET QUERY (...) FOR GRAPH <graph> { ... }`, or an installed query picked from the
 * source's schema, each with parameters as a JSON object.
 */
export function GsqlQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const modeName = useId();
  const pickId = useId();
  const paramsId = useId();
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  // The graph name for the template; members who may only query cannot read the settings.
  const settings = useQuery({ ...datasourceQuery(orgId, datasource.id), retry: false });
  const value = parseGsqlQuery(query);
  const installed = "installed" in value;
  const [paramsText, setParamsText] = useState(
    value.params === undefined ? "" : JSON.stringify(value.params, null, 2),
  );
  const parsed = parseParams(paramsText);
  const queries = schema.data?.kind === "graph" ? schema.data.queries : [];
  const graphSetting = settings.data?.settings.graph;
  const { graph, known } = templateGraph(graphSetting);
  const withParams = (next: { gsql: string } | { installed: string }) =>
    onChange(parsed.params === undefined ? next : { ...next, params: parsed.params });

  return (
    <div className="query-editor">
      <fieldset className="query-editor__options">
        <legend className="field__label">{t("datasources.editor.gsql.mode")}</legend>
        <label className="radio">
          <input
            type="radio"
            name={modeName}
            checked={!installed}
            onChange={() => withParams({ gsql: "" })}
          />
          {t("datasources.editor.gsql.interpreted")}
        </label>
        <label className="radio">
          <input
            type="radio"
            name={modeName}
            checked={installed}
            onChange={() => withParams({ installed: queries[0] ?? "" })}
          />
          {t("datasources.editor.gsql.installed")}
        </label>
      </fieldset>
      {installed ? (
        <div className="field">
          <label className="field__label" htmlFor={pickId}>
            {t("datasources.editor.gsql.query")}
          </label>
          {queries.length === 0 ? (
            <p className="field__hint">{t("datasources.editor.gsql.noQueries")}</p>
          ) : (
            <select
              id={pickId}
              className="select"
              value={value.installed}
              onChange={(event) => withParams({ installed: event.currentTarget.value })}
            >
              {queries.includes(value.installed) ? null : (
                <option value={value.installed}>{value.installed}</option>
              )}
              {queries.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <>
          <CodeEditor
            language="gsql"
            label={label ?? t("datasources.editor.label")}
            describedBy={hintId}
            value={value.gsql}
            onChange={(gsql) => withParams({ gsql })}
            {...(onRun === undefined ? {} : { onRun })}
          />
          <p className="field__hint" id={hintId}>
            {t("datasources.editor.shortcuts")} {t("datasources.editor.gsql.hint", { graph })}
            {known ? "" : ` ${t("datasources.editor.gsql.graphUnknown", { gap: GRAPH_GAP })}`}
          </p>
          {value.gsql.trim() === "" ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => withParams({ gsql: gsqlTemplate(graph) })}
            >
              {t("datasources.editor.gsql.template")}
            </button>
          ) : null}
        </>
      )}
      <div className="field">
        <label className="field__label" htmlFor={paramsId}>
          {t("datasources.editor.gsql.params")}
        </label>
        <p className="field__hint" id={`${paramsId}-hint`}>
          {t("datasources.editor.gsql.paramsHint")}
        </p>
        <textarea
          id={paramsId}
          className="input input--mono"
          rows={3}
          value={paramsText}
          aria-invalid={parsed.error === true ? true : undefined}
          aria-describedby={
            parsed.error === true ? `${paramsId}-hint ${paramsId}-error` : `${paramsId}-hint`
          }
          onChange={(event) => {
            const text = event.currentTarget.value;
            setParamsText(text);
            const next = parseParams(text);
            if (next.error !== true) {
              const base = installed ? { installed: value.installed } : { gsql: value.gsql };
              onChange(next.params === undefined ? base : { ...base, params: next.params });
            }
          }}
        />
        {parsed.error === true ? (
          <p className="field__error" id={`${paramsId}-error`}>
            {t("datasources.editor.gsql.paramsInvalid")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
