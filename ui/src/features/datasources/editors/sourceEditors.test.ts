import { describe, expect, it } from "vitest";
import type { IndicesSchema } from "../api";
import { emptyQuery, familyOf, hasQuery, queryText } from "../queryKinds";
import { paramsOf, rowProblem, rowsOf } from "./HttpJsonQueryEditor";
import { httpQueryText, parseHttpQuery, pathProblem, requestUrl, variableName } from "./httpQuery";
import { searchTemplate } from "./SearchQueryEditor";
import { dslCompletions, luceneCompletions, searchFields } from "./searchCompletion";
import {
  dslProblem,
  hasAggregations,
  indexMatches,
  indexProblem,
  isSearchQuery,
  parseSearchQuery,
  sizeProblem,
} from "./searchQuery";
import { tokenizeLucene } from "./syntax";

// The schema answer of an Elasticsearch source (docs/api/datasources.md, "Schema").
const INDICES: IndicesSchema = {
  kind: "indices",
  indices: [
    {
      name: "logs-2026.03",
      columns: [
        { name: "@timestamp", type: "date" },
        { name: "land", type: "keyword" },
        { name: "status", type: "long" },
      ],
    },
    { name: "metrics-2026.03", columns: [{ name: "cpu", type: "float" }] },
  ],
};
const FIELDS = searchFields(INDICES, "logs-*");
const labels = (result: { options: { label: string }[] } | null) =>
  result?.options.map((o) => o.label);

describe("query kinds of the search, file and HTTP JSON sources", () => {
  it("chooses the editor family by kind and starts with the documented empty form", () => {
    expect(familyOf("elasticsearch")).toBe("search");
    expect(familyOf("file")).toBe("file");
    expect(familyOf("http_json")).toBe("http");
    expect(emptyQuery("elasticsearch")).toEqual({ lucene: "" });
    expect(emptyQuery("file")).toEqual({});
    expect(emptyQuery("http_json")).toEqual({});
  });

  it("counts {} and an empty search as runnable, and empty text forms as not", () => {
    // With the kind: what that kind's server accepts.
    expect(hasQuery({}, "file")).toBe(true);
    expect(hasQuery({ sql: "" }, "file")).toBe(false);
    expect(hasQuery({}, "http_json")).toBe(true);
    expect(hasQuery({ path: "orders", params: { a: 1 } }, "http_json")).toBe(true);
    expect(hasQuery({ lucene: "" }, "elasticsearch")).toBe(true);
    expect(hasQuery({ lucene: "a", dsl: {} }, "elasticsearch")).toBe(false);
    expect(hasQuery({}, "postgres")).toBe(false);
    expect(hasQuery({ sql: " " }, "postgres")).toBe(false);
    // Without it (a stored panel target): told by the fields.
    expect(hasQuery({})).toBe(true);
    expect(hasQuery({ lucene: "" })).toBe(true);
    expect(hasQuery({ dsl: { query: { match_all: {} } } })).toBe(true);
    expect(hasQuery({ sql: "" })).toBe(false);
    expect(hasQuery({ expr: "up" })).toBe(true);
    expect(hasQuery({ collection: "", pipeline: "[]" })).toBe(false);
    expect(hasQuery(null)).toBe(false);
  });

  it("summarizes the new forms in one line", () => {
    expect(queryText({ lucene: "status:500" })).toBe("status:500");
    expect(queryText({ dsl: { size: 1 } })).toBe('{"size":1}');
    expect(queryText({ path: "orders", params: { land: "$land" } })).toBe("orders?land=$land");
    expect(httpQueryText(parseHttpQuery({}))).toBe("");
  });
});

describe("search query", () => {
  it("reads only the documented fields, with their types", () => {
    expect(
      parseSearchQuery({ index: "logs-*", lucene: "a", size: 10, timeField: "", sql: "x" }),
    ).toEqual({ index: "logs-*", lucene: "a", size: 10, timeField: "" });
    expect(parseSearchQuery({ dsl: { query: {} }, size: -1, index: " " })).toEqual({
      dsl: { query: {} },
    });
    expect(isSearchQuery({ index: "a", lucene: "" })).toBe(true);
    expect(isSearchQuery({ sql: "" })).toBe(false);
  });

  it("checks index names by the server's rule", () => {
    for (const ok of ["logs-*", "logs-*,metrics-*,-logs-alt", "remote:logs", ".hidden-ok"]) {
      expect(indexProblem(ok), ok).toBeNull();
    }
    for (const bad of ["_all", "logs/_delete_by_query", "..", "a,,b", "remote:_x", "a b"]) {
      expect(indexProblem(bad)?.reason, bad).toBe("elasticsearch.index_invalid");
    }
    expect(indexProblem("x y")?.params).toEqual({ index: "x y" });
  });

  it("checks the body's top-level keys against the server's list", () => {
    expect(dslProblem({ query: {}, sort: [], _source: ["a"], aggs: {} })).toBeNull();
    expect(dslProblem([])?.reason).toBe("elasticsearch.dsl_not_object");
    expect(dslProblem({ script: {} })).toEqual({
      reason: "elasticsearch.dsl_key_not_allowed",
      params: { key: "script" },
    });
    expect(hasAggregations({ aggs: { a: {} } })).toBe(true);
    expect(hasAggregations({ aggregations: { a: {} } })).toBe(true);
    expect(hasAggregations({ query: {} })).toBe(false);
  });

  it("accepts sizes from 1 to 10,000", () => {
    expect(sizeProblem("")).toBe(false);
    expect(sizeProblem("100")).toBe(false);
    expect(sizeProblem("10000")).toBe(false);
    expect(sizeProblem("10001")).toBe(true);
    expect(sizeProblem("0")).toBe(true);
    expect(sizeProblem("1.5")).toBe(true);
  });

  it("matches index patterns as the cluster does", () => {
    expect(indexMatches("logs-*", "logs-2026.03")).toBe(true);
    expect(indexMatches("logs-*,-logs-2026.03", "logs-2026.03")).toBe(false);
    expect(indexMatches("metrics-*", "logs-2026.03")).toBe(false);
    expect(FIELDS.map((f) => f.name)).toEqual(["@timestamp", "land", "status"]);
    expect(searchFields(INDICES, undefined).map((f) => f.name)).toContain("cpu");
  });

  it("completes field names and keywords in Lucene, and the time macros", () => {
    expect(labels(luceneCompletions("la", 2, FIELDS))).toEqual(["land"]);
    expect(labels(luceneCompletions("status:500 A", 12, FIELDS))).toEqual(["AND"]);
    expect(labels(luceneCompletions("ts:>$__t", 8, FIELDS))).toEqual(["$__timeFrom", "$__timeTo"]);
    // Inside a phrase is text to match.
    expect(luceneCompletions('"la', 3, FIELDS)).toBeNull();
  });

  it("completes Query DSL by position: keys, clauses, fields, aggregations, macros", () => {
    const at = (text: string) => labels(dslCompletions(text, text.length, FIELDS, true));
    expect(at('{"')).toContain("aggs");
    expect(at('{"query": {"')).toContain("bool");
    expect(at('{"query": {"bool": {"')).toEqual([
      "must",
      "filter",
      "should",
      "must_not",
      "minimum_should_match",
    ]);
    expect(at('{"query": {"term": {"')).toEqual(["@timestamp", "land", "status"]);
    expect(at('{"aggs": {"n": {"terms": {"field": "l')).toEqual(["land"]);
    expect(at('{"aggs": {"n": {"')).toContain("date_histogram");
    expect(at('{"sort": [{"')).toContain("@timestamp");
    expect(at('{"_source": ["s')).toEqual(["status"]);
    expect(at('{"aggs": {"t": {"date_histogram": {"fixed_interval": "$__i')).toEqual([
      "$__interval",
      "$__interval_ms",
    ]);
  });

  it("fills the templates with the index's time and keyword fields", () => {
    expect(searchTemplate("latest", "@timestamp", FIELDS)).toEqual({
      query: { match_all: {} },
      sort: [{ "@timestamp": { order: "desc" } }],
      _source: ["land", "status"],
    });
    expect(searchTemplate("termsOverTime", "ts", FIELDS)).toEqual({
      aggs: {
        time: {
          date_histogram: { field: "ts", fixed_interval: "$__interval" },
          aggs: { land: { terms: { field: "land", size: 10 } } },
        },
      },
    });
    // Every template passes the server's key check.
    for (const name of ["latest", "terms", "histogram", "termsOverTime"] as const) {
      expect(dslProblem(searchTemplate(name, "", FIELDS))).toBeNull();
    }
  });

  it("highlights Lucene: keywords, field names, phrases and macros", () => {
    const tokens = tokenizeLucene('land:"AT" AND ts:>$__timeFrom');
    expect(tokens.find((t) => t.text === "land")?.kind).toBe("label");
    expect(tokens.find((t) => t.text === '"AT"')?.kind).toBe("string");
    expect(tokens.find((t) => t.text === "AND")?.kind).toBe("keyword");
    expect(tokens.find((t) => t.text === "$__timeFrom")?.kind).toBe("macro");
    expect(tokens.map((t) => t.text).join("")).toBe('land:"AT" AND ts:>$__timeFrom');
  });
});

describe("HTTP JSON query", () => {
  it("reads only the documented fields", () => {
    expect(
      parseHttpQuery({ path: "a", params: { x: 1, y: null, z: true }, documentsPath: "", m: 1 }),
    ).toEqual({ path: "a", params: { x: 1, z: true } });
  });

  it("refuses paths the server refuses", () => {
    for (const ok of ["", "orders/open", "v1/items.json", "a/b..c"]) {
      expect(pathProblem(ok), ok).toBe(false);
    }
    for (const bad of [
      "/orders",
      "../admin",
      "a/./b",
      "a/..;/b",
      "a?b=1",
      "a#x",
      "http://evil",
      "a%2e%2e/b",
      "a%2F",
      "a\\b",
    ]) {
      expect(pathProblem(bad), bad).toBe(true);
    }
  });

  it("previews the requested URL below the source's URL, keeping its query", () => {
    expect(
      requestUrl("https://api.intern/v1", { path: "orders/open", params: { land: "$land" } }),
    ).toBe("https://api.intern/v1/orders/open?land=$land");
    expect(requestUrl("https://api.intern/v1/?key=1", { params: { n: 2 } })).toBe(
      "https://api.intern/v1/?key=1&n=2",
    );
    expect(requestUrl(undefined, {})).toBeUndefined();
    expect(variableName(`$${"{"}land}`)).toBe("land");
    expect(variableName("$land")).toBe("land");
    expect(variableName("a$land")).toBeNull();
  });

  it("keeps only complete parameter rows, typed as the server takes them", () => {
    const rows = [
      { key: 0, name: "land", type: "text" as const, value: "$land" },
      { key: 1, name: "limit", type: "number" as const, value: "10" },
      { key: 2, name: "open", type: "bool" as const, value: "false" },
      { key: 3, name: "", type: "text" as const, value: "" },
      { key: 4, name: "bad", type: "number" as const, value: "ten" },
      { key: 5, name: "land", type: "text" as const, value: "AT" },
    ];
    expect(rowProblem(rows[3] as never, rows)).toBeNull();
    expect(rowProblem(rows[4] as never, rows)).toBe("number");
    expect(rowProblem(rows[5] as never, rows)).toBe("duplicate");
    expect(paramsOf(rows)).toEqual({ limit: 10, open: false });
    expect(rowsOf({ a: 1, b: true, c: "x" }).map((r) => r.type)).toEqual([
      "number",
      "bool",
      "text",
    ]);
  });
});
