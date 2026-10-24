import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import type { Me } from "../api/auth";
import { orgAppearanceQuery } from "../appearance/api";
import { type Preferences, preferencesQuery } from "./preferences";

/**
 * The start dashboard opens when the user enters Kalzit at "/" (after signing in, or opening the
 * address); once inside, "Start" in the navigation shows the start page. The app shell marks the
 * entry when it appears and clears it when it goes (signing out).
 */
let entered = false;

export function markEntered(value: boolean): void {
  entered = value;
}

/** For the start route's `beforeLoad`: redirects to the start dashboard on entry. */
export async function redirectToStartDashboard(
  queryClient: QueryClient,
  me: Me,
  preload: boolean,
): Promise<void> {
  if (preload || entered) {
    return;
  }
  entered = true;
  let start: Preferences["startDashboard"];
  try {
    start = (await queryClient.ensureQueryData(preferencesQuery(me.id))).startDashboard;
  } catch {
    // Without preferences the start page is shown, as without a start dashboard.
    return;
  }
  // The UI works in the first organization (org/useOrg.ts); another one's dashboard waits.
  if (start !== null && start.orgId === me.orgs[0]?.id) {
    throw redirect({
      to: "/dashboards/$dashboardId",
      params: { dashboardId: start.dashboardId },
      replace: true,
    });
  }
  // Without a start dashboard of their own, members land where their organization says
  // (setting `appearance.start_page`).
  const orgId = me.orgs[0]?.id;
  if (orgId === undefined) {
    return;
  }
  let page: string;
  try {
    page = (await queryClient.ensureQueryData(orgAppearanceQuery(orgId))).startPage;
  } catch {
    return;
  }
  if (page === "dashboards") {
    throw redirect({ to: "/dashboards", replace: true });
  }
  if (page === "explore") {
    throw redirect({ to: "/explore", replace: true });
  }
}
