import type { QueryClient } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import type { Me } from "../api/auth";
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
    start = (await queryClient.ensureQueryData(preferencesQuery)).startDashboard;
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
}
