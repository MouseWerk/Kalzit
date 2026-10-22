import { RE2JS } from "re2js";

/**
 * Patterns users type (override matchers, regex mappings) run on re2js, a linear-time engine
 * with RE2 syntax: no backreferences or lookaround, so no pattern can hang a page however long
 * the value. The server checks the same syntax with the Rust `regex` crate before storing one.
 */

/** Values are tested on their first characters only; longer cells add nothing a pattern needs. */
export const MAX_TESTED_CHARS = 1000;
/** Results remembered per pattern, so a column of repeated values tests each once. */
const MAX_REMEMBERED = 10_000;
const MAX_PATTERNS = 500;

export interface Pattern {
  test: (text: string) => boolean;
}

const compiled = new Map<string, Pattern | null>();

function build(pattern: string): Pattern | null {
  let regex: RE2JS;
  try {
    regex = RE2JS.compile(pattern);
  } catch {
    return null;
  }
  const results = new Map<string, boolean>();
  return {
    test(text: string) {
      const tested = text.length > MAX_TESTED_CHARS ? text.slice(0, MAX_TESTED_CHARS) : text;
      let result = results.get(tested);
      if (result === undefined) {
        result = regex.test(tested);
        if (results.size >= MAX_REMEMBERED) {
          results.clear();
        }
        results.set(tested, result);
      }
      return result;
    },
  };
}

/** A pattern typed by a user, compiled once; null when it is not valid RE2 syntax. */
export function compilePattern(pattern: string): Pattern | null {
  if (!compiled.has(pattern)) {
    if (compiled.size >= MAX_PATTERNS) {
      compiled.clear();
    }
    compiled.set(pattern, build(pattern));
  }
  return compiled.get(pattern) ?? null;
}

/** Whether a non-empty pattern fails to compile, for the editor's error message. */
export function isInvalidPattern(pattern: string): boolean {
  return pattern !== "" && compilePattern(pattern) === null;
}
