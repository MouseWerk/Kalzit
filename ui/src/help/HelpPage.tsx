import { getRouteApi, Link } from "@tanstack/react-router";
import gettingStarted from "../../../docs/guide/getting-started.md?raw";
import installation from "../../../docs/guide/installation.md?raw";
import { AccessLayout } from "../auth/AccessLayout";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { markdown } from "../panels/text/markdown";
import "../auth/auth.css";

/**
 * The guide pages someone needs before they can sign in, shipped with the UI (and so with the
 * binary) and readable without an account: getting started and installation. They are the files
 * of docs/guide, rendered with the same safe Markdown renderer as text panels; links to other
 * guide pages lead to the repository, pictures are left out.
 */
export const HELP_PAGES = ["getting-started", "installation"] as const;
export type HelpPageName = (typeof HELP_PAGES)[number];

const SOURCES: Record<HelpPageName, string> = {
  "getting-started": gettingStarted,
  installation,
};

/** Where the whole guide lives, for the pages that are not shipped. */
export const GUIDE_URL = "https://github.com/MouseWerk/Kalzit/blob/main/docs/guide/";

const helpRoute = getRouteApi("/help/$page");

/**
 * Rewrites a guide page for the help route: links between shipped pages stay inside the app,
 * every other relative link points to the file in the repository, and pictures (whose files are
 * not shipped) are dropped.
 */
export function prepareGuide(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line))
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
      return `](${new URL(path, GUIDE_URL).href}${anchor})`;
    });
}

export function HelpPage() {
  const { t, language } = useI18n();
  const { page } = helpRoute.useParams();
  const name = HELP_PAGES.find((candidate) => candidate === page) ?? "getting-started";
  useDocumentTitle(`access.help.${name}`);

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
        <a className="help__full" href={GUIDE_URL} target="_blank" rel="noopener noreferrer">
          {t("access.help.full")}
          <Icon name="external" />
        </a>
      </nav>
      {language === "en" ? null : <p className="access__lead">{t("access.help.english")}</p>}
      <article className="access__card help__body" lang="en">
        {markdown(prepareGuide(SOURCES[name]), {}, 0)}
      </article>
    </AccessLayout>
  );
}
