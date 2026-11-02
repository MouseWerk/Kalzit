import type { MessageKey, MessageParams, Translate } from "../i18n/i18n";

/**
 * The shared help layer (docs/guide/query-languages.md, "Start from zero"): typed registries of
 * guides, cheat sheets and tips, and the components that show them (`help/components`). A screen
 * defines its entries once, as data, and renders them with the shared components; nothing here
 * knows about a particular screen.
 */

/** A text of the help layer: a catalog key, with the values its placeholders need. */
export type HelpText = MessageKey | { key: MessageKey; params: MessageParams };

export function helpText(t: Translate, text: HelpText): string {
  return typeof text === "string" ? t(text) : t(text.key, text.params);
}

/**
 * One example in a help panel or a start panel: what it does in plain words, the code it stands
 * for, and what "Insert" hands to the screen. Without `value` the code is shown only, as a
 * pattern that does not run where the panel is (a dashboard variable in Explore).
 */
export interface Snippet<V = unknown> {
  id: string;
  title: HelpText;
  /** One or two sentences: what the pattern does and when to use it. */
  text?: HelpText;
  /** The code as the person reads and learns it. */
  code: string;
  value?: V;
  /** The group it is listed under (`filter`, `sort`, `time`, ...). */
  topic?: string;
}

/** A group of snippets in a help panel, in the order the panel lists them. */
export interface HelpTopic {
  id: string;
  title: MessageKey;
}

/** A fixed set of entries with unique ids, looked up by id. */
export interface Registry<T extends { id: string }> {
  get(id: string): T | undefined;
  all(): readonly T[];
}

/** A registry of `entries`; two entries with the same id are a programming error. */
export function defineRegistry<T extends { id: string }>(
  name: string,
  entries: readonly T[],
): Registry<T> {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error(`${name}: the id ${entry.id} is used twice`);
    }
    byId.set(entry.id, entry);
  }
  return { get: (id) => byId.get(id), all: () => entries };
}

/** Whether a snippet matches a search, by its words in the reader's language and its code. */
export function snippetMatches(t: Translate, snippet: Snippet, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    helpText(t, snippet.title),
    snippet.text === undefined ? "" : helpText(t, snippet.text),
    snippet.code,
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
