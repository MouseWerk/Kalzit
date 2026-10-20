import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { ExplorePage } from "./ExplorePage";

// The explore area's pages. Nested routes of this area go here too.
const exploreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/explore",
  component: ExplorePage,
});

export const exploreRoutes = [exploreRoute] as const;
