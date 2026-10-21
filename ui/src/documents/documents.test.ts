import { describe, expect, it } from "vitest";
import { projectOutcomes } from "../features/dashboards/results";
import { jsonContext, mongoCompletions } from "../features/datasources/editors/mongoCompletion";
import { tokenizeJson } from "../features/datasources/editors/syntax";
import {
  addMatch,
  allStages,
  fromStages,
  type MongoAggregateQuery,
  parseMongoQuery,
  previewQuery,
} from "../features/datasources/mongoQuery";
import { distribution, histogram } from "./distribution";
import { filterable, toExtendedJson } from "./filter";
import { filterPath, mongoPath, schemaPath, valueAt, valuesAt } from "./paths";
import { projectDocuments } from "./projection";
import { outliersOf, sampleSchema, schemaOf } from "./schema";
import { base64Bytes, formatLeaf, typeOf } from "./values";

const oid = { $type: "objectId", value: "665f1c2e9b1e4a0001a1b001" };
const when = { $type: "date", value: "2026-10-01T08:00:00.000Z" };
const big = { $type: "int64", value: "9007199254740993" };
const price = { $type: "decimal", value: "129.90" };

const docs = [
  { _id: oid, at: when, n: big, total: price, items: [{ p: 1 }, { p: 2 }], tags: ["a"], größe: 1 },
  { _id: oid, at: when, items: [{ p: 3 }], tags: [], größe: "groß", "🙂": true },
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
    expect(base64Bytes("TWFu")).toBe(3);
    expect(base64Bytes("TQ==")).toBe(1);
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
    expect(outliersOf(field("🙂") ?? { path: "", coverage: 0, types: [] })).toEqual({
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
      [{ at: when }, { at: { $type: "date", value: "2026-10-03T00:00:00.000Z" } }],
      "at",
    );
    expect(dated.scale).toBe("date");
    expect(dated.min).toBe(Date.parse("2026-10-01T08:00:00.000Z"));
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
    expect(frame.fields[0]?.values).toEqual([Date.parse(when.value), Date.parse(when.value)]);
    expect(frame.fields[1]?.values).toEqual([129.9, null]);
    // int64 stays exact as text; a missing value is null.
    expect(frame.fields[2]?.values).toEqual(["9007199254740993", null]);
    expect(frame.fields[4]?.values).toEqual([oid.value, oid.value]);
  });

  it("applies only where the query has the step", () => {
    const outcome = {
      refId: "A",
      result: { shape: "documents" as const, documents: { documents: docs, schema: [] } },
    };
    const plain = projectOutcomes([outcome], [{ refId: "A", query: { collection: "c" } }]);
    expect(plain[0]).toBe(outcome);
    const projected = projectOutcomes(
      [outcome],
      [{ refId: "A", query: { collection: "c", toFrame: { columns: [{ path: "at" }] } } }],
    );
    expect(projected[0]).toMatchObject({ result: { shape: "frame" } });
  });
});

describe("click-to-filter values", () => {
  it("go back as Extended JSON, typed", () => {
    expect(toExtendedJson(oid)).toEqual({ $oid: oid.value });
    expect(toExtendedJson(when)).toEqual({ $date: "2026-10-01T08:00:00.000Z" });
    expect(toExtendedJson({ $type: "date", value: "1790000000000" })).toEqual({
      $date: new Date(1790000000000).toISOString(),
    });
    expect(toExtendedJson(price)).toEqual({ $numberDecimal: "129.90" });
    expect(toExtendedJson(big)).toEqual({ $numberLong: "9007199254740993" });
    expect(toExtendedJson("x")).toBe("x");
    expect(filterable({ $type: "binary", value: "AAAA" })).toBe(false);
    expect(filterable({ a: 1 })).toBe(false);
    expect(filterable(null)).toBe(true);
  });
});

describe("MongoDB query form", () => {
  const query: MongoAggregateQuery = {
    collection: "orders",
    mode: "aggregate",
    pipeline: [{ $match: { a: 1 } }, { $limit: 5 }],
    disabledStages: [{ index: 1, stage: { $sort: { a: 1 } } }],
  };

  it("keeps disabled stages in their place and out of what runs", () => {
    expect(allStages(query).map((e) => [Object.keys(e.stage)[0], e.enabled])).toEqual([
      ["$match", true],
      ["$sort", false],
      ["$limit", true],
    ]);
    expect(fromStages(query, allStages(query))).toEqual(query);
    const enabled = allStages(query).map((e) => ({ ...e, enabled: true }));
    expect(fromStages(query, enabled)).toEqual({
      collection: "orders",
      mode: "aggregate",
      pipeline: [{ $match: { a: 1 } }, { $sort: { a: 1 } }, { $limit: 5 }],
    });
  });

  it("previews up to a stage, without disabled stages and the projection", () => {
    expect(previewQuery({ ...query, toFrame: { columns: [] } }, 1)).toEqual({
      collection: "orders",
      mode: "aggregate",
      pipeline: [{ $match: { a: 1 } }],
    });
  });

  it("adds a filter as a $match stage, or to find's filter", () => {
    const next = addMatch(query, "items.sku", oid) as MongoAggregateQuery;
    expect(next.pipeline.at(-1)).toEqual({ $match: { "items.sku": { $oid: oid.value } } });
    expect(next.disabledStages).toEqual(query.disabledStages);
    expect(addMatch({ collection: "c", mode: "find", filter: { a: 1 } }, "b", 2)).toEqual({
      collection: "c",
      mode: "find",
      filter: { a: 1, b: 2 },
    });
  });

  it("reads stored queries defensively", () => {
    expect(parseMongoQuery(null)).toEqual({ collection: "", mode: "aggregate", pipeline: [] });
    expect(
      parseMongoQuery({
        collection: "c",
        mode: "aggregate",
        pipeline: [{ $match: {} }, { notAStage: 1 }, { $a: 1, $b: 2 }],
        disabledStages: [{ index: -1, stage: { $limit: 1 } }],
      }),
    ).toEqual({ collection: "c", mode: "aggregate", pipeline: [{ $match: {} }] });
    expect(parseMongoQuery({ collection: "c", mode: "find", limit: 0 })).toEqual({
      collection: "c",
      mode: "find",
      filter: {},
    });
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
