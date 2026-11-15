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
  parseTextQuery,
  type TextLanguage,
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
import { FileQueryEditor } from "./FileQueryEditor";
import { GsqlQueryEditor } from "./GsqlQueryEditor";
import { HttpJsonQueryEditor } from "./HttpJsonQueryEditor";
import { JsonField } from "./JsonField";
import { MacroHelp } from "./MacroHelp";
import { MongoQueryEditor, type PreviewRun } from "./MongoQueryEditor";
import { SearchQueryEditor } from "./SearchQueryEditor";
import { InfluxQueryEditor, LokiQueryEditor } from "./TimeSeriesQueryEditors";
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
    case "influx":
      return <InfluxQueryEditor {...props} />;
    case "logql":
      return <LokiQueryEditor {...props} />;
    case "mongo":
      return <MongoQueryEditor {...props} />;
    case "cypher":
      return <CypherQueryEditor {...props} />;
    case "gsql":
      return <GsqlQueryEditor {...props} />;
    case "aql":
      return <TextLanguageQueryEditor {...props} language="aql" />;
    case "gremlin":
      return <TextLanguageQueryEditor {...props} language="gremlin" />;
    case "sqlpp":
      return <TextLanguageQueryEditor {...props} language="sqlpp" />;
    case "search":
      return <SearchQueryEditor {...props} />;
    case "file":
      return <FileQueryEditor {...props} />;
    case "http":
      return <HttpJsonQueryEditor {...props} />;
    case "trace":
      return <JsonQueryEditor {...props} hint="datasources.editor.trace.hint" />;
    case "plugin":
      return <JsonQueryEditor {...props} hint="datasources.editor.plugin.hint" />;
    default:
      return <p className="field__hint">{t("datasources.editor.unsupported")}</p>;
  }
}

/**
 * A query edited as one JSON object, sent as written: a plugin kind's (the plugin defines its
 * form) and, until their own editor is drawn, a trace source's. The source checks it and answers
 * `query.invalid_form` for one it does not take.
 */
function JsonQueryEditor({
  query,
  onChange,
  onRun,
  label,
  hint,
}: QueryEditorProps & {
  hint: "datasources.editor.plugin.hint" | "datasources.editor.trace.hint";
}) {
  const { t } = useI18n();
  const hintId = useId();
  const object = query !== null && typeof query === "object" ? query : {};
  // The text as typed while it still says the same as the query, so the field does not reformat
  // what is being written; a query changed from outside is shown formatted.
  const [typed, setTyped] = useState<string | null>(null);
  const value = typed !== null && sameJson(typed, object) ? typed : JSON.stringify(object, null, 2);
  return (
    <div className="query-editor">
      <JsonField
        label={label ?? t("datasources.editor.label")}
        value={value}
        rows={6}
        describedBy={hintId}
        validate={(parsed) =>
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? null
            : t("datasources.editor.plugin.object")
        }
        onChange={(text) => {
          setTyped(text);
          onChange(text === "" ? {} : (JSON.parse(text) as unknown));
        }}
        onRun={onRun}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t(hint)}
      </p>
    </div>
  );
}

function sameJson(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function useSchema(orgId: string, datasourceId: string) {
  const schema = useQuery(schemaQuery(orgId, datasourceId));
  return { schema: schema.data, failed: schema.isError };
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

/** The hint under each text language's editor: how values and macros are written. */
const TEXT_LANGUAGE_HINTS = {
  aql: "datasources.editor.aqlHint",
  gremlin: "datasources.editor.gremlinHint",
  sqlpp: "datasources.editor.sqlppHint",
} as const satisfies Record<TextLanguage, MessageKey>;

/**
 * AQL (ArangoDB), Gremlin and SQL++ (Couchbase): one text in the source's language. The server
 * checks it, binds variables and macros as parameters, and refuses anything that writes.
 */
function TextLanguageQueryEditor({
  query,
  onChange,
  onRun,
  label,
  language,
}: QueryEditorProps & { language: TextLanguage }) {
  const { t } = useI18n();
  const hintId = useId();
  return (
    <div className="query-editor">
      <CodeEditor
        language={language}
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        value={parseTextQuery(language, query)}
        onChange={(text) => onChange({ [language]: text })}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t(TEXT_LANGUAGE_HINTS[language])}
      </p>
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
