import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";

export interface DataSourcesSearch {
  /** A data source just moved to the trash; the list offers to restore it. */
  deleted?: string | undefined;
  /** Lists the trash instead. */
  trash?: boolean | undefined;
}

export interface NewDataSourceSearch {
  kind?: string | undefined;
}

// The datasources area's pages. Nested routes of this area go here too.
const datasourcesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources",
  validateSearch: (search: Record<string, unknown>): DataSourcesSearch => ({
    deleted: typeof search.deleted === "string" ? search.deleted : undefined,
    trash: search.trash === true || search.trash === "true" ? true : undefined,
  }),
  component: lazyRouteComponent(() => import("./DataSourcesPage"), "DataSourcesPage"),
});

const newDatasourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources/new",
  validateSearch: (search: Record<string, unknown>): NewDataSourceSearch => ({
    kind: typeof search.kind === "string" ? search.kind : undefined,
  }),
  component: lazyRouteComponent(() => import("./DataSourceForm"), "NewDataSourcePage"),
});

const editDatasourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources/$datasourceId",
  component: lazyRouteComponent(() => import("./DataSourceForm"), "EditDataSourcePage"),
});

export const datasourcesRoutes = [
  datasourcesRoute,
  newDatasourceRoute,
  editDatasourceRoute,
] as const;
