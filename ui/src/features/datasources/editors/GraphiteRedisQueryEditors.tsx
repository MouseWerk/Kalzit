import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { type KeysSchema, type PromSchema, schemaQuery } from "../api";
import { parseGraphiteQuery, parseRedisQuery } from "../queryKinds";
import { CodeEditor } from "./CodeEditor";
import { type Completion, type CompletionResult, matching } from "./completion";
import { MacroHelp } from "./MacroHelp";
import type { QueryEditorProps } from "./QueryEditor";
import "./editors.css";
import "../../dashboards/ui/shared.css";
import { editorHintKeys } from "./editorKeys";

/** Graphite's functions most targets use; the server passes any function through. */
export const GRAPHITE_FUNCTIONS = [
  "alias",
  "aliasByNode",
  "aliasByTags",
  "averageSeries",
  "derivative",
  "groupByNode",
  "groupByTags",
  "highestAverage",
  "highestCurrent",
  "integral",
  "keepLastValue",
  "maxSeries",
  "minSeries",
  "movingAverage",
  "nonNegativeDerivative",
  "perSecond",
  "scale",
  "seriesByTag",
  "sortByMaxima",
  "summarize",
  "sumSeries",
  "timeShift",
  "transformNull",
];

export const GRAPHITE_MACROS: { name: string; help: MessageKey }[] = [
  { name: "$__interval", help: "datasources.editor.macro.interval" },
  { name: "$__interval_ms", help: "datasources.editor.macro.intervalMs" },
  { name: "$__range", help: "datasources.editor.macro.range" },
  { name: "$__timeFrom", help: "datasources.editor.macro.timeFromSeconds" },
  { name: "$__timeTo", help: "datasources.editor.macro.timeToSeconds" },
];

export const REDIS_MACROS: { name: string; help: MessageKey }[] = [
  { name: "$__timeFrom", help: "datasources.editor.macro.timeFromMs" },
  { name: "$__timeTo", help: "datasources.editor.macro.timeToMs" },
  { name: "$__interval", help: "datasources.editor.macro.intervalMs" },
  { name: "$__interval_ms", help: "datasources.editor.macro.intervalMs" },
];

/** The commands the server runs (`redis::command::ALLOWED`), for completion. */
export const REDIS_COMMANDS = [
  "GET",
  "MGET",
  "STRLEN",
  "GETRANGE",
  "EXISTS",
  "TYPE",
  "TTL",
  "PTTL",
  "DBSIZE",
  "SCAN",
  "INFO",
  "HGET",
  "HMGET",
  "HGETALL",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HSCAN",
  "LRANGE",
  "LLEN",
  "LINDEX",
  "SMEMBERS",
  "SCARD",
  "SISMEMBER",
  "SSCAN",
  "ZRANGE",
  "ZRANGEBYSCORE",
  "ZREVRANGE",
  "ZCARD",
  "ZCOUNT",
  "ZSCORE",
  "ZRANK",
  "ZSCAN",
  "PFCOUNT",
  "GEOPOS",
  "GEODIST",
  "GEOSEARCH",
  "XRANGE",
  "XREVRANGE",
  "XLEN",
  "XINFO",
  "JSON.GET",
  "JSON.MGET",
  "JSON.TYPE",
  "FT.SEARCH",
  "FT.AGGREGATE",
  "FT.INFO",
  "FT._LIST",
  "TS.RANGE",
  "TS.REVRANGE",
  "TS.MRANGE",
  "TS.MREVRANGE",
  "TS.GET",
  "TS.MGET",
  "TS.INFO",
];

/** Graphite: metric paths from the schema, functions and macros. */
export function graphiteCompletions(
  text: string,
  cursor: number,
  schema: PromSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const word = /[\w.:$*-]*$/.exec(before)?.[0] ?? "";
  if (word === "" && !explicit) {
    return null;
  }
  const options: Completion[] = word.startsWith("$")
    ? GRAPHITE_MACROS.map((m) => ({ label: m.name, kind: "macro" as const }))
    : [
        ...(schema?.metrics ?? []).map((name) => ({ label: name, kind: "metric" as const })),
        ...GRAPHITE_FUNCTIONS.map((name) => ({ label: name, kind: "function" as const })),
      ];
  const found = matching(options, word);
  return found.length === 0 ? null : { from: cursor - word.length, to: cursor, options: found };
}

/** Redis: the command first, then key names (with their type) and macros. */
export function redisCompletions(
  text: string,
  cursor: number,
  schema: KeysSchema | undefined,
  explicit = false,
): CompletionResult | null {
  const before = text.slice(0, cursor);
  const word = /[^\s"']*$/.exec(before)?.[0] ?? "";
  if (word === "" && !explicit) {
    return null;
  }
  const first = before.trim() === word;
  let options: Completion[];
  if (first) {
    options = REDIS_COMMANDS.map((name) => ({ label: name, kind: "keyword" as const }));
  } else if (word.startsWith("$")) {
    options = REDIS_MACROS.map((m) => ({ label: m.name, kind: "macro" as const }));
  } else {
    options = (schema?.keys ?? []).map((key) => ({
      label: key.name,
      kind: "label" as const,
      detail: key.type,
    }));
  }
  const found = matching(options, word);
  return found.length === 0 ? null : { from: cursor - word.length, to: cursor, options: found };
}

function useSourceSchema(orgId: string, datasourceId: string) {
  const schema = useQuery(schemaQuery(orgId, datasourceId));
  return { schema: schema.data, failed: schema.isError };
}

/** Graphite: one render target, completed from the metric names of the source. */
export function GraphiteQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const { schema, failed } = useSourceSchema(orgId, datasource.id);
  const metrics = schema?.kind === "metrics" ? schema : undefined;
  const value = parseGraphiteQuery(query);
  return (
    <div className="query-editor">
      <CodeEditor
        language="promql"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        rows={3}
        value={value.target}
        onChange={(target) => onChange({ target })}
        complete={(text, cursor, explicit) => graphiteCompletions(text, cursor, metrics, explicit)}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts", editorHintKeys())} {t("datasources.editor.graphiteHint")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <MacroHelp macros={GRAPHITE_MACROS} lead="datasources.editor.promMacrosLead" />
    </div>
  );
}

/** Redis: one command that reads, completed from the commands and the keys of the source. */
export function RedisQueryEditor({
  orgId,
  datasource,
  query,
  onChange,
  onRun,
  label,
}: QueryEditorProps) {
  const { t } = useI18n();
  const hintId = useId();
  const { schema, failed } = useSourceSchema(orgId, datasource.id);
  const keys = schema?.kind === "keys" ? schema : undefined;
  const value = parseRedisQuery(query);
  return (
    <div className="query-editor">
      <CodeEditor
        language="lucene"
        label={label ?? t("datasources.editor.label")}
        describedBy={hintId}
        rows={2}
        value={value.command}
        onChange={(command) => onChange({ command })}
        complete={(text, cursor, explicit) => redisCompletions(text, cursor, keys, explicit)}
        {...(onRun === undefined ? {} : { onRun })}
      />
      <p className="field__hint" id={hintId}>
        {t("datasources.editor.shortcuts", editorHintKeys())} {t("datasources.editor.redisHint")}
        {failed ? ` ${t("datasources.editor.schemaFailed")}` : ""}
      </p>
      <MacroHelp macros={REDIS_MACROS} lead="datasources.editor.promMacrosLead" />
    </div>
  );
}
