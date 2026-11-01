import type { InstanceState } from "./instance/manager.ts";

/**
 * The named screens of a seeded instance. Paths may name ids of the seeded organization in
 * braces: {dashboardId}, {galleryId}, {sourceId}, {graphDashboardId}, {graphSourceId}.
 */
export interface Screen {
  name: string;
  path: string;
  /** Shown signed out (the sign-in page). */
  signedOut?: boolean;
  /** Needs the graph seed (instance_start with graph). */
  graph?: boolean;
}

export const MAIN_SCREENS: readonly Screen[] = [
  { name: "sign-in", path: "/login", signedOut: true },
  { name: "home", path: "/" },
  { name: "dashboards", path: "/dashboards" },
  { name: "dashboard", path: "/dashboards/{dashboardId}" },
  { name: "dashboard-gallery", path: "/dashboards/{galleryId}" },
  { name: "dashboard-history", path: "/dashboards/{dashboardId}/versions" },
  { name: "dashboard-trash", path: "/dashboards/trash" },
  { name: "explore", path: "/explore" },
  { name: "saved-analyses", path: "/explore/saved" },
  { name: "data-sources", path: "/data-sources" },
  { name: "data-source-kinds", path: "/data-sources/new" },
  { name: "data-source", path: "/data-sources/{sourceId}" },
  { name: "members", path: "/admin/members" },
  { name: "teams", path: "/admin/teams" },
  { name: "roles", path: "/admin/roles" },
  { name: "audit-log", path: "/admin/audit" },
  { name: "usage", path: "/admin/usage" },
  { name: "users", path: "/admin/server/users" },
  { name: "organizations", path: "/admin/server/organizations" },
  { name: "updates", path: "/admin/server/updates" },
  { name: "organization-settings", path: "/settings/organization" },
  { name: "server-settings", path: "/settings/appearance" },
  { name: "ai-settings", path: "/settings/ai" },
  { name: "account", path: "/settings/profile" },
  { name: "graph-dashboard", path: "/dashboards/{graphDashboardId}", graph: true },
  { name: "graph-source", path: "/data-sources/{graphSourceId}", graph: true },
];

/**
 * The screens to visit: every main screen (graph ones only with a graph seed), or the named ones
 * and raw paths (starting with "/") in `wanted`.
 */
export function selectScreens(
  wanted: readonly string[] | undefined,
  state: InstanceState,
): Screen[] {
  const hasGraph = state.seed?.graph !== undefined;
  const all = MAIN_SCREENS.filter((s) => hasGraph || s.graph !== true);
  if (wanted === undefined || wanted.length === 0) return all;
  return wanted.map((item) => {
    if (item.startsWith("/")) {
      return { name: slug(item), path: item };
    }
    const screen = MAIN_SCREENS.find((s) => s.name === item);
    if (screen === undefined) {
      throw new Error(
        `unknown screen ${item}; known: ${MAIN_SCREENS.map((s) => s.name).join(", ")}, or a path`,
      );
    }
    if (screen.graph === true && !hasGraph) {
      throw new Error(`screen ${item} needs an instance started with graph`);
    }
    return screen;
  });
}

export function resolvePath(path: string, state: InstanceState): string {
  const ids: Record<string, string | undefined> = {
    dashboardId: state.seed?.dashboardId,
    galleryId: state.seed?.galleryId,
    sourceId: state.seed?.sourceId,
    graphDashboardId: state.seed?.graph?.dashboardId,
    graphSourceId: state.seed?.graph?.sourceId,
  };
  return path.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const value = ids[key];
    if (value === undefined) throw new Error(`${whole} in ${path} is not known for this instance`);
    return value;
  });
}

/** A file-name-safe form of a screen name or path. */
export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "root" : s;
}
