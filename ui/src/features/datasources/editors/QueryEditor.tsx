import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { schemaQuery } from "../api";
import {
  familyOf,
  type PromQuery,
  parseCypherQuery,
  parsePromQuery,
  parseSqlQuery,
} from "../queryKinds";
import { CodeEditor } from "./CodeEditor";
import {
  CYPHER_MACROS,
  cypherCompletions,
  PROMQL_MACROS,
  promqlCompletions,
  SQL_MACROS,
  sqlCompletions,
} from "./completion";
import { GsqlQueryEditor } from "./GsqlQueryEditor";
import { MongoQueryEditor, type PreviewRun } from "./MongoQueryEditor";
import "./editors.css";
import "../../dashboards/ui/shared.css";

export interface QueryEditorProps {
  orgId: string;
  datasource: { id: string; kind: string };
  query: unknown;
  onChange: (query: unknown) => void;
  onRun?: () => void;
  /** Accessible name of the text field; "Query" by default, "Query A" for a panel target. */
  label?: string;
  /**
   * The time range and variable values the page runs its queries with, read when a stage
   * preview is asked for; without it a preview runs over the last hour.
   */
  previewRun?: (() => PreviewRun) | undefined;
  /**
   * Whether a field holds text that does not parse yet, so it is not in the query: a change from
   * outside (a filter by click) would replace that text, and waits instead.
   */
  onPendingText?: ((pending: boolean) => void) | undefined;
}

/** The editor for a data source's query form, chosen by the data source kind. */
export function QueryEditor(props: QueryEditorProps) {
  const { t } = useI18n();
  switch (familyOf(props.datasource.kind)) {
    case "sql":
      return <SqlQueryEditor {...props} />;
    case "promql":
      return <PromqlQueryEditor {...props} />;
    case "mongo":
      return <MongoQueryEditor {...props} />;
    case "cypher":
      return <CypherQueryEditor {...props} />;
    case "gsql":
      return <GsqlQueryEditor {...props} />;
    default:
      return <p className="field__hint">{t("datasources.editor.unsupported")}</p>;
  }
}

function useSchema(orgId: string, datasourceId: string) {
  const schema = useQuery(schemaQuery(orgId, datasourceId));
  return { schema: schema.data, failed: schema.isError };
}

function MacroHelp({
  macros,
  lead,
}: {
  macros: { name: string; help: MessageKey }[];
  lead: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <details className="query-editor__help">
      <summary>{t("datasources.editor.macros")}</summary>
      <p className="field__hint">{t(lead)}</p>
      <dl className="query-editor__macros">
        {macros.map((macro) => (
          <div key={macro.name}>
            <dt>
              <code>{macro.name}</code>
            </dt>
            <dd>{t(macro.help)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function SqlQueryEditor({ orgId, datasource, query, onChange, onRun, label }: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const { schema, failed } = useSchema(orgId, datasource.id);
  const sqlSchema = schema?.kind === "tables" ? schema : undefined;
  const value = parseSqlQuery(query);

  return (
    <div className="query-editor">
      <CodeEditor
        language="sql"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        value={value.sql}
        onChange={(sql) => onChange({ sql })}
        complete={(text, cursor, explicit) => sqlCompletions(text, cursor, sqlSchema, explicit)}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t("datasources.editor.sqlHint")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <MacroHelp
        macros={SQL_MACROS.map((m) => ({ name: m.detail, help: m.help }))}
        lead="datasources.editor.macrosLead"
      />
    </div>
  );
}

/** Cypher for Neo4j and Memgraph, completed from the labels, edge types and keys of the source. */
function CypherQueryEditor({ orgId, datasource, query, onChange, onRun, label }: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const { schema, failed } = useSchema(orgId, datasource.id);
  const graphSchema = schema?.kind === "graph" ? schema : undefined;
  const value = parseCypherQuery(query);

  return (
    <div className="query-editor">
      <CodeEditor
        language="cypher"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        value={value.cypher}
        onChange={(cypher) => onChange({ cypher })}
        complete={(text, cursor, explicit) =>
          cypherCompletions(text, cursor, graphSchema, explicit)
        }
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t("datasources.editor.cypherHint")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <MacroHelp macros={CYPHER_MACROS} lead="datasources.editor.cypherMacrosLead" />
    </div>
  );
}

/** Seconds as typed; the query stores milliseconds. */
function stepText(minStepMs: number | undefined): string {
  return minStepMs === undefined ? "" : String(minStepMs / 1000);
}

function PromqlQueryEditor({ orgId, datasource, query, onChange, onRun, label }: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const stepId = useId();
  const instantId = useId();
  const { schema, failed } = useSchema(orgId, datasource.id);
  const promSchema = schema?.kind === "metrics" ? schema : undefined;
  const value = parsePromQuery(query);
  const [step, setStep] = useState(stepText(value.minStepMs));
  const stepValid = step.trim() === "" || /^\d+(\.\d+)?$/.test(step.trim());

  function update(patch: Partial<PromQuery>) {
    const next: PromQuery = { ...value, ...patch };
    // Defaults are left out, so a stored query stays as small as the user wrote it.
    if (next.instant !== true) {
      delete next.instant;
    }
    if (next.minStepMs === undefined || next.minStepMs <= 0) {
      delete next.minStepMs;
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
        {t("datasources.editor.shortcuts")} {t("datasources.editor.promHint")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <div className="query-editor__options">
        <div className="field query-editor__step">
          <label className="field__label" htmlFor={stepId}>
            {t("datasources.editor.minStep")}
          </label>
          <input
            id={stepId}
            className="input"
            inputMode="decimal"
            value={step}
            aria-invalid={stepValid ? undefined : true}
            aria-describedby={stepValid ? undefined : `${stepId}-error`}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setStep(text);
              if (text.trim() === "") {
                update({ minStepMs: 0 });
              } else if (/^\d+(\.\d+)?$/.test(text.trim())) {
                update({ minStepMs: Math.round(Number(text) * 1000) });
              }
            }}
          />
          {stepValid ? null : (
            <p className="field__error" id={`${stepId}-error`}>
              {t("datasources.editor.minStepInvalid")}
            </p>
          )}
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
      <MacroHelp macros={PROMQL_MACROS} lead="datasources.editor.promMacrosLead" />
    </div>
  );
}
