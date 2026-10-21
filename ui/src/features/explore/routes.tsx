import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";

// The explore area's pages. Nested routes of this area go here too.
const exploreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore",
  component: lazyRouteComponent(() => import("./ExplorePage"), "ExplorePage"),
});

export const exploreRoutes = [exploreRoute] as const;
