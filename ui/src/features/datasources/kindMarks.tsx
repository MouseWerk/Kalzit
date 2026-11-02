import clickhouse from "../../assets/logos/clickhouse.svg?raw";
import elasticsearch from "../../assets/logos/elasticsearch.svg?raw";
import influxdb from "../../assets/logos/influxdb.svg?raw";
import mariadb from "../../assets/logos/mariadb.svg?raw";
import mongodb from "../../assets/logos/mongodb.svg?raw";
import mysql from "../../assets/logos/mysql.svg?raw";
import neo4j from "../../assets/logos/neo4j.svg?raw";
import opensearch from "../../assets/logos/opensearch.svg?raw";
import postgresql from "../../assets/logos/postgresql.svg?raw";
import prometheus from "../../assets/logos/prometheus.svg?raw";
import sqlite from "../../assets/logos/sqlite.svg?raw";
import { Icon, type IconName } from "../../components/Icon";
import { hasMessage, type MessageKey, type Translate } from "../../i18n/i18n";
import "./datasources.css";

/**
 * How a data source kind is shown: the product's logo where there is one (Simple Icons files in
 * ui/src/assets/logos, see NOTICE.md there), used only to identify the data source, next to the
 * product name; otherwise a neutral line glyph for its family of data. A kind added later only
 * needs an entry in KIND_FAMILIES and, with a logo, in KIND_LOGOS; one without an entry gets the
 * generic glyph.
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
  | "plugin"
  | "generic";

export const KIND_FAMILIES: Readonly<Record<string, KindFamily>> = {
  postgres: "sql",
  mysql: "sql",
  mssql: "sql",
  sqlite: "sqlFile",
  clickhouse: "sql",
  prometheus: "metrics",
  influxdb: "metrics",
  loki: "search",
  mongodb: "documents",
  elasticsearch: "search",
  opensearch: "search",
  file: "file",
  http_json: "http",
  neo4j: "graph",
  memgraph: "graph",
  tigergraph: "graph",
};

/** The files as bundled: one filled path each on a 24 px box, read once at load. */
const LOGO_FILES = {
  clickhouse,
  elasticsearch,
  influxdb,
  mariadb,
  mongodb,
  mysql,
  neo4j,
  opensearch,
  postgresql,
  prometheus,
  sqlite,
} as const;

export type LogoName = keyof typeof LOGO_FILES;

function pathOf(svg: string): string {
  return /<path d="([^"]+)"/.exec(svg)?.[1] ?? "";
}

export const LOGO_PATHS = Object.fromEntries(
  Object.entries(LOGO_FILES).map(([name, svg]) => [name, pathOf(svg)]),
) as Record<LogoName, string>;

/**
 * The logos per kind. A kind that serves two products (MySQL and MariaDB, Elasticsearch and
 * OpenSearch) shows both. SQL Server, Loki, Memgraph and TigerGraph have no file their owners allow to
 * be copied into another product, so they keep the glyph (NOTICE.md).
 */
export const KIND_LOGOS: Readonly<Record<string, readonly LogoName[]>> = {
  postgres: ["postgresql"],
  mysql: ["mysql", "mariadb"],
  sqlite: ["sqlite"],
  clickhouse: ["clickhouse"],
  prometheus: ["prometheus"],
  influxdb: ["influxdb"],
  mongodb: ["mongodb"],
  elasticsearch: ["elasticsearch", "opensearch"],
  opensearch: ["opensearch"],
  neo4j: ["neo4j"],
};

export function kindLogos(kind: string): readonly LogoName[] {
  return Object.hasOwn(KIND_LOGOS, kind) ? (KIND_LOGOS[kind] ?? []) : [];
}

/**
 * The glyph per family: icons of the one icon set (components/Icon.tsx), so they share its grid,
 * stroke and size with every other icon.
 */
const FAMILY_ICONS: Record<KindFamily, IconName> = {
  sql: "table",
  sqlFile: "fileTable",
  metrics: "activity",
  documents: "documents",
  search: "searchIndex",
  file: "file",
  http: "globe",
  graph: "network",
  plugin: "plugin",
  // A database cylinder, for kinds this UI does not know yet.
  generic: "dataSources",
};

/**
 * Whether a kind comes from a plugin: plugin ids are reverse domain names with at least one dot
 * (docs/ARCHITECTURE.md, "Manifest"), built-in kinds never have one.
 */
export function isPluginKind(kind: string): boolean {
  return kind.includes(".");
}

export function kindFamily(kind: string): KindFamily {
  if (Object.hasOwn(KIND_FAMILIES, kind)) {
    return KIND_FAMILIES[kind] as KindFamily;
  }
  return isPluginKind(kind) ? "plugin" : "generic";
}

/** The two letters of a plugin kind's tile: "Sf" for Snowflake, "SH" for SAP HANA. */
export function kindMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  const word = words[0] ?? "?";
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1, 2).toLowerCase()}`;
}

/** The one-line summary of a kind for the picker, when this UI has one. */
export function kindSummary(t: Translate, kind: string): string | null {
  const key = `datasources.kinds.${kind}.summary`;
  return hasMessage(key) ? t(key as MessageKey) : null;
}

/**
 * The kind's logo, or its glyph, in a tile. Decorative: the kind's name always stands next to it,
 * so screen readers skip the mark. Logos keep their brand color on a light tile in every scheme
 * (several are dark blue and would vanish on dark); the contrast theme draws them in the text
 * color. Glyphs follow the text color.
 */
export function KindMark({
  kind,
  small = false,
  name,
}: {
  kind: string;
  small?: boolean;
  /** A plugin kind's name: its letters stand in the tile, where a built-in kind has its logo. */
  name?: string | undefined;
}) {
  const logos = kindLogos(kind);
  const size = small ? " kind-mark--small" : "";
  if (name !== undefined && isPluginKind(kind)) {
    return (
      <span className={`kind-mark${size}`} data-family="plugin" aria-hidden="true">
        <span className="kind-mark__letters">{kindMonogram(name)}</span>
      </span>
    );
  }
  if (logos.length > 0) {
    return (
      <span
        className={`kind-mark kind-mark--logo${size}`}
        data-logos={logos.length}
        aria-hidden="true"
      >
        {logos.map((name) => (
          <svg
            key={name}
            className="kind-logo"
            data-logo={name}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <path d={LOGO_PATHS[name]} />
          </svg>
        ))}
      </span>
    );
  }
  return (
    <span
      className={small ? "kind-mark kind-mark--small" : "kind-mark"}
      data-family={kindFamily(kind)}
      aria-hidden="true"
    >
      <Icon name={FAMILY_ICONS[kindFamily(kind)]} />
    </span>
  );
}

/** A kind's mark and its name, as a list shows it. */
export function KindLabel({ kind, name }: { kind: string; name: string }) {
  return (
    <span className="kind-label">
      <KindMark kind={kind} small name={name} />
      <span>{name}</span>
    </span>
  );
}
