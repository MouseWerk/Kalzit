import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import type { NavCount, NavItem } from "../../shell/navItem";
import { rulesQuery, statusQuery } from "./api";

/** Shown with `alerts:read` while alerting is on for the organization; otherwise no entry. */
function useAlertingShown(): boolean {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const allowed = org !== undefined && permissions.has("alerts:read");
  const status = useQuery({ ...statusQuery(org?.id ?? ""), enabled: allowed });
  return allowed && status.data?.enabled === true;
}

/** The number of firing rules, neutral, next to the entry; none while nothing fires. */
function useFiringRules(): NavCount | null {
  const { t } = useI18n();
  const org = useCurrentOrg();
  // Polled only while alerting is on: with it off there is no entry to count for.
  const shown = useAlertingShown();
  const rules = useQuery({ ...rulesQuery(org?.id ?? ""), enabled: shown });
  const firing = (rules.data ?? []).filter(
    (rule) => !rule.paused && rule.state === "firing",
  ).length;
  if (firing === 0) {
    return null;
  }
  return {
    value: firing,
    label: firing === 1 ? t("alerting.nav.firingOne") : t("alerting.nav.firing", { count: firing }),
  };
}

/** "Alerting" (board Alerting.dc.html, frame 1), between "Fragen" and the data sources. */
export const alertingNav: NavItem = {
  to: "/alerting",
  label: "alerting.nav",
  icon: "bell",
  visible: () => false,
  useGranted: useAlertingShown,
  useCount: useFiringRules,
};
