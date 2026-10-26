import { isContainer, isTyped, unwrap } from "./values";

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
    for (const outer of current) {
      const value = unwrap(outer);
      if (step === "[]") {
        if (Array.isArray(value)) {
          next.push(...value);
        }
      } else if (isObject(value) && Object.hasOwn(value, step)) {
        next.push(value[step]);
      }
    }
    current = next;
  }
  return current;
}

/**
 * A field path as its keys, unescaped, with `null` for "every element of the array here": the
 * form the distribution route takes. Unlike a schema path it is never ambiguous, since a key
 * may itself hold dots (`preis.netto`).
 */
export type PathStep = string | null;

/** Every value along `steps` in one document, as `valuesAt` for a schema path. */
export function valuesAlong(document: unknown, steps: readonly PathStep[]): unknown[] {
  let current: unknown[] = [document];
  for (const step of steps) {
    const next: unknown[] = [];
    for (const outer of current) {
      const value = unwrap(outer);
      if (step === null) {
        if (Array.isArray(value)) {
          next.push(...value);
        }
      } else if (isObject(value) && Object.hasOwn(value, step)) {
        next.push(value[step]);
      }
    }
    current = next;
  }
  return current;
}

/**
 * The keys behind a schema path, read from the documents themselves: `a.b` is the key `a.b` in
 * a document that has one, else `a` then `b`. The first document with the path decides; when no
 * document has it, the dots split it.
 */
export function stepsOf(documents: readonly unknown[], path: string): PathStep[] {
  const found = (value: unknown, rest: string): PathStep[] | null => {
    if (rest === "") {
      return [];
    }
    const inner = unwrap(value);
    if (rest.startsWith("[]")) {
      if (!Array.isArray(inner)) {
        return null;
      }
      const after = rest.slice(2).replace(/^\./, "");
      for (const element of inner) {
        const tail = found(element, after);
        if (tail !== null) {
          return [null, ...tail];
        }
      }
      return after === "" ? [null] : null;
    }
    if (!isObject(inner)) {
      return null;
    }
    // Longest keys first, so `a.b` as one key wins over `a` then `b` where both exist.
    const keys = Object.keys(inner)
      .filter((key) => rest === key || rest.startsWith(`${key}.`) || rest.startsWith(`${key}[]`))
      .sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const after = rest.slice(key.length).replace(/^\./, "");
      const tail = found(inner[key], after);
      if (tail !== null) {
        return [key, ...tail];
      }
    }
    return null;
  };
  for (const document of documents) {
    const resolved = found(document, path);
    if (resolved !== null) {
      return resolved;
    }
  }
  return steps(path).map((step) => (step === "[]" ? null : step));
}

/**
 * The one value at a dotted MongoDB path (`customer.address.city`, `items.0.price`); undefined
 * when the document has no such field.
 */
export function valueAt(document: unknown, path: string): unknown {
  let current: unknown = document;
  for (const part of path.split(".")) {
    const value = unwrap(current);
    if (Array.isArray(value) && /^\d+$/.test(part)) {
      current = value[Number(part)];
    } else if (isObject(value) && Object.hasOwn(value, part)) {
      current = value[part];
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
    const value = unwrap(current);
    if (typeof segment === "number" ? Array.isArray(value) : isObject(value)) {
      current = (value as Record<string | number, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** A document or embedded document: an object that is not a typed value. */
function isObject(value: unknown): value is Record<string, unknown> {
  return isContainer(value) && !Array.isArray(value) && !isTyped(value);
}
