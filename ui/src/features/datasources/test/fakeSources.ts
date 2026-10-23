import type {
  DocumentSet,
  QueryItem,
  QueryOutcome,
  TimeRange,
} from "../../../api/generated/shapes";
import { serverSchema } from "./fakeMongo";

/**
 * Elasticsearch/OpenSearch, CSV/JSON file and HTTP JSON sources for the fake server, written from
 * docs/api/datasources.md: each query form exactly as documented (`{lucene | dsl, index?,
 * timeField?, size?}`, `{}`, `{path?, params?, documentsPath?}`), with the server's reasons for
 * what it refuses.
 */

export const ES_ID = "ds-es";
export const FILE_ID = "ds-file";
export const HTTP_ID = "ds-http";

interface Source {
  id: string;
  kind: string;
  settings: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rejected(message: string, reason: string, params: Record<string, string> = {}) {
  return { error: { code: "query_rejected" as const, message, reason, params } };
}

const invalidForm = (detail: string) =>
  rejected(`the query does not fit this data source: ${detail}`, "query.invalid_form", { detail });

const DSL_KEYS = new Set([
  "query",
  "aggs",
  "aggregations",
  "sort",
  "_source",
  "fields",
  "docvalue_fields",
  "stored_fields",
  "size",
  "from",
  "track_total_hits",
  "search_after",
  "highlight",
  "post_filter",
  "min_score",
  "script_fields",
  "runtime_mappings",
  "collapse",
  "terminate_after",
  "track_scores",
  "version",
  "seq_no_primary_term",
  "indices_boost",
  "rescore",
]);

function indexValid(index: string): boolean {
  return index.split(",").every((part) => {
    const name = part.startsWith("-") ? part.slice(1) : part;
    return (
      /^[A-Za-z0-9._\-*:]+$/.test(name) && !name.startsWith("_") && name !== "." && name !== ".."
    );
  });
}

/** The hits of the fake index, newest first. */
export const FAKE_HITS = [
  { _index: "logs-2026.03", _id: "a1", _score: 1, _source: { land: "AT", status: 500 } },
  { _index: "logs-2026.03", _id: "a2", _score: 1, _source: { land: "CH", status: 200 } },
];

/** The rows of the fake CSV file and the documents of the fake JSON sources. */
export const FAKE_FILE_ROWS = [
  { region: "Nord", amount: 120.5 },
  { region: "Süd", amount: 98 },
];

function documents(docs: unknown[], executedQuery: string): QueryOutcome {
  const set: DocumentSet = {
    documents: docs,
    schema: serverSchema(docs),
    notices: [],
    executedQuery,
  };
  return { result: { shape: "documents", documents: set } };
}

function searchOutcome(source: Source, query: Record<string, unknown>): QueryOutcome {
  const extra = Object.keys(query).find(
    (key) => !["index", "lucene", "dsl", "timeField", "size"].includes(key),
  );
  if (extra !== undefined) {
    return invalidForm(`unknown field \`${extra}\``);
  }
  if (query.lucene !== undefined && query.dsl !== undefined) {
    return rejected("send either lucene or dsl, not both", "elasticsearch.query_form");
  }
  const index =
    typeof query.index === "string" && query.index.trim() !== ""
      ? query.index
      : typeof source.settings.index === "string" && source.settings.index !== ""
        ? source.settings.index
        : undefined;
  if (index === undefined) {
    return rejected("name an index", "elasticsearch.index_missing");
  }
  if (!indexValid(index)) {
    return rejected("the index is not valid", "elasticsearch.index_invalid", { index });
  }
  if (query.dsl !== undefined) {
    if (!isObject(query.dsl)) {
      return rejected("Query DSL must be an object", "elasticsearch.dsl_not_object");
    }
    const key = Object.keys(query.dsl).find((name) => !DSL_KEYS.has(name));
    if (key !== undefined) {
      return rejected(`${key} is not allowed`, "elasticsearch.dsl_key_not_allowed", { key });
    }
    const aggs = query.dsl.aggs ?? query.dsl.aggregations;
    if (isObject(aggs)) {
      const [name = "agg"] = Object.keys(aggs);
      return {
        result: {
          shape: "frame",
          frame: {
            fields: [
              { name, type: "string", values: ["AT", "CH"] },
              { name: "doc_count", type: "number", values: [12, 7] },
            ],
            meta: { executedQuery: JSON.stringify(query.dsl), rowsTruncated: false, notices: [] },
          },
        },
      };
    }
  }
  const size = typeof query.size === "number" ? query.size : 500;
  return documents(FAKE_HITS.slice(0, size), JSON.stringify(query));
}

function httpOutcome(query: Record<string, unknown>, variables: Record<string, unknown>) {
  const extra = Object.keys(query).find(
    (key) => !["path", "params", "documentsPath"].includes(key),
  );
  if (extra !== undefined) {
    return invalidForm(`unknown field \`${extra}\``);
  }
  const path = typeof query.path === "string" ? query.path : "";
  if (
    path.startsWith("/") ||
    path.includes("?") ||
    path.split("/").some((s) => s.startsWith(".."))
  ) {
    return rejected("the path must be relative", "http_json.path_invalid");
  }
  for (const [name, value] of Object.entries(isObject(query.params) ? query.params : {})) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      return rejected(`the parameter ${name} is not valid`, "http_json.param_invalid", { name });
    }
    const variable = typeof value === "string" ? /^\$\{?(\w+)\}?$/.exec(value)?.[1] : undefined;
    if (variable !== undefined && !(variable in variables)) {
      return rejected(`variable ${variable} has no value`, "http_json.variable_missing", {
        name: variable,
      });
    }
  }
  return documents(structuredClone(FAKE_FILE_ROWS), `GET ${path}`);
}

/**
 * Answers a query of one of these kinds as the server would; undefined for other kinds. The
 * time range is not used: the fake data has no times.
 */
export function sourceOutcome(
  source: Source,
  item: QueryItem,
  _range: TimeRange,
  variables: Record<string, unknown>,
): QueryOutcome | undefined {
  const query = item.query;
  if (!["elasticsearch", "file", "http_json"].includes(source.kind)) {
    return undefined;
  }
  if (!isObject(query)) {
    return invalidForm("the query is not an object");
  }
  if (source.kind === "elasticsearch") {
    return searchOutcome(source, query);
  }
  if (source.kind === "http_json") {
    return httpOutcome(query, variables);
  }
  const extra = Object.keys(query)[0];
  if (extra !== undefined) {
    return invalidForm(`unknown field \`${extra}\``);
  }
  const path = String(source.settings.path ?? "");
  if (/\.(json|ndjson|jsonl)$/i.test(path)) {
    return documents(structuredClone(FAKE_FILE_ROWS), path);
  }
  return {
    result: {
      shape: "frame",
      frame: {
        fields: [
          { name: "region", type: "string", values: FAKE_FILE_ROWS.map((r) => r.region) },
          { name: "amount", type: "number", values: FAKE_FILE_ROWS.map((r) => r.amount) },
        ],
        meta: { executedQuery: path, rowsTruncated: false, notices: [] },
      },
    },
  };
}

/** The schema answers of the three sources, in the documented wire shapes. */
export const FAKE_SOURCE_SCHEMAS: Record<string, unknown> = {
  [ES_ID]: {
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
  },
  [FILE_ID]: {
    kind: "tables",
    tables: [
      {
        name: "sales.csv",
        columns: [
          { name: "region", type: "string" },
          { name: "amount", type: "number" },
        ],
      },
    ],
  },
  [HTTP_ID]: {
    kind: "fields",
    fields: [{ path: "region", coverage: 1, types: [{ name: "string", share: 1 }] }],
  },
};

/** The three sources, as stored, for `addSourceKinds`. */
export function sourceKindSources(created: number) {
  const common = { secrets: {}, createdAt: created, updatedAt: created };
  return [
    {
      id: ES_ID,
      name: "Logs search",
      kind: "elasticsearch",
      settings: { url: "https://search.internal:9200", index: "logs-*", timeField: "@timestamp" },
      ...common,
    },
    {
      id: FILE_ID,
      name: "Sales file",
      kind: "file",
      settings: { path: "/data/files/sales.csv", format: "csv", delimiter: "semicolon" },
      ...common,
    },
    {
      id: HTTP_ID,
      name: "Orders API",
      kind: "http_json",
      settings: { url: "https://api.internal/v1/", documentsPath: "data.items" },
      ...common,
    },
  ];
}
