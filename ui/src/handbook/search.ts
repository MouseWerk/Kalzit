/**
 * The handbook's search (docs/design/blueprint/Handbook.dc.html, frame 6 and decision 2): an
 * index per language made at build time (src/handbook/build/plugin.ts), loaded by the browser on
 * the first search and searched there. Search terms never leave the browser. No imports: the build
 * runs it in Node.
 *
 * Words are compared in lower case with umlauts written out ("kürzester" and "kuerzester" are the
 * same word), and a word of the query finds the words that start with its stem, so "kürzester"
 * also finds "kürzeste" and "Pfad" finds "Pfade". Every word of the query must be in the section;
 * titles and headings count more than the text.
 */

/** One section of a page in the index, with short keys: the file is shipped as it is. */
export interface SearchEntry {
  /** The page's slug. */
  p: string;
  /** The section's anchor; empty for the start of the page. */
  a: string;
  /** The page's title. */
  t: string;
  /** The section's heading; empty for the start of the page. */
  h: string;
  /** The section's text. */
  x: string;
}

export interface SearchIndex {
  language: "en" | "de";
  entries: SearchEntry[];
}

/** A word in the form the search compares: lower case, umlauts written out, no accents. */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of a text, normalized. */
export function words(text: string): string[] {
  return [...text.matchAll(WORD)].map(([word]) => normalizeWord(word));
}

// Endings of German and English word forms, longest first; a stem keeps at least four letters.
const ENDINGS = ["ungen", "ung", "ern", "en", "er", "es", "em", "e", "n", "s"];

/** The part of a query word other forms of it start with. */
export function stem(word: string): string {
  if (word.length < 5) return word;
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 4) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

/** Whether a word of the text matches a query word (its stem, or the whole short word). */
function matches(word: string, query: string): boolean {
  return query.length < 3 ? word === query : word.startsWith(query);
}

interface PreparedEntry {
  entry: SearchEntry;
  title: string[];
  heading: string[];
  text: string[];
}

export interface PreparedIndex {
  language: "en" | "de";
  entries: PreparedEntry[];
}

/** The index with its words split once, so each search only compares. */
export function prepare(index: SearchIndex): PreparedIndex {
  return {
    language: index.language,
    entries: index.entries.map((entry) => ({
      entry,
      title: words(entry.t),
      heading: words(entry.h),
      text: words(entry.x),
    })),
  };
}

/** The sentence a hit was found in, cut into the part before the word, the word and the rest. */
export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface Hit {
  entry: SearchEntry;
  score: number;
  snippet: Snippet | null;
}

const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 130;

/** The sentence around the first word of `text` that matches one of the query's stems. */
export function snippetOf(text: string, stems: readonly string[]): Snippet | null {
  for (const found of text.matchAll(WORD)) {
    const word = normalizeWord(found[0]);
    if (!stems.some((query) => matches(word, query))) continue;
    const at = found.index;
    const end = at + found[0].length;
    // From the start of the sentence, at most so far back.
    let from = Math.max(0, at - SNIPPET_BEFORE);
    const sentence = text.lastIndexOf(". ", at);
    const cutBefore = from > 0 && sentence < from;
    // A cut starts at a word, not inside one.
    if (cutBefore) from = Math.min(at, text.indexOf(" ", from) + 1 || at);
    if (!cutBefore && sentence !== -1) from = sentence + 2;
    let to = Math.min(text.length, end + SNIPPET_AFTER);
    const stop = text.indexOf(". ", end);
    const cutAfter = to < text.length && (stop === -1 || stop >= to);
    if (!cutAfter && stop !== -1) to = stop + 1;
    return {
      before: `${cutBefore ? "… " : ""}${text.slice(from, at)}`,
      match: text.slice(at, end),
      after: `${text.slice(end, to)}${cutAfter ? " …" : ""}`,
    };
  }
  return null;
}

/** The first sentence of a section, for a hit found only in its title or heading. */
function lead(text: string): Snippet | null {
  if (text === "") return null;
  const stop = text.indexOf(". ");
  const end = stop === -1 || stop > SNIPPET_AFTER ? Math.min(text.length, SNIPPET_AFTER) : stop + 1;
  return { before: "", match: "", after: `${text.slice(0, end)}${end < text.length ? " …" : ""}` };
}

/** The sections that hold every word of the query, best first. */
export function search(index: PreparedIndex, query: string, limit = 50): Hit[] {
  const stems = [...new Set(words(query).map(stem))];
  if (stems.length === 0) return [];
  const hits: (Hit & { order: number })[] = [];
  index.entries.forEach((prepared, order) => {
    let score = 0;
    for (const query of stems) {
      const inTitle = prepared.title.some((word) => matches(word, query));
      const inHeading = prepared.heading.some((word) => matches(word, query));
      const inText = prepared.text.filter((word) => matches(word, query)).length;
      if (!inTitle && !inHeading && inText === 0) return;
      // The title counts for the page's first section, where its text starts.
      score +=
        (inTitle && prepared.entry.a === "" ? 8 : inTitle ? 2 : 0) +
        (inHeading ? 6 : 0) +
        Math.min(inText, 5);
    }
    hits.push({
      entry: prepared.entry,
      score,
      snippet: snippetOf(prepared.entry.x, stems) ?? lead(prepared.entry.x),
      order,
    });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return hits.slice(0, limit).map(({ order: _, ...hit }) => hit);
}
