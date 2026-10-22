import { describe, expect, it } from "vitest";
import { projectOutcomes } from "../features/dashboards/results";
import { jsonContext, mongoCompletions } from "../features/datasources/editors/mongoCompletion";
import { tokenizeJson } from "../features/datasources/editors/syntax";
import {
  addMatch,
  joinPipeline,
  modeOf,
  mongoQueryText,
  parseMongoQuery,
  previewQuery,
  splitPipeline,
} from "../features/datasources/mongoQuery";
import { distribution, histogram } from "./distribution";
import { filterable, toExtendedJson } from "./filter";
import { filterPath, mongoPath, schemaPath, valueAt, valuesAt } from "./paths";
import { projectDocuments, projectionFor, withProjection } from "./projection";
import { outliersOf, sampleSchema, schemaOf } from "./schema";
import { entriesOf, formatLeaf, isTyped, typeOf, unwrap } from "./values";

const oid = { $type: "objectId", value: "665f1c2e9b1e4a0001a1b001" };
/** Dates arrive as Unix milliseconds in text. */
const WHEN_MS = Date.parse("2026-10-01T08:00:00.000Z");
const when = { $type: "date", value: String(WHEN_MS) };
/** An emoji as a field name, built at run time: the sources themselves stay free of emoji. */
const SMILE = String.fromCodePoint(0x1f642);
const big = { $type: "int64", value: "9007199254740993" };
const price = { $type: "decimal", value: "129.90" };

const docs = [
  { _id: oid, at: when, n: big, total: price, items: [{ p: 1 }, { p: 2 }], tags: ["a"], größe: 1 },
  { _id: oid, at: when, items: [{ p: 3 }], tags: [], größe: "groß", [SMILE]: true },
];

describe("values", () => {
  it("keeps database types and tells them from a field named $type", () => {
    expect(typeOf(oid)).toBe("objectId");
    expect(typeOf({ $type: "x", value: "y", more: 1 })).toBe("object");
    expect(typeOf([1])).toBe("array");
    expect(typeOf(null)).toBe("null");
    expect(typeOf(1.5)).toBe("number");
    expect(formatLeaf(big, "en")).toBe("9,007,199,254,740,993");
    expect(formatLeaf(price, "de")).toBe("129.90");
    expect(formatLeaf(when, "en")).toContain("10/1/26");
    // Hidden binary data has no value; a NaN double keeps its text.
    expect(isTyped({ $type: "binary", value: null })).toBe(true);
    expect(formatLeaf({ $type: "double", value: "NaN" }, "en")).toBe("NaN");
  });

  it("opens a stored document with its own $type key as the document it is", () => {
    const wrapped = { $type: "document", value: { $type: "rule", value: "x", level: 2 } };
    expect(isTyped(wrapped)).toBe(false);
    expect(typeOf(wrapped)).toBe("object");
    expect(unwrap(wrapped)).toEqual({ $type: "rule", value: "x", level: 2 });
    expect(entriesOf(wrapped).map(([key]) => key)).toEqual(["$type", "value", "level"]);
    expect(valueAt({ meta: wrapped }, "meta.level")).toBe(2);
    expect(sampleSchema([{ meta: wrapped }]).map((field) => field.path)).toEqual([
      "meta",
      "meta.$type",
      "meta.value",
      "meta.level",
    ]);
  });
});

describe("paths", () => {
  it("spells paths for the schema, for copying and for filters", () => {
    const segments = ["items", 0, "price"];
    expect(schemaPath(segments)).toBe("items[].price");
    expect(mongoPath(segments)).toBe("items.0.price");
    expect(filterPath(segments)).toBe("items.price");
  });

  it("reads every value at a schema path, inside arrays too", () => {
    expect(valuesAt(docs[0], "items[].p")).toEqual([1, 2]);
    expect(valuesAt(docs[1], "tags[]")).toEqual([]);
    expect(valuesAt(docs[0], "missing.path")).toEqual([]);
    expect(valuesAt({ m: [[1, 2], [3]] }, "m[][]")).toEqual([1, 2, 3]);
    expect(valueAt(docs[0], "items.1.p")).toBe(2);
    // A typed value is a leaf, not an object to walk into.
    expect(valueAt(docs[0], "_id.value")).toBeUndefined();
  });
});

describe("schema sampling", () => {
  const schema = sampleSchema(docs);
  const field = (path: string) => schema.find((f) => f.path === path);

  it("gives every path with coverage and type shares, arrays as []", () => {
    expect(field("_id")).toEqual({
      path: "_id",
      coverage: 1,
      types: [{ name: "objectId", share: 1 }],
    });
    expect(field("n")?.coverage).toBe(0.5);
    expect(field("items[].p")).toEqual({
      path: "items[].p",
      coverage: 1,
      types: [{ name: "number", share: 1 }],
    });
    // A document with an empty array has the array, not its elements.
    expect(field("tags")?.coverage).toBe(1);
    expect(field("tags[]")?.coverage).toBe(0.5);
  });

  it("keeps umlauts and emoji in field names and finds mixed types", () => {
    expect(field("größe")?.types).toEqual([
      { name: "number", share: 0.5 },
      { name: "string", share: 0.5 },
    ]);
    expect(outliersOf(field("größe") ?? { path: "", coverage: 0, types: [] })).toEqual({
      partial: false,
      mixed: true,
    });
    expect(outliersOf(field(SMILE) ?? { path: "", coverage: 0, types: [] })).toEqual({
      partial: true,
      mixed: false,
    });
  });

  it("prefers the server's schema and samples only when there is none", () => {
    const server = [{ path: "x", coverage: 0.25, types: [{ name: "int32", share: 1 }] }];
    expect(schemaOf({ documents: docs, schema: server })).toBe(server);
    expect(schemaOf({ documents: docs, schema: [] }).length).toBe(schema.length);
  });
});

describe("distribution", () => {
  it("counts values inside arrays, with range, histogram and top values", () => {
    const result = distribution(docs, "items[].p", { bins: 2 });
    expect(result).toMatchObject({
      values: 3,
      documents: 2,
      missing: 0,
      distinct: 3,
      scale: "number",
    });
    expect(result.min).toBe(1);
    expect(result.max).toBe(3);
    expect(result.bins.map((bin) => bin.count)).toEqual([1, 2]);
  });

  it("orders top values by count and keeps types apart", () => {
    const result = distribution([{ s: "1" }, { s: 1 }, { s: "1" }, { s: oid }, {}], "s");
    expect(result.top.map((entry) => [entry.value, entry.count])).toEqual([
      ["1", 2],
      [1, 1],
      [oid, 1],
    ]);
    expect(result.missing).toBe(1);
    expect(result.scale).toBe("number");
  });

  it("uses dates as a time scale and strings for min and max", () => {
    const dated = distribution(
      [{ at: when }, { at: { $type: "date", value: String(WHEN_MS + 86_400_000) } }],
      "at",
    );
    expect(dated.scale).toBe("date");
    expect(dated.min).toBe(WHEN_MS);
    const words = distribution([{ w: "pear" }, { w: "apple" }], "w");
    expect([words.scale, words.min, words.max]).toEqual([null, "apple", "pear"]);
    expect(histogram([5, 5], 10)).toEqual([{ from: 5, to: 5, count: 2 }]);
  });
});

describe("projection step", () => {
  it("turns documents into a frame with typed columns", () => {
    const frame = projectDocuments(
      { documents: docs, schema: [] },
      {
        columns: [
          { path: "at" },
          { path: "total", name: "Total" },
          { path: "n" },
          { path: "items.0.p", type: "number" },
          { path: "_id" },
          { path: "" },
        ],
      },
    );
    expect(frame.fields.map((f) => [f.name, f.type])).toEqual([
      ["at", "time"],
      ["Total", "number"],
      ["n", "int64"],
      ["items.0.p", "number"],
      ["_id", "string"],
    ]);
    expect(frame.fields[0]?.values).toEqual([WHEN_MS, WHEN_MS]);
    expect(frame.fields[1]?.values).toEqual([129.9, null]);
    // int64 stays exact as text; a missing value is null.
    expect(frame.fields[2]?.values).toEqual(["9007199254740993", null]);
    expect(frame.fields[4]?.values).toEqual([oid.value, oid.value]);
  });

  it("is a transformation of the panel for one query, applied only where it is", () => {
    const outcome = {
      refId: "A",
      result: { shape: "documents" as const, documents: { documents: docs, schema: [] } },
    };
    expect(projectOutcomes([outcome], [])[0]).toBe(outcome);
    const steps = withProjection([{ type: "other" }], "A", { columns: [{ path: "at" }] });
    expect(steps).toEqual([
      { type: "other" },
      { type: "toFrame", refId: "A", columns: [{ path: "at" }] },
    ]);
    expect(projectionFor(steps, "B")).toBeUndefined();
    expect(projectOutcomes([outcome], steps)[0]).toMatchObject({ result: { shape: "frame" } });
    expect(withProjection(steps, "A", undefined)).toEqual([{ type: "other" }]);
  });
});

describe("click-to-filter values", () => {
  it("go back as Extended JSON, typed", () => {
    expect(toExtendedJson(oid)).toEqual({ $oid: oid.value });
    // Milliseconds stay exact as canonical Extended JSON, also beyond JavaScript's date range.
    expect(toExtendedJson(when)).toEqual({ $date: { $numberLong: String(WHEN_MS) } });
    expect(toExtendedJson({ $type: "date", value: "99999999999999999" })).toEqual({
      $date: { $numberLong: "99999999999999999" },
    });
    expect(toExtendedJson(price)).toEqual({ $numberDecimal: "129.90" });
    expect(toExtendedJson(big)).toEqual({ $numberLong: "9007199254740993" });
    expect(
      toExtendedJson({ $type: "uuid", value: "0199f0a0-0000-7000-8000-000000000000" }),
    ).toEqual({ $uuid: "0199f0a0-0000-7000-8000-000000000000" });
    expect(toExtendedJson({ $type: "timestamp", value: "1700000000:3" })).toEqual({
      $timestamp: { t: 1700000000, i: 3 },
    });
    expect(toExtendedJson("x")).toBe("x");
    expect(filterable({ $type: "binary", value: null })).toBe(false);
    expect(filterable({ $type: "javascript", value: "f()" })).toBe(false);
    expect(filterable({ a: 1 })).toBe(false);
    expect(filterable(null)).toBe(true);
  });
});

describe("MongoDB query form", () => {
  it("splits a pipeline into its stage texts, keeping each as written", () => {
    const text = '[{"$sort": {"b": 1, "a": -1}}, {"$match": {"s": "x, y]"}}]';
    expect(splitPipeline(text)).toEqual([
      '{"$sort": {"b": 1, "a": -1}}',
      '{"$match": {"s": "x, y]"}}',
    ]);
    expect(splitPipeline("[]")).toEqual([]);
    expect(splitPipeline('[{"a": "\\"}"}]')).toEqual(['{"a": "\\"}"}']);
    expect(splitPipeline('{"$match": {}}')).toBeNull();
    expect(splitPipeline("[{]")).toBeNull();
    expect(joinPipeline(['{"$sort": {"b": 1, "a": -1}}'])).toBe(
      '[\n{"$sort": {"b": 1, "a": -1}}\n]',
    );
    expect(joinPipeline([])).toBe("[]");
  });

  it("previews up to a stage with only the stages given", () => {
    expect(previewQuery({ collection: "orders", pipeline: "[]" }, ['{"$limit": 1}'])).toEqual({
      collection: "orders",
      pipeline: '[\n{"$limit": 1}\n]',
    });
  });

  it("adds a filter as a $match stage, or to find's filter text, keeping the order there", () => {
    const next = addMatch(
      { collection: "c", pipeline: '[{"$sort": {"b": 1, "a": -1}}]' },
      "items.sku",
      oid,
    );
    expect(splitPipeline(next.pipeline ?? "")).toEqual([
      '{"$sort": {"b": 1, "a": -1}}',
      `{"$match": {"items.sku": {"$oid":"${oid.value}"}}}`,
    ]);
    expect(addMatch({ collection: "c", filter: '{"z": 1, "a": 2}' }, "b", 3)).toEqual({
      collection: "c",
      filter: '{"z": 1, "a": 2, "b": 3}',
    });
    expect(addMatch({ collection: "c", filter: "{ }" }, "b", "x").filter).toBe('{"b": "x"}');
    expect(addMatch({ collection: "c" }, "b", true)).toEqual({
      collection: "c",
      filter: '{"b": true}',
    });
  });

  it("reads stored queries in the server's form only", () => {
    expect(parseMongoQuery(null)).toEqual({ collection: "" });
    expect(
      parseMongoQuery({ collection: "c", pipeline: "[]", filter: "{}", mode: "aggregate" }),
    ).toEqual({ collection: "c", pipeline: "[]" });
    expect(
      parseMongoQuery({ collection: "c", filter: { a: 1 }, sort: "{}", skip: -1, limit: 0 }),
    ).toEqual({ collection: "c", sort: "{}" });
    expect(modeOf({ collection: "c" })).toBe("find");
    expect(modeOf({ collection: "c", pipeline: "[]" })).toBe("aggregate");
    expect(mongoQueryText({ collection: "orders", filter: '{"a": 1}' })).toBe(
      'orders.find({"a": 1})',
    );
    expect(mongoQueryText({ collection: "", pipeline: "[]" })).toBe("");
  });
});

describe("MongoDB completion", () => {
  const fields = ["status", "customer.name", "items.price"];
  const at = (text: string) => text.indexOf("|");
  const complete = (text: string, target: Parameters<typeof mongoCompletions>[2] = "stage") =>
    mongoCompletions(text.replace("|", ""), at(text), target, fields)?.options.map((o) => o.label);

  it("finds where the cursor is in unfinished JSON", () => {
    const open = '{"$match": {"status": {"$';
    expect(jsonContext(open, open.length)).toMatchObject({
      path: ["$match", "status"],
      inKey: true,
      quoted: true,
      word: "$",
    });
    const value = '{"$group": {"_id": "$cu';
    expect(jsonContext(value, value.length)).toMatchObject({
      path: ["$group", "_id"],
      inKey: false,
      word: "$cu",
    });
  });

  it("offers stage names at the top and fields and operators in $match", () => {
    expect(complete('{"$ma|')).toEqual(["$match"]);
    // Unquoted, the option brings its quotes.
    expect(complete("{$li|")).toEqual(['"$limit"']);
    expect(complete('{"$match": {"st|')).toEqual(["status"]);
    expect(complete('{"$match": {"$o|')).toEqual(["$or"]);
    expect(complete('{"$match": {"status": {"$g|')).toEqual(["$gt", "$gte", "$geoWithin"]);
    expect(complete('{"$match": {"$or": [{"cu|')).toEqual(["customer.name"]);
  });

  it("offers accumulators in $group and field references where values are expressions", () => {
    expect(complete('{"$group": {"_id": null, "n": {"$su|')).toEqual(["$sum"]);
    expect(complete('{"$group": {"_|')).toEqual(["_id"]);
    expect(complete('{"$group": {"_id": "$cu|')).toEqual(["$customer.name"]);
    expect(complete('{"$project": {"total": "$it|')).toEqual(["$items.price"]);
    expect(complete('{"$lookup": {"lo|')).toEqual(["localField"]);
    expect(complete('{"$limit": 5|')).toBeUndefined();
  });

  it("completes find's filter, projection and sort", () => {
    expect(complete('{"sta|', "filter")).toEqual(["status"]);
    expect(complete('{"$an|', "filter")).toEqual(["$and"]);
    expect(complete('{"cus|', "sort")).toEqual(["customer.name"]);
  });
});

describe("JSON highlighting", () => {
  it("tells keys, operators, strings and literals apart and keeps every character", () => {
    const text = '{"$match": {"status": "paid", "n": 2, "ok": true}}';
    const tokens = tokenizeJson(text);
    expect(tokens.map((token) => token.text).join("")).toBe(text);
    const kinds = Object.fromEntries(tokens.map((token) => [token.text, token.kind]));
    expect(kinds['"$match"']).toBe("keyword");
    expect(kinds['"status"']).toBe("label");
    expect(kinds['"paid"']).toBe("string");
    expect(kinds.true).toBe("keyword");
  });
});
