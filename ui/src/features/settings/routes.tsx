import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";

// The settings page with one address per section (`/settings/appearance`) and per setting (its
// row as the hash). Loaded on first use.

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./SettingsLayout"), "SettingsLayout"),
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./SectionPage"), "SettingsIndex"),
});

const sectionRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: "/$section",
  component: lazyRouteComponent(() => import("./SectionPage"), "SectionPage"),
});

// The earlier addresses of the settings pages lead to their sections.
const accountRedirect = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "profile" }, replace: true });
  },
});

export const settingsRoutes = [
  settingsRoute.addChildren([settingsIndexRoute, sectionRoute]),
  accountRedirect,
] as const;
