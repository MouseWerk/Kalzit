import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { useI18n } from "../../../i18n/i18n";
import { type PromSchema, type SqlSchema, schemaQuery } from "../api";
import {
  familyOf,
  type PromQuery,
  parsePromQuery,
  parseSqlQuery,
  SQL_FORMATS,
  type SqlQuery,
} from "../queryKinds";
import { CodeEditor } from "./CodeEditor";
import { promqlCompletions, SQL_MACROS, sqlCompletions } from "./completion";

export interface QueryEditorProps {
  orgId: string;
  datasource: { id: string; kind: string };
  query: unknown;
  onChange: (query: unknown) => void;
  onRun?: () => void;
  /** Accessible name of the text field; "Query" by default, "Query A" for a panel target. */
  label?: string;
}

/** The editor for a data source's query form, chosen by the data source kind. */
export function QueryEditor(props: QueryEditorProps) {
  const { t } = useI18n();
  switch (familyOf(props.datasource.kind)) {
    case "sql":
      return <SqlQueryEditor {...props} />;
    case "promql":
      return <PromqlQueryEditor {...props} />;
    default:
      return <p className="field__hint">{t("datasources.editor.unsupported")}</p>;
  }
}

function useSchema(orgId: string, datasourceId: string) {
  const schema = useQuery(schemaQuery(orgId, datasourceId));
  return { schema: schema.data, failed: schema.isError };
}

function SqlQueryEditor({ orgId, datasource, query, onChange, onRun, label }: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const formatId = useId();
  const { schema, failed } = useSchema(orgId, datasource.id);
  const sqlSchema = schema !== undefined && "tables" in schema ? (schema as SqlSchema) : undefined;
  const value = parseSqlQuery(query);
  const update = (patch: Partial<SqlQuery>) => onChange({ ...value, ...patch });

  return (
    <div className="query-editor">
      <CodeEditor
        language="sql"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        value={value.sql}
        onChange={(sql) => update({ sql })}
        complete={(text, cursor, explicit) => sqlCompletions(text, cursor, sqlSchema, explicit)}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <div className="query-editor__options">
        <div className="preference">
          <label htmlFor={formatId}>{t("datasources.editor.format")}</label>
          <select
            id={formatId}
            className="select"
            value={value.format}
            onChange={(event) =>
              update({ format: event.currentTarget.value as SqlQuery["format"] })
            }
          >
            {SQL_FORMATS.map((format) => (
              <option key={format} value={format}>
                {t(`datasources.editor.format.${format}`)}
              </option>
            ))}
          </select>
        </div>
        <details className="query-editor__help">
          <summary>{t("datasources.editor.macros")}</summary>
          <p className="field__hint">{t("datasources.editor.macrosLead")}</p>
          <dl className="query-editor__macros">
            {SQL_MACROS.map((macro) => (
              <div key={macro.name}>
                <dt>
                  <code>{macro.detail}</code>
                </dt>
                <dd>{t(macro.help)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </div>
  );
}

function PromqlQueryEditor({ orgId, datasource, query, onChange, onRun, label }: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const legendId = useId();
  const instantId = useId();
  const { schema, failed } = useSchema(orgId, datasource.id);
  const promSchema =
    schema !== undefined && "metrics" in schema ? (schema as PromSchema) : undefined;
  const value = parsePromQuery(query);

  function update(patch: Partial<PromQuery>) {
    const next: PromQuery = { ...value, ...patch };
    // Defaults are left out, so a stored query stays as small as the user wrote it.
    if (next.instant !== true) {
      delete next.instant;
    }
    if (next.legend === "") {
      delete next.legend;
    }
    onChange(next);
  }

  return (
    <div className="query-editor">
      <CodeEditor
        language="promql"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        rows={3}
        value={value.expr}
        onChange={(expr) => update({ expr })}
        complete={(text, cursor, explicit) => promqlCompletions(text, cursor, promSchema, explicit)}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <div className="query-editor__options">
        <div className="field query-editor__legend">
          <label className="field__label" htmlFor={legendId}>
            {t("datasources.editor.legend")}
          </label>
          <input
            id={legendId}
            className="input input--mono"
            value={value.legend ?? ""}
            placeholder={t("datasources.editor.legendPlaceholder")}
            onChange={(event) => update({ legend: event.currentTarget.value })}
          />
        </div>
        <label className="checkbox" htmlFor={instantId}>
          <input
            id={instantId}
            type="checkbox"
            checked={value.instant === true}
            onChange={(event) => update({ instant: event.currentTarget.checked })}
          />
          {t("datasources.editor.instant")}
        </label>
      </div>
    </div>
  );
}
