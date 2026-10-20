import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHAPES = resolve(import.meta.dirname, "../api/generated/shapes.ts");

/**
 * The members of a string-literal union exported from the generated server types, read from the
 * file itself: the types vanish at runtime, and tests need the list the server actually has.
 */
export function generatedUnion(name: string): string[] {
  const source = readFileSync(SHAPES, "utf8");
  const match = new RegExp(`export type ${name} = ([^;]+);`).exec(source);
  if (match === null) {
    throw new Error(`${name} not found in api/generated/shapes.ts`);
  }
  const members = [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  if (members.length === 0) {
    throw new Error(`${name} in api/generated/shapes.ts is not a string-literal union`);
  }
  return members;
}
