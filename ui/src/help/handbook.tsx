import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { brandingQuery } from "../appearance/api";
import { Icon } from "../components/Icon";
import { HANDBOOK_HOME, HANDBOOK_PAGES, type HandbookSlug } from "../handbook/catalog";
import { useI18n } from "../i18n/i18n";
import { DOCS_BASE_URL, REPOSITORY_URL } from "./docs";

/**
 * Links from the app into the built-in handbook (docs/design/blueprint/Handbook.dc.html). The
 * handbook itself loads with its page (src/handbook); these helpers only know the page names, so
 * they cost the first page load nothing.
 *
 * Every link names a page and, if it likes, a section by its English anchor; the handbook finds
 * the same section in German (src/handbook/content.ts, `resolveAnchor`). With the handbook turned
 * off (Administration > Appearance) a link leads to the page on GitHub as of this release.
 */

export type { HandbookSlug };

/** A place in the handbook: a page, and a section of it by its English anchor. */
export interface HandbookTarget {
  page: HandbookSlug;
  section?: string | undefined;
}

/** Whether the server shows the handbook (`appearance.handbook`, on unless an admin turned it off). */
export function useHandbookEnabled(): boolean {
  const branding = useQuery(brandingQuery);
  return branding.data?.handbook !== false;
}

/** The page on GitHub as of this release, in a language: the handbook's secondary link. */
export function githubPageUrl(target: HandbookTarget, language: "en" | "de"): string {
  const page = HANDBOOK_PAGES.find((candidate) => candidate.slug === target.page);
  if (page === undefined) return REPOSITORY_URL;
  // The anchor is English; on the German page GitHub opens at its start.
  const file = language === "de" && page.de !== undefined ? page.de : page.en;
  const hash = target.section === undefined || file !== page.en ? "" : `#${target.section}`;
  return `${DOCS_BASE_URL}docs/${file}${hash}`;
}

/**
 * Where the router goes for a place in the handbook. The one way into it from the app, so the
 * contextual help (the handbook next to the screen, F1) can take these links over later.
 */
export function handbookLocation(target: HandbookTarget) {
  return {
    to: "/handbook/$page" as const,
    params: { page: target.page },
    ...(target.section === undefined ? {} : { hash: target.section }),
  };
}

/** The handbook's start page. */
export const HANDBOOK_START: HandbookTarget = { page: HANDBOOK_HOME };

/**
 * A link to a place in the handbook, in the app's own tab. With the handbook turned off it opens
 * the page on GitHub in a new tab instead, marked as leading outside.
 */
export function HandbookLink({
  target,
  className,
  children,
}: {
  target: HandbookTarget;
  className?: string | undefined;
  children: ReactNode;
}) {
  const { language } = useI18n();
  const enabled = useHandbookEnabled();
  if (!enabled) {
    return (
      <a
        className={className}
        href={githubPageUrl(target, language)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
        <Icon name="external" />
      </a>
    );
  }
  return (
    <Link className={className} {...handbookLocation(target)}>
      {children}
    </Link>
  );
}
