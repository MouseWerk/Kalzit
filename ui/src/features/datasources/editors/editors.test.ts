import { describe, expect, it } from "vitest";
import type { PromSchema, SqlSchema } from "../api";
import { promqlCompletions, sqlCompletions } from "./completion";
import { tokenizePromql, tokenizeSql } from "./syntax";

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
