import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../../app/baseRoutes";
import { loadArea } from "../../../i18n/i18n";

/** A page of an app plugin, under Kalzit's bar (docs/api/plugins.md, "App plugins"). */
const appPageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/apps/$appId/$pageId",
  component: lazyRouteComponent(() => loadArea("apps").then(() => import("./AppPage")), "AppPage"),
});

export const appsRoutes = [appPageRoute];
