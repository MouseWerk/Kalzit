import type { DocumentSet, FieldSchema } from "../api/generated/shapes";
import { entriesOf, isContainer, isTyped } from "./values";

/**
 * The schema of a document set. The server samples it (`DocumentSet.schema`, docs/api/datasources.md
 * "The documents shape"); `sampleSchema` derives the same from the documents at hand, for sets
 * without one and for array drilldowns, by the same rules: every field path in the order it first
 * appears (array elements as `items[]`, their fields as `items[].price`), `coverage` as the share
 * of documents with the path, and per type the share of those documents where the path has that
 * type, named by MongoDB's type aliases (`int`, `long`, `double`, `string`, ...). A path with
 * several types in one document counts for each, so shares may add up to more than 1.
 */

/** Deeper levels are left out of the schema; the tree still shows them. */
const MAX_DEPTH = 32;

const INT32 = 2 ** 31;

/** The MongoDB type alias of a value as it arrived (`$type` queries use the same names). */
export function schemaType(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (isTyped(value)) {
    switch (value.$type) {
      case "int64":
        return "long";
      case "uuid":
      case "binary":
        return "binData";
      default:
        return value.$type;
    }
  }
  if (Array.isArray(value)) {
    return "array";
  }
  switch (typeof value) {
    case "number":
      return Number.isInteger(value) && value >= -INT32 && value < INT32 ? "int" : "double";
    case "boolean":
      return "bool";
    case "string":
      return "string";
    default:
      return "object";
  }
}

export function sampleSchema(documents: readonly unknown[]): FieldSchema[] {
  // Insertion order is first appearance, which reads like the documents themselves.
  const paths = new Map<string, { documents: number; types: Map<string, number> }>();
  /** Per path, the types it has in the document being walked. */
  let current = new Map<string, Set<string>>();

  function record(path: string, value: unknown) {
    let types = current.get(path);
    if (types === undefined) {
      types = new Set();
      current.set(path, types);
    }
    types.add(schemaType(value));
  }

  function walk(value: unknown, path: string, depth: number) {
    if (depth > MAX_DEPTH || !isContainer(value)) {
      return;
    }
    if (Array.isArray(value)) {
      const element = `${path}[]`;
      for (const item of value) {
        record(element, item);
        walk(item, element, depth + 1);
      }
      return;
    }
    for (const [key, child] of entriesOf(value)) {
      const childPath = path === "" ? String(key) : `${path}.${key}`;
      record(childPath, child);
      walk(child, childPath, depth + 1);
    }
  }

  for (const document of documents) {
    current = new Map();
    walk(document, "", 0);
    for (const [path, types] of current) {
      let counts = paths.get(path);
      if (counts === undefined) {
        counts = { documents: 0, types: new Map() };
        paths.set(path, counts);
      }
      counts.documents++;
      for (const type of types) {
        counts.types.set(type, (counts.types.get(type) ?? 0) + 1);
      }
    }
  }
  const total = documents.length;
  return [...paths].map(([path, counts]) => ({
    path,
    coverage: total === 0 ? 0 : counts.documents / total,
    types: [...counts.types]
      .map(([name, count]) => ({ name, share: count / counts.documents }))
      .sort((a, b) => b.share - a.share),
  }));
}

/** The server's schema, or one sampled here when the set came without. */
export function schemaOf(set: DocumentSet): FieldSchema[] {
  return set.schema.length > 0 ? set.schema : sampleSchema(set.documents);
}

/** Shares are rounded for display; this much short of 1 still counts as full coverage. */
const EPSILON = 1e-9;

export interface Outliers {
  /** The field is missing in some documents. */
  partial: boolean;
  /** Values of more than one type, `null` included. */
  mixed: boolean;
}

export function outliersOf(field: FieldSchema): Outliers {
  return {
    partial: field.coverage < 1 - EPSILON,
    mixed: field.types.filter((type) => type.share > 0).length > 1,
  };
}

/** Paths of the schema as MongoDB filter paths (`items[].price` becomes `items.price`), once each. */
export function filterPaths(schema: readonly FieldSchema[]): string[] {
  return [...new Set(schema.map((field) => field.path.replaceAll("[]", "")))];
}
