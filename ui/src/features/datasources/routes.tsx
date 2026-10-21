import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { DataSourcesPage } from "./DataSourcesPage";
import { EditDataSourcePage, NewDataSourcePage } from "./DataSourceForm";

export interface DataSourcesSearch {
  /** A data source just moved to the trash; the list offers to restore it. */
  deleted?: string | undefined;
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
  }),
  component: DataSourcesPage,
});

const newDatasourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources/new",
  validateSearch: (search: Record<string, unknown>): NewDataSourceSearch => ({
    kind: typeof search.kind === "string" ? search.kind : undefined,
  }),
  component: NewDataSourcePage,
});

const editDatasourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/data-sources/$datasourceId",
  component: EditDataSourcePage,
});

export const datasourcesRoutes = [
  datasourcesRoute,
  newDatasourceRoute,
  editDatasourceRoute,
] as const;
