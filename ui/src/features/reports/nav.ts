import { useQuery } from "@tanstack/react-query";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import type { NavItem } from "../../shell/navItem";
import { reportsQuery, statusQuery } from "./api";

/** Shown with `reports:read` while reports are on for the organization; otherwise no entry. */
export function useReportsShown(): boolean {
  return useReportsGranted() === true;
}

/** `useReportsShown`, undefined while the permissions or the status are on their way. */
function useReportsGranted(): boolean | undefined {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const allowed = org !== undefined && permissions.has("reports:read");
  const status = useQuery({ ...statusQuery(org?.id ?? ""), enabled: allowed });
  if (!permissions.loaded || (allowed && status.data === undefined && !status.isError)) {
    return undefined;
  }
  return allowed && status.data?.enabled === true;
}

/** "Berichte" (board Reports.dc.html, frame 1), after "Alerting". */
export const reportsNav: NavItem = {
  to: "/reports",
  label: "shell.nav.reports",
  icon: "file",
  visible: () => false,
  useGranted: useReportsGranted,
  prime: (queryClient, orgId, permissions) =>
    permissions.has("reports:read")
      ? queryClient.ensureQueryData(statusQuery(orgId))
      : Promise.resolve(),
};

/**
 * What a dashboard's menu offers (board frame 9, "Aus dem Dashboard"): creating a report with
 * `reports:write`, and how many reports the dashboard has. The list is read only while reports
 * are on, and shared with the reports page through the query cache.
 */
export function useDashboardReports(dashboardId: string): { create: boolean; count: number } {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const shown = useReportsShown();
  const reports = useQuery({ ...reportsQuery(org?.id ?? ""), enabled: shown });
  return {
    create: shown && permissions.has("reports:write"),
    count: (reports.data ?? []).filter((report) => report.dashboardId === dashboardId).length,
  };
}
