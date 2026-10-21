/**
 * A deliberately small CSS reader for the style guard tests. It understands what our own
 * stylesheets use (style rules nested in @layer, @media and @supports, plain declarations) and
 * nothing more; it is not a general CSS parser.
 */

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Every .css file below `root`, as sorted paths relative to it with forward slashes. */
export function listCssFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".css")) {
        found.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

export interface Declaration {
  property: string;
  value: string;
}

export interface StyleRule {
  selector: string;
  declarations: Declaration[];
  /** Enclosing at-rule preludes, outermost first, e.g. ["@layer tokens", "@media (...)"]. */
  context: string[];
}

// Keyframes too, so each frame is a rule of its own with the @keyframes in its context.
const GROUPING_AT_RULES = /^@(layer|media|supports|container|keyframes)\b/;

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitDeclarations(body: string): Declaration[] {
  const declarations: Declaration[] = [];
  let depth = 0;
  let current = "";
  const flush = () => {
    const colon = current.indexOf(":");
    if (colon > 0) {
      declarations.push({
        property: current.slice(0, colon).trim().toLowerCase(),
        value: current
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, " "),
      });
    }
    current = "";
  };
  for (const char of body) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === ";" && depth === 0) {
      flush();
    } else {
      current += char;
    }
  }
  flush();
  return declarations;
}

export function parseCss(source: string): StyleRule[] {
  const css = stripComments(source);
  const rules: StyleRule[] = [];
  let index = 0;

  function readBlock(context: string[]): void {
    let prelude = "";
    while (index < css.length) {
      const char = css[index];
      index++;
      if (char === "{") {
        const head = prelude.trim().replace(/\s+/g, " ");
        prelude = "";
        if (GROUPING_AT_RULES.test(head)) {
          readBlock([...context, head]);
          continue;
        }
        let depth = 1;
        let body = "";
        while (index < css.length && depth > 0) {
          const inner = css[index];
          index++;
          if (inner === "{") depth++;
          if (inner === "}") depth--;
          if (depth > 0) body += inner;
        }
        rules.push({ selector: head, declarations: splitDeclarations(body), context });
      } else if (char === "}") {
        return;
      } else if (char === ";") {
        // Statement at-rules such as @import or the @layer order line.
        prelude = "";
      } else {
        prelude += char;
      }
    }
  }

  readBlock([]);
  return rules;
}
