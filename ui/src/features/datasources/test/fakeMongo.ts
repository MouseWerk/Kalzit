import type { QueryItem, QueryOutcome } from "../../../api/generated/shapes";
import { sampleSchema } from "../../../documents/schema";

/**
 * The MongoDB part of the data source fake: the query form of the `mongodb` kind (written from
 * features/datasources/mongoQuery.ts until docs/api/datasources.md documents it), the write
 * refusal for `$out` and `$merge`, and a small evaluator for the stages the UI's tests use:
 * `$match` with equality on dotted paths (arrays match by element, Extended JSON values typed),
 * `$sort`, `$skip`, `$limit`, `$project` by inclusion. Other stages pass documents through.
 */

const oid = (n: number) => ({
  $type: "objectId",
  value: `665f1c2e9b1e4a0001a1b0${String(n).padStart(2, "0")}`,
});
const date = (iso: string) => ({ $type: "date", value: iso });

/** A small orders collection with every typed value, nesting, arrays and two outliers. */
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
    },
  ];
}

export const FAKE_MONGO_COLLECTIONS = (): Record<string, Record<string, unknown>[]> => ({
  orders: fakeOrders(),
});

const QUERY_FIELDS = {
  aggregate: ["collection", "mode", "pipeline", "disabledStages", "toFrame"],
  find: ["collection", "mode", "filter", "projection", "sort", "limit", "toFrame"],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The rejection of a query that does not fit the form, or null. */
export function mongoQueryProblem(query: unknown): QueryOutcome | null {
  const rejected = (
    message: string,
    reason = "query.invalid_form",
    params?: Record<string, string>,
  ) => ({
    error: {
      code: "query_rejected" as const,
      message,
      reason,
      params: params ?? { detail: message },
    },
  });
  if (!isObject(query)) {
    return rejected("the query is not an object");
  }
  const mode = query.mode;
  if (mode !== "aggregate" && mode !== "find") {
    return rejected("mode is aggregate or find");
  }
  const extra = Object.keys(query).find((key) => !QUERY_FIELDS[mode].includes(key));
  if (extra !== undefined) {
    return rejected(`unknown query field ${extra}`);
  }
  if (typeof query.collection !== "string" || query.collection.trim() === "") {
    return rejected("collection is required");
  }
  if (mode === "find") {
    if (!isObject(query.filter)) return rejected("filter is an object");
    if (query.projection !== undefined && !isObject(query.projection))
      return rejected("projection");
    if (query.sort !== undefined && !isObject(query.sort)) return rejected("sort");
    if (
      query.limit !== undefined &&
      !(Number.isInteger(query.limit) && (query.limit as number) > 0)
    ) {
      return rejected("limit");
    }
    return null;
  }
  if (!Array.isArray(query.pipeline)) {
    return rejected("pipeline is a list of stages");
  }
  for (const stage of query.pipeline) {
    const keys = isObject(stage) ? Object.keys(stage) : [];
    if (keys.length !== 1 || !(keys[0] ?? "").startsWith("$")) {
      return rejected("a stage has exactly one operator");
    }
    if (keys[0] === "$out" || keys[0] === "$merge") {
      return rejected(`${keys[0]} writes data`, "mongo.write_stage", { stage: keys[0] });
    }
  }
  return null;
}

/** A value as a comparable key: typed values and Extended JSON of the same value agree. */
function keyOf(value: unknown): string {
  if (isObject(value)) {
    if (typeof value.$type === "string" && typeof value.value === "string") {
      return value.$type === "date"
        ? `date:${Date.parse(value.value)}`
        : `${value.$type}:${value.value}`;
    }
    if (typeof value.$oid === "string") return `objectId:${value.$oid}`;
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

function numberOf(value: unknown): number | string {
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
    const x = numberOf(resolve(a, path)[0]);
    const y = numberOf(resolve(b, path)[0]);
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

/** Runs a query in the documented form against the fake collections. */
export function mongoOutcome(
  item: QueryItem,
  collections: Record<string, Record<string, unknown>[]>,
): QueryOutcome {
  const query = item.query as Record<string, unknown>;
  let documents: unknown[] = structuredClone(collections[String(query.collection)] ?? []);
  if (query.mode === "find") {
    documents = documents.filter((d) => matches(d, query.filter as Record<string, unknown>));
    if (isObject(query.sort)) documents = sortBy(documents, query.sort);
    if (isObject(query.projection)) documents = project(documents, query.projection);
    if (typeof query.limit === "number") documents = documents.slice(0, query.limit);
  } else {
    for (const stage of query.pipeline as Record<string, unknown>[]) {
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
  const limit = item.limit;
  const truncated = limit !== undefined && documents.length > limit;
  if (truncated) {
    documents = documents.slice(0, limit);
  }
  return {
    result: {
      shape: "documents",
      documents: {
        documents,
        schema: sampleSchema(documents),
        ...(truncated ? { truncated: { limit } } : {}),
      },
    },
  };
}
