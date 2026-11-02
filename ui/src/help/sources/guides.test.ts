import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tokenizeLogql, tokenizePromql } from "../../features/datasources/editors/syntax";
import { hasQuery, queryText } from "../../features/datasources/queryKinds";
import { en } from "../../i18n/catalogs";
import type { MessageKey } from "../../i18n/i18n";
import { ERROR_RULES, hintFor, problemOf } from "./errors";
import {
  attempt,
  cypherName,
  type GuideContext,
  guideFor,
  luceneName,
  OBJECT_ACTIONS,
  PLUGIN_GUIDE,
  SOURCE_GUIDES,
  type SourceGuide,
  sqlName,
  sqlText,
} from "./guides";
import type { SchemaObject } from "./objects";
import { groupStepAsSql } from "./steps";

const SERVER = resolve(import.meta.dirname, "../../../../server");

/** The kinds the server registers (`KindRegistry::built_in`), read from its source. */
function serverKinds(): string[] {
  const registry = readFileSync(resolve(SERVER, "src/datasources/registry.rs"), "utf8");
  const list = registry.slice(registry.indexOf("for kind in ["), registry.indexOf("] {"));
  return [...list.matchAll(/super::(\w+)::(\w+)\(\)/g)].map(([, module = "", fn = ""]) => {
    if (fn !== "kind") {
      return fn;
    }
    const file = [`src/datasources/${module}.rs`, `src/datasources/${module}/mod.rs`]
      .map((path) => resolve(SERVER, path))
      .find(existsSync);
    const source = readFileSync(file ?? "", "utf8");
    const named = /fn kind\(&self\) -> &'static str \{\s*"([^"]+)"/.exec(source);
    return named?.[1] ?? `${module}?`;
  });
}

const table = (name: string, fields: [string, string][], schema?: string): SchemaObject => ({
  kind: "table",
  name,
  schema,
  fields: fields.map(([n, type]) => ({ name: n, type })),
});

/**
 * Names that break a query unless they are quoted or escaped: quotes of every kind, a backslash
 * (also at the end), a space, a reserved word and text that would end a statement.
 */
const HOSTILE = ['a"b', "a`b", "x\\", "Order Items", "User", "x; DROP TABLE y"];
const hostileFields = (types: string[]) =>
  HOSTILE.map((name, i) => ({ name, type: types[i % types.length] ?? "" }));

/** A small schema per kind, as the source would answer it, for building every query. */
const SAMPLES: Record<string, SchemaObject[]> = {
  sql: [
    table("orders", [
      ["id", "bigint"],
      ["created_at", "timestamp"],
      ["status", "text"],
      ["amount", "numeric"],
      ["customer_id", "bigint"],
    ]),
    table("customers", [
      ["customer_id", "bigint"],
      ["name", "text"],
    ]),
  ],
  promql: [
    { kind: "metric", name: "http_requests_total", fields: [{ name: "job", type: "label" }] },
  ],
  influx: [
    table("cpu", [
      ["time", "time"],
      ["usage_user", "float"],
      ["host", "string"],
    ]),
  ],
  logql: [{ kind: "label", name: "job", fields: [{ name: "api", type: "value" }] }],
  search: [
    {
      kind: "index",
      name: "logs",
      fields: [
        { name: "@timestamp", type: "date" },
        { name: "status", type: "keyword" },
        { name: "bytes", type: "long" },
      ],
    },
  ],
  mongo: [
    {
      kind: "collection",
      name: "orders",
      fields: [
        { name: "createdAt", type: "date" },
        { name: "status", type: "string" },
        { name: "total", type: "double" },
      ],
    },
    { kind: "collection", name: "customers", fields: [{ name: "name", type: "string" }] },
  ],
  cypher: [
    { kind: "nodeLabel", name: "Person", fields: [{ name: "name", type: "" }] },
    { kind: "edgeType", name: "KNOWS", fields: [{ name: "name", type: "" }] },
  ],
  gsql: [
    { kind: "nodeLabel", name: "Person", fields: [{ name: "name", type: "" }] },
    { kind: "edgeType", name: "KNOWS", fields: [{ name: "name", type: "" }] },
    { kind: "installed", name: "top_customers", fields: [] },
  ],
};

const HOSTILE_SAMPLES: Record<string, SchemaObject[]> = {
  sql: [
    {
      kind: "table",
      name: "Order Items",
      schema: "Sales Data",
      fields: [{ name: "Created At", type: "timestamp" }, ...hostileFields(["text", "numeric"])],
    },
    { kind: "table", name: "User", fields: [{ name: "select", type: "text" }] },
    { kind: "table", name: "x; DROP TABLE y", fields: [{ name: "id", type: "bigint" }] },
    { kind: "table", name: "x\\", fields: hostileFields(["text"]) },
  ],
  promql: [
    { kind: "metric", name: "http.requests", fields: [{ name: "my.label", type: "label" }] },
  ],
  influx: [{ kind: "table", name: 'cpu "load"\\', fields: hostileFields(["float", "string"]) }],
  logql: [
    { kind: "label", name: "app", fields: [{ name: 'a"b\\', type: "value" }] },
    { kind: "label", name: "my.label", fields: [{ name: "x", type: "value" }] },
  ],
  search: [
    {
      kind: "index",
      name: "logs-hostile",
      fields: [{ name: "x\\", type: "date" }, ...hostileFields(["keyword", "long"])],
    },
  ],
  mongo: [
    {
      kind: "collection",
      name: "Order Items",
      fields: [{ name: "User", type: "date" }, ...hostileFields(["string", "double"])],
    },
  ],
  cypher: [
    { kind: "nodeLabel", name: "Order Items", fields: hostileFields([""]) },
    { kind: "nodeLabel", name: "match", fields: [{ name: "User", type: "" }] },
    { kind: "edgeType", name: "a`b", fields: [] },
  ],
  gsql: [{ kind: "nodeLabel", name: "Order Items", fields: hostileFields([""]) }],
};
for (const [family, objects] of Object.entries(HOSTILE_SAMPLES)) {
  SAMPLES[family] = [...(SAMPLES[family] ?? []), ...objects];
}

function contextOf(guide: SourceGuide): GuideContext {
  const objects = SAMPLES[guide.family] ?? [];
  const kinds = guide.pick?.kinds ?? [];
  return { object: objects.find((o) => kinds.includes(o.kind)), objects, graph: "shop" };
}

interface Built {
  kind: string;
  id: string;
  query: unknown;
}

/**
 * Every query a guide can put into the editor, for the sample schema: the starters and cheat
 * sheet with each object picked in turn, and the actions of every object. A query that needs a
 * name the source cannot take is left out, as in Explore (`attempt`).
 */
function built(guide: SourceGuide): Built[] {
  const context = contextOf(guide);
  const kinds = guide.pick?.kinds ?? [];
  const picks = context.objects.filter((o) => kinds.includes(o.kind));
  const out: Built[] = [];
  const add = (id: string, query: unknown) => {
    if (query !== null && !out.some((b) => JSON.stringify(b.query) === JSON.stringify(query))) {
      out.push({ kind: guide.id, id, query });
    }
  };
  for (const object of picks.length === 0 ? [undefined] : picks) {
    const picked = { ...context, object };
    const at = object === undefined ? "" : ` for ${object.name}`;
    for (const starter of guide.starters) {
      add(
        `starter.${starter.id}${at}`,
        attempt(() => starter.build(picked)),
      );
    }
    for (const snippet of attempt(() => guide.cheats(picked)) ?? []) {
      if (snippet.value !== undefined) add(`cheat.${snippet.id}${at}`, snippet.value);
    }
  }
  for (const object of context.objects) {
    for (const action of OBJECT_ACTIONS) {
      const build = guide.actions[action];
      if (build !== undefined)
        add(
          `${action}.${object.name}`,
          attempt(() => build(object, context)),
        );
    }
  }
  return out;
}

const guides = SOURCE_GUIDES.all();
const all = guides.flatMap(built);
const FIXTURE = resolve(SERVER, "tests/fixtures/guide_queries.json");

describe("source guides", () => {
  it("cover every kind the server registers, and plugin kinds", () => {
    const kinds = serverKinds();
    expect(kinds.length).toBeGreaterThanOrEqual(15);
    expect(kinds.filter((kind) => SOURCE_GUIDES.get(kind) === undefined)).toEqual([]);
    expect(guideFor("com.example.weather")).toBe(PLUGIN_GUIDE);
    expect(guideFor("nothing")).toBeUndefined();
  });

  it("name only texts that are in the catalogs", () => {
    const keys: string[] = [];
    for (const guide of [...guides, PLUGIN_GUIDE]) {
      keys.push(guide.holds, guide.notes.time, guide.notes.variables, guide.tip);
      if (guide.pick !== null) keys.push(guide.pick.label);
      keys.push(...guide.starters.map((s) => s.title));
      for (const snippet of guide.cheats(contextOf(guide))) {
        for (const text of [snippet.title, snippet.text]) {
          if (typeof text === "string") keys.push(text);
        }
      }
      for (const rule of guide.errors) {
        keys.push(rule.hint, ...(rule.plain === undefined ? [] : [rule.plain]));
      }
    }
    expect(keys.filter((key) => !(key in en))).toEqual([]);
  });

  it.each(guides.map((g) => [g.id, g] as const))(
    "%s: has starters, and a cheat sheet when it has a language",
    (_, guide) => {
      expect(guide.starters.length).toBeGreaterThanOrEqual(1);
      if (guide.pick !== null) {
        expect(guide.starters.length).toBeGreaterThanOrEqual(3);
        expect(guide.cheats(contextOf(guide)).length).toBeGreaterThanOrEqual(5);
      }
    },
  );

  it("fill in only queries the editor can run as they are", () => {
    for (const { kind, id, query } of all) {
      expect(hasQuery(query, kind), `${kind} ${id}`).toBe(true);
    }
  });

  it("only read, with a limit, a count or the time range", () => {
    const writes =
      /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|MERGE|TRUNCATE|GRANT|DETACH|REMOVE)\b|\bSET\s|\$out|\$merge|to\(bucket/i;
    for (const { kind, id, query } of all) {
      // The hostile sample name holds a DROP as text; the server checks that it stays a name.
      const text = JSON.stringify(query).replaceAll("x; DROP TABLE y", "");
      expect(writes.test(text), `${kind} ${id}: ${text}`).toBe(false);
      const family = guideFor(kind)?.family;
      const code = queryText(query);
      if (family === "sql" || family === "cypher" || family === "gsql") {
        expect(
          // A count is one row; an installed query is the source's own, run by name.
          /\bLIMIT\b|\bTOP\b|count\(|COUNT\(|pragma_table_info|SumAccum/i.test(code) ||
            "installed" in (query as object),
          `${kind} ${id} has no limit: ${code}`,
        ).toBe(true);
      }
      if (family === "mongo") {
        expect(/\$limit|\$count/.test(text), `${kind} ${id}: ${text}`).toBe(true);
      }
      if (family === "logql" && !/count_over_time|rate\(/.test(code)) {
        expect((query as { limit?: number }).limit, `${kind} ${id}`).toBeLessThanOrEqual(1000);
      }
    }
  });

  it("hold no host, address or credential", () => {
    const text = JSON.stringify(guides.map((guide) => [guide.id, built(guide)]));
    expect(text).not.toMatch(/https?:\/\/|password|passwd|secret|token|apikey|@[a-z0-9-]+\./i);
  });

  it("write PromQL and LogQL the editor's highlighter reads without errors", () => {
    for (const { kind, id, query } of all) {
      const family = guideFor(kind)?.family;
      const tokenize =
        family === "promql" ? tokenizePromql : family === "logql" ? tokenizeLogql : null;
      if (tokenize === null) continue;
      const code = queryText(query);
      // Balanced brackets of each kind; the server checks the rest when it runs.
      for (const [open, close] of ["()", "[]", "{}"]) {
        const count = (c: string | undefined) => code.split(c ?? "").length - 1;
        expect(count(open), `${kind} ${id}: ${code}`).toBe(count(close));
      }
      expect(
        tokenize(code)
          .map((t) => t.text)
          .join(""),
        `${kind} ${id}`,
      ).toBe(code);
    }
  });

  // The server parses each of these with the checker of its kind
  // (server/src/datasources/guide_queries.rs); this keeps the copy it reads current.
  it("are the queries the server's parser test checks", () => {
    const fixture = `${JSON.stringify(all, null, 2)}\n`;
    if (process.env.KALZIT_UPDATE_GUIDE_QUERIES === "1") {
      writeFileSync(FIXTURE, fixture);
    }
    expect(readFileSync(FIXTURE, "utf8").replaceAll("\r\n", "\n")).toBe(fixture);
  });
});

describe("quoting", () => {
  it("quotes SQL names that are not plain lower case, and reserved words, per dialect", () => {
    expect(sqlName("postgres", "orders")).toBe("orders");
    expect(sqlName("postgres", "Orders")).toBe('"Orders"');
    expect(sqlName("postgres", "user")).toBe('"user"');
    expect(sqlName("postgres", 'a"b')).toBe('"a""b"');
    expect(sqlName("mysql", "a`b")).toBe("`a``b`");
    expect(sqlName("mssql", "a]b")).toBe("[a]]b]");
    expect(sqlName("sqlite", "x; DROP TABLE y")).toBe('"x; DROP TABLE y"');
    // ClickHouse refuses a backslash in a quoted name: the query is left out instead.
    expect(attempt(() => sqlName("clickhouse", "x\\"))).toBeNull();
  });

  it("escapes string literals as each dialect reads them", () => {
    expect(sqlText("postgres", "it's\\")).toBe("'it''s\\'");
    expect(sqlText("mysql", "it's\\")).toBe("'it''s\\\\'");
    expect(sqlText("clickhouse", "x\\")).toBe("'x\\\\'");
  });

  it("quotes Cypher names and escapes Lucene field names", () => {
    expect(cypherName("Person")).toBe("Person");
    expect(cypherName("match")).toBe("`match`");
    expect(cypherName("a`b")).toBe("`a``b`");
    expect(luceneName("user name")).toBe("user\\ name");
    expect(luceneName("a:b\\")).toBe("a\\:b\\\\");
  });

  it("covers the hostile names in the queries the server checks", () => {
    const text = JSON.stringify(all);
    for (const kind of [
      "postgres",
      "mysql",
      "sqlite",
      "mssql",
      "neo4j",
      "mongodb",
      "influxdb",
      "prometheus",
    ]) {
      const own = JSON.stringify(all.filter((b) => b.kind === kind));
      expect(own, kind).toMatch(/Order Items|a\\\\"b|http\.requests|load/);
    }
    expect(text).toContain("DROP TABLE y");
  });
});

describe("error hints", () => {
  const sql = ERROR_RULES.sql;
  it.each([
    ['relation "ordrs" does not exist', "help.hint.unknownTable", "ordrs"],
    ["no such table: ordrs", "help.hint.unknownTable", "ordrs"],
    ["Table 'shop.ordrs' doesn't exist", "help.hint.unknownTable", "shop.ordrs"],
    ["Invalid object name 'ordrs'.", "help.hint.unknownTable", "ordrs"],
    ['column "amout" does not exist', "help.hint.unknownColumn", "amout"],
    ["Unknown column 'amout' in 'field list'", "help.hint.unknownColumn", "amout"],
    ['syntax error at or near "FORM"', "help.hint.syntax", "FORM"],
    ["Incorrect syntax near 'FORM'.", "help.hint.syntax", "FORM"],
  ])("reads %s", (message, text, name) => {
    const hint = hintFor(sql, { code: "datasource_error", reason: "source.error", message });
    expect(hint?.text).toBe(text);
    expect(hint?.params).toEqual({ name });
  });

  it("derives hints from reason codes, and none from an unknown error", () => {
    expect(
      hintFor(sql, { code: "query_rejected", reason: "sql.not_select", message: "" })?.text,
    ).toBe("help.hint.readOnly");
    expect(
      hintFor(sql, {
        code: "query_rejected",
        reason: "sql.variable_missing",
        message: "",
        params: { name: "region" },
      })?.params,
    ).toEqual({ name: "region" });
    expect(
      hintFor(sql, { code: "query_rejected", reason: "sql.parse_error", message: "x" })?.text,
    ).toBe("help.hint.syntaxPlain");
    expect(
      hintFor(sql, { code: "datasource_error", reason: "source.error", message: "boom" }),
    ).toBeNull();
    expect(
      hintFor(ERROR_RULES.cypher, { code: "datasource_error", message: "Invalid input 'RETRUN'" })
        ?.params,
    ).toEqual({ name: "RETRUN" });
    expect(
      hintFor(ERROR_RULES.logql, {
        code: "datasource_error",
        message:
          "parse error : queries require at least one regexp or equality matcher that does not have an empty-compatible value",
      })?.text,
    ).toBe("help.hint.logqlSelector");
  });

  it("reads an error body and an API error alike", () => {
    expect(problemOf({ code: "query_rejected", reason: "sql.not_select", message: "m" })).toEqual({
      code: "query_rejected",
      reason: "sql.not_select",
      message: "m",
      params: undefined,
    });
    const api = {
      code: "query_rejected",
      body: { error: { code: "query_rejected", message: "n", reason: "x.y" } },
    };
    expect(problemOf(api)?.reason).toBe("x.y");
    expect(problemOf("text")).toBeNull();
  });

  it("names texts that are in the catalogs", () => {
    const keys = Object.values(ERROR_RULES).flatMap((rules) =>
      rules.flatMap((rule) => [rule.hint, ...(rule.plain === undefined ? [] : [rule.plain])]),
    );
    expect(keys.filter((key: MessageKey) => !(key in en))).toEqual([]);
  });
});

describe("the query behind a group step", () => {
  const group = {
    id: "s1",
    type: "group" as const,
    frame: "A",
    by: ["status"],
    aggregations: [
      { field: "amount", op: "sum" as const },
      { field: "id", op: "count" as const, name: "n" },
    ],
  };

  it("wraps the query and groups it as the step does", () => {
    expect(groupStepAsSql([group], "SELECT * FROM orders LIMIT 100;", "postgres")).toEqual({
      stepId: "s1",
      sql: 'SELECT status, SUM(amount) AS "sum(amount)", COUNT(*) AS n\nFROM (\n  SELECT * FROM orders LIMIT 100\n) AS q\nGROUP BY status\nORDER BY status\nLIMIT 1000',
    });
    expect(groupStepAsSql([group], "SELECT TOP 100 * FROM orders", "mssql")?.sql).toMatch(
      /^SELECT TOP 1000 status/,
    );
  });

  it("shows nothing for steps SQL does not say the same way", () => {
    const median = { ...group, aggregations: [{ field: "amount", op: "median" as const }] };
    expect(groupStepAsSql([median], "SELECT 1", "postgres")).toBeNull();
    expect(groupStepAsSql([{ ...group, disabled: true }], "SELECT 1", "postgres")).toBeNull();
    expect(groupStepAsSql([group], "", "postgres")).toBeNull();
  });
});
