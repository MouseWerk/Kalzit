/**
 * The pages of the built-in handbook (docs/design/blueprint/Handbook.dc.html, decisions 3 and 9):
 * the user guide in docs/guide (English) and docs/guide/de (German), the operator pages of
 * docs/operations (English only) and the glossary, in the order and groups of the table of
 * contents. The build reads this list (src/handbook/build/plugin.ts) and ships every page with
 * the UI; a test checks that every guide file is listed here, so a new page is not forgotten.
 *
 * Plain data without imports: the build loads it in Node, and the app shell (help links) may
 * import its types without pulling the handbook into the first page load.
 */

export const HANDBOOK_GROUPS = [
  "start",
  "data",
  "sources",
  "sharing",
  "ai",
  "admin",
  "install",
  "operations",
  "developers",
  "reference",
] as const;
export type HandbookGroup = (typeof HANDBOOK_GROUPS)[number];

export interface CatalogPage {
  /** The address below /handbook and the name links use. */
  slug: string;
  group: HandbookGroup;
  /** The English file, relative to docs/. */
  en: string;
  /** The German file, relative to docs/; none for pages that exist only in English. */
  de?: string;
  /** A shorter name for the table of contents than the page's own title, per language. */
  label?: { en: string; de: string };
}

const guide = (
  slug: string,
  group: HandbookGroup,
  label?: { en: string; de: string },
): CatalogPage => ({
  slug,
  group,
  en: `guide/${slug}.md`,
  de: `guide/de/${slug}.md`,
  ...(label === undefined ? {} : { label }),
});

const operations = (slug: string, label: { en: string; de: string }): CatalogPage => ({
  slug,
  group: "operations",
  en: `operations/${slug}.md`,
  label,
});

export const HANDBOOK_PAGES: readonly CatalogPage[] = [
  {
    slug: "overview",
    group: "start",
    en: "guide/README.md",
    de: "guide/de/README.md",
    label: { en: "Overview", de: "Übersicht" },
  },
  guide("getting-started", "start"),
  guide("query-languages", "start"),
  guide("dashboards", "data"),
  guide("panels", "data"),
  guide("explore", "data"),
  guide("saved-analyses", "data"),
  guide("calculated-fields", "data"),
  guide("traces", "data"),
  guide("export", "data"),
  guide("performance", "data"),
  guide("alerting", "data"),
  guide("data-sources", "sources"),
  guide("arangodb", "sources"),
  guide("gremlin", "sources"),
  guide("couchbase", "sources"),
  guide("warehouses", "sources", { en: "Data warehouses", de: "Data-Warehouses" }),
  guide("sharing", "sharing"),
  guide("reports", "sharing"),
  guide("ai", "ai"),
  guide("plugins", "ai"),
  guide("administration", "admin", { en: "Administration", de: "Verwaltung" }),
  guide("account-security", "admin"),
  guide("provisioning", "admin"),
  guide("grafana-import", "admin"),
  guide("installation", "install"),
  guide("linux-binary", "install"),
  guide("https", "install"),
  guide("reverse-proxy", "install"),
  guide("monitoring", "install"),
  guide("backup", "install"),
  guide("upgrading", "install"),
  guide("offline", "install", { en: "Offline operation", de: "Offline-Betrieb" }),
  operations("updates", { en: "Updates offline and signed", de: "Updates offline und signiert" }),
  operations("high-availability", { en: "Several servers", de: "Mehrere Server" }),
  operations("winget", { en: "winget", de: "winget" }),
  guide("sdk-typescript", "developers"),
  guide("sdk-go", "developers"),
  {
    slug: "glossary",
    group: "reference",
    en: "glossary.md",
    de: "glossary.md",
    label: { en: "Glossary", de: "Glossar" },
  },
];

/** The slugs of the handbook's pages, for links from the app (`HandbookLink`). */
export type HandbookSlug =
  | "overview"
  | "getting-started"
  | "query-languages"
  | "dashboards"
  | "panels"
  | "explore"
  | "saved-analyses"
  | "calculated-fields"
  | "traces"
  | "export"
  | "performance"
  | "alerting"
  | "data-sources"
  | "arangodb"
  | "gremlin"
  | "couchbase"
  | "warehouses"
  | "sharing"
  | "reports"
  | "ai"
  | "plugins"
  | "administration"
  | "account-security"
  | "provisioning"
  | "grafana-import"
  | "installation"
  | "linux-binary"
  | "https"
  | "reverse-proxy"
  | "monitoring"
  | "backup"
  | "upgrading"
  | "offline"
  | "updates"
  | "high-availability"
  | "winget"
  | "sdk-typescript"
  | "sdk-go"
  | "glossary";

/** The page the handbook opens with. */
export const HANDBOOK_HOME: HandbookSlug = "overview";
