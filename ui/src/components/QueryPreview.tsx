import { useId } from "react";

/** Keys whose text is the whole query of a source's query form. */
const TEXT_KEYS = ["sql", "expr", "cypher", "gsql", "lucene"];

/**
 * A query as a person checks it before saving: the text when the query is only its text (`sql`,
 * `expr`, ...), else the whole query as JSON, so no part of it is left out.
 */
export function fullQueryText(query: unknown): string {
  if (typeof query === "string") {
    return query;
  }
  if (query === null || typeof query !== "object") {
    return "";
  }
  const entries = Object.entries(query as Record<string, unknown>);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only !== undefined && TEXT_KEYS.includes(only[0]) && typeof only[1] === "string") {
    return only[1];
  }
  return JSON.stringify(query, null, 2);
}

/** The query a dialog is about to save, in full and read-only, with its label above it. */
export function QueryPreview({ label, query }: { label: string; query: unknown }) {
  const id = useId();
  return (
    <div className="field">
      <span className="field__label" id={id}>
        {label}
      </span>
      <figure className="query-preview__frame" aria-labelledby={id}>
        <pre className="query-preview" translate="no">
          {fullQueryText(query)}
        </pre>
      </figure>
    </div>
  );
}
