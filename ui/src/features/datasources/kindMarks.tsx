import { catalogs, type MessageKey, type Translate } from "../../i18n/i18n";
import "./datasources.css";

/**
 * How a data source kind is shown: a neutral line glyph for its family of data, never a vendor
 * logo. Most vendors allow their names to identify a compatible product but not their logos in
 * another product (see ui/src/assets/logos/NOTICE.md), so the name carries the identity and the
 * glyph the kind of data. A kind added later only needs an entry in KIND_FAMILIES; one without an
 * entry gets the generic glyph.
 */
export type KindFamily =
  | "sql"
  | "sqlFile"
  | "metrics"
  | "documents"
  | "search"
  | "file"
  | "http"
  | "graph"
  | "generic";

export const KIND_FAMILIES: Readonly<Record<string, KindFamily>> = {
  postgres: "sql",
  mysql: "sql",
  mssql: "sql",
  sqlite: "sqlFile",
  prometheus: "metrics",
  mongodb: "documents",
  elasticsearch: "search",
  opensearch: "search",
  file: "file",
  http_json: "http",
  neo4j: "graph",
  memgraph: "graph",
  tigergraph: "graph",
};

/** Paths on a 24 px grid, drawn like the other line icons (round caps, current color). */
const GLYPHS: Record<KindFamily, string> = {
  // A table: rows and a key column.
  sql: "M4 5h16v14H4zM4 10h16M4 14.5h16M9.5 10v9",
  // A file holding a table.
  sqlFile: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6v5.5H9zM9 14.75h6M12 12v5.5",
  // A pulse over time.
  metrics: "M3.5 12.5h4l2.5-6 4 11 2.5-5h4",
  // Braces: documents with nested fields.
  documents:
    "M9 4.5c-1.75 0-2.5.75-2.5 2.5v2.25c0 1.25-.75 2.25-2 2.75 1.25.5 2 1.5 2 2.75V17c0 1.75.75 2.5 2.5 2.5M15 4.5c1.75 0 2.5.75 2.5 2.5v2.25c0 1.25.75 2.25 2 2.75-1.25.5-2 1.5-2 2.75V17c0 1.75-.75 2.5-2.5 2.5",
  // Lines of text and a magnifier: an index to search.
  search: "M4 6h10M4 10h6M4 14h4M15.5 10a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM18 16.5l2.5 2.5",
  // A plain file.
  file: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 13h6M9 16.5h6",
  // A globe: a service reached over HTTP.
  http: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.25 2.25 3.25 5 3.25 8.5S14.25 18.25 12 20.5C9.75 18.25 8.75 15.5 8.75 12S9.75 5.75 12 3.5",
  // Three nodes and their edges.
  graph:
    "M3.75 7a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0M15.75 6a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0M9.75 18a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0M8.25 6.8l7.5-.6M7.1 9l3.8 7M16.9 8l-3.8 8",
  // A database cylinder, for kinds this UI does not know yet.
  generic:
    "M4.5 6c0-1.66 3.36-3 7.5-3s7.5 1.34 7.5 3-3.36 3-7.5 3-7.5-1.34-7.5-3zM4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3",
};

export function kindFamily(kind: string): KindFamily {
  return Object.hasOwn(KIND_FAMILIES, kind) ? (KIND_FAMILIES[kind] as KindFamily) : "generic";
}

/** The one-line summary of a kind for the picker, when this UI has one. */
export function kindSummary(t: Translate, kind: string): string | null {
  const key = `datasources.kinds.${kind}.summary`;
  return Object.hasOwn(catalogs.en, key) ? t(key as MessageKey) : null;
}

/**
 * The kind's glyph in a tile. Decorative: the kind's name always stands next to it, so screen
 * readers skip the mark. It follows the text color, so it works in every theme and at any size.
 */
export function KindMark({ kind, small = false }: { kind: string; small?: boolean }) {
  return (
    <span
      className={small ? "kind-mark kind-mark--small" : "kind-mark"}
      data-family={kindFamily(kind)}
      aria-hidden="true"
    >
      <svg
        className="icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d={GLYPHS[kindFamily(kind)]} />
      </svg>
    </span>
  );
}

/** A kind's mark and its name, as a list shows it. */
export function KindLabel({ kind, name }: { kind: string; name: string }) {
  return (
    <span className="kind-label">
      <KindMark kind={kind} small />
      <span>{name}</span>
    </span>
  );
}
