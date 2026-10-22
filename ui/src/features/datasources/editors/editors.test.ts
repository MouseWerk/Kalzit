import { describe, expect, it } from "vitest";
import type { GraphSourceSchema, PromSchema, SqlSchema } from "../api";
import { emptyQuery, parseGsqlQuery, queryText } from "../queryKinds";
import { cypherCompletions, promqlCompletions, sqlCompletions } from "./completion";
import { gsqlTemplate, parseParams } from "./GsqlQueryEditor";
import { tokenizeCypher, tokenizeGsql, tokenizePromql, tokenizeSql } from "./syntax";

// Wire shapes of GET .../schema in docs/api/datasources.md.
const SQL: SqlSchema = {
  kind: "tables",
  tables: [
    {
      schema: "public",
      name: "orders",
      columns: [
        { name: "id", type: "bigint" },
        { name: "amount", type: "numeric" },
      ],
    },
    { name: "customers", columns: [{ name: "name", type: "text" }] },
  ],
};

const PROM: PromSchema = {
  kind: "metrics",
  metrics: ["http_requests_total", "up"],
  labels: ["instance", "job", "status"],
};

const labels = (result: ReturnType<typeof sqlCompletions>) => result?.options.map((o) => o.label);

describe("SQL completion", () => {
  it("offers tables, keywords and the columns of tables in the query", () => {
    const text = "SELECT am FROM orders";
    expect(labels(sqlCompletions(text, 9, SQL))).toEqual(["amount"]);
    expect(labels(sqlCompletions("SELECT * FROM or", 16, SQL))).toEqual(["orders", "OR", "ORDER"]);
  });

  it("completes columns after a table name or alias and a dot", () => {
    const text = "SELECT o. FROM orders o";
    const result = sqlCompletions(text, 9, SQL);
    expect(labels(result)).toEqual(["id", "amount"]);
    expect(result?.options[0]?.detail).toBe("bigint");
    expect(result?.from).toBe(9);
    expect(labels(sqlCompletions("SELECT customers.n", 18, SQL))).toEqual(["name"]);
  });

  it("offers the macros after a dollar sign, and nothing for an empty word unless asked", () => {
    expect(labels(sqlCompletions("WHERE $__time", 13, SQL))).toEqual([
      "$__timeFilter",
      "$__timeFrom",
      "$__timeTo",
    ]);
    expect(sqlCompletions("SELECT ", 7, SQL)).toBeNull();
    expect(sqlCompletions("SELECT ", 7, SQL, true)?.options.length).toBeGreaterThan(0);
  });

  it("works without a schema", () => {
    expect(labels(sqlCompletions("sel", 3, undefined))).toEqual(["SELECT"]);
  });
});

describe("PromQL completion", () => {
  it("offers metrics and functions", () => {
    expect(labels(promqlCompletions("http", 4, PROM))).toEqual(["http_requests_total"]);
    expect(labels(promqlCompletions("ra", 2, PROM))).toEqual(["rate"]);
  });

  it("offers the labels of the metric inside braces, and nothing inside a value", () => {
    // The schema has one label list for the whole source.
    expect(labels(promqlCompletions("http_requests_total{", 20, PROM))).toEqual([
      "instance",
      "job",
      "status",
    ]);
    expect(labels(promqlCompletions('up{instance="a", j', 18, PROM))).toEqual(["job"]);
    expect(promqlCompletions('up{instance="lo', 15, PROM)).toBeNull();
  });

  it("offers durations inside brackets", () => {
    expect(labels(promqlCompletions("rate(up[5", 9, PROM))).toEqual(["5m"]);
    expect(labels(promqlCompletions("rate(up[$__ra", 13, PROM))).toEqual(["$__rate_interval"]);
  });
});

// The graph kinds' schema answer: property keys for the whole source.
const GRAPH: GraphSourceSchema = {
  kind: "graph",
  labels: ["Customer", "Product"],
  edgeTypes: ["BOUGHT", "REVIEWED"],
  propertyKeys: ["name", "price"],
  queries: [],
};

describe("Cypher completion", () => {
  it("offers labels in node patterns and edge types in edge patterns", () => {
    expect(labels(cypherCompletions("MATCH (c:Cu", 11, GRAPH))).toEqual(["Customer"]);
    expect(labels(cypherCompletions("MATCH (:", 8, GRAPH))).toEqual(["Customer", "Product"]);
    expect(labels(cypherCompletions("MATCH (c)-[:B", 13, GRAPH))).toEqual(["BOUGHT"]);
    expect(labels(cypherCompletions("MATCH (c)-[:BOUGHT|R", 20, GRAPH))).toEqual(["REVIEWED"]);
    expect(labels(cypherCompletions("MATCH (c)-[r]->(p:P", 19, GRAPH))).toEqual(["Product"]);
  });

  it("offers property keys after a dot and in a pattern's braces, not as labels in a map", () => {
    expect(labels(cypherCompletions("MATCH (c) RETURN c.n", 20, GRAPH))).toEqual(["name"]);
    expect(labels(cypherCompletions("MATCH (c {", 10, GRAPH))).toEqual(["name", "price"]);
    expect(cypherCompletions("MATCH (c {name:", 15, GRAPH)).toBeNull();
  });

  it("offers macros, keywords and functions", () => {
    expect(labels(cypherCompletions("WHERE t > $__timeF", 18, GRAPH))).toEqual([
      "$__timeFrom",
      "$__timeFromMs",
    ]);
    expect(labels(cypherCompletions("re", 2, GRAPH))).toEqual([
      "RETURN",
      "relationships",
      "replace",
    ]);
    expect(cypherCompletions("MATCH ", 6, GRAPH)).toBeNull();
    expect(labels(cypherCompletions("ma", 2, undefined))).toEqual(["MATCH", "max"]);
  });
});

describe("highlighting", () => {
  const samples = [
    "SELECT o.id, 'it''s' AS x -- note\nFROM orders o WHERE $__timeFilter(created_at) AND n > 1.5e3 /* c",
    'sum by (job) (rate(http_requests_total{status=~"5.."}[5m])) # errors',
    "",
    "Grüße → 日本",
  ];

  it.each(samples)("keeps every character exactly once: %s", (text) => {
    expect(
      tokenizeSql(text)
        .map((t) => t.text)
        .join(""),
    ).toBe(text);
    expect(
      tokenizePromql(text)
        .map((t) => t.text)
        .join(""),
    ).toBe(text);
    expect(
      tokenizeCypher(text)
        .map((t) => t.text)
        .join(""),
    ).toBe(text);
  });

  it("colors Cypher clauses, labels, parameters, strings and comments", () => {
    const tokens = tokenizeCypher(
      "MATCH (c:Customer)-[:`HAS ORDER`]->(o) // note\nWHERE c.name = 'x' AND o.at > $__timeFrom RETURN count(o)",
    );
    const kind = (text: string) => tokens.find((t) => t.text.trim() === text)?.kind;
    expect(kind("MATCH")).toBe("keyword");
    expect(kind(":Customer")).toBe("label");
    expect(kind(":`HAS ORDER`")).toBe("label");
    expect(kind("// note")).toBe("comment");
    expect(kind("'x'")).toBe("string");
    expect(kind("$__timeFrom")).toBe("macro");
    expect(kind("count")).toBe("function");
    // A keyword as a property name is not a keyword.
    expect(tokenizeCypher("RETURN n.count").find((t) => t.text === "count")?.kind).toBe("plain");
  });

  it("tells keywords, strings, comments and macros apart", () => {
    const kinds = Object.fromEntries(
      tokenizeSql("SELECT 'a' -- c\n$__timeFrom").map((t) => [t.text.trim(), t.kind]),
    );
    expect(kinds).toMatchObject({
      SELECT: "keyword",
      "'a'": "string",
      "-- c": "comment",
      $__timeFrom: "macro",
    });
    const prom = tokenizePromql('rate(up{job="x"}[5m])');
    expect(prom.find((t) => t.text === "rate")?.kind).toBe("function");
    expect(prom.find((t) => t.text === "job")?.kind).toBe("label");
    expect(prom.find((t) => t.text === "5m")?.kind).toBe("duration");
  });
});

describe("TigerGraph queries", () => {
  it("start as interpreted GSQL and keep the installed form with its params", () => {
    expect(emptyQuery("tigergraph")).toEqual({ gsql: "" });
    expect(parseGsqlQuery({ installed: "q", params: { a: 1 } })).toEqual({
      installed: "q",
      params: { a: 1 },
    });
    expect(parseGsqlQuery({ gsql: "x", params: [1] })).toEqual({ gsql: "x" });
    expect(queryText({ installed: "q" })).toBe("q");
  });

  it("read params as a JSON object only", () => {
    expect(parseParams("")).toEqual({});
    expect(parseParams('{"a": 1}')).toEqual({ params: { a: 1 } });
    expect(parseParams("[1]")).toEqual({ error: true });
    expect(parseParams("{")).toEqual({ error: true });
  });

  it("highlight GSQL and start from one query body for the graph", () => {
    const text = gsqlTemplate("social");
    expect(text).toMatch(/^INTERPRET QUERY \(\) FOR GRAPH social \{/);
    const tokens = tokenizeGsql(`${text} // c\nSELECT s FROM Start:s ACCUM @@n += 1`);
    expect(tokens.map((t) => t.text).join("")).toBe(
      `${text} // c\nSELECT s FROM Start:s ACCUM @@n += 1`,
    );
    const kind = (word: string) => tokens.find((t) => t.text === word)?.kind;
    expect(kind("INTERPRET")).toBe("keyword");
    expect(kind("ACCUM")).toBe("keyword");
    expect(kind("@@n")).toBe("macro");
    expect(kind("// c")).toBe("comment");
  });
});
