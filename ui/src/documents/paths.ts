import { isContainer } from "./values";

/**
 * Field paths in three spellings, one per use:
 * - schema paths, as the server samples them: dotted, array elements as `[]` (`items[].price`);
 * - MongoDB paths of one value, with array indexes (`items.0.price`), for copying;
 * - filter paths without indexes (`items.price`), which match any element of the array.
 */

export type Segment = string | number;

export function schemaPath(segments: readonly Segment[]): string {
  let path = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      path += "[]";
    } else {
      path += path === "" ? segment : `.${segment}`;
    }
  }
  return path;
}

export function mongoPath(segments: readonly Segment[]): string {
  return segments.map(String).join(".");
}

export function filterPath(segments: readonly Segment[]): string {
  return segments.filter((segment) => typeof segment === "string").join(".");
}

/** A schema path as steps: names, and `[]` for "every element of the array here". */
function steps(path: string): string[] {
  const result: string[] = [];
  for (const part of path.split(".")) {
    const name = part.replace(/(\[\])+$/, "");
    if (name !== "") {
      result.push(name);
    }
    for (let rest = part.length - name.length; rest >= 2; rest -= 2) {
      result.push("[]");
    }
  }
  return result;
}

/**
 * Every value at a schema path in one document: `items[].price` gives the price of each item.
 * Documents without the path give nothing; a `null` on the way stops there.
 */
export function valuesAt(document: unknown, path: string): unknown[] {
  let current: unknown[] = [document];
  for (const step of steps(path)) {
    const next: unknown[] = [];
    for (const value of current) {
      if (step === "[]") {
        if (Array.isArray(value)) {
          next.push(...value);
        }
      } else if (isContainer(value) && !Array.isArray(value) && Object.hasOwn(value, step)) {
        next.push(value[step]);
      }
    }
    current = next;
  }
  return current;
}

/**
 * The one value at a dotted MongoDB path (`customer.address.city`, `items.0.price`); undefined
 * when the document has no such field.
 */
export function valueAt(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split(".")) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (isContainer(current) && !Array.isArray(current) && Object.hasOwn(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** The value at a path of segments inside a document (the tree's rows know theirs). */
export function valueAtSegments(document: unknown, segments: readonly Segment[]): unknown {
  let current: unknown = document;
  for (const segment of segments) {
    if (typeof segment === "number" ? Array.isArray(current) : isContainer(current)) {
      current = (current as Record<string | number, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}
