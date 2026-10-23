import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { datasourceQuery } from "../api";
import { reasonText } from "../reasons";
import {
  type HttpQuery,
  type ParamValue,
  parseHttpQuery,
  pathProblem,
  requestUrl,
} from "./httpQuery";
import type { QueryEditorProps } from "./QueryEditor";
import "./editors.css";
import "./sourceEditors.css";

export type ParamType = "text" | "number" | "bool";

/** One row of the parameter list as typed; only complete rows reach the query. */
export interface ParamRow {
  key: number;
  name: string;
  type: ParamType;
  value: string;
}

export function rowsOf(params: Record<string, ParamValue> | undefined): ParamRow[] {
  return Object.entries(params ?? {}).map(([name, value], key) => ({
    key,
    name,
    type: typeof value === "number" ? "number" : typeof value === "boolean" ? "bool" : "text",
    value: String(value),
  }));
}

/** What is wrong with a row, or null: a name, a unique name, a number where one is asked for. */
export function rowProblem(
  row: ParamRow,
  rows: readonly ParamRow[],
): "name" | "duplicate" | "number" | null {
  if (row.name.trim() === "") {
    return row.value.trim() === "" ? null : "name";
  }
  if (rows.some((other) => other.key !== row.key && other.name.trim() === row.name.trim())) {
    return "duplicate";
  }
  if (row.type === "number" && (row.value.trim() === "" || !Number.isFinite(Number(row.value)))) {
    return "number";
  }
  return null;
}

/** The parameters the rows give: complete rows only, as texts, numbers and booleans. */
export function paramsOf(rows: readonly ParamRow[]): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {};
  for (const row of rows) {
    if (row.name.trim() === "" || rowProblem(row, rows) !== null) {
      continue;
    }
    params[row.name.trim()] =
      row.type === "number"
        ? Number(row.value)
        : row.type === "bool"
          ? row.value === "true"
          : row.value;
  }
  return params;
}

/**
 * HTTP JSON: a path below the source's URL, query parameters (a value that is exactly `$name`
 * takes the variable's value) and where the documents are in the answer. The query is
 * `{path?, params?, documentsPath?}`; Kalzit sends only GET and adds no header from the query,
 * so there is nothing to choose for either. A preview shows the address that will be requested.
 */
export function HttpJsonQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const id = useId();
  const value = parseHttpQuery(query);
  const detail = useQuery({ ...datasourceQuery(orgId, datasource.id), retry: false });
  const settings = detail.data?.settings;
  const base = typeof settings?.url === "string" ? settings.url : undefined;
  const sourcePath =
    typeof settings?.documentsPath === "string" && settings.documentsPath !== ""
      ? settings.documentsPath
      : undefined;

  const [pathText, setPathText] = useState(value.path ?? "");
  const [rows, setRows] = useState<ParamRow[]>(() => rowsOf(value.params));
  const [synced, setSynced] = useState(() => JSON.stringify(value.params ?? {}));
  if (JSON.stringify(value.params ?? {}) !== synced) {
    setSynced(JSON.stringify(value.params ?? {}));
    setRows(rowsOf(value.params));
  }
  const pathInvalid = pathProblem(pathText);

  function update(next: HttpQuery) {
    const clean: HttpQuery = {};
    if (next.path !== undefined && next.path !== "") clean.path = next.path;
    if (next.params !== undefined && Object.keys(next.params).length > 0)
      clean.params = next.params;
    if (next.documentsPath !== undefined && next.documentsPath !== "") {
      clean.documentsPath = next.documentsPath;
    }
    onChange(clean);
  }

  function changeRows(next: ParamRow[]) {
    setRows(next);
    const params = paramsOf(next);
    setSynced(JSON.stringify(params));
    update({ ...value, params });
  }

  const nextKey = () => rows.reduce((max, row) => Math.max(max, row.key + 1), 0);
  const url = requestUrl(base, value);

  return (
    <fieldset className="query-editor source-query">
      <legend className="visually-hidden">{label ?? t("datasources.editor.label")}</legend>
      <div className="source-query__head">
        <div className="field source-query__method">
          <label className="field__label" htmlFor={`${id}-method`}>
            {t("datasources.editor.http.method")}
          </label>
          <select id={`${id}-method`} className="select" value="GET" disabled>
            <option value="GET">GET</option>
          </select>
        </div>
        <div className="field source-query__wide">
          <label className="field__label" htmlFor={`${id}-path`}>
            {t("datasources.editor.http.path")}
          </label>
          <input
            id={`${id}-path`}
            className="input input--mono"
            value={pathText}
            autoComplete="off"
            spellCheck={false}
            placeholder="orders/open"
            aria-invalid={pathInvalid ? true : undefined}
            aria-describedby={`${id}-path-help`}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setPathText(text);
              if (!pathProblem(text)) {
                update({ ...value, path: text });
              }
            }}
          />
          <p className={pathInvalid ? "field__error" : "field__hint"} id={`${id}-path-help`}>
            {pathInvalid
              ? (reasonText(t, { reason: "http_json.path_invalid" }) ?? "")
              : t("datasources.editor.http.pathHint")}
          </p>
        </div>
      </div>
      <fieldset className="source-query__params">
        <legend className="field__label">{t("datasources.editor.http.params")}</legend>
        {rows.length === 0 ? (
          <p className="field__hint">{t("datasources.editor.http.noParams")}</p>
        ) : (
          <ul className="source-query__param-list">
            {rows.map((row, index) => {
              const problem = rowProblem(row, rows);
              const errorId = `${id}-param-${row.key}-error`;
              const set = (patch: Partial<ParamRow>) =>
                changeRows(rows.map((r) => (r.key === row.key ? { ...r, ...patch } : r)));
              const n = index + 1;
              return (
                <li key={row.key} className="source-query__param">
                  <input
                    className="input input--mono"
                    aria-label={t("datasources.editor.http.paramName", { n })}
                    value={row.name}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={problem === "name" || problem === "duplicate" ? true : undefined}
                    aria-describedby={problem === null ? undefined : errorId}
                    onChange={(event) => set({ name: event.currentTarget.value })}
                  />
                  <select
                    className="select"
                    aria-label={t("datasources.editor.http.paramType", { n })}
                    value={row.type}
                    onChange={(event) => {
                      const type = event.currentTarget.value as ParamType;
                      set({ type, value: type === "bool" ? "true" : row.value });
                    }}
                  >
                    {(["text", "number", "bool"] as const).map((type) => (
                      <option key={type} value={type}>
                        {t(`datasources.editor.http.type.${type}`)}
                      </option>
                    ))}
                  </select>
                  {row.type === "bool" ? (
                    <select
                      className="select"
                      aria-label={t("datasources.editor.http.paramValue", { n })}
                      value={row.value}
                      onChange={(event) => set({ value: event.currentTarget.value })}
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className="input input--mono"
                      aria-label={t("datasources.editor.http.paramValue", { n })}
                      value={row.value}
                      inputMode={row.type === "number" ? "decimal" : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={problem === "number" ? true : undefined}
                      aria-describedby={problem === null ? undefined : errorId}
                      onChange={(event) => set({ value: event.currentTarget.value })}
                    />
                  )}
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("datasources.editor.http.removeParam", { n })}
                    onClick={() => changeRows(rows.filter((r) => r.key !== row.key))}
                  >
                    {t("datasources.editor.http.remove")}
                  </button>
                  {problem === null ? null : (
                    <p className="field__error source-query__param-error" id={errorId}>
                      {t(`datasources.editor.http.problem.${problem}`)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() =>
              changeRows([...rows, { key: nextKey(), name: "", type: "text", value: "" }])
            }
          >
            {t("datasources.editor.http.addParam")}
          </button>
        </div>
        <p className="field__hint">{t("datasources.editor.http.paramsHint")}</p>
      </fieldset>
      <div className="field source-query__wide">
        <label className="field__label" htmlFor={`${id}-documents`}>
          {t("datasources.editor.http.documentsPath")}
        </label>
        <input
          id={`${id}-documents`}
          className="input input--mono"
          value={value.documentsPath ?? ""}
          autoComplete="off"
          spellCheck={false}
          placeholder={sourcePath ?? t("datasources.editor.http.documentsPathPlaceholder")}
          aria-describedby={`${id}-documents-help`}
          onChange={(event) =>
            update({ ...value, documentsPath: event.currentTarget.value.trim() })
          }
        />
        <p className="field__hint" id={`${id}-documents-help`}>
          {t("datasources.editor.http.documentsPathHint")}
        </p>
      </div>
      {url === undefined ? null : (
        <p className="source-query__url">
          <span className="field__label">{t("datasources.editor.http.request")}</span>{" "}
          <code className="source-query__mono">GET {url}</code>
        </p>
      )}
      <p className="field__hint">{t("datasources.editor.http.readOnly")}</p>
    </fieldset>
  );
}
