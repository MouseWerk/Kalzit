import type { DocumentSet, FieldSchema } from "../api/generated/shapes";
import { entriesOf, isContainer, typeOf } from "./values";

/**
 * The schema of a document set. The server samples it (`DocumentSet.schema`: every path with its
 * coverage and type shares); `sampleSchema` derives the same from the documents at hand, for sets
 * without one and for array drilldowns. Coverage is the share of documents that contain the path
 * at least once; type shares count values, so an array of mixed elements shows both types.
 */

/** Deeper levels are left out of the schema; the tree still shows them. */
const MAX_DEPTH = 32;

interface PathCounts {
  documents: number;
  values: number;
  types: Map<string, number>;
}

export function sampleSchema(documents: readonly unknown[]): FieldSchema[] {
  // Insertion order is first appearance, which reads like the documents themselves.
  const paths = new Map<string, PathCounts>();
  let seen = new Set<string>();

  function record(path: string, value: unknown) {
    let counts = paths.get(path);
    if (counts === undefined) {
      counts = { documents: 0, values: 0, types: new Map() };
      paths.set(path, counts);
    }
    if (!seen.has(path)) {
      seen.add(path);
      counts.documents++;
    }
    counts.values++;
    const type = typeOf(value);
    counts.types.set(type, (counts.types.get(type) ?? 0) + 1);
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
    seen = new Set();
    walk(document, "", 0);
  }
  const total = documents.length;
  return [...paths].map(([path, counts]) => ({
    path,
    coverage: total === 0 ? 0 : counts.documents / total,
    types: [...counts.types]
      .map(([name, count]) => ({ name, share: count / counts.values }))
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
