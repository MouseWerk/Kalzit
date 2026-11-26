// The handbook's content, made at build time by src/handbook/build/plugin.ts.
declare module "virtual:kalzit-handbook" {
  export interface HandbookHeading {
    id: string;
    level: number;
    text: string;
  }

  export interface HandbookVersion {
    /** The file below docs/ ("guide/de/explore.md"). */
    file: string;
    /** The address of the Markdown file in the bundle. */
    url: string;
    title: string;
    headings: HandbookHeading[];
  }

  export interface HandbookPageData {
    slug: string;
    /** One of HANDBOOK_GROUPS (src/handbook/catalog.ts). */
    group: string;
    label: { en: string; de: string } | null;
    en: HandbookVersion;
    de: HandbookVersion | null;
  }

  export const PAGES: readonly HandbookPageData[];
  /** The address in the bundle of each picture, by its path in the repository. */
  export const IMAGES: ReadonlyMap<string, string>;
  /** The address in the bundle of each language's search index. */
  export const SEARCH: Readonly<Record<"en" | "de", string>>;
}
