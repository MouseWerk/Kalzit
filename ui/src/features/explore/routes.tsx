import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";

export interface ExploreSearch {
  /** A saved analysis to open (docs/api/analyses.md). */
  analysis?: string | undefined;
  /** A data source to start with (the sample data added at the end of setup). */
  source?: string | undefined;
}

export interface SavedSearch {
  folder?: string | undefined;
  q?: string | undefined;
  /** Only analyses on this data source. */
  source?: string | undefined;
  /** Only the caller's own analyses. */
  mine?: boolean | undefined;
  /** Newest change first (the default) or by name. */
  sort?: "updated" | "title" | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// The explore area's pages. Nested routes of this area go here too.
const exploreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore",
  validateSearch: (search: Record<string, unknown>): ExploreSearch => ({
    analysis: text(search.analysis),
    source: text(search.source),
  }),
  component: lazyRouteComponent(() => import("./ExplorePage"), "ExplorePage"),
});

// The saved analyses, a list of its own under Explore in the navigation.
const savedRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore/saved",
  validateSearch: (search: Record<string, unknown>): SavedSearch => ({
    folder: text(search.folder),
    q: text(search.q),
    source: text(search.source),
    mine: search.mine === true || search.mine === "true" ? true : undefined,
    sort: search.sort === "title" ? "title" : undefined,
  }),
  component: lazyRouteComponent(() => import("../analyses/AnalysesPage"), "AnalysesPage"),
});

const savedTrashRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore/saved/trash",
  component: lazyRouteComponent(() => import("../analyses/AnalysesTrashPage"), "AnalysesTrashPage"),
});

// One analysis to look at and run, for its readers without the editor (viewers included).
const savedViewRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore/saved/$analysisId",
  component: lazyRouteComponent(() => import("../analyses/AnalysisViewPage"), "AnalysisViewPage"),
});

const savedVersionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore/saved/$analysisId/versions",
  component: lazyRouteComponent(
    () => import("../analyses/AnalysisVersionsPage"),
    "AnalysisVersionsPage",
  ),
});

export const exploreRoutes = [
  exploreRoute,
  savedRoute,
  savedTrashRoute,
  savedViewRoute,
  savedVersionsRoute,
] as const;
