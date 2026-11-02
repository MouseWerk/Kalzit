import type { SourceSchema } from "../../features/datasources/api";

/**
 * What a data source holds, as the help layer names it: tables, collections, metrics, log labels,
 * indices, node labels and edge types, each with its fields. Read from the source's schema
 * (docs/api/datasources.md, "Schema"), so starters and snippets use real names.
 */
export type ObjectKind =
  | "table"
  | "collection"
  | "metric"
  | "label"
  | "index"
  | "nodeLabel"
  | "edgeType"
  | "installed";

export interface SchemaField {
  name: string;
  /** The type as the source names it (`timestamptz`, `date`, `keyword`); empty when unknown. */
  type: string;
}

export interface SchemaObject {
  kind: ObjectKind;
  name: string;
  /** The schema or database a table lives in, when the source names one. */
  schema?: string | undefined;
  fields: SchemaField[];
}

/** How many objects the help layer lists; a picker with more is searched instead. */
export const MAX_OBJECTS = 500;

export function schemaObjects(schema: SourceSchema | undefined): SchemaObject[] {
  if (schema === undefined) {
    return [];
  }
  switch (schema.kind) {
    case "tables":
      return schema.tables.map((table) => ({
        kind: "table",
        name: table.name,
        schema: table.schema,
        fields: table.columns.map((c) => ({ name: c.name, type: c.type })),
      }));
    case "metrics":
      return schema.metrics.map((name) => ({
        kind: "metric",
        name,
        fields: schema.labels.map((label) => ({ name: label, type: "label" })),
      }));
    case "labels":
      return schema.labels.map((label) => ({
        kind: "label",
        name: label,
        fields: (schema.values[label] ?? []).map((value) => ({ name: value, type: "value" })),
      }));
    case "indices":
      return schema.indices.map((index) => ({
        kind: "index",
        name: index.name,
        fields: index.columns.map((c) => ({ name: c.name, type: c.type })),
      }));
    case "collections":
      return schema.collections.map((collection) => ({
        kind: "collection",
        name: collection.name,
        fields: collection.fields
          .filter((field) => !field.path.includes("[]"))
          .map((field) => ({ name: field.path, type: field.types[0]?.name ?? "" })),
      }));
    case "graph": {
      const keys = schema.propertyKeys.map((key) => ({ name: key, type: "" }));
      return [
        ...schema.labels.map((name) => ({ kind: "nodeLabel" as const, name, fields: keys })),
        ...schema.edgeTypes.map((name) => ({ kind: "edgeType" as const, name, fields: keys })),
        ...schema.queries.map((name) => ({
          kind: "installed" as const,
          name,
          fields: (schema.queryParams[name] ?? []).map((p) => ({ name: p.name, type: p.type })),
        })),
      ];
    }
    case "fields":
      return [];
  }
}

const TIME = /time|date|timestamp/i;
const NUMBER = /int|float|double|decimal|numeric|real|number|money|long|short|byte|scaled/i;

export const isTimeField = (field: SchemaField) => TIME.test(field.type);
export const isNumberField = (field: SchemaField) =>
  NUMBER.test(field.type) && !TIME.test(field.type);

/** The field a time filter goes on: the first time-typed one. */
export function timeField(object: SchemaObject | undefined): string | undefined {
  return object?.fields.find(isTimeField)?.name;
}

/** A field worth counting per value: the first that is neither a time, a number nor an id. */
export function groupField(object: SchemaObject | undefined): string | undefined {
  const fields = object?.fields ?? [];
  const plain = (f: SchemaField) =>
    !isTimeField(f) && !isNumberField(f) && !/^_?id$/i.test(f.name) && f.name !== "_id";
  return (fields.find(plain) ?? fields.find((f) => !isTimeField(f)) ?? fields[0])?.name;
}

/** A numeric field to sum or plot, if the object has one. */
export function numberField(object: SchemaObject | undefined): string | undefined {
  return object?.fields.find((f) => isNumberField(f) && !/^_?id$/i.test(f.name))?.name;
}
