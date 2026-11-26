import { describe, expect, it } from "vitest";
import { filterQuery, filtersKind, lokiFilter, luceneFilter } from "./filters";
import type { LogField } from "./model";

const label = (key: string, text: string): LogField => ({
  key,
  path: `labels.${key}`,
  value: text,
  text,
  origin: "label",
});
const fromLine = (key: string, text: string): LogField => ({
  key,
  path: key,
  value: text,
  text,
  origin: "line",
});
const docField = (key: string, path: string, value: unknown): LogField => ({
  key,
  path,
  value,
  text: typeof value === "string" ? value : JSON.stringify(value),
  origin: "document",
});

describe("filter to query: LogQL", () => {
  it("appends a label filter for a stream label, = to keep and != to leave out", () => {
    expect(lokiFilter('{app="api"} |= "order"', label("host", "web-3"), "include", false)).toEqual({
      logql: '{app="api"} |= "order" | host = "web-3"',
    });
    expect(lokiFilter('{app="api"}', label("host", "web-3"), "exclude", false)).toEqual({
      logql: '{app="api"} | host != "web-3"',
    });
  });

  it("adds the parser a field of the line needs, visibly, once", () => {
    expect(lokiFilter('{app="api"}', fromLine("order", "48213"), "include", false)).toEqual({
      logql: '{app="api"} | logfmt | order = "48213"',
    });
    expect(lokiFilter('{app="api"}', fromLine("items.sku", "KL-20"), "include", true)).toEqual({
      logql: '{app="api"} | json | items_sku = "KL-20"',
    });
    expect(
      lokiFilter('{app="api"} | logfmt | order = "1"', fromLine("psp", "adyen"), "exclude", false),
    ).toEqual({ logql: '{app="api"} | logfmt | order = "1" | psp != "adyen"' });
  });

  it("escapes quotes and backslashes in values", () => {
    expect(lokiFilter('{a="b"}', label("q", 'say "hi" \\ bye'), "include", false)).toEqual({
      logql: '{a="b"} | q = "say \\"hi\\" \\\\ bye"',
    });
  });

  it("starts a new line after a comment, which would swallow the filter", () => {
    expect(lokiFilter('{a="b"} # only api', label("host", "x"), "include", false)).toEqual({
      logql: '{a="b"} # only api\n| host = "x"',
    });
  });

  it("refuses metric queries and names LogQL cannot write", () => {
    expect(lokiFilter('rate({a="b"}[1m])', label("host", "x"), "include", false)).toEqual({
      refused: "metric",
    });
    expect(lokiFilter('{a="b"}', label("1st", "x"), "include", false)).toEqual({ refused: "key" });
  });

  it("keeps the rest of the query form as it was", () => {
    expect(
      filterQuery("loki", { logql: '{a="b"}', limit: 500 }, label("host", "x"), "include", false),
    ).toEqual({ query: { logql: '{a="b"} | host = "x"', limit: 500 } });
  });
});

describe("filter to query: Lucene and MongoDB", () => {
  it("joins a quoted Lucene clause with AND, AND NOT, and parentheses around OR", () => {
    const host = docField("host", "_source.host", "web-3");
    expect(luceneFilter("", host, "include")).toEqual({ lucene: 'host:"web-3"' });
    expect(luceneFilter("*", host, "exclude")).toEqual({ lucene: 'NOT host:"web-3"' });
    expect(luceneFilter("status:500", host, "include")).toEqual({
      lucene: '(status:500) AND host:"web-3"',
    });
    // query_string's default operator is OR: without parentheses AND would bind to "b" alone.
    expect(luceneFilter("a b", host, "include")).toEqual({ lucene: '(a b) AND host:"web-3"' });
    expect(luceneFilter("a OR b", host, "exclude")).toEqual({
      lucene: '(a OR b) AND NOT host:"web-3"',
    });
    expect(luceneFilter("", docField("log.level", "_source.log.level", 'a"b'), "include")).toEqual({
      lucene: 'log.level:"a\\"b"',
    });
  });

  it("leaves a Query DSL body alone", () => {
    expect(
      filterQuery(
        "elasticsearch",
        { dsl: { query: {} } },
        docField("h", "_source.h", "x"),
        "include",
        false,
      ),
    ).toEqual({ refused: "dsl" });
  });

  it("adds a MongoDB condition, $nin to leave a value out", () => {
    const outcome = filterQuery(
      "mongodb",
      { collection: "audit", filter: "{}" },
      docField("outcome", "outcome", "denied"),
      "exclude",
      false,
    );
    expect(outcome).toEqual({
      query: { collection: "audit", filter: '{"outcome": {"$nin":["denied"]}}' },
    });
  });

  it("knows which kinds take filters", () => {
    expect(["loki", "elasticsearch", "mongodb"].every(filtersKind)).toBe(true);
    expect(filtersKind("postgres")).toBe(false);
    expect(filterQuery("postgres", { sql: "" }, label("a", "b"), "include", false)).toEqual({
      refused: "kind",
    });
  });

  it("refuses objects and lists as values", () => {
    expect(luceneFilter("", docField("o", "_source.o", { a: 1 }), "include")).toEqual({
      refused: "value",
    });
    const list = docField("tags", "tags", ["a", "b"]);
    expect(luceneFilter("", list, "include")).toEqual({ refused: "value" });
    expect(lokiFilter('{a="b"}', { ...list, origin: "line" }, "include", true)).toEqual({
      refused: "value",
    });
    expect(
      filterQuery("mongodb", { collection: "audit", filter: "{}" }, list, "include", false),
    ).toEqual({ refused: "value" });
  });

  it("refuses Lucene names with range signs", () => {
    for (const key of ["a>b", "a<b", "a=b"]) {
      expect(luceneFilter("", docField(key, `_source.${key}`, "x"), "include")).toEqual({
        refused: "key",
      });
    }
  });
});
