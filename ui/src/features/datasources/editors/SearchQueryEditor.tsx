import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useState } from "react";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { datasourceQuery, schemaQuery } from "../api";
import { type Reason, reasonText } from "../reasons";
import { CodeEditor } from "./CodeEditor";
import { JsonField, PendingTextContext } from "./JsonField";
import { MacroHelp } from "./MacroHelp";
import type { QueryEditorProps } from "./QueryEditor";
import { StoredProblems } from "./StoredProblems";
import { dslCompletions, luceneCompletions, SEARCH_MACROS, searchFields } from "./searchCompletion";
import {
  DEFAULT_SIZE,
  DEFAULT_TIME_FIELD,
  dslProblem,
  hasAggregations,
  indexProblem,
  MAX_SIZE,
  parseSearchQuery,
  type SearchMode,
  type SearchQuery,
  searchMode,
  searchQueryProblems,
  sizeState,
} from "./searchQuery";
import "./editors.css";
import "./sourceEditors.css";
import "../../dashboards/ui/shared.css";

/** What the source's settings say about the index and the time field, when the caller may read them. */
interface SourceDefaults {
  index: string;
  timeField: string;
}

/** Ready-made search bodies; each uses the fields of the chosen index where it can. */
export const SEARCH_TEMPLATES = ["latest", "terms", "histogram", "termsOverTime"] as const;
export type SearchTemplate = (typeof SEARCH_TEMPLATES)[number];
/** Templates that group by a keyword field; offered only when the index has one. */
const KEYWORD_TEMPLATES: readonly SearchTemplate[] = ["terms", "termsOverTime"];

const KEYWORD_TYPES = new Set(["keyword", "constant_keyword", "ip", "boolean"]);
const TIME_TYPES = new Set(["date", "date_nanos"]);

/** The first field the terms templates can group by, or undefined. */
export function keywordField(fields: readonly { name: string; type: string }[]) {
  return fields.find((f) => KEYWORD_TYPES.has(f.type))?.name;
}

/**
 * The body of a template, with the time field and a keyword field of the index filled in. The
 * terms templates need a keyword field; without one they are not offered.
 */
export function searchTemplate(
  name: SearchTemplate,
  timeField: string,
  fields: readonly { name: string; type: string }[],
): Record<string, unknown> {
  const time = timeField === "" ? DEFAULT_TIME_FIELD : timeField;
  const keyword = keywordField(fields) ?? "";
  const histogram = { date_histogram: { field: time, fixed_interval: "$__interval" } };
  const terms = { terms: { field: keyword, size: 10 } };
  switch (name) {
    case "latest":
      return {
        query: { match_all: {} },
        sort: [{ [time]: { order: "desc" } }],
        _source: fields
          .filter((f) => !TIME_TYPES.has(f.type))
          .slice(0, 3)
          .map((f) => f.name),
      };
    case "terms":
      return { aggs: { [keyword]: terms } };
    case "histogram":
      return { aggs: { time: histogram } };
    case "termsOverTime":
      return { aggs: { time: { ...histogram, aggs: { [keyword]: terms } } } };
  }
}

/**
 * The body a Lucene text becomes when switching to Query DSL. Query DSL replaces only strings that
 * are exactly one variable or macro, so a text with `$` in it would lose them inside a
 * `query_string`: then the body starts empty and the Lucene text is kept for switching back.
 */
export function dslFromLucene(lucene: string): { dsl: Record<string, unknown>; kept: boolean } {
  const text = lucene.trim();
  if (text.includes("$")) {
    return { dsl: { query: { match_all: {} } }, kept: true };
  }
  return {
    dsl: text === "" ? { query: { match_all: {} } } : { query: { query_string: { query: text } } },
    kept: false,
  };
}

const pretty = (dsl: Record<string, unknown> | undefined) =>
  dsl === undefined ? "" : JSON.stringify(dsl, null, 2);

/**
 * Elasticsearch and OpenSearch: an index (picked from the schema or typed as a pattern), then a
 * Lucene query string or a Query DSL body, the number of hits and the time field. Every field is
 * the query's own (`{index?, lucene | dsl, timeField?, size?}`); the server's checks are mirrored
 * here with its reasons. While a field holds something the server would refuse, the page is told
 * (`onPendingText`) and does not run the query.
 */
export function SearchQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
  onPendingText,
}: QueryEditorProps) {
  const { t } = useI18n();
  const id = useId();
  const value = parseSearchQuery(query);
  const problems = searchQueryProblems(query);
  const mode = searchMode(value);
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  const indices = schema.data?.kind === "indices" ? schema.data.indices : [];
  // A role with only a query grant may still read the settings; without them the defaults stay
  // unknown and the fields say "data source default" instead of a name.
  const detail = useQuery({ ...datasourceQuery(orgId, datasource.id), retry: false });
  const settings = detail.data?.settings;
  const defaults: SourceDefaults | undefined =
    settings === undefined
      ? undefined
      : {
          index: typeof settings.index === "string" ? settings.index : "",
          timeField:
            typeof settings.timeField === "string" ? settings.timeField : DEFAULT_TIME_FIELD,
        };
  const pattern = value.index ?? defaults?.index;
  const fields = searchFields(schema.data?.kind === "indices" ? schema.data : undefined, pattern);

  const [indexText, setIndexText] = useState(value.index ?? "");
  const [sizeText, setSizeText] = useState(value.size === undefined ? "" : String(value.size));
  // The text of the other mode, so switching back brings it again.
  const [aside, setAside] = useState<{ lucene?: string; dsl?: Record<string, unknown> }>({});
  const [replaced, setReplaced] = useState<SearchQuery | null>(null);
  const [luceneKept, setLuceneKept] = useState(false);
  // The JSON field says whether its text parses; it is part of what is pending.
  const [dslPending, setDslPending] = useState(false);
  const reportDsl = useCallback(
    (_field: string, isPending: boolean) => setDslPending(isPending),
    [],
  );

  // The server checks the index as written; only a blank one falls back to the source's.
  const indexError = indexText.trim() === "" ? null : indexProblem(indexText);
  const size = sizeState(sizeText);
  const aggregations = hasAggregations(value.dsl);
  const sizeInBody = value.dsl !== undefined && "size" in value.dsl;
  const effectiveTime =
    value.timeField ?? (defaults === undefined ? undefined : defaults.timeField);
  const indexMissing = defaults !== undefined && defaults.index === "" && value.index === undefined;
  const keyword = keywordField(fields);

  const pending =
    indexError !== null ||
    size === "invalid" ||
    problems.length > 0 ||
    (mode === "dsl" && dslPending);
  useEffect(() => {
    onPendingText?.(pending);
  }, [onPendingText, pending]);

  function update(patch: Partial<SearchQuery>, remove: (keyof SearchQuery)[] = []) {
    const next: SearchQuery = { ...value, ...patch };
    for (const key of remove) {
      delete next[key];
    }
    onChange(next);
  }

  function switchMode(next: SearchMode) {
    if (next === mode) {
      return;
    }
    if (next === "dsl") {
      setAside({ ...aside, lucene: value.lucene ?? "" });
      const converted = dslFromLucene(value.lucene ?? "");
      setLuceneKept(aside.dsl === undefined && converted.kept);
      update({ dsl: aside.dsl ?? converted.dsl }, ["lucene"]);
    } else {
      setAside({ ...aside, ...(value.dsl === undefined ? {} : { dsl: value.dsl }) });
      setLuceneKept(false);
      update({ lucene: aside.lucene ?? "" }, ["dsl"]);
    }
    setReplaced(null);
  }

  const reason = (r: Reason) => reasonText(t, r) ?? r.reason;
  const hintId = `${id}-hint`;
  const indexHelp = `${id}-index-help`;

  return (
    <fieldset className="query-editor source-query">
      <legend className="visually-hidden">{label ?? t("datasources.editor.label")}</legend>
      <StoredProblems problems={problems} onRemove={() => onChange(value)} />
      <div className="source-query__head">
        <div className="field source-query__wide">
          <label className="field__label" htmlFor={`${id}-index`}>
            {t("datasources.editor.search.index")}
          </label>
          <input
            id={`${id}-index`}
            className="input input--mono"
            list={`${id}-indices`}
            value={indexText}
            autoComplete="off"
            spellCheck={false}
            placeholder={
              defaults === undefined || defaults.index === ""
                ? t("datasources.editor.search.indexPlaceholder")
                : defaults.index
            }
            aria-invalid={indexError === null ? undefined : true}
            aria-describedby={indexHelp}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setIndexText(text);
              if (text.trim() === "") {
                update({}, ["index"]);
              } else if (indexProblem(text) === null) {
                update({ index: text });
              }
            }}
          />
          <datalist id={`${id}-indices`}>
            {indices.map((index) => (
              <option key={index.name} value={index.name} />
            ))}
          </datalist>
          {indexError !== null ? (
            <p className="field__error" id={indexHelp}>
              {reason(indexError)}
            </p>
          ) : indexMissing ? (
            <p className="field__error" id={indexHelp}>
              {reason({ reason: "elasticsearch.index_missing" })}
            </p>
          ) : (
            <p className="field__hint" id={indexHelp}>
              {t("datasources.editor.search.indexHint")}
              {schema.isError ? ` ${t("datasources.editor.schemaFailed")}` : ""}
            </p>
          )}
        </div>
        <fieldset className="source-query__choice">
          <legend className="field__label">{t("datasources.editor.search.mode")}</legend>
          {(["lucene", "dsl"] as const).map((name) => (
            <label key={name} className="radio">
              <input
                type="radio"
                name={`${id}-mode`}
                value={name}
                checked={mode === name}
                onChange={() => switchMode(name)}
              />
              <span>{t(`datasources.editor.search.mode.${name}`)}</span>
            </label>
          ))}
        </fieldset>
      </div>
      {mode === "lucene" ? (
        <CodeEditor
          language="lucene"
          label={label ?? t("datasources.editor.label")}
          describedBy={hintId}
          rows={3}
          value={value.lucene ?? ""}
          onChange={(lucene) => update({ lucene })}
          complete={(text, cursor, explicit) => luceneCompletions(text, cursor, fields, explicit)}
          {...(onRun === undefined ? {} : { onRun })}
        />
      ) : (
        <PendingTextContext value={reportDsl}>
          <DslField
            id={id}
            label={label ?? t("datasources.editor.label")}
            dsl={value.dsl}
            fields={fields}
            hasKeyword={keyword !== undefined}
            hintId={hintId}
            onRun={onRun}
            onChange={(dsl) => update({ dsl })}
            onTemplate={(name) => {
              setReplaced(value);
              setLuceneKept(false);
              update({ dsl: searchTemplate(name, effectiveTime || DEFAULT_TIME_FIELD, fields) });
            }}
          />
        </PendingTextContext>
      )}
      {luceneKept ? (
        <p className="source-query__status" role="status">
          {t("datasources.editor.search.luceneKept")}
        </p>
      ) : null}
      {replaced === null ? null : (
        <div className="source-query__status" role="status">
          <span>{t("datasources.editor.search.templateApplied")}</span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => {
              onChange(replaced);
              setReplaced(null);
            }}
          >
            {t("documents.pipeline.undo")}
          </button>
        </div>
      )}
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts")}{" "}
        {t(
          mode === "lucene"
            ? "datasources.editor.search.luceneHint"
            : "datasources.editor.search.dslHint",
        )}{" "}
        {fields.length > 0
          ? t("datasources.editor.search.fieldsHint", {
              pattern: pattern === undefined || pattern === "" ? "*" : pattern,
            })
          : ""}
      </p>
      <div className="query-editor__options">
        <div className="field query-editor__step">
          <label className="field__label" htmlFor={`${id}-size`}>
            {t("datasources.editor.search.size")}
          </label>
          <input
            id={`${id}-size`}
            className="input"
            inputMode="numeric"
            value={sizeText}
            placeholder={String(DEFAULT_SIZE)}
            disabled={aggregations || sizeInBody}
            aria-invalid={size === "invalid" ? true : undefined}
            aria-describedby={`${id}-size-help`}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setSizeText(text);
              if (text.trim() === "") {
                update({}, ["size"]);
              } else if (sizeState(text) !== "invalid") {
                update({ size: Number(text.trim()) });
              }
            }}
          />
          <p className={size === "invalid" ? "field__error" : "field__hint"} id={`${id}-size-help`}>
            {size === "invalid"
              ? t("datasources.editor.search.sizeInvalid")
              : aggregations
                ? t("datasources.editor.search.sizeAggregations")
                : sizeInBody
                  ? t("datasources.editor.search.sizeInBody")
                  : size === "capped"
                    ? t("datasources.editor.search.sizeCapped", { max: MAX_SIZE })
                    : t("datasources.editor.search.sizeHint", { max: MAX_SIZE })}
          </p>
        </div>
        <TimeFieldControl
          id={id}
          value={value}
          defaults={defaults}
          effective={effectiveTime}
          timeFields={fields.filter((f) => TIME_TYPES.has(f.type)).map((f) => f.name)}
          onChange={(timeField) =>
            timeField === undefined ? update({}, ["timeField"]) : update({ timeField })
          }
        />
      </div>
      <p className="source-query__shape">
        {t(
          aggregations
            ? "datasources.editor.search.resultFrame"
            : "datasources.editor.search.resultDocuments",
        )}
      </p>
      <MacroHelp
        macros={SEARCH_MACROS.filter((m) => mode === "dsl" || m.dslOnly !== true).map((m) => ({
          name: m.name,
          help: m.help,
        }))}
        lead={
          mode === "lucene"
            ? "datasources.editor.search.luceneMacrosLead"
            : "datasources.editor.search.dslMacrosLead"
        }
      />
    </fieldset>
  );
}

function DslField({
  id,
  label,
  dsl,
  fields,
  hasKeyword,
  hintId,
  onRun,
  onChange,
  onTemplate,
}: {
  id: string;
  label: string;
  dsl: Record<string, unknown> | undefined;
  fields: readonly { name: string; type: string }[];
  hasKeyword: boolean;
  hintId: string;
  onRun: (() => void) | undefined;
  onChange: (dsl: Record<string, unknown>) => void;
  onTemplate: (name: SearchTemplate) => void;
}) {
  const { t } = useI18n();
  // The text as typed; the query holds the parsed body. A body changed from outside (a template,
  // undo) replaces the text.
  const [text, setText] = useState(() => pretty(dsl));
  const [synced, setSynced] = useState(() => JSON.stringify(dsl ?? {}));
  if (JSON.stringify(dsl ?? {}) !== synced) {
    setSynced(JSON.stringify(dsl ?? {}));
    setText(pretty(dsl));
  }
  const templateKey = (name: SearchTemplate): MessageKey =>
    `datasources.editor.search.template.${name}`;
  return (
    <>
      <div className="field source-query__template">
        <label className="field__label" htmlFor={`${id}-template`}>
          {t("datasources.editor.gsql.template")}
        </label>
        <select
          id={`${id}-template`}
          className="select"
          value=""
          aria-describedby={hasKeyword ? undefined : `${id}-template-help`}
          onChange={(event) => {
            const name = event.currentTarget.value as SearchTemplate;
            if ((SEARCH_TEMPLATES as readonly string[]).includes(name)) {
              onTemplate(name);
            }
          }}
        >
          <option value="">{t("datasources.editor.search.templateChoose")}</option>
          {SEARCH_TEMPLATES.map((name) => (
            <option
              key={name}
              value={name}
              disabled={!hasKeyword && KEYWORD_TEMPLATES.includes(name)}
            >
              {t(templateKey(name))}
            </option>
          ))}
        </select>
        {hasKeyword ? null : (
          <p className="field__hint" id={`${id}-template-help`}>
            {t("datasources.editor.search.noKeyword")}
          </p>
        )}
      </div>
      <JsonField
        label={label}
        value={text}
        optional
        rows={8}
        describedBy={hintId}
        validate={(parsed) => {
          const problem = dslProblem(parsed);
          return problem === null ? null : (reasonText(t, problem) ?? problem.reason);
        }}
        complete={(body, cursor, explicit) => dslCompletions(body, cursor, fields, explicit)}
        onRun={onRun}
        onChange={(next) => {
          setText(next);
          const parsed = next.trim() === "" ? {} : (JSON.parse(next) as Record<string, unknown>);
          setSynced(JSON.stringify(parsed));
          onChange(parsed);
        }}
      />
    </>
  );
}

/**
 * The time filter: on by default with the source's time field. A field typed here overrides it;
 * turned off, the query sends an empty time field, which adds no filter. When the source's
 * settings cannot be read and the query names no field, whether a filter applies is unknown, and
 * the box says so (mixed) instead of guessing.
 */
function TimeFieldControl({
  id,
  value,
  defaults,
  effective,
  timeFields,
  onChange,
}: {
  id: string;
  value: SearchQuery;
  defaults: SourceDefaults | undefined;
  effective: string | undefined;
  timeFields: string[];
  onChange: (timeField: string | undefined) => void;
}) {
  const { t } = useI18n();
  const unknown = effective === undefined;
  const filtered = effective !== undefined && effective !== "";
  const sourceField = defaults?.timeField;
  return (
    <>
      <label className="checkbox" htmlFor={`${id}-time-filter`}>
        <input
          id={`${id}-time-filter`}
          type="checkbox"
          checked={filtered}
          ref={(input) => {
            if (input !== null) {
              input.indeterminate = unknown;
            }
          }}
          aria-describedby={unknown ? `${id}-time-unknown` : undefined}
          onChange={(event) => {
            if (!event.currentTarget.checked) {
              onChange("");
            } else if (sourceField !== undefined && sourceField !== "") {
              onChange(undefined);
            } else {
              onChange(timeFields[0] ?? DEFAULT_TIME_FIELD);
            }
          }}
        />
        {t("datasources.editor.search.timeFilter")}
      </label>
      <div className="field source-query__time">
        <label className="field__label" htmlFor={`${id}-time`}>
          {t("datasources.editor.search.timeField")}
        </label>
        <input
          id={`${id}-time`}
          className="input input--mono"
          list={`${id}-time-fields`}
          disabled={!filtered && !unknown}
          value={value.timeField ?? ""}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            sourceField === undefined
              ? t("datasources.editor.search.timeFieldPlaceholder")
              : sourceField || DEFAULT_TIME_FIELD
          }
          aria-describedby={unknown ? `${id}-time-unknown` : undefined}
          onChange={(event) => {
            const text = event.currentTarget.value.trim();
            onChange(text === "" ? undefined : text);
          }}
        />
        <datalist id={`${id}-time-fields`}>
          {timeFields.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {unknown ? (
          <p className="field__hint" id={`${id}-time-unknown`}>
            {t("datasources.editor.search.timeUnknown")}
          </p>
        ) : null}
      </div>
    </>
  );
}
