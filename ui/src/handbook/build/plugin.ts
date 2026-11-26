import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { type CatalogPage, HANDBOOK_PAGES } from "../catalog.ts";
import {
  type Block,
  type HeadingInfo,
  headingsOf,
  imagesOf,
  linksOf,
  parseBlocks,
  resolveRepoPath,
  sectionsOf,
  titleOf,
  withoutLanguageLine,
} from "../markdown.ts";
import type { SearchEntry, SearchIndex } from "../search.ts";

/**
 * The handbook's content at build time (docs/design/blueprint/Handbook.dc.html, decisions 2, 3
 * and 5). The module `virtual:kalzit-handbook` lists every page of the catalog with its title,
 * headings and the address of its Markdown file, the pictures the pages show and the search index
 * of each language. The files themselves are assets of the bundle, each fetched when it is first
 * needed, so none of the text is part of a script; the server embeds them with the rest of the UI.
 *
 * The build fails when a page, a picture or a German section is missing: the headings of both
 * languages of a page must match one to one (by position and level), since a link to a section
 * finds it in the other language by its position. It fails as well for a link to a section
 * (`#anchor`, on the same page or another page of the handbook) that no heading has.
 */

export const HANDBOOK_MODULE = "virtual:kalzit-handbook";
const RESOLVED = `\0${HANDBOOK_MODULE}`;

export interface BuiltVersion {
  file: string;
  title: string;
  headings: HeadingInfo[];
}

export interface BuiltPage {
  slug: string;
  group: CatalogPage["group"];
  label?: CatalogPage["label"];
  en: BuiltVersion;
  de?: BuiltVersion;
}

export interface BuiltHandbook {
  pages: BuiltPage[];
  /** Pictures by their path in the repository ("docs/screenshots/x.png"). */
  images: string[];
  search: Record<"en" | "de", SearchIndex>;
}

function read(docs: string, file: string): Block[] {
  const path = join(docs, file);
  if (!existsSync(path)) {
    throw new Error(`handbook: ${file} is listed in src/handbook/catalog.ts but not in docs/`);
  }
  return parseBlocks(withoutLanguageLine(readFileSync(path, "utf8")));
}

function entries(slug: string, title: string, blocks: readonly Block[]): SearchEntry[] {
  return sectionsOf(blocks).map((section) => ({
    p: slug,
    a: section.id,
    t: title,
    h: section.heading,
    x: section.text,
  }));
}

/** Reads and checks every page of the catalog; `docs` is the repository's docs folder. */
export function buildHandbook(docs: string): BuiltHandbook {
  const pages: BuiltPage[] = [];
  const images = new Set<string>();
  const search: BuiltHandbook["search"] = {
    en: { language: "en", entries: [] },
    de: { language: "de", entries: [] },
  };
  const slugs = new Set<string>();
  const links: { file: string; hrefs: string[] }[] = [];
  for (const page of HANDBOOK_PAGES) {
    if (slugs.has(page.slug)) throw new Error(`handbook: ${page.slug} is listed twice`);
    slugs.add(page.slug);
    const version = (file: string, language: "en" | "de"): BuiltVersion => {
      const blocks = read(docs, file);
      const title = titleOf(blocks);
      if (title === undefined) throw new Error(`handbook: ${file} has no title (# heading)`);
      for (const src of imagesOf(blocks)) {
        if (/^[a-z][\w+.-]*:/i.test(src)) {
          throw new Error(`handbook: ${file} shows a picture from outside the program: ${src}`);
        }
        const path = resolveRepoPath(file, src);
        if (path === null || !existsSync(join(docs, "..", path))) {
          throw new Error(`handbook: ${file} shows ${src}, which is not in the repository`);
        }
        images.add(path);
      }
      search[language].entries.push(...entries(page.slug, title, blocks));
      links.push({ file, hrefs: linksOf(blocks) });
      return { file, title, headings: headingsOf(blocks) };
    };
    const en = version(page.en, "en");
    const de = page.de === undefined ? undefined : version(page.de, "de");
    if (de !== undefined && page.de !== page.en) {
      const shape = (v: BuiltVersion) => v.headings.map((h) => h.level).join(",");
      if (shape(en) !== shape(de)) {
        throw new Error(
          `handbook: the sections of ${page.de} do not match ${page.en} one to one ` +
            `(levels ${shape(de)} against ${shape(en)})`,
        );
      }
    }
    pages.push({
      slug: page.slug,
      group: page.group,
      ...(page.label === undefined ? {} : { label: page.label }),
      en,
      ...(de === undefined ? {} : { de }),
    });
  }
  checkAnchors(pages, links);
  return { pages, images: [...images].sort(), search };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Every link to a section must find a heading: on its own page, or on the handbook page it names
 * (in either language, as the app finds a section in the other language by its position).
 */
export function checkAnchors(
  pages: readonly BuiltPage[],
  links: readonly { file: string; hrefs: string[] }[],
) {
  const byFile = new Map<string, BuiltPage>();
  for (const page of pages) {
    byFile.set(`docs/${page.en.file}`, page);
    if (page.de !== undefined) byFile.set(`docs/${page.de.file}`, page);
  }
  const ids = (page: BuiltPage) =>
    new Set([...page.en.headings, ...(page.de?.headings ?? [])].map((heading) => heading.id));
  for (const { file, hrefs } of links) {
    for (const href of hrefs) {
      const target = href.trim();
      if (/^[a-z][\w+.-]*:/i.test(target) || !target.includes("#")) continue;
      const [path = "", anchor = ""] = target.split("#");
      if (anchor === "") continue;
      const page = byFile.get(path === "" ? `docs/${file}` : (resolveRepoPath(file, path) ?? ""));
      if (page === undefined) continue;
      if (!ids(page).has(decode(anchor))) {
        throw new Error(`handbook: ${file} links to ${href}, but ${page.slug} has no such section`);
      }
    }
  }
}

/** The ids Vite gets for a file: absolute, with forward slashes. */
function fileId(path: string): string {
  return path.replaceAll("\\", "/");
}

/** The source of `virtual:kalzit-handbook` for a built handbook. */
export function moduleSource(built: BuiltHandbook, repo: string, cache: string): string {
  const imports: string[] = [];
  const urlOf = (path: string): string => {
    const name = `u${imports.length}`;
    imports.push(`import ${name} from ${JSON.stringify(`${fileId(path)}?url`)};`);
    return name;
  };
  const version = (v: BuiltVersion) =>
    `{ file: ${JSON.stringify(v.file)}, url: ${urlOf(join(repo, "docs", v.file))}, title: ${JSON.stringify(v.title)}, headings: ${JSON.stringify(v.headings)} }`;
  const pages = built.pages.map(
    (page) =>
      `{ slug: ${JSON.stringify(page.slug)}, group: ${JSON.stringify(page.group)}, label: ${JSON.stringify(page.label ?? null)}, en: ${version(page.en)}, de: ${page.de === undefined ? "null" : version(page.de)} }`,
  );
  const images = built.images.map(
    (path) => `[${JSON.stringify(path)}, ${urlOf(join(repo, path))}]`,
  );
  mkdirSync(cache, { recursive: true });
  const search = (["en", "de"] as const).map((language) => {
    const file = join(cache, `handbook-search-${language}.json`);
    writeFileSync(file, JSON.stringify(built.search[language]));
    return `${language}: ${urlOf(file)}`;
  });
  return [
    ...imports,
    `export const PAGES = [\n${pages.join(",\n")}\n];`,
    `export const IMAGES = new Map([\n${images.join(",\n")}\n]);`,
    `export const SEARCH = { ${search.join(", ")} };`,
    "",
  ].join("\n");
}

/** The Vite plugin; `ui` is the UI's folder, whose parent holds docs/. */
export function handbook(ui: string): Plugin {
  const repo = resolve(ui, "..");
  const docs = join(repo, "docs");
  const cache = join(ui, "node_modules", ".cache", "kalzit-handbook");
  return {
    name: "kalzit-handbook",
    resolveId(id) {
      return id === HANDBOOK_MODULE ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const built = buildHandbook(docs);
      for (const page of built.pages) {
        this.addWatchFile(join(docs, page.en.file));
        if (page.de !== undefined) this.addWatchFile(join(docs, page.de.file));
      }
      return moduleSource(built, repo, cache);
    },
  };
}
