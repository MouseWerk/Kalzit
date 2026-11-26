import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { loadArea } from "../../i18n/i18n";

export interface DashboardsSearch {
  folder?: string | undefined;
  q?: string | undefined;
  /**
   * Opens the dialog for a new dashboard, a new folder or an import (from the command palette,
   * the start page and the top bar's New menu).
   */
  create?: "dashboard" | "folder" | "import" | undefined;
  /** Instead of a folder: the caller's starred or recently opened dashboards. */
  view?: "starred" | "recent" | undefined;
  /** The list order; newest change first when left out (last opened first in "recent"). */
  sort?: "updated" | "title" | "opened" | undefined;
  /** Only dashboards with this tag. */
  tag?: string | undefined;
}

export interface DashboardSearch {
  /** A time range other than the dashboard's own, as text ("now-1h"), so links can share it. */
  from?: string | undefined;
  to?: string | undefined;
  /** Opens in edit mode, as after creating a dashboard. */
  edit?: boolean | undefined;
  /** Kiosk mode (no controls) or TV mode (controls that hide themselves). */
  kiosk?: "kiosk" | "tv" | undefined;
  /** A panel shown alone, full screen. */
  viewPanel?: string | undefined;
  /** The section of the settings page (`/dashboards/{id}/settings`); General when left out. */
  section?: string | undefined;
}

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

// The dashboards area's pages. Nested routes of this area go here too. Pages load on their first
// visit, so the bundle every page needs stays small.
const dashboardsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards",
  validateSearch: (search: Record<string, unknown>): DashboardsSearch => ({
    folder: text(search.folder),
    q: text(search.q),
    create:
      search.create === "dashboard" || search.create === "folder" || search.create === "import"
        ? search.create
        : undefined,
    view: search.view === "starred" || search.view === "recent" ? search.view : undefined,
    sort:
      search.sort === "updated" || search.sort === "title" || search.sort === "opened"
        ? search.sort
        : undefined,
    tag: text(search.tag),
  }),
  component: lazyRouteComponent(() => import("./DashboardsPage"), "DashboardsPage"),
});

const trashRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/trash",
  component: lazyRouteComponent(() => import("./TrashPage"), "TrashPage"),
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/$dashboardId",
  validateSearch: (search: Record<string, unknown>): DashboardSearch => ({
    from: text(search.from),
    to: text(search.to),
    edit: search.edit === true || search.edit === "true" ? true : undefined,
    kiosk:
      search.kiosk === "tv"
        ? "tv"
        : search.kiosk === "kiosk" || search.kiosk === true
          ? "kiosk"
          : undefined,
    // `panel` is how alert notifications link to the panel of a rule (docs/api/alerting.md).
    viewPanel: text(search.viewPanel) ?? text(search.panel),
    section: text(search.section),
  }),
  component: lazyRouteComponent(() => import("./DashboardPage"), "DashboardPage"),
});

// The full-page panel editor. A child of the dashboard, so the dashboard and its unsaved draft
// stay mounted while a panel is edited; the dashboard page draws the editor in place of the grid.
const panelEditRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "panels/$panelId/edit",
  component: () => null,
});

// A panel being added: the same editor, the panel joins the dashboard when it is applied.
const panelNewRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "panels/new",
  component: () => null,
});

// The dashboard's settings as a page; like the panel editor a child of the dashboard, so its
// unsaved draft stays mounted, and the dashboard page draws the settings in place of the grid.
const settingsRoute = createRoute({
  getParentRoute: () => dashboardRoute,
  path: "settings",
  component: () => null,
});

const playlistsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/playlists",
  component: lazyRouteComponent(() => import("./PlaylistsPage"), "PlaylistsPage"),
});

const playlistPlayRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/playlists/$playlistId/play",
  component: lazyRouteComponent(() => import("./PlaylistPlayer"), "PlaylistPlayer"),
});

const libraryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/library",
  component: lazyRouteComponent(() => import("./LibraryPanelsPage"), "LibraryPanelsPage"),
});

const versionsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/$dashboardId/versions",
  component: lazyRouteComponent(() => import("./VersionsPage"), "VersionsPage"),
});

// The Grafana dashboard import in steps (features/provisioning), under Dashboards.
const grafanaImportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/import/grafana",
  validateSearch: (search: Record<string, unknown>): { folder?: string | undefined } => ({
    folder: text(search.folder),
  }),
  component: lazyRouteComponent(
    () => loadArea("provisioning").then(() => import("../provisioning/GrafanaImportPage")),
    "GrafanaImportPage",
  ),
});

// The report of the import that made a dashboard; it stays with the dashboard.
const importReportRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/$dashboardId/import-report",
  component: lazyRouteComponent(
    () => loadArea("provisioning").then(() => import("../provisioning/ImportReport")),
    "ImportReportPage",
  ),
});

// A snapshot inside the organization (features/sharing): the frozen results of a dashboard.
const snapshotRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/dashboards/$dashboardId/snapshots/$snapshotId",
  component: lazyRouteComponent(
    () => loadArea("sharing").then(() => import("../sharing/SnapshotPage")),
    "SnapshotPage",
  ),
});

export const dashboardsRoutes = [
  dashboardsRoute,
  trashRoute,
  dashboardRoute.addChildren([panelEditRoute, panelNewRoute, settingsRoute]),
  versionsRoute,
  grafanaImportRoute,
  importReportRoute,
  snapshotRoute,
  playlistsRoute,
  playlistPlayRoute,
  libraryRoute,
] as const;
