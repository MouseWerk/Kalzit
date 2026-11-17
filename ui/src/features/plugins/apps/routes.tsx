import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../../app/baseRoutes";

/** A page of an app plugin, under Kalzit's bar (docs/api/plugins.md, "App plugins"). */
const appPageRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/apps/$appId/$pageId",
  component: lazyRouteComponent(() => import("./AppPage"), "AppPage"),
});

export const appsRoutes = [appPageRoute];
