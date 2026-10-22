import type {
  DocumentSet,
  FieldSchema,
  QueryItem,
  QueryOutcome,
} from "../../../api/generated/shapes";

/**
 * The MongoDB part of the data source fake, written from docs/api/datasources.md ("MongoDB: a
 * pipeline or find", "The documents shape"): the query form with its texts of Extended JSON, the
 * refusals the UI shows (`mongodb.json_invalid`, `mongodb.write_stage`, ...), and a small
 * evaluator for the stages the UI's tests use: `$match` with equality on dotted paths (arrays
 * match by element, Extended JSON values typed), `$sort`, `$skip`, `$limit`, `$project` by
 * inclusion. Other reading stages pass documents through.
 */

const oid = (n: number) => ({
  $type: "objectId",
  value: `665f1c2e9b1e4a0001a1b0${String(n).padStart(2, "0")}`,
});
/** Dates arrive as Unix milliseconds in text. */
const date = (iso: string) => ({ $type: "date", value: String(Date.parse(iso)) });

/** A small orders collection with typed values, nesting, arrays and two outliers. */
export function fakeOrders(): Record<string, unknown>[] {
  return [
    {
      _id: oid(1),
      createdAt: date("2026-10-01T08:00:00.000Z"),
      status: "paid",
      total: { $type: "decimal", value: "129.90" },
      views: { $type: "int64", value: "9007199254740993" },
      customer: { name: "Ada", address: { city: "Wien" } },
      items: [
        { sku: "A-1", price: 19.9, qty: 2 },
        { sku: "B-2", price: 90.1, qty: 1 },
      ],
      tags: ["new", "eu"],
      rating: 5,
    },
    {
      _id: oid(2),
      createdAt: date("2026-10-02T09:30:00.000Z"),
      status: "open",
      total: { $type: "decimal", value: "15.00" },
      views: { $type: "int64", value: "12" },
      customer: { name: "Grace", address: { city: "Graz" } },
      items: [{ sku: "A-1", price: 15, qty: 1 }],
      tags: [],
      rating: "good",
    },
    {
      _id: oid(3),
      createdAt: date("2026-10-03T12:00:00.000Z"),
      status: "paid",
      total: { $type: "decimal", value: "42.50" },
      views: { $type: "int64", value: "7" },
      customer: { name: "Linus" },
      items: [{ sku: "C-3", price: 42.5, qty: 1 }],
      tags: ["eu"],
      rating: 4,
      attachment: { $type: "binary", value: null },
    },
  ];
}

export const FAKE_MONGO_COLLECTIONS = (): Record<string, Record<string, unknown>[]> => ({
  orders: fakeOrders(),
});

const FIELDS = ["collection", "pipeline", "filter", "projection", "sort", "skip", "limit"];
const FIND_FIELDS = ["filter", "projection", "sort", "skip", "limit"];
/** The reading stages the server allows. */
const STAGES = new Set([
  "$addFields",
  "$bucket",
  "$bucketAuto",
  "$count",
  "$densify",
  "$facet",
  "$fill",
  "$geoNear",
  "$graphLookup",
  "$group",
  "$limit",
  "$lookup",
  "$match",
  "$project",
  "$redact",
  "$replaceRoot",
  "$replaceWith",
  "$sample",
  "$search",
  "$searchMeta",
  "$set",
  "$setWindowFields",
  "$skip",
  "$sort",
  "$sortByCount",
  "$unionWith",
  "$unset",
  "$unwind",
  "$vectorSearch",
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rejected(message: string, reason: string, params: Record<string, string> = {}) {
  return { error: { code: "query_rejected" as const, message, reason, params } };
}

interface Parsed {
  collection: string;
  pipeline?: Record<string, unknown>[];
  filter: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  skip: number;
  limit?: number;
}

/** The query read as the server reads it, or its rejection. */
export function parseMongo(query: unknown): Parsed | QueryOutcome {
  if (!isObject(query)) {
    return rejected("the query is not an object", "query.invalid_form", {
      detail: "not an object",
    });
  }
  const extra = Object.keys(query).find((key) => !FIELDS.includes(key));
  if (extra !== undefined) {
    return rejected(`unknown field ${extra}`, "query.invalid_form", {
      detail: `unknown field ${extra}`,
    });
  }
  if (typeof query.collection !== "string" || query.collection.trim() === "") {
    return rejected("collection is required", "query.invalid_form", { detail: "collection" });
  }
  const name = query.collection;
  if (name.startsWith("system.")) {
    return rejected(`${name} is a system collection`, "mongodb.system_collection", { name });
  }
  // Collection names hold neither `$` nor a NUL character, and are at most 255 bytes long.
  if (/[$\0]/.test(name) || new TextEncoder().encode(name).length > 255) {
    return rejected(`${name} is not a collection name`, "mongodb.collection_invalid", { name });
  }
  for (const field of ["pipeline", "filter", "projection", "sort"]) {
    if (query[field] !== undefined && typeof query[field] !== "string") {
      // Objects instead of text are refused: text keeps the key order.
      return rejected(`${field} must be text`, "query.invalid_form", { detail: field });
    }
  }
  if (query.pipeline !== undefined && FIND_FIELDS.some((field) => query[field] !== undefined)) {
    return rejected("pipeline together with find fields", "mongodb.pipeline_and_find");
  }
  const json = (field: string): { value: unknown } | { refused: QueryOutcome } => {
    try {
      return { value: JSON.parse(String(query[field])) };
    } catch (problem) {
      return {
        refused: rejected(`${field} is not valid Extended JSON`, "mongodb.json_invalid", {
          field,
          detail: String(problem),
        }),
      };
    }
  };
  const parsed: Parsed = { collection: query.collection, filter: {}, skip: 0 };
  if (typeof query.pipeline === "string") {
    const read = json("pipeline");
    if ("refused" in read) return read.refused;
    const stages = read.value;
    if (!Array.isArray(stages)) {
      return rejected("the pipeline is not an array", "mongodb.pipeline_not_array");
    }
    for (const stage of stages) {
      const keys = isObject(stage) ? Object.keys(stage) : [];
      const name = keys[0] ?? "";
      if (keys.length !== 1 || !name.startsWith("$")) {
        return rejected("a stage has exactly one stage name", "mongodb.stage_invalid");
      }
      if (name === "$out" || name === "$merge") {
        return rejected(`${name} writes data`, "mongodb.write_stage", { stage: name });
      }
      if (!STAGES.has(name)) {
        return rejected(`${name} is not allowed`, "mongodb.stage_not_allowed", { stage: name });
      }
    }
    parsed.pipeline = stages as Record<string, unknown>[];
    return parsed;
  }
  for (const field of ["filter", "projection", "sort"] as const) {
    if (typeof query[field] !== "string" || (query[field] as string).trim() === "") {
      continue;
    }
    const read = json(field);
    if ("refused" in read) return read.refused;
    if (!isObject(read.value)) {
      return rejected(`${field} is not a document`, "mongodb.not_a_document", { field });
    }
    parsed[field] = read.value;
  }
  if (typeof query.skip === "number") parsed.skip = query.skip;
  if (typeof query.limit === "number") parsed.limit = query.limit;
  return parsed;
}

/** A value as a comparable key: typed values and Extended JSON of the same value agree. */
function keyOf(value: unknown): string {
  if (isObject(value)) {
    if (typeof value.$type === "string" && "value" in value) {
      return `${value.$type}:${String(value.value)}`;
    }
    if (typeof value.$oid === "string") return `objectId:${value.$oid}`;
    if (isObject(value.$date) && typeof value.$date.$numberLong === "string") {
      return `date:${value.$date.$numberLong}`;
    }
    if (typeof value.$date === "string") return `date:${Date.parse(value.$date)}`;
    if (typeof value.$numberDecimal === "string") return `decimal:${value.$numberDecimal}`;
    if (typeof value.$numberLong === "string") return `int64:${value.$numberLong}`;
  }
  return `json:${JSON.stringify(value)}`;
}

/** Values at a dotted path, MongoDB style: a name on an array looks into every element. */
function resolve(document: unknown, path: string): unknown[] {
  let current: unknown[] = [document];
  for (const part of path.split(".")) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        if (/^\d+$/.test(part)) {
          next.push(value[Number(part)]);
        } else {
          for (const element of value) {
            if (isObject(element) && part in element) next.push(element[part]);
          }
        }
      } else if (isObject(value) && part in value) {
        next.push(value[part]);
      }
    }
    current = next;
  }
  return current.flatMap((value) => (Array.isArray(value) ? [value, ...value] : [value]));
}

function matches(document: unknown, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([path, condition]) => {
    const wanted = isObject(condition) && "$eq" in condition ? condition.$eq : condition;
    return resolve(document, path).some((value) => keyOf(value) === keyOf(wanted));
  });
}

function sortable(value: unknown): number | string {
  if (typeof value === "number") return value;
  if (isObject(value) && typeof value.value === "string") {
    const n = Number(value.value);
    return Number.isFinite(n) ? n : value.value;
  }
  return String(value);
}

function sortBy(documents: unknown[], sort: Record<string, unknown>): unknown[] {
  const [[path, direction] = ["", 1]] = Object.entries(sort);
  const sign = direction === -1 ? -1 : 1;
  return [...documents].sort((a, b) => {
    const x = sortable(resolve(a, path)[0]);
    const y = sortable(resolve(b, path)[0]);
    return x < y ? -sign : x > y ? sign : 0;
  });
}

function project(documents: unknown[], projection: Record<string, unknown>): unknown[] {
  const keep = Object.keys(projection).filter(
    (key) => projection[key] === 1 || projection[key] === true,
  );
  if (keep.length === 0) {
    return documents;
  }
  return documents.map((document) =>
    Object.fromEntries(
      Object.entries(document as Record<string, unknown>).filter(
        ([key]) => key === "_id" || keep.includes(key),
      ),
    ),
  );
}

/** Documents a page holds when the request sets no limit, as `datasources.max_rows` would. */
export const FAKE_PAGE = 1000;

/** The type alias the server names a stored value by (the documents shape's table, read back). */
function alias(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (isObject(value) && typeof value.$type === "string" && "value" in value) {
    const named: Record<string, string> = {
      int64: "long",
      uuid: "binData",
      binary: "binData",
      document: "object",
    };
    return named[value.$type] ?? value.$type;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? "int" : "double";
  }
  if (typeof value === "boolean") return "bool";
  return typeof value === "string" ? "string" : "object";
}

/**
 * The schema as the server samples it (docs/api/datasources.md, "The documents shape"), written
 * from the docs rather than from the UI: the first 1,000 documents, at most 2,000 paths and 32
 * levels, paths in first appearance, coverage per document, and per type alias the share of the
 * documents with the path where it has that type.
 */
export function serverSchema(documents: readonly unknown[]): FieldSchema[] {
  const sample = documents.slice(0, 1000);
  const order: string[] = [];
  const withPath = new Map<string, number>();
  const typed = new Map<string, Map<string, number>>();
  for (const document of sample) {
    const found = new Map<string, Set<string>>();
    const visit = (value: unknown, path: string, depth: number) => {
      if (path !== "") {
        if (!found.has(path)) found.set(path, new Set());
        found.get(path)?.add(alias(value));
      }
      if (depth >= 32) return;
      const inner =
        isObject(value) && value.$type === "document" && isObject(value.value)
          ? value.value
          : value;
      if (Array.isArray(inner)) {
        for (const element of inner) visit(element, `${path}[]`, depth + 1);
      } else if (isObject(inner) && !(typeof inner.$type === "string" && "value" in inner)) {
        for (const [key, child] of Object.entries(inner)) {
          visit(child, path === "" ? key : `${path}.${key}`, depth + 1);
        }
      }
    };
    visit(document, "", 0);
    for (const [path, types] of found) {
      if (!withPath.has(path)) {
        if (order.length >= 2000) continue;
        order.push(path);
        typed.set(path, new Map());
      }
      withPath.set(path, (withPath.get(path) ?? 0) + 1);
      const counts = typed.get(path) as Map<string, number>;
      for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return order.map((path) => {
    const documentsWithPath = withPath.get(path) ?? 0;
    return {
      path,
      coverage: sample.length === 0 ? 0 : documentsWithPath / sample.length,
      types: [...(typed.get(path) ?? new Map<string, number>())]
        .map(([name, count]) => ({ name, share: count / documentsWithPath }))
        .sort((a, b) => b.share - a.share),
    };
  });
}

/** Runs a query in the documented form against the fake collections. */
export function mongoOutcome(
  item: QueryItem,
  collections: Record<string, Record<string, unknown>[]>,
): QueryOutcome {
  const parsed = parseMongo(item.query);
  if ("error" in parsed || "result" in parsed) {
    return parsed;
  }
  // The fake's cursor is the offset where the next page starts.
  const offset = item.cursor === undefined ? 0 : Number(item.cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    return rejected("the cursor does not belong to this query", "mongodb.cursor_invalid");
  }
  let documents: unknown[] = structuredClone(collections[parsed.collection] ?? []);
  if (parsed.pipeline === undefined) {
    documents = documents.filter((d) => matches(d, parsed.filter));
    if (parsed.sort !== undefined) documents = sortBy(documents, parsed.sort);
    documents = documents.slice(parsed.skip);
    if (parsed.projection !== undefined) documents = project(documents, parsed.projection);
    if (parsed.limit !== undefined) documents = documents.slice(0, parsed.limit);
  } else {
    for (const stage of parsed.pipeline) {
      const [[name, argument] = ["", null]] = Object.entries(stage);
      if (name === "$match" && isObject(argument)) {
        documents = documents.filter((d) => matches(d, argument));
      } else if (name === "$limit" && typeof argument === "number") {
        documents = documents.slice(0, argument);
      } else if (name === "$skip" && typeof argument === "number") {
        documents = documents.slice(argument);
      } else if (name === "$sort" && isObject(argument)) {
        documents = sortBy(documents, argument);
      } else if (name === "$project" && isObject(argument)) {
        documents = project(documents, argument);
      }
    }
  }
  const limit = item.limit ?? FAKE_PAGE;
  const rest = documents.slice(offset);
  const page = rest.slice(0, limit);
  const cut = rest.length > page.length;
  // As the server answers: notices and the executed query beside the documents; a cut set says
  // how many it holds and continues from `nextCursor`.
  const set = {
    documents: page,
    schema: serverSchema(page),
    notices: cut
      ? [
          {
            severity: "warning",
            code: "documents.limit",
            params: { limit: String(page.length) },
            text: `cut off at ${page.length} documents`,
          },
        ]
      : [],
    executedQuery: `${parsed.collection}.${parsed.pipeline === undefined ? "find" : "aggregate"}(...)`,
    ...(cut ? { truncated: { limit: page.length }, nextCursor: String(offset + page.length) } : {}),
  };
  return { result: { shape: "documents", documents: set as DocumentSet } };
}
