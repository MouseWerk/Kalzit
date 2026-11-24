// Grafana's addresses, for people who type them from habit or follow an old link: each leads to
// Kalzit's page for the same thing. `/explore` and `/dashboards` are the same in both.
import { createRoute, redirect } from "@tanstack/react-router";
import { ApiError, isRecord } from "../api/client";
import { orgPath, send } from "../features/datasources/api";
import { currentOrgOf } from "../org/useOrg";
import { appRoute } from "./baseRoutes";

/**
 * The id of the dashboard a Grafana address names (`/d/<uid>`): by the uid it had in Grafana
 * before an import, the uid of a provisioned one, or its own id. `null` when none is found or the
 * caller may not read it.
 */
export async function findDashboardByUid(orgId: string, uid: string): Promise<string | null> {
  try {
    const value = await send("GET", orgPath(orgId, "dashboards", "by-uid", uid));
    return isRecord(value) && typeof value.id === "string" ? value.id : null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** A Grafana address that always means the same Kalzit page. */
function moved(path: string, to: "/data-sources" | "/data-sources/new") {
  return createRoute({
    getParentRoute: () => appRoute,
    path,
    beforeLoad: () => {
      throw redirect({ to, replace: true });
    },
  });
}

/** `/d/<uid>` and `/d/<uid>/<slug>`: the dashboard when the uid is known, else the list. */
async function toDashboard(
  context: { me: Parameters<typeof currentOrgOf>[0] },
  uid: string,
): Promise<never> {
  const org = currentOrgOf(context.me);
  const id = org === undefined ? null : await findDashboardByUid(org.id, uid).catch(() => null);
  if (id === null) {
    throw redirect({ to: "/dashboards", replace: true });
  }
  throw redirect({ to: "/dashboards/$dashboardId", params: { dashboardId: id }, replace: true });
}

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/d/$uid",
  beforeLoad: ({ context, params }) => toDashboard(context, params.uid),
});

const dashboardSlugRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/d/$uid/$slug",
  beforeLoad: ({ context, params }) => toDashboard(context, params.uid),
});

export const grafanaAddressRoutes = [
  moved("/datasources", "/data-sources"),
  moved("/connections/datasources", "/data-sources"),
  moved("/connections/datasources/new", "/data-sources/new"),
  dashboardRoute,
  dashboardSlugRoute,
] as const;
