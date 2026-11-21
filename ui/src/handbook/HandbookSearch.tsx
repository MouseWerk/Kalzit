import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { type Language, useI18n } from "../i18n/i18n";
import { setOverlay } from "../shell/overlay";
import { keyLabel } from "../shell/sidebarState";
import { loadSearchIndex, pageBySlug, pageLabel, versionOf } from "./content";
import { type Hit, search } from "./search";
import "../shell/shellUx.css";
import "./handbook.css";

/**
 * The handbook's search (frame 6): a combobox over both languages, the language of the interface
 * first and the other below, marked. Before the first letter it offers what was read recently in
 * this session and three fixed ways in. Searching happens in the browser; the indexes load on the
 * first search.
 */

const RECENT_KEY = "kalzit.handbook.recent";
const FREQUENT = ["getting-started", "query-languages", "glossary"];
const OWN_LIMIT = 8;
const OTHER_LIMIT = 5;

export interface RecentEntry {
  slug: string;
  anchor: string;
}

export function readRecent(): RecentEntry[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is RecentEntry =>
        typeof entry?.slug === "string" && typeof entry?.anchor === "string",
    );
  } catch {
    return [];
  }
}

/** Remembers a page (and section) as read, for this session in this browser only. */
export function rememberRead(entry: RecentEntry): void {
  try {
    const rest = readRecent().filter((old) => old.slug !== entry.slug);
    sessionStorage.setItem(RECENT_KEY, JSON.stringify([entry, ...rest].slice(0, 3)));
  } catch {
    // Storage may be blocked; the list stays empty then.
  }
}

interface Option {
  key: string;
  slug: string;
  anchor: string;
  /** Set when the option opens the page in the other language. */
  language: Language | undefined;
  page: string;
  section: string;
  hit?: Hit | undefined;
}

interface Group {
  key: string;
  heading: string;
  mark?: string | undefined;
  options: Option[];
}

type Results =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed" }
  | { state: "done"; query: string; own: Hit[]; other: Hit[] };

export function HandbookSearch({
  inputRef,
  onShowContents,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** "Show the contents" when nothing is found. */
  onShowContents: () => void;
}) {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const id = useId();
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<Results>({ state: "idle" });
  const boxRef = useRef<HTMLDivElement>(null);
  const other: Language = language === "de" ? "en" : "de";

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      setResults({ state: "idle" });
      return undefined;
    }
    let current = true;
    setResults((previous) => (previous.state === "done" ? previous : { state: "loading" }));
    Promise.all([loadSearchIndex(language), loadSearchIndex(other)]).then(
      ([ownIndex, otherIndex]) => {
        if (!current) return;
        const own = search(ownIndex, trimmed, OWN_LIMIT);
        // The other language adds what the own one does not have: pages only it has, and
        // sections found there by a word of that language.
        const seen = new Set(own.map((hit) => `${hit.entry.p}#${hit.entry.a}`));
        const otherHits = search(otherIndex, trimmed, OTHER_LIMIT * 3)
          .filter((hit) => !seen.has(`${hit.entry.p}#${hit.entry.a}`))
          .filter((hit) => {
            // A page in both languages is found under its own name already when the words match.
            const page = pageBySlug(hit.entry.p);
            return page === undefined || page.en.file !== page.de?.file;
          })
          .slice(0, OTHER_LIMIT);
        setResults({ state: "done", query: trimmed, own, other: otherHits });
        setActive(0);
      },
      () => {
        if (current) setResults({ state: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [query, language, other]);

  const optionOf = (hit: Hit, hitLanguage: Language | undefined): Option => ({
    key: `${hitLanguage ?? language}:${hit.entry.p}#${hit.entry.a}`,
    slug: hit.entry.p,
    anchor: hit.entry.a,
    language: hitLanguage,
    page: hit.entry.t,
    section: hit.entry.h === "" ? t("handbook.pageStart") : hit.entry.h,
    hit,
  });

  const pageOption = (slug: string, anchor: string, prefix: string): Option | undefined => {
    const page = pageBySlug(slug);
    if (page === undefined) return undefined;
    const { version } = versionOf(page, language);
    const heading = version.headings.find((candidate) => candidate.id === anchor);
    return {
      key: `${prefix}:${slug}#${anchor}`,
      slug,
      anchor,
      language: undefined,
      page: pageLabel(page, language),
      section: heading?.text ?? "",
    };
  };

  const groups: Group[] = [];
  if (results.state === "done") {
    if (results.own.length > 0) {
      groups.push({
        key: "own",
        heading: t(`handbook.search.hits.${results.own.length === 1 ? "one" : "other"}`, {
          count: results.own.length,
        }),
        options: results.own.map((hit) => optionOf(hit, undefined)),
      });
    }
    if (results.other.length > 0) {
      const count = results.other.length === 1 ? "one" : "other";
      groups.push({
        key: "other",
        heading: t(`handbook.search.hitsIn.${other}.${count}`, { count: results.other.length }),
        mark: t(`handbook.mark.${other}`),
        options: results.other.map((hit) => optionOf(hit, other)),
      });
    }
  } else if (query.trim() === "") {
    const recent = readRecent()
      .map((entry) => pageOption(entry.slug, entry.anchor, "recent"))
      .filter((option): option is Option => option !== undefined);
    if (recent.length > 0) {
      groups.push({ key: "recent", heading: t("handbook.search.recent"), options: recent });
    }
    groups.push({
      key: "frequent",
      heading: t("handbook.search.frequent"),
      options: FREQUENT.map((slug) => pageOption(slug, "", "frequent")).filter(
        (option): option is Option => option !== undefined,
      ),
    });
  }
  const options = groups.flatMap((group) => group.options);
  const shown = Math.min(active, Math.max(0, options.length - 1));
  const activeOption = options[shown];
  const nothing = results.state === "done" && options.length === 0;
  const total = results.state === "done" ? results.own.length + results.other.length : 0;

  function choose(option: Option) {
    setOpen(false);
    setQuery("");
    void navigate({
      to: "/handbook/$page",
      params: { page: option.slug },
      search: option.language === undefined ? {} : { lang: option.language },
      ...(option.anchor === "" ? {} : { hash: option.anchor }),
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (options.length > 0) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((shown + step + options.length) % options.length);
      }
    } else if (event.key === "Enter") {
      if (open && activeOption !== undefined) {
        event.preventDefault();
        choose(activeOption);
      }
    } else if (event.key === "Escape") {
      if (open || query !== "") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        setQuery("");
      }
    }
  }

  const announcement =
    results.state === "done"
      ? nothing
        ? t("handbook.search.none.title", { query: results.query })
        : t(`handbook.search.hits.${total === 1 ? "one" : "other"}`, { count: total })
      : "";

  return (
    <div ref={boxRef} className="hb-search">
      <label className="hb-search__field">
        <Icon name="search" />
        <span className="visually-hidden">{t("handbook.search.label")}</span>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeOption !== undefined ? `${id}-${activeOption.key}` : undefined
          }
          placeholder={t("handbook.search.label")}
          value={query}
          aria-keyshortcuts="/"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={(event) => {
            // The list's buttons keep it open; anything else closes it.
            if (!boxRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="kbd hb-search__key" aria-hidden="true">
          /
        </span>
      </label>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {open ? (
        <div className="hb-search__popup">
          {results.state === "loading" ? (
            <p className="hb-search__state">{t("handbook.search.loading")}</p>
          ) : results.state === "failed" ? (
            <p className="hb-search__state">{t("handbook.stale.text")}</p>
          ) : null}
          {nothing && results.state === "done" ? (
            <div className="hb-search__none">
              <p className="hb-search__none-title">
                {t("handbook.search.none.title", { query: results.query })}
              </p>
              <p className="hb-search__state">{t("handbook.search.none.text")}</p>
              <div className="hb-search__ways">
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => {
                    setOpen(false);
                    onShowContents();
                  }}
                >
                  {t("handbook.search.none.contents")}
                </button>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => choose({ ...emptyOption, slug: "glossary", key: "glossary" })}
                >
                  {t("handbook.search.none.glossary")}
                </button>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => {
                    setOpen(false);
                    setOverlay("palette");
                  }}
                >
                  {t("handbook.search.none.kalzit")}
                </button>
              </div>
            </div>
          ) : null}
          <div
            id={listId}
            role="listbox"
            aria-label={t("handbook.search.results")}
            className="hb-search__list"
          >
            {groups.map((group) => (
              // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox
              <div key={group.key} role="group" aria-labelledby={`${id}-${group.key}`}>
                <p id={`${id}-${group.key}`} className="hb-search__group">
                  {group.heading}
                </p>
                {group.options.map((option) => {
                  const selected = option === activeOption;
                  return (
                    // Options are reached from the field with the arrow keys
                    // (aria-activedescendant), so they are not focusable themselves.
                    // biome-ignore lint/a11y/useFocusableInteractive: the combobox keeps focus.
                    // biome-ignore lint/a11y/useKeyWithClickEvents: Enter in the field opens it.
                    <div
                      key={option.key}
                      id={`${id}-${option.key}`}
                      role="option"
                      aria-selected={selected}
                      className="hb-search__option"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => choose(option)}
                      lang={option.language}
                    >
                      <span className="hb-search__where">
                        <span className="hb-search__page">{option.page}</span>
                        {option.section === "" ? null : (
                          <span className="hb-search__section">{option.section}</span>
                        )}
                        {group.mark === undefined ? null : (
                          <span className="hb-mark">{group.mark}</span>
                        )}
                      </span>
                      {option.hit?.snippet == null ? null : (
                        <span className="hb-search__snippet">
                          {option.hit.snippet.before}
                          {option.hit.snippet.match === "" ? null : (
                            <mark>{option.hit.snippet.match}</mark>
                          )}
                          {option.hit.snippet.after}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="hb-search__keys" aria-hidden="true">
            <span>
              <kbd className="kbd">{"↑"}</kbd>
              <kbd className="kbd">{"↓"}</kbd> {t("handbook.search.keys.select")}
            </span>
            <span>
              <kbd className="kbd">{keyLabel("Enter")}</kbd> {t("handbook.search.keys.open")}
            </span>
            <span>
              <kbd className="kbd">{keyLabel("Esc")}</kbd> {t("handbook.search.keys.close")}
            </span>
          </p>
        </div>
      ) : null}
    </div>
  );
}

const emptyOption: Option = {
  key: "",
  slug: "",
  anchor: "",
  language: undefined,
  page: "",
  section: "",
};
