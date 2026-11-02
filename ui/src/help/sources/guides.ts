import { searchTemplate } from "../../features/datasources/editors/SearchQueryEditor";
import type { EditorFamily } from "../../features/datasources/queryKinds";
import { familyOf } from "../../features/datasources/queryKinds";
import type { MessageKey } from "../../i18n/i18n";
import { defineRegistry, type HelpTopic, type Snippet } from "../registry";
import { ERROR_RULES, type ErrorRule } from "./errors";
import { groupField, numberField, type ObjectKind, type SchemaObject, timeField } from "./objects";

/**
 * One guide per data source kind (docs/guide/query-languages.md): what the source holds, starter
 * actions that fill in a ready query, schema actions, a cheat sheet of the language's common
 * patterns, and hints for errors. Every query here is read-only and bounded (a row limit, the
 * time range of the screen, a sample), and names nothing but objects of the source's own schema;
 * a guide never holds a host or a credential.
 */

/** What the builders get: the object picked (a table, a collection, a node label) and the rest. */
export interface GuideContext {
  object: SchemaObject | undefined;
  objects: readonly SchemaObject[];
  /** TigerGraph: the source's graph, or a visible gap when its settings cannot be read. */
  graph: string;
}

export interface Starter {
  id: string;
  title: MessageKey;
  /** Builds the query; null when the object picked does not allow it (no time field). */
  build: (context: GuideContext) => unknown;
}

/** The actions on one object of the schema list. */
export type ObjectAction = "rows" | "count" | "structure";
export const OBJECT_ACTIONS: readonly ObjectAction[] = ["rows", "count", "structure"];

export interface SourceGuide {
  /** The kind's name (`postgres`), or `plugin` for kinds a plugin adds. */
  id: string;
  family: EditorFamily;
  /** The language's own name, shown as is (`SQL`, `PromQL`). */
  language: string;
  holds: MessageKey;
  /** What the picker of the start panel offers; null when the source has nothing to pick. */
  pick: { kinds: readonly ObjectKind[]; label: MessageKey } | null;
  starters: readonly Starter[];
  /** The schema actions per object kind; a missing one is not offered. */
  actions: Partial<Record<ObjectAction, (object: SchemaObject, context: GuideContext) => unknown>>;
  cheats: (context: GuideContext) => Snippet[];
  errors: readonly ErrorRule[];
  notes: { time: MessageKey; variables: MessageKey };
  /** The tip after a first result: one pattern of the language. */
  tip: MessageKey;
  /** The section of docs/guide/query-languages.md. */
  docs: string;
  /** Whether a result can be shaped with steps without writing a query. */
  steps: boolean;
}

export const CHEAT_TOPICS: readonly HelpTopic[] = [
  { id: "basics", title: "help.topic.basics" },
  { id: "filter", title: "help.topic.filter" },
  { id: "sort", title: "help.topic.sort" },
  { id: "group", title: "help.topic.group" },
  { id: "join", title: "help.topic.join" },
  { id: "time", title: "help.topic.time" },
  { id: "variables", title: "help.topic.variables" },
];

/** Where the guide pages live; each guide names its section. */
export const QUERY_GUIDE_URL =
  "https://github.com/MouseWerk/Kalzit/blob/main/docs/guide/query-languages.md";

/** Rows a starter asks for; panels and tables stay quick with this many. */
export const LIMIT = 100;
/** Points of a time series starter. */
export const SERIES_LIMIT = 1000;

const snippet = (
  id: string,
  topic: string,
  title: MessageKey,
  text: MessageKey,
  code: string,
  value?: unknown,
): Snippet => ({ id, topic, title, text, code, ...(value === undefined ? {} : { value }) });

// ---------------------------------------------------------------------------------------------
// SQL

export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql" | "clickhouse";

/**
 * A name a guide cannot write safely for its source (ClickHouse refuses a backslash in a quoted
 * name, GSQL and LogQL have no quoting): the starter or snippet that needs it is left out.
 */
export class Unwritable extends Error {}

/** The result of a builder, or null when it needs a name it cannot write. */
export function attempt<T>(build: () => T): T | null {
  try {
    return build();
  } catch (problem) {
    if (problem instanceof Unwritable) {
      return null;
    }
    throw problem;
  }
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Lower case only: PostgreSQL folds unquoted names to lower case, the others ignore case. */
const PLAIN_SQL_NAME = /^[a-z_][a-z0-9_]*$/;

/** Words that are reserved in at least one of the SQL dialects; such names are always quoted. */
const SQL_RESERVED = new Set(
  `all alter analyze and any array as asc between both by case cast check collate column
  constraint create cross current current_date current_time current_timestamp current_user
  database date day default delete desc describe distinct drop else end except exists explain
  false fetch filter first for foreign from full function grant group having hour in index inner
  insert intersect interval into is join key last lateral leading left like limit lock minute
  month natural not null offset on only or order outer over partition primary range read
  references returning right row rows schema second select session_user set show some table
  then time timestamp to top trailing true union unique update user using value values view
  when where window with write year zone`.split(/\s+/),
);

/** A name as the dialect quotes it; lower-case names that are no reserved word stay plain. */
export function sqlName(dialect: SqlDialect, name: string): string {
  if (PLAIN_SQL_NAME.test(name) && !SQL_RESERVED.has(name)) {
    return name;
  }
  switch (dialect) {
    case "mysql":
      return `\`${name.replaceAll("`", "``")}\``;
    case "clickhouse":
      if (name.includes("\\")) {
        throw new Unwritable(name);
      }
      return `\`${name.replaceAll("`", "``")}\``;
    case "mssql":
      return `[${name.replaceAll("]", "]]")}]`;
    default:
      return `"${name.replaceAll('"', '""')}"`;
  }
}

/** A table with its schema, left out where the source's default schema holds it. */
function sqlTable(dialect: SqlDialect, object: SchemaObject | undefined): string {
  const name = sqlName(dialect, object?.name ?? "my_table");
  const schema = object?.schema;
  if (schema === undefined || schema === "" || ["public", "dbo", "main"].includes(schema)) {
    return name;
  }
  return `${sqlName(dialect, schema)}.${name}`;
}

/** A string literal; MySQL and ClickHouse also read backslash escapes in strings. */
export function sqlText(dialect: SqlDialect, text: string): string {
  const escaped =
    dialect === "mysql" || dialect === "clickhouse" ? text.replaceAll("\\", "\\\\") : text;
  return `'${escaped.replaceAll("'", "''")}'`;
}

/** `SELECT <columns> FROM <rest>` with a row limit in the dialect's form. */
function select(dialect: SqlDialect, columns: string, rest: string, limit: number): string {
  return dialect === "mssql"
    ? `SELECT TOP ${limit} ${columns}\nFROM ${rest}`
    : `SELECT ${columns}\nFROM ${rest}\nLIMIT ${limit}`;
}

const sql = (text: string) => ({ sql: text });

function sqlStructure(dialect: SqlDialect, object: SchemaObject): string {
  const name = sqlText(dialect, object.name);
  const schema = object.schema === undefined || object.schema === "" ? undefined : object.schema;
  switch (dialect) {
    case "sqlite":
      return `SELECT name, type, "notnull", pk\nFROM pragma_table_info(${name})`;
    case "clickhouse":
      return `SELECT name, type\nFROM system.columns\nWHERE table = ${name} AND database = ${
        schema === undefined ? "currentDatabase()" : sqlText(dialect, schema)
      }\nLIMIT 500`;
    case "mssql":
      return `SELECT TOP 500 COLUMN_NAME, DATA_TYPE, IS_NULLABLE\nFROM INFORMATION_SCHEMA.COLUMNS\nWHERE TABLE_NAME = ${name} AND TABLE_SCHEMA = ${
        schema === undefined ? "SCHEMA_NAME()" : sqlText(dialect, schema)
      }\nORDER BY ORDINAL_POSITION`;
    default: {
      const inSchema =
        schema === undefined ? "" : ` AND table_schema = ${sqlText(dialect, schema)}`;
      return `SELECT column_name, data_type, is_nullable\nFROM information_schema.columns\nWHERE table_name = ${name}${inSchema}\nORDER BY ordinal_position\nLIMIT 500`;
    }
  }
}

/** Two tables and the column they likely share, for the join pattern. */
function joinOf(context: GuideContext): { other: SchemaObject; left: string; right: string } {
  const object = context.object;
  const others = context.objects.filter((o) => o.kind === "table" && o !== object);
  for (const other of others) {
    const shared = (object?.fields ?? []).find(
      (f) => /id$/i.test(f.name) && other.fields.some((g) => g.name === f.name),
    );
    if (shared !== undefined) {
      return { other, left: shared.name, right: shared.name };
    }
  }
  const other = others[0] ?? { kind: "table" as const, name: "other_table", fields: [] };
  return { other, left: "id", right: `${(object?.name ?? "my_table").replace(/s$/, "")}_id` };
}

function sqlGuide(dialect: SqlDialect): SourceGuide {
  const q = (name: string) => sqlName(dialect, name);
  const rows = (o: SchemaObject | undefined) => select(dialect, "*", sqlTable(dialect, o), LIMIT);
  const count = (o: SchemaObject | undefined) =>
    `SELECT COUNT(*) AS n\nFROM ${sqlTable(dialect, o)}`;
  const countBy = (o: SchemaObject | undefined) => {
    const field = groupField(o);
    if (field === undefined) return null;
    return select(
      dialect,
      `${q(field)}, COUNT(*) AS n`,
      `${sqlTable(dialect, o)}\nGROUP BY ${q(field)}\nORDER BY n DESC`,
      LIMIT,
    );
  };
  const latest = (o: SchemaObject | undefined) => {
    const time = timeField(o);
    if (time === undefined) return null;
    return select(
      dialect,
      "*",
      `${sqlTable(dialect, o)}\nWHERE $__timeFilter(${q(time)})\nORDER BY ${q(time)} DESC`,
      LIMIT,
    );
  };
  const overTime = (o: SchemaObject | undefined) => {
    const time = timeField(o);
    const value = numberField(o);
    if (time === undefined || value === undefined) return null;
    return select(
      dialect,
      `${q(time)} AS time, ${q(value)}`,
      `${sqlTable(dialect, o)}\nWHERE $__timeFilter(${q(time)})\nORDER BY ${q(time)}`,
      SERIES_LIMIT,
    );
  };
  const orNull = (text: string | null) => (text === null ? null : sql(text));
  return {
    id: dialect,
    family: "sql",
    language: "SQL",
    holds: "help.source.sql.holds",
    pick: { kinds: ["table"], label: "help.pick.table" },
    starters: [
      { id: "rows", title: "help.starter.sql.rows", build: (c) => sql(rows(c.object)) },
      { id: "countBy", title: "help.starter.sql.countBy", build: (c) => orNull(countBy(c.object)) },
      { id: "latest", title: "help.starter.sql.latest", build: (c) => orNull(latest(c.object)) },
      {
        id: "overTime",
        title: "help.starter.sql.overTime",
        build: (c) => orNull(overTime(c.object)),
      },
      { id: "count", title: "help.starter.sql.count", build: (c) => sql(count(c.object)) },
    ],
    actions: {
      rows: (o) => sql(rows(o)),
      count: (o) => sql(count(o)),
      structure: (o) => sql(sqlStructure(dialect, o)),
    },
    cheats: (c) => {
      const table = sqlTable(dialect, c.object);
      const field = groupField(c.object) ?? "status";
      const time = timeField(c.object) ?? "created_at";
      const value = numberField(c.object);
      const join = joinOf(c);
      const order = `SELECT columns\nFROM table\nWHERE condition\nGROUP BY columns\nORDER BY columns\nLIMIT number`;
      const limited = (cols: string, rest: string, n = LIMIT) => select(dialect, cols, rest, n);
      const entry = (id: string, topic: string, code: string, insert = true) =>
        snippet(
          id,
          topic,
          `help.cheat.sql.${id}.title` as MessageKey,
          `help.cheat.sql.${id}.text` as MessageKey,
          code,
          insert ? sql(code) : undefined,
        );
      return [
        entry("order", "basics", order, false),
        entry("rows", "basics", rows(c.object)),
        entry("columns", "basics", limited(`${q(field)}, ${q(time)}`, table)),
        entry(
          "where",
          "filter",
          limited("*", `${table}\nWHERE ${q(field)} = ${sqlText(dialect, "value")}`),
        ),
        entry("like", "filter", limited("*", `${table}\nWHERE ${q(field)} LIKE '%part%'`)),
        entry(
          "and",
          "filter",
          limited("*", `${table}\nWHERE ${q(field)} IN ('a', 'b')\n  AND ${q(field)} IS NOT NULL`),
        ),
        entry("orderBy", "sort", limited("*", `${table}\nORDER BY ${q(time)} DESC`)),
        entry("top", "sort", limited("*", `${table}\nORDER BY ${q(value ?? field)} DESC`, 10)),
        entry(
          "groupBy",
          "group",
          limited(
            `${q(field)}, COUNT(*) AS n${value === undefined ? "" : `, SUM(${q(value)}) AS total`}`,
            `${table}\nGROUP BY ${q(field)}\nORDER BY n DESC`,
          ),
        ),
        entry("distinct", "group", limited(`DISTINCT ${q(field)}`, table)),
        entry(
          "join",
          "join",
          limited(
            "a.*, b.*",
            `${table} AS a\nJOIN ${sqlTable(dialect, join.other)} AS b ON b.${q(join.right)} = a.${q(join.left)}`,
          ),
        ),
        entry(
          "timeFilter",
          "time",
          limited("*", `${table}\nWHERE $__timeFilter(${q(time)})\nORDER BY ${q(time)} DESC`),
        ),
        entry(
          "variable",
          "variables",
          limited("*", `${table}\nWHERE ${q(field)} IN ($${field.replace(/\W/g, "_")})`),
          false,
        ),
      ];
    },
    errors: ERROR_RULES.sql,
    notes: { time: "help.source.sql.time", variables: "help.source.sql.variables" },
    tip: "help.source.sql.tip",
    docs: {
      postgres: "postgresql",
      mysql: "mysql-and-mariadb",
      sqlite: "sqlite",
      mssql: "sql-server",
      clickhouse: "clickhouse",
    }[dialect],
    steps: true,
  };
}

// ---------------------------------------------------------------------------------------------
// Prometheus

const promLabelValue = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;

const PROM_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** A label name: plain, or quoted (Prometheus 3 takes any UTF-8 name in quotes). */
const promLabel = (name: string) => (PLAIN_NAME.test(name) ? name : promLabelValue(name));

/** A series selector: `metric{m}` for a plain name, else the quoted form `{"metric", m}`. */
function promSelector(metric: string, ...matchers: string[]): string {
  if (PROM_NAME.test(metric)) {
    return matchers.length === 0 ? metric : `${metric}{${matchers.join(", ")}}`;
  }
  return `{${[promLabelValue(metric), ...matchers].join(", ")}}`;
}

const promGuide: SourceGuide = (() => {
  const name = (c: GuideContext) => c.object?.name ?? "up";
  const metric = (c: GuideContext) => promSelector(name(c));
  const label = (c: GuideContext) => promLabel(c.object?.fields[0]?.name ?? "job");
  const isCounter = (name: string) => /_(total|count|sum|bucket)$/.test(name);
  const rate = (name: string) => `rate(${name}[$__rate_interval])`;
  const prom = (expr: string, instant = false) => (instant ? { expr, instant: true } : { expr });
  const entry = (id: string, topic: string, expr: string, insert = true) =>
    snippet(
      id,
      topic,
      `help.cheat.promql.${id}.title` as MessageKey,
      `help.cheat.promql.${id}.text` as MessageKey,
      expr,
      insert ? prom(expr) : undefined,
    );
  return {
    id: "prometheus",
    family: "promql",
    language: "PromQL",
    holds: "help.source.promql.holds",
    pick: { kinds: ["metric"], label: "help.pick.metric" },
    starters: [
      { id: "series", title: "help.starter.promql.series", build: (c) => prom(metric(c)) },
      {
        id: "rate",
        title: "help.starter.promql.rate",
        build: (c) => (isCounter(name(c)) ? prom(rate(metric(c))) : null),
      },
      {
        id: "sumBy",
        title: "help.starter.promql.sumBy",
        build: (c) =>
          prom(`sum by (${label(c)}) (${isCounter(name(c)) ? rate(metric(c)) : metric(c)})`),
      },
      {
        id: "topk",
        title: "help.starter.promql.topk",
        build: (c) => prom(`topk(5, ${metric(c)})`, true),
      },
      { id: "down", title: "help.starter.promql.down", build: () => prom("up == 0", true) },
    ],
    actions: {
      rows: (o) => prom(promSelector(o.name)),
      count: (o) => prom(`count(${promSelector(o.name)})`, true),
      structure: (o) => prom(`last_over_time(${promSelector(o.name)}[5m])`, true),
    },
    cheats: (c) => {
      const m = metric(c);
      const l = label(c);
      return [
        entry("selector", "basics", m),
        entry("match", "filter", promSelector(name(c), `${l}=${promLabelValue("value")}`)),
        entry("regex", "filter", promSelector(name(c), `${l}=~${promLabelValue("a|b")}`)),
        entry("compare", "filter", `${m} > 0`),
        entry("topk", "sort", `topk(5, ${m})`),
        entry("sort", "sort", `sort_desc(${m})`),
        entry("sumBy", "group", `sum by (${l}) (${m})`),
        entry("count", "group", `count by (${l}) (${m})`),
        entry("rate", "time", rate(isCounter(name(c)) ? m : "http_requests_total")),
        entry("avgOverTime", "time", `avg_over_time(${m}[$__interval])`),
        entry(
          "ratio",
          "join",
          `sum(${rate(`http_requests_total{status=~${promLabelValue("5..")}}`)})
/
sum(${rate("http_requests_total")})`,
        ),
        entry(
          "variable",
          "variables",
          promSelector(name(c), `${l}=~${promLabelValue(`$${l.replace(/\W/g, "_")}`)}`),
          false,
        ),
      ];
    },
    errors: ERROR_RULES.promql,
    notes: { time: "help.source.promql.time", variables: "help.source.promql.variables" },
    tip: "help.source.promql.tip",
    docs: "prometheus",
    steps: true,
  };
})();

// ---------------------------------------------------------------------------------------------
// InfluxDB (InfluxQL; Flux and SQL in the cheat sheet)

/** Backslashes and double quotes escaped, for a quoted InfluxQL name or a Flux string. */
const backslashed = (text: string) => text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
const influxName = (name: string) => `"${backslashed(name)}"`;
/** A Flux string: `${` would start an interpolation, so its `$` is escaped too. */
const fluxString = (text: string) => `"${backslashed(text).replaceAll("${", "\\${")}"`;
/** An InfluxQL string literal in single quotes. */
const influxText = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const influxGuide: SourceGuide = (() => {
  const m = (c: GuideContext) => influxName(c.object?.name ?? "cpu");
  const field = (c: GuideContext) => numberField(c.object) ?? "value";
  const tag = (c: GuideContext) => groupField(c.object) ?? "host";
  const iql = (influxql: string) => ({ influxql });
  const entry = (id: string, topic: string, code: string, value: unknown) =>
    snippet(
      id,
      topic,
      `help.cheat.influx.${id}.title` as MessageKey,
      `help.cheat.influx.${id}.text` as MessageKey,
      code,
      value,
    );
  const text = (id: string, topic: string, code: string, insert = true) =>
    entry(id, topic, code, insert ? iql(code) : undefined);
  return {
    id: "influxdb",
    family: "influx",
    language: "InfluxQL",
    holds: "help.source.influx.holds",
    pick: { kinds: ["table"], label: "help.pick.measurement" },
    starters: [
      {
        id: "latest",
        title: "help.starter.influx.latest",
        build: (c) =>
          iql(`SELECT * FROM ${m(c)} WHERE $__timeFilter ORDER BY time DESC LIMIT ${LIMIT}`),
      },
      {
        id: "mean",
        title: "help.starter.influx.mean",
        build: (c) =>
          iql(
            `SELECT mean(${influxName(field(c))}) FROM ${m(c)} WHERE $__timeFilter GROUP BY time($__interval) fill(none)`,
          ),
      },
      {
        id: "byTag",
        title: "help.starter.influx.byTag",
        build: (c) =>
          iql(
            `SELECT mean(${influxName(field(c))}) FROM ${m(c)} WHERE $__timeFilter GROUP BY time($__interval), ${influxName(tag(c))} fill(none)`,
          ),
      },
      {
        id: "measurements",
        title: "help.starter.influx.measurements",
        build: () => iql("SHOW MEASUREMENTS LIMIT 100"),
      },
    ],
    actions: {
      rows: (o) =>
        iql(
          `SELECT * FROM ${influxName(o.name)} WHERE $__timeFilter ORDER BY time DESC LIMIT ${LIMIT}`,
        ),
      count: (o) => iql(`SELECT count(*) FROM ${influxName(o.name)} WHERE $__timeFilter`),
      structure: (o) => iql(`SHOW FIELD KEYS FROM ${influxName(o.name)}`),
    },
    cheats: (c) => [
      text(
        "select",
        "basics",
        `SELECT ${influxName(field(c))} FROM ${m(c)} WHERE $__timeFilter LIMIT ${LIMIT}`,
      ),
      text(
        "where",
        "filter",
        `SELECT * FROM ${m(c)} WHERE ${influxName(tag(c))} = ${influxText("value")} AND $__timeFilter LIMIT ${LIMIT}`,
      ),
      text(
        "orderBy",
        "sort",
        `SELECT * FROM ${m(c)} WHERE $__timeFilter ORDER BY time DESC LIMIT 10`,
      ),
      text(
        "groupBy",
        "group",
        `SELECT mean(${influxName(field(c))}) FROM ${m(c)} WHERE $__timeFilter GROUP BY ${influxName(tag(c))}`,
      ),
      text(
        "timeBuckets",
        "time",
        `SELECT max(${influxName(field(c))}) FROM ${m(c)} WHERE $__timeFilter GROUP BY time($__interval)`,
      ),
      entry(
        "flux",
        "basics",
        `from(bucket: v.bucket)\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n  |> filter(fn: (r) => r._measurement == ${fluxString(c.object?.name ?? "cpu")})\n  |> limit(n: ${LIMIT})`,
        undefined,
      ),
      text(
        "variable",
        "variables",
        `SELECT * FROM ${m(c)} WHERE ${influxName(tag(c))} = '$${tag(c).replace(/\W/g, "_")}' AND $__timeFilter`,
        false,
      ),
    ],
    errors: ERROR_RULES.influx,
    notes: { time: "help.source.influx.time", variables: "help.source.influx.variables" },
    tip: "help.source.influx.tip",
    docs: "influxdb",
    steps: true,
  };
})();

// ---------------------------------------------------------------------------------------------
// Loki

/** A Loki label name; Loki has no quoting for names that are not plain. */
function lokiLabel(name: string): string {
  if (!PLAIN_NAME.test(name)) {
    throw new Unwritable(name);
  }
  return name;
}

const lokiGuide: SourceGuide = (() => {
  const selector = (c: GuideContext) => {
    const label = lokiLabel(c.object?.name ?? "job");
    const value = c.object?.fields[0]?.name ?? "value";
    return `{${label}=${promLabelValue(value)}}`;
  };
  const logs = (logql: string) => ({ logql, limit: LIMIT });
  const metric = (logql: string) => ({ logql });
  const entry = (id: string, topic: string, code: string, value?: unknown) =>
    snippet(
      id,
      topic,
      `help.cheat.logql.${id}.title` as MessageKey,
      `help.cheat.logql.${id}.text` as MessageKey,
      code,
      value,
    );
  return {
    id: "loki",
    family: "logql",
    language: "LogQL",
    holds: "help.source.logql.holds",
    pick: { kinds: ["label"], label: "help.pick.label" },
    starters: [
      { id: "latest", title: "help.starter.logql.latest", build: (c) => logs(selector(c)) },
      {
        id: "errors",
        title: "help.starter.logql.errors",
        build: (c) => logs(`${selector(c)} |~ "(?i)error"`),
      },
      {
        id: "volume",
        title: "help.starter.logql.volume",
        build: (c) => metric(`sum(count_over_time(${selector(c)}[$__interval]))`),
      },
      {
        id: "byLevel",
        title: "help.starter.logql.byLevel",
        build: (c) =>
          metric(
            `sum by (${lokiLabel(c.object?.name ?? "job")}) (count_over_time(${selector(c)}[$__interval]))`,
          ),
      },
    ],
    actions: {
      rows: (o, c) => logs(selector({ ...c, object: o })),
      count: (o, c) =>
        metric(`sum(count_over_time(${selector({ ...c, object: o })}[$__interval]))`),
      structure: (o) =>
        metric(
          `count by (${lokiLabel(o.name)}) (count_over_time({${lokiLabel(o.name)}=~".+"}[$__interval]))`,
        ),
    },
    cheats: (c) => {
      const s = selector(c);
      return [
        entry("selector", "basics", s, logs(s)),
        entry("contains", "filter", `${s} |= "error"`, logs(`${s} |= "error"`)),
        entry("excludes", "filter", `${s} != "debug"`, logs(`${s} != "debug"`)),
        entry(
          "json",
          "filter",
          `${s} | json | level = "error"`,
          logs(`${s} | json | level = "error"`),
        ),
        entry(
          "count",
          "group",
          `sum by (level) (count_over_time(${s} | json [$__interval]))`,
          metric(`sum by (level) (count_over_time(${s} | json [$__interval]))`),
        ),
        entry("rate", "time", `rate(${s}[$__interval])`, metric(`rate(${s}[$__interval])`)),
        entry(
          "variable",
          "variables",
          `{${lokiLabel(c.object?.name ?? "job")}=~"$${(c.object?.name ?? "job").replace(/\W/g, "_")}"}`,
        ),
      ];
    },
    errors: ERROR_RULES.logql,
    notes: { time: "help.source.logql.time", variables: "help.source.logql.variables" },
    tip: "help.source.logql.tip",
    docs: "loki",
    steps: true,
  };
})();

// ---------------------------------------------------------------------------------------------
// Elasticsearch and OpenSearch

/** A field name in Lucene text, with the characters of the query syntax escaped. */
export function luceneName(name: string): string {
  return name.replace(/[\\+\-=&|><!(){}[\]^"~*?:/\s]/g, (c) => `\\${c}`);
}

const searchGuide: SourceGuide = (() => {
  const index = (c: GuideContext) => c.object?.name;
  const fields = (c: GuideContext) => c.object?.fields ?? [];
  const time = (c: GuideContext) => timeField(c.object) ?? "";
  const keyword = (c: GuideContext) =>
    fields(c).find((f) => ["keyword", "constant_keyword", "ip", "boolean"].includes(f.type))?.name;
  const at = (c: GuideContext, rest: Record<string, unknown>) => {
    const name = index(c);
    return {
      ...(name === undefined ? {} : { index: name }),
      ...(time(c) === "" ? {} : { timeField: time(c) }),
      ...rest,
    };
  };
  const lucene = (c: GuideContext, text: string) => at(c, { lucene: text, size: LIMIT });
  const dsl = (c: GuideContext, body: Record<string, unknown>) => at(c, { dsl: body });
  const entry = (id: string, topic: string, code: string, value?: unknown) =>
    snippet(
      id,
      topic,
      `help.cheat.search.${id}.title` as MessageKey,
      `help.cheat.search.${id}.text` as MessageKey,
      code,
      value,
    );
  return {
    id: "elasticsearch",
    family: "search",
    language: "Lucene / Query DSL",
    holds: "help.source.search.holds",
    pick: { kinds: ["index"], label: "help.pick.index" },
    starters: [
      { id: "latest", title: "help.starter.search.latest", build: (c) => lucene(c, "") },
      { id: "errors", title: "help.starter.search.errors", build: (c) => lucene(c, "error") },
      {
        id: "terms",
        title: "help.starter.search.terms",
        build: (c) =>
          keyword(c) === undefined ? null : dsl(c, searchTemplate("terms", time(c), fields(c))),
      },
      {
        id: "histogram",
        title: "help.starter.search.histogram",
        build: (c) => dsl(c, searchTemplate("histogram", time(c), fields(c))),
      },
    ],
    actions: {
      rows: (o, c) => lucene({ ...c, object: o }, ""),
      count: (o, c) =>
        dsl({ ...c, object: o }, searchTemplate("histogram", time({ ...c, object: o }), o.fields)),
      structure: (o, c) => at({ ...c, object: o }, { lucene: "", size: 1 }),
    },
    cheats: (c) => {
      const keywordName = keyword(c) ?? "status";
      const numberName = numberField(c.object) ?? "bytes";
      // In Lucene text the names are escaped; in a Query DSL body they are JSON strings.
      const k = luceneName(keywordName);
      const n = luceneName(numberName);
      return [
        entry("all", "basics", "*", lucene(c, "")),
        entry("field", "filter", `${k}:value`, lucene(c, `${k}:value`)),
        entry("bool", "filter", `${k}:a OR ${k}:b`, lucene(c, `${k}:a OR ${k}:b`)),
        entry("range", "filter", `${n}:>1000`, lucene(c, `${n}:>1000`)),
        entry("exists", "filter", `_exists_:${k}`, lucene(c, `_exists_:${k}`)),
        entry("wildcard", "filter", `${k}:err*`, lucene(c, `${k}:err*`)),
        entry(
          "sort",
          "sort",
          JSON.stringify(
            { query: { match_all: {} }, sort: [{ [numberName]: { order: "desc" } }], size: 10 },
            null,
            2,
          ),
          dsl(c, {
            query: { match_all: {} },
            sort: [{ [numberName]: { order: "desc" } }],
            size: 10,
          }),
        ),
        entry(
          "terms",
          "group",
          JSON.stringify(
            { aggs: { [keywordName]: { terms: { field: keywordName, size: 10 } } } },
            null,
            2,
          ),
          dsl(c, { aggs: { [keywordName]: { terms: { field: keywordName, size: 10 } } } }),
        ),
        entry(
          "histogram",
          "time",
          JSON.stringify(searchTemplate("histogram", time(c), fields(c)), null, 2),
          dsl(c, searchTemplate("histogram", time(c), fields(c))),
        ),
        entry("variable", "variables", `${k}:$${keywordName.replace(/\W/g, "_")}`),
      ];
    },
    errors: ERROR_RULES.search,
    notes: { time: "help.source.search.time", variables: "help.source.search.variables" },
    tip: "help.source.search.tip",
    docs: "elasticsearch-and-opensearch",
    steps: true,
  };
})();

// ---------------------------------------------------------------------------------------------
// MongoDB

/** A pipeline as the editor shows it: one stage per line. */
export function pipelineText(stages: readonly unknown[]): string {
  return stages.length === 0
    ? "[]"
    : `[\n${stages.map((s) => `  ${JSON.stringify(s)}`).join(",\n")}\n]`;
}

const mongoGuide: SourceGuide = (() => {
  const collection = (c: GuideContext) => c.object?.name ?? "";
  const field = (c: GuideContext) => groupField(c.object) ?? "status";
  const time = (c: GuideContext) => timeField(c.object);
  const pipeline = (c: GuideContext | string, stages: unknown[]) => ({
    collection: typeof c === "string" ? c : collection(c),
    pipeline: pipelineText(stages),
  });
  const limit = { $limit: LIMIT };
  const countBy = (name: string) => [
    { $group: { _id: `$${name}`, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    limit,
  ];
  const structure = [
    { $limit: 1000 },
    { $project: { fields: { $objectToArray: "$$ROOT" } } },
    { $unwind: "$fields" },
    { $group: { _id: "$fields.k", types: { $addToSet: { $type: "$fields.v" } }, n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
    limit,
  ];
  const entry = (
    id: string,
    topic: string,
    c: GuideContext,
    stages: unknown[] | null,
    insert = true,
  ) =>
    snippet(
      id,
      topic,
      `help.cheat.mongo.${id}.title` as MessageKey,
      `help.cheat.mongo.${id}.text` as MessageKey,
      stages === null ? "" : pipelineText(stages),
      insert && stages !== null ? pipeline(c, stages) : undefined,
    );
  return {
    id: "mongodb",
    family: "mongo",
    language: "MongoDB",
    holds: "help.source.mongo.holds",
    pick: { kinds: ["collection"], label: "help.pick.collection" },
    starters: [
      { id: "rows", title: "help.starter.mongo.rows", build: (c) => pipeline(c, [limit]) },
      {
        id: "countBy",
        title: "help.starter.mongo.countBy",
        build: (c) => pipeline(c, countBy(field(c))),
      },
      {
        id: "latest",
        title: "help.starter.mongo.latest",
        build: (c) => {
          const t = time(c);
          return t === undefined
            ? null
            : pipeline(c, [{ $match: { $__timeFilter: t } }, { $sort: { [t]: -1 } }, limit]);
        },
      },
      {
        id: "count",
        title: "help.starter.mongo.count",
        build: (c) => pipeline(c, [{ $count: "n" }]),
      },
    ],
    actions: {
      rows: (o) => pipeline(o.name, [limit]),
      count: (o) => pipeline(o.name, [{ $count: "n" }]),
      structure: (o) => pipeline(o.name, structure),
    },
    cheats: (c) => {
      const f = field(c);
      const t = time(c) ?? "createdAt";
      const n = numberField(c.object) ?? "total";
      const other =
        c.objects.find((o) => o.kind === "collection" && o !== c.object)?.name ?? "customers";
      return [
        entry("limit", "basics", c, [limit]),
        entry("match", "filter", c, [{ $match: { [f]: "value" } }, limit]),
        entry("in", "filter", c, [
          { $match: { [f]: { $in: ["a", "b"] }, [n]: { $gt: 0 } } },
          limit,
        ]),
        entry("project", "basics", c, [{ $project: { _id: 0, [f]: 1, [t]: 1 } }, limit]),
        entry("sort", "sort", c, [{ $sort: { [t]: -1 } }, { $limit: 10 }]),
        entry("group", "group", c, [
          { $group: { _id: `$${f}`, n: { $sum: 1 }, total: { $sum: `$${n}` } } },
          { $sort: { n: -1 } },
          limit,
        ]),
        entry("lookup", "join", c, [
          limit,
          {
            $lookup: {
              from: other,
              localField: `${other.replace(/s$/, "")}Id`,
              foreignField: "_id",
              as: other,
            },
          },
        ]),
        entry("time", "time", c, [{ $match: { $__timeFilter: t } }, { $sort: { [t]: -1 } }, limit]),
        entry(
          "variable",
          "variables",
          c,
          [{ $match: { [f]: `\${${f.replace(/\W/g, "_")}}` } }, limit],
          false,
        ),
      ];
    },
    errors: ERROR_RULES.mongo,
    notes: { time: "help.source.mongo.time", variables: "help.source.mongo.variables" },
    tip: "help.source.mongo.tip",
    docs: "mongodb",
    steps: true,
  };
})();

// ---------------------------------------------------------------------------------------------
// Cypher (Neo4j, Memgraph)

/** Cypher's reserved words, compared without case; such names are quoted. */
const CYPHER_RESERVED = new Set(
  `all and as asc ascending by call case contains count create delete desc descending detach
  distinct else end ends exists false foreach in is limit load match merge not null on optional
  or order remove return set skip starts then true union unwind use when where with xor yield`.split(
    /\s+/,
  ),
);

/** A label, edge type or property key: plain, or in backticks. */
export function cypherName(name: string): string {
  return PLAIN_NAME.test(name) && !CYPHER_RESERVED.has(name.toLowerCase())
    ? name
    : `\`${name.replaceAll("`", "``")}\``;
}

function cypherGuide(kind: "neo4j" | "memgraph"): SourceGuide {
  const label = (c: GuideContext) => cypherName(c.object?.name ?? "Person");
  const edge = (c: GuideContext) =>
    cypherName(c.objects.find((o) => o.kind === "edgeType")?.name ?? "KNOWS");
  const key = (c: GuideContext) => cypherName(c.object?.fields[0]?.name ?? "name");
  const cypher = (text: string) => ({ cypher: text });
  const entry = (id: string, topic: string, code: string, insert = true) =>
    snippet(
      id,
      topic,
      `help.cheat.cypher.${id}.title` as MessageKey,
      `help.cheat.cypher.${id}.text` as MessageKey,
      code,
      insert ? cypher(code) : undefined,
    );
  const nodes = (name: string) => `MATCH (n:${name})\nRETURN n\nLIMIT ${LIMIT}`;
  const edges = (name: string) => `MATCH (a)-[r:${name}]->(b)\nRETURN a, r, b\nLIMIT ${LIMIT}`;
  return {
    id: kind,
    family: "cypher",
    language: "Cypher",
    holds: "help.source.cypher.holds",
    pick: { kinds: ["nodeLabel"], label: "help.pick.nodeLabel" },
    starters: [
      { id: "nodes", title: "help.starter.cypher.nodes", build: (c) => cypher(nodes(label(c))) },
      {
        id: "neighbours",
        title: "help.starter.cypher.neighbours",
        build: (c) => cypher(`MATCH (n:${label(c)})-[r]-(m)\nRETURN n, r, m\nLIMIT ${LIMIT}`),
      },
      {
        id: "labels",
        title: "help.starter.cypher.labels",
        build: () =>
          cypher(
            `MATCH (n)\nRETURN labels(n) AS label, count(*) AS n\nORDER BY n DESC\nLIMIT ${LIMIT}`,
          ),
      },
      {
        id: "edgeTypes",
        title: "help.starter.cypher.edgeTypes",
        build: () =>
          cypher(
            `MATCH ()-[r]->()\nRETURN type(r) AS type, count(*) AS n\nORDER BY n DESC\nLIMIT ${LIMIT}`,
          ),
      },
      {
        id: "paths",
        title: "help.starter.cypher.paths",
        build: (c) => cypher(`MATCH p = (a:${label(c)})-[*1..3]-(b)\nRETURN p\nLIMIT 25`),
      },
    ],
    actions: {
      rows: (o) =>
        cypher(o.kind === "edgeType" ? edges(cypherName(o.name)) : nodes(cypherName(o.name))),
      count: (o) =>
        cypher(
          o.kind === "edgeType"
            ? `MATCH ()-[r:${cypherName(o.name)}]->()\nRETURN count(r) AS n`
            : `MATCH (n:${cypherName(o.name)})\nRETURN count(n) AS n`,
        ),
      structure: (o) =>
        cypher(
          o.kind === "edgeType"
            ? `MATCH ()-[r:${cypherName(o.name)}]->()\nWITH r LIMIT ${LIMIT}\nUNWIND keys(r) AS key\nRETURN key, count(*) AS n\nORDER BY n DESC`
            : `MATCH (n:${cypherName(o.name)})\nWITH n LIMIT ${LIMIT}\nUNWIND keys(n) AS key\nRETURN key, count(*) AS n\nORDER BY n DESC`,
        ),
    },
    cheats: (c) => {
      const l = label(c);
      const k = key(c);
      return [
        entry("match", "basics", nodes(l)),
        entry(
          "where",
          "filter",
          `MATCH (n:${l})\nWHERE n.${k} = 'value'\nRETURN n\nLIMIT ${LIMIT}`,
        ),
        entry(
          "contains",
          "filter",
          `MATCH (n:${l})\nWHERE n.${k} CONTAINS 'part'\nRETURN n\nLIMIT ${LIMIT}`,
        ),
        entry(
          "orderBy",
          "sort",
          `MATCH (n:${l})\nRETURN n.${k} AS value\nORDER BY value DESC\nLIMIT 10`,
        ),
        entry(
          "count",
          "group",
          `MATCH (n:${l})\nRETURN n.${k} AS value, count(*) AS n\nORDER BY n DESC\nLIMIT ${LIMIT}`,
        ),
        entry(
          "traverse",
          "join",
          `MATCH (a:${l})-[r:${edge(c)}]->(b)\nRETURN a, r, b\nLIMIT ${LIMIT}`,
        ),
        entry(
          "degree",
          "join",
          `MATCH (n:${l})-[r]-()\nRETURN n, count(r) AS degree\nORDER BY degree DESC\nLIMIT 10`,
        ),
        entry(
          "path",
          "join",
          `MATCH p = shortestPath((a:${l})-[*..5]-(b:${l}))\nWHERE a <> b\nRETURN p\nLIMIT 1`,
        ),
        entry(
          "time",
          "time",
          `MATCH (n:${l})\nWHERE n.createdAt >= $__timeFrom AND n.createdAt < $__timeTo\nRETURN n\nLIMIT ${LIMIT}`,
        ),
        entry(
          "variable",
          "variables",
          `MATCH (n:${l})\nWHERE n.${k} = $${k.replace(/\W/g, "_")}\nRETURN n\nLIMIT ${LIMIT}`,
          false,
        ),
      ];
    },
    errors: ERROR_RULES.cypher,
    notes: { time: "help.source.cypher.time", variables: "help.source.cypher.variables" },
    tip: "help.source.cypher.tip",
    docs: "neo4j-and-memgraph",
    steps: true,
  };
}

// ---------------------------------------------------------------------------------------------
// TigerGraph (GSQL)

/** A GSQL name; GSQL has no quoting, so a name that is not plain cannot be written. */
function gsqlName(name: string): string {
  if (!PLAIN_NAME.test(name)) {
    throw new Unwritable(name);
  }
  return name;
}

/** An interpreted query around `body`, for the source's graph. */
export function interpret(graph: string, body: string): string {
  return `INTERPRET QUERY () FOR GRAPH ${graph} {\n${body
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n}`;
}

const gsqlGuide: SourceGuide = (() => {
  const vertex = (c: GuideContext) => gsqlName(c.object?.name ?? "Person");
  const edgeType = (c: GuideContext) =>
    gsqlName(c.objects.find((o) => o.kind === "edgeType")?.name ?? "KNOWS");
  const gsql = (graph: string, body: string) => ({ gsql: interpret(graph, body) });
  const vertices = (name: string, n = LIMIT) =>
    `Start = {${name}.*};\nResult = SELECT s FROM Start:s LIMIT ${n};\nPRINT Result;`;
  const entry = (id: string, topic: string, c: GuideContext, body: string) =>
    snippet(
      id,
      topic,
      `help.cheat.gsql.${id}.title` as MessageKey,
      `help.cheat.gsql.${id}.text` as MessageKey,
      interpret(c.graph, body),
      gsql(c.graph, body),
    );
  return {
    id: "tigergraph",
    family: "gsql",
    language: "GSQL",
    holds: "help.source.gsql.holds",
    pick: { kinds: ["nodeLabel"], label: "help.pick.vertexType" },
    starters: [
      {
        id: "vertices",
        title: "help.starter.gsql.vertices",
        build: (c) => gsql(c.graph, vertices(vertex(c))),
      },
      {
        id: "neighbours",
        title: "help.starter.gsql.neighbours",
        build: (c) =>
          gsql(
            c.graph,
            `Start = {${vertex(c)}.*};\nResult = SELECT t FROM Start:s -(${edgeType(c)}:e)- :t LIMIT ${LIMIT};\nPRINT Result;`,
          ),
      },
      {
        id: "count",
        title: "help.starter.gsql.count",
        build: (c) =>
          gsql(
            c.graph,
            `SumAccum<INT> @@n;\nStart = {${vertex(c)}.*};\nResult = SELECT s FROM Start:s ACCUM @@n += 1;\nPRINT @@n;`,
          ),
      },
      {
        id: "installed",
        title: "help.starter.gsql.installed",
        build: (c) => {
          const installed = c.objects.find((o) => o.kind === "installed");
          return installed === undefined ? null : { installed: installed.name };
        },
      },
    ],
    actions: {
      rows: (o, c) =>
        o.kind === "installed" ? { installed: o.name } : gsql(c.graph, vertices(gsqlName(o.name))),
      count: (o, c) =>
        o.kind === "nodeLabel"
          ? gsql(
              c.graph,
              `SumAccum<INT> @@n;\nStart = {${gsqlName(o.name)}.*};\nResult = SELECT s FROM Start:s ACCUM @@n += 1;\nPRINT @@n;`,
            )
          : null,
      structure: (o, c) =>
        o.kind === "nodeLabel" ? gsql(c.graph, vertices(gsqlName(o.name), 5)) : null,
    },
    cheats: (c) => {
      const v = vertex(c);
      const e = edgeType(c);
      const key = gsqlName(c.object?.fields[0]?.name ?? "name");
      return [
        entry("select", "basics", c, vertices(v)),
        entry(
          "where",
          "filter",
          c,
          `Start = {${v}.*};\nResult = SELECT s FROM Start:s WHERE s.${key} == "value" LIMIT ${LIMIT};\nPRINT Result;`,
        ),
        entry(
          "orderBy",
          "sort",
          c,
          `Start = {${v}.*};\nResult = SELECT s FROM Start:s ORDER BY s.${key} DESC LIMIT 10;\nPRINT Result;`,
        ),
        entry(
          "accum",
          "group",
          c,
          `SumAccum<INT> @degree;\nStart = {${v}.*};\nResult = SELECT s FROM Start:s -(${e}:e)- :t ACCUM s.@degree += 1 ORDER BY s.@degree DESC LIMIT 10;\nPRINT Result;`,
        ),
        entry(
          "traverse",
          "join",
          c,
          `Start = {${v}.*};\nResult = SELECT t FROM Start:s -(${e}:e)- :t LIMIT ${LIMIT};\nPRINT Result;`,
        ),
      ];
    },
    errors: ERROR_RULES.gsql,
    notes: { time: "help.source.gsql.time", variables: "help.source.gsql.variables" },
    tip: "help.source.gsql.tip",
    docs: "tigergraph",
    steps: true,
  };
})();

// ---------------------------------------------------------------------------------------------
// Files, HTTP JSON and plugin kinds: no query language to learn.

const noLanguage = (
  id: string,
  family: EditorFamily,
  language: string,
  prefix: "file" | "http" | "plugin",
  docs: string,
  starters: readonly Starter[],
): SourceGuide => ({
  id,
  family,
  language,
  holds: `help.source.${prefix}.holds` as MessageKey,
  pick: null,
  starters,
  actions: {},
  cheats: () => [],
  errors: ERROR_RULES[prefix],
  notes: {
    time: `help.source.${prefix}.time` as MessageKey,
    variables: `help.source.${prefix}.variables` as MessageKey,
  },
  tip: `help.source.${prefix}.tip` as MessageKey,
  docs,
  steps: prefix !== "plugin",
});

const fileGuide = noLanguage("file", "file", "CSV / JSON", "file", "csv-and-json-files", [
  { id: "read", title: "help.starter.file.read", build: () => ({}) },
]);
const httpGuide = noLanguage("http_json", "http", "HTTP JSON", "http", "http-json", [
  { id: "read", title: "help.starter.http.read", build: () => ({}) },
]);
/** Kinds a plugin adds: the plugin defines its query form, so the guide explains only that. */
export const PLUGIN_GUIDE = noLanguage("plugin", "plugin", "JSON", "plugin", "", []);

/** Every built-in kind's guide; a test checks that each kind the server registers has one. */
export const SOURCE_GUIDES = defineRegistry<SourceGuide>("source guides", [
  sqlGuide("postgres"),
  sqlGuide("mysql"),
  sqlGuide("sqlite"),
  sqlGuide("mssql"),
  sqlGuide("clickhouse"),
  promGuide,
  influxGuide,
  lokiGuide,
  searchGuide,
  fileGuide,
  httpGuide,
  mongoGuide,
  cypherGuide("neo4j"),
  cypherGuide("memgraph"),
  gsqlGuide,
]);

/** The guide of a kind: its own, the plugin guide for a plugin's kind, else none. */
export function guideFor(kind: string): SourceGuide | undefined {
  return SOURCE_GUIDES.get(kind) ?? (familyOf(kind) === "plugin" ? PLUGIN_GUIDE : undefined);
}

/** The guide's link into docs/guide/query-languages.md. */
export function guideDocs(guide: SourceGuide): string {
  return guide.docs === "" ? QUERY_GUIDE_URL : `${QUERY_GUIDE_URL}#${guide.docs}`;
}

/** The objects a guide's picker offers, from all the schema's objects. */
export function pickable(guide: SourceGuide, objects: readonly SchemaObject[]): SchemaObject[] {
  const kinds = guide.pick?.kinds ?? [];
  return objects.filter((o) => kinds.includes(o.kind));
}
