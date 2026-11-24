import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import type { NavCount, NavItem } from "../../shell/navItem";
import { rulesQuery, statusQuery } from "./api";

/**
 * Shown with `alerts:read` while alerting is on for the organization; otherwise no entry.
 * Undefined while the permissions or the status are on their way.
 */
function useAlertingGranted(): boolean | undefined {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const allowed = org !== undefined && permissions.has("alerts:read");
  const status = useQuery({ ...statusQuery(org?.id ?? ""), enabled: allowed });
  if (!permissions.loaded || (allowed && status.data === undefined && !status.isError)) {
    return undefined;
  }
  return allowed && status.data?.enabled === true;
}

function useAlertingShown(): boolean {
  return useAlertingGranted() === true;
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

/**
 * Whether a rule started firing between two lists of firing rule ids (space-separated, null while
 * loading). The first list loaded is the baseline: nothing in it counts as new.
 */
export function startedFiring(before: string | null, now: string | null): boolean {
  if (before === null || now === null) {
    return false;
  }
  const seen = new Set(before.split(" "));
  return now.split(" ").some((id) => id !== "" && !seen.has(id));
}

/**
 * How often a rule started firing since the navigation loaded: the bell rings once for each
 * (board Icons.dc.html, "new alert"). What fires when the list first loads is the baseline, so
 * opening a page never rings it.
 */
function useNewFiring(): number {
  const org = useCurrentOrg();
  const shown = useAlertingShown();
  const rules = useQuery({ ...rulesQuery(org?.id ?? ""), enabled: shown });
  const firing =
    rules.data === undefined
      ? null
      : rules.data
          .filter((rule) => !rule.paused && rule.state === "firing")
          .map((rule) => rule.id)
          .sort()
          .join(" ");
  const [seen, setSeen] = useState<{ firing: string | null; rises: number }>({
    firing,
    rises: 0,
  });
  if (firing !== seen.firing) {
    const rose = startedFiring(seen.firing, firing);
    setSeen({ firing, rises: seen.rises + (rose ? 1 : 0) });
  }
  return seen.rises;
}

/** "Alerting" (board Alerting.dc.html, frame 1), between "Fragen" and the data sources. */
export const alertingNav: NavItem = {
  to: "/alerting",
  label: "alerting.nav",
  icon: "bell",
  visible: () => false,
  useGranted: useAlertingGranted,
  prime: (queryClient, orgId, permissions) =>
    permissions.has("alerts:read")
      ? queryClient.ensureQueryData(statusQuery(orgId))
      : Promise.resolve(),
  useCount: useFiringRules,
  useAttention: useNewFiring,
};
