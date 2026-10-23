import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { datasourceQuery } from "../api";
import { reasonText } from "../reasons";
import {
  type HttpQuery,
  httpQueryProblems,
  isParamValue,
  type ParamValue,
  paramObject,
  parseHttpQuery,
  pathProblem,
  requestUrl,
  storedParams,
} from "./httpQuery";
import type { QueryEditorProps } from "./QueryEditor";
import { StoredProblems } from "./StoredProblems";
import "./editors.css";
import "./sourceEditors.css";

export type ParamType = "text" | "number" | "bool" | "list";

/** One row of the parameter list as typed; only complete rows reach the query. */
export interface ParamRow {
  key: number;
  name: string;
  type: ParamType;
  value: string;
  /** A stored value the server refuses (such as null), until the row is changed. */
  invalid?: boolean;
}

/** The rows of the stored parameters; a value the server refuses is a row marked invalid. */
export function rowsOf(params: Map<string, unknown>): ParamRow[] {
  return [...params].map(([name, value], key): ParamRow => {
    if (!isParamValue(value)) {
      return { key, name, type: "text", value: "", invalid: true };
    }
    if (Array.isArray(value)) {
      return { key, name, type: "list", value: JSON.stringify(value) };
    }
    const type =
      typeof value === "number" ? "number" : typeof value === "boolean" ? "bool" : "text";
    return { key, name, type, value: String(value) };
  });
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function listOf(text: string): ParamValue | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && isParamValue(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What is wrong with a row, or null; a row without name and value is ignored. */
export function rowProblem(
  row: ParamRow,
  rows: readonly ParamRow[],
): "invalid" | "name" | "duplicate" | "number" | "list" | null {
  if (row.invalid === true) {
    return "invalid";
  }
  if (row.name.trim() === "") {
    return row.value.trim() === "" ? null : "name";
  }
  if (rows.some((other) => other.key !== row.key && other.name.trim() === row.name.trim())) {
    return "duplicate";
  }
  if (row.type === "number" && !NUMBER.test(row.value.trim())) {
    return "number";
  }
  if (row.type === "list" && listOf(row.value) === null) {
    return "list";
  }
  return null;
}

/**
 * The value of a number row. The server sends every parameter as text, so a number JSON would
 * change (beyond 2^53, or with leading zeros such as 007) goes as the text typed.
 */
function numberValue(text: string): ParamValue {
  const trimmed = text.trim();
  const number = Number(trimmed);
  const integer = /^-?\d+$/.test(trimmed);
  if (/^-?0\d/.test(trimmed) || (integer && !Number.isSafeInteger(number))) {
    return trimmed;
  }
  return number;
}

/** The parameters the rows give: complete rows only, typed as the server takes them. */
export function paramsOf(rows: readonly ParamRow[]): Record<string, ParamValue> {
  const entries: [string, ParamValue][] = [];
  for (const row of rows) {
    if (row.name.trim() === "" || rowProblem(row, rows) !== null) {
      continue;
    }
    const value =
      row.type === "number"
        ? numberValue(row.value)
        : row.type === "bool"
          ? row.value === "true"
          : row.type === "list"
            ? (listOf(row.value) as ParamValue)
            : row.value;
    entries.push([row.name.trim(), value]);
  }
  return paramObject(entries);
}

const paramsKey = (query: unknown) => JSON.stringify([...storedParams(query)]);

/**
 * HTTP JSON: a path below the source's URL, query parameters (a value that is exactly `$name`
 * takes the variable's value, a list repeats the parameter) and where the documents are in the
 * answer. The query is `{path?, params?, documentsPath?}`; Kalzit sends only GET and adds no
 * header from the query. A preview shows the address that will be requested. While a field holds
 * something the server would refuse, the page is told (`onPendingText`) and does not run it.
 */
export function HttpJsonQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  label,
  onPendingText,
}: QueryEditorProps) {
  const { t } = useI18n();
  const id = useId();
  const value = parseHttpQuery(query);
  const problems = httpQueryProblems(query).filter((p) => !p.startsWith("params."));
  const detail = useQuery({ ...datasourceQuery(orgId, datasource.id), retry: false });
  const settings = detail.data?.settings;
  const base = typeof settings?.url === "string" ? settings.url : undefined;
  const sourcePath =
    typeof settings?.documentsPath === "string" && settings.documentsPath !== ""
      ? settings.documentsPath
      : undefined;

  const [pathText, setPathText] = useState(value.path ?? "");
  const [documentsText, setDocumentsText] = useState(value.documentsPath ?? "");
  const [rows, setRows] = useState<ParamRow[]>(() => rowsOf(storedParams(query)));
  const [synced, setSynced] = useState(() => paramsKey(query));
  if (paramsKey(query) !== synced) {
    setSynced(paramsKey(query));
    setRows(rowsOf(storedParams(query)));
  }
  const pathInvalid = pathProblem(pathText);
  const rowsInvalid = rows.some((row) => rowProblem(row, rows) !== null);
  const pending = pathInvalid || rowsInvalid || problems.length > 0;
  useEffect(() => {
    onPendingText?.(pending);
  }, [onPendingText, pending]);

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
    setSynced(JSON.stringify(Object.entries(params)));
    update({ ...value, params });
  }

  const nextKey = () => rows.reduce((max, row) => Math.max(max, row.key + 1), 0);
  const url = requestUrl(base, value);

  return (
    <fieldset className="query-editor source-query">
      <legend className="visually-hidden">{label ?? t("datasources.editor.label")}</legend>
      <StoredProblems problems={problems} onRemove={() => update(value)} />
      <p className="source-query__method">{t("datasources.editor.http.methodGet")}</p>
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
          placeholder={t("datasources.editor.http.pathPlaceholder")}
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
                changeRows(
                  rows.map((r) => (r.key === row.key ? { ...r, ...patch, invalid: false } : r)),
                );
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
                    {(["text", "number", "bool", "list"] as const).map((type) => (
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
                      <option value="true">{t("datasources.editor.http.bool.true")}</option>
                      <option value="false">{t("datasources.editor.http.bool.false")}</option>
                    </select>
                  ) : (
                    <input
                      className="input input--mono"
                      aria-label={t("datasources.editor.http.paramValue", { n })}
                      value={row.value}
                      inputMode={row.type === "number" ? "decimal" : undefined}
                      placeholder={
                        row.type === "list"
                          ? t("datasources.editor.http.listPlaceholder")
                          : undefined
                      }
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={
                        problem === "number" || problem === "list" || problem === "invalid"
                          ? true
                          : undefined
                      }
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
                      {problem === "invalid"
                        ? (reasonText(t, {
                            reason: "http_json.param_invalid",
                            params: { name: row.name },
                          }) ?? "")
                        : t(`datasources.editor.http.problem.${problem}`)}
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
          value={documentsText}
          autoComplete="off"
          spellCheck={false}
          placeholder={sourcePath ?? t("datasources.editor.http.documentsPathPlaceholder")}
          aria-describedby={`${id}-documents-help`}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDocumentsText(text);
            update({ ...value, documentsPath: text.trim() });
          }}
          onBlur={() => setDocumentsText(documentsText.trim())}
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
