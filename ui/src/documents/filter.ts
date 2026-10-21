import { dateMs, isContainer, isTyped } from "./values";

/**
 * Click-to-filter: a value from a result goes back into the query as MongoDB Extended JSON
 * (relaxed v2), so its type survives: an ObjectId stays `{"$oid": ...}`, a date `{"$date": ...}`,
 * and the server reads the pipeline with the same rules.
 */

/** Values a filter can match exactly: leaves, and no binary data (too large to put in a query). */
export function filterable(value: unknown): boolean {
  if (value === undefined || isContainer(value)) {
    return false;
  }
  return !(isTyped(value) && value.$type === "binary");
}

export function toExtendedJson(value: unknown): unknown {
  if (!isTyped(value)) {
    return value;
  }
  switch (value.$type) {
    case "objectId":
      return { $oid: value.value };
    case "date": {
      const ms = dateMs(value);
      return { $date: ms === null ? value.value : new Date(ms).toISOString() };
    }
    case "decimal":
      return { $numberDecimal: value.value };
    case "int64":
      return { $numberLong: value.value };
    default:
      return value;
  }
}
