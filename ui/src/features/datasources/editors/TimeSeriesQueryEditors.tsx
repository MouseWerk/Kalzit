import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { schemaQuery } from "../api";
import {
  INFLUX_LANGUAGES,
  type InfluxLanguage,
  influxQuery,
  type LokiQuery,
  parseInfluxQuery,
  parseLokiQuery,
} from "../queryKinds";
import { CodeEditor } from "./CodeEditor";
import {
  FLUX_MACROS,
  fluxCompletions,
  INFLUXQL_MACROS,
  LOGQL_MACROS,
  logqlCompletions,
  SQL_MACROS,
  sqlCompletions,
} from "./completion";
import { MacroHelp } from "./MacroHelp";
import type { QueryEditorProps } from "./QueryEditor";
import "./editors.css";
import "../../dashboards/ui/shared.css";

/**
 * InfluxDB: one language per query. Flux answers on 1.8 and 2.x, InfluxQL everywhere, SQL on 3.x;
 * the server says so when the source's version does not take the chosen one.
 */
export function InfluxQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const languageId = useId();
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  const tables = schema.data?.kind === "tables" ? schema.data : undefined;
  const { language, text } = parseInfluxQuery(query);
  const flux = language === "flux";

  return (
    <div className="query-editor">
      <div className="query-editor__options">
        <div className="field">
          <label className="field__label" htmlFor={languageId}>
            {t("datasources.editor.influx.language")}
          </label>
          <select
            id={languageId}
            className="input"
            value={language}
            onChange={(event) =>
              onChange(influxQuery(event.currentTarget.value as InfluxLanguage, text))
            }
          >
            {INFLUX_LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {t(`datasources.editor.influx.${l}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <CodeEditor
        // A new editor per language, so highlighting and completion follow the choice.
        key={language}
        language={flux ? "flux" : "sql"}
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        rows={flux ? 6 : 4}
        value={text}
        onChange={(next) => onChange(influxQuery(language, next))}
        complete={(value, cursor, explicit) =>
          flux
            ? fluxCompletions(value, cursor, tables, explicit)
            : sqlCompletions(value, cursor, tables, explicit)
        }
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t(`datasources.editor.influx.${language}Hint`)}
        {schema.isError ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      {language === "flux" ? (
        <MacroHelp macros={FLUX_MACROS} lead="datasources.editor.promMacrosLead" />
      ) : language === "influxql" ? (
        <MacroHelp macros={INFLUXQL_MACROS} lead="datasources.editor.promMacrosLead" />
      ) : (
        <MacroHelp
          macros={SQL_MACROS.map((m) => ({ name: m.detail, help: m.help }))}
          lead="datasources.editor.macrosLead"
        />
      )}
    </div>
  );
}

/** Seconds as typed; the query stores milliseconds. */
function stepText(minStepMs: number | undefined): string {
  return minStepMs === undefined ? "" : String(minStepMs / 1000);
}

/**
 * Loki: LogQL, completed from the source's labels and their values. Log queries answer one
 * document per line; metric queries a time series.
 */
export function LokiQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const limitId = useId();
  const directionId = useId();
  const stepId = useId();
  const instantId = useId();
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  const labels = schema.data?.kind === "labels" ? schema.data : undefined;
  const value = parseLokiQuery(query);
  const [limit, setLimit] = useState(value.limit === undefined ? "" : String(value.limit));
  const [step, setStep] = useState(stepText(value.minStepMs));
  const limitValid = limit.trim() === "" || /^[1-9]\d*$/.test(limit.trim());
  const stepValid = step.trim() === "" || /^\d+(\.\d+)?$/.test(step.trim());

  function update(patch: Partial<LokiQuery>) {
    const next: LokiQuery = { ...value, ...patch };
    // Defaults are left out, so a stored query stays as small as the user wrote it.
    if (next.limit === undefined || next.limit <= 0) {
      delete next.limit;
    }
    if (next.direction !== "forward") {
      delete next.direction;
    }
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
        language="logql"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        rows={3}
        value={value.logql}
        onChange={(logql) => update({ logql })}
        complete={(text, cursor, explicit) => logqlCompletions(text, cursor, labels, explicit)}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")} {t("datasources.editor.loki.hint")}
        {schema.isError ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <div className="query-editor__options">
        <div className="field query-editor__step">
          <label className="field__label" htmlFor={limitId}>
            {t("datasources.editor.loki.limit")}
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
              if (text.trim() === "") {
                update({ limit: 0 });
              } else if (/^[1-9]\d*$/.test(text.trim())) {
                update({ limit: Number(text.trim()) });
              }
            }}
          />
          {limitValid ? null : (
            <p className="field__error" id={`${limitId}-error`}>
              {t("datasources.editor.loki.limitInvalid")}
            </p>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={directionId}>
            {t("datasources.editor.loki.direction")}
          </label>
          <select
            id={directionId}
            className="input"
            value={value.direction ?? "backward"}
            onChange={(event) =>
              update({ direction: event.currentTarget.value as "backward" | "forward" })
            }
          >
            <option value="backward">{t("datasources.editor.loki.backward")}</option>
            <option value="forward">{t("datasources.editor.loki.forward")}</option>
          </select>
        </div>
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
          {t("datasources.editor.loki.instant")}
        </label>
      </div>
      <MacroHelp macros={LOGQL_MACROS} lead="datasources.editor.promMacrosLead" />
    </div>
  );
}
