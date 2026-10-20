import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { DataSourcesPage } from "./DataSourcesPage";

// The datasources area's pages. Nested routes of this area go here too.
const datasourcesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources",
  component: DataSourcesPage,
});

export const datasourcesRoutes = [datasourcesRoute] as const;
