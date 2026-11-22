import { getRouteApi, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Icon } from "../components/Icon";
import { useHandbookEnabled } from "../help/handbook";
import { type Language, useI18n } from "../i18n/i18n";
import { isTypingTarget } from "../shell/sidebarState";
import { Blocks } from "./Article";
import { HANDBOOK_GROUPS, HANDBOOK_HOME, type HandbookGroup } from "./catalog";
import {
  githubUrl,
  type HandbookPageData,
  type HandbookVersion,
  loadMarkdown,
  neighbours,
  PAGES,
  pageBySlug,
  pageLabel,
  resolveAnchor,
  safeDecode,
  versionOf,
} from "./content";
import { HandbookSearch, rememberRead } from "./HandbookSearch";
import { parseBlocks, withoutLanguageLine } from "./markdown";
import "./handbook.css";

/**
 * The handbook as a page (frames 2, 3, 8, 10, 11 and 14 of the board): the table of contents on
 * the left with the search, the article in the middle, "On this page" on the right. The page
 * follows the language of the interface; a page without a German version shows the English one
 * with a line that says so.
 */

declare const __KALZIT_VERSION__: string;

const route = getRouteApi("/_app/handbook/$page");

type Loaded = { url: string; state: "done"; text: string } | { url: string; state: "failed" };

function useMarkdown(version: HandbookVersion | undefined): Loaded | undefined {
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  useEffect(() => {
    if (version === undefined) return undefined;
    let current = true;
    loadMarkdown(version).then(
      (text) => current && setLoaded({ url: version.url, state: "done", text }),
      () => current && setLoaded({ url: version.url, state: "failed" }),
    );
    return () => {
      current = false;
    };
  }, [version]);
  return loaded?.url === version?.url ? loaded : undefined;
}

/** The keys that turn the pages (shell/ShortcutsHelp.tsx lists them). */
const PAGE_KEYS: Record<string, "previous" | "next" | undefined> = {
  "[": "previous",
  "]": "next",
  k: "previous",
  j: "next",
};

export function HandbookPage() {
  const { t } = useI18n();
  const enabled = useHandbookEnabled();
  if (!enabled) {
    return (
      <div className="hb-state">
        <h1 className="hb-state__title">{t("handbook.off.title")}</h1>
        <p className="hb-state__text">{t("handbook.off.text")}</p>
      </div>
    );
  }
  return <Handbook />;
}

function Handbook() {
  const { t, language } = useI18n();
  const { page: slug } = route.useParams();
  const { lang } = route.useSearch();
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const page = pageBySlug(slug);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [contentsOpen, setContentsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);

  const wanted: Language = lang ?? language;
  const shown = page === undefined ? undefined : versionOf(page, wanted);
  const version = shown?.version;
  const loaded = useMarkdown(version);
  const blocks = useMemo(
    () => (loaded?.state === "done" ? parseBlocks(withoutLanguageLine(loaded.text)) : undefined),
    [loaded],
  );
  const anchor = hash === "" ? "" : safeDecode(hash);
  const resolved =
    page === undefined || version === undefined || anchor === ""
      ? undefined
      : resolveAnchor(page, version, anchor);
  const missingSection = blocks !== undefined && anchor !== "" && resolved === undefined;

  // The window title says the page, the handbook and Kalzit: the handbook keeps the name it is
  // written for, also on a server with a product name of its own (decision 8).
  const title = version === undefined ? t("handbook.notFound.title") : version.title;
  useEffect(() => {
    document.title = `${title} · ${t("handbook.title")} · Kalzit`;
  }, [title, t]);

  // Open at the section the address names, else at the title, which takes the focus (11B), but
  // never from a field the person moved to while the page loaded (the search after "/").
  useEffect(() => {
    if (blocks === undefined) return;
    if (resolved !== undefined) {
      document.getElementById(resolved)?.scrollIntoView?.({ block: "start" });
      return;
    }
    if (!isTypingTarget(document.activeElement)) {
      titleRef.current?.focus({ preventScroll: true });
    }
    window.scrollTo?.({ top: 0 });
  }, [blocks, resolved]);

  useEffect(() => {
    if (page !== undefined) rememberRead({ slug: page.slug, anchor: resolved ?? "" });
  }, [page, resolved]);

  // "/" searches the handbook and "[" and "]" turn the pages, outside text fields (11A); "k" and
  // "j" turn them too, since brackets need AltGr on German keyboards. The listener runs before
  // the app's own "/" (the command palette), which skips a handled key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target) || document.querySelector("[role=dialog]") !== null) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      const turn = PAGE_KEYS[event.key];
      if (turn !== undefined && page !== undefined) {
        const { previous, next } = neighbours(page.slug);
        const to = turn === "previous" ? previous : next;
        if (to !== undefined) {
          event.preventDefault();
          void navigate({ to: "/handbook/$page", params: { page: to.slug } });
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [page, navigate]);

  const current = useCurrentSection(blocks, version);

  if (page === undefined || version === undefined || shown === undefined) {
    return (
      <Layout
        navRef={navRef}
        searchRef={searchRef}
        current={undefined}
        contentsOpen={contentsOpen}
        onContents={setContentsOpen}
      >
        <div className="hb-state">
          <h1 className="hb-state__title" ref={titleRef} tabIndex={-1}>
            {t("handbook.notFound.title")}
          </h1>
          <p className="hb-state__text">{t("handbook.notFound.text")}</p>
          <div className="hb-state__actions">
            <Link
              to="/handbook/$page"
              params={{ page: HANDBOOK_HOME }}
              className="button button--secondary"
            >
              {t("handbook.notFound.overview")}
            </Link>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => searchRef.current?.focus()}
            >
              {t("handbook.search.label")}
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  const { previous, next } = neighbours(page.slug);
  const otherLanguage: Language = shown.language === "de" ? "en" : "de";
  const hasOther = page.de !== null && page.de.file !== page.en.file;
  const headings = version.headings.filter((heading) => heading.level === 2 || heading.level === 3);

  return (
    <Layout
      navRef={navRef}
      searchRef={searchRef}
      current={page}
      contentsOpen={contentsOpen}
      onContents={(open) => {
        setContentsOpen(open);
        if (open) navRef.current?.querySelector<HTMLElement>("a")?.focus();
      }}
      toc={
        headings.length === 0 ? null : (
          <nav
            className="hb-toc"
            aria-label={t("handbook.onThisPage")}
            data-open={tocOpen || undefined}
          >
            <button
              type="button"
              className="hb-toc__toggle"
              aria-expanded={tocOpen}
              onClick={() => setTocOpen(!tocOpen)}
            >
              <span>{t("handbook.onThisPage")}</span>
              <span className="hb-toc__count">
                {t(`handbook.sections.${headings.length === 1 ? "one" : "other"}`, {
                  count: headings.length,
                })}
              </span>
              <Icon name="chevronDown" />
            </button>
            <p className="hb-toc__title">{t("handbook.onThisPage")}</p>
            <ul className="hb-toc__list">
              {headings.map((heading) => (
                <li key={heading.id} data-level={heading.level}>
                  <Link
                    to="/handbook/$page"
                    params={{ page: page.slug }}
                    search={lang === undefined ? {} : { lang }}
                    hash={heading.id}
                    className="hb-toc__link"
                    aria-current={heading.id === current ? "location" : undefined}
                    onClick={() => setTocOpen(false)}
                  >
                    {heading.text}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )
      }
    >
      <HandbookCrumbs page={page} language={language} />
      <article id="hb-article" className="hb-article" lang={shown.language}>
        {language === "de" && page.de === null ? (
          <p className="hb-note" lang={language}>
            {t("handbook.fallback")}
          </p>
        ) : lang !== undefined && lang !== language && shown.language === lang ? (
          <p className="hb-note" lang={language}>
            {t(`handbook.reading.${shown.language}`)}{" "}
            <Link
              to="/handbook/$page"
              params={{ page: page.slug }}
              {...(resolved === undefined ? {} : { hash: resolved })}
            >
              {t("handbook.showOwn")}
            </Link>
          </p>
        ) : null}
        {missingSection ? (
          <p className="hb-note" lang={language}>
            {t("handbook.missingSection")}
          </p>
        ) : null}
        {loaded === undefined ? (
          <h1 className="hb-title" ref={titleRef} tabIndex={-1}>
            {version.title}
          </h1>
        ) : loaded.state === "failed" ? (
          <Stale />
        ) : (
          <Blocks
            blocks={blocks ?? []}
            context={{ file: version.file, slug: page.slug }}
            titleRef={titleRef}
          />
        )}
        <footer className="hb-footer" lang={language}>
          <nav className="hb-pager" aria-label={t("handbook.title")}>
            {next === undefined ? null : (
              <Link
                to="/handbook/$page"
                params={{ page: next.slug }}
                className="hb-pager__link hb-pager__link--next"
                aria-keyshortcuts="]"
              >
                <span className="hb-pager__label">{t("handbook.next")}</span>
                <span className="hb-pager__page">{pageLabel(next, language)}</span>
              </Link>
            )}
            {previous === undefined ? null : (
              <Link
                to="/handbook/$page"
                params={{ page: previous.slug }}
                className="hb-pager__link hb-pager__link--previous"
                aria-keyshortcuts="["
              >
                <span className="hb-pager__label">{t("handbook.previous")}</span>
                <span className="hb-pager__page">{pageLabel(previous, language)}</span>
              </Link>
            )}
          </nav>
          <p className="hb-footer__meta">
            <span>{t("handbook.version", { version: __KALZIT_VERSION__ })}</span>
            <a
              href={githubUrl(version)}
              target="_blank"
              rel="noopener noreferrer"
              title={t("handbook.opensGithub")}
            >
              {t("handbook.github")}
              <Icon name="external" />
            </a>
            {hasOther ? (
              <Link
                to="/handbook/$page"
                params={{ page: page.slug }}
                search={otherLanguage === language ? {} : { lang: otherLanguage }}
                {...(resolved === undefined ? {} : { hash: resolved })}
                lang={otherLanguage}
              >
                {t(`handbook.readIn.${otherLanguage}`)}
              </Link>
            ) : null}
          </p>
        </footer>
      </article>
    </Layout>
  );
}

function Stale() {
  const { t } = useI18n();
  return (
    <div className="hb-state">
      <h1 className="hb-state__title">{t("handbook.stale.title")}</h1>
      <p className="hb-state__text">{t("handbook.stale.text")}</p>
      <button
        type="button"
        className="button button--primary"
        onClick={() => window.location.reload()}
      >
        {t("handbook.stale.reload")}
      </button>
    </div>
  );
}

function HandbookCrumbs({ page, language }: { page: HandbookPageData; language: Language }) {
  const { t } = useI18n();
  return (
    <Breadcrumbs
      crumbs={[
        {
          label: t("handbook.title"),
          link: { to: "/handbook/$page", params: { page: HANDBOOK_HOME } },
        },
        { label: t(`handbook.group.${page.group}`) },
        { label: pageLabel(page, language) },
      ]}
    />
  );
}

/** The section being read: the last heading above the upper third of the window (11B). */
function useCurrentSection(
  blocks: unknown,
  version: HandbookVersion | undefined,
): string | undefined {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (
      blocks === undefined ||
      version === undefined ||
      typeof IntersectionObserver === "undefined"
    ) {
      return undefined;
    }
    const elements = [...document.querySelectorAll<HTMLElement>(".hb-article [data-section]")];
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const first = elements.find((element) => visible.has(element.id));
        if (first !== undefined) {
          setCurrent(first.id);
          return;
        }
        // None in view: the last heading above it.
        const above = elements.filter((element) => element.getBoundingClientRect().top < 0).pop();
        setCurrent(above?.id);
      },
      { rootMargin: "0px 0px -66% 0px" },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [blocks, version]);
  return current;
}

function Layout({
  children,
  toc,
  current,
  navRef,
  searchRef,
  contentsOpen,
  onContents,
}: {
  children: React.ReactNode;
  toc?: React.ReactNode;
  current: HandbookPageData | undefined;
  navRef: React.RefObject<HTMLElement | null>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  contentsOpen: boolean;
  onContents: (open: boolean) => void;
}) {
  const { t, language } = useI18n();
  const groups = HANDBOOK_GROUPS.map((group) => ({
    group,
    pages: PAGES.filter((page) => page.group === group),
  })).filter((entry) => entry.pages.length > 0);
  return (
    <div className="hb">
      <a className="hb-skip" href="#hb-article">
        {t("handbook.skip")}
      </a>
      <div className="hb-side">
        <HandbookSearch inputRef={searchRef} onShowContents={() => onContents(true)} />
        <button
          type="button"
          className="hb-side__toggle button button--secondary button--small"
          aria-expanded={contentsOpen}
          onClick={() => onContents(!contentsOpen)}
        >
          <Icon name="rows" />
          {t("handbook.contentsShort")}
        </button>
        <nav
          ref={navRef}
          className="hb-nav"
          aria-label={t("handbook.contents")}
          data-open={contentsOpen || undefined}
        >
          {groups.map(({ group, pages }) => (
            <NavGroup
              key={group}
              group={group}
              pages={pages}
              current={current}
              language={language}
            />
          ))}
          <p className="hb-nav__about">
            <span>{t("handbook.version", { version: __KALZIT_VERSION__ })}</span>
            <span>{t("handbook.offline")}</span>
          </p>
        </nav>
      </div>
      <div className="hb-main">{children}</div>
      {toc ?? <div />}
    </div>
  );
}

function NavGroup({
  group,
  pages,
  current,
  language,
}: {
  group: HandbookGroup;
  pages: HandbookPageData[];
  current: HandbookPageData | undefined;
  language: Language;
}) {
  const { t } = useI18n();
  return (
    <div className="hb-nav__group">
      <p className="hb-nav__heading">{t(`handbook.group.${group}`)}</p>
      <ul className="hb-nav__list">
        {pages.map((page) => {
          const englishOnly = language === "de" && page.de === null;
          return (
            <li key={page.slug}>
              <Link
                to="/handbook/$page"
                params={{ page: page.slug }}
                className="hb-nav__link"
                aria-current={page === current ? "page" : undefined}
                activeOptions={{ exact: true, includeHash: false, includeSearch: false }}
              >
                <span className="truncate" title={pageLabel(page, language)}>
                  {pageLabel(page, language)}
                </span>
                {englishOnly ? (
                  <span className="hb-mark" title={t("handbook.language.en")}>
                    {t("handbook.mark.en")}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
