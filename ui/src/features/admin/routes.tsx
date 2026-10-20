import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { AdminPage } from "./AdminPage";

// The admin area's pages. Nested routes of this area go here too.
const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: AdminPage,
});

export const adminRoutes = [adminRoute] as const;
