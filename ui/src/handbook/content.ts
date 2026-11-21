import {
  PAGES as BUILT_PAGES,
  type HandbookPageData as BuiltPage,
  type HandbookVersion,
  IMAGES,
  SEARCH,
} from "virtual:kalzit-handbook";
import { fetchOwnFile } from "../api/client";
import { DOCS_BASE_URL } from "../help/docs";
import type { Language } from "../i18n/i18n";
import type { HandbookGroup } from "./catalog";
import { resolveRepoPath } from "./markdown";
import { type PreparedIndex, prepare, type SearchIndex } from "./search";

/**
 * The handbook's pages in the browser: which version of a page to show in a language, where a
 * link of a page leads, and the Markdown files and search indexes, fetched once each.
 */

export type { HandbookVersion };

/** A page of the handbook as the build made it, in the order of the table of contents. */
export type HandbookPageData = Omit<BuiltPage, "group"> & { group: HandbookGroup };

// The build takes the groups from the catalog, so each is one of HANDBOOK_GROUPS.
export const PAGES = BUILT_PAGES as readonly HandbookPageData[];

export function pageBySlug(slug: string): HandbookPageData | undefined {
  return PAGES.find((page) => page.slug === slug);
}

/** The version of a page to show: the one asked for, else English (8A). */
export function versionOf(
  page: HandbookPageData,
  language: Language,
): { version: HandbookVersion; language: Language } {
  if (language === "de" && page.de !== null) {
    return { version: page.de, language: "de" };
  }
  return { version: page.en, language: "en" };
}

/** Whether a page has a German version of its own (the glossary is one file for both). */
export function hasGerman(page: HandbookPageData): boolean {
  return page.de !== null;
}

/** The name of a page in the table of contents. */
export function pageLabel(page: HandbookPageData, language: Language): string {
  return page.label?.[language] ?? versionOf(page, language).version.title;
}

/**
 * The anchor of a section in a version of a page. A link names the section in one language; the
 * other language finds it at the same position (the build checks that both match one to one).
 * Undefined when no version has the anchor (14A).
 */
export function resolveAnchor(
  page: HandbookPageData,
  version: HandbookVersion,
  anchor: string,
): string | undefined {
  if (version.headings.some((heading) => heading.id === anchor)) return anchor;
  for (const other of [page.en, page.de]) {
    if (other === null || other === version) continue;
    const position = other.headings.findIndex((heading) => heading.id === anchor);
    const match = position === -1 ? undefined : version.headings[position];
    if (match !== undefined) return match.id;
  }
  return undefined;
}

/** Where a link of a page leads. */
export type LinkTarget =
  | { kind: "page"; slug: string; anchor: string }
  | { kind: "anchor"; anchor: string }
  | { kind: "app"; path: string }
  | { kind: "external"; href: string };

const SCHEME = /^[a-z][\w+.-]*:/i;

/**
 * Resolves a link of a guide file (`from`, below docs/): another page of the handbook, a section
 * of this page, a screen of the app (`app:/admin/backups`, decision 7), or a file of the repository
 * as of this release on GitHub, or an address outside. Null for a link not to follow.
 */
export function resolveLink(from: string, href: string): LinkTarget | null {
  const target = href.trim();
  if (target.startsWith("app:")) {
    const path = target.slice("app:".length);
    return path.startsWith("/") && !path.startsWith("//") ? { kind: "app", path } : null;
  }
  if (target.startsWith("#"))
    return { kind: "anchor", anchor: decodeURIComponent(target.slice(1)) };
  if (SCHEME.test(target)) {
    return /^(https?|mailto):/i.test(target) ? { kind: "external", href: target } : null;
  }
  const [path = "", hash] = target.split("#");
  const repoPath = resolveRepoPath(from, path);
  if (repoPath === null) return null;
  const anchor = hash === undefined ? "" : decodeURIComponent(hash);
  const page = PAGES.find(
    (candidate) =>
      `docs/${candidate.en.file}` === repoPath ||
      (candidate.de !== null && `docs/${candidate.de.file}` === repoPath),
  );
  if (page !== undefined) return { kind: "page", slug: page.slug, anchor };
  return {
    kind: "external",
    href: `${DOCS_BASE_URL}${repoPath}${hash === undefined ? "" : `#${hash}`}`,
  };
}

/** The address of a picture in the bundle, for a picture link of a guide file. */
export function imageUrl(from: string, src: string): string | undefined {
  if (SCHEME.test(src)) return undefined;
  const path = resolveRepoPath(from, src);
  return path === null ? undefined : IMAGES.get(path);
}

/** The page on GitHub as of this release, the handbook's one link outside. */
export function githubUrl(version: HandbookVersion): string {
  return `${DOCS_BASE_URL}docs/${version.file}`;
}

/** A file of the bundle that could not be fetched: after an update the tab is older than the server. */
export class StaleBundleError extends Error {}

async function fetchText(url: string): Promise<string> {
  const file = await fetchOwnFile(url);
  if (file === null) throw new StaleBundleError(url);
  return file.text();
}

const texts = new Map<string, Promise<string>>();

/** A version's Markdown, fetched once; a failed fetch is tried again next time. */
export function loadMarkdown(version: HandbookVersion): Promise<string> {
  let text = texts.get(version.url);
  if (text === undefined) {
    text = fetchText(version.url);
    texts.set(version.url, text);
    text.catch(() => texts.delete(version.url));
  }
  return text;
}

const indexes = new Map<Language, Promise<PreparedIndex>>();

/** A language's search index, fetched on the first search and prepared once. */
export function loadSearchIndex(language: Language): Promise<PreparedIndex> {
  let index = indexes.get(language);
  if (index === undefined) {
    index = fetchText(SEARCH[language]).then((text) => prepare(JSON.parse(text) as SearchIndex));
    indexes.set(language, index);
    index.catch(() => indexes.delete(language));
  }
  return index;
}

/** The page before and after one, in the order of the table of contents. */
export function neighbours(slug: string): {
  previous: HandbookPageData | undefined;
  next: HandbookPageData | undefined;
} {
  const at = PAGES.findIndex((page) => page.slug === slug);
  return { previous: at > 0 ? PAGES[at - 1] : undefined, next: PAGES[at + 1] };
}
