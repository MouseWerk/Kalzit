import { getRouteApi, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AccessLayout } from "../auth/AccessLayout";
import { Icon } from "../components/Icon";
import { type Language, useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { markdown } from "../panels/text/markdown";
import { GUIDE_URL } from "./docs";
import "../auth/auth.css";
import { HELP_PAGES, type HelpPageName } from "./helpPages";

/**
 * The guide pages someone needs before they can sign in, shipped with the UI (and so with the
 * binary) and readable without an account: getting started and installation, in the language
 * the page shows. They are the files of docs/guide (docs/guide/de in German), rendered with the
 * same safe Markdown renderer as text panels; links to other guide pages lead to the repository as
 * of this release, pictures are left out.
 */
export { HELP_PAGES, type HelpPageName };

const text = (module: { default: string }) => module.default;

// Each page and language is a chunk of its own, fetched when it is first shown, like the
// language catalogs (src/i18n/i18n.ts). Exported for tests.
export const GUIDE_SOURCES: Record<Language, Record<HelpPageName, () => Promise<string>>> = {
  en: {
    "getting-started": () => import("../../../docs/guide/getting-started.md?raw").then(text),
    installation: () => import("../../../docs/guide/installation.md?raw").then(text),
  },
  de: {
    "getting-started": () => import("../../../docs/guide/de/getting-started.md?raw").then(text),
    installation: () => import("../../../docs/guide/de/installation.md?raw").then(text),
  },
};

/** The guide's folder in a language: the English pages at the top, the German ones in de/. */
export function guideUrl(language: Language): string {
  return language === "en" ? GUIDE_URL : `${GUIDE_URL}${language}/`;
}

// The line on top of every guide page that links to the page in the other language; the help
// route switches the language with the UI instead.
const LANGUAGE_LINE =
  /^(English \| \[Deutsch\]\(de\/[\w-]+\.md\)|\[English\]\(\.\.\/[\w-]+\.md\) \| Deutsch)\s*$/;

const helpRoute = getRouteApi("/help/$page");

/** A loaded guide page and the language it is written in. */
interface LoadedGuide {
  language: Language;
  source: string;
}

/**
 * Loads a guide page in a language. A chunk can fail to load, for example in a tab that stayed
 * open across an update of the server; then the English page is the fallback, and only when that
 * fails too does the promise reject.
 */
export async function loadGuide(language: Language, name: HelpPageName): Promise<LoadedGuide> {
  try {
    return { language, source: await GUIDE_SOURCES[language][name]() };
  } catch (error) {
    if (language === "en") {
      throw error;
    }
    return { language: "en", source: await GUIDE_SOURCES.en[name]() };
  }
}

/**
 * Rewrites a guide page for the help route: links between shipped pages stay inside the app,
 * every other relative link points to the file in the repository (below `base`, the page's
 * folder there), and pictures (whose files are not shipped) and the language line are dropped.
 */
export function prepareGuide(source: string, base: string = GUIDE_URL): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line) && !LANGUAGE_LINE.test(line))
    .join("\n")
    .replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) {
        return whole;
      }
      const [path = "", hash] = target.split("#");
      const page = HELP_PAGES.find((name) => path === `${name}.md`);
      const anchor = hash === undefined ? "" : `#${hash}`;
      if (page !== undefined) {
        return `](/help/${page}${anchor})`;
      }
      return `](${new URL(path, base).href}${anchor})`;
    });
}

export function HelpPage() {
  const { t, language } = useI18n();
  const { page } = helpRoute.useParams();
  const name = HELP_PAGES.find((candidate) => candidate === page) ?? "getting-started";
  useDocumentTitle(`access.help.${name}`);
  const key = `${language}/${name}`;
  const [loaded, setLoaded] = useState<{ key: string; guide: LoadedGuide | null } | null>(null);

  useEffect(() => {
    let current = true;
    loadGuide(language, name).then(
      (guide) => {
        if (current) {
          setLoaded({ key, guide });
        }
      },
      () => {
        if (current) {
          setLoaded({ key, guide: null });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [language, name, key]);
  const shown = loaded?.key === key ? loaded : undefined;

  return (
    <AccessLayout width="done">
      <nav className="help__nav" aria-label={t("access.help.pages")}>
        {HELP_PAGES.map((candidate) => (
          <Link
            key={candidate}
            to="/help/$page"
            params={{ page: candidate }}
            className="help__tab"
            aria-current={candidate === name ? "page" : undefined}
          >
            {t(`access.help.${candidate}`)}
          </Link>
        ))}
        <a
          className="help__full"
          href={guideUrl(language)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("access.help.full")}
          <Icon name="external" />
        </a>
      </nav>
      <article
        className="access__card help__body"
        lang={shown?.guide?.language ?? language}
        aria-busy={shown === undefined}
      >
        {shown === undefined ? null : shown.guide === null ? (
          <p>
            {t("access.help.failed")}{" "}
            <a href={guideUrl(language)} target="_blank" rel="noopener noreferrer">
              {t("access.help.full")}
            </a>
          </p>
        ) : (
          markdown(prepareGuide(shown.guide.source, guideUrl(shown.guide.language)), {}, 0)
        )}
      </article>
    </AccessLayout>
  );
}
