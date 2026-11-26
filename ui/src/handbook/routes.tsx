import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { appRoute } from "../app/baseRoutes";
import { loadArea } from "../i18n/i18n";
import { HANDBOOK_HOME } from "./catalog";

/**
 * The built-in handbook (docs/design/blueprint/Handbook.dc.html): `/handbook/<page>#<section>`,
 * for everyone signed in. Not under `/public`: the pages of public links and snapshots have no way
 * into it. Its texts, pages and search load with it, never with the first page.
 */

export interface HandbookPageSearch {
  /** A page opened in the other language than the interface's, from a search hit (8B). */
  lang?: "en" | "de" | undefined;
}

const handbookIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/handbook",
  beforeLoad: () => {
    throw redirect({ to: "/handbook/$page", params: { page: HANDBOOK_HOME }, replace: true });
  },
});

export const handbookPageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/handbook/$page",
  validateSearch: (search: Record<string, unknown>): HandbookPageSearch => ({
    lang: search.lang === "en" || search.lang === "de" ? search.lang : undefined,
  }),
  component: lazyRouteComponent(
    () => loadArea("handbook").then(() => import("./HandbookPage")),
    "HandbookPage",
  ),
});

export const handbookRoutes = [handbookIndexRoute, handbookPageRoute];
