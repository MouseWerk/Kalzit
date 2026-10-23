import type { RE2JS } from "re2js";
import { useEffect, useSyncExternalStore } from "react";
import { refusedSyntax } from "./patternSyntax";

/**
 * Patterns users type (override matchers, regex mappings) run on re2js, a linear-time engine
 * with RE2 syntax: no backreferences or lookaround, so no pattern can hang a page however long
 * the value. Only syntax both re2js and the server's Rust `regex` crate read alike is accepted
 * (`patternSyntax.ts`). re2js loads on first use, so dashboards without patterns never fetch it.
 */

/** Values are tested on their first characters only; longer cells add nothing a pattern needs. */
export const MAX_TESTED_CHARS = 1000;
/** Results remembered per pattern, so a column of repeated values tests each once. */
const MAX_REMEMBERED = 10_000;
const MAX_PATTERNS = 500;

export interface Pattern {
  test: (text: string) => boolean;
}

type Engine = typeof RE2JS;

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;
const listeners = new Set<() => void>();
const compiled = new Map<string, Pattern | null>();

/** Loads re2js once; everyone waiting is told when it is there. */
export function loadPatternEngine(): Promise<Engine> {
  loading ??= import("re2js").then((module) => {
    engine = module.RE2JS;
    compiled.clear();
    for (const listener of listeners) listener();
    return module.RE2JS;
  });
  return loading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Starts loading re2js when `needed` and re-renders the caller once it is there. Until then
 * patterns match nothing, so a panel shows its values unmapped for that moment.
 */
export function usePatternEngine(needed: boolean): boolean {
  const ready = useSyncExternalStore(
    subscribe,
    () => engine !== null,
    () => engine !== null,
  );
  useEffect(() => {
    if (needed) void loadPatternEngine();
  }, [needed]);
  return ready;
}

/** Matches nothing: a pattern whose engine is still loading. */
const WAITING: Pattern = { test: () => false };

function build(pattern: string, re2: Engine): Pattern | null {
  let regex: RE2JS;
  try {
    regex = re2.compile(pattern);
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

/**
 * A pattern typed by a user, compiled once; null when it is outside the shared syntax. While
 * re2js loads, a pattern with valid syntax matches nothing.
 */
export function compilePattern(pattern: string): Pattern | null {
  if (refusedSyntax(pattern)) {
    return null;
  }
  if (engine === null) {
    void loadPatternEngine();
    return WAITING;
  }
  if (!compiled.has(pattern)) {
    if (compiled.size >= MAX_PATTERNS) {
      compiled.clear();
    }
    compiled.set(pattern, build(pattern, engine));
  }
  return compiled.get(pattern) ?? null;
}

/**
 * What the editor says about a pattern: valid, invalid, or not known yet while re2js loads (the
 * syntax check alone cannot tell, since re2js still refuses some patterns it lets through).
 */
export function patternStatus(pattern: string): "valid" | "invalid" | "checking" {
  if (pattern === "") return "valid";
  if (refusedSyntax(pattern)) return "invalid";
  if (engine === null) {
    void loadPatternEngine();
    return "checking";
  }
  return compilePattern(pattern) === null ? "invalid" : "valid";
}

/** Whether a non-empty pattern is known to be refused. */
export function isInvalidPattern(pattern: string): boolean {
  return patternStatus(pattern) === "invalid";
}

/** Whether field options use patterns, so their panel needs re2js. */
export function usesPatterns(fieldConfig: unknown): boolean {
  return JSON.stringify(fieldConfig ?? null).includes('"regex"');
}
